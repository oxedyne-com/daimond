// verify_manifestmerge.mjs — two devices each delete in one Diamond, sync both ways, and both
// deletes still revert.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// A version manifest is named by its number (`versions/NNNN.files.json`), and the number is the
// Diamond's counter. Two devices that each record a turn between syncs both take the next number,
// and an import lays the other device's `versions/` over this one's BY NAME -- so it wrote over
// this device's manifest with a different one (re-check of 2026-09-23, R5). A deletion recorded
// here lost its row, its body was then swept as named by nothing, and `file_revert` answered
// "There is no kept copy" for a file the user had been told could be put back.
//
// ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
//
//   1. The premise: device A and device B, holding one Diamond, each delete a file in one turn,
//      and both record it under the SAME version number.
//   2. They sync both ways -- B takes A's copy, then A takes B's -- and each history holds both
//      deletes, once each.
//   3. Both deletes revert on both devices: each its own, and the other's, whose copy travelled.
//   4. A later turn mints a number nothing holds, and the first two deletes are still there.
//   5. After an import taken for a one-sided pull -- which keeps no copy and so moves no counter
//      -- a turn's manifest still does not take the number a refiled one sits at.
//
// Two browser profiles are two devices: each has its own origin-private store and its own
// folder. The copies travel as the sync carries them, `export_diamond` into `import_diamond`.
//
// Needs a world for the mock provider: `eval "$(bash dev/world.sh N --env)"`.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FOLDER = 'mmfolder';
const MOCK   = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';

const device = async (name) => {
	const s = await open({ name, connect: false,
		route: async (page) => { page.setDefaultNavigationTimeout(180000); } });
	await s.page.waitForTimeout(1500);
	await s.page.evaluate(async ({ folder, mock }) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		for (let i = 0; i < 200; i++) {
			try { mod.workspace_mode(); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
		}
		const root = await navigator.storage.getDirectory();
		try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* first run */ }
		const dir = await root.getDirectoryHandle(folder, { create: true });
		mod.set_workspace_dir(dir);
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const read = async (path) => { try { return await mod.read_file(path); } catch (e) { return null; } };
		// A daimon's turn: the mock answers `@tool` with that call.
		const turn = async (id, tool, args) => {
			const eng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
			const seen = [];
			try {
				await eng.steer_crystal(id, '@tool ' + tool + ' ' + JSON.stringify(args),
					JSON.stringify(['vault']), '[]', '[]', [],
					(ev) => { if (ev.type === 'tool_result') seen.push(String(ev.content || '')); });
			} catch (e) { seen.push('THREW: ' + String(e && e.message || e)); }
			return seen.join(' | ').slice(0, 300);
		};
		const history = async (id) => JSON.parse(await app.versions_list(id)).map((r) => ({
			v: r.version, cause: r.cause || '',
			gone: (r.files || []).filter((f) => f.gone).map((f) => f.path) }));
		window.__m = { mod, app, read, turn, history };
	}, { folder: FOLDER, mock: MOCK });
	return s;
};

const A = await device('mmA');
const B = await device('mmB');

// ── The Diamond on both devices, as a first sync leaves it ────────────────────
const id = await A.page.evaluate(() => __m.app.create_diamond('merged history'));
const e0 = await A.page.evaluate((id) => __m.app.export_diamond(id), id);
await B.page.evaluate(async (e0) => { await __m.app.import_diamond(e0, false); }, e0);

// ── 1. Each deletes a file in one turn, before either syncs ──────────────────
const del = (s, name, text) => s.page.evaluate(async ({ id, name, text }) => {
	const path = 'vault/' + name + '.md';
	await __m.mod.write_file(path, text);
	const said = await __m.turn(id, 'file_delete', { path });
	const h = await __m.history(id);
	return { said, gone: (await __m.read(path)) === null, v: h.length ? h[0].v : null };
}, { id, name, text });
const a1 = await del(A, 'a', 'from A');
const b1 = await del(B, 'b', 'from B');
check('1. A deletes a file in a turn', /^Deleted /.test(a1.said) && a1.gone, a1.said.slice(0, 120));
check('1. B deletes another in a turn', /^Deleted /.test(b1.said) && b1.gone, b1.said.slice(0, 120));
check('1. and both recorded it under the same version number (the collision)',
	a1.v !== null && a1.v === b1.v, JSON.stringify({ A: a1.v, B: b1.v }));

// ── 2. Sync both ways: B takes A's copy, then A takes B's ─────────────────────
const take = (s, from) => s.page.evaluate(async ({ id, from }) => {
	let imported = true;
	try { await __m.app.import_diamond(from, true); } catch (e) { imported = 'THREW ' + String(e && e.message || e); }
	return { imported, hist: await __m.history(id) };
}, { id, from });
const gones = (hist) => {
	const seen = {};
	for (const r of hist) for (const g of r.gone) seen[g] = (seen[g] || 0) + 1;
	return seen;
};
const b2 = await take(B, await A.page.evaluate((id) => __m.app.export_diamond(id), id));
check('2. B takes A\'s copy of the Diamond', b2.imported === true, String(b2.imported));
check('2. B\'s history holds both deletes, once each',
	gones(b2.hist)['vault/a.md'] === 1 && gones(b2.hist)['vault/b.md'] === 1, JSON.stringify(b2.hist));
