// verify_marknotice.mjs — a mark not in force on this device is said over the composer, and one
// press puts it back.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// Since 2026-09-23 a mark applies only on the device it was made or confirmed on: a mark made on
// argonaut's `usr` had been matched by NAME on gilgamesh's, where a daimon then removed four of
// its top-level folders. So at that deploy every existing mark on every desktop went inactive at
// once, and the audit of the delete unit (finding 6) found the only sign of it was the
// paperclip's hover tooltip -- which a touch screen never shows -- while the daimon, told nothing,
// met a plain out-of-bounds refusal and reported the folder as out of reach.
//
// ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
//
//   1. With a folder open, a Diamond whose marks were made on another device, before devices
//      were recorded, or before rows said who made them SAYS SO over the composer, in ink, with
//      nothing hovered: one row per mark, where it was made, and a press. A mark in force here,
//      and a link a model asserted, are not listed.
//   2. The fence agrees: what is listed is exactly `bounds().unconfirmed`, and none of it is in
//      `attached`.
//   3. The daimon is TOLD: its request names each as unconfirmed on this device, and a write it
//      tries in one is refused in words that name the mark and send it to the user -- and the
//      file is not written.
//   4. One press brings one mark into force, written with this device added and still the
//      user's; "Use all" brings the rest; the notice then goes.
//   5. On the crystal face the notice sits over the composer, and on a CHAT the same notice
//      lists the chat's own marks and the same press brings them into the chat's scope.
//
// As in dev/verify_droots.mjs, an OPFS subdirectory stands in for the picked folder, reconnected
// at boot the way a granted folder is: what the picker returns is a FileSystemDirectoryHandle,
// and OPFS hands out that very type.
//
// Needs a world for the mock provider: `eval "$(bash dev/world.sh N --env)"`.
import { open, signInAs, steerDiamond, newChat, markHere, mockLog, clearMockLog, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FOLDER = 'marknotice-folder';
const OTHER  = '0123456789abcdef';      // another device's id, as a mark made there names it

// Which part of the run a page error came from, since the list at the end says only what. Heard
// from before the first navigation, so an error in the boot is named as the boot's: attached after
// `open()`, the one error this was added for arrived before it and went unnamed.
let step = 'boot';
const s = await open({ name: 'marknotice',
	route: async (page) => {
		page.setDefaultNavigationTimeout(180000);
		page.on('pageerror', (e) => console.log('  note  page error during "' + step + '": '
			+ String((e && (e.stack || e.message)) || e).split('\n').slice(0, 6).join(' | ')));
	} });
const p = s.page;
await p.waitForTimeout(1500);

// Every expected word is asked of the running app: it ships eight languages.
const T  = (k, v) => p.evaluate(([k, v]) => DaimondI18n.t(k, v || undefined), [k, v || null]);
const TN = (k, n) => p.evaluate(([k, n]) => DaimondI18n.tn(k, n), [k, n]);

// ── The folder, open as a desktop has it ──────────────────────────────────────
step = 'folder';
await p.evaluate(async (folder) => {
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* first run */ }
	const dir = await root.getDirectoryHandle(folder, { create: true });
	for (const d of ['mine', 'theirs', 'older', 'nobody', 'agentold', 'late', 'chatmark']) {
		const sub = await dir.getDirectoryHandle(d, { create: true });
		const fh = await sub.getFileHandle('keep.md', { create: true });
		const w = await fh.createWritable();
		await w.write('kept ' + d);
		await w.close();
	}
	// Where the panel looks for a folder it may reconnect without a picker.
	const db = await new Promise((res, rej) => {
		const q = indexedDB.open('daimond-fsa', 1);
		q.onupgradeneeded = () => q.result.createObjectStore('handles');
		q.onsuccess = () => res(q.result);
		q.onerror   = () => rej(q.error);
	});
	await new Promise((res, rej) => {
		const tx = db.transaction('handles', 'readwrite');
		tx.objectStore('handles').put(dir, 'workspace');
		tx.oncomplete = res;
		tx.onerror = () => rej(tx.error);
	});
}, FOLDER);
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'marknotice');
await p.waitForTimeout(4000);
const mode = await p.evaluate(async () => (await import('/pkg/oxedyne_daimond.js')).workspace_mode());
check('0. the app reconnected the stand-in folder at boot, as a desktop does', mode === 'folder', mode);

