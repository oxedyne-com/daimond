// verify_pwa.mjs — Daimond is installable, and the cache that makes it possible
// cannot serve a build the server has moved past.
//
// Pinning Daimond to a home screen used to give a Safari bookmark: no manifest,
// no icons, no worker. Adding those is routine. The part that is not routine is
// that a service worker is a cache that serves CODE, and Daimond's whole update
// story is that there is no such thing -- `js/updater.js` polls `build.json` so a
// tab can never sit on last week's app without being told. A worker that ignored
// that would quietly undo it, and a user stuck on an old build who cannot tell is
// worse than no PWA at all.
//
// So one check here carries all the others:
//
//   THE WORKER SERVES THE SHELL FROM THE NETWORK, NOT ITS CACHE.
//
// The worker is network-first: an ordinary open, refresh or hard refresh always
// loads the build the server is serving now, and the cache speaks only when the
// network cannot be reached. It is asked at the network, on a server this file
// owns and can watch: the shell is served, a warm reload is proved to fetch the
// document, stylesheet and script from the SERVER (so freshness never rests on a
// build-id check succeeding), the network is then cut and the app must still open
// from the held shell (so the cache is a real offline fallback), and finally the
// build id is moved and the next load must fetch everything again with the old
// cache swept. Each half is a different failure: serving the cache first is how a
// user gets stuck on last week's build; holding nothing is an app that will not
// open on a train.
//
// The rest:
//
//   * the manifest is linked, parses, and is `app.webmanifest` -- `manifest.json`
//     is the TRANSPARENCY manifest and was never available;
//   * every icon it names exists and is the size it claims, measured from the
//     PNG header rather than from the file name;
//   * a maskable icon really is inside the 80% safe circle, measured in pixels,
//     with the measurement proved on an image that is not;
//   * no `/api/` path, and not `build.json`, is ever put in a cache -- the second
//     is fatal on its own, since the worker reads that file to decide;
//   * the worker, the manifest and the icons are covered by the seal, so the
//     bytes of the thing that serves the bytes are checkable too;
//   * and the frame holds the hardware off its contents in standalone mode,
//     where there is no browser chrome doing it for you.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a real file to the real page and the run is then
// expected to FAIL; a break whose anchor does not match exactly once aborts,
// because a check proved against code that was never broken is not proved.
//
//   node dev/verify_pwa.mjs --break manifest  # the document links no manifest
//   node dev/verify_pwa.mjs --break icons     # an icon lies about its size
//   node dev/verify_pwa.mjs --break register  # nothing registers the worker
//   node dev/verify_pwa.mjs --break stale     # THE ONE: a moved build is ignored
//   node dev/verify_pwa.mjs --break api       # the worker caches /api/
//   node dev/verify_pwa.mjs --break tokens    # the safe-area tokens are not env()
//   node dev/verify_pwa.mjs --break safearea  # the frame ignores the tokens
//   node dev/verify_pwa.mjs --break sealed    # the worker is left out of the seal
//   node dev/verify_pwa.mjs                   # and then, clean
//
//   eval "$(bash dev/world.sh 8 --up)"
//   node dev/verify_pwa.mjs
//
// THE SERVER IS THIS FILE'S OWN, not the world's, and not `page.route`. Three
// reasons, all of them about the worker: a worker's own fetches do not go through
// `page.route`, so the interception every other verifier uses cannot see the
// traffic that matters here; the build id has to MOVE mid-run, and `build.json`
// is a tracked file no test may rewrite; and the request log of a server is the
// only honest way to ask "did that come from the cache or from you?". It listens
// on port 0, so it cannot collide with another lane. The world is still used --
// for its scratch directory, and because that is where a browser belongs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it.
const BREAKS = {
	// The document no longer declares a manifest, so nothing is installable.
	manifest: [{
		file: 'index.html',
		find: '<link rel="manifest" href="app.webmanifest">',
		with: '<!-- no manifest -->',
	}],
	// An icon that claims a size it is not. iOS picks by the declared size and
	// then scales, so the mark arrives soft and nobody can say why.
	icons: [{
		file: 'app.webmanifest',
		find: '{ "src": "assets/icons/icon-192.png", "sizes": "192x192"',
		with: '{ "src": "assets/icons/icon-192.png", "sizes": "512x512"',
	}],
	// Nothing registers the worker: a manifest and icons alone give an app that
	// installs and then cannot start without the network.
	register: [{
		file: 'js/pwa.js',
		find: '\t\tif (!window.isSecureContext) return;',
		with: '\t\tif (!window.isSecureContext) return;\n\t\tif (true) return;',
	}],
	// THE FAILURE THIS FILE EXISTS FOR, and it is the ordinary way a PWA is
	// written: one cache under a fixed name, filled on first sight and read from
	// for ever. The build id is still read, and still ignored, so a phone goes on
	// running last week's app with nothing to show that it is.
	stale: [
		{
			file: 'sw.js',
			find: '\tif (b !== live) {\n\t\tawait sweep(b);\n\t\tlive = b;\n\t}',
			with: '\tif (b !== live) {\n\t\tlive = b;\n\t}',
		},
		{
			file: 'sw.js',
			find: '\t\t\tconst c = await caches.open(PREFIX + live);',
			with: "\t\t\tconst c = await caches.open(PREFIX + 'any');",
		},
		{
			file: 'sw.js',
			find: '\tconst c = await caches.open(PREFIX + at);',
			with: "\tconst c = await caches.open(PREFIX + 'any');",
		},
	],
	// The worker treats the gateway as part of the shell. A user's mail, their
	// spend and their model traffic go into a cache on disk, and a stale answer
	// is served for one of them.
	api: [
		{
			file: 'sw.js',
			find: "const SHELL_DIRS = ['css/', 'js/', 'i18n/', 'fonts/', 'assets/', 'pkg/'];",
			with: "const SHELL_DIRS = ['css/', 'js/', 'i18n/', 'fonts/', 'assets/', 'pkg/', 'api/'];",
		},
		{
			file: 'sw.js',
			find: "const NEVER_DIRS = ['api/', 'webhook/', 'vendor/', 'console/'];",
			with: "const NEVER_DIRS = ['webhook/', 'vendor/', 'console/'];",
		},
	],
	// The tokens exist but are not fed by the platform, so they are nought on a
	// phone and the whole safe area is a decoration that measures right in a test
	// and does nothing on the device.
	tokens: [{
		file: 'css/variables.css',
		find: '\t--safe-t:            env(safe-area-inset-top, 0px);',
		with: '\t--safe-t:            0px;',
	}],
	// The frame ignores them: the old padding, back as it was, with the top bar
	// under the status bar. BOTH frames -- a phone in portrait is under the
	// narrow breakpoint and takes responsive.css's rule, and turned on its side
	// it is 852px wide and takes app.css's. Breaking one leaves the other doing
	// the job, and the run would rightly stay green for half the screen.
	safearea: [
		{
			file: 'css/app.css',
			find: 'padding: calc(10px + var(--safe-t)) calc(12px + var(--safe-r)) calc(12px + var(--safe-b)) calc(12px + var(--safe-l));',
			with: 'padding: 10px 12px 12px;',
		},
		{
			file: 'css/responsive.css',
			find: '\t\tpadding: calc(8px + var(--safe-t)) calc(8px + var(--safe-r)) 0 calc(8px + var(--safe-l));',
			with: '\t\tpadding: 8px 8px 0;',
		},
		// And the drawer, which is fixed to the viewport and so takes neither.
		{
			file: 'css/mobile.css',
			find: '\t\tpadding: calc(8px + var(--safe-t)) 8px calc(8px + var(--safe-b)) calc(8px + var(--safe-l));',
			with: '\t\tpadding: 8px;',
		},
	],
};

