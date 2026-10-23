// gateway: none
// verify_handbfcache.mjs — the hand after Back restores the page from the back/forward cache.
//
// WHY THIS FILE EXISTS. On 2026-10-11 the owner's hand check showed, in the Daimond
// Hands extension, "Unchecked runtime.lastError: The page keeping the extension port
// is moved into back/forward cache, so the message channel is closed." Chrome closes
// every extension port of a page it puts in the bfcache, and the page that comes back
// on Back is the SAME document, with its JavaScript state intact -- including a port
// object that is now dead and a link record that still says "greeted". A reload is a
// fresh document and `verify_handreload.mjs` covers it; this is the other way a page
// leaves and returns, and nothing looked at it.
//
// THE PROPERTY:
//
//	A PAGE RESTORED FROM THE BFCACHE REACHES THE HAND AGAIN, AND NEITHER END
//	LEAVES A runtime.lastError UNREAD ON THE WAY.
//
// The restore itself is asserted (`pageshow.persisted === true`), or a run where the
// browser simply reloaded would pass for the wrong reason. The console oracle is
// proved live first: a marker logged from the extension's worker must be seen.
//
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_handbfcache.mjs [--keep]
//
// Headed, because Chromium loads an unpacked extension in no other mode. Serves its
// own pages on its own port from 8877, into its own profile, journal and folder.
import './predeploy_guard.mjs';	// first: deploy first, refuses (41) this suite on code that is not live (D-20261023-04)
import { port } from './ports.mjs';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import './display.mjs';
const { chromium } = await import('./pw.mjs');
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const WWW	= path.join(ROOT, 'www');
const INSTALL	= path.join(ROOT, 'hand/install/install.sh');
const HAND	= path.join(ROOT, 'hand/target/release/daimond-hand');
const SCRATCH	= process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const KEEP	= process.argv.includes('--keep');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE	= path.join(SCRATCH, `handbfcache-${process.pid}`);
const PROFILE	= path.join(BASE, 'profile');
const JOURNAL	= path.join(BASE, 'journal');
const GRANT	= path.join(BASE, 'work');
const HOSTS	= path.join(PROFILE, 'NativeMessagingHosts');
fs.rmSync(BASE, { recursive: true, force: true });
for (const d of [PROFILE, JOURNAL, GRANT, HOSTS]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(JOURNAL, 0o700);	// a journal others can read is a refusal to start

const { extDev } = await import(pathToFileURL(path.join(HERE, 'extdev.mjs')).href);
const PORT = port('handbfcache');
const EXT = path.join(BASE, 'ext');
fs.cpSync(await extDev(PORT), EXT, { recursive: true });

// Nothing here may make the page ineligible for the bfcache: no `unload`, no
// `Cache-Control: no-store`. `__shows` records every pageshow, so the restore is
// asserted rather than assumed.
const PAGE = (src) => `<!doctype html><meta charset="utf-8"><title>handbfcache</title>
<body><h1>handbfcache</h1><a id="away" href="http://localhost:${PORT}/away">away</a>
<script src="${src}"></script>
<script>
window.__shows = [];
window.__ports = [];
(function () {
	/* Every port the page opens, and how it ended: the page side of the bfcache close. */
	if (!(window.chrome && chrome.runtime && chrome.runtime.connect)) return;
	var c = chrome.runtime.connect;
	chrome.runtime.connect = function () {
		var p = c.apply(chrome.runtime, arguments);
		var r = { at: Date.now(), gone: 0, posts: 0, threw: '', msgs: 0 };
		window.__ports.push(r);
		p.onDisconnect.addListener(function () { r.gone = Date.now(); });
		p.onMessage.addListener(function (m) { r.msgs++; r.last = m && m.t; });
		var post = p.postMessage.bind(p);
		p.postMessage = function (m) {
			r.posts++;
			try { return post(m); } catch (e) { r.threw = String(e && e.message); throw e; }
		};
		return p;
	};
})();
window.addEventListener('pageshow', function (e) { window.__shows.push(!!e.persisted); });
window.__why = function (e) { return 'ERR ' + ((e && e.message) || e); };
window.__status = function () { return DaimondHand.status().then(function (s) { return String(s); }, window.__why); };
window.__close  = function () { DaimondHand.close(); return 'closed'; };
window.__run    = function (spec) { return DaimondHand.run(JSON.stringify(spec)).then(function (r) { return r; }, window.__why); };
</script></body>`;
const AWAY = '<!doctype html><meta charset="utf-8"><title>away</title><body><h1>away</h1></body>';

// THE PAGE THAT KEEPS ITS PORT. The relay lets go of its port on `pagehide`, so
// Chrome's own bfcache close -- the one the owner saw -- only reaches the extension
// when that letting-go loses the race or never happens. `/keep` serves the relay
// with the letting-go taken out, so the close is Chrome's every time, as the
// extension must be ready to meet it whatever the page did.
const LETGO = /\twindow\.addEventListener\('pagehide', function \(\) \{[^\n]*letGo\(false\); \}\);/;
const handJs = (keep) => {
	const js = fs.readFileSync(path.join(WWW, 'js/hand.js'), 'utf8');
	if (!keep) return js;
	if (!LETGO.test(js)) { console.error('www/js/hand.js no longer has the pagehide line /keep removes'); process.exit(2); }
	return js.replace(LETGO, '');
};
const server = http.createServer((req, res) => {
	const url = req.url || '';
	if (/^\/js\/hand(-keep)?\.js/.test(url)) {
		res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
		res.end(handJs(/-keep/.test(url)));
		return;
	}
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(/^\/away/.test(url) ? AWAY : PAGE(/^\/keep/.test(url) ? '/js/hand-keep.js' : '/js/hand.js'));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// The hand: `CARGO_TARGET_DIR` is dropped so cargo writes the binary `HAND` names.
const buildEnv = { ...process.env };
delete buildEnv.CARGO_TARGET_DIR;
if (!process.env.DAIMOND_NO_BUILD) {
	const r = spawnSync('cargo', ['build', '--release', '--manifest-path', 'hand/Cargo.toml'],
		{ cwd: ROOT, encoding: 'utf8', env: buildEnv });
	if (r.status !== 0) console.log((r.stderr || '').split('\n').filter((l) => /^error/.test(l)).slice(0, 5).join('\n'));
}
check('the hand is built', fs.existsSync(HAND), HAND);
if (!fs.existsSync(HAND)) { console.log(`\n${ok.length} ok, ${bad.length} failed`); process.exit(1); }
fs.writeFileSync(path.join(JOURNAL, 'root.txt'),
	`# The one folder Daimond's machine hand may work in.\n${GRANT}\n`);
process.env.DAIMOND_HAND_JOURNAL_DIR = JOURNAL;
delete process.env.DAIMOND_HAND_ROOT;
const inst = spawnSync('bash', [INSTALL, '--dir', HOSTS, HAND], { cwd: ROOT, encoding: 'utf8' });
check('install.sh registers the real binary in this run\'s own profile',
	inst.status === 0 && fs.existsSync(path.join(HOSTS, 'com.oxedyne.daimond.hand.json')),
	(inst.stderr || inst.stdout || '').trim().split('\n').slice(-2).join(' '));

const said = [];
const b = await chromium.launchPersistentContext(PROFILE, {
	executablePath:	CHROME,
	headless:	false,
	args: ['--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
		'--enable-logging=stderr', '--v=0'],
	// Playwright turns the bfcache off by default; the restore is the whole subject here.
	ignoreDefaultArgs: ['--disable-back-forward-cache'],
	// An unchecked lastError is reported natively, not through console.error, so the
	// worker's console event may never carry it. Chrome's own log does; Playwright hands
	// the browser's stderr to this logger.
	logger: {
		isEnabled: (name) => name === 'browser',
		log: (name, sev, msg) => { if (/lastError|CONSOLE/.test(String(msg))) said.push(`[log] ${msg}`); },
	},
	viewport: { width: 1100, height: 700 },
});

// ── The console oracle: every page and the extension's worker ──────
const listen = (who) => (m) => said.push(`[${who}] ${m.type()}: ${m.text()}`);
b.on('console', (m) => {
	// The context's own event carries page messages; the worker's are wired below.
	said.push(`[ctx] ${m.type()}: ${m.text()}`);
});
let sw = b.serviceWorkers()[0];
if (!sw) sw = await b.waitForEvent('serviceworker', { timeout: 10000 }).catch(() => null);
check('the extension\'s worker is running', !!sw);
const wired = new WeakSet();
const wire = (w) => { if (w && !wired.has(w)) { wired.add(w); w.on('console', listen('sw')); } };
wire(sw);
b.on('serviceworker', wire);
if (sw) {
	await sw.evaluate(() => console.error('bfcache-probe-mark'));
	await sleep(300);
}
// And Chrome's own log of the worker, over CDP: an unchecked lastError is reported
// natively, and may arrive as a Log entry the console event never carries.
{
	const tab = await b.newPage();
	const cdp = await b.newCDPSession(tab);
	const { targetInfos } = await cdp.send('Target.getTargets');
	const swt = targetInfos.find((t) => t.type === 'service_worker' && /background\.js/.test(t.url));
	if (swt) {
		const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: swt.targetId, flatten: false });
		let n = 0;
		const ask = (method) => cdp.send('Target.sendMessageToTarget',
			{ sessionId, message: JSON.stringify({ id: ++n, method }) }).catch(() => {});
		cdp.on('Target.receivedMessageFromTarget', (e) => {
			let m; try { m = JSON.parse(e.message); } catch (x) { return; }
			if (m.method === 'Log.entryAdded') said.push(`[swlog] ${m.params.entry.level}: ${m.params.entry.text}`);
			if (m.method === 'Runtime.consoleAPICalled') said.push(`[swrt] ${m.params.type}: ${(m.params.args || []).map((a) => a.value).join(' ')}`);
			if (m.method === 'Runtime.exceptionThrown') said.push(`[swex] ${JSON.stringify(m.params.exceptionDetails).slice(0, 300)}`);
		});
		await ask('Log.enable');
		await ask('Runtime.enable');
		await sw.evaluate(() => console.error('bfcache-probe-mark2'));
		await sleep(300);
	}
	note(`worker log over CDP: ${swt ? 'attached' : 'no worker target'}; ` + said.filter((x) => /mark2/.test(x)).join(' | '));
}
check('the oracle hears the extension\'s worker', said.some((s) => s.includes('bfcache-probe-mark')),
	said.slice(-3).join(' | '));

const HOLD_S = (() => {
	const m = /const HOLD_MS = (\d+);/.exec(fs.readFileSync(path.join(ROOT, 'ext/hand.js'), 'utf8'));
	if (!m) { console.error('ext/hand.js no longer names HOLD_MS'); process.exit(2); }
	return Number(m[1]) / 1000;
})();
function alive(pid) {
	if (!pid || !Number.isInteger(pid)) return false;
	try {
		const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
		return st.slice(st.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
	} catch (e) { return false; }
}

async function grant(ms = 15000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const p of b.pages()) {
			if (/grant\.html/.test(p.url())) {
				await p.waitForLoadState('domcontentloaded');
				await sleep(250);
				try { await p.click('#allow', { timeout: 3000 }); } catch (e) { continue; }
				return true;
			}
		}
		await sleep(150);
	}
	return false;
}

