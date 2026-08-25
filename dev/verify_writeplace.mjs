// verify_writeplace.mjs — a write that landed in browser storage never reads as a write to disk.
//
// THE DEFECT, AND IT IS THE WORST SHAPE THE OPFS/DISK SPLIT TAKES. Daimond has two
// filesystems: the browser's own storage, which the file tools reach, and the folder on
// this computer, which only `run` reaches. `two_places_note` (src/tools.rs, lane H,
// 2026-08-24) taught seven tools to say which one they had just answered about, and
// `absent_here` wired them up. `file_write` was left out, because the note works by
// asking whether the path EXISTS and a write to a path that does not exist is the
// ordinary case.
//
// What was left is not a missing sentence. `opfs::descend` calls `set_create(true)` on
// every directory component it walks, so a write into a folder browser storage does not
// hold MAKES THE FOLDER instead of failing. A daimon that has just found `src/tools.rs`
// with a `grep` on the machine, and writes to it with `file_write`, is answered
//
//     Wrote 812 bytes to src/tools.rs.
//
// with outcome `done`. A folder named `src` now exists in browser storage that nobody
// asked for, holding a file the daimon believes is on disk. And the deceit compounds:
// `file_read` of that path now SUCCEEDS, `file_list` of that folder lists the file, and
// `absent_here` answers nothing anywhere, because the entry is present. Every check the
// daimon can afterwards make agrees that the work landed. Nothing on the machine changed.
//
// That is why a sentence alone was judged insufficient here and is not what this pins. A
// note on the answer is one line contradicted by every later signal; the write itself has
// to not happen.
//
// SEVEN PROPERTIES:
//
//   0. NO HAND, NO NOISE. With no machine hand paired there is one filesystem and nothing
//      to disambiguate, so an ordinary write answers exactly as it always did. Without
//      this, a build that refused or annotated every write would pass everything below.
//   1. A WRITE THAT CANNOT REACH THE MACHINE DOES NOT PRETEND TO. Hand paired, no folder
//      open, and the write would have to invent a folder to land: it is REFUSED, and —
//      the load-bearing half — NOTHING IS CREATED. Not the file, not the folder.
//   2. THE REFUSAL IS A ROUTE. It names `run` for the machine, `dir_create` for browser
//      storage, and opening the folder for making the two one place.
//   3. AND THE ROUTE IS ONE CALL. `dir_create` then the same write lands. A daimon that
//      really meant browser storage is delayed by one call, not stopped.
//   4. A WRITE THAT DOES LAND SAYS WHERE IT LANDED. The folder is already there, so
//      nothing is invented and nothing is refused — but the answer still names the
//      filesystem, because a daimon reading `Wrote 812 bytes` has been told nothing.
//   5. AND ITS FIRST LINE IS UNCHANGED. `dev/verify_replylen.mjs` reads `Wrote (\d+)
//      bytes to <file>` out of a tool answer. The note goes on a SECOND line, for the
//      reason `dev/verify_refusedpath.mjs` check 1c records: a reader that stops
//      recognising an answer does not read it as unknown, it reads it as something else.
//   6. A DIAMOND'S OWN STORAGE IS NOT SECOND-GUESSED. `diamonds/`, `chats/` and `mail/`
//      ARE browser storage by design — the system prompt says so and the page's own mail
//      writer creates folders under `mail/` on every refresh. Refusing those would break
//      the product to fix a different fault.
//
// THE RED, AND HOW IT WAS TAKEN. The breaks here are in Rust, so they are not `--break`
// flags over `www/js/daimond.js` the way `dev/verify_refusedpath.mjs`'s are: the engine
// has to be rebuilt, which is two minutes. The world before the fix is the whole of it —
// `Tool::FileWrite` with no `write_place` call at all — and this file was written and run
// against that bundle first. What it printed is in the commit message. Reproduce it by
// deleting the two lines in the `Tool::FileWrite` arm that read
//
//     let place = res!(write_place(ctx, &raw, &path).await);
//     if let WritePlace::Inventing(dir) = &place {
//
// with their bodies, and the `place_line` that follows, then `bash dev/build-wasm.sh`.
// Checks 1, 2 and 4 go red together; 1's second half is the one to watch, because it is
// the only one that says the bytes went somewhere.
//
//   eval "$(bash dev/world.sh 6 --up)"
//   node dev/verify_writeplace.mjs
//
// Needs dev/serve.mjs. No mock and no gateway: every call here goes straight to the real
// registry through `run_tool_outcome`, which is the door `dev/CONTRACT_OUTCOME.md` §1
// defines and the only one that answers what became of a call.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const PROFILE = scratch('pw', 'writeplace');
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'writeplace', profile: PROFILE, connect: false });
const { page: p } = s;

