// The one door to Playwright in this tree.  Every browser in dev/ is launched
// through what this file exports, never through a playwright-core imported by
// path elsewhere; dev/breakproof_devshm.sh refuses any file that imports it
// itself.
//
// WHY.  Playwright adds `--disable-dev-shm-usage` to EVERY Chromium launch on
// its own (playwright-core's `chromiumSwitches`), so leaving the flag out of our
// `args` changes nothing (fa0dd6b1).  With it, Chromium makes its renderers'
// shared memory as `$TMPDIR/.org.chromium.Chromium.*`, and the fleet's TMPDIR is
// on the NVMe: measured 2026-10-09, one browser repainting a 1400x900 canvas
// wrote 16-110 GB/h.  Only `ignoreDefaultArgs` takes the flag off the command
// line; then the shared memory lives in /dev/shm (a 14 GB tmpfs, charged to the
// run's own cgroup and freed at exit) and the writes fall to ~0.01 GB/h, memory
// within noise.  The flag exists for Docker's 64 MB /dev/shm; nothing here needs it.
//
//   import { chromium, webkit } from './pw.mjs';          // or, lazily:
//   const { chromium } = await import('./pw.mjs');
//   const b = await chromium.launch({ executablePath: CHROME });   // flag already dropped
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/// The first of these that can be OPENED wins, because `existsSync` cannot tell
/// a file from a fence: inside Daimond's run fence `~/.red-pw` stats `true` (the
/// directory list is permitted) while opening the file is EACCES, so a
/// stat-based choice picks a path the import can never read.
export function firstThatOpens(candidates) {
	for (const p of candidates) {
		try { fs.closeSync(fs.openSync(p, 'r')); return p; } catch (e) { /* next */ }
	}
	return candidates[0];			// nothing opens: return the first, so the
						// import fails naming IT rather than `undefined`
}

/// Where playwright-core is.  It lives outside the repo, so it is resolved by
/// path, not by package name.  The second candidate lives INSIDE the granted
/// tree (the oxegen checkout beside this one: three levels up from dev/ reaches
/// apps), so a daimon's fenced `run` and the hand's unfenced `verify` both reach
/// it without an environment variable either of them may not have.
export const PW = process.env.DAIMOND_PW
	|| firstThatOpens([
		path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs'),
		path.resolve(HERE, '../../../oxegen/node_modules/playwright-core/index.mjs'),
	]);

const core = await import(pathToFileURL(PW).href);

const SHM_FLAG = '--disable-dev-shm-usage';

/// Is this run the hand's (`verify`), behind its fence?  The hand marks every run it
/// makes unattended, the same variable dev/display.mjs reads.
const UNDER_HAND = !!(process.env.DAIMOND_UNATTENDED || '').trim();

// A site's own `ignoreDefaultArgs` is kept: `true` already drops every default.
//
// UNDER THE HAND THE FLAG STAYS (11 Oct 2026).  The verifier fence never lends /dev/shm:
// writable, it is every other process's shared memory too.  With the flag, Chromium keeps
// its shared memory in $TMPDIR, which the hand points at the run's own scratch and removes
// afterwards, so the NVMe writes measured above are bounded by one run.
function shmInMemory(opts = {}) {
	if (UNDER_HAND) return opts;
	const own = opts.ignoreDefaultArgs;
	if (own === true) return opts;
	const list = Array.isArray(own) ? own : [];
	return { ...opts, ignoreDefaultArgs: list.includes(SHM_FLAG) ? list : [ ...list, SHM_FLAG ] };
}

/// Playwright's headless shell: the browser a verifier gets under the hand.
export const HEADLESS_SHELL = process.env.DAIMOND_HEADLESS_SHELL
	|| firstThatOpens([
		path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1229/chrome-headless-shell-linux64/chrome-headless-shell'),
	]);

