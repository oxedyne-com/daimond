// gateway: none
// verify_foldland.mjs -- a fold lands whole or not at all, and never dead-ends (D-20261010-01).
//
// The live fault (9 Oct 2026, Ontheism): the fold wrote REQUIREMENTS.md, DECISIONS.md and
// STATE.md, then the crystal was refused against the files' NEW weight on the 16 KiB hot
// ceiling -- three rewritten files, no version, no log row, no undo. Each check is driven
// through the real engine in a page, against the mock reducer:
//
//   E1  all or nothing: a proposal that cannot land is refused and the files, crystal and
//       version are byte-identical afterwards.
//   E2  the hot ceiling at the store door: hot sections over the room go cold and it lands.
//   E3  the hot ceiling at the reducer: an over-long summary is sent back with the room, and
//       the second answer lands (mock reduce mode `fat`).
//   E4  a crystal that does not parse is refused BEFORE the paid round.
//   E5  the fold's one version is its Undo (item 6): `fold_apply` answers the version it minted,
//       and the engine's version undo of it puts every file the fold rewrote back.
//
//   eval "$(bash dev/world.sh 89 --up)" ; eval "$(bash dev/world.sh 89 --env)"
//   node dev/verify_foldland.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, mockLog, clearMockLog } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG  = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');
const REDUCE = LOG + '.reduce';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' -- ' + detail));
	ok ? pass++ : fail++;
};

// The native fixture's files (`compact.rs`, `full_files`): they leave the crystal only its floor.
const fullFiles = () => {
	let req = '# Requirements\n\n';
	for (let i = 0; req.length + 80 < 8 * 1024; i++) {
		req += `- [ ] T${i} ${'an open requirement kept live '.repeat(2)}\n`;
	}
	let st = '# State\n\n';
	while (st.length + 80 < 4 * 1024) st += 'where things are, said once more.\n';
	let dec = '# Decisions\n\n';
	for (let i = 0; i < 200; i++) {
		dec += `- 2026-10-0${i % 9 + 1} a decision recorded with its reason, `
			+ `${'because the record must say why '.repeat(2)}\n`;
	}
	return { 'REQUIREMENTS.md': req, 'DECISIONS.md': dec, 'STATE.md': st };
};
const heavy = (summary, hot, each) => JSON.stringify({
	title: 'T', summary: 's'.repeat(summary),
	sections: Array.from({ length: hot }, (_, i) => ({ heading: `Part ${i}`, hot: true, body: 'b'.repeat(each) })),
});

const s = await open({ name: 'foldland' });
const page = s.page;
await signInAs(s, 'foldland');
await connectMock(s);
await page.waitForTimeout(1500);
const MOCK = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
await page.evaluate(async (mock) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	window.__m  = m;
	window.__vf = new m.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
}, MOCK);

const write = (p, t) => page.evaluate((a) => window.__m.write_file(a.p, a.t), { p, t });
const read  = (p) => page.evaluate((x) => window.__m.read_file(x).catch(() => ''), p);
const call  = (fn, ...args) => page.evaluate(async (a) => {
	try { return { ok: await window.__vf[a.fn](...a.args) }; }
	catch (e) { return { err: String((e && e.message) || e) }; }
}, { fn, args });
const version = async (id) => {
	const rows = JSON.parse((await call('list_diamonds')).ok || '[]');
	const r = rows.find((x) => x.id === id);
	return r ? r.crystal_version : -1;
};
const snapshot = async (id) => {
	const out = {};
	for (const leaf of ['REQUIREMENTS.md', 'DECISIONS.md', 'STATE.md', 'crystal.json']) {
		out[leaf] = await read(`diamonds/${id}/${leaf}`);
	}
	out.version = await version(id);
	return out;
};
const seeded = async (name) => {
	const id = (await call('create_diamond', name)).ok;
	for (const [leaf, text] of Object.entries(fullFiles())) await write(`diamonds/${id}/${leaf}`, text);
	await call('write_crystal_data', id, heavy(200, 0, 0));
	return id;
};
fs.writeFileSync(REDUCE, '');

// ── E1 ──
{
	const id = await seeded('Foldland one');
	const before = await snapshot(id);
	const st = fullFiles()['STATE.md'] + '## Zoapedia\n\nnew.\n';
	const env = JSON.stringify({ crystal: heavy(3 * 1024, 0, 0), state: st });
	const r = await call('fold_apply', id, env, 'the delta', 'verify_foldland E1');
	check('E1 a fold that cannot land is refused', !!r.err, JSON.stringify(r).slice(0, 160));
	const after = await snapshot(id);
	for (const k of Object.keys(before)) {
		check(`E1 ${k} is byte-identical after the refusal`, before[k] === after[k],
			`${String(before[k]).length} -> ${String(after[k]).length}`);
	}
}

