/* ============================================================
   Test -- two pages loaded in the same millisecond mint two page ids (UNBLOCK-96, U96-F3c).

   A page's id names its writer lock `daimond-writer-<page id>` and every note it leaves
   (src/wasm/store_opfs.rs), so two tabs sharing one would each take the other's notes for its own.
   The id was the load millisecond and a count from zero, the same in two tabs loaded together.
   Here the clock of two pages is held at one millisecond while each loads the real wasm and does
   the same first acts, and the page ids their writer locks carry must differ.  Two profiles, so
   the Diamond each makes at that instant cannot collide in one store: the mint is the page's own.

   Run:   node --test www/js/u96pageid.test.mjs     (needs www/pkg built: bash dev/pagesuite.sh does it)
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
const AT     = 1790000000000;				// fixed: any one millisecond, the same in both pages

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

// A page whose clock reads AT until its first acts are done, then this page's writer lock ids.
async function pageAt(ctx) {
	await ctx.addInitScript((at) => {
		const real = Date.now;
		self.__at = at;
		Date.now = () => (self.__at === null ? real() : self.__at);
	}, AT);
	await serve(ctx);
	const pg = await ctx.newPage();
	await pg.goto(ORIGIN + '/');
	return pg.evaluate(async (pre) => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		await mod.default();
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const id = await app.create_diamond('Same');
		await app.set_tags(id, JSON.stringify(['a']));
		self.__at = null;
		const s = await navigator.locks.query();
		return [...(s.held || []), ...(s.pending || [])].map((l) => l.name).filter((n) => n.startsWith(pre)).map((n) => n.slice(pre.length));
	}, LOCK);
}

test('two pages loaded in one millisecond hold two writer locks under two page ids', { timeout: 120000 }, async () => {
	const scratch = join(os.homedir(), '.cache/daimond');
	mkdirSync(scratch, { recursive: true });
	const profiles = [mkdtempSync(join(scratch, 'u96pageid-')), mkdtempSync(join(scratch, 'u96pageid-'))];
	const shell = firstThatOpens([HEADLESS_SHELL]);
	const ctxs = [];
	try {
		const ids = [];
		for (const profile of profiles) {
			const ctx = await chromium.launchPersistentContext(profile, { headless: true, executablePath: shell });
			ctxs.push(ctx);
			const held = await pageAt(ctx);
			assert.equal(held.length, 1, 'a page does not hold one writer lock: ' + JSON.stringify(held));
			ids.push(held[0]);
		}
		assert.notEqual(ids[0], ids[1], 'two pages loaded in one millisecond minted one page id: ' + ids[0]);
		for (const id of ids) assert.match(id, /^[0-9a-f]+$/, 'a page id is not hex, so a note name cannot be split on "-": ' + id);
	} finally {
		for (const ctx of ctxs) await ctx.close().catch(() => {});
		for (const p of profiles) rmSync(p, { recursive: true, force: true });
	}
});
