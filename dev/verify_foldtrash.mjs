// gateway: none
// verify_foldtrash.mjs -- a whole fold from the rail, failed and landed (D-20261010-01 items 3, 6).
//
// F  `fold_apply` refused: the source chat keeps a settled "Fold failed" row, and the
//    dialog saying so is still up ten seconds later -- a toast was gone before anyone looked.
// S  the fold lands: the ordinary chat goes to the Trash and the crystal moves one version.
// U  Undo: the chat is back on the rail, and the crystal and STATE.md are as they stood.
// C  a crystal-only fold (the reducer answers no file blocks, so `files` is empty) lands
//    and its Undo puts the crystal and the chat back with no failure said: the file undo
//    is skipped, never asked of the engine with no paths (which answers null).
//
//   eval "$(bash dev/world.sh 89 --env)" ; node dev/verify_foldtrash.mjs
//
// Needs dev/serve.mjs and dev/mockllm.mjs on the world's ports. No gateway.

import { open, chat, newChat, servedChats, shot } from './harness.mjs';
import fs from 'node:fs';

// The reducer answers with the crystal AND the three files, so STATE.md moves.
const REDUCE = (process.env.DAIMOND_MOCK_LOG || 'dev/mockllm.log') + '.reduce';
fs.writeFileSync(REDUCE, 'blocks');

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
	if (ok) pass++; else fail++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DIAMOND = 'Trash Fold Target';
const CHAT_MARK = 'FOLDTRASH-MARK';
const s = await open({ name: 'foldtrash' });
const p = s.page;

await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	window.__m = m;
	window.__vf = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
});
const diamondRow = () => p.evaluate(async (name) => {
	const row = JSON.parse(await window.__vf.list_diamonds()).find(r => r.name === name);
	if (!row) return null;
	const crystal = await window.__vf.read_crystal_data(row.id);
	const state = await window.__m.read_file(`diamonds/${row.id}/STATE.md`).catch(() => '');
	return { id: row.id, version: row.crystal_version, crystal, state };
}, DIAMOND);
const sourceChat = async () => (await servedChats(s))
	.find(c => (c.messages || []).some(m => String(m.content || '').includes(CHAT_MARK)));
const inTrash = (id) => p.evaluate(async (id) => {
	try { return ((await window.DaimondCore.trashList()) || []).some(r => r && (r.id === id)); }
	catch (e) { return 'n/a: ' + e.message; }
}, id);
const firstDiff = (a, b) => {
	let i = 0;
	while (i < a.length && a[i] === b[i]) i++;
	return `len ${a.length}/${b.length} at ${i}: ${JSON.stringify(a.slice(i, i + 40))} vs ${JSON.stringify(b.slice(i, i + 40))}`;
};
const dialogText = () => p.evaluate(() => {
	const c = document.querySelector('.dlg-card:not(.tile-dlg-card)');
	return c ? c.textContent : '';
});

/// The rail's whole-chat Fold: the chat tile's cog, "Turn into a Diamond…", the Diamond.
async function railFold(chatId) {
	await p.evaluate((id) => {
		const box = document.querySelector(`.session-box:not(.diamond-box)[data-id="${id}"]`);
		box.querySelector('.tile-cog').click();
	}, chatId);
	await p.waitForSelector('.tile-fold', { timeout: 8000 });
	await p.click('.tile-fold', { force: true });
	await p.waitForSelector('.fold-menu', { timeout: 8000 });
	await p.evaluate((name) => {
		const item = [...document.querySelectorAll('.fold-menu-item')].find(b => b.textContent.trim() === name);
		item.click();
	}, DIAMOND);
}

