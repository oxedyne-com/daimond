// verify_ext.mjs — the Daimond Verify extension, in a real browser.
//
// verify/ext/fingerprint.js is proven identical to verify/lib.mjs by
// verify/verify.test.mjs. This loads the actual unpacked extension and drives
// its service worker: its check.js runs a real fetch of a served manifest and
// its files, and a real fetch of a transparency log, and returns the right verdict.
//
// WHAT THIS FILE ASSERTS ON, AND WHY IT MOVED.
//
// Until 2026-08-13 the extension was pointed at the development origin and the run
// asserted that a sealed build verified green there — every served file matching
// `www/manifest.json`. That is not a fact about the extension. It is a fact about
// whether somebody has run `verify/manifest.mjs` since the last edit, and the answer
// on any ordinary day of development is no: on the gate of that morning, twenty-four
// files differed, and a central rebuild of `www/pkg` in the middle of the same session
// moved the wasm again. A check that is red every day is a check people learn to
// scroll past, and this one had been failing long enough to be listed as known.
//
// Resealing to make it green is worse than leaving it red. `verify/manifest.mjs`
// appends to `verify/transparency.jsonl`, the public record of what has been SHIPPED;
// sealing a working tree publishes a release that was never released. `--no-log`
// avoids that and turns the seal check red instead. And either way the next edit
// undoes it. Sealing a release is `dev/repro-check.sh`'s job, which builds from a
// clean clone — the same division of labour `dev/gate.sh` states for the bundle it
// borrows.
//
// So the assertions moved onto a FIXTURE BUNDLE this file builds, seals and serves
// itself, where every input is controlled and each verdict can be forced:
//
//   green    a sealed fixture, in a chain that carries it     -> ok
//   tampered one file changed AFTER sealing                   -> the file check fails, by name
//   unsealed the same fixture against an empty log            -> the seal check fails
//
// The tampered case is the one the old shape never had: the file check had no red
// case at all, so nothing here proved it could report a mismatch rather than merely
// suffer one.
//
// The DEVELOPMENT origin keeps the two questions that are honestly about it, and they
// are different questions:
//
//   * Are the served bytes the bytes on disk? This is the tamper question at a live
//     origin, and it is independent of the seal — the seal says what was published,
//     this says whether anything sits between the file and the browser rewriting it.
//     It does not go red because somebody edited a file.
//   * Does the served tree still match its manifest? REPORTED, not asserted, and
//     named as what it is: a working tree that has moved on from its seal, with the
//     count and the first few files, and a reminder that a deploy must reseal.
//
// Between them, a served file that differs from a manifest CLAIMING to cover it is
// still caught: by the fixture, where the manifest is current by construction, and at
// the live origin whenever the wire disagrees with the disk.
//
// EACH NEW CHECK IS PROVED AGAINST A BROKEN INSTRUMENT FIRST:
//
//   node dev/verify_ext.mjs --break blind   # the extension stops noticing a changed file
//   node dev/verify_ext.mjs --break wire    # the wire and the disk disagree on one file
//   node dev/verify_ext.mjs                 # and then, clean
//
// The log normally lives on GitHub (an origin the site cannot control). Here it is
// served locally (serve.mjs) and passed in, so the check runs offline against the same
// chain. Needs dev/serve.mjs (DAIMOND_PORT, default 8777). Headed: MV3 service workers
// need a real browser, so run it under xvfb.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');	// this checkout, not one developer's home
import { hashTree, bundleHash, coveredFiles, sha256, parseLog, nextEntry } from '../verify/lib.mjs';
// Chromium's ozone platform is chosen by autodetection and prefers Wayland whenever
// `WAYLAND_DISPLAY` is set -- which it is in every rc session on argonaut -- so a headed
// run under `xvfb-run` still went to the compositor and opened a window on the owner's
// desktop. Importing this strips the two variables from `process.env`, which is all a
// launcher that spreads `process.env` needs. See dev/display.mjs.
import './display.mjs';
const EXT_SRC = `${ROOT}/verify/ext`;
// Not /tmp -- see the SCRATCH note in harness.mjs.  Kept inline rather than
// imported, so this stays standalone and does not load the harness.
const SCRATCH = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const PROFILE = path.join(SCRATCH, 'verify-ext');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const die = (why) => { console.error('ABORT: ' + why); process.exit(2); };
if (BREAK && !['blind', 'wire'].includes(BREAK)) die(`no break called "${BREAK}"`);

