/* ============================================================
   Test -- a handed-off turn's lost run leaves nothing behind (r545 QA-C2 F-C2-1).
   ------------------------------------------------------------
   A runner that reloads mid-turn loses the run it was on. Its rows -- streamed to the
   asker as provisional tiles, or persisted on the runner -- belong to no answer, and
   stood beside the turn's ending for good. Each row a handed-off run writes now names
   the run (`run`), the frame carries it, and `otherRunRows` is the one rule every
   device drops the rest by.
     node www/js/runid.test.mjs      # ALL PASS
   On 436db66f: `otherRunRows` is absent and the frame drops `run`, `why` and `itext`.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

export function loadPeer() {
	const store = new Map();
	const win = {
		addEventListener: () => {}, dispatchEvent: () => true,
		localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
	};
	const document = { readyState: 'complete', addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
	const body = readPage(process.env.PEER_JS || join(HERE, 'peer.js'), 'utf8');
	new Function('window', 'document', 'localStorage', 'console', 'with (window) {\n' + body + '\n}')(
		win, document, win.localStorage, { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return win.DaimondPeer;
}

const P = loadPeer();
const T = 'turn1';
const rows = () => [
	{ role: 'user', mid: 'u0', content: 'earlier' },
	{ role: 'assistant', mid: 'a0', content: 'earlier answer', run: 'old' },	// another turn's: never touched
	{ role: 'user', mid: T, content: 'do ten rounds' },
	{ role: 'assistant', mid: 'ph', content: '', why: 'dispatched', iturn: T },		// the asker's placeholder
	{ role: 'tool_log', mid: 't1', run: 'r1', iturn: T },						// the lost run's
	{ role: 'tool_log', mid: 't2', run: 'r2' },								// the standing run's
	{ role: 'think_log', mid: 'p1', provisional: 1, iturn: T },					// streamed, no run finished it
	{ role: 'tool_log', mid: 'p2', provisional: 1, iturn: T, run: 'r2' },		// streamed, in the frame
	{ role: 'assistant', mid: 'x1', content: 'legacy' },						// no run: an older build's
	{ role: 'user', mid: 'u2', content: 'next' },
	{ role: 'tool_log', mid: 'n1', run: 'r9' },								// the next turn's
];

console.log('\notherRunRows -- what a final frame leaves standing');
{
	if (typeof P.otherRunRows !== 'function') { check('DaimondPeer.otherRunRows exists', false); }
	else {
		const out = P.otherRunRows(rows(), T, 'r2', { t2: 1, p2: 1, x1: 1 });
		check('the lost run\'s row and the unfinished streamed row go, in order',
			JSON.stringify(out) === JSON.stringify([{ mid: 't1', provisional: false }, { mid: 'p1', provisional: true }]), JSON.stringify(out));
		const noKeep = P.otherRunRows(rows(), T, 'r2', null);
		check('without the frame\'s mids only a row of another run goes', noKeep.map((r) => r.mid).join() === 't1', JSON.stringify(noKeep));
		const legacy = P.otherRunRows(rows(), T, '', { t2: 1, p2: 1 });
		check('a frame from a build with no run drops only unfinished streamed rows', legacy.map((r) => r.mid).join() === 'p1', JSON.stringify(legacy));
		check('a turn not held drops nothing', P.otherRunRows(rows(), 'nope', 'r2', {}).length === 0);
		check('another turn\'s rows are never touched', !P.otherRunRows(rows(), T, 'r2', {}).some((r) => /^(a0|n1|u2|ph)$/.test(r.mid)));
	}
}

console.log('\nThe lost run names the device it was lost on (check_f234 fix 6, I9)');
{
	const ds = readPage(join(HERE, 'daimond.js'), 'utf8');
	const at = ds.indexOf('\n\tfunction runnerLostLabel(');
	check('daimond.js has runnerLostLabel', at >= 0);
	if (at >= 0) {
		const end = ds.indexOf('\n\t}\n', at) + 4;
		const fn = new Function('deviceLabelFor', 't', ds.slice(at, end) + '\nreturn runnerLostLabel;')(
			(id) => (id === 'devB' ? 'Laptop B' : ''),
			(k, o) => (k === 'turn.peer_interrupted_named' ? 'Interrupted on ' + o.name + '.' : k));
		check('a lost run is named "Interrupted on <device>"', fn({ why: 'runner', lostOn: 'devB' }) === 'Interrupted on Laptop B.', fn({ why: 'runner', lostOn: 'devB' }));
		check('[ctl] an unstamped or unknown device keeps the generic words', fn({ why: 'runner' }) === 'turn.runner_lost' && fn({ why: 'runner', lostOn: 'devZ' }) === 'turn.runner_lost');
		check('markInterrupted draws it', /m\.why === 'runner'\)[\s\S]{0,200}runnerLostLabel\(m\)/.test(ds));
	}
	const stamps = ds.match(/\.why = 'runner';[^\n]*lostOn = selfDeviceId\(\)/g) || [];
	check('all three runner-lost writes stamp lostOn = selfDeviceId()', stamps.length === 3, String(stamps.length));
}

console.log('\nA turn queued behind a running one: its prompt lands before the answer ahead of it (UNBLOCK-1 3d)');
{
	// On the runner, q6 arrived while turn 5 ran, so turn 5's answer stands after q6. It is
	// tagged with turn 5 and stamped with turn 5's run: never turn 6's to drop or to send.
	const q5 = { role: 'user', mid: 'u5', content: 'q5' };
	const q6 = { role: 'user', mid: 'u6', content: 'q6' };
	const a5 = { role: 'assistant', mid: 'a5', iturn: 'u5', content: 'a5', run: 'r5', ts: 3 };
	const a6 = { role: 'assistant', mid: 'a6', iturn: 'u6', content: 'a6', run: 'r6', ts: 4 };
	const msgs = [q5, q6, a5, a6];
	const out = P.otherRunRows(msgs, 'u6', 'r6');
	check('another turn\'s answer standing in this turn\'s span is not this turn\'s other run', out.length === 0, JSON.stringify(out));
	const rows = P.turnSpan(msgs, 'u6').map((r) => r.mid);
	check('nor is it in this turn\'s span', JSON.stringify(rows) === '["a6"]', JSON.stringify(rows));
	const q7 = { role: 'user', mid: 'u7', content: 'q7' };
	const late = P.turnSpan([q5, q6, q7, a5, a6], 'u6').map((r) => r.mid);
	check('and a row tagged with this turn past the next prompt is', JSON.stringify(late) === '["a6"]', JSON.stringify(late));
	const stale = { role: 'assistant', mid: 'a6x', iturn: 'u6', content: 'old', run: 'r0', ts: 2 };
	const kept = P.otherRunRows([q5, q6, a5, stale, a6], 'u6', 'r6').map((g) => g.mid);
	check('[ctl] this turn\'s own row of another run still goes', JSON.stringify(kept) === '["a6x"]', JSON.stringify(kept));
	const loose = { role: 'end_log', mid: 'e6', content: '', run: 'r0' };
	const pos = P.otherRunRows([q5, q6, loose, a6], 'u6', 'r6').map((g) => g.mid);
	check('[ctl] an untagged row is this turn\'s by position, as before', JSON.stringify(pos) === '["e6"]', JSON.stringify(pos));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exitCode = failures ? 1 : 0;
