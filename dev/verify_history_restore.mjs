// gateway: none
// verify_history_restore.mjs — a restore from History is one act, asks before it takes
// anything newer away, and never runs over bytes History does not hold (D-20261009-29).
//
// Seven arms, each the owner's own item, each seen RED on 8f9342df before its fix:
//
//   1. A WHOLE-VERSION RESTORE IS ONE VERSION, crystal and files together, and its row
//      offers "Undo this restore", which puts back both.
//   2. THE DIAMOND'S OWN NEWER FILES ARE ASKED ABOUT, by name, with Keep the default; a
//      keep leaves them, a yes takes them.
//   3. THE ROW A RESTORE REPLACED SAYS SO: "Before restore".
//   4. A DELETED FILE'S ROW PUTS IT BACK, and a changed file's row offers "Restore before".
//   5. A PAGE'S SAVE IS RECORDED: before a restore replaces it, when the person leaves the
//      Diamond, and after a reload lost the mark.
//   6. A FILE IN THE PERSON'S OWN FOLDER THAT A RESTORE WOULD OVERWRITE IS ASKED ABOUT, by
//      name, default keep.
//   7. A RESTORE NEVER TOUCHES `capp.json`, the delivery record.
//
// Seeded test Diamonds only; a world with no owner data:
//   eval "$(bash dev/world.sh 98 --up)"; node dev/verify_history_restore.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { open, scratch, errors, steerDiamond, pressRowMark } from './harness.mjs';

const ok = [], bad = [];
let ran = 0;
const check = (name, pass, detail) => {
	ran++;
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ── Page-side doors ──────────────────────────────────────────────────
const glue = (page, fn, ...args) => page.evaluate(async (a) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { return await m[a.fn](...a.args); } catch (e) { return null; }
}, { fn, args });
const readStore  = (page, p) => glue(page, 'store_read', p);
const writeStore = (page, p, body) => glue(page, 'store_write', p, body);
const engine = (page, fn, ...args) => page.evaluate(async (a) => {
	const app = window.DaimondCore.diamondApp();
	try { return { ok: true, out: await app[a.fn](...a.args) }; }
	catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
}, { fn, args });
const tool = (page, name, args) => page.evaluate(async (a) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	window.__free = window.__free || new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	try { return await window.__free.run_tool(a.name, JSON.stringify(a.args)); } catch (e) { return String(e); }
}, { name, args });
const rows = (page, id) => page.evaluate((i) => DaimondVersions.rows(i), id);
const save = async (page, id, name) => {
	const r = await engine(page, 'versions_save_user', id, name);
	try { return JSON.parse(r.out).version; } catch (e) { return -1; }
};
const crystalTitle = async (page, id) => {
	const r = await engine(page, 'read_crystal_data', id);
	try { return JSON.parse(r.out).title || ''; } catch (e) { return ''; }
};

/// Every question a restore puts to the person, kept with the answer `window.__answer` gives.
const captureAsks = (page) => page.evaluate(() => {
	window.__asks = [];
	window.__answer = false;
	DaimondCore.confirm = async function (msg, okLabel, opts) {
		window.__asks.push({ msg: String(msg), ok: String(okLabel || ''), opts: opts || {} });
		return window.__answer;
	};
});
const asks = (page) => page.evaluate(() => window.__asks.slice());
const answer = (page, yes) => page.evaluate((y) => { window.__asks = []; window.__answer = y; }, yes);

const diamondId = (page, name) => page.evaluate(async (n) => {
	const d = JSON.parse(await DaimondCore.diamondApp().list_diamonds()).find((x) => x.name === n);
	return d ? d.id : '';
}, name);
const closeModals = (page) => page.evaluate(() => {
	document.querySelectorAll('.modal').forEach((m) => m.remove());
	document.body.classList.remove('modal-open');
});
const selectDiamond = async (page, name) => {
	await page.evaluate((n) => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find((e) => (e.getAttribute('aria-label') || '') === n);
		if (box) box.click();
	}, name);
	await page.waitForTimeout(900);
};
const newDiamond = async (page, name) => {
	await closeModals(page);
	await page.waitForFunction(() => {
		try { const d = window.DaimondModels && DaimondModels.getDefault(); return !!(d && d.model); }
		catch (e) { return false; }
	}, null, { timeout: 20000 }).catch(() => {});
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	const t0 = Date.now();
	while (Date.now() - t0 < 15000 && !(await diamondId(page, name))) await page.waitForTimeout(250);
	await page.waitForTimeout(400);
	await selectDiamond(page, name);
	return diamondId(page, name);
};

