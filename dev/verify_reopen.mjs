// verify_reopen.mjs — a reload comes back where you were, whichever it was.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// A boot restored the CHAT you were reading and dropped the DIAMOND you were
// in. Open a Diamond, talk to its daimon, reload: the stage came back as an
// empty "+ New chat" on the crystal face, with `DaimondDiamond.current()` null.
// The Diamond was still in the rail — you just had to find it and click it
// again, every reload, on the surface Daimond is developed from.
//
// It was never a policy. `renderAll` read `daimond-open-chat` and looked it up
// with `c => !c.diamondId && c.id === want`, so a daimon's record could not be
// the answer and no key held a Diamond at all. The comment beside it already
// made the whole argument for restoring — "on a phone, where resuming the app
// is a boot, that reads as the transcript you were reading having vanished" —
// and the argument was simply never carried across to the other half of the
// rail.
//
// ── WHAT IT ASSERTS, WHICH IS THE PROPERTY AND NOT THE FIX ───────────────────
//
// Not "a Diamond is restored". The property is that **whichever of the two was
// selected last is the one that comes back**, so the two keys cannot both claim
// the answer. That is why the chat arm is here too: a fix that restored the
// Diamond unconditionally would pass a Diamond-only test and lose the chat of
// anybody who opened a Diamond once, a fortnight ago.
//
//   node dev/verify_reopen.mjs
//   node dev/verify_reopen.mjs --break nodiamond   # the defect, restored
//   node dev/verify_reopen.mjs --break nochatclear # the two keys both claiming
//
// A `--break` run EXPECTS to fail: exit 0 when something reddened, 1 when
// nothing did, because a break that changes nothing is itself a failing run.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The breaks ───────────────────────────────────────────────────────────────
//
// Each one is scoped to survive every check but the one it proves. `nodiamond`
// restores the original defect exactly: the key is still written, and nothing
// reads it. `nochatclear` leaves the restore in and stops `selectChat` clearing
// the Diamond key, which is the state where both keys are set and the Diamond
// always wins — the failure a Diamond-only test would not have seen.
const BREAK  = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : ''; })();
const BREAKS = {
	nodiamond: [{
		file: 'js/daimond.js',
		find: "					if (!wantF) return;",
		with: "					if (!wantF) return;\n					return;   // --break nodiamond",
	}],
	nochatclear: [{
		file: 'js/daimond.js',
		find: "			localStorage.removeItem(OPEN_DIAMOND_KEY);   // a chat is where you are now",
		with: "			/* --break nochatclear */",
	}],
};

function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		if (!src.includes(spec.find)) {
			// A break whose anchor is not there patches nothing and launders a
			// plain run as proof. Loud, and fatal.
			console.error(`--break ${BREAK}: anchor not found in ${spec.file}. The break is stale.`);
			process.exit(1);
		}
		byFile.set(spec.file, src.replace(spec.find, spec.with));
	}
	return byFile;
}

