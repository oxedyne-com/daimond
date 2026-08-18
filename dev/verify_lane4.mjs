// verify_lane4.mjs — four controls that were drawn and did not work.
//
// Each of the four is a surface that LOOKS finished. Nothing here can be proved
// by reading a variable, because in every case the broken code holds the right
// variable and never reaches it — so every one of these presses the control the
// way a hand does and then asks what changed on the page.
//
//   §1 Pending      REWRITTEN 2026-08-16. It used to drive the draft tile: the
//                   tick opened the composer and dropped the tile in the same
//                   breath, so a composer closed without sending lost the action.
//                   That whole kind was DELETED on 2026-08-15 for having no
//                   producer -- see `dev/REACHABILITY.md` Finding 1 -- and nine
//                   checks here drove it. Keeping a branch alive because a
//                   verifier drives it is the same error as calling a panel done
//                   because a verifier called it, only inverted. So §1 now drives
//                   what is left: the one kind that has a producer, and the door
//                   that refuses the rest.
//   §2 Agents       a run dispatched from a chat carries a chip whose comment says
//                   it filters. The listener was `if (run.diamondId)`, which a chat
//                   run does not have, so every chat chip was inert.
//   §3 Crystal      the `+` that attaches the first file lives inside a list that
//                   hid itself when there was nothing attached — unreachable in
//                   exactly the state it exists for.
//   §4 Links        a link carries a SET of relations. The Graph drew chips; the
//                   Diamond panel printed the raw field, so `blocks,informs` read
//                   literally as that, and its form could only take one word.
//
// Run it with LANE4_RED=1 to serve the two scripts as they stand at HEAD — the
// same page, the broken code — which is how each check above was proved to fail
// before it was believed passing. Nothing is written to the working tree either
// way; the old files are served from a scratch copy through `page.route`.
//
//   bash dev/world.sh 3 --up && eval "$(bash dev/world.sh 3 --env)"
//   LANE4_RED=1 node dev/verify_lane4.mjs      # every fixed check must FAIL
//   node dev/verify_lane4.mjs                  # and all of them pass here
//
// `LANE4_NAIVE` went with §1's rewrite. It served a `Pending.sweep` cut down to
// decide on `read_file` alone, and there is no `sweep` any more: with the draft
// kind gone its first test kept every item, so it walked the list and could not
// change it. A mode that reproduces a defect in deleted code cannot go red for
// the right reason, and a red nobody can trigger is a red nobody will see.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { open, shot, errors } from './harness.mjs';

const RED = !!process.env.LANE4_RED;
const OLD = process.env.LANE4_OLD
	|| path.join(os.homedir(), '.cache/daimond/lane4-head');
const HERE = path.dirname(new URL(import.meta.url).pathname);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const head = (n) => console.log('\n── ' + n + ' ' + '─'.repeat(Math.max(0, 60 - n.length)));

// A broken build, served in place of the fixed one. Only for a red run: a green
// run touches nothing, and neither writes to the tree.
const serveOld = async (page) => {
	if (!RED) return;
	for (const f of ['daimond.js', 'graph.js']) {
		const body = fs.readFileSync(path.join(OLD, f), 'utf8');
		await page.route('**/js/' + f, (route) =>
			route.fulfill({ status: 200, contentType: 'application/javascript', body }));
	}
};

const s = await open({ name: 'lane4', connect: false, defaults: false, route: serveOld });
const p = s.page;
await p.waitForTimeout(2000);

/// Run one section, and let the next one run whatever this one does.
///
/// A red run has to reach all four. When the sections shared one `try`, the
/// first defect threw on a control that is not there and the other three were
/// never exercised at all -- which is how a check comes to be believed without
/// ever having been seen to fail.
const section = async (name, fn) => {
	head(name);
	try { await fn(); }
	catch (e) {
		// The locator is in the call log, not the message, and a bare "click timed
		// out" does not say WHICH control was not there -- which is the whole
		// finding when a section fails on the broken build.
		check(name + ' ran to the end', false,
			String(e.message || e).replace(/\s+/g, ' ').slice(0, 200));
		try { await shot(s, 'lane4-threw-' + name.replace(/\W+/g, '')); }
		catch (e2) { /* nothing left to photograph */ }
	}
};

