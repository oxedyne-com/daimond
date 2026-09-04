// The switch called Steps hides the STEPS, and not the model's own sentences.
//
// The owner's ruling of 2026-08-28, reversing a decision taken on 2026-08-23.  A run of prose
// that a tool call follows is demoted by `demoteToWorking` (www/js/daimond.js) into a
// `.chat-msg-working` tile, and that tile carried `.chat-output.hide-tools`'s `display: none`.
// So a reader who had turned the tool steps off was ALSO shown none of the model's prose: a
// turn of twenty calls drew twenty paragraphs of working, and with the switch on it drew a
// blank thread with one final answer at the bottom of it.
//
// That is note 05's complaint arriving by the other door, and it is the likelier cause of it:
// *"Chats are losing responses from models. I see some response text from a model, then later
// it is superceded by a final answer and I can't see what was there before."*  With the switch
// off the tile is collapsed, which the merged fix made legible; with the switch on it measured
// zero by zero and there was nothing to open at all.
//
// Measured as INK -- a bounding box, not a query -- because a `display: none` element still
// answers `textContent` and still appears in the markup.  A check that read the transcript
// would have passed throughout the whole of the defect.
//
//   node dev/verify_visible.mjs
//   node dev/verify_visible.mjs --break hidework   # the rule that hid the working, put back

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WWW  = path.join(ROOT, 'www');
const H = await import(path.join(HERE, 'harness.mjs'));
const { open, newChat, chat, transcript, shot, connectMock, scratch } = H;

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i === -1 ? '' : (process.argv[i + 1] || '');
})();
const NAME = 'visible';
const MARK = 'INTERIM-PROSE-MARKER';

// ── Every check is proved against broken code first ──────────────────────────
const BREAKS = {
	// The rule as it stood until 2026-08-28: the working goes when the steps go.
	hidework: [{
		file: 'css/app.css',
		find: '.chat-msg-working { margin: 4px 0 4px 2px; }',
		with: '.chat-output.hide-tools .chat-msg-working { display: none; }\n'
			+ '.chat-msg-working { margin: 4px 0 4px 2px; }',
	}],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}
const TYPE = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
const bodies = new Map();
for (const spec of (BREAKS[BREAK] || [])) {
	const src = bodies.has(spec.file) ? bodies.get(spec.file)
		: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	bodies.set(spec.file, damaged(src, spec));
}
async function serveBreaks(page) {
	for (const [file, body] of bodies) {
		const type = TYPE[path.extname(file)] || 'text/plain';
		await page.route('**/' + file, r => r.fulfill({ status: 200, contentType: type, body }));
	}
}

let failures = 0;
const log = (...a) => console.log(...a);
const line = (t) => log('\n════════ ' + t + ' ════════');
const check = (ok, what, detail = '') => {
	log((ok ? '  PASS  ' : '  FAIL  ') + what + (detail ? '  -- ' + detail : ''));
	if (!ok) failures++;
};

// The narration has to be long enough to be demoted into a control rather than a single quiet
// line, since the control is the shape the reader loses when the tile is hidden.
const LONG = `${MARK} and then the model keeps going in one long clause about the line numbers `
	+ 'it means to pin down and the files it means to open before it would ever commit to '
	+ 'anything at all, still with no full stop anywhere in sight, and only here does it '
	+ 'finally stop. Then a second sentence, which is the part that goes behind the control '
	+ 'and must be findable whichever way the switch is set.';

const s = await open({ name: NAME, connect: false,
	profile: scratch('pw', 'visible' + (BREAK ? '-' + BREAK : '')),
	route: serveBreaks });
await connectMock(s);
await newChat(s);

const dir = await s.page.evaluate(() => {
	const f = window.DaimondAttach.focus();
	return f && f.id ? window.DaimondAttach.chatScratch(f.id) : '';
});
check(!!dir, 'the chat has a scratch folder, so the tool call has somewhere legal to point', dir);
await chat(s, `@narrate ${LONG} ;; file_list {"path":"${dir}"}`, { timeout: 60000 });

