/* ============================================================
   Test -- a runner holding a report for an absent phone still sees
   new work past one collect page (www/js/post.js `collect`, hand-off
   QA F3, 2026-09-24).
   ------------------------------------------------------------
   `collect` fetched `?since=through` and stopped after the first page
   once anything was held ("once holding, stop fetching further batches
   this pass"): a second page asked from the pinned `through` would be
   the first page again. The gateway pages a collect at
   `max_collect_bytes` (1 MiB; an envelope may be 64 KiB). With a
   report held at the bottom for 16.5 min, the runner saw only the
   first page above it, pass after pass: an errand past that page was
   not collected until the phone came back or the window ended. The
   relay here pages at PAGE rows to make the page small.

   The fix: each page starts after the last row the one before it
   carried, whatever is held. On `4823e327` the runner holds [2] and
   never collects the errand at row 9. `--prefix` loads the collector
   as it was before `e6a99334` (no note hold). The harness is
   rerun_above_held.test.mjs's.

   Run:  node www/js/page_starve.test.mjs [--prefix]
         WWW=<tree>/www/js node www/js/page_starve.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const WWW = process.env.WWW || dirname(fileURLToPath(import.meta.url));
const PREFIX = process.argv.includes('--prefix');
const PAGE = 4;
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
				const since = Number(q.get('since'));
				const all = relay.rows.filter((r) => r.seq > since);
				return ok({ ok: true, rows: all.slice(0, PAGE), more: all.length > PAGE });
			}
			if (q.has('above')) return new Promise(() => {});
			return ok({ ok: true });
		},
	};
	win.DaimondPresence = { relayNow: () => relay.clock() };
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
	return win;
}

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


console.log('\nan errand past one collect page, above a report held for the phone' + (PREFIX ? ' (collector before the fix)' : ''));
{
	const relay = makeRelay();
	const { phone, runner, phoneDev } = await pair(relay);
	const cas = makeCas();
	wireRunner(runner, cas, () => 'done');
	await dispatch(phone, phoneDev, 'one');				// row 1
	await runner.DaimondPost.round();
	await until(() => runner.runs.length >= 1);
	await ticks(80);										// T1's report is row 2, held for the phone
	// Six notes for nobody in particular (another device's traffic), then an errand.
	for (let i = 0; i < 6; i++) {
		await phone.DaimondPost.post(await phone.DaimondPeer.sealForSelf(phone.DaimondPeer.makeReport({
			eid: 'f' + i, turnId: 'filler-' + i, chatId: 'c', status: 'done' })));
	}
	const t3 = await dispatch(phone, 'a1b2c3d4e5f60718', 'three');	// row 9
	for (let i = 0; i < 4; i++) { await runner.DaimondPost.round(); await ticks(80); }
	await until(() => runner.runs.length >= 2, 3000);
	check('THE RUNNER COLLECTS AND RUNS THE ERRAND PAST THE FIRST PAGE', runner.runs.some((r) => r.tid === t3),
		'runs ' + JSON.stringify(runner.runs.map((r) => r.tid.split('-').pop())) + ', relay rows '
		+ JSON.stringify(relay.seqs()) + ', runner holds '
		+ JSON.stringify(((await runner.DaimondPost.read()).holds || []).map((h) => h.seq)));
}
console.log('\n' + checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
