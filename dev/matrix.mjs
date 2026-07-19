// matrix.mjs — one launcher for the whole test matrix: engine × device × theme.
//
// The three browser ENGINES are the axis that matters. Android Chrome is
// Chromium; every iOS browser is WebKit (Safari); Firefox is Gecko. Driving all
// three at real device viewports, in each theme, is as close to "everywhere" as
// a Linux host reaches on its own. What it CANNOT reproduce is iOS chrome (the
// address-bar vh dance, safe areas, input zoom, standalone PWA) — that needs a
// real iPhone or a device cloud. WebKit-on-Linux is the engine, not the phone.
//
// Firefox is included only when installed (`npx playwright install firefox`);
// this host has Chromium and WebKit, so a Gecko cell is skipped with a note
// rather than failing the run.
//
//   import { openCell, defaultCells, VIEWS } from './matrix.mjs';
//   for (const cell of defaultCells()) {
//     const s = await openCell(cell);
//     await VIEWS.find(v => v.name === 'spend').setup(s.page);
//     await s.close();
//   }
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { signInAs, connectMock } from './harness.mjs';

// This host (Ubuntu 25.10) is newer than WebKit's build target, so the launch
// preflight refuses; the runtime libs are supplied out-of-band (setup-webkit-libs.sh).
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium, firefox, webkit, devices } = await import(pathToFileURL(PW).href);
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

/// The three engines, and whether each is launchable on this host. Chromium is
/// pinned to the same build the rest of the harness uses; WebKit and Firefox use
/// their Playwright bundles. `probe` is filled in lazily by `enginesAvailable`.
export const ENGINES = {
	chromium: { type: chromium, launch: { executablePath: CHROME } },
	webkit:   { type: webkit,   launch: {} },
	firefox:  { type: firefox,  launch: {} },
};

/// The three themes the app ships, exactly as `data-theme` names them.
export const THEMES = ['dark', 'light', 'lollypop'];

/// The devices worth walking. `engine` is the browser engine FAITHFUL to the real
/// device — Android is Chromium, iOS is WebKit — so a mobile cell picks the right
/// one automatically. `desc` is a Playwright device descriptor; `vp` an explicit
/// desktop viewport. `mobile` marks a touch device, which turns on tap-target
/// checks and the mobile shell.
export const DEVICES = {
	'desktop':        { engine: 'chromium', vp: { width: 1500, height: 950 }, mobile: false },
	'desktop-narrow': { engine: 'chromium', vp: { width: 1024, height: 820 }, mobile: false },
	'ipad':           { engine: 'webkit',   desc: 'iPad (gen 7)',             mobile: true  },
	'pixel':          { engine: 'chromium', desc: 'Pixel 5',                  mobile: true  },
	'iphone':         { engine: 'webkit',   desc: 'iPhone 13',                mobile: true  },
	'iphone-se':      { engine: 'webkit',   desc: 'iPhone SE',                mobile: true  },
};

/// Which engines can actually launch here, probed once. A missing engine (e.g.
/// Firefox not installed) is reported so a run says what it skipped rather than
/// silently narrowing coverage.
let _avail = null;
export async function enginesAvailable() {
	if (_avail) return _avail;
	_avail = {};
	for (const name of Object.keys(ENGINES)) {
		try {
			const b = await ENGINES[name].type.launch({ ...ENGINES[name].launch, headless: true });
			await b.close();
			_avail[name] = true;
		} catch (e) {
			_avail[name] = false;
		}
	}
	return _avail;
}

/// A cell is one (engine, device, theme). The label is stable and filesystem-safe,
/// so screenshots and findings key off it.
export function cellLabel(c) { return `${c.device}.${c.engine}.${c.theme}`; }

