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

// A Diamond to hang an arrangement on later.
const diamondId = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return await app.create_diamond('Ship the launch');
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

/// Which panels the DOCUMENT says belong to the dock.
///
/// The number of them is not a constant this file may hold: it was four, the
/// Terminal panel made it five, and a check carrying the old number fails for a
/// panel that is working. `data-zone` in the markup is where that fact lives.
const dockZone = () => p.$$eval('.panel[data-zone="dock"]', els => els.map(e => e.dataset.panel));

/// How many panels the dock actually DRAWS.
///
/// Not how many nodes sit in its columns: closing a panel hides its element and
/// leaves it where it was seated (apply() says so in as many words), so counting
/// nodes counts a panel that has just been shed and reads a working shrink as an
/// overfull dock. The computed style is what says a seat was given up.
const seatedNow = () => p.$$eval('#dock .pcol > .panel',
	els => els.filter(e => getComputedStyle(e).display !== 'none').length);

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
	const seated = await seatedNow();
	check('a 2 by 2 dock seats no more than four', seated <= 4, `${seated} seated`);

	await p.evaluate(() => window.DaimondPanels.setGrid('1'));
	await p.waitForTimeout(400);
	// Which panels belong to the dock is DECLARED in the markup, so the
	// expectation is read from there rather than written down here. It used to
	// say four; the Terminal panel made it five and the check went red for a
	// panel that was working perfectly. Reading the document also cross-checks
	// two sources against each other -- `data-zone` in the markup against the
	// `ptag-dock` class the chip row draws from the panel registry -- so a panel
	// declared in one zone and registered in another is caught here too.
	const dockPanels = await dockZone();
	const dockChips  = (await chips()).filter(x => x.zone === 'dock').map(x => x.id);
	const chipless   = dockPanels.filter(id => !dockChips.includes(id));
	check('every dock panel still has a chip after the grid shrank',
		chipless.length === 0 && dockChips.length === dockPanels.length,
		`${dockChips.length} chips for ${dockPanels.length} dock panels`
			+ (chipless.length ? `; no chip for ${chipless.join(', ')}` : ''));
	const drawn  = await seatedNow();
	const capNow = await p.evaluate(() => window.DaimondPanels.model().dockMax);
	check('the dock never seats more than the grid allows', drawn <= capNow,
		`${drawn} seated, ${capNow} allowed`);
}

// ── A fifth dock panel, so the shedding arm can be driven ──────────────
// The smallest grid seats four, and the product ships four dock panels, so
// nothing is ever surplus and `setGrid`'s shedding arm — and the "this dock is
// full" chip below it — run in no test at all.
//
// That gap was invisible for a day because the Terminal happened to be a fifth
// dock panel, and it closed again the moment the Terminal moved to the stage.
// Depending on a particular product panel being docked is what made the check
// fragile, so it does not depend on one: a panel is DECLARED, the way any panel
// is declared, and the engine is left to discover it through the same `scan()`
// that finds the real ones. It is added before the document's own scripts run
// (a MutationObserver at document-start, because the registry is read during
// boot and a DOMContentLoaded listener is a race against it), and the page is
// reloaded so boot sees it.
{
	await p.addInitScript(() => {
		const add = () => {
			if (document.getElementById('panel-scratch')) return true;
			const dock = document.getElementById('dock');
			if (!dock) return false;			// not parsed yet; the observer waits
			const a = document.createElement('aside');
			a.className = 'panel scratch';
			a.id = 'panel-scratch';
			a.dataset.panel = 'scratch';
			a.dataset.zone  = 'dock';
			a.dataset.label = 'Scratch';
			a.innerHTML = '<div class="railhead"><span role="heading" aria-level="2">Scratch</span></div>';
			dock.parentNode.insertBefore(a, dock.nextSibling);
			return true;
		};
		if (!add()) {
			// `document`, not `document.documentElement`: at document-start the root
			// element does not exist yet, and observing null throws before anything
			// else in this script has been registered.
			const mo = new MutationObserver(() => { if (add()) mo.disconnect(); });
			mo.observe(document, { childList: true, subtree: true });
			document.addEventListener('DOMContentLoaded', add);
		}
	});
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'workspace');
	await p.waitForTimeout(2500);
	const dockPanels = await dockZone();
	check('a fifth dock panel is registered from the markup, as any panel is',
		dockPanels.includes('scratch') && dockPanels.length === 5, dockPanels.join(', '));
	const smallest = await p.evaluate(() => {
		const g = window.DaimondPanels.grids();
		return Math.min(...Object.keys(g).filter(k => g[k]).map(k => g[k].cols * g[k].rows));
	});
	check('and the smallest grid seats fewer than there now are, so a surplus exists',
		smallest < dockPanels.length, `${smallest} seats for ${dockPanels.length} panels`);
}

