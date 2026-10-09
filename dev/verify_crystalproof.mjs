// gateway: none
// verify_crystalproof — an edit of a Diamond's page is followed by the LOAD PROOF, read from outside the page as the owner
// sees it, and the daimon is told in the edit's own result whether the page passed.
//
// WHY THIS EXISTS. D-20261008-08, the Ontheism Diamond: a daimon asked for an infographic wrote a page that showed a JSON dump,
// then one that showed a KEYMAP debug list, and said it was done both times, because nothing it could read told it what the
// owner saw (specs/daimond_ontheism_infographic_20261008.md).  K1 draws the stored page off screen after every write of
// `crystal.html` or `crystal.json`, reads its visible text against the crystal, and answers the write with "MUST FIX ... load
// proof" or "Load proof: pass"; a pass marks that version as the last that passed.  K2 warns, and tells the daimon next turn, only when this
// turn's own last proof of the page it wrote failed and that page is still in place (QA r544h F-H1); it writes nothing.
//
// Cases: a page that dumps the data as JSON, a page that draws the crystal but leaves a KEYMAP on screen, and a good page.
// A turn that ends over a failing proof is told the must-fix line once more and then ends `Blocked` (unit G's turn end).
//
//   node dev/verify_crystalproof.mjs
import { open, steerDiamond, mockLog, clearMockLog, contentText } from './harness.mjs';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const NAME = 'ProofCrystal';

const CRYSTAL = {
	title: 'Ontheism: the Invitation',
	summary: 'The Invitation sets out the first principles of Ontheism, to be read slowly and in order.',
	sections: [
		{ heading: 'The fabric', body: 'The fabric is divine but no one\'s god.' },
		{ heading: 'The mind', body: 'Mind is the bionous.' },
		{ heading: 'Part 3: Fire', body: 'The third part.' },
	],
};
const JSON_TEXT = JSON.stringify(CRYSTAL, null, 2);

/// A page that speaks the protocol and draws `data` with `draw`, a function source taking the data and returning HTML.
const page = (draw) => [
	'<!doctype html><meta charset="utf-8"><title>page</title><body><main id="out"></main>',
	'<script>',
	'(function () {',
	'	var send = function (m) { parent.postMessage(m, "*"); };',
	'	var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); };',
	'	addEventListener("message", function (e) {',
	'		var d = e.data;',
	'		if (!d || d.dc !== 1 || d.cmd !== "data") return;',
	'		var data = d.data || {};',
	'		document.getElementById("out").innerHTML = (' + draw + ')(data, esc);',
	'		send({ dc: 1, v: 1, cmd: "rendered", keys: Object.keys(data).filter(function (k) { return k.charAt(0) !== "_"; }) });',
	'	});',
	'	send({ dc: 1, v: 1, cmd: "ready" });',
	'}());',
	'<\/script>',
].join('\n');

const DRAW_GOOD = 'function (d, esc) { return "<h1>" + esc(d.title) + "</h1><p>" + esc(d.summary) + "</p>"'
	+ ' + "<svg width=\\"120\\" height=\\"40\\"><rect width=\\"120\\" height=\\"40\\" fill=\\"#4a7\\"/></svg>"'
	+ ' + (d.sections || []).map(function (s) { return "<h2>" + esc(s.heading) + "</h2><p>" + esc(s.body) + "</p>"; }).join(""); }';
// The first Ontheism failure: the page shows the crystal as text, in a <pre>.
const DRAW_JSON = 'function (d, esc) { return "<pre>" + esc(JSON.stringify(d, null, 2)) + "</pre>"; }';
// The second: everything is drawn, and a KEYMAP debug list is left on screen beside it.
const DRAW_KEYMAP = 'function (d, esc) { return (' + DRAW_GOOD + ')(d, esc)'
	+ ' + "<div>KEYMAP: " + esc(Object.keys(d).join(", ")) + "</div>"; }';

