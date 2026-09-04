// verify_daimonchat.mjs — phase E: a Diamond has a chat, and the daimon remembers.
//
// Notes2, in the user's own words: *"The idea of just having a prompt box and
// hiding the chat sequence doesn't work. … a diamond should offer the crystal
// view and a chat view."* and *"because the daimon is meant to be persistant"*.
//
// Five properties:
//
//   1. A Diamond has two faces and a control that switches between them; a chat
//      has one, and is not offered a second.
//   2. What the daimon says lands in a thread, and stays there. The old surface
//      put a text-only answer in a dismissable box that the next steer cleared.
//   3. THE DAIMON REMEMBERS. Measured at the wire: the second turn's request
//      carries the first turn's exchange. Every steer used to build a fresh
//      `Session`, so a follow-up question reached a model that had never heard
//      the first one — and no screenshot of a thread can tell a model that
//      remembers from a transcript that merely still has the words on it.
//   4. The conversation survives a reload, because it is an ordinary chat record
//      in the ordinary store.
//   5. It has no tile in the Chats rail. It belongs to its Diamond, and a record
//      with a tile AND a Diamond would be reachable two ways with one state.
//
//   node dev/verify_daimonchat.mjs
//   node dev/verify_daimonchat.mjs --break stateless  # the daimon forgets again
//   node dev/verify_daimonchat.mjs --break railtile   # the daimon gets a tile
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { open, connectMock, signInAs, scratch, shot, mockLog, clearMockLog, storedChats, contentText } from './harness.mjs';

const OUT = path.join(os.homedir(), '.cache/daimond/daimonchat-shots');
fs.mkdirSync(OUT, { recursive: true });

const BI = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const MODEL = 'accounts/fireworks/models/glm-5p2';

async function create(p, name) {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')]
			.filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	await p.waitForTimeout(1200);
}

/// Say something to whatever is on screen, through the one composer.
async function say(p, text, ms = 4000) {
	await p.fill('#chat-input', text);
	await p.click('#chat-send');
	await p.waitForTimeout(ms);
}

/// Every user message the provider was sent, in the LAST request it received.
function lastRequestUserTexts() {
	const rows = mockLog();
	if (!rows.length) return null;
	const msgs = rows[rows.length - 1].messages || [];
	return msgs.filter(m => m.role === 'user').map(m => contentText(m.content));
}

