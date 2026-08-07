// verify_handrun.mjs — a daimon runs a command on the machine, end to end.
//
// `dev/verify_hand.mjs` drives the EXTENSION's relay from a stub page: it proves
// order, attribution, gaps and the several ways a native host can vanish. It
// never loads the app, so it proves nothing about the half a user actually
// meets — the model calling `run`, the page relay carrying it, and the output
// coming back as a tool result the model reads. That is this file.
//
// The whole path, in one browser: sign in, connect the mock provider, ask a
// daimon to run a command, approve the machine hand for real in the extension's
// own window, and then read what the MODEL was shown. The assertions are made
// against the mock provider's log rather than against the screen, because the
// question is not "did something appear" but "did the output and the exit code
// reach the model".
//
// It runs against `hand/install/mock_host.py`, not the Rust binary. The host's
// message loop is being written; more to the point, the failures worth testing —
// a hand that says something meaningless for ever, a hand that says nothing at
// all for a minute, a hand that dies mid-command — are things a correct hand
// will never do, so a correct hand cannot be used to test them.
//
// WHAT THIS DOES NOT PROVE. The mock runs nothing. It invents output on a
// schedule and reports whatever exit status it was configured with, so a pass
// here says the pipeline carries a command's output and status faithfully from
// the host to the model. It does NOT say that `cargo test` ran, or that the
// fence held: nothing in this file executes a process, and the fence is the
// hand's to enforce and `hand/REVIEW.md`'s to argue about.
//
// Needs nothing running: the dev server and the mock provider are started here
// if they are not already up. Headed, under xvfb:
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_handrun.mjs
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { open as openApp, chat, transcript, mockLog, clearMockLog, scratch } from './harness.mjs';

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
// The SHIPPED extension. `harness.open` hands this to `dev/extdev.mjs`, which
// loads the development build instead: the shipped manifest names one origin,
// `daimond.oxedyne.com`, and a page on localhost cannot reach it at all. The
// loopback origins live in the generated tree and never in the file a release
// is carved from — see extdev.mjs, and `hand/REVIEW.md` §1.6 for why.
const SRC	= path.join(ROOT, 'ext');
const EXTID	= 'mpliijponglmmffjnonahhignkpkhmij';
const INSTALL	= path.join(ROOT, 'hand/install');
const MOCK	= path.join(INSTALL, 'mock_host.py');
const CFG	= path.join(INSTALL, 'mock_cfg.json');
const PROFILE	= scratch('verify-handrun');

// The folder the hand claims it was granted. Nothing is written there — the
// mock runs nothing — but it must be absolute, because `Tool::run` refuses a
// root that is not, and every fence path is built from it.
const GRANT	= scratch('handroot');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The two servers ─────────────────────────────────────────────────
//
// Both, or nothing works and the reason is invisible: without the mock provider
// every model turn fails and the transcript says only that Daimond could not
// answer, which reads as a broken app rather than a missing server.

function listening(port) {
	return new Promise((resolve) => {
		const s = net.connect(port, '127.0.0.1');
		s.once('connect', () => { s.destroy(); resolve(true); });
		s.once('error', () => resolve(false));
	});
}

const started = [];
async function serve(name, args, port) {
	if (await listening(port)) { console.log(`  (${name} already up on ${port})`); return; }
	const p = spawn('node', args, { cwd: ROOT, stdio: 'ignore', detached: false });
	started.push(p);
	for (let i = 0; i < 100; i++) {
		if (await listening(port)) { console.log(`  (started ${name} on ${port})`); return; }
		await sleep(100);
	}
	throw new Error(`${name} did not come up on ${port}`);
}

// ── The mock hand ───────────────────────────────────────────────────

const HOSTS = path.join(PROFILE, 'NativeMessagingHosts');

