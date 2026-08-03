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
//   The correction. The guide used to say a backup carries your identity. It
//   does not -- `doExport` in www/js/daimond.js writes chats, the ledger,
//   Diamonds and workspace files, and never touches the wrapped key; only
//   pairing and a passkey carry an identity, via DaimondIdentity.exportBundle.
//   Acting on the old sentence is how an account gets lost, so both the English
//   page and all seven translations are checked for the corrected wording and
//   against the wrong one.
//
// And the callout the stop-facts sit in has to be legible in all eleven
// palettes, not the two a colorScheme flag reaches.
//
//   node dev/verify_guidefacts.mjs            the checks
//   node dev/verify_guidefacts.mjs --prove    each check, against broken text
//
// Needs dev/serve.mjs on :8777.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
const ROOT = '/home/jason/usr/code/web/apps/oxedyne/daimond';
const BASE = 'http://localhost:8777/guide';
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

/// The things a reader is stopped by. Each must also come before the steps.
const STOPPERS = [
	['a snap or flatpak browser cannot do it',	/snap or flatpak browser cannot/i],
	['and why: the hidden directory',		/hidden director(y|ies)/i],
	['and what the browser reports instead',	/Native host has exited/i],
	['apt install chromium-browser is the snap',	/apt install chromium-browser/i],
	['Ubuntu has not shipped a deb since 20.04',	/since 20\.04/],
	['what to install instead',			/Chrome, Brave, Vivaldi or Edge/i],
	['the profile appears on first run',		/profile directory .{0,40}created the first time|run that browser once/i],
	['the passphrase does not recreate the key',	/passphrase does not recreate/i],
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

for (const [what, re] of STOPPERS)  say(re.test(mo), `machine-operations says: ${what}`);
for (const [what, re] of NEW_FACTS) say(re.test(mo), `machine-operations says: ${what}`);
for (const [what, re] of KEPT)      say(re.test(mo), `still says: ${what}`);

// ── Order ────────────────────────────────────────────────────────────
//
// A warning below the instructions it should have prevented is decoration.
{
	const stop = mo.search(/snap or flatpak browser cannot/i);
	const acct = mo.search(/passphrase does not recreate/i);
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
{
	const acc = await load(`${BASE}/accounts.html`);
	say(!/backup contains your identity|Anyone who imports it becomes you/i.test(acc),
		'accounts.html no longer says a backup carries your identity');
	say(/does not recreate it/.test(acc) && /Link another device/.test(acc),
		'and says what does carry it');
	say(/your key is not in it/.test(acc),
		'and says what a backup is for instead');

	const sync = await load(`${BASE}/sync.html`);
	say(/cannot travel on its own|nothing for it to open/.test(sync),
		'sync.html says the passphrase cannot bring the account over by itself');

	// The translations, which is where a corrected English page quietly keeps
	// telling seven other languages the wrong thing.
	const stale = [], fixed = [];
	for (const loc of LOCS) {
		const t = await load(`${BASE}/${loc}/accounts.html`);
		if (/Anyone who imports it becomes you/i.test(t)) stale.push(loc);
		if (/does not recreate|nicht neu|no la recrea|ne la recrée|作り直しません|다시 만들어|não a recria|重新造出来/.test(t)) fixed.push(loc);
	}
	say(stale.length === 0, 'no translation still carries the old claim', stale.join(', '));
	say(fixed.length === LOCS.length, 'every translation carries the corrected one',
		`${fixed.length}/${LOCS.length}: ${fixed.join(', ')}`);
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
			return !/snap or flatpak browser cannot/i.test(t) && !/passphrase does not recreate/i.test(t);
		}],
		['the callouts that carry the kept facts', '.note', async () => {
			const t = await load(`${BASE}/machine-operations.html`);
			return !KEPT.every(([, re]) => re.test(t));
		}],
		['the troubleshooting section', '#trouble', async () => {
			// Removing only the heading leaves the commands, so the check that
			// would notice is the ordering one; the heading is what anchors it.
			const t = await load(`${BASE}/machine-operations.html`);
			return !/When it does not work/.test(t);
		}],
		['the accounts correction', 'main p', async () => {
			const t = await load(`${BASE}/accounts.html`);
			return !/does not recreate it/.test(t);
		}],
	];
	for (const [what, sel, run] of CASES) {
		damage = { sel };
		const caught = await run();
		say(caught, `broken on purpose: removing ${what} is caught`, 'the check still passed');
		damage = null;
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
