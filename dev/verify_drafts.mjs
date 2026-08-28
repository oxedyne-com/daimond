// verify_drafts.mjs — what somebody is half-way through typing survives a
// reload, and does NOT thereby become a send queue.
//
// The owner reported one case and stated the general rule: "A screen refresh
// deletes text entered but waiting and not processed into Social > Notes. I
// would expect all live text input to persist, stored temporarily in the
// browser so it returns after a refresh."
//
// He is right, and the box is the one place in an app where the user rather
// than the app holds the only copy. `www/js/drafts.js` keeps it.
//
// ── WHY THIS FILE IS HALF ABOUT WHAT MUST *NOT* HAPPEN ───────────────
//
// `dev/IMPROVE_CONTRACT.md` §4: "A note leaves this device only when a person
// presses Send on that one note, and what leaves is exactly the characters that
// are on the screen at that moment. Nothing about a note is queued, retried,
// batched, synced or kept for later sending."
//
// Held text LOOKS like the thing that forbids, so the difference is asserted
// rather than argued. What is forbidden is SENDING WITHOUT A PRESS. A draft is
// not waiting to go; it is waiting to be looked at, by the person who typed it,
// on the device they typed it on. So every check that the words come back is
// paired with a check that they went NOWHERE — counted at the network, over the
// whole session, whatever the address, exactly as verify_improve.mjs counts.
//
// FIVE PROPERTIES:
//
//  1. THE NOTE BOX SURVIVES A RELOAD, and the words are the same characters.
//  2. AND NOT ONE REQUEST IN THE WHOLE SESSION CARRIED THEM. Not on the type,
//     not on the reload, not afterwards. This is the check that says a draft is
//     not a queue, and it is blind to the address on purpose.
//  3. A BOX THAT WAS EMPTIED IS EMPTY AFTER A RELOAD. A draft that outlived the
//     act of clearing it would put words back that somebody had deleted, which
//     is worse than losing them: it looks like the app arguing.
//  4. THE CHAT COMPOSER SURVIVES ONE TOO, and a draft belongs to ITS OWN
//     conversation — switching away and back finds the same words, and a
//     different chat does not inherit them.
//  5. NOTHING REACHES THE SYNC PARCEL. A draft that crossed to a phone would be
//     text moving without a press, which is the thing §4 forbids, arriving by
//     the side door.
//
// PROVED RED. `--unbuilt` serves the page with `DaimondDrafts` removed before
// anything binds to it, which is what the app did before this existed.
//
// ITS REACH IS THREE CHECKS AND THEY ARE NAMED, because a break whose reach is
// not written down is a break whose reach is not known: the note box coming
// back, the composer coming back, and the second conversation keeping its own.
// Those three are one property asserted over three surfaces, which is the point
// of asserting it three times — the owner said "all live text input", not "the
// note box".
//
// The other eleven STAY GREEN under it, and that is what makes them evidence
// rather than echo. They are the properties the old app also satisfied: nothing
// was sent, an emptied box stayed empty, no draft reached the parcel. A break
// that reddened everything would prove nothing about which check caught what.
// It also proves the call sites tolerate the module's absence — the run
// finishes, and the unhandled-error check is one of the eleven.
//
//   eval "$(bash dev/world.sh 7 --env)"
//   node dev/verify_drafts.mjs
//   node dev/verify_drafts.mjs --unbuilt      # expected to FAIL, exactly 3 checks
//
// Needs dev/serve.mjs and node. No gateway: nothing here reaches one, which is
// itself the point.
import { open, shot, scratch, errors, newChat } from './harness.mjs';

const UNBUILT = process.argv.includes('--unbuilt');

