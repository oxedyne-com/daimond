// gateway: none
// verify_carrybodies.mjs — a Kimberlite turn's file BODIES reach the asking device.
//
// THE DEFECT (2026-11-11, Neil's Diamond on Kimberlite). A turn a runner runs settles on the
// runner. `turn_rec` (kimberlite/src/errands/settle.rs) posted the file rows as path + hash and
// no bytes, and `record_away` (src/store/diamond.rs) then wrote the version with no body at all:
// "no bodies -- the bytes are on the runner". True, and useless: no door fetched a body by hash,
// so the asking device recorded a row naming a body it would never hold. The panel draws a
// Diamond's crystal from `crystal.json` and falls back to the SEED when the newest version names
// nothing it can read, so the Diamond opened on its seed line with Files 0 while the runner's
// store held crystal.json, tasks.txt and 32 bodies. Nothing had failed to sync: the rows arrived
// faithfully, carrying nothing.
//
// WHAT IS PROVED HERE, without a gateway and without a runner:
//
//   1. RED, the shape the code had: a carried record whose rows carry no body leaves the asker
//      with no bytes for that hash -- `versions_body` answers null. This is the symptom, stated.
//   2. A body offered under the wrong hash is REFUSED, not stored under a name it is not.
//   3. GREEN, the fix: the page's `DaimondVersions.recordCarried` fetches each row's carried
//      manifest, unseals it, puts the bytes down with `versions_put_body`, and only then records
//      the version -- so `versions_body` answers the bytes the runner had.
//   4. The recorded version names that body, so a restore has something to restore from.
//   5. A row with no `carry` is still recorded, as it always was (a runner on an older build).
//   6. A body that will not come back costs the body and not the turn.
//
// Each check is proved against broken code first: `--break nocarry` serves a `versions.js` whose
// `putCarried` puts nothing down, which is exactly the code this replaces.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

let good = 0, bad = 0;
const VOTES = {};	// the leading number of each check -> whether it passed
const check = (pass, name, detail) => {
	if (pass) good++; else bad++;
	const m = /^(\S+)\./.exec(name);
	if (m) VOTES[m[1]] = pass;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);

