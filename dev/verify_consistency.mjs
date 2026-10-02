// gateway: live
// verify_consistency.mjs -- D-20260929-03. The same kind of control is drawn the
// same way everywhere, and that is MEASURED, not eyeballed: an eye sweep and an
// independent re-check both passed a "New diamond" and a "New chat" drawn two
// different ways, side by side in the rail.
//
// It drives the real app over every reachable surface, classifies each visible
// control and text element by ROLE (the table below, from DOM and class evidence),
// then compares the computed styles of every instance of a role, and the layout
// of every panel and row: left edges, sibling spacing, glyph-to-label gaps,
// clipping, overlap and label casing. Any difference not named in ALLOW, with a
// reason, fails the run.
//
//   eval "$(bash dev/world.sh N --env)"; bash dev/world.sh N --up
//   CONS_OUT=<dir> CONS_PROFILE=<dir> DAIMOND_MOCK_SCRIPT=<json> \
//     node dev/verify_consistency.mjs seed|desk|phone|webkit|report|all
//     node dev/verify_consistency.mjs tap                  the phone and WebKit passes and a report (seeds if there is no profile)
//     node dev/verify_consistency.mjs diff <runA> <runB> <cfgPrefix> [rootSel]
//
// `all` = seed, desk (1440×900) and phone (390×844) in Chromium, phone in WebKit,
// each in Obsidian and Porcelain, then `report`. `report` re-reads the saved
// captures, so the table can be corrected and re-run without a browser.
import { open, chat, newChat, signInAs } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT   = process.env.CONS_OUT || `${os.homedir()}/.cache/daimond/${process.env.RC_SLOT || 'solo'}/consistency`;
const PROF  = process.env.CONS_PROFILE || `${OUT}/profile`;
const MODE  = process.argv[2] || 'all';
const LOOKS = (process.env.CONS_LOOKS || 'obsidian,porcelain').split(',');
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('[cons]', ...a);

// ── The world's content ─────────────────────────────────────────────────
const DIAMONDS = ['Kitchen renovation', 'Thesis, chapter 4', 'Tax return 2026',
	'Kitchen renovation for the Leederville house, stage two: joinery, benchtop and splashback'];
const CRYSTAL = {
	title: 'Kitchen renovation', summary: 'New kitchen for the Leederville house. Budget $38,000, start in May.',
	sections: [{ heading: 'Scope', body: 'Joinery, benchtop, splashback, two new power points.' }],
	facts: [{ k: 'Budget', v: '$38,000 incl. GST' }, { k: 'Start', v: 'week of 4 May' }],
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#e8d9c4"/><text x="60" y="220" font-size="32" font-family="sans-serif">Kitchen plan</text></svg>';
const FILES = {
	'quotes/harlow.md': '# Harlow Joinery\n\n$14,200 incl. benchtop. Lead time 5 weeks.\n',
	'quotes/oakline.md': '# Oakline\n\n$12,950. Benchtop +$2,100.\n',
	'budget.csv': 'item,cost\njoinery,14200\nelectrical,3100\nsplashback,2400\n',
	'notes.md': '# Notes\n\nMeasure the window reveal again.\n\n- Check the splashback tile\n- Ask Priya about the GPO height\n',
	'plan.svg': SVG,
	'a-very-long-file-name-for-the-kitchen-renovation-final-v3.md': '# Long\n',
};
const Q1 = 'Compare the three joinery quotes and tell me which to take.';
const A1 = '**Take Harlow Joinery.**\n\n| Quote | Price | Lead time | Benchtop |\n|---|---|---|---|\n| Harlow | $14,200 | 5 weeks | included |\n| Oakline | $12,950 | 8 weeks | +$2,100 |\n| Brandt & Co | $15,800 | 4 weeks | included |\n\nOakline looks cheapest until the benchtop is added.';
const Q2 = 'Write a function that totals the budget file.';
const A2 = 'Here it is:\n\n```rust\nfn total(rows: &[(String, u32)]) -> u32 {\n    rows.iter().map(|(_, c)| c).sum()\n}\n```\n\n- It reads `budget.csv`\n- It returns cents\n\n1. Load\n2. Sum';
const SCRIPT = { [Q1]: A1, [Q2]: A2, 'Outline section 4.2 on sampling bias.': 'Three parts: the problem, the two corrections, and what they cost.', 'Flights to Hobart on 14 November.': 'Two direct options: 7:05 and 9:40.' };

// ── The in-page capture ─────────────────────────────────────────────────
// Every rendered control and text-bearing element under `rootSel`, with the
// evidence the classifier reads (tag, id, classes, ancestry, role, text) and the
// computed styles and geometry the comparison reads. Plus the page-level layout
// faults that need live ranges: clipping and text overlap.
const CAPTURE = ({ rootSel, surface, tap }) => {
	const root = rootSel ? document.querySelector(rootSel) : document.body;
	if (!root) return { missing: true, items: [], faults: [], tiles: [] };
	const cs = (e, p) => getComputedStyle(e, p);
	window.__ck = window.__ck || new WeakMap(); window.__cn = window.__cn || 1;
	const key = (e) => { if (!e) return 0; let k = window.__ck.get(e); if (!k) { k = window.__cn++; window.__ck.set(e, k); } return k; };
	const clsOf = (e) => (typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || '').trim().split(/\s+/).filter(Boolean);
	const sig = (e) => { let s = e.tagName.toLowerCase(); if (e.id) s += '#' + e.id; const c = clsOf(e).filter((x) => !/^sw-|^is-anim/.test(x)); if (c.length) s += '.' + c.join('.'); return s; };
	const vis = (e) => {
		if (!e.getClientRects().length) return false;
		const s = cs(e); if (s.visibility === 'hidden' || +s.opacity === 0) return false;
		const r = e.getBoundingClientRect(); return r.width >= 2 && r.height >= 2;
	};
	const inView = (r) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
	// Colour → the palette token(s) that resolve to it, so Obsidian and Porcelain compare by role.
	const probe = document.createElement('i'); probe.style.display = 'none'; document.body.appendChild(probe);
	const TOK = new Map();
	// `--term-fg`/`--term-bg`/`--term-cursor` are the terminal panel's own
	// names for `--text-primary`/`--bg-primary`/`--accent`, declared once on
	// `:root` so the panel can be themed on its own -- not a second identity
	// for the app-wide token. Left in, their shorter names won every tie in
	// `tok()` below and reported "the terminal's own colour" for ordinary
	// text and fills across the whole app.
	for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch (e) { continue; }
		const walk = (rs) => { for (const r of rs) { if (r.style) for (const p of r.style) if (p.startsWith('--') && !/^--term-(fg|bg|cursor)$/.test(p)) TOK.set(p, 1); if (r.cssRules) walk(r.cssRules); } }; walk(rules); }
	const rootCs = cs(document.documentElement); const tokOf = new Map();
	for (const t of TOK.keys()) {
		const v = rootCs.getPropertyValue(t).trim(); if (!v || /^(\d|var\(|calc|url|"|')/.test(v) && !/^#|rgb|hsl|color/.test(v)) continue;
		probe.style.color = ''; probe.style.color = v; if (!probe.style.color) continue;
		const c = cs(probe).color; if (!tokOf.has(c)) tokOf.set(c, []); tokOf.get(c).push(t);
	}
	probe.remove();
	const tok = (c) => { if (!c || c === 'rgba(0, 0, 0, 0)' || c === 'transparent') return 'none'; const t = tokOf.get(c); return t ? t.sort((a, b) => a.length - b.length)[0] : c; };
	const GLY = /^[▸▾▶▼►◂◀←-⇿✎✕×⟳↺⋯☰✓✔•◈⚙⊕‹›»«⤓⬇⬆↗●○★☆…✏✂⧉⎘⏸■□◆◇≡✖✗✘⚠ℹ❓❗+＋📎🔒🔓📄📁🗑⭐⚡]/u;
	// What a person can read on a control: text under a `display: none` label (the phone Help menu's
	// words, hidden on the desktop bar) is not a word on that control.
	const visText = (e) => { let t = ''; const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.nodeValue.trim() && n.parentElement && vis(n.parentElement) ? 1 : 3 }); for (let n; (n = w.nextNode());) t += n.nodeValue; return t; };
	const firstText = (e) => { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.nodeValue.trim() && n.parentElement && vis(n.parentElement) ? 1 : 3 }); return w.nextNode(); };
	const charRect = (n, i) => { const rg = document.createRange(); rg.setStart(n, i); rg.setEnd(n, i + 1); return rg.getBoundingClientRect(); };
	// D3: the first cell's left padding and the last cell's right padding are the table's edge, not its spacing. They are masked (null) at
	// capture so only the inner sides of a table's cells are compared, side by side; a lone cell has no inner side.
	const padSides = (e, s) => {
		if (e.tagName !== 'TH' && e.tagName !== 'TD') return null;
		const first = !e.previousElementSibling, last = !e.nextElementSibling;
		return [s.paddingTop, last ? null : s.paddingRight, s.paddingBottom, first ? null : s.paddingLeft];
	};
	const CTRL = 'button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], a[href], input:not([type=hidden]), select, textarea, summary';
	const all = [root, ...root.querySelectorAll('*')].filter((e) => !(e instanceof SVGElement && e.tagName !== 'svg') && vis(e));
	const items = [];
	for (const el of all) {
		const isCtrl = el.matches(CTRL);
		let own = ''; for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
		own = own.trim().replace(/\s+/g, ' ');
		const inCtrl = !isCtrl && el.parentElement && el.parentElement.closest(CTRL);
		if (!isCtrl && !own) continue;
		if (inCtrl && root.contains(inCtrl) && inCtrl !== root) continue;	// a control's own label is measured with the control
		const s = cs(el), r = el.getBoundingClientRect();
		const tn = isCtrl ? firstText(el) : [...el.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim());
		const lab = tn ? tn.parentElement : el; const ls = cs(lab);
		let text = isCtrl ? (el.value && /INPUT|TEXTAREA|SELECT/.test(el.tagName) ? '' : visText(el)) : own;
		text = text.trim().replace(/\s+/g, ' ');
		// Where the first real character starts, and the glyph or icon before it.
		let tx = null, tcy = null, glyph = null, ggap = null, icon = null;
		if (tn) {
			const v = tn.nodeValue; let i = v.search(/\S/);
			let c0 = charRect(tn, i);
			if (GLY.test(v.slice(i)) ) {
				const g = [...v.slice(i)][0]; let j = i + g.length; while (j < v.length && /\s/.test(v[j])) j++;
				if (j < v.length) { const c1 = charRect(tn, j); glyph = g; ggap = +(c1.left - c0.right).toFixed(1); c0 = c1; }
			}
			tx = Math.round(c0.left); tcy = Math.round((c0.top + c0.bottom) / 2);
			// A ::before glyph on the label's element.
			const b = cs(lab, '::before'); const bc = b.content && b.content !== 'none' && b.content !== 'normal' ? b.content.replace(/^"|"$/g, '') : '';
			if (!glyph && bc && GLY.test(bc)) {
				const cv = document.createElement('canvas').getContext('2d'); cv.font = `${b.fontWeight} ${b.fontSize} ${b.fontFamily}`;
				const lr = lab.getBoundingClientRect(); const pl = parseFloat(cs(lab).paddingLeft) + parseFloat(cs(lab).borderLeftWidth);
				const gw = b.display === 'inline-block' || b.display === 'block' ? parseFloat(b.width) || cv.measureText(bc).width : cv.measureText(bc).width;
				const gEnd = lr.left + pl + parseFloat(b.marginLeft || 0) + gw;
				if (Math.abs(c0.left - gEnd) < 40 && lab === (tn && tn.parentElement)) { glyph = '::' + bc.trim(); ggap = +(c0.left - gEnd).toFixed(1); }
			}
		}
		// A leading svg/img icon: its size and the gap to the label.
		const ic = [...el.querySelectorAll('svg, img')].find((x) => vis(x));
		if (ic) {
			const ir = ic.getBoundingClientRect();
			icon = { w: Math.round(ir.width), h: Math.round(ir.height), gap: tx != null && tx > ir.left ? +(tx - ir.right).toFixed(1) : null, dy: tcy != null ? Math.round((ir.top + ir.bottom) / 2 - tcy) : null };
		}
		// Clipped text: overflowing its own box without an ellipsis, or cut by a clipping ancestor.
		let clip = null;
		if (text && !/INPUT|TEXTAREA|SELECT/.test(el.tagName)) {
			const ox = s.overflowX, over = el.scrollWidth > el.clientWidth + 1 && /hidden|clip/.test(ox);
			if (over && s.textOverflow !== 'ellipsis' && ls.textOverflow !== 'ellipsis') clip = 'own ' + el.scrollWidth + '>' + el.clientWidth;
			else if (!over && tn) {
				const rg = document.createRange(); rg.selectNodeContents(tn); const tr = rg.getBoundingClientRect();
				for (let a = lab.parentElement; a && a !== document.body; a = a.parentElement) {
					const as = cs(a);
					// A one-line scrolling strip cuts its last item by design; its `overflow-y` computes to `auto`, so test it first.
					if (/auto|scroll/.test(as.overflowX) && /flex/.test(as.display) && as.flexWrap === 'nowrap') break;
					if (!/hidden|clip/.test(as.overflowX + as.overflowY)) continue;
					if (/auto|scroll/.test(as.overflowX)) break;
					const ar = a.getBoundingClientRect();
					if (tr.right > ar.right + 1.5 && tr.left < ar.right && as.textOverflow !== 'ellipsis' && ls.textOverflow !== 'ellipsis') clip = 'by ' + sig(a) + ' ' + Math.round(tr.right - ar.right) + 'px';
					break;
				}
			}
		}
		const anc = []; for (let a = el.parentElement, i = 0; a && a !== document.documentElement && i < 7; a = a.parentElement, i++) anc.push(sig(a));
		const panel = el.closest('.panel, .pop, .dlg-card, .modal-card, [role="dialog"], #admin, .pal-box, .msheet, .topbar, .chat-input-bar');
		items.push({
			k: key(el), pk: key(el.parentElement), panel: panel ? sig(panel) : 'page', surface,
			sig: sig(el), tag: el.tagName.toLowerCase(), id: el.id || '', cls: clsOf(el), anc,
			role: el.getAttribute('role') || '', type: el.getAttribute('type') || '', aria: el.getAttribute('aria-label') || '',
			foc: document.activeElement === el ? 1 : 0,
			sel: el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-current') ? 1 : 0,
			dis: el.disabled || el.getAttribute('aria-disabled') === 'true' ? 1 : 0,
			ctrl: isCtrl ? 1 : 0, text: text.slice(0, 80), lines: tn ? (() => { const rg = document.createRange(); rg.selectNodeContents(tn); return rg.getClientRects().length; })() : 0,
			r: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], re: Math.round(r.right), view: inView(r) ? 1 : 0,
			tx, tcy, glyph, ggap, icon, clip, ph: el.getAttribute('placeholder') || '',
			st: {
				ff: ls.fontFamily.split(',')[0].replace(/["']/g, '').trim(), fs: ls.fontSize, fw: ls.fontWeight, ls: ls.letterSpacing, tt: ls.textTransform,
				col: tok(ls.color), bg: tok(s.backgroundColor),
				bd: ['Top', 'Right', 'Bottom', 'Left'].map((x) => parseFloat(s['border' + x + 'Width']) && s['border' + x + 'Style'] !== 'none' && tok(s['border' + x + 'Color']) !== 'none' ? s['border' + x + 'Width'] + ' ' + tok(s['border' + x + 'Color']) : '0').join(' / '),
				rad: s.borderRadius, pad: s.padding, padS: padSides(el, s), h: Math.round(r.height), lh: ls.lineHeight, gap: s.columnGap, disp: s.display, ai: s.alignItems,
				td: ls.textDecorationLine, sh: s.boxShadow === 'none' ? 'none' : 'shadow', cur: s.cursor, ta: s.textAlign,
			},
		});
	}
	// Overlapping text: two text runs, neither inside the other, whose ink boxes cross.
	const faults = [];
	const runs = [];
	const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.nodeValue.trim() && n.parentElement && vis(n.parentElement) ? 1 : 3 });
	// A run's box cut to every clipping ancestor, so text scrolled out of its own
	// pane is not counted as lying over the pane beside it.
	const clipTo = (e, q) => {
		let l = q.left, t = q.top, r = q.right, b = q.bottom;
		for (let a = e; a && a !== document.documentElement; a = a.parentElement) {
			const as = cs(a); if (!/hidden|clip|auto|scroll/.test(as.overflowX + as.overflowY)) continue;
			const ar = a.getBoundingClientRect(); l = Math.max(l, ar.left); t = Math.max(t, ar.top); r = Math.min(r, ar.right); b = Math.min(b, ar.bottom);
		}
		return r - l > 1 && b - t > 1 ? { left: l, top: t, right: r, bottom: b, height: q.height } : null;
	};
	for (let n; (n = tw.nextNode()) && runs.length < 1500;) {
		const rg = document.createRange(); rg.selectNodeContents(n);
		for (const q0 of rg.getClientRects()) { if (!(q0.width > 1 && q0.height > 1 && inView(q0))) continue; const q = clipTo(n.parentElement, q0); if (q) runs.push({ n, q, e: n.parentElement, pre: n.parentElement.closest('pre, .code-block, svg') }); }
	}
	const hit = (el, x, y) => { const t = document.elementFromPoint(x, y); return t && (t === el || el.contains(t) || t.contains(el)); };
	for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
		const a = runs[i], b = runs[j]; if (a.n === b.n || a.pre && a.pre === b.pre) continue;
		const w = Math.min(a.q.right, b.q.right) - Math.max(a.q.left, b.q.left), h = Math.min(a.q.bottom, b.q.bottom) - Math.max(a.q.top, b.q.top);
		if (w > 2 && h > Math.min(a.q.height, b.q.height) * 0.35) {
			// Only if both are actually painted there (neither is under an overlay).
			const cx = (Math.max(a.q.left, b.q.left) + Math.min(a.q.right, b.q.right)) / 2, cy = (Math.max(a.q.top, b.q.top) + Math.min(a.q.bottom, b.q.bottom)) / 2;
			if (!hit(a.e, cx, cy) && !hit(b.e, cx, cy)) continue;
			// Each run must be painted somewhere of its own, or it is covered, not overlapped.
			const seen = (r) => hit(r.e, (r.q.left + r.q.right) / 2, (r.q.top + r.q.bottom) / 2);
			if (!seen(a) || !seen(b)) continue;
			const pa = a.e.closest('.panel, .pop, .dlg-card, [role="dialog"], #admin, .msheet'), pb = b.e.closest('.panel, .pop, .dlg-card, [role="dialog"], #admin, .msheet');
			if (pa !== pb) continue;	// one pane over another is stacking, not a fault inside either
			faults.push({ kind: 'overlap', a: sig(a.e) + ' "' + a.n.nodeValue.trim().slice(0, 24) + '"', b: sig(b.e) + ' "' + b.n.nodeValue.trim().slice(0, 24) + '"', where: [Math.round(cx), Math.round(cy)], panel: (a.e.closest('.panel, .pop, .dlg-card, [role="dialog"], #admin') || {}).id || 'page', surface });
		}
	}
	// Several repeated components' own rows, read straight from the DOM rather
	// than from `items` (layout_contract.md, gate extension): a diamond tile's
	// outer box is itself `role="button"` (a click opens it), so every
	// descendant that is not its own control -- the name, the model chip, a
	// tag that is only a span -- is swallowed by the "a control's own label is
	// measured with the control" rule above and never becomes its own item.
	// Structure needs every row whether or not it is a control, so it is read
	// directly here, once per instance of each component.
	const COMPONENTS = [
		['rating-tile', '.ctile[data-t="rating"]', [['head', '.ctile-lbl'], ['lines', '.rate-line']]],
		['rate-popup', '.rate-card', [['scale', '.rate-scale'], ['tags', '.ctile-rate-tags'], ['details', '.tile-dlg-adv'], ['where', '.rate-where']]],
		['tile', '.session-box', [
			['title', '.session-box-header'],
			['model', '.session-box-meta, .tile-active-top'],
			['chips', '.session-box-tags'],
			['meter', '.diamond-meter, .tile-meter'],
		]],
		// The stage head (V5): the title cluster and the tools must stay on one
		// line whenever the panel is wide enough, whatever the title says.
		['stage-head', '.panel:is(.ai, .web, .doc, .msg) > .chead', [
			['title', ':scope > .chead-left, :scope > .ctitle, :scope > .web-mode'],
			['tools', ':scope > .chead-right'],
		]],
		// The Workspace's mode row (V6): chips, then actions, then the status
		// message, each its own row whatever the locale's strings measure.
		// Matched on each part's own leaf class rather than the wrapper divs
		// V6 adds, so the same check reads the row bands on the code before
		// that fix too (proving the gate fails there) as well as after.
		['files-mode', '.files-mode', [
			['chips', '.files-mode-chip'],
			['acts', '.files-mode-btn, .files-mode-forget'],
			['msg', '.files-mode-msg'],
		]],
		// A device row (V10): name, copy and rename share the first line; the
		// nominate/stay controls and the id/when/build meta each keep their own.
		['device-row', '.device-row', [
			['name', '.device-name'],
			['copy', '.copy-id'],
			['rename', '.device-acts'],
			['ctl', '.device-ctl'],
			['meta', '.device-meta'],
		]],
		// L2: the file viewer's own name and its action row.
		['files-view-head', '.files-view-head', [
			['name', '.files-view-name'],
			['acts', 'span:not(.files-view-name)'],
		]],
		// L8: an interrupted turn's warning and its Continue button.
		['turn-interrupted', '.turn-interrupted', [
			['label', '.ti-label'],
			['go', '.ti-continue'],
		]],
	];
	const tiles = [];
	for (const [kind, containerSel, rowSel] of COMPONENTS) {
		for (const box of root.querySelectorAll(containerSel)) {
			if (!vis(box)) continue;
			const rows = {};
			for (const [part, selList] of rowSel) {
				let top = null, bot = null, left = null;
				for (const el of box.querySelectorAll(selList)) {
					if (!vis(el)) continue;
					const rr = el.getBoundingClientRect();
					if (top === null || rr.top < top) top = rr.top;
					if (bot === null || rr.bottom > bot) bot = rr.bottom;
					if (left === null || rr.left < left) left = rr.left;
				}
				// `left` (third) is the row's own left edge -- the meter's first
				// reading, since a row's children run left to right (V6 invariant,
				// D-20260929-03 r526 residual pass: the meter starts at the same x
				// in every tile, whatever the model name above it measures).
				if (top !== null) rows[part] = [Math.round(top), Math.round(bot), Math.round(left)];
			}
			if (Object.keys(rows).length >= 2) tiles.push({ kind, sig: sig(box), text: (box.textContent || '').trim().slice(0, 40), rows, surface, w: Math.round(box.getBoundingClientRect().width) });
		}
	}
	// F10, the tap cross (rule 8, decision D6). From the centre of the control's box cut to the viewport, walk out left, right, up
	// and down, sampling `elementFromPoint` at pixel centres (n + 0.5), while the sample lands on the control or inside it, to
	// 30px at most. Width = left + right + 1, height = up + down + 1. An interval of 44px always holds 44 pixel centres, so a
	// fractional centre cannot read 44x43. Three rules choose what is measured, none of them a name:
	//   (i)   a checkbox or radio in a <label>, or named by one with `for`, is measured as its label;
	//   (ii)  a control in a horizontal scroller is scrolled into view within it first, and put back after;
	//   (iii) while the surface's top overlay is open (a menu, a dialog, a sheet, the open drawer), only controls inside it are measured;
	//   (iv)  a control inside a container that clips its overflow and has collapsed to nothing is not on screen, and is not measured (a closed
	//         sheet is `height: 0; overflow: hidden`, parked under the footer chips with its close button still laid out);
	//   (v)   a control in a vertical scroller is scrolled to the centre of that scroller first, and put back after, as (ii) does for a
	//         horizontal one: a person scrolls a row into view to tap it, so a sticky head or foot at the scroller's edge is not what covers
	//         it. A control still covered at the centre is a real fault, and is measured as one;
	//   (vi)  a chat tile's title button (`.tile-label`) is measured as its tile, as a checkbox is as its label: it runs the tile's own action
	//         (the tile's click handler selects the chat too), so a tap anywhere on the tile does what a tap on the title does. A 33px title
	//         inside a taller tile is one target, and a 44px title would make every chat tile taller for nothing.
	//         (Also for (iii): the Admin drawer's overlay is its body, `.admin-body`, which covers the whole rail on a phone, status strip
	//         included; the `#admin` wrapper also holds the strip, which lies beneath it and is not tappable while Admin is open.)
	const taps = [];
	if (tap) {
		const OV = '.pop:not([hidden]), .dlg-card, .modal-card, [role="dialog"], .modal, #admin.admin-open .admin-body, .pal-box, .menu:not([hidden]), #msheet.open, body.drawer-open #panel-rail';
		const ovs = [...document.querySelectorAll(OV)].filter((e) => e.getClientRects().length && e.getBoundingClientRect().height > 10 && cs(e).visibility !== 'hidden');
		// The top overlay is the one that is on top where it can be seen: of those whose own centre lands inside them, the last in document order
		// (a popover inside a sheet beats the sheet). An open drawer over an open sheet is the top overlay, not the sheet beneath it.
		let topOv = null;
		for (const o of ovs) {
			const q = o.getBoundingClientRect();
			const h = document.elementFromPoint(Math.min(Math.max(q.left + q.width / 2, 0), innerWidth - 1), Math.min(Math.max(q.top + q.height / 2, 0), innerHeight - 1));
			if (h && o.contains(h)) topOv = o;
		}
		const done = new WeakSet();
		const collapsed = (e) => { for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
			const o = cs(a); if (o.overflowX === 'visible' && o.overflowY === 'visible') continue;
			const q = a.getBoundingClientRect(); if (q.width < 2 || q.height < 2) return true;
		} return false; };
		const ctrls = [...(root.matches(CTRL) ? [root] : []), ...root.querySelectorAll(CTRL)];
		for (const el0 of ctrls) {
			let el = el0;
			if (el0.tagName === 'INPUT' && /^(checkbox|radio)$/.test(el0.type)) {
				const lab = el0.closest('label') || (el0.id ? document.querySelector('label[for="' + CSS.escape(el0.id) + '"]') : null);
				if (lab) el = lab;
			}
			// (vi) a chat tile's title button is measured as its tile.
			if (el0.classList.contains('tile-label')) { const tl = el0.closest('.session-box'); if (tl) el = tl; }
			if (done.has(el) || !vis(el)) continue;
			// A control inside a closed disclosure (not its summary) is not on screen, whatever box its content kept: the crystal's
			// Edit and Raw read "covered by the body" for that reason.
			{ const dt = el.closest('details:not([open])'); if (dt && !(el.closest('summary') && el.closest('summary').parentElement === dt)) continue; }
			if (topOv && !topOv.contains(el)) continue;
			if (collapsed(el)) continue;
			if (cs(el).pointerEvents === 'none') continue;
			done.add(el);
			// (ii) bring the control into each horizontal scroller that holds it, and (v) to the centre of each vertical one.
			const back = [];
			for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
				const o = cs(a), hx = /auto|scroll/.test(o.overflowX) && a.scrollWidth > a.clientWidth + 1, hy = /auto|scroll/.test(o.overflowY) && a.scrollHeight > a.clientHeight + 1;
				if (!hx && !hy) continue;
				const q = el.getBoundingClientRect(), v = a.getBoundingClientRect();
				back.push([a, a.scrollLeft, a.scrollTop]);
				if (hx) { if (q.left < v.left) a.scrollLeft -= v.left - q.left; else if (q.right > v.right) a.scrollLeft += q.right - v.right; }
				if (hy) a.scrollTop += (q.top + q.height / 2) - (v.top + v.height / 2);
			}
			const r = el.getBoundingClientRect();
			const l = Math.max(r.left, 0), rr = Math.min(r.right, innerWidth), t = Math.max(r.top, 0), b = Math.min(r.bottom, innerHeight);
			if (rr - l >= 1 && b - t >= 1) {
				const nx = Math.floor((l + rr) / 2), ny = Math.floor((t + b) / 2);
				// null when the sample lands on the control or inside it; otherwise what is there instead.
				const lands = (x, y) => { const h = document.elementFromPoint(x + 0.5, y + 0.5); return !!h && (h === el || el.contains(h)) ? null : h || 'none'; };
				const c0 = lands(nx, ny);
				let hit = [0, 0], by = '';
				if (c0 === null) {
					const walk = (dx, dy) => { let n = 0; for (let i = 1; i <= 30; i++) { const x = nx + dx * i, y = ny + dy * i; if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || lands(x, y) !== null) break; n++; } return n; };
					hit = [walk(-1, 0) + walk(1, 0) + 1, walk(0, -1) + walk(0, 1) + 1];
				} else by = c0 === 'none' ? 'nothing' : sig(c0);
				const anc2 = []; for (let a = el.parentElement, i = 0; a && a !== document.documentElement && i < 7; a = a.parentElement, i++) anc2.push(sig(a));
				taps.push({
					surface, sig: sig(el), tag: el.tagName.toLowerCase(), id: el.id || '', cls: clsOf(el), anc: anc2, role: el.getAttribute('role') || '',
					type: el.getAttribute('type') || '', aria: el.getAttribute('aria-label') || '', ctrl: 1, ph: el.getAttribute('placeholder') || '',
					text: (/INPUT|TEXTAREA|SELECT/.test(el.tagName) ? '' : visText(el)).trim().replace(/\s+/g, ' ').slice(0, 80), icon: null,
					box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], hit, by,
				});
			}
			for (const [a, x, y] of back.reverse()) { a.scrollLeft = x; a.scrollTop = y; }
		}
	}
	return { missing: false, items, faults, tiles, tap: taps };
};

