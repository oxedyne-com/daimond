// verify_crystalpanel.mjs — opening or closing a panel does not take the crystal's page down.
//
// THE DEFECT THIS IS WRITTEN FROM, in the owner's words (notes6, item 3): "adding or removing a
// panel in the stage makes the crystal show 'This Diamond's page did not show everything it
// holds…'". That note is `crystal.js` giving up on the page: `fell('partial')`, the frame gone,
// the built-in view in its place. Nothing about the crystal had changed — the user had merely
// opened the Tools panel.
//
// WHAT WAS ACTUALLY HAPPENING, measured before anything was fixed. Not a second `rendered` with
// fewer keys, which is the trap CAPP_CONTRACT §5 warns about: the key list was complete and
// identical throughout. It was the OTHER rule, §4. `DaimondPanels.apply()` re-seated the layout
// by appending every open panel to its zone, every time anything opened or closed anywhere —
// and `appendChild` on a node that is already in the document is a REMOVAL and a re-insertion.
// An iframe taken out of the document loses its content window and is navigated to its `src`
// again when it goes back in, so the crystal frame fired a second `load`; `crystal.js` reads
// that as the page navigating itself and shuts the channel, because a `postMessage` sent to
// `'*'` after the frame moved on would be delivered to whatever is there now. That rule is
// right and is not what changed. What changed is that the app stopped moving the frame.
//
// It could not have healed itself either: the blob URL is revoked once the document is fetched,
// so the reload had nothing to fetch. The frame was blank before the fallback replaced it.
//
// THE PROPERTIES:
//
//   1. A stage panel OPENING leaves the crystal's page up — and it is the SAME DOCUMENT, not a
//      fresh one. A mark set inside the frame survives. This is the check that matters: an app
//      that re-mounted the crystal after every panel change would look right in a screenshot
//      and would still throw away whatever a capp had on screen — the half-typed entry, the
//      lane you were reading, the scroll position.
//   2. A stage panel CLOSING, the same. Both directions, because the owner named both.
//   3. A DOCK panel opening and closing, the same. The crystal is in the stage, so a dock panel
//      had no business touching it — and it did, because the stage was re-seated on every pass.
//   4. NO PANEL IS TAKEN OUT OF THE DOCUMENT AND PUT BACK because a DIFFERENT panel opened or
//      closed. The mechanism, stated where it can be measured. It covers what checks 1-3 cannot
//      see: the Web panel's browser and the Preview panel's `<embed>` were being restarted by
//      every panel change too, and no crystal check would ever have noticed.
//   5. The layout is still right afterwards — the seats drawn in the asked-for order, left to
//      right, with a divider between each pair. Without this a "fix" that seated nothing at all
//      would pass everything above.
//
// The gestures are the user's: a chip in the panel row to open, the panel's own × to close.
// Driving `DaimondPanels.show()` from the console would test the engine and not the app.
//
// EACH CHECK PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_crystalpanel.mjs --break moves      # 1, 2, 3, 4: the stage re-seats by re-appending
//   node dev/verify_crystalpanel.mjs --break dockmoves  # 4 alone: the dock does
//   node dev/verify_crystalpanel.mjs                    # and then, clean
//
// `dockmoves` earns its place by turning ONE check red and no other, which is the whole reason
// check 4 is written in terms of the document and not in terms of the crystal: the dock holds
// no crystal, so every other check here is blind to it. The breaks go on the APP, as
// `verify_capp.mjs`'s do, and for the same reason — what is under test is what the app does to
// a page it did not write.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The stage seating as it was: every seat and every divider appended in turn, wherever they
	// already were. This is the shipped defect, byte for byte.
	moves: {
		file: 'js/daimond.js',
		find: "\t\t\t\tplace(stageEl, seq);",
		with: "\t\t\t\tseq.forEach(function (n) { stageEl.appendChild(n); });",
	},
	// The same for the dock's columns. It cannot touch the crystal, which is in the stage — so
	// if check 4 did not exist, this break would change nothing at all.
	dockmoves: {
		file: 'js/daimond.js',
		find: "\t\t\t\tcols.forEach(function (c, i) { place(c, colSeq[i]); });",
		with: "\t\t\t\tcols.forEach(function (c, i) { colSeq[i].forEach(function (n) { c.appendChild(n); }); });",
	},
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// A crystal with a key no page has ever heard of, because that is the case the coverage rule
// exists for: the reducer is a fresh model rewriting the whole crystal from one sentence, so
// `habits` is the expected shape of things and not a curiosity. The shipped page draws unknown
// keys generically and names them all in `rendered`, so a run that falls back has fallen back
// for a reason this file is about.
const CRYSTAL = {
	title:   'Panels',
	summary: 'A crystal to watch while the stage changes around it.',
	facts:   [{ k: 'Seats', v: 'as many as the width carries' }],
	open:    ['Open a panel without losing this page'],
	habits:  { watch: 'what happens to the frame' },
};

