// The read-only text copy must be torn down when a new page opens, and the
// panel must refuse to frame a loopback address. Both exercised via the real
// DaimondWeb driver in the loaded page — no network needed.
import { open, shot } from './harness.mjs';

const s = await open({ name: 'webpanel' });

const r = await s.page.evaluate(async () => {
	const W = window.DaimondWeb;
	const out = {};
	// 1. Show a read-only text copy (as 'Read it as text' does), then open a
	//    fresh page, and see whether the copy is still overlaying it.
	if (W && W._showTextForTest) W._showTextForTest('GitHub', 'GITHUB TEXT');
	// Fall back to calling the internal path via a synthesised text view:
	const body = document.getElementById('web-body') || document.querySelector('.web-body');
	out.hasBody = !!body;
	// Directly drive: open a blob page (same-origin, needs no network).
	const blob = URL.createObjectURL(new Blob(['<h1>fresh</h1>'], { type: 'text/html' }));
	// Seed a text overlay by hand, mimicking showText's DOM, to test teardown.
	let pre = document.getElementById('web-text');
	if (!pre) { pre = document.createElement('div'); pre.id = 'web-text'; (body||document.body).appendChild(pre); }
	pre.style.display = ''; pre.innerHTML = '<div class="web-text-body">GITHUB TEXT</div>';
	out.beforeOpen = pre.style.display;   // '' == visible
	try { await W.open(blob); } catch (e) { out.openErr = e.message; }
	const after = document.getElementById('web-text');
	out.afterOpenDisplay = after ? after.style.display : 'removed';
	out.afterOpenText = after ? after.textContent : '';

	// 2. Loopback must be refused (not framed).
	try {
		const res = await W.open('http://127.0.0.1:9002/api/balance');
		out.loopback = { framed: res.framed, driver: res.driver };
	} catch (e) { out.loopbackErr = e.message; }
	return out;
});
console.log(JSON.stringify(r, null, 2));
await shot(s, 'webpanel-after');
console.log('\nSTALE OVERLAY FIXED:', r.afterOpenDisplay === 'none' || r.afterOpenDisplay === 'removed');
console.log('LOOPBACK REFUSED:', r.loopback ? r.loopback.framed === false : ('err: ' + r.loopbackErr));
await s.close();
