// A browser harness for driving Daimond the way a user does.
//
// Every flow worth testing runs through the real page: the wasm, the panels,
// the agent loop, the tools.  This opens a browser on the dev server, gets
// past the passphrase gate, points the app at the mock provider, and hands
// back a page you can drive.  Console errors and page crashes are collected
// throughout, because a flow that "works" while throwing is not working.
//
//   import { open, chat, newChat, shot, errors } from './harness.mjs';
//   const s = await open();                       // signed in, model connected
//   await newChat(s);                             // …and now in a chat of its own
//   const dir = await s.page.evaluate(() => {
//       const f = window.DaimondAttach.focus();
//       return window.DaimondAttach.chatScratch(f.id);   // chats/<id>/work
//   });
//   await chat(s, `@tool file_write {"path":"${dir}/a.txt","content":"hi"}`);
//   await shot(s, 'after-write');
//   await s.close();
//
// A WORKSPACE-ROOT PATH DOES NOT WORK, and it fails silently, which is why the
// example above is longer than it used to be.  This said `{"path":"a.txt"}` until
// 2026-08-14.  Since the chat fence landed on 2026-08-12 every chat is confined to
// `chats/<id>/work` (`scopeChatTo`, www/js/daimond.js), and `Tool::guard`
// (src/tools.rs) refuses anything outside it BEFORE the tool runs.  The refusal comes
// back as an ordinary tool result: nothing is written, nothing throws, and the turn
// finishes normally — so a fixture built on a root path leaves the test measuring an
// apology.  Six verifiers were seeding that way, and two of them were reporting a
// user's data safe without ever touching a file.
//
// `chatScratch` is where the chat may ALWAYS write.  For a path elsewhere in the
// workspace, mark a folder in the way a user does — `DaimondAttach.chatToggle` then
// `DaimondAttach.chatWs`, the mark being the permission (see dev/verify_viewer.mjs).
// For a fixture that is not ABOUT a turn, write it through the engine's own door
// instead: `(await import('/pkg/oxedyne_daimond.js')).write_file(path, body)`, which
// is not fenced because it is not a chat (see dev/verify_backup.mjs).
//
// A FAILED REQUEST NAMES ITS SERVER. `errors(s)` pairs every "Failed to load
// resource" with the URL behind it, and drops the ones from hosts outside this
// world after printing them.  See `open()`'s response hook and `errors()` below
// for the gate that made this necessary.
//
// Headless by default.  Pass { headed: true } for the extension flows, which
// need real rendering — and run those under xvfb, never on the user's display.

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extDev, isExtSource } from './extdev.mjs';

// playwright-core lives outside the repo, so it is resolved by path, not by
// package name — nothing here is installed into the app.
/// Where playwright-core is, since it lives outside the repo and is resolved by
/// path rather than by package name.
///
/// Exported because a file that launches a browser of its own -- rather than
/// through `open()` -- would otherwise write this path down a second time, and a
/// second copy of a path is a second thing to move.
export const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');

/// The dev server, the mock provider and the mock's log together make one
/// "world".  They are all settable so several agents can each hold one and drive
/// their own browser; `dev/world.sh N` prints a consistent set.  A shared mock log
/// is the trap the ports alone do not close -- two suites appending to one file
/// make every `mockLog` assertion read another agent's traffic.
export const APP   = process.env.DAIMOND_APP
	|| `http://localhost:${process.env.DAIMOND_PORT || 8777}`;
export const MOCK  = process.env.DAIMOND_MOCK
	|| `http://127.0.0.1:${process.env.DAIMOND_MOCK_PORT || 9099}/v1/chat/completions`;
export const MODEL = 'mock/fast';
export const PASS  = 'testpass1234';
export const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const MOCK_LOG = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');

/// Scratch root for browser profiles and test artefacts.
///
/// NOT `/tmp`: that is a tmpfs, so anything left there is RAM, charged to the
/// cgroup of whichever agent ran the suite.  tmpfs pages are shmem and cannot be
/// dropped under pressure -- only swapped -- so stale profiles silently consume
/// the agent fleet's whole swap budget and unrelated sessions are OOM-killed for
/// it.  That has now happened three times (2026-07-24, 2026-07-27, 2026-07-28:
/// 803 profile dirs, 5.1 GB, five of six gigabytes of fleet swap).  Disk is
/// where this belongs.  Override with DAIMOND_SCRATCH.
export const SCRATCH = process.env.DAIMOND_SCRATCH
	|| path.join(os.homedir(), '.cache/daimond');

/// A path under the scratch root, with its parent created.
export function scratch(...parts) {
	const p = path.join(SCRATCH, ...parts);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	return p;
}