const PROFILE = scratch('pw', 'carrybodies' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

// ── The break ─────────────────────────────────────────────────────────────────
// `nocarry` is the code as it stood: the row is recorded, the bytes stay on the runner.
//
// IT IS A PATCH TO THE LIVE FUNCTION, not a second copy of `versions.js` served through a route.
// Serving a patched file was tried TWICE and was worthless both times: first the route was raised
// after `open` had already navigated, so the real file had been read; then, raised through `open`'s
// own hook before `goto`, the run still read 7 of 7 ok. So nothing is served. Once the page is up
// and BEFORE any check runs, `DaimondVersions.recordCarried` is replaced in the page with the
// door-call-and-no-bodies function this fix replaces -- and the replacement COUNTS ITS OWN CALLS,
// so check 0 can say not just that it was installed but that the checks below really went through
// it. A break that is installed and never called is the same lie as one that never arrives.
const BREAKS = { nocarry: true };
if (BREAK && !BREAKS[BREAK]) { console.error('unknown break: ' + BREAK); process.exit(2); }

const s = await open({ name: 'carrybodies', profile: PROFILE, connect: false });
const { page } = s;

const sha  = (text) => crypto.createHash('sha256').update(text).digest('hex');

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.diamondApp
		&& window.DaimondVersions && DaimondVersions.recordCarried), null, { timeout: 20000 });
	await page.waitForTimeout(600);

	// ── 0. THE BREAK REALLY RAN ──────────────────────────────────────────────────
	// A `--break` run whose break did not arrive is a run that proves nothing, and it looks
	// exactly like a pass. The function is replaced here, in the page, and it counts its own
	// calls: `window.__break` is read again after the checks, below, and the run is only PROVED
	// when the replacement was really called AND checks 3 and 4b came out red.
	if (BREAK) {
		// NO `eval`: the page may carry a CSP, and a break that fails to compile would look like a
		// break that failed to arrive. The replacement is written as ordinary code in the page.
		const patched = await page.evaluate(() => {
			window.__break = { calls: 0, versions: [], err: null, was: String(DaimondVersions.recordCarried || '') };
			DaimondVersions.recordCarried = function (rec) {
				window.__break.calls++;
				if (!rec || !rec.keeper || !rec.run) return Promise.resolve(null);
				var app = window.DaimondCore && DaimondCore.diamondApp ? DaimondCore.diamondApp() : null;
				if (!app) return Promise.resolve(null);
				// THE DEFECT: the version is recorded and the bytes are never put down.
				return app.versions_record_carried(String(rec.keeper), JSON.stringify(rec)).then(
					function (got) {
						var s = {};
						try { s = JSON.parse(got) || {}; } catch (e) { s = {}; }
						window.__break.versions.push(s && s.version ? s.version : 0);
						return s;
					},
					function (e) { window.__break.err = String((e && e.message) || e); throw e; });
			};
			return {
				installed: String(DaimondVersions.recordCarried).indexOf('__break') >= 0,
				// The code that was there really carried bodies, so the break replaced something
				// rather than a function that had already lost its own fix.
				fixWasThere: window.__break.was.indexOf('putCarried') >= 0,
			};
		});
		note('break installed in the page: ' + BREAK);
		check(patched.installed && patched.fixWasThere,
			'0. the break replaced the fix in the page (a break that does not arrive proves nothing)',
			'installed ' + patched.installed + ', the fix was there ' + patched.fixWasThere);
	}

	// ONE DIAMOND FOR THE WHOLE RUN, made once and named, exactly as the engine's own test does
	// (`carry_a_runner_turns_bodies_reach_the_asker`). `carried_keeper` needs a keeper the store
	// HOLDS a Diamond for -- a chat's bare id lands in `diamonds/<id>/versions`, where no History
	// reads it -- and a Diamond `create_diamond` made is one.
	const id = await page.evaluate(async (a) => {
		const app = DaimondCore.diamondApp();
		const got = JSON.parse(await app.list_diamonds()) || [];
		if (got.length) return String(got[0].id);
		return String(await app.create_diamond(a.n));
	}, { n: 'Carry bodies ' + Date.now() });
	note('Diamond ' + id);

	// The body a runner's turn left: what Neil's turn wrote.
	const TEXT = '# Tasks\n\n- fix the sync defect\n- tell Jason\n';
	const HASH = sha(TEXT);
	// A RUNNER'S PATHS ARE ABSOLUTE, and the door says so: `carried_rows` leaves out any row whose
	// path does not start with '/' or that holds an empty or '..' segment (diamond_versions.rs),
	// as the meter's own rows are. A record of relative paths is silently all-drop, `record_away`
	// finds no rows and no net and answers `Ok(None)`, and every check here reads version 0. That
	// is the trap this constant closes: every row below is a path the runner could really send.
	const BASE = '/home/neil/diamond';
	const at = (name) => BASE + '/' + name;

	const putBody = (hash, text) => page.evaluate(async (a) => {
		const app = DaimondCore.diamondApp();
		const bytes = new TextEncoder().encode(a.text);
		try { return { ok: await app.versions_put_body(a.id, a.hash, bytes) }; }
		catch (e) { return { refused: String((e && e.message) || e) }; }
	}, { id, hash, text });

	// `versions_body` answers the empty string for a body this device does not hold (an empty
	// Diamond file is not a body an asker ever needs), so `null` here means "not held".
	const heldBody = (hash) => page.evaluate(async (a) => {
		const app = DaimondCore.diamondApp();
		try {
			const b = await app.versions_body(a.id, a.hash);
			if (b === null || b === undefined || b === '') return null;
			return typeof b === 'string' ? b : new TextDecoder().decode(new Uint8Array(b));
		} catch (e) { return null; }
	}, { id, hash });

	// ── 1. RED: what the code did -- a carried row with no bytes ───────────────
	// The record is made with no `carry` on the row, which is every record the runner posts
	// today: `record_away` writes the version and puts down nothing.
	const recNoCarry = JSON.stringify({
		v: 1, keeper: id, turnId: 't-nocarry', run: 'e-nocarry', on: 'dev-runner', onName: 'Kimberlite',
		since: 0, until: 0, ts: 1762000000000, more: 0,
		files: [{ path: at('tasks.txt'), hash: HASH, created: true, by: { agent: 'daimon', via: 'file_write' } }],
	});
	const recordedNoCarry = await page.evaluate(async (a) => {
		const got = await DaimondVersions.recordCarried(JSON.parse(a.rec));
		return got && got.version ? got.version : 0;
	}, { rec: recNoCarry });
	const gone = await heldBody(HASH);
	check(recordedNoCarry > 0 && gone === null,
		'1. a carried row with no bytes leaves the asker holding none (the defect)',
		'version ' + recordedNoCarry + ', body ' + (gone === null ? 'absent' : 'present'));

	// ── 2. A body under a name it is not is refused ───────────────────────────
	const wrong = await putBody('0'.repeat(64), TEXT);
	check(!!wrong.refused, '2. bytes that do not hash to their name are refused', wrong.refused || 'accepted');

	// ── 3, 4. GREEN: the same record, this time carrying its bytes ────────────
	// The runner's `carry` is a v2 chunk manifest. Here it is named but the reader is stubbed:
	// what is under test is the page's ordering (bodies first, version after), not the chunk
	// transport, which `verify_chunks.mjs` owns.
	await page.evaluate(() => {
		window.__carriedStub = null;
		if (window.DaimondChunks) {
			DaimondChunks.materialiseBytes = async function (man) {
				if (man && man.key === 'stub-ok') {
					window.__carriedStub = (window.__carriedStub || 0) + 1;
					return new TextEncoder().encode(window.__carriedText);
				}
				return null;	// a chunk the gateway has swept
			};
		}
	});
	await page.evaluate((t) => { window.__carriedText = t; }, TEXT);

	const recCarry = JSON.stringify({
		v: 1, keeper: id, turnId: 't-carry', run: 'e-carry', on: 'dev-runner', onName: 'Kimberlite',
		since: 0, until: 0, ts: 1762000001000, more: 0,
		files: [{ path: at('tasks.txt'), hash: HASH, created: true, carry: { v: 2, size: TEXT.length, key: 'stub-ok', chunks: [] },
			by: { agent: 'daimon', via: 'file_write' } }],
	});
	const recordedCarry = await page.evaluate(async (a) => {
		const got = await DaimondVersions.recordCarried(JSON.parse(a.rec));
		return got && got.version ? got.version : 0;
	}, { rec: recCarry });
	const here = await heldBody(HASH);
	check(recordedCarry > 0 && here === TEXT,
		'3. a carried record puts its bodies down before the version that names them',
		'version ' + recordedCarry + ', body ' + (here === null ? 'absent' : here.length + ' bytes'));
	check(here === TEXT,
		'4. the bytes are the runner\'s, byte for byte',
		here === null ? 'nothing' : JSON.stringify(here.slice(0, 24)));

	// The version the fix wrote names that body, so a restore has one to restore from.
	const named = await page.evaluate(async (a) => {
		const app = DaimondCore.diamondApp();
		try {
			const all = JSON.parse(await app.versions_list(a.id)) || [];
			const v = all.filter((x) => Number(x.version) === Number(a.n))[0];
			return v ? (v.files || []).map((f) => f.hash) : ['no version ' + a.n];
		} catch (e) { return ['ERR ' + e]; }
	}, { id, n: recordedCarry });
	check(named.indexOf(HASH) >= 0 && here === TEXT,
		'4b. the recorded version names the body this device now holds',
		named.join(', ') + ' / body ' + (here === null ? 'absent' : here.length + ' bytes'));

	// ── 5. A row with no carry is still a row (an older runner) ───────────────
	const oldRun = await page.evaluate(async (a) => {
		const got = await DaimondVersions.recordCarried(JSON.parse(a.rec));
		return got && got.version ? got.version : 0;
	}, { rec: JSON.stringify({
		v: 1, keeper: id, turnId: 't-old', run: 'e-old', on: 'dev-old', onName: 'Older',
		since: 0, until: 0, ts: 1762000002000, more: 0,
		files: [{ path: at('old.txt'), hash: sha('old'), created: true }],
	}) });
	check(oldRun > 0, '5. a runner on an older build still records its turn', 'version ' + oldRun);

	// ── 6. A body that will not come back costs the body, not the turn ────────
	const sweptRun = await page.evaluate(async (a) => {
		const got = await DaimondVersions.recordCarried(JSON.parse(a.rec));
		return got && got.version ? got.version : 0;
	}, { rec: JSON.stringify({
		v: 1, keeper: id, turnId: 't-swept', run: 'e-swept', on: 'dev-runner', onName: 'Kimberlite',
		since: 0, until: 0, ts: 1762000003000, more: 0,
		files: [{ path: at('swept.txt'), hash: sha('swept'), created: true,
			carry: { v: 2, size: 5, key: 'gone', chunks: [] } }],
	}) });
	check(sweptRun > 0, '6. a body the gateway no longer holds does not cost the turn',
		'version ' + sweptRun);

	// ── 7. A CHAT KEEPER: a turn a runner ran for a chat, not a Diamond ────────
	// `carried_keeper` reads `chat:` OFF the record's own keeper and leaves the prefixed key as it
	// found it, so a chat's bodies and its version land under `chats/<id>` -- where its History
	// reads them -- and not under `diamonds/chat:<id>` or `diamonds/<id>`. The two doors must
	// agree on that key or the body is put down where the version will never look for it, which is
	// the shape of the defect itself. Asked through the same page entry point, with the record's
	// `keeper` the prefixed name the runner's own `turnRec` carries (`chat:<id>`).
	const chatKeeper = 'chat:' + id;
	// Its own body: the hash of check 3 is already held under the Diamond, and a chat check that
	// reuses it would read that copy back and call it agreement.
	const CHAT_TEXT = '# Chat notes\n- carried from Kimberlite\n';
	const CHAT_HASH = sha(CHAT_TEXT);
	const chatRec = JSON.stringify({
		v: 1, keeper: chatKeeper, turnId: 't-chat', run: 'e-chat', on: 'dev-runner', onName: 'Kimberlite',
		since: 0, until: 0, ts: 1762000004000, more: 0,
		files: [{ path: at('chat-notes.md'), hash: CHAT_HASH, created: true,
			carry: { v: 2, size: CHAT_TEXT.length, key: 'stub-ok', chunks: [] },
			by: { agent: 'daimon', via: 'file_write' } }],
	});
	const chatRun = await page.evaluate(async (a) => {
		window.__carriedText = a.text;
		const got = await DaimondVersions.recordCarried(JSON.parse(a.rec));
		return got && got.version ? got.version : 0;
	}, { rec: chatRec, text: CHAT_TEXT });
	// Read back where a chat's History reads: its own keeper, and nowhere else.
	const chatHeld = await page.evaluate(async (a) => {
		const app = DaimondCore.diamondApp();
		const out = { text: null, named: [], elsewhere: null };
		try {
			const b = await app.versions_body(a.chat, a.hash);
			if (b !== null && b !== undefined && b !== '') {
				out.text = typeof b === 'string' ? b : new TextDecoder().decode(new Uint8Array(b));
			}
		} catch (e) { out.text = 'ERR ' + e; }
		try {
			const all = JSON.parse(await app.versions_list(a.chat)) || [];
			const v = all.filter((x) => Number(x.version) === Number(a.n))[0];
			out.named = v ? (v.files || []).map((f) => f.hash) : ['no version ' + a.n];
		} catch (e) { out.named = ['ERR ' + e]; }
		// The bare id, where a body would land if `chat:` never came off: a Diamond keeper.
		try {
			const b = await app.versions_body(a.id, a.hash);
			out.elsewhere = b === null || b === undefined || b === '' ? null : 'held';
		} catch (e) { out.elsewhere = 'ERR ' + e; }
		return out;
	}, { chat: chatKeeper, id, hash: CHAT_HASH, n: chatRun });
	check(chatRun > 0 && chatHeld.text === CHAT_TEXT && chatHeld.named.indexOf(CHAT_HASH) >= 0 && chatHeld.elsewhere === null,
		'7. a chat keeper\'s carried body and its version land under the chat, in that order, and nowhere else',
		'version ' + chatRun + ', body ' + (chatHeld.text === null ? 'absent' : chatHeld.text.length + ' bytes')
			+ ', names ' + (chatHeld.named.join(',') || 'none') + ', under the bare id: ' + (chatHeld.elsewhere || 'nothing'));
} catch (e) {
	check(false, 'verify_carrybodies ran without throwing',
		e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e));
} finally {
	// ── AND THE BREAK WAS CALLED, AND IT TURNED THE RIGHT CHECKS RED ────────────
	// The break is only evidence if the checks went THROUGH it and came out the other way. So a
	// `--break` run ends by reading the count off the page and by naming exactly which checks the
	// broken function made red. The run's own verdict is then inverted: a break run is a proof
	// when 3 and 4b are RED, and proves nothing when they are green -- which is the failure that
	// cost two rounds, a route served and never read.
	if (BREAK) {
		const b = await page.evaluate(() => window.__break || null).catch(() => null);
		const calls = b && b.calls ? b.calls : 0;
		const red = [ '3', '4b' ].filter((n) => VOTES[n] === false);
		const green = [ '3', '4b' ].filter((n) => VOTES[n] === true);
		const proved = calls > 0 && red.length === 2;
		const all = Object.keys(VOTES).sort().map((k) => k + (VOTES[k] ? ':ok' : ':RED'));
		console.log('\nbreak ' + BREAK + ': called ' + calls + ' time(s)'
			+ (b && b.err ? ', threw ' + b.err : '')
			+ '; checks 3 and 4b ' + (red.length === 2 ? 'RED, as the broken code must'
				: (green.length ? 'GREEN -- the break did not turn them, so it proves nothing' : 'not reached'))
			+ '\n  every check: ' + all.join(' '));
		console.log(proved ? 'break ' + BREAK + ': PROVED (the defect is real and this run caught it)'
			: 'break ' + BREAK + ': NOT PROVED -- do not read this as evidence');
		await s.close().catch(() => {});
		process.exit(proved ? 0 : 1);
	}
	await s.close().catch(() => {});
}

console.log(bad === 0 ? `\nall ${good} checks passed` : `\n${bad} check(s) FAILED, ${good} passed`);
process.exit(bad === 0 ? 0 : 1);
