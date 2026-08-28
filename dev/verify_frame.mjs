// verify_frame.mjs — A TRANSIENT ELEMENT MUST NEVER SIT IN THE FLOW OF CLICKABLE
// TARGETS. Either it lives outside that flow, or the space it occupies is
// reserved whether or not it is showing.
//
// The top bar is where that rule is hardest to keep, because five things in it
// come and go on their own timing: a sync round starting and stopping, a held
// cloud sweep, the pairing button arriving with a session, the update chip going
// quiet, and an unseen count landing on a chip. Until 2026-08-28 the bar's
// right-hand group shrank to its contents inside a `space-between` row, so every
// one of those moved the whole chip row sideways -- 86px for a sync round, 98 for
// a held sweep, 122 for the pairing button, 21 for a mail badge -- and the owner
// reported it as what it is: "it makes it impossible to click moving targets
// during the process."
//
// So this measures rather than inspects. Each transient is made to appear
// through the app's own path, and the x of every chip and every icon button in
// the bar is compared across the change. Nothing may move by a pixel.
//
// EVERY CHECK BELOW WAS SHOWN GOING RED, 2026-08-28, by putting each mechanism
// back the way it was: the badge in the chip's flow (4 chips moved 22px), the
// update chip's `[hidden]` rule taken out (visible while hidden), the pairing
// button hidden with `display` (its arrival caught), the sync chip mounted back
// in `.top-actions` (18 targets moved, worst 77px, and 9 rail rows with it), and
// `.top-actions` back to `flex: 0 1 auto` (a longer label moved all 12 chips to
// its left). That last one caught a real mistake in the very change this file
// was written for: the property had been reverted while the comment above it
// still described the fix, and the four transient checks all passed anyway --
// their space is reserved, so they never needed the origin to be nailed down.
//
// WHAT THIS CANNOT SEE. It measures one window width and one language: a rule
// that held at 1440px in English and broke at 900px in German would pass here.
// The widths are `verify_workspace`'s subject and the languages are
// `verify_i18n`'s; this one owns the question of whether anything MOVES.
// And the pairing section is the weakest of the five, because the button's
// hidden form has to be posed by this file rather than read off the app: it
// catches a change to how the button is revealed, not every way its slot could
// stop being reserved.
import { open, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const s = await open({ signIn: true, connect: true, name: 'frame' });
const { page } = s;
await page.route('**/*.{woff,woff2,ttf,otf}', r => r.abort());
await page.evaluate(() => { try { window.DaimondAdmin.closeModal(); } catch (e) {} const m = document.getElementById('settings-modal'); if (m) m.style.display = 'none'; });
await page.setViewportSize({ width: 1440, height: 900 });
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await sleep(700);

/// Every target in the top bar, by its left edge.
const bar = () => page.evaluate(() => {
	const o = {};
	document.querySelectorAll('#panel-tags .ptag').forEach(c => {
		o['chip:' + (c.dataset.panel || c.id)] = Math.round(c.getBoundingClientRect().x);
	});
	document.querySelectorAll('.top-actions > button').forEach(b => {
		o['btn:' + (b.id || b.className)] = Math.round(b.getBoundingClientRect().x);
	});
	return o;
});

/// Compare two readings and report the worst movement.
const still = async (what, before) => {
	const after = await bar();
	const shared = Object.keys(before).filter(k => after[k] !== undefined);
	const moved = shared.filter(k => after[k] !== before[k]);
	const worst = moved.length ? Math.max(...moved.map(k => Math.abs(after[k] - before[k]))) : 0;
	check(what, moved.length === 0 && shared.length > 6,
		`${shared.length} targets` + (moved.length
			? `, ${moved.length} moved, worst ${worst}px: ` + moved.slice(0, 4).join(' ')
			: ', none moved'));
};

// ── 1. A sync round ────────────────────────────────────────────────
// Through sync.js's own `pullOnce`, with the gateway stubbed so the request
// hangs: that is the state being complained about, a round in flight while a
// thumb is on its way to a chip.
{
	const before = await bar();
	check('the bar holds chips and icon buttons to measure',
		Object.keys(before).filter(k => k.startsWith('chip:')).length > 3
		&& Object.keys(before).filter(k => k.startsWith('btn:')).length > 2,
		Object.keys(before).length + ' targets');
	await page.evaluate(() => {
		window.DaimondGateway.state = () => ({ authed: true });
		window.DaimondGateway.clientApi = () => 1;
		window.DaimondGateway.gwFetch = () => new Promise(r => setTimeout(
			() => r({ status: 200, json: async () => ({ present: false }) }), 5000));
	});
	page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
	await sleep(800);
	const chip = await page.evaluate(() => {
		const c = document.getElementById('sync-chip');
		return c ? { shown: getComputedStyle(c).display !== 'none', text: (c.textContent || '').trim(), where: c.parentNode.id } : null;
	});
	check('a round in flight says so somewhere the user can see it',
		!!(chip && chip.shown && /sync/i.test(chip.text)), JSON.stringify(chip));
	// AND NOT IN THE ROW OF TARGETS. The chip is the reason this file exists; a
	// later change that moved it back into `.top-actions` would pass every
	// measurement below only until the bar ran short of room.
	check('and it says so OUT of the bar, in the rail\'s status strip',
		!!(chip && chip.where === 'astat-sync'), chip && chip.where);
	await still('a sync round moves nothing in the bar', before);
	await sleep(5000);
}

// ── 2. The pairing button, revealed by a session ───────────────────
{
	await page.evaluate(() => { const b = document.getElementById('pair-link-btn'); if (b) b.style.visibility = 'hidden'; });
	await sleep(250);
	const before = await bar();
	await page.evaluate(() => window.dispatchEvent(new Event('daimond:authed')));
	await sleep(350);
	check('the pairing button is showing once a session exists', await page.evaluate(() => {
		const b = document.getElementById('pair-link-btn');
		return !!b && getComputedStyle(b).visibility === 'visible';
	}));
	await still('and its slot was already there, so nothing moved when it arrived', before);
}

// ── 3. The update chip going quiet ─────────────────────────────────
// `hidden` used to do nothing at all here: an author rule setting `display:
// flex` beats the browser's `[hidden] { display: none }`, so the one state that
// asks for silence -- no version stamp deployed -- drew a faint mark anyway.
{
	await page.evaluate(() => { document.getElementById('update-chip').hidden = true; });
	await sleep(250);
	const quiet = await page.evaluate(() => {
		const c = getComputedStyle(document.getElementById('update-chip'));
		return { display: c.display, visibility: c.visibility, w: Math.round(document.getElementById('update-chip').getBoundingClientRect().width) };
	});
	check('a hidden update chip is actually invisible', quiet.visibility === 'hidden', JSON.stringify(quiet));
	check('and still holds its place in the row', quiet.w > 20, quiet.w + 'px');
	const before = await bar();
	await page.evaluate(() => { document.getElementById('update-chip').hidden = false; });
	await sleep(250);
	await still('the update chip coming back moves nothing', before);
}

// ── 4. An unseen count landing on a chip ───────────────────────────
// Through the event mail.js dispatches, so what is measured is the badge the
// app really draws.
{
	const before = await bar();
	await page.evaluate(() => window.dispatchEvent(new CustomEvent('daimond:mail-arrived', { detail: { count: 3 } })));
	await sleep(450);
	check('three messages arriving draws a count on the Email chip', await page.evaluate(() => {
		const b = document.querySelector('#panel-tags .ptag[data-panel="mail"] .dock-count');
		return !!b && (b.textContent || '').trim() === '3';
	}));
	await still('a count arriving moves nothing — not even the chip it is on', before);
}

// ── 5. A chip's own label getting longer ───────────────────────────
// The row's LEFT EDGE has to be fixed too, not merely undisturbed by what is to
// its right. A language change, a renamed panel, or the `... N` chip going from
// one digit to two all change how much room the row wants; if the row shrank to
// its contents inside a right-anchored group, every one of those would slide the
// whole row sideways. This is the check that says the origin is nailed down --
// and it is here because the rule was written into the comment above
// `.top-actions` before it was written into the property, and nothing else
// noticed.
{
	// Through `relabel`, which is what a language change calls: writing a longer
	// word into the chip by hand does not survive, because the row's own
	// ResizeObserver rebuilds it from the registry within the frame.
	const before = await bar();
	await page.evaluate(() => {
		const el = document.getElementById('panel-social');
		el.dataset.was = el.dataset.label;
		el.dataset.label = el.dataset.label + ' and then some';
		window.DaimondPanels.relabel();
	});
	await sleep(400);
	const after = await bar();
	const grew = await page.evaluate(() => {
		const c = document.querySelector('#panel-tags .ptag[data-panel="social"]');
		return c ? Math.round(c.getBoundingClientRect().width) : 0;
	});
	const left = Object.keys(before).filter(k => k.startsWith('chip:') && k !== 'chip:social'
		&& after[k] !== undefined && before[k] < before['chip:social']);
	const movedLeft = left.filter(k => after[k] !== before[k]);
	check('a longer label moves no chip to its left',
		left.length > 3 && movedLeft.length === 0 && grew > 90,
		`the chip grew to ${grew}px; ${left.length} chips before it, ${movedLeft.length} moved`);
	await page.evaluate(() => {
		const el = document.getElementById('panel-social');
		if (el.dataset.was) { el.dataset.label = el.dataset.was; delete el.dataset.was; }
		window.DaimondPanels.relabel();
	});
	await sleep(300);
}

// ── 6. A held-back cloud sweep ─────────────────────────────────────
{
	const before = await bar();
	const drawn = await page.evaluate(() => {
		const c = document.getElementById('chunk-chip');
		if (!c) return null;
		c.querySelector('.ctext').textContent = 'Cleanup paused';
		c.style.display = 'flex';
		return c.parentNode.id;
	});
	await sleep(300);
	// IN THE SYNC ROW, sharing it. Its own row at the foot of the strip was the
	// first answer and it was the same fault one surface over -- the strip grew
	// and the rail's controls moved with it (`dev/verify_sweep_seen.mjs`, ANCHOR).
	check('a held sweep says so in the rail rather than in the bar',
		drawn === 'astat-sync', String(drawn));
	await still('a held sweep moves nothing in the bar', before);
}

// ── 7. And the strip it all moved into does not move either ────────
// A status that appears among the rail's rows would be the same fault one panel
// over: those rows are buttons, and the two above the sync row open Credits and
// the Pro offer.
{
	const rows = () => page.evaluate(() => {
		const o = {};
		document.querySelectorAll('#admin-status > *').forEach(r => { o[r.id || r.className] = Math.round(r.getBoundingClientRect().y); });
		return o;
	});
	const quiet = await rows();
	page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
	await sleep(800);
	const busy = await rows();
	const moved = Object.keys(quiet).filter(k => busy[k] !== undefined && busy[k] !== quiet[k]);
	check('a sync round moves no row in the rail\'s status strip either',
		moved.length === 0 && Object.keys(quiet).length > 6,
		Object.keys(quiet).length + ' rows, ' + moved.length + ' moved' + (moved.length ? ': ' + moved.join(', ') : ''));
	// The row cannot fade the way the old pill did -- it would take its
	// neighbours up the strip with it -- so what it does instead is say the one
	// thing that is always true and was never on screen anywhere before: a phone
	// has no hover, and this sentence lived only in the pill's `title`.
	//
	// THE TIER HAS TO BE HELD FOR THE RESTING STATE TO EXIST AT ALL. Without it
	// "Sync off" stands permanently and correctly, and there is nothing to rest
	// to; `recheck` is the app's own door to the state a Pro purchase leaves
	// behind. Then a round that lands leaves "Synced" for 1.8s and rests.
	await sleep(5500);
	await page.evaluate(async () => {
		window.DaimondGateway.gwFetch = () => Promise.resolve({ status: 200, json: async () => ({ present: false }) });
		window.DaimondSync.recheck();
		await window.DaimondSync.pull();
	});
	await sleep(2400);
	const rest = await page.evaluate(() => {
		const c = document.getElementById('sync-chip'), r = document.getElementById('sync-rest');
		return { chipShown: c ? c.style.display !== 'none' : null,
			restShown: getComputedStyle(r).display !== 'none', rest: (r.textContent || '').trim() };
	});
	check('with nothing in flight the row says when a sync last worked',
		rest.restShown && /sync/i.test(rest.rest), JSON.stringify(rest));
	// SIX VERIFIERS READ `#sync-chip`'s `style.display` to mean "is it saying
	// anything", verify_sessionrenew's `state === 'synced' || !shown` among them.
	// The resting line is a SIBLING for exactly that reason.
	check('and the chip itself is still hidden when it has nothing to say',
		rest.chipShown === false, JSON.stringify(rest));
}

// A world with no gateway of its own answers `/api/*` with a 502, deliberately
// (dev/world.sh), and nothing in this file is about the gateway.
// ── 8. The Admin drawer, bounded by the rail ───────────────────────
// The strip's own height is only safe to change because the drawer gives the
// height back instead of rising into the rail's head. HIT-TESTED, not measured:
// the failure here is a control that is present, positioned and covered, which
// is the one case a geometric check passes and a user fails.
{
	const seen = (sel) => page.evaluate((q) => {
		const e = document.querySelector(q);
		if (!e) return 'absent';
		const r = e.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return 'not drawn';
		const own = (x, y) => { const el = document.elementFromPoint(Math.round(x), Math.round(y)); return !!(el && (el === e || e.contains(el))); };
		const c = own(r.x + r.width / 2, r.y + r.height / 2);
		const t = own(r.x + r.width / 2, r.y + 2);
		const b = own(r.x + r.width / 2, r.bottom - 2);
		return c && t && b ? 'whole' : (c ? 'part' : (t || b ? 'half-live' : 'covered'));
	}, sel);
	const spill = () => page.evaluate(() => {
		const b = document.querySelector('.admin-body').getBoundingClientRect();
		const r = document.querySelector('.panel.rail').getBoundingClientRect();
		return Math.round(r.y - b.y);
	});
	// Three window heights, the middle one being where the old 540px cap put the
	// drawer's top edge inside `#new-diamond-btn`.
	const bad = [];
	for (const h of [700, 940, 1100]) {
		await page.setViewportSize({ width: 1440, height: h });
		await sleep(500);
		await page.evaluate(() => { const b = document.getElementById('settings-btn'); if (b && !document.getElementById('admin').classList.contains('admin-open')) b.click(); });
		await sleep(500);
		const said = { h, spill: await spill(), close: await seen('#admin-close'), plus: await seen('#new-diamond-btn') };
		if (said.spill > 0 || said.close !== 'whole' || said.plus !== 'whole') bad.push(JSON.stringify(said));
		await page.evaluate(() => { try { DaimondAdmin.close(); } catch (e) {} });
		await sleep(250);
	}
	check('the open Admin drawer never leaves the rail, and its own × is always pressable',
		bad.length === 0, bad.join(' | '));
	check('and the rail\'s own head is whole above it, at every window height',
		bad.length === 0, bad.length ? bad.join(' | ') : '700, 940 and 1100px');
	await page.setViewportSize({ width: 1440, height: 900 });
	await sleep(400);
}

// ── 9. The strip may change height by ANY amount ───────────────────
// Section 7 says no row inside the strip moves when a row's contents change.
// This says the thing underneath it: the strip may change HEIGHT, by any amount
// and for any reason, and the divider the user set in the rail above it does not
// move. A different claim, and until 2026-08-28 it was false. The Diamonds list
// held a SHARE of what the furniture left over, so a taller strip shrank
// `#rail-top`, `applyRailSplit` recomputed the list, and the Chats head went half
// as far again as the strip's own rows did. Measured on this file's world before
// the change, at 1440x900: a strip 37px taller moved the Chats head 16px, one
// 113px taller moved it 54.
//
// GROWN WITH PADDING rather than by showing one of the rows that happen to exist
// today. `astat-byok`, `astat-pro` and `astat-store-native` are all still
// transient, by decision or by circumstance, and more rows will be written after
// this file is: a check that names one of them proves nothing about the next.
// Padding is any reason at all, which is the whole claim.
//
// THE DIVIDER IS DRAGGED FIRST, and it has to be. A divider nobody has touched is
// an even split and is still cut from the room every time, deliberately -- see
// `applyRailSplit`. What is fixed here is that a position somebody CHOSE is never
// recomputed out from under them, whatever the strip below does.
{
	const MIN_LIST = 72;    // MIN_H.list in js/daimond.js -- neither list is crushed
	const rail = () => page.evaluate(() => {
		const heads = [...document.querySelectorAll('#rail-top .railhead')];
		const chats = heads[heads.length - 1];
		const list  = document.getElementById('diamond-list');
		const sess  = document.getElementById('session-list');
		return {
			chats: chats ? Math.round(chats.getBoundingClientRect().y) : null,
			list:  Math.round(list.getBoundingClientRect().height),
			sess:  Math.round(sess.getBoundingClientRect().height),
			strip: Math.round(document.getElementById('admin-status').getBoundingClientRect().height),
		};
	});
	// Its BOTTOM padding, which is nought in the stylesheet, so the strip grows by
	// exactly the number asked for. The top padding is 6px, and setting that grew
	// the strip by px-6 -- caught by the premise check below, which is the argument
	// for having one.
	const grow = (px) => page.evaluate((px) => {
		document.getElementById('admin-status').style.paddingBottom = px ? px + 'px' : '';
	}, px);
	const drag = async (dy) => {
		const b = await (await page.$('#handle-rail-split')).boundingBox();
		await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
		await page.mouse.down();
		await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + dy, { steps: 12 });
		await page.mouse.up();
		await sleep(400);
	};
	await page.evaluate(() => { try { DaimondAdmin.close(); } catch (e) {} });
	await page.setViewportSize({ width: 1440, height: 900 });
	await sleep(500);
	const even = await rail();
	await drag(-60);
	const set = await rail();
	check('the rail\'s divider can be put somewhere the user chose',
		set.list < even.list - 40 && set.sess > even.sess + 40,
		`diamonds ${even.list}->${set.list}px, chats ${even.sess}->${set.sess}px`);

	const missed = [], moved9 = [];
	for (const h of [900, 1100]) {
		await page.setViewportSize({ width: 1440, height: h });
		await sleep(500);
		for (const px of [37, 54, 97]) {
			const a = await rail();
			await grow(px);
			await sleep(350);
			const b = await rail();
			await grow(0);
			await sleep(300);
			const c = await rail();
			const said = `${h}/+${px}: chats ${a.chats}->${b.chats}, diamonds ${a.list}->${b.list}->${c.list}, chats list ${a.sess}->${b.sess}, strip ${a.strip}->${b.strip}`;
			// The growth has to have reached the rail and left the Chats list room
			// to give, or the clamp is entitled to move the divider and this is not
			// the case being made. Reported apart from a failure, because a check
			// whose premise did not hold has proved nothing rather than passed.
			if (b.strip - a.strip < px - 1 || b.sess >= a.sess || b.sess < MIN_LIST) { missed.push(said); continue; }
			if (b.chats !== a.chats || b.list !== a.list || c.list !== a.list) moved9.push(said);
		}
	}
	check('the strip really grew under the rail, six times over', missed.length === 0,
		missed.length ? missed.join(' | ') : '37, 54 and 97px at 900 and 1100');
	check('a strip taller by any amount leaves a divider the user set exactly where it was',
		moved9.length === 0 && missed.length === 0, moved9.join(' | '));

	// And when the room really does run out, the Chats list keeps its floor and
	// the STORED height is not quietly rewritten to fit: the clamp is on read.
	await page.setViewportSize({ width: 1440, height: 900 });
	await sleep(500);
	await drag(160);            // the divider low, with little left to give
	const low = await rail();
	await grow(60);
	await sleep(400);
	const squeezed = await rail();
	await grow(0);
	await sleep(400);
	const back = await rail();
	check('squeezed past what it can give, the Chats list keeps a usable height',
		squeezed.sess >= MIN_LIST - 1 && squeezed.list < low.list,
		`diamonds ${low.list}->${squeezed.list}, chats ${low.sess}->${squeezed.sess}`);
	check('and the divider returns to the pixel it was left at, nothing having been rewritten',
		back.list === low.list && back.chats === low.chats,
		`diamonds ${low.list}->${squeezed.list}->${back.list}`);
	await page.setViewportSize({ width: 1440, height: 900 });
	await sleep(400);
}

const errs = errors(s).filter(e => !/Failed to load resource|status of \d\d\d|favicon|net::ERR_ABORTED/.test(e));
check('no console errors while the bar was measured', errs.length === 0, errs.slice(0, 3).join(' | '));

await s.close();
console.log('');
console.log(bad.length ? `${ok.length} passed, ${bad.length} failed` : `ALL ${ok.length} CHECKS PASSED`);
process.exit(bad.length ? 1 : 0);
