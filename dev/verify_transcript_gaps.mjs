// gateway: none
// verify_transcript_gaps.mjs — the gaps between the transcript's entries come from ONE rule,
// keyed on the two roles that meet, and the text sits at one depth in every tile (D-20261010-16).
//
// THE OWNER'S WORDS (2026-10-10): "Quiet tiles is my favourites, but depends on you being able
// to ensure consistent tile gaps". Until r547 four margin rules, a skin override, a flex gap and
// the Copy gutter each set part of the distance between two entries, and which one won depended
// on the pair, the skin and whether a group was open.
//
// THE RULE, which this file states on its own and the stylesheet must meet:
//
//   any entry → the next, inside a turn            4px
//   answer → note                                 12px
//   anything but your own message → your message  24px
//   the last entry → the Undo row or the composer 16px
//   the Undo row → the composer                    8px
//   a step → the next step in an open group        4px
//
//   No entry has a bottom margin, and its top margin IS the gap. Every entry's content
//   starts and ends PAD_Y inside it (8px; 12.5px where the label row is a 44px tap row, at
//   760px wide and under), and starts PAD_X (12px) from its left edge.
//
// WHAT IS MEASURED, in the page, on the real DOM: a seeded chat that holds every pair of
// roles (first message, group, lone step, answer, fold note, system note, Interrupted, a
// rating, a long and a short message, code, a list, an image, a group of 40), then an open
// group, a turn while it streams and after it lands, and the Undo row. Every theme and skin
// the app offers, at 390, 820 and 1440 wide, with a pointer and with touch, at rest and with
// each kind of tile under the pointer, in Chromium and WebKit.
//
//   eval "$(bash dev/world.sh N --up)" ; eval "$(bash dev/world.sh N --env)"
//   node dev/verify_transcript_gaps.mjs            both engines
//   node dev/verify_transcript_gaps.mjs --break    a stray margin put back: the gate must catch it
//   node dev/verify_transcript_gaps.mjs --dump     print every entry and what was measured
//   GAPS_SHOTS=<dir> ...                           phone and desktop pictures in Obsidian and Porcelain
import { open, chat, newChat, errors, signInAs, scratch } from './harness.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const BREAK = process.argv.includes('--break');
const DUMP  = process.argv.includes('--dump');
const SHOTS = process.env.GAPS_SHOTS || '';
const ENGINES = (process.env.GAPS_ENGINES || 'chromium,webkit').split(',');

if (!process.env.GAPS_ONE) {
	let fails = 0, passes = 0;
	for (const eng of ENGINES) {
		console.log('\n=== ' + eng + ' ===');
		const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
			env: { ...process.env, DAIMOND_BROWSER: eng, GAPS_ONE: '1' }, encoding: 'utf8', maxBuffer: 256 << 20 });
		const txt = (r.stdout || '') + (r.stderr || '');
		process.stdout.write(txt);
		const m = txt.match(/(\d+) passed, (\d+) failed\s*$/);
		if (m) { passes += +m[1]; fails += +m[2]; }
		if (!m || (r.status !== 0 && +m[2] === 0)) fails += 1;		// a run that died without its count
	}
	console.log('\nALL ENGINES: ' + passes + ' passed, ' + fails + ' failed');
	process.exit(fails ? 1 : 0);
}

const ENGINE = process.env.DAIMOND_BROWSER || 'chromium';

// ── The rule ──
const RULE = {
	inTurn: 4, aside: 12, turn: 24, head: 16, foot: 16, undo: 8,
	padY: 8, padYTap: 12.5, padX: 12,
	tapMax: 760,		// at this width and under, a tile's label row is a 44px tap row
	tol: 0.5,			// subpixel
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null && detail !== '' ? ' — ' + detail : ''));
};

// ── The fixture ──
const LONG = 'A long message, written to wrap over several lines at every width the gate measures, so that the height of a tile is seen to change nothing about the space around it. '.repeat(4).trim();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAIAAAAt/+nTAAAAKElEQVR4nO3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAfgZEIAABxYFLMgAAAABJRU5ErkJggg==';
const RICH = [
	'A paragraph before the list.',
	'',
	'- one item',
	'- a second item, somewhat longer than the first',
	'',
	'```js',
	'const gap = 4;',
	'const turn = 24;',
	'```',
	'',
	'![a picture](' + PNG + ')',
	'',
	LONG,
].join('\n');
const CODE_LAST = 'It ends on code.\n\n```\nlast line\n```';
const LIST_LAST = 'It ends on a list.\n\n1. first\n2. second';

