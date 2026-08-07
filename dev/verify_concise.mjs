// verify_concise.mjs — the chip changes what the MODEL is sent.
//
// The chip in the chat header is a standing toggle that puts the `/concise`
// skill in front of every turn the chat sends. Whether the input box changed
// proves nothing: the property is about the request, so every assertion here
// reads the mock provider's own log (`DAIMOND_MOCK_LOG`) and looks at the user
// message the provider actually received.
//
// Four properties:
//   1. Off, the turn carries exactly what was typed.
//   2. On, the turn carries the SKILL'S OWN TEXT — not the string "/concise",
//      which would mean the wasm resolved nothing and the model was handed a
//      slash it cannot act on.
//   3. The chip is per chat and survives a reload.
//   4. A message the user began with their own `/command` is left alone.
//
// Gated: the skill file has to be on disk, and the mock has to have been
// reached at all, before any of the above can mean anything.
//
//   node dev/verify_concise.mjs
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { open, newChat, scratch, mockLog, clearMockLog } from './harness.mjs';

const OUT = path.join(os.homedir(), '.cache/daimond/concise-shots');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

/// The last user message the provider was actually sent.
function lastUserSent() {
	const rows = mockLog();
	for (let i = rows.length - 1; i >= 0; i--) {
		const msgs = rows[i].messages || [];
		for (let j = msgs.length - 1; j >= 0; j--) {
			if (msgs[j].role === 'user') return String(msgs[j].content || '');
		}
	}
	return null;
}

const s = await open({ name: 'concise', profile: scratch('pw', 'concise-' + process.pid) });
const { page } = s;
try {
	await newChat(s);

	// ── 0. The gate: the mock must be reachable, or every assertion below is
	// about a file that was never written. ──
	clearMockLog();
	await page.fill('#chat-input', '@text hello');
	await page.click('#chat-send');
	await page.waitForTimeout(2500);
	check(lastUserSent() !== null, 'the mock provider was reached',
		lastUserSent() === null ? 'nothing in the mock log — nothing below can be judged' : 'yes');
	if (lastUserSent() === null) { await s.close(); process.exit(1); }

	// ── 1. Off: what was typed is what was sent ──
	check(lastUserSent() === '@text hello', 'with the chip off, the turn is what was typed',
		JSON.stringify(lastUserSent()));

	const chipState = () => page.evaluate(() => {
		const c = document.getElementById('concise-chip');
		if (!c) return null;
		return { shown: c.getClientRects().length > 0, pressed: c.getAttribute('aria-pressed') };
	});
	// Which chat this is, so the check below can come BACK to it rather than to
	// whichever tile happens to be first once a second chat exists.
	const firstChatId = await page.evaluate(() => {
		const box = document.querySelector('#session-list .session-box');
		return box ? box.dataset.id : null;
	});

	const before = await chipState();
	check(before && before.shown, 'the chip is in the chat header', JSON.stringify(before));
	check(before && before.pressed === 'false', 'and it starts off', before && before.pressed);

	// ── 2. On: the chip lights, and the skill file appears ──
	await page.evaluate(() => document.getElementById('concise-chip').click());
	await page.waitForTimeout(1500);
	const lit = await chipState();
	check(lit && lit.pressed === 'true', 'pressing it lights it', lit && lit.pressed);

	// Read the file the way the panel does, not the way the model does.
	const skillText = await page.evaluate(async () => {
		try {
			const m = await import('./pkg/oxedyne_daimond.js');
			return await m.read_file('.daimond/skills/concise.md');
		} catch (e) { return 'ERR ' + String(e); }
	});
	check(typeof skillText === 'string' && /name:\s*concise/.test(skillText),
		'the skill file is on disk', String(skillText).slice(0, 40).replace(/\n/g, '⏎'));

	// ── 3. The turn carries the SKILL'S TEXT, not the slash ──
	clearMockLog();
	await page.fill('#chat-input', '@text second');
	await page.click('#chat-send');
	await page.waitForTimeout(3000);
	const sent = lastUserSent();
	check(sent !== null && sent !== '@text second',
		'with the chip on, the turn is NOT what was typed', JSON.stringify(String(sent).slice(0, 60)));
	check(sent !== null && /Skill 'concise'/.test(sent),
		'the skill was resolved into the turn, not left as a slash',
		JSON.stringify(String(sent).slice(0, 70)));
	check(sent !== null && /as few words as carry the answer/i.test(sent),
		'the skill FILE\'S OWN WORDS reached the model');
	check(sent !== null && /@text second/.test(sent),
		'and what the user typed is still in it');

	// ── 4. The choice survives a reload ──
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
	if (await page.$('#id-pass')) {
		await page.fill('#id-pass', 'testpass1234');
		await page.evaluate(() => document.getElementById('id-primary').click());
		await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 }).catch(() => {});
	}
	await page.waitForTimeout(2500);
	const afterReload = await chipState();
	check(afterReload && afterReload.pressed === 'true',
		'the chip is still lit after a reload', afterReload && JSON.stringify(afterReload));

	// ── 5. It is per CHAT, not per app ──
	await page.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); });
	await page.waitForTimeout(200);
	await page.evaluate(() => document.getElementById('new-session-btn').click());
	await page.waitForTimeout(600);
	await page.evaluate(() => {
		const start = [...document.querySelectorAll('.tile-start')].pop();
		if (start) start.click();
	});
	await page.waitForTimeout(1200);
	const onNewChat = await chipState();
	check(onNewChat && onNewChat.pressed === 'false',
		'a different chat does not inherit it', onNewChat && JSON.stringify(onNewChat));

	// ── 6. The user's own command wins ──
	// Back to the lit chat, then type a slash command of their own.
	await page.evaluate((id) => {
		const box = document.querySelector('#session-list .session-box[data-id="' + id + '"]');
		if (box) box.click();
	}, firstChatId);
	await page.waitForTimeout(800);
	const backLit = await chipState();
	check(backLit && backLit.pressed === 'true', 'and the first chat still has it lit',
		backLit && JSON.stringify(backLit));
	clearMockLog();
	await page.fill('#chat-input', '/nosuchskill please');
	await page.click('#chat-send');
	await page.waitForTimeout(2500);
	const afterSlash = lastUserSent();
	// The engine refuses an unknown skill BEFORE the provider is reached, so the
	// property is that nothing new was sent — and in particular that `/concise`
	// was not stapled in front of the user's own command.
	check(afterSlash === null || !/Skill 'concise'/.test(afterSlash),
		'a message the user began with a slash is left alone',
		afterSlash === null ? 'nothing reached the provider (the unknown skill was refused)'
			: JSON.stringify(String(afterSlash).slice(0, 60)));

	await page.screenshot({ path: path.join(OUT, 'chip-lit.png'),
		clip: await page.evaluate(() => {
			const h = document.querySelector('#panel-ai .chead');
			const r = h.getBoundingClientRect();
			return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
		}) });
	check(fs.existsSync(path.join(OUT, 'chip-lit.png')), 'the header screenshot is on disk');
} finally {
	await s.close();
}

console.log(failures === 0
	? `\nconcise: the chip changes the turn, not just the box. Shots in ${OUT}`
	: `\nconcise: ${failures} failure(s). Shots in ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