/// What is actually on the screen, in pixels, for each of the three things the switch governs.
const ink = () => s.page.evaluate(() => {
	const out = document.getElementById('chat-output');
	const box = (n) => {
		if (!n) return 0;
		const r = n.getBoundingClientRect();
		// A `display: none` element reports 0x0; so does one clipped to nothing. Either way
		// there is no ink, which is the only question being asked.
		return Math.round(r.width) * Math.round(r.height) > 0 ? Math.round(r.height) : 0;
	};
	const work = out.querySelector('.chat-msg-working');
	// Expand the tool tile before measuring: since 2026-09-04 Steps hides the tool's
	// DETAIL (its Sent→Result body), not the whole tile, so what the switch governs is
	// the `.ctile-io` body — which is only on screen at all when the tile is open.
	const tool = out.querySelector('.ctile[data-t="tool"]');
	if (tool) tool.classList.remove('collapsed');
	return {
		hidden:  out.classList.contains('hide-tools'),
		working: box(work),
		// The words inside it, whether or not they are drawn.
		words:   work ? String(work.textContent || '') : '',
		// The tool STEP is its Sent→Result detail; the LABEL is the compact marker
		// that stays in the flow so a tool between two reasoning steps is not orphaned.
		steps:   box(tool && tool.querySelector('.ctile-io')),
		toolLabel: box(tool && tool.querySelector(':scope > .ctile-lbl')),
		answer:  box(out.querySelector('.chat-msg-assistant')),
	};
});

line('1. with the steps shown');
// PUT WHERE THIS RUN NEEDS IT, not assumed to be there. The switch is kept in localStorage and
// the browser profile is reused between runs, so a second run of this file started with the
// switch left on by the first and failed a check about the default. What is under test is what
// each position DRAWS, not which of them a fresh profile opens in.
await s.page.evaluate(() => {
	const out = document.getElementById('chat-output');
	const b = document.getElementById('steps-toggle-btn');
	if (out && b && out.classList.contains('hide-tools')) b.click();
});
await s.page.waitForTimeout(400);
let seen = await ink();
check(!seen.hidden, 'the switch is off, which is this half of the comparison');
check(seen.working > 0, 'the model\'s working is on screen', `${seen.working}px tall`);
check(seen.words.includes(MARK), 'and it is the prose the reader watched arrive');
check(seen.steps > 0, 'and so is the tool step it decided on', `${seen.steps}px tall`);
await shot(s, 'visible-steps-on');

line('2. with the steps hidden, which is what the ruling is about');
await s.page.evaluate(() => {
	const b = document.getElementById('steps-toggle-btn');
	if (b) b.click();
});
await s.page.waitForTimeout(400);
seen = await ink();
check(seen.hidden, 'the switch is on');
check(seen.steps === 0, 'THE TOOL STEP DETAIL IS GONE, which is what the switch is for');
check(seen.toolLabel > 0,
	'but the Tool label STAYS in the flow, so a tool between two reasoning steps is not orphaned',
	`${seen.toolLabel}px tall`);
check(seen.working > 0,
	'AND THE MODEL\'S OWN PROSE IS STILL DRAWN, which is the ruling',
	`${seen.working}px tall`);
check(seen.words.includes(MARK),
	'with the words the reader watched arrive still in it');
check(seen.answer > 0, 'and the answer below it, untouched');
await shot(s, 'visible-steps-off');

line('3. and the collapsed summary still earns its keep');
// Both halves the merged lane added: the count that says there is something to open, and a
// summary that does not end inside a word. The prose is COLLAPSED even when it is not hidden,
// so neither stops mattering under this ruling.
const control = await s.page.evaluate(() => {
	const w = document.querySelector('.chat-msg-working');
	// The working run is a muted think tile: the "+N characters" count is the label
	// meta, the summary sentence is the peek, and it is collapsed (not the answer).
	const more = w && w.querySelector('.ctile-meta');
	const peek = w && w.querySelector('.ctile-peek');
	const label = peek ? String(peek.textContent || '').trim() : '';
	return {
		label,
		more:    more ? String(more.textContent || '').trim() : '',
		moreBox: more ? Math.round(more.getBoundingClientRect().width) : 0,
		open:    w ? !w.classList.contains('collapsed') : null,
	};
});
check(/\d/.test(control.more) && control.moreBox > 0,
	'the control still says how much is behind it', `"${control.more}" at ${control.moreBox}px`);
check(control.open === false, 'and it is still closed, because the working is not the answer');
check(!!control.label && !/\S$/.test(LONG.slice(control.label.length, control.label.length + 1)),
	'and its summary still stops on a whole word',
	`ends "${control.label.slice(-24)}"`);

line('4. the switch survives a reload, and so does the prose');
await s.page.reload({ waitUntil: 'domcontentloaded' });
await s.page.waitForTimeout(1200);
await H.signInAs(s, NAME);
await s.page.waitForTimeout(1500);
await s.page.evaluate(() => {
	const b = document.querySelector('#session-list .chat-box.active')
		|| document.querySelector('#session-list .chat-box');
	if (b) b.click();
});
await s.page.waitForTimeout(1200);
const after = await transcript(s);
check(after.includes(MARK),
	'a reader coming back tomorrow reads it too, with the steps still hidden');

const errs = s.errs.filter(e => !/favicon|manifest|502|Bad Gateway/i.test(e));
check(errs.length === 0, 'no unexpected console errors', errs.slice(0, 3).join(' | '));
await s.close();

log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
