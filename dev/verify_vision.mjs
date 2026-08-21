// verify_vision.mjs — a worker that is shown a picture ends up on a model that can
// see it, is billed for both halves, and says so on screen.
//
// WRITTEN BEFORE THE FIX, AND EXPECTED TO BE RED. Defect AA in
// dev/DEFECTS_20260821.md and the design in dev/DESIGN_VISION.md; nothing in §7 of
// that design is implemented at the time of writing. A verifier written after a fix
// asserts what the fix happens to do. This one asserts what was wanted, so the checks
// below are the specification and their failures are the defect, quoted.
//
// THE DEFECT. `Workers.routeFor` decides which model a worker runs on with
// `sees = !supplied && taskWantsVision(task)`, and `taskWantsVision` is nothing but
// `IMAGE_EXT.test(task)` — four extensions, matched against the TASK TEXT. So a worker
// that will certainly be shown a picture runs on the text model unless the daimon
// happened to spell a filename into the task; it then reads the image, the provider
// refuses it, and `LlmClient` quietly takes the pictures out and carries on answering
// about something it cannot see. That is what cost A$17 on 2026-08-20, and the only
// disclosure of it was a `title` attribute.
//
// FOUND WHILE BUILDING THIS, AND WORSE THAN THE DEFECT AS WRITTEN: the spelling rule
// does not run at all. `routeFor`'s first line is
//
//     var sees = !supplied && taskWantsVision(task);
//
// and `supplied` is `!!(pick && pick.model)` where `pick` is `dispatch`'s fifth
// argument. `dispatch` has exactly two callers — the daimon's, which passes
// `diamondWorkerModel(diamondId)`, and the chat's, which passes
// `chatWorkerModel(chat)` — and neither can return a pair without a model. So
// `supplied` is TRUE on every dispatch that exists, `sees` is always false, and
// `taskWantsVision`, `IMAGE_EXT` and `diamondVisionModel` decide nothing: `vm` is
// resolved, passed in, and never read. A task that DOES spell `shot.png` goes to the
// text model exactly like one that does not.
//
// It was not noticed because `dev/verify_diamondmodels.mjs:500-540` tests the rule
// through `Workers.routeForDiamond`, which hardcodes `supplied` to FALSE — a path
// production never takes. `routeForDiamond` is called by nothing under `www/` at all;
// its only callers are those two lines of that verifier, and its own doc comment says
// so: "What a verifier drives, and what a future settings preview would." The rule is
// correct, tested twice over, and reachable only from the test harness. BUILT BUT
// UNREACHABLE, and "true of the code, wrong about the reader", in one object.
//
// The measurement, rather than the argument: `--break always` was first written as
// `var sees = !supplied;` and changed nothing at all — no check moved, the worker still
// ran on the text model, and `run.sees` was still false. A patch that cannot change the
// answer proves the term it patched was already dead.
//
// CHECK 7 BELOW IS THE ONE THAT WOULD HAVE CAUGHT THIS, and it is why there are seven
// rather than the six DESIGN_VISION.md asks for. It puts a task naming a picture
// through the door `dispatch` actually opens, rather than through the rule's own
// method. The two green tests that cover this today both drive doors production never
// opens, which is exactly how a rule stays correct and dead for as long as it likes.
//
// SEVEN PROPERTIES — six from DESIGN_VISION.md §7 "Proof", and one the building of it
// turned up:
//
//   1. THE WORK MOVED TO THE IMAGE MODEL. The second leg names the Diamond's image
//      model and carries a picture; the first leg never reached that model, and the
//      picture it did carry was refused.
//   2. AND IT MOVED ONCE. A Diamond whose IMAGE model is itself blind does not
//      ping-pong: two legs, and no third.
//   3. AND EACH LEG IS BILLED TO THE MODEL THAT SPENT IT, both against one Diamond.
//   4. AND IT IS DISCLOSED ON SCREEN, WITHOUT HOVERING. The check that makes 1-3 mean
//      something: a re-route nobody can see is the silent fallback again with more
//      machinery behind it.
//   5. AND THE SECOND LEG IS A RESUME, not a restart from the top.
//   6. BUT A TASK CARRYING NO PICTURE IS UNTOUCHED. The check that stops "always
//      switch to the image model" from passing 1-5.
//   7. AND A TASK THAT NAMES A PICTURE REACHES THE IMAGE MODEL THROUGH THE DOOR
//      `dispatch` ACTUALLY USES. Not one of the design's six, and not fixed by the
//      design either: §7 adds a capability re-route and never touches `supplied`, so
//      this one stays red after that fix lands. That is the point of it — a check that
//      survives the approved design is the check that says the design is incomplete.
//
// ── THE BREAKS, AND WHICH OF THEM CAN BE PROVED TODAY ─────────────────────────
//
// House discipline is that a check is proved by reddening it on purpose first. Four
// of these six breaks patch lines the fix has not written yet, so they cannot be
// applied and REFUSE, naming the line they wanted. That is deliberate: the break table
// is the other half of the specification, and a break that silently patched nothing
// would be worse than one that says it could not.
//
// TWO GATES, not one, and the second was earned. `bill-after`'s anchor — `recordSpend`
// in the worker's `finally` — is in the file TODAY, so the anchor test passed it and it
// would have patched in an `if (run._reroute)` that is false for ever: a run identical
// to a plain one, reported under a break name. So a break may also declare what its
// PATCH depends on, and is refused when that is missing.
//
//   node dev/verify_vision.mjs --break spelling    1 (and 2-5) — routing by IMAGE_EXT
//                                                  alone, which is the tree as it
//                                                  stands: patches NOTHING and is
//                                                  simply a plain run under a name.
//   node dev/verify_vision.mjs --break always      6 — every worker is routed to the
//                                                  image model. LIVE TODAY: it patches
//                                                  `routeFor`, which exists.
//   node dev/verify_vision.mjs --break loop        2 — REFUSES until the fix lands.
//   node dev/verify_vision.mjs --break bill-after  3 — REFUSES until the fix lands.
//   node dev/verify_vision.mjs --break silent      4 — REFUSES until the fix lands.
//   node dev/verify_vision.mjs --break restart     5 — REFUSES until the fix lands.
//
// Check 7 has no break of its own, because it is red on the tree as shipped: a break
// for it would be a patch that made it GREEN, which is a fix and not a break.
//
// One break does not redden one check. `always` reddens 6 AND 1, because routing is
// upstream of everything; `spelling` reddens 1 through 5, and 7 with them.
// DESIGN_VISION.md's table says otherwise and is wrong about it — see the report
// accompanying this file.
//
// ── WHAT THIS FILE CANNOT YET DISTINGUISH ────────────────────────────────────
//
// Check 4 looks for a DISCLOSURE on the worker tile and the fix has not written one,
// so it cannot name a class. It therefore asserts a property no class name can dodge —
// the tile's own visible text names both the model the worker left and the model it
// moved to — and it prints the tile's whole visible text and every `title` attribute
// in it when it fails, so the failure reads as "the tile says nothing; the only
// mention of the image model is a tooltip" rather than "selector not found". If an
// implementer discloses the move by naming ONLY the destination model, this check will
// redden on a fix that is arguably correct: naming the destination alone does not tell
// a reader that anything moved, which is why it is asked for, but it is a judgement
// and it is written down here rather than hidden in a selector.
//
// Check 5 asserts the SHAPE of the second leg's first request — that its last user
// message is not the bare task, and that it carries the worker's own earlier words.
// The design's stronger sentence, "a worker that already wrote a file must not write
// it twice", is not asserted, and cannot honestly be: whether a model repeats work it
// can see it already did is a property of the model, and this one is a script. What IS
// app-level is restart-versus-resume, and that is what is measured.
//
// AND UNTIL SOMETHING MOVES A WORKER, CHECK 5 CANNOT SPEAK FOR ITSELF. There is no
// second leg to look at, so it reports that, which is honest but is a consequence of
// check 1 rather than a measurement of its own. It becomes a real check the moment the
// re-route exists, and not before.
//
//   eval "$(bash dev/world.sh 5 --up)"
//   node dev/verify_vision.mjs
//
// Needs dev/serve.mjs and dev/mockllm.mjs — the mock with model-name blindness
// (`mock/blind` refuses a picture, `mock/eyes` takes it, at ONE endpoint). The
// preflight refuses if the mock answering this world is an older one, because every
// check below would then be measuring a fixture that is not there. No gateway, no wasm
// rebuild: the branch under test is JavaScript.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, steerDiamond, scratch, shot, mockLog, clearMockLog, MOCK } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const SRC  = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
const MOCK_LOG_PATH = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');

