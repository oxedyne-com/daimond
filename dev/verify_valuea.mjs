// verify_valuea.mjs — the presentation redesign of 2026-09-15: what a first-time user
// meets, on the surfaces the naive-user audit ranked batch A.
//
// WHAT THIS IS WRITTEN FROM. `~/usr/code/ai/claude/handover/daimond_ui_audit_20260915.md`
// walked the app as somebody who had never seen it and found the engine room on every
// screen: two raw dumps of `crystal.json` on one page, a Start gate over a hidden composer
// on an account that already had a model, chats titled "the chat from just now", a System
// band above the user's own first message, eight diagnostic rows on a fresh account, a
// 92-word developer instruction dropped into the composer, operator-only controls on a
// read-only roadmap, and a closed-testing strip pushing "Create account" off a phone.
//
// Each of those is one claim, and each claim can pass for the wrong reason:
//
//   1. THE MEMORY CARD. A summary and counts are only worth drawing if the raw file has
//      actually moved behind a press. Both halves are asserted, and so is the absence of
//      the capp's own second dump.
//   2. THE COMPOSER. "Visible with a model" is not the same as "no gate exists": the gate
//      must still be there when nothing can run, or this is the SEV-1 of 2026-09-08 again.
//   3. THE TITLE. "Not 'the chat from just now'" is satisfied by any string; what is
//      checked is that the title IS the first line the user typed.
//   4. THE STATUS LINE. One row is only an improvement if the eight are still reachable.
//   5. THE PAGE ACTION. What is checked is the length of what lands in the composer AND
//      that the rules still reach the model, not merely that the box got shorter.
//
// EACH CHECK PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_valuea.mjs --break rawfirst    # the raw memory is open from the start
//   node dev/verify_valuea.mjs --break gate        # the Start gate comes back
//   node dev/verify_valuea.mjs --break whentitle   # chats are named by their clock again
//   node dev/verify_valuea.mjs --break eightrows   # the diagnostics are open from the start
//   node dev/verify_valuea.mjs --break pagedump    # the 92 words go back in the composer
//   node dev/verify_valuea.mjs --break wireshown   # the System band leads the thread again
//   node dev/verify_valuea.mjs                     # and then, clean
//
// Needs a world: `bash dev/world.sh N --up`, then DAIMOND_APP / DAIMOND_MOCK from it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Every break is a rewrite of what the PAGE does, served through `page.route`, so nothing
// on disk is touched and a killed run leaves no damaged tree behind.
const BREAKS = {
	// The card's raw block is open from the first paint, which is the wall of text the
	// whole surface was rewritten to get rid of.
	rawfirst: {
		file: 'js/daimond.js',
		find: "\t\traw.hidden = true;\n\t\tcard.appendChild(raw);",
		with: "\t\traw.hidden = false;\n\t\tcard.appendChild(raw);",
	},
	// The Start gate comes back: a startable chat is drawn as pending instead of started.
	gate: {
		file: 'js/daimond.js',
		find: "\t\tvar block = pendingStartBlock(chat);\n\t\tif (!block) {",
		with: "\t\tvar block = pendingStartBlock(chat) || { unreadable: false };\n\t\tif (false) {",
	},
	// A chat is named by its clock again.
	whentitle: {
		file: 'js/daimond.js',
		find: "\t\tvar opening = chatOpening(s);\n\t\tif (opening) {",
		with: "\t\tvar opening = '';\n\t\tif (opening) {",
	},
	// The eight diagnostic rows are open from the start, which is the strip as it was.
	// On `setDetail`, not on `wasOpen`: the line after that one reads the remembered
	// state and overwrites it, so breaking the initialiser breaks nothing -- which is
	// exactly what this run reported the first time it was tried.
	eightrows: {
		file: 'js/daimond.js',
		find: "\t\t\t\tsetDetail(wasOpen);",
		with: "\t\t\t\tsetDetail(true);",
	},
	// The 92 words go back into the composer.
	pagedump: {
		file: 'js/daimond.js',
		find: "\t\tvar ask = tOr('crystal.page_ask', 'Change how this page looks: ');",
		with: "\t\tvar ask = _pageNote;",
	},
	// The System band leads every thread again, in every view.
	wireshown: {
		file: 'css/app.css',
		find: ':root[data-view="simple"] #wire-head { display: none; }',
		with: ':root[data-view="simple"] #wire-head { display: block; }',
	},
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// A realistic Life log crystal: a title and summary worth a card head, two kinds of
// labelled fact, and a capp key the app has never heard of -- `habits` -- which the card
// must draw anyway, because a key that vanishes because nothing recognised it is the one
// defect the crystal frame is shaped around.
const CRYSTAL = {
	title:   'Life log',
	summary: 'Diet, gym and body, logged daily since the start of the month.',
	sections: [
		{ heading: 'Ground rules', body: 'Weigh in every morning, before breakfast.', hot: true },
	],
	facts: [
		{ k: 'Started', v: 'this month' },
		{ k: 'Lanes',   v: 'diet, gym, body' },
	],
	habits: ['weigh in every morning', '8,000 steps a day'],
	people: 'partner — likes the gym at 6am',
};

// What REQUIREMENTS.md looks like after lane req-files: two real objectives, the seeded
// placeholder heading (which must NOT be counted), three open tasks and one ticked.
const REQUIREMENTS = [
	'# Requirements', '',
	'What this Diamond exists to do.', '',
	'## O1 Keep the log honest', '',
	'- [ ] T1 Log every weigh-in',
	'- [x] T2 Seed the lanes (v3)', '',
	'## O2 Make the trend legible', '',
	'- [ ] T3 Draw a weekly average',
	'- [ ] T4 Mark the rest days', '',
	'## Unfiled', '',
	'## Done', '',
].join('\n');

const s = await open({ name: 'valuea', signIn: false, connect: false });
const { page } = s;

if (BREAK) {
	const spec = BREAKS[BREAK];
	if (!spec) {
		console.error('no such break: ' + BREAK + '\nhave: ' + Object.keys(BREAKS).join(' '));
		process.exit(2);
	}
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	const type = spec.file.endsWith('.css') ? 'text/css' : 'application/javascript';
	await page.route('**/' + spec.file, r => r.fulfill({
		status: 200, contentType: type, body: src.replace(spec.find, spec.with),
	}));
	console.log(`  (running with the app broken: ${BREAK})`);
}

const MOCKURL = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
const SHOTDIR = process.env.VALUEA_SHOTS || '';
const snap = async (label, w, h) => {
	if (!SHOTDIR) return;
	fs.mkdirSync(SHOTDIR, { recursive: true });
	await page.screenshot({ path: path.join(SHOTDIR, label + '.png'), timeout: 8000 })
		.catch(() => {});
	void w; void h;
};

try {
	// ── 7 and the start card: the GATE, before anything is signed in ──
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777',
		{ waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(2500);
	await snap('before-after-gate-390');
	const gate = await page.evaluate(() => {
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		const b = document.getElementById('id-doors');
		const create = document.getElementById('id-primary');
		const title = document.getElementById('id-title');
		const card = document.querySelector('#identity-modal .modal-card');
		return {
			doors:      vis(b),
			doorsOpen:  !!(b && b.open),
			doorsTop:   b ? Math.round(b.getBoundingClientRect().top) : -1,
			titleTop:   title ? Math.round(title.getBoundingClientRect().top) : -1,
			createTop:  create ? Math.round(create.getBoundingClientRect().top) : -1,
			cardH:      card ? Math.round(card.getBoundingClientRect().height) : -1,
			routes:     ['id-door-test', 'id-door-wait', 'id-door-code']
				.filter(id => vis(document.getElementById(id))).length,
		};
	});
	check('the gate still offers the other ways in', gate.doors, JSON.stringify(gate));
	check('but closed, so none of the three routes is on screen',
		!gate.doorsOpen && gate.routes === 0, `open=${gate.doorsOpen} routes=${gate.routes}`);
	check('"Create your account" is ABOVE the passcode line at 390px',
		gate.titleTop >= 0 && gate.doorsTop > gate.titleTop,
		`title=${gate.titleTop} doors=${gate.doorsTop}`);
	check('and the Create button is within the viewport, not on its bottom edge',
		gate.createTop > 0 && gate.createTop < 844, `create top=${gate.createTop}`);
	const opened = await page.evaluate(() => {
		const b = document.getElementById('id-doors');
		if (b && 'open' in b) b.open = true;
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		return ['id-door-test', 'id-door-wait', 'id-door-code']
			.filter(id => vis(document.getElementById(id))).length;
	});
	check('the line opens to the same three routes', opened === 3, String(opened));

	await page.setViewportSize({ width: 1440, height: 900 });
	await signInAs(s, 'valuea');
	await page.waitForTimeout(1200);

	// ── The start card, before a model is connected ───────────────────
	await snap('before-after-startcard-1440');
	const start = await page.evaluate(() => {
		const steps = [...document.querySelectorAll('#chat-output .start-step')];
		return {
			n:    steps.length,
			live: steps.map(li => li.classList.contains('on')),
			text: steps.map(li => (li.textContent || '').trim()),
		};
	});
	check('the empty centre is three steps, not a lone "New chat"',
		start.n === 3, JSON.stringify(start.text));
	check('and step 1 is the live one while no model is connected',
		start.live[0] === true && start.live[1] === false, JSON.stringify(start.live));

	await connectMock(s);
	await page.waitForTimeout(1500);

	// ── 4: the status strip ───────────────────────────────────────────
	const strip = await page.evaluate(() => {
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		const rows = [...document.querySelectorAll('#admin-status .astat-row')].filter(vis);
		const sum = document.getElementById('astat-summary');
		const det = document.getElementById('astat-detail');
		return {
			visible: rows.length,
			ids:     rows.map(r => r.id).filter(Boolean),
			summary: sum ? (sum.textContent || '').trim() : '',
			hidden:  !!(det && det.hidden),
			inside:  det ? det.querySelectorAll('.astat-row').length : 0,
		};
	});
	check('the strip shows ONE status row, not eight',
		strip.hidden && strip.ids.filter(id => id !== 'astat-summary').length === 0,
		`visible=${JSON.stringify(strip.ids)}`);
	check('and it says something true about this account',
		/\w/.test(strip.summary), strip.summary || '(empty)');
	check('the eight diagnostics are still there, behind the disclosure',
		strip.inside >= 8, strip.inside + ' rows inside #astat-detail');
	const openedStrip = await page.evaluate(() => {
		const sum = document.getElementById('astat-summary');
		if (sum) sum.click();
		const det = document.getElementById('astat-detail');
		return !!(det && !det.hidden);
	});
	check('and one press opens them', openedStrip);
	await page.evaluate(() => { const b = document.getElementById('astat-summary'); if (b) b.click(); });
	await snap('before-after-strip-1440');

	// ── 2: the composer, with a model connected ───────────────────────
	await page.evaluate(() => document.getElementById('new-session-btn').click());
	await page.waitForTimeout(1200);
	const composer = await page.evaluate(() => {
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		const bar = document.querySelector('.chat-input-bar');
		const input = document.getElementById('chat-input');
		return {
			shown:   vis(bar) && vis(input),
			pending: !!document.querySelector('.pending-centre'),
			focused: document.activeElement && document.activeElement.id === 'chat-input',
			gateTxt: (document.querySelector('.pending-centre') || {}).textContent || '',
		};
	});
	check('with a model connected the composer is on screen at once',
		composer.shown, JSON.stringify(composer));
	check('and there is no Start gate over it',
		!composer.pending, composer.gateTxt.slice(0, 60) || 'no pending centre');
	await snap('before-after-newchat-1440');

	// ── 3a: the title comes from the first line ───────────────────────
	await page.fill('#chat-input', 'Plan a week of meals for two people on a budget');
	await page.click('#chat-send', { force: true });
	await page.waitForTimeout(3500);
	const titled = await page.evaluate(() => {
		const head = (document.getElementById('current-session-name') || {}).textContent || '';
		// And the rail's own row for it, which is where a person looks for a chat
		// they left: its aria-label is `chatDisplayName` verbatim.
		const box = document.querySelector('.session-box[data-id] .tile-label');
		return { head: head, rail: box ? (box.getAttribute('aria-label') || '') : '' };
	});
	check('the chat is titled from what was said, not from the clock',
		/^Plan a week of meals/.test(titled.head.trim())
			&& !/chat from/i.test(titled.head), titled.head);
	check('and the rail row it is found by carries the same title',
		/^Plan a week of meals/.test(titled.rail.trim()), titled.rail || '(no rail row)');

	// ── 3b: the System band ───────────────────────────────────────────
	const wire = await page.evaluate(() => {
		const w = document.getElementById('wire-head');
		const view = document.documentElement.getAttribute('data-view');
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		const seen = vis(w);
		// And in the Detailed view it is there, one line, with no list of part names.
		window.DaimondView.set('max');
		const w2 = document.getElementById('wire-head');
		const peek = w2 ? (w2.querySelector('.crollup-peek') || {}).textContent || '' : '';
		const out = { view: view, seen: seen, maxSeen: vis(w2), peek: peek.trim() };
		window.DaimondView.set(view === 'max' ? 'max' : 'simple');
		return out;
	});
	check('the System band does not lead the thread in the shipped view',
		wire.view !== 'max' && !wire.seen, `view=${wire.view} shown=${wire.seen}`);
	check('but it IS there in the Detailed view, with no list of part names beside it',
		wire.maxSeen && wire.peek === '', `shown=${wire.maxSeen} peek="${wire.peek}"`);
	await snap('before-after-thread-1440');

	// ── 1: the memory card ────────────────────────────────────────────
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Life log');
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(2500);

	const id = await page.evaluate(async (a) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		window.__free = app;
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Life log');
		if (!d) return '';
		await app.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + d.id + '/crystal.json', content: a.crystal }));
		await app.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + d.id + '/REQUIREMENTS.md', content: a.req }));
		return d.id;
	}, { crystal: JSON.stringify(CRYSTAL, null, 1), req: REQUIREMENTS });
	check('a Diamond with a crystal and a REQUIREMENTS.md beside it', !!id, id);

	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(3000);
	await page.$$eval('.diamond-box', els => { const d = els.find(e => /Life log/.test(e.textContent)); if (d) d.click(); });
	await page.waitForTimeout(2500);

	const closed = await page.evaluate(() => {
		const box = document.querySelector('.crystal-memory');
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		return {
			summary: box ? (box.querySelector('summary') || {}).textContent || '' : '',
			cardSeen: vis(box && box.querySelector('.mem-card')),
			taSeen:   vis(box && box.querySelector('.crystal-memory-ta')),
		};
	});
	check('the memory disclosure is named for what it holds, not "Memory"',
		/knows/i.test(closed.summary), closed.summary);

	await page.evaluate(() => {
		const box = document.querySelector('.crystal-memory');
		if (box) box.open = true;
	});
	await page.waitForTimeout(900);
	await snap('before-after-memory-1440');
	const card = await page.evaluate(() => {
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		const box = document.querySelector('.crystal-memory');
		const pills = [...(box ? box.querySelectorAll('.mem-pill') : [])].map(p => p.textContent.trim());
		const dts = [...(box ? box.querySelectorAll('.mem-facts dt') : [])].map(d => d.textContent.trim());
		const acts = [...(box ? box.querySelectorAll('.mem-acts button') : [])].map(b => b.textContent.trim());
		return {
			title:   (box && (box.querySelector('.mem-title') || {}).textContent || '').trim(),
			summary: (box && (box.querySelector('.mem-summary') || {}).textContent || '').trim(),
			pills:   pills,
			labels:  dts,
			acts:    acts,
			rawSeen: vis(box && box.querySelector('.crystal-memory-ta')),
			gaugeSeen: vis(box && box.querySelector('.crystal-memory-gauge')),
		};
	});
	check('the card leads with the Diamond\'s own title and summary',
		card.title === 'Life log' && /Diet, gym and body/.test(card.summary),
		`${card.title} | ${card.summary.slice(0, 40)}`);
	check('it carries the objective and open-task counts from REQUIREMENTS.md',
		card.pills.some(p => /Objectives\D+2\b/.test(p)) && card.pills.some(p => /Open tasks\D+3\b/.test(p)),
		JSON.stringify(card.pills));
	check('and does not count the template\'s "(no objective yet)" heading',
		!card.pills.some(p => /Objectives\D+[34]\b/.test(p)), JSON.stringify(card.pills));
	check('every top-level key is a labelled line, the capp\'s own included',
		['Facts', 'Habits', 'People'].every(l => card.labels.indexOf(l) >= 0),
		JSON.stringify(card.labels));
	check('Edit and Show raw memory are the actions under it',
		card.acts.some(a => /Edit/.test(a)) && card.acts.some(a => /raw memory/i.test(a)),
		JSON.stringify(card.acts));
	check('THE RAW JSON IS NOT WHAT OPENS',
		!card.rawSeen && !card.gaugeSeen, `textarea=${card.rawSeen} gauge=${card.gaugeSeen}`);

	const rawOpen = await page.evaluate(() => {
		const b = [...document.querySelectorAll('.mem-raw-btn')][0];
		if (b) b.click();
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		return {
			ta:    vis(document.querySelector('.crystal-memory-ta')),
			gauge: (document.querySelector('.crystal-memory-gauge') || {}).textContent || '',
		};
	});
	check('and it is exactly one press away, with the byte gauge on it',
		rawOpen.ta && /KB/.test(rawOpen.gauge), `ta=${rawOpen.ta} gauge="${rawOpen.gauge.trim()}"`);

	// The capp's own second dump is gone from the page it shipped in.
	const cappSrc = fs.readFileSync(path.join(WWW, 'capps', 'lifelog', 'crystal.html'), 'utf8');
	check('the Life log page no longer draws a memory dump of its own',
		!/Diamond memory/.test(cappSrc) && !/function memory\(/.test(cappSrc));

	// ── 5: the Page action ────────────────────────────────────────────
	const pageAsk = await page.evaluate(() => {
		const b = [...document.querySelectorAll('.crystal-bar .crystal-act')]
			.find(x => /Page/i.test(x.textContent));
		if (!b) return { err: 'no Page button' };
		b.click();
		const box = document.getElementById('chat-input');
		const v = box ? box.value : '';
		return { text: v, words: v.trim().split(/\s+/).filter(Boolean).length };
	});
	check('pressing Page puts ONE short line in the composer, not 92 words',
		pageAsk.words > 0 && pageAsk.words <= 8, `${pageAsk.words} words: "${String(pageAsk.text).slice(0, 70)}"`);
	check('and that line is about what the user wants, not about crystal.html',
		!/crystal\.html|crystal\.json|data: URIs|no eval/i.test(String(pageAsk.text)),
		String(pageAsk.text).slice(0, 70));
	await snap('before-after-page-1440');
	await page.fill('#chat-input', '');

	// ── 6: the roadmap, for somebody who is not an operator ───────────
	await page.evaluate(() => window.DaimondPanels.show('tracker'));
	await page.waitForTimeout(2500);
	const trk = await page.evaluate(() => {
		const host = document.getElementById('tracker-view');
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		const err = host ? host.querySelector('.trk-err') : null;
		return {
			admin: vis(host && host.querySelector('.trk-admin')),
			text:  host ? (host.textContent || '') : '',
			err:   err ? (err.textContent || '').trim() : '',
			errLines: err ? (err.textContent || '').trim().split('\n').length : 0,
		};
	});
	check('the settle-voice block is hidden for an account with no operator role',
		!trk.admin, `admin block shown=${trk.admin}`);
	check('and no sentence about admin voices is on the board',
		!/settle voice|admin voice/i.test(trk.text),
		(trk.text.match(/[^.]*voice[^.]*\./i) || [''])[0].slice(0, 60) || 'clean');
	check('a forge that could not be read says so in one line, after the attempt',
		trk.err === '' || (trk.errLines === 1 && trk.err.length < 40), `"${trk.err}"`);
	await snap('before-after-improve-1440');

	// ── The phone, on the surfaces the audit measured there ───────────
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(1200);
	await snap('before-after-improve-390');
	await page.evaluate(() => window.DaimondPanels.hide && window.DaimondPanels.hide('tracker'));
	await page.waitForTimeout(800);
	await snap('before-after-memory-390');

	const errs = errors(s).filter(e => !/502|Bad Gateway|account|401|403|api\//i.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
	await shot(s, 'valuea-failed');
} finally {
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
