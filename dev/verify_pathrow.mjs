// gateway: none
// verify_pathrow.mjs -- UNBLOCK-13 (D-20261015-16): a path row is one line, cut in the middle, and
// the file name is never cut.
//
// A deep path wrapped the Workspace panel's crumb line onto two and three lines, and a Recent row
// with a long folder ended in "…", which cut the file's own name -- the one part a reader needs.
//
// Held on Chromium at 1440x900 and on WebKit as an iPhone at 390x844, with a new Diamond in focus,
// a file five long folders down, in its Recent and in its Can change:
//   P1  the panel's crumb line is one line, and the current folder's name is whole;
//   P2  the Recent row is one line, and the file name is whole (the folders give way);
//   P3  the Can change row is one line, and the file name is whole;
//   P4  the `+` picker's crumb line is one line, and its rows are, with their names whole.
//
// "Whole" is measured, not read from a class: the name's own text is laid out inside every box
// that clips it, up to the row.
//
// PRW_BASE=<sha> serves that commit's changed www files instead, to see the gate RED on the base page.
// Run with the world up (`bash dev/world.sh 75 --up`); no gateway.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const NAME = 'Kitchen renovation';
const DIRS = ['kitchen-renovation-2026', 'quotes-and-suppliers', 'electrical-and-lighting', 'second-round-revised', 'switchboard'];
const BASE_NAME = 'board-upgrade-quote.md';
const FILE = DIRS.join('/') + '/' + BASE_NAME;

