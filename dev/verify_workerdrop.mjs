// verify_workerdrop.mjs — an interrupted worker gets the Continue the chat already has.
//
// THE ASYMMETRY. A chat turn cut off by a dead road or a dying tab comes back badged, with a
// Continue button, and pressing it carries the answer on (dev/verify_dropped.mjs). A WORKER cut
// off the same way came back with the word `interrupted` on its tile and nothing to press.
// `Workers.load` rewrites any `running` or `queued` run to `interrupted` on the next boot and
// keeps its partial text, and `Workers.resume` already knows how to start a fresh session
// seeded with a run's own transcript plus a "carry on" line -- it simply refused any status but
// `paused`. Two states that differ only in WHO hung the worker up, one of them a dead end.
//
// WHY IT IS NOT THE SAME AS A BATCH. Batches are deliberately not persisted: "a tab that died
// mid-fan-out comes back with its agents marked `interrupted` -- there is no round to resume,
// and inventing one on reload would re-spend on a turn the user never saw" (www/js/daimond.js).
// That argument is about the GATHER -- the round that hands the workers' reports back to the
// daimon that dispatched them -- and it still stands: nothing here revives a batch. What it
// says nothing about is one worker, one task, and a person deciding to finish it. This file is
// about the person.
//
// FOUR PROPERTIES:
//
//   1. AN INTERRUPTED WORKER IS OFFERED A CONTINUE. Where there was a status word and no
//      action, there is now the same play button a paused worker has.
//   2. AND PRESSING IT CARRIES THE WORK ON rather than starting it again: `resume` is set,
//      which is what makes `start` seed the new session with the task AND the text so far and
//      send `RESUME_NUDGE` instead of the task.
//   3. UNLESS THERE IS NOTHING TO CARRY ON FROM. A worker that produced no text is started
//      over -- "do not repeat work already done above" is an instruction about nothing when
//      there is nothing above, and a model asked to continue an empty answer invents one.
//   4. AND A FINISHED WORKER IS NOT OFFERED ONE. The check that makes the others mean
//      something: a Continue on a run that is done would spend money to redo finished work.
//
// PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_workerdrop.mjs --break notile   # 1-3 fail: the tile offers nothing
//   node dev/verify_workerdrop.mjs --break norestart # 3 fails: an empty worker is "continued"
//   node dev/verify_workerdrop.mjs                  # and then, clean
//
// `--break notile` is the tile exactly as it stood on 2026-08-27.
//
// THE RUNS ARE SEEDED, not produced by a real fan-out. What is under test is the tile and
// `resume`, and a real dispatch would put a Diamond, a governor gate and a mint between this
// file and the two lines it is about. `dev/verify_panelfacts.mjs` seeds the same way and for
// the same reason.
//
//   eval "$(bash dev/world.sh 17 --up)"
//   node dev/verify_workerdrop.mjs
//
// Needs dev/serve.mjs. No gateway, no model: nothing here sends a turn.
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

