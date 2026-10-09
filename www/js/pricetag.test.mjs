/* ============================================================
   Test -- THE PRICE TAG'S FIGURE (D-20261009-18, variant B).
   ------------------------------------------------------------
   An estimated price is drawn as a tag glyph and a bare number: no "≈" and
   no currency symbol, the reader's own grouping, four places below a cent,
   the currency's own decimals (whole yen, but decimals below one yen), and
   nothing at all for an unknown price. "Estimated" and the currency live in
   the hover title. A CHARGED price keeps "US$" through `billed`.

   On a tree without `price` this reads `money`, which is what every site drew
   before, so the run is RED on the "≈" and the symbol.

   Run:  node www/js/pricetag.test.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = fs.readFileSync(path.join(HERE, 'i18n.js'), 'utf8');
const EN   = fs.readFileSync(path.join(HERE, '..', 'i18n', 'en.js'), 'utf8');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// Just enough of a DOM for the tag to be built.
function fakeEl(tag) {
	return {
		tagName: tag, className: '', title: '', children: [], _text: '', _html: '',
		set textContent(v) { this._text = String(v); this.children = []; },
		get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('') : this._text; },
		set innerHTML(v) { this._html = v; this.children = [fakeEl('svg')]; this.children[0]._html = v; },
		get firstChild() { return this.children[0]; },
		appendChild(c) { this.children.push(c); return c; },
		cloneNode() { const c = fakeEl(this.tagName); c._html = this._html; return c; },
		getAttribute(k) { return k === 'aria-hidden' && this.tagName === 'svg' && /aria-hidden="true"/.test(this._html) ? 'true' : null; },
	};
}

function load(locale, ccy) {
	const store = { 'daimond-locale': locale, 'daimond-currency': ccy };
	const ctx = {
		console: { log() {}, warn() {} },
		navigator: { language: 'en' },
		localStorage: { getItem: k => store[k] || null, setItem() {} },
		document: {
			documentElement: { lang: '' },
			head: { appendChild() {} },
			createElement: fakeEl,
			createTextNode: s => ({ textContent: s }),
			querySelectorAll: () => [],
		},
		Intl, Math, String, Number, isFinite, Object, Array, JSON, Promise,
	};
	ctx.window = ctx;
	vm.createContext(ctx);
	vm.runInContext(SRC, ctx);
	vm.runInContext(EN, ctx);
	return ctx.DaimondI18n;
}

// What a site draws for a US dollar estimate: the new figure, or the old one.
function fig(I, usd, mode) { return I.price ? I.price(usd, mode) : I.money(usd, mode); }

const SYMBOL = /[$€£¥₩≈~]|A\$|US/;

{
	const I = load('en', 'AUD');
	const r = 1.52;
	check('AUD: no "≈" and no symbol on a very small figure', fig(I, 0.0006 / r) === '0.0006', fig(I, 0.0006 / r));
	check('AUD: below a unit takes three places', fig(I, 0.49 / r) === '0.490', fig(I, 0.49 / r));
	check('AUD: a large figure is grouped', fig(I, 1234.56 / r, 'fine') === '1,234.56', fig(I, 1234.56 / r, 'fine'));
	check('AUD: zero reads with the currency\'s own decimals', fig(I, 0, 'fine') === '0.00', fig(I, 0, 'fine'));
	check('AUD: zero in the calm cascade too', fig(I, 0) === '0.00', fig(I, 0));
	check('AUD: never rounds to nothing', fig(I, 0.0000001) === '0.0001', fig(I, 0.0000001));
	check('AUD: an unknown price draws nothing', fig(I, null) === '' && fig(I, undefined) === '', JSON.stringify([fig(I, null), fig(I, undefined)]));
	for (const v of [0.00004, 0.0031, 0.49, 3.41, 10.35, 1234.56]) {
		const s = fig(I, v);
		check('AUD: ' + v + ' carries no symbol or ≈', !SYMBOL.test(s), s);
	}
	check('a charged price keeps US$', /^US\$/.test(I.billed(9)), I.billed(9));
}

{
	const I = load('en', 'USD');
	check('USD: no "$" on an estimate', fig(I, 0.0031) === '0.0031', fig(I, 0.0031));
	check('USD: four places below a cent', fig(I, 0.0062) === '0.0062', fig(I, 0.0062));
	check('USD: the spending panel\'s fine cascade', fig(I, 0.0124, 'fine') === '0.0124', fig(I, 0.0124, 'fine'));
	check('USD: two places above a unit', fig(I, 3.4) === '3.40', fig(I, 3.4));
	check('USD: a charged price stays "$9.00"', I.billed(9) === '$9.00', I.billed(9));
}

{
	const I = load('de', 'EUR');
	const v = 1234.56 / 0.92;
	check('de: grouped by the locale, 1.234,56', fig(I, v, 'fine') === '1.234,56', fig(I, v, 'fine'));
}

{
	const I = load('en', 'JPY');
	check('JPY: whole yen above one', fig(I, 1846 / 151) === '1,846', fig(I, 1846 / 151));
	check('JPY: decimals below one yen', fig(I, 0.09 / 151) === '0.09', fig(I, 0.09 / 151));
	check('JPY: zero is a whole 0', fig(I, 0) === '0', fig(I, 0));
}

{
	const I = load('en', 'AUD');
	const tag = I.priceTag ? I.priceTag(0.0031 / 1.52) : null;
	check('the tag exists and is one class', !!tag && tag.className === 'tagb', tag && tag.className);
	if (tag) {
		check('the tag reads the bare figure', tag.textContent === '0.0031', tag.textContent);
		check('the tag says "Estimated" and the currency in its title', /^Estimated · /.test(tag.title) && /dollar/i.test(tag.title), tag.title);
		check('the glyph is hidden from a screen reader', tag.children[0].getAttribute('aria-hidden') === 'true');
	}
	check('an unknown price has no tag', I.priceTag ? I.priceTag(null) === null : false);
	const U = load('en', 'USD');
	const st = U.priceTag ? U.priceTag(0.5) : null;
	check('a stated USD figure is not called estimated', !!st && !/Estimated/.test(st.title), st && st.title);
	const es = U.priceTag ? U.priceTag(0.5, { estimated: true }) : null;
	check('a table-priced USD figure is', !!es && /^Estimated/.test(es.title), es && es.title);
}

{
	const I = load('en', 'AUD');
	check('minor units: converted and bare', I.priceMinor ? I.priceMinor(500, 'usd') === '7.60' : false, I.priceMinor && I.priceMinor(500, 'usd'));
	check('minor units: quoted in its own currency, not converted twice', I.priceMinor ? I.priceMinor(500, 'eur') === '5.00' : false);
}

// THE GATE: no tally site emits "≈". A site that is all estimates draws every
// figure through the tag, so it neither writes "≈" nor calls the old formatter,
// which still hangs one on a converted figure; a site that also shows a charge
// (daimond.js, mail.js, models.js) at least writes no "≈" of its own. Comments
// are stripped first: a "≈" in prose about the old mark is not a mark.
{
	const code = (f) => fs.readFileSync(path.join(HERE, f), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n').map((l) => l.replace(/(^|[^:'"\\])\/\/.*$/, '$1')).join('\n');
	const ALL_EST = ['spend.js', 'modeldash.js', 'triage.js', 'ledger.js', 'governor.js'];
	const MIXED   = ['daimond.js', 'mail.js', 'models.js'];
	for (const f of ALL_EST.concat(MIXED)) {
		const c = code(f);
		const n = (c.match(/≈/g) || []).length;
		check('gate: ' + f + ' writes no "≈"', n === 0, n + ' found');
	}
	for (const f of ALL_EST) {
		const hits = code(f).match(/\b(?:money|moneyMinor|fmtMoney)\s*\(/g) || [];
		check('gate: ' + f + ' calls no "≈" formatter', hits.length === 0, hits.join(', '));
	}
}

console.log('\n' + (checks - failures) + '/' + checks + ' passed');
process.exit(failures ? 1 : 0);
