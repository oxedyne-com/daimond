// shot_qc.mjs — the surfaces `dev/sweep.mjs` cannot reach, photographed and measured.
//
// The sweep walks the panels and the three `.pop` overlays, and that is most of
// the app but not the part the user complained about: *"button and chip
// misalignment and spacing problems in dialogs in the rail"*. A dialog in the
// rail is not a panel. It is the Admin drawer on one of its six views, the New
// Diamond box, the tag editor, the settings modal — each behind a click the
// sweep does not make, and two of them behind a Diamond that has to exist first.
// So this seeds a real workspace and then opens them one at a time.
//
// It also opens the two overlays the sweep reports as "did not open": the panel
// gallery, whose opener `#panel-more` exists only when the chip row overflows,
// and the permission-mode pop, whose opener lives in a chat head that is not
// there until a chat is.
//
// Measuring, not only photographing: a row of controls meant to be equal is
// checked for being equal, to the pixel, because 16px out of 62 is obvious on
// screen and invisible in a list of rectangles nobody compares.
//
//   node dev/shot_qc.mjs --out ~/.cache/daimond/qc
//   node dev/shot_qc.mjs --only appearance,admin-models
//   node dev/shot_qc.mjs --cells sharp-dark-1500,warm-light-380
import fs from 'node:fs';
import path from 'node:path';
import { open, errors, scratch } from './harness.mjs';

const argv = process.argv.slice(2);
const value = (n, d) => { const i = argv.indexOf(n); return (i >= 0 && argv[i + 1]) ? argv[i + 1] : d; };
const list  = (n) => value(n, '').split(',').map((x) => x.trim()).filter(Boolean);

const OUT   = value('--out', scratch('qc'));
const ONLY  = list('--only');
const CELLS_WANTED = list('--cells');
fs.mkdirSync(OUT, { recursive: true });

const ALL_CELLS = [
	{ tag: 'sharp-dark-1500',  skin: 'sharp', theme: 'dark',  w: 1500, h: 950 },
	{ tag: 'warm-light-1500',  skin: 'warm',  theme: 'light', w: 1500, h: 950 },
	{ tag: 'sharp-light-1500', skin: 'sharp', theme: 'light', w: 1500, h: 950 },
	{ tag: 'warm-dark-1500',   skin: 'warm',  theme: 'dark',  w: 1500, h: 950 },
	{ tag: 'sharp-dark-380',   skin: 'sharp', theme: 'dark',  w: 380,  h: 780 },
	{ tag: 'warm-light-380',   skin: 'warm',  theme: 'light', w: 380,  h: 780 },
];
const CELLS = CELLS_WANTED.length ? ALL_CELLS.filter((c) => CELLS_WANTED.includes(c.tag)) : ALL_CELLS;

const s = await open({ name: 'qc', connect: true });
const { page } = s;
const pause = (ms) => page.waitForTimeout(ms);

/// Put the app back to rest: nothing modal, nothing popped, no drawer.
async function quieten() {
	await page.evaluate(() => {
		document.querySelectorAll('.pop:not([hidden])').forEach((el) => { el.hidden = true; });
		const pal = document.getElementById('palette'); if (pal) pal.hidden = true;
		document.querySelectorAll('.modal').forEach((el) => { el.style.display = 'none'; });
		document.querySelectorAll('.dlg-scrim, .scrim').forEach((el) => el.remove());
		const close = document.getElementById('admin-close');
		if (close && close.getClientRects().length) close.click();
	}).catch(() => {});
	await pause(180);
}