let bad = 0;
const check = (ok, what, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined && detail !== '' ? '  -- ' + detail : ''}`);
	if (!ok) bad++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The base page, when asked for ─────────────────────────────────────────────────
const BASE = process.env.PRW_BASE || '';
const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const changed = BASE
	? git('diff', '--name-only', BASE, '--', 'www').stdout.split('\n').filter(Boolean).map((f) => f.replace(/^www\//, ''))
		.filter((f) => git('cat-file', '-e', `${BASE}:www/${f}`).status === 0)
	: [];
const MIME = { js: 'application/javascript', css: 'text/css', html: 'text/html', json: 'application/json' };
console.log(BASE ? `PRW_BASE: ${changed.length} www file(s) served from ${BASE}` : 'serving this tree');
const route = BASE ? async (page) => {
	for (const f of changed) {
		const body = git('show', `${BASE}:www/${f}`).stdout;
		const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		await page.route(new RegExp('/' + esc + '(\\?.*)?$'), (r) =>
			r.fulfill({ status: 200, contentType: MIME[f.split('.').pop()] || 'text/plain', body }));
	}
} : null;

// ── The measure, in the page ──────────────────────────────────────────────────────
// One line: every laid-out piece of text in the element sits on the first one's line.
// Whole: the text node holding `name` lies inside every clipping box from its parent to `el`.
const MEASURE = ([sel, name]) => {
	const el = typeof sel === 'string' ? document.querySelector(sel) : null;
	if (!el) return { found: false };
	const tops = [];
	const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let n, hit = null;
	while ((n = walk.nextNode())) {
		if (!n.data.trim()) continue;
		const r = document.createRange();
		r.selectNodeContents(n);
		for (const q of r.getClientRects()) if (q.width > 0) tops.push({ m: (q.top + q.bottom) / 2, h: q.height });
		if (name && n.data.indexOf(name) >= 0) hit = n;
	}
	// Two pieces are on one line when their middles are within half a line of each other.
	const mids = [];
	for (const t of tops) if (!mids.some((m) => Math.abs(m - t.m) < t.h / 2)) mids.push(t.m);
	const out = { found: true, lines: mids.length, h: Math.round(el.getBoundingClientRect().height) };
	if (name) {
		if (!hit) { out.whole = false; out.why = 'name not found'; return out; }
		const r = document.createRange();
		r.selectNodeContents(hit);
		const at = hit.data.indexOf(name);
		r.setStart(hit, at); r.setEnd(hit, at + name.length);
		const nb = r.getBoundingClientRect();
		const n1 = [...r.getClientRects()].filter((q) => q.width > 0).length;
		out.whole = n1 === 1;
		if (!out.whole) out.why = `the name is laid out in ${n1} pieces: ` + JSON.stringify([...r.getClientRects()].map((q) => [Math.round(q.left), Math.round(q.right)])) + ' in ' + JSON.stringify([...el.querySelectorAll('*')].map((x) => x.className + ':' + Math.round(x.getBoundingClientRect().left) + '-' + Math.round(x.getBoundingClientRect().right) + ' sw' + x.scrollWidth + ' cw' + x.clientWidth));
		for (let p = hit.parentElement; p && out.whole; p = p.parentElement) {
			const cs = getComputedStyle(p);
			if (cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis') {
				const b = p.getBoundingClientRect();
				if (nb.left < b.left - 1 || nb.right > b.right + 1) { out.whole = false; out.why = `${p.className} clips ${Math.round(nb.right - b.right)}px`; }
			}
			if (p === el) break;
		}
	}
	return out;
};

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
		await app.run_tool('file_write', JSON.stringify({ path: file, content: '# quote\n' }));
	}, FILE);
	await page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', NAME);
	await page.click('.dlg-ok');
	await wait(1200);
	const id = await page.evaluate(async (n) => {
		for (const d of JSON.parse(await DaimondCore.diamondApp().list_diamonds())) if (d.name === n) return d.id;
	}, NAME);
	check(!!id, `${tag}: the Diamond was made`);
	if (!id) return;
	// What it wrote last, as the engine records it: the ring in the store.
	await page.evaluate(async ([id, file]) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		await m.store_write(DaimondRecent.ringPath(id), DaimondRecent.serialise([{ path: file, place: '', at: Date.now() - 60000 }]));
	}, [id, FILE]);
	await page.evaluate(() => DaimondPanels.show('work'));
	await wait(600);
	await page.evaluate(() => {
		const more = document.querySelector('#panel-work [data-act="ws-more"]');
		if (!more) return;
		more.click();
		const it = document.querySelector('.railhead-menu [data-act="refresh"]');
		if (it) it.click(); else more.click();
	});
	await wait(1200);
	// Down the tree as a person goes, one folder row at a time.
	let acc = '';
	for (const d of DIRS) {
		acc = acc ? acc + '/' + d : d;
		const sel = `#panel-work .files-tree .files-row[data-path="${acc}"]`;
		await page.waitForSelector(sel, { timeout: 10000 }).catch(async (e) => {
			console.log('tree: ' + await page.evaluate(() => [...document.querySelectorAll('#panel-work .files-tree .files-row')].map((r) => r.dataset.path).join(' | ')));
			throw e;
		});
		await page.click(sel);
		await wait(500);
	}
	const fileSel = `#panel-work .files-tree .files-row[data-path="${FILE}"]`;
	await page.waitForSelector(fileSel, { timeout: 10000 });

	const p1 = await page.evaluate(MEASURE, ['#panel-work .files-path', DIRS[DIRS.length - 1]]);
	check(p1.found && p1.lines === 1 && p1.whole, `${tag}: P1 the crumb line is one line, the current folder whole`, JSON.stringify(p1));

	// Into the Diamond, through the row's ⋯ (a long-press on a phone).
	await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), fileSel);
	await wait(200);
	if (phone) {
		await page.evaluate((s) => {
			const r = document.querySelector(s), b = r.getBoundingClientRect();
			r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', isPrimary: true,
				clientX: b.left + b.width / 3, clientY: b.top + b.height / 2 }));
		}, fileSel);
		await wait(750);
	} else {
		await page.hover(fileSel);
		await wait(200);
		await page.click(fileSel + ' [data-act="row-more"]');
		await wait(200);
	}
	await page.click('.railhead-menu[data-menu="row"] [data-act="attach"]');
	await wait(1500);

	const recSel = `#panel-work .files-focus .r[data-kind="recent"]`;
	const p2 = await page.evaluate(MEASURE, [recSel, BASE_NAME]);
	check(p2.found && p2.lines === 1 && p2.whole, `${tag}: P2 the Recent row is one line, the file name whole`, JSON.stringify(p2));
	const canSel = await page.evaluate((base) => {
		const rows = [...document.querySelectorAll('#panel-work .files-focus .r:not([data-kind="recent"])')];
		const r = rows.find((x) => x.textContent.indexOf(base) >= 0);
		if (!r) return null;
		r.dataset.prw = '1';
		return '#panel-work .files-focus .r[data-prw="1"]';
	}, BASE_NAME);
	const p3 = canSel ? await page.evaluate(MEASURE, [canSel, BASE_NAME]) : { found: false };
	check(p3.found && p3.lines === 1 && p3.whole, `${tag}: P3 the Can change row is one line, the file name whole`, JSON.stringify(p3));

	// The `+` picker, walked down to the same folder.
	await page.evaluate(() => DaimondPanels.hide && DaimondPanels.hide('work'));
	await wait(600);
	// The crystal footer's workspace strip, folded at rest: opened as a person opens it.
	await page.evaluate(() => {
		if ([...document.querySelectorAll('[data-act="attach-add"]')].some((x) => x.getClientRects().length)) return;
		const f = [...document.querySelectorAll('.arte-strip.foot-toggle')].find((x) => x.getClientRects().length);
		if (f) f.click();
	});
	await wait(600);
	const opened = await page.evaluate(() => {
		const b = [...document.querySelectorAll('[data-act="attach-add"]')].find((x) => x.getClientRects().length);
		if (b) b.click();
		return !!b;
	});
	check(opened, `${tag}: the + picker opens`, opened ? '' : await page.evaluate(() =>
		[...document.querySelectorAll('[data-act="attach-add"]')].map((x) => x.outerHTML.slice(0, 120) + ' rects=' + x.getClientRects().length).join(' | ') || 'none') + ' toggles: ' + await page.evaluate(() => [...document.querySelectorAll('.foot-toggle')].map((x) => x.className + ':' + x.textContent + ':' + x.getClientRects().length).join(' | ')));
	if (!opened) return;
	await page.waitForSelector('.attach-pick-row', { timeout: 10000 });
	for (const d of DIRS) {
		const ok = await page.evaluate((d) => {
			const b = [...document.querySelectorAll('.attach-pick-name.dir')].find((x) => x.textContent.trim() === d);
			if (b) b.click();
			return !!b;
		}, d);
		if (!ok) { check(false, `${tag}: P4 the picker lists ${d}`); return; }
		await wait(600);
	}
	const p4 = await page.evaluate(MEASURE, ['.attach-pick-path', DIRS[DIRS.length - 1]]);
	check(p4.found && p4.lines === 1 && p4.whole, `${tag}: P4 the picker's crumb line is one line, the current folder whole`, JSON.stringify(p4));
	const prSel = await page.evaluate((base) => {
		const r = [...document.querySelectorAll('.attach-pick-row')].find((x) => x.textContent.indexOf(base) >= 0);
		if (!r) return null;
		r.dataset.prw = '1';
		return '.attach-pick-row[data-prw="1"]';
	}, BASE_NAME);
	const p4r = prSel ? await page.evaluate(MEASURE, [prSel, BASE_NAME]) : { found: false };
	check(p4r.found && p4r.lines === 1 && p4r.whole, `${tag}: P4 the picker's row is one line, the file name whole`, JSON.stringify(p4r));
	await page.keyboard.press('Escape').catch(() => {});
}

let D = null, P = null;
try {
	D = await open({ name: 'prwd', route, browser: 'chromium' });
	await device('chromium desktop', D, { width: 1440, height: 900 }, false);
	P = await open({ name: 'prwp', route, browser: 'webkit', ua: IPHONE, touch: true });
	await device('webkit phone', P, { width: 390, height: 844 }, true);
} catch (e) {
	console.log('FAIL  the gate itself stopped: ' + (e && e.stack || e));
	bad++;
} finally {
	for (const x of [D, P]) if (x) await x.close().catch(() => {});
}
console.log(`\n${bad ? 'FAILED' : 'PASSED'}: ${bad} failing check(s)`);
process.exit(bad ? 1 : 0);
