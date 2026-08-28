// verify_queuebadge.mjs — the queue badge on a DIAMOND tile: that it is drawn,
// that it updates in place, and that a message typed into a busy daimon is held
// rather than swallowed.
//
// `queueBadge` was called from exactly one place, the ordinary-chat tile, so a
// Diamond's tile said nothing about what was waiting on its daimon -- though
// `app.css` states as settled fact that Simple keeps "the pause light, the name, the
// queue badge, the pending-fold badge and the tags", and every other item in that
// list is a Diamond-tile thing.
//
// TWO TRAPS, AND THEY ARE THE POINT OF THE FILE.
//
//   1. `updateQueueBadges` scanned `sessionList` alone, wanted a `.tile-active-top`
//      container a Diamond tile does not have, and looked the record up by
//      `byId[box.dataset.id]` -- but a Diamond tile's `dataset.id` is the DIAMOND'S
//      id, not its daimon conversation's. Any of the three wrong and the badge is
//      drawn once by `diamondBox` and then either frozen or stripped on the next
//      pass: correct-looking the moment it appears and wrong for ever after. So the
//      badge is asserted to CHANGE without a rail redraw, not merely to exist.
//
//   2. Nothing could put anything in a daimon's queue. `sendUserMessage`'s Diamond
//      branch read `if (crystalBusy) return;` and did nothing else, while the Send
//      button stayed enabled and read "Send" -- `sendMode` asks `curGen`, which reads
//      `_generating`, and a steer sets `crystalBusy` instead. The press was swallowed
//      whole. A badge over a queue that can never fill is decoration, so the queue is
//      exercised through the composer here, the way a person fills it.
//
//   node dev/verify_queuebadge.mjs --break railonly   # updateQueueBadges scans one rail again
//   node dev/verify_queuebadge.mjs --break byid       # the daimon looked up by the Diamond's id
//   node dev/verify_queuebadge.mjs --break swallow    # a busy daimon drops what you type
//   node dev/verify_queuebadge.mjs --break meterrow   # the badge on the row Simple hides
//   node dev/verify_queuebadge.mjs                    # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const die = (why) => { console.error('ABORT: ' + why); process.exit(2); };

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const BREAKS = {
	railonly: {
		what: 'updateQueueBadges scans the chats rail alone, as it always did',
		edit: (src) => src.replace(
			'\t\tif (diamondList) boxes = boxes.concat(\n'
			+ '\t\t\tArray.prototype.slice.call(diamondList.querySelectorAll(\'.diamond-box\')));',
			'\t\t/* railonly: the Diamonds rail is not looked at */'),
	},
	byid: {
		what: 'a Diamond tile\'s conversation looked up by the DIAMOND\'s id, in the chats map',
		edit: (src) => src.replace(
			'\t\tif (box.classList.contains(\'diamond-box\')) {',
			'\t\tif (false) {'),
	},
	swallow: {
		what: 'a message typed into a busy daimon is dropped, as it was before',
		edit: (src) => src.replace(
			'\t\t\tif (diamondBusy(current.diamondId)) { enqueueMessage(current, text); return; }',
			'\t\t\tif (diamondBusy(current.diamondId)) return;'),
	},
	meterrow: {
		what: 'the badge kept on the meter row, which Simple hides outright',
		edit: (src) => src.replace(
			'\t\tif (!box.classList.contains(\'diamond-box\')) return box.querySelector(\'.tile-active-top\');\n'
			+ '\t\tvar meta = box.querySelector(\'.session-box-meta\');',
			'\t\tif (!box.classList.contains(\'diamond-box\')) return box.querySelector(\'.tile-active-top\');\n'
			+ '\t\tvar meta = box.querySelector(\'.diamond-meter\');'),
	},
};
if (BREAK && !BREAKS[BREAK]) die(`no break called "${BREAK}"`);
if (BREAK) console.log(`\n*** BREAK ${BREAK}: ${BREAKS[BREAK].what} — failures below are the point ***\n`);

