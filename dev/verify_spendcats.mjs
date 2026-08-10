// verify_spendcats.mjs — the Spending page can name every category the gateway
// can charge under, in every language.
//
// This exists because of a defect that has now happened twice from one cause: a
// list of spend categories written out by hand in one place and extended in
// another. `infer` became a category in the gateway on 2026-07-17 and `storage`
// on 2026-07-21. The operator console's consumption chart named four and drew
// neither for three weeks; `www/js/spend.js` named eight and showed a user the
// bare tokens "search", "storage" and "infer" beside their own money, in all
// eight languages, because `catLabel` fell back to whatever string the gateway
// sent.
//
// So the check is deliberately NOT "the seven strings we have today exist" --
// that check would have passed on 17 July and every day since. It derives the
// truth from the gateway and fails when the page has fallen behind it.
//
// Two halves.
//
// STATIC (no browser, no gateway, no server). Parses `LedgerEntry::category()`
// in gateway/src/schema.rs -- the function itself, not the constant beside it,
// because a new category is BORN in that match and the constant is one more
// hand-written copy that can go stale. From it:
//
//   * every string `category()` can return, split into metered spends (the
//     reference-prefix arms) and credit-side movements (the kind arms);
//   * `SPEND_CATEGORIES` must name exactly the metered set -- this is the check
//     that would have caught 17 July, had the constant existed;
//   * `CATS` in www/js/spend.js must contain every one of them, and invent none;
//   * `spend.cat_<name>` must exist in ALL EIGHT locales, non-empty, and not be
//     the raw token wearing a translation's clothes.
//
// BROWSER. Drives the real Spending panel with a stubbed `/api/ledger` holding
// one movement per category plus one category the build cannot know, switches
// through all eight locales, and reads the rendered labels back. A key present
// in a table but not reaching the screen, or reaching it with a stray space or
// an unfilled placeholder, is only visible here. It also proves the fallback is
// loud: an unnameable category draws `spend.cat_unlisted` and reports the token
// to the console, rather than printing it at the user.
//
//   node dev/verify_spendcats.mjs             # both halves
//   node dev/verify_spendcats.mjs --static    # the drift check alone
//
// `DAIMOND_TREE` points the STATIC half at another checkout of this app, which
// is how the check was proved red against the code as it stood before the fix.
// The browser half always drives whatever the dev server is serving.
//
// The browser half needs dev/serve.mjs (DAIMOND_PORT) and the mock provider; no
// gateway, and no model is asked to think.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE   = path.dirname(fileURLToPath(import.meta.url));
const TREE   = process.env.DAIMOND_TREE || path.join(HERE, '..');
const STATIC = process.argv.includes('--static');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const setEq = (a, b) => a.length === b.length && a.every(x => b.includes(x));

// ── The gateway, read as the authority ──────────────────────────────

const RUST = fs.readFileSync(path.join(TREE, 'gateway/src/schema.rs'), 'utf8');

/// The body of `LedgerEntry::category()`, from its signature to the brace that
/// closes it. Every inner brace is indented deeper than the four spaces the
/// function's own closing brace sits at, so the first `\n    }` after the
/// signature is the end of it.
function categoryBody(src) {
	const i = src.indexOf('pub fn category(&self)');
	if (i < 0) return null;
	const j = src.indexOf('\n    }', i);
	return j < 0 ? null : src.slice(i, j);
}

const body = categoryBody(RUST);
check('gateway: LedgerEntry::category() found', !!body,
	body ? body.split('\n').length + ' lines' : 'schema.rs did not parse');
if (!body) process.exit(1);

// A kind arm names its category outright (`LedgerKind::Topup => "topup"`); a
// metered spend names it as the value of a prefix test (`{ "web" }`), including
// the `else` that catches an unknown prefix. `=> {` opens the Spend block and is
// not a category, which is why the kind pattern demands a quote straight after
// the arrow.
const kindCats  = [...body.matchAll(/=>\s*"([a-z_]+)"/g)].map(m => m[1]);
const spendCats = [...body.matchAll(/\{\s*"([a-z_]+)"\s*\}/g)].map(m => m[1]);
const prefixes  = [...body.matchAll(/starts_with\("([a-z_]+):"\)/g)].map(m => m[1]);
const derived   = kindCats.concat(spendCats);

