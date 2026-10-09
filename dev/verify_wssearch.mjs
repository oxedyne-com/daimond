// gateway: none
// verify_wssearch.mjs -- the Workspace panel's box searches the whole workspace (E5 of
// specs/daimond_workspace_firstprinciples_20261009.md, mockup flow "1b · Older: search").
//
// Held here, at 1440x900 with a Diamond in focus and the tree showing ANOTHER folder:
//   1  the box says "Search files";
//   2  a partial name finds a file two folders down elsewhere in the workspace, its row naming the
//      folder it sits in ("stories/old/") and its time, and a file in the diamond's own folder,
//      first, as "Its own folder"; while the query stands the card is the box and its hits;
//   3  a tap on a hit opens it in the Doc panel;
//   4  typing again cancels the old walk: with the first walk held on a listing, a second query is
//      typed and answered, and when the first listing is let go the old walk lists nothing more and
//      draws no row;
//   5  a query matching more than the cap draws the cap and the quiet "showing first N" line;
//   6  emptying the box puts the folder back.
//
// WSS_BASE=1 serves every www file this tree changed from 50f074cb, so the gate can be seen RED on
// the unchanged page. Run with the world up (`bash dev/world.sh 101 --up`); no gateway.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BASE = '50f074cb';

let bad = 0;
const check = (ok, what, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined && detail !== '' ? '  -- ' + detail : ''}`);
	if (!ok) bad++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const changed = process.env.WSS_BASE
	? git('diff', '--name-only', BASE, '--', 'www').stdout.split('\n').filter(Boolean).map((f) => f.replace(/^www\//, ''))
		.filter((f) => git('cat-file', '-e', `${BASE}:www/${f}`).status === 0)
	: [];
const MIME = { js: 'application/javascript', css: 'text/css', html: 'text/html', json: 'application/json' };
console.log(process.env.WSS_BASE ? `WSS_BASE: ${changed.length} www file(s) served from ${BASE}: ${changed.join(' ')}` : 'serving this tree');
const route = process.env.WSS_BASE ? async (page) => {
	for (const f of changed) {
		const body = git('show', `${BASE}:www/${f}`).stdout;
		const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		await page.route(new RegExp('/' + esc + '(\\?.*)?$'), (r) =>
			r.fulfill({ status: 200, contentType: MIME[f.split('.').pop()] || 'text/plain', body }));
	}
} : null;

const BOX = '#panel-work .files-filter-input';
const hits = (page) => page.evaluate(() => [...document.querySelectorAll('#panel-work .files-tree .files-row')].map((r) => ({
	text: (r.querySelector('.files-name') || r).textContent,
	dir: (r.querySelector('.files-name i') || {}).textContent || '',
	place: (r.querySelector('.place') || {}).textContent || '',
	time: (r.querySelector('.meta') || {}).textContent || '',
	path: r.dataset.path || '',
})));
const waitFor = async (page, pred, ms = 8000) => {
	const t0 = Date.now();
	for (;;) { const s = await hits(page); if (pred(s)) return s; if (Date.now() - t0 > ms) return s; await wait(100); }
};
const type = async (page, q) => { await page.fill(BOX, q); };

let S = null;
try {
	S = await open({ name: 'wssearch', route });
	const { page } = S;
	await page.setViewportSize({ width: 1440, height: 900 });
	await wait(1500);
	await page.evaluate(() => { if (getComputedStyle(document.getElementById('settings-modal')).display !== 'none') window.DaimondAdmin.closeModal(); });
	const T = (k, a) => page.evaluate(([k, a]) => DaimondI18n.t(k, a), [k, a]);

	// A Diamond in focus, and files in three places, written through the real tool.
	await page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Search seam');
	await page.click('.dlg-ok', { force: true });
	await wait(1200);
	const id = await page.evaluate(async () => {
		for (const d of JSON.parse(await DaimondCore.diamondApp().list_diamonds())) if (d.name === 'Search seam') return d.id;
	});
	check(!!id, 'the Diamond is made', id);
	await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const w = (p, c) => app.run_tool('file_write', JSON.stringify({ path: p, content: c }));
		await w('stories/life-story-e5.md', '# draft\n');
		await w('stories/old/lifestory-e5.txt', 'the old life story\n');
		await w('notes/plan-e5.md', '# plan\n');
		await w(`diamonds/${id}/FBR_LifeStory_e5.txt`, 'its own\n');
		for (let i = 0; i < 120; i++) await w('many/cap-e5-' + String(i).padStart(3, '0') + '.md', 'x\n');
	}, id);
	await page.evaluate(() => DaimondPanels.show('work'));
	await wait(600);
	await page.evaluate(() => { const r = document.querySelector('#panel-work [data-act="refresh"]'); if (r) r.click(); });
	await wait(900);
	// The tree shows ANOTHER folder: the search is not "from here down".
	await page.evaluate(() => {
		const r = document.querySelector('#panel-work .files-tree .files-row.dir[data-path="notes"]');
		if (r) r.click();
	});
	await wait(900);
	const crumb = await page.evaluate(() => document.querySelector('#panel-work .files-path').textContent);
	check(/notes/.test(crumb), 'the tree is in notes/ before the search', crumb);

	// 1
	const ph = await page.getAttribute(BOX, 'placeholder');
	check(ph === 'Search files' && ph === await T('work.search_ph'), 'the box says "Search files"', ph);

	// 2
	await type(page, 'lifest');
	let rows = await waitFor(page, (s) => s.some((r) => /lifestory-e5\.txt/.test(r.text)) && s.some((r) => /FBR_LifeStory_e5/.test(r.text)));
	const nested = rows.find((r) => /lifestory-e5\.txt/.test(r.text));
	check(!!nested, 'a partial name finds a file two folders down, outside the folder in view', JSON.stringify(rows.map((r) => r.text)));
	check(!!nested && nested.dir === 'stories/old/', 'its row names the folder it sits in', nested && JSON.stringify(nested));
	check(!!nested && nested.time.trim().length > 0 && !/ago/.test(nested.time), 'its row shows its time, short ("2 min", not "2m ago")', nested && JSON.stringify(nested));
	const ownRow = rows.find((r) => /FBR_LifeStory_e5/.test(r.text));
	const ownWord = await T('dws.own_folder');
	check(!!ownRow && ownRow.place === ownWord, 'a file in its own folder says "Its own folder"', ownRow && JSON.stringify(ownRow));
	check(rows.length > 0 && /FBR_LifeStory_e5/.test(rows[0].text), 'its own folder comes first', rows.map((r) => r.text).join(' | '));
	const only = await page.evaluate(() => {
		const p = document.querySelector('#panel-work .files-path');
		return { path: !!p.offsetParent, sys: !!(document.getElementById('sys-sec') || {}).offsetParent };
	});
	check(!only.path && !only.sys, 'while the query stands the card is the box and its hits', JSON.stringify(only));

	// 3
	await page.evaluate(() => {
		const r = [...document.querySelectorAll('#panel-work .files-tree .files-row')].find((x) => /lifestory-e5\.txt/.test(x.textContent));
		if (r) r.click();
	});
	let opened = '';
	for (let i = 0; i < 40 && !/the old life story/.test(opened); i++) {
		await wait(150);
		opened = await page.evaluate(() => { const d = document.getElementById('panel-doc'); return d && d.offsetParent ? (d.innerText || '') + [...d.querySelectorAll('textarea')].map((t) => t.value).join('') : ''; });
	}
	check(/the old life story/.test(opened), 'a tap on the hit opens it', opened.slice(0, 80));
	await page.evaluate(() => DaimondPanels.show('work'));
	await wait(300);

	// 4 -- the walk's listing door is wrapped, so the first walk can be held on a listing.
	const seam = await page.evaluate(() => {
		const W = window.DaimondWsSearch;
		if (!W) return false;
		const orig = W.walk;
		window.__wss = { gen: 0, hold: false, held: [], calls: {} };
		W.walk = function (o) {
			const s = window.__wss, gen = ++s.gen, list = o.list;
			return orig.call(this, Object.assign({}, o, { list: async (r, d) => {
				s.calls[gen] = (s.calls[gen] || 0) + 1;
				if (s.hold) await new Promise((res) => s.held.push(res));
				return list(r, d);
			} }));
		};
		return true;
	});
	check(seam, 'the search walk is a module of its own (window.DaimondWsSearch)');
	if (seam) {
		await type(page, '');
		await wait(400);
		await page.evaluate(() => { window.__wss.hold = true; });
		await type(page, 'lifest');
		await wait(600);
		const g1 = await page.evaluate(() => window.__wss.gen);
		await page.evaluate(() => { window.__wss.hold = false; });
		await type(page, 'plan-e');
		rows = await waitFor(page, (s) => s.some((r) => /plan-e5\.md/.test(r.text)));
		const before = await page.evaluate((g) => window.__wss.calls[g] || 0, g1);
		await page.evaluate(() => window.__wss.held.splice(0).forEach((r) => r()));
		await wait(1200);
		const after = await page.evaluate((g) => window.__wss.calls[g] || 0, g1);
		rows = await hits(page);
		check(rows.some((r) => /plan-e5\.md/.test(r.text)), 'the second query is answered while the first walk is held', rows.map((r) => r.text).join(' | '));
		check(after === before, 'let go, the first walk lists nothing more', `${before} -> ${after} listings`);
		check(!rows.some((r) => /lifest/i.test(r.text)), 'and draws no row', rows.map((r) => r.text).join(' | '));
	}

	// 5
	await type(page, 'cap-e5');
	rows = await waitFor(page, (s) => s.length >= 100, 15000);
	await wait(800);
	const capped = await page.evaluate(() => (document.querySelector('#panel-work .files-capped') || {}).textContent || '');
	rows = await hits(page);
	const capWords = await T('files.search_capped', { n: 100 });
	check(rows.length === 100 && capped === capWords && capWords === 'Showing first 100', 'a query past the cap draws the cap and says "Showing first 100"', `${rows.length} rows, "${capped}"`);

	// 6
	await type(page, '');
	await wait(1200);
	const back = await page.evaluate(() => ({ path: !!document.querySelector('#panel-work .files-path').offsetParent, hits: document.querySelectorAll('#panel-work .files-hit').length, rows: document.querySelectorAll('#panel-work .files-tree .files-row').length }));
	check(back.path && back.hits === 0 && back.rows > 0, 'emptying the box puts the folder back', JSON.stringify(back));
} catch (e) {
	console.log('FAIL  the gate itself stopped: ' + (e && e.stack || e));
	bad++;
} finally {
	if (S) await S.close().catch(() => {});
}
console.log(`\n${bad ? 'FAILED' : 'PASSED'}: ${bad} failing check(s)`);
process.exit(bad ? 1 : 0);
