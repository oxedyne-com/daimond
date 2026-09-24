// verify_filedelete.mjs — `file_delete` removes one file, on a folder-mounted Diamond as in the sandbox.
//
// 2026-09-22 13:38Z: a daimon on a folder-mounted Diamond (qwen3-coder), its eight `file_move`s
// refused, called `file_delete` four times with `recursive`, and Syncthing carried ~4,900 deletions
// out of the owner's tree in fifteen seconds. The tool took `recursive` and handed it to
// `removeEntry(name, {recursive:true})` on the FSA folder handle -- the user's own disk.
//
// What must be true, and what this drives through the real wasm:
//   A. With a folder open, a folder is REFUSED as a result the model reads -- recursive or not,
//      empty or not, through the app's registry AND through a Diamond's daimon (the incident's
//      route) -- and nothing under it is removed.
//   B. An escape ('..', absolute, the root itself) is refused.
//   C. One file is still deleted, and the internal single-file callers keep working.
//   D. `file_move` cannot take a folder off the disk into Daimond's store, nor into itself; a
//      folder moved within the folder arrives whole and the source goes only after.
//   E. The user's confirmed folder delete has its own door, `delete_folder`, which a file cannot use.
//   F. The same refusal holds in the OPFS sandbox with no folder open.
//   G. A daimon's one-file delete is a VERSION: through a real turn (the mock's `@tool`), the
//      bytes are kept, `file_revert` puts the file back, and History's restore does too -- on
//      the folder mount and in the sandbox. A file too large to keep is refused, not deleted.
//      The audit of 2026-09-23 (its probe is folded in here): a path spelled `./x`, `a//x`,
//      `a/z/../x` or `x/` is kept exactly as `x` is; the daimon cannot delete or write its own
//      version store; and a file only in cloud storage is refused rather than forgotten.
//   D and E, from the same audit: a folder holding `a:b` and `a%3Ab` moves with both, under
//      their own names; and the user's folder delete takes the cloud-only files under it too.
//   H. The open paths the forensics left (§8.2), each through real turns:
//      2. past TURN_FILES_MAX (64) deletes in one turn the next is refused and the model is sent
//         to the user;
//      3. a CHAT's delete and a Diamond WORKER's delete are kept too -- the chat's in its own
//         store (`chat:<id>`), put back by its own file_revert and by the page's undo through
//         the chat's marks; the worker's in its Diamond's, recorded at the daimon's turn end;
//      6. a mark's own path is never deleted, nor a marked folder moved;
//      9. the engine classes a destructive call's path for the lens (depth, file or folder, open
//         folder, refused) and never names it, and the page's `tool` row -- the chat's and the
//         daimon's, one function -- carries `ab` and that class and no path.
//      5. the `file_delete` description the page sends the provider (read off the request)
//         says an open folder is the user's disk and never names `run`.
//      (4 and 7 are the page's marks: dev/verify_droots.mjs.)
//
// G needs a world for the mock provider (`eval "$(bash dev/world.sh N --env)"`).
//
// As in verify_fsa.mjs, an OPFS subdirectory stands in for the picked folder: it is the same
// handle type the picker returns. What only a real disk could show -- a symlink inside the picked
// folder -- is covered natively by `test_delete_and_move_refuse_a_symlink_escape` in src/tools.rs.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FOLDER = 'fdfolder';
const MOCK   = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';

const s = await open({ name: 'filedelete', connect: false });
const p = s.page;
await p.waitForTimeout(1500);
// H5. What the model is actually told `file_delete` does: the description in the request the
// page sends the provider, read off the wire rather than off the Rust source.
const sentDesc = [];
p.on('request', (req) => {
	if (req.method() !== 'POST' || !req.url().startsWith(MOCK)) return;
	try {
		const tools = JSON.parse(req.postData() || '{}').tools || [];
		const t = tools.find((x) => x.function && x.function.name === 'file_delete');
		if (t) sentDesc.push(String(t.function.description || ''));
	} catch (e) { /* not a chat request */ }
});

