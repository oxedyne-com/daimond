// gateway: none
// verify_crystalrevert.mjs — a daimon's file_revert puts a crystal's page and memory back (fix 7).
//
// Found 2026-10-08 driving the Ontheism daimon (D-20261008-08): asked to undo a crystal page it
// had written, the daimon was told "There is no kept copy of crystal.html". The crystal's two
// files are not in the files store -- their history is the crystal chain, versions/NNNN.html and
// .json, written at turn end -- so file_revert never found a row for them. It now reverts them
// from that chain:
//
//   C1. A page written in one turn and reverted in the next goes back to the shipped page (empty).
//   C2. Write A, write B, revert: A.
//   C3. Write C and revert in ONE turn: the page as the turn found it.
//   C4. The memory, crystal.json, reverts the same way.
//   C5. file_glob over versions/ finds what file_list lists, whether the pattern is spelled from
//       the workspace root or from the `path` the walk starts at.
//
// Needs a world for the mock provider: `eval "$(bash dev/world.sh N --env)"`.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FOLDER = 'crfolder';
const MOCK   = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';

const s = await open({ name: 'crystalrevert', connect: false,
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
	const said = async (id, text) => {
		const eng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
		const seen = [];
		try {
			await eng.steer_crystal(id, text, '[]', '[]', '[]', [],
				(ev) => { if (ev.type === 'tool_result') seen.push(String(ev.content || '')); });
		} catch (e) { seen.push('THREW: ' + String(e && e.message || e)); }
		return seen;
	};
	const turn  = async (id, tool, args) => (await said(id, '@tool ' + tool + ' ' + JSON.stringify(args))).join(' | ');
	const turns = async (id, calls) => (await said(id, '@tools ' + calls.map(([t, a]) =>
		t + ' ' + JSON.stringify(a)).join(' ;; '))).join(' | ');
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
	window.__c = { mod, app, read, turn, turns, versions };
}, { folder: FOLDER, mock: MOCK });

const id = await p.evaluate(() => __c.app.create_diamond('crystal revert'));
const PAGE = (t) => '<!doctype html><html><body><p>' + t + '</p></body></html>';

const r = await p.evaluate(async ({ id, A, B, C }) => {
	const { read, turn, turns, versions } = __c;
	const page = 'diamonds/' + id + '/crystal.html';
	const data = 'diamonds/' + id + '/crystal.json';
	const out = {};
	// C1
	out.w1   = await turn(id, 'file_write', { path: page, content: A });
	out.r1   = await turn(id, 'file_revert', { path: page });
	out.p1   = await read(page);
	// C2
	await turn(id, 'file_write', { path: page, content: A });
	await turn(id, 'file_write', { path: page, content: B });
	out.r2   = await turn(id, 'file_revert', { path: page });
	out.p2   = await read(page);
	// C3
	out.r3   = await turns(id, [['file_write', { path: page, content: C }], ['file_revert', { path: page }]]);
	out.p3   = await read(page);
	// C4
	// A fresh Diamond's memory is empty, so the turn writes two of its own.
	const D1 = '{"facts":["one"]}\n', D2 = '{"facts":["one","two"]}\n';
	out.d0   = D1;
	out.dw   = await turn(id, 'file_write', { path: data, content: D1 }) + ' | '
		+ await turn(id, 'file_write', { path: data, content: D2 });
	out.d1ok = (await read(data)) === D2;
	out.r4   = await turn(id, 'file_revert', { path: data });
	out.d2   = await read(data);
	// C5
	out.names = await versions(id);
	out.g1 = await turn(id, 'file_glob', { pattern: 'diamonds/' + id + '/versions/**' });
	out.g2 = await turn(id, 'file_glob', { path: 'diamonds/' + id, pattern: 'versions/**' });
	out.g3 = await turn(id, 'file_glob', { path: 'diamonds/' + id + '/versions', pattern: '*' });
	return out;
}, { id, A: PAGE('A'), B: PAGE('B'), C: PAGE('C') });

const short = (t) => String(t).slice(0, 200);
check('C1. the page was written', /Wrote|wrote|bytes/.test(r.w1), short(r.w1));
check('C1. file_revert of a page written last turn puts the shipped page back',
	/back/.test(r.r1) && (r.p1 === '' || r.p1 === null), short(r.r1) + ' | now ' + JSON.stringify(short(r.p1)));
check('C2. write A, write B, revert: A', r.p2 === PAGE('A'), short(r.r2) + ' | now ' + short(r.p2));
check('C3. write C and revert in one turn: the page as the turn found it (A)', r.p3 === PAGE('A'),
	short(r.r3) + ' | now ' + short(r.p3));
check('C4. crystal.json was rewritten', r.d1ok, short(r.dw));
check('C4. and file_revert puts the memory back', r.d2 === r.d0, short(r.r4));
const found = (g) => [...String(g).matchAll(/versions\/([^\s\t|]+)\t/g)].map((m) => m[1]).sort();
const bare  = (g) => String(g).split('\n').map((l) => l.split('\t')[0].trim())
	.filter((l) => /^\d/.test(l)).sort();
const same  = (a) => JSON.stringify(a) === JSON.stringify(r.names);
check('C5. there are versions to find', r.names.length > 0, r.names.join(' '));
check("C5. file_glob 'diamonds/<id>/versions/**' finds them all", same(found(r.g1)), short(r.g1));
check("C5. file_glob {path:'diamonds/<id>', pattern:'versions/**'} finds them all", same(found(r.g2)), short(r.g2));
check("C5. file_glob {path:'diamonds/<id>/versions', pattern:'*'} finds them all",
	same(found(r.g3)) || same(bare(r.g3)), short(r.g3));

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
