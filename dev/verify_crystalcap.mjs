// verify_crystalcap.mjs — a crystal is a summary and its page is a page, and
// each has a ceiling that says so.
//
// The crystal carries the reduced state of a Diamond; the scope attached to it
// carries the weight. Nothing enforced that, so a daimon that started recording
// rather than reducing simply kept going — and the bill arrived somewhere else,
// because every fold copies the whole crystal into `versions/` and all of it
// rides in the sync parcel.
//
// WHAT CHANGED ON 2026-08-09, and why this file was wrong until now: the crystal
// became TWO files. `crystal.json` is the memory and `crystal.html` is the page
// that renders it, and they have SEPARATE ceilings — `CRYSTAL_CAP_DEFAULT` and
// `CRYSTAL_PAGE_CAP_DEFAULT` in `src/tools.rs`, read from there at the top of this
// file rather than restated — because a page is bigger than a summary and NEITHER
// IS EXEMPT. This file pinned one ceiling on one file, so a page could be any size
// at all and nothing here would have noticed: the page rides in every `versions/` snapshot where it changed and
// shares SYNC_DIAMONDS_MAX (4 MB) with the memory, so exempting presentation
// voids the cap's stated purpose. Worse, the page is written by a MODEL, which
// is the one author in this app with no sense of how big a file is.
//
// The rule is one function per file — `tools::crystal_write_refused` and
// `tools::crystal_page_write_refused` — and each is checked at all THREE doors,
// which is the only reason either holds:
//
//   * `Tool::FileWrite`, which is how a DAIMON rewrites the file. The store
//     sees that write only afterwards, when `record_steer` snapshots what is on
//     disk, so a check there would be refusing a write that already happened.
//   * `Tool::FileEdit`, which is how a daimon edits it IN PLACE. This door was
//     missing until 2026-08-09, and the file said "BOTH doors" while a daimon
//     that edited rather than rewrote walked past the ceiling entirely. The
//     store's door did then fire, but too late to help: it reads the old length
//     from disk, and by then the edit had landed, so `old == new`, the refusal
//     arrived after the fact, `record_steer` errored, the turn failed, and an
//     OVERSIZED CRYSTAL WAS LEFT ON DISK WITH NO VERSION SNAPSHOT AND NO LOG
//     RECORD. Every assertion below used to go through the other two doors,
//     which is exactly why nothing went red.
//   * `diamond::snapshot`, reached by `write_crystal_data` / `write_crystal_page`,
//     which is how a HAND EDIT and a FOLD write. They never touch the file tool,
//     so the first two doors do not see them.
//
// And three things the ceilings must NOT do, each of which would be worse than
// having no ceiling at all:
//
//   * refuse a write that makes an oversized file SMALLER, which would leave
//     every Diamond that predates the rule unable to be edited down to it;
//   * apply to anything but the two live files — a `versions/NNNN.json` or
//     `versions/NNNN.html` snapshot of an oversized crystal has to keep being
//     written, or the Diamond at the ceiling cannot be recorded at all;
//   * be ONE ceiling wearing two names. They are different numbers for different
//     jobs, and a file sized between them is over one and under the other.
//
// How each family goes red (this lane could not run a browser, so the lead's
// batched pass is the first time they are exercised):
//
//   * make `is_crystal_page_path` return false → every page check goes red and
//     every data check stays green, which is the shape the old file could not see;
//   * point `crystal_page_cap()` at `crystal_cap()` → the three DEFAULTS checks
//     and the two independence checks go red;
//   * drop the `is_crystal_*_path` guard from `Tool::FileEdit` → the two
//     "refused bytes never reached the file" checks go red and nothing else does;
//   * drop the `&& new_len >= old_len` half of either rule → the four shrink
//     checks go red.
//
//   node dev/verify_crystalcap.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no mock LLM: nothing
// here runs a turn.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