/// The mock answering this world's port must be THIS world's mock.
///
/// `mockLog()` below is how eighteen or more verifiers ask what the model was
/// shown, and every one of them asks it by READING A FILE. So a mock that answers
/// the port while appending somewhere else does not break anything visibly: the
/// turns happen, the page behaves, and the assertions read an empty file and
/// report that the provider was never reached.
///
/// That is not a hypothetical. The gate of 2026-08-17 found world 9's ports
/// already held by a gate started three hours earlier, left them alone -- which is
/// `world.sh --up`'s deliberate and correct behaviour when a person is sharing a
/// world -- and ran for two hours against that mock, which was appending 2.6 MB
/// into a worktree of commit b536d60 while the log this run read stayed at zero
/// bytes. `verify_concise` reported "the mock provider was reached: no";
/// `verify_toolmemory` reported "two turns really reached the model — 0
/// request(s)"; `verify_triggers` reported that the daimon was never sent the
/// user's message. All three were false, and each was a claim about a feature made
/// by a check that had not been able to look.
///
/// So it is asked ONCE per process, here, rather than in eighteen copies: the mock
/// is made to name the file it writes, and a mock that names another one -- or
/// that cannot answer the question, which is what an older mockllm from another
/// tree does -- stops the run before a single check has been made.
///
/// AND IT IS ASKED WHICH REVISION IT IS, which is a different question from which
/// world it belongs to, and the two came apart on 2026-08-28. `world.sh --up`
/// adopts a mock already listening -- correctly, so a person can share a world --
/// and a world brought up BEFORE a merge keeps answering after it. Same port, same
/// log path, so every guard above passed; a directive the merge had added meant
/// nothing to it, so it fell through to `Mock reply to: <the directive line>`.
///
/// That is worse than a mock that is not there. `dev/verify_thinking.mjs` went red
/// on twelve checks, and one of them said the model's reasoning had been stored as
/// its answer -- the most serious thing this suite can report. It had not been. The
/// echo put the check's own markers into the assistant message, so a fixture
/// produced a data-defect report about a product that was working.
///
/// This is the workflow that manufactures it: bring a world up, run the gate, merge,
/// run the gate again. A release lane does exactly that, all day.

/// The SHA-256 of THIS tree's mock, or '' when it cannot be read.
///
/// Empty rather than fatal: running the harness from somewhere its mock's source is
/// not is a thing that works today, and this check must not be why it stops.
let _mockSha = null;
function mockSha() {
	if (_mockSha === null) {
		try {
			_mockSha = crypto.createHash('sha256')
				.update(fs.readFileSync(path.join(HERE, 'mockllm.mjs'))).digest('hex');
		} catch (e) { _mockSha = ''; }
	}
	return _mockSha;
}

/// The directive names this tree's mock switches on, read the way the mock reads them
/// of itself, so the two lists cannot drift apart.
function ourDirectives() {
	try {
		const src = fs.readFileSync(path.join(HERE, 'mockllm.mjs'), 'utf8');
		return [...new Set([...src.matchAll(/^\t\tcase '([a-z0-9]+)':/gm)].map(m => m[1]))].sort();
	} catch (e) { return []; }
}

let mockIdentity = null;
async function requireOwnMock() {
	if (mockIdentity) return mockIdentity;
	const url = new URL('/__world', MOCK).href;
	let said;
	try {
		const r = await fetch(url, { cache: 'no-store' });
		said = r.ok ? await r.json() : { log: null, status: r.status };
	} catch (e) {
		// Nothing is listening. The verifier's own checks will say what it could
		// not do, and this says why -- but it is not made fatal here, because a
		// session opened with `connect: true` that never speaks to a model is a
		// legitimate thing and was working before this check existed.
		console.log(`  note  no mock provider answering ${MOCK} — anything below that reads`
			+ ' mockLog() is reading a file nothing is writing');
		mockIdentity = { log: null };
		return mockIdentity;
	}
	// WHICH REVISION, asked before which world: a mock from another tree can name the
	// right log by nothing but a shared directory layout, and then every answer it
	// gives is a revision behind and nothing says so.
	const ours = mockSha();
	if (ours && said.sha !== ours) {
		const knows   = Array.isArray(said.directives);
		const missing = knows ? ourDirectives().filter(d => !said.directives.includes(d)) : [];
		// Three cases, and they are not the same diagnosis. It listed its directives and
		// some are absent; it listed them and none are, so a directive's MEANING moved;
		// or it is old enough not to list them at all, in which case nothing is known
		// about what it understands and the sha is the whole of the evidence.
		const what = !knows
			? '  it does not say which directives it knows, so nothing can be said about\n'
				+ '  what it understands -- only that it is not this file.\n'
			: missing.length
				? `  it does not answer to: ${missing.map(d => '@' + d).join(', ')}\n`
				: '  it answers to the same directive names, so what differs is what they MEAN.\n';
		throw new Error(
			`the provider on ${MOCK} is not built from this tree's dev/mockllm.mjs.\n`
			+ `  it is:   ${said.sha || '(no sha in its /__world — a mockllm from before this '
				+ 'check existed)'}\n`
			+ `  we want: ${ours}\n`
			+ what
			+ '  A world adopts a mock already listening, so one started before a merge keeps\n'
			+ '  answering after it -- same port, same log, silently a revision behind. Each\n'
			+ '  directive it does not know becomes `Mock reply to: <the line>`, which is the\n'
			+ '  fixture echoing the prompt and reads exactly like the product being broken.\n'
			+ '  Restart it: dev/world.sh N --down && dev/world.sh N --up');
	}
	if (said.log !== MOCK_LOG) {
		throw new Error(
			`the provider on ${MOCK} is not this world's.\n`
			+ `  it logs to: ${said.log || `(no /__world answer — status ${said.status}; an older `
				+ 'mockllm.mjs from another tree, or not mockllm.mjs at all)'}\n`
			+ `  this run reads: ${MOCK_LOG}\n`
			+ '  Every check that asks what the model was sent reads THAT file, so this run\n'
			+ '  would report turns as never having happened. Free the port, or pick another\n'
			+ '  world (dev/world.sh N --status now says who holds one).');
	}
	mockIdentity = said;
	return mockIdentity;
}

/// Everything the model was sent, since `clearMockLog()` was last called.
export const mockLog = () => {
	if (!fs.existsSync(MOCK_LOG)) return [];
	return fs.readFileSync(MOCK_LOG, 'utf8').split('\n')
		.filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
		.filter(Boolean);
};
export const clearMockLog = () => { try { fs.writeFileSync(MOCK_LOG, ''); } catch {} };

/// The text of a message's `content`, whichever shape it arrived in.
///
/// A message's content is a plain string in the simple case and an ARRAY OF
/// PARTS whenever the request carries anything else -- a cache marker, an image.
/// A check written as `/x/.test(m.content || '')` sees `[object Object]` for the
/// second kind and quietly matches nothing.
///
/// That is not hypothetical: it is why `verify_credits` reported "0 copies of
/// the user message on the wire" and "0 worker request(s) landed" for weeks. The
/// wire was fine and the app was fine; the assertion was reading the message in
/// one shape and the app was sending it in the other. Use this rather than
/// touching `content` directly.
export const contentText = (content) => {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map((p) => (p && typeof p.text === 'string') ? p.text : '').join('');
	}
	return '';
};