/// A copy of the verify extension that may reach the port this run is using.
///
/// THE FAILURE THIS FIXES, which was called something else for two sessions.
/// `verify/ext/manifest.json` grants `localhost:8777` — the default dev port —
/// and nothing else. Whenever the suite runs in a numbered world (`dev/world.sh`,
/// 8781 and up, which is any run with more than one agent about) the extension
/// has no permission for the origin under test, so the checker's `fetch` of
/// `manifest.json` is refused and it reports **"this site served no
/// manifest.json"**. That reads as a broken server, and the server is fine.
///
/// It was recorded as "environmental: needs a headed browser, Missing X server".
/// It does need a display — `xvfb-run` supplies one and the service worker starts
/// — but the display was never the whole story, and the manifest message sent two
/// sessions looking at the seal instead of at the permissions.
///
/// The shipped file is not touched: a released extension holding permissions on a
/// developer's machine is exactly what `dev/extdev.mjs` exists to prevent, and the
/// same rule applies here. The copy is rebuilt every run so it cannot go stale.
///
/// # Arguments
/// * `port` - The port `dev/serve.mjs` is bound to for this run.
async function extForPort(port) {
	const out = path.join(SCRATCH, `verify-ext-build-${port}`);
	fs.rmSync(out, { recursive: true, force: true });
	fs.mkdirSync(out, { recursive: true });
	for (const name of fs.readdirSync(EXT_SRC)) {
		if (name === 'manifest.json') continue;
		fs.cpSync(path.join(EXT_SRC, name), path.join(out, name), { recursive: true });
	}
	// The port is in the SOURCE as well as the manifest: `background.js` decides
	// which navigations to check with its own `MATCH` list, which names 8777. The
	// manifest grants permission to fetch; this decides whether anything is
	// fetched at all, so without it the extension has the run of the origin and
	// simply never looks at it -- and the badge check reads "no verdict recorded".
	//
	// Rewritten here rather than made configurable in the shipped file: which
	// origins an integrity checker will vouch for is precisely the thing that must
	// not be settable from outside it.
	if (port !== 8777) {
		const bg = path.join(out, 'background.js');
		const before = fs.readFileSync(bg, 'utf8');
		const after = before.replace(/:8777/g, ':' + port);
		if (after === before) {
			throw new Error('verify/ext/background.js no longer names :8777, so the dev copy '
				+ 'cannot be pointed at port ' + port + '. Find what replaced MATCH and patch that.');
		}
		fs.writeFileSync(bg, after);
	}
	// A checker that no longer compares the files, so the tampered fixture below
	// comes back green and the check that reads it goes red. The copy is damaged,
	// never `verify/ext/`: an installed checker with its comparison removed is the
	// one thing this whole directory exists to prevent.
	if (BREAK === 'blind') {
		const chk = path.join(out, 'check.js');
		const src = fs.readFileSync(chk, 'utf8');
		const hurt = src.replace("add('every served file matches the manifest', bad.length === 0,",
			"add('every served file matches the manifest', true,");
		if (hurt === src) die('the blind break did not reach the file comparison in check.js');
		fs.writeFileSync(chk, hurt);
	}
	const m = JSON.parse(fs.readFileSync(path.join(EXT_SRC, 'manifest.json'), 'utf8'));
	// Added, not substituted: the shipped origins stay, so the copy is the shipped
	// extension plus this port rather than a different extension that happens to
	// pass. Both spellings of loopback, because Chrome matches the origin string.
	m.host_permissions = (m.host_permissions || [])
		.concat([`http://127.0.0.1:${port}/*`, `http://localhost:${port}/*`]);
	fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m, null, '\t') + '\n');
	return out;
}
const PORT = Number(process.env.DAIMOND_PORT || 8777);
const EXT = await extForPort(PORT);
fs.mkdirSync(PROFILE, { recursive: true });
// The world's dev server -- see dev/world.sh.  Kept inline rather than imported,
// so this stays standalone and does not load the harness.
const APP = process.env.DAIMOND_APP || `http://localhost:${PORT}`;

const ok = [], bad = [];
const check = (name, pass, detail) => { (pass ? ok : bad).push(name); console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : '')); };
const say   = (line) => console.log('  ·    ' + line);

