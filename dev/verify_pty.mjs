// verify_pty.mjs — the terminal relay, bytes and all, against a real host
// process.
//
// `www/js/handpty.js` is the page half of a pty session: it composes no fence,
// owns no transport, and does exactly three things worth testing. It carries
// bytes without touching them, it says so when bytes are missing, and it tells a
// hand that STOPPED apart from one that was never installed. This drives all
// three in a real browser.
//
// ── What it runs against ────────────────────────────────────────────
//
// `dev/mock_pty_host.py`, spawned as a real process, speaking Chrome's native
// messaging framing and the pty half of `hand/src/wire.rs`. It is a copy of
// `hand/install/mock_host.py` with the terminal messages added, because that
// file belongs to whoever is teaching the hand about terminals; when the real
// one speaks pty, this copy should go and the constant below point at it.
//
// The oracle for the byte path is deliberately three independent
// implementations: Python's `base64` encodes, the browser's `atob` decodes, and
// Node's `Buffer` compares. A payload that survives that is not surviving one
// library's agreement with itself. The payload carries NULs, a lone
// continuation byte, a truncated sequence, a surrogate encoding and every byte
// value from 0 to 255, and one `output` frame boundary is placed THROUGH the
// middle of a multi-byte character, which is exactly the case a text conversion
// would quietly destroy.
//
// ── What it does NOT prove ──────────────────────────────────────────
//
// The link between the page and the host is a bridge in this file, not the
// extension, for one reason: `ext/hand.js` refuses a message type it does not
// know, and `open`, `input` and `resize` are not yet among them (see the report
// accompanying this file). So this proves the page relay and the wire, and it
// does not prove the extension forwards a pty message or that the hand
// allocates a terminal. `dev/verify_hand.mjs` is where the extension's own half
// is proved, and this file should grow the same end-to-end phase the day the
// extension carries these messages.
//
// It also does not prove anything about the fence. The fence is composed by
// `fence_spec` in `src/tools.rs`, vetted by the extension and enforced by the
// hand; the only thing tested here is that a request arriving WITHOUT one is
// refused rather than sent, because this relay must never be the place a weaker
// path to the machine begins.
//
// Headless, and needs nothing running for the first phase. The app phase starts
// the dev server and the mock provider itself if they are not already up —
// without the mock provider every model turn fails and the transcript says only
// that Daimond could not answer, which reads as a broken app rather than a
// missing server.
//
//	node dev/verify_pty.mjs
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const RELAY	= path.join(ROOT, 'www/js/handpty.js');
const HANDJS	= path.join(ROOT, 'www/js/hand.js');
const MOCK	= path.join(HERE, 'mock_pty_host.py');
// Not /tmp -- see the SCRATCH note in harness.mjs.
const SCRATCH	= process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const WORK	= path.join(SCRATCH, `verify-pty-${process.pid}`);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// ── The payload ─────────────────────────────────────────────────────
//
// Everything a terminal actually carries and a string cannot. The offsets
// matter: `SPLITS` cuts the euro sign in half, so the two halves of one
// character travel in different frames and only an exact byte path puts it back
// together.

const HEAD	= Buffer.from('hello ', 'ascii');
const EURO	= Buffer.from([0xe2, 0x82, 0xac]);		// one character, three bytes
const NASTY	= Buffer.from([
	0x00, 0x00,			// NUL, which a C string ends at
	0x80, 0x81,			// continuation bytes with nothing to continue
	0xc3,				// a two-byte sequence that stops after one
	0xed, 0xa0, 0x80,		// a surrogate, which UTF-8 forbids outright
	0xf0, 0x28, 0x8c, 0x28,		// a four-byte sequence that is not one
	0xff, 0xfe,			// bytes that never appear in UTF-8 at all
]);
const ALL	= Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const PAYLOAD	= Buffer.concat([HEAD, EURO, Buffer.from('\r\n'), NASTY, ALL, NASTY]);
// Through the middle of the euro sign, and then twice more.
const SPLITS	= [HEAD.length + 1, HEAD.length + 12, HEAD.length + 120];
const PAYFILE	= path.join(WORK, 'payload.bin');
fs.writeFileSync(PAYFILE, PAYLOAD);

/// A fence a request may carry. It is NOT composed here in earnest — that is
/// `fence_spec`'s job in src/tools.rs — it is the shape of one, so the relay
/// can be shown passing it through untouched.
const FENCE = { rw: [WORK], ro: [], deny: [], net: false };