// ── Seeding ────────────────────────────────────────────────────────────
//
// Three Diamonds, one of them carrying enough tags to overflow its tile, and a
// chat with a turn in it. Every rail dialog worth photographing needs at least
// one of the three to exist, and the tag row needs the tags.
async function seed() {
	const drawerClose = page.locator('#admin-close');
	if (await drawerClose.isVisible().catch(() => false)) { await drawerClose.click({ force: true }); await pause(200); }
	for (const name of ['Ship a CSV parser', 'Mum birthday plan', 'Rust compiler notes']) {
		await page.click('#new-diamond-btn', { force: true });
		await page.waitForSelector('.dlg-input', { timeout: 10000 });
		await page.fill('.dlg-input', name);
		await page.click('.dlg-ok', { force: true });
		await pause(700);
	}
	// Tags on the first Diamond, through the editor a person uses. Five of them,
	// because a tile shows two and then "+n" — and the "+n" is a chip whose
	// alignment against the two beside it is exactly the kind of thing this
	// sweep is for.
	await page.$$eval('.diamond-box', (els) => els[0] && els[0].click());
	await pause(700);
	await page.evaluate(() => {
		const b = [...document.querySelectorAll('.crystal-act')].find((x) => /tag/i.test(x.textContent || ''));
		if (b) b.click();
	});
	await page.waitForSelector('.tag-input', { timeout: 8000 }).catch(() => {});
	for (const tag of ['rust', 'parser', 'work in progress', 'reading', 'deep']) {
		await page.fill('.tag-input', tag).catch(() => {});
		await page.keyboard.press('Enter');
		await pause(450);
	}
	await page.reload({ waitUntil: 'domcontentloaded' });
	await pause(1500);
	// The reload lands on the passphrase gate again.
	const pass = await page.$('#id-pass');
	if (pass && await pass.isVisible()) {
		await page.fill('#id-pass', 'testpass1234');
		await page.evaluate(() => document.getElementById('id-primary').click());
		await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 }).catch(() => {});
		await pause(800);
	}
	// A chat, so the chat head — and the permission chip in it — exists.
	await quieten();
	await page.click('#new-session-btn', { force: true }).catch(() => {});
	await pause(500);
	const start = page.locator('.tile-start').first();
	if (await start.count()) await start.click({ force: true });
	await page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 }).catch(() => {});
	await pause(400);
}

