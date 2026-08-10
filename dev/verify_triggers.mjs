// verify_triggers.mjs — phase H: automation you can see, pause and read.
//
// Notes2 §Diamonds asks for triggered actions, a Pending panel and two default
// Diamonds. The properties below are chosen because each one is a thing that
// would be invisible if it were wrong:
//
//   0. THE CLOCK. Every timer keeps its own stopwatch, counts only the minutes
//      somebody actually worked in, starts at the release of a hold, and keeps
//      what a refused firing accrued instead of throwing it away. It runs in
//      node against `www/js/triggers.js` with no browser at all, which is what
//      lets it advance half an hour in a millisecond -- and it was written after
//      two faults the seven checks below had no way of seeing: one stopwatch
//      shared by the whole account, so the shortest timer starved every longer
//      one, and a reset that happened whether or not the turn did.
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
//   8. A timer that is REFUSED keeps what it accrued. The three refusals are
//      silent -- no model, a turn already running, a Diamond that is not the one
//      on screen -- so this drives the real tick with the Diamond off screen and
//      then puts it on screen, and watches the same accrued time arrive at a
//      turn rather than being spent on nothing.
//
// Plus the Pending panel: three answers, all three taking the tile away, and the
// sort the user chose.
//
//   node dev/verify_triggers.mjs
//   node dev/verify_triggers.mjs --clock              # section 0 alone, no browser
//   node dev/verify_triggers.mjs --break unpaused     # defaults arrive running
//   node dev/verify_triggers.mjs --break ctxtwice     # context is sent every time
//   node dev/verify_triggers.mjs --break eagerreset   # the tick zeroes a refused timer
//
// and the clock's own, each of which is how some piece of it used to behave or
// could plausibly be written:
//
//   --clock --break sharedclock  one stopwatch for the whole account
//   --clock --break deaf         signs of life never reach the clock
//   --clock --break neverreset   a clock that is never restarted
//   --clock --break unheld       the tree answering that nothing is ever held
//   --clock --break wallclock    the input gate off, so an untouched tab counts
//   --clock --break readsclock   `due` consults the clock instead of the occasion
//   --clock --break openhanded   no reading read as "everything", not "nothing"
//
// Every break replaces a piece of the CODE UNDER TEST with the way it behaved
// before the fix, never a piece of this file, and every check in section 0 is
// red under at least one of them. A check nobody can turn red is not a check.
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both) --
// except with `--clock`, which needs neither.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

// `--clock` runs section 0 by itself, and section 0 is plain node. So the
// harness is imported only when the browser half is going to run: a check on
// the clock must not need a browser installed to say what the clock does.
const CLOCK_ONLY = process.argv.includes('--clock');
const { open, connectMock, signInAs, scratch, shot, mockLog } =
	CLOCK_ONLY ? {} : await import('./harness.mjs');

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

// ══ 0. The activity clock ═════════════════════════════════════════════
//
// `www/js/triggers.js` exports for node, so the clock and the decision can be
// driven at whatever speed the check needs. That matters more than tidiness
// here: the fault this section was written for was a 30-minute timer that could
// not fire, and no browser check is going to sit through thirty minutes of work
// to see it.
//
// The loop below is the tick's RULE and nothing else about it -- fire what is
// due, restart only the clocks that fired -- so what is being measured is the
// module, not a second copy of the app.
const require = createRequire(import.meta.url);
// `allowed` asks the pause tree at the moment of firing, and the tree lives on
// `window`. Node has none, so it gets one holding whatever `held` says -- which
// is how a check below can pause a timer and watch what its clock does.
const held = {};
globalThis.window = { DaimondPause: { isPaused: (nodeId) => !!held[nodeId] } };
const T = require('../www/js/triggers.js');

