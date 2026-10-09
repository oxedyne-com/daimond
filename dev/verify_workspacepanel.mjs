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
// Workspace round 2, P2+E4 (specs/daimond_workspace_firstprinciples_20261009.md): the scope, reach and
// toolchain rows and the DAIMOND.md chip are gone, and a focus section draws what is in focus, its Recent and
// what it Can change. Held at both sizes, with each focus:
//   P2  no scope/reach/kits/instructions chip in the DOM; the head holds the title, the ⋯ (toolchains, a
//       Diamond's alone) and the ×; the focus section names the focus, draws Recent newest first and Can
//       change; on a phone its rows and ◈ are 44px.
//   N1  Can change rows = own folder ∪ marks in force ∪ waiting marks ∪ granted toolchains, set equality
//       both ways against the fence's own inputs (`DaimondDiamond.bounds`); every lit paperclip in the
//       tree is in that set; a toolchain granted from the head ⋯ appears in it.
//   P3  a tree row shows at most its ◈ at rest: no paperclip, pen or ×; the rest is in the row ⋯, which
//       comes out on hover and on right-click on a desktop and on a long-press on a phone (no ⋯ drawn
//       there); the ⋯ holds rename, delete and, on a file, download; on the user's own mark, share and
//       read only; on a phone the ◈ is 44px.
//   N5  pressing a mark's ◈ takes it away at once, with no dialog: the row stays where it was, dimmed,
//       with an Undo; the Undo puts it back in force; left alone, the Undo goes after five seconds and
//       the mark stays away. Can change keeps N1 throughout (a taken row is not one of its rows).
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
// WSP_BASE=1 serves ed595e3f (I1, I8); WSP_BASE=<sha> serves that commit (dfd760b3 for the P2 focus section).
const BASE = process.env.WSP_BASE && process.env.WSP_BASE !== '1' ? process.env.WSP_BASE : 'ed595e3f';
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
		// The page itself is asked for as `/` and is served by the dev server, which writes into it, so it
		// stays this tree's: on the base, the head's ⋯ is there but nothing hides it.
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
	// A chat in focus, so the first pass has a focus for its section to be about. The rail is a drawer on a
	// phone, so the button is pressed as a script would press it.
	await page.evaluate(() => document.getElementById('new-session-btn').click());
	await wait(800);
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

	let did = null;
	for (const scope of ['all', 'diamond']) {
		const T2 = `${tag}/${scope === 'all' ? 'chat in focus' : 'Diamond in focus'}`;
		if (scope === 'diamond') {
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
			check(!!id, `${T2}: the Diamond was made`);
			if (!id) continue;
			// A Diamond that has had nothing written yet has no folder: that is "no files yet", not a failure.
			await refresh(page); await wait(700);
			const fresh = await treeNow(page);
			check(fresh.fail === null && fresh.loading === null && fresh.drawn !== undefined, `${T2}: a Diamond with no files yet is not a failure`, JSON.stringify({ fail: fresh.fail, loading: fresh.loading, rows: fresh.rows, empty: fresh.empty }));
			await page.evaluate(async (id) => {
				const m = await import('/pkg/oxedyne_daimond.js');
				const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
				for (let i = 1; i <= 12; i++) await app.run_tool('file_write', JSON.stringify({ path: `diamonds/${id}/saved_${String(i).padStart(2, '0')}.md`, content: '# s\n' }));
				await app.run_tool('file_write', JSON.stringify({ path: `diamonds/${id}/zz_saved_by_the_daimon.md`, content: '# the file\n' }));
				// A mark in force here, and one waiting for a press here (made on another device).
				await app.run_tool('file_write', JSON.stringify({ path: 'papers/a.md', content: '# a\n' }));
				await app.add_link(id, 'diamond:' + id, 'dir:[browser]papers', 'holds', '', 'user');
				await app.add_link(id, 'diamond:' + id, 'dir:[browser]drafts', 'holds', '', 'user');
				if (window.DaimondAttach && DaimondAttach.confirmHere) await DaimondAttach.confirmHere(id, 'dir:[browser]papers');
				// Recent, as the daimon's writes leave it: the ring in the Diamond's own folder.
				const now = Date.now();
				if (window.DaimondRecent) await app.run_tool('file_write', JSON.stringify({ path: DaimondRecent.ringPath(id), content: DaimondRecent.serialise([
					{ path: `diamonds/${id}/zz_saved_by_the_daimon.md`, place: '', at: now - 1000 },
					{ path: `diamonds/${id}/saved_01.md`, place: '', at: now - 3600000 }]) }));
			}, id);
			await page.evaluate(() => document.dispatchEvent(new CustomEvent('daimond-links-changed')));
			await page.evaluate(() => document.dispatchEvent(new CustomEvent('daimond-diamond-changed')));
			did = id;
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
		await toTop(page);
		{ const ok = await reach(page, '#panel-work .files-tree > :last-child'); check(ok, `${T2}: the last row of the tree is reachable by scrolling`, ok ? '' : reach.why); }
		{ const ok = await reach(page, '#sys-head'); check(ok, `${T2}: Daimond's files head is reachable by scrolling`, ok ? '' : reach.why); }
		{ const ok = await reach(page, '#sys-tree > :last-child'); check(ok, `${T2}: the last row of Daimond's files is reachable by scrolling`, ok ? '' : reach.why); }
		await focusSection(page, T2, scope === 'diamond' ? did : null, !stacked);
		await rowControls(page, T2, scope === 'diamond' ? did : null, !stacked);
		await toTop(page);
		// WSP_SHOTS=<dir> keeps a picture of the panel at its top, for the before/after record.
		if (process.env.WSP_SHOTS) await page.screenshot({ path: path.join(process.env.WSP_SHOTS, T2.replace(/[^\w-]+/g, '_') + '.png') });

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

// ── P2 and N1: the focus section ──────────────────────────────────────────────────
const FOCUS = () => {
	const vis = (el) => !!el && !el.hidden && el.offsetParent !== null && el.getBoundingClientRect().height > 0;
	const head = document.querySelector('#panel-work .railhead');
	const sec = document.querySelector('#panel-work .files-focus');
	const rows = (g) => {
		const out = [];
		const gl = sec && sec.querySelector(`.gl[data-group="${g}"]`);
		for (let el = gl && gl.nextElementSibling; el && el.classList.contains('r'); el = el.nextElementSibling) out.push(el);
		return out;
	};
	const can = rows('can'), rec = rows('recent');
	// A toolchain ghost (E3) is an offer, not part of the fence.
	const keys = can.filter((r) => r.dataset.kind !== 'taken' && r.dataset.kind !== 'kitghost').map((r) => r.dataset.kind === 'kit' ? 'kit:' + r.dataset.kit
		: r.dataset.kind + ':' + r.dataset.path + (r.querySelector('.place') ? ':ro' : '')).sort();
	const lit = [...document.querySelectorAll('#panel-work .files-tree .files-row')]
		.filter((r) => r.querySelector('.attach-btn.on, [data-act="mark"].on, [data-act="mark"].ro')).map((r) => (r.dataset.path || '').replace(/\/$/, ''));
	const h = (el) => el ? Math.round(el.getBoundingClientRect().height) : 0;
	return {
		gone: ['.files-scope', '.files-reach', '.files-kits', '#instructions-chip', '.instructions-chip', '.files-mark-here', '.attached-group']
			.filter((q) => document.querySelector('#panel-work ' + q) || document.querySelector(q)),
		title: vis(head && head.querySelector('[role="heading"]')),
		more: vis(head && head.querySelector('[data-act="ws-more"]')),
		close: vis(head && head.querySelector('.panel-close')),
		shown: vis(sec),
		sh: sec && sec.querySelector('.sh') ? sec.querySelector('.sh').textContent : null,
		hasCan: !!(sec && sec.querySelector('.gl[data-group="can"]')),
		rec: rec.map((r) => r.dataset.path),
		keys, lit,
		minRow: Math.min(...[...can, ...rec].map(h)),
		minDm: Math.min(...can.map((r) => h(r.querySelector('.dm')))),
	};
};
async function focusSection(page, T2, id, phone) {
	await toTop(page);
	let f = await page.evaluate(FOCUS);
	for (let i = 0; i < 20 && !(f.shown && f.hasCan); i++) { await wait(150); f = await page.evaluate(FOCUS); }
	check(f.gone.length === 0, `${T2}: no scope, reach or toolchain row and no DAIMOND.md chip`, f.gone.join(' '));
	// On a phone the Workspace is a destination, left by the app's own way back (I7), so it draws no ×.
	check(f.title && f.close === !phone && f.more === !!id, `${T2}: the head holds the title, ${id ? 'the ⋯' : 'no ⋯ (nothing to put in it)'}${phone ? '' : ' and the ×'}`, JSON.stringify({ title: f.title, more: f.more, close: f.close }));
	check(f.shown && f.hasCan && !!f.sh, `${T2}: the focus section names the focus and draws Can change`, JSON.stringify({ shown: f.shown, sh: f.sh, can: f.hasCan }));
	if (phone) check(f.minRow >= 44 && f.minDm >= 44, `${T2}: its rows and ◈ are 44px on a phone`, `row ${f.minRow}px, ◈ ${f.minDm}px`);
	if (!id) return;
	check(f.sh === 'Kitchen renovation', `${T2}: the section head is the Diamond's name`, `"${f.sh}"`);
	check(f.rec.length === 2 && /zz_saved_by_the_daimon\.md$/.test(f.rec[0]) && /saved_01\.md$/.test(f.rec[1]),
		`${T2}: Recent draws the daimon's writes, newest first`, JSON.stringify(f.rec));
	const n1 = async () => {
		const want = await page.evaluate(async (id) => DaimondRecent.boundsKeys(await DaimondDiamond.bounds(id)), id);
		f = await page.evaluate(FOCUS);
		const a = want.filter((k) => !f.keys.includes(k)), b = f.keys.filter((k) => !want.includes(k));
		return { want, a, b };
	};
	let r = await n1();
	const kinds = new Set(r.want.map((k) => k.split(':')[0]));
	check(kinds.has('own') && kinds.has('mark') && kinds.has('ghost'), `${T2}: the fixture has its own folder, a mark in force and a waiting one`, r.want.join(' '));
	check(r.a.length === 0 && r.b.length === 0, `${T2}: N1 Can change rows = the fence's inputs, both ways`, `missing ${r.a.join(' ') || '-'}; extra ${r.b.join(' ') || '-'}`);
	const marks = r.want.filter((k) => /^mark:/.test(k)).map((k) => k.replace(/^mark:/, '').replace(/:ro$/, ''));
	const stray = f.lit.filter((p) => !marks.some((m) => m === p || m.endsWith(']' + p)));
	check(stray.length === 0, `${T2}: N1 every lit paperclip in the tree is in Can change`, `lit ${f.lit.join(' ') || '-'}; stray ${stray.join(' ') || '-'}`);
	// A toolchain, from the head ⋯.
	const menu = await page.evaluate(async () => {
		document.querySelector('#panel-work [data-act="ws-more"]').click();
		await new Promise((r) => setTimeout(r, 300));
		const m = document.querySelector('.railhead-menu');
		const out = { head: m && m.querySelector('.railhead-menu-head') ? m.querySelector('.railhead-menu-head').textContent : null, kits: m ? m.querySelectorAll('[data-kit]').length : 0 };
		const py = m && m.querySelector('[data-kit="python"]');
		if (py) py.click();
		return out;
	});
	check(!!menu.head && menu.kits === 5, `${T2}: the head ⋯ holds the toolchains under a label`, JSON.stringify(menu));
	for (let i = 0; i < 20; i++) { await wait(150); if ((await page.evaluate(FOCUS)).keys.includes('kit:python')) break; }
	r = await n1();
	check(r.want.includes('kit:python') && r.a.length === 0 && r.b.length === 0, `${T2}: a toolchain granted from the ⋯ is a Can change row, and N1 holds`, `missing ${r.a.join(' ') || '-'}; extra ${r.b.join(' ') || '-'}`);
	// Leave it as it was, so the next size starts from the same Diamond.
	await page.evaluate(async () => {
		document.querySelector('#panel-work [data-act="ws-more"]').click();
		await new Promise((r) => setTimeout(r, 300));
		const py = document.querySelector('.railhead-menu [data-kit="python"]');
		if (py) py.click();
	});
	await wait(600);
}

// ── P3 and N5: the row's ◈, its ⋯, and the inline Undo ───────────────────────────
const ROWS = (phone) => {
	const shown = (el) => {
		if (!el || el.hidden) return false;
		const cs = getComputedStyle(el), r = el.getBoundingClientRect();
		return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05 && r.width > 0 && r.height > 0;
	};
	const rows = [...document.querySelectorAll('#panel-work .files-tree .files-row[data-path]')];
	const extra = [], noMore = [], noMark = [], small = [];
	for (const r of rows) {
		const vis = [...r.querySelectorAll('button')].filter(shown).filter((b) => b.dataset.act !== 'mark');
		if (vis.length) extra.push(r.dataset.path + ':' + vis.map((b) => b.dataset.act || b.className).join('+'));
		if (!r.querySelector('[data-act="row-more"]')) noMore.push(r.dataset.path);
		const m = r.querySelector('[data-act="mark"]');
		if (!m) noMark.push(r.dataset.path);
		else if (phone && shown(m) && m.getBoundingClientRect().height < 44) small.push(r.dataset.path + ':' + Math.round(m.getBoundingClientRect().height));
	}
	return {
		n: rows.length, extra, noMore, noMark, small,
		old: [...document.querySelectorAll('#panel-work .files-tree .files-row :is(.attach-btn, .files-del, .files-ren, .files-get, .files-free, .files-pin)')].length,
	};
};
const rowSel = (p) => `#panel-work .files-tree .files-row[data-path="${p}"]`;
const MENU = () => {
	const m = document.querySelector('.railhead-menu[data-menu="row"]');
	return m ? { path: m.dataset.path, acts: [...m.querySelectorAll('[data-act]')].map((b) => b.dataset.act) } : null;
};
const closeMenu = async (page) => { await page.keyboard.press('Escape').catch(() => {}); await wait(200); };
async function rowControls(page, T2, id, phone) {
	await toTop(page);
	await page.mouse.move(2, 2);
	await wait(300);
	const r = await page.evaluate(ROWS, phone);
	check(r.n > 0 && r.old === 0, `${T2}: P3 no paperclip, pen, × or cloud button on a tree row`, `${r.old} of them over ${r.n} rows`);
	check(r.n > 0 && r.extra.length === 0, `${T2}: P3 at rest a tree row shows at most its ◈`, r.extra.slice(0, 4).join(' '));
	check(r.noMore.length === 0, `${T2}: P3 every tree row has its ⋯`, r.noMore.slice(0, 4).join(' '));
	check(r.noMark.length === 0, `${T2}: P3 every tree row has its ◈ with something in focus`, r.noMark.slice(0, 4).join(' '));
	if (phone) check(r.small.length === 0, `${T2}: P3 the tree's ◈ is 44px on a phone`, r.small.slice(0, 4).join(' '));
	// The ⋯ on a file: hover then press on a desktop, a long-press on a phone.
	const file = 'f01.md';
	// A timed note in the mode bar (the 3 s "refreshed" after the fixture's refresh) moves the
	// tree when it leaves; let it go first, or the row slides out from under the pointer.
	for (let i = 0; i < 40 && await page.evaluate(() => !!document.querySelector('#panel-work .files-mode-msg')); i++) await wait(100);
	await reach(page, rowSel(file));
	if (phone) {
		const cdp = TOUCH.get(page);
		const b = await page.evaluate((sel) => { const e = document.querySelector(sel).getBoundingClientRect(); return { x: Math.round(e.left + e.width / 3), y: Math.round(e.top + e.height / 2) }; }, rowSel(file));
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [b] });
		await wait(700);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await wait(300);
	} else {
		await page.hover(rowSel(file));
		await wait(200);
		// What is under the pointer and how the ⋯ is drawn, so a miss says why.
		const hov = await page.evaluate((sel) => { const r = document.querySelector(sel), b = r && r.querySelector('[data-act="row-more"]'); if (!b) return { seen: false, why: 'no ⋯' };
			const cs = getComputedStyle(b), q = r.getBoundingClientRect(), at = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
			return { seen: cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05, vis: cs.visibility, hover: r.matches(':hover'),
				at: at ? at.tagName.toLowerCase() + '.' + [...at.classList].join('.') : null, row: [...r.classList].join('.') }; }, rowSel(file));
		const seen = hov.seen;
		check(seen, `${T2}: P3 the ⋯ comes out on hover`, JSON.stringify(hov));
		if (seen) await page.click(rowSel(file) + ' [data-act="row-more"]');
	}
	let m = await page.evaluate(MENU);
	check(!!m && m.path === file && ['rename', 'delete', 'download'].every((a) => m.acts.includes(a)),
		`${T2}: P3 a file's ⋯ (${phone ? 'long-press' : 'hover, press'}) holds rename, delete and download`, JSON.stringify(m));
	await closeMenu(page);
	check(!(await page.evaluate(MENU)), `${T2}: P3 Escape closes the row ⋯`);
	if (!phone) {
		await page.click(rowSel(file), { button: 'right' });
		await wait(200);
		m = await page.evaluate(MENU);
		check(!!m && m.path === file, `${T2}: P3 a right-click opens the same ⋯`, JSON.stringify(m));
		await closeMenu(page);
	}
	if (!id) return;
	// The user's own mark in force: share and read only in its ⋯; then N5 on its ◈.
	const dir = 'papers';
	const inForce = async () => page.evaluate(async (id) => DaimondRecent.boundsKeys(await DaimondDiamond.bounds(id))
		.some((k) => /^mark:.*papers$/.test(k)), id);
	const st = () => page.evaluate((sel) => {
		const r = document.querySelector(sel), b = r && r.querySelector('[data-act="mark"]');
		const can = [...document.querySelectorAll('#panel-work .files-focus .r')].find((e) => /papers$/.test(e.dataset.path || ''));
		return { mark: b ? [...b.classList].filter((c) => c !== 'dm').join(' ') : null, taken: !!(r && r.classList.contains('taken')),
			undo: !!(r && r.querySelector('[data-act="undo"]')), dialog: !!document.querySelector('.dlg-ok'),
			can: can ? { kind: can.dataset.kind, taken: can.classList.contains('taken'), undo: !!can.querySelector('[data-act="undo"]') } : null };
	}, rowSel(dir));
	await reach(page, rowSel(dir));
	await page.evaluate((sel) => document.querySelector(sel + ' [data-act="row-more"]').click(), rowSel(dir));
	await wait(200);
	m = await page.evaluate(MENU);
	check(!!m && ['share', 'readonly', 'rename', 'delete'].every((a) => m.acts.includes(a)) && !m.acts.includes('download'),
		`${T2}: P3 the ⋯ on the user's own mark holds share and read only, and a folder no download`, JSON.stringify(m));
	await closeMenu(page);
	const s0 = await st();
	check(await inForce() && /\bon\b/.test(s0.mark || ''), `${T2}: N5 the fixture's mark is in force and its ◈ is the accent`, JSON.stringify(s0));
	const press = async () => { await reach(page, rowSel(dir)); if (!phone) await page.hover(rowSel(dir)); await page.click(rowSel(dir) + ' [data-act="mark"]', { force: !!phone }); await wait(900); };
	await press();
	const s1 = await st();
	check(!(await inForce()) && !s1.dialog, `${T2}: N5 the ◈ takes the mark away at once, with no dialog`, JSON.stringify(s1));
	check(s1.taken && s1.undo && !!(await page.evaluate((sel) => document.querySelector(sel), rowSel(dir))),
		`${T2}: N5 the row stays where it was, dimmed, with an Undo`, JSON.stringify(s1));
	check(!!s1.can && s1.can.taken && s1.can.undo, `${T2}: N5 its Can change row stays too, dimmed, with an Undo`, JSON.stringify(s1.can));
	let f = await page.evaluate(FOCUS);
	const want = await page.evaluate(async (id) => DaimondRecent.boundsKeys(await DaimondDiamond.bounds(id)), id);
	check(want.every((k) => f.keys.includes(k)) && f.keys.every((k) => want.includes(k)), `${T2}: N5 N1 holds while the Undo stands`, `rows ${f.keys.join(' ')}; fence ${want.join(' ')}`);
	await page.click(rowSel(dir) + ' [data-act="undo"]', { force: true });
	await wait(1200);
	const s2 = await st();
	check(await inForce() && !s2.taken && !s2.undo && /\bon\b/.test(s2.mark || ''), `${T2}: N5 the Undo puts the mark back in force`, JSON.stringify(s2));
	// Left alone, the Undo goes and the mark stays away; the fixture is put back as it was.
	await press();
	await wait(5600);
	const s3 = await st();
	check(!(await inForce()) && !s3.taken && !s3.undo && !(s3.can && s3.can.undo), `${T2}: N5 after five seconds the Undo goes and the mark stays away`, JSON.stringify(s3));
	await page.evaluate(async (id) => {
		const app = DaimondCore.diamondApp();
		await app.add_link(id, 'diamond:' + id, 'dir:[browser]papers', 'holds', '', 'user');
		await DaimondAttach.confirmHere(id, 'dir:[browser]papers');
		document.dispatchEvent(new CustomEvent('daimond-links-changed'));
	}, id);
	await wait(900);
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
