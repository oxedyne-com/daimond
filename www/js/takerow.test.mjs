/* ============================================================
   Test — only a seal REFUSAL may mark a collected row bad (TAKEROW).
   ------------------------------------------------------------
   THE FAULT (S1 second check, D2). `takeRow`'s catch turned ANY throw
   from the open into a `bad:<addr>` row, and the ack then dropped the
   relay row: a transient failure -- the identity or WebCrypto not
   ready, the message format not loaded, a peer row whose account key
   could not be used yet -- destroyed that message, errand or report
   for every device.

   THE RULE. The seal types its refusals where it raises them
   (`err.refusal`: short, not_sealed, not_for_you, damaged, malformed,
   not_a_post). Only those mark a row bad. Any other throw records
   nothing, stops the pass before `seen`/`through` reach the row, and
   leaves it on the relay for the next collect.

   WHAT IS CHECKED, with the real post.js (and peer.js for a DPY row)
   over a stand-in relay box and real X25519 / AES-GCM sealing:
     1. transient (three ways): the row survives the ack, no `bad:` row,
        later rows untouched, and a later collect takes it normally;
     2. refusal: a tampered body and a record sealed to another device
        are still kept as bad and acked off the relay.

   Run:  node www/js/takerow.test.mjs        (TREE=<checkout> for another tree)
   ============================================================ */
import { webcrypto } from 'node:crypto';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { loadSeal, installSeal, pendingSeal } from './sealfixture.mjs';

// The real wasm seal (S1): post.js and peer.js seal and open through it only.
await loadSeal();

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const subtle = webcrypto.subtle;
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (u8) => Buffer.from(u8).toString('base64');
const utf8 = (s) => new TextEncoder().encode(s);

async function x25519() {
	const pair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
	const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
	return { pair, pub };
}

const ME = new Uint8Array(32).fill(7);

// identity.js's own verifySig, for the case where its decode of the signature matters.
const idWin = makeWindow({ now: 1_000_000_000 });
loadScript(idWin, 'vendor/noble-curves.min.js');
idWin.DaimondNoble = idWin.DaimondNoble || globalThis.DaimondNoble;
loadScript(idWin, 'curvefallback.js');
loadScript(idWin, 'identity.js');
const realVerifySig = (pub, sig, data) => idWin.DaimondIdentity.verifySig(pub, sig, data);			// this account's signing key (raw)

