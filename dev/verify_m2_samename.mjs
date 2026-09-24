// verify_m2_samename.mjs — two machine folders of one name are two places (M2, 2026-09-24).
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// This device's record of the marks pressed on it (markshere.js) keyed a machine workspace
// by the folder's name alone, `machine:usr`. A mark pressed while `/home/j/usr` was open was
// therefore in force in `/media/usb/usr`, a clone or a restored copy, with no press there:
// the Diamond's fence wrote and deleted through it, and a folder shared by ⇄ in the first was
// mirrored into the second (R3 QA, `specs/daimond_r3_qa_marks_20260924.md` M2). Each machine
// folder now carries a random id kept beside its handle in this account's `daimond-folders`
// database, and the record keys by `machine:<name>#<id>`.
//
// ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
//
//   1. In folder A, a mark on `code` pressed and ⇄'d here is in force, held and shared.
//   2. In folder B -- another directory, also called `usr`, also holding `code/` -- the same
//      mark is not in force: not in the fence, not in the share roots, and waiting.
//   3. "Use here" in B brings it into force in B, unshared.
//   4. Back in A through a NEWLY FETCHED handle to the same directory, the id is reused
//      (`isSameEntry`) and A's mark is still held and shared.
//   5. After a reload, the boot reconnect keeps A's id and A's mark.
//
// Both folders are real OPFS directories, and `isSameEntry` on them is false. The picker is
// stubbed to hand them over in turn, and every switch goes through the panel's own door:
// the Machine chip, then "Change folder…", which is the real `openFolder` -> `activateFolder`.
//
// Needs a world: `eval "$(bash dev/world.sh N --env)"`.
import { open, signInAs, markHere, standInFolders } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + String(detail).slice(0, 400) : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const has = (a, x) => Array.isArray(a) && a.includes(x);

// Every check below, counted, so a run that skips one cannot pass.
const PLANNED = 28;

const s = await open({ name: 'm2samename', connect: false,
	route: async (page) => { page.setDefaultNavigationTimeout(180000); } });
const p = s.page;
await p.waitForTimeout(1500);

// ── The two folders, and the stand-in picker ─────────────────────────────────
const F = await standInFolders(s, { tag: 'm2', dirs: ['code'] });
const pick = F.pick;
const facts = await p.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	const dir = async (w) => (await root.getDirectoryHandle('m2-' + w)).getDirectoryHandle('usr');
	const a = await dir('a'), b = await dir('b');
	return { a: a.name, b: b.name, same: await a.isSameEntry(b) };
});
check('0. two real folders, both called "usr", which are not the same entry',
	facts.a === 'usr' && facts.b === 'usr' && facts.same === false, J(facts));

/// What the open folder is, and what this device holds for the mark on `code`.
const state = (id, ref) => p.evaluate(async ({ id, ref }) => {
	if (window.DaimondCore && DaimondCore.syncClearWalkCache) DaimondCore.syncClearWalkCache();
	const b = await DaimondDiamond.bounds(id);
	const mode = (await import('/pkg/oxedyne_daimond.js')).workspace_mode();
	return {
		mode,
		name:   (DaimondFiles.folder() || {}).name || '',
		fid:    DaimondFiles.folderId ? DaimondFiles.folderId() : '(no folderId)',
		root:   DaimondAttach.root ? DaimondAttach.root() : '(no root)',
		force:  await DaimondAttach.inForce(id, ref),
		at:     (b.attached || []).slice().sort(),
		un:     (b.unconfirmed || []).slice().sort(),
		shared: (await DaimondFiles.shareRoots()).slice().sort(),
	};
}, { id, ref });

/// Put a Diamond on screen, as the rail's click does.
async function openDiamond(id) {
	await p.evaluate(async (id) => {
		await DaimondCore.loadDiamonds();
		const box = document.querySelector('.diamond-box[data-id="' + id + '"]');
		if (box) box.click();
	}, id);
	await sleep(1500);
}

/// The notice over the composer, as it is drawn.
const notice = () => p.evaluate(() => {
	const box = document.getElementById('mark-notice');
	if (!box) return { shown: false, rows: [] };
	const r = box.getBoundingClientRect();
	return { shown: !box.hidden && r.height > 0,
		rows: [...box.querySelectorAll('.mark-notice-row')].map((x) => x.dataset.path).sort() };
});

/// This device's ⇄ on a folder of the open Diamond, pressed in the Workspace panel.
async function shareHere(path) {
	await p.evaluate(() => window.DaimondPanels && (DaimondPanels.open ? DaimondPanels.open('work') : DaimondPanels.show('work')));
	await sleep(500);
	await p.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
	await sleep(700);
	await p.click('.files-scope-chip[data-scope="diamond"]', { force: true }).catch(() => {});
	await sleep(1400);
	const sel = '#panel-work .files-row.attached[data-path="' + path + '"] [data-act="share"]';
	const el = await p.$(sel);
	if (!el) return false;
	await el.click({ force: true });
	await sleep(1500);
	return true;
}

