// verify_migration.mjs — a workspace written before the rename must open with everything in it.
//
// The Red → Daimond rename moved two things a user's workspace actually holds: the per-Diamond
// store (`diamonds/<id>/.red/` → `.daimond/`) and the standing-instructions file (`RED.md` →
// `DAIMOND.md`). Neither is Daimond's to lose. A Diamond whose store is not found does not fail
// loudly — `read_meta` errors, `list` skips it, and a pursuit with a year of folds in it simply
// is not in the list any more. That is the failure this drives.
//
// So the test seeds a workspace exactly as the old code would have left one, boots the app on it
// the way a user does, and then asks the questions a user would: is my Diamond there, is its
// history there, and can I still read the delta of a fold I made before the rename?
//
// The seed below lands AFTER a boot, and that is the harder of the two orders on purpose.
// `open()` signs in, which draws the app, which runs `Instructions.refresh()` -- and since the
// starter shipped that refresh puts a `DAIMOND.md` in the store before this file has written a
// line. So the pre-rename `RED.md` here arrives beside a starter, exactly as one carried in by
// sync or found in a folder opened later does, and the migration has to beat a file that is
// already sitting at its destination. The easy order -- `RED.md` alone, no starter anywhere --
// is the one that never needed a check.
import { open, signInAs, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const ID   = 'legacy1';
const RULE = 'HOUSE RULE: every answer ends with ZZ-HOUSE.';

// A fresh profile, so the OPFS sandbox starts empty and what is in it is what we put there.
const s = await open({ name: 'migrate', connect: false });
const p = s.page;
await p.waitForTimeout(1200);

// ── Seed a workspace as the pre-rename code would have left it ──────────
//
// Written through the wasm file surface, which with no real folder open resolves against the
// same OPFS sandbox the Diamond store lives in — so these are the very bytes the old app wrote.
const seeded = await p.evaluate(async ({ id, rule }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const w = (path, content) => mod.write_file(path, content);

	// The crystal and its snapshots sit OUTSIDE the store directory and never moved.
	// It is markdown, because that is what a workspace of this vintage holds: the
	// boot below therefore runs the crystal's own conversion as well as the store
	// move, which is exactly what a real one of these does.
	await w(`diamonds/${id}/crystal.md`, '# The old pursuit\n\nA crystal written before the rename.\n');
	await w(`diamonds/${id}/versions/0000.md`, '');
	await w(`diamonds/${id}/versions/0001.md`, '# The old pursuit\n\nA crystal written before the rename.\n');

	// The store, under its old name.
	await w(`diamonds/${id}/.red/meta.json`,
		'{"name":"An old pursuit","crystal_version":1,"updated":1750000000000}');
	await w(`diamonds/${id}/.red/deltas/0001.md`, 'THE-OLD-DELTA: what the fold consumed.');
	// Two log records. The fold's `delta_ref` is a PATH, and it points into the old directory —
	// which is why moving the files alone would not be enough.
	await w(`diamonds/${id}/.red/log`,
		'{"id":"r1","ts":1750000000000,"kind":"create","agent":"user","task":"create diamond",'
		+ '"parent_crystal_version":-1,"crystal_version":0,"delta_ref":"","note":"An old pursuit"}\n'
		+ '{"id":"r2","ts":1750000000001,"kind":"fold","agent":"reducer","task":"fold delta",'
		+ '"parent_crystal_version":0,"crystal_version":1,'
		+ `"delta_ref":"diamonds/${id}/.red/deltas/0001.md","note":"folded before the rename"}\n`);

	// And the house rules, at the workspace root, under their old name.
	await w('RED.md', rule);
	return true;
}, { id: ID, rule: RULE });
check('a pre-rename workspace was seeded', seeded === true);

// ── Boot the app on it, the way a user does ─────────────────────────────
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'migrate');
await p.waitForTimeout(2500);      // loadDiamonds() and Instructions.refresh() run on unlock

// ── What the user sees ──────────────────────────────────────────────────
const listed = await p.$eval('#diamond-list', e => e.textContent);
check('the Diamond is still in the list', /An old pursuit/.test(listed), listed.trim().slice(0, 60));

const chip = await p.evaluate(() => {
	const el = document.getElementById('instructions-chip');
	return el && el.style.display !== 'none' ? el.textContent.trim() : '(hidden)';
});
check('the standing instructions are still in force', /DAIMOND\.md/.test(chip), chip);

// ── What is actually on disk ────────────────────────────────────────────
const disk = await p.evaluate(async ({ id }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const read = async (path) => {
		try { return await mod.read_file(path); }
		catch (e) { return null; }               // absent, which for the old paths is the point
	};
	return {
		newMeta:  await read(`diamonds/${id}/.daimond/meta.json`),
		newLog:   await read(`diamonds/${id}/.daimond/log`),
		newDelta: await read(`diamonds/${id}/.daimond/deltas/0001.md`),
		oldMeta:  await read(`diamonds/${id}/.red/meta.json`),
		oldLog:   await read(`diamonds/${id}/.red/log`),
		oldDelta: await read(`diamonds/${id}/.red/deltas/0001.md`),
		crystal:    await read(`diamonds/${id}/crystal.json`),
		oldCrystal: await read(`diamonds/${id}/crystal.md`),
		version:  await read(`diamonds/${id}/versions/0001.md`),
		newRules: await read('DAIMOND.md'),
		oldRules: await read('RED.md'),
	};
}, { id: ID });

