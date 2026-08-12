// verify_lane4.mjs — four controls that were drawn and did not work.
//
// Each of the four is a surface that LOOKS finished. Nothing here can be proved
// by reading a variable, because in every case the broken code holds the right
// variable and never reaches it — so every one of these presses the control the
// way a hand does and then asks what changed on the page.
//
//   §1 Pending      the tick on a draft tile opened the composer and dropped the
//                   tile in the same breath, so a composer closed without sending
//                   lost the action with nothing left to say it was ever owed.
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
//   LANE4_NAIVE=1 node dev/verify_lane4.mjs    # §1's LAST check, and only that one
//   node dev/verify_lane4.mjs                  # and all of them pass here
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { open, shot, errors } from './harness.mjs';

const RED = !!process.env.LANE4_RED;
// A second broken build, and a much narrower one: the sweep as it was first
// written, deciding on `read_file` alone. Every §1 check but ONE passes against
// it, and the one that fails is the check that says a store which cannot answer
// must not be read as "everything is done". Without this the safe direction was
// only ever proved against code that had no sweep at all — which is a check
// passing for the wrong reason, and there have been six of those here.
const NAIVE = !!process.env.LANE4_NAIVE;
const OLD = process.env.LANE4_OLD
	|| path.join(os.homedir(), '.cache/daimond/lane4-head');
const HERE = path.dirname(new URL(import.meta.url).pathname);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const head = (n) => console.log('\n── ' + n + ' ' + '─'.repeat(Math.max(0, 60 - n.length)));

/// The shipped `Pending.sweep`, rewritten to decide on `read_file` alone.
///
/// Cut from the live file at run time rather than kept as a copy, so it cannot
/// drift into being a test of something nobody ships.
const naiveBuild = () => {
	const src = fs.readFileSync(path.join(HERE, '..', 'www/js/daimond.js'), 'utf8');
	const from = '\t\t\t\tvar path = it.files[0];';
	const to   = 'if (!answered || listing.indexOf(name) !== -1) live.push(it);';
	const a = src.indexOf(from), b = src.indexOf(to);
	if (a < 0 || b < 0) throw new Error('the sweep no longer looks like this; fix naiveBuild');
	return src.slice(0, a) + [
		'\t\t\t\tvar gone = false;',
		'\t\t\t\ttry {',
		'\t\t\t\t\tvar raw = await Wasm.read_file(it.files[0]);',
		'\t\t\t\t\tgone = (typeof raw !== \'string\') || /^\\s*Error\\b/i.test(raw);',
		'\t\t\t\t} catch (e) { gone = true; }',
		'\t\t\t\tif (!gone) live.push(it);',
	].join('\n') + src.slice(b + to.length);
};

