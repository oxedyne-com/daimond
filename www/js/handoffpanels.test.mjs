/* handoffpanels.test.mjs -- P2.3a5: what a handed-off turn shows the asker, read without frames.

   The turn frames are gone (P2.3a2), and two things they carried go with them unless they are
   read from elsewhere (lead ruling (b), 30 Oct):
   - PANEL INTENTS. A runner showing a file or a page for another device's turn (file_show,
     web_open) puts it on the ASKER's screen. The asker derives that from the tool row the log
     already holds (its name and args), each row once, only for a turn it handed off.
   - THE HAND-OFF TILE'S WORKERS. Read from the peers' `agents.<device>` frames, which the
     progress door still serves: the runs naming the turn, checked as every run off the door is.

   node www/js/handoffpanels.test.mjs   (needs www/pkg: dev/build-wasm.sh --no-opt) */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPage } from '../../dev/pagesrc.mjs';
import { loadSeal, installSeal } from './sealfixture.mjs';
import { liftFn } from './testlift.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

const wasm = await loadSeal();
const seal = installSeal({});
const TL = await import('./page/turnlog.js');

// ── INTENT: a tool row read as a panel intent ──
console.log('\nINTENT\n');
const tool = (name, args, extra) => Object.assign({ mid: 'x', role: 'tool_log', name, args: JSON.stringify(args) }, extra || {});
const pi = TL.panelIntent || (() => ({ show: '', page: -1 }));
check('INTENT the reader exists', typeof TL.panelIntent === 'function');
check('INTENT file_show: path and page', JSON.stringify(pi(tool('file_show', { path: 'book/main.pdf', page: 7 })))
	=== '{"show":"book/main.pdf","page":7}', JSON.stringify(pi(tool('file_show', { path: 'book/main.pdf', page: 7 }))));
check('INTENT file_show: no page, or none worth having, is 0', pi(tool('file_show', { path: 'a.md' })).page === 0
	&& pi(tool('file_show', { path: 'a.md', page: -3 })).page === 0);
check('INTENT file_show: a path is cut at 1024', pi(tool('file_show', { path: 'p'.repeat(3000) })).show.length === 1024);
check('INTENT web_open: an http(s) page', JSON.stringify(pi(tool('web_open', { url: ' https://example.org/a ' })))
	=== '{"web":"https://example.org/a"}');
check('INTENT web_open: javascript:, blob: and over-long addresses are refused',
	pi(tool('web_open', { url: 'javascript:alert(1)' })) === null && pi(tool('web_open', { url: 'blob:x' })) === null
	&& pi(tool('web_open', { url: 'https://e.org/' + 'w'.repeat(2048) })) === null);
check('INTENT nothing from another tool, a non-tool row, bad args or no path',
	pi(tool('file_read', { path: 'a.md' })) === null && pi({ role: 'assistant', name: 'file_show', args: '{"path":"a"}' }) === null
	&& pi({ role: 'tool_log', name: 'file_show', args: '{nope' }) === null && pi(tool('file_show', {})) === null
	&& pi(tool('file_show', { path: 7 })) === null);
// The runner queues no intent since P2.3d, so turnlog.js holds the one address rule.
check('INTENT the address rule is one, in turnlog.js', ['consent.js', 'handoff.js']
	.every((f) => !/function uiWebUrl/.test(readFileSync(join(HERE, 'page', f), 'utf8'))));

// ── FRESH: a read tells the page each row it drew for the first time ──
console.log('\nFRESH\n');
let seq = 0;
function wire(turn, n, kind, body) {
	const head = { seq: ++seq, turn, n, kind, member: 'acct', daimon: '', at: 1000 + seq, len: 0 };
	return JSON.parse(wasm.row_wire(JSON.stringify(head), wasm.row_seal(JSON.stringify(head), JSON.stringify(body))));
}
const isTile = (m, t) => m.why === 'dispatched' && String(m.iturn) === String(t);
const fresh = [], changed = [];
const log = [];
const deps = {
	seal, unwrap: async (b) => b, isTile,
	join: (a, b) => Object.assign({}, a, b),
	onEnd: () => {},
	onRows: (chat, t, ms, ch) => { fresh.push([t, ms.map((m) => m.mid).join(',')]); changed.push([t, (ch || []).map((m) => m.mid).join(',')]); },
	read: async (_id, since) => ({ ok: true, rows: log.filter((r) => r.seq > since), more: false }),
};
const chat = { id: 'c1', _loaded: true, messages: [{ mid: 'u1', role: 'user', content: 'hi', ts: 900, iturn: 'T1' },
	{ mid: 'ph1', role: 'assistant', content: '', why: 'dispatched', iturn: 'T1', ts: 901 }] };
