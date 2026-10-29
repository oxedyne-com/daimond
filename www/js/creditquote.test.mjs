/* ============================================================
   Test -- A TOP-UP SHOWS WHAT THE CARD IS CHARGED (r578e G1).
   ------------------------------------------------------------
   The gateway prices a top-up as the credit plus the model host's fee plus
   the card and conversion fees, and `GET /api/checkout/credits` states that
   per preset (`quotes`) and the rates (`fees`). `GET /api/autoreload` states
   one reload's charge (`topup_charge_minor`). The page used to show the
   credit alone, so the buyer met the real figure only on Stripe's page.

   Against canned gateway answers, from the files as they ship:
   - each preset is quoted with the gateway's own total and a breakdown;
   - an amount that is not a preset is itemised from the gateway's rates and
     agrees with the gateway's quote wherever both exist;
   - an older gateway with no rates quotes nothing rather than a guess;
   - the Credits drawer draws the quote on each preset and the typed amount;
   - auto-reload shows one reload's charge, and a budget under it is
     refused with the gateway's own sentence.

   Run:  node www/js/creditquote.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const I18N = readPage(path.join(HERE, 'i18n.js'), 'utf8');
const EN   = readPage(path.join(HERE, '..', 'i18n', 'en.js'), 'utf8');
const GW   = readPage(path.join(HERE, 'gateway.js'), 'utf8');
const AR   = readPage(path.join(HERE, 'autoreload.js'), 'utf8');
const APP  = readPage(path.join(HERE, 'daimond.js'), 'utf8');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// The shipped fees and the gateway's own quotes for its four presets
// (topup.rs `test_the_presets_recover_host_card_and_conversion`).
const FEES = { host_bps: 550, card_bps: 350, card_fixed_minor: 21, conversion_bps: 200 };
const Q = (credit, host, total) => ({ credit_minor: credit, host_minor: host,
	fees_minor: total - credit - host, total_minor: total });
const QUOTES = [Q(1000, 55, 1139), Q(2000, 110, 2255), Q(5000, 275, 5604), Q(10000, 550, 11186)];
const OFFER = { ok: true, currency: 'usd', presets: [1000, 2000, 5000, 10000],
	min_minor: 500, max_minor: 50000, quotes: QUOTES, fees: FEES };

function load(offer) {
	const store = { 'daimond-locale': 'en', 'daimond-currency': 'USD' };
	const ctx = {
		console: { log() {}, warn() {}, error() {} },
		navigator: { language: 'en' },
		localStorage: { getItem: k => store[k] || null, setItem() {}, removeItem() {} },
		sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		location: { origin: 'http://localhost', pathname: '/', search: '', href: 'http://localhost/' },
		document: {
			documentElement: { lang: '' },
			head: { appendChild() {} },
			createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
			querySelectorAll: () => [],
			addEventListener() {},
		},
		addEventListener() {}, dispatchEvent() {}, Event: function () {},
		setTimeout, clearTimeout, URL,
		Intl, Math, String, Number, isFinite, Object, Array, JSON, Promise, Error, Date,
	};
	ctx.window = ctx;
	ctx.fetch = async (url, init) => {
		const body = String(url).indexOf('/api/checkout/credits') === 0 && !(init && init.method === 'POST')
			? offer : { ok: false, error: 'not in this fake' };
		return {
			ok: body.ok !== false, status: body.ok !== false ? 200 : 404,
			headers: { get: () => null },
			json: async () => body,
			clone() { return this; },
		};
	};
	vm.createContext(ctx);
	vm.runInContext(I18N, ctx);
	vm.runInContext(EN, ctx);
	vm.runInContext(GW, ctx);
	return { I: ctx.DaimondI18n, G: ctx.DaimondGateway };
}

// ── The quote, from the gateway module ──────────────────────
{
	const { G } = load(OFFER);
	await G.creditOffer();
	check('the gateway module quotes a top-up', typeof G.creditQuote === 'function');
	const q = G.creditQuote ? G.creditQuote(2000) : null;
	check('a preset is the gateway\'s own quote', !!q && q.total === 2255 && q.host === 110
		&& q.fees === 145 && q.credit === 2000, JSON.stringify(q));
	// The rates reproduce the gateway's quote for every preset, so a figure
	// that is not one (a local-currency tier, a typed amount) is priced alike.
	const G2 = load(Object.assign({}, OFFER, { quotes: [] })).G;
	await G2.creditOffer();
	const same = QUOTES.every(g => {
		const c = G2.creditQuote ? G2.creditQuote(g.credit_minor) : null;
		return c && c.total === g.total_minor && c.host === g.host_minor && c.fees === g.fees_minor;
	});
	check('the rates reproduce the gateway\'s preset quotes', same);
	const t = G.creditQuote ? G.creditQuote(1316) : null;
	check('a non-preset amount is itemised and adds up', !!t && t.credit + t.host + t.fees === t.total
		&& t.total > 1316, JSON.stringify(t));
	const txt = G.quoteText ? G.quoteText(2000) : null;
	check('the charged total is said', !!txt && /\$22\.55/.test(txt.charged), JSON.stringify(txt));
	check('the breakdown names credit, host fee and card fees on one line', !!txt
		&& /\$20\.00 credit/.test(txt.breakdown) && /\$1\.10 /.test(txt.breakdown) && /\$1\.45 /.test(txt.breakdown)
		&& !/\n/.test(txt.breakdown), JSON.stringify(txt));
}
{
	const old = Object.assign({}, OFFER);
	delete old.quotes; delete old.fees;
	const { G } = load(old);
	await G.creditOffer();
	check('an older gateway with no rates quotes nothing', G.creditQuote && G.creditQuote(2000) === null
		&& G.quoteText && G.quoteText(2000) === null);
}

// ── The Credits drawer draws it ─────────────────────────────
{
	const at = APP.indexOf('function renderCredits() {');
	const body = APP.slice(at, APP.indexOf('\n\t}\n', at));
	check('each preset is drawn with its quote', /DaimondGateway\.quoteText\(tier\.billedMinor\)/.test(body));
	const oa = APP.slice(APP.indexOf('function otherAmount(note) {'), at);
	check('a typed amount is drawn with its quote', /DaimondGateway\.quoteText\(/.test(oa));
}

// ── Auto-reload: one reload's charge ────────────────────────
function fakeDom() {
	const all = [];
	function node(tag) {
		const n = {
			tagName: tag, children: [], style: {}, attrs: {}, id: '', className: '', value: '', checked: false,
			_text: '', listeners: {},
			classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
			appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
			setAttribute(k, v) { this.attrs[k] = v; },
			addEventListener(k, f) { (this.listeners[k] = this.listeners[k] || []).push(f); },
			get firstChild() { return this.children[0] || null; },
			set innerHTML(v) { this.children = []; this._text = ''; },
			get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
			set textContent(v) { this._text = String(v); this.children = []; },
		};
		all.push(n);
		return n;
	}
	const host = node('div'); host.id = 'autoreload';
	const find = (n, id) => n.id === id ? n : n.children.reduce((a, c) => a || find(c, id), null);
	return {
		host,
		document: {
			createElement: node,
			createTextNode: x => { const n = node('#text'); n._text = String(x); return n; },
			getElementById: id => find(host, id),
		},
	};
}
async function loadAR(settings, saveAnswer) {
	const dom = fakeDom();
	const ctx = {
		console: { log() {}, warn() {}, error() {} },
		navigator: { language: 'en' },
		localStorage: { getItem: k => ({ 'daimond-locale': 'en', 'daimond-currency': 'USD' })[k] || null, setItem() {}, removeItem() {} },
		document: Object.assign({ documentElement: { lang: '' }, head: { appendChild() {} },
			querySelectorAll: () => [], addEventListener() {} }, dom.document),
		addEventListener() {}, dispatchEvent() {}, Event: function () {},
		setTimeout, clearTimeout, Intl, Math, String, Number, isFinite, Object, Array, JSON, Promise, Error, Date,
	};
	ctx.window = ctx;
	vm.createContext(ctx);
	vm.runInContext(I18N, ctx);
	vm.runInContext(EN, ctx);
	// A price tag draws an icon this fake has none of; the meter is not what is tested.
	ctx.DaimondI18n.fillPrices = (el, str) => { el.textContent = str; return el; };
	ctx.DaimondGateway = {
		state: () => ({ authed: true }),
		autoReload: async () => settings,
		setAutoReload: async () => { if (saveAnswer instanceof Error) throw saveAnswer; return saveAnswer; },
		fmtBilled: (m, c) => ctx.DaimondI18n.billedMinor(m, c),
		creditQuote: () => null,
		quoteText: () => null,
	};
	vm.runInContext(AR, ctx);
	await ctx.DaimondAutoReload.render();
	return dom;
}
{
	const S = { ok: true, enabled: true, threshold_minor: 500, topup_minor: 2000, topup_charge_minor: 2255,
		monthly_budget_minor: 10000, spent_this_month_minor: 0, currency: 'usd',
		card: { saved: true, brand: 'visa', last4: '4242' }, last_error: '' };
	const MSG = 'The monthly budget (2000) is smaller than one top-up\'s charge (2255: 2000 of credit plus fees), so auto-reload could never buy anything. Set the budget to at least 2255.';
	const dom = await loadAR(S, new Error(MSG));
	const text = dom.host.textContent;
	check('auto-reload says one reload\'s charge', /US\$22\.55/.test(text) || /\$22\.55/.test(text), text.slice(0, 400));
	const charge = dom.document.getElementById('ar-charge');
	check('the charge line is its own element', !!charge && /22\.55/.test(charge.textContent), charge && charge.textContent);
	const btn = dom.document.getElementById('ar-save');
	await (btn && btn.listeners.click && btn.listeners.click[0]());
	const note = dom.document.getElementById('ar-note');
	check('a budget under the charge is refused with the gateway\'s sentence', !!note && note.textContent === MSG,
		note && note.textContent);
}

console.log(`\ncreditquote: ${checks - failures}/${checks} ok`);
process.exit(failures ? 1 : 0);
