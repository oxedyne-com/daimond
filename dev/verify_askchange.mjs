// gateway: none
// verify_askchange.mjs -- a turn asks before it changes a file of the user's (UNBLOCK-26 U3).
//
// On 18 Oct 2026 a daimon filed a letter into his biography with two `file_edit` calls in a folder
// he had marked, and nothing asked.  A mark lets a turn write in a folder; it never said the turn
// may rewrite what he wrote there.  Every arm drives the real wasm and real turns (the mock's
// `@tool`), with the page's question stubbed (`window.DaimondDeletes.change`) to answer as told
// and to record what it was shown:
//
//   A1. file_edit of his file asks, and on No writes nothing; on Apply it writes.
//   A2. the same through a worker.
//   A3. file_move of his file asks, and on No moves nothing.
//   A4. a folder move carrying one of his files asks, and on No moves nothing.
//   A5. file_delete of his file asks, and on No deletes nothing.
//   A6. a file the Diamond made itself is edited without asking.
//   A7. a file that changes between the question and Apply is not written over.
//   A8. a No holds for the rest of the turn: a second verb on the same file is refused unasked.
//
// Needs a world for the mock provider: `eval "$(bash dev/world.sh N --env)"`, and the wasm built
// (`dev/build-wasm.sh --no-opt`).  `AC_ONLY=A1,A3` runs a subset.

