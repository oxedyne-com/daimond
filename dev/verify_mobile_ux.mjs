// verify_mobile_ux.mjs — walk the real mobile UX pathways, not just geometry.
//
// This exists because a headless "it renders" pass shipped bugs a human hit in
// seconds: iOS-zoom on 14px inputs, a modal titled "Settings" for Credits with no
// corner close, a dead "?" button, emoji toolbar icons. Each check below is one
// pathway a thumb would take.
//
// iOS auto-zoom itself is a Safari behaviour Chromium cannot reproduce, so we test
// its CAUSE instead: no focusable control may be under 16px on a phone.
import { open, signInAs, connectMock } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (!pass && detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Sign-in deferred so we can inspect the account-creation screen first.
const s = await open({ signIn: false, connect: false, name: 'muxtester' });
const { page } = s;
await page.setViewportSize({ width: 390, height: 844 });
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await sleep(400);

// Every input's computed font-size, for the currently-focusable ones.
const smallInputs = async () => page.evaluate(() => {
	const bad = [];
	document.querySelectorAll('input, textarea, select').forEach(el => {
		if (el.offsetParent === null && el.type !== 'hidden') return;   // not visible
		const fs = parseFloat(getComputedStyle(el).fontSize);
		if (fs < 16) bad.push((el.id || el.className || el.tagName) + '=' + fs + 'px');
	});
	return bad;
});

// ── 1. Account creation screen: no sub-16px field (would zoom on focus) ──
check('create-account: identity fields ≥16px', (await smallInputs()).length === 0, JSON.stringify(await smallInputs()));

// Now create the account and connect the mock model.
await signInAs(s, 'muxtester');
await connectMock(s);
await page.evaluate(() => { try { window.DaimondAdmin.closeModal(); } catch (e) {} });
await sleep(300);

// ── 2. Whole app: no sub-16px focusable field anywhere reachable ──
check('app: all visible fields ≥16px', (await smallInputs()).length === 0, JSON.stringify(await smallInputs()));

// ── 3. The drawer opens opaque ──
await page.evaluate(() => document.getElementById('drawer-btn').click());
await sleep(300);
check('drawer: opaque background', await page.evaluate(() => {
	const bg = getComputedStyle(document.getElementById('panel-rail')).backgroundColor;
	return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
}), await page.evaluate(() => getComputedStyle(document.getElementById('panel-rail')).backgroundColor));

// ── 4. Credits: correct title, fits the screen, top-right close that works ──
await page.evaluate(() => document.getElementById('astat-account').click());
await sleep(400);
check('credits: modal is open', await page.evaluate(() => getComputedStyle(document.getElementById('settings-modal')).display !== 'none'));
check('credits: titled "Credits", not "Settings"', await page.evaluate(() => {
	const t = document.querySelector('#admin-credits .admin-title');
	return t && /credit/i.test(t.textContent) && t.offsetParent !== null;
}), await page.evaluate(() => { const t = document.querySelector('#admin-credits .admin-title'); return t ? t.textContent : 'none'; }));
check('credits: no stray "Settings" heading', await page.evaluate(() => {
	const h = document.querySelector('#settings-modal > .modal-card > h2');
	return !h || getComputedStyle(h).display === 'none';
}));
check('credits: card fits within the viewport', await page.evaluate(() => {
	const r = document.querySelector('#settings-modal .modal-card').getBoundingClientRect();
	return r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.height <= window.innerHeight;
}), await page.evaluate(() => { const r = document.querySelector('#settings-modal .modal-card').getBoundingClientRect(); return `h=${Math.round(r.height)} vh=${window.innerHeight} bottom=${Math.round(r.bottom)}`; }));
check('credits: has a top-right × close', await page.evaluate(() => {
	const x = document.getElementById('credits-done');
	if (!x || x.offsetParent === null) return false;
	const r = x.getBoundingClientRect(), card = document.querySelector('#settings-modal .modal-card').getBoundingClientRect();
	return r.right > card.right - 80 && r.top < card.top + 80;		// upper-right region
}));
await page.evaluate(() => document.getElementById('credits-done').click());
await sleep(300);
check('credits: × closes the modal', await page.evaluate(() => getComputedStyle(document.getElementById('settings-modal')).display === 'none'));

// ── 5. Models: correct title ──
await page.evaluate(() => { document.getElementById('drawer-btn').click(); });   // reopen drawer
await sleep(200);
await page.evaluate(() => document.getElementById('astat-model').click());
await sleep(400);
check('models: titled "Models"', await page.evaluate(() => {
	const t = document.querySelector('#admin-models .admin-title');
	return t && /model/i.test(t.textContent) && t.offsetParent !== null;
}));
await page.evaluate(() => { const b = document.getElementById('settings-done'); if (b) b.click(); });
await sleep(300);

// ── 6. The guide "?" actually opens the guide ──
await page.evaluate(() => document.getElementById('guide-btn').click());
await sleep(600);
check('guide: "?" raises the web sheet', await page.evaluate(() =>
	window.DaimondSheet.isOpen() && window.DaimondSheet.guest() === 'web'));
await page.evaluate(() => { try { window.DaimondSheet.close(); } catch (e) {} });
await sleep(300);

// ── 7. The update chip answers a click ──
check('update-chip: visible', await page.evaluate(() => {
	const c = document.getElementById('update-chip'); return c && !c.hidden;
}));
await page.evaluate(() => document.getElementById('update-chip').click());
await sleep(500);
check('update-chip: click gives feedback (not inert)', await page.evaluate(() => {
	const c = document.getElementById('update-chip');
	return /latest|checking|update/i.test(c.title || '');
}), await page.evaluate(() => document.getElementById('update-chip').title));

// ── 8. Files toolbar: real icons, and a new-file dialog with a ≥16px field ──
await page.evaluate(() => { const b = [...document.querySelectorAll('#mnav button')].find(x => x.dataset.mp === 'work'); if (b) b.click(); });
await sleep(400);
check('files: toolbar icons are SVG, not emoji', await page.evaluate(() => {
	const btns = ['new-file', 'new-dir', 'upload', 'up', 'refresh'];
	return btns.every(a => {
		const b = document.querySelector(`[data-act="${a}"]`);
		return b && b.querySelector('svg') && !b.textContent.trim();
	});
}));
check('files: new-file and new-folder icons differ', await page.evaluate(() => {
	const a = document.querySelector('[data-act="new-file"] svg').innerHTML;
	const b = document.querySelector('[data-act="new-dir"] svg').innerHTML;
	return a !== b;
}));
await page.evaluate(() => { const b = document.querySelector('[data-act="new-file"]'); if (b) b.click(); });
await sleep(500);
const dlgSmall = await page.evaluate(() => {
	const inp = [...document.querySelectorAll('input')].find(el => el.offsetParent !== null && /dlg|dialog/.test(el.className + ' ' + (el.closest('[class]') || {}).className));
	if (!inp) return { found: false };
	return { found: true, fs: parseFloat(getComputedStyle(inp).fontSize) };
});
check('files: new-file dialog field is ≥16px', dlgSmall.found ? dlgSmall.fs >= 16 : true, JSON.stringify(dlgSmall));

// ── 9. Nothing threw across all of it ──
const real = s.errs.filter(e => !/Failed to load resource|status of 4\d\d/.test(e));
check('no console errors across the walk', real.length === 0, real.slice(0, 3).join(' | '));

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED: ' + bad.join(', '));
await s.close();
process.exit(bad.length ? 1 : 0);
