// verify_look.mjs — a device that joins an account by any route arrives wearing
// the account's look, once, and never argues about it afterwards.
//
// The pairing bundle carried theme, skin, language, currency, reading size and
// layout to a device linked by a QR code, and `applyLook` had exactly one caller.
// A device brought across by a passkey — which the catalogue advertises as
// bringing the account over "without a pairing code or a passphrase" — or one
// that simply holds the identity and is unlocked by typing it, got none of it. A
// user who works in French on a 125% reading size signed in on a new machine and
// was met by an English app at 100%.
//
// So the look now rides the sync parcel, which is the only channel every route
// ends at. Two things have to be true of it at once, and they pull in opposite
// directions:
//
//   IT MUST ARRIVE. A device that has never had a look of its own puts on the
//   account's, live, through the same services the appearance menu calls.
//
//   IT MUST NOT LOOP. The parcel is a FIXED POINT or two devices push at each
//   other for ever — reported from a freshly paired iPhone as "the syncing
//   seemed to go into an endless loop". A device that has a look of its own
//   RECORDS the account's without wearing it, and reports that same record back
//   unchanged. Nothing on the receiving path may stamp.
//
// The second device here is a genuinely separate browser profile that adopts the
// identity the way `adoptWithPasskey` does — `importBundle` of the exported
// bundle, then an ordinary passphrase unlock — and the file asserts that it
// never went near /api/pair. That is the route the bug was about.
//
//   node dev/verify_look.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT) AND the gateway on :9002.
import { open, signInAs } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Push until THIS device's own parcel is what the mailbox holds. See
/// verify_sync, where the same helper explains why the version advancing is not
/// evidence that this device's work went anywhere.
async function pushLanded(pg) {
	return await pg.evaluate(async (ms) => {
		const mailbox = async () => {
			const res = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
			const j = await res.json();
			if (!j.present) return null;
			try { return await window.DaimondIdentity.unwrap(j.blob); } catch (e) { return null; }
		};
		const mine = new Set();
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			await window.DaimondSync.push();
			mine.add(JSON.stringify(await window.DaimondSync.parcel()));
			const held = await mailbox();
			if (held !== null && mine.has(held)) return true;
			await new Promise(r => setTimeout(r, 200));
		}
		return false;
	}, 25000);
}

/// How a device looks, read from the places that decide it rather than from the
/// keys that were written. The DOM attributes are what the palette and the skin
/// actually hang off; `--fs-scale` is what the type is sized by; and the sample
/// string is the app speaking, which is the only proof a language arrived.
const looksLike = (pg) => pg.evaluate(() => ({
	theme:    document.documentElement.getAttribute('data-theme'),
	tone:     document.documentElement.getAttribute('data-tone'),
	skin:     document.documentElement.getAttribute('data-skin'),
	lang:     document.documentElement.lang,
	scale:    getComputedStyle(document.documentElement).getPropertyValue('--fs-scale').trim(),
	locale:   window.DaimondI18n ? DaimondI18n.locale() : '',
	currency: window.DaimondI18n ? DaimondI18n.currency() : '',
	sample:   window.DaimondI18n ? DaimondI18n.t('sync.synced') : '',
	layout:   localStorage.getItem('daimond-layout') || '',
	stored:   {
		theme:    localStorage.getItem('daimond-theme'),
		skin:     localStorage.getItem('daimond-skin'),
		locale:   localStorage.getItem('daimond-locale'),
		currency: localStorage.getItem('daimond-currency'),
		scale:    localStorage.getItem('daimond-fs-scale'),
	},
}));

const GWDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gateway');
const s = await open({ name: 'look', signIn: true, connect: false, defaults: false });
const { page } = s;
let child = null;