// Carried between sections: §4 links the Diamond §3 built.
let bareId = '', other = '';

/// The Diamond engine, for a fixture that has to write the store directly.
const app = (fn, args = []) => p.evaluate(async ({ fn, args }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const a = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await a[fn](...args);
}, { fn, args });

// ══ §1 Pending: one kind has a producer, and the door refuses the rest ═════
//
// The panel's `draft` and `note` kinds went on 2026-08-15 for never having had a
// producer, and with them the nine checks that used to stand here. What is left
// is `consent`, raised by `parkConsent` when a dispatched worker asks a question
// nobody is in front of the tab to answer, and a door that refuses any other
// kind rather than drawing a tile whose tick would grant a permission to nobody.
//
// Every refusal below is paired with a tile that DID draw, in the same list, in
// the same breath. Alone, "no tile appeared" passes on a panel that renders
// nothing at all, on a renamed `#pending-list`, and on a build where `add`
// refuses everything -- three ways of being right for the wrong reason.
await section('§1 Pending', async () => {

await p.evaluate(() => {
	try { localStorage.removeItem('daimond-pending'); } catch (e) { /* nothing stored */ }
	if (window.DaimondPendingView) window.DaimondPendingView.items()
		.forEach((it) => window.DaimondPendingView.drop(it.id));
});
await p.evaluate(() => window.DaimondPanels.show('pending'));
await p.waitForTimeout(500);

/// The Pending tile carrying one headline, as the page has it now.
const pendTile = (headline) => p.evaluate((h) => {
	const card = [...document.querySelectorAll('#pending-list .pend-card')]
		.find((c) => ((c.querySelector('.pend-line') || {}).textContent || '').trim() === h);
	if (!card) return null;
	const go = card.querySelector('.pend-go');
	return {
		id:      card.dataset.id,
		note:    (card.querySelector('.pend-consent') || {}).textContent || '',
		goLive:  !!go && !go.disabled,
		goTitle: go ? (go.title || '') : '',
	};
}, headline);

const cards = () => p.evaluate(() =>
	[...document.querySelectorAll('#pending-list .pend-card')].length);
const said = (key) => p.evaluate((k) =>
	window.DaimondI18n ? window.DaimondI18n.t(k) : '', key);

// ── A tile that IS raised, which everything below is measured against ──
const ASK = 'An agent wants to click Accept on example.test';
const rawId = await p.evaluate((h) => window.DaimondPendingView.add({
	headline: h, detail: 'It asked while you were looking at something else.',
	priority: 'high', diamondName: 'Pricing',
}), ASK);
await p.waitForTimeout(400);
let tile = await pendTile(ASK);
check('a consent tile is raised, drawn, and named by the words it was given',
	!!rawId && !!tile && (await cards()) === 1, JSON.stringify(tile));
check('and it says a turn is still waiting on the answer, in the catalogue\'s words',
	!!tile && tile.note.trim() === (await said('pending.consent.waiting')).trim(),
	tile ? tile.note : 'no tile');
await shot(s, 'lane4-1-consent-tile');

// ── The door: a kind this panel cannot act on is refused, not drawn ──
//
// `draft` and `note` are the two that were deleted; `whatever` stands for the
// next one somebody invents. A tile for any of them would carry the consent
// tile's "still waiting" line over a turn that was never parked.
const refused = await p.evaluate(() => ['draft', 'note', 'whatever'].map((k) => ({
	kind: k,
	id:   window.DaimondPendingView.add({ headline: 'Raised as ' + k, kind: k, detail: '' }),
})));
await p.waitForTimeout(400);
const drewOne = await p.evaluate(() =>
	[...document.querySelectorAll('#pending-list .pend-line')]
		.map((n) => n.textContent.trim()).filter((x) => /^Raised as /.test(x)));
check('a kind the panel cannot act on is refused at the door, and nothing is drawn for it',
	refused.every((r) => r.id === null) && drewOne.length === 0 && (await cards()) === 1,
	JSON.stringify(refused) + ' drew ' + JSON.stringify(drewOne));

// ── The tick answers honestly when nothing is parked on the tile ──
//
// Raised from outside, so no worker is holding a turn open on it. The tick must
// say that rather than report a permission it granted to nobody -- and it must
// still clear the tile, because there is nothing left to answer.
await p.click('#pending-list .pend-card .pend-go');
await p.waitForTimeout(500);
const toldThem = await p.evaluate(() =>
	[...document.querySelectorAll('.daimond-toast')].map((n) => n.textContent.trim()));
check('the tick on a tile nothing is parked on says so, rather than reporting an allow',
	toldThem.includes((await said('pending.consent.gone')).trim())
		&& !toldThem.includes((await said('pending.consent.allowed')).trim()),
	JSON.stringify(toldThem));
check('and the tile goes, because there is nothing left to answer',
	!(await pendTile(ASK)) && (await cards()) === 0, String(await cards()));

// ── A promise does not survive a reload, and the tile says which state it is in ──
//
// The tile is kept: "an agent asked and got no answer" is worth keeping. What
// must not survive is the offer to say yes, because the turn it would resume
// went with the page.
const LATER = 'An agent wants to reach example.test';
await p.evaluate((h) => window.DaimondPendingView.add({
	headline: h, detail: 'Asked before the reload.', priority: 'normal',
}), LATER);
await p.waitForTimeout(400);
tile = await pendTile(LATER);
check('a second tile is raised, and its tick is live while the turn is',
	!!tile && tile.goLive === true, JSON.stringify(tile));

await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);
const { signInAs } = await import('./harness.mjs');
await signInAs(s, 'lane4');
await p.waitForTimeout(2500);
await p.evaluate(() => window.DaimondPanels.show('pending'));
await p.waitForTimeout(1200);
tile = await pendTile(LATER);
check('the tile survives the reload, because a question that went unanswered is worth keeping',
	!!tile, JSON.stringify(tile));
check('but it says the agent has gone, and no longer offers a yes that could not be honoured',
	!!tile && tile.goLive === false
		&& tile.note.trim() === (await said('pending.consent.expired')).trim()
		&& tile.goTitle.trim() === (await said('pending.consent.expired')).trim(),
	tile ? `live: ${tile.goLive}, said: ${tile.note.slice(0, 60)}` : 'no tile');
await shot(s, 'lane4-1-expired-after-reload');

// ── And the ✕, which is the answer that always works ──
await p.evaluate((h) => {
	const card = [...document.querySelectorAll('#pending-list .pend-card')]
		.find((c) => ((c.querySelector('.pend-line') || {}).textContent || '').trim() === h);
	if (card) card.querySelector('.pend-no').click();
}, LATER);
await p.waitForTimeout(400);
const emptied = await p.evaluate(() =>
	(document.getElementById('pending-list') || {}).textContent || '');
check('dropping the last tile empties the list, and the panel says so in words',
	(await cards()) === 0 && emptied.trim() === (await said('pending.empty')).trim(),
	emptied.trim().slice(0, 80));
});