check('the store moved to .daimond/', !!disk.newMeta && /An old pursuit/.test(disk.newMeta));
check('the log came with it', !!disk.newLog && /folded before the rename/.test(disk.newLog));
check('the retained delta came with it',
	disk.newDelta === 'THE-OLD-DELTA: what the fold consumed.');
check('nothing was left behind in .red/',
	disk.oldMeta === null && disk.oldLog === null && disk.oldDelta === null);
// The store move leaves the crystal alone; the crystal's own conversion, which
// runs in the same pass, turns it into data. Both migrations are asserted by
// what SURVIVES rather than by what moved: the user's words are in `crystal.json`
// and the markdown history is exactly where it was.
check('the crystal came through as data, carrying the same words',
	/A crystal written before the rename/.test(disk.crystal || '')
	&& (disk.crystal || '').trim().startsWith('{'),
	(disk.crystal || '(absent)').slice(0, 80));
// The markdown is KEPT beside it, deliberately. The conversion self-checks by
// rendering back and comparing bytes, which structurally cannot prove the
// STRUCTURE is right -- a `##` inside a fence rejoins to identical bytes whether
// or not the fence was honoured -- so the one failure that would justify still
// having the markdown is exactly the one the check cannot see. And
// `import_diamond` deletes a Diamond's directory before rewriting it, so a bad
// conversion propagates back over a good copy on the next sync.
check('and the markdown is kept beside it, because lossless is not the same as proven',
	disk.oldCrystal !== null, disk.oldCrystal === null ? 'DELETED' : 'kept');
check('the markdown snapshots were untouched, so the conversion is reversible',
	/A crystal written before the rename/.test(disk.version || ''));

// The one that a directory move alone would fail: the log points at the delta BY PATH.
check('the log’s delta_ref was rewritten to the new path',
	!!disk.newLog && disk.newLog.includes(`diamonds/${ID}/.daimond/deltas/0001.md`)
	&& !disk.newLog.includes('.red/'),
	(disk.newLog || '').split('\n')[1]?.slice(0, 72));

check('RED.md became DAIMOND.md', disk.newRules === RULE && disk.oldRules === null);

// ── The history the user opens, and the delta they click ────────────────
const history = await p.evaluate(async ({ id }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	// Read the delta exactly as the History panel does: by the path the log record carries.
	const app  = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const recs = JSON.parse(await app.log_read(id) || '[]');
	const fold = recs.find(r => r.kind === 'fold');
	if (!fold || !fold.delta_ref) return { recs: recs.length, delta: null };
	const delta = await app.run_tool('file_read', JSON.stringify({ path: fold.delta_ref }));
	return { recs: recs.length, ref: fold.delta_ref, delta };
}, { id: ID });
check('the history reads back whole', history.recs === 2, history.recs + ' records');
check('a fold made before the rename can still show its delta',
	/THE-OLD-DELTA/.test(history.delta || ''),
	history.ref);

// ── Idempotence: a second boot must not undo the first ──────────────────
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'migrate');
await p.waitForTimeout(2000);
const again = await p.$eval('#diamond-list', e => e.textContent);
const stillThere = await p.evaluate(async ({ id }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	try { return await mod.read_file(`diamonds/${id}/.daimond/meta.json`); } catch { return null; }
}, { id: ID });
check('a second boot migrates nothing and breaks nothing',
	/An old pursuit/.test(again) && !!stillThere);

// ── The other side of it: rules the user WROTE are not overwritten ──────
//
// `migrate` carries `RED.md` over a `DAIMOND.md` that is the starter to the byte. This is the
// check that keeps that from becoming "carries it over anything": edit the file the way a user
// would, put an old `RED.md` back beside it, and the edit must still be there afterwards. Break
// the byte comparison and this goes red while the check above stays green, which is the only
// arrangement in which either of them is worth reading.
const MINE = 'MY OWN RULES: answer in Latin.';
await p.evaluate(async ({ mine, rule }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	await mod.write_file('DAIMOND.md', mine);
	await mod.write_file('RED.md', rule);
}, { mine: MINE, rule: RULE });
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'migrate');
await p.waitForTimeout(2500);
const kept = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const read = async (path) => { try { return await mod.read_file(path); } catch (e) { return null; } };
	return { mine: await read('DAIMOND.md'), old: await read('RED.md') };
});
check('rules the user wrote are not replaced by their old ones',
	kept.mine === MINE, JSON.stringify(kept.mine));
check('and the old file is left where it was, not silently dropped',
	kept.old === RULE, JSON.stringify(kept.old));

await shot(s, 'migration');
const errs = s.errs.filter(e => !/favicon|404|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
