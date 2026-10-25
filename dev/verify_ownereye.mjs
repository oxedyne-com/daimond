// gateway: none
// verify_ownereye.mjs -- E0 of the owner's-eye gate (specs/daimond_owner_eye_gate_20261023.md
// §10, §12): the rail checked against his rulings, as he sees it, at his sizes.
//
// Each assertion cites a ruling by id and a verbatim quote from rulings/daimond_rulings.md
// (DK_RULINGS overrides the path); a quote not found on a line carrying its id fails the
// run before a browser starts. Every finding names the element, the cell and the number.
//
// CELLS   1440x900 and 1280x720 in Chromium; 393x793 in WebKit, touch, the drawer open
//         (his phone). Obsidian and Porcelain in each.
// STATES  thin: four Diamonds, four chats, no money pool. full: forty of each (tagged) and three
//         pools ("Daimond credits", "OpenRouter", "Fireworks AI"), as the approved
//         per-pool Today shots (railfix/shots/today_per_pool_*) show them.
//         real: his setup as he runs it (lead, UNBLOCK-33): forty tagged Diamonds, twenty
//         chats, the three pools, a model set (no "No model · Connect" row) and a synced
//         gateway (no "This device only"), so the rail's top lines are his, not a fresh one's.
//
//   R1  rail.desk.no-floor-scroll    the desktop rail is not a scroller, no --rail-top-min
//   R2  rail.pools.always-visible    every battery whole on screen, every rail scroller at
//                                    top, middle and end
//   R3  rail.today.shares-row        each pool's own Today shares its pool's row; no total
//                                    Today anywhere (none at all with no pool)
//   R4  rail.phone.five-tiles        phone: each list its own window, holding >= 5 whole tiles at rest
//                                    whatever day heads fall among them (dev/railwin.mjs)
//   R5  rail.no-week-month-ev        no Week or Month tally, no "ev" title
//   R6  rail.pools.rows-shape        one row a pool, battery left of name and balance,
//                                    dials and Todays aligned down the rail, one-line range,
//                                    every landmark of the picked shots drawn and whole
//   R7  rail.dial.thirds             dial face: lower uncoloured, middle --warn, upper --danger
//   R8  rail.desk.lists-as-before    desktop lists each their own scroller, no five-tile floor,
//                                    neither crushed by the other (the split's floor, or halves)
//   R9  rail.no-nested-scroll        no scroller in a scroller; Models' "+ Add Provider"
//                                    reachable at the panel's end
//   R10 rail.pool.name-exact         each pool's name is its provider's name, whole
//   R11 rail.desk.three-tiles        tagged, at rest, on `real` (his setup): 1280x720 and 1440x900 >= 1 whole
//                                    Diamond tile and >= 1 whole chat tile (owner, 24 Oct "Own row, relax 1280",
//                                    D-20261024-04; was 2 + 1 under D-20261023-05; 1440 holds at least his 1280 floor);
//                                    on `full` the figures are report-only (its needs row is not his state); a tagged
//                                    Diamond's chips are a row of their own, below its name (every state and size,
//                                    CHIPLINE D-20261024-04)
//   R12 rail.phone.tagged-one-line   phone, full + real: only whole chips (none past the gear, none cut); a tagged
//                                    tile grows by one chip line and no more (CHIPLINE); the name cut only when it cannot fit
//                                    alone, with no chip beside it ("+N" folds first); at rest, full: five whole
//                                    Diamond tiles, then the Chats heading in view above the pinned foot, the first
//                                    chat may be one scroll away (D-20261024-04, "Chats heading is enough"); real:
//                                    the Chats heading in view. With the status row pinned over the batteries
//                                    (D-20261024-13, his pick "Heading one scroll away"): five whole Diamond tiles
//                                    always, full and real; the Chats heading may sit one scroll away under the row
//   R13 rail.tags.more-opens         every size, full + real: one row of whole chips under the name, starting at the
//                                    name's x, no scroller, the
//                                    tile one chip row taller; "+N" a popup button opening every tag as a filter chip,
//                                    Escape closing it back to "+N" (CHIPLINE D-20261024-04)
//
//   bash dev/world.sh 93 --up; eval "$(bash dev/world.sh 93 --env)"
//   node dev/verify_ownereye.mjs [--cite <D-id>] [--only R1,R2] [--vp 1440x900,393x793]
//        [--www <dir>] [--shots <dir>] [--list]
// --www (or OE_WWW) serves another tree's www (a `git archive` of BASE) for the red run.
// dev/owner_eye/*.mjs add assertion modules to the registry (see the loader below).
// Exit 0 green, 1 a finding, 2 a lint or setup fault, 3 zero checks (ZERO-ARMS).

import fs from 'node:fs';
import path from 'node:path';
import { open, signInAs, scratch, APP } from './harness.mjs';
import { standInPools } from './ownereye_pools.mjs';
import { railWinFindings } from './railwin.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const CITE = arg('--cite'), ONLY = (arg('--only') || process.env.OE_ONLY || '').split(',').filter(Boolean);	// OE_ONLY / OE_VP: the same through dk arms
const VPS = (arg('--vp') || process.env.OE_VP || '').split(',').filter(Boolean), SHOTS = arg('--shots') || process.env.OE_SHOTS || null;	// OE_SHOTS: the same through dk arms
const OTHER = arg('--www') || process.env.OE_WWW || null;	// OE_WWW: the same through dk arms, which passes no argument
const LIST = process.argv.includes('--list');
const RULINGS = process.env.DK_RULINGS || path.join(process.env.HOME, 'usr/code/ai/claude/rulings/daimond_rulings.md');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
// WHERE AND WHEN EVERY SCENARIO IS: one zone, and the instants each world is opened at.
// The zone alone left the date free, and R4 read a Yesterday head as tile height between
// 00:00 and 01:00 Sydney (2026-10-25). Every world opens at the first instant, a Wednesday
// afternoon, its clock flowing from there. The rail's full and real worlds open again
// either side of midnight, their clock held still so the boundary falls where it is put
// (rig-prod §3.7 rule 1). Each page is checked to be on its instant's day before any check.
const OE_ZONE = 'Australia/Sydney', OE_AT = [
	{ at: '2026-10-21T14:00:00+11:00', held: false },	// every world
	{ at: '2026-10-21T23:59:50+11:00', held: true },	// rail full, real: the last seconds of a day
	{ at: '2026-10-22T00:00:10+11:00', held: true },	// rail full, real: the first of the next
];
// Installed on the page before its first script: Playwright's clock, flowing or held.
// open() installs the instant (RIG-PROD P2: it refuses a page without one); a held instant is then stopped there.
const clockAt = (t) => async (pg) => { if (t.held) await pg.clock.setFixedTime(t.at); };
// A world's name is its account's, drawn in the rail's footer, so it carries no clock; its
// browser profile is made fresh per run by `fresh` instead.
const fresh = (name) => scratch('pw', `${name}-${process.pid}-${Date.now()}`);
const POOLS = ['Daimond credits', 'OpenRouter', 'Fireworks AI'];

