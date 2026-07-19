// verify_links.mjs — the link substrate: one stored record, found from both ends.
//
// Links are the layer under whatever gets built on them, so what matters here is not a
// feature but the guarantees the rest will rest on: that a link is stored ONCE and still
// found from either end, that its ends can name things that are not Facets, that direction
// survives even though both ends find it, that provenance says who drew it, and that an
// agent can read and write the sidecar with the file tools it already has — because if it
// cannot, "agents read and write the graph" needs a whole tool surface that does not exist.
//
// Run with dev/serve.mjs up. No gateway needed.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'links', connect: false });
const p = s.page;
await p.waitForTimeout(2500);   // open() has already signed in; wait for the app to settle

// ── Two Facets to hang links between ────────────────────────────────────
const ids = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const a = await app.create_facet('Ship the launch');
	const b = await app.create_facet('Brand voice');
	return { a, b };
});
check('two Facets were created', !!ids.a && !!ids.b, `${ids.a} / ${ids.b}`);

const call = (fn, args = []) => p.evaluate(async ({ fn, args }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return await app[fn](...args);
}, { fn, args });

// ── A link, asserted once ───────────────────────────────────────────────
const linkId = await call('add_link', [
	ids.a, `facet:${ids.a}`, `facet:${ids.b}`, 'Informs',
	'The launch copy has to sound like this.', 'user',
]);
check('a link was asserted', typeof linkId === 'string' && linkId.length > 0, linkId);

// ── Found from the end it was asserted from ─────────────────────────────
const fromA = JSON.parse(await call('links_touching', [`facet:${ids.a}`]));
check('found from the end it was asserted from', fromA.length === 1, `${fromA.length} link(s)`);
check('the relation was normalised, as a Facet tag would be',
	fromA[0]?.rel === 'informs', fromA[0]?.rel);
check('the note was kept as written',
	fromA[0]?.note === 'The launch copy has to sound like this.', fromA[0]?.note);
check('provenance says who drew it', fromA[0]?.by === 'user', fromA[0]?.by);
check('the owner is carried, so it can be deleted without a search',
	fromA[0]?.owner === ids.a, fromA[0]?.owner);

// ── And from the OTHER end, with no second copy stored ──────────────────
const fromB = JSON.parse(await call('links_touching', [`facet:${ids.b}`]));
check('the same link is found from the far end', fromB.length === 1, `${fromB.length} link(s)`);
check('it is the SAME record, not a mirrored copy', fromB[0]?.id === linkId, fromB[0]?.id);
check('the far end is told which end is the other one',
	fromB[0]?.other === `facet:${ids.a}`, fromB[0]?.other);
check('direction survived being found from the wrong end',
	fromB[0]?.from === `facet:${ids.a}` && fromB[0]?.to === `facet:${ids.b}`,
	`${fromB[0]?.from} -> ${fromB[0]?.to}`);

// Only one record exists on disk, in one sidecar.
const onDisk = await p.evaluate(async ({ a, b }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const read = async (path) => {
		try { return await mod.read_file(path); } catch (e) { return null; }
	};
	return {
		a: await read(`facets/${a}/.daimond/links.jsonl`),
		b: await read(`facets/${b}/.daimond/links.jsonl`),
	};
}, ids);
check('the record is stored once, in the asserting Facet’s sidecar',
	(onDisk.a || '').trim().split('\n').filter(Boolean).length === 1 && onDisk.b === null,
	`a=${(onDisk.a || '').length}b b=${onDisk.b === null ? 'absent' : 'present'}`);

// ── The node space is not Facets only ───────────────────────────────────
await call('add_link', [ids.a, `facet:${ids.a}`, 'file:notes/pricing.md', 'produced', '', 'agent:worker-1']);
await call('add_link', [ids.a, `facet:${ids.a}`, 'url:https://stripe.com/docs?a=1', 'consulted', '', 'user']);
await call('add_link', [ids.a, `facet:${ids.a}`, 'email:msg-99@example.com', 'from', '', 'user']);

const all = JSON.parse(await call('links_touching', [`facet:${ids.a}`]));
check('a Facet can link to a file', all.some(l => l.to === 'file:notes/pricing.md'));
check('a Facet can link to a page, colons in the URL and all',
	all.some(l => l.to === 'url:https://stripe.com/docs?a=1'),
	all.find(l => l.to.startsWith('url:'))?.to);