// A parse that quietly matched nothing would let every check below pass on an
// empty set, so the shape of what was read is asserted before it is used. Each
// prefix test yields one category and the `else` yields one more.
check('gateway: every prefix arm was read', spendCats.length === prefixes.length + 1,
	`${prefixes.length} prefixes (${prefixes.join(' ')}) → ${spendCats.length} categories`);
check('gateway: the credit-side kinds were read', kindCats.length >= 4, kindCats.join(' '));

// `SPEND_CATEGORIES` is what everything drawing a breakdown is told to iterate.
// It is a second hand-written list, so it is checked against the function rather
// than trusted as the source: it going stale is the same defect one step up.
const cm = RUST.match(/pub const SPEND_CATEGORIES: \[&str; (\d+)\] = \[([\s\S]*?)\];/);
const constCats = cm ? [...cm[2].matchAll(/"([a-z_]+)"/g)].map(m => m[1]) : [];
check('gateway: SPEND_CATEGORIES found and its arity matches its contents',
	!!cm && constCats.length === Number(cm[1]),
	cm ? `[&str; ${cm[1]}] holding ${constCats.length}` : 'constant not found');
check('gateway: SPEND_CATEGORIES names exactly what category() can return for a spend',
	setEq(constCats, spendCats),
	`constant: ${constCats.join(' ')} | category(): ${spendCats.join(' ')}`);

// ── The page's copy ─────────────────────────────────────────────────

const SPENDJS = fs.readFileSync(path.join(TREE, 'www/js/spend.js'), 'utf8');
const jm      = SPENDJS.match(/var CATS = \[([\s\S]*?)\];/);
const pageCats = jm ? [...jm[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]) : [];
check('spend.js: CATS found', !!jm && pageCats.length > 0, pageCats.join(' '));

const unnamed  = derived.filter(c => !pageCats.includes(c));
const invented = pageCats.filter(c => !derived.includes(c));
check('spend.js: CATS names every category the gateway can produce',
	unnamed.length === 0,
	unnamed.length ? 'the page cannot name: ' + unnamed.join(' ') : derived.length + ' categories');
check('spend.js: CATS invents no category the gateway cannot produce',
	invented.length === 0, invented.join(' ') || undefined);

// ── Eight locales ───────────────────────────────────────────────────

const I18NDIR = path.join(TREE, 'www/i18n');
/// A locale table, loaded the way the browser loads it: the file registers
/// itself against a stub window.
function loadTable(code) {
	let table = null;
	const w = { DaimondI18n: { register: (c, t) => { table = t; } } };
	new Function('window', fs.readFileSync(path.join(I18NDIR, code + '.js'), 'utf8'))(w);
	return table || {};
}
const codes  = fs.readdirSync(I18NDIR).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort();
const tables = {};
for (const c of codes) tables[c] = loadTable(c);
check('all eight locales load', codes.length === 8, codes.join(' '));

// The label a user reads for an unnameable category, which must itself exist
// everywhere -- a loud fallback that falls back to its own key is not loud.
const WANTED = derived.map(c => 'spend.cat_' + c).concat(['spend.cat_fallback', 'spend.cat_unlisted']);
/// The category a `spend.cat_*` key names.
const tokenOf = (k) => k.slice('spend.cat_'.length);
for (const code of codes) {
	const t = tables[code];
	const missing = WANTED.filter(k => typeof t[k] !== 'string' || !t[k].trim());
	check(code + ': every category has a label', missing.length === 0,
		missing.join(' ') || WANTED.length + ' labels');
	// A "translation" that is the category token is the defect with a key in
	// front of it: `'spend.cat_infer': 'infer'` reads no better in Japanese. It
	// is only a defect where English says something else -- English calls the
	// mail category "Mail" and German agrees, and neither is untranslated.
	if (code === 'en') continue;
	const tokens = WANTED.filter(k => typeof t[k] === 'string'
		&& t[k].trim().toLowerCase() === tokenOf(k)
		&& String(tables.en[k]).trim().toLowerCase() !== tokenOf(k));
	check(code + ': no label is the raw token', tokens.length === 0, tokens.join(' ') || undefined);
}

