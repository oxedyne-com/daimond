// verify_tiledlg.mjs — the cog, the dialog, and Delete at its foot.
//
// Phase C put a cog in the top right of every Diamond and chat tile and moved
// Delete into the dialog it opens. Four properties follow, and each is written
// as a SEARCH of the page rather than as "press this, expect that" — a check
// that names one button passes on a page where that button is the only thing
// left.
//
//   1. Every tile carries a cog. A Diamond tile carries no closer cross — the
//      DIALOG has one, in its title row, which is the way out of a window of
//      settings. notes4 put a cross back on a CHAT tile specifically ("chats
//      are ephemeral but not disposable"), so that half of the claim now
//      holds only for a Diamond; a chat tile's own cross, and the confirm
//      behind it, is verify_chattiles's subject, not this file's.
//   2. Delete is reachable from the dialog, it is the ONLY way to remove a
//      DIAMOND by hand, and it asks before it acts.
//   3. The dialog carries the settings the tile does not show — the pause
//      control and the two colours — and carries no level control, because
//      Simple and Max are global (notes3). Simple really hides what Max shows,
//      and that choice, being the view's, survives a reload.
//   4. Answering "no" to the confirm leaves the tile exactly where it was.
//
// Every check is gated on the thing it needs existing: a page with no tiles
// satisfies "no cross on any tile" for free, so the tile count is asserted
// first and the run refuses to be quietly vacuous.
//
//   node dev/verify_tiledlg.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway; nothing spends.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { open, scratch } from './harness.mjs';

const OUT = path.join(os.homedir(), '.cache/daimond/tiledlg-shots');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

/// A screenshot that is PROVEN to exist. `shot()` in the harness swallows a
/// failed capture, and under load on this box capture has silently failed for
/// an hour at a time, so a clean run is not evidence that anything was taken.
async function snap(page, name, sel) {
	const p = path.join(OUT, name + '.png');
	try {
		const target = sel ? await page.$(sel) : page;
		if (!target) { console.log(`  note  no ${sel} to photograph`); return null; }
		await target.screenshot({ path: p, timeout: 8000 });
	} catch (e) { console.log(`  note  screenshot ${name} failed: ${String(e).split('\n')[0]}`); return null; }
	if (!fs.existsSync(p) || fs.statSync(p).size < 500) { console.log(`  note  screenshot ${name} is not on disk`); return null; }
	return p;
}

/// Make a Diamond through the dialog a person uses.
async function makeDiamond(page, name) {
	await page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await page.waitForSelector('.dlg-card', { timeout: 8000 });
	await page.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')].find((c) => c.getClientRects().length);
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	await page.waitForTimeout(1500);
}

/// Make a chat tile (pending is enough: it is a tile with a cog).
async function makeChat(page) {
	await page.evaluate(() => document.getElementById('new-session-btn').click());
	await page.waitForTimeout(700);
}

/// Open the cog dialog of the first tile in `listSel`.
async function openCog(page, listSel) {
	const hit = await page.evaluate((sel) => {
		const box = document.querySelector(sel + ' .session-box');
		if (!box) return 'no tile';
		const cog = box.querySelector('.tile-cog');
		if (!cog) return 'no cog';
		cog.click();
		return 'ok';
	}, listSel);
	if (hit !== 'ok') throw new Error(hit);
	await page.waitForSelector('.tile-dlg-card', { timeout: 8000 });
	await page.waitForTimeout(200);
}

