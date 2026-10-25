// gateway: none
/* ============================================================
   verify_runner_turn_once.mjs — A RUNNER TURN SHOWS ITS STATE ONCE,
   AS A HERE TURN DOES (RUNNER-TURN-ONCE, 25 Oct).
   ------------------------------------------------------------
   The owner, on his Nancy run: "the double "argonaut is on it",
   "argonaut is doing this" are redundant". A turn handed to a runner
   drew a header ("argonaut is on it") over a footer ("argonaut is
   doing this."), with the thread's own "Thinking…" under both: three
   lines saying one thing. A Here turn has the dots
   and one line under them, and no header; a live runner turn must read
   the same: the footer's dots and line, no header.

   In the real page at 390x845 (touch) and 1440x900 it asserts:
     (a) a live runner turn shows exactly one status line, the
         footer's: no tile header, and no thread spinner under it;
     (b) a Here turn shows exactly one status line, the spinner's.
   With RUNNER_TURN_SHOT=<dir> it saves a crop of the live runner turn
   per view, as runner_turn_once_{phone,desktop}.png.

     eval "$(bash dev/world.sh N --env)"; node dev/verify_runner_turn_once.mjs
   ============================================================ */
import { open, signInAs, scratch, newChat } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { guardRan } from './verdict.mjs';

const RID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';	// the runner, "argonaut" in the roster and its beat
const VIEWS = [
	{ tag: 'phone',   w: 390,  h: 845, o: { touch: true, isMobile: true } },
	{ tag: 'desktop', w: 1440, h: 900, o: {} },
];
const SHOTS = process.env.RUNNER_TURN_SHOT || '';
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (pass || !detail ? '' : '  (' + detail + ')'));
};

const putRow = (page, rec) => page.evaluate((rec) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result, t = db.transaction('chats', 'readwrite');
		t.objectStore('chats').put(rec);
		t.oncomplete = () => res(); t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}), rec);

/// The status lines the thread shows for a handed-off turn: the hand-off tile's header and
/// footer line, and the thread's own spinner caption, each when drawn and not empty.
const handoffLines = (page) => page.evaluate(() => {
	const tile = document.querySelector('#chat-output .chat-msg-handoff');
	if (!tile) return null;
	const seen = (e) => !!e && e.isConnected && e.getClientRects().length > 0 && e.textContent.trim() !== '';
	const lines = [...tile.querySelectorAll('.ctile-who, .ti-label'), ...document.querySelectorAll('#chat-output .chat-spinner-say')]
		.filter(seen).map((e) => e.textContent.trim());
	return { lines, head: !!tile.querySelector('.ctile-lbl'), state: tile.dataset.handoffState };
});

try {
	for (const v of VIEWS) {
		const profile = scratch('pw', 'runner-turn-once-' + v.tag);
		fs.rmSync(profile, { recursive: true, force: true });
		const s = await open({ name: 'runner-turn-once-' + v.tag, profile, connect: true, defaults: true,
			viewport: { width: v.w, height: v.h }, ...v.o });
		const page = s.page;
		try {
			// ── (a) A LIVE RUNNER TURN ── a chat holding a turn handed to argonaut, which
			// holds its lease and is running it. Everything after the stubs is the page's own.
			const now = Date.now();
			await putRow(page, {
				id: 'rto1', name: 'RTO hand-off', model: 'mock/fast', provider: 'mock', status: 'active',
				promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
				prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
				updatedAt: now + 5000, messages: [
					{ role: 'user', mid: 'r0', ts: now, content: 'Do it on the runner.' },
					{ role: 'assistant', mid: 'r1', ts: now + 1, content: '', interrupted: true, why: 'dispatched',
						iturn: 'RT1', itext: 'Do it on the runner.', deadline: now + 900000,
						toName: 'argonaut', toDevice: RID },
				],
			});
			await page.reload({ waitUntil: 'domcontentloaded' });
			await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
			await signInAs(s, 'runner-turn-once-' + v.tag);
			await page.waitForTimeout(800);
			await page.evaluate((rid) => {
				const r = DaimondStore.get('daimond-devices', {}) || {};
				const n = Date.now();
				r[rid] = { name: 'argonaut', label: 'argonaut', created: n, namedAt: n, seen: n };
				DaimondStore.put('daimond-devices', r);
				const L = window.DaimondLease;
				// Only the handed-off turn is argonaut's: the Here turn below holds no lease.
				L.record  = (id) => (id === 'RT1' ? { mode: 'running', holder: rid, expiry: Date.now() + 600000 } : null);
				L.blocker = () => null;
				L.holder  = (id) => (id === 'RT1' ? rid : null);
				if (window.DaimondPresence) window.DaimondPresence.name = (id) => (id === rid ? 'argonaut' : '');
			}, RID);
			const opened = await page.evaluate(() => {
				const hit = [...document.querySelectorAll('#session-list .session-box')].find((b) => (b.textContent || '').includes('RTO hand-off'));
				if (hit) { (hit.querySelector('.tile-label, .tile-when, button:not(.av-btn)') || hit).click(); return true; }
				return false;
			});
			check(v.tag + ' the seeded hand-off chat opens', opened);
			await page.waitForTimeout(900);
			const h = await handoffLines(page);
			check(v.tag + ' (a) a live runner turn shows one status line, the footer\'s, and no header',
				!!h && h.state === 'running' && h.lines.length === 1 && /argonaut/.test(h.lines[0]) && !h.head,
				JSON.stringify(h));
			if (SHOTS) {
				fs.mkdirSync(SHOTS, { recursive: true });
				const b = await page.evaluate(() => {
					const r = document.querySelector('#chat-output .chat-msg-handoff').getBoundingClientRect();
					const t = Math.max(0, r.top - 70);
					return { x: 0, y: t, width: innerWidth, height: Math.min(innerHeight - t, r.bottom - t + 30) };
				});
				await page.screenshot({ path: path.join(SHOTS, 'runner_turn_once_' + v.tag + '.png'), clip: b });
			}

			// ── (b) A HERE TURN ── a slow reply on this device, read while it thinks.
			await newChat(s);
			await page.fill('#chat-input', '@slow 4000 Done here.');
			await page.click('#chat-send');
			await page.waitForSelector('#chat-output .chat-spinner', { timeout: 10000 }).catch(() => {});
			const here = await page.evaluate(() => {
				const sp = document.querySelector('#chat-output .chat-spinner');
				if (!sp) return null;
				const seen = (e) => e.getClientRects().length > 0 && e.textContent.trim() !== '';
				return { lines: [...sp.querySelectorAll('.chat-spinner-say, .ctile-who, .ti-label')].filter(seen).map((e) => e.textContent.trim()),
					head: !!sp.querySelector('.ctile-lbl') };
			});
			check(v.tag + ' (b) a Here turn shows one status line, the spinner\'s',
				!!here && here.lines.length === 1 && !here.head, JSON.stringify(here));
		} finally {
			await s.close();
		}
	}
} catch (e) {
	bad.push('crashed: ' + (e && e.message || e));
	console.log('  FAIL crashed — ' + (e && e.stack || e));
}

guardRan(ok.length + bad.length);
console.log('\n' + ok.length + ' ok, ' + bad.length + ' fail');
process.exitCode = bad.length ? 1 : 0;
