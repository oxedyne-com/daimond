/* sealboot.test.mjs -- a message sent before the wasm is up WAITS for it; it does not throw.

   post.js seals and opens through `window.DaimondSeal` (S1 SEAL, daimond.js), whose every entry
   point awaits the module being instantiated. The page instantiates it in `init()`, late in boot,
   so without that wait a send made in the gap would throw on an unbound wasm where the WebCrypto
   seal it replaced did not. This runs the REAL store.js, identity.js and post.js in a stand-in
   tab over a FRESH, not yet instantiated module (www/js/sealfixture.mjs `pendingSeal`), and:

     1. a DaimondPost.seal made before init is still pending, not rejected, while init has not run;
     2. once the boot instantiates the module and marks the bridge ready, it resolves to a record
        that opens to the same bytes;
     3. an open made before init waits the same way;
     4. a boot that FAILED rejects a waiting send with its error, so nothing hangs;
     5. a send made while the page still parses, before daimond.js has published the bridge,
        waits for DOMContentLoaded rather than throwing.

   Needs www/pkg (dev/build-wasm.sh --no-opt). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { pendingSeal, loadSeal, installSeal } from './sealfixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let checks = 0, failures = 0;
function check(name, ok, detail) {
	checks++;
	if (ok) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

function makeTab(parsing) {
	const domReady = [], winLoad = [];
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	win.addEventListener = (t, f) => { if (t === 'load') winLoad.push(f); };
	win.dispatchEvent = () => true;
	win.matchMedia = () => ({ matches: false, addListener: () => {}, addEventListener: () => {} });
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
	};
	const document = {
		readyState: parsing === true ? 'loading' : (parsing || 'complete'),
		addEventListener: (t, f) => { if (t === 'DOMContentLoaded') domReady.push(f); },
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	function EventShim(t) { this.type = t; }
	function load(rel, extra) {
		let body = readFileSync(join(HERE, rel), 'utf8');
		if (extra) body += extra;
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'Event',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'globalThis',
			'with (window) {\n' + body + '\n}');
		fn(win, document, webcrypto, localStorage, btoa, atob, TextEncoder, TextDecoder, EventShim,
			setTimeout, clearTimeout, () => 0, () => {},
			{ log: () => {}, debug: () => {}, warn: () => {}, error: console.error }, globalThis);
	}
	load('store.js');
	load('vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;');
	load('curvefallback.js');
	load('identity.js');
	const parsed = () => { document.readyState = 'interactive'; domReady.splice(0).forEach((f) => f()); };
	const loaded = () => { document.readyState = 'complete'; winLoad.splice(0).forEach((f) => f()); };
	return { win, load, parsed, loaded };
}

const settledWithin = (p, ms) => Promise.race([
	p.then(() => 'resolved', () => 'rejected'),
	new Promise((r) => setTimeout(() => r('pending'), ms)),
]);
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

async function main() {
	console.log('A send before the wasm is up waits for it');
	const { win, load } = makeTab();
	const boot = await pendingSeal(win);
	load('post.js');
	const I = win.DaimondIdentity, P = win.DaimondPost;
	await I.create('Seal Boot', 'seal boot passphrase, test only');
	await I.ensureSealingKey();
	const own = I.sealingKeyRaw();

	let unbound = false;
	try { boot.mod.seal_peer_aad(); } catch (e) { unbound = true; }
	check('the module is really not instantiated yet (a direct call throws)', unbound);

	const plain = new TextEncoder().encode('sent before init');
	const sending = P.seal([own], plain);
	check('a seal made before init is still pending, not thrown', (await settledWithin(sending, 150)) === 'pending');

	// An open made before init waits too: seal a record on a ready tab with the same keys.
	await loadSeal();
	const ready = installSeal({});
	const early = await ready.sealPost([own], plain);
	const opening = P.unseal(early);
	check('an open made before init is still pending, not thrown', (await settledWithin(opening, 150)) === 'pending');

	boot.start();
	let sealed = null, why = '';
	try { sealed = await sending; } catch (e) { why = e.message; }
	check('after init, the early send resolves to a sealed record', sealed instanceof Uint8Array && sealed.length > 100, why);
	check('and the record opens to what was sent', sealed && eq(await P.unseal(sealed), plain));
	let opened = null;
	try { opened = await opening; } catch (e) { why = e.message; }
	check('the early open resolves to the plaintext', opened && eq(opened, plain), why);

	console.log('A boot that failed rejects a waiting send');
	const t2 = makeTab();
	const boot2 = await pendingSeal(t2.win);
	t2.load('post.js');
	const waiting = t2.win.DaimondPost.seal([own], plain);
	boot2.fail(new Error('the wasm did not start'));
	let msg = '';
	try { await waiting; } catch (e) { msg = e.message; }
	check('the waiting send rejects with the boot error, rather than hanging', /did not start/.test(msg), msg);

	console.log('A send while the page still parses waits for the bridge to be published');
	const t3 = makeTab(true);
	t3.load('post.js');
	const parsingSend = t3.win.DaimondPost.seal([own], plain);
	check('a seal made before daimond.js has run is pending, not thrown', (await settledWithin(parsingSend, 100)) === 'pending');
	installSeal(t3.win);	// the module script runs ...
	t3.parsed();			// ... and then DOMContentLoaded fires
	let late = null; why = '';
	try { late = await parsingSend; } catch (e) { why = e.message; }
	check('and it resolves once the bridge is there', late instanceof Uint8Array && eq(await P.unseal(late), plain), why);

	console.log('D3: interactive, DOMContentLoaded already past: the send waits for load');
	const t4 = makeTab('interactive');
	t4.load('post.js');
	const lateSend = t4.win.DaimondPost.seal([own], plain);
	check('a seal made in the interactive gap is pending, not thrown', (await settledWithin(lateSend, 100)) === 'pending');
	installSeal(t4.win);
	t4.loaded();
	let lateBytes = null; why = '';
	try { lateBytes = await lateSend; } catch (e) { why = e.message; }
	check('and it resolves on load', lateBytes instanceof Uint8Array, why);

	console.log('D4: a boot that throws before its own try still fails the waiting seals');
	{
		const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
		const a = src.indexOf('\tboot().then(');
		const b = src.indexOf('});', a) + 3;
		check('daimond.js has the boot().then(..) statement', a > 0 && b > a);
		const t5 = makeTab();
		const boot5 = await pendingSeal(t5.win);
		void boot5;
		t5.load('post.js');
		const hung = t5.win.DaimondPost.seal([own], plain);
		const boom = async () => { throw new Error('boot threw before its try'); };
		const done = new Function('window', 'boot', 'handleCheckoutReturn', src.slice(a, b) + '\n;')
			(t5.win, boom, () => {});
		void done;
		process.on('unhandledRejection', () => {});
		let m5 = '';
		const r5 = await settledWithin(hung.catch((e) => { m5 = e.message; throw e; }), 500);
		check('the waiting send rejects with the boot error rather than hanging', r5 === 'rejected' && /before its try/.test(m5), r5 + ' ' + m5);
	}

	console.log('D5: a tampered body is refused in the page\'s own words');
	{
		const bad = new Uint8Array(sealed); bad[bad.length - 1] ^= 1;
		let m6 = '', code = null;
		try { await P.unseal(bad); } catch (e) { m6 = e.message; code = e.code; }
		check('the refusal is post.err_damaged, not the Rust sentence', /changed after it was sealed/.test(m6) && !/seal:/.test(m6), m6);
	}

	console.log(checks + ' checks, ' + failures + ' failed');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.log('test crashed: ' + (e && e.stack || e)); process.exit(1); });