if (STATIC) {
	console.log(`\nspendcats (static): ${ok.length} ok, ${bad.length} failed.`);
	if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
	process.exit(bad.length ? 1 : 0);
}

// ── The page itself, in eight languages ─────────────────────────────

const { open, shot } = await import('./harness.mjs');

// One movement per category the gateway can write, plus one it cannot: `quartz`
// stands for the next category to be invented, and is the whole point of the
// fallback being loud rather than printing whatever arrived.
const UNKNOWN = 'quartz';
const NS      = Date.now() * 1e6;			// the API dates a movement in nanoseconds
const entries = derived.map((c, i) => ({
	ts: NS - i * 3600e9,
	kind: kindCats.includes(c) ? c : 'spend',
	category: c,
	// Debits are negative, and only debits reach the breakdown; the credit-side
	// kinds are positive and appear in the movements table alone.
	delta_minor: kindCats.includes(c) ? 100 + i : -(100 + i),
	balance: 5000,
	ref: c + ':x',
})).concat([{
	ts: NS - 99 * 3600e9, kind: 'spend', category: UNKNOWN,
	delta_minor: -77, balance: 5000, ref: UNKNOWN + ':x',
}]);

const s = await open({ name: 'spendcats' + Date.now() });
const page = s.page;
await page.waitForFunction(
	() => !!window.DaimondSpend && !!window.DaimondI18n && !!window.DaimondGateway,
	null, { timeout: 15000 }).catch(() => {});

// Stand in for the gateway: an authed account with a ledger holding every
// category. `refreshBalance` is silenced because it publishes `daimond:credits`,
// which refreshes an open Spending panel, which refreshes the balance.
await page.evaluate((rows) => {
	const g = window.DaimondGateway;
	window.__gwReal = { state: g.state, refreshBalance: g.refreshBalance, ledger: g.ledger };
	g.state          = () => ({ authed: true, credits: 5000, currency: 'usd' });
	g.refreshBalance = async () => {};
	g.ledger         = async () => rows;
}, entries);

/// Every category label on screen: the breakdown rows, and the "What" column of
/// the movements table.
const labels = () => page.evaluate(() => ({
	breakdown: [...document.querySelectorAll('#spend-view .spend-bd-label')].map(n => n.textContent),
	movements: [...document.querySelectorAll('#spend-view tr')]
		.filter(tr => tr.querySelector('td.spend-when'))
		.map(tr => tr.children[1].textContent),
}));

// The Admin drawer is left open by the harness's model connect, and it sits over
// the rail; close it so the shots below are of the Spending panel and nothing
// else.
await page.evaluate(() => { try { document.getElementById('admin-close').click(); } catch (e) {} });
await page.evaluate(() => window.DaimondSpend.show());
await page.waitForTimeout(600);

/// A shot of the credits breakdown itself, scrolled to.
async function panelShot(label) {
	await page.evaluate(() => {
		const v = document.getElementById('spend-view');
		const n = document.querySelector('#spend-view .spend-breakdown');
		if (v && n) v.scrollTop += n.getBoundingClientRect().top - v.getBoundingClientRect().top - 60;
	});
	await page.waitForTimeout(150);
	await page.locator('#panel-spend')
		.screenshot({ path: path.join(HERE, 'shots', label + '.png'), timeout: 8000 })
		.catch(() => {});
}

