/* ============================================================
   Test -- A RUNNER ASKING TO JOIN, APPROVED WITH HIS PASSKEY (R2d1)
   (www/js/daimond.js, "A runner asking to join, approved with his passkey"; passkey.js
   `approveRunner`; src/seal/runner.rs; u3b_r_plan.md R2d row; design 20261016 §5 "Approve").
   ------------------------------------------------------------
   The tile half lifts `Pending` and the `runnerPair*` functions out of daimond.js as written
   (dev/syncprobe.mjs); the approve half runs the real passkey.js over the real wasm seal in
   www/pkg (the SEAL-BRIDGE block, as dev/seal_compat.mjs builds it), with the authenticator
   and the gateway stood in. The runner key is the committed vector
   (src/seal/testdata/runner_bundle.json); the bundle is opened here with node's own X25519
   from the vector's Ed25519 seed, as the keeper will (R2d2).
   Needs www/pkg (dev/build-wasm.sh --no-opt).

   Each check is proven able to fail:

     node www/js/runnerapprove.test.mjs --break sticky    # a tile outlives its pending runner
     node www/js/runnerapprove.test.mjs --break locked    # the list is asked with no identity unlocked
     node www/js/runnerapprove.test.mjs --break dropfail  # a failed approval takes the tile down
     node www/js/runnerapprove.test.mjs --break noassert  # an approval goes out with no assertion
     node www/js/runnerapprove.test.mjs --break plain     # the plaintext is posted, not the seal
     node www/js/runnerapprove.test.mjs                   # and then, clean
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { makeWindow, liftSource } from '../../dev/syncprobe.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPrivateKey, createPublicKey, diffieHellman, webcrypto } from 'node:crypto';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0, cases = 0, bad = null;
function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
async function kase(name, fn) {
	cases++; bad = null;
	try { await fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); } else { console.log('  ok   ' + name); }
}

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
const KNOWN = ['sticky', 'locked', 'dropfail', 'noassert', 'plain'];
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', ')); process.exit(2); }

function swapper(src) {
	return function swap(needle, to) {
		const n = src.split(needle).length - 1;
		if (n !== 1) { console.error('break ' + BREAK + ': target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
		src = src.replace(needle, to);
		return src;
	};
}
function patchTile(src) {
	const swap = swapper(src);
	if (BREAK === 'sticky')   src = swap("return x.kind !== 'runnerpair' || (!!x.runnerpair && !!waiting[x.runnerpair.device]);", 'return true;');
	if (BREAK === 'locked')   src = swap('try { if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return false; }', 'try { }');
	if (BREAK === 'dropfail') src = swap("if (!res || !res.ok) return { ok: false, error: (res && res.error) || t('pending.runnerpair.failed') };", '');
	return src;
}
function patchPasskey(src) {
	const swap = swapper(src);
	if (BREAK === 'noassert') src = swap("if (!got || !got.prf) return { ok: false, error: t('passkey.err_runner_no_assertion') };", "if (!got || !got.prf) got = { prf: PRF_FALLBACK, credId: credId };");
	if (BREAK === 'plain')    src = swap('try { sealed = await DaimondSeal.sealRunnerBundle(edPk, plain); }', 'try { sealed = plain.slice(); }');
	return src;
}

// ── The tile, lifted from daimond.js ────────────────────────────────

const NAMES = ['Pending', 'runnerPairPoll', 'runnerPairSettle', 'runnerPairApprove', 'runnerPairRefuse'];
const OWN = /^(runnerPair|RUNNER_PAIR_|_runnerPair)/;
const STUBS = liftSource(NAMES, []).ordered.filter((n) => !NAMES.includes(n) && !OWN.test(n));

const DEV1 = 'wd7q3nu5182bfz2e', DEV2 = 'c3v932cd31z6cszm';
const PK = 'A'.repeat(43);
function runner(device, state, more) {
	return Object.assign({ device: device, kind: 'runner', state: state, name: 'argonaut', pubkey: PK, joined: 1760745600, approved: state === 'active' ? 1760745700 : 0 }, more || {});
}

function page(o) {
	o = o || {};
	const win = makeWindow();
	const st = { fetches: [], reply: { ok: true, runners: [] }, unlocked: o.unlocked === undefined ? true : o.unlocked, approve: { ok: true }, approveCalls: [] };
	win.fetch = async (url) => { st.fetches.push(String(url)); const r = st.reply; return { ok: true, status: 200, json: async () => r }; };
	win.DaimondIdentity = { isUnlocked: () => st.unlocked };
	win.DaimondPasskey = { approveRunner: async (d, k) => { st.approveCalls.push([d, k]); return st.approve; } };
	win.document.hidden = !!o.hidden;
	const stub = {
		t: (k, v) => k + (v ? '|' + Object.keys(v).sort().map((x) => x + '=' + v[x]).join(',') : ''),
		readJson: (k, d) => { try { const v = win.localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
		PENDING_KEY: 'daimond-pending', PRIORITIES: ['high', 'normal', 'low'], NOTICED_KEY: 'daimond-pending-noticed', NOTICED_MAX: 64,
		settleConsent: () => false, _parked: {}, relTime: () => 'now', nudgeSync: () => {}, steerTile: () => {}, steerRaise: () => {},
		toast: () => {}, diamonds: [], currentDiamond: null, selectDiamond: async () => {}, turnHold: () => null, confirmHold: async () => {},
		doSteer: async () => {}, steerPress: async () => {}, steerEdit: async () => {}, promptDialog: async () => null,
		sendMessage: async () => {}, newChat: async () => {}, DaimondPanels: { isOpen: () => true, show: () => {} },
		DIAMOND_TOMBS_KEY: 'daimond-diamond-tombs', tombMapNow: () => ({}), trashed: () => false,
		RUNNER_NONCE_RE: /^[A-Za-z0-9_-]{22}$/,
	};
	let src = liftSource(NAMES, STUBS).src;
	src = patchTile(src);
	for (const n of STUBS) if (!(n in stub)) stub[n] = undefined;
	const sk = Object.keys(stub);
	const body = 'with (window) { return (function (' + sk.join(', ') + ') {\n' + src + '\nreturn { ' + NAMES.join(', ') + ' };\n}).apply(null, stubs); }';
	const fns = new Function('window', 'stubs', body)(win, sk.map((k) => stub[k]));
	fns.Pending.render = () => {};
	return { win, st, fns, P: fns.Pending, items: () => { fns.Pending.fresh(); return fns.Pending.items.slice(); } };
}
const tiles = (pg) => pg.items().filter((x) => x.kind === 'runnerpair');

console.log('runner join tile (R2d1)');

await kase('a pending runner raises ONE high-priority tile, and it counts on the chip', async () => {
	const pg = page();
	pg.st.reply = { ok: true, runners: [runner(DEV1, 'pending'), runner(DEV2, 'active')] };
	eq(await pg.fns.runnerPairPoll(), true, 'the list was read');
	const tl = tiles(pg);
	eq(tl.length, 1, 'one tile, for the pending runner only');
	eq(tl[0] && tl[0].runnerpair.device, DEV1, 'the pending device');
	eq(tl[0] && tl[0].priority, 'high', 'high priority');
	eq(tl[0] && tl[0].headline, 'pending.runnerpair.headline|name=argonaut', 'headline names the computer');
	eq(pg.P.counted(), 1, 'it counts (the importance filter: it needs him)');
	await pg.fns.runnerPairPoll();
	eq(tiles(pg).length, 1, 'polled again, still one');
	eq(pg.st.fetches[0], '/api/runner/pair/list', 'the list door');
});

await kase('the tile clears when the runner is approved, or removed', async () => {
	const pg = page();
	pg.st.reply = { ok: true, runners: [runner(DEV1, 'pending')] };
	await pg.fns.runnerPairPoll();
	eq(tiles(pg).length, 1, 'raised');
	pg.st.reply = { ok: true, runners: [runner(DEV1, 'active')] };
	await pg.fns.runnerPairPoll();
	eq(tiles(pg).length, 0, 'gone once approved (here or from another device)');
	pg.st.reply = { ok: true, runners: [runner(DEV2, 'pending')] };
	await pg.fns.runnerPairPoll();
	eq(tiles(pg).length, 1, 'a second runner raised');
	pg.st.reply = { ok: true, runners: [] };
	await pg.fns.runnerPairPoll();
	eq(tiles(pg).length, 0, 'gone once removed or lapsed');
});

await kase('an unreadable list takes nothing down; no ask while locked or hidden', async () => {
	const pg = page();
	pg.st.reply = { ok: true, runners: [runner(DEV1, 'pending')] };
	await pg.fns.runnerPairPoll();
	pg.win.fetch = async () => { throw new Error('offline'); };
	eq(await pg.fns.runnerPairPoll(), false, 'unread');
	pg.win.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
	eq(await pg.fns.runnerPairPoll(), false, 'refused');
	eq(tiles(pg).length, 1, 'kept while the list cannot be read');
	const pg2 = page({ unlocked: false });
	eq(await pg2.fns.runnerPairPoll(), false, 'not read while locked');
	eq(pg2.st.fetches.length, 0, 'no request with no identity unlocked');
	const pg3 = page({ hidden: true });
	eq(await pg3.fns.runnerPairPoll(), false, 'not read while hidden');
	eq(pg3.st.fetches.length, 0, 'no request while hidden');
});

await kase('Approve takes the tile down only when his passkey approval lands', async () => {
	const pg = page();
	pg.st.reply = { ok: true, runners: [runner(DEV1, 'pending')] };
	await pg.fns.runnerPairPoll();
	const it = tiles(pg)[0];
	pg.st.approve = { ok: false, error: 'passkey.err_runner_no_assertion' };
	const r1 = await pg.fns.runnerPairApprove(it);
	eq(r1, { ok: false, error: 'passkey.err_runner_no_assertion' }, 'the refusal is told');
	eq(tiles(pg).length, 1, 'a refused approval keeps the tile');
	eq(pg.st.approveCalls, [[DEV1, PK]], 'the passkey module was asked with the device and its key');
	pg.st.approve = { ok: true };
	eq(await pg.fns.runnerPairApprove(it), { ok: true }, 'approved');
	eq(tiles(pg).length, 0, 'the tile is down');
});

await kase('Pending.add refuses a malformed runner, and replaces one for the same device', async () => {
	const pg = page();
	eq(pg.P.add({ kind: 'runnerpair', headline: 'x', runnerpair: { device: 'bad id!', pubkey: PK } }), null, 'bad device id');
	eq(pg.P.add({ kind: 'runnerpair', headline: 'x', runnerpair: { device: DEV1, pubkey: 'short' } }), null, 'bad key');
	ok(typeof pg.P.add({ kind: 'runnerpair', headline: 'x', runnerpair: { device: DEV1, pubkey: PK } }) === 'string', 'accepted');
	ok(typeof pg.P.add({ kind: 'runnerpair', headline: 'y', runnerpair: { device: DEV1, pubkey: PK } }) === 'string', 'accepted again');
	eq(tiles(pg).map((x) => x.headline), ['y'], 'one tile per device');
});

// ── The approval: passkey.js over the wasm seal ─────────────────────

const pkgJs = join(APP, 'www', 'pkg', 'oxedyne_daimond.js');
if (!existsSync(pkgJs)) { console.log('no www/pkg: build it with dev/build-wasm.sh --no-opt'); process.exit(2); }
const mod = await import(pkgJs);
mod.initSync({ module: readPage(join(APP, 'www', 'pkg', 'oxedyne_daimond_bg.wasm')) });
if (typeof mod.seal_runner_bundle !== 'function') { console.log('www/pkg carries no seal_runner_bundle: rebuild it'); process.exit(2); }
const dsrc = readPage(join(APP, 'www', 'js', 'daimond.js'), 'utf8');
const sa = dsrc.indexOf('// SEAL-BRIDGE-BEGIN'), sb = dsrc.indexOf('// SEAL-BRIDGE-END');
function sealBridge() { const w = {}; new Function('window', 'Sbj', dsrc.slice(sa, sb))(w, mod); return w.DaimondSeal; }

const V = JSON.parse(readPage(join(APP, 'src', 'seal', 'testdata', 'runner_bundle.json'), 'utf8'));
const hexb = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const b64u = (b) => Buffer.from(b).toString('base64url');
const SENT = V.sentinel;
const PRF = webcrypto.getRandomValues(new Uint8Array(32));
const CRED = webcrypto.getRandomValues(new Uint8Array(16));

/// The X25519 secret the keeper derives from its Ed25519 seed (RFC 8032 §5.1.5 first half).
function xKeys(seed) {
	const sk = createHash('sha512').update(Buffer.from(seed)).digest().subarray(0, 32);
	const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), sk]), format: 'der', type: 'pkcs8' });
	const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12);
	return { priv, pub: new Uint8Array(pub) };
}
async function openWith(seal, bytes, seed) {
	const k = xKeys(seed);
	const epk = await seal.postEpk(bytes);
	const theirs = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(epk)]), format: 'der', type: 'spki' });
	const shared = diffieHellman({ privateKey: k.priv, publicKey: theirs });
	return (await seal.openPost(bytes, new Uint8Array(shared), k.pub)).plain;
}

/// A tab with an enrolled v2 passkey whose blob seals an identity bundle and a passphrase
/// that both carry the sentinel; `assert` is what the authenticator answers.
async function approveTab(assert) {
	const win = makeWindow();
	win.crypto = webcrypto;
	const st = { posts: [], gets: 0 };
	const salt = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('daimond-prf-salt-v2')));
	const base = await webcrypto.subtle.importKey('raw', PRF, { name: 'HKDF' }, false, ['deriveKey']);
	const key = await webcrypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: new TextEncoder().encode('daimond-passkey-v1') },
		base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	const plain = new TextEncoder().encode(JSON.stringify({ bundle: { v: 3, wrapped: SENT + '-bundle' }, pass: SENT + '-pass' }));
	const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plain));
	const blob = Buffer.concat([iv, ct]).toString('base64');
	win.localStorage.setItem('daimond-passkey', JSON.stringify({ v: 2, cred: b64u(CRED), blob: blob }));
	win.navigator.credentials = { get: async () => { st.gets++; return assert; } };
	win.DaimondGateway = {
		clientApi: () => 1,
		gwFetch: async (path, opts) => { st.posts.push({ path: path, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; },
	};
	win.DaimondSeal = sealBridge();
	win.DaimondIdentity = { deviceId: () => 'tab-approver-1' };
	win.PRF_FALLBACK = PRF;	// what the `noassert` break pretends the authenticator gave
	let src = readPage(join(APP, 'www', 'js', 'passkey.js'), 'utf8');
	src = patchPasskey(src);
	new Function('window', 'with (window) {\n' + src + '\n}')(win);
	return { win, st, P: win.DaimondPasskey };
}
const assertion = (prf) => ({
	rawId: CRED.buffer.slice(0),
	getClientExtensionResults: () => (prf ? { prf: { results: { first: prf.buffer.slice(0) } } } : {}),
});

console.log('runner approval (R2d1)');

await kase('approve without a passkey assertion is refused, and nothing is posted', async () => {
	for (const [what, a] of [['no assertion', null], ['an assertion with no PRF output', assertion(null)]]) {
		const tab = await approveTab(a);
		const r = await tab.P.approveRunner(DEV1, b64u(hexb(V.ed_pk)));
		eq(r && r.ok, false, what + ': refused');
		eq(tab.st.gets, 1, what + ': the authenticator was asked');
		eq(tab.st.posts.length, 0, what + ': no approval posted');
	}
	// With no passkey enrolled at all, the authenticator is not even asked.
	const tab = await approveTab(assertion(PRF));
	tab.win.localStorage.removeItem('daimond-passkey');
	const r = await tab.P.approveRunner(DEV1, b64u(hexb(V.ed_pk)));
	eq(r, { ok: false, error: 'pending.runnerpair.no_passkey' }, 'no passkey: told so');
	eq(tab.st.posts.length + tab.st.gets, 0, 'nothing asked, nothing posted');
});

await kase('the posted bundle carries no plaintext marker and opens only with the runner key', async () => {
	const tab = await approveTab(assertion(PRF));
	const r = await tab.P.approveRunner(DEV1, b64u(hexb(V.ed_pk)));
	eq(r, { ok: true }, 'approved');
	eq(tab.st.posts.length, 1, 'one approval posted');
	const post = tab.st.posts[0] || { body: {} };
	eq(post.path, '/api/runner/pair/approve', 'the approve door');
	eq(post.body.device, DEV1, 'names the device');
	ok(/^[A-Za-z0-9_-]{43}$/.test(String(post.body.passkey)), 'carries the passkey handle: ' + post.body.passkey);
	const raw = JSON.stringify(post.body);
	ok(!raw.includes(SENT), 'the posted body holds the plaintext marker');
	const bytes = Uint8Array.from(Buffer.from(String(post.body.bundle || ''), 'base64url'));
	ok(!Buffer.from(bytes).includes(SENT), 'the bundle bytes hold the plaintext marker');
	eq(Buffer.from(bytes.subarray(0, 4)).toString(), 'DPS1', 'a DPS1 record');
	eq(bytes[36], 1, 'exactly one slot');
	// The keeper's derivation from the seed agrees with the Rust recipient form.
	eq(b64u(xKeys(hexb(V.ed_seed)).pub), b64u(hexb(V.x_pk)), "node's X25519 of the seed is the vector's recipient");
	const seal = tab.win.DaimondSeal;
	const opened = JSON.parse(new TextDecoder().decode(await openWith(seal, bytes, hexb(V.ed_seed))));
	eq(opened.kind, 'kimberlite-bundle', 'kind');
	eq(opened.device, DEV1, 'bound to the runner it was approved for');
	eq(opened.pass, SENT + '-pass', 'carries the passphrase the passkey opened');
	eq(opened.bundle && opened.bundle.wrapped, SENT + '-bundle', 'carries the identity bundle');
	// R2d2: the pins travel inside the seal: the asserting passkey and the approving device.
	eq(opened.pins && opened.pins.passkeys, [post.body.passkey], 'pins the passkey that asserted');
	eq(opened.pins && opened.pins.approver && opened.pins.approver.device, 'tab-approver-1', 'pins the approving device');
	let code = null;
	try { await openWith(seal, bytes, webcrypto.getRandomValues(new Uint8Array(32))); } catch (e) { code = e.code; }
	eq(code, 'not_for_you', 'another key does not open it');
	// The bundle Rust sealed in the vector opens here too (Rust seal -> node keeper derivation).
	const vplain = new TextDecoder().decode(await openWith(seal, hexb(V.bundle), hexb(V.ed_seed)));
	eq(vplain, V.plain.replace(/'/g, '"'), 'the Rust vector opens with the seed');
});

console.log((failures ? 'FAIL' : 'PASS') + ' runnerapprove: ' + (cases - failures) + '/' + cases + (BREAK ? ' (break ' + BREAK + ')' : ''));
if (failures) process.exitCode = 1;