/// A tab: the real post.js over a relay box, with a seal key, an identity and a
/// message format whose readiness the test controls through `fault`.
async function tab(box, fault, withPeer, pending) {
	const mine = await x25519();
	const w = makeWindow({ now: 1_000_000_000 });
	const accountKey = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
	w.DaimondIdentity = {
		isUnlocked: () => true, deviceId: () => 'dev-self', publicKeyB64url: () => 'pub-self',
		wrap: async (s) => s, unwrap: async (s) => s,
		publicKeyRaw: async () => ME,
		sealingKeyRaw: () => mine.pub,
		sharedSecret: async (epk) => {
			if (fault.key) throw new Error('the sealing key is not ready yet');
			const theirs = await subtle.importKey('raw', epk, { name: 'X25519' }, false, []);
			return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: theirs }, mine.pair.privateKey, 256));
		},
		// The account key a DPY2 peer body is sealed under.
		unwrapBytesAad: async (buf, purpose) => {
			if (fault.locked) throw new Error('identity locked');
			return new Uint8Array(await subtle.decrypt(
				{ name: 'AES-GCM', iv: buf.slice(0, 12), additionalData: utf8(String(purpose)) }, accountKey, buf.slice(12)));
		},
		unwrapBytes: async () => { throw new Error('no DPY1 here'); },
		verifySig: async (pub, sig, data) => {
			if (fault.realVerify) return realVerifySig(pub, sig, data);
			if (fault.verifyThrows) throw new Error('the verifier is not ready');
			return !fault.badSig;
		},
	};
	const fmt = {
		postDraft() {}, signingInput() {}, assemble() {}, address() {},
		read: (plain) => {
			const txt = new TextDecoder().decode(plain);
			// The wasm reader's refusal is a bare STRING (wasm-bindgen); a trap is a RuntimeError.
			if (txt.includes('FORGED')) throw 'signature does not verify';
			if (txt.includes('TRAP') && fault.trap) throw new WebAssembly.RuntimeError('unreachable');
			return txt;
		},
	};
	Object.defineProperty(w, 'DaimondCrypto', { configurable: true, get: () => (fault.noFormat ? undefined : fmt) });
	w.DaimondGateway = {
		clientApi: () => 9,
		gwFetch: async (url, o) => {
			const q = new URLSearchParams(String(url).split('?')[1] || '');
			if (q.get('op') === 'ack') {
				box.acks.push(JSON.parse(o.body).through | 0);
				box.rows = box.rows.filter((r) => r.seq > (JSON.parse(o.body).through | 0));
				return { status: 200, json: async () => ({ ok: true, dropped: 0 }) };
			}
			if (q.has('above')) {
				box.parks = (box.parks || 0) + 1;
				if (box.parks >= 6) w.DaimondPost.parkStop();
				const above = Number(q.get('above'));
				return { status: 200, json: async () => ({ ok: true, waited: true, changed: box.rows.some((r) => r.seq > above) }) };
			}
			if (q.has('since')) {
				const since = Number(q.get('since'));
				const rows = box.rows.filter((r) => r.seq > since);
				const top = box.rows.reduce((m, r) => Math.max(m, r.seq), 0);
				return { status: 200, json: async () => ({ ok: true, rows, more: false, seq: top }) };
			}
			return { status: 200, json: async () => ({ ok: true }) };
		},
	};
	// Every wait is recorded and run at once, so the park's pacing is read off `sleeps`.
	w.sleeps = [];
	w.setTimeout = (fn, ms) => { w.sleeps.push(ms | 0); return setTimeout(fn, 1); };
	w.clearTimeout = (id) => clearTimeout(id);
	// The seal: ready, or (`pending`) as the page has it before the wasm's boot ends.
	const boot = pending ? await pendingSeal(w) : (installSeal(w), null);
	loadScript(w, 'post.js');
	if (withPeer) loadScript(w, 'peer.js');
	await w.DaimondPost.read();
	w.DaimondPost.adopt({ v: 5, through: 0, acked: 0, msgs: {}, notes: {}, groups: {}, shares: {}, feed: { since: 0, read: {}, new: {} } });
	return { w, mine, accountKey, boot };
}

/// A message row sealed to `pub`, addressed to this account.
async function msgRow(w, pub, seq, body, to) {
	const addr = 'a' + String(seq).padStart(63, '0');
	const art = { kind: 'post', address: addr, author: hex(new Uint8Array(32).fill(9)), fingerprint: 'fp',
		time: 1_700_000_000, post: { to: hex(to || ME), body } };
	const env = await w.DaimondPost.seal([pub], utf8(JSON.stringify(art)));
	return { seq, kind: 'post', addr, ts: 1, envelope: b64(env), from_pub: 'x' };
}

/// A DPY2 peer report row, sealed under the account key.
async function peerRow(accountKey, seq, t) {
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	const obj = { t: t || 'report', turnId: 't' + seq, deadline: 9e15, author: hex(ME), sig: 'c2ln' };
	const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8('daimond/peer/env/1') },
		accountKey, utf8(JSON.stringify(obj))));
	const env = new Uint8Array(4 + 12 + ct.length);
	env.set(utf8('DPY2'), 0); env.set(iv, 4); env.set(ct, 16);
	return { seq, kind: 'post', addr: 'p' + String(seq).padStart(63, '0'), ts: 1, envelope: b64(env), from_pub: 'x' };
}

