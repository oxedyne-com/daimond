// verify_diamondmodels.mjs — phase D: the models a Diamond runs on, and the fold.
//
// Five properties, each one a thing notes2 asks for and none of which could be
// seen from the app before this phase:
//
//   1. A Diamond SHOWS the model it thinks with. It has been stored since
//      Diamonds had models and drawn nowhere, so two Diamonds deliberately put
//      on different models were indistinguishable on the rail.
//   2. Changing the daimon's model is a deliberate two-step: the pulldown reveals
//      a "Change" button ONLY while the pick differs, and pressing it takes effect,
//      is written into the crystal's own version history — the discontinuity notes2
//      calls "a fold and a new daimon" — and LEAVES THE CONVERSATION WHERE IT IS.
//      There is no confirm, and the absence is the property: the modal that stood
//      here warned that the thread would not carry over, which was true for the
//      twenty-two minutes before a daimon had a thread at all. So the two halves are
//      checked together, because either one alone can be satisfied by the wrong
//      thing: a confirm nobody answers also leaves the session intact, and a silent
//      handler that empties it also asks nothing.
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
//   node dev/verify_diamondmodels.mjs --break wipes      # the model change empties the session
//   node dev/verify_diamondmodels.mjs --break asks       # the confirm comes back
//   node dev/verify_diamondmodels.mjs --break appguard   # the fold asks for an engine again
//   node dev/verify_diamondmodels.mjs --break refuses    # the fold refuses before it asks
//
// `wipes` and `asks` are SOURCE breaks: the handler they target is a closure inside
// daimond.js and cannot be reached from the page, so the file is patched in memory
// and served through `page.route` — the same trick verify_daimonface.mjs uses. Each
// one asserts its anchor lands exactly once; an anchor that has drifted is a break
// that quietly stopped applying, and a green run under it would prove nothing.
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { open, newChat, connectMock, scratch, shot, signInAs, steerDiamond, storedChats } from './harness.mjs';

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

