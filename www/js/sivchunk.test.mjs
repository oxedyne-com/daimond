/* ============================================================
   Test — one chunk address on every device of one account
   (UNBLOCK-4, www/js/identity.js `wrapChunk`, chunks.js offload).
   ------------------------------------------------------------
   The 507 of 14 Oct: each device sealed every chunk under a fresh
   random IV, so the same plaintext lived on the gateway once per
   device under three addresses, and each push released the other
   devices' copies. A chunk is now sealed SIV-style: its IV is
   derived from the account's own key and the plaintext's hash, so
   two devices of one account produce the same ciphertext and the
   same address, and a second upload adds nothing.

   Drives the REAL identity.js and chunks.js, two devices of one
   account (the second is the first's localStorage copied and
   unlocked with the same passphrase, which is what pairing leaves
   behind), and a mock gateway holding chunks by address.

   Run:  node www/js/sivchunk.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto, createHash } from 'node:crypto';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, passes = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); passes++; }
	else { console.log('  FAIL ' + line); failures++; }
}

const ID_SRC = readFileSync(join(HERE, 'identity.js'), 'utf8');
const CH_SRC = readFileSync(join(HERE, 'chunks.js'), 'utf8');
const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
const atob = (s) => Buffer.from(s, 'base64').toString('binary');
function EventShim(t) { this.type = t; }
function mkStore(m) {
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => m.set(k, String(v)),
		removeItem: (k) => m.delete(k),
	};
}
const quiet = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

/// One device: identity.js and chunks.js loaded over the device's own
/// localStorage, talking to the shared `gw`.
function device(disk, gw, tab) {
	const win = {};
	win.window = win;
	win.dispatchEvent = () => true;
	win.addEventListener = () => {};
	win.document = { readyState: 'complete', addEventListener: () => {} };
	win.sessionStorage = mkStore(tab || new Map());
	const ls = mkStore(disk);
	loadStore(win, ls);
	new Function('window', 'crypto', 'localStorage', 'btoa', 'atob',
		'TextEncoder', 'TextDecoder', 'Event', 'console', 'globalThis', ID_SRC)(
		win, webcrypto, ls, btoa, atob, TextEncoder, TextDecoder, EventShim, quiet, globalThis);

	const doc = { getElementById: () => null, querySelector: () => null,
		createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {},
			addEventListener: () => {}, querySelector: () => null }),
		head: { appendChild: () => {} }, body: { appendChild: () => {} } };
	win.document = doc;		// chunks.js reads `document` through `with (window)`.
	win.DaimondGateway = gw.api;
	win.btoa = btoa;
	win.atob = atob;
	new Function('window', 'document', 'DaimondGateway', 'localStorage', 'setTimeout',
		'clearTimeout', 'console', 'crypto', 'with (window) {\n' + CH_SRC + '\n}')(
		win, doc, gw.api, ls, setTimeout, clearTimeout, quiet, webcrypto);
	return { ID: win.DaimondIdentity, CH: win.DaimondChunks, disk };
}

/// A gateway holding chunks by address, re-hashing each as the real one does.
function gateway() {
	const held = new Map();		// addr -> bytes
	const log  = { puts: 0, fresh: 0, bytes: 0 };
	const dec  = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
	const api = {
		clientApi: () => 1,
		gwFetch: async (_path, opts) => {
			const b = JSON.parse(opts.body);
			let j = { ok: true };
			if (b.op === 'have') j = { ok: true, missing: b.addrs.filter((a) => !held.has(a)) };
			else if (b.op === 'put') {
				for (const c of b.chunks) {
					const bytes = dec(c.blob);
					if (createHash('sha256').update(bytes).digest('hex') !== c.addr) {
						return { status: 400, json: async () => ({ ok: false, error: 'mislabelled' }) };
					}
					log.puts++;
					if (!held.has(c.addr)) { held.set(c.addr, bytes); log.fresh++; log.bytes += bytes.length; }
				}
				j = { ok: true, stored: b.chunks.length };
			} else if (b.op === 'get') {
				const v = held.get(b.addr);
				j = v ? { ok: true, present: true, blob: v.toString('base64url') } : { ok: true, present: false };
			}
			return { status: 200, json: async () => j };
		},
	};
	return { api, held, log };
}

const PASS  = 'correct horse battery staple frigate';
const OTHER = 'a different account entirely, seven words';

async function main() {
	const gw = gateway();
	const diskA = new Map();
	const A = device(diskA, gw);
	await A.ID.create('Tester', PASS);
	// Pairing leaves the second device the same bundle and salt; it unlocks with
	// the same passphrase. Its chunk map (localStorage) starts empty.
	const diskB = new Map(diskA);
	for (const k of [...diskB.keys()]) if (k.startsWith('daimond-chunk-map')) diskB.delete(k);
	const B = device(diskB, gw);
	const r = await B.ID.unlock(PASS);
	check('the second device unlocks the same account', !!r && r.ok === true);

	// Several chunks' worth, so the manifest has more than one address.
	const plain = new Uint8Array(3 * 256 * 1024 + 777);
	let seed = 12345;		// LCG, so no two chunks share a plaintext.
	for (let i = 0; i < plain.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; plain[i] = seed >>> 24; }

	console.log('two devices of one account, one plaintext');
	const ma = await A.CH.offloadBytes('d:same', plain);
	const afterA = { ...gw.log };
	const mb = await B.CH.offloadBytes('d:same', plain);
	const addrsA = ma.chunks.map((c) => c.addr);
	const addrsB = mb.chunks.map((c) => c.addr);
	check('the manifest has several distinct chunks', new Set(addrsA).size > 1, String(addrsA.length));
	check('both devices name the same addresses',
		JSON.stringify(addrsA) === JSON.stringify(addrsB));
	check('the second device stores no new chunk', gw.log.fresh === afterA.fresh,
		(gw.log.fresh - afterA.fresh) + ' new');
	check('and adds no stored bytes', gw.log.bytes === afterA.bytes,
		(gw.log.bytes - afterA.bytes) + ' bytes');

	console.log('\nthe readers are unchanged');
	const back = await B.CH.materialiseBytes(ma);
	check('the second device opens the first device\'s manifest',
		!!back && Buffer.compare(Buffer.from(back), Buffer.from(plain)) === 0);
	const one = new Uint8Array([1, 2, 3, 4, 5]);
	const sealed = await A.ID.wrapChunk(one);
	check('a convergent seal opens with plain unwrapBytes',
		Buffer.compare(Buffer.from(await B.ID.unwrapBytes(sealed)), Buffer.from(one)) === 0);

	console.log('\nwhat stays apart');
	const twice = await A.ID.wrapChunk(one);
	check('the same chunk seals to the same bytes', Buffer.compare(Buffer.from(sealed), Buffer.from(twice)) === 0);
	const near = await A.ID.wrapChunk(new Uint8Array([1, 2, 3, 4, 6]));
	check('a different chunk takes a different IV',
		Buffer.compare(Buffer.from(sealed.slice(0, 12)), Buffer.from(near.slice(0, 12))) !== 0);
	const r1 = await A.ID.wrapBytes(one), r2 = await A.ID.wrapBytes(one);
	check('wrapBytes, used for envelopes, stays randomised',
		Buffer.compare(Buffer.from(r1), Buffer.from(r2)) !== 0);
	const C = device(new Map(), gateway());
	await C.ID.create('Other', OTHER);
	const elsewhere = await C.ID.wrapChunk(one);
	check('another account seals the same chunk differently',
		Buffer.compare(Buffer.from(sealed), Buffer.from(elsewhere)) !== 0);
	const ivA = Buffer.from(sealed.slice(0, 12)), ivC = Buffer.from(elsewhere.slice(0, 12));
	check('and under a different IV', Buffer.compare(ivA, ivC) !== 0);

	console.log('\na reload that restores the session keeps the address');
	{
		const tab  = new Map();
		const disk = new Map(diskA);
		const D = device(disk, gw, tab);
		D.ID.setStayUnlocked(true);
		await D.ID.unlock(PASS);
		const E = device(disk, gw, tab);
		const got = await E.ID.restoring();
		check('the reload restored the session', !!got && got.ok === true && got.via === 'session');
		const restored = await E.ID.wrapChunk(one);
		check('a restored session seals as the first device does',
			Buffer.compare(Buffer.from(restored), Buffer.from(sealed)) === 0);
		E.ID.lock();
		check('a locked device refuses to seal',
			await E.ID.wrapChunk(one).then(() => false, () => true));
	}

	console.log('\nthe IV is the HMAC of a labelled plaintext hash, under an HKDF key (condition 1, 2)');
	{
		const tab = new Map();
		const F = device(new Map(diskA), gw, tab);
		F.ID.setStayUnlocked(true);
		await F.ID.unlock(PASS);
		const bits = Buffer.from(JSON.parse(tab.get('daimond-id-session')).k, 'base64');
		const S = webcrypto.subtle;
		const base = await S.importKey('raw', bits, { name: 'HKDF' }, false, ['deriveKey']);
		const hk = await S.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32),
			info: new TextEncoder().encode('daimond chunk-iv key v1') }, base,
			{ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
		const ph  = new Uint8Array(await S.digest('SHA-256', one));
		const lab = new TextEncoder().encode('daimond chunk-iv v1\u0000');
		const mac = new Uint8Array(await S.sign('HMAC', hk,
			Buffer.concat([Buffer.from(lab), Buffer.from(ph)])));
		check('the IV is HMAC(HKDF(bits, label), label || sha256(chunk))[0..12]',
			Buffer.compare(Buffer.from(mac.slice(0, 12)), ivA) === 0);
		// The raw AES key used as the MAC key would give another IV; that is the
		// separation the HKDF label buys.
		const raw = await S.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const rawMac = new Uint8Array(await S.sign('HMAC', raw, Buffer.concat([Buffer.from(lab), Buffer.from(ph)])));
		check('and not the HMAC under the encryption key itself',
			Buffer.compare(Buffer.from(rawMac.slice(0, 12)), ivA) !== 0);
		const unlabelled = new Uint8Array(await S.sign('HMAC', hk, ph));
		check('and not the HMAC of the bare hash (the label is in the input)',
			Buffer.compare(Buffer.from(unlabelled.slice(0, 12)), ivA) !== 0);
	}

	console.log('\na passphrase change moves every address, on every device (condition 2)');
	{
		const gw2 = gateway();
		const d1 = new Map(diskA), d2 = new Map(diskA);
		const P = device(d1, gw2), Q = device(d2, gw2);
		await P.ID.unlock(PASS);
		await Q.ID.unlock(PASS);
		const before = await P.ID.wrapChunk(one);
		const ch = await P.ID.changePassphrase(PASS, 'yet another seven word passphrase for the rekey');
		check('the passphrase change goes through', !!ch && ch.ok === true, JSON.stringify(ch));
		const after = await P.ID.wrapChunk(one);
		check('the changer seals the chunk to a new address',
			Buffer.compare(Buffer.from(before), Buffer.from(after)) !== 0);
		const ad = await Q.ID.adoptRekey(P.ID.rekeyRecord());
		check('the other device adopts the rekey', !!ad && ad.ok === true, JSON.stringify(ad));
		const adopted = await Q.ID.wrapChunk(one);
		check('and seals to the changer\'s new address, not the old one',
			Buffer.compare(Buffer.from(adopted), Buffer.from(after)) === 0);
		const R = device(new Map(d1), gw2);
		await R.ID.unlock('yet another seven word passphrase for the rekey');
		check('a device unlocking with the new passphrase agrees',
			Buffer.compare(Buffer.from(await R.ID.wrapChunk(one)), Buffer.from(after)) === 0);
	}

	console.log('\ndevices upgraded from the random-IV build converge (B1)');
	{
		// The old build sealed each chunk under a random IV and kept the address in
		// its map under the unversioned key, then reused that address for as long
		// as the gateway held it. Build that state on two devices, then load the
		// new build over the same localStorage and collect again.
		const gw3 = gateway();
		const OLD = 'daimond-chunk-map';
		const dA = new Map(diskA), dB = new Map(diskA);
		for (const d of [dA, dB]) for (const k of [...d.keys()]) if (k.startsWith(OLD)) d.delete(k);
		const oldBuild = async (disk) => {
			const X = device(disk, gw3);
			await X.ID.unlock(PASS);
			X.ID.wrapChunk = X.ID.wrapBytes;		// the old seal: a fresh IV every time.
			const m = await X.CH.offloadBytes('d:same', plain);
			// Whatever key this build writes, the old build wrote the unversioned one.
			let held = null;
			for (const k of [...disk.keys()]) if (k.startsWith(OLD)) { held = disk.get(k); disk.delete(k); }
			disk.set(OLD, held);
			return m.chunks.map((c) => c.addr);
		};
		const oA = await oldBuild(dA), oB = await oldBuild(dB);
		check('the old build left the two devices on different addresses',
			JSON.stringify(oA) !== JSON.stringify(oB));
		const upgrade = async (disk) => {
			const X = device(disk, gw3);
			await X.ID.unlock(PASS);
			return X;
		};
		const nA = await upgrade(dA), nB = await upgrade(dB);
		// ASKED BEFORE ANY OFFLOAD, in the order a collect asks it: the collect skips
		// every unchanged file unless a re-offload is owed, so a device that learns of
		// the upgrade only inside an offload never learns of it while it is idle.
		check('an upgraded device owes the re-offload before it offloads anything',
			nA.CH.staleSinceRekey() === true && !dA.has(OLD));
		const uA = (await nA.CH.offloadBytes('d:same', plain)).chunks.map((c) => c.addr);
		const uB = (await nB.CH.offloadBytes('d:same', plain)).chunks.map((c) => c.addr);
		check('after the upgrade both devices name the same addresses',
			JSON.stringify(uA) === JSON.stringify(uB));
		check('and those are the convergent ones, not either old copy',
			JSON.stringify(uA) === JSON.stringify(addrsA)
			&& !uA.some((a) => oA.includes(a) || oB.includes(a)));
		check('the old map is gone from both devices', !dA.has(OLD) && !dB.has(OLD));
		check('a re-offload of unchanged large files is owed once',
			nA.CH.staleSinceRekey() === true && nB.CH.staleSinceRekey() === true);
		const before = gw3.log.fresh;
		const dN = new Map(diskA);
		for (const k of [...dN.keys()]) if (k.startsWith(OLD)) dN.delete(k);
		const N = device(dN, gw3);
		await N.ID.unlock(PASS);
		const uN = (await N.CH.offloadBytes('d:same', plain)).chunks.map((c) => c.addr);
		check('a third, new device names the same addresses', JSON.stringify(uN) === JSON.stringify(uA));
		check('and adds no new chunk', gw3.log.fresh === before, (gw3.log.fresh - before) + ' new');
	}

	console.log('\nfail closed (condition 3)');
	{
		const L = device(new Map(diskA), gw);
		let threw = false;
		try { await L.ID.wrapChunk(one); } catch (e) { threw = true; }
		check('a never-unlocked device refuses to seal a chunk', threw);
		const before = gw.log.puts;
		let offThrew = false;
		try { await L.CH.offloadBytes('d:locked', one); } catch (e) { offThrew = true; }
		check('and an offload on it uploads nothing', offThrew && gw.log.puts === before);
	}

	console.log('\n' + passes + ' passed, ' + failures + ' failed');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
