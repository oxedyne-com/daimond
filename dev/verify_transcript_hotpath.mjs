// Verify the transcript-storage + render hot-path rework (audit #4b, #5-render, #5-merge).
//
// Three proofs, all on the real page, all headless:
//   1  NO MESSAGE LOST. Seed a chat with big think/vision/error/tool logs plus
//      ordinary turns, reload, and assert every message id is still there and
//      the ordinary turns are byte-for-byte intact -- before and after a save.
//   2  THE LOGS ARE CAPPED. After a real save (persistChats via New chat), the
//      STORED row's think/vision/error/tool bodies are bounded and carry the
//      elision marker, the row shrinks, and the reader still sees head and tail.
//   3  THE DIFF RENDER MATCHES A FULL REBUILD. Open a chat, append a turn through
//      the real cross-tab path (append fast path), and assert the resulting DOM
//      is identical to a full rebuild of the same transcript -- and that the
//      already-drawn tiles were NOT recreated (so the append was incremental).
import { open, shot, scratch, errors, signInAs, newChat } from './harness.mjs';
import fs from 'node:fs';

const PROFILE = scratch('pw', 'transcript-hotpath');
fs.rmSync(PROFILE, { recursive: true, force: true });

const big = (tag, n) => (tag + ' ').repeat(n);   // a long, self-identifying body

function seededChat() {
	const messages = [
		{ role: 'user',       mid: 'u0', ts: 1, content: 'First question, kept whole.' },
		{ role: 'think_log',  mid: 'th0', ts: 2, content: 'HEADT ' + big('mid-think', 12000) + ' TAILT' },
		{ role: 'tool_log',   mid: 'to0', ts: 3, name: 'file_read', args: '{"path":"a.txt"}',
			outcome: 'done', content: 'HEADTOOL ' + big('mid-tool', 12000) + ' TAILTOOL' },
		{ role: 'vision_log', mid: 'vi0', ts: 4, content: 'HEADV ' + big('mid-vision', 12000) + ' TAILV' },
		{ role: 'assistant',  mid: 'a0', ts: 5, content: 'A short answer that must survive verbatim.' },
		{ role: 'error_log',  mid: 'er0', ts: 6, content: 'HEADE ' + big('mid-error', 12000) + ' TAILE' },
		{ role: 'user',       mid: 'u1', ts: 7, content: 'Second question, also kept whole.' },
		{ role: 'assistant',  mid: 'a1', ts: 8, content: 'Second answer, verbatim.' },
	];
	return {
		id: 'hot1', name: 'Hot path chat', model: 'mock/fast', provider: 'mock', status: 'active',
		promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
		prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
		updatedAt: Date.now(), messages,
	};
}

const putRow = (page, rec) => page.evaluate((r) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onupgradeneeded = () => {
		const d = req.result;
		if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
	};
	req.onsuccess = () => {
		const db = req.result, t = db.transaction('chats', 'readwrite');
		t.objectStore('chats').put(r);
		t.oncomplete = () => res(); t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}), rec);

const readRow = (page, id) => page.evaluate((k) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result, t = db.transaction('chats', 'readonly');
		const g = t.objectStore('chats').get(k);
		g.onsuccess = () => res(g.result || null); g.onerror = () => rej(g.error);
	};
	req.onerror = () => rej(req.error);
}), id);

const openChatByName = (page, name) => page.evaluate((nm) => {
	const boxes = [...document.querySelectorAll('#session-list .session-box')];
	const hit = boxes.find((b) => (b.textContent || '').includes(nm));
	if (hit) { (hit.querySelector('.tile-label, .tile-when, button') || hit).click(); return true; }
	return false;
}, name);

// The transcript region of the thread, with the furniture that renders async or
// carries volatile ids stripped, so two captures compare on the tiles alone.
const transcriptHtml = (page) => page.evaluate(() => {
	const o = document.getElementById('chat-output').cloneNode(true);
	o.querySelectorAll('#wire-head, #chat-queued, .chat-turn-indicator, .chat-spinner').forEach((n) => n.remove());
	// The test's own marker, not part of the render.
	o.querySelectorAll('[data-premark]').forEach((n) => n.removeAttribute('data-premark'));
	return o.innerHTML;
});

