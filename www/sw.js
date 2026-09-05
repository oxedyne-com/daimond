/* sw.js — the shell cache, and the reason Daimond can have one at all.
 *
 * Daimond deliberately had NO service worker for a long time, and the reason was
 * sound: a worker is a cache that serves code, and a cache that serves code can
 * serve LAST WEEK'S code to somebody who cannot tell. `js/updater.js` exists to
 * make that impossible -- it polls `build.json`, whose `build` id changes with
 * every deploy, and reloads a tab that has fallen behind. A worker that ignored
 * that would undo it.
 *
 * So this one does not have its own opinion about freshness. It goes to the
 * network for the shell EVERY time, and reads the cache only when the network
 * cannot be reached:
 *
 *   THE NETWORK IS THE SOURCE. THE CACHE IS THE FALLBACK, NAMED AFTER A BUILD,
 *   AND IS ONLY EVER READ WHEN THE SERVER CANNOT BE.
 *
 * This is network-first, deliberately, and it is the whole point: an ordinary
 * open or refresh always loads the build the server is serving right now, with
 * no banner to notice, no button to press, no worker to unregister. There is no
 * grace period and no stale-while-revalidate -- an old build is not served once,
 * briefly, while a new one is fetched. When there is a network, it is not served
 * at all.
 *
 * `build.json` is fetched `no-store` -- and is never itself intercepted, or the
 * whole scheme would be reading its own cache -- on every page load, and again
 * whenever a request comes in on a cold answer. It is what NAMES the cache: the
 * moment its id differs, every cache under the old name is deleted, so the
 * offline store never holds two builds at once. Freshness no longer rests on that
 * check succeeding, though -- the shell is fetched from the network regardless;
 * the check only keeps the fallback tidy.
 *
 * `js/updater.js` also posts each id it reads (it polls anyway, every two
 * minutes and on every focus), so a tab that notices a deploy tells the worker in
 * the same breath as it tells the user. One notion of "which build is live",
 * arrived at by one file, consulted by both.
 *
 * WHAT IS CACHED: the shell only -- the document, the stylesheets, the scripts,
 * the wasm, the fonts, the icons, the locale tables. Every one of those is a
 * public, sealed artefact: `verify/manifest.json` carries a SHA-256 for each and
 * `dev/repro-check.sh` proves the served bundle is the published source. Nothing
 * a user has typed, nothing a model has said, nothing from `/api/`, and not
 * `build.json`, `manifest.json` or `releases.json` -- the three files whose whole
 * job is to say what the server is doing right now.
 *
 * OFFLINE: the cache is read only when the network fails. If a shell fetch
 * cannot complete, the last shell this device saw the server offer is served from
 * the cache under the last id that WAS seen. That is not stale code being hidden
 * -- it is the most recent build this device ever saw, and the alternative is an
 * app that will not open on a train. The instant the network answers again the
 * shell is fetched fresh, and a moved build empties the old cache.
 *
 * IN DEVELOPMENT the cache is off. On a dev server the files change constantly
 * and the build id does not move at all, so a build-keyed cache would serve an
 * editor's last save for ever. The rule is by host, and `?cache=on` on the
 * worker's own script URL turns it back on -- which is how `dev/verify_pwa.mjs`
 * proves the caching rules on a loopback server, and the only thing that flag can
 * do is switch on what production has anyway.
 *
 * This file is served, so it is sealed with everything else: `verify/lib.mjs`
 * walks `www/` and excludes only the files named there, none of which is this
 * one. A worker whose bytes were not in the transparency manifest would be the
 * one piece of Daimond nobody could check.
 */
'use strict';

/// Where the app lives, taken from where this file lives, so a deployment under
/// a sub-path needs no edit here.
const BASE = new URL('./', self.location.href);

const PREFIX   = 'daimond-shell-';	// one cache per build id
const STAMP    = 'build.json';		// the same staleness file js/updater.js reads
const FRESH_MS = 30000;			// how long an answer about the live build stands

/// Cache off on a dev server, unless the script URL asks for it. See the header.
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);
const FORCED   = new URLSearchParams(self.location.search).get('cache') === 'on';
const SHELL    = !LOOPBACK || FORCED;