const spec = (id, cmd) => ({
	t: 'exec', id, argv: ['bash', '-c', cmd],
	cwd: GRANT, env: [], stdin: null, timeout_ms: 15000, capture: 'both',
	fence: { rw: [GRANT], ro: [], deny: [], net: false }, toolkits: [],
});
const parse = (s) => { try { return JSON.parse(s); } catch (e) { return { raw: String(s) }; } };
const runIn = (page, id, cmd) => page.evaluate((s) => Promise.race([
	window.__run(s),
	new Promise((r) => setTimeout(() => r('ERR no answer in 20 s'), 20000)),
]), spec(id, cmd)).then(parse);

/// Opens the probe page in a fresh tab, with Chrome's own account of any bfcache refusal.
async function opened(where) {
	const page = await b.newPage();
	const notUsed = [];
	const cdp = await b.newCDPSession(page);
	await cdp.send('Page.enable');
	cdp.on('Page.backForwardCacheNotUsed', (e) => notUsed.push(JSON.stringify(e.notRestoredExplanations || e)));
	await page.goto(`http://127.0.0.1:${PORT}${where}`, { waitUntil: 'domcontentloaded' });
	await sleep(500);
	return { page, notUsed };
}

/// Ends an arm: the page says goodbye so its hand stops at once (one hand holds the
/// journal at a time), and the tab goes.
const uncheckedNow = () => said.filter((s) => /Unchecked runtime\.lastError/.test(s)).length;
async function done({ page }, tag) {
	note(`${tag}: unchecked lastErrors so far: ${uncheckedNow()}`);
	try { await page.evaluate(() => window.__close()); } catch (e) { /* page gone */ }
	await page.close();
	await sleep(1500);
}