// ── The fixture bundle ───────────────────────────────────────────────────
//
// A bundle small enough to read, sealed by the same `verify/lib.mjs` the real one
// is sealed by, and served out of `www/` so the extension can reach it on the
// origin it is permitted. `_vtest_` because `verify/manifest.mjs` REFUSES to seal
// anything by that name: a run that dies before its cleanup cannot leak a
// synthetic manifest into a release.
const FIX      = `${ROOT}/www/_vtest_fixture`;
const FIX_BAD  = `${ROOT}/www/_vtest_fixture_bad`;
const FIX_FILE = { 'index.html': '<!doctype html><title>fixture</title>\n', 'js/app.js': 'export const n = 1;\n', 'css/app.css': ':root { --n: 1; }\n' };

/// Write the fixture and seal it, returning its bundle hash.
async function sealFixture() {
	fs.rmSync(FIX, { recursive: true, force: true });
	fs.rmSync(FIX_BAD, { recursive: true, force: true });
	for (const [rel, body] of Object.entries(FIX_FILE)) {
		const p = path.join(FIX, rel);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, body);
	}
	const files  = await hashTree(FIX);
	const bundle = bundleHash(files);
	fs.writeFileSync(path.join(FIX, 'manifest.json'),
		JSON.stringify({ algo: 'sha-256', build: 'fixture', bundle, files }, null, 0) + '\n');
	// The tampered copy carries the SAME manifest, so the only thing wrong with it
	// is a file, and the seal check stays green. A fixture that failed both checks
	// would not tell us which one did the noticing.
	fs.cpSync(FIX, FIX_BAD, { recursive: true });
	fs.writeFileSync(path.join(FIX_BAD, 'js', 'app.js'), 'export const n = 2;\n');
	return bundle;
}
const FIX_BUNDLE = await sealFixture();