// A broken build, served in place of the fixed one. Only for a red run: a green
// run touches nothing, and neither writes to the tree.
const serveOld = async (page) => {
	if (NAIVE) {
		const body = naiveBuild();
		await page.route('**/js/daimond.js', (route) =>
			route.fulfill({ status: 200, contentType: 'application/javascript', body }));
		return;
	}
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

// ══ §1 Pending: an abandoned composer must not lose the action ═════════════
await section('§1 Pending', async () => {

// A mailbox, so the composer the tick opens is the real one rather than a
// silent refusal. Written where mail.js reads it and re-read through the
// module's own loader, so nothing here reaches past the panel's front door.
const ADDR = 'ada@example.test';
const DRAFT = `mail/${ADDR}/drafts/quote-to-ada.eml`;
await p.evaluate((addr) => {
	localStorage.setItem('daimond-mail', JSON.stringify({
		accounts: [{
			address: addr, host: 'imap.example.test', port: 993,
			smtpHost: 'smtp.example.test', smtpPort: 587,
			user: addr, pass: '', folder: 'INBOX', lastSync: 0, touched: Date.now(),
		}],
		sel: addr,
	}));
	window.DaimondMail.reload();
}, ADDR);

await p.evaluate(async ({ path, addr }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.write_file(path,
		`From: ${addr}\r\nTo: ada@buyer.test\r\nSubject: The quote you asked for\r\n`
		+ `Date: Tue, 12 Aug 2026 09:00:00 +0000\r\n\r\nHere is the quote.\r\n`);
}, { path: DRAFT, addr: ADDR });

const HEADLINE = 'Send the quote to Ada';
await p.evaluate(({ headline, file }) => window.DaimondPendingView.add({
	headline, detail: 'It is drafted and waiting on you.',
	kind: 'draft', files: [file], priority: 'high', diamondName: 'Pricing',
}), { headline: HEADLINE, file: DRAFT });
await p.waitForTimeout(500);

/// The Pending tile carrying one headline, as the page has it now.
const pendTile = (headline) => p.evaluate((h) => {
	const card = [...document.querySelectorAll('#pending-list .pend-card')]
		.find((c) => ((c.querySelector('.pend-line') || {}).textContent || '').trim() === h);
	if (!card) return null;
	return {
		id:     card.dataset.id,
		opened: !!card.querySelector('.pend-opened'),
		note:   (card.querySelector('.pend-opened') || {}).textContent || '',
	};
}, headline);

check('the tile for the draft is on the panel, named by what it would do',
	!!(await pendTile(HEADLINE)), JSON.stringify(await pendTile(HEADLINE)));

// The tick, pressed the way a hand presses it.
await p.evaluate((h) => {
	const card = [...document.querySelectorAll('#pending-list .pend-card')]
		.find((c) => ((c.querySelector('.pend-line') || {}).textContent || '').trim() === h);
	card.querySelector('.pend-go').scrollIntoView({ block: 'center' });
}, HEADLINE);
const goSel = '#pending-list .pend-card .pend-go';
await p.click(goSel);
await p.waitForTimeout(900);

const composed = await p.evaluate(() => ({
	shown:   !!document.getElementById('panel-compose')
		&& getComputedStyle(document.getElementById('panel-compose')).display !== 'none',
	subject: (document.getElementById('compose-subject') || {}).value || '',
	to:      (document.getElementById('compose-to') || {}).value || '',
}));
check('the tick opens the real composer, holding THAT draft',
	composed.shown && composed.subject === 'The quote you asked for'
	&& composed.to === 'ada@buyer.test', JSON.stringify(composed));
await shot(s, 'lane4-1-composer-open');

let tile = await pendTile(HEADLINE);
check('and the tile is still owed, because opening a window is not sending mail',
	!!tile, tile ? 'still listed' : 'the tile was dropped the moment the window opened');
check('the tile says the composer has been opened, so the tick does not read as inert',
	!!tile && tile.opened && /\S/.test(tile.note), tile ? tile.note : 'no tile');

// Abandon it: the corner cross on the compose panel, which is what a hand
// reaches for to leave a form alone.
await p.click('#panel-compose .panel-close');
await p.waitForTimeout(600);
tile = await pendTile(HEADLINE);
check('closing the composer without sending leaves the action on the list',
	!!tile, tile ? 'still listed' : 'the action was lost with the window');
const stillThere = await p.evaluate(async (f) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { const r = await m.read_file(f); return typeof r === 'string' && !/^\s*Error\b/i.test(r); }
	catch (e) { return false; }
}, DRAFT);
check('and the draft itself is untouched, so there is something left to do',
	stillThere === true, String(stillThere));
await shot(s, 'lane4-1-tile-survives');

// Now the other half: the tile must not need tidying by hand once the draft is
// really gone. Driven through the composer's own Discard, which is the mail
// panel deleting the file and telling the app it did.
await p.click(goSel);
await p.waitForTimeout(700);
const beforeDiscard = await pendTile(HEADLINE);
check('a second visit finds the same tile rather than a duplicate',
	!!beforeDiscard && beforeDiscard.id === tile.id, JSON.stringify(beforeDiscard));
await p.click('#compose-discard');
await p.waitForSelector('.dlg-ok', { timeout: 8000 });
await p.click('.dlg-ok');
await p.waitForTimeout(1200);
const goneFile = await p.evaluate(async (f) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { const r = await m.read_file(f); return !(typeof r === 'string' && !/^\s*Error\b/i.test(r)); }
	catch (e) { return true; }
}, DRAFT);
check('discarding the draft removes the file', goneFile === true, String(goneFile));
check('and the tile goes with it, unasked — the list tidies itself on the fact',
	!(await pendTile(HEADLINE)), JSON.stringify(await pendTile(HEADLINE)));
await shot(s, 'lane4-1-tile-cleared');

// The safe direction, which is the half a check on the outcome alone would
// miss: a store that cannot answer must not be read as "everything is done".
// Same sweep, same hook, a path whose folder is not there at all.
const LOST = 'Chase the invoice';
await p.evaluate((h) => {
	const id = window.DaimondPendingView.add({
		headline: h, detail: '', kind: 'draft',
		files: ['mail/nobody@nowhere.test/drafts/invoice.eml'],
	});
	// As though the composer had been opened on it in an earlier session.
	const items = JSON.parse(localStorage.getItem('daimond-pending') || '[]');
	items.forEach((x) => { if (x.id === id) x.opened = Date.now(); });
	localStorage.setItem('daimond-pending', JSON.stringify(items));
}, LOST);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);
const { signInAs } = await import('./harness.mjs');
await signInAs(s, 'lane4');
await p.waitForTimeout(2500);
await p.evaluate(() => window.DaimondPanels.show('pending'));
await p.waitForTimeout(1200);
check('a draft the store cannot be asked about is KEPT, not quietly cleared',
	!!(await pendTile(LOST)), JSON.stringify(await pendTile(LOST)));
await p.evaluate((h) => {
	const card = [...document.querySelectorAll('#pending-list .pend-card')]
		.find((c) => ((c.querySelector('.pend-line') || {}).textContent || '').trim() === h);
	if (card) card.querySelector('.pend-no').click();
}, LOST);
await p.waitForTimeout(400);
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
console.log('\n' + (RED ? 'RED RUN (HEAD code) ' : NAIVE ? 'NAIVE-SWEEP RUN ' : 'GREEN RUN ')
	+ ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) console.log('failed:\n  ' + bad.join('\n  '));
if (errs && errs.length) console.log('console errors:\n  ' + errs.slice(0, 8).join('\n  '));
await s.close();
process.exit(bad.length ? 1 : 0);
