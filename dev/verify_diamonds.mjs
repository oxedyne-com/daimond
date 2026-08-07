// verify_diamonds.mjs — a Diamond made in one window must appear in the other.
//
// Chats have carried a cross-tab signal for a long time: they live in
// localStorage, which fires `storage` in every other tab of the origin.
// Diamonds live in OPFS, which fires nothing at all — so two windows of the
// same account each held their own idea of the rail, for ever. The user's
// report was "my second Diamond disappeared, and re-creating it does nothing":
// two windows open, each blind to the other's writes.
//
// This drives two REAL pages in ONE browser profile, which is what two windows
// of one account actually are, and asks the question a person would ask: is it
// there in the other window, without reloading it?
//
// Three scenarios, one fresh profile each, so no scenario inherits the state of
// the one before it:
//   1. create in A  → shows in B
//   2. delete in B  → goes from A
//   3. create while the rail is filtered → the new Diamond is visible anyway
//
// It also covers the two silent failures beside it: a create whose read-back
// finds nothing must SAY so, and a create must never land behind a filter.
import { open, signInAs, connectMock, shot, scratch, PASS, APP } from './harness.mjs';
import fs from 'node:fs';

// How long another window is allowed to take to notice. The `storage` event is
// synchronous-ish, but the listener re-reads OPFS, and a cold OPFS read on a
// loaded machine is not instant.
const SETTLE = 2600;

const ok = [], bad = [], skipped = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// The names in a page's Diamond rail.
const rail = (p) => p.evaluate(() =>
	[...document.querySelectorAll('#diamond-list .diamond-box .session-box-name')]
		.map(n => (n.textContent || '').trim()));

/// Wait for the rail to satisfy `fn`, or give up and return what it holds.
async function railUntil(p, fn, ms = SETTLE) {
	const t0 = Date.now();
	let last = [];
	while (Date.now() - t0 < ms) {
		last = await rail(p);
		if (fn(last)) return last;
		await p.waitForTimeout(150);
	}
	return last;
}

/// Make a Diamond through the dialog a person uses: a name, the model already
/// selected, and Create.
async function create(p, name) {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	const r = await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')].find(c => c.getClientRects().length);
		if (!card) return 'no dialog';
		const inp = card.querySelector('input.dlg-input');
		if (!inp) return 'no name field';
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		const btn = card.querySelector('.dlg-ok');
		if (!btn) return 'no create button';
		btn.click();
		return 'ok';
	}, name);
	await p.waitForTimeout(900);
	return r;
}

/// Delete the named Diamond the way a person does: the cog in its corner, then
/// Delete at the foot of the dialog, then the confirm. The closer cross it used
/// to press is gone (phase C).
async function remove(p, name) {
	const found = await p.evaluate((nm) => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === nm);
		if (!box) return false;
		const cog = box.querySelector('.tile-cog');
		if (!cog) return false;
		cog.click();
		return true;
	}, name);
	if (!found) return 'not in the rail';
	await p.waitForSelector('.tile-dlg-delete', { timeout: 8000 });
	await p.evaluate(() => document.querySelector('.tile-dlg-delete').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')].find(c => c.getClientRects().length);
		card.querySelector('.dlg-ok').click();
	});
	await p.waitForTimeout(900);
	return 'ok';
}

/// A second window on the same profile, signed in and looking at the same account.
async function secondWindow(s) {
	const p2 = await s.browser.newPage();
	p2.on('pageerror', e => s.errs.push('page2: ' + e.message));
	await p2.goto(APP, { waitUntil: 'domcontentloaded' });
	await signInAs({ page: p2 }, s.name);
	await p2.waitForTimeout(600);
	return p2;
}

