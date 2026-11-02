// scopereentry.test.mjs -- no exclusive borrow of the engine spans an await (ENGINE-REENTRY).
//
//	node --test www/js/scopereentry.test.mjs
//	REENTRY_PKG=/path/to/www/pkg node --test www/js/scopereentry.test.mjs	# against a given build
//
// wasm-bindgen holds a `&mut self` method's borrow of the whole `DaimondApp` until its future
// ends. `set_diamond_scope` was async and read the marks inside it, so the Agents panel redrawing
// a tile during `spawn_agent` read `live_prompt_tokens` mid-call and threw "recursive use of an
// object detected which would lead to unsafe aliasing in rust" (daimond-rig, verify_agents on
// r568, 1 run in 2). It is now one synchronous call on the id alone (D-20261031-11).

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

test("set_diamond_scope scopes from the id alone, synchronously, and refuses a second argument", { skip: !existsSync(join(PKG, 'oxedyne_daimond_bg.wasm')) && 'no www/pkg wasm here' }, async () => {
	shimPage();
	const m = await import(join(PKG, 'oxedyne_daimond.js'));
	m.initSync({ module: readPage(join(PKG, 'oxedyne_daimond_bg.wasm')) });
	const mk = () => new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'test-model', 4096, '', true);
	const app = mk();
	const id = '0da1000000e1';
	// Nothing to await, so no borrow spans a getter's read (D-20261031-11: the reach is the id's).
	assert.equal(app.set_diamond_scope(id), undefined);
	let threw = null;
	try { void app.live_prompt_tokens; void app.live_completion_tokens; } catch (e) { threw = String(e); }
	assert.equal(threw, null, 'the getter threw: ' + threw);
	const got = JSON.parse(app.diamond_scope());
	assert.deepEqual(got.write_allow, ['diamonds/' + id]);
	assert.equal(got.nowhere, false);
	assert.equal('toolkits' in got, false, 'no toolchain is granted per Diamond');
	// The old toolkits argument is refused plainly, never ignored.
	assert.throws(() => mk().set_diamond_scope(id, '[]'));
	assert.equal(typeof app.read_scope_reach, 'undefined');
});

// SCOPE BY ID (D-20261031-11): the engine builds a Diamond's reach from its id, and refuses the
// old second (toolkits) argument. Every caller in dev/*.mjs and www/js hands `set_diamond_scope`
// one argument. The 4-argument page-asserted form (`'diamonds/' + id, marks, …`) predates
// HIST-SAFE U2 and was refused long since; the probes still carrying it are frozen below, so a
// NEW stale caller anywhere fails here.
const DEV = join(HERE, '..', '..', 'dev');
const JSDIR = HERE;
const PRE_U2 = new Set([
	'e5bprobe_store.mjs', 'e5probe_mint.mjs', 'q5probe_launder.mjs', 'q5probe_launder_hand.mjs',
	'r51bprobe_store.mjs', 'r51cprobe_store.mjs', 'r51dprobe_store.mjs', 'r51hdprobe_hand.mjs',
	'r51probe_store.mjs', 'r51qa_hand.mjs', 'r51qa_more.mjs', 'r51qa_store.mjs', 'r51qb_attack.mjs',
	'r51qc_hand.mjs', 'r51qc_handguard.mjs', 'r51qc_store.mjs',
	'r52hrprobe_hand.mjs', 'r52hrqa2_hand.mjs', 'r52hrqa3_hand.mjs',
	'r52hrqa3_sync.mjs', 'r52hrqa_hand.mjs', 'verify_handmeterless.mjs', 'verify_scope.mjs',
]);

export function staleScopeCalls(name, src) {
	const bad = [];
	const lines = src.split('\n');
	lines.forEach((line, i) => {
		const t = line.replace(/\/\/.*$/, '');
		for (const m of t.matchAll(/\.set_diamond_scope\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
			const args = m[1];
			if (PRE_U2.has(name) && /^\s*'diamonds\//.test(args)) continue;
			// One argument: no comma outside a nested call.
			if (args.replace(/\([^()]*\)/g, '').indexOf(',') < 0) continue;
			bad.push(name + ':' + (i + 1) + ' set_diamond_scope(' + args.trim() + ')');
		}
	});
	return bad;
}

test('every dev/ and www/js caller hands set_diamond_scope the id alone', () => {
	const bad = [];
	for (const [dir, ext] of [[DEV, /\.mjs$/], [JSDIR, /\.m?js$/]]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (!ext.test(name) || name === 'scopereentry.test.mjs') continue;
			bad.push(...staleScopeCalls(name, readPage(join(dir, name), 'utf8')));
		}
	}
	assert.deepEqual(bad, [], 'set_diamond_scope given more than the id: ' + bad.join('; '));
});

test('the scan itself catches the stale forms', () => {
	assert.equal(staleScopeCalls('x.mjs', "await e.set_diamond_scope(id, '[]');").length, 1);
	assert.equal(staleScopeCalls('x.mjs', "e.set_diamond_scope(String(id), NO_KITS);").length, 1);
	assert.equal(staleScopeCalls('x.mjs', "e.set_diamond_scope(String(id));").length, 0);
	assert.equal(staleScopeCalls('x.mjs', "e.set_diamond_scope('diamonds/' + id, '[]', '[]', '[]');").length, 1);
});
