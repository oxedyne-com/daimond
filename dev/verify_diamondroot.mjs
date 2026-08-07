// verify_diamondroot.mjs — a workspace written before the Focus → Diamond rename must open whole.
//
// The rename moved the root every pursuit lives under: `foci/` → `diamonds/`. That is the whole
// store, not a corner of it, so getting it wrong loses everything at once — `list_dir("diamonds")`
// finds nothing, the rail comes up empty, and a user with a year of crystals sees a new install.
// It fails silently, too: no error, just an empty list, which is exactly how a user would fail
// to notice until their work was gone.
//
// The seed here is the OLDEST shape a real workspace can have: `foci/<id>/.red/`, which needs
// BOTH migrations, in order — the root move first, then the per-Diamond store move. That ordering
// is the part worth pinning, because the store migration rewrites log paths that the root move
// has already rewritten once.
//
// Run with dev/serve.mjs up. No gateway needed; nothing here talks to one.
import { open, signInAs } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const ID = 'ancient1';

const s = await open({ name: 'diamondroot', connect: false });
const p = s.page;
await p.waitForTimeout(1200);

// ── Seed a pre-rename workspace, and the two localStorage keys with it ──
const seeded = await p.evaluate(async ({ id }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const w = (path, content) => mod.write_file(path, content);

	// Everything under the OLD root, with the OLD store name inside it.
	await w(`foci/${id}/brief.md`, '# An ancient pursuit\n\nWritten before either rename.\n');
	await w(`foci/${id}/versions/0000.md`, '');
	await w(`foci/${id}/versions/0001.md`, '# An ancient pursuit\n\nWritten before either rename.\n');
	await w(`foci/${id}/.red/meta.json`,
		'{"name":"Ancient pursuit","brief_version":1,"updated":1740000000000}');
	await w(`foci/${id}/.red/deltas/0001.md`, 'ANCIENT-DELTA: what that fold consumed.');
	// The fold's delta_ref is an absolute path into the OLD root AND the OLD store.
	await w(`foci/${id}/.red/log`,
		'{"id":"a1","ts":1740000000000,"kind":"create","agent":"user","task":"create focus",'
		+ '"parent_brief_version":-1,"brief_version":0,"delta_ref":"","note":"Ancient pursuit"}\n'
		+ '{"id":"a2","ts":1740000000001,"kind":"fold","agent":"reducer","task":"fold delta",'
		+ '"parent_brief_version":0,"brief_version":1,'
		+ `"delta_ref":"foci/${id}/.red/deltas/0001.md","note":"folded long ago"}\n`);

	// The keys a long-standing user holds, under their pre-rename names.
	localStorage.setItem('daimond-focus-counter', '7');
	localStorage.setItem('daimond-focus-models', '{"someid":{"provider":"p","model":"m"}}');
	return true;
}, { id: ID });
check('a pre-rename workspace was seeded under foci/', seeded === true);

// ── Boot it the way a user does ─────────────────────────────────────────
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'diamondroot');
await p.waitForTimeout(2500);

// ── What the user sees ──────────────────────────────────────────────────
const listed = await p.$eval('#diamond-list', e => e.textContent);
check('the Diamond survived the root move', /Ancient pursuit/.test(listed), listed.trim().slice(0, 60));

// ── What is on disk ─────────────────────────────────────────────────────
const disk = await p.evaluate(async ({ id }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const read = async (path) => {
		try { return await mod.read_file(path); } catch (e) { return null; }
	};
	return {
		meta:     await read(`diamonds/${id}/.daimond/meta.json`),
		log:      await read(`diamonds/${id}/.daimond/log`),
		delta:    await read(`diamonds/${id}/.daimond/deltas/0001.md`),
		crystal:    await read(`diamonds/${id}/crystal.md`),
		version:  await read(`diamonds/${id}/versions/0001.md`),
		oldCrystal: await read(`foci/${id}/brief.md`),
		staleCrystal: await read(`diamonds/${id}/brief.md`),
		oldMeta:  await read(`foci/${id}/.red/meta.json`),
		oldDelta: await read(`foci/${id}/.red/deltas/0001.md`),
	};
}, { id: ID });

