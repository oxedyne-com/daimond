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
// A FIRST ATTEMPT FIXED 1 AND 3 AND LEFT THE ASKING EXACTLY WHERE IT WAS, which
// the same reporter said in the same words a day later: "I thought we got rid of
// this bullshit!" The answer lived on the chat's engine object, built per chat and
// gone on reload, so it had to be given again in every new chat and after every
// refresh -- and it was only ever given by somebody who had gone into the menu
// looking for it. It was made answerable, not answered. The standing choice is
// what actually removes the interruption, and check 7 is the one that proves it.
//
// NINE PROPERTIES:
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
//   6. THE SECTION IS NOT A FOURTH RUNG. Still exactly three radios in the ladder,
//      with the network under a head of its own -- the rungs are one policy for the
//      whole app and this is one answer, and giving it the ladder's shape would say
//      the two were the same kind of thing.
//   7. AND A CHAT THAT DID NOT EXIST WHEN YOU ANSWERED IS NOT ASKED. This is the
//      property the whole thing is for. Measured at the engine, because
//      `NetStep::Ask` is the only branch that raises a dialog: a NEW chat that
//      reports `allowed` while marked has had the question answered before it could
//      be put. Watching for a dialog instead would also pass on a chat that simply
//      never got as far as a command.
//   8. AND THE DIALOG CAN END THE ASKING IN ONE GESTURE -- a TICK the person makes,
//      clicked on the card that is actually up.
//   9. WHILE A YES NOBODY TICKED CHANGES NOTHING ELSE. Added 2026-08-28, and it is
//      the one that matters most. Until then ANY yes here called
//      `setStandingNet('allow')`, which writes the app-wide standing answer and
//      pushes `allow` into every engine that exists. A NO said in one chat was
//      silently overwritten by a YES said in another about a DIFFERENT command:
//      the first chat's next command reached the network, nobody was asked, and the
//      permissions button read "Always" -- a setting the user never chose, standing
//      through every reload. The reasoning in the code argued that only a yes should
//      become standing because refusing once is not refusing for ever, which is true
//      and points the wrong way: the direction being made permanent and global was
//      the PERMISSIVE one. `src/tools.rs` says of `override_net_consent`, where that
//      path ends, that NOTHING IN THE TOOL LOOP MAY CALL IT.
//
// PROVED AGAINST BROKEN CODE FIRST, each break chosen to survive every check but
// the ones under test:
//
//   node dev/verify_netchip.mjs --break generic  # 1-2: the hover names the category again
//   node dev/verify_netchip.mjs --break nomark   # 3, 5: a cut chat looks like a clean one
//   node dev/verify_netchip.mjs --break stuck    # 4-5: the choice is stored and never applied
//   node dev/verify_netchip.mjs --break perchat  # 7:   the answer dies with the chat
//   node dev/verify_netchip.mjs --break nosection# 8 checks, crudely
//   node dev/verify_netchip.mjs --break stickyyes# 9:   every yes becomes standing again
//   node dev/verify_netchip.mjs --break notick   # 8-9: no control to press at all
//   node dev/verify_netchip.mjs --break yesnotsticky # 8: the tick is drawn and does nothing
//   node dev/verify_netchip.mjs --break deafnote # 10:   a command with no network says nothing
//   node dev/verify_netchip.mjs                  # and then, clean
//
// `perchat` is the SHARP one: it restores the reported defect exactly -- the
// standing answer stored, applied to the engines that exist, and never handed to
// the next one -- and it reddens check 7 and NOTHING ELSE. Every check before it
// passes, because everything before it was working the day the defect was
// reported. That is what makes 7 a test of its own and not a rider on the others.
//
// `stickyyes` is the SHARPEST, and it is sharp in the other direction: it restores
// the consent defect exactly -- every yes made standing, whatever the box says --
// and reddens check 9 and nothing else. Everything before it passes, because
// everything before it is a property the standing answer is supposed to have and
// still has. A defect that leaves every existing check green is what this file is
// for; the previous one sat here for a week.
//
// `stuck` is its sibling one layer up: the choice recorded and never pushed into
// any engine. A Rust break exists for the write-once rule that sits under both --
// `override_net_consent` folded back into `set_net_consent` -- which no served file
// can reach; it is held by `test_the_user_can_take_an_answer_back_though_the_
// dialog_cannot`, run against that exact edit and red on "a no could not be taken
// back".
//
// `nosection` is the crude one: eight checks at once, so it proves nothing about
// any check after the first. It is kept because the section being absent is a real
// way this can break, not because it tests anything sharply.
//
// THE MARK IS SET DIRECTLY, through `DaimondCore.markRead`. It is the same one-way
// flag every real path ends at, so the STATE under test is the real state; which
// reads produce it is a Rust question and is answered there.
//
// AND THE STANDING CHOICE IS ARMED OUTRIGHT at the start. It is `localStorage` and
// the harness reuses its profile, so a run that ended on "always allow" left the
// next one starting there -- which duly failed checks 3 and 4 against an app that
// was working perfectly. A probe that assumes its starting state measures the last
// run.
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
	// The standing answer stored but never pushed into an engine -- which is what
	// "I granted it and it asked me again" actually looks like in code.
	stuck: {
		file: 'js/handmode.js',
		find: "\t\tif (typeof cfg.netApplyAll === 'function') {",
		with: "\t\tif (false) {",
	},
	// The dialog's yes answering this chat's engine and nothing else -- exactly
	// what it did through three reports. The tick is on screen and does nothing.
	yesnotsticky: {
		file: 'js/daimond.js',
		find: "\t\t\tif (netStanding && window.DaimondHandMode && DaimondHandMode.setStandingNet) {",
		with: "\t\t\tif (false) {",
	},
	// THE SHARP ONE FOR CHECK 9, and the defect it restores is the worst this file
	// has held: EVERY yes becomes the app-wide standing answer, whatever the box
	// says. That is what the code did until 2026-08-28 -- `setStandingNet('allow')`
	// on any yes, which writes `daimond-net-standing` AND pushes `allow` into every
	// engine that exists (`netApplyAll`). A no said in one chat was overwritten by a
	// yes said in another about a different command, with nothing on screen to say
	// so. It reddens 9 and NOTHING ELSE: everything before it is a property the
	// standing answer is supposed to have, and it still has them.
	stickyyes: {
		file: 'js/daimond.js',
		find: "\t\t\tnetStanding = !!netAns.standing;",
		with: "\t\t\tnetStanding = true;",
	},
	// And the other way: no control at all, so "one yes is enough" has no way to be
	// said. Reddens 8, and 9's first check with it.
	notick: {
		file: 'js/daimond.js',
		find: "\t\t\t\t\trow.appendChild(box);",
		with: "\t\t\t\t\tif (false) row.appendChild(box);",
	},
	// Stored, applied to the engines that exist, and forgotten by the next one. The
	// exact defect reported: an answer whose lifetime is one chat.
	perchat: {
		file: 'js/daimond.js',
		find: "\t\t\tvar st = window.DaimondHandMode ? DaimondHandMode.standingNet() : '';",
		with: "\t\t\tvar st = '';",
	},
	// The line saying a command had no network, drawn from a result that says it
	// had none. Nothing else in this file touches that block, so it reddens 9 and
	// only 9.
	deafnote: {
		file: 'js/daimond.js',
		find: "\t\t\treturn !!(Wasm && Wasm.ran_without_net",
		with: "\t\t\treturn false && !!(Wasm && Wasm.ran_without_net",
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
	const opts  = [...pop.querySelectorAll('.net-opt')];
	return {
		heads,
		rungs:   pop.querySelectorAll('.mode-row input[type=radio]').length,
		now:     now ? now.textContent.trim() : '',
		btn:     opts.map(e => e.textContent.trim()).join(' | '),
		hasBtn:  opts.length === 3,
		chosen:  (opts.find(e => e.getAttribute('aria-pressed') === 'true') || {}).textContent || '',
		marked:  chip.classList.contains('net-cut'),
		title:   chip.title || '',
		aria:    chip.getAttribute('aria-label') || '',
		engine:  (window.DaimondCore && DaimondCore.netState) ? DaimondCore.netState() : '',
	};
});