/// Launch a browser, sign in, and connect the mock model.
///
/// `name` seeds a distinct identity so parallel sessions never share state;
/// each gets its own browser profile, so OPFS and localStorage are its own.
// Where a headed browser is allowed to paint lives in `dev/display.mjs`, which
// has no imports so that the twelve headed launchers in this directory which do
// NOT import this file can have it for nothing. Re-exported here because this is
// where it was, and `dev/verify_harness.mjs` puts the cases to it through this
// door.
//
// The import is what strips `WAYLAND_DISPLAY` and `XDG_SESSION_TYPE` from this
// process, so it is load-bearing even where nothing below names it.
export { displayFault, cleanDisplayEnv, WAYLAND_VARS, INHERITED_ENV,
	UNATTENDED_VAR, OWNED_VAR, SEAT_DISPLAY } from './display.mjs';
import { displayFault, cleanDisplayEnv, INHERITED_ENV } from './display.mjs';

export async function open(opts = {}) {
	const {
		headed    = false,
		name      = 'tester',
		extension = null,		// path to an unpacked extension, headed only
		connect   = true,		// skip to test the disconnected state
		signIn    = true,		// skip to test the gate itself
		// The two default Diamonds the app seeds on a first boot. Pass false when
		// the test COUNTS Diamonds, or pause leaves, and needs to own the set --
		// see `clearDiamonds` below for why they are removed rather than skipped.
		defaults  = true,
		// A fixed profile directory, so a run keeps the identity — and therefore the
		// GATEWAY ACCOUNT — of the run before it. Without one, every run mints a new
		// account, and nothing that needs an entitlement (mail, a pack) can be tested
		// twice: the grant would land on an account the next run does not have.
		profile   = null,
		// A TOUCH context: `pointer: coarse` and `any-pointer: coarse` in the media
		// queries, which is what a tablet reports and what several of the app's
		// touch-target rules are written against. Without it a 900px window is a
		// mouse, and a rule that only lifts a control for a finger looks absent.
		touch     = false,
		// Called with the page before it is navigated, for a verifier that serves
		// a damaged file through `page.route`. It has to run BEFORE `goto`, which
		// is the whole reason it cannot be done by the caller afterwards.
		route     = null,
		// Let the transparency log be fetched from its real, foreign origin. See
		// the route below for why the default is not to. Almost nothing wants this:
		// what it buys is a dependency on GitHub's rate limiter.
		publicLog = false,
	} = opts;

	// Before a browser is even launched: is the mock this run will read the mock
	// this run will talk to? See `requireOwnMock` for the gate that made this
	// necessary. Only when the session is going to be pointed at one.
	if (connect) await requireOwnMock();

	const args = ['--no-sandbox', '--disable-dev-shm-usage'];
	if (extension) {
		// `ext/` is the SHIPPED extension and names one origin, which is not this
		// dev server. A test that asked for it wants the build that will talk to
		// localhost, so it is handed the generated one -- see dev/extdev.mjs for
		// why the dev origins are not in the file that ships.
		const dir = isExtSource(extension) ? await extDev() : extension;
		args.push(`--disable-extensions-except=${dir}`, `--load-extension=${dir}`);
	}
	if (!headed) args.push('--headless=new');

	// A persistent context per session, on its own profile: OPFS, localStorage
	// and identity are that session's alone, so sessions may run in parallel.
	const profileDir = profile || scratch('pw', `${name}-${process.pid}`);
	fs.mkdirSync(profileDir, { recursive: true });
	// DISPLAY is dropped for a headless run, and it is the reason half the
	// clicks in this tree are forced.
	//
	// This session's DISPLAY is an X display forwarded over SSH to a laptop that
	// is usually asleep. A headless Chrome still consults it, and when nothing
	// answers the compositor never produces a frame -- so requestAnimationFrame
	// never fires, Playwright's "stable" actionability check waits forever for a
	// second frame, and every ordinary click times out on a button that is
	// perfectly fine. Measured on a blank page: with DISPLAY set, no frames in
	// either headless mode; with it unset, frames, clicks and screenshots all
	// work.
	//
	// A HEADED RUN NEEDS A DISPLAY AND MUST NOT BE GIVEN THAT ONE. The sentence
	// here used to read "a headed run genuinely needs the display, so it keeps
	// it", and the display it kept was the forwarded one -- so a headed verifier
	// started from an rc session PAINTED ITSELF ON THE OWNER'S LAPTOP, across the
	// network, in front of whatever he was doing. He reported it happening more
	// than once before anybody looked at this line.
	//
	// A forwarded display is decidable and is not guessed at: X names a remote
	// display with a HOST PART before the colon (`localhost:10.0`, `gilgamesh:0`),
	// and a local one has none (`:0`, and `:99` from `xvfb-run`). So a headed
	// launch refuses a display carrying a host part rather than quietly using it.
	// Watching a headed run on argonaut's own seat still works -- that is `:0`,
	// which has no host part and is allowed.
	// The Wayland variables go for a headless run as well as a headed one. A
	// headless Chromium that finds a compositor still talks to it, and the frame
	// stalls this comment is about are the same stalls in a different costume.
	const env = cleanDisplayEnv(process.env);
	if (!headed) {
		delete env.DISPLAY;
	} else {
		// `INHERITED_ENV` and not `env`: the question is what this run was
		// STARTED with, and both the strip above and the one at import time have
		// taken the answer out of everything else.
		const shown = displayFault(INHERITED_ENV);
		if (shown) {
			throw new Error(shown);
		}
	}

	const browser = await chromium.launchPersistentContext(profileDir, {
		executablePath: CHROME,
		headless:       false,		// the flag above decides; MV3 needs a real browser
		args,
		env,
		viewport:       { width: 1500, height: 950 },
		hasTouch:       touch,
	});

	const page = browser.pages()[0] || await browser.newPage();
	const errs   = [];
	const logs   = [];
	// Every answer of 400 or worse, and every request that got no answer at all,
	// WITH ITS URL.
	//
	// Chrome's console line for a failed subresource is `Failed to load resource:
	// the server responded with a status of 429 ()` -- a status, no URL, no host.
	// Twenty-three verifiers failed the 2026-08-17 gate on exactly that line and
	// not one of them could say which server had answered it. A day went into
	// attributing it to the gateway rate-limiting its own test suite; it was
	// raw.githubusercontent.com refusing an unauthenticated scrape, which
	// `verify_releases` -- the one file in the tree that happened to record URLs
	// beside statuses -- had been printing in full the whole time. So the URL is
	// kept here, once, for everybody, and `errors()` below puts the two back
	// together.
	const net = [];
	page.on('response', (r) => {
		if (r.status() >= 400) net.push({ status: r.status(), url: r.url() });
	});
	page.on('requestfailed', (r) => {
		const f = r.failure();
		net.push({ status: 0, url: r.url(), why: (f && f.errorText) || 'no answer' });
	});
	page.on('console', m => {
		logs.push(`${m.type()}: ${m.text()}`);
		if (m.type() === 'error') errs.push(m.text());
	});
	page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
	page.on('crash', () => errs.push('PAGE CRASHED'));

	// CHATS EXPIRE ON THEIR OWN NOW, and almost every fixture in this suite
	// seeds `updatedAt` at a date in the past — because it is testing an
	// ordering, or a transcript, or a merge, and the stamp was only ever there
	// to make the ordering deterministic. With the shipped three-day window
	// those chats are all overdue, so twenty seconds into any run the app would
	// correctly move the entire fixture to the trash and the verifier would fail
	// on something it is not about.
	//
	// So the harness pins a long window for every run, into the same cached key
	// the app reads (`daimond-policy`), before any script on the page has run. A
	// verifier that IS about expiry sets its own figures at the moment it needs
	// them — `DaimondPolicy.set` writes this key — so this is a default and not
	// a gag.
	//
	// The retention is left at thirty days: nothing here depends on it, and a
	// figure invented for the tests is a figure the tests would then be proving
	// things about.
	await page.addInitScript(() => {
		try { localStorage.setItem('daimond-policy',
			JSON.stringify({ v: 1, expire: 3650, retain: 30, high: 30 })); }
		catch (e) { /* private mode: the shipped window stands */ }
	});

	// THE TRANSPARENCY LOG IS ON SOMEBODY ELSE'S SERVER, and that is the point of
	// it: `js/verify.js` and `js/release.js` both read the published chain from
	// raw.githubusercontent.com, an origin this project does not control, because a
	// page that verified itself against a file it also served would prove nothing.
	//
	// A suite is a different matter. Two hundred and fifty verifiers, several page
	// loads each, is a few hundred unauthenticated fetches of one file inside two
	// hours, and GitHub answers that with 429 and a link to its scraping terms.
	// That is what reddened twenty-three verifiers on 2026-08-17: not the app, not
	// the gateway, a third party quite correctly declining to be scraped.
	//
	// So the log is served from the repo's own copy -- the same bytes GitHub would
	// return for this commit, since that file is what gets pushed. Pass
	// `{ publicLog: true }` for a run that genuinely means to ask the real origin.
	// A verifier registering its own route after `open()` still wins: Playwright
	// matches handlers in reverse order of registration, which is how
	// dev/verify_delivery.mjs has served its own chain here since it was written.
	if (!publicLog) {
		const chain = path.join(HERE, '..', 'verify/transparency.jsonl');
		// Missing (a worktree between seals, a fork): let the real origin answer and
		// let `errors()` name it, rather than inventing an empty log for the page to
		// draw conclusions from.
		if (fs.existsSync(chain)) {
			const body = fs.readFileSync(chain, 'utf8');
			await page.route('https://raw.githubusercontent.com/**', r => r.fulfill({
				status:      200,
				contentType: 'text/plain',
				headers:     { 'access-control-allow-origin': '*' },
				body,
			}));
		}
	}

	if (route) await route(page);
	await page.goto(APP, { waitUntil: 'domcontentloaded' });

	const s = { browser, page, errs, logs, net, name, foreign: [] };

	if (signIn) await signInAs(s, name);
	if (signIn && !defaults) await clearDiamonds(s);
	if (signIn && connect) await connectMock(s);

	s.close = async () => { await browser.close(); };
	return s;
}