let seq = 0;
const m = (role, extra) => { const i = seq++; return Object.assign({ role, mid: 'g' + i, ts: 1760000000000 + i * 1000, content: role + ' ' + i }, extra || {}); };
const tool = () => m('tool_log', { name: 'file_list', args: '{"path":"."}', outcome: 'done' });
const messages = [
	m('user', { content: 'Short.' }),												// the first message
	m('think_log'), tool(), m('think_log'),											// user → group
	m('assistant', { content: 'A short answer.' }),									// group → answer
	m('user', { content: LONG }),													// answer → user
	m('assistant', { content: RICH }),												// user → answer
	m('fold_log', { content: 'Earlier messages were folded.', folded: 4, kept: 2 }),	// answer → note
	m('user', { content: 'After a note.' }),										// note → user
	m('think_log'),																	// user → a lone step
	m('assistant', { content: CODE_LAST }),											// lone step → answer
	m('note_log', { content: 'A system note.' }),									// answer → note
	m('end_log', { how: 'stopped', why: 'user' }),									// note → Interrupted
	m('user', { content: 'After Interrupted.' }),									// Interrupted → user
	...Array.from({ length: 40 }, tool),											// a group of 40
	m('assistant', { content: LIST_LAST }),
	m('end_log', { how: 'stopped', why: 'user' }),									// answer → Interrupted
	m('user', { content: 'One line.' }),
	tool(), tool(),																	// a group with no answer after it
	m('user', { content: 'Asked again.' }),											// group → user
	m('assistant', { content: LONG }),
	m('error_log', { content: 'A fault line.' }),									// answer → fault
	m('user', { content: 'The last question.' }),
	m('assistant', { content: 'The last answer.' }),
];

