/* consoleseal.test.mjs -- the operator console checks a report through the wasm seal, the one
   implementation the app and the native runner use (S1-QA2, r570s post-QA item 2).

   The console's "Check" on an abuse report opens the DPS1 envelope with the content key the
   recipient handed over and compares what comes out with the artefact the row carries. Until
   S1-QA2 it did that with its own JavaScript (a DPS1 parser and a WebCrypto AES-GCM open in
   www/console/admin.js), a second implementation outside the seal gate: a format change made only
   in src/seal would have read "THAT KEY DOES NOT OPEN THAT CIPHERTEXT" about a genuine report.

   This runs the console's own lines (the block between `// REPORT-SEAL-BEGIN` and
   `// REPORT-SEAL-END` in admin.js) over the wasm from www/pkg, and proves:
     C1  every DPS1 vector the wasm sealed (src/seal/testdata/wasm_vectors.json), and every native
         and JS-captured one, checks good with its content key;
     C2  a flipped body byte, a flipped head byte, a wrong key, a truncated record, a wrong tag
         and a short key are each refused with the seal's TYPED code;
     C3  a record that opens to something other than the artefact is refused;
     C4  admin.js carries no seal of its own (no AES-GCM, no subtle decrypt, no DPS1 magic).

   Needs www/pkg (dev/build-wasm.sh --no-opt).   node www/js/consoleseal.test.mjs */
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, diffieHellman } from 'node:crypto';
import { loadSeal } from './sealfixture.mjs';

const ADMIN = new URL('../console/admin.js', import.meta.url);
const TD = new URL('../../src/seal/testdata/', import.meta.url);
const vec = (n) => JSON.parse(readFileSync(new URL(n + '_vectors.json', TD), 'utf8'));

let checks = 0, failures = 0;
function check(name, ok, detail) {
	checks++;
	if (ok) return;
	failures++;
	console.log('  FAIL ' + name + (detail ? '  -- ' + detail : ''));
}

const b64 = (u8) => Buffer.from(u8).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const unhex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

const admin = readFileSync(ADMIN, 'utf8');

// C4 -- one implementation: nothing of the seal is left in the console's own script.
check('C4 admin.js has no AES-GCM', !/['"]AES-GCM['"]/.test(admin));
check('C4 admin.js has no subtle.decrypt', !/subtle\s*\.\s*decrypt\s*\(/.test(admin));
check('C4 admin.js has no DPS1 magic', !/0x44,\s*0x50,\s*0x53,\s*0x31/.test(admin));

const a = admin.indexOf('// REPORT-SEAL-BEGIN'), z = admin.indexOf('// REPORT-SEAL-END');
if (a < 0 || z < 0) {
	check('admin.js has the REPORT-SEAL block', false, 'no REPORT-SEAL markers: the console opens with its own JS');
	console.log(checks + ' checks, ' + failures + ' failed');
	process.exit(1);
}

const mod = await loadSeal();
let loads = 0;
const win = { atob: (s) => Buffer.from(String(s), 'base64').toString('binary') };
const verifyReport = new Function('window', 'atob', 'rpLoadSeal',
	admin.slice(a, z) + '\nreturn verifyReport;')(win, win.atob, async () => { loads++; return mod; });

// The keys the vectors were sealed to that the fixtures hold the secret of.
const js = vec('js');
const held = new Map([[js.identity.seal_pub, js.identity.seal_sk]]);
for (const k of js.keys) held.set(k.pub, k.sk);

const PK8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
function agree(skHex, pub) {
	const privateKey = createPrivateKey({ key: Buffer.concat([PK8, unhex(skHex)]), format: 'der', type: 'pkcs8' });
	const publicKey = createPublicKey({ key: Buffer.concat([SPKI, pub]), format: 'der', type: 'spki' });
	return new Uint8Array(diffieHellman({ privateKey, publicKey }));
}

/// The content key of a DPS1 record, through the app's own open (as the recipient's device
/// derives the key it hands over in a report).
function contentKey(r) {
	const sealed = unb64(r.sealed);
	const to = r.to.find((p) => held.has(p));
	if (!to) return null;
	const shared = agree(held.get(to), mod.seal_post_epk(sealed));
	return mod.seal_post_open(sealed, shared, unhex(to)).slice(0, 32);
}

const report = (env, art, ck) => ({ envelope: b64(env), artefact: b64(art), ckey: b64(ck) });

let opened = 0;
for (const set of ['wasm', 'rust', 'js']) {
	for (const r of vec(set).records.filter((x) => x.kind === 'dps1')) {
		const ck = contentKey(r);
		check('a held key opens ' + set + ' ' + r.name, ck !== null);
		if (!ck) continue;
		const env = unb64(r.sealed), art = unb64(r.plain);

		const good = await verifyReport(report(env, art, ck));
		check('C1 the console checks ' + set + ' ' + r.name + ' good', good.ok === true, good.why);
		if (good.ok) opened++;

		if (set !== 'wasm') continue;
		const flip = (at) => { const e = env.slice(); e[at] ^= 0x01; return e; };
		const refused = async (name, rep, code) => {
			const out = await verifyReport(rep);
			check('C2 ' + name + ' ' + r.name + ' refused as ' + code,
				out.ok === false && out.code === code, JSON.stringify(out));
		};
		await refused('a flipped body byte', report(flip(env.length - 1), art, ck), 'damaged');
		await refused('a flipped head byte', report(flip(5), art, ck), 'damaged');
		const wrong = ck.slice(); wrong[0] ^= 0x80;
		await refused('a wrong key', report(env, art, wrong), 'damaged');
		await refused('a truncated record', report(env.slice(0, 40), art, ck), 'short');
		await refused('a wrong tag', report(flip(0), art, ck), 'not_sealed');
		await refused('a short key', report(env, art, ck.slice(0, 31)), 'bad_key');

		const other = new Uint8Array(art.length + 1);
		const out = await verifyReport(report(env, other, ck));
		check('C3 ' + r.name + ' opening to something else is refused', out.ok === false && out.code === 'else', JSON.stringify(out));
	}
}
check('the console reached the wasm seal', loads > 0);
check('C1 opened at least the six wasm DPS1 vectors', opened >= 6, String(opened));

console.log('consoleseal: the console checked ' + opened + ' DPS1 vectors through the wasm seal; '
	+ checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