/// Point the profile's native messaging host at the mock, with the behaviour
/// this case needs. The host reads its configuration when it starts, so a fresh
/// link picks up a fresh setting — which is why every case closes the link.
function register(cfg) {
	fs.mkdirSync(HOSTS, { recursive: true });
	fs.writeFileSync(path.join(HOSTS, 'com.oxedyne.daimond.hand.json'), JSON.stringify({
		name:		'com.oxedyne.daimond.hand',
		description:	'Mock hand for verify_handrun.mjs.',
		path:		MOCK,
		type:		'stdio',
		allowed_origins: [`chrome-extension://${EXTID}/`],
	}, null, '\t') + '\n');
	fs.writeFileSync(CFG, JSON.stringify(Object.assign({
		// What a Linux hand with a working fence reports, plus the granted
		// folder. The folder arrives as a CAPABILITY because `wire.rs` has no
		// field for it and the wire is fixed; see ROOT_CAP in www/js/hand.js.
		caps: ['fence:linux', 'landlock:abi-8', 'carve:sealed', `root:${GRANT}`],
	}, cfg || {}), null, '\t') + '\n');
}
function unregister() {
	try { fs.rmSync(path.join(HOSTS, 'com.oxedyne.daimond.hand.json')); } catch (e) { /* gone */ }
}

// ── What the model was shown ────────────────────────────────────────

/// The last tool result the model was sent, which is the whole point of the
/// exercise: a run that draws output on screen and hands the model nothing has
/// achieved nothing.
function toolResult() {
	const reqs = mockLog();
	for (let i = reqs.length - 1; i >= 0; i--) {
		const msgs = reqs[i].messages || [];
		for (let j = msgs.length - 1; j >= 0; j--) {
			if (msgs[j].role === 'tool') return String(msgs[j].content || '');
		}
	}
	return '';
}

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
fs.mkdirSync(GRANT, { recursive: true });
register({ chunks: 3 });

// What the children will bind: `serve.mjs` reads DAIMOND_PORT and `mockllm.mjs`
// DAIMOND_MOCK_PORT, so the wait below is asking about the port they chose.
const APP_PORT  = Number(process.env.DAIMOND_PORT || 8777);
const MOCK_PORT = Number(process.env.DAIMOND_MOCK_PORT || 9099);
await serve('dev server', ['dev/serve.mjs'], APP_PORT);
await serve('mock provider', ['dev/mockllm.mjs'], MOCK_PORT);

// Signed in, pointed at the mock provider, with the extension loaded — the app
// as a user meets it. Headed and on a fixed profile, because the host manifest
// above was written into that profile's own NativeMessagingHosts directory,
// which is where a browser started with --user-data-dir looks for it.
const s = await openApp({ headed: true, name: 'handrun', extension: SRC, profile: PROFILE });
const b = s.browser;
const page = s.page;

/// Find the grant window and click Allow, in the background, while the turn
/// that provoked it is still running. It is the extension's own page, so the
/// click is a real one — and for this question there is no second Chrome prompt
/// behind it: this window IS the approval.
async function allowHand(ms = 20000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const p of b.pages()) {
			if (/grant\.html/.test(p.url())) {
				await p.waitForLoadState('domcontentloaded').catch(() => {});
				await sleep(300);
				const head = await p.evaluate(() =>
					(document.getElementById('head') || {}).textContent || '').catch(() => '');
				await p.click('#allow').catch(() => {});
				return head;
			}
		}
		await sleep(150);
	}
	return null;
}