// The two shipped ceilings, READ FROM THE ENGINE rather than restated here.
//
// They were `16 * 1024` and `64 * 1024` written out as literals in this file, and on
// 2026-08-13 the page ceiling was raised to 128 KiB — so the "80 KiB is over it" check
// went red against a build that was working exactly as intended, and the number this
// file believed in was one nothing enforced. A restated constant can only ever be
// right until somebody changes the real one. `dev/verify_lifelog.mjs` reads the same
// constant the same way.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const capOf = (name) => {
	const src = fs.readFileSync(path.join(ROOT, 'src', 'tools.rs'), 'utf8');
	const m = new RegExp(name + ':\\s*usize\\s*=\\s*(\\d+)\\s*\\*\\s*(\\d+)').exec(src);
	if (!m) throw new Error('verify_crystalcap: ' + name + ' not found in src/tools.rs');
	return Number(m[1]) * Number(m[2]);
};
const DATA_CAP = capOf('CRYSTAL_CAP_DEFAULT');
const PAGE_CAP = capOf('CRYSTAL_PAGE_CAP_DEFAULT');

// The whole point of the defaults block below is that these are two DIFFERENT numbers
// with room between them. If they ever meet, there is no size that is over one and under
// the other, and the block would pass by having nothing left to ask.
if (!(DATA_CAP < PAGE_CAP)) {
	console.error('verify_crystalcap: the page ceiling (' + PAGE_CAP + ') is not above the '
		+ 'memory ceiling (' + DATA_CAP + '), so no file can be over one and under the other. '
		+ 'These are meant to be different numbers for different jobs; see src/tools.rs.');
	process.exit(2);
}
// AND THE FIGURE THE SETTINGS PANE SHOWS, read the same way and for the same reason.
//
// `DEFAULT_CRYSTAL_KB` and `DEFAULT_CRYSTAL_PAGE_KB` in `daimond.js` are a hand-kept copy of the
// two constants above, used to label the "Default" row of each pulldown. Nothing set them from the
// engine and nothing checked them, so when the page ceiling was raised to 128 KiB on 2026-08-13 the
// label went on saying 64 KB and kept saying it for a fortnight. That is worse than having no label:
// the one place in the product that names the ceiling named half of it, and the author of a capp
// that met the real ceiling had to establish it by experiment. This runs before the browser does,
// because a number that disagrees with the engine is wrong whatever the app then does with it.
const labelOf = (name) => {
	const src = fs.readFileSync(path.join(ROOT, 'www', 'js', 'daimond.js'), 'utf8');
	const m = new RegExp('var\\s+' + name + '\\s*=\\s*(\\d+)\\s*;').exec(src);
	if (!m) throw new Error('verify_crystalcap: ' + name + ' not found in www/js/daimond.js');
	return Number(m[1]) * 1024;
};
for (const [label, cap, engine] of [
	['DEFAULT_CRYSTAL_KB',      labelOf('DEFAULT_CRYSTAL_KB'),      DATA_CAP],
	['DEFAULT_CRYSTAL_PAGE_KB', labelOf('DEFAULT_CRYSTAL_PAGE_KB'), PAGE_CAP],
]) {
	if (cap !== engine) {
		console.error('verify_crystalcap: ' + label + ' in www/js/daimond.js says ' + cap
			+ ' bytes, and the engine enforces ' + engine + '. The settings pane would tell the '
			+ 'user a ceiling that is not the one refusing their writes; see src/tools.rs.');
		process.exit(2);
	}
}

