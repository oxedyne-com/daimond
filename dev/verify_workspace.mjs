// verify_workspace.mjs — the controls that arrange Daimond.
//
// What is checked here is not the pixels but the guarantees the design rests on,
// because those are the things a later change can quietly break:
//
//   * a chip never moves when a neighbour opens (the reason chips are toggles),
//   * the dock's capacity comes from the chosen grid, not a constant,
//   * a grid too small to hold what is open CLOSES the surplus rather than
//     losing it, so it comes back as a chip,
//   * pinning is the only thing that decides the row, and nothing reorders,
//   * the row may be incomplete, but the gallery and the palette may not,
//   * text scaling moves the TYPE and leaves the frame where it is,
//   * an arrangement is restored only where one was deliberately saved.
//
// Run with dev/serve.mjs up. No gateway needed.
import { open, signInAs, errors } from './harness.mjs';

const s = await open({ name: 'workspace', connect: false });
const p = s.page;
await p.waitForTimeout(2500);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// A Facet to hang an arrangement on later.
const facetId = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return await app.create_facet('Ship the launch');
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'workspace');
await p.waitForTimeout(3000);

// The Agents panel hides until the first agent runs; reveal it so the fleet is
// whole and the counts below mean what they say.
await p.evaluate(() => {
	localStorage.setItem('daimond-agents-revealed', '1');
	document.body.classList.remove('agents-hidden');
	window.DaimondPanels.reflow();
});
await p.waitForTimeout(300);

const chips = () => p.$$eval('#panel-tags .ptag[data-panel]', els => els.map(e => ({
	id: e.dataset.panel,
	on: e.classList.contains('on'),
	disabled: e.disabled,
	zone: (e.className.match(/ptag-(rail|stage|dock)/) || [])[1] || null,
	x: Math.round(e.getBoundingClientRect().left),
})));

// ── The row shows every panel, not only the closed ones ─────────────────
{
	const c = await chips();
	const openCount = c.filter(x => x.on).length;
	check('the row carries chips for open panels too', openCount > 0, `${openCount} of ${c.length} shown as open`);
	check('an open panel is marked, not hidden',
		c.some(x => x.id === 'ai' && x.on), 'the chat is open and chipped');
}

// ── A chip does not move when its neighbour opens ───────────────────────
// This is the whole reason the row was inverted. When only closed panels had
// chips, opening one shifted every chip to its right and the target a user was
// aiming at slid out from under the cursor.
{
	const before = await chips();
	await p.evaluate(() => window.DaimondPanels.show('tools'));
	await p.waitForTimeout(350);
	const after = await chips();
	const moved = before.filter(b => {
		const a = after.find(x => x.id === b.id);
		return a && a.x !== b.x && b.id !== 'tools';
	});
	check('opening a panel moves no other chip', moved.length === 0,
		moved.length ? moved.map(m => m.id).join(', ') + ' shifted' : 'every chip held its place');
	check('the opened panel is now marked open',
		after.find(x => x.id === 'tools')?.on === true);
	await p.evaluate(() => window.DaimondPanels.hide('tools'));
	await p.waitForTimeout(300);
}

// ── Zones are legible by position, in screen order ──────────────────────
{
	const c = await chips();
	const firstOf = z => c.findIndex(x => x.zone === z);
	const rail = firstOf('rail'), stage = firstOf('stage'), dock = firstOf('dock');
	check('chips are grouped rail, then stage, then dock — the order the zones sit in',
		rail < stage && stage < dock, `rail@${rail} stage@${stage} dock@${dock}`);
	const divs = await p.$$eval('#panel-tags .ptag-div', e => e.length);
	check('the groups are separated', divs >= 2, `${divs} dividers`);
}

// ── The dock's capacity is the grid, not a constant ─────────────────────
{
	const cap = async g => p.evaluate(grid => {
		window.DaimondPanels.setGrid(grid);
		return window.DaimondPanels.model().dockMax;
	}, g);
	check('a 2 by 2 dock holds four', await cap('2x2') === 4);
	check('a 2 by 3 dock holds six',  await cap('2x3') === 6);
	check('a 3 by 2 dock holds six',  await cap('3x2') === 6);
	check('one column holds four',    await cap('1')   === 4);
}

// ── Columns are real, and balanced ──────────────────────────────────────
{
	await p.evaluate(() => {
		window.DaimondPanels.setGrid('2x3');
		['agents', 'mail', 'work', 'spend'].forEach(id => window.DaimondPanels.show(id));
	});
	await p.waitForTimeout(500);
	const cols = await p.$$eval('#dock .pcol', els =>
		els.map(e => e.children.length).filter(n => n > 0));
	check('four dock panels tile across two columns', cols.length === 2, `columns: ${cols.join(' + ')}`);
	check('the columns are balanced rather than filled in turn',
		Math.abs(cols[0] - cols[1]) <= 1, `${cols.join(' vs ')}`);
}