const SRC = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
const BROKEN = BREAKS[BREAK] ? BREAKS[BREAK].edit(SRC) : SRC;
if (BREAK && BROKEN === SRC) die(`the "${BREAK}" break no longer matches www/js/daimond.js`);

const s = await open({
	name:  'queuebadge' + (BREAK ? '-' + BREAK : ''),
	route: BREAK ? (async (page) => {
		await page.route('**/js/daimond.js', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: BROKEN,
		}));
	}) : null,
});
const p = s.page;
await p.waitForFunction(() => !!window.DaimondDiamond && !!window.DaimondModels, null, { timeout: 20000 });

const [A, B] = await p.evaluate(() =>
	[...document.querySelectorAll('#diamond-list .diamond-box')].map(b => b.dataset.id));
if (!A || !B) die('this world does not hold the two seeded Diamonds');

/// What the tile SAYS, measured as ink on the rail rather than as a computed
/// `display`: a badge inside a hidden row still answers `display: inline` for
/// itself, so only geometry can say whether anybody can read it.
const badgeOn = (id) => p.evaluate((i) => {
	const box = document.querySelector(`#diamond-list .diamond-box[data-id="${i}"]`);
	if (!box) return { tile: false };
	const b = box.querySelector('.queue-badge');
	if (!b) return { tile: true, badge: false };
	const r = b.getBoundingClientRect();
	const t = box.getBoundingClientRect();
	return {
		tile: true, badge: true,
		text: b.textContent || '',
		// Drawn, and drawn INSIDE its own tile: a badge with area somewhere off the
		// rail is not a badge the reader of that tile can see.
		ink:  r.width > 0 && r.height > 0,
		within: r.top >= t.top - 1 && r.bottom <= t.bottom + 1,
		// Which row it landed in, since that is what decides whether Simple keeps it.
		row:  (b.parentElement || {}).className || '',
	};
}, id);

const goDiamond = (id) => p.evaluate((i) => {
	document.querySelector(`#diamond-list .diamond-box[data-id="${i}"]`).click();
}, id);
const say = (text) => p.evaluate((t) => {
	const el = document.getElementById('chat-input');
	el.value = t;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	document.getElementById('chat-send').click();
}, text);
const queued = () => p.evaluate((i) =>
	(window.DaimondDiamond.conversation(i)._queue || []).slice(), A);

// ── 1. A busy daimon HOLDS what is typed into it ───────────────────
console.log('\n1. a message typed into a busy daimon\n');
await goDiamond(A);
await p.waitForTimeout(500);
await say('@slow 6000');                       // the turn this queues behind
await p.waitForTimeout(900);
// THE CONTROL for everything below: nothing here means anything unless the daimon
// really was busy when the second message was typed. `_generating` is set on the
// daimon's own record for the length of the steer.
check('the control: the daimon was mid-turn when the next message was typed',
	await p.evaluate((i) => !!window.DaimondDiamond.conversation(i)._generating, A));
await say('held one');
await p.waitForTimeout(300);
check('what was typed while it ran is held, not dropped',
	(await queued()).length === 1, JSON.stringify(await queued()));
check('and the composer was cleared, so the press did something visible',
	(await p.evaluate(() => document.getElementById('chat-input').value)) === '');

// ── 2. The badge is on the Diamond's tile, in the row Simple keeps ──
console.log('\n2. the badge on the tile\n');
{
	const b = await badgeOn(A);
	check('the Diamond\'s tile carries a queue badge', !!b.badge, JSON.stringify(b));
	check('the badge is ink on the tile, not a node with no area',
		!!(b.badge && b.ink && b.within), JSON.stringify(b));
	// `app.css` keeps a meta row alive in Simple exactly when it holds a
	// `.diamond-pending`; `.diamond-meter` it hides outright. So the row the badge
	// lands in decides whether the stylesheet's own sentence is true.
	check('and it is in the meta row, the one Simple keeps for a pending badge',
		/session-box-meta/.test(b.row || ''), JSON.stringify(b.row));
	check('no other Diamond\'s tile grew one',
		(await badgeOn(B)).badge === false);
}

