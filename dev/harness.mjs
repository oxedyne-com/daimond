// A browser harness for driving Daimond the way a user does.
//
// Every flow worth testing runs through the real page: the wasm, the panels,
// the agent loop, the tools.  This opens a browser on the dev server, gets
// past the passphrase gate, points the app at the mock provider, and hands
// back a page you can drive.  Console errors and page crashes are collected
// throughout, because a flow that "works" while throwing is not working.
//
//   import { open, chat, shot, errors } from './harness.mjs';
//   const s = await open();                       // signed in, model connected
//   await chat(s, '@tool file_write {"path":"a.txt","content":"hi"}');
//   await shot(s, 'after-write');
//   await s.close();
//
// Headless by default.  Pass { headed: true } for the extension flows, which
// need real rendering — and run those under xvfb, never on the user's display.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extDev, isExtSource } from './extdev.mjs';

// playwright-core lives outside the repo, so it is resolved by path, not by
// package name — nothing here is installed into the app.
const PW = process.env.DAIMOND_PW
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
	} = opts;

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
	// work. A headed run genuinely needs the display, so it keeps it.
	const env = { ...process.env };
	if (!headed) delete env.DISPLAY;

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

	if (route) await route(page);
	await page.goto(APP, { waitUntil: 'domcontentloaded' });

	const s = { browser, page, errs, logs, name };

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

export async function newChat(s) {
	const { page } = s;
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
	if (inChat) return;
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
}

/// Point the app at the mock provider through the real Settings form.
export async function connectMock(s, { baseUrl = MOCK, model = MODEL } = {}) {
	const { page } = s;
	await page.evaluate(async ({ baseUrl, model }) => {
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
			key.value = 'mock-key';
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
	}, { baseUrl, model });
	await s.page.waitForTimeout(1200);

	// Whatever the form did, the app is only connected if it says it is.
	const ready = await s.page.evaluate(() => {
		try {
			const raw = localStorage.getItem('daimond-byok');
			if (!raw) return null;
			const j = JSON.parse(raw);
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
	await newChat(s);
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

/// Console errors seen so far, minus the noise a dev server always makes.
export function errors(s) {
	const skip = [/favicon/i, /net::ERR_ABORTED.*hot/i];
	return s.errs.filter(e => !skip.some(r => r.test(e)));
}
