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
			async keys() { return Array.from(m.keys()).map(function (url) { return { url }; }); },
			async delete(u) { return m.delete(typeof u === 'string' ? u : u.url); },
		};
	}
	return {
		store,
		async keys() { return Array.from(store.keys()); },
		// A turn of the event loop, as real Cache Storage takes: work the worker
		// defers behind it runs after the page has read its answer.
		async open(n) { await new Promise(setImmediate); if (!store.has(n)) store.set(n, new Map()); return cache(n); },
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
		clients: { async claim() {}, async matchAll() { return (self.open || []).map(function (id) { return { id }; }); } },
		open: null,	// the client ids a test says are still open; null leaves pins unpruned
	};
	const ctx = {
		self, caches, URL, URLSearchParams, Response, Promise, Date, Number, String, isNaN, console,
		fetch: async function (r) { return basic(net(typeof r === 'string' ? r : r.url)); },
	};
	vm.runInNewContext(SRC, ctx);
	on.self = self;
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

async function navigate(on, client) {
	return (await ask(on, ORIG, { mode: 'navigate', resultingClientId: client || '' })).text();
}

/// One fetch event, as the browser dispatches it, settled with its hold.
async function ask(on, url, o) {
	let res, hold = Promise.resolve();
	on.fetch({
		request: { url, method: 'GET', mode: o.mode || 'no-cors' },
		clientId: o.clientId || '',
		resultingClientId: o.resultingClientId || '',
		waitUntil(p) { hold = p; },
		respondWith(p) { res = p; },
	});
	// The page reads the body the moment it is answered, before the hold settles,
	// as a browser does: a worker that clones after that loses what it meant to store.
	const r = await res;
	const body = await r.arrayBuffer();
	await hold;
	return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}

