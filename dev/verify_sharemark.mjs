// verify_sharemark.mjs — only the user's own mark, in force on this device, is shared.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// A folder flagged to be shared is copied to the account's other devices, and sync then writes
// into it and deletes from it on another device's word (`materialiseTo`, `deleteSyncFile`), with
// no copy kept on this device and no question. The flag was the word `share` in the link's free
// `note`, which `link_add` passes through from whatever a model writes, and `Files.shareRoots`
// counted it on ANY row -- a daimon's and a fold's included (re-check of 2026-09-23, R3). So one
// `link_add` by a daimon opened a sync-carried bulk-delete path onto the real disk.
//
// ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
//
//   1. The user's own mark, flagged by the user's own door, is shared (the control).
//   2. A daimon's `link_add` with `note: "share"` onto a folder, spelled with this device's own
//      root as `link_list` hands it out, is NOT shared, and its note stays only a note.
//   3. The page's share door refuses a model's link outright.
//   4. The user's flagged mark made on ANOTHER device is not shared from here until it is
//      confirmed here, and confirming it carries the flag.
//   5. A user's flag written the old way (the note) still shares, so the owner's flags keep
//      working; taking the flag off stops it.
//
// Every count is asked of `DaimondCore.syncFolderShare().flagged`, which is `Files.shareRoots`
// itself: the roots the census walks and the merge writes into and deletes from.
//
// As in dev/verify_marknotice.mjs, an OPFS subdirectory stands in for the picked folder,
// reconnected at boot the way a granted folder is.
//
// Needs a world for the mock provider: `eval "$(bash dev/world.sh N --env)"`.
import { open, signInAs } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FOLDER = 'sharemark-folder';
const OTHER  = 'fedcba9876543210';      // another device's id, as a mark made there names it
const MOCK   = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';

const s = await open({ name: 'sharemark', connect: false,
	route: async (page) => { page.setDefaultNavigationTimeout(180000); } });
const p = s.page;
await p.waitForTimeout(1500);

// ── The folder, open as a desktop has it ──────────────────────────────────────
await p.evaluate(async (folder) => {
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* first run */ }
	const dir = await root.getDirectoryHandle(folder, { create: true });
	for (const d of ['book', 'secret', 'away', 'older', 'other']) {
		const sub = await dir.getDirectoryHandle(d, { create: true });
		const fh = await sub.getFileHandle('keep.md', { create: true });
		const w = await fh.createWritable();
		await w.write('kept ' + d);
		await w.close();
	}
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
await signInAs(s, 'sharemark');
await p.waitForTimeout(3000);
const mode = await p.evaluate(async () => (await import('/pkg/oxedyne_daimond.js')).workspace_mode());
check('0. the app reconnected the stand-in folder at boot, as a desktop does', mode === 'folder', mode);

const setup = await p.evaluate(async ({ folder }) => {
	const app = DaimondCore.diamondApp();
	const id  = await app.create_diamond('Share marks');
	await DaimondCore.loadDiamonds();
	const dev = (window.DaimondIdentity && DaimondIdentity.deviceId && DaimondIdentity.deviceId()) || '';
	const here = (name) => 'dir:[machine:' + folder + '@' + dev + ']' + name;
	return { id, dev, book: here('book'), secret: here('secret'), older: here('older'),
		shareApi: typeof app.set_link_share === 'function' };
}, { folder: FOLDER });
check('0. a Diamond, and this device\'s own id to spell marks with', !!setup.id && !!setup.dev,
	JSON.stringify({ id: setup.id, dev: setup.dev }));

// What is shared from here, straight from the roots the census walks.
const flagged = () => p.evaluate(async () => {
	if (DaimondCore.syncClearWalkCache) DaimondCore.syncClearWalkCache();
	const sh = await DaimondCore.syncFolderShare();
	return { folder: sh.folder, flagged: sh.flagged || [] };
});
// The user's door onto the flag: the ⇄'s own store call where the build has it, and the note
// this build's predecessor wrote where it has not -- so an older build is measured as it is.
const flag = (id, linkId, on) => p.evaluate(async ({ id, linkId, on }) => {
	const app = DaimondCore.diamondApp();
	if (typeof app.set_link_share === 'function') return app.set_link_share(id, linkId, on);
	return app.update_link(id, linkId, 'holds', on ? 'share' : '');
}, { id, linkId, on });
const linksAbout = (id, re) => p.evaluate(async ({ id, re }) => {
	const all = JSON.parse(await DaimondCore.diamondApp().links_touching('diamond:' + id) || '[]');
	return all.filter((l) => new RegExp(re).test(l.other))
		.map((l) => ({ id: l.id, by: l.by || '', note: l.note || '', share: l.share === true, other: l.other }));
}, { id, re: re.source });

// ── 1. The control: the user's own mark, flagged by the user ─────────────────
const bookId = await p.evaluate(async ({ id, ref }) =>
	DaimondCore.diamondApp().add_link(id, 'diamond:' + id, ref, 'holds', '', 'user'),
	{ id: setup.id, ref: setup.book });
await flag(setup.id, bookId, true);
const f1 = await flagged();
check('1. the user\'s own mark, flagged by the user, is shared', f1.folder === true
	&& f1.flagged.includes('book'), JSON.stringify(f1));

// ── 2. A daimon asserts the flag with link_add ────────────────────────────────
const said2 = await p.evaluate(async ({ id, ref, mock }) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	const eng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
	const seen = [];
	const args = { from: 'diamond:' + id, to: ref, rel: 'holds', note: 'share', share: true, by: 'user' };
	try {
		await eng.steer_crystal(id, '@tool link_add ' + JSON.stringify(args), JSON.stringify([]),
			'[]', '[]', [], (ev) => { if (ev.type === 'tool_result') seen.push(String(ev.content || '')); });
	} catch (e) { seen.push('THREW: ' + String(e && e.message || e)); }
	return seen.join(' | ').slice(0, 300);
}, { id: setup.id, ref: setup.secret, mock: MOCK });
const row2 = (await linksAbout(setup.id, /secret$/))[0] || null;
const f2 = await flagged();
check('2. the daimon\'s link_add ran (the attack is real)', /^Linked /.test(said2), said2);
check('2. and is stored as the model\'s, with its note only a note',
	!!row2 && /^agent:/.test(row2.by) && row2.share === false, JSON.stringify(row2));
