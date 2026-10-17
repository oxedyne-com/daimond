// gateway: none
// verify_wsadd.mjs -- UNBLOCK-24 (D-20261017-12): a brand-new Diamond's workspace is set from the
// Workspace panel, on a desktop and on a phone.
//
// The owner, 17 Oct: "I just created a new daimond and how the fuck am I supposed to set its workspace?
// ... the Workspace panel ellipses adjacent to a file/folder in the list view doesn't allow it to be added
// to the current chat workspace." The row ⋯ held rename, delete and download only, and the ghost ◈ that
// does add was hidden at rest on a phone (its touch rule lost to the hover-only hide), so a phone had no
// visible way at all.
//
// Held on Chromium at 1440x900 (hover, then the ⋯) and on WebKit as an iPhone at 390x844 (the ◈ drawn at
// rest, and the long-press ⋯), with a new Diamond in focus:
//   A1  Can change shows the one-line pointer while nothing is added, and loses it once something is;
//   A2  on a phone the tree's ghost ◈ is drawn at rest;
//   A3  a file's ⋯ offers "Add to <Diamond>" first; pressing it puts the file in the Diamond's fence;
//   A4  the same ⋯ then offers "Remove from <Diamond>"; pressing it takes the file out, with the Undo.
//
// WSA_BASE=<sha> serves that commit's changed www files instead, to see the gate RED on the unchanged page.
// Run with the world up (`bash dev/world.sh 75 --up`); no gateway.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const NAME = 'Kitchen renovation', FILE = 'plan.md';

let bad = 0;
const check = (ok, what, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined && detail !== '' ? '  -- ' + detail : ''}`);
	if (!ok) bad++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The base page, when asked for ─────────────────────────────────────────────────
const BASE = process.env.WSA_BASE || '';
const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const changed = BASE
	? git('diff', '--name-only', BASE, '--', 'www').stdout.split('\n').filter(Boolean).map((f) => f.replace(/^www\//, ''))
		.filter((f) => git('cat-file', '-e', `${BASE}:www/${f}`).status === 0)
	: [];
const MIME = { js: 'application/javascript', css: 'text/css', html: 'text/html', json: 'application/json' };
console.log(BASE ? `WSA_BASE: ${changed.length} www file(s) served from ${BASE}` : 'serving this tree');
const route = BASE ? async (page) => {
	for (const f of changed) {
		const body = git('show', `${BASE}:www/${f}`).stdout;
		const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		await page.route(new RegExp('/' + esc + '(\\?.*)?$'), (r) =>
			r.fulfill({ status: 200, contentType: MIME[f.split('.').pop()] || 'text/plain', body }));
	}
} : null;

// ── What a person does ──────────────────────────────────────────────────────────
const HEADDOOR = (act) => {
	const more = document.querySelector('#panel-work [data-act="ws-more"]');
	if (!more) return false;
	more.click();
	const it = document.querySelector(`.railhead-menu [data-act="${act}"]`);
	if (it) { it.click(); return true; }
	if (document.querySelector('.railhead-menu')) more.click();
	return false;
};
const rowSel = `#panel-work .files-tree .files-row[data-path="${FILE}"]`;
const MENU = () => {
	const m = document.querySelector('.railhead-menu[data-menu="row"]');
	return m ? [...m.querySelectorAll('[data-act]')].map((b) => ({ act: b.dataset.act, text: b.textContent })) : null;
};
const STATE = ([sel, id, file]) => (async () => {
	const shown = (el) => { if (!el) return false; const cs = getComputedStyle(el), r = el.getBoundingClientRect();
		return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && r.width > 0 && r.height > 0; };
	const r = document.querySelector(sel), dm = r && r.querySelector('[data-act="mark"]');
	const keys = DaimondRecent.boundsKeys(await DaimondDiamond.bounds(id));
	return { row: !!r, ghost: !!dm && dm.classList.contains('ghost'), dmShown: shown(dm),
		pointer: shown(document.querySelector('#panel-work .files-focus .files-focus-note')),
		in: keys.some((k) => k.endsWith(':' + file)), undo: !!(r && r.querySelector('[data-act="undo"]')) };
})();

