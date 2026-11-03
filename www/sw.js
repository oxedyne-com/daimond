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
 * A worker the browser has just started knows no id, and the server may not
 * answer. It then takes the NEWEST cache as live (each is marked when its build
 * was adopted) and deletes the rest, on activate as well as on the first offline
 * fetch. Before 28 Oct it read no cache at all in that state, and an old build's
 * cache that no answered stamp had swept outlived seventeen releases and booted
 * on a reload (UNBLOCK-55).
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

/// Where each build's cache records when this device last took it as live. Not a
/// shell path, so it is never served; it is what lets a worker that has just
/// started, with no network and no memory, tell the newest cache from an old one.
const MARK = new URL('.daimond-at', BASE).href;

/// When a cache's build was last live here: its mark, else the server's `Date` on
/// its document (a cache written before marks existed), else 0.
async function takenAt(name) {
	try {
		const c = await caches.open(name);
		const m = await c.match(MARK);
		if (m) return Number(await m.text()) || 0;
		const d = await c.match(key(''));
		const t = d ? Date.parse(d.headers.get('date') || '') : NaN;
		return isNaN(t) ? 0 : t;
	} catch (e) { return 0; }
}

/// The build id of the newest shell cache this device holds, or null.
async function newest() {
	const names = (await caches.keys()).filter(function (n) { return n.indexOf(PREFIX) === 0; });
	let best = null, at = -1;
	for (const n of names) {
		const t = await takenAt(n);
		if (t > at) { best = n; at = t; }
	}
	return best ? best.slice(PREFIX.length) : null;
}

/// With the server unreachable, take the newest cache as live and drop the rest.
/// Ranked every time rather than trusting `live`: a worker that has just started
/// remembers nothing, and one kept alive by a busy tab may remember a build a
/// later instance has moved past. Without this an old build's cache outlived
/// every deploy that ran while no stamp was answered.
async function recall() {
	const b = await newest();
	if (b) { await sweep(b); live = b; }
	return live;
}

