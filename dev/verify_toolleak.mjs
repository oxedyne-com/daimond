// verify_toolleak.mjs — a tool call that arrives as PROSE never ends a turn as an answer.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// Turn 56, 2026-09-14 06:24, argonaut, glm-5.3 through OpenRouter, build
// 1f8ca7ce44f0. The daimon was asked to run `verify {"name":"daimonfold",
// "world":true}` and report its `[hand:` and `[world:` lines. It planned the call
// correctly; then its one round came back carrying the model's NATIVE call syntax
// as CONTENT —
//
//     name</arg_key><arg_value>daimonfold</arg_value><arg_key>timeout_ms</arg_key>…
//
// — with the head `<tool_call>verify<arg_key>` consumed upstream and no JSON
// `tool_calls` at all. The engine read a reply with no calls in it and ended the
// turn **answered** in 39 seconds (`end_log how:"answered", calls:0`), and the
// page drew `namedaimonfoldtimeout_ms600000worldtrue` as the model's reply —
// `scrub()` in www/js/render.js keeps an unknown tag's TEXT and drops its markup.
// No tool ran, no hand was launched, nothing was recorded, US$0.16 for 114k
// prompt tokens, and ZERO warnings anywhere. A wire fault had ended a turn as a
// success, which is the one ending this app may not report wrongly.
//
// ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
//
//   1. TWO LEAKS IN A ROW END THE TURN UNDER ITS OWN WORD. Not `answered`:
//      `malformed`, with `end_log.malformed === 2`. This is the defect itself.
//   2. THE CONSOLE WARNS. The live turn raised nothing anywhere, so the one
//      reader who could have caught it had nothing to catch.
//   3. THE FRAGMENT IS SHOWN AS CODE. A `<pre>` holding the markup with its angle
//      brackets intact, and the run-together prose form nowhere on screen.
//   4. THE NUDGE WAS SENT, once, and the round ran again — read off the mock's own
//      request log, not inferred from the page.
//   5. ONE LEAK IS SURVIVABLE. `@leakonce`: nudged, answered, `malformed === 1`.
//   6. A WHOLE CALL IS RECOVERED AND RUN. `@leakwhole`: a tool round, and
//      `malformed === 0` — a recovered leak costs nothing and is still reported.
//
//   node dev/verify_toolleak.mjs
//   node dev/verify_toolleak.mjs --break asprose   # the leaked reply drawn as an answer again
//   node dev/verify_toolleak.mjs --break quiet     # the warning removed
//   node dev/verify_toolleak.mjs --break theday    # the whole build of 2026-09-14
//
// A `--break` run EXPECTS to fail: exit 0 when something reddened, 1 when nothing
// did, because a break that changes nothing is itself a failing run.
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

// The wire, verbatim. The same bytes src/llm.rs's tests and dev/mockllm.mjs hold.
const TAGS   = ['</arg_key>', '<arg_value>', '</tool_call>'];
// What the owner was shown instead: every tag gone, the words run together.
const AS_PROSE = 'namedaimonfoldtimeout_ms600000worldtrue';

// ── The breaks ───────────────────────────────────────────────────────────────
//
// `asprose` drops the redraw, so the leaked markup finalises as an assistant tile
// exactly as it did on the day — the `<pre>` checks go red and the run-together
// check goes red with them. `quiet` removes the console line and nothing else.
const BREAK  = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	asprose: [{
		file: 'js/daimond.js',
		find: '					dropAssistant();',
		with: '					if (false) dropAssistant();   // --break asprose',
	}, {
		file: 'js/daimond.js',
		find: '					appendLeak(String(ev.fragment || \'\'));',
		with: '					if (false) appendLeak(String(ev.fragment || \'\'));   // --break asprose',
	}],
	// THE BUILD OF THE DAY, both halves of it: the page draws the leaked reply as an
	// answer AND the sanitiser strips the tags out of it. This is the only break that
	// can redden 3c, because either fix alone already keeps the markup on screen.
	theday: [{
		file: 'js/daimond.js',
		find: '\t\t\t\t\tdropAssistant();',
		with: '\t\t\t\t\tif (false) dropAssistant();   // --break theday',
	}, {
		file: 'js/daimond.js',
		find: "\t\t\t\t\tappendLeak(String(ev.fragment || ''));",
		with: "\t\t\t\t\tif (false) appendLeak(String(ev.fragment || ''));   // --break theday",
	}, {
		file: 'js/render.js',
		find: '\t\t\t\tif (LEAK_TAG[tag]) {',
		with: '\t\t\t\tif (false) {   // --break theday',
	}],
	quiet: [{
		file: 'js/daimond.js',
		find: "					console.warn('daimond: a tool call arrived as text rather than as a tool call'",
		with: "					String('--break quiet') && String(",
	}],
};

function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		// From what is ALREADY DAMAGED where a break edits one file twice, or the
		// second edit would drop the first and a two-place rule would be half
		// restored -- silently, since both anchors are found either way.
		const src = byFile.get(spec.file) || fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		if (!src.includes(spec.find)) {
			// A break whose anchor is not there patches nothing and launders a plain
			// run as proof. Loud, and fatal.
			console.error(`--break ${BREAK}: anchor not found in ${spec.file}. The break is stale.`);
			process.exit(1);
		}
		byFile.set(spec.file, src.replace(spec.find, spec.with));
	}
	return byFile;
}

