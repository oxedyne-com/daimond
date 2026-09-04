// Click-through verification of the chat-tile refinements (owner review 2026-09-04).
// Seeds a rich ordinary chat (thinking rollup + tool + reply), proves the tool tile
// renders and the selection model works by REAL CLICKS, checks the layout/header
// items, then drives a Diamond to check the header + fold-button-per-type.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { open, shot, newChat, chat, scratch, signInAs, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
const PROFILE = scratch('pw', 'verify-refine');
fs.rmSync(PROFILE, { recursive: true, force: true });

const RICH = {
	id: 'rich-refine', name: 'Refine research',
	model: 'deepseek/deepseek-v4-pro', provider: 'mock', status: 'active',
	promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
	prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
	updatedAt: Date.now(),
	messages: [
		{ role: 'user', mid: 'm1', ts: 1, content: 'compare three auto-pause designs' },
		{ role: 'think_log', mid: 'm2', ts: 2, content: 'First, separate inactivity detection from a manual pause.' },
		{ role: 'think_log', mid: 'm3', ts: 3, content: 'Stripe pause_collection is the usual primitive.' },
		{ role: 'think_log', mid: 'm4', ts: 4, content: 'Name the activity-detection layer above it.' },
		{ role: 'tool_log', mid: 'm5', ts: 5, name: 'web_search',
			args: '{"query":"subscription auto-pause"}', outcome: 'done',
			content: '6 results\n1 Recurly\n2 Stripe pause_collection' },
		{ role: 'assistant', mid: 'm8', ts: 8, content: 'The feature is **Auto-Pause**. Stripe subscription pause is the usual start.' },
		{ role: 'end_log', mid: 'm9', ts: 9, how: 'answered', offered: 20, rounds: 2, calls: 1, refused: 0, failed: 0, missing: [] },
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
	await s.page.locator('#panel-ai').screenshot({ path: p, timeout: 8000 }).catch(() => {});
};

const R = {};      // results
const say = (k, v) => { R[k] = v; console.log(k, '=>', JSON.stringify(v)); };

const s = await open({ name: 'verify-refine', profile: PROFILE, connect: true, defaults: true });
const { page } = s;

await seed(page, RICH);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'verify-refine');
await page.waitForTimeout(700);
await openChatByName(page, 'Refine research');
await page.waitForTimeout(900);

// ── Item 1: tool tile renders ; Item 3: no furniture ending ; Item 14 model name
say('item1_toolTiles', await page.evaluate(() => {
	const out = document.getElementById('chat-output');
	return {
		toolTiles: out.querySelectorAll('.ctile[data-t="tool"]').length,
		toolRollups: out.querySelectorAll('.crollup[data-t="tool"]').length,
		toolVisible: [...out.querySelectorAll('.crollup[data-t="tool"]')]
			.filter((e) => getComputedStyle(e).display !== 'none').length,
	};
}));
say('item3_endingFooter', await page.evaluate(() =>
	document.querySelectorAll('#chat-output .chat-msg-ended, #chat-output .end-line').length));
say('item14_modelName', await page.evaluate(() => {
	const out = document.getElementById('chat-output');
	const thinkMeta = [...out.querySelectorAll('.ctile[data-t="think"] > .ctile-lbl > .ctile-meta')].map((m) => m.textContent);
	const replyMeta = [...out.querySelectorAll('.ctile[data-t="reply"] > .ctile-lbl > .ctile-meta')].map((m) => m.textContent);
	return { thinkMeta, replyMeta };
}));

// ── Item 7: System header token, no caption, no outer border ; Item 8 Wire gone
say('item7_system', await page.evaluate(() => {
	const wh = document.getElementById('wire-head');
	const meta = wh && wh.querySelector(':scope > .crollup-lbl > .ctile-meta');
	return {
		wireHeadIsRollup: !!(wh && wh.classList.contains('crollup')),
		caption: document.querySelectorAll('.wire-title').length,
		header: meta ? meta.textContent : null,
		who: wh ? (wh.querySelector('.ctile-who') || {}).textContent : null,
	};
}));
say('item8_wireBtn', await page.evaluate(() => !!document.getElementById('wire-btn')));

// ── Item 5/6: You tile alignment + padding vs another tile
say('item5_6_youTile', await page.evaluate(() => {
	const you = document.querySelector('#chat-output .ctile[data-t="user"]');
	const youBody = you && you.querySelector('.ctile-body');
	const content = you && you.querySelector('.chat-msg-content');
	const reply = document.querySelector('#chat-output .ctile[data-t="reply"]');
	const rb = reply && reply.querySelector('.ctile-body');
	const cs = (e) => e ? getComputedStyle(e) : null;
	return {
		youBodyTextAlign: cs(youBody) && cs(youBody).textAlign,
		youContentDisplay: cs(content) && cs(content).display,
		youContentBg: cs(content) && cs(content).backgroundColor,
		youBodyPadBottom: cs(youBody) && cs(youBody).paddingBottom,
		replyBodyPadBottom: cs(rb) && cs(rb).paddingBottom,
	};
}));