const r = await p.evaluate(async ({ folder, mock }) => {
	const mod  = await import('../pkg/oxedyne_daimond.js');
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* first run */ }
	const dir  = await root.getDirectoryHandle(folder, { create: true });
	mod.set_workspace_dir(dir);
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const call = async (tool, args) => {
		const o = await app.run_tool_outcome(tool, JSON.stringify(args));
		return { outcome: o.outcome, text: String(o.text).slice(0, 800) };
	};
	// Asked of the handles directly, never of the tool under test.
	const at = async (path, kind) => {
		const parts = path.split('/');
		let d = dir;
		try {
			for (let i = 0; i < parts.length - 1; i++) d = await d.getDirectoryHandle(parts[i]);
			const leaf = parts[parts.length - 1];
			if (kind === 'dir') await d.getDirectoryHandle(leaf); else await d.getFileHandle(leaf);
			return true;
		} catch (e) { return false; }
	};
	const seed = async () => {
		for (const [path, content] of [['proj/a.txt', 'a'], ['proj/sub/b.txt', 'b'],
			['proj/sub/deep/c.txt', 'c'], ['keep.txt', 'k'], ['gone.txt', 'g']]) {
			await mod.write_file(path, content);
		}
		await app.run_tool('dir_create', JSON.stringify({ path: 'empty' }));
	};
	await seed();
	const out = { mode: mod.workspace_mode() };

	// A. Folders, through the app's own registry.
	out.dirRec   = await call('file_delete', { path: 'proj', recursive: 'true' });
	out.dirPlain = await call('file_delete', { path: 'proj' });
	out.subRec   = await call('file_delete', { path: 'proj/sub/', recursive: true });
	out.empty    = await call('file_delete', { path: 'empty' });
	out.survived = await at('proj/a.txt') && await at('proj/sub/b.txt')
		&& await at('proj/sub/deep/c.txt') && await at('empty', 'dir');

	// A, again, through a Diamond's daimon with `proj` marked in: the incident's own route.
	const id = await app.create_diamond('delete guard');
	const dia = async (tool, args) => {
		const o = await app.run_diamond_tool(id, JSON.stringify(['proj', 'keep.txt']), '[]',
			tool, JSON.stringify(args));
		return { outcome: o.outcome, text: String(o.text).slice(0, 800) };
	};
	out.diaDir   = await dia('file_delete', { path: 'proj', recursive: 'true' });
	out.diaSub   = await dia('file_delete', { path: 'proj/sub', recursive: 'true' });
	out.diaSurv  = await at('proj/sub/deep/c.txt');

	// B. Escapes.
	out.up    = await call('file_delete', { path: '../keep.txt' });
	out.up2   = await call('file_delete', { path: 'proj/../../keep.txt' });
	out.abs   = await call('file_delete', { path: '/keep.txt' });
	out.dot   = await call('file_delete', { path: '.' });
	out.keptAfterEscapes = await at('keep.txt');

	// C. One file still goes, through both doors.
	out.file    = await call('file_delete', { path: 'gone.txt' });
	out.fileGone = !(await at('gone.txt'));
	out.diaFile = await dia('file_delete', { path: 'proj/a.txt' });
	out.diaFileGone = !(await at('proj/a.txt'));

	// D. Moves.
	out.toStore  = await call('file_move', { path: 'proj', to: 'diamonds/' + id + '/proj' });
	out.intoSelf = await call('file_move', { path: 'proj', to: 'proj/inner' });
	out.afterRefusedMoves = await at('proj/sub/deep/c.txt');
	out.within   = await call('file_move', { path: 'proj', to: 'moved' });
	out.movedWhole = await at('moved/sub/b.txt') && await at('moved/sub/deep/c.txt');
	out.srcGone  = !(await at('proj', 'dir'));

	// E. The user's own door.
	let fileRefused = false;
	try { await mod.delete_folder('keep.txt'); } catch (e) { fileRefused = true; }
	out.userFileRefused = fileRefused && await at('keep.txt');
	let userErr = '';
	try { await mod.delete_folder('moved'); } catch (e) { userErr = String(e); }
	out.userDir = { err: userErr, gone: !(await at('moved', 'dir')) };

	// D, the name codec: two stored names that decode to one, and a name the codec escapes.
	// Read back off the handles by the names the browser stores, never through the tool.
	const stored = async (h) => {
		const o = {};
		for await (const [n, fh] of h.entries()) {
			o[n] = fh.kind === 'file' ? await (await fh.getFile()).text() : 'DIR';
		}
		return o;
	};
	const col = await dir.getDirectoryHandle('col', { create: true });
	for (const [n, t] of [['a:b', 'COLON'], ['a%3Ab', 'PERCENT'], ['z.txt', 'Z']]) {
		const fh = await col.getFileHandle(n, { create: true });
		const w = await fh.createWritable(); await w.write(t); await w.close();
	}
	out.colMove = await call('file_move', { path: 'col', to: 'col2' });
	try { out.colDst = await stored(await dir.getDirectoryHandle('col2')); }
	catch (e) { out.colDst = null; }
	out.colSrcGone = !(await at('col', 'dir'));

	// E, cloud-only files under a folder the user deletes. Seeded straight into the index as a
	// manifest this device has no bytes for, which is what a cloud-only file is.
	out.cloud = !!window.DaimondCloud;
	if (out.cloud) {
		await mod.write_file('cf/here.txt', 'h');
		await DaimondCloud.put('cf/away.md', { size: 3, chunks: [] }, 'h1',
			{ file: { size: 3 }, timeless: true });
		try { await mod.delete_folder('cf'); } catch (e) { /* the check below says */ }
		out.cfForgotten = !DaimondCloud.index()['cf/away.md'];
	}

	// G. A daimon's delete, through a real turn, and the two ways back.
	const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
		new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
	const read = async (path) => { try { return await mod.read_file(path); } catch (e) { return null; } };
	// A turn, as the daimon has one: the mock answers `@tool` with that call.
	const turn = async (marks, tool, args) => {
		const eng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
		const seen = [];
		try {
			await eng.steer_crystal(id, '@tool ' + tool + ' ' + JSON.stringify(args),
				JSON.stringify(marks), '[]', '[]', [],
				(ev) => { if (ev.type === 'tool_result') seen.push(String(ev.content || '')); });
		} catch (e) { seen.push('THREW: ' + String(e && e.message || e)); }
		return seen.join(' | ').slice(0, 400);
	};
	const newest = async () => {
		const rows = JSON.parse(await app.versions_list(id));
		return rows.length ? rows[0] : null;
	};
	// Both ways back, for one file on one root. `history` is the engine's half of the History
	// panel's Restore and then the fenced write-back `writeMachine` does for a marked path.
	const wayBack = async (dir, name, text) => {
		const path = dir + '/' + name;
		const o = {};
		await mod.write_file(path, text);
		await mod.write_file(dir + '/other.txt', 'stays');
		o.del      = await turn([dir], 'file_delete', { path });
		o.gone     = (await read(path)) === null;
		const m    = await newest();
		const e    = m && (m.files || []).find((f) => f.path === path);
		o.row      = e ? { gone: !!e.gone, was: e.was === await sha(text) } : null;
		// History first, straight off the delete's own row: the state before it is the row's
		// `was`, which a path outside the Diamond's directory carries as a mark, so it comes
		// back through the fenced write-back rather than the engine's own write.
		let why = '';
		try {
			const res = JSON.parse(await app.versions_restore(id, Number(m.version) - 1, path));
			const hit = (res.machine || []).find((x) => x.path === path && x.hash);
			if (hit) {
				const body = await app.versions_body(id, hit.hash);
				const w = await app.run_diamond_tool(id, JSON.stringify([dir]), '[]',
					'file_write', JSON.stringify({ path, content: body }));
				why = 'fenced write-back, ' + w.outcome + ': ' + String(w.text).slice(0, 100);
			} else if ((res.restored || []).includes(path)) {
				why = 'the engine wrote it back itself';
			} else {
				why = 'nothing to restore: ' + JSON.stringify(res).slice(0, 200);
			}
		} catch (err) { why = 'threw: ' + String(err && err.message || err); }
		o.history  = { restored: (await read(path)) === text, why };
		// And again with `file_revert`, which a daimon reaches for.
		o.del2     = await turn([dir], 'file_delete', { path });
		o.revert   = await turn([dir], 'file_revert', { path });
		o.reverted = /Deleted /.test(o.del2) && (await read(path)) === text;
		o.otherKept = (await read(dir + '/other.txt')) === 'stays';
		return o;
	};
	out.gFolder = await wayBack('vault', 'note.md', 'the only copy, on the disk');
	// Past what a version keeps: refused, and still there.
	const big = 'x'.repeat(600 * 1024);
	await mod.write_file('vault/big.txt', big);
	out.gBig      = await turn(['vault'], 'file_delete', { path: 'vault/big.txt' });
	out.gBigKept  = (await read('vault/big.txt')) !== null;

	// Every spelling of one path is that path, kept and put back.
	out.gSpell = [];
	for (const [name, spell] of [['p1.md', './vault/p1.md'], ['p2.md', 'vault//p2.md'],
		['p3.md', 'vault/zz/../p3.md'], ['p4.md', 'vault/p4.md/']]) {
		const path = 'vault/' + name, text = 'only copy ' + name;
		await mod.write_file(path, text);
		const del = await turn(['vault'], 'file_delete', { path: spell });
		const gone = (await read(path)) === null;
		const m = await newest();
		const e = m && (m.files || []).find((f) => f.path === path);
		const kept = !!e && !!e.gone && e.was === await sha(text);
		const rev = await turn(['vault'], 'file_revert', { path });
		out.gSpell.push({ spell, del: del.slice(0, 120), gone, kept, rev: rev.slice(0, 120),
			back: (await read(path)) === text });
	}

	// The daimon cannot reach its own undo record, with any write verb.
	await mod.write_file('vault/v.md', 'versioned only copy');
	await turn(['vault'], 'file_delete', { path: 'vault/v.md' });
	const mv = await newest();
	const ev = mv && (mv.files || []).find((f) => f.path === 'vault/v.md');
	out.gStore = { row: !!(ev && ev.was) };
	if (ev && ev.was) {
		const vdir = 'diamonds/' + id + '/versions/';
		const man  = vdir + String(mv.version).padStart(4, '0') + '.files.json';
		out.gStore.body  = await turn(['vault'], 'file_delete', { path: vdir + 'b/' + ev.was });
		out.gStore.man   = await turn(['vault'], 'file_delete', { path: man });
		out.gStore.write = await turn(['vault'], 'file_write', { path: man, content: '{}' });
		out.gStore.rev   = await turn(['vault'], 'file_revert', { path: 'vault/v.md' });
		out.gStore.back  = (await read('vault/v.md')) === 'versioned only copy';
	}

	// ── H ──────────────────────────────────────────────────────────────
	// A turn, with every tool result's text and the engine's path class for the lens.
	const turnEv = async (marks, text) => {
		const eng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
		const seen = [];
		try {
			await eng.steer_crystal(id, text, JSON.stringify(marks), '[]', '[]', [],
				(ev) => {
					if (ev.type === 'tool_result') seen.push({ name: String(ev.name || ''),
						content: String(ev.content || ''), outcome: String(ev.outcome || ''),
						class: ev.class === undefined ? null : String(ev.class) });
				});
		} catch (e) { seen.push({ name: '', content: 'THREW: ' + String(e && e.message || e) }); }
		return seen;
	};

	// 2. The per-turn bound: one more delete than a version keeps, in one turn.
	//
	// THE STORE'S bound, so the person's is moved out of its way: since 2026-09-23 a turn's
	// deletes from the open folder stop after eight until the PERSON lets it go on (that is
	// dev/verify_deletekeep.mjs F8), and set to the store's own figure the question is never
	// asked, which leaves this measuring what it always measured. A build with no such
	// setting has no such question, and is measured as it is.
	const CAP = 64;                 // diamond_versions::TURN_FILES_MAX
	const openAsk = (n) => { try { if (typeof app.set_open_deletes_ask === 'function') app.set_open_deletes_ask(n); } catch (e) { /* older build */ } };
	openAsk(CAP);
	const capCalls = [];
	for (let i = 0; i <= CAP; i++) {
		await mod.write_file('vault/cap/f' + i + '.txt', 'cap ' + i);
		capCalls.push('file_delete ' + JSON.stringify({ path: 'vault/cap/f' + i + '.txt' }));
	}
	const capRes = await turnEv(['vault'], '@tools ' + capCalls.join(' ;; '));
	openAsk(-1);
	const dels = capRes.filter((e) => e.name === 'file_delete');
	out.hCap = {
		calls:   dels.length,
		done:    dels.filter((e) => /^Deleted /.test(e.content)).length,
		last:    dels.length ? dels[dels.length - 1].content.slice(0, 240) : '',
		lastKept: (await read('vault/cap/f' + CAP + '.txt')) === 'cap ' + CAP,
	};
	const mc = await newest();
	out.hCap.rows = mc ? (mc.files || []).filter((f) => /^vault\/cap\//.test(f.path) && f.gone).length : 0;

	// 3. A chat's delete, kept in the chat's own store.
	const CHAT = 'cfd1';
	const chatEng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
	chatEng.set_chat_scope('chats/' + CHAT + '/work', JSON.stringify(['vault']));
	const chatTurn = async (text) => {
		const seen = [];
		let ver = null;
		try {
			await chatEng.run_turn(text, (ev) => {
				if (ev.type === 'tool_result') seen.push(String(ev.content || ''));
				if (ev.type === 'versions') ver = { keeper: String(ev.keeper),
					version: Number(ev.version), files: Array.from(ev.files || []) };
			});
		} catch (e) { seen.push('THREW: ' + String(e && e.message || e)); }
		return { said: seen.join(' | ').slice(0, 300), ver };
	};
	const chatText = 'the chat deletes me';
	await mod.write_file('vault/chat.md', chatText);
	const cd = await chatTurn('@tool file_delete ' + JSON.stringify({ path: 'vault/chat.md' }));
	const crows = JSON.parse(await app.versions_list('chat:' + CHAT));
	const crow = crows.length ? (crows[0].files || []).find((f) => f.path === 'vault/chat.md') : null;
	out.hChat = { del: cd.said, gone: (await read('vault/chat.md')) === null, ver: cd.ver,
		kept: !!crow && !!crow.gone && crow.was === await sha(chatText) };
	const cr = await chatTurn('@tool file_revert ' + JSON.stringify({ path: 'vault/chat.md' }));
	out.hChat.revert = cr.said;
	out.hChat.back = (await read('vault/chat.md')) === chatText;
	// Again, and back through the page's undo: the engine's restore, then the fenced
	// write-back through the CHAT's marks, which `writeMachine` does for a `chat:` store.
	const cd2 = await chatTurn('@tool file_delete ' + JSON.stringify({ path: 'vault/chat.md' }));
	out.hChat.undo = 'no version event';
	if (cd2.ver) {
		try {
			const res = JSON.parse(await app.versions_restore(cd2.ver.keeper, cd2.ver.version - 1,
				'vault/chat.md'));
			const hit = (res.machine || []).find((x) => x.path === 'vault/chat.md' && x.hash);
			if (hit) {
				const body = await app.versions_body(cd2.ver.keeper, hit.hash);
				const w = await app.run_diamond_tool(cd2.ver.keeper, JSON.stringify(['vault']), '[]',
					'file_write', JSON.stringify({ path: 'vault/chat.md', content: body }));
				out.hChat.undo = w.outcome;
			} else {
				out.hChat.undo = 'not sent back through the fence: ' + JSON.stringify(res).slice(0, 200);
			}
		} catch (e) { out.hChat.undo = 'threw: ' + String(e && e.message || e); }
	}
	out.hChat.undone = (await read('vault/chat.md')) === chatText;

	// 3. A Diamond's worker: kept in its Diamond's store, recorded at the daimon's turn end.
	const wEng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
	wEng.set_diamond_scope('diamonds/' + id, JSON.stringify(['vault']), '[]', '[]');
	const workText = 'the worker deletes me';
	await mod.write_file('vault/worker.md', workText);
	let wSaid = '';
	try {
		await wEng.run_turn('@tool file_delete ' + JSON.stringify({ path: 'vault/worker.md' }),
			(ev) => { if (ev.type === 'tool_result') wSaid += String(ev.content || ''); });
	} catch (e) { wSaid += 'THREW: ' + String(e && e.message || e); }
	await turn(['vault'], 'file_list', { path: 'vault' });
	const mw = await newest();
	const wrow = mw && (mw.files || []).find((f) => f.path === 'vault/worker.md');
	out.hWorker = { del: wSaid.slice(0, 160), gone: (await read('vault/worker.md')) === null,
		kept: !!wrow && !!wrow.gone && wrow.was === await sha(workText) };
	const wr = await turn(['vault'], 'file_revert', { path: 'vault/worker.md' });
	out.hWorker.revert = wr;
	out.hWorker.back = (await read('vault/worker.md')) === workText;

	// 9. The lens: the engine's class on a destructive call, and the page's row built from it.
	await mod.write_file('vault/sub/lens.md', 'lens');
	const lensFolder = await turnEv(['vault'], '@tool file_delete ' + JSON.stringify({ path: 'vault/sub' }));
	const lensFile   = await turnEv(['vault'], '@tool file_delete ' + JSON.stringify({ path: 'vault/sub/lens.md' }));
	const lensRead   = await turnEv(['vault'], '@tool file_read ' + JSON.stringify({ path: 'vault/other.txt' }));
	const pick = (list, name) => list.find((e) => e.name === name) || {};
	out.hLens = {
		folder: pick(lensFolder, 'file_delete'),
		file:   pick(lensFile, 'file_delete'),
		read:   pick(lensRead, 'file_read'),
	};
	out.hLens.row = null;
	if (window.DaimondCore && typeof DaimondCore.lensToolRow === 'function') {
		const ev = out.hLens.folder;
		out.hLens.row = DaimondCore.lensToolRow({ name: ev.name, content: ev.content,
			outcome: ev.outcome, class: ev.class }, JSON.stringify({ path: 'vault/sub' }), 't1', 1);
	}

	// A file only in cloud storage: nothing on this device could be kept, so it is refused.
	if (window.DaimondCloud) {
		await DaimondCloud.put('vault/cloudonly.md', { size: 7, chunks: [] }, 'h2',
			{ file: { size: 7 }, timeless: true });
		await DaimondCloud.refreshPaths();
		out.gCloud     = await turn(['vault'], 'file_delete', { path: 'vault/cloudonly.md' });
		out.gCloudKept = !!DaimondCloud.index()['vault/cloudonly.md'];
		DaimondCloud.forget('vault/cloudonly.md');
		await DaimondCloud.refreshPaths();
	}

	// 6. A mark's own path. Last in folder mode: on a build without the rule the move below
	// takes `vault` away, and nothing after this needs it.
	await mod.write_file('vault/pinned.md', 'a marked file');
	out.hMarkDel  = await turn(['vault', 'vault/pinned.md'], 'file_delete', { path: 'vault/pinned.md' });
	out.hMarkKept = (await read('vault/pinned.md')) === 'a marked file';
	// Moved into another place the turn may write, so only the mark rule stands in the way.
	await mod.write_file('vault/stay.md', 'stays in the mark');
	out.hMarkMove = await turn(['vault', 'dest'], 'file_move', { path: 'vault', to: 'dest/vault' });
	out.hMarkStays = (await read('vault/stay.md')) === 'stays in the mark';

	// F. The sandbox, no folder open.
	mod.use_opfs_workspace();
	await mod.write_file('sbx/one.txt', '1');
	out.sbxDir  = await call('file_delete', { path: 'sbx', recursive: 'true' });
	out.sbxFile = await call('file_delete', { path: 'sbx/one.txt' });
	out.gSbx    = await wayBack('sbx', 'note.md', 'the only copy, in the sandbox');
	try { await root.removeEntry('sbx', { recursive: true }); } catch (e) { /* tidy */ }
	try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* tidy */ }
	return out;
}, { folder: FOLDER, mock: MOCK });

