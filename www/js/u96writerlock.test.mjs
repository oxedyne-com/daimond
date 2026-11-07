/* ============================================================
   Test -- a waiting .part is another tab's while that tab holds its writer lock (UNBLOCK-96, U96-F3/F3b).

   Each tab holds the Web Lock `daimond-writer-<page id>` for its life (src/wasm/store_opfs.rs), and the
   holder of a Diamond's version store removes a `.part` in its metawait folder only when no tab holds or
   asks for the lock of the page that began it (`page_is_running`). Two real tabs of one browser, one
   origin, the real wasm: tab A lays down a `.part` under its own page id, tab B takes the version hold
   (a tag change) and A's file stays while a dead page's goes; A is closed, and B's next hold removes it.

   Run:   node --test www/js/u96writerlock.test.mjs     (needs www/pkg built: bash dev/pagesuite.sh does it)
   ============================================================ */
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, HEADLESS_SHELL, firstThatOpens } from '../../dev/pw.mjs';

const HERE   = dirname(fileURLToPath(import.meta.url));
const WWW    = join(HERE, '..');
const ORIGIN = 'http://localhost:8';		// fixed: routed below, never dialled
const TYPES  = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const LOCK   = 'daimond-writer-';			// fixed: store_opfs.rs WRITER_LOCK

// Every request to ORIGIN is answered from www/, and `/` by a blank page.
async function serve(ctx) {
	await ctx.route(ORIGIN + '/**', async (route) => {
		const p = new URL(route.request().url()).pathname;
		if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>u96</title>' });
		const file = normalize(join(WWW, p));
		if (!file.startsWith(WWW)) return route.fulfill({ status: 403, body: '' });
		try {
			return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
		} catch (e) {
			return route.fulfill({ status: 404, body: '' });
		}
	});
}

// A tab with the engine loaded and its app made.
async function tab(ctx) {
	const pg = await ctx.newPage();
	await pg.goto(ORIGIN + '/');
	await pg.evaluate(async () => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		await mod.default();
		window.__app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	});
	return pg;
}

// The writer locks held or asked for in the origin, as page ids.
const writers = (pg) => pg.evaluate(async (pre) => {
	const s = await navigator.locks.query();
	return [...(s.held || []), ...(s.pending || [])].map((l) => l.name).filter((n) => n.startsWith(pre)).map((n) => n.slice(pre.length));
}, LOCK);

// The names in Diamond `id`'s metawait folder, laying down `make` there first.
const metawait = (pg, id, make) => pg.evaluate(async ({ id, make }) => {
	const find = async (dir, depth) => {
		for await (const [n, h] of dir.entries()) {
			if (h.kind !== 'directory') continue;
			if (n === id) return h;
			if (depth < 4) { const f = await find(h, depth + 1); if (f) return f; }
		}
		return null;
	};
	const home = await find(await navigator.storage.getDirectory(), 0);
	if (!home) throw new Error('no folder for the Diamond ' + id);
	const v = await home.getDirectoryHandle('versions', { create: true });
	const w = await v.getDirectoryHandle('metawait', { create: true });
	for (const n of make) {
		const f = await (await w.getFileHandle(n, { create: true })).createWritable();
		await f.write('a line half written'); await f.close();
	}
	const names = [];
	for await (const [n] of w.entries()) names.push(n);
	return names.sort();
}, { id, make });

test('a .part stays while its tab holds the writer lock, and goes with the next hold once it is closed', { timeout: 120000 }, async () => {
	const scratch = join(os.homedir(), '.cache/daimond');
	mkdirSync(scratch, { recursive: true });
	const profile = mkdtempSync(join(scratch, 'u96writerlock-'));
	const shell = firstThatOpens([HEADLESS_SHELL]);
	let ctx = null;
	try {
		ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: shell });
		await serve(ctx);
		const A = await tab(ctx);
		const id = await A.evaluate(async () => {
			const id = await window.__app.create_diamond('Lock');
			await window.__app.set_tags(id, JSON.stringify(['a']));
			return id;
		});
		const held = await writers(A);
		assert.equal(held.length, 1, 'tab A does not hold one writer lock: ' + JSON.stringify(held));
		const pageA = held[0];
		const B = await tab(ctx);
		const partA = pageA + '-1-0.part', dead = 'deadpage-1-0.part';
		assert.deepEqual(await metawait(A, id, [partA, dead]), [dead, partA].sort(), 'the files were not laid down');

		// B's hold: the dead page's file goes (the hold ran), A's stays.
		await B.evaluate((id) => window.__app.set_tags(id, JSON.stringify(['b1'])), id);
		let left = await metawait(B, id, []);
		assert.ok(!left.includes(dead), 'B\'s hold did not remove a dead page\'s .part, so it never ran: ' + JSON.stringify(left));
		assert.ok(left.includes(partA), 'B\'s hold removed a .part of live tab A: ' + JSON.stringify(left));

		// A closes; the browser lets its lock go; B's next hold removes A's file.
		await A.close();
		let gone = false;
		for (let i = 0; i < 50 && !gone; i++) {
			gone = !(await writers(B)).includes(pageA);
			if (!gone) await B.waitForTimeout(100);
		}
		assert.ok(gone, 'tab A\'s writer lock outlived the tab');
		await B.evaluate((id) => window.__app.set_tags(id, JSON.stringify(['b2'])), id);
		left = await metawait(B, id, []);
		assert.ok(!left.includes(partA), 'a closed tab\'s .part was left to pile up: ' + JSON.stringify(left));
	} finally {
		if (ctx) await ctx.close().catch(() => {});
		rmSync(profile, { recursive: true, force: true });
	}
});