// Rename the open chat through its real tile-cog dialog: the app's own path to a
// stamp-changing write, which is what makes persistChats -> slimMessages cap and
// put the row. (A chat whose stamp has not moved is never re-written, so a save
// that leaves the row unchanged is correct, not a missing cap.)
const renameViaCog = async (page, matchName, newName) => {
	await page.evaluate((nm) => {
		const boxes = [...document.querySelectorAll('#session-list .session-box')];
		const hit = boxes.find((b) => (b.textContent || '').includes(nm));
		const cog = hit && hit.querySelector('.tile-cog');
		if (cog) cog.click();
	}, matchName);
	await page.waitForSelector('.tile-dlg-name-input', { timeout: 5000 });
	await page.evaluate((nn) => {
		const inp = document.querySelector('.tile-dlg-name-input');
		inp.value = nn;
		inp.dispatchEvent(new Event('change', { bubbles: true }));
	}, newName);
};

const fail = [];
const ok = [];
const check = (cond, msg) => (cond ? ok : fail).push(msg);

const s = await open({ name: 'transcript-hotpath', profile: PROFILE, connect: true, defaults: true });
const { page } = s;

// ── 1 + 2  seed, reload, prove no loss, then cap on save ──────────────────────
await putRow(page, seededChat());
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'transcript-hotpath');
await page.waitForTimeout(700);

const rawBefore = await readRow(page, 'hot1');
const bytesBefore = JSON.stringify(rawBefore).length;
check(rawBefore && rawBefore.messages.length === 8, `boot: row holds 8 messages (got ${rawBefore && rawBefore.messages.length})`);
const thBefore = rawBefore.messages.find((m) => m.mid === 'th0');
check(thBefore && thBefore.content.length > 50000 && !thBefore.elided,
	`boot: think_log stored full and uncapped (${thBefore && thBefore.content.length} chars)`);

const opened = await openChatByName(page, 'Hot path chat');
check(opened, 'open: seeded chat opened from the rail');
await page.waitForTimeout(500);

// On screen, every message is present and the ordinary turns are intact.
const dom1 = await page.evaluate(() => {
	// textContent, not innerText: a Thinking tile renders COLLAPSED (only a head
	// peek is visible), and the tail we are checking for lives in the hidden body.
	const txt = document.getElementById('chat-output').textContent;
	return {
		hasA0: txt.includes('A short answer that must survive verbatim.'),
		hasA1: txt.includes('Second answer, verbatim.'),
		hasU0: txt.includes('First question, kept whole.'),
		// head and tail of the capped logs are both on screen
		thinkHead: txt.includes('HEADT'), thinkTail: txt.includes('TAILT'),
		visionHead: txt.includes('HEADV'), visionTail: txt.includes('TAILV'),
		errorHead: txt.includes('HEADE'), errorTail: txt.includes('TAILE'),
	};
});
check(dom1.hasA0 && dom1.hasA1 && dom1.hasU0, 'render: ordinary turns shown verbatim');
check(dom1.thinkHead && dom1.thinkTail, 'render: think_log shows HEAD and TAIL');
check(dom1.visionHead && dom1.visionTail, 'render: vision_log shows HEAD and TAIL');
check(dom1.errorHead && dom1.errorTail, 'render: error_log shows HEAD and TAIL');

// Trigger a real stamp-changing save (rename runs touchChat + persistChats -> slimMessages).
await renameViaCog(page, 'Hot path chat', 'Hot path chat R');
await page.waitForTimeout(800);
await page.keyboard.press('Escape').catch(() => {});

const rawAfter = await readRow(page, 'hot1');
const bytesAfter = JSON.stringify(rawAfter).length;
check(rawAfter && rawAfter.messages.length === 8, `save: row STILL holds 8 messages (got ${rawAfter && rawAfter.messages.length})`);

const byMid = {};
(rawAfter ? rawAfter.messages : []).forEach((m) => { byMid[m.mid] = m; });
// The ordinary turns must be byte-for-byte unchanged.
check(byMid.a0 && byMid.a0.content === 'A short answer that must survive verbatim.', 'save: assistant a0 intact');
check(byMid.a1 && byMid.a1.content === 'Second answer, verbatim.', 'save: assistant a1 intact');
check(byMid.u0 && byMid.u0.content === 'First question, kept whole.', 'save: user u0 intact');
// The logs are capped: bounded, elided-marked, head and tail retained.
for (const [mid, tag] of [['th0','think'],['vi0','vision'],['er0','error'],['to0','tool']]) {
	const m = byMid[mid];
	const capped = m && m.elided > 0 && m.content.length < 8000;
	check(capped, `save: ${tag}_log capped (elided=${m && m.elided}, len=${m && m.content.length})`);
	if (mid !== 'to0') {
		check(m && m.content.startsWith('HEAD') && /TAIL[A-Z]$/.test(m.content.trim()),
			`save: ${tag}_log kept head AND tail`);
	}
}
check(bytesAfter < bytesBefore / 5, `save: row shrank (${bytesBefore} -> ${bytesAfter} bytes)`);

