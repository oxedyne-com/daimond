/* ============================================================
   Test -- the inline sync budget comes from the door, in encoded bytes (DOORBUDGET, 24 Oct 2026).
   ------------------------------------------------------------
   THE FAULT (diag_doorpush.md). The parcel's inline budget was a fixed 5 MiB of
   `String.length`, spent beside sections nothing subtracted (the chunk index, the
   ledger, the models, the mail), while the door weighs the UTF-8 of the JSON-escaped
   parcel, sealed and base64'd. A phone whose files had filled their hard budget was
   over the 8 MiB door by construction: 8,730,418 bytes of wire at 04:59:22.

   WHAT IS CHECKED:
     A. `doorPlain` is the exact inverse of `wireBytes`: the largest parcel that fits a
        door, against a REAL AES-GCM seal and base64, at padding boundaries.
     B. the room the door leaves beside 972 KB of other sections (his census) is about
        5.32 MB, and `parcelRoom()` is that less what sync.js hung on the last parcel.
     C. the files `collectFiles` carries, counted as the parcel counts them (JSON-escaped
        UTF-8, path and all), never exceed the budget they were handed -- over mail, which
        is where `String.length` and the wire part company.
     D. daimond.js's `jsonBytes` is the same scan as sync.js's `utf8Len`.

     node www/js/doorbudget.test.mjs            # ALL PASS
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
const enc = (s) => new TextEncoder().encode(s).length;

/// A mail-shaped body of `n` code units: CRLF every 76, `="…"` attributes, `—` and `é`.
function mail(i, n) {
	const lines = [
		'<td style=3D"font-family:Arial;color:#333333" class=3D"msg-body">Bonjour',
		'<a href=3D"https://example.com/r?id=3D' + i + '">voilà le résumé</a> — merci',
		'<p class=3D"x" align=3D"left">café, déjà vu — "quoted" and \\ back</p>',
		'Content-Type: text/html; charset=3D"utf-8"; format=3D"flowed" =E2=80=94 ',
	];
	let out = '', k = 0;
	while (out.length < n) out += lines[k++ % lines.length].padEnd(76, ' ').slice(0, 76) + '\r\n';
	return out.slice(0, n);
}

/// sync.js loaded into a bare tab, as synckey.test.mjs does, for its pure arithmetic.
function syncTab() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} }, dataset: {},
	};
	const document = {
		readyState: 'complete', hidden: false, addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	win.DaimondIdentity = { isUnlocked: () => false, handle: () => '', deviceId: () => '00112233445566aa' };
	win.DaimondGateway  = { clientApi: () => 1, state: () => ({ authed: false }), gwFetch: async () => ({ status: 500, json: async () => ({}) }) };
	win.DaimondCore     = { collectSync: async () => ({ v: 3 }), syncSelfDeviceId: () => '00112233445566aa',
		busy: () => false, deviceSelfName: () => 'Chromium on Linux' };
	const body = readFileSync(join(HERE, 'sync.js'), 'utf8');
	const fn = new Function('window', 'document', 'crypto', 'localStorage', 'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'with (window) {\n' + body + '\n}');
	fn(win, document, webcrypto, localStorage, TextEncoder, TextDecoder,
		setTimeout, clearTimeout, () => 0, () => {}, { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return win;
}

/// IV(12) || AES-GCM(plain) || tag(16), base64'd: what identity.js `seal` writes.
async function sealReal(plain) {
	const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
	const iv = webcrypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
	const out = new Uint8Array(iv.length + ct.length);
	out.set(iv, 0); out.set(ct, iv.length);
	return Buffer.from(out).toString('base64');
}

const win = syncTab();
const S = win.DaimondSync;
const F = S.forTest;

console.log('\nA. the door, inverted exactly\n');
{
	check('A0. sync.js exposes doorPlain', typeof F.doorPlain === 'function');
	if (typeof F.doorPlain === 'function') {
		// Doors a few bytes apart, so every base64 residue is crossed; each answer must
		// fit a real seal and one byte more must not.
		const env = 80;
		let exact = true, why = '';
		for (let door = 4000; door < 4012; door++) {
			for (const ov of [0, 1, 2, 137]) {
				const p = F.doorPlain(door, env, ov);
				// With no rekey envelope the REAL seal is the check. With one, the envelope
				// is base64'd together with the seal (`wrapEnvelope`), so the check is the
				// 4/3 of their sum, which is what the real base64 of that buffer weighs.
				const fits = async (n) => ov === 0
					? env + (await sealReal('x'.repeat(n))).length <= door
					: env + Buffer.alloc(n + 28 + ov).toString('base64').length <= door;
				const realOk = (await fits(p)) && !(await fits(p + 1));
				if (!realOk) { exact = false; why += ' door=' + door + ' ov=' + ov + ' p=' + p; }
			}
		}
		check('A1. doorPlain is the largest parcel a real seal fits, at every residue', exact, why.trim() || '48 doors');
		const wenv = F.wireBytes(0) - 4 * Math.ceil(28 / 3);
		const p = F.doorPlain(F.door, wenv, 0);
		check('A2. and agrees with wireBytes at the real door',
			F.wireBytes(p) <= F.door && F.wireBytes(p + 1) > F.door, `p=${p} wire=${F.wireBytes(p)}`);
	}
}

console.log('\nB. the room beside his other sections\n');
{
	check('B0. DaimondSync.parcelRoom is published', typeof S.parcelRoom === 'function');
	if (typeof S.parcelRoom === 'function' && typeof F.doorPlain === 'function') {
		const room = S.parcelRoom();
		const wenv = F.wireBytes(0) - 4 * Math.ceil(28 / 3);
		check('B1. before any parcel, the room is the whole door in plaintext',
			room === F.doorPlain(F.door, wenv, 0), String(room));
		// His census at 04:59:22: k + l + md + o + ml = 972 KB beside the inline sections.
		const left = room - 972 * 1000;
		check('B2. 972 KB of other sections leave about 5.32 MB for the inline three',
			left > 5.30e6 && left < 5.33e6, String(left));
	}
}

console.log('\nC. collectFiles over mail, counted as the parcel counts it\n');
{
	const w = makeWindow();
	w.DaimondChunks = { offloadBytes: () => {} };
	w.DaimondCloud  = { available: () => true, contentGet: () => null, index: () => ({}) };
	const N = 10, PER = 100 * 1024;
	const names = Array.from({ length: N }, (_, i) => 'f' + i + '.eml');
	const bodies = Object.fromEntries(names.map((n, i) => [n, mail(i, PER)]));
	const app = {
		run_tool_outcome: async (tool) => tool === 'file_list'
			? { outcome: 'done', text: names.map((n) => n + '  (' + PER + ' bytes)').join('\n') }
			: { outcome: 'done', text: '' },
	};
	const { collectFiles } = sliceDaimond(w, ['collectFiles'], {
		syncWalkPlan:       async () => ({ app, folder: null }),
		syncFileAt:         async (plan, full) => new File([bodies[full]], full, { lastModified: 0 }),
		offloadConfirmed:   () => false,
		isMobileDeviceSelf: () => false,
		syncAppState:       () => false,
		parseSyncListing:   () => names.map((name) => ({ name, size: PER, dir: false })),
	}).fns;
	// Five files' worth of code units and a little over: `String.length` admits five,
	// whose JSON-UTF-8 is well past it.
	for (const budget of [5 * PER + 1000, 3 * PER + 7, 777777]) {
		const col = await collectFiles(budget);
		const wire = enc(JSON.stringify(col.files));
		const n = Object.keys(col.files).length;
		check(`C1. budget ${budget}: the carried files weigh no more than it in JSON-UTF-8`,
			wire <= budget, `${n} files, ${wire} B, counted ${col.bytes}`);
		check(`C2. budget ${budget}: and what did not fit is HELD, so the census is incomplete`,
			n < N && col.held > 0 && col.complete === false, `held=${col.held} complete=${col.complete}`);
	}
}

console.log('\nD. one scan\n');
{
	const w = makeWindow();
	const { jsonBytes } = sliceDaimond(w, ['jsonBytes'], {}).fns;
	const samples = ['', 'ascii', 'café — 日本語', 'a\u{1F600}b', 'a\uD83Db', 'a\uDE00b', JSON.stringify(mail(3, 4000))];
	const bad = samples.filter((s) => jsonBytes(s) !== F.utf8Len(s) || jsonBytes(s) !== enc(s));
	check('D1. jsonBytes and utf8Len agree with TextEncoder on every sample', !bad.length,
		bad.length ? bad.map((s) => JSON.stringify(s).slice(0, 20)).join(', ') : samples.length + ' samples');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