check('a kind this build does not model is stored rather than refused',
	all.some(l => l.to === 'email:msg-99@example.com'));
check('an agent-asserted link says so',
	all.find(l => l.to === 'file:notes/pricing.md')?.by === 'agent:worker-1');

// A file is a node too, so the link is findable from the file's side.
const fromFile = JSON.parse(await call('links_touching', ['file:notes/pricing.md']));
check('a link is findable from the file end as well',
	fromFile.length === 1 && fromFile[0].other === `facet:${ids.a}`, `${fromFile.length} link(s)`);

// ── What is refused ─────────────────────────────────────────────────────
const selfLink = await call('add_link', [ids.a, `facet:${ids.a}`, `facet:${ids.a}`, '', '', 'user'])
	.then(() => 'accepted').catch(() => 'refused');
check('a link from a thing to itself is refused', selfLink === 'refused', selfLink);

const badRef = await call('add_link', [ids.a, `facet:${ids.a}`, 'not a reference', '', '', 'user'])
	.then(() => 'accepted').catch(() => 'refused');
check('an end that is not a kind:rest reference is refused', badRef === 'refused', badRef);

// ── An agent can reach the sidecar with the tools it already has ────────
//
// This is the load-bearing one. The sidecar sits inside `.daimond/`, and if the tool
// fence covered it, agents could not touch the graph at all without a new tool surface.
const agent = await p.evaluate(async ({ a }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const path = `facets/${a}/.daimond/links.jsonl`;
	const read = await app.run_tool('file_read', JSON.stringify({ path }));
	// Append a link the way an agent would: by writing the file.
	const line = JSON.stringify({
		id: 'agent-made-1', ts: 1700000000000,
		from: `facet:${a}`, to: 'file:notes/agent-wrote-this.md',
		rel: 'produced', note: 'written straight into the sidecar', by: 'agent:tester',
	});
	const wrote = await app.run_tool('file_write',
		JSON.stringify({ path, content: read.replace(/\n*$/, '\n') + line + '\n' }));
	return { read, wrote };
}, ids);
check('an agent can READ the sidecar with file_read',
	/facet:/.test(agent.read || ''), (agent.read || '').slice(0, 40));
check('an agent can WRITE the sidecar with file_write',
	!/error|refus|denied/i.test(agent.wrote || ''), (agent.wrote || '').slice(0, 60));

const afterAgent = JSON.parse(await call('links_touching', [`facet:${ids.a}`]));
check('the link the agent wrote is read back by the store',
	afterAgent.some(l => l.id === 'agent-made-1' && l.by === 'agent:tester'),
	`${afterAgent.length} link(s)`);

// ── A hand-edited sidecar is forgiving ──────────────────────────────────
const handEdit = await p.evaluate(async ({ a }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const path = `facets/${a}/.daimond/links.jsonl`;
	const text = await mod.read_file(path);
	// A person edits this file. One line comes out mangled.
	await mod.write_file(path, text + 'oops, half a line{\n'
		+ JSON.stringify({ from: `facet:${a}`, to: 'file:by-hand.md', rel: 'noted' }) + '\n');
	return true;
}, ids);
check('the sidecar was hand-edited', handEdit === true);

const afterHand = JSON.parse(await call('links_touching', [`facet:${ids.a}`]));
check('a mangled line does not take the other links with it',
	afterHand.length === afterAgent.length + 1, `${afterHand.length} link(s)`);
check('a link written by hand with only its two ends still counts',
	afterHand.some(l => l.to === 'file:by-hand.md'));

// ── Removal ─────────────────────────────────────────────────────────────
const removed = await call('remove_link', [ids.a, linkId]);
check('a link can be removed', removed === true, String(removed));
const afterRemove = JSON.parse(await call('links_touching', [`facet:${ids.b}`]));
check('and is then gone from the far end too', afterRemove.length === 0,
	`${afterRemove.length} link(s)`);
const removeAgain = await call('remove_link', [ids.a, linkId]);
check('removing what is not there is false, not an error', removeAgain === false);

// ── Deleting a Facet takes its links with it ────────────────────────────
await call('delete_facet', [ids.a]);
const afterDelete = JSON.parse(await call('links_touching', ['file:notes/pricing.md']));
check('deleting a Facet takes the links in its sidecar with it',
	afterDelete.length === 0, `${afterDelete.length} link(s)`);

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
