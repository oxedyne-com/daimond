// verify_daimonconc.mjs — two daimons at once, and the Agents panel that shows up
// when work starts.
//
// TESTER NOTE 14: *"When I have a daimon (or chat) in-progress and then prompt a
// different daimon (or chat), the new prompt is queued ('Waiting, Sent when this
// answer finishes'), apparently waiting for the other daimon/chat to finish. I'd
// expect them to be able to be sent independently!"*
//
// They were serialised, and nothing about it was deliberate. `crystalBusy` was ONE
// BOOLEAN for the whole app (`www/js/daimond.js`), read by the Diamond branch of
// `sendUserMessage` and by `doSteer`, so a turn on Diamond A queued a message
// typed at Diamond B. No governor asked for it -- `www/js/governor.js` gates the
// SIZE of a fan-out and nothing else -- and no engine limit required it:
// `steer_crystal` composes a fresh `Agent`, a fresh `ToolRegistry` and a LOCAL
// `Session` per call (`src/wasm/app.rs`), so two Diamonds sharing one `DaimondApp`
// can be steered at the same moment. Ordinary chats have run concurrently all
// along, gated per record by `_generating`.
//
// THE SECOND HALF, WHICH THE NOTE DOES NOT MENTION AND IS WORSE. The queue was
// drained at the end of the turn it waited on -- and that turn belonged to the
// OTHER Diamond. So the message did not merely wait: when A finished, nothing
// drained B, because `drainSteerQueue` runs for A's record and `resumeSteerQueue`
// only fires on coming BACK to a Diamond. A user sitting on B watched A finish and
// their own message stay badged and unsent for ever. Measured before the fix:
// `B after send: queue:["@text hello from B"]` … `after A finishes: queue:["@text
// hello from B"]`. So §1 asserts the OVERLAP and §2 asserts B actually answered.
//
// WHAT IS DELIBERATE AND STAYS: one turn per Diamond. A steer and a fold both
// rewrite that Diamond's `crystal.json`, and two writers on one crystal lose each
// other's edits. §3 holds that line, and §4 holds it for the fold -- which now
// says so out loud instead of leaving a dead button.
//
// TESTER NOTE 10: *"When a daimon or chat initiates a new agent worker, the Agent
// dock panel should be toggled to visible, currently this is not happening."* It
// was ONCE EVER, remembered under `daimond-agents-revealed`, so the first fan-out
// a browser ever ran opened the panel and none afterwards did. §5 dispatches
// twice, closing the panel in between. §6 is the other side of it: a panel a
// PERSON pushed away while workers were running is not argued with.
//
//   node dev/verify_daimonconc.mjs --break oneflag   # one busy flag for the whole app again
//   node dev/verify_daimonconc.mjs --break onceonly  # the Agents panel reveals once ever again
//   node dev/verify_daimonconc.mjs --break noveto    # it reopens over a panel just closed
//   node dev/verify_daimonconc.mjs --break sharefold # a fold ignores whose Diamond is busy
//   node dev/verify_daimonconc.mjs                   # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const die = (why) => { console.error('ABORT: ' + why); process.exit(2); };

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const BREAKS = {
	oneflag: {
		what: 'one busy flag for the whole app, so a second daimon queues behind the first',
		edit: (src) => src.replace(
			'\t\t\tif (diamondBusy(current.diamondId)) { enqueueMessage(current, text); return; }',
			'\t\t\tif (anyCrystalBusy()) { enqueueMessage(current, text); return; }'),
	},
	onceonly: {
		what: 'the Agents panel reveals once ever, as it did',
		edit: (src) => src.replace(
			'\tfunction revealAgents() {\n\t\tif (agentsPushedAway) return;',
			'\tfunction revealAgents() {\n\t\tif (agentsPushedAway) return;\n'
			+ '\t\tif (localStorage.getItem(\'daimond-agents-revealed\') === \'1\') return;\n'
			+ '\t\tlocalStorage.setItem(\'daimond-agents-revealed\', \'1\');'),
	},
	noveto: {
		what: 'a panel the user has just closed is opened again by the next dispatch',
		edit: (src) => src.replace(
			'\tfunction revealAgents() {\n\t\tif (agentsPushedAway) return;',
			'\tfunction revealAgents() {'),
	},
	sharefold: {
		what: 'a fold does not ask whether its target Diamond is already mid-turn',
		edit: (src) => src.replace(
			'\t\tif (diamondBusy(diamondId)) {\n'
			+ '\t\t\tnoticeDialog(t(\'fold.busy_title\'), t(\'fold.busy_body\', { diamond: f.name }));\n'
			+ '\t\t\treturn;\n'
			+ '\t\t}\n'
			+ '\t\tawait selectDiamond(f);                          // switch the centre to the Diamond crystal',
			'\t\tawait selectDiamond(f);                          // switch the centre to the Diamond crystal'),
	},
};
if (BREAK && !BREAKS[BREAK]) die(`no break called "${BREAK}"`);
if (BREAK) console.log(`\n*** BREAK ${BREAK}: ${BREAKS[BREAK].what} — failures below are the point ***\n`);