// ── E2 ──
{
	const id = await seeded('Foldland two');
	const v0 = await version(id);
	const env = JSON.stringify({ crystal: heavy(300, 3, 1000) });
	const r = await call('fold_apply', id, env, 'the delta', 'verify_foldland E2');
	check('E2 a fold over the hot room lands', !r.err, r.err);
	check('E2 and mints one version', (await version(id)) === v0 + 1, `${v0} -> ${await version(id)}`);
	const c = await read(`diamonds/${id}/crystal.json`);
	check('E2 with a section moved cold', /"hot"\s*:\s*false/.test(c), c.slice(0, 120));
	let said = {};
	try { said = JSON.parse(r.ok); } catch { /* stays empty */ }
	check('E2 and it says so', /Moved/.test(said.said || ''), JSON.stringify(r.ok));
	check('E2 and names the version it minted', said.version === v0 + 1, JSON.stringify(r.ok));
}

// ── E3 ──
{
	fs.writeFileSync(REDUCE, 'fat');
	const id = (await call('create_diamond', 'Foldland three')).ok;
	const v0 = await version(id);
	const p = await call('fold_propose', id, 'the words folded in');
	check('E3 the reducer is sent back with the room and its answer fits', !p.err, p.err);
	let fits = false;
	try { fits = JSON.parse(p.ok).crystal.length < 4096; } catch { /* stays false */ }
	check('E3 the proposal is the second, shorter answer', fits, String(p.ok || '').length);
	const a = p.ok ? await call('fold_apply', id, p.ok, 'the words folded in', 'verify_foldland E3')
		: { err: 'no proposal' };
	check('E3 and it lands', !a.err && (await version(id)) === v0 + 1, a.err);
	fs.writeFileSync(REDUCE, '');
}

// ── E4 ──
{
	const id = (await call('create_diamond', 'Foldland four')).ok;
	await write(`diamonds/${id}/crystal.json`, '{"title": "x", "summary": "a "bare" quote"}');
	clearMockLog();
	const p = await call('fold_propose', id, 'the words folded in');
	check('E4 a damaged crystal is refused', !!p.err && /damaged/i.test(p.err), JSON.stringify(p).slice(0, 160));
	check('E4 before any round is paid', mockLog().length === 0, `${mockLog().length} requests`);
}

// ── E5 ──
{
	const id = await seeded('Foldland five');
	const before = await snapshot(id);
	const env = JSON.stringify({ crystal: heavy(200, 0, 0).replace('"T"', '"T2"'),
		state: '# State\n\nfolded.\n', decisions: before['DECISIONS.md'] + '- 2026-10-10 folded.\n' });
	const r = await call('fold_apply', id, env, 'the delta', 'verify_foldland E5');
	let v = 0;
	try { v = JSON.parse(r.ok).version; } catch { /* stays 0 */ }
	check('E5 the fold lands and names its version', !r.err && v > 0, JSON.stringify(r).slice(0, 160));
	// The rows the version holds, which the page's Undo undoes, and only those: a crystal-only
	// fold has none, and an undo of a path the version never touched is refused outright.
	let files = null;
	try { files = JSON.parse(r.ok).files; } catch { /* stays null */ }
	check('E5 the fold names the files it recorded', Array.isArray(files)
		&& files.includes(`diamonds/${id}/STATE.md`) && files.includes(`diamonds/${id}/DECISIONS.md`)
		&& !files.includes(`diamonds/${id}/REQUIREMENTS.md`), JSON.stringify(files));
	check('E5 STATE.md was rewritten', (await read(`diamonds/${id}/STATE.md`)) === '# State\n\nfolded.\n');
	const o = await call('versions_undo_open', id, v, '[]');
	let t = null;
	try { t = JSON.parse(o.ok).ticket; } catch { /* stays null */ }
	check('E5 the fold version has an undo', t != null, JSON.stringify(o).slice(0, 200));
	if (t != null) await call('versions_restore_close', id, t);
	for (const leaf of ['STATE.md', 'DECISIONS.md', 'REQUIREMENTS.md']) {
		const now = await read(`diamonds/${id}/${leaf}`);
		check(`E5 ${leaf} is back after the undo`, now === before[leaf],
			`${before[leaf].length} -> ${now.length}`);
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
await s.close?.();
process.exit(fail ? 1 : 0);