const s = await open({ name: 'crystalpanel', signIn: false, connect: false });
const { page } = s;

if (BREAK) {
	const spec = BREAKS[BREAK];
	if (!spec) {
		console.error('no such break: ' + BREAK + '\nhave: ' + Object.keys(BREAKS).join(' '));
		process.exit(2);
	}
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	await page.route('**/' + spec.file, r => r.fulfill({
		status: 200, contentType: 'application/javascript', body: src.replace(spec.find, spec.with),
	}));
	console.log(`  (running with the app broken: ${BREAK})`);
}

/// What the channel says is on screen. `_state()` is the verifier's window on it and the app
/// never uses it.
const state = () => page.evaluate(() => {
	const st = window.DaimondCrystal && window.DaimondCrystal._state && window.DaimondCrystal._state();
	return st ? { mode: st.mode, reason: st.reason, keys: st.keys } : null;
});

/// The crystal's own frame. It is the only `blob:` frame on the page — the guide is a child of
/// the main frame too, so a search by parentage finds THAT one and every measurement after it
/// is of the wrong document.
const crystalFrame = () => page.frames().find(fr => fr.url().indexOf('blob:') === 0) || null;

/// Which panels are drawn in the stage, left to right, and what stands between them.
const seating = () => page.evaluate(() => {
	const out = [];
	[].slice.call(document.getElementById('stage').children).forEach((el) => {
		if (!el.getClientRects().length) return;
		const r = el.getBoundingClientRect();
		out.push({ id: el.dataset.panel || (el.className.indexOf('phandle') >= 0 ? '|' : '?'), x: Math.round(r.x) });
	});
	return out.sort((a, b) => a.x - b.x).map(p => p.id).join(' ');
});

/// Watch for a panel leaving the document. `childList` on the whole tree, because the two zones
/// are different containers and a panel can be pulled out of either.
const watch = () => page.evaluate(() => {
	window.__pulled = [];
	if (window.__obs) window.__obs.disconnect();
	window.__obs = new MutationObserver((recs) => {
		recs.forEach((r) => {
			[].slice.call(r.removedNodes).forEach((n) => {
				if (n.nodeType === 1 && n.dataset && n.dataset.panel) window.__pulled.push(n.dataset.panel);
			});
		});
	});
	window.__obs.observe(document.body, { childList: true, subtree: true });
});
const pulled = () => page.evaluate(() => (window.__pulled || []).slice());

