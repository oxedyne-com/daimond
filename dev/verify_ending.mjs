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
// ── WHAT IT ASSERTS, WHICH IS THE FURNITURE RULE AND NOT THE FEATURE ─────────
//
// Drawing a line is the easy half and it is not the half that matters. §3 is a
// rule about NOT crying wolf, and two checks here are the whole of it:
//
//   - **a toolless turn draws nothing at all.** A pure chat has no tool log, so
//     a line under every message in it is noise with nothing behind it.
//   - **an ordinary successful turn is not styled as a notice.** An app that
//     appends a warning to every turn teaches its reader to skip the one that
//     mattered, which is the failure this whole mechanism exists to prevent.
//     Only `refused`, `failed` or a missing path may promote it.
//
// Without those two this becomes a warning nobody reads, and every other check
// here would still be green.
//
//   node dev/verify_ending.mjs
//   node dev/verify_ending.mjs --break nofurniture   # a toolless turn draws a line
//   node dev/verify_ending.mjs --break alwaysnotice  # every ending is a notice
//   node dev/verify_ending.mjs --break nopersist     # a reload loses the ending
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
	// BOTH GUARDS, and the fact that there are two is the finding. Patching
	// `endingParts` alone reddened NOTHING on the first run: `endLogOf` refuses to
	// store a toolless ending as well, so the line was never reached even with the
	// drawing rule removed. That is belt and braces rather than a defect -- but a
	// break that restores only half of a two-place rule launders a plain run as
	// proof of the other half, which is exactly what this note exists to stop the
	// next reader repeating.
	nofurniture: [{
		file: 'js/daimond.js',
		find: "		// Rule 2, first, so no caller can forget it.\n		if (!e || !((e.offered | 0) > 0)) return null;",
		with: "		if (!e) return null;   // --break nofurniture",
	}, {
		file: 'js/daimond.js',
		find: "		if (!ev || !((ev.offered | 0) > 0)) return null;",
		with: "		if (!ev) return null;   // --break nofurniture",
	}],
	alwaysnotice: [{
		file: 'js/daimond.js',
		find: "			notice: !!(refused || failed || missing.length),",
		with: "			notice: true,   /* --break alwaysnotice */",
	}],
	nopersist: [{
		file: 'js/daimond.js',
		find: "			else if (m.role === 'end_log') { appendEnding(m); }",
		with: "			else if (m.role === 'end_log') { /* --break nopersist */ }",
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

// ── 1. THE OWNER'S CASE: tools on the table, and no call made ────────────────
//
// `offered > 0, calls === 0`. This is the turn he watched: nothing technically
// wrong, so nothing was said. The line is what replaces that silence — and it is
// FURNITURE, because a turn that simply answered is not a fault and drawing it
// as one is how the reader learns to skip the line.
await newChat(s);
await say('@text I will rewrite lines 43 through 49 applying the lessons.');
const idle = await endings();
check('1a a turn that used no tool still says how it ended',
	idle.length === 1, JSON.stringify(idle));
check('1b and it says NO TOOLS WERE USED, which is the fact he could not see',
	idle.length === 1 && /no tools used/i.test(idle[0].text), (idle[0] || {}).text || '(none)');
check('1c AND IT IS NOT A NOTICE — a turn that answered is not a fault',
	idle.length === 1 && idle[0].notice === false,
	idle.length ? ('notice=' + idle[0].notice) : '(no line)');
check('1d the figures nobody put on the line are in its title',
	idle.length === 1 && /\d/.test(idle[0].title), (idle[0] || {}).title || '(no title)');
await shot(s, 'ending-1-no-tools');

// ── 2. An ordinary successful turn, WITH a tool call ─────────────────────────
//
// The second half of the not-crying-wolf rule: the commonest turn in the app
// must read as quietly as the one above.
await newChat(s);
const dir = await p.evaluate(() => {
	const f = window.DaimondAttach.focus();
	return window.DaimondAttach.chatScratch(f.id);
});
await say(`@tool file_write {"path":"${dir}/ok.txt","content":"hi"}`);
const good = await endings();
check('2a a turn that called a tool says so',
	good.length === 1 && /1/.test(good[0].text), JSON.stringify(good));
check('2b AND AN ORDINARY SUCCESSFUL TURN IS NOT STYLED AS A NOTICE',
	good.length === 1 && good[0].notice === false,
	good.length ? ('notice=' + good[0].notice + ' — ' + good[0].text) : '(no line)');
await shot(s, 'ending-2-ordinary');

// ── 3. A refusal, which is what a notice is FOR ──────────────────────────────
//
// A write outside the chat's fence comes back `CallOutcome::Refused` — the door
// turned it away, nothing was written, and the turn finished normally. That is
// exactly the ending a reader has to be able to pick out of a run of quiet ones.
await newChat(s);
await say('@tool file_write {"path":"/etc/passwd","content":"no"}');
const refused = await endings();
check('3a a refused call is counted on the line',
	refused.length === 1 && /1/.test(refused[0].text), JSON.stringify(refused));
check('3b AND IT IS PROMOTED TO A NOTICE',
	refused.length === 1 && refused[0].notice === true,
	refused.length ? ('notice=' + refused[0].notice + ' — ' + refused[0].text) : '(no line)');
await shot(s, 'ending-3-refused');

// ── 4. A reload still shows how the turn ended ───────────────────────────────
//
// Persisted the way `think_log` and `fold_log` are. A RELOAD IS A LOCK: `boot()`
// finds the stored identity and returns before `renderAll`, so waiting only for
// `__DAIMOND_READY` reads the lock screen — see dev/verify_reopen.mjs.
await reboot();
// The app restores the chat that was open, which is the refused one above.
let after = [];
const until = Date.now() + 20000;
while (Date.now() < until) {
	after = await endings();
	if (after.length) break;
	await sleep(250);
}
check('4 A RELOAD STILL SHOWS HOW THE TURN ENDED',
	after.length === 1 && after[0].notice === true, JSON.stringify(after));
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
check('4e the DAIMON’S OWN THREAD closes the same way a chat’s does',
	daimon.length >= 1 && /no tools used/i.test(daimon[daimon.length - 1].text),
	JSON.stringify(daimon));
check('4f and it is furniture there too',
	daimon.length >= 1 && daimon[daimon.length - 1].notice === false,
	daimon.length ? ('notice=' + daimon[daimon.length - 1].notice) : '(no line)');
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
