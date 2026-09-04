// The model's own working, after it has been demoted — note 05 of the 2026-08-27 round.
//
// Verbatim: *"Chats are losing responses from models. I see some response text from a model,
// then later it is superceded by a final answer and I can't see what was there before."*
//
// Nothing is lost, and that was measured before anything was changed.  A run of prose
// followed by a tool call is demoted by `demoteToWorking` (www/js/daimond.js) into a
// collapsed control, exactly as designed on 2026-08-23 -- and the WHOLE run, working and
// answer both, is stored as one assistant message, so a reload shows every word of it.
//
// What the tester met is presentational, and in two parts.  A paragraph he had just watched
// arrive was replaced by one grey sentence with no sign that there was anything behind it;
// and that sentence was cut at 160 characters wherever that landed, mid-word, in the branch
// the code's own comment says never happens.  Both are checked here, and the second is
// checked with a narration deliberately built to have no sentence end inside 160 characters,
// because that is the only input that reaches the broken branch.
//
// AND THERE WAS A THIRD PART, which this file could not see because it never touched the
// switch.  The 2026-08-23 design also hid the demoted tile with the tool steps, so a reader
// with Steps off was shown no working at all -- zero by zero, nothing to open, the model's
// prose gone from the screen entirely.  The owner reversed that on 2026-08-28 and
// `dev/verify_visible.mjs` is where the switch is now driven; this file runs with it in its
// default position and is unchanged in what it asks.
//
//   node dev/verify_working.mjs
//   node dev/verify_working.mjs --break midword   # the cut put back where it was
//   node dev/verify_working.mjs --break nocount   # the control with nothing to say it opens

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const WWW  = path.join(ROOT, 'www');
const H = await import(path.join(HERE, 'harness.mjs'));
const { open, newChat, chat, transcript, shot, connectMock, signInAs, scratch } = H;

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i === -1 ? '' : (process.argv[i + 1] || '');
})();
const NAME = 'working';

let failures = 0;
const log = (...a) => console.log(...a);
const line = (t) => log('\n════════ ' + t + ' ════════');
const check = (ok, what, detail = '') => {
	log((ok ? '  PASS  ' : '  FAIL  ') + what + (detail ? '  -- ' + detail : ''));
	if (!ok) failures++;
};

const BREAKS = {
	// The cut put back exactly as it was: 160 characters, wherever that lands.
	midword: [{
		file: 'js/daimond.js',
		find: "\t\t\tvar sp = head.lastIndexOf(' ');\n\t\t\tif (sp > 40) head = head.slice(0, sp);",
		with: "\t\t\tvar sp = head.lastIndexOf(' ');\n\t\t\tif (false) head = head.slice(0, sp);",
	}],
	// The control, with nothing on it to say there is anything to open.
	nocount: [{
		file: 'js/daimond.js',
		find: "tOr('chat.working_more', '+{n} characters', { n: rest.length })",
		with: "''",
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
const bodies = new Map();
for (const spec of (BREAKS[BREAK] || [])) {
	const src = bodies.has(spec.file) ? bodies.get(spec.file)
		: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	bodies.set(spec.file, damaged(src, spec));
}
async function serveBreaks(page) {
	for (const [file, body] of bodies) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body }));
	}
}

// THE FIXTURE IS THE INPUT THAT REACHES THE BROKEN BRANCH, and it is built here rather than
// written out, so a later hand cannot shorten it without noticing what it was for. No full
// stop until well past 160 characters, which is what sends `demoteToWorking` down the arm
// that used to cut wherever 160 fell.
const LONG = 'INTERIM-PROSE-MARKER and then the model keeps going in one long clause about '
	+ 'the line numbers it means to pin down and the files it means to open before it would '
	+ 'ever commit to anything at all, still with no full stop anywhere in sight, and only '
	+ 'here does it finally stop. Then a second sentence, which is the part that goes behind '
	+ 'the control and must be findable.';
// THE 160th CHARACTER MUST LAND INSIDE A WORD, or the broken branch cuts cleanly by luck and
// `--break midword` reddens nothing. Asserted rather than trusted: the first draft of this
// fixture put a space there, the break passed every check, and the proof was worthless.
if (/\s/.test(LONG[160]) || LONG.search(/[.!?](\s|$)/) < 160) {
	console.error('the fixture no longer reaches the branch under test: character 160 is '
		+ JSON.stringify(LONG[160]) + ' and the first sentence ends at '
		+ LONG.search(/[.!?](\s|$)/));
	process.exit(2);
}