// ── A Diamond, open, with marks from here, from elsewhere, and from before ────
step = 'diamond';
await p.click('#new-diamond-btn', { force: true });
await p.waitForSelector('.dlg-input', { timeout: 15000 });
await p.fill('.dlg-input', 'Marks here');
await p.click('.dlg-ok', { force: true });
await sleep(1600);
await p.evaluate(() => {
	const box = [...document.querySelectorAll('.diamond-box')]
		.find((b) => /Marks here/.test(b.getAttribute('aria-label') || b.textContent || ''));
	if (box) box.click();
});
await sleep(1500);
const did = await p.evaluate(() => (window.DaimondDiamond && DaimondDiamond.current()
	&& DaimondDiamond.current().name === 'Marks here') ? DaimondDiamond.current().id : '');
check('0. the Diamond is open', !!did, did);

const dev = await p.evaluate(() => (window.DaimondIdentity && DaimondIdentity.deviceId
	&& DaimondIdentity.deviceId()) || '');
const ref = (name, devs) => 'dir:[machine:' + FOLDER + (devs ? '@' + devs : '') + ']' + name;
// `mine` is pressed here (R2): a row alone, however it names this device, is
// only a claim, so it is `markHere`'d rather than added and left. The rest are
// left exactly as `add_link` writes them, so the notice has marks not in force
// here to list: made elsewhere, before devices were recorded, or by an agent.
await p.evaluate(async ({ did, theirs, older, agentold, nobody }) => {
	const app = DaimondCore.diamondApp();
	const self = 'diamond:' + did;
	await app.add_link(did, self, theirs,   'holds', '', 'user');
	await app.add_link(did, self, older,    'holds', '', 'user');
	await app.add_link(did, self, agentold, 'holds', '', 'agent:daimon');
	// A row from before rows said who made them, through the store's own door: `add_link` stamps
	// every row it writes, so no row it writes can be one of these.
	const M = await import('/pkg/oxedyne_daimond.js');
	const side = 'diamonds/' + did + '/.daimond/links.jsonl';
	let had = '';
	try { had = await M.read_file(side); } catch (e) { had = ''; }
	await M.write_file(side, had + JSON.stringify({ id: 'legacy1', ts: 1, from: self, to: nobody,
		rel: 'holds', note: '' }) + '\n');
	if (window.DaimondLinks && DaimondLinks.changed) DaimondLinks.changed();
}, { did, theirs: ref('theirs', OTHER), older: ref('older', ''),
	agentold: ref('agentold', ''), nobody: ref('nobody', dev) });
await markHere(s, did, ref('mine', dev));
await sleep(1500);

const notice = () => p.evaluate(() => {
	const box = document.getElementById('mark-notice');
	if (!box) return { box: false };
	const r = box.getBoundingClientRect();
	const bar = document.querySelector('.chat-input-bar');
	const b = bar ? bar.getBoundingClientRect() : null;
	return {
		box:    true,
		shown:  !box.hidden && r.height > 0 && r.width > 0 && r.top >= 0 && r.bottom <= innerHeight + 1,
		above:  !!b && r.bottom <= b.top + 1,
		head:   ((box.querySelector('.mark-notice-head') || {}).textContent) || '',
		rows:   [...box.querySelectorAll('.mark-notice-row')].map((x) => ({ path: x.dataset.path,
			where: ((x.querySelector('.mark-notice-where') || {}).textContent) || '',
			press: !!x.querySelector('[data-act="mark-use-here"]') })),
		all:    !!box.querySelector('[data-act="mark-use-all"]'),
	};
});
const bounds = () => p.evaluate((id) => DaimondDiamond.bounds(id), did);
// A press on what should be there. A build without it records the failure at the check that
// follows rather than ending the run, so every check still says what it saw.
const press = async (sel) => {
	const el = await p.$(sel);
	if (!el) return false;
	await el.click({ force: true });
	return true;
};
const linksOf = () => p.evaluate(async (id) =>
	JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + id) || '[]'), did);