// Seed: a Diamond and an ordinary chat with something worth folding.
await p.click('#new-diamond-btn', { force: true });
await p.waitForSelector('.dlg-input', { timeout: 10000 });
await p.fill('.dlg-input', DIAMOND);
await p.click('.dlg-ok', { force: true });
await sleep(1000);
await chat(s, `@text ${CHAT_MARK} one, and something worth keeping about it.`);
await chat(s, `@text ${CHAT_MARK} two, and a second thing.`);
await sleep(800);
const c0 = await sourceChat();
check('seed: the source chat exists', !!c0, c0 ? c0.id : 'none');
// A crystal with something in it, so "as it stood" is a claim about content.
await p.evaluate(async (name) => {
	const row = JSON.parse(await window.__vf.list_diamonds()).find(r => r.name === name);
	await window.__vf.write_crystal_data(row.id,
		JSON.stringify({ title: 'Seed', summary: 'FOLDTRASH seeded crystal.' }, null, 2));
}, DIAMOND);
const d0 = await diamondRow();
check('seed: the Diamond exists', !!d0, JSON.stringify(d0 && { v: d0.version }));

// ── F: fold_apply refused ──
await p.evaluate(() => {
	const proto = window.__m.DaimondApp.prototype;
	window.__realApply = proto.fold_apply;
	proto.fold_apply = function () { return Promise.reject(new Error('probe: fold_apply refused')); };
});
await railFold(c0.id);
let dlg = '';
for (let i = 0; i < 80 && !/Fold failed/.test(dlg); i++) { await sleep(250); dlg = await dialogText(); }
check('F the failure is said in a dialog', /Fold failed/.test(dlg) && /refused/.test(dlg), dlg.slice(0, 120));
await sleep(10000);
dlg = await dialogText();
check('F the dialog is still up after 10 s', /Fold failed/.test(dlg), dlg.slice(0, 80));
await shot(s, 'foldtrash-failed');
const c1 = await sourceChat();
const row = (c1.messages || []).find(m => m.role === 'error_log' && /Fold failed/.test(m.content));
check('F the source chat keeps a settled Fold failed row', !!row && /refused/.test(row.content),
	row ? row.content.slice(0, 100) : JSON.stringify((c1.messages || []).map(m => m.role)));
const running = await p.evaluate(() => document.querySelectorAll('.tool-block.running').length);
check('F no fold tile is left running', running === 0, 'running=' + running);
const d1 = await diamondRow();
check('F the crystal did not move', d1.version === d0.version && d1.crystal === d0.crystal,
	`v ${d0.version} -> ${d1.version}`);
check('F the chat was not trashed', (await inTrash(c0.id)) === false);
await p.click('.dlg-card:not(.tile-dlg-card) .dlg-ok', { force: true }).catch(() => {});
await sleep(500);
await p.evaluate(() => { window.__m.DaimondApp.prototype.fold_apply = window.__realApply; });
await p.evaluate((id) => {
	// The source chat's transcript, on screen: the row is drawn, not only stored.
	const box = document.querySelector(`.session-box:not(.diamond-box)[data-id="${id}"]`);
	const l = box && box.querySelector('.session-box-name');
	(l || box).click();
}, c0.id);
await sleep(1500);
const shown = await p.evaluate(() => (document.getElementById('chat') || document.body).textContent);
check('F the row is drawn when the chat is opened', /Fold failed/.test(shown));

// ── S: the fold lands ──
// Each fold opens the tile dialog afresh; close whatever is left of the last one.
await p.keyboard.press('Escape').catch(() => {});
await sleep(300);
await railFold(c0.id);
let undoUp = false;
for (let i = 0; i < 120 && !undoUp; i++) {
	await sleep(250);
	undoUp = await p.evaluate(() => {
		const u = document.querySelector('.daimond-undo');
		return !!u && /Folded/.test(u.textContent) && getComputedStyle(u).display !== 'none';
	});
}
check('S the fold offers its Undo', undoUp);
const d2 = await diamondRow();
check('S the crystal moved one version', d2.version === d0.version + 1, `${d0.version} -> ${d2.version}`);
check('S STATE.md was rewritten', d2.state !== d0.state && /MOCKNEXT/.test(d2.state), d2.state.slice(0, 60));
check('S the chat is in the Trash', (await inTrash(c0.id)) === true, String(await inTrash(c0.id)));
await shot(s, 'foldtrash-landed');