async function serveBreaks(page) {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

/// Every request the mock has been handed since `mark`, as parsed bodies.
///
/// READ OFF THE MOCK, not off the page. Whether the nudge reached the model is a
/// fact about what went on the wire, and the page cannot answer it: a transcript
/// showing a nudge proves the app wrote one, not that it sent one.
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

const s = await open({ name: 'toolleak', route: serveBreaks });
const p = s.page;

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

/// How the engine says the last turn ended, in its own word.
const lastTurn = () => p.evaluate(() =>
	(window.DaimondCore && DaimondCore.lastTurn && DaimondCore.lastTurn()) || null);

/// The leak tiles on screen: the `<pre>` bodies, as typed.
const leakPres = () => p.evaluate(() =>
	[...document.querySelectorAll('#chat-output pre.leak-frag')].map(e => e.textContent || ''));

/// Everything the thread shows, as text.
const shown = () => p.evaluate(() => {
	const out = document.getElementById('chat-output');
	return out ? (out.innerText || '') : '';
});

/// The console warnings this run has raised.
const warnings = () => (s.logs || []).filter(l => /^warning:/.test(l));

try {
	// ── 1-4. TWO LEAKS IN A ROW ──────────────────────────────────────────────
	await newChat(s);
	const mark = logLines();
	await say('@leak');

	const t1 = await lastTurn();
	check('1a THE DEFECT: two leaked calls do NOT end the turn as an answer',
		!!t1 && t1.how !== 'done' && t1.how !== 'answered', JSON.stringify(t1));
	check('1b it ends under its own word, and the count says how many rounds went',
		!!t1 && t1.how === 'malformed' && (t1.malformed | 0) === 2, JSON.stringify(t1));
	check('1c and no tool ran, which is what the turn was for',
		!!t1 && (t1.calls | 0) === 0, JSON.stringify(t1));

	const warned = warnings().filter(l => /arrived as text/.test(l));
	check('2a THE CONSOLE WARNS — the live turn raised nothing at all',
		warned.length >= 1, `${warnings().length} warning(s) in total`);

	const pres = await leakPres();
	check('3a the fragment is drawn in a <pre>', pres.length >= 1, `${pres.length} block(s)`);
	check('3b with its markup intact, which is the evidence',
		pres.length >= 1 && TAGS.every(tag => pres[0].includes(tag)),
		JSON.stringify(pres[0] || '').slice(0, 160));
	const text = await shown();
	check('3c and NEVER as the run-together prose the owner was shown',
		text.indexOf(AS_PROSE) === -1);

	const reqs = requestsSince(mark);
	const nudged = reqs.filter(r => (r.messages || []).some(m =>
		m && m.role === 'user' && /arrived as text/.test(String(m.content || ''))));
	check('4a the nudge went ON THE WIRE, not just into the transcript',
		nudged.length >= 1, `${reqs.length} request(s), ${nudged.length} carrying a nudge`);
	check('4b the round ran again exactly once, so a leak costs one round and not a loop',
		reqs.length === 2, `${reqs.length} request(s)`);
	check('4c and the nudge carries the family’s own hint',
		nudged.length >= 1 && (nudged[0].messages || []).some(m =>
			/arg_key/.test(String(m.content || ''))));
	await shot(s, 'toolleak-1-malformed' + (BREAK ? '-' + BREAK : ''));

	// ── 5. ONE LEAK IS SURVIVABLE ────────────────────────────────────────────
	//
	// The nudge exists to rescue the turn, not to end it. A model that leaks once
	// and then emits properly answers, and the leak is still counted and still
	// drawn — the user is entitled to know a round was spent on nothing.
	await newChat(s);
	await say('@leakonce');
	const t2 = await lastTurn();
	check('5a one leak is nudged past and the turn ANSWERS',
		!!t2 && t2.how === 'answered', JSON.stringify(t2));
	check('5b and the round it cost is still counted',
		!!t2 && (t2.malformed | 0) === 1, JSON.stringify(t2));
	const pres2 = await leakPres();
	check('5c the fragment is still shown as code, on a turn that ended well',
		pres2.length >= 1, `${pres2.length} block(s)`);
	await shot(s, 'toolleak-2-nudged' + (BREAK ? '-' + BREAK : ''));

	// ── 6. A WHOLE CALL IS RECOVERED ─────────────────────────────────────────
	//
	// With its `<tool_call>NAME` head still on it there is a call in the bytes, so
	// the engine rebuilds it and the round proceeds. Reported anyway: a provider
	// getting the wire wrong is worth measuring whether or not this app can paper
	// over it.
	await newChat(s);
	await say('@leakwhole');
	const t3 = await lastTurn();
	check('6a a whole leaked call is recovered and the turn runs a tool',
		!!t3 && (t3.calls | 0) >= 1, JSON.stringify(t3));
	check('6b it cost no round, so nothing is counted against the turn',
		!!t3 && (t3.malformed | 0) === 0, JSON.stringify(t3));
	check('6c and it is STILL reported, so a fault that fixes itself is still measurable',
		warnings().filter(l => /recovered and run/.test(l)).length >= 1);
	await shot(s, 'toolleak-3-recovered' + (BREAK ? '-' + BREAK : ''));

	// ── 7. Nothing threw ─────────────────────────────────────────────────────
	// A world with no gateway refuses `/api`, which is this world's configuration and
	// not the app throwing. `dev/world.sh 39 --up` says so on the way up.
	const errs = errors(s).filter(e => !(/\/api\//.test(e) && /50\d/.test(e)));
	check('7a the app raised no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
	// A run that cannot get to the end of itself IS a failure, and one that says
	// so in the same voice as the rest.
	check('the run got to the end of itself', false,
		String(e && e.message ? e.message : e).split('\n')[0]);
	try { await shot(s, 'toolleak-threw' + (BREAK ? '-' + BREAK : '')); } catch (e2) { /* no picture */ }
} finally {
	await s.close();
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0
	? `\ntoolleak: all ${ok.length} checks passed`
	: `\ntoolleak: ${bad.length} of ${ok.length + bad.length} checks FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