/// A Diamond with two saved versions: `base` and `second`, the second changing keep.md and the
/// crystal, adding new.md, deleting del.md and moving the delivery record on.
async function fixture(page, name) {
	const id = await newDiamond(page, name);
	const D = `diamonds/${id}`;
	await writeStore(page, `${D}/notes/keep.md`, 'k1');
	await writeStore(page, `${D}/notes/del.md`, 'd1');
	await writeStore(page, `${D}/log/a.jsonl`, 'a1\n');
	await writeStore(page, `${D}/capp.json`, '{"v":1}');
	await engine(page, 'write_crystal_data', id, JSON.stringify({ title: 'First' }));
	const vBase = await save(page, id, 'base');
	await writeStore(page, `${D}/notes/keep.md`, 'k2');
	await writeStore(page, `${D}/notes/new.md`, 'n1');
	await writeStore(page, `${D}/capp.json`, '{"v":2}');
	await tool(page, 'file_delete', { path: `${D}/notes/del.md` });
	await engine(page, 'write_crystal_data', id, JSON.stringify({ title: 'Second' }));
	const v2 = await save(page, id, 'second');
	return { id, D, vBase, v2 };
}

/// A page that saves through the `save` verb, as a capp does, mounted as the crystal page.
const PAGE = `<!doctype html><meta charset="utf-8"><body><div id="out">idle</div><script>
var P = 1, seq = 0, waiting = {};
function send(cmd, extra) {
	var id = 'r' + (++seq);
	var msg = Object.assign({ dc: 1, v: P, cmd: cmd, id: id }, extra || {});
	return new Promise(function (res) { waiting[id] = res; parent.postMessage(msg, '*'); });
}
window.addEventListener('message', function (e) {
	var m = e.data;
	if (!m || m.dc !== 1) return;
	if (m.id && waiting[m.id]) { waiting[m.id](m); delete waiting[m.id]; return; }
	if (m.cmd === 'data') {
		var d = (m.data && m.data.data) ? m.data.data : (m.data || {});
		var ks = []; for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) ks.push(k);
		parent.postMessage({ dc:1, v:P, cmd:'rendered', keys: ks }, '*');
	}
});
window.__capp = { save: function (p, t, mode) { return send('save', { path: p, text: t, mode: mode }); } };
parent.postMessage({ dc: 1, v: P, cmd: 'ready' }, '*');
<\/script></body>`;

/// Mount the saving page on `name` and save `text` into `rel` through it.
async function pageSave(page, name, D, rel, text) {
	await writeStore(page, `${D}/crystal.html`, PAGE);
	await selectDiamond(page, name);
	await page.waitForTimeout(1500);
	const f = page.frames().find((fr) => fr.url().indexOf('blob:') === 0);
	if (!f) return 'no frame';
	try {
		const r = await f.evaluate((a) => window.__capp.save(a.rel, a.text, 'replace'), { rel, text });
		return r && r.ok ? 'ok' : JSON.stringify(r);
	} catch (e) { return String(e); }
}

/// Is `bytes` at `path` recorded in a row of its own (not a restore's `was`) of `id`?
const recordedAs = async (page, id, path, bytes) =>
	(await rows(page, id)).some((r) => r.cause !== 'restore'
		&& (r.files || []).some((e) => e.path === path && e.hash === sha(bytes)));

/// Open History, and answer the restore row's and the row below's controls.
async function history(page) {
	await closeModals(page);
	await page.evaluate(() => {
		const b = [...document.querySelectorAll('.crystal-act')].find((x) => /History/.test(x.textContent));
		if (b) b.click();
	});
	await page.waitForTimeout(1200);
}
const rowOf = (page, v) => page.evaluate((n) => {
	const r = [...document.querySelectorAll('.hist-row')]
		.find((x) => (x.querySelector('.hist-ver') || {}).textContent === 'v' + n);
	return r ? { text: r.textContent, undo: !!r.querySelector('.hist-undo-restore') } : null;
}, v);
const openFiles = (page, v) => page.evaluate((n) => {
	const r = [...document.querySelectorAll('.hist-row')]
		.find((x) => (x.querySelector('.hist-ver') || {}).textContent === 'v' + n);
	const c = r && r.querySelector('.hist-files-n');
	if (c) c.click();
	return !!c;
}, v);
const fileRow = (page, path) => page.evaluate((p) => {
	const r = [...document.querySelectorAll('.hist-file')].find((x) => x.dataset.path === p);
	return r ? { restore: !!r.querySelector('.hist-file-restore:not([disabled])'),
		before: !!r.querySelector('.hist-file-before') } : null;
}, path);
const pressFile = (page, path, cls) => page.evaluate((a) => {
	const r = [...document.querySelectorAll('.hist-file')].find((x) => x.dataset.path === a.p);
	const b = r && r.querySelector(a.cls);
	if (b) b.click();
	return !!b;
}, { p: path, cls });

