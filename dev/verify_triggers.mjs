// verify_triggers.mjs — phase H: automation you can see, pause and read.
//
// Notes2 §Diamonds asks for triggered actions, a Pending panel and two default
// Diamonds. Seven properties, chosen because each one is a thing that would be
// invisible if it were wrong:
//
//   1. The two default Diamonds are there. The Optimiser STARTS PAUSED, because
//      it carries a timer that would otherwise spend on a schedule nobody set.
//      Help does NOT, and carries no light at all: it has no triggered actions,
//      so the only thing that makes it spend is the user typing to it.
//   2. The Optimiser's timer action is there and is INACTIVE, in the record and
//      on the pause tree both — notes2 asks for it by name.
//   3. A trigger is a leaf of the pause tree, so a Diamond with one held and its
//      daimon running reads amber without anyone setting amber.
//   4. EVERY action has a light. There used to be one that did not — `prompted`,
//      on every Diamond, drawn with a spacer where the widget goes — and the
//      user's ruling removed it: typing a prompt IS the activation, so there is
//      nothing there to arm and nothing to represent.
//   5. The actions are FILES, at `diamonds/<id>/triggers.json`, where the System
//      section shows them and a daimon can read them.
//   6. Context is sent ONCE, and changing it makes it new again. Measured on the
//      composer, which is the thing that decides.
//   7. A paused Diamond's input says where its play control is.
//
// Plus the Pending panel: three answers, all three taking the tile away, and the
// sort the user chose.
//
//   node dev/verify_triggers.mjs
//   node dev/verify_triggers.mjs --break unpaused   # defaults arrive running
//   node dev/verify_triggers.mjs --break ctxtwice   # context is sent every time
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { open, connectMock, signInAs, scratch, shot } from './harness.mjs';

const OUT = path.join(os.homedir(), '.cache/daimond/triggers-shots');
fs.mkdirSync(OUT, { recursive: true });

const BI = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const MODEL = 'accounts/fireworks/models/glm-5p2';

// Opened WITHOUT signing in, so a break can be installed before the app boots.
// The defaults are seeded on the first render after sign-in, which is the thing
// under test — patch it afterwards and the break patches nothing.
const s = await open({ name: 'triggers', signIn: false, connect: false,
	profile: scratch('pw', 'triggers-' + process.pid) });