// ══ §2 Agents: the chat chip filters ═══════════════════════════════════════
await section('§2 Agents', async () => {

// Two conversations, made the ordinary way, so the chips carry real chat ids.
for (let i = 0; i < 2; i++) {
	await p.evaluate(() => document.getElementById('new-session-btn').click());
	await p.waitForTimeout(700);
}
const chatIds = await p.$$eval('.chat-box', (els) => els.map((e) => e.dataset.id));
check('two conversations exist to tell apart', chatIds.length >= 2, chatIds.join(', '));
const [chatA, chatB] = chatIds;

// One Diamond, so the Diamond filter and the chat filter are both in the picture
// and neither can be mistaken for the other.
const dId = await app('create_diamond', ['Pricing research']);
await p.evaluate(() => window.DaimondCore.loadDiamonds());
await p.waitForTimeout(600);

await p.evaluate(({ a, b, d }) => {
	const mk = (o) => Object.assign({
		id: 'w-' + o.name, batch: 'b1', task: 'sort a list', status: 'done',
		diamondId: '', diamondName: '', chatId: '', chatName: '',
		model: 'mock/fast', provider: '', tools: [], text: '', sees: false,
		promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, app: null,
	}, o);
	window.DaimondWorkers.runs = [
		mk({ name: 'from-chat-a', chatId: a }),
		mk({ name: 'from-chat-b', chatId: b }),
		mk({ name: 'from-diamond', diamondId: d, diamondName: 'Pricing research' }),
	];
	window.DaimondPanels.show('agents');
	window.DaimondWorkers.render();
}, { a: chatA, b: chatB, d: dId });
await p.waitForTimeout(500);

/// Which runs the panel is showing, and which chip each carries.
const shown = () => p.$$eval('#panel-agents .acard', (els) => els.map((e) => ({
	name:   (e.querySelector('.an') || {}).textContent || '',
	chip:   (e.querySelector('.diamond-chip') || {}).textContent || '',
	active: !!(e.querySelector('.diamond-chip') || {}).classList?.contains('tag-active'),
})));

let cards = await shown();
check('all three runs are listed before anything is filtered',
	cards.length === 3 && ['from-chat-a', 'from-chat-b', 'from-diamond']
		.every((n) => cards.some((c) => c.name === n)),
	cards.map((c) => c.name).join(', '));
check('each chat run carries a chip that names where it came from',
	cards.filter((c) => /^from-chat/.test(c.name)).every((c) => /↳\s*\S/.test(c.chip)),
	JSON.stringify(cards.map((c) => c.chip)));

// The click. On the tile of the run from chat A, on the chip itself.
await p.click('#panel-agents .acard:has(.an:text-is("from-chat-a")) .diamond-chip');
await p.waitForTimeout(500);
cards = await shown();
check('clicking the chat chip filters the panel to that conversation',
	cards.length === 1 && cards[0].name === 'from-chat-a',
	cards.length ? cards.map((c) => c.name).join(', ') : 'nothing shown');
check('the chip it was clicked on now reads as the one in force',
	cards.length === 1 && cards[0].active === true, JSON.stringify(cards[0]));
const standing = await p.evaluate(() => {
	const c = document.querySelector('#agent-filter .tag-chip');
	return c ? { text: c.textContent, title: c.title } : null;
});
check('a standing filter chip says why the other runs are not on screen',
	!!standing && /\S/.test(standing.text) && /\S/.test(standing.title),
	JSON.stringify(standing));
await shot(s, 'lane4-2-chat-filter-on');

// Clearing it, from the standing chip, brings everything back.
await p.click('#agent-filter .tag-chip');
await p.waitForTimeout(400);
cards = await shown();
check('clearing the filter brings the other conversations back',
	cards.length === 3, cards.map((c) => c.name).join(', '));

// The two filters are one at a time, as the rail's are: a Diamond chip pressed
// while a chat filter is on must replace it rather than intersect with it and
// show nothing.
await p.click('#panel-agents .acard:has(.an:text-is("from-chat-a")) .diamond-chip');
await p.waitForTimeout(400);
await p.click('#panel-agents .acard:has(.an:text-is("from-chat-a")) .diamond-chip');
await p.waitForTimeout(400);
await p.click('#panel-agents .acard:has(.an:text-is("from-diamond")) .diamond-chip');
await p.waitForTimeout(400);
cards = await shown();
check('a Diamond chip pressed after a chat chip replaces the filter, not adds to it',
	cards.length === 1 && cards[0].name === 'from-diamond',
	cards.map((c) => c.name).join(', ') || 'nothing shown');
await p.click('#agent-filter .tag-chip');
await p.waitForTimeout(400);

});