// The two blind models and the sighted one. `mock/blind-too` is never listed by the
// mock's catalogue and does not need to be: blindness is a property of the NAME, and
// `DaimondModels.resolve` will resolve any id under a provider that holds a key.
const TEXT_MODEL   = 'mock/blind';
const VISION_MODEL = 'mock/eyes';
const BLIND_VISION = 'mock/blind-too';

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
//
// Each is an anchor in js/daimond.js and what to put in its place, served over the
// real file through `page.route` so the page under test is the shipped page with one
// line changed. An anchor that is not in the file EXACTLY ONCE stops the run: a break
// that patches nothing would produce a green page under a red name, which is the
// failure this whole file exists to avoid.
const BREAKS = {
	// The tree as it stands. There is nothing to patch, because the defect is the
	// current behaviour: routing by spelling and no re-route at all.
	spelling: {
		anchor:  'var sees = !supplied && taskWantsVision(task);',
		patched: 'var sees = !supplied && taskWantsVision(task);',
		why:     'the routing rule as shipped — this break patches NOTHING and is the '
			+ 'defect itself, run under a name so the table in DESIGN_VISION.md has a '
			+ 'row that can be executed',
	},
	// The plausible over-correction: send every worker to the image model. Checks 1-5
	// would pass and the bill would double for the nineteen workers in twenty that
	// never look at anything.
	always: {
		anchor:  'var sees = !supplied && taskWantsVision(task);',
		patched: 'var sees = true;',
		why:     'every worker is routed to the image model, whatever it was asked to do',
		// `!supplied` was the first spelling of this break and it changed NOTHING, which
		// is how the finding below was made: `supplied` is true on every dispatch there
		// is, so the whole right-hand side of that line is already dead. The break has to
		// overwrite the lot.
	},
	// ── Below here the anchors belong to code that does not exist yet ──
	//
	// Each names the line DESIGN_VISION.md §7 item 5 asks for. They will refuse until
	// that line is written, and the refusal names it, so the implementer is told what
	// this file will patch rather than being left to guess.
	loop: {
		anchor:  'if (run._reroute) return;',
		patched: 'if (false) return;',
		why:     'the once-per-run guard on the re-route is dropped, so a blind image '
			+ 'model is moved to again and again',
	},
	'bill-after': {
		// ITS ANCHOR IS ALREADY IN THE FILE — `recordSpend`'s call in the worker
		// `finally` is live today — so the anchor test alone lets this break through and
		// it then patches in an `if (run._reroute)` that is false for ever. It would run
		// clean, look exactly like a plain run, and report check 3 red under a break name
		// that had done nothing. `needs` is the second gate: the break is refused until
		// the field its patch depends on exists.
		needs:   'run._reroute',
		anchor:  'recordSpend(run.model, _pt, _ct, _ca, _cost, run.provider, run.diamondId || \'\');',
		patched: 'if (run._reroute) { run.model = run._reroute.to.model; run.provider = run._reroute.to.provider; }\n\t\t\t\t'
			+ 'recordSpend(run.model, _pt, _ct, _ca, _cost, run.provider, run.diamondId || \'\');',
		why:     'the model is swapped BEFORE the spend is recorded, so the wasted first '
			+ 'leg is billed to the image model — the same class of lie as defect A',
	},
	silent: {
		anchor:  'run.reroutedFrom',
		patched: 'run.__no_such_field',
		why:     'the tile stops knowing it was re-routed, so the disclosure falls back '
			+ 'to the tooltip it was before',
	},
	restart: {
		anchor:  'Workers.reroute',
		patched: 'Workers.__restartFromTheTop',
		why:     'the second leg is built fresh and run from the task again, repeating '
			+ 'every side effect the first leg had already had',
	},
};