check('the store landed at diamonds/<id>/.daimond/',
	!!disk.meta && /Ancient pursuit/.test(disk.meta));
check('brief.md became crystal.md, and did not linger under the old name',
	/An ancient pursuit/.test(disk.crystal || '') && disk.staleCrystal === null,
	disk.staleCrystal === null ? 'renamed' : 'BOTH present');
check('a meta.json still saying brief_version reports the right version, not 0',
	/"crystal_version":1|"brief_version":1/.test(disk.meta || ''), (disk.meta || '').slice(0, 70));
check('the crystal and its snapshots came across',
	/An ancient pursuit/.test(disk.crystal || '') && /An ancient pursuit/.test(disk.version || ''));
check('the retained delta came across',
	disk.delta === 'ANCIENT-DELTA: what that fold consumed.');
check('nothing was left behind under foci/',
	disk.oldCrystal === null && disk.oldMeta === null && disk.oldDelta === null);

// The check a directory move alone would fail, twice over: the log points at the delta BY PATH,
// and that path named both the old root and the old store.
check('the log’s delta_ref was rewritten through BOTH migrations',
	!!disk.log && disk.log.includes(`diamonds/${ID}/.daimond/deltas/0001.md`)
	&& !disk.log.includes('foci/') && !disk.log.includes('.red/'),
	(disk.log || '').split('\n')[1]?.slice(0, 84));

// ── The localStorage keys a long-standing user holds ────────────────────
const keys = await p.evaluate(() => ({
	counter:    localStorage.getItem('daimond-diamond-counter'),
	models:     localStorage.getItem('daimond-diamond-models'),
	oldCounter: localStorage.getItem('daimond-focus-counter'),
	oldModels:  localStorage.getItem('daimond-focus-models'),
}));
check('the Diamond counter carried over', keys.counter === '7', String(keys.counter));
check('the per-Diamond model choices carried over',
	/someid/.test(keys.models || ''), (keys.models || '').slice(0, 40));
check('the old keys were dropped, not left to rot',
	keys.oldCounter === null && keys.oldModels === null);

// ── The history the user opens, and the delta they click ────────────────
const history = await p.evaluate(async ({ id }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const recs = JSON.parse(await app.log_read(id) || '[]');
	const fold = recs.find(r => r.kind === 'fold');
	if (!fold || !fold.delta_ref) return { recs: recs.length, delta: null };
	return { recs: recs.length, ref: fold.delta_ref,
		delta: await app.run_tool('file_read', JSON.stringify({ path: fold.delta_ref })) };
}, { id: ID });
check('the history reads back whole', history.recs === 2, history.recs + ' records');
check('a fold made before either rename can still show its delta',
	/ANCIENT-DELTA/.test(history.delta || ''), history.ref);

// ── Idempotence: a second boot must not undo the first ──────────────────
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'diamondroot');
await p.waitForTimeout(2500);
const again = await p.$eval('#diamond-list', e => e.textContent);
check('a second boot leaves it alone', /Ancient pursuit/.test(again), again.trim().slice(0, 60));

// ── Both roots present: MERGE what does not collide ─────────────────────
//
// This used to assert the opposite — "the old one is left alone rather than
// merged" — and that refusal was the hazard, not the safeguard. `diamonds/`
// exists the moment anyone creates a single Diamond, so a `foci/` arriving
// afterwards (a restored backup, a sync from an older device, a folder adopted
// later) went into a directory nothing reads and stayed there for ever. Moving
// an id that is not already present overwrites nothing, so it is strictly safer
// than leaving it unreachable.
const merged = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	// An old root alongside the new one, holding a DIFFERENT Diamond, the way a
	// restored backup arrives.
	await mod.write_file('foci/latecomer/crystal.md', 'a pursuit that arrived afterwards');
	await mod.write_file('foci/latecomer/.daimond/meta.json',
		'{"name":"Latecomer","brief_version":0,"updated":1}');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const listed = await app.list_diamonds();      // triggers migrate_root again
	const read = async (path) => { try { return await mod.read_file(path); } catch (e) { return null; } };
	return {
		listed,
		moved:   await read('diamonds/latecomer/crystal.md'),
		leftOld: await read('foci/latecomer/crystal.md'),
		// The original Diamond of this file, which must not have moved or changed.
		ancient: await read('diamonds/ancient1/crystal.md'),
	};
});
check('a Diamond that arrives in an old root AFTERWARDS is taken into diamonds/',
	merged.moved === 'a pursuit that arrived afterwards', String(merged.moved).slice(0, 50));
