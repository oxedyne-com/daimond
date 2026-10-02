// gateway: none
// verify_no_left_bars.mjs -- D-20260929-03. No row, tile, card or quote in
// Daimond carries a left-only border or box-shadow accent, and every
// selected/current row in the app is drawn with the ONE selected treatment
// (fill only, no bar, no outline).
//
//   eval "$(bash dev/world.sh N --env)"
//   node dev/verify_no_left_bars.mjs
//
// Renders the known offending rows (the owner's own screenshot: a selected
// mail account and folder; plus the selected chat/diamond, a paused agent
// tile, an unread social item, a guide callout and a quoted reply) with the
// app's real classes in an injected stage, so the check exercises the
// SHIPPED stylesheet cascade rather than a copy of it, and asserts none of
// them draws a left-only accent.
//
// THE OUTLINE HALF (D-20260929-03, F4, decision D5; carry list for 5.2.9, G1).
// The left-bar half looks for lines on one side. This half looks for a line on
// all four: an outline round a button, chip, field, card or tile, which the
// quality bar (rule 1) rules out. It does not sample by name. It lists EVERY rule
// in www/css/*.css that gives an element a border on all four sides, builds an
// element for each selector in an injected stage, and reads the computed borders
// under the shipped cascade: Daylight, in Obsidian and Porcelain, on a computer
// (1440x900) and a phone (390x844, touch). A side draws a line when it is at
// least 1px wide, is not none or hidden, has some alpha, and differs from the
// element's own background. All four drawing is a FAIL.
//
//   node dev/verify_no_left_bars.mjs             both halves
//   node dev/verify_no_left_bars.mjs --bars      the left-bar half alone
//   node dev/verify_no_left_bars.mjs --outline   the outline half alone
//   NLB_OUT=<dir>                                also writes outline.json and outline.md there
//
// A selector the stage cannot build is NOT COVERED: printed with its text,
// counted, and never a pass. The stage is SYNTHETIC. It proves the CSS, not the
// data path: the Email message pane, Compose and the tracker cards, which the
// runtime gate never renders, are covered because their selectors are.
//
// RATING U2 (2026-10-01). The stage also takes the rated answer tile (its label
// bar, the lit and unlit arrows, the details control with `.on`, the phone row,
// the chip row with a pressed chip), the Rating tile (a line, its jump link, its
// score and the person's words) and the popup (`.rate-card`: the five steps, the
// tag chips, Details, a dimension, the words field, the where note and Withdraw),
// each with the classes the page gives it, in Obsidian and in Porcelain. A
// `data-nlb="label"` marks every element that is measured; a surface fails if any of
// them draws an accent.
import { open } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ev = (page, f, a) => page.evaluate(f, a).catch((e) => ({ err: e.message.split('\n')[0] }));

// ── Static half: every www/css/*.css file, for the surfaces the main app
// never loads at runtime (guide.css is only linked from the standalone
// www/guide/*.html pages, never from index.html). A left-only border or an
// inset box-shadow bar anywhere outside the allowlist fails the run. The
// allowlist is structural nesting/divider lines, not state on a row, tile,
// card or quote -- named so a new one added later has to be argued for, not
// merely missed. */
const ALLOW = new Set([
	'viewer.css:.fv-jkids',       // a JSON tree's own nesting depth guide, not a state
	'app.css:.astat-detail',      // an accordion's own nesting indent, not a state
	'app.css:.dview-btn + .dview-btn', // a toolbar button-group divider, not a row bar
	'app.css:.crollup.indeterminate > .crollup-lbl .ctile-chk::after', // a checkbox's mixed-state dash, a glyph
	'guide.css:.site-nav a',      // the standalone guide's nav underline, transparent at rest; the owner to confirm
]);
function staticScan() {
	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www', 'css');
	const bad = [];
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith('.css')) continue;
		const text = fs.readFileSync(path.join(dir, f), 'utf8');
		// One CSS rule block at a time: a selector list up to its `{...}` body.
		const re = /([^{}]+)\{([^{}]*)\}/g;
		let m;
		while ((m = re.exec(text))) {
			const [, sel, body] = m;
			const selTrim = sel.trim().split('\n').pop().trim();
			if (ALLOW.has(`${f}:${selTrim}`)) continue;
			// The start edge is the left one on a left-to-right page, so `border-inline-start`, `border-inline` and the 4-value `border-width`
			// are left borders too (5.2.9, G1: a scratch `border-inline-start: 3px` passed this half and only the stage caught it).
			const leftBorder = /border-(left|inline-start|inline)(-width)?\s*:\s*[1-9]|border-inline-width\s*:\s*[1-9]|border-width\s*:\s*0(px)?\s+0(px)?\s+0(px)?\s+[1-9]/.test(body)
				&& !/border-(left|inline-start|inline)\s*:\s*0/.test(body);
			// A sideline is a sideline on any side (5.2.6 review, F1): one-sided borders of 2px or more, in physical or logical form.
			const sideBar = /border-(right|top|bottom|inline-end|block|block-start|block-end)(-width)?\s*:\s*([2-9]|[1-9][0-9])/.test(body);
			const insetShadow = /box-shadow\s*:[^;]*inset\s+[1-9][\d.]*px\s+0(px)?\s+0(px)?/.test(body);
			// A bar drawn as a pseudo-element: absolutely placed on the start edge, 1 to 6px wide, filled, and running the height of its box.
			const edge = /(^|[;\s])(left|inset-inline-start)\s*:\s*0(px)?\s*(;|$)/.test(body) || /(^|[;\s])inset-inline\s*:\s*0(px)?\s+auto/.test(body);
			const full = /top\s*:\s*0(px)?\s*;[^}]*bottom\s*:\s*0(px)?|bottom\s*:\s*0(px)?\s*;[^}]*top\s*:\s*0(px)?|(^|[;\s])height\s*:\s*100%|inset-block\s*:\s*0/.test(body);
			const posBar = /::?(before|after)\b/.test(selTrim) && /position\s*:\s*(absolute|fixed)/.test(body) && edge && full
				&& /(^|[;\s])width\s*:\s*[1-6](px)?\s*(;|$)/.test(body) && /background(-color)?\s*:\s*(?!\s*(none|transparent))/.test(body);
			if (leftBorder || sideBar || insetShadow || posBar) bad.push(`${f} :: ${selTrim}`);
		}
	}
	return bad;
}

