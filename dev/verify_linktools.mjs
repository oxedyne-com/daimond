// verify_linktools.mjs — can a daimon actually read and write the world model?
//
// The Diamond graph exists "to give all daimons access to a Daimond world model with
// relational data", and until now no daimon could read a single edge of it: there was no
// link variant in the tool enum at all, so `all_links` and `links_touching` had exactly two
// readers, both of them JavaScript drawing a picture for a person. This drives the three
// tools that close that gap, through the real steer turn, with the real mock provider, and
// asks the questions a model would fail on rather than the ones the Rust tests already
// answer:
//
//   * are the tools OFFERED — do the schemas the daimon's request carries name them,
//     and do the chat's not, since `Tool::browser()` is also the Tools panel;
//   * does a link a MODEL asserted land on the right Diamond, stamped as the model's
//     rather than as the user's;
//   * does what comes BACK from link_list actually reach the model, or stop at the app;
//   * does a removal go, and does the graph notice;
//   * and does `update_link` keep the id and the first-assertion time that a delete plus a
//     fresh assertion destroys.
//
// NOT YET RUN. It needs `www/pkg` rebuilt, and that directory is shared with another
// agent's running browser, so the rebuild was deliberately not done. Run with dev/serve.mjs
// and dev/mockllm.mjs up, after a wasm-pack build:
//
//   node dev/verify_linktools.mjs
//
import { open, shot, clearMockLog, mockLog } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

clearMockLog();
const s = await open({ name: 'linktools' });
const p = s.page;
await p.waitForTimeout(2000);

/// Call one method on a fresh app handle, as the other link verifiers do.
const call = (fn, args = []) => p.evaluate(async ({ fn, args }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return await app[fn](...args);
}, { fn, args });

/// Steer the open Diamond and wait for the turn to end.
async function steer(text) {
	await p.waitForSelector('#steer-input', { timeout: 10000 });
	await p.fill('#steer-input', text);
	await p.click('#steer-send');
	const t0 = Date.now();
	while (Date.now() - t0 < 30000) {
		const busy = await p.evaluate(() => {
			const b = document.getElementById('steer-send');
			return b ? b.disabled : false;
		});
		if (!busy) break;
		await p.waitForTimeout(200);
	}
	await p.waitForTimeout(800);
}

/// The most recent request the mock was sent.
const lastRequest = () => {
	const lines = mockLog();
	return lines.length ? lines[lines.length - 1] : null;
};

// ── Two Diamonds, and one of them open ────────────────────────────────────
await p.click('#new-diamond-btn');
await p.waitForSelector('.dlg-input', { timeout: 8000 });
await p.fill('.dlg-input', 'Brand voice');
await p.click('.dlg-ok');
await p.waitForTimeout(600);
await p.click('#new-diamond-btn');
await p.waitForSelector('.dlg-input', { timeout: 8000 });
await p.fill('.dlg-input', 'Ship the launch');
await p.click('.dlg-ok');
await p.waitForSelector('#steer-input', { timeout: 10000 });
await p.waitForTimeout(800);

const ids = JSON.parse(await call('list_diamonds')).reduce((acc, d) => {
	acc[d.name] = d.id;
	return acc;
}, {});
check('two Diamonds exist to hang a relation between',
	!!ids['Brand voice'] && !!ids['Ship the launch'],
	JSON.stringify(ids));
const LAUNCH = ids['Ship the launch'], VOICE = ids['Brand voice'];

// ── Are they offered at all? ──────────────────────────────────────────────
//
// A tool the prompt names and the registry lacks is the failure mode this change was told
// not to repeat, so the two are asserted against each other rather than separately.
await steer('@text noted');
const daimonReq = lastRequest();
const daimonTools = daimonReq?.tools || [];      // the mock logs the names, not the schemas
for (const name of ['link_list', 'link_add', 'link_remove']) {
	check(`the daimon is offered ${name}`, daimonTools.includes(name), daimonTools.join(','));
}
const daimonSystem = (daimonReq?.messages || []).filter(m => m.role === 'system')
	.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
for (const name of ['link_list', 'link_add', 'link_remove']) {
	check(`and its prompt names ${name}, so the prompt and the registry agree`,
		daimonSystem.includes(name));
}
check('the prompt says there are three things to do, now that there are',
	daimonSystem.includes('Three things are yours to do'));

// ── ...and not claimed to the user in the Tools panel ─────────────────────
const panel = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return JSON.parse(mod.builtin_tools()).map(t => t.tool);
});
for (const name of ['link_list', 'link_add', 'link_remove']) {
	check(`${name} is not claimed to the user as a chat tool`, !panel.includes(name),
		panel.join(','));
}
check('the precedent holds: the daimon’s other exclusive tool is absent too',
	!panel.includes('spawn_agent'));

