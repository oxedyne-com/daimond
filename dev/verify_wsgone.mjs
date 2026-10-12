// gateway: none
// verify_wsgone.mjs -- a marked folder that is no longer there says "Gone" in Can change (WS-GONE).
//
// The 8 Oct Workspace design had a muted `Gone` row, read from `statAttachments`; round 2 (1f6228e1) dropped
// that stat with the old attach rows, the 9 Oct P2 spec omitted the row without a ruling, and a deleted marked
// folder stood in Can change as if it were there. Restored as a bug fix (rulings §6, 12 Oct).
//
// Held here, with a Diamond in focus and two of its folders marked and in force, one then deleted:
//   1  the deleted one's row is muted (`.gone`) and says "Gone" in its place, and keeps its take-away ◈;
//   2  the one still there says nothing of the kind;
//   3  the gone row is still one of Can change's marks (N1: `data-kind="mark"`).
//
// WSG_BASE=1 serves every www file this tree changed from a655345b (or WSG_BASE_REF), so the gate can be seen
// RED on the unchanged page. Run with the world up; no gateway.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BASE = process.env.WSG_BASE_REF || 'a655345b';

let bad = 0;
const check = (ok, what, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined && detail !== '' ? '  -- ' + detail : ''}`);
	if (!ok) bad++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const changed = process.env.WSG_BASE
	? git('diff', '--name-only', BASE, '--', 'www').stdout.split('\n').filter(Boolean).map((f) => f.replace(/^www\//, ''))
		.filter((f) => git('cat-file', '-e', `${BASE}:www/${f}`).status === 0)
	: [];
const MIME = { js: 'application/javascript', css: 'text/css', html: 'text/html', json: 'application/json' };
console.log(process.env.WSG_BASE ? `WSG_BASE: ${changed.length} www file(s) served from ${BASE}` : 'serving this tree');
const route = process.env.WSG_BASE ? async (page) => {
	for (const f of changed) {
		const body = git('show', `${BASE}:www/${f}`).stdout;
		const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		await page.route(new RegExp('/' + esc + '(\\?.*)?$'), (r) =>
			r.fulfill({ status: 200, contentType: MIME[f.split('.').pop()] || 'text/plain', body }));
	}
} : null;

let S = null;
try {
	S = await open({ name: 'wsgone', route });
	const { page } = S;
	await page.setViewportSize({ width: 1440, height: 900 });
	await wait(1500);
	await page.evaluate(() => { if (getComputedStyle(document.getElementById('settings-modal')).display !== 'none') window.DaimondAdmin.closeModal(); });
	await page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Gone marks');
	await page.click('.dlg-ok', { force: true });
	await wait(1200);
	const id = await page.evaluate(async () => {
		for (const d of JSON.parse(await DaimondCore.diamondApp().list_diamonds())) if (d.name === 'Gone marks') return d.id;
	});
	check(!!id, 'the Diamond is made', id);
	const fx = await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: 'kept-g/a.md', content: '# a\n' }));
		await app.run_tool('file_write', JSON.stringify({ path: 'lost-g/a.md', content: '# a\n' }));
		for (const p of ['kept-g', 'lost-g']) {
			await app.add_link(id, 'diamond:' + id, 'dir:[browser]' + p, 'holds', '', 'user');
			if (window.DaimondAttach && DaimondAttach.confirmHere) await DaimondAttach.confirmHere(id, 'dir:[browser]' + p);
		}
		// Deleted outside the panel, as a person deletes a folder in another app.
		const dirs = [];
		const top = await navigator.storage.getDirectory();
		const hunt = async (h, at, depth) => {
			for await (const [n, e] of h.entries()) {
				if (e.kind !== 'directory') continue;
				if (n === 'lost-g') { await h.removeEntry(n, { recursive: true }); dirs.push(at + n); continue; }
				if (depth < 2) await hunt(e, at + n + '/', depth + 1);
			}
		};
		await hunt(top, '', 0);
		const left = String(await m.store_list('')).split('\n').map((l) => l.split('\t')[0]);
		return { removed: dirs, listed: left.includes('lost-g'), kept: left.includes('kept-g') };
	}, id);
	check(fx.removed.length === 1 && !fx.listed && fx.kept, 'the fixture: two marked folders, one deleted', JSON.stringify(fx));
	await page.evaluate(() => document.dispatchEvent(new CustomEvent('daimond-links-changed')));
	await page.evaluate(() => document.dispatchEvent(new CustomEvent('daimond-diamond-changed')));
	await page.evaluate(() => DaimondPanels.show('work'));
	await wait(600);
	await page.evaluate(() => { const r = document.querySelector('#panel-work [data-act="refresh"]'); if (r) r.click(); });
	await wait(1500);
	const goneWord = await page.evaluate(() => DaimondI18n.t('dws.gone'));
	const rows = await page.evaluate(() => [...document.querySelectorAll('#panel-work .files-focus .r')].map((r) => ({
		path: r.dataset.path || '', kind: r.dataset.kind || '', gone: r.classList.contains('gone'),
		place: (r.querySelector('.place') || {}).textContent || '', dm: !!r.querySelector('button.dm'),
		colour: getComputedStyle(r.querySelector('.nm')).color,
	})));
	if (process.env.WSG_DUMP) console.log('focus: ' + await page.evaluate(() => {
		const f = document.querySelector('#panel-work .files-focus');
		return f ? `hidden=${f.hidden} ` + f.innerHTML.slice(0, 3000) : 'none';
	}));
	const lost = rows.find((r) => /lost-g$/.test(r.path)), kept = rows.find((r) => /kept-g$/.test(r.path));
	check(!!lost && lost.gone && lost.place === goneWord && goneWord === 'Gone' && lost.dm,
		'1 the deleted marked folder is muted, says "Gone" and keeps its take-away', JSON.stringify(lost));
	check(!!kept && !kept.gone && kept.place !== goneWord && !!lost && kept.colour !== lost.colour,
		'2 the folder still there says nothing of the kind, and reads unmuted', JSON.stringify(kept));
	check(!!lost && lost.kind === 'mark', '3 the gone row is still one of Can change\'s marks (N1)', JSON.stringify(lost));
} catch (e) {
	console.log('FAIL  the gate itself stopped: ' + (e && e.stack || e));
	bad++;
} finally {
	if (S) await S.close().catch(() => {});
}
console.log(`\n${bad ? 'FAILED' : 'PASSED'}: ${bad} failing check(s)`);
process.exit(bad ? 1 : 0);