/// Empty the rail, for a test that owns the Diamond set.
///
/// A FRESH PROFILE IS NO LONGER EMPTY. The app seeds two default Diamonds on the
/// first boot of an account (`seedDefaultDiamonds`), which notes2 asks for: an
/// arriving user should not face a blank rail. A verifier that builds a fixture
/// and then COUNTS — the graph pane's stats line, the tag filter, the pause
/// parcel, "the rail did not gain a Diamond nothing lists" — was written when a
/// new account held nothing, and two it did not create read as a defect in
/// whatever it was measuring.
///
/// Deleting them AFTER the boot that made them is deliberate: the app records
/// that it has already offered them, so nothing offers again and the rail stays
/// empty for the rest of the run. Suppressing the seed instead would mean a flag
/// in shipped code that exists only for tests, and would have to be written into
/// the account's own localStorage namespace before a boot that has not happened.
///
/// The pause tree is cleared with them. The defaults are seeded PAUSED, at the
/// leaf, so their ids travel in the sync parcel and outlive the Diamonds that
/// named them.
export async function clearDiamonds(s) {
	const { page } = s;
	const gone = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		let list = [];
		try { list = JSON.parse(await app.list_diamonds()); } catch (e) { return 0; }
		for (const d of list) { try { await app.delete_diamond(d.id); } catch (e) { /* already gone */ } }
		try { window.DaimondPause.forget('root'); } catch (e) { /* module not up */ }
		return list.length;
	});
	if (!gone) return 0;
	// Redrawn from the store the way a person would see it, rather than by poking
	// the rail: a reload is the one path guaranteed to agree with what is on disk.
	// It lands on the lock screen, hence the second sign-in.
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, s.name);
	return gone;
}