const SRC = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
const BROKEN = BREAKS[BREAK] ? BREAKS[BREAK].edit(SRC) : SRC;
if (BREAK && BROKEN === SRC) die(`the "${BREAK}" break no longer matches www/js/daimond.js`);

const s = await open({
	name:  'daimonconc' + (BREAK ? '-' + BREAK : ''),
	route: BREAK ? (async (page) => {
		await page.route('**/js/daimond.js', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: BROKEN,
		}));
	}) : null,
});
const p = s.page;
await p.waitForFunction(() => !!window.DaimondDiamond && !!window.DaimondPanels, null, { timeout: 20000 });

const [A, B] = await p.evaluate(() =>
	[...document.querySelectorAll('#diamond-list .diamond-box')].map(b => b.dataset.id));
if (!A || !B) die('this world does not hold the two seeded Diamonds');
// THIS WORLD SEEDS A PAUSED DIAMOND, and a paused one dispatches nothing at all:
// `governorClearsDispatch` refuses at `root/diamonds/<id>/self` before
// `Workers.dispatch` is reached, so §5 would be measuring the pause tree and
// calling it the Agents panel. Both are set playing here, in the app's own words.
await p.evaluate((ids) => {
	if (!window.DaimondPause) return;
	ids.forEach((i) => DaimondPause.set(DaimondPause.id('root', 'diamonds', i, 'self'), true));
	DaimondPause.set(DaimondPause.id('root', 'workers'), true);
}, [A, B]);
await p.waitForTimeout(300);

// The name as the FOLD MENU spells it, which is `f.name` — asked of the app
// rather than scraped off a tile, whose text also carries a meter and a badge.

const goDiamond = async (id) => {
	await p.evaluate((i) => {
		document.querySelector(`#diamond-list .diamond-box[data-id="${i}"]`).click();
	}, id);
	await p.waitForTimeout(500);
};
const say = (text) => p.evaluate((t) => {
	const el = document.getElementById('chat-input');
	el.value = t;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	document.getElementById('chat-send').click();
}, text);
/// What a daimon's own record says about itself. Asked of the CONVERSATION rather
/// than of the screen: a turn that is running is running whether or not anybody is
/// looking at it, and that distinction is the whole subject of this file.
const state = (id) => p.evaluate((i) => {
	const c = window.DaimondDiamond.conversation(i);
	return {
		gen:   !!c._generating,
		queue: (c._queue || []).slice(),
		text:  (c.messages || []).map(m => String(m.content || '')).join(' | '),
	};
}, id);
/// Wait until a daimon is idle AND holding nothing: a queue that drains starts a
/// turn of its own, so "not generating" alone is a moment, not a state.
const settle = async (id, ms = 60000) => {
	const t0 = Date.now();
	for (;;) {
		const st = await state(id);
		if (!st.gen && st.queue.length === 0) {
			await p.waitForTimeout(400);
			const again = await state(id);
			if (!again.gen && again.queue.length === 0) return again;
		}
		if (Date.now() - t0 > ms) return st;
		await p.waitForTimeout(250);
	}
};

/// Wait for a predicate on a daimon's record, or give up.
const until = async (id, f, ms = 30000) => {
	const t0 = Date.now();
	for (;;) {
		const st = await state(id);
		if (f(st)) return st;
		if (Date.now() - t0 > ms) return st;
		await p.waitForTimeout(250);
	}
};

