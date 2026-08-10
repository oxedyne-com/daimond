// verify_guidesearch.mjs — the guide's search box, driven rather than read.
//
// notes2.txt line 96: "Maybe we should have a search box in the help guide?"
// and, later, "some users will choose to burn tokens on Daimond Help but a
// search facility in the guide is a fallback. It has to be of decent quality."
// Decent quality is the thing under test here, so this file does not check that
// a box exists — it checks that the box ANSWERS.
//
// WHAT IS LOCKED DOWN.
//
//  A. THE INDEX IS CURRENT. `node dev/guide-index.mjs --check` exits 0. A stale
//     index is worse than none: it answers confidently about a page that has
//     changed underneath it.
//  B. Every section the index names can actually be jumped to — the anchor
//     exists in the page it claims, in every locale.
//  C. Searching finds the right page: a set of question-and-expected-page pairs
//     written from what a reader would actually type.
//  D. Every term must be present. A two-word query does not return everything
//     matching either word.
//  E. Ranking puts a heading match above a passing mention.
//  F. The keyboard works: `/` focuses, arrows move a highlight, Enter goes,
//     Escape closes. And the highlight is announced (aria-activedescendant).
//  G. It works in a locale that is not English and has no spaces between words
//     — Japanese, where splitting a query on whitespace finds nothing.
//  H. Nothing found says so, rather than showing an empty box.
//  I. It works inside a SANDBOXED frame with no allow-same-origin, which is how
//     the guide is really served. This is the one that decides the design: an
//     opaque origin cannot fetch its own index, so it must arrive as a script.
//  J. Every local URL any guide page names is a file that is on the disk, in
//     every locale. A 404 in the guide is silent: the page still renders, and a
//     missing `search.js` simply means no search box. It is the CLASS that
//     matters, not search alone — the translated pages sit a folder deeper than
//     the English source they are generated from, so any URL the generator
//     forgets to reroot points at nothing, and the last two that did were the
//     screenshots and `search.js`.
//
// PROVED RED: `--break <what>` neuters one property in the page before it runs
// and requires the matching check to notice. `all` runs each in turn.
//
//   node dev/verify_guidesearch.mjs
//   node dev/verify_guidesearch.mjs --break all
//   node dev/verify_guidesearch.mjs --static   # A, B and J only; no browser
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no model.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, APP } from './harness.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');
const GUIDE = path.join(ROOT, 'www', 'guide');

const BREAK = (process.argv.find((a) => a.startsWith('--break')) || '').split('=')[1]
	|| (process.argv.includes('--break') ? process.argv[process.argv.indexOf('--break') + 1] : null);
// The checks that only read the built files need no browser and no server, so
// they can be run on their own -- straight after a guide build, which is where
// the mistakes they catch are made.
const STATIC = process.argv.includes('--static');

const out = [];
let bad = 0;
const check = (ok, what, detail) => {
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail != null ? ' — ' + detail : ''}`);
	if (!ok) bad++;
	return ok;
};

// ── A. The index is current ─────────────────────────────────────────
{
	let ok = true, why = '';
	try {
		execFileSync('node', [path.join(HERE, 'guide-index.mjs'), '--check'],
			{ cwd: ROOT, stdio: 'pipe' });
	} catch (e) {
		ok = false;
		why = String(e.stdout || e.message).split('\n').filter(Boolean).slice(-3).join(' | ');
	}
	check(ok, 'the search index is current — no guide page has changed under it', why || null);
}

// ── B. Every anchor the index names exists ──────────────────────────
{
	const locales = ['.'].concat(fs.readdirSync(GUIDE, { withFileTypes: true })
		.filter((e) => e.isDirectory() && /^[a-z]{2}(-[A-Za-z]+)?$/.test(e.name))
		.map((e) => e.name));
	let sections = 0, missing = [];
	for (const loc of locales) {
		const dir = loc === '.' ? GUIDE : path.join(GUIDE, loc);
		const ixf = path.join(dir, 'search-index.js');
		if (!fs.existsSync(ixf)) { missing.push(`${loc}: no index`); continue; }
		const g = {};
		// eslint-disable-next-line no-new-func
		new Function('window', fs.readFileSync(ixf, 'utf8'))(g);
		const ix = g.GUIDE_INDEX;
		const pages = new Map();
		for (const s of ix.sections) {
			sections++;
			if (!s.a) continue;
			if (!pages.has(s.p)) {
				const pf = path.join(dir, s.p);
				pages.set(s.p, fs.existsSync(pf) ? fs.readFileSync(pf, 'utf8') : null);
			}
			const html = pages.get(s.p);
			if (html == null) { missing.push(`${loc}/${s.p}: no such page`); continue; }
			if (!html.includes(`id="${s.a}"`)) missing.push(`${loc}/${s.p}#${s.a}`);
		}
	}
	check(sections > 500, `the index covers every locale (${sections} sections across ${locales.length})`);
	check(missing.length === 0, 'every section it names can be jumped to',
		missing.length ? `${missing.length} cannot, e.g. ${missing.slice(0, 3).join(', ')}` : null);
}