// `sealed` is not in the table above and cannot be: the file that would have to
// be damaged is `verify/lib.mjs`, the tool the seal is computed with, and a
// verifier that edits its own instrument proves nothing. What is damaged instead
// is the QUESTION -- the covered set is asked for with `sw.js` excluded, which is
// exactly what a future edit to that file's EXCLUDE list would do.
const SEALED_BREAK = BREAK === 'sealed';

if (BREAK && !BREAKS[BREAK] && !SEALED_BREAK) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}, sealed`);
	process.exit(2);
}

/// The damaged source, or a hard stop.
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// The damaged files, by relative path, built once so the anchors are checked
/// before a browser is started.
///
/// Each spec is applied to what the LAST one left, not to the file on disk. A
/// break that edits one file twice -- and two of them do -- otherwise keeps only
/// its final edit, and then runs green while claiming to have broken something.
const DAMAGED = {};
for (const spec of (BREAKS[BREAK] || [])) {
	const src = Object.prototype.hasOwnProperty.call(DAMAGED, spec.file)
		? DAMAGED[spec.file]
		: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	DAMAGED[spec.file] = damaged(src, spec);
}

// ── The server ───────────────────────────────────────────────────────

const TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.json': 'application/json', '.webmanifest': 'application/manifest+json',
	'.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
	'.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

/// Every path asked of the server, in order. This is the oracle: a file that was
/// served from the cache is a file that is not in here.
const hits = [];
const since = () => hits.length;
const asked = (from, p) => hits.slice(from).filter(h => h === p).length;

/// The build id the server is currently on. Moving it is what the whole
/// verifier turns on, and it is why this cannot be the world's dev server.
const state = { build: 'build-one' };

function send(res, status, type, body, cc) {
	res.writeHead(status, { 'content-type': type, 'cache-control': cc });
	res.end(body);
}

const server = http.createServer((req, res) => {
	let p;
	try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
	catch (e) { return send(res, 400, 'text/plain', 'bad path', 'no-store'); }
	hits.push(p);

	// The staleness stamp, served from memory so the test can move it.
	if (p === '/build.json') {
		return send(res, 200, 'application/json',
			JSON.stringify({ build: state.build, note: 'verify_pwa' }), 'no-cache');
	}
	// The one gateway route this needs. Everything else under /api/ answers the
	// way dev/serve.mjs does with no gateway running, which every browser-only
	// verifier already tolerates. `no-cache`, not `no-store`, because that is
	// what Steel stamps a generated response with -- a worker that only kept
	// API responses out because of a header would pass a weaker test.
	if (p === '/api/ping') {
		return send(res, 200, 'application/json', JSON.stringify({ ok: true, at: Date.now() }), 'no-cache');
	}
	if (p.startsWith('/api/') || p.startsWith('/webhook/')) {
		return send(res, 502, 'application/json', JSON.stringify({ error: 'no gateway' }), 'no-store');
	}

	const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
	if (rel.includes('..')) return send(res, 403, 'text/plain', 'no', 'no-store');
	const type = TYPES[path.extname(rel)] || 'application/octet-stream';

	if (Object.prototype.hasOwnProperty.call(DAMAGED, rel)) {
		return send(res, 200, type, DAMAGED[rel], 'no-cache');
	}
	let body;
	try { body = fs.readFileSync(path.join(WWW, rel)); }
	catch (e) { return send(res, 404, 'text/plain', 'not found: ' + rel, 'no-store'); }
	// `no-cache` on everything, which is what Steel serves (srv/cache.rs): a
	// store may hold it and may not use it without asking. The worker's whole
	// design is that BUILD.JSON is what it asks, once, for the lot.
	send(res, 200, type, body, 'no-cache');
});

await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const APP  = `http://127.0.0.1:${PORT}`;
console.log(`serving ${WWW} on ${APP}\n`);