// ── What the page reports ──
// Every visible child of the thread, in order, with its role, its box, its margins and the
// depth of its content; the steps of every open group; and the foot (Undo row, composer).
const MEASURE = () => {
	const out = document.getElementById('chat-output');
	const shown = (e) => e.getClientRects().length > 0 && e.getBoundingClientRect().height > 0;
	const has = (e, c) => e.classList.contains(c);
	const role = (e) => {
		if (has(e, 'chat-msg-user')) return 'user';
		if (has(e, 'chat-msg-assistant') && has(e, 'ctile')) return 'answer';
		if (has(e, 'crollup')) return e.dataset.t === 'work' ? 'work' : 'system';
		if (has(e, 'ctile')) return ({ think: 'work', tool: 'work', rating: 'rating', user: 'user', assistant: 'answer' })[e.dataset.t] || 'tile:' + e.dataset.t;
		if (has(e, 'chat-msg-compacted') || has(e, 'chat-msg-ended') || has(e, 'chat-msg-error')
			|| has(e, 'chat-msg-interjected') || has(e, 'chat-msg-empty')) return 'note';
		if (has(e, 'chat-msg-working') || has(e, 'chat-msg-assistant')) return 'said';
		if (has(e, 'chat-spinner') || has(e, 'chat-turn-indicator') || e.id === 'chat-queued' || has(e, 'chat-queued')) return 'live';
		return '?' + (e.id ? '#' + e.id : '') + '.' + e.className;
	};
	const px = (v) => parseFloat(v) || 0;
	const paints = (cs) => {
		const bg = cs.backgroundColor;
		if (bg && bg !== 'transparent' && !/rgba?\([^)]*,\s*0\)$/.test(bg) && !/\/\s*0\)$/.test(bg)) return true;
		return cs.backgroundImage && cs.backgroundImage !== 'none';
	};
	// The box a piece of content occupies: the content box of the nearest block that holds
	// it, or the whole box of an ancestor inside the entry that paints a ground of its own
	// (a code block, a nested tile), since that ground is what the eye takes as the content.
	const boxOf = (leaf, entry) => {
		let el = leaf.nodeType === 3 ? leaf.parentElement : leaf, block = null, painted = null;
		for (let n = el; n && n !== entry; n = n.parentElement) {
			const cs = getComputedStyle(n);
			if (!block && !/^inline($|-)/.test(cs.display) && cs.display !== 'contents') block = n;
			else if (!block && /^inline-/.test(cs.display)) block = n;
			if (block && paints(cs)) painted = n;
		}
		if (painted) { const r = painted.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left }; }
		if (!block) {		// text straight in the entry: its own line boxes
			const rg = document.createRange(); rg.selectNodeContents(leaf);
			const r = rg.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left };
		}
		const r = block.getBoundingClientRect(), cs = getComputedStyle(block);
		return {
			top: r.top + px(cs.borderTopWidth) + px(cs.paddingTop),
			bottom: r.bottom - px(cs.borderBottomWidth) - px(cs.paddingBottom),
			left: r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft),
		};
	};
	// The left edge of an SVG glyph's INK: its path geometry less half the round-capped stroke, in px.
	const inkLeft = (svg) => {
		const vb = svg.viewBox && svg.viewBox.baseVal, r = svg.getBoundingClientRect();
		if (!vb || !vb.width) return r.left;
		const bb = svg.getBBox(), sw = parseFloat(getComputedStyle(svg.querySelector('path') || svg).strokeWidth) || 0;
		return r.left + (bb.x - vb.x - sw / 2) * (r.width / vb.width);
	};
	const depth = (entry) => {
		const er = entry.getBoundingClientRect();
		let top = Infinity, bottom = -Infinity, left = Infinity, n = 0;
		const tw = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		for (let x = tw.nextNode(); x; x = tw.nextNode()) {
			let leaf = null;
			if (x.nodeType === 3) { if (x.nodeValue.trim() && shown(x.parentElement) && getComputedStyle(x.parentElement).visibility !== 'hidden') leaf = x; }
			else if (/^(IMG|SVG|CANVAS|VIDEO|INPUT|TEXTAREA|SELECT)$/i.test(x.tagName) && shown(x)) leaf = x;
			// A childless element that paints (a label's dot) is content: the eye reads it as the row's first mark.
			else if (!x.firstChild && shown(x) && paints(getComputedStyle(x))) leaf = x;
			if (!leaf) continue;
			const host = leaf.nodeType === 3 ? leaf.parentElement : leaf;
			// Controls that only show under the pointer, and anything laid over the flow, are not content.
			let skip = false;
			for (let p = host; p && p !== entry; p = p.parentElement) {
				const cs = getComputedStyle(p);
				if (cs.position === 'absolute' || cs.position === 'fixed' || cs.opacity === '0' || cs.visibility === 'hidden') { skip = true; break; }
			}
			if (skip) continue;
			const b = boxOf(leaf, entry);
			if (b.bottom <= b.top) continue;
			// The rating row's glyphs stand on the text column by their ink (lead ruling, 11 Oct), not their box.
			if (leaf.nodeType === 1 && /^svg$/i.test(leaf.tagName) && leaf.closest('.ctile-rate-row')) b.left = inkLeft(leaf);
			n++;
			if (b.top < top) { top = b.top; }
			if (b.bottom > bottom) bottom = b.bottom;
			if (b.left < left) left = b.left;
		}
		if (!n) return null;
		return { top: top - er.top, bottom: er.bottom - bottom, left: left - er.left };
	};
	const row = (e) => {
		const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
		return {
			role: role(e), top: r.top, bottom: r.bottom, left: r.left, right: r.right,
			mt: px(cs.marginTop), mb: px(cs.marginBottom),
			depth: depth(e),
			first: !e.previousElementSibling || ![...e.parentElement.children].slice(0, [...e.parentElement.children].indexOf(e)).some(shown),
			what: (e.className + ' ' + (e.textContent || '').trim().slice(0, 28)).replace(/\s+/g, ' '),
		};
	};
	const entries = [...out.children].filter(shown).map(row);
	const groups = [...out.querySelectorAll('.crollup:not(.collapsed):not(.solo) > .crollup-body, .crollup.collapsed.live:not(.solo) > .crollup-body')]
		.filter(shown).map((b) => ({
			steps: [...b.children].filter(shown).map(row),
			head: (() => { const l = b.parentElement.querySelector(':scope > .crollup-lbl'); return l && shown(l) ? l.getBoundingClientRect().bottom : null; })(),
			box: (() => { const r = b.parentElement.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left }; })(),
		}));
	const ocs = getComputedStyle(out), or = out.getBoundingClientRect();
	const undo = document.getElementById('daimond-undo');
	const undoUp = !!undo && shown(undo) && getComputedStyle(undo).opacity !== '0';
	// The foot is read to the next thing DRAWN: the composer area starts at whatever row
	// follows the thread (the Undo row, the attachments strip, a notice, the input bar).
	const nextShown = (e) => { for (let n = e.nextElementSibling; n; n = n.nextElementSibling) if (shown(n) && !/absolute|fixed/.test(getComputedStyle(n).position)) return n; return null; };		// in the flow: a screen-reader-only row is not a row
	const named = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, id: e.id ? '#' + e.id : '.' + String(e.className).split(' ')[0] }; };
	const after = nextShown(out), undoNext = undoUp ? nextShown(undo) : null;
	const txt = (el) => { if (!el) return null; const cs = getComputedStyle(el), r = el.getBoundingClientRect(); return r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft); };
	return {
		entries, groups,
		flow: ocs.display + '/' + ocs.flexDirection,
		outBottom: or.bottom, outPadB: px(ocs.paddingBottom), outPadL: px(ocs.paddingLeft), outLeft: or.left,
		scrolled: out.scrollHeight - out.clientHeight - out.scrollTop,
		overflows: out.scrollHeight > out.clientHeight + 1,
		// For --dump: every box in the thread whose height is not a whole pixel, innermost only.
		frac: [...out.querySelectorAll('*')].filter((e) => shown(e) && Math.abs(e.getBoundingClientRect().height % 1 - 0.5) < 0.49 && ![...e.children].some((c) => Math.abs(c.getBoundingClientRect().height % 1 - 0.5) < 0.49))
			.map((e) => e.tagName + '.' + String(e.className.baseVal != null ? e.className.baseVal : e.className).split(' ').slice(0, 2).join('.') + ' h ' + Math.round(e.getBoundingClientRect().height * 100) / 100 + ' lh ' + getComputedStyle(e).lineHeight + ' fs ' + getComputedStyle(e).fontSize)
			.filter((v, i, a) => a.indexOf(v) === i).slice(0, 12),
		outH: or.height, scrollTop: out.scrollTop,
		// The first entry, from the thread's own top edge wherever the thread is scrolled to.
		head: entries.length ? entries[0].top - or.top - px(ocs.borderTopWidth) + out.scrollTop : null,
		before: (() => { const f = [...out.children].findIndex(shown); return [...out.children].slice(0, Math.max(f, 0)).map((e) => e.tagName + (e.id ? '#' + e.id : '') + '.' + e.className); })(),
		undo: undoUp ? (() => { const r = undo.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, text: txt(undo) }; })() : null,
		after: after ? named(after) : null,
		undoNext: undoNext ? named(undoNext) : null,
		// A rating row's first glyph: the left edge of its INK (path geometry less half the round-capped
		// stroke, in px), against the answer text's column in the same tile.
		rateInk: [...out.querySelectorAll('.ctile-rate-row')].filter(shown).map((row) => {
			const svg = row.querySelector('.ctile-rate button svg'), body = row.closest('.ctile') && row.closest('.ctile').querySelector('.ctile-body');
			if (!svg || !body) return null;
			return { ink: inkLeft(svg), col: txt(body), what: 'rating row' };
		}).filter(Boolean),
	};
};

