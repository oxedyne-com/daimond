// verify_hand.mjs — the machine hand's relay, end to end, without the Rust
// binary.
//
// The relay's whole job is the part a correct hand never exercises: output that
// arrives in order and stays attributable, a gap that is announced rather than
// hidden, and the several ways a native messaging host can vanish. So this runs
// against hand/install/mock_host.py, which speaks the real framing and the real
// messages and can be told to misbehave on purpose.
//
// It launches a real Chrome with the real unpacked extension, writes the host
// manifest into the test profile's own NativeMessagingHosts directory — which is
// exactly where a browser started with --user-data-dir looks — and drives the
// relay from a page on an allowed origin. The grant window is clicked for real:
// unlike a site approval, this one has no second Chrome prompt behind it, so the
// whole flow is reachable from a test.
//
// It also drives the boundary itself, which is the half a working day never
// touches: a hostile origin's probe, a grant that must not carry from one origin
// to the next, the four shapes of exec this end refuses, and the wording the
// grant window is only allowed to use when the machine can back it.
//
// Needs nothing else running, and takes the first free port from 8877 rather
// than the dev server's, so it can be run beside one. Run it headed, under xvfb:
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_hand.mjs
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

import { fileURLToPath } from 'node:url';
// Chromium's ozone platform is chosen by autodetection and prefers Wayland whenever
// `WAYLAND_DISPLAY` is set -- which it is in every rc session on argonaut -- so a headed
// run under `xvfb-run` still went to the compositor and opened a window on the owner's
// desktop. Importing this strips the two variables from `process.env`, which is all a
// launcher that spreads `process.env` needs. See dev/display.mjs.
import './display.mjs';
const ROOT	= path.join(path.dirname(fileURLToPath(import.meta.url)), '..');	// this checkout, not one developer's home
const EXT	= `${ROOT}/ext`;
// The SHIPPED manifest names one origin and it is not this test server. The dev
// origins live in the generated build alone, so that the release artefact cannot
// carry them -- see dev/extdev.mjs, and hand/REVIEW.md §1.6 for what they cost.
const { extDev } = await import(pathToFileURL(`${ROOT}/dev/extdev.mjs`).href);
const INSTALL	= `${ROOT}/hand/install`;
// Not /tmp -- see the SCRATCH note in harness.mjs.
const SCRATCH	= process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
// The mock reads its configuration, and writes its log, BESIDE ITSELF. Two runs
// of this file at once would each be told what to do by the other, which is not
// a hypothetical: it happened, and it looked like the relay dropping chunks. So
// each run gets its own copy of the mock and its own pair of files. The copy is
// made on every launch, so a change to hand/install/mock_host.py is picked up.
// The extension's reload grace, read from the file rather than repeated here: a
// wait that disagreed with the hold would pass or fail for a reason that is not
// the property. See ext/hand.js, "The reload grace".
const HOLD_MS = (() => {
	const src = fs.readFileSync(`${ROOT}/ext/hand.js`, 'utf8');
	const m = /const HOLD_MS = (\d+);/.exec(src);
	if (!m) { console.error('ext/hand.js no longer names HOLD_MS; the waits below cannot be aimed'); process.exit(2); }
	return Number(m[1]);
})();
const MOCKDIR	= path.join(SCRATCH, `verify-hand-mock-${process.pid}`);
const MOCK	= path.join(MOCKDIR, 'mock_host.py');
const CFG	= path.join(MOCKDIR, 'mock_cfg.json');
const MOCKLOG	= path.join(MOCKDIR, 'mock_host.log');
fs.rmSync(MOCKDIR, { recursive: true, force: true });
fs.mkdirSync(MOCKDIR, { recursive: true });
fs.copyFileSync(`${INSTALL}/mock_host.py`, MOCK);
fs.chmodSync(MOCK, 0o755);
const PROFILE	= path.join(SCRATCH, 'verify-hand');
// The stub page only has to be on an origin the manifest lets speak to the
// extension. It is not the app: nothing here needs the app -- and it is not the
// dev server either, so the two must not fight over its port. The port is CHOSEN
// below, from the first free one, and the dev build is then generated to trust
// whichever that was. That is what lets this run beside `dev/serve.mjs`.
const FIRST	= Number(process.env.HAND_PORT || 8877);
const EXTID	= 'mpliijponglmmffjnonahhignkpkhmij';
let PORT	= FIRST;
let HOSTILE_PORT = 0;
let APP		= '';
let APP2	= '';
let HOSTILE	= '';
let EXT_DEV	= '';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// The page under test: it opens a port to the extension and keeps every
/// message, in the order it arrived, for us to read afterwards.
const PAGE = `<!doctype html><meta charset="utf-8"><title>hand</title>
<body><h1>hand harness</h1><script>
window.__seen = [];
window.__port = null;
window.__open = function () {
	const id = document.documentElement.dataset.daimondHands;
	if (!id) return 'no extension';
	window.__seen = [];
	window.__port = chrome.runtime.connect(id, { name: 'daimond-hand' });
	window.__port.onMessage.addListener((m) => window.__seen.push(m));
	window.__port.onDisconnect.addListener(() => window.__seen.push({ t: '__gone' }));
	return 'ok';
};
// A port whose extension end has already gone throws here, and Chrome does
// not tell the page it went until a turn later -- so a send that crosses that
// moment is a race this harness has lost before (it died with "Attempting to
// use a disconnected port object", killing the whole run). The answer is
// reported rather than thrown: every check reads what the extension SENT, and
// a post that could not be made is not one of them.
window.__say = function (m) {
	try { window.__port.postMessage(m); return 'sent'; }
	catch (e) { return 'gone: ' + ((e && e.message) || e); }
};
// A well-formed exec, with anything overridden and anything dropped. The fence
// is a real one: the hand refuses an empty fence and a cwd outside it, and so,
// now, does the relay.
window.__exec = function (id, argv, over, drop) {
	const m = { t: 'exec', id, argv, cwd: '/tmp', env: [], stdin: null,
		timeout_ms: 60000, capture: 'both',
		fence: { rw: ['/tmp'], ro: [], deny: [], net: false } };
	Object.assign(m, over || {});
	for (const k of (drop || [])) delete m[k];
	window.__say(m);
};
</script></body>`;

