// verify_mailroot.mjs — a mailbox belongs to the account, not to whichever folder is open.
//
// `mail/<address>/…` was NOT one of Daimond's own roots, so every path the mail
// client used resolved against the workspace root like a file of the user's:
// sync with folder A open and the messages landed inside A, close it and Daimond
// read the sandbox and found nothing, open folder B and they went somewhere else
// again. A mailbox is per ACCOUNT, so that was wrong in all three directions —
// and a real folder would not even take the names, because a Maildir file is
// called `70074.3.daimond:2,S` and nothing outside a browser's sandbox accepts
// the colon.
//
// The rule is now one line, in the same place the Diamond store's is
// (`is_store_path`, src/tools.rs; `resolve_root`, src/wasm/opfs.rs), and the
// messages an earlier build stranded in a folder are COPIED home on the next
// folder activation and never deleted (`bring_mail_home`, src/wasm/diamond.rs).
//
// What is checked:
//   * mail written with a folder open lands in the store and NOT in the folder;
//   * it reads back after the folder is closed, and after a switch to another;
//   * a message present only in the folder is readable after the migration,
//     under the name the mail client asks for — colon and all;
//   * a draft is never lost: it comes home, and the folder's copy stays put;
//   * a draft ALREADY in the store is not overwritten by the folder's older one;
//   * running the migration twice changes nothing, and makes no second copy;
//   * no message ends up under two spellings of its own name;
//   * with no folder ever opened the migration is a no-op, which is the common
//     case;
//   * `mailbox.md`, `mail-old/` and `src/mail/` are the user's work and still
//     follow the folder — a fix that pinned everything to the sandbox would pass
//     half of the above and destroy real-folder mode.
//
// A real folder needs `showDirectoryPicker()`, a native dialog no harness can
// answer, so an OPFS subdirectory stands in for one — the same stand-in
// dev/verify_droots.mjs and dev/verify_fsa.mjs use, and for the same reason:
// what the picker returns is a FileSystemDirectoryHandle, and OPFS hands out
// that very type. The one thing it cannot reproduce is a real folder REFUSING a
// colon, so the on-disk names below are asserted rather than assumed: what the
// codec does with them is proved in src/fsname.rs's own tests.
//
// Run with dev/serve.mjs (DAIMOND_PORT, default 8777) up. No gateway, no hand, no mock
// model.
//
//	node dev/verify_mailroot.mjs
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FOLDER = 'standin-folder';        // an OPFS subdirectory standing in for a picked folder
const ADDR   = 'alice@example.com';
const BOX    = 'mail/' + ADDR + '/INBOX/cur';
const MSG    = '70074.3.daimond:2,S';   // the Maildir name, colon and all
const MSG2   = '70075.3.daimond:2,';
const RAW    = 'From: bob@example.net\r\nSubject: in the folder\r\n\r\nbody\r\n';

const s = await open({ name: 'mailroot', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

// Helpers installed in the page, so every step below drives the real engine.
// Re-installed after a reload, which takes the page's globals with it.
const install = () => p.evaluate(async (folder) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	window.__d = {
		mod,
		app:    new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true),
		root:   await navigator.storage.getDirectory(),
		folder: null,
	};
	__d.folder = await __d.root.getDirectoryHandle(folder, { create: true });

	// Reach a directory by its ON-DISK components, bypassing every tool: the question
	// "where did the bytes land, and under what name" must not be answered by the thing
	// under test. `parts` are literal filesystem names, not workspace ones.
	const dirAt = async (which, parts, create) => {
		let cur = which === 'folder' ? __d.folder : __d.root;
		for (const seg of parts) cur = await cur.getDirectoryHandle(seg, { create: !!create });
		return cur;
	};
	// Every name a directory actually holds, exactly as the filesystem spells it.
	window.__names = async (which, path) => {
		try {
			const dir = await dirAt(which, path ? path.split('/') : [], false);
			const out = [];
			for await (const [name] of dir.entries()) out.push(name);
			return out.sort();
		} catch (e) { return null; }
	};
	// Read a file by its on-disk path.
	window.__at = async (which, path) => {
		const parts = path.split('/');
		try {
			const dir = await dirAt(which, parts.slice(0, -1), false);
			const fh  = await dir.getFileHandle(parts[parts.length - 1]);
			return await (await fh.getFile()).text();
		} catch (e) { return null; }
	};
	// Write a file by its on-disk path, which is how a folder left by an earlier build
	// is reproduced: that build wrote through the same codec, so the colon arrives
	// escaped in a folder and bare in the sandbox.
	window.__put = async (which, path, body) => {
		const parts = path.split('/');
		const dir = await dirAt(which, parts.slice(0, -1), true);
		const fh  = await dir.getFileHandle(parts[parts.length - 1], { create: true });
		const w   = await fh.createWritable();
		await w.write(body);
		await w.close();
	};
	window.__tool = (name, args) => __d.app.run_tool(name, JSON.stringify(args));
	window.__err  = (v) => typeof v !== 'string' || /^\s*Error\b/i.test(v);
}, FOLDER);

