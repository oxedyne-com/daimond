// verify_netchip.mjs — the permissions button says what it governs, shows whether
// THIS chat's commands have the network, and lets that be granted and taken back.
//
// THE DEFECT, reported on 2026-08-19 by the owner, about a dialog he had been
// approving for weeks: *"I always click approve. I never even understand the
// message itself."* Three things were wrong and only the first is cosmetic.
//
//   1. THE HOVER NAMED THE CATEGORY. `permmode.chip_help` was "Permission mode:
//      what Daimond does without asking" — which is what somebody hovering a
//      button marked Guarded can already see. The sentence that answers them was
//      written, and sat a click away inside the popover as `guarded_blurb`.
//   2. THE DIALOG SAID "THIS TURN" AND MEANT THIS CHAT. The answer is kept on the
//      chat's own engine object (`ensureApp`, daimond.js), which lasts until the
//      tab reloads — so a reader who took the word at face value expected to be
//      asked again next message and was not.
//   3. AND THERE WAS NO WAY BACK. `set_net_consent` writes once and never
//      overwrites, which is right for the tool loop and wrong for a person: an
//      answer given in passing could not be changed, and a chat that had lost the
//      network showed nothing anywhere to say so.
//
// SIX PROPERTIES:
//
//   1. THE HOVER NAMES THE RUNG. Asserted as the pair — it carries the rung's own
//      word AND is not the old category sentence — because a tooltip that merely
//      changed would satisfy either half alone.
//   2. A CLEAN CHAT SAYS SO AND IS NOT MARKED. The section is drawn, it says
//      nothing is withheld, and the chip carries no mark.
//   3. A CHAT THAT HAS READ A STRANGER'S WORDS IS MARKED, on the button, where it
//      can be seen without opening anything.
//   4. GRANTING IT MOVES THE ENGINE. Read from `net_state()` and not from the
//      button that was pressed: a control that relabels itself having changed
//      nothing is the failure this is for.
//   5. AND IT CAN BE TAKEN BACK, which is the thing that was impossible. Both
//      directions, because a one-way control that happens to start in the other
//      state would satisfy check 4 on its own.
//   6. THE SECTION IS NOT A FOURTH RUNG. Still exactly three radios, under a head
//      of their own, or a per-chat state would read as a setting outliving the chat.
//
// PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_netchip.mjs --break generic  # 1 fails: the hover names the category again
//   node dev/verify_netchip.mjs --break nomark   # 3 fails: a cut chat looks like a clean one
//   node dev/verify_netchip.mjs --break stuck    # 5 fails: an answer cannot be changed
//   node dev/verify_netchip.mjs --break nosection# 3-6 fail, then it dies on the missing button
//   node dev/verify_netchip.mjs                  # and then, clean
//
// `stuck` is the SHARP one and the reason it exists. The defect it restores lives
// in Rust — `override_net_consent` tidied back into the write-once rule — which no
// served-file break can reach, so it is restored here at the surface instead: the
// button that can only ever say yes. The Rust half is held by
// `test_the_user_can_take_an_answer_back_though_the_dialog_cannot`, which was run
// against that exact edit and went red on "a no could not be taken back".
//
// `nosection` is the crude one: it fails four checks at once and therefore proves
// nothing about the three after the first, then dies clicking a button that is not
// there. It is kept because the section being absent is a real way this can break,
// not because it tests anything sharply.
//
// THE MARK IS SET DIRECTLY, through `DaimondCore.markRead`. It is the same one-way
// flag every real path ends at, so the STATE under test is the real state; which
// reads produce it is a Rust question and is answered there.
//
//   eval "$(bash dev/world.sh 4 --up)"
//   node dev/verify_netchip.mjs
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
	// The tooltip as it stood: the category, which the word on the button already gives.
	generic: {
		file: 'js/handmode.js',
		find: "\t\t\tchip.title = label(current) + ' — ' + blurb(current);",
		with: "\t\t\tchip.title = t('permmode.chip_help');",
	},
	// The mark taken off, so a chat with no network looks exactly like one with it.
	nomark: {
		file: 'js/handmode.js',
		find: "\t\t\tchip.classList.toggle('net-cut', cut);",
		with: "\t\t\tchip.classList.toggle('net-cut', false);",
	},
	// The button that can only ever say yes — `override_net_consent` folded back
	// into the write-once rule, restored where a served file can reach it.
	stuck: {
		file: 'js/handmode.js',
		find: "\t\tb.addEventListener('click', function () { setNet(allowed ? 'refuse' : 'allow'); });",
		with: "\t\tb.addEventListener('click', function () { setNet('allow'); });",
	},
	// No chat can be asked, so the whole section goes.
	nosection: {
		file: 'js/handmode.js',
		find: "\t\tif (typeof cfg.netGet !== 'function') return '';",
		with: "\t\tif (typeof cfg.netGet === 'function') return '';",
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
		status: 200, contentType: 'application/javascript', body,
	}));
};

