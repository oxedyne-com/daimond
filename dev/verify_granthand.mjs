// verify_granthand.mjs — the Daimond Hands consent window, rendered.
//
// The window was too long to read at the moment it matters, so it now has two
// screens: what a person needs IN ORDER TO DECIDE on the surface, and
// everything else behind one disclosure. That change can fail in two opposite
// directions, and both are checked here.
//
//   Too long still — the first screen is a wall, or the two buttons are pushed
//   below the fold in the longest language, which is the same failure the split
//   was meant to end.
//
//   Too short — a sentence was DELETED rather than moved. So every string the
//   window said before is looked for in the DOM, wherever it now sits, and the
//   ones that carry the decision (that programs run as you with your files, how
//   far they reach, which folder, which page asked, and that this is the
//   strongest thing Daimond can be allowed) are looked for on the FIRST screen
//   specifically.
//
// Also: the mark, so the window's provenance is visible before its words are
// read; the contrast floors, 4.5:1 for text and 3:1 for the edge of anything
// clickable; and the keyboard, because a window that can only be answered with
// a mouse cannot be answered by everyone.
//
//   node dev/verify_granthand.mjs            the checks
//   node dev/verify_granthand.mjs --prove    each check, against broken output
//
// `--prove` is the point of the file. A check that has never failed is a check
// nobody has tested, so every one of them is run a second time against markup
// or CSS deliberately broken in the one way that check exists to catch, and the
// run fails unless the check FAILS there.
//
// Needs nothing running: it serves ext/ itself and stubs the two chrome APIs
// i18n.js reaches for, so the strings come from _locales exactly as they do in
// the browser.
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');	// this checkout, not one developer's home
const EXT = `${ROOT}/ext`;
const OUT = path.join(os.homedir(), '.cache/daimond/grant-shots');
fs.mkdirSync(OUT, { recursive: true });

const PROVE = process.argv.includes('--prove');
const PORT = Number(process.env.GRANT_PORT || 9187);
const BASE = `http://127.0.0.1:${PORT}`;
/// The viewport the window has AFTER grant.js has sized it to its own first
/// screen -- 520 is what the wordiest language asks for. background.js opens at
/// a guess; `fit()` corrects it, and that correction is checked separately at a
/// height too small for French.
const VH = Number(process.env.GRANT_VH || 520);

/// App locale code -> Chrome `_locales` directory, as i18n.js has it.
const DIRS = {
	'en': 'en', 'de': 'de', 'es': 'es', 'fr': 'fr',
	'ja': 'ja', 'ko': 'ko', 'pt-BR': 'pt_BR', 'zh-Hans': 'zh_CN',
};
const MSG = {};
for (const [code, dir] of Object.entries(DIRS)) {
	MSG[code] = JSON.parse(fs.readFileSync(`${EXT}/_locales/${dir}/messages.json`, 'utf8'));
}
const m = (code, key) => MSG[code][key].message;

/// A hand that fences, keeps a journal, and names its folder — what the window
/// is drawn for on a working Linux machine.
const CAPS = 'fence:linux landlock:abi-8 seccomp journal root:/home/u/work ws:8f3a1c home:/home/u';
const ORIGIN = 'https://daimond.oxedyne.com';

// ── The server ───────────────────────────────────────────────────────
//
// ext/ as it sits on disk, plus whatever a prove-run wants broken. A patch is
// applied to the BYTES on the way out, so the source tree is never touched.
let patch = null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
	const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
	const file = path.join(EXT, rel);
	if (!file.startsWith(EXT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
		res.writeHead(404); res.end('no'); return;
	}
	let body = fs.readFileSync(file);
	if (patch) body = Buffer.from(patch(rel, body.toString('utf8')) ?? body.toString('utf8'));
	res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
	res.end(body);
});
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: CHROME });