// Reload once more: the capped row must round-trip with no message lost.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'transcript-hotpath');
await page.waitForTimeout(700);
const rawReload = await readRow(page, 'hot1');
check(rawReload && rawReload.messages.length === 8, `reload: capped row round-trips 8 messages (got ${rawReload && rawReload.messages.length})`);
const mids = (rawReload ? rawReload.messages.map((m) => m.mid) : []).sort().join(',');
check(mids === 'a0,a1,er0,th0,to0,u0,u1,vi0', `reload: every mid present (${mids})`);

// ── 3  diff render == full rebuild ────────────────────────────────────────────
const opened2 = await openChatByName(page, 'Hot path chat');
check(opened2, 'diff: reopened chat for render test');
await page.waitForTimeout(500);

// Mark the standing tiles so we can prove the append did not recreate them.
await page.evaluate(() => {
	let i = 0;
	document.querySelectorAll('#chat-output .ctile, #chat-output .chat-msg, #chat-output .crollup')
		.forEach((n) => { n.dataset.premark = String(i++); });
});

// Append a new turn to the stored transcript and fire the REAL cross-tab path.
const appendTurn = [
	{ role: 'user', mid: 'u2', ts: 9, content: 'Third question, appended after render.' },
	{ role: 'think_log', mid: 'th2', ts: 10, content: 'A short new thought.' },
	{ role: 'assistant', mid: 'a2', ts: 11, content: 'Third answer, appended after render.' },
];
await page.evaluate((extra) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result, t = db.transaction('chats', 'readwrite');
		const g = t.objectStore('chats').get('hot1');
		g.onsuccess = () => {
			const rec = g.result; rec.messages = rec.messages.concat(extra); rec.updatedAt = Date.now();
			t.objectStore('chats').put(rec);
		};
		t.oncomplete = () => res(); t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}), appendTurn);
await page.evaluate(() => {
	const k = 'daimond-chats-rev', v = String(Date.now()) + '.' + Math.random();
	try { localStorage.setItem(k, v); } catch {}
	window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: v }));
});
await page.waitForTimeout(700);

const appendHtml = await transcriptHtml(page);
const appendShows = await page.evaluate(() => document.getElementById('chat-output').innerText.includes('Third answer, appended after render.'));
check(appendShows, 'diff: appended turn is visible after the cross-tab nonce');
// The pre-existing tiles kept their marker -> they were not recreated (incremental).
const preserved = await page.evaluate(() => {
	const marked = document.querySelectorAll('#chat-output [data-premark]').length;
	return marked;
});
check(preserved > 0, `diff: ${preserved} pre-existing tiles preserved (append was incremental, not a rebuild)`);

// Now force a FULL rebuild of the same transcript: switch away, switch back.
await newChat(s).catch(() => {});
await page.waitForTimeout(300);
const reop = await openChatByName(page, 'Hot path chat');
check(reop, 'diff: reopened for full-rebuild capture');
await page.waitForTimeout(600);
const fullHtml = await transcriptHtml(page);

check(appendHtml === fullHtml, 'diff: append-path DOM == full-rebuild DOM'
	+ (appendHtml === fullHtml ? '' : `\n   append len=${appendHtml.length} full len=${fullHtml.length}`));
if (appendHtml !== fullHtml) {
	// Show the first divergence to make a failure debuggable.
	let i = 0; while (i < appendHtml.length && appendHtml[i] === fullHtml[i]) i++;
	console.log('  first diff at', i, '\n   append:', JSON.stringify(appendHtml.slice(i - 40, i + 60)),
		'\n   full  :', JSON.stringify(fullHtml.slice(i - 40, i + 60)));
}

await shot(s, 'transcript-hotpath');
console.log('\n--- PASS ---'); ok.forEach((m) => console.log('  ok  ', m));
console.log('--- FAIL ---'); fail.forEach((m) => console.log('  FAIL', m));
console.log('\nconsole errors:', errors(s).slice(0, 8));
await s.close();
process.exit(fail.length ? 1 : 0);