/// The default matrix: each mobile device on its faithful engine, desktop on
/// Chromium and (when present) Firefox, across all three themes. Override with
/// env DAIMOND_DEVICES / DAIMOND_THEMES (comma lists) to narrow a run.
export function defaultCells() {
	const devs   = (process.env.DAIMOND_DEVICES || 'desktop,pixel,iphone,ipad').split(',').map(s => s.trim()).filter(Boolean);
	const themes = (process.env.DAIMOND_THEMES  || THEMES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
	const cells = [];
	for (const device of devs) {
		const d = DEVICES[device];
		if (!d) continue;
		for (const theme of themes) {
			cells.push({ engine: d.engine, device, theme });
			// Desktop is also worth a Gecko pass; mobile Gecko is not a real target.
			if (device === 'desktop') cells.push({ engine: 'firefox', device, theme });
		}
	}
	return cells;
}

/// Launch one cell: the right engine, the device's viewport/DPR/touch/UA, the
/// theme pinned before first paint, then (by default) signed in on the mock model.
/// Returns a driven page plus a collected console-error list, mirroring harness.open.
export async function openCell(cell, opts = {}) {
	const { signIn = true, connect = true } = opts;
	const eng = ENGINES[cell.engine];
	if (!eng) throw new Error(`unknown engine ${cell.engine}`);

	const d = DEVICES[cell.device] || {};
	const descriptor = d.desc ? devices[d.desc] : null;

	// Build the context options from the device descriptor. WebKit rejects
	// `isMobile`, so it is dropped for that engine (as verify_webkit does).
	const ctxOpts = {};
	if (descriptor) {
		Object.assign(ctxOpts, {
			viewport:           descriptor.viewport,
			userAgent:          descriptor.userAgent,
			deviceScaleFactor:  descriptor.deviceScaleFactor,
			hasTouch:           descriptor.hasTouch,
		});
		if (cell.engine === 'chromium' && descriptor.isMobile) ctxOpts.isMobile = true;
	} else if (d.vp) {
		ctxOpts.viewport = d.vp;
	}
	// Pin the theme before any script runs, so the very first paint is themed.
	ctxOpts.colorScheme = cell.theme === 'dark' ? 'dark' : 'light';

	const profileDir = path.join('/tmp/daimond-matrix', `${cellLabel(cell)}-${process.pid}`);
	const context = await eng.type.launchPersistentContext(profileDir, {
		...eng.launch,
		headless: true,
		...ctxOpts,
	});
	// Seed the theme in storage so the app's own setTheme agrees with the attribute.
	await context.addInitScript(t => {
		try { localStorage.setItem('daimond-theme', t); } catch (e) {}
		document.documentElement.setAttribute('data-theme', t);
	}, cell.theme);

	const page = context.pages()[0] || await context.newPage();
	const errs = [], logs = [];
	page.on('console', m => { logs.push(`${m.type()}: ${m.text()}`); if (m.type() === 'error') errs.push(m.text()); });
	page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
	page.on('crash', () => errs.push('PAGE CRASHED'));

	const { APP } = await import('./harness.mjs');
	await page.goto(APP, { waitUntil: 'domcontentloaded' });
	// Re-assert the theme after load (the app's boot may set its own default).
	await applyTheme(page, cell.theme);

	const s = { context, page, errs, logs, cell, label: cellLabel(cell) };
	if (signIn) await signInAs(s, 'mx' + Math.abs(hash(cellLabel(cell))) % 9999);
	if (signIn && connect) {
		await connectMock(s);
		// connectMock leaves the settings form open; toggle it shut so a signed-in
		// view is the app itself, not the config panel lingering over it.
		await page.evaluate(() => { const b = document.getElementById('settings-btn'); if (b) b.click(); }).catch(() => {});
		await page.waitForTimeout(150);
	}
	await applyTheme(page, cell.theme);
	s.close = async () => { try { await context.close(); } catch (e) {} };
	return s;
}

/// Set the theme on a live page the way the app does (attribute + storage).
export async function applyTheme(page, theme) {
	await page.evaluate(t => {
		try { localStorage.setItem('daimond-theme', t); } catch (e) {}
		document.documentElement.setAttribute('data-theme', t);
	}, theme).catch(() => {});
}

/// A stable non-crypto hash, for a per-cell identity name.
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

/// The app states worth exercising, each reached through the app's own surface so
/// the walk is a real user path, not a poke at private state. `needsAuth` views
/// are skipped on a locked (signed-out) cell.
export const VIEWS = [
	{ name: 'locked',   needsAuth: false, setup: async () => {} },
	{ name: 'home',     needsAuth: true,  setup: async () => {} },
	{ name: 'chat',     needsAuth: true,  setup: async (p) => chatTurn(p) },
	{ name: 'spend',    needsAuth: true,  setup: async (p) => open(p, () => window.DaimondSpend && window.DaimondSpend.show(), '.spend-sec') },
	{ name: 'pair-qr',  needsAuth: true,  setup: async (p) => open(p, () => window.DaimondPairing && window.DaimondPairing.showLink(), '.pair-qr,.pair-code') },
	{ name: 'workspace',needsAuth: true,  setup: async (p) => open(p, () => window.DaimondPanels && window.DaimondPanels.show('work'), '#panel-work') },
	{ name: 'mail',     needsAuth: true,  setup: async (p) => open(p, () => window.DaimondPanels && window.DaimondPanels.show('mail'), '#panel-mail') },
	{ name: 'agents',   needsAuth: true,  setup: async (p) => open(p, () => window.DaimondPanels && window.DaimondPanels.show('agents'), '#panel-agents') },
	{ name: 'tools',    needsAuth: true,  setup: async (p) => open(p, () => (window.DaimondTools && window.DaimondTools.show()) || (window.DaimondPanels && window.DaimondPanels.show('tools')), '#panel-tools') },
	{ name: 'compose',  needsAuth: true,  setup: async (p) => open(p, () => window.DaimondPanels && window.DaimondPanels.show('compose'), '#panel-compose') },
	{ name: 'settings', needsAuth: true,  setup: async (p) => open(p, () => { const b = document.getElementById('settings-btn'); if (b) b.click(); }, '#cfg-provider,#byok-form') },
];

/// Drive one real chat turn against the mock model, so the transcript, the
/// streaming bubble and the cost row are all in a populated (not empty) state.
async function chatTurn(page) {
	await page.evaluate(() => { const b = document.getElementById('new-session-btn'); if (b) b.click(); }).catch(() => {});
	await page.waitForTimeout(300);
	await page.evaluate(() => { const s = [...document.querySelectorAll('button')].find(x => /^Start$/.test((x.textContent || '').trim())); if (s) s.click(); }).catch(() => {});
	await page.waitForSelector('#chat-input', { timeout: 4000 }).catch(() => {});
	await page.evaluate(() => { const i = document.getElementById('chat-input'); if (i) { i.value = 'In one sentence, what is Daimond?'; i.dispatchEvent(new Event('input', { bubbles: true })); } }).catch(() => {});
	await page.evaluate(() => { const b = document.getElementById('chat-send'); if (b) b.click(); }).catch(() => {});
	await page.waitForTimeout(3000);
}

/// Dismiss anything overlaying the app before the next view is set up, so a modal
/// or dialog from one view (the pairing overlay, an open settings form) does not
/// bleed into the next screen's capture or audit.
export async function resetView(page) {
	await page.evaluate(() => {
		document.querySelectorAll('.pair-scrim').forEach(e => e.remove());	// pairing dialog
		// Close every open guest panel, so a view is captured/audited in isolation
		// rather than stacked on the panels the previous view left open. The rail
		// (Facets/Chats/Admin) and the chat floor stay.
		document.querySelectorAll('[data-close]').forEach(b => {
			var t = b.getAttribute('data-close');
			if (t && t !== 'rail' && b.offsetParent !== null) { try { b.click(); } catch (e) {} }
		});
		// Close the settings/admin form if it is showing, back to home.
		try {
			var cfg = document.getElementById('cfg-provider');
			if (cfg && cfg.offsetParent !== null) { var s = document.getElementById('settings-btn'); if (s) s.click(); }
		} catch (e) {}
	}).catch(() => {});
	await page.waitForTimeout(150);
}

/// Run a setup thunk in the page, then wait briefly for a landmark selector so the
/// view has painted before it is audited or shot. Never throws — a view that does
/// not open is caught by the audit/shot as an empty result.
async function open(page, thunk, landmark) {
	await page.evaluate(thunk).catch(() => {});
	await page.waitForSelector(landmark, { timeout: 3000 }).catch(() => {});
	await page.waitForTimeout(250);
}