check('and it is in the list, so the user can actually see it',
	/Latecomer/.test(merged.listed), merged.listed.slice(0, 120));
check('the emptied old root is gone, not left as a second place to look',
	merged.leftOld === null, String(merged.leftOld));
check('and the Diamond already in diamonds/ was not disturbed',
	/An ancient pursuit/.test(merged.ancient || ''), String(merged.ancient).slice(0, 40));

// ── A genuine id collision is the one case the merge does NOT attempt ───
//
// Which copy is the user's current work is not answerable from inside the
// migration, and overwriting the one they can see with one they cannot is the
// loss the whole function exists to avoid. So it stays where it is, and
// `legacy_root_waiting` keeps saying so.
// A collision is planted ALONGSIDE a clean entry, and that pairing is the point.
//
// `move_entry` refuses to clobber on its own, so a merge that simply tried every
// entry would still overwrite nothing — but it would THROW on the collision and
// abandon the walk, stranding whatever had not been reached. Recognising the
// collision by name and stepping over it is what turns a failure into an
// outcome. Measured as such: the migration must complete WITHOUT ERROR. That is
// order-independent, where "the entry behind it still arrived" is not — OPFS
// does not promise the order a directory iterates in, so the stranded entry may
// or may not be the one this file happened to plant second.
const logsBefore = s.logs.length;
const collide = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	// The SAME id as the Diamond already in diamonds/, with different content...
	await mod.write_file('foci/ancient1/crystal.md', 'a DIFFERENT pursuit under the same id');
	await mod.write_file('foci/ancient1/.daimond/meta.json',
		'{"name":"Impostor","brief_version":0,"updated":1}');
	// ...and a clean one that sorts AFTER it, so a walk that stops on the
	// collision never reaches it.
	await mod.write_file('foci/zzlater/crystal.md', 'behind the collision in the walk');
	await mod.write_file('foci/zzlater/.daimond/meta.json',
		'{"name":"Behind it","brief_version":0,"updated":1}');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const listed = await app.list_diamonds();
	const read = async (path) => { try { return await mod.read_file(path); } catch (e) { return null; } };
	return {
		listed,
		current: await read('diamonds/ancient1/crystal.md'),
		old:     await read('foci/ancient1/crystal.md'),
		behind:  await read('diamonds/zzlater/crystal.md'),
		waiting: await app.legacy_diamond_root_waiting(),
	};
});
check('a colliding id does NOT overwrite the copy the user can see',
	/An ancient pursuit/.test(collide.current || ''), String(collide.current).slice(0, 40));
check('and the old copy is still there, not deleted out from under them',
	collide.old === 'a DIFFERENT pursuit under the same id', String(collide.old).slice(0, 50));
check('the clean entry beside it still came across',
	collide.behind === 'behind the collision in the walk', String(collide.behind));
{
	// A COLLISION IS AN OUTCOME, NOT A FAILURE. If the walk throws on it instead
	// of stepping over it, everything it had not yet reached is stranded — and
	// which entries those are is down to an iteration order nothing promises.
	const failed = s.logs.slice(logsBefore)
		.filter((l) => /root could not be migrated/i.test(l));
	check('and the migration completed without erroring out of the walk',
		failed.length === 0, failed.length ? failed[0].slice(0, 160) : 'no migration error logged');
}
check('and the store says an older root is still waiting, so nothing seeds over it',
	collide.waiting === true, String(collide.waiting));
check('the rail shows one of them, not two rows for one id',
	(collide.listed.match(/"id":"ancient1"/g) || []).length === 1,
	collide.listed.slice(0, 120));

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