try {
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
	await signInAs(s, 'crystalpanel');
	await connectMock(s);
	await page.waitForTimeout(1500);
	// Wide enough for a THIRD seat. Below 2000 the stage seats two, so opening a panel would
	// evict the one beside the conversation and the act under test would be an eviction rather
	// than an arrival — which is a different thing and not the one the owner reported.
	await page.setViewportSize({ width: 2000, height: 1000 });
	await page.waitForTimeout(600);
	const seatsMax = await page.evaluate(() => DaimondPanels.model().stageMax);
	check('the stage has room for a third seat, so opening one evicts nothing',
		seatsMax >= 3, String(seatsMax));

	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Panels');
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(1800);

	const id = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		window.__free = app;
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Panels');
		return d ? d.id : '';
	});
	check('a Diamond to watch', !!id, id);

	// Only the memory is written. The page is the shipped one, which the app writes into the
	// Diamond on the first render — so what is under test is what every Diamond starts with.
	await page.evaluate(async (a) => {
		await window.__free.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + a.id + '/crystal.json', content: a.crystal }));
	}, { id, crystal: JSON.stringify(CRYSTAL) });
	await page.$$eval('.diamond-box', els => els[0] && els[0].click());
	await page.waitForTimeout(2500);

	const st0 = await state();
	check('the crystal is drawn by its own page to start with',
		!!st0 && st0.mode === 'frame', JSON.stringify(st0));
	const missing = Object.keys(CRYSTAL).filter(k => !(st0 && (st0.keys || []).includes(k)));
	check('and the page named every content key, so nothing below is a coverage failure',
		missing.length === 0, 'missing: ' + (missing.join(', ') || 'none'));

	// The mark. A DOM move destroys the frame's content window, and so does a re-mount by the
	// app; both lose this, and nothing else does.
	const mark = async () => {
		const f = crystalFrame();
		if (!f) return false;
		return await f.evaluate(() => { window.__kept = 'kept'; return true; }).catch(() => false);
	};
	const kept = async () => {
		const f = crystalFrame();
		if (!f) return 'no frame';
		return await f.evaluate(() => String(window.__kept || 'gone')).catch(e => 'unreachable');
	};
	check('a mark can be set inside the page', (await mark()) === true);
	const seats0 = await seating();
	check('and the stage starts with the conversation and the Web panel beside it',
		seats0 === 'ai | web', '"' + seats0 + '"');

	/// One act, and everything it must not have done.
	///
	/// `gesture` is what a person does; `panel` is the panel it is done to, which is the ONE
	/// node allowed to move — a panel being seated for the first time has to come from
	/// wherever the markup left it.
	const act = async (name, panel, gesture, expectSeats) => {
		await watch();
		await gesture();
		await page.waitForTimeout(900);
		const st = await state();
		const note = await page.evaluate(() => !!document.querySelector('.crystal-fallback-note'));
		check(name + ': THE CRYSTAL PAGE IS STILL UP',
			!!st && st.mode === 'frame' && !note,
			'mode:' + (st && st.mode) + ' reason:' + (st && st.reason) + ' fallback:' + note);
		check(name + ': and it is the same document, not a fresh one',
			(await kept()) === 'kept', await kept());
		const moved = (await pulled()).filter(p => p !== panel);
		check(name + ': and no other panel was pulled out of the document',
			moved.length === 0, moved.join(', ') || 'none');
		const seats = await seating();
		check(name + ': and the stage is drawn as it was asked to be', seats === expectSeats,
			'"' + seats + '" wanted "' + expectSeats + '"');
	};

	// ── 1 and 2. A stage panel, opened by its chip and closed by its ×.
	//
	// Tools rather than Web: Web is already open on a first boot, so its chip would be a
	// no-op and the act would prove nothing.
	const chip = (p) => page.click('.ptag[data-panel="' + p + '"]', { timeout: 5000 });
	const closer = (p) => page.click('[data-close="' + p + '"]', { timeout: 5000 });
	await act('opening a stage panel', 'tools', () => chip('tools'), 'ai | web | tools');
	await act('closing a stage panel', 'tools', () => closer('tools'), 'ai | web');

	// ── 3. A dock panel. The crystal is in the stage and this must not reach it at all — the
	// stage's seating must come out of it completely unchanged.
	await act('opening a dock panel', 'trash', () => chip('trash'), 'ai | web');
	await act('closing a dock panel', 'trash', () => closer('trash'), 'ai | web');

	// And the acts were real: a check that passes because nothing happened is the failure this
	// project keeps paying for.
	const flips = await page.evaluate(() => ({
		tools: DaimondPanels.isOpen('tools'), trash: DaimondPanels.isOpen('trash'),
	}));
	check('the panels really opened and closed, so none of the above passed by standing still',
		flips.tools === false && flips.trash === false, JSON.stringify(flips));

	// The 502s are the account service on :9002, which a world does not run; they say nothing
	// about the layout. Everything else counts.
	const errs = errors(s).filter(e => !/502|Bad Gateway|account/i.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
} finally {
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