/// The chats as they are actually stored.
///
/// IndexedDB, not localStorage: transcripts moved there when a day of tool results
/// stopped fitting in the origin's five megabytes and `setItem` began throwing into
/// a swallowed catch. Read from outside the app, so what a test asserts on is what
/// is on disk rather than what the page believes it wrote.
export function storedChats(s) {
	return s.page.evaluate(() => new Promise((res) => {
		const req = indexedDB.open('daimond-chats', 1);
		req.onsuccess = () => {
			const db = req.result;
			let t;
			try { t = db.transaction('chats', 'readonly'); } catch (e) { res([]); return; }
			const all = t.objectStore('chats').getAll();
			all.onsuccess = () => res(all.result || []);
			all.onerror   = () => res([]);
		};
		req.onerror = () => res([]);
	}));
}

/// Empty the chat store, for a test that wants a clean rail.
///
/// Both places: the store itself, and the old localStorage key, which the app
/// migrates back in on the next boot if it is left sitting there.
export function clearChats(s) {
	return s.page.evaluate(() => new Promise((res) => {
		try {
			localStorage.removeItem('daimond-chats');
			localStorage.removeItem('daimond-chats-legacy');
		} catch (e) { /* private mode, or full */ }
		const req = indexedDB.open('daimond-chats', 1);
		req.onsuccess = () => {
			const db = req.result;
			let t;
			try { t = db.transaction('chats', 'readwrite'); } catch (e) { res(); return; }
			t.objectStore('chats').clear();
			t.oncomplete = () => res();
			t.onerror    = () => res();
		};
		req.onerror = () => res();
	}));
}

/// Get past the passphrase gate, creating the identity on first run.
export async function signInAs(s, name) {
	const { page } = s;
	await page.waitForSelector('#id-primary', { timeout: 15000 });
	// The name field is present in BOTH modes now — it doubles as the username a
	// password manager files the entry under — but it is readonly when unlocking,
	// where it names the account rather than choosing one. isEditable, not
	// isVisible: fill() throws on a readonly input.
	const nameBox = await page.$('#id-name');
	if (nameBox && await nameBox.isVisible() && await nameBox.isEditable()) await nameBox.fill(name);
	await page.fill('#id-pass', PASS);
	const confirm = await page.$('#id-pass2');
	if (confirm && await confirm.isVisible()) await confirm.fill(PASS);	// first run only
	// Creating an account now starts from a GENERATED passphrase, and the create
	// button stays disabled until the user says they have written it down. The
	// harness overwrites the generated phrase with its own fixed one (so a run can
	// reproduce the account), then ticks the acknowledgement the same way a person
	// would. Absent on the unlock screen, hence the visibility check.
	const wrote = await page.$('#id-wrote');
	if (wrote && await wrote.isVisible() && !(await wrote.isChecked())) {
		await wrote.check({ force: true });
	}
	// A direct DOM click, not page.click: the modal's fade keeps failing
	// Playwright's "stable" actionability check, so the normal click can hang
	// on a button that is perfectly clickable. The gate has no interception to
	// worry about (verified), so bypassing actionability is safe here.
	await page.evaluate(() => document.getElementById('id-primary').click());
	// The identity modal closes when it takes; if it does not, say why.
	await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 })
		.catch(async () => {
			const why = await page.evaluate(() =>
				(document.getElementById('id-error') || {}).textContent || '(no message)');
			throw new Error(`sign-in did not take: ${why}`);
		});
	await page.waitForTimeout(400);
}

