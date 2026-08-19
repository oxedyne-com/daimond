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
//   3. AND CONTINUE RUNS IT AGAIN, from the prompt the user typed — which they
//      never have to retype, and which is the whole point of keeping it.
//   4. BUT A PROVIDER REFUSAL IS STILL TERMINAL. This is the check that makes the
//      other three mean something: if everything became recoverable then nothing
//      was classified, and a 500 from the provider would sit there offering a
//      Continue that will fail the same way for ever.
//
// EACH PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_dropped.mjs --break terminal   # 1-3 fail: every death is terminal again
//   node dev/verify_dropped.mjs --break everything # 4 fails: a 500 is offered back too
//   node dev/verify_dropped.mjs                    # and then, clean
//
// `--break terminal` restores the old condition — `_unloading` alone — which is
// the state the defect was reported from. `--break everything` widens it to every
// error, which is the plausible over-correction and the reason check 4 exists.
//
//   eval "$(bash dev/world.sh 4 --up)"
//   node dev/verify_dropped.mjs
//
// Needs dev/serve.mjs and the mock. No gateway, no wasm rebuild — the branch under
// test is JavaScript.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, scratch, shot } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// The one line that decides it, and the two ways of getting it wrong.
const COND = '\t\t\t\t} else if (offline(e)) {';
const BREAKS = {
	// The state before the fix: only a closing page keeps its turn.
	terminal:   '\t\t\t\t} else if (false) {',
	// The over-correction: everything is recoverable, so nothing is classified.
	everything: '\t\t\t\t} else if (true) {',
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
if (SRC.split(COND).length !== 2) {
	console.error('the branch this file measures is not in js/daimond.js exactly once; '
		+ 'the anchor has moved and the breaks below would patch nothing');
	process.exit(2);
}

const s = await open({
	name:    'dropped',
	profile: scratch('pw', 'dropped' + (BREAK ? '-' + BREAK : '')),
	// Serve the damaged file in place of the real one, so the page under test is
	// the shipped page with one line changed and not a copy of it. Registered
	// before `goto`, which is what `route` is for.
	route:   BREAK ? (async (page) => {
		const body = SRC.replace(COND, BREAKS[BREAK]);
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

try {
	await newChat(s);

	// ── 1 and 2. The road fails part way through an answer ───────
	//
	// Three words arrive and then the socket is destroyed: no `[DONE]`, no finish
	// reason, exactly what a lid closing does to a connection.
	await p.fill('#chat-input', '@drop 3');
	await p.click('#chat-send');
	await p.waitForTimeout(6000);
	const dropped = await lastTurn();
	await shot(s, 'dropped-interrupted');

	check(dropped.interrupted,
		'A DROPPED CONNECTION LEAVES AN INTERRUPTED TURN, not a dead one',
		`last message class ${JSON.stringify(dropped.lastClass)}`);
	check(dropped.continues,
		'and the turn is offered back with a Continue button',
		dropped.interrupted ? 'no button in .turn-interrupted' : 'nothing was marked interrupted');
	// The words that DID arrive. Asserted on a word the mock only sends in this
	// mode, so a generic reply cannot satisfy it.
	check(/word-1/.test(dropped.text),
		'AND THE WORDS THAT ARRIVED SURVIVE — the partial answer is still there',
		JSON.stringify(dropped.text.slice(0, 80)));

	// ── 3. Continue re-runs it from the prompt ───────────────────
	//
	// The user must not have to retype. Pressing Continue drops the interrupted
	// turn's messages and sends the original prompt again -- which, since the
	// prompt IS `@drop 3`, drops again. That is what makes this a clean test of
	// REPLACEMENT: what must be true afterwards is one question and one interrupted
	// answer, not two of each. A turn that completed would prove nothing about
	// whether the old one had been cleared away.
	const before = await p.evaluate(() =>
		document.querySelectorAll('#chat-output .chat-msg').length);
	if (dropped.continues) {
		await p.evaluate(() => {
			const inter = [...document.querySelectorAll('#chat-output .chat-msg.interrupted')].pop();
			inter.querySelector('.turn-interrupted button').click();
		});
		await p.waitForTimeout(6000);
	}
	const after = await p.evaluate(() => ({
		count: document.querySelectorAll('#chat-output .chat-msg').length,
		// The interrupted turn is REPLACED, not added to: its messages are
		// tombstoned so a reload cannot resurrect them beside the retry.
		interruptedCount: document.querySelectorAll('#chat-output .chat-msg.interrupted').length,
		user: [...document.querySelectorAll('#chat-output .chat-msg-user .chat-msg-content')]
			.map(e => e.textContent).join('|'),
	}));
	check(dropped.continues && after.interruptedCount === 1,
		'CONTINUE RE-RUNS THE TURN and the interrupted one is replaced rather than piled on',
		`${before} messages before, ${after.count} after, ${after.interruptedCount} interrupted`);
	// One question, not two. This is the assertion that caught the first version of
	// the fix: the prompt was left untagged, so Continue removed the answer, sent
	// the question again, and the thread held it twice.
	check(after.user.split('|').filter(Boolean).length === 1,
		'from the prompt the user typed, once, which they never had to type again',
		JSON.stringify(after.user.slice(0, 80)));

	// ── 4. A provider refusal is still terminal ──────────────────
	//
	// THE CHECK THAT MAKES THE OTHERS MEAN SOMETHING. A 500 is the provider
	// answering: it is not interrupted work, and offering Continue on it would
	// offer a button that fails identically every time it is pressed.
	await newChat(s);
	await p.fill('#chat-input', '@err 500');
	await p.click('#chat-send');
	await p.waitForTimeout(5000);
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
