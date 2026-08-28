// verify_toolroad.mjs — a TOOL call that dies on the road never reaches the model.
//
// THE DEFECT, as the owner met it on a real iPhone on 2026-08-28:
//
//   "on ios the retry mechanism is 'succeeding' but the overall ux is failing, the response
//    started 'I can't get through to the web right now to look this up ....'"
//
// The provider retry ladder (src/llm.rs, eight attempts over up to 120 s) does work across an iOS
// freeze, and `dev/verify_predrop.mjs` proves it. It was beside the point. THE LADDER GUARDS THE
// CALL TO THE MODEL; IT DOES NOT GUARD THE CALLS THE MODEL MAKES. A home-screen PWA is put in the
// back/forward cache on every app switch, so every in-flight request dies — and a `web_fetch`
// that dies was handed back to the model AS A TOOL RESULT SAYING IT FAILED. The model then did
// the reasonable thing with a failed tool: it apologised and answered around it.
//
// WHAT MADE IT SERIOUS. That apology was not a transient. `ToolRegistry::dispatch_unbilled`
// caught every tool `Err` and returned `MessageContent::text(error_line(…))`, so the failure
// became an ordinary result, the model answered, and THE TURN COMPLETED NORMALLY. It travelled
// the SUCCESS path, not an error path. So `captureSession` (www/js/daimond.js) stored the whole
// exchange — the failed tool result and the apology — into `chat.session.msgs`, which is the
// model's own conversation and is replayed on every later turn and folded into the summary. A
// moment of platform behaviour became a durable false fact in the record.
//
// THE CATEGORY ERROR AT THE ROOT, which is what the code now says out loud: a local failure is
// not information the model should reason about. "The host refused you", "that page is 404",
// "the API returned an error" are RESULTS and the model should adapt to them. "Your user's phone
// went to sleep and the fetch never left the device" is an infrastructure event, and handing it
// over as though it were a fact about the world is what produces the apology.
//
// ── WHAT IS CHECKED ──────────────────────────────────────────────────────────
//
//   1. THE INSTRUMENT FIRED. The tool's request really did meet a rejected fetch.
//   2. THE MODEL WAS NEVER TOLD. Not one request in the whole sitting carries a tool message
//      naming the failure. Read off dev/mockllm-N.log, which is what the model was ACTUALLY
//      shown, rather than off the screen.
//   3. AND THE TURN CAME BACK BADGED, with a Continue — the machinery lane/n-drop built for a
//      dead provider call, reached now by a dead tool call.
//   4. AND THE LADDER WAS CLIMBED, and said so while it climbed.
//   5. AND THE STORED SESSION CARRIES NO APOLOGY AND NO DANGLING TOOL CALL.
//   6. THE CONTROL: a tool that fails for a REMOTE reason still reaches the model, unchanged.
//      Without this, "nothing reaches the model" would pass by breaking every tool.
//   7. THE REGRESSION GUARD — see below.
//   8. The two spellings of the mark, Rust and JavaScript, are the same string.
//   9. THE LADDER PARKS WHILE THE PAGE IS FROZEN, and resumes when it comes back.
//
// ── CHECK 7 IS A REGRESSION GUARD AND CANNOT FAIL TODAY ──────────────────────
//
// It types a SECOND prompt into a sitting whose tool call died, and asserts the provider is not
// handed an assistant turn bearing a tool_use block with no matching result — which every
// provider rejects outright, taking the whole conversation with it.
//
// It is written because that property is INVISIBLE on the restore path. Press Continue, or
// reload, and `restore_session` runs `pair_up` (src/protocol.rs), which strips the dangling call
// for you. Only the LIVE session, carried on by typing again in the same sitting, can hold one —
// and only `Agent::abandon_round` prevents that. A future refactor that dropped the in-memory
// repair would pass every other check in this tree and break exactly this. It is load-bearing
// rather than redundant, which is the reason to keep it green rather than to delete it as a
// check that never fails.
//
// ── HOW THE FAILURE IS PRODUCED ──────────────────────────────────────────────
//
// `window.fetch` is replaced in the page with one that rejects with `new TypeError('Load
// failed')` — WebKit's own wording, verbatim — for `/api/web/fetch` and only while armed. The
// same instrument `dev/verify_predrop.mjs` uses for the provider call, pointed one layer down.
// This is a simulation of Safari and is honest about it: what it proves is that the APP treats a
// dead tool fetch correctly. Whether iOS produces that sentence in the field is a question for a
// device, and the owner has one.
//
// PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_toolroad.mjs --break swallow   # the catch as it stood: SEVEN checks fail
//   node dev/verify_toolroad.mjs --wording alien   # a browser nobody has met: all still pass
//   node dev/verify_toolroad.mjs                   # and then, clean
//
// `--break swallow` restores `dispatch_unbilled`'s behaviour of 2026-08-27 exactly — every tool
// error becoming a sentence — by disarming the mark at the point it is set, which is the only
// half of this that lives in a file a verifier can patch. Measured 2026-08-28 in world 21: seven
// checks fail, and the two that matter most read
//
//   FAIL THE MODEL WAS NEVER TOLD THE FETCH DIED — 1 message(s), first: "Error: Load failed"
//   FAIL THE STORED SESSION CARRIES NO APOLOGY AND NO DEAD TOOL RESULT — 1 message(s) of 4
//
// which is the defect itself, reproduced: the failure reaching the model, and reaching the
// durable record it is replayed from.
//
// `--wording alien` is NOT a break; it is the argument for having done this with a mark rather
// than with a regex. It rejects with a sentence no classifier in this tree has ever seen, and
// everything must still pass — because what is being tested for is Daimond's own mark and not
// the browser's prose. Run it after changing anything about how the road is recognised.
//
// A THIRD PROPERTY IS NOT PROVED HERE AND IS PROVED IN RUST INSTEAD, because it cannot be
// reached from a browser: that a REFUSAL is never read as a road failure however it is worded.
// See `test_a_refusal_is_not_a_road_failure_however_it_is_worded` in src/tools.rs, which fails
// on a pattern classifier with "an answer from the far end was classified as the road: Daimond
// Hands refused that." That is the check that makes the whole design safe, and a regex over tool
// results would not survive it.
//
//   eval "$(bash dev/world.sh 21 --up)"
//   node dev/verify_toolroad.mjs
//
// Needs dev/serve.mjs and the mock. No gateway: `/api/web/fetch` is stubbed here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, scratch, shot, storedChats } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG  = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// The lines that decide it, each quoted whole so a move breaks this file loudly rather than
// letting it patch nothing and report a pass.
const ANCHORS = {
	// gateway.js: the mark itself. Disarming it is exactly the old behaviour — an unmarked
	// rejection is not classifiable as the road, so it becomes a tool result as it always did.
	swallow: ['www/js/gateway.js',
		'\t\t\treturn real.apply(window, arguments).catch(function (e) { throw roadMark(e); });\n',
		'\t\t\treturn real.apply(window, arguments);\n'],
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

const SRC = {};
for (const [k, [rel, from]] of Object.entries(ANCHORS)) {
	const file = path.join(HERE, '..', rel);
	SRC[rel] = SRC[rel] || fs.readFileSync(file, 'utf8');
	if (SRC[rel].split(from).length !== 2) {
		console.error(`the line the '${k}' break patches is not in ${rel} exactly once; `
			+ 'the anchor has moved and the break would patch nothing');
		process.exit(2);
	}
}

// ── 8. One mark, two spellings ───────────────────────────────────────
//
// The engine tests for this string EXACTLY (`ROAD_MARK`, src/tools.rs) and the page writes it
// (`roadMark`, www/js/gateway.js). Neither can see the other, so the coupling is asserted here:
// a change to one of them fails this file rather than quietly stopping the classification.
const RUST_MARK = (() => {
	const s = fs.readFileSync(path.join(HERE, '..', 'src/tools.rs'), 'utf8');
	const m = s.match(/pub const ROAD_MARK: &str = "([^"]+)";/);
	return m ? m[1] : '';
})();
const JS_MARK = (() => {
	const s = SRC['www/js/gateway.js'];
	const m = s.match(/var ROAD_MARK = '([^']+)';/);
	return m ? m[1] : '';
})();
check(!!RUST_MARK && RUST_MARK === JS_MARK,
	'THE MARK IS ONE STRING in both halves — src/tools.rs and www/js/gateway.js',
	`rust ${JSON.stringify(RUST_MARK)} / js ${JSON.stringify(JS_MARK)}`);