// ══ §3 The crystal's `+` is reachable when there is nothing attached ═══════
await section('§3 Attach', async () => {

// A file to attach, and a Diamond holding nothing at all — which is the state
// the control exists for and the state it used to be hidden in.
await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.write_file('attach-spec.md', '# The spec\n\nWhat we agreed.\n');
});
bareId = await app('create_diamond', ['Bare pursuit']);
await p.evaluate(() => window.DaimondCore.loadDiamonds());
await p.waitForTimeout(700);
await p.evaluate((id) => {
	const box = [...document.querySelectorAll('.diamond-box')].find((b) => b.dataset.id === id);
	box.querySelector('.session-box-name, .session-box-open, button').click();
}, bareId);
await p.waitForTimeout(1200);

const noLinks = await app('links_touching', ['diamond:' + bareId]);
check('the Diamond under test holds nothing', JSON.parse(noLinks || '[]').length === 0, noLinks);

const stripState = await p.evaluate(() => {
	const st = document.getElementById('arte-strip');
	if (!st) return null;
	return { shown: getComputedStyle(st).display !== 'none', text: st.textContent };
});
check('the workspace strip is on screen even with nothing kept yet',
	!!stripState && stripState.shown && /\S/.test(stripState.text),
	JSON.stringify(stripState));

