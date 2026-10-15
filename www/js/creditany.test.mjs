/* ============================================================
   Test -- CREDITS IN ANY AMOUNT (UNBLOCK-19/20).
   ------------------------------------------------------------
   The gateway owns what a top-up may cost: `GET /api/checkout/credits` states
   the presets and a range, and its POST takes any whole amount in that range.
   The browser used to carry its own constant list, so an Australian tier
   snapped to A$20 (billed US$13.16, 1316) was not one of the amounts the
   gateway would sell, and there was no way to ask for any other figure.

   This reads both files as they ship, against a fake gateway:
   - the presets and range come from the GET, not from a constant;
   - an amount typed in Australian dollars is billed as the presets are;
   - 1316 passes the client's check, and an amount outside the gateway's range
     is refused here, naming the range, with nothing sent.

   On a tree without the fetched offer this is RED.

   Run:  node www/js/creditany.test.mjs
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const I18N = fs.readFileSync(path.join(HERE, 'i18n.js'), 'utf8');
const EN   = fs.readFileSync(path.join(HERE, '..', 'i18n', 'en.js'), 'utf8');
const GW   = fs.readFileSync(path.join(HERE, 'gateway.js'), 'utf8');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// The gateway's answer, deliberately not the old constant, so a build that
// still draws its own list cannot pass.
const OFFER = { ok: true, currency: 'usd', presets: [700, 1300, 4000], min_minor: 500, max_minor: 50000 };

function load(ccy) {
	const store = { 'daimond-locale': 'en', 'daimond-currency': ccy };
	const calls = [];
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
		calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
		const body = String(url).indexOf('/api/checkout/credits') === 0 && !(init && init.method === 'POST')
			? OFFER : { ok: false, error: 'not in this fake' };
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
	return { I: ctx.DaimondI18n, G: ctx.DaimondGateway, calls };
}

{
	const { I, G, calls } = load('AUD');
	check('the gateway module offers creditOffer', typeof G.creditOffer === 'function');
	let offer = null;
	try { offer = await G.creditOffer(); } catch (e) { offer = null; }
	check('the offer is asked of GET /api/checkout/credits',
		calls.some(c => c.url === '/api/checkout/credits' && c.method === 'GET'), JSON.stringify(calls));
	check('the presets are the gateway\'s, not a constant',
		!!offer && JSON.stringify(offer.presets) === JSON.stringify(OFFER.presets), JSON.stringify(offer));
	check('the range is the gateway\'s', !!offer && offer.min === 500 && offer.max === 50000, JSON.stringify(offer));
	check('packs() draws the fetched presets', JSON.stringify(G.packs && G.packs()) === JSON.stringify(OFFER.presets));

	// A figure typed in Australian dollars, billed as the presets are.
	const tier = I.tierFor ? I.tierFor(20) : null;
	check('A$20 typed is billed 1316', !!tier && tier.billedMinor === 1316, JSON.stringify(tier));
	check('A$20 typed reads in Australian dollars', !!tier && /A\$\s?20/.test(tier.localText), tier && tier.localText);
	check('A$20 typed shows the US dollar charge', !!tier && tier.billedText === 'US$13.16', tier && tier.billedText);
	check('nothing typed is no tier', I.tierFor && I.tierFor(0) === null && I.tierFor(NaN) === null);

	// Every snapped local preset is legal as sent.
	const tiers = I.niceTiers(OFFER.presets);
	check('each AUD preset passes the client\'s check',
		tiers.every(t => G.creditRefusal && G.creditRefusal(t.billedMinor) === null),
		JSON.stringify(tiers.map(t => t.billedMinor)));
	check('1316 passes the client\'s check', G.creditRefusal && G.creditRefusal(1316) === null);

	// Out of range: refused here, naming the range, and never sent.
	for (const bad of [400, 50001, 1316.5, -1000]) {
		const why = G.creditRefusal ? G.creditRefusal(bad) : null;
		check(`${bad} is refused client-side`, typeof why === 'string' && why.length > 0, String(why));
		if (bad === 400) check('the refusal names the gateway\'s range', /US\$5\.00/.test(why || '') && /US\$500\.00/.test(why || ''), why);
		const before = calls.length;
		let err = '';
		try { await G.buyCredits(bad); } catch (e) { err = e.message; }
		check(`buyCredits(${bad}) refuses with that sentence`, err === why, err);
		check(`buyCredits(${bad}) sends nothing`, !calls.slice(before).some(c => c.method === 'POST'),
			JSON.stringify(calls.slice(before)));
	}

	// 1316 is past the range check: what stops it here is only that this fake
	// has no account, which is the next step and not the amount.
	let err = '';
	try { await G.buyCredits(1316); } catch (e) { err = e.message; }
	check('buyCredits(1316) is not refused for its amount', err !== (G.creditRefusal ? G.creditRefusal(400) : '') && !/US\$5\.00/.test(err), err);
	check('the offer is asked once', calls.filter(c => c.url === '/api/checkout/credits' && c.method === 'GET').length === 1);
}

{
	const { I } = load('USD');
	const tier = I.tierFor ? I.tierFor(37.5) : null;
	check('US$37.50 typed is billed 3750 as is', !!tier && tier.billedMinor === 3750 && tier.billedText === 'US$37.50', JSON.stringify(tier));
}

console.log(`\ncreditany: ${checks - failures}/${checks} ok`);
process.exit(failures ? 1 : 0);
