// verify_chatworkspace.mjs — a chat's footer says two different things, and only
// one of them is a permission.
//
// The paperclip used to carry Note and Read as if they were the whole story. They
// are not, and they never were two alternatives to a third thing: an attachment
// carries TWO INDEPENDENT marks.
//
//   * NOTE | READ is a COST decision about what goes into the turn's prompt. Note
//     names a path so the user need not type it; Read quotes the contents. They
//     are mutually exclusive, they are both reading, and NEITHER GRANTS ANY REACH.
//   * IN THE WORKSPACE is the other one, and it is the blast radius: the folders
//     this chat may read and change. A path can be in the workspace AND Read.
//
// So the footer is two groups, workspace first, and the difference between how
// they are DRAWN is part of the claim. The workspace is one bounded box with a
// rail down its edge, because its meaning is collective -- take a folder out and
// the fence shrinks. The attachments below are a plain list of individuals.
//
// THE EMPTY STATE IS THE POINT. The fence exists from the moment a folder is
// marked, so the group is drawn when it holds nothing and says, in words, that the
// chat can reach nothing of the user's. The crystal footer hid itself at zero
// until 4216383 and took the `+` inside it out of reach in exactly the state that
// control exists for; this asserts that lesson rather than rediscovering it.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged file to the real page through `page.route`; the run is then
// expected to FAIL, and a break whose anchor does not match aborts rather than
// passing quietly.
//
//   node dev/verify_chatworkspace.mjs --break hideatzero  # 1 fails: the empty group hides
//   node dev/verify_chatworkspace.mjs --break attachmarks # 2 fails: attaching grants
//   node dev/verify_chatworkspace.mjs --break inertmark   # 3 fails: the mark does nothing
//   node dev/verify_chatworkspace.mjs --break notegrants  # 4 fails: Note becomes a grant
//   node dev/verify_chatworkspace.mjs --break costclears  # 5 fails: the two marks are one
//   node dev/verify_chatworkspace.mjs --break bothgroups  # 6 fails: a folder is drawn twice
//   node dev/verify_chatworkspace.mjs --break filemark    # 7 fails: a file offers the mark
//   node dev/verify_chatworkspace.mjs --break nohydrate   # 8 fails: the mark dies on reload
//   node dev/verify_chatworkspace.mjs --break nostamp     # 8 fails: the mark never reaches disk
//   node dev/verify_chatworkspace.mjs --break wscapless   # 9 fails: the box eats the composer
//   node dev/verify_chatworkspace.mjs --break readfetch   # 10 fails: Read only asks
//   node dev/verify_chatworkspace.mjs --break wsrestamp   # 11 fails: a read normalises the field
//   node dev/verify_chatworkspace.mjs --break rendertouch # 12 fails: a redraw restamps the parcel
//   node dev/verify_chatworkspace.mjs --break pickernomark # 13 fails: the group's + only attaches
//   node dev/verify_chatworkspace.mjs                     # and then, clean
//
//   bash dev/world.sh 5 --up
//   eval "$(bash dev/world.sh 5 --env)"
//   node dev/verify_chatworkspace.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, newChat, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The footer hides itself while there is nothing in it -- which is what the
	// crystal footer did until 4216383, and it takes the `+` down with it. The
	// state that most needs saying becomes the one state nothing is said in.
	hideatzero: {
		file: 'js/daimond.js',
		find: `		var held = chatAttachList(f.id);`,
		with: `		var held = chatAttachList(f.id);
		if (!held.length) { box.innerHTML = ''; box.style.display = 'none'; return; }`,
	},
	// Attaching a folder marks it into the workspace by itself. Plausible -- it is
	// what the old code effectively did, since the fence was built from the whole
	// attachment list -- and it carries the old meaning through under a new name.
	attachmarks: {
		file: 'js/daimond.js',
		find: `		list[list.length - 1].ws = false;`,
		with: `		list[list.length - 1].ws = !!dir;`,
	},
	// The control is drawn, is pressable, and does nothing. Two of lane 4's four
	// defects on 2026-08-12 were exactly this, and no check on internal state can
	// see it: this one goes through a real click.
	inertmark: {
		file: 'js/daimond.js',
		find: `					on:      function () { chatAttachSetWorkspace(f.id, a.ref, !a.ws); },`,
		with: `					on:      function () { /* the press does nothing */ },`,
	},
	// The fence is built from everything attached, so Note -- which costs a few
	// tokens and is meant to grant nothing -- hands over read and write access to
	// the path it names.
	notegrants: {
		file: 'js/daimond.js',
		find: `			.filter(function (a) { return !!a.ws; })`,
		with: `			.filter(function (a) { return true; })`,
	},
	// The two marks are one field after all: choosing the cost clears the
	// permission. This is what a single three-valued state would do, and it is the
	// design mistake the orthogonality exists to prevent.
	costclears: {
		file: 'js/daimond.js',
		find: `		rec.state = state;
		persistChats(); attachChanged();`,
		with: `		rec.state = state; rec.ws = false;
		persistChats(); attachChanged();`,
	},
	// The attachment group draws everything the chat holds rather than what is not
	// already in the workspace, so a marked folder appears in both groups -- and
	// the reader cannot tell whether that is one folder or two.
	bothgroups: {
		file: 'js/daimond.js',
		find: `			at.appendChild(attachBody(noted.map(toTile)));`,
		with: `			at.appendChild(attachBody(held.map(toTile)));`,
	},
	// A FILE is offered the workspace mark. The workspace is a union of folders; a
	// fence around one file is a fence around its folder wearing a smaller name,
	// and offering it invites a mark that means something else than it says.
	filemark: {
		file: 'js/daimond.js',
		find: `				actions: a.dir ? [{`,
		with: `				actions: true ? [{`,
	},
	// BOTH OF THESE WERE REAL, and both were found by the check they now break.
	//
	// `nohydrate`: the loader that turns a stored chat back into a live one never
	// carried `holds`. It was written out faithfully and read back as nothing, and
	// the first save after boot then wrote the empty list over the user's own.
	nohydrate: {
		file: 'js/daimond.js',
		find: `			// workspace mark rides here, so it would have taken the fence with it.
			holds: Array.isArray(c.holds) ? c.holds : [],`,
		with: `			// the holdings are dropped on the way in`,
	},
	// `nostamp`: the store writes a record only when its stamp moves, and the stamp
	// was `updatedAt : messages : session`. Attaching, flipping Note to Read and
	// marking a folder in move none of those, so the put never happened -- while
	// the in-memory mirror, which is what every reader reads, said it had.
	nostamp: {
		file: 'js/daimond.js',
		find: `				+ ':' + JSON.stringify(c.holds || []);`,
		with: `				;`,
	},
	// The workspace box has no cap, so it grows with every folder marked and
	// pushes the composer down the screen -- the failure `--attach-cap` was
	// measured to end, arriving again through the group beside it.
	wscapless: {
		file: 'css/app.css',
		find: `	max-height: calc(var(--ws-cap) * var(--attach-row-h) + var(--attach-peek));
	overflow-y: auto; scrollbar-gutter: stable; scrollbar-width: thin; }`,
		with: `	overflow-y: auto; }`,
	},
	// Read goes back to TELLING THE MODEL to open the file. Now that a chat is
	// fenced to its workspace, that is an instruction the app itself refuses
	// unless the path is also marked in -- so the first Read a user presses
	// produces a refusal the app caused.
	readfetch: {
		file: 'js/daimond.js',
		find: `		if (text && f.kind === 'chat') text += await attachReadBodies(list);`,
		with: `		if (text && f.kind === 'chat') text += '';`,
	},
	// The `+` in the workspace group's own header attaches the folder and does not
	// mark it in -- so the sentence beside it, which says to mark a folder in with
	// that control, is half true and the fence does not move.
	pickernomark: {
		file: 'js/daimond.js',
		find: `			if (mark && picked[paths[i]].dir) {`,
		with: `			if (false && picked[paths[i]].dir) {`,
	},
	// The render hangs a stamp on every holding it draws -- "when this was last
	// shown", say. Plausible bookkeeping, and it is the exact shape of the bug
	// that put a paired iPhone into an endless sync loop: two collects with a
	// redraw between them no longer agree, so the device always has something to
	// send and the far end always has something to send back.
	rendertouch: {
		file: 'js/daimond.js',
		find: `		held.forEach(function (a) { (a.ws ? marked : noted).push(a); });`,
		with: `		held.forEach(function (a) { a.seen = Date.now(); (a.ws ? marked : noted).push(a); });`,
	},
	// The render normalises `ws` back onto the record it just read. Harmless
	// looking, and it is how the sync parcel stops being a fixed point: a record
	// that arrives from another device without the field gains one here, so the
	// next collect differs from what was applied and the two devices push at each
	// other for ever.
	wsrestamp: {
		file: 'js/daimond.js',
		find: `		held.forEach(function (a) { (a.ws ? marked : noted).push(a); });`,
		with: `		held.forEach(function (a) { a.ws = !!a.ws; (a.ws ? marked : noted).push(a); });`,
	},
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

