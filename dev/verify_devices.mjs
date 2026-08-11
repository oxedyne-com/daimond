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
//   3b. The name a USER gives a device merges on a stamp of its own. A device
//      refreshes only its own `seen`, so a name typed on device A for device B
//      would never travel if it rode on `seen` -- B's next refresh would win the
//      whole line back and take the name off it.
//   4. The surface tells the truth: it lists devices that SYNC this account, it
//      marks this one, it lets any line be named, and it offers no control that
//      pretends a device can be signed out (nothing could enforce that under one
//      shared keypair).
//   5. A name typed at pairing time survives the reload that redeeming does, and
//      the new device's line takes it up the moment that line is minted.
//
//   node dev/verify_devices.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.
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

	// ── (3b) The name the user gives a device ───────────────────────
	// "Chromium on Linux" is what a device can say about itself; it is not what
	// its owner calls it. So a line carries a LABEL as well, with a stamp of its
	// own, and the rename is done through the real drawer control rather than by
	// writing storage -- the point of the feature is that a user can do it.
	// A roster written by a version that had no names at all, read back. It has
	// to decode rather than be dropped, and it must not invent a name for a
	// device nobody has named.
	const legacy = await page.evaluate(async () => {
		const keep = localStorage.getItem('daimond-devices') || '{}';
		const OLD  = 'eeee5555ffff6666';
		localStorage.setItem('daimond-devices', JSON.stringify({
			[OLD]: { name: 'Edge on Windows', created: 1.75e12, seen: 1.75e12 },
		}));
		const line = ((await DaimondCore.collectSync()).devices || {})[OLD];
		localStorage.setItem('daimond-devices', keep);
		return line;
	});
	check('a roster stored before names existed still decodes, with no name and no stamp',
		!!legacy && legacy.name === 'Edge on Windows' && legacy.label === '' && legacy.namedAt === 0,
		JSON.stringify(legacy));

	const named = await page.evaluate(async ([A, B]) => {
		const now = Date.now();
		const roster = () => JSON.parse(localStorage.getItem('daimond-devices') || '{}');
		const wait = (n) => new Promise(r => setTimeout(r, n));
		// Rename a device the way a user does: open the drawer, press the control
		// on that device's row, type, save.
		const renameVia = async (id, text) => {
			DaimondAdmin.home();
			const row = [...document.querySelectorAll('#admin-home .device-row')]
				.find(r => ((r.querySelector('.device-id') || {}).textContent || '') === id.slice(-4));
			const btn = row && row.querySelector('.device-rename');
			if (!btn) return false;
			btn.click();
			await wait(80);
			const input = document.querySelector('.dlg .dlg-input');
			const ok    = document.querySelector('.dlg .dlg-ok');
			if (!input || !ok) return false;
			input.value = text;
			ok.click();
			await wait(200);
			return !document.querySelector('.dlg');
		};
		const out = {};
		// This device names ANOTHER device's line.
		out.renamed = await renameVia(A, ' Kitchen laptop ');
		out.local   = roster()[A];
		out.parcel  = ((await DaimondCore.collectSync()).devices || {})[A];
		// The named device refreshes its own `seen` and knows nothing of the name.
		// Its line is fresher, so it wins the line -- and must not take the name.
		await DaimondCore.applySync({ v: 2, devices: {
			[A]: { name: 'Firefox on Windows', created: now - 9e6, seen: now - 1e3 },
		} });
		out.afterSelfRefresh = roster()[A];
		// A rename made on the OTHER device arrives even though its `seen` is
		// older than what is here: the label merges on its own stamp alone.
		await DaimondCore.applySync({ v: 2, devices: {
			[A]: { name: 'Firefox on Windows', created: now - 9e6, seen: now - 9e5,
				label: 'Work desktop', namedAt: now + 5e3 },
		} });
		out.afterRemoteRename = roster()[A];
		// An EQUAL namedAt keeps what is here, exactly as an equal `seen` does.
		await DaimondCore.applySync({ v: 2, devices: {
			[A]: { name: 'Firefox on Windows', created: now - 9e6, seen: now - 9e5,
				label: 'Somebody else\'s idea', namedAt: now + 5e3 },
		} });
		out.afterEqualNamedAt = roster()[A];
		// And an OLDER rename loses.
		await DaimondCore.applySync({ v: 2, devices: {
			[A]: { name: 'Firefox on Windows', created: now - 9e6, seen: now - 9e5,
				label: 'Older idea', namedAt: now - 1e6 },
		} });
		out.afterOlderRename = roster()[A];
		// A device that predates names carries neither field, and must not take
		// the name off a line that has one -- even when its `seen` wins the line.
		await DaimondCore.applySync({ v: 2, devices: {
			[A]: { name: 'Firefox on Windows', created: now - 9e6, seen: now - 500 },
		} });
		out.afterOldFormat = roster()[A];
		// Clearing a name is itself a rename: an empty label with a fresher stamp,
		// arriving on a line whose `seen` did not move at all.
		// Its `seen` is EXACTLY what is already stored, so nothing but the naming
		// can move: a label that travelled with the entry would not arrive at all.
		const bSeen = (roster()[B] || {}).seen;
		await DaimondCore.applySync({ v: 2, devices: {
			[B]: { name: 'Safari on iOS', created: now - 5e6, seen: bSeen,
				label: 'Phone', namedAt: now },
		} });
		out.bNamed = roster()[B];
		await DaimondCore.applySync({ v: 2, devices: {
			[B]: { name: 'Safari on iOS', created: now - 5e6, seen: bSeen,
				label: '', namedAt: now + 2e3 },
		} });
		out.bCleared = roster()[B];
		// A name is a name, not a paragraph.
		await renameVia(B, 'x'.repeat(400));
		out.capped = ((roster()[B] || {}).label || '').length;
		await renameVia(B, '');
		out.bBlank = roster()[B];
		// The push skip survives the two new fields.
		const s1 = JSON.stringify((await DaimondCore.collectSync()).devices);
		await wait(300);
		const s2 = JSON.stringify((await DaimondCore.collectSync()).devices);
		out.stableA = s1; out.stableB = s2;
		return out;
	}, [A, B]);

	check('a device row can be renamed from the drawer', named.renamed === true, String(named.renamed));
	check('the name is stored trimmed, with a stamp of its own',
		!!named.local && named.local.label === 'Kitchen laptop' && named.local.namedAt > 1.7e12,
		JSON.stringify(named.local));
	check('the derived description is kept underneath it, as the fallback',
		!!named.local && named.local.name === 'Firefox on Windows', JSON.stringify(named.local));
	check('and the name rides in the parcel, so it can reach the other devices',
		!!named.parcel && named.parcel.label === 'Kitchen laptop' && named.parcel.namedAt === named.local.namedAt,
		JSON.stringify(named.parcel));
	check('the named device refreshing its own seen does NOT take the name off',
		!!named.afterSelfRefresh && named.afterSelfRefresh.label === 'Kitchen laptop'
			&& named.afterSelfRefresh.seen > named.local.seen,
		JSON.stringify(named.afterSelfRefresh));
	check('a rename from another device arrives even though its seen is older — the label merges on namedAt',
		!!named.afterRemoteRename && named.afterRemoteRename.label === 'Work desktop',
		JSON.stringify(named.afterRemoteRename));
	check('an EQUAL namedAt keeps the name that is here — strictly newer, or nothing',
		!!named.afterEqualNamedAt && named.afterEqualNamedAt.label === 'Work desktop',
		JSON.stringify(named.afterEqualNamedAt));
	check('an OLDER rename loses', !!named.afterOlderRename && named.afterOlderRename.label === 'Work desktop',
		JSON.stringify(named.afterOlderRename));
	check('an entry from before names existed carries none, and takes none away',
		!!named.afterOldFormat && named.afterOldFormat.label === 'Work desktop'
			&& named.afterOldFormat.seen > named.afterRemoteRename.seen,
		JSON.stringify(named.afterOldFormat));
	check('a name reaches a line whose seen did not move at all',
		!!named.bNamed && named.bNamed.label === 'Phone', JSON.stringify(named.bNamed));
	check('and clearing it is itself a rename, so the clearing travels too',
		!!named.bCleared && named.bCleared.label === '' && named.bCleared.namedAt > named.bNamed.namedAt,
		JSON.stringify(named.bCleared));
	check('a name is capped, so one line cannot become a paragraph', named.capped === 64,
		String(named.capped));
	check('an empty box clears the name, back to what the device says about itself',
		!!named.bBlank && named.bBlank.label === '' && named.bBlank.name === 'Safari on iOS',
		JSON.stringify(named.bBlank));
	check('two collects in a row still stringify identically with names in play — the push skip survives',
		typeof named.stableA === 'string' && named.stableA === named.stableB,
		String(named.stableA).slice(0, 100));

	// ── (4) The surface ─────────────────────────────────────────────
	const view = await page.evaluate(() => {
		DaimondAdmin.home();
		const secs = [...document.querySelectorAll('#admin-home .admin-sec')].map(e => e.textContent);
		const rows = [...document.querySelectorAll('#admin-home .device-row')].map(r => ({
			text:      r.innerText.replace(/\s+/g, ' ').trim(),
			name:      (r.querySelector('.device-name') || {}).textContent || '',
			nameTitle: (r.querySelector('.device-name') || {}).title,
			nameLabel: (r.querySelector('.device-name') || {}).getAttribute
				? r.querySelector('.device-name').getAttribute('aria-label') : null,
			suffix:  (r.querySelector('.device-id') || {}).textContent || '',
			buttons: r.querySelectorAll('button').length,
			// What each control CLAIMS to do, which is the thing worth asserting on.
			// A count cannot tell a rename from a revoke, and counting is what made
			// this file go stale twice as controls were added beside it.
			acts:    [...r.querySelectorAll('button')].map(b =>
				((b.getAttribute('aria-label') || b.title || b.textContent || '').trim())),
			rename:  r.querySelectorAll('button.device-rename').length,
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
	check('every row offers a rename — a device is named where it is listed',
		view.rows.every(r => r.rename === 1), view.rows.map(r => r.rename).join(','));
	// The property, stated as a property. Removing a line from this list is not a
	// revocation and must never read as one: every paired device holds the SAME
	// keypair (`identity.js` exportBundle hands over the wrapped private key), so
	// no control here could revoke one even if it said it did.
	//
	// This was `buttons === 1` and went stale the moment a second control landed
	// beside the rename, which is the ninth time a literal count has broken a
	// check in this codebase. A count cannot tell a rename from a revoke; the
	// words on the controls can.
	const REVOKES = /revoke|sign ?out|log ?out|disconnect|unpair|deauthor/i;
	const claims = view.rows.flatMap(r => r.acts).filter(a => REVOKES.test(a));
	check('nothing here pretends a device can be revoked',
		claims.length === 0, claims.join(' | ') || view.rows.flatMap(r => r.acts).join(' | '));
	check('a named device shows the user\'s name in place of the derived description',
		view.rows.some(r => r.name === 'Work desktop') && !view.rows.some(r => r.name === 'Firefox on Windows'),
		view.rows.map(r => r.name).join(' | '));
	check('a device with no name of its own still shows what it says about itself',
		view.rows.some(r => r.name === 'Safari on iOS'), view.rows.map(r => r.name).join(' | '));
	// THE PROPERTY. This list is what has SYNCED, and the note has to say so in
	// three parts, because every row above it carries a ✕: syncing is what puts
	// a device here, a device that holds the account without syncing is
	// therefore MISSING from it (so absence is not proof of no access), and
	// taking a line off the list does not sign that device out.
	//
	// This was `/sync/ && /appears/` and went red when the copy said "is not
	// listed" instead of "never appears here" -- the same claim in other words.
	// `/sync/` alone would pass for a note that called these paired devices and
	// left a user believing the ✕ revoked one.
	const noteIsHonest = (n) => {
		const bits = n.split(/(?<=[.!?:;])\s+/);
		const neg  = /\b(not|no|never|nothing|none|cannot)\b|n[’']t\b/i;
		const list = /\b(list|listed|listing|appears?|shown?|show|here|below|missing)\b/i;
		return {
			// Syncing is what puts a device on this list.
			scope:   /sync/i.test(n),
			// One that holds the account and has not synced is absent from it.
			absent:  bits.some(b => /sync/i.test(b) && neg.test(b) && list.test(b)),
			// And nothing on this list ends a device's access.
			signout: bits.some(b => neg.test(b)
				&& /\bsigns?[- ]?(a |the )?(device |it )?out\b|\brevokes?\b|\bcuts? off\b|\bdeauthor/i.test(b)),
		};
	};
	const honest = view.notes.map(noteIsHonest)
		.find(h => h.scope && h.absent && h.signout);
	check('and the copy says these are devices that SYNC, that one which has not is missing, and that nothing here signs a device out',
		!!honest,
		view.notes.filter(n => /sync|device/i.test(n)).join(' | ').slice(0, 200));
	// Two of a user's devices can easily describe themselves identically
	// ("Chrome on macOS" twice), so each line carries the tail of its own id.
	const wantSuffix = [view.self, A, B].map(x => x.slice(-4)).sort();
	check('each line carries the tail of its OWN id, so two alike devices are still two',
		JSON.stringify(view.rows.map(r => r.suffix).sort()) === JSON.stringify(wantSuffix),
		view.rows.map(r => r.suffix).join(',') + ' vs ' + wantSuffix.join(','));

	// notes4.txt, Admin panel: "The Device names are shortened with '...' which
	// is fine but they should show hover text with the full name." CSS does the
	// shortening (`.device-name{text-overflow:ellipsis}`); what is asked here is
	// that the FULL name still reaches a mouse (`title`) and a keyboard or screen
	// reader user, for whom a `title` is invisible (`aria-label`).
	check('every device name carries the FULL name in a title, for a mouse to hover',
		view.rows.every(r => r.nameTitle === r.name && r.name.length > 0),
		JSON.stringify(view.rows.map(r => ({ name: r.name, title: r.nameTitle }))));
	check('and in an aria-label, since a title alone says nothing to a keyboard or screen-reader user',
		view.rows.every(r => r.nameLabel === r.name),
		JSON.stringify(view.rows.map(r => ({ name: r.name, label: r.nameLabel }))));

	// This device can be named too, and naming it must not cost it the one mark
	// that says which line the user is standing on.
	const selfNamed = await page.evaluate(async () => {
		const self = localStorage.getItem('daimond-device-id');
		DaimondAdmin.home();
		const row = [...document.querySelectorAll('#admin-home .device-row')]
			.find(r => ((r.querySelector('.device-id') || {}).textContent || '') === self.slice(-4));
		const btn = row && row.querySelector('.device-rename');
		if (!btn) return null;
		btn.click();
		await new Promise(r => setTimeout(r, 80));
		const input = document.querySelector('.dlg .dlg-input');
		const ok    = document.querySelector('.dlg .dlg-ok');
		if (!input || !ok) return null;
		// The box opens on the name that is there now, and says what it falls back
		// to when emptied.
		const opened = { value: input.value, placeholder: input.placeholder || '' };
		input.value = 'Studio Mac';
		ok.click();
		await new Promise(r => setTimeout(r, 200));
		const mine = [...document.querySelectorAll('#admin-home .device-row')]
			.find(r => ((r.querySelector('.device-id') || {}).textContent || '') === self.slice(-4));
		return {
			opened: opened,
			name:   (mine.querySelector('.device-name') || {}).textContent || '',
			text:   mine.innerText.replace(/\s+/g, ' ').trim(),
			suffix: (mine.querySelector('.device-id') || {}).textContent || '',
		};
	});
	check('this device can be named as well', !!selfNamed && selfNamed.name === 'Studio Mac',
		JSON.stringify(selfNamed));
	check('and stays marked as this device, with its id tail, once named',
		!!selfNamed && /this device/i.test(selfNamed.text) && selfNamed.suffix.length === 4,
		selfNamed && selfNamed.text);
	check('the rename box offers what the device calls itself as the placeholder',
		!!selfNamed && /\w/.test(selfNamed.opened.placeholder) && selfNamed.opened.value === '',
		JSON.stringify(selfNamed && selfNamed.opened));

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

	// ── (5) A name chosen while pairing ─────────────────────────────
	// The name is typed on the NEW device, during redeem — before that device has
	// a line to put it on. Its line is minted on the first collect, which happens
	// after the reload the redeem dialog performs, so the name is stashed and the
	// mint consumes it. Redeeming needs a gateway; the field and the stash do not.
	const paired = await page.evaluate(async () => {
		const out = {};
		DaimondPairing.showRedeem('ABCD1234');
		await new Promise(r => setTimeout(r, 80));
		const box   = document.querySelector('.pair-scrim .pair-box');
		const field = box && box.querySelector('.pair-name');
		out.hasField = !!field;
		out.ph       = field ? (field.getAttribute('placeholder') || '') : '';
		out.maxlen   = field ? (field.getAttribute('maxlength') || '') : '';
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await new Promise(r => setTimeout(r, 60));
		out.closed = !document.querySelector('.pair-scrim');
		// What a successful redeem does with what was typed.
		DaimondPairing.stashName('  Kitchen laptop  ');
		out.stash = localStorage.getItem('daimond-pair-label');
		// The reload boundary: a device that has just redeemed has no line at all.
		localStorage.removeItem('daimond-device-id');
		localStorage.setItem('daimond-devices', '{}');
		const reg = (await DaimondCore.collectSync()).devices || {};
		out.self       = reg[localStorage.getItem('daimond-device-id')] || null;
		out.stashAfter = localStorage.getItem('daimond-pair-label');
		// And the next device to mint a line does not inherit it.
		localStorage.removeItem('daimond-device-id');
		localStorage.setItem('daimond-devices', '{}');
		const reg2 = (await DaimondCore.collectSync()).devices || {};
		out.second = reg2[localStorage.getItem('daimond-device-id')] || null;
		return out;
	});
	check('the redeem dialog offers a name for the device being linked',
		paired.hasField === true && /\w/.test(paired.ph), JSON.stringify(paired.ph));
	check('the field is capped there too', String(paired.maxlen) === '64', String(paired.maxlen));
	check('the chosen name is stashed, trimmed, across the reload redeeming does',
		paired.stash === 'Kitchen laptop', JSON.stringify(paired.stash));
	check('and the roster takes it up the moment this device first mints its line',
		!!paired.self && paired.self.label === 'Kitchen laptop' && paired.self.namedAt > 1.7e12,
		JSON.stringify(paired.self));
	check('the stash is consumed, so the next line minted is not named for it',
		!paired.stashAfter && !!paired.second && paired.second.label === '',
		JSON.stringify(paired.stashAfter) + ' / ' + JSON.stringify(paired.second));

	const errs = s.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|402|409|426|502/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('verify_devices ran without throwing', false, String(e && e.message || e));
} finally {
	await s.close?.().catch?.(() => {});
}

console.log('\n' + (bad.length ? `FAIL: ${bad.length} failed, ${ok.length} passed` : `ok: all ${ok.length} passed`));
process.exit(bad.length ? 1 : 0);
