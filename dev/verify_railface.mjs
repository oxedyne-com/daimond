// verify_railface.mjs — the rail's second divider, and the crystal's own face.
//
// Two small things the user asked for, both of them about a boundary being
// visible.
//
// The divider: Diamonds accumulate, and the list grew with them until the chat
// tiles were off the bottom of the rail — with the only handle in the rail
// belonging to the Admin pane, which no longer splits anything. So the boundary
// between the two lists moves now, and the proportion is saved with the rest of
// the layout.
//
// The face: the AI panel shows either a conversation or a Diamond's crystal, and
// nothing said which. The crystal takes the mark beside its name and squares its
// corners — square against rounded everywhere else, which has to hold in three
// themes and both skins, since the warm skin's whole idea is a larger radius.
//
//   node dev/verify_railface.mjs
//
// Needs dev/serve.mjs on :8777. No gateway.

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
		saved:    (() => { try { return JSON.parse(localStorage.getItem('daimond-layout') || '{}').railSplit; } catch (e) { return null; } })(),
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

// ── 4. The proportion is remembered ──────────────────────────────────
await drag(-260);
const r4 = await rail();
check('the drag is saved with the rest of the layout',
	typeof r4.saved === 'number' && r4.saved >= 0 && r4.saved <= 1, String(r4.saved));
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'railface');
await sleep(1800);
await closeAdmin();
const r5 = await rail();
// The PROPORTION is what is saved, not the pixels: the furniture below the two
// lists (the status strip) is a different height on an unlocked session than on
// a freshly created one, so the same share is a different number of pixels.
const share = x => x.list / (x.list + x.sess);
check('and the divider comes back at the share it was left at',
	Math.abs(share(r5) - share(r4)) <= 0.03,
	`${share(r4).toFixed(3)} → ${share(r5).toFixed(3)} (${r4.list}px → ${r5.list}px)`);

// ── 5. Double-click puts it back to even ─────────────────────────────
// Guarded, so this file can be RUN against the code before the divider existed:
// a hard dblclick on a missing element aborts the pass instead of failing the
// check that is meant to catch its absence.
if (await p.$('#handle-rail-split')) await p.dblclick('#handle-rail-split', { force: true });
await sleep(500);
const r6 = await rail();
check('a double-click resets the divider to an even split',
	Math.abs(r6.list - r6.sess) <= 24, `${r6.list}px vs ${r6.sess}px`);

// ── 6. The crystal face, in every theme and both skins ───────────────
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

// ── 7. The phone drawer is not divided ───────────────────────────────
await p.setViewportSize({ width: 390, height: 844 });
await sleep(700);
const phone = await rail();
check('on a phone the drawer scrolls as one column, with no divider in it',
	phone.shown === false, `handle shown=${phone.shown}`);
const inline = await p.$eval('#diamond-list', e => e.style.height);
check('and no height is imposed on either list there', inline === '', JSON.stringify(inline));
await shot(s, 'railface-phone');

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