await p.click('#arte-strip');
await p.waitForTimeout(600);
const addBtn = await p.evaluate(() => {
	const b = document.querySelector('#arte-list [data-act="attach-add"]');
	if (!b) return null;
	const r = b.getBoundingClientRect();
	return { text: b.textContent, title: b.title, w: Math.round(r.width), h: Math.round(r.height) };
});
check('opening it reveals the control that attaches the first thing, with real size',
	!!addBtn && addBtn.text === '+' && addBtn.w > 0 && addBtn.h > 0, JSON.stringify(addBtn));
check('and a line saying what keeping something here is for',
	await p.evaluate(() => /\S/.test((document.querySelector('#arte-list .arte-empty') || {}).textContent || '')),
	await p.evaluate(() => (document.querySelector('#arte-list .arte-empty') || {}).textContent || '(nothing)'));
await shot(s, 'lane4-3-empty-strip-open');

// Press it, and go all the way through: a picker that opens but attaches
// nothing would be the same defect one step further along.
await p.click('#arte-list [data-act="attach-add"]');
await p.waitForSelector('.attach-pick-tick[data-path="attach-spec.md"]', { timeout: 10000 });
await p.click('.attach-pick-tick[data-path="attach-spec.md"]');
await p.click('.dlg-ok');
await p.waitForTimeout(1500);

const nowLinks = JSON.parse(await app('links_touching', ['diamond:' + bareId]) || '[]');
const held = nowLinks.find((l) => /attach-spec\.md$/.test(String(l.other)));
check('the picker reached from that control actually attaches the file',
	!!held && held.rel === 'holds', JSON.stringify(nowLinks));
const tileNow = await p.evaluate(() => [...document.querySelectorAll('#arte-list .arte-row')]
	.map((r) => (r.querySelector('.arte-open') || {}).textContent || ''));
check('and the tile for it names that path',
	tileNow.some((x) => /attach-spec\.md/.test(x)), JSON.stringify(tileNow));
await shot(s, 'lane4-3-attached');

});