/// The shell: the files a cold start needs, all of them sealed and public.
const SHELL_DIRS = ['css/', 'js/', 'i18n/', 'fonts/', 'assets/', 'pkg/'];

/// Never, whatever else matches.
///
/// `api/` and `webhook/` are the gateway: a user's mail, their spend, their
/// model traffic. `vendor/` and `console/` are not part of the sealed client.
const NEVER_DIRS = ['api/', 'webhook/', 'vendor/', 'console/'];

/// Never, by name. The first three are the files that say what the server is
/// doing NOW, and a cached answer to that question is a wrong answer; `sw.js` is
/// this file, whose updates the browser handles itself.
const NEVER_FILES = ['build.json', 'manifest.json', 'releases.json', 'sw.js'];

let live = null;	// the build id last seen at the server
let seen = 0;		// when it was seen, ms

/// The path relative to the app root, or null for anything outside it.
///
/// A query means a different resource, and none of the shell files has one -- so
/// `js/thing.js?v=2` goes to the network rather than matching the entry for
/// `js/thing.js`. A NAVIGATION is the exception, and has to be: `daimond.app/`
/// and `daimond.app/?anything` are the same document, the query is app state, and
/// judging a page load by its query would leave the document alone uncached and
/// unchecked -- which is precisely the request the build check matters most for.
function rel(url, isNav) {
	if (url.search && !isNav) return null;
	const here = url.origin + url.pathname;
	if (!here.startsWith(BASE.href)) return null;
	return here.slice(BASE.href.length);
}

/// Is this one of the shell files?
function isShell(p) {
	if (p === null) return false;
	if (p === '' || p === 'index.html') return true;
	if (NEVER_FILES.indexOf(p) >= 0) return false;
	if (NEVER_DIRS.some(function (d) { return p.indexOf(d) === 0; })) return false;
	return SHELL_DIRS.some(function (d) { return p.indexOf(d) === 0; });
}

/// The cache key for a shell path. The document is stored once, under the name
/// it has, so a visit to `/` and a visit to `/index.html` are the same entry.
function key(p) { return BASE.href + (p === '' ? 'index.html' : p); }

/// Drop every shell cache that is not this build's.
async function sweep(keep) {
	const names = await caches.keys();
	await Promise.all(names
		.filter(function (n) { return n.indexOf(PREFIX) === 0 && n !== PREFIX + keep; })
		.map(function (n) { return caches.delete(n); }));
}

/// Take `b` as the live build. A DIFFERENT id empties the cupboard before it is
/// recorded, so there is no instant at which `live` names a build whose
/// predecessor's files are still reachable.
async function adopt(b) {
	if (b !== live) {
		await sweep(b);
		live = b;
	}
	seen = Date.now();
}

/// Ask the server which build is live. Null on any failure, and `live` is then
/// left exactly as it was -- see OFFLINE in the header.
async function stamp() {
	try {
		const r = await fetch(new URL(STAMP, BASE).href, { cache: 'no-store' });
		if (!r.ok) return null;
		const j = await r.json();
		const b = (j && typeof j.build === 'string' && j.build) ? j.build : null;
		if (b) await adopt(b);
		return b;
	} catch (e) {
		return null;			// offline, or no stamp deployed: say nothing
	}
}

/// Put a fetched shell file away under the build that was live when it was
/// asked for -- and only if that is still the live build once it has arrived. A
/// deploy landing mid-load must not leave two builds' files in one cache.
async function store(p, res, at) {
	if (live !== at) return;
	if (!res || !res.ok || res.type !== 'basic') return;
	if ((res.headers.get('cache-control') || '').indexOf('no-store') >= 0) return;
	const c = await caches.open(PREFIX + at);
	await c.put(key(p), res);
	if (live !== at) await caches.delete(PREFIX + at);
}