await install();

const tool  = (name, args) => p.evaluate(([n, a]) => __tool(n, a), [name, args]);
const at    = (which, path) => p.evaluate(([w, x]) => __at(w, x), [which, path]);
const names = (which, path) => p.evaluate(([w, x]) => __names(w, x), [which, path]);
const put   = (which, path, body) => p.evaluate(([w, x, b]) => __put(w, x, b), [which, path, body]);
const toFolder  = () => p.evaluate(() => __d.mod.set_workspace_dir(__d.folder));
const toBrowser = () => p.evaluate(() => __d.mod.use_opfs_workspace());
const adopt = () => p.evaluate(() => __d.mod.adopt_folder_diamonds().then(JSON.parse));

// The escape the filename codec applies to a reserved byte (src/fsname.rs). Written
// out here rather than imported, so the verifier does not agree with the code under
// test by construction. It covers the names a mailbox produces — a Maildir file and a
// `.eml` draft — and not the codec's whole corpus: the rule for a name that already
// carries a `%` is asserted where the codec lives, in src/fsname.rs's own tests.
const RESERVED = '"*:<>?\\|';
const enc = (name) => name.split('').map((c) => {
	const b = c.charCodeAt(0);
	if (RESERVED.indexOf(c) > -1 || b < 0x20 || b === 0x7f) {
		return '%' + b.toString(16).toUpperCase().padStart(2, '0');
	}
	return c;
}).join('');
const dec = (name) => name.replace(/%([0-9A-F]{2})/g, (m, h) => {
	const c = String.fromCharCode(parseInt(h, 16));
	return (RESERVED.indexOf(c) > -1 || parseInt(h, 16) < 0x20 || parseInt(h, 16) === 0x7f) ? c : m;
});

// ── Mail written while a folder is open ─────────────────────────────────

await toFolder();
await tool('file_write', { path: BOX + '/' + MSG2, content: 'a message synced with a folder open' });

const wroteStore  = await names('opfs', BOX);
const wroteFolder = await names('folder', 'mail');
check('mail written with a folder open lands in the store',
	Array.isArray(wroteStore) && wroteStore.some((n) => dec(n) === MSG2),
	JSON.stringify(wroteStore));
check('and not one byte of it in the user\'s folder',
	wroteFolder === null, JSON.stringify(wroteFolder));
check('and the mail client reads it back through its own path',
	/a message synced with a folder open/.test(await tool('file_read', { path: BOX + '/' + MSG2 })),
	(await tool('file_read', { path: BOX + '/' + MSG2 })).slice(0, 60));

// The whole of the defect: closing the folder used to take the mailbox with it.
await toBrowser();
check('and it is still there once the folder is closed',
	/a message synced with a folder open/.test(await tool('file_read', { path: BOX + '/' + MSG2 })),
	(await tool('file_read', { path: BOX + '/' + MSG2 })).slice(0, 60));

// A second folder: the mailbox must not move again.
const OTHER = await p.evaluate(async () => {
	const h = await __d.root.getDirectoryHandle('standin-other', { create: true });
	__d.other = h;
	__d.mod.set_workspace_dir(h);
	return true;
});
check('and still there with a DIFFERENT folder open, which is where it used to go missing',
	OTHER && /a message synced with a folder open/.test(
		await tool('file_read', { path: BOX + '/' + MSG2 })),
	(await tool('file_read', { path: BOX + '/' + MSG2 })).slice(0, 60));
await toFolder();

// ── The user's own work still follows the folder ────────────────────────
//
// Without this the fix could be "pin everything to the sandbox", which passes
// every check above and destroys real-folder mode.

