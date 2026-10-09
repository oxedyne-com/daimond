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

// A site's own `ignoreDefaultArgs` is kept: `true` already drops every default.
function shmInMemory(opts = {}) {
	const own = opts.ignoreDefaultArgs;
	if (own === true) return opts;
	const list = Array.isArray(own) ? own : [];
	return { ...opts, ignoreDefaultArgs: list.includes(SHM_FLAG) ? list : [ ...list, SHM_FLAG ] };
}

const LAUNCH = {
	launch:			(opts) => core.chromium.launch(shmInMemory(opts)),
	launchPersistentContext:	(dir, opts) => core.chromium.launchPersistentContext(dir, shmInMemory(opts)),
	launchServer:		(opts) => core.chromium.launchServer(shmInMemory(opts)),
};

/// Playwright's Chromium, whose every launch keeps shared memory in /dev/shm.
/// Everything else (`connectOverCDP`, `executablePath()`, `name()`) is the
/// real BrowserType's, bound to it.
export const chromium = new Proxy(core.chromium, {
	get(t, k) {
		if (Object.hasOwn(LAUNCH, k)) return LAUNCH[k];
		const v = Reflect.get(t, k, t);
		return typeof v === 'function' ? v.bind(t) : v;
	},
});

export const webkit	= core.webkit;
export const firefox	= core.firefox;
export const devices	= core.devices;

/// This module's own path, for a library that loads Playwright from a path it
/// is given (crawlgate's `adapter.playwright`): handing it playwright-core would
/// hand it the raw Chromium.
export const PW_MODULE = fileURLToPath(import.meta.url);
