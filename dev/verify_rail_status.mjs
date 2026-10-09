// gateway: none
// verify_rail_status.mjs -- D-20261008-14. The rail's status section is expandable on a
// desktop, and shut to one line until somebody opens it.
//
// Owner, 2026-10-08: "Lets recover the real estate taken by the always open status
// section of the rail, make it expandable in desktop view." Measured on build
// 000a44a01612 at 1440x900, the foot of the rail held, always:
//
//   identity row   avatar, name, cog                      36px
//   summary row    dot and one word ("This device only")  22px
//   spend row      Today / Week / Month                    46px
//   #admin         the three and their padding           119px  (299px with the detail open)
//
// and nothing on a desktop could fold it. The phone already could (mobile.js `bindFolds`,
// the `.rail-fold` chevron, `daimond-rail-fold` per device), but that fold's rules sat
// inside the phone breakpoint and the chevron was `display: none` above it.
//
// What this file asserts, one section at a time:
//
//   D1  the toggle is drawn on a desktop, at the trailing end of the identity row.
//   D2  the section is SHUT BY DEFAULT: identity row only, no summary, no spend.
//   D3  THE RAIL HEIGHT IS RECOVERED, and the figure is measured: `#admin` collapsed
//       against expanded, and the room the lists above it gain.
//   D4  it expands IN PLACE (the rail and its neighbours do not move, nothing floats) and
//       collapses again to where it was.
//   D5  the state is kept over a reload, both ways, and is a per-device key.
//   D6  with storage refusing to write, the fold still works (the in-memory mirror).
//   D7  the collapsed line carries a status ONLY when it passed the importance filter:
//       a warning (no model) shows a flag with the summary's own word; an ordinary state
//       shows nothing; expanded, the flag steps aside for the summary row.
//   D8  variable length: a long name and a long flag leave the cog and the toggle where
//       they were and overlap nothing.
//   D9  the phone still has its own fold and now one drawn by the same code: shut by
//       default, the toggle's tap area at least 44px.
//
//   bash dev/world.sh 76 --up   (or the runner the lane uses)
//   DAIMOND_APP=http://localhost:8853 node dev/verify_rail_status.mjs
import { open, signInAs, connectMock } from './harness.mjs';

let bad = 0, good = 0;
const check = (n, pass, d) => { pass ? good++ : bad++; console.log((pass ? '  ok   ' : '  FAIL ') + n + (d !== undefined && d !== '' ? ' -- ' + String(d).slice(0, 320) : '')); };

const TOGGLE = '#panel-rail .rail-fold[data-fold="status"]';