async function pass(w) {
	const r = await w.DaimondPost.collect();
	await w.DaimondPost.ack();
	const st = await w.DaimondPost.read();
	return { r, st };
}
const bads = (st) => Object.keys(st.msgs).filter((k) => k.startsWith('bad:'));

for (const [label, set, withPeer] of [
	['the sealing key not ready', (f) => { f.key = true; }, false],
	['the message format not loaded', (f) => { f.noFormat = true; }, false],
	['a DPY2 peer row while the identity is locked', (f) => { f.locked = true; }, true],
]) {
	console.log('\ntakerow 1: transient -- ' + label);
	const box = { rows: [], acks: [] };
	const fault = {};
	const { w, mine, accountKey } = await tab(box, fault, withPeer);
	const first = withPeer ? await peerRow(accountKey, 1) : await msgRow(w, mine.pub, 1, 'hello one');
	const second = await msgRow(w, mine.pub, 2, 'hello two');
	box.rows = [first, second];
	if (withPeer) {
		// Only the peer row faults: the message after it opens, so a pass that did not
		// stop would take it.
		set(fault);
	} else set(fault);
	const a = await pass(w);
	check('the faulting row is still on the relay', box.rows.some((r) => r.seq === 1), JSON.stringify(box.acks));
	check('no bad: row is stored', bads(a.st).length === 0, bads(a.st).join(','));
	check('the pass stopped: the later row was not taken', !a.st.msgs[second.addr] && box.rows.some((r) => r.seq === 2));
	check('the cursor did not reach the row', (a.st.through | 0) < 1 && (a.st.seen | 0) < 1, 'through ' + a.st.through + ' seen ' + a.st.seen);
	for (const k of Object.keys(fault)) delete fault[k];
	const b = await pass(w);
	if (!withPeer) check('cleared, a later collect takes the row normally', !!b.st.msgs[first.addr] && b.st.msgs[first.addr].body === 'hello one');
	else check('cleared, a later collect routes the peer row', bads(b.st).length === 0);
	check('and the rest of the box', !!b.st.msgs[second.addr] && box.rows.length === 0, JSON.stringify(box.rows.map((r) => r.seq)));
}

console.log('\ntakerow 2: refusals are still kept as bad and acked off');
{
	const box = { rows: [], acks: [] };
	const fault = {};
	const { w, mine } = await tab(box, fault, true);
	const other = await x25519();
	const tampered = await msgRow(w, mine.pub, 1, 'tampered');
	const raw = Buffer.from(tampered.envelope, 'base64');
	raw[raw.length - 1] ^= 1;						// the body's GCM tag fails
	tampered.envelope = raw.toString('base64');
	const elsewhere = await msgRow(w, other.pub, 2, 'for another device');
	const after = await msgRow(w, mine.pub, 3, 'fine');
	box.rows = [tampered, elsewhere, after];
	const a = await pass(w);
	check('the tampered record is kept as bad', !!a.st.msgs['bad:' + tampered.addr]);
	check('the record for another device is kept as bad', !!a.st.msgs['bad:' + elsewhere.addr]);
	check('the pass went on to the next row', !!a.st.msgs[after.addr]);
	check('and all three were acked off the relay', box.rows.length === 0, JSON.stringify(box.rows.map((r) => r.seq)));
}

