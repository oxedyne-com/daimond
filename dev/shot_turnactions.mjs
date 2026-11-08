// dev/shot_turnactions.mjs -- a turn's tool calls as their lines, at 390 px and on the desktop (K1).
// On the phone each line wraps its whole command with "HH:MM · duration" small beneath (his pick C,
// D-20261108-04); on the desktop the time and duration stand on the line.
//
//   eval "$(bash dev/world.sh 2 --up)" ; eval "$(bash dev/world.sh 2 --env)"
//   node dev/shot_turnactions.mjs [out dir]
//
// Seeds a chat whose turn thought, edited a file, ran a passing and a failing command and
// answered, as a reload reads it from the store (`done`, and a Kimberlite row's `exit`), and
// shots the folded Thinking and Tools group, then the failing line opened. Fails (exit 1) when
// the folded group does not show the four call lines with their key, exit code and time, or on
// the phone a key is clipped or a line lacks its sub-line, or on the desktop a sub-line shows.
import path from 'node:path';
import fs from 'node:fs';
import { open, shot, scratch, signInAs } from './harness.mjs';

const OUT = process.argv[2] || '';
const PROFILE = scratch('pw', 'turnactions-shot');
fs.rmSync(PROFILE, { recursive: true, force: true });

// A shot is taken at a fixed instant and zone, never the host's (harness `open`).
const CLOCK = Date.parse('2026-11-08T09:00:00+11:00');
const T0 = CLOCK - 120_000;
const TURN = {
	id: 'turnact1',
	name: 'Absolute paths fix',
	model: 'mock/fast', provider: 'mock', status: 'active',
	promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
	prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
	updatedAt: CLOCK,
	messages: [
		{ role: 'user', mid: 'u1', ts: T0, content: 'Make the file tools refuse absolute paths, and test it.' },
		{ role: 'think_log', mid: 'k1', ts: T0 + 1000,
			content: 'The guard drops a leading slash; it should refuse instead, with a sentence that says why.' },
		{ role: 'tool_log', mid: 't1', ts: T0 + 2000, done: T0 + 2100, name: 'file_edit', outcome: 'done',
			args: JSON.stringify({ path: 'src/tools.rs', edits: [{
				old_string: 'let p = p.trim_start_matches(\'/\');\n',
				new_string: 'if p.starts_with(\'/\') {\n    return Err(refusal(p));\n}\n' }] }),
			content: 'Edited src/tools.rs (1 edit).' },
		{ role: 'tool_log', mid: 't2', ts: T0 + 3000, done: T0 + 44_000, name: 'run', outcome: 'done',
			args: JSON.stringify({ argv: ['cargo', 'test', '-p', 'daimond', 'abspaths'] }),
			content: 'running 3 tests\ntest abspaths_refused ... ok\ntest abspaths_named ... ok\ntest relative_kept ... ok\n\ntest result: ok. 3 passed\n[exit code: 0]' },
		{ role: 'tool_log', mid: 't2b', ts: T0 + 44_200, done: T0 + 46_000, name: 'run', outcome: 'done', exit: 0,
			args: JSON.stringify({ argv: ['cargo', 'clippy', '-p', 'daimond', '--all-targets', '--', '-D', 'warnings', '-A', 'clippy::too_many_arguments'] }),
			content: 'Finished dev profile\n[exit code: 0]' },
		{ role: 'tool_log', mid: 't3', ts: T0 + 47_000, done: T0 + 47_400, name: 'run', outcome: 'done', exit: 1,
			args: JSON.stringify({ argv: ['git', 'commit', '-m', 'file tools refuse absolute paths'] }),
			content: 'nothing added to commit but untracked files present (use "git add" to track)\n[exit code: 1]' },
		{ role: 'assistant', mid: 'a1', ts: T0 + 48_000,
			content: 'The file tools now refuse an absolute path and say why; the three tests pass. The commit found nothing staged, so nothing is committed yet.' },
	],
};

async function seed(page, rec) {
	await page.evaluate((r) => new Promise((res, rej) => {
		const req = indexedDB.open('daimond-chats');
		req.onupgradeneeded = () => {
			const d = req.result;
			if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
		};
		req.onsuccess = () => {
			const t = req.result.transaction('chats', 'readwrite');
			t.objectStore('chats').put(r);
			t.oncomplete = () => res(); t.onerror = () => rej(t.error);
		};
		req.onerror = () => rej(req.error);
	}), rec);
}

const openChatByName = (page, name) => page.evaluate((nm) => {
	const boxes = [...document.querySelectorAll('#session-list .session-box')];
	const hit = boxes.find((b) => (b.textContent || '').includes(nm));
	if (hit) { (hit.querySelector('.tile-label, .tile-when, button:not(.av-btn)') || hit).click(); return true; }
	return false;
}, name);