const SURFACES = {
	'mail account (selected)':  '<div class="mail-acct on" data-nlb>a@b.com</div>',
	'mail folder (selected)':   '<div class="mail-acct mail-folder on" data-nlb>Inbox</div>',
	'chat/diamond row (selected)': '<div class="session-box active" data-nlb><div class="session-box-name">x</div></div>',
	'paused agent tile':         '<div class="acard paused" data-nlb><div class="ah"><span class="pill paused">Paused</span></div></div>',
	'unread social item':        '<div class="feed-unread" data-nlb>x</div>',
	'out-link row':              '<div class="link-row link-row-out" data-nlb>x</div>',
	'in-link row':               '<div class="link-row link-row-in" data-nlb>x</div>',
	'guide note':                '<div class="fv-md"><div class="note" data-nlb>x</div></div>',
	'guide stop note':           '<div class="fv-md"><div class="note stop" data-nlb>x</div></div>',
	'quoted reply':              '<div class="post-quote" data-nlb>x</div>',
	'own message (post-out)':    '<div class="post-out" data-nlb>x</div>',
	'chat said (fold)':          '<div class="chat-msg said" data-nlb>x</div>',
	'pending card':              '<div class="pend-card prio-high" data-nlb>x</div>',
	'ask card':                  '<div class="ask-card" data-nlb>x</div>',
};

// ── Rating U2: the markup is what daimond.js builds (`rateGroup`, `rateDress`,
// `rateDressTags`, `appendRatingLine`, `openRatePopup`), reduced to its classes.
// `host: 'chat'` puts the stage inside `#chat-output`, because some rules (the chip
// row's padding, the selecting hide) are written against it.
const IC   = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const GRP  = (up, dn, more) => '<span class="ctile-rate" data-chrome="rate" role="group" aria-label="Rate this answer">'
	+ `<button type="button" class="ctile-rate-up" aria-pressed="${up}" data-nlb="up (${up ? 'lit' : 'unlit'})">${IC}</button>`
	+ `<button type="button" class="ctile-rate-down" aria-pressed="${dn}" data-nlb="down (${dn ? 'lit' : 'unlit'})">${IC}</button>`
	+ `<button type="button" class="ctile-rate-more${more ? ' on' : ''}" aria-haspopup="dialog" data-nlb="details (${more ? 'on' : 'off'})">${IC}</button></span>`;
const TIME = '<span class="ctile-time"><span class="ctile-time-full">02026-10-01 12:00:00</span><span class="ctile-time-short">26-10-01 12:00</span></span>';
const TILE = (type, who, meta, lblMid, body, after) => `<div class="ctile csel-unit${type === 'reply' ? ' chat-msg-assistant' : ''}" data-t="${type}" data-dir="${type === 'rating' ? 'local' : 'from'}" data-mid="nlb-${type}" data-nlb="${type} tile">`
	+ `<div class="ctile-lbl" data-nlb="${type} label bar"><span class="ctile-dot"></span><span class="ctile-who">${who}</span><span class="ctile-meta">${meta}</span><span class="ctile-grow"></span><span class="ctile-peek"></span>${lblMid}${TIME}`
	+ '<span class="ctile-ctl"><button type="button" class="ctile-copy">' + IC + '</button><span class="ctile-chk"></span></span></div>'
	+ `<div class="ctile-body"><div class="chat-msg-content">${body}</div></div>${after}</div>`;
const SEG  = (cls, label, words, on, attrs = '') => `<div class="tile-dlg-seg ${cls}" role="group" data-nlb="${label}"${attrs}>`
	+ words.map((w, i) => `<button type="button" class="tile-dlg-level" aria-pressed="${i === on}" data-nlb="${label}: ${w}${i === on ? ' (pressed)' : ''}">${w}</button>`).join('') + '</div>';
const U2 = {
	'rated answer tile (lit, phone row, chip row)': { host: 'chat', html:
		TILE('reply', 'Daimond', 'fast', GRP(true, false, true), '<p>An answer.</p>',
			'<div class="ctile-rate-row" data-chrome="rate" data-nlb="phone row">' + GRP(false, true, false) + '</div>'
			+ SEG('ctile-rate-tags', 'chip row', ['Wrong', 'Ignored', 'Long'], 0, ' data-chrome="rate"')) },
	'rated answer tile (up and details lit)': { host: 'chat', html:
		TILE('reply', 'Daimond', 'fast', GRP(true, false, true), '<p>An answer.</p>', '') },
	'rating tile': { host: 'chat', html:
		TILE('rating', 'You', '', '', '<p class="rate-line" data-nlb="rate line"><span class="rate-score" data-nlb="rate score">−2</span> on <button type="button" class="rate-jump-link" data-nlb="jump link">the answer of 10:04</button> · Long · <span class="rate-said" data-nlb="rate said">“Just the command.”</span></p>'
			+ '<p class="rate-line"><span class="rate-score">+1</span> on <button type="button" class="rate-jump-link">the answer of 10:06</button></p>', '') },
	'rate popup (.rate-card)': { host: 'body', html:
		'<div class="modal dlg tile-dlg"><div class="modal-card dlg-card tile-dlg-card rate-card" role="dialog" aria-modal="true" data-nlb="popup card">'
		+ '<div class="ui-head"><h2>Rate this answer</h2><button type="button" class="ui-close tile-dlg-done" data-nlb="popup close">' + IC + '</button></div>'
		+ '<div class="rate-body"><div class="tile-dlg-head">Score</div>' + SEG('rate-scale', 'five steps', ['Wrong', 'Poor', 'Fine', 'Good', 'Great'], 0)
		+ '<div class="rate-tagbox"><div class="tile-dlg-head">Tags</div>' + SEG('ctile-rate-tags', 'popup chips', ['Ignored', 'Long', 'Style'], 1) + '</div>'
		+ '<details class="tile-dlg-adv" open data-nlb="details box"><summary class="tile-dlg-head tile-dlg-adv-sum" data-nlb="details summary">Details</summary>'
		+ '<div class="tile-dlg-field rate-dim" data-nlb="dimension"><span class="tile-dlg-label">Correct</span>' + SEG('', 'dimension steps', ['0', '1', '2', '3', '4'], 1) + '</div>'
		+ '<label class="tile-dlg-label rate-said-label" for="nlb-said">Your words</label><textarea id="nlb-said" class="rate-said-input" rows="3" data-nlb="words field">Too long.</textarea></details>'
		+ '<div class="tile-dlg-note rate-where" data-nlb="where note">Goes to the model it was rated on.</div>'
		+ '<div class="tile-dlg-actions"><button type="button" class="rate-clear tile-keep" data-nlb="withdraw">Withdraw</button></div></div></div></div>' },
};

