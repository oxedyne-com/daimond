// verify_permmode.mjs — is the permission mode visible, changeable, and honest?
//
// The user's requirement, in their words: "the permission level should be visible
// and easy to change." Three things follow, and each is asserted here.
//
//   VISIBLE     a word in the chat header, not a setting you go and look up. The
//               word carries the state; nothing rests on the dot's colour.
//   HONEST      the ENGINE's copy is the one that decides anything, so a control
//               that failed must redraw what is actually in force. A page showing
//               "Bypass" over an engine running Guarded is worse than either being
//               wrong on its own.
//   QUIET       bypass explains itself once and never again, and switching AWAY
//               never asks. Being asked repeatedly was the original complaint;
//               a mode switch that nags has the same defect one layer up.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099).
import { open, chat, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'permmode' });
const p = s.page;
await chat(s, '@text hello');

// ── Visible, and defaulting to the careful rung ───────────────────────────

const start = await p.evaluate(() => ({
	chip:   (document.getElementById('hand-mode-chip-txt') || {}).textContent,
	engine: window.__DAIMOND_MODE_PROBE ? null : null,
	astat:  (document.getElementById('astat-hand') || {}).textContent,
	saved:  localStorage.getItem('daimond-permission-mode'),
}));
check('the chip says which mode is in force', /guarded/i.test(start.chip || ''), start.chip);
check('and the admin status row says it too', /guarded/i.test(start.astat || ''), start.astat);

// ── The engine agrees with the page ───────────────────────────────────────

const engine = await p.evaluate(() => (window.DaimondHandMode ? DaimondHandMode.get() : null));
check('the page and the engine name the same mode', engine === 'guarded', String(engine));

// ── The picker opens, and offers the ladder in order ──────────────────────

await p.click('#hand-mode-chip', { force: true });
await p.waitForTimeout(300);
const pop = await p.evaluate(() => {
	const el = document.getElementById('hand-mode-pop');
	if (!el || el.hidden) return null;
	return {
		rows:  [...el.querySelectorAll('.mode-row-name')].map(n => n.textContent),
		radio: [...el.querySelectorAll('input[type=radio]')].map(r => ({ v: r.value, on: r.checked })),
		note:  (el.querySelector('.pop-note') || {}).textContent || '',
		aria:  document.getElementById('hand-mode-chip').getAttribute('aria-expanded'),
	};
});
check('the chip opens a picker', !!pop);
check('offering the ladder strictest first',
	!!pop && pop.radio.map(r => r.v).join(',') === 'ask,guarded,bypass',
	pop ? pop.radio.map(r => r.v).join(',') : '');
check('with the one in force already chosen',
	!!pop && pop.radio.some(r => r.v === 'guarded' && r.on));
check('and it says what NO mode changes, so a choice is made knowing that',
	!!pop && /fence|folders|journal/i.test(pop.note), pop ? pop.note.slice(0, 80) : '');
check('the chip reports its own state to a screen reader', pop && pop.aria === 'true');

// ── Bypass explains itself exactly once ───────────────────────────────────

await p.evaluate(() => {
	const r = [...document.querySelectorAll('#hand-mode-pop input[type=radio]')].find(x => x.value === 'bypass');
	r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
});
await p.waitForTimeout(500);
// The app's own dialog is `.modal.dlg` with a `.dlg-card` inside it.
const dlg1 = await p.evaluate(() => {
	const d = document.querySelector('.modal.dlg .dlg-card');
	return d ? d.innerText : '';
});
// THE PROPERTY, in two halves, and this dialog is the only place either is
// said. WHAT IS GIVEN UP: the asking stops, and what will now happen unasked is
// named -- commands run on the user's machine AND pages the model chose are
// fetched -- including on a turn that has already read text somebody else
// wrote. That last clause is the whole of the risk: it is the one sentence that
// distinguishes "Daimond acts without nagging me" from "anything Daimond reads
// can send my work somewhere", and a user who never sees it cannot weigh what
// they are agreeing to.
//
// WHAT IS KEPT: all five guarantees. `/fence|journal|folders/` passed on ONE of
// the five, so four could go and the check stayed green -- for a dialog whose
// entire job is to bound the thing it is turning off.
//
// The first was `/stops asking/`, red as soon as the copy said "stops the
// asking". Every guarantee below survived that rewrite; it was checked against
// the string one commit before it (`git show 5b0eeb9^`), clause by clause.
const explainsBypass = (d) => ({
	// The asking stops, and commands on the machine are what stops being asked about.
	asking:   /\b(stops? (the )?asking|without (asking|putting)|no longer asks?)\b/i.test(d)
		&& /\bcommands?\b/i.test(d) && /\b(machine|computer)\b/i.test(d),
	// So does fetching a page the model chose for itself.
	fetching: /\b(fetch(es|ing)?|opens?|requests?|loads?)\b/i.test(d) && /\b(pages?|web|url)\b/i.test(d),
	// And it holds even on a turn that has read somebody else's words.
	injected: /\b(somebody|someone) else\b|\bwritten by (somebody|someone)\b/i.test(d)
		&& /\b(already read|has read|a turn that)\b/i.test(d),
});
const kept = (d) => ({
	fence:   /\bfence|sandbox\b/i.test(d),
	folders: /\bown folders?\b|\bonly its own\b/i.test(d),
	syscall: /\bsystem[- ]call filter\b|\bsyscall\b|\bseccomp\b/i.test(d),
	marked:  /\b(marked|labell?ed|tagged)\b/i.test(d) && /\b(somebody|someone) else|outside\b/i.test(d),
	journal: /\bjournal\b|\baudit\b/i.test(d) && /\b(check(ed)?|review(ed)?|afterwards|after the fact)\b/i.test(d),
});
const turnsOff = explainsBypass(dlg1), leaves = kept(dlg1);
const missing = (o) => Object.entries(o).filter(([, v]) => !v).map(([k]) => 'no ' + k).join(', ');
check('choosing bypass explains what it turns off', Object.values(turnsOff).every(Boolean),
	missing(turnsOff) || dlg1.slice(0, 90).replace(/\n/g, ' / '));
