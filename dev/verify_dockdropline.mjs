// gateway: none
// verify_dockdropline.mjs — the Dock's drop indicator is a LINE at the edge a
// carried panel will be inserted at, it can be seen in every palette, and the
// release lands exactly where it was drawn.
//
// His stumble (1 Nov 2026, UNBLOCK-77): the Workspace docked, Email added as a
// second row, then carried left to make two columns. The indicator shaded the
// whole Workspace column (a 7% accent tint, invisible in Ember) where a new
// column should be a vertical line to its left, as a new row is a horizontal
// one. This file drives that gesture with a real pointer in every palette and
// measures what is painted, never the engine's bookkeeping alone.
//
//   node dev/verify_dockdropline.mjs          # needs a world (DAIMOND_PORT)
//
// Shots: dev/shots/dockdropline-<palette>-{before,during,after}.png for his
// case in Ember (`dark`), Light and Midnight.
import { open, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── Reading the page ────────────────────────────────────────────────────

const shape = (p) => p.evaluate(() => window.DaimondPanels.dock());
const box = (p, sel) => p.evaluate((sel) => {
	const el = document.querySelector(sel);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}, sel);
const HEAD = (id) => `.panel[data-panel="${id}"] .railhead > [role="heading"]`;

/// Everything the overlay is painting, with the colours it is painted in and
/// the colours it is painted OVER: the panel under the indicator, and the
/// gutter (the Dock's own ground between panels). Backgrounds are composited
/// up the ancestor chain, since a translucent fill is only a colour once it is
/// laid on what is behind it.
const PAINTED = () => {
	const parse = (s) => {
		const m = (s || '').match(/rgba?\(([^)]*)\)/);
		if (!m) return null;
		const v = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
		return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1];
	};
	const ground = (el) => {
		const stack = [];
		for (let e = el; e; e = e.parentElement) {
			const c = parse(getComputedStyle(e).backgroundColor);
			if (c && c[3] > 0) { stack.push(c); if (c[3] >= 1) break; }
		}
		let out = [255, 255, 255];
		for (let i = stack.length - 1; i >= 0; i--) {
			const [r, g, b, a] = stack[i];
			out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
		}
		return out;
	};
	const lum = (c) => {
		const f = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
		return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
	};
	const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
	const seen = (sel) => {
		const e = document.querySelector(sel);
		if (!e || e.hidden) return null;
		const r = e.getBoundingClientRect();
		const cs = getComputedStyle(e);
		return {
			x: r.x, y: r.y, w: r.width, h: r.height,
			fill: parse(cs.backgroundColor), edge: parse(cs.borderTopColor),
			edgeW: parseFloat(cs.borderTopWidth) || 0, edgeStyle: cs.borderTopStyle,
			caps: getComputedStyle(e, '::before').content !== 'none'
				&& getComputedStyle(e, '::after').content !== 'none',
		};
	};
	const line = seen('.ddz-line'), boxed = seen('.ddz-box'), col = seen('.ddz-col');
	// What is under the indicator: a docked panel, and the Dock's gutter.
	const panel = document.querySelector('#dock .panel[data-zone="dock"]');
	const gutter = document.querySelector('#dock .pcol') || document.getElementById('dock');
	const mark = line ? line.fill : (boxed ? boxed.edge : (col ? col.edge : null));
	const vs = (el) => (mark && el) ? ratio(mark, ground(el)) : null;
	return {
		zone: window.DaimondDockDrag.showing(),
		line, boxed, col,
		onPanel: vs(panel), onGutter: vs(gutter),
		ghost: (() => {
			const g = document.querySelector('.ptag-ghost');
			if (!g) return null;
			const cs = getComputedStyle(g);
			return { opacity: Number(cs.opacity), text: ratio(parse(cs.color), ground(g)) };
		})(),
	};
};

/// Press a heading, travel to `to`, and answer what is painted -- without
/// releasing.
const carryTo = async (p, from, to) => {
	const a = await box(p, from);
	if (!a) throw new Error('no drag source ' + from);
	await p.mouse.move(a.cx, a.cy);
	await p.mouse.down();
	await p.mouse.move(a.cx + 8, a.cy + 6, { steps: 3 });
	await p.mouse.move(to.x, to.y, { steps: 10 });
	await p.waitForTimeout(160);
	return p.evaluate(PAINTED);
};
const release = async (p) => { await p.mouse.up(); await p.waitForTimeout(450); };