let ok = 0, bad = 0;
const check = (name, pass, detail) => {
	if (pass) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
/// Each section owns its failure. One shared `try` let lane 4's first defect
/// throw and left three later checks never seen to fail at all.
const section = async (name, fn) => {
	try { await fn(); }
	catch (e) { check(`${name} ran to the end`, false, String(e && e.message || e)); }
};

// Not signed in and not connected by `open` itself: the break has to be routed
// before the app is ever loaded, and signing in afterwards is what gives the
// composer -- and therefore the footer above it -- a page to be drawn on.
const s = await open({ name: 'chatworkspace', signIn: false, connect: false });
const { page } = s;

/// Serve one deliberately damaged file in place of the real one, before the app
/// is loaded. Routes outlive a reload, so this is installed once.
async function installBreak() {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	const type = /\.css$/.test(spec.file) ? 'text/css' : 'application/javascript';
	await page.route('**/' + spec.file, r => r.fulfill({ status: 200, contentType: type, body }));
}
await installBreak();
await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
const { signInAs, connectMock } = await import('./harness.mjs');
await signInAs(s, 'chatworkspace');
await connectMock(s);
await page.waitForTimeout(1500);

const T = (k, v) => page.evaluate(([k, v]) => DaimondI18n.t(k, v || undefined), [k, v || null]);

// The files and folders a person would have: two folders to mark, one file to
// quote. Written through the tool door, which is how a turn would have made them.
const FILE_BODY = '# Spec\nthe sentence that proves the quote is the FILE\n';
await page.evaluate(async (body) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool('file_write', JSON.stringify({ path: 'papers/spec.md', content: body }));
	await app.run_tool('file_write', JSON.stringify({ path: 'books/draft.md', content: '# Draft\n' }));
}, FILE_BODY);

