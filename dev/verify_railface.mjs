// verify_railface.mjs — the rail's second divider, and the crystal's own face.
//
// Two small things the user asked for, both of them about a boundary being
// visible.
//
// The divider: Diamonds accumulate, and the list grew with them until the chat
// tiles were off the bottom of the rail — with the only handle in the rail
// belonging to the Admin pane, which no longer splits anything. So the boundary
// between the two lists moves now, and A HEIGHT IN PIXELS is saved with the rest
// of the layout. It was a share until 2026-08-28, and a share is spent against a
// room that the Status strip below changes on its own: see section 4.
//
// The face: the AI panel shows either a conversation or a Diamond's crystal, and
// nothing said which. The crystal takes the mark beside its name and squares its
// corners — square against rounded everywhere else, which has to hold in three
// themes and both skins, since the warm skin's whole idea is a larger radius.
//
//   node dev/verify_railface.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway.

import { open, signInAs, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const s = await open({ name: 'railface' });
const p = s.page;

const rail = () => p.evaluate(() => {
	const top  = document.getElementById('rail-top');
	const list = document.getElementById('diamond-list');
	const sess = document.getElementById('session-list');
	const h    = document.getElementById('handle-rail-split');
	const kids = [...(top ? top.children : [])];
	return {
		handle:   !!h,
		shown:    !!h && getComputedStyle(h).display !== 'none',
		// Between the Diamonds list and the Chats head, or it divides the wrong pair.
		between:  !!h && kids.indexOf(h) === kids.indexOf(list) + 1
			&& (kids[kids.indexOf(h) + 1] || {}).className === 'railhead',
		list:     list ? Math.round(list.getBoundingClientRect().height) : 0,
		sess:     sess ? Math.round(sess.getBoundingClientRect().height) : 0,
		// What is on disk, both formats, so the check can say the old one has gone
		// rather than only that the new one is there.
		saved:    (() => { try { return JSON.parse(localStorage.getItem('daimond-layout') || '{}').railH; } catch (e) { return null; } })(),
		share:    (() => { try { return JSON.parse(localStorage.getItem('daimond-layout') || '{}').railSplit; } catch (e) { return null; } })(),
	};
});
/// The Admin drawer is an overlay that rises over the rail, and unlocking opens
/// it — so it sits on top of the divider until it is dismissed. Not a fault in
/// the divider, but it does have to be got out of the way before one can be
/// dragged, exactly as a user would.
async function closeAdmin() {
	const x = await p.$('#admin-close');
	if (x && await x.isVisible()) { await x.click({ force: true }); await sleep(400); }
}
/// Drag the divider by `dy` pixels. Returns false when there is nothing to drag.
async function drag(dy) {
	const el = await p.$('#handle-rail-split');
	if (!el) return false;
	const b = await el.boundingBox();
	if (!b) return false;
	await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
	await p.mouse.down();
	await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + dy, { steps: 12 });
	await p.mouse.up();
	await sleep(400);
	return true;
}

// A few Diamonds and a chat, so both lists have something in them.
for (const n of ['One', 'Two', 'Three']) {
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 10000 });
	await p.fill('.dlg-input', n);
	await p.click('.dlg-ok', { force: true });
	await sleep(700);
}
await p.click('#new-session-btn', { force: true });
await sleep(600);

// ── 1. There is a divider, and it divides the right pair ─────────────
const r0 = await rail();
check('the rail has a divider between Diamonds and Chats', r0.handle && r0.shown);
check('and it sits between the Diamonds list and the Chats head', r0.between === true);

// ── 2. It moves the boundary ─────────────────────────────────────────
check('the divider can be dragged', await drag(150));
const r1 = await rail();
check('dragging down gives the Diamonds list the room',
	r1.list > r0.list + 60, `${r0.list}px → ${r1.list}px`);
check('and takes it from the Chats list, which keeps a usable height',
	r1.sess < r0.sess && r1.sess > 40, `chats ${r0.sess}px → ${r1.sess}px`);
await shot(s, 'railface-dragged');

// ── 3. Neither list can be crushed out of existence ──────────────────
await drag(-900);
const r2 = await rail();
check('dragged hard up, the Diamonds list keeps a height it can be seen at',
	r2.list >= 60, `${r2.list}px`);
await drag(900);
const r3 = await rail();
check('dragged hard down, the Chats list keeps one too',
	r3.sess >= 60, `${r3.sess}px`);

// ── 4. The height is remembered, in pixels ───────────────────────────
// A HEIGHT, not a share, since 2026-08-28. A share is spent against the room the
// two lists have, and that room changes for reasons that have nothing to do with
// the divider: the Status strip below them is a stack of rows that come and go,
// and one row appearing took 28px out of the pane and carried the Chats head 14
// further. `applyRailSplit` in js/daimond.js holds the reasoning, and
// dev/verify_frame.mjs holds the check that the class is fixed rather than the
// instance.
// Back up the pane rather than hard against its floor: a divider at 72px comes
// back at 72px however it is stored, so the reload below would prove nothing.
await drag(-150);
const r4 = await rail();
check('the drag is saved with the rest of the layout, as a height in pixels',
	typeof r4.saved === 'number' && r4.saved > 60 && Math.abs(r4.saved - r4.list) <= 2,
	`stored ${r4.saved}, drawn ${r4.list}px`);
