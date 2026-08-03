// verify_ptyedge.mjs — the three rungs under the Terminal panel, proved on the
// real thing.
//
// The panel above these was built and verified first, against a relay that
// could not carry a terminal message and a wasm module that exported nothing to
// compose one. This file is the other end: it proves that hand.js multiplexes a
// terminal onto the ONE link it already holds, that `Wasm.pty_request` composes
// a request the real hand accepts, and that the screen model survives a resize
// the way a real terminal does.
//
// ── What it runs against ────────────────────────────────────────────
//
// The REAL extension (the dev build, which is the shipped one plus the
// loopback origins) and the REAL `hand/target/release/daimond-hand`, registered
// as this profile's native messaging host and told which folder it was granted.
// So a session opened here goes page → hand.js → the extension's vetting → the
// hand → a pseudo-terminal on this machine, with nothing mocked anywhere along
// it. `test -t 0` is answered by the kernel and `stty size` by the terminal
// driver; neither can be satisfied by a test that is agreeing with itself.
//
// ── One thing is stood in for, and it is named ──────────────────────
//
// `hand/REVIEW.md` §1.14: the relay refuses to pair where the folder the page
// has open cannot be shown to be the folder the hand was granted. This page has
// no folder — and no automated page can have one, because a real folder arrives
// only through `showDirectoryPicker()`, a native dialog no harness can answer —
// so the verdict here is always a refusal. Section 3 asserts that refusal
// against the real hand; everywhere else `status()` is wrapped so that the
// verdict, and only the verdict, is stood in for. The hand's own account of
// itself passes through untouched, and every fence below is composed from it.
//
// ── The oracle for the screen model is tmux ─────────────────────────
//
// A resize is asserted against what tmux 3.6 actually does with the same
// sequence, read back with `capture-pane`, rather than against what this file
// thinks a terminal should do. The cases are the two that matter: the cursor
// inside the new height (where a shrink must keep the text and cost nothing)
// and the cursor below it (where the top of the screen goes into the history
// and comes back on the way out).
//
// ── Proved against broken code ──────────────────────────────────────
//
// Every property here is proved twice: the code under test is BROKEN and the
// check is required to go red, then restored and required to go green. The
// break is in the file or the wasm being tested, never in the harness — a
// harness that breaks itself proves only that both worlds answer alike.
//
//	hand.js and terminal.js	served through a patch, and the page reloaded.
//	pty_request		a whole second wasm package, built from a
//				patched src/wasm/pty.rs. Slow, and the only
//				honest way to break a function that lives in
//				a .wasm.
//
//	node dev/verify_ptyedge.mjs              # reuse the broken packages
//	node dev/verify_ptyedge.mjs --prove      # build them (about three minutes)
//
// Needs tmux, python3 and a built www/pkg. Run it headed, under xvfb, because
// the grant window is a real window and is really clicked:
//	xvfb-run -a -s "-screen 0 1400x900x24" node dev/verify_ptyedge.mjs
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const HERE	= path.dirname(fileURLToPath(import.meta.url));
const ROOT	= path.join(HERE, '..');
const WWW	= path.join(ROOT, 'www');
const HAND	= path.join(ROOT, 'hand/target/release/daimond-hand');
// Not /tmp -- it is a tmpfs and what is written there is RAM charged to this
// machine's agent fleet. See the SCRATCH note in harness.mjs.
const SCRATCH	= process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const WORK	= path.join(SCRATCH, `ptyedge-${process.pid}`);
const PROFILE	= path.join(WORK, 'profile');
const BROKEN	= path.join(SCRATCH, 'ptyedge-broken');
const PROVE	= process.argv.includes('--prove');

// The Diamond this session belongs to, as the panel would name it: a directory
// under the granted root, which is what `diamond_bounds` fences a turn to.
const OWN_DIR	= 'diamonds/d1';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A property proved twice: broken, and required to fail; whole, and required
/// to pass. `proved` counts only the pairs where BOTH halves answered as they
/// should — a check that passes with the code broken is blind and is reported
/// as such rather than counted.
const provedNames = [];
async function proved(name, breakIt, testIt, fixIt) {
	await breakIt();
	let red = true;
	try { red = await testIt(); } catch (e) { red = false; }
	await fixIt();
	let green = false;
	try { green = await testIt(); } catch (e) { green = false; }
	provedNames.push(name);
	check(`PROVED ${name}`, !red && green,
		`broken=${red ? 'PASSED — the check is blind' : 'failed, correctly'}, `
		+ `whole=${green ? 'passed' : 'FAILED'}`);
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'root', OWN_DIR), { recursive: true });
fs.mkdirSync(path.join(WORK, 'root/.daimond'), { recursive: true });
fs.mkdirSync(path.join(WORK, 'root/shared'), { recursive: true });
const GRANT = fs.realpathSync(path.join(WORK, 'root'));
fs.writeFileSync(path.join(GRANT, OWN_DIR, 'hello.txt'), 'inside the fence\n');
fs.writeFileSync(path.join(GRANT, '.daimond/secret.txt'), 'out of bounds\n');

// ┌───────────────────────────────────────────────────────────────┐
// │ The hand under test is built here, now, from this tree          │
// └───────────────────────────────────────────────────────────────┘
//
// This file used to take whatever was lying in `hand/target/release` and, where
// there was nothing, print a line and leave. Neither half is safe. Nothing in
// the test suite builds that binary, and nor did this file, so a release binary
// from last week would drive the pty edge and report it green against code that
// no longer exists — a verifier that cannot say which code it measured must not
// report success. `verify_kitfence.mjs` records having measured exactly that:
// with a `CARGO_TARGET_DIR` inherited, its checks passed against a binary from
// before the clamp existed. `hand/src/exec.rs`'s `shipping_hand` refuses for the
// same reason on the debug side.
//
// So: build first, and then require the artefact to be newer than every source
// cargo says went into it. `CARGO_TARGET_DIR` is REMOVED from the build's
// environment, and that is not tidying — an agent working in this tree usually
// has one set, cargo would write the new binary there, and `HAND`, the path this
// registers as the profile's native messaging host, would still be whatever was
// built last.

/// What to run by hand when this refuses.
const REBUILD = 'cargo build --release --manifest-path hand/Cargo.toml';

/// The prerequisites named on one line of a cargo dep-info file.
///
/// Make's escaping, which is what the format is: a backslash makes the character
/// after it ordinary, so a path containing a space survives being split on
/// whitespace. The same reading as `dep_sources` in `hand/src/exec.rs`.
function depSources(list) {
	const out = [];
	let cur = '', esc = false;
	for (const c of list) {
		if (esc) { cur += c; esc = false; }
		else if (c === '\\') { esc = true; }
		else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } }
		else { cur += c; }
	}
	if (cur) out.push(cur);
	return out;
}