check('2. a daimon\'s link_add with note "share" does not share the folder',
	f2.folder === true && !f2.flagged.includes('secret') && f2.flagged.includes('book'),
	JSON.stringify(f2));

// ── 3. The share door refuses a model's link ─────────────────────────────────
const t3 = await p.evaluate(async ({ id, linkId }) => {
	const app = DaimondCore.diamondApp();
	if (typeof app.set_link_share !== 'function') return { api: false };
	try { return { api: true, moved: await app.set_link_share(id, linkId, true) }; }
	catch (e) { return { api: true, refused: String(e && e.message || e).slice(0, 160) }; }
}, { id: setup.id, linkId: row2 ? row2.id : '' });
const f3 = await flagged();
check('3. the page\'s share door refuses a model\'s link', t3.api === true && !!t3.refused
	&& !f3.flagged.includes('secret'), JSON.stringify(t3));

// ── 4. The user's flagged mark made on another device ────────────────────────
const away = 'dir:[machine:' + FOLDER + '@' + OTHER + ']away';
const t4 = await p.evaluate(async ({ id, ref }) => {
	const app = DaimondCore.diamondApp();
	const linkId = await app.add_link(id, 'diamond:' + id, ref, 'holds', '', 'user', true);
	// A build whose add_link takes no flag is given the note it read the flag from.
	const row = JSON.parse(await app.links_touching('diamond:' + id) || '[]').find((l) => l.id === linkId);
	if (row && row.share !== true && typeof app.set_link_share !== 'function') {
		await app.update_link(id, linkId, 'holds', 'share');
	}
	return linkId;
}, { id: setup.id, ref: away });
const f4 = await flagged();
check('4. the user\'s flagged mark from another device is not shared from here',
	!f4.flagged.includes('away'), JSON.stringify(f4));
const c4 = await p.evaluate(async ({ id, ref }) => {
	if (!window.DaimondAttach || !DaimondAttach.confirmHere) return { api: false };
	return { api: true, done: await DaimondAttach.confirmHere(id, ref) };
}, { id: setup.id, ref: away });
const row4 = (await linksAbout(setup.id, /away$/)).find((l) => l.by === 'user' && l.other.indexOf(setup.dev) >= 0);
const f4b = await flagged();
check('4. confirmed here, it keeps its flag and is shared from here',
	c4.done === true && !!row4 && row4.share === true && f4b.flagged.includes('away'),
	JSON.stringify({ confirm: c4, row: row4, flagged: f4b.flagged }));

// ── 5. The owner's flags written the old way, and taking a flag off ─────────
const t5 = await p.evaluate(async ({ id, ref }) => {
	const M = await import('/pkg/oxedyne_daimond.js');
	const side = 'diamonds/' + id + '/.daimond/links.jsonl';
	let had = '';
	try { had = await M.read_file(side); } catch (e) { had = ''; }
	await M.write_file(side, had + JSON.stringify({ id: 'olduser1', ts: 5, from: 'diamond:' + id,
		to: ref, rel: 'holds', note: 'share', by: 'user' }) + '\n');
	return true;
}, { id: setup.id, ref: setup.older });
const f5 = await flagged();
check('5. a user\'s flag written the old way, as the note, still shares',
	t5 === true && f5.flagged.includes('older'), JSON.stringify(f5));
await flag(setup.id, bookId, false);
const f5b = await flagged();
check('5. and taking the user\'s flag off stops the share',
	!f5b.flagged.includes('book') && f5b.flagged.includes('older'), JSON.stringify(f5b));

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
