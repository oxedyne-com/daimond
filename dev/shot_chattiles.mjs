// dev/shot_chattiles.mjs — screenshot the redesigned chat transcript tiles.
//
//   eval "$(bash dev/world.sh 2 --up)" ; eval "$(bash dev/world.sh 2 --env)"
//   node dev/shot_chattiles.mjs
//
// Seeds a rich ordinary chat straight into IndexedDB so a run is deterministic
// (a Thinking rollup, a Tools rollup with ok/refused/failed, a Daimond answer),
// opens it with the Wire on, and shots it in the reading view and in select
// mode; then drives a LIVE reasoning+tool turn to prove the tiles build as the
// turn streams; then a Diamond's chat in select mode to show Fold-selected gone.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { open, shot, newChat, chat, scratch, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
const PROFILE = scratch('pw', 'chattiles-shot');
fs.rmSync(PROFILE, { recursive: true, force: true });

const RICH = {
	id: 'rich1',
	name: 'Auto-pause research',
	model: 'mock/fast', provider: 'mock', status: 'active',
	promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
	prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
	updatedAt: Date.now(),
	messages: [
		{ role: 'user', mid: 'm1', ts: 1,
			content: 'subscription services that offer auto-pause after a billing period of no activity' },
		{ role: 'think_log', mid: 'm2', ts: 2,
			content: 'Auto-pause is the concept; most services only pause on a manual request from the customer.' },
		{ role: 'think_log', mid: 'm3', ts: 3,
			content: 'Separate genuine inactivity-detection from a manual pause button — the two are usually conflated.' },
		{ role: 'think_log', mid: 'm4', ts: 4,
			content: 'Stripe pause_collection is the usual build primitive; name it, and the activity-detection layer above it.' },
		{ role: 'tool_log', mid: 'm5', ts: 5, name: 'web_search',
			args: '{"query":"subscription auto-pause after inactivity billing"}',
			outcome: 'done',
			content: '6 results\n1 Recurly pause schedules\n2 Stripe pause_collection\n3 dunning vs pause\n4 …' },
		{ role: 'tool_log', mid: 'm6', ts: 6, name: 'file_write',
			args: '{"path":"/notes/autopause.md","content":"…"}',
			outcome: 'refused',
			content: 'Refused: path is outside chats/<id>/work — nothing was written.' },
		{ role: 'tool_log', mid: 'm7', ts: 7, name: 'file_read',
			args: '{"path":"/etc/hosts"}',
			outcome: 'failed',
			content: 'Error: could not read that path.' },
		{ role: 'assistant', mid: 'm8', ts: 8,
			content: 'The feature you are describing is called **"Auto-Pause"** — surprisingly rare '
				+ 'despite being talked about for a decade. Most services that offer a pause require '
				+ 'you to request it manually; very few detect inactivity and pause billing on their own.\n\n'
				+ 'To build it, **Stripe’s subscription pause** is the usual starting point: set a '
				+ 'pause schedule programmatically when your own activity-detection logic fires. The hard '
				+ 'part is not the billing — it is defining what "inactive" means for your service.' },
	],
};

async function seed(page, rec) {
	await page.evaluate((r) => new Promise((res, rej) => {
		const req = indexedDB.open('daimond-chats', 1);
		req.onupgradeneeded = () => {
			const d = req.result;
			if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
		};
		req.onsuccess = () => {
			const db = req.result;
			const t = db.transaction('chats', 'readwrite');
			t.objectStore('chats').put(r);
			t.oncomplete = () => res(); t.onerror = () => rej(t.error);
		};
		req.onerror = () => rej(req.error);
	}), rec);
}

const openChatByName = (page, name) => page.evaluate((nm) => {
	const boxes = [...document.querySelectorAll('#session-list .session-box')];
	const hit = boxes.find((b) => (b.textContent || '').includes(nm));
	if (hit) { (hit.querySelector('.tile-label, .tile-when, button') || hit).click(); return true; }
	return false;
}, name);

const panelShot = async (s, label) => {
	fs.mkdirSync(SHOTS, { recursive: true });
	const p = path.join(SHOTS, `${label}.png`);
	const panel = s.page.locator('#panel-ai');
	await panel.screenshot({ path: p, timeout: 8000 }).catch(() => {});
	return p;
};