// WebKit's own sentence for a fetch that never got a response, verbatim.
// https://trackjs.com/javascript-errors/load-failed/
const WEBKIT_WORDING = 'Load failed';

/// A sentence for a dead fetch that NOTHING in this tree recognises.
///
/// Neither `CLIENT_ROAD` nor `BROWSER_ROAD` (www/js/daimond.js) matches a word of it, and it is
/// deliberately plausible: every engine words this differently and the next one to appear will
/// word it differently again. Under `--wording alien` every check must still pass, which is only
/// possible because the classification is done on Daimond's own mark.
const ALIEN_WORDING = 'The operation was interrupted before completion';

const WORDING = (() => {
	const i = process.argv.indexOf('--wording');
	return (i > 0 && String(process.argv[i + 1] || '') === 'alien') ? ALIEN_WORDING : WEBKIT_WORDING;
})();

const s = await open({
	name:    'toolroad',
	profile: scratch('pw', 'toolroad' + (BREAK ? '-' + BREAK : '')),
	route:   async (page) => {
		if (BREAK) {
			const [rel, from, to] = ANCHORS[BREAK];
			const body = SRC[rel].replace(from, to);
			await page.route('**/' + rel.split('/').slice(1).join('/'), (r) => r.fulfill({
				status: 200, contentType: 'application/javascript', body,
			}));
		}
		// The gateway route the Web panel's `fetch` posts to. There is no gateway in this world,
		// so it is answered here — and this is the ANSWER case, which check 6 needs.
		await page.route('**/api/web/fetch', (r) => r.fulfill({
			status: 200, contentType: 'application/json',
			body: JSON.stringify({ ok: true, url: 'https://example.test/', title: 'Example',
				text: 'the page said this', bytes: 18 }),
		}));
		// The Safari failure, armed from the test rather than from the mock: what is being
		// simulated is the BROWSER's behaviour, not the far end's, so it belongs in the browser.
		// Installed before any script runs — which also means `guardFetch` in js/gateway.js
		// wraps THIS, exactly as it wraps the real one.
		await page.addInitScript((wording) => {
			const real = window.fetch.bind(window);
			window.__loadFailCount = 0;
			window.fetch = function (input, init) {
				const url = typeof input === 'string' ? input
					: (input && input.url) || String(input || '');
				if (window.__loadFail && /\/api\/web\/fetch/.test(url)) {
					window.__loadFailCount++;
					// A TypeError with no response and no status, which is the whole of what a
					// page gets when a fetch dies before its headers.
					return Promise.reject(new TypeError(wording));
				}
				return real(input, init);
			};
		}, WORDING);
	},
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);
if (WORDING !== WEBKIT_WORDING) {
	console.log(`\n*** a browser that says ${JSON.stringify(WORDING)}: everything must still pass ***\n`);
}

/// Every line of the mock log, as records.
///
/// LINES AND NOT BYTES. The obvious mark is `statSync(LOG).size`, and it is wrong: the log holds
/// the system prompt, which is full of multi-byte characters, so a BYTE offset used to slice a
/// decoded STRING lands past where it should and takes the next record's opening with it. The
/// first version of this file did exactly that, and the regression guard read "0 requests" for a
/// turn that had plainly made one. The log is one JSON object per line, so a line count is exact.
const records = () => {
	let raw = '';
	try { raw = fs.readFileSync(LOG, 'utf8'); } catch (e) { return []; }
	return raw.split('\n').filter(Boolean)
		.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } });
};

