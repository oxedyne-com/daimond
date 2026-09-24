/* ============================================================
   Test -- a device works each mailbox row once, and keeps every
   hold it has not decided again (www/js/post.js `collect`, hand-off
   QA F1, 2026-09-24).
   ------------------------------------------------------------
   The hand-off reply fix (`e6a99334`) leaves a runner's report on the
   relay for the device it names (`noteHeldFor`), so the runner's ack
   cursor stays below that report until the phone collects it or
   16.5 min pass. Every row above it is then re-fetched by the runner
   on each collect. The runner's code assumed the opposite: a finished
   errand is let go (`runWork` -> `letGo`) and acked off the relay, "so
   it leaves the shared relay and no peer re-claims it into a loop"
   (peer.js, the undeliverable branch). A turn whose report does not
   settle it -- `parked`, `undeliverable`, or a crash with no report --
   was taken again and run again on the runner's every collect.

   Scenario: the PHONE hands T1 to the RUNNER and is put away. T1 runs
   and its report R1 is held on the runner for the phone. A LAPTOP
   (a third device) hands T2 to the runner; T2 parks (a consent no
   attended device could answer), comes back undeliverable or crashes.
   The runner's park wakes on its own report and collects again.
   Expect: T2 is run ONCE.

   The fix passes a row at or below the last pass's `seen` that was not
   held then, so a pass depends on knowing every hold the last one
   kept. Two more cases guard that:

     cut   a collect the wire cuts short keeps R1's hold, so the next
           collect does not ack R1 away before the phone has it;
     lapse R1's window ends while R2 (a second hand-off from the phone)
           is still held: the cursor stops below R2, never passes it
           on the way to deciding it again.

   `--prefix` loads the collector as it was before `e6a99334` (no note
   hold), the baseline for the first four. On `4823e327` the park,
   undeliverable and crash cases enter T2 four times and `lapse` acks
   R2 off the relay; the QA's first cut of the fix, which emptied the
   holds at the top of a pass, failed `cut` and `lapse`.

   Run:  node www/js/rerun_above_held.test.mjs [--prefix]
         WWW=<tree>/www/js node www/js/rerun_above_held.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const WWW = process.env.WWW || dirname(fileURLToPath(import.meta.url));
const PREFIX = process.argv.includes('--prefix');
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
				return ok({ ok: true, rows: relay.rows.filter((r) => r.seq > since), more: false });
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

async function scenario(end) {
	console.log('\nT2 ends ' + end + (PREFIX ? ' (collector before the fix)' : ''));
	const relay = makeRelay();
	const { phone, runner, phoneDev } = await pair(relay);
	const cas = makeCas();
	const LAPTOP = 'a1b2c3d4e5f60718';
	let t1 = '', t2 = '';
	wireRunner(runner, cas, (tid) => (tid === t2 ? end : 'done'));

	// The phone hands T1 to the runner and is put away: it never collects again here.
	t1 = await dispatch(phone, phoneDev, 'one');
	await runner.DaimondPost.round();
	await until(() => runner.runs.length >= 1);
	await ticks(80);
	check('T1 ran on the runner and its report is on the relay', runner.runs.length === 1
		&& relay.rows.some((r) => r.seq === 2), 'rows ' + JSON.stringify(relay.seqs()));

	// A laptop hands T2 to the runner.
	t2 = await dispatch(phone, LAPTOP, 'two');
	await runner.DaimondPost.round();
	await until(() => runner.runs.length >= 2);
	await ticks(80);
	check('T2 was taken and ended ' + end, runner.runs.length === 2 && (runner.starts[t2] | 0) === 1,
		'starts ' + JSON.stringify(runner.starts));

	// The runner's park wakes on its own report row, twice over.
	for (let i = 0; i < 3; i++) {
		await runner.DaimondPost.round();
		await ticks(80);
		await new Promise((r) => setTimeout(r, 50));
		await ticks(80);
	}
	const t2runs = runner.runs.filter((r) => r.tid === t2);
	check('T2 IS RUN ONCE, NOT AGAIN ON EACH COLLECT (' + end + ')', (runner.starts[t2] | 0) === 1,
		'T2 entered ' + (runner.starts[t2] | 0) + ' times; outcomes '
		+ JSON.stringify(t2runs.map((r) => r.out && (r.out.why || (r.out.done ? 'done' : '?'))))
		+ '; relay rows ' + JSON.stringify(relay.seqs()) + '; runner acks '
		+ JSON.stringify(relay.acks.filter((a) => a.by === 'runner').map((a) => a.through)));
}

/// The runner's ack cursor, as the relay last heard it.
const ackedBy = (relay, who) => relay.acks.filter((a) => a.by === who).reduce((m, a) => Math.max(m, a.through), 0);

/// A collect the wire cuts short has decided none of the last pass's holds again, so it
/// must leave them standing: the next collect passes R1's row as already worked.
async function cutShort() {
	console.log('\na collect cut short by the wire, then a new errand' + (PREFIX ? ' (collector before the fix)' : ''));
	const relay = makeRelay();
	const { phone, runner, phoneDev } = await pair(relay);
	const cas = makeCas();
	wireRunner(runner, cas, () => 'done');
	await dispatch(phone, phoneDev, 'one');				// row 1; R1 is row 2, held for the phone
	await runner.DaimondPost.round();
	await until(() => runner.runs.length >= 1);
	await ticks(80);
	await runner.DaimondPost.round();						// folds R1 and holds it
	await ticks(80);
	check('the runner holds R1 for the phone',
		((await runner.DaimondPost.read()).holds || []).some((h) => h.seq === 2));
	relay.cut = 1;
	const cut = await runner.DaimondPost.round();
	check('the cut collect fails as offline', cut && !cut.ok, JSON.stringify(cut));
	const t2 = await dispatch(phone, 'a1b2c3d4e5f60718', 'two');	// row 3, from a laptop
	for (let i = 0; i < 3; i++) { await runner.DaimondPost.round(); await ticks(80); }
	await until(() => (runner.starts[t2] | 0) >= 1, 3000);
	check('the laptop\'s errand ran once', (runner.starts[t2] | 0) === 1, 'starts ' + JSON.stringify(runner.starts));
	check('R1 IS STILL ON THE RELAY FOR THE PHONE AFTER A CUT COLLECT', relay.has(2) && ackedBy(relay, 'runner') < 2,
		'relay rows ' + JSON.stringify(relay.seqs()) + ', runner acked through ' + ackedBy(relay, 'runner'));
}

/// Two reports held for the phone; the lower one's window ends. The cursor rises to just
/// below the one still held -- not to `seen` on the way to deciding it again.
async function lapse() {
	console.log('\ntwo reports held for the phone, the lower one\'s window over' + (PREFIX ? ' (collector before the fix)' : ''));
	const relay = makeRelay();
	const { phone, runner, phoneDev } = await pair(relay);
	const cas = makeCas();
	wireRunner(runner, cas, () => 'done');
	// T1 and its report R1 reach the relay ten minutes before T2 and R2 do.
	const EARLIER = 10 * 60000;
	relay.clock = () => Date.now() - EARLIER;
	await dispatch(phone, phoneDev, 'one');				// row 1; R1 row 2
	await runner.DaimondPost.round();
	await until(() => runner.runs.length >= 1);
	await ticks(80);
	relay.clock = () => Date.now();
	await dispatch(phone, phoneDev, 'two');				// row 3; R2 row 4
	await runner.DaimondPost.round();
	await until(() => runner.runs.length >= 2);
	await ticks(80);
	await runner.DaimondPost.round();
	await ticks(80);
	const held = ((await runner.DaimondPost.read()).holds || []).map((h) => h.seq);
	check('the runner holds R1 and R2 for the phone', held.includes(2) && held.includes(4),
		'holds ' + JSON.stringify(held) + ', relay rows ' + JSON.stringify(relay.seqs()));
	// Seven and a half minutes on: R1 is 17.5 min old, past its window (16.5 min), and R2
	// 7.5 min, inside it. The relay's clock moves on, as the runner's next presence answer
	// tells it; a stamp the relay wrote never changes, and the runner does not read R1 again.
	relay.clock = () => Date.now() + 7.5 * 60000;
	teach(runner, relay);
	await runner.DaimondPost.round();
	await ticks(80);
	check('R1 is let go once its window has passed', !relay.has(2),
		'relay rows ' + JSON.stringify(relay.seqs()));
	check('R2 IS STILL ON THE RELAY FOR THE PHONE', relay.has(4) && ackedBy(relay, 'runner') < 4,
		'relay rows ' + JSON.stringify(relay.seqs()) + ', runner acked through ' + ackedBy(relay, 'runner'));
}

await scenario('park');
await scenario('undeliverable');
await scenario('crash');
await scenario('done');
if (!PREFIX) { await cutShort(); await lapse(); }
console.log('\n' + checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