const s = await open({ name: 'crystalproof', signIn: true, connect: true, defaults: false,
	route: async (p) => { await p.setViewportSize({ width: 1280, height: 800 }); } });
const pg = s.page;

await pg.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
await pg.waitForTimeout(900);
await pg.fill('.dlg-input', NAME).catch(() => {});
await pg.click('.dlg-ok', { force: true }).catch(() => {});
await pg.waitForTimeout(2500);
const id = await pg.evaluate(async (name) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find(x => x.name === name);
	return d ? d.id : '';
}, NAME);
check('a Diamond was made', !!id, id);
const PAGE_PATH = 'diamonds/' + id + '/crystal.html';

await pg.evaluate(async ({ path, text }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.write_file(path, text);
}, { path: 'diamonds/' + id + '/crystal.json', text: JSON_TEXT });

async function lastPassed() {
	return await pg.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		return typeof m.crystal_last_passed === 'function' ? String(await m.crystal_last_passed(id) || '') : '';
	}, id);
}

// One tool call by the daimon, answered with the text its result carried.
async function daimon(tool, args) {
	clearMockLog();
	await steerDiamond(s, '@tool ' + tool + ' ' + JSON.stringify(args));
	const toolsIn = (r) => ((r && r.messages) || []).filter((m) => m.role === 'tool');
	let text = null;
	for (let i = 0; i < 240 && text === null; i++) {
		await pg.waitForTimeout(500);
		const log = mockLog();
		if (!log.length) continue;
		const n0 = toolsIn(log[0]).length;
		const carrying = log.filter((r) => toolsIn(r).length > n0);
		if (carrying.length) { const t = toolsIn(carrying[carrying.length - 1]); text = contentText(t[t.length - 1].content); }
	}
	await pg.waitForTimeout(1500);
	return text === null ? '' : text;
}
// A write of the page, read first so an overwrite is not refused for want of a read.
async function writePage(html) {
	await daimon('file_read', { path: PAGE_PATH });
	return await daimon('file_write', { path: PAGE_PATH, content: html });
}
// Was the model, ending its turn with the write's MUST FIX standing, told it once more before the turn ended (unit G's honest end)?
async function nudged(waitMs) {
	// The newest message of a request only: the nudge stays in the session's history, so an earlier turn's is in every later request.
	const last = (r) => { const m = (r && r.messages) || []; return m.length ? m[m.length - 1] : null; };
	const isNudge = (m) => !!m && m.role === 'user' && /^MUST FIX[^]*load proof/.test(contentText(m.content));
	for (let t = 0; t <= waitMs; t += 500) {
		if (mockLog().some((r) => isNudge(last(r)))) return true;
		await pg.waitForTimeout(500);
	}
	return false;
}
const show = (t) => console.log(t.split('\n').slice(0, 12).map((l) => '       | ' + l.slice(0, 220)).join('\n'));
await pg.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
await pg.waitForTimeout(900);

for (const [what, draw, why] of [
	['a JSON dump', DRAW_JSON, /raw JSON/],
	['a KEYMAP left on screen', DRAW_KEYMAP, /KEYMAP/],
]) {
	console.log('\nFAILING: ' + what);
	const t = await writePage(page(draw));
	show(t);
	check(`${what}: the write lands`, !/^Refused|not valid/i.test(t.trim()));
	check(`${what}: its result says MUST FIX ... load proof`, /MUST FIX[^]*load proof/.test(t));
	check(`${what}: and names why`, why.test(t));
	check(`${what}: it is not marked as passing`, (await lastPassed()) === '');
	check(`${what}: ending over it, the model is told the must-fix line before the turn ends`, await nudged(20000));
}

console.log('\nPASSING: a page that draws the crystal');
{
	const t = await writePage(page(DRAW_GOOD));
	show(t);
	check('the result says "Load proof: pass"', /Load proof: pass/.test(t));
	check('and no MUST FIX', !/MUST FIX/.test(t));
	check('and the turn ends without a must-fix nudge', !(await nudged(4000)));
	const marked = await lastPassed();
	check('the passing version is marked', marked.length > 0 && marked.includes('KEYMAP') === false, `${marked.length} chars`);
}

