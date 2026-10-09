// gateway: none
// verify_crystallook — a daimon that restyles its Diamond's page can MEASURE the page before and after, as the owner sees
// it, and a daimon that restyles it and never looks is looked for by the engine before it answers (D-20261009-27).
//
// WHY THIS EXISTS. 9 Oct 2026, the Life log Diamond: asked to make the buttons' heights consistent, a daimon edited the CSS,
// never looked, and said "done"; on 8 Oct the owner had answered the same kind of "done" with "I'm not seeing any
// difference".  The load proof (verify_crystalproof) says the page DRAWS; only a measurement says a button grew.
// `crystal_look` draws the stored page off screen with the owner's theme and data and measures what it is told to; an edit
// after a look measures the same targets again in its own result; and a turn that wrote the page and never looked has its
// ending turned into the engine's own look (a `capture` in:"crystal", call id look_auto_<n>, unique in the conversation, in the tool log), which a model
// that reads no pictures has described by the account's default images model when the Diamond chose none.
//
// Arms: LOOKED (look, edit .go 37 -> 53 px, look again: the numbers move, the edit re-measures, the answer quotes them, no
// engine look) and NEVER LOOKED, NO IMAGES MODEL (edit .go 53 -> 61 px and stop: the engine looks, measuring .go at 61, and
// the cheapest seeing priced model of a maker the account uses describes it, named with its rule and cost) and A PAGE THAT
// FAILS ITS LOAD PROOF (crystal.json unreadable: the proof's must-fix comes first and the engine does not look).
//
//   node dev/verify_crystallook.mjs
import { open, steerDiamond, mockLog, clearMockLog, contentText } from './harness.mjs';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const NAME = 'LookCrystal';

const CRYSTAL = {
	title: 'Life log',
	summary: 'A log of the day, one line at a time, with groups to keep them in.',
	sections: [{ heading: 'Today', body: 'Walked. Read.' }],
};

/// A page that speaks the protocol, draws the crystal and two buttons whose height `h` sets.
const page = (h) => [
	'<!doctype html><meta charset="utf-8"><title>page</title>',
	'<style>body{margin:0}.bar{position:absolute;top:8px;left:8px}.go{height:' + h + 'px;box-sizing:border-box}</style>',
	'<body><div class="bar"><button class="go">Log it</button> <button class="go">Edit group</button></div>',
	'<main id="out" style="margin-top:80px"></main>',
	'<script>',
	'(function () {',
	'	var send = function (m) { parent.postMessage(m, "*"); };',
	'	var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); };',
	'	addEventListener("message", function (e) {',
	'		var d = e.data;',
	'		if (!d || d.dc !== 1 || d.cmd !== "data") return;',
	'		var data = d.data || {};',
	'		document.getElementById("out").innerHTML = "<h1>" + esc(data.title) + "</h1><p>" + esc(data.summary) + "</p>"',
	'			+ (data.sections || []).map(function (s) { return "<h2>" + esc(s.heading) + "</h2><p>" + esc(s.body) + "</p>"; }).join("");',
	'		send({ dc: 1, v: 1, cmd: "rendered", keys: Object.keys(data).filter(function (k) { return k.charAt(0) !== "_"; }) });',
	'	});',
	'	send({ dc: 1, v: 1, cmd: "ready" });',
	'}());',
	'<\/script>',
].join('\n');