import { open, answerChanges } from './harness.mjs';
import { armFilter, guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FOLDER = 'acfolder';
const MOCK   = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
const want   = armFilter('AC_ONLY');

// A loaded machine can take longer than Playwright's thirty seconds to paint the first page.
const s = await open({ name: 'askchange', connect: false,
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
	// Named as the page names every folder it opens (FsaDB.folderId): a folder opened with no id
	// names no folder, so its rows are asked about before they go back over different bytes (HX2).
	const FID = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
	mod.set_workspace_dir(dir, FID);
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const read = async (path) => { try { return await mod.read_file(path); } catch (e) { return null; } };
	const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
		new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
	// The marks a turn names, PRESSED as the page presses them (HIST-SAFE U2): the engine reads the
	// Diamond's sidecar row and this device's record of the press itself and takes no list from a
	// caller. Exactly the named marks are left in force: one pressed for an earlier turn and not
	// named now is withdrawn as the page withdraws one (`removeLinkHere`). Read off the sidecar
	// each time, so it holds across the reload F3 needs. Only marks pressed HERE (rooted on this
	// folder, as `refOf` writes them) are withdrawn: a user row a section wrote for itself -- F7's
	// `usermark`, which the daimon must be refused removing -- is that section's, not the turn's.
	const ROOT = 'machine:' + folder + '#' + FID;
	const refOf = (m) => (m.includes('.') ? 'file:' : 'dir:') + '[machine:' + folder + ']' + m;
	const pressedHere = (to) => /^(file|dir):/.test(to)
		&& to.slice(to.indexOf(':') + 1).startsWith('[machine:' + folder + ']');
	const press = async (id, marks) => {
		const did = String(id);
		const want = marks.map(refOf);
		const rows = JSON.parse(await app.links_touching('diamond:' + did) || '[]')
			.filter((l) => l.owner === did && l.from === 'diamond:' + did && l.rel === 'holds'
				&& l.by === 'user' && pressedHere(String(l.to || '')));
		for (const l of rows) {
			if (want.includes(l.to)) continue;
			window.DaimondMarksHere.drop(did, l.id, l.to);
			await app.remove_link(did, l.id);
		}
		for (const ref of want) {
			if (rows.some((l) => l.to === ref) && window.DaimondMarksHere.force(did, rows.find((l) => l.to === ref), ROOT)) continue;
			if (!await window.__pressMark(app, did, ref, ROOT)) throw new Error('mark not pressed: ' + ref);
		}
	};
	// A daimon's turn: the mock answers `@tool` / `@tools` with those calls.
	const turnEv = async (id, marks, text) => {
		const eng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
		const seen = [];
		try {
			await press(id, marks);
			await eng.steer_crystal(id, text, '[]', [],
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
		const seen = [];
		try {
			await press(id, marks);
			// As the page scopes a worker (`scopeAgentTo`): the engine reads the marks itself.
			const reach = await eng.read_scope_reach(String(id));
			eng.set_diamond_scope(reach, '[]');
			await eng.run_turn(text, (ev) => {
				if (ev.type === 'tool_result') seen.push(String(ev.content || ''));
			});
		} catch (e) { seen.push('THREW: ' + String(e && e.message || e)); }
		return seen;
	};
	// THE PAGE'S "Use here" on a waiting row, under the root the ENGINE has open. `confirmHere`
	// presses under the page's own root, and this verifier opens the folder in the engine behind
	// the page's back (`set_workspace_dir` above), so the page still stands on `browser` and its
	// press would land where the engine never looks. The same grant `confirmMarkHere` makes, on
	// the workspace the turns run on.
	const confirm = async (id, ref) => {
		const did = String(id);
		const row = JSON.parse(await app.links_touching('diamond:' + did) || '[]')
			.find((l) => l.owner === did && l.from === 'diamond:' + did && l.to === ref);
		return !!row && window.DaimondMarksHere.grant(did, row, ROOT, { share: false });
	};
	const newest = async (id) => {
		const rows = JSON.parse(await app.versions_list(id));
		return rows.length ? rows[0] : null;
	};
	window.__k = { mod, app, dir, read, sha, turn, turnEv, worker, newest, press, confirm };
}, { folder: FOLDER, mock: MOCK, fresh });

await install(true);
const id = await p.evaluate(() => __k.app.create_diamond('ask change'));

// The page's question, stubbed: answers `window.__changeAnswer` (a word, or a function of the
// payload) and records every payload it is shown.
await answerChanges(p, 'refused');
// One arm: fresh files written by the person (the test's own door), a fresh question log.
const arm = (fn, arg) => p.evaluate(async ({ id, src, arg }) => {
	window.__changeAsks = [];
	window.__changeAnswer = 'refused';
	const f = new Function('return (' + src + ')')();
	return await f({ ...__k, id, asks: () => window.__changeAsks, answer: (a) => { window.__changeAnswer = a; } }, arg);
}, { id, src: fn.toString(), arg });
const short = (x) => JSON.stringify(x).slice(0, 260);

if (want('A1')) {
	const r = await arm(async ({ mod, read, turn, id, asks, answer }) => {
		await mod.write_file('vault/a1.md', 'Dear Jason,\nline two\n');
		const no = await turn(id, ['vault'], 'file_edit',
			{ path: 'vault/a1.md', old_string: 'line two', new_string: 'LINE TWO' });
		const afterNo = await read('vault/a1.md');
		const askedNo = asks().map((a) => ({ act: a.act, path: a.path, add: a.add, del: a.del }));
		window.__changeAsks = [];
		answer('apply');
		await mod.write_file('vault/a1b.md', 'Dear Jason,\nline two\n');
		const yes = await turn(id, ['vault'], 'file_edit',
			{ path: 'vault/a1b.md', old_string: 'line two', new_string: 'LINE TWO' });
		return { no, afterNo, askedNo, yes, afterYes: await read('vault/a1b.md'), askedYes: asks().length };
	});
	check('A1. file_edit of his file asks first', r.askedNo.length === 1 && r.askedNo[0].act === 'change'
		&& /a1\.md$/.test(r.askedNo[0].path), short(r.askedNo));
	check('A1. on No nothing is written, and the model is told', r.afterNo === 'Dear Jason,\nline two\n'
		&& /chose not to have/.test(r.no), r.no.slice(0, 200));
	check('A1. on Apply the edit lands', r.askedYes === 1 && r.afterYes === 'Dear Jason,\nLINE TWO\n',
		r.yes.slice(0, 160));
}

if (want('A2')) {
	const r = await arm(async ({ mod, read, worker, id, asks }) => {
		await mod.write_file('vault/a2.md', 'his words\n');
		const said = await worker(id, ['vault'], '@tool file_edit ' + JSON.stringify(
			{ path: 'vault/a2.md', old_string: 'his words', new_string: 'a worker\'s words' }));
		return { said: said.join(' | ').slice(0, 300), after: await read('vault/a2.md'), asked: asks().length };
	});
	check('A2. a worker\'s file_edit of his file asks too, and on No writes nothing',
		r.asked === 1 && r.after === 'his words\n', short(r));
}

if (want('A3')) {
	const r = await arm(async ({ mod, read, turn, id, asks }) => {
		await mod.write_file('vault/a3.md', 'chapter\n');
		const said = await turn(id, ['vault'], 'file_move', { path: 'vault/a3.md', to: 'vault/moved/a3.md' });
		return { said, from: await read('vault/a3.md'), to: await read('vault/moved/a3.md'),
			asked: asks().map((a) => ({ act: a.act, to: a.to })) };
	});
	check('A3. file_move of his file asks, and on No moves nothing',
		r.asked.length === 1 && r.asked[0].act === 'move' && r.from === 'chapter\n' && r.to === null,
		short(r));
}

if (want('A4')) {
	const r = await arm(async ({ mod, read, turn, id, asks }) => {
		await mod.write_file('vault/a4dir/inner/his.md', 'his\n');
		const said = await turn(id, ['vault'], 'file_move', { path: 'vault/a4dir', to: 'vault/a4moved' });
		return { said, from: await read('vault/a4dir/inner/his.md'),
			to: await read('vault/a4moved/inner/his.md'), asked: asks().map((a) => a.act) };
	});
	check('A4. a folder move carrying one of his files asks, and on No moves nothing',
		r.asked.length === 1 && r.asked[0] === 'move' && r.from === 'his\n' && r.to === null, short(r));
}

if (want('A5')) {
	const r = await arm(async ({ mod, read, turn, id, asks }) => {
		await mod.write_file('vault/a5.md', 'keep me\n');
		const said = await turn(id, ['vault'], 'file_delete', { path: 'vault/a5.md' });
		return { said, after: await read('vault/a5.md'), asked: asks().map((a) => a.act) };
	});
	check('A5. file_delete of his file asks, and on No deletes nothing',
		r.asked.length === 1 && r.asked[0] === 'delete' && r.after === 'keep me\n', short(r));
}

if (want('A6')) {
	const r = await arm(async ({ read, turn, id, asks, answer }) => {
		answer('apply');
		const made = await turn(id, ['vault'], 'file_write', { path: 'vault/a6own.md', content: 'draft one\n' });
		const edit = await turn(id, ['vault'], 'file_edit',
			{ path: 'vault/a6own.md', old_string: 'draft one', new_string: 'draft two' });
		return { made, edit, after: await read('vault/a6own.md'), asked: asks().length };
	});
	check('A6. a file the Diamond made is edited without asking',
		r.asked === 0 && r.after === 'draft two\n', short(r));
}

if (want('A7')) {
	const r = await arm(async ({ mod, read, turn, id, asks, answer }) => {
		await mod.write_file('vault/a7.md', 'as shown\n');
		// He saves the file while the question is open, then says Apply.
		answer(async () => { await mod.write_file('vault/a7.md', 'saved while asked\n'); return 'apply'; });
		const said = await turn(id, ['vault'], 'file_edit',
			{ path: 'vault/a7.md', old_string: 'as shown', new_string: 'the model\'s' });
		return { said, after: await read('vault/a7.md'), asked: asks().length };
	});
	check('A7. a file changed between the question and Apply is not written over',
		r.asked === 1 && r.after === 'saved while asked\n' && /changed while the user was being asked/.test(r.said),
		short(r));
}

if (want('A8')) {
	const r = await arm(async ({ mod, read, turnEv, id, asks }) => {
		await mod.write_file('vault/a8.md', 'mine\n');
		const ev = await turnEv(id, ['vault'], '@tools file_edit ' + JSON.stringify(
			{ path: 'vault/a8.md', old_string: 'mine', new_string: 'edited' }) + ' ;; file_write '
			+ JSON.stringify({ path: 'vault/a8.md', content: 'rewritten\n' }) + ' ;; file_delete '
			+ JSON.stringify({ path: 'vault/a8.md' }));
		return { said: ev.map((e) => e.name + ': ' + e.content.slice(0, 90)), after: await read('vault/a8.md'),
			asked: asks().length };
	});
	check('A8. a No holds for the turn: the other verbs are refused unasked, and nothing changes',
		r.asked === 1 && r.after === 'mine\n' && r.said.some((s) => /^file_delete: .*already chose not to have/.test(s)),
		short(r));
}

await p.evaluate(async (folder) => {
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* tidy */ }
}, FOLDER);
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR|Failed to load resource/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

guardRan(ok.length + bad.length, want);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
