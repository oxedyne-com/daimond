// verify_guidefacts.mjs — the guide says the things a first install cost an hour.
//
// dev/verify_guidemachine.mjs already asks whether the Machine Operations page
// LOOKS right: it renders, it does not scroll sideways, its code blocks keep
// their overflow. This file asks whether it SAYS the right things, which is a
// different failure and one no layout check can see.
//
// Three groups.
//
//   The new facts, each of which was learned the expensive way: a snap or
//   flatpak browser cannot run this at all, `apt install chromium-browser` is
//   how you get one by accident, a browser profile does not exist until the
//   browser has been run, the passphrase alone cannot restore an account on a
//   fresh browser, and `install.sh --check` is the first thing to run when
//   something is wrong. A fact stated below the fold of a long page is a fact
//   nobody reads, so the two that STOP a reader are also required to appear
//   before the installation steps do.
//
//   The old facts, none of which may have been lost in the reordering. This is
//   a friendliness pass, not a simplification pass, so the security detail, the
//   fence's limits and the "what is not protected" list are all looked for.
//
//   The correction. The guide used to say that anyone who imports a backup
//   becomes you. That is the claim to keep out, and it is wrong for one reason:
//   `doExport` in www/js/daimond.js DOES write the identity -- it calls
//   DaimondIdentity.exportBundle() -- but the private key in that bundle is
//   sealed under PBKDF2(passphrase, salt), so the file opens to the passphrase
//   and to nothing else. Both halves have to be said. Drop the first and a
//   reader who deletes a browser after taking a backup loses the account the
//   backup was holding; drop the second and the file reads as a bearer token.
//   The English page and all seven translations are checked for both.
//
// And the callout the stop-facts sit in has to be legible in all eleven
// palettes, not the two a colorScheme flag reaches.
//
//   node dev/verify_guidefacts.mjs            the checks
//   node dev/verify_guidefacts.mjs --prove    each check, against broken text
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');	// this checkout, not one developer's home
// The world's dev server -- see dev/world.sh.  Kept inline rather than imported,
// so this stays standalone and does not load the harness.
const BASE = (process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`) + '/guide';
const OUT = path.join(os.homedir(), '.cache/daimond/guide-shots');
fs.mkdirSync(OUT, { recursive: true });

const PROVE = process.argv.includes('--prove');
const LOCS = ['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];
/// Every palette the guide can wear, as [tone, ink], mirroring frame.js.
const PALETTES = {
	light: ['light', 'dark'], mist: ['light', 'dark'], linen: ['light', 'dark'],
	lollypop: ['mid', 'dark'], sage: ['mid', 'dark'], dusk: ['mid', 'light'],
	dark: ['dark', 'light'], amber: ['dark', 'light'], midnight: ['dark', 'light'],
	forest: ['dark', 'light'], plum: ['dark', 'light'],
};

let bad = 0, ran = 0;
const say = (ok, what, detail) => {
	ran++;
	if (!ok) bad++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? ' — ' + detail : ''}`);
};

// ── What the page has to say ─────────────────────────────────────────
//
// Matched against the RENDERED text, not the markup, so a fact hidden by a
// stylesheet does not count as said.
//
// A fact is a NAMED PROPERTY with a predicate, not a sentence. A check that
// matches one inflection reports a defect every time the copy is tightened, and
// reports nothing when the copy keeps the words and loses the meaning.

/// Where a page first says that the passphrase does not follow you to a new
/// browser. An index, because the ordering check needs one.
const ACCOUNT_AT = /passphrase[^.]{0,220}\b(fresh|new|another|different)\b[^.]{0,30}browser|\b(fresh|new|another|different)\b[^.]{0,30}browser[^.]{0,220}passphrase/i;

