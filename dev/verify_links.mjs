// verify_links.mjs — the link substrate: one stored record, found from both ends.
//
// Links are the layer under whatever gets built on them, so what matters here is not a
// feature but the guarantees the rest will rest on: that a link is stored ONCE and still
// found from either end, that its ends can name things that are not Diamonds, that direction
// survives even though both ends find it, that provenance says who drew it, and that an
// agent can read and write the sidecar with the file tools it already has — because if it
// cannot, "agents read and write the graph" needs a whole tool surface that does not exist.
//
// The second half drives the association UI itself -- the real form, the real picker, the
// real suggestion chips -- because a substrate that is right underneath a control nobody
// can complete is still a feature nobody has.
//
// Run with dev/serve.mjs up. No gateway needed.
import { open, signInAs, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'links', connect: false });
const p = s.page;
await p.waitForTimeout(2500);   // open() has already signed in; wait for the app to settle

// ── Two Diamonds to hang links between ────────────────────────────────────
const ids = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const a = await app.create_diamond('Ship the launch');
	const b = await app.create_diamond('Brand voice');
	return { a, b };
});
check('two Diamonds were created', !!ids.a && !!ids.b, `${ids.a} / ${ids.b}`);

const call = (fn, args = []) => p.evaluate(async ({ fn, args }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return await app[fn](...args);
}, { fn, args });

// ── A link, asserted once ───────────────────────────────────────────────
const linkId = await call('add_link', [
	ids.a, `diamond:${ids.a}`, `diamond:${ids.b}`, 'Informs',
	'The launch copy has to sound like this.', 'user',
]);
check('a link was asserted', typeof linkId === 'string' && linkId.length > 0, linkId);

// ── Found from the end it was asserted from ─────────────────────────────
const fromA = JSON.parse(await call('links_touching', [`diamond:${ids.a}`]));
check('found from the end it was asserted from', fromA.length === 1, `${fromA.length} link(s)`);
check('the relation was normalised, as a Diamond tag would be',
	fromA[0]?.rel === 'informs', fromA[0]?.rel);
check('the note was kept as written',
	fromA[0]?.note === 'The launch copy has to sound like this.', fromA[0]?.note);
check('provenance says who drew it', fromA[0]?.by === 'user', fromA[0]?.by);
check('the owner is carried, so it can be deleted without a search',
	fromA[0]?.owner === ids.a, fromA[0]?.owner);

// ── And from the OTHER end, with no second copy stored ──────────────────
const fromB = JSON.parse(await call('links_touching', [`diamond:${ids.b}`]));
check('the same link is found from the far end', fromB.length === 1, `${fromB.length} link(s)`);
check('it is the SAME record, not a mirrored copy', fromB[0]?.id === linkId, fromB[0]?.id);
check('the far end is told which end is the other one',
	fromB[0]?.other === `diamond:${ids.a}`, fromB[0]?.other);
check('direction survived being found from the wrong end',
	fromB[0]?.from === `diamond:${ids.a}` && fromB[0]?.to === `diamond:${ids.b}`,
	`${fromB[0]?.from} -> ${fromB[0]?.to}`);

// Only one record exists on disk, in one sidecar.
const onDisk = await p.evaluate(async ({ a, b }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const read = async (path) => {
		try { return await mod.read_file(path); } catch (e) { return null; }
	};
	return {
		a: await read(`diamonds/${a}/.daimond/links.jsonl`),
		b: await read(`diamonds/${b}/.daimond/links.jsonl`),
	};
}, ids);
check('the record is stored once, in the asserting Diamond’s sidecar',
	(onDisk.a || '').trim().split('\n').filter(Boolean).length === 1 && onDisk.b === null,
	`a=${(onDisk.a || '').length}b b=${onDisk.b === null ? 'absent' : 'present'}`);