/// A shell request: the network every time, the cache only when the network
/// cannot be reached. Network-first -- so a plain open, a refresh or a hard
/// refresh always loads the build the server is serving now, with no banner and
/// no unregister dance. See the header.
///
/// `done` releases the hold the fetch handler took on the event's lifetime; it is
/// called on every path, including the failing ones, or the worker is kept alive
/// by a promise nothing will settle.
async function serve(req, p, done) {
	try {
		// A page load is when the build id is re-checked; everything else on that
		// page rides on the answer until it goes cold. This no longer gates
		// freshness -- the shell is fetched below regardless -- it only keeps the
		// offline cache named after the live build and sweeps old ones.
		if (req.mode === 'navigate' || Date.now() - seen > FRESH_MS) await stamp();

		const at = live;
		try {
			const res = await fetch(req);
			// Squirrel the fresh copy away for offline, under the build that was
			// live when it was asked for; store() drops it if a deploy has since
			// moved on. A non-ok response (a 404, say) is returned as-is, not cached.
			if (at) store(p, res.clone(), at).then(done, done); else done();
			return res;
		} catch (netErr) {
			// Only here does the cache speak: the network failed, so serve the last
			// shell this device saw the server offer. Guarded on its own -- a
			// browser with no usable Cache Storage (some private modes, a full disk)
			// must surface the network error, not take the whole app down with it.
			if (live) {
				try {
					const c = await caches.open(PREFIX + live);
					const hit = await c.match(key(p));
					if (hit) { done(); return hit; }
				} catch (e) { /* no store to read from; the failure stands */ }
			}
			done();
			throw netErr;
		}
	} catch (e) {
		done();
		throw e;
	}
}

self.addEventListener('install', function () {
	// Straight to active. A waiting worker would mean the page and the worker
	// disagreeing about which build is live, which is the one thing this file
	// exists to prevent; and taking over changes nothing a page has already
	// loaded, because the cache only ever holds the build that is live anyway.
	self.skipWaiting();
});

self.addEventListener('activate', function (ev) {
	ev.waitUntil((async function () {
		await self.clients.claim();
		await stamp();			// know the build before serving a byte
	})());
});

self.addEventListener('fetch', function (ev) {
	if (!SHELL) return;			// dev: pass everything through, untouched
	const req = ev.request;
	if (req.method !== 'GET') return;
	let url;
	try { url = new URL(req.url); } catch (e) { return; }
	if (url.origin !== self.location.origin) return;
	const p = rel(url, req.mode === 'navigate');
	if (!isShell(p)) return;
	// The hold on the event's lifetime is taken HERE, while the event is being
	// dispatched, because that is the only moment `waitUntil` is valid -- the put
	// that needs it happens several awaits later, by which time the browser would
	// refuse and the cache would quietly stay empty.
	let done;
	ev.waitUntil(new Promise(function (r) { done = r; }));
	ev.respondWith(serve(req, p, done));
});

self.addEventListener('message', function (ev) {
	const d = ev.data;
	if (!d || !d.type) return;
	// A page's banner "Reload" asks the worker it is handing over to to take
	// control at once rather than sit in `waiting` until every tab has closed.
	// `install` already self-skips, so a new worker rarely waits; this is the
	// belt to that braces, and the one thing a page can do to force the handover
	// on a browser that parked the new worker anyway. See js/pwa.js freshenWorker.
	if (d.type === 'skipWaiting') { self.skipWaiting(); return; }
	// js/updater.js has just read build.json, no-store, for its own purposes.
	// Taking its answer is what makes "the build identity" one thing rather than
	// two, and means a deploy noticed by a foreground tab empties the cache at
	// once rather than at the next navigation.
	if (d.type === 'daimond-build' && typeof d.build === 'string' && d.build) {
		ev.waitUntil(adopt(d.build));
		return;
	}
	// What the worker believes, for anything that needs to ask rather than infer
	// -- dev/verify_pwa.mjs does, and so does a bug report from a phone.
	if (d.type === 'daimond-sw-state' && ev.ports && ev.ports[0]) {
		const port = ev.ports[0];
		ev.waitUntil(caches.keys().then(function (names) {
			port.postMessage({
				shell: SHELL,
				live:  live,
				seen:  seen,
				caches: names.filter(function (n) { return n.indexOf(PREFIX) === 0; }),
			});
		}));
	}
});