async function rowMenu(page, phone) {
	await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), rowSel);
	await wait(200);
	if (phone) {
		// A long-press: the row's own touch handler, as a finger's pointer events reach it.
		await page.evaluate((s) => {
			const r = document.querySelector(s), b = r.getBoundingClientRect();
			const at = { bubbles: true, pointerType: 'touch', isPrimary: true, clientX: b.left + b.width / 3, clientY: b.top + b.height / 2 };
			r.dispatchEvent(new PointerEvent('pointerdown', at));
		}, rowSel);
		await wait(750);
	} else {
		await page.hover(rowSel);
		await wait(200);
		await page.click(rowSel + ' [data-act="row-more"]');
		await wait(200);
	}
	return page.evaluate(MENU);
}

async function device(tag, s, size, phone) {
	const { page } = s;
	console.log(`\n── ${tag}: ${size.width}x${size.height} ──`);
	await page.setViewportSize(size);
	await wait(1500);
	await page.evaluate(() => { if (getComputedStyle(document.getElementById('settings-modal')).display !== 'none') window.DaimondAdmin.closeModal(); });
	await wait(300);
	await page.evaluate(async (file) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: file, content: '# plan\n' }));
	}, FILE);
	// A new Diamond, made as a person makes one.
	await page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', NAME);
	await page.click('.dlg-ok', { force: true });
	await wait(1200);
	await page.evaluate(() => DaimondPanels.show('work'));
	await wait(600);
	await page.evaluate(HEADDOOR, 'refresh');
	await wait(1200);
	const id = await page.evaluate(async (n) => {
		for (const d of JSON.parse(await DaimondCore.diamondApp().list_diamonds())) if (d.name === n) return d.id;
	}, NAME);
	check(!!id, `${tag}: the Diamond was made`);
	if (!id) return;
	const st = () => page.evaluate(STATE, [rowSel, id, FILE]);

	let s0 = await st();
	check(s0.row && s0.ghost && !s0.in, `${tag}: the file is in the tree, not yet in the Diamond`, JSON.stringify(s0));
	check(s0.pointer, `${tag}: A1 Can change says where adding is while nothing is added`, JSON.stringify(s0));
	if (phone) check(s0.dmShown, `${tag}: A2 the ghost ◈ is drawn at rest on a phone`, JSON.stringify(s0));

	let m = await rowMenu(page, phone);
	const add = m && m[0];
	check(!!add && add.act === 'attach' && add.text.includes(NAME), `${tag}: A3 the ⋯ offers Add to the Diamond, first`, JSON.stringify(m));
	if (add && add.act === 'attach') {
		await page.click('.railhead-menu[data-menu="row"] [data-act="attach"]', { force: true });
		await wait(1500);
	} else { await page.keyboard.press('Escape').catch(() => {}); await wait(200); }
	const s1 = await st();
	check(s1.in && !s1.ghost, `${tag}: A3 the press puts the file in the Diamond, and its ◈ shows it`, JSON.stringify(s1));
	check(!s1.pointer, `${tag}: A1 the pointer goes once something is added`, JSON.stringify(s1));

	m = await rowMenu(page, phone);
	const rem = m && m[0];
	check(!!rem && rem.act === 'detach' && rem.text.includes(NAME), `${tag}: A4 the ⋯ then offers Remove from the Diamond`, JSON.stringify(m));
	if (rem && rem.act === 'detach') {
		await page.click('.railhead-menu[data-menu="row"] [data-act="detach"]', { force: true });
		await wait(1200);
	} else { await page.keyboard.press('Escape').catch(() => {}); await wait(200); }
	const s2 = await st();
	check(!s2.in && s2.undo, `${tag}: A4 the press takes it out at once, with the Undo`, JSON.stringify(s2));
}

let D = null, P = null;
try {
	D = await open({ name: 'wsaddd', route, browser: 'chromium' });
	await device('chromium desktop', D, { width: 1440, height: 900 }, false);
	P = await open({ name: 'wsaddp', route, browser: 'webkit', ua: IPHONE, touch: true });
	await device('webkit phone', P, { width: 390, height: 844 }, true);
} catch (e) {
	console.log('FAIL  the gate itself stopped: ' + (e && e.stack || e));
	bad++;
} finally {
	for (const x of [D, P]) if (x) await x.close().catch(() => {});
}
console.log(`\n${bad ? 'FAILED' : 'PASSED'}: ${bad} failing check(s)`);
process.exit(bad ? 1 : 0);