// ── 1. Folder A ──────────────────────────────────────────────────────────────
const pA = await pick('a');
check('1. folder A opened through the Machine chip, the real openFolder', pA.how === 'chip' && pA.landed, J(pA));
const id = await p.evaluate(async () => {
	const d = await DaimondCore.diamondApp().create_diamond('M2 same name');
	await DaimondCore.loadDiamonds();
	return d;
});
await openDiamond(id);
const ref = await p.evaluate(() => DaimondAttach.ref('dir', 'code'));
const m1 = await markHere(s, id, ref);
const shared1 = await shareHere('code');
const a1 = await state(id, ref);
check('1. the mark on code was pressed here', m1.confirmed === true, J(m1));
check('1. and ⇄ was pressed here', shared1 === true);
check('1. in A the mark is held and shared', !!a1.force && a1.force.rel === 'holds' && a1.force.share === true, J(a1.force));
check('1. in A code is in the fence', has(a1.at, 'code'), J(a1));
check('1. in A code is a share root', has(a1.shared, 'code'), J(a1.shared));
check('1. A has a folder id of 128 random bits', /^[0-9a-f]{32}$/.test(a1.fid), a1.fid);
check('1. the record keys A by its name and its id', a1.root === 'machine:usr#' + a1.fid, a1.root);

// ── 2. Folder B, of the same name ─────────────────────────────────────────────
const pB = await pick('b');
check('2. folder B opened through "Change folder…"', pB.how === 'change' && pB.landed, J(pB));
const b2 = await state(id, ref);
check('2. B is another folder called usr', b2.mode === 'folder' && b2.name === 'usr', J({ mode: b2.mode, name: b2.name }));
check('2. B has its own id', /^[0-9a-f]{32}$/.test(b2.fid) && b2.fid !== a1.fid, J({ a: a1.fid, b: b2.fid }));
check('2. in B the mark is NOT in force', b2.force === null, J(b2.force));
check('2. in B code is not in the fence', !has(b2.at, 'code'), J(b2.at));
check('2. in B nothing is shared', Array.isArray(b2.shared) && b2.shared.length === 0, J(b2.shared));
check('2. in B the mark waits for a press', has(b2.un, 'code'), J(b2.un));
await openDiamond(id);
const n2 = await notice();
check('2. and the notice over the composer lists it', n2.shown && has(n2.rows, 'code'), J(n2));

// ── 3. "Use here" in B ────────────────────────────────────────────────────────
const used = await p.evaluate(() => {
	const b = document.querySelector('#mark-notice .mark-notice-row[data-path="code"] [data-act="mark-use-here"]');
	if (!b) return false;
	b.click();
	return true;
});
await sleep(2000);
const b3 = await state(id, ref);
check('3. "Use here" was pressed in B', used === true);
check('3. in B the mark is now held, and unshared: a confirmation never carries ⇄',
	!!b3.force && b3.force.rel === 'holds' && b3.force.share === false, J(b3.force));
check('3. and code is in B\'s fence', has(b3.at, 'code') && !has(b3.un, 'code'), J(b3));

// ── 4. Back to A, through a newly fetched handle ─────────────────────────────
const pA2 = await pick('a');
check('4. folder A opened again through "Change folder…", a new handle', pA2.how === 'change' && pA2.landed, J(pA2));
const a4 = await state(id, ref);
check('4. A\'s id is reused, found by isSameEntry', /^[0-9a-f]{32}$/.test(a4.fid) && a4.fid === a1.fid, J({ was: a1.fid, now: a4.fid }));
check('4. and A\'s mark is still held and shared', !!a4.force && a4.force.rel === 'holds' && a4.force.share === true
	&& has(a4.at, 'code') && has(a4.shared, 'code'), J(a4));

// ── 5. A reload: the boot reconnect ──────────────────────────────────────────
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'm2samename');
await sleep(3500);
const a5 = await state(id, ref);
check('5. the boot reconnected A', a5.mode === 'folder' && a5.name === 'usr', J({ mode: a5.mode, name: a5.name }));
check('5. and kept A\'s id', /^[0-9a-f]{32}$/.test(a5.fid) && a5.fid === a1.fid, J({ was: a1.fid, now: a5.fid }));
check('5. and A\'s mark is held and shared', !!a5.force && a5.force.rel === 'holds' && a5.force.share === true
	&& has(a5.shared, 'code'), J(a5));

// ── Tidy ─────────────────────────────────────────────────────────────────────
await F.tidy();
const errs = s.errs.filter((e) => !/401|502|404|favicon|net::ERR|Failed to load resource/i.test(e));
check('the page threw nothing along the way', errs.length === 0, errs.slice(0, 3).join(' | '));
const ran = ok.length + bad.length;
check('every planned check ran', ran === PLANNED - 1, ran + ' of ' + (PLANNED - 1) + ' before this one');
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