/// Start a chat, which is what makes the composer appear.
///
/// A new chat is a *pending tile*: it carries a model and a Start button, and
/// becomes a live chat only when Start is pressed.  The harness presses it.
/// Say something to the Diamond on screen, through the composer it now uses.
///
/// The crystal used to carry its own `#steer-input`, and every test typed into
/// that. It is gone: a Diamond's daimon is a persistent chat, so there is ONE
/// composer for it and it lives in the chat face. `sendUserMessage` routes a
/// Diamond's message to `doSteer`, so this is the same code path the steer box
/// drove -- only reached the way a person now reaches it.
///
/// Selects the chat face first, because the composer is not on screen while the
/// crystal face is up.
export async function steerDiamond(s, text) {
	const p = s.page;
	const chat = await p.$('#dview-chat');
	if (chat) { await chat.click({ force: true }); await p.waitForTimeout(400); }
	await p.waitForSelector('#chat-input', { timeout: 10000 });
	await p.fill('#chat-input', text);
	await p.click('#chat-send', { force: true });
}

/// Start a NEW chat, and answer with its id.
///
/// `{ reuse: true }` asks only that SOME chat be in focus, and is what `chat()`
/// wants: a message per chat is not what any test means by "say this".
///
/// THE DEFAULT REALLY MAKES ONE, and says so if it cannot. This used to return
/// early whenever a chat was already on screen, which is the same request read as
/// the weaker one -- and after a reload it is a different chat entirely, because
/// the app restores the one that was open. dev/verify_attachfocus.mjs asked for a
/// fresh chat after a reload, was handed back the PRE-RELOAD chat, and then
/// called `chatToggle` on an attachment that chat already held: a toggle, so the
/// check REMOVED the attachment and read zero rows. It reported
/// `{"icons":0,"rows":0,"name":""}` for five gates as a footer that would not
/// draw. A silent no-op is what let that stand; a caller that asks for a new chat
/// and is handed an old one now gets a throw with both ids in it.
export async function newChat(s, { reuse = false } = {}) {
	const { page } = s;
	/// The chat in focus, or '' when the focus is a Diamond or nothing.
	const focusId = () => page.evaluate(() => {
		try {
			const f = window.DaimondAttach && window.DaimondAttach.focus();
			return (f && f.kind === 'chat') ? String(f.id) : '';
		} catch (e) { return ''; }
	});
	const before = await focusId();
	// "A composer is on screen" is NOT "we are in a chat", and the difference
	// arrived when a Diamond's crystal face gained the shared composer. Before
	// that, a visible `#chat-input` could only mean a chat; now it also means a
	// Diamond, whose composer talks to its daimon. Returning early there sent
	// every `chat()` call to the daimon instead of to a chat -- silently, with
	// the turns landing somewhere the test never looked.
	//
	// The face switch is the honest test: it is drawn for a Diamond and for
	// nothing else.
	const inChat = await page.evaluate(() => {
		const ci = document.getElementById('chat-input');
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		const sw = document.getElementById('diamond-view');
		return vis(ci) && !vis(sw);
	});
	if (inChat && reuse) return before;
	// The Admin drawer opens over the rail on a not-connected profile
	// ("Connect a model"), and since the rail gained its Diamonds/Chats
	// divider the + button sits under it. A force-click dispatches at the
	// button's coordinates, so the DRAWER receives it and nothing happens.
	// Close it the way a user would before reaching for the rail.
	const drawerClose = page.locator('#admin-close');
	if (await drawerClose.isVisible().catch(() => false)) {
		await drawerClose.click({ force: true });
		await page.waitForTimeout(200);
	}
	// force:true throughout — a page animation keeps failing Playwright's
	// "stable" actionability check, hanging otherwise-fine clicks.
	await page.click('#new-session-btn', { force: true });
	await page.waitForTimeout(500);
	// `.tile-start` by class, NOT `button:has-text("Start")`: has-text is a
	// case-insensitive SUBSTRING match, so it also matches the BYOK form's
	// "Save & start" -- which sits earlier in the document, so `.first()`
	// returned that hidden button and the click failed as "not visible" in any
	// test whose settings form happened to be in the DOM.
	const start = page.locator('.tile-start').first();
	if (await start.count()) {
		await start.click({ force: true });
	}
	await page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
	await page.waitForTimeout(300);
	const after = await focusId();
	// Only when both ids are readable: with no `DaimondAttach` there is nothing to
	// compare, and a harness that threw on that would be inventing a failure.
	if (!reuse && before && after && before === after) {
		throw new Error(`newChat: still in chat ${after} — no new chat was made. `
			+ 'Pass { reuse: true } if any chat will do.');
	}
	return after;
}