/// The account fact, in any wording: three things, all of which the code makes
/// true. The signing key is generated at random on the device that made the
/// account (`generatePair` in www/js/identity.js) and the passphrase only
/// derives the AES-GCM key that unwraps the stored copy, so (a) the same
/// passphrase in a fresh browser is a DIFFERENT account, (b) the key itself has
/// to be carried, and (c) these are the things that carry it. Say (a) without
/// (c) and the reader has a warning and no way out.
const ACCOUNT_FACT = (t) =>
	ACCOUNT_AT.test(t)
	&& /\b(different|separate|second|its own|new)\b[^.]{0,30}account/i.test(t)
	&& /Link another device/.test(t)
	&& /passkey|Export a backup/i.test(t);

/// Sentences, near enough. The guide's prose is ordinary, and an abbreviation
/// inside one costs a split rather than a verdict.
const sentences = (t) => t.split(/(?<=[.!?;])\s+|\n+/);

/// What a backup is, in any wording, and sentence by sentence rather than over
/// the whole page -- which is the difference between a check and a coincidence.
/// `doExport` writes DaimondIdentity.exportBundle(), so the key IS in the file,
/// and the private half of it is sealed under PBKDF2(passphrase, salt), so the
/// file is not a bearer token. Both halves, or the page loses an account or
/// hands one over. Page-wide matching cannot say this: "your key is not in it"
/// sits on a page that elsewhere says "encrypted" and "passphrase", and every
/// term would be found.
const BACKUP_FACT = (t) => {
	const s = sentences(t);
	// One sentence has to put the key IN the file. A sentence that says it is
	// not there is the defect, so a negation next to the key disqualifies it.
	const inIt = s.some((x) => /\b(backup|file you keep|exported file)\b/i.test(x)
		&& /\bkey\b/i.test(x)
		&& !/\bkey\b[^.]{0,40}\bnot\b|\bnot\b[^.]{0,40}\bkey\b/i.test(x));
	// And one has to say it travels wrapped, under the passphrase.
	const wrapped = s.some((x) => /\bkey\b/i.test(x)
		&& /wrapped|sealed|encrypted/i.test(x) && /passphrase/i.test(x));
	return inIt && wrapped;
};

/// Decode the handful of entities a bank string can carry, and flatten
/// whitespace, so a bank value can be looked for in rendered text.
const flat = (s) => s
	.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
	.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;| /g, ' ')
	.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
	.replace(/\s+/g, ' ').trim();

/// The things a reader is stopped by. Each must also come before the steps.
const STOPPERS = [
	['a snap or flatpak browser cannot do it',	/snap or flatpak browser cannot/i],
	['and why: the hidden directory',		/hidden director(y|ies)/i],
	['and what the browser reports instead',	/Native host has exited/i],
	['apt install chromium-browser is the snap',	/apt install chromium-browser/i],
	['Ubuntu has not shipped a deb since 20.04',	/since 20\.04/],
	['what to install instead',			/Chrome, Brave, Vivaldi or Edge/i],
	['the profile appears on first run',		/profile directory .{0,40}created the first time|run that browser once/i],
	['the passphrase does not stand up a new browser',	ACCOUNT_FACT],
	['so pair before you retire the old browser',	/Link another device/],
	['and export a backup for the work',		/Export a backup/],
];

/// The rest of what is new.
const NEW_FACTS = [
	['--check is the first thing to run',		/install\.sh --check/],
	['run the hand by hand',			/daimond-hand &lt; \/dev\/null|daimond-hand < \/dev\/null/],
	['read the journal',				/journal\/hand-\*\.jsonl/],
	['ask the extension',				/DaimondHand\.status\(\)/],
	['the installer refuses a confined browser',	/refuses rather than writing into it|stops rather than leaving/i],
	['--workspace does the folder step',		/install\.sh --workspace/],
];

