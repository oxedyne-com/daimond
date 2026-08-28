// verify_predrop.mjs — a turn that dies BEFORE THE FIRST TOKEN is handed back, whatever
// the browser calls a dead fetch.
//
// THE DEFECT. `dev/verify_dropped.mjs` proves the mid-stream case: three words arrive, the
// socket dies, the turn comes back badged with a Continue button. The case BEFORE the first
// token did not work, and it did not work on one platform only.
//
// A rejected `fetch` reaches JavaScript as the browser's own sentence. Chromium says
// `TypeError: Failed to fetch`; WebKit says `TypeError: Load failed`. `isUnreachable` in
// www/js/daimond.js held the first and not the second, so on iOS a turn that died before any
// token fell through to the terminal branch of `runTurn`'s catch: an error line was written
// and `J.clearTurn` deleted the turn from the write-ahead log. No badge, no Continue, and the
// whole recovery apparatus built for exactly this case never ran. `failureClass` had the same
// gap, which is why telemetry counted these as `other` and the numbers never showed it.
//
// Mid-stream breaks were unaffected: their text carries `read stream chunk failed`, which is
// the `err!` text itself and crosses the wasm boundary. THAT ASYMMETRY IS WHAT THIS FILE
// MEASURES.
//
// AND WHY THE REGEX IS NOT THE FIX. `TransportErr` (src/llm.rs) keeps `reason` and `err`
// apart, and only `err` used to leave the module -- so `could not reach the provider`, which
// is Daimond's own wording and identical on every browser, never reached the classifier that
// quoted it. `TransportErr::crossed` now puts the reason in front of the error. Adding
// `Load failed` to the regex fixes iOS; carrying the reason means the next browser's wording
// does not have to be discovered from a bug report.
//
// A SECOND DEFECT, found while proving the first. `_unloading` was set by `pagehide` and
// never cleared. `pagehide` fires when a tab enters the back/forward cache, which is what iOS
// does to a home-screen PWA on every app switch -- so ONE switch away and back put the tab in
// "we are unloading" mode for the rest of the sitting, and after that a dropped turn showed
// the user nothing at all: no error, no badge, no button, the spinner simply stopping. Check 5
// is that one, and it is the check that is closest to the symptom actually reported.
//
// HOW THE FAILURE IS PRODUCED. `window.fetch` is replaced in the page with one that rejects
// with `new TypeError('Load failed')` -- WebKit's own wording, verbatim -- for requests to the
// provider, and only while armed. The engine reaches `fetch` through the window object at call
// time, so the wasm sees the replacement. This is a simulation of Safari and is honest about
// it: what it proves is that the APP classifies WebKit's sentence correctly. Whether iOS
// produces that sentence in the field is a question for a device, and the owner is testing it
// on one.
//
// FOUR PROPERTIES, and one more:
//
//   1. THE TURN ENDS rather than hanging on the road. (The retry ladder runs first -- eight
//      attempts over up to 120 s -- so this is not a five-second wait.)
//   2. AND IT IS HANDED BACK, badged, with a Continue button.
//   3. AND THE BADGE SAYS THE ROAD WENT, not that the browser closed. Four sentences exist for
//      exactly this distinction and picking the wrong one is a small lie.
//   4. AND THE TURN IS STILL IN THE WRITE-AHEAD LOG. This is the one the user cannot see and
//      the one that cost them the turn: the terminal branch calls `J.clearTurn`.
//   5. AND A PAGE THAT WAS BACKGROUNDED AND CAME BACK STILL SAYS SO.
//   6. AND THE SCREEN WAS KEPT AWAKE WHILE THE TURN RAN, AND ONLY WHILE IT RAN.
//
// PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_predrop.mjs --break wording   # the shipped regex: 2-4 fail
//   node dev/verify_predrop.mjs --break bfcache   # `_unloading` never cleared: 5 fails
//   node dev/verify_predrop.mjs --break nolock    # the wake lock never taken: 6 fails
//   node dev/verify_predrop.mjs                   # and then, clean
//
// `--break wording` restores `isUnreachable` exactly as it stood on 2026-08-27, and it is the
// one break whose result CHANGES with the engine. Measured in world 17 on 2026-08-28:
//
//   old JS classifier, old engine      6 of 15 fail: an error line, nothing badged, no
//                                      Continue, and `0 turn(s) open` -- the write-ahead
//                                      entry deleted by `clearTurn`
//   old JS classifier, new engine      all 15 pass
//
// Nothing about the JavaScript differs between those two runs. What differs is that
// `TransportErr::crossed` puts `could not reach the provider` in front of the browser's
// sentence, and the 2026-08-27 regex already quoted that phrase -- it had simply never
// arrived. That is the argument for having done the Rust half rather than adding a string,
// and running this file both ways across the rebuild is how it was made.
//
//   eval "$(bash dev/world.sh 17 --up)"
//   node dev/verify_predrop.mjs
//
// Needs dev/serve.mjs and the mock. No gateway. The engine matters -- see above.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, scratch, shot, signInAs } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// The three lines that decide it, each quoted whole so a move breaks this file loudly
// rather than letting it patch nothing and report a pass.
const ANCHORS = {
	// The classifier, as it reads now.
	wording: [
		'\t\treturn CLIENT_ROAD.test(s) || BROWSER_ROAD.test(s);\n',
		// Exactly the two patterns of 2026-08-27, before `Load failed` was in either of
		// them and before the client\'s own reason could reach here at all.
		'\t\treturn /Failed to fetch|network\\s*error|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|refused|dns/i.test(s)\n'
		+ '\t\t\t|| /could not reach|the stream broke|read stream chunk failed/i.test(s);\n',
	],
	// The bfcache restore.
	bfcache: [
		"\twindow.addEventListener('pageshow', function () { _unloading = false; });\n",
		"\twindow.addEventListener('pageshow', function () { /* broken: nothing clears it */ });\n",
	],
	// The lock itself.
	nolock: [
		'\t\t\thold: function () { held++; ask(); },\n',
		'\t\t\thold: function () { /* broken: never asked for */ },\n',
	],
};
if (BREAK && !ANCHORS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(ANCHORS).join(', ')}`);
	process.exit(2);
}

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const SRC = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
for (const [k, [from]] of Object.entries(ANCHORS)) {
	if (SRC.split(from).length !== 2) {
		console.error(`the line the '${k}' break patches is not in js/daimond.js exactly once; `
			+ 'the anchor has moved and the break would patch nothing');
		process.exit(2);
	}
}

// WebKit's own sentence for a fetch that never got a response, verbatim.
// https://trackjs.com/javascript-errors/load-failed/
const WEBKIT_WORDING = 'Load failed';

const s = await open({
	name:    'predrop',
	profile: scratch('pw', 'predrop' + (BREAK ? '-' + BREAK : '')),
	route:   async (page) => {
		if (BREAK) {
			const [from, to] = ANCHORS[BREAK];
			const body = SRC.replace(from, to);
			await page.route('**/js/daimond.js', (r) => r.fulfill({
				status: 200, contentType: 'application/javascript', body,
			}));
		}
		// The Safari failure, armed from the test rather than from the mock: what is being
		// simulated is the BROWSER's behaviour, not the provider's, so it belongs in the
		// browser. Installed before any script runs, and inert until `__loadFail` is set.
		await page.addInitScript((wording) => {
			const real = window.fetch.bind(window);
			window.__loadFailCount = 0;
			window.fetch = function (input, init) {
				const url = typeof input === 'string' ? input
					: (input && input.url) || String(input || '');
				if (window.__loadFail && /\/v1\/chat\/completions/.test(url)) {
					window.__loadFailCount++;
					// A TypeError with no response and no status, which is the whole of
					// what a page gets when a fetch dies before its headers.
					return Promise.reject(new TypeError(wording));
				}
				return real(input, init);
			};
		}, WEBKIT_WORDING);
	},
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

/// What the thread holds, and what is offered about the last answer in it.
const thread = () => p.evaluate(() => {
	const inter = [...document.querySelectorAll('#chat-output .chat-msg.interrupted')].pop() || null;
	return {
		interrupted: !!inter,
		// By role rather than by its words, so a translation does not decide this file.
		continues:   !!(inter && inter.querySelector('.turn-interrupted button')),
		badge:       inter ? ((inter.querySelector('.ti-label') || {}).textContent || '') : '',
		errors:      [...document.querySelectorAll('#chat-output .chat-msg-error, #chat-output .error-log')].length,
		users:       [...document.querySelectorAll('#chat-output .chat-msg-user .chat-msg-content')]
			.map(e => e.textContent),
		tries:       window.__loadFailCount || 0,
	};
});

/// Wait for the composer to offer Send again — the app's own "the turn is over".
///
/// The bound is above `RetryPolicy::default()`'s whole budget (eight attempts,
/// `max_total_wait_ms` 120 s), because a fetch that never gets a response is
/// retryable and the ladder runs to the end of it before the turn dies.
const settle = async (label, timeout = 200000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const busy = await p.evaluate(() => {
			const b = document.getElementById('chat-send');
			return !!b && (b.classList.contains('stop') || b.disabled);
		});
		if (!busy) return { ended: true, ms: Date.now() - t0 };
		await p.waitForTimeout(250);
	}
	console.log(`  note  the ${label} turn was still running after ${timeout} ms`);
	return { ended: false, ms: Date.now() - t0 };
};

/// Turn ids still open in the write-ahead log.
const journalled = () => p.evaluate(async () => {
	if (!window.DaimondJournal) return null;
	const rec = await DaimondJournal.recover();
	return (rec.turns || []).map(t => t.turnId);
});

try {
	await newChat(s);

	// ── 1-4 and 6. The road never opens ──────────────────────────
	//
	// Armed AFTER the model is connected, so only the turn's own request dies.
	await p.evaluate(() => { window.__loadFail = true; });
	await p.fill('#chat-input', '@text hello');

	// The lock is taken by the turn and given back by it, so both halves are read around
	// the send rather than after it.
	const lockBefore = await p.evaluate(() => window.DaimondWake && DaimondWake.state());
	await p.click('#chat-send');
	// Sampled while the retry ladder is still climbing, which is the only window there is.
	await p.waitForTimeout(1500);
	const lockDuring = await p.evaluate(() => window.DaimondWake && DaimondWake.state());

	const end = await settle('pre-token');
	check(end.ended, 'THE TURN THAT NEVER REACHED THE PROVIDER ENDS rather than hanging',
		`${end.ms} ms`);

	const t1 = await thread();
	await shot(s, 'predrop-interrupted');
	check(t1.tries > 0,
		'the instrument fired — the engine really did meet a rejected fetch',
		`${t1.tries} attempt(s) refused with ${JSON.stringify(WEBKIT_WORDING)}`);
	check(t1.interrupted,
		"A TURN THAT DIED BEFORE THE FIRST TOKEN IS HANDED BACK, not written off",
		t1.interrupted ? '' : `${t1.errors} error line(s) and nothing marked interrupted`);
	check(t1.continues,
		'and the Continue button is on it',
		t1.continues ? '' : (t1.interrupted ? 'no button in .turn-interrupted'
			: 'nothing was marked interrupted'));
	// The badge that says the ROAD went. `turn.offline_early` in www/i18n/en.js; matched on a
	// distinctive clause rather than the whole sentence so a rewording does not fail this.
	check(/connection dropped/i.test(t1.badge),
		'AND THE BADGE SAYS THE CONNECTION DROPPED, not that the browser closed',
		JSON.stringify(t1.badge.slice(0, 90)));
	check(t1.users.length === 1,
		'and the prompt is still in the thread, once',
		JSON.stringify(t1.users.join('|').slice(0, 80)));

	check(t1.errors === 0,
		'AND IT IS SAID ONCE — no red line telling the user to check their base URL',
		`${t1.errors} error line(s) beside the badge`);

	// THE PROPERTY THE USER ACTUALLY HAS, and the one the deleted journal entry cost them:
	// close the app, come back, and the turn is still there to be continued. Everything above
	// is true of a sitting; this is true of a device.
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(1200);
	await signInAs(s, 'predrop');
	await p.waitForTimeout(1200);
	await p.locator('#session-list .chat-box').first().click({ force: true });
	await p.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
	await p.waitForTimeout(600);
	const t1r = await thread();
	await shot(s, 'predrop-after-reload');
	check(t1r.interrupted && t1r.continues,
		'AND IT IS STILL THERE AFTER A RELOAD, badge and button',
		t1r.interrupted ? '' : `${t1r.errors} error line(s), nothing interrupted`);
	check(t1r.users.length === 1,
		'with the prompt kept, once',
		JSON.stringify(t1r.users.join('|').slice(0, 80)));

	// 6. The screen was kept awake for the turn, and given back at the end of it.
	const lockAfter = await p.evaluate(() => window.DaimondWake && DaimondWake.state());
	check(!!lockBefore && lockBefore.held === 0 && !!lockDuring && lockDuring.held === 1,
		'THE SCREEN WAKE LOCK IS HELD FOR THE DURATION OF A TURN',
		`held ${lockBefore && lockBefore.held} before, ${lockDuring && lockDuring.held} during`);
	check(!!lockAfter && lockAfter.held === 0 && !lockAfter.locked,
		'and released when the turn ends, by whatever door it left',
		`held ${lockAfter && lockAfter.held}, lock ${lockAfter && lockAfter.locked}`
		+ (lockAfter && !lockAfter.supported ? ' (API absent here: the count is the assertion)' : ''));

	// ── 5. A page that was backgrounded and came back ────────────
	//
	// `pagehide` then `pageshow` is what iOS does to a home-screen PWA on an app switch.
	// After it, a dropped turn must still say so.
	await newChat(s);
	// Re-armed: the reload above ran the init script again, which leaves the stub in place
	// and disarmed.
	await p.evaluate(() => {
		window.__loadFail = true;
		window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
		window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
	});
	await p.fill('#chat-input', '@text after the switch');
	await p.click('#chat-send');
	const end2 = await settle('after-bfcache');
	const t2 = await thread();
	await shot(s, 'predrop-after-bfcache');
	// UNDER `--break bfcache` THIS FAILS WITH NOTHING ON SCREEN AT ALL, which is the shape
	// worth recognising: no badge and no error line, because `_unloading` sent the catch down
	// its first branch. Under `--break wording` it fails with an error line instead. The count
	// is reported so the two are told apart from the output.
	check(end2.ended && t2.interrupted && t2.continues,
		'A TAB THAT WENT INTO THE BACKGROUND AND CAME BACK STILL HANDS THE TURN BACK',
		t2.interrupted ? '' : `${t2.errors} error line(s), nothing interrupted`);

	// ── The control. A provider refusal is still terminal ────────
	//
	// THE CHECK THAT MAKES THE OTHERS MEAN SOMETHING. Without it, "everything is
	// recoverable" would pass every check above and classify nothing.
	await p.evaluate(() => { window.__loadFail = false; });
	await newChat(s);
	// What is open BEFORE the refusal, so the check below is about this turn and not about
	// the interrupted ones above it -- which are open, correctly, and stay open.
	const openBefore = await journalled();
	await p.fill('#chat-input', '@err 400');
	await p.click('#chat-send');
	const end3 = await settle('400');
	const t3 = await thread();
	check(end3.ended, 'a provider refusal ends too', `${end3.ms} ms`);
	check(!t3.interrupted && t3.errors > 0,
		'BUT A PROVIDER REFUSAL IS STILL TERMINAL — a 400 is not offered back',
		t3.interrupted ? 'a 400 was badged interrupted and offers a Continue that cannot work'
			: `${t3.errors} error line(s)`);
	const openAfter = await journalled();
	check(Array.isArray(openAfter) && Array.isArray(openBefore)
		&& openAfter.length === openBefore.length,
		'AND ITS JOURNAL ENTRY IS PRUNED — a terminal turn is not left to be recovered',
		openBefore === null ? 'no journal'
			: `${openBefore.length} turn(s) open before it, ${openAfter && openAfter.length} after`);
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