/// Point the app at a provider through the real Settings form.
///
/// `apiKey` is a parameter because `dev/reflux.mjs` drives this whole stack against a
/// REAL provider, and a probe that had to edit this function to do it would be measuring
/// a build nobody ships.  It defaults to the mock's sentinel, so every existing caller is
/// unchanged.
///
/// **Nothing here ever reads a credential from a file, and none is written down in this
/// tree.**  What a caller passes is whatever it holds; `reflux.mjs` passes a per-run token
/// its own relay mints, so the provider key never enters the page's storage at all.
export async function connectMock(s, { baseUrl = MOCK, model = MODEL, apiKey = 'mock-key' } = {}) {
	const { page } = s;
	// THE OTHER DOOR ONTO A MOCK, and until 2026-08-28 the guard was only on the first
	// one. `open()` asks `requireOwnMock` when it is told `connect: true` -- and 142 of
	// the 305 verifiers pass `connect: false` and reach a provider through here instead,
	// which is the ordinary pattern rather than an unusual one. So the check written
	// after the 2026-08-17 incident could not see the majority of the runs it was
	// written for, and `dev/verify_thinking.mjs` met the 2026-08-28 one with nothing
	// between it and a stale mock. Asked at whichever door is used.
	//
	// Only for THIS WORLD'S mock. This function is also how a probe points the app at a
	// real provider (`dev/probe_thinking_live.mjs` hands it an OpenRouter URL), and
	// openrouter.ai is quite properly not built from dev/mockllm.mjs.
	if (baseUrl === MOCK) await requireOwnMock();
	await page.evaluate(async ({ baseUrl, model, apiKey }) => {
		// Drive the form the user drives, so its own save path is exercised.
		const open = document.getElementById('settings-btn')
			|| document.querySelector('[data-admin="settings"]')
			|| document.querySelector('#admin-settings-btn');
		if (open) open.click();
		await new Promise(r => setTimeout(r, 200));
		const prov = document.getElementById('cfg-provider');
		if (prov) {
			prov.value = 'custom';
			prov.dispatchEvent(new Event('change', { bubbles: true }));
		}
		await new Promise(r => setTimeout(r, 200));
		const url = document.getElementById('cfg-base-url');
		if (url) {
			url.value = baseUrl;
			url.dispatchEvent(new Event('input', { bubbles: true }));
			url.dispatchEvent(new Event('change', { bubbles: true }));
		}
		const key = document.getElementById('cfg-api-key');
		if (key) {
			key.value = apiKey;
			key.dispatchEvent(new Event('input', { bubbles: true }));
			key.dispatchEvent(new Event('change', { bubbles: true }));
		}
		await new Promise(r => setTimeout(r, 600));	// the model list is fetched
		const sel = document.getElementById('cfg-model');
		const cus = document.getElementById('cfg-model-custom');
		if (sel && [...sel.options].some(o => o.value === model)) {
			sel.value = model;
			sel.dispatchEvent(new Event('change', { bubbles: true }));
		} else if (cus) {
			cus.style.display = '';
			cus.value = model;
			cus.dispatchEvent(new Event('input', { bubbles: true }));
			cus.dispatchEvent(new Event('change', { bubbles: true }));
		}
		const save = document.getElementById('byok-save');
		if (save) save.click();
	}, { baseUrl, model, apiKey });
	await s.page.waitForTimeout(1200);

	// Whatever the form did, the app is only connected if it says it is.
	//
	// READ FROM `daimond-models-v2`, WHICH IS WHERE THE APP KEEPS IT. This asked
	// `daimond-byok` -- the single-provider config that key replaced -- so from the
	// day the provider list landed it answered `null` for every connection that had
	// in fact worked perfectly. Nothing caught it because `open()` throws the value
	// away, and it was found by the first caller that read it: `dev/reflux.mjs`
	// refused to spend against a relay the app had plainly taken. The old key is
	// still read, for a profile written before the migration.
	const ready = await s.page.evaluate(() => {
		try {
			const raw = localStorage.getItem('daimond-models-v2');
			if (raw) {
				const j = JSON.parse(raw);
				const id = (j.def || {}).provider;
				const p  = ((j.providers || {})[id]) || {};
				if (!id) return null;
				return { baseUrl: p.url || '', model: (j.def || {}).model || '',
					hasKey: !!(p.key || p.keyEnc) };
			}
			const old = localStorage.getItem('daimond-byok');
			if (!old) return null;
			const j = JSON.parse(old);
			return { baseUrl: j.baseUrl, model: j.model, hasKey: !!(j.apiKey || j.apiKeyEnc) };
		} catch { return null; }
	});
	s.cfg = ready;
	return ready;
}

