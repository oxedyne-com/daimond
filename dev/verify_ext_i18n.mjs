// verify_ext_i18n.mjs — Daimond Hands in the eight languages the app speaks.
//
// The extension is where the user is asked to GRANT a page to an agent. A
// reader who cannot read that window is being asked to trust something at the
// exact moment they cannot understand the question, so this file is mostly
// about that one window.
//
// Two halves.
//
// The tables, read from disk: every locale carries every key, no key is empty,
// the placeholders line up, the product nouns are left alone, and the source
// asks for nothing that is not there.
//
// The extension, in a real browser: the manifest's own `description` really is
// served from `_locales` (nothing but `_locales` can do that); the grant window
// really does draw itself in the language the APP chose rather than the one
// Chrome is running in; the answer still reaches the broker and still refuses
// in English, which is the daimon's language and not the user's; and a locale
// we do not ship falls back to English rather than to a blank window.
//
// Needs dev/serve.mjs on :8777. Run it headed, under xvfb:
//	xvfb-run -a node dev/verify_ext_i18n.mjs
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
const ROOT = '/home/jason/usr/code/web/apps/oxedyne/daimond';
const EXT = `${ROOT}/ext`;
const EXTID = 'mpliijponglmmffjnonahhignkpkhmij';
// Not /tmp -- see the SCRATCH note in harness.mjs.
const SCRATCH = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const APP = 'http://localhost:8777';
const SITE_PORT = Number(process.env.EXTI18N_PORT || 9123);
const SITE = `http://127.0.0.1:${SITE_PORT}`;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The locales we ship ──────────────────────────────────────────────
//
// App locale code -> Chrome `_locales` directory name. Chrome's directories are
// its own: an underscore, and its own region spellings. `pt-BR` becomes `pt_BR`
// and `zh-Hans` becomes `zh_CN`, because `_locales` has no script-tag form.
const DIRS = {
	'en': 'en', 'de': 'de', 'es': 'es', 'fr': 'fr',
	'ja': 'ja', 'ko': 'ko', 'pt-BR': 'pt_BR', 'zh-Hans': 'zh_CN',
};

const table = {};
for (const [code, dir] of Object.entries(DIRS)) {
	const p = `${EXT}/_locales/${dir}/messages.json`;
	try {
		table[code] = JSON.parse(fs.readFileSync(p, 'utf8'));
	} catch (e) {
		table[code] = null;
		check(`${code} has a table at _locales/${dir}/`, false, String(e.message));
	}
}

const EN = table.en || {};
const KEYS = Object.keys(EN);
check('the English table is the baseline and is not empty', KEYS.length > 0, `${KEYS.length} messages`);

// ── Every locale, every key ──────────────────────────────────────────
for (const code of Object.keys(DIRS)) {
	const tbl = table[code];
	if (!tbl) continue;
	const missing	= KEYS.filter((k) => !tbl[k]);
	const extra	= Object.keys(tbl).filter((k) => !EN[k]);
	const empty	= KEYS.filter((k) => tbl[k] && !String(tbl[k].message || '').trim());
	check(`${code}: every key is present`, missing.length === 0, missing.join(', '));
	check(`${code}: no key is empty`, empty.length === 0, empty.join(', '));
	check(`${code}: no key the baseline does not have`, extra.length === 0, extra.join(', '));

	// A `$HOST$` that survives in one language and is dropped in another is a
	// window that names the site to some users and not to others.
	const phBad = KEYS.filter((k) => {
		if (!tbl[k]) return false;
		const wantsHost = /\$HOST\$/.test(EN[k].message);
		const hasHost   = /\$HOST\$/.test(tbl[k].message);
		const declared  = !!(tbl[k].placeholders && tbl[k].placeholders.host);
		return wantsHost !== hasHost || wantsHost !== declared;
	});
	check(`${code}: the $HOST$ placeholder is kept and declared`, phBad.length === 0, phBad.join(', '));
}