// ── Driving the app ─────────────────────────────────────────────────────
let page, CFG = '', CAP = null;
const wait = (ms) => page.waitForTimeout(ms);
const ev = (f, a) => page.evaluate(f, a).catch((e) => ({ err: e.message.split('\n')[0] }));
async function wear(theme) { await ev((t) => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set(t); }, theme); await wait(700); }
async function view(v) { await ev((x) => { try { window.DaimondView.set(x); } catch (e) {} }, v); await wait(400); }
async function quiet() {
	for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape').catch(() => {}); await wait(60); }
	await ev(() => { const c = document.getElementById('admin-close'); if (c && c.offsetParent) c.click(); document.querySelectorAll('.pop:not([hidden])').forEach((e) => { e.hidden = true; }); });
	await wait(150);
}
async function panels(show) {
	await ev((show) => { const P = window.DaimondPanels; const ids = P.panels().map((p) => p.id);
		for (const id of ids) if (!show.includes(id)) { try { P.hide(id); } catch (e) {} }
		for (const id of show) { try { P.show(id); } catch (e) {} } try { P.reflow(); } catch (e) {} }, show);
	await wait(600);
}
const click = (sel) => ev((q) => { const b = [...document.querySelectorAll(q)].find((e) => e.getClientRects().length) || document.querySelector(q); if (!b) return false; b.click(); return true; }, sel);
const clickText = (sel, re) => ev(({ sel, re }) => { const r = new RegExp(re, 'i');
	const b = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length && r.test((e.textContent || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.getAttribute('aria-label') || '')));
	if (!b) return false; b.click(); return true; }, { sel, re });
async function mainChat() {
	await ev(() => { const t = [...document.querySelectorAll('#session-list .chat-box')].find((b) => /joinery|function/i.test(b.textContent));
		const l = t && t.querySelector('.tile-label'); if (l) l.click(); else if (t) t.click(); });
	await wait(900);
}
async function topOverlay() {
	return ev(() => {
		const c = [...document.querySelectorAll('.pop:not([hidden]), .dlg-card, .modal-card, [role="dialog"], .modal, #admin.admin-open, .pal-box, .menu:not([hidden]), .msheet:not([hidden])')]
			.filter((e) => e.getClientRects().length && e.getBoundingClientRect().height > 10 && getComputedStyle(e).visibility !== 'hidden');
		const e = c[c.length - 1]; if (!e) return null;
		if (!e.id) e.id = 'cons-ov-' + Math.random().toString(36).slice(2, 7);
		return '#' + e.id;
	});
}
// Where the pointer rests between surfaces: a phone has no resting pointer, so the corner; a computer's rests at the page's top-left,
// which hovers no control at 1440×900 (the check in `grab` says so on every surface it parks over).
const PARK_PHONE = [0, 0], PARK_DESK = [5, 5];
async function grab(name, rootSel, keep) {
	if (rootSel === undefined) rootSel = null;
	const surface = `${CFG}/${name}`;
	// Playwright's mouse stays where the last click landed (a touch context still dispatches mouse events), so whatever a later layout moves
	// under that point reads `:hover`, and the gate takes the hover fill for the resting style. `keep` leaves the pointer for the one
	// surface that is about hover.
	if (!keep) {
		const ph = /^(phone|webkit)-/.test(CFG);
		await page.mouse.move(...(ph ? PARK_PHONE : PARK_DESK)).catch(() => {});
		await wait(ph ? 80 : 200);	// a computer's pointer leaves a control that fades its fill over 150 ms
		const hv = await ev(() => [...document.querySelectorAll(':hover')].filter((e) => /^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL)$/.test(e.tagName) || getComputedStyle(e).cursor === 'pointer').map((e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '')));
		if (hv && hv.length) log('PARK HOVERS', surface, hv.join(' '));
	}
	const a = await ev(CAPTURE, { rootSel, surface, tap: /^(phone|webkit)-/.test(CFG) });
	if (a.err) { log('capture fail', surface, a.err); return; }
	if (a.missing) { log('MISSING', surface, rootSel); CAP.missing.push(surface); return; }
	CAP.items.push(...a.items); CAP.faults.push(...a.faults); CAP.tiles.push(...a.tiles); CAP.tap.push(...(a.tap || [])); CAP.surfaces.push(surface);
	if (process.env.CONS_SHOTS) await page.screenshot({ path: `${OUT}/shot_${surface.replace(/\W+/g, '_')}.png`, animations: 'disabled' }).catch(() => {});
	log('surface', surface, a.items.length);
}
async function overlay(name, opener) {
	await quiet();
	const ok = typeof opener === 'function' ? await opener() : await click(opener);
	if (!ok || ok.err) { log('no opener', name); CAP.missing.push(`${CFG}/${name}`); return false; }
	await wait(600);
	const ov = await topOverlay();
	await grab(name, ov);
	return ov;
}

/// U2's own surfaces on the main chat: the chip row under a down tap on the last answer (taken back and committed afterwards,
/// so the chat is as seeded), then the popup on the first answer, collapsed and with Details open. `pre` is '' or 'p_'.
async function rateSurfaces(pre) {
	const pick = (first) => ev((first) => { const t = [...document.querySelectorAll('#chat-output .ctile.chat-msg-assistant[data-mid]')].filter((e) => e.querySelector('.ctile-rate')); const x = first ? t[0] : t[t.length - 1]; return x ? x.dataset.mid : ''; }, first);
	const vis = (mid, cls) => page.locator(`#chat-output .ctile[data-mid="${mid}"] .${cls} >> visible=true`).first();
	const last = await pick(false), first = await pick(true);
	const into = (mid) => ev((m) => { const t = document.querySelector(`#chat-output .ctile[data-mid="${m}"]`); if (t) t.scrollIntoView({ block: 'center' }); }, mid);
	if (!last || !first) { CAP.missing.push(`${CFG}/${pre}rate_tags`, `${CFG}/${pre}dlg_rate`); return; }
	await into(last); await wait(300);
	await vis(last, 'ctile-rate-down').click({ force: true }); await wait(400);
	await grab(pre + 'rate_tags', '#chat-output');
	await vis(last, 'ctile-rate-down').click({ force: true }); await wait(300);
	await ev(async () => { await window.DaimondRatingUI.flush(String(window.DaimondAttach.focus().id)); });
	await into(first); await wait(300);
	const ov = await overlay(pre + 'dlg_rate', async () => { await vis(first, 'ctile-rate-more').click({ force: true }); return true; });
	if (ov) {
		await ev(() => { const d = document.querySelector('.rate-card details'); if (d) d.open = true; }); await wait(400);
		await grab(pre + 'dlg_rate_details', await topOverlay());
	}
	await quiet();
}