let bad = 0, n = 0;
const check = (ok, what, detail) => {
	n++;
	if (!ok) bad++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ' — ' + detail : ''}`);
};

// The markers. Distinctive enough that a substring search over every request
// body and URL in the session cannot match anything else.
const NOTE   = 'the rail forgot where it was quokka-draft-note';
const CHAT   = 'ask the daimon about quokka-draft-chat';
const SECOND = 'a different conversation quokka-draft-other';

const profile = scratch('pw', 'drafts-' + process.pid);
const s = await open({
	name: 'drafts' + process.pid,
	profile,
	defaults: false,
	// Every request the page makes, whatever its address, so check 2 can be
	// asked over the whole session rather than over one route.
	route: async (page) => {
		if (UNBUILT) {
			// The app as it was: the module is served, and then taken away before
			// anything can bind to it. Serving an EMPTY file would be the same
			// break; taking the global away after the file has run also proves the
			// call sites tolerate its absence, which they must.
			await page.route('**/js/drafts.js', (r) => r.fulfill({
				status: 200, contentType: 'text/javascript',
				body: '/* --unbuilt: the app before drafts.js */\n',
			}));
		}
	},
});
const p = s.page;

// Everything the page sent, in full. Read from the request rather than from a
// route handler, so a request that a handler would have had to fulfil is
// counted the same as one that went out.
const wire = [];
p.on('request', (r) => {
	let body = '';
	try { body = r.postData() || ''; } catch (e) { body = ''; }
	wire.push(r.url() + ' ' + body);
});
const anywhereOnTheWire = (needle) => wire.filter((w) => w.includes(needle));

const reload = async () => {
	await p.reload({ waitUntil: 'domcontentloaded' });
	// The gate is on a fresh load; the profile keeps the identity, so this is an
	// unlock rather than a create.
	await p.waitForTimeout(400);
	const pass = await p.$('#id-pass');
	if (pass) {
		await pass.fill('testpass1234');
		await p.evaluate(() => {
			const b = document.getElementById('id-primary');
			if (b) b.click();
		});
	}
	await p.waitForTimeout(1200);
};

const openSocial = async () => {
	await p.evaluate(() => {
		window.DaimondPanels.show('social');
		if (window.DaimondImprove) window.DaimondImprove.onOpen();
	});
	await p.waitForTimeout(600);
};

console.log(UNBUILT ? 'drafts (UNBUILT — 2 checks are expected to fail)' : 'drafts');

// ── 1 and 2. The note box ────────────────────────────────────────────
console.log('the note box');
await openSocial();
const box = await p.$('#improve-box');
check(!!box, 'the note box is on screen to type into');
if (box) {
	await box.fill(NOTE);
	// The settle timer, plus a moment. Written as a wait rather than a flush,
	// because what is being checked is that an ORDINARY pause is enough — a test
	// that called `flush()` would prove the store works and nothing about whether
	// the app ever reaches it.
	await p.waitForTimeout(700);
	await shot(s, 'drafts-typed');

	const sentWhileTyping = anywhereOnTheWire('quokka-draft-note');
	check(sentWhileTyping.length === 0,
		'typing sends nothing — not one request in the session carries the words',
		sentWhileTyping.length ? sentWhileTyping[0].slice(0, 160) : null);

	await reload();
	await openSocial();
	const back = await p.evaluate(() => {
		const b = document.getElementById('improve-box');
		return b ? String(b.value || '') : null;
	});
	check(back === NOTE, 'and after a reload the words are back, character for character',
		JSON.stringify(back));
	await shot(s, 'drafts-restored');

	// THE CHECK THIS FILE EXISTS FOR. The reload is exactly the moment a queue
	// would flush, so it is asked after it and over the whole session.
	const sentEver = anywhereOnTheWire('quokka-draft-note');
	check(sentEver.length === 0,
		'AND THE RELOAD SENT NOTHING EITHER — a draft is held, never queued',
		sentEver.length ? `${sentEver.length}, e.g. ${sentEver[0].slice(0, 160)}` : null);
}

// ── 3. Emptying it means it is empty ─────────────────────────────────
console.log('emptying it');
{
	await p.evaluate(() => {
		const b = document.getElementById('improve-box');
		if (!b) return;
		b.value = '';
		b.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await p.waitForTimeout(700);
	await reload();
	await openSocial();
	const after = await p.evaluate(() => {
		const b = document.getElementById('improve-box');
		return b ? String(b.value || '') : null;
	});
	check(after === '', 'a box emptied on purpose is still empty after a reload',
		JSON.stringify(after));
}

// ── 4. The chat composer ─────────────────────────────────────────────
console.log('the chat composer');
{
	// The Social panel is open over the stage, and the composer is on the stage.
	// A chat of this run's own, so the draft has a conversation to belong to and
	// the keying check below has a second one to switch to.
	await p.evaluate(() => { try { window.DaimondPanels.hide('social'); } catch (e) { /* already */ } });
	await newChat(s);
	await p.waitForTimeout(400);
	const input = await p.$('#chat-input');
	check(!!input, 'the composer is on screen to type into');
	if (input) {
		await input.fill(CHAT);
		await p.waitForTimeout(700);
		await reload();
		const back = await p.evaluate(() => {
			const b = document.getElementById('chat-input');
			return b ? String(b.value || '') : null;
		});
		check(back === CHAT, 'a half-typed message is back after a reload', JSON.stringify(back));
		const leaked = anywhereOnTheWire('quokka-draft-chat');
		check(leaked.length === 0, 'and it went nowhere either',
			leaked.length ? leaked[0].slice(0, 160) : null);

		// A DRAFT BELONGS TO ITS OWN CONVERSATION. The composer is ONE element
		// shared by every chat and both faces of every Diamond, so a draft keyed on
		// the element rather than on the conversation would follow the user into
		// the next one — which is how a stranger's half-sentence once ended up in a
		// Diamond that had never seen it.
		await newChat(s);
		await p.waitForTimeout(400);
		const afterSwitch = await p.evaluate(() => document.getElementById('chat-input').value);
		check(afterSwitch === '', 'a new conversation does not inherit the last one\'s draft',
			JSON.stringify(afterSwitch));
		// And it keeps one of its own, which is the other half: a key that was the
		// same for every conversation would pass the check above only by losing
		// both drafts.
		await p.fill('#chat-input', SECOND);
		await p.waitForTimeout(700);
		await reload();
		const secondBack = await p.evaluate(() => document.getElementById('chat-input').value);
		check(secondBack === SECOND, 'and it keeps its OWN across a reload', JSON.stringify(secondBack));
		const bothLeaked = anywhereOnTheWire('quokka-draft-other');
		check(bothLeaked.length === 0, 'and neither of them went anywhere');
	}
}

// ── 5. Nothing crosses to another device ─────────────────────────────
console.log('the sync parcel');
{
	const parcel = await p.evaluate(async () => {
		try {
			if (!window.DaimondSync || !DaimondSync.parcel) return null;
			return JSON.stringify(await DaimondSync.parcel());
		} catch (e) { return 'ERR ' + String(e && e.message); }
	});
	if (parcel === null) {
		check(true, 'the sync module offers no parcel to read here, so nothing can be in it');
	} else {
		check(!parcel.includes('quokka-draft'),
			'no draft is in the sync parcel — a draft that crossed devices would be text moving with no press',
			parcel.startsWith('ERR') ? parcel : null);
		check(!parcel.includes('daimond-drafts'),
			'and the store is not named in it either');
	}
}

// ── The page did not fall over doing any of it ───────────────────────
{
	// 401 and 502 on `/api/...` are this world with no gateway of its own, which
	// is deliberate: nothing this file checks reaches one. See dev/world.sh.
	const errs = errors(s).filter((e) => !/401|502|Failed to fetch|NetworkError/i.test(e));
	check(errs.length === 0, 'nothing above was reached by way of an unhandled error',
		errs.slice(0, 2).join(' | '));
}

await s.close();
console.log('');
if (UNBUILT) {
	// The break must redden exactly the three "the words are back" checks. A break
	// that reddened everything would say nothing about which check caught what.
	console.log(bad === 3
		? `--unbuilt: ${bad} of ${n} failed, which is the three restore checks and only those`
		: `--unbuilt: ${bad} of ${n} failed — EXPECTED 3. A break whose reach is not known is not proof.`);
	process.exit(bad === 3 ? 0 : 1);
}
console.log(bad ? `${bad} of ${n} failed` : `all ${n} checks passed`);
process.exit(bad ? 1 : 0);