for (const code of codes) {
	const mark = s.logs.length;
	await page.evaluate(c => window.DaimondI18n.setLocale(c), code);
	await page.waitForTimeout(200);
	await page.evaluate(() => window.DaimondSpend.refresh());
	await page.waitForTimeout(300);

	const seen = await labels();
	const all  = seen.breakdown.concat(seen.movements);
	const t    = tables[code];

	// Every category the gateway can write reaches the screen under this
	// locale's own words for it.
	const absent = derived.filter(c => !all.includes(t['spend.cat_' + c]));
	check(code + ': every category is drawn with its own label', absent.length === 0,
		absent.length ? absent.map(c => c + '→' + t['spend.cat_' + c]).join(' ')
			: derived.length + ' labels drawn');

	// The token itself must never be on screen. `derived` is what a stale page
	// leaks; `spend.cat_` is what a missing key leaks.
	const raw = all.filter(x => derived.includes(x.trim()) || /^spend\.cat_/.test(x.trim()));
	check(code + ': no raw category token on screen', raw.length === 0, raw.join(' ') || undefined);

	// Composed and read back: a stray space or an unfilled placeholder is
	// invisible in the source string and plain here.
	const badly = all.filter(x => x !== x.trim() || /\s\s/.test(x) || /[{}]/.test(x) || !x.length);
	// The drawn breakdown is quoted whether it passes or not: this line is the
	// read-back, and a label that is wrong rather than malformed is caught by
	// somebody's eye on it and by nothing else.
	check(code + ': labels compose cleanly', badly.length === 0,
		badly.map(x => JSON.stringify(x)).join(' ') || seen.breakdown.join(' · '));

	// A shot per language, because "the string is right" and "the row reads
	// right at this width" are different questions.
	await panelShot('spendcats-' + code);

	// The unnameable category is drawn as unaccounted for, and the token goes to
	// the console instead of to the user.
	check(code + ': an unnameable category is drawn as unaccounted for',
		all.includes(t['spend.cat_unlisted']), t['spend.cat_unlisted']);
	const gaps = s.logs.slice(mark).filter(l => /i18n: no string for "spend\.cat_/.test(l));
	check(code + ': no missing-label warning', gaps.length === 0, gaps.slice(0, 3).join(' | ') || undefined);
}

check('the unnameable category was reported to the console',
	s.logs.some(l => l.includes('cannot label') && l.includes(UNKNOWN)),
	s.logs.filter(l => l.includes('cannot label'))[0] || 'nothing said');
// Reported ONCE per token, however many rows and redraws carried it: eight
// locales times a redraw each is eight chances to turn a diagnostic into a
// flood.
check('and only once, however many redraws carried it',
	s.logs.filter(l => l.includes('cannot label') && l.includes(UNKNOWN)).length === 1,
	s.logs.filter(l => l.includes('cannot label')).length + ' warning(s)');

await page.evaluate(c => window.DaimondI18n.setLocale(c), 'en');
await page.waitForTimeout(200);
await page.evaluate(() => window.DaimondSpend.refresh());
await page.waitForTimeout(300);
await shot(s, 'spendcats-page');		// the whole page, English, for context

// ── Negative control ────────────────────────────────────────────────
// Everything above passes on a page that draws the right words. It would also
// pass on a check that asserts nothing, so the check is shown failing on a page
// that has lost a label: the English table is re-registered without
// `spend.cat_infer`, which is exactly the shape of a category added to the
// gateway and not to the locales.
{
	const before = await labels();
	const lost = await page.evaluate(async () => {
		const src = await (await fetch('/i18n/en.js')).text();
		let tbl = null;
		new Function('window', src)({ DaimondI18n: { register: (c, t) => { tbl = t; } } });
		const full = Object.assign({}, tbl);
		delete tbl['spend.cat_infer'];
		window.DaimondI18n.register('en', tbl);
		await window.DaimondSpend.refresh();
		const shown = [...document.querySelectorAll('#spend-view .spend-bd-label')].map(n => n.textContent);
		window.DaimondI18n.register('en', full);		// put it back
		await window.DaimondSpend.refresh();
		return shown;
	});
	const en = tables.en;
	check('negative control: the check fails when a label is removed',
		before.breakdown.includes(en['spend.cat_infer']) && !lost.includes(en['spend.cat_infer']),
		'lost row read: ' + (lost.find(x => /spend\.cat_/.test(x)) || '(none)'));
	const back = await labels();
	check('negative control: and passes again once it is restored',
		back.breakdown.includes(en['spend.cat_infer']));
}

await page.evaluate(() => {
	const g = window.DaimondGateway, r = window.__gwReal;
	if (r) { g.state = r.state; g.refreshBalance = r.refreshBalance; g.ledger = r.ledger; }
});

// No gateway runs for this check -- the ledger is stubbed in the page -- so the
// bootstrap's /api calls come back 502 from dev/serve.mjs. That is the harness,
// not the page, and it is the only noise allowed through.
const errs = s.errs.filter(e => !/502|Bad Gateway|quartz/.test(e));
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || undefined);

await s.close();
console.log(`\nspendcats: ${ok.length} ok, ${bad.length} failed.`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
