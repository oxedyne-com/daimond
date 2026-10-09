#!/usr/bin/env node
// gateway: none
// verify_turnfiles_nine.mjs -- #8 in the browser: a daimon turn that writes NINE files leaves a
// Files tile that draws all nine, each with its +N -M, from the turn row alone. The tail note names
// only six and then "and 3 more", so a tile drawn from the note's words could never reach the last
// three; the row's structured list (`turnFileList`) is what does.
//
// RED on a build without #8: after the fold opens the tile holds six rows (or the fold unfolds
// nothing), and the row carries no `files`. The world: dev/serve.mjs + dev/mockllm.mjs.
//
//   node dev/verify_turnfiles_nine.mjs

import { open, connectMock, steerDiamond, scratch, shot, storedChats } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

async function until(p, fn, arg, ms = 60000, step = 400) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let v = false; try { v = await p.evaluate(fn, arg); } catch (e) { v = false; }
		if (v) return true; await p.waitForTimeout(step);
	}
	return false;
}

const NOTE = /^\[Daimond: this turn changed /;

const s = await open({ name: 'turnfiles9', profile: scratch('pw', 'turnfiles9-' + process.pid) });
const { page: p } = s;
try {
	await connectMock(s);
	await p.waitForFunction(() => !!window.DaimondVersions && !!window.Files, null, { timeout: 20000 }).catch(() => {});
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm; inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, 'Nine ' + Date.now().toString(36));
	await p.waitForTimeout(1200);
	const id = await p.evaluate(() => { const d = window.DaimondDiamond && window.DaimondDiamond.current(); return d ? d.id : ''; });
	check('a new Diamond is current', !!id);

	// Nine writes in one turn; file i has i + 1 lines, so each row's +N is known.
	const calls = Array.from({ length: 9 }, (_, i) => 'file_write ' + JSON.stringify({
		path: 'diamonds/' + id + '/code/n/f' + i + '.md',
		content: Array.from({ length: i + 1 }, (_, k) => 'line ' + k).join('\n') + '\n' }));
	await steerDiamond(s, '@tools ' + calls.join(' ;; '));

	let chat = null;
	for (let k = 0; k < 100 && !chat; k++) {
		const cs = await storedChats(s);
		chat = (cs || []).find(c => (c.messages || []).some(m => NOTE.test(String(m.content || '')))) || null;
		if (!chat) await p.waitForTimeout(800);
	}
	check('the turn left its tail note', !!chat);
	if (!chat) throw new Error('no tail note');
	const row = chat.messages.find(m => NOTE.test(String(m.content || '')));
	check('the note names six and counts the rest', /and 3 more/.test(row.content), row.content.slice(0, 120));
	check('the turn row carries all nine files, counted', Array.isArray(row.files) && row.files.length === 9
		&& row.files.every(f => typeof f.add === 'number'), JSON.stringify((row.files || []).map(f => [f.path.split('/').pop(), f.add, f.del])));

	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForFunction(() => !!window.DaimondVersions, null, { timeout: 20000 }).catch(() => {});
	const drew = await until(p, () => document.querySelectorAll('.turn-files-rows .turn-file-row').length >= 6, null, 20000);
	check('the Files tile drew', drew);
	const before = await p.evaluate(() => ({
		rows: document.querySelectorAll('.turn-files-rows .turn-file-row').length,
		more: [...document.querySelectorAll('.turn-files-rows .turn-file-more')].map(b => b.tagName + ':' + b.textContent),
		rest: document.querySelectorAll('.turn-files-rows .turn-file-rest').length }));
	check('six rows, a fold for the other three, and no unknown count', before.rows === 6 && before.more.length === 1
		&& /^BUTTON:.*3/.test(before.more[0]) && before.rest === 0, JSON.stringify(before));
	await p.evaluate(() => { const b = document.querySelector('.turn-files-rows .turn-file-more'); if (b) b.click(); });
	await p.waitForTimeout(500);
	const after = await p.evaluate(() => [...document.querySelectorAll('.turn-files-rows .turn-file-row')].map(r => ({
		name: ((r.querySelector('.turn-file-name') || {}).textContent || '').split('/').pop(),
		add: ((r.querySelector('.tf-add') || {}).textContent || '') })));
	const want = Array.from({ length: 9 }, (_, i) => 'f' + i + '.md');
	check('the fold opens on all nine, in order', after.map(r => r.name).join() === want.join(), JSON.stringify(after.map(r => r.name)));
	check('each with its +N', after.length === 9 && after.every((r, i) => r.add === '+' + (i + 1)), JSON.stringify(after.map(r => r.add)));
	check('and the fold is gone', await p.evaluate(() => !document.querySelector('.turn-files-rows .turn-file-more')));
	await shot(s, 'turnfiles_nine_' + (bad.length ? 'RED' : 'GREEN'));
} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	await s.close().catch(() => {});
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
