// verify_ending.mjs — every turn says how it ended, and it reads as furniture.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// A model announced "let me rewrite from line 43 through 49 applying the
// lessons" and then ended its turn having written nothing. The spinner stopped,
// which was correct — the turn HAD ended — and the owner was left saying **"I
// have no visibility on what occurred here."** `AgentEvent::Ended` now closes
// every turn and `dev/CONTRACT_CLAIMS.md` §3 says how it is drawn.
//
// ── WHAT IT ASSERTS (owner review 2026-09-05: the SUMMARY is GONE) ───────────
//
// The furniture line "Answered · N tool calls" went on 2026-09-04. The trailing
// NOTICE — "1 refused", "1 failed", "Ended on an error" — was the remnant, and the
// owner asked for it gone too: a refused or failed tool already shows its state ON
// ITS OWN TOOL TILE (`.ctile[data-t="tool"].refused` / `.failed`, named "· refused"
// / "· failed"), and the absence of the spinner says the turn is over, so a line
// under the whole turn restating the tally is noise. So a turn that produced a tile
// of its own — the ordinary case — draws NOTHING now, whatever happened in it. The
// one line that survives is for a HARD ERROR WITH NOTHING TO SHOW: a turn that drew
// no tile at all, where the failure would otherwise be invisible.
//
// The checks are:
//
//   - **a clean turn draws nothing** — tool or not (unchanged from 2026-09-04).
//   - **a REFUSED turn draws no trailing line either** — and the refusal is on the
//     tool tile, which is where a reader picks it out now.
//   - **a reload keeps that** — no line, tool-tile refusal intact.
//
//   node dev/verify_ending.mjs
//   node dev/verify_ending.mjs --break showsall    # every turn draws a summary line again
//
// A `--break` run EXPECTS to fail: exit 0 when something reddened, 1 when
// nothing did, because a break that changes nothing is itself a failing run.
//
// Needs dev/serve.mjs (:8777) and dev/mockllm.mjs (:9099).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, signInAs, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The breaks ───────────────────────────────────────────────────────────────
//
// Each is scoped to survive every check but the one it proves. `nofurniture`
// drops the `offered === 0` guard, which is the rule that keeps a pure chat
// clean; `alwaysnotice` promotes every ending, which is the app teaching its
// reader to skip the line; `nopersist` leaves the live drawing alone and stops
// the reload redrawing it, so only the durability check moves.
const BREAK  = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	// THE END-OF-TURN SUMMARY IS GONE (owner review 2026-09-05). `appendEnding`
	// draws nothing when the turn produced a tile of its own — a refused or failed
	// tool shows its state on ITS OWN tile, so a line under the whole turn is
	// furniture. `showsall` removes that gate, so every offered>0 turn draws a
	// trailing line again, which reddens the "draws nothing" checks — the whole of
	// the change.
	showsall: [{
		file: 'js/daimond.js',
		find: "		if (shown || !bad) return;",
		with: "		if (false) return;   // --break showsall",
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

const s = await open({ name: 'ending', route: serveBreaks });
const p = s.page;

/// Every ending line in the chat on screen, with whether it is a notice.
const endings = () => p.evaluate(() =>
	[...document.querySelectorAll('#chat-output .chat-msg-ended')].map(e => ({
		text:   (e.textContent || '').trim(),
		notice: e.classList.contains('ended-notice'),
		title:  e.getAttribute('title') || '',
	})));

/// Come back from a reload, past the gate.
///
/// A RELOAD IS A LOCK — `boot()` finds the stored identity and returns before
/// `renderAll`, so waiting only for `__DAIMOND_READY` reads the lock screen (see
/// dev/verify_reopen.mjs). AND THE LOCK LANDS AFTER THAT FLAG: a single read of
/// `body.locked` straight after it can be taken in the gap before the gate is up,
/// which skips the sign-in and then waits thirty seconds on a modal nobody
/// answered. So the gate is waited FOR, briefly, and only then answered.
///
/// Nothing here throws: a deadline that expires leaves the checks below to report
/// what they see, because a race that takes the process with it is a run with no
/// check attributed to it.
async function reboot() {
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForFunction(() => window.__DAIMOND_READY === true, null, { timeout: 30000 })
		.catch(() => {});
	const gate = Date.now() + 10000;
	let locked = false;
	while (Date.now() < gate) {
		locked = await p.evaluate(() => document.body.classList.contains('locked'));
		if (locked) break;
		await sleep(200);
	}
	if (locked) await signInAs(s, 'ending').catch(() => {});
	await p.waitForFunction(() => !document.body.classList.contains('locked'), null,
		{ timeout: 30000 }).catch(() => {});
	await sleep(600);
}

/// Send one message and wait for the turn to stop.
///
/// NOT `harness.chat`, which opens a chat of its own when none is in focus. Each
/// case here owns its chat, so the send is the send and nothing else.
async function say(text, timeout = 40000) {
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
	await sleep(500);
}

// ── 1. A turn that offered tools and used none draws NOTHING (owner review) ───
//
// `offered > 0, calls === 0`. The old build drew "Answered · no tools used" here;
// the owner asked for the furniture gone, so a clean turn now leaves no line.
await newChat(s);
await say('@text I will rewrite lines 43 through 49 applying the lessons.');
const idle = await endings();
check('1a a clean turn that used no tool draws NO ending line',
	idle.length === 0, JSON.stringify(idle));
await shot(s, 'ending-1-no-tools');

// ── 2. An ordinary successful turn WITH a tool call also draws NOTHING ────────
//
// This is the exact line the owner pointed at — "Answered · 1 tool call" — and it
// is gone. The commonest turn in the app leaves no residue at all.
await newChat(s);
const dir = await p.evaluate(() => {
	const f = window.DaimondAttach.focus();
	return window.DaimondAttach.chatScratch(f.id);
});
await say(`@tool file_write {"path":"${dir}/ok.txt","content":"hi"}`);
const good = await endings();
check('2a a successful tool turn draws NO ending line',
	good.length === 0, JSON.stringify(good));
await shot(s, 'ending-2-ordinary');

// ── 3. A refusal shows on the TOOL TILE, not as a trailing summary ───────────
//
// A write outside the chat's fence comes back `CallOutcome::Refused` — the door
// turned it away, nothing was written, and the turn finished normally. The refusal
// is disclosed on the tool tile itself (amber, named "· refused"); the turn draws
// NO line under itself, because the tile has already said it.
const refusedTile = () => p.evaluate(() => {
	const t = document.querySelector('#chat-output .ctile[data-t="tool"].refused');
	return { present: !!t, meta: t ? ((t.querySelector('.ctile-meta') || {}).textContent || '') : '' };
});
await newChat(s);
await say('@tool file_write {"path":"/etc/passwd","content":"no"}');
const refused = await endings();
const rtile = await refusedTile();
check('3a a refused turn draws NO trailing summary line',
	refused.length === 0, JSON.stringify(refused));
check('3b and the refusal is shown on the tool tile instead',
	rtile.present === true && /refus/i.test(rtile.meta), JSON.stringify(rtile));
await shot(s, 'ending-3-refused');

// ── 4. A reload keeps that: no line, tool-tile refusal intact ────────────────
//
// The tool log is persisted with its outcome, so a reload redraws the refusal on
// the tile. A RELOAD IS A LOCK: `boot()` finds the stored identity and returns
// before `renderAll`, so waiting only for `__DAIMOND_READY` reads the lock screen
// — see dev/verify_reopen.mjs.
await reboot();
// The app restores the chat that was open, which is the refused one above. Wait
// for the tile to redraw rather than for a line that never comes.
let rafter = { present: false };
const until = Date.now() + 20000;
while (Date.now() < until) {
	rafter = await refusedTile();
	if (rafter.present) break;
	await sleep(250);
}
const after = await endings();
check('4a A RELOAD KEEPS THE TRAILING LINE ABSENT',
	after.length === 0, JSON.stringify(after));
check('4b and the tool tile still shows the refusal after reload',
	rafter.present === true, JSON.stringify(rafter));
await shot(s, 'ending-4-reloaded');

// ── 4b. The Diamond's own thread, which is the SECOND of three sinks ────────
//
// A daimon's conversation is durable and it is the surface this app is developed
// from, so a steer that quietly did nothing is exactly as invisible there as it
// was in a chat — and the reader is the same person. Same line, same rule.
await p.evaluate(() => document.querySelector('#diamond-list [data-id]').click());
await sleep(900);
await p.$('#dview-chat').then(el => el && el.click({ force: true }));
await sleep(400);
await say('@text I will rewrite lines 43 through 49.');
const daimon = await endings();
check('4e the DAIMON’S OWN THREAD closes the same way a chat’s does — a clean turn draws no line',
	daimon.length === 0, JSON.stringify(daimon));
await shot(s, 'ending-4b-daimon');

// ── 4c. A worker's tile, which is the THIRD sink and NOT a thread ───────────
//
// A worker has no transcript to close: `run.text` is what it SAID, gathered and
// handed back to the daimon that dispatched it, and the app's audit written into
// that would be delivered to another model as if the worker had written it. So
// the ending rides on the TILE, beside the vision note — the other fact the app
// states about a run in its own voice.
await newChat(s);
await p.evaluate(() => window.DaimondPanels.show('agents'));
await say('@tool spawn_agent {"name":"scribe","task":"@text I will fix it."}');
const untilRun = Date.now() + 45000;
let tiles = [];
while (Date.now() < untilRun) {
	tiles = await p.evaluate(() => [...document.querySelectorAll('#panel-agents .acard')].map(c => ({
		pill:   ((c.querySelector('.pill') || {}).textContent || ''),
		ended:  ((c.querySelector('.aended') || {}).textContent || ''),
		notice: !!c.querySelector('.aended.ended-notice'),
	})));
	if (tiles.length && tiles.every(t => ['done', 'error', 'stopped'].includes(t.pill))) break;
	await sleep(400);
}
check('4g A WORKER’S TILE SAYS HOW ITS TURN ENDED',
	tiles.length >= 1 && /no tools used/i.test(tiles[0].ended), JSON.stringify(tiles));
check('4h and a worker that simply answered is not badged as a notice either',
	tiles.length >= 1 && tiles[0].notice === false, JSON.stringify(tiles));
await shot(s, 'ending-4c-worker');

// ── 5. A TOOLLESS TURN DRAWS NOTHING AT ALL ─────────────────────────────────
//
// `offered === 0` is the pure-chat path, and the app reaches it for real: `cfg.tools`
// is read from the stored config (`loadCfg`) and handed to `DaimondApp`'s
// `enable_tools`. So the fixture is the product's own setting rather than an
// invented one, and what it produces is a genuine `Ended { offered: 0 }`.
await p.evaluate(() => {
	const raw = JSON.parse(localStorage.getItem('daimond-byok') || '{}');
	raw.tools = false;
	localStorage.setItem('daimond-byok', JSON.stringify(raw));
});
await reboot();
await newChat(s);
await say('@text a plain answer with no tools anywhere near it');
const quiet = await endings();
check('5a A TOOLLESS TURN DRAWS NOTHING AT ALL',
	quiet.length === 0, JSON.stringify(quiet));
// And the turn really happened, so 5a is not passing because nothing ran.
const said = await p.evaluate(() => (document.getElementById('chat-output') || {}).innerText || '');
check('5b …and the turn really ran, so 5a is not green for want of a turn',
	/plain answer|no tools anywhere/i.test(said) || said.trim().length > 0,
	said.slice(0, 80));
await shot(s, 'ending-5-toolless');

// ── The console ─────────────────────────────────────────────────────────────
const errs = errors(s).filter(e => !/502|Account service|429/.test(e));
check('6 drawing the ending raised nothing in the console', errs.length === 0,
	errs.slice(0, 2).join(' | '));

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length ? `--break ${BREAK}: reddened ${bad.length} check(s), as it must`
		: `--break ${BREAK}: CHANGED NOTHING — the check it names is not testing what it says`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