// ── 1. TWO DAIMONS RUN AT ONCE ─────────────────────────────────────
//
// The overlap is the claim, so it is measured as an overlap: B's own record must
// say it is generating AT A MOMENT WHEN A's still does. A check that only waited
// for B's answer would pass on a queue that drained a minute later.
console.log('\n1. a second daimon starts while the first is still running\n');
await goDiamond(A);
const AName = await p.evaluate(() => (window.DaimondDiamond.current() || {}).name || '');
if (!AName) die('the app will not name the Diamond that is open');
// A label after the number is legal again as of 2026-08-28: `numArg` in
// dev/mockllm.mjs reads the FIRST token and refuses anything it cannot parse, where
// `Number(d.rest)` used to read the whole line, make NaN of `@slow 9000 A-ANSWER`
// and fall back to its 2-second default. That was long enough to pass §1 by luck and
// far too short for §4, where it cost an afternoon. Nothing here needs the label --
// A's turn is told apart by its own user message -- so this stays as it is, and the
// paragraph stays as the record of why it was written.
await say('@slow 9000');
await p.waitForTimeout(900);
// THE CONTROL. Nothing below means anything unless A really was mid-turn.
check('the control: daimon A is mid-turn before B is prompted',
	(await state(A)).gen);

await goDiamond(B);
await say('@text B-ANSWER');
// B's turn is a round trip through the mock, so it is awaited rather than assumed
// -- but only for as long as A is still going, which is what makes it an overlap.
let overlap = null;
{
	const t0 = Date.now();
	while (Date.now() - t0 < 8000) {
		const [a, b] = [await state(A), await state(B)];
		if (a.gen && b.gen) { overlap = { a, b }; break; }
		if (!a.gen) break;                       // A finished first: no overlap to catch
		await p.waitForTimeout(120);
	}
}
check('B\'s turn is in flight while A\'s still is — they overlap',
	!!overlap, overlap ? 'both _generating' : JSON.stringify({ a: await state(A), b: await state(B) }));
check('nothing was queued on B: the prompt went, it did not wait',
	(await state(B)).queue.length === 0, JSON.stringify((await state(B)).queue));
await shot(s, 'daimonconc-overlap');

// ── 2. AND B'S ANSWER ARRIVES, IN B'S OWN THREAD ───────────────────
//
// The half a queue could never reach: before the fix B's message sat unsent even
// after A finished, because the drain runs at the end of the turn it waited on and
// that turn was A's. So this asserts an ANSWER, not merely an empty queue.
console.log('\n2. B answers, in B\'s thread, and A\'s answer stays in A\'s\n');
{
	const b = await until(B, (st) => !st.gen && /B-ANSWER/.test(st.text));
	check('B has its own answer', /B-ANSWER/.test(b.text), b.text.slice(0, 160));
	const a = await until(A, (st) => !st.gen, 30000);
	check('A finished too', !a.gen);
	check('B\'s words are not in A\'s thread', !/B-ANSWER/.test(a.text), a.text.slice(0, 160));
	check('A\'s words are not in B\'s thread',
		!/@slow/.test((await state(B)).text), (await state(B)).text.slice(0, 160));
}

// ── 3. ONE TURN PER DIAMOND, WHICH IS THE PART THAT IS DELIBERATE ──
console.log('\n3. a daimon still queues behind its OWN turn\n');
await goDiamond(A);
await say('@slow 6000');
await p.waitForTimeout(900);
check('the control: A is mid-turn again', (await state(A)).gen);
await say('held one');
await p.waitForTimeout(400);
check('a second message to the SAME daimon is held, not sent',
	(await state(A)).queue.length === 1, JSON.stringify((await state(A)).queue));
check('and the composer was cleared, so the press did something visible',
	(await p.evaluate(() => document.getElementById('chat-input').value)) === '');