if (BREAK === 'sharedclock') {
	// The clock as it was: ONE stopwatch for the whole account, reset by whatever
	// fires. This is the defect -- a 5-minute timer zeroes the count a 30-minute
	// one is waiting on, every five minutes, so the longer one never arrives.
	let shared = 0, saw = false;
	T.noteActivity    = () => { saw = true; };
	T.tickActivity    = (ms) => { if (saw) shared += ms; saw = false; return shared; };
	T.activityMinutes = () => shared / 60000;
	T.resetActivity   = () => { shared = 0; };
}
if (BREAK === 'wallclock') {
	// The input gate taken off, so every minute counts whether anybody was there
	// or not. A tab left open overnight then greets its owner with eight turns
	// nobody asked for, which is the failure this whole section is written
	// against.
	const tick = T.tickActivity;
	T.tickActivity = (ms) => { T.noteActivity(); return tick(ms); };
}
if (BREAK === 'deaf') {
	// The page's signs of life never reaching the clock -- one unwired listener,
	// and nothing ever accrues or fires again.
	T.noteActivity = () => {};
}
if (BREAK === 'neverreset') {
	// A clock that is never restarted: the opposite mistake to zeroing it on a
	// refusal, and it shows as a timer that fires every minute once it first
	// comes due, instead of once a period.
	T.resetActivity = () => {};
}
if (BREAK === 'openhanded') {
	// An occasion with no reading read as "everything has accrued" rather than
	// "nothing has". Failing open here means a caller that forgets to pass the
	// clock fires every armed TA it can reach.
	const real = T.due;
	T.due = (id, actions, occ) => real(id, actions,
		Object.assign({ minutesFor: () => Infinity }, occ));
}
if (BREAK === 'unheld') {
	// The tree answering that nothing is ever held. A hold is enforcement, not
	// decoration: a Diamond seeded paused, or a pause that arrived from another
	// device between the schedule and the fire, then spends anyway.
	globalThis.window.DaimondPause.isPaused = () => false;
}
if (BREAK === 'readsclock') {
	// `due` consulting the clock itself instead of the occasion it was handed.
	// It is then no longer pure, and cannot be asked a question about a reading
	// the caller has -- which is how the per-TA clock reaches it.
	const real = T.due;
	T.due = (id, actions, occ) => real(id, actions, Object.assign({}, occ, {
		minutesFor: (d, ta) => T.activityMinutes(d, ta.id),
	}));
}

/// One armed timer of `n` minutes, whose action id is `name` -- the name is
/// what a firing is reported under, so a check can say which one went.
const timer = (n, name) => {
	const ta = T.blank('activity');
	ta.id = name;
	ta.minutes = n;
	ta.instruction = 'do the ' + name + ' thing';
	return ta;
};

/// Run `n` minutes of the clock and report every firing, as `{ minute, id,
/// actionId }`.
///
/// `arm` is `{ diamondId: [actions] }`. `idle` is a tab nobody touches. `refuse`
/// is the dispatcher declining -- a turn already running, or a Diamond that is
/// not the one on screen -- which is silent to `due` and is exactly the case
/// where the accrued time must survive. One firing per Diamond per minute, as
/// `Triggers.fire` allows.
const run = (n, arm, { idle = false, refuse = null, from = 0 } = {}) => {
	const log = [];
	for (let m = from; m < from + n; m++) {
		if (!idle) T.noteActivity();
		T.tickActivity(60000);
		for (const id of Object.keys(arm)) {
			const owed = T.due(id, arm[id], {
				kind: 'activity',
				minutesFor: (d, ta) => T.activityMinutes(d, ta.id),
			});
			const t = owed[0];
			if (!t) continue;
			if (refuse && refuse(id, t, m + 1)) continue;
			log.push({ minute: m + 1, id: id, actionId: t.id });
			T.resetActivity(id, t.id);
		}
	}
	return log;
};

{
	// ── Two timers of different lengths, armed together ──
	const SHORT = 5, LONG = 30;
	const arm = {
		quick: [timer(SHORT, 'five')],
		slow:  [timer(LONG, 'thirty')],
	};
	const log = run(LONG + 2, arm);
	const at = (name) => log.filter(x => x.actionId === name).map(x => x.minute);
	const said = 'five at ' + (at('five').join(',') || 'never')
		+ '; thirty at ' + (at('thirty').join(',') || 'never');
	// THE ONE THIS SECTION EXISTS FOR. With one stopwatch for the account the
	// 30-minute timer is not late, it is impossible: the 5-minute one zeroes the
	// count every five minutes for ever, while the light says armed.
	check(at('thirty').length > 0,
		'a 30-minute timer fires even with a 5-minute one running beside it', said);
	check(at('five').length > 0,
		'and the 5-minute one is not starved in its turn', said);
	// Each waits its OWN period rather than the other's: no firing before the
	// minute it is set for, and no two firings closer together than that.
	const spaced = (mins, period) =>
		mins.every((v, i) => v - (i ? mins[i - 1] : 0) >= period);
	check(spaced(at('thirty'), LONG),
		'the 30-minute one waits thirty minutes of work, not somebody else’s five', said);
	check(spaced(at('five'), SHORT),
		'and the 5-minute one keeps its own period instead of firing every tick', said);
}

{
	// ── Two timers on ONE Diamond take turns ──
	//
	// `Triggers.fire` sends at most one turn per Diamond however many matched:
	// two instructions arriving as two turns is two bills and a daimon answering
	// itself. The one that waits is not reset, so it comes to the next minute
	// further ahead than the one that went -- the earlier line in the file wins
	// the tick, not the session.
	const arm = { both: [timer(5, 'first-line'), timer(5, 'second-line')] };
	const log = run(30, arm);
	const at = (name) => log.filter(x => x.actionId === name).map(x => x.minute);
	check(at('second-line').length > 0,
		'a second timer on the same Diamond is deferred a tick, not starved for ever',
		'first at ' + (at('first-line').join(',') || 'never')
		+ '; second at ' + (at('second-line').join(',') || 'never'));
}