// ── Surfaces: the computer ──────────────────────────────────────────────
async function deskSurfaces() {
	await quiet(); await mainChat();
	await panels(['rail', 'ai', 'work']);
	await grab('page_chat');
	await ev(() => { const o = document.getElementById('chat-output'); if (o) o.scrollTop = 0; }); await wait(300);
	await grab('page_chat_top', '#chat-output');
	await ev(() => { const b = document.getElementById('expand-all-btn'); if (b) b.click(); }); await wait(500);
	for (const f of [0.3, 0.6, 1]) { await ev((f) => { const o = document.getElementById('chat-output'); if (o) o.scrollTop = o.scrollHeight * f; }, f); await wait(250); await grab('transcript_' + f, '#chat-output'); }
	await ev(() => { const b = document.getElementById('expand-all-btn'); if (b) b.click(); });
	const tiles = page.locator('#chat-output .ctile.chat-msg-assistant');
	if (await tiles.count()) { await tiles.last().hover({ force: true }).catch(() => {}); await wait(300); await grab('tile_hover', '#chat-output', true); await page.mouse.move(...PARK_DESK); }
	await rateSurfaces('');
	await page.fill('#chat-input', 'A draft that is long enough to wrap onto a second line of the composer, so its height and its buttons show how they sit together.').catch(() => {});
	await wait(300); await grab('composer', '.chat-input-bar'); await page.fill('#chat-input', '').catch(() => {});
	// Rail sections, each unfolded, and a filter chip on.
	await ev(() => { document.querySelectorAll('#panel-rail details').forEach((d) => { d.open = true; }); document.querySelectorAll('#panel-rail .rail-fold[aria-expanded="false"]').forEach((b) => b.click()); });
	await wait(300); await grab('rail', '#panel-rail');
	await ev(() => { const c = document.querySelector('#panel-rail .tag-chip'); if (c) c.click(); }); await wait(400);
	await grab('rail_filtered', '#panel-rail');
	await ev(() => { const c = document.querySelector('#panel-rail .tag-chip.tag-inc, #panel-rail .tag-chip.on'); if (c) c.click(); }); await wait(300);
	await ev(() => { const r = document.querySelector('#panel-rail .rail-scroll') || document.getElementById('panel-rail'); r.scrollTop = 99999; }); await wait(250);
	await grab('rail_end', '#panel-rail');
	// Top bar and its tabs.
	await grab('topbar', '.topbar');
	// Menus, pop-ups and dialogs.
	const opens = [
		['menu_settings', '#settings-menu-btn'], ['menu_help', '#help-btn'], ['menu_chats', '#chats-menu-btn'], ['menu_gallery', '#panel-tags .ptag-more'],
		['menu_identity', '#user-row'], ['dlg_about', async () => { await click('#help-btn'); await wait(300); return click('#about-btn'); }],
		['dlg_newdiamond', '#new-diamond-btn'], ['menu_handmode', '#hand-mode-chip'], ['menu_astat', '#astat-summary'],
		['dlg_chatcog', '#session-list .chat-box .tile-cog'], ['dlg_diamondcog', '#diamond-list .diamond-box .tile-cog'],
		['palette', async () => { await page.keyboard.press('Control+k'); return true; }],
	];
	for (const [name, sel] of opens) {
		await overlay(name, sel);
		// A dialog's own sub-menus, if any are open-able from inside it.
		if (name === 'menu_settings') {
			const n = await ev(() => [...document.querySelectorAll('#settings-menu details, #settings-menu .pop-more')].filter((e) => e.getClientRects().length).length);
			if (n > 0) { await ev(() => document.querySelectorAll('#settings-menu details').forEach((d) => { d.open = true; })); await wait(300); await grab('menu_settings_open', '#settings-menu'); }
		}
	}
	await quiet();
	// Admin: every view of the drawer, top and bottom, then the forms its rows open.
	for (const v of ['home', 'settings', 'credits', 'release', 'push']) {
		await quiet();
		if (!(await click('#settings-btn'))) { CAP.missing.push(`${CFG}/admin_${v}`); continue; }
		await wait(600);
		await ev((v) => { try { window.DaimondAdmin[v](); } catch (e) {} }, v); await wait(700);
		await ev(() => document.querySelectorAll('#admin details').forEach((d) => { d.open = true; }));
		await grab('admin_' + v, '#admin');
		await ev(() => { const b = document.getElementById('admin-scroll') || document.getElementById('admin'); b.scrollTop = 99999; }); await wait(250);
		await grab('admin_' + v + '_end', '#admin');
	}
	for (const re of ['^Change name', '^Change passphrase', '^Set up git push', '^Edit the Chat prompt', '^Forget this identity', '^Social settings']) {
		await overlay('form_' + re.replace(/\W+/g, '').slice(0, 16), async () => { await click('#settings-btn'); await wait(600); await ev(() => { try { window.DaimondAdmin.home(); } catch (e) {} }); await wait(400); return clickText('#admin .admin-item', re); });
	}
	await quiet();
	// Every dock and stage panel on its own beside the chat.
	const ids = await ev(() => DaimondPanels.panels().map((p) => p.id));
	for (const id of ids || []) {
		if (['rail', 'ai'].includes(id)) continue;
		await panels(['rail', 'ai', id]);
		await ev((id) => document.querySelectorAll(`#panel-${id} details`).forEach((d) => { d.open = true; }), id);
		await wait(200);
		await grab('panel_' + id, `#panel-${id}`);
	}
	// The file viewer and editor.
	await panels(['rail', 'ai', 'work']);
	for (const [name, re] of [['viewer_text', '^\\s*notes\\.md'], ['viewer_image', 'plan\\.svg'], ['viewer_csv', 'budget\\.csv'], ['viewer_long', 'a-very-long']]) {
		await quiet();
		const ok = await ev((re) => { const r = new RegExp(re);
			const row = [...document.querySelectorAll('.files-row')].find((x) => r.test((x.querySelector('.files-name') || x).textContent.trim()));
			if (!row) return false; (row.querySelector('.files-name') || row).click(); return true; }, re);
		if (!ok) { log('no row', name); CAP.missing.push(`${CFG}/${name}`); continue; }
		await wait(1400);
		const pv = await ev(() => { const p = [...document.querySelectorAll('#panel-doc, #panel-preview')].find((x) => x.getClientRects().length); return p ? '#' + p.id : null; });
		await grab(name, pv);
		if (name === 'viewer_text' && await clickText(`${pv} button`, '^\\W*edit\\b')) { await wait(800); await grab('editor_text', pv); await clickText(`${pv} button`, 'cancel|back'); }
	}
	await quiet();
	// A diamond: its Crystal, its chat view, then its built-in page.
	await ev(() => { const t = [...document.querySelectorAll('.diamond-box')].find((e) => /Kitchen/.test(e.getAttribute('aria-label') || e.textContent)); if (t) (t.querySelector('.tile-label') || t).click(); });
	await wait(1200);
	await click('#dview-crystal'); await wait(1600); await grab('diamond_crystal');
	for (const re of ['^\\W*history', 'tags', '^\\W*edit\\b']) {
		await overlay('crystal_' + re.replace(/\W+/g, ''), async () => { await click('#dview-crystal'); await wait(900); return clickText('.crystal-bar button', re); });
	}
	await quiet(); await click('#dview-crystal'); await wait(900);
	await click('#dview-chat'); await wait(800); await grab('diamond_chat');
	await ev(() => { const d = document.querySelector('.rail-builtin'); if (d) d.open = true; }); await wait(300);
	await ev(() => { const b = document.querySelector('.rail-builtin .diamond-box, .rail-builtin .session-box, .rail-builtin button'); if (b) ((b.querySelector && b.querySelector('.tile-label')) || b).click(); });
	await wait(1400); await grab('diamond_builtin');
	await quiet();
}

// ── Surfaces: the phone ─────────────────────────────────────────────────
async function phoneSurfaces(wk) {
	await quiet();
	for (let i = 0; i < 3; i++) { if (await page.locator('#admin-close').isVisible().catch(() => false)) { await page.locator('#admin-close').click({ force: true }); await wait(300); } }
	await ev(() => { try { window.DaimondPanels.show('ai'); } catch (e) {} }); await wait(300);
	await mainChat();
	await grab('p_chat');
	await ev(() => { const o = document.getElementById('chat-output'); if (o) o.scrollTop = 0; }); await wait(300);
	await grab('p_chat_top', '#chat-output');
	await rateSurfaces('p_');
	await page.fill('#chat-input', 'A draft long enough to wrap onto a second line of the composer on a phone.').catch(() => {});
	await wait(300); await grab('p_composer', '.chat-input-bar'); await page.fill('#chat-input', '').catch(() => {});
	await click('#drawer-btn'); await wait(900);
	await ev(() => document.querySelectorAll('#panel-rail details').forEach((d) => { d.open = true; }));
	await grab('p_drawer', '#panel-rail');
	await ev(() => { const r = document.querySelector('#panel-rail .rail-scroll') || document.getElementById('panel-rail'); r.scrollTop = 99999; }); await wait(300);
	await grab('p_drawer_end', '#panel-rail');
	await quiet();
	await ev(() => { document.body.classList.remove('drawer-open'); const sc = document.querySelector('.drawer-scrim, .scrim'); if (sc) sc.click(); }); await wait(400);
	// The strip (bottom nav) and each sheet it opens.
	await grab('p_strip', '#mnav');
	const tabs = await ev(() => [...document.querySelectorAll('#mnav button')].map((b, i) => (b.textContent || '').trim().replace(/\W+/g, '').slice(0, 12) || 'b' + i));
	for (let i = 0; i < (tabs || []).length; i++) {
		await ev((i) => { const b = [...document.querySelectorAll('#mnav button')][i]; if (b) b.click(); }, i); await wait(700);
		// WebKit's Workspace tab is real furniture with no content behind it:
		// WebKit keeps no file store, so files never sync to it by design (CRF2).
		// Recorded as not covered, never scored as if it were a pass or a fail.
		if (wk && !WKSTORE && /Workspace/i.test(tabs[i])) {
			CAP.notCovered.push({ label: 'webkit Workspace', reason: 'WebKit has no file store; files do not sync to it by design (CRF2)', surface: `${CFG}/p_tab_${tabs[i]}` });
		} else {
			await grab('p_tab_' + tabs[i]);
		}
		const more = await ev(() => [...document.querySelectorAll('#msheet .msheet-list button, .mmore button, #mmore button')].filter((b) => b.getClientRects().length).map((b) => (b.textContent || '').trim().replace(/\W+/g, '').slice(0, 12)));
		if (more && more.length && /more/i.test(tabs[i])) {
			await grab('p_sheet_more', await topOverlay());
			for (let j = 0; j < more.length; j++) {
				await ev((j) => { const b = [...document.querySelectorAll('#msheet .msheet-list button, .mmore button, #mmore button')].filter((b) => b.getClientRects().length)[j]; if (b) b.click(); }, j);
				await wait(700); await grab('p_more_' + more[j]);
				await ev((i) => { const b = [...document.querySelectorAll('#mnav button')][i]; if (b) b.click(); }, i); await wait(500);
			}
		}
	}
	await quiet();
	await ev(() => { try { window.DaimondPanels.show('ai'); } catch (e) {} }); await wait(300);
	for (const [name, sel, drawer] of [['p_menu_settings', '#settings-menu-btn'], ['p_admin', '#settings-btn', 1], ['p_dlg_newdiamond', '#new-diamond-btn', 1], ['p_menu_handmode', '#hand-mode-chip'], ['p_dlg_chatcog', '#session-list .chat-box .tile-cog', 1]]) {
		await overlay(name, async () => { if (drawer) { await click('#drawer-btn'); await wait(700); } return click(sel); });
	}
	await quiet();
	await ev(() => { try { window.DaimondPanels.show('work'); } catch (e) {} }); await wait(700);
	const ok = await ev(() => { const row = [...document.querySelectorAll('.files-row')].find((x) => /^\s*notes\.md/.test((x.querySelector('.files-name') || x).textContent)); if (!row) return false; (row.querySelector('.files-name') || row).click(); return true; });
	if (ok) { await wait(1400); await grab('p_viewer_text'); }
	// The files are in the store; a device with none holds no row to open (see `webkitPair`). Anywhere else the missing row is a fault.
	else if (wk && !WKSTORE) CAP.notCovered.push({ label: 'webkit file viewer', reason: 'WebKit has no file store, so notes.md never reaches the device (CRF2)', surface: `${CFG}/p_viewer_text` });
	else CAP.missing.push(`${CFG}/p_viewer_text`);
	await quiet();
	await carrySurfaces(wk);
}

// The surfaces the 5.2.9 carry needs (G1, rule 4: every instance). Each starts from a known place, the main chat on the chat panel with
// the drawer shut, and each is a place a fault lived: Help's rows, the head's ⋯ menu, select mode, a Diamond's two faces, and the page
// the drawer leaves after New Chat.
async function carrySurfaces(wk) {
	const home = async () => {
		await quiet();
		await ev(() => { document.body.classList.remove('drawer-open'); const sc = document.querySelector('.drawer-scrim, .scrim'); if (sc && sc.getClientRects().length) sc.click(); }); await wait(300);
		await ev(() => { try { window.DaimondPanels.show('ai'); } catch (e) {} }); await wait(400);
		await mainChat();
	};
	const drawer = async () => { await ev(() => { if (!document.body.classList.contains('drawer-open')) { const b = document.getElementById('drawer-btn'); if (b) b.click(); } }); await wait(800); };
	await home();
	await overlay('p_menu_help', '#help-btn');
	// MISSING on B0 by design: the ⋯ menu is H1's. The surface turns from MISSING to present when H1 merges.
	await overlay('p_menu_headmore', '#chead-more');
	await home();
	if (await click('#collapse-btn')) { await wait(600); await grab('p_chat_select'); await click('#collapse-btn'); await wait(400); }
	else CAP.missing.push(`${CFG}/p_chat_select`);
	// The Kitchen Diamond, on each face, picked from the drawer as a person would.
	await home(); await drawer();
	const dia = await ev(() => { const t = [...document.querySelectorAll('#diamond-list .diamond-box')].find((e) => /Kitchen/.test(e.getAttribute('aria-label') || e.textContent)); if (!t) return false; (t.querySelector('.tile-label') || t).click(); return true; });
	if (dia === true) {
		await wait(1200);
		await click('#dview-crystal'); await wait(1400); await grab('p_diamond_crystal');
		await click('#dview-chat'); await wait(900); await grab('p_diamond_chat');
		await click('#dview-crystal'); await wait(500);
	} else if (wk && !WKSTORE) {
		// A Diamond is a folder in the store (see `webkitPair`): the device holds none, so there is no face to open.
		for (const f of ['p_diamond_crystal', 'p_diamond_chat']) CAP.notCovered.push({ label: 'webkit Diamonds', reason: 'WebKit has no file store, so no Diamond reaches the device (CRF2)', surface: `${CFG}/${f}` });
	} else CAP.missing.push(`${CFG}/p_diamond_crystal`, `${CFG}/p_diamond_chat`);
	// New Chat from the drawer, then the page it leaves (item 8: the drawer is meant to be shut over the new chat). It leaves a pending chat.
	await home(); await drawer();
	if (await click('#new-session-btn')) {
		await wait(1000); await grab('p_newchat');
		// The pending chat is deleted again, through the app's own delete, so the surfaces after it, the other look and the WebKit device do not
		// inherit a chat called "New Chat".
		await home();
		await ev(() => { const t = [...document.querySelectorAll('#session-list .session-box')].find((e) => e.classList.contains('pending') || /^New Chat/.test((e.textContent || '').trim())); const c = t && t.querySelector('.tile-cog'); if (c) c.click(); });
		await wait(700); await click('.tile-dlg-delete'); await wait(600);
		await ev(() => { const b = [...document.querySelectorAll('.dlg-card .dlg-ok.danger, .modal-card .dlg-ok.danger')].find((e) => e.getClientRects().length); if (b) b.click(); });
		await wait(700);
	} else CAP.missing.push(`${CFG}/p_newchat`);
	await home();
}

function saveCap(name) { fs.writeFileSync(`${OUT}/cap_${name}.json`, JSON.stringify(CAP)); log('saved', `${OUT}/cap_${name}.json`, CAP.items.length, 'items', CAP.surfaces.length, 'surfaces', CAP.missing.length, 'missing', CAP.notCovered.length, 'not covered'); }

