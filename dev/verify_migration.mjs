// verify_migration.mjs — a workspace written before the rename must open with everything in it.
//
// The Red → Daimond rename moved two things a user's workspace actually holds: the per-Facet
// store (`facets/<id>/.red/` → `.daimond/`) and the standing-instructions file (`RED.md` →
// `DAIMOND.md`). Neither is Daimond's to lose. A Facet whose store is not found does not fail
// loudly — `read_meta` errors, `list` skips it, and a pursuit with a year of folds in it simply
// is not in the list any more. That is the failure this drives.
//
// So the test seeds a workspace exactly as the old code would have left one, boots the app on it
// the way a user does, and then asks the questions a user would: is my Facet there, is its
// history there, and can I still read the delta of a fold I made before the rename?
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
// same OPFS sandbox the Facet store lives in — so these are the very bytes the old app wrote.
const seeded = await p.evaluate(async ({ id, rule }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const w = (path, content) => mod.write_file(path, content);

	// The brief and its snapshots sit OUTSIDE the store directory and never moved.
	await w(`facets/${id}/brief.md`, '# The old pursuit\n\nA brief written before the rename.\n');
	await w(`facets/${id}/versions/0000.md`, '');
	await w(`facets/${id}/versions/0001.md`, '# The old pursuit\n\nA brief written before the rename.\n');

	// The store, under its old name.
	await w(`facets/${id}/.red/meta.json`,
		'{"name":"An old pursuit","brief_version":1,"updated":1750000000000}');
	await w(`facets/${id}/.red/deltas/0001.md`, 'THE-OLD-DELTA: what the fold consumed.');
	// Two log records. The fold's `delta_ref` is a PATH, and it points into the old directory —
	// which is why moving the files alone would not be enough.
	await w(`facets/${id}/.red/log`,
		'{"id":"r1","ts":1750000000000,"kind":"create","agent":"user","task":"create facet",'
		+ '"parent_brief_version":-1,"brief_version":0,"delta_ref":"","note":"An old pursuit"}\n'
		+ '{"id":"r2","ts":1750000000001,"kind":"fold","agent":"reducer","task":"fold delta",'
		+ '"parent_brief_version":0,"brief_version":1,'
		+ `"delta_ref":"facets/${id}/.red/deltas/0001.md","note":"folded before the rename"}\n`);

	// And the house rules, at the workspace root, under their old name.
	await w('RED.md', rule);
	return true;
}, { id: ID, rule: RULE });
check('a pre-rename workspace was seeded', seeded === true);

// ── Boot the app on it, the way a user does ─────────────────────────────
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'migrate');
await p.waitForTimeout(2500);      // loadFacets() and Instructions.refresh() run on unlock

// ── What the user sees ──────────────────────────────────────────────────
const listed = await p.$eval('#facet-list', e => e.textContent);
check('the Facet is still in the list', /An old pursuit/.test(listed), listed.trim().slice(0, 60));

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
		newMeta:  await read(`facets/${id}/.daimond/meta.json`),
		newLog:   await read(`facets/${id}/.daimond/log`),
		newDelta: await read(`facets/${id}/.daimond/deltas/0001.md`),
		oldMeta:  await read(`facets/${id}/.red/meta.json`),
		oldLog:   await read(`facets/${id}/.red/log`),
		oldDelta: await read(`facets/${id}/.red/deltas/0001.md`),
		brief:    await read(`facets/${id}/brief.md`),
		version:  await read(`facets/${id}/versions/0001.md`),
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
check('the brief and its snapshots were untouched',
	/A brief written before the rename/.test(disk.brief || '')
	&& /A brief written before the rename/.test(disk.version || ''));

// The one that a directory move alone would fail: the log points at the delta BY PATH.
check('the log’s delta_ref was rewritten to the new path',
	!!disk.newLog && disk.newLog.includes(`facets/${ID}/.daimond/deltas/0001.md`)
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
const again = await p.$eval('#facet-list', e => e.textContent);
const stillThere = await p.evaluate(async ({ id }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	try { return await mod.read_file(`facets/${id}/.daimond/meta.json`); } catch { return null; }
}, { id: ID });
check('a second boot migrates nothing and breaks nothing',
	/An old pursuit/.test(again) && !!stillThere);

await shot(s, 'migration');
const errs = s.errs.filter(e => !/favicon|404|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