const BREAK = (() => {
	const eq = process.argv.find(a => a.startsWith('--break='));
	if (eq) return eq.split('=')[1];
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}
if (BREAK) {
	const b = BREAKS[BREAK];
	// An anchor that is present is not the same as a break that can bite: a patch may
	// depend on a field the fix has not written. Both gates, and the same refusal.
	if (b.needs && !SRC.includes(b.needs)) {
		console.error(`\n  REFUSED  --break ${BREAK} would patch nothing.`);
		console.error(`  Its anchor is in the file, but the patch depends on ${JSON.stringify(b.needs)},`);
		console.error('  which is not. Applying it would produce a run indistinguishable from a');
		console.error('  plain one, under a break name — the exact thing this file exists to stop.');
		console.error(`  What it is for: ${b.why}.\n`);
		process.exit(2);
	}
	const n = SRC.split(b.anchor).length - 1;
	if (n !== 1) {
		console.error(`\n  REFUSED  --break ${BREAK} cannot be applied.`);
		console.error(`  It patches: ${JSON.stringify(b.anchor)}`);
		console.error(`  which is in www/js/daimond.js ${n} time(s), not once.`);
		console.error(`  What it is for: ${b.why}.`);
		console.error('  If this is one of the four breaks that belong to the vision fix,');
		console.error('  the fix has not landed yet and there is nothing to break. Running');
		console.error('  the file with no --break measures the defect, which is the point');
		console.error('  of it today.\n');
		process.exit(2);
	}
}

// ── The routing rule, read out of the app rather than copied ─────────
//
// Check 1's whole premise is that its task names NO image, so today's rule sends the
// worker to the text model and only a capability signal could move it. A copy of the
// regex here would go stale the moment somebody widened the real one — which §5 of the
// design argues against and somebody will eventually try anyway — and this file would
// then be proving something about a rule the app no longer uses.
const IMAGE_EXT = (() => {
	const m = /var IMAGE_EXT = (\/.*\/[a-z]*);/.exec(SRC);
	if (!m) {
		console.error('IMAGE_EXT is not in www/js/daimond.js where this file reads it. '
			+ 'Check 1 cannot state its own premise, so nothing below would mean anything.');
		process.exit(2);
	}
	return new Function('return ' + m[1])();
})();

// ── Preflight: is the mock this run reads the mock this run drives, and is it
//    the one that knows how to be blind? ───────────────────────────────
//
// Both halves, because either alone is the failure this suite has been burned by.
// A mock writing to a log nobody reads makes every check below report "the model was
// never called"; a mock from before this fixture existed answers 200 to a picture on
// `mock/blind`, so the worker never learns anything, no event is ever emitted, and six
// checks fail with a story about the app that is entirely about the fixture.
{
	const before = mockLog().length;
	let why = '';
	try {
		const r = await fetch(MOCK, {
			method:  'POST',
			headers: { 'content-type': 'application/json' },
			body:    JSON.stringify({ model: 'mock/fast', stream: false,
				messages: [{ role: 'user', content: 'vision-preflight-probe' }] }),
		});
		if (!r.ok) why = `the mock answered ${r.status}`;
		else {
			await r.text();
			if (mockLog().length <= before) why = 'the probe was not written to the log';
		}
	} catch (e) {
		why = 'the mock could not be reached: ' + e.message;
	}
	if (!why) {
		// The fixture itself: a picture on a blind model must come back 400, in the
		// provider's own words about `image_url`, because that is the shape
		// `LlmClient::stream_turn` learns blindness from.
		try {
			const r = await fetch(MOCK, {
				method:  'POST',
				headers: { 'content-type': 'application/json' },
				body:    JSON.stringify({ model: TEXT_MODEL, stream: false, messages: [{
					role: 'user', content: [
						{ type: 'text', text: 'look' },
						{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
					] }] }),
			});
			const body = await r.text();
			if (r.status !== 400 || !/image_url/.test(body)) {
				why = `${TEXT_MODEL} answered ${r.status} to a picture instead of refusing it — `
					+ 'this mock predates the vision fixture in dev/mockllm.mjs';
			}
		} catch (e) {
			why = 'the blindness probe could not be sent: ' + e.message;
		}
	}
	if (why) {
		console.log('  REFUSED ' + why);
		console.log(`  driving:  ${MOCK}`);
		console.log(`  reading:  ${MOCK_LOG_PATH}`);
		console.log('  Nothing below could measure the app: it would measure the fixture.');
		console.log('  `bash dev/world.sh N --down` then --up, from THIS worktree.');
		process.exit(2);
	}
}

// ── Reading the wire ─────────────────────────────────────────────────

/// Whether a logged request is a WORKER's turn on `task` rather than the daimon's own
/// turn about it.
///
/// The daimon's transcript quotes the task inside its `spawn_agent` call, so every
/// round of the dispatching turn mentions it. A worker's turn is the one where the task
/// IS a user message — and a RESUMED worker's session is seeded with that same user
/// message, which is exactly why it is the right test: both legs of one worker match,
/// and the daimon never does.
const isWorkerTurn = (e, task) => (e.messages || []).some(
	(m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim() === task);

/// Every request one worker's task produced, oldest first.
const turnsFor = (task) => mockLog().filter((e) => isWorkerTurn(e, task));

/// The legs of one worker: consecutive requests grouped by the model they named.
///
/// A leg is a session on one model. Two legs is a re-route; one is the defect; three
/// or more is a ping-pong. Grouping by RUNS of the same model rather than by the set of
/// models is what tells the last two apart.
const legsOf = (task) => {
	const out = [];
	for (const e of turnsFor(task)) {
		const last = out[out.length - 1];
		if (last && last.model === e.model) last.reqs.push(e);
		else out.push({ model: e.model, reqs: [e] });
	}
	return out.map((l) => ({
		model:    l.model,
		reqs:     l.reqs,
		images:   l.reqs.reduce((n, e) => n + (e.images || 0), 0),
		refused:  l.reqs.filter((e) => e.refusedImages).length,
	}));
};

const legLine = (task) => legsOf(task)
	.map((l, i) => `leg ${i + 1}: ${l.model}, ${l.reqs.length} req, ${l.images} image(s)`
		+ (l.refused ? `, ${l.refused} refused` : ''))
	.join(' | ') || 'no worker turn reached the mock at all';

/// Wait for a condition, polling.
const until = async (fn, ms = 60000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return true;
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
};

// ── The session ──────────────────────────────────────────────────────

const s = await open({
	name:    'vision',
	profile: scratch('pw', 'vision' + (BREAK ? '-' + BREAK : '')),
	// The damaged file in place of the real one, registered before `goto`.
	route:   (BREAK && BREAKS[BREAK].patched !== BREAKS[BREAK].anchor) ? (async (page) => {
		const body = SRC.replace(BREAKS[BREAK].anchor, BREAKS[BREAK].patched);
		await page.route('**/js/daimond.js', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}) : null,
});
const p = s.page;
if (BREAK) {
	console.log(`\n*** RUNNING UNDER --break ${BREAK}: ${BREAKS[BREAK].why}.`);
	if (BREAKS[BREAK].patched === BREAKS[BREAK].anchor) {
		console.log('*** This break patches nothing: it IS the shipped behaviour.');
	}
	console.log('*** Failures below are the point ***\n');
}

/// A 2x3 PNG, byte for byte the one dev/verify_fileview.mjs uses, so what the app
/// sniffs is a real picture and not a signature with filler behind it.
const PNG = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
	0x08, 0x02, 0x00, 0x00, 0x00, 0x36, 0x88, 0x49, 0xd6, 0x00, 0x00, 0x00,
	0x10, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xf8, 0xcf, 0x00, 0x04,
	0xff, 0x19, 0x50, 0x28, 0x00, 0x3e, 0xd6, 0x05, 0xfb, 0xb6, 0xd6, 0xf9,
	0xda, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60,
	0x82,
];

/// Put bytes in the workspace through the engine's own door, as dev/verify_fileview
/// does: it applies the path jail and the per-account namespace, and a hand-rolled
/// OPFS walk would write somewhere the worker's fence does not reach.
const put = (file, bytes) => p.evaluate(async ({ file, bytes }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_bytes(file, new Uint8Array(bytes));
}, { file, bytes });

/// Shut the Admin drawer if it is open.
///
/// It opens over the rail, so the `+` buttons sit UNDER it and a click on one is
/// swallowed by `.admin-drawer-head` — which Playwright reports as a timeout on a
/// button it can plainly see. It matters on the SECOND run of a fixed profile, because
/// the drawer's state is remembered: run one is fresh and green, run two dies on a
/// button, and the difference is not in the app.
///
/// THE HARNESS ALREADY KNEW. `harness.newChat` has closed this drawer, with the reason
/// written beside it, since long before this file existed; this file reached past the
/// harness for the rail and re-met the trap on its own. Reach for the harness first —
/// it is the same failure as writing a helper without searching for the machinery that
/// already does the job, and that one was walked past twice more the same night.
const closeAdmin = async () => {
	const btn = p.locator('#admin-close');
	if (await btn.isVisible().catch(() => false)) {
		await btn.click({ force: true });
		await p.waitForTimeout(300);
	}
};

/// Make a Diamond through the real dialog and answer its id.
const newDiamond = async (name) => {
	await closeAdmin();
	await p.click('#new-diamond-btn');
	await p.waitForSelector('.dlg-input', { timeout: 8000 });
	await p.fill('.dlg-input', name);
	await p.click('.dlg-ok');
	await p.waitForTimeout(1200);
	return p.evaluate(() => {
		const f = window.DaimondAttach && window.DaimondAttach.focus();
		return (f && f.kind === 'diamond') ? String(f.id) : '';
	});
};

/// Put a Diamond back in focus, the way a person does: by clicking its rail box.
const selectDiamond = async (id) => {
	await closeAdmin();
	await p.$$eval('.diamond-box', (els, want) => {
		for (const e of els) if (e.dataset.id === want) { e.click(); return; }
	}, id);
	await p.waitForTimeout(900);
};

/// Give a Diamond its three models.
///
/// Written straight into the record `setDiamondModel` owns, rather than driven through
/// the tile dialog's "Workers, images" pulldown. That pulldown is not what this file is
/// about, and dev/verify_diamondmodels.mjs already drives it; what matters here is that
/// the record downstream reads is the one the user's choice produces, which is why the
/// shape is written out in full and read back.
const setModels = (id, rec) => p.evaluate(({ id, rec }) => {
	const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
	all[id] = rec;
	localStorage.setItem('daimond-diamond-models', JSON.stringify(all));
	return all[id];
}, { id, rec });

/// The worker run the app persisted for `task`, as it sees it.
const runFor = (task) => p.evaluate((task) => {
	let box = {};
	try { box = JSON.parse(localStorage.getItem('daimond-workers') || '{}'); } catch (e) { return null; }
	const runs = (box && box.runs) || [];
	return runs.find((r) => (r.task || '').trim() === task) || null;
}, task);

/// Install the visibility predicate on the page, once, as `window.__visionShown`.
///
/// VISIBILITY IS ASSERTED PROPERLY, and this is the part of the file that exists
/// because `verify_view.mjs:271` went vacuous (defect K): a chip scrolled out of a
/// horizontal scroller still returns a rect with area, and content under
/// `content-visibility: hidden` keeps its last layout. So an element counts as shown
/// only when its CENTRE lies inside the intersection of every clipping ancestor's box
/// and the viewport, AND a hit test at that centre lands on it or inside it. Both, not
/// either: containment says it is not scrolled away, the hit test says nothing is drawn
/// over it, and neither says anything about the other.
///
/// One installation shared by the checks and by the instrument's own self-test, so what
/// the self-test proves is the predicate the checks then use and not a copy of it.
const installShown = () => p.evaluate(() => {
	// The intersection of the viewport with every ancestor that clips.
	const clipRect = (el) => {
		let r = { l: 0, t: 0, r: window.innerWidth, b: window.innerHeight };
		for (let a = el.parentElement; a; a = a.parentElement) {
			const cs = getComputedStyle(a);
			if (cs.contentVisibility === 'hidden') return { l: 0, t: 0, r: -1, b: -1 };
			if (!/auto|scroll|hidden|clip/.test(cs.overflowX + ' ' + cs.overflowY)) continue;
			const q = a.getBoundingClientRect();
			r = { l: Math.max(r.l, q.left), t: Math.max(r.t, q.top),
				r: Math.min(r.r, q.right), b: Math.min(r.b, q.bottom) };
		}
		return r;
	};
	window.__visionShown = (el) => {
		if (!el) return { ok: false, why: 'no element' };
		const cs = getComputedStyle(el);
		if (cs.display === 'none') return { ok: false, why: 'display:none' };
		if (cs.visibility === 'hidden') return { ok: false, why: 'visibility:hidden' };
		if (Number(cs.opacity) === 0) return { ok: false, why: 'opacity:0' };
		// Chrome's own answer, where it has one: it knows about content-visibility and
		// about ancestors this walk would have to guess at.
		if (typeof el.checkVisibility === 'function'
			&& !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true,
				contentVisibilityAuto: true })) {
			return { ok: false, why: 'checkVisibility() says no' };
		}
		const b = el.getBoundingClientRect();
		if (b.width < 1 || b.height < 1) return { ok: false, why: 'no area' };
		const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
		const c = clipRect(el);
		if (cx < c.l || cx > c.r || cy < c.t || cy > c.b) {
			return { ok: false, why: `centre (${Math.round(cx)},${Math.round(cy)}) is outside its `
				+ `clip rect (${Math.round(c.l)},${Math.round(c.t)})-(${Math.round(c.r)},${Math.round(c.b)})`
				+ ' — it has a rect with area but nobody can see it' };
		}
		const hit = document.elementFromPoint(cx, cy);
		if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) {
			return { ok: false, why: 'the hit test at its centre lands on '
				+ (hit ? '<' + hit.tagName.toLowerCase() + ' class="' + hit.className + '">' : 'nothing') };
		}
		return { ok: true, why: '' };
	};
});