// ── Modes that drive a browser ──────────────────────────────────────────
async function seed() {
	if (process.env.DAIMOND_MOCK_SCRIPT) fs.writeFileSync(process.env.DAIMOND_MOCK_SCRIPT, JSON.stringify(SCRIPT));
	const s = await open({ name: 'alex', profile: PROF });
	page = s.page;
	await page.setViewportSize({ width: 1440, height: 900 });
	await wait(800);
	await ev(async () => { const m = await import('/pkg/oxedyne_daimond.js'); window.__free = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true); });
	for (const name of DIAMONDS) {
		await page.click('#new-diamond-btn', { force: true });
		await page.waitForSelector('.dlg-input', { timeout: 10000 });
		await page.fill('.dlg-input', name);
		await page.click('.dlg-ok', { force: true });
		await wait(1200);
	}
	const kid = await ev(async () => { const d = JSON.parse(await window.__free.list_diamonds()).find((x) => x.name === 'Kitchen renovation'); return d ? d.id : ''; });
	const W = (p, c) => ev(async (a) => { await window.__free.run_tool('file_write', JSON.stringify({ path: a.p, content: a.c })); }, { p, c });
	await W(`diamonds/${kid}/crystal.json`, JSON.stringify(CRYSTAL));
	await W(`diamonds/${kid}/STATE.md`, '# State\n\nWaiting on Harlow.\n');
	for (const [p, c] of Object.entries(FILES)) await W(p, c);
	for (const q of ['Outline section 4.2 on sampling bias.', 'Flights to Hobart on 14 November.']) { await newChat(s); await chat(s, q); }
	await newChat(s);
	await chat(s, Q1);
	await chat(s, Q2);
	// U2 (plan unit I): the Q1 answer rated down with the tag Too long and a note, through the popup; the Q2 answer up by a tap; then
	// committed. The chat holds a lit pair, a details control that is `.on` and a Rating tile of two lines, for every surface after it.
	{
		const vis = (mid, cls) => page.locator(`#chat-output .ctile[data-mid="${mid}"] .${cls} >> visible=true`).first();
		const mids = await ev(async () => [...document.querySelectorAll('#chat-output .ctile.chat-msg-assistant[data-mid]')].map((t) => t.dataset.mid));
		if (mids.length < 2) { log(`seed: ${mids.length} answers with a mid, want >= 2`); await s.close().catch(() => {}); process.exit(3); }
		await vis(mids[0], 'ctile-rate-more').click({ force: true });
		await page.waitForSelector('.rate-card', { timeout: 6000 });
		await page.locator('.rate-card .rate-scale .tile-dlg-level').first().click({ force: true });
		await page.locator('.rate-card .ctile-rate-tags .tile-dlg-level').nth(2).click({ force: true });
		await page.locator('.rate-card details > summary').first().click({ force: true });
		await page.locator('.rate-card textarea.rate-said-input').fill('Too long for what I asked, and the table was not needed.');
		await page.locator('.rate-card .ui-close').first().click({ force: true });
		await wait(300);
		await vis(mids[1], 'ctile-rate-up').click({ force: true });
		await ev(async () => { await window.DaimondRatingUI.flush(String(window.DaimondAttach.focus().id)); });
		await wait(500);
		const lines = await ev(() => document.querySelectorAll('#chat-output .ctile[data-t="rating"] .rate-line').length);
		if (lines !== 2) { log(`seed: the ratings did not land (${lines} Rating lines, want 2)`); await s.close().catch(() => {}); process.exit(3); }
	}
	await chat(s, '@tool file_read {"path":"notes.md"}').catch((e) => log('tool turn', e.message));
	await chat(s, '@tools file_read {"path":"budget.csv"} ;; file_read {"path":"quotes/harlow.md"}').catch((e) => log('tools turn', e.message));
	await chat(s, '@reason I compare the lead times against a May start first. ;; Harlow is the only one that lands in May.').catch((e) => log('reason turn', e.message));
	await chat(s, '@err 500').catch((e) => log('err turn', e.message));
	// Three diamonds, three different shapes of the same tile (D-20260929-03
	// followup): a short model and one tag, a long model and five tags, and a
	// short model with none at all. A content-dependent wrap in the model,
	// chips or meter row shows up as a difference between these three rather
	// than needing a fourth seeded diamond.
	await ev(async () => {
		const list = JSON.parse(await window.__free.list_diamonds());
		const byName = (n) => list.find((x) => x.name === n);
		// `set_tags`, not the `set_diamond_tags` the seed used to guard on: that
		// name is not a method `DaimondApp` has, so the guard was always false
		// and the kitchen diamond's own 'home' tag -- the one the rail's filter
		// chip was meant to come from -- was never actually set.
		const tag = async (n, tags) => { const d = byName(n); if (d && window.__free.set_tags) await window.__free.set_tags(d.id, JSON.stringify(tags)); };
		const model = (n, m) => { const d = byName(n); if (!d) return; try {
			const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
			all[d.id] = { provider: 'openrouter', model: m };
			localStorage.setItem('daimond-diamond-models', JSON.stringify(all));
		} catch (e) {} };
		await tag('Kitchen renovation', ['home']);
		model('Kitchen renovation', 'gpt-5');
		await tag('Thesis, chapter 4', ['research', 'writing', 'citations', 'committee', 'deadline']);
		model('Thesis, chapter 4', 'anthropic/claude-opus-5.5-extended-context');
		await tag('Tax return 2026', []);
		model('Tax return 2026', 'gpt-5');
		// A long title AND many chips together, for the gate extension's row
		// invariants (layout_contract.md G1/I10): the stage head at its own
		// title's extreme, and a chips row long enough to wrap.
		await tag('Kitchen renovation for the Leederville house, stage two: joinery, benchtop and splashback',
			['research', 'writing', 'citations', 'committee-review', 'deadline', 'thesis', 'chapter-four', 'sampling-bias']);
		model('Kitchen renovation for the Leederville house, stage two: joinery, benchtop and splashback',
			'anthropic/claude-opus-5.5-extended-context-preview');
	});
	// I10: a seed that silently did not land is how the owner's fault stayed
	// unmeasured for two sweeps and a re-check (`set_diamond_tags` was never a
	// real method). Fail loudly here instead of failing quietly in the report.
	// `set_tags` writes through `window.__free`, a WASM instance made only for
	// this seed's direct file/tag writes -- the rail's OWN app object does not
	// hear about the change, so the tile it already drew keeps its old tags
	// until something re-reads the list. A reload is that something.
	await page.reload(); await wait(1500);
	const tagCount = await ev(() => document.querySelectorAll('#panel-rail .session-box-tags .tag-chip').length);
	if (tagCount < 10) { log(`seed: tags did not land (${tagCount} chips, want >= 10)`); await s.close().catch(() => {}); process.exit(3); }
	log('seeded');
	await s.close();
}
// The layout contract's own extremes (layout_contract.md G2/G4): a long
// title and many chips are already seeded; German is the longest locale
// ("Einen Ordner importieren …", "Modellstatistik") and a narrow rail is the
// width the contract's own violations were measured at (260px, MIN_W.rail).
// Row-order/row-shared findings from these surfaces land in the same
// `tiles` capture as the English ones, under their own CFG prefix.
async function layoutExtras() {
	await ev(() => window.DaimondI18n && window.DaimondI18n.setLocale('de')); await wait(900);
	CFG = 'de-obsidian'; await wear('obsidian');
	await quiet();
	// The long-named diamond, open, so the stage head carries the long title
	// this pass exists to measure -- not `mainChat`'s ordinary chat.
	await ev(() => { const t = [...document.querySelectorAll('#diamond-list .diamond-box')].find((b) => /Leederville/.test(b.textContent)); const l = t && t.querySelector('.tile-label, .session-box-name'); if (l) l.click(); else if (t) t.click(); });
	await wait(900);
	await panels(['rail', 'ai', 'work']);
	await grab('rail', '#panel-rail');
	await grab('page_chat');
	await grab('panel_work', '#panel-work');
	// The "floor" width (layout_contract.md G2): the contract's own V6
	// evidence was measured at a narrow dock (desk-en-r260_workhead.png).
	// Opening a fourth panel does not reliably narrow this build's dock (it
	// held 298px regardless), so the width is forced the same way rail260 is
	// below.
	const workStyle = await ev(() => { const w = document.getElementById('panel-work'); if (!w) return null; const s = { width: w.style.width, flex: w.style.flex, minWidth: w.style.minWidth, maxWidth: w.style.maxWidth };
		Object.assign(w.style, { width: '230px', flex: '0 0 230px', minWidth: '230px', maxWidth: '230px' }); return s; });
	await wait(300);
	await grab('panel_work_floor', '#panel-work');
	await ev(() => window.DaimondI18n && window.DaimondI18n.setLocale('en')); await wait(900);
	await grab('panel_work_floor_en', '#panel-work');
	if (workStyle) await ev((s) => { const w = document.getElementById('panel-work'); if (w) Object.assign(w.style, s); }, workStyle);
	const railStyle = await ev(() => { const r = document.getElementById('panel-rail'); if (!r) return null; const s = { width: r.style.width, flex: r.style.flex, minWidth: r.style.minWidth, maxWidth: r.style.maxWidth };
		Object.assign(r.style, { width: '260px', flex: '0 0 260px', minWidth: '260px', maxWidth: '260px' }); return s; });
	CFG = 'rail260-obsidian'; await wear('obsidian');
	await quiet();
	await grab('rail', '#panel-rail');
	if (railStyle) await ev((s) => { const r = document.getElementById('panel-rail'); if (r) Object.assign(r.style, s); }, railStyle);
}
async function desk() {
	CAP = { items: [], faults: [], tiles: [], tap: [], surfaces: [], missing: [], notCovered: [] };
	// CONS_NOCONNECT=1: capture with no provider connected, which is what a run against another tree's server needs (the harness refuses a mock that is not this tree's), as the phone passes already do.
	const s = await open({ name: 'alex', profile: PROF, ...(process.env.CONS_NOCONNECT ? { connect: false } : {}) });
	page = s.page;
	await page.setViewportSize({ width: 1440, height: 900 });
	await wait(1000); await view('max');
	for (const th of LOOKS) { CFG = `desk-${th}`; await wear(th); await deskSurfaces(); }
	await layoutExtras().catch((e) => log('layout extras', e.message));
	saveCap('desk');
	await s.close();
}
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// WebKit is seeded by pairing it to PROF's own account as a SECOND DEVICE, not
// a fresh one, so its chats are real and arrive by sync. Pattern:
// dev/verify_markshere_sync.mjs's `pairedDevice`. If pairing cannot run under
// this harness at all, WebKit is excluded in full rather than measured empty.
//
// TWO FACTS THIS RESTS ON (G2, 2026-10-01; before them `all` on a gateway world
// died at exit 4 and `varlen webkit` on a click timeout):
//  1. SYNC IS PRO-GATED. The seed's account is on the free tier, so every flush of
//     the lead answered `{ ok: false, why: 'not_entitled' }` and nothing ever left
//     it: the 60 s wait was waiting on a push refused at the door. The account is
//     granted Pro the one way the gateway trusts (dev/pro.mjs), here, after the
//     Chromium passes have captured the free-tier surfaces.
//  2. PLAYWRIGHT'S WEBKIT HAS NO OPFS (`navigator.storage.getDirectory` is absent;
//     real Safari has it). Diamonds and files live in that store, so they never
//     reach this device however long it waits: the rail says "No diamonds yet." and
//     `DaimondSync.state().filesHeld` is false. The wait therefore asks for the
//     chats only, and the Diamond and file surfaces are recorded as NOT COVERED
//     with this reason. If an engine ever offers the store, the wait asks for the
//     Diamonds too and the surfaces are measured.
const GWDIR = new URL('../gateway', import.meta.url).pathname;
let WKSTORE = false;	// does the WebKit device hold a file store (set by `webkitPair`)?
const wait2 = (ms) => new Promise((r) => setTimeout(r, ms));
const syncLine = (p) => p.evaluate(() => {
	let st = {}; try { st = window.DaimondSync.state(); } catch (e) {}
	return { entitled: st.entitled, stalledWhy: st.stalledWhy, ver: st.version, filesHeld: st.filesHeld, chip: (window.DaimondSync.chip && window.DaimondSync.chip()) || '',
		chats: document.querySelectorAll('#session-list .chat-box').length, diamonds: document.querySelectorAll('#diamond-list .diamond-box').length };
}).then((x) => JSON.stringify(x), (e) => 'unreadable: ' + e.message.split('\n')[0]);
async function webkitPair() {
	const lead = await open({ name: 'alex', profile: PROF, connect: false });
	let s = null;
	try {
		await lead.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 });
		const pro = await makePagePro(lead.page, GWDIR, GW_URL);
		if (!pro.pro) throw new Error(`the Pro grant did not take (webhook ${pro.status}, account ${pro.id || 'unknown'})`);
		s = await open({ name: 'alex', profile: PROF + '-webkit', signIn: false, connect: false, defaults: false, browser: 'webkit', touch: true, ua: IPHONE_UA });
		await s.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 });
		const code = await lead.page.evaluate(() => DaimondPairing.create());
		if (!code || !code.code) throw new Error('no pairing code');
		await s.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		await signInAs(s, 'alex');
		await s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway && DaimondGateway.state().authed), null, { timeout: 30000 });
		WKSTORE = await s.page.evaluate(() => !!(navigator.storage && typeof navigator.storage.getDirectory === 'function'));
		return { lead, s };
	} catch (e) {
		if (s) await s.close().catch(() => {});
		await lead.close().catch(() => {});
		throw e;
	}
}
// Push from the lead and pull on the device until its chats (and, if it holds a store, its Diamonds) have landed. A device that never gets
// them fails the run with exit 4, naming both ends' sync state, rather than capturing its own empty rail as if it were real.
async function webkitSync(lead, s) {
	const t0 = Date.now(); let last = 0;
	while (Date.now() - t0 < 60000) {
		await lead.page.evaluate(() => window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push()).catch(() => {});
		await s.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
		await wait2(800);
		const n = await s.page.evaluate(() => ({ chats: document.querySelectorAll('#session-list .chat-box').length, diamonds: document.querySelectorAll('#diamond-list .diamond-box').length })).catch(() => null);
		if (n && n.chats >= 3 && (!WKSTORE || n.diamonds >= 4)) return true;
		if (Date.now() - last > 10000) { last = Date.now(); log(`webkit sync, t+${Math.round((Date.now() - t0) / 1000)}s  lead ${await syncLine(lead.page)}  webkit ${await syncLine(s.page)}`); }
	}
	log(`webkit: sync wait timed out (store ${WKSTORE ? 'held' : 'absent'}); lead ${await syncLine(lead.page)}  webkit ${await syncLine(s.page)}`);
	return false;
}
async function phone(wk) {
	CAP = { items: [], faults: [], tiles: [], tap: [], surfaces: [], missing: [], notCovered: [] };
	let lead = null, s, excluded = null;
	if (wk) {
		try { ({ lead, s } = await webkitPair()); }
		catch (e) {
			log('webkit pairing unavailable under this harness, excluding WebKit in full:', e.message);
			excluded = 'webkit-*: no seeded content (' + e.message.split('\n')[0] + ')';
		}
	} else {
		s = await open({ name: 'alex', profile: PROF, touch: true, connect: false, isMobile: true });
	}
	if (excluded) {
		CAP.notCovered.push({ label: 'webkit', reason: excluded, surface: 'webkit-*' });
		saveCap('webkit');
		if (s) await s.close().catch(() => {});
		if (lead) await lead.close().catch(() => {});
		return;
	}
	page = s.page;
	await page.setViewportSize({ width: 390, height: 844 });
	await wait(1500);
	if (wk && !(await webkitSync(lead, s))) {
		log('webkit: failing the run rather than capturing an empty rail');
		await s.close().catch(() => {}); await lead.close().catch(() => {});
		process.exit(4);
	}
	await view('max');
	for (const th of LOOKS) { CFG = `${wk ? 'webkit' : 'phone'}-${th}`; await wear(th); await phoneSurfaces(wk); }
	saveCap(wk ? 'webkit' : 'phone');
	await s.close();
	if (lead) await lead.close().catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════
// THE CLASSIFICATION TABLE. First match wins, so narrower roles come first.
// `when` reads only DOM and class evidence captured above: tag, id, cls, anc
// (the seven nearest ancestors as tag#id.classes), role, text, ctrl.
// Correct a row here and re-run `report`; no browser is needed.
// ════════════════════════════════════════════════════════════════════════
const has = (it, c) => it.cls.includes(c);
const within = (it, re) => it.anc.some((a) => re.test(a));
const ROLES = [
	// [role, casing rule, predicate]
	// Controls.
	['close-button',    'none',     (it) => it.ctrl && (has(it, 'panel-close') || has(it, 'ui-close') || has(it, 'admin-back') || has(it, 'pal-close') || /^close\b/i.test(it.aria) && !txt(it))],
	['create-button',   'title',    (it) => it.ctrl && !has(it, 'tile-label') && (has(it, 'railbtn') || /^(new|add|create)\b/i.test(txt(it)) && txt(it).length < 32 && !has(it, 'admin-item') && !within(it, /dlg-actions/) && !/link|add-credits/.test(it.cls.join(' ')))],
	['picture-option',  'none',     (it) => it.ctrl && has(it, 'grid-opt')],
	['tab',             'sentence', (it) => it.ctrl && (has(it, 'ptag') || within(it, /#mnav|msheet-tabs/) || it.role === 'tab') && !has(it, 'dview-btn')],
	['dialog-action',   'title',    (it) => it.ctrl && (has(it, 'push-save') || it.id === 'push-save' || it.id === 'beta-open') || it.ctrl && within(it, /dlg-actions|modal-actions|tile-dlg-actions|dlg-foot|compose-foot/)],
	// G5: a toggle that opens a section reads as a disclosure, not a toggle
	// (ahead of toggle-option below, whose `-toggle\b` would otherwise claim it).
	['disclosure',      'sentence', (it) => it.ctrl && (has(it, 'tagf-toggle') || has(it, 'models-prov-head'))],
	['toggle-option',   'sentence', (it) => it.ctrl && (has(it, 'dview-btn') || within(it, /\.seg\b|\.size-row|-toggle\b|\.files-scope|\.imp-chips|\.net-row|\.tile-dlg-seg|\.files-mode\b/) && !has(it, 'files-mode-btn') || has(it, 'grid-opt'))],
	['composer-button', 'none',     (it) => it.ctrl && (within(it, /chat-input-bar|msheet-ask/) && !/^(input|textarea)$/.test(it.tag))],
	// G16: the bar's own icon-only tools (hamburger, gear, section fold) are a
	// role of their own -- 30px on desk, 36px on phone -- ahead of `head-tool`,
	// whose regex otherwise claims `.rail-fold` for a row it does not belong to.
	['bar-icon',        'none',     (it) => it.ctrl && (it.id === 'drawer-btn' || it.id === 'settings-btn' || has(it, 'rail-fold'))],
	['head-tool',       'title',    (it) => it.ctrl && within(it, /chead-right|railhead-acts|(files|mail|spend|trash|pending|agents|top)-actions(\.|$)|files-view-head|^div\.railhead($|\.)|pptw-head/)],
	// The "Go to a panel" gallery is a padded search-result row, not a plain
	// text menu entry -- it fell into `menu-item` only through the generic
	// `div#….pop` clause below and then outvoted that role's real, compact
	// entries on height.
	['gallery-row',     'none',     (it) => has(it, 'gal-row') || has(it, 'gal-pin')],
	['menu-item',       'sentence',    (it) => it.ctrl && (it.role === 'menuitem' || has(it, 'admin-item') || has(it, 'railhead-menu-item') || within(it, /^div#[\w-]*\.pop\b/) && /BUTTON/i.test(it.tag) && !/select|input/.test(it.tag))],
	// G6: only the chip itself is a filter chip -- its × closer, its input and
	// its "add" text-button are their own roles (ahead of filter-chip below).
	['icon-button',     'none',     (it) => it.ctrl && has(it, 'tag-x')],
	['field',            'sentence', (it) => it.tag === 'input' && has(it, 'tag-input')],
	['text-button',     'title',    (it) => it.ctrl && has(it, 'crystal-act') && within(it, /tag-add/)],
	['filter-chip',     'none',     (it) => it.ctrl && (has(it, 'tag-chip') || within(it, /\.tag-box|\.tag-row|\.rail-filter/))],
	// "Uploads paused" sits in the status strip's detail rows as a reading, not as a button the person reaches for (5.2.9, S's finding; the lead's
	// decision of 1 Oct keeps it a status-row occupant). Its stylesheet gave it the class `chunk-chip`, which the `chip` role below would claim.
	['status-row',      'none',     (it) => it.id === 'chunk-chip'],
	['chip',            'sentence', (it) => it.ctrl && it.cls.some((c) => /chip/.test(c))],
	['swatch',          'none',     (it) => has(it, 'tile-dlg-swatch') || it.type === 'color'],
	['field',           'sentence', (it) => /^(input|textarea)$/.test(it.tag) && !/checkbox|radio|range|color|file/.test(it.type)],
	['select',          'none',     (it) => it.tag === 'select'],
	// G19: `.device-stay` carries `role="switch"` honestly, but it is a WORDED
	// button (an icon and a label), not the icon-only or native control this
	// role's height and radius are compared against -- excluded by class since
	// the role check alone would still claim it.
	['toggle',          'none',     (it) => (/checkbox|radio/.test(it.type) || /switch|checkbox|radio/.test(it.role)) && !has(it, 'device-stay')],
	['disclosure',      'sentence', (it) => it.tag === 'summary' || ['sys-head', 'files-rest-head', 'link-strip', 'cap-more', 'mem-raw-btn', 'arte-strip'].some((c) => has(it, c))],
	// G7: a tile's own label button is not the tile that carries it.
	['rail-tile-label', 'none',     (it) => has(it, 'tile-label')],
	['rail-tile',       'none',     (it) => has(it, 'session-box') || has(it, 'tile-label') && within(it, /session-box/)],
	// G20: `.path-crumb` is a breadcrumb, not a list row.
	['file-row',        'none',     (it) => has(it, 'files-row')],
	// G14: a figures strip is not a status row (L3 lays it out on its own).
	['stat-strip',      'none',     (it) => has(it, 'spend-row')],
	['status-row',      'none',     (it) => has(it, 'astat-row') || has(it, 'spend-row') || has(it, 'user-row')],
	['palette-row',     'none',     (it) => has(it, 'pal-item')],
	// G20 follow-on: a breadcrumb reads AS a link (files.css: inherited font, no
	// chrome, underline on hover) but does not carry the padding or the
	// underline-at-rest a REAL inline-link does -- its own role, checked for
	// consistency only against its own other instances.
	['breadcrumb',      'none',     (it) => it.ctrl && has(it, 'path-crumb')],
	['inline-link',     'none',     (it) => it.tag === 'a' || it.ctrl && /link|learn-more|install|add-credits/.test(it.cls.join(' '))],
	['icon-button',     'none',     (it) => it.ctrl && !txt(it).replace(/[^\p{L}\p{N}]/gu, '') && (!!it.icon || [...txt(it)].length <= 2)],
	// G19 follow-on: a labelled toggle (icon + word, `role="switch"`) is
	// neither the icon-only/native toggle role nor an ordinary text-button --
	// `.device-stay` is the only one of its kind today, checked for
	// consistency against its own other instances (on/off, phone/desk).
	['labelled-toggle', 'sentence', (it) => it.ctrl && has(it, 'device-stay')],
	['text-button',     'title',    (it) => it.ctrl && !!txt(it).replace(/[^\p{L}]/gu, '')],
	['other-control',   'none',     (it) => it.ctrl],
	// Text.
	['panel-title',     'sentence', (it) => has(it, 'ctitle')],
	['dialog-title',    'sentence', (it) => /^h[12]$/.test(it.tag) && within(it, /ui-head|dlg|modal/) || has(it, 'ui-head-title') || has(it, 'admin-title') || has(it, 'dlg-title') || has(it, 'modal-title')],
	// G18: `.spend-sub` is a section head, not meta -- §8 already styles it as one.
	['section-head',    'sentence', (it) => ['pop-head', 'admin-sec', 'tile-dlg-head', 'mem-title', 'pptw-head-label', 'rail-title', 'railhead-title', 'spend-sub'].some((c) => has(it, c)) || it.cls.some((c) => /sec-title$|-sec-head$|section-title$/.test(c)) || /^h[3-6]$/.test(it.tag) && !within(it, /ctile-body|\.md\b/)],
	['field-label',     'sentence', (it) => it.tag === 'label' || it.cls.some((c) => /-label$|-lbl$/.test(c)) && !within(it, /ctile/)],
	// G1: release notes are list data -- 315 `.rel-build-note` lines would
	// otherwise outvote the 20 real note classes.
	['list-text',       'none',     (it) => has(it, 'rel-build-note')],
	['note',            'sentence', (it) => it.cls.some((c) => /(^|-)(note|empty|hint|fine|help|blurb|intro|desc)$/.test(c))],
	// G11: times, ids, sizes, versions and fingerprints are mono stamps on
	// purpose (the pre-existing "one meta reading" rule); the rest of `meta`
	// is sans. The class list is explicit, not a loose substring match --
	// `/size|time|when/` alone also caught KaTeX's `.reset-size*`, `.size-row`,
	// `.update-banner`, `.mail-when`, `.tile-when` and a dozen others that
	// were never meta at all, and let them outvote the real stamps.
	['stamp',           'none',     (it) => ['ctile-meta', 'chead-when', 'device-when', 'fv-size', 'hist-ver',
		'ctile-time-full', 'device-id', 'device-build', 'account-fp-val'].some((c) => has(it, c))],
	['meta',            'none',     (it) => it.cls.some((c) => /meta|stamp|when|date|time|count|sub$|fp-val|device-(id|build)|size|ver$/.test(c))],
	['tile-prose',      'none',     (it) => within(it, /ctile-body|\.md\b/) && /^(p|li|strong|em|span|b)$/.test(it.tag) && !within(it, /pre|code|table/)],
	// G8: an app table (Spend, Model stats) is not a reply's own table.
	['tile-table-head', 'none',     (it) => it.tag === 'th' && within(it, /ctile-body|\.md\b/)],
	['data-table-head', 'none',     (it) => it.tag === 'th'],
	['tile-table-cell', 'none',     (it) => it.tag === 'td' && within(it, /ctile-body|\.md\b/)],
	['data-table-cell', 'none',     (it) => it.tag === 'td'],
	['tile-code',       'none',     (it) => within(it, /^pre|^code|code-block/) || it.tag === 'code'],
	['body-text',       'none',     () => true],
];
const txt = (it) => it.text || '';
const classify = (it) => { for (const [role, casing, f] of ROLES) { try { if (f(it)) return [role, casing]; } catch (e) {} } return ['unclassified', 'none']; };

// Properties compared within a role. A role compares only what its members share
// by design: a list row's text is the user's own, so its casing is not compared.
const PROPS_CTRL = ['ff', 'fs', 'fw', 'ls', 'tt', 'col', 'bg', 'bd', 'rad', 'pad', 'h', 'lh', 'gap', 'td', 'sh'];
const FONTP = new Set(['ff', 'fs', 'fw', 'ls', 'tt', 'lh', 'td']);
const PROPS_TEXT = ['ff', 'fs', 'fw', 'ls', 'tt', 'col', 'lh', 'td'];
const ROLE_PROPS = {
	// G17: a single-child button's `gap` is invisible, and the icon-gap check
	// already measures the real gap, so `head-tool` drops it from its props.
	'create-button': PROPS_CTRL.concat('icon'), 'text-button': PROPS_CTRL, 'dialog-action': PROPS_CTRL, 'head-tool': PROPS_CTRL.filter((p) => p !== 'gap').concat('icon'),
	'icon-button': ['col', 'bg', 'bd', 'rad', 'pad', 'h', 'sh', 'icon'], 'bar-icon': ['col', 'bg', 'bd', 'rad', 'pad', 'h', 'sh', 'icon'], 'composer-button': ['rad', 'h', 'icon', 'bd'], 'close-button': ['col', 'bg', 'bd', 'rad', 'pad', 'h', 'sh', 'icon'],
	'tab': PROPS_CTRL, 'toggle-option': PROPS_CTRL, 'menu-item': PROPS_CTRL.concat('icon'), 'chip': PROPS_CTRL, 'filter-chip': PROPS_CTRL,
	'field': ['ff', 'fs', 'fw', 'col', 'bg', 'bd', 'rad', 'h', 'sh'], 'select': ['ff', 'fs', 'fw', 'col', 'bg', 'bd', 'rad', 'pad', 'h'], 'toggle': ['h', 'bd', 'rad'],
	'disclosure': PROPS_TEXT.concat('bg', 'bd', 'pad', 'h'), 'inline-link': ['ff', 'fw', 'col', 'td', 'bg', 'bd', 'pad'],
	'breadcrumb': ['ff', 'fs', 'fw', 'col', 'pad'],
	'labelled-toggle': ['ff', 'fs', 'fw', 'col', 'bg', 'bd', 'rad', 'pad', 'h', 'gap'],
	'rail-tile': ['ff', 'fs', 'fw', 'col', 'bg', 'bd', 'rad', 'pad'], 'rail-tile-label': ['ff', 'fs', 'fw', 'col', 'bg', 'bd', 'rad', 'pad'],
	'file-row': ['ff', 'fs', 'fw', 'col', 'bg', 'bd', 'rad', 'pad', 'h', 'lh'],
	'status-row': ['ff', 'fs', 'fw', 'col', 'bg', 'bd', 'rad', 'pad', 'h'], 'stat-strip': ['ff', 'fs', 'fw', 'col', 'bg', 'bd', 'rad', 'pad', 'h'],
	'gallery-row': ['ff', 'fs', 'fw', 'col', 'bg', 'bd', 'rad', 'pad', 'h'],
	'palette-row': ['ff', 'fs', 'col', 'bd', 'rad', 'pad', 'h'],
	'panel-title': PROPS_TEXT, 'dialog-title': PROPS_TEXT, 'section-head': PROPS_TEXT, 'field-label': PROPS_TEXT, 'note': ['ff', 'fs', 'fw', 'ls', 'col', 'lh'],
	'list-text': ['ff', 'fs', 'fw', 'col', 'lh'],
	'meta': ['ff', 'fs', 'fw', 'ls', 'tt', 'col'], 'stamp': ['ff', 'fs', 'fw', 'ls', 'tt', 'col'],
	'tile-prose': ['ff', 'fs', 'lh', 'col'], 'tile-table-head': PROPS_TEXT.concat('pad'), 'tile-table-cell': ['ff', 'fs', 'fw', 'col', 'lh', 'pad'],
	// D3 (5.2.9): `pad` is compared again, side by side, with the table's outer edge (the first cell's left, the last cell's right) masked
	// at capture. The old fix dropped `pad` for these roles because the last column keeps the panel's own right gutter, which also stopped
	// the inner gaps being checked.
	'data-table-head': PROPS_TEXT.concat('pad'), 'data-table-cell': ['ff', 'fs', 'fw', 'col', 'lh', 'pad'],
};

// THE ALLOW-LIST. A deliberate variant, named, with its reason. `m` is tested
// against `sig + ' ' + text` (plus ' aria-current' when the element says it is
// selected); `p` lists the properties it may differ in.
const ALLOW = [
	// GO-1 (carry r529): `bd` is NOT allowed here any more. A selected or current element is drawn apart by its colour, its fill and its weight,
	// never by a border (bar rule 1: a selected row is a light fill, never an outline). The row used to include `bd`, which let any pressed or
	// current element wear one.
	{ role: '*', m: /\.(on|active|current|selected|is-on|tag-inc)\b|aria-current/, p: ['col', 'bg', 'fw'], why: 'the current or selected state is drawn apart on purpose, by colour, fill and weight, never by a border' },
	{ role: '*', m: /\.danger\b/, p: ['col'], why: 'a destructive action is drawn in the danger colour' },
	{ role: '*', m: /\.dlg-ok\b|#chat-send\b|\.compose-send\b|\.ti-continue\b|#push-save\b|#beta-open\b|\.crystal-act\.primary\b|\.pro-buy\b|\.tools-buy\b|\.mail-unlock\b|\.ar-save\b|\.ar-card-btn\.accent\b/, p: ['col', 'bg', 'bd', 'fw', 'rad'], why: 'the one primary action of a dialog, the composer, an interrupted turn or the crystal form is filled -- the send button’s own round primary keeps its radius too' },
	{ role: 'meta', m: /\.crollup-count\b/, p: ['col', 'fw', 'ff'], why: 'the tool-count badge is filled in the outcome colour (ok, warn, fail)' },
	{ role: '*', m: / :focus$/, p: ['bd', 'sh'], why: 'the focused field shows the accent edge; every field takes it on focus' },
	{ role: 'close-button', m: /about-card/, p: ['col', 'bg', 'rad'], why: 'the About card closes over its picture, so its × is a dark disc (app.css .about-card > .ui-head .ui-close)' },
	{ role: 'filter-chip', m: /\.tag-chip\b/, p: ['col', 'bg'], why: 'each tag keeps its own hue' },
	// cluster 6: `.tag-x` is its own icon-button role now (G6), but its colour
	// is still the chip's own hue by inheritance, not the icon-button grey.
	// r526 residual, approved: its height is the chip's own too (17px), not a
	// standalone 20px control.
	{ role: 'icon-button', m: /\.tag-x\b/, p: ['col', 'h'], why: 'the chip’s own × colour is inherited from its tag’s hue, and it is sized by its chip, not a standalone control' },
	// r526 residual allow-list, all approved by the lead (D-20260929-03):
	{ role: 'inline-link', m: /^a\.(brand|mb-hit)\b/, p: ['col'], why: 'the wordmark and the About picture’s hotspots keep the brand colour -- they are not text links' },
	{ role: 'icon-button', m: /\.attach-add\.grants\b/, p: ['col'], why: 'a "+" that widens a fence takes the accent, like every granting control (daimond.js)' },
	{ role: 'composer-button', m: /#chat-send\b/, p: ['icon'], why: 'the filled send disc carries a 16px arrow for optical balance' },
	{ role: '*', m: /\.ghost\b/, p: ['col'], why: 'a ghost (unavailable) option is drawn muted' },
	{ role: 'tile-prose', m: /^(strong|b)\b/, p: ['col'], why: 'bold in a reply may take the ink colour' },
	{ role: 'field', m: /#chat-input\b|\.pal-input\b|\.compose-text\b|\.files-edit\b/, p: ['fs', 'h', 'bg', 'bd', 'rad', 'ff'], why: 'the composer, the Go to box and the editors are writing surfaces, not form fields' },
	// A1 (§13, approved): §1 kept "Verify this build" a filled row on purpose;
	// it is a button-like link.
	{ role: 'inline-link', m: /about-verify/, p: ['col', 'td', 'bg', 'pad'], why: '"Verify this build" is a button-like link, filled on purpose (§1)' },
	// A numeric column's head and cells are mono, matching the figures in the
	// column below them; a text column's are not (cluster 12, the data-table
	// role). Lumping `th.num` in with `th` for `ff` votes the wrong one out.
	// 5.2.9 (X, the lead's ruling of 1 Oct): the Diamond head's face switch keeps its 30px box (the head block's, and the toggle-option rule's own)
	// and carries its 44px tap area as the house overlay. Every other toggle option is a 44px box on a phone, but 44px here would make the
	// Diamond head 110px, not the 96px the owner chose on 30 Sep (B: title, mode, one more menu).
	{ role: 'head-tool', m: /^select#pending-sort\b/, p: ['h'], why: 'a select cannot wear the 44px overlay a head tool wears (it has no pseudo-element), so its box is the 44px, and the head-tool role\'s 36px is the height of an icon box' },
	{ role: 'toggle-option', m: /\.dview-btn\b/, p: ['h'], why: 'the face switch keeps its 30px box and wears a 44px overlay for its tap: at 44px the Diamond head would be 110px, not the 96px the owner chose' },
	{ role: 'data-table-head', m: /\.num\b/, p: ['ff'], why: 'a numeric column head is mono, matching its own column' },
	{ role: 'data-table-cell', m: /\.num\b/, p: ['ff'], why: 'a numeric cell is mono, matching its own column' },
];

// ── Report ──────────────────────────────────────────────────────────────
const MINOR = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'as', 'from', 'per', 'vs', 'into']);
const PROPER = /^(Chat|Helper|Conversation|Daimond|Daimonds|Crystal|GitHub|OpenRouter|Anthropic|Typst|Obsidian|Porcelain|Daylight|English|Google|Apple|iPhone|Android|Windows|Linux|Mac|macOS|Hobart|Harlow|Oakline|Brandt|Kitchen|Priya|Sam|Alex|Ozone|Oxedyne|Pro|Max|Simple|Classic|I|OK|Git|Ctrl)$/;
// The user's own words are not UI copy: the seeded names, titles and files.
const USER = /Kitchen|Thesis|Tax return|Compare the three|Flights to|Outline section|Write a function|^alex$|\.(md|csv|svg|pdf|typ|json)\b|Daimond (Optimiser|Helper)|^[\w-]+\/|^\d/;
// G23: a leading glyph joined straight to its word ("▸Custom") must not carry
// the word out with it -- strip glyphs before splitting, not just punctuation.
const GLY_CHARS = /[▸▾▶▼►◂◀←-⇿✎✕×⟳↺⋯☰✓✔•◈⚙⊕‹›»«⤓⬇⬆↗●○★☆…✏✂⧉⎘⏸■□◆◇≡✖✗✘⚠ℹ❓❗+＋📎🔒🔓📄📁🗑⭐⚡]/gu;
const words = (t) => t.replace(GLY_CHARS, ' ').replace(/[“”"'‘’()[\]…:.,!?]/g, ' ').split(/\s+/).filter((w) => /^\p{L}/u.test(w));
function casingOf(t) {
	// G4(a): a text whose first word character is a figure is data, not copy
	// ("▸ 0 linked diamonds").
	if (/^[^\p{L}]*\d/u.test(t)) return 'n/a';
	// G3: a sentence is split on the full stop too, so "Ctrl K." reads as one.
	const w = words(t.split(/[.?!]\s/)[0]); if (!w.length) return 'n/a';
	const cap = (x) => /^\p{Lu}/u.test(x), acr = (x) => /^\p{Lu}[\p{Lu}\d]*$/u.test(x);
	if (w.every((x) => acr(x) || !/\p{Ll}/u.test(x))) return w.length === 1 && w[0].length <= 4 ? 'n/a' : 'UPPER';
	if (w.length === 1) return cap(w[0]) ? 'Cap' : 'lower';
	const rest = w.slice(1).filter((x) => !acr(x) && !PROPER.test(x));
	const major = w.slice(1).filter((x) => !MINOR.has(x.toLowerCase()) && !acr(x));
	if (!cap(w[0])) return rest.some(cap) ? 'mixed' : 'lower';
	// G4(b): a title with no major word after the first ("Edit as JSON") is Cap.
	if (!major.length) return 'Cap';
	if (major.every(cap)) return 'Title';
	if (rest.every((x) => !cap(x))) return 'Sentence';
	return 'mixed';
}
const CASE_OK = { title: ['Title', 'Cap', 'n/a', 'UPPER'], sentence: ['Sentence', 'Cap', 'n/a', 'UPPER'], lower: ['lower', 'n/a', 'Cap', 'Sentence', 'Title'], none: null };
// A5 (D-20260929-03 §13, approved): a dialog, panel or step named after the
// button that opens it quotes the label, as the guide does -- the alternative
// is a second, sentence-case key for the same words, which puts "New diamond"
// back on screen.
// 5.2.9 (G2, the lead's decision of 1 Oct, for the owner's review): `^New Chat$` joins them. A pending chat's head title is the chat's own name,
// and it is named for the button that made it (the owner's "New Chat"), exactly as "New Diamond" is; the head shows it until the first message names the chat.
const CASE_ALLOW = [/^New Diamond$/, /^New Message$/, /^Say Hello$/, /^New Chat$/];

function report() {
	const caps = ['desk', 'phone', 'webkit'].map((n) => `${OUT}/cap_${n}.json`).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
	if (!caps.length) { log('no captures in', OUT); process.exit(2); }
	const items = caps.flatMap((c) => c.items), faults = caps.flatMap((c) => c.faults), missing = caps.flatMap((c) => c.missing), surfaces = caps.flatMap((c) => c.surfaces);
	// Recorded, printed, and never scored as a pass or a fail (WebKit's own
	// Workspace, CRF2, or the whole engine when pairing cannot run at all).
	const notCovered = caps.flatMap((c) => c.notCovered || []);
	const tiles = caps.flatMap((c) => c.tiles || []);
	const taps = caps.flatMap((c) => c.tap || []);
	// A run that never saved its WebKit pass (exit 4, or `desk` alone) did not cover WebKit, and says so.
	if (!fs.existsSync(`${OUT}/cap_webkit.json`)) notCovered.push({ label: 'webkit', reason: 'no WebKit capture in this run (the pass did not finish, or was not run)', surface: 'webkit-*' });
	const cfgOf = (s) => s.split('/')[0];
	// One instance = one element (config + signature + text), seen on one or more surfaces.
	const inst = new Map();
	for (const it of items) {
		const [role, casing] = classify(it); it.roleName = role; it.casing = casing;
		const ik = cfgOf(it.surface) + '|' + role + '|' + it.sig + '|' + it.text.slice(0, 30);
		const x = inst.get(ik); if (x) { if (!x.surfaces.includes(it.surface.split('/')[1])) x.surfaces.push(it.surface.split('/')[1]); continue; }
		inst.set(ik, { ...it, cfg: cfgOf(it.surface), surfaces: [it.surface.split('/')[1]] });
	}
	const I = [...inst.values()];
	const byRole = new Map(); for (const it of I) { const k = it.roleName; if (!byRole.has(k)) byRole.set(k, []); byRole.get(k).push(it); }
	const SIDEPAD = /^(tile|data)-table-(head|cell)$/;
	const val = (it, p) => p === 'icon' ? (it.icon ? it.icon.w + '×' + it.icon.h : '-') : p.startsWith('pad:') ? (it.st.padS ? it.st.padS['TRBL'.indexOf(p[4])] : null) : it.st[p];
	const allowed = (role, it, p) => ALLOW.find((a) => (a.role === '*' || a.role === role) && a.p.includes(p) && a.m.test(it.sig + ' ' + it.text + ' < ' + it.anc.slice(0, 3).join(' ') + (it.sel ? ' aria-current' : '') + (it.foc ? ' :focus' : '')));
	const diffs = [];	// style differences within a role
	for (const [role, list] of byRole) {
		const props = ROLE_PROPS[role]; if (!props) continue;
		const byCfg = new Map(); for (const it of list) { if (!byCfg.has(it.cfg)) byCfg.set(it.cfg, []); byCfg.get(it.cfg).push(it); }
		for (const [cfg, L] of byCfg) {
			if (L.length < 2) continue;
			for (const p of SIDEPAD.test(role) ? props.flatMap((x) => x === 'pad' ? ['pad:T', 'pad:R', 'pad:B', 'pad:L'] : [x]) : props) {
				if (p === 'h' && role !== 'list-row') { /* single-line only */ }
				// Type is compared only where there is type; an icon's height only on
				// one line. G12: a textarea sizes to its content, not to a rule. G10:
				// `gap` means nothing on a box that isn't flex or grid.
				const pool = L.filter((it) => !(p === 'h' && it.lines > 1) && !(p === 'icon' && !it.icon) && !(FONTP.has(p) && !/\p{L}/u.test(it.text))
					&& !(p === 'h' && it.tag === 'textarea') && !(p === 'gap' && !/flex|grid/.test(it.st.disp)) && !(p.startsWith('pad:') && val(it, p) == null));
				// G9: padding is compared icon with icon, word with word -- a 30×30
				// icon tool and a worded tool cannot share one canonical padding.
				// G21: a `select`'s own text is never captured (its value is read
				// instead), so it always tested as icon-only; it is worded by its tag.
				const hasWord = (it) => /\p{L}/u.test(it.text) || it.tag === 'select';
				const groups = p === 'pad' ? [pool.filter(hasWord), pool.filter((it) => !hasWord(it))] : [pool];
				for (const gpool of groups) {
					// The canonical form is counted over the plain instances: a filled primary is not a vote for filling the rest.
					const plain = gpool.filter((it) => !allowed(role, it, p)); const voters = plain.length ? plain : gpool;
					const cnt = new Map(); for (const it of voters) { const v = String(val(it, p)); cnt.set(v, (cnt.get(v) || 0) + 1); }
					if (plain.length) for (const it of gpool) { const v = String(val(it, p)); if (!cnt.has(v)) cnt.set(v, 0); }
					if (cnt.size < 2) continue;
					const canon = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
					for (const it of gpool) {
						const v = String(val(it, p)); if (v === canon) continue;
						if (p === 'h' && Math.abs(parseFloat(v) - parseFloat(canon)) <= 1) continue;
						const a = allowed(role, it, p);
						diffs.push({ role, cfg, p: p.replace(':', ' '), canon, v, sig: it.sig, text: it.text.slice(0, 40), surfaces: it.surfaces.slice(0, 4), panel: it.panel, allowed: a ? a.why : null, n: cnt.get(canon), of: gpool.length });
					}
				}
			}
		}
	}
	// Casing.
	const casing = [];
	for (const it of I) {
		// G2: casing is English only -- each locale keeps its own capitalisation.
		if (/^de-/.test(it.cfg)) continue;
		const ok = CASE_OK[it.casing]; if (!ok) continue;
		let t = (it.text || it.ph || '').trim(); if (!t || /^[\d\W]+$/.test(t) || USER.test(t) || /rel-build|rel-note|placeholder-example/.test(it.sig) || it.tag === 'input' && !it.ph) continue;
		// G4(d): an input's placeholder that is itself an example value ("github.com",
		// "someone@example.com") is not UI copy either.
		if (it.tag === 'input' && /^[\w.-]+(@[\w.-]+)?\.[a-z]{2,}$/.test(it.ph || '')) continue;
		if (it.st.tt === 'uppercase') t = t.toUpperCase(); else if (it.st.tt === 'lowercase') t = t.toLowerCase();
		if (CASE_ALLOW.some((re) => re.test(t))) continue;
		const c = casingOf(t); if (ok.includes(c)) continue;
		casing.push({ role: it.roleName, rule: it.casing, got: c, text: t.slice(0, 50), sig: it.sig, cfg: it.cfg, surfaces: it.surfaces.slice(0, 3) });
	}
	// Layout: glyph and icon gaps, left edges, sibling spacing, clipping, overlap.
	const layout = [];
	// G22: an avatar is not an inline icon.
	const ggaps = I.filter((it) => it.ggap != null && !/^tile-/.test(it.roleName) && !/^[+＋]$/.test(it.glyph || '') || it.glyph && /^[＋]$/.test(it.glyph)); const igaps = I.filter((it) => it.icon && it.icon.gap != null && it.text && !has(it, 'user-avatar'));
	const modeOf = (xs) => { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]; };
	for (const [kind, L, get] of [['glyph-gap', ggaps, (it) => Math.round(it.ggap)], ['icon-gap', igaps, (it) => Math.round(it.icon.gap)]]) {
		const byCfg = new Map(); for (const it of L) { if (!byCfg.has(it.cfg)) byCfg.set(it.cfg, []); byCfg.get(it.cfg).push(it); }
		for (const [cfg, X] of byCfg) { if (X.length < 2) continue; const [m] = modeOf(X.map(get));
			for (const it of X) if (Math.abs(get(it) - m) > 1.5) layout.push({ kind, cfg, canon: m + 'px', v: get(it) + 'px', sig: it.sig, text: it.text.slice(0, 40), glyph: it.glyph || 'svg', surfaces: it.surfaces.slice(0, 3), role: it.roleName }); }
	}
	// Siblings of one role under one parent: same left edge when stacked, same
	// height, same spacing; vertical centres level when in a row.
	// G14: a line-numbered source line's 1px row-to-row overlap is not uneven spacing.
	const sibs = new Map(); for (const it of items) { if (!it.view || it.cls.includes('lnrow')) continue; const k = it.surface + '|' + it.pk + '|' + it.roleName; if (!sibs.has(k)) sibs.set(k, []); sibs.get(k).push(it); }
	const seenLayout = new Set();
	const addL = (f) => { const k = f.kind + '|' + f.cfg + '|' + f.sig + '|' + f.v; if (seenLayout.has(k)) return; seenLayout.add(k); layout.push(f); };
	for (const [k, L] of sibs) {
		if (L.length < 2) continue; const cfg = cfgOf(L[0].surface), surf = L[0].surface.split('/')[1];
		const stacked = L.every((a, i) => i === 0 || a.r[1] >= L[i - 1].r[1] + L[i - 1].r[3] - 2);
		const inRow = L.every((a) => Math.abs(a.r[1] - L[0].r[1]) < Math.max(8, L[0].r[3] / 2));
		// Only neighbours: a head or a note of another role between two rows is a section break, not uneven spacing.
		const between = (a, b) => items.some((o) => o.surface === a.surface && o.pk === a.pk && o.roleName !== a.roleName && o.view && o.r[1] >= a.r[1] + a.r[3] - 1 && o.r[1] + o.r[3] <= b.r[1] + 1);
		if (stacked) {
			const [ml] = modeOf(L.map((a) => a.r[0]));
			for (const a of L) if (Math.abs(a.r[0] - ml) >= 2 && Math.abs(a.r[0] - ml) <= 24) addL({ kind: 'left-edge', cfg, canon: ml + 'px', v: a.r[0] + 'px', sig: a.sig, text: a.text.slice(0, 30), surfaces: [surf], role: a.roleName });
			if (L.length >= 3) { const g = []; for (let i = 1; i < L.length; i++) g.push(L[i].r[1] - (L[i - 1].r[1] + L[i - 1].r[3]));
				const [mg] = modeOf(g); g.forEach((x, i) => { if (mg <= 24 && Math.abs(x - mg) > 1.5 && Math.abs(x - mg) < 40 && !between(L[i], L[i + 1])) addL({ kind: 'row-spacing', cfg, canon: mg + 'px', v: x + 'px', sig: L[i + 1].sig, text: L[i + 1].text.slice(0, 30), surfaces: [surf], role: L[0].roleName }); }); }
		}
		if (inRow && L.length >= 2 && L[0].ctrl) {
			const cy = L.map((a) => a.r[1] + a.r[3] / 2); const [mc] = modeOf(cy.map(Math.round));
			L.forEach((a, i) => { if (Math.abs(cy[i] - mc) > 1.5) addL({ kind: 'row-centre', cfg, canon: 'centre ' + mc, v: 'centre ' + Math.round(cy[i]), sig: a.sig, text: a.text.slice(0, 30), surfaces: [surf], role: a.roleName }); });
			if (L.length >= 3) { // The gap is from the rounded RIGHT edge, not from a rounded left plus a rounded width: those two round apart, and a true gap of 8px
				// read 7 beside its neighbours' 9 (the footer strip's Agents chip, 289.4 after a chip of 71.6 at 209.9).
				const o = L.slice().sort((a, b) => a.r[0] - b.r[0]); const g = []; for (let i = 1; i < o.length; i++) g.push(o[i].r[0] - (o[i - 1].re !== undefined ? o[i - 1].re : o[i - 1].r[0] + o[i - 1].r[2]));
				const [mg] = modeOf(g); g.forEach((x, i) => { if (Math.abs(x - mg) > 1.5 && x < 60) addL({ kind: 'row-gap', cfg, canon: mg + 'px', v: x + 'px', sig: o[i + 1].sig, text: o[i + 1].text.slice(0, 30), surfaces: [surf], role: L[0].roleName }); }); }
		}
	}
	// Text left edges within one panel: heads, titles, rows and meta that start
	// within a few pixels of each other but not on the same pixel.
	// G15: text after a leading glyph (a chevron, dot or ▸) is compared by the
	// control's own box edge, not by the post-glyph text pixel, which wobbles a
	// few px with the glyph's own font metrics and reports a difference that
	// is not there. A right-aligned reading's left edge moves with its own
	// length by design, so it is never compared at all.
	// `.crystal-act` is led by a glyph ("+ Add a Section") and `#current-session-name` follows the Diamond's mark: both are compared by their box edge (5.2.9, S's finding: 395 against 392).
	const GLYROLE = (it) => /^summary\b|\btagf-toggle\b|#sys-head\b|\barte-strip\b|\bastat-val\b|#sync-rest\b|\bcrystal-act\b|#current-session-name\b/.test(it.sig);
	const RIGHTALIGN = (it) => /\bastat-aside\b|\brel-when\b|\bpptw-head-state\b/.test(it.sig);
	// G13: a text edge inside a card (a transcript tile, a history or tag row) is
	// that container's own edge, not the panel's -- so it is not compared to it.
	const textBySurf = new Map(); for (const o of items) { if (!o.view || o.tx == null || o.tcy == null) continue; if (!textBySurf.has(o.surface)) textBySurf.set(o.surface, []); textBySurf.get(o.surface).push(o); }
	const leftMate = (it) => (textBySurf.get(it.surface) || []).some((o) => o !== it && o.panel === it.panel && Math.abs(o.tcy - it.tcy) <= 4 && o.r[0] < it.r[0] && o.r[0] + o.r[2] <= it.r[0] + 2);
	const byPanel = new Map(); for (const it of items) { if (!it.view || it.tx == null || it.lines !== 1) continue; if (!/panel-title|section-head|list-row|meta|disclosure|body-text|create-button|text-button/.test(it.roleName)) continue;
		if (RIGHTALIGN(it)) continue;
		// A text edge is the left edge of a row's FIRST text. An item with another text-bearing item wholly to its left on the same line (a button
		// after a note, a unit after a field) is placed by that neighbour, not by the panel (5.2.9: `.ar-card-btn` after "No card saved.").
		if (leftMate(it)) continue;
		if (within(it, /ctile|crollup|mem-card|hist-row|tag-row|fileview|crystal-bar|link-sec|session-box|pptw-|rel-|mode-pop/)) continue;
		it.cmpx = GLYROLE(it) ? it.r[0] : it.tx;
		const k = it.surface + '|' + it.panel; if (!byPanel.has(k)) byPanel.set(k, []); byPanel.get(k).push(it); }
	for (const [k, L] of byPanel) {
		const xs = [...new Set(L.map((a) => a.cmpx))].sort((a, b) => a - b); const cnt = new Map(); for (const a of L) cnt.set(a.cmpx, (cnt.get(a.cmpx) || 0) + 1);
		for (const x of xs) { const near = xs.filter((y) => y !== x && Math.abs(y - x) <= 8 && (cnt.get(y) > cnt.get(x) || cnt.get(y) === cnt.get(x) && y < x));
			if (!near.length) continue; const to = near.sort((a, b) => cnt.get(b) - cnt.get(a))[0];
			for (const a of L.filter((a) => a.cmpx === x)) addL({ kind: 'text-edge', cfg: cfgOf(a.surface), canon: 'x ' + to, v: 'x ' + x, sig: a.sig, text: a.text.slice(0, 30), surfaces: [a.surface.split('/')[1]], role: a.roleName, panel: a.panel }); }
	}
	for (const it of I) if (it.clip) layout.push({ kind: 'clipped', cfg: it.cfg, canon: 'fits or ellipsis', v: it.clip, sig: it.sig, text: it.text.slice(0, 40), surfaces: it.surfaces.slice(0, 3), role: it.roleName });
	const ovs = new Map(); for (const f of faults) { const k = cfgOf(f.surface) + '|' + f.a + '|' + f.b; if (!ovs.has(k)) ovs.set(k, { kind: 'overlap', cfg: cfgOf(f.surface), canon: 'apart', v: f.b, sig: f.a, text: '', surfaces: [f.surface.split('/')[1]], role: f.panel }); }
	layout.push(...ovs.values());
	// A repeated component -- a diamond tile, a chat tile, the stage head, the
	// Workspace mode row -- keeps the same rows in the same order whatever it
	// says (layout_contract.md, D-20260929-03 followup, owner: "the chip list
	// in diamond tiles should start on its own line": a short model name left
	// room for the tags row to climb onto its own line, a longer one did not,
	// so the same tile drew two different shapes depending on what it
	// happened to hold). `CAPTURE` reads each instance's row bands straight
	// from the DOM (`a.tiles`, above `items` there and unfiltered by control
	// status, since a diamond tile's whole box is itself a control and
	// swallows its own children as items).
	//
	// `files-mode` never shares a line between two different parts, in a
	// fixed order. `tile` never shares one either, any more (V6, D-20260929-03
	// r526 residual pass): `model` and `meter` were DELIBERATELY the same grid
	// row through V1-V5 ("the model and the meter share the last line"), which
	// is exactly how a long model name came to push the meter's own left edge
	// sideways, tile to tile -- variable-length content sharing a line with
	// fixed content, the fault V1 itself was written to fix in `chips`. `model`
	// and `meter` are now two rows, never sharing one, like every other part
	// here. `stage-head` is the opposite kind of rule again: title and tools
	// MUST share one line once the panel has room (>460px, safely past the
	// 440px container-query breakpoint) -- the row splitting there with room
	// to spare, keyed to how long the title happens to be, is V5's bug.
	const ROWORDER = { tile: { title: 0, chips: 1, model: 2, meter: 3 }, 'files-mode': { chips: 0, acts: 1, msg: 2 },
		'device-row': { name: 0, copy: 0, rename: 0, ctl: 1, meta: 2 },
		'files-view-head': { name: 0, acts: 1 }, 'turn-interrupted': { label: 0, go: 1 } };
	const ROW0 = new Set(['name', 'copy', 'rename']);
	const SHARELINE = { 'device-row': (a, b) => ROW0.has(a) && ROW0.has(b) };
	const structure = [];
	for (const t of tiles) {
		const rows = Object.entries(t.rows).map(([part, [top, bot]]) => ({ part, top, bot })).sort((a, b) => a.top - b.top);
		if (rows.length < 2) continue;
		if (t.kind === 'stage-head') {
			if (t.w > 460) {
				const [title, tools] = rows[0].part === 'title' ? rows : [rows[1], rows[0]];
				if (tools.top >= title.bot - 1) structure.push({ kind: 'row-split', cfg: cfgOf(t.surface), canon: 'title and tools share one line (panel ' + t.w + 'px)', v: 'title and tools on separate lines', sig: t.sig, text: t.text, surfaces: [t.surface.split('/')[1]], role: 'stage-head' });
			}
			continue;
		}
		const order = ROWORDER[t.kind]; if (!order) continue;
		const okShare = SHARELINE[t.kind] || (() => false);
		for (let i = 1; i < rows.length; i++) {
			const a = rows[i - 1], b = rows[i];
			if (b.top < a.bot - 1) {
				if (okShare(a.part, b.part)) continue;
				structure.push({ kind: 'row-shared', cfg: cfgOf(t.surface), canon: a.part + ' then ' + b.part + ', apart', v: a.part + ' and ' + b.part + ' share one line', sig: t.sig, text: t.text, surfaces: [t.surface.split('/')[1]], role: t.kind + '-row' });
			} else if (order[b.part] < order[a.part]) {
				structure.push({ kind: 'row-order', cfg: cfgOf(t.surface), canon: Object.keys(order).join(', '), v: a.part + ' before ' + b.part, sig: t.sig, text: t.text, surfaces: [t.surface.split('/')[1]], role: t.kind + '-row' });
			}
		}
	}
	// V6 (D-20260929-03, r526 residual pass): the meter's first reading is
	// at ONE x across every tile, whatever the model name above it
	// measures -- the owner's rule generalised ("does variable length
	// content change the layout in a way that is not desirable?"),
	// checked here on the one instance this pass was raised over. Diamond
	// tiles and chat tiles are grouped apart: a diamond tile's own left
	// inset is not a chat tile's. FAILS on `0b5673fc` (the meter's x moved
	// with the model chip's length, on the old shared grid row).
	const meterXByGroup = new Map();
	for (const t of tiles) {
		// A phone surface with a chat or a file open keeps the rail's drawer in
		// the DOM, slid off-canvas by a transform `vis()` (above) does not
		// follow -- its tiles measure a large negative x, not a real position.
		if (t.kind !== 'tile' || !t.rows.meter || t.rows.meter[2] < 0) continue;
		const group = cfgOf(t.surface) + '|' + (/chat-box/.test(t.sig) ? 'chat' : 'diamond');
		if (!meterXByGroup.has(group)) meterXByGroup.set(group, []);
		meterXByGroup.get(group).push({ x: t.rows.meter[2], sig: t.sig, text: t.text, surface: t.surface });
	}
	for (const [group, L] of meterXByGroup) {
		if (L.length < 2) continue;
		const [cfg] = group.split('|');
		const [mx] = modeOf(L.map((a) => a.x));
		for (const a of L) if (Math.abs(a.x - mx) > 1) structure.push({ kind: 'meter-x', cfg, canon: 'x ' + mx, v: 'x ' + a.x, sig: a.sig, text: a.text.slice(0, 30), surfaces: [a.surface.split('/')[1]], role: 'tile-row' });
	}
	layout.push(...structure);
	// Merge the same finding across configs.
	const merge = (L, keyf) => { const m = new Map(); for (const f of L) { const k = keyf(f); const x = m.get(k); if (x) { if (!x.cfgs.includes(f.cfg)) x.cfgs.push(f.cfg); for (const s of f.surfaces) if (!x.surfaces.includes(s) && x.surfaces.length < 5) x.surfaces.push(s); } else m.set(k, { ...f, cfgs: [f.cfg], surfaces: [...f.surfaces] }); } return [...m.values()]; };
	const D = merge(diffs, (f) => [f.role, f.p, f.sig, f.text, f.canon.replace(/rgb[^)]*\)/, 'c'), f.v.replace(/rgb[^)]*\)/, 'c')].join('|'));
	const C = merge(casing, (f) => f.role + '|' + f.text);
	const Lx = merge(layout, (f) => [f.kind, f.sig, f.text, f.canon, f.v].join('|'));
	const unexplained = D.filter((d) => !d.allowed);
	// F10, rule 8: every control on a phone surface has a tap cross of at least 44 each way. One row per distinct control (role, element,
	// label), with the surfaces and configs it failed on; the worst reading is the one shown.
	const TAPMIN = 44, tapSeen = new Set(), tapRows = new Map();
	for (const t of taps) {
		const [role] = classify(t); t.roleName = role;
		const k = role + '|' + t.sig + '|' + t.text.slice(0, 30); tapSeen.add(k);
		if (t.hit[0] >= TAPMIN && t.hit[1] >= TAPMIN) continue;
		const surf = t.surface.split('/')[1], cfg = cfgOf(t.surface), x = tapRows.get(k);
		if (!x) { tapRows.set(k, { kind: 'tap', role, sig: t.sig, text: t.text.slice(0, 40), box: t.box, hit: t.hit, by: t.by, cfgs: [cfg], surfaces: [surf] }); continue; }
		if (!x.cfgs.includes(cfg)) x.cfgs.push(cfg);
		if (!x.surfaces.includes(surf) && x.surfaces.length < 8) x.surfaces.push(surf);
		if (t.hit[0] * t.hit[1] < x.hit[0] * x.hit[1]) { x.hit = t.hit; x.box = t.box; x.by = t.by; }
	}
	const Tx = [...tapRows.values()];
	const roleCount = new Map(); for (const it of I) roleCount.set(it.roleName, (roleCount.get(it.roleName) || 0) + 1);
	const summary = {
		surfaces: surfaces.length, missing, instances: I.length, roles: Object.fromEntries([...roleCount.entries()].sort((a, b) => b[1] - a[1])),
		styleDiffs: unexplained.length, allowedDiffs: D.length - unexplained.length, casing: C.length, layout: Lx.length, tap: Tx.length, tapMeasured: tapSeen.size,
		byRole: Object.fromEntries([...new Set(unexplained.map((d) => d.role))].map((r) => [r, unexplained.filter((d) => d.role === r).length])),
		layoutByKind: Object.fromEntries([...new Set(Lx.map((d) => d.kind))].map((r) => [r, Lx.filter((d) => d.kind === r).length])),
		tapByRole: Object.fromEntries([...new Set(Tx.map((d) => d.role))].map((r) => [r, Tx.filter((d) => d.role === r).length])),
		notCovered: notCovered.map((n) => n.label + ': ' + n.reason),
	};
	fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ summary, style: D, casing: C, layout: Lx, tap: Tx, unclassified: I.filter((i) => i.roleName === 'unclassified').map((i) => i.sig + ' ' + i.text) }, null, 1));
	// A readable table too.
	const md = ['# verify_consistency report', '', '```', JSON.stringify(summary, null, 1), '```', ''];
	for (const r of [...new Set(D.map((d) => d.role))]) {
		md.push(`## ${r}`, '', '| prop | canonical | deviant | element | text | where | cfgs | allowed |', '|---|---|---|---|---|---|---|---|');
		for (const d of D.filter((x) => x.role === r)) md.push(`| ${d.p} | ${d.canon} (${d.n}/${d.of}) | ${d.v} | \`${d.sig}\` | ${d.text} | ${d.surfaces.join(', ')} | ${d.cfgs.join(' ')} | ${d.allowed || ''} |`);
		md.push('');
	}
	md.push('## Casing', '', '| role | rule | got | text | element | where |', '|---|---|---|---|---|---|');
	for (const c of C) md.push(`| ${c.role} | ${c.rule} | ${c.got} | ${c.text} | \`${c.sig}\` | ${c.surfaces.join(', ')} ${c.cfgs.join(' ')} |`);
	md.push('', '## Layout', '', '| kind | canonical | deviant | element | text | where | cfgs |', '|---|---|---|---|---|---|---|');
	for (const l of Lx) md.push(`| ${l.kind} | ${l.canon} | ${l.v} | \`${l.sig}\` | ${l.text} | ${l.surfaces.join(', ')} | ${l.cfgs.join(' ')} |`);
	md.push('', '## Tap areas', '', `Tap cross under ${TAPMIN}px either way, ${Tx.length} of ${tapSeen.size} distinct controls measured on phone surfaces.`, '',
		'| role | element | text | box (x y w h) | hit (w×h) | covered by | cfgs | where |', '|---|---|---|---|---|---|---|---|');
	for (const t of Tx.sort((a, b) => a.role.localeCompare(b.role) || a.sig.localeCompare(b.sig))) md.push(`| ${t.role} | \`${t.sig}\` | ${t.text} | ${t.box.join(' ')} | ${t.hit.join('×')} | ${t.by ? '`' + t.by + '`' : ''} | ${t.cfgs.join(' ')} | ${t.surfaces.join(', ')} |`);
	fs.writeFileSync(`${OUT}/report.md`, md.join('\n'));
	log('report', `${OUT}/report.md`, JSON.stringify(summary));
	const bad = unexplained.length + C.length + Lx.length + missing.length + Tx.length;
	return { bad, notCovered, parts: { style: unexplained.length, casing: C.length, layout: Lx.length, missing: missing.length, tap: Tx.length } };
}

// ════════════════════════════════════════════════════════════════════════
// VARLEN (D-20260929-03 ~19:20, owner: "does variable length content change
// the layout in a way that is not desirable?"). Every slot whose content
// varies is set short, long and very long, ONE AT A TIME with everything else
// held, and every change to any OTHER part is recorded: position, size, row,
// wrapping, clipping, overlap, and alignment against the same part in sibling
// instances. The slot's own truncation or wrap is recorded, not flagged. The
// verdict on each change is a person's; this only makes sure none goes unseen.
//
//   node dev/verify_consistency.mjs varlen [desk|phone|webkit|report]  (default: seed, desk, phone, webkit, report)
// ════════════════════════════════════════════════════════════════════════
const V_NAME  = ['Tax', 'Kitchen renovation for the Leederville house', 'Kitchen renovation for the Leederville house, stage two: joinery-benchtop-splashback-laundry-ensuite'];
const V_MODEL = ['gpt-5', 'anthropic/claude-opus-5.5', 'anthropic/claude-opus-5.5-extended-context-preview-20260929'];
const V_SAID  = ['Too long.', 'Just give me the command next time, and skip the explanation of every flag it takes.', 'Please keep every answer to what was asked and no more. '.repeat(11) + 'https://example.com/' + 'a'.repeat(80)];
const V_CHIP  = ['tax', 'committee-review', 'leederville-kitchen-renovation-stage-two'];
const V_TIME  = ['1m ago', '3 weeks ago', '2 years, 11 months ago'];
const V_COST  = ['$0.01', 'A$1,234.56', 'A$1,234,567.89'];
const V_TOK   = ['12 tok', '1.2M tok', '123,456,789 tok'];
const V_FILE  = ['a.md', 'kitchen-renovation-quotes-final.md', 'a-very-long-file-name-for-the-kitchen-renovation-final-v3-with-benchtop-and-splashback.md'];
const V_DIR   = ['q', 'joinery-and-benchtop-quotes', 'joinery-and-benchtop-quotes-from-every-supplier-we-spoke-to-in-2026'];
const V_ACCT  = ['al', 'Alexandra Montgomery-Whitfield', 'Alexandra Montgomery-Whitfield (Leederville office, second laptop)'];
const V_SYNC  = ['Synced 2m ago', 'Last synced 3 hours ago on this device', 'Sync paused: the gateway refused the last push (quota exceeded for this account), retrying in 4 minutes'];
const V_STAT  = ['Local', 'gpt-5 · 12,345 tok · A$1,234.56 today', 'anthropic/claude-opus-5.5-extended-context-preview · 123,456,789 tok · A$1,234,567.89 today'];
const V_BTN   = ['New', 'Neuer Diamant', 'Nouveau diamant de travail partagé avec toute l’équipe'];
const V_OK    = ['OK', 'Diamant erstellen', 'Créer le diamant et l’ouvrir dans un nouvel onglet'];
const V_MODE  = ['Guarded', 'Ask every time', 'Demander à chaque fois'];
// [name, ctx, comp, slot, values, pick, setup]. `slot` '' = the comp itself;
// `pick` chooses the instance by its text; values `{count}` vary a list's length.
const VSLOTS = [
	['diamond name',        '#diamond-list', '.diamond-box', '.session-box-name', V_NAME, /Tax return/],
	['diamond model',       '#diamond-list', '.diamond-box', '.tile-model-chip', V_MODEL, /Tax return/],
	['diamond chip label',  '#diamond-list', '.diamond-box', '.session-box-tags .tag-chip', V_CHIP, /Kitchen renovation$|home/],
	['diamond chip count',  '#diamond-list', '.diamond-box', '.session-box-tags', { count: [1, 5, 14] }, /Kitchen renovation$|home/],
	['diamond meter time',  '#diamond-list', '.diamond-box', '.diamond-meter .session-box-time', V_TIME, /Tax return/],
	['diamond meter last',  '#diamond-list', '.diamond-box', '.diamond-meter > :last-child', V_COST, /Tax return/],
	['chat name',           '#session-list', '.chat-box', '.tile-when', V_NAME, /Flights/],
	['chat model',          '#session-list', '.chat-box', '.tile-model-chip', V_MODEL, /Flights/],
	['chat meter tokens',   '#session-list', '.chat-box', '.tile-tok', V_TOK, /Flights/],
	['chat meter last',     '#session-list', '.chat-box', '.tile-meter > :last-child', V_COST, /Flights/],
	['rail filter chip',    '#panel-rail', '.tagf-pool', '.tag-chip', V_CHIP, null, 'filter'],
	['rail button label',   '#panel-rail', '.railhead', '#new-diamond-btn', V_BTN, null],
	['account name',        '#admin-status', '.astat-id', '#user-info', V_ACCT, null],
	['status summary',      '#admin-status', '#admin-status', '#astat-summary', V_STAT, null],
	['sync line',           '#admin-status', '#astat-detail', '#sync-rest', V_SYNC, null, 'astat'],
	['chat title',          '#panel-ai', '.chead', '.ctitle', V_NAME, null, 'chat'],
	['file name',           '#panel-work', '.files-row', '.files-name', V_FILE, /budget\.csv/, 'work'],
	['folder name',         '#panel-work', '.files-row', '.files-name', V_DIR, /^\W*quotes/, 'work'],
	['file viewer title',   '#panel-doc', '.chead, .files-view-head', '.ctitle, .files-view-name', V_FILE, null, 'viewer'],
	['tile dialog title',   'OVERLAY', '.ui-head', 'h2', V_NAME, null, 'cog'],
	['dialog action label', 'OVERLAY', '.dlg-actions, .modal-actions, .tile-dlg-actions', '.dlg-ok', V_OK, null, 'newdia'],
	// U2 (plan unit I).
	['answer model, rated', '#chat-output', '.ctile.chat-msg-assistant', '.ctile-meta', V_MODEL, /Harlow/, 'chat'],
	['rating note',         '#chat-output', '.ctile[data-t="rating"]', '.rate-said', V_SAID, null, 'chat'],
	['rating tile lines',   '#chat-output', '.ctile[data-t="rating"]', '.chat-msg-content', { count: [1, 5, 14] }, null, 'chat'],
	['rate chip label',     '#chat-output', '.ctile-rate-tags', '.tile-dlg-level', V_CHIP, null, 'ratetags'],
	['rate popup chip label', 'OVERLAY', '.ctile-rate-tags', '.tile-dlg-level', V_CHIP, null, 'ratepop'],
	['rate popup model',    'OVERLAY', '.rate-where', '', V_MODEL, null, 'ratepop'],
	// 5.2.9 (G1): the chat head. The mode chip's word, and a Diamond's title on its crystal face. The head's tools and the mode chip keep one
	// x for every title and every word (rule 3); `.chead` is the comp, so the whole head is read for what moves.
	['mode word',           '#panel-ai', '.chead', '#hand-mode-chip .mode-chip-txt', V_MODE, null, 'chat'],
	['diamond head title',  '#panel-ai', '.chead', '.ctitle', V_NAME, null, 'diamond'],
];
// Whole surfaces re-read in each locale: every label at once, en against de and fr.
const VLOCALE = [['rail', '#panel-rail'], ['chat head', '#panel-ai > .chead'], ['workspace', '#panel-work', 'work'], ['composer', '.chat-input-bar'], ['topbar', '.topbar'], ['new diamond dialog', 'OVERLAY', 'newdia'], ['admin', '#admin', 'admin'], ['rate popup', 'OVERLAY', 'ratepop'], ['rate chips', '#chat-output', 'ratetags'],
	// The phone's ⋯ menu in en, de and fr. Phone only: on a computer the head has no ⋯, which is "not applicable", not NOT COVERED.
	['chat head menu', 'OVERLAY', 'headmore']];

// In the page: set (or restore) one slot, then read every part's geometry.
const VMEASURE = ({ ctx, comp, slot, idx, pick, text, count, restore }) => {
	const W = window.__vl = window.__vl || {};
	const cs = (e) => getComputedStyle(e);
	const vis = (e) => { if (!e.getClientRects().length) return false; const s = cs(e); if (s.visibility === 'hidden' || +s.opacity === 0) return false; const r = e.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; };
	if (restore) { for (const f of (W.undo || []).reverse()) f(); W.undo = []; return { ok: 1 }; }
	const C = ctx === 'OVERLAY' ? W.ov : document.querySelector(ctx);
	if (!C || !vis(C)) return { miss: 'ctx ' + ctx };
	const comps = [...(C.matches(comp) ? [C] : []), ...C.querySelectorAll(comp)].filter(vis);
	let ti = comps.findIndex((c) => (!slot || c.querySelector(slot) || c.matches(slot)) && (!pick || new RegExp(pick.s, pick.f).test(c.textContent.trim())));
	if (idx != null) ti = idx;
	if (ti < 0) return { miss: 'slot ' + slot + (pick ? ' ' + pick.s : '') };
	const T = comps[ti];
	if (idx == null && text == null && count == null) T.scrollIntoView({ block: 'center' });
	const S = slot ? (T.matches(slot) ? T : T.querySelector(slot)) : T;
	W.undo = W.undo || [];
	if (text != null) {
		const tw = document.createTreeWalker(S, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.nodeValue.trim() ? 1 : 3 });
		const n = tw.nextNode();
		if (n) { const o = n.nodeValue; n.nodeValue = text; W.undo.push(() => { n.nodeValue = o; }); }
		else { const o = S.textContent; S.textContent = text; W.undo.push(() => { S.textContent = o; }); }
	}
	if (count != null) {
		const k = [...S.children]; const proto = k[0]; if (!proto) return { miss: 'no child to count' };
		const words = ['home', 'research', 'writing', 'citations', 'committee', 'deadline', 'thesis', 'budget', 'joinery', 'tiles', 'power', 'window', 'quotes', 'may'];
		k.forEach((c) => { c.style.display = 'none'; });
		const add = []; for (let i = 0; i < count; i++) { const c = proto.cloneNode(true); c.style.display = ''; const tw = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.nodeValue.trim() ? 1 : 3 }); const n = tw.nextNode(); if (n) n.nodeValue = words[i % words.length]; S.appendChild(c); add.push(c); }
		W.undo.push(() => { add.forEach((c) => c.remove()); k.forEach((c) => { c.style.display = ''; }); });
	}
	void document.body.offsetHeight;
	const cr = C.getBoundingClientRect();
	const path = (e, root) => { const p = []; for (let a = e; a && a !== root; a = a.parentElement) { const c = (typeof a.className === 'string' ? a.className : '').trim().split(/\s+/)[0]; const par = a.parentElement; const i = par ? [...par.children].indexOf(a) : 0; p.unshift(a.tagName.toLowerCase() + (a.id ? '#' + a.id : c ? '.' + c : '') + ':' + i); } return p.join('>'); };
	const cls = (e) => { const c = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/)[0]; return e.tagName.toLowerCase() + (e.id ? '#' + e.id : c ? '.' + c : ''); };
	const lines = (e) => { const rg = document.createRange(); rg.selectNodeContents(e); const tops = new Set(); for (const q of rg.getClientRects()) if (q.width > 0.5) tops.add(Math.round(q.top)); return tops.size; };
	// The part's box cut to every clipping ancestor up to the ctx: how much of it can be seen.
	const shown = (e) => { const r = e.getBoundingClientRect(); let l = r.left, t = r.top, rr = r.right, b = r.bottom;
		for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) { const s = cs(a); if (!/hidden|clip|auto|scroll/.test(s.overflowX + s.overflowY)) continue; const q = a.getBoundingClientRect(); l = Math.max(l, q.left); t = Math.max(t, q.top); rr = Math.min(rr, q.right); b = Math.min(b, q.bottom); }
		const area = Math.max(0, rr - l) * Math.max(0, b - t), full = r.width * r.height; return full ? Math.round(100 * area / full) : 100; };
	const CTRL = 'button, [role="button"], a[href], input, select, textarea, summary, svg, img, canvas';
	const leaves = (root, skip, pr) => { const out = []; for (const e of [root, ...root.querySelectorAll('*')]) {
		if (e.closest('svg') && e.tagName !== 'svg') continue; if (skip && skip(e)) continue; if (!vis(e)) continue;
		const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
		const kids = [...e.children].some(vis);
		if (!own && kids && !e.matches(CTRL)) continue;
		const r = e.getBoundingClientRect(), s = cs(e);
		out.push({ k: path(e, pr || C), c: cls(e), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), ln: own ? lines(e) : 0,
			ov: e.scrollWidth > e.clientWidth + 1 && /hidden|clip/.test(s.overflowX) ? (s.textOverflow === 'ellipsis' ? 'ellipsis' : 'cut') : '', sh: shown(e), t: own ? e.textContent.trim().slice(0, 24) : '' });
		if (out.length > 400) break; } return out; };
	const inSlot = slot ? (e) => S.contains(e) || e.contains(S) : null;
	const sr = S.getBoundingClientRect(), trr = T.getBoundingClientRect();
	const sib = comps.filter((c, i) => i !== ti).slice(0, 4);
	return {
		ti, n: comps.length, hscroll: document.documentElement.scrollWidth > innerWidth + 1 ? document.documentElement.scrollWidth - innerWidth : 0,
		ctxOver: C.scrollWidth > C.clientWidth + 1 && !/auto|scroll/.test(cs(C).overflowX) ? C.scrollWidth - C.clientWidth : 0,
		comp: { x: Math.round(trr.left), y: Math.round(trr.top), w: Math.round(trr.width), h: Math.round(trr.height), over: T.scrollWidth > T.clientWidth + 1 ? T.scrollWidth - T.clientWidth : 0 },
		slot: { x: Math.round(sr.left), y: Math.round(sr.top), w: Math.round(sr.width), h: Math.round(sr.height), ln: lines(S), ov: S.scrollWidth > S.clientWidth + 1 ? (cs(S).textOverflow === 'ellipsis' ? 'ellipsis' : 'cut') : '', sh: shown(S), past: Math.round(Math.max(0, sr.right - trr.right)) },
		parts: leaves(T, inSlot, T),
		sibs: sib.map((c) => leaves(c, null, c)),
		outside: leaves(C, (e) => comps.some((c) => c.contains(e))).slice(0, 200),
		clip: [Math.max(0, Math.round(trr.left) - 16), Math.max(0, Math.round(trr.top) - 12), Math.round(trr.width) + 32, Math.round(trr.height) + 24],
		ctxClip: [Math.max(0, Math.round(cr.left)), Math.max(0, Math.round(cr.top)), Math.round(Math.min(cr.width, innerWidth)), Math.round(Math.min(cr.height, innerHeight))],
	};
};