// ── The surfaces ───────────────────────────────────────────────────────
//
// `sel` is what gets photographed; `open` is what has to happen first. A
// surface that will not open on a cell is reported, not silently dropped: an
// absent picture reads as "clean" to whoever reads the directory.
const SURFACES = [
	{ id: 'rail', sel: '#panel-rail', mobileDrawer: true,
		open: async () => { await quieten(); await page.evaluate(() => DaimondPanels.show('rail')); } },

	{ id: 'dlg-newdiamond', sel: '.dlg-card',
		open: async () => {
			await quieten();
			await page.evaluate(() => DaimondPanels.show('rail'));
			await page.click('#new-diamond-btn', { force: true });
			await page.waitForSelector('.dlg-input', { timeout: 6000 });
		},
		after: async () => { await page.keyboard.press('Escape'); await pause(200); } },

	{ id: 'crystal', sel: '.crystal-bar',
		open: async () => {
			await quieten();
			await page.evaluate(() => DaimondPanels.show('rail'));
			await page.$$eval('.diamond-box', (els) => els[0] && els[0].click());
			await pause(600);
		} },

	{ id: 'tag-editor', sel: '.tag-editor',
		open: async () => {
			await quieten();
			await page.evaluate(() => DaimondPanels.show('rail'));
			await page.$$eval('.diamond-box', (els) => els[0] && els[0].click());
			await pause(600);
			await page.evaluate(() => {
				const b = [...document.querySelectorAll('.crystal-act')]
					.find((x) => /tag/i.test(x.textContent || ''));
				if (b) b.click();
			});
			await page.waitForSelector('.tag-editor', { timeout: 6000 });
		} },

	{ id: 'tag-pool', sel: '#diamond-filter',
		open: async () => {
			await quieten();
			await page.evaluate(() => DaimondPanels.show('rail'));
			await page.click('#diamond-filter .tagf-toggle', { force: true }).catch(() => {});
			await pause(350);
		} },

	{ id: 'admin-home',    sel: '#admin-body', admin: 'settings-btn' },
	{ id: 'admin-models',  sel: '#admin-body', admin: 'astat-model' },
	{ id: 'admin-account', sel: '#admin-body', admin: 'astat-account' },
	{ id: 'admin-tools',   sel: '#admin-body', admin: 'astat-tools' },
	{ id: 'admin-hand',    sel: '#admin-body', admin: 'astat-hand' },
	{ id: 'admin-release', sel: '#admin-body', admin: 'astat-release' },
	{ id: 'admin-pro',     sel: '#admin-body', admin: 'astat-pro' },

	{ id: 'admin-models-form', sel: '#admin-body',
		open: async () => {
			await quieten();
			await page.evaluate(() => DaimondPanels.show('rail'));
			await page.click('#astat-model', { force: true });
			await pause(450);
			await page.click('#models-add', { force: true }).catch(() => {});
			await pause(350);
		} },

	{ id: 'settings-modal', sel: '#settings-modal .modal-card',
		open: async () => {
			await quieten();
			await page.evaluate(() => {
				const m = document.getElementById('settings-modal');
				if (m) m.style.display = '';
			});
			await pause(300);
		} },

	{ id: 'appearance', sel: '#settings-menu',
		open: async () => {
			await quieten();
			await page.click('#settings-menu-btn', { force: true });
			await pause(320);
		},
		after: async () => { await page.keyboard.press('Escape'); await pause(150); } },

	{ id: 'gallery', sel: '#panel-gallery',
		open: async (cell) => {
			await quieten();
			// `#panel-more` is drawn only when the chip row cannot hold every chip,
			// which at 1500px it always can. Narrow the window until the row
			// overflows — that IS the state the gallery exists for, so it is the
			// honest one to photograph, not a reach past the UI.
			await page.setViewportSize({ width: Math.min(cell.w, 1000), height: cell.h });
			await pause(400);
			const more = await page.$('#panel-more');
			if (!more) return false;
			await more.click({ force: true });
			await pause(320);
			return true;
		},
		after: async (cell) => {
			await page.keyboard.press('Escape');
			await page.setViewportSize({ width: cell.w, height: cell.h });
			await pause(250);
		} },

	{ id: 'handmode', sel: '#hand-mode-pop',
		open: async () => {
			await quieten();
			await page.evaluate(() => DaimondPanels.show('ai'));
			await pause(300);
			const chip = await page.$('#hand-mode-chip');
			if (!chip) return false;
			await chip.click({ force: true });
			await pause(320);
			return true;
		},
		after: async () => { await page.keyboard.press('Escape'); await pause(150); } },

	{ id: 'palette', sel: '.pal-box',
		open: async () => {
			await quieten();
			await page.keyboard.press('Control+k');
			await pause(350);
			const ok = await page.$eval('#palette', (el) => !el.hidden).catch(() => false);
			if (!ok) return false;
			await page.fill('.pal-input', 'sp').catch(() => {});
			await pause(250);
			return true;
		},
		after: async () => { await page.keyboard.press('Escape'); await pause(150); } },
];

