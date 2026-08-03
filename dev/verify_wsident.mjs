// verify_wsident.mjs — the hand's folder and the page's folder are the SAME
// folder, or nothing runs.
//
// `hand/REVIEW.md` §1.14. The hand is told once, in `<root>/.daimond/workspace.id`,
// which folder it may work in. The app separately has a folder open, chosen by
// the user in the Workspace panel. Until this check was armed, nothing compared
// them: a daimon could read and edit `~/projects/alpha` through the browser and
// then run `cargo test` in `~/projects/beta`, because that is what the hand's
// `root.txt` said — reporting results about a codebase it had never touched.
// Silent, and confidently wrong.
//
// ── Why this file exists at all ─────────────────────────────────────
//
// The refusal cannot be satisfied by any headless run, ever. A page holds a real
// folder only through `showDirectoryPicker()`, a native dialog no harness can
// answer, so an automated browser always has an OPFS workspace — which is
// §1.14's third outcome and a refusal. The two verifiers that drive the real
// hand therefore stand in for `status()` and get on with what they are actually
// testing; the REFUSAL itself is tested here, and nowhere else.
//
// ── What stands in for what ─────────────────────────────────────────
//
// The two folders are real `FileSystemDirectoryHandle`s, taken from OPFS, each
// with a real `.daimond/workspace.id` written into it. So every line of the
// comparison runs for real: `getDirectoryHandle`, `getFileHandle`, the read, the
// comment-skipping and the string compare. What is stood in for is only the one
// thing a headless browser cannot have — a handle the user picked — and the
// hand, whose `hello` is fed to `DaimondHand.adopt` directly, exactly as the
// extension feeds it.
//
// Nothing here breaks the harness to make a check go red. Every property is
// proved against a BROKEN `www/js/hand.js`, served through a patch: the break is
// in the file under test, and a check that still passes with the code broken is
// reported as blind rather than counted.
//
// ── Running it ──────────────────────────────────────────────────────
//
//	node dev/verify_wsident.mjs
//
// Headless, and it needs nothing running: no extension, no hand binary, no dev
// server. `www/pkg` must be built, because the engine's own refusal is checked
// through the real `pty_request`.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { whyStaleWasm, refuse } from './staleguard.mjs';

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const WWW	= path.join(ROOT, 'www');

// The granted folder, as the PATH the hand would report. Nothing on this machine
// is ever opened there: the hand is stood in for, and all a path has to be here
// is absolute.
const PATH_A	= '/home/u/projects/alpha';
// A grant whose last component is the same as a folder the page can hold, which
// is the case the check must not fall back to comparing names on.
const PATH_SITE	= '/home/u/work/site';

const TOKEN_A	= 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN_B	= '0f9e8d7c6b5a49382716f5e4d3c2b1a0';

/// The file the hand writes, verbatim: four comment lines and then the token.
/// The comments are not decoration — they are why the token is not simply the
/// first line, and a reader who deletes them is testing something else.
const HEADER = '# Daimond wrote this so that the browser and the machine hand can tell whether\n'
	+ '# they are talking about the same folder. It is not a secret and not a key.\n'
	+ '# Deleting it costs nothing: the next hand to start writes a new one, and the\n'
	+ '# page will ask you to confirm the folder again.\n';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// A property proved twice: broken, and required to fail; whole, and required to
