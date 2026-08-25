// The read-only text copy must be torn down when a new page opens, and the
// panel must refuse to frame a loopback address. Both exercised via the real
// DaimondWeb driver in the loaded page — no network needed.
//
// PROVED AGAINST TWO BREAKS FIRST, because both checks read a value that is
// `false`/`none` in more than one way:
//   --break keepoverlay   the fresh page is never opened, so the old text copy
//                         is still standing and the teardown check must go red.
//   --break framehost     the loopback probe is aimed at our own blob instead,
//                         which the panel DOES frame, so the refusal check must
//                         go red. Without this the check cannot tell a refusal
//                         from an open that never happened.
//
//   node dev/verify_webpanel.mjs --break keepoverlay   # expected to FAIL
//   node dev/verify_webpanel.mjs --break framehost     # expected to FAIL
//   node dev/verify_webpanel.mjs                       # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, errors } from './harness.mjs';
import { GW_URL } from './ports.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBJS = path.join(HERE, '..', 'www', 'js', 'web.js');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK && !['keepoverlay', 'framehost'].includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; known: keepoverlay, framehost`);
	process.exit(2);
}

const s = await open({ name: 'webpanel' });
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

const r = await s.page.evaluate(async ([brk, GW_URL]) => {
	const W = window.DaimondWeb;
	const out = { hasDriver: !!W };
	if (!W) return out;
	const body = document.getElementById('web-body') || document.querySelector('.web-body');
	out.hasBody = !!body;
	// `_showTextForTest` used to be called here. There is no such export on
	// DaimondWeb and there never was, so the call did nothing and the overlay
	// below was always the hand-built one.
	// A page of our own, so nothing here needs the network.
	const blob = URL.createObjectURL(new Blob(['<h1>fresh</h1>'], { type: 'text/html' }));
	// The overlay is seeded by hand in showText's own shape and under showText's
	// own id: `hideText()` finds it by that id, so this exercises the real
	// teardown even though the text itself was not fetched by the gateway.
	let pre = document.getElementById('web-text');
	if (!pre) { pre = document.createElement('div'); pre.id = 'web-text'; (body || document.body).appendChild(pre); }
	pre.style.display = ''; pre.innerHTML = '<div class="web-text-body">GITHUB TEXT</div>';
	out.beforeOpen = { display: pre.style.display, text: pre.textContent };

	if (brk !== 'keepoverlay') {
		try { await W.open(blob); } catch (e) { out.openErr = e.message; }
	} else {
		out.skippedOpen = true;
	}
	const after = document.getElementById('web-text');
	out.afterOpenDisplay = after ? after.style.display : 'removed';
	out.afterOpenText = after ? after.textContent : '';

	// Loopback must be refused (not framed). Under `framehost` the same question
	// is asked of a page the panel is entitled to frame.
	const probe = brk === 'framehost' ? blob : `${GW_URL}/api/balance`;
	out.probe = brk === 'framehost' ? 'our own blob' : probe;
	try {
		const res = await W.open(probe);
		out.loopback = { framed: res.framed, driver: res.driver };
	} catch (e) { out.loopbackErr = e.message; }
	return out;
}, [BREAK, GW_URL]);
console.log(JSON.stringify(r, null, 2));
await shot(s, 'webpanel-after');

check('the web panel driver and its body are on the page', r.hasDriver && r.hasBody,
	`driver ${!!r.hasDriver}, body ${!!r.hasBody}`);
// The overlay is seeded by hand, so the id it is seeded under has to be the one
// the app's own `showText` uses -- otherwise this file tears down its own div
// and calls that a pass while the real copy stays on the screen.
const ID = "pre.id = 'web-text';";
const seeded = fs.readFileSync(WEBJS, 'utf8').split(ID).length - 1;
check('the id the overlay is seeded under is the id showText uses', seeded === 1,
	`"${ID}" appears ${seeded} times in www/js/web.js`);
check('a read-only text copy is standing before the next page opens',
	!!(r.beforeOpen && r.beforeOpen.text), JSON.stringify(r.beforeOpen));
check('A FRESH PAGE TEARS THE OLD TEXT COPY DOWN — no site\'s words under another site\'s header',
	(r.afterOpenDisplay === 'none' || r.afterOpenDisplay === 'removed') && !r.afterOpenText,
	`display ${r.afterOpenDisplay}, text ${JSON.stringify((r.afterOpenText || '').slice(0, 40))}`
	+ (r.skippedOpen ? ' (no page was opened)' : '') + (r.openErr ? ' openErr: ' + r.openErr : ''));
check('A LOOPBACK ADDRESS IS REFUSED THE FRAME',
	!!r.loopback && r.loopback.framed === false,
	r.loopback ? `${r.probe}: framed=${r.loopback.framed} driver=${r.loopback.driver}` : 'threw: ' + r.loopbackErr);

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(x => console.log('  FAILED: ' + x)); process.exit(1); }
