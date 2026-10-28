/* sw.test.mjs — a fresh worker with two build caches serves the NEWEST, and drops
   the old one (UNBLOCK-55: a reload booted a cache seventeen releases old).

   sw.js is run in a vm with a Cache Storage, a network and the worker events
   faked, so the browser's own case is reproduced: the worker has just been
   started (it remembers no build id) and the server does not answer.

   Run:  node --test www/js/sw.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(process.env.SW_SRC || join(HERE, '..', 'sw.js'), 'utf8');	// SW_SRC: prove red on an old copy
const ORIG = 'https://daimond.app/';

/// A Cache Storage: name → Map(url → { body, headers }).
function cacheStorage() {
	const store = new Map();
	function cache(name) {
		const m = store.get(name);
		return {
			async match(u) {
				const e = m.get(typeof u === 'string' ? u : u.url);
				return e ? new Response(e.body, { headers: e.headers }) : undefined;
			},
			async put(u, res) {
				const h = {}; res.headers.forEach(function (v, k) { h[k] = v; });
				m.set(typeof u === 'string' ? u : u.url, { body: await res.text(), headers: h });
			},
		};
	}
	return {
		store,
		async keys() { return Array.from(store.keys()); },
		async open(n) { if (!store.has(n)) store.set(n, new Map()); return cache(n); },
		async delete(n) { return store.delete(n); },
		async has(n) { return store.has(n); },
	};
}

/// Load sw.js as a just-started worker. `net` answers a URL, or throws (offline).
function boot(caches, net) {
	const on = {};
	const self = {
		location: new URL(ORIG + 'sw.js'),
		addEventListener(t, f) { on[t] = f; },
		skipWaiting() {},
		clients: { async claim() {} },
	};
	const ctx = {
		self, caches, URL, URLSearchParams, Response, Promise, Date, Number, String, isNaN, console,
		fetch: async function (r) { return basic(net(typeof r === 'string' ? r : r.url)); },
	};
	vm.runInNewContext(SRC, ctx);
	return on;
}

/// Seed one build's cache with a document saying which build it is.
async function seed(caches, build, date) {
	const c = await caches.open('daimond-shell-' + build);
	await c.put(ORIG + 'index.html', new Response('<html>' + build + '</html>', { headers: { date } }));
}

/// A same-origin response, as the browser types it; Node's says 'default'.
function basic(r) {
	const c = r.clone.bind(r);
	Object.defineProperty(r, 'type', { value: 'basic' });
	r.clone = function () { return basic(c()); };
	return r;
}

const OFFLINE = function () { throw new TypeError('Failed to fetch'); };

async function navigate(on) {
	let res, hold = Promise.resolve();
	on.fetch({
		request: { url: ORIG, method: 'GET', mode: 'navigate' },
		waitUntil(p) { hold = p; },
		respondWith(p) { res = p; },
	});
	const r = await res; await hold;
	return r.text();
}

test('offline, a fresh worker serves the newest of two build caches and drops the old', async function () {
	const caches = cacheStorage();
	await seed(caches, 'new', 'Tue, 28 Oct 2026 01:00:00 GMT');
	await seed(caches, 'old', 'Sat, 06 Sep 2026 01:00:00 GMT');	// keys() lists it second
	const on = boot(caches, OFFLINE);
	assert.equal(await navigate(on), '<html>new</html>');
	assert.deepEqual(await caches.keys(), ['daimond-shell-new']);
});

test('activate with no server drops every build cache but the newest', async function () {
	const caches = cacheStorage();
	await seed(caches, 'old', 'Sat, 06 Sep 2026 01:00:00 GMT');
	await seed(caches, 'new', 'Tue, 28 Oct 2026 01:00:00 GMT');
	const on = boot(caches, OFFLINE);
	let p; on.activate({ waitUntil(x) { p = x; } }); await p;
	assert.deepEqual(await caches.keys(), ['daimond-shell-new']);
});

test('a reload with the server up adopts its build, sweeps the rest and serves fresh', async function () {
	const caches = cacheStorage();
	await seed(caches, 'old', 'Sat, 06 Sep 2026 01:00:00 GMT');
	const on = boot(caches, function (u) {
		if (u.endsWith('build.json')) return new Response(JSON.stringify({ build: 'live' }));
		return new Response('<html>live</html>');
	});
	assert.equal(await navigate(on), '<html>live</html>');
	assert.equal(await caches.has('daimond-shell-old'), false);
});

test('the adopt mark outranks a cached document date', async function () {
	const caches = cacheStorage();
	// Adopt 'b' online, then go offline with an older-dated 'a' cache beside it
	// whose document claims a later date: the mark, not the date, decides.
	await seed(caches, 'a', 'Tue, 28 Oct 2026 01:00:00 GMT');
	let up = true;
	const on = boot(caches, function (u) {
		if (!up) throw new TypeError('Failed to fetch');
		if (u.endsWith('build.json')) return new Response(JSON.stringify({ build: 'b' }));
		return new Response('<html>b</html>', { headers: { date: 'Sat, 06 Sep 2026 01:00:00 GMT' } });
	});
	assert.equal(await navigate(on), '<html>b</html>');
	await seed(caches, 'a', 'Tue, 28 Oct 2026 01:00:00 GMT');	// a stray old cache reappears
	up = false;
	const fresh = boot(caches, OFFLINE);
	assert.equal(await navigate(fresh), '<html>b</html>');
	assert.deepEqual(await caches.keys(), ['daimond-shell-b']);
});