// The K2 warning, wherever it is drawn (the undo window since QA F-H3, a plain toast before): every time it appeared, and
// whether it was announced (role=status, aria-live=polite). Polled, since a plain toast lives 4.2 s.
const warnWatch = () => pg.evaluate(() => {
	window.__k2 = { seen: [], announced: true };
	if (window.__k2t) return;
	window.__k2t = setInterval(() => {
		const els = [...document.querySelectorAll('.daimond-toast, #daimond-undo:not([hidden])')]
			.filter((n) => /load check/.test(n.textContent));
		for (const n of els) {
			const at = Date.now();
			const last = window.__k2.seen[window.__k2.seen.length - 1];
			if (last && at - last.to < 600) last.to = at;
			else window.__k2.seen.push({ from: at, to: at, text: n.textContent.trim().slice(0, 120) });
			if (n.getAttribute('role') !== 'status' || n.getAttribute('aria-live') !== 'polite') window.__k2.announced = false;
		}
	}, 250);
});
const warnings = () => pg.evaluate(() => window.__k2 || { seen: [], announced: false });
// The engine's K2 note, as the NEXT turn's request carries it (old and new wording alike).
const K2_NOTE = /(last turn left did not pass|now in place has not passed) the load proof/;
const noteNext = async () => {
	clearMockLog();
	await steerDiamond(s, 'Status?');
	for (let i = 0; i < 40 && !mockLog().length; i++) await pg.waitForTimeout(250);
	await pg.waitForTimeout(1500);
	const r = mockLog()[0];
	const msgs = (r && r.messages) || [];
	// Only what this request added after the last assistant message: an earlier turn's note stays in the history.
	let k = msgs.length - 1;
	while (k >= 0 && msgs[k].role !== 'assistant') k--;
	return msgs.slice(k + 1).filter((m) => m.role === 'user').map((m) => contentText(m.content)).find((t) => K2_NOTE.test(t)) || '';
};
const readStored = async () => await pg.evaluate(async (path) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { return String(await m.read_file(path)); } catch (e) { return null; }
}, PAGE_PATH);

// K2 x K1: a page that fails the proof after one has passed. The turn ends Blocked over it, and since the r544 hotfix
// (QA-B F-B1/F-B2) nothing is put back: the page stays as the turn left it, a warning says so, and no "Bring back" writes.
console.log('\nFAILING AFTER A PASS: the turn ends Blocked, the page stays, a warning and no Bring back');
{
	const readPage = async () => await pg.evaluate(async (path) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		try { return String(await m.read_file(path)); } catch (e) { return null; }
	}, PAGE_PATH);
	const bad  = page(DRAW_JSON);
	await warnWatch();
	const t = await writePage(bad);
	check('K2xK1: the failing write says MUST FIX ... load proof', /MUST FIX[^]*load proof/.test(t));
	check('K2xK1: the model is told the must-fix line before the turn ends', await nudged(20000));
	const probe = () => pg.evaluate(() => ({
		bring: !![...document.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Bring back'),
		warn:  !![...document.querySelectorAll('.daimond-toast, #daimond-undo:not([hidden])')].find((n) => /load check/.test(n.textContent)),
	}));
	let warned = false, offered = false;
	for (let i = 0; i < 60 && !warned; i++) { await pg.waitForTimeout(500); const v = await probe(); warned = v.warn; offered = offered || v.bring; }
	const after = await readPage();
	let blocked = false;
	for (let i = 0; i < 20 && !blocked; i++) {
		blocked = await pg.evaluate(() => !!document.querySelector('.ended-notice[data-why="blocked"]')
			|| /Not done: the page does not load/.test(document.body.innerText));
		if (!blocked) await pg.waitForTimeout(500);
	}
	const ends = await pg.evaluate(() => [...document.querySelectorAll('.ended-notice')].map((n) => (n.dataset.why || '-') + ':' + n.textContent.trim().slice(0, 60)).join(' | '));
	check('K2xK1: the turn ends Blocked', blocked, blocked ? '' : 'end notices: ' + (ends || 'none'));
	check('K2xK1: nothing is put back: the page is the one the turn left', after === bad, after === null ? 'no page read' : '');
	check('K2xK1: a warning says the page did not pass the load check', warned);
	check('K2xK1: no "Bring back" is offered', !offered && !(await probe()).bring);
	// F-H3: announced, and held well past a plain toast's 4.2 s.
	await pg.waitForTimeout(6000);
	const w = await warnings();
	const held = w.seen.length ? w.seen[0].to - w.seen[0].from : 0;
	check('K2xK1: the warning is announced (role=status, aria-live=polite)', w.seen.length > 0 && w.announced, JSON.stringify(w.seen));
	check('K2xK1: the warning stays past 6 s', held >= 6000, held + ' ms');
	const note = await noteNext();
	check('K2xK1: the next turn tells the daimon its last page did not pass', !!note, note.slice(0, 160));
}