const refused = (o) => o && o.outcome === 'refused';
const show = (o) => o ? `${o.outcome}: ${o.text.slice(0, 160)}` : 'none';

check('a folder is open', r.mode === 'folder', r.mode);
check('A. a folder delete with recursive is refused', refused(r.dirRec), show(r.dirRec));
check('A. a folder delete without recursive is refused', refused(r.dirPlain), show(r.dirPlain));
check('A. a subfolder with a trailing slash is refused', refused(r.subRec), show(r.subRec));
check('A. an empty folder is refused', refused(r.empty), show(r.empty));
check('A. the refusal tells the model to ask the user', /user/i.test(r.dirRec.text), r.dirRec.text);
check('A. nothing under a refused folder was removed', r.survived === true);
check("A. a daimon's recursive folder delete is refused", refused(r.diaDir), show(r.diaDir));
check("A. a daimon's subfolder delete is refused", refused(r.diaSub), show(r.diaSub));
check('A. and the tree survives the daimon', r.diaSurv === true);
check("B. '../' is refused", refused(r.up), show(r.up));
check("B. a '..' that climbs out midway is refused", refused(r.up2), show(r.up2));
check('B. an absolute path is refused', refused(r.abs), show(r.abs));
check("B. '.' (the root) is refused", refused(r.dot), show(r.dot));
check('B. the file the escapes named is still there', r.keptAfterEscapes === true);
check('C. one file is deleted', r.file.outcome === 'done' && r.fileGone, show(r.file));
check("C. a daimon's one-file delete in its workspace works",
	r.diaFile.outcome === 'done' && r.diaFileGone, show(r.diaFile));
