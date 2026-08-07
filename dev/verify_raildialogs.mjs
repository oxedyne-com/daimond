// verify_raildialogs.mjs — photograph and MEASURE every dialog the rail opens.
//
// The user's complaint, verbatim: *"I saw obvious button and chip misalignment
// and spacing problems in dialogs in the rail, I can't remember which ones, so
// examine all visually and quality control."* A defect nobody can name cannot
// be asserted on, so it has to be swept for.
//
// `dev/sweep.mjs` sweeps panels and three pop-ups. It does not open a single
// dialog, because a dialog needs something to be about — a Diamond, a chat, a
// mailbox — and the sweep runs on an empty account. So this seeds a rail and
// then walks every dialog it can reach, at both skins, both themes and three
// widths.
//
// What it MEASURES, chosen for the defect the user described rather than for
// completeness:
//
//   [escapes]   an element whose box leaves the card it is in
//   [clipped]   an element whose content is wider or taller than its own box
//   [wrapped]   a flex ROW whose children landed on more than one line —
//               which is what "the refresh button dropped below the title"
//               looks like from the outside, and what geometry alone can see
//   [offcentre] children of a centred row whose INK centres differ by more
//               than 1.5px — the misalignment, measured rather than eyeballed
//   [overlap]   two controls whose boxes intersect
//
// It asserts nothing about beauty. It fails only on [escapes], [clipped] and
// [overlap], which are always wrong; [wrapped] and [offcentre] are reported to
// be LOOKED at, because a row that wraps on a phone is often correct.
//
//   node dev/verify_raildialogs.mjs
//   node dev/verify_raildialogs.mjs --out ~/.cache/daimond/raildlg
//   node dev/verify_raildialogs.mjs --only 'Tile dialog (Diamond)'
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway; nothing spends.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { open, scratch } from './harness.mjs';

const argv = process.argv.slice(2);
const val  = (n, d) => { const i = argv.indexOf(n); return (i >= 0 && argv[i + 1]) ? argv[i + 1] : d; };
const OUT  = val('--out', path.join(os.homedir(), '.cache/daimond/raildlg'));
const ONLY = val('--only', '');
fs.mkdirSync(OUT, { recursive: true });

let hard = 0, soft = 0, shots = 0;
const findings = [];

const CELLS = [
	{ skin: 'sharp', theme: 'dark',  w: 1500, h: 950 },
	{ skin: 'warm',  theme: 'light', w: 1500, h: 950 },
	// 1400, not 900: below 1280 the rail FOLDS ITSELF AWAY (daimond.js:3112), so
	// at 900 the dialogs it opens are genuinely unreachable and a sweep there
	// photographs nothing. 1400 is the narrowest at which the rail is still a rail.
	{ skin: 'sharp', theme: 'light', w: 1400, h: 820 },
	{ skin: 'warm',  theme: 'dark',  w: 380,  h: 780 },
];