await newChat(s);
await page.waitForTimeout(600);
const focus = await page.evaluate(() => window.DaimondAttach.focus());
const chatId = focus && focus.id;
check('a chat is in focus', !!chatId && focus.kind === 'chat', JSON.stringify(focus));

/// What the footer is showing, by GROUP. Never a bare `#chat-attachments`
/// selector: with two groups on screen, the first match in DOM order is the
/// workspace's, and a check that meant the attachments would silently be asking
/// the wrong one.
const footer = () => page.evaluate(() => {
	const g = (sel) => [...document.querySelectorAll(sel)].map(r => ({
		path:  (r.querySelector('.arte-open') || {}).textContent || '',
		state: (r.querySelector('.attach-state') || {}).textContent || '',
		ws:    (r.querySelector('.attach-ws') || {}).getAttribute
			? r.querySelector('.attach-ws').getAttribute('aria-pressed') : null,
		hasWsBtn: !!r.querySelector('.attach-ws'),
	}));
	const box = document.getElementById('chat-attachments');
	return {
		shown:   !!box && box.style.display !== 'none',
		title:   ((box || document).querySelector('.ws-group .attach-group-title') || {}).textContent || '',
		atTitle: ((box || document).querySelector('.at-group .attach-group-title') || {}).textContent || '',
		empty:   ((box || document).querySelector('.ws-empty') || {}).textContent || '',
		add:     !!(box || document).querySelector('.ws-group [data-act="attach-add"]'),
		ws:      g('#chat-attachments .ws-group .arte-row'),
		at:      g('#chat-attachments .at-group .arte-row'),
	};
});
const scopeOf = () => page.evaluate((id) => window.DaimondAttach.chatScope(id), chatId);