{
	// ── A refused firing keeps what it accrued ──
	//
	// One Diamond dispatches all the way through; the other is refused until the
	// minute it is not. The refused one must go at once on the first minute it is
	// allowed to, because the time it accrued while being refused is still there.
	const LIFT = 12, PERIOD = 5;
	const arm = {
		onscreen:  [timer(PERIOD, 'on')],
		offscreen: [timer(PERIOD, 'off')],
	};
	const log = run(LIFT + 4, arm, {
		refuse: (id, t, minute) => id === 'offscreen' && minute <= LIFT,
	});
	const off = log.filter(x => x.actionId === 'off').map(x => x.minute);
	const said = 'refused through minute ' + LIFT + '; fired at ' + (off.join(',') || 'never');
	check(off.length > 0, 'a timer that was refused still fires once it can', said);
	check(off.length > 0 && Math.min(...off) === LIFT + 1,
		'and it goes on the FIRST minute it is allowed to — the refusal deferred its '
		+ 'time, it did not spend it', said);
}

{
	// ── A tab nobody touches ──
	//
	// The deliberate semantic, and the reason none of this runs on a wall clock:
	// "N minutes of USER ACTIVITY". An overnight tab must arrive at nothing.
	const arm = { idle: [timer(5, 'sleeper')] };
	const log = run(90, arm, { idle: true });
	check(log.length === 0,
		'a tab nobody touches accrues nothing, however long it is left open',
		log.map(x => x.minute).join(',') || 'no firings');
	// And it is still armed: the same TA fires once somebody works at it.
	const after = run(6, arm, { from: 90 });
	check(after.length > 0,
		'and the same timer fires as soon as somebody actually works',
		after.map(x => x.minute).join(',') || 'never');
}

{
	// ── A timer added later starts from now ──
	//
	// Asking a TA its age is what starts its clock, so one made after a long
	// session does not inherit that session and fire on the tick it was made.
	const arm = { later: [timer(5, 'early')] };
	run(40, arm);
	const fresh = timer(10, 'added-late');
	arm.later.push(fresh);
	const mins = run(12, arm, { from: 40 }).filter(x => x.actionId === 'added-late')
		.map(x => x.minute);
	check(mins.length > 0, 'a timer added later does eventually fire',
		mins.join(',') || 'never');
	check(mins.length > 0 && Math.min(...mins) >= 40 + fresh.minutes,
		'and it counts from when it was made, not from the work that went before it',
		'added at 40, set for ' + fresh.minutes + ', fired at ' + (mins.join(',') || 'never'));
}

{
	// ── A held timer has no clock until it is released ──
	//
	// The tree is the authority and it is asked at the moment of firing, so a
	// held TA is dropped before anything asks its age -- and nothing starts
	// counting. That is what a Diamond seeded paused wants: the Optimiser's
	// thirty minutes are thirty minutes of work after its owner lets it go, not
	// thirty minutes that quietly went by while it was held.
	const ta = timer(5, 'onhold');
	const arm = { held: [ta] };
	const leaf = T.node('held', 'onhold');
	held[leaf] = true;
	const during = run(20, arm);
	check(during.length === 0, 'a held timer does not fire, however long the work goes on',
		during.map(x => x.minute).join(',') || 'no firings');
	delete held[leaf];
	const after = run(20, arm, { from: 20 }).map(x => x.minute);
	check(after.length > 0 && Math.min(...after) >= 20 + ta.minutes,
		'and once released it counts from the release, rather than firing on the '
		+ 'minutes it was held through',
		'released at 20, set for ' + ta.minutes + ', fired at ' + (after.join(',') || 'never'));
}

{
	// ── `due` is pure ──
	//
	// It answers about the reading it was HANDED. That is what lets one clock per
	// TA reach it without this module holding any of them, and what makes every
	// check above possible at all.
	const ta = timer(30, 'p');
	const asIf = (mins) => T.due('pure', [ta], {
		kind: 'activity', minutesFor: () => mins,
	}).length > 0;
	check(asIf(31) && !asIf(29),
		'`due` answers about the reading it is handed, not one it goes and finds',
		'31 → ' + asIf(31) + ', 29 → ' + asIf(29));
	check(!T.due('pure', [ta], { kind: 'activity' }).length,
		'and an occasion carrying no reading is due nothing — a caller that forgets '
		+ 'the clock spends nothing, rather than everything');
}