/// The reviewer's probe: a bare hostile page that knows the extension id -- it is
/// pinned in the manifest and public -- and simply asks. Everything it can try
/// is tried, and what it got is left on the window.
const PROBE = `<!doctype html><meta charset="utf-8"><title>probe</title>
<body><h1>hostile</h1><script>
window.__probe = { announced: null, runtime: null, connect: null, message: null };
// What the page can see without touching anything, so the control can be run
// from an allowed origin without opening a grant question nobody answers.
window.__peek = function () {
	return {
		announced: document.documentElement.dataset.daimondHands || null,
		runtime: (window.chrome && chrome.runtime && chrome.runtime.connect) ? 'present' : 'absent',
	};
};
window.__try = function () {
	const id = '${EXTID}';
	window.__probe.announced = document.documentElement.dataset.daimondHands || null;
	window.__probe.runtime = (window.chrome && chrome.runtime) ? 'present' : 'absent';
	try {
		const port = chrome.runtime.connect(id, { name: 'daimond-hand' });
		window.__probe.connect = 'port';
		port.onMessage.addListener((m) => { window.__probe.connect = 'answered:' + m.t; });
		port.onDisconnect.addListener(() => { window.__probe.connect = 'disconnected'; });
		port.postMessage({ t: 'hello', proto: 1, client: 'probe' });
	} catch (e) {
		window.__probe.connect = 'threw:' + ((e && e.message) || e);
	}
	try {
		chrome.runtime.sendMessage(id, { cmd: 'ping' }, (r) => {
			window.__probe.message = chrome.runtime.lastError
				? 'error:' + chrome.runtime.lastError.message : JSON.stringify(r);
		});
	} catch (e) {
		window.__probe.message = 'threw:' + ((e && e.message) || e);
	}
	return window.__probe;
};
</script></body>`;

/// Serves the harness page, and the hostile probe at `/probe` so the same probe
/// can be run from an origin that IS allowed -- otherwise "it did not work"
/// proves only that the probe does not work.
async function serve(port, host) {
	const s = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(/^\/probe/.test(req.url || '') ? PROBE : PAGE);
	});
	await new Promise((resolve, reject) => {
		s.once('error', reject);
		s.listen(port, host, resolve);
	});
	return s;
}

/// Takes the first free port from `from`, so a dev server that already holds one
/// is left alone rather than fought over.
async function serveFree(from) {
	for (let port = from; port < from + 40; port++) {
		try {
			return { s: await serve(port, '127.0.0.1'), port };
		} catch (e) {
			if (e.code !== 'EADDRINUSE') { throw e; }
		}
	}
	console.error(`No free port from ${from}. Set HAND_PORT.`);
	process.exit(2);
}

const servers	= [];
const first	= await serveFree(FIRST);
servers.push(first.s);
PORT		= first.port;
const second	= await serveFree(PORT + 1);
servers.push(second.s);
HOSTILE_PORT	= second.port;