// ── J. Every local URL a page names is a file that is there ─────────
//
// Cheap, whole-corpus, and no browser: for every generated page in every
// locale, resolve each of its own relative URLs against the folder that page
// actually sits in, and require the file to exist.
//
// This is the check the guide had been missing. The translated pages are
// generated from the English ones and land a folder deeper, so a URL written
// as `shots/x.png` or `search.js` -- correct at the root, and looking correct
// everywhere -- resolves inside the locale folder, where nothing is. Both of
// those shipped. Neither showed: a missing screenshot is a gap in a page
// nobody reads in Korean, and a missing `search.js` is just no search box.
{
	/// Every .html under the guide, root and locale folders alike.
	const files = [];
	const collect = (dir) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) collect(path.join(dir, e.name));
			else if (e.name.endsWith('.html')) files.push(path.join(dir, e.name));
		}
	};
	collect(GUIDE);

	const dead = [];
	let urls = 0;
	for (const f of files) {
		const html = fs.readFileSync(f, 'utf8');
		for (const m of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
			const raw = m[1];
			// An anchor, a root-relative path the dev server owns, or anything
			// with a scheme is somebody else's business.
			if (!raw || /^(#|\/|[a-z][a-z0-9+.-]*:)/i.test(raw)) continue;
			const rel = decodeURIComponent(raw.split('#')[0].split('?')[0]);
			if (!rel) continue;
			urls++;
			const target = path.resolve(path.dirname(f), rel);
			if (!fs.existsSync(target)) {
				dead.push(`${path.relative(GUIDE, f)} -> ${raw}`);
			}
		}
	}
	check(dead.length === 0,
		`every local URL in the guide resolves to a file that is there (${urls} across ${files.length} pages)`,
		dead.length ? `${dead.length} do not: ${[...new Set(dead)].slice(0, 6).join(', ')}` : null);
}

if (STATIC) {
	console.log(out.join('\n'));
	const n = out.filter((l) => /^(PASS|FAIL)/.test(l)).length;
	console.log(bad === 0 ? `\nALL ${n} STATIC CHECKS PASSED` : `\n${bad} of ${n} FAILED`);
	process.exit(bad === 0 ? 0 : 1);
}

// ── The browser ─────────────────────────────────────────────────────
const s = await open({ name: 'guidesearch', signIn: false, connect: false });
const p = s.page;

/// Load a guide page, optionally with one property broken before it runs.
async function load(url) {
	if (BREAK) {
		await p.route('**/guide/**/search.js', async (route) => {
			const res = await route.fetch();
			let body = await res.text();
			if (BREAK === 'everyterm' || BREAK === 'all') {
				// Any term will do, instead of all of them: the classic bad search.
				body = body.replace('if (!inT && !inU && !inB) return null;',
					'if (!inT && !inU && !inB) { total += 0; continue; } /* BROKEN */');
			}
			if (BREAK === 'rank' || BREAK === 'all') {
				// A heading match scores no more than a body mention.
				body = body.replace(/best = Math\.max\(best, 100 \+[^;]+;/,
					'best = Math.max(best, 30); /* BROKEN */');
			}
			if (BREAK === 'keys' || BREAK === 'all') {
				body = body.replace("if (e.key === 'ArrowDown')", "if (false)");
			}
			if (BREAK === 'cjk' || BREAK === 'all') {
				// Split on whitespace only, which finds nothing in ja/ko/zh.
				body = body.replace('var CJK = /[\\u3040-\\u30ff', 'var CJK = /[\\uE000-\\uE001');
			}
			if (BREAK === 'none' || BREAK === 'all') {
				body = body.replace("none.textContent = W.no || 'Nothing found';", "none.textContent = '';");
			}
			await route.fulfill({ response: res, body,
				headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
		});
	}
	await p.goto(url, { waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(500);
}

/// Type a query and read what comes back.
async function ask(q) {
	await p.fill('#guide-search', '');
	await p.fill('#guide-search', q);
	await p.waitForTimeout(220);
	return p.evaluate(() => {
		const panel = document.getElementById('guide-search-results');
		return {
			open: panel && !panel.hidden,
			none: !!panel.querySelector('.gsearch-none'),
			noneText: (panel.querySelector('.gsearch-none') || {}).textContent || '',
			live: (document.querySelector('.gsearch-live') || {}).textContent || '',
			hits: [...panel.querySelectorAll('.gsearch-hit')].map((a) => ({
				href: a.getAttribute('href'),
				title: (a.querySelector('.gsearch-t') || {}).textContent || '',
				marks: [...a.querySelectorAll('mark')].map((m) => m.textContent),
				snippet: (a.querySelector('.gsearch-b') || {}).textContent || '',
			})),
		};
	});
}

await load(`${APP}/guide/index.html`);

check(await p.$('#guide-search') !== null, 'there is a search box in the guide header');

// ── C. It finds the right page ──────────────────────────────────────
//
// Written from what a reader would type, not from the headings — a query
// copied out of a heading proves only that the string is in the file.
// Each of these was checked against the corpus before being written down. The
// first draft of this list was invented from what a reader might type and three
// of six asked for words the guide does not contain -- which proved nothing
// about the search and everything about writing expectations without looking.
const ASKS = [
	['passphrase',     'accounts.html'],
	['passkey',        'accounts.html'],
	['pause spending', 'spending.html'],
	['crystal',        'chats-and-diamonds.html'],
	['mailbox',        'email-web-files.html'],
	['credits',        'models.html'],
];

// THE ALIASES, which are the answer to that finding rather than a way round it.
// A reader searching a help guide does not know its vocabulary -- that is why
// they are searching. The guide says "passphrase" and never "password"; it
// explains bringing your own key and never writes "BYOK". Each of these is a
// word the guide does NOT contain, and must still land.
const ALIAS_ASKS = [
	['password', 'accounts.html'],
	['byok',     'models.html'],
	['cost',     'spending.html'],
];
{
	const misses = [];
	for (const [q, want] of ASKS) {
		const r = await ask(q);
		const top3 = r.hits.slice(0, 3).map((h) => (h.href || '').split('#')[0]);
		if (!top3.includes(want)) misses.push(`${q} -> ${top3.join(',') || 'nothing'} (want ${want})`);
	}
	check(misses.length === 0, `a reader's own words reach the right page (${ASKS.length} queries)`,
		misses.length ? misses.join(' | ') : null);
}
{
	const misses = [];
	for (const [q, want] of ALIAS_ASKS) {
		const r = await ask(q);
		const top3 = r.hits.slice(0, 3).map((h) => (h.href || '').split('#')[0]);
		if (!top3.includes(want)) misses.push(`${q} -> ${top3.join(',') || 'nothing'} (want ${want})`);
	}
	check(misses.length === 0,
		`a word the guide never uses still lands, through an alias (${ALIAS_ASKS.length} queries)`,
		misses.length ? misses.join(' | ') : null);
	// And an alias never beats the real word: "passphrase" typed directly must
	// still answer with a passphrase section, not with whatever "password"
	// happens to reach.
	const direct = await ask('passphrase');
	check(/passphrase/i.test((direct.hits[0] || {}).title || ''),
		'and a direct hit still outranks an aliased one',
		JSON.stringify((direct.hits[0] || {}).title));
}

// ── D. Every term must be present ───────────────────────────────────
{
	const one  = await ask('passphrase');
	const two  = await ask('passphrase kangaroo');
	check(one.hits.length > 0, 'a one-word query finds sections', `${one.hits.length}`);
	check(two.hits.length === 0,
		'adding a word that appears NOWHERE returns nothing — every term must be present',
		`${two.hits.length} hit(s): ${two.hits.slice(0, 2).map((h) => h.title).join(', ')}`);
	// And the honest version of the same property: a second word that DOES
	// appear narrows rather than widens.
	const wide   = await ask('sync');
	const narrow = await ask('sync passkey');
	check(narrow.hits.length > 0 && narrow.hits.length <= wide.hits.length,
		'a second real word narrows the answer rather than widening it',
		`sync ${wide.hits.length} -> sync passkey ${narrow.hits.length}`);
}

// ── E. A heading beats a passing mention ────────────────────────────
{
	const r = await ask('passkey');
	const first = r.hits[0] || {};
	check(/passkey/i.test(first.title || ''),
		'the top answer is a section ABOUT the word, not one that merely says it',
		JSON.stringify((r.hits.slice(0, 3)).map((h) => h.title)));
	check((first.marks || []).length > 0,
		'and the match is marked in what is shown', JSON.stringify(first.marks));
	check(!!(first.snippet || '').trim(),
		'with the sentence it was found in', JSON.stringify((first.snippet || '').slice(0, 60)));
}

// ── H. Nothing found says so ────────────────────────────────────────
{
	const r = await ask('zzzqqxwv');
	check(r.open && r.none && r.noneText.trim().length > 0,
		'a query that matches nothing says so, rather than showing an empty box',
		JSON.stringify(r.noneText));
	check(/\d|[^\s]/.test(r.live), 'and the count is announced', JSON.stringify(r.live));
}

// ── F. The keyboard ─────────────────────────────────────────────────
{
	await p.evaluate(() => document.getElementById('guide-search').blur());
	await p.keyboard.press('/');
	await p.waitForTimeout(150);
	const focused = await p.evaluate(() => document.activeElement && document.activeElement.id);
	check(focused === 'guide-search', '`/` from the page focuses the box', String(focused));

	await p.fill('#guide-search', 'passkey');
	await p.waitForTimeout(220);
	await p.keyboard.press('ArrowDown');
	await p.keyboard.press('ArrowDown');
	const nav = await p.evaluate(() => {
		const on = document.querySelectorAll('.gsearch-hit.on');
		const inp = document.getElementById('guide-search');
		return {
			lit: on.length,
			which: on[0] ? on[0].id : null,
			active: inp.getAttribute('aria-activedescendant'),
			expanded: inp.getAttribute('aria-expanded'),
		};
	});
	check(nav.lit === 1 && nav.which === 'gsearch-hit-1',
		'the arrows move exactly one highlight', JSON.stringify(nav));
	check(nav.active === nav.which,
		'and a screen reader is told which row it is on', JSON.stringify(nav.active));
	check(nav.expanded === 'true', 'the box says its list is open');

	const href = await p.evaluate(() => {
		var el = document.querySelector('.gsearch-hit.on') || document.querySelector('.gsearch-hit');
		return el ? el.getAttribute('href') : null;
	});
	check(!!href, 'there is a highlighted answer to press Enter on', String(href));
	if (!href) { console.log(out.join('\n')); await s.close(); process.exit(1); }
	await p.keyboard.press('Enter');
	await p.waitForTimeout(700);
	const landed = await p.evaluate(() => ({
		url: location.pathname.split('/').pop() + location.hash,
		flashed: !!document.querySelector('.gsearch-landed'),
		heading: (document.querySelector('.gsearch-landed') || {}).textContent || '',
	}));
	check(landed.url === href, 'Enter goes to the highlighted answer', `${landed.url} vs ${href}`);
	check(landed.flashed, 'and the section it landed on is marked, so the eye has somewhere to go',
		JSON.stringify(landed.heading.slice(0, 40)));

	// Escape closes without navigating.
	await p.fill('#guide-search', 'sync');
	await p.waitForTimeout(220);
	await p.keyboard.press('Escape');
	const closed = await p.evaluate(() => document.getElementById('guide-search-results').hidden);
	check(closed, 'Escape closes the list');
}

// ── G. A locale with no spaces between words ────────────────────────
{
	await load(`${APP}/guide/ja/index.html`);
	const box = await p.$('#guide-search');
	check(box !== null, 'the Japanese guide has the box too');
	const ph = await p.evaluate(() => document.getElementById('guide-search').placeholder);
	check(/[぀-ヿ㐀-䶿一-鿿]/.test(ph), 'in Japanese', JSON.stringify(ph));
	const r = await ask('パスキー');
	check(r.hits.length > 0,
		'and a Japanese query finds something — a whitespace split would find nothing here',
		`${r.hits.length} hit(s): ${r.hits.slice(0, 2).map((h) => h.title).join(' | ')}`);
	const inJa = r.hits.every((h) => !/^\.\.\//.test(h.href || ''));
	check(inJa, 'and its answers stay inside the Japanese guide',
		JSON.stringify(r.hits.slice(0, 2).map((h) => h.href)));
}

// ── I. Inside a sandboxed frame, which is how it is really served ───
{
	await p.goto(`${APP}/guide/index.html`, { waitUntil: 'domcontentloaded' });
	const framed = await p.evaluate(async (app) => {
		const f = document.createElement('iframe');
		// The app's own sandbox, from the Web panel: no allow-same-origin, so
		// the frame has an OPAQUE origin and cannot fetch its own index.
		f.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms');
		f.src = app + '/guide/index.html';
		f.style.cssText = 'width:900px;height:600px';
		document.body.appendChild(f);
		await new Promise((r) => { f.onload = r; setTimeout(r, 6000); });
		await new Promise((r) => setTimeout(r, 800));
		// Nothing can be read out of an opaque frame from here, so the frame is
		// asked to report on itself the only way it can: it cannot. What CAN be
		// checked from outside is that it loaded and did not throw — and the
		// index being a <script> is what makes that true, so the real evidence
		// is the console, collected by the harness.
		return { loaded: true };
	}, APP);
	await p.waitForTimeout(500);
	const sandboxErrs = s.errs.filter((e) =>
		/GUIDE_INDEX|search-index|Failed to fetch|CORS|Access to fetch/i.test(e));
	check(framed.loaded && sandboxErrs.length === 0,
		'the guide loads its index inside a sandbox with no allow-same-origin',
		sandboxErrs.length ? JSON.stringify(sandboxErrs.slice(0, 2)) : 'no index or CORS errors');
}

const noise = /favicon|401|402|502|Unauthorized|Payment|Bad Gateway/i;
const errs = s.errs.filter((e) => !noise.test(e));
check(errs.length === 0, 'no console errors', JSON.stringify(errs.slice(0, 3)));

await s.close();

console.log(out.join('\n'));
const total = out.filter((l) => /^(PASS|FAIL)/.test(l)).length;
if (BREAK) {
	console.log(`\nBROKEN RUN (${BREAK}): ${bad} of ${total} checks failed. `
		+ (bad > 0 ? 'Good — the checks see it.' : 'BAD — a check that cannot fail is not evidence.'));
	process.exit(bad > 0 ? 0 : 1);
}
console.log(bad === 0 ? `\nALL ${total} CHECKS PASSED` : `\n${bad} of ${total} FAILED`);
process.exit(bad === 0 ? 0 : 1);