// ── The node space is not Diamonds only ───────────────────────────────────
await call('add_link', [ids.a, `diamond:${ids.a}`, 'file:notes/pricing.md', 'produced', '', 'agent:worker-1']);
await call('add_link', [ids.a, `diamond:${ids.a}`, 'url:https://stripe.com/docs?a=1', 'consulted', '', 'user']);
await call('add_link', [ids.a, `diamond:${ids.a}`, 'email:msg-99@example.com', 'from', '', 'user']);

const all = JSON.parse(await call('links_touching', [`diamond:${ids.a}`]));
check('a Diamond can link to a file', all.some(l => l.to === 'file:notes/pricing.md'));
check('a Diamond can link to a page, colons in the URL and all',
	all.some(l => l.to === 'url:https://stripe.com/docs?a=1'),
	all.find(l => l.to.startsWith('url:'))?.to);
check('a kind this build does not model is stored rather than refused',
	all.some(l => l.to === 'email:msg-99@example.com'));
check('an agent-asserted link says so',
	all.find(l => l.to === 'file:notes/pricing.md')?.by === 'agent:worker-1');

// A file is a node too, so the link is findable from the file's side.
const fromFile = JSON.parse(await call('links_touching', ['file:notes/pricing.md']));
check('a link is findable from the file end as well',
	fromFile.length === 1 && fromFile[0].other === `diamond:${ids.a}`, `${fromFile.length} link(s)`);

// ── What is refused ─────────────────────────────────────────────────────
const selfLink = await call('add_link', [ids.a, `diamond:${ids.a}`, `diamond:${ids.a}`, '', '', 'user'])
	.then(() => 'accepted').catch(() => 'refused');
check('a link from a thing to itself is refused', selfLink === 'refused', selfLink);

const badRef = await call('add_link', [ids.a, `diamond:${ids.a}`, 'not a reference', '', '', 'user'])
	.then(() => 'accepted').catch(() => 'refused');
check('an end that is not a kind:rest reference is refused', badRef === 'refused', badRef);

// ── An agent can reach the sidecar with the tools it already has ────────
//
// This is the load-bearing one. The sidecar sits inside `.daimond/`, and if the tool
// fence covered it, agents could not touch the graph at all without a new tool surface.
const agent = await p.evaluate(async ({ a }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const path = `diamonds/${a}/.daimond/links.jsonl`;
	const read = await app.run_tool('file_read', JSON.stringify({ path }));
	// Append a link the way an agent would: by writing the file.
	const line = JSON.stringify({
		id: 'agent-made-1', ts: 1700000000000,
		from: `diamond:${a}`, to: 'file:notes/agent-wrote-this.md',
		rel: 'produced', note: 'written straight into the sidecar', by: 'agent:tester',
	});
	const wrote = await app.run_tool('file_write',
		JSON.stringify({ path, content: read.replace(/\n*$/, '\n') + line + '\n' }));
	return { read, wrote };
}, ids);
check('an agent can READ the sidecar with file_read',
	/diamond:/.test(agent.read || ''), (agent.read || '').slice(0, 40));
check('an agent can WRITE the sidecar with file_write',
	!/error|refus|denied/i.test(agent.wrote || ''), (agent.wrote || '').slice(0, 60));

const afterAgent = JSON.parse(await call('links_touching', [`diamond:${ids.a}`]));
check('the link the agent wrote is read back by the store',
	afterAgent.some(l => l.id === 'agent-made-1' && l.by === 'agent:tester'),
	`${afterAgent.length} link(s)`);

// ── A hand-edited sidecar is forgiving ──────────────────────────────────
const handEdit = await p.evaluate(async ({ a }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const path = `diamonds/${a}/.daimond/links.jsonl`;
	const text = await mod.read_file(path);
	// A person edits this file. One line comes out mangled.
	await mod.write_file(path, text + 'oops, half a line{\n'
		+ JSON.stringify({ from: `diamond:${a}`, to: 'file:by-hand.md', rel: 'noted' }) + '\n');
	return true;
}, ids);
check('the sidecar was hand-edited', handEdit === true);