/// pass. Only a pair where BOTH halves answered as they should is counted — a
/// check that passes with the code broken is blind, and is reported as such.
const provedNames = [];
async function proved(name, brk, testIt) {
	breaking = brk;
	await reload();
	let red = true;
	try { red = await testIt(); } catch (e) { red = false; }
	breaking = '';
	await reload();
	let green = false;
	try { green = await testIt(); } catch (e) { green = false; }
	provedNames.push(name);
	check(`PROVED ${name}`, !red && green,
		`broken=${red ? 'PASSED — the check is blind' : 'failed, correctly'}, `
		+ `whole=${green ? 'passed' : 'FAILED'}`);
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Breaking the code under test                                   │
// └───────────────────────────────────────────────────────────────┘
//
// Each break is what the file looked like before the property was there, or what
// a reasonable person would write who had not thought about it. None of them is
// nonsense: `not-armed` is literally the state this file was written to end.

const PATCHES = {
	// The arming itself: report the verdict and pair anyway, which is where
	// §1.14 stood until today.
	'not-armed': ['\t\t\t\tout.paired = false;\n', ''],
	// The fallback §1.14 forbids by name: compare the folder's NAME with the
	// last component of the hand's root.
	'name-compare': [
		'\t\tif (firstLine(mine) !== token) return { ok: false, why: mismatch(dir) };',
		'\t\tif (dir.name !== String(state.root).split(\'/\').pop()) '
		+ 'return { ok: false, why: mismatch(dir) };'],
	// A page that creates the file it is about to read proves nothing.
	'creates-file': [
		'\t\t\tvar sub  = await dir.getDirectoryHandle(WS_DIR);\n'
		+ '\t\t\tvar file = await sub.getFileHandle(WS_FILE);',
		'\t\t\tvar sub  = await dir.getDirectoryHandle(WS_DIR, { create: true });\n'
		+ '\t\t\tvar file = await sub.getFileHandle(WS_FILE, { create: true });'],
	// The token taken as the first line of the file rather than the first line
	// that is neither blank nor a comment.
	'first-line': ['\t\t\tif (!line || line.charAt(0) === \'#\') continue;', ''],
	// Refusing a hand that publishes no `ws:` at all, which breaks every older
	// hand and every mock host permanently.
	'silence-refuses': ['\t\t\treturn { ok: true, why: \'\' };\n\t\t}\n\t\tif (token === WS_UNPROVEN)',
		'\t\t\treturn { ok: false, why: mismatch(dir) };\n\t\t}\n\t\tif (token === WS_UNPROVEN)'],
	// The cache keyed by the grant alone, so a folder swapped underneath the page
	// is answered for out of memory.
	'stale-cache': ['if (wsProof && wsProof.key === key && wsProof.dir === dir) return wsProof;',
		'if (wsProof && wsProof.key === key) return wsProof;'],
	// Skipping the check for want of a handle, which is the outcome that must NOT
	// be skipped: there is nothing to compare, so it cannot pass.
	'opfs-passes': ['\t\t\treturn { ok: false, why: \'This workspace lives in the browser',
		'\t\t\treturn { ok: true, why: \'This workspace lives in the browser'],
	// A hand that could not write its identity file, believed anyway.
	'unproven-passes': ['\t\t\treturn { ok: false, why: \'The machine hand could not write',
		'\t\t\treturn { ok: true, why: \'The machine hand could not write'],
	// A comparison that could not be made at all, reported and then paired anyway.
	'unchecked-passes': ['\t\t\tout.paired = false;\n\t\t\tout.workspace = \'unchecked\';',
		'\t\t\tout.workspace = \'unchecked\';'],
};

/// The break in force, or ''. Read by the server as it serves `hand.js`.
let breaking = '';

/// One served file's source, patched where a break names it.
function served(rel) {
	let src = fs.readFileSync(path.join(WWW, rel), 'utf8');
	const p = PATCHES[breaking];
	if (p && rel === 'js/hand.js') {
		if (src.indexOf(p[0]) < 0) {
			console.error(`  !! the break "${breaking}" no longer matches www/js/hand.js; `
				+ 'the patch is stale and would prove nothing');
			process.exitCode = 3;
		}
		src = src.replace(p[0], p[1]);
	}
	return src;
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The page                                                       │
// └───────────────────────────────────────────────────────────────┘
//
// The relay and the wasm module, and nothing else. The relay is reached exactly
// as the app reaches it — `DaimondHand.init`, `DaimondHand.adopt`, and then
// `status()` — so what is under test is the shipped object and not a copy.

const PAGE = `<!doctype html><meta charset="utf-8"><title>wsident</title>
<body>
<script src="/js/hand.js"><\/script>
<script type="module">
import init, * as W from '/pkg/oxedyne_daimond.js';
await init();
window.Wasm = W;
window.__ready = true;
<\/script>
<script>
/// The folder the page has open, as the Workspace panel would hand it over: a
/// directory handle and never a path.
window.__folder = null;
DaimondHand.init({ folder: function () { return window.__folder; } });

/// Write one folder's identity file, through the same API a page reads it with.
///
/// Real OPFS handles, so the read under test is a real read. 'create: true' here
/// is the TEST writing the fixture, which is a different act from the relay
/// creating what it is about to compare against.
window.__folderWith = async function (parent, name, body) {
	const top  = await navigator.storage.getDirectory();
	const up   = await top.getDirectoryHandle(parent, { create: true });
	const dir  = await up.getDirectoryHandle(name, { create: true });
	if (body === null) return dir;
	const sub  = await dir.getDirectoryHandle('.daimond', { create: true });
	const f    = await sub.getFileHandle('workspace.id', { create: true });
	const w    = await f.createWritable();
	await w.write(body);
	await w.close();
	return dir;
};

/// A folder with a '.daimond' directory and no identity file in it.
window.__folderBare = async function (parent, name) {
	const top = await navigator.storage.getDirectory();
	const up  = await top.getDirectoryHandle(parent, { create: true });
	const dir = await up.getDirectoryHandle(name, { create: true });
	await dir.getDirectoryHandle('.daimond', { create: true });
	return dir;
};

/// Whether a folder has a '.daimond', and whether that has a 'workspace.id'.
/// Read WITHOUT creating anything, or the reading would be the writing.
window.__whatIsThere = async function (dir) {
	let sub = null;
	try { sub = await dir.getDirectoryHandle('.daimond'); } catch (e) { return { dir: false, file: false }; }
	try { await sub.getFileHandle('workspace.id'); } catch (e) { return { dir: true, file: false }; }
	return { dir: true, file: true };
};

/// Tell the relay what a hand said, exactly as the extension's greeting does.
///
/// # Arguments
/// * root - The folder the hand was granted.
/// * ws - The identity it published, or null to publish none at all.
window.__handSays = function (root, ws) {
	DaimondHand.forget();
	const caps = ['fence:linux', 'landlock:abi-8', 'root:' + root];
	if (ws !== null) caps.push('ws:' + ws);
	DaimondHand.adopt({ transport: 'machine', host: 'test', version: '0.0.0', os: 'linux', caps: caps });
};
<\/script>
</body>`;

const server = http.createServer((req, res) => {
	const url = (req.url || '').split('?')[0];
	const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
	if (url === '/favicon.ico') { res.writeHead(404); return res.end('no'); }
	if (url.startsWith('/js/')) return send('text/javascript; charset=utf-8', served(url.slice(1)));
	if (url.startsWith('/pkg/')) {
		const f = path.join(WWW, 'pkg', url.slice('/pkg/'.length));
		if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no'); }
		return send(f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
			fs.readFileSync(f));
	}
	return send('text/html; charset=utf-8', PAGE);
});

/// The first free port from `from`, so a dev server already holding one is left
/// alone rather than fought over.
async function listen(from) {
	for (let port = from; port < from + 40; port++) {
		try {
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
			});
			return port;
		} catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
	}
	throw new Error(`No free port from ${from}.`);
}

