// gateway: none
// verify_endings.mjs -- every ending the engine can send, other than `answered`, draws a line
// that says how the turn ended (r541 QA B, F2), and a stop line reads as transcript text on
// the transcript's own text edge (F3, F4).
//
// THE WORDS ARE THE ENGINE'S OWN. They are read out of `TurnEnd::wire` in src/agent.rs, so a
// new ending added there is walked here without anyone remembering to copy it -- which is how
// `capped` and `spend_cap` came to end a turn without a word (QA B: `ended: null` for both).
//
// THE ARMS, from seeded chats on the real `renderHistory` path:
//   1. QUIET: the question and a Thinking tile, then the ending. Every word but `answered`
//      draws a line, and `answered` draws none.
//   2. WORKED: the question, a Thinking-and-Tools group and a partial answer, then the ending.
//      An ending that cut the turn short (stopped, paused, capped, spend_cap) still draws its
//      line, last; every halt but `paused` says "Stopped".
//   3. STYLE AND EDGE (F3, F4): the stop line is set at the tile text size, in the ordinary
//      text colour, with no box, outline or side bar, and its text and its Continue's text
//      start on the tiles' text edge (within 1 px).
//
//   eval "$(bash dev/world.sh N --up)" ; eval "$(bash dev/world.sh N --env)"
//   node dev/verify_endings.mjs
import { open, shot, signInAs, scratch } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/agent.rs'), 'utf8');
const body = (src.match(/pub fn wire\(&self\) -> &'static str \{([\s\S]*?)\n\t\}/) || [])[1] || '';
const WORDS = [...body.matchAll(/Self::\w+\s*=>\s*"([a-z_]+)"/g)].map((m) => m[1]);
const HALTS = new Set(['stopped', 'paused', 'capped', 'spend_cap']);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};
check('0 the engine list is read (TurnEnd::wire, src/agent.rs)', WORDS.length >= 8 && WORDS.includes('answered'),
	JSON.stringify(WORDS));

const PROFILE = scratch('pw', 'endings');
fs.rmSync(PROFILE, { recursive: true, force: true });
const s = await open({ name: 'endings', profile: PROFILE, connect: true, defaults: true });
const { page } = s;

const putRow = (rec) => page.evaluate((rec) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const t = req.result.transaction('chats', 'readwrite');
		t.objectStore('chats').put(rec);
		t.oncomplete = () => res(); t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}), rec);
const NOW = Date.now();
const m = (role, i, x) => Object.assign({ role, mid: 'e' + i, ts: NOW + i, content: role + i }, x || {});
const tool = (i) => m('tool_log', i, { name: 'file_list', args: '{"path":"."}', outcome: 'done' });
// The figures each ending arrives with from the engine: a malformed turn counted its leaked
// round, a reasoning-only one its two rounds, a stop carries the person's own reason.
const end = (i, how) => m('end_log', i, Object.assign({ how, offered: 30, rounds: 2, calls: 0 },
	how === 'malformed' ? { malformed: 1 } : {}, how === 'reasoned_only' ? { reasoned: 2 } : {},
	how === 'stopped' ? { why: 'user' } : {}));
const row = (id, name, messages) => ({ id, name, model: 'mock/fast', provider: 'mock', status: 'active',
	promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0, prevPrompt: 0, prevCompletion: 0,
	prevCached: 0, prevCost: 0, lastPrompt: 0, updatedAt: NOW + 5000, messages });
const quiet = () => [m('user', 0, { content: 'Do the work.' }), m('think_log', 1)];
const worked = () => [m('user', 0, { content: 'Do the work.' }), m('think_log', 1), tool(2),
	m('assistant', 3, { content: 'Partial answer.' })];

for (const w of WORDS) {
	await putRow(row('eq-' + w, 'EQ ' + w, [...quiet(), end(4, w)]));
	if (HALTS.has(w)) await putRow(row('ew-' + w, 'EW ' + w, [...worked(), end(4, w)]));
}
await putRow(row('ew-cap', 'EW lease', [...worked(), m('end_log', 4, { how: 'stopped', why: 'lease_cap', offered: 30, rounds: 3, calls: 1 })]));

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'endings');
await page.waitForTimeout(800);
const openByName = (nm) => page.evaluate((nm) => {
	const hit = [...document.querySelectorAll('#session-list .session-box')].find((b) => (b.textContent || '').trim().includes(nm));
	if (hit) { (hit.querySelector('.tile-label, .tile-when, button') || hit).click(); return true; }
	return false;
}, nm);
const read = () => page.evaluate(() => {
	const out = document.getElementById('chat-output');
	const kids = [...out.children].filter((n) => n.id !== 'chat-queued' && n.id !== 'wire-head'
		&& !(n.classList && n.classList.contains('chat-spinner')));
	const e = out.querySelectorAll('.chat-msg-ended');
	const el = e[e.length - 1] || null;
	const line = el && el.querySelector('.end-line');
	return { n: e.length, how: el ? el.dataset.how || '' : '', text: line ? line.textContent.trim() : '',
		last: !!el && kids[kids.length - 1] === el, title: (document.querySelector('#current-session-name') || {}).textContent || '' };
});
const openAndRead = async (nm) => {
	if (!(await openByName(nm))) return null;
	await page.waitForTimeout(700);
	return read();
};

