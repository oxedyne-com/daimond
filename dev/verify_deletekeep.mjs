// verify_deletekeep.mjs — what a turn deletes or replaces stays kept, and only the user grants reach.
//
// The audit of 2026-09-23 (`~/usr/code/ai/claude/specs/daimond_delete_open_paths_audit_20260923.md`)
// reproduced two of its findings live on the delete-safety unit and named five more. Each section
// here is one finding, driven through the real wasm and real turns (the mock's `@tool`):
//
//   F1. A daimon cannot forge a mark: its `file_write` and `file_edit` of its own link sidecar are
//       refused, the sidecar is left as it was, and `Files.bounds` ignores a row with no `by`.
//   F2. A deleted file's copy outlives later turns (the audit's H2b): three turns each delete a
//       distinct 400 KiB file, later turns overwrite large files, and the first delete still
//       reverts. A delete the store has no room left to keep is refused in stop-and-ask words.
//   F3. The copy is on disk before the delete: a worker deletes a file, the page is reloaded
//       before any turn end, and the next turn end still records it, so it reverts.
//   F4. The per-turn bound holds across concurrent workers sharing one Diamond: no more deletes
//       run than one manifest keeps, and every one that ran has a restorable row.
//   F7. A daimon's `link_remove` of a user's mark is refused; a mark compares case- and
//       NFC-folded; every Diamond's version store and link sidecar are fenced whatever a mark
//       covers.
//   F5. An overwrite whose old bytes are not on this device to keep -- a file only in cloud
//       storage -- is refused. (The hand's arms and a present-but-unreadable file are pinned by
//       native tests in src/tools.rs; F6 is the page's marks, in dev/verify_marknotice.mjs.)
//   F8. A turn's deletes from the folder the user opened stop after the limit (8 unless set)
//       until the PERSON says: the question is the page's own dialog, asked even under the
//       autonomous posture; a stop refuses the rest of the turn's deletes there and keeps the
//       files; a yes lets it go on and every copy is kept; deletes in Daimond's own storage are
//       never asked about; one question stands for concurrent workers; and with no page to ask,
//       the delete is refused rather than made. The re-check of the same day added two: the
//       question takes focus onto Stop and no key typed as it appears answers it (R6), and at
//       a limit of none each file is its own question (R7).
//
// The re-check of 2026-09-23 (`daimond_bc2_recheck_20260923.md`) added two more:
//
//   F9.  (R1) `web_fetch` with `to` is fenced like every other write: a daimon cannot save a
//        page over its own link sidecar (a forged mark), into a folder nobody marked, or over a
//        version manifest a kept delete depends on -- and the kept delete still reverts.
//   F10. (R1, the table) Every tool the daimon is offered, every argument its schema says holds a
//        path: each is called with the fenced places in that argument, and none of them changes.
//        A control call to a place the turn may write shows the same call does write, so a pass
//        is not a call that could never have written. (`doc_edit`, `sheet_write` and
//        `file_fetch` are not a daimon's; they are pinned natively by
//        `test_every_path_argument_of_every_tool_is_fenced_or_named_as_a_read_00`.)
//   F11. (R4) A write that leaves less than half of a user's file, as the turns found it, is a
//        delete by another verb: past the limit, a turn emptying files in the open folder -- by
//        file_write, file_edit or web_fetch -- waits for the person as a deleting one does, while
//        edits that keep most of a file are not asked about; an emptied file's copy outlives later
//        turns' edits; a file emptied in one turn and deleted in the next can still be put back as
//        it was before it was emptied; and within one turn, the copy kept is the one from before
//        the first wipe. And "emptying most": at a limit of none, a trim to one line is asked
//        about and held, as is the third of three trims that together take most of a file (and
//        it goes back to the file as the turns found it), while an ordinary edit of a paragraph
//        written as one line, and a same-size rewrite that keeps the text, are not asked about.
//        And R4's follow-ons: a destruction by either verb keeps the file as the turns found it --
//        two trims that each leave over half and then a delete put back the whole file, not the
//        trimmed one; and a worker's edit and wipe in one turn, with the page dying before the
//        daimon's turn ends, still put it back whole, because the wipe's copy replaced the edit's
//        note on disk.
//
// F2's later turns are EDITS -- they keep most of each file -- since R4: a write that replaced a
// 300 KiB file with 300 KiB of something else is now a destruction, held and bounded by the room a
// destruction may take, which is not what F2 measures.
//
// Needs a world for the mock provider: `eval "$(bash dev/world.sh N --env)"`.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FOLDER = 'dkfolder';
const MOCK   = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
const only   = (process.env.DK_ONLY || '').split(',').filter(Boolean);
const want   = (f) => !only.length || only.includes(f);

// A loaded machine can take longer than Playwright's thirty seconds to paint the first page.
const s = await open({ name: 'deletekeep', connect: false,
	route: async (page) => { page.setDefaultNavigationTimeout(180000); } });
const p = s.page;
await p.waitForTimeout(1500);

// Helpers installed in the page, re-installed after the reload F3 needs.
const install = (fresh) => p.evaluate(async ({ folder, mock, fresh }) => {
	const mod  = await import('../pkg/oxedyne_daimond.js');
	// After a reload the page initialises the wasm itself; wait for it rather than for a clock.
	for (let i = 0; i < 200; i++) {
		try { mod.workspace_mode(); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
	}
	const root = await navigator.storage.getDirectory();
	if (fresh) {
		try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* first run */ }
	}
	const dir = await root.getDirectoryHandle(folder, { create: true });
	mod.set_workspace_dir(dir);
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const read = async (path) => { try { return await mod.read_file(path); } catch (e) { return null; } };
	const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
		new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
	// A daimon's turn: the mock answers `@tool` / `@tools` with those calls.
	const turnEv = async (id, marks, text) => {
		const eng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
		const seen = [];
		try {
			await eng.steer_crystal(id, text, JSON.stringify(marks), '[]', '[]', [],
				(ev) => { if (ev.type === 'tool_result') seen.push({ name: String(ev.name || ''),
					content: String(ev.content || '') }); });
		} catch (e) { seen.push({ name: '', content: 'THREW: ' + String(e && e.message || e) }); }
		return seen;
	};
	const turn = async (id, marks, tool, args) => (await turnEv(id, marks,
		'@tool ' + tool + ' ' + JSON.stringify(args))).map((e) => e.content).join(' | ').slice(0, 400);
	// A Diamond's worker: its changes wait for the daimon's turn end.
	const worker = async (id, marks, text) => {
		const eng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
		eng.set_diamond_scope('diamonds/' + id, JSON.stringify(marks), '[]', '[]');
		const seen = [];
		try {
			await eng.run_turn(text, (ev) => {
				if (ev.type === 'tool_result') seen.push(String(ev.content || ''));
			});
		} catch (e) { seen.push('THREW: ' + String(e && e.message || e)); }
		return seen;
	};
	const newest = async (id) => {
		const rows = JSON.parse(await app.versions_list(id));
		return rows.length ? rows[0] : null;
	};
	window.__k = { mod, app, dir, read, sha, turn, turnEv, worker, newest };
}, { folder: FOLDER, mock: MOCK, fresh });

await install(true);
const id = await p.evaluate(() => __k.app.create_diamond('delete keep'));