// ── 1. THE EMPTY STATE, which is the state that most needs saying ──────
await section('the empty state', async () => {
	const f = await footer();
	check('WITH NOTHING MARKED, THE WORKSPACE GROUP IS ON SCREEN',
		f.shown === true && !!f.title, JSON.stringify({ shown: f.shown, title: f.title }));
	// The app's OWN words for this idea, reused rather than coined again: the
	// same key the account strip and the guide say.
	check('and it is headed with the app’s existing words for the workspace',
		f.title === await T('astat.workspace_browser'), `${JSON.stringify(f.title)} vs the catalogue`);
	const want = await T('attach.ws_empty');
	check('and it says, in words, that the chat can reach nothing of the user’s',
		f.empty === want && /reach nothing/.test(want), JSON.stringify(f.empty));
	check('with no attachment group beside it, because there are no attachments',
		f.at.length === 0 && f.ws.length === 0, JSON.stringify({ ws: f.ws.length, at: f.at.length }));
	// The lesson of 4216383: the control that ends this state must be reachable
	// FROM this state.
	check('and the control that marks the first folder is inside that group',
		f.add === true, String(f.add));
	const sc = await scopeOf();
	check('and the fence is handed nothing at all', Array.isArray(sc) && sc.length === 0,
		JSON.stringify(sc));
});
await shot(s, 'chatworkspace-1-empty');

// ── 2. Attaching is not marking ────────────────────────────────────────
await section('attaching', async () => {
	await page.evaluate((id) => {
		window.DaimondAttach.chatToggle(id, 'dir:[browser]papers', true, 'papers');
		window.DaimondAttach.chatToggle(id, 'file:[browser]papers/spec.md', false, 'papers/spec.md');
	}, chatId);
	await page.waitForTimeout(600);
	const f = await footer();
	check('ATTACHING A FOLDER PUTS IT IN FRONT OF THE MODEL, not in the workspace',
		f.ws.length === 0 && f.at.some(r => r.path === 'papers'), JSON.stringify(f.at));
	check('and the attachment group says what it is, in the app’s words',
		f.atTitle === await T('attach.group_prompt'), JSON.stringify(f.atTitle));
	check('the folder’s tile carries BOTH controls: a cost, and the mark',
		f.at.some(r => r.path === 'papers' && r.state === 'Note' && r.ws === 'false'),
		JSON.stringify(f.at.find(r => r.path === 'papers')));
	check('a FILE is offered no workspace mark, because a workspace is folders',
		f.at.some(r => r.path === 'papers/spec.md' && !r.hasWsBtn),
		JSON.stringify(f.at.find(r => r.path === 'papers/spec.md')));
	const sc = await scopeOf();
	check('AND NOTHING ATTACHED HAS WIDENED THE FENCE', sc.length === 0, JSON.stringify(sc));
});

