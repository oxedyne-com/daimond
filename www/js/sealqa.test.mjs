/* sealqa.test.mjs -- post-deploy QA r570sqa1 (S1 SEAL): every refusal the wasm seal raises on
   OPEN reaches post.js / peer.js TYPED (`e.refusal`), because TAKEROW keeps a refused row as
   `bad:` and the ack drops the only copy -- so an untyped refusal retries forever and a typed
   transient drops data. And a large binary sealed by the new seal opens in the OLD JavaScript
   (a2bd55bf), the phone not yet reloaded.

   Runs the real store.js, identity.js, post.js and peer.js over the wasm in www/pkg. */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';
import { loadSeal, installSeal, pendingSeal } from './sealfixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let checks = 0, failures = 0;
function check(name, ok, detail) {
	checks++;
	if (ok) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}
const eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

function makeTab(dir, storeInit, withSeal) {
	const store = new Map(Object.entries(storeInit || {}));
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
		key: (i) => Array.from(store.keys())[i] || null,
		get length() { return store.size; },
	};
	const win = {};
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	win.matchMedia = () => ({ matches: false, addListener: () => {}, addEventListener: () => {} });
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
	};
	const document = {
		readyState: 'complete', addEventListener: () => {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	function EventShim(t) { this.type = t; }
	function load(rel, extra) {
		let body = readFileSync(join(dir, rel), 'utf8');
		if (extra) body += extra;
		new Function('window', 'document', 'crypto', 'localStorage', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'Event',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'globalThis',
			'with (window) {\n' + body + '\n}')(
			win, document, webcrypto, localStorage, btoa, atob, TextEncoder, TextDecoder, EventShim,
			setTimeout, clearTimeout, () => 0, () => {},
			{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, globalThis);
	}
	if (withSeal === true) installSeal(win);
	load('store.js');
	load('vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;');
	load('curvefallback.js');
	load('identity.js');
	return { win, store, load };
}

async function refusalOf(p) {
	try { await p; return { opened: true }; }
	catch (e) { return { refusal: e && e.refusal, msg: String(e && e.message || e) }; }
}

async function main() {
	await loadSeal();
	const pass = 'seal qa passphrase, test only';
	const t = makeTab(HERE, null, true);
	t.load('post.js'); t.load('peer.js');
	const I = t.win.DaimondIdentity, P = t.win.DaimondPost, Peer = t.win.DaimondPeer;
	await I.create('Seal QA', pass);
	await I.ensureSealingKey();
	const own = I.sealingKeyRaw();
	const plain = new TextEncoder().encode('qa sealed body');
	const sealed = await P.seal([own], plain);
	check('a fresh record opens', eq(await P.unseal(sealed), plain));

	console.log('Open refusals are typed');
	const other = new Uint8Array(32); other.set(webcrypto.getRandomValues(new Uint8Array(32)));
	const pair = await webcrypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
	const theirs = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey));
	const notMine = await P.seal([theirs], plain);
	let r = await refusalOf(P.unseal(notMine));
	check('non-recipient: refusal not_for_you', r.refusal === 'not_for_you', JSON.stringify(r));
	const body = sealed.slice(); body[body.length - 1] ^= 1;
	r = await refusalOf(P.unseal(body));
	check('flipped body byte: refusal damaged', r.refusal === 'damaged', JSON.stringify(r));
	const slot = sealed.slice(); slot[37 + 14] ^= 1;
	r = await refusalOf(P.unseal(slot));
	check('flipped slot byte: refusal not_for_you', r.refusal === 'not_for_you', JSON.stringify(r));
	const tag = sealed.slice(); tag[3] = 0x32;
	r = await refusalOf(P.unseal(tag));
	check('retagged scheme: refusal not_sealed', r.refusal === 'not_sealed', JSON.stringify(r));
	r = await refusalOf(P.unseal(sealed.slice(0, 60)));
	check('truncated: refusal short', r.refusal === 'short', JSON.stringify(r));

	console.log('Peer DPY2 refusals are typed, and peek passes them on');
	const env = await Peer.sealForSelf(Peer.makeErrand({ turnId: 'qa-t', chatId: 'qa-c', prompt: 'qa',
		model: { provider: 'p', model: 'm', url: '' }, ts: 1760000000000 }));
	const raw = new Uint8Array(Buffer.from(env.envelope, 'base64'));
	const obj = await Peer.openEnvelope(env.envelope);
	check('a fresh DPY2 errand opens', obj && obj.turnId === 'qa-t');
	const flipped = raw.slice(); flipped[flipped.length - 1] ^= 1;
	r = await refusalOf(Peer.openEnvelope(Buffer.from(flipped).toString('base64')));
	check('flipped DPY2: refusal not_for_you', r.refusal === 'not_for_you', JSON.stringify(r));

	console.log('A seal that failed to boot is NOT a refusal (the row stays on the relay)');
	const t2 = makeTab(HERE, Object.fromEntries(t.store), false);
	const boot2 = await pendingSeal(t2.win);
	t2.load('post.js'); t2.load('peer.js');
	await t2.win.DaimondIdentity.unlock(pass);
	boot2.fail(new Error('the wasm did not start'));
	r = await refusalOf(t2.win.DaimondPost.unseal(sealed));
	check('post unseal on a failed boot carries no refusal', !r.opened && !r.refusal, JSON.stringify(r));
	r = await refusalOf(t2.win.DaimondPeer.peek(env.envelope));
	check('peer peek on a failed boot throws without refusal', !r.opened && !r.refusal, JSON.stringify(r));

	console.log('A large binary sealed by the new seal opens in the OLD JavaScript (a2bd55bf)');
	const old = mkdtempSync(join(tmpdir(), 'sealqa-old-'));
	try {
		mkdirSync(join(old, 'vendor'));
		for (const f of ['store.js', 'curvefallback.js', 'identity.js', 'post.js', 'vendor/noble-curves.min.js']) {
			writeFileSync(join(old, f), execFileSync('git', ['-C', HERE, 'show', 'a2bd55bf:www/js/' + f]));
		}
		const ot = makeTab(old, Object.fromEntries(t.store), false);
		ot.load('post.js');
		await ot.win.DaimondIdentity.unlock(pass);
		const big = new Uint8Array(8 * 1024 * 1024);
		for (let i = 0; i < big.length; i += 65536) webcrypto.getRandomValues(big.subarray(i, i + 65536));
		const bigSealed = await P.seal([theirs, own], big);
		let got = null, why = '';
		try { got = await ot.win.DaimondPost.unseal(bigSealed); } catch (e) { why = e.message; }
		check('old JS opens an 8 MB two-recipient record the wasm sealed', got && eq(got, big), why);
		const oldSealed = await ot.win.DaimondPost.seal([own, theirs], big);
		got = null; why = '';
		try { got = await P.unseal(oldSealed); } catch (e) { why = e.message; }
		check('the wasm opens an 8 MB record the old JS sealed', got && eq(got, big), why);
	} finally { rmSync(old, { recursive: true, force: true }); }

	console.log(checks + ' checks, ' + failures + ' failed');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.log('test crashed: ' + (e && e.stack || e)); process.exit(1); });