// ── The two source breaks ────────────────────────────────────────────
//
// Both live in the daimon's model-change handler, which is a closure: nothing the
// page can reach from outside gets at it, so the only honest way to break it is to
// serve a different file.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = 'js/daimond.js';
const SRC_BREAKS = {
	// THE LOSS THE OLD CONFIRM WARNED ABOUT, made real: the conversation discarded as
	// the model moves. Both halves of it, because the two are stored separately and a
	// break that took only one would leave the other check green on a conversation
	// half gone -- the model's own copy, which is what the next turn carries, and the
	// transcript the reader is looking at.
	wipes: {
		find: "\t\t\tresetDiamondApps();\n\t\t\tvar logged = true;",
		with: "\t\t\tresetDiamondApps();\n"
			+ "\t\t\tvar _lost = (chats || []).find(function (c) { return c.diamondId === opts.id; });\n"
			+ "\t\t\tif (_lost) {\n"
			+ "\t\t\t\t_lost.messages = [];\n"
			+ "\t\t\t\t_lost.session = { v: 1, msgs: [], upto: '', uptoTs: 0 };\n"
			+ "\t\t\t\tpersistChats();\n"
			+ "\t\t\t\tif (current && current.id === _lost.id) renderHistory(_lost.messages);\n"
			+ "\t\t\t}\n"
			+ "\t\t\tvar logged = true;",
	},
	// THE OLD FOLD GUARD, restored: `chat.app`, which asks whether an engine was built
	// during THIS page load and not whether anything was ever said. After a reload it
	// is null for every chat there is, so a thread of any length is refused.
	appguard: {
		find: "\t\tif (!chatSaid(chat)) { toast(t('tile.fold_unavailable'), true); return; }",
		with: "\t\tvar _a = chat.app;\n"
			+ "\t\tif (!_a || typeof _a.fold_now !== 'function') {\n"
			+ "\t\t\ttoast(t('tile.fold_unavailable'), true); return;\n"
			+ "\t\t}",
	},
	// THE FOLD REFUSING BEFORE IT ASKS, which is the shape that trashed a chat.
	// `appguard` above produces it only after a reload; this one produces it on the
	// first press, where section 5a stands. It is here so the SCOPING in 5a and 5b is
	// held by something: unscoped, this break does not merely fail, it deletes the
	// conversation the rest of the section is about and then reports on what is left.
	refuses: {
		find: "\t\tif (!chatSaid(chat)) { toast(t('tile.fold_unavailable'), true); return; }",
		with: "\t\tif (true) { toast(t('tile.fold_unavailable'), true); return; }",
	},
	// The confirm back, in its plainest form. Nothing answers it, so the model does
	// not move either — which is the point: a confirm is a thing that stands there.
	// It now lives on the Change button's click, where the switch was moved.
	asks: {
		find: "\t\t\tsetDiamondModel(opts.id, { provider: p.provider, model: p.model });",
		with: "\t\t\tvar _ok = await confirmDialog('Change the model?', 'Change',\n"
			+ "\t\t\t\t{ title: 'Change the daimon', danger: false });\n"
			+ "\t\t\tif (!_ok) return;\n"
			+ "\t\t\tsetDiamondModel(opts.id, { provider: p.provider, model: p.model });",
	},
};
let patched = null;
if (SRC_BREAKS[BREAK]) {
	const spec = SRC_BREAKS[BREAK];
	patched = fs.readFileSync(path.join(HERE, '..', 'www', SRC), 'utf8');
	const n = patched.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${SRC}, so nothing was `
			+ 'broken and the run below would prove nothing. The file has moved on; move the '
			+ 'anchor with it.\n  ' + spec.find.split('\n')[0].trim());
		process.exit(2);
	}
	patched = patched.replace(spec.find, spec.with);
}

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

/// Close whatever dialogs are standing. The tile dialog's way out is the closer
/// cross, which still carries `tile-dlg-done` — that class means "the control
/// that finishes with this dialog" and never meant the word Done, so this path
/// is unchanged by the cross replacing the button.
const closeDialogs = (p) => p.evaluate(() => {
	document.querySelectorAll('.tile-dlg .tile-dlg-done, .dlg-card .dlg-cancel')
		.forEach(b => { try { b.click(); } catch {} });
});

/// How much every tile draws. Simple and Max are global (notes3), so this is one
/// call and not a visit to each tile's dialog: the per-tile level control is
/// gone. Set live rather than by writing `localStorage` and reloading — the
/// reload was costing the wasm a fresh boot on every check, and what is under
/// test here is the rail as the user sees it change.
async function setView(p, level) {
	await p.evaluate((lv) => window.DaimondView.set(lv), level);
	await p.waitForTimeout(250);
}

/// Open one tile's dialog from its cog. False when that tile has no cog, which
/// is a failure worth naming rather than a selector timeout.
async function openTile(p, box) {
	const opened = await p.evaluate((sel) => {
		const b = document.querySelector(sel);
		const cog = b && b.querySelector('.tile-cog');
		if (!cog) return false;
		cog.click();
		return true;
	}, box);
	if (!opened) return false;
	await p.waitForSelector('.tile-dlg-card', { timeout: 8000 });
	return true;
}

const s = await open({
	name: 'diamondmodels', profile: scratch('pw', 'models-' + process.pid),
	route: patched ? async (page) => {
		await page.route('**/' + SRC, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body: patched,
		}));
	} : null,
});
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
	check(await openTile(p, dSel), 'the tile dialog opens from the cog');
	await closeDialogs(p);
	await setView(p, 'max');

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
	await setView(p, 'simple');
	const hidden = await p.evaluate((sel) => {
		const c = document.querySelector(sel + ' .tile-model-chip.diamond-model');
		return !c || c.getClientRects().length === 0;
	}, dSel);
	check(hidden, 'Simple hides the model chip with the other model controls');
	await setView(p, 'max');
	await p.waitForTimeout(300);

	// ══ 2. The model changes on Change, and the thread comes with it ═══
	//
	// GIVE THE DAIMON A CONVERSATION FIRST. Without one, "the session is the same
	// length afterwards" is 0 === 0 — a check with no subject, which passes against
	// anything, including a handler that empties the session on its way past.
	await p.evaluate((sel) => { document.querySelector(sel).click(); }, dSel);
	await p.waitForTimeout(900);
	await steerDiamond(s, 'remember this sentence');
	await p.waitForSelector('.chat-spinner', { state: 'detached', timeout: 40000 }).catch(() => {});
	await p.waitForTimeout(1200);
	/// How many messages the MODEL's own copy of this daimon's conversation holds.
	///
	/// Read from IndexedDB rather than from the screen: `session.msgs` is what the next
	/// turn is built from and carries the provider's tool-call ids, and it is invisible
	/// from the transcript either way. The transcript is the other half of the same
	/// claim and is checked beside it.
	const sessLen = async () => {
		const all = await storedChats(s);
		const rec = (all || []).find(c => c && c.diamondId === dId);
		return rec ? (((rec.session || {}).msgs) || []).length : -1;
	};
	const sessBefore = await sessLen();
	check(sessBefore > 0, 'the daimon has a conversation, so what follows has a subject',
		'session msgs: ' + sessBefore);

	check(await openCog(p, 'Dee'), 'the cog opens the tile dialog');
	// The label is a real `<label>` now, bound to its pulldown by `for`/`id`.
	// It used to wear `.tile-model-chip`, which is the mono pill a model NAME is
	// drawn in on the tile — so three form labels looked like three values, and
	// the word did not focus the control it named.
	const rows = await p.evaluate(() => {
		const card = document.querySelector('.tile-dlg-card');
		return [...card.querySelectorAll('.tile-dlg-model')].map(r => {
			const lab = r.querySelector('label.tile-dlg-label');
			const sel = r.querySelector('select');
			return {
				label: lab ? (lab.textContent || '').trim() : '',
				// Which of the three settings this row IS, taken from the control's
				// own id rather than from the row's position: a row list read by
				// index says nothing about which setting moved when one is added.
				which: sel ? (/(daimon|workers|vision)/.exec(sel.id) || [''])[0] : '',
				bound: !!(lab && sel && lab.htmlFor && lab.htmlFor === sel.id),
				options: [...((sel || { options: [] }).options)].map(o => o.value),
			};
		});
	});
	const rowFor = (w) => rows.find(r => r.which === w);
	check(['daimon', 'workers', 'vision'].every(w => !!rowFor(w)),
		'the dialog carries a row for each of the three settings: the daimon, the workers, and the workers’ eyes',
		rows.map(r => r.which || '(unnamed)').join(', '));
	check(rows.length > 0 && rows.every(r => r.label && r.bound),
		'each is a real label bound to its own pulldown, so the word focuses the control it names',
		JSON.stringify(rows.map(r => [r.label, r.bound])));
	check(!!rowFor('workers') && !!rowFor('vision')
		&& rowFor('workers').options.includes('') && rowFor('vision').options.includes(''),
		'the two worker rows offer "same as the text model" as a real choice, which is what absent MEANS here');

	// Each of the three reads below reaches the DAIMON's pulldown by the setting
	// it carries -- `/daimon/` in the control's own id -- rather than by taking
	// the first row on screen. The daimon is the only one of the three written
	// into the crystal's history, so a check that found a row by position would
	// end up asserting that against a setting which deliberately has none.

	// A second model to move to. The mock serves whatever it is asked for, so any
	// second name in the pulldown will do.
	const other = await p.evaluate(() => {
		const sel = [...document.querySelectorAll('.tile-dlg-card .tile-dlg-model select')]
			.find(s => /daimon/.test(s.id));
		if (!sel) return '';
		const opts = [...sel.options].map(o => o.value).filter(Boolean);
		return opts.find(v => v !== sel.value) || '';
	});
	if (!other) {
		console.log('  ..   only one model is configured; the change checks are skipped');
	} else {
		const before = await p.evaluate((id) =>
			(JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[id] || {}).model || '', dId);
		const move = (v) => p.evaluate((val) => {
			const sel = [...document.querySelectorAll('.tile-dlg-card .tile-dlg-model select')]
				.find(s => /daimon/.test(s.id));
			sel.value = val;
			sel.dispatchEvent(new Event('change', { bubbles: true }));
		}, v);
		/// Did a dialog appear OVER the tile dialog, within `ms`?
		///
		/// Measured as a bounding rectangle -- `getClientRects().length` -- and never as
		/// a computed `display`. `display: none` does not cascade: a child of a hidden
		/// parent computes its own `display` quite happily and reports itself drawn, and
		/// a check written that way is green against a dialog nobody can see and green
		/// against one everybody can.
		///
		/// The tile dialog's own card is excluded by class. It is a `.dlg-card` too, and
		/// it is standing throughout, so an unscoped read answers "yes" every time and
		/// the check never had a chance of being false.
		const confirmWithin = async (ms) => {
			try {
				await p.waitForFunction(() =>
					[...document.querySelectorAll('.dlg-card')]
						.filter(c => c.getClientRects().length && !c.classList.contains('tile-dlg-card'))
						.length > 0, null, { timeout: ms });
				return true;
			} catch { return false; }
		};

		// ── The pulldown reveals Change; pressing it moves the daimon. ──
		//
		// The switch is two steps now, on purpose: a daimon's model is persistent, so
		// it is not moved by a pulldown brushed past. The Change button beside it shows
		// ONLY while the pick differs from the model in force, and pressing it is what
		// switches -- reusing the conversation, never a fresh daimon.
		/// Is the daimon row's Change button drawn (a real bounding box), and what does
		/// it read? Measured as `getClientRects()`, never a computed `display`, for the
		/// reason `confirmWithin` states about itself.
		const changeState = () => p.evaluate(() => {
			const row = [...document.querySelectorAll('.tile-dlg-card .tile-dlg-model')]
				.find(r => { const s = r.querySelector('select'); return s && /daimon/.test(s.id); });
			const b = row ? row.querySelector('.tile-dlg-apply') : null;
			return { shown: !!(b && b.getClientRects().length), text: b ? (b.textContent || '').trim() : '' };
		});
		const pressChange = () => p.evaluate(() => {
			const row = [...document.querySelectorAll('.tile-dlg-card .tile-dlg-model')]
				.find(r => { const s = r.querySelector('select'); return s && /daimon/.test(s.id); });
			const b = row ? row.querySelector('.tile-dlg-apply') : null;
			if (b) b.click();
		});
		const hiddenAtRest = await changeState();
		check(!hiddenAtRest.shown,
			'the Change button is hidden until a different model is picked',
			'shown=' + hiddenAtRest.shown);
		await move(other);
		await p.waitForTimeout(150);
		const shownOnDiff = await changeState();
		check(shownOnDiff.shown && /change/i.test(shownOnDiff.text),
			'picking a different model reveals the button, reading "Change"',
			JSON.stringify(shownOnDiff));
		await pressChange();
		// THE RECEIPT IS CAUGHT AS IT APPEARS. It used to be read at the bottom of
		// this block, and that read was a coin toss.
		//
		// `toast()` fades its box at 3600ms and REMOVES it at 4200ms
		// (daimond.js:29857). The read below it stood behind `confirmWithin(3000)`,
		// which burns its whole window on the healthy path where no confirm ever
		// comes, then a 1200ms settle, then a localStorage read, an IndexedDB round
		// trip and a transcript read. So the earliest it could sample was 4200ms
		// plus three round trips: the removal boundary itself, missed or hit on a
		// few milliseconds of jitter. It came up "(nothing said)" once in ten runs
		// on 2026-08-21 — red for the right reason, in the one shape that cannot be
		// attributed to anything, and a gate of 253 checks that reports a different
		// count each time is a gate nobody can read.
		//
		// The fade is not the problem and a shorter wait would not have fixed it:
		// an opacity-0 box still answers `getClientRects()`, so the window is sharp
		// rather than soft. What is wanted is not an earlier guess at when to look
		// but a watch that fires the moment the toast exists, which is this.
		const receiptEarly = await p.waitForFunction(() => {
			const said = [...document.querySelectorAll('.toast, .toast-msg, [class*="toast"]')]
				.filter(n => n.getClientRects().length)
				.map(n => (n.textContent || '').trim()).filter(Boolean).join(' | ');
			return (/tile\.model_changed/.test(said) || /moved from .* to /i.test(said)) ? said : false;
		}, null, { timeout: 4000 }).then(h => h.jsonValue()).catch(() => '');
		const asked = await confirmWithin(3000);
		check(!asked, 'NOTHING IS ASKED: a change this cheap to undo takes a receipt, not a modal',
			asked ? 'a confirm was drawn over the tile dialog' : 'no dialog appeared');
		await p.waitForTimeout(1200);
		const afterYes = await p.evaluate((id) =>
			(JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[id] || {}).model || '', dId);
		check(afterYes === other, 'and the daimon really is on the new model',
			`${before} → ${afterYes}`);

		// ── AND THE CONVERSATION IS STILL THERE. ──
		//
		// The claim the deleted modal made was that it would not be. Both halves are
		// read: the model's own copy, which is what the next turn carries and is
		// invisible from the screen, and the transcript, which is what the reader sees.
		const sessAfter = await sessLen();
		check(sessAfter === sessBefore,
			'THE MODEL\'S OWN CONVERSATION IS UNTOUCHED by the change of model',
			`${sessBefore} → ${sessAfter} messages`);
		const stillDrawn = await p.evaluate(() => {
			const co = document.getElementById('chat-output');
			return co ? (co.textContent || '') : '';
		});
		check(/remember this sentence/.test(stillDrawn),
			'and so is the transcript the reader is looking at',
			stillDrawn.replace(/\s+/g, ' ').slice(0, 70));

		// ── The receipt. ──
		//
		// `tile.model_changed` is added by the locale files, so until those land `t()`
		// hands back the key itself and the toast reads `tile.model_changed`. Either
		// form is accepted; what is asserted is that the app SAID something when it
		// moved, rather than moving in silence.
		// The watch above is what answers this; the late read stays as the fallback,
		// so a build whose toast lingers still reports what it said rather than an
		// empty string, and so a failure names whatever IS on screen instead of
		// nothing at all.
		const receiptLate = await p.evaluate(() =>
			[...document.querySelectorAll('.toast, .toast-msg, [class*="toast"]')]
				.filter(n => n.getClientRects().length)
				.map(n => (n.textContent || '').trim()).filter(Boolean).join(' | '));
		const receipt = receiptEarly || receiptLate;
		check(/tile\.model_changed/.test(receipt) || /moved from .* to /i.test(receipt),
			'a receipt says what moved, in place of the question that used to be asked',
			receipt || '(nothing said)');

		// ── And it is written into the crystal's own history, which is what
		// notes2 means by "it requires a fold and a new daimon": a change that
		// only flipped a browser setting would leave the Diamond with no record
		// that its daimon is not the one that wrote the crystal above it. ──
		await closeDialogs(p);
		await p.waitForTimeout(400);
		await p.evaluate((sel) => { document.querySelector(sel).click(); }, dSel);
		await p.waitForTimeout(900);
		// Onto the CRYSTAL face: the steer above put this Diamond on its chat face and
		// `setDiamondView` remembers, so selecting it again lands on the conversation and
		// the history control -- which belongs to the crystal -- is simply not on screen.
		await p.click('#dview-crystal', { force: true });
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
	// Max, or the meter is hidden by the view's CSS rather than absent.
	const cId = await p.evaluate(() =>
		(document.querySelector('#session-list .chat-box') || {}).dataset?.id || '');
	await setView(p, 'max');
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
		// `.tile-dlg-level` is a BOX, not a meaning: the colour reset in this same
		// dialog wears it too. The fold is the one inside the Context section, so
		// the reset is excluded by class and the words settle which of what is
		// left is being pressed.
		const btn = [...card.querySelectorAll('.tile-dlg-level:not(.tile-dlg-clear)')]
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
		[...card.querySelectorAll('.tile-dlg-level:not(.tile-dlg-clear)')]
			.find(b => /fold/i.test(b.textContent || '')).click();
	});
	// THE CONFIRM, SCOPED PAST THE TILE DIALOG'S OWN CARD — and this is the
	// second place in this file to need saying so.
	//
	// What stood here was `waitForSelector('.dlg-card .dlg-ok')` followed by a
	// click on the last visible `.dlg-card`. The tile dialog is a `.dlg-card`
	// too (`modal-card dlg-card tile-dlg-card`), it is standing at this point
	// because the Fold button that was just pressed is inside it, and the only
	// `.dlg-ok` it carries is DELETE at its foot — which `deleteChat` acts on
	// with no second question. So the wait was answered by the dialog already on
	// screen, and the click was a coin toss settled by document order.
	//
	// It came up tails on 2026-08-20/21. Under a break where the fold refuses
	// before any confirm is drawn, this block pressed Delete and the run said
	// "Moved 'the chat from just now' to the trash" — a check destroying the
	// fixture it was in the middle of measuring, and then reporting on the
	// wreckage. 5b was scoped that night; this one was left because it passed,
	// and it passed only because a confirm happens to be drawn LAST in document
	// order on the healthy path. That is not a reason, it is a coincidence.
	//
	// Scoped by `:not(.tile-dlg-card)` — the same guard 5b uses — and a missing
	// confirm is now a NAMED failure rather than a timeout thrown out of the
	// block: the fold is a destructive-enough act to be worth asking about, so
	// its absence is a fact about the product and belongs in the list.
	//
	// Read the toast once BEFORE waiting the confirm out, for the reason 5b gives
	// below: a refusal is instant and its toast is gone in a few seconds, so a run
	// that waits the full timeout first reports the break as "(nothing said)" —
	// red for the right reason and unreadable, which is how a red run gets blamed
	// on the harness.
	await p.waitForTimeout(1200);
	const earlySaid = await p.evaluate(() =>
		[...document.querySelectorAll('.toast, .toast-msg, [class*="toast"]')]
			.filter(n => n.getClientRects().length)
			.map(n => (n.textContent || '').trim()).filter(Boolean).join(' | '));
	const askedFirst = await p.waitForFunction(() =>
		[...document.querySelectorAll('.dlg-card')]
			.filter(c => c.getClientRects().length && !c.classList.contains('tile-dlg-card'))
			.length > 0, null, { timeout: 8000 }).then(() => true).catch(() => false);
	check(askedFirst, 'pressing Fold asks first, in a card of its own',
		askedFirst ? 'a confirm was drawn over the tile dialog' : 'no confirm appeared, so nothing was pressed');
	if (askedFirst) {
		await p.evaluate(() => {
			const card = [...document.querySelectorAll('.dlg-card')]
				.filter(c => c.getClientRects().length && !c.classList.contains('tile-dlg-card')).pop();
			card.querySelector('.dlg-ok').click();
		});
	}
	await p.waitForTimeout(2500);
	const said = (await p.evaluate(() =>
		[...document.querySelectorAll('.toast, .toast-msg, [class*="toast"]')]
			.map(n => (n.textContent || '').trim()).filter(Boolean).join(' | '))) || earlySaid;
	check(/nothing to fold|already as short/i.test(said),
		'a fold of a conversation that cannot be folded says so', said || '(nothing said)');
	// And the transcript is not quietly shorter for having pressed it.
	const foldRows = await p.evaluate(() =>
		document.querySelectorAll('.chat-msg-compacted').length);
	check(foldRows === 0, 'and no fold notice was written for a fold that did not happen',
		String(foldRows));
	await shot(s, 'fold-dialog');
	await closeDialogs(p);

	// ── 5b. AND IT IS STILL ASKABLE AFTER A RELOAD, which is the ordinary case.
	//
	// `chat.app` is an engine instance for THIS page load, and `hydrateChat` nulls it on
	// every boot. The guard used to read it, so the first thing a fold said about a
	// two-hundred-message thread reopened tomorrow was that the chat had nothing in it.
	// Nothing could see this from a single-page run, which is why the reload is the
	// check: the conversation is real, the engine is not, and the fold has to build one.
	//
	// What is asserted is the HONEST answer for a one-turn chat -- nothing to fold --
	// rather than the absence of the refusal. Asserting on the refusal's own words would
	// be a check written against a string the locales are in the middle of rewording.
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'diamondmodels');
	await p.waitForTimeout(2000);
	await setView(p, 'max');
	const reopened = await p.evaluate((id) => {
		const box = document.querySelector(`#session-list .chat-box[data-id="${id}"]`);
		if (!box) return false;
		box.click();
		return true;
	}, cId);
	check(reopened, 'the chat is still on the rail after a reload');
	await p.waitForTimeout(900);
	const drawnBack = await p.evaluate(() => {
		const co = document.getElementById('chat-output');
		return co ? (co.textContent || '').replace(/\s+/g, ' ') : '';
	});
	check(/hello/.test(drawnBack),
		'and it still holds the conversation, so the fold below has a subject',
		drawnBack.slice(0, 60));
	const cogAgain = await p.evaluate((id) => {
		const box = document.querySelector(`#session-list .chat-box[data-id="${id}"]`);
		const cog = box && box.querySelector('.tile-cog');
		if (!cog) return false;
		cog.click();
		return true;
	}, cId);
	check(cogAgain, 'its cog still opens');
	await p.waitForSelector('.tile-dlg-card', { timeout: 8000 });
	await p.evaluate(() => {
		const card = document.querySelector('.tile-dlg-card');
		[...card.querySelectorAll('.tile-dlg-level:not(.tile-dlg-clear)')]
			.find(b => /fold/i.test(b.textContent || '')).click();
	});
	/// Whatever the app is saying in a toast, right now.
	const toasts = () => p.evaluate(() =>
		[...document.querySelectorAll('.toast, .toast-msg, [class*="toast"]')]
			.filter(n => n.getClientRects().length)
			.map(n => (n.textContent || '').trim()).filter(Boolean).join(' | '));
	// Read once BEFORE waiting for the confirm. A refusal is instant and its toast is
	// gone in a few seconds, so a run that waited out the confirm timeout first would
	// report the break as "(nothing said)" -- red for the right reason, and unreadable.
	await p.waitForTimeout(1200);
	const early = await toasts();
	// The confirm, if one comes: SCOPED past the tile dialog's own card, which carries
	// `.dlg-card` and whose Delete at the foot carries `.dlg-ok`. An unscoped wait is
	// satisfied by the dialog already standing and an unscoped click then trashes the
	// chat -- which is what happened here, under the break, where a refusal returns
	// before any confirm is drawn. A missing confirm is not a failure at this point;
	// the toast is what is being judged.
	const askedToFold = await p.waitForFunction(() =>
		[...document.querySelectorAll('.dlg-card')]
			.filter(c => c.getClientRects().length && !c.classList.contains('tile-dlg-card'))
			.length > 0, null, { timeout: 8000 }).then(() => true).catch(() => false);
	if (askedToFold) {
		await p.evaluate(() => {
			const card = [...document.querySelectorAll('.dlg-card')]
				.filter(c => c.getClientRects().length && !c.classList.contains('tile-dlg-card')).pop();
			card.querySelector('.dlg-ok').click();
		});
	}
	await p.waitForTimeout(3000);
	const saidAgain = (await toasts()) || early;
	check(/nothing to fold|already as short/i.test(saidAgain),
		'A FOLD ASKED FOR AFTER A RELOAD REACHES THE CONVERSATION, and answers about it',
		saidAgain || '(nothing said)');
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
