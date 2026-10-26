// gateway: none
// probe_crystaltaps -- UNBLOCK-2 (D-20261013-03), the failing-first check in a real browser: crystal_look reaches a pair
// behind a tap by tapping first, and its table says UNEVEN from the numbers. The arm is the same as verify_crystallook's
// BEHIND A TAP, which runs after the deploy; this one may run before it.
//
//   node dev/probe_crystaltaps.mjs
import { open, steerDiamond, mockLog, clearMockLog, contentText, turnTools } from './harness.mjs';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const NAME = 'TapCrystal';

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

const s = await open({ name: 'crystaltaps', signIn: true, connect: true, defaults: false,
	route: async (p) => { await p.setViewportSize({ width: 1280, height: 800 }); } });
const pg = s.page;

await pg.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
await pg.waitForTimeout(900);
await pg.fill('.dlg-input', NAME).catch(() => {});
await pg.locator('.modal.dlg .dlg-ok').first().click({ timeout: 10000 }).catch(() => {});	// a real click on the visible OK (NO-FORCE)
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
		for (const r of log) { const t = turnTools(r, directive); if (t.length > results.length) results = t; }
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

console.log('\nBEHIND A TAP (UNBLOCK-2): a pair a tile opens, 36 and 38 px, is reached by tapping and called UNEVEN');
// His Lifelog "Log it"/"Edit group" live in the card a group tile opens. A look without taps finds nothing and says
// how to reach it; with taps it clicks the tile in the read-only copy, measures both, and the table says UNEVEN.
{
	const tapPage = page(53).replace('</style>', '.card{display:none;position:absolute;top:300px;left:8px}.card.on{display:block}'
		+ '.acts button{box-sizing:border-box}.acts .go{height:36px}.acts .ghost{height:38px}</style>')
		.replace('<main id="out"', '<div class="tile" onclick="document.querySelector(\'.card\').classList.add(\'on\')">Diet</div>'
			+ '<div class="card"><div class="acts"><button class="go">Log it</button> <button class="ghost">Edit group</button></div></div><main id="out"');
	await pg.evaluate(async ({ id, html }) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		await m.write_file('diamonds/' + id + '/crystal.html', html);
	}, { id, html: tapPage });
	const bare = 'crystal_look ' + JSON.stringify({ targets: ['.acts button'] });
	const tapped = 'crystal_look ' + JSON.stringify({ targets: ['.acts button'], taps: ['.tile'] });
	const [b, t] = await turn('@seq ' + [bare, tapped].join(' ;; '), 2);
	show(b || '(no result)'); show(t || '(no result)');
	check('without taps the pair is not on the first screen, and the table says how to reach it',
		/nothing visible matches; if a tap shows it, name that in taps/.test(b || ''), (b || '').slice(0, 200));
	check('with taps the tile is tapped first', /measured after tapping '\.tile'/.test(t || ''), (t || '').slice(0, 200));
	check('and the pair is measured UNEVEN, 36 vs 38', /heights: UNEVEN, row at y [\d.]+: \.acts button 36\.0 vs \.acts button 38\.0\./.test(t || ''),
		((t || '').split('\n').find((l) => /^heights:/.test(l)) || '(no heights line)'));
}

console.log(`\n${ok} ok, ${bad} failed`);
await s.browser?.close?.().catch(() => {});
process.exit(bad ? 1 : 0);
