/* ============================================================
   Test — a runner's report reaches the device that sent the turn
   (www/js/post.js `takeRow`/`collect`, peer.js `noteHeldFor`,
   2026-09-24).
   ------------------------------------------------------------
   The defect: the relay's ack is ONE watermark for the whole
   account (gateway `ack_posts`), and a note -- a report -- is
   folded into page memory on whichever device collects it, never
   into the mailbox record the parcel carries. Since E-R4 the runner
   collects while it runs, so it folds the `done` report it has just
   posted for the phone; its finished run then lets the errand go
   and acks through both rows. The relay drops the report before the
   phone collects it, and the phone's tile stays on "Sent to your
   other devices" with [Take back] offered over a turn that ran.
   `verify_handoff_slowparcel` CASE 1 lost it in 12 runs of 14.

   The fix: a note that names its device (`to`, the errand's
   dispatcher) is HELD by every other collector until that device
   acks it or its window passes; and the phone decides its own
   errand's hold again once a batch is folded, so the report in the
   same batch lets both rows go in one round.

   Drives the REAL identity.js, post.js and peer.js in two tabs of
   one account (PHONE, RUNNER) over one in-memory relay that stamps
   rows and honours the account-wide ack, and the REAL `runErrand`
   on the runner. Every step is sequenced by the test, so the result
   does not depend on load.

   R3 QA (2026-09-25) added three cases: the pause refusal names the
   phone, as every report does (Q3); a runner that has not yet learned
   the relay's clock does not age a report on its own (Q1); and the
   runner decides its hold from what it kept, so it folds the report
   once and looks for its row again only while the phone is awake
   (Q2, Q5).

   Proven able to fail:
     node www/js/postreply.test.mjs --break noteack   # the runner acks the report away
     node www/js/postreply.test.mjs --break batch     # the phone's own hold is not re-decided
     node www/js/postreply.test.mjs                   # clean

   Run:  node www/js/postreply.test.mjs
         WWW=<tree>/www/js node www/js/postreply.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = process.env.WWW || dirname(fileURLToPath(import.meta.url));
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
const KNOWN = ['noteack', 'batch'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const drain = () => new Promise((r) => setImmediate(r));
async function ticks(n = 40) { for (let i = 0; i < n; i++) await drain(); }

/// Wait, on the real clock, until `cond()` holds or `ms` pass. The seal and the
/// signature are WebCrypto, which settles off the event loop, so a count of turns is
/// not a wait; a condition is. Answers whether it held.
async function until(cond, ms = 10000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 5));
	}
	return !!cond();
}

/// The relay box: `/api/post` in the shape the gateway gives it. A row is stamped with
/// the relay's clock in Unix SECONDS, as `PostRow.ts` is; `?since=X` reads rows above X;
/// `?op=ack` drops EVERY row up to `through`, for every device of the account.
function makeRelay() {
	let seq = 0;
	const relay = {
		rows: [],
		acks: [],						// [{ by, through }]
		reads: [],						// [{ by, since }], every collect GET
		clock: () => Date.now(),		// the relay's own clock, in ms
		put(b) {
			if (relay.rows.some((r) => r.addr === b.addr)) return;
			seq++;
			relay.rows.push({ seq, kind: 'post', to: b.to, addr: b.addr, envelope: b.envelope,
				ts: Math.floor(relay.clock() / 1000) });
		},
		has: (s) => relay.rows.some((r) => r.seq === s),
		seqs: () => relay.rows.map((r) => r.seq),
	};
	return relay;
}

function makeTab(relay, name, opts) {
	opts = opts || {};
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = { name };
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	win.matchMedia = () => ({ matches: false, addListener: () => {}, addEventListener: () => {} });
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
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	function EventShim(t) { this.type = t; }
	const ok = (json) => ({ status: 200, json: async () => json });
	win.DaimondGateway = {
		clientApi: () => 1,
		gwFetch: async (path, o) => {
			const q = new URLSearchParams(String(path).split('?')[1] || '');
			if (q.get('op') === 'ack') {
				const through = JSON.parse(o.body).through | 0;
				relay.acks.push({ by: name, through });
				relay.rows = relay.rows.filter((r) => r.seq > through);
				return ok({ ok: true, dropped: 0 });
			}
			if (o && o.method === 'POST') { relay.put(JSON.parse(o.body)); return ok({ ok: true }); }
			if (q.has('since')) {
				const since = Number(q.get('since'));
				relay.reads.push({ by: name, since });
				return ok({ ok: true, rows: relay.rows.filter((r) => r.seq > since), more: false });
			}
			if (q.has('above')) return new Promise(() => {});		// a park: the test collects by hand
			return ok({ ok: true });
		},
	};

	function loadScript(rel, extra, edit) {
		let body = readFileSync(join(HERE, rel), 'utf8');
		if (edit) body = edit(body);
		if (extra) body += extra;
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'Event',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
			'console', 'globalThis',
			'with (window) {\n' + body + '\n}');
		fn(win, document, webcrypto, localStorage, btoa, atob,
			TextEncoder, TextDecoder, EventShim,
			setTimeout, clearTimeout, () => 0, () => {},
			{ log: () => {}, debug: () => {}, warn: () => {}, error: console.error }, globalThis);
	}
	loadScript('store.js');
	loadScript('vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;');
	loadScript('curvefallback.js');
	loadScript('identity.js');
	loadScript('post.js', '', opts.editPost);
	loadScript('peer.js');
	if (opts.noteAck) win.DaimondPeer.noteHeldFor = () => '';	// the pre-fix collector
	// THE RELAY'S CLOCK, taught as a presence answer teaches it (peer.js `ingest`), so
	// `relayNow` reads it. peer.js defines `DaimondPresence` itself, so a stub set before
	// it loads is replaced, and a tab that has had no answer reads null. `opts.noClock`
	// is that tab.
	if (!opts.noClock) teach(win, relay);
	return win;
}

/// A presence answer: the relay's clock as `relay.clock` reads it now.
function teach(win, relay) {
	win.DaimondPresence.ingest({}, relay.clock());
}

function makeCas() {
	let version = 5, leases = {};
	return {
		read: async () => ({ version, leases: JSON.parse(JSON.stringify(leases)) }),
		write: async (base, next) => {
			if (base !== version) return { ok: false, version, leases: JSON.parse(JSON.stringify(leases)) };
			version += 1;
			leases = JSON.parse(JSON.stringify(next));
			return { ok: true, version };
		},
	};
}

/// A gate the runner's turn waits on, opened by the test.
function makeGate() {
	let open = null;
	const p = new Promise((r) => { open = r; });
	return { wait: () => p, open: () => open() };
}

/// Two tabs of one account over one relay. The phone's report handler and settle
/// probe are daimond.js's in shape: a report is stashed by turn, and a turn is
/// settled here once a terminal report for it has been collected.
async function pair(relay, opts) {
	const editPost = BREAK === 'batch'
		? (src) => {
			const at = 'if (h.own) {';
			if (src.indexOf(at) < 0) throw new Error('postreply: the batch re-decision was not found to revert');
			return src.replace(at, 'if (false) {');
		}
		: null;
	const phone  = makeTab(relay, 'phone',  { editPost });
	const runner = makeTab(relay, 'runner', { editPost, noteAck: BREAK === 'noteack', noClock: !!(opts && opts.runnerNoClock) });
	const PASS = 'correct horse battery staple frigate';
	await phone.DaimondIdentity.create('Phone', PASS);
	runner.DaimondIdentity.importBundle(phone.DaimondIdentity.exportBundle());
	await runner.DaimondIdentity.unlock(PASS);
	for (const t of [phone, runner]) {
		t.reports = {};
		t.folds = {};					// turnId -> times the report was folded here
		t.DaimondPeer.onReport(async (r) => { t.reports[r.turnId] = r; t.folds[r.turnId] = (t.folds[r.turnId] | 0) + 1; });
		t.DaimondPeer.onSettled(async (env) => {
			const r = t.reports[String(env && env.turnId)];
			return !!r && r.status !== 'parked' && r.status !== 'undeliverable';
		});
	}
	return { phone, runner, phoneDev: phone.DaimondIdentity.deviceId(), runnerDev: runner.DaimondIdentity.deviceId() };
}

/// The runner's errand handler: the REAL `runErrand`, its turn held on `gate`, its
/// report posted and its ack made as daimond.js's deps make them. `beforeAck` runs
/// between the report and the ack: the runner's park, woken by its own report row.
function wireRunner(runner, gate, beforeAck, pauseHold) {
	runner.runs = [];
	runner.DaimondPeer.onErrand(async (errand, row) => {
		const cas = makeCas();
		const out = await runner.DaimondPeer.runErrand(errand, {
			selfId: runner.DaimondIdentity.deviceId(), selfName: 'runner', cas,
			rowTs: row && row.ts, relayNow: () => Date.now(),
			reconstruct: async () => ({}),
			pauseHold: pauseHold || null,
			runTurn: async () => { await gate.wait(); return { text: 'four' }; },
			post: async (report) => {
				await runner.DaimondPost.post(await runner.DaimondPeer.sealForSelf(report));
				if (report.status === 'done' && beforeAck) await beforeAck();
			},
			ack: async (er) => {
				await runner.DaimondPost.settle(er && er.turnId);
				await runner.DaimondPost.ack();
			},
			pushResult: async () => 0,
			setTimer: () => null, clearTimer: () => {},
		});
		runner.runs.push(out);
		return out;
	});
}

/// The runner's run is over, and `runWork` has let its row go (the claim released).
const runOver = (runner) => until(() => runner.runs.length > 0);

/// An errand as the phone posts one: its own turn id (a `newMid`, so it can be aged),
/// the seed ending at that turn's user message, and the phone as its dispatcher.
async function dispatch(phone, phoneDev, tag) {
	const now = Date.now();
	const turnId = now.toString(36) + '-1-' + tag;
	const errand = phone.DaimondPeer.makeErrand({
		turnId, chatId: 'chat-' + tag, prompt: 'what is two plus two', eid: 'e-' + tag,
		dispatchedBy: phoneDev, ts: now, deadline: now + phone.DaimondPeer.DISPATCH_DEADLINE_MS,
		seed: { chatId: 'chat-' + tag, title: '', provider: '', model: '',
			msgs: [{ role: 'user', content: 'what is two plus two', mid: turnId, ts: now }] },
	});
	await phone.DaimondPost.post(await phone.DaimondPeer.sealForSelf(errand));
	return turnId;
}

async function main() {
	// ── (1) the reply row: the runner leaves it for the phone, the phone takes it ──
	console.log('the runner\'s report stays on the relay until the phone that sent the turn takes it');
	{
		const relay = makeRelay();
		const { phone, runner, phoneDev } = await pair(relay);
		const gate = makeGate();
		// The runner's park wakes on its own report row and collects BEFORE the ack dep
		// runs: the interleaving that lost the report in the browser, made certain here.
		wireRunner(runner, gate, async () => { await runner.DaimondPost.collect(); });
		const turnId = await dispatch(phone, phoneDev, 'one');
		check('the phone\'s errand is on the relay', relay.has(1), 'rows ' + JSON.stringify(relay.seqs()));

		// The phone collects its own errand first: held for the runner, as ever.
		await phone.DaimondPost.round();
		check('the phone holds its own errand for the runner', relay.has(1), 'rows ' + JSON.stringify(relay.seqs()));

		await runner.DaimondPost.round();		// the runner claims it; the turn waits on the gate
		gate.open();
		check('the runner ran the turn', await runOver(runner), 'runs ' + runner.runs.length);
		await ticks(80);
		const report = relay.rows.find((r) => r.seq === 2);
		check('the runner posted its report (row 2), and folded it in its own collect',
			!!report && !!runner.reports[turnId], 'rows ' + JSON.stringify(relay.seqs()));
		const rst = await runner.DaimondPost.read();
		check('the runner acked its errand and no further', relay.acks.some((a) => a.by === 'runner')
			&& relay.acks.filter((a) => a.by === 'runner').every((a) => a.through < 2),
			'acks ' + JSON.stringify(relay.acks));
		check('THE REPORT IS STILL ON THE RELAY FOR THE PHONE', relay.has(2),
			'rows ' + JSON.stringify(relay.seqs()) + ', acks ' + JSON.stringify(relay.acks));
		check('held on the runner for the phone, and for nothing else',
			(rst.holds || []).length === 1 && rst.holds[0].seq === 2 && rst.holds[0].forDevice === phoneDev,
			'holds ' + JSON.stringify(rst.holds));

		// The phone's park wakes on row 2 and collects.
		const pr = await phone.DaimondPost.round();
		check('the phone collected the report', !!phone.reports[turnId] && phone.reports[turnId].status === 'done',
			'reports ' + JSON.stringify(Object.keys(phone.reports)));
		check('THE PHONE ACKS THE REPLY ROW, in the same round', relay.acks.some((a) => a.by === 'phone' && a.through >= 2)
			&& pr && pr.acked >= 2, 'round ' + JSON.stringify(pr) + ', acks ' + JSON.stringify(relay.acks));
		check('and the relay is empty', relay.rows.length === 0, 'rows ' + JSON.stringify(relay.seqs()));
		const pst = await phone.DaimondPost.read();
		check('no hold is left on the phone', (pst.holds || []).length === 0 && pst.through === 2,
			'through ' + pst.through + ', holds ' + JSON.stringify(pst.holds));
		// THE RUNNER DOES NOT READ THE REPORT AGAIN WHILE THE PHONE IS AWAY (R3 QA Q2, Q5):
		// its hold keeps what its window is read from, so its collects ask only for rows
		// above what it has worked, and it folds the report once. Looking for the row is the
		// only way to learn the phone has taken it, and costs every row above it, so it is
		// looked for only while the phone is awake.
		const folds = runner.folds[turnId] | 0;
		const readsBefore = relay.reads.length;
		await runner.DaimondPost.round();
		await runner.DaimondPost.round();
		const rreads = relay.reads.slice(readsBefore).filter((x) => x.by === 'runner');
		check('THE RUNNER ASKS ONLY FOR ROWS ABOVE WHAT IT HAS WORKED while the phone is away',
			rreads.length === 2 && rreads.every((x) => x.since >= 2), 'reads ' + JSON.stringify(rreads));
		check('and it folded the report once', folds === 1 && (runner.folds[turnId] | 0) === 1,
			'folds ' + folds + ' then ' + (runner.folds[turnId] | 0));
		// The phone's beat reaches the runner: it is awake, so the runner looks for the
		// report again, finds it gone, and lets it go.
		await new Promise((r) => setTimeout(r, 5));
		runner.DaimondPresence.ingest({ [phoneDev]: { name: 'Phone', last_seen: relay.clock() } }, relay.clock());
		const readsHeard = relay.reads.length;
		await runner.DaimondPost.round();
		const rst2 = await runner.DaimondPost.read();
		const hreads = relay.reads.slice(readsHeard).filter((x) => x.by === 'runner');
		check('ONCE THE PHONE IS AWAKE, THE RUNNER LOOKS AGAIN AND LETS THE TAKEN REPORT GO',
			(rst2.holds || []).length === 0 && rst2.through === 2 && hreads.length === 1 && hreads[0].since === 1,
			'through ' + rst2.through + ', holds ' + JSON.stringify(rst2.holds) + ', reads ' + JSON.stringify(hreads));
		check('and still folded it once', (runner.folds[turnId] | 0) === 1, 'folds ' + (runner.folds[turnId] | 0));
	}

	// ── (2) one batch: the phone's own errand and the report that settles it ──
	console.log('\nthe phone collects its errand and the report in one batch, and lets both go at once');
	{
		const relay = makeRelay();
		const { phone, runner, phoneDev } = await pair(relay);
		const gate = makeGate();
		wireRunner(runner, gate, null);
		const turnId = await dispatch(phone, phoneDev, 'two');
		await runner.DaimondPost.round();
		gate.open();
		check('the runner ran the turn', await runOver(runner), 'runs ' + runner.runs.length);
		await ticks(80);
		check('the report is on the relay', relay.has(2), 'rows ' + JSON.stringify(relay.seqs()));
		const pr = await phone.DaimondPost.round();		// rows [2] or [1,2], in seq order
		check('the phone took the report', !!phone.reports[turnId]);
		check('and acked through it in that round', relay.rows.length === 0 && pr && pr.acked >= 2,
			'round ' + JSON.stringify(pr) + ', rows ' + JSON.stringify(relay.seqs()));
	}

	// ── (3) the phone collects before the runner has let its errand go ──
	console.log('\nthe phone collects [errand, report] before the runner acks: its own hold is decided again');
	{
		const relay = makeRelay();
		const { phone, runner, phoneDev } = await pair(relay);
		const gate = makeGate();
		let phoneRound = null;
		// The phone's park and the runner's wake on the same row; here the phone's
		// collect lands first, reading the errand (still held by the runner) and the
		// report in one batch.
		wireRunner(runner, gate, async () => { phoneRound = await phone.DaimondPost.round(); });
		const turnId = await dispatch(phone, phoneDev, 'three');
		await runner.DaimondPost.round();
		gate.open();
		check('the runner ran the turn', await runOver(runner), 'runs ' + runner.runs.length);
		await ticks(80);
		check('the phone read both rows and took the report', !!phone.reports[turnId]);
		check('THE PHONE ACKED THROUGH THE REPORT, not stopping at its own settled errand',
			relay.acks.some((a) => a.by === 'phone' && a.through >= 2),
			'round ' + JSON.stringify(phoneRound) + ', acks ' + JSON.stringify(relay.acks));
		check('and nothing is left on the relay', relay.rows.length === 0, 'rows ' + JSON.stringify(relay.seqs()));
	}

	// ── (4) the hold has an end ──
	console.log('\na report the phone never collects is let go once its window has passed');
	{
		const relay = makeRelay();
		const { runner } = await pair(relay);
		const other = 'feedfacecafebeef';
		const body = await runner.DaimondPeer.sealForSelf(runner.DaimondPeer.makeReport({
			eid: 'e4', to: other, turnId: 'turn-four', chatId: 'c', status: 'done' }));
		const held = runner.DaimondPeer.NOTE_HOLD_MS;
		relay.clock = () => Date.now() - held - 60000;		// posted a window and a minute ago
		await runner.DaimondPost.post(body);
		relay.clock = () => Date.now();
		await runner.DaimondPost.round();
		check('a report older than its window is not held', relay.rows.length === 0,
			'rows ' + JSON.stringify(relay.seqs()) + ' (window ' + held + ' ms)');
		const fresh = await runner.DaimondPeer.sealForSelf(runner.DaimondPeer.makeReport({
			eid: 'e5', to: other, turnId: 'turn-five', chatId: 'c', status: 'done' }));
		await runner.DaimondPost.post(fresh);
		await runner.DaimondPost.round();
		check('while a fresh one for another device is', relay.rows.length === 1,
			'rows ' + JSON.stringify(relay.seqs()));
	}

	// ── (5) an older runner's report names nobody, and is taken as before ──
	console.log('\na report with no `to` (an older runner\'s) is acked as it always was');
	{
		const relay = makeRelay();
		const { runner } = await pair(relay);
		await runner.DaimondPost.post(await runner.DaimondPeer.sealForSelf(runner.DaimondPeer.makeReport({
			eid: 'e6', turnId: 'turn-six', chatId: 'c', status: 'done' })));
		await runner.DaimondPost.round();
		check('it is not held', relay.rows.length === 0, 'rows ' + JSON.stringify(relay.seqs()));
	}

	// ── (6) a paused chat's refusal names the phone, as every report does (R3 QA Q3) ──
	console.log('\na runner that refuses a paused chat leaves the refusal on the relay for the phone');
	{
		const relay = makeRelay();
		const { phone, runner, phoneDev } = await pair(relay);
		const gate = makeGate();
		gate.open();
		wireRunner(runner, gate, null, () => ({ node: 'chat', why: 'This chat is paused.' }));
		const turnId = await dispatch(phone, phoneDev, 'six');
		await runner.DaimondPost.round();
		check('the runner refused the turn for the pause', await runOver(runner)
			&& runner.runs[0].why === 'paused', 'runs ' + JSON.stringify(runner.runs));
		await ticks(80);
		for (let i = 0; i < 3; i++) { await runner.DaimondPost.round(); await ticks(40); }
		check('THE REFUSAL NAMES THE PHONE', !!runner.reports[turnId] && runner.reports[turnId].to === phoneDev,
			'report ' + JSON.stringify(runner.reports[turnId] || null));
		check('and it is still on the relay after the runner\'s collects', relay.has(2),
			'rows ' + JSON.stringify(relay.seqs()) + ', acks ' + JSON.stringify(relay.acks));
		await phone.DaimondPost.round();
		const r = phone.reports[turnId];
		check('THE PHONE GETS THE RUNNER\'S SENTENCE', !!r && r.status === 'error' && r.why === 'This chat is paused.',
			'phone report ' + JSON.stringify(r || null));
	}

	// ── (7) a runner with no relay clock yet does not age a report on its own (R3 QA Q1) ──
	console.log('\na runner that has not learned the relay\'s clock holds the report, whatever its own clock says');
	{
		const relay = makeRelay();
		const { phone, runner, phoneDev } = await pair(relay, { runnerNoClock: true });
		const gate = makeGate();
		wireRunner(runner, gate, null);
		check('the runner has no relay clock', runner.DaimondPresence.relayNow() == null);
		const turnId = await dispatch(phone, phoneDev, 'seven');
		await runner.DaimondPost.round();
		gate.open();
		check('the runner ran the turn', await runOver(runner), 'runs ' + runner.runs.length);
		await ticks(80);
		// Its own clock twenty minutes ahead of the relay's, past the window.
		const realNow = Date.now, AHEAD = 20 * 60000;
		globalThis.Date.now = () => realNow() + AHEAD;
		try {
			for (let i = 0; i < 2; i++) { await runner.DaimondPost.round(); await ticks(40); }
		} finally { globalThis.Date.now = realNow; }
		check('THE REPORT IS STILL ON THE RELAY FOR THE PHONE', relay.has(2),
			'rows ' + JSON.stringify(relay.seqs()) + ', acks ' + JSON.stringify(relay.acks));
		await phone.DaimondPost.round();
		check('and the phone takes it', !!phone.reports[turnId] && phone.reports[turnId].status === 'done');
		// The hold still ends without a relay clock: counted on the runner's own clock
		// from when it first took the report, which no offset between the two moves.
		globalThis.Date.now = () => realNow() + AHEAD + runner.DaimondPeer.NOTE_HOLD_MS + 60000;
		try { await runner.DaimondPost.round(); } finally { globalThis.Date.now = realNow; }
		const rst = await runner.DaimondPost.read();
		check('and the runner\'s hold ends a window after it first took it, on its own count',
			(rst.holds || []).length === 0, 'holds ' + JSON.stringify(rst.holds));
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': the failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

await main();