/// Why the binary at `bin` is not this tree's, or '' when there is no reason.
///
/// The oracle is cargo's own dep-info file, `<bin>.d`, written beside it: it
/// names every source that went into the binary, this crate's and every fe2o3
/// crate's, so a change anywhere below the pty edge counts. A missing binary, a
/// missing or silent record, a source that can no longer be read, or a source
/// newer than the binary are each a refusal with the sentence that says so.
function whyStale(bin) {
	let built;
	try { built = fs.statSync(bin).mtimeMs; }
	catch (e) {
		return `The pty edge cannot be verified, because there is no hand at ${bin} `
			+ `to verify it against. Run \`${REBUILD}\` and try again.`;
	}
	const record = `${bin}.d`;
	let listed;
	try { listed = fs.readFileSync(record, 'utf8'); }
	catch (e) {
		return `The pty edge cannot be verified, because ${bin} has no dep-info file at `
			+ `${record}, so there is no record of what went into it and its vintage `
			+ `cannot be established. Run \`${REBUILD}\` and try again.`;
	}
	let described = false;
	let newest = null;
	for (const line of listed.split('\n')) {
		const at = line.indexOf(':');
		if (at < 0) continue;
		if (path.resolve(line.slice(0, at).trim()) !== path.resolve(bin)) continue;
		described = true;
		for (const src of depSources(line.slice(at + 1))) {
			let t;
			try { t = fs.statSync(src).mtimeMs; }
			catch (e) {
				return `The pty edge cannot be verified, because ${bin} was built from `
					+ `${src}, which can no longer be read, so what is inside the binary `
					+ `cannot be established. Run \`${REBUILD}\` and try again.`;
			}
			if (!newest || t > newest.t) newest = { src, t };
		}
	}
	if (!described) {
		return `The pty edge cannot be verified, because ${record} says nothing about `
			+ `${bin}, so that binary is not the one this build produced. Run `
			+ `\`${REBUILD}\` and try again.`;
	}
	if (newest && newest.t > built) {
		const by = Math.round((newest.t - built) / 1000);
		return `The pty edge would have been verified against a stale hand, which proves `
			+ `nothing about it in either direction: ${newest.src} was last changed ${by} `
			+ `second(s) after ${bin} was linked, so that binary is not this source. Run `
			+ `\`${REBUILD}\` and try again.`;
	}
	return '';
}

const buildEnv = { ...process.env };
delete buildEnv.CARGO_TARGET_DIR;
// `PTYEDGE_NO_BUILD` skips the build and nothing else: the staleness guard below
// runs either way, so the variable cannot make this file report success against
// code it did not test — it can only make it refuse. It is here so that the
// guard can be shown to refuse, which is the only way to know it works.
if (!process.env.PTYEDGE_NO_BUILD) {
	const built = spawnSync('cargo', ['build', '--release', '--manifest-path', 'hand/Cargo.toml'],
		{ cwd: ROOT, encoding: 'utf8', env: buildEnv });
	if (built.status !== 0) {
		console.error(`The hand did not build, so there is nothing here to verify the pty `
			+ `edge against. Fix the build and run this again.\n`
			+ (built.stderr || '').split('\n').filter((l) => /^error/.test(l)).slice(0, 5).join('\n'));
		process.exit(2);
	}
}
const stale = whyStale(HAND);
if (stale) {
	console.error(stale);
	process.exit(2);
}
console.log(`The hand under test was built from this tree: ${HAND}`);

// ── And the other half of what is under test ────────────────────
//
// Sections 1 to 3 run against `www/pkg`, so `pty_request` there is as much the
// code under test as the hand is, and a bundle older than the engine it was
// built from would carry the same fail-open: green against a composition that no
// longer exists. Every `.rs` under `src/` goes into that bundle, so any one of
// them being newer than it is enough to say it is not this tree. Not rebuilt
// here, because a wasm build is minutes and a surprise one in the middle of a
// verifier is worse than a sentence saying what to run.
const WASM_FILE = path.join(WWW, 'pkg/oxedyne_daimond_bg.wasm');

/// Every Rust source under `dir`, which is everything the bundle is built from.
function rustSources(dir) {
	const out = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const f = path.join(dir, ent.name);
		if (ent.isDirectory()) out.push(...rustSources(f));
		else if (ent.name.endsWith('.rs')) out.push(f);
	}
	return out;
}

const wasmAt = fs.existsSync(WASM_FILE) ? fs.statSync(WASM_FILE).mtimeMs : 0;
if (!wasmAt) {
	console.error(`The pty edge cannot be verified, because there is no wasm bundle at `
		+ `${WASM_FILE} and \`pty_request\` lives in it. Run \`dev/build-wasm.sh\` and try again.`);
	process.exit(2);
}
const newestSrc = rustSources(path.join(ROOT, 'src'))
	.map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
	.reduce((a, b) => (a && a.t >= b.t ? a : b), null);
if (newestSrc && newestSrc.t > wasmAt) {
	console.error(`The pty edge would have been verified against a stale engine, which proves `
		+ `nothing about it in either direction: ${newestSrc.f} was last changed `
		+ `${Math.round((newestSrc.t - wasmAt) / 1000)} second(s) after ${WASM_FILE} was built, `
		+ `so that bundle is not this source. Run \`dev/build-wasm.sh\` and try again.`);
	process.exit(2);
}
console.log(`and the engine under test was built from this tree: ${WASM_FILE}`);

// ┌───────────────────────────────────────────────────────────────┐
// │ The tmux oracle                                                │
// └───────────────────────────────────────────────────────────────┘
//
// A real terminal, driven with the same bytes, read back with the tool that
// ships with it. The pane runs `cat` on a fifo so that nothing but the lines
// under test is ever written: a shell would add a prompt, and typing into one
// would add the echo of the keystrokes, which is how a test ends up asserting
// against its own input.

/// One resize, as tmux does it.
///
/// # Arguments
/// * `rows` - The height the pane opens at.
/// * `lines` - The lines printed before the resize.
/// * `nr` - The height it is resized to.
/// * `back` - An optional second height, to grow back to.
///
/// # Returns
/// `{ screen, cursorY, hist, history }` for each stage, or null when tmux is
/// not on this machine.
function tmuxResize(rows, lines, nr, back) {
	const sock = `ptyedge${process.pid}`;
	const fifo = path.join(WORK, `fifo-${Math.random().toString(36).slice(2, 8)}`);
	const tm = (...a) => execFileSync('tmux', ['-L', sock, '-f', '/dev/null', ...a],
		{ encoding: 'utf8' });
	execFileSync('mkfifo', [fifo]);
	// Held open from this end for as long as the case lasts, so `cat` does not
	// see end-of-file after the first write and exit.
	const fd = fs.openSync(fifo, 'r+');
	const state = () => ({
		screen:  tm('capture-pane', '-p').replace(/\n+$/, '').split('\n'),
		history: tm('capture-pane', '-p', '-S', '-', '-E', '-1').replace(/\n+$/, ''),
		cursorY: Number(tm('display-message', '-p', '#{cursor_y}').trim()),
		hist:    Number(tm('display-message', '-p', '#{history_size}').trim()),
		height:  Number(tm('display-message', '-p', '#{pane_height}').trim()),
	});
	try {
		tm('new-session', '-d', '-x', '40', '-y', String(rows), `cat ${fifo}`);
		spawnSync('sleep', ['0.4']);
		for (const l of lines) {
			fs.writeSync(fd, `${l}\n`);
			spawnSync('sleep', ['0.08']);
		}
		spawnSync('sleep', ['0.3']);
		const before = state();
		tm('resize-window', '-y', String(nr));
		spawnSync('sleep', ['0.4']);
		const after = state();
		let grown = null;
		if (back) {
			tm('resize-window', '-y', String(back));
			spawnSync('sleep', ['0.4']);
			grown = state();
		}
		return { before, after, grown };
	} finally {
		try { fs.closeSync(fd); } catch (e) { /* already shut */ }
		try { tm('kill-server'); } catch (e) { /* already gone */ }
		try { fs.rmSync(fifo); } catch (e) { /* already gone */ }
	}
}

