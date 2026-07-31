// verify_pairing.mjs — an identity travels to a second device through a one-time
// gateway code, so the new device becomes the SAME account.
//
// Needs the dev stack up (app :8777, gateway :9002). Device B is simulated by
// wiping the local identity and redeeming the code in the same page.
//
// The second half runs a REAL second device: its own browser profile, its own
// localStorage, no identity of its own. That is the only way to prove the
// presentation snapshot, since a snapshot applied in the parent's own page would
// be indistinguishable from the parent's own settings.
import { open, signInAs } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'pair', signIn: true, connect: false });
const { page } = s;
let child = null;		// the real second device, opened below on its own profile

await page.waitForFunction(
	() => !!window.DaimondPairing && !!window.DaimondGateway && DaimondGateway.state().authed,
	null, { timeout: 12000 },
).catch(() => {});

try {
	const p1 = await page.evaluate(() => DaimondIdentity.publicKeyB64url());
	const authed = await page.evaluate(() => DaimondGateway.state().authed);
	check('device A has an identity and an authed session', !!p1 && authed);

	// Device A creates a pairing code.
	const created = await page.evaluate(async () => {
		try { return await DaimondPairing.create(); } catch (e) { return { error: e.message }; }
	});
	check('create() returns a pairing code', !!(created && created.code && created.code.length >= 8),
		created && (created.code || created.error));

	// Device B: wipe the identity, then redeem the code to get it back.
	const redeemed = await page.evaluate(async (code) => {
		DaimondIdentity.reset();
		const goneBefore = DaimondIdentity.exists();
		let ok = false, err = null;
		try { ok = await DaimondPairing.redeem(code); } catch (e) { err = e.message; }
		return { goneBefore, ok, err, existsAfter: DaimondIdentity.exists(), pub: DaimondIdentity.publicKeyB64url() };
	}, created.code);
	check('resetting cleared the local identity (a fresh device)', redeemed.goneBefore === false);
	check('redeem imports the identity — same account on device B',
		redeemed.ok === true && redeemed.existsAfter === true && redeemed.pub === p1,
		redeemed.err || ('pub-match=' + (redeemed.pub === p1)));

	// The code is single-use.
	const second = await page.evaluate(async (code) => {
		try { await DaimondPairing.redeem(code); return 'redeemed-again'; } catch (e) { return e.message; }
	}, created.code);
	check('a pairing code cannot be redeemed twice', /invalid|expired/i.test(second), second);

	// A bad code fails cleanly.
	const bogus = await page.evaluate(async () => {
		try { await DaimondPairing.redeem('not-a-real-code'); return 'redeemed'; } catch (e) { return e.message; }
	});
	check('an unknown code is rejected', /invalid|expired/i.test(bogus), bogus);

	// The UI entry points were injected without any bespoke markup.
	const ui = await page.evaluate(() => ({
		redeem: !!document.getElementById('pair-redeem-entry'),
		link:   !!document.getElementById('pair-link-btn'),
	}));
	check('redeem entry button is present on the identity screen', ui.redeem);
	check('link-a-device button is present in the top actions', ui.link);

	// ── Linking carries how the app LOOKS, once ────────────────────────
	// Two devices that hold one account should not need setting up twice, so the
	// link carries the parent's presentation across: theme, skin, language,
	// display currency, reading size and the panel layout. It is a ONE-TIME
	// handover, not a synced setting — from then on each device is its own.
	const LOOK = {
		'daimond-theme':    'light',
		'daimond-skin':     'warm',
		'daimond-locale':   'de',
		'daimond-currency': 'eur',
		'daimond-fs-scale': '1.15',
		'daimond-layout':   JSON.stringify({ open: { work: true }, widths: { rail: 399, dock: 300 }, grid: '2x2' }),
	};
	await page.evaluate((look) => {
		Object.keys(look).forEach((k) => localStorage.setItem(k, look[k]));
	}, LOOK);
	const handover = await page.evaluate(async () => {
		try { return await DaimondPairing.create(); } catch (e) { return { error: e.message }; }
	});
	check('the parent creates a second code with its presentation attached',
		!!(handover && handover.code), handover && (handover.code || handover.error));

	if (handover && handover.code) {
		child = await open({ name: 'pairchild', signIn: false, connect: false });
		await child.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 12000 })
			.catch(() => {});
		// The child starts with its OWN look, deliberately different in every
		// field the snapshot carries, so nothing below can pass by coincidence.
		await child.page.evaluate(() => {
			localStorage.setItem('daimond-theme', 'dark');
			localStorage.setItem('daimond-skin', 'sharp');
			localStorage.setItem('daimond-locale', 'en');
			localStorage.setItem('daimond-currency', 'usd');
			localStorage.removeItem('daimond-fs-scale');
			localStorage.removeItem('daimond-layout');
		});
		const fresh = await child.page.evaluate(() => ({
			identity: window.DaimondIdentity.exists(),
			theme:    localStorage.getItem('daimond-theme'),
		}));
		check('the child is a real second device: its own profile, no identity',
			fresh.identity === false && fresh.theme === 'dark', JSON.stringify(fresh));

		const took = await child.page.evaluate(async (code) => {
			try { return { ok: await DaimondPairing.redeem(code) }; }
			catch (e) { return { err: e.message }; }
		}, handover.code);
		check('the child redeems the code', took.ok === true, took.err || '');

		const stored = await child.page.evaluate(() => ({
			theme:    localStorage.getItem('daimond-theme'),
			skin:     localStorage.getItem('daimond-skin'),
			locale:   localStorage.getItem('daimond-locale'),
			currency: localStorage.getItem('daimond-currency'),
			scale:    localStorage.getItem('daimond-fs-scale'),
			layout:   localStorage.getItem('daimond-layout'),
		}));
		check('the redeem wrote the parent’s theme, skin, language and currency',
			stored.theme === 'light' && stored.skin === 'warm'
				&& stored.locale === 'de' && stored.currency === 'eur',
			JSON.stringify(stored).slice(0, 160));
		check('and the reading size and the whole panel layout',
			stored.scale === '1.15'
				&& !!stored.layout && JSON.parse(stored.layout).widths.rail === 399,
			'scale=' + stored.scale + ' layout=' + String(stored.layout).slice(0, 60));

		// The keys are read before first paint, so the reload the redeem dialog
		// already does IS the apply. Prove the paint, not just the storage.
		await child.page.reload({ waitUntil: 'domcontentloaded' });
		await child.page.waitForTimeout(600);
		const painted = await child.page.evaluate(() => ({
			theme: document.documentElement.getAttribute('data-theme'),
			skin:  document.documentElement.getAttribute('data-skin'),
			lang:  document.documentElement.lang,
			scale: getComputedStyle(document.documentElement).getPropertyValue('--fs-scale').trim(),
		}));
		check('the child paints as the parent did: theme, skin, language, reading size',
			painted.theme === 'light' && painted.skin === 'warm'
				&& painted.lang === 'de' && painted.scale === '1.15',
			JSON.stringify(painted));

		// …and then it is the child's own. A later sync must not re-impose the
		// parent's look: screen configuration is per-device from here on.
		await signInAs(child, 'pair').catch(() => {});
		const diverged = await child.page.evaluate(async () => {
			localStorage.setItem('daimond-theme', 'dark');
			if (window.DaimondTheme && DaimondTheme.set) DaimondTheme.set('dark');
			const ready = !!(window.DaimondSync && window.DaimondIdentity.isUnlocked());
			try { await window.DaimondSync.pull(); } catch (e) {}
			try { await window.DaimondSync.push(); } catch (e) {}
			await new Promise(r => setTimeout(r, 400));
			return {
				ready:   ready,
				theme:   localStorage.getItem('daimond-theme'),
				painted: document.documentElement.getAttribute('data-theme'),
			};
		});
		check('a later sync does not re-impose the parent’s look (the child diverges)',
			diverged.theme === 'dark' && diverged.painted !== 'light',
			JSON.stringify(diverged));

		// The gateway refuses a parked bundle over 8 KiB, so the snapshot has two
		// guards: a per-value cap, and a budget on the whole. Neither may ever cost
		// the LINK — the identity is the thing being carried.
		const huge = JSON.stringify({ open: { work: true }, pad: 'x'.repeat(9000) });
		await page.evaluate((big) => {
			localStorage.setItem('daimond-layout', big);
			localStorage.setItem('daimond-theme', 'lollypop');
		}, huge);
		const third = await page.evaluate(async () => {
			try { return await DaimondPairing.create(); } catch (e) { return { error: e.message }; }
		});
		check('a layout too large to be a preference still parks a bundle',
			!!(third && third.code), third && (third.code || third.error));
		if (third && third.code) {
			const shed = await child.page.evaluate(async (arg) => {
				try { await DaimondPairing.redeem(arg.code); } catch (e) { return { err: e.message }; }
				return {
					theme:  localStorage.getItem('daimond-theme'),
					layout: localStorage.getItem('daimond-layout'),
				};
			}, { code: third.code });
			check('the small keys still travel when the layout is dropped',
				shed.theme === 'lollypop', shed.err || ('theme=' + shed.theme));
			check('and the oversize layout does not', shed.layout !== huge,
				'layout=' + String(shed.layout).slice(0, 40));
		}

		// Six values each under the per-value cap can still add up past what the
		// gateway will park. The budget drops the snapshot whole rather than let the
		// link fail — the child then simply keeps its own look, which is the right
		// way to lose this feature.
		const before = await page.evaluate(() => {
			const keep = {};
			['daimond-theme', 'daimond-skin', 'daimond-locale', 'daimond-currency',
				'daimond-fs-scale', 'daimond-layout'].forEach((k) => { keep[k] = localStorage.getItem(k); });
			const pad = 'y'.repeat(4000);
			Object.keys(keep).forEach((k) => localStorage.setItem(k, pad));
			return keep;
		});
		const fourth = await page.evaluate(async () => {
			try { return await DaimondPairing.create(); } catch (e) { return { error: e.message }; }
		});
		await page.evaluate((keep) => {
			Object.keys(keep).forEach((k) => {
				if (keep[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, keep[k]);
			});
		}, before);
		check('a snapshot over the whole budget still parks a bundle',
			!!(fourth && fourth.code), fourth && (fourth.code || fourth.error));
		if (fourth && fourth.code) {
			const dropped = await child.page.evaluate(async (code) => {
				try { await DaimondPairing.redeem(code); } catch (e) { return { err: e.message }; }
				return { theme: localStorage.getItem('daimond-theme') };
			}, fourth.code);
			check('and none of it travels — the child keeps its own look',
				dropped.theme === 'lollypop', dropped.err || ('theme=' + String(dropped.theme).slice(0, 20)));
		}

		const cerrs = child.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|402|404|409|426|502|Unauthorized/.test(e));
		check('no unexpected console errors on the child device', cerrs.length === 0,
			cerrs.slice(0, 3).join(' | '));
	}

	const errs = s.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|404|426|502|Unauthorized/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('verify_pairing ran without throwing', false, String(e && e.message || e));
} finally {
	await child?.close?.().catch?.(() => {});
	await s.close?.().catch?.(() => {});
}

console.log('\n' + (bad.length ? `FAIL: ${bad.length} failed, ${ok.length} passed` : `ok: all ${ok.length} passed`));
process.exit(bad.length ? 1 : 0);