const s = await open({ name: 'tiledlg', profile: scratch('pw', 'tiledlg-' + process.pid) });
const { page } = s;
try {
	await page.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); });
	await page.waitForTimeout(200);
	await makeDiamond(page, 'Alpha');
	await makeChat(page);

	// ── 0. The gate. Without tiles, every property below is vacuous. ──
	const counts = await page.evaluate(() => ({
		diamonds: document.querySelectorAll('#diamond-list .session-box').length,
		chats:    document.querySelectorAll('#session-list .session-box').length,
	}));
	check(counts.diamonds >= 1 && counts.chats >= 1,
		'the rail holds a Diamond and a chat to judge',
		`${counts.diamonds} Diamond(s), ${counts.chats} chat(s)`);
	if (!(counts.diamonds >= 1 && counts.chats >= 1)) {
		console.log('\nnothing to test against — refusing to report a vacuous pass.');
		await s.close();
		process.exit(1);
	}
	await snap(page, 'rail-with-cogs', '#panel-rail');

	// ── 1. A cog on every tile. A cross on a chat tile, none on a Diamond's ──
	const corner = await page.evaluate(() => {
		const boxes   = [...document.querySelectorAll('.session-box')];
		const diamond = [...document.querySelectorAll('#diamond-list .session-box')];
		const chat    = [...document.querySelectorAll('#session-list .session-box')];
		return {
			total:   boxes.length,
			withCog: boxes.filter((b) => b.querySelector('.tile-cog')).length,
			diamondTotal:   diamond.length,
			diamondCrosses: diamond.filter((b) => b.querySelector('.tile-x')).length,
			chatTotal:      chat.length,
			chatCrosses:    chat.filter((b) => b.querySelector('.tile-x')).length,
		};
	});
	check(corner.withCog === corner.total, 'every tile carries a cog',
		`${corner.withCog} of ${corner.total}`);
	check(corner.diamondTotal > 0 && corner.diamondCrosses === 0,
		'a Diamond tile carries no closer cross — the dialog is the way out',
		`${corner.diamondCrosses} of ${corner.diamondTotal}`);
	// notes4: brought back for a chat only, because a chat is ephemeral but not
	// disposable. The confirm behind it is verify_chattiles's job, not this
	// file's — here it is only asked whether the button exists.
	check(corner.chatTotal > 0 && corner.chatCrosses === corner.chatTotal,
		'and a chat tile carries one, restored by notes4',
		`${corner.chatCrosses} of ${corner.chatTotal}`);

	// ── 2. The dialog, and Delete at its foot ──
	await openCog(page, '#diamond-list');
	await snap(page, 'diamond-dialog', '.tile-dlg-card');
	const dlg = await page.evaluate(() => {
		const card = document.querySelector('.tile-dlg-card');
		if (!card) return null;
		const btns = [...card.querySelectorAll('button')];
		const del = card.querySelector('.tile-dlg-delete');
		const foot = card.querySelector('.tile-dlg-foot');
		const closer = card.querySelector('.tile-dlg-title .tile-dlg-done');
		return {
			hasPause: !!card.querySelector('.pptw'),
			// By `[data-level]`, which is what the deleted per-tile control was
			// marked with. `.tile-dlg-level` on its own is now worn by the colour
			// reset and by Fold context in a chat's dialog, so a bare-class check
			// would report a control that is not the one being asked about.
			levels: [...card.querySelectorAll('[data-level]')].map(b => b.dataset.level),
			// The way out, which is a cross in the title row and no longer a Done
			// at the foot. It keeps `tile-dlg-done` deliberately: that class has
			// never meant "the button that says Done", it means "the control that
			// finishes with this dialog", and half the suite reaches for it.
			closerInTitle: !!closer,
			closerNotInFoot: !!(closer && foot && !foot.contains(closer)),
			closerNamed: !!(closer && (closer.getAttribute('aria-label') || '').trim()),
			// The colours, by the field each writes rather than by how many
			// pickers happen to be there.
			swatches: [...card.querySelectorAll('.tile-dlg-swatch')].map(i => ({
				id: i.id, type: i.type,
				// The label earns its click: `htmlFor` pointing at this input is
				// what makes the word a way into the control it names.
				labelled: !!card.querySelector(`label.tile-dlg-label[for="${i.id}"]`),
			})),
			hasClear: !!card.querySelector('.tile-dlg-clear'),
			hasDelete: !!del,
			deleteInFoot: !!(del && foot && foot.contains(del)),
			// The foot is the last block of the card: "at the bottom of the dialog".
			footLast: !!(foot && card.lastElementChild === foot),
			labels: btns.map((b) => (b.textContent || '').trim()),
		};
	});
	check(!!dlg, 'the cog opens a dialog');
	// THE DIALOG ALWAYS CARRIES IT, even for a Diamond whose tile draws none.
	// Taking the light off an unautomated tile is a statement about clutter; the
	// object is still in the pause tree, still held by the global control, and
	// this dialog is where it can be let go from. A version of this change that
	// dropped the node here too left such a Diamond with no release valve at all.
	check(dlg && dlg.hasPause,
		'the dialog carries the pause control — it is the release valve for a tile with no light',
		JSON.stringify(dlg && dlg.hasPause));
	// The level control is GONE, and this is the check that says so. It used to
	// assert which levels were offered; the property it was protecting — that a
	// tile can always be got back into step with the global view — is now kept
	// by there being nothing here that can take it out of step in the first
	// place, so that is what is asserted instead.
	check(dlg && (dlg.levels || []).length === 0,
		'the dialog offers no level control — Simple and Max are global, so a tile cannot detach itself',
		dlg && ((dlg.levels || []).join(',') || 'none'));
	// The way out. Named as well as drawn: a lone × with no accessible name is a
	// button a screen reader announces as "×".
	check(dlg && dlg.closerInTitle && dlg.closerNotInFoot,
		'the way out is a cross in the title row, not a Done at the foot',
		dlg && JSON.stringify({ inTitle: dlg.closerInTitle, notInFoot: dlg.closerNotInFoot }));
	check(dlg && dlg.closerNamed, 'and it says what it is to a reader who cannot see it');
	// The colours, by the field each picker writes. Two pickers is not the
	// property — a background and a text colour is.
	check(dlg && (dlg.swatches || []).some(i => /-bg-/.test(i.id))
		&& (dlg.swatches || []).some(i => /-fg-/.test(i.id)),
		'the dialog offers a background colour and a text colour',
		dlg && JSON.stringify((dlg.swatches || []).map(i => i.id)));
	check(dlg && (dlg.swatches || []).length > 0
		&& (dlg.swatches || []).every(i => i.type === 'color' && i.labelled),
		'each is a real colour input with a label bound to it, so the word focuses the control it names',
		dlg && JSON.stringify(dlg.swatches));
	check(dlg && dlg.hasClear, 'and there is a way back to the theme’s own colours');
	check(dlg && dlg.hasDelete && dlg.deleteInFoot && dlg.footLast,
		'Delete is at the foot of the dialog', dlg && JSON.stringify(dlg.labels));

	// ── The colours, driven rather than described ──
	//
	// A picker that paints the tile and writes nothing is the failure worth
	// catching: `daimond-tile-prefs` is what the Graph reads to paint the same
	// Diamond, so a colour that reached the rail and not the store is a colour
	// the picture never hears about.
	{
		const tileId = await page.evaluate(() =>
			document.querySelector('#diamond-list .session-box').dataset.id);
		const painted = await page.evaluate(() => {
			const card = document.querySelector('.tile-dlg-card');
			const put = (which, hex) => {
				const inp = [...card.querySelectorAll('.tile-dlg-swatch')]
					.find(i => new RegExp('-' + which + '-').test(i.id));
				if (!inp) return null;
				inp.value = hex;
				inp.dispatchEvent(new Event('input', { bubbles: true }));
				return hex;
			};
			const bg = put('bg', '#123456');
			const fg = put('fg', '#abcdef');
			const box = document.querySelector('#diamond-list .session-box');
			const name = box.querySelector('.session-box-name');
			return { bg, fg, back: box.style.backgroundColor,
				ink: name ? name.style.color : '' };
		});
		const rec = await page.evaluate((i) =>
			JSON.parse(localStorage.getItem('daimond-tile-prefs') || '{}')[i] || {}, tileId);
		check(rec.bg === '#123456' && rec.fg === '#abcdef',
			'the pickers write both colours into daimond-tile-prefs, which is where the Graph reads them',
			JSON.stringify(rec));
		check(/18,\s*52,\s*86/.test(painted.back || ''),
			'and the tile takes the background at once, not at the next reload', painted.back);
		// The ink is the other half: the stylesheet colours the name, the meta and
		// the chips individually, so a tile that took a background and kept its old
		// text is the failure this half exists for.
		check(/171,\s*205,\s*239/.test(painted.ink || ''),
			'and the words inside it take the text colour with it', painted.ink);

		await page.evaluate(() => document.querySelector('.tile-dlg-card .tile-dlg-clear').click());
		await page.waitForTimeout(250);
		const cleared = await page.evaluate((i) => ({
			rec: JSON.parse(localStorage.getItem('daimond-tile-prefs') || '{}')[i] || {},
			back: document.querySelector('#diamond-list .session-box').style.backgroundColor,
		}), tileId);
		// A stored empty string is not the same as an absent field: "the theme's
		// own" IS the absence, and a record that keeps the key around invites a
		// later reader to treat it as a value.
		check(!('bg' in cleared.rec) && !('fg' in cleared.rec),
			'the reset takes both fields OUT of the record rather than storing an empty one',
			JSON.stringify(cleared.rec));
		check(!cleared.back, 'so the tile is drawn in the theme’s colours again',
			JSON.stringify(cleared.back));
	}

	// AND THE TILE IS THE OTHER HALF OF THE RULE: no light until the Diamond has
	// something that spends unbidden, then one. Measured on the tile rather than
	// in the dialog, because that is where the user's instruction applies.
	{
		// Closed by the control that means "finished with this dialog", which is
		// the cross. Reaching for the last `.dlg-ok` in the card would now press
		// DELETE: the foot holds nothing else since Done left it.
		await page.evaluate(() => {
			const c = document.querySelector('.tile-dlg-card .tile-dlg-done');
			if (c) c.click(); else document.querySelector('.tile-dlg').remove();
		});
		await page.waitForTimeout(400);
		check(await page.evaluate(() => !document.querySelector('.tile-dlg-card')),
			'the closer cross really closes the dialog');
		// THE FIRST TILE, not any tile in the list. `#diamond-list .session-box
		// .pptw` matches a light inside ANY box, and the Optimiser ships with a
		// timer and therefore a light — so this said "true" for a tile that has
		// none. Scope it to the box being talked about.
		const bare = await page.evaluate(() => {
			const b = document.querySelector('#diamond-list .session-box');
			return !!(b && b.querySelector('.pptw'));
		});
		check(!bare, 'a Diamond with no actions carries no light on its TILE', String(bare));

		await page.evaluate(async () => {
			const id = document.querySelector('#diamond-list .session-box').dataset.id;
			const ta = DaimondTriggers.blank('activity');
			ta.id = 'activity-1';
			ta.instruction = 'Say one useful thing.';
			await DaimondCore.triggerSet(id, ta);
		});
		await page.waitForTimeout(600);
		const armed = await page.evaluate(() => {
			const b = document.querySelector('#diamond-list .session-box');
			return {
				has:   !!b.querySelector('.pptw'),
				order: [...b.querySelector('.session-box-header').children]
					.map((el) => el.className.split(' ')[0]).join(','),
			};
		});
		check(armed.has, 'and one WITH an action grows one', JSON.stringify(armed));
		check(/^session-box-name,pptw,tile-cog/.test(armed.order),
			'to the right of the name, hard against the cog', armed.order);
		// And no chat tile has one at all — the user's ruling, and the same rule:
		// a chat spends when you type in it and at no other time.
		const chat = await page.evaluate(() =>
			!!document.querySelector('#session-list .session-box .pptw'));
		check(!chat, 'while an ordinary chat carries none at all', String(chat));

		await openCog(page, '#diamond-list');
	}

	// ── 3. Delete asks nothing, because it takes nothing away ──
	//
	// This used to assert a confirm and a "no" that left the tile standing. Since
	// the trash, Delete is reversible and asks nothing — the question moved to
	// "Delete permanently" and "Empty trash", where it is true (see
	// dev/verify_trash.mjs). What is asserted here is the pair that makes the
	// silence safe: the tile goes, AND the Diamond is in the trash.
	const before = await page.evaluate(() =>
		[...document.querySelectorAll('#diamond-list .session-box-name')].map((n) => n.textContent.trim()));
	await page.evaluate(() => document.querySelector('.tile-dlg-delete').click());
	await page.waitForTimeout(1800);
	const asked = await page.evaluate(() => {
		const dlgs = [...document.querySelectorAll('.modal.dlg .dlg-card')]
			.filter((c) => c.getClientRects().length && !c.classList.contains('tile-dlg-card'));
		return dlgs.length ? (dlgs[0].querySelector('.dlg-msg') || {}).textContent || '(no message)' : null;
	});
	check(asked === null, 'Delete asks nothing — it is reversible',
		asked ? `a dialog opened: ${asked.slice(0, 60)}…` : 'no dialog');
	const after = await page.evaluate(() =>
		[...document.querySelectorAll('#diamond-list .session-box-name')].map((n) => n.textContent.trim()));
	check(!after.includes('Alpha') && before.includes('Alpha'),
		'and the Diamond leaves the rail', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

	// ── 4. Where it went ──
	const inTrash = await page.evaluate(async () => {
		try { return (await window.DaimondCore.trashList()).map((x) => x.name); }
		catch (e) { return []; }
	});
	check(inTrash.includes('Alpha'), 'IT IS IN THE TRASH, which is why Delete no longer has to ask',
		JSON.stringify(inTrash));
	await page.evaluate(() => window.DaimondPanels.show('trash'));
	await page.waitForTimeout(700);
	await snap(page, 'delete-trash', '#panel-trash');

	// ── 5. Simple hides, Max shows, and the choice survives a reload ──
	//
	// Driven through `DaimondView`, which is the whole of the control now: the
	// dialog no longer offers a level, so the only way to change what a tile
	// draws is the one control in the appearance menu. What is measured is still
	// the TILE, because the tile is where a user would notice the rule failing.
	// The view's own segmented control is verify_view's subject.
	//
	// The Diamond is TAGGED first, and that is not decoration. Simple also drops
	// the whole meta row when nothing in it is a tag — so on an untagged tile the
	// timestamp is invisible whether or not the rule that hides it exists, and
	// the check passed against CSS with that rule deleted. Proved by deleting it:
	// the run stayed green. A tag keeps the row on screen, so what is being
	// measured is the rule and not the row.
	await makeDiamond(page, 'Beta');
	await page.evaluate(() => {
		const box = document.querySelector('#diamond-list .session-box');
		const meta = box.querySelector('.session-box-meta');
		const chip = document.createElement('span');
		chip.className = 'tag-chip tag-sm';
		chip.textContent = 'kept';
		meta.appendChild(chip);
	});
	await page.waitForTimeout(200);
	const shownAt = () => page.evaluate(() => {
		const box = document.querySelector('#diamond-list .session-box');
		if (!box) return null;
		// PRESENT and VISIBLE are different questions. A check that only asks
		// "is it on screen?" passes on a page where the element was never built,
		// which is the vacuous pass this whole file exists to avoid.
		const st = (sel) => {
			const e = box.querySelector(sel);
			return { present: !!e, visible: !!e && e.getClientRects().length > 0 };
		};
		return { detail: box.dataset.detail, ver: st('.session-box-ctx'), time: st('.session-box-time'),
			meta: st('.session-box-meta') };
	});
	const simple = await shownAt();
	check(simple && simple.detail === 'simple', 'a new tile starts Simple', simple && simple.detail);
	check(simple && simple.ver.present && simple.time.present && simple.meta.visible,
		'the tile really has a version, a timestamp and a visible meta row to hide',
		JSON.stringify(simple));
	check(simple && !simple.ver.visible && !simple.time.visible,
		'Simple hides the version and the timestamp', JSON.stringify(simple));
	await snap(page, 'tile-simple', '#diamond-list .session-box');

	await page.evaluate(() => window.DaimondView.set('max'));
	await page.waitForTimeout(300);
	const max = await shownAt();
	check(max && max.detail === 'max' && max.ver.visible && max.time.visible,
		'Max shows what Simple hid', JSON.stringify(max));
	await snap(page, 'tile-max', '#diamond-list .session-box');

	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForTimeout(1200);
	// Back through the gate.
	await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
	if (await page.$('#id-pass')) {
		await page.fill('#id-pass', 'testpass1234');
		await page.evaluate(() => document.getElementById('id-primary').click());
		await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 }).catch(() => {});
	}
	await page.waitForTimeout(2500);
	const afterReload = await shownAt();
	check(afterReload && afterReload.detail === 'max',
		'the choice survives a reload', afterReload && JSON.stringify(afterReload));
	// And it survived as the VIEW, which is the only place it is now written
	// down. A tile that came back Max because something had stamped `max` into
	// its own record would look identical here and be the bug notes3 removed.
	const kept = await page.evaluate(() => ({
		view: localStorage.getItem('daimond-view'),
		prefs: localStorage.getItem('daimond-tile-prefs') || '{}',
	}));
	check(kept.view === 'max' && !/"detail"/.test(kept.prefs),
		'and it survived as the view, with nothing written into the tile’s own record',
		JSON.stringify(kept));

	// ── 5b. And back again. A level you can raise and not lower is the one-way
	// door verify_reversible hunts; it cannot see this one, because its
	// signature does not read `aria-pressed`, so it is asserted here.
	await page.evaluate(() => window.DaimondView.set('simple'));
	await page.waitForTimeout(300);
	const backToSimple = await shownAt();
	check(backToSimple && backToSimple.detail === 'simple'
		&& !backToSimple.ver.visible && !backToSimple.time.visible,
		'Max can be turned back to Simple', backToSimple && JSON.stringify(backToSimple));

	// ── 6. Nothing on a tile DESTROYS anything ──
	//
	// Searched, not enumerated: every control inside a tile is pressed on a
	// fresh page, and the rail is counted afterwards. The rule used to be "a
	// tile that vanished without a confirm is a second delete path"; since the
	// trash it is the stronger and simpler "whatever a click removes must be
	// recoverable". A control that took a tile off the rail and put nothing in
	// the trash destroyed something, whatever it is called.
	const trashBefore = await page.evaluate(async () => {
		try { return (await window.DaimondCore.trashList()).length; } catch (e) { return 0; }
	});
	const railBefore = await page.evaluate(() =>
		document.querySelectorAll('.session-box').length);
	const controls = await page.evaluate(() => [...document.querySelectorAll('.session-box')]
		.flatMap((b, bi) => [...b.querySelectorAll('button, input, select')]
			.map((c, ci) => ({ bi, ci, what: c.className || c.tagName }))));
	let vanished = [];
	for (const c of controls) {
		const gone = await page.evaluate(({ bi, ci }) => {
			const boxes = [...document.querySelectorAll('.session-box')];
			const box = boxes[bi];
			if (!box) return null;
			const ctl = [...box.querySelectorAll('button, input, select')][ci];
			if (!ctl) return null;
			const was = boxes.length;
			ctl.click();
			return { was };
		}, c);
		if (!gone) continue;
		await page.waitForTimeout(250);
		const now = await page.evaluate(() => ({
			tiles: document.querySelectorAll('.session-box').length,
			modal: !!document.querySelector('.modal.dlg'),
		}));
		if (now.tiles < gone.was && !now.modal) vanished.push(c.what);
		// Put anything that opened back down.
		await page.keyboard.press('Escape');
		await page.waitForTimeout(150);
	}
	const trashAfter = await page.evaluate(async () => {
		try { return (await window.DaimondCore.trashList()).length; } catch (e) { return -1; }
	});
	check(vanished.length === trashAfter - trashBefore,
		'no control on a tile DESTROYS anything — everything a click removed is in the trash',
		`${controls.length} control(s) pressed; ${vanished.length} tile(s) vanished `
		+ `(${vanished.join(', ') || 'none'}); trash went ${trashBefore} → ${trashAfter}`);

	// 502 is the dev server proxying to a gateway that is not running, which is
	// the ordinary state of a browser-only run and not a fault of the page.
	const errs = s.errs.filter((e) => !/favicon/i.test(e) && !/502 \(Bad Gateway\)/.test(e));
	check(errs.length === 0, 'no console errors', errs.slice(0, 3).join(' | ') || 'none');
} finally {
	await s.close();
}

console.log(failures === 0
	? `\ntiledlg: the cog is the corner and Delete is the foot. Shots in ${OUT}`
	: `\ntiledlg: ${failures} failure(s). Shots in ${OUT}`);
process.exit(failures === 0 ? 0 : 1);