/// One call through the real registry, with the outcome the engine gave it.
const call = (name, args) => p.evaluate(async (a) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const r = await app.run_tool_outcome(a.name, JSON.stringify(a.args));
	return { outcome: (r && r.outcome) || 'none', text: String((r && r.text) || '') };
}, { name, args });

/// A machine hand, or the page's own relay saying there is none.
///
/// `hand.js` installs `window.DaimondHand` on EVERY page — it is the shim that answers "no
/// hand is installed" — so the unpaired world is the page LEFT ALONE, and `hasHand()` is
/// what tells the two apart. A REAL pairing needs the extension and a native host, neither
/// of which an automated browser can be given, so the paired world is a stub that answers
/// that one question the way a paired relay does. What is under test is what `file_write`
/// does when a second filesystem exists, not how it came to exist.
const hand = (on) => p.evaluate((v) => {
	if (v) {
		window.__realHand = window.__realHand || window.DaimondHand;
		window.DaimondHand = { hasHand: () => true, status: async () => '{}', run: async () => '{}' };
	} else if (window.__realHand) {
		window.DaimondHand = window.__realHand;
	}
	return !!(window.DaimondHand && window.DaimondHand.hasHand && window.DaimondHand.hasHand());
}, on);

/// What browser storage actually holds, asked of the browser and not of the tool that
/// was just refused. A tool that lied about writing would also lie about reading.
const held = (dir, file) => p.evaluate(async (a) => {
	const root = await DaimondCloud.opfsRoot();
	const walk = async (parts) => {
		let d = root;
		for (const seg of parts) { d = await d.getDirectoryHandle(seg); }
		return d;
	};
	const out = { dir: false, file: false };
	try { await walk(a.dir.split('/').filter(Boolean)); out.dir = true; } catch (e) { /* absent */ }
	try {
		const parts = a.file.split('/').filter(Boolean);
		const d = await walk(parts.slice(0, -1));
		await d.getFileHandle(parts[parts.length - 1]);
		out.file = true;
	} catch (e) { /* absent */ }
	return out;
}, { dir, file });

const firstLine = (t) => String(t).split('\n')[0];

