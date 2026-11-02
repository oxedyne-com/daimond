// gateway: none
// verify_chatworkspace.mjs — a chat's footer: what it holds, what each holding
// costs, and the `+` that adds to it, drawn in every state including the empty one.
//
// RE-AIMED 2026-11-02 (TRAIN-15b) to what the page draws now. The workspace MARK
// is gone: no `Workspace` pill on a folder, no `DaimondAttach.chatScope`, and so no
// fence built from the footer (D-20261031-11: neither Note nor Read grants anything).
// The sections that asserted the mark ('the mark', 'independence' of the mark from
// the cost) and their breaks (attachmarks, inertmark, notegrants, filemark) went
// with it. What the footer still claims is asserted here:
//
//   * ONE GROUP, `.ws-group`, whose head band carries the fold, the view toggle and
//     the `+`. A holding is a row with one control of its own: NOTE | READ, a COST
//     decision about what goes into the turn's prompt. Note names the path; Read
//     quotes the contents. Neither offers any reach, and no row draws a control
//     that says it does.
//   * THE EMPTY STATE IS THE POINT. The group is drawn when it holds nothing, the
//     band says so in words (`dws.none_yet`; the old `.ws-empty` sentence is gone),
//     and the `+` that ends the state is on the band. The crystal footer hid itself
//     at zero until 4216383 and took the `+` with it; this asserts that lesson.
//   * The holdings and their cost are written down: they survive a reload, and the
//     sync parcel stays a fixed point however often the footer is drawn.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged file to the real page through `page.route`; the run is then
// expected to FAIL, and a break whose anchor does not match aborts rather than
// passing quietly.
//
//   node dev/verify_chatworkspace.mjs --break hideatzero   # 1 fails: the empty group hides
//   node dev/verify_chatworkspace.mjs --break emptysilent  # 1 fails: the band says nothing
//   node dev/verify_chatworkspace.mjs --break headingback  # 1 fails: a heading restates the rows
//   node dev/verify_chatworkspace.mjs --break bothgroups   # 2 fails: a holding is drawn twice
//   node dev/verify_chatworkspace.mjs --break wspill       # 2 fails: a row claims reach again
//   node dev/verify_chatworkspace.mjs --break pickernoadd  # 3 fails: the group's + adds nothing
//   node dev/verify_chatworkspace.mjs --break costinert    # 4 fails: Note/Read does nothing
//   node dev/verify_chatworkspace.mjs --break readfetch    # 5 fails: Read only names the file
//   node dev/verify_chatworkspace.mjs --break nohydrate    # 6 fails: the holdings die on reload
//   node dev/verify_chatworkspace.mjs --break nostamp      # 6 fails: the holdings never reach disk
//   node dev/verify_chatworkspace.mjs --break staterestamp # 7 fails: a draw normalises the record
//   node dev/verify_chatworkspace.mjs --break rendertouch  # 7 fails: a redraw restamps the parcel
//   node dev/verify_chatworkspace.mjs --break wscapless    # 8 fails: the box eats the composer
//   node dev/verify_chatworkspace.mjs                      # and then, clean
//
//   bash dev/world.sh 5 --up
//   eval "$(bash dev/world.sh 5 --env)"
//   node dev/verify_chatworkspace.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, newChat, errors, chat, mockLog, clearMockLog } from './harness.mjs';

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
		file: 'js/page/marks.js',
		find: `	var held = chatAttachList(f.id);`,
		with: `	var held = chatAttachList(f.id);
	if (!held.length) { box.innerHTML = ''; box.style.display = 'none'; return; }`,
	},
	// The group is drawn and the band says nothing: the empty state is on screen
	// and silent, so nothing tells the reader the chat holds nothing.
	emptysilent: {
		file: 'js/page/marks.js',
		find: `held.length ? tn('dws.count', held.length) : t('dws.none_yet')`,
		with: `held.length ? tn('dws.count', held.length) : ''`,
	},
	// The heading put back over the list. Nothing else changes and nothing breaks;
	// what goes red is the one check that says the footer no longer restates in a
	// heading what every row already says, which is the change the owner asked for.
	headingback: {
		file: 'js/page/marks.js',
		find: `		help:  t('attach.group_prompt'),`,
		with: `		title: t('attach.group_prompt'),
		help:  t('attach.group_prompt'),`,
	},
	// The list draws the holdings twice. A holding is one decision, and a reader
	// who sees it twice cannot tell whether that is one folder or two.
	bothgroups: {
		file: 'js/page/marks.js',
		find: `	var body = attachBody(held.map(toTile),`,
		with: `	var body = attachBody(held.concat(held).map(toTile),`,
	},
	// A row draws the retired `Workspace` pill again. Nothing behind it grants
	// reach any more, so a pill on the row is a claim the app no longer makes.
	wspill: {
		file: 'js/page/marks.js',
		find: `			actions: [],`,
		with: `			actions: a.dir ? [{ cls: 'attach-ws', text: 'Workspace', pressed: false, on: function () {} }] : [],`,
	},
	// The `+` on the group's own band opens the picker, the user ticks a folder,
	// presses Add -- and nothing is added. The dialog closing reads as "added".
	pickernoadd: {
		file: 'js/page/marks.js',
		find: `		await Files.attachAdd(paths[i], picked[paths[i]].dir);`,
		with: `		/* the ticked paths are dropped */`,
	},
	// Note/Read is drawn, is pressable, and does nothing. Two of lane 4's four
	// defects on 2026-08-12 were exactly this, and no check on internal state can
	// see it: the check goes through a real click.
	costinert: {
		file: 'js/page/marks.js',
		find: `		rec.state = state;`,
		with: `		/* the press does nothing */`,
	},
	// Read goes back to TELLING THE MODEL to open the file. Read grants no reach,
	// so that is an instruction the app itself refuses -- the first Read a user
	// presses produces a refusal the app caused.
	readfetch: {
		file: 'js/page/marks.js',
		find: `	if (text && f.kind === 'chat') text += await attachReadBodies(list, f.id);`,
		with: `	if (text && f.kind === 'chat') text += '';`,
	},
	// BOTH OF THESE WERE REAL, and both were found by the check they now break.
	//
	// `nohydrate`: the loader that turns a stored chat back into a live one never
	// carried `holds`. It was written out faithfully and read back as nothing, and
	// the first save after boot then wrote the empty list over the user's own.
	nohydrate: {
		file: 'js/page/chatstore.js',
		find: `		// workspace mark rides here, so it would have taken the fence with it.
		holds: Array.isArray(c.holds) ? c.holds : [],`,
		with: `		// the holdings are dropped on the way in`,
	},
	// `nostamp`: the store writes a record only when its stamp moves. Attaching
	// and flipping Note to Read move nothing else in the stamp, so without the
	// holdings in it the put never happens -- while the in-memory mirror, which is
	// what every reader reads, says it has.
	nostamp: {
		file: 'js/page/chatstore.js',
		find: `':' + JSON.stringify(c.holds || []) + ':m'`,
		with: `':m'`,
	},
	// The draw normalises `state` back onto the record it just read. Harmless
	// looking, and it is how the sync parcel stops being a fixed point: a record
	// that arrives from another device without the field gains one here, so the
	// next collect differs from what was applied and the two devices push at each
	// other for ever.
	staterestamp: {
		file: 'js/page/marks.js',
		find: `			state:  a.state,`,
		with: `			state:  (a.state = a.state || 'note'),`,
	},
	// The draw hangs a stamp on every holding -- "when this was last shown", say.
	// Plausible bookkeeping, and the exact shape of the bug that put a paired
	// iPhone into an endless sync loop: two collects with a redraw between them
	// no longer agree.
	rendertouch: {
		file: 'js/page/marks.js',
		find: `	var toTile = function (a) {`,
		with: `	var toTile = function (a) {
		a.seen = Date.now();`,
	},
	// The box has no cap, so it grows with every folder held and pushes the
	// composer down the screen -- the failure `--attach-cap` was measured to end.
	wscapless: {
		file: 'css/app.css',
		find: `.ws-body {
	max-height: calc(var(--attach-cap) * var(--attach-row-h) + var(--attach-peek));`,
		with: `.ws-body {`,
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
const s = await open({ name: 'chatworkspace', signIn: false, connect: false, foot: ['ws'] });
const { page } = s;

/// Serve one deliberately damaged file in place of the real one, before the app
/// is loaded. Routes outlive a reload, so this is installed once.
async function installBreak() {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	// The file AS SERVED, read raw: the browser fetches each www/js/page/ module by
	// itself, so `readPage` (which reads those as nothing, they being in the view)
	// would find no anchor in them.
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

// The files and folders a person would have: two folders to hold, one file to
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

/// What the footer is showing, row by row, with the controls each row carries.
const footer = () => page.evaluate(() => {
	const read = (r) => ({
		kind:  (r.querySelector('.arte-kind') || {}).textContent || '',
		path:  (r.querySelector('.arte-open') || {}).textContent || '',
		state: (r.querySelector('.attach-state') || {}).textContent || '',
		read:  r.querySelector('.attach-state')
			? r.querySelector('.attach-state').getAttribute('aria-pressed') : null,
		hasWsBtn: !!r.querySelector('.attach-ws'),
	});
	const box = document.getElementById('chat-attachments');
	const all = box ? [...box.querySelectorAll('.ws-group .arte-row')].map(read) : [];
	const band = box && box.querySelector('.ws-group [data-act="foot-fold"]');
	return {
		shown: !!box && box.style.display !== 'none' && !!box.querySelector('.ws-group'),
		// No heading is drawn, and its absence is asserted rather than assumed:
		// a heading creeping back is the thing he asked to be rid of.
		heads: box ? box.querySelectorAll('.attach-group-title').length : 0,
		band:  band ? band.textContent.trim() : '',
		add:   !!(box && box.querySelector('.ws-group [data-act="attach-add"]')),
		pills: box ? box.querySelectorAll('.attach-ws').length : 0,
		all,
	};
});
const rowOf = (f, p) => f.all.find(r => r.path === p);

/// Press the Note/Read control on the row for `p`, found by its path rather than
/// by position: first-in-DOM would be whichever row happens to be drawn first.
const pressCost = (p) => page.evaluate((p) => {
	const row = [...document.querySelectorAll('#chat-attachments .arte-row')]
		.find(r => (r.querySelector('.arte-open') || {}).textContent === p);
	const btn = row && row.querySelector('.attach-state');
	if (!btn) return 'no control';
	btn.click();
	return 'clicked';
}, p);

// ── 1. THE EMPTY STATE, which is the state that most needs saying ──────
await section('the empty state', async () => {
	const f = await footer();
	check('WITH NOTHING HELD, THE GROUP IS ON SCREEN', f.shown === true, JSON.stringify({ shown: f.shown }));
	check('and it carries no group heading, because every row says its own claim',
		f.heads === 0, `${f.heads} heading(s) still drawn`);
	const want = await T('dws.none_yet');
	check('and its band says, in words, that nothing is held',
		!!want && f.band.indexOf(want) >= 0, JSON.stringify({ band: f.band, want }));
	check('and the list itself is empty, because nothing is attached',
		f.all.length === 0, JSON.stringify({ rows: f.all.length }));
	// The lesson of 4216383: the control that ends this state must be reachable
	// FROM this state.
	check('and the `+` that adds the first holding is on that band', f.add === true, String(f.add));
});
await shot(s, 'chatworkspace-1-empty');

// ── 2. Attaching: one row per holding, one control per row ─────────────
await section('attaching', async () => {
	await page.evaluate((id) => {
		window.DaimondAttach.chatToggle(id, 'dir:[browser]papers', true, 'papers');
		window.DaimondAttach.chatToggle(id, 'file:[browser]papers/spec.md', false, 'papers/spec.md');
	}, chatId);
	await page.waitForTimeout(600);
	const f = await footer();
	const note = await T('attach.note');
	check('ATTACHING PUTS EACH IN THE LIST, the folder as a folder',
		!!rowOf(f, 'papers') && !!rowOf(f, 'papers/spec.md') && rowOf(f, 'papers').kind === 'dir',
		JSON.stringify(f.all));
	check('and each appears ONCE in the list, not twice',
		f.all.filter(r => r.path === 'papers').length === 1
			&& f.all.filter(r => r.path === 'papers/spec.md').length === 1, JSON.stringify(f.all));
	check('each starts at Note, the cheaper cost, unpressed',
		f.all.length > 0 && f.all.every(r => r.state === note && r.read === 'false'), JSON.stringify(f.all));
	// The workspace mark is retired (D-20261031-11): neither cost grants anything,
	// and no row may draw a control that says otherwise.
	check('AND NO ROW OFFERS A WORKSPACE MARK, because attaching grants nothing',
		f.pills === 0 && f.all.every(r => !r.hasWsBtn), `${f.pills} pill(s)`);
	const band = f.band;
	check('and the band counts what is held', /2/.test(band), JSON.stringify(band));
});
await shot(s, 'chatworkspace-2-attached');

// ── 3. The `+` on the group's band adds what is ticked ─────────────────
await section('the group’s own +', async () => {
	// Driven as a person drives it, through the dialog, because a control that
	// opens and then quietly does nothing is what two of lane 4's defects were.
	await page.click('#chat-attachments .ws-group [data-act="attach-add"]', { force: true });
	await page.waitForSelector('.attach-pick-row', { timeout: 10000 });
	const ticked = await page.evaluate(() => {
		const row = [...document.querySelectorAll('.attach-pick-row')]
			.find(r => /books/.test(r.querySelector('.attach-pick-name').textContent));
		if (!row) return 'no books row';
		row.querySelector('input').click();
		return 'ticked';
	});
	check('the picker lists the folder to be added', ticked === 'ticked', ticked);
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(1000);
	const f = await footer();
	check('THE GROUP’S OWN `+` ADDS THE TICKED FOLDER to the list',
		!!rowOf(f, 'books') && rowOf(f, 'books').kind === 'dir', JSON.stringify(f.all));
	const held = await page.evaluate((id) => (window.DaimondAttach.chatList(id) || []).map(a => a.path), chatId);
	check('and the chat holds it', held.indexOf('books') >= 0, JSON.stringify(held));
});

// ── 4. Note ⇄ Read, through a real click ───────────────────────────────
await section('the cost', async () => {
	const read = await T('attach.read'), note = await T('attach.note');
	const c1 = await pressCost('papers');
	check('the folder’s Note/Read control is there to press', c1 === 'clicked', c1);
	await page.waitForTimeout(600);
	let f = await footer();
	check('PRESSING NOTE MAKES IT READ, and the row says so',
		!!rowOf(f, 'papers') && rowOf(f, 'papers').state === read && rowOf(f, 'papers').read === 'true',
		JSON.stringify(rowOf(f, 'papers')));
	let held = await page.evaluate((id) => (window.DaimondAttach.chatList(id) || [])
		.map(a => ({ path: a.path, state: a.state })), chatId);
	check('and the chat’s own record says read',
		held.some(a => a.path === 'papers' && a.state === 'read'), JSON.stringify(held));
	// And back, so the rest of the run reads a Note folder.
	await pressCost('papers');
	await page.waitForTimeout(600);
	f = await footer();
	check('and pressing it again puts it back to Note',
		!!rowOf(f, 'papers') && rowOf(f, 'papers').state === note && rowOf(f, 'papers').read === 'false',
		JSON.stringify(rowOf(f, 'papers')));
});

// ── 5. Read quotes the file rather than asking for it ──────────────────
await section('read quotes', async () => {
	await pressCost('papers/spec.md');
	await page.waitForTimeout(900);
	// What the MODEL is sent is the claim, so it is read off the wire: the chat's
	// first message carries the holdings' note, and a Read quotes the file in it.
	clearMockLog();
	await chat(s, 'what does the spec say?');
	const said = [];
	const walk = (v) => {
		if (typeof v === 'string') said.push(v);
		else if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === 'object') Object.values(v).forEach(walk);
	};
	mockLog().forEach(walk);
	const all = said.join('\n');
	check('the turn reached the model', said.length > 0, `${said.length} string(s) logged`);
	check('READ PUTS THE FILE’S OWN WORDS IN WHAT THE MODEL IS SENT',
		all.indexOf('the sentence that proves the quote is the FILE') >= 0,
		JSON.stringify(all.slice(0, 200)));
	// The tool door numbers every line; the raw door does not. Quoting the tool's
	// answer would put a gutter down the user's file, which this app has shipped
	// twice before.
	check('and quotes the file, not the tool’s numbered view of it',
		!/^\s*\d+\t# Spec/m.test(all), '');
	check('and Note names the folder without quoting it',
		/Note [^\n]*papers/.test(all), '');
});
await shot(s, 'chatworkspace-3-read-quoted');

// ── 6. The holdings are written down ───────────────────────────────────
await section('persistence', async () => {
	await page.reload({ waitUntil: 'domcontentloaded' });
	// A reload always locks -- identity.js holds the wrapping key in memory and
	// nowhere else -- so the passphrase goes in again before anything can be read.
	await signInAs(s, 'chatworkspace');
	await page.waitForTimeout(1800);
	const held = await page.evaluate((id) => (window.DaimondAttach.chatList(id) || [])
		.map(a => ({ path: a.path, state: a.state })), chatId);
	check('THE HOLDINGS SURVIVE A RELOAD, because they live on the chat’s own record',
		held.some(a => a.path === 'papers') && held.some(a => a.path === 'books'), JSON.stringify(held));
	check('and so does the cost beside each',
		held.some(a => a.path === 'papers/spec.md' && a.state === 'read')
			&& held.some(a => a.path === 'papers' && a.state === 'note'), JSON.stringify(held));
});

// ── 7. The parcel is still a fixed point ───────────────────────────────
await section('the parcel', async () => {
	// A parcel from ANOTHER DEVICE whose holding lacks a field the draw reads:
	// collect, redraw, apply, and the bytes must come back. AWAITED, all of them:
	// a check that compared two unawaited promises compared `undefined` with
	// `undefined` and passed while proving nothing.
	const same = await page.evaluate(async (id) => {
		const one = window.DaimondAttach.chatList(id)[0];
		delete one.state;
		// STRINGIFIED THE MOMENT IT IS COLLECTED. A parcel carries the holdings BY
		// REFERENCE, so two parcels held as objects are two views of one array and
		// can only ever compare equal.
		const j = (p) => JSON.stringify(p.chats || []);
		const p1 = await DaimondCore.collectSync();
		const mine = (p1.chats || []).find(c => c.id === id) || {};
		const fieldless = (mine.holds || []).some(h => !('state' in h));
		const holds = (p1.chats || []).reduce((n, c) => n + (c.holds || []).length, 0);
		const s1 = j(p1);
		// A redraw, which is the moment a normalising or stamping read would happen.
		window.DaimondAttach.render();
		await new Promise(r => setTimeout(r, 400));
		const s2 = j(await DaimondCore.collectSync());
		// The fixed point itself: apply what this device would send, and it must
		// still send exactly that.
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

// ── 8. The composer stays put however much is held ─────────────────────
await section('the cap', async () => {
	const geom = () => page.evaluate(() => {
		const b = document.querySelector('#chat-attachments .ws-body');
		const bar = document.querySelector('.chat-input-bar');
		const r = el => el ? el.getBoundingClientRect() : { height: 0, top: 0 };
		return {
			box: Math.round(r(b).height), inside: b ? b.scrollHeight : 0,
			rows: document.querySelectorAll('#chat-attachments .arte-row').length,
			bar: Math.round(r(bar).top),
		};
	});
	// UNREACHABLE folders -- on a machine whose workspace is not the open one.
	// Two things at once: it proves a holding that cannot be reached is still
	// shown rather than silently dropped (§7), and it keeps the composer's own
	// text out of the measurement.
	const hold = async (from, to) => {
		for (let i = from; i < to; i++) {
			await page.evaluate(([id, i]) => window.DaimondAttach.chatToggle(
				id, `dir:[machine:elsewhere]bulk-${i}`, true, `bulk-${i}`), [chatId, i]);
		}
		await page.waitForTimeout(500);
		return geom();
	};
	// AT the cap and then well past it. Measuring from BELOW the cap would compare
	// a box still growing with one that has stopped.
	const atSix = await hold(0, 6);
	const atMany = await hold(6, 15);
	// MEASURED, not merely equal: two absences are equal to each other.
	check('fifteen more folders are held, in a box that is drawn',
		atMany.rows >= 15 && atSix.box > 0 && atSix.bar > 0, JSON.stringify({ atSix, atMany }));
	check('and the box was already at its cap with six of them',
		atSix.inside > atSix.box + 10, `${atSix.inside}px of rows in a ${atSix.box}px box`);
	check('PAST THE CAP THE BOX STOPS GROWING',
		atMany.box > 0 && atMany.box === atSix.box, `${atSix.box}px at 6, ${atMany.box}px at 15`);
	check('AND THE COMPOSER HAS NOT MOVED', atMany.bar > 0 && atMany.bar === atSix.bar,
		`${atSix.bar} at 6, ${atMany.bar} at 15`);
	check('and the box scrolls, so the rows past the fold can still be reached',
		atMany.inside > atMany.box + 10, `${atMany.inside}px of rows in a ${atMany.box}px box`);
	const strays = await page.evaluate(() => [...document.querySelectorAll(
		'#chat-attachments .arte-row.shut .arte-why')].length);
	check('and an unreachable holding is shown, saying where it lives', strays > 0, String(strays));
	await shot(s, 'chatworkspace-4-capped');
	// Off again, so the shots below are of a footer a person would recognise.
	for (let i = 0; i < 15; i++) {
		await page.evaluate(([id, i]) => window.DaimondAttach.chatToggle(
			id, `dir:[machine:elsewhere]bulk-${i}`, true, `bulk-${i}`), [chatId, i]);
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
	check('ON A PHONE THE COMPOSER IS STILL ON SCREEN under the footer',
		!!fits && fits.h > 0 && fits.footer > 0 && fits.bar + fits.h <= fits.win + 1,
		JSON.stringify(fits));
	await page.setViewportSize({ width: 1500, height: 950 });
	await page.waitForTimeout(700);
});

// 502s are the local gateway proxy (/api) not running in this world -- a world
// is the browser tiers only, as dev/world.sh says in as many words. A 401 is NOT
// excluded: a world's gateway is its own (9700 + N), so a 401 here can only be a
// gateway THIS world started refusing the app, which is what this check is for.
const GATEWAY_NOISE = /502 \(Bad Gateway\)/;
const errs = errors(s).filter(e => !GATEWAY_NOISE.test(e));
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