// ── U: Undo ──
await p.click('.daimond-undo-btn', { force: true });
let back = false;
for (let i = 0; i < 60 && !back; i++) { await sleep(250); back = (await inTrash(c0.id)) === false && !!(await sourceChat()); }
await sleep(1500);
check('U the chat is out of the Trash', back);
const c3 = await sourceChat();
check('U the chat is back with its turns', !!c3 && (c3.messages || []).filter(m => String(m.content || '').includes(CHAT_MARK)).length >= 2);
check('U the chat is no longer marked folded', !!c3 && !c3.foldedInto, JSON.stringify(c3 && c3.foldedInto));
const d3 = await diamondRow();
const same = (a, b) => { try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); } catch (e) { return a === b; } };
check('U the crystal is as it stood', same(d3.crystal, d0.crystal), `v ${d3.version} ` + firstDiff(d0.crystal, d3.crystal));
check('U STATE.md is as it stood', d3.state === d0.state, JSON.stringify(d3.state.slice(0, 60)));
check('U the undo is written forward, not deleted', d3.version > d2.version, `${d2.version} -> ${d3.version}`);
await shot(s, 'foldtrash-undone');

// ── C: a crystal-only fold, and its Undo ──
// The reducer answers the crystal alone, so the fold records no file rows.
fs.writeFileSync(REDUCE, '');
const C_MARK = 'FOLDTRASH-CRYSTALONLY';
await p.keyboard.press('Escape').catch(() => {});
await newChat(s);
await chat(s, `@text ${C_MARK} one, a thing for the crystal alone.`);
await chat(s, `@text ${C_MARK} two, and another.`);
await sleep(800);
const cChat = async () => (await servedChats(s))
	.find(c => (c.messages || []).some(m => String(m.content || '').includes(C_MARK)));
const k0 = await cChat();
check('C seed: the second chat exists', !!k0 && k0.id !== c0.id, k0 ? k0.id : 'none');
const e0 = await diamondRow();
await railFold(k0.id);
let cUp = false;
for (let i = 0; i < 120 && !cUp; i++) {
	await sleep(250);
	cUp = await p.evaluate(() => {
		const u = document.querySelector('.daimond-undo');
		return !!u && /Folded/.test(u.textContent) && getComputedStyle(u).display !== 'none';
	});
}
check('C the fold offers its Undo', cUp);
const e1 = await diamondRow();
check('C the crystal moved one version', e1.version === e0.version + 1, `${e0.version} -> ${e1.version}`);
check('C STATE.md was not touched', e1.state === e0.state, JSON.stringify(e1.state.slice(0, 60)));
check('C the chat is in the Trash', (await inTrash(k0.id)) === true, String(await inTrash(k0.id)));
await p.click('.daimond-undo-btn', { force: true });
let cBack = false;
for (let i = 0; i < 60 && !cBack; i++) { await sleep(250); cBack = (await inTrash(k0.id)) === false && !!(await cChat()); }
await sleep(1500);
const cDlg = await dialogText();
check('C no failure is said', !/could not|failed/i.test(cDlg), cDlg.slice(0, 120));
check('C the chat is out of the Trash', cBack);
const k1 = await cChat();
check('C the chat is no longer marked folded', !!k1 && !k1.foldedInto, JSON.stringify(k1 && k1.foldedInto));
const e2 = await diamondRow();
check('C the crystal is as it stood', same(e2.crystal, e0.crystal), `v ${e2.version} ` + firstDiff(e0.crystal, e2.crystal));
check('C STATE.md is as it stood', e2.state === e0.state);
check('C the undo is written forward', e2.version > e1.version, `${e1.version} -> ${e2.version}`);
await shot(s, 'foldtrash-crystalonly-undone');

fs.writeFileSync(REDUCE, '');
await s.close();
console.log(fail ? '\n' + fail + ' FAIL' : '\nall ' + pass + ' checks passed');
process.exit(fail ? 1 : 0);
