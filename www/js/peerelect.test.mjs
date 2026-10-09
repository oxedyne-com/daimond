/* ============================================================
   Test — the busy-aware hand-off election (H1).
   ------------------------------------------------------------
   A machine running a turn collects the next errand only when
   that turn ends, so seating it made a sender wait out its
   ~100 s backstop and run the turn itself. Driven against the
   real www/js/peer.js in a simulated tab:

     A. `busy` on the beat is a depth and TRI-STATE through
        `presenceBeat`, `presenceIngest` and `presenceAdopt`:
        absent (an older peer or gateway) stays absent.
     B. The election passes a busy peer over for an idle one,
        names it in `passed`, and still seats it for the chat
        it is already running (`queueOn`). A peer whose beat
        cannot say is seated as before (mixed-version safe).
     C. A busy nominee does not make others stand down.
     D. A busy runner answers a collected errand AT ONCE: a
        `busy` report when the turn waits on it, a held row
        when an idle desk beside it will claim; never a run.
     E. `decideNow` takes such an errand out of the work chain.

   Run:  node www/js/peerelect.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}

// ── One simulated tab, the pattern peer.test.mjs established ──
function makeTab(scripts) {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
	};
	const document = {
		readyState: 'complete', addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	function CustomEventShim(t, o) { this.type = t; this.detail = o && o.detail; }
	const quiet = { debug: () => {}, log: () => {}, warn: console.warn, error: console.error };
	for (const rel of ['stamp.js'].concat(scripts)) {		// the shared stamp rule first, as index.html
		const body = readFileSync(join(HERE, rel), 'utf8');
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage',
			'TextEncoder', 'TextDecoder', 'CustomEvent', 'Blob',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
			'console', 'globalThis', 'navigator',
			'with (window) {\n' + body + '\n}');
		fn(win, document, webcrypto, localStorage,
			TextEncoder, TextDecoder, CustomEventShim, Blob,
			setTimeout, clearTimeout, setInterval, clearInterval,
			quiet, globalThis, { storage: {} });
	}
	win.__localStorage = localStorage;
	return win;
}

function sentErrand(P, f) {
	const o = Object.assign({ ts: Date.now() }, f);
	o.seed = { chatId: o.chatId, title: '', provider: '', model: '',
		msgs: [{ role: 'user', content: 'p', mid: o.turnId, ts: o.ts }] };
	return P.makeErrand(o);
}

const NOM  = 'n0000000000000000000000000000000';
const DESK = 'd0000000000000000000000000000000';
const SELF = 's0000000000000000000000000000000';

const win = makeTab(['peer.js']);
const P = win.DaimondPeer, Pr = win.DaimondPresence;
const W = P.DISPATCH_FRESH_MS;

console.log('\n— A: `busy` is a depth, tri-state end to end —');
{
	const now = Date.now();
	Pr.forget();
	Pr.beat(NOM,  'argonaut', now, false, true, 'b1', true, false, null, null, 2);
	Pr.beat(DESK, 'oldbox',   now, false, true, 'b0', true, false);
	let snap = Pr.snapshot();
	check('A1 a beat that says busy carries its depth', snap[NOM] && snap[NOM].busy === 2, JSON.stringify(snap[NOM]));
	check('A1 a beat that cannot say carries NO busy field', snap[DESK] && !('busy' in snap[DESK]), JSON.stringify(snap[DESK]));
	Pr.beat(NOM, 'argonaut', now + 1000, false, true, 'b1', true, false, null, null, 0);
	check('A2 an explicit 0 unsays busy', Pr.snapshot()[NOM].busy === 0);
	check('A3 busyDepth reads an old boolean true as one, junk as zero',
		typeof P.busyDepth === 'function' && P.busyDepth(true) === 1 && P.busyDepth('3') === 3 && P.busyDepth(-1) === 0 && P.busyDepth('x') === 0);
	Pr.forget();
	Pr.ingest({
		[NOM]:  { name: 'argonaut', last_seen: now, busy: 1 },
		[DESK]: { name: 'oldbox',   last_seen: now },
	}, now);
	snap = Pr.snapshot();
	check('A4 ingest relays busy verbatim', snap[NOM].busy === 1);
	check('A4 and OMITS it when the gateway did not send it', !('busy' in snap[DESK]), JSON.stringify(snap[DESK]));
	Pr.forget();
}

console.log('\n— B: the election passes a busy peer over —');
{
	const now = Date.now();
	const rec = (name, busy) => Object.assign({ name, lastSeen: now }, busy == null ? {} : { busy });
	const opts = (x) => Object.assign({ selfId: SELF, windowMs: W, nominatedId: NOM }, x || {});
	let r = P.handoffTarget({ [NOM]: rec('argonaut', 1), [DESK]: rec('desk', 0) }, opts(), now);
	check('B1 a busy nominee is passed over for the idle desk',
		!!r.target && r.target.deviceId === DESK, JSON.stringify(r.target));
	check('B1 and is named in `passed` with its depth',
		Array.isArray(r.passed) && r.passed.length === 1 && r.passed[0].deviceId === NOM && r.passed[0].busy === 1,
		JSON.stringify(r.passed));
	r = P.handoffTarget({ [NOM]: rec('argonaut', 1) }, opts(), now);
	check('B2 with no idle peer the turn runs LOCAL rather than wait on the busy one', !r.target, JSON.stringify(r.target));
	r = P.handoffTarget({ [NOM]: rec('argonaut', 1), [DESK]: rec('desk', 0) }, opts({ queueOn: NOM }), now);
	check('B3 the device already running THIS chat is still seated (the turn queues there)',
		!!r.target && r.target.deviceId === NOM, JSON.stringify(r.target));
	r = P.handoffTarget({ [NOM]: rec('argonaut'), [DESK]: rec('desk') }, opts(), now);
	check('B4 a beat that cannot say busy is seated as before (mixed-version safe)',
		!!r.target && r.target.deviceId === NOM && r.passed.length === 0, JSON.stringify(r));
	r = P.handoffTarget({ [DESK]: rec('desk', 2), [NOM]: rec('other', 0) }, opts({ nominatedId: '' }), now);
	check('B5 among plain desktops the busy one is passed over too',
		!!r.target && r.target.deviceId === NOM, JSON.stringify(r.target));
	const d = P.autoDispatchDecision({ id: 'c1' }, { [NOM]: rec('argonaut', 1), [DESK]: rec('desk', 0) },
		{ selfId: SELF, nominatedId: NOM }, now);
	check('B6 autoDispatchDecision carries `passed` out', Array.isArray(d.passed) && d.passed.length === 1 && d.passed[0].deviceId === NOM,
		JSON.stringify(d.passed));
}

console.log('\n— C: a busy nominee does not make others stand down —');
{
	const now = Date.now();
	check('C1 an idle fresh nominee: others stand down',
		P.nominationStandDown(NOM, SELF, { [NOM]: { name: 'n', lastSeen: now, busy: 0 } }, now, W) === true);
	check('C2 a busy fresh nominee: an idle device claims',
		P.nominationStandDown(NOM, SELF, { [NOM]: { name: 'n', lastSeen: now, busy: 1 } }, now, W) === false);
}

console.log('\n— D: a busy runner answers the errand at once —');
{
	const now = Date.now();
	const base = (over) => {
		const seen = { ran: 0, posts: [] };
		const deps = Object.assign({
			cas: { read: async () => ({ version: 1, leases: {} }), write: async () => ({ ok: true }) },
			finished: async () => false,
			reconstruct: async () => ({ chat: {}, app: {} }),
			runTurn: async () => { seen.ran++; },
			abort: () => {}, pushResult: async () => 1,
			post: async (r) => { seen.posts.push(r); }, ack: async () => {},
			freshWindowMs: W,
			busyFor: () => 1,
		}, over);
		return { deps, seen };
	};
	{
		const { deps, seen } = base({ selfId: NOM, nominatedId: NOM, presence: {} });
		const e = sentErrand(P, { turnId: 't-busy-1', chatId: 'c2', eid: 'e1', deadline: 0, dispatchedBy: SELF });
		const res = await P.runErrand(e, deps);
		check('D1 the busy nominee answers `busy` and does not run', res.why === 'busy' && seen.ran === 0, JSON.stringify(res));
		check('D1 with a busy report naming itself', seen.posts.length === 1 && seen.posts[0].status === 'busy' && seen.posts[0].by === NOM,
			JSON.stringify(seen.posts.map((p) => ({ status: p.status, by: p.by }))));
	}
	{
		const { deps, seen } = base({ selfId: NOM, nominatedId: '', presence: {
			[DESK]: { name: 'desk', lastSeen: now, busy: 0 } } });
		const e = sentErrand(P, { turnId: 't-busy-2', chatId: 'c2', eid: 'e2', deadline: 0, dispatchedBy: SELF });
		const res = await P.runErrand(e, deps);
		check('D2 with an idle desk beside, a busy non-nominee HOLDS the row and says nothing',
			res.why === 'busy-hold' && seen.ran === 0 && seen.posts.length === 0, JSON.stringify(res));
		check('D2 and the hold is an undecided stand-down (the errand stays for the idle desk)',
			P.standDownUndecided('busy-hold') === true);
	}
	{
		const { deps, seen } = base({ selfId: NOM, nominatedId: '', presence: {} });
		const e = sentErrand(P, { turnId: 't-busy-3', chatId: 'c2', eid: 'e3', deadline: 0, dispatchedBy: SELF });
		const res = await P.runErrand(e, deps);
		check('D3 with no idle desk beside it, the busy device answers `busy`',
			res.why === 'busy' && seen.posts.length === 1 && seen.posts[0].status === 'busy', JSON.stringify(res));
	}
}

console.log('\n— E: decideNow takes a busy errand out of the work chain —');
{
	const e = sentErrand(P, { turnId: 't-now', chatId: 'c2', eid: 'e4', deadline: 0, dispatchedBy: SELF });
	if (typeof P.decideNow === 'function') check('E1 no probe registered: never decided now', P.decideNow(e) === false);
	let depth = 1;
	const has = typeof P.onBusyProbe === 'function' && typeof P.decideNow === 'function';
	check('E0 peer.js exposes onBusyProbe and decideNow', has);
	if (has) P.onBusyProbe((cid) => (cid === 'c2' ? 0 : depth));
	if (has) check('E2 busy for ANOTHER chat: decided now', P.decideNow(sentErrand(P, { turnId: 't-x', chatId: 'c3', eid: 'e5', dispatchedBy: SELF })) === true);
	if (has) check('E3 the chat already running here: queues, not decided now', P.decideNow(e) === false);
	depth = 0;
	if (has) check('E4 idle: queues as before', P.decideNow(sentErrand(P, { turnId: 't-y', chatId: 'c3', eid: 'e6', dispatchedBy: SELF })) === false);
	if (has) check('E5 a non-errand envelope is never decided now', P.decideNow({ t: 'report', chatId: 'c3' }) === false);
}

console.log(failures ? `\n${failures} FAILED` : '\nall busy-election checks passed');
if (failures) process.exit(1);