log.push(wire('T1', 1, 'msg', { mid: 'u1', role: 'user', text: 'hi' }));
log.push(wire('T1', 2, 'msg', { mid: 's1', role: 'tool_log', text: '{"shown":false}', meta: { name: 'file_show', args: '{"path":"a.md"}' } }));
await TL.readChat(chat, deps);
check('FRESH the rows drawn first here are told, those already held are not', JSON.stringify(fresh) === '[["T1","s1"]]', JSON.stringify(fresh));
const s1 = chat.messages.find((m) => m.mid === 's1');
check('FRESH a tool row keeps its name and args (the meta)', !!s1 && s1.name === 'file_show' && s1.args === '{"path":"a.md"}', JSON.stringify(s1));
log.push(wire('T1', 3, 'edit', { mid: 's1', role: 'tool_log', text: '{"shown":false,"asker":"A"}', meta: { name: 'file_show', args: '{"path":"a.md"}' } }));
log.push(wire('T1', 4, 'end', { status: 'done', totals: null, alerts: [], undo: null, tried: [] }));
fresh.length = 0;
await TL.readChat(chat, deps);
check('FRESH an edit of a row drawn already, and the end, are not fresh', fresh.every((f) => f[1] === ''), JSON.stringify(fresh));
// The tool's result lands as an edit of its row, so the reader is told the rows an edit changed (P2.3d).
check('CHANGED an edited row is told as changed', changed.some((c) => c[1] === 's1'), JSON.stringify(changed));

// ── OPEN: the asker opens what its handed-off turn showed, each once, in order ──
console.log('\nOPEN\n');
const hsrc = readFileSync(join(HERE, 'page/handoff.js'), 'utf8');
const FNS = ['onLogRows', 'openIntent'];
const lifted = FNS.map((n) => liftFn(readPage(join(HERE, 'daimond.js'), 'utf8'), n));
check('OPEN the page functions exist', lifted.every(Boolean), FNS.filter((n, i) => !lifted[i]).join(','));
if (lifted.every(Boolean)) {
	const shown = [];
	let fail = 0;
	const W = {
		DaimondDoc: { show: async (p, page, owner) => { if (fail > 0) { fail--; throw new Error('not here yet'); } shown.push(['show', p, page || 0, owner]); } },
		DaimondWeb: { open: async (u, owner) => { shown.push(['web', u, owner]); } },
	};
	const S = {
		REASON_DISPATCHED_STR: 'dispatched', UI_RETRY_MS: [1, 1, 1],
		_uiDone: Object.create(null), _uiChain: Object.create(null),
		selfDeviceId: () => 'ASKER', diag: () => {}, panelIntent: TL.panelIntent,
		dispatchedPlaceholderIn: (c, t) => c.messages.find((m) => m.why === 'dispatched' && String(m.iturn) === t && !m.content) || null,
	};
	const keys = Object.keys(S);
	const api = new Function('S', 'window', keys.map((k) => 'var ' + k + ' = S.' + k + ';').join('\n') + '\n'
		+ 'var DaimondDoc = window.DaimondDoc, DaimondWeb = window.DaimondWeb;\n'
		+ lifted.join('\n') + '\nreturn { onLogRows: onLogRows };')(S, W);
	const settle = () => new Promise((r) => setTimeout(r, 30));
	const mine = { id: 'cA', diamondId: 'D1', _loaded: true, messages: [{ mid: 'pA', role: 'assistant', content: '', why: 'dispatched', iturn: 'TA', dispatchedBy: 'ASKER' }] };
	const theirs = { id: 'cB', _loaded: true, messages: [{ mid: 'pB', role: 'assistant', content: '', why: 'dispatched', iturn: 'TB', dispatchedBy: 'OTHER' }] };
	fail = 1;		// the file has not synced here yet: the show is tried again
	const ok = (mid) => ({ mid, content: '{"shown":false,"asker":"A"}', outcome: 'done' });
	api.onLogRows(mine, 'TA', [tool('file_show', { path: 'n.md', page: 2 }, ok('r1')),
		{ mid: 'r2', role: 'assistant', content: 'done' }, tool('web_open', { url: 'https://e.org/' }, ok('r3'))]);
	await settle();
	check('OPEN the shows of a turn handed off from here, in order, under the turn\'s owner, the first retried',
		JSON.stringify(shown) === '[["show","n.md",2,"D1"],["web","https://e.org/","D1"]]', JSON.stringify(shown));
	shown.length = 0;
	api.onLogRows(mine, 'TA', [tool('file_show', { path: 'n.md', page: 2 }, ok('r1'))]);
	api.onLogRows(theirs, 'TB', [tool('file_show', { path: 'b.md' }, ok('q1'))]);
	api.onLogRows(mine, 'TZ', [tool('file_show', { path: 'z.md' }, ok('z1'))]);
	await settle();
	check('OPEN nothing twice, nothing for another device\'s hand-off, nothing for a turn not handed off',
		shown.length === 0, JSON.stringify(shown));
	// Since LAG-1b readChatLog's onRows also tells the arrivals, then hands the rows to onLogRows.
	check('OPEN the reader is wired: readChatLog passes onRows', /onRows:\s*(onLogRows|function\s*\(c, t, fresh, changed\)\s*\{[\s\S]{0,300}?onLogRows\(c, t, fresh, changed\);\s*\})/.test(hsrc));

	// A show the runner refused is not the asker's to retry: its tool row's result says so (P2.3d).
	shown.length = 0;
	api.onLogRows(mine, 'TA', [tool('file_show', { path: 'w.md' }, { mid: 'r4' })]);	// the call, no result yet
	await settle();
	check('REFUSED a show with no result yet waits for it', shown.length === 0, JSON.stringify(shown));
	api.onLogRows(mine, 'TA', [], [tool('file_show', { path: 'w.md' }, { mid: 'r4', content: 'Refused: outside the workspace.', outcome: 'refused' })]);
	api.onLogRows(mine, 'TA', [tool('web_open', { url: 'https://r.org/' }, { mid: 'r5', content: 'Refused.', outcome: 'refused' })]);
	await settle();
	check('REFUSED a show or a page the runner refused is never opened here', shown.length === 0, JSON.stringify(shown));
	api.onLogRows(mine, 'TA', [], [tool('file_show', { path: 'w.md' }, { mid: 'r4', content: 'x', outcome: 'done' })]);
	await settle();
	check('REFUSED and stays given up', shown.length === 0, JSON.stringify(shown));
	api.onLogRows(mine, 'TA', [tool('file_show', { path: 'k.md' }, { mid: 'r6' })]);
	api.onLogRows(mine, 'TA', [], [tool('file_show', { path: 'k.md' }, ok('r6'))]);
	await settle();
	check('DONE a show whose result lands by an edit opens then, once', JSON.stringify(shown) === '[["show","k.md",0,"D1"]]', JSON.stringify(shown));
}

