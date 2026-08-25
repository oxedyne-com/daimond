// verify_refusedpath.mjs — a refused tool call is not a call that did nothing wrong.
//
// THE DEFECT, ONE DOOR ALONG FROM `dev/CONTRACT_OUTCOME.md`. That contract put the
// outcome on `AgentEvent::ToolResult`, so the five consumers of a MODEL's tool call
// stopped guessing. `DaimondApp::run_tool` — the app's own door to the same
// registry, taken by the sync census, the Files panels, the skill seeder and mail —
// still returned a bare String. Nine callers read that string to decide what had
// happened, every one of them testing for `Error:` alone, while `refusal_line`
// (src/tools.rs) opens every refusal with `Refused:`.
//
// The one that matters is `collectFiles` (www/js/daimond.js). A `file_list` the
// scope fence refused sailed past the `Error` test into `parseSyncListing`, which
// reads a sentence ending "is empty." as NO ENTRIES — so a fenced directory read as
// an empty one, and the census still reported `filesComplete`. Completeness is the
// single thing that entitles the other device to read an absent path as a deletion
// (see `applyFiles`). A Diamond could therefore sync a file set with a whole folder
// silently missing from it, and nothing anywhere said so.
//
// `run_tool_outcome` answers `{ text, outcome }` from `call_outcome` — the same
// classifier, the same three words, `dev/CONTRACT_OUTCOME.md` §1 — and the callers
// ask it.
//
// THREE PROPERTIES:
//
//   0. THE ENGINE ITSELF STATES THE OUTCOME. Not simulated: three real calls
//      through the real registry — a write that lands, a write the fence refuses,
//      a read of a file that is not there — must come back done / refused / failed.
//   1. A REFUSED LISTING IS NOT AN EMPTY DIRECTORY. The census must report
//      `filesComplete: false`, so the far side deletes nothing by absence.
//   2. A REFUSED WRITE IS NOT AN AGREEMENT. `applyFiles` records a pulled file in
//      the fork point as held by both devices; a write the fence stopped must not
//      be entered there, or the next complete census from the other side will read
//      its absence here as a deletion made here.
//   3. A REFUSED CREATE SAYS SO. `newFile` threw the answer away and went straight
//      on to open the new file, so a create the fence stopped was a button that did
//      nothing and said nothing. (The editor half of that is defended twice over --
//      see the note at the check -- so the message is what the break moves.)
//   4. A REFUSED SAVE DOES NOT SAY "SAVED", which is the worst of the four. The
//      Doc panel's save resolved with the refusal text and took the success
//      branch: the message read "Saved.", the editor was torn down, and the edit
//      existed nowhere but in the textarea that had just been removed. So the
//      check is not only the message: the EDITOR MUST STILL BE STANDING, holding
//      what was typed.
//
// WHY THE FIXTURE LIES ON PURPOSE, as `dev/verify_outcome.mjs` does. Its refusal
// carries the TEXT of an empty directory — `'notes' is empty.` — and its refused
// write carries no error wording at all. Every check would pass on truthful text
// with the old sniffing still in place; a consumer still reading the words is
// caught here and nowhere else. The stamp is not derived from anything the app can
// see: it is the test's arranged truth, which is what the engine's field is.
//
// EACH CHECK PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_refusedpath.mjs --break sniff   # 1 fails: the text wins again
//   node dev/verify_refusedpath.mjs --break wrote   # 2 fails: a refused write returns true
//   node dev/verify_refusedpath.mjs --break agreed  # 2 fails: agreement is recorded unasked
//   node dev/verify_refusedpath.mjs --break created # 3 fails: the create says nothing at all
//   node dev/verify_refusedpath.mjs --break saved   # 4 fails: "Saved.", and the editor goes
//   node dev/verify_refusedpath.mjs --break bare    # 0 and the control fail: the door
//                                                   #   hands back text again, as it used to
//   node dev/verify_refusedpath.mjs                 # and then, clean
//
//   eval "$(bash dev/world.sh 6 --up)"
//   node dev/verify_refusedpath.mjs
//
// Needs dev/serve.mjs. No mock and no gateway: `collectSync` and `applySync` are
// driven directly, which is what lets a census be measured without a push.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Each break is [find, replace, howManyTimes] over www/js/daimond.js, asserted
// before the browser opens so an anchor that has moved stops the run rather than
// patching nothing and reporting green. `bare` is not here: it damages the wasm
// GLUE, not the app, and is applied to the shim below.
const BREAKS = {
	// The rule exactly as it was: read the sentence for `Error`. The fixture's
	// refusal does not carry that word, so the census walks on and calls itself
	// complete — which is the whole defect, reproduced.
	sniff: [[
		`			if (!res || res.outcome !== 'done') {\n				console.warn('sync: '`,
		`			if (typeof res.text !== 'string' || /^\\s*Error\\b/i.test(res.text)) {\n				console.warn('sync: '`, 1]],
	// The best-effort writer says "written" for anything that did not throw.
	wrote: [[
		`			var r = await app.run_tool_outcome('file_write',\n				JSON.stringify({ path: path, content: content }));\n			return !!r && r.outcome === 'done';`,
		`			await app.run_tool_outcome('file_write',\n				JSON.stringify({ path: path, content: content }));\n			return true;`, 1]],
	// The caller stops asking, so the answer above no longer matters.
	agreed: [[
		`if (l == null) { if (await writeSyncFile(app, p, r)) agreed[p] = fileHash(r); continue; }`,
		`if (l == null) { await writeSyncFile(app, p, r); agreed[p] = fileHash(r); continue; }`, 1]],
	// The Doc panel's save stops asking, so a refusal takes the success branch: the
	// message says "Saved.", the textarea is replaced by a <pre>, and what the person
	// typed is gone with it.
	saved: [[
		`					writeOpenFile(path, content).then(function (wr) {\n						if (!wr || wr.outcome !== 'done') {`,
		`					writeOpenFile(path, content).then(function (wr) {\n						if (false) {`, 1]],
	// And `newFile` stops asking, so it opens an editor over a file that was refused.
	created: [[
		`				// The result used to be thrown away, so a refused create opened an editor\n				// on a file that was never made.\n				if (!w || w.outcome !== 'done') {`,
		`				// The result used to be thrown away, so a refused create opened an editor\n				// on a file that was never made.\n				if (false) {`, 1]],
	// The empty-listing reader anchored at the END of the text, as it was before
	// `two_places_note` put a second line under the answer. 1c goes red: the note becomes
	// a file, in a census that still calls itself complete.
	// TWO occurrences, and that is the honest count: the census reader and the Work panel's
	// reader are the same line at two indents, so a substring anchor finds both -- and both
	// were anchored at the end of the text before this change, so damaging both IS the world
	// before it.
	endanchor: [[
		`		if (/ is empty\\.$/.test(String(text).split('\\n')[0].trim())) return out;`,
		`		if (/ is empty\\.$/.test(String(text).trim())) return out;`, 2]],
	bare: [],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

const APP_SRC  = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
const GLUE_SRC = fs.readFileSync(path.join(WWW, 'pkg/oxedyne_daimond.js'), 'utf8');

let damaged = APP_SRC;
for (const [find, repl, want] of (BREAKS[BREAK] || [])) {
	const got = damaged.split(find).length - 1;
	if (got !== want) {
		console.error(`--break ${BREAK}: expected ${want} occurrence(s) of\n  ${find}\nbut found ${got}; `
			+ 'the anchor has moved and this break would patch nothing');
		process.exit(2);
	}
	damaged = damaged.split(find).join(repl);
}

// The fence, stood in for. A real scope refusal needs a real fence and a real
// machine hand; what is being tested is what the app DOES with a refusal, so the
// refusal is arranged. `__stamp` names a tool and a fragment of its arguments; a
// match answers with the stamped pair and the call is NOT dispatched, so a refused
// write really does leave nothing behind. Everything else goes through untouched
// and its true outcome is recorded, which is what check 0 reads.
const SHIM = `
/* ── dev/verify_refusedpath.mjs: stands in for a door that refuses ── */
const __rp_real = DaimondApp.prototype.run_tool_outcome;
DaimondApp.prototype.run_tool_outcome = async function (name, argsJson) {
	try {
		for (const s of (globalThis.__stamp || [])) {
			if (s.name === name && String(argsJson).indexOf(s.match) >= 0) {
				(globalThis.__stamped = globalThis.__stamped || []).push(name + ' ' + s.match);
				return { text: s.text, outcome: s.outcome };
			}
		}
	} catch (e) { /* the shim may never break the run it observes */ }
	const real = await __rp_real.call(this, name, argsJson);
	try {
		(globalThis.__seen = globalThis.__seen || []).push(
			name + ':' + (real && real.outcome === undefined ? 'none' : (real && real.outcome)));
	} catch (e) { /* nor may the recorder */ }
	return real;
};
`;
// The door as it was before this landed: the text alone, with the outcome thrown
// away. Everything downstream is then reading prose again, whether it means to or
// not, and the checks below must notice.
const BARE = `
DaimondApp.prototype.run_tool_outcome = async function (name, argsJson) {
	return await this.run_tool(name, argsJson);
};
`;

// The document the third fixture edits: what is on disk, and what gets typed over it.
const DOC_WAS   = 'the words that are already saved\n';
const DOC_TYPED = 'the words that exist only on screen, and must survive being refused\n';

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const PROFILE = scratch('pw', 'refusedpath' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({
	name:    'refusedpath',
	profile: PROFILE,
	connect: false,
	route:   async (page) => {
		await page.route('**/pkg/oxedyne_daimond.js', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript',
			body: GLUE_SRC + SHIM + (BREAK === 'bare' ? BARE : ''),
		}));
		if (BREAK && BREAK !== 'bare') await page.route('**/js/daimond.js', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: damaged,
		}));
	},
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