const s = await open({ name: 'daimonchat', profile: scratch('pw', 'daimonchat-' + process.pid) });
const { page: p } = s;
try {
	await connectMock(s, { model: MODEL });
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);

	// ══ 1. Two faces on a Diamond, one on a chat ══════════════════════
	await create(p, 'Dee');
	const sw = () => p.evaluate(() => {
		const d = document.getElementById('diamond-view');
		if (!d) return null;
		return {
			shown: d.getClientRects().length > 0,
			crystal: (document.getElementById('dview-crystal') || {}).getAttribute
				? document.getElementById('dview-crystal').getAttribute('aria-pressed') : '',
			chat: (document.getElementById('dview-chat') || {}).getAttribute
				? document.getElementById('dview-chat').getAttribute('aria-pressed') : '',
		};
	});
	let v = await sw();
	check(v !== null, 'the face switch exists');
	check(!!(v && v.shown), 'it is drawn on a Diamond');
	check(!!(v && v.crystal === 'true' && v.chat === 'false'),
		'and a Diamond opens on its crystal', v && `${v.crystal}/${v.chat}`);

	await p.click('#dview-chat');
	await p.waitForTimeout(700);
	v = await sw();
	check(!!(v && v.chat === 'true' && v.crystal === 'false'),
		'pressing Chat moves the switch', v && `${v.crystal}/${v.chat}`);
	const faces = await p.evaluate(() => ({
		crystal: document.getElementById('crystal-view').style.display,
		bar: getComputedStyle(document.querySelector('.chat-input-bar')).display,
	}));
	check(faces.crystal === 'none', 'the crystal goes away', faces.crystal);
	check(faces.bar !== 'none', 'and the composer comes back', faces.bar);

	if (BREAK === 'railtile') {
		// The record's binding to its Diamond dropped on the way out of the store --
		// which is exactly what `hydrateChat` did before this phase, and the reason a
		// reloaded daimon appeared in the Chats rail while its Diamond started a
		// second, empty conversation beside it.
		await p.evaluate(() => {
			const rec = DaimondDiamond.conversation(DaimondDiamond.current().id);
			if (rec) rec.diamondId = '';
		});
	}

	// ══ 2. What the daimon says lands in a thread ═════════════════════
	clearMockLog();
	await say(p, 'remember the word ORTOLAN');
	// The transcript is uniform tiles now (`.ctile`), the user's and the daimon's
	// carrying `.chat-msg-user`/`.chat-msg-assistant` for older hooks. `.chat-msg`
	// alone (the pre-tile bubble class) matches only furniture, so it is added to
	// the tiles rather than replaced.
	let thread = await p.evaluate(() =>
		[...document.querySelectorAll('#chat-output .ctile, #chat-output .chat-msg')]
			.map(n => ({ cls: n.className, text: (n.textContent || '').trim().slice(0, 80) })));
	check(thread.some(m => /chat-msg-user/.test(m.cls) && /ORTOLAN/.test(m.text)),
		'what was asked is in the thread', thread.length + ' messages');
	check(thread.some(m => /chat-msg-assistant/.test(m.cls) && m.text),
		'and what the daimon answered is too',
		(thread.find(m => /assistant/.test(m.cls)) || {}).text);

	// ══ 3. The daimon remembers — measured at the wire ════════════════
	if (BREAK === 'stateless') {
		// Exactly the pre-phase-E daimon: a fresh session per instruction. The one
		// thing that makes it persistent is the conversation that travels to the
		// engine and back, so emptying that is the whole of the old behaviour.
		await p.evaluate(() => {
			const rec = DaimondDiamond.conversation(DaimondDiamond.current().id);
			if (rec) rec.session = null;
		});
	}
	clearMockLog();
	await say(p, 'what was the word?');
	const sent = lastRequestUserTexts();
	check(sent !== null, 'the provider was reached');
	check(!!(sent && sent.some(x => /what was the word/.test(x))),
		'the second turn is in the request', sent && String(sent.length));
	check(!!(sent && sent.some(x => /ORTOLAN/.test(x))),
		'AND SO IS THE FIRST — the daimon carried the conversation forward',
		sent ? sent.map(x => x.slice(0, 40)).join(' | ') : '');

	// ══ 4. It survives a reload ═══════════════════════════════════════
	await p.reload({ waitUntil: 'domcontentloaded' });
	// A reload lands on the lock screen: the account's keys live in memory, so
	// every reload is a fresh unlock. Signing back in is part of what is being
	// tested here -- a conversation that survived the reload but not the unlock
	// would still be lost.
	await signInAs(s, 'daimonchat');
	// Waited FOR rather than slept through: a reload boots the wasm, opens the
	// store and reads the Diamonds off OPFS, and how long that takes is a property
	// of the machine rather than of the app.
	try {
		await p.waitForFunction(() => {
			return [...document.querySelectorAll('#diamond-list .diamond-box')]
				.some(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === 'Dee');
		}, null, { timeout: 20000 });
	} catch { /* reported by the check below */ }
	const back = await p.evaluate(() => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === 'Dee');
		if (!box) return null;
		box.click();
		return true;
	});
	check(!!back, 'the Diamond is still on the rail after a reload');
	await p.waitForTimeout(1200);
	const face = await p.evaluate(() =>
		(document.getElementById('dview-chat') || {}).getAttribute
			? document.getElementById('dview-chat').getAttribute('aria-pressed') : '');
	check(face === 'true', 'and it opens back on the face you left it on', face);
	thread = await p.evaluate(() =>
		[...document.querySelectorAll('#chat-output .ctile, #chat-output .chat-msg')]
			.map(n => (n.textContent || '').trim()));
	check(thread.some(x => /ORTOLAN/.test(x)),
		'with the conversation still in it', String(thread.length) + ' messages');
	await shot(s, 'chat-view');

	// ══ 5. No tile in the Chats rail ══════════════════════════════════
	//
	// The harness's `newChat` returns early when `#chat-input` is already visible,
	// and in a Diamond's chat view it IS — that composer is the daimon's. So the
	// rail's own + is pressed directly, which is what a person does.
	// A direct DOM click. A coordinate click lands on whatever is drawn over the
	// rail — the harness's own `newChat` closes the Admin drawer first for exactly
	// this reason, and here the Diamond's chat view is what is in the way.
	await p.evaluate(() => document.getElementById('new-session-btn').click());
	await p.waitForTimeout(800);
	const rail = await p.evaluate(() =>
		[...document.querySelectorAll('#session-list .chat-box .tile-when')]
			.map(n => n.value || ''));
	check(!rail.includes('Dee'),
		'the daimon has no tile in the Chats rail', rail.join(', ') || '(empty)');
	check(rail.length >= 1,
		'while an ordinary chat still has one', rail.join(', ') || '(empty)');
	// And the store DOES hold it, so what is filtered is the rail and not the
	// record: a conversation dropped from the store would be one that never
	// reached another device, and the daimon would forget on every reload.
	const stored = await storedChats(s);
	const mine = stored.filter(c => c && c.diamondId);
	check(mine.length === 1, 'and the store holds it exactly once, bound to its Diamond',
		String(mine.length) + ' of ' + stored.length);
	check(!!(mine[0] && mine[0].session && (mine[0].session.msgs || []).length > 0),
		'with the MODEL\'s conversation stored beside the transcript',
		mine[0] && mine[0].session ? String((mine[0].session.msgs || []).length) : 'none');

	// ══ 6. A HALF-TYPED MESSAGE BELONGS TO ITS CONVERSATION ═══════════
	//
	// Reported live: "I started interacting with my Daimond daimon, switched to
	// the Daimond Optimiser diamond, and a text box from the previous chat then
	// appeared in the new one." There is ONE `#chat-input` for every chat and both
	// faces of every Diamond, and the switch re-pointed everything about it except
	// the words in it -- so a sentence meant for one Diamond followed the user into
	// the next, and `syncComposerAttachPrefix` then glued the arriving Diamond's
	// attachment prefix onto the front of it.
	//
	// A ROUND TRIP AND NOT A CLEARING. Emptying the box on every switch would pass
	// the first check below and is not the fix: it loses the sentence instead of
	// misplacing it. What is asserted is that each Diamond gets its OWN words back,
	// which only a save-and-restore can satisfy.
	//
	// Proved against the broken code by hand before it was written -- there is no
	// `page.route` machinery in this file -- by removing the two `moveComposerTo`
	// calls from `selectChat` and `selectDiamond` in `www/js/daimond.js`. Checks
	// two and four go red, and check two's detail prints the other Diamond's
	// sentence, which is the defect verbatim.
	const goTo = (name) => p.evaluate((nm) => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === nm);
		if (!box) return false;
		box.click();
		return true;
	}, name);
	const boxText = () => p.evaluate(() => document.getElementById('chat-input').value);

	await create(p, 'Dum');
	await p.waitForTimeout(600);
	const DEE = 'half a sentence meant for Dee';
	const DUM = 'and a different one for Dum';

	check(await goTo('Dee'), 'both Diamonds are on the rail');
	await p.waitForTimeout(700);
	await p.fill('#chat-input', DEE);
	await goTo('Dum');
	await p.waitForTimeout(700);
	const atDum = await boxText();
	check(!atDum.includes(DEE),
		'a draft typed in one Diamond does not follow the user into another',
		JSON.stringify(atDum));

	await p.fill('#chat-input', DUM);
	await goTo('Dee');
	await p.waitForTimeout(700);
	const atDee = await boxText();
	check(atDee === DEE,
		'and going back finds the words that were left there',
		JSON.stringify(atDee));

	await goTo('Dum');
	await p.waitForTimeout(700);
	const atDum2 = await boxText();
	check(atDum2 === DUM,
		'each Diamond keeping its own, so nothing was cleared to make the first check pass',
		JSON.stringify(atDum2));

} catch (e) {
	check(false, 'the run finished', String(e && e.message || e));
	try { await shot(s, 'threw'); } catch {}
} finally {
	await s.close();
}

console.log(failures === 0
	? `\nverify_daimonchat: all checks pass.`
	: `\nverify_daimonchat: ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