/// A well-formed `open`, with anything overridden and anything dropped.
function spec(id, over, drop) {
	const m = {
		t: 'open', id, argv: ['bash', '-i'], cwd: WORK, env: [['TERM', 'xterm-256color']],
		size: { cols: 80, rows: 24 }, fence: FENCE,
	};
	Object.assign(m, over || {});
	for (const k of (drop || [])) delete m[k];
	return m;
}

// ── hand.js's own sentences ─────────────────────────────────────────
//
// Read out of the file rather than copied, so this test cannot drift into
// asserting a sentence the product no longer says. WHICH of them a dead link
// produces is hand.js's decision and dev/verify_handrun.mjs proves it; what is
// proved here is that handpty.js repeats whichever it is given, word for word,
// and marks the two apart.

/// The value of a `var NAME = '…' + '…';` in a source file, evaluated.
function sentence(src, name) {
	const hit = new RegExp(`var\\s+${name}\\s*=\\s*([\\s\\S]*?);\\n`).exec(src);
	if (!hit) return '';
	// eslint-disable-next-line no-new-func
	try { return new Function('return ' + hit[1])(); } catch (e) { return ''; }
}
const HANDSRC	= fs.readFileSync(HANDJS, 'utf8');
const NO_HAND	= sentence(HANDSRC, 'NO_HAND');
const HAND_GONE	= sentence(HANDSRC, 'HAND_GONE');

// ── The stub page ───────────────────────────────────────────────────
//
// The relay under test, plus the SMALLEST thing that satisfies the interface it
// asks of hand.js. The double is a bridge and nothing more: every message goes
// to a real host process and every answer comes back from one. It supplies no
// wire behaviour of its own, so nothing here can agree with handpty.js by
// construction.

const PAGE = `<!doctype html><meta charset="utf-8"><title>pty</title>
<body><h1>pty harness</h1><script>
// What hand.js is asked to provide. Two functions; see the report beside this file.
window.__subs = {};
window.__sent = [];
window.__met = false;
window.DaimondHand = {
	send: function (m) {
		window.__sent.push(m);
		if (m && m.t !== 'hello') window.__met = true;
		return window.__ptyOut(JSON.stringify(m));
	},
	subscribe: function (id, fn) {
		(window.__subs[id] = window.__subs[id] || []).push(fn);
		return function () {
			var a = window.__subs[id] || [];
			var i = a.indexOf(fn);
			if (i >= 0) a.splice(i, 1);
		};
	},
	status: function () {
		return Promise.resolve(JSON.stringify({
			paired: true, transport: 'machine', machine: 'mock', os: 'linux',
			root: '/nowhere', caps: ['fence:linux', 'pty'],
		}));
	},
};
/// One message from the host, to whoever the id belongs to.
window.__ptyIn = function (json) {
	var m = JSON.parse(json);
	var a = (window.__subs[m.id] || []).slice();
	for (var i = 0; i < a.length; i++) a[i](m);
};
/// The link died. \`message\` and \`met\` are hand.js's to decide; this passes on
/// whatever the test says it decided.
window.__gone = function (message, met) {
	for (var id in window.__subs) {
		var a = (window.__subs[id] || []).slice();
		for (var i = 0; i < a.length; i++) a[i]({ t: '__gone', message: message, met: met });
	}
};
/// Everything one session said, recorded for the far end to compare.
window.__watch = function (id) {
	window.__seen = { chunks: [], types: [], gaps: [], errs: [], closed: null };
	return {
		onOutput: function (b) {
			window.__seen.types.push(Object.prototype.toString.call(b));
			window.__seen.chunks.push(Array.prototype.slice.call(b));
		},
		onGap:    function (g) { window.__seen.gaps.push(g); },
		onError:  function (e) { window.__seen.errs.push(e); },
		onClosed: function (c) { window.__seen.closed = c; },
	};
};
<\/script>
<script src="/handpty.js"><\/script></body>`;

/// Serves the stub page, and the relay itself as the file it really is.
async function serveStub(port) {
	const s = http.createServer((req, res) => {
		if (/^\/handpty\.js/.test(req.url || '')) {
			res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
			res.end(fs.readFileSync(RELAY));
			return;
		}
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(PAGE);
	});
	await new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', resolve); });
	return s;
}

/// The first free port from `from`, so a dev server already holding one is left
/// alone rather than fought over.
async function stubOnFreePort(from) {
	for (let port = from; port < from + 40; port++) {
		try { return { s: await serveStub(port), port }; }
		catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
	}
	throw new Error(`No free port from ${from}.`);
}