/// Open the window, in one language and one palette, with the chrome APIs
/// i18n.js needs stubbed the way the browser would answer them.
async function open(opts) {
	const { kind = 'hand', code = 'en', scheme = 'light', caps = CAPS,
		width = 480, height = VH } = opts || {};
	const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width, height } });
	const page = await ctx.newPage();
	await page.addInitScript(({ code, base }) => {
		globalThis.chrome = {
			runtime: {
				getURL: (p) => base + '/' + p,
				sendMessage: (msgObj, cb) => { globalThis.__answered = msgObj; if (cb) cb(); },
			},
			storage: { local: { get: async () => ({ locale: code }) } },
			i18n: { getMessage: () => '' },
			permissions: { request: async () => true },
			// The window sizes itself to its first screen; record what it asks
			// for. `height` here stands for the outer window, frame included,
			// which is how chrome.windows reports it.
			windows: {
				getCurrent: (cb) => cb({ id: 1, height: innerHeight + 40 }),
				update: (id, o) => { globalThis.__resized = o; },
			},
		};
		globalThis.close = () => { globalThis.__closed = true; };
		// A headless screen is exactly the viewport, so the cap grant.js puts on
		// how tall a window may grow would bite at every size and hide the very
		// behaviour being measured. Give it a real display to work against.
		try { Object.defineProperty(screen, 'availHeight', { value: 1080, configurable: true }); }
		catch (e) { /* whatever the runtime allows */ }
	}, { code, base: BASE });
	const q = new URLSearchParams({ nonce: 'probe', kind, origin: ORIGIN, caps,
		host: 'example.com', pattern: '*://*.example.com/*' });
	await page.goto(`${BASE}/grant.html?${q}`, { waitUntil: 'networkidle' });
	await page.waitForTimeout(200);
	return { ctx, page };
}

