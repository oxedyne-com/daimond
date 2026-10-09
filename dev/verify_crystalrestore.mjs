// gateway: none
// verify_crystalrestore.mjs — a turn that leaves a page the load proof did not pass puts back the
// last one that did (K2, D-20261008-08).
//
// r544 HOTFIX (QA-B F-B1..F-B3): the put-back is OFF. The engine now writes nothing and raises
// {type:'crystal_unproven'} instead, and the page offers no "Bring back"; R2 checks that, R3 is gone.
// fire/fb brings the put-back back as a compare-and-swap on the turn's own FAIL verdict.
//
// The Ontheism daimon left a crystal that drew nothing, and it stayed in front of the person. Now,
// where a pass is marked (.daimond/crystal_passed.json, written by the load proof) and a turn leaves
// a different page, the engine writes the passed page back as a version of its own, keeps the
// failing page as the turn's version, and raises {type:'crystal_restored', failing, restored},
// which the page offers back with a "Bring back" toast:
//
//   R1. No mark: the turn's page stays, and nothing is raised.
//   R2. Marked on X, a turn writes Y: X is back, the event names both versions, Y is the failing
//       version, the restore is a new version, and the version count never drops.
//   R3. "Bring back" (the toast's revert) puts Y back.
//   R4. A turn that does not touch the page restores nothing.
//   R5. The toast's button says "Bring back", not "Undo".
//
// The mock turn does not run the load proof, so the mark stays as written.
// Needs a world for the mock provider: `eval "$(bash dev/world.sh N --env)"`.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FOLDER = 'crsfolder';
const MOCK   = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';

const s = await open({ name: 'crystalrestore', connect: false,
	route: async (page) => { page.setDefaultNavigationTimeout(180000); } });
const p = s.page;
await p.waitForTimeout(1500);

await p.evaluate(async ({ folder, mock }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	for (let i = 0; i < 200; i++) {
		try { mod.workspace_mode(); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
	}
	const root = await navigator.storage.getDirectory();
	try { await root.removeEntry(folder, { recursive: true }); } catch (e) { /* first run */ }
	const dir = await root.getDirectoryHandle(folder, { create: true });
	mod.set_workspace_dir(dir, '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e');
	const app  = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const read = async (path) => { try { return await mod.read_file(path); } catch (e) { return null; } };
	// One mock turn: what its tools answered, and every crystal_restored event it raised.
	const turn = async (id, tool, args) => {
		const eng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
		const seen = [], restored = [], unproven = [];
		try {
			await eng.steer_crystal(id, '@tool ' + tool + ' ' + JSON.stringify(args), '[]', '[]', '[]', [],
				(ev) => {
					if (ev.type === 'tool_result') seen.push(String(ev.content || ''));
					if (ev.type === 'crystal_restored') restored.push({ failing: ev.failing, restored: ev.restored });
					if (ev.type === 'crystal_unproven') unproven.push(1);
				});
		} catch (e) { seen.push('THREW: ' + String(e && e.message || e)); }
		return { said: seen.join(' | '), restored, unproven: unproven.length };
	};
	// The load proof's mark, written as the proof writes it: the sha256 hex of the page.
	const mark = async (id, page) => {
		const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(page)))]
			.map((b) => b.toString(16).padStart(2, '0')).join('');
		let d = await navigator.storage.getDirectory();
		for (const seg of ['diamonds', id, '.daimond']) d = await d.getDirectoryHandle(seg, { create: true });
		const w = await (await d.getFileHandle('crystal_passed.json', { create: true })).createWritable();
		await w.write(JSON.stringify({ version: 1, at: 1, page: h, data: '', debug: 0 }));
		await w.close();
	};
	// The versions/ directory's files, read straight off the disk.
	const versions = async (id) => {
		// Daimond's own storage, not the folder opened: a Diamond lives there.
		let d = await navigator.storage.getDirectory();
		try {
			for (const seg of ['diamonds', id, 'versions']) d = await d.getDirectoryHandle(seg);
		} catch (e) { return ['NO VERSIONS DIR: ' + e.name]; }
		const names = [];
		for await (const [name, h] of d.entries()) if (h.kind === 'file') names.push(name);
		return names.sort();
	};
	window.__c = { mod, app, read, turn, mark, versions };
}, { folder: FOLDER, mock: MOCK });