const afterHand = JSON.parse(await call('links_touching', [`diamond:${ids.a}`]));
check('a mangled line does not take the other links with it',
	afterHand.length === afterAgent.length + 1, `${afterHand.length} link(s)`);
check('a link written by hand with only its two ends still counts',
	afterHand.some(l => l.to === 'file:by-hand.md'));

// ── Removal ─────────────────────────────────────────────────────────────
const removed = await call('remove_link', [ids.a, linkId]);
check('a link can be removed', removed === true, String(removed));
const afterRemove = JSON.parse(await call('links_touching', [`diamond:${ids.b}`]));
check('and is then gone from the far end too', afterRemove.length === 0,
	`${afterRemove.length} link(s)`);
const removeAgain = await call('remove_link', [ids.a, linkId]);
check('removing what is not there is false, not an error', removeAgain === false);

// ── Deleting a Diamond takes its links with it ────────────────────────────
await call('delete_diamond', [ids.a]);
const afterDelete = JSON.parse(await call('links_touching', ['file:notes/pricing.md']));
check('deleting a Diamond takes the links in its sidecar with it',
	afterDelete.length === 0, `${afterDelete.length} link(s)`);

// ── The UI: the same record, made and read from both ends ────────────────
//
// Everything above went straight at the store. This drives what a person drives: the
// Links section on the crystal, the picker that finds the other Diamond by name, the three
// suggested relations, the note, and the × that takes the link away again. The direction
// is the load-bearing part -- the row on the Diamond the link was asserted FROM must read
// `out`, and the very same record must show as `in` on the other one.

// Three Diamonds to link between, made through the store rather than through the rail's
// "+": that dialog will not complete without a model, and this session deliberately has
// none. Then a clean page, so the rail holds what the store holds.
for (const n of ['Ship the console', 'Pricing research', 'Support playbook']) {
	await call('create_diamond', [n]);
}
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'links');
await p.waitForTimeout(1800);

/// Put a Diamond in the Centre by clicking its box in the rail.
async function selectDiamond(name) {
	await p.$$eval('.diamond-box', (els, n) => {
		for (const e of els) {
			const t = (e.querySelector('.session-box-name') || {}).textContent;
			if (t === n) { e.click(); return; }
		}
	}, name);
	await p.waitForTimeout(900);
}
/// Open the Links section, which renders no rows while it is shut.
async function expandLinks() {
	await p.waitForSelector('#link-strip', { timeout: 10000 });
	const shut = await p.$eval('#link-strip', e => e.getAttribute('aria-expanded') !== 'true');
	if (shut) { await p.click('#link-strip', { force: true }); await p.waitForTimeout(700); }
}
const rows = () => p.$$eval('.link-row', els => els.map(e => ({
	lid:   e.dataset.linkId,
	dir:   e.dataset.dir,
	other: e.dataset.other,
	cls:   e.getAttribute('class'),
	rel:   (e.querySelector('.link-rel')   || {}).textContent ?? null,
	name:  (e.querySelector('.link-other') || {}).textContent ?? null,
	note:  (e.querySelector('.link-note')  || {}).textContent ?? null,
	hasNoteBtn: !!e.querySelector('.link-note-btn'),
})));

const railIds = await p.$$eval('.diamond-box', els => els.map(e => ({
	id: e.dataset.id, name: (e.querySelector('.session-box-name') || {}).textContent,
})));
const idOf = (n) => (railIds.find(r => r.name === n) || {}).id;
check('three Diamonds are in the rail to link between',
	!!idOf('Ship the console') && !!idOf('Pricing research') && !!idOf('Support playbook'),
	railIds.map(r => r.name).join(', '));

await selectDiamond('Ship the console');
check('the Links section is on the crystal, whether or not there are links',
	await p.isVisible('#link-sec'));