// Every `[data-nlb]` element in the stage is measured; the surface is bad if any one of them draws an accent.
const measure = (name) => {
	const stage = document.getElementById('nlb-stage');
	const one = (el) => {
		const cs = getComputedStyle(el);
		const bw = { l: parseFloat(cs.borderLeftWidth) || 0, t: parseFloat(cs.borderTopWidth) || 0, r: parseFloat(cs.borderRightWidth) || 0, b: parseFloat(cs.borderBottomWidth) || 0 };
		// A bar on any one side: some side 2px or more, and the four not equal.
		const leftOnly = (bw.l > 0 && bw.l !== bw.t) || (Math.max(bw.l, bw.t, bw.r, bw.b) >= 2 && !(bw.l === bw.t && bw.t === bw.r && bw.r === bw.b));
		// Chromium's computed order is "<color> <x> <y> <blur> <spread> inset".
		// A left bar is x != 0, y == 0, blur == 0, inset present.
		const m = /^\S+\(.*?\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+inset/.exec(cs.boxShadow || '');
		const shadowBar = !!m && parseFloat(m[1]) !== 0 && parseFloat(m[2]) === 0 && parseFloat(m[3]) === 0;
		return { label: el.getAttribute('data-nlb') || el.className, leftOnly, shadowBar, borderLeftWidth: bw.l, borderTopWidth: bw.t, borderRightWidth: bw.r, boxShadow: cs.boxShadow };
	};
	const all = [...stage.querySelectorAll('[data-nlb]')].map(one);
	const bad = all.filter((r) => r.leftOnly || r.shadowBar);
	return { name, n: all.length, bad };
};

// ═══════════════════════════════════════════════════════════════════════
// THE OUTLINE HALF
// ═══════════════════════════════════════════════════════════════════════

// The outline allow-list. A selector that really does draw a four-sided line, or
// cannot be built, and is meant to. `file:selector` as the rule is written (white
// space collapsed), and the reason. Every entry is approved by the lead and is
// listed in the QA target; none is added to make the run pass. Empty at B0.
const OUTLINE_ALLOW = new Map([
]);

// ── Reading the stylesheets ──────────────────────────────────────────────
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
function matchClose(s, i, open, close) {
	let d = 0, q = '';
	for (let j = i; j < s.length; j++) {
		const c = s[j];
		if (q) { if (c === '\\') j++; else if (c === q) q = ''; continue; }
		if (c === '"' || c === "'") { q = c; continue; }
		if (c === open) d++; else if (c === close && --d === 0) return j;
	}
	return s.length;
}
// Split on a separator at depth 0, outside strings.
function splitTop(s, sep) {
	const out = []; let d = 0, q = '', cur = '';
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) { cur += c; if (c === '\\') cur += s[++i] || ''; else if (c === q) q = ''; continue; }
		if (c === '"' || c === "'") { q = c; cur += c; continue; }
		if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--;
		if (d === 0 && c === sep) { out.push(cur); cur = ''; continue; }
		cur += c;
	}
	out.push(cur);
	return out.map((x) => x.trim()).filter(Boolean);
}
// Every style rule, with the at-rules it sits in. @keyframes and @font-face are not rules about elements.
function cssRules(text, file) {
	const src = stripComments(text), out = [];
	const lineAt = (i) => src.slice(0, i).split('\n').length;
	const walk = (from, to, at) => {
		let i = from;
		while (i < to) {
			let j = i, d = 0, q = '';
			for (; j < to; j++) {
				const c = src[j];
				if (q) { if (c === '\\') j++; else if (c === q) q = ''; continue; }
				if (c === '"' || c === "'") { q = c; continue; }
				if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--;
				else if (d === 0 && (c === '{' || c === ';')) break;
			}
			if (j >= to) break;
			if (src[j] === ';') { i = j + 1; continue; }
			const k = matchClose(src, j, '{', '}');
			const raw = src.slice(i, j), prelude = raw.trim(), body = src.slice(j + 1, k);
			if (prelude.startsWith('@')) {
				if (/^@(media|supports|container|layer|scope|document)\b/.test(prelude)) walk(j + 1, k, at.concat(prelude.replace(/\s+/g, ' ')));
			} else if (prelude) out.push({ file, line: lineAt(i + raw.length - raw.trimStart().length), sel: prelude.replace(/\s+/g, ' '), body, at });
			i = k + 1;
		}
	};
	walk(0, src.length, []);
	return out;
}
const LEN = /^(\.?\d[\d.]*)(px|em|rem|pt|ch|ex|vw|vh|%)?$/;
const BSTYLE = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/;
const BWIDTH = { thin: 1, medium: 3, thick: 5 };
const isClear = (c) => /^(transparent|none)$/i.test(c) || /^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(\.0+)?\s*\)$/i.test(c) || /^#0000(0000)?$/.test(c) || /^hsla?\([^)]*[,/]\s*0(\.0+)?\s*\)$/i.test(c);
// What a rule's declarations leave each side's border as; null is "not set here", 'v' is a var() we cannot read.
function borderSides(body) {
	const S = { t: { w: null, s: null, c: null }, r: { w: null, s: null, c: null }, b: { w: null, s: null, c: null }, l: { w: null, s: null, c: null } };
	const ks = ['t', 'r', 'b', 'l'];
	const tok = (v) => splitTop(v.replace(/\s+/g, ' '), ' ');
	const box = (v) => v.length === 1 ? [v[0], v[0], v[0], v[0]] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : v.length === 3 ? [v[0], v[1], v[2], v[1]] : v.slice(0, 4);
	const width = (v) => { if (v in BWIDTH) return BWIDTH[v]; const m = LEN.exec(v); return m ? parseFloat(m[1]) : 'v'; };
	const short = (k, v) => {
		const t = tok(v);
		if (/^(inherit|initial|unset|revert|revert-layer)$/.test(t[0] || '')) return;
		if (t.length === 1 && /^var\(/.test(t[0])) { S[k] = { w: 'v', s: 'v', c: 'v' }; return; }
		// A shorthand resets what it omits: no style is none, which draws nothing.
		const o = { w: 3, s: 'none', c: 'currentcolor' };
		for (const x of t) { if (BSTYLE.test(x)) o.s = x; else if (x in BWIDTH || LEN.test(x) || /^(calc|min|max|clamp)\(/.test(x) || /^var\(\s*--[\w-]*(width|bw|thick)/i.test(x)) o.w = width(x); else o.c = x; }
		S[k] = o;
	};
	for (const d of splitTop(body, ';')) {
		const m0 = /^([\w-]+)\s*:\s*([\s\S]*?)\s*(!important)?$/.exec(d); if (!m0) continue;
		const p = m0[1].toLowerCase(), v = m0[2].trim(); let m;
		if (p === 'border') ks.forEach((k) => short(k, v));
		else if ((m = /^border-(top|right|bottom|left)$/.exec(p))) short(m[1][0], v);
		else if (p === 'border-width') { const b = box(tok(v)); ks.forEach((k, i) => { S[k].w = width(b[i]); }); }
		else if (p === 'border-style') { const b = box(tok(v)); ks.forEach((k, i) => { S[k].s = b[i]; }); }
		else if (p === 'border-color') { const b = box(tok(v)); ks.forEach((k, i) => { S[k].c = b[i]; }); }
		// Logical forms, read as a left-to-right page does: inline is left and right, block is top and bottom (5.2.9, G1).
		else if ((m = /^border-(inline|block)(?:-(start|end))?(?:-(width|style|color))?$/.exec(p))) {
			const ax = m[1] === 'inline' ? ['l', 'r'] : ['t', 'b'], side = m[2] === 'start' ? [ax[0]] : m[2] === 'end' ? [ax[1]] : ax;
			if (!m[3]) side.forEach((k) => short(k, v));
			else { const vals = box(tok(v)); side.forEach((k, i) => { const x = m[2] ? vals[0] : vals[Math.min(i, vals.length - 1)]; S[k][m[3] === 'width' ? 'w' : m[3] === 'style' ? 's' : 'c'] = m[3] === 'width' ? width(x) : x; }); }
		}
		else if ((m = /^border-(top|right|bottom|left)-(width|style|color)$/.exec(p))) { const k = m[1][0]; S[k][m[2] === 'width' ? 'w' : m[2] === 'style' ? 's' : 'c'] = m[2] === 'width' ? width(v) : v; }
	}
	return S;
}
// Does the rule give all four sides a border it does not take away? `strict` is width and colour both.
function fourSided(body) {
	const S = borderSides(body); let strict = true;
	for (const k of ['t', 'r', 'b', 'l']) {
		const { w, s, c } = S[k];
		if (w === 0 || (s && /^(none|hidden)$/.test(s)) || (c && isClear(c))) return null;
		if (!((w != null && w !== 0) || (s != null && s !== 'none') || (c != null && !isClear(c)))) return null;
		if (!(w != null && w !== 0 && c != null && !isClear(c))) strict = false;
	}
	return { strict };
}
// Take `:not(...)` out: the stage leaves the thing out, which satisfies it.
function stripNot(s) {
	for (let m; (m = /:not\(/.exec(s));) { const o = m.index + m[0].length - 1; s = s.slice(0, m.index) + s.slice(matchClose(s, o, '(', ')') + 1); }
	return s;
}
const STATE = /:(hover|focus|focus-visible|focus-within|active|checked|disabled)\b/;
// `:is()` and `:where()` become one selector per alternative; null when an alternative cannot be spliced in as text.
function expandIs(sel, cap = 600) {
	const out = []; let bad = false;
	const go = (s) => {
		if (out.length > cap) { bad = true; return; }
		const m = /:(is|where)\(/.exec(s);
		if (!m) { out.push(s); return; }
		const o = m.index + m[0].length - 1, c = matchClose(s, o, '(', ')');
		const pre = s.slice(0, m.index), post = s.slice(c + 1);
		for (const a of splitTop(s.slice(o + 1, c), ',')) {
			if (/[\s>+~]/.test(a.replace(/\[[^\]]*\]|\([^)]*\)/g, '')) && (pre && !/[\s>+~]$/.test(pre) || post && !/^[\s>+~]/.test(post))) { bad = true; continue; }
			go(pre + a + post);
		}
	};
	go(sel);
	return bad ? null : out;
}
// The static half of the outline check: every four-sided rule, sorted into what the stage will measure.
function outlineCandidates() {
	const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www', 'css');
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.css') && f !== 'katex.min.css').sort();
	const rules = files.flatMap((f) => cssRules(fs.readFileSync(path.join(dir, f), 'utf8'), f));
	const four = rules.map((r) => ({ ...r, four: fourSided(r.body) })).filter((r) => r.four);
	const bySel = new Map();	// the expanded selector -> where it came from
	const state = [], printed = [], unreadable = [];
	for (const r of four) {
		if (r.at.some((a) => /\bprint\b/.test(a))) { printed.push(r); continue; }
		for (const s of splitTop(r.sel, ',')) {
			const E = expandIs(s);
			if (!E) { unreadable.push({ file: r.file, line: r.line, sel: s, why: 'a :is() or :where() alternative that cannot be spliced in as text' }); continue; }
			for (const e of E) {
				if (STATE.test(stripNot(e))) { state.push({ file: r.file, line: r.line, sel: s }); continue; }
				if (!bySel.has(e)) bySel.set(e, []);
				bySel.get(e).push({ file: r.file, line: r.line, sel: s, sheet: r.file });
			}
		}
	}
	return { files, rules: rules.length, four: four.length, strict: four.filter((r) => r.four.strict).length, bySel, state, printed, unreadable };
}

// ── The stage, in the page ───────────────────────────────────────────────
// Builds an element tree for each selector, measures the subject's computed
// borders, removes the tree. Everything is read from the browser's own cascade,
// and the build is checked by `matches()`, so a tree that does not satisfy the
// selector is NOT COVERED rather than a silent pass.
const OSTAGE = ({ items, css }) => {
	const out = [];
	const sheet = css ? Object.assign(document.createElement('style'), { textContent: css }) : null;
	if (sheet) document.head.appendChild(sheet);
	const cv = document.createElement('canvas'); cv.width = cv.height = 1;
	const cx = cv.getContext('2d', { willReadFrequently: true });
	const memo = new Map();
	const rgba = (c) => { let v = memo.get(c); if (v) return v; cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; v = [d[0], d[1], d[2], d[3]]; memo.set(c, v); return v; };
	const same = (a, b) => a.every((x, i) => Math.abs(x - b[i]) <= 2);
	const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
	// Which sides of this element (or pseudo-element) draw a line.
	const read = (el, pel) => {
		const s = getComputedStyle(el, pel || null);
		if (pel && /^::?(before|after)$/.test(pel) && (!s.content || /^(none|normal)$/.test(s.content))) return { gen: false };
		const bg = rgba(s.backgroundColor);
		const sd = SIDES.map((x) => { const w = parseFloat(s['border' + x + 'Width']) || 0, st = s['border' + x + 'Style'], col = s['border' + x + 'Color'], c = rgba(col); return { w, st, col, line: w >= 1 && st !== 'none' && st !== 'hidden' && c[3] > 0 && !same(c, bg) }; });
		return { gen: true, all: sd.every((x) => x.line), n: sd.filter((x) => x.line).length, side: sd[0], bg: s.backgroundColor };
	};
	// ── The selector reader
	const parseChain = (s) => {
		const parts = []; let comb = null, cur = '', d = 0, q = '';
		const push = () => { if (cur) { parts.push({ comb, c: cur }); cur = ''; } };
		for (let i = 0; i < s.length; i++) {
			const ch = s[i];
			if (q) { cur += ch; if (ch === '\\') cur += s[++i] || ''; else if (ch === q) q = ''; continue; }
			if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
			if (ch === '(' || ch === '[') { d++; cur += ch; continue; }
			if (ch === ')' || ch === ']') { d--; cur += ch; continue; }
			if (d === 0 && /[\s>+~]/.test(ch)) {
				let j = i, c = ' '; while (j < s.length && /[\s>+~]/.test(s[j])) { if (/[>+~]/.test(s[j])) c = s[j]; j++; }
				push(); comb = c; i = j - 1; continue;
			}
			cur += ch;
		}
		push();
		return parts;
	};
	const close = (c, i, o, e) => { let d = 0, q = ''; for (let j = i; j < c.length; j++) { const ch = c[j]; if (q) { if (ch === '\\') j++; else if (ch === q) q = ''; continue; } if (ch === '"' || ch === "'") { q = ch; continue; } if (ch === o) d++; else if (ch === e && --d === 0) return j; } return c.length; };
	const parseCompound = (c) => {
		const o = { tag: '', id: '', cls: [], attrs: [], pseudos: [], pel: '' };
		let i = 0; const m0 = /^(\*|[a-zA-Z][\w-]*)/.exec(c); if (m0) { o.tag = m0[1]; i = m0[0].length; }
		while (i < c.length) {
			const ch = c[i], rest = c.slice(i); let m;
			if (ch === '#' && (m = /^#([\w-]+)/.exec(rest))) { o.id = m[1]; i += m[0].length; }
			else if (ch === '.' && (m = /^\.([\w-]+)/.exec(rest))) { o.cls.push(m[1]); i += m[0].length; }
			else if (ch === '[') {
				const e = close(c, i, '[', ']'), inner = c.slice(i + 1, e);
				const a = /^\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))\s*(?:[is])?)?\s*$/.exec(inner); if (!a) return null;
				o.attrs.push({ n: a[1], op: a[2] || '', v: a[3] ?? a[4] ?? a[5] ?? '', raw: inner }); i = e + 1;
			}
			else if (ch === ':' && c[i + 1] === ':' && (m = /^::[\w-]+(\([^)]*\))?/.exec(rest))) { o.pel = m[0]; i += m[0].length; }
			else if (ch === ':' && (m = /^:(before|after|first-line|first-letter)\b/.exec(rest))) { o.pel = '::' + m[1]; i += m[0].length; }
			else if (ch === ':' && (m = /^:([\w-]+)/.exec(rest))) {
				let j = i + m[0].length, arg = null;
				if (c[j] === '(') { const e = close(c, j, '(', ')'); arg = c.slice(j + 1, e); j = e + 1; }
				o.pseudos.push({ n: m[1].toLowerCase(), a: arg }); i = j;
			}
			else return null;
		}
		return o;
	};
	const attrValue = (a) => a.op === '^=' ? a.v + 'x' : a.op === '$=' ? 'x' + a.v : a.op === '*=' ? 'x' + a.v + 'x' : a.v;
	// ── Building
	const stripNot = (s) => { for (let m; (m = /:not\(/.exec(s));) { const o = m.index + m[0].length - 1; s = s.slice(0, m.index) + s.slice(close(s, o, '(', ')') + 1); } return s; };
	const nth = (arg) => {	// the first index an `an+b` can take, at least 1
		const t = (arg || '').replace(/\s+/g, '').toLowerCase();
		if (t === 'odd') return 1; if (t === 'even') return 2;
		const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(t);
		if (m) { const a = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : 0; for (let n = 0; n < 50; n++) { const k = a * n + b; if (k >= 1) return k; } return null; }
		return /^\d+$/.test(t) ? parseInt(t, 10) : null;
	};
	const build = (sel, tagIfNone) => {
		const parts = parseChain(stripNot(sel)); if (!parts.length) return { nc: 'an empty selector' };
		const comps = parts.map((p) => parseCompound(p.c)); if (comps.some((c) => !c)) return { nc: 'syntax the stage does not read' };
		const undo = [], made = []; let prev = null, subject = null, pel = '';
		const fail = (why) => { undo.reverse().forEach((f) => f()); made.forEach((e) => e.remove()); return { nc: why }; };
		const attach = (el, comb, base, wrap) => {
			if (!base || base === document.documentElement) {
				if (comb === '>' && base) return false;
				// A subject that must be a first or only child gets a parent of its own.
				let into = document.body; if (wrap) { into = document.createElement('div'); document.body.appendChild(into); made.push(into); }
				into.appendChild(el); return true;
			}
			if (comb === '+' || comb === '~') { if (!base.parentNode) return false; base.parentNode.insertBefore(el, base.nextSibling); return true; }
			base.appendChild(el); return true;
		};
		const shape = (el, c) => {
			if (c.id) el.id = c.id;
			for (const k of c.cls) el.classList.add(k);
			for (const a of c.attrs) el.setAttribute(a.n, attrValue(a));
		};
		for (let k = 0; k < comps.length; k++) {
			const c = comps[k], last = k === comps.length - 1;
			const root = c.tag === 'html' || c.pseudos.some((p) => p.n === 'root'), body = c.tag === 'body';
			if (root || body) {
				// The page's own element: its conditions are met or set for the measure, and a mismatch means the rule is for another skin or look.
				const real = root ? document.documentElement : document.body;
				if (k > 0 && !(body && prev === document.documentElement)) return fail('html or body below the top of the selector');
				for (const cl of c.cls) if (!real.classList.contains(cl)) { real.classList.add(cl); undo.push(() => real.classList.remove(cl)); }
				if (c.id && real.id !== c.id) return fail('an id on html or body');
				for (const a of c.attrs) {
					const has = real.hasAttribute(a.n);
					if (has && !real.matches('[' + a.raw + ']')) { undo.reverse().forEach((f) => f()); made.forEach((e) => e.remove()); return { inactive: a.n + '=' + real.getAttribute(a.n) + ' where the rule wants ' + a.raw }; }
					if (!has) { real.setAttribute(a.n, attrValue(a)); undo.push(() => real.removeAttribute(a.n)); }
				}
				prev = real; if (last) subject = real; continue;
			}
			const hasType = c.attrs.some((a) => a.n === 'type' || a.n === 'placeholder'), isLink = c.attrs.some((a) => a.n === 'href') || c.pseudos.some((p) => /^(link|any-link)$/.test(p.n));
			const tag = c.tag && c.tag !== '*' ? c.tag : last ? (hasType ? 'input' : isLink ? 'a' : tagIfNone) : 'div';
			const el = document.createElement(tag); shape(el, c);
			for (const p of c.pseudos) {
				if (p.n === 'lang') el.setAttribute('lang', (p.a || 'en').replace(/["']/g, ''));
				else if (p.n === 'placeholder-shown') el.setAttribute('placeholder', 'x');
				else if (p.n === 'required') el.setAttribute('required', '');
				else if (p.n === 'visited') return fail(':visited cannot be matched by script');
				else if (/^(first-child|last-child|only-child|first-of-type|last-of-type|only-of-type|empty|not|enabled|link|any-link|defined|nth-child|nth-last-child|nth-of-type|nth-last-of-type|has|read-write|optional|indeterminate)$/.test(p.n)) { /* handled below or by structure */ }
				else return fail('the pseudo-class :' + p.n);
			}
			if (!attach(el, parts[k].comb, k === 0 ? null : prev, c.pseudos.some((p) => /^(first|last|only|nth)-/.test(p.n)))) return fail('a sibling or child with nothing to attach to');
			made.push(el);
			if (last) {
				subject = el;
				for (const p of c.pseudos) {
					if (/^nth-(last-)?(child|of-type)$/.test(p.n)) {
						const n = nth(p.a); if (n == null) return fail(':' + p.n + '(' + p.a + ') the stage cannot place');
						for (let i = 1; i < n; i++) { const f = document.createElement(p.n.endsWith('type') ? tag : 'div'); if (p.n.includes('last')) el.after(f); else el.before(f); made.push(f); }
					}
					if (p.n === 'has') {
						const m = /^\s*([>+~])?\s*([\s\S]*)$/.exec(p.a || ''); const rp = parseChain(m[2]); let base = el, comb0 = m[1] || ' ';
						for (let r = 0; r < rp.length; r++) {
							const rc = parseCompound(rp[r].c); if (!rc) return fail('syntax inside :has()');
							const e2 = document.createElement(rc.tag && rc.tag !== '*' ? rc.tag : 'div'); shape(e2, rc);
							const cb = r === 0 ? comb0 : rp[r].comb;
							if (cb === '+' || cb === '~') { if (!base.parentNode) return fail('a sibling inside :has()'); base.parentNode.insertBefore(e2, base.nextSibling); made.push(e2); }
							else { base.appendChild(e2); }
							base = e2;
						}
					}
				}
				pel = c.pel;
			}
			prev = el;
		}
		// The check that makes NOT COVERED honest: does the browser agree the subject is what the selector names?
		let ok = false;
		try { ok = subject.matches(sel.replace(/(::?(before|after|first-line|first-letter|placeholder|marker|selection|file-selector-button|-webkit-[\w-]+))(\([^)]*\))?\s*$/, '') || '*'); } catch (e) { return fail('the browser reads the selector differently: ' + e.message.slice(0, 60)); }
		if (!ok) return fail('the tree the stage built does not match the selector');
		return { subject, pel, made, undo, explicit: !!(comps[comps.length - 1].tag && comps[comps.length - 1].tag !== '*') };
	};
	const tear = (b) => { b.undo.reverse().forEach((f) => f()); b.made.forEach((e) => e.remove()); };
	// Self-test of the detector, so it cannot pass by being blind.
	const probe = (css, bg) => { const e = document.createElement('div'); e.style.cssText = css + ';background:' + (bg || 'rgb(10,20,30)'); document.body.appendChild(e); const r = read(e); e.remove(); return r.all; };
	const self = { line: probe('border:2px solid rgb(250,0,0)'), fill: probe('border:2px solid rgb(10,20,30)'), clear: probe('border:2px solid transparent'), three: probe('border:2px solid rgb(250,0,0);border-bottom:0'), faint: probe('border:2px solid rgb(250,0,0,0)') };
	const selfOk = self.line === true && self.fill === false && self.clear === false && self.three === false && self.faint === false;
	const PEL = /(::?(placeholder|marker|selection|file-selector-button|first-line|first-letter|before|after))$/;
	for (const it of items) {
		let inactive = null, nc = null, tags = [], seen = null;
		for (const tagIfNone of it.tags) {
			const b = build(it.sel, tagIfNone);
			if (b.inactive) { inactive = b.inactive; break; }
			if (b.nc) { nc = b.nc; break; }
			let pel = ''; const m = PEL.exec(it.sel); if (m) pel = m[1]; else if (b.pel) nc = 'the pseudo-element ' + b.pel + ' has no computed style to read';
			if (!nc) {
				let r; try { r = read(b.subject, pel); } catch (e) { r = null; nc = 'computed style unavailable: ' + e.message.slice(0, 50); }
				if (r && r.gen === false) { /* content: none, nothing drawn */ }
				else if (r && r.all) { tags.push(b.explicit ? '' : tagIfNone); if (!seen || !seen.all) seen = r; }
				else if (r && r.side && !seen) seen = r;
			}
			const stop = nc || b.explicit;
			tear(b);
			if (stop) break;
		}
		out.push({ id: it.id, inactive, nc, line: tags.length ? tags : null, n: seen ? seen.n : 0, bd: seen && seen.side ? seen.side.w + 'px ' + seen.side.st + ' ' + seen.side.col : '', bg: seen ? seen.bg : '' });
	}
	if (sheet) sheet.remove();
	return { out, selfOk, self };
};

// Run the stage once under the page's present look and theme.
async function runStage(page, rows, cfg, store) {
	const baseRows = rows.filter((r) => r.sheet === 'app');
	const extra = [...new Set(rows.filter((r) => r.sheet !== 'app').map((r) => r.sheet))];
	const groups = [[null, baseRows], ...extra.map((f) => [f, rows.filter((r) => r.sheet === f)])];
	for (const [file, G] of groups) {
		if (!G.length) continue;
		// A stylesheet the app page does not link (guide.css, legal.css) is added for its own selectors alone.
		const css = file ? await page.evaluate((f) => fetch('/css/' + f).then((r) => r.text()), file) : '';
		const r = await ev(page, OSTAGE, { items: G.map((g) => ({ id: g.id, sel: g.sel, tags: g.tags })), css });
		if (r.err) throw new Error('outline stage: ' + r.err);
		if (!r.selfOk) { console.log('  FAIL: the outline detector failed its own self-test ' + JSON.stringify(r.self)); process.exit(2); }
		for (const o of r.out) { const s = store.get(o.id); s.res.push({ cfg, ...o }); }
	}
}

async function outlineHalf(deskPage) {
	const C = outlineCandidates();
	// The sheets the app page links, and so the ones the stage already has.
	const linked = new Set(await ev(deskPage, () => [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => (l.getAttribute('href') || '').split('/').pop().split('?')[0])));
	const rows = [];
	for (const [sel, srcs] of C.bySel) {
		const sheets = [...new Set(srcs.map((x) => x.file))];
		const own = sheets.filter((f) => linked.has(f)), off = sheets.filter((f) => !linked.has(f));
		// A subject that names no tag is built as a div and as a button: the Daylight control reset gives a button a border that a div never has.
		const tags = ['div', 'button'];
		if (own.length) rows.push({ sel, srcs: srcs.filter((x) => linked.has(x.file)), sheet: 'app', tags });
		for (const f of off) rows.push({ sel, srcs: srcs.filter((x) => x.file === f), sheet: f, tags });
	}
	rows.forEach((r, i) => { r.id = i; r.res = []; });
	const store = new Map(rows.map((r) => [r.id, r]));
	const passes = [['desk', deskPage, null]];
	let phone = null;
	try {
		phone = await open({ name: 'alex', profile: `${process.env.DAIMOND_SCRATCH || '/tmp'}/nlb-profile-phone`, touch: true, connect: false, isMobile: true });
		await phone.page.setViewportSize({ width: 390, height: 844 });
		passes.push(['phone', phone.page, phone]);
	} catch (e) { console.log('  FAIL: the phone session did not open: ' + e.message.split('\n')[0]); process.exit(2); }
	for (const [name, pg] of passes) {
		await pg.waitForTimeout(800);
		for (const theme of ['obsidian', 'porcelain']) {
			await ev(pg, (t) => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set(t); }, theme);
			await pg.waitForTimeout(700);
			await runStage(pg, rows, name + '-' + theme, store);
		}
	}
	await phone.close();
	return { C, rows };
}

function outlineVerdict({ C, rows }) {
	const key = (r) => r.srcs.map((x) => x.file + ':' + x.sel);
	const allowed = (r) => { for (const k of key(r)) if (OUTLINE_ALLOW.has(k)) return OUTLINE_ALLOW.get(k); return null; };
	const live = [], nc = [], inactive = [], ok = [], okAllowed = [];
	for (const r of rows) {
		const lines = r.res.filter((x) => x.line);
		const ncs = r.res.filter((x) => x.nc), act = r.res.filter((x) => !x.inactive);
		if (lines.length) live.push({ r, lines }); else if (ncs.length) nc.push({ r, why: ncs[0].nc }); else if (!act.length) inactive.push({ r, why: r.res[0] && r.res[0].inactive }); else ok.push(r);
	}
	const lab = (r) => r.srcs.map((x) => x.file + ':' + x.line).filter((v, i, a) => a.indexOf(v) === i).join(' ');
	const lines = [];
	lines.push('outline half -- SYNTHETIC stage: an element is built from each rule\'s own selector and its computed borders are read under Daylight, in Obsidian and Porcelain, on a computer (1440x900) and a phone (390x844, touch). It proves the CSS, not the data path.');
	lines.push(`  ${C.files.length} stylesheets (katex.min.css excepted), ${C.rules} rules; ${C.four} set a four-sided border (${C.strict} with width and colour both); ${C.bySel.size} selectors after :is()/:where() are spliced`);
	lines.push(`  not measured: ${new Set(C.state.map((x) => x.file + ':' + x.line)).size} state rules (:hover :focus :focus-visible :focus-within :active :checked :disabled), ${new Set(C.printed.map((x) => x.file + ':' + x.line)).size} print rules`);
	lines.push(`  measured ${rows.length} stage rows; clean ${ok.length}; not active in any look here ${inactive.length}`);
	let fails = 0, ncs = 0, allow = 0;
	for (const { r, lines: L } of live.sort((a, b) => lab(a.r).localeCompare(lab(b.r)))) {
		const why = allowed(r);
		const tags = [...new Set(L.flatMap((x) => x.line))].filter(Boolean).join('+'), cfgs = L.length === 4 ? 'all four looks' : L.map((x) => x.cfg).join(' ');
		const x = L[0];
		if (why) { allow++; lines.push(`  allowed  ${lab(r)}  ${r.sel}  -- ${why}`); continue; }
		fails++;
		lines.push(`  FAIL (outline) ${lab(r)}  ${r.sel}  ${tags ? `[as ${tags}] ` : ''}${x.bd} on ${x.n} sides, background ${x.bg}  (${cfgs})`);
	}
	for (const { r, why } of nc.sort((a, b) => lab(a.r).localeCompare(lab(b.r)))) {
		const a = allowed(r);
		if (a) { allow++; lines.push(`  allowed  ${lab(r)}  ${r.sel}  -- ${a}`); continue; }
		ncs++;
		lines.push(`  NOT COVERED (outline) ${lab(r)}  ${r.sel}  -- ${why}`);
	}
	for (const x of C.unreadable) lines.push(`  NOT COVERED (outline) ${x.file}:${x.line}  ${x.sel}  -- ${x.why}`), ncs++;
	for (const { r, why } of inactive) lines.push(`  inactive ${lab(r)}  ${r.sel}  -- ${why}`);
	const bySheet = {}; for (const { r } of live) if (!allowed(r)) for (const f of new Set(r.srcs.map((x) => x.file))) bySheet[f] = (bySheet[f] || 0) + 1;
	if (fails) lines.push('  outlines by stylesheet: ' + Object.entries(bySheet).sort((a, b) => b[1] - a[1]).map(([f, n]) => f + ' ' + n).join(', '));
	lines.push(fails + ncs ? `FAIL: ${fails} outline(s) found, ${ncs} selector(s) NOT COVERED${allow ? `, ${allow} allowed` : ''}` : `PASS: no outlines${allow ? ` (${allow} allowed, each with a reason)` : ''}`);
	return { lines, fails: fails + ncs, outlines: fails, notCovered: ncs, allowed: allow, live: live.map(({ r, lines: L }) => ({ at: lab(r), sel: r.sel, tags: [...new Set(L.flatMap((x) => x.line))], bd: L[0].bd, cfgs: L.map((x) => x.cfg) })), nc: nc.map(({ r, why }) => ({ at: lab(r), sel: r.sel, why })) };
}

const s = await open({ name: 'alex', profile: `${process.env.DAIMOND_SCRATCH || '/tmp'}/nlb-profile` });
const page = s.page;
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(1000);
await ev(page, () => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set('obsidian'); });
await page.waitForTimeout(300);

const ARGS = process.argv.slice(2);
const DO_BARS = !ARGS.includes('--outline'), DO_OUTLINE = !ARGS.includes('--bars');
let fails = 0;
const staticBad = DO_BARS ? staticScan() : [];
for (const rule of staticBad) console.log('  FAIL (static) ' + rule);
fails += staticBad.length;

// One stage, moved to where the surface wants it: the body, or `#chat-output` (rules written against it).
const runSurface = async (name, html, host, tag) => {
	await ev(page, ([html, host]) => {
		let stage = document.getElementById('nlb-stage');
		if (!stage) { stage = document.createElement('div'); stage.id = 'nlb-stage'; }
		const to = host === 'chat' ? document.getElementById('chat-output') : document.body;
		if (stage.parentElement !== to) to.appendChild(stage);
		stage.innerHTML = html;
	}, [html, host]);
	await page.waitForTimeout(50);
	const r = await ev(page, measure, name);
	if (r.err) { fails++; console.log('  FAIL ' + tag + name + ' -- ' + r.err); return; }
	if (r.bad.length) fails++;
	console.log((r.bad.length ? '  FAIL ' : '  ok   ') + tag + name + (r.n > 1 ? ` (${r.n} measured)` : '')
		+ r.bad.map((b) => ` -- ${b.label}: borderLeftWidth=${b.borderLeftWidth} borderTopWidth=${b.borderTopWidth} borderRightWidth=${b.borderRightWidth} boxShadow=${b.boxShadow}`).join(''));
};
for (const [name, html] of DO_BARS ? Object.entries(SURFACES) : []) await runSurface(name, html, 'body', '');
// Rating U2, in both looks (the 5.2.6 gate reads Obsidian and Porcelain).
for (const look of DO_BARS ? ['obsidian', 'porcelain'] : []) {
	await ev(page, (l) => window.DaimondTheme.set(l), look);
	await page.waitForTimeout(300);
	for (const [name, u] of Object.entries(U2)) await runSurface(name, u.html, u.host, look + ': ');
}
if (DO_BARS) console.log(fails ? `FAIL: ${fails} left bar(s) found` : 'PASS: no left bars');
let outline = { fails: 0 };
if (DO_OUTLINE) {
	const O = await outlineHalf(page);
	outline = outlineVerdict(O);
	for (const l of outline.lines) console.log(l);
	if (process.env.NLB_OUT) {
		fs.mkdirSync(process.env.NLB_OUT, { recursive: true });
		fs.writeFileSync(path.join(process.env.NLB_OUT, 'outline.json'), JSON.stringify({ outlines: outline.outlines, notCovered: outline.notCovered, allowed: outline.allowed, live: outline.live, nc: outline.nc }, null, 1));
		fs.writeFileSync(path.join(process.env.NLB_OUT, 'outline.md'), outline.lines.join('\n') + '\n');
	}
}
await s.close();
process.exit(fails + outline.fails ? 1 : 0);