APP		= `http://127.0.0.1:${PORT}`;
// The SECOND allowed origin. Same server, same machine, different origin string
// -- which is the whole of the per-origin grant: allowed once from 127.0.0.1,
// the hand reached the host from localhost with no window shown at all.
APP2		= `http://localhost:${PORT}`;
// And one that is allowed nowhere. The reviewer's probe was a bare hostile HTML
// file served from a port the extension trusted; this is the same file served
// from one it does not.
HOSTILE		= `http://127.0.0.1:${HOSTILE_PORT}`;
// The dev build trusts the port this run actually took. Nothing else about it
// differs from the one a developer loads -- see dev/extdev.mjs.
EXT_DEV		= await extDev(PORT);

// `localhost` is the other spelling of the same machine, and which family it
// resolves to is the resolver's business, so both are answered.
try { servers.push(await serve(PORT, '::1')); } catch (e) { /* no IPv6 loopback here */ }

/// Points the profile's native messaging host at the mock, with the behaviour
/// this part of the test needs. The host reads its configuration when it
/// starts, so a fresh port picks up a fresh setting.
const HOSTS = path.join(PROFILE, 'NativeMessagingHosts');
function register(cfg) {
	fs.mkdirSync(HOSTS, { recursive: true });
	fs.writeFileSync(path.join(HOSTS, 'com.oxedyne.daimond.hand.json'), JSON.stringify({
		name:		'com.oxedyne.daimond.hand',
		description:	'Mock hand for verify_hand.mjs.',
		path:		MOCK,
		type:		'stdio',
		allowed_origins: ['chrome-extension://mpliijponglmmffjnonahhignkpkhmij/'],
	}, null, '\t') + '\n');
	fs.writeFileSync(CFG, JSON.stringify(cfg || {}, null, '\t') + '\n');
	try { fs.rmSync(MOCKLOG); } catch (e) { /* first run */ }
}
function unregister() {
	try { fs.rmSync(path.join(HOSTS, 'com.oxedyne.daimond.hand.json')); } catch (e) {}
}

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
// `caps` is what the hand claims it can enforce, and the grant window's
// wording is chosen from it. `root:` is how the granted folder travels, since
// wire.rs has no field for one.
register({ chunks: 3, caps: ['fence:none', 'root:/tmp'] });

const b = await chromium.launchPersistentContext(PROFILE, {
	executablePath:	CHROME,
	headless:	false,
	args: ['--no-sandbox', '--disable-dev-shm-usage',
		`--disable-extensions-except=${EXT_DEV}`, `--load-extension=${EXT_DEV}`],
	viewport: { width: 1200, height: 800 },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitSW() {
	for (let i = 0; i < 100 && !b.serviceWorkers().length; i++) await sleep(100);
	return b.serviceWorkers()[0];
}

/// Everything the page has been sent so far.
async function seen(page) {
	return await page.evaluate(() => window.__seen);
}

/// Waits for a message of a given `t`, and returns the whole transcript.
async function until(page, t, ms = 12000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		const all = await seen(page);
		if (all.some((m) => m.t === t)) return all;
		await sleep(150);
	}
	return await seen(page);
}

/// Finds the grant window, reads every word of it, and answers. It is the
/// extension's own page, so a click here is a real click, and for this question
/// there is no second Chrome prompt behind it — this window IS the approval.
///
/// The whole window is returned, not only its heading: what it PROMISES is the
/// thing under test, and the promise is in the body and the small print.
async function handWindow(answer = 'allow', ms = 8000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const p of b.pages()) {
			if (/grant\.html/.test(p.url())) {
				await p.waitForLoadState('domcontentloaded');
				await sleep(300);
				const said = await p.evaluate(() => {
					const at = (id) => {
						const n = document.getElementById(id);
						return n && !n.hidden ? (n.textContent || '') : '';
					};
					return { head: at('head'), host: at('host'), scope: at('scope'), body: at('body'), fine: at('fine') };
				});
				said.url = p.url();
				await p.click(answer === 'allow' ? '#allow' : '#deny');
				return said;
			}
		}
		await sleep(150);
	}
	return null;
}

/// The grant window as it would be drawn for a hand reporting `caps`, without
/// waiting for a machine that reports them. Chrome's own page, opened directly,
/// which is how dev/verify_ext_i18n.mjs reads this window too.
async function wordingFor(caps) {
	const p = await b.newPage();
	await p.goto(`chrome-extension://${extId}/grant.html?nonce=probe&kind=hand`
		+ `&origin=${encodeURIComponent(APP)}&caps=${encodeURIComponent(caps)}`,
		{ waitUntil: 'domcontentloaded' });
	await sleep(400);
	const said = await p.evaluate(() => ({
		body:	(document.getElementById('body') || {}).textContent || '',
		fine:	(document.getElementById('fine') || {}).textContent || '',
		scope:	(document.getElementById('scope') || {}).textContent || '',
	}));
	await p.close();
	return said;
}