// The call lines a reader sees in the folded group: each tool tile drawn on screen, by its parts.
const lines = (page) => page.evaluate(() => {
	const grp = document.querySelector('#chat-output .crollup[data-t="work"]');
	const drawn = (e) => !!(e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
	return {
		folded: !!(grp && grp.classList.contains('collapsed')),
		lines: [...document.querySelectorAll('#chat-output .crollup[data-t="work"] .ctile[data-t="tool"]')].map((t) => ({
			shown: drawn(t.querySelector('.ctile-lbl')),
			who:  (t.querySelector('.ctile-who') || {}).textContent || '',
			key:  drawn(t.querySelector('.ctile-peek')) ? t.querySelector('.ctile-peek').textContent : '',
			meta: (t.querySelector('.ctile-meta') || {}).textContent || '',
			dur:  drawn(t.querySelector('.ctile-dur')) ? t.querySelector('.ctile-dur').textContent : '',
			sub:  drawn(t.querySelector('.ctile-sub')) ? t.querySelector('.ctile-sub').textContent : '',
			clipped: ((p) => !!p && p.scrollWidth > p.clientWidth + 1)(t.querySelector('.ctile-peek')),
			failed: t.classList.contains('failed'),
		})),
	};
});

// A shot is also copied to the out dir, when one is named.
const keep = (p) => {
	if (!OUT) return p;
	fs.mkdirSync(OUT, { recursive: true });
	const to = path.join(OUT, path.basename(p));
	fs.copyFileSync(p, to);
	return to;
};

let bad = 0;
const s = await open({ name: 'turnactions-shot', profile: PROFILE, connect: true, defaults: true,
	clock: CLOCK, timezoneId: 'Australia/Sydney' });
const { page } = s;
await seed(page, TURN);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'turnactions-shot');
await page.waitForTimeout(600);
console.log('opened:', await openChatByName(page, TURN.name));
await page.waitForTimeout(800);

for (const [w, h, tag] of [[1500, 950, 'desktop'], [390, 844, 'phone']]) {
	await page.setViewportSize({ width: w, height: h });
	await page.waitForTimeout(500);
	const got = await lines(page);
	console.log(tag, JSON.stringify(got));
	const want = [['Edit', 'src/tools.rs', '+3 −1', '08:58 · 0.1 s'], ['Run', 'cargo test -p daimond abspaths', 'exit 0', '08:58 · 41 s'],
		['Run', 'cargo clippy -p daimond --all-targets -- -D warnings -A clippy::too_many_arguments', 'exit 0', '08:58 · 1.8 s'],
		['Run', 'git commit -m "file tools refuse absolute paths"', 'exit 1', '08:58 · 0.4 s']];
	const phone = w <= 480;
	const ok = got.folded && got.lines.length === 4 && want.every(([who, key, meta, sub], i) => {
		const l = got.lines[i];
		const when = phone ? l.sub === sub && !l.dur && !l.clipped : !!l.dur && !l.sub;
		return l.shown && l.who === who && l.key === key && l.meta === meta && when;
	}) && got.lines[3].failed;
	console.log((ok ? 'ok   ' : 'FAIL ') + tag + (phone
		? ': four call lines, each key whole and "HH:MM · duration" beneath'
		: ': four call lines with key, exit and time on the line'));
	if (!ok) bad++;
	console.log('shot', await keep(await shot(s, `turnactions-${tag}-folded`)));
	// The failing line, pressed, opens to its arguments and output.
	await page.evaluate(() => {
		const t = [...document.querySelectorAll('#chat-output .ctile[data-t="tool"]')].pop();
		t.querySelector('.ctile-lbl').click();
		t.scrollIntoView({ block: 'center' });
	});
	await page.waitForTimeout(300);
	const opened = await page.evaluate(() => {
		const t = [...document.querySelectorAll('#chat-output .ctile[data-t="tool"]')].pop();
		const r = t.querySelector('.tool-result');
		return !t.classList.contains('collapsed') && !!r.getClientRects().length && /nothing added/.test(r.textContent);
	});
	console.log((opened ? 'ok   ' : 'FAIL ') + tag + ': the failing line opens to its output');
	if (!opened) bad++;
	console.log('shot', await keep(await shot(s, `turnactions-${tag}-opened`)));
	await page.evaluate(() => [...document.querySelectorAll('#chat-output .ctile[data-t="tool"]')].pop().querySelector('.ctile-lbl').click());
}
await s.close();
process.exit(bad ? 1 : 0);