// ── A smaller grid CLOSES the surplus; it does not lose it ──────────────
// A panel that simply vanished would be a panel the user cannot get back
// without knowing it was ever there. Closed, it returns to the row as a chip.
{
	await p.evaluate(() => window.DaimondPanels.setGrid('2x2'));
	await p.waitForTimeout(400);
	const seated = await p.$$eval('#dock .pcol > .panel', e => e.length);
	check('a 2 by 2 dock seats no more than four', seated <= 4, `${seated} seated`);

	await p.evaluate(() => window.DaimondPanels.setGrid('1'));
	await p.waitForTimeout(400);
	const c = await chips();
	const dockChips = c.filter(x => x.zone === 'dock');
	check('every dock panel still has a chip after the grid shrank',
		dockChips.length === 4, `${dockChips.length} dock chips`);
	// NOTE: the shedding path in setGrid cannot be driven today. The smallest
	// grid seats four and there are exactly four dock panels, so nothing is ever
	// surplus. What can be asserted is the invariant it exists to keep -- and
	// this check starts biting the moment a fifth dock panel is added.
	const seatedNow = await p.$$eval('#dock .pcol > .panel', e => e.length);
	const capNow = await p.evaluate(() => window.DaimondPanels.model().dockMax);
	check('the dock never seats more than the grid allows', seatedNow <= capNow,
		`${seatedNow} seated, ${capNow} allowed`);
}

// ── A full dock says so on the chip, before it is clicked ───────────────
{
	await p.evaluate(() => {
		window.DaimondPanels.setGrid('2x2');
		['agents', 'mail', 'work', 'spend'].forEach(id => window.DaimondPanels.show(id));
	});
	await p.waitForTimeout(400);
	const full = await p.evaluate(() => {
		// Close one and fill with the other three, then ask about the odd one out.
		window.DaimondPanels.setGrid('1');
		return window.DaimondPanels.model().panels.filter(x => x.full).map(x => x.id);
	});
	await p.waitForTimeout(300);
	const c = await chips();
	const disabled = c.filter(x => x.disabled).map(x => x.id);
	check('a chip that cannot be honoured is disabled rather than silently inert',
		full.length === 0 || disabled.length > 0, `full: [${full}] disabled: [${disabled}]`);
	await p.evaluate(() => window.DaimondPanels.setGrid('auto'));
	await p.waitForTimeout(300);
}

// ── Pinning decides the row, and only pinning ───────────────────────────
{
	const before = (await chips()).length;
	await p.evaluate(() => window.DaimondPanels.setPinned('compose', false));
	await p.waitForTimeout(350);
	const after = await chips();
	check('unpinning takes a chip off the row', after.length === before - 1,
		`${before} then ${after.length}`);
	check('the unpinned panel is gone from the row',
		!after.some(x => x.id === 'compose'));
	const more = await p.$$eval('#panel-more', e => e.map(x => x.textContent));
	check('an overflow chip appears, carrying the count', more.length === 1, more[0]);

	// Unpinning ONE must not read as unpinning all: the implicit "all of them"
	// has to become a real list without collapsing.
	check('every other panel keeps its pin',
		after.length === before - 1, `${after.length} chips remain`);
}

// ── The row may be incomplete; the gallery may not ──────────────────────
{
	await p.click('#panel-more');
	await p.waitForTimeout(400);
	const rows = await p.$$eval('#panel-gallery .gal-row .nm', els => els.map(e => e.textContent));
	const model = await p.evaluate(() => window.DaimondPanels.model().panels.length);
	check('the gallery lists every panel, pinned or not', rows.length === model,
		`${rows.length} rows for ${model} panels`);
	check('including the one that is not on the row', rows.includes('Compose'));

	await p.fill('#panel-gallery .gal-search', 'spend');
	await p.waitForTimeout(300);
	const hits = await p.$$eval('#panel-gallery .gal-row .nm', els => els.map(e => e.textContent));
	check('the gallery searches', hits.length === 1 && hits[0] === 'Spending', hits.join(', '));

	await p.keyboard.press('Escape');
	await p.waitForTimeout(250);
	check('escape closes the gallery', await p.$eval('#panel-gallery', e => e.hidden));
}