// ── The bridge ──────────────────────────────────────────────────────

let host	= null;		// the mock host process, or null
let hostLog	= '';		// where it is writing what it saw
let deliver	= Promise.resolve();	// host -> page, strictly in order

/// Starts a fresh host with the behaviour this case needs.
///
/// One process per case, because the host reads its configuration when it
/// starts — and because a session that outlived its case would answer the next
/// one.
function startHost(cfg, page) {
	stopHost();
	const n	= Math.random().toString(36).slice(2, 8);
	const cf	= path.join(WORK, `cfg-${n}.json`);
	hostLog		= path.join(WORK, `log-${n}.jsonl`);
	fs.writeFileSync(cf, JSON.stringify(Object.assign({ payload: PAYFILE, splits: SPLITS }, cfg), null, '\t'));
	const p = spawn('python3', [MOCK, cf, hostLog], { stdio: ['pipe', 'pipe', 'inherit'] });
	let buf = Buffer.alloc(0);
	p.stdout.on('data', (d) => {
		buf = Buffer.concat([buf, d]);
		for (;;) {
			if (buf.length < 4) break;
			// Native byte order, which on every machine this runs on is little.
			const n2 = buf.readUInt32LE(0);
			if (buf.length < 4 + n2) break;
			const body = buf.subarray(4, 4 + n2).toString('utf8');
			buf = buf.subarray(4 + n2);
			deliver = deliver.then(() => page.evaluate((j) => window.__ptyIn(j), body).catch(() => {}));
		}
	});
	host = p;
	return p;
}

/// Stops it, so the next case gets a fresh one.
function stopHost() {
	if (!host) return;
	try { host.kill('SIGKILL'); } catch (e) { /* already gone */ }
	host = null;
}

/// Everything the host recorded, as objects.
function heard() {
	if (!hostLog || !fs.existsSync(hostLog)) return [];
	return fs.readFileSync(hostLog, 'utf8').split('\n').filter(Boolean)
		.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

/// What the host was SENT of a given type, which is the honest way to ask
/// whether a message travelled.
function received(t) {
	return heard().filter((e) => e.dir === '<-' && e.msg && e.msg.t === t).map((e) => e.msg);
}

/// Everything the page has been given about the session under watch, once the
/// host has finished talking.
async function seen(page) {
	await deliver;
	await sleep(120);
	await deliver;
	return page.evaluate(() => window.__seen);
}

/// The bytes a subscriber was handed, joined.
function bytes(s) {
	return Buffer.concat((s.chunks || []).map((c) => Buffer.from(c)));
}

// ── The two servers, for the app phase ──────────────────────────────

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
	const p = spawn('node', args, { cwd: ROOT, stdio: 'ignore' });
	started.push(p);
	for (let i = 0; i < 100; i++) {
		if (await listening(port)) { console.log(`  (started ${name} on ${port})`); return; }
		await sleep(100);
	}
	throw new Error(`${name} did not come up on ${port}`);
}

// ── Phase one: the relay, the wire, and a real host ─────────────────

const stub = await stubOnFreePort(8977);
const b = await chromium.launchPersistentContext(path.join(WORK, 'profile'), {
	executablePath:	CHROME,
	headless:	false,
	args: ['--no-sandbox', '--disable-dev-shm-usage', '--headless=new'],
	viewport: { width: 1000, height: 700 },
});
const page = b.pages()[0] || await b.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
await page.exposeFunction('__ptyOut', (json) => {
	if (!host) return;
	const data = Buffer.from(json, 'utf8');
	const head = Buffer.alloc(4);
	head.writeUInt32LE(data.length, 0);
	try { host.stdin.write(Buffer.concat([head, data])); } catch (e) { /* it has gone */ }
});
await page.goto(`http://127.0.0.1:${stub.port}/`, { waitUntil: 'domcontentloaded' });