// ── The surplus is CLOSED, not lost ─────────────────────────────────────
// A grid too small to hold what is open leaves a panel with nowhere to sit, and
// what has to be true of it is that it was CLOSED, and is therefore still on the
// row to be clicked back. A panel that simply vanished would be one the user
// cannot get back without knowing it was ever there.
{
	const dockPanels = await dockZone();
	await p.evaluate((ids) => {
		window.DaimondPanels.setGrid('2x3');
		ids.forEach(id => window.DaimondPanels.show(id));
	}, dockPanels);
	await p.waitForTimeout(600);
	const openFull = await p.evaluate((ids) =>
		ids.filter(id => window.DaimondPanels.isOpen(id)), dockPanels);
	check('a grid with room for them seats every dock panel at once',
		openFull.length === dockPanels.length,
		`${openFull.length} of ${dockPanels.length} open`);

	await p.evaluate(() => window.DaimondPanels.setGrid('1'));
	await p.waitForTimeout(600);
	const shrunk = await p.evaluate((ids) => ({
		open: ids.filter(id => window.DaimondPanels.isOpen(id)),
		cap:  window.DaimondPanels.model().dockMax,
	}), dockPanels);
	shrunk.seated = await seatedNow();
	const shed = openFull.filter(id => !shrunk.open.includes(id));
	check('a grid too small to hold them closes the surplus',
		shrunk.seated <= shrunk.cap && shed.length === openFull.length - shrunk.cap,
		`${shrunk.seated} seated of ${shrunk.cap}; closed: ${shed.join(', ') || 'none'}`);
	const onRow = (await chips()).map(x => x.id);
	check('and what was closed is back on the row, where it can be clicked again',
		shed.length > 0 && shed.every(id => onRow.includes(id)),
		`closed ${shed.join(', ') || 'nothing'}; row has ${onRow.join(', ')}`);

	await p.evaluate((ids) => {
		ids.forEach(id => window.DaimondPanels.hide(id));
		window.DaimondPanels.setGrid('auto');
	}, dockPanels);
	await p.waitForTimeout(400);
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
	// Two checks, not one. This used to read `full.length === 0 || disabled…`,
	// which passes without asserting anything at all on a dock that is never
	// full — and with four dock panels and a four-seat floor, that was every run.
	check('a dock with no seat left names the chip it cannot honour',
		full.length > 0, `full: [${full}]`);
	check('and that chip is disabled rather than silently inert',
		full.length > 0 && full.every(id => disabled.includes(id)),
		`full: [${full}] disabled: [${disabled}]`);
	await p.evaluate(() => window.DaimondPanels.setGrid('auto'));
	await p.waitForTimeout(300);
}

// ── Pinning decides the row, and only pinning ───────────────────────────
{
	const before = (await chips()).length;
	await p.evaluate(() => window.DaimondPanels.setPinned('tools', false));
	await p.waitForTimeout(350);
	const after = await chips();
	check('unpinning takes a chip off the row', after.length === before - 1,
		`${before} then ${after.length}`);
	check('the unpinned panel is gone from the row',
		!after.some(x => x.id === 'tools'));
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
	check('including the one that is not on the row', rows.includes('Tools'));

	await p.fill('#panel-gallery .gal-search', 'spend');
	await p.waitForTimeout(300);
	const hits = await p.$$eval('#panel-gallery .gal-row .nm', els => els.map(e => e.textContent));
	check('the gallery searches', hits.length === 1 && hits[0] === 'Spending', hits.join(', '));

	await p.keyboard.press('Escape');
	await p.waitForTimeout(250);
	check('escape closes the gallery', await p.$eval('#panel-gallery', e => e.hidden));
}