check('and no share is written any more, so there is one format on disk',
	r4.share === undefined, JSON.stringify(r4.share));
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'railface');
await sleep(1800);
await closeAdmin();
const r5 = await rail();
// THE PIXELS, and this check used to compare shares. The furniture below the two
// lists is a different height on an unlocked session than on a freshly created
// one, so the same share came back as a different number of pixels -- which is
// exactly the movement the height was introduced to stop.
check('and the divider comes back at the height it was left at',
	Math.abs(r5.list - r4.list) <= 2, `${r4.list}px → ${r5.list}px`);

// ── 5. A height made on a tall window survives a short one ───────────
// He drags the divider low on a large screen and then opens Daimond on a laptop.
// A raw pixel figure could push the Chats list off the bottom of the rail, so
// what is APPLIED is held inside the room in force -- and what is STORED is his
// gesture, left alone, so the large screen gives it back exactly. The clamp is on
// read; nothing rewrites the figure to fit a window he is only passing through.
await p.setViewportSize({ width: 1440, height: 1100 });
await sleep(700);
await drag(220);
const tall = await rail();
await p.setViewportSize({ width: 1440, height: 820 });
await sleep(700);
const short = await rail();
check('a divider dragged low on a tall window leaves the Chats list usable on a short one',
	short.sess >= 60 && short.list >= 60, `diamonds ${short.list}px, chats ${short.sess}px`);
check('and the short window does not rewrite what he chose',
	typeof tall.saved === 'number' && short.saved === tall.saved,
	`${tall.saved} → ${short.saved}`);
await p.setViewportSize({ width: 1440, height: 1100 });
await sleep(700);
const again = await rail();
check('so the tall window gives the divider back where he put it',
	Math.abs(again.list - tall.list) <= 1, `${tall.list}px → ${short.list}px → ${again.list}px`);

