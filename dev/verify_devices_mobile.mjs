// verify_devices_mobile.mjs — the Devices panel on a PHONE, and the same list on a
// desktop beside it (owner trace, 2026-09-13, iPhone PWA on build ea8174ff76f6:
// a red skew box "Your devices are on 2 different builds" over "an indecipherable
// mess of a list"). Four defects, all panel-only:
//
//   1. TWO ROWS FOR ONE MACHINE. A device that has not reloaded since the id spaces
//      were joined beats presence under its IDENTITY id while its roster line is
//      still keyed by the LEGACY one, so it arrives as a live row with no build and
//      a dead row carrying the build -- and the "reload me" tag landed on the dead
//      half, which cannot be reloaded. A legacy-width line that is not beating is a
//      pre-migration SHADOW and is not a device: it is read for the build it is the
//      only carrier of, and never drawn.
//   2. THE SKEW LINE NAMED NOBODY. "2 different builds. Reload the older ones" left
//      the owner comparing seven-character prefixes across three machines. It names
//      the device now.
//   3. THE ROW DID NOT FIT. Eleven children, all `white-space: nowrap` bar the name:
//      a row measured 450px inside the drawer's 380px column. It wraps now, and at
//      a phone's width it folds to two lines with the controls flush right.
//   4. SORTED BY ONE STAMP, WORDED FROM ANOTHER. Ordered on the roster's `seen` and
//      written from the presence beat, the list read "just now / 2m ago / 1m ago".
//
// TWO CONTEXTS, because the complaint was about a phone and the fix must not cost
// the desktop anything: a WebKit iPhone at 390x844 (the engine and the width the
// owner's PWA runs) and a Chromium desktop, both carrying the SAME roster, reached
// through the app's own merge (`DaimondCore.roster.merge` -- `mergeDevices`), which
// is what a completed sync round leaves behind. Client-only: no gateway, no mock,
// no turn is billed.
//
//   bash dev/world.sh 25 --up
//   DAIMOND_APP=http://localhost:8802 node dev/verify_devices_mobile.mjs