const Q_0523 = "The rail's dual scrolling (five-tile floor) is for the phone only";
const DESK = ['1440x900', '1280x720'], ALL = [...DESK, '393x793'];

// ── The registry (E1 moves these records unchanged) ─────────────────
const REG = [
	{ id: 'R1', name: 'rail.desk.no-floor-scroll', cite: { id: 'D-20261023-05', quote: 'the desktop rail does not scroll that way' },
	  vp: DESK, states: ['full'], check: (p) => p.evaluate(() => {
		const f = [], rail = document.getElementById('panel-rail'), rs = rail && rail.querySelector('.rail-scroll');
		if (!rail) return ['#panel-rail absent'];
		const sc = (e) => { const o = getComputedStyle(e); return o.display !== 'contents' && /auto|scroll/.test(o.overflowY) && e.scrollHeight > e.clientHeight + 1; };
		if (rs && sc(rs)) f.push(`.rail-scroll scrolls: scrollHeight ${rs.scrollHeight} > clientHeight ${rs.clientHeight}`);
		if (sc(rail)) f.push(`#panel-rail scrolls: scrollHeight ${rail.scrollHeight} > clientHeight ${rail.clientHeight}`);
		const m = rail.style.getPropertyValue('--rail-top-min');
		if (m) f.push(`#panel-rail --rail-top-min is set (${m})`);
		return f;
	}) },
	{ id: 'R2', name: 'rail.pools.always-visible', cite: { id: 'D-20261023-05', quote: 'The credit batteries are always visible in the rail, never scrolled away' },
	  vp: ALL, states: ['full'], check: (p) => p.evaluate(async () => {
		const f = [], rail = document.getElementById('panel-rail');
		const bats = [...rail.querySelectorAll('#spend-row .evp svg.evb')];
		if (bats.length !== 3) return [`${bats.length} batteries drawn in the rail, want 3`];
		const sc = (e) => { const o = getComputedStyle(e); return o.display !== 'contents' && /auto|scroll/.test(o.overflowY) && e.scrollHeight > e.clientHeight + 1; };
		const scrollers = [rail, ...rail.querySelectorAll('*')].filter(sc);
		const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		const look = (where) => {
			const rr = rail.getBoundingClientRect();
			bats.forEach((b, i) => {
				const q = b.getBoundingClientRect();
				const clip = [{ n: 'viewport', t: 0, b: innerHeight, l: 0, r: innerWidth }, { n: 'rail', t: rr.top, b: rr.bottom, l: rr.left, r: rr.right }];
				for (let a = b.parentElement; a && a !== document.body; a = a.parentElement) if (sc(a)) { const x = a.getBoundingClientRect(); clip.push({ n: a.id || a.className, t: x.top, b: x.bottom, l: x.left, r: x.right }); }
				for (const c of clip) if (q.top < c.t - 1 || q.bottom > c.b + 1 || q.left < c.l - 1 || q.right > c.r + 1 || q.height < 1)
					f.push(`battery ${i + 1} at ${Math.round(q.top)}-${Math.round(q.bottom)} outside ${c.n} ${Math.round(c.t)}-${Math.round(c.b)} (${where})`);
			});
		};
		look('at rest');
		for (const s of scrollers) {
			const was = s.scrollTop, end = s.scrollHeight - s.clientHeight;
			for (const [w, y] of [['top', 0], ['middle', end / 2], ['end', end]]) {
				s.scrollTop = y; await frame(); look(`${s.id || s.className.split(' ')[0]} at ${w}`);
			}
			s.scrollTop = was;
		}
		await frame();
		return [...new Set(f)];
	}) },
	{ id: 'R3', name: 'rail.today.shares-row', cite: { id: 'D-20261023-05', quote: 'Each credit account (pool) in the rail shows its own "Today" spend; there is no total "Today"' },
	  also: { id: 'D-20261023-05', quote: '"Today" never takes a row by itself' },
	  vp: ALL, states: ['thin', 'full'], check: (p, c) => p.evaluate((state) => {
		const f = [], rail = document.getElementById('panel-rail');
		const on = (e) => { if (!e || !e.getClientRects().length) return false; const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
		// Every money stat cell the rail draws outside its lists: the trip meter of old
		// (.spend-today / .spend-cell) and each pool's own Today (.evday).
		const cells = [...rail.querySelectorAll('.spend-cell, .spend-today, .evday')].filter(on)
			.filter((e) => !e.closest('#diamond-list, #session-list'));
		const rows = [...rail.querySelectorAll('#spend-row .evp')].filter(on);
		const totals = cells.filter((e) => !e.closest('.evp'));
		totals.forEach((e) => f.push(`a total Today "${e.textContent.trim()}" outside every pool row (${Math.round(e.getBoundingClientRect().top)} px)`));
		if (state === 'full') {
			if (rows.length !== 3) f.push(`${rows.length} pool rows, want 3`);
			rows.forEach((r) => { const n = r.querySelectorAll('.evday').length; if (n !== 1) f.push(`pool ${r.dataset.pool} has ${n} Today cells, want 1`); });
		}
		// lonecell: a stat cell whose line band holds no other drawn element of its container.
		for (const e of cells) {
			const box = e.closest('.evp') || e.parentElement, a = e.getBoundingClientRect();
			const mates = [...box.querySelectorAll('*')].filter((x) => !e.contains(x) && !x.contains(e) && on(x) && !x.children.length)
				.filter((x) => { const b = x.getBoundingClientRect(); return b.bottom > a.top + 2 && b.top < a.bottom - 2; });
			if (!mates.length) f.push(`"${e.textContent.trim()}" alone on its row (${Math.round(a.top)}-${Math.round(a.bottom)} px, ${Math.round(a.width)} px wide)`);
		}
		return f;
	}, c.state) },
	{ id: 'R4', name: 'rail.phone.five-tiles', cite: { id: 'D-20261020-12', quote: 'we need dual scrolling to provide scrollable windows of say min height 5 tiles or something' },
	  vp: ['393x793'], states: ['full'], check: async (p) => {
		// The page reports each list's geometry and railwin.mjs counts it, so dev/railwin.test.mjs
		// can feed it any hour's day heads without a browser.
		const got = await p.evaluate(() => [['#diamond-list', '.diamond-box'], ['#session-list', '.session-box']].map(([sel, row]) => {
			const l = document.querySelector(sel);
			const t = l ? [...l.querySelectorAll(row)].map((x) => x.getBoundingClientRect()).filter((b) => b.height > 0) : [];
			if (t.length < 6) return { sel, f: `${sel}: ${t.length} tiles drawn, want > 5` };
			const g = { clientHeight: l.clientHeight, scrollTop: l.scrollTop, top: l.getBoundingClientRect().top + l.clientTop,
				tiles: t.map((b) => ({ top: b.top, bottom: b.bottom })) };
			return { sel, g, f: l.scrollHeight > l.clientHeight + 1 ? '' : `${sel} is not its own scroller (${l.scrollHeight}/${l.clientHeight})` };
		}));
		return got.flatMap((x) => [...(x.f ? [x.f] : []), ...(x.g ? railWinFindings(x.sel, x.g) : [])]);
	} },
	{ id: 'R5', name: 'rail.no-week-month-ev', cite: { id: 'D-20261022-07', quote: 'Week and Month removed; no "ev" title' },
	  vp: ALL, states: ['thin', 'full'], check: (p) => p.evaluate(() => {
		const f = [], rail = document.getElementById('panel-rail');
		const leaves = [...rail.querySelectorAll('*')].filter((e) => !e.closest('#diamond-list, #session-list, #admin-body') && !e.children.length && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
		for (const e of leaves) {
			const s = e.textContent.trim();
			if (/^(week|month|this week|this month)$/i.test(s)) f.push(`a "${s}" tally (${e.className || e.tagName})`);
			if (/^ev$/i.test(s)) f.push(`an "ev" title (${e.className || e.tagName})`);
		}
		return f;
	}) },
	{ id: 'R6', name: 'rail.pools.rows-shape', cite: { id: 'D-20261020-14', quote: 'One row per pool: battery, name and balance (user currency, tag glyph) left; dial (15-min rate) and one-line time left right' },
	  vp: ALL, states: ['full'], check: (p) => p.evaluate(() => {
		const f = [], R = (e) => e.getBoundingClientRect();
		const rows = [...document.querySelectorAll('#spend-row .evp')];
		if (rows.length !== 3) return [`${rows.length} pool rows, want 3`];
		const dials = [], days = [];
		for (const r of rows) {
			const k = r.dataset.pool, rb = R(r);
			const el = { battery: r.querySelector('svg.evb'), name: r.querySelector('.evnm'), balance: r.querySelector('.evbal'),
				dial: r.querySelector('svg.evd'), range: r.querySelector('.evmi'), today: r.querySelector('.evday') };
			// The picked shots draw each of these: each is present, drawn and whole on screen.
			let whole = true;
			for (const [n, e] of Object.entries(el)) {
				if (!e) { f.push(`${k}: ${n} absent`); whole = false; continue; }
				const q = R(e);
				if (!(q.width > 0 && q.height > 0) || q.top < -1 || q.bottom > innerHeight + 1 || q.left < -1 || q.right > innerWidth + 1) { f.push(`${k}: ${n} not whole on screen (${Math.round(q.top)}-${Math.round(q.bottom)} of ${innerHeight})`); whole = false; }
				if (q.top < rb.top - 1 || q.bottom > rb.bottom + 1) { f.push(`${k}: ${n} outside its row (${Math.round(q.top)}-${Math.round(q.bottom)} vs ${Math.round(rb.top)}-${Math.round(rb.bottom)})`); whole = false; }
			}
			if (!whole) continue;
			const b = R(el.battery), nm = R(el.name), bal = R(el.balance), d = R(el.dial), mi = R(el.range), td = R(el.today);
			if (b.right > Math.min(nm.left, bal.left) + 1) f.push(`${k}: battery right ${Math.round(b.right)} past name/balance left ${Math.round(Math.min(nm.left, bal.left))}`);
			if (Math.max(nm.right, bal.right) > d.left + 1) f.push(`${k}: name/balance right ${Math.round(Math.max(nm.right, bal.right))} past the dial ${Math.round(d.left)}`);
			if (d.right > td.left + 1) f.push(`${k}: dial right ${Math.round(d.right)} past Today ${Math.round(td.left)}`);
			const lh = parseFloat(getComputedStyle(el.range).lineHeight) || 16;
			if (mi.height > lh * 1.5) f.push(`${k}: time left wraps (${Math.round(mi.height)} px, line ${lh} px)`);
			dials.push(d.left); days.push(td.right);
		}
		const spread = (a) => a.length ? Math.max(...a) - Math.min(...a) : 0;
		if (spread(dials) > 2) f.push(`dials not aligned: left edges ${dials.map(Math.round).join(', ')}`);
		if (spread(days) > 2) f.push(`Today cells not aligned: right edges ${days.map(Math.round).join(', ')}`);
		return f;
	}) },
	{ id: 'R7', name: 'rail.dial.thirds', cite: { id: 'D-20261022-07', quote: 'dial face in thirds: lower uncoloured, middle orange, upper red' },
	  vp: ALL, states: ['full'], check: (p) => p.evaluate(() => {
		const f = [], el = document.getElementById('spend-row');
		const ink = (v) => { const s = document.createElement('span'); s.style.color = 'var(' + v + ')'; el.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
		const warn = ink('--warn'), danger = ink('--danger');
		const dials = [...el.querySelectorAll('svg.evd')];
		if (!dials.length) return ['no dial drawn'];
		dials.forEach((d, i) => {
			const band = (k) => { const x = d.querySelector('.band.' + k); return x ? getComputedStyle(x).stroke : null; };
			const n = d.querySelectorAll('.band').length, b1 = band('b1'), b2 = band('b2'), b3 = band('b3');
			if (n !== 3) f.push(`dial ${i + 1}: ${n} bands, want 3`);
			if (b1 === warn || b1 === danger) f.push(`dial ${i + 1}: lower third coloured (${b1})`);
			if (b2 !== warn) f.push(`dial ${i + 1}: middle third ${b2}, want --warn ${warn}`);
			if (b3 !== danger) f.push(`dial ${i + 1}: upper third ${b3}, want --danger ${danger}`);
		});
		return f;
	}) },
	{ id: 'R8', name: 'rail.desk.lists-as-before', cite: { id: 'D-20261023-05', quote: Q_0523 },
	  vp: DESK, states: ['full'], check: (p) => p.evaluate(() => {
		const f = [], ls = ['#diamond-list', '#session-list'].map((sel) => [sel, document.querySelector(sel)]);
		if (ls.some(([, l]) => !l)) return ls.filter(([, l]) => !l).map(([sel]) => `${sel} absent`);
		// The split's own floor (72 px each), or half the room when the room is short of two.
		const room = ls.reduce((a, [, l]) => a + l.clientHeight, 0), floor = Math.min(72, Math.floor(room / 2) - 1);
		for (const [sel, l] of ls) {
			const mh = getComputedStyle(l).minHeight;
			if (!(l.scrollHeight > l.clientHeight + 1)) f.push(`${sel} is not its own scroller with 40 rows (${l.scrollHeight}/${l.clientHeight})`);
			if (l.clientHeight < floor) f.push(`${sel} ${l.clientHeight} px of the lists' ${room} px, under ${floor} px (crushed by the other list)`);
			if (mh !== '0px' && mh !== 'auto') f.push(`${sel} has a floor: min-height ${mh}`);
		}
		return f;
	}) },
	{ id: 'R9', name: 'rail.no-nested-scroll', cite: { id: 'D-20261023-05', quote: Q_0523 },
	  vp: DESK, states: ['full'], check: async (p) => {
		const f = await p.evaluate(async () => {
			const f = [], rail = document.getElementById('panel-rail');
			const sc = (e) => { const o = getComputedStyle(e); return o.display !== 'contents' && /auto|scroll/.test(o.overflowY) && e.scrollHeight > e.clientHeight + 1; };
			const nested = () => [...rail.querySelectorAll('*')].filter(sc).forEach((s) => {
				for (let a = s.parentElement; a; a = a.parentElement) {
					if (sc(a)) { f.push(`${s.id || s.className.split(' ')[0]} scrolls inside ${a.id || a.className.split(' ')[0]}`); break; }
					if (a === rail) break;
				}
			});
			nested();
			try { DaimondAdmin.settings(); } catch (e) { return [...f, 'DaimondAdmin.settings() threw: ' + e.message]; }
			await new Promise((r) => setTimeout(r, 900));
			nested();
			const as = document.getElementById('admin-scroll'), add = document.getElementById('models-add');
			if (!as || !add || !add.getClientRects().length) return [...f, '#models-add not drawn with Models open'];
			as.scrollTop = as.scrollHeight;
			await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
			const q = add.getBoundingClientRect(), rr = rail.getBoundingClientRect(), ab = as.getBoundingClientRect();
			for (const [n, c] of [['viewport', { top: 0, bottom: innerHeight }], ['rail', rr], ['#admin-scroll', ab]])
				if (q.top < c.top - 1 || q.bottom > c.bottom + 1) f.push(`#models-add ${Math.round(q.top)}-${Math.round(q.bottom)} outside ${n} ${Math.round(c.top)}-${Math.round(c.bottom)}, #admin-scroll at its end`);
			try { DaimondAdmin.close(); } catch (e) { /* closed by the next state */ }
			await new Promise((r) => setTimeout(r, 400));
			return [...new Set(f)];
		});
		return f;
	} },
	{ id: 'R10', name: 'rail.pool.name-exact', cite: { id: 'D-20261020-14', quote: 'One row per pool: battery, name and balance' },
	  vp: ALL, states: ['full'], check: (p) => p.evaluate((want) => {
		const f = [], nm = [...document.querySelectorAll('#spend-row .evp .evnm')];
		const got = nm.map((e) => e.textContent);
		if (JSON.stringify(got) !== JSON.stringify(want)) f.push(`pool names ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
		nm.forEach((e) => { if (e.scrollWidth > e.clientWidth + 1) f.push(`"${e.textContent}" cut: ${e.scrollWidth} px in ${e.clientWidth} px`); });
		return f;
	}, POOLS) },
	{ id: 'R11', name: 'rail.desk.three-tiles', cite: { id: 'D-20261024-04', quote: 'Own row, relax 1280' },
	  also: { id: 'D-20261020-12', quote: 'i can only see one or two diamond tiles or chat tiles at once' },
	  vp: ['1440x900', '1280x720', '393x793'], states: ['full', 'real'], check: (p, c) => p.evaluate(({ phone, real, vp }) => {
		const f = [];
		if (real) {
			// The world is his only if the rail's top lines are: no needs row, no "This device only".
			const nd = document.getElementById('astat-needs');
			if (nd && !nd.hidden && nd.textContent.trim()) f.push(`setup: a needs row is drawn ("${nd.textContent.trim()}"), his setup has none`);
			const sm = document.getElementById('astat-summary');
			if (sm && /This device only/.test(sm.textContent)) f.push('setup: the calm line reads "This device only", his has a gateway');
		}
		for (const [sel, row] of [['#diamond-list', '.diamond-box'], ['#session-list', '.session-box']]) {
			const l = document.querySelector(sel);
			if (!l) { f.push(`${sel} absent`); continue; }
			l.scrollTop = 0;
			const q = l.getBoundingClientRect();
			const whole = [...l.querySelectorAll(row)].filter((x) => { const r = x.getBoundingClientRect(); return r.height > 0 && r.top >= q.top - 1 && r.bottom <= q.bottom + 1; });
			if (phone) continue;
			// The floor: the owner's 24 Oct ruling at 1280x720 (1 Diamond, 1 chat; D-20261024-04 "Own row,
			// relax 1280", the chips on their own row; was 2 + 1, D-20261023-05). 1440x900 has at least the
			// floor he accepted at 1280 (lead's ruling, derived from that line); its figures print as notes.
			const floor = 1;
			const say = `${sel}: ${whole.length} whole tiles in its ${Math.round(q.height)} px window, want >= ${floor}`;
			if (!real) f.push('NOTE: ' + say + ' (full: report-only)');
			else if (whole.length < floor) f.push(say);
			else f.push('NOTE: ' + say);
		}
		const tagged = [...document.querySelectorAll('#diamond-list .diamond-box')].filter((b) => b.querySelector('.session-box-tags .tag-chip'));
		if (!tagged.length) f.push('no tagged Diamond drawn');
		tagged.slice(0, 5).forEach((b) => {
			const h = b.querySelector('.session-box-header'), t = b.querySelector('.session-box-tags');
			const n = b.querySelector('.session-box-name');
			// CHIPLINE (D-20261024-04, re-affirming D-20260929-03): the chips start on their own
			// line, below the name, as a row of the tile and not of its header, on every size.
			if (h.contains(t)) f.push(`"${n.textContent.trim()}": its tags are on its name's line, not a row of their own`);
			const a = n.getBoundingClientRect(), z = t.getBoundingClientRect();
			if (z.top < a.bottom - 0.5) f.push(`"${n.textContent.trim()}": tag row top ${z.top.toFixed(1)} above the name's bottom ${a.bottom.toFixed(1)}`);
			if (n.scrollWidth > n.clientWidth + 1) f.push(`"${n.textContent.trim()}" cut by its tags: ${n.scrollWidth} px in ${n.clientWidth} px`);
		});
		return f;
	}, { phone: !!c.phone, real: c.state === 'real', vp: c.vp }) },
	{ id: 'R12', name: 'rail.phone.tagged-one-line', cite: { id: 'feedback_specify_structure_not_flow', quote: 'give every text slot an overflow policy' },
	  also: [{ id: 'D-20261020-12', quote: 'i can only see one or two diamond tiles or chat tiles at once' },
		{ id: 'D-20261024-13', quote: 'picked "Heading one scroll away (Recommended)"' }],
	  vp: ['393x793', '390x845'], states: ['full', 'real'], check: (p, c) => p.evaluate(({ full, real }) => {
		const f = [], R = (e) => e.getBoundingClientRect(), shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
		const dl = document.getElementById('diamond-list'), sl = document.getElementById('session-list');
		if (!dl || !sl) return ['#diamond-list or #session-list absent'];
		dl.scrollTop = 0; sl.scrollTop = 0;
		// A text's own width, set alone in the element's font (a cut element's scrollWidth is not
		// reliable across engines with an ellipsis).
		const natural = (e) => {
			const s = document.createElement('span'), cs = getComputedStyle(e);
			s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
			s.textContent = e.textContent; document.body.appendChild(s);
			const w = s.getBoundingClientRect().width; s.remove(); return w;
		};
		const tiles = [...dl.querySelectorAll('.diamond-box')].filter((b) => b.querySelector('.session-box-tags .tag-chip') && R(b).height > 0).slice(0, 12);
		if (!tiles.length) return ['no tagged Diamond drawn'];
		for (const b of tiles) {
			const n = b.querySelector('.session-box-name'), nm = n.textContent.trim(), strip = b.querySelector('.session-box-tags');
			const cog = b.querySelector('.tile-cog'), g = cog ? R(cog) : null, s = R(strip);
			const chips = [...strip.querySelectorAll('.tag-chip')].filter(shown);
			// 1. Only whole chips: none past the gear, none cut by the strip, none ellipsised.
			for (const ch of chips) {
				const q = R(ch), w = ch.textContent.trim();
				if (g && q.right > g.left + 0.5) f.push(`"${nm}": chip "${w}" right ${Math.round(q.right)} passes the gear's left ${Math.round(g.left)}`);
				if (q.right > s.right + 0.5 || q.left < s.left - 0.5) f.push(`"${nm}": chip "${w}" cut by its strip (${Math.round(q.left)}-${Math.round(q.right)} in ${Math.round(s.left)}-${Math.round(s.right)})`);
				if (ch.scrollWidth > ch.clientWidth + 1) f.push(`"${nm}": chip "${w}" clipped: ${ch.scrollWidth} px in ${ch.clientWidth} px`);
			}
			// 2. One chip line (CHIPLINE, D-20261024-04): the chips share one line, and the tile grows
			// by that line and no more -- the same tile measured with its tags taken out.
			const tops = chips.map((ch) => R(ch).top);
			if (tops.length && Math.max(...tops) - Math.min(...tops) > 1) f.push(`"${nm}": chips on more than one line (tops ${Math.round(Math.min(...tops))}-${Math.round(Math.max(...tops))})`);
			const line = chips.length ? Math.max(...chips.map((ch) => R(ch).height)) : 0;
			const mt = parseFloat(getComputedStyle(strip).marginTop) || 0;
			const h1 = R(b).height;
			strip.style.display = 'none'; const h0 = R(b).height; strip.style.display = '';
			if (h1 - h0 > line + mt + 2) f.push(`"${nm}": tagged tile ${Math.round(h1)} px, untagged ${Math.round(h0)} px, want at most one chip line (${Math.round(line + mt)} px) more`);
			// 3. The name gives up nothing to its chips: cut only when it cannot fit on its own,
			// and then with no tag chip beside it (they fold first). Strict: a name 0.3 px short of
			// its text already draws its ellipsis ("Diamond project …", 41f73df30).
			const nw = natural(n), cw = n.getBoundingClientRect().width;
			if (nw > cw + 0.05) {
				const plain = chips.filter((ch) => !ch.classList.contains('tag-more'));
				const own = (g ? g.left : R(b).right) - R(n).left;
				if (nw <= own || plain.length) f.push(`"${nm}" cut by its tags: ${nw.toFixed(1)} px of name in ${cw.toFixed(1)} px, ${plain.length} chip(s) beside it`);
			}
		}
		// 4. At rest: the Chats heading above the pinned foot. Full: five whole Diamond tiles before it,
		// and the first chat may be one scroll away (D-20261024-04, 24 Oct 11:5x, "Chats heading is
		// enough"). Real had no whole-chat check before the ruling and its first chat is a scroll away.
		const sr = document.getElementById('spend-row');
		const hdTop = () => { const h = document.querySelector('#session-list') && [...document.querySelectorAll('.railhead')].find((h) => h.querySelector('[data-i18n="rail.chats"]')); return h ? Math.round(R(h).top) + '-' + Math.round(R(h).bottom) : 'absent'; };
		let foot = sr && shown(sr) ? Math.min(R(sr).top, innerHeight) : innerHeight;
		// The phone's status, pinned over the batteries out of the scroller (RAILSTATUS, D-20261024-13),
		// is the foot's top now: what lies under it is clipped by the scroller, not in view.
		const ad = document.getElementById('admin'), rs = document.getElementById('rail-scroll');
		if (ad && rs && !rs.contains(ad) && shown(ad)) foot = Math.min(foot, R(ad).top);
		f.push(`NOTE: foot ${Math.round(foot)}, Chats heading ${hdTop()}, Diamond tiles ${[...dl.querySelectorAll('.diamond-box')].slice(0, 6).map((x) => { const r = R(x); return Math.round(r.top) + '+' + Math.round(r.height); }).join(' ')}`);
		const head = sl.parentElement && [...sl.parentElement.querySelectorAll('.railhead')].find((h) => h.querySelector('[data-i18n="rail.chats"]'));
		const hd = head || document.querySelector('[data-i18n="rail.chats"]');
		// With the status row pinned (D-20261024-13, his pick "Heading one scroll away"): five whole
		// Diamond tiles always, full and real; on a shorter phone the Chats heading may sit one scroll
		// away under the pinned row -- its top within one scroller-height of the foot.
		const pinned = !!(ad && rs && !rs.contains(ad) && shown(ad));
		const reach = pinned ? foot + rs.clientHeight : foot;
		if (!hd || R(hd).top < 0 || (pinned ? R(hd).top > reach + 1 : R(hd).bottom > foot + 1))
			f.push(`the Chats heading is not ${pinned ? 'within one scroll of' : 'in view above'} the pinned foot (${hd ? Math.round(R(hd).top) + '-' + Math.round(R(hd).bottom) : 'absent'}, foot at ${Math.round(foot)}${pinned ? ', one scroll to ' + Math.round(reach) : ''})`);
		if (full || pinned) {
			const d = R(dl);
			const five = [...dl.querySelectorAll('.diamond-box')].filter((x) => { const r = R(x); return r.height > 0 && r.top >= Math.max(d.top, 0) - 1 && r.bottom <= Math.min(d.bottom, foot) + 1; });
			if (five.length < 5) f.push(`${five.length} whole Diamond tiles above the Chats heading, want >= 5 (list ${Math.round(d.top)}-${Math.round(d.bottom)})`);
		}
		if (!real && !full) f.push('R12 ran on a state it does not cover');
		return f;
	}, { full: c.state === 'full', real: c.state === 'real' }) },
	{ id: 'R13', name: 'rail.tags.more-opens', cite: { id: 'D-20261024-04', quote: 'own line' },
	  also: { id: 'D-20260929-03', quote: 'the chip list in diamond tiles should start on its own line' },
	  vp: ALL, states: ['full', 'real'], check: async (p, c) => {
		// 1. Every tagged tile: one row of whole chips under the name, not a scroller, and the tile
		// grows by that row and no more.
		const f = await p.evaluate(() => {
			const f = [], R = (e) => e.getBoundingClientRect(), shown = (e) => e.getClientRects().length > 0;
			const dl = document.getElementById('diamond-list');
			if (!dl) return ['#diamond-list absent'];
			dl.scrollTop = 0;
			const tiles = [...dl.querySelectorAll('.diamond-box')].filter((b) => b.querySelector('.session-box-tags .tag-chip') && R(b).height > 0).slice(0, 8);
			if (!tiles.length) return ['no tagged Diamond drawn'];
			for (const b of tiles) {
				const nm = b.querySelector('.session-box-name').textContent.trim(), st = b.querySelector('.session-box-tags');
				const chips = [...st.querySelectorAll('.tag-chip')].filter(shown), s = R(st);
				const nl = R(b.querySelector('.session-box-name')).left;
				if (Math.abs(s.left - nl) > 1) f.push(`"${nm}": chip row starts at ${s.left.toFixed(1)}, its name at ${nl.toFixed(1)} (want the same x)`);
				if (st.scrollWidth > st.clientWidth + 1) f.push(`"${nm}": the chip row scrolls (${st.scrollWidth} px in ${st.clientWidth} px)`);
				const tops = chips.map((ch) => R(ch).top);
				if (Math.max(...tops) - Math.min(...tops) > 1) f.push(`"${nm}": chips on more than one line`);
				for (const ch of chips) {
					const q = R(ch);
					if (q.right > s.right + 0.5 || q.left < s.left - 0.5) f.push(`"${nm}": chip "${ch.textContent.trim()}" cut by its row (${Math.round(q.left)}-${Math.round(q.right)} in ${Math.round(s.left)}-${Math.round(s.right)})`);
				}
				const line = Math.max(...chips.map((ch) => R(ch).height)) + (parseFloat(getComputedStyle(st).marginTop) || 0);
				const h1 = R(b).height; st.style.display = 'none'; const h0 = R(b).height; st.style.display = '';
				if (h1 - h0 > line + 2) f.push(`"${nm}": tagged tile ${Math.round(h1)} px, untagged ${Math.round(h0)} px, more than one chip row (${Math.round(line)} px)`);
			}
			return f;
		});
		// 2. The heavily filed Diamond folds into "+N", a button that opens every one of its tags as
		// a filter chip; Escape closes it and gives the keyboard back to "+N".
		const sel = '#diamond-list .diamond-box .session-box-tags > .tag-more:not([hidden])';
		const st0 = await p.evaluate((sel) => {
			const m = document.querySelector(sel);
			if (!m) return null;
			const b = m.closest('.diamond-box');
			return { tag: m.tagName, exp: m.getAttribute('aria-expanded'), pop: m.getAttribute('aria-haspopup'), label: m.getAttribute('aria-label') || '',
				name: b.querySelector('.session-box-name').textContent.trim(), n: b.querySelectorAll('.session-box-tags > .tag-chip:not(.tag-more)').length };
		}, sel);
		if (!st0) { f.push('no "+N" drawn on the heavily filed Diamond (8 tags)'); return f; }
		if (st0.tag !== 'BUTTON' || st0.exp !== 'false' || !st0.pop || !st0.label) f.push(`"+N" on "${st0.name}" is not a closed popup button (${st0.tag}, aria-expanded=${st0.exp}, aria-haspopup=${st0.pop}, label "${st0.label}")`);
		await p.click(sel);
		const st1 = await p.evaluate((sel) => {
			const m = document.querySelector(sel), pop = document.querySelector('.tag-more-pop');
			if (!pop) return null;
			const r = pop.getBoundingClientRect();
			return { exp: m && m.getAttribute('aria-expanded'), chips: [...pop.querySelectorAll('button.tag-chip')].map((x) => x.textContent.trim()),
				inView: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, focus: pop.contains(document.activeElement) };
		}, sel);
		if (!st1) { f.push(`pressing "+N" on "${st0.name}" opened no list of its tags`); return f; }
		if (st1.chips.length !== st0.n) f.push(`"+N" list holds ${st1.chips.length} filter chips, the tile has ${st0.n} tags`);
		if (st1.exp !== 'true') f.push(`"+N" open but aria-expanded=${st1.exp}`);
		if (!st1.inView) f.push('the "+N" list is not whole on screen');
		if (!st1.focus) f.push('the "+N" list took no keyboard focus');
		await p.keyboard.press('Escape');
		const st2 = await p.evaluate((sel) => {
			const m = document.querySelector(sel);
			return { open: !!document.querySelector('.tag-more-pop'), exp: m && m.getAttribute('aria-expanded'), back: document.activeElement === m };
		}, sel);
		if (st2.open) f.push('Escape left the "+N" list open');
		if (st2.exp !== 'false') f.push(`after Escape aria-expanded=${st2.exp}`);
		if (!st2.back) f.push('after Escape the keyboard is not back on "+N"');
		return f;
	} },
];

// ── The loader: this file's R-list, then every dev/owner_eye/*.mjs module ──
// A module's default export is a list of records of REG's shape (id, name, cite {id, quote},
// also?, vp, states, check(page, cell)); its optional `seed(page, cell, state)` runs on each
// world after the rail's own seeding, before any check. A module that exports
// `world(cell, state, ctx)` runs its records in that world instead (built from the same
// helpers, `CTX` below). An id taken twice is a lint fault.
const SEEDS = [], MODS = {};
{
	const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'owner_eye');
	const mods = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort() : [];
	for (const f of mods) {
		let m;
		try { m = await import(path.join(dir, f)); } catch (e) { console.error(`LOAD owner_eye/${f}: ${e.message.split('\n')[0]}`); process.exit(2); }
		if (!Array.isArray(m.default)) { console.error(`LOAD owner_eye/${f}: no default export list of records`); process.exit(2); }
		const key = typeof m.world === 'function' ? path.basename(f, '.mjs') : null;
		if (key) MODS[key] = m;
		for (const r of m.default) REG.push({ ...r, from: f, ...(key ? { world: key } : {}) });
		if (!key && typeof m.seed === 'function') SEEDS.push(m.seed);
	}
	const seen = new Set();
	for (const r of REG) {
		if (seen.has(r.id)) { console.error(`LOAD ${r.id}${r.from ? ' (owner_eye/' + r.from + ')' : ''}: id taken twice`); process.exit(2); }
		seen.add(r.id);
		if (!r.cite || !r.cite.id || !r.cite.quote || !Array.isArray(r.vp) || !Array.isArray(r.states) || typeof r.check !== 'function') {
			console.error(`LOAD ${r.id}: a record needs cite {id, quote}, vp [], states [] and check()`); process.exit(2);
		}
	}
}

// ── The cite lint ────────────────────────────────────────────────────
{
	let lines;
	try { lines = fs.readFileSync(RULINGS, 'utf8').split('\n'); } catch (e) { console.error('rulings not readable: ' + RULINGS); process.exit(2); }
	let bad = 0;
	for (const r of REG) for (const c of [r.cite, ...[].concat(r.also || [])]) {	// `also`: one cite or a list
		const at = lines.findIndex((l) => l.includes(c.id) && l.includes(c.quote));
		if (at < 0) { console.error(`LINT ${r.id}: quote not found on a line carrying ${c.id}: "${c.quote}"`); bad++; continue; }
		const sup = lines.filter((l) => /supersedes "([^"]+)"/.test(l)).map((l) => l.match(/supersedes "([^"]+)"/)[1]);
		if (sup.some((s) => c.quote.includes(s) || s.includes(c.quote))) { console.error(`LINT ${r.id}: cites a superseded fragment: "${c.quote}"`); bad++; }
	}
	if (bad) process.exit(2);
}