// Three logs, served from www/ so the extension can fetch them from the app origin:
// a chain that seals the fixture, the app's real chain, and an empty one that seals
// nothing.
const fixLog = JSON.stringify(nextEntry(parseLog(''), {
	ts: '2026-01-01T00:00:00.000Z', build: 'fixture', bundle: FIX_BUNDLE, note: 'verify_ext fixture',
})) + '\n';
fs.writeFileSync(`${ROOT}/www/_vtest_fixlog.jsonl`, fixLog);
fs.writeFileSync(`${ROOT}/www/_vtest_log.jsonl`, fs.readFileSync(`${ROOT}/verify/transparency.jsonl`, 'utf8'));
fs.writeFileSync(`${ROOT}/www/_vtest_empty.jsonl`, '');
const cleanup = () => {
	for (const f of ['_vtest_fixlog.jsonl', '_vtest_log.jsonl', '_vtest_empty.jsonl']) {
		try { fs.rmSync(`${ROOT}/www/${f}`); } catch (e) {}
	}
	for (const d of [FIX, FIX_BAD]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
};

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const b = await chromium.launchPersistentContext(PROFILE, {
	executablePath: CHROME, headless: false,
	args: ['--no-sandbox', '--disable-dev-shm-usage', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
async function waitSW() { for (let i = 0; i < 80 && !b.serviceWorkers().length; i++) await new Promise(r => setTimeout(r, 100)); return b.serviceWorkers()[0]; }

/// One named check out of a verdict, or `undefined` if the checker never ran it.
const named = (v, re) => v && v.checks.find(c => re.test(c.name));

try {
	const sw = await waitSW();
	check('the extension service worker started', !!sw);
	check('it exposes its checker to the worker scope', await sw.evaluate(() => typeof self.verifyOrigin === 'function'));

	const run = (origin, log) => sw.evaluate(
		async (a) => await self.verifyOrigin(a.origin, a.log), { origin, log });

	// 1. A sealed fixture, checked against a chain that carries it → green.
	const v1 = await run(`${APP}/_vtest_fixture`, `${APP}/_vtest_fixlog.jsonl`);
	check('a sealed bundle verifies green', v1 && v1.ok === true,
		v1 && v1.checks.map(c => c.name + '=' + c.ok).join(', '));
	check('the "sealed in the public log" check passed',
		!!(named(v1, /sealed in the public log/) || {}).ok);
	check('every served file matched the manifest',
		!!(named(v1, /every served file/) || {}).ok);

	// 2. The SAME manifest, one file changed after it was sealed → the file check
	//    fails and says which. This is the case the old shape of this file never
	//    ran: nothing proved the comparison could report a mismatch.
	const v2 = await run(`${APP}/_vtest_fixture_bad`, `${APP}/_vtest_fixlog.jsonl`);
	const fileChk = named(v2, /every served file/);
	check('a file changed after sealing is caught', v2 && v2.failed === true && fileChk && fileChk.ok === false,
		fileChk ? fileChk.detail : 'the checker ran no file comparison at all');
	check('and it names the file that differs', !!fileChk && /js\/app\.js/.test(fileChk.detail || ''),
		fileChk ? fileChk.detail : '');
	check('the seal is untouched by it — the failure is not blamed on the log',
		!!(named(v2, /sealed in the public log/) || {}).ok);

	// 3. The same fixture against an EMPTY log → red, and for the seal.
	const v3 = await run(`${APP}/_vtest_fixture`, `${APP}/_vtest_empty.jsonl`);
	check('a build absent from the log fails', v3 && v3.failed === true);
	check('the failure is the seal check', !!(named(v3, /sealed in the public log/) && named(v3, /sealed in the public log/).ok === false));

	// ── The development origin ───────────────────────────────────────
	//
	// 4. THE TAMPER QUESTION, asked of the live origin: are the bytes the browser
	//    is given the bytes on disk? Nothing between `www/` and the socket may
	//    rewrite a file. This is true of a working tree mid-edit, so it does not
	//    go red because somebody saved a file — and it is the one thing at this
	//    origin that a tampered delivery would break.
	const rels = (await coveredFiles(`${ROOT}/www`)).filter(r => !r.startsWith('_vtest_'));
	const wrong = [];
	for (const rel of rels) {
		let served;
		try {
			const res = await fetch(`${APP}/${rel}`, { cache: 'no-store' });
			served = sha256(Buffer.from(await res.arrayBuffer()));
		} catch (e) { wrong.push(`${rel} (not served)`); continue; }
		// `--break wire` reads a DIFFERENT file off the disk for one path, so the
		// two sides of the comparison genuinely disagree — which is what a rewrite
		// on the way out looks like from here, and proves the naming as well as
		// the comparison.
		const from = (BREAK === 'wire' && rel === 'index.html') ? 'manifest.json' : rel;
		const disk = sha256(fs.readFileSync(path.join(ROOT, 'www', from)));
		if (served !== disk) wrong.push(rel);
	}
	check('every served file is the file on disk', wrong.length === 0,
		wrong.length ? `${wrong.length} rewritten on the way out: ${wrong.slice(0, 4).join(', ')}`
			: `${rels.length} files`);

	// 5. And the seal, REPORTED. A working tree that has moved on from its manifest
	//    is the expected state between deploys; a tree that matches it is worth
	//    saying out loud too, because it means this checkout is the sealed one.
	const vApp = await run(APP, `${APP}/_vtest_log.jsonl`);
	const appFiles = named(vApp, /every served file/);
	if (appFiles && appFiles.ok) {
		say('the served tree still matches www/manifest.json: this checkout is the sealed build');
	} else {
		say(`the served tree has moved on from www/manifest.json (${(appFiles || {}).detail || 'no comparison ran'}).`);
		say('That is the expected state of a working tree. `node verify/manifest.mjs` seals a');
		say('deploy; it is NOT run to make this line go away.');
	}

	// 6. The badge path: a navigation records a verdict for the tab, and it is the
	//    verdict the checker gives for that origin. Asserted as AGREEMENT rather
	//    than as green: on an unsealed working tree the honest verdict is red, and
	//    a check demanding green here would be demanding a reseal again.
	await sw.evaluate((url) => chrome.storage.local.set({ logUrl: url }), `${APP}/_vtest_log.jsonl`);
	const page = await b.newPage();
	await page.goto(APP + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});
	let recorded = null;
	for (let i = 0; i < 60; i++) {
		const vs = await sw.evaluate(() => self.__verdicts);
		const vals = Object.values(vs || {});
		if (vals.length) { recorded = vals[0]; break; }
		await new Promise(r => setTimeout(r, 200));
	}
	check('a real navigation records a verdict for the tab', !!recorded,
		recorded ? 'ok=' + recorded.ok : 'no verdict recorded');
	check('and the recorded verdict is the one the checker gives for that origin',
		!!recorded && !!vApp && recorded.ok === vApp.ok && recorded.bundle === vApp.bundle,
		recorded && vApp ? `tab ok=${recorded.ok}, checker ok=${vApp.ok}` : '');
} finally {
	await b.close();
	cleanup();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (BREAK) {
	if (bad.length) { console.log('the break was caught, as it should be'); process.exit(0); }
	console.log('THE BREAK WAS NOT CAUGHT: this check proves nothing');
	process.exit(1);
}
process.exit(bad.length ? 1 : 0);