check('and says plainly what it does NOT change — all five, not one of them',
	Object.values(leaves).every(Boolean), missing(leaves));
check('and promises not to ask again',
	/\b(not|never) be asked (this )?again\b|\bonly ask(s|ed)? (this )?once\b/i.test(dlg1));

await p.evaluate(() => {
	const b = [...document.querySelectorAll('button')].find(x => /use bypass/i.test(x.textContent));
	if (b) b.click();
});
await p.waitForTimeout(600);
const afterBypass = await p.evaluate(() => ({
	chip: (document.getElementById('hand-mode-chip-txt') || {}).textContent,
	mode: DaimondHandMode.get(),
	ack:  localStorage.getItem('daimond-permission-bypass-ack'),
}));
check('the chip now says Bypass', /bypass/i.test(afterBypass.chip || ''), afterBypass.chip);
check('and the engine is in it', afterBypass.mode === 'bypass', afterBypass.mode);
// The ENGINE's own answer, not the page's copy of it — the only one that decides
// anything. A chip reading Bypass over an engine still in guarded is the failure
// this asks about, and the page cannot detect it by consulting itself.
const engineSays = await p.evaluate(() => DaimondCore.permissionMode());
check('and the engine itself says so when asked', engineSays === 'bypass', engineSays || '(no answer)');
check('the acknowledgement is recorded', afterBypass.ack === '1');

// Switching away must never ask, and coming back must not ask again.
await p.evaluate(() => DaimondHandMode.set('guarded'));
await p.waitForTimeout(400);
const away = await p.evaluate(() => ({
	mode: DaimondHandMode.get(),
	dlg:  !!document.querySelector('.modal.dlg'),
}));
check('switching AWAY from bypass asks nothing', away.mode === 'guarded' && !away.dlg);

await p.evaluate(() => DaimondHandMode.set('bypass'));
await p.waitForTimeout(400);
const again = await p.evaluate(() => ({
	mode: DaimondHandMode.get(),
	dlg:  !!document.querySelector('.modal.dlg'),
}));
check('and going back does not explain itself a second time',
	again.mode === 'bypass' && !again.dlg, again.mode + (again.dlg ? ' (asked again)' : ''));

// ── Fail closed: a setter that will not take must not be drawn as if it did ──

await p.evaluate(() => DaimondHandMode.set('guarded'));
await p.waitForTimeout(300);
await p.evaluate(() => {
	// Break the seam between the page and the engine, leaving the engine where it is.
	window.__realInit = null;
	const hm = window.DaimondHandMode;
	hm.init({
		apply:   function () { throw new Error('the engine refused'); },
		confirm: async () => true,
		notice:  (m) => { window.__notice = m; },
	});
});
await p.waitForTimeout(300);
await p.evaluate(() => DaimondHandMode.set('bypass'));
await p.waitForTimeout(400);
const failClosed = await p.evaluate(() => ({
	chip:   (document.getElementById('hand-mode-chip-txt') || {}).textContent,
	mode:   DaimondHandMode.get(),
	notice: window.__notice || '',
}));
check('a setter that throws does NOT leave "Bypass" drawn over a guarded engine',
	!/bypass/i.test(failClosed.chip || '') && failClosed.mode !== 'bypass',
	`chip "${failClosed.chip}", mode ${failClosed.mode}`);
check('and the user is told that nothing changed', /could not be set|nothing changed/i.test(failClosed.notice),
	failClosed.notice || '(nothing said)');

const errs = errors(s).filter(e => !/502|Bad Gateway|the engine refused/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