// ── 1. QUIET: every word draws, `answered` draws nothing ──
for (const w of WORDS) {
	const r = await openAndRead('EQ ' + w);
	if (!r) { check(`1 ${w}: the seeded chat opens`, false); continue; }
	if (w === 'answered') { check('1 answered draws no line', r.n === 0, JSON.stringify(r)); continue; }
	check(`1 ${w} draws a line, in words`, r.n === 1 && r.how === w && r.text && !r.text.includes('end.how_')
		&& r.text !== w, JSON.stringify(r));
}

// ── 2. WORKED: a halt draws its line, last, whatever arrived ──
for (const w of WORDS.filter((x) => HALTS.has(x))) {
	const r = await openAndRead('EW ' + w);
	if (!r) { check(`2 ${w}: the seeded chat opens`, false); continue; }
	check(`2 ${w} after a partial answer still draws its line, last`, r.n === 1 && r.last, JSON.stringify(r));
	if (w !== 'paused') check(`2 ${w} says "Stopped"`, /^Stopped\b/.test(r.text), JSON.stringify(r.text));
}

// ── 3. STYLE AND EDGE ──
const geo = () => page.evaluate(() => {
	const out = document.getElementById('chat-output');
	const inkX = (el) => {
		if (!el) return null;
		const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let n = w.nextNode(); n; n = w.nextNode()) {
			if (!n.textContent.trim()) continue;
			const r = document.createRange(); r.selectNodeContents(n);
			const b = r.getBoundingClientRect(); if (b.width) return Math.round(b.left);
		}
		return null;
	};
	const ended = out.querySelector('.chat-msg-ended');
	const line = ended && ended.querySelector('.end-line');
	const cont = ended && ended.querySelector('.ti-continue');
	const bodies = [...out.querySelectorAll('.ctile-body')].filter((b) => b.offsetParent && b.textContent.trim());
	const ref = bodies[bodies.length - 1];
	const cs = (el) => el ? getComputedStyle(el) : null;
	const ls = cs(line), es = cs(ended), rs = cs(ref);
	return {
		tileX: inkX(ref), lineX: inkX(line), contX: inkX(cont),
		size: ls && ls.fontSize, tileSize: rs && rs.fontSize, colour: ls && ls.color, tileColour: rs && rs.color,
		box: es && [es.borderTopWidth, es.borderLeftWidth, es.outlineStyle, es.backgroundColor, es.boxShadow].join(' '),
	};
});
const THEMES = ['obsidian', 'porcelain', 'light'];
for (const [w, h] of [[1440, 900], [390, 844]]) {
	await page.setViewportSize({ width: w, height: h });
	for (const theme of THEMES) {
		await page.evaluate((t) => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set(t); }, theme);
		if (!(await openByName('EW lease'))) { check(`3 ${w} ${theme}: the stop chat opens`, false); continue; }
		await page.waitForTimeout(700);
		const g = await geo();
		const tag = `3 ${w} ${theme}`;
		check(`${tag} the stop line is set at the tile text size`, !!g.size && g.size === g.tileSize, `${g.size} vs ${g.tileSize}`);
		check(`${tag} in the ordinary text colour`, !!g.colour && g.colour === g.tileColour, `${g.colour} vs ${g.tileColour}`);
		check(`${tag} with no box, outline or side bar`, /^0px 0px none rgba\(0, 0, 0, 0\) none$/.test(g.box || ''), g.box);
		check(`${tag} its text starts on the tile text edge`, g.lineX != null && Math.abs(g.lineX - g.tileX) <= 1, `${g.lineX} vs ${g.tileX}`);
		check(`${tag} and so does its Continue`, g.contX != null && Math.abs(g.contX - g.tileX) <= 1, `${g.contX} vs ${g.tileX}`);
		await shot(s, `endings-${w}-${theme}`);
	}
}

console.log(`\nendings: ${ok.length} ok, ${bad.length} failed`);
if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
await s.close();
process.exit(bad.length ? 1 : 0);