if (LIST) { for (const r of REG) console.log(`${r.id}\t${r.name}\t${r.cite.id}\t${r.from || 'verify_ownereye.mjs'}`); process.exit(0); }
const want = REG.filter((r) => (!CITE || r.cite.id === CITE || [].concat(r.also || []).some((a) => a.id === CITE)) && (!ONLY.length || ONLY.includes(r.id)));
// A --vp outside ALL is admitted (a module's record may name it; RAILSTATUS's 390x845).
const CELLS = (VPS.length ? VPS : ALL).map((vp) => {
	const [w, h] = vp.split('x').map(Number);
	return { vp, w, h, phone: w < 600 };
});

// ── Serving another tree (the red run on BASE) ───────────────────────
const MIME = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
	'.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
async function serve(page) {
	if (!OTHER) return;
	await page.route(APP + '/**', (r) => {
		const u = new URL(r.request().url());
		if (u.pathname.startsWith('/api/')) return r.fallback();
		const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname.slice(1));
		const file = path.join(OTHER, rel);
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return r.fallback();
		return r.fulfill({ status: 200, body: fs.readFileSync(file), contentType: MIME[path.extname(file)] || 'application/octet-stream' });
	});
}

// ── Determinism (ported from rig/geom dev/rig/screens.mjs) ───────────
const SEEDED_RANDOM = (seed) => {
	let a = seed >>> 0;
	Math.random = () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};