check('a shut section renders no rows', (await rows()).length === 0
	&& await p.$eval('#link-body', e => e.style.display === 'none'), 'body hidden');
await expandLinks();
check('the strip opens the section', await p.$eval('#link-strip', e => e.getAttribute('aria-expanded') === 'true'),
	await p.textContent('#link-strip'));
check('an empty section still offers the way in to making one', await p.isVisible('#link-add'));

// ── Making one through the form ─────────────────────────────────────────
await p.click('#link-add', { force: true });
await p.waitForSelector('#link-form', { timeout: 5000 });
check('the add control becomes the form', await p.isVisible('#link-form')
	&& await p.isVisible('#link-pick') && await p.isVisible('#link-rel')
	&& await p.isVisible('#link-note') && await p.isVisible('#link-save'));
check('the form says which way the link will run', /\S/.test(await p.textContent('#link-says')),
	(await p.textContent('#link-says')).slice(0, 60));

const sugs = await p.$$eval('#link-rel-sug .link-sug', els => els.map(e => e.dataset.rel));
check('exactly three relations are suggested, and none enforced',
	JSON.stringify(sugs) === JSON.stringify(['part-of', 'relates-to', 'derives-from']), JSON.stringify(sugs));

await p.fill('#link-pick', 'pricing');
await p.waitForTimeout(500);
const hits = await p.$$eval('.link-pick-hit', els => els.map(e => ({ id: e.dataset.id, name: e.textContent })));
check('typing part of a name finds the Diamond, and offers only the others',
	hits.length === 1 && hits[0].id === idOf('Pricing research'), JSON.stringify(hits));
await p.click('.link-pick-hit', { force: true });
await p.waitForTimeout(400);
check('picking one replaces the search with the choice, and a way to change it',
	await p.isVisible('#link-chosen') && await p.isVisible('#link-change')
	&& (await p.textContent('#link-chosen')).includes('Pricing research'));

await p.click('.link-sug[data-rel="part-of"]', { force: true });
await p.waitForTimeout(300);
// A link carries a SET of relations now, edited as the Graph edits the same
// field: a suggestion becomes a chip ON the link and leaves the box clear for
// the next word, rather than filling the box in and being the only one.
const chosenRels = await p.$$eval('#link-rel-chips .tag-chip',
	els => els.map(e => e.textContent.replace(/×$/, '').trim()));
check('a suggestion chip puts that relation on the link, and clears the box for another',
	chosenRels.join('|') === 'part-of' && await p.inputValue('#link-rel') === '',
	JSON.stringify(chosenRels));
await p.fill('#link-note', 'the pricing work feeds the console rollout');
await p.click('#link-save', { force: true });
await p.waitForTimeout(1200);

const outRows = await rows();
check('the link appears on the Diamond it was asserted from, pointing out',
	outRows.length === 1 && outRows[0].dir === 'out' && /link-row-out/.test(outRows[0].cls),
	JSON.stringify(outRows[0]));
check('the row names the far end and the relation',
	outRows[0]?.rel === 'part-of' && outRows[0]?.name === 'Pricing research'
	&& outRows[0]?.other === `diamond:${idOf('Pricing research')}`,
	`${outRows[0]?.rel} → ${outRows[0]?.name}`);
check('a link with a note offers the control that shows it', outRows[0]?.hasNoteBtn === true);
check('the strip carries the count', /1/.test(await p.textContent('#link-strip')),
	await p.textContent('#link-strip'));
const madeId = outRows[0]?.lid;
await shot(s, 'links-out-row');

// ── The same record, read from the far end ──────────────────────────────
await selectDiamond('Pricing research');
await expandLinks();
const inRows = await rows();
check('the far end shows the SAME record, pointing in',
	inRows.length === 1 && inRows[0].lid === madeId && inRows[0].dir === 'in'
	&& /link-row-in/.test(inRows[0].cls), JSON.stringify(inRows[0]));