// ── F1: the sidecar is the record, and a row with no `by` is nobody's ────
if (want('F1')) {
	const f1 = await p.evaluate(async (id) => {
		const { mod, read, turn } = __k;
		const out = {};
		const side = 'diamonds/' + id + '/.daimond/links.jsonl';
		await mod.write_file('vault/v.md', 'v');
		await mod.write_file('secret/x.md', 'not granted');
		// A link of the daimon's own, so the sidecar exists and has a line to edit.
		out.link = await turn(id, ['vault'], 'link_add',
			{ from: 'diamond:' + id, to: 'dir:vault/linked', rel: 'holds' });
		const before = await read(side);
		out.hadSidecar = before !== null;
		const forged = JSON.stringify({ id: 'forged1', ts: 1, from: 'diamond:' + id,
			to: 'dir:secret', rel: 'holds', note: '' });
		out.write = await turn(id, ['vault'], 'file_write',
			{ path: side, content: (before || '') + forged + '\n' });
		out.edit  = await turn(id, ['vault'], 'file_edit',
			{ path: side, old_string: '"by":"agent:daimon"', new_string: '"by":"user"' });
		const after = await read(side);
		out.untouched = after === before;
		out.bounds1 = (await DaimondDiamond.bounds(id)).attached;
		// Two rows written through the test's own door: one with no `by`, one the user's.
		await mod.write_file(side, (after || '')
			+ JSON.stringify({ id: 'legacy1', ts: 2, from: 'diamond:' + id, to: 'dir:nobody',
				rel: 'holds', note: '' }) + '\n'
			+ JSON.stringify({ id: 'user1', ts: 3, from: 'diamond:' + id, to: 'dir:granted',
				rel: 'holds', note: '', by: 'user' }) + '\n');
		// R2: a row is only a claim until pressed here, so the user's own mark is
		// pressed, exactly as Use here does. The row with no `by` is left waiting
		// on purpose: the contrast this check is about is now between a mark
		// pressed and one that is not, rather than between the two kinds of row.
		if (window.DaimondAttach && DaimondAttach.confirmHere) {
			await DaimondAttach.confirmHere(id, 'dir:granted');
		}
		out.bounds2 = (await DaimondDiamond.bounds(id)).attached;
		// Put the sidecar back as the daimon left it, for the sections after.
		await mod.write_file(side, after || '');
		// DENY BY DEFAULT: a record file nobody has named is fenced too, and so is the old name.
		out.newRecord = await turn(id, ['vault'], 'file_write',
			{ path: 'diamonds/' + id + '/.daimond/authority.json', content: '{"grant":"secret"}' });
		out.oldName = await turn(id, ['vault'], 'file_write',
			{ path: 'diamonds/' + id + '/.red/links.jsonl', content: forged });
		return out;
	}, id);
	const has = (l, x) => Array.isArray(l) && l.includes(x);
	check('F1. the daimon has a link of its own to attack', /^Linked /.test(f1.link) && f1.hadSidecar,
		f1.link.slice(0, 160));
	check("F1. a daimon's file_write of its own link sidecar is refused",
		/^Refused/.test(f1.write), f1.write.slice(0, 200));
	check("F1. and so is its file_edit", /^Refused/.test(f1.edit), f1.edit.slice(0, 200));
	check('F1. the sidecar is as it was', f1.untouched === true);
	check('F1. no forged folder is in the bounds',
		!has(f1.bounds1, 'secret') && !has(f1.bounds1, 'vault/linked'), JSON.stringify(f1.bounds1));
	check("F1. a record file nobody has named is fenced as well (deny by default)",
		/^Refused/.test(f1.newRecord) && /Daimond's own record/.test(f1.newRecord), f1.newRecord.slice(0, 200));
	check('F1. and so is the store directory\'s old name', /^Refused/.test(f1.oldName), f1.oldName.slice(0, 200));
	check('F1. Files.bounds ignores a row with no `by`, and keeps the user\'s',
		!has(f1.bounds2, 'nobody') && has(f1.bounds2, 'granted'), JSON.stringify(f1.bounds2));
}

// ── F2: a deleted file's copy survives later turns (H2b) ─────────────────
if (want('F2')) {
	const f2 = await p.evaluate(async (id) => {
		const { mod, read, turn } = __k;
		const out = { del: {}, back: {}, rev: {} };
		const big = (c, kb) => (c + ':' + Math.random() + ':').repeat(40000).slice(0, kb * 1024);
		const text = {};
		for (const n of ['a1', 'a2', 'a3']) {
			text[n] = big(n, 400);
			await mod.write_file('vault/big/' + n + '.bin', text[n]);
		}
		for (const n of ['a1', 'a2', 'a3']) {
			out.del[n] = await turn(id, ['vault'], 'file_delete', { path: 'vault/big/' + n + '.bin' });
		}
		// Later turns overwriting large files: ordinary EDITS, which keep most of each file, and
		// which the old prune took the deletes' copies to make room for.
		const lines = (c, kb) => {
			let t = '';
			for (let i = 0; t.length < kb * 1024; i++) t += c + ':' + i + ':' + Math.random() + '\n';
			return t;
		};
		for (const n of ['e1', 'e2', 'e3']) {
			const was = lines(n, 300);
			await mod.write_file('vault/big/' + n + '.bin', was);
			out[n] = await turn(id, ['vault'], 'file_write',
				{ path: 'vault/big/' + n + '.bin', content: n + ': edited\n' + was.slice(was.indexOf('\n') + 1) });
		}
		for (const n of ['a1', 'a2', 'a3']) {
			const path = 'vault/big/' + n + '.bin';
			if (/^Deleted /.test(out.del[n])) {
				out.rev[n] = await turn(id, ['vault'], 'file_revert', { path });
			}
			out.back[n] = (await read(path)) === text[n];
		}
		return out;
	}, id);
	check('F2. the first turn deletes a 400 KiB file', /^Deleted /.test(f2.del.a1), f2.del.a1.slice(0, 160));
	check('F2. and the second another', /^Deleted /.test(f2.del.a2), f2.del.a2.slice(0, 160));
	check('F2. later turns overwrite large files', /^Wrote /.test(f2.e3 || ''), String(f2.e3).slice(0, 160));
	check("F2. an earlier turn's delete still reverts after later turns (H2b)",
		f2.back.a1 === true, String(f2.rev.a1).slice(0, 200));
	check('F2. and so does the second', f2.back.a2 === true, String(f2.rev.a2).slice(0, 200));
	check('F2. a delete with no room left to keep is refused and sent to the user, or kept',
		(/^Deleted /.test(f2.del.a3) && f2.back.a3 === true)
			|| (/^Refused/.test(f2.del.a3) && /ask the user/.test(f2.del.a3) && f2.back.a3 === true),
		f2.del.a3.slice(0, 240));
}

// ── F3: the copy is on disk before the file goes ──────────────────────────
if (want('F3')) {
	const pre = await p.evaluate(async (id) => {
		const { mod, read, worker } = __k;
		await mod.write_file('vault/w3.md', 'the worker deletes me, then the page dies');
		const said = await worker(id, ['vault'],
			'@tool file_delete ' + JSON.stringify({ path: 'vault/w3.md' }));
		return { said: said.join(' | ').slice(0, 200), gone: (await read('vault/w3.md')) === null };
	}, id);
	// The page dies before any turn of the daimon's ends: the worker's capture was in memory.
	await p.reload();
	await p.waitForTimeout(1500);
	await install(false);
	const post = await p.evaluate(async (id) => {
		const { read, turn } = __k;
		const end = await turn(id, ['vault'], 'file_list', { path: 'vault' });
		const rev = await turn(id, ['vault'], 'file_revert', { path: 'vault/w3.md' });
		return { end: end.slice(0, 120), rev: rev.slice(0, 200),
			back: (await read('vault/w3.md')) === 'the worker deletes me, then the page dies' };
	}, id);
	check("F3. a worker's delete runs", /Deleted /.test(pre.said) && pre.gone, pre.said);
	check('F3. and after the page is reloaded before any turn end, it still reverts',
		post.back === true, post.rev);
}

// ── F4: concurrent workers share one bound ────────────────────────────────
if (want('F4')) {
	const f4 = await p.evaluate(async (id) => {
		const { mod, app, worker, turn, newest } = __k;
		// THE STORE'S bound is what this measures, so the person's open-folder limit (F8) is set
		// to the store's own figure, where it never asks. An older build has no such setting.
		if (typeof app.set_open_deletes_ask === 'function') app.set_open_deletes_ask(64);
		const W = 3, PER = 25;
		const texts = [];
		for (let k = 0; k < W; k++) {
			const calls = [];
			for (let i = 0; i < PER; i++) {
				const path = 'vault/cc/w' + k + '_' + i + '.txt';
				await mod.write_file(path, 'cc ' + k + ' ' + i);
				calls.push('file_delete ' + JSON.stringify({ path }));
			}
			texts.push('@tools ' + calls.join(' ;; '));
		}
		const said = await Promise.all(texts.map((t) => worker(id, ['vault'], t)));
		const all = said.flat();
		const out = {
			done:    all.filter((x) => /^Deleted /.test(x)).length,
			refused: all.filter((x) => /^Refused/.test(x)).length,
		};
		await turn(id, ['vault'], 'file_list', { path: 'vault' });
		const m = await newest(id);
		out.rows = m ? (m.files || []).filter((f) => /^vault\/cc\//.test(f.path) && f.gone && f.was).length : 0;
		out.truncated = m ? (m.truncated || 0) : -1;
		if (typeof app.set_open_deletes_ask === 'function') app.set_open_deletes_ask(-1);
		return out;
	}, id);
	check('F4. concurrent workers ran no more deletes than one version keeps',
		f4.done <= 64 && f4.done > 0, JSON.stringify(f4));
	check('F4. and every delete that ran has a restorable row, none only counted',
		f4.rows === f4.done && f4.truncated === 0, JSON.stringify(f4));
}

// ── F5: an overwrite whose old bytes are not here to keep is refused ──────
//
// The one case a browser can show: a file held only in cloud storage is not on this device, and
// its read failing was taken as "no file here", so a daimon's write replaced it with no copy.
// (A present file that will not read, and the hand's binary, oversized and unreadable answers,
// are pinned natively: `test_an_overwrite_with_no_copy_is_refused_and_only_not_found_is_new_00`.)
if (want('F5')) {
	const f5 = await p.evaluate(async (id) => {
		const { turn } = __k;
		if (!window.DaimondCloud) return { cloud: false };
		await DaimondCloud.put('vault/cloudonly.md', { size: 9, chunks: [] }, 'h5',
			{ file: { size: 9 }, timeless: true });
		await DaimondCloud.refreshPaths();
		const out = { cloud: true };
		out.write = await turn(id, ['vault'], 'file_write',
			{ path: 'vault/cloudonly.md', content: 'replaced with no copy' });
		out.kept = !!DaimondCloud.index()['vault/cloudonly.md'];
		DaimondCloud.forget('vault/cloudonly.md');
		await DaimondCloud.refreshPaths();
		return out;
	}, id);
	check('F5. the cloud index is here to test with', f5.cloud === true);
	check("F5. a daimon's overwrite of a file only in cloud storage is refused, not made without a copy",
		/^Refused/.test(f5.write || '') && /cloud storage/.test(f5.write || '') && f5.kept === true,
		String(f5.write).slice(0, 220));
}

// ── F7: minors ─────────────────────────────────────────────────────────────
if (want('F7')) {
	const f7 = await p.evaluate(async (id) => {
		const { mod, app, read, turn } = __k;
		const out = {};
		const self = 'diamond:' + id;
		// A daimon's link_remove of the user's mark.
		await app.add_link(id, self, 'dir:vault/usermark', 'holds', '', 'user');
		await app.add_link(id, self, 'dir:vault/agentmark', 'holds', '', 'agent:daimon');
		const links = JSON.parse(await app.links_touching(self) || '[]');
		const um = links.find((l) => /usermark$/.test(l.other));
		const am = links.find((l) => /agentmark$/.test(l.other));
		out.rmUser  = await turn(id, ['vault'], 'link_remove', { owner: id, id: um ? um.id : '' });
		out.rmAgent = await turn(id, ['vault'], 'link_remove', { owner: id, id: am ? am.id : '' });
		const after = JSON.parse(await app.links_touching(self) || '[]').map((l) => l.other);
		out.userKept  = after.some((r) => /usermark$/.test(r));
		out.agentGone = !after.some((r) => /agentmark$/.test(r));
		// A marked file named in another case, and in another Unicode form.
		await mod.write_file('vault/keep.md', 'marked');
		out.caseDel = await turn(id, ['vault', 'vault/keep.md'], 'file_delete', { path: 'vault/KEEP.md' });
		const nfc = 'vault/café.md', nfd = 'vault/café.md';
		await mod.write_file(nfc, 'marked too');
		out.nfcDel = await turn(id, ['vault', nfc], 'file_delete', { path: nfd });
		out.caseMove = await turn(id, ['vault', 'vault/keep.md', 'dest'], 'file_move',
			{ path: 'VAULT/Keep.md', to: 'dest/k.md' });
		out.keptBoth = (await read('vault/keep.md')) === 'marked' && (await read(nfc)) === 'marked too';
		// Another Diamond's record, under a mark that covers `diamonds`.
		const other = await app.create_diamond('another');
		out.otherVersions = await turn(id, ['diamonds'], 'file_write',
			{ path: 'diamonds/' + other + '/versions/0001.files.json', content: '{}' });
		out.otherSidecar  = await turn(id, ['diamonds'], 'file_write',
			{ path: 'diamonds/' + other + '/.daimond/links.jsonl', content: '{}' });
		out.otherWork     = await turn(id, ['diamonds'], 'file_write',
			{ path: 'diamonds/' + other + '/notes.md', content: 'a mark covers it' });
		// R2: A CONFIRMATION WRITES ONLY THIS DEVICE'S OWN RECORD -- no add, no remove,
		// no stamp on the row at all, so "the store refuses the new row" (the OLD
		// confirm's add-before-remove hazard, from before R2 rewrote the row on every
		// press) has nothing left to refuse: `confirmHere` never calls `add_link`. What
		// can still fail is the write to THIS DEVICE'S RECORD itself (quota, or storage
		// blocked), and the mark must stay waiting, exactly as `marks.not_saved` says.
		const side = 'diamonds/' + id + '/.daimond/links.jsonl';
		const had = (await read(side)) || '';
		await mod.write_file(side, had + JSON.stringify({ id: 'legacy7', ts: 7, from: self,
			to: 'dir:confirmme', rel: 'holds', note: '' }) + '\n');
		const A = window.DaimondAttach || {};
		const pageApp = window.DaimondCore && DaimondCore.diamondApp && DaimondCore.diamondApp();
		out.confirmApi = !!(A.confirmHere && pageApp);
		if (out.confirmApi) {
			const realSetItem = window.localStorage.setItem.bind(window.localStorage);
			window.localStorage.setItem = () => { throw new Error('quota exceeded, or storage blocked'); };
			try { out.failed = await A.confirmHere(id, 'dir:confirmme'); } catch (e) { out.failed = 'threw'; }
			window.localStorage.setItem = realSetItem;
			out.kept = JSON.parse(await app.links_touching(self) || '[]')
				.filter((l) => /confirmme$/.test(l.other)).map((l) => [l.other, l.by || '']);
			out.bFail = (await DaimondDiamond.bounds(id)).attached;
			out.done = await A.confirmHere(id, 'dir:confirmme');
			out.after = JSON.parse(await app.links_touching(self) || '[]')
				.filter((l) => /confirmme$/.test(l.other)).map((l) => [l.other, l.by || '']);
			out.bDone = (await DaimondDiamond.bounds(id)).attached;
		}
		return out;
	}, id);
	check("F7. a daimon's link_remove of the user's mark is refused",
		/^Refused/.test(f7.rmUser) && f7.userKept === true, f7.rmUser.slice(0, 200));
	check('F7. and of its own link still works', /Removed link/.test(f7.rmAgent) && f7.agentGone === true,
		f7.rmAgent.slice(0, 160));
	check('F7. a marked file named in another case is not deleted',
		/^Refused/.test(f7.caseDel) && /places this turn was given/.test(f7.caseDel), f7.caseDel.slice(0, 200));
	check('F7. nor in another Unicode form',
		/^Refused/.test(f7.nfcDel) && /places this turn was given/.test(f7.nfcDel), f7.nfcDel.slice(0, 200));
	check('F7. nor moved', /^Refused/.test(f7.caseMove), f7.caseMove.slice(0, 200));
	check('F7. and both are still there', f7.keptBoth === true);
	check("F7. another Diamond's version store is fenced whatever a mark covers",
		/^Refused/.test(f7.otherVersions), f7.otherVersions.slice(0, 200));
	check('F7. and its link sidecar', /^Refused/.test(f7.otherSidecar), f7.otherSidecar.slice(0, 200));
	check('F7. while its ordinary files are the mark\'s to write', /^Wrote /.test(f7.otherWork),
		f7.otherWork.slice(0, 160));
	// R2: the row is untouched either way now (no add, no remove, no stamp), so what
	// this asks is whether a press whose own record-write fails leaves the mark
	// waiting -- the opposite of before R2, when a doomed REWRITE had to leave the
	// OLD row in place. `kept[0][1]` stays `''`: confirming never makes the row the
	// user's, since it was never rewritten to say so.
	check('F7. a confirmation whose record-write does not land leaves the mark waiting, row untouched',
		f7.confirmApi === true && f7.failed === false && Array.isArray(f7.kept) && f7.kept.length === 1
			&& f7.kept[0][1] === '' && !(f7.bFail || []).includes('confirmme'),
		JSON.stringify({ api: f7.confirmApi, failed: f7.failed, kept: f7.kept }));
	check("F7. and once the record can be written, the same press puts the mark in force -- the row still unrewritten, still nobody's",
		f7.done === true && Array.isArray(f7.after) && f7.after.length === 1 && f7.after[0][1] === ''
			&& (f7.bDone || []).includes('confirmme'),
		JSON.stringify({ done: f7.done, after: f7.after, attached: f7.bDone }));
}

// ── F8: past the limit, a turn's deletes from the open folder wait for the PERSON ──
//
// Decision review of 2026-09-23, decision 2 (delete unit items b and c): sixty-four deletes on a
// real disk, each carried off the machine at once by whatever syncs the folder, is a bulk delete
// however well each copy is kept. So a turn deletes a handful there and then the person is asked,
// through the page's own dialog -- never the permission door, which answers for an unattended
// turn under the autonomous posture. The posture is ON for every turn below.
if (want('F8')) {
	const setup = await p.evaluate(async (id) => {
		const { mod, app } = __k;
		const out = { api: typeof app.set_open_deletes_ask === 'function', driver: !!window.DaimondDeletes };
		try { localStorage.setItem('daimond-autonomous-posture', '1'); } catch (e) { /* private mode */ }
		// Set where the build has it; a build without it is measured as it is.
		window.__ask = (n) => { if (typeof __k.app.set_open_deletes_ask === 'function') __k.app.set_open_deletes_ask(n); };
		window.__ask(3);
		if (out.api) out.limit = app.open_deletes_ask();
		for (const n of ['a0', 'a1', 'a2', 'a3', 'a4', 'c0', 'c1', 'c2', 'c3', 'c4', 'd0', 'd1',
			'k0', 'k1', 'k2', 'k3', 'k4', 'g0', 'g1', 'g2', 'g3']) {
			await mod.write_file('vault/f8/' + n + '.md', 'f8 ' + n);
		}
		for (const n of ['s0', 's1']) await mod.write_file('diamonds/' + id + '/f8s/' + n + '.md', 'store ' + n);
		for (let w = 0; w < 2; w++) {
			for (let i = 0; i < 3; i++) await mod.write_file('vault/f8w/w' + w + '_' + i + '.md', 'w');
		}
		return out;
	}, id);
	check('F8. the engine has the limit and the page has the question', setup.api && setup.driver
		&& setup.limit === 3, JSON.stringify(setup));

	// A turn started in the page and LEFT RUNNING, so the dialog it raises can be answered here.
	const dels = (names) => '@tools ' + names.map((n) => 'file_delete '
		+ JSON.stringify({ path: n.indexOf('/') < 0 ? 'vault/f8/' + n + '.md' : n })).join(' ;; ');
	const start = (tag, text) => p.evaluate(({ id, tag, text }) => {
		window.__f8 = window.__f8 || {};
		window.__f8[tag] = __k.turnEv(id, ['vault'], text);
		return true;
	}, { id, tag, text });
	const finish = (tag) => p.evaluate(async (tag) =>
		(await window.__f8[tag]).filter((e) => e.name === 'file_delete').map((e) => e.content), tag);
	const HELD = '.modal.dlg[data-ask="delete-held"]';
	const dialog = async (ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			const el = await p.$(HELD);
			if (el) return { text: (await el.textContent()) || '', count: (await p.$$(HELD)).length };
			await p.waitForTimeout(150);
		}
		return null;
	};
	// A yes waits until it can be pressed: an unbidden question's yes is held for its first
	// second (R6), and a forced click on a disabled button is no click at all.
	const answer = async (yes) => {
		if (yes) await p.waitForSelector(HELD + ' .dlg-ok:not([disabled])', { timeout: 5000 }).catch(() => {});
		await p.click(HELD + (yes ? ' .dlg-ok' : ' .dlg-cancel'), { force: true });
	};
	// A build with no question raises none; it is not waited on for the length of one.
	const WAIT = setup.api ? 45000 : 5000;
	// Whether each named file is still in the folder, keyed by the name it was given.
	const there = (names) => p.evaluate(async (names) => {
		const out = {};
		for (const n of names) out[n] = (await __k.read('vault/f8/' + n + '.md')) !== null;
		return out;
	}, names);
	const done = (said) => said.filter((x) => /^Deleted /.test(x)).length;
	const stoppedSaid = (x) => /^Refused/.test(x) && /did not let it go on/.test(x);

	// 1. Stop.
	await start('stop', dels(['a0', 'a1', 'a2', 'a3', 'a4']));
	const d1 = await dialog(WAIT);
	if (d1) await answer(false);
	const s1 = await finish('stop');
	const k1 = await there(['a0', 'a1', 'a2', 'a3', 'a4']);
	check('F8. past the limit the PERSON is asked, under the autonomous posture too',
		!!d1 && /a3\.md/.test(d1.text), d1 ? d1.text.slice(0, 200) : 'no dialog');
	check('F8. a stop refuses the rest of the turn\'s deletes there, in words that send it to the user',
		done(s1) === 3 && s1.filter(stoppedSaid).length === 2,
		JSON.stringify(s1.map((x) => x.slice(0, 70))));
	check('F8. and the files it was stopped at are still there',
		!k1.a0 && !k1.a1 && !k1.a2 && k1.a3 && k1.a4, JSON.stringify(k1));

	// 2. A new turn is a new count, and a yes lets it go on, every copy kept.
	await start('go', dels(['c0', 'c1', 'c2', 'c3', 'c4']));
	const d2 = await dialog(WAIT);
	if (d2) await answer(true);
	const s2 = await finish('go');
	const back = await p.evaluate(async (id) => {
		const said = await __k.turn(id, ['vault'], 'file_revert', { path: 'vault/f8/c4.md' });
		return { said: said.slice(0, 160), back: (await __k.read('vault/f8/c4.md')) === 'f8 c4' };
	}, id);
	check('F8. a new turn is asked afresh, and a yes lets it go on',
		!!d2 && done(s2) === 5, JSON.stringify(s2.map((x) => x.slice(0, 50))));
	check('F8. and what it deleted past the question is kept', back.back === true, back.said);

	// 3. Daimond's own storage is not the user's folder and is never asked about.
	await p.evaluate(() => window.__ask(0));
	await start('store', dels(['diamonds/' + id + '/f8s/s0.md', 'diamonds/' + id + '/f8s/s1.md']));
	const d3 = await dialog(4000);
	if (d3) await answer(false);
	const s3 = await finish('store');
	check("F8. deletes in Daimond's own storage are not asked about, even at a limit of none",
		!d3 && done(s3) === 2, JSON.stringify({ dialog: !!d3, said: s3.map((x) => x.slice(0, 50)) }));

	// 4. Concurrent workers share one count and one question.
	await p.evaluate(() => window.__ask(2));
	await p.evaluate((id) => {
		window.__f8w = [0, 1].map((w) => __k.worker(id, ['vault'], '@tools ' + [0, 1, 2].map((i) =>
			'file_delete ' + JSON.stringify({ path: 'vault/f8w/w' + w + '_' + i + '.md' })).join(' ;; ')));
		return true;
	}, id);
	const d4 = await dialog(WAIT);
	await p.waitForTimeout(1500);
	const d4n = (await p.$$(HELD)).length;
	if (d4) await answer(false);
	const s4 = await p.evaluate(async () => (await Promise.all(window.__f8w)).flat());
	await p.evaluate((id) => __k.turn(id, ['vault'], 'file_list', { path: 'vault/f8w' }), id);
	check('F8. concurrent workers share one count and are asked one question',
		!!d4 && d4n === 1 && s4.filter((x) => /Deleted /.test(x)).length === 2
			&& s4.filter(stoppedSaid).length === 4,
		JSON.stringify({ dialogs: d4n, said: s4.map((x) => x.slice(0, 40)) }));

	// 6. A key meant for somewhere else does not answer (re-check R6). The person is typing
	// in a box while the turn works; the question used to take focus onto "Let it go on", so
	// their next Space or Enter let the turn delete everything it asked for.
	await p.evaluate(() => {
		window.__ask(3);
		let ta = document.getElementById('__f8typing');
		if (!ta) {
			ta = document.createElement('textarea');
			ta.id = '__f8typing';
			ta.style.cssText = 'position:fixed;left:0;bottom:0;width:300px;height:60px;z-index:1';
			document.body.appendChild(ta);
		}
		ta.value = '';
		ta.focus();
	});
	await start('keys', dels(['k0', 'k1', 'k2', 'k3', 'k4']));
	await p.keyboard.type('please tidy');
	// Waited on by the page's own observer rather than by polling, so the keys below land
	// within a typist's gap of the question appearing, which is the case being tested.
	const d6 = await p.waitForSelector(HELD, { timeout: WAIT }).then(() => true, () => false);
	const t6 = Date.now();
	const f6 = await p.evaluate(() => {
		const a = document.activeElement;
		return a ? String(a.className || a.tagName) : '';
	});
	await p.keyboard.press('Space');
	await p.keyboard.press('Enter');
	const ms6 = Date.now() - t6;
	await p.waitForTimeout(250);
	const up6 = !!(await p.$(HELD));
	const k6 = await there(['k3', 'k4']);
	// Past the first second a key can reach only the button it is on, which is Stop.
	await p.waitForTimeout(1100);
	if (await p.$(HELD)) await p.keyboard.press('Enter');
	await p.waitForTimeout(400);
	const gone6 = !(await p.$(HELD));
	if (!gone6) await answer(false);
	const s6 = await finish('keys');
	const e6 = await there(['k3', 'k4']);
	check('F8. the question takes focus onto Stop, not onto its yes',
		!!d6 && /dlg-cancel/.test(f6), JSON.stringify({ dialog: !!d6, focus: f6 }));
	check('F8. a Space and an Enter typed as it appears answer nothing, and delete nothing',
		!!d6 && ms6 < 900 && up6 && k6.k3 === true && k6.k4 === true,
		JSON.stringify({ pressedWithinMs: ms6, stillUp: up6, kept: k6 }));
	check('F8. and a key after the first second can only stop the turn',
		gone6 && done(s6) === 3 && s6.filter(stoppedSaid).length === 2 && e6.k3 && e6.k4,
		JSON.stringify({ closedByKey: gone6, said: s6.map((x) => x.slice(0, 50)), kept: e6 }));

	// 7. "Ask before every one" asks before every one (re-check R7): the first yes let the rest
	// of the turn delete there unasked. Each file is its own question now, and a stop is final.
	await p.evaluate(() => window.__ask(0));
	await p.evaluate(({ id, text }) => {
		window.__f8end = false;
		window.__f8.each = __k.turnEv(id, ['vault'], text);
		window.__f8.each.then(() => { window.__f8end = true; }, () => { window.__f8end = true; });
		return true;
	}, { id, text: dels(['g0', 'g1', 'g2', 'g3']) });
	const asked7 = [];
	const until7 = Date.now() + 90000;
	while (Date.now() < until7 && !(await p.evaluate(() => window.__f8end))) {
		const el = await p.$(HELD);
		if (!el) { await p.waitForTimeout(150); continue; }
		const text = (await el.textContent()) || '';
		const name = (/(g[0-3])\.md/.exec(text) || [])[1] || '?';
		asked7.push(name);
		// Yes to the first two, and Stop at the third.
		await answer(asked7.length < 3);
		await el.waitForElementState('hidden', { timeout: 5000 }).catch(() => {});
	}
	const s7 = await finish('each');
	const k7 = await p.evaluate(async () => {
		const out = {};
		for (const n of ['g0', 'g1', 'g2', 'g3']) out[n] = (await __k.read('vault/f8/' + n + '.md')) !== null;
		return out;
	});
	const kept7 = Object.keys(k7).filter((n) => k7[n]).length;
	check('F8. "Ask before every one" asks about each file, naming it',
		asked7.length === 3 && new Set(asked7).size === 3 && !asked7.includes('?'),
		JSON.stringify({ asked: asked7 }));
	check('F8. a yes lets that one file go, and a stop keeps the rest, unasked',
		done(s7) === 2 && s7.filter(stoppedSaid).length === 2 && kept7 === 2,
		JSON.stringify({ said: s7.map((x) => x.slice(0, 50)), kept: k7 }));

	// 5. With nobody able to ask, the delete is refused, not made.
	await p.evaluate(() => { window.__ask(1); window.__f8keep = window.DaimondDeletes;
		window.DaimondDeletes = undefined; });
	const s5 = await p.evaluate(async (id) => (await __k.turnEv(id, ['vault'], '@tools '
		+ ['d0', 'd1'].map((n) => 'file_delete ' + JSON.stringify({ path: 'vault/f8/' + n + '.md' })).join(' ;; ')))
		.filter((e) => e.name === 'file_delete').map((e) => e.content), id);
	const k5 = await there(['d0', 'd1']);
	await p.evaluate(() => { window.DaimondDeletes = window.__f8keep; window.__ask(-1);
		try { localStorage.removeItem('daimond-autonomous-posture'); } catch (e) { /* private mode */ } });
	check('F8. with no page to ask, the delete past the limit is refused rather than made',
		done(s5) === 1 && s5.filter(stoppedSaid).length === 1 && k5.d1 === true,
		JSON.stringify({ said: s5.map((x) => x.slice(0, 60)), kept: k5 }));
	const limit = await p.evaluate(() => typeof __k.app.open_deletes_ask === 'function'
		? __k.app.open_deletes_ask() : null);
	check('F8. and the limit goes back to eight when set to the default', limit === 8, String(limit));
}

// ── F9: web_fetch's `to` is a write, and fenced as one (re-check R1) ──────────
//
// The gateway's answer is stood in by `window.DaimondWeb.fetch`, which is exactly what
// `src/wasm/web.rs` `fetch_raw` awaits; in production it is whatever the fetched URL serves.
if (want('F9')) {
	const f9 = await p.evaluate(async () => {
		const { mod, app, read, turn } = __k;
		const out = {};
		// A Diamond of its own, so the sections before cannot have moved its record.
		const id = await app.create_diamond('f9 web fetch');
		await mod.write_file('vault/f9/v.md', 'v');
		await mod.write_file('secret/f9.md', 'not granted');
		await mod.write_file('vault/f9/keep.md', 'precious');
		out.link = await turn(id, ['vault'], 'link_add',
			{ from: 'diamond:' + id, to: 'dir:vault/f9/linked', rel: 'holds' });
		// A kept delete, so there is a manifest a revert depends on.
		out.del = await turn(id, ['vault'], 'file_delete', { path: 'vault/f9/keep.md' });
		const rows = JSON.parse(await app.versions_list(id));
		const n = rows.length ? rows[0].version : 0;
		const man = 'diamonds/' + id + '/versions/' + String(n).padStart(4, '0') + '.files.json';
		const side = 'diamonds/' + id + '/.daimond/links.jsonl';
		const before = { side: await read(side), man: await read(man), secret: await read('secret/f9.md') };
		out.hadBoth = before.side !== null && before.man !== null;
		out.bounds0 = (await DaimondDiamond.bounds(id)).attached;
		// What the "page" serves: a forged `holds` row, written by "the user".
		let served = (before.side || '') + JSON.stringify({ id: 'forged9', ts: 1, from: 'diamond:' + id,
			to: 'dir:secret', rel: 'holds', note: '', by: 'user' }) + '\n';
		const keepFetch = window.DaimondWeb && window.DaimondWeb.fetch;
		window.DaimondWeb = window.DaimondWeb || {};
		window.DaimondWeb.fetch = async (url) => ({ url, content_type: 'text/plain',
			body_b64: btoa(served), bytes: served.length });
		out.side = await turn(id, ['vault'], 'web_fetch', { url: 'https://example.test/links', to: side });
		served = 'overwritten by web_fetch';
		out.secret = await turn(id, ['vault'], 'web_fetch', { url: 'https://example.test/x', to: 'secret/f9.md' });
		served = '{}';
		out.man = await turn(id, ['vault'], 'web_fetch', { url: 'https://example.test/y', to: man });
		// The door still works where the turn may write.
		served = 'a download';
		out.ok = await turn(id, ['vault'], 'web_fetch', { url: 'https://example.test/z', to: 'vault/f9/dl.txt' });
		out.okBytes = await read('vault/f9/dl.txt');
		window.DaimondWeb.fetch = keepFetch;
		out.sideSame = (await read(side)) === before.side;
		out.manSame = (await read(man)) === before.man;
		out.secretSame = (await read('secret/f9.md')) === before.secret;
		out.bounds1 = (await DaimondDiamond.bounds(id)).attached;
		out.rev = await turn(id, ['vault'], 'file_revert', { path: 'vault/f9/keep.md' });
		out.back = (await read('vault/f9/keep.md')) === 'precious';
		return out;
	});
	const has = (l, x) => Array.isArray(l) && l.includes(x);
	check('F9. the daimon has a sidecar and a kept delete to attack',
		f9.hadBoth === true && /^Deleted /.test(f9.del), String(f9.del).slice(0, 120));
	check("F9. web_fetch 'to' its own link sidecar is refused, and the sidecar is as it was",
		/^Refused/.test(f9.side) && f9.sideSame === true, f9.side.slice(0, 200));
	check('F9. no forged folder is in the bounds',
		!has(f9.bounds1, 'secret') && JSON.stringify(f9.bounds1) === JSON.stringify(f9.bounds0),
		JSON.stringify({ before: f9.bounds0, after: f9.bounds1 }));
	check("F9. web_fetch 'to' a folder nobody marked is refused, and the file is as it was",
		/^Refused/.test(f9.secret) && f9.secretSame === true, f9.secret.slice(0, 200));
	check("F9. web_fetch 'to' a version manifest is refused, and the manifest is as it was",
		/^Refused/.test(f9.man) && f9.manSame === true, f9.man.slice(0, 200));
	check('F9. and the kept delete still reverts', f9.back === true, String(f9.rev).slice(0, 200));
	check("F9. web_fetch 'to' a place the turn may write still saves the bytes",
		/^Saved \d+ bytes/.test(f9.ok) && f9.okBytes === 'a download', f9.ok.slice(0, 160));
}

// ── F10: every tool, every argument that names a path (re-check R1, the table) ──
//
// The native test asks the guard; this asks the whole dispatch, down to the primitive that writes.
// The arguments are found in the schemas the daimon is actually sent, by the same rule the native
// test uses, and the ones that are not writes are named here with the native test's reasons.
if (want('F10')) {
	const f10 = await p.evaluate(async () => {
		const { mod, app, turnEv, dir } = __k;
		const out = { rows: [], wire: false };
		const id = await app.create_diamond('f10 table');
		const READS = ['file_read.path', 'file_read.paths', 'file_list.path', 'file_search.path',
			'outline.path', 'file_glob.path', 'artefact_add.path', 'file_show.path',
			'sheet_read.path', 'serve.path', 'typst_compile.path', 'ocr.path', 'mail_read.path'];
		const RUNS_IN = ['run.cwd', 'verify.cwd'];
		const NOT_PATHS = ['file_search.glob', 'verify.name', 'run.argv', 'link_add.from',
			'link_add.to', 'mail_draft.from', 'mail_draft.to'];
		const PATH_NAMES = ['path', 'paths', 'to', 'out', 'cwd', 'from', 'dir', 'dest', 'file'];
		// What stands at a path, file or folder, read off the handles rather than through any door
		// under test: a folder a leak made is a change a file read would miss.
		const rootOf = async (path) => /^(diamonds|chats|mail)\//.test(path)
			? navigator.storage.getDirectory() : dir;
		const walk = async (path) => {
			let d = await rootOf(path);
			const parts = path.split('/').filter(Boolean);
			const leaf = parts.pop();
			for (const s of parts) d = await d.getDirectoryHandle(s);
			return [d, leaf];
		};
		const state = async (path) => {
			let d, leaf;
			try { [d, leaf] = await walk(path); } catch (e) { return null; }
			try { const fh = await d.getFileHandle(leaf); return 'F:' + await (await fh.getFile()).text(); }
			catch (e) { /* not a file */ }
			try { await d.getDirectoryHandle(leaf); return 'D'; } catch (e) { return null; }
		};
		const putBack = async (path, was) => {
			const [d, leaf] = await walk(path);
			if (was === null) { await d.removeEntry(leaf, { recursive: true }); return; }
			if (was === 'D') return;
			await mod.write_file(path, was.slice(2));
		};
		const wire = JSON.parse(await app.wire_system(id, JSON.stringify(['vault']), '[]', '[]'));
		out.wire = Array.isArray(wire.schemas);
		const tools = (wire.schemas || []).map((s) => s.function || s);
		// The fenced places: two record files and one unmarked file that are there, one of each
		// kind that is not.
		await mod.write_file('secret/f10.md', 'not granted f10');
		await turnEv(id, ['vault'], '@tool link_add ' + JSON.stringify(
			{ from: 'diamond:' + id, to: 'dir:vault/f10/linked', rel: 'holds' }));
		await mod.write_file('vault/f10/gone.md', 'f10 kept delete');
		await turnEv(id, ['vault'], '@tool file_delete ' + JSON.stringify({ path: 'vault/f10/gone.md' }));
		const rows = JSON.parse(await app.versions_list(id));
		const man = 'diamonds/' + id + '/versions/'
			+ String(rows.length ? rows[0].version : 1).padStart(4, '0') + '.files.json';
		const targets = ['diamonds/' + id + '/.daimond/links.jsonl', man, 'secret/f10.md',
			'diamonds/' + id + '/.daimond/f10-new.json', 'secret/f10-new.md'];
		const snap = async () => Promise.all(targets.map((t) => state(t)));
		const base = await snap();
		out.targetsThere = base.slice(0, 3).every((x) => x !== null && x.startsWith('F:'))
			&& base.slice(3).every((x) => x === null);
		// Something `capture` can photograph cheaply, and a source `typst_compile` can compile.
		const probe = document.createElement('div');
		probe.id = 'f10-probe';
		probe.textContent = 'f10';
		document.body.appendChild(probe);
		await mod.write_file('vault/f10/t.typ', '= F10\nhello\n');
		const keepFetch = window.DaimondWeb && window.DaimondWeb.fetch;
		window.DaimondWeb = window.DaimondWeb || {};
		window.DaimondWeb.fetch = async (url) => ({ url, content_type: 'text/plain',
			body_b64: btoa('f10 served'), bytes: 10 });
		let n = 0;
		for (const t of tools) {
			const props = (t.parameters && t.parameters.properties) || {};
			const isPath = (k) => PATH_NAMES.includes(k) || ((props[k].type === 'string'
				|| props[k].type === 'array') && /path/i.test(props[k].description || ''));
			const pathKeys = Object.keys(props).filter(isPath);
			for (const k of pathKeys) {
				const tag = t.name + '.' + k;
				if (READS.includes(tag) || RUNS_IN.includes(tag) || NOT_PATHS.includes(tag)) continue;
				n++;
				let fresh = 0;
				// Every other path argument names a place the turn may write: a source that is there
				// where the call reads one, a new name where the call makes one.
				const fill = async (val, old) => {
					const a = { url: 'https://example.test/f10', content: 'f10 content',
						new_string: 'f10 edited', selector: '#f10-probe' };
					for (const o of pathKeys) {
						if (o === k) continue;
						if (t.name === 'typst_compile' && o === 'path') {
							a[o] = 'vault/f10/t.typ';
						} else if (t.name === 'file_move' && o === 'to') {
							a[o] = 'vault/f10/dst_' + n + '_' + (fresh++) + '.md';
						} else {
							a[o] = 'vault/f10/src_' + n + '_' + o + '.md';
							await mod.write_file(a[o], 'f10 source');
						}
					}
					a[k] = k === 'paths' ? [val] : val;
					if (old !== undefined) a.old_string = old;
					return a;
				};
				// THE CONTROL: the same call, at a place the turn may write -- a file that is there
				// for a door that needs one, a new name for a door that makes one.
				const ctl = 'vault/f10/ctl_' + n + (t.name === 'dir_create' ? '' : '.md');
				const needs = ['file_edit', 'file_delete', 'file_revert'].includes(t.name)
					|| (t.name === 'file_move' && k === 'path');
				if (needs) await mod.write_file(ctl, 'control text');
				if (t.name === 'file_revert') {
					await turnEv(id, ['vault'], '@tool file_write ' + JSON.stringify({ path: ctl, content: 'changed' }));
				}
				const ctlBefore = await state(ctl);
				const cs = await turnEv(id, ['vault'], '@tool ' + t.name + ' ' + JSON.stringify(
					await fill(ctl, 'control text')));
				const ctlAfter = await state(ctl);
				const said = cs.filter((e) => e.name === t.name).map((e) => e.content).join(' | ');
				const wrote = ctlAfter !== ctlBefore;
				// THE FENCED PLACES, in the same argument, in one turn.
				const calls = [];
				for (const target of targets) {
					const cur = await state(target);
					const old = cur && cur.startsWith('F:') ? cur.slice(2, 26) : 'absent';
					calls.push(t.name + ' ' + JSON.stringify(await fill(target, old)));
				}
				const before = await snap();
				const ev = await turnEv(id, ['vault'], '@tools ' + calls.join(' ;; '));
				const after = await snap();
				const changed = targets.filter((x, i) => after[i] !== before[i]);
				// Put back whatever a leak changed, so the next row is measured from the same place.
				for (let i = 0; i < targets.length; i++) {
					if (after[i] !== before[i]) {
						try { await putBack(targets[i], before[i]); } catch (e) { out.putBack = String(e); }
					}
				}
				out.rows.push({ tag, control: wrote, said: said.slice(0, 90), changed,
					answers: ev.filter((e) => e.name === t.name).map((e) => e.content.slice(0, 60)) });
			}
		}
		window.DaimondWeb.fetch = keepFetch;
		probe.remove();
		return out;
	});
	check('F10. the daimon\'s schemas were read off the wire, and the fenced places are set up',
		f10.wire === true && f10.targetsThere === true, JSON.stringify({ wire: f10.wire, there: f10.targetsThere }));
	const leaks = f10.rows.filter((r) => r.changed.length);
	check('F10. no argument of any tool that names a path changes a fenced place',
		f10.rows.length > 0 && leaks.length === 0,
		leaks.length ? leaks.map((r) => r.tag + ' changed ' + r.changed.join(', ')).join('; ')
			: f10.rows.length + ' written path arguments asked: ' + f10.rows.map((r) => r.tag).join(', '));
	const written = f10.rows.filter((r) => r.control).map((r) => r.tag);
	const idle = f10.rows.filter((r) => !r.control).map((r) => r.tag + ' (' + r.said + ')');
	check('F10. and the same calls do write where the turn may (web_fetch.to, file_write, file_edit, '
		+ 'file_delete, file_move both ends, dir_create among them)',
		['web_fetch.to', 'file_write.path', 'file_edit.path', 'file_delete.path', 'file_move.path',
			'file_move.to', 'dir_create.path'].every((t) => written.includes(t)),
		'wrote: ' + written.join(', ') + (idle.length ? ' | not exercised: ' + idle.join('; ') : ''));
}

// ── F11: a write that keeps nothing of a user's file is a delete by another verb (R4) ─────
if (want('F11')) {
	const HELD = '.modal.dlg[data-ask="delete-held"]';
	const dialog = async (ms) => {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			const el = await p.$(HELD);
			if (el) return { text: (await el.textContent()) || '', count: (await p.$$(HELD)).length };
			await p.waitForTimeout(150);
		}
		return null;
	};
	// A yes waits until it can be pressed, as F8's does once a question's yes is held for its
	// first second (lane-bc3's R6): a forced click on a disabled button is no click at all.
	const answer = async (yes) => {
		if (yes) await p.waitForSelector(HELD + ' .dlg-ok:not([disabled])', { timeout: 5000 }).catch(() => {});
		await p.click(HELD + (yes ? ' .dlg-ok' : ' .dlg-cancel'), { force: true });
	};
	const setup = await p.evaluate(async () => {
		const { mod, app } = __k;
		const id = await app.create_diamond('f11 wipes');
		app.set_open_deletes_ask(3);
		for (let i = 0; i < 5; i++) await mod.write_file('vault/f11/m' + i + '.md', 'keep me ' + i + '\n');
		for (let i = 0; i < 5; i++) await mod.write_file('vault/f11/k' + i + '.md', 'keep this ' + i + '\nand this\n');
		window.__f11keep = window.DaimondWeb && window.DaimondWeb.fetch;
		window.DaimondWeb = window.DaimondWeb || {};
		window.DaimondWeb.fetch = async (url) => ({ url, content_type: 'text/plain', body_b64: btoa('x'), bytes: 1 });
		return { id, limit: app.open_deletes_ask() };
	});
	const id11 = setup.id;
	// 1. Five wipes in the open folder, by three verbs, past a limit of three: the person is asked.
	const calls = [
		'file_write ' + JSON.stringify({ path: 'vault/f11/m0.md', content: '' }),
		'file_edit ' + JSON.stringify({ path: 'vault/f11/m1.md', old_string: 'keep me 1\n', new_string: '' }),
		'web_fetch ' + JSON.stringify({ url: 'https://example.test/x', to: 'vault/f11/m2.md' }),
		'file_write ' + JSON.stringify({ path: 'vault/f11/m3.md', content: 'x' }),
		'file_write ' + JSON.stringify({ path: 'vault/f11/m4.md', content: '' }),
	];
	await p.evaluate(({ id, text }) => { window.__f11 = __k.turnEv(id, ['vault'], text); return true; },
		{ id: id11, text: '@tools ' + calls.join(' ;; ') });
	const d1 = await dialog(45000);
	if (d1) await answer(false);
	const s1 = await p.evaluate(async () => (await window.__f11).map((e) => e.content));
	const k1 = await p.evaluate(async () => {
		const out = {};
		for (let i = 0; i < 5; i++) out['m' + i] = await __k.read('vault/f11/m' + i + '.md');
		return out;
	});
	check('F11. past the limit, a turn wiping files in the open folder waits for the PERSON, as a deleting one does',
		!!d1 && /m3\.md/.test(d1.text) && /wip/i.test(d1.text), d1 ? d1.text.slice(0, 220) : 'no dialog: ' + JSON.stringify(s1.map((x) => x.slice(0, 50))));
	check('F11. whatever the verb: file_write, file_edit and web_fetch each counted, and the stop kept the rest',
		k1.m0 === '' && k1.m1 === '' && k1.m2 === 'x' && k1.m3 === 'keep me 3\n' && k1.m4 === 'keep me 4\n'
			&& s1.filter((x) => /^Refused/.test(x) && /did not let it go on/.test(x)).length === 2,
		JSON.stringify({ kept: k1, said: s1.map((x) => x.slice(0, 44)) }));
	// 2. Five edits that keep something of each file are not asked about, at the same limit.
	const edits = [0, 1, 2, 3, 4].map((i) => 'file_edit ' + JSON.stringify(
		{ path: 'vault/f11/k' + i + '.md', old_string: 'keep this ' + i, new_string: 'kept ' + i }));
	await p.evaluate(({ id, text }) => { window.__f11b = __k.turnEv(id, ['vault'], text); return true; },
		{ id: id11, text: '@tools ' + edits.join(' ;; ') });
	const d2 = await dialog(5000);
	if (d2) await answer(false);
	const s2 = await p.evaluate(async () => (await window.__f11b).map((e) => e.content));
	check('F11. edits that keep something of each file are not asked about',
		!d2 && s2.filter((x) => /^Edited /.test(x)).length === 5, JSON.stringify(s2.map((x) => x.slice(0, 40))));
	// 3 and 4. The copies: one file wiped, one wiped and then deleted, and one wiped then
	// deleted in the same turn -- then later turns' EDITS of large files, the churn that pruned
	// the re-check's copies.
	const f11 = await p.evaluate(async (id) => {
		const { mod, app, read, turn } = __k;
		app.set_open_deletes_ask(64);
		const out = {};
		await mod.write_file('vault/f11/w.md', 'precious w\nsecond line\n');
		await mod.write_file('vault/f11/t1.md', 'the t1 text\nline two\n');
		await mod.write_file('vault/f11/u.md', 'the u text\n');
		out.wipe = await turn(id, ['vault'], 'file_write', { path: 'vault/f11/w.md', content: '' });
		out.wipeT = await turn(id, ['vault'], 'file_write', { path: 'vault/f11/t1.md', content: '' });
		const rowsT = JSON.parse(await app.versions_list(id));
		const vT = rowsT.find((r) => (r.files || []).some((f) => f.path === 'vault/f11/t1.md' && !f.gone));
		out.vT = vT ? vT.version : null;
		out.wipedFlag = vT ? (vT.files || []).some((f) => f.path === 'vault/f11/t1.md' && f.wiped === true) : null;
		out.delT = await turn(id, ['vault'], 'file_delete', { path: 'vault/f11/t1.md' });
		out.same = await turn(id, ['vault'], 'file_write', { path: 'vault/f11/u.md', content: '' });
		// One turn: wipe, then delete. (The line above is its own turn; this is the pair.)
		await mod.write_file('vault/f11/u2.md', 'the u2 text\n');
		const pair = await __k.turnEv(id, ['vault'], '@tools '
			+ 'file_write ' + JSON.stringify({ path: 'vault/f11/u2.md', content: '' }) + ' ;; '
			+ 'file_delete ' + JSON.stringify({ path: 'vault/f11/u2.md' }));
		out.pair = pair.map((e) => e.content.slice(0, 40));
		// A generated output over a user's file is kept as any other write's is (capture here;
		// the Typst compiler does not load in this page), and one over its own kind of output is
		// simply made again.
		const probe = document.createElement('div');
		probe.id = 'f11-probe';
		probe.textContent = 'f11';
		document.body.appendChild(probe);
		await mod.write_file('vault/f11/pic.md', 'my notes\nabout the picture\n');
		out.cap = await turn(id, ['vault'], 'capture', { selector: '#f11-probe', path: 'vault/f11/pic.md' });
		out.capA = await turn(id, ['vault'], 'capture', { selector: '#f11-probe', path: 'vault/f11/shot.png' });
		probe.textContent = 'f11 again';
		out.capB = await turn(id, ['vault'], 'capture', { selector: '#f11-probe', path: 'vault/f11/shot.png' });
		// WHOSE A PICTURE IS, by provenance and never by kind: the tool's own is the very bytes it
		// last wrote there. A PNG of the user's, or the tool's own changed since by the user, is
		// theirs -- the exemption was once "a PNG over a PNG", and kept neither.
		const rowOf = async (p) => {
			const rows = JSON.parse(await app.versions_list(id));
			for (const r of rows) {
				const f = (r.files || []).find((x) => x.path === p);
				if (f) return { v: r.version, wiped: f.wiped === true };
			}
			return null;
		};
		out.capBRow = await rowOf('vault/f11/shot.png');
		const png = (tag) => {
			const b = new Uint8Array(96);
			b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			for (let i = 8; i < b.length; i++) b[i] = (i * 31 + tag) & 255;
			return b;
		};
		out.userPng = Array.from(png(1));
		await app.write_bytes('vault/f11/photo.png', png(1));
		out.capP = await turn(id, ['vault'], 'capture', { selector: '#f11-probe', path: 'vault/f11/photo.png' });
		out.capC = await turn(id, ['vault'], 'capture', { selector: '#f11-probe', path: 'vault/f11/shot2.png' });
		out.userPng2 = Array.from(png(2));
		await app.write_bytes('vault/f11/shot2.png', png(2));
		out.capD = await turn(id, ['vault'], 'capture', { selector: '#f11-probe', path: 'vault/f11/shot2.png' });
		probe.remove();
		// The same door for a compile, where this tree has the Typst compiler to run it.
		await mod.write_file('vault/f11/doc.typ', '= F11\nA page the compiler makes.\n');
		out.userPdf = Array.from(new TextEncoder().encode('%PDF-1.4\nthe signed contract\n%%EOF\n'));
		await app.write_bytes('vault/f11/contract.pdf', new Uint8Array(out.userPdf));
		out.tc = await turn(id, ['vault'], 'typst_compile', { path: 'vault/f11/doc.typ', out: 'vault/f11/contract.pdf' });
		out.typst = /^Compiled /.test(out.tc);
		if (out.typst) {
			out.tcA = await turn(id, ['vault'], 'typst_compile', { path: 'vault/f11/doc.typ', out: 'vault/f11/book.pdf' });
			await mod.write_file('vault/f11/doc.typ', '= F11\nThe same book, revised.\n');
			out.tcB = await turn(id, ['vault'], 'typst_compile', { path: 'vault/f11/doc.typ', out: 'vault/f11/book.pdf' });
			out.tcBRow = await rowOf('vault/f11/book.pdf');
		}
		const lines = (c, kb) => {
			let t = '';
			for (let i = 0; t.length < kb * 1024; i++) t += c + ':' + i + ':' + Math.random() + '\n';
			return t;
		};
		for (const n of ['c1', 'c2', 'c3', 'c4']) {
			const was = lines(n, 300);
			await mod.write_file('vault/f11/big/' + n + '.txt', was);
			out[n] = (await turn(id, ['vault'], 'file_write', { path: 'vault/f11/big/' + n + '.txt',
				content: n + ': edited\n' + was.slice(was.indexOf('\n') + 1) })).slice(0, 60);
		}
		out.revW = await turn(id, ['vault'], 'file_revert', { path: 'vault/f11/w.md' });
		out.backW = await read('vault/f11/w.md');
		out.revT = out.vT ? await turn(id, ['vault'], 'file_revert',
			{ path: 'vault/f11/t1.md', version: out.vT - 1 }) : 'no version';
		out.backT = await read('vault/f11/t1.md');
		out.revU2 = await turn(id, ['vault'], 'file_revert', { path: 'vault/f11/u2.md' });
		out.backU2 = await read('vault/f11/u2.md');
		out.revPic = await turn(id, ['vault'], 'file_revert', { path: 'vault/f11/pic.md' });
		out.backPic = await read('vault/f11/pic.md');
		const bytesAt = async (p) => { try { return Array.from(await mod.read_bytes(p, 0, 1 << 20)); } catch (e) { return null; } };
		out.revPhoto = await turn(id, ['vault'], 'file_revert', { path: 'vault/f11/photo.png' });
		out.backPhoto = await bytesAt('vault/f11/photo.png');
		out.revShot2 = await turn(id, ['vault'], 'file_revert', { path: 'vault/f11/shot2.png' });
		out.backShot2 = await bytesAt('vault/f11/shot2.png');
		if (out.typst) {
			out.revPdf = await turn(id, ['vault'], 'file_revert', { path: 'vault/f11/contract.pdf' });
			out.backPdf = await bytesAt('vault/f11/contract.pdf');
		}
		app.set_open_deletes_ask(-1);
		window.DaimondWeb.fetch = window.__f11keep;
		return out;
	}, id11);
	check('F11. the churn was edits, and they were written', /^Wrote /.test(f11.c4 || ''), String(f11.c4));
	check("F11. an emptied file's copy outlives later turns' edits",
		f11.backW === 'precious w\nsecond line\n', String(f11.revW).slice(0, 200));
	check('F11. the store says the file was wiped', f11.wipedFlag === true, JSON.stringify({ v: f11.vT, wiped: f11.wipedFlag }));
	check('F11. a file emptied in one turn and deleted in the next goes back as it was before it was emptied',
		/^Deleted /.test(f11.delT) && f11.backT === 'the t1 text\nline two\n', String(f11.revT).slice(0, 200));
	check('F11. and in one turn, the copy kept is the one from before the first wipe',
		f11.backU2 === 'the u2 text\n', JSON.stringify({ pair: f11.pair, rev: String(f11.revU2).slice(0, 120) }));
	check("F11. a picture taken over a user's file keeps what it replaced, through the same churn",
		/^Photographed /.test(f11.cap) && f11.backPic === 'my notes\nabout the picture\n',
		JSON.stringify({ cap: String(f11.cap).slice(0, 60), rev: String(f11.revPic).slice(0, 120) }));
	check('F11. and one taken over its own last picture is simply taken again, with nothing held as a wipe',
		/^Photographed /.test(f11.capA) && /^Photographed /.test(f11.capB)
			&& !(f11.capBRow && f11.capBRow.wiped),
		JSON.stringify([String(f11.capA).slice(0, 50), String(f11.capB).slice(0, 50), f11.capBRow]));
	const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
		&& a.every((x, i) => x === b[i]);
	check("F11. a picture taken over the user's own PNG keeps it: a PNG is not the tool's for being a PNG",
		/^Photographed /.test(f11.capP) && same(f11.backPhoto, f11.userPng),
		JSON.stringify({ cap: String(f11.capP).slice(0, 50), rev: String(f11.revPhoto).slice(0, 120),
			back: f11.backPhoto ? f11.backPhoto.length + ' bytes' : null }));
	check("F11. and so is the tool's own picture once the user has written over it",
		/^Photographed /.test(f11.capC) && /^Photographed /.test(f11.capD) && same(f11.backShot2, f11.userPng2),
		JSON.stringify({ cap: String(f11.capD).slice(0, 50), rev: String(f11.revShot2).slice(0, 120),
			back: f11.backShot2 ? f11.backShot2.length + ' bytes' : null }));
	if (f11.typst) {
		check("F11. a compile over the user's own PDF keeps it: a PDF is not the compiler's for being a PDF",
			same(f11.backPdf, f11.userPdf),
			JSON.stringify({ tc: String(f11.tc).slice(0, 60), rev: String(f11.revPdf).slice(0, 120),
				back: f11.backPdf ? f11.backPdf.length + ' bytes' : null }));
		check('F11. and a compile over its own last PDF is made again, with nothing held as a wipe',
			/^Compiled /.test(f11.tcA) && /^Compiled /.test(f11.tcB) && !(f11.tcBRow && f11.tcBRow.wiped),
			JSON.stringify([String(f11.tcA).slice(0, 50), String(f11.tcB).slice(0, 50), f11.tcBRow]));
	} else {
		console.log('  skip F11. the compile door: this tree has no Typst compiler to run it -- ' + String(f11.tc).slice(0, 120));
	}

	// 5. R4, EMPTYING MOST (2026-09-23): a write that leaves less than half of a user's file, as
	// the turns found it, is a wipe. At a limit of none every wipe in the open folder is asked
	// about, so each row below says whether the PERSON was asked. A trim to one line, and the
	// third of three trims that each leave most of what they replaced, are asked about and held;
	// an ordinary edit and a same-size rewrite that keeps the text are not. Then later turns'
	// edits churn the store, and each trimmed file goes back to the file as the turns found it.
	const NOTES = [
		'Monday: the boiler engineer comes at nine.', 'Tuesday: send the Harbour Street invoice.',
		'Wednesday: dentist at half past three, Ada.', 'Thursday: pick up the framed map from Ada.',
		'Friday: book the train to Edinburgh early.', 'Saturday: plant the garlic along a fence.',
		'Sunday: call Mum about the October visit.', 'Rent: the standing order moves to the 3rd.',
		'Car: its MOT is due before the month ends.', 'Bins: recycling goes out on alternate days.',
		'Library: return the Pevsner guide by 30th.', 'Garden: order two bags of bark for a bed.',
	];
	const notes = (n) => NOTES.slice(0, n).map((l) => l + '\n').join('');
	const PARA = 'The survey found that most of the older houses on the east side of the village still '
		+ 'had their original sash windows, although many had been painted shut decades ago and would '
		+ 'need careful work before they opened again.\n';
	const KILN = 'The kiln was fired on Friday.\nIt held two hundred pots.\nMost came out whole.\n'
		+ 'The glaze on the blue ones ran.\nWe will fire again in May.\n';
	const most = await p.evaluate(async ({ all, para, kiln }) => {
		const { mod, app } = __k;
		const id = await app.create_diamond('f11 emptying most');
		app.set_open_deletes_ask(0);
		await mod.write_file('vault/f11/most/one.md', all);
		await mod.write_file('vault/f11/most/three.md', all);
		await mod.write_file('vault/f11/most/para.md', para);
		await mod.write_file('vault/f11/most/kiln.md', kiln);
		return id;
	}, { all: notes(12), para: PARA, kiln: KILN });
	// One turn, and whether the person was asked while it ran: a question is answered "go on", so
	// the write lands either way and the rows after it can be read.
	const asked = async (text, id = most) => {
		await p.evaluate(({ id, text }) => {
			window.__r4done = false;
			window.__r4 = __k.turnEv(id, ['vault'], text).then((r) => { window.__r4done = true; return r; });
			return true;
		}, { id, text });
		let q = null;
		const until = Date.now() + 60000;
		while (Date.now() < until) {
			const el = await p.$(HELD);
			if (el) {
				q = (await el.textContent()) || '';
				await answer(true);
				break;
			}
			if (await p.evaluate(() => window.__r4done)) break;
			await p.waitForTimeout(150);
		}
		const said = await p.evaluate(async () => (await window.__r4).map((e) => e.content.slice(0, 60)));
		return { q, said };
	};
	const write = (path, content) => '@tool file_write ' + JSON.stringify({ path, content });
	const r4 = {};
	r4.one = await asked(write('vault/f11/most/one.md', notes(1)));
	r4.t1 = await asked(write('vault/f11/most/three.md', notes(9)));
	r4.t2 = await asked(write('vault/f11/most/three.md', notes(7)));
	r4.t3 = await asked(write('vault/f11/most/three.md', notes(4)));
	r4.para = await asked('@tool file_edit ' + JSON.stringify({ path: 'vault/f11/most/para.md',
		old_string: 'careful', new_string: 'patient' }));
	r4.kiln = await asked(write('vault/f11/most/kiln.md', KILN.trim().split('\n').join(' ') + '\n'));
	const back = await p.evaluate(async ({ id, all }) => {
		const { mod, app, read, turn } = __k;
		const out = {};
		const rowOf = async (path) => {
			const rows = JSON.parse(await app.versions_list(id));
			for (const r of rows) {
				const f = (r.files || []).find((x) => x.path === path);
				if (f) return { v: r.version, wiped: f.wiped === true };
			}
			return null;
		};
		for (const n of ['one', 'three', 'para', 'kiln']) out[n + 'Row'] = await rowOf('vault/f11/most/' + n + '.md');
		out.paraNow = await read('vault/f11/most/para.md');
		out.kilnNow = await read('vault/f11/most/kiln.md');
		// Later turns' edits of large files of the user's: the churn that prunes an ordinary copy.
		const lines = (c, kb) => {
			let t = '';
			for (let i = 0; t.length < kb * 1024; i++) t += c + ':' + i + ':' + Math.random() + '\n';
			return t;
		};
		for (const n of ['d1', 'd2', 'd3', 'd4']) {
			const was = lines(n, 300);
			await mod.write_file('vault/f11/most/big/' + n + '.txt', was);
			out[n] = (await turn(id, ['vault'], 'file_write', { path: 'vault/f11/most/big/' + n + '.txt',
				content: n + ': edited\n' + was.slice(was.indexOf('\n') + 1) })).slice(0, 60);
		}
		out.revOne = await turn(id, ['vault'], 'file_revert', { path: 'vault/f11/most/one.md' });
		out.backOne = await read('vault/f11/most/one.md');
		out.revThree = await turn(id, ['vault'], 'file_revert', { path: 'vault/f11/most/three.md' });
		out.backThree = await read('vault/f11/most/three.md');
		app.set_open_deletes_ask(-1);
		return out;
	}, { id: most, all: notes(12) });
	const at = (x) => x.q === null ? 'not asked' : 'asked: ' + x.q.slice(0, 90);
	check("F11. R4: a user's file cut to its first line is asked about, as a delete is",
		r4.one.q !== null && /one\.md/.test(r4.one.q), at(r4.one) + ' | ' + JSON.stringify(r4.one.said));
	check('F11. R4: of three trims that each leave most of what they replaced, the third -- which takes the file below half -- is asked about, and only it',
		r4.t1.q === null && r4.t2.q === null && r4.t3.q !== null && /three\.md/.test(r4.t3.q),
		[at(r4.t1), at(r4.t2), at(r4.t3)].join(' / '));
	check('F11. R4: an ordinary edit -- one word of a paragraph written as one line -- is not asked about',
		r4.para.q === null && back.paraNow === PARA.replace('careful', 'patient'), at(r4.para) + ' | ' + JSON.stringify(r4.para.said));
	check('F11. R4: a same-size rewrite that keeps the text -- its sentences made one paragraph -- is not asked about',
		r4.kiln.q === null && back.kilnNow !== KILN && back.kilnNow.length === KILN.length, at(r4.kiln) + ' | ' + JSON.stringify(r4.kiln.said));
	check('F11. R4: the store holds the trim to one line and the third trim as wipes, and neither the edit nor the rewrite',
		!!(back.oneRow && back.oneRow.wiped && back.threeRow && back.threeRow.wiped
			&& back.paraRow && !back.paraRow.wiped && back.kilnRow && !back.kilnRow.wiped),
		JSON.stringify({ one: back.oneRow, three: back.threeRow, para: back.paraRow, kiln: back.kilnRow }));
	check("F11. R4: after later turns' edits, the file cut to one line goes back whole",
		/^Wrote /.test(back.d4 || '') && back.backOne === notes(12), String(back.revOne).slice(0, 160));
	check('F11. R4: and the file cut three times goes back to the file as the turns found it, not to the last trim before the third',
		back.backThree === notes(12), String(back.revThree).slice(0, 160) + ' | now ' + String(back.backThree).split('\n').length + ' lines');

	// 6. R4's follow-ons (2026-09-23): a destruction by either verb keeps the file as the turns
	// found it. (a) Two trims that each leave over half, and then a delete: the delete's copy is
	// the whole file, not the trimmed one. (b) A worker edits a file and then wipes it in one
	// turn, and the page dies before the daimon's turn ends: the note the next turn end adopts is
	// the wipe's copy, not what the edit found, so the file still goes back whole.
	const lines = (t) => String(t).split('\n').length - 1;
	const found = await p.evaluate(async ({ all }) => {
		const { mod, app } = __k;
		const id = await app.create_diamond('f11 as the turns found it');
		app.set_open_deletes_ask(0);
		await mod.write_file('vault/f11/found/del.md', all);
		await mod.write_file('vault/f11/found/crash.md', all);
		return id;
	}, { all: notes(12) });
	const fa = {};
	fa.t1 = await asked(write('vault/f11/found/del.md', notes(9)), found);
	fa.t2 = await asked(write('vault/f11/found/del.md', notes(7)), found);
	fa.del = await asked('@tool file_delete ' + JSON.stringify({ path: 'vault/f11/found/del.md' }), found);
	const fa2 = await p.evaluate(async (id) => {
		const { read, turn } = __k;
		const gone = (await read('vault/f11/found/del.md')) === null;
		const rev = await turn(id, ['vault'], 'file_revert', { path: 'vault/f11/found/del.md' });
		return { gone, rev, back: await read('vault/f11/found/del.md') };
	}, found);
	check("F11. R4's follow-on: two trims that each leave over half are not asked about, and the delete after them is",
		fa.t1.q === null && fa.t2.q === null && fa.del.q !== null && fa2.gone,
		[at(fa.t1), at(fa.t2), at(fa.del)].join(' / '));
	check("F11. R4's follow-on: and the delete keeps the file as the turns found it, so it goes back whole, not trimmed",
		fa2.back === notes(12), String(fa2.rev).slice(0, 160) + ' | now ' + lines(fa2.back) + ' lines');
	// (b) The trims are the daimon's own turns; the edit and the wipe are one worker's turn, whose
	// changes wait for the daimon's turn end -- which the page does not live to see.
	const fb = {};
	fb.t1 = await asked(write('vault/f11/found/crash.md', notes(9)), found);
	fb.t2 = await asked(write('vault/f11/found/crash.md', notes(7)), found);
	const edit = '@tools ' + [
		'file_edit ' + JSON.stringify({ path: 'vault/f11/found/crash.md', old_string: 'at nine', new_string: 'at ten' }),
		'file_write ' + JSON.stringify({ path: 'vault/f11/found/crash.md', content: notes(1) }),
	].join(' ;; ');
	await p.evaluate(({ id, text }) => {
		window.__wdone = false;
		window.__w = __k.worker(id, ['vault'], text).then((r) => { window.__wdone = true; return r; });
		return true;
	}, { id: found, text: edit });
	let wq = null;
	for (let i = 0; i < 400 && !(await p.evaluate(() => window.__wdone)); i++) {
		const el = await p.$(HELD);
		if (el) { wq = (await el.textContent()) || ''; await answer(true); }
		await p.waitForTimeout(150);
	}
	const wsaid = await p.evaluate(async () => (await window.__w).map((x) => String(x).slice(0, 60)));
	const crashNow = await p.evaluate(async () => __k.read('vault/f11/found/crash.md'));
	// The page dies before any turn of the daimon's ends: the worker's captures were in memory.
	await p.reload();
	await p.waitForTimeout(1500);
	await install(false);
	const fb2 = await p.evaluate(async (id) => {
		const { read, turn } = __k;
		await turn(id, ['vault'], 'file_list', { path: 'vault/f11/found' });
		const rev = await turn(id, ['vault'], 'file_revert', { path: 'vault/f11/found/crash.md' });
		return { rev, back: await read('vault/f11/found/crash.md') };
	}, found);
	check("F11. R4's follow-on: a worker's edit and then wipe in one turn -- the edit not asked about, the wipe asked, both landed",
		fb.t1.q === null && fb.t2.q === null && wq !== null && crashNow === notes(1),
		JSON.stringify({ asked: wq ? wq.slice(0, 80) : null, said: wsaid, now: lines(crashNow) + ' lines' }));
	check("F11. R4's follow-on: and with the page dead before the turn ended, the file still goes back whole, not to what the edit found",
		fb2.back === notes(12), String(fb2.rev).slice(0, 160) + ' | now ' + lines(fb2.back) + ' lines');
}

await p.evaluate(async (folder) => {
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* tidy */ }
}, FOLDER);
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR|Failed to load resource/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