const a2 = await take(A, await B.page.evaluate((id) => __m.app.export_diamond(id), id));
check('2. A takes B\'s copy back', a2.imported === true, String(a2.imported));
check('2. A\'s history holds both deletes, once each',
	gones(a2.hist)['vault/a.md'] === 1 && gones(a2.hist)['vault/b.md'] === 1, JSON.stringify(a2.hist));

// ── 3. Both deletes revert, on both devices ───────────────────────────────────
const revert = (s, name) => s.page.evaluate(async ({ id, name }) => {
	const path = 'vault/' + name + '.md';
	const said = await __m.turn(id, 'file_revert', { path });
	return { said, back: await __m.read(path) };
}, { id, name });
const aa = await revert(A, 'a');
const ab = await revert(A, 'b');
const bb = await revert(B, 'b');
const ba = await revert(B, 'a');
check('3. A\'s delete reverts on A', aa.back === 'from A', aa.said.slice(0, 200));
check('3. and B\'s, whose copy travelled, reverts on A', ab.back === 'from B', ab.said.slice(0, 200));
check('3. B\'s delete reverts on B, after it took A\'s copy', bb.back === 'from B', bb.said.slice(0, 200));
check('3. and A\'s reverts on B', ba.back === 'from A', ba.said.slice(0, 200));

// ── 4. A later turn mints a number nothing holds ─────────────────────────────
const b4 = await B.page.evaluate(async (id) => {
	await __m.mod.write_file('vault/c.md', 'later on B');
	const del = await __m.turn(id, 'file_delete', { path: 'vault/c.md' });
	const rev = await __m.turn(id, 'file_revert', { path: 'vault/c.md' });
	const back = await __m.read('vault/c.md');
	const hist = await __m.history(id);
	const versions = hist.map((r) => r.v);
	return { del, rev, back, dupes: versions.length - new Set(versions).size, hist };
}, id);
check('4. a later turn on B deletes and reverts on a number of its own',
	/^Deleted /.test(b4.del) && b4.back === 'later on B' && b4.dupes === 0, b4.rev.slice(0, 200));
check('4. and both first deletes are still in B\'s history',
	gones(b4.hist)['vault/a.md'] === 1 && gones(b4.hist)['vault/b.md'] === 1, JSON.stringify(gones(b4.hist)));

// ── 5. An import taken for a one-sided pull, then a turn ─────────────────────
// No copy is kept before a one-sided import, so nothing moves the counter past what was refiled,
// and the Diamond's counter is the other device's: the next turn here took the number a refiled
// manifest sits at and wrote its own over it -- unless a number on disk is never minted again.
const id5 = await A.page.evaluate(() => __m.app.create_diamond('one-sided'));
await B.page.evaluate(async (e) => { await __m.app.import_diamond(e, false); },
	await A.page.evaluate((id) => __m.app.export_diamond(id), id5));
const x5 = await A.page.evaluate(async (id) => {
	await __m.mod.write_file('vault/x.md', 'x on A');
	return __m.turn(id, 'file_delete', { path: 'vault/x.md' });
}, id5);
const b5 = await B.page.evaluate(async ({ id, from }) => {
	await __m.mod.write_file('vault/y.md', 'y on B');
	const delY = await __m.turn(id, 'file_delete', { path: 'vault/y.md' });
	let imported = true;
	try { await __m.app.import_diamond(from, false); } catch (e) { imported = 'THREW ' + String(e && e.message || e); }
	await __m.mod.write_file('vault/z.md', 'z on B');
	const delZ = await __m.turn(id, 'file_delete', { path: 'vault/z.md' });
	const revY = await __m.turn(id, 'file_revert', { path: 'vault/y.md' });
	const backY = await __m.read('vault/y.md');
	const revZ = await __m.turn(id, 'file_revert', { path: 'vault/z.md' });
	const backZ = await __m.read('vault/z.md');
	return { delY, imported, delZ, revY, backY, revZ, backZ };
}, { id: id5, from: await A.page.evaluate((id) => __m.app.export_diamond(id), id5) });
check('5. after a one-sided import, a turn\'s delete does not take a refiled manifest\'s number',
	/^Deleted /.test(x5) && /^Deleted /.test(b5.delY) && b5.imported === true && /^Deleted /.test(b5.delZ)
		&& b5.backY === 'y on B' && b5.backZ === 'z on B',
	JSON.stringify({ revY: b5.revY.slice(0, 120), revZ: b5.revZ.slice(0, 120) }));

for (const s of [A, B]) {
	await s.page.evaluate(async (folder) => {
		const root = await navigator.storage.getDirectory();
		try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* tidy */ }
	}, FOLDER);
}
const errs = [...A.errs, ...B.errs].filter(e => !/favicon|404|401|net::ERR|Failed to load resource/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await A.close();
await B.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
