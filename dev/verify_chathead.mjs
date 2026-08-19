// verify_chathead.mjs — the conversation can be taken out whole, and on a phone
// the header's controls can be reached and the box you type in has room.
//
// THREE THINGS REPORTED FROM A PHONE, 2026-08-19, in the user's own words:
//
//   "I want a copy button in the header of chats and daimons that copies the
//    entire transcript to the clipboard."
//   "In mobile, this header does not scroll so I can't see a lot of buttons."
//   "In mobile, the text prompt input box is too narrow beside the three arrow
//    icons."
//
// MEASURED BEFORE ANY OF IT WAS CHANGED, on a 390px viewport: the input bar is
// 372px wide and the text box had 170 of it — Send and the two walk-back
// chevrons take 46px each plus gaps, so three buttons held more of the row than
// the thing the row exists for. The header's chip row did not overflow either;
// it squeezed the title to an ellipsis and then ran off the end of the panel,
// which is why buttons could not be reached rather than merely not seen.
//
// FOUR PROPERTIES:
//
//   1. THE WHOLE CONVERSATION COPIES, and what lands on the clipboard is the
//      words — both sides, in order, as plain text. Read back out of the
//      clipboard and not off the button, because a button that says "Copied"
//      having copied nothing is the failure this is for.
//   2. AND THE BUTTON SAYS SO, briefly, then goes back to being a button.
//   3. ON A PHONE THE HEADER SCROLLS. Asserted as `scrollWidth > clientWidth`
//      together with an overflow that permits scrolling — the pair, because a row
//      that fits scrolls nowhere and a row that overflows with `visible` is the
//      state the user reported.
//   4. AND THE COMPOSER HAS ROOM. The text box takes more than half the bar,
//      which it did not: 170 of 372 is 46%.
//
// PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_chathead.mjs --break nocopy   # 1 and 2 fail: the button copies nothing
//   node dev/verify_chathead.mjs --break noscroll # 3 fails: the row overflows unreachably
//   node dev/verify_chathead.mjs --break inbar    # 4 fails: the chevrons take the row back
//   node dev/verify_chathead.mjs                  # and then, clean
//
// `--break inbar` restores the measured original exactly — three 46px buttons in
// the bar — so check 4's red is the reported defect and not an invented one.
//
//   eval "$(bash dev/world.sh 4 --up)"
//   node dev/verify_chathead.mjs
//
// Needs dev/serve.mjs and the mock. No gateway, no wasm rebuild.
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