try {
	await sleep(500);

	check('the extension announced itself to the app',
		await page.evaluate(() => !!document.documentElement.dataset.daimondHands));
	check('the page relay is loaded and wired',
		await page.evaluate(() => !!(window.DaimondHand && window.DaimondHand.run)));

	/// The waits are tens of seconds by design; a test cannot spend them.
	async function waits(o) {
		return await page.evaluate((x) => window.DaimondHand._setWaitsForTest(x), o);
	}
	/// Let go of the link, so the next case gets a fresh host with fresh
	/// configuration. The relay keeps one port for the life of the page.
	async function relink() {
		await page.evaluate(() => window.DaimondHand.close());
		await sleep(400);
	}

	await waits({ grace: 4000, slack: 2000, hello: 15000 });

	// ── A command runs, and its output reaches the model ────────────
	clearMockLog();
	const grant = allowHand();
	await chat(s, '@tool run {"argv":["cargo","test"],"timeout_ms":20000}', { timeout: 60000 });
	const head = await grant;
	check('running a command asks the user first, in the extension\'s own window',
		!!head && /computer/i.test(head), String(head));

	// The belt the model was actually offered, taken from what the provider was
	// sent rather than from a list in the page.
	const belt = (mockLog()[0] || {}).tools || [];
	check('`run` is in the toolbelt the model is offered', belt.includes('run'), belt.join(' '));

	let r = toolResult();
	check('the command\'s output reached the model',
		/line 1 of cargo test/.test(r) && /line 3 of cargo test/.test(r), r.slice(0, 200));
	check('so did what it wrote on standard error',
		/\[stderr\] a word from standard error/.test(r), r.slice(0, 300));
	check('and the exit code', /\[exit code: 0\]/.test(r), r.slice(-120));
	check('the output is marked as a stranger\'s words, naming the command',
		/untrusted content begins — run: cargo test/.test(r), r.slice(0, 120));
	check('the person watching saw it too, as it arrived',
		/line 1 of cargo test/.test(await transcript(s)), '');

	// ── A failure is reported as a failure ──────────────────────────
	await relink();
	register({ chunks: 1, exit: 3 });
	clearMockLog();
	await chat(s, '@tool run {"argv":["make"],"timeout_ms":20000}', { timeout: 60000 });
	r = toolResult();
	check('a non-zero exit reaches the model as itself',
		/\[exit code: 3\]/.test(r) && !/exit code: 0/.test(r), r.slice(-160));

	// ── A hole in the stream is shown to the model ──────────────────
	//
	// The first chunk of a stream sets the baseline — where a hand starts
	// counting is its own business — so this is what proves the marker still
	// fires when there is a real hole rather than merely a different origin.
	await relink();
	register({ chunks: 3, gap: true });
	clearMockLog();
	await chat(s, '@tool run {"argv":["patchy"],"timeout_ms":20000}', { timeout: 60000 });
	r = toolResult();
	check('a hole in the output is shown to the model, not stitched over',
		/output missing: expected chunk/.test(r), r.slice(0, 300));
	await relink();
	register({ chunks: 2 });
	clearMockLog();
	await chat(s, '@tool run {"argv":["tidy"],"timeout_ms":20000}', { timeout: 60000 });
	r = toolResult();
	check('and an ordinary run carries no such marker', !/output missing/.test(r), r.slice(0, 200));

	// ── §4.4 The output is bounded, and says where it was cut ───────
	await relink();
	register({ chunks: 3000 });
	await waits({ keep: 400 });
	clearMockLog();
	await chat(s, '@tool run {"argv":["flood"],"timeout_ms":20000}', { timeout: 60000 });
	r = toolResult();
	check('a command that prints too much does not go unbounded into the tab',
		r.length < 20000, `${r.length} chars`);
	check('and the hole is named where it happened, not smoothed over',
		/characters of output are missing here/.test(r), r.slice(0, 200));
	check('both ends of the output are kept: the start …',
		/line 1 of flood/.test(r), '');
	check('… and the end, which is where a build says why it failed',
		/line 3000 of flood/.test(r), r.slice(-200));
	await waits({ keep: 262144 });

	// ── §4.3 A quiet command is not a dead one ──────────────────────
	//
	// The grace is four seconds here and the host says nothing for six after
	// `started`. Under the old rule — the wait refreshed only by output — this
	// was rejected as "stopped part-way through the command" while the process
	// was still running, which is exactly the `cargo test` case.
	await relink();
	register({ chunks: 2, quiet_ms: 6000 });
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"],"timeout_ms":30000}', { timeout: 90000 });
	r = toolResult();
	check('a command that says nothing for longer than the grace still finishes',
		/line 1 of cargo test/.test(r) && /\[exit code: 0\]/.test(r), r.slice(0, 200));

	// ── §4.2 Noise is not proof of life ─────────────────────────────
	//
	// The host sends a message the page does not understand, three times a
	// second, and nothing else at all. Anything that refreshes the wait on
	// receipt of a message rather than on receipt of a MEANINGFUL one waits for
	// ever here, and the daimon never speaks again.
	await relink();
	register({ noise_ms: 300 });
	clearMockLog();
	const t0 = Date.now();
	await chat(s, '@tool run {"argv":["noisy"],"timeout_ms":600000}', { timeout: 60000 });
	const took = Date.now() - t0;
	r = toolResult();
	check('a host that says only meaningless things does not hold the model for ever',
		took < 30000, `${took} ms, grace 4000`);
	check('and the daimon is told what happened, in one plain sentence',
		/^Refused: /.test(r) && /did not acknowledge/.test(r), r.slice(0, 200));
	check('nothing was invented about a command that never started',
		!/exit code/.test(r), r.slice(0, 200));

	// ── §1.16 A hand that dies is not a hand that was never there ───
	await relink();
	register({ crash: true });
	clearMockLog();
	await chat(s, '@tool run {"argv":["boom"],"timeout_ms":20000}', { timeout: 60000 });
	r = toolResult();
	check('a hand that crashes mid-command says so',
		/disconnected|stopped|crash/i.test(r), r.slice(0, 300));
	check('and does NOT tell the user to install what they have already installed',
		!/not installed/i.test(r), r.slice(0, 300));

	// ── Gate 1: a hand that cannot fence is refused ─────────────────
	await relink();
	register({ chunks: 1, caps: ['mock', `root:${GRANT}`] });
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"]}', { timeout: 60000 });
	r = toolResult();
	check('a hand that does not say it can fence is refused',
		/^Refused:/.test(r) && /fence/i.test(r), r.slice(0, 200));
	check('and nothing ran', !/line 1 of/.test(r), r.slice(0, 200));

	await relink();
	register({ chunks: 1, caps: ['fence:none', `root:${GRANT}`] });
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"]}', { timeout: 60000 });
	r = toolResult();
	check('a hand that says it CANNOT fence is refused in its own words',
		/^Refused:/.test(r) && /cannot fence/i.test(r), r.slice(0, 200));

	// ── No root, no fence to express ────────────────────────────────
	await relink();
	register({ chunks: 1, caps: ['fence:linux', 'landlock:abi-8'] });
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"]}', { timeout: 60000 });
	r = toolResult();
	check('a hand that will not name the granted folder is refused',
		/folder/i.test(r) && !/line 1 of/.test(r), r.slice(0, 240));

	// ── Nothing installed at all ────────────────────────────────────
	await relink();
	unregister();
	clearMockLog();
	await chat(s, '@tool run {"argv":["cargo","test"]}', { timeout: 60000 });
	r = toolResult();
	check('a missing host is reported as a missing host',
		/not installed/i.test(r), r.slice(0, 240));
	check('and the sentence says exactly what to install',
		/install\.sh/.test(r) && /com\.oxedyne\.daimond\.hand/.test(r), r.slice(0, 400));

	// ── §1.16 again, where it actually bites ────────────────────────
	//
	// The crash above is announced BY the extension, which writes its own
	// sentence, so it does not discriminate between the two behaviours. This
	// does: the link dies with nobody saying anything, which is what an
	// extension reload, an evicted worker or a lost pipe looks like from the
	// page. Every disconnect used to be answered with "the hand is not
	// installed" — advice to install software the user has already installed.
	//
	// Driven through the relay rather than the model, because the model's turn
	// would have to be held open across the reload for no gain.
	await relink();
	register({ chunks: 5, delay_ms: 1500 });
	// The same shape `Tool::run` composes — the extension vets the fence now
	// (`hand/REVIEW.md` §1.5), and rightly refuses one that names no root.
	await page.evaluate((grant) => {
		window.__handrun = window.DaimondHand.run(JSON.stringify({
			t: 'exec', id: 'r-reload', argv: ['sleep'], cwd: grant, env: [], stdin: null,
			timeout_ms: 60000, capture: 'both',
			fence: { rw: [grant], ro: [], deny: [], net: false },
		})).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
	}, GRANT);
	await sleep(1500);
	const sw = b.serviceWorkers()[0];
	if (sw) await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
	const lost = await page.evaluate(() => window.__handrun);
	check('a link that dies with nobody saying why is reported as a hand that STOPPED',
		!!lost.err && /answered earlier and has now gone/.test(lost.err), JSON.stringify(lost).slice(0, 300));
	check('and not as one that was never installed',
		!!lost.err && !/is not installed|it is not installed/i.test(lost.err),
		JSON.stringify(lost).slice(0, 300));

	// 502s are the gateway proxy answering for a gateway nobody started; the
	// browser-only tiers carry on without it, which is what `dev/serve.mjs` says.
	const noise = s.errs.filter((e) => !/favicon|ERR_ABORTED|502|Bad Gateway/i.test(e));
	check('the page threw nothing along the way', noise.length === 0, noise.slice(0, 3).join(' | '));
} finally {
	await b.close().catch(() => {});
	for (const p of started) { try { p.kill(); } catch (e) { /* already gone */ } }
	try { fs.rmSync(CFG); } catch (e) { /* never written */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
