// verify_diamondmodels.mjs — phase D: the models a Diamond runs on, and the fold.
//
// Five properties, each one a thing notes2 asks for and none of which could be
// seen from the app before this phase:
//
//   1. A Diamond SHOWS the model it thinks with. It has been stored since
//      Diamonds had models and drawn nowhere, so two Diamonds deliberately put
//      on different models were indistinguishable on the rail.
//   2. Changing the daimon's model is confirmed, takes effect, and is written
//      into the crystal's own version history — the discontinuity notes2 calls
//      "a fold and a new daimon". A REFUSED confirm changes nothing, which is
//      the half a dialog usually gets wrong.
//   3. The secondary is a map keyed by modality. A task naming an image is
//      dispatched on the vision model; a task naming none is not. Measured from
//      the RUN, which is what carries the model and the key, rather than from
//      the pulldown that was set.
//   4. The context meter says where the fold happens. The number is `FOLD_AT`
//      in compact.rs and has never been anywhere a user could see it.
//   5. The fold can be asked for, and reports honestly when there is nothing to
//      fold. That a hand fold does not SHRINK the window is proved in Rust, where
//      the window lives — `learn_from_refusal` moves it down and never up, so a
//      hand fold routed through the refusal arm would cost a quarter of the
//      context every three presses, and no screenshot of a meter can tell a
//      window that shrank from a conversation that grew.
//
//   node dev/verify_diamondmodels.mjs
//   node dev/verify_diamondmodels.mjs --break novision   # dispatch ignores modality
//   node dev/verify_diamondmodels.mjs --break nomark     # the meter loses the fold mark
//   node dev/verify_diamondmodels.mjs --break noconfirm  # the model changes unasked
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { open, newChat, connectMock, scratch, shot } from './harness.mjs';

// The mock offers three models, and exactly one of them is in the price TABLE with
// a context window. That is the one this run connects under, because `mock/fast`
// has no published window: the meter is then not drawn at all, and the checks on
// the fold mark would pass vacuously against a meter that is not there.
const MODEL = 'accounts/fireworks/models/glm-5p2';

const OUT = path.join(os.homedir(), '.cache/daimond/diamondmodels-shots');
fs.mkdirSync(OUT, { recursive: true });

// `--break x` or `--break=x`. The index form has to be guarded: `indexOf` of an
// absent flag is -1, and -1 + 1 is 0, which is the path to node.
const BI = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

/// The topmost visible dialog card.
///
/// NOT the first: the tile dialog's own card also carries `.dlg-card`, and its
/// Done button also carries `.dlg-cancel` — so `find(first visible)` reaches past
/// a confirm that is drawn over it and presses Done on the dialog underneath,
/// which closes the wrong thing and leaves the confirm standing.
/// Make a Diamond through the dialog a person uses.
async function create(p, name) {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')]
			.filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	await p.waitForTimeout(900);
}

/// Open a Diamond tile's cog dialog by the Diamond's name.
async function openCog(p, name) {
	const found = await p.evaluate((nm) => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === nm);
		if (!box) return false;
		const cog = box.querySelector('.tile-cog');
		if (!cog) return false;
		cog.click();
		return true;
	}, name);
	if (!found) return false;
	await p.waitForSelector('.tile-dlg-card', { timeout: 8000 });
	return true;
}

const closeDialogs = (p) => p.evaluate(() => {
	document.querySelectorAll('.tile-dlg .tile-dlg-done, .dlg-card .dlg-cancel')
		.forEach(b => { try { b.click(); } catch {} });
});

/// Set a tile's detail through the dialog a person uses: the cog, then Simple or
/// Max. Not by writing `localStorage` and reloading — the reload was costing the
/// wasm a fresh boot on every check, and what is under test here is the rail as
/// the user sees it change, which `applyTileDetail` does live.
async function setDetail(p, box, level) {
	const opened = await p.evaluate((sel) => {
		const b = document.querySelector(sel);
		const cog = b && b.querySelector('.tile-cog');
		if (!cog) return false;
		cog.click();
		return true;
	}, box);
	if (!opened) return false;
	await p.waitForSelector('.tile-dlg-card', { timeout: 8000 });
	await p.evaluate((lv) => {
		const card = document.querySelector('.tile-dlg-card');
		const b = [...card.querySelectorAll('.tile-dlg-level[data-level]')]
			.find(x => x.dataset.level === lv);
		if (b) b.click();
	}, level);
	await p.waitForTimeout(250);
	return true;
}