// ── Do not translate ─────────────────────────────────────────────────
//
// "Daimond" is a product noun, "Daimond Hands" is the extension's name, and a
// user must not meet two words for one thing. Wherever the English says them,
// every other language says them too, verbatim.
for (const noun of ['Daimond Hands', 'Daimond', 'Chrome']) {
	const owed = KEYS.filter((k) => EN[k].message.includes(noun));
	const broken = [];
	for (const code of Object.keys(DIRS)) {
		if (!table[code] || code === 'en') continue;
		for (const k of owed) {
			const m = table[code][k] && table[code][k].message;
			if (m && !m.includes(noun)) broken.push(`${code}/${k}`);
		}
	}
	check(`"${noun}" is left untranslated everywhere`, broken.length === 0,
		`${owed.length} keys carry it; broken: ${broken.join(', ')}`);
}

// ── Register ─────────────────────────────────────────────────────────
//
// Calm, plain, concrete. The app has no exclamation marks in it and neither
// should the window that asks for a permission.
{
	const shouty = [];
	for (const code of Object.keys(DIRS)) {
		if (!table[code]) continue;
		for (const k of Object.keys(table[code])) {
			if (/[!！]/.test(table[code][k].message)) shouty.push(`${code}/${k}`);
		}
	}
	check('no exclamation marks anywhere', shouty.length === 0, shouty.join(', '));
}

// ── The source and the tables agree ──────────────────────────────────
const SRC = ['manifest.json', 'i18n.js', 'background.js', 'content.js', 'popup.js', 'popup.html', 'grant.js', 'grant.html', 'announce.js']
	.map((f) => fs.readFileSync(`${EXT}/${f}`, 'utf8')).join('\n');