/// A file into the OPFS workspace, through the text-only door — which is the honest
/// use of it: this is setup, and nothing here reads the answer.
const write = (path, content) => p.evaluate(async (a) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return String(await app.run_tool('file_write', JSON.stringify({ path: a.path, content: a.content })));
}, { path, content });

const exists = (path) => p.evaluate(async (f) => {
	try {
		const dir = await DaimondCloud.opfsRoot();
		await dir.getFileHandle(f);
		return true;
	} catch (e) { return false; }
}, path);

/// Arm the stand-in, and clear what it recorded last time.
const stamp = (plan) => p.evaluate((pl) => {
	globalThis.__stamp   = pl;
	globalThis.__stamped = [];
	globalThis.__seen    = [];
	return true;
}, plan);

/// The census, as the parcel would carry it.
const census = () => p.evaluate(async () => {
	const c = await DaimondCore.collectSync();
	return { complete: c.filesComplete === true, paths: Object.keys(c.files || {}).sort() };
});

const baseline = () => p.evaluate(() => {
	try { return JSON.parse(localStorage.getItem('daimond-sync-filebase') || '{}'); }
	catch (e) { return {}; }
});

const stamped = () => p.evaluate(() => (globalThis.__stamped || []).slice());

/// Every call the door was asked that the stand-in did NOT answer, with the outcome
/// the engine gave it. Only ever a detail line: a check that read this would be
/// asking the recorder rather than the app.
const seen = () => p.evaluate(() => (globalThis.__seen || []).slice(-8));

