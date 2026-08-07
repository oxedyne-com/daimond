// verify_nogutter.mjs — no zone reserves room for nothing.
//
// The fifth property search, after reversible, escapable, focus and errnames.
// The property is one sentence: A ZONE WITH WIDTH HAS SOMETHING IN IT. If the
// dock is 300px wide, at least one panel must actually be rendering inside it;
// the same for the stage. A zone that holds width for a panel nobody can see is
// a dead gutter — a strip of nothing beside the chat, taking space from the
// work.
//
// It is a property rather than a case because of how the real one arose. Panels
// can be held back until they have earned their place (`WAITS_FOR`): the Agents
// panel stays behind `body.agents-hidden`, Message and Compose wait for a
// mailbox. The chip row's own path knew to let a panel out before opening it —
// but `show()`, which is what the API, the mobile nav, the guide button and a
// saved layout all call, did not. So a panel the stylesheet suppresses could be
// SEATED: `display:none !important` beat the engine's `display:''`, the dock
// reserved its column, and nothing appeared in it. Worse, an unrevealed panel
// draws no chip and its own closer is inside the hidden element, so there was
// no way to shut it again — the gutter stayed for the rest of the session and
// was written to the saved layout for the next one.
//
// Nobody would have written a test for "the Agents panel, on an account that
// has not met agents yet, opened through the API rather than the chip". The
// property covers it without anyone naming it.
//
//   node dev/verify_nogutter.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway.

import fs from 'node:fs';
import { open, scratch, shot } from './harness.mjs';