// ┌───────────────────────────────────────────────────────────────┐
// │ Breaking the code under test                                   │
// └───────────────────────────────────────────────────────────────┘

/// What each named break does to the file it is a break of.
///
/// Each is a plausible bug rather than a nonsense edit: the substitution is
/// what the code looked like before the property was there, or what a
/// reasonable person would write if they had not thought about it.
const PATCHES = {
	// hand.js
	'send-missing': ['js/hand.js', 'send: send,', ''],
	'no-dispatch':  ['js/hand.js', 'if (msg.id) toSubs(msg.id, msg);', ''],
	'no-gone':      ['js/hand.js', '\t\tsayGone(why);', ''],
	'second-port':  ['js/hand.js',
		'if (link && link.greeted) return Promise.resolve(link);', 'link = null;'],
	// What a person writes who has not met a port that dies between the
	// handshake and the post: no guard, and a throw swallowed. The whole block
	// goes, because the guard alone would still be covered by the catch.
	'swallow-dead': ['js/hand.js',
		'\t\t\tif (rec.dead || link !== rec) {',
		'\t\t\ttry { rec.port.postMessage(msg); } catch (e) { /* gone */ }\n'
		+ '\t\t\treturn undefined;\n'
		+ '\t\t\t// eslint-disable-next-line no-unreachable\n'
		+ '\t\t\tif (rec.dead || link !== rec) {'],
	// terminal.js — the shape the resize had before tmux was asked.
	'resize-bottom': ['js/terminal.js', 'fitHeight(prim, pcur, nr);',
		'var keep = prim.slice(Math.max(0, prim.length - nr));'
		+ ' var lost = prim.length - keep.length;'
		+ ' while (keep.length < nr) { var pl = newLine(cols); blankLine(pl, 0, cols, 0, 0, 0); keep.push(pl); }'
		+ ' prim.length = 0; for (var pi = 0; pi < keep.length; pi++) prim.push(keep[pi]);'
		+ ' pcur.y = Math.max(0, Math.min(nr - 1, pcur.y - lost));'],
	'resize-nogrow': ['js/terminal.js',
		'\t\t\t\tif (sb.length) {\n\t\t\t\t\tls.unshift(sb.pop());',
		'\t\t\t\tif (false) {\n\t\t\t\t\tls.unshift(sb.pop());'],
	'resize-noalt': ['js/terminal.js',
		'var prim = S.modes.alt ? alt : lines;', 'var prim = lines;'],
};

/// The break currently in force, or ''. Read by the stub server.
let breaking = '';

/// The source of one served file, patched if a break names it.
function served(rel) {
	let src = fs.readFileSync(path.join(WWW, rel), 'utf8');
	const p = PATCHES[breaking];
	if (p && p[0] === rel) {
		if (src.indexOf(p[1]) < 0) {
			console.error(`  !! the break "${breaking}" no longer matches ${rel}; `
				+ 'the patch is stale and would prove nothing');
			process.exitCode = 3;
		}
		src = src.replace(p[1], p[2]);
	}
	return src;
}

// ── The wasm breaks ─────────────────────────────────────────────
//
// `pty_request` lives in the .wasm, so there is nothing to substitute at serve
// time. Each break is therefore a whole second package, built from a patched
// `src/wasm/pty.rs` with `--dev` (which skips wasm-opt and is four times
// quicker). The pristine package is built the SAME way, so a broken run and a
// whole run differ only in the patch.

const PTY_RS = path.join(ROOT, 'src/wasm/pty.rs');

/// The wasm breaks, each one line of `src/wasm/pty.rs` turned into a plausible
/// mistake.
const WASM_PATCHES = {
	'w-term': ['None      => fmt!("[]"),', 'None      => fmt!(r#"[["TERM","xterm-256color"]]"#),'],
	'w-nofence': ['if !fence_enforced(&machine.caps) {', 'if false {'],
	'w-noroot': ['if !machine.rooted() {', 'if false {'],
	'w-nopair': ['if extract_json_bool(&st, "paired") != Some(true) {', 'if false {'],
	'w-nocwd': ['if !inside(&cwd, &fence.rw) && !inside(&cwd, &fence.ro) {', 'if false {'],
	'w-tainted': ['extract_json_bool(ask, "tainted") == Some(true));', 'false);'],
	'w-argvkit': ['bounds.extend(toolkit_bounds(&extract_json_string_array(ask, "toolkits").unwrap_or_default()));',
		'bounds.extend(toolkit_bounds(&extract_json_string_array(ask, "argv").unwrap_or_default()));'],
};

/// Builds one wasm package, patching `src/wasm/pty.rs` first where `name` is a
/// break rather than the pristine build.
///
/// The file is restored whatever happens: a verifier that left a deliberate
/// bug in the tree would be worse than no verifier.
function buildWasm(name) {
	const out = path.join(BROKEN, name, 'pkg');
	const orig = fs.readFileSync(PTY_RS, 'utf8');
	try {
		if (name !== 'whole') {
			const [from, to] = WASM_PATCHES[name];
			if (orig.indexOf(from) < 0) {
				throw new Error(`the wasm break "${name}" no longer matches src/wasm/pty.rs`);
			}
			fs.writeFileSync(PTY_RS, orig.replace(from, to));
		}
		const env = Object.assign({}, process.env, {
			CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR
				|| path.join(os.homedir(), '.cache/cargo-targets/daimond_ptyedge_target'),
			RUSTFLAGS: `--remap-path-prefix=${os.homedir()}/.cargo=/cargo `
				+ `--remap-path-prefix=${ROOT}=/build`,
		});
		execFileSync('wasm-pack',
			['build', '--dev', '--target', 'web', '--out-dir', out],
			{ cwd: ROOT, env, stdio: 'pipe' });
	} finally {
		fs.writeFileSync(PTY_RS, orig);
	}
	return out;
}

if (PROVE || !fs.existsSync(path.join(BROKEN, 'whole/pkg/oxedyne_daimond.js'))) {
	console.log('\nBuilding the wasm packages the pty_request checks are proved against.');
	for (const name of ['whole', ...Object.keys(WASM_PATCHES)]) {
		process.stdout.write(`  building ${name} … `);
		const t0 = Date.now();
		buildWasm(name);
		console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
	}
}

