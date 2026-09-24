/* ============================================================
   Test — a runner's turn is never run under the mailbox lock
   (www/js/post.js, E-R4, 2026-09-23).
   ------------------------------------------------------------
   The defect: the park woke `round()`, which holds the
   `daimond-post-mailbox` Web Lock across `collect()`; `collect()`
   routed an errand through `takeRow -> absorb` to the runner and
   AWAITED the whole turn; and the runner's ack dep called
   `DaimondPost.settle()` and `DaimondPost.ack()` at the end of the
   turn, each asking for the same lock. A Web Lock is not
   re-entrant, so the round never returned: the desktop ran its
   first hand-off, then never parked or collected again.

   The fix: `takeRow` only CLAIMS a work row (a per-turn lock of
   its own, taken without waiting) and HOLDS it on the relay; the
   run starts once the mailbox lock is let go, and the row is let
   go -- the hold dropped, the ack sent -- when the run is over.

   Drives the REAL post.js against a faithful post box and a
   faithful `navigator.locks` (exclusive, FIFO per name, and
   `ifAvailable`). The `DaimondPeer` stub's errand handler is the
   real one's shape: it waits on a gate (the turn), then calls
   `DaimondPost.settle` and `DaimondPost.ack`, as daimond.js's ack
   dep does.

   Proven able to fail:
     node www/js/postwork.test.mjs --break inline   # the run back under the lock
     node www/js/postwork.test.mjs                  # clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['inline'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const drain = () => new Promise((r) => setImmediate(r));
async function ticks(n = 30) { for (let i = 0; i < n; i++) await drain(); }

/// Does `p` settle within `n` event-loop turns? Answers the value, or the sentinel.
const PENDING = Symbol('pending');
async function within(p, n = 60) {
	let out = PENDING;
	p.then((v) => { out = v; }, (e) => { out = { threw: String(e) }; });
	for (let i = 0; i < n && out === PENDING; i++) await drain();
	return out;
}

/// `navigator.locks`, for one origin: exclusive, FIFO per name, granted on a later
/// turn as the browser grants it, with `ifAvailable` answering null at once when the
/// name is held. Shared by every tab given the same instance.
function makeLocks() {
	const held = new Set();
	const waiting = new Map();			// name -> [grant]
	function grant(name, fn, resolve, reject) {
		held.add(name);
		Promise.resolve().then(() => fn({ name, mode: 'exclusive' })).then(
			(v) => { next(name); resolve(v); },
			(e) => { next(name); reject(e); });
	}
	function next(name) {
		const q = waiting.get(name) || [];
		const g = q.shift();
		if (g) g(); else held.delete(name);
	}
	return {
		held: (prefix) => [...held].filter((n) => n.startsWith(prefix)),
		waitingOn: (name) => (waiting.get(name) || []).length,
		request(name, opts, fn) {
			if (typeof opts === 'function') { fn = opts; opts = {}; }
			return new Promise((resolve, reject) => {
				if (!held.has(name)) { grant(name, fn, resolve, reject); return; }
				if (opts && opts.ifAvailable) {
					Promise.resolve().then(() => fn(null)).then(resolve, reject);
					return;
				}
				if (!waiting.has(name)) waiting.set(name, []);
				waiting.get(name).push(() => grant(name, fn, resolve, reject));
			});
		},
	};
}

/// The relay box: `?since=X` reads rows above X; `?op=ack` drops rows up to `through`.
function makeBox(rows) {
	const box = {
		rows,
		acks: [],
		since: (x) => box.rows.filter((r) => (r.seq | 0) > (x | 0)),
		dropThrough: (t) => { box.acks.push(t | 0); box.rows = box.rows.filter((r) => (r.seq | 0) > (t | 0)); },
		has: (seq) => box.rows.some((r) => (r.seq | 0) === seq),
	};
	return box;
}

/// A gate the turn waits on, opened by the test.
function makeGate() {
	let open = null;
	const p = new Promise((r) => { open = r; });
	return { wait: () => p, open: () => open() };
}

/// A tab loading the REAL post.js. An envelope 'ERRAND:<turn>' is a foreign errand
/// (work); 'REPORT:<turn>' is a note. `turn(turnId)` answers the gate a run of that
/// turn waits on; `outcome` is what the handler answers.
function makeTab(box, opts) {
	opts = opts || {};
	const local = opts.local || new Map();
	const locks = opts.locks;
	const stat = { runs: [], notes: [], settled: [], acked: [] };

	const gwFetch = (url, o) => {
		const q = String(url).split('?')[1] || '';
		const params = new URLSearchParams(q);
		if (params.get('op') === 'ack') {
			box.dropThrough(JSON.parse(o.body).through | 0);
			return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, dropped: 0 }) });
		}
		if (params.has('since')) {
			const since = Number(params.get('since'));
			return Promise.resolve({ status: 200,
				json: () => Promise.resolve({ ok: true, rows: box.since(since), more: false }) });
		}
		if (params.has('above')) return new Promise(() => {});		// a park: never answers here
		return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
	};

	const document = {
		readyState: 'complete', visibilityState: 'hidden', addEventListener() {},
		createElement: () => ({ className: '', textContent: '', dataset: {}, style: {},
			setAttribute() {}, appendChild(c) { return c; }, addEventListener() {},
			classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
	};
	const win = {
		addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
		location: { origin: 'https://example.test', href: 'https://example.test/' },
		navigator: locks ? { onLine: true, locks } : { onLine: true },
		localStorage: {
			getItem: (k) => (local.has(k) ? local.get(k) : null),
			setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k),
		},
		DaimondIdentity: {
			isUnlocked: () => true, deviceId: () => 'dev-runner',
			publicKeyB64url: () => 'pub-self', sealingKeyRaw: () => null,
			wrap: async (s) => s, unwrap: async (s) => s,
		},
		DaimondGateway: { clientApi: () => 9, gwFetch },
		DEBUG_SHARE: { event: () => {} },
	};
	win.DaimondPeer = {
		peek: async (env) => {
			const s = String(env);
			if (s.startsWith('ERRAND:')) return { t: 'errand', turnId: s.slice(7), dispatchedBy: 'dev-phone' };
			if (s.startsWith('REPORT:')) return { t: 'report', turnId: s.slice(7) };
			return null;
		},
		isOwnDispatch: () => false,
		isWork: (p) => !!p && p.t === 'errand',
		workKey: (p) => 'turn:' + p.turnId,
		verifyEnvelope: async (p) => !(opts.forged && opts.forged.includes(p.turnId)),
		// THE COLLECTOR'S DOOR, in the real one's shape: a forgery is dropped here, then
		// a note is recorded and an errand is run -- the turn, then the ack dep's two calls.
		absorb: async (p) => {
			if (!(await win.DaimondPeer.verifyEnvelope(p))) return { routed: false, verified: false };
			if (p.t !== 'errand') { stat.notes.push(p.turnId); return { routed: true, verified: true, result: null }; }
			stat.runs.push(p.turnId);
			const outcome = (opts.outcome && opts.outcome[p.turnId]) || 'done';
			if (outcome === 'nominee') return { routed: true, verified: true, result: { ran: false, why: 'nominee' } };
			await opts.turn(p.turnId);
			const s = await win.DaimondPost.settle(p.turnId);
			stat.settled.push(p.turnId + ':' + !!(s && s.settled));
			const a = await win.DaimondPost.ack();
			stat.acked.push(a && a.acked);
			return { routed: true, verified: true, result: { ran: true, done: true } };
		},
	};
	win.window = win;

	let src = readFileSync(join(HERE, 'post.js'), 'utf8');
	if (opts.inline) {
		// The run back under the lock: the routing as it stood before the fix, an errand
		// handed to `absorb` and awaited inside the collect, a nominee stand-down held.
		const from = src.indexOf('if (DaimondPeer.isWork && DaimondPeer.isWork(peer)) {');
		const end  = src.indexOf('return NOTHING;\t\t\t// routed, and never a message on the list', from);
		if (from < 0 || end < 0) throw new Error('postwork: could not find the work branch to revert');
		src = src.slice(0, from)
			+ 'var routed = null;\n'
			+ '\t\t\t\ttry { routed = await DaimondPeer.absorb(peer, row); }\n'
			+ "\t\t\t\tcatch (e) { log('a peer envelope would not apply', e); }\n"
			+ "\t\t\t\tif (routed && routed.result && routed.result.why === 'nominee') return hold(peer.turnId);\n\t\t\t\t"
			+ src.slice(end);
	}
	const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout',
		'setInterval', 'clearInterval',
		'with (window) {\n' + src + '\n}');
	fn(win, document, setTimeout, clearTimeout, () => 0, () => {});
	return { win, stat, P: () => win.DaimondPost };
}

async function main() {
	const inline = BREAK === 'inline';

	// ── (1) E-R4: the round returns while the turn runs, and the turn's own ack lands ──
	console.log('a runner collects an errand: the round returns while the turn runs');
	{
		const box = makeBox([{ seq: 1, kind: 'post', addr: 'e1', envelope: 'ERRAND:T1' }]);
		const locks = makeLocks();
		const gate = makeGate();
		const tab = makeTab(box, { locks, inline, turn: () => gate.wait() });
		await ticks();
		const P = tab.P();
		const r = await within(P.round());
		check('round() returns while the turn is still running', r !== PENDING, 'still pending');
		await ticks();
		check('the turn started', tab.stat.runs.length === 1, JSON.stringify(tab.stat.runs));
		check('the mailbox lock is free while the turn runs', locks.held('daimond-post-mailbox').length === 0,
			'held: ' + JSON.stringify(locks.held('daimond-post-mailbox')));
		check('the errand stays on the relay while its turn runs', box.has(1), 'rows: ' + JSON.stringify(box.rows.map((x) => x.seq)));
		const c = await within(P.collect());
		check('a collect forced mid-turn returns', c !== PENDING, 'still pending');
		check('and does not start the turn a second time', tab.stat.runs.length === 1, JSON.stringify(tab.stat.runs));
		gate.open();
		await ticks(80);
		check('the turn\'s own settle and ack completed', tab.stat.acked.length === 1,
			'settled ' + JSON.stringify(tab.stat.settled) + ', acked ' + JSON.stringify(tab.stat.acked));
		check('and the errand left the relay once the turn was over', !box.has(1), 'rows: ' + JSON.stringify(box.rows.map((x) => x.seq)));
		const st = await P.read();
		check('no hold is left behind', (st.holds || []).length === 0 && st.through === 1,
			'through ' + st.through + ', holds ' + JSON.stringify(st.holds));
		check('and no claim is left held', locks.held('daimond-post-work:').length === 0,
			JSON.stringify(locks.held('daimond-post-work:')));
		const again = await within(P.round());
		check('a later round returns', again !== PENDING, 'still pending');
	}

	// ── (2) a note collected mid-turn is folded, and the errand is not run twice ──
	console.log('\na report arriving mid-turn is folded at once; the held errand is not run again');
	{
		const box = makeBox([{ seq: 1, kind: 'post', addr: 'e1', envelope: 'ERRAND:T1' }]);
		const locks = makeLocks();
		const gate = makeGate();
		const tab = makeTab(box, { locks, inline, turn: () => gate.wait() });
		await ticks();
		const P = tab.P();
		await within(P.round());
		await ticks();
		box.rows.push({ seq: 2, kind: 'post', addr: 'r2', envelope: 'REPORT:T0' });
		const c = await within(P.round());
		check('the second round returns mid-turn', c !== PENDING, 'still pending');
		check('the report was folded while the turn ran', tab.stat.notes.includes('T0'), JSON.stringify(tab.stat.notes));
		check('the held errand was not started again', tab.stat.runs.length === 1, JSON.stringify(tab.stat.runs));
		check('nothing was acked past the running errand', box.has(1) && box.has(2), 'rows: ' + JSON.stringify(box.rows.map((x) => x.seq)));
		gate.open();
		await ticks(80);
		check('both rows left the relay once the turn was over', !box.has(1) && !box.has(2), 'rows: ' + JSON.stringify(box.rows.map((x) => x.seq)));
	}

	// ── (3) another tab of the same browser holds the row, never runs it ──
	console.log('\na second tab collecting mid-turn holds the errand and does not run it');
	if (!inline) {
		const box = makeBox([{ seq: 1, kind: 'post', addr: 'e1', envelope: 'ERRAND:T1' }]);
		const locks = makeLocks();
		const local = new Map();
		const gate = makeGate();
		const one = makeTab(box, { locks, local, turn: () => gate.wait() });
		const two = makeTab(box, { locks, local, turn: () => Promise.resolve() });
		await ticks();
		await within(one.P().round());
		await ticks();
		const c = await within(two.P().round());
		check('the second tab\'s round returns', c !== PENDING, 'still pending');
		check('the second tab did not run the turn', two.stat.runs.length === 0, JSON.stringify(two.stat.runs));
		check('and did not ack it off the relay', box.has(1), 'rows: ' + JSON.stringify(box.rows.map((x) => x.seq)));
		gate.open();
		await ticks(80);
		check('the first tab ran it once and let it go', one.stat.runs.length === 1 && !box.has(1),
			'runs ' + JSON.stringify(one.stat.runs) + ', rows ' + JSON.stringify(box.rows.map((x) => x.seq)));
	} else {
		console.log('  ..   (skipped under --break inline: the first round never returns)');
	}

	// ── (4) a stand-down for the nominee stays held for the next collect ──
	console.log('\na stand-down for the account\'s nominee keeps the errand on the relay');
	{
		const box = makeBox([{ seq: 1, kind: 'post', addr: 'e1', envelope: 'ERRAND:T1' }]);
		const locks = makeLocks();
		const tab = makeTab(box, { locks, inline, outcome: { T1: 'nominee' }, turn: () => Promise.resolve() });
		await ticks();
		const P = tab.P();
		await within(P.round());
		await ticks(80);
		const st = await P.read();
		check('the stood-down errand is still on the relay', box.has(1), 'rows: ' + JSON.stringify(box.rows.map((x) => x.seq)));
		check('and still held below the cursor', st.through === 0 && (st.holds || []).some((h) => h.seq === 1),
			'through ' + st.through + ', holds ' + JSON.stringify(st.holds));
		await within(P.round());
		await ticks(80);
		check('the next collect decides it again', tab.stat.runs.length === 2, JSON.stringify(tab.stat.runs));
	}

	// ── (5) a forged errand is dropped, never held ──
	console.log('\nan errand that fails its signature check is dropped, never held');
	{
		const box = makeBox([{ seq: 1, kind: 'post', addr: 'e1', envelope: 'ERRAND:F1' }]);
		const locks = makeLocks();
		const tab = makeTab(box, { locks, inline, forged: ['F1'], turn: () => Promise.resolve() });
		await ticks();
		const P = tab.P();
		await within(P.round());
		await ticks(40);
		check('the forgery is not run', tab.stat.runs.length === 0, JSON.stringify(tab.stat.runs));
		check('and does not pin the cursor', !box.has(1), 'rows: ' + JSON.stringify(box.rows.map((x) => x.seq)));
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': the failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

await main();