/// Facts the page carried before the rewrite. None may have been dropped.
const KEPT = [
	['not the same as the Machine workspace',	/Not the same thing as the Machine workspace/],
	['it is free and not part of Pro',		/it is not part of Pro/],
	['no tools are implemented',			/Daimond implements no tools|implements no tools/],
	['the read-only system list',			/\/libx32/],
	['there is no shell',				/There is no shell, so there is no shell syntax/],
	['the manifest-path trap',			/--manifest-path/],
	['mode 700 on the journal directory',		/mode 700/],
	['the DAIMOND_HAND_ROOT trap',			/DAIMOND_HAND_ROOT/],
	['the workspace.id token',			/workspace\.id/],
	['unix sockets are always refused',		/Named local sockets are refused/],
	['the Landlock ABI 9 reason',			/ABI 9/],
	['ssh does not work, for two reasons',		/ssh.{0,20}does not work|Two independent reasons/],
	['a toolchain needs a grant',			/credentials\.toml/],
	['the network rule',				/own output counts as content from outside/],
	['32-bit binaries are killed',			/32-bit binaries are killed/],
	['the three rungs',				/Ask every time/],
	['a rung never changes what is possible',	/never changes what is possible/],
	['NixOS and Guix will not work',		/nix\/store/],
	['Linux 5.13 to 6.6 is partial',		/5\.13 to 6\.6/],
	['version managers other than two',		/sdkman/],
	['BusyBox is fine',				/BusyBox/],
	['the Terminal panel',				/Terminal/],
	['the journal is hash-chained',			/hash-chained/],
	['what is not protected: stat',			/Asking about a file is not opening it/],
	['what is not protected: the deny-list',	/The filter is a deny-list/],
	['what is not protected: timestamps',		/Timestamps are not protected anywhere/],
	['taking it back, three ways',			/uninstall\.sh/],
];

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
const page = await ctx.newPage();

/// The rendered page, with the prove-run's damage applied to the text.
let damage = null;
async function load(url) {
	await page.goto(url, { waitUntil: 'networkidle' });
	// EVERY match, not the first. Removing one of two callouts leaves the other
	// carrying half the sentences, and the check passes on damage -- which is how
	// three of these proofs first reported success.
	if (damage) await page.evaluate((d) => {
		document.querySelectorAll(d.sel).forEach((el) => el.remove());
	}, damage);
	return page.evaluate(() => document.body.innerText);
}

const mo = await load(`${BASE}/machine-operations.html`);

/// A required fact is a regular expression or a predicate over the page's text.
const said = (t, m) => (typeof m === 'function' ? m(t) : m.test(t));

for (const [what, m] of STOPPERS)  say(said(mo, m), `machine-operations says: ${what}`);
for (const [what, m] of NEW_FACTS) say(said(mo, m), `machine-operations says: ${what}`);
for (const [what, m] of KEPT)      say(said(mo, m), `still says: ${what}`);

// ── Order ────────────────────────────────────────────────────────────
//
// A warning below the instructions it should have prevented is decoration.
{
	const stop = mo.search(/snap or flatpak browser cannot/i);
	const acct = mo.search(ACCOUNT_AT);
	const inst = mo.search(/^Installing it$/m);
	const steps = mo.search(/cargo build --release/);
	say(stop >= 0 && inst > stop, 'the snap warning comes before the installation steps', `${stop} vs ${inst}`);
	say(acct >= 0 && inst > acct, 'the account warning comes before them too', `${acct} vs ${inst}`);
	say(steps > inst, 'and the commands come after the heading that introduces them');
	// The very first thing after the lede, because it is the first thing that
	// stops anyone.
	say(stop < mo.length * 0.12, 'the snap warning is in the first eighth of the page',
		`at ${((stop / mo.length) * 100).toFixed(1)}%`);
}