const s = await open({ name: NAME, connect: false,
	profile: scratch('pw', 'working' + (BREAK ? '-' + BREAK : '')),
	route: serveBreaks });
await connectMock(s);
await newChat(s);

const dir = await s.page.evaluate(() => {
	const f = window.DaimondAttach.focus();
	return f && f.id ? window.DaimondAttach.chatScratch(f.id) : '';
});
check(!!dir, 'the chat has a scratch folder, so the tool call has somewhere legal to point', dir);
await chat(s, `@narrate ${LONG} ;; file_list {"path":"${dir}"}`, { timeout: 60000 });

line('1. the words are still there');
const live = await transcript(s);
check(live.includes('INTERIM-PROSE-MARKER'),
	'the prose the reader watched arrive is still on screen after the answer superseded it');
check(live.includes('Narration done'), 'and so is the answer');

line('2. and the control says there is something to open');
const seen = await s.page.evaluate(() => {
	const w = document.querySelector('.chat-msg-working');
	if (!w) return { there: false };
	// A demoted working run is a muted think tile now: its label bar carries the
	// "+N characters" count (.ctile-meta), the summary sentence is the peek, and
	// the rest sits in the body behind the collapse.
	const more = w.querySelector('.ctile-meta');
	const body = w.querySelector('.chat-thinking-body');
	const peek = w.querySelector('.ctile-peek');
	const label = peek ? String(peek.textContent || '').trim() : '';
	return {
		there: true,
		label: label,
		more:  more ? String(more.textContent || '').trim() : '',
		moreBox: more ? more.getBoundingClientRect().width : 0,
		body:  body ? String(body.textContent || '') : '',
		open:  !w.classList.contains('collapsed'),
	};
});
check(seen.there, 'the run of prose was demoted to working, which is the shape this is about');
check((seen.body || '').length > 0,
	'the rest of it is behind the control rather than gone', `${(seen.body || '').length} characters`);

// THE CUT, which is the defect. The code's own comment says "never mid-word"; the branch this
// fixture reaches did exactly that. A label that ends inside a word is the failure, and it is
// asked of the label rather than of the source.
const ends = (seen.label || '').slice(-1);
const wholeWord = !!seen.label && (
	/[.!?]$/.test(seen.label)                      // cut on a sentence end
	|| !LONG.slice(seen.label.length, seen.label.length + 1).match(/\S/));
check(wholeWord,
	'the summary never ends in the middle of a word',
	`ends "${(seen.label || '').slice(-28)}" (next character in the source: `
	+ JSON.stringify(LONG.slice((seen.label || '').length, (seen.label || '').length + 1)) + ')');
check(/\d/.test(seen.more || '') && seen.moreBox > 0,
	'and it says how much went behind it, so the control reads as one',
	`"${seen.more}" at ${seen.moreBox}px`);
check(seen.open === false,
	'it starts closed, because the working is not the answer');

line('3. nothing was lost, which is what the store has to show');
const stored = await s.page.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats', 1);
	req.onsuccess = () => {
		const db = req.result; let t;
		try { t = db.transaction('chats', 'readonly'); } catch (e) { res([]); return; }
		const out = []; const cur = t.objectStore('chats').openCursor();
		cur.onsuccess = () => { const c = cur.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
		cur.onerror = () => res(out);
	};
	req.onerror = () => res([]);
}));
const asst = stored.flatMap(c => c.messages || []).filter(m => m.role === 'assistant');
check(asst.some(m => String(m.content || '').includes('INTERIM-PROSE-MARKER')),
	'the working is stored as part of the turn, so it was never the app\'s to lose',
	`${asst.length} assistant message(s) stored`);

await s.page.reload({ waitUntil: 'domcontentloaded' });
await s.page.waitForTimeout(1200);
await signInAs(s, NAME);
await s.page.waitForTimeout(1500);
await s.page.evaluate(() => {
	const b = document.querySelector('#session-list .chat-box.active')
		|| document.querySelector('#session-list .chat-box');
	if (b) b.click();
});
await s.page.waitForTimeout(1200);
const after = await transcript(s);
check(after.includes('INTERIM-PROSE-MARKER'),
	'and a reader who comes back tomorrow can still read it');

await shot(s, 'working-final');
const errs = s.errs.filter(e => !/favicon|manifest|502|Bad Gateway/i.test(e));
check(errs.length === 0, 'no unexpected console errors', errs.slice(0, 3).join(' | '));
await s.close();

log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