// ── 3. Simple keeps it ─────────────────────────────────────────────
console.log('\n3. Simple keeps the badge, as app.css says it does\n');
{
	const was = await p.evaluate(() => window.DaimondView.get && window.DaimondView.get());
	await p.evaluate(() => window.DaimondView.set('simple'));
	await p.waitForTimeout(400);
	const b = await badgeOn(A);
	check('the badge survives Simple', !!(b.badge && b.ink && b.within), JSON.stringify(b));
	await shot(s, 'queuebadge-simple');
	await p.evaluate((w) => window.DaimondView.set(w || 'max'), was);
	await p.waitForTimeout(400);
}

// ── 4. IT UPDATES IN PLACE ─────────────────────────────────────────
//
// The half that a badge drawn only by `diamondBox` would pass on and then fail for
// ever. The rail is NOT redrawn here: the count is changed and `updateQueueBadges`
// is left to do its work, which is what it exists for.
console.log('\n4. the badge follows the queue without a rail redraw\n');
{
	const before = await badgeOn(A);
	// A second message, through the composer again.
	await say('held two');
	await p.waitForTimeout(300);
	const after = await badgeOn(A);
	check('two are queued now', (await queued()).length === 2, JSON.stringify(await queued()));
	check('the badge text changed with the queue, in place',
		!!(after.badge && after.text && after.text !== before.text),
		`${JSON.stringify(before.text)} -> ${JSON.stringify(after.text)}`);

	// And back down: emptying the queue must take the badge away, on the same path.
	await p.evaluate((i) => {
		window.DaimondDiamond.conversation(i)._queue = [];
		// The app's own refresh, not a rail rebuild -- see `renderQueue`.
		document.getElementById('chat-input').dispatchEvent(new Event('input', { bubbles: true }));
	}, A);
	await p.evaluate(() => window.dispatchEvent(new Event('resize')));
	// `renderQueue` is what calls `updateQueueBadges`, and it is reached by the
	// composer's own path: taking a queued bubble back withdraws it.
	await p.evaluate(() => {
		const x = document.querySelector('#chat-queued .queue-x');
		if (x) x.click();
	});
	await p.waitForTimeout(300);
	const gone = await badgeOn(A);
	check('an emptied queue takes the badge away again', gone.badge === false, JSON.stringify(gone));
	check('and the empty meta row goes with it, rather than costing its margin',
		await p.evaluate((i) => {
			const box = document.querySelector(`#diamond-list .diamond-box[data-id="${i}"]`);
			const m = box.querySelector('.session-box-meta');
			return !m || !!m.firstChild;
		}, A));
}

// ── 5. The queue drains when the turn is over ──────────────────────
console.log('\n5. what was held is sent, once the daimon is free\n');
{
	await p.evaluate((i) => { window.DaimondDiamond.conversation(i)._queue = ['@text drained']; }, A);
	await p.evaluate(() => {
		const b = document.getElementById('chat-input');
		b.dispatchEvent(new Event('input', { bubbles: true }));
	});
	// Wait out the steer that is still running, then a moment for the drain.
	const t0 = Date.now();
	while (Date.now() - t0 < 40000) {
		if ((await queued()).length === 0) break;
		await p.waitForTimeout(400);
	}
	check('the held message was sent rather than left waiting for ever',
		(await queued()).length === 0, JSON.stringify(await queued()));
}

const errs = errors(s).filter(e => !/favicon|401|402|502|Unauthorized|Payment|Bad Gateway/i.test(e));
check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await s.close();

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) console.log('  ' + bad.join('\n  '));
if (BREAK) {
	console.log(bad.length
		? '\nTHE BREAK WAS CAUGHT.'
		: '\nTHE BREAK WAS NOT CAUGHT: this check proves nothing');
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
