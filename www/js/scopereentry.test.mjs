// scopereentry.test.mjs -- no exclusive borrow of the engine spans an await (ENGINE-REENTRY).
//
//	node --test www/js/scopereentry.test.mjs
//	REENTRY_PKG=/path/to/www/pkg node --test www/js/scopereentry.test.mjs	# against a given build
//
// wasm-bindgen holds a `&mut self` method's borrow of the whole `DaimondApp` until its future
// ends. `set_diamond_scope` was async and read the marks inside it, so the Agents panel redrawing
// a tile during `spawn_agent` read `live_prompt_tokens` mid-call and threw "recursive use of an
// object detected which would lead to unsafe aliasing in rust" (daimond-rig, verify_agents on
// r568, 1 run in 2). The read is now an async `&self` call and the mutation a synchronous one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src', 'wasm');
const PKG = process.env.REENTRY_PKG || join(HERE, '..', 'pkg');

function rustFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...rustFiles(p));
		else if (name.endsWith('.rs')) out.push(p);
	}
	return out;
}

test('no exported async method in src/wasm takes &mut self', () => {
	const bad = [];
	const re = /pub\s+async\s+fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(\s*&\s*(?:'\w+\s+)?mut\s+self/g;
	for (const f of rustFiles(SRC)) {
		const src = readFileSync(f, 'utf8');
		for (const m of src.matchAll(re)) bad.push(f.slice(SRC.length + 1) + ': ' + m[1]);
	}
	assert.deepEqual(bad, [], 'async `&mut self` exports hold the whole engine across an await: ' + bad.join(', '));
});

// The page the engine reads its marks from: an unlocked identity, an empty record, and an OPFS
// root that answers late, so the read is genuinely pending when the getter is called.
function shimPage() {
	const ls = new Map([['daimond-marks-here', '{"v":1,"d":{}}']]);
	globalThis.Window = class { static [Symbol.hasInstance]() { return true; } };
	globalThis.window = globalThis;
	globalThis.DaimondIdentity = { isUnlocked: () => true };
	globalThis.localStorage = {
		getItem: k => (ls.has(k) ? ls.get(k) : null),
		setItem: (k, v) => ls.set(k, String(v)),
		removeItem: k => ls.delete(k),
	};
	const nf = () => { const e = new Error('not found'); e.name = 'NotFoundError'; return Promise.reject(e); };
	const dir = { getDirectoryHandle: nf, getFileHandle: nf, entries: async function* () {}, values: async function* () {}, keys: async function* () {} };
	Object.defineProperty(globalThis, 'navigator', {
		value: { storage: { getDirectory: () => new Promise(r => setTimeout(() => r(dir), 50)) } },
		configurable: true,
	});
}

test("a tile's getter answers while a Diamond's scope is being read", { skip: !existsSync(join(PKG, 'oxedyne_daimond_bg.wasm')) && 'no www/pkg wasm here' }, async () => {
	shimPage();
	const m = await import(join(PKG, 'oxedyne_daimond.js'));
	m.initSync({ module: readFileSync(join(PKG, 'oxedyne_daimond_bg.wasm')) });
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'test-model', 4096, '', true);
	const id = '0da1000000e1';
	// A build from before the split has only the one async call; it is the one that threw.
	const split = typeof app.read_scope_reach === 'function';
	const pending = split ? app.read_scope_reach(id) : app.set_diamond_scope(id, '[]');
	await new Promise(r => setTimeout(r, 5));			// inside the late OPFS answer
	let threw = null;
	try { void app.live_prompt_tokens; void app.live_completion_tokens; } catch (e) { threw = String(e); }
	const reach = await pending;
	assert.equal(threw, null, 'the getter threw mid-read: ' + threw);
	if (split) app.set_diamond_scope(reach, '[]');
	const got = JSON.parse(app.diamond_scope());
	assert.deepEqual(got.write_allow, ['diamonds/' + id]);
	assert.equal(got.nowhere, false);
	// The reach is spent by the apply: the same one cannot scope a second app.
	if (split) {
		const other = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'test-model', 4096, '', true);
		assert.throws(() => other.set_diamond_scope(reach, '[]'));
	}
});
