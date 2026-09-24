/* ============================================================
   Test -- a note held for another device is decided from what the
   hold kept, never by reading the relay again (R3 QA, 2026-09-25).
   ------------------------------------------------------------
   The QA of live Release 3 (build 653d3c40b442, `81309ed6`) found:

     Q1  a collector with no relay clock yet aged a report on its own
         clock: twenty minutes fast, it took the phone's report at once
         and acked it away;
     Q2  a note held for the phone was folded again on every collect
         for its whole window: a `done` report 6 times in 6 park rounds,
         two held reports 12 times, a `built` 6 times (and `built` was
         drawn on whichever device folded it);
     Q5  every collect started at the pinned `through`, so every row
         above a held note was served again: 860 rows for 40 new ones;
     Q6  a restarted runner's hand-back (`runner-restarted`) named no
         device, so the runner acked it away before the phone saw it.

   Drives the REAL identity.js, post.js and peer.js in two tabs of one
   account over one in-memory relay that stamps rows and honours the
   account-wide ack, and the REAL `runErrand` on the runner, with one
   lease CAS. Counts are asserted, so a regression is a number.

   Run:  node www/js/heldnote.test.mjs
         WWW=<tree>/www/js node www/js/heldnote.test.mjs   # e.g. 81309ed6: 9 fail
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const WWW = process.env.WWW || dirname(fileURLToPath(import.meta.url));
const PREFIX = false;
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const drain = () => new Promise((r) => setImmediate(r));
async function ticks(n = 40) { for (let i = 0; i < n; i++) await drain(); }
async function until(cond, ms = 10000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 5)); }
	return !!cond();
}

function makeRelay() {
	let seq = 0;
	const relay = {
		rows: [], acks: [], clock: () => Date.now(),
		cut: 0,					// collects the wire fails before they are answered
		served: {},				// tab name -> rows its collects were served
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

function makeTab(relay, name) {
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
				if (relay.cut > 0) { relay.cut--; throw new Error('the network is down'); }
				const since = Number(q.get('since'));
				const out = relay.rows.filter((r) => r.seq > since);
				relay.served[name] = (relay.served[name] | 0) + out.length;
				return ok({ ok: true, rows: out, more: false });
			}
			if (q.has('above')) return new Promise(() => {});
			return ok({ ok: true });
		},
	};
	function loadScript(rel, extra) {
		let body = readFileSync(join(WWW, rel), 'utf8');
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
			{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, globalThis);
	}
	loadScript('store.js');
	loadScript('vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;');
	loadScript('curvefallback.js');
	loadScript('identity.js');
	loadScript('post.js');
	loadScript('peer.js');
	if (PREFIX) win.DaimondPeer.noteHeldFor = () => '';		// the collector before e6a99334
	teach(win, relay);
	return win;
}

/// A presence answer: the relay's clock as `relay.clock` reads it now. peer.js defines
/// `DaimondPresence` itself, so this is how a tab learns the relay's clock (`relayNow`).
function teach(win, relay) { win.DaimondPresence.ingest({}, relay.clock()); }

/// One lease record for the account, as the parcel carries it: every take and release
/// by any run goes through the same CAS.
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
		peek: () => leases,
	};
}

async function pair(relay) {
	const phone  = makeTab(relay, 'phone');
	const runner = makeTab(relay, 'runner');
	const PASS = 'correct horse battery staple frigate';
	await phone.DaimondIdentity.create('Phone', PASS);
	runner.DaimondIdentity.importBundle(phone.DaimondIdentity.exportBundle());
	await runner.DaimondIdentity.unlock(PASS);
	for (const t of [phone, runner]) {
		t.reports = {};
		t.DaimondPeer.onReport(async (r) => { t.reports[r.turnId] = r; });
		t.DaimondPeer.onSettled(async (env) => {
			const r = t.reports[String(env && env.turnId)];
			return !!r && r.status !== 'parked' && r.status !== 'undeliverable';
		});
	}
	return { phone, runner, phoneDev: phone.DaimondIdentity.deviceId() };
}

/// The runner's errand handler, with daimond.js's deps in shape: ONE lease CAS, and
/// `finished` as `dispatchedTurnSettled` reads a report (any terminal report but
/// `parked` and `undeliverable`). `how(turnId)` says how a turn's run ends.
function wireRunner(runner, cas, how) {
	runner.starts = {};		// turnId -> times runTurn or reconstruct was entered
	runner.runs = [];
	const parked = {};
	runner.DaimondPeer.onErrand(async (errand, row) => {
		const tid = String(errand.turnId);
		const out = await runner.DaimondPeer.runErrand(errand, {
			selfId: runner.DaimondIdentity.deviceId(), selfName: 'runner', cas,
			rowTs: row && row.ts, relayNow: () => Date.now(),
			finished: async (er) => {
				const r = runner.reports[String(er.turnId)];
				return !!r && r.status !== 'parked' && r.status !== 'undeliverable';
			},
			maxParks: 2,
			parkRequested: (er) => parked[String(er.turnId)] || null,
			reconstruct: async () => {
				runner.starts[tid] = (runner.starts[tid] | 0) + 1;
				if (how(tid) === 'undeliverable') {
					const e = new Error('the parcel is not reaching this device'); e.undeliverable = true; throw e;
				}
				return {};
			},
			runTurn: async () => {
				if (how(tid) === 'park') { parked[tid] = { why: 'no-attended-device' }; throw new Error('parked'); }
				if (how(tid) === 'crash') throw new Error('an unexpected fault in the turn');
				return { text: 'four' };
			},
			post: async (report) => { await runner.DaimondPost.post(await runner.DaimondPeer.sealForSelf(report)); },
			ack: async (er) => { await runner.DaimondPost.settle(er && er.turnId); await runner.DaimondPost.ack(); },
			pushResult: async () => 0,
			setTimer: () => null, clearTimer: () => {},
		});
		delete parked[tid];
		runner.runs.push({ tid, out });
		return out;
	});
}

async function dispatch(tab, dispatchedBy, tag) {
	const now = Date.now();
	const turnId = now.toString(36) + '-1-' + tag;
	const errand = tab.DaimondPeer.makeErrand({
		turnId, chatId: 'chat-' + tag, prompt: 'what is two plus two', eid: 'e-' + tag,
		dispatchedBy, ts: now, deadline: now + tab.DaimondPeer.DISPATCH_DEADLINE_MS,
		seed: { chatId: 'chat-' + tag, title: '', provider: '', model: '',
			msgs: [{ role: 'user', content: 'what is two plus two', mid: turnId, ts: now }] },
	});
	await tab.DaimondPost.post(await tab.DaimondPeer.sealForSelf(errand));
	return turnId;
}


/// Count the folds of each report on a tab, beside what `pair` records.
function countFolds(tab) {
	tab.folds = {};
	tab.DaimondPeer.onReport(async (r) => {
		tab.reports[r.turnId] = r;
		tab.folds[r.turnId] = (tab.folds[r.turnId] | 0) + 1;
	});
}

const LAPTOP = 'a1b2c3d4e5f60718';
const round = async (tab, n = 40) => { await tab.DaimondPost.round(); await ticks(n); };

// ── Q2: a report held for the away phone is folded once, however many collects follow ──
async function q2reports() {
	console.log('\nQ2: held reports are folded once on the runner');
	const relay = makeRelay();
	const { phone, runner, phoneDev } = await pair(relay);
	countFolds(runner);
	const cas = makeCas();
	wireRunner(runner, cas, (tid) => (tid.endsWith('two') ? 'undeliverable' : 'done'));
	const t1 = await dispatch(phone, phoneDev, 'one');
	await round(runner);
	await until(() => runner.runs.length >= 1);
	await ticks(80);
	for (let i = 0; i < 6; i++) await round(runner);
	check('Q2 the phone\'s done report, held on the runner, is folded ONCE in 6 park rounds',
		(runner.folds[t1] | 0) === 1 && relay.has(2),
		'folded ' + (runner.folds[t1] | 0) + ' times; rows ' + JSON.stringify(relay.seqs()));
	const t2 = await dispatch(phone, LAPTOP, 'two');
	await round(runner);
	await until(() => runner.runs.length >= 2);
	await ticks(80);
	await round(runner);			// the undeliverable report's first sight
	const f1 = runner.folds[t1] | 0, f2 = runner.folds[t2] | 0;
	for (let i = 0; i < 6; i++) await round(runner);
	check('Q2 with a second report held (for the laptop), 6 more rounds fold neither again',
		(runner.folds[t1] | 0) === f1 && (runner.folds[t2] | 0) === f2 && f2 === 1,
		'T1 ' + f1 + ' -> ' + (runner.folds[t1] | 0) + ', T2 ' + f2 + ' -> ' + (runner.folds[t2] | 0));
	check('Q2 and both are still on the relay for their devices', relay.has(2) && relay.has(4),
		'rows ' + JSON.stringify(relay.seqs()));
	await round(phone);
	check('Q2 the phone then takes its report', !!phone.reports[t1] && phone.reports[t1].status === 'done');
}

// ── Q2: a `built` note for the phone reaches the runner's handler once, and is not the runner's to draw ──
async function q2built() {
	console.log('\nQ2: a built note for the phone is folded once, and drawn only where it was asked');
	const relay = makeRelay();
	const { phone, runner, phoneDev } = await pair(relay);
	const runnerDev = runner.DaimondIdentity.deviceId();
	let built = 0;
	runner.DaimondPeer.onBuilt(async () => { built++; });
	const b = runner.DaimondPeer.makeBuilt({ eid: 'eB', cid: 'k1', to: phoneDev, status: 'done', main: 'main.typ' });
	await runner.DaimondPost.post(await runner.DaimondPeer.sealForSelf(b));
	for (let i = 0; i < 6; i++) await round(runner);
	check('Q2 the runner\'s onBuilt fires ONCE in 6 rounds while the note waits for the phone',
		built === 1 && relay.has(1), 'fired ' + built + ' times; rows ' + JSON.stringify(relay.seqs()));
	const P = runner.DaimondPeer;
	const ours = typeof P.builtIsOurs === 'function';
	check('Q2 a built naming the phone is not the runner\'s to draw, nor a third device\'s with the same document in flight',
		ours && !P.builtIsOurs(b, runnerDev, false) && !P.builtIsOurs(b, LAPTOP, true));
	check('Q2 it is the phone\'s', ours && P.builtIsOurs(b, phoneDev, false));
	check('Q2 an older runner\'s built names nobody, and the device with the compile in flight draws it',
		ours && P.builtIsOurs(P.makeBuilt({ cid: 'k1' }), runnerDev, true)
		&& !P.builtIsOurs(P.makeBuilt({ cid: 'k1' }), runnerDev, false));
}

// ── Q5: rows arriving while a note is held are served once each ──
async function q5served() {
	console.log('\nQ5: while a note is held, a collect is served only the rows above what it has worked');
	const relay = makeRelay();
	const { phone, runner, phoneDev } = await pair(relay);
	const cas = makeCas();
	wireRunner(runner, cas, () => 'done');
	await dispatch(phone, phoneDev, 'one');
	await round(runner);
	await until(() => runner.runs.length >= 1);
	await ticks(80);
	await round(runner);
	relay.served.runner = 0;
	const N = 40;
	for (let i = 0; i < N; i++) {
		const n = runner.DaimondPeer.makeReport({ eid: 'x' + i, turnId: 'other-' + i, chatId: 'c', status: 'aborted' });
		await runner.DaimondPost.post(await runner.DaimondPeer.sealForSelf(n));
		await round(runner, 20);
	}
	check('Q5 ' + N + ' rows arriving during the hold, one collect each, are served ' + N + ' rows (not 860)',
		(relay.served.runner | 0) === N, 'served ' + (relay.served.runner | 0));
	check('Q5 and the phone\'s report is still on the relay for it', relay.has(2),
		'rows ' + relay.rows.length + ' from ' + JSON.stringify(relay.seqs().slice(0, 3)));
	// The phone comes back, takes its report and acks; the runner hears its beat, looks
	// for the report, finds it gone, and its cursor rejoins what it has worked.
	await round(phone);
	check('Q5 the phone takes its report', !relay.has(2));
	runner.DaimondPresence.ingest({ [phoneDev]: { name: 'Phone', last_seen: relay.clock() } }, relay.clock());
	relay.served.runner = 0;
	const n = runner.DaimondPeer.makeReport({ eid: 'y', turnId: 'other-y', chatId: 'c', status: 'aborted' });
	await runner.DaimondPost.post(await runner.DaimondPeer.sealForSelf(n));
	await round(runner);
	const rst = await runner.DaimondPost.read();
	check('Q5 once the phone is awake, the runner lets the taken report go and acks what it worked',
		(rst.holds || []).length === 0 && rst.through === rst.seen && relay.rows.length === 0,
		'holds ' + JSON.stringify(rst.holds) + ', through ' + rst.through + '/' + rst.seen + ', rows ' + relay.rows.length
		+ ', served ' + relay.served.runner);
}

// ── Q1: no relay clock yet, and this device's clock twenty minutes fast ──
async function q1skew() {
	console.log('\nQ1: a report is never aged on this device\'s clock');
	const relay = makeRelay();
	const { phone, runner, phoneDev } = await pair(relay);
	const P = runner.DaimondPeer;
	const sec = Math.floor(Date.now() / 1000);
	const rep = P.makeReport({ eid: 'e', to: phoneDev, turnId: 't', chatId: 'c', status: 'done' });
	const realNow = Date.now;
	const at = (skewMin, fn) => { globalThis.Date.now = () => realNow() + skewMin * 60000; try { return fn(); } finally { globalThis.Date.now = realNow; } };
	check('Q1 relay clock known, own clock 20 min fast: held for the phone',
		at(20, () => P.noteHeldFor(rep, { ts: sec }, 'RUNNER', realNow())) === phoneDev);
	check('Q1 NO RELAY CLOCK, own clock 20 min fast: held for the phone, not taken',
		at(20, () => P.noteHeldFor(rep, { ts: sec }, 'RUNNER', null)) === phoneDev);
	// End to end: the runner has had no presence answer, and its clock is 20 min fast.
	runner.DaimondPresence.forget();
	const cas = makeCas();
	wireRunner(runner, cas, () => 'done');
	const t1 = await dispatch(phone, phoneDev, 'one');
	await round(runner);
	await until(() => runner.runs.length >= 1);
	await ticks(80);
	globalThis.Date.now = () => realNow() + 20 * 60000;
	try { for (let i = 0; i < 2; i++) await round(runner); }
	finally { globalThis.Date.now = realNow; }
	check('Q1 THE RUNNER LEAVES THE REPORT ON THE RELAY FOR THE PHONE', relay.has(2),
		'rows ' + JSON.stringify(relay.seqs()) + ', runner acked ' + JSON.stringify(relay.acks.filter((a) => a.by === 'runner').map((a) => a.through)));
	await round(phone);
	check('Q1 and the phone gets its answer', !!phone.reports[t1] && phone.reports[t1].status === 'done');
}

// ── Q6: a runner that comes back from a reload with a lease and no errand ──
async function q6restart() {
	console.log('\nQ6: a restarted runner\'s hand-back names the phone');
	const relay = makeRelay();
	const { phone, runner, phoneDev } = await pair(relay);
	const runnerDev = runner.DaimondIdentity.deviceId();
	const cas = makeCas();
	// The turn is taken, and the page is reloaded before it ends: the turn never returns.
	runner.DaimondPeer.onErrand(async (errand, row) => {
		runner.DaimondPeer.runErrand(errand, {
			selfId: runnerDev, selfName: 'runner', cas,
			rowTs: row && row.ts, relayNow: () => Date.now(),
			reconstruct: async () => ({}),
			runTurn: () => new Promise(() => {}),
			post: async () => {}, ack: async () => {}, pushResult: async () => 0,
			setTimer: () => null, clearTimer: () => {},
		});
		return { ran: true };
	});
	const t1 = await dispatch(phone, phoneDev, 'one');
	await round(runner);
	await until(() => !!cas.peek()[t1], 5000);
	const lease = cas.peek()[t1];
	check('Q6 THE LEASE NAMES THE DEVICE THE TURN IS RUN FOR',
		!!lease && lease.holder === runnerDev && lease.dispatchedBy === phoneDev, 'lease ' + JSON.stringify(lease));
	// claimed -> running is its own write; a renew in the same millisecond as the take
	// loses the same-holder tie (`pickLease`), so it is made a moment on, as a run's is.
	await new Promise((r) => setTimeout(r, 5));
	await runner.DaimondLease.renew(t1, runnerDev, cas);
	check('Q6 and the running lease still does', (cas.peek()[t1] || {}).mode === 'running'
		&& (cas.peek()[t1] || {}).dispatchedBy === phoneDev, 'lease ' + JSON.stringify(cas.peek()[t1]));
	// As daimond.js `releaseOwnStaleLeases` builds it on each tree: from the lease where
	// `reportFor` exists, and from the turn id alone before it did.
	const P = runner.DaimondPeer;
	const stale = P.staleOwnLeaseDecision(cas.peek(), runnerDev, {}, Date.now());
	check('Q6 the reloaded runner finds its own stale lease', stale.length === 1 && stale[0] === t1,
		'stale ' + JSON.stringify(stale));
	const report = P.reportFor
		? P.reportFor(cas.peek()[t1] || { turnId: t1 }, { status: 'error', why: 'runner-restarted' })
		: P.makeReport({ turnId: t1, status: 'error', why: 'runner-restarted' });
	await runner.DaimondPost.post(await P.sealForSelf(report));
	await runner.DaimondLease.release(t1, runnerDev, cas);
	check('Q6 the release carries the dispatcher on', (cas.peek()[t1] || {}).dispatchedBy === phoneDev,
		'lease ' + JSON.stringify(cas.peek()[t1]));
	for (let i = 0; i < 3; i++) await round(runner);
	check('Q6 THE HAND-BACK STAYS ON THE RELAY FOR THE PHONE', relay.has(2),
		'rows ' + JSON.stringify(relay.seqs()) + ', runner acked ' + JSON.stringify(relay.acks.filter((a) => a.by === 'runner').map((a) => a.through)));
	await round(phone);
	const r = phone.reports[t1];
	check('Q6 and the phone is told why', !!r && r.status === 'error' && r.why === 'runner-restarted',
		'phone report ' + JSON.stringify(r || null));
}

// ── The awake phone took the report; a later errand the runner lets go leaves the relay ──
// (`verify_handoff_staleturn` a-c with an older phone: the runner refused a replayed turn
// fifteen seconds after the phone took its last report, and its ack stayed pinned below
// the refused errand while it held that report on facts alone.)
async function awakeTook() {
	console.log('\nQ5: a report the awake phone has taken no longer pins the runner\'s ack');
	const relay = makeRelay();
	const { phone, runner, phoneDev } = await pair(relay);
	const cas = makeCas();
	wireRunner(runner, cas, (tid) => (tid.endsWith('two') ? 'undeliverable' : 'done'));
	runner.DaimondPresence.ingest({ [phoneDev]: { name: 'Phone', last_seen: relay.clock() } }, relay.clock());
	await dispatch(phone, phoneDev, 'one');				// row 1; its report row 2, for the phone
	await round(runner);
	await until(() => runner.runs.length >= 1);
	await ticks(80);
	await round(runner);
	await round(phone);									// the phone takes row 2 and acks
	check('the phone took its report', !relay.has(2), 'rows ' + JSON.stringify(relay.seqs()));
	await dispatch(phone, LAPTOP, 'two');				// row 3, let go undeliverable; row 4 for the laptop
	await round(runner);
	await until(() => runner.runs.length >= 2);
	await ticks(80);
	await round(runner);
	check('Q5 THE ERRAND THE RUNNER LET GO IS OFF THE RELAY: the taken report no longer pins its ack',
		!relay.has(3) && relay.has(4), 'rows ' + JSON.stringify(relay.seqs()) + ', runner acked '
		+ JSON.stringify(relay.acks.filter((x) => x.by === 'runner').map((x) => x.through)));
}

await q2reports();
await q2built();
await q5served();
await q1skew();
await q6restart();
await awakeTook();
console.log('\n' + checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