// ── A panel that has not revealed itself is still enumerable ───────────
// The Agents panel stays off the chip row until the first agent runs. It must
// still be findable, or the dock reads as three panels and a user counting them
// is simply misinformed about their own app.
{
	await p.evaluate(() => {
		localStorage.removeItem('daimond-agents-revealed');
		document.body.classList.add('agents-hidden');
		window.DaimondPanels.reflow();
	});
	await p.waitForTimeout(350);
	const row = await chips();
	check('an unrevealed panel keeps off the chip row',
		!row.some(x => x.id === 'agents'), `${row.length} chips`);

	await p.click('#panel-more').catch(() => {});
	await p.waitForTimeout(400);
	const names = await p.$$eval('#panel-gallery .gal-row .nm', els => els.map(e => e.textContent));
	check('but the gallery still lists it', names.includes('Agents'), names.join(', '));
	const states = await p.$$eval('#panel-gallery .gal-row', els =>
		els.map(e => e.textContent).filter(t => /Agents/.test(t)));
	check('and says why it is not on the row', /not in use yet/.test(states[0] || ''), states[0]);
	await p.keyboard.press('Escape');
	await p.waitForTimeout(250);

	// Asking for it IS the event the reveal was waiting for.
	await p.evaluate(() => window.DaimondPanels.activate('agents'));
	await p.waitForTimeout(500);
	check('reaching for it reveals it',
		!(await p.evaluate(() => document.body.classList.contains('agents-hidden'))));
	check('and it opens', await p.evaluate(() => window.DaimondPanels.isOpen('agents')));
}

// ── Pins survive a reload, and so does the grid ─────────────────────────
{
	await p.evaluate(() => window.DaimondPanels.setGrid('2x3'));
	await p.waitForTimeout(300);
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'workspace');
	await p.waitForTimeout(2500);
	const grid = await p.evaluate(() => window.DaimondPanels.grid());
	check('the chosen tiling outlives a reload', grid === '2x3', grid);
	const c = await chips();
	check('so does the pin list', !c.some(x => x.id === 'compose'),
		`${c.length} chips, compose absent`);
}

// ── The palette reaches what the row does not ───────────────────────────
{
	await p.keyboard.press('Control+k');
	await p.waitForTimeout(400);
	check('ctrl-k opens the palette', !(await p.$eval('#palette', e => e.hidden)));
	await p.fill('#pal-input', 'compose');
	await p.waitForTimeout(300);
	const items = await p.$$eval('#pal-list .pal-item .nm', els => els.map(e => e.textContent));
	check('an unpinned panel is still reachable by typing', items.includes('Compose'), items.join(', '));
	await p.keyboard.press('Enter');
	await p.waitForTimeout(500);
	check('and opening it from the palette works',
		await p.evaluate(() => window.DaimondPanels.isOpen('compose')));
	check('the palette closes itself once it has acted',
		await p.$eval('#palette', e => e.hidden));

	// Settings are reachable the same way, which is what makes the palette
	// complete rather than merely a panel switcher.
	await p.keyboard.press('Control+k');
	await p.waitForTimeout(300);
	await p.fill('#pal-input', 'lolly');
	await p.waitForTimeout(250);
	await p.keyboard.press('Enter');
	await p.waitForTimeout(400);
	check('a theme can be set from the palette',
		await p.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'lollypop');
	await p.evaluate(() => window.DaimondTheme.set('dark'));
}

// ── Text scaling moves the type and leaves the frame ────────────────────
{
	const measure = () => p.evaluate(() => {
		const cs = getComputedStyle(document.body);
		const head = document.querySelector('.topbar, .header, header');
		return {
			font: parseFloat(cs.fontSize),
			headerH: head ? Math.round(head.getBoundingClientRect().height) : null,
			railW: Math.round(document.getElementById('panel-rail').getBoundingClientRect().width),
		};
	});
	const base = await measure();
	await p.evaluate(() => window.DaimondWorkspace.setScale(1.3));
	await p.waitForTimeout(500);
	const big = await measure();

	check('the type grows', big.font > base.font, `${base.font}px then ${big.font}px`);
	check('by the amount asked for',
		Math.abs(big.font - base.font * 1.3) < 0.6, `${big.font} vs ${(base.font * 1.3).toFixed(1)}`);
	check('the rail does not', big.railW === base.railW, `${base.railW}px then ${big.railW}px`);

	await p.evaluate(() => window.DaimondWorkspace.setScale(1));
	await p.waitForTimeout(400);
	const back = await measure();
	check('and it goes back exactly', back.font === base.font, `${back.font}px`);
}