/// Away to another site, and Back; asserts the restore came from the bfcache.
async function awayAndBack(tag, { page, notUsed }) {
	await page.click('#away');
	await page.waitForURL(/\/away/);
	await sleep(1500);
	await page.goBack({ waitUntil: 'commit' });	// a restore fires no load event
	await sleep(800);
	const shows = await page.evaluate(() => window.__shows.slice());
	check(`${tag}: Back restored the page from the bfcache (pageshow.persisted === true)`,
		shows.length >= 2 && shows[shows.length - 1] === true,
		JSON.stringify(shows) + (notUsed.length ? ' not used: ' + notUsed.join(' ; ') : ''));
}

// ── A. The relay as shipped: away, Back, and a command ──────────────
const A = await opened('/');
const statusP = A.page.evaluate(() => window.__status());
check('A: the grant window opened and was answered', await grant());
const status = parse(await statusP);
check('A: the real hand answered before the page went away',
	status && status.transport === 'machine' && status.root === GRANT, JSON.stringify(status).slice(0, 200));
const one = await runIn(A.page, 'run-a1', 'echo BEFORE');
check('A: a command runs through the hand before the page goes away',
	one.exit === 0 && /BEFORE/.test(one.stdout || ''), JSON.stringify(one).slice(0, 200));