const s = await open({ name: 'chattiles-shot', profile: PROFILE, connect: true, defaults: true });
const { page } = s;

// ── 1. The seeded rich transcript ──────────────────────────────────
await seed(page, RICH);
await page.reload({ waitUntil: 'domcontentloaded' });
// re-sign after reload (lands on the lock screen)
import('./harness.mjs').then(() => {});
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
{
	const { signInAs } = await import('./harness.mjs');
	await signInAs(s, 'chattiles-shot');
}
await page.waitForTimeout(600);
const opened = await openChatByName(page, 'Auto-pause research');
console.log('opened rich chat:', opened);
await page.waitForTimeout(500);
// Wire ON — reveals the System container.
await page.evaluate(() => { const b = document.getElementById('wire-btn'); if (b) b.click(); });
await page.waitForTimeout(700);
// Expand the Thinking and Tools rollups so their nested tiles read.
await page.evaluate(() => {
	document.querySelectorAll('#chat-output .crollup').forEach((r) => r.classList.remove('collapsed'));
	// open the failed tool tile so both states show
	document.querySelectorAll('#chat-output .ctile[data-t="tool"]').forEach((t) => t.classList.remove('collapsed'));
});
await page.waitForTimeout(400);
await shot(s, 'chattiles-1-full');
await panelShot(s, 'chattiles-1-panel');

// Collapsed (default) view — rollups shut, peeks showing.
await page.evaluate(() => {
	document.querySelectorAll('#chat-output .crollup').forEach((r) => r.classList.add('collapsed'));
	document.querySelectorAll('#chat-output .ctile[data-t="tool"],#chat-output .ctile[data-t="think"],#chat-output .ctile[data-t="wire"]').forEach((t) => t.classList.add('collapsed'));
});
await page.waitForTimeout(300);
await panelShot(s, 'chattiles-2-collapsed');

// ── 2. Select mode on the ordinary chat ────────────────────────────
await page.evaluate(() => { const b = document.getElementById('collapse-btn'); if (b) b.click(); });
await page.waitForTimeout(300);
// tick a couple to show the checked state + count
await page.evaluate(() => {
	const units = [...document.querySelectorAll('#chat-output .csel-unit')];
	if (units[0]) units[0].querySelector('.ctile-lbl, .crollup-lbl').click();
	if (units[2]) units[2].querySelector('.ctile-lbl, .crollup-lbl').click();
});
await page.waitForTimeout(300);
await panelShot(s, 'chattiles-3-select-ordinary');
// leave select mode
await page.evaluate(() => { const b = document.getElementById('collapse-btn'); if (b) b.click(); });

// ── 3. A LIVE reasoning + tool turn (streaming builds tiles) ───────
await newChat(s);
await chat(s, '@reasontool I’ll look at the workspace first.;;file_list {"path":"."}');
await page.waitForTimeout(500);
await page.evaluate(() => { const b = document.getElementById('wire-btn'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); });
await page.waitForTimeout(500);
await panelShot(s, 'chattiles-4-live');

// ── 4. A Diamond's chat in select mode → no Fold-selected ─────────
const wentDiamond = await page.evaluate(() => {
	const box = [...document.querySelectorAll('.diamond-box')][0];
	if (!box) return false;
	// The box itself opens the Diamond — a button inside it is the settings gear.
	box.click();
	return true;
});
console.log('opened a diamond:', wentDiamond);
await page.waitForTimeout(700);
// switch to its chat face
await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
await page.waitForTimeout(600);
await page.evaluate(() => { const b = document.getElementById('collapse-btn'); if (b) b.click(); });
await page.waitForTimeout(500);
await panelShot(s, 'chattiles-5-select-diamond');

const diag = await page.evaluate(() => {
	const sf = document.getElementById('sel-fold');
	const mark = document.getElementById('chead-mark');
	return {
		foldVisible: sf ? getComputedStyle(sf).display !== 'none' : null,
		onDiamond:   mark ? getComputedStyle(mark).display !== 'none' : null,
		selecting:   document.getElementById('chat-output').classList.contains('selecting'),
	};
});
console.log('Diamond select-mode diag (want foldVisible=false):', diag);

const errs = errors(s);
console.log('console errors:', errs.length, errs.slice(0, 8));
await s.close();
console.log('shots in', SHOTS);