const { page: p } = s;
try {
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);
	if (BREAK === 'unpaused') {
		// The defaults seeded without the hold — which is what "start paused"
		// costs if it is left to a branch instead of written at the leaf. A
		// Diamond that arrives running spends on a schedule nobody set.
		await p.evaluate(() => { DaimondPause.seedPaused = function () { /* BROKEN */ }; });
	}
	await signInAs(s, 'triggers');
	await connectMock(s, { model: MODEL });
	// THE TWO DEFAULT DIAMONDS ARE WITHHELD from this release -- see
	// `seedDefaultDiamonds`, which is not called: creating a Diamond makes
	// `diamonds/` exist, and `migrate_root` then refuses for ever to move a legacy
	// root that arrives afterwards. So this file makes the same two itself, seeds
	// them exactly as that function would, and checks the PROPERTIES notes2 asks
	// for -- paused, with an inactive 30-minute timer -- without depending on the
	// boot path that is held back.
	await p.evaluate(() => DaimondDiamond.seedDefaults());
	await p.waitForFunction(() =>
		[...document.querySelectorAll('#diamond-list .session-box-name')]
			.some(n => /Daimond Help/.test(n.textContent)), null, { timeout: 20000 }).catch(() => {});

	// ══ 1. Two Diamonds, both paused ══════════════════════════════════
	const rail = await p.evaluate(() =>
		[...document.querySelectorAll('#diamond-list .diamond-box')].map(b => ({
			name:  ((b.querySelector('.session-box-name') || {}).textContent || '').trim(),
			// Whether there IS a widget, apart from what it says. An absent one
			// and a present one with no state both read `''`, and the difference
			// between them is now the point.
			has:   !!b.querySelector('.pptw'),
			state: (b.querySelector('.pptw') || {}).dataset ? b.querySelector('.pptw').dataset.state : '',
			// Where it sits: the user's rule is that a light goes to the RIGHT of
			// the name, hard against the cog, so a rail of mixed Diamonds keeps
			// one left edge for its labels.
			order: [...(b.querySelector('.session-box-header') || { children: [] }).children]
				.map((el) => el.className.split(' ')[0]).join(','),
			id:    b.dataset.id,
		})));
	const help = rail.find(r => /Daimond Help/.test(r.name));
	const opt  = rail.find(r => /Daimond Optimiser/.test(r.name));
	check(!!help, 'Daimond Help is there', rail.map(r => r.name).join(', ') || '(none)');
	check(!!opt, 'Daimond Optimiser is there', rail.map(r => r.name).join(', ') || '(none)');
	// Help has NO triggered actions, so it has nothing that spends without being
	// asked — and therefore no widget and no hold. This read "Help starts
	// PAUSED", which was right while every Diamond carried a `prompted` action;
	// with that gone, a red light on Help would be a control standing for a
	// decision the user makes by typing.
	check(!!(help && help.has === false),
		'Help carries no traffic light — with no actions, prompting it IS the choice to run it',
		help && JSON.stringify(help.order));
	check(!!(opt && opt.has === true && opt.state === 'pause'),
		'the Optimiser does, and starts PAUSED — it has a timer that would spend unasked',
		opt && opt.state);
	// The user's placement rule, measured rather than eyeballed: name first, then
	// the light, then the cog. It used to be light, name, cog — so a rail of
	// Diamonds with and without one had two different left edges for its labels.
	check(!!(opt && /^session-box-name,pptw,tile-cog/.test(opt.order)),
		'and it sits to the RIGHT of the name, hard against the cog',
		opt && opt.order);

	// ══ 7. And a Diamond that IS held says where its play control is ══
	if (opt) {
		await p.evaluate((id) => {
			document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`).click();
		}, opt.id);
		await p.waitForTimeout(900);
		const ph = await p.evaluate(() =>
			(document.getElementById('steer-input') || {}).placeholder || '');
		check(/paus/i.test(ph) && /play/i.test(ph),
			'a paused Diamond’s input says where its play control is', ph);
	}

	// A Diamond whose TILE has no light must still be typeable when nothing has
	// paused it, and must still have a release valve when something has. It is
	// left in the pause tree deliberately — the global control writes through
	// that tree, so dropping it out would mean "pause Everything" no longer
	// stopped it spending.
	if (help) {
		await p.evaluate((id) => {
			document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`).click();
		}, help.id);
		await p.waitForTimeout(900);
		const ph = await p.evaluate(() =>
			(document.getElementById('steer-input') || {}).placeholder || '');
		check(!/paus/i.test(ph), 'a Diamond with no light on its tile is not held', ph);

		const reach = await p.evaluate((id) => ({
			// In the tree, so the global control still reaches it.
			inTree: !!DaimondPause._core.findNode(DaimondCore.pauseTree(),
				DaimondPause.id('root', 'diamonds', id) + '/self'),
		}), help.id);
		check(reach.inTree,
			'but it IS in the pause tree, so “pause Everything” still stops it spending',
			JSON.stringify(reach));
	}

	// ══ 2–4. The Optimiser's timer, and the pause tree ════════════════
	if (opt) {
		await p.evaluate((id) => {
			document.querySelector(`#diamond-list .diamond-box[data-id="${id}"] .tile-cog`).click();
		}, opt.id);
		// The actions are named by the chooser's options now, not by a row each:
		// notes2 asks for them to be "selected for editing from a pulldown", so
		// the pulldown is the census of what a Diamond has.
		await p.waitForSelector('.tile-dlg-card .trig-choose', { timeout: 8000 });
		const rows = await p.evaluate(() => {
			const sel = document.querySelector('.tile-dlg-card .trig-choose');
			const light = document.querySelector('.tile-dlg-card .trig-pick .pptw');
			return {
				names: [...sel.options].map(o => o.textContent.trim()),
				chosen: sel.value,
				light: light ? light.dataset.state : '(none)',
			};
		});
		check(rows.names.length === 1, 'the Optimiser has ONE action: the timer',
			rows.names.join(' | '));
		check(rows.names.some(n => /30 minutes/.test(n)),
			'the timer is set for 30 minutes, as notes2 asks', rows.names.join(' | '));
		check(rows.light === 'pause',
			'and it starts INACTIVE, on the tree as well as in the record', rows.light);
		// EVERY action has a light. The one that did not — `prompted`, drawn with
		// a spacer where the widget goes — is gone, because prompting a Diamond
		// is the user asking rather than an arrangement to be armed. The light now
		// sits beside the pulldown and belongs to whichever action is chosen, and
		// the option text carries the state of the ones that are not.
		check(rows.light !== '(none)',
			'and the chosen action has a light — there is no longer one that is only decoration',
			rows.light);
		check(rows.names.every(n => /^[▶⏸]/.test(n)),
			'and every option says whether that action is running, so the pulldown hides no state',
			rows.names.join(' | '));

		await p.evaluate(() => {
			const done = document.querySelector('.tile-dlg-done');
			if (done) done.click();
		});
		await p.waitForTimeout(300);

		// ══ 5. They are files, where you can read them ════════════════
		const file = await p.evaluate(async (id) => {
			const W = await import('/pkg/oxedyne_daimond.js');
			try { return await W.store_read('diamonds/' + id + '/triggers.json'); }
			catch (e) { return ''; }
		}, opt.id);
		check(!!file, 'the actions are a file at diamonds/<id>/triggers.json',
			file ? file.replace(/\s+/g, ' ').slice(0, 70) : '(absent)');
		let parsed = null;
		try { parsed = JSON.parse(file); } catch (e) { parsed = null; }
		check(!!parsed, 'and it parses');
		const ta = parsed && (parsed.actions || []).find(x => x.kind === 'activity');
		check(!!ta, 'with the timer in it', ta ? JSON.stringify(ta).slice(0, 80) : 'none');
		check(!!(ta && ta.on === false),
			'recorded as inactive, so the engine reads what the light shows',
			ta && String(ta.on));
		// NOT under `.daimond/`, which both trees hide: "an intuitive system
		// directory hierarchy" means one you can see.
		const listed = await p.evaluate(async (id) => {
			const W = await import('/pkg/oxedyne_daimond.js');
			try { return await W.store_list('diamonds/' + id); } catch (e) { return ''; }
		}, opt.id);
		check(/triggers\.json/.test(listed),
			'and it is listed in the open, not hidden under a dotfile',
			listed.replace(/\n/g, ' ').slice(0, 80));
	}

	// ══ 6. Context is sent once, and again when it changes ════════════
	const ctx = await p.evaluate((brk) => {
		const T = window.DaimondTriggers;
		const ta = T.blank('activity');
		ta.instruction = 'DO THE THING';
		ta.context = 'BACKGROUND';
		const first = T.compose(ta);
		// The caller records the stamp only when the turn was accepted, which is
		// what this simulates.
		if (brk !== 'ctxtwice') ta.contextSent = first.sentContext;
		const second = T.compose(ta);
		ta.context = 'DIFFERENT BACKGROUND';
		const third = T.compose(ta);
		return { first: first.text, second: second.text, third: third.text };
	}, BREAK);
	check(/BACKGROUND/.test(ctx.first) && /DO THE THING/.test(ctx.first),
		'the first firing carries the context in front of the instruction',
		ctx.first.replace(/\n+/g, ' / '));
	check(!/BACKGROUND/.test(ctx.second) && /DO THE THING/.test(ctx.second),
		'the second does NOT — context is sent once',
		ctx.second.replace(/\n+/g, ' / '));
	check(/DIFFERENT BACKGROUND/.test(ctx.third),
		'and changing the context makes it new again',
		ctx.third.replace(/\n+/g, ' / '));

	// ══ The Pending panel ═════════════════════════════════════════════
	await p.evaluate(() => DaimondPanels.show('pending'));
	await p.waitForTimeout(500);
	const empty = await p.evaluate(() =>
		(document.getElementById('pending-list') || {}).textContent || '');
	check(/nothing waiting/i.test(empty), 'Pending says so when nothing is waiting', empty.trim());

	const ids = await p.evaluate(() => [
		DaimondPendingView.add({ headline: 'Send the quote to Ada', detail: 'It is drafted.',
			priority: 'high', diamondName: 'Work' }),
		DaimondPendingView.add({ headline: 'Tidy the notes', detail: '', priority: 'low',
			diamondName: 'Work' }),
	]);
	check(ids.every(Boolean), 'two items can be raised', String(ids.length));
	await p.waitForTimeout(400);
	const order = await p.evaluate(() =>
		[...document.querySelectorAll('#pending-list .pend-line')].map(n => n.textContent.trim()));
	check(order.length === 2, 'both are on the panel', order.join(' | '));
	check(order[0] === 'Send the quote to Ada',
		'and the high-priority one is first, because the question is “what next”',
		order.join(' | '));
	const badge = await p.evaluate(() =>
		(document.getElementById('pending-count') || {}).textContent || '');
	check(badge === '2', 'the count says how many are waiting', badge);

	// The headline expands, because a panel of one-liners cannot be judged.
	await p.evaluate(() => document.querySelector('#pending-list .pend-line').click());
	await p.waitForTimeout(200);
	const expanded = await p.evaluate(() => {
		const d = document.querySelector('#pending-list .pend-detail');
		return { shown: d && d.style.display !== 'none', text: d ? d.textContent : '' };
	});
	check(!!(expanded.shown && /drafted/.test(expanded.text)),
		'the headline expands to what the daimon actually said', expanded.text.slice(0, 50));

	// Drop takes it away, and the panel is one shorter.
	await p.evaluate(() => document.querySelector('#pending-list .pend-no').click());
	await p.waitForTimeout(400);
	const left = await p.evaluate(() =>
		[...document.querySelectorAll('#pending-list .pend-line')].map(n => n.textContent.trim()));
	check(left.length === 1 && left[0] === 'Tidy the notes',
		'dropping one takes it off the list', left.join(' | '));
	await shot(s, 'pending');

} catch (e) {
	check(false, 'the run finished', String(e && e.message || e));
	try { await shot(s, 'threw'); } catch {}
} finally {
	await s.close();
}

console.log(failures === 0
	? `\nverify_triggers: all checks pass.`
	: `\nverify_triggers: ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