// ── WORKERS: the hand-off tile's workers, from the peers' agents frames ──
console.log('\nWORKERS\n');
const window = {};
new Function('window', readPage(join(HERE, 'peer.js'), 'utf8'))(window);
const P = window.DaimondPeer;
check('WORKERS the reader exists', typeof P.turnWorkers === 'function');
if (typeof P.turnWorkers === 'function') {
	const frame = JSON.stringify({ v: 1, dev: 'RUN', runs: [
		{ id: 'w1', name: 'tests', status: 'running', turnId: 'T1' },
		{ id: 'w2', status: 'done', turnId: 'T1', endedAt: Date.now() },
		{ id: 'w3', name: 'n'.repeat(500), status: 'paused', turnId: 'T1' },
		{ id: 'w4', name: 'bad', status: 'exploded', turnId: 'T1' },
		{ name: 'no id', status: 'running', turnId: 'T1' },
		{ id: 'w5', name: 'other turn', status: 'running', turnId: 'T2' },
		'junk', null,
	] });
	const got = P.agentsFromFrame(frame, 'RUN');
	const store = P.peerRunsMerge({}, got, Date.now());
	const runs = P.peerRunsList(store, null, [], Date.now());
	const ws = P.turnWorkers(runs, 'T1');
	check('WORKERS the turn\'s runs, checked: unknown state, no id, junk and another turn\'s left out',
		ws.map((w) => w.id).join() === 'w1,w2,w3', JSON.stringify(ws));
	check('WORKERS each is { id, name, status }, a missing name its id, a long one cut',
		JSON.stringify(ws[0]) === '{"id":"w1","name":"tests","status":"running"}' && ws[1].name === 'w2' && ws[2].name.length === 80,
		JSON.stringify(ws));
	const gone = P.turnWorkers(P.peerRunsList(store, [], [], Date.now()), 'T1');
	check('WORKERS a runner not awake reads its live workers interrupted', gone[0].status === 'interrupted', JSON.stringify(gone));
	check('WORKERS none for no turn or no runs', P.turnWorkers(runs, '').length === 0 && P.turnWorkers(null, 'T1').length === 0);
}
const tsrc = readFileSync(join(HERE, 'page/turns.js'), 'utf8');
const wsrc = readFileSync(join(HERE, 'page/workers.js'), 'utf8');
check('WORKERS the hand-off tile draws them again', /drawHandoffWorkers\(tile, m\.iturn\)/.test(tsrc)
	&& /export function drawHandoffWorkers/.test(hsrc) && /turnWorkers\(/.test(hsrc));
check('WORKERS a peer\'s agents frame redraws the tiles', /redrawHandoffWorkers\(\)/.test(wsrc.slice(wsrc.indexOf('take: function'), wsrc.indexOf('draw: function'))));

console.log('\n' + (checks - failures) + '/' + checks + ' passed');
if (failures) process.exit(1);