const s = await open({ name: 'crystallook', signIn: true, connect: true, defaults: false,
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
await pg.evaluate(async ({ id, json, html }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.write_file('diamonds/' + id + '/crystal.json', json);
	await m.write_file('diamonds/' + id + '/crystal.html', html);
}, { id, json: JSON.stringify(CRYSTAL, null, 2), html: page(37) });
await pg.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
await pg.waitForTimeout(900);

// This turn's tool results only: the session's history carries every earlier turn's too.
const toolsIn = (r) => {
	const m = (r && r.messages) || [];
	let k = m.length - 1;
	while (k >= 0 && !(m[k].role === 'user' && /^@/.test(contentText(m[k].content).trim()))) k--;
	return m.slice(k + 1).filter((x) => x.role === 'tool');
};
// The engine's own look: an assistant tool call with the look_auto id, in any request of the turn.
// This turn's engine looks, as calls: those in its latest request beyond the ones its first request carried as history.
const autoCalls = () => {
	const calls = (q) => ((q && q.messages) || []).filter((m) => m.role === 'assistant')
		.flatMap((m) => m.tool_calls || []).filter((c) => /^look_auto/.test(c.id || ''));
	const log = mockLog();
	if (!log.length) return [];
	const latest = log.reduce((a, q) => (((q && q.messages) || []).length > ((a && a.messages) || []).length ? q : a), log[0]);
	const prior = new Set(calls(log[0]).map((c) => c.id));
	return calls(latest).filter((c) => !prior.has(c.id));
};
const autoResult = () => {
	// This turn's LAST: a request carries the session's earlier turns, and their looks, too, so the looks already in the
	// turn's first request (its history) are passed over, by id: each engine look's id is unique in the conversation (r546 F1).
	const looks = (q) => ((q && q.messages) || []).filter((m) => m.role === 'tool' && /^look_auto/.test(m.tool_call_id || ''));
	const log = mockLog();
	if (!log.length) return '';
	const prior = new Set(looks(log[0]).map((m) => m.tool_call_id));
	const latest = log.reduce((a, q) => (((q && q.messages) || []).length > ((a && a.messages) || []).length ? q : a), log[0]);
	const fresh = looks(latest).filter((m) => !prior.has(m.tool_call_id));
	let said = fresh.length ? contentText(fresh[fresh.length - 1].content) : '';
	return said;
};

// One turn of the mock daimon: every tool result it was handed, in order, once the turn has settled.
async function turn(directive, calls) {
	clearMockLog();
	await steerDiamond(s, directive);
	let results = [];
	for (let i = 0; i < 240 && results.length < calls; i++) {
		await pg.waitForTimeout(500);
		const log = mockLog();
		for (const r of log) { const t = toolsIn(r); if (t.length > results.length) results = t; }
	}
	await pg.waitForTimeout(5000);
	return results.map((m) => contentText(m.content));
}
// The `.go` rows of a look table, and their h column (the table's columns are target # element x y w h ...).
const goRows = (t) => String(t || '').split('\n').filter((l) => /^\.go\b/.test(l) || /^\s+2\s+button/.test(l));
const heights = (t) => {
	const out = [];
	const head = String(t || '').split('\n').find((l) => /^target\s+#\s+element/.test(l));
	if (!head) return out;
	const at = head.indexOf(' h ') + 1;
	for (const l of goRows(t)) { const m = /^\s*(\d+)/.exec(l.slice(at)); if (m) out.push(Number(m[1])); }
	return out;
};
const show = (t) => console.log(String(t).split('\n').slice(0, 8).map((l) => '       | ' + l.slice(0, 220)).join('\n'));
const edit = (from, to) => 'file_edit ' + JSON.stringify({ path: PAGE_PATH,
	edits: [{ old_string: '.go{height:' + from + 'px', new_string: '.go{height:' + to + 'px' }] });
const look = 'crystal_look ' + JSON.stringify({ targets: ['.go'] });
const read = 'file_read ' + JSON.stringify({ path: PAGE_PATH });

console.log('\nLOOKED: look, edit the buttons 37 -> 53 px, look again');
{
	const r = await turn('@seqreport ' + [look, read, edit(37, 53), look].join(' ;; '), 4);
	const [before, , edited, after] = r;
	show(before || '(no result)');
	check('the first look measures the page', /look at the crystal page/.test(before || ''), (before || '').slice(0, 120));
	check('both buttons measure 37 px before', JSON.stringify(heights(before)) === '[37,37]', JSON.stringify(heights(before)));
	check('the edit lands', !!edited && !/^Refused/i.test(edited.trim()), (edited || '').slice(0, 120));
	check('the edit after a look re-measures the same targets by itself',
		/After this edit, the same measurement/.test(edited || '') && JSON.stringify(heights(edited)) === '[53,53]',
		JSON.stringify(heights(edited)));
	check('the second look measures 53 px', JSON.stringify(heights(after)) === '[53,53]', JSON.stringify(heights(after)));
	let answer = '';
	for (let i = 0; i < 20 && !/Before:/.test(answer); i++) {
		answer = await pg.evaluate(() => document.body.innerText);
		if (!/Before:/.test(answer)) await pg.waitForTimeout(500);
	}
	const said = (/Before:[^\n]*/.exec(answer) || [''])[0];
	check('the answer carries the measured numbers, before and after', /\b37\b/.test(said) && /After:.*\b53\b/.test(said), said.slice(0, 200));
	check('a turn that looked after its edit is not looked for again', autoCalls().length === 0, String(autoCalls().length));
}

console.log('\nNEVER LOOKED, NO IMAGES MODEL: edit the buttons 53 -> 61 px and stop');
{
	const r = await turn('@seq ' + [read, edit(53, 61)].join(' ;; '), 3);
	check('the edit lands', !!r[1] && !/^Refused/i.test(r[1].trim()), (r[1] || '').slice(0, 120));
	let said = '';
	for (let i = 0; i < 60 && !said; i++) { said = autoResult(); if (!said) await pg.waitForTimeout(500); }
	show(said || '(no engine look)');
	const calls = autoCalls();
	const args = calls.length ? String((calls[0].function || {}).arguments || '') : '';
	check('the engine looks, as a capture in the tool log', calls.length >= 1 && (calls[0].function || {}).name === 'capture'
		&& /"in":"crystal"/.test(args) && /"targets":\[".go"\]/.test(args), args);
	check('its result opens on what it is', /^The engine looked at your page/.test(said), said.slice(0, 120));
	const hs = heights(said);
	check('it measures what the edit styled: .go at 61 px', hs.length >= 2 && hs.every((h) => h === 61), JSON.stringify(hs));
	const line = (said.split('\n').find((l) => /Seen at \d+ px by/.test(l)) || '');
	console.log('       | ' + line.slice(0, 240));
	check('the account\'s default images model describes it, named, with its cost',
		/by the account's default images model \(mock\/cheap-eyes, the cheapest that takes pictures from a maker the account already uses; \d+ tokens, \$0\.0*[1-9]\d?\)/.test(line), line.slice(0, 200));
	check('no "No images model is set" while one is on the account', !/No images model is set/.test(said));
	check('the engine looks once for one edit', calls.length === 1, String(calls.length));
}

console.log('\nA PAGE THAT FAILS ITS LOAD PROOF: crystal.json unreadable, edit the buttons 61 -> 62 px and stop');
// An unreadable crystal.json fails the page's load proof, and the proof's must-fix comes before any look: the engine does
// not look at a page it already knows is broken, and the daimon is told what to mend.  (Settled 10 Oct on world 99: this arm
// never reaches a look.  A look that is taken and fails says why in its result; the native test
// test_a_turn_that_wrote_its_page_is_looked_at_before_it_ends_00 holds that path.)
{
	await pg.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		await m.write_file('diamonds/' + id + '/crystal.json', '{ not json');
	}, id);
	const r = await turn('@seq ' + [read, edit(61, 62)].join(' ;; '), 3);
	let proof = '';
	for (const t of r) { const m = /[^\n]*(must-fix|load proof)[^\n]*/i.exec(t || ''); if (m) proof = m[0]; }
	show(proof || '(no load proof line)');
	check('the edit lands', r.some((t) => /^Edited /.test(t || '')), r.map((t) => String(t || '').slice(0, 40)).join(' | '));
	check('the load proof\'s must-fix is in the turn\'s results', !!proof, proof.slice(0, 200));
	await pg.waitForTimeout(3000);
	check('and the engine does not look at a page its proof failed', autoCalls().length === 0 && !autoResult(), String(autoCalls().length));
}

console.log(`\n${ok} ok, ${bad} failed`);
await s.browser?.close?.().catch(() => {});
process.exit(bad ? 1 : 0);