// ── 3. The mark, driven as a person drives it ──────────────────────────
await section('the mark', async () => {
	// A REAL CLICK on the pill of the row for `papers`. Found by its path, not by
	// position: `.attach-ws` first-in-DOM would be whichever row happens to be
	// drawn first.
	const clicked = await page.evaluate(() => {
		const row = [...document.querySelectorAll('#chat-attachments .at-group .arte-row')]
			.find(r => (r.querySelector('.arte-open') || {}).textContent === 'papers');
		const btn = row && row.querySelector('.attach-ws');
		if (!btn) return 'no control';
		btn.click();
		return 'clicked';
	});
	check('the folder’s workspace control is there to press', clicked === 'clicked', clicked);
	await page.waitForTimeout(700);
	const f = await footer();
	check('PRESSING IT MOVES THE FOLDER INTO THE WORKSPACE GROUP',
		f.ws.some(r => r.path === 'papers'), JSON.stringify({ ws: f.ws, at: f.at }));
	check('and it appears ONCE, not in both groups',
		f.at.every(r => r.path !== 'papers'), JSON.stringify(f.at));
	check('carrying both marks: the cost it had, and the mark it now has',
		f.ws.some(r => r.path === 'papers' && r.state === 'Note' && r.ws === 'true'),
		JSON.stringify(f.ws.find(r => r.path === 'papers')));
	const sc = await scopeOf();
	check('AND THE FENCE THE ENGINE IS HANDED IS NOW THAT FOLDER',
		sc.length === 1 && sc[0] === 'papers', JSON.stringify(sc));
});
await shot(s, 'chatworkspace-2-marked');

// ── 3b. The `+` in that group means what its position says ────────────
await section('the group’s own +', async () => {
	// The empty state tells the reader to mark a folder in "with the paperclip, or
	// with + above". So the `+` that sits in the workspace group marks in what it
	// adds -- driven here as a person drives it, through the dialog, because a
	// control that opens and then quietly does something else is exactly what two
	// of lane 4's defects were.
	await page.click('#chat-attachments .ws-group [data-act="attach-add"]', { force: true });
	await page.waitForSelector('.attach-pick-row', { timeout: 10000 });
	const ticked = await page.evaluate(() => {
		const row = [...document.querySelectorAll('.attach-pick-row')]
			.find(r => /books/.test(r.querySelector('.attach-pick-name').textContent));
		if (!row) return 'no books row';
		row.querySelector('input').click();
		return 'ticked';
	});
	check('the picker lists the folder to be marked in', ticked === 'ticked', ticked);
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(1000);
	const f = await footer();
	check('THE GROUP’S OWN `+` MARKS THE FOLDER IN, as the sentence beside it says',
		f.ws.some(r => r.path === 'books' && r.ws === 'true'), JSON.stringify(f.ws));
	const sc = await scopeOf();
	check('and the fence is both folders now', sc.indexOf('books') >= 0 && sc.indexOf('papers') >= 0,
		JSON.stringify(sc));
});

// ── 4. The two marks are independent ───────────────────────────────────
await section('independence', async () => {
	// Read on the marked folder: the cost changes, the permission must not.
	await page.evaluate(() => {
		const row = [...document.querySelectorAll('#chat-attachments .ws-group .arte-row')]
			.find(r => (r.querySelector('.arte-open') || {}).textContent === 'papers');
		row.querySelector('.attach-state').click();
	});
	await page.waitForTimeout(600);
	let f = await footer();
	check('CHANGING THE COST LEAVES THE PERMISSION WHERE IT WAS',
		f.ws.some(r => r.path === 'papers' && r.state === 'Read' && r.ws === 'true'),
		JSON.stringify(f.ws.find(r => r.path === 'papers')));
	let sc = await scopeOf();
	// The MARKED SET, unchanged by a cost decision. Asserted as membership rather
	// than as a list of one: the `+` above marked a second folder in, and a check
	// that counted would be measuring that instead of what it says it measures.
	check('and the fence has not moved', sc.indexOf('papers') >= 0, JSON.stringify(sc));
	// And back, so the rest of the run reads a Note folder.
	await page.evaluate(() => {
		const row = [...document.querySelectorAll('#chat-attachments .ws-group .arte-row')]
			.find(r => (r.querySelector('.arte-open') || {}).textContent === 'papers');
		row.querySelector('.attach-state').click();
	});
	await page.waitForTimeout(600);
	f = await footer();
	check('and the cost goes back without disturbing it either',
		f.ws.some(r => r.path === 'papers' && r.state === 'Note' && r.ws === 'true'),
		JSON.stringify(f.ws.find(r => r.path === 'papers')));
});

