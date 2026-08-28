// The model's working, shown while it is being done — 2026-08-28.
//
// The finding this is built on, measured against OpenRouter that morning: Daimond read
// the `content` of an OpenAI-dialect delta and nothing else, so every reasoning token
// that GLM and DeepSeek streamed was thrown away.  One DeepSeek round took 84.7 seconds
// and pulled 1,814,168 bytes down the wire in 1,378 chunks, and what reached the page
// was one tool call and about fifty characters.  A GLM round measured here spent 230 of
// its 300 output tokens reasoning and was then cut off mid-thought.  The user was billed
// for all of it and watched a blank spinner throughout.
//
// So the engine now reads `reasoning` (OpenRouter's spelling) and `reasoning_content`
// (DeepSeek's own), and hands them to the page as they arrive, tagged as working rather
// than as answer.  Which leaves this file with two things to establish, and they pull in
// opposite directions:
//
//   THE WORKING IS SHOWN, WHILE IT IS STILL BEING DONE.  Not after the round, which is
//   the one moment it no longer explains the wait.
//
//   AND IT IS NEVER THE ANSWER.  The reply is what gets written into the transcript and
//   handed back to the model next turn as its own words.  A round's working is mostly
//   wrong turns, and quoting those back to a model as its own conclusions is a data
//   defect, not a cosmetic one.
//
//   node dev/verify_thinking.mjs
//   node dev/verify_thinking.mjs --break perdelta   # a tile per delta, as it was before
//   node dev/verify_thinking.mjs --break shut       # the tile drawn already collapsed
//   node dev/verify_thinking.mjs --break nocollapse # and never folded away afterwards
//   node dev/verify_thinking.mjs --break asanswer   # the working recorded as the reply

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WWW  = path.join(ROOT, 'www');
const H = await import(path.join(HERE, 'harness.mjs'));
const { open, newChat, chat, transcript, shot, connectMock, signInAs, scratch } = H;

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i === -1 ? '' : (process.argv[i + 1] || '');
})();
const NAME = 'thinking';

let failures = 0;
const log  = (...a) => console.log(...a);
const line = (t) => log('\n════════ ' + t + ' ════════');
const check = (ok, what, detail = '') => {
	log((ok ? '  PASS  ' : '  FAIL  ') + what + (detail ? '  -- ' + detail : ''));
	if (!ok) failures++;
};

const BREAKS = {
	// The drawing exactly as it was before this round: every delta its own tile, its own
	// record, and no growing. On a real round that is four hundred disclosures.
	perdelta: [{
		file: 'js/daimond.js',
		find: "\t\tif (live && liveThink && liveThink.parentNode) {",
		with: "\t\tif (false && liveThink && liveThink.parentNode) {",
	}, {
		file: 'js/daimond.js',
		find: "\t\tif (last && last.role === 'think_log') { last.content = (last.content || '') + text; return; }",
		with: "\t\tif (false) { return; }",
	}],
	// Drawn, but collapsed — which is what the tile did before, and which leaves a reader
	// with a closed box and a spinner rather than something to watch.
	shut: [{
		file: 'js/daimond.js',
		find: "\t\t\td.open = true;",
		with: "\t\t\td.open = false;",
	}],
	// Grown and never closed off, so the answer arrives underneath a wall of working.
	nocollapse: [{
		file: 'js/daimond.js',
		find: "\t\t\tif (!liveThink._held) liveThink.open = false;",
		with: "\t\t\tif (false) liveThink.open = false;",
	}],
	// THE ONE THAT MATTERS. The working written into the record as what the model said.
	asanswer: [{
		file: 'js/daimond.js',
		find: "\t\tmsgs.push({ role: 'think_log', content: text, mid: newMid(), ts: Date.now() });",
		with: "\t\tmsgs.push({ role: 'assistant', content: text, mid: newMid(), ts: Date.now() });",
	}],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}
const bodies = new Map();
for (const spec of (BREAKS[BREAK] || [])) {
	const src = bodies.has(spec.file) ? bodies.get(spec.file)
		: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	bodies.set(spec.file, damaged(src, spec));
}
async function serveBreaks(page) {
	for (const [file, body] of bodies) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body }));
	}
}

// THE FIXTURE. Every word distinct, so a doubled stream is a doubled word rather than a
// longer one, and so a count of occurrences means something.
const WORDS = ['WORKING-01', 'WORKING-02', 'WORKING-03', 'WORKING-04', 'WORKING-05',
	'WORKING-06', 'WORKING-07', 'WORKING-08', 'WORKING-09', 'WORKING-10',
	'WORKING-11', 'WORKING-12', 'WORKING-13', 'WORKING-14', 'WORKING-15'];
const THINK = WORDS.join(' ');
const ANSWER = 'ANSWER-MARKER the number is 391.';