/// Take `b` as the live build. A DIFFERENT id empties the cupboard before it is
/// recorded, so there is no instant at which `live` names a build whose
/// predecessor's files are still reachable.
async function adopt(b) {
	if (b !== live) {
		await sweep(b);
		live = b;
		try {
			const c = await caches.open(PREFIX + b);
			await c.put(MARK, new Response(String(Date.now())));
		} catch (e) { /* no store: there is nothing to rank either */ }
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

/// Which build each client's document came from: client id → build id, or ''
/// when the worker could not tell. A page and every file it loads must be one
/// build (UNBLOCK-97/98): his phone booted a new document beside the old build's
/// scripts, and died on a name only the new scripts defined. So a client is
/// pinned when its document is served, every later file it asks for is filed
/// and recalled under that pin alone, and a pin is written into its build's own
/// cache as well, because a browser stops an idle worker within seconds and a
/// lazy import may come after the restart. The pin goes when its build's cache
/// is swept, which is right: that build's files went with it.
const PIN  = new URL('.daimond-client/', BASE).href;
const pins = new Map();

/// Pin `id` to build `b` (null: the build is not known).
async function pin(id, b) {
	if (!id) return;
	pins.set(id, b || '');
	if (!b) return;
	try {
		const c = await caches.open(PREFIX + b);
		await c.put(PIN + encodeURIComponent(id), new Response(b));
		await prune(c, id);
	} catch (e) { /* no store: the pin lives as long as this worker */ }
}

/// Drop the pins of clients that have closed, so a build's cache does not
/// collect one entry per page load for as long as the build is live. `id` is
/// kept whatever the list says: a client being created is not in it yet.
async function prune(c, id) {
	const open = new Set((await self.clients.matchAll({ includeUncontrolled: true, type: 'all' }))
		.map(function (k) { return PIN + encodeURIComponent(k.id); }));
	open.add(PIN + encodeURIComponent(id));
	for (const r of await c.keys()) {
		if (r.url.indexOf(PIN) === 0 && !open.has(r.url)) await c.delete(r);
	}
}

/// The build client `id` is pinned to: '' when it is not known.
async function pinOf(id) {
	if (!id) return '';
	if (pins.has(id)) return pins.get(id);
	try {
		for (const n of await caches.keys()) {
			if (n.indexOf(PREFIX) !== 0) continue;
			const c = await caches.open(n);
			if (await c.match(PIN + encodeURIComponent(id))) {
				const b = n.slice(PREFIX.length);
				pins.set(id, b);
				return b;
			}
		}
	} catch (e) { /* no store to look in */ }
	return '';
}

/// Put a fetched shell file away under the build it belongs to -- and only if
/// that is still the live build once it has arrived. A deploy landing mid-load
/// must not leave two builds' files in one cache.
async function store(p, res, at) {
	if (!at || live !== at) return;
	if (!res || !res.ok || res.type !== 'basic') return;
	if ((res.headers.get('cache-control') || '').indexOf('no-store') >= 0) return;
	const c = await caches.open(PREFIX + at);
	await c.put(key(p), res);
	if (live !== at) await caches.delete(PREFIX + at);
}

/// The answer when the network has failed and the file is not in the cache of
/// the build its page came from. Said out loud -- a 504 naming why, and a line in
/// the console -- rather than a bare network error or a file from another build:
/// another build's file is how one page ends up running two.
function refuse(p, why) {
	try { console.warn('daimond sw: offline and ' + p + ' is ' + why); } catch (e) {}
	return new Response('', { status: 504, statusText: 'Offline: not in this build', headers: { 'x-daimond-shell': why } });
}

/// A shell request: the network every time, the cache only when the network
/// cannot be reached. Network-first -- so a plain open, a refresh or a hard
/// refresh always loads the build the server is serving now, with no banner and
/// no unregister dance. See the header.
///
/// THE BUILD OF A LOAD. A document's build is the stamp the server answered for
/// that very navigation, never a remembered `live`: a stamp that fails while the
/// document arrives leaves `live` naming the previous build, and filing the new
/// document there is what booted his phone on two builds. Every other file is of
/// the build its client (`cid`) was pinned to, and a worker script's new client
/// (`rid`) inherits its page's pin.
///
/// `done` releases the hold the fetch handler took on the event's lifetime; it is
/// called on every path, including the failing ones, or the worker is kept alive
/// by a promise nothing will settle.
async function serve(req, p, done, cid, rid) {
	try {
		const nav = req.mode === 'navigate';
		// A page load is when the build id is re-checked; everything else on that
		// page rides on the answer until it goes cold. This does not gate
		// freshness -- the shell is fetched below regardless -- it names the build
		// a document belongs to and sweeps old caches.
		let asked = null;
		if (nav || Date.now() - seen > FRESH_MS) asked = await stamp();
		const at = nav ? asked : await pinOf(cid);
		if (rid && !nav) await pin(rid, at);
		try {
			const res = await fetch(req);
			// Squirrel the fresh copy away for offline, under the build it belongs
			// to; store() drops it if a deploy has since moved on, and files nothing
			// whose build is not known. A non-ok response is returned as-is.
			// Cloned NOW: once `res` is handed back the page reads its body, and a
			// clone taken after that throws, leaving the document never stored.
			const copy = res.clone();
			const kept = nav ? pin(rid, at) : Promise.resolve();
			kept.then(function () { return store(p, copy, at); }).then(done, done);
			return res;
		} catch (netErr) {
			// Only here does the cache speak, and only the cache of the build this
			// load is: a page and its files never come from two. Guarded on its
			// own -- a browser with no usable Cache Storage (some private modes, a
			// full disk) must surface the network error, not take the app down.
			let b = at;
			if (nav) {
				// No page yet: the build is the newest this device holds, whole.
				try { b = await recall(); } catch (e) { b = null; }
			}
			if (!b) { done(); return refuse(p, 'build-unknown'); }
			let hit;
			try {
				// `has` first: opening a swept build's name would create it again, empty.
				if (await caches.has(PREFIX + b)) hit = await (await caches.open(PREFIX + b)).match(key(p));
			} catch (e) { done(); throw netErr; }
			if (!hit) { done(); return refuse(p, 'not-in-build ' + b); }
			if (nav) await pin(rid, b);
			done();
			return hit;
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
		// Know the build before serving a byte, and empty every older build's
		// cache NOW: from the server when it answers, else by keeping only the
		// newest this device holds. Either way one build's shell survives.
		if (!(await stamp())) await recall();
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
	ev.respondWith(serve(req, p, done, ev.clientId, ev.resultingClientId));
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