// ── 5. Read quotes the file rather than asking for it ──────────────────
await section('read quotes', async () => {
	// papers/spec.md is attached and NOT marked in, which is the case the fence
	// makes interesting: the chat may quote it and may not open it.
	await page.evaluate(() => {
		const row = [...document.querySelectorAll('#chat-attachments .at-group .arte-row')]
			.find(r => (r.querySelector('.arte-open') || {}).textContent === 'papers/spec.md');
		row.querySelector('.attach-state').click();
	});
	await page.waitForTimeout(900);
	const val = await page.$eval('#chat-input', e => e.value);
	check('READ PUTS THE FILE’S OWN WORDS IN THE COMPOSER',
		val.indexOf('the sentence that proves the quote is the FILE') >= 0,
		JSON.stringify(val.slice(0, 160)));
	// The tool door numbers every line; the raw door does not. Quoting the tool's
	// answer would put a gutter down the user's file, which this app has shipped
	// twice before.
	check('and quotes the file, not the tool’s numbered view of it',
		!/^\s*1\t/m.test(val), JSON.stringify(val.slice(0, 160)));
	const sc = await scopeOf();
	check('while READ STILL GRANTS NOTHING: the file is not in the fence',
		sc.indexOf('papers/spec.md') < 0, JSON.stringify(sc));
});
await shot(s, 'chatworkspace-3-read-quoted');

// ── 6. The mark is written down ────────────────────────────────────────
await section('persistence', async () => {
	await page.reload({ waitUntil: 'domcontentloaded' });
	// A reload always locks -- identity.js holds the wrapping key in memory and
	// nowhere else -- so the passphrase goes in again before anything can be read.
	await signInAs(s, 'chatworkspace');
	await page.waitForTimeout(1800);
	const held = await page.evaluate((id) => (window.DaimondAttach.chatList(id) || [])
		.map(a => ({ path: a.path, ws: !!a.ws, state: a.state })), chatId);
	check('THE MARK SURVIVES A RELOAD, because it lives on the chat’s own record',
		held.some(a => a.path === 'papers' && a.ws === true), JSON.stringify(held));
	check('and so does the cost beside it',
		held.some(a => a.path === 'papers/spec.md' && a.state === 'read' && a.ws === false),
		JSON.stringify(held));
});