/// Everything this file asserts on, read in one pass so the numbers describe one layout.
const survey = (p) => p.evaluate((TOGGLE) => {
	const box = (sel) => {
		let e = null;
		try { e = document.querySelector(sel); } catch (x) { e = null; }
		if (!e) return { absent: true, drawn: false, h: 0, w: 0, top: 0, bottom: 0, left: 0, right: 0 };
		const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
		const drawn = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0 && !e.closest('[hidden]');
		return { absent: false, drawn, h: Math.round(r.height), w: Math.round(r.width), top: Math.round(r.top),
			bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
	};
	const t = document.querySelector(TOGGLE);
	const flag = document.getElementById('astat-flag');
	const sum = document.getElementById('astat-summary');
	return {
		rail: box('#panel-rail'), railTop: box('#rail-top'), admin: box('#admin'), status: box('#admin-status'),
		idRow: box('#admin-status .astat-id'), name: box('#user-info'), userRow: box('#user-row'), cog: box('#settings-btn'),
		toggle: box(TOGGLE), summary: box('#astat-summary'), spend: box('#spend-row'), flag: box('#astat-flag'),
		diamondList: box('#diamond-list'), sessionList: box('#session-list'),
		chat: box('#panel-ai'), guide: box('#panel-guide'),
		expanded: t ? t.getAttribute('aria-expanded') === 'true' : null,
		flagText: flag ? flag.textContent.trim() : null,
		summaryText: sum ? sum.textContent.trim() : null,
		stored: (() => { try { return JSON.parse(localStorage.getItem('daimond-rail-fold') || 'null'); } catch (e) { return 'unreadable'; } })(),
		idOverflow: (() => { const r = document.querySelector('#admin-status .astat-id'); return r ? r.scrollWidth - r.clientWidth : 0; })(),
	};
}, TOGGLE);

const settle = (p, ms = 350) => p.waitForTimeout(ms);

/// Put away whatever the sign-in left open over the rail, so a measurement is the rail's.
async function quiet(p) {
	for (let i = 0; i < 3; i++) { await p.keyboard.press('Escape').catch(() => {}); await p.waitForTimeout(60); }
	await p.evaluate(() => { const c = document.getElementById('admin-close'); if (c && c.offsetParent) c.click(); });
	await settle(p, 250);
}

async function press(p) {
	try {
		const loc = p.locator(TOGGLE).first();
		if (!(await loc.count())) return false;
		await loc.click({ force: true, timeout: 4000 });
		await settle(p);
		return true;
	} catch (e) { return false; }
}

const s = await open({ name: 'railstat', connect: false });
const p = s.page;
await p.setViewportSize({ width: 1440, height: 900 });
await p.waitForFunction(() => !!window.DaimondShell, null, { timeout: 30000 });
await p.evaluate(() => { try { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set('obsidian'); } catch (e) {} });
await settle(p, 900);
await quiet(p);

// ── D1, D2: a toggle on a desktop, and a section that starts shut ─────────
const A = await survey(p);
console.log('  measured, collapsed by default:', JSON.stringify({ admin: A.admin.h, idRow: A.idRow.h, summary: A.summary.drawn, spend: A.spend.drawn, toggle: A.toggle.drawn, expanded: A.expanded }));
check('D1 the status toggle is drawn on a desktop', A.toggle.drawn && A.toggle.w >= 30 && A.toggle.h >= 30, `drawn=${A.toggle.drawn} ${A.toggle.w}x${A.toggle.h}`);
check('D1 it is the last thing in the identity row, right of the cog', A.toggle.drawn && A.toggle.left >= A.cog.right - 1 && A.toggle.right <= A.idRow.right + 1,
	`cog.right=${A.cog.right} toggle=${A.toggle.left}..${A.toggle.right} row.right=${A.idRow.right}`);
check('D2 shut by default', A.expanded === false, `aria-expanded=${A.expanded}`);
check('D2 the summary row is not on screen', !A.summary.drawn, `h=${A.summary.h}`);
check('D2 the spend row is not on screen', !A.spend.drawn, `h=${A.spend.h}`);
check('D2 the identity row and the cog stay', A.idRow.drawn && A.cog.drawn && A.userRow.drawn, `id=${A.idRow.h} cog=${A.cog.drawn}`);
check('D2 the whole section is one compact line (<= 60px)', A.admin.drawn && A.admin.h <= 60, `#admin=${A.admin.h}px`);

// ── D7 (collapsed half): no model is a warning, so the line says so ───────
check('D7 no model: the collapsed line carries the status flag', A.flag.drawn, `flag.drawn=${A.flag.drawn} text="${A.flagText}"`);
check('D7 the flag says what the summary says', A.flag.drawn && !!A.flagText && A.flagText === A.summaryText, `flag="${A.flagText}" summary="${A.summaryText}"`);

// ── D3, D4: expand in place, measure what was recovered ─────────────────
const pressed = await press(p);
const B = await survey(p);
console.log('  measured, expanded:', JSON.stringify({ admin: B.admin.h, summary: B.summary.h, spend: B.spend.h, railTop: B.railTop.h }));
check('D4 the toggle can be pressed', pressed);
check('D4 expanded: aria-expanded is true', B.expanded === true, `aria-expanded=${B.expanded}`);
check('D4 expanded: the summary and the spend rows are on screen', B.summary.drawn && B.spend.drawn, `summary=${B.summary.h} spend=${B.spend.h}`);
const gained = B.admin.h - A.admin.h;
check('D3 RAIL HEIGHT RECOVERED: collapsed is at least 60px shorter than expanded', gained >= 60, `expanded #admin=${B.admin.h}px, collapsed=${A.admin.h}px, recovered=${gained}px`);
check('D3 the room goes to the rail\'s lists', gained > 0 && (A.railTop.h - B.railTop.h) >= gained - 2, `#rail-top collapsed=${A.railTop.h} expanded=${B.railTop.h}`);
const grew = pressed && B.expanded === true;
check('D4 in place: the rail does not move or resize', grew && A.rail.top === B.rail.top && A.rail.h === B.rail.h && A.rail.left === B.rail.left && A.rail.w === B.rail.w,
	`rail ${A.rail.left},${A.rail.top} ${A.rail.w}x${A.rail.h} -> ${B.rail.left},${B.rail.top} ${B.rail.w}x${B.rail.h}`);
check('D4 in place: its neighbours do not move', grew && A.chat.left === B.chat.left && A.chat.w === B.chat.w && A.guide.left === B.guide.left,
	`chat ${A.chat.left}/${A.chat.w} -> ${B.chat.left}/${B.chat.w}; guide ${A.guide.left} -> ${B.guide.left}`);
check('D4 in place: the section stays at the rail\'s foot and inside it', grew && B.admin.bottom === A.admin.bottom && B.admin.top >= B.rail.top && B.admin.bottom <= B.rail.bottom,
	`#admin bottom ${A.admin.bottom} -> ${B.admin.bottom}, rail ${B.rail.top}..${B.rail.bottom}`);
check('D4 in place: the toggle keeps its column', grew && A.toggle.drawn && A.toggle.left === B.toggle.left && A.cog.left === B.cog.left, `toggle ${A.toggle.left} -> ${B.toggle.left}, cog ${A.cog.left} -> ${B.cog.left}`);
check('D7 expanded: the flag steps aside for the summary row', grew && A.flag.drawn && !B.flag.drawn && B.summary.drawn, `flag.drawn=${B.flag.drawn}`);
check('D5 the open state is written under the per-device key', !!B.stored && B.stored !== 'unreadable' && B.stored.status === true, JSON.stringify(B.stored));

await press(p);
const C = await survey(p);
check('D4 collapses again, to the same line', C.expanded === false && Math.abs(C.admin.h - A.admin.h) <= 1 && !C.summary.drawn && !C.spend.drawn,
	`expanded=${C.expanded} #admin=${C.admin.h} (was ${A.admin.h})`);
check('D5 the shut state is written too', !!C.stored && C.stored !== 'unreadable' && C.stored.status === false, JSON.stringify(C.stored));

// ── D5: kept over a reload, both ways ──────────────────────────────────
await press(p);                                                    // open it
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, s.name);
await settle(p, 1400);
await quiet(p);
const R1 = await survey(p);
check('D5 opened, then reloaded: still open', R1.expanded === true && R1.summary.drawn && R1.spend.drawn, `expanded=${R1.expanded} summary=${R1.summary.drawn}`);
await press(p);                                                    // shut it
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, s.name);
await settle(p, 1400);
await quiet(p);
const R2 = await survey(p);
check('D5 shut, then reloaded: still shut', R2.expanded === false && !R2.summary.drawn && R2.admin.h <= 60, `expanded=${R2.expanded} #admin=${R2.admin.h}`);