check("D. a folder cannot be moved off the disk into Daimond's store", refused(r.toStore), show(r.toStore));
check('D. a folder cannot be moved into itself', refused(r.intoSelf), show(r.intoSelf));
check('D. refused moves left the tree whole', r.afterRefusedMoves === true);
check('D. a folder moved within the folder arrives whole',
	r.within.outcome === 'done' && r.movedWhole, show(r.within));
check('D. and its source is gone after', r.within.outcome === 'done' && r.srcGone === true);
check("E. the user's folder door refuses a file",
	r.userFileRefused === true && r.userDir.err === '', r.userDir.err);
check("E. the user's folder door removes a folder",
	r.userDir.err === '' && r.userDir.gone === true, r.userDir.err);
check('D. a folder holding a:b and a%3Ab moves with both, under their own names',
	!!r.colDst && r.colDst['a:b'] === 'COLON' && r.colDst['a%3Ab'] === 'PERCENT'
		&& r.colDst['z.txt'] === 'Z' && r.colSrcGone === true,
	show(r.colMove) + ' | ' + JSON.stringify(r.colDst));
check("E. the user's folder delete forgets the cloud-only files under it",
	r.cloud && r.cfForgotten === true, String(r.cfForgotten));
check('F. a folder delete is refused in the sandbox too', refused(r.sbxDir), show(r.sbxDir));
check('F. a sandbox file still deletes', r.sbxFile.outcome === 'done', show(r.sbxFile));