await awayAndBack('A', A);
const twoP = runIn(A.page, 'run-a2', 'echo AFTER');
note(`A: grant window after Back: ${await grant(4000) ? 'shown and answered' : 'not shown'}`);
const two = await twoP;
check('A: after Back, the restored page still reaches the hand (a command runs)',
	two.exit === 0 && /AFTER/.test(two.stdout || ''), JSON.stringify(two).slice(0, 300));
await done(A, 'A');

// ── B. A page that keeps its port into the bfcache ──────────────────
//
// Chrome closes the port itself, and the extension's end is told so through
// `runtime.lastError` -- the owner's message, when nobody reads it.
const B = await opened('/keep');
const bStatusP = B.page.evaluate(() => window.__status());
await grant(6000);
note('B: ' + String(await bStatusP).slice(0, 80));
const b1 = await runIn(B.page, 'run-b1', 'echo KEEP');
check('B: a command runs before the page goes away', b1.exit === 0, JSON.stringify(b1).slice(0, 200));
await awayAndBack('B', B);
const b2P = runIn(B.page, 'run-b2', 'echo KEPT');
await grant(4000);
const b2 = await b2P;
check('B: after Back, a page whose port Chrome closed reaches the hand again',
	b2.exit === 0 && /KEPT/.test(b2.stdout || ''), JSON.stringify(b2).slice(0, 300));
note('B: page ports: ' + JSON.stringify(await B.page.evaluate(() => window.__ports)));
await done(B, 'B');

// ── C. Back inside the grace, then nothing ──────────────────────────
//
// A person who goes Back and then reads for a minute has not left. The page is
// the same document with the same runs, so it takes its hand back on `pageshow`
// rather than on its next command -- or the grace runs out under it and the
// standing process it left (a dev server, typically) is stopped.
const C = await opened('/');
const cStatusP = C.page.evaluate(() => window.__status());
await grant(6000);
note('C: ' + String(await cStatusP).slice(0, 80));
const c1 = await runIn(C.page, 'run-c1', 'sleep 300 </dev/null >/dev/null 2>&1 & echo LEFT=$!');
const leftPid = Number((/LEFT=(\d+)/.exec(c1.stdout || '') || [])[1] || 0);
check('C: a command leaves a process standing', c1.exit === 0 && alive(leftPid), `pid ${leftPid}`);
await awayAndBack('C', C);
await grant(3000);
await sleep((HOLD_S + 6) * 1000);
check(`C: Back, then ${HOLD_S + 6} s idle: the standing process is still running`,
	alive(leftPid), `pid ${leftPid}`);
note('C: page ports: ' + JSON.stringify(await C.page.evaluate(() => window.__ports)));
try { if (alive(leftPid)) process.kill(leftPid, 'SIGKILL'); } catch (e) { /* gone */ }
await done(C, 'C');

await sleep(1000);
const unchecked = said.filter((s) => /Unchecked runtime\.lastError/.test(s));
check('no runtime.lastError is left unchecked, in the page or the extension',
	unchecked.length === 0, unchecked.join(' | ').slice(0, 400));
for (const s of said) if (!/bfcache-probe-mark/.test(s)) note(s.slice(0, 200));

await b.close();
server.close();
if (!KEEP) fs.rmSync(BASE, { recursive: true, force: true });
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
