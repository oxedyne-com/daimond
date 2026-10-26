/* ============================================================
   Test — the browser the lens `boot` event names (LENS-UA, 26 Oct 2026).
   ------------------------------------------------------------
   `browserOf` lives inside `www/js/daimond.js` beside `uaBrand` and
   `shortBrand`, which it reuses, and daimond.js cannot be loaded whole in
   Node (see devicename.test.mjs). So the exact bodies are lifted out of the
   real source with a brace-balanced scan and run against real user-agent
   strings, with and without `navigator.userAgentData`.

   What is proved: engine (Blink, Gecko, WebKit), brand and major version for
   Chrome desktop, Chrome Android, Firefox desktop, Safari macOS, iOS Safari,
   an iOS Home Screen app and Edge; nothing else rides (no OS build); the
   boot call site sends it; and the field passes debugshare's redactor and
   scrub.js's content scrubber unchanged.

   Run:  node www/js/browserua.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

function extractFn(src, name) {
	const start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) throw new Error('function not found in daimond.js: ' + name);
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
let browserOf = null;
try {
	const lifted = ['uaBrand', 'shortBrand', 'browserOf', 'brandsOf'].map((n) => extractFn(src, n)).join('\n');
	browserOf = new Function(lifted + '\nreturn browserOf;')();
} catch (e) {
	check('browserOf exists in daimond.js', false, e.message);
}

// Real strings, as each browser sends them.
const UA = {
	chromeDesk:  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	chromeAnd:   'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.81 Mobile Safari/537.36',
	firefoxDesk: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
	safariMac:   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
	iosSafari:   'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
	iosHome:     'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
	edgeDesk:    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.56',
	chromeIos:   'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
	firefoxIos:  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15',
};
const uad = (brands) => ({ brands, mobile: false, platform: 'Linux' });
const CHROME_UAD = uad([{ brand: 'Not?A_Brand', version: '99' }, { brand: 'Chromium', version: '130' }, { brand: 'Google Chrome', version: '130' }]);
const EDGE_UAD   = uad([{ brand: 'Microsoft Edge', version: '130' }, { brand: 'Not?A_Brand', version: '99' }, { brand: 'Chromium', version: '130' }]);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CASES = [
	['Chrome desktop',            UA.chromeDesk,  CHROME_UAD, { engine: 'Blink',  brand: 'Chrome',  major: 130 }],
	['Chrome desktop, UA only',   UA.chromeDesk,  null,       { engine: 'Blink',  brand: 'Chrome',  major: 130 }],
	['Chrome Android',            UA.chromeAnd,   null,       { engine: 'Blink',  brand: 'Chrome',  major: 129 }],
	['Firefox desktop',           UA.firefoxDesk, null,       { engine: 'Gecko',  brand: 'Firefox', major: 131 }],
	['Safari macOS',              UA.safariMac,   null,       { engine: 'WebKit', brand: 'Safari',  major: 18 }],
	['iOS Safari',                UA.iosSafari,   null,       { engine: 'WebKit', brand: 'Safari',  major: 18 }],
	['iOS Home Screen app',       UA.iosHome,     null,       { engine: 'WebKit', brand: 'Safari',  major: 17 }],
	['Edge desktop',              UA.edgeDesk,    EDGE_UAD,   { engine: 'Blink',  brand: 'Edge',    major: 130 }],
	['Edge desktop, UA only',     UA.edgeDesk,    null,       { engine: 'Blink',  brand: 'Edge',    major: 130 }],
	['Chrome on iOS is WebKit',   UA.chromeIos,   null,       { engine: 'WebKit', brand: 'Chrome',  major: 130 }],
	['Firefox on iOS is WebKit',  UA.firefoxIos,  null,       { engine: 'WebKit', brand: 'Firefox', major: 132 }],
	['nothing recognisable',      '',             null,       { engine: '',       brand: '',        major: null }],
];

console.log('browserua: engine, brand and major per browser');
if (browserOf) {
	for (const [name, ua, ud, want] of CASES) {
		let got;
		try { got = browserOf(ua, ud); } catch (e) { got = { threw: e.message }; }
		check(name + ' -> ' + JSON.stringify(want), same(got, want), JSON.stringify(got));
	}
	const keys = Object.keys(browserOf(UA.iosSafari, null)).sort().join(',');
	check('only engine, brand and major ride', keys === 'brand,engine,major', keys);
	check('a userAgentData that throws falls back to the string', (() => {
		const bad = {}; Object.defineProperty(bad, 'brands', { get() { throw new Error('x'); } });
		try { return same(browserOf(UA.firefoxDesk, bad), CASES[3][3]); } catch (e) { return false; }
	})());
}

console.log('browserua: the boot call site sends it');
{
	const at = src.indexOf("dsEvent('boot', {");
	const call = at < 0 ? '' : src.slice(at, src.indexOf('});', at));
	check('boot carries browser: browserOf(navigator.userAgent, navigator.userAgentData)',
		/browser:[^\n]*browserOf\(navigator\.userAgent, navigator\.userAgentData\)/.test(call));
}

console.log('browserua: the field passes the scrubbers unchanged');
{
	const require = createRequire(import.meta.url);
	const SCRUB = require(join(HERE, 'scrub.js'));
	for (const [name, ua, ud, want] of CASES.slice(0, 8)) {
		const ev = { v: 1, d: 'abc', n: 1, b: 'fx', t: 1, ua: 'desktop', browser: want };
		const red = SCRUB.redact(JSON.parse(JSON.stringify(ev)));
		const deep = SCRUB.scrubDeep(JSON.parse(JSON.stringify(ev)));
		check(name + ': redactor and content scrubber leave browser as sent',
			same(red.browser, want) && same(deep.browser, want), JSON.stringify([red.browser, deep.browser]));
	}
}

console.log(failures ? `\n${failures} failed` : '\nall ok');
process.exit(failures ? 1 : 0);
