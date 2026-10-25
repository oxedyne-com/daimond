/* ============================================================
   Test -- keeping the identity, and getting it back (F3b, R1).
   ------------------------------------------------------------
   Drives the REAL identity.js in a stand-in window, as
   identity.test.mjs does, with a stand-in `navigator.storage`
   that counts what it is asked.

     (a) KEEP. `persist()` is asked at create, and once at load
         for an identity that is not persisted yet; never when
         the browser already says it is persisted, and never at
         load on a device that holds no identity.

   Run:  node www/js/recoverable.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, passes = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); passes++; }
	else { console.log('  FAIL ' + line); failures++; }
}

const SRC = readFileSync(join(HERE, 'identity.js'), 'utf8');
const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
const atob = (s) => Buffer.from(s, 'base64').toString('binary');
function EventShim(t) { this.type = t; }
const tick = () => new Promise((r) => setTimeout(r, 0));

function mkStore(m) {
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => m.set(k, String(v)),
		removeItem: (k) => m.delete(k),
	};
}

const UA = {
	iphone:  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
	mac:     'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
	android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
	linux:   'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};

/// A browser's storage manager: `kept` is what `persisted()` answers, `grant` what
/// `persist()` answers (and then what `persisted()` answers after it).
function mkNav(o) {
	const nav = { asked: 0, storage: null, standalone: o.standalone,
		userAgent: o.ua || UA.linux, maxTouchPoints: o.touch | 0 };
	if (o.storage !== false) {
		nav.storage = {
			persisted: async () => !!o.kept,
			persist:   async () => { nav.asked++; if (o.grant) o.kept = true; return !!o.grant; },
		};
	}
	return nav;
}

function load(o) {
	const disk = o.disk || new Map();
	const fired = [];
	const win = {};
	win.window = win;
	win.dispatchEvent = (ev) => { fired.push(ev && ev.type); return true; };
	win.document = { readyState: 'complete', addEventListener: () => {} };
	win.navigator = o.nav;
	win.matchMedia = (q) => ({ matches: !!o.displayStandalone && /standalone/.test(q) });
	if (o.passkey !== undefined) win.DaimondPasskey = { isEnrolled: () => !!o.passkey };
	win.sessionStorage = mkStore(new Map());
	const localStorage = mkStore(disk);
	loadStore(win, localStorage);
	new Function('window', 'crypto', 'localStorage', 'btoa', 'atob',
		'TextEncoder', 'TextDecoder', 'Event', 'console', 'globalThis', SRC)(
		win, webcrypto, localStorage, btoa, atob,
		TextEncoder, TextDecoder, EventShim, console, globalThis);
	return { ID: win.DaimondIdentity, disk, fired, win };
}

const PASS = 'correct horse battery staple frigate';

async function main() {
	console.log('keep: persist() at create, and once at load');
	{
		const nav = mkNav({ kept: false, grant: true });
		const a = load({ nav });
		await tick();
		check('a device with no identity is not asked at load', nav.asked === 0, 'asked ' + nav.asked);
		await a.ID.create('Tester', PASS);
		await tick();
		check('create asks the browser to keep the store', nav.asked === 1, 'asked ' + nav.asked);

		const nav2 = mkNav({ kept: false, grant: false });
		load({ disk: a.disk, nav: nav2 });
		await tick(); await tick();
		check('a load with an identity not yet persisted asks once', nav2.asked === 1, 'asked ' + nav2.asked);

		const nav3 = mkNav({ kept: true, grant: true });
		const c = load({ disk: a.disk, nav: nav3 });
		await tick(); await tick();
		check('a load the browser already keeps does not ask', nav3.asked === 0, 'asked ' + nav3.asked);
		check('keep() answers true when already kept', (await c.ID.keep()) === true);
		check('and still asks nothing', nav3.asked === 0);

		const nav4 = mkNav({ storage: false });
		const d = load({ disk: a.disk, nav: nav4 });
		check('an engine with no storage manager answers false, quietly', (await d.ID.keep()) === false);
	}


	console.log('recoverable: what would bring this identity back');
	{
		const a = load({ nav: mkNav({ kept: true }) });
		check('no identity: nothing to recover', a.ID.recoverable() === '');
		await a.ID.create('Tester', PASS);
		check('a fresh identity is not recoverable', a.ID.recoverable() === '', JSON.stringify(a.ID.recoverable()));
		const snap0 = JSON.stringify(a.ID.recoverSnapshot());
		check('the snapshot has a fixed shape with nothing in it',
			snap0 === JSON.stringify({ v: 1, pk: { pub: '', on: 0, t: 0 }, file: { pub: '', epoch: 0, t: 0 } }), snap0);
		a.fired.length = 0;
		check('a saved file is noted', a.ID.noteRecovery('file') === true);
		check('and makes it recoverable by file', a.ID.recoverable() === 'file');
		check('and says so', a.fired.includes('daimond:recoverable'), a.fired.join(','));
		check('an unknown kind is refused', a.ID.noteRecovery('wish') === false);

		// The file is this identity's at this epoch: a passphrase change makes a new one owed.
		a.disk.set('daimond-id-epoch', '1');
		check('a file saved before a passphrase change no longer counts', a.ID.recoverable() === '');
		a.disk.delete('daimond-id-epoch');
		check('back at its epoch it counts again', a.ID.recoverable() === 'file');

		check('a passkey the gateway holds is noted', a.ID.noteRecovery('passkey', true) === true);
		check('and is named first', a.ID.recoverable() === 'passkey');
		a.ID.noteRecovery('passkey', false);
		check('a removed passkey leaves the file', a.ID.recoverable() === 'file');

		// Another device of the same identity, which has heard nothing yet.
		const b = load({ disk: new Map([...a.disk].filter(([k]) => k !== 'daimond-id-recover')), nav: mkNav({ kept: true }) });
		check('the other device starts unrecoverable', b.ID.recoverable() === '');
		const sent = a.ID.recoverSnapshot();
		check('it adopts the record from the parcel', b.ID.adoptRecover(sent) === true);
		check('and the file counts there too', b.ID.recoverable() === 'file');
		const before = b.disk.get('daimond-id-recover');
		check('adopting the same record moves nothing', b.ID.adoptRecover(sent) === false
			&& b.disk.get('daimond-id-recover') === before);
		check('the record goes back out byte for byte', JSON.stringify(b.ID.recoverSnapshot()) === JSON.stringify(sent));
		const old = JSON.parse(JSON.stringify(sent)); old.file.t = 1; old.file.pub = 'someone-else';
		b.ID.adoptRecover(old);
		check('an older record does not bury a newer one', b.ID.recoverable() === 'file');

		// A tie is settled the same way on both sides, and never towards "recoverable" (R1).
		const tie1 = { v: 1, pk: { pub: sent.file.pub, on: 1, t: 9e12 }, file: sent.file };
		const tie0 = { v: 1, pk: { pub: sent.file.pub, on: 0, t: 9e12 }, file: sent.file };
		b.ID.adoptRecover(tie1); b.ID.adoptRecover(tie0);
		const x = b.ID.recoverSnapshot().pk.on;
		b.ID.adoptRecover(tie1);
		check('on an equal stamp, the removal wins, whichever arrives last', x === 0 && b.ID.recoverSnapshot().pk.on === 0);

		// A record naming another identity is inert here.
		const c = load({ nav: mkNav({ kept: true }) });
		await c.ID.create('Other', PASS);
		c.ID.adoptRecover(a.ID.recoverSnapshot());
		check("another identity's record does not make this one recoverable", c.ID.recoverable() === '');
		for (const junk of [null, 'x', { v: 1, pk: 'no', file: { pub: 5, epoch: 'a', t: -1 } }]) c.ID.adoptRecover(junk);
		check('junk in the parcel is ignored', c.ID.recoverable() === '');
	}
	{
		const disk = new Map();
		const a = load({ disk, nav: mkNav({ kept: true }) });
		await a.ID.create('Tester', PASS);
		const ios = load({ disk, nav: mkNav({ kept: true, standalone: true, ua: UA.iphone }) });
		check("iOS's home-screen app counts", ios.ID.recoverable() === 'home');
		const ipad = load({ disk, nav: mkNav({ kept: true, ua: UA.mac, touch: 5 }), displayStandalone: true });
		check("iPadOS's home-screen app (a Mac with touch) counts", ipad.ID.recoverable() === 'home');
		// M1: an installed web app elsewhere is still one browser profile, which "clear data" or
		// an eviction removes, so it is not a way back.
		const desk = load({ disk, nav: mkNav({ kept: true, ua: UA.linux }), displayStandalone: true });
		check('a desktop install does not count', desk.ID.recoverable() === '', desk.ID.recoverable());
		const and = load({ disk, nav: mkNav({ kept: true, ua: UA.android, touch: 5 }), displayStandalone: true });
		check('an Android install does not count', and.ID.recoverable() === '', and.ID.recoverable());
		const dock = load({ disk, nav: mkNav({ kept: true, standalone: true, ua: UA.mac }), displayStandalone: true });
		check('a Mac Dock web app does not count', dock.ID.recoverable() === '', dock.ID.recoverable());
		check('an iOS tab does not', load({ disk, nav: mkNav({ kept: true, ua: UA.iphone }) }).ID.recoverable() === '');
		check('a tab does not', load({ disk, nav: mkNav({ kept: true }) }).ID.recoverable() === '');
		check('home is not a record that travels', JSON.stringify(ios.ID.recoverSnapshot()).indexOf('home') === -1);
	}

	console.log(`\n${passes} ok, ${failures} failed`);
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