/// A subresource the page `client` asks for: its status and body.
async function sub(on, path, client) {
	const r = await ask(on, ORIG + path, { clientId: client });
	return { status: r.status, body: await r.text(), why: r.headers.get('x-daimond-shell') };
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

// ── UNBLOCK-97/98: one load never mixes builds ────────────────────────────────
// His phone booted a document of the new build (js/page/apppaths.js an ES module)
// with the old build's scripts beside it: a build.json blip left the worker
// naming the old build while the new document came off the network, so the new
// document was filed in the old build's cache; offline it came back with old
// scripts and no apppaths.js, and the page died on ReferenceError DaimondAppPaths.

/// Seed a whole build's cache: its document and the scripts it loads.
async function seedBuild(caches, build, files, at) {
	const c = await caches.open('daimond-shell-' + build);
	await c.put(ORIG + 'index.html', new Response('<html>' + build + '</html>'));
	for (const f of files) await c.put(ORIG + f, new Response(f + '@' + build));
	await c.put(ORIG + '.daimond-at', new Response(String(at)));
}

test('a document fetched while build.json is unreachable is never filed under another build', async function () {
	const caches = cacheStorage();
	await seedBuild(caches, 'old', ['js/daimond.js'], 1000);	// no js/page/apppaths.js: it is new
	let mode = 'down';
	const on = boot(caches, function (u) {
		if (mode === 'down' || u.endsWith('build.json')) throw new TypeError('Failed to fetch');
		if (u === ORIG) return new Response('<html>new</html>');
		return new Response(u.slice(ORIG.length) + '@new');
	});
	let p; on.activate({ waitUntil(x) { p = x; } }); await p;		// offline: takes 'old' as live
	mode = 'blip';								// the server answers, its stamp does not
	assert.equal(await navigate(on, 'tab1'), '<html>new</html>');
	assert.equal((await sub(on, 'js/page/apppaths.js', 'tab1')).body, 'js/page/apppaths.js@new');
	mode = 'down';
	// Offline again: the reload is the old build whole, its own document with its own scripts.
	assert.equal(await navigate(on, 'tab2'), '<html>old</html>');
	assert.equal((await sub(on, 'js/daimond.js', 'tab2')).body, 'js/daimond.js@old');
	// The file the old build never had is refused out loud, not answered by another build.
	const miss = await sub(on, 'js/page/apppaths.js', 'tab2');
	assert.equal(miss.status, 504);
	assert.equal(miss.why, 'not-in-build old');
});

test('offline, a page of one build is never answered from a later build\'s cache', async function () {
	const caches = cacheStorage();
	let build = 'a', up = true;
	const on = boot(caches, function (u) {
		if (!up) throw new TypeError('Failed to fetch');
		if (u.endsWith('build.json')) return new Response(JSON.stringify({ build }));
		if (u === ORIG) return new Response('<html>' + build + '</html>');
		return new Response(u.slice(ORIG.length) + '@' + build);
	});
	assert.equal(await navigate(on, 'tabA'), '<html>a</html>');
	assert.equal((await sub(on, 'js/daimond.js', 'tabA')).body, 'js/daimond.js@a');
	build = 'b';							// a deploy; a second tab opens on it
	assert.equal(await navigate(on, 'tabB'), '<html>b</html>');
	assert.equal((await sub(on, 'js/page/apppaths.js', 'tabB')).body, 'js/page/apppaths.js@b');
	up = false;
	// tabA's lazy import must not be b's file: a's cache is gone, so it is refused.
	const r = await sub(on, 'js/page/apppaths.js', 'tabA');
	assert.equal(r.status, 504);
	assert.notEqual(r.body, 'js/page/apppaths.js@b');
	assert.equal(await caches.has('daimond-shell-a'), false);	// and the swept build is not made again
	// tabB is served whole from its own build.
	assert.equal((await sub(on, 'js/page/apppaths.js', 'tabB')).body, 'js/page/apppaths.js@b');
});

test('a page keeps its build across a worker restart, and a worker inherits its page\'s', async function () {
	const caches = cacheStorage();
	let up = true;
	const net = function (u) {
		if (!up) throw new TypeError('Failed to fetch');
		if (u.endsWith('build.json')) return new Response(JSON.stringify({ build: 'b' }));
		if (u === ORIG) return new Response('<html>b</html>');
		return new Response(u.slice(ORIG.length) + '@b');
	};
	const on = boot(caches, net);
	assert.equal(await navigate(on, 'tab'), '<html>b</html>');
	await sub(on, 'js/engineworker.js', 'tab');
	await sub(on, 'pkg/daimond.js', 'tab');
	up = false;
	const again = boot(caches, net);					// the browser stopped and restarted the worker
	assert.equal((await sub(again, 'pkg/daimond.js', 'tab')).body, 'pkg/daimond.js@b');
	const w = await ask(again, ORIG + 'js/engineworker.js', { clientId: 'tab', resultingClientId: 'wk' });
	assert.equal(await w.text(), 'js/engineworker.js@b');
	assert.equal((await sub(again, 'pkg/daimond.js', 'wk')).body, 'pkg/daimond.js@b');
});

test('a page whose build the worker never learned is refused offline, not guessed', async function () {
	const caches = cacheStorage();
	await seedBuild(caches, 'old', ['js/daimond.js'], 1000);
	const on = boot(caches, OFFLINE);
	const r = await sub(on, 'js/daimond.js', 'stranger');
	assert.equal(r.status, 504);
	assert.equal(r.why, 'build-unknown');
});

test('a closed page\'s pin is dropped when the next page is pinned', async function () {
	const caches = cacheStorage();
	const on = boot(caches, function (u) {
		if (u.endsWith('build.json')) return new Response(JSON.stringify({ build: 'b' }));
		return new Response('<html>b</html>');
	});
	await navigate(on, 'gone');
	on.self.open = ['kept'];
	await navigate(on, 'kept');
	const urls = Array.from(caches.store.get('daimond-shell-b').keys()).filter(function (u) { return u.indexOf('.daimond-client/') >= 0; });
	assert.deepEqual(urls, [ORIG + '.daimond-client/kept']);
});

test('a page load files its document and its files under its build, the page reading as it goes', async function () {
	const caches = cacheStorage();
	const on = boot(caches, function (u) {
		if (u.endsWith('build.json')) return new Response(JSON.stringify({ build: 'b' }));
		if (u === ORIG) return new Response('<html>b</html>');
		return new Response(u.slice(ORIG.length) + '@b');
	});
	await navigate(on, 'tab');
	await sub(on, 'js/daimond.js', 'tab');
	const m = caches.store.get('daimond-shell-b');
	assert.equal(m.get(ORIG + 'index.html') && m.get(ORIG + 'index.html').body, '<html>b</html>');
	assert.equal(m.get(ORIG + 'js/daimond.js') && m.get(ORIG + 'js/daimond.js').body, 'js/daimond.js@b');
});
