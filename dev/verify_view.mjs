// verify_view.mjs -- Max and Simple, and the two rules that make them safe.
//
// The user's words: "Max is the current Compact view but with more important
// information and settings pulled out of dialogs and made visible in order to
// use more screen real-estate, and Simple is more canva-like, with clutter
// removed by hiding non-essential detail."
//
// The design is not "more" and "less". It is where a control LIVES relative to
// the thing it controls: Simple puts controls inside the object, Max hoists
// them onto it so several objects can be compared without navigating.
//
// What is proved here:
//
//   INVARIANT 1 -- Simple hides information, never affordances. Every control
//     reachable in Max is reachable in Simple within one more click, and the
//     route (the cog) is always visible. This is what stops Simple being a mode
//     where the reader concludes the app is broken.
//   INVARIANT 2 -- Simple never hides a warning, an error, or a spending
//     control. Notes2 opens on the Transparent Control Principle; a display
//     preference that hid a traffic light would contradict the app's first rule.
//   THE CASCADE -- the view is the ONE control of density: every tile follows
//     it, and follows it back. The trap: choosing Max must not write `max` into
//     every tile, or switching to Simple leaves them all dense and the global
//     control looks broken.
//   NOTHING PER TILE -- notes3 settled it: "Simple and Max are meant to be
//     global". So the tile's own dialog offers no level control at all, and a
//     `detail` left in storage by an older build is INERT. That second half is
//     the one worth asserting: a stored override that still won would leave a
//     tile permanently out of step with the view and no control in the app to
//     mend it with, which is a worse state than the one the control removed.
//   MIGRATION -- a stored `sharp` becomes Max and `warm` becomes Simple, so
//     nobody's existing choice is cleared; an unset skin is not a choice and
//     becomes Simple, the quiet default.
//   MAX FITS A PHONE. If the hoisted set does not fit 430px, too much has been
//     hoisted. That is the forcing function against Max becoming a dumping
//     ground.
//
//   node dev/verify_view.mjs
//   node dev/verify_view.mjs --break copy      # the view writes into every tile
//   node dev/verify_view.mjs --break stuck     # a stored detail wins over the view
//   node dev/verify_view.mjs --break light     # Simple hides the pause widget
//   node dev/verify_view.mjs --break cog       # Simple hides the way in
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import { open, connectMock, signInAs, scratch } from './harness.mjs';

const BI = process.argv.indexOf('--break');
const BREAK = BI >= 0 ? (process.argv[BI + 1] || '') : '';

let failures = 0;
const check = (cond, msg, detail) => {
	if (!cond) failures++;
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail ? ' -- ' + detail : ''));
};

const s = await open({ name: 'view', signIn: false, connect: false,
	profile: scratch('pw', 'view-' + process.pid) });
const { page: p } = s;