/// How many requests the model has been sent so far, as a mark to read forward from.
const logMark = () => records().length;

/// Every request the model was shown since `from`, parsed.
const shown = (from) => records().slice(from).filter(Boolean);

/// Every message of every request in that span, flattened.
const shownMsgs = (from) => {
	const out = [];
	for (const r of shown(from)) {
		const ms = (r && r.body && r.body.messages) || (r && r.messages) || [];
		for (const m of ms) out.push(m);
	}
	return out;
};

/// What the thread holds, and what is offered about the last answer in it.
const thread = () => p.evaluate(() => {
	const inter = [...document.querySelectorAll('#chat-output .chat-msg.interrupted')].pop() || null;
	return {
		interrupted: !!inter,
		continues:   !!(inter && inter.querySelector('.turn-interrupted button')),
		badge:       inter ? ((inter.querySelector('.ti-label') || {}).textContent || '') : '',
		errors:      [...document.querySelectorAll('#chat-output .chat-msg-error, #chat-output .error-log')].length,
		text:        (document.getElementById('chat-output') || {}).textContent || '',
		tries:       window.__loadFailCount || 0,
	};
});

/// The MODEL's own conversation as the app has STORED it — not the screen transcript.
///
/// `chat.session.msgs` is what `captureSession` writes at the end of every turn, and it is what
/// `restore_session` feeds back to the engine on the next one. It is the durable record, and it
/// is the thing the apology was getting into.
const storedSession = async () => {
	const chats = await storedChats(s);
	if (!chats || !chats.length) return null;
	let best = null;
	for (const c of chats) {
		if (c && c.session && Array.isArray(c.session.msgs) && c.session.msgs.length) {
			if (!best || (c.updated || 0) >= (best.updated || 0)) best = c;
		}
	}
	return best ? { msgs: best.session.msgs } : null;
};