const s = await open({ name: NAME, connect: false,
	profile: scratch('pw', 'thinking' + (BREAK ? '-' + BREAK : '')),
	route: serveBreaks });
await connectMock(s);
// The profile outlives a run, and section 3 counts records across the whole store: a
// second run would otherwise be counting the first one's rounds and calling it a defect.
await H.clearChats(s);
await newChat(s);

// ── The round, watched while it runs ────────────────────────────────────────
//
// The turn is started and NOT awaited, because the whole question is what the page shows
// during it. `@reasonslow` paces the working at a real round's pace so there is something
// to look at.
line('1. the working is on the screen while the model is still doing it');
await s.page.fill('#chat-input', `@reasonslow ${THINK} ;; ${ANSWER}`);
await s.page.click('#chat-send', { force: true });

// Poll until a thinking tile appears, and record how far into the round that was and how
// much of the answer had arrived by then.
const t0 = Date.now();
let firstSight = null;
while (Date.now() - t0 < 20000) {
	const seen = await s.page.evaluate(() => {
		const tiles = Array.from(document.querySelectorAll('.chat-msg-thinking'));
		if (!tiles.length) return null;
		const b = tiles[0].querySelector('.chat-thinking-body');
		const asst = document.querySelector('.chat-msg-assistant');
		return {
			tiles: tiles.length,
			open:  tiles[0].open,
			body:  b ? String(b.textContent || '') : '',
			answerYet: asst ? String(asst.textContent || '') : '',
		};
	});
	if (seen) { firstSight = { ...seen, atMs: Date.now() - t0 }; break; }
	await s.page.waitForTimeout(60);
}
check(!!firstSight, 'a thinking tile appeared during the round',
	firstSight ? `after ${firstSight.atMs} ms` : 'nothing in 20 s');
if (firstSight) {
	check(firstSight.body.includes('WORKING-01'),
		'and it already had the model\'s first words in it', JSON.stringify(firstSight.body.slice(0, 40)));
	check(!firstSight.answerYet.includes('ANSWER-MARKER'),
		'shown BEFORE the answer, which is the whole point of showing it',
		`answer so far: ${JSON.stringify(firstSight.answerYet.slice(0, 40))}`);
	check(firstSight.open === true,
		'open, because at that moment it is the only thing there is to show');
}

// And it GROWS: a second look, still mid-round, must find more in the same tile.
let grew = null;
for (let i = 0; i < 60; i++) {
	await s.page.waitForTimeout(200);
	const now = await s.page.evaluate(() => {
		const tiles = Array.from(document.querySelectorAll('.chat-msg-thinking'));
		const b = tiles.length ? tiles[0].querySelector('.chat-thinking-body') : null;
		return { tiles: tiles.length, body: b ? String(b.textContent || '') : '' };
	});
	if (firstSight && now.body.length > firstSight.body.length) { grew = now; break; }
}
check(!!grew && grew.body.length > (firstSight ? firstSight.body.length : 0),
	'the tile FILLS as the model thinks rather than appearing whole at the end',
	grew ? `${firstSight.body.length} → ${grew.body.length} characters` : 'never grew');
check(!!grew && grew.tiles === 1,
	'and it is one tile, not one per delta',
	grew ? `${grew.tiles} tile(s) partway through` : '');
await shot(s, 'thinking-midround');

// ── The round finishes ──────────────────────────────────────────────────────
line('2. and then it gets out of the answer\'s way');
const t1 = Date.now();
while (Date.now() - t1 < 30000) {
	const busy = await s.page.evaluate(() => {
		const b = document.getElementById('chat-send');
		if (!b) return false;
		const t = (b.getAttribute('title') || '') + (b.className || '');
		return /stop/i.test(t) || b.disabled;
	});
	if (!busy) break;
	await s.page.waitForTimeout(200);
}
await s.page.waitForTimeout(600);

const done = await s.page.evaluate((words) => {
	const tiles = Array.from(document.querySelectorAll('.chat-msg-thinking'));
	const body = tiles.length
		? String(tiles[0].querySelector('.chat-thinking-body').textContent || '') : '';
	const counts = {};
	for (const w of words) counts[w] = (body.match(new RegExp(w, 'g')) || []).length;
	const out = document.getElementById('chat-output');
	return {
		tiles:  tiles.length,
		open:   tiles.length ? tiles[0].open : null,
		body,
		counts,
		text:   out ? out.innerText : '',
	};
}, WORDS);

check(done.tiles === 1, 'the whole round is ONE tile', `${done.tiles}`);
check(done.open === false,
	'shut once there is an answer, so the reply is not buried under the working');
check(WORDS.every(w => done.body.includes(w)),
	'and it holds every word the model thought',
	`${done.body.length} characters`);
