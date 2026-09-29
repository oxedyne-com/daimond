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
//
// `all` = seed, desk (1440×900) and phone (390×844) in Chromium, phone in WebKit,
// each in Obsidian and Porcelain, then `report`. `report` re-reads the saved
// captures, so the table can be corrected and re-run without a browser.
import { open, chat, newChat, signInAs } from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';

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
const CAPTURE = ({ rootSel, surface }) => {
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
			r: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], view: inView(r) ? 1 : 0,
			tx, tcy, glyph, ggap, icon, clip, ph: el.getAttribute('placeholder') || '',
			st: {
				ff: ls.fontFamily.split(',')[0].replace(/["']/g, '').trim(), fs: ls.fontSize, fw: ls.fontWeight, ls: ls.letterSpacing, tt: ls.textTransform,
				col: tok(ls.color), bg: tok(s.backgroundColor),
				bd: ['Top', 'Right', 'Bottom', 'Left'].map((x) => parseFloat(s['border' + x + 'Width']) && s['border' + x + 'Style'] !== 'none' && tok(s['border' + x + 'Color']) !== 'none' ? s['border' + x + 'Width'] + ' ' + tok(s['border' + x + 'Color']) : '0').join(' / '),
				rad: s.borderRadius, pad: s.padding, h: Math.round(r.height), lh: ls.lineHeight, gap: s.columnGap, disp: s.display, ai: s.alignItems,
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
	return { missing: false, items, faults, tiles };
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
async function grab(name, rootSel) {
	if (rootSel === undefined) rootSel = null;
	const surface = `${CFG}/${name}`;
	const a = await ev(CAPTURE, { rootSel, surface });
	if (a.err) { log('capture fail', surface, a.err); return; }
	if (a.missing) { log('MISSING', surface, rootSel); CAP.missing.push(surface); return; }
	CAP.items.push(...a.items); CAP.faults.push(...a.faults); CAP.tiles.push(...a.tiles); CAP.surfaces.push(surface);
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
	if (await tiles.count()) { await tiles.last().hover({ force: true }).catch(() => {}); await wait(300); await grab('tile_hover', '#chat-output'); await page.mouse.move(5, 5); }
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
		if (wk && /Workspace/i.test(tabs[i])) {
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
	await quiet();
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
	CAP = { items: [], faults: [], tiles: [], surfaces: [], missing: [], notCovered: [] };
	const s = await open({ name: 'alex', profile: PROF });
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
// a fresh one, so its chats and diamonds are real and arrive by sync (CRF2:
// only the Workspace files take no part). Pattern:
// dev/verify_markshere_sync.mjs's `pairedDevice`. If pairing cannot run under
// this harness at all, WebKit is excluded in full rather than measured empty.
async function phone(wk) {
	CAP = { items: [], faults: [], tiles: [], surfaces: [], missing: [], notCovered: [] };
	let lead = null, s, excluded = null;
	if (wk) {
		try {
			lead = await open({ name: 'alex', profile: PROF, connect: false });
			await lead.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 });
			s = await open({ name: 'alex', profile: PROF + '-webkit', signIn: false, connect: false, defaults: false,
				browser: 'webkit', touch: true, ua: IPHONE_UA });
			await s.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 });
			const code = await lead.page.evaluate(() => DaimondPairing.create());
			if (!code || !code.code) throw new Error('no pairing code');
			await s.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
			await s.page.reload({ waitUntil: 'domcontentloaded' });
			await signInAs(s, 'alex');
			await s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway && DaimondGateway.state().authed), null, { timeout: 30000 });
		} catch (e) {
			log('webkit pairing unavailable under this harness, excluding WebKit in full:', e.message);
			excluded = 'webkit-*: no seeded content';
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
	if (wk) {
		// The content comes by sync, not by WebKit's own chat() calls against a
		// fresh, empty profile. Push from the lead and pull here until the
		// paired content lands, or fail the run rather than capture WebKit's
		// own empty state as if it were real.
		const t0 = Date.now(); let synced = false;
		while (Date.now() - t0 < 60000) {
			await lead.page.evaluate(() => window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push()).catch(() => {});
			await page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
			await wait(800);
			const n = await ev(() => ({ chats: document.querySelectorAll('#session-list .chat-box').length, diamonds: document.querySelectorAll('#diamond-list .diamond-box').length }));
			if (n && !n.err && n.chats >= 3 && n.diamonds >= 4) { synced = true; break; }
		}
		if (!synced) {
			log('webkit: sync wait timed out, failing the run rather than capturing an empty rail');
			await s.close().catch(() => {}); await lead.close().catch(() => {});
			process.exit(4);
		}
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
	['create-button',   'title',    (it) => it.ctrl && (has(it, 'railbtn') || /^(new|add|create)\b/i.test(txt(it)) && txt(it).length < 32 && !has(it, 'admin-item') && !within(it, /dlg-actions/) && !/link|add-credits/.test(it.cls.join(' ')))],
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
	// `pad` is left out: the last column keeps the panel's own right gutter,
	// every other column sits flush against its neighbour, by design (§11).
	'data-table-head': PROPS_TEXT, 'data-table-cell': ['ff', 'fs', 'fw', 'col', 'lh'],
};

// THE ALLOW-LIST. A deliberate variant, named, with its reason. `m` is tested
// against `sig + ' ' + text` (plus ' aria-current' when the element says it is
// selected); `p` lists the properties it may differ in.
const ALLOW = [
	{ role: '*', m: /\.(on|active|current|selected|is-on|tag-inc)\b|aria-current/, p: ['col', 'bg', 'fw', 'bd'], why: 'the current or selected state is drawn apart on purpose' },
	{ role: '*', m: /\.danger\b/, p: ['col'], why: 'a destructive action is drawn in the danger colour' },
	{ role: '*', m: /\.dlg-ok\b|#chat-send\b|\.compose-send\b|\.ti-continue\b|#push-save\b|#beta-open\b|\.crystal-act\.primary\b/, p: ['col', 'bg', 'bd', 'fw', 'rad'], why: 'the one primary action of a dialog, the composer, an interrupted turn or the crystal form is filled -- the send button’s own round primary keeps its radius too' },
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
const CASE_ALLOW = [/^New Diamond$/, /^New Message$/, /^Say Hello$/];

function report() {
	const caps = ['desk', 'phone', 'webkit'].map((n) => `${OUT}/cap_${n}.json`).filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
	if (!caps.length) { log('no captures in', OUT); process.exit(2); }
	const items = caps.flatMap((c) => c.items), faults = caps.flatMap((c) => c.faults), missing = caps.flatMap((c) => c.missing), surfaces = caps.flatMap((c) => c.surfaces);
	// Recorded, printed, and never scored as a pass or a fail (WebKit's own
	// Workspace, CRF2, or the whole engine when pairing cannot run at all).
	const notCovered = caps.flatMap((c) => c.notCovered || []);
	const tiles = caps.flatMap((c) => c.tiles || []);
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
	const val = (it, p) => p === 'icon' ? (it.icon ? it.icon.w + '×' + it.icon.h : '-') : it.st[p];
	const allowed = (role, it, p) => ALLOW.find((a) => (a.role === '*' || a.role === role) && a.p.includes(p) && a.m.test(it.sig + ' ' + it.text + ' < ' + it.anc.slice(0, 3).join(' ') + (it.sel ? ' aria-current' : '') + (it.foc ? ' :focus' : '')));
	const diffs = [];	// style differences within a role
	for (const [role, list] of byRole) {
		const props = ROLE_PROPS[role]; if (!props) continue;
		const byCfg = new Map(); for (const it of list) { if (!byCfg.has(it.cfg)) byCfg.set(it.cfg, []); byCfg.get(it.cfg).push(it); }
		for (const [cfg, L] of byCfg) {
			if (L.length < 2) continue;
			for (const p of props) {
				if (p === 'h' && role !== 'list-row') { /* single-line only */ }
				// Type is compared only where there is type; an icon's height only on
				// one line. G12: a textarea sizes to its content, not to a rule. G10:
				// `gap` means nothing on a box that isn't flex or grid.
				const pool = L.filter((it) => !(p === 'h' && it.lines > 1) && !(p === 'icon' && !it.icon) && !(FONTP.has(p) && !/\p{L}/u.test(it.text))
					&& !(p === 'h' && it.tag === 'textarea') && !(p === 'gap' && !/flex|grid/.test(it.st.disp)));
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
						diffs.push({ role, cfg, p, canon, v, sig: it.sig, text: it.text.slice(0, 40), surfaces: it.surfaces.slice(0, 4), panel: it.panel, allowed: a ? a.why : null, n: cnt.get(canon), of: gpool.length });
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
			if (L.length >= 3) { const o = L.slice().sort((a, b) => a.r[0] - b.r[0]); const g = []; for (let i = 1; i < o.length; i++) g.push(o[i].r[0] - o[i - 1].r[0] - o[i - 1].r[2]);
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
	const GLYROLE = (it) => /^summary\b|\btagf-toggle\b|#sys-head\b|\barte-strip\b|\bastat-val\b|#sync-rest\b/.test(it.sig);
	const RIGHTALIGN = (it) => /\bastat-aside\b|\brel-when\b|\bpptw-head-state\b/.test(it.sig);
	// G13: a text edge inside a card (a transcript tile, a history or tag row) is
	// that container's own edge, not the panel's -- so it is not compared to it.
	const byPanel = new Map(); for (const it of items) { if (!it.view || it.tx == null || it.lines !== 1) continue; if (!/panel-title|section-head|list-row|meta|disclosure|body-text|create-button|text-button/.test(it.roleName)) continue;
		if (RIGHTALIGN(it)) continue;
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
	const roleCount = new Map(); for (const it of I) roleCount.set(it.roleName, (roleCount.get(it.roleName) || 0) + 1);
	const summary = {
		surfaces: surfaces.length, missing, instances: I.length, roles: Object.fromEntries([...roleCount.entries()].sort((a, b) => b[1] - a[1])),
		styleDiffs: unexplained.length, allowedDiffs: D.length - unexplained.length, casing: C.length, layout: Lx.length,
		byRole: Object.fromEntries([...new Set(unexplained.map((d) => d.role))].map((r) => [r, unexplained.filter((d) => d.role === r).length])),
		layoutByKind: Object.fromEntries([...new Set(Lx.map((d) => d.kind))].map((r) => [r, Lx.filter((d) => d.kind === r).length])),
		notCovered: notCovered.map((n) => n.label + ': ' + n.reason),
	};
	fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ summary, style: D, casing: C, layout: Lx, unclassified: I.filter((i) => i.roleName === 'unclassified').map((i) => i.sig + ' ' + i.text) }, null, 1));
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
	fs.writeFileSync(`${OUT}/report.md`, md.join('\n'));
	log('report', `${OUT}/report.md`, JSON.stringify(summary));
	const bad = unexplained.length + C.length + Lx.length + missing.length;
	return { bad, notCovered };
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
	['rail filter chip',    '#panel-rail', '.tagf-row', '.tag-chip', V_CHIP, null, 'filter'],
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
];
// Whole surfaces re-read in each locale: every label at once, en against de and fr.
const VLOCALE = [['rail', '#panel-rail'], ['chat head', '#panel-ai > .chead'], ['workspace', '#panel-work', 'work'], ['composer', '.chat-input-bar'], ['topbar', '.topbar'], ['new diamond dialog', 'OVERLAY', 'newdia'], ['admin', '#admin', 'admin']];

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
	if (kind === 'filter') { await ev(() => { document.querySelectorAll('#panel-rail .tagf-toggle[aria-expanded="false"], #panel-rail .rail-fold[aria-expanded="false"]').forEach((b) => b.click()); document.querySelectorAll('#panel-rail details').forEach((d) => { d.open = true; }); }); await wait(400); }
	if (kind === 'viewer') {
		await ev(() => { const row = [...document.querySelectorAll('.files-row')].find((x) => /^\s*notes\.md/.test((x.querySelector('.files-name') || x).textContent)); if (row) (row.querySelector('.files-name') || row).click(); });
		await wait(1400);
	}
	if (kind === 'cog') { await click('#diamond-list .diamond-box .tile-cog'); await wait(700); }
	if (kind === 'newdia') { await click('#new-diamond-btn'); await wait(700); }
	if (kind === 'admin') { await click('#settings-btn'); await wait(700); await ev(() => { try { window.DaimondAdmin.home(); } catch (e) {} }); await wait(500); }
	if (['cog', 'newdia', 'admin'].includes(kind)) { const ov = kind === 'admin' ? '#admin' : await topOverlay(); await ev((q) => { window.__vl = window.__vl || {}; window.__vl.ov = q && document.querySelector(q); }, ov); }
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
		else if (phone && (setup === 'chat' || /panel-ai|chat-input/.test(ctx))) { await ev(() => { try { window.DaimondPanels.show('ai'); } catch (e) {} }); await wait(400); }
		else if (phone && /rail|diamond-list|session-list|admin-status|topbar/.test(ctx) || phone && ['cog', 'newdia'].includes(setup)) await railOpen();
		if (setup) await vSetup(setup);
		if (/admin-status/.test(ctx)) await ev(() => { const a = document.getElementById('admin-status'); if (a) a.scrollIntoView({ block: 'end' }); });
		if (/diamond-list|session-list/.test(ctx)) await ev((q) => { const a = document.querySelector(q); if (a) a.scrollIntoView({ block: 'start' }); }, ctx);
		await wait(200);
	};
	for (const [name, ctx, comp, slot, vals, pick, setup] of VSLOTS) {
		await place(setup, ctx);
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
	}
	await quiet();
	return recs;
}
async function varlenRun(which) {
	let s, lead = null;
	if (which === 'webkit') {
		try {
			lead = await open({ name: 'alex', profile: PROF, connect: false });
			await lead.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 });
			s = await open({ name: 'alex', profile: PROF + '-webkit', signIn: false, connect: false, defaults: false, browser: 'webkit', touch: true, ua: IPHONE_UA });
			await s.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 });
			const code = await lead.page.evaluate(() => DaimondPairing.create()); if (!code || !code.code) throw new Error('no pairing code');
			await s.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
			await s.page.reload({ waitUntil: 'domcontentloaded' }); await signInAs(s, 'alex');
			await s.page.waitForFunction(() => !!(window.DaimondSync && DaimondGateway.state().authed), null, { timeout: 30000 });
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
		if (o.notCovered) { md.push(`- **${o.name}** (${o.cfg}): NOT COVERED -- ${o.notCovered}`); continue; }
		const ch = o.changes.map((c) => `${c.where}:${c.part}${c.text ? '"' + c.text.slice(0, 14) + '"' : ''}[${c.kinds.join('+')}${c.dx ? ' dx' + c.dx : ''}${c.dy ? ' dy' + c.dy : ''}${c.dw ? ' dw' + c.dw : ''}${c.dh ? ' dh' + c.dh : ''}]`);
		md.push(`- **${o.name}** ${o.variant} (${o.cfg})${o.own ? ` own: lines ${o.own.ln.join('→')}${o.own.ov ? ' ' + o.own.ov : ''}${o.own.sh < 100 ? ' shown ' + o.own.sh + '%' : ''}${o.own.past ? ' past-tile ' + o.own.past + 'px' : ''} tile dh${o.own.dh} dw${o.own.dw}${o.own.over ? ' tile-overflow ' + o.own.over : ''}` : ''}${o.hscroll ? ' PAGE-HSCROLL ' + o.hscroll : ''}${o.ctxOver ? ' CTX-OVERFLOW ' + o.ctxOver : ''}`);
		if (ch.length) md.push('  - ' + ch.slice(0, 14).join(' ') + (ch.length > 14 ? ` (+${ch.length - 14})` : ''));
		if (o.align && o.align.length) md.push('  - misaligned vs siblings: ' + o.align.map((a) => `${a.part} x${a.x} vs ${a.sibX}`).join(', '));
	}
	fs.writeFileSync(`${OUT}/varlen_report.md`, md.join('\n'));
	log('varlen report', `${OUT}/varlen_report.md`, out.length, 'rows');
}

// ── Main ────────────────────────────────────────────────────────────────
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
if (MODE === 'all') { await seed(); await desk(); await phone(false); await phone(true); }
if (MODE === 'report' || MODE === 'all') {
	const { bad, notCovered } = report();
	const covGroups = new Map(); for (const n of notCovered) covGroups.set(n.label, (covGroups.get(n.label) || 0) + 1);
	const covStr = covGroups.size ? ` (not covered: ${[...covGroups.entries()].map(([k, n]) => `${k} ×${n}`).join(', ')})` : '';
	log(bad ? `FAIL: ${bad} unexplained differences${covStr}` : `PASS: every role consistent${covStr}`);
	process.exit(bad ? 1 : 0);
}
log('done', MODE);
