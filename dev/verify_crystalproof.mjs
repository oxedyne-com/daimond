// gateway: none
// verify_crystalproof — an edit of a Diamond's page is followed by the LOAD PROOF, read from outside the page as the owner
// sees it, and the daimon is told in the edit's own result whether the page passed.
//
// WHY THIS EXISTS. D-20261008-08, the Ontheism Diamond: a daimon asked for an infographic wrote a page that showed a JSON dump,
// then one that showed a KEYMAP debug list, and said it was done both times, because nothing it could read told it what the
// owner saw (specs/daimond_ontheism_infographic_20261008.md).  K1 draws the stored page off screen after every write of
// `crystal.html` or `crystal.json`, reads its visible text against the crystal, and answers the write with "MUST FIX ... load
// proof" or "Load proof: pass"; a pass marks that version as the last that passed, which K2 restores from.
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

// K2 x K1: a page that fails the proof after one has passed. The turn ends Blocked over it, AND the page that passed comes
// back, with the "Bring back" toast for the failing one -- the engine's crystal_restored event run by a real browser turn,
// through the page's own steer, not replayed.
console.log('\nFAILING AFTER A PASS: the turn ends Blocked and the passed page comes back');
{
	const readPage = async () => await pg.evaluate(async (path) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		try { return String(await m.read_file(path)); } catch (e) { return null; }
	}, PAGE_PATH);
	const good = await readPage();
	const bad  = page(DRAW_JSON);
	const t = await writePage(bad);
	check('K2xK1: the failing write says MUST FIX ... load proof', /MUST FIX[^]*load proof/.test(t));
	check('K2xK1: the model is told the must-fix line before the turn ends', await nudged(20000));
	const bringBack = () => pg.evaluate(() => {
		const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Bring back');
		return b ? true : false;
	});
	// The toast lasts 20 s, so it is clicked as soon as it shows; the turn's Blocked end is the end notice's locale-neutral
	// `data-why`, or its sentence where the turn drew nothing else.
	let shown = false;
	for (let i = 0; i < 60 && !shown; i++) { await pg.waitForTimeout(500); shown = await bringBack(); }
	const restored = await readPage();
	let blocked = false;
	for (let i = 0; i < 20 && !blocked; i++) {
		blocked = await pg.evaluate(() => !!document.querySelector('.ended-notice[data-why="blocked"]')
			|| /Not done: the page does not load/.test(document.body.innerText));
		if (!blocked) await pg.waitForTimeout(500);
	}
	const ends = await pg.evaluate(() => [...document.querySelectorAll('.ended-notice')].map((n) => (n.dataset.why || '-') + ':' + n.textContent.trim().slice(0, 60)).join(' | '));
	check('K2xK1: the turn ends Blocked', blocked, blocked ? '' : 'end notices: ' + (ends || 'none'));
	check('K2xK1: the page that passed is back', restored === good, good === null ? 'no page read' : '');
	check('K2xK1: a "Bring back" toast offers the failing page', shown);
	if (shown) {
		await pg.evaluate(() => {
			const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === 'Bring back');
			if (b) b.click();
		});
		let back = null;
		for (let i = 0; i < 20 && back !== bad; i++) { await pg.waitForTimeout(500); back = await readPage(); }
		check('K2xK1: "Bring back" puts the failing page back', back === bad);
	}
}

console.log(`\n${ok} ok, ${bad} failed`);
await s.browser?.close?.().catch(() => {});
process.exit(bad ? 1 : 0);
