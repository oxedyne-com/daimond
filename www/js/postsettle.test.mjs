/* ============================================================
   Test — the own-errand HOLD is released once the turn is
   settled (www/js/post.js, S-HAND #1/#2, the MONEY defect).
   ------------------------------------------------------------
   Before this fix `takeRow` HELD this device's own dispatched
   errand on the relay UNCONDITIONALLY: `collect` pinned the ack
   watermark `through` below it, and `ackThrough` (WS-BRICK) then
   never dropped the row. So a turn the dispatching device ended
   up running ITSELF still sat on the shared relay, and a peer
   waking inside the 15-min deadline collected it, took the freed
   lease and re-ran + RE-BILLED it (S-HAND #1). The same hold
   froze the ack cursor for the row's 30-day life (S-HAND #2).

   The fix: `takeRow` consults `DaimondPeer.holdOwnDispatch(env)`
   and HOLDs only while the turn is live. `collect` records each
   live hold as `{ seq, turnId }` on the (local) record and clips
   `through` just below the LOWEST hold; a new `settle(turnId)`
   drops one hold and frees `through` past it WITHOUT a network
   round. A settled/dead errand falls through, the cursor passes
   it, and the next ack takes it off the relay.

   This drives the REAL post.js against a faithful post-box
   `gwFetch` (post.rs:608's park rule), the loader copied from
   postspin.test.mjs. The `DaimondPeer` stub gains
   `holdOwnDispatch`, keyed on a per-tab `settled` set.

   Proven able to fail:
     node www/js/postsettle.test.mjs --break unfixed  # gate removed
     node www/js/postsettle.test.mjs                  # clean
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
const KNOWN = ['unfixed'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const drain = () => new Promise((r) => setImmediate(r));
async function settleTicks(n = 10) { for (let i = 0; i < n; i++) await drain(); }

/// The gateway's post box, reduced to a `?since=` read and an `?op=ack`. `?since=X`
/// returns rows above X; the ack drops nothing here (the test asserts `through`, not
/// the relay's retention, which postack.test.mjs owns).
function makeBox(rows) {
	return {
		rows,
		top: () => rows.reduce((m, r) => Math.max(m, r.seq | 0), 0),
		since: (x) => rows.filter((r) => (r.seq | 0) > (x | 0)),
	};
}

function makeTab(box, opts) {
	opts = opts || {};
	// The turnIds this tab reports as ALREADY SETTLED here, so `holdOwnDispatch`
	// answers false for them and `takeRow` lets the cursor pass the row.
	const settled = new Set(opts.settled || []);
	const local = new Map();

	const gwFetch = (url) => {
		const q = String(url).split('?')[1] || '';
		const params = new URLSearchParams(q);
		if (params.has('since')) {
			const since = Number(params.get('since'));
			return Promise.resolve({ status: 200,
				json: () => Promise.resolve({ ok: true, rows: box.since(since), more: false }) });
		}
		if (params.get('op') === 'ack') {
			return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, dropped: 0 }) });
		}
		if (params.has('above')) {			// a park: never news in this test, hold quietly
			return new Promise(() => {});
		}
		return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
	};

	const document = {
		readyState: 'complete', visibilityState: 'hidden',
		addEventListener() {}, createElement: () => ({ className: '', textContent: '', dataset: {}, style: {},
			setAttribute() {}, appendChild(c) { return c; }, addEventListener() {},
			classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
	};
	const win = {
		addEventListener() {}, dispatchEvent: () => true,
		Date: { now: () => 1757000000000 },
		location: { origin: 'https://example.test', href: 'https://example.test/' },
		navigator: { onLine: true },
		localStorage: {
			getItem: (k) => (local.has(k) ? local.get(k) : null),
			setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k),
		},
		DaimondIdentity: {
			isUnlocked: () => true, deviceId: () => 'dev-self',
			publicKeyB64url: () => 'pub-self', sealingKeyRaw: () => null,
			wrap: async (s) => s, unwrap: async (s) => s,
		},
		DaimondGateway: { clientApi: () => 9, gwFetch },
		// The peer seam. An 'ERRAND:<turnId>' envelope is this device's OWN dispatch;
		// `peek` parses the turnId so `takeRow` can hold(turnId) and `collect` record it.
		// `holdOwnDispatch` answers false for a turn this tab reports settled.
		DaimondPeer: {
			peek: async (env) => {
				const s = String(env);
				if (!s.startsWith('ERRAND:')) return null;
				return { own: true, turnId: s.slice('ERRAND:'.length), dispatchedBy: 'dev-self', deadline: 0 };
			},
			isOwnDispatch: (p) => !!(p && p.own),
			verifyEnvelope: async () => true,
			holdOwnDispatch: async (env) => !settled.has(String(env && env.turnId)),
			absorb: async () => null,
		},
		DEBUG_SHARE: { event: () => {} },
	};
	win.window = win;

	let src = readFileSync(join(HERE, 'post.js'), 'utf8');
	if (opts.unfixed) {
		// The pre-fix gate: HOLD an own errand unconditionally, never consulting
		// holdOwnDispatch. Reverting it here is what makes the "settled row falls
		// through" checks go red -- the proof they test the fix and do not pass blind.
		const from = 'if (DaimondPeer.holdOwnDispatch) keep = await DaimondPeer.holdOwnDispatch(peer);';
		src = src.replace(from, 'keep = true;');
		if (src.indexOf('keep = true;') < 0) throw new Error('postsettle: could not find the holdOwnDispatch gate to revert');
	}

	const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout',
		'setInterval', 'clearInterval', 'Date',
		'with (window) {\n' + src + '\n}');
	fn(win, document, (f) => setTimeout(f, 0), () => {}, () => {}, () => {}, { now: () => 1757000000000 });

	return { win, settled, P: () => win.DaimondPost };
}

const holdsOf = (st) => (st.holds || []).map((h) => h.seq).sort((a, b) => a - b);

async function main() {
	// ── (1) a LIVE own errand holds; settle() then frees the cursor ──
	console.log('a live own errand at 142 HOLDS; settle() frees the watermark past it');
	{
		const tab = makeTab(makeBox([
			{ seq: 141, kind: 'post', addr: 'a141', envelope: 'NORMAL:141' },
			{ seq: 142, kind: 'post', addr: 'e142', envelope: 'ERRAND:T' },
		]));
		await settleTicks();
		const P = tab.P();
		check('the module loaded', !!P && typeof P.settle === 'function');
		const col = await P.collect();
		check('the collect succeeded', col.ok === true, JSON.stringify(col));
		let st = await P.read();
		check('through stopped BELOW the held errand (relay keeps it for the peer)',
			st.through === 141, 'through=' + st.through);
		check('seen CLIMBED PAST the held errand', st.seen === 142, 'seen=' + st.seen);
		check('the hold is recorded with its seq and turnId',
			st.holds.length === 1 && st.holds[0].seq === 142 && st.holds[0].turnId === 'T',
			JSON.stringify(st.holds));
		check('holds is a LOCAL cursor, never on the sync snapshot',
			P.snapshot().holds === undefined, 'snapshot.holds=' + JSON.stringify(P.snapshot().holds));

		const r = await P.settle('T');
		check('settle(T) reported it dropped the hold', r.settled === true, JSON.stringify(r));
		st = await P.read();
		check('after settle, through RE-JOINS seen (the errand can be acked away)',
			st.through === 142, 'through=' + st.through);
		check('after settle, no holds remain', st.holds.length === 0, JSON.stringify(st.holds));
		const r2 = await P.settle('T');
		check('a second settle of the same turn is a no-op', r2.settled === false, JSON.stringify(r2));
	}

	// ── (2) a SETTLED own errand falls through in ONE pass ──
	console.log('\na settled own errand falls through: the cursor passes it in one collect');
	{
		const tab = makeTab(makeBox([
			{ seq: 141, kind: 'post', addr: 'a141', envelope: 'NORMAL:141' },
			{ seq: 142, kind: 'post', addr: 'e142', envelope: 'ERRAND:T' },
		]), { settled: ['T'], unfixed: BREAK === 'unfixed' });
		await settleTicks();
		const P = tab.P();
		const col = await P.collect();
		check('the collect succeeded', col.ok === true, JSON.stringify(col));
		const st = await P.read();
		// This is the S-HAND #1/#2 fix: a turn already settled here is NOT held, so the
		// cursor passes the row and the next ack drops it -- no peer re-runs and re-bills.
		check('a settled errand is NOT held (through == seen == 142)',
			st.through === 142 && st.seen === 142, 'through=' + st.through + ' seen=' + st.seen);
		check('no hold recorded for a settled errand', st.holds.length === 0, JSON.stringify(st.holds));
	}

	// ── (3) two own errands: settle of the lower never frees past the higher ──
	console.log('\ntwo live own errands 142/144: settle(142) frees to 143, never past 144');
	{
		const tab = makeTab(makeBox([
			{ seq: 141, kind: 'post', addr: 'a141', envelope: 'NORMAL:141' },
			{ seq: 142, kind: 'post', addr: 'e142', envelope: 'ERRAND:T1' },
			{ seq: 143, kind: 'post', addr: 'a143', envelope: 'NORMAL:143' },
			{ seq: 144, kind: 'post', addr: 'e144', envelope: 'ERRAND:T2' },
		]));
		await settleTicks();
		const P = tab.P();
		await P.collect();
		let st = await P.read();
		check('through clipped below the LOWEST hold (142 -> 141)', st.through === 141, 'through=' + st.through);
		check('both holds recorded', JSON.stringify(holdsOf(st)) === '[142,144]', JSON.stringify(holdsOf(st)));
		const r = await P.settle('T1');
		check('settle(T1) dropped the lower hold', r.settled === true, JSON.stringify(r));
		st = await P.read();
		check('through advanced to 143, one below the SURVIVING hold at 144',
			st.through === 143, 'through=' + st.through);
		check('the higher hold survives', JSON.stringify(holdsOf(st)) === '[144]', JSON.stringify(holdsOf(st)));
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': the "settled row falls through" failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

await main();
