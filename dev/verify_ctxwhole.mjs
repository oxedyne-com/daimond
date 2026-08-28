// Is the whole conversation fed back to the model, and is the user told when it is not?
//
// Note 06 of the 2026-08-27 tester round, verbatim: *"Serious: all of a conversation is not
// being fed back into context in long chats. Easily tested, just ask a model if it is
// receiving some of its first response in a long transcript."*
//
// That is a test, so it is run here rather than reasoned about.  A first reply carrying a
// unique word, an ordinary conversation on top of it, and then the MOCK'S OWN LOG read back
// to see whether the word is still in the request the model was sent.  Nothing here asks the
// app what it did.
//
// What the answer turned out to be, and why the checks are shaped as they are.  Nothing was
// dropping messages: twenty turns reach the model whole, and so do twenty turns reloaded from
// the store.  A long enough conversation FOLDS, which is `src/compact.rs` working as designed
// and paid for, and the app announced it in one sentence at the bottom of the thread -- while
// leaving every folded message on screen above it, at full fidelity, drawn exactly like the
// ones the model still has.  So the reader scrolls up, reads their first answer, asks about
// it, is told it is gone, and concludes the app is losing the conversation.
//
// The defect is therefore the disclosure and not the fold, and these checks are about the
// LINE: it is drawn, it says which side of it the model still has, it survives a reload, and
// it does not dim the words above it.
//
//   node dev/verify_ctxwhole.mjs
//   node dev/verify_ctxwhole.mjs --break noline     # the notice with no boundary
//   node dev/verify_ctxwhole.mjs --break nomark     # the boundary with nothing marked above
//   node dev/verify_ctxwhole.mjs --break dimmed     # the mark, but the ink taken out of it
//   node dev/verify_ctxwhole.mjs --break oldfold    # the fold fraction back at 0.8

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const H = await import(path.join(HERE, 'harness.mjs'));
const { open, newChat, chat, transcript, shot, connectMock, mockLog, clearMockLog,
	contentText, signInAs } = H;

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i === -1 ? '' : (process.argv[i + 1] || '');
})();
const NAME  = 'ctxwhole';
const MARK  = 'FIRSTREPLY-Q7X2';
const WWW   = path.join(ROOT, 'www');