// ══ §4 A link's relations are chips on both surfaces ══════════════════════
await section('§4 Link relations', async () => {

// The READ side first, on a record the store already holds: two relations in
// one field, which is what the Graph has written since the set arrived.
other = await app('create_diamond', ['Brand voice']);
await app('add_link', [bareId, 'diamond:' + bareId, 'diamond:' + other, 'blocks,informs', '', 'user']);
// The far end has to be ON THE RAIL, or the form's picker has nothing to offer:
// it searches the Diamonds the app is holding, not the store.
await p.evaluate(() => window.DaimondCore.loadDiamonds());
await p.waitForTimeout(900);
await p.evaluate((id) => {
	const box = [...document.querySelectorAll('.diamond-box')].find((b) => b.dataset.id === id);
	box.querySelector('.session-box-name, .session-box-open, button').click();
}, bareId);
await p.waitForTimeout(1200);
await p.evaluate(() => window.DaimondLinks.toggle(true));
await p.waitForTimeout(800);
check('the Links section opened on the Diamond under test',
	await p.isVisible('#link-add') || await p.isVisible('#link-form'),
	await p.textContent('#link-strip'));

const relShapes = () => p.$$eval('.link-row', (els) => els.map((e) => ({
	other: e.dataset.other,
	rels:  [...e.querySelectorAll('.link-phrase .link-rel')].map((c) => ({
		text: c.textContent.replace(/×$/, '').trim(),
		chip: c.classList.contains('tag-chip'),
	})),
})));
let shapes = await relShapes();
const two = shapes.find((r) => /diamond:/.test(r.other) && r.rels.length);
check('a link carrying two relations draws two chips, not one string with a comma in it',
	!!two && two.rels.length === 2
	&& two.rels.map((r) => r.text).join('|') === 'blocks|informs'
	&& two.rels.every((r) => r.chip),
	JSON.stringify(two));
await shot(s, 'lane4-4-two-chips');

// The WRITE side: the form has to be able to say two things.
await p.click('#link-add');
await p.waitForSelector('#link-rel', { timeout: 8000 });
await p.fill('#link-pick', 'Brand');
await p.waitForTimeout(500);
await p.click('.link-pick-hit');
await p.waitForTimeout(400);
await p.click('.link-sug[data-rel="part-of"]');
await p.waitForTimeout(300);
const afterSug = await p.evaluate(() => ({
	box:   (document.getElementById('link-rel') || {}).value,
	chips: [...document.querySelectorAll('#link-rel-chips .tag-chip')]
		.map((c) => c.textContent.replace(/×$/, '').trim()),
}));
check('a suggestion becomes a chip on the link and empties the box for the next word',
	afterSug.chips.join('|') === 'part-of' && afterSug.box === '', JSON.stringify(afterSug));

await p.fill('#link-rel', 'blocks');
await p.press('#link-rel', 'Enter');
await p.waitForTimeout(300);
const bothChips = await p.evaluate(() => [...document.querySelectorAll('#link-rel-chips .tag-chip')]
	.map((c) => c.textContent.replace(/×$/, '').trim()));
check('a word typed and entered joins it, so the form can say two things',
	bothChips.join('|') === 'part-of|blocks', JSON.stringify(bothChips));
await shot(s, 'lane4-4-form-chips');

await p.click('#link-save');
await p.waitForTimeout(1500);
const saved = JSON.parse(await app('links_touching', ['diamond:' + bareId]) || '[]')
	.filter((l) => l.other === 'diamond:' + other);
const made = saved.find((l) => /part-of/.test(l.rel || ''));
check('the store keeps both, in the one field the Graph reads',
	!!made && made.rel === 'part-of,blocks', JSON.stringify(saved.map((l) => l.rel)));

shapes = await relShapes();
const drawn = shapes.find((r) => r.rels.map((x) => x.text).join('|') === 'part-of|blocks');
check('and the row it drew shows them as two chips as well',
	!!drawn && drawn.rels.every((r) => r.chip), JSON.stringify(shapes.map((r) => r.rels)));

// A chip closes, which is the other half of editing a set.
await p.click('#link-add');
await p.waitForSelector('#link-rel', { timeout: 8000 });
await p.click('.link-sug[data-rel="part-of"]');
await p.waitForTimeout(300);
await p.click('.link-sug[data-rel="relates-to"]');
await p.waitForTimeout(300);
await p.evaluate(() => {
	const c = [...document.querySelectorAll('#link-rel-chips .tag-chip')]
		.find((x) => x.textContent.replace(/×$/, '').trim() === 'part-of');
	c.querySelector('.tag-x').click();
});
await p.waitForTimeout(300);
const left = await p.evaluate(() => [...document.querySelectorAll('#link-rel-chips .tag-chip')]
	.map((c) => c.textContent.replace(/×$/, '').trim()));
check('closing a chip takes that relation off and leaves the rest',
	left.join('|') === 'relates-to', JSON.stringify(left));
await p.click('#link-cancel');
});

const errs = errors ? errors(s) : (s.errs || []);
console.log('\n' + (RED ? 'RED RUN (HEAD code) ' : 'GREEN RUN ')
	+ ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) console.log('failed:\n  ' + bad.join('\n  '));
if (errs && errs.length) console.log('console errors:\n  ' + errs.slice(0, 8).join('\n  '));
await s.close();
process.exit(bad.length ? 1 : 0);