await tool('file_write', { path: 'src/main.rs',      content: 'fn main() {}' });
await tool('file_write', { path: 'mailbox.md',       content: 'my notes about mail' });
await tool('file_write', { path: 'mail-old/keep.eml', content: 'an archive of theirs' });
await tool('file_write', { path: 'src/mail/client.rs', content: 'their own mail client' });
check("the user's own file goes into the folder, as real-folder mode promises",
	(await at('folder', 'src/main.rs')) === 'fn main() {}' && (await at('opfs', 'src/main.rs')) === null,
	'folder: ' + JSON.stringify(await at('folder', 'src/main.rs')));
check('a path that only resembles the mailbox is still the user\'s work',
	(await at('folder', 'mailbox.md')) === 'my notes about mail'
		&& (await at('folder', 'mail-old/keep.eml')) === 'an archive of theirs'
		&& (await at('folder', 'src/mail/client.rs')) === 'their own mail client'
		&& (await at('opfs', 'mailbox.md')) === null
		&& (await at('opfs', 'mail-old/keep.eml')) === null,
	'mailbox.md in folder: ' + JSON.stringify(await at('folder', 'mailbox.md'))
		+ ', in store: ' + JSON.stringify(await at('opfs', 'mailbox.md')));

// ── What an earlier build left in the folder ────────────────────────────
//
// The state a user of yesterday's build is actually in: their mailbox sitting in
// their project, under the ESCAPED name a real folder forced on it, and a draft
// an agent wrote that exists nowhere else at all.

const FOLDER_MSG = 'mail/' + ADDR + '/INBOX/cur/' + enc(MSG);
const DRAFT      = 'mail/' + ADDR + '/drafts/draft-7.eml';
const HELD       = 'mail/' + ADDR + '/drafts/draft-9.eml';
await put('folder', FOLDER_MSG, RAW);
await put('folder', DRAFT, 'From: ' + ADDR + '\r\nSubject: written by the daimon\r\n\r\nplease send\r\n');
await put('folder', HELD,  'From: ' + ADDR + '\r\nSubject: the folder\'s older copy\r\n\r\nold\r\n');
// The same draft, already in the store and edited since. The store's copy must win.
await tool('file_write', { path: HELD, content: 'From: ' + ADDR + '\r\nSubject: edited here\r\n\r\nnew\r\n' });
// A directory of the user's that happens to live under `mail/`: an archive, a
// module, a year's correspondence. It is not a mailbox and is not ours to copy.
await put('folder', 'mail/archive-2019/letter.txt', 'the user\'s own correspondence');

const report = await adopt();
check('the migration took the two files that were missing and not the one that was not',
	report.mail && report.mail.copied === 2 && (report.mail.left || []).length === 0,
	JSON.stringify(report.mail));
check('a directory of the user\'s under mail/ is left alone',
	(await at('opfs', 'mail/archive-2019/letter.txt')) === null
		&& (await at('folder', 'mail/archive-2019/letter.txt')) === "the user's own correspondence",
	JSON.stringify(await at('opfs', 'mail/archive-2019/letter.txt')));

const readBack = await tool('file_read', { path: BOX + '/' + MSG });
check('a message that was only in the folder now reads under the name mail asks for',
	/in the folder/.test(readBack), readBack.slice(0, 80));
check('and the draft the daimon wrote came with it',
	/written by the daimon/.test(await tool('file_read', { path: DRAFT })),
	(await tool('file_read', { path: DRAFT })).slice(0, 80));
check('a draft already in the store was not overwritten by the folder\'s older copy',
	/edited here/.test(await tool('file_read', { path: HELD })),
	(await tool('file_read', { path: HELD })).slice(0, 80));
check('and nothing at all was deleted from the folder',
	(await at('folder', FOLDER_MSG)) === RAW
		&& /written by the daimon/.test(await at('folder', DRAFT))
		&& /older copy/.test(await at('folder', HELD)),
	'message: ' + JSON.stringify((await at('folder', FOLDER_MSG) || '').slice(0, 20)));

// ── One message, one name ───────────────────────────────────────────────
//
// The codec escapes a name a filesystem refuses and prefers an unescaped name
// that is already there (`disk_name`, src/wasm/opfs.rs). A migration that wrote
// the escaped spelling where an unescaped one already sat — or the reverse —
// would leave the same message on disk twice, and the panel would show it twice.

