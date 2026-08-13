// verify_chatscope.mjs — an ordinary chat has a WORKSPACE, and it is a real
// boundary that never interrupts anybody.
//
// On 2026-08-11 a daimon in an ordinary chat edited two files of the user's own
// book — `thinking.typ` and `config.typ` — to work around a compiler
// limitation, in a directory under no version control, and put them back only
// because it chose to. No worker was involved, so the worker fence that existed
// could not have helped: `chat_bounds` was applied to dispatched workers alone
// and the conversation itself carried no bounds at all.
//
// The remedy the author asked for is a WORKING DIRECTORY and not a permission
// dialog — Claude Code run on bypassed permissions, where the friction is paid
// once at the `cd` and nothing inside interrupts you. So:
//
//   * A CHAT HAS A WORKSPACE, the set of folders the user marked into it, and it
//     is fenced to it FOR WRITING AND RUNNING. Reading is free inside whatever
//     the user already opened (amended 2026-08-13; this file asserted the
//     opposite for a day, and `dev/verify_chatfence.mjs` asserted this one, and
//     they cannot both be right).
//   * THE MARK IS THE PERMISSION, and what it grants is WRITING. Inside the
//     workspace a write happens with nothing asked. A fence that also
//     interrupted would have missed the point, so the control below is as
//     load-bearing as the refusals.
//   * NOTE AND READ ARE NOT THE MARK. They are a cost decision about what is
//     quoted into the prompt — a path costs a few tokens, a file costs
//     thousands — and neither grants any reach. A path attached as Read and NOT
//     marked into the workspace is readable, as everything is, and cannot be
//     changed.
//   * AN EMPTY WORKSPACE IS THE CHAT'S OWN SCRATCH AND NOTHING ELSE TO WRITE IN,
//     which is what a Diamond with no attachment gets.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST.
//
//   node dev/verify_chatscope.mjs --break unscoped     # the state before this change
//   node dev/verify_chatscope.mjs --break allattached  # Note becomes a grant
//   node dev/verify_chatscope.mjs --break readonlyrw   # 'consult' becomes 'edit'
//   node dev/verify_chatscope.mjs --break nowrite      # the workspace is read-only
//   node dev/verify_chatscope.mjs                      # and then, clean
//
// The breaks are applied to the SCOPE THE PAGE ASKS FOR, never to the engine:
// the engine is the thing under test, and a break that damaged it would prove
// only that a damaged engine misbehaves. Each one is a plausible caller mistake,
// and `allattached` is the one this design turns on — it is what a caller does
// who reads the paperclip's list as a permission list.
import { open } from './harness.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'chatscope', signIn: true, connect: false });
const { page } = s;
await page.waitForFunction(() => !!window.DaimondCore, null, { timeout: 15000 }).catch(() => {});