// ── The judgement: what the rule says each measure is ──
const TILE = { user: 1, answer: 1, work: 1, rating: 1 };
const gapWant = (a, b) => {
	if (b === 'user' && a !== 'user') return RULE.turn;
	if (a === 'answer' && b === 'note') return RULE.aside;
	return RULE.inTurn;
};
const near = (got, want) => Math.abs(got - want) <= RULE.tol;
const r1 = (v) => Math.round(v * 10) / 10;

const faults = [];		// { cfg, kind, where, want, got }
const tally = { gaps: 0, depths: 0, steps: 0 };
function judge(cfg, d, { width }) {
	const put = (kind, where, want, got, what) => { if (!near(got, want)) faults.push({ cfg, kind, where, want, got: r1(got), what }); };
	const padY = width <= RULE.tapMax ? RULE.padYTap : RULE.padY;
	if (d.flow !== 'flex/column') faults.push({ cfg, kind: 'flow', where: 'thread', want: 'flex/column', got: d.flow });
	const es = d.entries;
	for (let i = 0; i < es.length; i++) {
		const e = es[i];
		if (e.role[0] === '?' || e.role.startsWith('tile:')) faults.push({ cfg, kind: 'role', where: e.role, want: 'a known role', got: e.what });
		put('margin-bottom', e.role, 0, e.mb, e.what);
		if (i > 0) {
			const p = es[i - 1], want = gapWant(p.role, e.role);
			tally.gaps++;
			put('gap', p.role + '→' + e.role, want, e.top - p.bottom, e.what);
		}
		if (e.depth && e.role !== 'live') {
			tally.depths++;
			const y = TILE[e.role] ? padY : RULE.padY;
			put('depth-top', e.role, y, e.depth.top, e.what);
			put('depth-bottom', e.role, y, e.depth.bottom, e.what);
			put('depth-left', e.role, RULE.padX, e.depth.left, e.what);
		}
		put('edge-left', e.role, d.outLeft + d.outPadL, e.left, e.what);
	}
	for (const g of d.groups) {
		for (let i = 0; i < g.steps.length; i++) {
			const s = g.steps[i];
			tally.steps++;
			put('step margin-bottom', s.role, 0, s.mb, s.what);
			if (i > 0) put('step gap', 'step→step', RULE.inTurn, s.top - g.steps[i - 1].bottom, s.what);
			else if (g.head != null) put('step gap', 'group head→step', RULE.inTurn, s.top - g.head, s.what);
			if (i === g.steps.length - 1) put('step gap', 'step→group foot', 0, g.box.bottom - s.bottom, s.what);		// the last step's own depth is the group's
			if (s.depth) {
				put('step depth-top', s.role, padY, s.depth.top, s.what);
				put('step depth-bottom', s.role, padY, s.depth.bottom, s.what);
				put('step depth-left', s.role, RULE.padX, s.depth.left, s.what);
			}
			// A step's text stands on the same column as the group's own label.
			put('step edge-left', s.role, g.box.left, s.left, s.what);
		}
	}
	// The head: the first entry carries no gap of its own, so what stands over it is the thread's padding.
	if (es.length) put('head', 'thread top→first entry', RULE.head, d.head, es[0].what + (d.before.length ? ' after ' + d.before.join(' ') : ''));
	// The foot, read with the thread scrolled to its end. A thread shorter than its panel
	// has no foot to read: its last entry is not at the composer.
	if (es.length && d.overflows && d.scrolled <= 1) {
		const last = es[es.length - 1];
		if (!d.after) faults.push({ cfg, kind: 'foot', where: 'composer area', want: 'a row after the thread', got: 'none drawn' });
		else {
			// The foot is the thread's own padding under its last entry, up to the next row drawn. It is read
			// from those two edges and not from the last entry's box, because a scroll offset is a whole pixel
			// while the thread's height and its line boxes are not (621.3px; a 17px text line is 26.52px): at
			// the end of the scroll the engine leaves the last entry under a pixel off its place, by a different
			// fraction at every width. That residue is held under one pixel; anything put under the last entry
			// is a whole pixel or more, and its margin is read above.
			put('foot', 'last entry→' + (d.undo ? 'Undo row' : 'composer area'), RULE.foot, d.outPadB + d.after.top - d.outBottom, d.after.id);
			const snap = d.outBottom - d.outPadB - last.bottom;
			if (Math.abs(snap) >= 1) faults.push({ cfg, kind: 'foot', where: 'last entry→end of the thread', want: 'under 1px', got: r1(snap), what: last.what });
		}
		if (d.undo && d.after && d.after.id !== '#daimond-undo') faults.push({ cfg, kind: 'foot', where: 'Undo row', want: 'the first row after the thread', got: d.after.id });
		if (d.undo) {
			if (!d.undoNext) faults.push({ cfg, kind: 'foot', where: 'Undo row→composer', want: 'a row after the Undo row', got: 'none drawn' });
			else put('foot', 'Undo row→composer', RULE.undo, d.undoNext.top - d.undo.bottom, d.undoNext.id);
		}
		if (d.undo) {
			const tile = es.filter((e) => TILE[e.role]).pop();
			if (tile) put('undo-column', 'Undo text↔tile text', tile.left + RULE.padX, d.undo.text, 'undo');
		}
	}
	// The rating row's glyph INK stands on the answer text's column (lead ruling, 11 Oct), not its 16px box.
	for (const k of d.rateInk || []) put('rate-ink', 'rating glyph ink↔answer text', k.col, k.ink, k.what);
}

