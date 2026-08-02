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
// Needs nothing else running. Run it headed, under xvfb:
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

const ROOT	= '/home/jason/usr/code/web/apps/oxedyne/daimond';
const EXT	= `${ROOT}/ext`;
const INSTALL	= `${ROOT}/hand/install`;
const MOCK	= `${INSTALL}/mock_host.py`;
const CFG	= `${INSTALL}/mock_cfg.json`;
const MOCKLOG	= `${INSTALL}/mock_host.log`;
// Not /tmp -- see the SCRATCH note in harness.mjs.
const SCRATCH	= process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const PROFILE	= path.join(SCRATCH, 'verify-hand');
// The stub page only has to be on an origin the manifest lets speak to the
// extension. It is not the app: nothing here needs the app.
const PORT	= Number(process.env.HAND_PORT || 8777);
const APP	= `http://127.0.0.1:${PORT}`;

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
window.__say = function (m) { window.__port.postMessage(m); };
window.__exec = function (id, argv) {
	window.__say({ t: 'exec', id, argv, cwd: '/tmp', env: [], stdin: null,
		timeout_ms: 60000, capture: 'both', fence: { rw: [], ro: [], deny: [], net: false } });
};
</script></body>`;

const server = http.createServer((req, res) => {
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(PAGE);
});
await new Promise((resolve, reject) => {
	server.once('error', reject);
	server.listen(PORT, '127.0.0.1', resolve);
}).catch((e) => {
	console.error(`Could not serve on ${APP}: ${e.message}. Stop whatever holds the port, or set HAND_PORT.`);
	process.exit(2);
});

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
register({ chunks: 3 });

const b = await chromium.launchPersistentContext(PROFILE, {
	executablePath:	CHROME,
	headless:	false,
	args: ['--no-sandbox', '--disable-dev-shm-usage',
		`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
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

/// Finds the grant window and clicks Allow. It is the extension's own page, so
/// a click here is a real click, and for this question there is no second Chrome
/// prompt behind it — this window IS the approval.
async function allowHand(ms = 8000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const p of b.pages()) {
			if (/grant\.html/.test(p.url())) {
				await p.waitForLoadState('domcontentloaded');
				await sleep(300);
				const head = await p.evaluate(() => (document.getElementById('head') || {}).textContent || '');
				await p.click('#allow');
				return head;
			}
		}
		await sleep(150);
	}
	return null;
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

	// ── The grant ───────────────────────────────────────────────────
	check('the hand is not granted before it is asked',
		!(await sw.evaluate(() => globalThis.DaimondHand.granted())));

	await page.evaluate(() => window.__open());
	await page.evaluate(() => window.__say({ t: 'hello', proto: 1, client: 'verify_hand' }));
	const head = await allowHand();
	check('opening the port asks the user, in the extension\'s own window', !!head, String(head));
	check('the question is about this computer, not about a site',
		/computer/i.test(head || ''), String(head));

	let all = await until(page, 'hello');
	const hello = all.find((m) => m.t === 'hello');
	check('the hand answers the handshake', !!hello, JSON.stringify(hello));
	check('the answer is the host\'s own, relayed untouched',
		!!hello && hello.proto === 1 && /mock/.test(hello.host || ''), JSON.stringify(hello));
	check('the grant is now recorded',
		await sw.evaluate(() => globalThis.DaimondHand.granted()));

	// The popup is where a person goes to see what they have allowed and to take
	// it back, so the machine hand has to be findable there beside the sites --
	// in words, not as the sentinel the code passes around.
	{
		const pop = await popup();
		const text = await pop.evaluate(() => document.body.innerText);
		check('the popup lists it among what the user has allowed',
			/commands on this computer/i.test(text), text.replace(/\n/g, ' / '));
		check('and offers to revoke it', await pop.evaluate(() => {
			const li = [...document.querySelectorAll('#granted li')]
				.find((n) => /computer/i.test(n.textContent));
			return !!(li && li.querySelector('button'));
		}));
		await pop.close();
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

	// ── A gap is announced, not hidden ──────────────────────────────
	register({ chunks: 3, gap: true });
	await page.evaluate(() => { window.__port.disconnect(); });
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
	await page.evaluate(() => { window.__port.disconnect(); });
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
	await page.evaluate(() => { window.__port.disconnect(); });
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
	// The host dies when its port closes. Poll rather than guess: the mock is
	// mid-sleep and only notices its stdin has gone when it comes back up.
	let alive = true;
	for (let i = 0; i < 60 && alive; i++) {
		await sleep(200);
		alive = fs.existsSync(`/proc/${pid}`);
	}
	check('a page that goes away leaves no orphan behind', !alive, `pid ${pid}`);

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
	for (let i = 0; i < 30; i++) {
		await sleep(200);
		log = fs.existsSync(MOCKLOG) ? fs.readFileSync(MOCKLOG, 'utf8') : '';
		if (/"bye"/.test(log)) break;
	}
	check('the relay says bye on the way out', /"bye"/.test(log),
		log.split('\n').slice(-3).join(' | '));

	// ── The host is not installed ───────────────────────────────────
	unregister();
	await page.evaluate(() => { try { window.__port.disconnect(); } catch (e) {} });
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
	server.close();
	try { fs.rmSync(CFG); } catch (e) {}
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