{
	// Asked for but not shipped: the surface would print the key itself.
	const asked = new Set();
	for (const m of SRC.matchAll(/\b[tT]\(\s*'([a-z0-9_]+)'/g)) asked.add(m[1]);
	for (const m of SRC.matchAll(/data-i18n(?:-title)?="([a-z0-9_]+)"/g)) asked.add(m[1]);
	for (const m of SRC.matchAll(/__MSG_([a-z0-9_]+)__/g)) asked.add(m[1]);
	const unknown = [...asked].filter((k) => !EN[k]);
	check('every key the source asks for exists', unknown.length === 0, unknown.join(', '));
	check('the source really does ask for them', asked.size > 10, `${asked.size} keys used`);

	// Shipped but never asked for: a translator's work nobody will ever read.
	const dead = KEYS.filter((k) => !SRC.includes(k));
	check('no key is shipped that the source never uses', dead.length === 0, dead.join(', '));
}

// ── The manifest ─────────────────────────────────────────────────────
{
	const man = JSON.parse(fs.readFileSync(`${EXT}/manifest.json`, 'utf8'));
	check('the manifest declares a default_locale', man.default_locale === 'en', String(man.default_locale));
	check('the manifest description comes from _locales', man.description === '__MSG_ext_desc__', man.description);
	// The name is a product noun. Routing it through _locales would only invite
	// somebody to translate it.
	check('the manifest name is the untranslated product noun', man.name === 'Daimond Hands', man.name);
}

// ── The extension, in a real browser ─────────────────────────────────

/// A tiny site of our own, so nothing here depends on another test's server.
const site = http.createServer((req, res) => {
	const body = req.url.startsWith('/login')
		? '<!doctype html><title>Sign in</title><main><h1>Sign in</h1>'
			+ '<form action="/in" method="post"><input name="u" placeholder="User" type="text">'
			+ '<input name="p" placeholder="Password" type="password">'
			+ '<button type="submit">Log in</button></form></main>'
		: '<!doctype html><title>Home</title><main><h1>Home</h1><p>An ordinary page.</p></main>';
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(body);
});
await new Promise((r) => site.listen(SITE_PORT, '127.0.0.1', r));

function launch(profile) {
	fs.rmSync(profile, { recursive: true, force: true });
	fs.mkdirSync(profile, { recursive: true });
	return chromium.launchPersistentContext(profile, {
		executablePath: CHROME, headless: false,
		args: ['--no-sandbox', '--disable-dev-shm-usage',
			`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
		viewport: { width: 1280, height: 900 },
	});
}
async function waitSW(b) {
	for (let i = 0; i < 80 && !b.serviceWorkers().length; i++) await new Promise((r) => setTimeout(r, 100));
	return b.serviceWorkers()[0];
}
const msg = (code, key) => table[code][key].message;
/// The message with its `$HOST$` filled in, the way the window will show it.
const msgHost = (code, key, host) => msg(code, key).replace(/\$HOST\$/g, host);

/// Put a language into the app the way a user does, and let announce.js carry
/// it across. Reloading is what makes it deterministic: the content script
/// reads the choice at document_start.
async function speak(page, code) {
	await page.evaluate((c) => {
		if (c) localStorage.setItem('daimond-locale', c);
		else localStorage.removeItem('daimond-locale');
	}, code);
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(350);
}

const PROFILE = path.join(SCRATCH, 'verify-ext-i18n');
let b = await launch(PROFILE);

try {
	const sw = await waitSW(b);
	check('the extension service worker started', !!sw);

	// Only `_locales` can reach the manifest. If this is the literal
	// `__MSG_ext_desc__`, the whole mechanism is not wired up.
	const desc = sw ? await sw.evaluate(() => chrome.runtime.getManifest().description) : '';
	check('the manifest description is served from _locales', desc === msg('en', 'ext_desc'), desc.slice(0, 60));

	const app = await b.newPage();
	await app.goto(APP + '/', { waitUntil: 'domcontentloaded' });
	await app.waitForTimeout(400);

	const grant = await b.newPage();
	const HOST = 'example.com';
	const grantUrl = `chrome-extension://${EXTID}/grant.html?nonce=t&kind=site&host=${HOST}`
		+ `&pattern=${encodeURIComponent('*://*.' + HOST + '/*')}`;

	// The grant window, once per language.
	for (const code of Object.keys(DIRS)) {
		await speak(app, code);
		await grant.goto(grantUrl, { waitUntil: 'domcontentloaded' });
		await grant.waitForTimeout(250);
		const got = await grant.evaluate(() => ({
			head:  document.getElementById('head').textContent,
			scope: document.getElementById('scope').textContent,
			body:  document.getElementById('body').textContent,
			fine:  document.getElementById('fine').textContent,
			allow: document.getElementById('allow').textContent,
			deny:  document.getElementById('deny').textContent,
			lang:  document.documentElement.lang,
		}));
		const want = {
			head:  msg(code, 'grant_site_head'),
			scope: msgHost(code, 'grant_site_scope', HOST),
			body:  msg(code, 'grant_site_body'),
			fine:  msg(code, 'grant_site_fine'),
			allow: msg(code, 'grant_site_allow'),
			deny:  msg(code, 'grant_deny'),
		};
		const wrong = Object.keys(want).filter((k) => got[k] !== want[k]);
		check(`the grant window speaks ${code}`, wrong.length === 0,
			wrong.map((k) => `${k}: ${JSON.stringify(got[k])}`).join(' | '));
		check(`the grant window says it is in ${code}`, got.lang === code, got.lang);
	}

	// The other question, in one language, so the mirror branch is covered too.
	{
		await speak(app, 'ja');
		await grant.goto(`chrome-extension://${EXTID}/grant.html?nonce=t&kind=mirror`
			+ `&pattern=${encodeURIComponent('<all_urls>')}`, { waitUntil: 'domcontentloaded' });
		await grant.waitForTimeout(250);
		const got = await grant.evaluate(() => ({
			head: document.getElementById('head').textContent,
			allow: document.getElementById('allow').textContent,
			hostShown: !document.getElementById('host').hidden,
		}));
		check('the live-view question speaks ja too',
			got.head === msg('ja', 'grant_mirror_head') && got.allow === msg('ja', 'grant_mirror_allow'),
			JSON.stringify(got));
		check('the live-view question still names no host', !got.hostShown);
	}

	// A language we do not ship falls back to English, not to a blank window.
	for (const [what, code] of [['a locale we do not ship', 'zh-Hant'], ['no choice at all', '']]) {
		await speak(app, code);
		await grant.goto(grantUrl, { waitUntil: 'domcontentloaded' });
		await grant.waitForTimeout(250);
		const got = await grant.evaluate(() => ({
			head: document.getElementById('head').textContent,
			allow: document.getElementById('allow').textContent,
			scope: document.getElementById('scope').textContent,
		}));
		check(`${what} falls back to English`,
			got.head === msg('en', 'grant_site_head') && got.allow === msg('en', 'grant_site_allow'),
			JSON.stringify(got).slice(0, 160));
		// The fallback runs through chrome.i18n rather than through our own
		// table, and that is the path where a `$HOST$` left standing would tell
		// the user their site is called "$HOST$".
		check(`${what} still fills in the host`,
			got.scope === msgHost('en', 'grant_site_scope', HOST), JSON.stringify(got.scope));
	}

	// The popup, in one language.
	{
		await speak(app, 'de');
		const pop = await b.newPage();
		await pop.goto(`chrome-extension://${EXTID}/popup.html`, { waitUntil: 'domcontentloaded' });
		await pop.waitForTimeout(500);
		const got = await pop.evaluate(() => ({
			head: document.querySelector('h2').textContent,
			mode: document.getElementById('mode').textContent,
			none: document.querySelector('#granted li') ? document.querySelector('#granted li').textContent : '',
		}));
		check('the popup speaks de',
			got.head === msg('de', 'popup_granted_head')
			&& got.mode.startsWith(msg('de', 'popup_mode_idle'))
			&& got.none === msg('de', 'popup_none'),
			JSON.stringify(got));
		await pop.close();
	}
	await grant.close();

	// ── The whole round trip: ask, answer, refuse ────────────────────
	//
	// The window the broker itself opens, in the app's language; the click that
	// answers it; and the refusal that comes back — which is addressed to the
	// model, not to the user, and so stays English however the window was
	// written.
	await speak(app, 'ja');
	const opened = new Promise((resolve) => {
		const on = (p) => { if (p.url().includes('grant.html')) { b.off('page', on); resolve(p); } };
		b.on('page', on);
	});
	const answer = app.evaluate(({ extId, url }) => new Promise((resolve) => {
		chrome.runtime.sendMessage(extId, { cmd: 'open', url }, (r) =>
			resolve(r || { ok: false, error: chrome.runtime.lastError && chrome.runtime.lastError.message }));
	}), { extId: EXTID, url: SITE + '/' });

	const win = await Promise.race([opened, new Promise((r) => setTimeout(() => r(null), 15000))]);
	check('asking to open an un-approved site opens the grant window', !!win);
	if (win) {
		await win.waitForTimeout(400);
		const shown = await win.evaluate(() => ({
			head: document.getElementById('head').textContent,
			host: document.getElementById('host').textContent,
			deny: document.getElementById('deny').textContent,
		}));
		check('that window is in ja, and names the host',
			shown.head === msg('ja', 'grant_site_head') && shown.deny === msg('ja', 'grant_deny')
			&& shown.host === '127.0.0.1',
			JSON.stringify(shown));
		await win.click('#deny');
	}
	const r = await Promise.race([answer, new Promise((res) => setTimeout(() => res({ ok: false, error: 'TIMEOUT' }), 20000))]);
	check('the answer reaches the broker and the site is refused', r && r.ok === false, JSON.stringify(r).slice(0, 160));
	check('the refusal to the model is still English',
		!!(r && /The user declined/.test(r.error || '')), (r && r.error || '').slice(0, 120));

	await b.close();

	// ── The wheel, and the button that gives it back ─────────────────
	//
	// Chrome's own permission bubble cannot be clicked under automation, so the
	// host grant is seeded into the profile — the user having said Allow once.
	// Everything after it is real: a login page takes the wheel, the reason the
	// app prints back is in the user's language, and so is the button in the tab.
	const P2 = path.join(SCRATCH, 'verify-ext-i18n-granted');
	b = await launch(P2);
	await waitSW(b);
	await b.close();
	const prefsPath = path.join(P2, 'Default', 'Preferences');
	const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
	for (const k of ['granted_permissions', 'active_permissions']) {
		prefs.extensions.settings[EXTID][k].explicit_host = ['*://*/*', '<all_urls>'];
	}
	fs.writeFileSync(prefsPath, JSON.stringify(prefs));

	b = await chromium.launchPersistentContext(P2, {
		executablePath: CHROME, headless: false,
		args: ['--no-sandbox', '--disable-dev-shm-usage',
			`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
		viewport: { width: 1280, height: 900 },
	});
	await waitSW(b);
	const app2 = await b.newPage();
	await app2.goto(APP + '/', { waitUntil: 'domcontentloaded' });
	await app2.waitForTimeout(400);
	await speak(app2, 'ja');

	const send = (cmd, extra) => app2.evaluate(({ extId, cmd, extra }) => new Promise((resolve) => {
		chrome.runtime.sendMessage(extId, Object.assign({ cmd }, extra || {}), (r) =>
			resolve(r || { ok: false, error: chrome.runtime.lastError && chrome.runtime.lastError.message }));
	}), { extId: EXTID, cmd, extra });

	const o = await send('open', { url: SITE + '/login' });
	check('a granted site opens without asking again', !!(o && o.ok), JSON.stringify(o).slice(0, 140));
	await app2.waitForTimeout(2000);
	const st = await send('status');
	check('a login page takes the wheel', !!(st && st.mode === 'user'), JSON.stringify(st).slice(0, 140));
	check('the reason the app prints back is in ja',
		!!(st && st.reason === msg('ja', 'reason_password')),
		JSON.stringify(st && st.reason));

	const tab = b.pages().find((p) => p.url().startsWith(SITE));
	// The host element is all the page can see: the button lives in a CLOSED
	// shadow root, which is the point of it. Reading the label therefore needs
	// the debugger rather than script — `pierce` is the only way in, and that
	// nothing else can do this is the property being relied on.
	let planted = false, label = '';
	if (tab) {
		for (let i = 0; i < 30 && !planted; i++) {
			planted = await tab.evaluate(() =>
				[...document.querySelectorAll('div')].some((d) =>
					d.style.position === 'fixed' && d.style.zIndex === '2147483647')
			).catch(() => false);
			if (!planted) await tab.waitForTimeout(200);
		}
		const leak = await tab.evaluate(() => {
			for (const d of document.querySelectorAll('div')) if (d.shadowRoot) return true;
			return false;
		}).catch(() => false);
		check('the page cannot read the overlay for itself', !leak);
		try {
			const cdp = await tab.context().newCDPSession(tab);
			const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
			// Only what is INSIDE a shadow root counts: the page's own headings
			// are text too, and finding one of those would prove nothing.
			const text = (n) => {
				if (n.nodeName === '#text') return (n.nodeValue || '').trim();
				return (n.children || []).map(text).join('').trim();
			};
			// `closed` only: every <input> on the page carries a user-agent shadow
			// root of its own, and its placeholder is not what is being checked.
			const hunt = (n) => {
				for (const sr of (n.shadowRoots || [])) {
					if (sr.shadowRootType === 'closed') label = label || text(sr);
				}
				for (const c of (n.children || [])) hunt(c);
			};
			hunt(root);
			await cdp.detach().catch(() => {});
		} catch (e) { /* no debugger; the plant check still stands */ }
	}
	check('the resume button is planted in the managed tab', planted);
	check('the resume button is labelled in ja', label === msg('ja', 'resume_button'), JSON.stringify(label));
} finally {
	await b.close().catch(() => {});
	await new Promise((r) => site.close(r));
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