// ── The measuring pass, run inside the page ────────────────────────────
//
// One evaluate, not one per element: a layout read per element over a whole
// dialog is hundreds of round trips and the page relayouts between them.
const MEASURE = function (rootSel) {
	const root = document.querySelector(rootSel);
	if (!root) return { missing: true, defects: [] };
	const out = [];
	const vis = (el) => {
		if (el.getClientRects().length === 0) return false;
		const cs = getComputedStyle(el);
		if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
		if (el.classList.contains('vh')) return false;
		return true;
	};
	const name = (el) => {
		let s = el.tagName.toLowerCase();
		if (el.id) s += '#' + el.id;
		else if (typeof el.className === 'string' && el.className.trim()) {
			s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
		}
		const t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
		return t ? `${s} "${t}"` : s;
	};
	const at = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
	const all = [...root.querySelectorAll('*')].filter(vis);
	const rr = root.getBoundingClientRect();
	// A container that SCROLLS is meant to hold things outside its visible box —
	// that is what scrolling is — so an escape is measured only on the axes the
	// root does not scroll. Without this the Appearance menu, a tall scroller on
	// a phone, reported every control below its fold as escaping.
	const rcs = getComputedStyle(root);
	const scrollY = /auto|scroll/.test(rcs.overflowY) || /auto|scroll/.test(rcs.overflow);
	const scrollX = /auto|scroll/.test(rcs.overflowX) || /auto|scroll/.test(rcs.overflow);
	// Once per chain: a path inside an svg inside a button that escapes is ONE
	// defect written up three times, which is how eight findings become twenty.
	const escaped = [];

	for (const el of all) {
		const r = el.getBoundingClientRect();
		// [escapes] — beyond the card, by more than a rounding error. Half a pixel
		// is subpixel layout; two is somebody's box being too big.
		const overX = scrollX ? -1 : Math.max(rr.left - r.left, r.right - rr.right);
		const overY = scrollY ? -1 : Math.max(rr.top - r.top, r.bottom - rr.bottom);
		const over = Math.max(overX, overY);
		if (over > 2 && !escaped.some((a) => a.contains(el))) {
			escaped.push(el);
			out.push({ kind: 'escapes', by: Math.round(over), el: name(el), rect: at(r), weight: 3 });
		}
		// [clipped] — its own content does not fit, and it is not a scroller.
		const cs = getComputedStyle(el);
		const scrolls = /auto|scroll/.test(cs.overflow + cs.overflowX + cs.overflowY);
		if (!scrolls) {
			const dx = el.scrollWidth - el.clientWidth, dy = el.scrollHeight - el.clientHeight;
			if (el.clientWidth > 0 && (dx > 2 || dy > 2)) {
				out.push({ kind: 'clipped', by: Math.max(dx, dy), el: name(el), rect: at(r), weight: 3 });
			}
		}
	}

	// [wrapped] and [offcentre] — properties of a ROW, so they are measured on
	// the containers rather than on the elements.
	for (const el of all) {
		const cs = getComputedStyle(el);
		if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue;
		if (cs.flexDirection !== 'row') continue;
		const kids = [...el.children].filter(vis);
		if (kids.length < 2) continue;
		const boxes = kids.map((k) => k.getBoundingClientRect());
		// The CENTRES, against the tallest child. A 30px button beside a 19px
		// label sits on one line and its box top is 5px higher; bucketing by top
		// called that a wrap, which is a false positive on every mixed row in the
		// app. A row has genuinely wrapped only when a child's centre is most of a
		// child-height away from another's.
		const mids = boxes.map((b) => b.top + b.height / 2);
		const tall = Math.max(...boxes.map((b) => b.height), 1);
		const spread = Math.max(...mids) - Math.min(...mids);
		if (spread > tall * 0.6) {
			out.push({ kind: 'wrapped', by: +spread.toFixed(1), el: name(el),
				rect: at(el.getBoundingClientRect()), weight: 1, note: kids.map(name).join(' | ') });
			continue;		// a wrapped row's centres are not comparable
		}
		if (cs.alignItems !== 'center') continue;
		if (spread > 1.5) {
			out.push({ kind: 'offcentre', by: +spread.toFixed(2), el: name(el),
				rect: at(el.getBoundingClientRect()), weight: 2, note: kids.map(name).join(' | ') });
		}
	}

	// [overlap] — two controls sharing pixels. Only controls: a label lying over
	// its own field's background is how a field is drawn.
	const ctl = all.filter((e) => e.matches('button, a[href], input, select, textarea, [role="button"]'));
	for (let i = 0; i < ctl.length; i++) {
		for (let j = i + 1; j < ctl.length; j++) {
			if (ctl[i].contains(ctl[j]) || ctl[j].contains(ctl[i])) continue;
			const a = ctl[i].getBoundingClientRect(), b = ctl[j].getBoundingClientRect();
			const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
			const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
			if (ox > 2 && oy > 2) {
				out.push({ kind: 'overlap', by: Math.round(Math.min(ox, oy)), el: name(ctl[i]),
					other: name(ctl[j]), rect: at(a), weight: 3 });
			}
		}
	}
	out.sort((p, q) => (q.weight - p.weight) || ((q.by || 0) - (p.by || 0)));
	return { missing: false, defects: out };
};

