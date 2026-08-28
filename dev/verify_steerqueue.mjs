// verify_steerqueue.mjs — a steer typed while the daimon is working is kept.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// `doSteer` opened with `if (crystalBusy || !currentDiamond) return;`. So a Send
// pressed while a turn was in flight did NOTHING: no queue, no message, no
// sentence saying why, and the text left sitting in the box. An ordinary chat in
// exactly that state queues what you typed and draws it (`enqueueMessage`), and
// a Diamond's own queue already existed — `drainSteerQueue` empties it at the end
// of every turn and `resumeSteerQueue` when you come back to the Diamond. This
// was the one door that never put anything into it.
//
// It is worse than it first reads, because `crystalBusy` is ONE FLAG FOR THE
// WHOLE APP. The turn in flight may belong to a different Diamond entirely, so a
// Send could do nothing on a Diamond that was not itself doing anything, with
// nothing on that screen to explain it.
//
// ── THE PROPERTY ─────────────────────────────────────────────────────────────
//
// Nothing the user types is lost. Not "the queue exists" — that it CARRIES what
// was typed, and that the box is cleared so the app has visibly taken it. The
// second half matters: a queue that kept the text in the box as well would leave
// the user unable to tell whether it had been taken, and pressing Send again is
// how you get it twice.
//
// A PRESET IS NOT QUEUED, and that is asserted too. A gather round, a trigger and
// the conductor all steer with a preset and each has its own way back; queueing
// one would deliver a stale report at an arbitrary later turn. So the fix must
// keep the old silent return for exactly that case, and a check that only proved
// "typed text is queued" would let a later simplification break it.
//
//   node dev/verify_steerqueue.mjs
//   node dev/verify_steerqueue.mjs --break swallow   # the old silent return
//
// A `--break` run EXPECTS to fail: exit 0 when something reddened, 1 when
// nothing did.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, steerDiamond, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BREAK  = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	// The defect, restored exactly: busy means do nothing at all.
	swallow: [{
		file: 'js/daimond.js',
		find: '\t\tif (diamondBusy(currentDiamond.id)) {',
		with: '\t\tif (diamondBusy(currentDiamond.id)) { return; } if (false) {',
	}],
	// THERE IS NO `queueall` BREAK, AND THAT IS A FINDING RATHER THAN A GAP.
	//
	// Check 3 asserts a preset is not queued, and no break makes it go red. Two
	// were tried. Deleting the preset guard changes nothing, because `!typed`
	// already turns every preset away — a preset call carries no box text.
	// Rewriting the enqueue as `typed || presetArg` changes nothing either, and
	// that one was measured: the door is reachable and the turn IS in flight when
	// it is taken (check 3a proves both), and the preset still never lands.
	//
	// So the honest reading is that the guard is defence in depth over a state
	// that cannot currently be constructed, and check 3 is a REGRESSION guard
	// rather than a proved one. It is kept, and it is labelled, because the state
	// becomes constructible the moment anything queues something other than what
	// the box holds. Writing a break that reddened it would have meant damaging
	// the check instead of the code, which is the shape this suite exists to
	// refuse.
};

function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
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
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

const s = await open({ name: 'steerqueue', route: serveBreaks });
const p = s.page;

// Open a Diamond and put it on the chat face, which is where the composer is.
const picked = await p.evaluate(() => {
	const el = document.querySelector('#diamond-list [data-id]');
	if (!el) return '';
	el.click();
	return el.dataset.id || '';
});
check('0 a Diamond is open', !!picked, picked);
await sleep(800);

// `@slow` holds the reply for two seconds, which is the turn-in-flight window
// this whole file needs. Racing a fast mock would make the check pass or fail on
// how loaded the machine is, which is not a property of the app.
await steerDiamond(s, '@slow 4000 first');
await sleep(700);

const busy = await p.evaluate(() => {
	const b = document.getElementById('chat-fold-btn');
	return { foldDisabled: !!(b && b.disabled) };
});
check('1 a turn really is in flight', busy.foldDisabled === true,
	'the Fold button answers `crystalBusy`, so its disabled state is the flag');

// ── The typed steer, arriving while that turn runs ───────────────────────────
const TYPED = 'kept-' + Math.random().toString(36).slice(2, 9);
await p.fill('#chat-input', TYPED);
await p.click('#chat-send', { force: true });
await sleep(600);

const after = await p.evaluate(() => ({
	box:    (document.getElementById('chat-input') || {}).value || '',
	queued: document.body.innerText,
}));
check('2a WHAT WAS TYPED IS KEPT, not swallowed', after.queued.includes(TYPED),
	after.queued.includes(TYPED) ? '' : 'nothing on screen carries it');
check('2b and the box is cleared, so the app has visibly taken it',
	after.box.trim() === '', JSON.stringify(after.box.slice(0, 40)));
await shot(s, 'steerqueue-held');

// ── A preset must NOT be queued ──────────────────────────────────────────────
//
// Driven through `doSteer` itself with a preset, which is how a gather round, a
// trigger and the conductor all reach it. The queue must not grow.
const PRESET = 'preset-' + Math.random().toString(36).slice(2, 9);
const drove = await p.evaluate((t) => {
	const has  = !!(window.DaimondCore && typeof window.DaimondCore.steer === 'function');
	const busy = !!(document.getElementById('chat-fold-btn') || {}).disabled;
	if (has) window.DaimondCore.steer(t);
	return { has, busy };
}, PRESET);
check('3a the preset door exists and a turn is still in flight when it is taken',
	drove.has === true && drove.busy === true, JSON.stringify(drove));
await sleep(600);
const presetSeen = await p.evaluate((t) => document.body.innerText.includes(t), PRESET);
// Labelled UNPROVED because no break reddens it — see the note beside BREAKS.
// A check nobody can make fail is worth keeping and is not worth trusting, and
// the name is where a reader finds that out.
check('3 a preset is not queued (regression guard, unproved — see BREAKS)',
	presetSeen === false, presetSeen ? 'the preset reached the queue' : '');

const errs = errors(s).filter(e => !/502|401|Account service|favicon/.test(e));
check('4 nothing was raised in the console', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length ? `--break ${BREAK}: reddened ${bad.length} check(s), as it must`
		: `--break ${BREAK}: CHANGED NOTHING — the check it names is not testing what it says`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