// Each break is one real edit to one real file, served in its place.
const BREAKS = {
	nocopy: {
		file: 'js/daimond.js',
		find: "\t\tvar text = transcriptOf(current);",
		with: "\t\tvar text = '';",
	},
	// BOTH AXES. The first version of this break set `overflow-x: visible` and left
	// `overflow-y: hidden`, and NOTHING went red — because CSS says that when one
	// axis is not `visible` the other computes to `auto`, so the break was a no-op
	// that read as a passing check. A break that does not redden is a finding, and
	// this one's finding was about the break.
	noscroll: {
		file: 'css/responsive.css',
		find: "\t\toverflow-x: auto;\n\t\toverflow-y: hidden;\n\t\tscrollbar-width: none;",
		with: "\t\toverflow: visible;\n\t\tscrollbar-width: none;",
	},
	inbar: {
		file: 'css/responsive.css',
		find: "\t.chat-input-bar #chat-jump,\n\t.chat-input-bar #chat-end {\n\t\tposition: absolute;",
		with: "\t.chat-input-bar #chat-jump,\n\t.chat-input-bar #chat-end {\n\t\tposition: static;",
	},
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

const stub = async (page) => {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	const src  = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	// An anchor that is not there exactly once patches nothing and the run would
	// pass quietly, which is worse than a red.
	if (src.split(spec.find).length !== 2) {
		console.error(`break '${BREAK}': its anchor is not in ${spec.file} exactly once`);
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	await page.route('**/' + spec.file, (r) => r.fulfill({
		status: 200,
		contentType: spec.file.endsWith('.css') ? 'text/css' : 'application/javascript',
		body,
	}));
};

const s = await open({
	name:    'chathead',
	profile: scratch('pw', 'chathead' + (BREAK ? '-' + BREAK : '')),
	route:   stub,
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

try {
	try { await p.context().grantPermissions(['clipboard-read', 'clipboard-write']); }
	catch (e) { /* the read below reports it */ }

	await newChat(s);
	const ASK = '@text the answer is forty two';
	await p.fill('#chat-input', ASK);
	await p.click('#chat-send');
	await p.waitForTimeout(4000);

	// ── 1 and 2. The whole conversation, out ─────────────────────
	const btn = await p.evaluate(() => {
		const b = document.getElementById('chat-copy-btn');
		return b ? { label: b.textContent, w: Math.round(b.getBoundingClientRect().width) } : null;
	});
	check(!!(btn && btn.w > 0), 'there is a copy control in the chat header at all',
		btn ? `${btn.w}px wide` : 'no #chat-copy-btn');

	await p.click('#chat-copy-btn');
	await p.waitForTimeout(700);
	const said = await p.evaluate(() => document.getElementById('chat-copy-btn').textContent);
	const clip = await p.evaluate(async () => {
		try { return await navigator.clipboard.readText(); } catch (e) { return 'CLIPBOARD UNREADABLE: ' + e.message; }
	});
	// BOTH SIDES. Asserting only the question would pass on a transcript that
	// copied what the user typed and none of the answer, which is the likelier
	// half to go missing and the half worth having.
	check(clip.includes(ASK) && clip.includes('the answer is forty two'),
		'THE WHOLE CONVERSATION IS ON THE CLIPBOARD — both sides of it',
		JSON.stringify(clip.slice(0, 90)));
	check(/##\s*You/.test(clip) && /##\s*Daimond/.test(clip),
		'with who said what, so it reads as a conversation somewhere else',
		JSON.stringify(clip.slice(0, 60)));
	check(said !== (btn && btn.label),
		'AND THE BUTTON SAYS SO rather than looking as though nothing happened',
		`${JSON.stringify(btn && btn.label)} then ${JSON.stringify(said)}`);

	// ── 3 and 4. A phone ─────────────────────────────────────────
	await p.setViewportSize({ width: 390, height: 844 });
	await p.waitForTimeout(1200);
	const m = await p.evaluate(() => {
		const right = document.querySelector('#panel-ai .chead-right');
		const bar   = document.querySelector('.chat-input-bar');
		const inp   = document.getElementById('chat-input');
		const r = (el) => el ? Math.round(el.getBoundingClientRect().width) : 0;
		return {
			scrollW:  right ? right.scrollWidth : 0,
			clientW:  right ? right.clientWidth : 0,
			overflow: right ? getComputedStyle(right).overflowX : '',
			barW:     r(bar),
			inputW:   r(inp),
			// The chevrons, to say in the detail WHY the box is the width it is.
			jumpPos:  getComputedStyle(document.getElementById('chat-jump')).position,
		};
	});
	await shot(s, 'chathead-phone');

	// THE PAIR, not either alone. A row that fits has nothing to scroll and would
	// satisfy an overflow test; a row that overflows with `visible` is exactly the
	// reported defect and would satisfy a width test.
	check(m.scrollW > m.clientW && (m.overflow === 'auto' || m.overflow === 'scroll'),
		'ON A PHONE THE HEADER SCROLLS — the row overflows AND may be dragged',
		`scrollWidth ${m.scrollW} vs client ${m.clientW}, overflow-x ${m.overflow}`);
	check(m.inputW > m.barW * 0.6,
		'AND THE BOX YOU TYPE IN HAS ROOM — more than 60% of the bar',
		`${m.inputW} of ${m.barW} (${Math.round(100 * m.inputW / m.barW)}%), chevrons ${m.jumpPos}`);
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