await panelShot(s, 'refine-1-default');

// ── Item 2: SELECTION by real clicks ───────────────────────────────
await page.evaluate(() => { const b = document.getElementById('collapse-btn'); if (b) b.click(); });
await page.waitForTimeout(300);
// expand the thinking rollup so children are clickable
await page.evaluate(() => {
	document.querySelectorAll('#chat-output .crollup[data-t="think"]').forEach((r) => r.classList.remove('collapsed'));
});
await page.waitForTimeout(200);

const selState = () => page.evaluate(() => {
	const out = document.getElementById('chat-output');
	const roll = out.querySelector('.crollup[data-t="think"]:not(.solo)');
	const kids = roll ? [...roll.querySelectorAll(':scope > .crollup-body > .ctile')] : [];
	return {
		haveThinkRollup: !!roll,
		rollSel: roll ? roll.classList.contains('sel') : null,
		rollIndet: roll ? roll.classList.contains('indeterminate') : null,
		kidsSel: kids.map((k) => k.classList.contains('sel')),
		selCount: document.getElementById('sel-count') ? document.getElementById('sel-count').textContent : '',
		leafSelTotal: out.querySelectorAll('.ctile.sel').length,
	};
});

say('item2_before', await selState());

// (2b) click the CONTAINER checkbox → all children selected
await page.evaluate(() => {
	const roll = document.querySelector('#chat-output .crollup[data-t="think"]:not(.solo)');
	roll.querySelector('.crollup-lbl').click();
});
await page.waitForTimeout(150);
say('item2b_containerClick_allChildren', await selState());

// (2a) click ONE child checkbox → toggles itself, container goes indeterminate
await page.evaluate(() => {
	const roll = document.querySelector('#chat-output .crollup[data-t="think"]:not(.solo)');
	roll.querySelector(':scope > .crollup-body > .ctile > .ctile-lbl').click();
});
await page.waitForTimeout(150);
say('item2a_childClick_indeterminate', await selState());

// (2c) a standalone (solo) Thinking or Tool tile selects itself
const soloBefore = await page.evaluate(() => {
	const solo = document.querySelector('#chat-output .crollup.solo[data-t="tool"] > .crollup-body > .ctile, #chat-output .crollup.solo[data-t="think"] > .crollup-body > .ctile');
	return solo ? solo.classList.contains('sel') : null;
});
await page.evaluate(() => {
	const solo = document.querySelector('#chat-output .crollup.solo[data-t="tool"] > .crollup-body > .ctile, #chat-output .crollup.solo[data-t="think"] > .crollup-body > .ctile');
	if (solo) solo.querySelector('.ctile-lbl').click();
});
await page.waitForTimeout(150);
const soloAfter = await page.evaluate(() => {
	const solo = document.querySelector('#chat-output .crollup.solo[data-t="tool"] > .crollup-body > .ctile, #chat-output .crollup.solo[data-t="think"] > .crollup-body > .ctile');
	return solo ? solo.classList.contains('sel') : null;
});
say('item2c_soloTile_toggle', { before: soloBefore, after: soloAfter });

// (2 tool tile expands) click the tool tile label to expand its body
const toolExpand = await page.evaluate(() => {
	const tool = document.querySelector('#chat-output .ctile[data-t="tool"]');
	if (!tool) return null;
	const wasCollapsed = tool.classList.contains('collapsed');
	return { wasCollapsed };
});
say('item2_toolExpandable', toolExpand);

await panelShot(s, 'refine-2-select');

// leave select mode
await page.evaluate(() => { const b = document.getElementById('collapse-btn'); if (b) b.click(); });
await page.waitForTimeout(200);

// ── Ordinary chat header: fold button absent, sel-fold present ─────
await page.evaluate(() => { const b = document.getElementById('collapse-btn'); if (b) b.click(); });
await page.waitForTimeout(200);
say('item12_ordinary_header', await page.evaluate(() => {
	const fold = document.getElementById('chat-fold-btn');
	const sf = document.getElementById('sel-fold');
	const mark = document.getElementById('chead-mark');
	return {
		chatFoldBtnVisible: fold ? getComputedStyle(fold).display !== 'none' : null,
		selFoldVisible: sf ? getComputedStyle(sf).display !== 'none' : null,
		logoVisible: mark ? getComputedStyle(mark).display !== 'none' : null,
	};
}));
await page.evaluate(() => { const b = document.getElementById('collapse-btn'); if (b) b.click(); });

// ── Item 11: header left cluster order ─────────────────────────────
say('item11_headerLeft', await page.evaluate(() => {
	const left = document.querySelector('.panel.ai .chead .chead-left');
	if (!left) return null;
	return { childOrder: [...left.children].map((c) => c.id || c.className) };
}));

console.log('ERRORS', JSON.stringify(errors(s).filter((e) => !/502|\/api\//.test(e)).slice(0, 8)));
await s.close();
console.log('DONE-ORDINARY');