for (const [where, g] of [['folder', r.gFolder], ['sandbox', r.gSbx]]) {
	check(`G. ${where}: a daimon's one-file delete runs`, /Deleted /.test(g.del) && g.gone, g.del);
	check(`G. ${where}: the turn records it as a version that keeps the bytes`,
		!!g.row && g.row.gone && g.row.was, JSON.stringify(g.row));
	check(`G. ${where}: History's restore puts it back`, g.history.restored === true, g.history.why);
	check(`G. ${where}: file_revert puts it back`, g.reverted === true, g.del2 + ' | ' + g.revert);
	check(`G. ${where}: its neighbour was not touched`, g.otherKept === true);
}
check('G. a file too large to keep is refused to a daimon', /^Refused/.test(r.gBig), r.gBig.slice(0, 160));
check('G. and is still there', r.gBigKept === true);
for (const g of r.gSpell) {
	check(`G. '${g.spell}' is deleted and kept as the one file it names`,
		g.gone && g.kept, g.del);
	check(`G. '${g.spell}': file_revert puts it back`, g.back === true, g.rev);
}
check('G. a captured delete has a row to attack', r.gStore.row === true);
check('G. the daimon cannot delete a body of its own version store',
	/^Refused/.test(r.gStore.body || ''), (r.gStore.body || '').slice(0, 160));
