// verify_mobile.mjs — the phone shell: chat floor, left drawer, thing-sheet.
//
// Drives the real page at a phone viewport (390×844) and checks the paradigm:
// the rail opens as a left drawer, a stage guest rises as a bottom sheet over
// the chat (never taking a bar slot), the ask pill forwards to the one
// composer, closing the sheet returns the guest to the stage, and growing back
// to desktop reseats everything with the chat still whole.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A browser-only tab talking to no gateway account gets 401s on /api/* — that is
// the disconnected state, not a fault. Judge only real script/page errors.
const realErrs = () => s.errs.filter(e =>
	!/Failed to load resource|status of 401|status of 4\d\d/.test(e));
const shot = async (p) => { try { await page.screenshot({ path: p, timeout: 8000 }); } catch (e) { console.log('  (shot skipped: ' + p + ')'); } };
const raise = async (id) => {			// force a clean open even if open-by-default
	await page.evaluate((x) => { window.DaimondPanels.hide(x); window.DaimondPanels.show(x); }, id);
	await sleep(450);
};

const s = await open({ signIn: true, connect: true, name: 'mobiletester' });
const { page } = s;

// Become a phone. matchMedia('(max-width:760px)') flips, and the shell takes over.
await page.setViewportSize({ width: 390, height: 844 });
// Headless does not reliably advance CSS transitions, so a measured mid-flight
// value is meaningless; disable them so every assertion reads the settled state.
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await sleep(400);

// A chat must exist for the floor to be the conversation.
await page.evaluate(() => { try { document.getElementById('new-session-btn').click(); } catch (e) {} });
await sleep(300);
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /^Start$/.test(x.textContent.trim())); if (b) b.click(); });
await sleep(500);

// ── 1. Boot clean on a phone ───────────────────────────────
check('boot: no console errors', realErrs().length === 0, realErrs().slice(0, 3).join(' | '));
check('boot: shell present', await page.evaluate(() => !!window.DaimondSheet && !!window.DaimondShell));
check('boot: hamburger visible', await page.evaluate(() => {
	const b = document.getElementById('drawer-btn'); return b && getComputedStyle(b).display !== 'none';
}));
check('boot: bar has 4 destinations', await page.evaluate(() =>
	document.querySelectorAll('#mnav button').length === 4));
check('boot: floor is the chat', await page.evaluate(() => document.body.dataset.mpanel === 'ai'));

// ── 2. The drawer ──────────────────────────────────────────
await page.evaluate(() => document.getElementById('drawer-btn').click());
await sleep(350);
check('drawer: opens on hamburger', await page.evaluate(() => document.body.classList.contains('drawer-open')));
check('drawer: rail is on screen', await page.evaluate(() => {
	const r = document.getElementById('panel-rail'); if (!r) return false;
	const x = r.getBoundingClientRect().left; return x > -5;			// slid in from the left
}));
check('drawer: scrim is catching taps', await page.evaluate(() => {
	const sc = document.getElementById('scrim'); return sc && getComputedStyle(sc).pointerEvents === 'auto';
}));
await page.evaluate(() => document.getElementById('scrim').click());
await sleep(350);
check('drawer: scrim tap closes it', await page.evaluate(() => !document.body.classList.contains('drawer-open')));

// ── 3. A thing rises as a sheet ────────────────────────────
await raise('web');
check('sheet: opens for a stage guest', await page.evaluate(() => window.DaimondSheet.isOpen() && window.DaimondSheet.guest() === 'web'));
check('sheet: guest moved into the sheet', await page.evaluate(() => {
	const el = document.getElementById('panel-web');
	return el && el.closest('#msheet') !== null;
}));
check('sheet: floor stays the chat', await page.evaluate(() => document.body.dataset.mpanel === 'ai'));
check('sheet: raised above peek', await page.evaluate(() => {
	const h = document.getElementById('msheet').getBoundingClientRect().height;
	return h > 120;								// well above the ~56px peek
}));
check('sheet: ask pill on screen at half', await page.evaluate(() => {
	const pill = document.getElementById('msheet-ask');
	const r = pill.getBoundingClientRect();
	return r.height > 0 && r.bottom <= window.innerHeight + 1 && r.top >= 0;
}));
check('sheet: web keeps an ask pill', await page.evaluate(() =>
	!document.getElementById('msheet-ask').classList.contains('hidden')));
