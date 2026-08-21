// verify_waiting.mjs — the waiting indicator means "this turn is still running".
//
// The complaint, against the live app: the dots cleared when the FIRST thing came
// back, not when the turn ended. A turn is one request per tool-call round, so a
// long run of tool calls is minutes of work, and with the steps hidden nothing on
// screen changes for any of it. What the user saw was the indicator vanish and
// then a still page — indistinguishable from a session that had died. An earlier
// round fixed the short gap, between pressing send and the first token; this is
// the long one, and the long one is the one that reads as death.
//
// So the property is not "a spinner appears". It is:
//
//   * WHILE the app says a turn is running, the indicator is up. Sampled
//     throughout, so a single moment of absence anywhere in the turn fails —
//     which is what the old code did at the first tool call.
//   * It stays at the FOOT of the thread. An indicator that sinks above each new
//     tool block says "running file_read" halfway up a thread that has moved on.
//   * It SAYS something, and what it says follows the tool that is actually
//     running. Dots that have not changed in four minutes are barely better than
//     no dots at all.
//   * It holds with the steps hidden, which is the case the complaint was about.
//   * Every way out of a turn takes it down. A stuck indicator is worse than one
//     that clears early, so the exits are enumerated and each one is driven:
//     the answer, an error, the Stop button, a provider refusal, a reload in the
//     middle, and walking away to another chat and back.
//   * It belongs to ONE chat. A turn running behind the chat on screen must put
//     nothing on that chat — not its dots, and not its words. The two are the
//     same rule read at two distances, and the second is the one that bites: a
//     daimon turn used to answer the question "am I the thing on screen?" once,
//     before it started, so walking away mid-turn left it streaming into
//     whichever thread had arrived.
//
// Two halves, and the first needs nothing running.
//
//   SOURCE  reads www/js/daimond.js and asserts that no event arm takes the
//           indicator down — only the end of a turn does. This is the half that
//           covers the exits a mock provider cannot produce (a turn that ends in
//           silence, a refused key that is reminted and retried): both arrive as
//           an `error` EVENT in the middle of a turn that then carries on, so the
//           rule "an error event is not an exit" is the thing to hold.
//   BROWSER drives real turns through the mock and samples the page while they
//           run.
//
//   node dev/verify_waiting.mjs             # both halves
//   node dev/verify_waiting.mjs --source    # the source half alone, no server
//
// Needs dev/serve.mjs and dev/mockllm.mjs for the browser half. No gateway.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, shot, errors, signInAs, steerDiamond } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPJS = path.join(HERE, '..', 'www', 'js', 'daimond.js');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	return pass;
};

// ── The source half ────────────────────────────────────────────────
//
// Brace-matched, not line-ranged: these functions move every week and a range
// would quietly start reading somewhere else rather than failing.

/// The body of the first `{…}` block that opens after `marker`.
const blockAfter = (src, marker) => {
	const at = src.indexOf(marker);
	if (at === -1) return null;
	let i = src.indexOf('{', at);
	if (i === -1) return null;
	let depth = 0;
	for (let j = i; j < src.length; j++) {
		if (src[j] === '{') depth++;
		else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
	}
	return null;
};

/// The `onEvent` sink declared inside `fnBody` — the arms that run DURING a turn.
const sinkOf = (fnBody) => fnBody && blockAfter(fnBody, 'var onEvent = function');

const src     = fs.readFileSync(APPJS, 'utf8');
const runTurn = blockAfter(src, 'async function runTurn(');
const doSteer = blockAfter(src, 'async function doSteer(');
const sync    = blockAfter(src, 'function syncComposer(');

check('runTurn, doSteer and syncComposer are all found in the source',
	!!(runTurn && doSteer && sync));

