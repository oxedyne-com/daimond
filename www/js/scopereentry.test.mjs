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

import { readPage } from '../../dev/pagesrc.mjs';
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
		const src = readPage(f, 'utf8');
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
	m.initSync({ module: readPage(join(PKG, 'oxedyne_daimond_bg.wasm')) });
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

// SCOPEREACH (18 Oct 2026): b3c06a03 split the call and updated only the page, so three dev/
// verifiers still passed a string id and died in `_assertClass` ("expected instance of
// ScopeReach"). Every caller in dev/*.mjs and www/js must hand `set_diamond_scope` a value it
// bound from `read_scope_reach`. The 4-argument page-asserted form (`'diamonds/' + id, marks,
// …`) predates HIST-SAFE U2 and was refused before the split; the files still carrying it are
// frozen below, so a NEW stale caller anywhere fails here.
const DEV = join(HERE, '..', '..', 'dev');
const JSDIR = HERE;
const PRE_U2 = new Set([
	'e5bprobe_store.mjs', 'e5probe_mint.mjs', 'q5probe_launder.mjs', 'q5probe_launder_hand.mjs',
	'r51bprobe_store.mjs', 'r51cprobe_store.mjs', 'r51dprobe_store.mjs', 'r51hdprobe_hand.mjs',
	'r51probe_store.mjs', 'r51qa_hand.mjs', 'r51qa_more.mjs', 'r51qa_store.mjs', 'r51qb_attack.mjs',
	'r51qc_hand.mjs', 'r51qc_handguard.mjs', 'r51qc_store.mjs', 'r522hk1_tabs.mjs',
	'r52hrprobe_hand.mjs', 'r52hrqa2_hand.mjs', 'r52hrqa2_sync.mjs', 'r52hrqa3_hand.mjs',
	'r52hrqa3_sync.mjs', 'r52hrqa_hand.mjs', 'verify_handmeterless.mjs', 'verify_scope.mjs',
]);

export function staleScopeCalls(name, src) {
	const bad = [];
	const reaches = new Set();
	for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?[^;\n]*\.read_scope_reach\s*\(/g)) reaches.add(m[1]);
	const lines = src.split('\n');
	lines.forEach((line, i) => {
		const t = line.replace(/\/\/.*$/, '');
		for (const m of t.matchAll(/\.set_diamond_scope\s*\(\s*([^,)]*)/g)) {
			const first = m[1].trim();
			if (reaches.has(first)) continue;
			if (PRE_U2.has(name) && /^'diamonds\//.test(first)) continue;
			bad.push(name + ':' + (i + 1) + ' set_diamond_scope(' + first + ', …)');
		}
	});
	return bad;
}

test('every dev/ and www/js caller hands set_diamond_scope a read_scope_reach result', () => {
	const bad = [];
	for (const [dir, ext] of [[DEV, /\.mjs$/], [JSDIR, /\.m?js$/]]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (!ext.test(name) || name === 'scopereentry.test.mjs') continue;
			bad.push(...staleScopeCalls(name, readPage(join(dir, name), 'utf8')));
		}
	}
	assert.deepEqual(bad, [], 'set_diamond_scope given something other than a ScopeReach: ' + bad.join('; '));
});

test('the scan itself catches the stale forms', () => {
	assert.equal(staleScopeCalls('x.mjs', "await e.set_diamond_scope(id, '[]');").length, 1);
	assert.equal(staleScopeCalls('x.mjs', "e.set_diamond_scope(String(id), '[]');").length, 1);
	assert.equal(staleScopeCalls('x.mjs', "const r = await e.read_scope_reach(String(id));\ne.set_diamond_scope(r, '[]');").length, 0);
	assert.equal(staleScopeCalls('x.mjs', "e.set_diamond_scope('diamonds/' + id, '[]', '[]', '[]');").length, 1);
});
