// gateway: none
// verify_thinktools_group.mjs — a run of two or more adjacent Thinking and Tool tiles is
// ONE collapsed "Thinking and Tools" group, and a run of one is a plain tile (D-20261007-04).
//
// THE OWNER'S WORDS (2026-10-07): "I want consecutive Thinking and Tool tiles in the
// transcript to be grouped into a "Thinking and Tools" group tile. The transcript gets
// flooded with these sequences, we just need to tidy by folding them up."
//
// Until r538 a run rolled up only by the SAME type, so think, tool, think, tool never
// folded: each tile stood in a box of its own. Display only: the stored messages are the
// same either way, and the three arms below draw them three ways.
//
//   1. LIVE      a mock turn that reasons, calls a tool, reasons again, then answers.
//   2. RELOAD    the same chats after the page is reloaded and the chat opened again.
//   3. HAND-OFF  a seeded transcript shaped like the one a runner's turn leaves on the
//                asking device (`ranOn` set on the answer), drawn by the same
//                `renderHistory` the viewer uses. The two-device pairing itself is not
//                driven here; `repro_handoff_tiles.mjs` does that.
//
// WHAT IS ASSERTED, in the page, on the real DOM:
//   * no two adjacent think/tool `.ctile` render outside one `.crollup` (adjacent: nothing
//     but the queue box and the spinner between them in the thread);
//   * every group is collapsed, labelled with the translated "Thinking and Tools", and its
//     badge counts its tiles; a run of one is a `.solo` box with no label of its own;
//   * the label and the plural noun exist in all 8 locales.
//
//   eval "$(bash dev/world.sh N --up)" ; eval "$(bash dev/world.sh N --env)"
//   node dev/verify_thinktools_group.mjs
import { open, chat, newChat, shot, errors, signInAs } from './harness.mjs';
import { scratch } from './harness.mjs';
import fs from 'node:fs';

const PROFILE = scratch('pw', 'thinktools-group');
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

const s = await open({ name: 'thinktools-group', profile: PROFILE, connect: true, defaults: true });
const { page } = s;

// What the thread shows, read from the DOM: the top-level units in order, and the
// violations of the one rule. A "unit" is a rollup (grouped or solo) or a plain tile.
const read = () => page.evaluate(() => {
	const out = document.getElementById('chat-output');
	const leaf = (n) => n.matches && n.matches('.ctile[data-t="think"], .ctile[data-t="tool"]');
	const leaves = [...out.querySelectorAll('.ctile[data-t="think"], .ctile[data-t="tool"]')];
	// Two leaves are adjacent when no content element lies between them at the top level.
	const topOf = (el) => { while (el.parentNode !== out) el = el.parentNode; return el; };
	const furniture = (n) => n.id === 'chat-queued' || (n.classList && (n.classList.contains('chat-turn-indicator') || n.classList.contains('chat-spinner')));
	let ungrouped = 0;
	for (let i = 1; i < leaves.length; i++) {
		const a = topOf(leaves[i - 1]), b = topOf(leaves[i]);
		let between = false;
		for (let n = a.nextElementSibling; n && n !== b; n = n.nextElementSibling) {
			if (!furniture(n)) { between = true; break; }
		}
		if (between) continue;                       // something else sits between: not adjacent
		const pa = leaves[i - 1].closest('.crollup'), pb = leaves[i].closest('.crollup');
		if (!pa || pa !== pb) ungrouped++;
	}
	const units = [...out.children].filter((n) => n.classList
		&& (n.classList.contains('crollup') || n.classList.contains('ctile')) && n.id !== 'wire-head')
		.map((n) => {
			if (!n.classList.contains('crollup')) return n.dataset.t;
			const kids = n.querySelectorAll(':scope > .crollup-body > .ctile').length;
			return n.classList.contains('solo') ? 'plain:' + (n.querySelector('.ctile') || {dataset:{}}).dataset.t : 'group:' + kids;
		});
	const groups = [...out.querySelectorAll('.crollup:not(.solo)')].filter((g) => g.id !== 'wire-head').map((g) => ({
		label: (g.querySelector(':scope > .crollup-lbl .ctile-who') || {}).textContent || '',
		count: (g.querySelector(':scope > .crollup-lbl .crollup-count') || {}).textContent || '',
		noun:  (g.querySelector(':scope > .crollup-lbl .ctile-meta') || {}).textContent || '',
		kids:  g.querySelectorAll(':scope > .crollup-body > .ctile').length,
		collapsed: g.classList.contains('collapsed'),
	}));
	const solos = [...out.querySelectorAll('.crollup.solo')].filter((g) => g.id !== 'wire-head').map((g) => ({
		kids: g.querySelectorAll(':scope > .crollup-body > .ctile').length,
		lblShown: (() => { const l = g.querySelector(':scope > .crollup-lbl'); return !!l && getComputedStyle(l).display !== 'none'; })(),
	}));
	return { ungrouped, units, groups, solos, leaves: leaves.length };
});

