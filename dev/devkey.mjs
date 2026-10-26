// The one place a dev tool finds its provider key (DEV-KEY, HATE-11).
//
// The key FILE comes from the one dev key config, $DAIMOND_DEVKEY or
// ~/.config/oxedyne/daimond-dev/devkey.jdat (outside every tree, so one entry serves every
// lane and rc's orbudget, which reads it through ~/usr/code/bash/devkey). No dev script names
// a key path of its own; the config names each file by absolute path, never a key. Before
// this, eleven scripts and orbudget each carried their own key path, and
// when that key expired every one of them failed in its own way, one of them silently.
//
// Loud by design: a missing entry, an unreadable or empty file, and a key OpenRouter answers 401
// all throw, naming the file and the fix. There is no fallback and there never may be -- a
// default that lets an example "just work" is how a live key reached a public repository on
// 2026-07-10. The key itself is never printed; `fingerprint` gives its last four characters.
//

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function configFile() {
	return process.env.DAIMOND_DEVKEY || path.join(os.homedir(), '.config/oxedyne/daimond-dev/devkey.jdat');
}

/// The absolute key file the entry `name` names.
export function keyFile(name = 'openrouter', cfg = configFile()) {
	let map;
	try { map = JSON.parse(fs.readFileSync(cfg, 'utf8')); }
	catch (e) {
		throw new Error(`devkey: cannot read the dev key config ${cfg} (${e.code || e.message}). Create it `
			+ '(0700 directory, 0600 file): a JSON map such as {"openrouter": "/abs/path/openrouter.key"}, or set DAIMOND_DEVKEY.');
	}
	const v = map[name];
	if (typeof v !== 'string' || !v.trim()) {
		throw new Error(`devkey: ${cfg} has no "${name}" entry. Add one naming the key file, e.g. `
			+ `"${name}": "~/.config/oxedyne/<app>/<name>.key".`);
	}
	if (!path.isAbsolute(v.trim())) throw new Error(`devkey: "${name}" in ${cfg} is not an absolute path.`);
	return v.trim();
}


export function fingerprint(key) { return `…${String(key).slice(-4)}`; }

/// The key from the first set variable in `env`, else from the configured file. Synchronous,
/// so it cannot ask OpenRouter; `devKey` adds that.
export function readDevKey(name = 'openrouter', env = []) {
	for (const v of env) {
		const k = (process.env[v] || '').trim();
		if (k) return k;
	}
	const file = keyFile(name);
	let text;
	try { text = fs.readFileSync(file, 'utf8'); }
	catch (e) {
		throw new Error(`devkey: cannot read the ${name} key file ${file} (${e.code || e.message}). `
			+ `Install one there (0600, in a 0700 directory), or point "${name}" in ${configFile()} `
			+ `at a working one${env.length ? `, or set ${env[0]}` : ''}.`);
	}
	const key = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
	if (!key) throw new Error(`devkey: ${file} holds no key -- every line is empty or a comment.`);
	return key;
}

/// Does OpenRouter take the key? Throws on a 401 or 403, naming the file; a network failure is
/// left to the caller's own first call, which will say so.
export async function checkDevKey(key, name = 'openrouter', { fetch: f = globalThis.fetch } = {}) {
	if (!name.endsWith('openrouter')) return;
	let r;
	try {
		r = await f('https://openrouter.ai/api/v1/key',
			{ headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
	} catch (e) { return; }
	if (r.status === 401 || r.status === 403) {
		throw new Error(`devkey: OpenRouter answers ${r.status} for the ${name} key ${fingerprint(key)} `
			+ `from ${keyFile(name)} -- expired or revoked. Replace that file with a live key, or point `
			+ `"${name}" in ${configFile()} at one.`);
	}
}

/// `readDevKey` and then `checkDevKey`: what a script about to spend wants.
export async function devKey(name = 'openrouter', env = [], opts = {}) {
	const key = readDevKey(name, env);
	await checkDevKey(key, name, opts);
	return key;
}