// ── The engine under test has to be this tree's ─────────────────────
//
// This file asked only whether `www/pkg` EXISTED. That is the fail-open that
// `hand/src/exec.rs`'s `shipping_hand` and `dev/verify_ptyedge.mjs` were both
// written to close: the whole subject here is the ENGINE's own refusal, reached
// through the real `pty_request` in the bundle, so a bundle built before that
// refusal existed would have this file report, in detail and in green, on a
// refusal that is no longer in the code. Existence proves the file is there and
// nothing at all about what is in it.
//
// So: every `.rs` under `src/` must be older than the bundle. Not rebuilt here —
// a wasm build is minutes and a surprise one inside a verifier is worse than a
// sentence saying what to run.
refuse(whyStaleWasm(path.join(WWW, 'pkg/oxedyne_daimond_bg.wasm'), path.join(ROOT, 'src'), {
	subject: 'The workspace-identity refusal',
	holds:   '`pty_request`, whose refusal is the subject of this file,',
}));

const PORT = await listen(Number(process.env.WSIDENT_PORT || 8811));
const APP  = `http://127.0.0.1:${PORT}`;

const b = await chromium.launch({ executablePath: CHROME, headless: true,
	args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await b.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));

/// Loads the page again, with whatever break is in force. The reload is what
/// puts a patched relay into the running page.
async function reload() {
	await page.goto(APP, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
}

// ┌───────────────────────────────────────────────────────────────┐
// │ The one question, asked both ways round                        │
// └───────────────────────────────────────────────────────────────┘

/// A fresh OPFS parent for every fixture. Reloading the page resets its
/// JavaScript and not its storage, so a folder made under one break would
/// otherwise still be there — with whatever the break did to it — when the whole
/// code is asked the same question afterwards.
let seq = 0;

/// Set the two ends up and ask the relay.
///
/// # Arguments
/// * `root` - The folder the hand was granted.
/// * `ws` - The identity the hand published, or null for a hand that publishes none.
/// * `folder` - `{ name, body }` for the folder the page holds, `{ name, body: null }`
///   for one with no `.daimond` in it, `'bare'` for one with an empty `.daimond`,
///   or null for an OPFS-only workspace with no folder at all.
async function ask(root, ws, folder) {
	const parent = `w${++seq}`;
	return await page.evaluate(async ([root, ws, folder, parent]) => {
		window.__folder = null;
		if (folder === 'bare') window.__folder = await window.__folderBare(parent, 'bare');
		else if (folder) window.__folder = await window.__folderWith(parent, folder.name, folder.body);
		window.__handSays(root, ws);
		const proof = await DaimondHand.workspaceProof();
		const st = JSON.parse(await DaimondHand.status());
		const there = window.__folder ? await window.__whatIsThere(window.__folder) : null;
		return { proof, st, there, folderName: window.__folder ? window.__folder.name : null };
	}, [root, ws, folder || null, parent]);
}

/// What the ENGINE does with that answer, through the real `pty_request` — the
/// same composition a Terminal panel goes through, on the real wasm.
async function engine() {
	return await page.evaluate(async () => JSON.parse(await window.Wasm.pty_request(JSON.stringify({
		own_dir: 'diamonds/d1', attached: [], read_only: [],
		cwd: 'diamonds/d1', cols: 80, rows: 24,
	}))));
}

await reload();

console.log('\n── 1. The same folder, and silence ───────────────────');

const same = await ask(PATH_A, TOKEN_A, { name: 'alpha', body: HEADER + TOKEN_A + '\n' });
check('a page holding the granted folder is not refused',
	same.proof.ok === true && same.proof.why === '', JSON.stringify(same.proof).slice(0, 200));
check('and the ordinary case says NOTHING: no reason, no complaint, just paired',
	same.st.paired === true && same.st.workspace === 'ok'
	&& same.st.workspace_reason === undefined && same.st.reason === undefined,
	JSON.stringify(same.st).slice(0, 240));
check('and the token is read past the four comment lines the hand writes',
	same.proof.ok === true, 'the fixture is the hand\'s own file, header and all');

const opened = await engine();
check('so the engine composes a terminal for it', opened.t === 'open' && !opened.refused,
	JSON.stringify(opened).slice(0, 160));

console.log('\n── 2. Folder A granted, folder B open ────────────────');

// THE case this check exists for. The hand was granted alpha and says so; the
// page has beta open, and beta carries its own, different identity. Both folders
// exist, both are perfectly good workspaces, and the two ends mean different
// files.
const AvsB = await ask(PATH_A, TOKEN_A, { name: 'beta', body: HEADER + TOKEN_B + '\n' });
check('a hand granted A with the page holding B is REFUSED',
	AvsB.proof.ok === false, JSON.stringify(AvsB.proof).slice(0, 200));
check('and the refusal names BOTH ends, so the user can tell which one is wrong',
	new RegExp('Daimond has “beta”; the hand has “'
		+ PATH_A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '”').test(AvsB.proof.why),
	AvsB.proof.why);
check('and it says what to do about each end',
	/root\.txt/.test(AvsB.proof.why) && /open the other folder here/.test(AvsB.proof.why),
	AvsB.proof.why.slice(-120));
check('and the relay refuses the pairing rather than merely reporting it',
	AvsB.st.paired === false && AvsB.st.reason === AvsB.proof.why
	&& AvsB.st.workspace === 'mismatch',
	JSON.stringify(AvsB.st).slice(0, 200));
check('and what the hand said about itself survives the refusal, for the user to read',
	AvsB.st.root === PATH_A && (AvsB.st.caps || []).includes('fence:linux'),
	JSON.stringify(AvsB.st).slice(0, 200));

const refusedByEngine = await engine();
check('so the ENGINE will not open a terminal, and passes the sentence on whole',
	!!refusedByEngine.refused && refusedByEngine.t === undefined
	&& refusedByEngine.refused.includes('is not the folder the machine hand was told to work in'),
	JSON.stringify(refusedByEngine).slice(0, 220));

console.log('\n── 3. Two projects called "site" ─────────────────────');

// §1.14 forbids falling back to the folder's name by name, and this is why: one
// machine with two `site` directories is the ordinary case. Both directions are
// asserted, because a name check is wrong in both — it passes the wrong folder
// AND refuses the right one.
const wrongSite = await ask(PATH_SITE, TOKEN_A, { name: 'site', body: HEADER + TOKEN_B + '\n' });
check('a folder whose NAME matches the grant, and whose identity does not, is refused',
	wrongSite.proof.ok === false && wrongSite.folderName === 'site',
	JSON.stringify(wrongSite.proof).slice(0, 160));
const renamed = await ask(PATH_SITE, TOKEN_A, { name: 'moved', body: HEADER + TOKEN_A + '\n' });
check('and a folder whose name matches NOTHING, but whose identity matches, is allowed',
	renamed.proof.ok === true && renamed.folderName === 'moved',
	JSON.stringify(renamed.proof).slice(0, 160));

console.log('\n── 4. The other three outcomes ───────────────────────');

const opfs = await ask(PATH_A, TOKEN_A, null);
check('an OPFS-only workspace is refused, and told it has no folder at all',
	opfs.proof.ok === false && /lives in the browser and not in a folder/.test(opfs.proof.why)
	&& opfs.st.paired === false, opfs.proof.why.slice(0, 140));

const unproven = await ask(PATH_A, 'unproven', { name: 'alpha', body: HEADER + TOKEN_A + '\n' });
check('a hand that could not write its identity file is refused, not believed',
	unproven.proof.ok === false && /could not write its identity file/.test(unproven.proof.why)
	&& unproven.st.paired === false, unproven.proof.why.slice(0, 140));

const silent = await ask(PATH_A, null, null);
check('a hand that publishes no identity at all is an OLDER hand, and still pairs',
	silent.proof.ok === true && silent.st.paired === true && silent.st.workspace === 'ok',
	JSON.stringify(silent.st).slice(0, 200));

console.log('\n── 5. What the page must never do ────────────────────');

const missing = await ask(PATH_A, TOKEN_A, { name: 'empty', body: null });
check('a folder with no .daimond in it is refused',
	missing.proof.ok === false, JSON.stringify(missing.proof).slice(0, 160));
check('and the page did not CREATE the directory it failed to find',
	missing.there.dir === false && missing.there.file === false, JSON.stringify(missing.there));

const bare = await ask(PATH_A, TOKEN_A, 'bare');
check('a .daimond with no identity file in it is refused',
	bare.proof.ok === false, JSON.stringify(bare.proof).slice(0, 160));
check('and the page did not CREATE the file it failed to find',
	bare.there.dir === true && bare.there.file === false, JSON.stringify(bare.there));

// The token is the first line that is neither blank nor a comment. A file whose
// COMMENT quotes the hand's token, and whose payload line is something else, is
// a different folder — and reading it the lazy way would call it a match.
const commented = await ask(PATH_A, TOKEN_A,
	{ name: 'commented', body: `# ${TOKEN_A}\n\n${TOKEN_B}\n` });
check('a token quoted in a COMMENT is not the folder\'s identity',
	commented.proof.ok === false, JSON.stringify(commented.proof).slice(0, 160));

// A comparison that cannot be made is not a comparison that passed. The page is
// asked for its folder and throws instead of answering — the shape of a handle
// the browser has let go of.
const threw = await page.evaluate(async ([root, tok]) => {
	DaimondHand.init({ folder: function () { throw new Error('the folder handle is gone'); } });
	window.__handSays(root, tok);
	const st = JSON.parse(await DaimondHand.status());
	DaimondHand.init({ folder: function () { return window.__folder; } });
	return st;
}, [PATH_A, TOKEN_A]);
check('a check that cannot answer at all refuses, rather than passing by default',
	threw.paired === false && threw.workspace === 'unchecked'
	&& threw.reason === threw.workspace_reason && /will not run a command/.test(threw.reason || ''),
	JSON.stringify(threw).slice(0, 220));

console.log('\n── 6. The folder changing underneath the page ────────');

// The user opens a different folder in the Workspace panel. The hand has said
// nothing — the grant has not changed — so a verdict remembered by grant alone
// would answer for a folder it never read.
const swapped = await page.evaluate(async ([root, tok, header, other, parent]) => {
	window.__folder = await window.__folderWith(parent, 'alpha', header + tok + '\n');
	window.__handSays(root, tok);
	const first = await DaimondHand.workspaceProof();
	// Nothing else changes: same hand, same grant, same token. Only the folder.
	window.__folder = await window.__folderWith(parent, 'beta', header + other + '\n');
	const second = await DaimondHand.workspaceProof();
	const st = JSON.parse(await DaimondHand.status());
	return { first: first.ok, second: second.ok, paired: st.paired, why: second.why };
}, [PATH_A, TOKEN_A, HEADER, TOKEN_B, `w${++seq}`]);
check('a folder swapped under a PASSING verdict is checked again, and refused',
	swapped.first === true && swapped.second === false && swapped.paired === false,
	JSON.stringify(swapped).slice(0, 200));

check('nothing on the page threw along the way', errs.length === 0, errs.slice(0, 3).join(' | '));

// ┌───────────────────────────────────────────────────────────────┐
// │ 7. Every property, proved against broken code                  │
// └───────────────────────────────────────────────────────────────┘
//
// The break is in `www/js/hand.js`, served through a patch and the page
// reloaded. Nothing in this file breaks itself.

console.log('\n── 7. Proved against broken code ─────────────────────');

await proved('the refusal is armed at all', 'not-armed', async () => {
	const r = await ask(PATH_A, TOKEN_A, { name: 'beta', body: HEADER + TOKEN_B + '\n' });
	return r.st.paired === false && r.st.reason === r.proof.why;
});

await proved('the engine will not open a terminal on the wrong folder', 'not-armed', async () => {
	await ask(PATH_A, TOKEN_A, { name: 'beta', body: HEADER + TOKEN_B + '\n' });
	const r = await engine();
	return !!r.refused && r.t === undefined
		&& r.refused.includes('is not the folder the machine hand was told to work in');
});

await proved('the folder\'s name is never what settles it', 'name-compare', async () => {
	const wrong = await ask(PATH_SITE, TOKEN_A, { name: 'site', body: HEADER + TOKEN_B + '\n' });
	const right = await ask(PATH_SITE, TOKEN_A, { name: 'moved', body: HEADER + TOKEN_A + '\n' });
	return wrong.proof.ok === false && right.proof.ok === true;
});

await proved('the page reads the identity file and never writes one', 'creates-file', async () => {
	const r = await ask(PATH_A, TOKEN_A, { name: 'empty', body: null });
	return r.proof.ok === false && r.there.dir === false && r.there.file === false;
});

await proved('the token is the first line that is not a comment', 'first-line', async () => {
	const good = await ask(PATH_A, TOKEN_A, { name: 'alpha', body: HEADER + TOKEN_A + '\n' });
	const bad2 = await ask(PATH_A, TOKEN_A, { name: 'commented', body: `# ${TOKEN_A}\n\n${TOKEN_B}\n` });
	return good.proof.ok === true && bad2.proof.ok === false;
});

await proved('silence is an older hand and not a mismatch', 'silence-refuses', async () => {
	const r = await ask(PATH_A, null, null);
	return r.proof.ok === true && r.st.paired === true;
});

await proved('a folder swapped under the page is checked again', 'stale-cache', async () => {
	const r = await page.evaluate(async ([root, tok, header, other, parent]) => {
		window.__folder = await window.__folderWith(parent, 'alpha', header + tok + '\n');
		window.__handSays(root, tok);
		const first = await DaimondHand.workspaceProof();
		window.__folder = await window.__folderWith(parent, 'beta', header + other + '\n');
		const second = await DaimondHand.workspaceProof();
		return { first: first.ok, second: second.ok };
	}, [PATH_A, TOKEN_A, HEADER, TOKEN_B, `w${++seq}`]);
	return r.first === true && r.second === false;
});

await proved('a workspace with no folder is refused rather than skipped', 'opfs-passes', async () => {
	const r = await ask(PATH_A, TOKEN_A, null);
	return r.proof.ok === false && r.st.paired === false;
});

await proved('a comparison that cannot be made is refused', 'unchecked-passes', async () => {
	const r = await page.evaluate(async ([root, tok]) => {
		DaimondHand.init({ folder: function () { throw new Error('the folder handle is gone'); } });
		window.__handSays(root, tok);
		const st = JSON.parse(await DaimondHand.status());
		DaimondHand.init({ folder: function () { return window.__folder; } });
		return st;
	}, [PATH_A, TOKEN_A]);
	return r.paired === false && r.workspace === 'unchecked';
});

await proved('an unprovable identity is refused rather than believed', 'unproven-passes', async () => {
	const r = await ask(PATH_A, 'unproven', { name: 'alpha', body: HEADER + TOKEN_A + '\n' });
	return r.proof.ok === false && r.st.paired === false;
});

console.log(`\n${ok.length} ok, ${bad.length} failed, `
	+ `${provedNames.length} properties proved against broken code.`);
if (bad.length) console.log(`failed:\n  ${bad.join('\n  ')}`);
await b.close();
server.close();
process.exit(bad.length ? 1 : (process.exitCode || 0));