let failures = 0, skips = 0;
const skipped = [];
const check = (cond, msg, detail) => {
	console.log((cond ? '    ok   ' : '    FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};
const skip = (name, why) => {
	console.log('  SKIP ' + name + ' — ' + why);
	skipped.push(name + ': ' + why);
	skips++;
};

/// What each zone is holding, and what is actually drawn inside it.
///
/// `getClientRects()`, not the inline style: the whole defect was a stylesheet
/// rule beating an inline `display:''`, so anything that reads what the engine
/// INTENDED rather than what the browser DID would have reported the broken
/// layout as healthy. (An `el.style.display || 'unset'` probe is worse still —
/// it prints "unset" for the empty string the engine legitimately sets.)
const ZONES = () => {
	const seen = (el) => el.getClientRects().length > 0;
	const out = {};
	[['dock', 'dock'], ['stage', 'stage']].forEach(([key, id]) => {
		const z = document.getElementById(id);
		if (!z) { out[key] = null; return; }
		out[key] = {
			width:   Math.round(z.getBoundingClientRect().width),
			visible: [...z.querySelectorAll('.panel')].filter(seen).map((p) => p.dataset.panel),
			seated:  [...z.querySelectorAll('.panel')].map((p) => p.dataset.panel),
		};
	});
	out.open = (window.DaimondPanels ? DaimondPanels.panels() : [])
		.map((p) => p.id).filter((id) => DaimondPanels.isOpen(id));
	// The same question one level down. The dock's columns SHARE its width, so a
	// column the grid has finished with but the browser is still drawing takes
	// its share from the columns that have something in them -- a gutter that
	// does not show up in the dock's own width at all.
	out.cols = [...document.querySelectorAll('#dock .pcol')].map((c) => ({
		id:      c.id,
		width:   Math.round(c.getBoundingClientRect().width),
		visible: [...c.children].filter(seen).map((k) => k.dataset.panel),
	}));
	return out;
};

/// The complaint, or null when the zones are honest.
function gutterIn(z) {
	for (const key of ['dock', 'stage']) {
		const zone = z[key];
		if (!zone) continue;
		if (zone.width > 0 && zone.visible.length === 0) {
			return `${key} is ${zone.width}px wide with nothing rendered in it`
				+ (zone.seated.length ? ` (seated but invisible: ${zone.seated.join(', ')})` : '');
		}
	}
	const dead = (z.cols || []).filter((c) => c.width > 0 && c.visible.length === 0);
	if (dead.length) {
		return dead.map((c) => `dock column ${c.id} is ${c.width}px wide with nothing rendered in it`)
			.join('; ');
	}
	return null;
}

/// Every panel the engine knows about, asked of the engine rather than listed
/// here — a panel added later is covered without this file being edited.
const PANEL_IDS = () => (window.DaimondPanels ? DaimondPanels.panels() : []).map((p) => p.id);

const start = async (name) => {
	const dir = scratch('pw', 'gut-' + Math.random().toString(36).slice(2, 10));
	const s = await open({ connect: false, name: name || 'nogutter', profile: dir });
	const inner = s.close;
	s.close = async () => {
		await inner();
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ }
	};
	await s.page.waitForTimeout(600);
	return s;
};

// ── 1. Every panel, opened and closed on its own, in a fresh session ────
//
// Fresh each time, and deliberately on a NEW account: `agents-hidden` is on
// until an account has met the agents, which is exactly the state the defect
// needed. A verifier that reused one signed-in profile would reveal the panel
// on its first probe and be blind for the rest of the run.
console.log('\n── Each panel, shown then hidden, on a fresh account');
let ids = [];
try {
	const s0 = await start();
	ids = await s0.page.evaluate(PANEL_IDS);
	await s0.close();
} catch (e) {
	skip('panel list', String(e && e.message ? e.message : e).split('\n')[0]);
}

for (const id of ids) {
	if (id === 'rail' || id === 'ai') continue;      // permanent furniture, not guests
	let s = null;
	try {
		s = await start();
		const { page } = s;
		await page.evaluate((i) => DaimondPanels.show(i), id);
		await page.waitForTimeout(500);
		const shown = await page.evaluate(ZONES);
		const bad1 = gutterIn(shown);

		// And the other side of the same coin: show() has to SHOW. Refusing to
		// seat a panel that cannot render would collapse the gutter honestly
		// enough, and leave "open the Agents panel" as a silent no-op — the
		// asking is what earns a held-back panel its place, so the answer to
		// being asked is to let it out, not to swallow the request.
		const up = await page.evaluate((i) => {
			const el = document.querySelector('.panel[data-panel="' + i + '"]');
			return !!(el && el.getClientRects().length);
		}, id);

		await page.evaluate((i) => DaimondPanels.hide(i), id);
		await page.waitForTimeout(500);
		const hidden = await page.evaluate(ZONES);
		const bad2 = gutterIn(hidden);

		check(!bad1 && !bad2, `show('${id}') then hide('${id}') leaves no dead space`,
			bad1 ? 'after show: ' + bad1 : (bad2 ? 'after hide: ' + bad2 : null));
		check(up, `show('${id}') actually puts it on screen`,
			up ? null : 'the panel never rendered — the request was swallowed');
		if (bad1 || bad2 || !up) await shot(s, 'nogutter-' + id);
	} catch (e) {
		skip(`show/hide ${id}`, String(e && e.message ? e.message : e).split('\n')[0]);
	} finally {
		if (s) { try { await s.close(); } catch (e) { /* gone */ } }
	}
}

// ── 2. The whole round, in one session ─────────────────────────────────
//
// One session ON PURPOSE, unlike every other probe here: the defect's second
// half was that it PERSISTED — the gutter outlived the panel that caused it and
// followed the saved layout into the next session. Only a sequence can catch
// that, so this walk opens everything in turn and checks after every step.
console.log('\n── One session, opening each panel in turn and closing it again');
{
	let s = null;
	try {
		s = await start('nogutter-walk');
		const { page } = s;
		let worst = null;
		for (const id of ids) {
			if (id === 'rail' || id === 'ai') continue;
			await page.evaluate((i) => DaimondPanels.show(i), id);
			await page.waitForTimeout(350);
			let bad = gutterIn(await page.evaluate(ZONES));
			if (bad && !worst) worst = `after show('${id}'): ${bad}`;
			await page.evaluate((i) => DaimondPanels.hide(i), id);
			await page.waitForTimeout(350);
			bad = gutterIn(await page.evaluate(ZONES));
			if (bad && !worst) worst = `after hide('${id}'): ${bad}`;
		}
		check(worst === null, 'the whole round leaves no dead space', worst);

		// And the state it leaves behind: reload, and see what the saved layout
		// brings back. A gutter that survives a reload is one the user is stuck
		// with for good.
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(2500);
		const after = await page.evaluate(ZONES);
		const bad = gutterIn(after);
		check(!bad, 'and nothing dead is restored from the saved layout', bad);
		if (bad) await shot(s, 'nogutter-after-reload');
	} catch (e) {
		skip('the walk', String(e && e.message ? e.message : e).split('\n')[0]);
	} finally {
		if (s) { try { await s.close(); } catch (e) { /* gone */ } }
	}
}

// ── 3. A layout that arrives already broken ────────────────────────────
//
// Anyone who met the defect has it written into `daimond-layout` already, and
// boot calls apply() rather than show() — so unless apply() itself heals it,
// the fix would never reach the people who need it.
console.log('\n── A saved layout that already carries the state');
{
	let s = null;
	try {
		s = await start('nogutter-heal');
		const { page } = s;
		await page.evaluate(() => {
			localStorage.removeItem('daimond-agents-revealed');
			localStorage.removeItem('daimond-used-panels');
			const l = JSON.parse(localStorage.getItem('daimond-layout') || '{}');
			l.open  = Object.assign({}, l.open, { rail: true, ai: true, web: false, work: false, agents: true });
			l.stage = ['ai'];
			l.dock  = ['agents'];
			localStorage.setItem('daimond-layout', JSON.stringify(l));
		});
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(2500);
		const z = await page.evaluate(ZONES);
		const bad = gutterIn(z);
		check(!bad, 'a layout saved with an unshowable panel heals on load',
			bad || `dock ${z.dock.width}px, open: ${z.open.join(',')}`);
		if (bad) await shot(s, 'nogutter-heal');
	} catch (e) {
		skip('the heal', String(e && e.message ? e.message : e).split('\n')[0]);
	} finally {
		if (s) { try { await s.close(); } catch (e) { /* gone */ } }
	}
}

if (skipped.length) console.log('\nSKIPPED: ' + skipped.join('; '));
console.log(failures === 0
	? `\nnogutter: every zone with width has something in it${skips ? ` (${skips} SKIPPED)` : ''}.`
	: `\nnogutter: ${failures} zone(s) holding room for nothing${skips ? `, ${skips} SKIPPED` : ''}.`);
process.exit(failures === 0 && skips === 0 ? 0 : 1);
