// verify_diamondroot_recent.mjs — the migration EVERY current user will take.
//
// verify_diamondroot.mjs seeds the oldest shape a workspace can have, `foci/`
// with a `.red/` store. This one seeds the shape almost every real workspace is
// in right now: `facets/` with a `.daimond/` store and a `brief.md`, written by
// the build that shipped yesterday. It is the likelier migration by far, and it
// exercises a different path -- the root move has only ONE hop to make and the
// store move has none, so a bug that hides behind the older seed's two-stage
// walk would show up here instead.
//
// What must survive: the Diamond itself, its crystal, its version number (held
// in a field that has been renamed under it), its history, and any links it had
// asserted, whose stored ends name a kind that no longer exists.
//
// Run with dev/serve.mjs up. No gateway needed.
import { open, signInAs } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const A = 'recent1', B = 'recent2';

const s = await open({ name: 'diamondroot-recent', connect: false });
const p = s.page;
await p.waitForTimeout(1200);

// ── Seed yesterday's shape ──────────────────────────────────────────────
const seeded = await p.evaluate(async ({ a, b }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const w = (path, content) => mod.write_file(path, content);

	for (const [id, name] of [[a, 'Ship the launch'], [b, 'Brand voice']]) {
		await w(`facets/${id}/brief.md`, `# ${name}\n\nWritten yesterday, under the old names.\n`);
		await w(`facets/${id}/versions/0000.md`, '');
		await w(`facets/${id}/versions/0001.md`, `# ${name}\n\nWritten yesterday.\n`);
		await w(`facets/${id}/.daimond/meta.json`,
			`{"name":"${name}","brief_version":1,"updated":1750000000000,"tags":["live"]}`);
		await w(`facets/${id}/.daimond/deltas/0001.md`, `DELTA-${id}: what that fold consumed.`);
		await w(`facets/${id}/.daimond/log`,
			`{"id":"r1","ts":1750000000000,"kind":"create","agent":"user","task":"create",`
			+ `"parent_brief_version":-1,"brief_version":0,"delta_ref":"","note":"${name}"}\n`
			+ `{"id":"r2","ts":1750000000001,"kind":"fold","agent":"reducer","task":"fold delta",`
			+ `"parent_brief_version":0,"brief_version":1,`
			+ `"delta_ref":"facets/${id}/.daimond/deltas/0001.md","note":"folded yesterday"}\n`);
	}

	// A link asserted between the two, with its ends named the way the substrate
	// spelled a Diamond yesterday.
	await w(`facets/${a}/.daimond/links.jsonl`,
		`{"id":"l1","ts":1750000000002,"from":"facet:${a}","to":"facet:${b}",`
		+ `"rel":"informs","note":"The launch copy has to sound like this.","by":"user"}\n`
		+ `{"id":"l2","ts":1750000000003,"from":"facet:${a}","to":"file:notes/pricing.md",`
		+ `"rel":"produced","note":"","by":"agent:worker"}\n`);

	localStorage.setItem('daimond-facet-counter', '4');
	localStorage.setItem('daimond-facet-models', '{"recent1":{"provider":"p","model":"m"}}');
	return true;
}, { a: A, b: B });
check("yesterday's workspace was seeded under facets/", seeded === true);

// ── Boot it the way a user does ─────────────────────────────────────────
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'diamondroot-recent');
await p.waitForTimeout(2500);

const listed = await p.$eval('#diamond-list', e => e.textContent);
check('both Diamonds survived the root move',
	/Ship the launch/.test(listed) && /Brand voice/.test(listed), listed.trim().slice(0, 70));

// ── What is on disk ─────────────────────────────────────────────────────
const disk = await p.evaluate(async ({ a }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const read = async (path) => {
		try { return await mod.read_file(path); } catch (e) { return null; }
	};
	return {
		crystal:  await read(`diamonds/${a}/crystal.md`),
		oldFile:  await read(`diamonds/${a}/brief.md`),
		meta:     await read(`diamonds/${a}/.daimond/meta.json`),
		log:      await read(`diamonds/${a}/.daimond/log`),
		delta:    await read(`diamonds/${a}/.daimond/deltas/0001.md`),
		version:  await read(`diamonds/${a}/versions/0001.md`),
		oldRoot:  await read(`facets/${a}/brief.md`),
	};
}, { a: A });

check('brief.md became crystal.md', /Ship the launch/.test(disk.crystal || ''));
check('and did not linger under its old name', disk.oldFile === null);
check('the snapshots came across', /Ship the launch/.test(disk.version || ''));
check('the retained delta came across', /DELTA-recent1/.test(disk.delta || ''));
check('nothing was left behind under facets/', disk.oldRoot === null);
check('the delta_ref was rewritten to the new root',
	!!disk.log && disk.log.includes(`diamonds/${A}/.daimond/deltas/0001.md`)
	&& !disk.log.includes('facets/'),
	(disk.log || '').split('\n')[1]?.slice(0, 80));

// ── The version, held in a field renamed under it ───────────────────────
const rows = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return JSON.parse(await app.list_diamonds() || '[]');
});
const rowA = rows.find(r => r.id === A);
check('the version survived the field being renamed under it',
	rowA && rowA.crystal_version === 1, String(rowA && rowA.crystal_version));
check('and so did the tags', !!rowA && JSON.stringify(rowA.tags || []).includes('live'),
	JSON.stringify(rowA && rowA.tags));

// ── The links, whose stored ends name a kind that is gone ───────────────
const links = await p.evaluate(async ({ a }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return {
		fromNew: JSON.parse(await app.links_touching(`diamond:${a}`) || '[]'),
		fromOld: JSON.parse(await app.links_touching(`facet:${a}`) || '[]'),
	};
}, { a: A });
check('a link asserted before the rename is found under the NEW kind',
	links.fromNew.length === 2, `${links.fromNew.length} found`);
check('its far end was rewritten too, not just the near one',
	links.fromNew.some(l => l.other === `diamond:${B}`),
	links.fromNew.map(l => l.other).join(', '));
check('a non-Diamond end was left exactly as it was',
	links.fromNew.some(l => l.other === 'file:notes/pricing.md'),
	links.fromNew.map(l => l.other).join(', '));
check('and nothing answers to the old kind any more',
	links.fromOld.length === 0, `${links.fromOld.length} found`);

// ── The keys, one generation back rather than two ───────────────────────
const keys = await p.evaluate(() => ({
	counter: localStorage.getItem('daimond-diamond-counter'),
	models:  localStorage.getItem('daimond-diamond-models'),
	old:     localStorage.getItem('daimond-facet-counter'),
}));
check('the counter carried over from the facet-era key', keys.counter === '4', String(keys.counter));
check('so did the per-Diamond model choices', /recent1/.test(keys.models || ''));
check('and the old key was dropped', keys.old === null);

// ── Idempotence ─────────────────────────────────────────────────────────
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'diamondroot-recent');
await p.waitForTimeout(2500);
const again = await p.$eval('#diamond-list', e => e.textContent);
check('a second boot leaves it alone',
	/Ship the launch/.test(again) && /Brand voice/.test(again), again.trim().slice(0, 60));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