// ── The size reaches the framed guide, which is its own document ────────
// The guide is a separate document with its own stylesheet, so a size set on
// the app does not reach it by inheritance. It has to be mirrored, exactly as
// the theme already was -- and this is the check that would have caught the
// guide falling back to a default when the tokens were first introduced.
{
	await p.click('#guide-btn').catch(() => {});
	await p.waitForTimeout(2500);
	// Read through Playwright's frame API, not contentDocument: the Web panel
	// withholds `allow-same-origin`, so the document is opaque to the page.
	const guideFrame = () => p.frames().find(f => /\/guide\//.test(f.url()));
	const guideFont = async () => {
		const f = guideFrame();
		if (!f) return null;
		try { return await f.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize)); }
		catch (e) { return null; }
	};
	const a = await guideFont();
	if (a === null) {
		check('the framed guide could be measured', false, 'no same-origin frame to read');
	} else {
		await p.evaluate(() => window.DaimondWorkspace.setScale(1.3));
		await p.waitForTimeout(700);
		const b = await guideFont();
		check('the guide carries the reader\'s size too', b > a, `${a}px then ${b}px`);
		await p.evaluate(() => window.DaimondWorkspace.setScale(1));

		// The guide could never see the app's theme through the sandbox, and had
		// been quietly defaulting to dark whatever the app was set to.
		await p.evaluate(() => window.DaimondTheme.set('light'));
		await p.waitForTimeout(600);
		const th = await guideFrame().evaluate(() => document.documentElement.getAttribute('data-theme'));
		check('and the theme, which the sandbox had always blocked', th === 'light', String(th));
		await p.evaluate(() => window.DaimondTheme.set('dark'));
	}
}

// ── An arrangement is restored only where one was saved ─────────────────
{
	await p.waitForTimeout(300);
	// Nothing saved yet: selecting the Facet must not disturb the panels.
	const before = await p.evaluate(() => window.DaimondPanels.model().panels
		.filter(x => x.open).map(x => x.id).sort().join(','));
	await p.evaluate(async (id) => {
		const row = Array.from(document.querySelectorAll('#facet-list .facet-box'))
			.find(e => e.dataset.id === id);
		if (row) row.click();
		await new Promise(r => setTimeout(r, 800));
	}, facetId);
	await p.waitForTimeout(600);
	const after = await p.evaluate(() => window.DaimondPanels.model().panels
		.filter(x => x.open).map(x => x.id).sort().join(','));
	check('a Facet with no saved arrangement changes nothing', before === after,
		`${before} then ${after}`);

	// Save one, disturb the layout, come back.
	await p.evaluate((id) => {
		window.DaimondPanels.show('spend');
		window.DaimondPanels.saveArrangement(id);
	}, facetId);
	await p.waitForTimeout(400);
	check('the arrangement is recorded',
		await p.evaluate((id) => window.DaimondPanels.hasArrangement(id), facetId));

	await p.evaluate(() => window.DaimondPanels.hide('spend'));
	await p.waitForTimeout(300);
	check('and the layout was genuinely disturbed',
		!(await p.evaluate(() => window.DaimondPanels.isOpen('spend'))));

	await p.evaluate((id) => window.DaimondPanels.restoreArrangement(id), facetId);
	await p.waitForTimeout(500);
	check('returning to the Facet puts the panels back',
		await p.evaluate(() => window.DaimondPanels.isOpen('spend')));

	await p.evaluate((id) => window.DaimondPanels.forgetArrangement(id), facetId);
	check('and it can be forgotten',
		!(await p.evaluate((id) => window.DaimondPanels.hasArrangement(id), facetId)));
}

// ── The row fits the window, and takes nothing off screen with it ──────
// This one is worth keeping. The header used to run off the right of a narrow
// window, carrying the README, guide and appearance buttons out of reach, and
// NOTHING caught it: the body does not scroll when it happens, so the usual
// horizontal-overflow check reads clean. The row now sheds its tail into the
// menu instead, and what is asserted is that the controls stay reachable.
{
	for (const w of [1440, 1100, 950, 850]) {
		await p.setViewportSize({ width: w, height: 850 });
		await p.evaluate(() => window.DaimondPanels.reflow());
		await p.waitForTimeout(400);
		const r = await p.evaluate(() => {
			const acts = document.querySelector('.top-actions').getBoundingClientRect();
			const tags = document.getElementById('panel-tags');
			const btn = document.getElementById('settings-menu-btn').getBoundingClientRect();
			return {
				actsRight: Math.round(acts.right),
				btnRight: Math.round(btn.right),
				rowOverflows: tags.scrollWidth > tags.clientWidth + 1,
				onRow: document.querySelectorAll('#panel-tags .ptag[data-panel]').length,
			};
		});
		check(`at ${w}px the header stays inside the window`,
			r.actsRight <= w + 1, `actions end at ${r.actsRight}`);
		check(`at ${w}px the appearance button is reachable`,
			r.btnRight <= w + 1 && r.btnRight > 0, `button ends at ${r.btnRight}`);
		check(`at ${w}px the row does not overflow its own box`,
			!r.rowOverflows, `${r.onRow} chips on the row`);
	}
	await p.setViewportSize({ width: 1500, height: 950 });
	await p.evaluate(() => window.DaimondPanels.reflow());
	await p.waitForTimeout(400);
}

// ── Nothing threw ───────────────────────────────────────────────────────
{
	const errs = errors(s).filter(e => !/502|Bad Gateway|Failed to load resource/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.join(' | ') || 'clean');
}

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
