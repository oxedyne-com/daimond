// gateway: none
// verify_workspacepanel.mjs -- the Workspace panel never crops, and it shows its loading and its failures
// (Workspace panel redesign U1; invariants I1 and I8 of specs/daimond_workspace_panel_design_20261008.md).
//
// The owner, 2026-10-06 10:47: his daimon said it had saved a file "under Daimond's files", and the panel
// showed "Files" over an empty list. `.files-card` was `overflow:hidden` with a `flex:1` tree inside it, so
// with the Email panel stacked below Workspace in the dock column the tree shrank to nothing and the card
// cut `Daimond's files` off its foot. Nothing could be scrolled, because the only scroller was the tree.
//
// Held here, at 1440x900 (Email stacked below Workspace in the dock) and 390x844 (the phone, where the
// Workspace is a destination), with a chat in focus and with a Diamond in focus, `Daimond's files` open:
//   I1  the panel body is ONE scroller the user can scroll (wheel, not scrollIntoView, which scrolls
//       overflow:hidden too); the tree is not an inner scroller and is not squeezed; the last row of the
//       tree, the `Daimond's files` head and its last row are all reachable and hit-testable; nothing
//       between a row and the body clips; the panel does not run under the Email panel.
//   I8  a delayed `file_list` draws a `.files-loading` row (not the empty state, not a bare ellipsis) and
//       then the rows; a failed one draws its reason (`.files-fail`), a refusal as the sentence it is, and
//       never an empty list; `Daimond's files` does the same; the loading row is ONE role in both places.
//
// WSP_BASE=1 serves every www file this tree changed from ed595e3f (`git show`, lane B's pattern), so the gate
// can be seen RED on the unchanged page whatever the tree holds. On ed595e3f itself the two are the same page.
// Run with the world up (`bash dev/world.sh 75 --up`); no gateway.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BASE = 'ed595e3f';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let bad = 0;
const check = (ok, what, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined && detail !== '' ? '  -- ' + detail : ''}`);
	if (!ok) bad++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The base page, when asked for ─────────────────────────────────────────────────
const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const changed = process.env.WSP_BASE
	? git('diff', '--name-only', BASE, '--', 'www').stdout.split('\n').filter(Boolean).map((f) => f.replace(/^www\//, ''))
		.filter((f) => git('cat-file', '-e', `${BASE}:www/${f}`).status === 0)
	: [];
const MIME = { js: 'application/javascript', css: 'text/css', html: 'text/html', json: 'application/json' };
console.log(process.env.WSP_BASE ? `WSP_BASE: ${changed.length} www file(s) served from ${BASE}: ${changed.join(' ')}` : 'serving this tree');
const serveBase = async (page) => {
	for (const f of changed) {
		const body = git('show', `${BASE}:www/${f}`).stdout;
		const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		await page.route(new RegExp('/' + esc + '(\\?.*)?$'), (r) =>
			r.fulfill({ status: 200, contentType: MIME[f.split('.').pop()] || 'text/plain', body }));
	}
};

// ── Eight locales carry the loading word ─────────────────────────────────────────
const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];
const missing = LOCALES.filter((l) => !/'files\.loading'\s*:/.test(fs.readFileSync(path.join(ROOT, 'www/i18n', l + '.js'), 'utf8')));
check(missing.length === 0, 'files.loading is in all eight locales', missing.join(' '));

// ── What a person does ──────────────────────────────────────────────────────────
const CARD = '#panel-work .files-card';
const hit = (page, sel) => page.evaluate((sel) => {
	// Can a person see and press this element? Hit-test its centre, inside the body's box and the screen.
	const E = document.querySelector(sel); if (!E) return { missing: true };
	const c = document.querySelector('#panel-work .files-card').getBoundingClientRect();
	const r = E.getBoundingClientRect();
	const x = r.left + r.width / 2, y = r.top + r.height / 2;
	const at = document.elementFromPoint(x, y);
	const inside = y >= c.top && y <= c.bottom && y >= 0 && y <= innerHeight && x >= 0 && x <= innerWidth;
	return { ok: inside && !!at && (E === at || E.contains(at)), above: r.top < c.top, top: document.querySelector('#panel-work .files-card').scrollTop, y: Math.round(y), card: [Math.round(c.top), Math.round(c.bottom)], at: at ? (at.id || at.className) : null };
}, sel);
/// Scroll the body as a person does until the element can be pressed: the wheel on a desktop,
/// a finger's drag on a phone (a touch page takes no wheel), then the same hit test.
const TOUCH = new WeakMap();
async function reach(page, sel) {
	const c = await page.evaluate(() => { const r = document.querySelector('#panel-work .files-card').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
	const cdp = TOUCH.get(page);
	if (!cdp) await page.mouse.move(c.x, c.y);
	let still = 0, last = -1, h = null;
	for (let i = 0; i < 90; i++) {
		h = await hit(page, sel);
		if (h.missing) { reach.why = 'missing'; return false; }
		if (h.ok) return true;
		if (cdp) {
			// A finger's drag: up the screen to read further down.
			const x = Math.round(c.x), y0 = Math.round(c.y), dir = h.above ? 1 : -1;
			const tp = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
			await tp('touchStart', y0);
			for (let d = 10; d <= 140; d += 10) { await tp('touchMove', y0 + dir * d); await wait(16); }
			await tp('touchEnd');
		}
		else await page.mouse.wheel(0, h.above ? -140 : 140);
		await wait(40);
		still = h.top === last ? still + 1 : 0; last = h.top;
		if (still >= 3) break;
	}
	reach.why = JSON.stringify(h);
	return false;
}
const toTop = async (page) => { await page.evaluate(() => { document.querySelector('#panel-work .files-card').scrollTop = 0; }); await wait(60); }

const GEO = () => {
	const q = (s) => document.querySelector(s);
	const card = q('#panel-work .files-card'), tree = q('#panel-work .files-tree'), sys = q('#sys-tree');
	const cr = card.getBoundingClientRect(), pr = q('#panel-work').getBoundingClientRect();
	const mail = q('#panel-mail'), mr = mail && mail.getClientRects().length ? mail.getBoundingClientRect() : null;
	const last = sys && sys.lastElementChild;
	const clips = [];
	for (let e = last && last.parentElement; e && e !== card; e = e.parentElement) {
		const cs = getComputedStyle(e);
		if ((cs.overflowY !== 'visible' || cs.overflowX !== 'visible') && e.scrollHeight > e.clientHeight + 1) clips.push((e.id || e.className) + ':' + cs.overflowY);
	}
	return {
		overflowY: getComputedStyle(card).overflowY, over: card.scrollHeight - card.clientHeight, cardH: Math.round(cr.height),
		treeH: Math.round(tree.clientHeight), treeSH: tree.scrollHeight, rows: tree.querySelectorAll('.files-row').length,
		sysRows: sys ? sys.querySelectorAll('.files-row').length : 0, clips,
		panelBottom: pr.bottom, mailTop: mr ? mr.top : null, mailLeft: mr ? mr.left : null, panelLeft: pr.left,
	};
};

// ── The loading / failure seam: the tool door and the OPFS root ─────────────────
async function seam(page) {
	await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const orig = m.DaimondApp.prototype.run_tool_outcome;
		window.__wsp = { mode: 'pass', held: [], text: '' };
		m.DaimondApp.prototype.run_tool_outcome = async function (name, args) {
			const w = window.__wsp;
			if (name === 'file_list' && w.mode === 'delay') await new Promise((r) => w.held.push(r));
			if (name === 'file_list' && w.mode === 'fail') return { outcome: 'failed', text: w.text };
			if (name === 'file_list' && w.mode === 'refuse') return { outcome: 'refused', text: w.text };
			return orig.call(this, name, args);
		};
	});
}
const mode = (page, mode, text) => page.evaluate(([m, t]) => { const w = window.__wsp; w.mode = m; w.text = t || ''; if (m === 'pass') { w.held.splice(0).forEach((r) => r()); } }, [mode, text]);
const release = (page) => page.evaluate(() => { window.__wsp.held.splice(0).forEach((r) => r()); window.__wsp.mode = 'pass'; });
const refresh = (page) => page.evaluate(() => { document.querySelector('#panel-work [data-act="refresh"]').click(); });
const treeNow = (page) => page.evaluate(() => {
	const t = document.querySelector('#panel-work .files-tree');
	const q = (s) => t.querySelector(s);
	const cs = (e) => e ? (({ fontSize, color, textAlign, paddingTop, paddingBottom }) => ({ fontSize, color, textAlign, paddingTop, paddingBottom }))(getComputedStyle(e)) : null;
	const l = q('.files-loading'), f = q('.files-fail');
	const c = document.querySelector('#panel-work .files-card').getBoundingClientRect();
	const lr = (l || f) && (l || f).getBoundingClientRect();
	return {
		loading: l ? l.textContent.trim() : null, fail: f ? f.textContent.trim() : null, failRole: f ? f.getAttribute('role') : null,
		empty: !!q('.files-empty:not(.files-dws-hint)'), rows: t.querySelectorAll('.files-row').length, ls: cs(l),
		drawn: !!lr && lr.height > 0, box: lr ? [Math.round(lr.top), Math.round(lr.bottom), Math.round(c.top), Math.round(c.bottom), document.querySelector('#panel-work .files-card').scrollTop] : null,
	};
});
const waitTree = async (page, pred, ms = 5000) => {
	const t0 = Date.now();
	for (;;) { const s = await treeNow(page); if (pred(s)) return s; if (Date.now() - t0 > ms) return s; await wait(60); }
};

// ── One device ──────────────────────────────────────────────────────────────────
async function device(tag, s, size, stacked) {
	const { page } = s;
	console.log(`\n── ${tag}: ${size.width}x${size.height}${stacked ? ', Email stacked below Workspace' : ', Workspace as the destination'} ──`);
	await page.setViewportSize(size);
	await wait(1500);
	// A first run on a phone opens Settings over everything; a person closes it first.
	await page.evaluate(() => { if (getComputedStyle(document.getElementById('settings-modal')).display !== 'none') window.DaimondAdmin.closeModal(); });
	await wait(300);
	check(await page.evaluate(() => getComputedStyle(document.getElementById('settings-modal')).display === 'none'), `${tag}: Settings is closed before the panel is used`);
	const T = (k) => page.evaluate((k) => DaimondI18n.t(k), k);
	// Files to look at, written through the real tool so they exist the way a person's do.
	await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		for (let i = 1; i <= 15; i++) await app.run_tool('file_write', JSON.stringify({ path: 'f' + String(i).padStart(2, '0') + '.md', content: '# ' + i + '\n' }));
		await app.run_tool('file_write', JSON.stringify({ path: 'zz_last.md', content: '# last\n' }));
	});
	if (stacked) {
		await page.evaluate(() => {
			DaimondPanels.setGrid('auto');
			DaimondPanels.panels().filter((x) => x.zone === 'dock').forEach((x) => DaimondPanels.hide(x.id));
			['work', 'mail'].forEach((id) => DaimondPanels.show(id));
		});
	} else {
		await page.evaluate(() => DaimondPanels.show('work'));
	}
	await wait(900);
	await refresh(page); await wait(900);
	await seam(page);

	for (const scope of ['all', 'diamond']) {
		const T2 = `${tag}/${scope === 'all' ? 'chat in focus' : 'Diamond in focus'}`;
		if (scope === 'diamond') {
			await page.evaluate(() => { try { localStorage.removeItem('daimond-files-scope'); } catch (e) {} });
			// The rail is a drawer on a phone, so the button is pressed as a script would press it.
			await page.evaluate(() => document.getElementById('new-diamond-btn').click());
			await page.waitForSelector('.dlg-input', { timeout: 10000 });
			await page.fill('.dlg-input', 'Kitchen renovation');
			await page.click('.dlg-ok', { force: true });
			await wait(1200);
			await page.evaluate(() => DaimondPanels.show('work'));
			await wait(500);
			const id = await page.evaluate(async () => {
				for (const d of JSON.parse(await DaimondCore.diamondApp().list_diamonds())) if (d.name === 'Kitchen renovation') return d.id;
			});
			// A Diamond that has had nothing written yet has no folder: that is "no files yet", not a failure.
			// Pressed as a script presses it: a forced click is inert headless.
			const diamondChip = () => page.evaluate(() => { const c = document.querySelector('.files-scope-chip[data-scope="diamond"]'); if (c) c.click(); return !!c && c.classList.contains('active'); });
			const sc0 = () => page.evaluate(() => { const row = document.querySelector('.files-scope'); return { row: !!row, shown: !!row && row.style.display !== 'none' && !!row.offsetParent, chips: row ? [...row.querySelectorAll('.files-scope-chip')].map((c) => c.dataset.scope + (c.classList.contains('active') ? '*' : '')) : [], ls: (() => { try { return localStorage.getItem('daimond-files-scope'); } catch (e) { return null; } })() }; });
			// Selecting a Diamond can take the panel with it; the refresh button is what always re-lists (dev/verify_dworkspace.mjs).
			await refresh(page); await wait(700);
			for (let i = 0; i < 40 && !(await sc0()).shown; i++) await wait(150);
			await diamondChip(); await wait(900);
			const inD = await page.evaluate(() => { const c = document.querySelector('.files-scope-chip[data-scope="diamond"]'); return !!c && c.classList.contains('active'); });
			check(inD, `${T2}: the Diamond's tree is the one in focus`, JSON.stringify(await sc0()));
			const fresh = await treeNow(page);
			check(fresh.fail === null && fresh.loading === null && fresh.drawn !== undefined, `${T2}: a Diamond with no files yet is not a failure`, JSON.stringify({ fail: fresh.fail, loading: fresh.loading, rows: fresh.rows, empty: fresh.empty }));
			await page.evaluate(async (id) => {
				const m = await import('/pkg/oxedyne_daimond.js');
				const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
				for (let i = 1; i <= 12; i++) await app.run_tool('file_write', JSON.stringify({ path: `diamonds/${id}/saved_${String(i).padStart(2, '0')}.md`, content: '# s\n' }));
				await app.run_tool('file_write', JSON.stringify({ path: `diamonds/${id}/zz_saved_by_the_daimon.md`, content: '# the file\n' }));
			}, id);
			await refresh(page);
			await wait(900);
		}
		await refresh(page); await wait(900);
		// Daimond's files, open.
		await page.evaluate(() => { const h = document.getElementById('sys-head'); if (h.getAttribute('aria-expanded') !== 'true') h.click(); });
		await wait(900);
		await toTop(page);

		// I1
		const g = await page.evaluate(GEO);
		check(g.over > 20, `${T2}: the fixture is taller than the panel body`, `body ${g.cardH}px, ${g.over}px over, ${g.rows} tree rows, ${g.sysRows} store rows`);
		if (stacked) check(g.mailTop !== null && g.mailTop >= g.panelBottom - 1 && Math.abs(g.mailLeft - g.panelLeft) < 2,
			`${T2}: Email is open below Workspace in the same column`, `work bottom ${Math.round(g.panelBottom)}, mail top ${Math.round(g.mailTop)}`);
		check(g.overflowY === 'auto' || g.overflowY === 'scroll', `${T2}: the body is a scroller a person can use`, `overflow-y ${g.overflowY}`);
		check(g.treeSH <= g.treeH + 1 && g.rows > 0, `${T2}: the tree is not squeezed or a scroller of its own`, `${g.treeH}px box, ${g.treeSH}px of rows`);
		check(g.clips.length === 0, `${T2}: nothing between the last store row and the body clips`, g.clips.join(' '));
		if (stacked) check(g.mailTop === null || g.panelBottom <= g.mailTop + 1, `${T2}: the panel does not run under Email`);
		const last = scope === 'all' ? '#panel-work .files-tree > :last-child' : '#panel-work .files-tree .files-row[data-path$="zz_saved_by_the_daimon.md"]';
		await toTop(page);
		{ const ok = await reach(page, last); check(ok, `${T2}: the last row of the tree is reachable by scrolling${scope === 'diamond' ? ' (the file the daimon saved)' : ''}`, ok ? '' : reach.why); }
		{ const ok = await reach(page, '#sys-head'); check(ok, `${T2}: Daimond's files head is reachable by scrolling`, ok ? '' : reach.why); }
		{ const ok = await reach(page, '#sys-tree > :last-child'); check(ok, `${T2}: the last row of Daimond's files is reachable by scrolling`, ok ? '' : reach.why); }

		// I8
		await toTop(page);
		const loadWord = await T('files.loading');
		// A re-read of the folder already on screen keeps its rows, and the scroll place, while it is read.
		await page.evaluate(() => { document.querySelector('#panel-work .files-card').scrollTop = 120; });
		await wait(80);
		// The place is the rows on screen, not the scroll number: a note the refresh puts in the head
		// may wrap to a second line on a phone, and the browser moves scrollTop to keep the rows still.
		const place = () => page.evaluate(() => {
			const c = document.querySelector('#panel-work .files-card'), top = c.getBoundingClientRect().top;
			const r = [...c.querySelectorAll('.files-tree .files-row[data-path]')].find((e) => e.getBoundingClientRect().top >= top);
			return r ? { path: r.dataset.path, y: Math.round(r.getBoundingClientRect().top), st: c.scrollTop } : null;
		});
		const at0 = await place();
		await mode(page, 'delay');
		await refresh(page); await wait(500);
		const keep = await treeNow(page);
		check(keep.loading === null && keep.rows > 0 && !keep.empty, `${T2}: a re-read keeps the rows on screen while it is read`, `loading ${keep.loading}, rows ${keep.rows}, empty ${keep.empty}`);
		await release(page); await wait(700);
		const at1 = await page.evaluate((p) => { const r = p && document.querySelector(`#panel-work .files-tree .files-row[data-path="${CSS.escape(p)}"]`); return r ? Math.round(r.getBoundingClientRect().top) : null; }, at0 && at0.path);
		check(!!at0 && at0.st > 20 && at1 !== null && Math.abs(at1 - at0.y) <= 2, `${T2}: and the rows on screen stay where they were`, `${JSON.stringify(at0)} -> ${at1}`);
		await toTop(page);
		// Nothing drawn yet (the first paint, or another folder): the loading row stands in for the rows.
		await page.evaluate(() => { document.querySelector('#panel-work .files-tree').innerHTML = ''; });
		await mode(page, 'delay');
		await refresh(page);
		let st = await waitTree(page, (x) => x.loading !== null, 3000);
		check(st.loading !== null && st.loading === loadWord && st.loading !== '…', `${T2}: a delayed list draws the loading row`, `"${st.loading}"`);
		{ const ok = st.drawn && await reach(page, '#panel-work .files-tree .files-loading'); check(ok, `${T2}: the loading row is drawn and reachable inside the body`, ok ? '' : JSON.stringify(st.box) + ' ' + reach.why); }
		await toTop(page);
		check(!st.empty && st.rows === 0, `${T2}: and not the empty state, nor stale rows`, `empty ${st.empty}, rows ${st.rows}`);
		if (scope === 'all' && stacked) {
			// The system store's own loading, held at the OPFS root.
			await page.evaluate(() => { const sm = navigator.storage; window.__dir = sm.getDirectory.bind(sm); window.__heldDir = []; sm.getDirectory = () => new Promise((res, rej) => window.__heldDir.push(() => window.__dir().then(res, rej))); });
			await release(page);
			await page.evaluate(() => { document.getElementById('sys-tree').innerHTML = ''; });
			await page.evaluate(() => { const h = document.getElementById('sys-head'); h.click(); h.click(); });
			await wait(500);
			const sl = await page.evaluate(() => { const l = document.querySelector('#sys-tree .files-loading'); return l ? l.textContent.trim() : null; });
			check(sl === loadWord, `${T2}: Daimond's files draws the loading row while its store is read`, `"${sl}"`);
			const two = await page.evaluate(() => {
				const a = document.querySelector('#sys-tree .files-loading'); if (!a) return null;
				const f = (e) => { const c = getComputedStyle(e); return [c.fontSize, c.color, c.textAlign, c.paddingTop, c.paddingBottom].join('|'); }
				const t = document.createElement('div'); t.className = 'files-loading'; t.textContent = 'x'; document.querySelector('#panel-work .files-tree').appendChild(t);
				const r = [f(a), f(t)]; t.remove(); return r;
			});
			check(two && two[0] === two[1], `${T2}: the loading row is one role in the tree and in Daimond's files`, two ? two.join('  vs  ') : 'no row');
			await page.evaluate(() => { window.__heldDir.splice(0).forEach((r) => r()); });
			await wait(700);
			await page.evaluate(() => { navigator.storage.getDirectory = () => Promise.reject(new DOMException('Storage is not available in this window.', 'SecurityError')); });
			await page.evaluate(() => { const h = document.getElementById('sys-head'); h.click(); h.click(); });
			await wait(800);
			const sf = await page.evaluate(() => { const t = document.getElementById('sys-tree'); return { fail: (t.querySelector('.files-fail') || {}).textContent || null, empty: !!t.querySelector('.files-empty'), rows: t.querySelectorAll('.files-row').length }; });
			check(!!sf.fail && !sf.empty && sf.rows === 0 && !/src\/|\[IO/.test(sf.fail), `${T2}: Daimond's files that cannot be read says why, in plain words`, JSON.stringify(sf));
			await page.evaluate(() => { delete navigator.storage.getDirectory; });
			await page.evaluate(() => { const h = document.getElementById('sys-head'); h.click(); h.click(); });
			await wait(700);
		}
		await release(page);
		st = await waitTree(page, (x) => x.loading === null && x.rows > 0, 6000);
		check(st.loading === null && st.rows > 0, `${T2}: released, the rows replace the loading row`, `${st.rows} rows`);

		await mode(page, 'fail', 'Error: [IO Missing] file_list: the folder is not there src/wasm/opfs.rs:210');
		await refresh(page);
		st = await waitTree(page, (x) => x.fail !== null, 4000);
		check(st.fail !== null && st.fail !== '…' && !/src\/|\[IO|Error:/.test(st.fail) && /not there/i.test(st.fail),
			`${T2}: a failed list says why, in plain words`, `"${st.fail}"`);
		check(!st.empty && st.rows === 0 && st.loading === null, `${T2}: and shows no empty state, no rows, no loading row`, `empty ${st.empty}, rows ${st.rows}`);
		{ const ok = st.drawn && await reach(page, '#panel-work .files-tree .files-fail'); check(ok, `${T2}: and the reason is drawn and reachable inside the body`, ok ? '' : JSON.stringify(st.box) + ' ' + reach.why); }
		await toTop(page);
		check(st.failRole === 'alert', `${T2}: the failure is announced (role=alert)`, String(st.failRole));

		const REFUSAL = 'That folder is outside what this Diamond may open.';
		await mode(page, 'refuse', REFUSAL);
		await refresh(page);
		st = await waitTree(page, (x) => x.fail !== null, 4000);
		check(st.fail === REFUSAL, `${T2}: a refusal shows as the sentence it is`, `"${st.fail}"`);

		await mode(page, 'pass');
		await refresh(page);
		st = await waitTree(page, (x) => x.fail === null && x.rows > 0, 6000);
		check(st.fail === null && st.rows > 0, `${T2}: and the list comes back`, `${st.rows} rows`);
	}
}

const route = process.env.WSP_BASE ? serveBase : null;
let D = null, P = null;
try {
	D = await open({ name: 'wspanel', route });
	await device('desktop', D, { width: 1440, height: 900 }, true);
	P = await open({ name: 'wspanelp', route, ua: IPHONE, isMobile: true, touch: true });
	TOUCH.set(P.page, await P.page.context().newCDPSession(P.page));
	await device('phone', P, { width: 390, height: 844 }, false);
} catch (e) {
	console.log('FAIL  the gate itself stopped: ' + (e && e.stack || e));
	bad++;
} finally {
	for (const x of [D, P]) if (x) await x.close().catch(() => {});
}
console.log(`\n${bad ? 'FAILED' : 'PASSED'}: ${bad} failing check(s)`);
process.exit(bad ? 1 : 0);
