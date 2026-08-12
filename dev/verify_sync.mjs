// verify_sync.mjs — a user's work travels between devices through the gateway's
// encrypted mailbox, and two devices editing at once converge rather than clobber.
//
// This drives the real client engine (sync.js) against the REAL gateway (/api/sync), so
// it needs the dev stack up: the app (DAIMOND_PORT, default 8777) and the gateway on
// :9002.
//
//   1. Sign in, make a chat, push. The mailbox holds a version >= 1, and its blob
//      is ciphertext — the plaintext codeword must NOT appear in it.
//   2. Simulate a second device: wipe local chats and the version cursor, pull, and
//      confirm the chat's transcript comes back decrypted and merged.
//   3. Conflict: another device bumps the mailbox out of band, then this device
//      pushes from its now-stale version; the engine must 409, pull, merge and retry
//      to success — the version advances, no work lost.
//   4. Diamonds travel too. A Diamond is a DIRECTORY, not a record, so the whole
//      of it must arrive — name, tags, crystal, log, links, and which model it
//      thinks with. A deletion must travel and STAY travelled, the freshest copy
//      must win, and a parcel from a device that predates any of this must still
//      apply.
//   5. The identity export bundle carries the salt, without which a second device
//      could never derive the key to open any of this.
//   6. A parcel the gateway refuses as too large (413) is SAID so — on the sync
//      chip, held, with the reason on hover — and the stall clears on the next
//      push that works.
//   7. A parked tab converges on window focus, without a reload, and a focus
//      storm coalesces into one pull.
//   8. Provider keys and model lists travel too: sealed keys only, deterministic
//      to the byte, freshest-wins per provider, and a union so neither device
//      loses a provider the other has never seen.
//  10. One section of a parcel that cannot be merged costs only itself: the
//      Diamonds beside it still arrive, and the merge says what it could not do.
//  11. A reconcile that gives up says so on the chip, rather than leaving the
//      "Synced" its own pull put there.
//  12. Two REAL devices, on two browser profiles, converge in BOTH directions --
//      including the one that is not being typed at, which raises no focus event
//      and ends no turn and therefore never asked the gateway anything at all.
//  13. And it converges with NOTHING happening on it at all: the gateway taps
//      every other device of the account when the mailbox moves, so a window
//      left open on a second desk applies the other one's work within seconds --
//      no focus, no visibility change, no settling event, no reload. Over a
//      socket where the front door carries one and over a parked request where
//      it does not, across a gateway restart, carrying version integers only.
import { open, chat, signInAs } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Push, and wait until THIS DEVICE'S OWN PARCEL is what the mailbox holds.
///
/// A single push() call is not enough: one that finds another in flight (or the
/// app busy) only reschedules and returns, so awaiting it proves nothing.
///
/// THE VERSION ADVANCING IS NOT ENOUGH EITHER, which is what this helper used
/// to wait for, and it is why one check per run went red and never the same
/// one. `serverVersion` moves on any completed round, and three of them are not
/// this push:
///
///   * a round that was ALREADY IN FLIGHT when the caller made its change. It
///     collected the parcel before the change existed, and it lands carrying
///     the state as it was. The version advances, the wait is satisfied, and
///     the pull that follows reads a mailbox that never saw the change --
///     "the second device pulls the shared Diamond down" and "a deleted
///     workspace file is restored by pull", both of which failed exactly here.
///   * `pull()` adopting a higher version from another device.
///   * push()'s own idle branch: with nothing new to send it pulls instead,
///     which can advance the version having sent nothing at all.
///
/// So the wait is on the only fact the callers actually depend on: the mailbox
/// decrypts to a parcel THIS device produced after the change. The parcel is
/// resampled each round and every sample kept, because a stray landing round
/// may carry a perfectly good newer parcel; what can never be accepted is the
/// one collected before the caller's change, which is never sampled at all.
///
/// A push that does not land is a FAILURE, not a note. It used to print a line
/// and carry on, so the red surfaced two hundred lines later as an unrelated
/// merge fault.
async function pushLanded(pg, where) {
	const r = await pg.evaluate(async (ms) => {
		const mailbox = async () => {
			const res = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
			const j = await res.json();
			if (!j.present) return null;
			try { return await window.DaimondIdentity.unwrap(j.blob); }
			catch (e) { return null; }
		};
		const mine = new Set();
		const t0 = Date.now();
		let rounds = 0, held = null, sample = '';
		while (Date.now() - t0 < ms) {
			rounds++;
			await window.DaimondSync.push();
			sample = JSON.stringify(await window.DaimondSync.parcel());
			mine.add(sample);
			held = await mailbox();
			if (held !== null && mine.has(held)) return { landed: true, rounds, took: Date.now() - t0 };
			await new Promise(r => setTimeout(r, 200));
		}
		return {
			landed: false, rounds, took: Date.now() - t0,
			// Which it is: a mailbox holding somebody else's parcel and a mailbox
			// holding nothing readable are different faults.
			mailbox: held === null ? '(absent or undecryptable)' : String(held.length) + ' bytes',
			parcel:  String(sample.length) + ' bytes',
			state:   JSON.stringify(window.DaimondSync.state()),
		};
	}, 25000);
	if (!r.landed) {
		check('a push reached the mailbox' + (where ? ' (' + where + ')' : ''), false,
			r.rounds + ' rounds in ' + r.took + 'ms, mailbox ' + r.mailbox
				+ ' vs parcel ' + r.parcel + ' — ' + r.state);
	}
	return r.landed;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Put `window.__bump(tag)` on the page: one genuine local change, so the push
/// that follows is not skipped as a no-op.
///
/// THE BLINDING THIS EXISTS FOR. Every stubbed refusal below — 413, 402, 409 —
/// is only reached if a parcel is actually SENT, and the engine sends one only
/// when the parcel differs from the last one it sent. The helper this replaces
/// wrote `daimond-chats` in localStorage. Transcripts moved into IndexedDB, so
/// those writes changed nothing `collectSync()` reads: every push was skipped
/// before any request was made, no stub was ever reached, and eighteen checks
/// reported on something other than the behaviour they name.
///
/// Two things are done about that. The change goes through the app's own chat
/// store — `DaimondCore.chatStore()`, the very object `collectSync()` packs, so
/// a store that moves again takes this with it LOUDLY (the call throws) rather
/// than silently. And the parcel is COMPARED across the change, so a bump that
/// stops moving it says so at the call site instead of surfacing as an
/// unrelated red four sections later. Each caller asserts on what it returns.
///
/// The tombstone map `daimond-msgs-deleted` would also have worked (see
/// verify_sessionrenew, which uses it) and is inert by construction. This is
/// preferred here because these sections say "a genuine local change" and mean
/// a transcript: what travels is the same section of the parcel the 413 and 409
/// arms exist to protect.
const installBump = (pg) => pg.evaluate(() => {
	window.__bump = async function (tag) {
		const before = JSON.stringify(await window.DaimondCore.collectSync());
		const store  = window.DaimondCore.chatStore();
		const list   = store.stored();
		if (!list.length) return { moved: false, why: 'no chat in the store to change' };
		list[0].messages  = (list[0].messages || []).concat([
			{ role: 'user', content: tag, mid: tag, ts: Date.now() },
		]);
		list[0].updatedAt = Date.now();
		store.save(list);
		const after = JSON.stringify(await window.DaimondCore.collectSync());
		return { moved: after !== before, why: after === before ? 'the parcel did not move' : '' };
	};

	/// Push until a parcel really LEAVES this device, and say whether one did.
	///
	/// THE SECOND BLINDING. `__bump` above makes sure there is something to send;
	/// this makes sure it is sent. `push()` answers a caller no differently
	/// whether it sent or stood aside -- over a live turn, and over a round
	/// already in flight, it only reschedules and returns -- so every stubbed
	/// refusal below (413, 402, 409) could be asserted against a gateway nobody
	/// had spoken to. Observed: "a permanent conflict is retried, and bounded"
	/// red at posts=0, with the chip still reading "Syncing…" from the round
	/// that had swallowed the call.
	///
	/// `count` is the section's own POST counter, so what is waited for is the
	/// thing the section measures. Re-bumped each round because a round that was
	/// in flight may have sent the change for real before the stub went on,
	/// leaving the engine with nothing to send and no reason to speak again.
	window.__pushSent = async function (count, tag, ms) {
		const t0 = Date.now();
		let rounds = 0;
		while (count() === 0 && Date.now() - t0 < (ms || 15000)) {
			rounds++;
			if (rounds > 1) await window.__bump(tag + '-' + rounds);
			await window.DaimondSync.push();
			if (count() === 0) await new Promise(r => setTimeout(r, 250));
		}
		return { sent: count() > 0, rounds: rounds, took: Date.now() - t0 };
	};
});

/// One local change, from Node. Returns `{ moved, why }`.
const bumped = (pg, tag) => pg.evaluate(t => window.__bump(t), tag);

/// Did every change a section made really move the parcel? The sections that
/// bump from inside their own `evaluate` collect the answers and hand them back
/// as `tag: moved` / `tag: <why not>` lines.
const allMoved = (lines) => Array.isArray(lines) && lines.length > 0
	&& lines.every(l => / moved$/.test(l));

/// Is the gateway answering?
async function gatewayUp() {
	try {
		const r = await fetch('http://127.0.0.1:9002/api/health', { signal: AbortSignal.timeout(2000) });
		return r.ok;
	} catch (e) { return false; }
}

/// Stop the running gateway and start it again exactly as it was.
///
/// Exactly as it was matters: the suite may be running it from `gateway/` or
/// from the generated `dev/devgw/`, and which one decides what config it reads.
/// Both are taken from the live process rather than guessed, so this restarts
/// whatever is actually there and hands it back in the state it found it.
///
/// Returns `true`, or a string saying what went wrong -- this test is the one
/// place in the suite that takes the gateway down, and it must not leave the
/// verifiers that run after it wondering why.
async function restartGateway() {
	let pid;
	try { pid = execFileSync('pgrep', ['-x', 'daimond_gateway'], { encoding: 'utf8' }).trim().split('\n')[0]; }
	catch (e) { return 'no daimond_gateway process to restart'; }
	if (!pid) return 'no daimond_gateway process to restart';

	let cwd, exe;
	try {
		cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
		// Linux appends " (deleted)" to this link once the binary has been
		// REPLACED under the running process -- which is what a rebuild does, and
		// a rebuild during a test run is an ordinary Tuesday. Spawning the link
		// verbatim then failed ENOENT on a path ending in that suffix, and the
		// failure arrived as an ChildProcess 'error' EVENT rather than a throw,
		// so it went round the whole file's try/catch and killed the run outright
		// with everything before it green and nothing said about why.
		exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
	} catch (e) { return 'could not read the gateway process: ' + e.message; }
	if (!fs.existsSync(exe)) return 'the gateway binary is no longer at ' + exe;

	try { execFileSync('pkill', ['-x', 'daimond_gateway']); } catch (e) { /* already gone */ }
	for (let i = 0; i < 20 && await gatewayUp(); i++) await sleep(500);
	if (await gatewayUp()) return 'the gateway would not stop';

	let spawnErr = '';
	const child = spawn(exe, [], {
		cwd, detached: true, stdio: 'ignore',
		env: { ...process.env, APP_MODE: process.env.APP_MODE || 'sandbox' },
	});
	// A spawn failure is an EVENT, not a throw. Unhandled it is fatal to the
	// whole run — see the note on the " (deleted)" suffix above.
	child.on('error', (e) => { spawnErr = String(e && e.message || e); });
	child.unref();
	await sleep(200);
	if (spawnErr) return 'the gateway would not start: ' + spawnErr;
	for (let i = 0; i < 60; i++) {
		if (await gatewayUp()) return true;
		await sleep(500);
	}
	return 'the gateway did not come back on :9002';
}

const s = await open({ name: 'sync', signIn: true, connect: true, defaults: false });
const { page } = s;
let child = null;		// a second REAL device, paired in at (12)

// The engine and its dependencies must be live and the session authed.
await page.waitForFunction(
	() => !!window.DaimondSync && !!window.DaimondCore && !!window.DaimondGateway
		&& DaimondGateway.state().authed,
	null, { timeout: 12000 },
).catch(() => {});

try {
	const authed = await page.evaluate(() => DaimondGateway.state().authed);
	check('gateway session is authed (sync can reach its mailbox)', authed);
	await installBump(page);

	// Sync IS the Pro capability under test, so the account has to hold Pro:
	// without it the gateway answers 402 and there is nothing below to measure.
	const GWDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gateway');
	const lic = await makePagePro(page, GWDIR);
	check('the account holds Pro, so sync may run at all',
		lic.pro === true, `webhook ${lic.status}, pro=${lic.pro}`);
	// A refusal must never put anything over the app -- that dialog is gone, and
	// this is what keeps it gone.
	const overlay = await page.evaluate(() =>
		[...document.querySelectorAll('.modal')]
			.filter(m => getComputedStyle(m).display !== 'none')
			.map(m => (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)));
	check('no dialog was raised over the app on the way here', overlay.length === 0,
		overlay.join(' | '));

	// A distinctive codeword, carried in a real message so it lands in the synced
	// transcript. We then hunt for it in the ciphertext to prove it is sealed.
	const MARK = 'ZEBRA-' + '7788';
	await chat(s, 'Remember the codeword ' + MARK + ' for later.');

	// Push and read the mailbox straight back.
	//
	// The push is RETRIED until the mailbox actually moves, because `push()`
	// stands aside over a live turn -- "never over a live turn", sync.js -- and
	// answers a caller no differently than when it sent. `chat()` returns when
	// the send button stops looking busy, which is not the same instant as
	// `DaimondCore.busy()` going false, so a single push here could return
	// having only scheduled one. The mailbox then still held the round BEFORE
	// the conversation: version 1, one chat, no messages in it, and the second
	// device below duly got an empty transcript back. That read as a sync defect
	// for weeks; it was this race.
	//
	// Waiting on the version rather than on a timer, and reporting how many
	// rounds it took, so a push that stops landing altogether still fails here
	// instead of being papered over by a longer wait.
	const mailboxWas = await page.evaluate(async () => {
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		return ((await r.json()).version) | 0;
	});
	await pushLanded(page, 'the conversation');
	const pushed = await page.evaluate(async () => {
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		let name = '';
		try { name = String(window.DaimondIdentity.displayName() || ''); } catch (e) { name = ''; }
		return { version: j.version, present: j.present, blob: j.blob || '', device: j.device || '', account: name };
	});
	// Asserted against the MAILBOX, not against `DaimondSync.state().version`
	// which `pushLanded` waits on: the client's own counter is this device's
	// belief about the round, and the question here is whether the gateway
	// really holds the conversation. `pushLanded` notes a push that never went
	// and carries on; this is where that becomes a failure.
	check('the push carrying the conversation actually landed',
		(pushed.version | 0) > mailboxWas, 'v' + mailboxWas + '→' + pushed.version);
	check('after a push the mailbox holds a version >= 1', pushed.present && pushed.version >= 1,
		'version=' + pushed.version);

	// The record's display label is the one thing the gateway keeps in the clear
	// beside the blob. A browser-and-platform description is fine; the account
	// name is the user's own words and must never leave the browser readable.
	check('the plaintext device label is not the account\'s chosen name',
		pushed.device !== '' && (pushed.account === '' || !pushed.device.includes(pushed.account)),
		'device="' + pushed.device + '" account="' + pushed.account + '"');

	// The blob is ciphertext: the plaintext codeword must not be in it, and it must
	// not decode to readable JSON.
	check('the stored blob is ciphertext (plaintext codeword absent)', !pushed.blob.includes(MARK));
	const looksEncrypted = await page.evaluate((blob) => {
		try { const t = atob(blob); return !(t.trim().startsWith('{') || t.includes('"chats"') || t.includes('messages')); }
		catch (e) { return true; }
	}, pushed.blob);
	check('the blob does not decode to plaintext JSON', looksEncrypted);

	// (2) Second device: wipe local chats + version cursor, then pull.
	//
	// The chats are wiped through the store that holds them. They are in
	// IndexedDB, so removing the old localStorage key emptied nothing and this
	// measured a device that had never lost anything.
	// The shape of what came back is carried out with the count, because this
	// check asserts TWO things -- a chat arrived, and the words in it did -- and
	// reporting only the count says "chats=1" for both a pass and the failure
	// where the transcript is empty. That reads as a passing check that failed.
	const restored = await page.evaluate(async () => {
		const store = window.DaimondCore.chatStore();
		await store.wipe();
		localStorage.removeItem('daimond-sync-version');
		const emptied = store.stored().length;
		const v = await window.DaimondSync.pull();
		const arr = store.stored();
		const text = JSON.stringify(arr);
		return {
			version: v, emptied, chatCount: arr.length, text,
			// Per chat: its id, how many messages it holds, and which roles they
			// are. A chat that arrives with an empty transcript and one that never
			// arrived are different defects and this is what tells them apart.
			shape: arr.map(c => ({
				id:    c && c.id,
				msgs:  (c && Array.isArray(c.messages)) ? c.messages.length : -1,
				roles: (c && Array.isArray(c.messages)) ? c.messages.map(m => m && m.role).join(',') : '',
			})),
		};
	});
	check('the second device really started with no transcripts',
		restored.emptied === 0, 'held=' + restored.emptied);
	check('a fresh device pulls and decrypts the chat transcript back',
		restored.chatCount >= 1 && restored.text.includes(MARK),
		'chats=' + restored.chatCount
			+ ' codeword=' + (restored.text.includes(MARK) ? 'present' : 'ABSENT')
			+ ' ' + JSON.stringify(restored.shape));

	// (3) Conflict: another device bumps the mailbox out of band (a garbage blob is
	// fine — the gateway is opaque and checks only the version), so THIS device's
	// known version is now stale. Its next push must 409, pull, merge and retry.
	const conflict = await page.evaluate(async () => {
		const before = window.DaimondSync.version();
		// The "other device" pushes over the current version, advancing it by one.
		const otherWrite = await fetch('/api/sync', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ base_version: before, device: 'other-device', blob: 'AAAABBBBCCCCDDDD' }),
		});
		const otherJson = await otherWrite.json();
		// A genuine local change, or the push is skipped before it is ever sent and
		// there is no 409 to reconcile.
		const changed = await window.__bump('conflict-note');
		// This device still thinks the version is `before`. Push the fresh change.
		//
		// Pushed until the mailbox moves, not once: a push that finds a round
		// already in flight reschedules and returns, and reading the version in
		// the same tick then reported a reconcile that had not been attempted
		// yet as one that failed. The base is still stale whichever call ends up
		// sending, so what is waited for is still the 409-pull-retry path.
		let after = otherJson.version;
		const t0 = Date.now();
		while (after <= otherJson.version && Date.now() - t0 < 15000) {
			await window.DaimondSync.push();		// base=before → 409 → pull → retry → success.
			const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
			after = ((await r.json()).version) | 0;
			if (after <= otherJson.version) await new Promise(x => setTimeout(x, 250));
		}
		return { before, bumped: otherJson.version, after, changed };
	});
	check('the out-of-band write advanced the mailbox', conflict.bumped === conflict.before + 1,
		'before=' + conflict.before + ' bumped=' + conflict.bumped);
	check('and this device really had something of its own to send',
		conflict.changed.moved === true, conflict.changed.why);
	check('a stale push reconciles (409 → pull → retry) and advances past the conflict',
		conflict.after > conflict.bumped, 'bumped=' + conflict.bumped + ' after=' + conflict.after);
	// After reconciling, the mailbox is this device's real (decryptable) state again.
	const reopened = await page.evaluate(async () => {
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		try { const plain = await window.DaimondIdentity.unwrap(j.blob); JSON.parse(plain); return true; }
		catch (e) { return false; }
	});
	check('the reconciled blob is this device’s own decryptable state', reopened);

	// (3b) Workspace files travel too: write one, push, confirm it is sealed, then
	// delete it locally and pull it back.
	//
	// The push is driven by the helper, not called once: a bare push() that finds
	// a round in flight only reschedules, and the mailbox then held a parcel with
	// no file in it at all. That read as "a deleted workspace file is restored by
	// pull" failing -- while the sealed check above it stayed green, because a
	// blob that never carried the file passes "the mark is absent" perfectly.
	// Which is why the file's presence is now asserted too: a check that only
	// looks for something's ABSENCE is answered by having nothing.
	const FILEMARK = 'FILEMARK-' + '5566';
	await page.evaluate(async (mark) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: 'sync-note.txt', content: 'workspace ' + mark }));
	}, FILEMARK);
	await pushLanded(page, 'the workspace file');
	const filePush = await page.evaluate(async () => {
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		let plain = '';
		try { plain = await window.DaimondIdentity.unwrap(j.blob || ''); } catch (e) { plain = ''; }
		return { version: j.version, blob: j.blob || '', plain };
	});
	check('the workspace file really travelled — the mailbox holds it, sealed',
		filePush.plain.includes(FILEMARK), 'parcel ' + filePush.plain.length + ' bytes');
	check('a workspace file is sealed in the pushed blob (content absent from ciphertext)',
		!filePush.blob.includes(FILEMARK));

	const fileRestore = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_delete', JSON.stringify({ path: 'sync-note.txt' }));
		const gone = await app.run_tool('file_read', JSON.stringify({ path: 'sync-note.txt' }));
		localStorage.removeItem('daimond-sync-filebase');		// a fresh device has no baseline.
		await window.DaimondSync.pull();
		const back = await app.run_tool('file_read', JSON.stringify({ path: 'sync-note.txt' }));
		return { gone: String(gone), back: String(back) };
	});
	check('a deleted workspace file is restored by pull',
		fileRestore.back.includes(FILEMARK) && /error|not found|no such/i.test(fileRestore.gone),
		'back=' + fileRestore.back.slice(0, 40));

	// (3c) A deletion on another device propagates here (an unchanged local copy
	// is removed; an edit would have beaten the delete).
	// The agreeing push is driven by the helper for the same reason as (3b): the
	// deletion below is only meaningful against a mailbox that HELD the file, and
	// a bare push() that stood aside left there being nothing to delete.
	await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: 'DELME.txt', content: 'delete me across devices' }));
		localStorage.removeItem('daimond-sync-filebase');
	});
	await pushLanded(page, 'DELME.txt enters the baseline');
	const delProp = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const present = await app.run_tool('file_read', JSON.stringify({ path: 'DELME.txt' }));
		// The OTHER device deletes DELME.txt and pushes the reduced state.
		const state = await window.DaimondCore.collectSync();
		delete state.files['DELME.txt'];
		const blob = await window.DaimondIdentity.wrap(JSON.stringify(state));
		const ver = window.DaimondSync.version();
		await fetch('/api/sync', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ base_version: ver, device: 'other', blob: blob }),
		});
		await window.DaimondSync.pull();							// honour the remote deletion.
		const after = await app.run_tool('file_read', JSON.stringify({ path: 'DELME.txt' }));
		return { present: String(present), after: String(after) };
	});
	check('a file deleted on another device is removed here',
		delProp.present.includes('delete me') && /error|not found|no such/i.test(delProp.after),
		'after=' + delProp.after.slice(0, 40));

	// ── (4) Diamonds ───────────────────────────────────────────────────
	// A Diamond is a directory in OPFS, so "it synced" means the whole directory
	// arrived: the crystal and its versions, the metadata that carries the name
	// and the tags, the append-only log, and the link sidecar. Each of those is a
	// separate file, and a merge that carried only some of them would look like a
	// working sync right up until the user asked the Graph pane a question.
	const DMARK = 'DIAMOND-' + '3344';

	/// Reach the real wasm on the page's own OPFS — the same store the app reads,
	/// not a copy of it.
	const wasm = (fn, arg) => page.evaluate(async ({ src, arg }) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return await (new Function('app', 'arg', `return (${src})(app, arg);`))(app, arg);
	}, { src: fn.toString(), arg });

	/// Make a Diamond the way a person does: the rail's button, the dialog, the
	/// name, Create. Going through the UI is what records the model choice, which
	/// is half of what this section is checking travels.
	const newDiamond = async (name) => {
		await page.evaluate(() => document.getElementById('new-diamond-btn').click());
		await page.waitForSelector('.dlg-card', { timeout: 8000 });
		const r = await page.evaluate((nm) => {
			const card = [...document.querySelectorAll('.dlg-card')].find(c => c.getClientRects().length);
			if (!card) return 'no dialog';
			const inp = card.querySelector('input.dlg-input');
			if (!inp) return 'no name field';
			inp.value = nm;
			inp.dispatchEvent(new Event('input', { bubbles: true }));
			const btn = card.querySelector('.dlg-ok');
			if (!btn) return 'no create button';
			btn.click();
			return 'ok';
		}, name);
		await page.waitForTimeout(1000);
		return r;
	};

	/// Delete the named Diamond the way a person does — the cog, then Delete at
	/// the foot of its dialog. THERE IS NO CONFIRM ANY MORE: since the trash,
	/// deleting is reversible and asks nothing, and this is the call site that
	/// has to put the Diamond into the state that travels.
	const removeDiamond = async (name) => {
		const found = await page.evaluate((nm) => {
			const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
				.find(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === nm);
			if (!box) return false;
			const cog = box.querySelector('.tile-cog');
			if (!cog) return false;
			cog.click();
			return true;
		}, name);
		if (!found) return 'not in the rail';
		await page.waitForSelector('.tile-dlg-delete', { timeout: 8000 });
		await page.evaluate(() => document.querySelector('.tile-dlg-delete').click());
		await page.waitForTimeout(1500);
		return 'ok';
	};

	/// Destroy a Diamond for good, out of the trash. THIS is now the call site
	/// that writes the tombstone.
	///
	/// By ID rather than by looking the name up in the panel: this file runs
	/// sections that empty the store on purpose, and a lookup that went through
	/// the panel would report "not in the trash" for a record that is perfectly
	/// present — testing the fixture rather than the tombstone.
	const purgeDiamond = async (id) => {
		await page.evaluate((i) => window.DaimondCore.trashPurge(i), id);
		await page.waitForTimeout(1200);
		return 'ok';
	};

	/// A crystal as the store now holds one: `crystal.json`, conforming to the core
	/// schema. These fixtures only ever needed a crystal they could tell apart, and
	/// the schema's `title` is where a short distinguishing string goes.
	///
	/// It has to be REAL JSON, not merely a different string. The parcel carries the
	/// Diamond's directory file for file, so whatever this writes is what the app
	/// parses on the other side — a markdown fixture would leave the merge under test
	/// carrying something no reader downstream can open.
	const crystalOf = (title) => JSON.stringify({ title: title });

	/// What another device would have pushed: this device's own state with one
	/// Diamond's entry rewritten to a different crystal at a different stamp,
	/// sealed under the shared key, written over the current version and pulled
	/// straight back — which is the merge under test.
	///
	/// BOTH stamps move, in both the places a real export carries them: the entry
	/// the merge compares, and the `meta.json` inside the packed directory. A
	/// real device's copies always agree, so a fixture whose copies disagree
	/// would be testing a state that cannot occur -- and a crystal edit on a real
	/// device moves `updated` (it was worked on) AND `touched` (it changed).
	const otherDeviceShifts = (id, crystal, delta) => page.evaluate(async (arg) => {
		const state = await window.DaimondCore.collectSync();
		const e = (state.diamonds || []).find(d => d.id === arg.id);
		if (!e) return 'no entry for that Diamond';
		const pack = JSON.parse(e.data);
		pack.files['crystal.json'] = arg.crystal;
		const meta = JSON.parse(pack.files['.daimond/meta.json']);
		meta.updated = (e.updated || 0) + arg.delta;
		meta.touched = (e.touched || e.updated || 0) + arg.delta;
		pack.files['.daimond/meta.json'] = JSON.stringify(meta);
		e.updated = meta.updated;
		e.touched = meta.touched;
		e.data    = JSON.stringify(pack);
		const blob = await window.DaimondIdentity.wrap(JSON.stringify(state));
		await fetch('/api/sync', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ base_version: window.DaimondSync.version(), device: 'other', blob: blob }),
		});
		await window.DaimondSync.pull();
		return 'ok';
	}, { id, crystal, delta });

	/// One Diamond's whole visible state, read back from the store.
	const readDiamond = (id) => wasm(async (app, id) => {
		const list = JSON.parse(await app.list_diamonds()).find(d => d.id === id) || null;
		if (!list) return null;
		return {
			name:    list.name,
			tags:    list.tags || [],
			version: list.crystal_version,
			updated: list.updated,
			crystal: await app.read_crystal_data(id),
			log:     JSON.parse(await app.log_read(id)).length,
			links:   JSON.parse(await app.links_touching('diamond:' + id)),
		};
	}, id);

	// The fixture: two Diamonds, one of them tagged, steered (so its log has an
	// edit record beside the create) and linked to the other.
	await newDiamond('Sync-Alpha');
	await newDiamond('Sync-Bravo');
	const ids = await wasm(async (app, crystal) => {
		const list = JSON.parse(await app.list_diamonds());
		const find = (n) => (list.find(d => d.name === n) || {}).id || '';
		const A = find('Sync-Alpha'), B = find('Sync-Bravo');
		if (!A || !B) return { A, B };
		await app.set_tags(A, JSON.stringify(['travel', 'sync']));
		await app.write_crystal_data(A, crystal);
		await app.add_link(A, 'diamond:' + A, 'diamond:' + B, 'part-of', 'bravo sits under alpha', 'user');
		return { A, B };
	}, crystalOf('Alpha ' + DMARK));
	check('the fixture Diamonds were made through the rail', !!(ids.A && ids.B),
		'alpha=' + (ids.A || '-') + ' bravo=' + (ids.B || '-'));

	const before = await readDiamond(ids.A);
	// What the fixture actually laid down, before any of it travels. Without this
	// a fixture that quietly failed to write reads afterwards as a sync that
	// quietly failed to carry, and the two want opposite fixes.
	check('the fixture took locally before anything synced',
		!!before && before.tags.join(',') === 'travel,sync' && before.crystal.includes(DMARK)
			&& before.log >= 2 && before.links.length >= 1,
		before ? 'tags=[' + before.tags.join(',') + '] v' + before.version
			+ ' log=' + before.log + ' links=' + before.links.length : 'absent');
	await pushLanded(page, 'the fixture Diamonds');

	// A second device: it has never seen these Diamonds, holds no per-Diamond
	// model choice, and has no version cursor. Wiping all three is what "another
	// device" means here.
	const arrived = await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		for (const d of JSON.parse(await app.list_diamonds())) await app.delete_diamond(d.id);
		localStorage.removeItem('daimond-diamond-models');
		localStorage.removeItem('daimond-sync-version');
		const gone = JSON.parse(await app.list_diamonds()).length;
		await window.DaimondSync.pull();
		const models = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
		return { gone: gone, model: models[id] || null };
	}, ids.A);
	check('the second device really started without them', arrived.gone === 0, 'held=' + arrived.gone);

	const after = await readDiamond(ids.A);
	check('a Diamond arrives on the second device at all', !!after,
		after ? after.name : 'absent');
	check('its name and tags arrive with it',
		!!after && after.name === 'Sync-Alpha' && after.tags.join(',') === 'travel,sync',
		after ? after.name + ' [' + after.tags.join(',') + ']' : 'absent');
	check('its crystal arrives, at the version it was left at',
		!!after && after.crystal.includes(DMARK) && after.version === before.version,
		after ? 'v' + after.version + ' len=' + after.crystal.length : 'absent');
	check('its log arrives whole (the create record and the edit)',
		!!after && after.log === before.log && after.log >= 2,
		after ? 'records=' + after.log : 'absent');
	check('the link to the other Diamond arrives, and is found from this end',
		!!after && after.links.some(l => l.other === 'diamond:' + ids.B && l.rel === 'part-of'),
		after ? JSON.stringify(after.links.map(l => l.other + '/' + l.rel)) : 'absent');
	check('the model the Diamond thinks with arrives with it',
		!!(arrived.model && arrived.model.model), JSON.stringify(arrived.model));
	// The other Diamond came too, or the rail below has nothing to delete.
	const bravoBack = await readDiamond(ids.B);
	check('the second Diamond arrives as well', !!bravoBack && bravoBack.name === 'Sync-Bravo',
		bravoBack ? bravoBack.name : 'absent');

	// (4b) Deleting through the rail must put the Diamond into a state the
	// parcel CARRIES — and, since the trash, that state is not a tombstone.
	//
	// The two are different promises and both are asked here. Trashing has to
	// travel WITH THE BYTES, or the other device holds a name it cannot restore;
	// destroying has to travel as a tombstone, or the other device still holds
	// the Diamond and hands it straight back on the next pull. The old shape of
	// this check — delete in the rail, expect a tombstone — would now pass with
	// a trash that quietly destroyed everything, which is the failure the panel
	// exists to prevent.
	// What the parcel carried BEFORE the delete, so "its bytes still travel" is a
	// comparison rather than an absolute: earlier sections of this file empty the
	// store on purpose, and a Diamond whose bytes were not in the parcel to begin
	// with cannot be asked to still be in it.
	const carriedBefore = await page.evaluate(async (id) => {
		const state = await window.DaimondSync.parcel();
		return (state.diamonds || []).some(d => d.id === id);
	}, ids.B);
	const removed = await removeDiamond('Sync-Bravo');
	const parcel = await page.evaluate(async (id) => {
		const state = await window.DaimondSync.parcel();
		const rec   = (state.trash && state.trash.items) ? state.trash.items[id] : null;
		return {
			v:       state.v,
			tombed:  !!(state.diamondTombs && state.diamondTombs[id]),
			trashed: !!(rec && rec.at > rec.back),
			listed:  (state.diamonds || []).some(d => d.id === id),
			count:   (state.diamonds || []).length,
		};
	}, ids.B);
	check('a Diamond deleted in the rail travels as TRASHED, so the other device can restore it',
		removed === 'ok' && parcel.trashed, removed + ', trashed=' + parcel.trashed);
	check('and it is NOT tombstoned by that — deleting it is not destroying it',
		!parcel.tombed, 'tombed=' + parcel.tombed);
	check('while its bytes travel exactly as before, or there would be nothing to restore',
		parcel.listed === carriedBefore,
		'carried before=' + carriedBefore + ', after=' + parcel.listed + ' (of ' + parcel.count + ')');
	check('the parcel declares itself v2', parcel.v === 2, 'v=' + parcel.v);

	// And destroying it from the trash is what lays the tombstone.
	const purged = await purgeDiamond(ids.B);
	const afterPurge = await page.evaluate(async (id) => {
		const state = await window.DaimondSync.parcel();
		return {
			tombed: !!(state.diamondTombs && state.diamondTombs[id]),
			listed: (state.diamonds || []).some(d => d.id === id),
		};
	}, ids.B);
	check('destroying it from the trash IS what tombstones it in the parcel',
		purged === 'ok' && afterPurge.tombed, purged + ', tombed=' + afterPurge.tombed);
	check('and it is no longer offered as a live Diamond',
		!afterPurge.listed, 'listed=' + afterPurge.listed);

	// (4c) A deletion made on ANOTHER device reaches this one, and does not come
	// back on the cycle after — the failure a tombstone-less delete would show as
	// a Diamond that reappears every time the app is opened.
	const delCycle = await page.evaluate(async (id) => {
		const post = async (state) => {
			const blob = await window.DaimondIdentity.wrap(JSON.stringify(state));
			await fetch('/api/sync', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
				body: JSON.stringify({ base_version: window.DaimondSync.version(), device: 'other', blob: blob }),
			});
			await window.DaimondSync.pull();
		};
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const here = async () => JSON.parse(await app.list_diamonds()).some(d => d.id === id);
		const held = await here();
		// The other device deletes it: gone from its Diamonds, present in its tombs.
		const state = await window.DaimondCore.collectSync();
		state.diamonds = (state.diamonds || []).filter(d => d.id !== id);
		state.diamondTombs = state.diamondTombs || {};
		state.diamondTombs[id] = Date.now();
		await post(state);
		// SETTLE, DO NOT SNAPSHOT. `pull()` resolving is not the same instant as the
		// store having finished with the directory it just removed: two
		// `list_diamonds()` calls a few microseconds apart were observed
		// disagreeing, the first still carrying the Diamond and the second empty.
		// Reading once, in the same tick, therefore reported a deletion that HAD
		// happened as one that had not -- and it read as sync losing a tombstone,
		// which is about as alarming as this suite gets.
		//
		// Bounded, so a deletion that genuinely never lands still fails rather than
		// hanging: half a second is already hundreds of times what the settle costs.
		const gone = async () => {
			for (let i = 0; i < 25; i++) {
				if (!(await here())) return false;
				await new Promise(r => setTimeout(r, 20));
			}
			return true;
		};
		const afterPull = await gone();
		// A full cycle later — this device pushes its own view, then pulls again.
		await window.DaimondSync.push();
		await window.DaimondSync.pull();
		const afterCycle = await gone();   // same reason: settle, do not snapshot
		return { held, afterPull, afterCycle };
	}, ids.A);
	check('a Diamond deleted on another device is deleted here',
		delCycle.held === true && delCycle.afterPull === false,
		'held=' + delCycle.held + ' after=' + delCycle.afterPull);
	check('and does not resurrect on the next cycle', delCycle.afterCycle === false,
		'after a push+pull, present=' + delCycle.afterCycle);

	// (4d) Freshest wins, wholesale, and the comparison is STRICT: an equal stamp
	// keeps what is here, so an unchanged Diamond is not rewritten on every pull.
	await newDiamond('Sync-Charlie');
	const cid = await wasm(async (app, crystal) => {
		const list = JSON.parse(await app.list_diamonds());
		const id = (list.find(d => d.name === 'Sync-Charlie') || {}).id || '';
		if (id) await app.write_crystal_data(id, crystal);
		return id;
	}, crystalOf('HERE-' + DMARK));
	await pushLanded(page, 'Sync-Charlie');

	/// Which of the four copies below is on this device, named by the one field they
	/// differ by. PARSED rather than compared as text: a copy that arrives as
	/// anything but the JSON a crystal now is fails here, where it reads as a merge
	/// that carried the wrong thing, rather than passing as bytes that merely match.
	const crystalNow = async () => {
		const text = await wasm((app, id) => app.read_crystal_data(id), cid);
		try { return JSON.parse(text).title; }
		catch (e) { return 'not JSON: ' + String(text).slice(0, 30); }
	};

	const shifted = await otherDeviceShifts(cid, crystalOf('OLDER-COPY'), -60000);
	const keptOlder = await crystalNow();
	await otherDeviceShifts(cid, crystalOf('EQUAL-COPY'), 0);
	const keptEqual = await crystalNow();
	await otherDeviceShifts(cid, crystalOf('NEWER-COPY'), 60000);
	const tookNewer = await crystalNow();
	check('the freshest-wins fixture reached the other device', shifted === 'ok', shifted);
	check('an older copy from another device does not overwrite this one',
		keptOlder === 'HERE-' + DMARK, keptOlder);
	check('an equally-stamped copy keeps what is here (the comparison is strict)',
		keptEqual === 'HERE-' + DMARK, keptEqual);
	check('a fresher copy from another device replaces this one',
		tookNewer === 'NEWER-COPY', tookNewer);

	// (4e) A device that predates all of this sends a v1 parcel: no `diamonds`,
	// no `diamondTombs`. It must apply as it always did, and touch nothing.
	const v1 = await page.evaluate(async (id) => {
		const state = await window.DaimondCore.collectSync();
		delete state.diamonds;
		delete state.diamondTombs;
		state.v = 1;
		const blob = await window.DaimondIdentity.wrap(JSON.stringify(state));
		await fetch('/api/sync', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ base_version: window.DaimondSync.version(), device: 'old-device', blob: blob }),
		});
		let threw = '';
		try { await window.DaimondCore.applySync(JSON.parse(await window.DaimondIdentity.unwrap(blob))); }
		catch (e) { threw = String(e && e.message || e); }
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return { threw, still: JSON.parse(await app.list_diamonds()).some(d => d.id === id) };
	}, cid);
	check('a v1 parcel (no diamonds section) applies without error',
		v1.threw === '', v1.threw);
	check('and leaves this device’s Diamonds exactly where they were', v1.still === true);

	// ── (4f) Tags across devices: the change that used to vanish ───────
	// A tag is content, but it is not WORK, so tagging deliberately leaves
	// `updated` alone -- the rail is ordered by it, and filing a Diamond must not
	// shuffle it to the top. The merge compared `updated`, so a tag-only change
	// was invisible to it: it never travelled, and the moment the other device
	// did anything stamped (a rename, a crystal edit) its untagged copy became
	// strictly fresher and REPLACED the tagged one wholesale. A real user lost
	// real tags to exactly that.
	//
	// Two devices are simulated on the one browser by swapping the store under
	// it: `export_diamond` is a device's disk, `import_diamond` lays it back down
	// verbatim (stamps included), and the merge that runs on each side is the
	// app's own `applySync`, not a copy of it written here.
	const TAG = 'keepsake';

	/// What this device holds, as import-ready packs: its disk.
	const diskNow = () => wasm(async (app) => {
		const out = [];
		for (const d of JSON.parse(await app.list_diamonds())) out.push(await app.export_diamond(d.id));
		return out;
	});

	/// Make the browser BE the device that disk came from.
	const becomeDevice = (disk) => wasm(async (app, disk) => {
		for (const d of JSON.parse(await app.list_diamonds())) await app.delete_diamond(d.id);
		for (const pack of disk) await app.import_diamond(pack);
		return JSON.parse(await app.list_diamonds()).length;
	}, disk);

	/// What this device would push, and what a pull does with what arrives.
	const parcelNow  = () => page.evaluate(() => window.DaimondCore.collectSync());
	const pullParcel = (p) => page.evaluate(async (p) => { await window.DaimondCore.applySync(p); }, p);

	/// One Diamond's row as the rail reads it.
	const rowOf  = (id) => wasm(async (app, id) =>
		JSON.parse(await app.list_diamonds()).find(d => d.id === id) || null, id);
	const orderNow = () => wasm(async (app) =>
		JSON.parse(await app.list_diamonds()).map(d => d.id).join(','));
	const entryOf = (p, id) => (p.diamonds || []).find(d => d.id === id) || {};
	const tagsOn  = (row) => ((row && row.tags) || []).join(',');

	// A clean two-device world: one Diamond to tag, one beside it so the rail has
	// an order to disturb.
	const two = await wasm(async (app, crystal) => {
		for (const d of JSON.parse(await app.list_diamonds())) await app.delete_diamond(d.id);
		const a = await app.create_diamond('Tag-Travel');
		const b = await app.create_diamond('Tag-Neighbour');
		await app.write_crystal_data(a, crystal);
		return { a, b };
	}, crystalOf('shared ground'));
	const disk0 = await diskNow();				// what BOTH devices last agreed on
	check('the tag fixture starts from one agreed copy on both devices',
		!!(two.a && two.b) && disk0.length === 2, 'packs=' + disk0.length);

	// (1) A tag-only change reaches the other device.
	await becomeDevice(disk0);
	const orderBefore = await orderNow();
	const rowBefore   = await rowOf(two.a);
	await wasm((app, arg) => app.set_tags(arg.id, JSON.stringify([arg.tag])), { id: two.a, tag: TAG });
	const rowTagged = await rowOf(two.a);
	check('tagging leaves `updated` alone, so the rail keeps its order',
		!!rowTagged && rowTagged.updated === rowBefore.updated && (await orderNow()) === orderBefore,
		'updated ' + rowBefore.updated + ' -> ' + (rowTagged && rowTagged.updated));
	const parcel1 = await parcelNow();
	const disk1   = await diskNow();			// device 1: tagged, nothing else touched

	await becomeDevice(disk0);					// device 2: the copy it last saw
	const beforePull2 = await rowOf(two.a);
	await pullParcel(parcel1);
	const gotTag = await rowOf(two.a);
	check('a tag-only change reaches the other device',
		tagsOn(gotTag) === TAG, 'tags=[' + tagsOn(gotTag) + ']');
	check('and arriving does not reorder the rail it arrived on',
		!!gotTag && gotTag.updated === beforePull2.updated && (await orderNow()) === orderBefore,
		'updated ' + beforePull2.updated + ' -> ' + (gotTag && gotTag.updated));

	// (2) The other device then works on the SAME Diamond. Its copy is fresher,
	// so it wins wholesale -- and because it had already received the tags, the
	// tags come back with the rename rather than being wiped by it.
	await wasm((app, id) => app.rename_diamond(id, 'Renamed-On-Two'), two.a);
	const parcel2 = await parcelNow();
	await becomeDevice(disk1);					// device 1 as it was: tagged, not renamed
	await pullParcel(parcel2);
	const afterWork = await rowOf(two.a);
	check('the other device working on that Diamond does not wipe the tags',
		!!afterWork && afterWork.name === 'Renamed-On-Two' && tagsOn(afterWork) === TAG,
		afterWork ? afterWork.name + ' [' + tagsOn(afterWork) + ']' : 'absent');
	check('an imported copy keeps the stamp it was sent with (an import is not working)',
		!!afterWork && afterWork.updated === (entryOf(parcel2, two.a).updated || 0),
		'here=' + (afterWork && afterWork.updated) + ' sent=' + entryOf(parcel2, two.a).updated);

	// (3) Two stores that have ALREADY diverged -- the state the user is in.
	// One side tagged the Diamond under a build that wrote no second stamp, so
	// both copies are stamped identically and neither is fresher than the other.
	const diverged = await page.evaluate(({ disk, id, tag }) => disk.map((p) => {
		const pack = JSON.parse(p);
		if (pack.id !== id) return p;
		const meta = JSON.parse(pack.files['.daimond/meta.json']);
		meta.tags = [tag];
		delete meta.touched;					// an old build: one stamp, and it did not move
		pack.files['.daimond/meta.json'] = JSON.stringify(meta);
		return JSON.stringify(pack);
	}), { disk: disk0, id: two.a, tag: TAG });

	await becomeDevice(diverged);				// device 1: tagged, stamps as they were
	const pD1 = await parcelNow();
	await becomeDevice(disk0);					// device 2: untagged, the same stamps
	const beforeConv = await rowOf(two.a);
	await pullParcel(pD1);
	const conv2 = await rowOf(two.a);
	check('two stores that already diverged converge: the untagged side gains the tag',
		tagsOn(conv2) === TAG, 'tags=[' + tagsOn(conv2) + ']');
	check('and converging still does not reorder the rail',
		!!conv2 && conv2.updated === beforeConv.updated,
		'updated ' + beforeConv.updated + ' -> ' + (conv2 && conv2.updated));
	const pD2 = await parcelNow();
	await becomeDevice(diverged);				// device 1 once more
	await pullParcel(pD2);
	const conv1 = await rowOf(two.a);
	check('and the side that had the tag keeps it when the union comes back',
		tagsOn(conv1) === TAG, 'tags=[' + tagsOn(conv1) + ']');

	// (4) A parcel from a device that predates the second stamp still merges by
	// the only stamp it carries.
	const oldStyle = await page.evaluate(({ p, id }) => {
		const e = (p.diamonds || []).find(d => d.id === id);
		if (!e) return p;
		const pack = JSON.parse(e.data);
		const meta = JSON.parse(pack.files['.daimond/meta.json']);
		meta.name    = 'Named-By-An-Old-Build';
		meta.updated = (e.updated || 0) + 60000;
		delete meta.touched;
		pack.files['.daimond/meta.json'] = JSON.stringify(meta);
		e.data    = JSON.stringify(pack);
		e.updated = meta.updated;
		delete e.touched;
		return p;
	}, { p: await parcelNow(), id: two.a });
	await pullParcel(oldStyle);
	const oldWon = await rowOf(two.a);
	check('a parcel with no second stamp still merges on the one it has',
		!!oldWon && oldWon.name === 'Named-By-An-Old-Build', oldWon ? oldWon.name : 'absent');

	// ── (4g) Links across devices: the same flaw, one file over ───────
	// A Diamond's links live in a sidecar inside its own directory, so they rode
	// the wholesale copy and nothing else -- and before `touched`, asserting or
	// removing a link stamped nothing at all, exactly as tagging did not. Two
	// stores could therefore hold different links at identical stamps for ever,
	// and the first thing either of them stamped replaced the other's links
	// wholesale. Tags were repaired by unioning them at equal stamps; this is
	// the same repair one file over, where a link's id is what says whether the
	// two copies mean the same link or two different ones.
	const EAST = 'link-east-1', WEST = 'link-west-1';

	/// One stored sidecar line, as a hand or an older build would leave it.
	const linkLine = (id, from, to, rel) => JSON.stringify({
		id: id, ts: 1700000000000, from: from, to: to, rel: rel, note: '', by: 'user',
	}) + '\n';

	/// Every link one Diamond's own sidecar holds, as `id/rel`, sorted. The id
	/// is in there because a union that re-created the links it took would look
	/// identical by relation alone, and would then duplicate on every round.
	const linksOf = (id) => wasm(async (app, id) =>
		JSON.parse(await app.all_links()).filter(l => l.owner === id)
			.map(l => l.id + '/' + l.rel).sort().join(','), id);

	/// A disk with one Diamond's sidecar replaced and its stamps left exactly as
	/// they were -- which is what a link written by a build that stamped nothing
	/// looks like from the outside.
	const withSidecar = (disk, id, text) => page.evaluate(({ disk, id, text }) => disk.map((p) => {
		const pack = JSON.parse(p);
		if (pack.id !== id) return p;
		pack.files['.daimond/links.jsonl'] = text;
		return JSON.stringify(pack);
	}), { disk: disk, id: id, text: text });

	const three = await wasm(async (app, crystal) => {
		for (const d of JSON.parse(await app.list_diamonds())) await app.delete_diamond(d.id);
		const a = await app.create_diamond('Link-Travel');
		const b = await app.create_diamond('Link-East');
		const c = await app.create_diamond('Link-West');
		await app.write_crystal_data(a, crystal);
		return { a: a, b: b, c: c };
	}, crystalOf('shared ground'));
	const diskL = await diskNow();				// what BOTH devices last agreed on
	const BOTH  = [EAST + '/east', WEST + '/west'].sort().join(',');
	const dev1  = await withSidecar(diskL, three.a,
		linkLine(EAST, 'diamond:' + three.a, 'diamond:' + three.b, 'east'));
	const dev2  = await withSidecar(diskL, three.a,
		linkLine(WEST, 'diamond:' + three.a, 'diamond:' + three.c, 'west'));

	await becomeDevice(dev1);
	const pL1 = await parcelNow();
	await becomeDevice(dev2);
	const beforeUnion = await rowOf(three.a);
	const linksBefore = await linksOf(three.a);
	check('the link fixture is two stores that disagree at one identical stamp',
		linksBefore === WEST + '/west'
			&& entryOf(pL1, three.a).touched === beforeUnion.touched,
		'here=[' + linksBefore + '] stamps ' + entryOf(pL1, three.a).touched
			+ ' / ' + beforeUnion.touched);

	await pullParcel(pL1);
	const unioned2 = await linksOf(three.a);
	const rowUnion = await rowOf(three.a);
	check('two stores that already diverged converge: both links, both ids kept',
		unioned2 === BOTH, '[' + unioned2 + ']');
	check('and unioning links does not reorder the rail either',
		!!rowUnion && rowUnion.updated === beforeUnion.updated,
		'updated ' + beforeUnion.updated + ' -> ' + (rowUnion && rowUnion.updated));
	check('writing the union stamps this side, so it can travel back',
		!!rowUnion && rowUnion.touched > beforeUnion.touched,
		'touched ' + beforeUnion.touched + ' -> ' + (rowUnion && rowUnion.touched));

	const pL2      = await parcelNow();			// device 2, unioned and stamped
	const diskBoth = await diskNow();
	await becomeDevice(dev1);					// device 1 as it was: one link
	await pullParcel(pL2);
	const unioned1 = await linksOf(three.a);
	const rowBack  = await rowOf(three.a);
	check('the union travels back, and the fresher side is taken wholesale',
		unioned1 === BOTH, '[' + unioned1 + ']');
	check('the import lays that stamp down verbatim, so the union cannot bounce',
		!!rowBack && rowBack.touched === entryOf(pL2, three.a).touched,
		'here=' + (rowBack && rowBack.touched) + ' sent=' + entryOf(pL2, three.a).touched);

	// Round three: the two sides now hold the same links at the same stamp, and
	// a union with nothing to add must write nothing at all -- otherwise each
	// side would stamp itself fresher than the other for ever.
	const pL3 = await parcelNow();
	await becomeDevice(diskBoth);
	const quietBefore = await rowOf(three.a);
	await pullParcel(pL3);
	const quietAfter  = await rowOf(three.a);
	check('once the two agree, the union writes nothing and moves no stamp',
		(await linksOf(three.a)) === BOTH
			&& !!quietAfter && quietAfter.touched === quietBefore.touched,
		'[' + (await linksOf(three.a)) + '] touched ' + quietBefore.touched
			+ ' -> ' + (quietAfter && quietAfter.touched));

	// A link removed since the fix DOES stamp the Diamond, so the removal is
	// strictly fresher and is taken wholesale. The union only ever sees copies
	// that are equally fresh, so it cannot be what puts a deleted link back.
	await becomeDevice(diskBoth);
	await wasm((app, arg) => app.remove_link(arg.id, arg.link), { id: three.a, link: EAST });
	const rowDel  = await rowOf(three.a);
	const pDel    = await parcelNow();
	const diskDel = await diskNow();
	check('removing a link stamps the Diamond, so the removal can travel at all',
		(await linksOf(three.a)) === WEST + '/west'
			&& !!rowDel && rowDel.touched > quietBefore.touched,
		'[' + (await linksOf(three.a)) + '] touched ' + quietBefore.touched
			+ ' -> ' + (rowDel && rowDel.touched));

	await becomeDevice(diskBoth);				// the other device: still holds both
	const pStale = await parcelNow();			// and would hand the deleted link back
	await pullParcel(pDel);
	const pDel2 = await parcelNow();			// that device, having taken the deletion
	check('a link deleted on another device goes here too',
		(await linksOf(three.a)) === WEST + '/west', '[' + (await linksOf(three.a)) + ']');

	await becomeDevice(diskDel);				// the device that did the deleting
	const staleRow = await rowOf(three.a);
	await pullParcel(pStale);
	// The outcome AND the mechanism: the copy that still holds the link is
	// strictly older, so it never reaches the union at all. That is the whole of
	// why unioning links cannot undo a deletion made since the stamp existed.
	check('and a stale copy that still holds it does not put it back',
		(await linksOf(three.a)) === WEST + '/west'
			&& entryOf(pStale, three.a).touched < staleRow.touched,
		'[' + (await linksOf(three.a)) + '] stale ' + entryOf(pStale, three.a).touched
			+ ' < here ' + staleRow.touched);
	const beforeAgreed = await rowOf(three.a);
	await pullParcel(pDel2);
	const afterAgreed  = await rowOf(three.a);
	check('nor does an equal-stamped copy that has already taken the deletion',
		(await linksOf(three.a)) === WEST + '/west'
			&& !!afterAgreed && afterAgreed.touched === beforeAgreed.touched,
		'[' + (await linksOf(three.a)) + '] touched ' + beforeAgreed.touched
			+ ' -> ' + (afterAgreed && afterAgreed.touched));

	// Every merge above left the store changed, so the engine has a push
	// scheduled. Let it land: a push still in flight when the next section stubs
	// the gateway is only rescheduled, and that section would then measure a chip
	// that says "Syncing…" for a reason that has nothing to do with it.
	await pushLanded(page, 'the merges of (4f)/(4g)');
	await page.waitForTimeout(500);

	// ── (6) A parcel the gateway refuses as too large is VISIBLE ───────
	// A 413 used to log to the console and stop, so sync simply stopped working
	// and nothing on the screen said so. The refusal is stubbed rather than
	// provoked: the real ceiling is 32 MB, and building that in the browser to
	// test a status chip would cost more than the behaviour it proves.
	const tooBig = await page.evaluate(async () => {
		const chip = () => {
			const c = document.getElementById('sync-chip');
			if (!c) return null;
			return {
				state:  c.dataset.state || '',
				text:   (c.querySelector('.stext') || {}).textContent || '',
				title:  c.title || '',
				shown:  c.style.display !== 'none',
			};
		};
		// A genuine local change, or the push is skipped as a no-op and nothing
		// reaches the (stubbed) gateway at all. Made BEFORE the stub goes on, so
		// nothing the change does can be answered by it.
		const changed = await window.__bump('too-big-1');
		const real = window.fetch;
		// Counted, so "the refusal was answered" is a measurement rather than an
		// assumption: the push below is driven until a parcel really leaves.
		let sent = 0;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/sync') !== -1 && o && o.method === 'POST') {
				sent++;
				return Promise.resolve(new Response(
					JSON.stringify({ ok: false, error: 'Sync blob exceeds the size limit' }),
					{ status: 413, headers: { 'content-type': 'application/json' } }));
			}
			return real.apply(this, arguments);
		};
		const refused = await window.__pushSent(() => sent, 'too-big-1');
		const stalled = chip();
		const api = window.DaimondSync.state ? window.DaimondSync.state() : null;
		window.fetch = real;
		// And a later successful push clears it — a stall that outlives its cause
		// is the same lie the other way round.
		//
		// Driven until the engine says the stall is gone, for the third time in
		// this file: a bare push() here found a round in flight, rescheduled, and
		// the chip was read still holding the 413 it had never been given a
		// chance to clear. Waiting on the STALL, not on a timer, so a stall that
		// genuinely never clears still fails.
		const cleared = await window.__bump('too-big-2');
		const tClear = Date.now();
		while (window.DaimondSync.state().stalled && Date.now() - tClear < 15000) {
			await window.DaimondSync.push();
			if (window.DaimondSync.state().stalled) await new Promise(r => setTimeout(r, 250));
		}
		const after = chip();
		return { changed, cleared, stalled, api, after, refused };
	});
	check('both local changes moved the parcel, so the 413 arm was reached at all',
		tooBig.changed.moved === true && tooBig.cleared.moved === true,
		[tooBig.changed.why, tooBig.cleared.why].filter(Boolean).join('; '));
	check('and a parcel really reached the refusal', tooBig.refused.sent === true,
		JSON.stringify(tooBig.refused));
	check('a 413 push shows a stalled state on the sync chip, held (not a flash)',
		!!(tooBig.stalled && tooBig.stalled.shown && tooBig.stalled.state === 'stalled'),
		JSON.stringify(tooBig.stalled));
	check('and says on hover that the parcel is too large, naming what makes it large',
		!!(tooBig.stalled && /too large/i.test(tooBig.stalled.title)
			&& /(Diamond|file)/i.test(tooBig.stalled.title)),
		(tooBig.stalled && tooBig.stalled.title || '').slice(0, 120));
	check('the engine reports the stall through its own surface too',
		!!(tooBig.api && tooBig.api.stalled === true), JSON.stringify(tooBig.api));
	check('a later successful push clears the stall',
		!!(tooBig.after && tooBig.after.state === 'synced'), JSON.stringify(tooBig.after));
	const lastLine = await page.evaluate(() => {
		const c = document.getElementById('sync-chip');
		return { title: c ? c.title : '', at: (window.DaimondSync.state ? DaimondSync.state().lastSyncedAt : 0) };
	});
	check('a successful sync records when it happened, and the chip can say so',
		lastLine.at > 0 && /synced/i.test(lastLine.title),
		JSON.stringify(lastLine).slice(0, 120));

	// ── (7) A parked tab converges on focus, without a reload ──────────
	// Sync fired on idle, on the tab going away, and on auth. A device left open
	// on the desk therefore never caught up until it was reloaded. Coming back to
	// a window is exactly the moment its owner expects to see the other device's
	// work.
	//
	// Measured with the wake channel SHUT. The gateway taps every other device of
	// the account when the mailbox moves, so with the channel open this device
	// converges on its own and the pull it makes is counted here as a focus pull:
	// the storm reads as noise and the trigger under test is never the thing that
	// answered. Section 13 turns the channel back on and tests it in its own
	// right, which is where that behaviour belongs.
	await page.evaluate(() => window.DaimondSync.wakeVia('off'));
	// And from a quiet engine: a push still armed when the focus fires holds
	// `inFlight`, and `focusPull` stands aside for a round already under way.
	// Longer than the push debounce, so anything armed has fired and finished.
	await page.waitForTimeout(4000);
	const focus = await page.evaluate(async () => {
		const mark = 'FOCUSMARK-' + Date.now();
		const state = await window.DaimondCore.collectSync();
		state.chats = (state.chats || []).concat([{
			id: 'focus-' + Date.now(), title: mark, updatedAt: Date.now(),
			messages: [{ role: 'user', content: mark, mid: 'fm-' + Date.now(), ts: Date.now() }],
		}]);
		const blob = await window.DaimondIdentity.wrap(JSON.stringify(state));
		const r = await fetch('/api/sync', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ base_version: window.DaimondSync.version(), device: 'other', blob: blob }),
		});
		const posted = r.status;
		// What the chat store holds, not what localStorage holds: the transcripts
		// are in IndexedDB, so the old read saw an empty string and "this device
		// did not already hold it" passed for a device that held nothing at all.
		const holds = () => JSON.stringify(window.DaimondCore.chatStore().stored()).indexOf(mark) !== -1;
		const before = holds();
		// Count the pulls, so a focus STORM is proved to coalesce into one.
		const real = window.fetch;
		let gets = 0;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/sync') !== -1 && (!o || !o.method || o.method === 'GET')) gets++;
			return real.apply(this, arguments);
		};
		for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('focus'));
		document.dispatchEvent(new Event('visibilitychange'));
		await new Promise(res => setTimeout(res, 2500));
		const after = holds();
		const storm = gets;
		// And a focus arriving straight back is refused by the throttle.
		window.dispatchEvent(new Event('focus'));
		await new Promise(res => setTimeout(res, 1200));
		const again = gets;
		window.fetch = real;
		return { posted, before, after, storm, again };
	});
	await page.evaluate(() => window.DaimondSync.wakeVia('ws'));
	check('the other device’s push landed on the mailbox', focus.posted === 200, 'HTTP ' + focus.posted);
	check('this device did not already hold it', focus.before === false);
	check('focus pulls the other device’s work in, with no reload', focus.after === true);
	check('a focus storm coalesces into ONE pull', focus.storm === 1, 'pulls=' + focus.storm);
	check('a focus straight afterwards is throttled, not another pull',
		focus.again === focus.storm, 'pulls=' + focus.again);

	// ── (8) Models and API keys travel with the work ───────────────────
	// A second device that holds the account holds the same identity, so a key
	// sealed under it opens on both. That is what makes carrying keys safe, and
	// it is the only reason this is allowed at all: what travels is `keyEnc`,
	// never a readable key.
	const M = await page.evaluate(async () => {
		const S = window.DaimondModels;
		const r = { api: typeof S.exportSync === 'function' && typeof S.applySync === 'function' };
		if (!r.api) return r;
		const now = Date.now();
		const PLAIN = 'LOCAL-KEY-' + '4242';
		const def0 = S.getDefault();		// put the app's own default back afterwards

		S.addProvider('groq', { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions' });
		await S.setKey('groq', PLAIN);

		const e1 = JSON.stringify(S.exportSync());
		const e2 = JSON.stringify(S.exportSync());
		r.deterministic  = e1 === e2;
		r.carriesKeyEnc  = !!(S.exportSync().providers.groq || {}).keyEnc;
		r.plaintextAbsent = e1.indexOf(PLAIN) === -1;
		r.noMintedRow    = !Object.prototype.hasOwnProperty.call(S.exportSync().providers, 'credits');

		// A provider only the other device has arrives; one only this device has
		// survives. (The union is what makes a second device usable at all.)
		await S.applySync({
			v: 2, def: { provider: '', model: '' }, defAt: 0,
			providers: { together: {
				name: 'Together AI', url: 'https://api.together.xyz/v1/chat/completions',
				models: ['m-b', 'm-a'], fetched: now, touched: now, keyEnc: 'REMOTE-SEALED',
			} },
		});
		let ex = S.exportSync();
		r.remoteArrived = !!ex.providers.together && ex.providers.together.keyEnc === 'REMOTE-SEALED';
		r.localSurvived = !!ex.providers.groq;
		r.modelsSorted  = !!ex.providers.together
			&& ex.providers.together.models.join(',') === 'm-a,m-b';

		// An OLDER remote copy must not clobber a newer local one.
		const stamp = ex.providers.groq.touched;
		await S.applySync({ v: 2, providers: { groq: {
			name: 'Stale', url: 'https://stale.example/v1/chat/completions',
			models: [], fetched: 0, touched: stamp - 60000, keyEnc: 'STALE-SEALED',
		} } });
		let g = S.exportSync().providers.groq;
		r.olderIgnored = g.keyEnc !== 'STALE-SEALED' && g.url.indexOf('groq.com') !== -1;

		// A fresher one wins, wholesale.
		await S.applySync({ v: 2, providers: { groq: {
			name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions',
			models: ['fresh-1'], fetched: now + 60000, touched: stamp + 60000, keyEnc: 'FRESH-SEALED',
		} } });
		g = S.exportSync().providers.groq;
		r.newerWon = g.keyEnc === 'FRESH-SEALED' && g.models.join(',') === 'fresh-1';

		// The live session keeps the key it is running on: a merge must not lock
		// a working device out mid-turn.
		r.sessionKeyKept = S.keyFor('groq') === PLAIN;

		// The default follows the freshest side, and only to somewhere real.
		S.setDefault('groq', 'fresh-1');
		const defAt = S.exportSync().defAt;
		await S.applySync({ v: 2, def: { provider: 'nowhere', model: 'x' }, defAt: defAt + 60000, providers: {} });
		r.defGuarded = S.getDefault().provider === 'groq';
		await S.applySync({ v: 2, def: { provider: 'together', model: 'm-a' }, defAt: defAt + 120000, providers: {} });
		r.defFreshest = S.getDefault().provider === 'together' && S.getDefault().model === 'm-a';
		await S.applySync({ v: 2, def: { provider: 'groq', model: 'fresh-1' }, defAt: 1, providers: {} });
		r.defOlderIgnored = S.getDefault().provider === 'together';

		// Enumeration order must not reach the wire: the push-skip comparison is a
		// string compare, so a store that enumerates differently would push for ever.
		S.addProvider('zzz-probe', { name: 'Z', url: 'https://z.example/v1/chat/completions' });
		S.addProvider('aaa-probe', { name: 'A', url: 'https://a.example/v1/chat/completions' });
		const ks = Object.keys(S.exportSync().providers);
		r.sortedKeys = JSON.stringify(ks) === JSON.stringify(ks.slice().sort());

		// An old parcel carries no models section at all, and must still apply.
		let threw = '';
		try {
			await S.applySync(undefined);
			await S.applySync({});
			await S.applySync({ v: 1 });
		} catch (e) { threw = String((e && e.message) || e); }
		r.oldParcelNoop = threw === '' && !!S.exportSync().providers.groq;

		['groq', 'together', 'zzz-probe', 'aaa-probe'].forEach(function (id) { S.removeProvider(id); });
		S.setDefault(def0.provider, def0.model);
		return r;
	});
	check('models.js offers exportSync/applySync for the parcel', M.api === true);
	check('two exports of one store are byte-identical', M.deterministic === true);
	check('the export lists providers in sorted order (enumeration never reaches the wire)',
		M.sortedKeys === true);
	check('a model list travels sorted, for the same reason', M.modelsSorted === true);
	check('a sealed key travels', M.carriesKeyEnc === true);
	check('a readable key never does', M.plaintextAbsent === true);
	check('the minted credits row does not travel (it is minted per device)',
		M.noMintedRow === true);
	check('a provider only the other device has arrives, key and all', M.remoteArrived === true);
	check('a provider only this device has survives the merge', M.localSurvived === true);
	check('an older remote provider does not clobber a newer local one', M.olderIgnored === true);
	check('a fresher remote provider replaces the local one', M.newerWon === true);
	check('the running session keeps the key it holds', M.sessionKeyKept === true);
	check('the default follows the freshest side', M.defFreshest === true);
	check('an older default is ignored', M.defOlderIgnored === true);
	check('a default naming a provider nobody has is refused', M.defGuarded === true);
	check('a parcel with no models section applies as a no-op', M.oldParcelNoop === true);

	// The plaintext-at-rest key exists only where there is no identity to seal
	// under — and sync only runs WITH one. It is still checked, because the store
	// on disk may predate the identity and the export must not carry it out.
	const atRest = await page.evaluate(() => {
		const S = window.DaimondModels;
		if (typeof S.exportSync !== 'function') return { absent: false, noField: false };
		const raw = localStorage.getItem('daimond-models-v2');
		localStorage.setItem('daimond-models-v2', JSON.stringify({
			v: 2, def: { provider: 'plainprov', model: 'm' },
			providers: { plainprov: {
				name: 'Plain', url: 'https://plain.example/v1/chat/completions',
				key: 'AT-REST-PLAIN-9876', keyEnc: '', models: ['m'], fetched: 1, touched: 1,
			} },
		}));
		S.init({});
		const ex = S.exportSync();
		const out = {
			absent:  JSON.stringify(ex).indexOf('AT-REST-PLAIN-9876') === -1,
			noField: !Object.prototype.hasOwnProperty.call(ex.providers.plainprov || {}, 'key'),
		};
		if (raw === null) localStorage.removeItem('daimond-models-v2');
		else localStorage.setItem('daimond-models-v2', raw);
		S.init({});
		return out;
	});
	check('a plaintext-at-rest key is left behind by the export',
		atRest.absent === true && atRest.noField === true, JSON.stringify(atRest));

	// ── (9) A provider deleted here stays deleted ──────────────────────
	// The provider merge is a UNION, so a row removed on this device and still
	// held on the other one was handed straight back on the next pull -- key and
	// all -- and removing it was something the user could not make stick. An
	// absence still means "that device never had it"; a TOMBSTONE means "it is
	// gone", and the stamps decide between a deletion and a re-add.
	const T = await page.evaluate(async () => {
		const S = window.DaimondModels;
		const r = {};
		const now = Date.now();
		S.addProvider('tombprov', { name: 'Tombed', url: 'https://tomb.example/v1/chat/completions' });
		const born = S.exportSync().providers.tombprov.touched;
		S.removeProvider('tombprov');
		let ex = S.exportSync();
		r.gone   = !ex.providers.tombprov;
		r.tombed = !!(ex.tombs && ex.tombs.tombprov && ex.tombs.tombprov >= born);
		// The other device still has it, and offers it back.
		await S.applySync({ v: 2, providers: { tombprov: {
			name: 'Tombed', url: 'https://tomb.example/v1/chat/completions',
			models: [], fetched: 0, touched: born, keyEnc: 'RESURRECTED',
		} } });
		r.stayedGone = !S.exportSync().providers.tombprov;
		// A deletion made on the OTHER device reaches this one: the tombstone
		// arrives without the row, and the row here goes.
		S.addProvider('otherdev', { name: 'Other', url: 'https://other.example/v1/chat/completions' });
		await S.applySync({ v: 2, providers: {}, tombs: { otherdev: Date.now() + 1000 } });
		r.remoteDeleteHonoured = !S.exportSync().providers.otherdev;
		// A re-add AFTER the deletion wins by its stamp -- deleting a provider must
		// not make its id unusable for a week.
		S.addProvider('tombprov', { name: 'Back', url: 'https://back.example/v1/chat/completions' });
		r.readdSurvives = !!S.exportSync().providers.tombprov;
		await S.applySync({ v: 2, providers: {}, tombs: { tombprov: now - 1000 } });
		r.readdSurvivesMerge = !!S.exportSync().providers.tombprov;
		S.removeProvider('tombprov');
		return r;
	});
	check('removing a provider takes it out of the store', T.gone === true);
	check('and leaves a tombstone in the parcel', T.tombed === true);
	check('a deleted provider handed back by the other device does not come back',
		T.stayedGone === true);
	check('a provider deleted on the other device is deleted here',
		T.remoteDeleteHonoured === true);
	check('a provider re-added after its deletion survives', T.readdSurvives === true);
	check('and survives a merge carrying the older tombstone', T.readdSurvivesMerge === true);

	// ── (10) The two standing refusals, on one chip, in one order ──────
	// 402 (not on the tier) and 413 (parcel too large) both outlive the round
	// that found them, and both are reported on the chip alone. So neither may be
	// painted over by an ordinary round -- a pull SUCCEEDING used to show
	// "Synced" on a device whose pushes were paused by a 402, and a pull FAILING
	// used to blank a refusal that was still perfectly true. And the chip has to
	// lead somewhere: "Sync off" names Pro, and Pro is bought in Credits.
	const gate = await page.evaluate(async () => {
		const chip = () => {
			const c = document.getElementById('sync-chip');
			if (!c) return null;
			return { state: c.dataset.state || '', title: c.title || '',
				text: (c.querySelector('.stext') || {}).textContent || '',
				shown: c.style.display !== 'none' };
		};
		// Every refusal below is only reached if a parcel is actually sent, so each
		// change records whether it moved the parcel and the file asserts on it.
		const bumps = [];
		const bump = async (tag) => {
			const r = await window.__bump(tag);
			bumps.push(tag + ': ' + (r.moved ? 'moved' : r.why));
			return r.moved;
		};
		const real = window.fetch;
		// Refusals ANSWERED, not merely offered. A push that finds a round in
		// flight reschedules and returns, so a single call could leave every
		// assertion below reporting on a stub nothing ever reached.
		let sent = 0;
		const stub = (post, get) => {
			window.fetch = function (u, o) {
				const url = String((u && u.url) || u || '');
				const isSync = url.indexOf('/api/sync') !== -1;
				const method = (o && o.method) || 'GET';
				const code = isSync ? (method === 'POST' ? post : get) : 0;
				if (code) {
					if (method === 'POST') sent++;
					return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'stub' }),
						{ status: code, headers: { 'content-type': 'application/json' } }));
				}
				return real.apply(this, arguments);
			};
		};
		const out = {};
		// A 413 first: the parcel is too large, and the chip stalls.
		stub(413, 0);
		await bump('gate-1');
		out.sent413 = await window.__pushSent(() => sent, 'gate-1');
		out.stalled = chip();
		// Then a 402 on top of it. Not entitled outranks too large: an account
		// that may not sync at all cannot act on a parcel being oversized.
		stub(402, 0);
		await bump('gate-2');
		sent = 0;
		out.sent402 = await window.__pushSent(() => sent, 'gate-2');
		out.off = chip();
		// A pull that WORKS must not paint "Synced" over it.
		window.fetch = real;
		await window.DaimondSync.pull();
		out.afterGoodPull = chip();
		// Nor may a pull that fails simply hide it.
		stub(0, 500);
		await window.DaimondSync.pull();
		out.afterBadPull = chip();
		window.fetch = real;
		// Clicking it goes where the sentence leads.
		document.getElementById('sync-chip').click();
		await new Promise(r => setTimeout(r, 400));
		const cv = document.getElementById('admin-credits');
		out.creditsOpen = !!(cv && cv.style.display !== 'none' && cv.offsetParent !== null);
		out.creditsNote = (document.getElementById('credits-note') || {}).textContent || '';
		if (window.DaimondAdmin && DaimondAdmin.close) DaimondAdmin.close();
		// The tier comes back: the stall underneath it is still true and shows again.
		window.DaimondSync.recheck();
		await new Promise(r => setTimeout(r, 1200));
		out.afterRecheck = chip();
		// And a push that fits clears the lot, so nothing below runs under a stall.
		await bump('gate-3');
		await window.DaimondSync.push();
		await new Promise(r => setTimeout(r, 400));
		out.cleared = chip();
		out.api = window.DaimondSync.state();
		out.bumps = bumps;
		return out;
	});
	check('each refusal below was answered to a parcel that really left',
		allMoved(gate.bumps), (gate.bumps || []).join(' | '));
	check('and both refusals were reached by a parcel that was actually SENT',
		gate.sent413.sent === true && gate.sent402.sent === true,
		'413 ' + JSON.stringify(gate.sent413) + ', 402 ' + JSON.stringify(gate.sent402));
	check('a 413 stalls the chip', gate.stalled && gate.stalled.state === 'stalled',
		JSON.stringify(gate.stalled));
	check('a 402 on top of a stall shows "Sync off" — not entitled outranks too large',
		!!(gate.off && gate.off.state === 'off' && gate.off.shown), JSON.stringify(gate.off));
	check('and says on hover that it is Pro, and that the chip can be clicked',
		!!(gate.off && /Pro/.test(gate.off.title) && /Credits/i.test(gate.off.title)),
		(gate.off && gate.off.title || '').replace(/\n/g, ' | ').slice(0, 140));
	check('a pull that WORKS does not paint "Synced" over a device whose pushes are off',
		!!(gate.afterGoodPull && gate.afterGoodPull.state === 'off'),
		JSON.stringify(gate.afterGoodPull));
	check('a pull that FAILS does not hide the refusal either',
		!!(gate.afterBadPull && gate.afterBadPull.state === 'off' && gate.afterBadPull.shown),
		JSON.stringify(gate.afterBadPull));
	check('clicking the off chip opens the Pro offer in Credits',
		gate.creditsOpen === true && gate.creditsNote.length > 0,
		'open=' + gate.creditsOpen + ' note=' + JSON.stringify(gate.creditsNote.slice(0, 60)));
	check('when the tier comes back the stall underneath is still reported',
		!!(gate.afterRecheck && gate.afterRecheck.state === 'stalled'),
		JSON.stringify(gate.afterRecheck));
	check('and a push that fits clears both',
		!!(gate.cleared && gate.cleared.state === 'synced')
		&& gate.api.stalled === false && gate.api.entitled === true,
		JSON.stringify(gate.cleared) + ' ' + JSON.stringify(gate.api));

	// ── (11) Work done OUTSIDE a turn travels on its own ───────────────
	// Pushes fired on exactly two things: a turn ending, and the tab going away.
	// Most of what a person does to a Diamond is neither. A user renamed a
	// Diamond on one machine, left the tab open and focused, and the new name
	// never reached the other machine — because nothing ever scheduled the push.
	// The other device's focus pull was working perfectly; the mailbox simply
	// still held the old name.
	//
	// Measured from a QUIET engine. A push that finds one in flight reschedules,
	// so `pushLanded` leaves a timer armed, and that stray timer would carry the
	// rename and hide the whole bug — which is exactly what it did the first time
	// this was written.

	/// Let anything already armed drain, and return once the version has stopped
	/// moving. A flat sleep is not enough: what has to be true is that the engine
	/// is quiet, not that some number of milliseconds passed.
	const quiesce = async (pg, ms = 20000) => {
		let last = -1, stable = Date.now();
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const v = await pg.evaluate(() => window.DaimondSync.state().version);
			if (v !== last) { last = v; stable = Date.now(); }
			else if (Date.now() - stable > 5000) return last;
			await pg.waitForTimeout(300);
		}
		return last;
	};

	/// Wait for the engine to push on its OWN. Deliberately never calls push():
	/// the point of the whole section is that the change leaves without asking.
	const ownPush = async (pg, v0, ms = 25000) => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const v = await pg.evaluate(() => window.DaimondSync.state().version);
			if (v > v0) return { landed: true, took: Date.now() - t0 };
			await pg.waitForTimeout(250);
		}
		return { landed: false, took: Date.now() - t0 };
	};

	/// Count POSTs to the mailbox, so "nothing was sent" is a measurement.
	const countPosts = (pg) => pg.evaluate(() => {
		window.__syncPosts = 0;
		const real = window.__syncRealFetch || window.fetch;
		window.__syncRealFetch = real;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/sync') !== -1 && o && o.method === 'POST') window.__syncPosts++;
			return real.apply(this, arguments);
		};
	});
	const posts    = (pg) => pg.evaluate(() => window.__syncPosts | 0);
	const unstub   = (pg) => pg.evaluate(() => {
		if (window.__syncRealFetch) { window.fetch = window.__syncRealFetch; window.__syncRealFetch = null; }
	});

	/// Rename a Diamond the way a person does: double-click its name in the rail,
	/// type into the dialog, press the button. No turn is taken and the tab is
	/// never hidden — which is the whole of the report.
	const renameDiamond = async (from, to) => {
		const found = await page.evaluate((nm) => {
			const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
				.find(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === nm);
			if (!box) return false;
			box.querySelector('.session-box-name')
				.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
			return true;
		}, from);
		if (!found) return 'not in the rail';
		await page.waitForSelector('.dlg-card', { timeout: 8000 });
		await page.evaluate((nm) => {
			const card = [...document.querySelectorAll('.dlg-card')].find(c => c.getClientRects().length);
			const inp = card.querySelector('input.dlg-input');
			inp.value = nm;
			inp.dispatchEvent(new Event('input', { bubbles: true }));
			card.querySelector('.dlg-ok').click();
		}, to);
		await page.waitForTimeout(600);
		return 'ok';
	};

	/// What the MAILBOX holds, decrypted — what the other device would receive if
	/// it pulled this instant. The Diamond names, and what the trash says about
	/// each of them, because since the trash those are two different facts about
	/// the same Diamond and a delete moves only the second.
	const inMailbox = () => page.evaluate(async () => {
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		if (!j.present) return { names: [], trash: {} };
		try {
			const st = JSON.parse(await window.DaimondIdentity.unwrap(j.blob));
			return {
				names: (st.diamonds || []).map((d) => {
					try { return JSON.parse(JSON.parse(d.data).files['.daimond/meta.json']).name; }
					catch (e) { return '?'; }
				}),
				trash: (st.trash && st.trash.items) || {},
			};
		} catch (e) { return { names: ['<undecryptable>'], trash: {} }; }
	});
	const namesInMailbox = async () => (await inMailbox()).names;

	await newDiamond('Quiet-Alpha');
	await pushLanded(page, 'Quiet-Alpha');
	const vQuiet = await quiesce(page);
	check('the engine is quiet before the measurement, so nothing stray can carry it',
		vQuiet > 0, 'version=' + vQuiet);

	await countPosts(page);
	const renamed = await renameDiamond('Quiet-Alpha', 'Quiet-Renamed');
	const own = await ownPush(page, vQuiet);
	const mailNames = await namesInMailbox();
	check('a Diamond is renamed through the rail, with no turn and the tab visible',
		renamed === 'ok', renamed);
	check('and the rename pushes ON ITS OWN — no turn, no tab-hide, no explicit push',
		own.landed === true, 'version ' + vQuiet + ' -> '
			+ (await page.evaluate(() => window.DaimondSync.state().version))
			+ ' after ' + own.took + 'ms, posts=' + (await posts(page)));
	check('so the mailbox holds the NEW name, which is all the other device can read',
		mailNames.includes('Quiet-Renamed') && !mailNames.includes('Quiet-Alpha'),
		JSON.stringify(mailNames));
	check('and it took ONE parcel, not one per keystroke', (await posts(page)) === 1,
		'posts=' + (await posts(page)));

	// The receiving half, end to end: a device that has never seen the rename
	// pulls it. (Pull-on-focus is proved in section 7; what is proved here is
	// that there is now something on the mailbox for it to find.)
	const second = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		for (const d of JSON.parse(await app.list_diamonds())) await app.delete_diamond(d.id);
		localStorage.removeItem('daimond-sync-version');
		await window.DaimondSync.pull();
		return JSON.parse(await app.list_diamonds()).map(d => d.name);
	});
	check('a second device pulls the rename in', second.includes('Quiet-Renamed'),
		JSON.stringify(second));

	// A second real mutation path through the same funnel: deleting through the
	// rail, which writes the TRASH RECORD that has to travel with it.
	//
	// Not a tombstone, and not an absence. (4b) settled what a rail delete now
	// means -- the Diamond is trashed, its bytes still travel so the other device
	// can restore it, and only destroying it from the trash tombstones it -- and
	// this check went on asserting the contract that replaced. It failed on every
	// run, naming the Diamond it had just been told would still be there.
	await quiesce(page);
	await countPosts(page);
	const vDel = await page.evaluate(() => window.DaimondSync.state().version);
	const quietId = await wasm(async (app) =>
		(JSON.parse(await app.list_diamonds()).find(d => d.name === 'Quiet-Renamed') || {}).id || '');
	const dropped = await removeDiamond('Quiet-Renamed');
	const delPush = await ownPush(page, vDel);
	const afterDel = await inMailbox();
	const delRec = afterDel.trash[quietId] || null;
	check('deleting a Diamond in the rail also travels without a turn',
		dropped === 'ok' && delPush.landed === true,
		dropped + ', after ' + delPush.took + 'ms');
	// The other Diamonds are named too, so an empty or unreadable mailbox cannot
	// pass this by holding nothing.
	check('and the mailbox says it is in the trash, while still holding the rest',
		!!quietId && !!delRec && delRec.at > delRec.back && afterDel.names.includes('Link-Travel'),
		'id=' + quietId + ' rec=' + JSON.stringify(delRec) + ' ' + JSON.stringify(afterDel.names));

	// A nudge is not a poll, and this is the failure mode the fix itself could
	// have: collectSync() persists the chats on its way past, so if THAT nudged,
	// every push would arm the next one for ever.
	//
	// Counted as parcels PACKED, not as requests sent. An unchanged parcel is
	// skipped before any request is made, so a POST counter watches a perfectly
	// quiet network while the app re-exports every Diamond every 2.5 seconds —
	// measured at six packs in fifteen seconds with the guard removed, and one
	// with it. Both numbers are checked, because both costs are real.
	await quiesce(page);
	// Refresh this device's roster stamp first: it is rewritten when it goes
	// stale (five minutes), and a run that crossed that boundary here would see
	// a genuinely changed parcel and read it as a spurious push.
	await page.evaluate(async () => { await window.DaimondCore.collectSync(); return true; });
	await countPosts(page);
	const idle = await page.evaluate(async () => {
		let packed = 0;
		const real = window.DaimondCore.collectSync;
		window.DaimondCore.collectSync = function () { packed++; return real.apply(this, arguments); };
		window.DaimondSync.nudge();
		await new Promise(r => setTimeout(r, 15000));
		window.DaimondCore.collectSync = real;
		return { packed: packed, posts: window.__syncPosts | 0 };
	});
	check('a nudge with nothing changed sends no parcel at all', idle.posts === 0,
		'posts=' + idle.posts);
	check('and packing it does not arm the next one — the debounce is not a poll',
		idle.packed <= 1, 'parcels packed in 15s = ' + idle.packed);

	// A nudge must not walk through the standing refusals either. 402 stops
	// pushes until the tier is rechecked, and a mutation arriving afterwards
	// must not quietly restart them or repaint the chip.
	const refusal = await page.evaluate(async () => {
		const chip = () => {
			const c = document.getElementById('sync-chip');
			return c ? { state: c.dataset.state || '', shown: c.style.display !== 'none' } : null;
		};
		// One real change, made before the stub so nothing it does is answered by
		// it, and asserted on: without it the push below is skipped and the 402
		// arm is never reached at all.
		const changed = await window.__bump('nudge-402');
		const real = window.__syncRealFetch || window.fetch;
		window.__syncRealFetch = real;
		let sent = 0;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/sync') !== -1 && o && o.method === 'POST') {
				sent++;
				return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'stub' }),
					{ status: 402, headers: { 'content-type': 'application/json' } }));
			}
			return real.apply(this, arguments);
		};
		// Pushed, refused: the engine is now paused on a 402. Driven until one
		// really goes -- a push over a round already in flight is only
		// rescheduled, and the pause below would then be nobody's.
		const reached = await window.__pushSent(() => sent, 'nudge-402');
		const paused = { chip: chip(), entitled: window.DaimondSync.state().entitled, reached };
		// Now a mutation of the kind that nudges. It must change nothing.
		const before = sent;
		await window.DaimondCore.collectSync();	// persistChats() runs on the way past
		window.DaimondSync.nudge();
		await new Promise(r => setTimeout(r, 7000));
		const out = { paused, after: chip(), tried: sent - before, changed: changed,
			entitled: window.DaimondSync.state().entitled };
		window.fetch = real;
		window.__syncRealFetch = null;
		return out;
	});
	check('the change that provoked the 402 really left this device',
		refusal.changed.moved === true, refusal.changed.why);
	check('a 402 pauses pushes and says so on the chip',
		!!(refusal.paused.chip && refusal.paused.chip.state === 'off')
			&& refusal.paused.entitled === false && refusal.paused.reached.sent === true,
		JSON.stringify(refusal.paused));
	check('a nudge afterwards does not restart them behind the refusal',
		refusal.tried === 0 && refusal.entitled === false, 'attempts=' + refusal.tried);
	check('nor repaint the chip over it',
		!!(refusal.after && refusal.after.state === 'off' && refusal.after.shown),
		JSON.stringify(refusal.after));

	// Put the engine back, so nothing below runs paused.
	await unstub(page);
	await page.evaluate(() => window.DaimondSync.recheck());
	await page.waitForTimeout(1500);
	await pushLanded(page, 'the tier coming back');
	const back = await page.evaluate(() => window.DaimondSync.state());
	check('and the tier coming back lifts it, with the engine syncing again',
		back.entitled === true && back.stalled === false, JSON.stringify(back));

	// (9) The device roster travels, so a user can be told whether their account
	// is on more than one device.
	//
	// Nothing else can tell them. Pairing hands the second device the SAME
	// keypair, so the gateway sees one user and cannot count devices, and the
	// parked bundle is deleted on redeem, so there is no server record of the
	// pairing either. The count therefore has to come out of the parcel, which
	// means it has to survive the real encrypted round trip -- and the roster must
	// stay INSIDE the sealed blob while it does. The second device is simulated
	// the way this file simulates one everywhere else: by swapping what this
	// browser holds.
	const DEV_B = 'bbbb2222cccc3333';
	const roster0 = await page.evaluate(() => ({
		self: localStorage.getItem('daimond-device-id'),
		reg:  localStorage.getItem('daimond-devices') || '{}',
	}));
	check('this device is on its own roster before any of it travels',
		/^[0-9a-f]{16}$/.test(roster0.self || '') && !!JSON.parse(roster0.reg)[roster0.self],
		roster0.reg.slice(0, 120));

	await pushLanded(page, 'the device roster');
	const sealed = await page.evaluate(async () => {
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		return j.blob || '';
	});
	check('the roster rides inside the sealed blob — the gateway is told no device name',
		!sealed.includes('device') && !sealed.includes('Chromium') && !sealed.includes(roster0.self),
		'blob ' + sealed.length + ' bytes');

	// Device B: another install of the app, which has never seen this roster.
	const bSaw = await page.evaluate(async (b) => {
		localStorage.setItem('daimond-device-id', b);
		localStorage.setItem('daimond-devices', '{}');
		await window.DaimondSync.pull();
		return JSON.parse(localStorage.getItem('daimond-devices') || '{}');
	}, DEV_B);
	check('the second device pulls and learns of the first',
		!!bSaw[roster0.self], Object.keys(bSaw).join(','));
	await pushLanded(page, 'device B line');

	// Device A again, knowing only itself, exactly as it was left.
	const aSaw = await page.evaluate(async (r) => {
		localStorage.setItem('daimond-device-id', r.self);
		localStorage.setItem('daimond-devices', r.reg);
		await window.DaimondSync.pull();
		return JSON.parse(localStorage.getItem('daimond-devices') || '{}');
	}, roster0);
	check('and the first device pulls and learns of the second',
		!!aSaw[DEV_B], Object.keys(aSaw).join(','));
	check('so both ends see BOTH devices — the account is visibly on two',
		!!aSaw[roster0.self] && !!aSaw[DEV_B] && Object.keys(aSaw).length === 2,
		JSON.stringify(aSaw).slice(0, 200));
	const lineB = aSaw[DEV_B] || {};
	check('each line carries a name and a last-seen, so the list can be read',
		!!lineB.name && lineB.seen > 1.7e12 && lineB.created > 1.7e12,
		JSON.stringify(lineB));

	// A name the USER gives a device, the whole way round. The second device
	// names the FIRST one's line -- which is the case that cannot work if the
	// name rides on `seen`, because the first device refreshes its own line and
	// would win it straight back. And the name is the user's own words, so it
	// must reach the other device WITHOUT the gateway ever holding it in the
	// clear: sync.js sends the coarse derived description as the mailbox label
	// and nothing else, so the typed name may exist only inside the sealed blob.
	const rename = await page.evaluate(async (r) => {
		const wait = (n) => new Promise(x => setTimeout(x, n));
		const mine = JSON.parse(localStorage.getItem('daimond-devices') || '{}');
		const out  = { aBefore: mine[r.self] };
		// Device B, naming device A's line through the drawer, as a user would.
		localStorage.setItem('daimond-device-id', r.b);
		DaimondAdmin.home();
		const row = [...document.querySelectorAll('#admin-home .device-row')]
			.find(x => ((x.querySelector('.device-id') || {}).textContent || '') === r.self.slice(-4));
		const btn = row && row.querySelector('.device-rename');
		if (!btn) { out.renamed = false; return out; }
		btn.click();
		await wait(80);
		const input = document.querySelector('.dlg .dlg-input');
		const ok    = document.querySelector('.dlg .dlg-ok');
		if (!input || !ok) { out.renamed = false; return out; }
		input.value = 'Kitchen laptop';
		ok.click();
		await wait(200);
		DaimondAdmin.close();
		out.renamed = (JSON.parse(localStorage.getItem('daimond-devices') || '{}')[r.self] || {}).label
			=== 'Kitchen laptop';
		return out;
	}, { self: roster0.self, b: DEV_B });
	check('the second device can name the first one\'s line', rename.renamed === true,
		JSON.stringify(rename.aBefore));

	await pushLanded(page, 'the typed device name');
	const sealedNamed = await page.evaluate(async () => {
		const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const j = await r.json();
		return { blob: j.blob || '', label: j.device || j.label || '' };
	});
	check('the name the user typed is inside the sealed blob and nowhere else on the wire',
		!sealedNamed.blob.includes('Kitchen') && !sealedNamed.blob.includes('laptop')
			&& !/kitchen/i.test(JSON.stringify(sealedNamed.label)),
		'blob ' + sealedNamed.blob.length + ' bytes, mailbox label ' + JSON.stringify(sealedNamed.label));

	// Back to device A, with the roster it had before any of this: its own line
	// is the FRESHER one, and it still has to take the name.
	const aNamed = await page.evaluate(async (r) => {
		localStorage.setItem('daimond-device-id', r.self);
		localStorage.setItem('daimond-devices', r.reg);
		const before = JSON.parse(r.reg)[r.self];
		await window.DaimondSync.pull();
		const after = JSON.parse(localStorage.getItem('daimond-devices') || '{}')[r.self];
		DaimondAdmin.home();
		const rows = [...document.querySelectorAll('#admin-home .device-row')]
			.map(x => x.innerText.replace(/\s+/g, ' ').trim());
		DaimondAdmin.close();
		return { before: before, after: after, rows: rows };
	}, { self: roster0.self, reg: JSON.stringify(aSaw) });
	check('and the first device pulls the name for ITSELF, though its own line is the fresher one',
		!!aNamed.after && aNamed.after.label === 'Kitchen laptop'
			&& aNamed.after.seen >= aNamed.before.seen,
		JSON.stringify(aNamed.after));
	check('so the drawer there now reads the name its owner gave it',
		aNamed.rows.some(x => /Kitchen laptop/.test(x) && /this device/i.test(x)),
		aNamed.rows.join(' | '));
	// The drawer is the surface the user actually reads.
	const shown = await page.evaluate(() => {
		DaimondAdmin.home();
		const rows = [...document.querySelectorAll('#admin-home .device-row')]
			.map(r => r.innerText.replace(/\s+/g, ' ').trim());
		DaimondAdmin.close();
		return rows;
	});
	check('and the Admin drawer lists them both, with this one marked',
		shown.length === 2 && shown.filter(r => /this device/i.test(r)).length === 1,
		shown.join(' | '));

	// (5) The export bundle carries the salt (without it, no second device could decrypt).
	const bundle = await page.evaluate(() => {
		const b = window.DaimondIdentity.exportBundle();
		return b ? { hasSalt: !!b.salt, hasPriv: !!b.priv, hasPub: !!b.pub, v: b.v } : null;
	});
	check('identity export bundle carries salt + wrapped key + pubkey',
		!!bundle && bundle.hasSalt && bundle.hasPriv && bundle.hasPub && bundle.v === 1);

	// ── (10) One bad section must not swallow the parcel ───────────────
	// A parcel is written by ANOTHER device: a version behind, a version ahead,
	// or halfway through a write when it was packed. Every section of the merge
	// is meant to be best effort, so that one of them failing costs only itself.
	// The TOP of applySync was not: the chats ran outside any guard, so a
	// transcript that was not a list threw out of the whole function and the
	// Diamonds, the files, the providers and the mailboxes below it were never
	// reached. The pull that called it logged one console.debug line -- hidden in
	// DevTools unless Verbose is on -- adopted the version, and went on to push
	// this device's state over the top of the parcel it had just failed to merge.
	const poison = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const id   = await app.create_diamond('Poison-Local');
		const pack = JSON.parse(await app.export_diamond(id));
		const meta = JSON.parse(pack.files['.daimond/meta.json']);
		meta.name    = 'Poison-Survivor';
		meta.touched = Date.now() + 60000;			// the other device's copy is the fresher one
		pack.files['.daimond/meta.json'] = JSON.stringify(meta);
		const parcel = await window.DaimondCore.collectSync();
		parcel.diamonds = [{ id: id, updated: meta.updated || 0, touched: meta.touched,
			model: null, data: JSON.stringify(pack) }];
		// A chat THIS DEVICE ALREADY HOLDS, arriving with a transcript that is
		// not a list. A chat nobody here has seen is simply stored; one that is
		// held is MERGED, and the union walks the transcript -- so this is where
		// a parcel written by another build, or half written when it was packed,
		// actually reaches. Nothing is left behind by it: the throw happens
		// before the merged chats are written back.
		// From the store the chats actually live in. Read out of localStorage, this
		// was always an empty list: the parcel was never poisoned, and the three
		// checks below passed on a merge that had nothing to fail at.
		const store   = window.DaimondCore.chatStore();
		const held    = store.stored();
		const victim  = held.length ? held[0].id : '';
		parcel.chats  = (parcel.chats || []).map(c =>
			(c && c.id === victim) ? Object.assign({}, c, { messages: 'not-a-list' }) : c);
		let threw = '', report = null;
		try { report = await window.DaimondCore.applySync(parcel); }
		catch (e) { threw = String(e && e.message || e); }
		const row  = JSON.parse(await app.list_diamonds()).find(d => d.id === id) || null;
		const kept = store.stored();
		return { threw, report, victim, name: row ? row.name : '(gone)',
			chatsIntact: kept.length === held.length
				&& kept.every(c => Array.isArray(c.messages)) };
	});
	check('the poisoned parcel names a chat this device really holds', !!poison.victim, poison.victim);
	check('a malformed section does not throw out of applySync', poison.threw === '', poison.threw);
	check('and the Diamond in the same parcel still arrives',
		poison.name === 'Poison-Survivor', poison.name);
	check('and the merge SAYS which section it could not apply',
		!!(poison.report && Array.isArray(poison.report.failed) && poison.report.failed.indexOf('chats') !== -1),
		JSON.stringify(poison.report));
	check('and the section that failed left this device’s own chats as they were',
		poison.chatsIntact === true);

	// ── (11) Giving up is said out loud ────────────────────────────────
	// The pull-merge-retry loop is bounded, and running out of attempts used to
	// be one console.debug line. Worse: the last thing on the chip was the
	// "Synced" the reconciling PULL put there, so a device whose work never left
	// looked exactly like a device that had just saved.
	const exhausted = await page.evaluate(async () => {
		const chip = () => {
			const c = document.getElementById('sync-chip');
			return c ? { state: c.dataset.state || '', text: (c.querySelector('.stext') || {}).textContent || '',
				title: c.title || '', shown: c.style.display !== 'none' } : null;
		};
		// Something of this device's own to lose, made before the stub: with an
		// unchanged parcel the push never leaves and there is no conflict to
		// exhaust.
		const changed = await window.__bump('storm-note');
		const real = window.fetch;
		let posts = 0;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/sync') !== -1 && o && o.method === 'POST') {
				posts++;
				return Promise.resolve(new Response(
					JSON.stringify({ ok: false, conflict: true, version: 9999, device: 'the other one' }),
					{ status: 409, headers: { 'content-type': 'application/json' } }));
			}
			return real.apply(this, arguments);
		};
		// Driven until a parcel really leaves. A single push() here measured a
		// gateway nobody had spoken to: the call found a round already in flight,
		// rescheduled, and returned exactly as it does when it sent -- posts=0,
		// the chip still reading "Syncing…" from the other round, and all four
		// checks below red for a reason that had nothing to do with conflicts.
		//
		// `posts` is zeroed before each attempt, so what the bound below measures
		// is ONE push's retries and not the sum of every round in the window.
		let attempts = 0;
		const t0 = Date.now();
		while (posts === 0 && Date.now() - t0 < 15000) {
			attempts++;
			if (attempts > 1) await window.__bump('storm-note-' + attempts);
			posts = 0;
			await window.DaimondSync.push();
			if (posts === 0) await new Promise(r => setTimeout(r, 300));
		}
		const out = { posts, attempts, changed, chip: chip(), api: window.DaimondSync.state() };
		window.fetch = real;
		return out;
	});
	check('the work the conflict is about really left this device',
		exhausted.changed.moved === true, exhausted.changed.why);
	check('a permanent conflict is retried, and bounded', exhausted.posts >= 2 && exhausted.posts <= 6,
		'posts=' + exhausted.posts + ' over ' + exhausted.attempts + ' push attempts');
	check('and running out of attempts is SAID, not swallowed',
		!!(exhausted.chip && exhausted.chip.state === 'stalled' && exhausted.chip.shown),
		JSON.stringify(exhausted.chip));
	check('with a reason that names what is happening — another device writing too',
		!!(exhausted.chip && /device/i.test(exhausted.chip.title)),
		(exhausted.chip && exhausted.chip.title || '').slice(0, 140));
	check('and the engine reports the stall through its own surface',
		!!(exhausted.api && exhausted.api.stalled === true), JSON.stringify(exhausted.api));

	// Clear the stall before the second device runs below.
	await bumped(page, 'calm-note');
	await pushLanded(page, 'clearing the stall');

	// ── (12) Two REAL devices converge, both ways ──────────────────────
	// Every check above simulates the second device inside this browser. That
	// cannot see the thing that actually broke in the field: two windows, both
	// open and both FOCUSED, on two machines. Neither raises a focus event, so
	// the focus pull never fires, and the app settling only ever schedules a
	// PUSH -- which is skipped outright when this device has nothing new to send.
	// A device that is not editing therefore never asked the gateway anything at
	// all, and the other device's work sat in the mailbox unread for as long as
	// the window stayed where it was.
	child = await open({ name: 'syncmate', signIn: false, connect: false });
	await child.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await page.evaluate(() => DaimondPairing.create());
	await child.page.evaluate(c => DaimondPairing.redeem(c), code.code);
	await child.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(child, 'sync');
	await child.page.waitForFunction(
		() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 15000 }).catch(() => {});
	const mate = await child.page.evaluate(() => ({
		authed: DaimondGateway.state().authed,
		same:   window.DaimondIdentity.publicKeyB64url(),
	}));
	const mine = await page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
	check('a second REAL device holds the same account and an authed session',
		mate.authed === true && mate.same === mine, JSON.stringify(mate).slice(0, 80));

	/// One Diamond's name, as each device's own store reads it.
	const nameOn = (pg, id) => pg.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return ((JSON.parse(await app.list_diamonds()).find(d => d.id === id)) || {}).name || '(absent)';
	}, id);

	/// The same name, once the store has SETTLED on it. Every assertion below
	/// that expects a particular name is asserting the end of a merge, and
	/// `pull()` resolving is not the same instant as the store having finished
	/// rewriting the directory -- two `list_diamonds()` calls microseconds apart
	/// were observed disagreeing, which is what (4c) settles rather than
	/// snapshots for the same reason.
	///
	/// Bounded, and it returns whatever it last read: a name that never arrives
	/// fails the caller's check with the name it actually found, rather than
	/// hanging or passing.
	const nameSettles = async (pg, id, want, ms = 6000) => {
		const t0 = Date.now();
		let seen = '';
		do {
			seen = await nameOn(pg, id);
			if (seen === want) return seen;
			await pg.waitForTimeout(150);
		} while (Date.now() - t0 < ms);
		return seen;
	};

	// A shared Diamond, on both devices, agreed.
	const shared = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return await app.create_diamond('Both-Devices');
	});
	await pushLanded(page, 'the shared Diamond');
	await child.page.evaluate(() => window.DaimondSync.pull());
	check('the second device pulls the shared Diamond down',
		(await nameSettles(child.page, shared, 'Both-Devices')) === 'Both-Devices',
		await nameOn(child.page, shared));
	// …and it pushes once, so it has something it believes it last sent. This is
	// the state every idle device is in.
	await child.page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.create_diamond('Made-On-The-Mate');
	});
	await pushLanded(child.page, 'the mate own Diamond');
	await page.evaluate(() => window.DaimondSync.pull());
	// Quiesce the mate, so it is in the state every idle device is in: whatever
	// it would send, it has already sent.
	await child.page.evaluate(() => window.DaimondSync.push());
	await child.page.waitForTimeout(600);
	await child.page.evaluate(() => window.DaimondSync.push());

	// (12a) The idle device. This one renames; the other has nothing to send and
	// never leaves the window it is in. Only the app settling fires there.
	await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.rename_diamond(id, 'Renamed-Over-There');
	}, shared);
	await pushLanded(page, 'the rename for the idle device');
	const idleLearn = await child.page.evaluate(async () => {
		const v0 = window.DaimondSync.state().version;
		// The app settling, twice, which is all a device that is not being typed
		// at ever gets. Twice because the catch-up is rate-limited, and the
		// quiescing pushes just above have only recently spent that budget.
		window.dispatchEvent(new Event('daimond:idle'));
		await new Promise(r => setTimeout(r, 4000));
		window.dispatchEvent(new Event('daimond:idle'));
		await new Promise(r => setTimeout(r, 5500));
		return { v0, v1: window.DaimondSync.state().version };
	});
	check('a device with nothing to send still learns what the other one did',
		(await nameSettles(child.page, shared, 'Renamed-Over-There')) === 'Renamed-Over-There',
		'version ' + idleLearn.v0 + ' -> ' + idleLearn.v1);

	// (12b) Both devices editing at once, pushing on every change, as seq 50's
	// nudge makes them. Each works on its OWN Diamond, so nothing here is a
	// question of whose copy wins: a merge that reconciles at all must end with
	// both names on both devices.
	const mateOwn = await child.page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return (JSON.parse(await app.list_diamonds()).find(d => d.name === 'Made-On-The-Mate') || {}).id || '';
	});
	check('the mate device owns a Diamond of its own to work on', !!mateOwn, mateOwn);
	for (let round = 1; round <= 3; round++) {
		await page.evaluate(async (arg) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			await app.rename_diamond(arg.id, 'Here-' + arg.round);
		}, { id: shared, round });
		await child.page.evaluate(async (arg) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			await app.rename_diamond(arg.id, 'There-' + arg.round);
		}, { id: mateOwn, round });
		// Both at once: one of them is pushing from a base the other just moved.
		await Promise.all([
			page.evaluate(() => window.DaimondSync.push()),
			child.page.evaluate(() => window.DaimondSync.push()),
		]);
		await page.waitForTimeout(400);
	}
	// Let each side have its ordinary settling trigger, three times, and no more:
	// no reload, no focus, nothing a user would have to think of.
	for (let i = 0; i < 3; i++) {
		await Promise.all([
			page.evaluate(() => window.dispatchEvent(new Event('daimond:idle'))),
			child.page.evaluate(() => window.dispatchEvent(new Event('daimond:idle'))),
		]);
		await page.waitForTimeout(6000);
	}
	const hereName  = await nameSettles(page, shared, 'Here-3');
	const thereName = await nameSettles(page, mateOwn, 'There-3');
	const mateHere  = await nameSettles(child.page, shared, 'Here-3');
	const mateThere = await nameSettles(child.page, mateOwn, 'There-3');
	check('after a storm of simultaneous pushes, this device holds both sides’ work',
		hereName === 'Here-3' && thereName === 'There-3', hereName + ' / ' + thereName);
	check('and so does the other one — the conflict path converges, both ways',
		mateHere === 'Here-3' && mateThere === 'There-3', mateHere + ' / ' + mateThere);
	const chips = await Promise.all([
		page.evaluate(() => { const c = document.getElementById('sync-chip'); return c ? c.dataset.state : '(none)'; }),
		child.page.evaluate(() => { const c = document.getElementById('sync-chip'); return c ? c.dataset.state : '(none)'; }),
	]);
	check('and neither device is left claiming to be synced while it is stalled',
		chips.every(c => c !== 'stalled'), chips.join(' / '));

	// ── (13) The gateway taps an idle device ───────────────────────────
	// (12a) proved the idle device catches up when the app settles. But the app
	// settling is still something that happened HERE, and a window sitting
	// unfocused on a second desk settles once and then never again: no turn ends,
	// nothing is renamed, the user is not in it. That window used to converge
	// only when somebody came back to it, which is the complaint this section
	// exists for. The trigger now comes from the gateway.
	//
	// Everything below runs with the second device touched in exactly one way:
	// reading its state. No focus, no visibility change, no settling event, no
	// reload. Those are counted, and the count must stay at zero.
	// First, what it was like without one. With the channel shut this device has
	// exactly the triggers it had before the channel existed -- a focus that will
	// not come, a turn that will not end, a push with nothing to send -- and ten
	// seconds go by with the other device's work sitting unread in the mailbox.
	// This is the live complaint, kept as a test so the channel cannot quietly
	// stop being the thing that answers it.
	await child.page.evaluate(() => window.DaimondSync.wakeVia('off'));
	const blindV = await child.page.evaluate(() => window.DaimondSync.state().version);
	await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.rename_diamond(id, 'Unheard-Over-There');
	}, shared);
	await pushLanded(page, 'the rename the shut channel must miss');
	const blind = await child.page.evaluate(async (v0) => {
		const t0 = Date.now();
		while (Date.now() - t0 < 10000 && window.DaimondSync.state().version <= v0) {
			await new Promise(r => setTimeout(r, 200));
		}
		return { v0, v1: window.DaimondSync.state().version };
	}, blindV);
	check('WITHOUT the channel, an idle unfocused device never hears — this is the bug',
		blind.v1 === blind.v0 && (await nameOn(child.page, shared)) !== 'Unheard-Over-There',
		'version stayed at ' + blind.v1);

	// Now with it. Same device, same conditions, one thing different.
	await child.page.evaluate(() => window.DaimondSync.wakeVia('ws'));
	await child.page.waitForFunction(
		() => { const w = window.DaimondSync.wake(); return w.open && (w.mode === 'ws' || w.mode === 'poll'); },
		null, { timeout: 15000 }).catch(() => {});
	// A channel that has just opened says what the version is NOW, so a device
	// that missed something while it was away learns about it on connecting
	// rather than on the next push somebody else happens to make.
	await child.page.waitForFunction(
		v0 => window.DaimondSync.state().version > v0, blind.v1, { timeout: 15000 }).catch(() => {});
	check('opening the channel catches the device up on what it missed while it was shut',
		(await nameSettles(child.page, shared, 'Unheard-Over-There')) === 'Unheard-Over-There',
		'version ' + blind.v1 + ' -> ' + (await child.page.evaluate(() => window.DaimondSync.state().version)));
	const chan = await child.page.evaluate(() => {
		window.__wakeProbe = { focus: 0, vis: 0, idle: 0 };
		window.addEventListener('focus', () => window.__wakeProbe.focus++, true);
		document.addEventListener('visibilitychange', () => window.__wakeProbe.vis++, true);
		window.addEventListener('daimond:idle', () => window.__wakeProbe.idle++, true);
		return { wake: window.DaimondSync.wake(), version: window.DaimondSync.state().version };
	});
	check('the idle device holds a wake channel open to the gateway',
		chan.wake.open === true && (chan.wake.mode === 'ws' || chan.wake.mode === 'poll'),
		JSON.stringify(chan.wake));
	check('and the two devices name different channels, so neither is woken by itself',
		chan.wake.id !== (await page.evaluate(() => window.DaimondSync.wake().id)),
		chan.wake.id);

	// The other device renames a Diamond and pushes. Nothing at all happens on
	// the idle one.
	const selfBefore = await page.evaluate(() => window.DaimondSync.wake().wakes);
	await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.rename_diamond(id, 'Woken-Over-There');
	}, shared);
	const beganWake = Date.now();
	await pushLanded(page, 'the rename the wake channel carries');
	const woke = await child.page.evaluate(async (v0) => {
		const t0 = Date.now();
		while (Date.now() - t0 < 10000 && window.DaimondSync.state().version <= v0) {
			await new Promise(r => setTimeout(r, 100));
		}
		return {
			v1:    window.DaimondSync.state().version,
			probe: window.__wakeProbe,
			wake:  window.DaimondSync.wake(),
		};
	}, chan.version);
	const wakeMs = Date.now() - beganWake;
	check('an idle, unfocused device applies the other one’s work with no trigger of its own',
		(await nameSettles(child.page, shared, 'Woken-Over-There')) === 'Woken-Over-There',
		'version ' + chan.version + ' -> ' + woke.v1 + ' in ' + wakeMs + 'ms');
	check('and it converges within five seconds of the push, not on the next thing the user does',
		woke.v1 > chan.version && wakeMs < 5000, wakeMs + 'ms');
	check('and nothing on that device caused it — no focus, no visibility change, no settling',
		woke.probe.focus === 0 && woke.probe.vis === 0 && woke.probe.idle === 0,
		JSON.stringify(woke.probe));
	check('and the pull was the wake channel’s doing, by its own count',
		woke.wake.wakes > chan.wake.wakes && woke.wake.heard >= woke.v1,
		JSON.stringify(woke.wake));

	// The device that pushed is not woken by its own push: it already knows the
	// version it just wrote, and a channel that told it would double every round.
	const selfWake = await page.evaluate(() => window.DaimondSync.wake());
	check('and the device that pushed was not woken by its own push',
		selfWake.wakes === selfBefore,
		'wakes ' + selfBefore + ' -> ' + selfWake.wakes);

	// (13b) The channel survives the gateway going away and coming back. A
	// restart is the ordinary case -- a deploy -- and a device that did not
	// reconnect would go quiet until its owner touched it, which is exactly the
	// state this whole section exists to end.
	const restarted = await restartGateway();
	check('the gateway comes back after a restart', restarted === true, String(restarted));
	if (restarted === true) {
		await child.page.waitForFunction(
			() => window.DaimondSync.wake().open === true, null, { timeout: 60000 }).catch(() => {});
		const back = await child.page.evaluate(() => window.DaimondSync.wake());
		check('and the idle device’s wake channel comes back with it, unprompted',
			back.open === true, JSON.stringify(back));

		const v2 = await child.page.evaluate(() => window.DaimondSync.state().version);
		await page.evaluate(async (id) => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			await app.rename_diamond(id, 'Woken-After-Restart');
		}, shared);
		const beganAgain = Date.now();
		await pushLanded(page, 'the rename after the restart');
		await child.page.evaluate(async (v0) => {
			const t0 = Date.now();
			while (Date.now() - t0 < 15000 && window.DaimondSync.state().version <= v0) {
				await new Promise(r => setTimeout(r, 100));
			}
		}, v2);
		check('and it is woken again on the far side of the restart',
			(await nameSettles(child.page, shared, 'Woken-After-Restart')) === 'Woken-After-Restart',
			'took ' + (Date.now() - beganAgain) + 'ms');
	}

	// (13c) The plain-HTTP fallback does the same job. A front door that will not
	// carry a WebSocket upgrade is not a reason for an idle device to go blind:
	// the same wake arrives as a parked request answered early, and a completed
	// response wakes a throttled background tab exactly as a frame does.
	//
	// Every parked request this device makes from here on, and when each was
	// answered, so the second half of this section can say whether the one the
	// push woke was WAITING for it. Attached before the channel is switched over:
	// a park lasts three quarters of a minute, and a listener added later would
	// miss the one already open and conclude there was none.
	const parks = [];
	const above = (p) => p ? (p.url.match(/[?&]above=(\d+)/) || [])[1] : undefined;
	const onPark = (r) => {
		if (r.url().includes('/api/sync?above=')) parks.push({ r, url: r.url(), began: Date.now(), ended: 0, body: null });
	};
	const onParkDone = (r) => {
		const p = parks.find(q => q.r === r && !q.ended);
		if (!p) return;
		p.ended = Date.now();
		p.body  = r.response().then(res => res.text()).catch(() => '');
	};
	child.page.on('request', onPark);
	child.page.on('requestfinished', onParkDone);

	const pollOn = await child.page.evaluate(() => window.DaimondSync.wakeVia('poll'));
	check('the channel can be put onto parked requests instead of a socket', pollOn === 'poll', pollOn);
	await child.page.waitForFunction(
		() => window.DaimondSync.wake().open === true, null, { timeout: 15000 }).catch(() => {});
	const pollChan = await child.page.evaluate(() => {
		window.__wakeProbe = { focus: 0, vis: 0, idle: 0 };
		return { wake: window.DaimondSync.wake(), version: window.DaimondSync.state().version };
	});
	check('and parking one is enough to hold the channel open', pollChan.wake.open === true,
		JSON.stringify(pollChan.wake));
	await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.rename_diamond(id, 'Woken-Without-A-Socket');
	}, shared);
	const beganPoll = Date.now();
	await pushLanded(page, 'the rename the parked request carries');
	// What the push itself cost, which is most of what the budget below spends:
	// `pushLanded` re-pushes and re-reads the mailbox until this device's own
	// parcel is what it holds, and that loop is not the wake.
	const landedPoll = Date.now();
	const polled = await child.page.evaluate(async (v0) => {
		const t0 = Date.now();
		while (Date.now() - t0 < 10000 && window.DaimondSync.state().version <= v0) {
			await new Promise(r => setTimeout(r, 100));
		}
		return { v1: window.DaimondSync.state().version, probe: window.__wakeProbe, wake: window.DaimondSync.wake() };
	}, pollChan.version);
	const pollMs = Date.now() - beganPoll;
	check('a parked request wakes the idle device just as a socket does',
		(await nameSettles(child.page, shared, 'Woken-Without-A-Socket')) === 'Woken-Without-A-Socket'
			&& polled.v1 > pollChan.version,
		'version ' + pollChan.version + ' -> ' + polled.v1 + ' in ' + pollMs + 'ms');
	check('and that route converges inside five seconds too', pollMs < 5000,
		pollMs + 'ms, of which the push took ' + (landedPoll - beganPoll) + 'ms');
	check('and still with nothing happening on the device itself',
		polled.probe.focus === 0 && polled.probe.vis === 0 && polled.probe.idle === 0,
		JSON.stringify(polled.probe));
	// The same question the socket route above is asked, and for the same reason:
	// WHAT pulled? push() catches up on its own every five seconds when it has
	// nothing to send (IDLE_PULL_MIN_MS, sync.js), which is inside the budget the
	// check above allows, so the version moving is no evidence at all that the
	// channel did it. The channel counts the pulls it causes, and only `wakeTo`
	// -- a version the channel itself heard -- increments that count.
	//
	// What is asked of `heard` is that the channel heard something ABOVE what the
	// device held, rather than that it heard as much as the device ended up with:
	// a pull answers with the mailbox as it stands, which may already have moved
	// past the version that was announced, and that is the mailbox being busy
	// rather than the channel being wrong.
	check('and that pull was the parked channel’s doing too, by its own count',
		polled.wake.wakes > pollChan.wake.wakes && polled.wake.heard > pollChan.version,
		'wakes ' + pollChan.wake.wakes + ' -> ' + polled.wake.wakes
			+ ', heard ' + polled.wake.heard + ' while holding ' + pollChan.version
			+ ', pulled to ' + polled.v1);

	// And WAS it parked? The count above cannot say, and this is the half that was
	// never measured -- the gateway's own "waited past" line does not appear for
	// this account at all. A request that reaches the gateway AFTER the push is
	// answered on the spot, out of the version already in the store, and it
	// increments the very same counter: a channel whose park had lapsed and whose
	// next one turned up late is indistinguishable, by the count, from one that
	// waited. Without this, the section is satisfied by the idle catch-up in
	// push() and the parked wake is assumed rather than shown.
	//
	// So the request itself is watched, from the moment it leaves the browser.
	// What is waited for is one the gateway is demonstrably HOLDING: still
	// unanswered a full second after it was made, which no answer served out of
	// the store on arrival ever is, and with more of its own declared wait left
	// than the push below can take even at its slowest. Only then does the other
	// device push. A request in that state, answered after the push was made and
	// saying the version changed, came from the branch that was waiting for it and
	// from nowhere else.
	//
	// Both devices are let settle first: a round still on its way would end the
	// park before the push could, and prove nothing either way.
	await quiesce(child.page, 15000);
	await quiesce(page, 15000);
	// Longer than an answer made on arrival takes -- those come back in tens of
	// milliseconds on this loopback, and are seen doing so in the same run.
	const HELD_MS = 1000;
	const budget  = (p) => ((p.url.match(/[?&]ms=(\d+)/) || [])[1] | 0);
	const parked  = await (async () => {
		const t0 = Date.now();
		while (Date.now() - t0 < 90000) {
			// The channel holds one park at a time, so the newest unanswered one is
			// the live one; anything older is an orphan of a torn-down loop.
			const open = parks.filter(q => !q.ended);
			const p    = open.length ? open[open.length - 1] : null;
			// `pushLanded` gives up after 25s, so a park with more than that left
			// cannot run its wait out from under the push.
			if (p && Date.now() - p.began >= HELD_MS && p.began + budget(p) - Date.now() > 25000) return p;
			await sleep(200);
		}
		return null;
	})();
	check('the gateway is HOLDING a request of the idle device’s own, unanswered',
		!!parked, parked
			? parked.url.replace(/^.*\/api/, '/api') + ', open ' + (Date.now() - parked.began)
				+ 'ms of its ' + budget(parked) + 'ms wait'
			: 'no request of the channel’s own was left open long enough to be woken, in 90s');

	await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.rename_diamond(id, 'Woken-While-Parked');
	}, shared);
	const parkPush = Date.now();
	await pushLanded(page, 'the rename made while the other device had a request parked');
	const parkLanded = Date.now();
	for (let i = 0; i < 150 && parked && !parked.ended; i++) await sleep(100);
	child.page.off('request', onPark);
	child.page.off('requestfinished', onParkDone);
	let answer = null;
	try { answer = parked && parked.body ? JSON.parse(await parked.body) : null; }
	catch (e) { answer = null; }
	check('and the push wakes THAT request, rather than leaving it to run its wait out',
		!!answer && answer.waited === true && answer.changed === true
			&& (answer.version | 0) > (above(parked) | 0)
			&& parked.began < parkPush && parked.ended > parkPush,
		parked
			? 'held on ' + above(parked) + ' for ' + (parked.ended - parked.began)
				+ 'ms of its ' + budget(parked) + 'ms wait, answered ' + (parked.ended - parkPush)
				+ 'ms after the push was made (which landed after ' + (parkLanded - parkPush)
				+ 'ms): ' + JSON.stringify(answer)
			: 'nothing was parked to wake');
	const applied = await (async () => {
		const name  = await nameSettles(child.page, shared, 'Woken-While-Parked');
		const after = await child.page.evaluate(() => ({
			version: window.DaimondSync.state().version,
			probe:   window.__wakeProbe,
			wake:    window.DaimondSync.wake(),
		}));
		return { name, ...after };
	})();
	check('and the device applies what that answer told it, still with nothing happening on it',
		!!parked && applied.name === 'Woken-While-Parked' && applied.version > (above(parked) | 0)
			&& applied.probe.focus === 0 && applied.probe.vis === 0 && applied.probe.idle === 0
			&& applied.wake.wakes > polled.wake.wakes,
		'version ' + (parked ? above(parked) : '?') + ' -> ' + applied.version + ', wakes '
			+ polled.wake.wakes + ' -> ' + applied.wake.wakes + ', ' + JSON.stringify(applied.probe));

	// The channel carries version integers and nothing else. What the gateway
	// parks on and answers with is read here directly, so a future change that
	// smuggled content down it would be caught rather than assumed against.
	//
	// The second half of this asks what a wait NOTHING MOVED UNDER answers, so
	// the premise has to be established rather than assumed. Both are needed and
	// neither was there: the mate had just pulled, and a pull schedules a push of
	// whatever this device adds over the pulled base -- so a parcel was still on
	// its way while the probe parked. And `above` was read from THIS device's
	// cursor, which the mate's round had already left behind, so the probe was
	// parking over a change that had happened rather than waiting for one that
	// had not. It reported `changed: true`, correctly, and the check called it an
	// invention.
	await quiesce(child.page, 15000);
	await quiesce(page, 15000);
	const bare = await page.evaluate(async () => {
		// The version the GATEWAY holds this instant, not this device's belief
		// about it.
		const r0 = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		const v = ((await r0.json()).version) | 0;
		const r = await fetch('/api/sync?above=' + v + '&ms=1000&w=wkprobe',
			{ credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
		return { status: r.status, json: await r.json(), above: v };
	});
	check('a wake answer carries a version and nothing else — no blob, no device, no account',
		bare.status === 200 && bare.json.waited === true
			&& Object.keys(bare.json).sort().join(',') === 'changed,ok,version,waited',
		JSON.stringify(bare.json).slice(0, 160));
	check('and a wait that nothing moved under says so rather than inventing a change',
		bare.json.changed === false, 'parked above ' + bare.above + ' — ' + JSON.stringify(bare.json));

	// The gateway is deliberately restarted above, so a wake socket that was open
	// across it reports a failed connection while it is down. That is the reconnect
	// working, not a fault, and it is the only WebSocket noise this run may make.
	const wakeNoise = /WebSocket connection to '[^']*\/api\/sync\/ws/;
	const cerrs = child.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|402|409|426|502|Unauthorized/.test(e) && !wakeNoise.test(e));
	check('no unexpected console errors on the second device', cerrs.length === 0,
		cerrs.slice(0, 3).join(' | '));

	const errs = s.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|402|409|426|502|Unauthorized/.test(e) && !wakeNoise.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('verify_sync ran without throwing', false, String(e && e.message || e));
} finally {
	await child?.close?.().catch?.(() => {});
	await s.close?.().catch?.(() => {});
}

console.log('\n' + (bad.length ? `FAIL: ${bad.length} failed, ${ok.length} passed` : `ok: all ${ok.length} passed`));
process.exit(bad.length ? 1 : 0);