try {
	await p.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync && window.DaimondTools),
		null, { timeout: 20000 });
	await p.waitForTimeout(900);

	// ── 0. The engine's own word, unsimulated ────────────────────
	//
	// The stand-in is not armed here, so these three go to the real registry and
	// come back with whatever it says. If this fails, nothing below means anything:
	// every other check is about what the app does with an outcome, and this is the
	// only one about where the outcome comes from.
	await stamp([]);
	const eng = await p.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const call = async (n, a) => {
			const r = await app.run_tool_outcome(n, JSON.stringify(a));
			return { outcome: r && r.outcome, head: String((r && r.text) || '').slice(0, 44) };
		};
		return {
			done:    await call('file_write', { path: 'rp/landed.txt', content: 'landed' }),
			refused: await call('file_write', { path: '/etc/daimond-must-not-write.txt', content: 'nope' }),
			failed:  await call('file_read',  { path: 'rp/not-here.txt' }),
		};
	});
	check(eng.done.outcome === 'done' && eng.refused.outcome === 'refused' && eng.failed.outcome === 'failed',
		'THE ENGINE STATES THE OUTCOME — done, refused and failed come back as themselves',
		`${eng.done.outcome} / ${eng.refused.outcome} / ${eng.failed.outcome}`);
	check(/^Refused\b/.test(eng.refused.head) && /^Error\b/.test(eng.failed.head)
		&& !/^(Refused|Error)\b/.test(eng.done.head),
		'and the text still says what it always said, so the outcome is a second fact and not a rewrite',
		JSON.stringify([eng.done.head, eng.refused.head, eng.failed.head]));

	// ── The workspace this census is of ──────────────────────────
	await write('rp-top.md', 'at the root, and readable\n');
	await write('notes/keep.md', 'inside the folder that will be refused\n');
	await p.waitForTimeout(300);

	// ── 1a. The control ──────────────────────────────────────────
	//
	// Nothing stamped: the whole workspace lists, so the census is complete and
	// carries both files. Without this, check 1b passes for a build that reports
	// every census incomplete, which would be useless in a different way.
	const clean = await census();
	check(clean.complete === true && clean.paths.indexOf('notes/keep.md') >= 0
		&& clean.paths.indexOf('rp-top.md') >= 0,
		'A WALK THAT SAW EVERYTHING REPORTS COMPLETE, and carries what it saw',
		`complete=${clean.complete}, ${JSON.stringify(clean.paths.slice(0, 6))}`);

	// ── 1b. The load-bearing one ─────────────────────────────────
	//
	// `notes` is refused, in the words of an empty directory. The old rule tested
	// those words for `Error`, found none, and let `parseSyncListing` read them as
	// no entries at all — an empty folder, indistinguishable from a folder the user
	// really had emptied. Only the outcome tells the two apart.
	await stamp([{
		name: 'file_list', match: '"path":"notes"',
		outcome: 'refused', text: "'notes' is empty.",
	}]);
	const fenced = await census();
	const hit = await stamped();
	check(hit.length > 0, 'THE FIXTURE RAN: the census asked to list the refused folder',
		JSON.stringify(hit.slice(0, 3)));
	check(fenced.complete === false,
		'A REFUSED LISTING IS NOT AN EMPTY DIRECTORY — the census reports itself INCOMPLETE, '
			+ 'so the other device deletes nothing by absence',
		`filesComplete=${fenced.complete}, paths ${JSON.stringify(fenced.paths.slice(0, 6))}`);
	check(fenced.paths.indexOf('notes/keep.md') === -1 && fenced.paths.indexOf('rp-top.md') >= 0,
		'and it still carries what it COULD read: the refused folder is missing, the rest is not',
		JSON.stringify(fenced.paths.slice(0, 6)));

	// ── 1c. An empty directory that also SAYS something ──────────
	//
	// `file_list` puts a second line under the empty answer when the file tools and a
	// command are looking at two different filesystems (`two_places_note`, src/tools.rs,
	// 2026-08-24). The reader here tested the END of the text, so the answer stopped being
	// recognised — and an unrecognised listing is not read as "unknown", it is read as ONE
	// FILE whose name is that sentence. In a census that calls itself COMPLETE, a phantom
	// file is what the other device syncs, and the fix for §1b would have been undone by
	// the fix for a different fault entirely.
	await stamp([{
		name: 'file_list', match: '"path":"notes"',
		outcome: 'done',
		text: "'notes' is empty.\n'notes' is empty in this browser's own storage, which is the "
			+ 'only filesystem the file tools reach while no folder is open. The granted folder '
			+ 'on this computer is a second one, which the run tool reaches and a file tool '
			+ 'cannot.',
	}]);
	const noted = await census();
	const hitN = await stamped();
	check(hitN.length > 0, 'THE FIXTURE RAN: the census asked to list the folder that answers with a note',
		JSON.stringify(hitN.slice(0, 3)));
	// THE HEADLINE IS COMPLETENESS, and the ordering is what the break taught: with the reader
	// anchored at the end of the text the note became an entry, the census then tried to READ
	// that entry, the read failed, and the census went INCOMPLETE. So the phantom is caught one
	// step upstream of where it would show, and a check that only looked at the file list would
	// have stayed green while sync stopped working for every empty folder in the workspace.
	check(noted.complete === true,
		'AN EMPTY DIRECTORY THAT EXPLAINS ITSELF IS STILL A COMPLETE ANSWER — a note under the '
			+ 'empty line does not cost the census its completeness, which is the one word that '
			+ 'entitles the other device to act on absence',
		`filesComplete=${noted.complete}`);
	// The corollary, which the break above does NOT red on its own. Kept because it is the
	// property a future reader will look for, and said to be a corollary rather than left to
	// read as the evidence.
	check(!noted.paths.some((x) => /browser|filesystem|is empty/.test(x)),
		'and no sentence was carried as a file name',
		JSON.stringify(noted.paths.slice(0, 6)));
	check(!noted.paths.some((x) => x.indexOf('notes/') === 0),
		'and nothing under it was invented either',
		JSON.stringify(noted.paths.filter((x) => x.indexOf('notes/') === 0).slice(0, 4)));

	// ── 2. A refused write is not an agreement ───────────────────
	//
	// The other device sends a file this one has never seen. `applyFiles` adopts it
	// and records the path in the fork point as held by BOTH devices. The write is
	// refused here, so the file does not exist — and a fork point that says it does
	// is one the next complete census will read as a deletion made on this side.
	await stamp([{
		name: 'file_write', match: '"path":"adopted.md"',
		outcome: 'refused', text: 'Refused: adopted.md is outside what this Diamond may write.',
	}]);
	await p.evaluate(async () => {
		await DaimondCore.applySync({
			v: 2, chats: [], tombs: {}, msgTombs: {},
			files: { 'adopted.md': 'sent by the other device\n' },
			filesComplete: true, diamonds: [], diamondTombs: {}, chunked: {},
		});
	});
	await p.waitForTimeout(400);
	const hit2 = await stamped();
	const base = await baseline();
	check(hit2.length > 0, 'THE SECOND FIXTURE RAN: the pull tried to write the adopted file',
		JSON.stringify(hit2.slice(0, 3)));
	check(!(await exists('adopted.md')),
		'the refused write really left nothing behind, which is what makes the next check about anything');
	check(!Object.prototype.hasOwnProperty.call(base, 'adopted.md'),
		'A REFUSED WRITE IS NOT AN AGREEMENT — the fork point does not claim a file this device '
			+ 'was stopped from writing',
		`baseline ${JSON.stringify(Object.keys(base).slice(0, 6))}`);

	// ── 3. A refused create does not open an editor ──────────────
	//
	// `newFile` threw the answer away and opened the file it had just been stopped
	// from making. The editor then sat over nothing, and the first save met the same
	// fence — by which time the person had typed into it.
	await stamp([{
		name: 'file_write', match: 'rp-never.md',
		outcome: 'refused', text: 'Refused: rp-never.md is outside what this Diamond may write.',
	}]);
	await p.evaluate(() => {
		const b = document.querySelector('#panel-work [data-act="new-file"]');
		if (b) b.click();
	});
	await p.waitForSelector('.dlg-card', { timeout: 5000 });
	await p.fill('.dlg-input', 'rp-never.md');
	await p.evaluate(() => {
		const b = document.querySelector('.dlg-ok');
		if (b) b.click();
	});
	await p.waitForTimeout(1500);

	const made = await p.evaluate(() => {
		// The message lands in the open document's header when there is one, and in
		// the mode row when there is not, so both are read.
		const a = document.querySelector('#doc-view .files-view-msg');
		const b = document.querySelector('#panel-work .files-mode-msg');
		// Read whether or not the surface is on screen: which of the two `fileMsg`
		// picks depends on a document being open, and this check is about what was
		// SAID, not about which header it landed in.
		const shown = (el) => (el ? (el.textContent || '') : '');
		return {
			msg:  (shown(a) + ' ' + shown(b)).trim(),
			err:  !!((a && a.classList.contains('err')) || (b && b.classList.contains('err'))),
			name: (document.getElementById('doc-name') || {}).textContent || '',
			editing: !!document.querySelector('#doc-view .files-edit'),
		};
	});
	check((await stamped()).length > 0, 'THE THIRD FIXTURE RAN: the create reached the fence',
		JSON.stringify((await stamped()).slice(0, 2)));
	check(made.err && /Could not create file/i.test(made.msg),
		'A REFUSED CREATE SAYS SO', JSON.stringify(made.msg.slice(0, 70)));
	// SAID OUT LOUD: the editor half is defended TWICE — `newFile` asks the outcome,
	// and `openFile`'s own read of a file that is not there fails anyway — so
	// `--break created` reddens the message above and NOT this one. No break in this
	// file can falsify it, because a refused create leaves nothing to open. It is
	// asserted regardless, because the day something seeds the file before writing it
	// this becomes the only check between a person and an editor over nothing; it is
	// labelled a corollary so nobody reads it as proven.
	check(made.name.indexOf('rp-never.md') === -1 && !made.editing,
		'and no editor is left open over it (corollary: there is nothing to open)',
		`doc-name ${JSON.stringify(made.name)}, editing=${made.editing}`);
	check(!(await exists('rp-never.md')),
		'and the file really was never made, so the editor would have been over nothing');

	// ── 4. A refused save does not say "Saved" ───────────────────
	//
	// LAST, on purpose: this one ends with an editor left standing over words that
	// were never written, which is the state being asserted — so nothing may run
	// after it that needs a clean panel.
	//
	// The person's own words are in the textarea and nowhere else. The save resolved
	// with the refusal, the success branch ran, the message said "Saved." and the
	// textarea was replaced by a <pre> built from the string that had NOT been
	// written. So the message is only half the check: the editor must still be
	// standing, holding what they typed.
	await stamp([]);
	await write('rp-doc.md', DOC_WAS);
	await p.waitForTimeout(300);

	// Open it the way a person does. The tree races the write that made the file, so
	// the panel is reopened until the row is there rather than once with a hopeful
	// pause — a verifier that flakes on its own fixture says nothing.
	//
	// Asking for the tree and reading it are two steps, not one: the panel relists
	// asynchronously, so a query in the same evaluate as the refresh always reads a
	// tree that is still being built and the hunt never finds anything.
	let opened = false;
	for (let i = 0; i < 10 && !opened; i++) {
		await p.evaluate(() => {
			try { DaimondPanels.hide('work'); DaimondPanels.show('work'); } catch (e) { /* no panels */ }
		});
		await p.waitForTimeout(700);
		opened = await p.evaluate(() => {
			// NOT `.sys-row`. The System section lists the store, whose root is this
			// same OPFS root, so the fixture appears in BOTH trees — and a store row
			// opens the file through the STORE door, which is not the one under test.
			// Hunting `.files-row` alone found the store's copy first, and the save
			// then went to `Wasm.store_write` and never reached the fence.
			const row = [...document.querySelectorAll('#panel-work .files-row:not(.sys-row)')]
				.find((r) => /rp-doc\.md/.test(r.textContent || ''));
			if (!row) return false;
			row.click();
			return true;
		});
	}
	await p.waitForTimeout(1200);
	check(opened, 'THE FOURTH FIXTURE IS OPEN: the document is in the Doc panel',
		JSON.stringify(await p.evaluate(() => ({
			doc:  (document.getElementById('doc-name') || {}).textContent || '',
			rows: [...document.querySelectorAll('#panel-work .files-row')]
				.map((r) => (r.className.indexOf('sys-row') >= 0 ? 'SYS ' : '') + (r.textContent || '').trim()),
			crumb: (document.querySelector('#panel-work .files-path') || {}).textContent || '',
		}))));

	// Into the editor, and type something that must not be lost.
	await p.evaluate(() => {
		const b = document.querySelector('#doc-view [data-act="edit"]');
		if (b) b.click();
	});
	await p.waitForTimeout(600);
	await p.evaluate((typed) => {
		const ta = document.querySelector('#doc-view .files-edit');
		if (ta) {
			ta.value = typed;
			ta.dispatchEvent(new Event('input', { bubbles: true }));
		}
	}, DOC_TYPED);

	// The fence closes between the typing and the save, which is exactly when it is
	// worst: the only copy of these words is on screen.
	await stamp([{
		name: 'file_write', match: 'rp-doc.md',
		outcome: 'refused', text: 'Refused: rp-doc.md is outside what this Diamond may write.',
	}]);
	await p.evaluate(() => {
		const b = document.querySelector('#doc-view [data-act="edit"]');   // now "✔ Save"
		if (b) b.click();
	});
	await p.waitForTimeout(1500);

	const saved = await p.evaluate(() => {
		const msg = document.querySelector('#doc-view .files-view-msg');
		const ta  = document.querySelector('#doc-view .files-edit');
		return {
			msg:     msg && msg.style.display !== 'none' ? (msg.textContent || '') : '',
			err:     !!(msg && msg.classList.contains('err')),
			editing: !!ta,
			held:    ta ? ta.value : '',
		};
	});
	const onDisk = await p.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		try { return await mod.read_file('rp-doc.md'); } catch (e) { return 'ERR'; }
	});
	check((await stamped()).length > 0, 'THE SAVE REACHED THE FENCE',
		`stamped ${JSON.stringify((await stamped()).slice(0, 2))}, `
			+ `door asked ${JSON.stringify(await seen())}`);
	check(saved.err && /Save failed/i.test(saved.msg) && !/^Saved\./i.test(saved.msg),
		'A REFUSED SAVE DOES NOT SAY "SAVED" — it says the save failed, and says it as an error',
		JSON.stringify(saved.msg.slice(0, 70)));
	check(saved.editing && saved.held === DOC_TYPED,
		'AND THE EDITOR IS STILL STANDING, holding what was typed — the words are not lost '
			+ 'to a message that said they were safe',
		`editing=${saved.editing}, held ${JSON.stringify(saved.held.slice(0, 40))}`);
	check(onDisk === DOC_WAS,
		'and the file on disk is untouched, which is what makes the message a lie or not',
		JSON.stringify(String(onDisk).slice(0, 40)));

} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