// ── Getting each dialog on screen ──────────────────────────────────────
/// Make sure the rail is actually on screen, opening the drawer if it is not.
/// Returns whether it managed it, so a skip says "no rail" rather than "no
/// button".
async function railOpen(page) {
	const there = () => page.evaluate(() => {
		const r = document.getElementById('panel-rail');
		return !!r && r.getClientRects().length > 0 && r.getBoundingClientRect().width > 40;
	});
	if (await there()) return true;
	// Two ways, because the rail is hidden two different ways: below 1280px it
	// is a panel the dock has closed, and on a phone it is a drawer behind the
	// hamburger. Asking the panel registry first is the one that works at 900.
	await page.evaluate(() => { try { DaimondPanels.show('rail'); } catch (e) { /* not up */ } });
	await page.waitForTimeout(400);
	if (await there()) return true;
	await page.evaluate(() => { const b = document.getElementById('drawer-btn'); if (b) b.click(); });
	await page.waitForTimeout(450);
	return there();
}

const press = async (page, sel) => {
	await page.waitForSelector(sel, { timeout: 10000 });
	await page.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); }, sel);
	await page.waitForTimeout(320);
};

/// Press the control inside `rootSel` whose words are exactly `text`. Exact,
/// because Playwright's `:has-text` is a case-insensitive substring and would
/// press "Change name…" when asked for "Change passphrase…".
const pressLabel = async (page, rootSel, text) => {
	await page.waitForSelector(rootSel, { timeout: 10000 });
	const hit = await page.evaluate(({ rootSel, text }) => {
		const root = document.querySelector(rootSel);
		if (!root) return false;
		const b = [...root.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === text);
		if (!b) return false;
		b.click();
		return true;
	}, { rootSel, text });
	if (!hit) throw new Error(`no control labelled "${text}"`);
	await page.waitForTimeout(400);
};

const DIALOGS = [
	{
		name: 'New Diamond', sel: '.modal.dlg .dlg-card',
		reach: async (p) => { await press(p, '#new-diamond-btn'); },
	},
	{
		name: 'Tile dialog (Diamond)', sel: '.tile-dlg-card',
		reach: async (p) => { await press(p, '#diamond-list .tile-cog'); },
	},
	{
		name: 'Tile dialog (chat)', sel: '.tile-dlg-card',
		reach: async (p) => { await press(p, '#session-list .tile-cog'); },
	},
	{
		name: 'Delete a Diamond (confirm)', sel: '.modal.dlg .dlg-card',
		reach: async (p) => {
			await press(p, '#diamond-list .tile-cog');
			await press(p, '.tile-dlg-delete');
		},
	},
	{
		name: 'Delete a chat (confirm)', sel: '.modal.dlg .dlg-card',
		reach: async (p) => {
			await press(p, '#session-list .tile-cog');
			await press(p, '.tile-dlg-delete');
		},
	},
	{
		name: 'Rename a Diamond', sel: '.modal.dlg .dlg-card',
		reach: async (p) => {
			await p.evaluate(() => {
				const n = document.querySelector('#diamond-list .session-box-name');
				n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
			});
			await p.waitForTimeout(400);
		},
	},
	{
		name: 'Fold this chat into…', sel: '.fold-menu',
		reach: async (p) => { await press(p, '#session-list .tile-fold'); },
	},
	{
		name: 'Admin home', sel: '#admin-home',
		reach: async (p) => { await press(p, '#user-row'); },
	},
	{
		name: 'Models', sel: '#admin-models',
		reach: async (p) => { await press(p, '#astat-model'); },
	},
	{
		name: 'Credits', sel: '#admin-credits',
		reach: async (p) => { await press(p, '#astat-account'); },
	},
	{
		name: 'Change name', sel: '.modal.dlg .dlg-card',
		reach: async (p) => {
			await press(p, '#user-row');
			await pressLabel(p, '#admin-home', 'Change name…');
		},
	},
	{
		name: 'Forget this identity (confirm)', sel: '.modal.dlg .dlg-card',
		reach: async (p) => {
			await press(p, '#user-row');
			await pressLabel(p, '#admin-home', 'Forget this identity…');
		},
	},
	{
		name: 'Add a mailbox', sel: '#admin-form',
		reach: async (p) => {
			await p.evaluate(() => window.DaimondPanels && DaimondPanels.show('mail'));
			await p.waitForTimeout(320);
			await press(p, '#panel-mail [data-act="mail-add"]');
			await p.waitForSelector('#admin-form .dlg-input', { timeout: 8000 });
		},
	},
	{
		name: 'Link another device', sel: '.pair-scrim',
		reach: async (p) => {
			await p.evaluate(() => window.DaimondPairing && DaimondPairing.showLink());
			await p.waitForSelector('.pair-scrim', { timeout: 8000 });
		},
	},
	{
		name: 'Appearance menu', sel: '#settings-menu',
		reach: async (p) => { await press(p, '#settings-menu-btn'); },
	},
	{
		name: 'Panel gallery', sel: '#panel-gallery',
		reach: async (p) => {
			await p.evaluate(() => {
				['doc', 'msg', 'compose'].forEach((x) => { try { DaimondPanels.markUsed(x); } catch (e) {} });
				try { DaimondPanels.reflow(); } catch (e) {}
			});
			await p.waitForTimeout(400);
			await press(p, '#panel-more');
		},
	},
];