/// Everything the page has been told, with the refusals easy to find.
async function refusalFor(page, id) {
	const all = await seen(page);
	return all.find((m) => m.t === 'refused' && m.id === id) || null;
}

/// The extension's own popup, opened as a page. Messages to the broker have to
/// come from a page like this one: Chrome does not deliver a runtime message
/// back to the context that sent it, so the service worker cannot ask itself.
let extId = '';
async function popup() {
	const p = await b.newPage();
	await p.goto(`chrome-extension://${extId}/popup.html`);
	await sleep(700);
	return p;
}

try {
	const sw = await waitSW();
	extId = sw ? new URL(sw.url()).host : '';
	check('the broker service worker started', !!sw);
	check('the manifest asks for nativeMessaging', !!sw
		&& (await sw.evaluate(() => chrome.runtime.getManifest().permissions.includes('nativeMessaging'))));
	check('the relay is loaded into the worker', !!sw
		&& (await sw.evaluate(() => typeof globalThis.DaimondHand === 'object')));

	const page = await b.newPage();
	await page.goto(APP + '/', { waitUntil: 'domcontentloaded' });
	await sleep(800);
	check('the extension announced itself to the page',
		await page.evaluate(() => !!document.documentElement.dataset.daimondHands));

	// ── What ships ──────────────────────────────────────────────────
	//
	// The manifest under test here is the GENERATED one, which has the dev
	// origins in it on purpose. The one that ships is the file in the tree, and
	// the only thing that keeps a user safe from a stray server on 8777 is that
	// it does not name it. So the file itself is read.
	{
		const man	= JSON.parse(fs.readFileSync(`${EXT}/manifest.json`, 'utf8'));
		const pats	= [].concat(
			(man.externally_connectable || {}).matches || [],
			...(man.content_scripts || []).map((cs) => cs.matches || []));
		const loop	= pats.filter((p) => /(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)/.test(p));
		check('the shipped manifest names no loopback origin', loop.length === 0, loop.join(', '));
		check('and it still names the one origin that is real',
			pats.every((p) => /^https:\/\/daimond\.oxedyne\.com\//.test(p)), pats.join(', '));
		const dev = JSON.parse(fs.readFileSync(`${EXT_DEV}/manifest.json`, 'utf8'));
		check('the dev build is the one that carries them',
			(dev.externally_connectable.matches || []).filter((p) => /127\.0\.0\.1|localhost/.test(p)).length === 2,
			JSON.stringify(dev.externally_connectable.matches));
	}

	// ── A hostile origin ────────────────────────────────────────────
	//
	// The reviewer's probe, from a port the extension does not trust. Chrome is
	// the doorman and this is what it is for; the point of running it is that
	// the same page, from an origin that IS trusted, gets straight through.
	{
		const eve = await b.newPage();
		await eve.goto(HOSTILE + '/probe', { waitUntil: 'domcontentloaded' });
		await sleep(500);
		const got = await eve.evaluate(() => window.__try());
		await sleep(900);
		const after = await eve.evaluate(() => window.__probe);
		check('a hostile origin is not content-scripted at all', !got.announced, String(got.announced));
		check('a hostile origin cannot reach the extension at all',
			after.runtime === 'absent' || /threw|disconnected/.test(String(after.connect)),
			JSON.stringify(after));
		check('and nothing answers its message either',
			!after.message || /error|threw/.test(String(after.message)), String(after.message));
		await eve.close();

		const ours = await b.newPage();
		await ours.goto(APP + '/probe', { waitUntil: 'domcontentloaded' });
		await sleep(500);
		const mineProbe = await ours.evaluate(() => window.__peek());
		check('the same page on an allowed origin can see the extension, so the probe works',
			mineProbe.runtime === 'present' && !!mineProbe.announced, JSON.stringify(mineProbe));
		await ours.close();
	}

	// ── The second look at the boundary is a real one ───────────────
	//
	// `mayConnect` used to add each pattern's host with the port stripped off,
	// so it would have accepted 8778 on the strength of a pattern naming 8777.
	// Chrome honours the port, so nothing was exploitable through it — which is
	// the trouble exactly: a re-check laxer than the first is load-bearing only
	// on the day the first one changes, and on that day it fails open.
	{
		const answers = await sw.evaluate(([mine, next]) => ({
			allowed:	globalThis.DaimondHand.allowedOrigin({ origin: mine, url: mine + '/' }),
			otherPort:	globalThis.DaimondHand.allowedOrigin({ origin: next, url: next + '/' }),
			otherHost:	globalThis.DaimondHand.allowedOrigin({ origin: 'https://daimond.oxedyne.com.evil.test', url: 'https://daimond.oxedyne.com.evil.test/' }),
			live:		globalThis.DaimondHand.allowedOrigin({ origin: 'https://daimond.oxedyne.com', url: 'https://daimond.oxedyne.com/' }),
			nothing:	globalThis.DaimondHand.allowedOrigin({}),
		}), [APP, HOSTILE]);
		check('the relay\'s own check accepts the origins the manifest names',
			answers.allowed === APP && answers.live === 'https://daimond.oxedyne.com', JSON.stringify(answers));
		check('the port is part of the origin, so a neighbouring port is refused',
			answers.otherPort === '', JSON.stringify(answers.otherPort));
		check('a host that merely starts with ours is refused',
			answers.otherHost === '' && answers.nothing === '', JSON.stringify(answers));
	}

	// ── The grant ───────────────────────────────────────────────────
	check('the hand is not granted before it is asked',
		!(await sw.evaluate(() => globalThis.DaimondHand.granted())));

	await page.evaluate(() => window.__open());
	await page.evaluate(() => window.__say({ t: 'hello', proto: 1, client: 'verify_hand' }));
	const said = await handWindow();
	const head = said && said.head;
	check('opening the port asks the user, in the extension\'s own window', !!head, JSON.stringify(said));
	check('the question is about this computer, not about a site',
		/computer/i.test(head || ''), String(head));
	check('the window names the page that asked, because only that page is answered',
		!!said && said.host === APP, JSON.stringify(said && said.host));

	// This hand reports `fence:none`, so the window must NOT promise the
	// folders: the sentence is chosen from what the hand said, and this hand
	// said it can enforce nothing.
	check('the wording is chosen from what the hand said it can enforce',
		!!said && /fence:none/.test(said.scope || ''), JSON.stringify(said && said.scope));
	check('and a hand with no fence does not get the sentence about folders',
		!!said && !/folders the workspace/.test(said.body || '')
			&& /cannot limit which files/.test(said.body || ''), JSON.stringify(said && said.body));

	let all = await until(page, 'hello');
	const hello = all.find((m) => m.t === 'hello');
	check('the hand answers the handshake', !!hello, JSON.stringify(hello));
	check('the answer is the host\'s own, relayed untouched',
		!!hello && hello.proto === 1 && /mock/.test(hello.host || ''), JSON.stringify(hello));
	check('the grant is now recorded',
		await sw.evaluate(() => globalThis.DaimondHand.granted()));

	check('the grant is recorded for the origin that asked, and only that one',
		await sw.evaluate((o) => globalThis.DaimondHand.granted(o), APP)
		&& !(await sw.evaluate((o) => globalThis.DaimondHand.granted(o), APP2)),
		`${APP} yes, ${APP2} no`);

	// ── The grant does not carry to the origin next door ────────────
	//
	// The same machine, the same server, the same port, the other spelling of
	// loopback. Granted from 127.0.0.1, `localhost` reached the host with no
	// window shown at all: the grant was one boolean for the whole browser.
	{
		const other = await b.newPage();
		await other.goto(APP2 + '/', { waitUntil: 'domcontentloaded' });
		await sleep(700);
		await other.evaluate(() => window.__open());
		const asked = await handWindow('deny', 6000);
		check('a second origin is asked again rather than inheriting the grant',
			!!asked && /computer/i.test(asked.head || ''), JSON.stringify(asked && asked.head));
		check('and the window names the origin that is actually asking',
			!!asked && asked.host === APP2, JSON.stringify(asked && asked.host));
		const told = await until(other, 'error', 6000);
		check('declining it refuses that origin, in the sentence the daimon reads',
			told.some((m) => m.t === 'error' && /declined/i.test(m.message || '')),
			JSON.stringify(told.filter((m) => m.t === 'error')).slice(0, 160));
		check('and the first origin still holds its own grant',
			await sw.evaluate((o) => globalThis.DaimondHand.granted(o), APP)
			&& !(await sw.evaluate((o) => globalThis.DaimondHand.granted(o), APP2)));
		await other.close();
	}

	// The popup is where a person goes to see what they have allowed and to take
	// it back, so the machine hand has to be findable there beside the sites --
	// in words, not as the sentinel the code passes around.
	{
		const pop = await popup();
		const text = await pop.evaluate(() => document.body.innerText);
		check('the popup lists it among what the user has allowed',
			/commands on this computer/i.test(text), text.replace(/\n/g, ' / '));
		check('and says which page it was allowed for', text.includes(APP), text.replace(/\n/g, ' / '));
		check('and offers to revoke it', await pop.evaluate(() => {
			const li = [...document.querySelectorAll('#granted li')]
				.find((n) => /computer/i.test(n.textContent));
			return !!(li && li.querySelector('button'));
		}));
		await pop.close();
	}

	// ── The wording is the machine's, not the product's ─────────────
	//
	// Release gate 1 in hand/README.md: the consent window's wording must be
	// chosen from `caps` rather than hard-coded, so it can only claim what that
	// machine actually enforces. A fenceless machine gets different, honest
	// words, and the difference is in the sentence a user would act on.
	{
		const none	= await wordingFor('fence:none');
		const real	= await wordingFor('fence:linux landlock:abi-8 journal');
		const silent	= await wordingFor('');
		check('a fenceless machine is not described as fencing anything',
			!/folders the workspace/.test(none.body) && /cannot limit which files/.test(none.body), none.body);
		check('a machine that fences gets the sentence about folders',
			/folders the workspace/.test(real.body), real.body);
		check('the two are not the same words', none.body !== real.body);
		check('a hand that keeps a journal is the only one that promises one',
			/journal/i.test(real.fine) && !/journal/i.test(none.fine), `${real.fine} || ${none.fine}`);
		check('what the machine can enforce is shown verbatim',
			/landlock:abi-8/.test(real.scope) && /fence:none/.test(none.scope), `${real.scope} || ${none.scope}`);
		check('a hand that said nothing is a third answer, not a promise',
			/did not say/.test(silent.scope) && /did not say/.test(silent.body), `${silent.scope} || ${silent.body}`);
	}

	// ── Order and attribution ───────────────────────────────────────
	await page.evaluate(() => window.__exec('r1', ['cargo', 'test']));
	all = await until(page, 'ended');
	const mine	= all.filter((m) => m.id === 'r1');
	const chunks	= mine.filter((m) => m.t === 'chunk');
	const outs	= chunks.filter((m) => m.stream === 'out');
	check('the run starts and ends', mine.some((m) => m.t === 'started') && mine.some((m) => m.t === 'ended'));
	check('every chunk arrives as its own message, none joined', chunks.length === 4, `${chunks.length} chunks`);
	check('the out stream is in order and complete',
		outs.map((m) => m.seq).join(',') === '1,2,3', outs.map((m) => m.seq).join(','));
	check('started comes before the first chunk, ended after the last',
		mine.findIndex((m) => m.t === 'started') === 0 && mine[mine.length - 1].t === 'ended',
		mine.map((m) => m.t).join(' '));
	check('the chunks carry the text the host sent',
		outs.map((m) => m.data).join('').includes('line 2 of cargo test'), '');
	check('no gap is reported when there is none',
		!mine.some((m) => m.t === 'error'), JSON.stringify(mine.filter((m) => m.t === 'error')));

	// ── The page does not choose its own compartment ────────────────
	//
	// The fence arrived from the page and went to the hand verbatim, and an
	// exec with no fence at all went too. A reviewer sent `fence:{rw:["/"]}`
	// with its own LD_PRELOAD and the hand received it byte for byte. The hand
	// is the authority and is being made to clamp; these are the shapes this end
	// can be sure of, and each of them is refused before the host sees it.
	{
		// A fresh port, so the refusals are the only things on it.
		await page.evaluate(() => { window.__say({ t: 'bye' }); window.__port.disconnect(); });
		await sleep(400);
		await page.evaluate(() => window.__open());
		await sleep(300);

		await page.evaluate(() => window.__exec('bad-nofence', ['cargo', 'test'], {}, ['fence']));
		await page.evaluate(() => window.__exec('bad-root', ['cargo', 'test'],
			{ fence: { rw: ['/'], ro: [], deny: [], net: true } }));
		await page.evaluate(() => window.__exec('bad-home', ['cargo', 'test'],
			{ fence: { rw: ['/home'], ro: [], deny: [], net: false } }));
		await page.evaluate(() => window.__exec('bad-env', ['cargo', 'test'],
			{ env: [['LD_PRELOAD', '/tmp/evil.so']] }));
		await page.evaluate(() => window.__exec('bad-cwd', ['cargo', 'test'],
			{ cwd: '/etc', fence: { rw: ['/tmp'], ro: [], deny: [], net: false } }));
		await page.evaluate(() => window.__exec('bad-outside', ['cargo', 'test'],
			{ cwd: '/var/tmp', fence: { rw: ['/var/tmp'], ro: [], deny: [], net: false } }));
		await page.evaluate(() => window.__exec('bad-timeout', ['cargo', 'test'], { timeout_ms: 0 }));
		await page.evaluate(() => window.__exec('x'.repeat(400), ['cargo', 'test']));
		await sleep(800);

		const noFence	= await refusalFor(page, 'bad-nofence');
		const rootFence	= await refusalFor(page, 'bad-root');
		const homeFence	= await refusalFor(page, 'bad-home');
		const badEnv	= await refusalFor(page, 'bad-env');
		const badCwd	= await refusalFor(page, 'bad-cwd');
		const badTime	= await refusalFor(page, 'bad-timeout');
		check('an exec with no fence at all is refused',
			!!noFence && /fence/i.test(noFence.reason), JSON.stringify(noFence));
		check('a fence naming the whole filesystem is refused',
			!!rootFence && /machine/i.test(rootFence.reason), JSON.stringify(rootFence));
		check('and so is one naming a folder the machine follows from',
			!!homeFence, JSON.stringify(homeFence));
		check('an LD_PRELOAD in the environment is refused',
			!!badEnv && /LD_PRELOAD/.test(badEnv.reason), JSON.stringify(badEnv));
		check('a working directory outside the fence is refused',
			!!badCwd && /outside/i.test(badCwd.reason), JSON.stringify(badCwd));
		check('a command with no wall-clock limit is refused',
			!!badTime && /timeout_ms/.test(badTime.reason), JSON.stringify(badTime));
		// The hand said `root:/tmp` in its hello, which is the folder its grant
		// covers. A fence outside that is a fence the grant does not reach, and
		// this end holds the page to it as well.
		const outside = await refusalFor(page, 'bad-outside');
		check('a fence outside the folder the hand says it was granted is refused',
			!!outside && /outside/.test(outside.reason) && /tmp/.test(outside.reason),
			JSON.stringify(outside));
		const seenAll	= await seen(page);
		const longId	= seenAll.find((m) => m.t === 'refused' && m.id.length > 300);
		check('an unbounded id is refused, because every answer carries it',
			!!longId && /128/.test(longId.reason), JSON.stringify(longId && longId.reason));
		check('none of them reached the host', await (async () => {
			const log = fs.existsSync(MOCKLOG) ? fs.readFileSync(MOCKLOG, 'utf8') : '';
			return !/bad-nofence|bad-root|bad-env|LD_PRELOAD/.test(log);
		})(), 'the mock host logs everything it is sent');

		// And a well-formed one still runs, so none of the above is a blanket no.
		await page.evaluate(() => window.__exec('good', ['cargo', 'test']));
		const done = await until(page, 'ended');
		check('a well-formed exec is still forwarded and still runs',
			done.some((m) => m.t === 'ended' && m.id === 'good'),
			JSON.stringify(done.filter((m) => m.t === 'refused')).slice(0, 200));
	}

	// ── A gap is announced, not hidden ──────────────────────────────
	register({ chunks: 3, gap: true });
	await page.evaluate(() => { window.__say({ t: 'bye' }); window.__port.disconnect(); });
	await sleep(400);
	await page.evaluate(() => window.__open());
	await page.evaluate(() => window.__exec('r2', ['make']));
	all = await until(page, 'ended');
	const gapErr = all.find((m) => m.t === 'error' && /missing|hole|sequence/i.test(m.message || ''));
	check('a hole in the sequence is reported', !!gapErr, JSON.stringify(gapErr));
	check('the report names the run and the stream it belongs to',
		!!gapErr && gapErr.id === 'r2' && /out/.test(gapErr.message), JSON.stringify(gapErr));
	const iErr	= all.indexOf(gapErr);
	const iChunk	= all.findIndex((m) => m.t === 'chunk' && m.seq === 3);
	check('it arrives before the chunk that revealed it', iErr >= 0 && iErr < iChunk, `${iErr} < ${iChunk}`);
	check('the chunks are still forwarded, hole and all',
		all.filter((m) => m.t === 'chunk' && m.stream === 'out').length === 3);

	// ── Over Chrome's 1 MB cap ──────────────────────────────────────
	register({ huge: true });
	await page.evaluate(() => { window.__say({ t: 'bye' }); window.__port.disconnect(); });
	await sleep(400);
	await page.evaluate(() => window.__open());
	await page.evaluate(() => window.__exec('r3', ['dump']));
	all = await until(page, 'ended');
	const capErr = all.find((m) => m.t === 'error' && /1 MB|disconnected/i.test(m.message || ''));
	check('an oversized message is reported, not swallowed', !!capErr, JSON.stringify(capErr));
	check('the report names the 1 MB limit as a cause',
		!!capErr && /1 MB/.test(capErr.message), (capErr || {}).message);
	check('the run is closed out so the page is not left waiting',
		all.some((m) => m.t === 'ended' && m.id === 'r3' && m.exit === -1),
		JSON.stringify(all.filter((m) => m.t === 'ended')));

	// ── A host that dies mid-command ────────────────────────────────
	register({ crash: true });
	await page.evaluate(() => { window.__say({ t: 'bye' }); window.__port.disconnect(); });
	await sleep(400);
	await page.evaluate(() => window.__open());
	await page.evaluate(() => window.__exec('r4', ['boom']));
	all = await until(page, 'ended');
	check('a crash mid-command is reported',
		all.some((m) => m.t === 'error' && /disconnected/i.test(m.message || '')),
		JSON.stringify(all.filter((m) => m.t === 'error')));
	check('and its run is closed out too',
		all.some((m) => m.t === 'ended' && m.id === 'r4' && m.killed === true));

	// ── The page goes away with a command running ───────────────────
	register({ chunks: 3, delay_ms: 900 });
	const runner = await b.newPage();
	await runner.goto(APP + '/', { waitUntil: 'domcontentloaded' });
	await sleep(500);
	await runner.evaluate(() => window.__open());
	await runner.evaluate(() => window.__exec('r5', ['sleep']));
	const running	= await until(runner, 'started', 6000);
	const pid	= (running.find((m) => m.t === 'started') || {}).pid;
	check('the run is really a process on this machine', !!pid && fs.existsSync(`/proc/${pid}`), String(pid));
	await runner.close();
	// SINCE 2026-08-25 THERE ARE TWO FACTS HERE AND NOT ONE. A page that vanishes
	// is held for the length of the grace, because the commonest way a page
	// vanishes is a reload; what it left is stopped only when nothing comes back
	// for it. So "no orphan" is still the promise and "at once" is no longer part
	// of it, and BOTH halves are asserted -- a file that only waited long enough
	// would pass with the grace deleted, and one that only checked the hold would
	// pass with the teardown deleted.
	await sleep(3000);
	check('a page that goes away leaves what it was running alive for the grace',
		fs.existsSync(`/proc/${pid}`), `pid ${pid}`);
	// The host dies when the hold runs out and its port is closed. Poll rather
	// than guess: the mock is mid-sleep and only notices its stdin has gone when
	// it comes back up.
	let alive = true;
	for (let i = 0; i < (HOLD_MS + 20000) / 200 && alive; i++) {
		await sleep(200);
		alive = fs.existsSync(`/proc/${pid}`);
	}
	check('and when nothing comes back for it, leaves no orphan behind', !alive, `pid ${pid}`);

	// And it says so rather than merely dropping the pipe. A host that is
	// between commands is sitting in a read, which is where a `bye` can actually
	// be seen -- the one above was mid-run and was reaped before it looked.
	register({ chunks: 1 });
	const idle = await b.newPage();
	await idle.goto(APP + '/', { waitUntil: 'domcontentloaded' });
	await sleep(500);
	await idle.evaluate(() => window.__open());
	await idle.evaluate(() => window.__say({ t: 'hello', proto: 1, client: 'verify_hand' }));
	await until(idle, 'hello', 6000);
	await idle.close();
	let log = '';
	for (let i = 0; i < (HOLD_MS + 20000) / 200; i++) {
		await sleep(200);
		log = fs.existsSync(MOCKLOG) ? fs.readFileSync(MOCKLOG, 'utf8') : '';
		if (/"bye"/.test(log)) break;
	}
	check('the relay says bye on the way out, once the hold has run out', /"bye"/.test(log),
		log.split('\n').slice(-3).join(' | '));

	// ── The host is not installed ───────────────────────────────────
	unregister();
	await page.evaluate(() => { try { window.__say({ t: 'bye' }); window.__port.disconnect(); } catch (e) {} });
	await sleep(400);
	await page.evaluate(() => window.__open());
	await page.evaluate(() => window.__say({ t: 'hello', proto: 1, client: 'verify_hand' }));
	all = await until(page, 'error');
	const gone = all.find((m) => m.t === 'error');
	check('a missing host is reported as such', !!gone, JSON.stringify(gone));
	check('and the sentence says exactly what to install',
		!!gone && /install\.sh/.test(gone.message) && /com\.oxedyne\.daimond\.hand/.test(gone.message),
		(gone || {}).message);
	check('it does not merely repeat Chrome\'s own wording',
		!!gone && /cargo build|README/.test(gone.message), '');

	// ── Revocation ──────────────────────────────────────────────────
	//
	// Clicked, not messaged. The Revoke button beside the machine hand is the
	// one a person would press, and it is a plain button in a plain list.
	{
		const pop = await popup();
		await pop.evaluate(() => {
			const li = [...document.querySelectorAll('#granted li')]
				.find((n) => /computer/i.test(n.textContent));
			if (li) li.querySelector('button').click();
		});
		await sleep(700);
		check('revoking from the popup takes the grant back',
			!(await sw.evaluate(() => globalThis.DaimondHand.granted())));
		const text = await pop.evaluate(() => document.body.innerText);
		check('and the popup no longer lists it', !/commands on this computer/i.test(text),
			text.replace(/\n/g, ' / '));
		await pop.close();
	}
} finally {
	await b.close().catch(() => {});
	for (const s of servers) s.close();
	try { fs.rmSync(MOCKDIR, { recursive: true, force: true }); } catch (e) {}
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
