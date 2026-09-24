/* ============================================================
   Test — staying unlocked across a reload (www/js/identity.js).
   ------------------------------------------------------------
   Drives the REAL module in a simulated tab: a Map-backed
   localStorage that survives a "reload", a Map-backed
   sessionStorage that survives a reload of the SAME tab only,
   real WebCrypto, and a capture of the debug feed. A reload is
   loading identity.js a second time against the same two stores,
   which is what a new tab and a reloaded tab actually differ by.

   The properties under test are the ones the ruling of
   2026-09-13 turns on:

     (a) THE SETTING. Default ON for a desktop, OFF for a phone,
         and an explicit answer beats both.
     (b) WHAT IS KEPT. The derived key material, in the TAB's
         sessionStorage and nowhere else -- never the passphrase,
         and nothing of it in localStorage.
     (c) THE RESTORE. A reload comes back unlocked with no
         passphrase typed, and the restored key opens what the
         typed one sealed. The feed says `unlock {via:'session'}`,
         so a restored unlock is distinguishable from a typed one.
     (d) NOTHING STORED WHEN OFF, and a reload then stays locked.
     (e) CLEARED on lock, on forget-me, and on the removal path
         (daimond.js `onThisDeviceRemoved`, which resets and locks).
     (f) STALE MATERIAL IS NOT A LOCK-OUT. A key that no longer
         opens the stored one is dropped, and the tab asks for the
         passphrase as it always did; a changed passphrase replaces
         what is remembered rather than stranding it.

   Run:  node www/js/identity.test.mjs
   (Node 20+, whose WebCrypto implements Ed25519 and X25519.)
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

function mkStore(m) {
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => m.set(k, String(v)),
		removeItem: (k) => m.delete(k),
	};
}

/// One load of identity.js. `disk` is the localStorage Map (survives everything
/// short of a new browser profile) and `tab` the sessionStorage Map (survives a
/// reload of this tab, and nothing else) -- so passing both is a reload, passing a
/// fresh `tab` is a new tab, and passing no `tab` at all is a host without one.
function load(opts) {
	const o = opts || {};
	const disk = o.disk || new Map();
	const tab  = o.tab === null ? null : (o.tab || new Map());
	const events = [];
	const fired = [];
	const win = {};
	win.window = win;
	win.dispatchEvent = (ev) => { fired.push(ev && ev.type); return true; };
	// A document that has FINISHED loading, so `announceWhenReady` announces at once.
	// A page still parsing defers to DOMContentLoaded, which is the whole point of it:
	// the modules that listen for `daimond:unlock` load after this one.
	const ready = [];
	win.document = { readyState: o.loading ? 'loading' : 'complete',
		addEventListener: (k, fn) => { if (k === 'DOMContentLoaded') ready.push(fn); } };
	win.DEBUG_SHARE = { event: (kind, payload) => events.push({ kind, payload }) };
	if (o.mobile !== undefined) win.DaimondShell = { isMobileDevice: () => !!o.mobile };
	if (tab) win.sessionStorage = mkStore(tab);
	const localStorage = mkStore(disk);
	loadStore(win, localStorage);
	const fn = new Function(
		'window', 'crypto', 'localStorage', 'btoa', 'atob',
		'TextEncoder', 'TextDecoder', 'Event', 'console', 'globalThis',
		SRC);
	fn(win, webcrypto, localStorage, btoa, atob,
		TextEncoder, TextDecoder, EventShim, console, globalThis);
	return { ID: win.DaimondIdentity, disk, tab, events, fired, win,
		// Fire DOMContentLoaded, for a page that was still parsing when it restored.
		loaded: () => ready.forEach((fn) => fn({ type: 'DOMContentLoaded' })),
		kinds: () => events.map((e) => e.kind),
		via:   () => events.filter((e) => e.kind === 'unlock').map((e) => e.payload.via) };
}

const S_KEY = 'daimond-id-session';
const PASS   = 'correct horse battery staple frigate';
const PASS2  = 'another seven word passphrase entirely different here';

async function main() {
	console.log('identity: the setting, and what it defaults to');
	{
		const a = load({ mobile: false });
		check('a desktop keeps its session by default', a.ID.stayUnlocked() === true);
		const b = load({ mobile: true });
		check('a phone does not', b.ID.stayUnlocked() === false);
		const c = load({});
		check('a device that cannot say reads as a desktop', c.ID.stayUnlocked() === true);
		b.ID.setStayUnlocked(true);
		check('an explicit yes beats the phone default', b.ID.stayUnlocked() === true);
		check('and it is written per device, not synced',
			b.disk.get('daimond-stay-unlocked') === '1');
		a.ID.setStayUnlocked(false);
		check('an explicit no beats the desktop default', a.ID.stayUnlocked() === false);
	}

	console.log('\nidentity: what is kept, and where');
	const disk = new Map();
	const tab  = new Map();
	{
		const t = load({ disk, tab, mobile: false });
		await t.ID.create('Tester', PASS);
		check('create leaves the tab unlocked', t.ID.isUnlocked() === true);
		check('and remembers the session for this tab', !!tab.get(S_KEY));
		t.ID.lock();
		check('lock drops it', tab.get(S_KEY) === undefined);

		const r = await t.ID.unlock(PASS);
		check('a typed unlock succeeds', !!r && r.ok === true);
		check('and remembers the session again', !!tab.get(S_KEY));
		check('the feed calls a typed unlock typed', t.via().includes('typed'));

		const rec = JSON.parse(tab.get(S_KEY));
		check('what is kept is 32 bytes of derived key',
			Buffer.from(rec.k, 'base64').length === 32);
		check('the passphrase is not in it', !tab.get(S_KEY).includes(PASS));
		check('and no word of it either', !tab.get(S_KEY).includes('correct'));
		let onDisk = false;
		for (const v of disk.values()) if (String(v).includes(rec.k)) onDisk = true;
		check('nothing in localStorage holds the key', onDisk === false);
		check('sessionStorage holds exactly the one record', tab.size === 1);
	}

	console.log('\nidentity: the restore, on a reload of the same tab');
	let sealed = null;
	{
		const t = load({ disk, tab, mobile: false });
		const r = await t.ID.unlock(PASS);
		check('the tab is unlocked to start with', !!r && r.ok === true);
		sealed = await t.ID.wrap('the BYOK key this account holds');

		// THE RELOAD: the same disk, the same tab, a fresh module.
		const u = load({ disk, tab, mobile: false });
		const got = await u.ID.restoring();
		check('the boot attempt restored the session', !!got && got.ok === true);
		check('and says it came from the session', got.via === 'session');
		check('isUnlocked() is true with no passphrase typed', u.ID.isUnlocked() === true);
		check('the feed can tell it from a typed unlock',
			u.via().length === 1 && u.via()[0] === 'session');
		check('the unlock was announced to the app', u.fired.includes('daimond:unlock'));
		check('the restored key opens what the typed one sealed',
			(await u.ID.unwrap(sealed)) === 'the BYOK key this account holds');
		check('it can sign, so the signing key came back too',
			typeof (await u.ID.sign('anything')) === 'string');
		// The fingerprint is a RENDERING the wasm bridge draws, and there is no bridge
		// here, so what is asserted is that a restore answers with the same thing a
		// typed unlock answers with -- not that either has one.
		check('the name comes back with it', got.name === 'Tester');
		check('and the fingerprint is whatever the device holds',
			got.fingerprint === u.ID.fingerprint());

		// A page still PARSING defers the announcement to DOMContentLoaded. identity.js
		// is loaded before the modules that listen for it, so announcing the moment the
		// restore finished would announce to nobody.
		const w = load({ disk, tab, mobile: false, loading: true });
		const late = await w.ID.restoring();
		check('a restore during parsing still restores', !!late && late.ok === true);
		check('and holds the announcement back', !w.fired.includes('daimond:unlock'));
		w.loaded();
		check('until the listeners exist', w.fired.includes('daimond:unlock'));

		// A NEW TAB is not a reload: sessionStorage is per tab.
		const v = load({ disk, tab: new Map(), mobile: false });
		const none = await v.ID.restoring();
		check('a NEW tab restores nothing', !none.ok && none.reason === 'none');
		check('and stays locked', v.ID.isUnlocked() === false);
	}

	console.log('\nidentity: with the setting off, nothing is stored');
	{
		const d2 = new Map(disk), t2 = new Map();
		const t = load({ disk: d2, tab: t2, mobile: false });
		t.ID.setStayUnlocked(false);
		const r = await t.ID.unlock(PASS);
		check('the unlock itself still works', !!r && r.ok === true);
		check('nothing was written to the tab', t2.get(S_KEY) === undefined);
		const u = load({ disk: d2, tab: t2, mobile: false });
		const got = await u.ID.restoring();
		check('so a reload restores nothing', !got.ok);
		check('and comes back locked', u.ID.isUnlocked() === false);
	}
	{
		// Turning it off mid-session drops what is already there, so the answer is
		// true of THIS tab and not only of the next one.
		const d3 = new Map(disk), t3 = new Map();
		const t = load({ disk: d3, tab: t3, mobile: false });
		await t.ID.unlock(PASS);
		check('the session is remembered while it is on', !!t3.get(S_KEY));
		t.ID.setStayUnlocked(false);
		check('turning it off drops it at once', t3.get(S_KEY) === undefined);
	}
	{
		// A host with no sessionStorage at all: nothing is kept and nothing throws.
		const d4 = new Map(disk);
		const t = load({ disk: d4, tab: null, mobile: false });
		const r = await t.ID.unlock(PASS);
		check('an unlock works where there is no tab storage', !!r && r.ok === true);
		check('and nothing is remembered', t.ID.sessionHeld() === false);
	}

	console.log('\nidentity: every deliberate end of a session clears it');
	{
		const d5 = new Map(disk), t5 = new Map();
		const t = load({ disk: d5, tab: t5, mobile: false });
		await t.ID.unlock(PASS);
		check('remembered before the Lock button', t.ID.sessionHeld() === true);
		t.ID.lock();
		check('cleared by Lock, and by sign-out through it', t.ID.sessionHeld() === false);

		await t.ID.unlock(PASS);
		check('remembered again', t.ID.sessionHeld() === true);
		t.ID.reset();						// "Forget this identity"
		check('cleared by forget-me', t.ID.sessionHeld() === false);
		check('and the keys went with it', t.ID.exists() === false);
	}
	{
		// The removal path: daimond.js `onThisDeviceRemoved` calls reset() and then
		// lock() on a 410 that says `removed:true`. Both clear; neither throws twice.
		const d6 = new Map(disk), t6 = new Map();
		const t = load({ disk: d6, tab: t6, mobile: false });
		await t.ID.unlock(PASS);
		t.ID.reset();
		t.ID.lock();
		check('a 410-removed device keeps nothing', t6.get(S_KEY) === undefined);
		const u = load({ disk: d6, tab: t6, mobile: false });
		const got = await u.ID.restoring();
		check('and a reload cannot come back on it', !got.ok);
	}

	console.log('\nidentity: stale material is dropped, never a lock-out');
	{
		const d7 = new Map(disk), t7 = new Map();
		const t = load({ disk: d7, tab: t7, mobile: false });
		await t.ID.unlock(PASS);
		// A key that opens nothing here: 32 random bytes in the right shape.
		const junk = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64');
		t7.set(S_KEY, JSON.stringify({ k: junk, alg: 'Ed25519' }));
		const u = load({ disk: d7, tab: t7, mobile: false });
		const got = await u.ID.restoring();
		check('a key that no longer opens the store is refused',
			!got.ok && got.reason === 'stale');
		check('and is dropped rather than retried for ever', t7.get(S_KEY) === undefined);
		check('the passphrase still works afterwards',
			!!(await u.ID.unlock(PASS)).ok);
	}
	{
		// A passphrase change REPLACES what is remembered. Before the change there
		// was material that the change makes useless; after it, a reload still comes
		// back unlocked.
		const d8 = new Map(disk), t8 = new Map();
		const t = load({ disk: d8, tab: t8, mobile: false });
		await t.ID.unlock(PASS);
		const before = t8.get(S_KEY);
		const ch = await t.ID.changePassphrase(PASS, PASS2);
		check('the passphrase changed', !!ch && ch.ok === true);
		check('what is remembered changed with it', t8.get(S_KEY) !== before);
		const u = load({ disk: d8, tab: t8, mobile: false });
		const got = await u.ID.restoring();
		check('a reload still comes back unlocked', !!got && got.ok === true);
		check('under the NEW passphrase', !!(await load({ disk: d8, tab: new Map() })
			.ID.unlock(PASS2)).ok);
	}

	console.log('');
	console.log(passes + ' passed, ' + failures + ' failed');
	if (failures) process.exit(1);
	console.log('all identity session checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
