// verify_devices.mjs — "is my account on more than one device?", answered.
//
// Pairing moves the identity WHOLE, so both devices then hold one keypair and
// the gateway cannot tell them apart; it keeps no record of a pairing either.
// What can still be shown is a ROSTER: each device writes its own line, the
// sync parcel carries the lines, and the merge unions them. This drives the
// real page and checks the four things that make that roster trustworthy:
//
//   1. The id is minted, not measured. Two fresh installs of the same browser
//      on the same machine get DIFFERENT ids, and the id is only ever a random
//      number in this account's own storage.
//   2. The parcel is byte-stable between real changes. This device's own stamp
//      does not move on every collect -- sync skips a push whose parcel
//      stringifies to what it last sent, and a stamp that always moved would
//      put the whole parcel back on the wire for nothing, for ever.
//   3. The merge is freshest-wins, STRICTLY, per entry, with unknown entries
//      unioned in -- and a parcel with no roster at all is a no-op both ways.
//   4. The surface tells the truth: it lists devices that SYNC this account, it
//      marks this one, and it offers no control that pretends a device can be
//      signed out (nothing could enforce that under one shared keypair).
//
//   node dev/verify_devices.mjs
//
// Needs dev/serve.mjs on :8777 and dev/mockllm.mjs on :9099. No gateway.
import fs from 'node:fs';
import { open, shot, scratch } from './harness.mjs';

