// gateway: none
// probe_u98swbuild.mjs -- UNBLOCK-98: with the app's service worker running, one page load
// never mixes two builds, in two browsers of one world.
//
// His phone (2 Nov 2026, build 892c3ad90a85) booted a new document beside the old build's
// scripts. The worker filed a document under whichever build it last remembered, so a
// build.json blip while the new document arrived put it in the OLD build's cache; offline,
// that cache answered with the new document, the old scripts and no js/page/apppaths.js.
//
// The two builds are told apart by the routes below, on the context so they see the
// worker's own fetches (Chromium): build.json names the build of the phase, the document
// carries `<meta name="u98" content="<build>">`, and js/page/apppaths.js a `/* u98 <build> */`
// line. "Offline" aborts every request, the worker's included.
//
//   browser 1  his phone's case: build old cached, a stamp blip while the new document
//              loads, then offline. The old build's cache must still hold the old
//              document, and the offline reload must be the old build whole.
//   browser 2  two clients: tab A on build a, a deploy, a frame B on build b (which
//              sweeps a), then offline. tab A's next file must not be build b's.
//
// Run in a world of its own, worker allowed:
//   eval "$(bash dev/world.sh N --up)"; DAIMOND_SW=allow node dev/probe_u98swbuild.mjs
// To prove it red, run the same probe in a world on a worktree of the base commit.

import { open } from './harness.mjs';


/// A browser whose network is a set of phases this run switches between.
async function browser(label) {
	const st = { build: null, stamp: true, down: false, bare: false };
	const route = async (page) => {
		const ctx = page.context();
		await ctx.route('**/*', async (r) => {
			const u = new URL(r.request().url());
			if (st.down) return r.abort('internetdisconnected');
			if (u.pathname.endsWith('/build.json')) {
				if (!st.stamp) return r.abort('connectionfailed');
				return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ build: st.build }) });
			}
			if (u.pathname === '/' || u.pathname.endsWith('/index.html')) {
				// A bare document for the second tab: a second full app tab never reached
				// DOMContentLoaded in 30 s here, and only the worker's answer is under test.
				if (st.bare) return r.fulfill({ status: 200, contentType: 'text/html', headers: { 'cache-control': 'no-cache' }, body: `<!doctype html><html><head><meta name="u98" content="${st.build}"></head><body></body></html>` });
				const res = await r.fetch();
				const body = (await res.text()).replace('<head>', `<head><meta name="u98" content="${st.build}">`);
				return r.fulfill({ response: res, body });
			}
			if (u.pathname.endsWith('/js/page/apppaths.js')) {
				if (st.build === 'u98-old') return r.fulfill({ status: 404, body: '' });	// the old build had none
				const res = await r.fetch();
				return r.fulfill({ response: res, body: `/* u98 ${st.build} */\n` + await res.text() });
			}
			return r.fallback();
		});
	};
	const s = await open({ browser: 'chromium', serviceWorkers: 'allow', signIn: false, connect: false, defaults: false, route });
	return { s, st, label };
}

const APP = process.env.DAIMOND_APP;

/// Load the page with the caching worker in control of it.
async function controlled(page) {
	await page.goto(APP + '/?cache=on', { waitUntil: 'load' });
	await page.waitForFunction(() => navigator.serviceWorker.controller && /cache=on/.test(navigator.serviceWorker.controller.scriptURL), null, { timeout: 20000 });
	await page.reload({ waitUntil: 'load' });		// this load goes through the worker
	await page.waitForTimeout(1500);			// its stores settle
}

const meta = (page) => page.evaluate(() => { const m = document.querySelector('meta[name=u98]'); return m ? m.content : null; });

/// A shell file the page asks for: status, its build line, and the worker's reason.
const ask = (page, f) => page.evaluate(async (f) => {
	try {
		const r = await fetch(f);
		const t = await r.text();
		const m = /\/\* u98 (\S+) \*\//.exec(t);
		return { status: r.status, build: m ? m[1] : null, why: r.headers.get('x-daimond-shell') };
	} catch (e) { return { status: 'threw ' + e.name, build: null, why: null }; }
}, f);