/// A steer through the composer, waited to its end (as verify_versions.mjs's own).
///
/// `allow`: answer "Let <Diamond> change <folder>?" Allow, as the person does. A ◈ mark grants
/// reading; the first write into the folder asks (daimond.js, "A WRITE ON FIRST USE").
async function steer(s, text, timeout = 30000, allow = false) {
	await steerDiamond(s, text);
	await s.page.waitForTimeout(300);
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (allow) await s.page.evaluate(() => {
			const ok = document.querySelector('[data-ask="place"] .dlg-ok');
			if (ok) ok.click();
		});
		const busy = await s.page.evaluate(() => {
			const b = document.getElementById('chat-send');
			if (!b) return false;
			const t = (b.getAttribute('title') || '') + (b.className || '');
			return /stop/i.test(t) || b.disabled;
		});
		if (!busy) break;
		await s.page.waitForTimeout(250);
	}
	await s.page.waitForTimeout(600);
}

// ── The world ────────────────────────────────────────────────────────
const PROFILE = scratch('pw', 'history-restore');
fs.rmSync(PROFILE, { recursive: true, force: true });
const s = await open({ name: 'histrestore', profile: PROFILE, defaults: false });
const { page } = s;

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.diamondApp && window.DaimondVersions), null, { timeout: 15000 });

	// ── 7. capp.json is never a restore's ───────────────────────────
	console.log('\n7. a restore never touches capp.json');
	{
		const F = await fixture(page, 'Hist Seven');
		await captureAsks(page);
		await answer(page, true);
		await page.evaluate((a) => DaimondVersions.restore(a.id, a.v, { ask: false }), { id: F.id, v: F.vBase });
		check('a whole-version restore leaves the delivery record as it stands',
			(await readStore(page, `${F.D}/capp.json`)) === '{"v":2}', String(await readStore(page, `${F.D}/capp.json`)));
		const rs = await rows(page, F.id);
		const r = rs.find((x) => x.cause === 'restore' && /^restore/.test(x.note || ''));
		await page.evaluate((a) => DaimondVersions.undoVersion(a.id, a.v, a.paths),
			{ id: F.id, v: r ? r.v : 0, paths: r ? r.files.map((e) => e.path) : [] });
		check('and so does the undo of it', (await readStore(page, `${F.D}/capp.json`)) === '{"v":2}',
			String(await readStore(page, `${F.D}/capp.json`)));
	}

	// ── 2. the Diamond's own newer files are asked about ───────────
	console.log('\n2. the Diamond\'s own newer files are asked about, Keep the default');
	{
		const F = await fixture(page, 'Hist Two');
		await captureAsks(page);
		await answer(page, false);
		await page.evaluate((a) => DaimondVersions.restore(a.id, a.v, { ask: false }), { id: F.id, v: F.vBase });
		const q = (await asks(page)).find((x) => /new\.md/.test(x.msg));
		check('a restore that would delete new.md asks, naming it', !!q, JSON.stringify(await asks(page)).slice(0, 200));
		check('Keep is the default: a named keep button and the safe focus',
			!!q && !!q.opts.cancelLabel && q.opts.guard === true, q ? JSON.stringify(q.opts) : 'no question');
		check('the question says where it goes: History, by version',
			!!q && /History/.test(q.msg) && /v\d+/.test(q.msg), q ? q.msg : 'no question');
		check('a keep leaves it in place', (await readStore(page, `${F.D}/notes/new.md`)) === 'n1');
		await answer(page, true);
		await page.evaluate((a) => DaimondVersions.restore(a.id, a.v, { ask: false }), { id: F.id, v: F.vBase });
		check('a yes takes it', (await readStore(page, `${F.D}/notes/new.md`)) === null);
	}

	// ── 5. a page's save is recorded ────────────────────────────────
	console.log('\n5. a page\'s save is recorded');
	{
		const F = await fixture(page, 'Hist Five');
		const P = `${F.D}/log/a.jsonl`;
		check('the page saved through its own door', (await pageSave(page, 'Hist Five', F.D, 'log/a.jsonl', 'a1\na2\n')) === 'ok');
		await captureAsks(page);
		await answer(page, true);
		await page.evaluate((a) => DaimondVersions.restore(a.id, a.v, { ask: false }), { id: F.id, v: F.vBase });
		check('a restore records the page\'s save in a row of its own first', await recordedAs(page, F.id, P, 'a1\na2\n'));
		check('the page\'s save is marked: its row keeps what it replaced as was',
			(await rows(page, F.id)).some((r) => r.cause !== 'restore'
				&& (r.files || []).some((e) => e.path === P && e.hash === sha('a1\na2\n') && e.was === sha('a1\n'))));

		// Leaving the Diamond records a save without a turn.
		await newDiamond(page, 'Hist Five Away');
		await selectDiamond(page, 'Hist Five');
		await page.waitForTimeout(800);
		check('a second save went down', (await pageSave(page, 'Hist Five', F.D, 'log/a.jsonl', 'a3\n')) === 'ok');
		await selectDiamond(page, 'Hist Five Away');
		await page.waitForTimeout(2500);
		check('leaving the Diamond records the save, with no turn and no restore', await recordedAs(page, F.id, P, 'a3\n'));

		// A reload loses an in-memory mark; the restore still records what is there.
		await selectDiamond(page, 'Hist Five');
		await pageSave(page, 'Hist Five', F.D, 'log/a.jsonl', 'a4\n');
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.diamondApp && window.DaimondVersions), null, { timeout: 15000 });
		await page.waitForTimeout(2500);
		await writeStore(page, P, 'a5\n');      // as a write whose mark the reload lost
		await captureAsks(page);
		await answer(page, true);
		await page.evaluate((a) => DaimondVersions.restore(a.id, a.v, { ask: false }), { id: F.id, v: F.vBase });
		check('after a reload, a restore still records what it replaces first', await recordedAs(page, F.id, P, 'a5\n'));
	}

	// ── 1 and 3. one restore, one Undo, and the row before it ───────
	console.log('\n1, 3. a whole-version restore is one version and undoes as one');
	{
		const F = await fixture(page, 'Hist One');
		await captureAsks(page);
		await answer(page, true);
		const before = (await rows(page, F.id)).length;
		await history(page);
		await page.evaluate((n) => {
			const r = [...document.querySelectorAll('.hist-row')]
				.find((x) => (x.querySelector('.hist-ver') || {}).textContent === 'v' + n);
			const b = r && r.querySelector('.hist-restore');
			if (b) b.click();
		}, F.vBase);
		await page.waitForTimeout(600);
		await page.click('.modal .dlg-ok', { force: true, timeout: 3000 }).catch(() => {});
		await page.waitForTimeout(2500);
		const after = await rows(page, F.id);
		check('ONE new version for the crystal and the files together', after.length === before + 1,
			`${before} → ${after.length}: ${after.slice(0, 3).map((r) => r.v + ':' + r.kind + '/' + r.cause).join(' ')}`);
		check('the crystal and the files are as at the version',
			(await crystalTitle(page, F.id)) === 'First' && (await readStore(page, `${F.D}/notes/keep.md`)) === 'k1',
			`${await crystalTitle(page, F.id)} ${await readStore(page, `${F.D}/notes/keep.md`)}`);
		const top = after[0];
		await history(page);
		const rt = await rowOf(page, top.v);
		check('the restore\'s row offers "Undo this restore"', !!rt && rt.undo, rt ? rt.text.slice(0, 120) : 'no row');
		const below = await rowOf(page, F.v2);
		check('the row it replaced says "Before restore"', !!below && /Before restore/.test(below.text),
			below ? below.text.slice(0, 120) : 'no row');
		await page.evaluate((n) => {
			const r = [...document.querySelectorAll('.hist-row')]
				.find((x) => (x.querySelector('.hist-ver') || {}).textContent === 'v' + n);
			const b = r && r.querySelector('.hist-undo-restore');
			if (b) b.click();
		}, top.v);
		await page.waitForTimeout(2500);
		check('Undo this restore puts back the crystal AND the files',
			(await crystalTitle(page, F.id)) === 'Second' && (await readStore(page, `${F.D}/notes/keep.md`)) === 'k2'
				&& (await readStore(page, `${F.D}/notes/new.md`)) === 'n1',
			`${await crystalTitle(page, F.id)} ${await readStore(page, `${F.D}/notes/keep.md`)} ${await readStore(page, `${F.D}/notes/new.md`)}`);
	}

	// ── 4. a deleted file's row, and Restore before ─────────────────
	console.log('\n4. a deleted row puts the file back; a changed row offers Restore before');
	{
		const F = await fixture(page, 'Hist Four');
		await captureAsks(page);
		await answer(page, true);
		await history(page);
		await openFiles(page, F.v2);
		await page.waitForTimeout(500);
		check('the deleted file\'s row can be restored', !!(await fileRow(page, `${F.D}/notes/del.md`) || {}).restore);
		await pressFile(page, `${F.D}/notes/del.md`, '.hist-file-restore');
		await page.waitForTimeout(2000);
		check('and pressing it puts the file back as it was', (await readStore(page, `${F.D}/notes/del.md`)) === 'd1',
			String(await readStore(page, `${F.D}/notes/del.md`)));
		await history(page);
		await openFiles(page, F.v2);
		await page.waitForTimeout(500);
		check('a changed file\'s row offers "Restore before"', !!(await fileRow(page, `${F.D}/notes/keep.md`) || {}).before);
		await pressFile(page, `${F.D}/notes/keep.md`, '.hist-file-before');
		await page.waitForTimeout(2000);
		check('and pressing it puts back what the version replaced', (await readStore(page, `${F.D}/notes/keep.md`)) === 'k1',
			String(await readStore(page, `${F.D}/notes/keep.md`)));
	}

	// ── 6. the person's own folder ──────────────────────────────────
	console.log('\n6. a file in the person\'s own folder is asked about before it is overwritten');
	{
		const id = await newDiamond(page, 'Hist Six');
		await glue(page, 'write_file', 'mine/f.txt', 'p1');
		await page.evaluate(() => DaimondPanels.show('work'));
		await page.waitForTimeout(700);
		await page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
		await page.waitForTimeout(1000);
		// The row's ◈ marks a folder into the Diamond in focus (the row paperclip is gone).
		const clipped = await pressRowMark(s, 'mine');
		await page.waitForTimeout(1000);
		await selectDiamond(page, 'Hist Six');
		await steer(s, '@tool file_write {"path":"mine/f.txt","content":"p2"}', 30000, true);
		const all6 = await rows(page, id);
		const top = all6[0];
		check('the folder is marked and the turn recorded', clipped && !!top
			&& (top.files || []).some((e) => e.path === 'mine/f.txt'),
			`clipped ${clipped}; on disk ${JSON.stringify(await glue(page, 'read_file', 'mine/f.txt'))}; rows `
			+ JSON.stringify(all6.map((r) => [r.v, r.cause, (r.files || []).map((e) => e.path)])).slice(0, 600));
		await captureAsks(page);
		await answer(page, false);
		await page.evaluate((a) => DaimondVersions.restore(a.id, a.v, { ask: false }), { id, v: top ? top.v - 1 : 0 });
		const q = (await asks(page)).find((x) => /f\.txt/.test(x.msg));
		check('a restore that would overwrite f.txt asks, naming it, Keep the default',
			!!q && !!q.opts.cancelLabel && q.opts.guard === true, JSON.stringify(await asks(page)).slice(0, 200));
		check('a keep leaves the person\'s file as it is', (await glue(page, 'read_file', 'mine/f.txt')) === 'p2',
			String(await glue(page, 'read_file', 'mine/f.txt')));
	}

	const errs = errors(s).filter((e) => !/favicon/i.test(e) && !/Failed to load resource/.test(e) && !/502 \(Bad Gateway\)/.test(e));
	check('nothing was done by way of an unhandled error', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
} finally {
	await s.close();
}

const EXPECTED = 26;
check(`exactly ${EXPECTED} checks ran — a displaced case trips this`, ran === EXPECTED, `ran ${ran}`);
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