// ── Every check is proved against broken code first ──────────────────────────
//
// A break serves ONE damaged file to the browser -- or, for the two figures read off disk,
// damages the text this file reads -- and the run is then expected to FAIL. A break whose
// anchor is gone stops the run rather than passing quietly, because a break that breaks
// nothing proves nothing.
const BREAKS = {
	// The notice goes back to being one more message at the bottom of the thread.
	noline: [{
		file: 'js/daimond.js',
		find: '\t\tvar isFold  = (folded | 0) > 0;',
		with: '\t\tvar isFold  = false;',
	}],
	// The line is drawn and nothing above it is marked, so the region it names is unfindable.
	nomark: [{
		file: 'js/daimond.js',
		find: "\t\t\tn.classList.add('chat-above-fold');",
		with: '\t\t\tif (false) n.classList.add(\'chat-above-fold\');',
	}],
	// The mark, with the ink taken out of the words it marks.
	dimmed: [{
		file: 'css/app.css',
		find: '.chat-above-fold {\n\tborder-left: 2px solid var(--border-2);',
		with: '.chat-above-fold {\n\topacity: 0.45;\n\tborder-left: 2px solid var(--border-2);',
	}],
	// The engine folds where it used to.
	oldfold: [{
		file: '../src/compact.rs',
		find: 'pub const FOLD_AT:     f64 = 0.65;',
		with: 'pub const FOLD_AT:     f64 = 0.8;',
	}],
	// The browser's copy of the figure drifts from the engine's, so the meter marks the fold
	// in a place the engine does not fold at.
	jsdrift: [{
		file: 'js/daimond.js',
		find: 'var DEFAULT_FOLD_AT = 0.65;',
		with: 'var DEFAULT_FOLD_AT = 0.8;',
	}],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// `src` with `spec` applied, or a hard stop.
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

const _bodies = new Map();
for (const spec of (BREAKS[BREAK] || [])) {
	const src = _bodies.has(spec.file) ? _bodies.get(spec.file)
		: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	_bodies.set(spec.file, damaged(src, spec));
}

/// A file as the browser will see it, damaged where a break says so.
const srcOf = (f) => _bodies.has(f) ? _bodies.get(f)
	: fs.readFileSync(path.join(WWW, f), 'utf8');

const TYPE = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
async function serveBreaks(page) {
	for (const [file, body] of _bodies) {
		if (file.startsWith('..')) continue;        // not served; read off disk above
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

/// The last thing the model was actually sent.
const lastSent = () => {
	const rows = mockLog();
	return (rows[rows.length - 1] || {}).messages || [];
};
const carries = (msgs, role, word) =>
	msgs.some(m => m.role === role && contentText(m.content).includes(word));

// ── The two figures, read from the source rather than written down twice ──────
//
// `compact::FOLD_AT` is the engine's authority and `DEFAULT_FOLD_AT` is the browser's copy of
// it, used to draw the meter's mark before an agent exists.  A test that pinned only one of
// them would pass while the meter marked a place the engine does not fold at.
const rustFoldAt = (() => {
	const m = /pub const FOLD_AT:\s*f64\s*=\s*([0-9.]+)/.exec(srcOf('../src/compact.rs'));
	return m ? Number(m[1]) : NaN;
})();
const jsFoldAt = (() => {
	const m = /var DEFAULT_FOLD_AT = ([0-9.]+)/.exec(srcOf('js/daimond.js'));
	return m ? Number(m[1]) : NaN;
})();

line('0. where the conversation folds');
check(rustFoldAt === 0.65,
	'the engine folds at the owner\'s figure', `compact::FOLD_AT = ${rustFoldAt}`);
check(jsFoldAt === rustFoldAt,
	'and the browser draws the mark in the same place',
	`DEFAULT_FOLD_AT = ${jsFoldAt} against compact::FOLD_AT = ${rustFoldAt}`);

clearMockLog();
const s = await open({ name: NAME, connect: false,
	profile: H.scratch('pw', 'ctxwhole' + (BREAK ? '-' + BREAK : '')),
	route: serveBreaks });
await connectMock(s);
await newChat(s);

// ── 1. The owner's own test ──────────────────────────────────────────────────
line('1. a long conversation, under the window');
await chat(s, `@text ${MARK} this is the very first answer in the conversation.`);
for (let i = 1; i <= 12; i++) await chat(s, `@text turn ${i} answer, nothing special.`);

let sent = lastSent();
check(carries(sent, 'user', MARK),
	'the first thing the user said is still in the request', `${sent.length} messages sent`);
check(carries(sent, 'assistant', MARK),
	'AND SO IS THE MODEL\'S FIRST REPLY, which is the question the tester asked',
	`${sent.length} messages sent`);
check(!/[Ff]olded \d+ earlier/.test(await transcript(s)),
	'a conversation this size did not need folding, so nothing was folded');

// ── 2. And it survives a reload ──────────────────────────────────────────────
line('2. after a reload');
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
await chat(s, '@text after the reload.');
sent = lastSent();
check(carries(sent, 'assistant', MARK),
	'the model\'s first reply survives a reload and is sent again',
	`${sent.length} messages sent`);

// ── 3. Force a real fold, and read the line it draws ─────────────────────────
line('3. a conversation big enough to fold');
const BULK = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod. ';
const chunk = BULK.repeat(900);              // about 63 KB of user text per turn
let folded = false;
for (let i = 1; i <= 12 && !folded; i++) {
	await chat(s, `bulk ${i}: ${chunk}`, { timeout: 90000 });
	folded = /[Ff]olded \d+ earlier/.test(await transcript(s));
	log(`  bulk ${i}: ${lastSent().length} messages sent, folded=${folded}`);
}
check(folded, 'the conversation folded, which is the state this is about');

sent = lastSent();
check(sent.some(m => /Daimond folded/.test(contentText(m.content))),
	'the fold notice reached the model, so the summary really is standing in');
check(!carries(sent, 'assistant', MARK),
	'and the first reply is genuinely no longer on the wire — the fold is real, not cosmetic');

const seen = await transcript(s);
check(seen.includes(MARK),
	'while the SCREEN still shows it, which is exactly why the line has to be drawn');

// One ordinary turn AFTER the fold, so there is a message on each side of the line and the
// ink above it can be compared with the ink below it. Without it the fold is the last thing
// in the thread and the comparison has nothing to compare against.
await chat(s, '@text a short turn after the fold.', { timeout: 60000 });

// ── 4. The line ──────────────────────────────────────────────────────────────
line('4. what the reader is shown');
const drawn = await s.page.evaluate(() => {
	const out = document.getElementById('chat-output');
	// THE LAST LINE, not the first. A conversation this size folds again on the turn after,
	// and everything between two folds is above the SECOND one -- correctly marked, and below
	// the first. Measuring from the first read that as the mark running past its own line.
	const lines = [...out.querySelectorAll('.chat-msg-compacted.chat-fold-line')];
	const fold = lines[lines.length - 1] || null;
	const says = fold && fold.querySelector('.chat-fold-boundary');
	const above = [...out.querySelectorAll('.chat-above-fold')];
	// The rule itself is a ::before, so it is measured rather than looked for in the markup.
	const rule = fold ? getComputedStyle(fold, '::before').borderTopWidth : '';
	// WHAT THE MARK DOES TO THE INK, measured by taking the mark off and putting it back
	// rather than by finding a second message to compare against. A conversation that folded
	// on its last turn has nothing below the line to compare with, and a check that needs one
	// is a check that goes blank exactly when the fold is freshest.
	const ink = (n) => {
		if (!n) return null;
		const cs = getComputedStyle(n);
		return { colour: cs.color, opacity: cs.opacity };
	};
	const aboveMsg = out.querySelector('.chat-above-fold.chat-msg-user');
	let unmarkedInk = null;
	if (aboveMsg) {
		aboveMsg.classList.remove('chat-above-fold');
		unmarkedInk = ink(aboveMsg);
		aboveMsg.classList.add('chat-above-fold');
	}
	let belowMsg = null, markedBelow = 0;
	if (fold) {
		let n = fold.nextElementSibling;
		while (n) {
			// The queue box and the turn indicator sit permanently below the line and are
			// furniture rather than conversation, so they are not counted either way.
			if (n.id !== 'chat-queued' && !n.classList.contains('chat-spinner')
				&& n.classList.contains('chat-above-fold')) markedBelow++;
			if (!belowMsg && n.classList.contains('chat-msg-user')) belowMsg = n;
			n = n.nextElementSibling;
		}
	}
	return {
		hasFold:  !!fold,
		says:     says ? (says.textContent || '') : '',
		above:    above.length,
		rule:     rule,
		aboveInk: ink(aboveMsg),
		belowInk: ink(belowMsg) || unmarkedInk,
		markedBelow,
		foldBox:  fold ? fold.getBoundingClientRect().height : 0,
		lines:    lines.length,
	};
});
check(drawn.hasFold, 'the fold notice is drawn as a boundary, not as one more message');
check(drawn.foldBox > 0, 'and it is actually on screen', `height ${drawn.foldBox}`);
check(/^\d/.test(drawn.rule) && parseFloat(drawn.rule) > 0,
	'a rule is drawn across the thread at the fold', `border-top-width ${drawn.rule || '(none)'}`);
check(drawn.says.length > 40 && /above this line/i.test(drawn.says),
	'and it says which side of the line the model still has',
	drawn.says.slice(0, 140));
check(drawn.above > 0,
	'the messages the model no longer holds verbatim are marked',
	`${drawn.above} marked`);
// AND THE MARK STOPS AT THE LINE. A mark that ran on past it would be the app saying the
// model has lost something it is holding, which is the same fault as the silence, pointed the
// other way.
check(drawn.markedBelow === 0,
	'and nothing below the line is marked, because the model still has all of it',
	`${drawn.markedBelow} marked below, ${drawn.lines} fold line(s) in the thread`);
// THE INK IS NOT TAKEN OUT. Dimming the words above the line would be the app hiding a
// conversation it has just been accused of losing, so the mark is a rule down the side and
// the colour is measured to prove it.
check(!!drawn.aboveInk && !!drawn.belowInk
	&& drawn.aboveInk.colour === drawn.belowInk.colour
	&& drawn.aboveInk.opacity === drawn.belowInk.opacity,
	'and they are marked without being dimmed — the words stay as readable as the rest',
	JSON.stringify({ above: drawn.aboveInk, below: drawn.belowInk }));

// ── 5. And the line survives a reload ────────────────────────────────────────
line('5. the line after a reload');
await s.page.reload({ waitUntil: 'domcontentloaded' });
await s.page.waitForTimeout(1200);
await signInAs(s, NAME);
await s.page.waitForTimeout(1500);
await s.page.evaluate(() => {
	const b = document.querySelector('#session-list .chat-box.active')
		|| document.querySelector('#session-list .chat-box');
	if (b) b.click();
});
await s.page.waitForTimeout(1500);
const again = await s.page.evaluate(() => {
	const out = document.getElementById('chat-output');
	return {
		fold:  !!out.querySelector('.chat-msg-compacted.chat-fold-line'),
		says:  (out.querySelector('.chat-fold-boundary') || {}).textContent || '',
		above: out.querySelectorAll('.chat-above-fold').length,
	};
});
check(again.fold && again.above > 0 && /above this line/i.test(again.says),
	'a reader who comes back tomorrow is shown the same line in the same place',
	JSON.stringify({ fold: again.fold, above: again.above }));

// ── 6. The setting ───────────────────────────────────────────────────────────
line('6. the fold point is the user\'s to set');
const row = await s.page.evaluate(() => {
	const sel = document.getElementById('cfg-fold-at');
	if (!sel) return { there: false };
	return {
		there:   true,
		options: [...sel.options].map(o => o.value + ':' + o.textContent),
		value:   sel.value,
	};
});
check(row.there, 'there is a control for it, beside the round limit', JSON.stringify(row.options || []));
if (row.there) {
	check((row.options[0] || '').indexOf(String(Math.round(jsFoldAt * 100)) + '%') !== -1,
		'whose Default row names the figure actually in force', row.options[0]);
	// Chosen the way a user chooses, and read back from where it is kept.
	const stored = await s.page.evaluate(() => {
		const sel = document.getElementById('cfg-fold-at');
		sel.value = '50';
		sel.dispatchEvent(new Event('change'));
		return localStorage.getItem('daimond-byok');
	});
	let f = null;
	try { f = JSON.parse(stored).foldAt; } catch (e) { /* unreadable is a fail below */ }
	check(f === 0.5, 'and a choice is kept as the fraction the engine takes', `foldAt = ${f}`);
}
// The engine's own end of it, since a setting nothing can apply is not a setting.
const engine = await s.page.evaluate(async () => {
	const w = await import('/pkg/oxedyne_daimond.js');
	if (typeof w.DaimondApp !== 'function') return { built: false };
	const a = new w.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, 'x', true);
	const before = a.fold_at;
	if (typeof a.set_fold_at !== 'function') return { built: true, setter: false, before };
	a.set_fold_at(0.5);
	const after = a.fold_at;
	a.set_fold_at(0);                       // zero is "the user has not chosen"
	return { built: true, setter: true, before, after, afterZero: a.fold_at };
});
check(engine.setter === true, 'the engine takes a fold fraction from the browser',
	JSON.stringify(engine));
check(Math.abs((engine.before || 0) - jsFoldAt) < 1e-9,
	'a fresh agent folds where the browser says it does', `${engine.before} against ${jsFoldAt}`);
check(engine.after === 0.5 && engine.afterZero === 0.5,
	'a chosen fraction is taken, and a zero leaves it alone rather than folding to nothing',
	JSON.stringify(engine));

await shot(s, 'ctxwhole-final');
const errs = s.errs.filter(e => !/favicon|manifest|502|Bad Gateway/i.test(e));
check(errs.length === 0, 'no unexpected console errors', errs.slice(0, 3).join(' | '));
await s.close();

log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