// Every way of saying "take the indicator down" that is reachable from inside a
// turn — the call itself, and any little helper the turn declares that makes it.
//
// Naming `hideSpinner` alone was not enough, and the proof is that it passed
// against the very code this exists to catch: the daimon's sink cleared the dots
// through a two-line `replyStarted()` of its own, so a check looking for the one
// name saw nothing wrong and reported green on a broken page. A check that passes
// for the wrong reason is worse than no check.
const clearersIn = (fnBody, sink) => {
	const names = ['hideSpinner'];
	const decl  = /(?:function\s+(\w+)\s*\(|var\s+(\w+)\s*=\s*function\s*\()/g;
	let m, added = true;
	const helpers = [];
	while ((m = decl.exec(fnBody || ''))) {
		const nm = m[1] || m[2];
		const body = blockAfter(fnBody.slice(m.index), nm);
		// The sink itself is the thing under test, not a way of reaching it.
		if (nm && body && body !== sink) helpers.push({ nm, body });
	}
	// A helper may clear through another helper, so settle it.
	while (added) {
		added = false;
		for (const h of helpers) {
			if (names.indexOf(h.nm) !== -1) continue;
			if (names.some(n => new RegExp('\\b' + n + '\\s*\\(').test(h.body))) {
				names.push(h.nm); added = true;
			}
		}
	}
	return names;
};

/// Places in `where` that take the indicator down, by any of `names`.
const clearsAt = (where, names) => names
	.map(n => ((where || '').match(new RegExp('\\b' + n + '\\s*\\(', 'g')) || []).length)
	.reduce((a, b) => a + b, 0);

const chatSink  = sinkOf(runTurn);
const steerSink = sinkOf(doSteer);
check('a chat turn has an event sink to inspect',   !!chatSink);
check('a daimon turn has an event sink to inspect', !!steerSink);

const chatClearers  = clearersIn(runTurn, chatSink);
const steerClearers = clearersIn(doSteer, steerSink);
check('nothing that arrives DURING a chat turn takes the indicator down',
	clearsAt(chatSink, chatClearers) === 0,
	clearsAt(chatSink, chatClearers)
		? clearsAt(chatSink, chatClearers) + ' place(s) in the sink still clear it, via ' + chatClearers.join('/') : '');
check('nor during a daimon turn, which behaves identically to a chat',
	clearsAt(steerSink, steerClearers) === 0,
	clearsAt(steerSink, steerClearers)
		? clearsAt(steerSink, steerClearers) + ' place(s) in the sink still clear it, via ' + steerClearers.join('/') : '');

// An error EVENT is not the end of a turn: a refused key is reminted and the same
// turn run again, and the guard that raises "the model ended its turn without
// saying anything" leaves the turn to finish underneath it. Both would clear the
// indicator on a page that still had work to do.
const errArm = chatSink && blockAfter(chatSink.slice(chatSink.indexOf("ev.type === 'error'")), ')');
check('an error reported mid-turn is not treated as the end of the turn',
	!!errArm && clearsAt(errArm, chatClearers) === 0);

// And the one place it does come down: where the turn ends, however it ended.
const ends = runTurn && blockAfter(runTurn.slice(runTurn.lastIndexOf('} finally {')), 'finally');
check('the end of a turn is where the indicator comes down',
	!!ends && /syncComposer\s*\(|hideSpinner\s*\(/.test(ends));

// `syncComposer` is what decides whether the chat ON SCREEN is working, so it has
// to be able to raise the indicator as well as lower it — otherwise coming back
// to a chat that is still running finds a thread that was rebuilt without one.
check('the composer sync can raise the indicator as well as take it down',
	!!sync && /showSpinner\s*\(/.test(sync) && /hideSpinner\s*\(/.test(sync));

if (process.argv.includes('--source')) {
	console.log(`\n${ok.length} passed, ${bad.length} failed`);
	if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
	process.exit(bad.length ? 1 : 0);
}

// ── The browser half ───────────────────────────────────────────────

/// Watch the thread while a turn runs.
///
/// Sampled rather than event-driven, because what is being asserted is that
/// there is NO moment of absence — and a moment nobody looked at is exactly where
/// the old behaviour lived. `busy` is the composer's own Stop state, which is the
/// only signal the app itself trusts for "a turn is running"; nothing is typed
/// into the box during these turns, so Stop is what it shows.
const WATCH = () => {
	window.__wait = { samples: [], timer: null, said: [], obs: null };
	const tick = () => {
		const send = document.getElementById('chat-send');
		const out  = document.getElementById('chat-output');
		const el   = out ? out.querySelector('.chat-spinner') : null;
		const kids = out ? [...out.children].filter(e => e.id !== 'chat-queued') : [];
		const say  = el ? el.querySelector('.chat-spinner-say') : null;
		window.__wait.samples.push({
			busy: !!send && send.classList.contains('stop'),
			up:   !!el,
			last: !!el && kids.length > 0 && kids[kids.length - 1] === el,
			say:  say ? (say.textContent || '') : '',
		});
	};
	window.__wait.timer = setInterval(tick, 25);

	// EVERY caption, not every twenty-five milliseconds' worth. Sampling is the
	// right instrument for "there was no moment of absence", because a moment
	// nobody looked at is exactly where the old behaviour lived -- but it is the
	// wrong one for "it named the tools in the order they ran". Against the mock
	// a tool returns in about a millisecond, so the line naming it is overwritten
	// long before the next tick, and the check went red against code that was
	// doing the right thing. In front of a real provider the same caption stands
	// for as long as the tool takes, which is the case it exists for.
	const seen = window.__wait.said;
	const note = () => {
		const el = document.querySelector('#chat-output .chat-spinner .chat-spinner-say');
		const t = el ? (el.textContent || '').trim() : '';
		if (t && seen[seen.length - 1] !== t) seen.push(t);
	};
	const out = document.getElementById('chat-output');
	if (out) {
		window.__wait.obs = new MutationObserver(note);
		window.__wait.obs.observe(out, { subtree: true, childList: true, characterData: true });
	}
	tick();
	note();
};

const watch  = (p) => p.evaluate(WATCH);
const reap   = (p) => p.evaluate(() => {
	clearInterval(window.__wait.timer);
	if (window.__wait.obs) window.__wait.obs.disconnect();
	const s = window.__wait.samples;
	return {
		total:    s.length,
		working:  s.filter(x => x.busy).length,
		// The whole point: a moment when the app said it was working and the
		// thread showed nothing.
		dark:     s.filter(x => x.busy && !x.up).length,
		// A moment when the indicator had sunk above something else.
		adrift:   s.filter(x => x.busy && x.up && !x.last).length,
		// What it said, in the order it first said it -- from the observer, so a
		// caption that stood for less than one sampling interval still counts.
		saidIn:   window.__wait.said.slice(),
		mute:     s.filter(x => x.busy && x.up && !x.say.trim()).length,
	};
});

/// Send without waiting: the turn is what is being watched, not its answer.
const send = async (p, text) => {
	await p.fill('#chat-input', text);
	await p.click('#chat-send', { force: true });
};

/// Wait for the composer to offer Send again — the app's own "the turn is over".
///
/// `took` is how long that was, and it is reported rather than discarded: the
/// provider-failure exits below are the two turns whose length is a POLICY, and a
/// silent timeout is how a widened retry budget came to read as a stuck
/// indicator. See the `@err` loop.
const settle = async (p, timeout = 40000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const busy = await p.evaluate(() => {
			const b = document.getElementById('chat-send');
			return !!b && (b.classList.contains('stop') || b.disabled);
		});
		if (!busy) return { ended: true, took: Date.now() - t0 };
		await p.waitForTimeout(100);
	}
	return { ended: false, took: Date.now() - t0 };
};

/// Make a NEW chat from the rail, and say which one it turned out to be.
///
/// NOT `harness.newChat`, whose job is "get me into a chat" and which therefore
/// returns the instant a chat composer is already on screen. Called from inside
/// a chat it does nothing at all, and that is how the fresh-chat check below
/// came to fail against code that was right: it sampled the chat it meant to
/// leave — which of course had an indicator up, being the one that was working —
/// and reported it as the other chat's state leaking onto a fresh one that was
/// never made. The + and Start are what a person presses, so press those.
const freshChat = async (p) => {
	await p.click('#new-session-btn', { force: true });
	await p.waitForTimeout(400);
	const start = p.locator('.tile-start').first();
	if (await start.count()) await start.click({ force: true });
	await p.waitForTimeout(400);
	return p.evaluate(() => {
		const a = document.querySelector('.session-box.active');
		return a ? a.dataset.id : '';
	});
};

/// Open a chat through its own tile label, the way a person opens one.
const openChat = async (p, id) => {
	await p.evaluate((i) => {
		const box = document.querySelector('.session-box[data-id="' + i + '"]');
		const lab = box && box.querySelector('.tile-label');
		if (lab) lab.click();
	}, id);
	await p.waitForTimeout(800);
};

/// Everything the thread on screen is currently saying.
const threadText = (p) => p.evaluate(() => {
	const out = document.getElementById('chat-output');
	return out ? (out.innerText || '') : '';
});

/// Is anything left claiming to be running?
const resting = (p) => p.evaluate(() => {
	const out = document.getElementById('chat-output');
	return {
		spinner: !!(out && out.querySelector('.chat-spinner')),
		send:    !!document.querySelector('#chat-send:not(.stop)'),
	};
});

const s = await open({ name: 'waiting' });
const p = s.page;
await newChat(s);

// WHERE THE CHAIN'S FIRST TOOL WRITES, and it has to be somewhere it may.
//
// This said `waiting.txt` — a workspace-ROOT path — until 2026-08-14. Since the
// chat fence landed on 2026-08-12 a chat is confined to `chats/<id>/work`
// (`scopeChatTo`, www/js/daimond.js) and `Tool::guard` (src/tools.rs:5490) refuses a
// root path before the write ever happens. A refusal is instant, and instant is the
// problem here: the caption "Running file_write, step 1…" was replaced by the next
// one inside a single microtask checkpoint, so the observer below never saw it and
// two checks about WHAT THE INDICATOR SAID went red about a fence.
const SCRATCH = await p.evaluate(() => {
	const f = window.DaimondAttach.focus();
	return f && f.id ? window.DaimondAttach.chatScratch(f.id) : '';
});
check('the chat has a scratch folder, so its tools have real work to do', !!SCRATCH, SCRATCH);

// ── A turn of several tool calls, with the steps SHOWN ──────────────
//
// `@chain` is two rounds of one tool call each and then a text reply — the shape
// of a real agentic turn, and the shape the old code went dark for.

await watch(p);
await send(p, `@chain file_write {"path":"${SCRATCH}/waiting.txt","content":"hello"}`);
check('the multi-call turn ran to the end', (await settle(p)).ended);
const shown = await reap(p);

check('the app was seen working, so there was something to watch',
	shown.working > 0, shown.working + ' of ' + shown.total + ' samples');
check('the indicator never went dark while the turn was running',
	shown.dark === 0, shown.dark ? shown.dark + ' sample(s) with work in flight and nothing on screen' : '');
check('and it stayed at the foot of the thread, under what the turn had produced',
	shown.adrift === 0, shown.adrift ? shown.adrift + ' sample(s) with the indicator adrift above later output' : '');
check('it never sat there saying nothing',
	shown.mute === 0, shown.mute ? shown.mute + ' silent sample(s)' : '');
// The caption follows the work: `@chain` calls the named tool, then file_list.
check('it named the tool that was actually running, and then the next one',
	shown.saidIn.some(w => /file_write/.test(w)) && shown.saidIn.some(w => /file_list/.test(w)),
	shown.saidIn.join(' | '));
// BOTH HAVE TO BE THERE, and this is why. Written as a bare
// `findIndex(file_write) < findIndex(file_list)`, an ABSENT first caption scores -1
// and -1 is less than any index, so the check passed BECAUSE its subject was
// missing — green, beside a sibling going red about the very same absence. An
// ordering assertion over a set that may not hold either member has to say so.
const iWrote = shown.saidIn.findIndex(w => /file_write/.test(w));
const iList  = shown.saidIn.findIndex(w => /file_list/.test(w));
check('the tool it named first is the tool that ran first',
	iWrote >= 0 && iList >= 0 && iWrote < iList,
	`file_write at ${iWrote}, file_list at ${iList} — ` + shown.saidIn.join(' | '));
check('and the line changed as the turn went on, rather than standing still',
	shown.saidIn.length > 1, shown.saidIn.join(' | '));
// Nothing about how long the user has been waiting: the app may notice, and must
// never remark on it.
check('it says nothing about how long any of it has taken',
	!shown.saidIn.some(w => /\b(still|yet|long|wait|minute|second|patien)/i.test(w)),
	shown.saidIn.join(' | '));

const done1 = await resting(p);
check('the answer ends the turn, and the indicator goes with it',
	!done1.spinner && done1.send);

await shot(s, 'waiting-steps-shown');

// ── The same turn with the steps HIDDEN ─────────────────────────────
//
// The reported case. With the tool blocks hidden the thread genuinely does not
// change for the whole of a tool-call run, so the indicator is the only thing
// distinguishing work from a hang.

await p.evaluate(() => document.getElementById('steps-toggle-btn').click());
await p.waitForTimeout(200);

await watch(p);
await send(p, `@chain file_write {"path":"${SCRATCH}/waiting2.txt","content":"again"}`);
check('the hidden-steps turn ran to the end', (await settle(p)).ended);
const hidden = await reap(p);

// Prove the case is really the hidden one before asserting anything about it.
const reallyHidden = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const blocks = [...out.querySelectorAll('.tool-block')];
	return blocks.length > 0 && blocks.every(b => getComputedStyle(b).display === 'none');
});
check('the tool steps really are hidden, so this is the case that was reported',
	reallyHidden);
check('the indicator never went dark with the steps hidden either',
	hidden.dark === 0, hidden.dark ? hidden.dark + ' dark sample(s)' : '');
check('and it still said which tool was running, where nothing else could',
	hidden.saidIn.some(w => /file_write/.test(w)), hidden.saidIn.join(' | '));

await shot(s, 'waiting-steps-hidden');
await p.evaluate(() => document.getElementById('steps-toggle-btn').click());
await p.waitForTimeout(200);

// ── Exit: the user presses Stop ─────────────────────────────────────

await watch(p);
await send(p, '@long 80');
await p.waitForTimeout(1200);
const wasUp = await p.evaluate(() =>
	!!document.querySelector('#chat-output .chat-spinner'));
check('a long answer is still being watched over while it streams', wasUp);
await p.evaluate(() => document.getElementById('chat-send').click());   // Stop
check('the stopped turn ended', (await settle(p)).ended);
await reap(p);
const stopped = await resting(p);
check('stopping a turn takes the indicator down with it',
	!stopped.spinner && stopped.send);

// ── Exit: the provider fails ────────────────────────────────────────

// A 500 IS RETRIED AND A 403 IS NOT, so the two are not the same turn with a
// different number in it, and giving them one budget was what made this file red.
//
// `RetryPolicy::default()` (src/llm.rs) treats a 5xx as transient: eight attempts
// over up to 120 s of backoff, widened from four over 20 s on 2026-08-19 so that a
// laptop waking in another building keeps its turn. Measured in world 7 on
// 2026-08-21 the retry notices land at 1.1, 1.7, 2.8, 4.8, 12.1, 20.9 and 40.8 s
// and the turn ends at 59-69 s -- past the 40 s this waited, so it reported a
// stuck indicator on a turn that was still correctly retrying. The indicator was
// doing exactly what this file exists to require.
//
// So each code carries its own bound, and the bound on the 403 is the assertion:
// a refusal the client must not retry has to end PROMPTLY. Should 403 ever be
// classified retryable, the 403 arm goes over 15 s and this says so — which the
// single shared budget could not.
for (const { code, budget, why } of [
	{ code: 500, budget: 180000, why: 'retried: eight attempts, up to 120s of backoff' },
	{ code: 403, budget:  15000, why: 'not retried: the provider has answered' },
]) {
	await watch(p);
	await send(p, '@err ' + code);
	const end = await settle(p, budget);
	check(`the ${code} turn ended`, end.ended,
		`${(end.took / 1000).toFixed(1)}s of ${budget / 1000}s — ${why}`);
	await reap(p);
	const r = await resting(p);
	check(`a ${code} from the provider takes the indicator down`,
		!r.spinner && r.send);
}

// ── Exit: walk away mid-turn, and come back ─────────────────────────
//
// The half nobody sees. The thread is thrown away and rebuilt when a chat is
// opened, so a turn still running elsewhere used to leave the indicator detached:
// coming back found a chat that looked finished and was not, and — because the
// node was still held — the NEXT turn could not raise one at all.

// Whose tile to come back to. Taken before the turn starts, so the click below
// reaches THIS chat and not whichever tile happens to be first.
const working = await p.evaluate(() => {
	const a = document.querySelector('.session-box.active');
	return a ? a.dataset.id : '';
});
check('the chat about to be left is identifiable in the rail', !!working, working);

await send(p, '@long 160');
await p.waitForTimeout(1200);
const fresh = await freshChat(p);       // a second chat, on top of the running one
await p.waitForTimeout(600);
// Prove the case before asserting anything about it, as the hidden-steps case
// above does. A fresh-chat check that is standing on the chat it meant to leave
// is not testing a fresh chat, and it will say so either way.
check('the new chat really is another chat, not the one still working',
	!!fresh && fresh !== working, fresh + ' vs ' + working);
check('and it opened on a thread of its own, with nothing in it',
	await p.evaluate(() => {
		const out = document.getElementById('chat-output');
		return !!out && !out.querySelector('.chat-msg');
	}));
const away = await resting(p);
check('a fresh chat shows no indicator of its own while another chat works',
	!away.spinner);
// The other half of the same state: the button is the composer's word for "this
// chat is working", and a fresh chat must not inherit that either.
check('nor does it inherit the other chat\'s Stop button', away.send);

// Back to the one that is still going, through its own label, the way a person
// opens a chat.
await openChat(p, working);
const back = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const el  = out ? out.querySelector('.chat-spinner') : null;
	const b   = document.getElementById('chat-send');
	const say = el ? el.querySelector('.chat-spinner-say') : null;
	return {
		busy: !!b && b.classList.contains('stop'),
		up:   !!el,
		say:  say ? (say.textContent || '').trim() : '',
	};
});
// `busy` is the app's own word for "this chat is still working", so the check is
// conditional on it rather than on the clock: a stream that happened to finish
// during the switch is not a failure, and asserting on a timing race would be.
check('the chat left running is still running when we come back to it',
	back.busy, back.busy ? '' : '(it finished during the switch — nothing was proved here)');
check('coming back to a chat that is still working finds its indicator again',
	!back.busy || back.up, back.busy ? 'indicator ' + (back.up ? 'up' : 'MISSING') : '');
check('and it is still saying what that turn is doing',
	!back.busy || !!back.say, back.say || '(nothing)');
await settle(p);

// ── A daimon's turn, and the thread it must not draw into ───────────
//
// The same rule one surface along, and the one where it bites hardest. A
// Diamond's daimon is an ordinary chat record drawn by the ordinary renderer
// into the one thread, so "am I the thing on screen?" is what keeps its turn
// off everybody else's transcript — and it was answered once, before the turn
// started, and then trusted for the length of it. Walk off the Diamond
// mid-turn and the answer went with you: the daimon kept streaming, and an
// ordinary chat that had long since finished its own work collected another
// conversation's words as they arrived.
//
// The dots were never the visible part of this. They are decided by
// `syncComposer` from whichever chat is current, so they were right the whole
// time — which is exactly why it needs a check of its own rather than being
// assumed to fall out of the indicator ones.

await p.click('#new-diamond-btn', { force: true });
await p.waitForSelector('.dlg-input', { timeout: 10000 });
await p.fill('.dlg-input', 'Waiting');
await p.click('.dlg-ok', { force: true });
await p.waitForTimeout(900);
const dia = await p.evaluate(() => {
	const a = document.querySelector('#diamond-list .diamond-box.active')
		|| document.querySelector('#diamond-list .diamond-box');
	return a ? a.dataset.id : '';
});
check('the Diamond about to be left is identifiable in the rail', !!dia, dia);

await steerDiamond(s, '@long 200');
await p.waitForTimeout(1200);
check('the daimon turn is watched over on the Diamond it belongs to',
	await p.evaluate(() => !!document.querySelector('#chat-output .chat-spinner')));

// Walk off onto the ordinary chat made earlier, which has nothing of its own to
// say and no turn of its own running.
await openChat(p, fresh);
const quietBefore = await threadText(p);
await p.waitForTimeout(2500);
const quietAfter = await threadText(p);

// Back to the Diamond, both to stop the turn and to establish that there WAS
// one running for all of that — the same conditional idiom as the switch above,
// because a daimon that finished early would make the quiet meaningless.
await p.evaluate((id) => {
	const box = document.querySelector('#diamond-list .diamond-box[data-id="' + id + '"]');
	if (box) box.click();
}, dia);
await p.waitForTimeout(800);
const face = await p.$('#dview-chat');
if (face) { await face.click({ force: true }); await p.waitForTimeout(400); }
const daimonBusy = await p.evaluate(() => {
	const b = document.getElementById('chat-send');
	return !!b && b.classList.contains('stop');
});
check('the daimon turn was still running for the whole of that absence',
	daimonBusy, daimonBusy ? '' : '(it finished while we were away — nothing was proved here)');
check('a daimon turn writes nothing into the chat you walked away to',
	!daimonBusy || quietAfter === quietBefore,
	quietAfter === quietBefore ? '' : 'the thread gained: '
		+ JSON.stringify(quietAfter.slice(quietBefore.length, quietBefore.length + 60)));

if (daimonBusy) await p.evaluate(() => document.getElementById('chat-send').click());   // Stop
await settle(p);
check('and stopping it leaves no indicator on the Diamond either',
	(await resting(p)).spinner === false);
await openChat(p, working);              // back to a chat, for the reload below

// ── Exit: the page reloads in the middle ────────────────────────────

await send(p, '@long 200');
await p.waitForTimeout(1200);
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'waiting');
await p.waitForTimeout(1200);
const afterReload = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const b   = document.getElementById('chat-send');
	return {
		spinner: !!(out && out.querySelector('.chat-spinner')),
		stop:    !!b && b.classList.contains('stop'),
	};
});
check('a reload in the middle of a turn does not come back to a stuck indicator',
	!afterReload.spinner && !afterReload.stop);

// ── Nothing anywhere is left claiming to run ────────────────────────

const anyLeft = await p.evaluate(() =>
	!!document.querySelector('.chat-spinner, .crystal-spinner'));
check('with every turn finished, no indicator is left anywhere on the page',
	!anyLeft);

await shot(s, 'waiting-rest');

const errs = errors(s).filter(e => !/favicon|404|401|402|403|500|502|Bad Gateway|net::ERR|mock: as requested/.test(e));
check('and none of it throws', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