for (const [label, set, t] of [
	['a report whose signature check THROWS', (f) => { f.verifyThrows = true; }, 'report'],
	['an errand whose signature check THROWS', (f) => { f.verifyThrows = true; }, 'errand'],
	['a report whose handler THROWS', (f) => { f.handler = true; }, 'report'],
]) {
	console.log('\ntakerow 3: no verdict is not a drop -- ' + label);
	const box = { rows: [], acks: [] };
	const fault = {};
	const { w, mine, accountKey } = await tab(box, fault, true);
	let handled = 0;
	w.DaimondPeer.onReport(async () => { if (fault.handler) throw new Error('the report runner failed'); handled++; });
	w.DaimondPeer.onErrand(async () => { handled++; return null; });
	const first = await peerRow(accountKey, 1, t);
	const second = await msgRow(w, mine.pub, 2, 'after');
	box.rows = [first, second];
	set(fault);
	const a = await pass(w);
	check('the row is still on the relay', box.rows.some((r) => r.seq === 1), JSON.stringify(box.acks));
	check('the pass stopped on it', a.r.stopped === true && !a.st.msgs[second.addr]);
	for (const k of Object.keys(fault)) delete fault[k];
	await pass(w);
	await new Promise((r) => setTimeout(r, 20));
	check('cleared, a later collect hands it on', handled === 1, 'handled ' + handled);
	check('and takes the rest', !!(await w.DaimondPost.read()).msgs[second.addr]);
}

console.log('\ntakerow 3: a signature checked and wrong is still dropped');
{
	const box = { rows: [], acks: [] };
	const fault = { badSig: true };
	const { w, mine, accountKey } = await tab(box, fault, true);
	let handled = 0;
	w.DaimondPeer.onReport(async () => { handled++; });
	const forged = await peerRow(accountKey, 1);
	const after = await msgRow(w, mine.pub, 2, 'after');
	box.rows = [forged, after];
	const a = await pass(w);
	check('the forgery is not handed on', handled === 0);
	check('the pass went on, and both rows were acked off', !!a.st.msgs[after.addr] && box.rows.length === 0,
		JSON.stringify(box.rows.map((r) => r.seq)));
}

console.log('\ntakerow 4: a stall on one row is told to the debug feed, once');
{
	const box = { rows: [], acks: [] };
	const fault = { key: true };
	const { w, mine } = await tab(box, fault, false);
	const events = [];
	w.DEBUG_SHARE = { event: (k, p) => events.push([k, p]) };
	const row = await msgRow(w, mine.pub, 1, 'stuck');
	box.rows = [row];
	const stalls = () => events.filter((e) => e[0] === 'collect.stall');
	await pass(w);
	check('one stopped pass says nothing', stalls().length === 0);
	await pass(w);
	const s1 = stalls();
	check('a second pass stopped on the same row emits collect.stall', s1.length === 1, JSON.stringify(events));
	check('naming the row and the error', s1.length === 1 && s1[0][1].seq === 1 && s1[0][1].addr === row.addr
		&& /not ready/.test(s1[0][1].err), JSON.stringify(s1));
	await pass(w); await pass(w);
	check('at most once per row per page load', stalls().length === 1, String(stalls().length));
}

console.log('\ntakerow 5: definite refusals a stranger can post are refusals, not stalls');
for (const [label, make, opts] of [
	['P1 an artefact the wasm reader refuses (a thrown string)', async (w, mine) => msgRow(w, mine.pub, 1, 'FORGED'), {}],
	['P2 a low-order sender key (all-zero shared secret)', async (w, mine) => {
		const r = await msgRow(w, mine.pub, 1, 'low order');
		const env = Buffer.from(r.envelope, 'base64'); env.fill(0, 4, 36); r.envelope = env.toString('base64');
		return r;
	}, {}],
	['P3 a DPS1 peer report whose signature is not base64', async (w, mine) => {
		const obj = { t: 'report', turnId: 't1', author: hex(ME), sig: '!!!not-b64!!!' };
		const env = await w.DaimondPost.seal([mine.pub], utf8(JSON.stringify(obj)));
		return { seq: 1, kind: 'post', addr: 'p' + '1'.padStart(63, '0'), ts: 1, envelope: b64(env), from_pub: 'x' };
	}, { realVerify: true, peer: true }],
]) {
	console.log('  -- ' + label);
	const box = { rows: [], acks: [] };
	const fault = { realVerify: !!opts.realVerify };
	const { w, mine } = await tab(box, fault, !!opts.peer);
	let handled = 0;
	if (opts.peer) w.DaimondPeer.onReport(async () => { handled++; });
	const first = await make(w, mine);
	const after = await msgRow(w, mine.pub, 2, 'after');
	box.rows = [first, after];
	const a = await pass(w);
	check('the pass did not stop on it', a.r.stopped === false, JSON.stringify(a.r));
	check('the later message was taken', !!a.st.msgs[after.addr]);
	check('both rows acked off the relay', box.rows.length === 0, JSON.stringify(box.rows.map((r) => r.seq)));
	if (opts.peer) check('the bad report was not handed on', handled === 0);
}