// ── D6: storage refuses to write, the fold still works ─────────────────
await p.evaluate(() => { Storage.prototype.setItem = function () { throw new Error('quota'); }; });
await press(p);
const M1 = await survey(p);
await press(p);
const M2 = await survey(p);
check('D6 storage refusing: the toggle still opens the section', M1.expanded === true && M1.summary.drawn, `expanded=${M1.expanded}`);
check('D6 storage refusing: and shuts it again', M2.expanded === false && !M2.summary.drawn, `expanded=${M2.expanded}`);
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, s.name);
await settle(p, 1400);
await quiet(p);

// ── D7: an ordinary state is silent ────────────────────────────────────
await connectMock(s);
await settle(p, 900);
await quiet(p);
const Q = await survey(p);
check('D7 a model is connected and nothing is wrong: the collapsed line carries no flag', Q.expanded === false && !Q.flag.drawn, `flag.drawn=${Q.flag.drawn} text="${Q.flagText}" summary="${Q.summaryText}"`);
check('D7 and the section is still one compact line', Q.admin.h <= 60, `#admin=${Q.admin.h}`);

// ── D8: variable length. A long name, a long flag, and the line holds. ──
// The flag is only drawn on a warning, so the test makes one by emptying the models again.
const longName = 'Bartholomew Featherstonehaugh-Cholmondeley the Third of Wolverhampton and Elsewhere';
const flagWords = 'Synced, but not the files of any of your many devices, today';
await p.evaluate(({ longName, flagWords }) => {
	document.getElementById('user-info').textContent = longName;
	const f = document.getElementById('astat-flag');
	if (f) { f.hidden = false; f.style.display = ''; const v = f.querySelector('.astat-val, span:last-child'); (v || f).textContent = flagWords; }
}, { longName, flagWords });
await settle(p);
const V = await survey(p);
const baseline = Q;
console.log('  measured, long name and flag:', JSON.stringify({ cog: [baseline.cog.left, V.cog.left], toggle: [baseline.toggle.left, V.toggle.left], idRow: [baseline.idRow.h, V.idRow.h], overflow: V.idOverflow }));
check('D8 a long name leaves the cog where it was', V.cog.left === baseline.cog.left && V.cog.drawn, `cog ${baseline.cog.left} -> ${V.cog.left}`);
check('D8 and the toggle where it was', V.toggle.left === baseline.toggle.left && V.toggle.drawn, `toggle ${baseline.toggle.left} -> ${V.toggle.left}`);
check('D8 the row keeps its height', V.idRow.h === baseline.idRow.h && V.admin.h === baseline.admin.h, `idRow ${baseline.idRow.h} -> ${V.idRow.h}, #admin ${baseline.admin.h} -> ${V.admin.h}`);
check('D8 nothing wider than the row', V.idOverflow <= 0, `scroll overflow ${V.idOverflow}px`);
check('D8 the flag does not overlap the name', V.flag.drawn && V.flag.left >= V.userRow.right - 1, `flag.left=${V.flag.left} name.right=${V.userRow.right}`);
check('D8 the flag stays left of the cog', V.flag.drawn && V.flag.right <= V.cog.left + 1, `flag.right=${V.flag.right} cog.left=${V.cog.left}`);