const s = await open({ name: 'diamondmodels', profile: scratch('pw', 'models-' + process.pid) });
const { page: p } = s;
try {
	await connectMock(s, { model: MODEL });

	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);
	if (BREAK === 'novision') {
		// Exactly the pre-phase-D dispatch: one model for the whole fan-out,
		// modality ignored. Applied to the live rule, so what is disabled is the
		// thing under test rather than a flag beside it.
		await p.evaluate(() => {
			const W = window.DaimondWorkers;
			W.routeFor = function (task, text) {
				return { provider: text.provider || '', model: text.model || '', sees: false };
			};
		});
	}
	if (BREAK === 'nomark') {
		await p.addStyleTag({ content: '.tile-ctx-fold { display: none !important; }' });
	}
	// ══ 1. A Diamond shows its model ══════════════════════════════════
	await create(p, 'Dee');
	const dId = await p.evaluate(() =>
		([...document.querySelectorAll('#diamond-list .diamond-box')]
			.find(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === 'Dee') || {}).dataset?.id || '');
	check(!!dId, 'the Diamond was made', dId);
	const dSel = `#diamond-list .diamond-box[data-id="${dId}"]`;
	check(await setDetail(p, dSel, 'max'), 'the tile dialog opens from the cog');

	const chip = await p.evaluate((sel) => {
		const c = document.querySelector(sel + ' .tile-model-chip.diamond-model');
		if (!c) return null;
		return { text: (c.textContent || '').trim(), title: c.title || '',
			shown: c.getClientRects().length > 0 };
	}, dSel);
	check(chip !== null, 'the Diamond tile carries a model chip');
	check(!!(chip && chip.shown && chip.text), 'the chip is drawn and says something',
		chip && chip.text);
	check(!!(chip && chip.title.includes(MODEL)),
		'the chip names the full model, not only the short form', chip && chip.title);

	// ── And Simple hides it, because a model is detail. ──
	await setDetail(p, dSel, 'simple');
	const hidden = await p.evaluate((sel) => {
		const c = document.querySelector(sel + ' .tile-model-chip.diamond-model');
		return !c || c.getClientRects().length === 0;
	}, dSel);
	check(hidden, 'Simple hides the model chip with the other model controls');
	await setDetail(p, dSel, 'max');
	await closeDialogs(p);
	await p.waitForTimeout(300);

	if (BREAK === 'noconfirm') {
		// A dialog that applies a choice the moment the pulldown moves — the common
		// shape, and the one this phase deliberately does not have, because changing
		// a daimon's model ends one daimon and starts another. Installed HERE rather
		// than at the top: an auto-answering observer that runs from the start
		// answers the New Diamond dialog too, and then what fails is the setup.
		await p.evaluate(() => {
			new MutationObserver(() => {
				document.querySelectorAll('.dlg-card .dlg-ok').forEach(b => {
					if (!b.closest('.tile-dlg-card')) b.click();
				});
			}).observe(document.body, { childList: true, subtree: true });
		});
	}

	// ══ 2. The daimon's model changes, and it is recorded ═════════════
	check(await openCog(p, 'Dee'), 'the cog opens the tile dialog');
	const rows = await p.evaluate(() => {
		const card = document.querySelector('.tile-dlg-card');
		return [...card.querySelectorAll('.tile-dlg-model')].map(r => ({
			label: (r.querySelector('.tile-model-chip') || {}).textContent || '',
			options: [...(r.querySelector('select') || { options: [] }).options].map(o => o.value),
		}));
	});
	check(rows.length === 3, 'three model rows: daimon, workers, workers-images', rows.length);
	check(rows.length === 3 && rows[1].options[0] === '' && rows[2].options[0] === '',
		'the two worker rows offer "same as the text model" as a real choice');

	// A second model to move to. The mock serves whatever it is asked for, so any
	// second name in the pulldown will do.
	const other = await p.evaluate(() => {
		const sel = document.querySelector('.tile-dlg-card .tile-dlg-model select');
		const opts = [...sel.options].map(o => o.value).filter(Boolean);
		return opts.find(v => v !== sel.value) || '';
	});
	if (!other) {
		console.log('  ..   only one model is configured; the change checks are skipped');
	} else {
		// ── The refused confirm changes NOTHING. ──
		const before = await p.evaluate((id) =>
			(JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[id] || {}).model || '', dId);
		const move = (v) => p.evaluate((val) => {
			const sel = document.querySelector('.tile-dlg-card .tile-dlg-model select');
			sel.value = val;
			sel.dispatchEvent(new Event('change', { bubbles: true }));
		}, v);
		/// Wait for a confirm drawn OVER the tile dialog, and answer it.
		///
		/// Reported as a failed check rather than thrown: "the model changed with
		/// nothing asked" is the defect this section exists to catch, and a bare
		/// selector timeout names neither the property nor the cause.
		async function answerConfirm(which) {
			try {
				await p.waitForFunction(() =>
					[...document.querySelectorAll('.dlg-card')]
						.filter(c => c.getClientRects().length && !c.classList.contains('tile-dlg-card'))
						.length > 0, null, { timeout: 6000 });
			} catch { return false; }
			await p.evaluate((sel) => {
				const card = [...document.querySelectorAll('.dlg-card')]
					.filter(c => c.getClientRects().length && !c.classList.contains('tile-dlg-card')).pop();
				card.querySelector(sel).click();
			}, which);
			await p.waitForTimeout(800);
			return true;
		}

		await move(other);
		const asked = await answerConfirm('.dlg-cancel');
		check(asked, 'changing the daimon\'s model asks first');
		const afterNo = await p.evaluate((id) =>
			(JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[id] || {}).model || '', dId);
		check(afterNo === before, 'a refused confirm leaves the model where it was',
			`${before} → ${afterNo}`);
		const putBack = await p.evaluate(() =>
			(document.querySelector('.tile-dlg-card .tile-dlg-model select') || {}).value || '');
		check(putBack === before, 'and puts the pulldown back, rather than showing a change it did not make',
			putBack);

		// ── The accepted confirm changes the model. ──
		await move(other);
		await answerConfirm('.dlg-ok');
		const afterYes = await p.evaluate((id) =>
			(JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[id] || {}).model || '', dId);
		check(afterYes === other, 'an accepted confirm moves the daimon to the new model',
			`${before} → ${afterYes}`);

		// ── And it is written into the crystal's own history, which is what
		// notes2 means by "it requires a fold and a new daimon": a change that
		// only flipped a browser setting would leave the Diamond with no record
		// that its daimon is not the one that wrote the crystal above it. ──
		await closeDialogs(p);
		await p.waitForTimeout(400);
		await p.evaluate((sel) => { document.querySelector(sel).click(); }, dSel);
		await p.waitForTimeout(900);
		const opened = await p.evaluate(() => {
			const b = [...document.querySelectorAll('.crystal-act')]
				.find(x => /history/i.test(x.textContent || ''));
			if (!b) return false;
			b.click();
			return true;
		});
		check(opened, 'the crystal has a history to open');
		await p.waitForTimeout(900);
		const hist = await p.evaluate(() => [...document.querySelectorAll('.hist-row')].map(r => ({
			kind: (r.querySelector('.hist-kind') || {}).textContent || '',
			note: (r.querySelector('.hist-note') || {}).textContent || '',
		})));
		const mrow = hist.find(h => h.kind.trim() === 'model');
		check(!!mrow, 'the model change is a version in the crystal\'s history',
			hist.map(h => h.kind.trim()).join(', ') || '(no rows)');
		check(!!(mrow && /moved from .* to /i.test(mrow.note)),
			'and the row says which model it moved from and to',
			mrow && mrow.note);
		await shot(s, 'history');
	}
	await closeDialogs(p);

	// ══ 3. The secondary is keyed by modality ═════════════════════════
	// Asked of `Workers.routeFor`, which is the function `dispatch` itself calls —
	// not a copy of the rule written here. A rule about how money is spent that
	// could only be observed by spending it would be checked by nobody.
	const routed = await p.evaluate(() => {
		const W = window.DaimondWorkers;
		if (!W || !W.routeFor) return null;
		const text = { provider: 'p', model: 'the-text-one' };
		const eyes = { provider: 'p', model: 'the-eyes-one' };
		const r = (task, supplied) => W.routeFor(task, text, eyes, !!supplied);
		return {
			plain:    r('read src/main.rs and summarise it'),
			image:    r('look at shots/home.png and say what is wrong'),
			jpeg:     r('compare a.jpg with b.jpeg'),
			gif:      r('what happens in loop.gif'),
			webp:     r('open hero.webp'),
			nearMiss: r('read notes.pngx, it is not an image'),
			tiff:     r('open scan.tiff'),
			supplied: r('look at shots/home.png', true),
		};
	});
	if (!routed) {
		check(false, 'the dispatch routing rule can be asked about without dispatching');
	} else {
		check(routed.plain.model === 'the-text-one',
			'a task naming no image runs on the text model', routed.plain.model);
		check(routed.image.model === 'the-eyes-one',
			'a task naming a .png runs on the image model', routed.image.model);
		check(routed.jpeg.model === 'the-eyes-one' && routed.gif.model === 'the-eyes-one'
			&& routed.webp.model === 'the-eyes-one',
			'.jpg, .jpeg, .gif and .webp count as images — exactly what ImageMedia sniffs');
		check(routed.tiff.model === 'the-text-one',
			'a format this app cannot hand a model as an image is not one', routed.tiff.model);
		check(routed.nearMiss.model === 'the-text-one',
			'an extension that merely starts with an image name is not one', routed.nearMiss.model);
		check(routed.supplied.model === 'the-text-one' && routed.supplied.sees === false,
			'a model supplied for the whole fan-out is not second-guessed by modality',
			routed.supplied.model);

		// ── And through the store: with no image model set, an image task falls
		// back to the TEXT worker model rather than failing — §1.4's stated
		// behaviour — and still records that it was an image task, so the
		// fallback shows on the run instead of looking chosen. ──
		const fell = await p.evaluate((id) => {
			const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
			all[id] = Object.assign({}, all[id], { visionProvider: '', visionModel: '' });
			localStorage.setItem('daimond-diamond-models', JSON.stringify(all));
			const W = window.DaimondWorkers;
			return {
				img:   W.routeForDiamond(id, 'look at shots/home.png'),
				plain: W.routeForDiamond(id, 'read main.rs'),
			};
		}, dId);
		check(!!fell.img.model && fell.img.model === fell.plain.model,
			'with no image model set, an image task falls back to the text model',
			fell.img.model);
		check(fell.img.sees === true && fell.plain.sees === false,
			'and the run still records which of the two it was', String(fell.img.sees));
	}

	// ══ 4. The meter says where the fold happens ══════════════════════
	await newChat(s);
	await p.fill('#chat-input', 'hello');
	await p.click('#chat-send');
	await p.waitForTimeout(2500);
	// Max, or the meter is hidden by the detail CSS rather than absent.
	const cId = await p.evaluate(() =>
		(document.querySelector('#session-list .chat-box') || {}).dataset?.id || '');
	const cSel = `#session-list .chat-box[data-id="${cId}"]`;
	await setDetail(p, cSel, 'max');
	await closeDialogs(p);
	await p.waitForTimeout(300);

	const meter = await p.evaluate(() => {
		const bar = document.querySelector('#session-list .chat-box .tile-ctx-bar');
		if (!bar) return null;
		const mark = bar.querySelector('.tile-ctx-fold');
		const ctx = bar.closest('.tile-ctx');
		return {
			hasMark: !!mark,
			left: mark ? mark.style.left : '',
			drawn: mark ? mark.getClientRects().length > 0 : false,
			title: ctx ? (ctx.title || '') : '',
		};
	});
	if (meter === null) {
		console.log('  ..   this model publishes no window, so there is no meter to mark');
	} else {
		check(meter.hasMark, 'the context bar carries a fold mark');
		check(meter.drawn, 'the fold mark is actually drawn', meter.left);
		check(/^\d+%$/.test(meter.left) && parseInt(meter.left, 10) > 0
			&& parseInt(meter.left, 10) < 100,
			'the mark sits inside the bar at the fold fraction', meter.left);
		check(/\bFolds at\b|\d+%/.test(meter.title),
			'and the meter says so in words as well as in ink', meter.title);
	}
	await shot(s, 'meter');

	// ══ 5. A fold the user can ask for, that reports honestly ═════════
	//
	// That a hand fold does not SHRINK the window is proved in Rust, where the
	// window lives (`test_a_hand_fold_leaves_the_window_where_it_was_00`). What
	// only the browser can prove is that the control exists, is reachable, and
	// tells the truth about a conversation too short to fold — the failure mode
	// of every "do it now" button ever written.
	const cogOpened = await p.evaluate((id) => {
		const box = document.querySelector(`#session-list .chat-box[data-id="${id}"]`);
		const cog = box && box.querySelector('.tile-cog');
		if (!cog) return false;
		cog.click();
		return true;
	}, cId);
	check(cogOpened, 'the chat tile has a cog');
	await p.waitForSelector('.tile-dlg-card', { timeout: 8000 });
	const ctxSec = await p.evaluate(() => {
		const card = document.querySelector('.tile-dlg-card');
		const heads = [...card.querySelectorAll('.tile-dlg-head')].map(h => h.textContent.trim());
		const btn = [...card.querySelectorAll('.tile-dlg-level')]
			.find(b => /fold/i.test(b.textContent || ''));
		const notes = [...card.querySelectorAll('.tile-dlg-note')].map(n => n.textContent.trim());
		return { heads, hasBtn: !!btn, notes };
	});
	check(ctxSec.heads.some(h => /context/i.test(h)),
		'the chat dialog has a Context section', ctxSec.heads.join(' | '));
	check(ctxSec.hasBtn, 'and a control that folds it now');
	check(ctxSec.notes.some(n => /folds at \d+%/i.test(n)),
		'which says where the fold happens, in words',
		ctxSec.notes.find(n => /folds/i.test(n)) || ctxSec.notes.join(' | '));

	// ── Press it on a one-turn conversation. There is no tail to cut below
	// MIN_KEEP_MESSAGES, so the honest answer is that nothing moved. ──
	await p.evaluate(() => {
		const card = document.querySelector('.tile-dlg-card');
		[...card.querySelectorAll('.tile-dlg-level')]
			.find(b => /fold/i.test(b.textContent || '')).click();
	});
	await p.waitForSelector('.dlg-card .dlg-ok', { timeout: 8000 });
	await p.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')]
			.filter(c => c.getClientRects().length).pop();
		card.querySelector('.dlg-ok').click();
	});
	await p.waitForTimeout(2500);
	const said = await p.evaluate(() =>
		[...document.querySelectorAll('.toast, .toast-msg, [class*="toast"]')]
			.map(n => (n.textContent || '').trim()).filter(Boolean).join(' | '));
	check(/nothing to fold|already as short/i.test(said),
		'a fold of a conversation that cannot be folded says so', said || '(nothing said)');
	// And the transcript is not quietly shorter for having pressed it.
	const foldRows = await p.evaluate(() =>
		document.querySelectorAll('.chat-msg-compacted').length);
	check(foldRows === 0, 'and no fold notice was written for a fold that did not happen',
		String(foldRows));
	await shot(s, 'fold-dialog');
	await closeDialogs(p);

} catch (e) {
	check(false, 'the run finished', String(e && e.message || e));
	try { await shot(s, 'threw'); } catch {}
} finally {
	await s.close();
}

console.log(failures === 0
	? `\nverify_diamondmodels: all checks pass.`
	: `\nverify_diamondmodels: ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