// ── A panel with nothing to hold waits before joining the row ──────────
// Message and Compose mean nothing without an account for mail to arrive at or
// be sent from, and a Doc panel means nothing before something is compiled into
// it. Standing in the row from the first run they read as broken features
// rather than as features not yet reached.
{
	const row = await chips();
	const onRow = row.map(x => x.id);
	check('Message stays off the row while no mail account exists',
		!onRow.includes('msg'), onRow.join(', '));
	check('and so does Compose, which needs somewhere to send from',
		!onRow.includes('compose'));
	check('and Doc, until something has been compiled into it',
		!onRow.includes('doc'));

	// But all three are still enumerable, which is the rule the row bends to.
	await p.evaluate(() => window.DaimondRelease && 0);
	const model = await p.evaluate(() => window.DaimondPanels.model().panels.map(x => x.id));
	check('all three are still in the model, for the gallery and the palette',
		['msg', 'compose', 'doc'].every(id => model.includes(id)), model.join(', '));

	// Reaching for one is the event it was waiting for.
	await p.evaluate(() => window.DaimondPanels.activate('doc'));
	await p.waitForTimeout(400);
	const after2 = (await chips()).map(x => x.id);
	check('reaching for Doc puts it on the row for good', after2.includes('doc'), after2.join(', '));
}

// ── A panel that has not revealed itself is still enumerable ───────────
// This was proved with the Agents panel, which stayed off the chip row until a
// Diamond dispatched its first agent. It no longer does: a panel that comes and
// goes reads as a panel that was taken away, which is how the user read it, so
// Agents is now reachable at all times and says that nothing is running. The
// property is unchanged and is proved directly above with the Doc panel, which
// is what still waits to be earned ("reaching for Doc puts it on the row for
// good"). What went with the block was its fixture, not its subject.
{
	// `show`, not `activate`: activate TOGGLES a panel that has already revealed
	// itself, so calling it on one that happens to be open closes it -- which is
	// what the first draft of this check did to itself.
	await p.evaluate(() => window.DaimondPanels.hide('agents'));
	await p.waitForTimeout(300);
	await p.evaluate(() => window.DaimondPanels.show('agents'));
	await p.waitForTimeout(400);
	check('the Agents panel opens whether or not an agent has ever run',
		await p.evaluate(() => window.DaimondPanels.isOpen('agents')));
	const row = (await chips()).map(x => x.id);
	check('and it is on the chip row from the start', row.includes('agents'), row.join(', '));
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
	check('so does the pin list', !c.some(x => x.id === 'tools'),
		`${c.length} chips, tools absent`);
}

// ── The palette reaches what the row does not ───────────────────────────
{
	await p.keyboard.press('Control+k');
	await p.waitForTimeout(400);
	check('ctrl-k opens the palette', !(await p.$eval('#palette', e => e.hidden)));
	await p.fill('#pal-input', 'tools');
	await p.waitForTimeout(300);
	const items = await p.$$eval('#pal-list .pal-item .nm', els => els.map(e => e.textContent));
	check('an unpinned panel is still reachable by typing', items.includes('Tools'), items.join(', '));
	await p.keyboard.press('Enter');
	await p.waitForTimeout(500);
	check('and opening it from the palette works',
		await p.evaluate(() => window.DaimondPanels.isOpen('tools')));
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
	// Nothing saved yet: selecting the Diamond must not disturb the panels.
	const before = await p.evaluate(() => window.DaimondPanels.model().panels
		.filter(x => x.open).map(x => x.id).sort().join(','));
	await p.evaluate(async (id) => {
		const row = Array.from(document.querySelectorAll('#diamond-list .diamond-box'))
			.find(e => e.dataset.id === id);
		if (row) row.click();
		await new Promise(r => setTimeout(r, 800));
	}, diamondId);
	await p.waitForTimeout(600);
	const after = await p.evaluate(() => window.DaimondPanels.model().panels
		.filter(x => x.open).map(x => x.id).sort().join(','));
	check('a Diamond with no saved arrangement changes nothing', before === after,
		`${before} then ${after}`);

	// Save one, disturb the layout, come back.
	await p.evaluate((id) => {
		window.DaimondPanels.show('spend');
		window.DaimondPanels.saveArrangement(id);
	}, diamondId);
	await p.waitForTimeout(400);
	check('the arrangement is recorded',
		await p.evaluate((id) => window.DaimondPanels.hasArrangement(id), diamondId));

	await p.evaluate(() => window.DaimondPanels.hide('spend'));
	await p.waitForTimeout(300);
	check('and the layout was genuinely disturbed',
		!(await p.evaluate(() => window.DaimondPanels.isOpen('spend'))));

	await p.evaluate((id) => window.DaimondPanels.restoreArrangement(id), diamondId);
	await p.waitForTimeout(500);
	check('returning to the Diamond puts the panels back',
		await p.evaluate(() => window.DaimondPanels.isOpen('spend')));

	await p.evaluate((id) => window.DaimondPanels.forgetArrangement(id), diamondId);
	check('and it can be forgotten',
		!(await p.evaluate((id) => window.DaimondPanels.hasArrangement(id), diamondId)));
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