// ── 7. The parcel is still a fixed point ───────────────────────────────
await section('the parcel', async () => {
	// A parcel from ANOTHER DEVICE, whose records predate the field: apply it,
	// collect, and the bytes must come back. A render that normalised `ws` onto
	// what it read would fail here and nowhere else -- and that is the shape of
	// the bug that put a paired iPhone into an endless sync loop.
	// AWAITED, all of them. `collectSync` is async, and a check that compared two
	// unawaited promises compared `undefined` with `undefined` and passed while
	// proving nothing -- which is how five verifiers went green for the wrong
	// reason in one night here.
	//
	// A HOLDING WITHOUT THE FIELD is what makes this bite: a record written before
	// `ws` existed, or one that arrived from a device that has not been updated.
	// A render that normalised the field onto what it read would gain a byte
	// between two collects, and two devices would then push at each other for ever.
	const same = await page.evaluate(async (id) => {
		const one = window.DaimondAttach.chatList(id)[0];
		delete one.ws;
		// STRINGIFIED THE MOMENT IT IS COLLECTED. A parcel carries the holdings BY
		// REFERENCE, so two parcels held as objects and compared at the end are two
		// views of one array: every later mutation appears in both, and the
		// comparison can only ever say they are equal. Measured -- a break that
		// stamped every holding on every redraw passed this check until the
		// stringify moved here.
		const j = (p) => JSON.stringify(p.chats || []);
		const p1 = await DaimondCore.collectSync();
		const mine = (p1.chats || []).find(c => c.id === id) || {};
		const fieldless = (mine.holds || []).some(h => !('ws' in h));
		const holds = (p1.chats || []).reduce((n, c) => n + (c.holds || []).length, 0);
		const s1 = j(p1);
		// A redraw, which is the moment a normalising or stamping read would happen.
		window.DaimondAttach.render();
		await new Promise(r => setTimeout(r, 400));
		const s2 = j(await DaimondCore.collectSync());
		// And the fixed point itself: apply what this device would send, and it
		// must still send exactly that.
		await DaimondCore.applySync(JSON.parse(JSON.stringify(p1)));
		await new Promise(r => setTimeout(r, 500));
		const s3 = j(await DaimondCore.collectSync());
		return {
			holds: holds, fieldless: fieldless,
			render: s1 === s2, fixed: s1 === s3,
			a: s1.slice(-220), b: s2.slice(-220), c: s3.slice(-220),
		};
	}, chatId);
	check('A HOLDING WITHOUT THE FIELD IS LEFT WITHOUT IT: nothing normalises on read',
		same.holds > 0 && same.fieldless === true, JSON.stringify({ holds: same.holds, fieldless: same.fieldless }));
	check('DRAWING THE FOOTER DOES NOT CHANGE WHAT THIS DEVICE WOULD SEND',
		same.render === true, same.render ? '' : `before ${same.a}\n         after  ${same.b}`);
	check('AND APPLYING ITS OWN PARCEL LEAVES IT THE SAME BYTES (the fixed point)',
		same.fixed === true, same.fixed ? '' : `sent ${same.a}\n         got  ${same.c}`);
});