/// The worker tile for `task`, and everything the checks read off it.
const tileFor = (task) => p.evaluate((task) => {
	const shown = window.__visionShown;
	const card = [...document.querySelectorAll('#agents-list .acard')]
		.find((c) => ((c.querySelector('.atask') || {}).textContent || '').trim() === task);
	if (!card) return { found: false, cards: document.querySelectorAll('#agents-list .acard').length };
	// Every leaf in the tile that carries words of its own, so "the tile says X" can be
	// traced to the one element that says it rather than to an innerText soup.
	const said = [...card.querySelectorAll('*')]
		.filter((e) => e.children.length === 0 && (e.textContent || '').trim())
		.map((e) => ({ cls: e.className || '', text: (e.textContent || '').trim(), vis: shown(e) }));
	return {
		found:   true,
		cls:     card.className,
		visible: shown(card).ok ? card.innerText : '',
		why:     shown(card).why,
		said:    said.filter((x) => x.vis.ok).map((x) => x.text),
		hidden:  said.filter((x) => !x.vis.ok).map((x) => x.text + ' [' + x.vis.why + ']'),
		// Everything only a mouse would ever find, which is what the app offers today.
		titles:  [...card.querySelectorAll('[title]')]
			.map((e) => (e.className || e.tagName) + ': ' + e.getAttribute('title')),
	};
}, task);