// ── 6. A layout saved before the divider was a height ────────────────
// Every layout ever saved holds a `railSplit`, because it was written whether or
// not anybody had touched the handle. One holding a share somebody chose is spent
// once, at the size in force, and written back as a height. Not left readable for
// ever, and not silently discarded either.
await p.evaluate(() => {
	const j = JSON.parse(localStorage.getItem('daimond-layout') || '{}');
	delete j.railH;
	j.railSplit = 0.78;
	localStorage.setItem('daimond-layout', JSON.stringify(j));
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'railface');
await sleep(1800);
await closeAdmin();
const mig = await rail();
const share = x => x.list / (x.list + x.sess);
// TO THE PIXEL, and it took `railPin` to get there. The first layout runs before
// the Status strip's rows exist, in a pane some 130px taller than the one that
// settles, so converting the share THERE pinned the divider well below where it
// was left -- measured at 0.869 for a stored 0.78, and the clamp then made that
// permanent. The share goes on cutting instead, and what is written down is the
// cut, taken from a room that had settled.
check('a share saved by an older build is honoured, at the size in force',
	Math.abs(share(mig) - 0.78) <= 0.02, share(mig).toFixed(3));
check('and is written back as a height, the share gone from the layout',
	typeof mig.saved === 'number' && mig.saved >= mig.list && mig.share === undefined,
	`railH ${mig.saved}, drawn ${mig.list}px, railSplit ${JSON.stringify(mig.share)}`);

// ── 7. Double-click puts it back to even, and unpins it ──────────────
// Guarded, so this file can be RUN against the code before the divider existed:
// a hard dblclick on a missing element aborts the pass instead of failing the
// check that is meant to catch its absence.
if (await p.$('#handle-rail-split')) await p.dblclick('#handle-rail-split', { force: true });
await sleep(500);
const r6 = await rail();
check('a double-click resets the divider to an even split',
	Math.abs(r6.list - r6.sess) <= 24, `${r6.list}px vs ${r6.sess}px`);
// An even split is not a choice, so it goes on following the window -- which is
// what keeps every user who has never touched the handle on the behaviour they
// have always had. The reset undoes the pinning as well as the position.
await p.setViewportSize({ width: 1440, height: 820 });
await sleep(700);
const r7 = await rail();
check('and a reset divider follows the window again, rather than staying pinned',
	Math.abs(r7.list - r7.sess) <= 24 && r7.list < r6.list - 40,
	`${r6.list}px at 1100 → ${r7.list}px vs ${r7.sess}px at 820`);
await p.setViewportSize({ width: 1440, height: 900 });
await sleep(600);

// ── 8. The crystal face, in every theme and both skins ───────────────
const face = () => p.evaluate(() => {
	const ai = document.getElementById('panel-ai');
	const m  = document.getElementById('chead-mark');
	const cs = getComputedStyle(ai);
	return {
		cls:    ai.classList.contains('crystal-face'),
		radius: parseFloat(cs.borderTopLeftRadius),
		mark:   !!m && getComputedStyle(m).display !== 'none',
		markInHead: !!(m && m.closest('.chead')),
		// The mark is decoration beside a name that is already there, so it must be
		// invisible to a screen reader rather than read out as a second title.
		hidden: !!m && m.getAttribute('aria-hidden') === 'true' && m.getAttribute('alt') === '',
		nameFirst: (() => {
			const head = document.querySelector('.panel.ai .chead');
			if (!head || !m) return null;
			const kids = [...head.children];
			return kids.indexOf(m) < kids.indexOf(head.querySelector('.ctitle'));
		})(),
	};
});
async function selectDiamond(name) {
	await p.evaluate((n) => {
		const box = [...document.querySelectorAll('.diamond-box')]
			.find(b => (b.querySelector('.session-box-name') || {}).textContent === n);
		if (box) box.click();
	}, name);
	await sleep(900);
}
async function selectChat() {
	await p.evaluate(() => {
		const box = document.querySelector('.session-box:not(.diamond-box)');
		if (box) box.click();
	});
	await sleep(700);
}

await selectChat();
const chatFace = await face();
check('a chat wears no mark', chatFace.mark === false && chatFace.cls === false);
check('and keeps the rounded corners everything else in the app has',
	chatFace.radius > 4, `${chatFace.radius}px`);

for (const skin of ['sharp', 'warm']) {
	await p.evaluate(k => window.DaimondSkin.set(k), skin);
	await sleep(500);
	for (const theme of ['dark', 'light', 'lollypop']) {
		await p.evaluate(t => window.DaimondTheme.set(t), theme);
		await sleep(400);
		await selectDiamond('Two');
		const f = await face();
		check(`the crystal squares its corners (${skin}/${theme})`,
			f.cls === true && f.radius === 0, `radius ${f.radius}px`);
		check(`and shows the mark beside the crystal name (${skin}/${theme})`,
			f.mark && f.markInHead && f.nameFirst === true,
			`mark=${f.mark} inHead=${f.markInHead} beforeName=${f.nameFirst}`);
		if (theme === 'dark') await shot(s, `railface-crystal-${skin}`);
		await selectChat();
		const c = await face();
		check(`and the chat gets its corners back (${skin}/${theme})`,
			c.cls === false && c.radius > 4, `radius ${c.radius}px`);
	}
	await p.evaluate(() => window.DaimondTheme.set('dark'));
}
await p.evaluate(() => window.DaimondSkin.set('sharp'));
await sleep(400);
await selectDiamond('Two');
const acc = await face();
check('the mark is decoration, not a second heading, to a screen reader', acc.hidden === true);

// ── 9. The phone drawer is not divided ───────────────────────────────
await p.setViewportSize({ width: 390, height: 844 });
await sleep(700);
const phone = await rail();
check('on a phone the drawer scrolls as one column, with no divider in it',
	phone.shown === false, `handle shown=${phone.shown}`);
const inline = await p.$eval('#diamond-list', e => e.style.height);
check('and no height is imposed on either list there', inline === '', JSON.stringify(inline));
await shot(s, 'railface-phone');

// ── 10. A phone must not eat an old share on its way past ────────────
// The layout is one of the keys pairing copies between devices, and the phone
// draws no divider -- so there is no room to convert a share against and nothing
// to write down. It is carried instead of dropped, and the desktop spends it.
await p.evaluate(() => {
	const j = JSON.parse(localStorage.getItem('daimond-layout') || '{}');
	delete j.railH;
	j.railSplit = 0.34;
	localStorage.setItem('daimond-layout', JSON.stringify(j));
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'railface');
await sleep(1800);
const onPhone = await rail();
check('a phone-only session leaves an old share where it found it',
	onPhone.share === 0.34 && (onPhone.saved === null || onPhone.saved === undefined),
	`railSplit ${onPhone.share}, railH ${JSON.stringify(onPhone.saved)}`);
// RELOADED ON THE PHONE, and the order matters. The share is still in memory
// after the step above, so a desktop viewport set first would cut a divider from
// there whether or not anything survived the write -- and the check would pass on
// code that had just eaten it. Reloading before the window widens makes the disk
// the only source there is.
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'railface');
await sleep(1800);
await p.setViewportSize({ width: 1440, height: 1000 });
await sleep(1400);
await closeAdmin();
const offPhone = await rail();
check('and the next desktop spends it, as a height, the share gone',
	typeof offPhone.saved === 'number' && offPhone.share === undefined
		&& Math.abs(share(offPhone) - 0.34) <= 0.03,
	`railH ${offPhone.saved}, share ${share(offPhone).toFixed(3)}`);

// 402 as well as 502: the unlock path asks the account service what this account
// is entitled to, and with no gateway running that question is answered by
// nothing at all.
const errs = errors(s).filter(e => !/favicon|404|401|402|502|Bad Gateway|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 5));
check('nothing throws while all this happens', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