check('G. nor a manifest', /^Refused/.test(r.gStore.man || ''), (r.gStore.man || '').slice(0, 160));
check('G. nor write over one', /^Refused/.test(r.gStore.write || ''),
	(r.gStore.write || '').slice(0, 160));
check('G. and file_revert still has its copy', r.gStore.back === true, (r.gStore.rev || '').slice(0, 160));
check('G. a file only in cloud storage is refused to a daimon, not forgotten',
	/^Refused/.test(r.gCloud || '') && r.gCloudKept === true, (r.gCloud || '').slice(0, 200));

// H.
check('H2. a turn deletes as many files as one version keeps',
	r.hCap.done === 64 && r.hCap.rows === 64, JSON.stringify({ done: r.hCap.done, rows: r.hCap.rows, calls: r.hCap.calls }));
check('H2. and the next is refused, sending the model to the user',
	/^Refused/.test(r.hCap.last) && /ask the user/.test(r.hCap.last) && r.hCap.lastKept === true,
	r.hCap.last.slice(0, 200));
check("H3. a chat's delete runs", /Deleted /.test(r.hChat.del) && r.hChat.gone, r.hChat.del);
check("H3. and the chat's own store keeps it", r.hChat.kept === true, JSON.stringify(r.hChat.ver));
check('H3. and tells the page, which offers it back',
	!!r.hChat.ver && r.hChat.ver.keeper === 'chat:cfd1' && r.hChat.ver.files.includes('vault/chat.md'),
	JSON.stringify(r.hChat.ver));