// ── Measurement: rows that claim to be even ────────────────────────────
//
// Photographs catch what is grossly wrong. These catch what is a few pixels
// wrong, which is the class the user has twice had to point out.
const EVENNESS = function () {
	const out = [];
	const round = (n) => Math.round(n * 100) / 100;
	// A row of siblings meant to read as one control. If they are unequal, say
	// by how much, and name the narrowest and the widest so the fix is obvious.
	const ROWS = [
		{ what: '.seg (dock tiling / spacing)', sel: '.seg', child: 'button' },
		{ what: 'mobile tab bar',               sel: '#mnav', child: 'button' },
		{ what: 'chat head chips',              sel: '.chat-head-right', child: 'button' },
		{ what: 'crystal actions',              sel: '.crystal-bar', child: 'button' },
		{ what: 'dialog actions',               sel: '.dlg-actions', child: 'button' },
		{ what: 'mode ladder rungs',            sel: '#hand-mode-pop', child: '.mode-row, label' },
	];
	for (const r of ROWS) {
		document.querySelectorAll(r.sel).forEach((row, n) => {
			if (row.getClientRects().length === 0) return;
			const kids = [...row.querySelectorAll(r.child)]
				.filter((k) => k.getClientRects().length && k.parentElement === row);
			if (kids.length < 2) return;
			const ws = kids.map((k) => k.getBoundingClientRect().width);
			const hs = kids.map((k) => k.getBoundingClientRect().height);
			const lo = Math.min(...ws), hi = Math.max(...ws);
			// One row, or two? A wrapped row's widths are meant to differ.
			const tops = new Set(kids.map((k) => Math.round(k.getBoundingClientRect().top)));
			out.push({
				row: `${r.what}${n ? ` [${n}]` : ''}`,
				n: kids.length,
				lines: tops.size,
				widths: ws.map(round),
				heights: hs.map(round),
				spread: round(hi - lo),
				narrowest: kids[ws.indexOf(lo)].textContent.trim().slice(0, 16),
				widest: kids[ws.indexOf(hi)].textContent.trim().slice(0, 16),
			});
		});
	}
	// Anything wrapping onto a second line inside a header that means to be one
	// line. A header that wraps leaves a void beside its title, which is the
	// mobile-sheet complaint exactly.
	for (const sel of ['.msheet-grab', '.panel-head', '.chead', '.railhead', '.admin-drawer-head', '.pptw-head']) {
		document.querySelectorAll(sel).forEach((h) => {
			if (h.getClientRects().length === 0) return;
			const kids = [...h.children].filter((k) => k.getClientRects().length);
			if (kids.length < 2) return;
			// Not "the tops differ" — in any header a 22px button and a 16px
			// heading sit at different tops by design, and testing for that
			// reports every header in the app. A header has WRAPPED when the
			// vertical spread exceeds the tallest child, which no single line
			// can do.
			const rs = kids.map((k) => k.getBoundingClientRect());
			const spreadY = Math.max(...rs.map((r) => r.top)) - Math.min(...rs.map((r) => r.top));
			const tallest = Math.max(...rs.map((r) => r.height));
			if (spreadY > tallest * 0.8) {
				out.push({
					row: `WRAPPED HEADER ${sel}`,
					n: kids.length,
					lines: 2,
					spreadY: round(spreadY),
					tallest: round(tallest),
					widths: rs.map((r) => round(r.width)),
					heights: rs.map((r) => round(r.height)),
					text: h.textContent.trim().replace(/\s+/g, ' ').slice(0, 40),
				});
			}
		});
	}
	// The two rail lists, side by side: a Diamond tile and a chat tile that do
	// not start at the same x read as a wobble down the whole rail.
	const dl = document.querySelector('#diamond-list');
	const sl = document.querySelector('#session-list');
	if (dl && sl && dl.getClientRects().length && sl.getClientRects().length) {
		const d = dl.querySelector('.session-box'), c = sl.querySelector('.session-box');
		out.push({
			row: 'RAIL TILE INSET',
			diamondList: getComputedStyle(dl).padding,
			sessionList: getComputedStyle(sl).padding,
			diamondTileLeft: d ? round(d.getBoundingClientRect().left) : null,
			chatTileLeft:    c ? round(c.getBoundingClientRect().left) : null,
			diamondTileRight: d ? round(d.getBoundingClientRect().right) : null,
			chatTileRight:    c ? round(c.getBoundingClientRect().right) : null,
		});
	}
	return out;
};

// ── Run ────────────────────────────────────────────────────────────────
const findings = [];
let shots = 0, misses = 0;

async function snap(label, sel) {
	const file = path.join(OUT, label.replace(/[^\w.-]+/g, '_') + '.png');
	const el = await page.$(sel);
	if (!el) return null;
	try {
		await el.screenshot({ path: file, timeout: 8000, animations: 'disabled' });
	} catch (e) {
		try {
			const box = await el.boundingBox();
			const vp = page.viewportSize();
			if (!box) throw e;
			const clip = {
				x: Math.max(0, box.x), y: Math.max(0, box.y),
				width:  Math.min(box.width,  vp.width  - Math.max(0, box.x)),
				height: Math.min(box.height, vp.height - Math.max(0, box.y)),
			};
			await page.screenshot({ path: file, clip, timeout: 8000, animations: 'disabled' });
		} catch (e2) { console.log(`  MISS  ${label} — ${(e2.message || e2).toString().split('\n')[0]}`); misses++; return null; }
	}
	// The trap this file exists under: `shot()` swallows a failure, so the run
	// looks clean and the directory is empty. Confirm the bytes.
	if (!fs.existsSync(file) || fs.statSync(file).size < 200) {
		console.log(`  MISS  ${label} — no bytes on disk`); misses++; return null;
	}
	shots++;
	return file;
}