const settle = async (p) => {
	await p.evaluate(() => document.fonts && document.fonts.ready);
	let last = '';
	for (let i = 0; i < 10; i++) {
		const now = await p.evaluate(() => { const r = document.getElementById('panel-rail'); return r ? r.innerHTML.length + ':' + [...r.querySelectorAll('#spend-row .evp, #diamond-list, #session-list')].map((e) => Math.round(e.getBoundingClientRect().top)).join(',') : ''; });
		if (now === last) return;
		last = now;
		await p.waitForTimeout(250);
	}
};

// ── A world: one session per (cell, state) ───────────────────────────
async function world(cell, state, t) {
	const n = state === 'thin' ? 4 : 40, nc = state === 'real' ? 20 : n;
	const s = await open({ name: `oe${cell.w}${state[0]}`, profile: fresh(`oe${cell.w}${state[0]}`), connect: false, viewport: { width: cell.w, height: cell.h },
		timezoneId: OE_ZONE, clock: t.at, ...(OTHER ? { serviceWorkers: 'block' } : {}),
		...(cell.phone ? { browser: 'webkit', touch: true, ua: IPHONE } : { browser: 'chromium' }), route: async (pg) => { await clockAt(t)(pg); await serve(pg); } });
	const p = s.page;
	await p.addInitScript(SEEDED_RANDOM, 20261023);
	await p.emulateMedia({ reducedMotion: 'reduce' });
	await p.waitForFunction(() => !!window.DaimondCore, null, { timeout: 30000 });
	await p.evaluate(async ({ n, nc, real }) => {
		if (real) {
			// A model set, as his is: the default on a keyed OpenRouter.
			localStorage.setItem('daimond-models-v2', JSON.stringify({ v: 2, def: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }, defAt: Date.now(), providers: {
				openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', key: 'sk-or-v1-fixture', keyEnc: '', models: [], fetched: 0 } } }));   // allowlist secret
		}
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		for (let i = 0; i < n; i++) { try { await app.create_diamond('Diamond project ' + (i + 1)); } catch (e) { /* counted below */ } }
		// Tagged, as his are: the tag filter row is drawn above the Diamonds and takes its room.
		const tags = ['work', 'writing', 'person', 'health', 'money', 'home'];
		if (n > 4) try {
			const ls = JSON.parse(await app.list_diamonds());
			for (let i = 0; i < ls.length; i++) await app.set_tags(ls[i].id, JSON.stringify([tags[i % 6], tags[(i + 2) % 6]]));
			// One heavily filed Diamond, the newest (top of the rail), so the chip row folds into
			// "+N" at every width (R13, CHIPLINE D-20261024-04).
			const top = ls.find((d) => d.name === 'Diamond project ' + n);
			if (top) await app.set_tags(top.id, JSON.stringify([...tags, 'reading-list', 'side-projects']));
		} catch (e) { /* no OPFS */ }
		await new Promise((res) => {
			const now = Date.now(), rows = [];
			for (let i = 0; i < nc; i++) rows.push({ id: 'oe' + i, name: 'Seeded chat ' + (i + 1),
				createdAt: now - i * 36e5, updatedAt: now - i * 36e5, messages: [], msgCount: 2, model: 'mock/fast' });
			const r = indexedDB.open('daimond-chats');
			r.onsuccess = () => {
				let t;
				try { t = r.result.transaction('chats', 'readwrite'); } catch (e) { res(); return; }
				rows.forEach((x) => t.objectStore('chats').put(x));
				t.oncomplete = () => { try { localStorage.setItem('daimond-chats-count', String(rows.length)); } catch (e) {} res(); };
				t.onerror = () => res();
			};
			r.onerror = () => res();
		});
	}, { n, nc, real: state === 'real' });
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, s.name);
	const lists = await p.waitForFunction(([n, nc]) => document.querySelectorAll('#session-list .session-box').length >= nc
		&& document.querySelectorAll('#diamond-list .diamond-box').length >= n, [n, nc], { timeout: 30000 }).then(() => true, () => false);
	if (!lists) s.setup = `lists not seeded: ${await p.evaluate(() => document.querySelectorAll('#diamond-list .diamond-box').length + ' Diamonds, ' + document.querySelectorAll('#session-list .session-box').length + ' chats')}`;
	if (state !== 'thin') {
		// The three pools of the approved shots (ownereye_pools.mjs).
		await standInPools(p);
	}
	if (state === 'real') {
		// His gateway syncs: the calm line reads "Synced", not "This device only".
		await p.evaluate(() => {
			if (window.DaimondSync) DaimondSync.chip = () => 'synced';
			try { DaimondAdmin.summary(); } catch (e) { /* the check says */ }
			try { DaimondNeeds.refresh(); } catch (e) { /* the check says */ }
		});
	}
	for (const f of SEEDS) await f(p, cell, state);
	if (cell.phone) await p.evaluate(() => window.DaimondShell && DaimondShell.openDrawer());
	await p.waitForTimeout(800);
	await settle(p);
	return s;
}

// ── Run ──────────────────────────────────────────────────────────────
let ran = 0;
const red = [];
const t0 = Date.now();
// A module's world opens through the pin too, whatever it asks for, in a fresh profile.
const pinned = (o) => open({ ...o, timezoneId: OE_ZONE, clock: OE_AT[0].at, profile: o.profile || fresh(o.name),
	route: async (pg) => { await clockAt(OE_AT[0])(pg); if (o.route) await o.route(pg); } });
const CTX = { open: pinned, signInAs, serve, settle, SEEDED_RANDOM, IPHONE, OTHER };
for (const t of OE_AT) for (const wk of ['rail', ...Object.keys(MODS)]) for (const cell of CELLS) for (const state of ['thin', 'full', 'real']) {
	if (t !== OE_AT[0] && (wk !== 'rail' || state === 'thin')) continue;
	const todo = want.filter((r) => (r.world || 'rail') === wk && r.vp.includes(cell.vp) && r.states.includes(state));
	if (!todo.length) continue;
	const when = t === OE_AT[0] ? '' : ' @' + t.at.slice(11, 19);
	let s;
	try { s = wk === 'rail' ? await world(cell, state, t) : await MODS[wk].world(cell, state, CTX); }
	catch (e) { console.log(`  FAIL setup ${wk} ${cell.vp} ${state}${when}: ${e.message.split('\n')[0]}`); red.push('setup'); continue; }
	if (s.setup) { console.log(`  FAIL setup ${cell.vp} ${state}${when}: ${s.setup}`); red.push('setup'); }
	const at = await s.page.evaluate((z) => new Date().toLocaleString('sv-SE', { timeZone: z }), OE_ZONE).catch((e) => 'unread: ' + e.message.split('\n')[0]);
	if (!at.startsWith(t.at.slice(0, 10))) { console.log(`  FAIL setup clock ${wk} ${cell.vp} ${state}${when}: the page reads ${at} in ${OE_ZONE}, not the pinned ${t.at}`); red.push('setup'); }
	for (const theme of ['obsidian', 'porcelain']) {
		await s.page.evaluate((t) => DaimondTheme.set(t), theme);
		await s.page.waitForTimeout(400);
		await settle(s.page);
		if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await s.page.screenshot({ path: path.join(SHOTS, `oe_${wk}_${state}${when.replace(/\W/g, "")}_${theme}_${cell.phone ? 'phone' : cell.vp}.png`) }); }
		for (const r of todo) {
			let f;
			// shot(n): a frame of what the check has open, named by world, state, theme and cell.
			const shot = SHOTS ? (n) => s.page.screenshot({ path: path.join(SHOTS, `oe_${wk}_${state}${when.replace(/\W/g, "")}_${theme}_${cell.phone ? 'phone' : cell.vp}_${n}.png`) }) : null;
			try { f = await r.check(s.page, { ...cell, state, theme, shot }); } catch (e) { f = ['threw: ' + e.message.split('\n')[0]]; }
			ran++;
			const where = `${cell.vp} ${theme} ${state}${when}`;
			// A finding that begins "NOTE: " is a figure reported, not a fault.
			for (const x of f.filter((x) => x.startsWith('NOTE: '))) console.log(`  note ${r.id} ${r.name} [${where}] ${x.slice(6)}`);
			f = f.filter((x) => !x.startsWith('NOTE: '));
			if (f.length) { red.push(r.id); for (const x of f) console.log(`  FAIL ${r.id} ${r.name} [${where}] ${x}  (${r.cite.id})`); }
			else console.log(`  ok   ${r.id} ${r.name} [${where}]`);
		}
	}
	try { await s.close(); } catch (e) { /* gone */ }
}
const ids = [...new Set(red)];
console.log(`\nverify_ownereye: ${ran} checks, ${ids.length ? 'RED ' + ids.join(' ') : 'all green'} (${Math.round((Date.now() - t0) / 1000)} s${OTHER ? ', www ' + OTHER : ''})`);
process.exit(ran === 0 ? 3 : ids.length ? 1 : 0);