// ── A link a MODEL asserted ───────────────────────────────────────────────
await steer(`@tool link_add {"from":"diamond:${LAUNCH}","to":"diamond:${VOICE}",`
	+ `"rel":"Derives From","note":"The launch copy has to sound like this."}`);
const made = JSON.parse(await call('all_links'));
check('the model’s call put exactly one link in the store', made.length === 1,
	`${made.length} link(s)`);
const link = made[0] || {};
check('kept on the Diamond it was asserted from', link.owner === LAUNCH, link.owner);
check('and NOT filed as the user’s own', link.by === 'agent:daimon', link.by);
check('the relation was normalised as any other would be', link.rel === 'derives from', link.rel);
check('the note was kept as written',
	link.note === 'The launch copy has to sound like this.', link.note);
check('the ends are what the model named',
	link.from === `diamond:${LAUNCH}` && link.to === `diamond:${VOICE}`,
	`${link.from} -> ${link.to}`);

// ── Does the answer reach the model, or stop at the app? ──────────────────
await steer('@tool link_list {}');
const afterList = lastRequest();
const toolReplies = (afterList?.messages || [])
	.filter(m => m.role === 'tool')
	.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
	.join('\n');
check('the whole graph came back to the MODEL, not just to the picture',
	toolReplies.includes(`diamond:${VOICE}`) && toolReplies.includes('derives from'),
	toolReplies.slice(0, 200));
check('and it carries the owner and id a removal needs',
	toolReplies.includes(link.owner) && toolReplies.includes(link.id));

await steer(`@tool link_list {"node":"diamond:${VOICE}"}`);
const afterNode = lastRequest();
const nodeReply = (afterNode?.messages || []).filter(m => m.role === 'tool')
	.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
check('asking from the far end finds the same one record, not a second copy',
	nodeReply.includes(link.id) && (nodeReply.match(/"id":/g) || []).length === 1,
	nodeReply.slice(0, 200));

// ── A revision keeps what a re-assertion destroys ─────────────────────────
const revised = await call('update_link', [link.owner, link.id, 'Supersedes', 'Rewritten.']);
check('update_link reports the revision', revised === true, String(revised));
const after = (JSON.parse(await call('all_links')))[0] || {};
check('the id survived the edit, so anything holding it still resolves',
	after.id === link.id, `${link.id} -> ${after.id}`);
check('and so did the moment the two were FIRST said to be related',
	after.ts === link.ts, `${link.ts} -> ${after.ts}`);
check('while the relation itself moved', after.rel === 'supersedes', after.rel);
check('and the note with it', after.note === 'Rewritten.', after.note);
check('a revision that changes nothing writes nothing',
	(await call('update_link', [link.owner, link.id, 'supersedes', 'Rewritten.'])) === false);
check('and an id that names no link revises nothing',
	(await call('update_link', [link.owner, 'nosuch', 'x', ''])) === false);

// ── The removal, and whether the picture notices ──────────────────────────
await p.click('#link-graph-btn', { force: true });
await p.waitForTimeout(1000);
const edgesBefore = await p.$$eval('#graph-body g.graph-edge', els => els.length);
check('the graph draws the model’s link', edgesBefore === 1, `${edgesBefore} edge(s)`);

await steer(`@tool link_remove {"owner":"${link.owner}","id":"${link.id}"}`);
check('the model’s removal emptied the store',
	JSON.parse(await call('all_links')).length === 0);
// THE JS SIDE. A link a model made or unmade is a link the page did not make, so nothing
// fires `signalLinksChanged` for it. If this fails, the graph is stale until something else
// redraws it -- see the report: the fix is one call after `steer_crystal` resolves.
const edgesAfter = await p.$$eval('#graph-body g.graph-edge', els => els.length);
check('and the graph noticed without being reopened', edgesAfter === 0,
	`${edgesAfter} edge(s) still drawn`);

// ── A Diamond that is not there is not one to write a sidecar for ─────────
await steer('@tool link_add {"from":"diamond:no-such-diamond","to":"file:notes/x.md","rel":"holds"}');
const afterGhost = lastRequest();
const ghostReply = (afterGhost?.messages || []).filter(m => m.role === 'tool')
	.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
check('a mistyped owner is refused rather than given a directory of its own',
	ghostReply.includes('no Diamond'), ghostReply.slice(0, 200));
check('and the rail did not gain a Diamond nothing lists',
	JSON.parse(await call('list_diamonds')).length === 2);

// ── A removal aimed at the wrong Diamond says so ──────────────────────────
await steer(`@tool link_remove {"owner":"${VOICE}","id":"nosuch"}`);
const afterMiss = lastRequest();
const missReply = (afterMiss?.messages || []).filter(m => m.role === 'tool')
	.map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
check('a miss is explained rather than reported as success',
	missReply.includes('nothing was removed') && missReply.includes('owner'),
	missReply.slice(0, 200));

await shot(s, 'linktools-graph');
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
