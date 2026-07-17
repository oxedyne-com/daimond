// verify/ext/fingerprint.js — the Daimond bundle fingerprint, carried by the
// extension itself.
//
// This is a deliberate copy of the algorithm in verify/lib.mjs, NOT a shared
// import from the site. That is the whole point of the extension: its copy of
// the check is installed from source and cannot be touched by the server it is
// checking. verify/verify.test.mjs asserts this file agrees, byte-for-byte,
// with verify/lib.mjs and www/js/verify.js — three implementations that must
// compute the identical hash, or none of them verifies anything.
//
// Uses the global Web Crypto (SubtleCrypto), present in a service worker and in
// Node 20+, so the same file runs under the extension and under the tests.

export const GENESIS_PREV = '0'.repeat(64);

export async function sha256(bytes) {
	const buf = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256str(str) {
	return sha256(new TextEncoder().encode(str));
}

export function manifestText(files) {
	const rels = Object.keys(files).sort();
	let s = '';
	for (const rel of rels) s += rel + '\n' + files[rel] + '\n';
	return s;
}

export async function bundleHash(files) {
	return sha256str(manifestText(files));
}

export async function entryHash(e) {
	return sha256str(e.seq + '|' + e.ts + '|' + e.build + '|' + e.bundle + '|' + e.prev);
}

export async function verifyChain(entries) {
	let prev = GENESIS_PREV;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e.seq !== i)     return { ok: false, error: 'entry ' + i + ' out of order' };
		if (e.prev !== prev) return { ok: false, error: 'entry ' + i + ' does not chain on ' + (i - 1) };
		if (e.entry !== await entryHash(e)) return { ok: false, error: 'entry ' + i + ' hash mismatch' };
		prev = e.entry;
	}
	return { ok: true, error: '' };
}