// ── Measuring ────────────────────────────────────────────────────────
//
// Run in the page: what is visible above the fold, what the DOM holds anywhere,
// where the buttons are, and every colour actually painted.
const READ = () => {
	const vis = (el) => {
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return false;
		for (let n = el; n; n = n.parentElement) {
			if (n.hidden) return false;
			if (n.tagName === 'DETAILS' && !n.open && !el.closest('summary')) return false;
		}
		return true;
	};
	/// Any computed colour as [r, g, b, a] in 0..255.
	///
	/// `color-mix()` with a system colour computes to `color(srgb 0.22 …)`,
	/// whose components are 0..1 — read as 0..255 they make every mixed colour
	/// near-black and every contrast ratio a lie. This is the bug that made the
	/// first run of this file report 1.01:1 for black text on white.
	const rgb = (s) => {
		const n = (s.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
		const k = /^color\(/.test(s) ? 255 : 1;
		return [n[0] * k, n[1] * k, n[2] * k, n.length > 3 ? n[3] : 1];
	};
	/// What the page paints where nothing else does.
	const canvas = (() => {
		const d = document.createElement('div');
		d.style.background = 'Canvas';
		document.body.appendChild(d);
		const c = rgb(getComputedStyle(d).backgroundColor);
		d.remove();
		return c.slice(0, 3);
	})();
	/// The painted background behind an element: the first ancestor that has one.
	const bgOf = (el) => {
		for (let n = el; n; n = n.parentElement) {
			const c = rgb(getComputedStyle(n).backgroundColor);
			if (c[3] > 0) return c.slice(0, 3);
		}
		return canvas;
	};
	const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
	const lum = (c) => {
		const f = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
		return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
	};
	const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

	const out = { firstScreen: '', allText: document.body.innerText, dom: '', problems: [],
		buttons: [], mark: null, tabbable: [], detailsOpen: false, scrollH: 0, clientH: 0,
		sheetFits: false };
	out.detailsOpen = !!document.querySelector('details').open;
	out.scrollH = document.documentElement.scrollHeight;
	out.clientH = document.documentElement.clientHeight;

	// Everything the DOM holds, whether shown or not.
	out.dom = [...document.querySelectorAll('h1, p, div, summary, button')]
		.map((n) => n.textContent).join('\n');

	// What a person reads before touching anything.
	//
	// WHOLLY visible, and clipped by the SHEET rather than by the window: the
	// sheet scrolls inside itself, so a line an inch below its bottom edge is as
	// unread as one below the window's. Measuring against innerHeight alone
	// reported a first screen that a screenshot showed cut in half.
	const sheet = document.querySelector('.sheet');
	const sr = sheet.getBoundingClientRect();
	out.sheetFits = sheet.scrollHeight <= sheet.clientHeight + 1;
	out.sheetNeeds = sheet.scrollHeight;
	out.sheetHas = sheet.clientHeight;
	const seen = [];
	for (const el of document.querySelectorAll('h1, p, div.host, div.val, summary, button')) {
		if (!vis(el)) continue;
		const r = el.getBoundingClientRect();
		const lo = sheet.contains(el) ? Math.max(0, sr.top) : 0;
		const hi = sheet.contains(el) ? Math.min(sr.bottom, innerHeight) : innerHeight;
		if (r.top < lo - 1 || r.bottom > hi + 1) continue;
		const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
		if (own) seen.push(own);
	}
	out.firstScreen = seen.join('\n');

	// The two buttons, and whether they are on screen at all.
	for (const b of document.querySelectorAll('.row button')) {
		const r = b.getBoundingClientRect();
		out.buttons.push({ id: b.id, top: r.top, bottom: r.bottom, inView: r.top >= 0 && r.bottom <= innerHeight + 0.5 });
	}

	// The mark: it must have actually loaded, not merely be referenced.
	const img = document.querySelector('.brand img');
	out.mark = img ? { src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight } : null;

	// Focus order, by walking it the way a keyboard does. `tabindex="-1"` takes a
	// node OUT of that order however focusable its tag normally is, so it is
	// filtered after the selector rather than in it -- a `summary` term matches
	// a summary that has been taken out, which is precisely the mistake this
	// check exists to catch.
	out.tabbable = [...document.querySelectorAll('button, summary, a[href], [tabindex]')]
		.filter((n) => n.getAttribute('tabindex') !== '-1' && !n.disabled)
		.filter(vis).map((n) => n.id || n.tagName.toLowerCase());

	// Contrast. Text against what is painted behind it, and the border of
	// anything clickable against the same.
	for (const el of document.querySelectorAll('h1, p, div.host, div.val, summary, button, b')) {
		if (!vis(el)) continue;
		const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
		if (!own) continue;
		const cs = getComputedStyle(el);
		const bg = bgOf(el.parentElement || el);
		const fg = over(rgb(cs.color), bgOf(el));
		const r = ratio(fg, bgOf(el));
		if (r < 4.5) out.problems.push(`text ${r.toFixed(2)}:1 — ${JSON.stringify(own.slice(0, 40))}`);
		void bg;
	}
	for (const el of document.querySelectorAll('button, div.host, div.val')) {
		if (!vis(el)) continue;
		const cs = getComputedStyle(el);
		if (cs.borderTopStyle === 'none' || parseFloat(cs.borderTopWidth) < 0.5) continue;
		const edge = over(rgb(cs.borderTopColor), bgOf(el.parentElement || el));
		const r = ratio(edge, bgOf(el.parentElement || el));
		if (r < 3) out.problems.push(`edge ${r.toFixed(2)}:1 — <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>`);
	}
	return out;
};

// ── The checks ───────────────────────────────────────────────────────
//
// Each one is a named function of the measurement, returning [pass, detail], so
// the same function can be run against sound output and against broken output.

/// Sentences that must be readable BEFORE the disclosure is opened. Each is
/// here because a person cannot answer the question without it.
const MUST_SURFACE = (code) => [
	['what is being asked',	m(code, 'grant_hand_head')],
	['how far it reaches',	m(code, 'grant_hand_lead')],
	['how much it weighs',	m(code, 'grant_hand_strongest')],
	['which page asked',	ORIGIN],
	['which folder',	'/home/u/work'],
	['the way out',		m(code, 'grant_deny')],
	['the way in',		m(code, 'grant_hand_allow')],
];

/// Everything the window said before the split. None of it may be gone; it may
/// only have moved.
const MUST_KEEP = (code) => [
	m(code, 'grant_hand_body'),
	m(code, 'grant_hand_fine'),
	m(code, 'grant_hand_strongest'),
	m(code, 'grant_hand_head'),
	m(code, 'grant_hand_allow'),
	m(code, 'grant_deny'),
];

const CHECKS = {
	'the mark is there, and really loaded':
		(r) => [!!r.mark && r.mark.w > 0 && r.mark.h > 0,
			JSON.stringify(r.mark)],

	'the first screen carries every fact the decision needs':
		(r, code) => {
			const miss = MUST_SURFACE(code).filter(([, s]) => !r.firstScreen.includes(s));
			return [miss.length === 0, miss.map(([w]) => w).join(', ')];
		},

	'nothing that was said has been dropped, only moved':
		(r, code) => {
			const gone = MUST_KEEP(code).filter((s) => !r.dom.includes(s));
			return [gone.length === 0, gone.map((s) => JSON.stringify(s.slice(0, 40))).join(', ')];
		},

	'the long prose is behind the disclosure, not on the first screen':
		(r, code) => {
			const leaked = [m(code, 'grant_hand_body'), m(code, 'grant_hand_fine')]
				.filter((s) => r.firstScreen.includes(s));
			return [leaked.length === 0, `${leaked.length} leaked`];
		},

	// A guard against creep rather than a design target: the real constraint is
	// the one below, which is measured rather than counted. 85 is French, the
	// wordiest of the eight, plus a little.
	'the first screen is short enough to read':
		(r) => {
			const n = r.firstScreen.replace(/\s+/g, ' ').trim().split(' ').length;
			return [n <= 85, `${n} words`];
		},

	// The sharper form of the same thing: it does not merely fit a word budget,
	// it fits the window, so nothing on it has to be scrolled to.
	'the first screen fits the window without scrolling':
		(r) => [r.sheetFits, `needs ${r.sheetNeeds}px, has ${r.sheetHas}px`],

	// The document itself must never scroll: only the sheet between the brand
	// and the buttons does. Without that clause the check is toothless, because
	// focusing the cautious button scrolls it into view and the buttons look
	// fine while the question they answer has gone off the top.
	'both buttons are on screen, and the window itself never scrolls':
		(r) => [r.buttons.length === 2 && r.buttons.every((b) => b.inView)
				&& r.scrollH <= r.clientH + 1,
			`${JSON.stringify(r.buttons)} scroll ${r.scrollH}/${r.clientH}`],

	'the disclosure is in the keyboard\'s path, before the buttons':
		(r) => {
			const i = r.tabbable.indexOf('more-sum'), d = r.tabbable.indexOf('deny');
			return [i >= 0 && d > i, r.tabbable.join(' > ')];
		},

	'every visible run clears the contrast floors':
		(r) => [r.problems.length === 0, r.problems.join('; ')],
};

// ── Running them ─────────────────────────────────────────────────────
let bad = 0, ran = 0;
const say = (ok, what, detail) => {
	ran++;
	if (!ok) bad++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`);
};

async function measure(opts) {
	const { ctx, page } = await open(opts);
	const r = await page.evaluate(READ);
	return { r, ctx, page };
}

if (!PROVE) {
	// The window as it ships: both palettes, the narrow height a popup really
	// gets, and every language — German and Japanese are the ones that overrun.
	for (const scheme of ['light', 'dark']) {
		for (const code of Object.keys(DIRS)) {
			const { r, ctx, page } = await measure({ code, scheme });
			for (const [name, fn] of Object.entries(CHECKS)) {
				const [ok, detail] = fn(r, code);
				say(ok, `${scheme} ${code}: ${name}`, ok ? '' : detail);
			}
			if (['en', 'de', 'fr', 'ja'].includes(code)) {
				await page.screenshot({ path: path.join(OUT, `hand-${scheme}-${code}-closed.png`) });
				// Opened with the keyboard, which is also the check that the
				// keyboard can open it.
				await page.focus('#more-sum');
				await page.keyboard.press('Enter');
				await page.waitForTimeout(120);
				const open2 = await page.evaluate(READ);
				say(open2.detailsOpen, `${scheme} ${code}: Enter on the disclosure opens it`);
				say(open2.buttons.every((b) => b.inView) && open2.scrollH <= open2.clientH + 1,
					`${scheme} ${code}: the buttons stay on screen with it open`,
					`${JSON.stringify(open2.buttons)} scroll ${open2.scrollH}/${open2.clientH}`);
				say(open2.problems.length === 0,
					`${scheme} ${code}: the detail clears the contrast floors too`, open2.problems.join('; '));
				await page.screenshot({ path: path.join(OUT, `hand-${scheme}-${code}-open.png`) });
			}
			await ctx.close();
		}
	}

	// The other two questions still work, and the mirror one still names no site.
	for (const kind of ['site', 'mirror']) {
		const { r, ctx, page } = await measure({ kind });
		say(r.buttons.every((b) => b.inView), `${kind}: both buttons are on screen`, JSON.stringify(r.buttons));
		say(r.problems.length === 0, `${kind}: contrast floors`, r.problems.join('; '));
		say(r.dom.includes(m('en', kind === 'site' ? 'grant_site_fine' : 'grant_mirror_fine')),
			`${kind}: the fine print is still in the window`);
		if (kind === 'mirror') {
			const named = await page.evaluate(() => !document.getElementById('host').hidden);
			say(!named, 'mirror: the live-view question still names no site');
		}
		await page.screenshot({ path: path.join(OUT, `${kind}-light-en.png`) });
		await ctx.close();
	}

	// A narrow window, because a popup can be dragged narrow and the strings do
	// not get shorter.
	{
		const { r, ctx } = await measure({ width: 360 });
		say(r.buttons.every((b) => b.inView), '360px wide: both buttons are on screen', JSON.stringify(r.buttons));
		say(r.problems.length === 0, '360px wide: contrast floors', r.problems.join('; '));
		await ctx.close();
	}

	// The window sizing itself. At a height French does not fit in, it must ASK
	// for more -- otherwise the whole first-screen promise rests on a constant in
	// background.js being right about a frame nobody measured.
	{
		const { ctx, page } = await open({ code: 'fr', height: 420 });
		const asked = await page.evaluate(() => globalThis.__resized || null);
		say(!!asked && asked.height > 460, 'a first screen that does not fit asks for a taller window',
			JSON.stringify(asked));
		await ctx.close();
	}
	{
		const { ctx, page } = await open({ code: 'zh-Hans', height: 700 });
		const asked = await page.evaluate(() => globalThis.__resized || null);
		say(!!asked && asked.height < 700, 'and one with room to spare gives it back',
			JSON.stringify(asked));
		await ctx.close();
	}

	// A short window, which is what a small screen leaves after grant.js has
	// asked for all the height there is. The first screen has to give way here
	// -- but it gives way by SCROLLING THE SHEET, with the brand still naming
	// who is asking and both buttons still on screen. Degrading any other way
	// would put the answer out of reach on exactly the machines least able to
	// spare the room.
	{
		const { r, ctx } = await measure({ code: 'fr', height: 360 });
		say(r.buttons.every((b) => b.inView) && r.scrollH <= r.clientH + 1,
			'360px tall: the window still does not scroll and both buttons are on screen',
			`${JSON.stringify(r.buttons)} scroll ${r.scrollH}/${r.clientH}`);
		say(r.firstScreen.includes(m('fr', 'grant_hand_head')),
			'360px tall: the question itself is still the first thing shown');
		await ctx.close();
	}

	// Release gate 1 of hand/README.md, which dev/verify_hand.mjs reads off the
	// same three elements: the wording is chosen from `caps`, so it can only
	// claim what THIS machine enforces. Moving those three behind the disclosure
	// must not have moved the gate.
	{
		const say3 = async (caps) => {
			const { ctx, page } = await open({ caps });
			const got = await page.evaluate(() => ({
				body:  (document.getElementById('body') || {}).textContent || '',
				fine:  (document.getElementById('fine') || {}).textContent || '',
				scope: (document.getElementById('scope') || {}).textContent || '',
				lead:  (document.getElementById('lead') || {}).textContent || '',
			}));
			await ctx.close();
			return got;
		};
		const none   = await say3('fence:none');
		const real   = await say3('fence:linux landlock:abi-8 journal root:/home/u/work');
		const silent = await say3('');
		say(!/folders the workspace/.test(none.body) && /cannot limit which files/.test(none.body),
			'a fenceless machine is not described as fencing anything', none.body);
		say(/folders the workspace/.test(real.body),
			'a machine that fences gets the sentence about folders', real.body);
		say(none.body !== real.body, 'the two are not the same words');
		say(/journal/i.test(real.fine) && !/journal/i.test(none.fine),
			'a hand that keeps a journal is the only one that promises one');
		say(/landlock:abi-8/.test(real.scope) && /fence:none/.test(none.scope),
			'what the machine can enforce is still shown verbatim');
		say(/did not say/.test(silent.scope) && /did not say/.test(silent.body),
			'a hand that said nothing is a third answer, not a promise');
		// And the same three answers on the FIRST screen, in one line each.
		say(/cannot limit which files/.test(none.lead) && /can hold them to one folder/.test(real.lead)
			&& /did not say/.test(silent.lead),
			'the first screen carries the same three answers, not a fourth', JSON.stringify(silent.lead));
	}

	// The mark in ext/ is the app's own, not a redrawing of it.
	{
		const a = fs.readFileSync(`${ROOT}/www/assets/daimond_mark.svg`);
		const b = fs.readFileSync(`${EXT}/daimond_mark.svg`);
		say(a.equals(b), 'the mark in ext/ is byte-identical to the app\'s', `${b.length} bytes`);
	}
} else {
	// ── Proving the checks ───────────────────────────────────────
	//
	// One breakage per check, chosen to be exactly what that check is for. The
	// check must FAIL. A check that passes here is decoration.
	const BREAK = {
		'the mark is there, and really loaded':
			(rel, s) => rel === 'grant.html' ? s.replace('src="daimond_mark.svg"', 'src="nope.svg"') : s,

		'the first screen carries every fact the decision needs':
			(rel, s) => rel === 'grant.js'
				? s.replace("$('strongest').hidden\t\t= false;", "$('strongest').hidden\t\t= true;") : s,

		'nothing that was said has been dropped, only moved':
			(rel, s) => rel === 'grant.js'
				? s.replace(/\$\('fine'\)\.textContent\t= journalled\(\)[^;]*;/, "$('fine').textContent = '';") : s,

		'the long prose is behind the disclosure, not on the first screen':
			(rel, s) => rel === 'grant.js' ? s.replace('conceal($(\'body\'), $(\'scope\'));', '') : s,

		'the first screen is short enough to read':
			(rel, s) => rel === 'grant.js' ? s.replace('conceal($(\'body\'), $(\'scope\'));', '') : s,

		// The pinned row is what keeps the buttons reachable once the detail is
		// open, so the breakage is exactly that: ordinary block flow, detail
		// open, and the row slides off the bottom.
		'both buttons are on screen, and the window itself never scrolls':
			(rel, s) => rel === 'grant.html'
				? s.replace('flex-direction:\tcolumn;', 'flex-direction:\tcolumn; display: block;')
					.replace('<details id="more">', '<details id="more" open>') : s,

		'the disclosure is in the keyboard\'s path, before the buttons':
			(rel, s) => rel === 'grant.html'
				? s.replace('<summary id="more-sum"', '<summary tabindex="-1" id="more-sum"') : s,

		'the first screen fits the window without scrolling':
			(rel, s) => rel === 'grant.html'
				? s.replace('padding:\t16px 20px 14px;', 'padding: 16px 20px 220px;') : s,

		'every visible run clears the contrast floors':
			(rel, s) => rel === 'grant.html'
				? s.replace('--dim:\tcolor-mix(in srgb, CanvasText 78%, Canvas);',
					'--dim:\tcolor-mix(in srgb, CanvasText 28%, Canvas);') : s,
	};

	/// A breakage that changes nothing proves nothing, and a stale search string
	/// is silent about it -- which is how both of the first two written here got
	/// past their own proof. So the patch must be seen to bite.
	let bit = false;
	for (const [name, fn] of Object.entries(CHECKS)) {
		const breaker = BREAK[name];
		if (!breaker) { say(false, `${name}: has a breakage to prove it`, 'none written'); continue; }
		bit = false;
		patch = (rel, s) => { const o = breaker(rel, s); if (o !== s) bit = true; return o; };
		const { r, ctx } = await measure({ code: 'en', scheme: 'light' });
		const [ok, detail] = fn(r, 'en');
		say(bit, `the breakage for "${name}" actually bit`, bit ? '' : 'the patch matched nothing');
		say(!ok, `broken on purpose: "${name}" catches it`, ok ? 'it PASSED on broken output' : `(said: ${detail})`);
		await ctx.close();
		patch = null;
	}
	// The window sizing itself, proved the same way: with the call taken out, a
	// first screen that does not fit must go unnoticed.
	{
		patch = (rel, str) => rel === 'grant.js' ? str.replace(/^\t\tfit\(\);$/m, '') : str;
		const { ctx, page } = await open({ code: 'fr', height: 420 });
		const asked = await page.evaluate(() => globalThis.__resized || null);
		say(!asked, 'broken on purpose: "a first screen that does not fit asks for a taller window" catches it',
			asked ? 'it still asked' : '');
		await ctx.close();
		patch = null;
	}

	// The one check with no page behind it.
	{
		const a = fs.readFileSync(`${ROOT}/www/assets/daimond_mark.svg`);
		const b = Buffer.from(fs.readFileSync(`${EXT}/daimond_mark.svg`).toString('utf8') + '<!--x-->');
		say(!a.equals(b), 'broken on purpose: "the mark in ext/ is byte-identical" catches it');
	}
}

await browser.close();
await new Promise((r) => srv.close(r));
console.log(`\n${ran} checks, ${bad ? bad + ' FAILED' : 'all good'} — shots in ${OUT}`);
process.exit(bad ? 1 : 0);