const n1 = await notice();
const paths1 = (n1.rows || []).map((r) => r.path).sort();
check('1. the notice is on screen with nothing hovered, over the composer',
	n1.box === true && n1.shown === true && n1.above === true, JSON.stringify(n1).slice(0, 240));
check('1. it says how many, in the app\'s own words', n1.head === await TN('marks.waiting', 3), n1.head);
check('1. it lists each mark not in force here, and no other',
	JSON.stringify(paths1) === JSON.stringify(['nobody', 'older', 'theirs']), JSON.stringify(paths1));
const rowOf = (n, path) => (n.rows || []).find((r) => r.path === path) || {};
check('1. each row says where the mark was made, and has its press',
	/another device|0123/.test(rowOf(n1, 'older').where + rowOf(n1, 'theirs').where)
		&& rowOf(n1, 'nobody').where === await T('marks.made_before')
		&& (n1.rows || []).every((r) => r.press) && n1.all === true,
	JSON.stringify(n1.rows));
const b1 = await bounds();
check('2. the fence agrees: listed is unconfirmed, and none of it is attached',
	JSON.stringify((b1.unconfirmed || []).slice().sort()) === JSON.stringify(['nobody', 'older', 'theirs'])
		&& JSON.stringify(b1.attached) === JSON.stringify(['mine']),
	JSON.stringify({ attached: b1.attached, unconfirmed: b1.unconfirmed }));

// ── The daimon is told, and a write there is refused in words that say why ────
step = 'steer';
clearMockLog();
await steerDiamond(s, '@tool file_write ' + JSON.stringify({ path: 'theirs/x.md', content: 'x' }));
let log = [];
for (let i = 0; i < 120; i++) {
	log = mockLog();
	if (log.some((r) => (r.messages || []).some((m) => m.role === 'tool'))) break;
	await sleep(500);
}
const sent = JSON.stringify(log);
const told = log.some((r) => {
	const sys = (r.messages || []).filter((m) => m.role === 'system').map((m) => JSON.stringify(m.content)).join(' ');
	return /unconfirmed on this device/.test(sys) && /`theirs`/.test(sys) && /`older`/.test(sys);
});
check('3. the daimon\'s request names each as unconfirmed on this device', told,
	told ? '' : sent.slice(0, 300));
const toolSaid = log.flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool'))
	.map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(' | ');
const unwritten = await p.evaluate(async (folder) => {
	const root = await navigator.storage.getDirectory();
	try {
		const d = await (await root.getDirectoryHandle(folder)).getDirectoryHandle('theirs');
		await d.getFileHandle('x.md');
		return false;
	} catch (e) { return true; }
}, FOLDER);
check('3. and a write in one is refused, naming the mark and sending it to the user',
	/^Refused/.test(toolSaid) && /'theirs' IS marked in/.test(toolSaid) && unwritten === true,
	toolSaid.slice(0, 260));
await shot(s, 'marknotice-diamond-chat');

// ── One press, then the rest ──────────────────────────────────────────────────
step = 'presses';
const l1 = (await linksOf()).filter((l) => /\]theirs$/.test(l.other));	// before the press, for the byte check below
await press('#mark-notice .mark-notice-row[data-path="theirs"] [data-act="mark-use-here"]');
await sleep(1800);
const n2 = await notice();
const b2 = await bounds();
const l2 = (await linksOf()).filter((l) => /\]theirs$/.test(l.other));
const forced2 = await p.evaluate(({ did, ref }) => DaimondAttach.inForce(did, ref),
	{ did, ref: ref('theirs', OTHER) });
check('4. one press brings that mark into force here',
	JSON.stringify((n2.rows || []).map((r) => r.path).sort()) === JSON.stringify(['nobody', 'older'])
		&& (b2.attached || []).includes('theirs') && !(b2.unconfirmed || []).includes('theirs')
		&& !!forced2,
	JSON.stringify({ rows: n2.rows, attached: b2.attached, forced: forced2 }));