try {
	check('the payload is the awkward one, or the test proves nothing',
		PAYLOAD.includes(0x00) && PAYLOAD.includes(0x80) && PAYLOAD.includes(0xff)
		&& !Buffer.from(PAYLOAD.toString('utf8'), 'utf8').equals(PAYLOAD),
		`${PAYLOAD.length} bytes, and a text round trip does not survive it`);
	check('the relay loaded and installed itself',
		await page.evaluate(() => !!(window.DaimondPty && window.DaimondPty.open)));

	// ── A session opens, and its id comes back ──────────────────────
	startHost({}, page);
	let got = await page.evaluate(async (sp) => {
		const h = window.__watch(sp.id);
		return await window.DaimondPty.open(sp, h).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
	}, spec('t1'));
	check('a terminal opens and resolves with its id', !!got.ok && got.ok.id === 't1', JSON.stringify(got));
	check('and with the process it is attached to', !!got.ok && got.ok.pid > 0, JSON.stringify(got.ok));

	// ── The bytes are the bytes ─────────────────────────────────────
	let s = await seen(page);
	const back = bytes(s);
	check('the subscriber is handed raw bytes, never base64',
		s.types.length > 0 && s.types.every((t) => t === '[object Uint8Array]'), s.types.join(' '));
	check('the output is byte-for-byte what the program wrote',
		back.equals(PAYLOAD), `${back.length} of ${PAYLOAD.length} bytes`);
	check('including the NULs and the invalid UTF-8',
		back.includes(0x00) && back.includes(0x80) && back.includes(0xed) && back.includes(0xff),
		back.slice(0, 24).toString('hex'));
	check('a character cut in half by a frame boundary is put back together',
		received('open').length === 1 && back.indexOf(EURO) === HEAD.length,
		`euro at ${back.indexOf(EURO)}, expected ${HEAD.length}`);
	check('it really did arrive in more than one frame',
		heard().filter((e) => e.dir === '->' && e.msg.t === 'output').length >= SPLITS.length + 1,
		String(heard().filter((e) => e.dir === '->' && e.msg.t === 'output').length));
	check('nothing was reported missing when nothing was', s.gaps.length === 0, JSON.stringify(s.gaps));

	// ── Typing travels, exactly ─────────────────────────────────────
	const typed = Buffer.from([0x03, 0x1b, 0x5b, 0x41, 0x00, 0xff, 0xc3, 0xa9, 0x0d]);
	await page.evaluate(async ({ id, t }) => {
		await window.DaimondPty.input(id, new Uint8Array(t));
	}, { id: 't1', t: Array.from(typed) });
	await sleep(300);
	const ins = received('input');
	check('keystrokes travel as one input message', ins.length === 1, JSON.stringify(ins).slice(0, 120));
	check('and carry exactly the bytes typed, Ctrl-C, NUL and all',
		ins.length === 1 && Buffer.from(ins[0].data, 'base64').equals(typed),
		ins.length ? Buffer.from(ins[0].data, 'base64').toString('hex') : '');
	s = await seen(page);
	check('and what the terminal echoes comes back as those same bytes',
		bytes(s).equals(Buffer.concat([PAYLOAD, typed])), `${bytes(s).length} bytes`);

	// ── A resize travels ────────────────────────────────────────────
	await page.evaluate(() => window.DaimondPty.resize('t1', 132, 43));
	await sleep(250);
	const rs = received('resize');
	check('a resize travels, with the new size',
		rs.length === 1 && rs[0].size.cols === 132 && rs[0].size.rows === 43, JSON.stringify(rs));

	// ── Asking it to stop ───────────────────────────────────────────
	await page.evaluate(() => window.DaimondPty.close('t1'));
	await sleep(300);
	const sig = received('signal');
	s = await seen(page);
	check('closing asks the program to stop rather than insisting',
		sig.length === 1 && sig[0].sig === 'term', JSON.stringify(sig));
	check('and the session ends with the status the hand reported',
		!!s.closed && s.closed.exit === 0, JSON.stringify(s.closed));
	check('a closed session is no longer live in the page',
		(await page.evaluate(() => window.DaimondPty.sessions())).length === 0);

	// ── A hole is surfaced, not stitched ────────────────────────────
	startHost({ gap: true }, page);
	got = await page.evaluate(async (sp) => {
		const h = window.__watch(sp.id);
		return await window.DaimondPty.open(sp, h).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
	}, spec('t2'));
	s = await seen(page);
	check('a hole in the sequence is reported', s.gaps.length === 1, JSON.stringify(s.gaps));
	check('and it says which chunk is missing, and how many',
		s.gaps.length === 1 && s.gaps[0].missing === 1 && s.gaps[0].got === s.gaps[0].expected + 1,
		JSON.stringify(s.gaps[0]));
	check('the bytes still go through, hole and all — nothing is invented and nothing dropped',
		bytes(s).equals(PAYLOAD), `${bytes(s).length} of ${PAYLOAD.length}`);
	check('and the marker is beside the stream, not written into it',
		!bytes(s).includes(Buffer.from('missing')), '');
	await page.evaluate(() => window.DaimondPty.forget('t2'));

	// ── A host that dies mid-session ────────────────────────────────
	//
	// The host really exits; the bridge sees the pipe close, exactly as the
	// extension would. WHICH sentence a dead link produces is hand.js's
	// decision and dev/verify_handrun.mjs proves it. What is proved here is
	// that a terminal repeats it word for word and marks a hand that STOPPED
	// apart from one that was never there.
	startHost({ crash_after_ms: 400 }, page);
	got = await page.evaluate(async (sp) => {
		const h = window.__watch(sp.id);
		return await window.DaimondPty.open(sp, h).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
	}, spec('t3'));
	check('the session was open before the host died', !!got.ok, JSON.stringify(got));
	await new Promise((r) => { if (!host || host.exitCode !== null) r(); else host.once('exit', r); });
	await page.evaluate((m) => window.__gone(m, true), HAND_GONE);
	s = await seen(page);
	check('a host that dies mid-session ends it rather than leaving it hanging',
		!!s.closed && s.closed.exit === -1 && s.closed.killed === true, JSON.stringify(s.closed));
	check('it is reported as a hand that STOPPED, not one that is absent',
		!!s.closed && s.closed.stopped === true && s.closed.absent === false, JSON.stringify(s.closed));
	check('and the sentence is hand.js\'s own, word for word',
		!!s.closed && s.closed.reason === HAND_GONE && HAND_GONE.length > 40,
		(s.closed || {}).reason);
	// The sentence HAND_GONE writes is "Do not tell the user to install it",
	// which is the opposite instruction and must not be mistaken for the other
	// one. So this asks the question that actually matters: it is not the
	// never-installed sentence, and it does not say the hand is not installed.
	check('so it does NOT tell the user to install what they have already installed',
		!!s.closed && s.closed.reason !== NO_HAND && !/is not installed/i.test(s.closed.reason || ''),
		(s.closed || {}).reason);

	// And the other half of the same distinction, with the link dying while the
	// opening is still in flight — nothing answers at all, which is what a hand
	// that was never installed looks like from here.
	stopHost();
	await page.evaluate(async (sp) => {
		const h = window.__watch(sp.id);
		window.__t4 = window.DaimondPty.open(sp, h).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
	}, spec('t4'));
	await sleep(300);
	await page.evaluate((m) => window.__gone(m, false), NO_HAND);
	s = await seen(page);
	const t4 = await page.evaluate(() => window.__t4);
	check('a link that never met a hand is reported as absent instead',
		!!s.closed && s.closed.absent === true && s.closed.stopped === false, JSON.stringify(s.closed));
	check('and a caller still waiting on the opening is given that sentence, not a hang',
		!!t4.err && t4.err === NO_HAND, JSON.stringify(t4).slice(0, 200));

	// ── The fence is not this file's to invent ──────────────────────
	startHost({}, page);
	const nofence = await page.evaluate(async (sp) =>
		await window.DaimondPty.open(sp).then((v) => ({ ok: v }), (e) => ({ err: e.message })),
	spec('t5', {}, ['fence']));
	const norootFence = await page.evaluate(async (sp) =>
		await window.DaimondPty.open(sp).then((v) => ({ ok: v }), (e) => ({ err: e.message })),
	spec('t6', { fence: { rw: [], ro: [], deny: [], net: true } }));
	const relcwd = await page.evaluate(async (sp) =>
		await window.DaimondPty.open(sp).then((v) => ({ ok: v }), (e) => ({ err: e.message })),
	spec('t7', { cwd: 'work' }));
	check('a terminal with no fence is refused, naming where one comes from',
		!!nofence.err && /fence_spec/.test(nofence.err), (nofence.err || '').slice(0, 120));
	check('and one whose fence names no root at all',
		!!norootFence.err && /no root/.test(norootFence.err), (norootFence.err || '').slice(0, 120));
	check('and one with a working directory that is not absolute',
		!!relcwd.err && /absolute/.test(relcwd.err), (relcwd.err || '').slice(0, 120));
	check('none of them reached the host',
		received('open').length === 0, JSON.stringify(received('open')).slice(0, 120));

	// ── A page whose relay cannot carry terminals ───────────────────
	const noCarry = await page.evaluate(async (sp) => {
		const real = window.DaimondHand;
		window.DaimondHand = { status: real.status };	// an older hand.js: no send, no subscribe
		const r = await window.DaimondPty.open(sp).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
		const st = JSON.parse(await window.DaimondPty.status());
		window.DaimondHand = real;
		return { r, st };
	}, spec('t8'));
	check('a page whose relay predates terminals says so, and blames the page',
		!!noCarry.r.err && /Reload the app/.test(noCarry.r.err), (noCarry.r.err || '').slice(0, 140));
	check('and does not send the user off to reinstall a working hand',
		!!noCarry.r.err && !/install/i.test(noCarry.r.err), (noCarry.r.err || '').slice(0, 140));
	check('status says the page cannot carry them, without pretending to be a hand',
		noCarry.st.carries === false && !!noCarry.st.reason, JSON.stringify(noCarry.st).slice(0, 160));

	const noRelay = await page.evaluate(async (sp) => {
		const real = window.DaimondHand;
		delete window.DaimondHand;
		const r = await window.DaimondPty.open(sp).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
		window.DaimondHand = real;
		return r;
	}, spec('t9'));
	check('and a page with no hand relay at all is a fault in the app, said as one',
		!!noRelay.err && /js\/hand\.js/.test(noRelay.err), (noRelay.err || '').slice(0, 140));

	// ── Output that arrives before anyone is drawing ────────────────
	//
	// A program writes its first screen at once, and a terminal that missed its
	// own first screen is broken. Opened with no handlers, subscribed to
	// afterwards, and everything must still be there.
	startHost({}, page);
	const late = await page.evaluate(async (sp) => {
		const r = await window.DaimondPty.open(sp).then((v) => ({ ok: v }), (e) => ({ err: e.message }));
		return r;
	}, spec('ta'));
	await sleep(400);
	await page.evaluate((id) => { window.DaimondPty.subscribe(id, window.__watch(id)); }, 'ta');
	s = await seen(page);
	check('output that arrived before a renderer attached is still delivered',
		!!late.ok && bytes(s).equals(PAYLOAD), `${bytes(s).length} of ${PAYLOAD.length}`);
	await page.evaluate(() => window.DaimondPty.forget('ta'));

	check('the page threw nothing along the way', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
	stopHost();
	await b.close().catch(() => {});
	stub.s.close();
}

// ── Phase two: the file in the real app ─────────────────────────────
//
// The relay is a page script and has to behave inside the page it ships in: it
// must load beside the rest, and it must degrade into a sentence rather than an
// exception when the machine hand is not there — which, on a plain dev profile
// with no extension, it is not.

await serve('dev server', ['dev/serve.mjs'], 8777);
await serve('mock provider', ['dev/mockllm.mjs'], 9099);

const { open: openApp } = await import(pathToFileURL(path.join(HERE, 'harness.mjs')).href);
const app = await openApp({ name: 'pty', connect: false });
try {
	await app.page.addScriptTag({ path: RELAY });
	await sleep(200);
	const st = JSON.parse(await app.page.evaluate(() => window.DaimondPty.status()));
	check('the relay loads into the real app and answers about itself',
		typeof st.carries === 'boolean' && st.sessions === 0, JSON.stringify(st).slice(0, 200));
	const r = await app.page.evaluate(async (sp) =>
		await window.DaimondPty.open(sp).then((v) => ({ ok: v }), (e) => ({ err: e.message })),
	{ t: 'open', id: 'app1', argv: ['bash'], cwd: '/nowhere', env: [], size: { cols: 80, rows: 24 },
		fence: { rw: ['/nowhere'], ro: [], deny: [], net: false } });
	// The sentence is the LINK's, not this relay's, and that is the change worth
	// noting: hand.js now carries terminal messages, so an `open` on a machine
	// with no hand gets as far as the link and comes back with the sentence
	// hand.js already writes for a hand that is not installed -- verbatim, which
	// is what handpty.js's header asks of it. Before hand.js grew `send` and
	// `subscribe` this refusal was NO_CARRY, which is a different fault with a
	// different instruction: reload the app, rather than install the hand.
	check('and with no hand on this machine it refuses in a whole sentence, not an exception',
		!!r.err && r.err.length > 60 && /machine hand|terminal/i.test(r.err),
		(r.err || '').slice(0, 160));
	const noise = app.errs.filter((e) => !/favicon|ERR_ABORTED|502|Bad Gateway/i.test(e));
	check('the app threw nothing when it loaded', noise.length === 0, noise.slice(0, 3).join(' | '));
} finally {
	await app.close().catch(() => {});
	for (const p of started) { try { p.kill(); } catch (e) { /* already gone */ } }
	fs.rmSync(WORK, { recursive: true, force: true });
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