try {
	// ── The instrument, installed before anything is driven ──
	//
	// "Nothing asked" is a claim about an ABSENCE, and an absence is what a
	// broken detector reports too. So the counter is installed first, proved at
	// the end against a dialog put up on purpose, and only then believed.
	// `.modal.dlg` is what `confirmDialog` builds (daimond.js:5762); the other
	// selectors are there so a future dialog of a different shape is still seen.
	await page.evaluate(() => {
		window.__asked = { dialogs: 0, confirms: 0, prompts: 0 };
		window.confirm = function () { window.__asked.confirms++; return true; };
		window.prompt  = function () { window.__asked.prompts++;  return '';   };
		var sel = '.modal, .dlg, [role="dialog"], dialog';
		var isDialog = function (n) {
			if (!n || n.nodeType !== 1) return false;
			return (n.matches && n.matches(sel)) || (n.querySelector && !!n.querySelector(sel));
		};
		new MutationObserver(function (ms) {
			ms.forEach(function (m) {
				Array.prototype.forEach.call(m.addedNodes, function (n) {
					if (isDialog(n)) window.__asked.dialogs++;
				});
			});
		}).observe(document.documentElement, { childList: true, subtree: true });
	});
	const asked = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__asked)));
	const resetAsked = () => page.evaluate(() => {
		window.__asked.dialogs = 0; window.__asked.confirms = 0; window.__asked.prompts = 0;
	});

	// Lay down the user's files through an UNSCOPED app — which is what a chat
	// was until this change, and which is also the reader used below to prove a
	// refusal really left a file alone. `papers` is marked into the workspace;
	// `books` and `elsewhere` are not; `refs` is marked read-only; `quoted` is
	// attached as Read and marked into nothing.
	await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		window.__free = app;
		const put = (path, content) => app.run_tool('file_write', JSON.stringify({ path, content }));
		await put('papers/spec.md',      'the spec as the user left it\n');
		await put('books/thinking.typ',  'the user own chapter\n');
		await put('elsewhere/notes.md',  'the user own note\n');
		await put('refs/handbook.md',    'a reference to consult\n');
		await put('quoted/passage.md',   'a passage quoted into the chat\n');
		// Laid down so the deny below is refused for being DENIED rather than for
		// being absent. A refusal and a missing file read the same to a check on
		// the reply text, and only one of them is the rule under test.
		await put('.daimond/config.json', '{"seeded":true}\n');
	});

	/// A chat's own app, scoped as the page will scope one.
	///
	/// `ws` is what the user MARKED INTO THE WORKSPACE; `ro` is the read-only
	/// part of it; `noted` is attached-but-not-marked — Note or Read, which are
	/// about cost and not about reach. Only the first two may reach the engine.
	const chatApp = async (ws, ro, noted, brk) => await page.evaluate(async (a) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		window.__app = app;
		let scratch = 'chats/c-scope/work';
		let ws = a.ws.slice(), ro = a.ro.slice();
		// The state this change replaced: the chat's own turn was never scoped at
		// all. Nothing is set, and the app keeps the reach of the whole workspace.
		if (a.brk === 'unscoped') return JSON.parse(app.diamond_scope() || '{}');
		// The mistake this design turns on: reading the paperclip's whole list as a
		// permission list, so a path attached only to be quoted becomes reachable.
		if (a.brk === 'allattached') ws = ws.concat(a.noted);
		// 'Consult, do not edit' handed over as ordinary workspace.
		if (a.brk === 'readonlyrw') { ws = ws.concat(ro); ro = []; }
		// And the opposite slip: the workspace handed over as read-only, so the
		// chat can look at the folder it was given and change nothing in it.
		if (a.brk === 'nowrite') { ro = ro.concat(ws); ws = []; }
		app.set_chat_scope(scratch, JSON.stringify(ws), JSON.stringify(ro));
		return JSON.parse(app.diamond_scope() || '{}');
	}, { ws, ro, noted, brk });

	const tool = (name, args) => page.evaluate(
		({ name, args }) => window.__app.run_tool(name, JSON.stringify(args)).then(String),
		{ name, args });
	/// What is actually on disk, read by the unscoped app — so "the refusal is
	/// real" is asserted against the file rather than against the reply text.
	const onDisk = (path) => page.evaluate(
		(p) => window.__free.run_tool('file_read', JSON.stringify({ path: p })).then(String), path);

	// ── An empty workspace ──
	const bare = await chatApp([], [], ['quoted'], BREAK);
	check('a chat declares a workspace even when the user has marked nothing into it',
		Array.isArray(bare.write_allow) && bare.write_allow.indexOf('chats/c-scope/work') >= 0
			&& (bare.allow || []).length === 0,
		JSON.stringify(bare));

	const bareRead = await tool('file_read', { path: 'books/thinking.typ' });
	check('with an empty workspace the user\'s files are still readable',
		/the user own chapter/.test(bareRead), bareRead.slice(0, 100));

	const bareWrite = await tool('file_write', { path: 'books/thinking.typ', content: 'rewritten\n' });
	check('and not writable — this is the file the incident was about',
		/Refused/.test(bareWrite), bareWrite.slice(0, 100));
	const bookAfter = await onDisk('books/thinking.typ');
	check('and the refusal is real: the chapter is untouched on disk',
		/the user own chapter/.test(bookAfter) && !/rewritten/.test(bookAfter),
		bookAfter.slice(0, 100));

	const bareScratch = await tool('file_write',
		{ path: 'chats/c-scope/work/draft.md', content: 'thinking out loud\n' });
	check('a chat always has its own folder to work in, marked or not',
		!/Refused/.test(bareScratch), bareScratch.slice(0, 100));

	// ── A folder marked into the workspace ──
	const held = await chatApp(['papers'], ['refs'], ['quoted'], BREAK);
	check('a marked folder is in the workspace the engine holds',
		(held.write_allow || []).indexOf('papers') >= 0, JSON.stringify(held.write_allow));

	const readIn = await tool('file_read', { path: 'papers/spec.md' });
	check('inside the workspace, reading works',
		/the spec as the user left it/.test(readIn), readIn.slice(0, 100));

	// THE CONTROL. A fence that also interrupts has failed the brief, so the
	// counters are cleared, a real write is made, and nothing may have asked.
	await resetAsked();
	const writeIn = await tool('file_write',
		{ path: 'papers/from-the-chat.md', content: 'written with nobody asked\n' });
	const quietWrite = await asked();
	check('inside the workspace, writing works',
		!/Refused/.test(writeIn), writeIn.slice(0, 100));
	check('and it lands: the file is there afterwards',
		/written with nobody asked/.test(await onDisk('papers/from-the-chat.md')));
	check('and NOTHING ASKED — no dialog, no confirm, no prompt',
		quietWrite.dialogs === 0 && quietWrite.confirms === 0 && quietWrite.prompts === 0,
		JSON.stringify(quietWrite));

	// An EDIT of a file that was already there, not merely a new file. Asserted on
	// what the file says afterwards rather than on the reply text: `!/Refused/` is
	// true of an exception as well as of a success, which is how a verifier passes
	// for the wrong reason.
	await tool('file_edit',
		{ path: 'papers/spec.md', old_string: 'as the user left it', new_string: 'as the chat left it' });
	const spec = await onDisk('papers/spec.md');
	check('and editing a file already in the workspace works, with nothing asked',
		/as the chat left it/.test(spec) && (await asked()).dialogs === 0, spec.slice(0, 100));

	// ── Outside it, one verb ──
	const outRead = await tool('file_read', { path: 'elsewhere/notes.md' });
	check('outside the workspace, reading works',
		/the user own note/.test(outRead), outRead.slice(0, 110));

	const outWrite = await tool('file_write', { path: 'elsewhere/notes.md', content: 'clobbered\n' });
	check('outside the workspace, writing is refused', /Refused/.test(outWrite), outWrite.slice(0, 110));
	check('and the refusal names the chat\'s workspace, not a Diamond\'s',
		/chat/i.test(outWrite) && !/Diamond's workspace/.test(outWrite), outWrite.slice(0, 140));
	check('and it says the read it was probably about is allowed',
		/Reading is not fenced/.test(outWrite), outWrite.slice(0, 200));
	const noteAfter = await onDisk('elsewhere/notes.md');
	check('and that refusal is real too — the note is untouched',
		/the user own note/.test(noteAfter) && !/clobbered/.test(noteAfter), noteAfter.slice(0, 100));

	// A walk reaches paths it does not name, so the door is not the whole house:
	// `file_list` re-asks per entry. It now lists outside the workspace, which is
	// what "summarise these ten files" needs — and every entry it lists is still
	// refused to every writing tool.
	const listOut = await tool('file_list', { path: 'elsewhere' });
	check('and a directory listing outside the workspace works',
		/notes\.md/.test(listOut), listOut.slice(0, 110));

	// ── Note and Read are not the mark ──
	//
	// The mark grants WRITING. Note and Read decide what is quoted into the prompt
	// and grant nothing at all — which is now asserted as it always should have
	// been: the quoted path is no more writable than any other, and no less
	// readable.
	const quotedRead = await tool('file_read', { path: 'quoted/passage.md' });
	check('a path attached to be QUOTED is readable, as everything in the workspace is',
		/a passage quoted into the chat/.test(quotedRead), quotedRead.slice(0, 110));
	const quotedWrite = await tool('file_write',
		{ path: 'quoted/passage.md', content: 'rewritten by the chat\n' });
	check('and attaching it did not make it writable — Note is not a grant',
		/Refused/.test(quotedWrite), quotedWrite.slice(0, 110));
	check('and it is untouched on disk',
		/a passage quoted into the chat/.test(await onDisk('quoted/passage.md')));

	// ── Consult, do not edit ──
	const roRead = await tool('file_read', { path: 'refs/handbook.md' });
	check('a read-only workspace path can be consulted',
		/a reference to consult/.test(roRead), roRead.slice(0, 100));
	const roWrite = await tool('file_write',
		{ path: 'refs/handbook.md', content: 'edited by the chat\n' });
	check('and cannot be edited', /Refused/.test(roWrite), roWrite.slice(0, 110));
	check('and is untouched on disk',
		/a reference to consult/.test(await onDisk('refs/handbook.md')));

	// Daimond's own directory holds the rules about what agents may do, and is
	// out of a chat's workspace as it is out of a Diamond's.
	const ownDir = await tool('file_read', { path: '.daimond/config.json' });
	check('Daimond\'s own directory is not readable from a chat',
		/Refused/.test(ownDir), ownDir.slice(0, 100));
	const ownWrite = await tool('file_write',
		{ path: '.daimond/config.json', content: '{"owned":true}\n' });
	check('nor writable — it holds the rules about what agents may do',
		/Refused/.test(ownWrite), ownWrite.slice(0, 100));
	check('and the control that makes that mean something: the file IS there',
		/seeded/.test(await onDisk('.daimond/config.json')));

	// ── The instrument, proved ──
	//
	// Everything above that says "nothing asked" is worth exactly as much as
	// this. A dialog is put up deliberately and the counter must see it; a
	// counter that cannot go up has been reporting silence, not quiet.
	await resetAsked();
	await page.evaluate(() => {
		var back = document.createElement('div');
		back.className = 'modal dlg';
		var card = document.createElement('div');
		card.className = 'modal-card dlg-card';
		back.appendChild(card);
		document.body.appendChild(back);
		window.confirm('proving the counter');
	});
	await page.waitForTimeout(50);
	const proof = await asked();
	check('the instrument works: a dialog put up on purpose IS counted',
		proof.dialogs > 0 && proof.confirms > 0, JSON.stringify(proof));
	await page.evaluate(() => {
		var n = document.querySelector('.modal.dlg');
		if (n && n.parentNode) n.parentNode.removeChild(n);
	});
} catch (e) {
	check('no exception during the run', false, String(e && e.message || e));
} finally {
	try { await s.browser.close(); } catch (e) { /* ignore */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