const PAGE = (t) => '<!doctype html><html><body><p>' + t + '</p></body></html>';

const r = await p.evaluate(async ({ X, Y, Z, W }) => {
	const { app, read, turn, mark, versions } = __c;
	// Versions, not files: a version is a page file and a memory file.
	const count = async (id) => new Set((await versions(id)).map((n) => n.split('.')[0])).size;
	const out = {};
	// R1
	const id1 = await app.create_diamond('crystal restore none');
	const page1 = 'diamonds/' + id1 + '/crystal.html';
	await turn(id1, 'file_write', { path: page1, content: X });
	out.t1 = await turn(id1, 'file_write', { path: page1, content: Y });
	out.p1 = await read(page1);
	// R2
	const id = await app.create_diamond('crystal restore');
	const page = 'diamonds/' + id + '/crystal.html';
	const data = 'diamonds/' + id + '/crystal.json';
	await turn(id, 'file_write', { path: page, content: X });
	await mark(id, X);
	out.n0 = await count(id);
	out.t2 = await turn(id, 'file_write', { path: page, content: Y });
	out.p2 = await read(page);
	out.n2 = await count(id);
	// R4 -- the page is Y again, which did not pass, but this turn does not touch it.
	out.t4 = await turn(id, 'file_write', { path: data, content: '{"facts":["one"]}\n' });
	out.p4 = await read(page);
	// R2b -- a turn that leaves the passed page itself restores nothing.
	await turn(id, 'file_write', { path: page, content: Z });
	await mark(id, Z);
	out.t5 = await turn(id, 'file_write', { path: page, content: W });
	out.t6 = await turn(id, 'file_write', { path: page, content: Z });
	out.p6 = await read(page);
	// R5
	let btn = '', aria = '';
	if (window.DaimondUndo) {
		DaimondUndo.able({ text: 'restored', label: 'Bring back', ms: 60000, revert: () => {} });
		const b = [...document.querySelectorAll('button')].find((n) => /Bring back|Undo/.test(n.textContent));
		btn  = b ? b.textContent : '';
		aria = b ? b.getAttribute('aria-label') : '';
		DaimondUndo.able({ text: 'plain', ms: 60000, revert: () => {} });
		const u = [...document.querySelectorAll('button')].find((n) => /Bring back|Undo/.test(n.textContent));
		out.plain = u ? u.textContent : '';
	}
	out.btn = btn; out.aria = aria;
	return out;
}, { X: PAGE('X'), Y: PAGE('Y'), Z: PAGE('Z'), W: PAGE('W') });

const short = (t) => String(t).slice(0, 160);
check('R1. no mark: the page the turn wrote stays', r.p1 === PAGE('Y'), short(r.p1));
check('R1. no mark: nothing is raised', r.t1.restored.length === 0, JSON.stringify(r.t1.restored));
check('R2. marked on X, a turn writes Y: Y stays (nothing is put back, r544 hotfix)', r.p2 === PAGE('Y'), short(r.p2));
check('R2. no crystal_restored is raised', r.t2.restored.length === 0, JSON.stringify(r.t2.restored));
check('R2. crystal_unproven is raised once', r.t2.unproven === 1, String(r.t2.unproven));
check('R2. only the turn is a version: no restore version', r.n2 === r.n0 + 1, r.n0 + ' -> ' + r.n2);
check('R4. a turn that does not touch the page restores nothing',
	r.t4.restored.length === 0 && r.t4.unproven === 0 && r.p4 === PAGE('Y'), JSON.stringify(r.t4.restored) + ' | ' + short(r.p4));
check('R2b. a turn that leaves the passed page restores nothing',
	r.t6.restored.length === 0 && r.t6.unproven === 0 && r.p6 === PAGE('Z'), JSON.stringify(r.t6.restored) + ' | ' + short(r.p6));
check('R5. the toast\'s button says "Bring back"', r.btn === 'Bring back' && r.aria === 'Bring back',
	JSON.stringify([r.btn, r.aria]));
check('R5. an ordinary undo still says "Undo"', /Undo/.test(r.plain), JSON.stringify(r.plain));

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