try {
	await page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	const lic = await makePagePro(page, GWDIR);
	check('the account holds Pro, so a parcel can travel at all',
		lic.pro === true, `webhook ${lic.status}, pro=${lic.pro}`);

	// ── (1) The first device is dressed by its user ───────────────────
	// Through the app's own services, which is what a person pressing the
	// controls does. A test that wrote the keys directly would be asserting
	// against a state the app never produces.
	await page.evaluate(async () => {
		DaimondTheme.set('amber');
		DaimondSkin.set('sharp');
		DaimondI18n.setCurrency('EUR');
		DaimondWorkspace.setScale(1.3);
		await DaimondI18n.setLocale('fr');
	});
	await sleep(600);
	const dressed = await looksLike(page);
	check('the first device is wearing a look of its own',
		dressed.theme === 'amber' && dressed.skin === 'sharp' && dressed.locale === 'fr'
			&& dressed.currency === 'EUR' && dressed.stored.scale === '1.3',
		JSON.stringify(dressed).slice(0, 160));

	check('the first device gets its parcel into the mailbox', await pushLanded(page));
	const sent = await page.evaluate(() => window.DaimondSync.parcel());
	check('the parcel carries the look as a stamped record',
		!!(sent.look && sent.look.t > 0 && sent.look.v
			&& sent.look.v['daimond-theme'] === 'amber'),
		JSON.stringify(sent.look));
	check('and it carries the five that travel and NOT the layout, which is the screen’s',
		!!sent.look && Object.keys(sent.look.v).sort().join(',')
			=== 'daimond-currency,daimond-fs-scale,daimond-locale,daimond-skin,daimond-theme',
		Object.keys((sent.look || {}).v || {}).sort().join(','));

	// ── (2) A second device, by a route that is NOT a pairing bundle ──
	// The identity is transplanted exactly as `adoptWithPasskey` transplants it:
	// `importBundle` of the bundle, then an ordinary passphrase unlock. What is
	// deliberately absent is `DaimondPairing.redeem`, which is the one caller
	// `applyLook` ever had.
	child = await open({ name: 'lookmate', signIn: false, connect: false });
	const pairCalls = [];
	child.page.on('request', (r) => { if (r.url().includes('/api/pair')) pairCalls.push(r.url()); });
	await child.page.waitForFunction(() => !!window.DaimondIdentity, null, { timeout: 20000 });
	const virgin = await looksLike(child.page);
	check('the new device starts on the defaults, in English, looking nothing like it',
		virgin.theme !== 'amber' && virgin.skin !== 'sharp' && virgin.locale === 'en',
		`${virgin.theme}/${virgin.skin}/${virgin.locale} "${virgin.sample}"`);

	const bundle = await page.evaluate(() => DaimondIdentity.exportBundle());
	const took = await child.page.evaluate(b => DaimondIdentity.importBundle(b), bundle);
	check('the new device takes the identity without a pairing code', took === true);
	await child.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(child, 'look');
	await child.page.waitForFunction(
		() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	const same = await child.page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
	const mine = await page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
	check('and it is the SAME account, unlocked with the passphrase', same === mine, same.slice(0, 12));
	check('with no pairing bundle anywhere in it — this is the route that got nothing',
		pairCalls.length === 0, pairCalls.join(' | ') || 'no /api/pair request was made');
	// This device's own dock arrangement, as it stands before anything arrives.
	// The layout is the one setting that must NOT travel, and "did not change"
	// is the exact form of that -- two fresh profiles may well have byte-identical
	// default layouts, so comparing the two devices would prove nothing.
	const preLook = await looksLike(child.page);

	// ── (3) The look arrives, and is WORN ─────────────────────────────
	// Nothing is done to the device but wait: the first pull after signing in is
	// what carries it.
	const worn = await (async () => {
		const t0 = Date.now();
		let seen = null;
		while (Date.now() - t0 < 30000) {
			seen = await looksLike(child.page);
			if (seen.theme === 'amber' && seen.locale === 'fr') return seen;
			await sleep(400);
		}
		return seen;
	})();
	check('the new device puts on the account’s palette, with nothing asked of it',
		worn.theme === 'amber' && worn.tone === 'dark', `${worn.theme}/${worn.tone}`);
	check('and its skin', worn.skin === 'sharp', worn.skin);
	check('and it speaks the account’s language — the app itself, not the stored key',
		worn.locale === 'fr' && worn.lang === 'fr' && worn.sample !== virgin.sample
			&& worn.sample === dressed.sample,
		`${worn.lang} "${worn.sample}"`);
	check('and shows money in the account’s currency', worn.currency === 'EUR', worn.currency);
	check('and reads at the account’s size, in the type itself',
		worn.stored.scale === '1.3' && parseFloat(worn.scale) === 1.3,
		`stored ${worn.stored.scale}, --fs-scale ${worn.scale}`);
	check('but NOT the other device’s dock layout — its own arrangement is untouched',
		!!worn.layout && worn.layout === preLook.layout,
		(worn.layout || '(none)').slice(0, 70));

	// ── (4) It is worn ONCE ───────────────────────────────────────────
	// The second device now chooses for itself. Whatever the account does after
	// that is recorded and not imposed: a phone and a desk may differ.
	await child.page.evaluate(() => DaimondTheme.set('forest'));
	await sleep(400);
	await pushLanded(child.page);
	await page.evaluate(() => window.DaimondSync.pull());
	await page.evaluate(() => DaimondTheme.set('midnight'));
	await sleep(400);
	check('the first device pushes a later look', await pushLanded(page));
	const held = await (async () => {
		const t0 = Date.now();
		let seen = null;
		while (Date.now() - t0 < 20000) {
			await child.page.evaluate(() => window.DaimondSync.pull());
			seen = await child.page.evaluate(async () => ({
				look:  (await window.DaimondSync.parcel()).look,
				theme: document.documentElement.getAttribute('data-theme'),
			}));
			if (seen.look && seen.look.v['daimond-theme'] === 'midnight') return seen;
			await sleep(500);
		}
		return seen;
	})();
	check('a device that has a look of its own RECORDS the account’s later one',
		!!(held.look && held.look.v['daimond-theme'] === 'midnight'),
		JSON.stringify(held.look));
	check('and does not put it on — the look arrives once, at first login, and never again',
		!!(held.look && held.look.v['daimond-theme'] === 'midnight') && held.theme === 'forest',
		`holding ${held.look && held.look.v['daimond-theme']}, wearing ${held.theme}`);

	// ── (4b) And a device that was here before the record was ─────────
	// The migration, which is the case that decides whether shipping this is
	// safe. Every device in an existing account wakes up one morning with no
	// record of its own look and a mailbox that may already hold somebody else's
	// -- and if "has this device got a look" were answered by looking at the keys,
	// the answer would be no, because they are only there at all thanks to the
	// default theme and skin the app writes on every boot. A whole cohort would be
	// redressed by whichever device published first.
	//
	// What is asked instead is whether this device has ever read this account's
	// mailbox, which nothing but this device having been here can produce. So:
	// wipe what the feature knows about this device, keep the sync cursor, and
	// come back.
	const cursor = await child.page.evaluate(() => {
		localStorage.removeItem('daimond-look');
		localStorage.removeItem('daimond-look-base');
		return localStorage.getItem('daimond-sync-version');
	});
	check('the established device still has the one thing that says it was here',
		(cursor | 0) > 0, `sync cursor ${cursor}`);
	await child.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(child, 'look');
	await child.page.waitForFunction(
		() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	const migrated = await (async () => {
		const t0 = Date.now();
		let seen = null;
		while (Date.now() - t0 < 20000) {
			await child.page.evaluate(() => window.DaimondSync.pull());
			seen = await child.page.evaluate(async () => ({
				look:  (await window.DaimondSync.parcel()).look,
				theme: document.documentElement.getAttribute('data-theme'),
			}));
			if (seen.look && seen.look.v['daimond-theme']) return seen;
			await sleep(500);
		}
		return seen;
	})();
	check('a device that has synced before is NOT redressed by the record arriving',
		migrated.theme === 'forest', migrated.theme);
	check('and it carries the account’s record all the same',
		!!(migrated.look && migrated.look.v['daimond-theme'] === 'midnight'),
		JSON.stringify(migrated.look));

	// ── (5) The fixed point, which is what stops the endless loop ─────
	// Measured on the device that DISAGREES with the record it holds, because
	// that is the state a restamp would show up in: collect, apply what you just
	// collected, collect again. And then apply the OTHER device's parcel, which
	// is the cross-device shape the iPhone was caught in.
	const stable = await child.page.evaluate(async () => {
		const a = JSON.stringify(await window.DaimondSync.parcel());
		await window.DaimondSync.apply(JSON.parse(a));
		const b = JSON.stringify(await window.DaimondSync.parcel());
		return { a, b };
	});
	check('applying its own parcel leaves the next one byte-identical',
		stable.a === stable.b,
		stable.a === stable.b ? `${stable.a.length} bytes` : 'the parcel moved under an apply');
	const theirs = await page.evaluate(async () => JSON.stringify(await window.DaimondSync.parcel()));
	const crossed = await child.page.evaluate(async (p) => {
		const before = (await window.DaimondSync.parcel()).look;
		await window.DaimondSync.apply(JSON.parse(p));
		const one = (await window.DaimondSync.parcel()).look;
		await window.DaimondSync.apply(JSON.parse(p));
		const two = (await window.DaimondSync.parcel()).look;
		return { sent: JSON.parse(p).look, before, one, two,
			theme: document.documentElement.getAttribute('data-theme') };
	}, theirs);
	check('and applying the OTHER device’s parcel gives that record straight back, unstamped',
		!!(crossed.sent && crossed.sent.t) && JSON.stringify(crossed.one) === JSON.stringify(crossed.sent),
		`sent ${JSON.stringify(crossed.sent)} → would send ${JSON.stringify(crossed.one)}`);
	check('twice over, so nothing is drifting a stamp at a time',
		!!(crossed.one && crossed.one.t) && JSON.stringify(crossed.one) === JSON.stringify(crossed.two),
		`${JSON.stringify(crossed.one)} then ${JSON.stringify(crossed.two)}`);
	check('and merging a look it will not wear does not change how it looks',
		!!(crossed.sent && crossed.sent.v['daimond-theme'] === 'midnight') && crossed.theme === 'forest',
		`merged ${crossed.sent && crossed.sent.v['daimond-theme']}, wearing ${crossed.theme}`);

	// And the same on the first device, which is the other half of the loop.
	const stableA = await page.evaluate(async () => {
		const a = JSON.stringify(await window.DaimondSync.parcel());
		await window.DaimondSync.apply(JSON.parse(a));
		const b = JSON.stringify(await window.DaimondSync.parcel());
		return a === b;
	});
	check('the first device’s parcel is a fixed point too', stableA === true);

	const clean = (errs) => errs.filter(e =>
		!/favicon|ERR_|Failed to load resource|401|402|409|426|502|Unauthorized/.test(e));
	check('no unexpected console errors on the new device', clean(child.errs).length === 0,
		clean(child.errs).slice(0, 3).join(' | '));
	check('no unexpected console errors on the first one', clean(s.errs).length === 0,
		clean(s.errs).slice(0, 3).join(' | '));
} catch (e) {
	check('verify_look ran without throwing', false, String(e && e.message || e));
} finally {
	await child?.close?.().catch?.(() => {});
	await s.close?.().catch?.(() => {});
}

console.log('\n' + (bad.length ? `FAIL: ${bad.length} failed, ${ok.length} passed` : `ok: all ${ok.length} passed`));
process.exit(bad.length ? 1 : 0);