/// Screenshot, and PROVE it landed. The suite's own `shot()` swallows a failed
/// capture, and capture on this box has silently failed for an hour at a time
/// under load — so a clean run is not by itself evidence of a picture.
async function snap(page, file, sel) {
	const p = path.join(OUT, file + '.png');
	try {
		const el = sel ? await page.$(sel) : null;
		if (el) await el.screenshot({ path: p, timeout: 8000 });
		else await page.screenshot({ path: p, timeout: 8000 });
	} catch (e) { return null; }
	if (!fs.existsSync(p) || fs.statSync(p).size < 400) return null;
	shots++;
	return p;
}

const s = await open({ name: 'raildlg', profile: scratch('pw', 'raildlg-' + process.pid) });
const { page } = s;
try {
	// A rail with something in it. Every dialog below is about an object, and an
	// empty account has none — the whole reason dev/sweep.mjs never opened one.
	await page.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); });
	await page.waitForTimeout(250);
	await press(page, '#new-diamond-btn');
	await page.waitForSelector('.dlg-card', { timeout: 8000 });
	await page.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')].find((c) => c.getClientRects().length);
		const i = card.querySelector('input.dlg-input');
		i.value = 'A Diamond with a fairly long name';
		i.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	});
	await page.waitForTimeout(1600);
	await press(page, '#new-session-btn');
	await page.evaluate(() => { const b = [...document.querySelectorAll('.tile-start')].pop(); if (b) b.click(); });
	await page.waitForTimeout(1500);
	// One turn, so the chat has something in it. The Fold picker refuses an empty
	// chat with a notice, so without this the picker is never photographed and
	// the skip reads as "unreachable" rather than "there was nothing to fold".
	if (await page.isVisible('#chat-input')) {
		await page.fill('#chat-input', '@text a first answer');
		await page.click('#chat-send');
		await page.waitForTimeout(2500);
	}

	const seeded = await page.evaluate(() => ({
		d: document.querySelectorAll('#diamond-list .session-box').length,
		c: document.querySelectorAll('#session-list .session-box').length,
		// An ACTIVE chat, not a pending one: Fold is only on an active tile, and
		// a pending one would make that dialog silently unreachable.
		fold: document.querySelectorAll('#session-list .tile-fold').length,
	}));
	console.log(`seeded: ${seeded.d} Diamond(s), ${seeded.c} chat(s), ${seeded.fold} foldable`);
	if (!seeded.fold) console.log('note  the chat did not start — the Fold picker will be skipped');
	if (!seeded.d || !seeded.c) {
		console.log('FAIL nothing to open a dialog about — refusing to sweep an empty rail.');
		await s.close();
		process.exit(1);
	}

	for (const cell of CELLS) {
		const tag = `${cell.skin}-${cell.theme}-${cell.w}`;
		console.log(`\n── ${tag}`);
		await page.setViewportSize({ width: cell.w, height: cell.h });
		await page.evaluate((c) => {
			document.documentElement.setAttribute('data-skin', c.skin);
			document.documentElement.setAttribute('data-theme', c.theme);
			document.documentElement.setAttribute('data-tone', c.theme === 'light' ? 'light' : 'dark');
			document.documentElement.setAttribute('data-ink', c.theme === 'light' ? 'dark' : 'light');
		}, cell);
		await page.waitForTimeout(250);

		// The rail folds itself away below 1280px, and on a phone it is a
		// drawer. Photographing without opening it photographs the chat and
		// concludes the work is missing — so it is opened whenever it is not
		// actually on screen, whatever the width.
		await railOpen(page);

		for (const d of DIALOGS) {
			if (ONLY && d.name !== ONLY) continue;
			// Quieten first, so the previous dialog cannot be measured as this one.
			for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(90); }
			await railOpen(page);
			let up = false;
			try { await d.reach(page); up = true; } catch (e) { /* reported below */ }
			await page.waitForTimeout(280);
			const there = up && await page.evaluate((sel) => {
				const e = document.querySelector(sel);
				return !!e && e.getClientRects().length > 0 && e.getBoundingClientRect().height > 4;
			}, d.sel);
			if (!there) { console.log(`  skip  ${d.name} — did not open here`); continue; }

			const file = `${tag}--${d.name.replace(/\W+/g, '-').toLowerCase()}`;
			const shot = await snap(page, file, d.sel);
			const m = await page.evaluate(MEASURE, d.sel);
			const worst = m.defects.length ? `${m.defects.length}: ${m.defects[0].kind} ${m.defects[0].el}` : '';
			console.log(`  ${m.defects.length ? 'LOOK' : ' ok '}  ${d.name}${worst ? '  ' + worst : ''}`
				+ (shot ? '' : '   [NO SHOT ON DISK]'));
			for (const f of m.defects) {
				findings.push({ cell: tag, dialog: d.name, shot, ...f });
				if (f.kind === 'escapes' || f.kind === 'clipped' || f.kind === 'overlap') hard++; else soft++;
			}
		}
	}
} finally {
	await s.close();
}

findings.sort((a, b) => (b.weight - a.weight) || ((b.by || 0) - (a.by || 0)));
console.log(`\n${shots} shots in ${OUT}`);
if (!findings.length) console.log('nothing measured — the images are still the other half. Read them.');
else {
	console.log(`\n${findings.length} finding(s), worst first:\n`);
	for (const f of findings.slice(0, 40)) {
		console.log(`  [${f.kind}] by ${f.by}  ${f.cell}  ${f.dialog}\n      ${f.el}`
			+ (f.other ? `  ↔ ${f.other}` : '') + (f.note ? `\n      children: ${f.note}` : '')
			+ `  @${f.rect.x},${f.rect.y} ${f.rect.w}x${f.rect.h}`);
	}
	if (findings.length > 40) console.log(`  … and ${findings.length - 40} more, in the json.`);
}
fs.writeFileSync(path.join(OUT, 'raildialogs.json'), JSON.stringify(findings, null, '\t'));
console.log(`\n${hard} always-wrong, ${soft} to look at. ${path.join(OUT, 'raildialogs.json')}`);
process.exit(hard === 0 ? 0 : 1);