const inbox = await names('opfs', BOX);
const spellings = {};
(inbox || []).forEach((n) => { (spellings[dec(n)] = spellings[dec(n)] || []).push(n); });
const doubled = Object.keys(spellings).filter((k) => spellings[k].length > 1);
check('no message exists under two spellings of its own name',
	Array.isArray(inbox) && doubled.length === 0,
	JSON.stringify(spellings));
check('and every message in the store answers to the name the mail client uses',
	Array.isArray(inbox) && inbox.length === Object.keys(spellings).length
		&& [MSG, MSG2].every((m) => Object.keys(spellings).indexOf(m) > -1),
	JSON.stringify(Object.keys(spellings)));

// ── Twice is once ───────────────────────────────────────────────────────

const before = JSON.stringify(await names('opfs', BOX));
const second = await adopt();
const after  = JSON.stringify(await names('opfs', BOX));
check('running the migration again brings nothing home',
	second.mail && second.mail.copied === 0, JSON.stringify(second.mail));
check('and leaves the store exactly as it was', before === after, before + ' | ' + after);
check('and the message still reads the same afterwards',
	/in the folder/.test(await tool('file_read', { path: BOX + '/' + MSG })),
	(await tool('file_read', { path: BOX + '/' + MSG })).slice(0, 60));

// A run interrupted halfway is a run that copied some and not others, which is
// the state above with one file removed from the store. It must complete, and
// must not touch the ones already home.
await p.evaluate(async ([box, msg]) => {
	const parts = (box + '/' + msg).split('/');
	let cur = __d.root;
	for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i]);
	// Whichever spelling is on disk: the point is that the file is gone.
	for await (const [name] of cur.entries()) {
		if (name.indexOf(parts[parts.length - 1].split(':')[0]) === 0) await cur.removeEntry(name);
	}
}, [BOX, MSG]);
const third = await adopt();
check('a run interrupted halfway completes on the next activation',
	third.mail && third.mail.copied === 1
		&& /in the folder/.test(await tool('file_read', { path: BOX + '/' + MSG })),
	JSON.stringify(third.mail));

// ── The common case: no folder, ever ────────────────────────────────────

await toBrowser();
const none = await adopt();
check('with no folder open the migration looks at nothing and says so',
	none.folder === false && none.mail && none.mail.copied === 0 && none.mail.left.length === 0,
	JSON.stringify(none));
const settled = (await names('opfs', BOX) || []).map(dec).sort();
check('and mail written in the sandbox stays exactly where it always was',
	(await tool('file_read', { path: BOX + '/' + MSG2 })).indexOf('folder open') > -1
		&& settled.join('|') === [MSG, MSG2].sort().join('|'),
	JSON.stringify(settled));

// ── And through the mail client's own idea of where a mailbox is ────────
//
// Everything above spelled the path itself. `folderDir` is what the panel and
// the sync use, and if it ever stops agreeing with the engine's rule the
// messages go back to following the folder with nothing going red.

const viaPanel = await p.evaluate(async ({ addr }) => {
	if (!window.DaimondMail) return null;
	localStorage.setItem('daimond-mail', JSON.stringify({
		accounts: [{ address: addr, host: 'imap.example.com', port: 993, user: addr, folder: 'INBOX' }],
		sel: addr,
	}));
	// `reload` reads the record and then redraws; the panel has never been opened here,
	// so a redraw that finds no elements is not what is being asked about.
	try { DaimondMail.reload(); } catch (e) { /* the record is loaded either way */ }
	return DaimondMail.folderDir(addr, 'INBOX');
}, { addr: ADDR });
await toFolder();
if (viaPanel) {
	await tool('file_write', { path: viaPanel + '/cur/probe', content: 'through the panel\'s own path' });
}
check("the mail client's own path for a mailbox is in the store, not the folder",
	!!viaPanel
		&& (await at('opfs', viaPanel + '/cur/probe')) === "through the panel's own path"
		&& (await at('folder', viaPanel + '/cur/probe')) === null,
	String(viaPanel));

// A resource the browser could not load is the dev stack, not the page: no
// gateway runs here, so its probes answer 401 or 502 and neither is a throw.
const noise = s.errs.filter((e) =>
	!/favicon|ERR_ABORTED|net::ERR|Failed to load resource/i.test(e));
check('the page threw nothing along the way', noise.length === 0, noise.slice(0, 3).join(' | '));

console.log('\n  ' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) console.log('  failed: ' + bad.join(', '));
await s.close();
process.exit(bad.length ? 1 : 0);