// UNDER THE HAND THE BROWSER IS THE HEADLESS SHELL (rc-b ruling, 11 Oct 2026).  The full
// Chrome takes a ProcessSingleton, a bound AF_UNIX socket, which the verifier fence's seccomp
// refuses -- and must keep refusing, because a socket grant cannot exclude the session bus.
// The shell takes no singleton.  /proc is not lent either: other processes' command lines
// carry secrets.
//
// --no-sandbox (Playwright's default, `chromiumSandbox: false`, stated here so it is a choice
// and not an accident) is acceptable ONLY because the hand's Landlock + seccomp fence is the
// real boundary around the whole browser: renderer and browser process alike can reach the
// mark, the run's scratch and the named read-only needs, and nothing else.  Outside the hand
// this branch is never taken.
//
// An extension flow needs the full browser, so it is refused here by name rather than run
// as if the extension were loaded.
function handBrowser(opts = {}) {
	if (!UNDER_HAND) return opts;
	const args = (opts.args || []).filter((a) => !a.startsWith('--headless'));
	if (args.some((a) => a.startsWith('--load-extension'))) {
		throw new Error('a verifier under the hand cannot load the MV3 extension: that needs the '
			+ 'full Chrome, whose ProcessSingleton socket the verifier fence refuses.');
	}
	// What the fence costs a browser, each measured on 11 Oct and answered without lending:
	// * Every child (zygote, renderer, GPU) is started by exec'ing /proc/self/exe unless named
	//   ("GPU process launch failed: error_code=1002"), so it is named by path, with no zygote.
	// * GPU information is gathered through libpci, which calls exit(1) when /sys/bus/pci is
	//   unreadable ("pcilib: Cannot open /sys/bus/pci/devices", the GPU process dies six times
	//   and the browser with it).  Playwright's `--enable-unsafe-swiftshader` asks for that
	//   probe; with GL disabled there is no probe and Chromium composites in software, which
	//   is all a headless verifier draws with.
	// * A GPU process, even unsandboxed, opens /proc before anything else and dies when it
	//   cannot ("FATAL:sandbox_linux.cc:616 ... Permission denied"), so with GL disabled the
	//   compositor runs inside the browser process and there is no GPU process at all.
	args.push(`--browser-subprocess-path=${HEADLESS_SHELL}`, '--no-zygote', '--disable-gpu', '--use-gl=disabled', '--in-process-gpu');
	const own = opts.ignoreDefaultArgs;
	const skip = own === true ? true
		: [ ...(Array.isArray(own) ? own : []), '--enable-unsafe-swiftshader' ];
	return { ...opts, args, ignoreDefaultArgs: skip, headless: true, chromiumSandbox: false,
		executablePath: HEADLESS_SHELL };
}

const LAUNCH = {
	launch:			(opts) => core.chromium.launch(handBrowser(shmInMemory(opts))),
	launchPersistentContext:	(dir, opts) => core.chromium.launchPersistentContext(dir, handBrowser(shmInMemory(opts))),
	launchServer:		(opts) => core.chromium.launchServer(handBrowser(shmInMemory(opts))),
};

/// Playwright's Chromium, whose every launch keeps shared memory in /dev/shm (in
/// $TMPDIR, and the headless shell, under the hand).
/// Everything else (`connectOverCDP`, `executablePath()`, `name()`) is the
/// real BrowserType's, bound to it.
export const chromium = new Proxy(core.chromium, {
	get(t, k) {
		if (Object.hasOwn(LAUNCH, k)) return LAUNCH[k];
		const v = Reflect.get(t, k, t);
		return typeof v === 'function' ? v.bind(t) : v;
	},
});

// WEBKIT GETS SAFARI'S STORAGE (16 Oct 2026).  The Linux WebKit Playwright bundles (WPE,
// r2311, and r2336 alike) ships the Storage API and the File System API compiled in but
// switched OFF, so `navigator.storage` is undefined, the app's OPFS root cannot open and no
// Diamond can be written.  Safari ships them on, so a WebKit run without them is testing a
// browser nobody has.  `--features` takes effect for persistent contexts only (an ephemeral
// `newContext()` still has no OPFS); dev/rig/capped.sh execs the real browser with "$@", so
// the flag passes through the device cap unchanged.  Diagnosis:
// ~/usr/code/ai/claude/notes/daimond_rig_20261016/diag_webkit_diamond.md.
export const WEBKIT_SAFARI_FEATURES = '--features=+StorageAPI,+StorageAPIEstimate,+FileSystem,'
	+ '+FileSystemWritableStream,+AccessHandle';

function safariFeatures(opts = {}) {
	const args = opts.args || [];
	if (args.some((a) => a.startsWith('--features='))) {
		throw new Error(`a WebKit launch passed its own --features; merge it with ${WEBKIT_SAFARI_FEATURES} `
			+ 'in dev/pw.mjs rather than replacing the storage features Safari ships.');
	}
	return { ...opts, args: [ ...args, WEBKIT_SAFARI_FEATURES ] };
}

const WK_LAUNCH = {
	launch:			(opts) => core.webkit.launch(safariFeatures(opts)),
	launchPersistentContext:	(dir, opts) => core.webkit.launchPersistentContext(dir, safariFeatures(opts)),
	launchServer:		(opts) => core.webkit.launchServer(safariFeatures(opts)),
};

/// Playwright's WebKit, whose every launch carries `WEBKIT_SAFARI_FEATURES`.
export const webkit = new Proxy(core.webkit, {
	get(t, k) {
		if (Object.hasOwn(WK_LAUNCH, k)) return WK_LAUNCH[k];
		const v = Reflect.get(t, k, t);
		return typeof v === 'function' ? v.bind(t) : v;
	},
});

export const firefox	= core.firefox;
export const devices	= core.devices;

/// This module's own path, for a library that loads Playwright from a path it
/// is given (crawlgate's `adapter.playwright`): handing it playwright-core would
/// hand it the raw Chromium.
export const PW_MODULE = fileURLToPath(import.meta.url);