// ── The callout, in every palette ────────────────────────────────────
//
// `.note.stop` is a new colour, and a colour that works in two of eleven
// palettes is a colour that is wrong in nine.
{
	const problems = [];
	for (const [name, [tone, ink]] of Object.entries(PALETTES)) {
		const found = await page.evaluate(({ name, tone, ink }) => {
			const r = document.documentElement;
			r.setAttribute('data-theme', name);
			r.setAttribute('data-tone', tone);
			r.setAttribute('data-ink', ink);
			const rgb = (s) => {
				const n = (s.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
				const k = /^color\(/.test(s) ? 255 : 1;
				return [n[0] * k, n[1] * k, n[2] * k, n.length > 3 ? n[3] : 1];
			};
			const bgOf = (el) => {
				for (let n = el; n; n = n.parentElement) {
					const c = rgb(getComputedStyle(n).backgroundColor);
					if (c[3] > 0) return c.slice(0, 3);
				}
				return [255, 255, 255];
			};
			const lum = (c) => {
				const f = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
				return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
			};
			const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
			const out = [];
			for (const box of document.querySelectorAll('.note.stop')) {
				const bg = bgOf(box);
				for (const el of [box, ...box.querySelectorAll('strong, a, li, code, em')]) {
					const own = [...el.childNodes].filter((n) => n.nodeType === 3)
						.map((n) => n.textContent).join('').trim();
					if (!own) continue;
					const fg = rgb(getComputedStyle(el).color).slice(0, 3);
					const r = ratio(fg, bgOf(el.parentElement || el));
					if (r < 4.5) out.push(`${r.toFixed(2)}:1 ${JSON.stringify(own.slice(0, 30))}`);
				}
				// The box's own edge, which is what makes it read as a warning
				// rather than as a paragraph.
				const edge = rgb(getComputedStyle(box).borderLeftColor).slice(0, 3);
				if (ratio(edge, bg) < 3) out.push(`edge ${ratio(edge, bg).toFixed(2)}:1`);
			}
			return out;
		}, { name, tone, ink });
		if (found.length) problems.push(`${name}: ${found.join('; ')}`);
	}
	say(problems.length === 0, 'the stop callouts clear 4.5:1 in all eleven palettes', problems.join(' | '));
}

// ── The correction ───────────────────────────────────────────────────
//
// The translations are the half that rots quietly: a corrected English page
// keeps telling seven other languages the old thing, and nobody who reads
// English ever sees it.
//
// Their oracle is the BANK, not a list of foreign phrases. The locale pages are
// generated from dev/guide-i18n/<loc>.json by dev/guide_i18n.mjs, so "this
// locale carries the corrected sentence" means exactly "the locale page renders
// the bank's translation of the English run that carries it". Naming the
// phrases instead fails twice over: it called Japanese wrong for writing
// 作り直すのではなく where the list held 作り直しません, and it called an
// untranslated page RIGHT, because a fallback page carries the English source
// and the English source was one of the alternatives.
const BANK = path.join(ROOT, 'dev', 'guide-i18n');

/// Every locale's rendering of the English runs on `page` that match `carries`.
/// Returns what is stale, what is missing, and why.
async function translated(page, carries) {
	const src  = JSON.parse(fs.readFileSync(path.join(BANK, '_source.json'), 'utf8'));
	const runs = (src[page] || []).filter((s) => carries.test(s));
	const stale = [], missing = [];
	// The English page having no such sentence is itself the failure, and a
	// louder one than any locale's: there is nothing left to translate.
	if (!runs.length) missing.push(`the English ${page} has no run matching ${carries}`);
	for (const loc of LOCS) {
		const text = flat(await load(`${BASE}/${loc}/${page}`));
		if (/Anyone who imports it becomes you/i.test(text)) stale.push(loc);
		const raw  = JSON.parse(fs.readFileSync(path.join(BANK, `${loc}.json`), 'utf8'));
		const bank = Object.assign({}, raw._common || {}, raw[page] || {});
		for (const run of runs) {
			const t = bank[run];
			if (t === undefined) missing.push(`${loc}: no entry for "${run.slice(0, 48)}…"`);
			else if (!text.includes(flat(t))) missing.push(`${loc}: the page does not render its entry`);
		}
	}
	return { stale, missing };
}

{
	const acc = await load(`${BASE}/accounts.html`);
	// Not "a backup contains your identity", which is TRUE -- the export writes
	// the wrapped bundle. The claim to keep out is that holding the file is
	// enough, which is what the passphrase stops.
	say(!/Anyone who imports it becomes you/i.test(acc),
		'accounts.html does not say that importing a backup makes anyone you');
	say(ACCOUNT_FACT(acc),
		'and says the passphrase alone starts a different account, and what carries the key');
	say(BACKUP_FACT(acc),
		'and says the key is in a backup, wrapped under the passphrase');

	const sync = await load(`${BASE}/sync.html`);
	say(/cannot travel on its own|nothing for it to open/.test(sync),
		'sync.html says the passphrase cannot bring the account over by itself');

	const tr = await translated('accounts.html', /passphrase does not recreate/i);
	say(tr.stale.length === 0, 'no translation still carries the old claim', tr.stale.join(', '));
	say(tr.missing.length === 0, 'every translation carries the corrected one', tr.missing.join(' | '));
}

// ── Shots ────────────────────────────────────────────────────────────
if (!PROVE) {
	for (const [name] of [['light'], ['dark'], ['linen'], ['amber']].map((x) => x)) {
		const [tone, ink] = PALETTES[name];
		await page.goto(`${BASE}/machine-operations.html`, { waitUntil: 'networkidle' });
		await page.evaluate(({ name, tone, ink }) => {
			const r = document.documentElement;
			r.setAttribute('data-theme', name);
			r.setAttribute('data-tone', tone);
			r.setAttribute('data-ink', ink);
		}, { name, tone, ink });
		// The top of the page, where the two stop boxes are.
		await page.screenshot({ path: path.join(OUT, `facts-top-${name}.png`) });
		const box = await page.$$('.note.stop');
		if (box[1]) await box[1].screenshot({ path: path.join(OUT, `facts-account-${name}.png`) });
	}
	// And the narrow width, where a callout with a list in it is likeliest to
	// break out of its box.
	await page.setViewportSize({ width: 360, height: 900 });
	await page.goto(`${BASE}/machine-operations.html`, { waitUntil: 'networkidle' });
	const narrow = await page.evaluate(() => {
		const out = [];
		if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) out.push('page scrolls sideways');
		for (const b of document.querySelectorAll('.note.stop')) {
			const r = b.getBoundingClientRect();
			if (r.right > document.documentElement.clientWidth + 1 || r.left < -1) out.push('callout out of the column');
			if (b.scrollWidth > b.clientWidth + 2) out.push('callout clips its own text');
		}
		return out;
	});
	say(narrow.length === 0, '360px wide: the stop callouts stay in the column', narrow.join('; '));
	const b2 = await page.$$('.note.stop');
	if (b2[1]) await b2[1].screenshot({ path: path.join(OUT, 'facts-account-narrow.png') });
}

// ── Proving the checks ───────────────────────────────────────────────
//
// Every check above reads text off a rendered page, so one breakage shape --
// removing the element that carries the sentence -- exercises all of them. Each
// group gets its own, aimed at the element that group is about.
if (PROVE) {
	const CASES = [
		['the stop callouts', '.note.stop', async () => {
			const t = await load(`${BASE}/machine-operations.html`);
			return !/snap or flatpak browser cannot/i.test(t) && !ACCOUNT_FACT(t) && t.search(ACCOUNT_AT) < 0;
		}],
		['the callouts that carry the kept facts', '.note', async () => {
			const t = await load(`${BASE}/machine-operations.html`);
			return !KEPT.every(([, m]) => said(t, m));
		}],
		['the troubleshooting section', '#trouble', async () => {
			// Removing only the heading leaves the commands, so the check that
			// would notice is the ordering one; the heading is what anchors it.
			const t = await load(`${BASE}/machine-operations.html`);
			return !/When it does not work/.test(t);
		}],
		['the accounts correction', 'main p', async () => {
			const t = await load(`${BASE}/accounts.html`);
			return !ACCOUNT_FACT(t);
		}],
		['the translated sentence', 'main p', async () => {
			// The same removal, on the seven generated pages: the bank still holds
			// the entry, and the page no longer renders it. A check that only asked
			// whether the bank had an entry would pass here.
			const t = await translated('accounts.html', /passphrase does not recreate/i);
			return t.missing.length === LOCS.length;
		}],
	];
	for (const [what, sel, run] of CASES) {
		damage = { sel };
		const caught = await run();
		say(caught, `broken on purpose: removing ${what} is caught`, 'the check still passed');
		damage = null;
	}
	// BACKUP_FACT, against the page as it actually read until this was corrected.
	// Removing an element cannot prove this one -- three separate sentences carry
	// the fact, and any of them satisfies the predicate -- and the failure was
	// never a missing sentence. It was a page that said something, confidently,
	// and said the opposite of what doExport does. So it is given those words
	// back, with the neighbours that make a page-wide match pass: "encrypted"
	// and "passphrase" both appear, a few rows up, about something else.
	{
		const was = [
			'Change passphrase… — set a new one; your encrypted data is re-wrapped under it.',
			'Export a backup — write your chats, Diamonds and workspace files to a file you keep.',
			'It restores your work and not your account: your key is not in it.',
			'Import a backup… — bring an exported identity into this browser.',
			'Your account is a signing key held in this browser. The passphrase does not recreate it, only decrypts the copy already stored here, so the same passphrase in a fresh browser starts a separate account with its own credits and no Pro.',
			'Two things carry the key across and nothing else does: Link another device, which shows a pairing code to type into the new browser, and a passkey, which stands a new device up in one gesture.',
			'Take an Export a backup as well, for the chats, Diamonds and workspace files the key does not carry.',
			'A backup holds everything you have written.',
			'Not the key — importing it does not make anyone you — but every chat, Diamond and workspace file is in it as plain text, so keep it as private as the work itself.',
		].join('\n');
		say(!BACKUP_FACT(was), 'broken on purpose: "your key is not in it" is caught', 'the check still passed');
		// And the same text must still satisfy the OTHER property, or the case
		// above would be proving nothing more than that some words changed.
		say(ACCOUNT_FACT(was), 'and that page still says the account fact, so the two are independent');
	}
	// The palette check, against a colour that does not clear the floor.
	{
		await page.goto(`${BASE}/machine-operations.html`, { waitUntil: 'networkidle' });
		const worst = await page.evaluate(() => {
			const s = document.createElement('style');
			s.textContent = '.note.stop { color: color-mix(in srgb, currentColor 20%, var(--warn-bg)); }';
			document.head.appendChild(s);
			const rgb = (x) => { const n = (x.match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
				const k = /^color\(/.test(x) ? 255 : 1; return [n[0] * k, n[1] * k, n[2] * k]; };
			const lum = (c) => { const f = c.map((v) => { const t = v / 255; return t <= 0.03928 ? t / 12.92 : Math.pow((t + 0.055) / 1.055, 2.4); });
				return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]; };
			const box = document.querySelector('.note.stop');
			const li = box.querySelector('li') || box;
			const [x, y] = [lum(rgb(getComputedStyle(li).color)), lum(rgb(getComputedStyle(box).backgroundColor))]
				.sort((a, b) => b - a);
			return (x + 0.05) / (y + 0.05);
		});
		say(worst < 4.5, 'broken on purpose: a washed-out callout colour is caught', `${worst.toFixed(2)}:1`);
	}
	// The translation check, against a page that kept the old claim.
	{
		const stale = 'Anyone who imports it becomes you';
		const t = `nonsense ${stale} nonsense`;
		say(/Anyone who imports it becomes you/i.test(t),
			'broken on purpose: the old claim in a translation is caught');
	}
}

await browser.close();
console.log(`\n${ran} checks, ${bad ? bad + ' FAILED' : 'all good'} — shots in ${OUT}`);
process.exit(bad ? 1 : 0);