/// Which wasm package the page is loading: '' for the one in www/pkg, or a name
/// under the broken tree.
let usingPkg = '';

// ┌───────────────────────────────────────────────────────────────┐
// │ The page                                                       │
// └───────────────────────────────────────────────────────────────┘
//
// The relay, the terminal renderer and the wasm module, and nothing else: this
// is what the app has under its Terminal panel, without the app. The panel
// itself is verified by dev/verify_termpanel.mjs against the same surface.

const PAGE = `<!doctype html><meta charset="utf-8"><title>ptyedge</title>
<body>
<div id="host" style="width:720px;height:360px"></div>
<script src="/js/terminal.js"><\/script>
<script src="/js/hand.js"><\/script>
<script src="/js/handpty.js"><\/script>
<script type="module">
import init, * as W from '/pkg/oxedyne_daimond.js';
await init();
window.Wasm = W;
window.__ready = true;
<\/script>
<script>
/// Everything one session has said, for the far end to read back.
window.__watch = function () {
	window.__seen = { bytes: [], gaps: [], errs: [], closed: null, order: [] };
	return {
		onOutput: function (b) {
			window.__seen.order.push('out');
			window.__seen.bytes.push(Array.prototype.slice.call(b));
		},
		onGap:    function (g) { window.__seen.order.push('gap'); window.__seen.gaps.push(g); },
		onError:  function (e) { window.__seen.order.push('err'); window.__seen.errs.push(e); },
		onClosed: function (c) { window.__seen.order.push('closed'); window.__seen.closed = c; },
	};
};
/// Everything the relay carried for one id, raw, so the ORDER can be asserted.
window.__tap = function (id) {
	window.__raw = [];
	return DaimondHand.subscribe(id, function (m) { window.__raw.push(m); });
};
<\/script>
</body>`;