// Two FIXED profiles, wiped before use rather than minted per run. Every check
// below is about a FRESH install -- one that has never seen a roster -- so the
// profile has to be new anyway, and a fixed pair leaves two directories behind
// instead of two more on every run.
const PROFILES = ['devices-one', 'devices-two'].map(n => scratch('pw', n));
for (const p of PROFILES) fs.rmSync(p, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const A = 'aaaa1111bbbb2222';		// a fabricated second device
const B = 'cccc3333dddd4444';		// and a third

const s = await open({ name: 'devices', profile: PROFILES[0] });
const { page } = s;

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync), null,
		{ timeout: 12000 }).catch(() => {});

	// ── (1) Minted, not measured ────────────────────────────────────
	const mine = await page.evaluate(async () => {
		const p = await DaimondCore.collectSync();
		return {
			devices: p.devices,
			id:      localStorage.getItem('daimond-device-id'),
			stored:  localStorage.getItem('daimond-devices'),
		};
	});
	const ids = Object.keys(mine.devices || {});
	check('the parcel carries a devices roster', !!mine.devices && typeof mine.devices === 'object',
		JSON.stringify(mine.devices || null).slice(0, 120));
	check('a fresh install knows exactly one device — itself', ids.length === 1, ids.join(','));
	check('this device\'s id is 16 hex characters, kept in localStorage',
		/^[0-9a-f]{16}$/.test(mine.id || ''), String(mine.id));
	check('the roster is keyed by that id', ids[0] === mine.id, ids[0] + ' vs ' + mine.id);
	const me = (mine.devices || {})[ids[0]] || {};
	check('its line names the environment, in words', typeof me.name === 'string' && me.name.length > 2,
		JSON.stringify(me.name));
	check('with created and seen as real ms stamps (not 32-bit truncated)',
		me.created > 1.7e12 && me.seen > 1.7e12, me.created + ' / ' + me.seen);
	check('the merged roster is persisted', !!mine.stored && !!JSON.parse(mine.stored)[mine.id]);

	// A second install of the SAME browser on the SAME machine. If the id were
	// derived from the environment the two would collide; a random number cannot.
	const s2 = await open({ name: 'devices2', profile: PROFILES[1] });
	const other = await s2.page.evaluate(async () => {
		const p = await DaimondCore.collectSync();
		return { id: localStorage.getItem('daimond-device-id'), devices: p.devices };
	}).catch(() => null);
	await s2.close();
	check('a second install of the same browser mints a DIFFERENT id — nothing is derived from the machine',
		!!other && /^[0-9a-f]{16}$/.test(other.id) && other.id !== mine.id,
		(other && other.id) + ' vs ' + mine.id);
	const otherName = other && ((other.devices || {})[other.id] || {}).name;
	check('but describes itself the same way, because the description IS the environment',
		typeof otherName === 'string' && otherName.length > 2 && otherName === me.name,
		otherName + ' vs ' + me.name);

	// ── (2) Byte-stable between real changes ────────────────────────
	const stable = await page.evaluate(async () => {
		const a = JSON.stringify((await DaimondCore.collectSync()).devices);
		await new Promise(r => setTimeout(r, 400));
		const b = JSON.stringify((await DaimondCore.collectSync()).devices);
		return { a, b };
	});
	check('two collects in a row stringify identically — the push skip survives',
		typeof stable.a === 'string' && stable.a !== '{}' && stable.a === stable.b,
		String(stable.a).slice(0, 80) + ' | ' + String(stable.b).slice(0, 80));

	// ── (3) The merge ───────────────────────────────────────────────
	const merged = await page.evaluate(async ([A, B]) => {
		const now = Date.now();
		const roster = () => JSON.parse(localStorage.getItem('daimond-devices') || '{}');
		const out = {};
		// An unknown device unions in.
		await DaimondCore.applySync({ v: 2, devices: {
			[A]: { name: 'Firefox on Windows', created: now - 9e6, seen: now - 3600e3 },
		} });
		out.unioned = roster();
		// A STALE copy of a device already known must not roll it back.
		await DaimondCore.applySync({ v: 2, devices: {
			[A]: { name: 'Stale name', created: now - 9e6, seen: now - 7200e3 },
		} });
		out.afterStale = roster();
		// An EQUAL stamp keeps what is here (strictly newer, or nothing happens).
		await DaimondCore.applySync({ v: 2, devices: {
			[A]: { name: 'Equal name', created: now - 9e6, seen: now - 3600e3 },
		} });
		out.afterEqual = roster();
		// A fresher one wins.
		await DaimondCore.applySync({ v: 2, devices: {
			[A]: { name: 'Firefox on Windows', created: now - 9e6, seen: now - 60e3 },
		} });
		out.afterFresh = roster();
		// This device's own line is not rolled back by a stale remote copy of it.
		const self = localStorage.getItem('daimond-device-id');
		const before = roster()[self];
		await DaimondCore.applySync({ v: 2, devices: {
			[self]: { name: 'Somebody else\'s idea', created: 1, seen: 1 },
		} });
		out.selfBefore = before; out.selfAfter = roster()[self];
		// A malformed id is refused, so the roster stays a roster.
		await DaimondCore.applySync({ v: 2, devices: {
			'../../etc': { name: 'nope', created: now, seen: now },
			'2':         { name: 'nope', created: now, seen: now },
		} });
		out.afterJunk = roster();
		// A third device, so the ordering below has something to order.
		await DaimondCore.applySync({ v: 2, devices: {
			[B]: { name: 'Safari on iOS', created: now - 5e6, seen: now - 86400e3 },
		} });
		out.three = roster();
		out.parcel = (await DaimondCore.collectSync()).devices || {};
		out.parcelKeys = Object.keys(out.parcel);
		// And a parcel from a device that predates all of this changes nothing.
		const snap = JSON.stringify(roster());
		await DaimondCore.applySync({ v: 1 });
		out.afterV1 = JSON.stringify(roster());
		out.snap = snap;
		out.self = self;
		return out;
	}, [A, B]);

	check('an unknown device unions in', !!merged.unioned[A], Object.keys(merged.unioned).join(','));
	check('a STALE copy of a known device does not roll it back',
		merged.afterStale[A] && merged.afterStale[A].name === 'Firefox on Windows',
		JSON.stringify(merged.afterStale[A]));
	check('an EQUAL stamp keeps what is here — strictly newer, or nothing',
		merged.afterEqual[A] && merged.afterEqual[A].name === 'Firefox on Windows',
		JSON.stringify(merged.afterEqual[A]));
	check('a FRESHER copy wins', merged.afterFresh[A] && merged.afterFresh[A].seen > merged.afterStale[A].seen,
		JSON.stringify(merged.afterFresh[A]));
	check('this device\'s own line is not rolled back by a stale remote copy of it',
		merged.selfAfter && merged.selfAfter.seen === merged.selfBefore.seen,
		JSON.stringify(merged.selfAfter));
	check('a malformed device id is refused', !merged.afterJunk['../../etc'] && !merged.afterJunk['2'],
		Object.keys(merged.afterJunk).join(','));
	check('the parcel lists the ids SORTED — enumeration order would push for ever',
		JSON.stringify(merged.parcelKeys) === JSON.stringify(merged.parcelKeys.slice().sort()),
		merged.parcelKeys.join(','));
	check('a parcel with no roster at all is a no-op', merged.afterV1 === merged.snap);

	// ── (4) The surface ─────────────────────────────────────────────
	const view = await page.evaluate(() => {
		DaimondAdmin.home();
		const secs = [...document.querySelectorAll('#admin-home .admin-sec')].map(e => e.textContent);
		const rows = [...document.querySelectorAll('#admin-home .device-row')].map(r => ({
			text:    r.innerText.replace(/\s+/g, ' ').trim(),
			suffix:  (r.querySelector('.device-id') || {}).textContent || '',
			buttons: r.querySelectorAll('button').length,
		}));
		const notes = [...document.querySelectorAll('#admin-home .admin-note')].map(e => e.textContent);
		return { secs, rows, notes, self: localStorage.getItem('daimond-device-id') };
	});
	check('the Admin drawer has a Devices section', view.secs.some(x => /device/i.test(x)),
		view.secs.join(' | '));
	check('with one line per device', view.rows.length === 3, view.rows.length + ' rows');
	check('exactly one of them is marked as this device',
		view.rows.filter(r => /this device/i.test(r.text)).length === 1,
		view.rows.map(r => r.text).join(' | '));
	check('the others carry a relative last-seen, not a raw stamp',
		view.rows.filter(r => /(just now|\d+[mhd] ago)/.test(r.text)).length === 2,
		view.rows.map(r => r.text).join(' | '));
	check('no row offers a control — nothing here pretends a device can be revoked',
		view.rows.every(r => r.buttons === 0));
	check('and the copy says these are devices that SYNC, not devices that are paired',
		view.notes.some(n => /sync/i.test(n) && /appears/i.test(n)),
		view.notes.filter(n => /sync/i.test(n)).join(' | ').slice(0, 160));
	// Two of a user's devices can easily describe themselves identically
	// ("Chrome on macOS" twice), so each line carries the tail of its own id.
	const wantSuffix = [view.self, A, B].map(x => x.slice(-4)).sort();
	check('each line carries the tail of its OWN id, so two alike devices are still two',
		JSON.stringify(view.rows.map(r => r.suffix).sort()) === JSON.stringify(wantSuffix),
		view.rows.map(r => r.suffix).join(',') + ' vs ' + wantSuffix.join(','));

	await shot(s, 'devices-roster');

	// Back to one device: the quiet line has to answer the question in the other
	// direction too, or a user with one device learns nothing at all.
	const alone = await page.evaluate(() => {
		const self = localStorage.getItem('daimond-device-id');
		const keep = JSON.parse(localStorage.getItem('daimond-devices') || '{}')[self];
		localStorage.setItem('daimond-devices', JSON.stringify({ [self]: keep }));
		DaimondAdmin.home();
		return {
			rows:  [...document.querySelectorAll('#admin-home .device-row')].length,
			notes: [...document.querySelectorAll('#admin-home .admin-note')].map(e => e.textContent),
		};
	});
	check('with one device there is still a line for it', alone.rows === 1, String(alone.rows));
	check('and a sentence saying so, so the question is answered either way',
		alone.notes.some(n => /only this device/i.test(n)),
		alone.notes.join(' | ').slice(0, 120));

	const errs = s.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|402|409|426|502/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('verify_devices ran without throwing', false, String(e && e.message || e));
} finally {
	await s.close?.().catch?.(() => {});
}

console.log('\n' + (bad.length ? `FAIL: ${bad.length} failed, ${ok.length} passed` : `ok: all ${ok.length} passed`));
process.exit(bad.length ? 1 : 0);