const WANT = 'Thinking and Tools';
const wellFormed = (name, r) => {
	check(`${name}: no two adjacent Thinking/Tool tiles render outside one group`,
		r.ungrouped === 0, `${r.ungrouped} ungrouped pair(s); units ${JSON.stringify(r.units)}`);
	check(`${name}: every group is collapsed, counts its tiles and reads "${WANT}"`,
		r.groups.length > 0 && r.groups.every((g) => g.collapsed && g.label === WANT && Number(g.count) === g.kids && g.kids >= 2),
		JSON.stringify(r.groups));
	check(`${name}: a run of one is a plain tile (no label of its own)`,
		r.solos.every((g) => g.kids === 1 && !g.lblShown), JSON.stringify(r.solos));
};

// ── 1. LIVE ──
await newChat(s);
// reason → list → reason → answer: three adjacent working tiles.
await chat(s, '@rtr Let me list the workspace first.;;file_list {"path":"."};;Now I can summarise.');
await page.waitForTimeout(1500);
let r = await read();
wellFormed('1a live reason-tool-reason', r);
check('1a live: the three tiles are ONE group of 3',
	r.units.filter((u) => u === 'group:3').length === 1, JSON.stringify(r.units));
// two tools in one turn: a run of two, no reasoning between.
await chat(s, '@tools file_list {"path":"."} ;; file_list {"path":"."}');
await page.waitForTimeout(1500);
r = await read();
wellFormed('1b live two tools', r);
check('1b live: two tool calls fold into a group of 2',
	r.units.filter((u) => u === 'group:2').length >= 1, JSON.stringify(r.units));
// a single reasoning step with an answer: stands alone.
await chat(s, '@reason Just one thought.;;The answer.');
await page.waitForTimeout(1500);
r = await read();
wellFormed('1c live single think', r);
check('1c live: one lone Thinking tile is a plain tile',
	r.units.some((u) => u === 'plain:think'), JSON.stringify(r.units));
await shot(s, 'thinktools-live');
const liveUnits = r.units.join('|');

// ── 3 (seeded before the reload so one reload serves arms 2 and 3). A hand-off shaped
// transcript: the asking device draws what the runner streamed back.
const putRow = (rec) => page.evaluate((rec) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result, t = db.transaction('chats', 'readwrite');
		t.objectStore('chats').put(rec);
		t.oncomplete = () => res(); t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}), rec);
const m = (role, i, extra) => Object.assign({ role, mid: 'h' + i, ts: 1000 + i, content: role + i }, extra || {});
await putRow({
	id: 'hov1', name: 'Hand-off viewer chat', model: 'mock/fast', provider: 'mock', status: 'active',
	promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
	prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
	updatedAt: Date.now() + 5000,
	messages: [
		m('user', 0, { content: 'Tidy the notes.' }),
		m('think_log', 1), m('tool_log', 2, { name: 'file_list', args: '{"path":"."}', outcome: 'done' }),
		m('think_log', 3), m('tool_log', 4, { name: 'file_list', args: '{"path":"."}', outcome: 'done' }),
		m('tool_log', 5, { name: 'file_list', args: '{"path":"."}', outcome: 'done' }),
		m('assistant', 6, { content: 'Done, on the other device.', ranOn: 'peerdevice' }),
		m('user', 7, { content: 'And again?' }),
		m('think_log', 8),
		m('assistant', 9, { content: 'Once more.', ranOn: 'peerdevice' }),
	],
});