// AND THE FIGURE THE GUIDE SHOWS, which is the copy a non-technical reader meets.
//
// `www/guide/capps.html` gives the page ceiling a card of its own, headed with the number, and
// `dev/guide-i18n/_source.json` carries that heading as a translatable run. The block above was
// written after the settings label had spent a fortnight naming half the real ceiling; the guide
// was a THIRD copy of the same number, it was left at 128 KB when the engine went to 512 KiB, and
// nothing here read it. A reader who trusts the guide over the refusal has no way to find out.
// Both are checked, because a corrected page with a stale bank entry ships the old figure to
// seven other languages.
const guideCap = (label, file, rel, text) => {
	const m = /(\d+)\s*(K|M)i?B/i.exec(text);
	if (!m) {
		console.error('verify_crystalcap: ' + label + ' names no size in ' + rel + '. The guide\'s '
			+ 'page-ceiling card is how a reader learns the number; see www/guide/capps.html.');
		process.exit(2);
	}
	return Number(m[1]) * (m[2].toUpperCase() === 'M' ? 1024 * 1024 : 1024);
};
{
	// The card is found by the control it names rather than by its heading id, so renumbering the
	// page's anchors does not silently take the check with it.
	const rel  = path.join('www', 'guide', 'capps.html');
	const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
	const card = /<div class="card">\s*<h3[^>]*>([^<]*)<\/h3>\s*<p>(?:(?!<\/div>)[\s\S])*?Page size limit[\s\S]*?<\/div>/i.exec(html);
	if (!card) {
		console.error('verify_crystalcap: no card in ' + rel + ' names "Page size limit", so the '
			+ 'guide either stopped naming the page ceiling or renamed the setting it points at.');
		process.exit(2);
	}
	const heading = card[1];
	const shown   = guideCap('the guide\'s page-ceiling card', rel, rel, heading);
	if (shown !== PAGE_CAP) {
		console.error('verify_crystalcap: ' + rel + ' heads its page-ceiling card "' + heading.trim()
			+ '" (' + shown + ' bytes), and the engine enforces ' + PAGE_CAP + '. This is the one '
			+ 'place a non-technical reader is told the ceiling; see src/tools.rs.');
		process.exit(2);
	}
	// And the translatable run behind it, which is what the seven locale pages are built from.
	const bankRel = path.join('dev', 'guide-i18n', '_source.json');
	const bank    = JSON.parse(fs.readFileSync(path.join(ROOT, bankRel), 'utf8'));
	const runs    = (bank['capps.html'] || []).filter((s) => /^\s*\d+\s*(K|M)i?B\s*$/i.test(s));
	if (runs.length !== 1 || guideCap('the bank\'s copy', bankRel, bankRel, runs[0]) !== PAGE_CAP) {
		console.error('verify_crystalcap: ' + bankRel + ' holds ' + JSON.stringify(runs) + ' where '
			+ 'the guide\'s page-ceiling heading should be, and the engine enforces ' + PAGE_CAP
			+ '. Run `node dev/guide_i18n.mjs extract` after editing the English page, or the '
			+ 'translations keep shipping the old figure.');
		process.exit(2);
	}
}

const KIB     = (n) => (n / 1024) + ' KiB';
const MID_LEN = DATA_CAP + Math.floor((PAGE_CAP - DATA_CAP) / 2);	// over memory, under page
const BIG_LEN = PAGE_CAP + 16 * 1024;								// over page as well

const PROFILE = scratch('pw', 'crystalcap');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// One recorded outcome, or a stand-in that FAILS and says why it is missing.
///
/// A result the run never reached must not read as a pass, and it must not
/// throw here either: a build with no page ceiling should produce a column of
/// named reds pointing at the missing function, not one stack trace.
const R = (f, k) => (f && f[k]) || { ok: false, msg: (f && f.missing) || 'no result recorded' };

const s = await open({ name: 'crystalcap', profile: PROFILE, connect: false });
const { page } = s;