// F-H1 (QA r544h H1, H2, H2b): the warning and the note are said ONLY on this turn's own failing proof of a page it
// wrote. A page another hand wrote, or the one the daimon put back with file_revert, was never judged by the turn.
const G = (tag) => page(DRAW_GOOD) + '\n<!-- ' + tag + ' -->';
const tagOf = (h) => { const m = /<!-- (G\d) -->/.exec(h || ''); return m ? m[1] : (h === null ? 'none' : 'other'); };

console.log('\nH1: the daimon\'s file_revert after two passing pages: no warning, no note');
{
	let t = await writePage(G('G1'));
	check('H1: G1 passes', /Load proof: pass/.test(t));
	t = await writePage(G('G2'));
	check('H1: G2 passes', /Load proof: pass/.test(t));
	await warnWatch();
	t = await daimon('file_revert', { path: PAGE_PATH });
	await pg.waitForTimeout(4000);
	const now = await readStored();
	check('H1: the revert stands (G1)', tagOf(now) === 'G1', tagOf(now) + ' | ' + t.slice(0, 120).replace(/\n/g, ' / '));
	const w = await warnings();
	check('H1: no "did not pass" warning', w.seen.length === 0, JSON.stringify(w.seen));
	const note = await noteNext();
	check('H1: the next turn carries no "fix it" note', !note, note.slice(0, 160));
	check('H1: the page is still G1 after the next turn', tagOf(await readStored()) === 'G1');
}

for (const variant of ['H2', 'H2b']) {
	console.log('\n' + variant + ': a good page written behind a turn that never touches it (' + (variant === 'H2' ? 'the store' : 'write_crystal_page') + ')');
	const t = await writePage(G('G2'));
	check(variant + ': G2 passes', /Load proof: pass/.test(t));
	await warnWatch();
	clearMockLog();
	await steerDiamond(s, '@slow 5000 Nothing to change.');
	await pg.waitForTimeout(1200);
	const G3 = G('G3');
	if (variant === 'H2') await pg.evaluate(async ({ path, text }) => {
		const m = await import('/pkg/oxedyne_daimond.js'); await m.write_file(path, text); }, { path: PAGE_PATH, text: G3 });
	else await pg.evaluate(async ({ id, text }) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.write_crystal_page(id, text); }, { id, text: G3 });
	await pg.waitForTimeout(9000);
	const now = await readStored();
	check(variant + ': G3 stays', tagOf(now) === 'G3', tagOf(now));
	const w = await warnings();
	check(variant + ': no "did not pass" warning', w.seen.length === 0, JSON.stringify(w.seen));
	const note = await noteNext();
	check(variant + ': the next turn carries no "fix it" note', !note, note.slice(0, 160));
}

console.log(`\n${ok} ok, ${bad} failed`);
await s.browser?.close?.().catch(() => {});
process.exit(bad ? 1 : 0);