// ── 4. THE FOLD CONTROLS, AND WHOSE TURN THEY ANSWER FOR ───────────
//
// `setCrystalBusy` used to disable `#chat-fold-btn` for the whole app, so a
// Diamond quietly steering in the background left the control that compacts a
// CHAT'S OWN CONTEXT dead on a chat with nothing to do with it. It answers for
// the conversation the composer is on now.
//
// The exclusion that is real -- one writer per crystal, since a fold and a steer
// both rewrite `crystal.json` -- is kept, and is said in words where the target is
// known: the picker off the rail tile.
//
// The chat turn run here beside a steering daimon is also the other half of note
// 14, which names chats as well as daimons.
console.log('\n4. the fold controls answer for the right conversation\n');
{
	await goDiamond(A);
	await settle(A);
	await say('@slow 9000');
	await p.waitForTimeout(900);
	check('the control: A is steering in the background', (await state(A)).gen);

	// A chat of its own, given something to say so its tile carries controls.
	// Through the harness, which presses the tile's Start: a chat left `pending`
	// draws no controls at all, and the picker would then be missing for a reason
	// that has nothing to do with this file.
	await newChat(s);
	await say('@text CHAT-ANSWER');
	const answered = await (async () => {
		const t0 = Date.now();
		while (Date.now() - t0 < 20000) {
			const got = await p.evaluate(() => (document.getElementById('chat-output') || {}).textContent || '');
			if (/CHAT-ANSWER/.test(got)) return true;
			await p.waitForTimeout(250);
		}
		return false;
	})();
	check('a chat answers while a daimon is mid-turn — chats and daimons are independent too',
		answered);
	check('and the daimon was still running when it did', (await state(A)).gen);

	const fold = await p.evaluate(() => {
		const b = document.getElementById('chat-fold-btn');
		return b ? { shown: b.style.display !== 'none', disabled: !!b.disabled } : null;
	});
	check('the chat\'s own Fold control is offered', !!(fold && fold.shown), JSON.stringify(fold));
	check('and it is NOT disabled by another Diamond\'s turn',
		!!(fold && !fold.disabled), JSON.stringify(fold));

	// ── Folding this chat INTO the busy Diamond ────────────────
	//
	// A FRESH steer, started here rather than relied on from above: everything
	// between the two is a real round trip through the mock, and a check that
	// depends on the first one still running is a check on how fast the machine is.
	// Max, because Simple draws no tile controls at all, so the picker would be off
	// screen for a reason that is not this one.
	await settle(A);
	const chatTile = await p.evaluate(() =>
		(document.querySelector('#session-list .session-box.active') || {}).dataset?.id || '');
	await goDiamond(A);
	await say('@slow 25000');
	await p.waitForTimeout(800);
	check('the control: A is mid-turn when the fold is attempted', (await state(A)).gen);
	const wasView = await p.evaluate(() => window.DaimondView && window.DaimondView.get
		? window.DaimondView.get() : '');
	await p.evaluate(() => window.DaimondView && window.DaimondView.set('max'));
	await p.waitForTimeout(400);
	await p.evaluate((id) => {
		const t = document.querySelector(`#session-list .session-box[data-id="${id}"] .tile-label`)
			|| document.querySelector(`#session-list .session-box[data-id="${id}"]`);
		if (t) t.click();
	}, chatTile);
	await p.waitForTimeout(600);
	await p.evaluate(() => {
		const b = document.querySelector('#session-list .session-box.active .tile-fold')
			|| document.querySelector('#session-list .tile-fold');
		if (b) b.click();
	});
	await p.waitForTimeout(400);
	const picked = await p.evaluate((name) => {
		const items = [...document.querySelectorAll('.fold-menu .fold-menu-item')];
		const want = items.find(i => (i.textContent || '').trim() === name);
		if (!want) return { ok: false, saw: items.map(i => (i.textContent || '').trim()) };
		want.click();
		return { ok: true };
	}, AName);
	if (!picked.ok) {
		check('the fold menu offers the busy Diamond', false,
			`wanted ${JSON.stringify(AName)}, saw ${JSON.stringify(picked.saw)}`);
	} else {
		await p.waitForTimeout(700);
		const dlg = await p.evaluate(() => {
			const d = document.querySelector('.modal.dlg');
			return d ? (d.textContent || '') : '';
		});
		check('folding into a Diamond that is mid-turn answers with a notice, not a silent nothing',
			dlg.length > 0, dlg.slice(0, 200));
		check('and the notice names the Diamond it refused', dlg.includes(AName), dlg.slice(0, 200));
		await p.evaluate(() => {
			const d = document.querySelector('.modal.dlg');
			const b = d && d.querySelector('button');
			if (b) b.click();
		});
		await p.waitForTimeout(300);
	}
	await p.evaluate((v) => window.DaimondView && window.DaimondView.set(v || 'simple'), wasView);
	await p.waitForTimeout(400);
	// A 25-second steer is not worth waiting out, and Stop is the app's own door.
	await goDiamond(A);
	await p.evaluate(() => {
		const b = document.getElementById('chat-send');
		if (b && /stop/i.test(b.getAttribute('aria-label') || b.title || '')) b.click();
	});
	await settle(A);
}