async function vSetup(kind) {
	await quiet();
	if (kind === 'astat') { await ev(() => { const d = document.getElementById('astat-detail'); if (d && d.hidden) document.getElementById('astat-summary').click(); }); await wait(300); }
	if (kind === 'chat') { await mainChat(); }
	if (kind === 'ratetags' || kind === 'ratepop') {
		await mainChat();
		const at = (first) => ev((first) => { const t = [...document.querySelectorAll('#chat-output .ctile.chat-msg-assistant[data-mid]')].filter((e) => e.querySelector('.ctile-rate')); const x = first ? t[0] : t[t.length - 1]; if (x) x.scrollIntoView({ block: 'center' }); return x ? x.dataset.mid : ''; }, first);
		if (kind === 'ratetags') {
			// A down tap on a down rating takes it back, so tap again if no chip row came (an earlier pass leaves its rating committed).
			const m = await at(false), down = page.locator(`#chat-output .ctile[data-mid="${m}"] .ctile-rate-down >> visible=true`).first();
			const row = () => ev(() => [...document.querySelectorAll('#chat-output .ctile-rate-tags')].some((e) => e.getClientRects().length > 0));
			await down.click({ force: true }); await wait(400);
			if (!(await row())) { await down.click({ force: true }); await wait(400); }
		}
		else { const m = await at(true); await page.locator(`#chat-output .ctile[data-mid="${m}"] .ctile-rate-more >> visible=true`).first().click({ force: true }); await wait(600); }
	}
	if (kind === 'filter') { await ev(() => { document.querySelectorAll('#panel-rail .tagf-toggle[aria-expanded="false"], #panel-rail .rail-fold[aria-expanded="false"]').forEach((b) => b.click()); document.querySelectorAll('#panel-rail details').forEach((d) => { d.open = true; }); }); await wait(400); }
	if (kind === 'viewer') {
		await ev(() => { const row = [...document.querySelectorAll('.files-row')].find((x) => /^\s*notes\.md/.test((x.querySelector('.files-name') || x).textContent)); if (row) (row.querySelector('.files-name') || row).click(); });
		await wait(1400);
	}
	if (kind === 'diamond') {
		// The Kitchen Diamond on its crystal face, picked as a person would: from the drawer on a phone.
		const ph = page.viewportSize().width <= 760;
		if (ph) { await ev(() => { if (!document.body.classList.contains('drawer-open')) { const b = document.getElementById('drawer-btn'); if (b) b.click(); } }); await wait(800); }
		const hit = await ev(() => { const t = [...document.querySelectorAll('#diamond-list .diamond-box')].find((e) => /Kitchen/.test(e.getAttribute('aria-label') || e.textContent)); if (!t) return false; (t.querySelector('.tile-label') || t).click(); return true; });
		// A device that holds no Diamond (WebKit has no file store; see `webkitPair`) has no head to measure. Measuring the chat's head under this
		// slot's name would be a pass on the wrong element.
		if (hit !== true) return 'no Diamond on this device';
		await wait(1200); await click('#dview-crystal'); await wait(1200);
	}
	if (kind === 'headmore') { await mainChat(); await click('#chead-more'); await wait(700); }
	if (kind === 'cog') { await click('#diamond-list .diamond-box .tile-cog'); await wait(700); }
	if (kind === 'newdia') { await click('#new-diamond-btn'); await wait(700); }
	if (kind === 'admin') { await click('#settings-btn'); await wait(700); await ev(() => { try { window.DaimondAdmin.home(); } catch (e) {} }); await wait(500); }
	if (['cog', 'newdia', 'admin', 'ratepop', 'headmore'].includes(kind)) { const ov = kind === 'admin' ? '#admin' : await topOverlay(); await ev((q) => { window.__vl = window.__vl || {}; window.__vl.ov = q && document.querySelector(q); }, ov); }
}
async function vShot(name, clip) {
	if (!clip) return '';
	const f = `${OUT}/varlen_shots/${CFG}_${name.replace(/\W+/g, '_')}.png`;
	const vp = page.viewportSize();
	const [x, y, w, h] = clip; const c = { x, y, width: Math.max(8, Math.min(w, vp.width - x)), height: Math.max(8, Math.min(h, vp.height - y)) };
	await page.screenshot({ path: f, clip: c, animations: 'disabled' }).catch(() => {});
	return f;
}
async function varlenPass(phone) {
	fs.mkdirSync(`${OUT}/varlen_shots`, { recursive: true });
	const recs = [];
	const railOpen = async () => { if (phone) { await ev(() => { if (!document.body.classList.contains('drawer-open')) { const b = document.getElementById('drawer-btn'); if (b) b.click(); } }); await wait(800); } };
	const place = async (setup, ctx) => {
		await quiet();
		if (phone) { await ev(() => { document.body.classList.remove('drawer-open'); }); await wait(300); }
		if (!phone) await panels(['rail', 'ai', 'work']);
		if (phone && setup === 'work') { await ev(() => { try { window.DaimondPanels.show('work'); } catch (e) {} }); await wait(700); }
		else if (phone && setup === 'viewer') { await ev(() => { try { window.DaimondPanels.show('work'); } catch (e) {} }); await wait(700); }
		else if (phone && (['chat', 'ratetags', 'ratepop', 'headmore'].includes(setup) || /panel-ai|chat-input/.test(ctx))) { await ev(() => { try { window.DaimondPanels.show('ai'); } catch (e) {} }); await wait(400); }
		else if (phone && /rail|diamond-list|session-list|admin-status|topbar/.test(ctx) || phone && ['cog', 'newdia'].includes(setup)) await railOpen();
		const miss = setup ? await vSetup(setup) : null;
		if (miss) return miss;
		if (/admin-status/.test(ctx)) await ev(() => { const a = document.getElementById('admin-status'); if (a) a.scrollIntoView({ block: 'end' }); });
		if (/diamond-list|session-list/.test(ctx)) await ev((q) => { const a = document.querySelector(q); if (a) a.scrollIntoView({ block: 'start' }); }, ctx);
		await wait(200);
	};
	// A `ratetags` setup taps a down rating and leaves its chip row up as a DRAFT; the row is taken away when the burst commits, BURST_MS of
	// quiet later, under whatever is being measured by then (a pending rating's row vanished mid-pass and read as movement in the slot after
	// it: QA2 Q7). So the pass lets it commit, with a margin, before the next slot's base read. The page's own figure, 10 s if it is unreadable.
	let draft = false;
	const letCommit = async () => {
		const ms = await ev(() => window.DaimondRatings && window.DaimondRatings.BURST_MS);
		await wait((typeof ms === 'number' ? ms : 10000) + 100);
		draft = false;
	};
	for (const [name, ctx, comp, slot, vals, pick, setup] of VSLOTS) {
		if (draft) await letCommit();
		const gone = await place(setup, ctx);
		draft = setup === 'ratetags';
		if (gone) { recs.push({ name, cfg: CFG, notCovered: gone }); log('varlen', CFG, name, 'NOT COVERED', gone); continue; }
		const pk = pick ? { s: pick.source, f: pick.flags } : null;
		const base = await ev(VMEASURE, { ctx, comp, slot, pick: pk });
		if (!base || base.err || base.miss) { recs.push({ name, cfg: CFG, notCovered: (base && (base.err || base.miss)) || 'no measure' }); log('varlen', CFG, name, 'NOT COVERED', base && (base.miss || base.err)); continue; }
		const shots = { base: await vShot(name + '_base', base.clip) };
		const variants = [];
		const V = Array.isArray(vals) ? vals.map((v, i) => [['short', 'long', 'vlong'][i], { text: v }]) : vals.count.map((n, i) => [['few', 'several', 'many'][i], { count: n }]);
		for (const [vn, arg] of V) {
			const m = await ev(VMEASURE, { ctx, comp, slot, idx: base.ti, ...arg });
			if (m && !m.err && !m.miss) { shots[vn] = await vShot(name + '_' + vn, m.clip); variants.push([vn, m]); }
			await ev(VMEASURE, { restore: 1 });
		}
		recs.push({ name, cfg: CFG, base, variants, shots });
		log('varlen', CFG, name, 'variants', variants.length);
	}
	// Every label at once: en, then de and fr, the same surface re-read.
	for (const [name, ctx, setup] of VLOCALE) {
		if (draft) await letCommit();
		if (setup === 'headmore' && !phone) { recs.push({ name: 'locale: ' + name, cfg: CFG, na: 'phone only: a computer\'s head has no ⋯ menu' }); log('varlen', CFG, 'locale', name, 'not applicable'); continue; }
		const by = {};
		for (const loc of ['en', 'de', 'fr']) {
			await ev((l) => window.DaimondI18n && window.DaimondI18n.setLocale(l), loc); await wait(900);
			await place(setup, ctx);
			const m = await ev(VMEASURE, { ctx, comp: ctx === 'OVERLAY' ? '*' : ctx, slot: '', idx: 0 });
			if (m && !m.err && !m.miss) { m.shot = await vShot('locale_' + name + '_' + loc, m.ctxClip); by[loc] = m; }
		}
		await ev(() => window.DaimondI18n && window.DaimondI18n.setLocale('en')); await wait(700);
		recs.push({ name: 'locale: ' + name, cfg: CFG, locale: by, notCovered: by.en ? null : 'no surface' });
		log('varlen', CFG, 'locale', name, Object.keys(by).join(','));
		draft = setup === 'ratetags';
	}
	if (draft) await letCommit();
	await quiet();
	return recs;
}
async function varlenRun(which) {
	let s, lead = null;
	if (which === 'webkit') {
		try {
			({ lead, s } = await webkitPair());
			if (!(await webkitSync(lead, s))) throw new Error('the paired content did not arrive within 60 s');
		} catch (e) {
			log('varlen webkit: pairing unavailable, NOT COVERED:', e.message.split('\n')[0]);
			fs.writeFileSync(`${OUT}/varlen_webkit.json`, JSON.stringify([{ name: 'webkit (all slots)', cfg: 'webkit', notCovered: 'pairing/seeding unavailable under this harness: ' + e.message.split('\n')[0] }]));
			if (s) await s.close().catch(() => {}); if (lead) await lead.close().catch(() => {}); return;
		}
	} else s = await open({ name: 'alex', profile: PROF, ...(which === 'phone' ? { touch: true, connect: false, isMobile: true } : {}) });
	page = s.page;
	await page.setViewportSize(which === 'desk' ? { width: 1440, height: 900 } : { width: 390, height: 844 });
	await wait(1200); await view('max');
	CFG = `varlen-${which}-obsidian`; await wear('obsidian');
	const recs = await varlenPass(which !== 'desk');
	fs.writeFileSync(`${OUT}/varlen_${which}.json`, JSON.stringify(recs));
	await s.close(); if (lead) await lead.close().catch(() => {});
}
// Diff each variant against the slot's own baseline and list every change to
// another part. The `flag` is a first sort for the reader, not the verdict.
function varlenReport() {
	const recs = ['desk', 'phone', 'webkit'].map((w) => `${OUT}/varlen_${w}.json`).filter((f) => fs.existsSync(f)).flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
	const out = [];
	const cmp = (a, b, where) => { const m = new Map(a.map((p) => [p.k, p])); const ch = [];
		for (const q of b) { const p = m.get(q.k); if (!p) continue;
			const d = { dx: q.x - p.x, dy: q.y - p.y, dw: q.w - p.w, dh: q.h - p.h };
			const kinds = [];
			if (Math.abs(d.dx) > 1) kinds.push('x-shift'); if (Math.abs(d.dy) > 1) kinds.push('y-shift');
			if (d.dw < -1) kinds.push('squeezed'); if (d.dw > 1) kinds.push('widened'); if (Math.abs(d.dh) > 1) kinds.push('height');
			if (q.ln > p.ln) kinds.push('wraps'); if (q.ov !== p.ov && q.ov) kinds.push(q.ov === 'cut' ? 'clipped' : 'ellipsised');
			if (q.sh < p.sh - 5) kinds.push('hidden ' + p.sh + '→' + q.sh + '%');
			if (kinds.length) ch.push({ where, part: q.c, text: q.t || p.t, k: q.k, ...d, kinds });
		}
		for (const p of a) if (!b.some((q) => q.k === p.k)) ch.push({ where, part: p.c, text: p.t, k: p.k, kinds: ['vanished'] });
		return ch; };
	for (const r of recs) {
		if (r.na) { out.push({ name: r.name, cfg: r.cfg, na: r.na }); continue; }
		if (r.notCovered) { out.push({ name: r.name, cfg: r.cfg, notCovered: r.notCovered }); continue; }
		if (r.locale) {
			const en = r.locale.en;
			for (const loc of ['de', 'fr']) { const m = r.locale[loc]; if (!m) continue;
				const ch = cmp(en.parts, m.parts, 'surface').filter((c) => !(c.kinds.length === 1 && c.kinds[0] === 'x-shift' && Math.abs(c.dx) < 400) && !(c.kinds.every((k) => /widened|squeezed/.test(k))));
				out.push({ name: r.name, cfg: r.cfg, variant: loc, hscroll: m.hscroll, ctxOver: m.ctxOver, changes: ch, shot: m.shot, base: en.shot }); }
			continue;
		}
		for (const [vn, m] of r.variants) {
			const inComp = cmp(r.base.parts, m.parts, 'comp');
			const outside = cmp(r.base.outside, m.outside, 'ctx');
			// Siblings: the same part's x in every sibling instance, held against the target's.
			const align = [];
			for (const p of m.parts) { const bp = r.base.parts.find((z) => z.k === p.k); if (!bp) continue; const rel = p.k;
				for (const sl of m.sibs) { const q = sl.find((z) => z.k === rel); if (!q) continue; if (Math.abs(bp.x - q.x) <= 1 && Math.abs(p.x - q.x) > 1) { align.push({ part: p.c, text: p.t, sibX: q.x, x: p.x }); break; } } }
			const own = { ln: [r.base.slot.ln, m.slot.ln], ov: m.slot.ov, sh: m.slot.sh, past: m.slot.past, dh: m.comp.h - r.base.comp.h, dw: m.comp.w - r.base.comp.w, over: m.comp.over };
			out.push({ name: r.name, cfg: r.cfg, variant: vn, own, hscroll: m.hscroll, ctxOver: m.ctxOver, changes: inComp.concat(outside), align, shot: r.shots[vn], base: r.shots.base });
		}
	}
	fs.writeFileSync(`${OUT}/varlen_report.json`, JSON.stringify(out, null, 1));
	// A compact table, one line per slot and variant, for the reader's pass.
	const md = ['# varlen', ''];
	for (const o of out) {
		if (o.na) { md.push(`- **${o.name}** (${o.cfg}): not applicable -- ${o.na}`); continue; }
		if (o.notCovered) { md.push(`- **${o.name}** (${o.cfg}): NOT COVERED -- ${o.notCovered}`); continue; }
		const ch = o.changes.map((c) => `${c.where}:${c.part}${c.text ? '"' + c.text.slice(0, 14) + '"' : ''}[${c.kinds.join('+')}${c.dx ? ' dx' + c.dx : ''}${c.dy ? ' dy' + c.dy : ''}${c.dw ? ' dw' + c.dw : ''}${c.dh ? ' dh' + c.dh : ''}]`);
		md.push(`- **${o.name}** ${o.variant} (${o.cfg})${o.own ? ` own: lines ${o.own.ln.join('→')}${o.own.ov ? ' ' + o.own.ov : ''}${o.own.sh < 100 ? ' shown ' + o.own.sh + '%' : ''}${o.own.past ? ' past-tile ' + o.own.past + 'px' : ''} tile dh${o.own.dh} dw${o.own.dw}${o.own.over ? ' tile-overflow ' + o.own.over : ''}` : ''}${o.hscroll ? ' PAGE-HSCROLL ' + o.hscroll : ''}${o.ctxOver ? ' CTX-OVERFLOW ' + o.ctxOver : ''}`);
		if (ch.length) md.push('  - ' + ch.slice(0, 14).join(' ') + (ch.length > 14 ? ` (+${ch.length - 14})` : ''));
		if (o.align && o.align.length) md.push('  - misaligned vs siblings: ' + o.align.map((a) => `${a.part} x${a.x} vs ${a.sibX}`).join(', '));
	}
	fs.writeFileSync(`${OUT}/varlen_report.md`, md.join('\n'));
	log('varlen report', `${OUT}/varlen_report.md`, out.length, 'rows');
}