/// The arrangement a cell starts from, through the app's own doors.
const seed = async (p, grid, ids) => {
	await p.evaluate(({ grid, ids }) => {
		const P = window.DaimondPanels;
		P.panels().forEach((x) => P.setPinned(x.id, true));
		P.panels().filter((x) => x.zone === 'dock').forEach((x) => P.hide(x.id));
		P.setGrid(grid);
		ids.forEach((id) => P.show(id));
	}, { grid, ids });
	await p.waitForTimeout(500);
};
/// Seat an exact arrangement: open in order, then drop each into place.
const arrange = async (p, cols) => {
	await seed(p, 'auto', cols.flat());
	await p.evaluate((cols) => {
		const P = window.DaimondPanels;
		// Everything into the first column, in order; then each later column
		// is made at the right edge and filled.
		cols.flat().forEach((id, i) => {
			if (!i) return;
			P.placeDock(id, { kind: 'after', col: 0, row: i - 1 });
		});
		for (let c = 1; c < cols.length; c++) {
			P.placeDock(cols[c][0], { kind: 'newcol', col: c, row: 0 });
			for (let r = 1; r < cols[c].length; r++) P.placeDock(cols[c][r], { kind: 'after', col: c, row: r - 1 });
		}
	}, cols);
	await p.waitForTimeout(500);
};

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const THIN = 5;            // the line's weight (3px) plus its 1px ring either side
const isH = (l) => !!l && l.h <= THIN && l.w > 40;
const isV = (l) => !!l && l.w <= THIN && l.h > 40;
const fmt = (o) => JSON.stringify(o && { x: Math.round(o.x), y: Math.round(o.y), w: Math.round(o.w), h: Math.round(o.h) });

const s = await open({ name: 'dockdropline', connect: false });
const p = s.page;
await p.setViewportSize({ width: 2200, height: 1000 });
await p.waitForTimeout(1600);
const PALETTES = await p.evaluate(() => window.DaimondTheme.list());
const SKINS = await p.evaluate(() => (window.DaimondSkin ? window.DaimondSkin.list() : ['daylight']));
const setLook = async (theme, skin) => {
	await p.evaluate(({ theme, skin }) => {
		window.DaimondTheme.set(theme);
		if (skin) document.documentElement.setAttribute('data-skin', skin);
	}, { theme, skin });
	await p.waitForTimeout(250);
};

// ── 1. His case, in Ember and two more palettes ─────────────────────────
for (const theme of ['dark', 'light', 'midnight']) {
	await setLook(theme);
	// At 2200px Auto seats a second panel as a second column, so his case is
	// seated as he had it: one column, the Workspace over Email.
	await arrange(p, [['work', 'mail']]);
	const start = await shape(p);
	check(`${theme}: Email added after the Workspace becomes its second row`,
		JSON.stringify(start) === JSON.stringify([['work', 'mail']]), JSON.stringify(start));
	await shot(s, `dockdropline-${theme}-before`);
	const dock = await box(p, '#dock');
	const got = await carryTo(p, HEAD('mail'), { x: dock.x + 10, y: dock.y + dock.h * 0.4 });
	await shot(s, `dockdropline-${theme}-during`);
	check(`${theme}: carried left, the Dock offers a new column`,
		!!(got.zone && got.zone.kind === 'newcol' && got.zone.col === 0), got.zone && got.zone.kind);
	check(`${theme}: drawn as a vertical line at the Workspace column's left edge`,
		isV(got.line) && near(got.line.x + got.line.w / 2, dock.x, 3)
			&& got.line.h >= dock.h * 0.9, `line ${fmt(got.line)}, dock x ${Math.round(dock.x)}`);
	check(`${theme}: and nothing shades the existing column`, !got.boxed && !got.col,
		`box ${fmt(got.boxed)} col ${fmt(got.col)}`);
	check(`${theme}: the line carries an end cap at each end (an I-beam, not a divider)`,
		!!(got.line && got.line.caps));
	check(`${theme}: the line clears 3:1 against the panel it crosses`,
		got.onPanel >= 3, got.onPanel && got.onPanel.toFixed(2));
	check(`${theme}: and against the Dock's gutter`, got.onGutter >= 3, got.onGutter && got.onGutter.toFixed(2));
	check(`${theme}: the ghost is opaque and its name reads at 4.5:1`,
		!!(got.ghost && got.ghost.opacity >= 1 && got.ghost.text >= 4.5),
		JSON.stringify(got.ghost));
	await release(p);
	await shot(s, `dockdropline-${theme}-after`);
	const after = await shape(p);
	check(`${theme}: the release lands Email where the line was, the first of two columns`,
		JSON.stringify(after) === JSON.stringify([['mail'], ['work']]), JSON.stringify(after));
}