check('and names the Diamond at the other end of it',
	inRows[0]?.other === `diamond:${idOf('Ship the console')}` && inRows[0]?.name === 'Ship the console',
	inRows[0]?.name);

// ── A relation of the user's own words ──────────────────────────────────
await p.click('#link-add', { force: true });
await p.waitForSelector('#link-form', { timeout: 5000 });
await p.fill('#link-pick', 'playbook');
await p.waitForTimeout(500);
await p.click('.link-pick-hit', { force: true });
await p.waitForTimeout(300);
await p.fill('#link-rel', '  Feeds INTO  ');
await p.click('#link-save', { force: true });
await p.waitForTimeout(1200);
const freeRows = await rows();
const free = freeRows.find(r => r.lid !== madeId);
check('a relation nobody suggested is accepted', !!free && freeRows.length === 2,
	`${freeRows.length} row(s)`);
check('and is normalised to lowercase, the way a tag is',
	free?.rel === 'feeds into', JSON.stringify(free?.rel));

// ── Shut again, with links to shut over ─────────────────────────────────
// The rows are built only while the section is open, so closing it has to take them out of
// the document rather than merely hide them -- with two links stored, this can tell.
await p.click('#link-strip', { force: true });
await p.waitForTimeout(700);
check('closing the section takes the rows out of the document, not just out of sight',
	(await rows()).length === 0 && await p.$eval('#link-body', e => e.style.display === 'none'),
	`${(await rows()).length} row(s) in the DOM with 2 links stored`);
await expandLinks();
check('and opening it again brings them back', (await rows()).length === 2,
	`${(await rows()).length} row(s)`);

// ── Escape leaves the form without asking anything ──────────────────────
await p.click('#link-add', { force: true });
await p.waitForSelector('#link-form', { timeout: 5000 });
await p.fill('#link-pick', 'ship');
await p.waitForTimeout(300);
await p.focus('#link-pick');
await p.keyboard.press('Escape');
await p.waitForTimeout(600);
check('Escape closes the form', await p.$('#link-form') === null);
check('and asks nothing on the way out', await p.$('.dlg-card') === null);
check('the rows it was sitting under are still there', (await rows()).length === 2);

// ── Taking one away, from one end, removes it from both ─────────────────
await p.$$eval('.link-row', (els, lid) => {
	for (const e of els) if (e.dataset.linkId === lid) { e.querySelector('.link-drop').click(); return; }
}, madeId);
await p.waitForSelector('.dlg-card', { timeout: 5000 });
check('dropping a link asks first, in the app’s own dialog', await p.isVisible('.dlg-card'));
await p.click('.dlg-ok', { force: true });
await p.waitForTimeout(1200);
const leftHere = await rows();
check('the dropped link is gone from the end it was dropped at',
	leftHere.length === 1 && !leftHere.some(r => r.lid === madeId), `${leftHere.length} row(s)`);
await selectDiamond('Ship the console');
await expandLinks();
const leftThere = await rows();
check('and from the other end as well, with no second copy to clean up',
	leftThere.length === 0, `${leftThere.length} row(s)`);

// ── The way through to the picture ──────────────────────────────────────
check('the graph button is on the rail head', await p.isVisible('#link-graph-btn'));
await p.click('#link-graph-btn', { force: true });
await p.waitForTimeout(1200);
check('it opens the Graph pane',
	await p.$eval('#panel-graph', e => !e.classList.contains('closed') && e.offsetParent !== null),
	await p.$eval('#panel-graph', e => e.className));
check('and the pane has drawn the link that is left',
	await p.$$eval('#graph-body g.graph-edge', els => els.length) === 1,
	`${await p.$$eval('#graph-body g.graph-edge', els => els.length)} edge(s)`);
await shot(s, 'links-graph-open');

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