console.log('\ntakerow 5: a wasm trap is no verdict on the record');
{
	const box = { rows: [], acks: [] };
	const fault = { trap: true };
	const { w, mine } = await tab(box, fault, false);
	const row = await msgRow(w, mine.pub, 1, 'TRAP');
	box.rows = [row];
	const a = await pass(w);
	check('a RuntimeError from the reader leaves the row on the relay, unjudged',
		a.r.stopped === true && box.rows.length === 1 && bads(a.st).length === 0, JSON.stringify(a.r));
}

console.log('\ntakerow 6: a stalled box backs the park off, as a failed round does');
{
	const box = { rows: [], acks: [] };
	const fault = { key: true };
	const { w, mine } = await tab(box, fault, false);
	box.rows = [await msgRow(w, mine.pub, 1, 'stuck')];
	const r = await w.DaimondPost.round();
	check('round reports the stopped pass', r && r.stopped === true, JSON.stringify(r));
	w.sleeps.length = 0;
	w.DaimondPost.parkStart();
	for (let i = 0; i < 200 && w.DaimondPost.parking().on; i++) await new Promise((res) => setTimeout(res, 5));
	const ladder = w.sleeps.filter((ms) => ms >= 5000 && ms <= 60000);
	check('the park waited on the backoff ladder (5 s doubling)', ladder.includes(5000) && ladder.includes(10000) && ladder.includes(20000),
		JSON.stringify(w.sleeps));
}

console.log('\ntakerow 7: the wasm seal not yet up is waited for; one whose boot FAILED takes no row');
{
	const box = { rows: [], acks: [] };
	const { w, mine, boot } = await tab(box, {}, false, true);
	const { w: sealer } = await tab({ rows: [], acks: [] }, {}, false);		// a ready tab seals the rows
	box.rows = [await msgRow(sealer, mine.pub, 1, 'early one'), await msgRow(sealer, mine.pub, 2, 'early two')];
	let done = false;
	const run = w.DaimondPost.collect().then((r) => { done = true; return r; });
	await new Promise((r) => setTimeout(r, 30));
	check('a collect before the seal is up waits for it', !done && box.rows.length === 2);
	boot.start();
	const r = await run;
	await w.DaimondPost.ack();
	const st = await w.DaimondPost.read();
	check('and takes the rows once it is', r.stopped === false && !!st.msgs['a' + '1'.padStart(63, '0')] && !!st.msgs['a' + '2'.padStart(63, '0')]
		&& box.rows.length === 0, JSON.stringify(r));
}
{
	const box = { rows: [], acks: [] };
	const { w, mine, boot } = await tab(box, {}, false, true);
	const { w: sealer } = await tab({ rows: [], acks: [] }, {}, false);
	box.rows = [await msgRow(sealer, mine.pub, 1, 'one'), await msgRow(sealer, mine.pub, 2, 'two')];
	boot.fail(new Error('the wasm module did not start'));
	const a = await pass(w);
	check('a failed boot stops the pass', a.r.stopped === true, JSON.stringify(a.r));
	check('no row is taken or kept as bad', Object.keys(a.st.msgs).length === 0, Object.keys(a.st.msgs).join(','));
	check('and every row stays on the relay', box.rows.length === 2 && (a.st.through | 0) === 0 && (a.st.seen | 0) === 0,
		JSON.stringify(box.rows.map((x) => x.seq)));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall takerow checks passed');
process.exit(failures ? 1 : 0);