/// Connect a real provider (from dev/.secrets/testcfg.json) through the real
/// Settings form. `tier` selects value|mid|power. Returns the saved cfg.
export async function connectReal(s, tier = 'value') {
	const cfg = JSON.parse(fs.readFileSync(path.join(HERE, '.secrets/testcfg.json'), 'utf8'));
	const model = cfg.models[tier] || cfg.models.value;
	await s.page.evaluate(async (c) => {
		document.getElementById('settings-btn')?.click();
		await new Promise(r => setTimeout(r, 250));
		const prov = document.getElementById('cfg-provider');
		prov.value = 'custom'; prov.dispatchEvent(new Event('change', { bubbles: true }));
		await new Promise(r => setTimeout(r, 200));
		const url = document.getElementById('cfg-base-url');
		url.value = c.baseUrl; url.dispatchEvent(new Event('input', { bubbles: true })); url.dispatchEvent(new Event('change', { bubbles: true }));
		const key = document.getElementById('cfg-api-key');
		key.value = c.apiKey; key.dispatchEvent(new Event('input', { bubbles: true })); key.dispatchEvent(new Event('change', { bubbles: true }));
		await new Promise(r => setTimeout(r, 1500));
		const cus = document.getElementById('cfg-model-custom');
		if (cus) { cus.style.display = ''; cus.value = c.model; cus.dispatchEvent(new Event('input', { bubbles: true })); }
		const sel = document.getElementById('cfg-model');
		if (sel && [...sel.options].some(o => o.value === c.model)) { sel.value = c.model; sel.dispatchEvent(new Event('change', { bubbles: true })); }
		document.getElementById('byok-save')?.click();
	}, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model });
	await s.page.waitForTimeout(1500);
	s.model = model;
	return model;
}

/// Cumulative USD spend recorded in the client ledger for this session.
export function spend(s) {
	return s.page.evaluate(() => {
		try { return JSON.parse(localStorage.getItem('daimond-ledger') || '[]').reduce((a, e) => a + (e.u || 0), 0); }
		catch { return 0; }
	});
}

/// Send a message and wait for the turn to finish.
///
/// "Finished" means the send button is offering Send again, not Stop — the
/// only signal the UI itself trusts.
export async function chat(s, text, { timeout = 30000 } = {}) {
	const { page } = s;
	// `reuse`: a conversation is several messages in ONE chat. Only a caller who
	// asks for `newChat` itself is asking for a new one.
	await newChat(s, { reuse: true });
	await page.fill('#chat-input', text);
	await page.click('#chat-send', { force: true });
	await page.waitForTimeout(300);
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const busy = await page.evaluate(() => {
			const b = document.getElementById('chat-send');
			if (!b) return false;
			const t = (b.getAttribute('title') || '') + (b.className || '');
			return /stop/i.test(t) || b.disabled;
		});
		if (!busy) break;
		await page.waitForTimeout(250);
	}
	await page.waitForTimeout(400);
	return transcript(s);
}

/// The visible conversation, as text.
export async function transcript(s) {
	return s.page.evaluate(() => {
		const out = document.getElementById('chat-output');
		return out ? out.innerText : '';
	});
}

/// A screenshot, kept in dev/shots.
export async function shot(s, label) {
	fs.mkdirSync(SHOTS, { recursive: true });
	const p = path.join(SHOTS, `${label}.png`);
	// Non-fatal and time-boxed: a headless render can hang on a live animation,
	// and a missing screenshot must never fail a test that otherwise passed.
	await s.page.screenshot({ path: p, fullPage: false, timeout: 8000 }).catch(() => {});
	return p;
}

/// Is this URL somewhere outside the world under test?
///
/// A world is the dev server, the mock provider, the gateway and anything else
/// answering on loopback. Everything on any other host is a third party, and a
/// third party's refusal is a fact about the internet, not about the product.
function foreign(url) {
	if (!url) return false;
	let h;
	try { h = new URL(url).hostname; } catch (e) { return false; }
	return !(h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]');
}

/// Put a console error back together with the URL that caused it.
///
/// Chrome prints the status and drops the URL, so the pairing has to be made from
/// the response log kept in `open()`. Matched by status and CONSUMED: two 429s in
/// one run are two different requests, and blaming both on the first would put a
/// name to something that was never asked.
///
/// Anything else -- a `net::ERR_*`, a `pageerror` -- already carries its own URL
/// where it has one, so it is only read for the origin.
function attribute(msg, pending) {
	const m = /status of (\d{3})/.exec(msg);
	if (m) {
		const i = pending.findIndex(n => n.status === Number(m[1]));
		if (i < 0) return { text: msg, url: '' };
		const n = pending.splice(i, 1)[0];
		return { text: `${msg} ${n.url}`, url: n.url };
	}
	const u = /(https?:\/\/[^\s'"]+)/.exec(msg);
	return { text: msg, url: u ? u[1] : '' };
}

/// Console errors seen so far, minus the noise a dev server always makes.
///
/// TWO THINGS HAPPEN HERE that did not before the 2026-08-17 gate.
///
/// Each "Failed to load resource" is given the URL that caused it, so a red is
/// actionable on sight. Twenty-three verifiers reported `a status of 429 ()` that
/// day and no reader of any of those logs could say which server had answered.
///
/// And a failure from a host OUTSIDE THIS WORLD is not returned, because every
/// caller of this function is asking "did the product throw" and a third party
/// declining to serve us is not the product. It is not swallowed: it goes to
/// `s.foreign` and is PRINTED, once each, so a run can never be quietly excused by
/// a filter. A verifier that means to assert on one reads `s.foreign` itself.
export function errors(s) {
	const skip = [/favicon/i, /net::ERR_ABORTED.*hot/i];
	const pending = (s.net || []).slice();
	if (!s.foreign) s.foreign = [];		// a session this module did not build
	const out = [];
	for (const e of s.errs) {
		if (skip.some(r => r.test(e))) continue;
		const a = attribute(e, pending);
		if (!foreign(a.url)) { out.push(a.text); continue; }
		if (s.foreign.indexOf(a.text) >= 0) continue;
		s.foreign.push(a.text);
		console.log(`  note  outside this world, so not counted as the app throwing: ${a.text}`);
	}
	return out;
}