async function serveBreaks(page) {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

// ── Where the app thinks it is ───────────────────────────────────────────────
const where = (p) => p.evaluate(() => {
	const d = window.DaimondDiamond && window.DaimondDiamond.current
		? window.DaimondDiamond.current() : null;
	let openChat = '', openDiamond = '';
	try { openChat    = localStorage.getItem('daimond-open-chat')    || ''; } catch (e) {}
	try { openDiamond = localStorage.getItem('daimond-open-diamond') || ''; } catch (e) {}
	return {
		diamond: d ? (d.id || '') : '',
		name:    d ? (d.name || '') : '',
		keys:    { openChat, openDiamond },
	};
});

// `connect: false` -- nothing here talks to a model, and it drops the
// requirement for a mock this run owns.
const s = await open({ name: 'reopen', route: serveBreaks, connect: false });
const p = s.page;

// A RELOAD IS A LOCK. `boot()` finds the stored identity and returns before
// `renderAll` ever runs, so the restore happens after the passphrase, not
// before it — which is also what the user meets. A reload that only waits for
// `__DAIMOND_READY` is looking at the lock screen and reads every restore as
// absent.
async function reboot() {
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForFunction(() => window.__DAIMOND_READY === true, null, { timeout: 30000 });
	if (await p.evaluate(() => document.body.classList.contains('locked'))) {
		await signInAs(s, 'reopen');
	}
	await p.waitForFunction(() => !document.body.classList.contains('locked'), null, { timeout: 30000 });
}

/// Poll until `want()` matches, then hand back what it last saw.
///
/// NOT `page.waitForFunction`, which throws — and a throw here killed the whole
/// run in the gate's world while passing locally, turning a slow boot into a
/// crash with no check attributed to it. The restore hangs off the end of an
/// async step, so it is genuinely a race; what it must never be is a race that
/// takes the process with it. A deadline that expires is a RED CHECK with the
/// last state printed, which is a fact somebody can act on.
async function settle(want, ms = 30000) {
	const until = Date.now() + ms;
	let last = await where(p);
	while (Date.now() < until) {
		if (want(last)) return last;
		await sleep(250);
		last = await where(p);
	}
	return last;
}

// ── 0. A chat exists FIRST, because that is the world a real user is in ──────
//
// This is the ordering the gate caught and this file originally missed. `boot`
// restores the chat BEFORE the rail is read, and restoring a chat forgets the
// Diamond -- so a boot with any stored chat lost the Diamond and a boot with
// none did not. Locally there was no chat yet and every check passed; in the
// gate's world there was one and 1c failed honestly. Making the chat first is
// what stops this file passing by fixture ordering rather than by behaviour.
await newChatOnRail();
async function newChatOnRail() {
	await p.evaluate(() => {
		const b = document.getElementById('new-session-btn');
		if (b) b.click();
	});
	// A deadline that expires is a red check, never a thrown stack: see `settle`.
	const until = Date.now() + 15000;
	while (Date.now() < until) {
		const n = await p.evaluate(() => document.querySelectorAll('#session-list [data-id]').length);
		if (n > 0) return true;
		await sleep(250);
	}
	return false;
}
check('0z a chat is on the rail before the Diamond is opened',
	(await p.evaluate(() => document.querySelectorAll('#session-list [data-id]').length)) > 0);

// ── 1. A Diamond ─────────────────────────────────────────────────────────────
//
// The rail is seeded with two default Diamonds on a first boot, so there is one
// to open without minting anything.
const picked = await p.evaluate(() => {
	const el = document.querySelector('#diamond-list [data-id]');
	if (!el) return '';
	el.click();                       // NOT page.click: force-clicking a tile is
	return el.dataset.id || '';       // silently inert headless.
});
check('0 a Diamond exists on the rail to open', !!picked, picked || 'no tile with data-id');
await sleep(400);

const before = await where(p);
check('1a opening a Diamond makes it current', before.diamond === picked,
	`current ${before.diamond || '(none)'}, clicked ${picked}`);
check('1b and the app remembers which one', before.keys.openDiamond === picked,
	`key ${before.keys.openDiamond || '(unset)'}`);

await reboot();

const after = await settle(w => w.diamond === picked);
check('1c A RELOAD COMES BACK TO THE DIAMOND YOU WERE IN',
	after.diamond === picked,
	`came back to ${after.diamond || '(none)'}, was in ${picked}`);
await shot(s, 'reopen-diamond');

// ── 2. A chat, which must still win when it was selected last ────────────────
//
// Made rather than found: a fresh profile has no chat on the rail, and a click
// that lands on nothing leaves the Diamond current — which would read as this
// arm passing for the wrong reason. The rail's own `+`, not `harness.newChat`,
// because that one waits for the composer to be VISIBLE and this session is
// deliberately unconnected — no provider, so no composer, and a chat that
// exists perfectly well without one.
await newChatOnRail();
await sleep(600);
const onChat = await where(p);
check('2a selecting a chat leaves no Diamond current and forgets the Diamond key',
	onChat.diamond === '' && onChat.keys.openDiamond === '',
	`current ${onChat.diamond || '(none)'}, key ${onChat.keys.openDiamond || '(unset)'}`);

await reboot();

// The Diamond arm settles on a value appearing; this one settles on the rail
// having been read at all, because "no Diamond" is also the state before the
// step runs — a check that did not wait would pass while proving nothing.
const back = await settle(w => w.diamond === '' && !!w.keys.openChat, 15000);
check('2b A RELOAD AFTER A CHAT DOES NOT DRAG THE DIAMOND BACK',
	back.diamond === '',
	`came back into ${back.diamond || '(none)'}`);
check('2c and it is the chat that was remembered',
	back.keys.openChat === onChat.keys.openChat && !!back.keys.openChat,
	`key ${back.keys.openChat || '(unset)'}`);

// ── The console, which a restore that throws would fill ──────────────────────
const errs = errors(s).filter(e => !/502|Account service/.test(e));
check('3 the boot restore raised nothing in the console', errs.length === 0,
	errs.slice(0, 2).join(' | '));

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	// A break that reddened nothing proves nothing about the check it names.
	console.log(bad.length ? `--break ${BREAK}: reddened ${bad.length} check(s), as it must`
		: `--break ${BREAK}: CHANGED NOTHING — the check it names is not testing what it says`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
