/* ============================================================
   Test -- the page half of the per-device ack (gateway release 5,
   R3 QA Q4, P1a H4): post.js and peer.js against a relay that acks
   per device, and against one that does not.
   ------------------------------------------------------------
   A relay that answers a collect with `acks:"device"` drops a row
   addressed to one device (`for`) only on that device's own ack, and
   forgets any row at its `ttl`. The page's side of that:

     meta   `sealForSelf` tells the relay whose a note is and how long
            it matters: a report or `built` for its `to`, an ask for its
            `target`, a grant for the runner that asked; an errand names
            its turn and lives until no device may start it;
     q4     a grant answered on one device, collected and acked by it and
            by a third device, still reaches the runner that asked;
     nohold on such a relay a note addressed to another device is folded
            and never held, so no cursor waits on it; on a relay that
            does not ack per device it is held exactly as before;
     first  the age rule reads the relay's stamp of a turn's first post,
            so a re-hand of a turn first posted five days ago is stale
            whatever the sender's clock says.

   Each block names the tree it fails on: all of it fails on release/r4,
   where the fields are not sent and not read.

   Run:  node www/js/postack_device.test.mjs
         WWW=<tree>/www/js node www/js/postack_device.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const WWW = process.env.WWW || dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
async function until(cond, ms = 10000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 5)); }
	return !!cond();
}

/// The relay, modelled on gateway release 5's `handlers/post.rs`: rows carry `for`, `until`
/// and `first`; an ack naming a device keeps a row addressed to another; a collect answers
/// `acks:"device"`. `perDevice:false` is the gateway before it: every ack drops every row.
function makeRelay(perDevice) {
	let seq = 0;
	const firsts = {};
	const relay = {
		rows: [], acks: [], perDevice,
		now: () => Date.now(),
		put(b) {
			if (relay.rows.some((r) => r.addr === b.addr)) return;
			seq++;
			const ts = Math.floor(relay.now() / 1000);
			const row = { seq, kind: 'post', addr: b.addr, envelope: b.envelope, ts };
			if (perDevice) {
				row['for'] = String(b['for'] || '');
				row.until = b.ttl ? ts + Math.max(30, Math.min(86400, b.ttl | 0)) : (row['for'] ? ts + 990 : 0);
				if (b.turn) { firsts[b.turn] = firsts[b.turn] || ts; row.turn = b.turn; row.first = firsts[b.turn]; }
			}
			relay.rows.push(row);
		},
		seedFirst(turn, ts) { firsts[turn] = ts; },
		live: () => relay.rows.filter((r) => !(r.until > 0 && r.until <= Math.floor(relay.now() / 1000))),
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
	win.posted = [];
	win.DaimondGateway = {
		clientApi: () => 1,
		gwFetch: async (path, o) => {
			const q = new URLSearchParams(String(path).split('?')[1] || '');
			if (q.get('op') === 'ack') {
				const b = JSON.parse(o.body);
				const through = b.through | 0, dev = String(b.device || '');
				relay.acks.push({ by: name, through, device: dev });
				relay.rows = relay.rows.filter((r) => r.seq > through
					|| (relay.perDevice && dev && r['for'] && r['for'] !== dev));
				return ok({ ok: true, dropped: 0 });
			}
			if (o && o.method === 'POST') { const b = JSON.parse(o.body); win.posted.push(b); relay.put(b); return ok({ ok: true }); }
			if (q.has('since')) {
				const since = Number(q.get('since'));
				const out = { ok: true, rows: relay.live().filter((r) => r.seq > since), more: false };
				if (relay.perDevice) { out.acks = 'device'; out.now = relay.now(); }
				return ok(out);
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
	// identity.js reads its records through store.js since release 5, as index.html loads it.
	loadScript('store.js');
	loadScript('vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;');
	loadScript('curvefallback.js');
	loadScript('identity.js');
	loadScript('post.js');
	loadScript('peer.js');
	return win;
}

/// Three devices of one account on `relay`: R the runner, L and P two more.
async function three(relay) {
	const R = makeTab(relay, 'R'), L = makeTab(relay, 'L'), P = makeTab(relay, 'P');
	const PASS = 'correct horse battery staple frigate';
	await R.DaimondIdentity.create('Runner', PASS);
	for (const t of [L, P]) {
		t.DaimondIdentity.importBundle(R.DaimondIdentity.exportBundle());
		await t.DaimondIdentity.unlock(PASS);
	}
	for (const t of [R, L, P]) {
		t.grants = []; t.reports = []; t.asks = [];
		t.DaimondPeer.onGrant(async (g) => { t.grants.push(g); });
		t.DaimondPeer.onReport(async (r) => { t.reports.push(r); });
		t.DaimondPeer.onAsk(async (a) => { t.asks.push(a); });
		t.id = t.DaimondIdentity.deviceId();
	}
	return { R, L, P };
}

const collect = (t) => t.DaimondPost.collect();
const ack = (t) => t.DaimondPost.ack();

// ── meta ────────────────────────────────────────────────────────
console.log('\nmeta -- what sealForSelf tells the relay');
{
	const relay = makeRelay(true);
	const { R, L } = await three(relay);
	const P = R.DaimondPeer;
	const now = Date.now();
	const rep = await P.sealForSelf(P.makeReport({ eid: 'e', turnId: 't', to: L.id, status: 'done' }));
	check('a report names its device and lives a note\'s span', rep['for'] === L.id && rep.ttl === 990,
		JSON.stringify({ for: rep['for'], ttl: rep.ttl }));
	const unaddressed = await P.sealForSelf(P.makeReport({ eid: 'e', turnId: 't', status: 'done' }));
	check('a report with no `to` is an account row', !('for' in unaddressed) && !('ttl' in unaddressed));
	const err = await P.sealForSelf(P.makeErrand({ turnId: 'turn-9', chatId: 'c', prompt: 'x',
		deadline: now + 15 * 60000, dispatchedBy: R.id }));
	check('an errand names its turn and no device', err.turn === 'turn-9' && !('for' in err), JSON.stringify(err.turn));
	check('an errand lives until no device may start it', err.ttl >= 990 && err.ttl <= 991, 'ttl ' + err.ttl);
	const ask = await P.sealForSelf(P.makeAsk({ cid: 'c1', turnId: 't', dispatchedBy: R.id, target: L.id,
		deadline: now + 120000 }));
	check('an ask names the device that should answer it', ask['for'] === L.id && ask.ttl >= 149 && ask.ttl <= 150,
		JSON.stringify({ for: ask['for'], ttl: ask.ttl }));
}

// ── q4 ──────────────────────────────────────────────────────────
console.log('\nq4 -- a grant answered on L reaches R after L and P ack through it');
// The ask names L, the device that answers it (SIM-3, release 5): an ask with no addressee is
// the owner's broadcast, which every device holds for as long as it can be answered, so no
// cursor would pass it inside this test.
async function q4(perDevice) {
	const relay = makeRelay(perDevice);
	const { R, L, P } = await three(relay);
	await R.DaimondPost.post(await R.DaimondPeer.sealForSelf(R.DaimondPeer.makeAsk({
		cid: 'cid-q4', eid: 'e', turnId: 'turn-q4', dispatchedBy: R.id, target: L.id, deadline: Date.now() + 120000 })));
	await collect(L); await collect(P);
	const body = await L.DaimondPeer.sealForSelf(L.DaimondPeer.makeGrant({
		cid: 'cid-q4', eid: 'e', turnId: 'turn-q4', verdict: 'allow', by: L.id }));
	await L.DaimondPost.post(body);
	await collect(L); await ack(L);
	await collect(P); await ack(P);
	const kept = relay.rows.some((r) => r.addr === body.addr);
	await collect(R);
	return { relay, R, L, P, body, kept, got: R.grants.filter((g) => g.cid === 'cid-q4').length };
}
{
	const q = await q4(true);
	check('the grant is addressed to the runner that asked', q.body['for'] === q.R.id, q.body['for'] + ' vs ' + q.R.id);
	check('L and P acked through the grant', q.relay.acks.filter((a) => a.by !== 'R').every((a) => a.through >= 2)
		&& q.relay.acks.some((a) => a.by === 'L') && q.relay.acks.some((a) => a.by === 'P'), JSON.stringify(q.relay.acks));
	check('each ack named its device', q.relay.acks.every((a) => a.device), JSON.stringify(q.relay.acks));
	check('THE RELAY KEPT THE GRANT FOR R', q.kept, JSON.stringify(q.relay.rows.map((r) => [r.seq, r['for']])));
	check('R RECEIVED THE GRANT, ONCE', q.got === 1, 'received ' + q.got);
	await ack(q.R);
	check('R\'s own ack took it', !q.relay.rows.some((r) => r.addr === q.body.addr));
}
{
	// The same page on a relay that does not ack per device: the grant names R, so every
	// other collector holds it for R (`noteHeldFor`), and R still gets it -- Q4's interim.
	const q = await q4(false);
	check('on an older relay the grant still names R', q.body['for'] === q.R.id);
	check('on an older relay L and P hold it for R, so R receives it', q.kept && q.got === 1,
		'kept ' + q.kept + ', received ' + q.got);
}

// ── nohold ──────────────────────────────────────────────────────
console.log('\nnohold -- an addressed note is not held on a relay that keeps it for its device');
async function heldAfterReport(perDevice) {
	const relay = makeRelay(perDevice);
	const { R, L } = await three(relay);
	// The runner posts its report for L and collects it itself, as it does.
	await R.DaimondPost.post(await R.DaimondPeer.sealForSelf(R.DaimondPeer.makeReport({
		eid: 'e', turnId: 'turn-r', chatId: 'c', to: L.id, status: 'done' })));
	await collect(R); await ack(R);
	return { relay, st: R.DaimondPost.state() };
}
{
	const a = await heldAfterReport(true);
	check('on a per-device relay the runner\'s cursor passes its own report at once',
		a.st.through >= 1 && a.st.acked >= 1, JSON.stringify(a.st));
	check('and the relay keeps the report for L', a.relay.rows.length === 1 && a.relay.rows[0]['for'] !== '');
	const b = await heldAfterReport(false);
	check('on an older relay the runner holds it for L as before (cursor below it)',
		b.st.through === 0 && b.relay.rows.length === 1, JSON.stringify(b.st));
}

// ── first ───────────────────────────────────────────────────────
console.log('\nfirst -- the age rule reads the relay\'s stamp of a turn\'s first post');
{
	const relay = makeRelay(true);
	const { R } = await three(relay);
	const now = Date.now();
	// A turn born a minute ago on the sender's clock, re-handed now: fresh by every birth
	// the sender holds.
	const turnId = (now - 60000).toString(36) + '-1-abcd';
	const e = R.DaimondPeer.makeErrand({ turnId, chatId: 'c', prompt: 'x', deadline: now + 14 * 60000,
		dispatchedBy: R.id, ts: now });
	const rowTs = Math.floor(now / 1000);
	const fresh = R.DaimondPeer.turnAgeVerdict(e, { rowTs, relayNow: now, now });
	check('without a first-post stamp the re-hand reads fresh', fresh.ok === true, JSON.stringify(fresh));
	const firstTs = rowTs - 5 * 86400;
	const stale = R.DaimondPeer.turnAgeVerdict(e, { rowTs, rowFirst: firstTs, relayNow: now, now });
	check('WITH THE RELAY\'S FIRST POST FIVE DAYS AGO IT IS STALE', stale.ok === false && stale.why === 'stale',
		JSON.stringify(stale));
	check('and the age says whose clock', /first/.test(stale.clock), stale.clock);
	const recent = R.DaimondPeer.turnAgeVerdict(e, { rowTs, rowFirst: rowTs - 30, relayNow: now, now });
	check('a first post thirty seconds ago changes nothing', recent.ok === true, JSON.stringify(recent));
}

// ── parcel ──────────────────────────────────────────────────────
// Where L and P fold a grant addressed to R and ack past it, and R then pulls L's record off
// the sync parcel before it collects again: R adopted L's cursors, started its collect above
// the grant, never folded it, and believed it had acked it. The Q4 probe on world 27 failed
// this way one run in two.
console.log('\nparcel -- a sibling\'s record does not carry the runner past a grant addressed to it');
async function parcel(perDevice) {
	const relay = makeRelay(perDevice);
	const { R, L, P } = await three(relay);
	await R.DaimondPost.post(await R.DaimondPeer.sealForSelf(R.DaimondPeer.makeAsk({
		cid: 'cid-pc', eid: 'e', turnId: 'turn-pc', dispatchedBy: R.id, target: L.id, deadline: Date.now() + 120000 })));
	await collect(L); await collect(P);
	await collect(R); await ack(R);		// R has read its relay before it goes quiet
	const body = await L.DaimondPeer.sealForSelf(L.DaimondPeer.makeGrant({
		cid: 'cid-pc', eid: 'e', turnId: 'turn-pc', verdict: 'allow', by: L.id }));
	await L.DaimondPost.post(body);
	await collect(L); await ack(L);
	await collect(P); await ack(P);
	const snap = L.DaimondPost.snapshot();
	const before = R.DaimondPost.state();
	R.DaimondPost.adopt(snap);
	// A page before this fix still sends its cursors; they are not followed either.
	R.DaimondPost.adopt(Object.assign({}, snap, { through: 99, acked: 99 }));
	const after = R.DaimondPost.state();
	await collect(R);
	const got = R.grants.filter((g) => g.cid === 'cid-pc').length;
	await ack(R);
	return { relay, snap, body, got, before, after };
}
{
	const q = await parcel(true);
	check('on a per-device relay the parcel carries no mailbox cursor',
		!('through' in q.snap) && !('acked' in q.snap) && !('devAcks' in q.snap),
		JSON.stringify({ through: q.snap.through, acked: q.snap.acked, devAcks: q.snap.devAcks }));
	check('a sibling\'s cursors do not move R', q.after.through === q.before.through && q.after.acked === q.before.acked,
		JSON.stringify({ before: [q.before.through, q.before.acked], after: [q.after.through, q.after.acked] }));
	check('R STILL COLLECTS THE GRANT AFTER ADOPTING L\'S RECORD', q.got === 1, 'received ' + q.got);
	check('R\'s own ack then takes it off the relay', !q.relay.rows.some((r) => r.addr === q.body.addr),
		JSON.stringify(q.relay.rows.map((r) => [r.seq, r['for']])));
}
{
	// An older relay acks for the account: the cursors are the account's and travel as before.
	const q = await parcel(false);
	check('on an older relay the cursors still ride the parcel', (q.snap.through | 0) >= 1 && 'acked' in q.snap,
		JSON.stringify({ through: q.snap.through, acked: q.snap.acked }));
	check('and are adopted', q.after.through === 99 && q.after.acked === 99,
		JSON.stringify([q.after.through, q.after.acked]));
}

console.log('\n' + checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