// ── D9: the phone, the same toggle, shut by default, a thumb's target ───
await p.setViewportSize({ width: 390, height: 844 });
await settle(p, 700);
await p.evaluate(() => window.DaimondShell && DaimondShell.openDrawer && DaimondShell.openDrawer());
await settle(p, 600);
const F = await survey(p);
const hit = await p.evaluate((TOGGLE) => {
	const t = document.querySelector(TOGGLE);
	if (!t) return { ok: false, why: 'absent' };
	const r = t.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
	let n = 0, total = 0;
	for (const [dx, dy] of [[-20, 0], [20, 0], [0, -20], [0, 20], [0, 0]]) {
		total++;
		const e = document.elementFromPoint(cx + dx, cy + dy);
		if (e && (e === t || t.contains(e))) n++;
	}
	return { ok: n === total, n, total };
}, TOGGLE);
check('D9 phone: the toggle is drawn and the section is shut by default', F.toggle.drawn && F.expanded === false && !F.summary.drawn && !F.spend.drawn, `toggle=${F.toggle.drawn} expanded=${F.expanded}`);
check('D9 phone: the toggle\'s tap area is at least 44px each way', hit.ok, JSON.stringify(hit));
check('D9 phone: nothing in the identity row overlaps or overflows at 390', F.idOverflow <= 0 && F.cog.right <= F.toggle.left + 1 + 8, `overflow=${F.idOverflow} cog.right=${F.cog.right} toggle.left=${F.toggle.left}`);
await press(p);
const G = await survey(p);
check('D9 phone: it opens, and the summary and spend rows come back', G.expanded === true && G.summary.drawn, `expanded=${G.expanded} summary=${G.summary.h}`);

const errs = (s.errs || []).filter((e) => !/401|Failed to load resource|favicon/i.test(String(e)));
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`\n${good} ok, ${bad} failed`);
await s.close().catch(() => {});
process.exit(bad ? 1 : 0);