try {
	await p.waitForFunction(() => !!(window.DaimondCloud && window.DaimondCloud.opfsRoot),
		null, { timeout: 20000 });

	// ── 0. The control: one filesystem, and the answer it always gave ───────────
	//
	// Not a formality. Every check below reads a sentence the engine adds; a build that
	// added it unconditionally would satisfy all of them and would have made the ordinary
	// single-filesystem answer worse for every user who has no hand installed.
	// The relay is the page's own, untouched, which is the state of every browser that has
	// never paired one. `hand::present()` asked `relay().is_ok()` until 2026-08-24 and got
	// TRUE here, because the object it looked for is the shim that says "no hand installed" —
	// so the two-filesystems note was being told to users who had one filesystem. This check
	// is red against that build, and it is the reason `present()` now asks `hasHand()`.
	const none = await hand(false);
	check(none === false, 'THE PAGE\'S OWN RELAY IS NOT A PAIRED HAND', `hasHand()=${none}`);
	const plain = await call('file_write', { path: 'wp0/a/b.txt', content: 'plain' });
	check(plain.outcome === 'done' && /^Wrote \d+ bytes to wp0\/a\/b\.txt\.$/.test(plain.text.trim()),
		'NO HAND, NO NOISE — with one filesystem the answer is the one it always was',
		JSON.stringify(plain.text.slice(0, 120)));

	// ── 1. The silence, ended ───────────────────────────────────────────────────
	//
	// `wpm` is a folder browser storage does not hold. Before this change the write
	// invented it and answered `Wrote 6 bytes to wpm/deep/thing.rs.`, outcome `done`.
	const on = await hand(true);
	check(on === true, 'THE FIXTURE STANDS: a hand is present and no folder is open', String(on));
	const meant = await call('file_write', { path: 'wpm/deep/thing.rs', content: 'fn main(){}' });
	const after = await held('wpm', 'wpm/deep/thing.rs');
	check(meant.outcome === 'refused',
		'A WRITE THAT CANNOT REACH THE MACHINE DOES NOT REPORT SUCCESS',
		`${meant.outcome}: ${JSON.stringify(meant.text.slice(0, 150))}`);
	check(after.dir === false && after.file === false,
		'AND NOTHING WAS CREATED — no invented folder, no bytes, so every later read '
			+ 'tells the truth too',
		`folder wpm ${after.dir ? 'EXISTS' : 'absent'}, file ${after.file ? 'EXISTS' : 'absent'}`);

	// ── 2. A refusal that is a route ────────────────────────────────────────────
	//
	// Three ways out, because there are three different things the daimon may have meant,
	// and a refusal that names none of them is a wall. `run` is the machine; `dir_create`
	// is browser storage, said on purpose; opening the folder is how the user makes the
	// two one place and stops this happening at all.
	const says = String(meant.text);
	check(/\brun\b/.test(says), 'THE REFUSAL NAMES run, for the machine', '');
	check(/\bdir_create\b/.test(says), 'and dir_create, for browser storage said on purpose', '');
	check(/open the folder/.test(says), 'and opening the folder, which makes the two one place', '');
	check(/the file tools reach while no folder is open/.test(says),
		'and it carries the clause both file tools share, which dev/reflux.mjs keys opfsSplit on',
		'');

	// ── 3. And the route is one call ────────────────────────────────────────────
	const made = await call('dir_create', { path: 'wpm/deep' });
	const again = await call('file_write', { path: 'wpm/deep/thing.rs', content: 'fn main(){}' });
	const now = await held('wpm', 'wpm/deep/thing.rs');
	check(made.outcome === 'done' && again.outcome === 'done' && now.file === true,
		'THE ROUTE IS ONE CALL — dir_create, then the same write lands',
		`${made.outcome} / ${again.outcome} / file ${now.file ? 'present' : 'ABSENT'}`);

	// ── 4. A write that lands says where ────────────────────────────────────────
	//
	// Nothing is invented now, so nothing is refused — and this is the case a note alone
	// was always going to have to cover, because a daimon overwriting a file it has
	// already read gets no refusal and still has to know which disk it is on.
	const landed = await call('file_write', { path: 'wpm/deep/second.rs', content: 'fn two(){}' });
	check(landed.outcome === 'done'
		&& /this browser's own storage/.test(landed.text)
		&& /the file tools reach while no folder is open/.test(landed.text),
		'A WRITE THAT LANDS NAMES THE FILESYSTEM IT LANDED IN',
		JSON.stringify(landed.text.slice(0, 200)));

	// ── 5. And its first line is unchanged ──────────────────────────────────────
	check(/^Wrote \d+ bytes to wpm\/deep\/second\.rs\.$/.test(firstLine(landed.text).trim()),
		'THE FIRST LINE IS UNCHANGED, so dev/verify_replylen.mjs still reads the byte count',
		JSON.stringify(firstLine(landed.text)));

	// ── 6. A Diamond's own storage is not second-guessed ────────────────────────
	//
	// `mail/` is browser storage by design and the page's own mailbox writer creates
	// folders under it unasked (`www/js/mail.js`). A rule that refused a store path would
	// have broken mail to fix a fault mail does not have.
	const store = await call('file_write',
		{ path: 'mail/someone@example.com/INBOX/index.md', content: '| UID |\n' });
	check(store.outcome === 'done' && !/Refused/.test(store.text),
		'A STORE PATH IS BROWSER STORAGE BY DESIGN — mail/ writes through, folders and all',
		`${store.outcome}: ${JSON.stringify(store.text.slice(0, 90))}`);
	const dia = await call('file_write',
		{ path: 'diamonds/wp-test/notes/n.md', content: 'note\n' });
	check(dia.outcome === 'done' && !/Refused/.test(dia.text),
		'and so is a Diamond\'s own directory', `${dia.outcome}`);
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