// ── 8. The composer stays put however much is marked ───────────────────
await section('the cap', async () => {
	const chat2 = await page.evaluate(() => window.DaimondAttach.focus());
	const id = (chat2 && chat2.id) || chatId;
	const geom = () => page.evaluate(() => {
		const b = document.querySelector('#chat-attachments .ws-body');
		const bar = document.querySelector('.chat-input-bar');
		const r = el => el ? el.getBoundingClientRect() : { height: 0, top: 0 };
		return {
			box: Math.round(r(b).height), inside: b ? b.scrollHeight : 0,
			rows: document.querySelectorAll('#chat-attachments .ws-group .arte-row').length,
			bar: Math.round(r(bar).top),
		};
	});
	// Marked, and UNREACHABLE -- a folder on a machine whose workspace is not the
	// open one. Two things at once: it proves a mark that cannot be reached is
	// still shown in the workspace group rather than silently dropped (§7), and it
	// keeps the composer's own text out of the measurement. A reachable path is
	// named in the generated prefix, the prefix is in the textarea, and the
	// textarea grows -- so the composer would move for a reason that is the user's
	// own text rather than the footer's doing.
	const mark = async (from, to) => {
		for (let i = from; i < to; i++) {
			await page.evaluate(([id, i]) => {
				const ref = `dir:[machine:elsewhere]bulk-${i}`;
				window.DaimondAttach.chatToggle(id, ref, true, `bulk-${i}`);
				window.DaimondAttach.chatWs(id, ref, true);
			}, [id, i]);
		}
		await page.waitForTimeout(500);
		return geom();
	};
	// AT the cap and then well past it. Measuring from BELOW the cap would compare
	// a box still growing with one that has stopped, and the difference would be
	// the cap doing its job rather than the failure this is looking for.
	const atTwo = await mark(0, 6);
	const atMany = await mark(6, 15);
	// MEASURED, not merely equal. Two absences are equal to each other, and a
	// footer that was not drawn at all would otherwise pass both checks below
	// with nothing on screen -- which is how a verifier passes for the wrong
	// reason.
	check('fifteen folders are marked into the workspace, in a box that is drawn',
		atMany.rows >= 15 && atTwo.box > 0 && atTwo.bar > 0, JSON.stringify({ atTwo, atMany }));
	check('and the box was already at its cap with six of them',
		atTwo.inside > atTwo.box + 10, `${atTwo.inside}px of rows in a ${atTwo.box}px box`);
	check('PAST THE CAP THE WORKSPACE BOX STOPS GROWING',
		atMany.box > 0 && atMany.box === atTwo.box,
		`${atTwo.box}px at 6 rows, ${atMany.box}px at 15`);
	check('AND THE COMPOSER HAS NOT MOVED', atMany.bar > 0 && atMany.bar === atTwo.bar,
		`${atTwo.bar} at 6 rows, ${atMany.bar} at 15`);
	check('and the box scrolls, so the rows past the fold can still be reached',
		atMany.inside > atMany.box + 10, `${atMany.inside}px of rows in a ${atMany.box}px box`);
	// A mark made in another workspace is still a mark: it is shown, saying where
	// it lives, rather than vanishing into an empty box the user cannot account for.
	const strays = await page.evaluate(() => [...document.querySelectorAll(
		'#chat-attachments .ws-group .arte-row.shut .arte-why')].length);
	check('and an unreachable mark is shown in the workspace, saying where it lives',
		strays > 0, String(strays));
	await shot(s, 'chatworkspace-4-capped');
	// Off again, so the shots below are of a footer a person would recognise.
	for (let i = 0; i < 15; i++) {
		await page.evaluate(([id, i]) => window.DaimondAttach.chatToggle(
			id, `dir:[machine:elsewhere]bulk-${i}`, true, `bulk-${i}`), [id, i]);
	}
	await page.waitForTimeout(400);
});

// ── The look, at both widths ───────────────────────────────────────────
await section('the look', async () => {
	await page.setViewportSize({ width: 360, height: 780 });
	await page.waitForTimeout(900);
	await shot(s, 'chatworkspace-5-phone');
	const fits = await page.evaluate(() => {
		const box = document.getElementById('chat-attachments');
		const bar = document.querySelector('.chat-input-bar');
		if (!box || !bar) return null;
		const b = bar.getBoundingClientRect();
		return { bar: Math.round(b.top), h: Math.round(b.height), win: window.innerHeight,
			footer: Math.round(box.getBoundingClientRect().height) };
	});
	check('ON A PHONE THE COMPOSER IS STILL ON SCREEN under the two groups',
		!!fits && fits.h > 0 && fits.footer > 0 && fits.bar + fits.h <= fits.win + 1,
		JSON.stringify(fits));
	await page.setViewportSize({ width: 1500, height: 950 });
	await page.waitForTimeout(700);
});

// 502s are the local gateway proxy (/api) not running in this world -- a world
// is the browser tiers only, as dev/world.sh says in as many words. The same
// exclusion is in verify_attachfocus, verify_compact and verify_credits.
const errs = errors(s).filter(e => !/502 \(Bad Gateway\)/.test(e));
check('nothing threw along the way', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`\n${ok} ok, ${bad} failed`);
if (BREAK) {
	console.log(bad ? `break '${BREAK}' correctly failed ${bad} check(s)`
		: `break '${BREAK}': NOTHING FAILED, so the checks above prove nothing`);
	await s.close();
	process.exit(bad ? 0 : 1);		// a break MUST fail something
}
await s.close();
process.exit(bad ? 1 : 0);