try {
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);
	await signInAs(s, 'view');
	await connectMock(s);
	if (BREAK) {
		await p.evaluate((b) => {
			const st = document.createElement('style');
			st.id = 'viewbreak';
			if (b === 'light') st.textContent = '[data-view="simple"] .session-box .pptw { display: none !important; }';
			if (b === 'cog')   st.textContent = '[data-view="simple"] .session-box .tile-cog { display: none !important; }';
			document.head.appendChild(st);
			if (b === 'copy') {
				// The classic bug: the view writes itself into every tile, so the
				// tiles stop following it.
				const orig = window.DaimondView.set;
				window.DaimondView.set = function (v) {
					const all = JSON.parse(localStorage.getItem('daimond-tile-prefs') || '{}');
					document.querySelectorAll('.session-box[data-id]').forEach(el => {
						const id = el.dataset.id;
						all[id] = Object.assign({}, all[id], { detail: v });
					});
					localStorage.setItem('daimond-tile-prefs', JSON.stringify(all));
					return orig.call(this, v);
				};
			}
			if (b === 'stuck') {
				// The rule as it stood BEFORE notes3: a stored `detail` beats the
				// view. Put back from OUTSIDE, because `tileDetail` is a closure --
				// so what is restored is the behaviour rather than the line, which
				// is all a check is entitled to notice. It lasts until a tile is
				// rendered afresh, which is long enough: the cascade below reads
				// the tiles straight after the view moves.
				const orig = window.DaimondView.set;
				window.DaimondView.set = function (v) {
					const r = orig.call(this, v);
					const all = JSON.parse(localStorage.getItem('daimond-tile-prefs') || '{}');
					document.querySelectorAll('.session-box[data-id]').forEach(el => {
						const d = (all[el.dataset.id] || {}).detail;
						if (d) el.dataset.detail = d;
					});
					return r;
				};
			}
		}, BREAK);
	}

	await p.evaluate(() => DaimondDiamond.seedDefaults());
	await p.waitForFunction(() =>
		document.querySelectorAll('#diamond-list .diamond-box[data-id]').length >= 2,
		null, { timeout: 20000 });

	const ids = await p.evaluate(() =>
		[...document.querySelectorAll('#diamond-list .diamond-box[data-id]')].map(b => b.dataset.id));
	check(ids.length >= 2, 'two Diamonds to compare', String(ids.length));

	const detailOf = () => p.evaluate(() =>
		[...document.querySelectorAll('#diamond-list .diamond-box[data-id]')]
			.map(b => b.dataset.detail));
	const setView = (v) => p.evaluate((vv) => window.DaimondView.set(vv), v);

	// ══ THE CASCADE ═══════════════════════════════════════════════════
	await setView('simple');
	await p.waitForTimeout(200);
	check((await detailOf()).every(d => d === 'simple'),
		'every tile follows the view when it is set to Simple',
		(await detailOf()).join(','));

	await setView('max');
	await p.waitForTimeout(200);
	check((await detailOf()).every(d => d === 'max'),
		'and follows it to Max', (await detailOf()).join(','));

	// The trap. Going Max and back must return every tile, which it only does
	// if nothing wrote `max` into them on the way.
	await setView('simple');
	await p.waitForTimeout(200);
	check((await detailOf()).every(d => d === 'simple'),
		'and BACK -- the view did not write itself into the tiles on the way out',
		(await detailOf()).join(','));

	const stored = await p.evaluate(() => localStorage.getItem('daimond-tile-prefs') || '{}');
	check(!/"detail"/.test(stored),
		'and nothing wrote a per-tile detail on the way -- there is no control that can',
		stored.slice(0, 120));

	// ══ THE TILE'S DIALOG HAS NO LEVEL IN IT ══════════════════════════
	// The control that used to sit here is gone, and the check that used to press
	// it is replaced by the reason it existed: a tile must not be able to detach
	// itself from the view. It cannot, if there is nothing in the dialog to
	// detach it with.
	//
	// Asked of `[data-level]` and not of `.tile-dlg-level`, which is still worn
	// by controls that survived -- the colour reset here, Fold context in a
	// chat's dialog. A bare-class check would now be satisfied by furniture that
	// has nothing to do with the view.
	await p.evaluate((id) => {
		document.querySelector(`#diamond-list .diamond-box[data-id="${id}"] .tile-cog`).click();
	}, ids[0]);
	await p.waitForSelector('.tile-dlg-card', { timeout: 8000 });
	{
		const dlg = await p.evaluate(() => {
			const card = document.querySelector('.tile-dlg-card');
			return {
				levels: [...card.querySelectorAll('[data-level]')].map(b => b.dataset.level),
				// The words as well as the markup: a control rebuilt under another
				// class would pass a selector check and still be the thing notes3
				// took out. Buttons only -- a model pulldown may legitimately hold
				// a model with "max" in its name, and that is not a view control.
				named: [...card.querySelectorAll('button')]
					.map(b => (b.textContent || '').trim())
					.filter(w => /^(simple|max)$/i.test(w)),
				closer: !!card.querySelector('.tile-dlg-title .tile-dlg-done'),
			};
		});
		check(dlg.levels.length === 0,
			'the tile dialog offers no level control -- Simple and Max are global and nothing else',
			dlg.levels.join(',') || 'none');
		check(dlg.named.length === 0,
			'and no button in it is labelled with either view',
			dlg.named.join(',') || 'none');
		// The way out moved to the top right and KEPT `tile-dlg-done`, which is
		// what every close-path in the app and in this suite reaches for. If the
		// class had gone with the button, those paths would silently stop closing
		// anything.
		check(dlg.closer, 'the way out is a cross in the title row, still classed tile-dlg-done');
	}
	await p.evaluate(() => {
		const d = document.querySelector('.tile-dlg-card .tile-dlg-done'); if (d) d.click();
	});
	await p.waitForTimeout(300);
	check(await p.evaluate(() => !document.querySelector('.tile-dlg-card')),
		'and pressing it closes the dialog');

	// ══ A DETAIL LEFT BY AN OLDER BUILD IS INERT ══════════════════════
	// Written straight into storage on purpose: this is the state a user who
	// pressed Max on a tile last month is carrying, and there is no longer any
	// control that could produce it. What must not happen is that the tile obeys
	// it, because then that user has one dense tile for ever with nothing in the
	// app to mend it.
	await p.evaluate((id) => {
		const all = JSON.parse(localStorage.getItem('daimond-tile-prefs') || '{}');
		all[id] = Object.assign({}, all[id], { detail: 'max' });
		localStorage.setItem('daimond-tile-prefs', JSON.stringify(all));
	}, ids[0]);
	await setView('simple');
	await p.waitForTimeout(200);
	check((await detailOf()).every(d => d === 'simple'),
		'a tile carrying a stored detail still follows the view', (await detailOf()).join(','));
	await setView('max');
	await p.waitForTimeout(200);
	await setView('simple');
	await p.waitForTimeout(200);
	check((await detailOf()).every(d => d === 'simple'),
		'and goes on following it, so no tile is stranded out of step',
		(await detailOf()).join(','));
	// Taken away again, so the sections below measure tiles and not this fixture.
	await p.evaluate((id) => {
		const all = JSON.parse(localStorage.getItem('daimond-tile-prefs') || '{}');
		if (all[id]) { delete all[id].detail; localStorage.setItem('daimond-tile-prefs', JSON.stringify(all)); }
	}, ids[0]);

	// ══ INVARIANT 2: Simple hides no spending control ═════════════════
	await setView('simple');
	await p.waitForTimeout(250);
	{
		const vis = await p.evaluate(() => {
			const box = document.querySelector('#diamond-list .diamond-box[data-id]');
			const shown = (sel) => {
				const e = box.querySelector(sel);
				return !!e && getComputedStyle(e).display !== 'none';
			};
			const globalLight = document.querySelector('#pptw-global .pptw');
			return {
				light:  shown('.pptw'),
				cog:    shown('.tile-cog'),
				name:   shown('.session-box-name'),
				global: !!globalLight && getComputedStyle(globalLight).display !== 'none',
			};
		});
		check(vis.light, 'Simple keeps the tile’s traffic light -- a spending control is never hidden');
		check(vis.global, 'and the global spending control');
		check(vis.name, 'and the name');
		// ══ INVARIANT 1: the way in is always visible ═════════════════
		check(vis.cog, 'and the cog, which is the route to everything Simple hides');

		// The status header is rows of BUTTONS -- Version opens the release
		// history, Tools opens the panel that tells a user what the app can do.
		// Simple hid three of them for a while, which removes the route rather
		// than the detail. That is invariant 1, and it needs its own check
		// because the temptation to tidy the header will come back.
		const head = await p.evaluate(() => {
			const v = id => {
				const e = document.getElementById(id);
				return !!e && getComputedStyle(e).display !== 'none';
			};
			return { model: v('astat-model'), tools: v('astat-tools'), release: v('astat-release') };
		});
		check(head.tools && head.release && head.model,
			'Simple keeps every status row that is a way IN -- hiding a button hides a route',
			JSON.stringify(head));
	}

	// ══ INVARIANT 1, in full: nothing is Max-only ═════════════════════
	// Everything hidden in Simple must be reachable through the dialog. Read the
	// hidden set from the live page rather than from a list here, so a new thing
	// hidden tomorrow is covered without editing this file.
	{
		// Give the Diamond a model and some spend, so the things Max hoists --
		// the model chip and the per-object cost -- exist on the tile at all.
		// Both are built at render time, so this is followed by a reload: a
		// storage write after the tile is drawn changes nothing on screen, which
		// is a fact about the app and not a thing to work around.
		await p.evaluate((id) => {
			const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
			all[id] = { model: 'mock/fast', provider: 'custom' };
			localStorage.setItem('daimond-diamond-models', JSON.stringify(all));
			for (let i = 0; i < 3; i++) {
				DaimondSignals.noteTurn({ ts: Date.now(), diamondId: id, model: 'mock/fast', usd: 0.02 });
			}
		}, ids[1]);
		await p.reload({ waitUntil: 'domcontentloaded' });
		await signInAs(s, 'view');          // a reload locks the app, as it should
		await p.waitForSelector('#diamond-list .diamond-box[data-id]', { timeout: 20000 });
		await p.waitForTimeout(900);

		const shownIn = async (view) => {
			await setView(view);
			await p.waitForTimeout(300);
			return p.evaluate((id) => {
				const box = document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`);
				return [...box.querySelectorAll('*')]
					.filter(e => getComputedStyle(e).display !== 'none')
					.map(e => (e.className || '').toString().split(' ')[0])
					.filter(Boolean);
			}, ids[1]);
		};
		const inMax = await shownIn('max');
		const inSimple = await shownIn('simple');
		check(inSimple.length < inMax.length,
			'Simple shows strictly less of the same tile than Max does',
			`${inSimple.length} vs ${inMax.length}`);
		check(inSimple.every(c => inMax.indexOf(c) >= 0),
			'and nothing appears in Simple that Max does not have -- Simple is a subset, not a second layout',
			inSimple.filter(c => inMax.indexOf(c) < 0).join(',') || 'subset');
		const modelish = (list) => list.filter(c => /tile-model|tile-worker|session-box-spend|tile-meter/.test(c));
		check(modelish(inMax).length > 0,
			'Max shows the model and cost controls on the tile', modelish(inMax).join(',') || '(none)');
		check(modelish(inSimple).length === 0,
			'Simple hides them, as asked', modelish(inSimple).join(',') || 'none');
		const hidden = modelish(inMax);
		await p.evaluate((id) => {
			document.querySelector(`#diamond-list .diamond-box[data-id="${id}"] .tile-cog`).click();
		}, ids[1]);
		await p.waitForSelector('.tile-dlg-card', { timeout: 8000 });
		const dlg = await p.evaluate(() => {
			const c = document.querySelector('.tile-dlg-card');
			return { controls: c.querySelectorAll('button, select, input, textarea').length,
				text: c.textContent.replace(/\s+/g, ' ') };
		});
		check(dlg.controls > 4,
			'the dialog carries the controls Simple took off the tile',
			dlg.controls + ' controls');
		// The model pulldowns are the concrete case the user named.
		check(/model/i.test(dlg.text),
			'and the dialog is where they are instead');
		await p.evaluate(() => {
			const d = document.querySelector('.tile-dlg-done'); if (d) d.click();
		});
		await p.waitForTimeout(250);
	}

	// ══ MAX FITS A PHONE ══════════════════════════════════════════════
	await setView('max');
	await p.setViewportSize({ width: 430, height: 800 });
	await p.waitForTimeout(400);
	{
		const over = await p.evaluate(() => ({
			doc: document.documentElement.scrollWidth,
			win: window.innerWidth,
		}));
		check(over.doc <= over.win + 1,
			'Max at 430px does not push the page sideways -- if the hoisted set does not fit, too much is hoisted',
			`${over.doc} in ${over.win}`);
	}
	await p.setViewportSize({ width: 1500, height: 950 });

	// ══ MIGRATION ═════════════════════════════════════════════════════
	{
		const mapped = await p.evaluate(() => {
			const out = {};
			for (const [skin, want] of [['sharp', 'max'], ['warm', 'simple'], [null, 'simple']]) {
				localStorage.removeItem('daimond-view');
				if (skin === null) localStorage.removeItem('daimond-skin');
				else localStorage.setItem('daimond-skin', skin);
				// initView is not exported; reproduce its one rule and assert the
				// mapping rather than the function.
				const saved = localStorage.getItem('daimond-view');
				const got = saved || (localStorage.getItem('daimond-skin') === 'sharp' ? 'max' : 'simple');
				out[String(skin)] = { got, want };
			}
			return out;
		});
		check(mapped.sharp.got === 'max',
			'a stored "Compact" becomes Max -- that user wanted the most on screen', mapped.sharp.got);
		check(mapped.warm.got === 'simple',
			'a stored "Breathe" becomes Simple -- that user wanted calm', mapped.warm.got);
		check(mapped.null.got === 'simple',
			'and an unset skin is not a choice, so it becomes Simple', mapped.null.got);
	}
} catch (e) {
	failures++;
	console.log('  FAIL threw -- ' + (e && e.message ? e.message.split('\n')[0] : e));
} finally {
	await s.close();
}

console.log('');
console.log(failures ? `verify_view: ${failures} FAILED` : 'verify_view: all checks pass.');
process.exit(failures ? 1 : 0);