check("H3. the chat's file_revert puts it back", r.hChat.back === true, r.hChat.revert);
check("H3. and so does the page's undo, through the chat's marks",
	r.hChat.undone === true && r.hChat.undo === 'done', String(r.hChat.undo));
check("H3. a Diamond worker's delete runs", /Deleted /.test(r.hWorker.del) && r.hWorker.gone, r.hWorker.del);
check("H3. and is kept in its Diamond's store at the daimon's turn end", r.hWorker.kept === true);
check("H3. and file_revert puts it back", r.hWorker.back === true, r.hWorker.revert.slice(0, 160));
check("H6. a mark's own file is not deleted",
	/^Refused/.test(r.hMarkDel) && r.hMarkKept === true, r.hMarkDel.slice(0, 200));
check('H6. nor a marked folder moved, even where its destination may be written',
	/^Refused/.test(r.hMarkMove) && /places this turn was given/.test(r.hMarkMove)
		&& r.hMarkStays === true, r.hMarkMove.slice(0, 200));
{
	const d = sentDesc.length ? sentDesc[sentDesc.length - 1] : '';
	check('H5. the model is sent a file_delete description', !!d, String(sentDesc.length));
	check("H5. it says an open folder is the user's own disk and every synced copy",
		/user's own disk/.test(d) && /every copy their sync reaches/.test(d), d.slice(0, 200));
	check('H5. and never sends the model to run, nor denies a door onto this computer',
		!!d && !/\brun\b/.test(d) && !/NO DOOR ONTO THIS COMPUTER/i.test(d), d.slice(0, 200));
}
const cls = (e) => { try { return e && e.class ? JSON.parse(e.class) : null; } catch (x) { return null; } };
const cf = cls(r.hLens.folder), cfile = cls(r.hLens.file);
check('H9. a refused folder delete is classed: depth, folder, in the open folder, refused',
	!!cf && cf.d === 2 && cf.k === 'folder' && cf.open === true && cf.refused === true,
	String(r.hLens.folder.class));
check('H9. a file delete is classed as a file, not refused',
	!!cfile && cfile.d === 3 && cfile.k === 'file' && cfile.open === true && cfile.refused === false,
	String(r.hLens.file.class));
check('H9. and the class names no path', !/vault|sub|lens/.test(String(r.hLens.folder.class) + String(r.hLens.file.class)));
check('H9. a read carries no class', r.hLens.read.name === 'file_read' && r.hLens.read.class === null,
	String(r.hLens.read.class));
const row = r.hLens.row;
check("H9. the page's tool row carries ab and the class, and no path",
	!!row && row.ab === JSON.stringify({ path: 'vault/sub' }).length && row.pd === 2
		&& row.pk === 'folder' && row.po === 1 && row.px === 1 && !/vault/.test(JSON.stringify(row)),
	JSON.stringify(row));
{
	// The daimon's half builds its row with the same function; read off the source this world
	// SERVES, so a run against another tree's bundle is measured against that tree's page.
	const src = await p.evaluate(() => fetch('js/daimond.js').then((x) => x.text()).catch(() => ''));
	check("H9. the daimon's tool row is the chat's, with its args measured",
		/lensToolRow\(ev,\s*last && last\.role === 'tool_log' \? last\.args : ''/.test(src)
			&& /dsEvent\('tool', lensToolRow\(ev, pendingTool/.test(src));
}

const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
