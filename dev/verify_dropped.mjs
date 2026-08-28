// verify_dropped.mjs — a turn the ROAD killed is handed back; a turn the PROVIDER
// refused is not.
//
// THE DEFECT, reported live on 2026-08-19 by a user working from a laptop:
// *"I am moving around during some days like today on my laptop, closing it and
// moving between locations, so there can be frequent and long interruptions."*
// Each interruption killed the turn outright. The prompt they had typed, the part
// of the answer that had arrived, and the tools that had already run were all
// deleted, and the only thing left was a red line.
//
// WHY IT WAS NOT A RETRY PROBLEM, which is what it looked like and what was first
// tried. `LlmClient::stream_turn` does not retry once tokens have started —
// `if started || !e.retryable` — and that is correct: re-sending a request whose
// answer was half delivered bills the answer twice. So the commonest shape of
// this, a break part way through a reply, was never retryable at any budget. A
// wider retry policy buys a couple of minutes against a gap that lasts as long as
// the walk between two buildings.
//
// WHAT WAS ACTUALLY MISSING was a judgement, not a mechanism. Everything needed to
// hand a turn back had been built for the tab-crash case: the write-ahead journal
// holds the prompt, the partial reply and the tools that ran, and `markInterrupted`
// draws the badge and the Continue button. But `runTurn`'s catch split the world in
// two — `_unloading`, which kept the turn, and everything else, which threw it away
// — and a suspended laptop is neither. It is not unloading; it is asleep.
//
// FOUR PROPERTIES:
//
//   1. A DROPPED CONNECTION LEAVES AN INTERRUPTED TURN, not an error. The badge is
//      on screen and the Continue button with it.
//   2. AND THE WORDS THAT ARRIVED SURVIVE. A turn handed back empty is barely
//      better than one thrown away; the partial answer is read off the message.
//   3. AND CONTINUE CONTINUES IT. The words that arrived STAY, and the model is asked
//      to carry on from them.
//
//      IT USED TO RE-RUN THE PROMPT, tombstoning the partial reply first. Two costs, and
//      the second is the one that was reported: output tokens already billed were thrown
//      away and bought again, and THE ANSWER THE USER WAS READING WAS REPLACED BY A
//      DIFFERENT ONE. They watched text appear, pressed the button the app offered them,
//      and the text became something else with no way back to it. A tester described
//      exactly that shape — "I see some response text from a model, then later it is
//      superceded by a final answer and I can't see what was there before".
//
//      A turn that died BEFORE THE FIRST TOKEN still re-runs the prompt, and that is
//      right: there is nothing to carry on from and nothing was billed. That case is
//      dev/verify_predrop.mjs.
//   4. BUT A PROVIDER REFUSAL IS STILL TERMINAL. This is the check that makes the
//      other three mean something: if everything became recoverable then nothing
//      was classified, and a 500 from the provider would sit there offering a
//      Continue that will fail the same way for ever.
//
// EACH PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_dropped.mjs --break terminal   # 1-3 fail: every death is terminal again
//   node dev/verify_dropped.mjs --break everything # 4 fails: a 500 is offered back too
//   node dev/verify_dropped.mjs --break rerun      # 3 fails: Continue throws the partial away
//   node dev/verify_dropped.mjs                    # and then, clean
//
// `--break terminal` restores the old condition — `_unloading` alone — which is
// the state the defect was reported from. `--break everything` widens it to every
// error, which is the plausible over-correction and the reason check 4 exists.
// `--break rerun` sends every Continue down the path meant for a turn that produced
// nothing, which is `continueTurn` exactly as it stood on 2026-08-27: tombstone the
// turn and ask the question again.
//
// WAITING FOR THE TURN TO END, RATHER THAN FOR A FIXED FIVE SECONDS. Check 4 sends
// `@err 500` and used to look at the thread 5,000 ms later. A 500 is RETRYABLE —
// `RetryPolicy::default()` in `src/llm.rs` is eight attempts over up to 120 s of
// backoff, widened from four attempts over 20 s on 2026-08-19 so a laptop that
// wakes in another building does not lose its turn — so at five seconds the turn
// is on attempt 4 of 8 and has not ended. Measured in world 7 on 2026-08-21: the
// first request goes out at once, the retry notices land at 1.1, 1.7, 2.8, 4.8,
// 12.1, 20.9 and 40.8 s, and the error line is written at 69.2 s. Nothing was
// misclassified; the file was reading the thread mid-turn.
//
// That made check 4a pass for the wrong reason as well: NOTHING is marked
// interrupted five seconds in, because nothing has ended, so "a 500 is not offered
// back" was true of a turn that was still running. Both checks now wait on the
// composer — the app's own "this turn is over" — and the wait is bounded well
// above the retry budget, so a turn that really hangs still fails rather than
// being waited out.
//
//   eval "$(bash dev/world.sh 4 --up)"
//   node dev/verify_dropped.mjs
//
// Needs dev/serve.mjs and the mock. No gateway, no wasm rebuild — the branch under
// test is JavaScript.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, scratch, shot, storedChats } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// The two lines that decide it, and the three ways of getting them wrong. Each break
// names the line it patches, so an anchor that has moved is caught rather than skipped.
const COND = '\t\t\t\t} else if (offline(e)) {';
const PART = '\t\tif (!partial.trim()) {';
const BREAKS = {
	// The state before the fix: only a closing page keeps its turn.
	terminal:   [COND, '\t\t\t\t} else if (false) {'],
	// The over-correction: everything is recoverable, so nothing is classified.
	everything: [COND, '\t\t\t\t} else if (true) {'],
	// Continue as it was before it continued anything.
	rerun:      [PART, '\t\tif (true) {'],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const SRC = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
for (const anchor of [COND, PART]) {
	if (SRC.split(anchor).length !== 2) {
		console.error(`the line ${JSON.stringify(anchor.trim())} is not in js/daimond.js `
			+ 'exactly once; the anchor has moved and the breaks below would patch nothing');
		process.exit(2);
	}
}

const s = await open({
	name:    'dropped',
	profile: scratch('pw', 'dropped' + (BREAK ? '-' + BREAK : '')),
	// Serve the damaged file in place of the real one, so the page under test is
	// the shipped page with one line changed and not a copy of it. Registered
	// before `goto`, which is what `route` is for.
	route:   BREAK ? (async (page) => {
		const body = SRC.replace(BREAKS[BREAK][0], BREAKS[BREAK][1]);
		await page.route('**/js/daimond.js', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}) : null,
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

/// What the last assistant message in the thread is, and what is offered about it.
const lastTurn = () => p.evaluate(() => {
	const msgs = [...document.querySelectorAll('#chat-output .chat-msg')];
	const last = msgs[msgs.length - 1] || null;
	const inter = [...document.querySelectorAll('#chat-output .chat-msg.interrupted')].pop() || null;
	return {
		interrupted: !!inter,
		// The button by its role rather than its words, so a translation does not
		// decide whether this file passes.
		continues:   !!(inter && inter.querySelector('.turn-interrupted button')),
		text:        inter ? (inter.querySelector('.chat-msg-content') || {}).textContent || '' : '',
		errors:      [...document.querySelectorAll('#chat-output .chat-msg-error, #chat-output .error-log')].length,
		lastClass:   last ? last.className : '',
	};
});

/// Wait for the composer to offer Send again — the app's own "the turn is over".
///
/// The bound is above `RetryPolicy::default()`'s whole budget (eight attempts,
/// `max_total_wait_ms` 120 s, `max_backoff_ms` 30 s) plus the requests between
/// them, so a turn that ends fails nothing and a turn that HANGS still fails.
/// Answers how long it waited, because that number is the retry budget and a
/// change to it should be visible here rather than as a mystery timeout.
const settle = async (label, timeout = 180000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const busy = await p.evaluate(() => {
			const b = document.getElementById('chat-send');
			return !!b && (b.classList.contains('stop') || b.disabled);
		});
		if (!busy) return { ended: true, ms: Date.now() - t0 };
		await p.waitForTimeout(200);
	}
	console.log(`  note  the ${label} turn was still running after ${timeout} ms`);
	return { ended: false, ms: Date.now() - t0 };
};

try {
	await newChat(s);

	// ── 1 and 2. The road fails part way through an answer ───────
	//
	// Three words arrive and then the socket is destroyed: no `[DONE]`, no finish
	// reason, exactly what a lid closing does to a connection.
	await p.fill('#chat-input', '@drop 3');
	await p.click('#chat-send');
	const dropEnd = await settle('dropped');
	check(dropEnd.ended, 'THE DROPPED TURN ENDS rather than hanging on the road',
		`${dropEnd.ms} ms`);
	const dropped = await lastTurn();
	await shot(s, 'dropped-interrupted');

	check(dropped.interrupted,
		'A DROPPED CONNECTION LEAVES AN INTERRUPTED TURN, not a dead one',
		`last message class ${JSON.stringify(dropped.lastClass)}`);
	check(dropped.continues,
		'and the turn is offered back with a Continue button',
		dropped.continues ? '' : (dropped.interrupted ? 'no button in .turn-interrupted'
			: 'nothing was marked interrupted'));
	// The words that DID arrive. Asserted on a word the mock only sends in this
	// mode, so a generic reply cannot satisfy it.
	check(/word-1/.test(dropped.text),
		'AND THE WORDS THAT ARRIVED SURVIVE — the partial answer is still there',
		JSON.stringify(dropped.text.slice(0, 80)));

	// ── 3. Continue CONTINUES it ───────────────────────────────
	//
	// The words the user was reading must still be there afterwards. Pressing Continue
	// keeps the partial as an ordinary answer and asks the model to carry on from it, so
	// what must be true afterwards is: the same question once, `word-1` still on screen,
	// nothing badged interrupted any more, and MORE messages than before rather than the
	// same ones rewritten.
	//
	// THE ASSERTION THAT MATTERS IS `word-1` SURVIVING. The count and the badge are
	// bookkeeping; the text is the complaint.
	const before = await p.evaluate(() =>
		document.querySelectorAll('#chat-output .chat-msg').length);
	// THE PARTIAL'S OWN ID, off the disk. Text alone cannot answer this question: the
	// prompt is `@drop 3`, so a Continue that RE-RUNS it produces `word-1 word-2` a
	// second time and a check on the words passes while the user's answer has in fact
	// been thrown away and bought again. The `mid` is the only thing that tells a kept
	// message from an identical new one.
	const midOf = async () => {
		const chats = await storedChats(s);
		for (const c of chats) {
			for (const m of (c.messages || [])) {
				if (m.role === 'assistant' && m.interrupted && /word-1/.test(m.content || '')) {
					return m.mid;
				}
			}
		}
		return '';
	};
	const partialMid = await midOf();
	if (dropped.continues) {
		await p.evaluate(() => {
			const inter = [...document.querySelectorAll('#chat-output .chat-msg.interrupted')].pop();
			inter.querySelector('.turn-interrupted button').click();
		});
		await settle('continued');
	}
	const after = await p.evaluate(() => ({
		count: document.querySelectorAll('#chat-output .chat-msg').length,
		// Nothing is left badged: the partial has become an ordinary answer, and the
		// continuation finished cleanly.
		interruptedCount: document.querySelectorAll('#chat-output .chat-msg.interrupted').length,
		user: [...document.querySelectorAll('#chat-output .chat-msg-user .chat-msg-content')]
			.map(e => e.textContent).join('|'),
		// Every assistant word on screen, so "is what I was reading still here?" is asked
		// of the thread rather than of one element.
		said: [...document.querySelectorAll('#chat-output .chat-msg-assistant .chat-msg-content')]
			.map(e => e.textContent).join(' '),
	}));
	// The same record, still there, still holding the same words, no longer badged.
	const kept = await (async () => {
		const chats = await storedChats(s);
		for (const c of chats) {
			for (const m of (c.messages || [])) {
				if (m.mid && m.mid === partialMid) {
					return { there: true, said: /word-1/.test(m.content || ''),
						badged: !!m.interrupted };
				}
			}
		}
		return { there: false, said: false, badged: false };
	})();
	check(!!partialMid && kept.there && kept.said && !kept.badged && /word-1/.test(after.said),
		'CONTINUE KEEPS WHAT THE USER WAS READING — the same message, not a fresh copy',
		kept.there ? (kept.badged
				? 'the message with that id is still badged interrupted, so what is on screen '
					+ 'is a fresh turn beside it: the turn was re-run, not continued'
				: (kept.said ? '' : 'the id survived but the words did not'))
			: `no message ${JSON.stringify(partialMid)} survives: the answer the user was `
				+ 'reading was thrown away and generated again');
	check(dropped.continues && after.interruptedCount === 0 && after.count > before,
		'and the turn carries on from it rather than starting again',
		`${before} messages before, ${after.count} after, ${after.interruptedCount} interrupted`);
	// One question, not two. This is the assertion that caught the first version of
	// the offline branch: the prompt was left untagged, so Continue removed the answer,
	// sent the question again, and the thread held it twice. It still holds, and it is
	// what tells a continuation apart from a re-run: the app's own "carry on" line is
	// the second user message, and the user's question is never sent twice.
	const asked = after.user.split('|').filter(Boolean);
	check(asked.filter(u => /@drop 3/.test(u)).length === 1,
		'and the prompt the user typed was never sent again',
		JSON.stringify(after.user.slice(0, 110)));

	// ── 4. A provider refusal is still terminal ──────────────────
	//
	// THE CHECK THAT MAKES THE OTHERS MEAN SOMETHING. A 500 is the provider
	// answering: it is not interrupted work, and offering Continue on it would
	// offer a button that fails identically every time it is pressed.
	await newChat(s);
	await p.fill('#chat-input', '@err 500');
	await p.click('#chat-send');
	// THE TURN MUST HAVE ENDED BEFORE EITHER CHECK BELOW MEANS ANYTHING. A 500 is
	// retryable, so this is not a five-second wait: it is the retry ladder running
	// to the end of its budget, about seventy seconds against the mock. Asked as a
	// check of its own, because "a 500 is not offered back" is trivially true of a
	// turn still in flight and was passing that way.
	const errEnd = await settle('500');
	check(errEnd.ended,
		'A PROVIDER 500 IS RETRIED TO THE END OF THE BUDGET AND THEN THE TURN ENDS',
		`${errEnd.ms} ms`);
	const refused = await lastTurn();
	await shot(s, 'dropped-refusal');
	check(!refused.interrupted,
		'BUT A PROVIDER REFUSAL IS STILL TERMINAL — a 500 is not offered back',
		refused.interrupted ? 'a 500 was marked interrupted and offers a Continue that cannot work'
			: 'no interrupted badge');
	check(refused.errors > 0,
		'and is reported as the error it is',
		`${refused.errors} error lines`);
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
