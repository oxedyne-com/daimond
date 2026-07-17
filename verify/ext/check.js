// verify/ext/check.js — verify a served Daimond origin, from the extension.
//
// The extension fetches the served manifest and every file it lists FROM THE
// SITE, and the transparency log from GitHub — a different origin the site does
// not control. Because this code is installed, not served, a tampered server
// cannot tamper with the check itself. That is what makes the extension the
// trustworthy, always-on form of "check the code your browser is running".

import * as fp from './fingerprint.js';

/// The public log, on an origin the checked site does not control. Overridable
/// (chrome.storage `logUrl`) so a fork can point at its own, and so tests can
/// serve a local copy.
export const DEFAULT_LOG =
	'https://raw.githubusercontent.com/oxedyne-com/daimond/main/verify/transparency.jsonl';

/// Verify the build served at `origin`. Returns
///   { ok, failed, build, bundle, checks: [{ name, ok, detail }] }
/// where a check's `ok` is true/false, or null when it could not run (offline).
export async function verifyOrigin(origin, logUrl) {
	logUrl = logUrl || DEFAULT_LOG;
	const checks = [];
	const add = (name, ok, detail) => checks.push({ name, ok, detail: detail || '' });

	let manifest;
	try {
		manifest = await (await fetch(origin + '/manifest.json', { cache: 'no-store' })).json();
	} catch (e) {
		add('manifest', false, 'this site served no manifest.json — it cannot be checked');
		return verdict(checks, null);
	}

	// The manifest's bundle hash is the hash of its own file list.
	add('manifest self-consistent', (await fp.bundleHash(manifest.files)) === manifest.bundle,
		'the bundle hash matches the file list');

	// The one that counts: the served bundle is a sealed entry in the public,
	// hash-chained log — fetched from GitHub, which this site does not control.
	try {
		const text = await (await fetch(logUrl, { cache: 'no-store' })).text();
		const entries = text.split('\n').map(l => l.trim()).filter(Boolean).map(JSON.parse);
		const chain = await fp.verifyChain(entries);
		if (!chain.ok) {
			add('public transparency log', false, 'the public log is not an intact chain: ' + chain.error);
		} else {
			const sealed = entries.some(e => e.bundle === manifest.bundle);
			add('sealed in the public log', sealed,
				sealed ? entries.length + ' releases on record'
					: 'this served bundle was never published');
		}
	} catch (e) {
		add('public transparency log', null, 'could not reach the public log (offline?)');
	}

	// Every served file hashes to what the manifest says.
	const bad = [];
	for (const rel of Object.keys(manifest.files)) {
		try {
			const res = await fetch(origin + '/' + rel, { cache: 'no-store' });
			const got = await fp.sha256(new Uint8Array(await res.arrayBuffer()));
			if (got !== manifest.files[rel]) bad.push(rel);
		} catch (e) { bad.push(rel + ' (unreadable)'); }
	}
	add('every served file matches the manifest', bad.length === 0,
		bad.length ? bad.length + ' differ: ' + bad.slice(0, 6).join(', ')
			: Object.keys(manifest.files).length + ' files');

	return verdict(checks, manifest);
}

function verdict(checks, manifest) {
	const failed  = checks.some(c => c.ok === false);
	const unknown = checks.some(c => c.ok === null);
	return {
		ok:     !failed && !unknown,
		failed: failed,
		build:  manifest ? manifest.build : '',
		bundle: manifest ? manifest.bundle : '',
		checks: checks,
	};
}
