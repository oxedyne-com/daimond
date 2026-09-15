// verify_silentround.mjs — a round that REASONS and says nothing never ends a
// turn as a plain success.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// Proposal 15, 2026-09-15. Driving Daimond's own daimon as a naive user, turn
// `cmszd1052-1-qya52` (glm-5.3 through OpenRouter) came back with 3,372 tokens
// on the REASONING channel and nothing on content, no tool call, ending
// mid-sentence: "One more thing:" and then nothing. 318 s wall, US$0.10, no
// work. The engine read the empty content as a plain empty answer and ended the
// turn `TurnEnd::Silent` -- and the page drew no ending line at all, because a
// thinking tile counted as "something was shown" (`appendEnding`,
// www/js/daimond.js). The spinner simply stopped.
//
// ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
//
//   1. A ROUND THAT REASONS AND SAYS NOTHING IS NUDGED ONCE, on the wire --
//      read off the mock's own request log, not inferred from the page.
//   2. ONE NUDGE IS SURVIVABLE: nudged, then an ordinary answer, `reasoned: 1`.
//   3. TWO IN A ROW ENDS THE TURN UNDER ITS OWN WORD: `reasoned_only`, never
//      `silent` and never `answered`. This is the defect itself.
//   4. THE COUNT SAYS HOW MANY ROUNDS WENT, and that no tool ran.
//   5. THE PAGE DRAWS THE ENDING. A thinking tile alone must not satisfy
//      `appendEnding`'s "something was shown" and swallow the line.
//   6. THE DEBUG FEED IS TOLD THE HONEST WORD -- `reasoned_only`, not `done` --
//      via `endedHow` (intercepted at `DEBUG_SHARE.event`, so this is the exact
//      call the app makes and not a page-side guess).
//   7. A PROVIDER LENGTH CUT REACHES THE FEED (`dsEvent('truncated', …)`),
//      which was previously a local flag nobody outside the tab could see.
//   8. NOTHING THREW. A world with no gateway refuses `/api`, which is this
//      world's configuration and not the app breaking.
//
//   node dev/verify_silentround.mjs
//   node dev/verify_silentround.mjs --break silentisdone   # endedHow forgets the new words
//   node dev/verify_silentround.mjs --break thinkingshown  # a thinking tile counts as shown again
//   node dev/verify_silentround.mjs --break notruncated    # dsEvent('truncated', …) removed
//
// A `--break` run EXPECTS to fail: exit 0 when something reddened, 1 when
// nothing did. `--break nonudge` is NOT offered: the nudge itself is engine
// logic compiled into the wasm binary, which this suite's `--break` mechanism
// (serving a damaged .js file over the wire) cannot reach at all -- check 1
// below is a plain positive assertion instead, and a version of the wasm
// built without the fix already fails it on its own, with nothing to break.
//
// Needs dev/serve.mjs and dev/mockllm.mjs (a world: `bash dev/world.sh N --up`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const LOG  = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The breaks ───────────────────────────────────────────────────────────────
const BREAK  = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	// `endedHow` forgets the two new words: `silent`/`reasoned_only` fall back
	// into the same `default: return 'done'` every ordinary turn takes.
	silentisdone: [{
		file: 'js/daimond.js',
		find: "			case 'silent':        return 'silent';\n"
			+ "			case 'reasoned_only': return 'reasoned_only';\n",
		with: "			// --break silentisdone: both arms removed\n",
	}],
	// `appendEnding` goes back to counting a thinking-only tile as "shown",
	// which is the bug itself: the line never draws.
	thinkingshown: [{
		file: 'js/daimond.js',
		find: "			if (k.classList.contains('chat-msg-user')) continue;\n"
			+ "			// A lone thinking tile carries `chat-msg-thinking`; a RUN of them is\n"
			+ "			// wrapped in a `.crollup` container instead (`makeRollup`, above), whose\n"
			+ "			// own class list never gets that marker -- only `dataset.t === 'think'`\n"
			+ "			// says what it holds. Both must be skipped, or a second reasoning-only\n"
			+ "			// round (which rolls the first tile up rather than standing it alone)\n"
			+ "			// slips back into \"something was shown\" the moment there are two.\n"
			+ "			if (k.classList.contains('chat-msg-thinking') || k.dataset.t === 'think') continue;\n"
			+ "			shown = true;\n"
			+ "			break;",
		with: "			if (!k.classList.contains('chat-msg-user')) { shown = true; break; }   // --break thinkingshown",
	}],
	// The `truncated` event no longer reaches the feed.
	notruncated: [{
		file: 'js/daimond.js',
		find: "				dsEvent('truncated', { turn: String(umid), r: step });",
		with: "				/* --break notruncated */",
	}],
};