// `reasoning_details` repeats the same words verbatim on the wire. A reader that took
// both fields would put each of them on the page twice.
const wrong = WORDS.filter(w => done.counts[w] !== 1);
check(wrong.length === 0,
	'each word in the tile exactly once, though the provider sends it twice '
	+ '(`reasoning` and `reasoning_details` carry the same text)',
	wrong.length
		? wrong.map(w => `${w}×${done.counts[w]}`).join(' ')
		: `all ${WORDS.length} exactly once`);
check(done.text.includes('ANSWER-MARKER'), 'the answer is on screen');
await shot(s, 'thinking-after');

// ── THE ONE THAT MUST NOT BREAK ─────────────────────────────────────────────
line('3. the working is not the answer, in the record as well as on the screen');
const stored = await s.page.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats', 1);
	req.onsuccess = () => {
		const db = req.result; let t;
		try { t = db.transaction('chats', 'readonly'); } catch (e) { res([]); return; }
		const out = []; const cur = t.objectStore('chats').openCursor();
		cur.onsuccess = () => { const c = cur.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
		cur.onerror = () => res(out);
	};
	req.onerror = () => res([]);
}));
const msgs  = stored.flatMap(c => c.messages || []);
const asst  = msgs.filter(m => m.role === 'assistant');
const think = msgs.filter(m => m.role === 'think_log');
check(asst.length > 0 && asst.some(m => String(m.content || '').includes('ANSWER-MARKER')),
	'the answer is stored as the assistant\'s message', `${asst.length} assistant message(s)`);
check(!asst.some(m => WORDS.some(w => String(m.content || '').includes(w))),
	'AND NONE OF THE WORKING IS IN IT -- reasoning stored as the reply would be handed '
	+ 'back to the model next turn as its own conclusions',
	asst.map(m => JSON.stringify(String(m.content || '').slice(0, 60))).join(' '));
check(think.length === 1,
	'the working is one record of its own kind, not one per delta', `${think.length} think_log(s)`);
check(think.length > 0 && WORDS.every(w => String(think[0].content || '').includes(w)),
	'and it is all there, so a reload can redraw it');

// ── DeepSeek's own spelling ─────────────────────────────────────────────────
line('4. and the same when the provider calls the field something else');
await chat(s, '@reasonc DEEPSEEK-WORKING considered ;; DEEPSEEK-ANSWER done.', { timeout: 30000 });
const two = await s.page.evaluate(() => {
	const tiles = Array.from(document.querySelectorAll('.chat-msg-thinking'));
	const last  = tiles.length ? tiles[tiles.length - 1] : null;
	const out   = document.getElementById('chat-output');
	return {
		body: last ? String(last.querySelector('.chat-thinking-body').textContent || '') : '',
		text: out ? out.innerText : '',
	};
});
check(two.body.includes('DEEPSEEK-WORKING'),
	'`reasoning_content` is read as well as `reasoning`', JSON.stringify(two.body.slice(0, 50)));
check(two.text.includes('DEEPSEEK-ANSWER'), 'and the answer still arrives');

// ── A reload ────────────────────────────────────────────────────────────────
line('5. a reload draws it back, and draws it shut');
await s.page.reload({ waitUntil: 'domcontentloaded' });
await s.page.waitForTimeout(1200);
await signInAs(s, NAME);
await s.page.waitForTimeout(1500);
await s.page.evaluate(() => {
	const b = document.querySelector('#session-list .chat-box.active')
		|| document.querySelector('#session-list .chat-box');
	if (b) b.click();
});
await s.page.waitForTimeout(1200);
const back = await s.page.evaluate(() => {
	const tiles = Array.from(document.querySelectorAll('.chat-msg-thinking'));
	const out = document.getElementById('chat-output');
	return {
		tiles: tiles.length,
		open:  tiles.map(t => t.open),
		body:  tiles.map(t => String(t.querySelector('.chat-thinking-body').textContent || '')).join(' '),
		text:  out ? out.innerText : '',
	};
});
check(back.body.includes('WORKING-01') && back.body.includes('WORKING-15'),
	'the working survived the reload', `${back.tiles} tile(s)`);
check(back.open.every(o => o === false),
	'and comes back closed: those rounds are over, so it is working again and not news',
	JSON.stringify(back.open));
check(back.text.includes('ANSWER-MARKER'), 'and so did the answer');

// This world asked for no gateway, so `/api` answers 502 by design and says so --
// see the note in dev/world.sh. That is the world, not the page.
const errs = H.errors(s).filter(e => !/favicon/i.test(e) && !/\/api\/\S*\b502\b|502 \(Bad Gateway\)/.test(e));
check(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | '));

log('\n' + (failures ? `FAILED: ${failures} check(s)` : 'all checks passed'));
await s.close();
process.exit(failures ? 1 : 0);