const s = await open({
	name:    'netchip',
	profile: scratch('pw', 'netchip' + (BREAK ? '-' + BREAK : '')),
	route:   stub,
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

// The popover is rebuilt on every open, so it is opened fresh for each reading
// rather than left up: a stale one would report the state at the moment it opened.
const popOpen = async () => {
	await p.evaluate(() => {
		const pop = document.getElementById('hand-mode-pop');
		if (!pop.hidden) document.getElementById('hand-mode-chip').click();
	});
	await p.click('#hand-mode-chip');
	await p.waitForTimeout(400);
};
const popClose = async () => {
	await p.evaluate(() => {
		const pop = document.getElementById('hand-mode-pop');
		if (!pop.hidden) document.getElementById('hand-mode-chip').click();
	});
	await p.waitForTimeout(250);
};
const readPop = () => p.evaluate(() => {
	const pop  = document.getElementById('hand-mode-pop');
	const chip = document.getElementById('hand-mode-chip');
	const heads = [...pop.querySelectorAll('.pop-head')].map(e => e.textContent.trim());
	const now   = pop.querySelector('.net-now');
	const btn   = pop.querySelector('.net-btn');
	return {
		heads,
		rungs:   pop.querySelectorAll('.mode-row input[type=radio]').length,
		now:     now ? now.textContent.trim() : '',
		btn:     btn ? btn.textContent.trim() : '',
		hasBtn:  !!btn,
		marked:  chip.classList.contains('net-cut'),
		title:   chip.title || '',
		aria:    chip.getAttribute('aria-label') || '',
		engine:  (window.DaimondCore && DaimondCore.netState) ? DaimondCore.netState() : '',
	};
});

try {
	await newChat(s);
	// A turn, so the chat has an engine to answer for. Nothing here reads anything
	// from outside — that is check 2's whole point.
	await p.fill('#chat-input', '@text hello');
	await p.click('#chat-send');
	await p.waitForTimeout(3500);

	// ── 1. The hover names the rung ──────────────────────────────
	await popOpen();
	const clean = await readPop();
	await popClose();
	const rung = await p.evaluate(() =>
		document.getElementById('hand-mode-chip-txt').textContent.trim());
	// THE PAIR. "Names the rung" alone would pass on a tooltip that says "Guarded"
	// and nothing else; "is not the old sentence" alone would pass on any rewording.
	check(clean.title.includes(rung) && clean.title.length > rung.length + 12,
		'THE HOVER NAMES THIS RUNG AND WHAT IT DOES',
		JSON.stringify(clean.title.slice(0, 96)));
	// AGAINST THE STRING ITSELF, not against the words it used to hold. Written the
	// second way first, and `--break generic` did not redden it: the break restores
	// `permmode.chip_help`, whose wording had also been shortened, so a literal from
	// the old copy matched nothing and the check could not fail. Read the key.
	const generic = await p.evaluate(() =>
		(window.DaimondI18n ? DaimondI18n.t('permmode.chip_help') : ''));
	check(!!generic && clean.title !== generic,
		'and is not the category sentence, whatever that sentence now says',
		`chip_help=${JSON.stringify(generic)}`);

	// ── 2 and 6. A clean chat, and the section's altitude ────────
	check(clean.heads.some(h => /this chat/i.test(h)),
		'THE POPOVER HAS A SECTION FOR THIS CHAT', JSON.stringify(clean.heads));
	check(/nothing/i.test(clean.now) && clean.engine === 'open',
		'A CLEAN CHAT SAYS NOTHING IS WITHHELD, and the engine agrees',
		`${JSON.stringify(clean.now.slice(0, 60))} engine=${clean.engine}`);
	check(!clean.marked, 'AND THE BUTTON IS NOT MARKED', `net-cut=${clean.marked}`);
	// Not a fourth rung. A per-chat state sitting in the ladder would read as a
	// setting that outlives the chat, which is the one thing it is not.
	check(clean.rungs === 3,
		'and the ladder is still three rungs, with the chat under a head of its own',
		`${clean.rungs} radios, heads ${JSON.stringify(clean.heads)}`);

	// ── 3. A chat that has read a stranger's words ───────────────
	const marked = await p.evaluate(() =>
		!!(window.DaimondCore && DaimondCore.markRead && DaimondCore.markRead()));
	check(marked, 'the chat can be marked as having read outside content',
		marked ? '' : 'DaimondCore.markRead did not take');
	// A REAL TURN, and not a direct redraw. The mark goes on during a turn and the
	// app refreshes the chip when that turn ends; calling the redraw from here would
	// prove the drawing works while leaving the wiring that calls it unproved, and
	// deleting that wiring would not redden anything.
	await p.fill('#chat-input', '@text and again');
	await p.click('#chat-send');
	await p.waitForTimeout(3500);
	// Read BEFORE anything is opened — that is the property.
	const chipCut = await p.evaluate(() => ({
		marked: document.getElementById('hand-mode-chip').classList.contains('net-cut'),
		aria:   document.getElementById('hand-mode-chip').getAttribute('aria-label') || '',
	}));
	await popOpen();
	const cut = await readPop();
	cut.marked = chipCut.marked;
	cut.aria   = chipCut.aria;
	await shot(s, 'netchip-cut');
	check(cut.engine === 'cut',
		'a marked chat has lost the network', `engine=${cut.engine}`);
	check(cut.marked,
		'AND THE BUTTON SAYS SO WITHOUT ANYTHING BEING OPENED',
		`net-cut=${cut.marked}, aria=${JSON.stringify(cut.aria)}`);
	check(/no network|without.*network/i.test(cut.now) && cut.hasBtn,
		'and the section says it in a sentence, with the way out beside it',
		`${JSON.stringify(cut.now.slice(0, 70))} btn=${JSON.stringify(cut.btn)}`);

	// ── 4. Granting it moves the ENGINE ──────────────────────────
	await p.click('#hand-mode-pop .net-btn');
	await p.waitForTimeout(500);
	const on = await readPop();
	check(on.engine === 'allowed',
		'GRANTING IT MOVES THE ENGINE, not merely the label on the button',
		`engine=${on.engine}, btn now ${JSON.stringify(on.btn)}`);
	check(!on.marked,
		'and the button stops saying the network is gone', `net-cut=${on.marked}`);

	// ── 5. And it can be taken back ──────────────────────────────
	await p.click('#hand-mode-pop .net-btn');
	await p.waitForTimeout(500);
	const off = await readPop();
	await popClose();
	check(off.engine === 'refused',
		'AND IT CAN BE TAKEN BACK — the thing that was impossible',
		`engine=${off.engine}`);
	check(off.marked,
		'with the button marked again, so the two never disagree',
		`net-cut=${off.marked}`);
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