// ── 5. THE AGENTS PANEL OPENS EVERY TIME WORK STARTS ───────────────
//
// Twice, with a close in between, because once-ever passes the first half.
console.log('\n5. the Agents panel opens when a fan-out starts — every time\n');
const agentsOpen = () => p.evaluate(() => window.DaimondPanels.isOpen('agents'));
/// Wait for the panel to reach a state, and answer with what it actually did.
/// A fixed sleep here would make the check a measure of machine load: a fan-out
/// is a tool round trip through the mock and then a worker being enqueued.
const panelSettles = async (want, ms = 20000) => {
	const t0 = Date.now();
	for (;;) {
		const now = await agentsOpen();
		if (now === want || Date.now() - t0 > ms) return now;
		await p.waitForTimeout(200);
	}
};
/// Is the dock carrying live work? `#agents-count` is written on every render
/// whether or not the panel is seated, so this reads the same fact the panel does
/// without needing it on screen.
const workersLive = () => p.evaluate(() =>
	((document.getElementById('agents-count') || {}).textContent || '').trim().length > 0);
const closeAgents = () => p.evaluate(() => {
	// Through the CLOSER a person presses, not through the engine: the app closes
	// panels itself for reasons of its own, and only a hand means "not this".
	const b = document.querySelector('[data-close="agents"]');
	if (b) b.click(); else window.DaimondPanels.hide('agents');
});
const fanOut = async (id, name) => {
	await goDiamond(id);
	await settle(id);            // a Diamond still holding a queue would queue this too
	// The task is what the WORKER is prompted with, and the mock reads its
	// directives from that — so a slow worker is how a live batch becomes a state
	// this file can stand in rather than a flicker it has to catch.
	await say(`@tool spawn_agent {"name":"${name}","task":"@slow 5000"}`);
};
const dockQuiet = async (ms = 90000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (!(await p.evaluate(() => window.DaimondCore.busy()))) return true;
		await p.waitForTimeout(300);
	}
	return false;
};

await p.evaluate(() => window.DaimondPanels.hide('agents'));
await p.waitForTimeout(200);
check('the control: the Agents panel is shut before the first fan-out',
	(await agentsOpen()) === false);
await fanOut(A, 'wk1');
check('the first fan-out opens it', (await panelSettles(true)) === true);
await shot(s, 'daimonconc-agents-1');

// Wait for the dock to fall quiet, then shut the panel while nothing is running:
// a tidy-up between batches is not a veto on the next batch.
await dockQuiet();
await closeAgents();
await p.waitForTimeout(300);
check('the control: it is shut again, by hand, with nothing running',
	(await agentsOpen()) === false);
await fanOut(B, 'wk2');
check('THE SECOND fan-out opens it too — this is note 10',
	(await panelSettles(true)) === true);
await shot(s, 'daimonconc-agents-2');

// ── 6. AND IT DOES NOT ARGUE ───────────────────────────────────────
//
// Closed while workers are running, it stays closed until they are done. Without
// this the fix above becomes a panel that reappears every time it is dismissed.
console.log('\n6. a panel pushed away while work runs is left alone\n');
{
	await dockQuiet();
	await fanOut(A, 'wk3');
	// Closed WHILE the batch is live, which is what makes it a refusal rather than
	// a tidy-up. Waited for on the dock's own count, not on a clock.
	let live = false;
	{
		const t0 = Date.now();
		while (Date.now() - t0 < 30000) {
			if (await workersLive()) { live = true; break; }
			await p.waitForTimeout(150);
		}
	}
	check('the control: workers really were running when the panel was closed', live);
	await closeAgents();
	await p.waitForTimeout(200);
	await fanOut(B, 'wk4');
	check('a panel pushed away mid-batch is not reopened under the user',
		(await panelSettles(true, 6000)) === false);
	// And the refusal expires with the batch: it was about that work, not for ever.
	await dockQuiet();
	await p.waitForTimeout(600);
	await fanOut(A, 'wk5');
	check('and once the dock is quiet again, the next fan-out opens it',
		(await panelSettles(true)) === true);
}

const errs = errors(s).filter(e => !/favicon|401|402|502|Unauthorized|Payment|Bad Gateway/i.test(e));
check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await s.close();

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) console.log('  ' + bad.join('\n  '));
if (BREAK) {
	console.log(bad.length
		? '\nTHE BREAK WAS CAUGHT.'
		: '\nTHE BREAK WAS NOT CAUGHT: this check proves nothing');
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