// ── The run ──
const PROFILE = scratch('pw', 'transcript-gaps-' + ENGINE);
const phoneOpts = ENGINE === 'chromium'
	? { isMobile: true, touch: true }
	: { touch: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const SESSIONS = [
	{ kind: 'pointer', opts: {},        sizes: [[1440, 900], [820, 1180]] },
	{ kind: 'touch',   opts: phoneOpts, sizes: [[390, 844], [820, 1180]] },
];
const STRAY = '#chat-output .ctile.chat-msg-assistant { margin-bottom: 3px; }';
const dumped = {};
const seenRoles = new Set(), seenPairs = new Set();

for (const S of SESSIONS) {
	const profile = PROFILE + '-' + S.kind;
	fs.rmSync(profile, { recursive: true, force: true });
	const s = await open({ name: 'transcript-gaps', profile, connect: true, defaults: true, ...S.opts });
	const { page } = s;
	const wait = (ms) => page.waitForTimeout(ms);
	const measure = async () => { await page.evaluate(() => { const o = document.getElementById('chat-output'); o.scrollTop = o.scrollHeight; }); await wait(120); return page.evaluate(MEASURE); };

	// Seed the chat through the store the app reads, then reload and open it.
	await page.evaluate((rec) => new Promise((res, rej) => {
		const req = indexedDB.open('daimond-chats');
		req.onsuccess = () => {
			const db = req.result, t = db.transaction('chats', 'readwrite');
			t.objectStore('chats').put(rec);
			t.oncomplete = () => res(); t.onerror = () => rej(t.error);
		};
		req.onerror = () => rej(req.error);
	}), {
		id: 'gaps1', name: 'Gap gate chat', model: 'mock/fast', provider: 'mock', status: 'active',
		promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
		prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
		updatedAt: Date.now() + 5000, messages,
	});
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
	await signInAs(s, 'transcript-gaps');
	await wait(800);
	const opened = await page.evaluate(() => {
		const hit = [...document.querySelectorAll('#session-list .session-box')].find((b) => (b.textContent || '').includes('Gap gate chat'));
		if (hit) { (hit.querySelector('.tile-label, .tile-when, button') || hit).click(); return true; }
		return false;
	});
	check(`${S.kind}: the seeded chat opens`, opened);
	await wait(1200);
	if (BREAK) await page.addStyleTag({ content: STRAY });

	const themes = await page.evaluate(() => Object.keys(DaimondTheme.inTone('light').concat(DaimondTheme.inTone('mid'), DaimondTheme.inTone('dark')).reduce((o, k) => (o[k] = 1, o), {})));
	const skins = await page.evaluate(() => DaimondSkin.list());
	check(`${S.kind}: the app offers its themes and skins`, themes.includes('obsidian') && themes.includes('porcelain') && skins.length > 0, themes.length + ' themes, skins ' + skins.join(','));

	for (const [w, h] of S.sizes) {
		await page.setViewportSize({ width: w, height: h });
		await wait(400);
		const measured = new Set();		// a skin the app will not wear lands on another: measure each pair once
		for (const skin of skins) for (const theme of themes) {
			await page.evaluate(([t, k]) => { DaimondTheme.set(t); DaimondSkin.set(k); }, [theme, skin]);
			const now = await page.evaluate(() => DaimondTheme.get() + '/' + DaimondSkin.get());
			if (measured.has(now)) continue;
			measured.add(now);
			const cfg = `${ENGINE} ${S.kind} ${w} ${now}` + (now.endsWith('/' + skin) ? '' : ` (asked ${skin})`);
			await wait(60);
			const d = await measure();
			judge(cfg + ' rest', d, { width: w });
			for (const e of d.entries) seenRoles.add(e.role);
			for (let i = 1; i < d.entries.length; i++) seenPairs.add(d.entries[i - 1].role + '→' + d.entries[i].role);
			if (DUMP && !dumped[S.kind + w]) {
				dumped[S.kind + w] = 1;
				console.log(`--- ${cfg}: flow ${d.flow}, pad ${d.outPadL}/${d.outPadB}`);
				d.entries.forEach((e, i) => console.log(`  ${String(i).padStart(2)} ${e.role.padEnd(7)} gap ${i ? r1(e.top - d.entries[i - 1].bottom) : '-'} mt ${e.mt} mb ${e.mb} depth ${e.depth ? [r1(e.depth.top), r1(e.depth.bottom), r1(e.depth.left)].join('/') : '-'} h ${r1(e.bottom - e.top)}  ${e.what.slice(0, 60)}`));
			}
			// Under the pointer: one tile of each kind, and the whole thread measured again.
			if (S.kind === 'pointer') {
				for (const sel of ['.ctile.chat-msg-user', '.ctile.chat-msg-assistant', '.crollup[data-t="work"]:not(.solo)', '.crollup.solo[data-t="work"]']) {
					const loc = page.locator('#chat-output > ' + sel).last();
					if (!(await loc.count())) { faults.push({ cfg, kind: 'fixture', where: sel, want: 'present', got: 'absent' }); continue; }
					await loc.scrollIntoViewIfNeeded().catch(() => {});
					await loc.hover({ force: true, position: { x: 30, y: 6 } }).catch(() => {});
					await wait(200);
					judge(cfg + ' hover ' + sel.replace(/^\.c\w+/, '').slice(0, 22), await page.evaluate(MEASURE), { width: w });
				}
				await page.mouse.move(2, 2);
			}
		}
		// The rest of the surfaces once per width, in the two named themes.
		for (const theme of ['obsidian', 'porcelain']) {
			await page.evaluate((t) => DaimondTheme.set(t), theme);
			const cfg = `${ENGINE} ${S.kind} ${w} ${theme}`;
			// An open group: the 40 steps, and the group of 3.
			const openN = await page.evaluate(() => {
				let n = 0;
				for (const g of document.querySelectorAll('#chat-output > .crollup.collapsed:not(.solo)[data-t="work"]')) { g.querySelector(':scope > .crollup-lbl').click(); n++; }
				return n;
			});
			await wait(250);
			let d = await measure();
			if (!d.groups.length || !d.groups.some((g) => g.steps.length === 40)) faults.push({ cfg, kind: 'fixture', where: 'open group of 40', want: 'present', got: `${openN} opened, ${d.groups.map((g) => g.steps.length)}` });
			judge(cfg + ' groups-open', d, { width: w });
			if (DUMP && theme === 'obsidian') {
				const g = d.groups[0];
				if (g) console.log(`--- ${cfg} open group: head→step ${r1(g.steps[0].top - g.head)}; ` + g.steps.slice(0, 4).map((x, i) => `gap ${i ? r1(x.top - g.steps[i - 1].bottom) : '-'} mt ${x.mt} mb ${x.mb} depth ${x.depth ? [r1(x.depth.top), r1(x.depth.bottom), r1(x.depth.left)].join('/') : '-'} left ${r1(x.left - g.box.left)}`).join(' | ') + `; foot ${r1(g.box.bottom - g.steps[g.steps.length - 1].bottom)}`);
			}
			// A step opened inside the group: its body sits at the same depth.
			await page.evaluate(() => { const st = document.querySelector('#chat-output > .crollup:not(.solo)[data-t="work"] > .crollup-body > .ctile > .ctile-lbl'); if (st) st.click(); });
			await wait(200);
			d = await measure();
			judge(cfg + ' step-open', d, { width: w });
			if (DUMP && theme === 'obsidian') console.log(`--- ${cfg} step-open: thread ${r1(d.outH)} high, scrolled to ${d.scrollTop}, ${r1(d.scrolled)} short of its end; boxes off the pixel: ${d.frac.join(' | ') || 'none'}`);
			await page.evaluate(() => { const st = document.querySelector('#chat-output > .crollup:not(.solo)[data-t="work"] > .crollup-body > .ctile > .ctile-lbl'); if (st) st.click(); });
			await page.evaluate(() => { for (const g of document.querySelectorAll('#chat-output > .crollup:not(.collapsed):not(.solo)[data-t="work"]')) g.querySelector(':scope > .crollup-lbl').click(); });
			await wait(200);
			// The Undo row, in front of the composer.
			await page.evaluate(() => DaimondUndo.able({ text: 'Copies kept of the files this turn changed: 2', ms: 120000, revert: () => {} }));
			await wait(350);
			d = await measure();
			if (!d.undo) faults.push({ cfg, kind: 'fixture', where: 'Undo row', want: 'up', got: 'not drawn' });
			judge(cfg + ' undo', d, { width: w });
			if (DUMP && theme === 'obsidian') console.log(`--- ${cfg} foot: last→undo ${d.undo ? r1(d.undo.top - d.entries[d.entries.length - 1].bottom) : '-'} after thread ${d.after && d.after.id} undo→next ${d.undo && d.undoNext ? r1(d.undoNext.top - d.undo.bottom) : '-'} next ${d.undoNext && d.undoNext.id} undo text x ${d.undo ? r1(d.undo.text) : '-'} tile text x ${r1(d.entries[d.entries.length - 1].left + RULE.padX)}`);
			if (SHOTS) {
				fs.mkdirSync(SHOTS, { recursive: true });
				if ((S.kind === 'touch' && w === 390) || (S.kind === 'pointer' && w === 1440)) {
					const tag = `${ENGINE}_${w === 390 ? 'phone' : 'desktop'}_${theme}`;
					await page.screenshot({ path: path.join(SHOTS, `transcript_${tag}_foot.png`), timeout: 8000 }).catch(() => {});
					await page.evaluate(() => { const o = document.getElementById('chat-output'); o.scrollTop = 0; });
					await wait(200);
					await page.screenshot({ path: path.join(SHOTS, `transcript_${tag}_top.png`), timeout: 8000 }).catch(() => {});
				}
			}
			await page.evaluate(() => DaimondUndo.flush());
			await wait(250);
		}
	}

	// A turn while it streams, and after it lands: the live drawing obeys the rule too.
	const [lw, lh] = S.sizes[0];
	await page.evaluate(() => DaimondTheme.set('obsidian'));
	const cfgL = `${ENGINE} ${S.kind} ${lw} obsidian`;
	// In a chat of its own: the seeded record is a drawing fixture, with no turn behind it to continue.
	// It is started at the session's widest size, where the rail that starts one is on screen.
	const [ww, wh] = S.sizes.reduce((a, b) => (b[0] > a[0] ? b : a));
	await page.setViewportSize({ width: ww, height: wh });
	await wait(300);
	await newChat(s).catch(async () => {
		// A touch layout keeps the rail off screen: press its button where it lies.
		await page.evaluate(() => document.getElementById('new-session-btn').click());
		await wait(500);
		await page.evaluate(() => { const b = document.querySelector('.tile-start'); if (b) b.click(); });
		await wait(600);
	});
	await wait(400);
	await page.setViewportSize({ width: lw, height: lh });
	await wait(300);
	const asks0 = await page.evaluate(() => document.querySelectorAll('#chat-output > .chat-msg-user').length);
	let turnOver = false, turnErr = '';
	const turn = chat(s, '@narrates 5000 I will read the workspace first.;;file_list {"path":"."};;Now once more, to be sure of every name in it.;;file_list {"path":"."};;All listed.', { timeout: 60000 })
		.catch((e) => { turnErr = String(e && e.message || e).slice(0, 200); }).finally(() => { turnOver = true; });
	// A reading is taken from the moment the question is drawn until the turn is over,
	// whatever the app draws in between: no selector for "live" to go stale.
	let live = 0;
	for (let i = 0; i < 200 && !turnOver; i++) {
		await wait(300);
		const asked = await page.evaluate(() => document.querySelectorAll('#chat-output > .chat-msg-user').length);
		if (asked <= asks0 || turnOver) continue;
		const d = await page.evaluate(MEASURE);
		live++;
		judge(cfgL + ' streaming#' + live, d, { width: lw });
		for (const e of d.entries) seenRoles.add(e.role);
		if (DUMP && live <= 3) console.log(`--- ${cfgL} streaming#${live}: ` + d.entries.slice(-5).map((e, i, a) => `${e.role} gap ${i ? r1(e.top - a[i - 1].bottom) : '·'} depth ${e.depth ? [r1(e.depth.top), r1(e.depth.bottom)].join('/') : '-'}`).join(' | '));
	}
	await turn;
	await wait(1200);
	check(`${S.kind}: the turn was measured while it streamed`, live > 0 && !turnErr, live + ' reading(s)' + (turnErr ? '; the turn failed: ' + turnErr : ''));
	judge(cfgL + ' landed', await measure(), { width: lw });

	// The instant before the first token, taken deterministically. `appendAssistantText` mounts the
	// answer tile with an empty `.chat-msg-content` and `renderAsst` fills it a frame later, so a
	// streaming reading lands on that instant only now and then (WebKit, 1 run in 3). The landed
	// answer is put back to it -- its body holding the empty wrapper, then nothing at all, and no rating row -- and
	// judged: the label's padding and an empty body's must not stack, or the text jumps as it lands.
	for (const how of ['wrapper', 'bare']) {
		const cfgE = `${cfgL} emptybody/${how}`;
		const held = await page.evaluate((how) => {
			const t = [...document.querySelectorAll('#chat-output > .ctile.chat-msg-assistant:not(.collapsed)')].pop();
			const b = t && t.querySelector(':scope > .ctile-body');
			if (!b) return false;
			// Nothing under the body yet either: the rating row comes when the turn ends.
			const after = [];
			for (let n = b.nextSibling; n; n = n.nextSibling) after.push(n);
			for (const n of after) n.remove();
			window.__gapsHeld = { t, b, html: b.innerHTML, after };
			b.innerHTML = how === 'wrapper' ? '<div class="chat-msg-content"></div>' : '';
			return true;
		}, how);
		if (!held) { faults.push({ cfg: cfgE, kind: 'fixture', where: 'answer tile', want: 'one landed', got: 'none' }); continue; }
		judge(cfgE, await measure(), { width: lw });
		await page.evaluate(() => { const h = window.__gapsHeld; h.b.innerHTML = h.html; for (const n of h.after) h.t.appendChild(n); delete window.__gapsHeld; });
	}
	check(`${S.kind}: an answer tile with an empty body was judged`, !faults.some((f) => f.kind === 'fixture' && / emptybody\//.test(f.cfg)), 'no landed answer to empty');

	// WebKit reports an observer that resizes what it observes as a page error; the app's layout settles on
	// the next frame and the base shows the same line (r546 QA-B B4). That exact message, and nothing else.
	const errs = errors(s).filter((e) => !/502|\/api\//.test(e) && !/^(pageerror: )?ResizeObserver loop completed with undelivered notifications\.?$/.test(e));
	check(`${S.kind}: nothing threw`, errs.length === 0, errs.slice(0, 2).join(' | '));
	await s.close();
}

// ── The fixture held every pair the rule names ──
for (const p of ['user→work', 'work→answer', 'user→answer', 'answer→user', 'answer→note', 'note→user', 'note→note', 'work→user'])
	check('fixture: the thread holds ' + p, seenPairs.has(p), [...seenPairs].join(' '));
const unknown = [...seenRoles].filter((r) => r[0] === '?' || r.startsWith('tile:'));
check('every entry in the thread has a role the rule knows', unknown.length === 0, unknown.slice(0, 4).join(' | '));

// ── The verdict ──
const by = {};
for (const f of faults) {
	const k = `${f.kind} ${f.where}: want ${f.want}, got ${f.got}`;
	(by[k] = by[k] || { n: 0, cfgs: new Set(), what: f.what }).n++;
	by[k].cfgs.add(f.cfg.split(' ').slice(1, 3).join(' '));
}
const kinds = Object.keys(by).sort((a, b) => by[b].n - by[a].n);
const outDir = scratch('transcript-gaps');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `faults-${ENGINE}${BREAK ? '-break' : ''}.json`);
fs.writeFileSync(outFile, JSON.stringify(faults, null, '\t'));
console.log(`\n${ENGINE}: measured ${tally.gaps} gaps, ${tally.depths} entry depths, ${tally.steps} group steps; ${faults.length} off the rule in ${kinds.length} kind(s) (all in ${outFile})`);
for (const k of kinds.slice(0, 40)) console.log(`  ${String(by[k].n).padStart(6)}×  ${k}   [${[...by[k].cfgs].join(', ')}]${by[k].what ? '  e.g. ' + String(by[k].what).slice(0, 50) : ''}`);
if (kinds.length > 40) console.log(`  … and ${kinds.length - 40} more kinds`);

if (BREAK) {
	const caught = faults.filter((f) => f.kind === 'gap' || f.kind === 'margin-bottom').length;
	check('--break: a stray margin under every answer is caught', caught > 0, `${caught} measure(s) off the rule with "${STRAY}" put back`);
} else {
	check('every gap, margin and depth in the transcript meets the one rule', faults.length === 0, faults.length ? `${faults.length} off the rule in ${kinds.length} kind(s)` : `${tally.gaps} gaps, ${tally.depths} depths, ${tally.steps} steps`);
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