check('sheet: bar still reachable above sheet', await page.evaluate(() => {
	const bar = document.getElementById('mnav'), sh = document.getElementById('msheet');
	const bz = +getComputedStyle(bar).zIndex || 0, sz = +getComputedStyle(sh).zIndex || 0;
	return bz > sz;
}));
check('sheet: chat composer hidden while sheet up', await page.evaluate(() => {
	const bar = document.querySelector('.ai .chat-input-bar');
	return bar && getComputedStyle(bar).visibility === 'hidden';
}));
await shot('shots/mobile-sheet-web.png');

// ── 4. Tools sheet hides the ask pill ──────────────────────
await raise('tools');
check('sheet: only one guest up at a time', await page.evaluate(() =>
	document.getElementById('panel-web').closest('#msheet') === null &&
	document.getElementById('panel-tools').closest('#msheet') !== null));
check('sheet: tools has no ask pill', await page.evaluate(() =>
	document.getElementById('msheet-ask').classList.contains('hidden')));

// ── 5. Close returns the guest to the stage ────────────────
await page.evaluate(() => document.getElementById('msheet-close').click());
await sleep(400);
check('close: sheet down', await page.evaluate(() => !window.DaimondSheet.isOpen() && !document.body.classList.contains('sheet-open')));
check('close: guest back in the stage', await page.evaluate(() => {
	const el = document.getElementById('panel-tools');
	return el && el.closest('#stage') !== null && el.closest('#msheet') === null;
}));
check('close: engine marks it closed', await page.evaluate(() => !window.DaimondPanels.isOpen('tools')));

// ── 6. The ask pill forwards to the one composer ───────────
await raise('web');
const asked = await page.evaluate(async () => {
	const before = document.querySelectorAll('.chat-msg-user').length;
	document.getElementById('msheet-ask-input').value = 'what is this page';
	document.getElementById('msheet-ask-send').click();
	await new Promise(r => setTimeout(r, 600));
	const after = document.querySelectorAll('.chat-msg-user').length;
	return { before, after, parkedH: document.getElementById('msheet').style.height };
});
check('ask: pill posts a user message to the chat', asked.after === asked.before + 1, JSON.stringify(asked));

// ── 7. Grow back to desktop: everything reseats ────────────
await page.setViewportSize({ width: 1500, height: 950 });
// A real browser fires `resize` on a viewport change; Playwright's
// setViewportSize does not always, so dispatch it as the browser would.
await page.evaluate(() => window.dispatchEvent(new Event('resize')));
await sleep(600);
console.log('  dbg ' + JSON.stringify(await page.evaluate(() => ({
	innerW: window.innerWidth,
	mqMatches: window.matchMedia('(max-width: 760px)').matches,
	sheetOpen: document.body.classList.contains('sheet-open'),
	guest: window.DaimondSheet.guest(),
	webParent: (function () { const e = document.getElementById('panel-web'); return e && e.parentElement ? e.parentElement.id : null; })(),
	webOpen: window.DaimondPanels.isOpen('web'),
}))));
check('desktop: sheet folded away', await page.evaluate(() =>
	!document.body.classList.contains('sheet-open') && !window.DaimondSheet.isOpen()));
check('desktop: rail back in the main column', await page.evaluate(() => {
	const r = document.getElementById('panel-rail');
	return r && r.closest('#main') !== null && getComputedStyle(r).position !== 'fixed';
}));
check('desktop: web guest reseated on the stage', await page.evaluate(() => {
	const el = document.getElementById('panel-web');
	return el && el.closest('#stage') !== null;
}));
check('desktop: no new console errors', realErrs().length === 0, realErrs().slice(0, 3).join(' | '));

await shot('shots/mobile-desktop-after.png');

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED: ' + bad.join(', '));
await s.close();
process.exit(bad.length ? 1 : 0);