/// Every ledger entry and Diamond-turn count since `mark`.
const spendSince = (mark) => p.evaluate((mark) => {
	let entries = [];
	try { entries = JSON.parse(localStorage.getItem('daimond-ledger') || '[]'); } catch (e) { entries = []; }
	let sig = { diamonds: {} };
	try { sig = window.DaimondSignals ? window.DaimondSignals.snapshot() : sig; } catch (e) { /* absent */ }
	return {
		entries: entries.filter((e) => e && e.t >= mark).map((e) => ({ m: e.m, u: e.u, p: e.p, c: e.c })),
		diamonds: Object.keys(sig.diamonds || {}).reduce((o, k) => {
			o[k] = (sig.diamonds[k] || {}).turns || 0; return o;
		}, {}),
	};
}, mark);

try {
	// ── The instrument's own self-test ───────────────────────────
	//
	// Before anything is claimed about the app: the visibility predicate check 4 rests
	// on must reject a thing that has a rect with area and is nonetheless invisible.
	// This is defect K made deliberately and measured, so that a green check 4 later
	// cannot be the vacuity that check was written to escape.
	await installShown();
	const control = await p.evaluate(() => {
		const wrap = document.createElement('div');
		wrap.style.cssText = 'position:fixed;left:10px;top:10px;width:80px;height:20px;'
			+ 'overflow:hidden;z-index:99998';
		const away = document.createElement('span');
		away.textContent = 'scrolled out of a clipped scroller';
		away.style.cssText = 'display:inline-block;margin-left:600px;white-space:nowrap';
		const here = document.createElement('span');
		here.textContent = 'plainly there';
		here.style.cssText = 'display:inline-block;position:fixed;left:10px;top:60px;'
			+ 'background:#000;color:#fff;z-index:99999';
		wrap.appendChild(away);
		document.body.appendChild(wrap);
		document.body.appendChild(here);
		const shown = window.__visionShown;
		const b = away.getBoundingClientRect();
		const out = {
			awayRects: away.getClientRects().length,
			awayArea:  b.width * b.height,
			away:      shown(away),
			here:      shown(here),
		};
		wrap.remove(); here.remove();
		return out;
	});
	check(control.awayRects > 0 && control.awayArea > 0
			&& !control.away.ok && control.here.ok,
		'INSTRUMENT: the visibility predicate rejects a chip scrolled out of a clipped '
			+ 'scroller (a rect with area that nobody can see) and accepts one that is drawn',
		`${control.awayRects} rect(s), area ${Math.round(control.awayArea)}; `
			+ `hidden → ${control.away.ok ? 'ACCEPTED, which is the vacuity of defect K' : control.away.why}; `
			+ `visible → ${control.here.ok ? 'accepted' : 'REJECTED: ' + control.here.why}`);

	// ── The fixture ──────────────────────────────────────────────
	const prov = await p.evaluate(() => {
		const d = window.DaimondModels.getDefault();
		return d.provider;
	});
	const dId = await newDiamond('Vision Routing');
	if (!dId) throw new Error('no Diamond came into focus after the New Diamond dialog');
	const rec = await setModels(dId, {
		provider: prov, model: 'mock/fast',
		workerProvider: prov, workerModel: TEXT_MODEL,
		visionProvider: prov, visionModel: VISION_MODEL,
	});
	check(rec.workerModel === TEXT_MODEL && rec.visionModel === VISION_MODEL,
		'the Diamond has a text worker model that cannot see and an image model that can',
		JSON.stringify(rec));

	// The picture, under a name that spells NO image extension.
	//
	// It is the defect's own case — the one `taskWantsVision`'s doc comment admits it
	// cannot know, "a worker that discovers an image for itself" — and the only fixture
	// that could tell the defect from the fix if the spelling rule ran at all. It does
	// not (see the header), so today BOTH kinds of task go to the text model; check 7
	// is the one that measures the other kind. This premise is asserted rather than
	// assumed all the same, because the rule can be made reachable, and on the day it is
	// a fixture that spelled `shot.png` would start passing check 1 without anything
	// having learned anything about capability.
	const PIC  = `diamonds/${dId}/capture`;
	const TASK = `@look ${PIC}`;
	await put(PIC, PNG);
	check(!IMAGE_EXT.test(TASK),
		'and the task names no image, so nothing but a CAPABILITY signal could move this '
			+ 'worker off the text model — the case the defect is about',
		`${String(IMAGE_EXT)} against ${JSON.stringify(TASK)}`);

	// ── 1, 3, 4, 5. One worker, shown a picture it cannot see ────
	clearMockLog();
	const mark = Date.now();
	// The per-Diamond turn counts BEFORE anything is dispatched. Without a baseline the
	// "both against this Diamond" half of check 3 is satisfied by the daimon's own two
	// turns, which are on this Diamond whatever the workers do — the clause would be
	// there and would be measuring nothing, which is the shape of defect K.
	const base = await spendSince(mark);
	await steerDiamond(s, `@tools spawn_agent {"name":"looker","task":"${TASK}"}`);
	const ran = await until(async () => {
		const r = await runFor(TASK);
		return !!r && ['done', 'error', 'stopped'].includes(r.status);
	});
	await p.waitForTimeout(1500);
	await shot(s, 'vision-1-looker');

	const run  = await runFor(TASK);
	const legs = legsOf(TASK);
	check(ran && legs.length > 0,
		'the worker ran and reached the model (nothing below is true of a worker that never ran)',
		legLine(TASK));

	// ── 1. The work moved to the image model ─────────────────────
	//
	// "leg 1 carries neither" as DESIGN_VISION.md §7 puts it is not quite right and is
	// not asserted: leg 1 MUST carry the picture exactly once, because being refused is
	// how the app learns the model is blind. What must be true is that the picture was
	// refused there and accepted on the image model.
	const leg1 = legs[0] || { model: '', images: 0, refused: 0 };
	const leg2 = legs[1] || null;
	check(!!leg2 && leg2.model === VISION_MODEL && leg2.images > 0
			&& leg1.model === TEXT_MODEL && leg1.refused > 0,
		'THE WORK MOVED TO THE IMAGE MODEL — a second leg on the Diamond\'s image model '
			+ 'carrying the picture, after the text model refused it',
		legLine(TASK));

	// ── 3. Each leg billed to the model that spent it ────────────
	const money = await spendSince(mark);
	const onText   = money.entries.filter((e) => e.m === TEXT_MODEL);
	const onVision = money.entries.filter((e) => e.m === VISION_MODEL);
	// Every turn charged since the dispatch, and to whom. `bump` drops an empty id, so a
	// leg billed to nobody — which is what a `finally` reading the SELECTION rather than
	// the run used to do — shows up as a Diamond that grew by less than the ledger did.
	const grew = Object.keys(money.diamonds)
		.filter((k) => (money.diamonds[k] || 0) > (base.diamonds[k] || 0));
	const mine = (money.diamonds[dId] || 0) - (base.diamonds[dId] || 0);
	check(onText.length === 1 && onVision.length === 1
			&& mine === money.entries.length && grew.length === 1 && grew[0] === dId,
		'AND EACH LEG IS BILLED TO THE MODEL THAT SPENT IT, both against this Diamond',
		`ledger since dispatch: ${JSON.stringify(money.entries)}; `
			+ `${mine} of those ${money.entries.length} turn(s) went to this Diamond`
			+ (grew.filter((k) => k !== dId).length
				? `; also charged: ${grew.filter((k) => k !== dId).join(', ')}` : ''));

	// ── 4. Disclosed on screen, without hovering ─────────────────
	const tile = await tileFor(TASK);
	const names = (txt, m) => txt.includes(m) || txt.includes(m.split('/').pop());
	const seen  = tile.found ? tile.said.join(' · ') : '';
	check(tile.found && !!tile.visible && names(seen, VISION_MODEL) && names(seen, TEXT_MODEL),
		'AND IT IS DISCLOSED ON SCREEN WITHOUT HOVERING — the tile\'s own visible text '
			+ 'names both the model it left and the model it moved to',
		!tile.found
			? `no tile whose task is ${JSON.stringify(TASK)} (${tile.cards} tile(s) in the pane)`
			: (tile.visible ? '' : `the whole tile is not visible: ${tile.why}; `)
				+ `visible text: ${JSON.stringify(seen)}`
				+ (tile.hidden.length ? `; drawn but not visible: ${JSON.stringify(tile.hidden)}` : '')
				+ `; only on hover: ${JSON.stringify(tile.titles)}`);

	// ── 5. The second leg is a RESUME, not a restart ─────────────
	//
	// WHILE THE FIX IS ABSENT THIS CHECK CANNOT SPEAK FOR ITSELF. There is no second leg
	// at all, so it fails with "there was no second leg to look at" — which is honest,
	// and is a consequence of check 1 rather than an independent measurement. It only
	// starts distinguishing restart from resume once something moves the worker. Said
	// here rather than left for a reader to work out from a green run that never was.
	//
	// Restart and resume differ in one observable thing: what the last user message of
	// the new session is. `resume()` seeds `[{user: task}, {assistant: its own text}]`
	// and runs the turn on a NUDGE; a restart runs it on the task again. So the last
	// user message being the task IS the restart. The assistant seed is asserted beside
	// it, because a nudge with nothing carried forward is a restart with extra words.
	const first2 = leg2 && leg2.reqs[0];
	const msgs2  = (first2 && first2.messages) || [];
	const lastUser = [...msgs2].reverse().find((m) => m.role === 'user');
	const lastUserText = lastUser
		? (typeof lastUser.content === 'string' ? lastUser.content
			: (lastUser.content || []).map((x) => x.text || '').join(' '))
		: '';
	// An assistant message with words in it, not a particular form of words: a restart
	// carries NONE, so "there is one" is the whole discriminator, and matching the
	// mock's phrasing would only make this brittle against the fixture.
	const seed2 = msgs2.filter((m) => m.role === 'assistant'
		&& typeof m.content === 'string' && m.content.trim());
	check(!!first2 && lastUserText.trim() !== TASK && seed2.length > 0,
		'AND THE SECOND LEG IS A RESUME — seeded with the worker\'s own earlier words and '
			+ 'carried on by a nudge, not started again from the task',
		!first2 ? 'there was no second leg to look at'
			: `last user message ${JSON.stringify(lastUserText.slice(0, 90))}; `
				+ `earlier words carried: ${JSON.stringify(seed2.map((m) => m.content.slice(0, 60)))}`);

	// ── 2. It moved ONCE ─────────────────────────────────────────
	//
	// Its own Diamond, because the case is a Diamond whose IMAGE model is itself blind.
	// Without the once-per-run guard this is a worker moved from a blind model to a
	// blind model for as long as the pool will let it.
	const dId2 = await newDiamond('Vision Ping Pong');
	if (!dId2) throw new Error('no second Diamond came into focus');
	await setModels(dId2, {
		provider: prov, model: 'mock/fast',
		workerProvider: prov, workerModel: TEXT_MODEL,
		visionProvider: prov, visionModel: BLIND_VISION,
	});
	const PIC2  = `diamonds/${dId2}/capture`;
	const TASK2 = `@look ${PIC2}`;
	await put(PIC2, PNG);
	clearMockLog();
	await steerDiamond(s, `@tools spawn_agent {"name":"pingpong","task":"${TASK2}"}`);
	await until(async () => {
		const r = await runFor(TASK2);
		return !!r && ['done', 'error', 'stopped'].includes(r.status);
	});
	await p.waitForTimeout(1500);
	await shot(s, 'vision-2-pingpong');
	const legs2 = legsOf(TASK2);
	const tile2 = await tileFor(TASK2);
	const run2  = await runFor(TASK2);
	// THE LEG COUNT CANNOT SEE THE FAILURE THIS CHECK EXISTS FOR, and that was measured
	// rather than argued.  A repeat move goes to the SAME image model, and `legsOf` groups
	// consecutive requests by model, so every repeat merges into leg 2 and the count stays
	// at two.  Under `--break loop` the app made 2,101 requests and was refused 700 times,
	// ~83k tokens and about five cents in sixty seconds, and this check was green for all
	// of it.
	//
	// So the once-ness is measured where it actually shows: the blind image model is handed
	// the picture ONCE.  Unbroken that is 1 refusal on leg 2; the runaway made 700.  The
	// terminal status is asserted beside it because a ping-pong does not merely cost money,
	// it never ends -- and a check that waits for a terminal state it never reaches would
	// otherwise report on a half-finished run.
	const moved2 = legs2.length === 2
		&& legs2[0].model === TEXT_MODEL && legs2[1].model === BLIND_VISION;
	const once2  = legs2.length > 1 && legs2[1].refused <= 2 && legs2[1].reqs.length <= 12;
	const ended2 = !!run2 && ['done', 'error', 'stopped'].includes(run2.status);
	check(moved2 && once2 && ended2,
		'AND IT MOVED ONCE — an image model that is itself blind is tried once and not '
			+ 'again, and the run ENDS',
		`${legLine(TASK2)}; status ${run2 ? run2.status : '(no run)'}; `
			+ `the tile says ${JSON.stringify(tile2.found ? tile2.said.join(' · ') : '(no tile)')}`);

	// ── 6. A task with no picture is untouched ───────────────────
	//
	// The check that stops "always send workers to the image model" from passing every
	// one of the five above. Same Diamond as check 1, so the image model is configured
	// and available — it simply must not be used.
	await selectDiamond(dId);
	const back = await p.evaluate(() => {
		const f = window.DaimondAttach && window.DaimondAttach.focus();
		return (f && f.kind === 'diamond') ? String(f.id) : '';
	});
	check(back === dId,
		'the first Diamond — the one with a SIGHTED image model — is in focus again, so '
			+ 'the check below is about routing and not about a Diamond with nowhere to go',
		`focus is ${back || '(nothing)'}, wanted ${dId}`);
	const TASK3 = '@text there is nothing here to look at';
	clearMockLog();
	await steerDiamond(s, `@tools spawn_agent {"name":"reader","task":"${TASK3}"}`);
	await until(async () => {
		const r = await runFor(TASK3);
		return !!r && ['done', 'error', 'stopped'].includes(r.status);
	});
	await p.waitForTimeout(1200);
	await shot(s, 'vision-3-noplicture');
	const legs3 = legsOf(TASK3);
	const tile3 = await tileFor(TASK3);
	const said3 = tile3.found ? tile3.said.join(' · ') : '';
	check(legs3.length === 1 && legs3[0].model === TEXT_MODEL && legs3[0].images === 0
			&& !names(said3, VISION_MODEL),
		'BUT A TASK CARRYING NO PICTURE IS UNTOUCHED — one leg, on the text model, and '
			+ 'the tile says nothing about an image model',
		`${legLine(TASK3)}; the tile says ${JSON.stringify(said3)}`);

	// ── 7. The spelling rule, through the door dispatch uses ─────
	//
	// A task that NAMES a picture should reach the image model with no capability signal
	// at all — DESIGN_VISION.md §5 keeps `IMAGE_EXT` on exactly that promise, as "a
	// cheap hint that saves the first leg whenever the daimon happens to spell the
	// filename". It saves nothing: `dispatch` supplies a model on every call, so
	// `routeFor` never consults the task. `verify_diamondmodels` proves the rule through
	// `routeForDiamond`, which passes `supplied: false` and is called by nothing under
	// `www/` at all.
	const TASK4 = '@text compare shots/rail.png against the mockup';
	clearMockLog();
	await steerDiamond(s, `@tools spawn_agent {"name":"speller","task":"${TASK4}"}`);
	await until(async () => {
		const r = await runFor(TASK4);
		return !!r && ['done', 'error', 'stopped'].includes(r.status);
	});
	await p.waitForTimeout(1200);
	const legs4 = legsOf(TASK4);
	const run4  = await runFor(TASK4);
	// `sees` is asserted beside the model, not instead of it: landing on the image model
	// is what a RE-ROUTE also does, and this check is about the first leg being routed
	// there.  Without it the check would pass on the very failure it was written for.
	const routed4 = !!legs4[0] && legs4[0].model === VISION_MODEL && !!(run4 && run4.sees);
	check(routed4,
		'AND A TASK THAT NAMES A PICTURE REACHES THE IMAGE MODEL through the door '
			+ 'dispatch actually uses — the check the other six assume',
		`${legLine(TASK4)}; the app recorded sees=${run4 ? run4.sees : '(no run)'}`
			// The diagnosis belongs to the FAILURE, not to the line.  Printed always, it
			// made a green check assert that the defect was still live.
			+ (routed4 ? '' : ' — if sees is false, `supplied` was true on this dispatch and'
				+ ' `taskWantsVision` was never asked'));

	// Context for whoever reads the failures: what the app itself thought it was doing.
	console.log('\n  what the app recorded for the looker: '
		+ JSON.stringify(run ? { model: run.model, provider: run.provider, sees: run.sees,
			status: run.status, text: String(run.text || '').slice(0, 160) } : null));
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