import { open, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// The fleet under test. SHADOW is legacy width on purpose -- it is the pre-migration
// line of the machine DESK_PEER is, which is the whole of defect 1.
const DESK_PEER = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const SHADOW    = '569d927e449602ea';
const OLD_BUILD = '84224133a563';
const PEER_NAME = 'Chrome on gilgamesh';

let phone, desk;
try {
	desk = await open({ name: 'devmobdesk', browser: 'chromium', connect: false });
	phone = await open({ name: 'devmobphone', browser: 'webkit', touch: true, connect: false,
		ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
			+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
	await phone.page.setViewportSize({ width: 390, height: 844 });
	for (const s of [desk, phone]) {
		await s.page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.roster
			&& DaimondCore.roster.merge && window.DaimondPresence && DaimondPresence.beat
			&& window.DaimondAdmin), null, { timeout: 25000 });
	}
	const ua = await phone.page.evaluate(() => navigator.userAgent);
	check('the phone context is WebKit, the engine an iPhone runs',
		/WebKit/.test(ua) && !/Chrome\//.test(ua), ua.slice(0, 60));
	check('and it is 390px wide, the width the owner read the mess at',
		(await phone.page.evaluate(() => innerWidth)) === 390);

	// ── The roster ONE device writes, then MERGED into the other ────────────────
	// Each context's own line is its own identity id, which it alone knows; the peer
	// and the shadow are written on the desktop and reach the phone through the real
	// merge, so the phone is reading a roster it did not author.
	const seed = (s, selfName) => s.page.evaluate((a) => {
		const now = Date.now();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
			.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
		DaimondPresence.forget();
		const SELF = DaimondIdentity.deviceId();
		const reg = {};
		reg[SELF] = { name: a.selfName, label: '', created: now, namedAt: 0, seen: now,
			build: DaimondRelease && DaimondRelease.buildId ? DaimondRelease.buildId() : '' };
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		return SELF;
	}, { selfName });
	const SELF_DESK  = await seed(desk, 'Chrome on argonaut');
	const SELF_PHONE = await seed(phone, 'Safari on iOS');
	check('the two contexts hold distinct device ids', SELF_DESK !== SELF_PHONE,
		SELF_DESK.slice(-4) + ' vs ' + SELF_PHONE.slice(-4));

	// The peer's live line, and its pre-migration shadow, written on the desktop and
	// taken back out as the parcel the phone will merge. The desktop's OWN line stays
	// behind: each context is then the same two devices -- itself and the peer -- so
	// "exactly two rows" means the same thing on both, and the shadow's suppression is
	// a row count rather than a judgement about which row is which.
	const parcel = await desk.page.evaluate((a) => {
		const now = Date.now(), R = DaimondCore.roster;
		const inc = {};
		inc[a.PEER] = { name: a.PEER_NAME, label: '', created: now - 9e5, namedAt: 0, seen: now };
		// The shadow: the SAME machine's legacy line, last seen a moment ago (the peer
		// keeps pushing it until it reloads) and the only carrier of its OLD build.
		inc[a.SHADOW] = { name: a.PEER_NAME, label: '', created: now - 9e6, namedAt: 0,
			seen: now - 1000, build: a.OLD_BUILD };
		R.merge(inc);
		return inc;
	}, { PEER: DESK_PEER, SHADOW, PEER_NAME, OLD_BUILD });
	const deskReg = await desk.page.evaluate(() => DaimondCore.roster.load());
	check('the desktop roster holds its own line, the peer and the peer\'s shadow',
		Object.keys(deskReg).length === 3 && !!deskReg[SHADOW] && !!deskReg[SELF_DESK],
		Object.keys(deskReg).map(k => k.slice(-4)).join(' '));

	// ── The MERGE across the two contexts ───────────────────────────────────────
	const merged = await phone.page.evaluate((inc) => {
		DaimondCore.roster.merge(inc);
		return DaimondCore.roster.load();
	}, parcel);
	check('the phone took the peer and its shadow through the app\'s own merge',
		!!merged[DESK_PEER] && !!merged[SHADOW] && !!merged[SELF_PHONE] && !merged[SELF_DESK],
		Object.keys(merged).map(k => k.slice(-4)).join(' '));

	// Who is BEATING: the three live machines, never the shadow.
	const beat = (s, selfId, selfName) => s.page.evaluate((a) => {
		const now = Date.now();
		DaimondPresence.beat(a.selfId, a.selfName, now, true, true);
		DaimondPresence.beat(a.PEER, a.PEER_NAME, now, false, true);
	}, { selfId, selfName, PEER: DESK_PEER, PEER_NAME });

	/// Render the panel through the app's own door and read every row back, with the
	/// geometry that says whether it fits and whether it folded.
	const read = async (s, selfId, selfName) => {
		await beat(s, selfId, selfName);
		await s.page.evaluate(() => { try { DaimondAdmin.home(); } catch (e) {} });
		await s.page.waitForTimeout(400);
		return s.page.evaluate(() => {
			const rows = [...document.querySelectorAll('.device-row')].map(r => {
				const q = c => r.querySelector('.' + c);
				const nm = q('device-name'), idv = q('device-id');
				const br = q('device-break');
				return {
					name:  nm ? nm.textContent : '',
					idsuf: idv ? idv.textContent : '',
					when:  (q('device-when') || {}).textContent || '',
					build: (q('device-build') || {}).textContent || '',
					old:   !!q('device-oldbuild'),
					// Does the row fit the column it is in?
					fits:  r.scrollWidth <= r.clientWidth,
					sw: r.scrollWidth, cw: r.clientWidth,
					// Did the id fall BELOW the name? That is the second line, measured
					// rather than assumed from a class.
					twoLine: !!(nm && idv && idv.getBoundingClientRect().top
						>= nm.getBoundingClientRect().bottom - 1),
					breakShown: !!(br && getComputedStyle(br).display !== 'none'),
					// A finger's target, for the controls that take one.
					taps: [...r.querySelectorAll('button')].map(b => Math.round(
						Math.min(b.getBoundingClientRect().width, b.getBoundingClientRect().height))),
				};
			});
			const skew = document.querySelector('.device-skew');
			return { rows, skew: skew ? skew.textContent : '', vw: innerWidth };
		});
	};

	// ── (a) THE PHONE: two rows, folded, fitting, and a skew line that NAMES ─────
	const P = await read(phone, SELF_PHONE, 'Safari on iOS');
	check('the phone lists exactly two devices — itself and the peer',
		P.rows.length === 2, JSON.stringify(P.rows.map(r => r.name + '/' + r.idsuf)));
	check('the phone\'s own row is first and says so',
		P.rows[0] && P.rows[0].idsuf === SELF_PHONE.slice(-4) && /this device/i.test(P.rows[0].when),
		JSON.stringify(P.rows[0] || null));
	const peerRow = P.rows.find(r => r.idsuf === DESK_PEER.slice(-4));
	check('the peer is named from its own beat, not a generic self-description',
		!!peerRow && peerRow.name === PEER_NAME, JSON.stringify(peerRow || null));
	check('the pre-migration SHADOW line is not drawn at all',
		!P.rows.some(r => r.idsuf === SHADOW.slice(-4)),
		JSON.stringify(P.rows.map(r => r.idsuf)));
	check('no row on the phone overflows its column',
		P.rows.every(r => r.fits), JSON.stringify(P.rows.map(r => r.sw + '/' + r.cw)));
	check('every phone row folded to two lines',
		P.rows.every(r => r.twoLine && r.breakShown), JSON.stringify(P.rows.map(r => r.twoLine)));
	check('and its controls are 44px, a finger rather than a mouse',
		P.rows.every(r => r.taps.length && r.taps.every(t => t >= 44)),
		JSON.stringify(P.rows.map(r => r.taps)));
	check('the skew line names WHICH device is older, and its build',
		P.skew.indexOf(PEER_NAME) === 0 && P.skew.indexOf(OLD_BUILD.slice(0, 7)) > 0
			&& /reload it/i.test(P.skew), JSON.stringify(P.skew));
	check('the skew line is one short line, not a paragraph',
		P.skew.length > 0 && P.skew.length <= 70, String(P.skew.length));

	// ── (b) THE DESKTOP: the same two devices, on ONE line each, still fitting ───
	const D = await read(desk, SELF_DESK, 'Chrome on argonaut');
	check('the desktop lists two devices too, shadow suppressed there as well',
		D.rows.length === 2 && !D.rows.some(r => r.idsuf === SHADOW.slice(-4)),
		JSON.stringify(D.rows.map(r => r.name + '/' + r.idsuf)));
	check('no row on the desktop overflows its column',
		D.rows.every(r => r.fits), JSON.stringify(D.rows.map(r => r.sw + '/' + r.cw)));
	check('and the desktop row is still ONE line — the fold costs it nothing',
		D.rows.every(r => !r.twoLine && !r.breakShown), JSON.stringify(D.rows.map(r => r.twoLine)));
	check('the desktop skew line names the same device',
		D.skew.indexOf(PEER_NAME) === 0, JSON.stringify(D.skew));

	// ── (c) ORDER: the list is sorted by the stamp the rows actually SHOW ────────
	const O = await phone.page.evaluate((a) => {
		const now = Date.now();
		DaimondPresence.forget();
		// A third line, so there is an order to get wrong.
		const add = {}; add[a.SELF_DESK] = { name: 'Chrome on argonaut', label: '',
			created: now - 9e5, namedAt: 0, seen: now };
		DaimondCore.roster.merge(add);
		// The peer is AWAKE with nothing to say: a fresh beat over a stale roster
		// stamp. Sorting on the roster would have put it below a device last seen
		// longer ago, and the words on the rows would have disagreed with the order.
		const reg = JSON.parse(localStorage.getItem('daimond-devices') || '{}');
		reg[a.PEER].seen = now - 6e5;
		reg[a.SELF_DESK].seen = now - 6e4;
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		DaimondPresence.beat(a.SELF_PHONE, 'Safari on iOS', now, true, true);
		DaimondPresence.beat(a.PEER, a.PEER_NAME, now, false, true);
		DaimondPresence.beat(a.SELF_DESK, 'Chrome on argonaut', now - 6e4, false, true);
		try { DaimondAdmin.home(); } catch (e) {}
		return [...document.querySelectorAll('.device-row')].map(r => ({
			idsuf: (r.querySelector('.device-id') || {}).textContent || '',
			when:  (r.querySelector('.device-when') || {}).textContent || '' }));
	}, { PEER: DESK_PEER, SELF_PHONE, SELF_DESK, PEER_NAME });
	check('a device awake with nothing to say sorts by its BEAT, above a quieter one',
		O.length === 3 && O[0].idsuf === SELF_PHONE.slice(-4)
			&& O[1].idsuf === DESK_PEER.slice(-4) && O[2].idsuf === SELF_DESK.slice(-4),
		JSON.stringify(O));

	// ── (d) A LIVE PEER ON AN OLD BUILD: the chip the skew line is about ─────────
	// The shadow above carries an old build and is not drawn, so nothing there wears
	// the row-level "old build" tag. A peer that HAS reloaded into its identity id and
	// is still behind does, and that is the row whose six-word tag used to push it
	// 450px wide inside a 380px column.
	for (const [who, s, selfId, selfName] of [['phone', phone, SELF_PHONE, 'Safari on iOS'],
		['desktop', desk, SELF_DESK, 'Chrome on argonaut']]) {
		const E = await s.page.evaluate((a) => {
			const now = Date.now();
			DaimondPresence.forget();
			['daimond-devices', 'daimond-device-tombs', 'daimond-device-super']
				.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
			const reg = {};
			reg[a.PEER] = { name: a.PEER_NAME, label: '', created: now - 9e5, namedAt: 0,
				seen: now, build: a.OLD_BUILD };
			try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
			DaimondPresence.beat(a.selfId, a.selfName, now, true, true);
			DaimondPresence.beat(a.PEER, a.PEER_NAME, now, false, true);
			try { DaimondAdmin.home(); } catch (e) {}
			const rows = [...document.querySelectorAll('.device-row')].map(r => ({
				idsuf: (r.querySelector('.device-id') || {}).textContent || '',
				old:   ((r.querySelector('.device-oldbuild') || {}).textContent || ''),
				fits:  r.scrollWidth <= r.clientWidth, sw: r.scrollWidth, cw: r.clientWidth }));
			return { rows, skew: (document.querySelector('.device-skew') || {}).textContent || '' };
		}, { PEER: DESK_PEER, PEER_NAME, OLD_BUILD, selfId, selfName });
		const peer = E.rows.find(r => r.idsuf === DESK_PEER.slice(-4));
		check('the ' + who + ' flags a live peer that is behind, in two words',
			!!peer && peer.old === 'old build', JSON.stringify(peer || null));
		check('and that row still fits its column on the ' + who,
			E.rows.every(r => r.fits), JSON.stringify(E.rows.map(r => r.sw + '/' + r.cw)));
		check('the ' + who + ' skew line names it and its build',
			E.skew.indexOf(PEER_NAME) === 0 && E.skew.indexOf(OLD_BUILD.slice(0, 7)) > 0,
			JSON.stringify(E.skew));
		// A picture of the row, for a human to look at. Best-effort and never a check:
		// the drawer may be scrolled below the fold, and a shot is not the proof --
		// the geometry above is.
		if (process.env.DEV_SHOT) try {
			await s.page.evaluate(() => {
				const r = document.querySelector('.device-skew') || document.querySelector('.device-row');
				if (r) r.scrollIntoView({ block: 'center' });
			});
			await s.page.waitForTimeout(200);
			const clip = await s.page.evaluate(() => {
				const rs = [...document.querySelectorAll('.device-skew, .device-row')];
				if (!rs.length) return null;
				const b = rs.map(e => e.getBoundingClientRect());
				const x = Math.max(0, Math.min(...b.map(r => r.left)) - 10);
				const y = Math.max(0, Math.min(...b.map(r => r.top)) - 10);
				return { x, y, width: Math.max(...b.map(r => r.right)) - x + 10,
					height: Math.max(...b.map(r => r.bottom)) - y + 10 };
			});
			if (clip) await s.page.screenshot({ path: process.env.DEV_SHOT + '-' + who + '.png', clip });
		} catch (e) { console.log('  (no shot: ' + e.message + ')'); }
	}

	for (const s of [phone, desk]) {
		// A gateway-less world answers /api with 502, and a missing favicon is a
		// missing favicon: neither is a fault in the panel under test.
		const e = errors(s).filter(x => !/favicon|net::ERR|Failed to load resource/.test(x));
		check('no console error in the ' + s.name + ' context', e.length === 0, e.slice(0, 2).join(' | '));
	}
} catch (e) {
	check('the verifier ran', false, String(e && e.stack || e));
} finally {
	for (const s of [phone, desk]) { if (s) { try { await s.close(); } catch (e) {} } }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { bad.forEach(b => console.log('  FAIL ' + b)); process.exit(1); }