function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.get(spec.file) || fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		if (!src.includes(spec.find)) {
			console.error(`--break ${BREAK}: anchor not found in ${spec.file}. The break is stale.`);
			process.exit(1);
		}
		byFile.set(spec.file, src.replace(spec.find, spec.with));
	}
	return byFile;
}

async function serveBreaks(page) {
	if (!BREAK) return;
	if (BREAK !== 'silentisdone' && BREAK !== 'thinkingshown' && BREAK !== 'notruncated') {
		console.error(`verify_silentround: no such break '${BREAK}'. `
			+ `Known: silentisdone, thinkingshown, notruncated.`);
		process.exit(1);
	}
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

/// Every request the mock has been handed since `mark`, as parsed bodies.
///
/// READ OFF THE MOCK, not off the page: whether the nudge reached the model is
/// a fact about what went on the wire.
function requestsSince(mark) {
	let lines = [];
	try { lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); }
	catch (e) { return []; }
	return lines.slice(mark).map(l => { try { return JSON.parse(l); } catch (e) { return null; } })
		.filter(Boolean);
}

function logLines() {
	try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length; }
	catch (e) { return 0; }
}

const s = await open({ name: 'silentround', route: serveBreaks });
const p = s.page;

// THE DEBUG FEED, INTERCEPTED AT ITS ONE SEAM. `dsEvent` (www/js/daimond.js)
// always calls `DEBUG_SHARE.event(kind, payload)` whether or not sharing is
// switched on -- the internal `enabled` gate lives inside `event` itself -- so
// wrapping it here after the page has loaded records every call the app makes,
// independent of the Settings toggle. Wrapped rather than replaced: the real
// function still runs, so this changes nothing about what the app does.
await p.evaluate(() => {
	window.__ds = [];
	if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
		const orig = DEBUG_SHARE.event;
		DEBUG_SHARE.event = function (kind, payload) {
			try { window.__ds.push([kind, payload]); } catch (e) { /* never block the app */ }
			return orig.apply(this, arguments);
		};
	}
});
const dsEvents = (kind) => p.evaluate((k) =>
	(window.__ds || []).filter(e => e[0] === k).map(e => e[1]), kind);

/// Send one message and wait for the turn to stop.
async function say(text, timeout = 45000) {
	await p.fill('#chat-input', text);
	await p.click('#chat-send', { force: true });
	await p.waitForTimeout(300);
	const until = Date.now() + timeout;
	while (Date.now() < until) {
		const busy = await p.evaluate(() => {
			const b = document.getElementById('chat-send');
			if (!b) return false;
			const t = (b.getAttribute('title') || '') + (b.className || '');
			return /stop/i.test(t) || b.disabled;
		});
		if (!busy) break;
		await sleep(200);
	}
	await sleep(600);
}

/// How the engine says the last turn ended, in its own word -- read off the
/// app's own state, not off the debug feed (which is intercepted separately
/// so the two never validate each other in a circle).
const lastTurn = () => p.evaluate(() =>
	(window.DaimondCore && DaimondCore.lastTurn && DaimondCore.lastTurn()) || null);

/// The ending line drawn under the turn, if any.
const endingLine = () => p.evaluate(() => {
	const els = [...document.querySelectorAll('.chat-msg-ended .end-line')];
	return els.map(e => e.textContent || '');
});

/// Everything the thread shows, as text.
const shown = () => p.evaluate(() => {
	const out = document.getElementById('chat-output');
	return out ? (out.innerText || '') : '';
});