// ── 2. Every drop kind: what is drawn, and where the release lands ──────
await setLook('dark');
{
	// before / after / replace, in one column of three.
	const cases = [
		{ kind: 'before', at: 'work', f: 0.12, want: [['agents', 'work', 'mail']], from: 'agents', line: 'h', edge: (w, m, a) => w.y },
		{ kind: 'before', at: 'mail', f: 0.12, want: [['work', 'agents', 'mail']], from: 'agents', line: 'h', edge: (w, m, a) => (w.y + w.h + m.y) / 2 },
		{ kind: 'after',  at: 'mail', f: 0.88, want: [['mail', 'work', 'agents']], from: 'work', line: 'h', edge: (w, m, a) => (m.y + m.h + a.y) / 2 },
		{ kind: 'after',  at: 'agents', f: 0.88, want: [['work', 'agents', 'mail']], from: 'mail', line: 'h', edge: (w, m, a) => a.y + a.h },
		{ kind: 'replace', at: 'work', f: 0.5, want: [['agents', 'mail', 'work']], from: 'agents', line: null },
	];
	for (const c of cases) {
		await arrange(p, [['work', 'mail', 'agents']]);
		const pr = await box(p, `.panel[data-panel="${c.at}"]`);
		const pw = await box(p, '.panel[data-panel="work"]'), pm = await box(p, '.panel[data-panel="mail"]');
		const pa = await box(p, '.panel[data-panel="agents"]');
		const got = await carryTo(p, HEAD(c.from), { x: pr.cx, y: pr.y + pr.h * c.f });
		check(`${c.kind} ${c.at}: the zone under the pointer is ${c.kind}`, !!(got.zone && got.zone.kind === c.kind),
			got.zone && got.zone.kind);
		if (c.line === 'h') {
			const edge = c.edge(pw, pm, pa);
			check(`${c.kind} ${c.at}: a horizontal line on the boundary (a gap's middle), never a shade`,
				isH(got.line) && !got.boxed && !got.col && near(got.line.y + got.line.h / 2, edge, 2),
				`line ${fmt(got.line)}, edge y ${Math.round(edge)}`);
			check(`${c.kind} ${c.at}: with end caps`, !!(got.line && got.line.caps));
		} else {
			check('replace: the one area drop, outlined in the indicator token over the panel',
				!!(got.boxed && !got.line && got.boxed.edgeW >= 2 && near(got.boxed.y, pr.y, 2)
					&& near(got.boxed.h, pr.h, 2)), `box ${fmt(got.boxed)} edge ${got.boxed && got.boxed.edgeW}`);
			check('replace: its outline clears 3:1 against the panel', got.onPanel >= 3,
				got.onPanel && got.onPanel.toFixed(2));
		}
		await release(p);
		const after = await shape(p);
		check(`${c.kind} ${c.at}: the release lands where it was drawn`,
			JSON.stringify(after) === JSON.stringify(c.want), JSON.stringify(after));
	}
	// The boundary between two rows is one line whichever side of it is aimed at.
	await arrange(p, [['work', 'mail', 'agents']]);
	const w = await box(p, '.panel[data-panel="work"]'), m = await box(p, '.panel[data-panel="mail"]');
	const lo = await carryTo(p, HEAD('agents'), { x: w.cx, y: w.y + w.h * 0.9 });
	await p.mouse.move(m.cx, m.y + m.h * 0.1, { steps: 4 });
	await p.waitForTimeout(160);
	const hi = await p.evaluate(PAINTED);
	await p.keyboard.press('Escape');
	await p.waitForTimeout(200);
	await p.mouse.up();
	await p.waitForTimeout(300);
	check('the boundary between two rows draws ONE line, at the gap\'s middle, from either side',
		!!(lo.line && hi.line && near(lo.line.y, hi.line.y, 1)
			&& near(lo.line.y + lo.line.h / 2, (w.y + w.h + m.y) / 2, 2)),
		`from above ${fmt(lo.line)}, from below ${fmt(hi.line)}`);

	// newcol at the right edge: a vertical line, kept inside the window.
	await arrange(p, [['work', 'mail']]);
	const d = await box(p, '#dock');
	const vw = await p.evaluate(() => document.documentElement.clientWidth);
	const r = await carryTo(p, HEAD('work'), { x: d.x + d.w - 8, y: d.y + d.h * 0.5 });
	check('newcol right: a vertical line on the right edge, wholly inside the window',
		!!(r.zone && r.zone.kind === 'newcol') && isV(r.line) && !r.col && !r.boxed
			&& r.line.x + r.line.w <= vw && r.line.x >= d.x + d.w - 8,
		`line ${fmt(r.line)}, dock right ${Math.round(d.x + d.w)}, window ${vw}`);
	await release(p);
	check('newcol right: the release makes the column on the right',
		JSON.stringify(await shape(p)) === JSON.stringify([['mail'], ['work']]), JSON.stringify(await shape(p)));

	// A small overshoot past the left edge, into the stage, still asks for the column.
	await arrange(p, [['work', 'mail']]);
	const d2 = await box(p, '#dock');
	const os = await carryTo(p, HEAD('mail'), { x: d2.x - 14, y: d2.y + d2.h * 0.5 });
	check('an overshoot of 14px past the left edge still offers the column, not the stage',
		!!(os.zone && os.zone.kind === 'newcol'), os.zone ? os.zone.kind : 'out of the Dock');
	// Escape cancels: nothing is drawn, nothing moves, nothing is closed.
	await p.keyboard.press('Escape');
	await p.waitForTimeout(200);
	const esc = await p.evaluate(PAINTED);
	await p.mouse.up();
	await p.waitForTimeout(350);
	check('Escape cancels the drag: no indicator, no ghost, and the Dock unchanged',
		!esc.line && !esc.boxed && !esc.col && !esc.ghost
			&& JSON.stringify(await shape(p)) === JSON.stringify([['work', 'mail']]),
		JSON.stringify(await shape(p)));

	// The empty Dock: one area, outlined dashed.
	await seed(p, 'auto', []);
	const chip = await box(p, '#panel-tags .ptag[data-panel="mail"]');
	if (!chip) console.log('  (no mail chip: ' + await p.evaluate(() => [...document.querySelectorAll('#panel-tags .ptag')].map((e) => e.dataset.panel).join(',')) + ')');
	const main = await box(p, '#main');
	const em = chip && await carryTo(p, '#panel-tags .ptag[data-panel="mail"]',
		{ x: main.x + main.w - 60, y: main.y + main.h * 0.5 });
	check('empty Dock: the first column is an outlined, dashed area in the token',
		!!(em && em.zone && em.zone.kind === 'empty' && em.col && em.col.edgeStyle === 'dashed'
			&& em.col.edgeW >= 2 && !em.line), em && `${em.zone && em.zone.kind} ${fmt(em.col)} ${em.col && em.col.edgeStyle}`);
	if (em) await release(p);
	check('empty Dock: the release docks it',
		JSON.stringify(await shape(p)) === JSON.stringify([['mail']]), JSON.stringify(await shape(p)));
}

