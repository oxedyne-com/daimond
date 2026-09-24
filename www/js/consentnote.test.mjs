/* ============================================================
   Test -- a consent question and its answer reach the device they
   are for (SIM-3 and R3 QA Q4 / D126, 2026-09-25).
   ------------------------------------------------------------
   The relay's ack is one watermark for the whole account, so a note
   is held on the relay for the device it names (`noteHeldFor`), and
   `to` is the one field that names it. Two notes had none:

     SIM-3  a consent ASK named its device only in `target`, which the
            hold did not read, and the owner's broadcast ask names no
            device at all: the runner that asked folded its own
            question and acked it away before the phone saw it.
     Q4     a consent GRANT named nobody: a third device that collected
            it took it and acked it away before the runner saw it, and
            the turn parked at its deadline.

   Drives the REAL identity.js, post.js and peer.js in two tabs of one
   account over one in-memory relay that stamps rows and honours the
   account-wide ack (the harness of heldnote.test.mjs).

     G1  a grant addressed to the runner survives the laptop's own
         collect and ack, and the runner receives it once;
     G2  the laptop's hold on it ends when a question can no longer be
         answered (the ask's deadline, 60 s, plus 30 s), not after the
         16.5 min a report is held;
     A1  a broadcast ask survives the runner's own collect and ack, and
         the phone raises it once;
     A2  an ask that names the phone is held for the phone;
     A3  the runner's hold on a question ends with the question.

   Run:  node www/js/consentnote.test.mjs
         WWW=<release/r4>/www/js node www/js/consentnote.test.mjs   # G1, A1, A2 fail
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


const round = async (tab, n = 40) => { await tab.DaimondPost.round(); await ticks(n); };

/// A consent question as `routeConsentAsk` posts it: from the runner, broadcast unless
/// `target` names a device.
async function postAsk(runner, cid, target) {
	const now = Date.now();
	const ask = runner.DaimondPeer.makeAsk({ cid, eid: 'e-' + cid, turnId: 't-' + cid, chatId: 'c-' + cid,
		tool: 'web_click', host: 'example.test', detail: 'press the button',
		deadline: now + runner.DaimondPeer.CONSENT_DEADLINE_MS, dispatchedBy: runner.DaimondIdentity.deviceId(),
		target: target || '' });
	await runner.DaimondPost.post(await runner.DaimondPeer.sealForSelf(ask));
	return ask;
}

/// The grant `sealAndPostGrant` posts for an ask: to the runner that asked.
async function postGrant(tab, ask) {
	const grant = tab.DaimondPeer.makeGrant({ cid: ask.cid, eid: ask.eid, turnId: ask.turnId, verdict: 'allow',
		by: tab.DaimondIdentity.deviceId(), to: String(ask.dispatchedBy || '') });
	await tab.DaimondPost.post(await tab.DaimondPeer.sealForSelf(grant));
	return grant;
}

function listen(tab) {
	tab.asks = {}; tab.grants = {};
	tab.DaimondPeer.onAsk(async (a) => { tab.asks[a.cid] = (tab.asks[a.cid] | 0) + 1; });
	tab.DaimondPeer.onGrant(async (g) => { tab.grants[g.cid] = (tab.grants[g.cid] | 0) + 1; });
}

async function grantCase() {
	console.log('\nG: a grant for the runner, collected first by the device that answered (Q4, D126)');
	const relay = makeRelay();
	let skew = 0;
	relay.clock = () => Date.now() + skew;
	const { phone: laptop, runner } = await pair(relay);
	listen(laptop); listen(runner);
	teach(laptop, relay); teach(runner, relay);
	const ask = { cid: 'k1', eid: 'e-k1', turnId: 't-k1', dispatchedBy: runner.DaimondIdentity.deviceId() };
	await postGrant(laptop, ask);						// row 1
	await round(laptop);								// the laptop collects and acks first
	check('G1. the grant is still on the relay after the laptop\'s collect and ack (release 4: acked away)',
		relay.has(1), 'rows ' + JSON.stringify(relay.seqs()) + ', laptop acked '
		+ JSON.stringify(relay.acks.filter((x) => x.by === 'phone').map((x) => x.through)));
	await round(runner);
	check('G1. the runner receives it once (release 4: 0)', runner.grants.k1 === 1, JSON.stringify(runner.grants));
	check('G1. and its own ack takes it off the relay', !relay.has(1), 'rows ' + JSON.stringify(relay.seqs()));
	// A second grant nobody else collects: the laptop's hold ends with the question.
	await postGrant(laptop, { ...ask, cid: 'k2' });		// row 2
	await round(laptop);
	const held0 = relay.has(2);
	skew = runner.DaimondPeer.CONSENT_DEADLINE_MS + 20000;	// 80 s on the relay's clock
	teach(laptop, relay);
	await round(laptop);
	const held80 = relay.has(2);
	skew = runner.DaimondPeer.CONSENT_DEADLINE_MS + 40000;	// 100 s
	teach(laptop, relay);
	await round(laptop);
	check('G2. the laptop holds a grant for the runner while its question stands, and not past it (90 s)',
		held0 && held80 && !relay.has(2), JSON.stringify({ at0: held0, at80: held80, at100: relay.has(2) }));
}

async function askCase() {
	console.log('\nA: a consent question, collected first by the runner that asked it (SIM-3)');
	const relay = makeRelay();
	let skew = 0;
	relay.clock = () => Date.now() + skew;
	const { phone, runner, phoneDev } = await pair(relay);
	listen(phone); listen(runner);
	teach(phone, relay); teach(runner, relay);
	await postAsk(runner, 'q1', '');					// row 1, broadcast
	await round(runner);								// the runner collects its own question and acks
	check('A1. a broadcast question survives the runner\'s own collect and ack (release 4: acked away)',
		relay.has(1), 'rows ' + JSON.stringify(relay.seqs()));
	await round(phone);
	check('A1. and the phone raises it once (release 4: 0)', phone.asks.q1 === 1, JSON.stringify(phone.asks));
	await postAsk(runner, 'q2', phoneDev);				// row 2, for the phone
	await round(runner);
	check('A2. a question that names the phone is held for it (release 4: acked away)', relay.has(2),
		'rows ' + JSON.stringify(relay.seqs()));
	await round(phone);
	check('A2. and the phone raises it once', phone.asks.q2 === 1, JSON.stringify(phone.asks));
	// The question has stood its 60 s and 30 s more: every hold on it ends.
	skew = runner.DaimondPeer.CONSENT_DEADLINE_MS + 40000;
	teach(phone, relay); teach(runner, relay);
	await round(runner);
	await round(phone);
	check('A3. once the question can no longer be answered nobody holds it (100 s)', !relay.has(1) && !relay.has(2),
		'rows ' + JSON.stringify(relay.seqs()));
}

await grantCase();
await askCase();
console.log('\n' + checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