// ── 1 & 2: two windows, one account ──────────────────────────────────
{
	const dir = scratch('pw', 'diamonds-cross-' + process.pid);
	fs.rmSync(dir, { recursive: true, force: true });
	const s = await open({ name: 'dtabs', profile: dir });
	const p1 = s.page;
	const p2 = await secondWindow(s);

	const made = await create(p1, 'Beta');
	check('a Diamond can be made in the first window', made === 'ok', made);
	const own = await railUntil(p1, r => r.includes('Beta'));
	check('the window that made it shows it', own.includes('Beta'), own.join(', ') || 'empty');

	const other = await railUntil(p2, r => r.includes('Beta'));
	check('the OTHER window shows it, without a reload', other.includes('Beta'),
		other.join(', ') || 'empty');

	// The second window must be able to act on it, not merely list it.
	const gone = await remove(p2, 'Beta');
	check('it can be deleted from the other window', gone === 'ok', gone);
	const back = await railUntil(p1, r => !r.includes('Beta'));
	check('the deletion reaches the first window', !back.includes('Beta'),
		back.join(', ') || 'empty');

	await shot(s, 'diamonds-crosstab');
	await s.close();
}

// ── 3: a create selects what it made ─────────────────────────────────
{
	const dir = scratch('pw', 'diamonds-filter-' + process.pid);
	fs.rmSync(dir, { recursive: true, force: true });
	const s = await open({ name: 'dfilter', profile: dir });
	const p = s.page;

	await create(p, 'Alpha');
	await railUntil(p, r => r.includes('Alpha'));

	// The rail's text search was removed at the user's request, so the filter this
	// block was written around no longer exists. The property it proved does -- a
	// Diamond made while the rail is filtered must not land out of sight -- and it
	// is now proved against the TAG filter, which is the only filter left, at the
	// foot of dev/verify_tags.mjs where the tags already are.
	await create(p, 'Zeta');
	await railUntil(p, r => r.includes('Zeta'));

	// The centre followed the create, which is what selecting it means.
	const centre = await p.$eval('#current-session-name', e => e.textContent.trim());
	check('the new Diamond is the one on screen', centre === 'Zeta', centre);

	await shot(s, 'diamonds-filter');
	await s.close();
}

// ── 4: a create the store will not read back must SAY so ─────────────
//
// `list_diamonds` skips a Diamond whose meta it cannot read, silently. When the
// one it skips is the one just made, the create looks like a no-op — and a user
// who thinks nothing happened makes it again. The skip is simulated at the
// store boundary, which is the only place it can arise.
{
	const dir = scratch('pw', 'diamonds-ghost-' + process.pid);
	fs.rmSync(dir, { recursive: true, force: true });
	const s = await open({ name: 'dghost', profile: dir });
	const p = s.page;

	const patched = await p.evaluate(() => {
		if (!window.DaimondApp || !DaimondApp.prototype.list_diamonds) return false;
		const real = DaimondApp.prototype.list_diamonds;
		DaimondApp.prototype.list_diamonds = function () {
			const json = real.apply(this, arguments);
			try {
				return JSON.stringify(JSON.parse(json).filter(d => d.name !== 'Ghost'));
			} catch (e) { return json; }
		};
		window.__restoreList = () => { DaimondApp.prototype.list_diamonds = real; };
		return true;
	});
	if (!patched) {
		// Not `SKIPPED:` at the start of a line — run_all reads that as the whole
		// verifier having skipped, which would hide the checks that did run.
		skipped.push('the unreadable-read-back case: DaimondApp is an ES module import, '
			+ 'not a global, so the store cannot be faulted from the page. Proven instead by '
			+ 'injecting the fault in source (see the report).');
		console.log('  skip  the unreadable-read-back case — the store class is not reachable '
			+ 'from the page');
	} else {
		await create(p, 'Ghost');
		await p.waitForTimeout(800);
		const said = await p.evaluate(() => {
			const card = [...document.querySelectorAll('.dlg-card')].find(c => c.getClientRects().length);
			return card ? card.textContent : '';
		});
		check('a Diamond that will not read back is reported, not swallowed',
			/Ghost/.test(said) && /read it back|not readable/i.test(said),
			JSON.stringify(said.slice(0, 120)));
		await shot(s, 'diamonds-ghost');
		await p.evaluate(() => window.__restoreList && window.__restoreList());
	}
	console.log('\nconsole errors:', s.errs.filter(e => !/favicon|404|502/.test(e)).slice(0, 5));
	await s.close();
}

if (skipped.length) console.log('\nnot covered here:\n  ' + skipped.join('\n  '));
console.log(`\n${ok.length} passed, ${bad.length} failed, ${skipped.length} not covered`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