// ── 3. Touch: hold, carry, release ──────────────────────────────────────
{
	await arrange(p, [['work', 'mail']]);
	const h = await box(p, HEAD('mail'));
	const d = await box(p, '#dock');
	const cdp = await p.context().newCDPSession(p);
	await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
	const tp = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(h.cx, h.cy) });
	await p.waitForTimeout(500);       // past the gesture's hold
	for (let i = 1; i <= 10; i++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
			touchPoints: tp(h.cx + (d.x + 10 - h.cx) * i / 10, h.cy) });
		await p.waitForTimeout(20);
	}
	await p.waitForTimeout(160);
	const tg = await p.evaluate(PAINTED);
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await p.waitForTimeout(450);
	await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
	check('touch: a held finger carried left draws the same vertical line',
		!!(tg.zone && tg.zone.kind === 'newcol') && isV(tg.line), `${tg.zone && tg.zone.kind} ${fmt(tg.line)}`);
	check('touch: and lifting the finger lands it there',
		JSON.stringify(await shape(p)) === JSON.stringify([['mail'], ['work']]), JSON.stringify(await shape(p)));
}

// ── 4. Rendered contrast, every palette × every skin ────────────────────
for (const skin of SKINS) {
	for (const theme of PALETTES) {
		await setLook(theme, skin);
		await arrange(p, [['work', 'mail']]);
		const dk = await box(p, '#dock');
		const got = await carryTo(p, HEAD('mail'), { x: dk.x + 10, y: dk.y + dk.h * 0.4 });
		await p.keyboard.press('Escape');
		await p.waitForTimeout(150);
		await p.mouse.up();
		await p.waitForTimeout(200);
		const worst = Math.min(got.onPanel || 0, got.onGutter || 0);
		check(`${skin}/${theme}: the drop line against panel ${(got.onPanel || 0).toFixed(2)} and gutter ${(got.onGutter || 0).toFixed(2)} (floor 3)`,
			isV(got.line) && worst >= 3);
	}
}

await s.close?.();
console.log(`\n${ok.length} ok, ${bad.length} FAIL`);
process.exit(bad.length ? 1 : 0);