const BREAKS = {
	// The tile before the fix: only a paused run is offered anything.
	notile: [
		"\t\t\t} else if (run.status === 'paused' || run.status === 'interrupted') {\n",
		"\t\t\t} else if (run.status === 'paused') {\n",
	],
	// The plausible over-correction: continue everything, including a run with no text
	// to continue from.
	norestart: [
		"\t\t\trun.resume = !!(run.text && run.text.trim());\n",
		"\t\t\trun.resume = true;\n",
	],
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
for (const [k, [from]] of Object.entries(BREAKS)) {
	if (SRC.split(from).length !== 2) {
		console.error(`the line the '${k}' break patches is not in js/daimond.js exactly once; `
			+ 'the anchor has moved and the break would patch nothing');
		process.exit(2);
	}
}

const s = await open({
	name:    'workerdrop',
	profile: scratch('pw', 'workerdrop' + (BREAK ? '-' + BREAK : '')),
	// The mock IS connected: check 2 lets the resumed worker actually run, and what it
	// answers is the evidence that the transcript went with it.
	route:   BREAK ? (async (page) => {
		const [from, to] = BREAKS[BREAK];
		await page.route('**/js/daimond.js', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: SRC.replace(from, to),
		}));
	}) : null,
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

/// Three runs: one cut off with something to show for it, one cut off with nothing, and one
/// that finished. Written through `Workers` itself rather than into localStorage, so what is
/// drawn is drawn from the same objects the app would hold after a `load`.
const seed = (chatId) => p.evaluate(async (chatId) => {
	const W = window.DaimondWorkers;
	W.runs = [];
	const base = {
		// A CHAT-DISPATCHED WORKER, because a worker has to be fenced to somewhere: with
		// neither a chat nor a Diamond, `start` refuses with "an agent was dispatched
		// without a Diamond to work in" before it reaches anything this file is about.
		diamondId: '', diamondName: '', chatId: chatId, chatName: 'workerdrop',
		model: 'mock/fast', provider: 'custom', tools: [], sees: false,
		promptTokens: 40, completionTokens: 12, cachedTokens: 0, costUsd: 0, app: null,
	};
	// `@text` is a directive to the mock, so the resumed leg's answer is known exactly and
	// can be told apart from the partial that was already there.
	W.runs.push(Object.assign({}, base, { id: 'w1', name: 'cut-off',
		task: '@text carried-on', status: 'interrupted', text: 'one, two, three' }));
	W.runs.push(Object.assign({}, base, { id: 'w2', name: 'cut-off-empty',
		task: '@text from-scratch', status: 'interrupted', text: '' }));
	W.runs.push(Object.assign({}, base, { id: 'w3', name: 'finished',
		task: '@text done', status: 'done', text: 'one two three four' }));
	W.persist();
	window.DaimondPanels.show('agents');
	W.render();
	await new Promise((r) => setTimeout(r, 400));
}, chatId);

/// What each tile offers, by the button's CLASS rather than its words, so a translation does
/// not decide whether this file passes.
const tiles = () => p.evaluate(() => {
	const out = {};
	[...document.querySelectorAll('#agents-list .acard')].forEach((card) => {
		const name = (card.querySelector('.an') || {}).textContent || '';
		out[name.trim()] = {
			play: !!card.querySelector('.abtn.a-play'),
			stop: !!card.querySelector('.abtn.a-cross'),
			cls:  card.className,
		};
	});
	return out;
});

try {
	const chatId = await newChat(s);
	await seed(chatId);
	const before = await tiles();
	await shot(s, 'workerdrop-tiles');

	check(!!(before['cut-off'] && before['cut-off'].play),
		'AN INTERRUPTED WORKER IS OFFERED A CONTINUE',
		before['cut-off'] ? '' : 'no tile drawn for it at all');
	check(!!(before['finished'] && !before['finished'].play),
		'AND A FINISHED ONE IS NOT — a Continue there would redo work already paid for',
		before['finished'] && before['finished'].play ? 'a done run offers Continue' : '');

	// ── 2. It carries on rather than starting again ──────────────
	//
	// `resume` is the flag that decides which of two things `start` does: seed the session
	// with the transcript and send `RESUME_NUDGE`, or send the task afresh. The run is then
	// let go all the way to the mock, because the property worth having is not the flag but
	// what happens to the report -- it must be ADDED TO, not replaced.
	const after = await p.evaluate(async () => {
		const W = window.DaimondWorkers;
		const card = [...document.querySelectorAll('#agents-list .acard')].find(
			(c) => ((c.querySelector('.an') || {}).textContent || '').trim() === 'cut-off');
		const btn = card && card.querySelector('.abtn.a-play');
		const resumed = W.runs.find((r) => r.id === 'w1') || {};
		if (btn) btn.click();
		await new Promise((r) => setTimeout(r, 300));
		const queued = { status: resumed.status, resume: !!resumed.resume,
			prior: resumed.priorPrompt | 0 };
		for (let i = 0; i < 60; i++) {
			if (resumed.status === 'done' || resumed.status === 'error') break;
			await new Promise((r) => setTimeout(r, 250));
		}
		return Object.assign(queued, { ended: resumed.status, text: resumed.text || '' });
	});
	check(after.status !== 'interrupted',
		'and pressing it takes the run out of `interrupted`',
		`status went ${JSON.stringify(after.status)} then ${JSON.stringify(after.ended)}`);
	check(after.resume === true,
		'AND CARRIES THE WORK ON — the session is seeded with what the worker had said',
		after.resume ? '' : 'it was queued to start the task over from scratch');
	// APPENDED, not rewritten: the partial is still at the FRONT of the report and there is
	// more after it. Asserted on the shape rather than on the resumed leg's words, because
	// the mock reads its directive from the last user message and on a resume that message
	// is `RESUME_NUDGE` -- so what the second leg says is the mock's default, not the
	// task's. What matters is that the first leg was kept and built on.
	const PARTIAL = 'one, two, three';
	check(after.text.indexOf(PARTIAL) === 0 && after.text.length > PARTIAL.length,
		'AND THE REPORT IS ADDED TO, NOT REPLACED — the partial is still at the front of it',
		after.text.indexOf(PARTIAL) === 0
			? `${after.text.length - PARTIAL.length} further character(s) after it`
			: JSON.stringify(after.text.slice(0, 90)));
	check(after.prior === 40,
		'and what it had already spent is carried across rather than billed again',
		`priorPrompt ${after.prior}`);

	// ── 3. Nothing to carry on from ──────────────────────────────
	const empty = await p.evaluate(async () => {
		const W = window.DaimondWorkers;
		W.resume(W.runs.find((r) => r.id === 'w2'));
		await new Promise((r) => setTimeout(r, 300));
		const r2 = W.runs.find((r) => r.id === 'w2') || {};
		return { status: r2.status, resume: !!r2.resume };
	});
	check(empty.status !== 'interrupted' && empty.resume === false,
		'A WORKER THAT PRODUCED NOTHING IS STARTED OVER, not asked to continue an empty answer',
		empty.resume ? 'it was told to carry on from nothing' : '');
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
