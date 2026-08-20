// verify_daimonface.mjs — the Centre knows which face it is showing, and says so once.
//
// WHAT THIS IS FOR. The Centre has three faces and one variable that names the one it is
// showing: `centreMode`, written only by `showCentre`, holding one of `CENTRE_FACES` —
// `'chat'` (an ordinary chat), `'focus'` (a Diamond's crystal) and `'daimon'` (a Diamond's
// own conversation, drawn in the chat's thread). Three guards ask which face is up before
// they draw, and all three are about the same thing: IS THIS CONVERSATION THE ONE ON SCREEN.
//
//   * "Fresh daimon" empties a daimon's conversation, and has to repaint the thread. The
//     dialog it is pressed in overlays the app, so what is behind it is stale until
//     something repaints it — and closing a dialog repaints nothing. It also has to make the
//     emptying STICK, which is a separate claim and was the false one: the transcript merge
//     is a deliberate UNION, so an emptied array saved straight back was refilled from the
//     store, and the conversation returned on the next reload with the screen none the wiser.
//   * Fold belongs to the conversation a hand fold can REACH, and to no other. It was
//     drawn on the daimon's face and nowhere else, which is precisely backwards: a
//     Diamond engine's session holds no messages, so `fold_now` there compacts nothing
//     and bills for the round; an ordinary chat is the one that can be folded by hand.
//   * A daimon's reply streams into the thread AS IT ARRIVES, and only when that thread is
//     the one on screen. A turn can run from a gather round with its Diamond nowhere near
//     the screen, and drawing then puts one conversation's words in another's transcript.
//
// WHY THIS FILE EXISTS, which is not the same as what it checks. `centreMode` was declared
// with the comment `'chat' | 'focus'` and had been holding `'daimon'` since a Diamond grew
// two faces — `selectDiamond` calls `showCentre('daimon')`. Read from the declaration alone,
// the three guards above are three dead branches, each a real feature that has supposedly
// never run, and the obvious repair is to make all three live at once. They were already
// live. The COMMENT was the defect, and it was very nearly paid for three times over.
//
// So the check that matters most here is the fourth, and it is worth more than the other
// three: THE DOCUMENTED FACES, THE FACES ANYTHING ENTERS, AND THE FACES ANYTHING COMPARES
// AGAINST MUST BE THE SAME SET. A comparison against a face nothing enters is a dead branch;
// a face documented but never entered is a promise nothing keeps; a write to `centreMode`
// from outside `showCentre` puts the app in a face the list never sanctioned. None of the
// three can be seen by looking at any one line.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST.
//
//   node dev/verify_daimonface.mjs --break no-redraw    # 1a fails: Fresh daimon stops repainting
//   node dev/verify_daimonface.mjs --break resurrect    # 1b+1d fail: the union puts it all back
//   node dev/verify_daimonface.mjs --break sessionless  # 1c fails: the model keeps the conversation
//   node dev/verify_daimonface.mjs --break clear-midturn # 1e fails: a clear a turn then undoes
//   node dev/verify_daimonface.mjs --break fold-drift   # 2 fails: Fold goes back to the daimon
//   node dev/verify_daimonface.mjs --break crosstalk    # 3a fails: a reply lands in another thread
//   node dev/verify_daimonface.mjs --break mute         # 3b fails: nothing streams into its own
//   node dev/verify_daimonface.mjs --break dead-compare # 4a+4b fail: a face nothing enters
//   node dev/verify_daimonface.mjs --break ghost-face   # 4c fails: a face documented and unreachable
//   node dev/verify_daimonface.mjs --break side-assign  # 4d+4e fail: `centreMode` written elsewhere
//   node dev/verify_daimonface.mjs --break indirect-compare  # 4e fails: the comparison hides
//   node dev/verify_daimonface.mjs --break unhelped     # NOTHING fails, and that is the point
//   node dev/verify_daimonface.mjs                      # and then, clean
//
// WHAT THE FOURTH CHECK STILL CANNOT SEE, attacked and confirmed rather than guessed at:
//
//   * A face entered ONLY from code that never runs — `if (false) showCentre('stage');` —
//     counts as entered, so 4b and 4c are satisfied by a face nothing reaches. Reading the
//     source cannot tell a live call from a dead one, and this file does not pretend to.
//   * The comment stripper knows strings but not REGEX LITERALS, so a regex containing a lone
//     quote (`/['"]/`) desynchronises it and can swallow the code after it. Nothing in the
//     file does that today and 4e's residue scan would notice the loss of a whole comparison,
//     but a regex is where this breaks first, and that is where to look.
//   * It is a scan of one file. `centreMode` is a closure variable and no other file can see
//     it, which is the only reason that is enough.
//
// `crosstalk` and `mute` are two breaks and not one because the guard has TWO ways to be
// wrong and a check for either alone passes while the other is broken: `mute` makes it always
// false, so nothing is ever drawn live and no thread is ever polluted; `crosstalk` makes it
// forget WHICH thread, so every thread on screen is drawn into and the right one is drawn
// into too. A single check would have been green under one of them.
//
// `unhelped` is the odd one and is not a break at all: it restores the raw compound conditions
// the one helper replaced. It MUST leave every check green, which is how this file says that
// collapsing the copies into `daimonOnScreen` was a refactor and not a change of behaviour. Red
// there is a failure of the refactor, and the run says so. It covers TWO sites and not three:
// `syncFoldBtn` no longer asks which face is up at all, since a daimon's record is `current` on
// both of a Diamond's faces and `diamondId` therefore answers for both.
//
// THE HARNESS. Use a world, or the run silently drives world 0 on :8777 and says nothing:
//
//   eval "$(bash dev/world.sh 3 --env)" && node dev/verify_daimonface.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, steerDiamond, newChat } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const SRC  = 'js/daimond.js';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Every break names its sites. A break may name several, and every one of them has to land:
// an anchor that no longer matches is a break that quietly stopped applying, and a green run
// under it proves nothing at all.
const BREAKS = {
	// The repaint after "Fresh daimon" simply never runs. The record still clears — which is
	// the point of asserting on what is DRAWN rather than on what is stored.
	'no-redraw': {
		find: "			if (daimonOnScreen(rec)) {\n				await selectDiamond(f, 'chat');",
		with: "			if (false) {\n				await selectDiamond(f, 'chat');",
	},
	// THE OLD CONDITION, restored: Fold drawn on the daimon's face and on no other. It is a
	// real comparison against a real face, so every static check stays green and only the
	// control checks move — which is the point, because for months this was the shipped
	// behaviour and nothing in this file objected. It must redden 2a (the control is back on
	// the face that cannot use it) and 2c (it is gone from the one that can).
	'fold-drift': {
		find: "		b.style.display = (current && !current.diamondId && chatSaid(current)) ? '' : 'none';",
		with: "		b.style.display = (daimonOnScreen(current) && current.diamondId) ? '' : 'none';",
	},
	// The guard forgets WHICH conversation and remembers only that some conversation is up.
	crosstalk: {
		find: "		var onScreen = function () { return daimonOnScreen(rec); };",
		with: "		var onScreen = function () { return !!(current && centreMode === 'daimon'); };",
	},
	// The tombstones come off, so the union puts the conversation straight back. The SCREEN
	// still clears, which is what made this so hard to see: every check that watches the
	// thread stays green and only the store, and a reload, know anything happened.
	resurrect: {
		find: "			msgTombstone((rec.messages || []).map(function (m) { return m.mid; }));\n",
		with: "",
	},
	// The model's own conversation goes back to `null` — "this tab does not know" — which
	// `persistChats` fills in from the store. Invisible on screen: the thread is empty and the
	// next turn quietly carries the whole discarded conversation to the model, and is billed
	// for it.
	sessionless: {
		find: "			rec.session = { v: 1, msgs: [], upto: '', uptoTs: 0 };",
		with: "			rec.session = null;",
	},
	// The refusal comes off, so a clear can be taken mid-turn and undone by the turn.
	'clear-midturn': {
		find: "			if (rec._generating) {\n				await noticeDialog(t('tile.daimon_reset_busy_title'), t('tile.daimon_reset_busy'));\n				return;\n			}",
		with: "			if (false) { return; }",
	},
	// The guard is always false — the state the whole file was mistakenly believed to be in.
	mute: {
		find: "		var onScreen = function () { return daimonOnScreen(rec); };",
		with: "		var onScreen = function () { return false; };",
	},
	// A comparison against a face nothing ever enters: the dead branch, in its natural form —
	// somebody writing the DIAMOND view's word ('crystal') where the CENTRE's word ('focus')
	// belongs. Deliberately placed at a site none of the three behaviour checks measures, so
	// it proves the static check and not one of them.
	'dead-compare': {
		find: "		toast(centreMode === 'focus'",
		with: "		toast(centreMode === 'crystal'",
	},
	// A face in the list that nothing enters: a promise the app does not keep.
	'ghost-face': {
		find: "	var CENTRE_FACES = ['chat', 'focus', 'daimon'];",
		with: "	var CENTRE_FACES = ['chat', 'focus', 'daimon', 'stage'];",
	},
	// A second writer for `centreMode`, which makes every reading above unsound: the set of
	// faces the app can be in is no longer the set `showCentre` sanctions. Behaviour here is
	// unchanged, which is exactly why nothing but the static check can see it.
	'side-assign': {
		find: "			showCentre('daimon');\n			renderHistory(rec.messages);",
		with: "			centreMode = 'daimon';\n			showCentre('daimon');\n			renderHistory(rec.messages);",
	},
	// The comparison goes through a variable, so the scan for literal comparisons stops seeing
	// it. Nothing about the app changes except that one face is now compared against a name --
	// and 4a and 4b go green on a set one face SMALLER without a word about the one that left.
	// This is the original defect wearing a disguise, and 4e is what strips it.
	'indirect-compare': {
		find: "		return !!(rec && current && current.id === rec.id && centreMode === 'daimon');",
		with: "		var face = 'daimon';\n		return !!(rec && current && current.id === rec.id && centreMode === face);",
	},
	// Not a break: the three raw conditions the helper replaced, restored. Everything must
	// stay green.
	unhelped: [
		{
			find: "			if (daimonOnScreen(rec)) {",
			with: "			if (currentDiamond && currentDiamond.id === id && centreMode === 'daimon') {",
		},
		{
			find: "		var onScreen = function () { return daimonOnScreen(rec); };",
			with: "		var onScreen = function () {\n			return !!(current && rec && current.id === rec.id && centreMode === 'daimon');\n		};",
		},
	],
};
// The one that must stay green. Named here rather than tested by string, so adding another
// equivalence break is one line and not a scattered special case.
const MUST_STAY_GREEN = new Set(['unhelped']);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The source under test, broken or not ────────────────────────────────
//
// The STATIC checks below read this string and not the file on disk, so a break that is a
// static regression really does turn its check red.
let source = fs.readFileSync(path.join(WWW, SRC), 'utf8');
if (BREAK) {
	const spec = BREAKS[BREAK];
	if (!spec) { console.error(`no such break: ${BREAK}`); process.exit(2); }
	for (const site of (Array.isArray(spec) ? spec : [spec])) {
		const n = source.split(site.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${SRC}, so nothing `
				+ 'was broken and the run below would prove nothing. The file has moved on; '
				+ 'move the anchor with it.\n  ' + site.find.split('\n')[0].trim());
			process.exit(2);
		}
		source = source.replace(site.find, site.with);
	}
}

// ── 4. The regression check: one set of faces, agreed on from three directions ──
//
// COMMENTS ARE STRIPPED FIRST, and they have to be: the declaration of `CENTRE_FACES` carries
// a paragraph about the day this went wrong, and that paragraph quotes `centreMode ===
// 'daimon'`. Scanned raw, the check reads its own explanation as code. This is a line-and-block
// stripper that respects quotes; it does not understand regex literals, which is stated rather
// than hidden — `centreMode` never appears in one, and if it ever does, this comment is the
// place the next reader will look.
function stripComments(s) {
	let out = '', i = 0, n = s.length;
	while (i < n) {
		const c = s[i], d = s[i + 1];
		if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; continue; }
		if (c === '/' && d === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
		if (c === '"' || c === "'" || c === '`') {
			out += c; i++;
			while (i < n && s[i] !== c) { if (s[i] === '\\') { out += s[i]; i++; } out += s[i]; i++; }
			out += s[i]; i++; continue;
		}
		out += c; i++;
	}
	return out;
}
const code = stripComments(source);

// What the file says the faces are.
const facesDecl = /var CENTRE_FACES = \[([^\]]*)\];/.exec(code);
const documented = facesDecl
	? [...facesDecl[1].matchAll(/'([^']*)'/g)].map(m => m[1])
	: [];
check('the faces are declared in one place the checks can read',
	documented.length > 0, documented.join(', ') || '(CENTRE_FACES not found)');

// What anything actually enters. Every call must pass a literal, or none of this is sound:
// a computed face would mean the set cannot be read from the source at all.
const calls = [...code.matchAll(/(?<!function )showCentre\(([^)]*)\)/g)]
	.map(m => m[1].trim())
	.filter(a => a !== 'mode');
const nonLiteral = calls.filter(a => !/^'[^']*'$/.test(a));
check('4d. EVERY `showCentre` CALL NAMES A FACE OUTRIGHT, so the set can be read at all',
	nonLiteral.length === 0, nonLiteral.join(' | ') || `${calls.length} calls, all literal`);
const entered = [...new Set(calls.filter(a => /^'[^']*'$/.test(a)).map(a => a.slice(1, -1)))];

// What anything compares against.
const compared = [...new Set([...code.matchAll(/centreMode\s*[=!]==\s*'([^']*)'/g)].map(m => m[1]))];
check('the checks found real comparisons to judge', compared.length > 0, compared.join(', '));

// 4a. Nothing compares against a face the list does not name.
const undocumented = compared.filter(v => documented.indexOf(v) < 0);
check('4a. NOTHING COMPARES `centreMode` AGAINST A FACE THE LIST DOES NOT NAME',
	undocumented.length === 0,
	undocumented.length ? 'stray: ' + undocumented.join(', ') : compared.join(', '));

// 4b. Nothing compares against a face nothing enters. THIS is the dead branch, and it is the
// one that hid here for months: a guard that can never be true, guarding a real feature.
const unreachable = compared.filter(v => entered.indexOf(v) < 0);
check('4b. NOTHING COMPARES AGAINST A FACE NOTHING EVER ENTERS (the dead branch)',
	unreachable.length === 0,
	unreachable.length ? 'dead: ' + unreachable.join(', ') : 'entered: ' + entered.join(', '));

// 4c. Nothing is documented that cannot be entered.
const promised = documented.filter(v => entered.indexOf(v) < 0);
check('4c. EVERY DOCUMENTED FACE IS ONE SOMETHING ENTERS',
	promised.length === 0,
	promised.length ? 'never entered: ' + promised.join(', ') : documented.join(', '));

// 4d. `centreMode` is written in exactly two places: its declaration, and `showCentre`, which
// refuses a face the list does not name. A third writer makes every reading above unsound.
const writes = [...code.matchAll(/centreMode\s*=\s*([^=][^;]*);/g)].map(m => m[1].trim());
check('4d. `centreMode` IS WRITTEN ONLY BY ITS DECLARATION AND BY `showCentre`',
	writes.length === 2 && writes[0] === "'chat'" && writes[1] === 'mode',
	writes.join(' | '));
check('and `showCentre` refuses a face the list does not name',
	/CENTRE_FACES\.indexOf\(mode\) < 0/.test(code), 'the guard is in showCentre');

// 4e. EVERY USE OF THE NAME IS ONE OF THREE SHAPES. Without this, 4a and 4b are read straight
// past by `var face = 'stage'; if (centreMode === face)` and by `switch (centreMode)`: the
// comparison simply stops being visible, and the checks above go green on a SMALLER set than
// before while saying nothing about what left it — which is the original defect exactly,
// reintroduced under the check written to catch it. Attacked and confirmed. So the file is
// allowed only the declaration, `showCentre`'s own write, and comparison against a literal.
const residue = code
	.replace(/var centreMode = '[^']*';/g, '')
	.replace(/centreMode\s*=\s*mode;/g, '')
	.replace(/centreMode\s*[=!]==\s*'[^']*'/g, '');
const stray = [...residue.matchAll(/.{0,34}\bcentreMode\b.{0,34}/g)]
	.map(m => m[0].replace(/\s+/g, ' ').trim());
check('4e. `centreMode` IS ONLY DECLARED, SET BY `showCentre`, OR COMPARED TO A LITERAL FACE',
	stray.length === 0, stray.join('  ¦  ') || 'no other use of the name');

// ── The browser half ────────────────────────────────────────────────────
const APP = process.env.DAIMOND_APP || 'http://localhost:8777';
console.log(`\ndriving ${APP}${process.env.DAIMOND_APP ? '' : '  (NO WORLD SET — this is world 0)'}\n`);

const s = await open({
	name: 'daimonface', defaults: false,
	route: BREAK ? async (page) => {
		await page.route('**/' + SRC, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body: source,
		}));
	} : null,
});
const { page } = s;

/// What the Centre is actually drawing, read the way a reader sees it.
const drawn = () => page.evaluate(() => {
	const co = document.getElementById('chat-output');
	const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
	const fold = document.getElementById('chat-fold-btn');
	return {
		users:  co ? [...co.querySelectorAll('.chat-msg-user')].map(e => (e.textContent || '').trim()) : [],
		empty:  !!(co && co.querySelector('.chat-msg-empty')),
		text:   co ? (co.textContent || '').replace(/\s+/g, ' ') : '',
		fold:   vis(fold),
	};
});

/// Open a Diamond by name, on the face asked for.
async function openDiamond(name, face) {
	await page.evaluate((n) => {
		const box = [...document.querySelectorAll('.diamond-box')]
			.find(b => (b.textContent || '').indexOf(n) >= 0);
		if (!box) throw new Error('no Diamond named ' + n);
		box.click();
	}, name);
	await page.waitForTimeout(900);
	await page.click('#dview-' + face, { force: true });
	await page.waitForTimeout(900);
}

async function makeDiamond(name) {
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(1800);
}

/// Press "Fresh daimon" on a Diamond's cog dialog and answer the confirm.
///
/// The confirm's OK is scoped to the dialog that is NOT the tile's own, because the tile
/// dialog's Delete at the foot is also a `.dlg-ok` and sits earlier in the document. An
/// unscoped `.dlg-ok` deletes the Diamond, which reads exactly like a thread that cleared
/// itself — it cost this file an hour to notice.
async function freshDaimon(name) {
	await page.evaluate((n) => {
		const box = [...document.querySelectorAll('.diamond-box')]
			.find(b => (b.textContent || '').indexOf(n) >= 0);
		box.querySelector('.tile-cog').click();
	}, name);
	await page.waitForTimeout(800);
	const found = await page.evaluate(() => {
		const b = [...document.querySelectorAll('.tile-dlg-clear')]
			.find(e => /fresh daimon/i.test(e.textContent || ''));
		if (!b) return false;
		b.click();
		return true;
	});
	if (!found) throw new Error('no "Fresh daimon" control in the cog dialog');
	await page.waitForTimeout(700);
	const confirmed = await page.evaluate(() => {
		const b = document.querySelector('.dlg-card:not(.tile-dlg-card) .dlg-ok');
		if (!b) return false;
		b.click();
		return true;
	});
	if (!confirmed) throw new Error('the Fresh daimon confirm never appeared');
	await page.waitForTimeout(1400);
	// Out of the cog dialog, so what is asserted below is what a reader would be looking at.
	await page.evaluate(() => {
		const x = document.querySelector('.tile-dlg-card .tile-dlg-done');
		if (x) x.click();
	});
	await page.waitForTimeout(600);
}

try {
	await makeDiamond('Alpha');
	await makeDiamond('Beta');

	// ── 2. Fold belongs to the conversation a hand fold can reach.
	//
	// Two of these say "not here" and one says "here". A file with only the refusals would be
	// green against a Fold button that had been deleted, and a file with only the assertion
	// would be green against one drawn on every face at once — so the positive and the two
	// negatives are all three of them load-bearing.
	//
	// EVERY READING IS A BOUNDING RECTANGLE (`drawn`'s `vis`), never a computed `display`.
	// `display: none` does not cascade: a child of a hidden parent computes its own `display`
	// perfectly happily and reports itself visible.
	await openDiamond('Alpha', 'chat');
	await steerDiamond(s, 'hello alpha');
	await page.waitForTimeout(4000);
	// RE-DRAWN FROM THE RECORD before anything is read off it. Taken straight after the turn,
	// this snapshot would be the LIVE stream's work, and the control check below would then go
	// red under `mute` — which is check 3b's break, not this one's. A control that fails for
	// another check's reason stops being a control.
	await openDiamond('Alpha', 'chat');
	const onChat = await drawn();
	check('2a. FOLD IS OFF THE DAIMON FACE, the one conversation a hand fold cannot reach',
		onChat.fold === false, 'visible:' + onChat.fold);
	// The control beside it: the thread really has something in it, so 2a is a REFUSAL and not
	// a button hidden for want of a conversation. It also makes check 1's "empty" below a
	// change and not the state it started in.
	check('the daimon really said something, so 2a is a refusal and not an empty thread',
		onChat.users.length === 1 && /hello alpha/.test(onChat.users[0] || ''),
		JSON.stringify(onChat.users));

	await page.click('#dview-crystal', { force: true });
	await page.waitForTimeout(900);
	const onCrystal = await drawn();
	check('2b. AND OFF THE CRYSTAL FACE, which shows no conversation at all',
		onCrystal.fold === false, 'visible:' + onCrystal.fold);

	// ── 2c/2d. And ON an ordinary chat, once there is something in it.
	//
	// The chat is made first and measured EMPTY, because "shown on a chat" and "shown on a
	// chat with something in it" are two different claims and only the second one is the
	// app's. A fold offered on an empty thread is the same dead control this check is about,
	// one surface along.
	await newChat(s);
	await page.waitForTimeout(600);
	const fresh = await drawn();
	check('2d. AND OFF A CHAT NOBODY HAS SAID ANYTHING IN, which has nothing to fold',
		fresh.fold === false, 'visible:' + fresh.fold);
	await page.fill('#chat-input', 'hello chat');
	await page.click('#chat-send', { force: true });
	// The user's turn is on the record before the reply is, and that is what makes the
	// control live: `runTurn` pushes and persists first, then syncs the composer.
	await page.waitForTimeout(2500);
	const onOrdinary = await drawn();
	check('2c. FOLD IS ON AN ORDINARY CHAT WITH SOMETHING IN IT, which is the fold that works',
		onOrdinary.fold === true, 'visible:' + onOrdinary.fold);
	check('and that chat really has something in it, so 2c is not a control drawn over nothing',
		onOrdinary.users.length >= 1 && /hello chat/.test(onOrdinary.text),
		JSON.stringify(onOrdinary.users));
	// Let the turn finish before the Diamond work below, so a reply still streaming cannot
	// land in a thread check 1 or check 3 is about to read.
	await page.waitForSelector('.chat-spinner', { state: 'detached', timeout: 30000 }).catch(() => {});
	await page.waitForTimeout(500);
	await openDiamond('Alpha', 'chat');
	await page.waitForTimeout(600);

	// ── 1. "Fresh daimon" clears WHAT IS DRAWN, not merely what is stored.
	await freshDaimon('Alpha');
	const after = await drawn();
	check('1a. FRESH DAIMON EMPTIES THE THREAD ON SCREEN',
		after.users.length === 0 && !/hello alpha/.test(after.text),
		JSON.stringify(after.users).slice(0, 80));
	check('and the emptied thread says so rather than going blank',
		after.empty === true, after.text.slice(0, 60));
	// ── 1b. AND IT STAYS CLEARED. The screen and the store are two different claims, and this
	//        is the one that was false: `persistChats` UNIONS a transcript with the stored copy,
	//        so emptying the array and saving put every message back. Nothing on screen could
	//        see it, because the screen had already been repainted from the emptied array.
	const stored = () => page.evaluate(() => new Promise((res) => {
		const r = indexedDB.open('daimond-chats', 1);
		r.onsuccess = () => {
			const db = r.result;
			let t; try { t = db.transaction('chats', 'readonly'); } catch (e) { return res(null); }
			const a = t.objectStore('chats').getAll();
			a.onsuccess = () => {
				const d = (a.result || []).filter(c => c.diamondId);
				res({
					msgs: d.reduce((n, c) => Math.max(n, (c.messages || []).length), 0),
					sess: d.reduce((n, c) => Math.max(n, ((c.session || {}).msgs || []).length), 0),
				});
			};
			a.onerror = () => res(null);
		};
		r.onerror = () => res(null);
	}));
	const st = await stored();
	check('1b. THE TRANSCRIPT IS GONE FROM THE STORE TOO, not only from the screen',
		!!st && st.msgs === 0, 'longest stored daimon transcript: ' + ((st || {}).msgs));
	// The half the dialog's own comment calls the one that matters: `session.msgs` is what goes
	// to the model on the next turn, and it is invisible from the screen either way.
	check('1c. AND SO IS THE CONVERSATION THE MODEL HOLDS, which the next turn would carry',
		!!st && st.sess === 0, 'stored session length: ' + ((st || {}).sess));

	// Read the way the owner read it: come back tomorrow and see whether it is still gone.
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'daimonface');
	await page.waitForTimeout(1500);
	await openDiamond('Alpha', 'chat');
	const reloaded = await drawn();
	check('1d. AND IT IS STILL GONE AFTER A RELOAD, which is what "start fresh" means',
		reloaded.users.length === 0 && !/hello alpha/.test(reloaded.text),
		JSON.stringify(reloaded.users).slice(0, 80));

	// ── 1e. WHAT FALLS BETWEEN CHECK 1 AND CHECK 3, which neither can see on its own.
	//
	// Check 1 clears with nothing running. Check 3 runs a turn with nothing cleared. Between
	// them sits the clear taken WHILE a turn is in flight, and it was real: the reply and the
	// model's whole conversation are written back into the record when the turn ends, by
	// reference, so the clear was undone a few seconds later and the reader was left with half
	// an answer to a question that was no longer there. Two checks, each right, one gap.
	await page.fill('#chat-input', '@long 40');
	await page.click('#chat-send', { force: true });
	await page.waitForTimeout(1500);
	const refused = await page.evaluate(() => {
		const box = [...document.querySelectorAll('.diamond-box')]
			.find(b => (b.textContent || '').indexOf('Alpha') >= 0);
		box.querySelector('.tile-cog').click();
		return true;
	}) && await page.waitForTimeout(700).then(async () => {
		const pressed = await page.evaluate(() => {
			const b = [...document.querySelectorAll('.tile-dlg-clear')]
				.find(e => /fresh daimon/i.test(e.textContent || ''));
			if (!b) return 'no control';
			b.click();
			return 'pressed';
		});
		await page.waitForTimeout(700);
		// A NOTICE and not a confirm: nothing is discarded, and the way to discard is named.
		return await page.evaluate((p) => {
			const dlg = document.querySelector('.dlg-card:not(.tile-dlg-card)');
			return { pressed: p, dialog: dlg ? (dlg.textContent || '').replace(/\s+/g, ' ') : '' };
		}, pressed);
	});
	check('1e. A CLEAR IS REFUSED MID-TURN rather than undone by the turn a moment later',
		/still working/i.test(refused.dialog),
		refused.pressed + ': ' + (refused.dialog || '(no dialog)').slice(0, 70));
	// Out of both dialogs, and let the turn finish, so what follows starts from a known place.
	await page.evaluate(() => {
		const n = document.querySelector('.dlg-card:not(.tile-dlg-card) .dlg-ok');
		if (n) n.click();
	});
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		const x = document.querySelector('.tile-dlg-card .tile-dlg-done');
		if (x) x.click();
	});
	// The dots are the app's own answer to "is a turn still running", so they are what is
	// waited on rather than a number of seconds somebody guessed.
	await page.waitForSelector('.chat-spinner', { state: 'detached', timeout: 30000 });
	await page.waitForTimeout(800);
	// Cleared again, now that it is allowed — so check 3 below starts from an empty thread and
	// its `chunk-` evidence is this turn's and not the one just run.
	await freshDaimon('Alpha');
	await openDiamond('Alpha', 'chat');
	const cleared2 = await drawn();
	check('and the clear works once the turn is over, which is what the refusal promised',
		cleared2.users.length === 0 && !/chunk-/.test(cleared2.text),
		JSON.stringify(cleared2.users) + ' chunks:' + /chunk-/.test(cleared2.text));

	// ── 3. A reply streams into ITS OWN thread, and into no other.
	await page.fill('#chat-input', '@long 40');
	await page.click('#chat-send', { force: true });
	await page.waitForTimeout(1600);
	const mid = await drawn();
	check('3b. A REPLY STREAMS INTO ITS OWN THREAD WHILE IT ARRIVES',
		/chunk-/.test(mid.text), mid.text.slice(-60));

	// Away, mid-turn, to another Diamond's conversation — the gather-round shape, reached the
	// way a reader reaches it.
	await openDiamond('Beta', 'chat');
	await page.waitForTimeout(2500);
	const beta = await drawn();
	check('3a. AND INTO NO OTHER THREAD, when the reader has moved on mid-turn',
		!/chunk-/.test(beta.text) && beta.users.length === 0,
		"Alpha's words in Beta's thread: " + (/chunk-/.test(beta.text) ? 'YES' : 'no')
			+ ', user turns drawn: ' + beta.users.length);

	// And it was not lost by being undrawn: back on Alpha, the whole reply is there.
	await page.waitForTimeout(4000);
	await openDiamond('Alpha', 'chat');
	const back = await drawn();
	check('and the reply was kept, so "drawn nowhere" never meant "thrown away"',
		/chunk-40/.test(back.text), back.text.slice(-70));

} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
} finally {
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK && MUST_STAY_GREEN.has(BREAK)) {
	console.log(bad.length
		? `\n'${BREAK}' IS NOT A BREAK: it restores the conditions the helper replaced and must `
			+ 'change nothing. Something failed, so the helper is not the refactor it claims to be.'
		: `\n'${BREAK}' changed nothing, which is what it is for: the helper says the same thing `
			+ 'the raw conditions said.');
	process.exit(bad.length ? 1 : 0);
}
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