// The harness reads the app's address once, at import, so this is set first.
process.env.DAIMOND_APP = APP;
const { open, shot, scratch, errors, signInAs } = await import('./harness.mjs');

const PROFILE = scratch('pw', 'pwa' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

// ── Measurements that need no browser ────────────────────────────────

/// The pixel size a PNG really is, from its IHDR. The manifest's `sizes` is a
/// claim; this is the file.
function pngSize(file) {
	const b = fs.readFileSync(file);
	if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
	return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/// The app's ground colour, from the stylesheet that defines it. The manifest
/// has to agree with it, or the splash and the app are two different blacks.
function groundColour() {
	const css = fs.readFileSync(path.join(WWW, 'css', 'variables.css'), 'utf8');
	const m = /:root\s*\{[\s\S]*?--bg-primary:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(css);
	return m ? m[1].toLowerCase() : null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const s = await open({ name: 'pwa', profile: PROFILE, signIn: false, connect: false });
const { page } = s;

// The browser's OWN cache is switched off for the whole run. It sits in a
// different place from the worker's -- Chrome will reuse a subresource on a
// reload without asking anybody, which is a perfectly good thing for it to do and
// makes "did that come from the cache or from the server?" unanswerable. With it
// off, every request either reaches the server or was answered by the worker,
// and the request log means exactly what it says. Nothing about the worker's own
// cache is affected.
const cdp = await s.browser.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

try {
	// ── 0. The seal covers the new files ─────────────────────────
	// A worker is code, served from Daimond's origin, and every other served
	// byte is hashed into www/manifest.json and chained in the transparency log.
	// One that was not would be the only part of the client nobody could check.
	{
		const lib = await import('../verify/lib.mjs');
		const exclude = SEALED_BREAK ? new Set([...lib.EXCLUDE, 'sw.js']) : lib.EXCLUDE;
		const covered = new Set(await lib.coveredFiles(WWW, { exclude }));
		const want = [
			'sw.js', 'app.webmanifest', 'js/pwa.js',
			'assets/icons/icon-180.png', 'assets/icons/icon-192.png',
			'assets/icons/icon-512.png', 'assets/icons/maskable-192.png',
			'assets/icons/maskable-512.png',
		];
		const missing = want.filter(f => !covered.has(f));
		check('THE WORKER AND THE MANIFEST ARE SEALED WITH EVERYTHING ELSE',
			missing.length === 0, missing.length ? 'not covered: ' + missing.join(', ') : `${want.length} files`);
	}

	// ── 1. The manifest is linked, and parses ────────────────────
	// The plain URL, which is the one a user has: nothing here needs the cache.
	await page.goto(APP + '/', { waitUntil: 'domcontentloaded' });
	await sleep(1500);

	const link = await page.evaluate(() => {
		const el = document.querySelector('link[rel="manifest"]');
		return el ? { href: el.getAttribute('href'), abs: el.href } : null;
	});
	check('the document links a web app manifest', !!link, link ? link.href : 'no <link rel="manifest">');
	check('and it is app.webmanifest, because manifest.json is the transparency manifest',
		!!link && link.href === 'app.webmanifest', link ? link.href : '—');

	const mf = link ? await page.evaluate(async (href) => {
		try {
			const r = await fetch(href);
			return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
		} catch (e) { return { status: 0, type: '', text: '' }; }
	}, link.href) : { status: 0, type: '', text: '' };

	let man = null;
	try { man = JSON.parse(mf.text); } catch (e) { man = null; }
	check('the manifest is served and parses', mf.status === 200 && !!man,
		`status ${mf.status}, ${mf.text.length} bytes`);
	check('and is served as a manifest rather than a download',
		/manifest\+json/.test(mf.type || ''), mf.type || 'none');

	if (man) {
		check('it asks for a window of its own', man.display === 'standalone', String(man.display));
		check('and names a start url and a scope', !!man.start_url && !!man.scope,
			`${man.start_url} / ${man.scope}`);
		check('and carries a name for the home screen',
			!!man.name && !!man.short_name && man.short_name.length <= 12,
			`${man.name} / ${man.short_name}`);
		const bg = groundColour();
		check('its colours are the app\'s own, not invented',
			(man.theme_color || '').toLowerCase() === bg
			&& (man.background_color || '').toLowerCase() === bg,
			`manifest ${man.theme_color}/${man.background_color}, css --bg-primary ${bg}`);
	}

	// The meta tag the platform paints its furniture with, after the app has
	// booted and chosen a palette.
	const metaColour = await page.evaluate(() => {
		const m = document.querySelector('meta[name="theme-color"]');
		const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
		return { meta: m ? m.getAttribute('content') : null, bg };
	});
	check('the theme colour follows the palette in use',
		!!metaColour.meta && metaColour.meta.toLowerCase() === metaColour.bg.toLowerCase(),
		`${metaColour.meta} vs ${metaColour.bg}`);

	// iOS reads its own tags and will not take an SVG for a home-screen icon.
	const apple = await page.evaluate(() => {
		const icon = document.querySelector('link[rel="apple-touch-icon"]');
		const cap  = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
		return { icon: icon ? icon.getAttribute('href') : null, cap: cap ? cap.content : null };
	});
	check('iOS is told it may open without Safari\'s chrome', apple.cap === 'yes', String(apple.cap));
	check('and is given a PNG for the home screen, which is all it accepts',
		!!apple.icon && /\.png$/.test(apple.icon), String(apple.icon));
	if (apple.icon) {
		const sz = pngSize(path.join(WWW, apple.icon));
		check('and that icon is the 180px iOS asks for',
			!!sz && sz.w === 180 && sz.h === 180, sz ? `${sz.w}x${sz.h}` : 'unreadable');
	}

	// ── 2. The icons are the sizes they claim ────────────────────
	if (man && Array.isArray(man.icons)) {
		const wrong = [];
		for (const ic of man.icons) {
			const file = path.join(WWW, ic.src);
			const sz = pngSize(file);
			const want = String(ic.sizes || '').split('x').map(Number);
			if (!sz) { wrong.push(`${ic.src}: missing or not a PNG`); continue; }
			if (sz.w !== want[0] || sz.h !== want[1]) {
				wrong.push(`${ic.src}: says ${ic.sizes}, is ${sz.w}x${sz.h}`);
			}
		}
		check('every icon the manifest names exists and is the size it claims',
			wrong.length === 0 && man.icons.length >= 2, wrong.join('; ') || `${man.icons.length} icons`);
		check('and one of them is maskable, so a round crop is survivable',
			man.icons.some(i => /maskable/.test(i.purpose || '')),
			man.icons.map(i => i.purpose || 'any').join(', '));
	}

	// A maskable icon may be cropped to any shape, and only the centre circle of
	// 80% diameter is safe. Measured in PIXELS, in the browser, and the
	// measurement is proved on an image that fails it -- otherwise "the ink is
	// inside the circle" is a sentence that passes on a blank square.
	const mask = await page.evaluate(async (src) => {
		function measure(ctx, n) {
			const d = ctx.getImageData(0, 0, n, n).data;
			const bg = [d[0], d[1], d[2]];
			let ink = 0, far = 0;
			const c = n / 2;
			for (let y = 0; y < n; y++) {
				for (let x = 0; x < n; x++) {
					const i = (y * n + x) * 4;
					if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) < 24) continue;
					ink++;
					const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
					if (r > far) far = r;
				}
			}
			return { ink, far, safe: n * 0.4 };
		}
		const img = new Image();
		img.src = src;
		await img.decode();
		const n = img.naturalWidth;
		const cv = document.createElement('canvas');
		cv.width = cv.height = n;
		const ctx = cv.getContext('2d', { willReadFrequently: true });
		ctx.drawImage(img, 0, 0);
		const real = measure(ctx, n);
		// The negative control: the same image with ink in a corner. If the
		// measurement cannot see that, it cannot see anything.
		ctx.fillStyle = '#00ff00';
		ctx.fillRect(0, 0, 12, 12);
		const spoilt = measure(ctx, n);
		return { real, spoilt, n };
	}, 'assets/icons/maskable-512.png');
	check('the maskable icon\'s ink is inside the safe circle',
		mask.real.ink > 1000 && mask.real.far <= mask.real.safe,
		`${mask.real.ink} ink px, furthest ${mask.real.far.toFixed(1)} of ${mask.real.safe}`);
	check('and the measurement rejects ink outside it, so the line above means something',
		mask.spoilt.far > mask.spoilt.safe,
		`furthest ${mask.spoilt.far.toFixed(1)} of ${mask.spoilt.safe}`);

	// ── 3. The worker registers ──────────────────────────────────
	// On the plain URL, which is the registration a user gets.
	const waitForWorker = (flagged) => page.evaluate((want) => new Promise((res) => {
		if (!('serviceWorker' in navigator)) { res(false); return; }
		const has = () => {
			const c = navigator.serviceWorker.controller;
			return !!c && (!want || /cache=on/.test(c.scriptURL));
		};
		if (has()) { res(true); return; }
		const t = setInterval(() => { if (has()) { clearInterval(t); res(true); } }, 200);
		setTimeout(() => { clearInterval(t); res(has()); }, 12000);
	}), flagged);
	check('a shell worker registers and takes control', await waitForWorker(false) === true, '');

	// From here the cache has to be ON, which it is not on a loopback host (see
	// sw.js). The flag rides on the page's URL, so the plain registration made
	// above is retired first: waiting for "a controller" alone can catch the
	// outgoing one, whose cache is off, and the run then measures the wrong
	// worker -- which it did, intermittently, until this was written.
	await page.evaluate(async () => {
		const rs = await navigator.serviceWorker.getRegistrations();
		await Promise.all(rs.map(r => r.unregister()));
	});
	await page.goto(APP + '/?cache=on', { waitUntil: 'load' });
	const flagged = await waitForWorker(true);
	check('and with the cache switched on it takes control too', flagged === true, String(flagged));

	const swState = await page.evaluate(() => window.DaimondPWA.state());
	check('and its cache is switched on for this run', !!swState && swState.shell === true,
		JSON.stringify(swState));
	check('and it agrees with the server about which build is live',
		!!swState && swState.live === 'build-one', swState ? String(swState.live) : 'no worker');

	// ── 4. THE ONE: network-first, with the cache as an offline fallback ──
	// First, prove the shell is fetched from the SERVER on a warm reload. A worker
	// that served the cache here is exactly the "stuck on last week's build" trap;
	// network-first is what stops it.
	await page.reload({ waitUntil: 'load' });		// prime: fill the cache through the worker
	await sleep(2500);
	let from = since();
	await page.reload({ waitUntil: 'load' });
	await sleep(2000);
	const warm = ['/index.html', '/css/app.css', '/js/daimond.js', '/js/updater.js']
		.map(p => `${p}:${asked(from, p)}`);
	const warmDoc  = asked(from, '/') + asked(from, '/index.html');
	const warmEach = warmDoc >= 1
		&& ['/css/app.css', '/js/daimond.js', '/js/updater.js'].every(p => asked(from, p) >= 1);
	if (process.env.PWA_DEBUG) console.log('    warm window:', JSON.stringify(hits.slice(from)));
	check('a warm reload fetches the shell from the server, not the cache (network-first)',
		warmEach, warm.join(' '));
	check('and the stamp is fetched too, because that is what names the offline cache',
		asked(from, '/build.json') >= 1, `${asked(from, '/build.json')} fetch(es)`);

	// Now prove the cache earns its keep: cut the network and the app must still
	// open, served from the shell the worker holds.
	await cdp.send('Network.emulateNetworkConditions',
		{ offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
	let offlineOpened = false;
	try {
		await page.reload({ waitUntil: 'load' });
		await sleep(1200);
		offlineOpened = await page.evaluate(() =>
			document.readyState === 'complete' && !!document.querySelector('script'));
	} catch (e) { offlineOpened = false; }
	await cdp.send('Network.emulateNetworkConditions',
		{ offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
	check('with the network cut, the app still opens from the cached shell (offline)',
		offlineOpened, offlineOpened ? 'opened offline' : 'did not open offline');

	// Now move the build. Everything the cache holds is a build the server has
	// left behind, and none of it may be served again.
	state.build = 'build-two';
	from = since();
	await page.reload({ waitUntil: 'load' });
	await sleep(2500);
	const cold = {
		doc: asked(from, '/') + asked(from, '/index.html'),
		css: asked(from, '/css/app.css'),
		js:  asked(from, '/js/daimond.js'),
	};
	check('THE WORKER SERVES NOTHING FROM THE CACHE ONCE THE BUILD ID HAS MOVED',
		cold.doc >= 1 && cold.css >= 1 && cold.js >= 1,
		`document ${cold.doc}, stylesheet ${cold.css}, script ${cold.js} fetched from the server`);

	const after = await page.evaluate(() => window.DaimondPWA.state());
	// Deleted, not merely stepped over -- and nothing else left standing either.
	// A cache under some name of its own that the build does not enter into is
	// how a worker ends up holding a build for ever without appearing to.
	check('and no cache but the live build\'s is left standing',
		!!after && after.caches.length > 0 && after.caches.every(n => n === 'daimond-shell-build-two'),
		after ? after.caches.join(', ') || 'none' : 'no worker');
	check('and the worker has adopted the build the server is actually on',
		!!after && after.live === 'build-two', after ? String(after.live) : 'no worker');

	// ── 5. Nothing of the user's, and nothing that decides ───────
	from = since();
	const twice = await page.evaluate(async () => {
		const a = await (await fetch('api/ping')).json();
		const b = await (await fetch('api/ping')).json();
		return [a.at, b.at];
	});
	check('an API call reaches the gateway every time it is made',
		asked(from, '/api/ping') === 2 && twice[0] !== twice[1],
		`${asked(from, '/api/ping')} request(s), ${twice[0]} vs ${twice[1]}`);

	const held = await page.evaluate(async () => {
		const names = await caches.keys();
		const out = [];
		for (const n of names) {
			const c = await caches.open(n);
			for (const r of await c.keys()) out.push(r.url);
		}
		return out;
	});
	const forbidden = held.filter(u =>
		/\/api\//.test(u) || /\/webhook\//.test(u)
		|| /\/build\.json$/.test(u) || /\/manifest\.json$/.test(u) || /\/releases\.json$/.test(u));
	check('and nothing under /api/ is in a cache, nor any file that says what the server is doing',
		forbidden.length === 0, forbidden.join(', ') || `${held.length} shell entries held`);
	if (process.env.PWA_DEBUG) console.log('    cached:', JSON.stringify(held));
	check('while the shell itself IS held, so the app opens without a network',
		held.some(u => /\/js\/daimond\.js$/.test(u)) && held.some(u => /index\.html$/.test(u)),
		`${held.length} entries`);

	// ── 6. Standalone: the hardware takes its share of the screen ─
	// Chrome reports nought for every inset on a desktop, so the four tokens are
	// set to an iPhone 15 Pro's real numbers and the frame is measured against
	// them. That is only honest because the tokens are the ONE place the app
	// reads the platform, which is asserted first.
	const varsCss = fs.readFileSync(path.join(WWW, 'css', 'variables.css'), 'utf8');
	const tokenSrc = ['t:top', 'r:right', 'b:bottom', 'l:left'].every(pair => {
		const [k, side] = pair.split(':');
		return new RegExp(`--safe-${k}:\\s*env\\(safe-area-inset-${side}`).test(
			BREAK === 'tokens' ? DAMAGED['css/variables.css'] : varsCss);
	});
	check('the safe-area tokens are fed by the platform, not by a number',
		tokenSrc, 'css/variables.css --safe-t/r/b/l');

	await cdp.send('Emulation.setEmulatedMedia', {
		media: 'screen',
		features: [{ name: 'display-mode', value: 'standalone' }],
	});

	const INSET = { t: 59, r: 0, b: 34, l: 0 };		// iPhone 15 Pro, portrait
	const setInsets = (i) => page.evaluate((v) => {
		let el = document.getElementById('pwa-insets');
		if (!el) { el = document.createElement('style'); el.id = 'pwa-insets'; document.head.appendChild(el); }
		el.textContent = `:root{--safe-t:${v.t}px;--safe-r:${v.r}px;--safe-b:${v.b}px;--safe-l:${v.l}px;}`;
	}, i);

	await page.setViewportSize({ width: 393, height: 852 });
	await signInAs(s, 'pwa');
	await setInsets(INSET);
	await sleep(600);

	const port = await page.evaluate(() => {
		const r = (sel) => {
			const el = document.querySelector(sel);
			if (!el) return null;
			const b = el.getBoundingClientRect();
			return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
		};
		const btns = [...document.querySelectorAll('#mnav button')].map(b => b.getBoundingClientRect().bottom);
		return {
			bar:   r('.topbar'),
			brand: r('.brand-wordmark:not([hidden])') || r('.brand'),
			nav:   btns.length ? Math.max(...btns) : null,
			h:     window.innerHeight,
		};
	});
	check('the top bar clears the status bar and the notch',
		!!port.bar && port.bar.top >= INSET.t,
		port.bar ? `bar top ${port.bar.top.toFixed(1)}, inset ${INSET.t}` : 'no top bar');
	check('and so does its ink, not merely its box',
		!!port.brand && port.brand.top >= INSET.t,
		port.brand ? `wordmark top ${port.brand.top.toFixed(1)}` : 'no wordmark');
	check('the bottom bar clears the home indicator',
		port.nav !== null && port.nav <= port.h - INSET.b,
		port.nav === null ? 'no bottom bar' : `lowest button ${port.nav.toFixed(1)}, floor ${port.h - INSET.b}`);
	await shot(s, 'pwa-standalone-portrait' + (BREAK ? '-' + BREAK : ''));

	// The drawer is fixed to the viewport, outside the frame's padding, so it
	// has to hold the hardware off its own contents.
	await page.click('#drawer-btn', { force: true });
	await sleep(700);
	const drawer = await page.evaluate((inset) => {
		const rail = document.querySelector('.panel.rail');
		if (!rail) return null;
		const cs = getComputedStyle(rail);
		const first = rail.querySelector('button, input, a');
		return {
			padTop: parseFloat(cs.paddingTop),
			padBot: parseFloat(cs.paddingBottom),
			firstTop: first ? first.getBoundingClientRect().top : null,
			open: document.body.classList.contains('drawer-open'),
			inset,
		};
	}, INSET);
	check('the drawer holds its contents off the status bar and the home indicator',
		!!drawer && drawer.padTop >= INSET.t && drawer.padBot >= INSET.b,
		drawer ? `padding ${drawer.padTop}/${drawer.padBot}, insets ${INSET.t}/${INSET.b}` : 'no drawer');
	check('and its first control is below the notch',
		!!drawer && drawer.firstTop !== null && drawer.firstTop >= INSET.t,
		drawer ? String(drawer.firstTop) : '—');
	await shot(s, 'pwa-standalone-drawer' + (BREAK ? '-' + BREAK : ''));
	// Escape, not a click on the scrim: a forced click lands at a point whether
	// or not anything is over it, and once the drawer began closing it went
	// through to the control underneath and opened a dialog over the shot.
	await page.keyboard.press('Escape');
	await sleep(500);

	// Landscape: the notch moves to one side, and 852px wide is above the phone
	// breakpoint, so this is the desktop frame taking the inset.
	await page.setViewportSize({ width: 852, height: 393 });
	await setInsets({ t: 0, r: 59, b: 21, l: 59 });
	await sleep(700);
	const land = await page.evaluate(() => {
		const bar = document.querySelector('.topbar');
		const b = bar ? bar.getBoundingClientRect() : null;
		const main = document.querySelector('.main');
		return b ? {
			left: b.left, right: b.right,
			foot: main ? main.getBoundingClientRect().bottom : null,
			w: window.innerWidth, h: window.innerHeight,
		} : null;
	});
	check('in landscape the frame clears the notch on both sides',
		!!land && land.left >= 59 && land.right <= land.w - 59,
		land ? `bar ${land.left.toFixed(1)}..${land.right.toFixed(1)} of ${land.w}` : 'no top bar');
	// And the foot of the panels clears the home indicator. This is the desktop
	// frame -- a phone on its side is 852px wide, above the narrow breakpoint --
	// so it is a different rule from the bottom bar's on the portrait screen.
	check('and its foot clears the home indicator',
		!!land && land.foot !== null && land.foot <= land.h - 21,
		land ? `panels end ${land.foot && land.foot.toFixed(1)}, floor ${land.h - 21}` : '—');
	await shot(s, 'pwa-standalone-landscape' + (BREAK ? '-' + BREAK : ''));

	// A worker that throws on every navigation is a worker nobody will notice is
	// broken, so the console is part of the result.
	const errs = errors(s).filter(e =>
		!/Failed to load resource/.test(e) && !/no gateway/.test(e) && !/502/.test(e));
	check('nothing was served by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));
} finally {
	await s.close();
	server.close();
}

console.log(`\nrequests seen: ${hits.length}`);
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