/// Wait for the composer to offer Send again — the app's own "the turn is over".
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

/// Does any message here carry the failure, in any of the shapes it could take?
///
/// Deliberately broad. The point is not that one particular sentence is absent but that NOTHING
/// about a dead fetch reached the model, so this looks for the browser's wording, the app's mark
/// and the tool layer's error opening alike.
const carriesFailure = (m) => {
	const c = m && m.content;
	const s = typeof c === 'string' ? c : JSON.stringify(c || '');
	return s.indexOf(WORDING) !== -1
		|| /Load failed|daimond-road|Error: .*fetch|could not reach that page/i.test(s);
};

try {
	await newChat(s);

	// ── 1-5. The road goes under a tool call ─────────────────────
	const mark0 = logMark();
	await p.evaluate(() => { window.__loadFail = true; });
	await p.fill('#chat-input', '@tool web_fetch {"url":"https://example.test/"}');
	await p.click('#chat-send');
	// Sampled while the ladder is still climbing, which is the only window there is.
	await p.waitForTimeout(2000);
	const caption = await p.evaluate(() => {
		const el = document.querySelector('.chat-spinner-say');
		return el ? (el.textContent || '') : '';
	});

	const end1 = await settle('tool-road');
	const t1 = await thread();
	await shot(s, 'toolroad-interrupted');

	check(t1.tries > 0,
		'THE INSTRUMENT FIRED — the tool really did meet a rejected fetch',
		`${t1.tries} attempt(s) refused with ${JSON.stringify(WORDING)}`);

	// 2. THE CHECK THIS FILE EXISTS FOR.
	const msgs1 = shownMsgs(mark0);
	const told  = msgs1.filter(carriesFailure);
	check(told.length === 0,
		'THE MODEL WAS NEVER TOLD THE FETCH DIED — no request carries the failure',
		told.length
			? `${told.length} message(s), first: ${JSON.stringify(String(told[0].content).slice(0, 120))}`
			: `${msgs1.length} message(s) shown to the model, none of them the failure`);

	// And the apology it would have written is not on screen either, which is the symptom the
	// owner actually reported. Matched on the shape rather than on one model's words.
	check(!/can.?t get through|could not reach the web|unable to (access|reach)/i.test(t1.text),
		'AND NO APOLOGY WAS WRITTEN for a failure that was never the world\'s',
		JSON.stringify(t1.text.replace(/\s+/g, ' ').slice(0, 120)));

	// 4. The ladder was climbed, and said so.
	check(t1.tries > 1,
		'THE LADDER WAS CLIMBED — a read is tried again rather than reported',
		`${t1.tries} attempt(s)`);
	check(/connection dropped|trying/i.test(caption),
		'and the app said so while it climbed, in its own voice',
		JSON.stringify(caption.slice(0, 90)));

	// 3. And the turn came back the way a dropped provider call does.
	check(end1.ended, 'the turn ends rather than hanging on the road', `${end1.ms} ms`);
	check(t1.interrupted && t1.continues,
		'THE TURN IS HANDED BACK, badged, with a Continue',
		t1.interrupted ? '' : `${t1.errors} error line(s), nothing marked interrupted`);
	check(/connection dropped/i.test(t1.badge),
		'and the badge says the CONNECTION DROPPED, not that a tool failed',
		JSON.stringify(t1.badge.slice(0, 90)));

	// 5. And nothing false is in the model's own stored conversation.
	const sess1 = await storedSession();
	if (!sess1) {
		console.log('  note  no probe for the stored session; check 5 is skipped');
	} else {
		const dirty = sess1.msgs.filter(carriesFailure);
		check(dirty.length === 0,
			'THE STORED SESSION CARRIES NO APOLOGY AND NO DEAD TOOL RESULT',
			dirty.length ? `${dirty.length} message(s) of ${sess1.msgs.length}` : `${sess1.msgs.length} kept`);
		// pair_up's rule, asserted on the stored list: no assistant turn may carry a call that
		// nothing answers.
		const dangling = sess1.msgs.filter((m, i) => {
			if (m.role !== 'assistant' || !(m.tool_calls || []).length) return false;
			const answered = new Set();
			for (let j = i + 1; j < sess1.msgs.length && sess1.msgs[j].role === 'tool'; j++) {
				answered.add(sess1.msgs[j].tool_call_id);
			}
			return m.tool_calls.some((tc) => !answered.has(tc.id));
		});
		check(dangling.length === 0,
			'AND NO ASSISTANT TURN CARRIES A CALL NOTHING ANSWERED',
			`${dangling.length} dangling`);
	}

	// ── 9. THE LADDER PARKS WHILE THE PAGE IS FROZEN ─────────────
	//
	// This is the one genuinely new mechanism and the only part of it that can be measured from
	// here. A request already in flight CANNOT be parked -- the promise belongs to the browser,
	// the page's JavaScript is not running while the page is frozen, and by the time anything of
	// ours runs again the request has already been rejected. What can be parked is the moment
	// BEFORE a request, and that is what `Agent::over_the_road` does: it sleeps its backoff and
	// then waits for `document.visibilityState` to say `visible` again.
	//
	// MEASURED BY THE SHAPE OF THE COUNT, which is falsifiable without a break: with the park,
	// attempts stall at one while the page is hidden and resume when it comes back. Without it,
	// all eight are spent into a dead page within a few seconds and the count would already be at
	// its ceiling by the first sample below. The two are not close.
	//
	// `visibilityState` is overridden rather than the page really being backgrounded, because a
	// headless browser has no app to switch to. What is simulated is the one signal the engine
	// reads, and it reads it the same way whoever set it.
	await newChat(s);
	await p.evaluate(() => {
		Object.defineProperty(document, 'visibilityState',
			{ get: () => 'hidden', configurable: true });
		window.__loadFail = true;
		window.__loadFailCount = 0;
	});
	await p.fill('#chat-input', '@tool web_fetch {"url":"https://example.test/frozen"}');
	await p.click('#chat-send');
	await p.waitForTimeout(8000);
	const whileHidden = await p.evaluate(() => window.__loadFailCount || 0);
	check(whileHidden > 0 && whileHidden <= 2,
		'THE LADDER PARKS WHILE THE PAGE IS FROZEN rather than spending itself into a dead page',
		`${whileHidden} attempt(s) in 8 s hidden — the whole budget is ${8} attempts`);
	// And it comes back when the page does.
	await p.evaluate(() => {
		Object.defineProperty(document, 'visibilityState',
			{ get: () => 'visible', configurable: true });
	});
	await p.waitForTimeout(4000);
	const afterShow = await p.evaluate(() => window.__loadFailCount || 0);
	check(afterShow > whileHidden,
		'AND IT RESUMES WHEN THE PAGE COMES BACK, rather than having given up in the dark',
		`${whileHidden} attempt(s) hidden, ${afterShow} after the restore`);
	await settle('frozen');
	await shot(s, 'toolroad-frozen');

	// ── 7. The regression guard ──────────────────────────────────
	//
	// Carry on by TYPING, not by pressing Continue and not by reloading — the one path on which
	// `pair_up` does not run for you. What must not happen is the provider being handed an
	// assistant turn whose tool_use block nothing answers.
	await p.evaluate(() => { window.__loadFail = false; });
	const mark1 = logMark();
	await p.fill('#chat-input', '@text carrying on');
	await p.click('#chat-send');
	const end2 = await settle('second-prompt');
	const msgs2 = shown(mark1);
	let dangled = 0, requests = 0;
	for (const r of msgs2) {
		const ms = (r && r.body && r.body.messages) || (r && r.messages) || [];
		if (!ms.length) continue;
		requests++;
		for (let i = 0; i < ms.length; i++) {
			const m = ms[i];
			if (m.role !== 'assistant' || !(m.tool_calls || []).length) continue;
			const answered = new Set();
			for (let j = i + 1; j < ms.length && ms[j].role === 'tool'; j++) {
				answered.add(ms[j].tool_call_id);
			}
			if (m.tool_calls.some((tc) => !answered.has(tc.id))) dangled++;
		}
	}
	check(end2.ended && requests > 0 && dangled === 0,
		'REGRESSION GUARD: typing again in the same sitting sends a LEGAL conversation',
		`${requests} request(s), ${dangled} carrying an unanswered tool call`);

	// ── 6. THE CONTROL ───────────────────────────────────────────
	//
	// A tool that fails for a REMOTE reason must still reach the model, unchanged. Without this,
	// every check above would pass on a build that simply stopped reporting tool failures at all
	// — which is a far worse app than the one being fixed.
	await p.route('**/api/web/fetch', (r) => r.fulfill({
		status: 502, contentType: 'application/json',
		body: JSON.stringify({ ok: false, error: 'that page refused the gateway (502)' }),
	}));
	await newChat(s);
	const mark2 = logMark();
	await p.fill('#chat-input', '@tool web_fetch {"url":"https://example.test/gone"}');
	await p.click('#chat-send');
	const end3 = await settle('remote-refusal');
	const t3 = await thread();
	const msgs3 = shownMsgs(mark2);
	const heard = msgs3.filter((m) => {
		const c = m && m.content;
		const s2 = typeof c === 'string' ? c : JSON.stringify(c || '');
		return m.role === 'tool' && /refused the gateway|502/i.test(s2);
	});
	check(end3.ended, 'a remote refusal ends too', `${end3.ms} ms`);
	check(heard.length > 0,
		'THE CONTROL: A REMOTE REFUSAL STILL REACHES THE MODEL — only the road is withheld',
		heard.length ? '' : `${msgs3.length} message(s) shown, none carrying the far end's answer`);
	check(!t3.interrupted,
		'and it is NOT offered back as an interrupted turn: the far end answered',
		t3.interrupted ? 'a 502 was badged as a dropped connection' : '');
	await shot(s, 'toolroad-remote');
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