// ── 2. RELOAD ──
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'thinktools-group');
await page.waitForTimeout(800);
const openByName = (nm) => page.evaluate((nm) => {
	const boxes = [...document.querySelectorAll('#session-list .session-box')];
	const hit = boxes.find((b) => (b.textContent || '').includes(nm));
	if (hit) { (hit.querySelector('.tile-label, .tile-when, button') || hit).click(); return true; }
	return false;
}, nm);
const rail = await page.evaluate(() => [...document.querySelectorAll('#session-list .session-box')].map((b) => (b.textContent || '').trim().slice(0, 40)));
// The live chat is the one that is not the seeded one.
const liveName = rail.find((x) => !x.includes('Hand-off viewer chat'));
check('2 reload: the live chat is in the rail', !!liveName, JSON.stringify(rail));
if (liveName) {
	await openByName(liveName.slice(0, 20));
	await page.waitForTimeout(900);
	r = await read();
	wellFormed('2 reload', r);
	check('2 reload: the thread draws the same units as the live turn did',
		r.units.join('|') === liveUnits, `live ${liveUnits} / reload ${r.units.join('|')}`);
}

// ── 3. HAND-OFF viewer ──
check('3 hand-off: the seeded chat opens', await openByName('Hand-off viewer chat'));
await page.waitForTimeout(900);
r = await read();
wellFormed('3 hand-off', r);
check('3 hand-off: think,tool,think,tool,tool is one group of 5; the later lone think is plain',
	r.units.join('|').includes('group:5') && r.units.includes('plain:think'), r.units.join('|'));
await shot(s, 'thinktools-handoff');

// ── 4. EXPANDS IN PLACE, selection still works on the leaves ──
const exp = await page.evaluate(() => {
	const g = [...document.querySelectorAll('#chat-output .crollup:not(.solo)')].find((x) => x.id !== 'wire-head');
	if (!g) return null;
	const lbl = g.querySelector(':scope > .crollup-lbl');
	const before = g.getBoundingClientRect().height;
	lbl.click();
	const after = g.getBoundingClientRect().height;
	return { opened: !g.classList.contains('collapsed'), grew: after > before, kids: g.querySelectorAll(':scope > .crollup-body > .ctile').length };
});
check('4 a click on the group opens it in place to its tiles', !!exp && exp.opened && exp.grew && exp.kids === 5, JSON.stringify(exp));

// ── 5. THE LABEL EXISTS IN ALL 8 LOCALES ──
const locales = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];
const en = await page.evaluate(() => ({ w: DaimondI18n.t('chat.who_work'), n1: DaimondI18n.tn('chat.roll_work', 1, { n: 1 }), n5: DaimondI18n.tn('chat.roll_work', 5, { n: 5 }) }));
check(`5 en: label reads "${WANT}"`, en.w === WANT && !!en.n1 && !!en.n5 && en.n1 !== 'chat.roll_work', JSON.stringify(en));
for (const code of locales.slice(1)) {
	const got = await page.evaluate(async (c) => {
		await DaimondI18n.setLocale(c);
		return { w: DaimondI18n.t('chat.who_work'), n5: DaimondI18n.tn('chat.roll_work', 5, { n: 5 }), has: DaimondI18n.has('chat.who_work') };
	}, code);
	check(`5 ${code}: label and noun are translated`,
		got.has && got.w && got.w !== WANT && got.w !== 'chat.who_work' && got.n5 && got.n5 !== 'chat.roll_work', JSON.stringify(got));
}
await page.evaluate(() => DaimondI18n.setLocale('en'));

const errs = errors(s).filter((e) => !/502|\/api\//.test(e));
check('6 nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