try {
	await page.waitForFunction(() => !!(window.DaimondPanels && DaimondPanels.panels), null, { timeout: 20000 });
	await seed();
	console.log(`seeded; sweeping ${SURFACES.length} surfaces over ${CELLS.length} cells into ${OUT}\n`);

	for (const cell of CELLS) {
		console.log(`── ${cell.tag}`);
		await page.setViewportSize({ width: cell.w, height: cell.h });
		await page.evaluate((c) => {
			document.documentElement.setAttribute('data-skin', c.skin);
			document.documentElement.setAttribute('data-theme', c.theme);
			document.documentElement.setAttribute('data-tone', c.theme === 'light' ? 'light' : 'dark');
			document.documentElement.setAttribute('data-ink', c.theme === 'light' ? 'dark' : 'light');
		}, cell);
		await pause(300);

		for (const surf of SURFACES) {
			if (ONLY.length && !ONLY.includes(surf.id)) continue;
			try {
				// Below the breakpoint the rail is behind the hamburger. Photograph
				// the chat instead of the rail and the picture is mislabelled, which
				// is worse than no picture.
				if (cell.w < 700 && (surf.mobileDrawer || /^(rail|tag-|crystal|admin-|dlg-)/.test(surf.id))) {
					await quieten();
					const btn = await page.$('#drawer-btn');
					if (btn) { await btn.click({ force: true }); await pause(400); }
				}
				let ok = true;
				if (surf.admin) {
					await quieten();
					if (cell.w >= 700) await page.evaluate(() => DaimondPanels.show('rail'));
					const b = await page.$('#' + surf.admin);
					if (!b || !(await b.isVisible())) ok = false;
					else { await b.click({ force: true }); await pause(450); }
				} else if (surf.open) {
					const r = await surf.open(cell);
					if (r === false) ok = false;
				}
				if (!ok) { console.log(`  skip  ${surf.id} — no opener on this cell`); continue; }

				const shown = await page.$eval(surf.sel, (el) => {
					const r = el.getBoundingClientRect();
					return r.width > 4 && r.height > 4;
				}).catch(() => false);
				if (!shown) { console.log(`  skip  ${surf.id} — did not show`); continue; }

				const file = await snap(`${cell.tag}--${surf.id}`, surf.sel);
				const rows = await page.evaluate(EVENNESS);
				findings.push({ cell: cell.tag, surface: surf.id, shot: file, rows });
				// Only the rows that MEAN to be even are faulted for unevenness.
				// The crystal bar's three buttons are sized to their words and are
				// meant to be; the segmented controls and the tab bar are not.
				const EVEN = /\.seg|tab bar|dialog actions|ladder/;
				const bad = rows.filter((r) => (EVEN.test(r.row) && r.spread > 1 && r.lines === 1)
					|| /WRAPPED/.test(r.row));
				console.log(`  ${bad.length ? 'LOOK' : ' ok '}  ${surf.id}${bad.length ? '  ' + bad.map((b) => b.row + (b.spread ? ` spread ${b.spread}px` : '')).join('; ') : ''}`);
				if (surf.after) await surf.after(cell);
			} catch (e) {
				console.log(`  ERR   ${surf.id} — ${(e.message || String(e)).split('\n')[0]}`);
			}
		}
	}

	const jsonPath = path.join(OUT, 'qc.json');
	fs.writeFileSync(jsonPath, JSON.stringify(findings, null, '\t'));
	console.log(`\n${shots} shots, ${misses} missed, in ${OUT}\n${jsonPath}`);
	const errs = errors(s).filter((e) => !/502|Bad Gateway/.test(e));
	if (errs.length) {
		console.log(`\n${errs.length} console error(s):`);
		for (const e of errs.slice(0, 10)) console.log('  ' + String(e).split('\n')[0]);
	}
} finally {
	await s.close();
}