try {
	// ARM THE DEFAULT OUTRIGHT. The standing answer is `localStorage` and the
	// harness reuses its profile, so a previous run that ended on "always allow"
	// left this one starting there -- and checks 3 and 4 duly failed against a chat
	// that was working correctly. A probe that assumes its starting state is a probe
	// measuring the last run.
	// No reload needed: `standing()` reads the key on every call, and no chat engine
	// exists yet to be carrying an older answer.
	await p.evaluate(() => { try { localStorage.removeItem('daimond-net-standing'); } catch (e) {} });

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
	// Against the app's own string: the head was reworded once already, and a
	// literal from the old copy would have made this check unable to fail.
	const netHead = await p.evaluate(() => DaimondI18n.t('permmode.net_head'));
	check(!!netHead && clean.heads.includes(netHead),
		'THE POPOVER HAS A SECTION FOR THE NETWORK', JSON.stringify(clean.heads));
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
		'and the section says it in a sentence, with all three ways out beside it',
		`${JSON.stringify(cut.now.slice(0, 70))} choices=${JSON.stringify(cut.btn)}`);

	// ── 4. Granting it moves the ENGINE ──────────────────────────
	const pick = async (label) => {
		await p.evaluate((l) => {
			const b = [...document.querySelectorAll('#hand-mode-pop .net-opt')]
				.find(x => x.textContent.trim() === l);
			if (b) b.click();
		}, label);
		await p.waitForTimeout(500);
	};
	const ALWAYS = await p.evaluate(() => DaimondI18n.t('permmode.net_always'));
	const EACH   = await p.evaluate(() => DaimondI18n.t('permmode.net_each'));
	const NEVER  = await p.evaluate(() => DaimondI18n.t('permmode.net_never'));
	await pick(ALWAYS);
	const on = await readPop();
	check(on.engine === 'allowed',
		'GRANTING IT MOVES THE ENGINE, not merely the label that was pressed',
		`engine=${on.engine}`);
	check(!on.marked,
		'and the button stops saying the network is gone', `net-cut=${on.marked}`);

	// ── 5. And it can be taken back ──────────────────────────────
	await pick(NEVER);
	const off = await readPop();
	check(off.engine === 'refused',
		'AND IT CAN BE TAKEN BACK — the thing that was impossible',
		`engine=${off.engine}`);
	check(off.marked,
		'with the button marked again, so the two never disagree',
		`net-cut=${off.marked}`);
	// The default is reachable again, which a two-state toggle would have lost.
	await pick(EACH);
	const back = await readPop();
	check(back.engine === 'cut',
		'and "ask once per chat" is still reachable, so nothing is a one-way door',
		`engine=${back.engine}`);
	await popClose();

	// ── 7. THE ONE THAT MATTERS: a NEW chat is not asked again ───
	//
	// The reported defect, in the reporter's words: "I thought we got rid of this
	// bullshit!" It had not been got rid of. The answer lived on the chat's engine,
	// which is built per chat and does not survive a reload, so every new chat put
	// the question again however many times it had been answered.
	//
	// Measured at the ENGINE and not by watching for a dialog, because `NetStep::Ask`
	// is the only branch that raises one: a chat that reports `allowed` while marked
	// has had the question answered before it could be put. A dialog watcher would
	// also pass on a chat that simply never ran a command.
	await popOpen();
	await pick(ALWAYS);
	await popClose();
	await newChat(s);
	await p.fill('#chat-input', '@text a brand new chat');
	await p.click('#chat-send');
	await p.waitForTimeout(3500);
	await p.evaluate(() => DaimondCore.markRead());
	await p.fill('#chat-input', '@text and it reads something');
	await p.click('#chat-send');
	await p.waitForTimeout(3500);
	const fresh = await p.evaluate(() => ({
		engine: DaimondCore.netState(),
		marked: document.getElementById('hand-mode-chip').classList.contains('net-cut'),
		dialog: !![...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).length,
	}));
	check(fresh.engine === 'allowed',
		'A CHAT THAT NEVER EXISTED WHEN YOU ANSWERED IS NOT ASKED AGAIN',
		`engine=${fresh.engine}`);
	check(!fresh.marked && !fresh.dialog,
		'and nothing on screen interrupts it',
		`net-cut=${fresh.marked}, dialog=${fresh.dialog}`);

	// ── 8. A YES *THE USER MAKES STANDING* IS THE LAST ONE ───────
	//
	// The standing choice above is only reachable by somebody who went looking for
	// it in a menu. Nobody did: three reports came from a person answering the
	// DIALOG, whose yes went to the chat's own engine and died with it. A person who
	// has said yes has consented, and asking again in the next chat treats that
	// answer as though it had never been given.
	//
	// SO THE DIALOG STILL ENDS IT IN ONE GESTURE -- it is now a TICK the person
	// makes rather than something that happens to them for saying yes once. The box
	// is ticked here, and check 9 is the other half: a yes with the box left alone
	// changes nothing outside the command it was given about.
	//
	// DRIVEN THROUGH THE APP'S OWN GATE, `window.__daimondEgressAllowed` -- the
	// global the wasm calls when a command wants the network -- and the dialog it
	// raises is clicked like a person clicks it. The first version of this called
	// `setStandingNet` directly instead, and `--break yesnotsticky` reddened
	// NOTHING: the check proved the recorder worked and said nothing about whether
	// the dialog ever reaches it, which is the entire defect. A break that does not
	// go red is a finding, and this one's finding was about the check.
	await p.evaluate(() => { try { localStorage.removeItem('daimond-net-standing'); } catch (e) {} });
	await newChat(s);
	await p.fill('#chat-input', '@text before the yes');
	await p.click('#chat-send');
	await p.waitForTimeout(3500);
	const gate = p.evaluate(() => window.__daimondEgressAllowed(JSON.stringify({
		tool: 'run_net', url: 'cargo build --release', detail: '/home/jason/usr/code',
	})));
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	// THE TICK, then OK. Clicked as a person clicks it, on the box in the card that
	// is actually up: a `standing: true` posted into the handler from here would
	// prove the recorder works and say nothing about whether any control on screen
	// reaches it, which is the same fault `--break yesnotsticky` was written to
	// catch the first time.
	const tickable = await p.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		const box  = card && card.querySelector('.net-standing-box');
		if (!box) return false;
		box.click();
		return !!box.checked;
	});
	check(tickable,
		'THE DIALOG OFFERS A CONTROL THE USER PRESSES to make an answer standing',
		tickable ? '' : 'no .net-standing-box in the card, or it would not tick');
	await p.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		card.querySelector('.dlg-ok').click();
	});
	const verdict = await gate;
	check(verdict === 'allow-net',
		'the network dialog is raised and a yes comes back as a yes', String(verdict));
	await newChat(s);
	await p.fill('#chat-input', '@text a chat made after the yes');
	await p.click('#chat-send');
	await p.waitForTimeout(3500);
	await p.evaluate(() => DaimondCore.markRead());
	const after = await p.evaluate(() => DaimondCore.netState());
	check(after === 'allowed',
		'A YES THE USER TICKED IS THE LAST ONE — a later chat is never asked',
		`engine=${after}`);

	// ── 9. AND A YES NOBODY TICKED CHANGES NOTHING ELSE ──────────
	//
	// THE CHECK THAT MATTERS, and the one nothing above it could have caught. Until
	// 2026-08-28 ANY yes in this dialog called `setStandingNet('allow')`, which
	// writes `daimond-net-standing` -- the app-wide standing answer -- and pushes
	// `allow` into every chat that already has an engine. So:
	//
	//   two chats open; in one the user is asked about a command and says NO; in the
	//   other they are asked about a DIFFERENT command and say yes; and the first
	//   chat's refusal is gone. Its next command reaches the network, nobody is
	//   asked, nothing says the answer was reversed, and the permissions button
	//   reads "Always" -- a setting they never chose, surviving every reload.
	//
	// src/tools.rs says of `override_net_consent`, which that path ends at, that
	// NOTHING IN THE TOOL LOOP MAY CALL IT. This dialog is the tool loop.
	//
	// TWO ASSERTIONS AND NOT ONE, because either alone is satisfied by half a fix:
	// the stored policy is untouched, AND the other chat's engine still refuses. A
	// build that stopped writing the key but went on calling `netApplyAll` would
	// pass the first and reverse the user's no all the same.
	//
	// HOW THE REFUSING CHAT IS PUT IN THAT STATE: the popover's own "Never" chip,
	// and then the stored key removed from under it. `setStanding` writes the key
	// AND every engine, so taking the key away afterwards leaves exactly what a no
	// in the dialog leaves -- one engine holding a refusal, and no stored policy.
	// There is no other way in from a served page: a no at the dialog is answered to
	// the WASM, which is not in the loop when the gate is driven from here.
	const focusId = () => p.evaluate(() => {
		try {
			const f = window.DaimondAttach && window.DaimondAttach.focus();
			return (f && f.kind === 'chat') ? String(f.id) : '';
		} catch (e) { return ''; }
	});
	const goTo = async (id) => {
		await p.evaluate((cid) => {
			const esc = (window.CSS && CSS.escape) ? CSS.escape(cid) : cid;
			const box = document.querySelector('.session-box[data-id="' + esc + '"]');
			if (box) box.click();
		}, id);
		await p.waitForTimeout(800);
	};

	// Cleared BEFORE the chat is made: `ensureApp` reads the standing answer into
	// each new engine, so a chat born under check 8's "always" would start granted.
	await p.evaluate(() => { try { localStorage.removeItem('daimond-net-standing'); } catch (e) {} });
	await newChat(s);
	const chatNo = await focusId();
	await p.fill('#chat-input', '@text the chat that says no');
	await p.click('#chat-send');
	await p.waitForTimeout(3500);
	await p.evaluate(() => DaimondCore.markRead());
	await popOpen();
	await pick(NEVER);
	await popClose();
	await p.evaluate(() => { try { localStorage.removeItem('daimond-net-standing'); } catch (e) {} });
	const noBefore = await p.evaluate(() => DaimondCore.netState());
	check(noBefore === 'refused' && !!chatNo,
		'a chat has said no, and nothing is stored — the state a no in the dialog leaves',
		`engine=${noBefore} id=${JSON.stringify(chatNo)}`);

	// The OTHER chat, a different command, and OK with the box LEFT ALONE.
	await newChat(s);
	await p.fill('#chat-input', '@text the chat that says yes');
	await p.click('#chat-send');
	await p.waitForTimeout(3500);
	const gate2 = p.evaluate(() => window.__daimondEgressAllowed(JSON.stringify({
		tool: 'run_net', url: 'curl https://elsewhere.test/x', detail: '/home/jason/usr',
	})));
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	const untouched = await p.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		const box  = card && card.querySelector('.net-standing-box');
		return !!card && (!box || box.checked === false);
	});
	await shot(s, 'netchip-oneoff');
	await p.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		card.querySelector('.dlg-ok').click();
	});
	const verdict2 = await gate2;
	check(untouched && verdict2 === 'allow-net',
		'the box starts UNTICKED and a plain yes is still a yes for this command',
		`unticked=${untouched} verdict=${verdict2}`);
	const stored = await p.evaluate(() => {
		try { return localStorage.getItem('daimond-net-standing'); } catch (e) { return 'unreadable'; }
	});
	check(!stored,
		'A ONE-OFF YES WRITES NO STANDING POLICY',
		`daimond-net-standing=${JSON.stringify(stored)}`);
	await goTo(chatNo);
	const noAfter = await p.evaluate(() => DaimondCore.netState());
	check(noAfter === 'refused',
		"AND THE OTHER CHAT'S NO IS STILL A NO",
		`engine=${noAfter}`);
	// ── 10. AND THE COMMAND THAT RAN WITHOUT IT SAYS SO ──────────
	//
	// Everything above is about the CHAT's state, on a button in the header. None
	// of it is what a person meets: they watch a `cargo build` stop halfway with
	// "failed to fetch" and nothing anywhere says why. `src/tools.rs` writes a note
	// into the result for exactly that reason -- and wrote it FOR THE MODEL, in
	// English, inside brackets, so the person learned the reason only if the model
	// chose to relay it. A capability with a model-facing surface and no
	// user-facing one, recorded on 2026-08-13 and still standing on 2026-08-28.
	//
	// THE FIXTURE IS THE CONTRACT ITSELF. `NO_NET_MARK` is read out of the Rust,
	// so this cannot go green against a mark the engine no longer writes; that the
	// mark opens the note it stands for is held in Rust by
	// `test_the_no_network_mark_opens_the_note_and_finds_it_in_a_result`, and the
	// whole path -- a real command, a real hand, a real fence -- by
	// `dev/verify_handrun.mjs`. What is asked here is the half neither of those
	// can see: whether the person is told.
	const MARK = (() => {
		const rs = fs.readFileSync(path.join(WWW, '..', 'src/tools.rs'), 'utf8');
		const m  = rs.match(/pub const NO_NET_MARK: &str = "([^"]+)"/);
		return m ? m[1] : '';
	})();
	check(!!MARK, 'the engine\'s own mark for a command that had no network was read',
		JSON.stringify(MARK));

	const said = await p.evaluate((mark) => {
		const out = {};
		DaimondCore.drawToolResult('run',
			'error: failed to fetch `serde`\n[exit code: 101]\n' + mark + ' the turn read outside '
				+ 'content, so this command ran without it.]', 'done');
		// The LAST block, by position rather than by `:last-of-type`, which is about
		// element type and would answer about whatever div happens to be last.
		const last = () => [...document.querySelectorAll('.tool-block')].pop();
		out.blocks   = document.querySelectorAll('.tool-block').length;
		let line = last() ? last().querySelector('.tool-nonet') : null;
		out.withNote = line ? (line.textContent || '').trim() : '';
		out.shown    = !!(line && line.getClientRects().length);
		DaimondCore.drawToolResult('run', 'Compiling daimond v0.1.0\n[exit code: 0]', 'done');
		line = last() ? last().querySelector('.tool-nonet') : null;
		out.without = line ? (line.textContent || '').trim() : '';
		out.sentence = window.DaimondI18n ? DaimondI18n.t('chat.tool_no_net') : '';
		return out;
	}, MARK);
	check(!!said.withNote && said.shown,
		'A COMMAND THAT RAN WITH NO NETWORK SAYS SO ON ITS OWN BLOCK, to the person',
		`${said.blocks} block(s) drawn — ${JSON.stringify(said.withNote.slice(0, 80))}`);
	// In the app's own words and not the model's: the bracketed note is written for
	// a model to act on, and a person reading it is reading somebody else's post.
	check(said.withNote === said.sentence && said.sentence.length > 40
		&& !said.withNote.includes(MARK),
		'and in the app\'s own sentence, from the catalogue, not the model\'s note',
		JSON.stringify(said.sentence.slice(0, 80)));
	// The other half, and it is what stops the line becoming noise: a command that
	// HAD the network says nothing at all.
	check(said.without === '',
		'and a command that had the network says nothing about it',
		JSON.stringify(said.without));

	// The sentence exists in all eight catalogues. `tOr` draws correct English when
	// a key is in no table, so a missing translation looks exactly like a finished
	// one and nothing reports it.
	const LOCALES = ['en', 'es', 'de', 'fr', 'pt-BR', 'zh-Hans', 'ja', 'ko'];
	const gaps = LOCALES.filter((code) => {
		const src = fs.readFileSync(path.join(WWW, 'i18n', code + '.js'), 'utf8');
		return !/'chat\.tool_no_net':\s*'[^']{20,}'/.test(src);
	});
	check(gaps.length === 0,
		'and it is in all eight catalogues, not in English only',
		gaps.join(', '));
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