// R2: a confirmation is THIS DEVICE'S RECORD ONLY -- no add, no remove, no stamp.
// The old row-rewriting confirm moved the mark to a new id with this device added;
// this checks the opposite property, that the row is byte-for-byte what it was.
check('4. the record changes; the row does not',
	JSON.stringify(l2) === JSON.stringify(l1),
	JSON.stringify({ before: l1, after: l2 }));
await press('#mark-notice [data-act="mark-use-all"]');
await sleep(2500);
const n3 = await notice();
const b3 = await bounds();
const l3 = await linksOf();
check('4. "Use all" brings the rest, and the notice goes',
	n3.shown === false && JSON.stringify((b3.attached || []).slice().sort())
		=== JSON.stringify(['mine', 'nobody', 'older', 'theirs'])
		&& (b3.unconfirmed || []).length === 0,
	JSON.stringify({ shown: n3.shown, attached: b3.attached, unconfirmed: b3.unconfirmed }));
// R2: a legacy row is confirmable and in force under this device's entry, and is
// NEVER rewritten by a confirmation -- only ⇄ on it would carry it to a fresh,
// user-owned row (dws.share_here_help's O2), which nothing here presses. So the
// old row now reads in force while still anonymous, which is the opposite of what
// this asserted before R2, when confirming rewrote it as the user's.
const nobodyRows3 = l3.filter((l) => /\]nobody$/.test(l.other));
check("4. the model's own link is still not a mark, and the legacy row is in force unrewritten",
	!(b3.attached || []).includes('agentold')
		&& nobodyRows3.length === 1 && nobodyRows3[0].by === '' && (b3.attached || []).includes('nobody'),
	JSON.stringify(nobodyRows3.map((l) => [l.other, l.by])));

// ── The crystal face ──────────────────────────────────────────────────────────
step = 'crystal';
await p.evaluate(async ({ did, late }) => {
	await DaimondCore.diamondApp().add_link(did, 'diamond:' + did, late, 'holds', '', 'user');
	if (window.DaimondLinks && DaimondLinks.changed) DaimondLinks.changed();
}, { did, late: ref('late', OTHER) });
const crystal = await p.$('#dview-crystal');
if (crystal) await crystal.click({ force: true });
await sleep(1800);
const n4 = await notice();
check('5. on the crystal face it sits over the composer too, and counts one',
	n4.shown === true && n4.above === true && n4.head === await TN('marks.waiting', 1)
		&& (n4.rows || []).length === 1 && n4.rows[0].path === 'late',
	JSON.stringify(n4).slice(0, 240));
await shot(s, 'marknotice-crystal');

// ── A chat ────────────────────────────────────────────────────────────────────
step = 'chat';
const cid = await newChat(s);
const cref = ref('chatmark', OTHER);
// R2: `chatToggle`/`chatWs` now press THIS device the instant they are called,
// so seeding "a mark from another device" through them would confirm it on the
// spot. `markHere(..., { press: false })` writes the holding straight into the
// chat's own record instead -- claimed, and not yet pressed here -- which is
// what a synced holding actually looks like before anyone has used it.
await markHere(s, null, cref, { chat: cid, path: 'chatmark', ws: true, press: false });
await sleep(1200);
const n5 = await notice();
const scope5 = await p.evaluate((cid) => DaimondAttach.chatScope(cid), cid);
check("5. a chat's mark from another device is listed over its composer, and is not in its scope",
	n5.shown === true && (n5.rows || []).length === 1 && n5.rows[0].path === 'chatmark'
		&& !scope5.includes('chatmark'),
	JSON.stringify({ rows: n5.rows, scope: scope5 }));
await shot(s, 'marknotice-chat');
await press('#mark-notice [data-act="mark-use-here"]');
await sleep(1500);
const n6 = await notice();
const scope6 = await p.evaluate((cid) => DaimondAttach.chatScope(cid), cid);
check('5. and the same press brings it into the chat\'s scope',
	n6.shown === false && scope6.includes('chatmark'), JSON.stringify({ shown: n6.shown, scope: scope6 }));

// ── Tidy ──────────────────────────────────────────────────────────────────────
step = 'tidy';
await p.evaluate(async (folder) => {
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* tidy */ }
}, FOLDER);
const errs = errors(s).filter((e) => !/401|502|404|net::ERR|Failed to load resource/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