try {
	await page.waitForTimeout(1500);

	const out = await page.evaluate(async ({ MID_LEN, BIG_LEN }) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const r = { absent: [] };

		// Named up front, so a red is attributable to the engine rather than to the
		// checks below discovering the same absence twenty times over.
		for (const fn of ['set_crystal_cap', 'set_crystal_page_cap',
			'write_crystal_data', 'write_crystal_page']) {
			if (typeof app[fn] !== 'function') r.absent.push(fn);
		}

		const strip = (m) => String(m).replace(/\[[0-9;]*m/g, '');

		// `run_tool` RESOLVES with the error text rather than rejecting, so a
		// refusal and a write look identical to a `try`/`catch`. Success is the
		// "Wrote N bytes" shape and nothing else -- reading it the other way round
		// made this file report two passes it had not earned.
		const write = async (path, content) => {
			let msg;
			try { msg = String(await app.run_tool('file_write', JSON.stringify({ path, content }))); }
			catch (e) { msg = String(e && e.message ? e.message : e); }
			return { ok: /^Wrote \d+ bytes/.test(msg), msg: strip(msg) };
		};
		const edit = async (path, oldS, newS) => {
			let msg;
			try {
				msg = String(await app.run_tool('file_edit',
					JSON.stringify({ path, old_string: oldS, new_string: newS })));
			} catch (e) { msg = String(e && e.message ? e.message : e); }
			return { ok: /^Edited /.test(msg), msg: strip(msg) };
		};
		// The bytes as they are on disk, through the store's own reader.
		//
		// NOT `run_tool('file_read')`: that is a MODEL-FACING rendering which
		// numbers every line and wraps an untrusted path in an envelope, and two
		// verifiers in this tree have already compared it to plain bytes and been
		// red for weeks over nothing. `store_read` pins the OPFS root, which is
		// where a Diamond lives whatever folder the user has open.
		const onDisk = async (path) => {
			try { return await mod.store_read(path); } catch (e) { return 'ERR ' + e; }
		};

		// ── The two ceilings are different numbers ───────────────────
		// Measured BEFORE any setter runs, so what is under test is the shipped
		// defaults. `MID_LEN` sits between the two, so it is over the memory's
		// ceiling and under the page's: a single ceiling serving both files fails
		// here whichever of the two numbers it happens to hold. `BIG_LEN` is over
		// the page's as well, which is what says the page has a ceiling at all.
		// Both are derived from the engine's own constants, so raising either
		// ceiling moves the fixture with it instead of turning this red.
		{
			const id  = await app.create_diamond('Ceilings');
			const dir = 'diamonds/' + id;
			// Legal JSON and legal HTML at exactly the sizes named, so a refusal
			// can only ever be the weight and never the shape.
			const dataMid = '{"t":"' + 'm'.repeat(MID_LEN - 8) + '"}';
			const pageMid = '<!--'  + 'm'.repeat(MID_LEN - 7) + '-->';
			const pageBig = '<!--'  + 'p'.repeat(BIG_LEN - 7) + '-->';
			r.defDataMid = await write(dir + '/crystal.json', dataMid);
			r.defPageMid = await write(dir + '/crystal.html', pageMid);
			r.defPageBig = await write(dir + '/crystal.html', pageBig);
		}

		// ── Each file, at each of its three doors ────────────────────
		const CAP = 1000;	// small, so the test is about the rule and not about writing 16 KB.
		const specs = [
			{
				key:   'data',
				file:  'crystal.json',
				snap:  'versions/0007.json',
				other: 'notes.json',
				// Legal JSON at every size, so a refusal can only be the ceiling.
				// A store door that parses what it is handed would otherwise refuse
				// a wall of `x` for a reason that has nothing to do with weight, and
				// the check would pass having proved nothing.
				body:  (s) => '{"t":"' + s + '"}',
				capFn: 'set_crystal_cap',
				hand:  (id, text) => app.write_crystal_data(id, text),
			},
			{
				key:   'page',
				file:  'crystal.html',
				snap:  'versions/0007.html',
				other: 'notes.html',
				body:  (s) => '<!--' + s + '-->',
				capFn: 'set_crystal_page_cap',
				hand:  (id, text) => app.write_crystal_page(id, text),
			},
		];

		for (const spec of specs) {
			const f = {};
			r[spec.key] = f;
			if (typeof app[spec.capFn] !== 'function') {
				f.missing = 'this build of the engine has no ' + spec.capFn;
				continue;
			}
			const setCap = (n) => app[spec.capFn](n);
			const over   = spec.body('').length;			// what the wrapper itself costs
			const fill   = (n, ch) => spec.body((ch || 'x').repeat(Math.max(0, n - over)));

			setCap(CAP);
			const id    = await app.create_diamond('Capped ' + spec.key);
			const dir   = 'diamonds/' + id;
			const path  = dir + '/' + spec.file;
			const big   = fill(CAP + 500, 'x');
			const small = fill(200, 'y');

			// ── The daimon's door ────────────────────────────────
			f.underCap = await write(path, small);
			f.overCap  = await write(path, big);
			// And the file must still hold the small one: a refusal that wrote anyway
			// is not a refusal.
			f.afterRefusal = { ok: (await onDisk(path)) === small, msg: 'on disk after the refusal' };

			// ── Not one of the two live files, not capped ────────
			f.versionBig  = await write(dir + '/' + spec.snap, big);
			f.ordinaryBig = await write(dir + '/' + spec.other, big);
			// Exactly three path segments is what keeps `is_crystal_*_path` a small
			// change rather than a redesign, and a four-segment `crystal/data.json`
			// layout was declined for precisely this reason. A ceiling written as a
			// filename match would silently start capping a user's own file.
			f.nestedBig   = await write(dir + '/nested/' + spec.file, big);

			// ── The store's door ─────────────────────────────────
			// `write_crystal_*` DOES reject, so here a throw is the refusal.
			const hand = async (text) => {
				try { await spec.hand(id, text); return { ok: true, msg: 'accepted' }; }
				catch (e) { return { ok: false, msg: strip(String(e && e.message ? e.message : e)) }; }
			};
			f.storeOver  = await hand(big);
			f.storeUnder = await hand(small);

			// ── The daimon's OTHER door: file_edit ───────────────
			// `file_edit` writes the file just as `file_write` does, so it needs the
			// same ceiling. Anchored on a unique token, because the tool refuses an
			// `old_string` that appears more than once and a run of identical letters
			// matches itself many times over.
			const seed = spec.body('HEAD' + 'y'.repeat(200));
			f.editSeed  = await write(path, seed);
			f.editUnder = await edit(path, 'HEAD', 'HEADER');
			f.editOver  = await edit(path, 'HEADER', 'z'.repeat(CAP + 500));
			// The specific harm this door caused: not that the write was allowed, but
			// that the turn then died at the store's door leaving the oversized bytes
			// on disk, unsnapshotted and unlogged. So the file itself is the assertion.
			f.afterEditRefusal = {
				ok: (await onDisk(path)) === seed.replace('HEAD', 'HEADER'),
				msg: 'on disk after the refused edit',
			};

			// ── An already-oversized file can still be edited DOWN ─
			// Seeded past the ceiling with the ceiling RAISED -- not with zero, which
			// means the default rather than "no ceiling", and which quietly refused
			// the seed the first time this was written.
			setCap(256 * 1024);
			f.seeded = await write(path, fill(20 * 1024, 'z'));
			setCap(CAP);
			// The asymmetry has to hold at the edit door too, or a Diamond that
			// predates the rule could be rewritten down to size but never edited down.
			// A hair over half the run, so it matches once rather than twice.
			f.editShrink   = await edit(path, 'z'.repeat(10 * 1024 + 1), '');
			// 20 KB less 10241 leaves 10239 -- still over, so the writes below are
			// still shrinking and the chain that follows is unchanged.
			f.shrinkToward = await write(path, fill(5 * 1024, 'z'));	// still over, but smaller
			f.shrinkUnder  = await write(path, small);					// and all the way down
			f.growAgain    = await write(path, fill(6 * 1024, 'z'));	// over again: refused
		}

		// ── Two ceilings, two settings, no shared static ─────────────
		// The likeliest way to build this wrong is a copy-pasted setter that moves
		// the other file's number. Nothing in the run above would show it: each
		// half only ever writes its own file.
		if (r.absent.length === 0) {
			const id  = await app.create_diamond('Two settings');
			const dir = 'diamonds/' + id;
			const five = 5 * 1024;
			app.set_crystal_cap(64 * 1024);
			app.set_crystal_page_cap(1000);
			r.pageSetterLeftData = await write(dir + '/crystal.json',
				'{"t":"' + 'd'.repeat(five) + '"}');
			app.set_crystal_cap(1000);
			app.set_crystal_page_cap(64 * 1024);
			r.dataSetterLeftPage = await write(dir + '/crystal.html',
				'<!--' + 'h'.repeat(five) + '-->');
		}

		return r;
	}, { MID_LEN, BIG_LEN });

	if (out.absent.length) {
		check(false, 'the engine offers both ceilings and both store doors',
			'missing: ' + out.absent.join(', '));
	} else {
		check(true, 'the engine offers both ceilings and both store doors');
	}

	// ── The shipped defaults are two different numbers ───────────
	check(!out.defDataMid.ok,
		KIB(MID_LEN) + ' of MEMORY is over the default ceiling (' + KIB(DATA_CAP) + ') and is refused',
		out.defDataMid.msg);
	check(out.defPageMid.ok,
		'the same ' + KIB(MID_LEN) + ' as a PAGE is under its own, larger ceiling ('
			+ KIB(PAGE_CAP) + ') and is written',
		out.defPageMid.msg);
	check(!out.defPageBig.ok,
		'but ' + KIB(BIG_LEN) + ' of page is over that one and is refused too',
		out.defPageBig.msg);

	// The wording of a refusal, per file. The user has TWO pulldowns in settings,
	// so a message that does not say which file it is about leaves them guessing
	// which one to move -- and telling somebody to put their HTML "in the
	// Diamond's scope" is advice for the memory, aimed at the wrong file.
	const says = {
		data: (m) => /scope/i.test(m || ''),
		page: (m) => /page/i.test(m || ''),
	};
	const said = { data: 'names the scope as the place for the detail', page: 'names the page' };

	for (const key of ['data', 'page']) {
		const f = out[key];
		const w = key === 'data' ? 'the memory' : 'the page';
		check(R(f, 'underCap').ok, w + ' under its ceiling is written', R(f, 'underCap').msg);
		check(!R(f, 'overCap').ok, w + ' over it is refused at the daimon\'s door',
			R(f, 'overCap').msg);
		check(says[key](R(f, 'overCap').msg), 'and the refusal ' + said[key],
			R(f, 'overCap').msg);
		check(R(f, 'afterRefusal').ok, 'and the refused bytes did not reach the file');

		check(R(f, 'versionBig').ok, 'a version snapshot of ' + w + ' is not measured against it',
			R(f, 'versionBig').msg);
		check(R(f, 'ordinaryBig').ok, 'nor is an ordinary file of the same kind beside it',
			R(f, 'ordinaryBig').msg);
		check(R(f, 'nestedBig').ok, 'nor is one a folder deeper, which is not the crystal at all',
			R(f, 'nestedBig').msg);

		check(!R(f, 'storeOver').ok, 'a hand edit of ' + w + ' over the ceiling is refused at the store\'s door',
			R(f, 'storeOver').msg);
		check(says[key](R(f, 'storeOver').msg), 'and that refusal ' + said[key],
			R(f, 'storeOver').msg);
		check(R(f, 'storeUnder').ok, 'a hand edit under it is written', R(f, 'storeUnder').msg);

		check(R(f, 'editSeed').ok, w + ' small enough to edit is in place', R(f, 'editSeed').msg);
		check(R(f, 'editUnder').ok, 'an edit that keeps it under the ceiling is written',
			R(f, 'editUnder').msg);
		check(!R(f, 'editOver').ok, 'an edit that would push it over is refused at the edit door',
			R(f, 'editOver').msg);
		check(says[key](R(f, 'editOver').msg), 'and that refusal ' + said[key],
			R(f, 'editOver').msg);
		// The one that matters most: the old failure was not a permitted write, it was
		// a write that landed and then killed the turn, leaving bytes nothing recorded.
		check(R(f, 'afterEditRefusal').ok,
			'and the refused bytes never reached the file, so nothing oversized is left unsnapshotted');
		check(R(f, 'editShrink').ok, 'an edit may still make an oversized ' + w + ' SMALLER',
			R(f, 'editShrink').msg);

		check(R(f, 'seeded').ok, w + ' can be seeded past the ceiling with the ceiling lifted',
			R(f, 'seeded').msg);
		check(R(f, 'shrinkToward').ok, 'and edited SMALLER while still over', R(f, 'shrinkToward').msg);
		check(R(f, 'shrinkUnder').ok, 'and all the way under', R(f, 'shrinkUnder').msg);
		check(!R(f, 'growAgain').ok, 'but not grown again once it is under', R(f, 'growAgain').msg);
	}

	// ── The two settings are two settings ────────────────────────
	check(R(out, 'pageSetterLeftData').ok,
		'lowering the PAGE ceiling leaves the memory\'s where it was',
		R(out, 'pageSetterLeftData').msg);
	check(R(out, 'dataSetterLeftPage').ok,
		'and lowering the memory\'s leaves the PAGE\'s where it was',
		R(out, 'dataSetterLeftPage').msg);

} finally {
	await s.close();
}

console.log(bad === 0 ? '\nall checks passed' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