// ════════════════════════════════════════════════════════════════════════
// DIFF (I1, carry r529). `diff <runA> <runB> <cfgPrefix> [rootSel]` holds two saved
// captures side by side and prints every element that differs, so "computers are
// unchanged" is a measurement and not a promise. An element is paired with its
// namesake on the same surface (signature, then order). What is compared: its
// box, its computed style, its classes and ancestry, its text position and gaps.
// What is not: its words and aria (they change with the day and the locale), the
// per-run keys, and the random id a top overlay is given. A run is a name that
// resolves to <parent of CONS_OUT>/cons_<name>, or a directory. `cfgPrefix`
// selects configs by their start ('desk' is desk-obsidian and desk-porcelain; a
// comma lists several); `rootSel` keeps elements that are, or sit under, the
// selector's id or class text (e.g. '#panel-rail').
// ════════════════════════════════════════════════════════════════════════
function diffRuns() {
	const [ra, rb, pre, rootSel] = process.argv.slice(3);
	if (!ra || !rb || !pre) { log('usage: diff <runA> <runB> <cfgPrefix> [rootSel]'); process.exit(2); }
	const dirOf = (x) => (fs.existsSync(x) && fs.statSync(x).isDirectory() ? x : path.join(path.dirname(OUT), 'cons_' + x));
	const A = dirOf(ra), B = dirOf(rb);
	const prefixes = pre.split(',');
	const norm = (v) => (typeof v === 'string' ? v.replace(/cons-ov-[a-z0-9]{5}/g, 'cons-ov-X') : v);
	// Wall-clock words ("3m ago", "Synced 2m ago", "14:05") differ between runs by the clock alone.
	const CLOCK = /\b\d+\s*(s|m|h|d|w|mo|y|sec|min|mins|hr|hrs|days?|weeks?|months?|years?)\b|\bago\b|\b\d{1,2}:\d{2}\b|\bjust now\b|\btoday\b|\byesterday\b/i;
	const read = (dir) => {
		const m = new Map();
		for (const n of ['desk', 'phone', 'webkit']) {
			const f = `${dir}/cap_${n}.json`; if (!fs.existsSync(f)) continue;
			for (const it of JSON.parse(fs.readFileSync(f, 'utf8')).items) {
				const cfg = it.surface.split('/')[0];
				if (!prefixes.some((x) => cfg.startsWith(x))) continue;
				if (rootSel && !(norm(it.sig).includes(rootSel.replace(/^[#.]/, '')) || it.anc.some((a) => norm(a).includes(rootSel.replace(/^[#.]/, ''))))) continue;
				const k = it.surface + '|' + norm(it.sig); const c = (m.get(k) || []); c.push(it); m.set(k, c);
			}
		}
		return m;
	};
	const ma = read(A), mb = read(B);
	const out = []; let changed = 0, added = 0, removed = 0, pairs = 0;
	const keys = new Set([...ma.keys(), ...mb.keys()]);
	for (const k of [...keys].sort()) {
		const la = ma.get(k) || [], lb = mb.get(k) || [];
		const n = Math.max(la.length, lb.length);
		for (let i = 0; i < n; i++) {
			const x = la[i], y = lb[i], [surface] = k.split('|');
			if (!x) { added++; out.push(`+ ${surface}  ${norm(y.sig)} "${y.text.slice(0, 30)}"  r ${y.r.join(',')}`); continue; }
			if (!y) { removed++; out.push(`- ${surface}  ${norm(x.sig)} "${x.text.slice(0, 30)}"  r ${x.r.join(',')}`); continue; }
			pairs++;
			const why = [];
			const clock = x.text !== y.text && (CLOCK.test(x.text) || CLOCK.test(y.text));
			const cmp = (name, p, q) => { const a = JSON.stringify(p), b = JSON.stringify(q); if (a !== b) why.push(`${name}: ${a} -> ${b}`); };
			cmp('classes', [...x.cls].sort().join(' '), [...y.cls].sort().join(' '));
			cmp('ancestry', x.anc.map(norm), y.anc.map(norm));
			for (const f of ['tag', 'role', 'type', 'ctrl', 'sel', 'dis', 'lines', 'glyph', 'clip', 'view']) cmp(f, x[f], y[f]);
			cmp('panel', norm(x.panel), norm(y.panel));
			// A box and its text edges, except across a clock-dependent word, whose width is the clock's.
			if (clock) { cmp('y,h', [x.r[1], x.r[3]], [y.r[1], y.r[3]]); }
			else {
				// An inline run of text (the person's own words in a Rating tile) shifts its width and first edge by a pixel with the shaping of its text.
				const t = x.st.disp === 'inline' ? 1 : 0, nr = (a, b, i) => (i === 2 || i === 0) && Math.abs(a - b) <= t;
				cmp('box', x.r.map((v, i) => (nr(v, y.r[i], i) ? y.r[i] : v)), y.r);
				cmp('text edge', [x.tx != null && y.tx != null && Math.abs(x.tx - y.tx) <= t ? y.tx : x.tx, x.tcy, x.ggap], [y.tx, y.tcy, y.ggap]); cmp('icon', x.icon, y.icon);
			}
			for (const p of Object.keys(x.st)) { if (clock && p === 'pad') continue; cmp('style ' + p, x.st[p], y.st[p]); }
			if (why.length) { changed++; out.push(`~ ${surface}  ${norm(x.sig)} "${x.text.slice(0, 30)}"\n      ${why.join('\n      ')}`); }
		}
	}
	fs.writeFileSync(`${OUT}/diff.md`, out.join('\n') + '\n');
	for (const l of out) console.log(l);
	log('diff', `${A} against ${B}, configs ${pre}${rootSel ? ', under ' + rootSel : ''}:`, pairs, 'pairs,', changed, 'changed,', added, 'added,', removed, 'removed');
	process.exit(changed + added + removed ? 1 : 0);
}

// ── Main ────────────────────────────────────────────────────────────────
if (MODE === 'diff') diffRuns();
if (MODE === 'varlen') {
	const w = process.argv[3] || 'all';
	if (w === 'all' && !process.env.CONS_NOSEED) await seed();
	for (const x of w === 'all' ? ['desk', 'phone', 'webkit'] : w === 'report' ? [] : [w]) await varlenRun(x).catch((e) => log('varlen', x, 'failed', e.message.split('\n')[0]));
	varlenReport();
	process.exit(0);
}
if (MODE === 'seed') await seed();
else if (MODE === 'desk') await desk();
else if (MODE === 'phone') await phone(false);
else if (MODE === 'webkit') await phone(true);
// `tap` seeds when there is no profile yet, then takes the phone pass and the WebKit pass and reports. `all` takes the same
// measure in through its own phone and WebKit passes.
else if (MODE === 'tap') { if (!fs.existsSync(PROF)) await seed(); await phone(false); await phone(true); }
if (MODE === 'all') { await seed(); await desk(); await phone(false); await phone(true); }
if (MODE === 'report' || MODE === 'all' || MODE === 'tap') {
	const { bad, notCovered, parts } = report();
	const covGroups = new Map(); for (const n of notCovered) covGroups.set(n.label, (covGroups.get(n.label) || 0) + 1);
	const covStr = covGroups.size ? ` (not covered: ${[...covGroups.entries()].map(([k, n]) => `${k} ×${n}`).join(', ')})` : '';
	log(bad ? `FAIL: ${bad} unexplained differences (style ${parts.style}, casing ${parts.casing}, layout ${parts.layout}, missing ${parts.missing}, tap ${parts.tap})${covStr}` : `PASS: every role consistent${covStr}`);
	process.exit(bad ? 1 : 0);
}
log('done', MODE);