if (CLOCK_ONLY) {
	// The clock alone, for the breaks above and for anywhere without a browser.
	console.log(failures === 0
		? `\nverify_triggers (clock): all checks pass.`
		: `\nverify_triggers (clock): ${failures} failed.`);
	process.exit(failures === 0 ? 0 : 1);
}

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
			(document.getElementById('chat-input') || {}).placeholder || '');
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
			(document.getElementById('chat-input') || {}).placeholder || '');
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

	// ══ 8. A refused firing keeps the time it accrued ═════════════════
	//
	// The three refusals are silent: no model, a turn already running, and a
	// Diamond that is not the one on screen. The last is the one a test can stage
	// honestly, so a timer is armed on Help while the Optimiser is on screen. It
	// comes due, it is refused -- deliberately, because moving the centre out from
	// under somebody mid-sentence is worse than a turn that waits -- and the
	// question is what happens to the six minutes it spent getting there.
	//
	// Driven through the real tick, because the fault was in the tick: it worked
	// out what to zero by asking `due` a second time, and `due` is pure and can
	// see neither a busy crystal nor which Diamond is on screen. It reported the
	// refused timer as owed, the clock was zeroed anyway, and the accrued time
	// went nowhere.
	if (help && opt) {
		if (BREAK === 'eagerreset') {
			// The tick as it was: whatever the clock says is owed gets zeroed,
			// whether or not a turn went anywhere.
			await p.evaluate(() => {
				const T = window.DaimondTriggers, tick = window.DaimondTriggerTick;
				window.DaimondTriggerTick = async function () {
					await tick();
					document.querySelectorAll('#diamond-list .diamond-box').forEach((b) => {
						(window.DaimondTriggersOf(b.dataset.id) || []).forEach((ta) => {
							if (ta.kind !== 'activity') return;
							if (T.activityMinutes(b.dataset.id, ta.id) >= (ta.minutes || 30)) {
								T.resetActivity(b.dataset.id, ta.id);
							}
						});
					});
				};
			});
		}
		const SAYS = 'TRIGGER DEFERRAL CHECK';
		const PERIOD = 3;
		// Where the mock's log has got to, so "was this sent?" is asked of THIS
		// run. The log is a world's, not a run's, and a second run against the same
		// world would otherwise find the first run's turn and call the refusal a
		// dispatch.
		const seen = mockLog().length;
		const armed = await p.evaluate(async (a) => {
			const T = window.DaimondTriggers;
			const ta = T.blank('activity');
			ta.id = 'defer-' + Date.now().toString(36);
			ta.minutes = a.period;
			ta.instruction = a.says;
			await DaimondCore.triggerSet(a.id, ta);
			// Running, said out loud rather than assumed: an unheld leaf reads as
			// playing, and this check is about the refusal, not about what the tree
			// happened to be seeded with.
			DaimondPause.set(T.node(a.id, ta.id), true);
			return ta.id;
		}, { id: help.id, says: SAYS, period: PERIOD });

		// The OPTIMISER on screen, so Help is not the Diamond a trigger may steer.
		await p.evaluate((id) => {
			document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`).click();
		}, opt.id);
		await p.waitForTimeout(700);
		const held = await p.evaluate(async (a) => {
			const T = window.DaimondTriggers;
			for (let m = 0; m < a.mins; m++) {
				T.noteActivity();
				await window.DaimondTriggerTick();
			}
			// Asking does not consume it; only a firing does.
			return T.activityMinutes(a.id, a.ta);
		}, { id: help.id, ta: armed, mins: PERIOD * 2 });
		// JSON rather than `content`: a message's content is a string in the simple
		// case and an array of parts in every other, and the question here is only
		// whether the instruction reached the wire at all.
		const spoke = () => mockLog().slice(seen).some(r => JSON.stringify(r).includes(SAYS));
		check(!spoke(),
			'a trigger does not steer a Diamond the user is not looking at',
			'the model was ' + (spoke() ? 'sent it anyway' : 'not sent the instruction'));
		check(held >= PERIOD,
			'and the minutes it accrued while being refused are still there, not spent on nothing',
			held.toFixed(1) + ' minutes held, set for ' + PERIOD);

		// And on screen, the same accrued time arrives at a turn on the very next
		// tick — it did not go back to zero and start the wait again.
		await p.evaluate((id) => {
			document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`).click();
		}, help.id);
		await p.waitForTimeout(700);
		await p.evaluate(() => {
			window.DaimondTriggers.noteActivity();
			window.DaimondTriggerTick();
		});
		const restarted = await p.waitForFunction(
			(a) => window.DaimondTriggers.activityMinutes(a.id, a.ta) < 1,
			{ id: help.id, ta: armed }, { timeout: 40000 }).then(() => true).catch(() => false);
		await p.waitForTimeout(600);
		check(spoke(), 'once the Diamond is on screen the held time reaches the daimon',
			'the model was ' + (spoke() ? 'sent the instruction' : 'never sent it'));
		check(restarted,
			'and only then does that timer start counting again — a firing consumes it, '
			+ 'a refusal never did');
	}

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