const server = http.createServer((req, res) => {
	const url = (req.url || '').split('?')[0];
	const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
	if (url === '/favicon.ico') { res.writeHead(404); return res.end('no'); }
	if (url.startsWith('/js/')) {
		return send('text/javascript; charset=utf-8', served(url.slice(1)));
	}
	if (url.startsWith('/pkg/')) {
		const base = usingPkg ? path.join(BROKEN, usingPkg, 'pkg') : path.join(WWW, 'pkg');
		const f = path.join(base, url.slice('/pkg/'.length));
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
const PORT = await listen(Number(process.env.PTYEDGE_PORT || 8797));
const APP  = `http://127.0.0.1:${PORT}`;

// ┌───────────────────────────────────────────────────────────────┐
// │ The browser, the extension and the real hand                   │
// └───────────────────────────────────────────────────────────────┘

const { extDev } = await import(pathToFileURL(path.join(HERE, 'extdev.mjs')).href);
const EXT_DEV = await extDev(PORT);

fs.mkdirSync(path.join(PROFILE, 'NativeMessagingHosts'), { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'NativeMessagingHosts/com.oxedyne.daimond.hand.json'),
	JSON.stringify({
		name:		'com.oxedyne.daimond.hand',
		description:	'The real hand, for verify_ptyedge.mjs.',
		path:		HAND,
		type:		'stdio',
		allowed_origins: ['chrome-extension://mpliijponglmmffjnonahhignkpkhmij/'],
	}, null, '\t') + '\n');

const b = await chromium.launchPersistentContext(PROFILE, {
	executablePath:	CHROME,
	headless:	false,
	args: ['--no-sandbox', '--disable-dev-shm-usage',
		`--disable-extensions-except=${EXT_DEV}`, `--load-extension=${EXT_DEV}`],
	viewport: { width: 1200, height: 800 },
	// The hand is told which folder it was granted through its environment,
	// which it inherits from the browser that launched it. There is no third
	// answer by design: a hand that guessed a root would be guessing what a
	// command may touch.
	env: Object.assign({}, process.env, {
		DAIMOND_HAND_ROOT: GRANT,
		DAIMOND_HAND_JOURNAL_DIR: path.join(WORK, 'journal'),
	}),
});

const page = b.pages()[0] || await b.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));

/// Loads the page again, with whatever break and whichever wasm package are in
/// force. The reload is what puts a patched file into the running page.
async function reload() {
	await page.goto(APP, { waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
	await page.evaluate(() => {
		// Tens of seconds is right for a person answering an approval window
		// and wrong for a test that has already answered it.
		if (window.DaimondPty && DaimondPty._setWaitsForTest) DaimondPty._setWaitsForTest({ open: 20000 });
		if (window.DaimondHand && DaimondHand._setWaitsForTest) DaimondHand._setWaitsForTest({ hello: 20000, grace: 20000 });
		// ── The folder verdict, stood in for ────────────────────────
		//
		// `hand/REVIEW.md` §1.14 is armed: the relay refuses to pair where the
		// folder the page has open cannot be shown to be the folder the hand was
		// granted. This page has no folder at all — it is three script tags, and
		// even the app cannot get one without `showDirectoryPicker()`, a native
		// dialog no harness can answer — so the verdict here is always a refusal
		// and there is no arrangement of this file in which it is not. What is
		// under test below is the COMPOSITION of a terminal request and a real pty
		// on this machine, so the verdict is stood in for, as `dev/verify_scope.mjs`
		// does. `dev/verify_wsident.mjs` tests the refusal itself, and section 3
		// asserts it here once against the real hand before this takes effect.
		//
		// Only the verdict. The hand's own account of itself — its root, its caps,
		// its os — passes through untouched, and the fence every request composes
		// is built from it.
		var real = window.DaimondHand.status;
		window.__realStatus = function () { return real.call(window.DaimondHand); };
		window.DaimondHand.status = function () {
			return real.call(window.DaimondHand).then(function (raw) {
				var st = JSON.parse(raw);
				if (st.workspace && st.workspace !== 'ok') {
					st.paired = true;
					delete st.reason;
					st.workspace = 'stood in for by verify_ptyedge.mjs';
				}
				return JSON.stringify(st);
			});
		};
	});
}

/// Finds the extension's grant window and answers it. It is the extension's own
/// page, so the click is a real click and the answer is the real answer.
async function grant(answer = 'allow', ms = 15000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		for (const p of b.pages()) {
			if (/grant\.html/.test(p.url())) {
				await p.waitForLoadState('domcontentloaded');
				await sleep(250);
				await p.click(answer === 'allow' ? '#allow' : '#deny');
				return true;
			}
		}
		await sleep(150);
	}
	return false;
}

/// How many hand processes this profile has running. The one-link property is
/// what keeps it at one: Chrome starts a fresh host per connection, so a second
/// port is a second process and a second approval question.
function hands() {
	const r = spawnSync('pgrep', ['-fa', HAND], { encoding: 'utf8' });
	return (r.stdout || '').split('\n')
		// The launcher arm is the same binary re-executed to apply a fence and
		// then become the command, so it is not a second host.
		.filter((l) => l.trim() && l.indexOf('--daimond-hand-launch') < 0).length;
}

// ┌───────────────────────────────────────────────────────────────┐
// │ 1. The screen model, against tmux                              │
// └───────────────────────────────────────────────────────────────┘

await reload();

/// The same case, run through the screen model in the page.
///
/// # Arguments
/// * `rows` - The height the screen opens at.
/// * `lines` - The lines printed before the resize.
/// * `nr` - The height it is resized to.
/// * `back` - An optional second height, to grow back to.
async function modelResize(rows, lines, nr, back) {
	return await page.evaluate(([rows, lines, nr, back]) => {
		const S = DaimondTerminal.screen(40, rows, { scrollback: 5000 });
		// A pty translates a program's \n into \r\n on the way out, so that is
		// what a terminal is actually fed.
		for (const l of lines) S.write(l + '\r\n');
		const read = () => {
			S.compose(true);
			const screen = [];
			for (let y = 0; y < S.rows; y++) screen.push(S.lineText(S.absOfRow(y)));
			const history = [];
			for (let a = S.absTop(); a < S.absTop() + S.scrollback(); a++) history.push(S.lineText(a));
			return { screen, history: history.join('\n'), cursorY: S.cursor.y,
				hist: S.scrollback(), height: S.rows };
		};
		const before = read();
		S.resize(40, nr);
		const after = read();
		let grown = null;
		if (back) { S.resize(40, back); grown = read(); }
		return { before, after, grown };
	}, [rows, lines, nr, back]);
}

/// tmux pads a captured pane's short lines with nothing and the model returns
/// the same, but a trailing run of empty rows is written differently by the two
/// (tmux drops them from `capture-pane`). Compared on the rows that have text.
const textOf = (rows) => rows.map((s) => s.replace(/\s+$/, '')).filter((s) => s !== '');

console.log('\n── 1. The screen model, against tmux ─────────────────');

const T1 = tmuxResize(20, ['one', 'two'], 10);
const M1 = await modelResize(20, ['one', 'two'], 10);
check('tmux: shrinking 20 rows to 10 with the cursor at row 2 keeps both lines',
	textOf(T1.after.screen).join('|') === 'one|two' && T1.after.cursorY === 2 && T1.after.hist === 0,
	`tmux says ${JSON.stringify(textOf(T1.after.screen))} cursor=${T1.after.cursorY} hist=${T1.after.hist}`);
check('the model does what tmux does on that shrink',
	textOf(M1.after.screen).join('|') === textOf(T1.after.screen).join('|')
	&& M1.after.cursorY === T1.after.cursorY && M1.after.hist === T1.after.hist,
	`model ${JSON.stringify(textOf(M1.after.screen))} cursor=${M1.after.cursorY} hist=${M1.after.hist}`);

const L15 = Array.from({ length: 15 }, (_, i) => `L${i + 1}`);
const T2 = tmuxResize(20, L15, 10, 20);
const M2 = await modelResize(20, L15, 10, 20);
check('tmux: with the cursor below the new height the top goes into the history',
	textOf(T2.after.screen).join('|') === 'L7|L8|L9|L10|L11|L12|L13|L14|L15'
	&& T2.after.cursorY === 9 && T2.after.hist === 6,
	`tmux says ${JSON.stringify(textOf(T2.after.screen))} cursor=${T2.after.cursorY} hist=${T2.after.hist}`);
check('the model does what tmux does on that shrink',
	textOf(M2.after.screen).join('|') === textOf(T2.after.screen).join('|')
	&& M2.after.cursorY === T2.after.cursorY && M2.after.hist === T2.after.hist,
	`model ${JSON.stringify(textOf(M2.after.screen))} cursor=${M2.after.cursorY} hist=${M2.after.hist}`);
check('tmux: growing back takes those lines out of the history again',
	textOf(T2.grown.screen).join('|') === L15.join('|') && T2.grown.cursorY === 15 && T2.grown.hist === 0,
	`tmux says cursor=${T2.grown.cursorY} hist=${T2.grown.hist}`);
check('the model does what tmux does on the way back',
	textOf(M2.grown.screen).join('|') === textOf(T2.grown.screen).join('|')
	&& M2.grown.cursorY === T2.grown.cursorY && M2.grown.hist === T2.grown.hist,
	`model cursor=${M2.grown.cursorY} hist=${M2.grown.hist}`);

// The panel's own case, which is what a user meets: the shrink happens, and
// then the program prints again.
const M3 = await page.evaluate(() => {
	const S = DaimondTerminal.screen(40, 20, { scrollback: 5000 });
	S.write('one\r\ntwo\r\n');
	S.resize(40, 10);
	S.write('three\r\n');
	const out = [];
	for (let a = S.absTop(); a < S.absTop() + S.scrollback() + S.rows; a++) out.push(S.lineText(a));
	while (out.length && out[out.length - 1] === '') out.pop();
	return out;
});
check('a panel resized mid-session keeps the screen the reader was reading',
	M3.join('|') === 'one|two|three', `the model holds ${JSON.stringify(M3)}`);

const M4 = await page.evaluate(() => {
	const S = DaimondTerminal.screen(40, 20, { scrollback: 5000 });
	S.write('shell line\r\n');
	S.write('\x1b[?1049h');			// into the alternate screen, cursor saved
	S.write('ALT');
	S.resize(30, 10);
	S.write('\x1b[?1049l');			// and back out of it
	S.compose(true);
	const screen = [];
	for (let y = 0; y < S.rows; y++) screen.push(S.lineText(S.absOfRow(y)));
	return { cols: S.cols, rows: S.rows, width: S.cells.ch.length, screen };
});
check('the parked primary screen comes back at the new size, not the old one',
	M4.width === M4.cols * M4.rows && M4.screen[0] === 'shell line',
	`cols=${M4.cols} rows=${M4.rows} first row ${JSON.stringify(M4.screen[0])}`);

// ┌───────────────────────────────────────────────────────────────┐
// │ 2. pty_request composes the wire's own open                    │
// └───────────────────────────────────────────────────────────────┘
//
// The hand's answer is what a machine says about itself, so it is the thing
// stood in for here: the code under test is the composition, and a machine that
// cannot fence, or that never said which folder it granted, is a machine and
// not a stub of this file's making. Every one of these is proved against a wasm
// built with the corresponding line removed.

console.log('\n── 2. pty_request ────────────────────────────────────');

const ASK = {
	own_dir:   OWN_DIR,
	attached:  ['shared'],
	read_only: ['shared'],
	cwd:       OWN_DIR,
	cols:      100,
	rows:      30,
};

/// Ask the wasm for a request, with the hand's answer stood in for.
///
/// # Arguments
/// * `ask` - What the panel would send, with anything overridden.
/// * `st` - What the relay's `status()` should answer, or null for the real one.
async function request(ask, st) {
	return await page.evaluate(async ([ask, st]) => {
		const real = window.DaimondHand.status;
		if (st) window.DaimondHand.status = () => Promise.resolve(JSON.stringify(st));
		try { return JSON.parse(await window.Wasm.pty_request(JSON.stringify(ask))); }
		finally { window.DaimondHand.status = real; }
	}, [ask, st || null]);
}

const FENCED = {
	paired: true, transport: 'machine', machine: 'test', os: 'linux',
	root: GRANT, caps: ['fence:linux', `root:${GRANT}`, `home:${os.homedir()}`],
};

/// Every pty_request property, as one function so the same code answers for the
/// whole wasm and for each broken one.
const REQ_CHECKS = {
	'composes the wire\'s own open, with the fence in it': async () => {
		const r = await request(ASK);
		return r.t === 'open' && !!r.fence
			&& r.fence.rw.indexOf(`${GRANT}/${OWN_DIR}`) >= 0
			&& r.fence.rw.indexOf(`${GRANT}/shared`) < 0
			&& r.fence.ro.indexOf(`${GRANT}/shared`) >= 0
			&& r.fence.deny.indexOf(`${GRANT}/.daimond`) >= 0
			&& r.cwd === `${GRANT}/${OWN_DIR}`
			&& r.size.cols === 100 && r.size.rows === 30;
	},
	'sends no TERM, which the hand sets and refuses a caller for naming': async () => {
		const r = await request(ASK);
		return Array.isArray(r.env) && !r.env.some((p) => p[0] === 'TERM');
	},
	'refuses a hand that cannot fence a program': async () => {
		const r = await request(ASK, Object.assign({}, FENCED, { caps: ['fence:none', `root:${GRANT}`] }));
		return !!r.refused && /cannot fence/.test(r.refused) && !r.t;
	},
	'refuses a hand that said nothing about fencing': async () => {
		const r = await request(ASK, Object.assign({}, FENCED, { caps: [`root:${GRANT}`] }));
		return !!r.refused && /did not say it can fence/.test(r.refused) && !r.t;
	},
	'refuses a hand that did not say which folder it was granted': async () => {
		const r = await request(ASK, Object.assign({}, FENCED, { root: '' }));
		return !!r.refused && /which folder it was granted/.test(r.refused) && !r.t;
	},
	'refuses when no hand is paired, in the relay\'s own words': async () => {
		const r = await request(ASK, { paired: false, caps: [], reason: 'THE RELAY SAID THIS.' });
		return !!r.refused && r.refused.indexOf('THE RELAY SAID THIS.') >= 0 && !r.t;
	},
	'refuses a working directory outside what the Diamond may touch': async () => {
		const r = await request(Object.assign({}, ASK, { cwd: '.daimond' }));
		return !!r.refused && /outside what this Diamond may touch/.test(r.refused) && !r.t;
	},
	'a tainted session loses the network': async () => {
		const clean = await request(ASK);
		const dirty = await request(Object.assign({}, ASK, { tainted: true }));
		return clean.fence.net === true && dirty.fence.net === false;
	},
	'a toolkit comes from what the user granted, never from argv': async () => {
		const asked = await request(Object.assign({}, ASK, { argv: ['cargo', 'test'] }));
		const granted = await request(Object.assign({}, ASK, { toolkits: ['rust'] }));
		const kit = `${os.homedir()}/.cargo/bin`;
		return asked.fence.ro.indexOf(kit) < 0
			&& !asked.env.some((p) => p[0] === 'CARGO_HOME')
			&& granted.fence.ro.indexOf(kit) >= 0
			&& granted.env.some((p) => p[0] === 'CARGO_HOME');
	},
};

/// Runs one named pty_request check.
async function reqCheck(name) {
	try { return await REQ_CHECKS[name](); } catch (e) { return false; }
}

for (const name of Object.keys(REQ_CHECKS)) {
	check(`pty_request ${name}`, await reqCheck(name));
}

// A few more that no broken build is built for, because they are not one line
// to remove: the defaults, and the ceilings.
{
	const bare = await request({ own_dir: OWN_DIR, attached: [], read_only: [], cwd: OWN_DIR });
	check('pty_request opens a shell when nobody named a program',
		bare.argv.join(' ') === '/bin/sh', `argv is ${JSON.stringify(bare.argv)}`);
	check('pty_request assumes 80x24 when the page did not say',
		bare.size.cols === 80 && bare.size.rows === 24, JSON.stringify(bare.size));
	const named = await request(Object.assign({}, ASK, { argv: ['/bin/sh', '-c', 'true'] }));
	check('pty_request honours an argv it was given',
		named.argv.join(' ') === '/bin/sh -c true', JSON.stringify(named.argv));
	const huge = await request(Object.assign({}, ASK, { cols: 99999, rows: 0 }));
	check('pty_request holds the size to what the wire can carry',
		huge.size.cols === 2000 && huge.size.rows === 24, JSON.stringify(huge.size));
	const nowhere = await request({ own_dir: '', attached: [], read_only: [], cwd: '' });
	check('pty_request refuses a Diamond whose bounds name nowhere',
		!!nowhere.refused && !nowhere.t, JSON.stringify(nowhere).slice(0, 120));
	const win = await request(ASK, Object.assign({}, FENCED, { os: 'windows' }));
	check('pty_request refuses a machine with no pseudo-terminals',
		!!win.refused && /Windows/.test(win.refused), JSON.stringify(win).slice(0, 120));
	const mine = await request(ASK);
	check('pty_request mints no id, leaving that to the end that knows the page\'s sessions',
		mine.id === undefined, JSON.stringify(mine.id));
	// Printed rather than asserted: what a reader wants from this file is the
	// request itself, and a check that only says "true" hides it.
	console.log(`         the request it composed: ${JSON.stringify(mine)}`);
}

// ┌───────────────────────────────────────────────────────────────┐
// │ 3. End to end: a real terminal on this machine                 │
// └───────────────────────────────────────────────────────────────┘

console.log('\n── 3. A real pty, through the real extension and hand ─');

/// Opens a session for real and returns what happened.
async function openReal(ask) {
	return await page.evaluate(async (ask) => {
		const req = JSON.parse(await window.Wasm.pty_request(JSON.stringify(ask)));
		if (req.refused) return { refused: req.refused };
		window.__req = req;
		const subs = window.__watch();
		try {
			const live = await DaimondPty.open(req, subs);
			window.__sid = live.id;
			return { id: live.id, pid: live.pid };
		} catch (e) {
			return { refused: (e && e.message) || String(e) };
		}
	}, ask);
}

/// Opens a terminal by sending the wire message on the link directly, and
/// reports what the relay handed to a subscriber watching that id.
///
/// The low road, deliberately: `DaimondPty` is not in the way, so what is
/// proved is hand.js's own multiplexing rather than the relay above it.
async function probeOpen(id = 'probe-1', tries = 3) {
	for (let n = 0; n < tries; n++) {
		const said = await probeOnce(id);
		// A link that would not open at all is not the property under test, and
		// it happens: the previous host is still exiting and the next one
		// cannot take the journal's lock yet. Retried, so that a red result
		// means the subscriber heard nothing rather than that nothing was sent.
		if (!/^send rejected|^evaluate threw/.test(said)) {
			if (!/opened/.test(said)) console.log(`    (the probe was told: ${String(said).slice(0, 300)})`);
			return said;
		}
		await sleep(1500);
		await reload();
	}
	console.log('    (the link would not open at all, three times over)');
	return '';
}

/// One attempt at that.
async function probeOnce(id) {
	const r = await Promise.all([
		page.evaluate(async ([root, id]) => {
			window.__heard = [];
			const off = DaimondHand.subscribe(id, (m) => window.__heard.push(
				m.t + (m.t === 'refused' || m.t === 'error' ? ':' + (m.reason || m.message || '') : '')));
			const sent = await DaimondHand.send({
				t: 'open', id: id, argv: ['/bin/sh'], cwd: root,
				env: [], size: { cols: 20, rows: 5 },
				fence: { rw: [root], ro: [], deny: [], net: false },
			}).then(() => '', (e) => 'send rejected: ' + ((e && e.message) || e));
			await new Promise((r2) => setTimeout(r2, 2500));
			off();
			return (sent ? sent + ' | ' : '') + window.__heard.join(',');
		}, [GRANT, id]).catch((e) => 'evaluate threw: ' + e.message),
		allow(),
	]);
	return r[0];
}

/// Types at a session and waits for the program to answer.
async function typed(text, ms = 2500) {
	await page.evaluate((t) => DaimondPty.input(window.__sid, t), text);
	await sleep(ms);
	return await page.evaluate(() => {
		const all = [].concat.apply([], window.__seen.bytes);
		return new TextDecoder().decode(new Uint8Array(all));
	});
}

const opened = await Promise.all([openReal(ASK), grant('allow')]).then((r) => r[0]);
/// The origin is granted once and remembered, so every later open finds no
/// window at all; the short wait is what keeps this from costing a minute.
const allow = () => grant('allow', 4000);
check('a real terminal opens on this machine, through the extension and the hand',
	!!opened.id && opened.pid > 0, JSON.stringify(opened));

// ── §1.14, asked of the real hand, with nothing stood in for ────
//
// The relay's OWN answer, reached through `__realStatus`. The hand has a folder
// on this machine and this page has none, so the two cannot be shown to mean the
// same folder and the relay refuses the pairing outright — which is what a user
// with the wrong folder open meets, and the reason everything else in this file
// stands the verdict in. Asserted against the REAL hand, because a refusal that
// only ever fires against a stub is a refusal nobody has watched happen.
const owned = await page.evaluate(async (ask) => {
	const st = JSON.parse(await window.__realStatus());
	const stood = window.DaimondHand.status;
	window.DaimondHand.status = window.__realStatus;
	let req;
	try { req = JSON.parse(await window.Wasm.pty_request(JSON.stringify(ask))); }
	finally { window.DaimondHand.status = stood; }
	return { st, req };
}, ASK);
check('the relay refuses to pair a folder it cannot show is the hand\'s',
	owned.st.paired === false && owned.st.root === GRANT
	&& /lives in the browser and not in a folder on this machine/.test(owned.st.reason || ''),
	JSON.stringify(owned.st).slice(0, 220));
check('and the engine opens no terminal on it, passing the sentence on whole',
	!!owned.req.refused && owned.req.t === undefined
	&& /lives in the browser and not in a folder on this machine/.test(owned.req.refused),
	JSON.stringify(owned.req).slice(0, 220));

let SAW = '';
if (opened.id) {
	// The marker is COMPOSED by the shell and never typed. A terminal echoes
	// what is typed at it, so a test looking for a word it had just sent finds
	// its own keystrokes and passes with the program removed entirely.
	SAW = await typed('t=IS; test -t 0 && echo "$t-A-TTY"\n');
	check('the program really has a terminal: test -t 0 says so',
		/IS-A-TTY/.test(SAW), JSON.stringify(SAW.slice(-160)));

	SAW = await typed('stty size\n');
	check('the kernel reports the panel\'s own size to the program',
		new RegExp(`\\b${ASK.rows} ${ASK.cols}\\b`).test(SAW),
		`expected "${ASK.rows} ${ASK.cols}" in ${JSON.stringify(SAW.slice(-160))}`);

	SAW = await typed('echo "sum-$((6*7))"\n');
	check('what is typed reaches the program, which answers it',
		/sum-42/.test(SAW), JSON.stringify(SAW.slice(-120)));

	SAW = await typed('cat hello.txt\n');
	check('the session can read inside the fence',
		/inside the fence/.test(SAW), JSON.stringify(SAW.slice(-160)));

	SAW = await typed('cat .daimond/secret.txt 2>&1 | tail -1\n');
	check('and cannot read the folder the fence denies',
		!/out of bounds/.test(SAW), JSON.stringify(SAW.slice(-200)));

	// The renderer, fed the real bytes: this is the whole road, from a program
	// on the machine to the grid a person reads.
	const drawn = await page.evaluate(() => {
		const T = DaimondTerminal.create(document.getElementById('host'), { label: 'e2e' });
		for (const c of window.__seen.bytes) T.write(new Uint8Array(c));
		const out = T.screen.allText();
		T.destroy();
		return out;
	});
	check('the terminal renderer draws what the program wrote',
		/IS-A-TTY/.test(drawn) && /sum-42/.test(drawn), JSON.stringify(drawn.slice(-160)));

	check('one hand process, however many conversations are on the link',
		hands() === 1, `${hands()} running`);

	const heard = await probeOpen('probe-0');
	check('a wire message sent straight down the link is answered to its subscriber',
		/opened/.test(heard), heard.slice(0, 220));

	const ord = await page.evaluate(() => window.__seen.order.join(','));
	check('the session reported no holes in its output', !/gap/.test(ord), ord.slice(0, 200));
}

// ── The link, and what the relay does when it dies ──────────────

const raw = await page.evaluate(() => {
	// A tap on the SAME id, watching the wire itself rather than the relay's
	// reading of it. Stopped again at once: a handler left attached would
	// double every message the next tap sees, which is a harness that breaks
	// its own check.
	const off = window.__tap(window.__sid);
	const isFn = typeof off === 'function';
	if (isFn) off();
	return isFn;
});
check('subscribe hands back the way to stop watching', raw === true);

const seqOk = await page.evaluate(async () => {
	const off = window.__tap(window.__sid);
	await DaimondPty.input(window.__sid, 'echo seq-check\n');
	await new Promise((r) => setTimeout(r, 1200));
	off();
	const out = window.__raw.filter((m) => m.t === 'output');
	let rising = out.length > 0;
	for (let i = 1; i < out.length; i++) if (out[i].seq !== out[i - 1].seq + 1) rising = false;
	return { n: out.length, rising, types: window.__raw.map((m) => m.t).join(',') };
});
check('subscribe delivers every message for its id, in arrival order',
	seqOk.n > 0 && seqOk.rising, JSON.stringify(seqOk));

// The link dies. Which sentence it produces is hand.js's decision and
// dev/verify_handrun.mjs proves that; what is proved here is that a subscriber
// is TOLD, with the sentence and with whether a hand was ever met.
const goneMsg = await page.evaluate(async () => {
	window.__gone = null;
	DaimondHand.subscribe(window.__sid, function (m) { if (m.t === '__gone') window.__gone = m; });
	const rejected = await DaimondHand.send({ t: 'input', id: window.__sid, data: 'AA==' })
		.then(() => '', (e) => (e && e.message) || String(e));
	// The link dies UNDER a send that is already on its way. `open` has already
	// resolved, so the post happens a microtask after the port went, which is
	// the shape of the "disconnected port object" failure: nothing has told the
	// relay yet, and it must not post into a corpse and call that a success.
	const inflight = DaimondHand.send({ t: 'input', id: window.__sid, data: 'AA==' })
		.then(() => '', (e) => (e && e.message) || String(e));
	DaimondHand.close();
	const caught = await inflight;
	await new Promise((r) => setTimeout(r, 300));
	return { gone: window.__gone, before: rejected, caught: caught };
});
check('a live link accepts a send without complaint', goneMsg.before === '', goneMsg.before);
check('a subscriber is told when the link dies, and whether a hand was ever met',
	!!goneMsg.gone && goneMsg.gone.met === true && typeof goneMsg.gone.message === 'string'
	&& goneMsg.gone.message.length > 20, JSON.stringify(goneMsg.gone).slice(0, 160));
check('a send caught by the link dying under it rejects with a sentence',
	typeof goneMsg.caught === 'string' && goneMsg.caught.length > 20,
	JSON.stringify(goneMsg.caught).slice(0, 200));
const thrown = errs.filter((e) => e.indexOf('pageerror:') === 0);
check('nothing in the relay, the renderer or the wasm threw on the page',
	thrown.length === 0, thrown.slice(0, 3).join(' | '));

// ┌───────────────────────────────────────────────────────────────┐
// │ 4. Every property, proved against the broken code              │
// └───────────────────────────────────────────────────────────────┘

console.log('\n── 4. Proved against broken code ─────────────────────');

/// One source-level break: patch the file, reload, run, restore, reload, run.
async function provedSrc(name, brk, testIt) {
	await proved(name,
		async () => { breaking = brk; await reload(); },
		testIt,
		async () => { breaking = ''; await reload(); });
}

await provedSrc('hand.js exports what a terminal needs', 'send-missing', async () => {
	const st = JSON.parse(await page.evaluate(() => DaimondPty.status()));
	return st.carries === true;
});

await provedSrc('the model keeps the screen on a shrink', 'resize-bottom', async () => {
	const m = await modelResize(20, ['one', 'two'], 10);
	return textOf(m.after.screen).join('|') === 'one|two' && m.after.cursorY === 2;
});

await provedSrc('growing takes the lines back out of the history', 'resize-nogrow', async () => {
	const m = await modelResize(20, L15, 10, 20);
	return textOf(m.grown.screen).join('|') === L15.join('|') && m.grown.cursorY === 15;
});

await provedSrc('the parked screen is resized too', 'resize-noalt', async () => {
	const r = await page.evaluate(() => {
		const S = DaimondTerminal.screen(40, 20, { scrollback: 5000 });
		S.write('shell line\r\n');
		S.write('\x1b[?1049h');
		S.resize(30, 10);
		S.write('\x1b[?1049l');
		S.compose(true);
		return { first: S.lineText(S.absOfRow(0)), cols: S.cols, width: S.cells.ch.length, rows: S.rows };
	});
	return r.first === 'shell line' && r.width === r.cols * r.rows;
});

// The three that need a live link are proved together, because each costs an
// approval window and a host process.
await provedSrc('a subscriber hears the wire', 'no-dispatch',
	async () => /opened/.test(await probeOpen()));

await provedSrc('the link dies once, and everybody is told', 'no-gone', async () => {
	const r = await Promise.all([
		page.evaluate(async () => {
			window.__g = 0;
			DaimondHand.subscribe('probe-2', (m) => { if (m.t === '__gone') window.__g++; });
			await DaimondHand.send({ t: 'hello', proto: 1, client: 'probe' }).catch(() => {});
			DaimondHand.close();
			await new Promise((r2) => setTimeout(r2, 400));
			return window.__g;
		}).catch(() => 0),
		allow(),
	]);
	return r[0] === 1;
});

await provedSrc('a send caught by a dying link rejects rather than vanishing', 'swallow-dead',
	async () => {
		const r = await Promise.all([
			page.evaluate(async () => {
				await DaimondHand.send({ t: 'hello', proto: 1, client: 'probe' }).catch(() => {});
				// The port is torn down UNDER a send already on its way, which
				// is the shape of the intermittent failure this handles: the
				// post lands after the port went and before anything said so.
				const p = DaimondHand.send({ t: 'hello', proto: 1, client: 'probe' })
					.then(() => '', (e) => (e && e.message) || 'rejected');
				DaimondHand.close();
				return await p;
			}).catch(() => ''),
			allow(),
		]);
		return typeof r[0] === 'string' && r[0].length > 20;
	});

// ── The wasm ones ───────────────────────────────────────────────

/// One wasm break: load the broken package, run the check, load the whole one,
/// run it again. Both are `--dev` builds, so the only difference is the patch.
async function provedWasm(name, pkg, checkName) {
	await proved(`${name} (wasm)`,
		async () => { usingPkg = pkg; await reload(); },
		() => reqCheck(checkName),
		async () => { usingPkg = 'whole'; await reload(); });
}

await provedWasm('no TERM is sent', 'w-term',
	'sends no TERM, which the hand sets and refuses a caller for naming');
await provedWasm('a hand that cannot fence is refused', 'w-nofence',
	'refuses a hand that cannot fence a program');
await provedWasm('a hand with no granted root is refused', 'w-noroot',
	'refuses a hand that did not say which folder it was granted');
await provedWasm('an unpaired hand is refused in its own words', 'w-nopair',
	'refuses when no hand is paired, in the relay\'s own words');
await provedWasm('a cwd outside the Diamond is refused', 'w-nocwd',
	'refuses a working directory outside what the Diamond may touch');
await provedWasm('a tainted session loses the network', 'w-tainted',
	'a tainted session loses the network');
await provedWasm('a toolkit is never inferred from argv', 'w-argvkit',
	'a toolkit comes from what the user granted, never from argv');

usingPkg = '';
breaking = '';
await reload();

// ── Done ────────────────────────────────────────────────────────

console.log(`\n${ok.length} ok, ${bad.length} failed, `
	+ `${provedNames.length} properties proved against broken code.`);
if (bad.length) console.log(`failed:\n  ${bad.join('\n  ')}`);
await b.close();
server.close();
fs.rmSync(WORK, { recursive: true, force: true });
process.exit(bad.length ? 1 : (process.exitCode || 0));