/// The document a build's cache holds, by its meta.
const cachedDoc = (page, b) => page.evaluate(async (b) => {
	if (!(await caches.has('daimond-shell-' + b))) return 'no cache';
	const r = await (await caches.open('daimond-shell-' + b)).match(new URL('index.html', location.href).href);
	if (!r) return 'no document';
	const m = /<meta name="u98" content="([^"]*)">/.exec(await r.text());
	return m ? m[1] : 'unmarked';
}, b);

let ok = true;
const check = (label, pass, got) => { ok = ok && pass; console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}: ${got}`); };

// ── Browser 1: his phone's case ──────────────────────────────────────────────
{
	const { s, st } = await browser('phone');
	const p = s.page;
	st.build = 'u98-old';
	await controlled(p);
	check('1. old build loads through the worker', await meta(p) === 'u98-old', await meta(p));
	console.log('       worker: ' + JSON.stringify(await p.evaluate(async () => ({
		state: await window.DaimondPWA.state(),
		ctl: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL,
		caches: await Promise.all((await caches.keys()).map(async (n) => n + ':' + (await (await caches.open(n)).keys()).map((r) => r.url.replace(location.origin, '')).join(','))),
	}))));
	st.build = 'u98-new'; st.stamp = false;			// a deploy, and build.json does not answer
	await p.reload({ waitUntil: 'load' });
	await p.waitForTimeout(1500);
	check('1. the new document comes off the network', await meta(p) === 'u98-new', await meta(p));
	const filed = await cachedDoc(p, 'u98-old');
	check('1. the old build\'s cache still holds the OLD document', filed === 'u98-old', filed);
	st.down = true;
	await p.reload({ waitUntil: 'load' }).catch(() => {});
	await p.waitForTimeout(1500);
	const doc = await meta(p);
	check('1. offline, the reload is the old build\'s document', doc === 'u98-old', doc);
	const ap = await ask(p, 'js/page/apppaths.js');
	check('1. and a file that build never cached is refused by name, not another build\'s', ap.status === 504 && ap.build === null, JSON.stringify(ap));
	await s.close();
}

// ── Browser 2: two tabs across a deploy ──────────────────────────────────────
{
	const { s, st } = await browser('tabs');
	const a = s.page;
	st.build = 'u98-a';
	await controlled(a);
	const a1 = await ask(a, 'js/page/apppaths.js');
	check('2. tab A on build a', await meta(a) === 'u98-a' && a1.build === 'u98-a', `${await meta(a)} ${JSON.stringify(a1)}`);
	st.build = 'u98-b'; st.bare = true;
	// The second client is a frame of tab A's: a second Playwright page in this
	// context never committed its navigation (30 s, fix and base alike), and a
	// same-origin frame is a client of its own, served by the same worker.
	await a.evaluate(() => new Promise((res) => {
		const f = document.createElement('iframe');
		f.onload = res; f.src = '/?cache=on&u98=b'; document.body.appendChild(f);
	}));
	await a.waitForTimeout(1500);
	const b = a.frames().find((f) => /u98=b/.test(f.url()));
	const b1 = await ask(b, 'js/page/apppaths.js');
	check('2. tab B on build b', await meta(b) === 'u98-b' && b1.build === 'u98-b', `${await meta(b)} ${JSON.stringify(b1)}`);
	st.down = true;
	const a2 = await ask(a, 'js/page/apppaths.js');
	check('2. offline, tab A is never handed build b\'s file', a2.build !== 'u98-b' && a2.status === 504, JSON.stringify(a2));
	const b2 = await ask(b, 'js/page/apppaths.js');
	check('2. and tab B is served whole from its own build', b2.status === 200 && b2.build === 'u98-b', JSON.stringify(b2));
	await s.close();
}

console.log(ok ? 'u98swbuild: PASS' : 'u98swbuild: FAIL');
process.exit(ok ? 0 : 1);