try {
	// ── 1-2. ONE ROUND, NUDGED, THEN AN ORDINARY ANSWER ─────────────────────
	await newChat(s);
	const mark1 = logLines();
	await say('@reasononce One more thing: ;; Here is the answer.');

	const reqs1 = requestsSince(mark1);
	const nudged1 = reqs1.filter(r => (r.messages || []).some(m =>
		m && m.role === 'user' && /neither answered nor called a tool/.test(String(m.content || ''))));
	check('1a the nudge went ON THE WIRE, not just into the transcript',
		nudged1.length >= 1, `${reqs1.length} request(s), ${nudged1.length} carrying a nudge`);
	check('1b the round ran again exactly once, so this costs one round and not a loop',
		reqs1.length === 2, `${reqs1.length} request(s)`);

	const t1 = await lastTurn();
	check('2a one reasoning-only round is nudged past and the turn ANSWERS',
		!!t1 && t1.how === 'answered', JSON.stringify(t1));
	check('2b and the round it cost is still counted',
		!!t1 && (t1.reasoned | 0) === 1, JSON.stringify(t1));
	await shot(s, 'silentround-1-nudged' + (BREAK ? '-' + BREAK : ''));

	// ── 3-4. TWO IN A ROW ENDS THE TURN UNDER ITS OWN WORD ───────────────────
	await newChat(s);
	const mark2 = logLines();
	await say('@reasononly One more thing: ;; Still nothing to say.');

	const t2 = await lastTurn();
	check('3a THE DEFECT: a round that reasons twice and answers nothing does NOT '
		+ 'end as an ordinary success',
		!!t2 && t2.how !== 'done' && t2.how !== 'answered' && t2.how !== 'silent', JSON.stringify(t2));
	check('3b it ends under its own word, `reasoned_only`',
		!!t2 && t2.how === 'reasoned_only', JSON.stringify(t2));
	check('4a the count says how many rounds went',
		!!t2 && (t2.reasoned | 0) === 2, JSON.stringify(t2));
	check('4b and no tool ran, which is what the turn was for',
		!!t2 && (t2.calls | 0) === 0, JSON.stringify(t2));

	const reqs2 = requestsSince(mark2);
	check('4c one nudge only: bounded to a single retry, not a loop',
		reqs2.length === 2, `${reqs2.length} request(s)`);

	// ── 5. THE PAGE DRAWS THE ENDING ─────────────────────────────────────────
	const lines = await endingLine();
	check('5a a thinking tile alone does not satisfy "something was shown" — '
		+ 'the ending line draws',
		lines.some(l => /answer/i.test(l) || /reason/i.test(l)), JSON.stringify(lines));
	const text = await shown();
	check('5b and it reads as English, not a raw engine word left untranslated',
		!text.includes('end.how_'), text.slice(-200));
	await shot(s, 'silentround-2-reasoned-only' + (BREAK ? '-' + BREAK : ''));

	// ── 6. THE DEBUG FEED IS TOLD THE HONEST WORD ────────────────────────────
	const ended = await dsEvents('ended');
	const lastEnded = ended[ended.length - 1];
	check('6a the feed is told `reasoned_only`, never collapsed into `done`',
		!!lastEnded && lastEnded.how === 'reasoned_only', JSON.stringify(lastEnded));

	// ── 7. A LENGTH CUT REACHES THE FEED ──────────────────────────────────────
	//
	// `@cutreason` is an ordinary text reply whose finish reason is the
	// provider's own word for a cut, `"length"` rather than `"stop"` -- so this
	// exercises `AgentEvent::Truncated` for real, through the actual wire the
	// engine reads, rather than asserting on the source.
	await newChat(s);
	await say('@cutreason This reply was cut at the output limit before it finished.');
	const truncated = await dsEvents('truncated');
	check('7a a provider length cut reaches the feed via dsEvent(\'truncated\', …), '
		+ 'not just a local flag nobody outside the tab could see',
		truncated.length >= 1, `${truncated.length} truncated event(s)`);

	// ── 8. Nothing threw ─────────────────────────────────────────────────────
	const errs = errors(s).filter(e => !(/\/api\//.test(e) && /50\d/.test(e)));
	check('8a the app raised no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
	check('the run got to the end of itself', false,
		String(e && e.message ? e.message : e).split('\n')[0]);
	try { await shot(s, 'silentround-threw' + (BREAK ? '-' + BREAK : '')); } catch (e2) { /* no picture */ }
} finally {
	await s.close();
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0
	? `\nsilentround: all ${ok.length} checks passed`
	: `\nsilentround: ${bad.length} of ${ok.length + bad.length} checks FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
