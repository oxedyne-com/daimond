// The model's working, shown in the real app, by a real model — the external oracle.
//
// `dev/verify_thinking.mjs` proves the behaviour against the mock, which is the mock
// doing what this repository told it to.  That is worth having and it is not evidence
// about GLM or DeepSeek.  This drives the same page against OpenRouter, on the two
// models the finding was measured on, and reports what a person would have seen: how
// long after pressing Send the first of the model's working reached the screen, how
// long until the first word of the ANSWER did, and how much working there was in
// between.  The gap between those two numbers is the wait this whole change is about.
//
// IT SPENDS REAL MONEY.  A run is a few tenths of a cent per model; the figure is
// printed at the end from OpenRouter's own `usage` block rather than estimated.  It is
// NOT part of `dev/run_all.sh` and must never be added to it.
//
//   OPENROUTER_KEY=$(cat ~/.config/oxedyne/<...>) node dev/probe_thinking_live.mjs
//   ... node dev/probe_thinking_live.mjs --model z-ai/glm-5.2
//
// First run, 2026-08-28, world 12, this tree: see the table this file prints.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = await import(path.join(HERE, 'harness.mjs'));
const { open, newChat, connectMock, scratch, shot } = H;

const KEY = process.env.OPENROUTER_KEY;
if (!KEY) {
	console.error('Set OPENROUTER_KEY before running this. It spends real money, so it '
		+ 'will not run without one, and no key is written into this file.');
	process.exit(2);
}
const arg = (name, dflt) => {
	const i = process.argv.indexOf('--' + name);
	return i === -1 ? dflt : process.argv[i + 1];
};
const MODELS = arg('model', 'z-ai/glm-5.2,deepseek/deepseek-v4-pro').split(',');
const ASK = arg('ask', 'A shop sells pens at 43p and pencils at 27p. Someone spends '
	+ 'exactly £10.00 on 30 items. How many of each? Show your working.');

const s = await open({ name: 'thinklive', connect: false, profile: scratch('pw', 'thinklive') });

const rows = [];
for (const model of MODELS) {
	const cfg = await connectMock(s,
		{ baseUrl: 'https://openrouter.ai/api/v1/chat/completions', model, apiKey: KEY });
	console.log(`connected: ${JSON.stringify(cfg)}`);
	await H.clearChats(s);
	await newChat(s);

	await s.page.fill('#chat-input', ASK);
	const t0 = Date.now();
	await s.page.click('#chat-send', { force: true });

	let firstThink = null, firstAnswer = null, thinkChars = 0, tiles = 0;
	while (Date.now() - t0 < 240000) {
		const now = await s.page.evaluate(() => {
			const t = Array.from(document.querySelectorAll('.chat-msg-thinking'));
			const body = t.map(x => String(x.querySelector('.chat-thinking-body').textContent || '')).join('');
			const a = document.querySelector('.chat-msg-assistant');
			const b = document.getElementById('chat-send');
			const busy = b ? (/stop/i.test((b.getAttribute('title') || '') + (b.className || '')) || b.disabled) : false;
			return { tiles: t.length, think: body.length, open: t.length ? t[0].open : null,
				answer: a ? String(a.textContent || '').trim().length : 0, busy };
		});
		if (firstThink === null && now.think > 0) {
			firstThink = Date.now() - t0;
			await shot(s, `thinklive-${model.replace(/[^a-z0-9]+/gi, '-')}-firstthink`);
		}
		if (firstAnswer === null && now.answer > 0) firstAnswer = Date.now() - t0;
		thinkChars = Math.max(thinkChars, now.think);
		tiles = Math.max(tiles, now.tiles);
		// The turn has to have STARTED before its stopping means anything: the send
		// button is idle for the first moment too.
		if (!now.busy && (firstThink !== null || firstAnswer !== null)) break;
		if (!now.busy && (Date.now() - t0) > 20000) { console.log('  (the turn never started)'); break; }
		await s.page.waitForTimeout(120);
	}
	const total = Date.now() - t0;
	await shot(s, `thinklive-${model.replace(/[^a-z0-9]+/gi, '-')}-done`);
	const spent = await s.page.evaluate(() => {
		try { return JSON.parse(localStorage.getItem('daimond-spend') || 'null'); } catch { return null; }
	});
	rows.push({ model, firstThink, firstAnswer, thinkChars, tiles, total, spent });
	console.log(`\n${model}`);
	console.log(`  first WORKING on screen   ${firstThink === null ? 'never' : firstThink + ' ms'}`);
	console.log(`  first ANSWER on screen    ${firstAnswer === null ? 'never' : firstAnswer + ' ms'}`);
	console.log(`  working shown             ${thinkChars} characters in ${tiles} tile(s)`);
	console.log(`  round total               ${total} ms`);
	console.log(`  BLANK SPINNER BEFORE      ${firstAnswer === null ? 'n/a' : firstAnswer + ' ms'}`);
	console.log(`  BLANK SPINNER NOW         ${firstThink === null ? 'unchanged' : firstThink + ' ms'}`);
}

console.log('\n' + JSON.stringify(rows, null, 1));
await s.close();
