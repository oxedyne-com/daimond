// verify_crystalmigrate.mjs — `crystal.md` becomes `crystal.json`, and NOTHING
// IS LOST DOING IT.
//
// A Diamond's crystal stops being markdown and becomes data. Every Diamond that
// exists today has the old shape, so the change reaches all of them at once,
// through one migration, on one boot — and the crystal is the only place a
// Diamond's reduced state lives. A migration that drops the last two sections of
// a file is not a bug the user reports; it is a bug they discover months later
// when they go looking for something that used to be there.
//
// So the property asserted here is NOT the steps of the conversion. Steps can be
// read off the code and re-asserted in a test that agrees with the code and with
// nothing else. The property is a ROUND TRIP: rendering the produced data back to
// markdown reproduces the original file byte for byte. That holds or it does not,
// whatever the conversion does in the middle, and it is the only statement that
// covers a shape nobody thought of. Where a shape cannot survive being reshaped,
// the contract's answer is to carry it verbatim in one section — which the round
// trip accepts and a step-by-step test would reject.
//
// The awkward inputs are chosen because each breaks a different plausible
// implementation:
//
//   * a `##` inside a fenced code block breaks a splitter that scans for `^## `,
//     and that is the whole of the naive implementation. A crystal that documents
//     markdown, or holds a snippet of a config file, has one.
//   * a `#` inside a fence BEFORE any real heading gives that splitter the wrong
//     title, and the title is what the rail shows and what `name_from_crystal`
//     reads back when a Diamond loses its metadata.
//   * text before the first heading has nowhere to go in the schema, so it is the
//     first thing a conversion silently drops.
//   * an empty file, a whitespace-only file and a file with no headings at all
//     are what a young Diamond actually holds — `create_diamond` writes an empty
//     crystal, so EVERY Diamond starts as case 9.
//   * CRLF, trailing spaces after a heading, and a missing final newline are the
//     three ways a file that looks identical on screen is not identical in bytes.
//
// Then the two properties this migration inherits from the `brief.md` → `crystal.md`
// rename that came before it, because it runs in the same place on the same
// trigger: it is IDEMPOTENT, and IT NEVER CLOBBERS. A Diamond holding both files
// is left alone rather than merged; whichever way a merge went it would be
// guessing, and the losing side is somebody's work.
//
// And the redundancy path, which is the most destructive thing in this whole
// change to get wrong: a Diamond whose `crystal.json` is missing reads its newest
// `versions/NNNN.json`. A Diamond whose crystal is not found reads as an EMPTY
// one, and an agent handed an empty crystal will write a new one over work it
// never saw.
//
// How these go red (this lane could not run a browser, so the lead's batched pass
// is the first time they are exercised):
//
//   * split on `^## ` without tracking fences → the four fence cases go red and
//     the ordinary one stays green, which is the shape a fence-blind splitter has;
//   * drop the text before the first heading → case 4 goes red;
//   * `toMarkdown` always ending its output with a newline → cases 9 and 11 go red;
//   * let the migration run over a Diamond that already has both files → the
//     clobber check goes red;
//   * revert `read_crystal_data` to a bare read → the two redundancy checks go red.
//
//   node dev/verify_crystalmigrate.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no mock LLM: nothing
// here runs a turn.
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'crystalmigrate');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Every awkward shape a crystal can arrive in, and what makes each awkward.
///
/// Written with explicit `\n` rather than as template literals: a fence inside a
/// template literal has to be escaped, and an escaped fence in a test about
/// fences is one transcription error away from testing nothing.
const ROUNDTRIP = [
	{ name: 'an ordinary crystal',
		md: '# Title\n\nWhat this Diamond is for.\n\n## One\n\nThe first thing.\n\n## Two\n\nThe second.\n' },
	{ name: 'no headings at all',
		md: 'Just a paragraph, and then another.\n\nNothing in it is a heading.\n' },
	{ name: 'a heading with nothing under it',
		md: '# Only a title\n' },
	{ name: 'text before the first heading',
		md: 'A line that arrived before anything named it.\n\n# Title\n\n## One\n\nBody.\n' },
	{ name: 'a ## line inside a fenced code block',
		md: '# Title\n\nSummary.\n\n## Real section\n\n```\n## not a heading\n```\n\nAfter the fence.\n' },
	{ name: 'a ## line inside a ~~~ fence',
		md: '# Title\n\n~~~\n## not a heading either\n~~~\n' },
	{ name: 'a # line inside a fence, before any real heading',
		md: '```\n# not the title\n```\n\n# The actual title\n\nBody.\n' },
	{ name: 'a ## line indented into a code block',
		md: '# Title\n\n    ## four spaces in, so it is code\n\nAfter it.\n' },
	{ name: 'an empty file',
		md: '' },
	{ name: 'a file that is only whitespace',
		md: '\n \n\t\n\n' },
	{ name: 'a file that does not end in a newline',
		md: '# Title\n\n## One\n\nIt stops here.' },
	{ name: 'a ### under a ##, which is body and not a section of its own',
		md: '# Title\n\n## One\n\n### Deeper\n\nUnder the deeper one.\n' },
	{ name: '#Nospace, which is not a heading at all',
		md: '#Nospace\n\n##Nor is this one.\n' },
	{ name: 'a second # heading later in the file',
		md: '# First\n\nA.\n\n# Second\n\nB.\n' },
	{ name: 'a heading with trailing spaces after it',
		md: '# Title  \n\n## One   \n\nBody.\n' },
	{ name: 'CRLF line endings',
		md: '# Title\r\n\r\nSummary.\r\n\r\n## One\r\n\r\nBody.\r\n' },
	{ name: 'blank lines before anything else',
		md: '\n\n# Title\n\nBody.\n' },
	{ name: 'a fence nobody closed',
		md: '# Title\n\n```\n## inside a fence with no end\n' },
];

const s = await open({ name: 'crystalmigrate', profile: PROFILE, connect: false });
const { page } = s;

try {
	await page.waitForTimeout(1500);

	// ── The instrument, installed once ───────────────────────────
	await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		window.__d = {
			mod,
			app:  new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true),
			root: await navigator.storage.getDirectory(),
		};
		// Seeded through the directory handle, not through the store: the state
		// under test is a PRE-MIGRATION Diamond, which the store's own writers can
		// no longer produce.
		window.__put = async (path, body) => {
			let cur = __d.root;
			const parts = path.split('/');
			for (let i = 0; i < parts.length - 1; i++) {
				cur = await cur.getDirectoryHandle(parts[i], { create: true });
			}
			const fh = await cur.getFileHandle(parts[parts.length - 1], { create: true });
			const w = await fh.createWritable();
			await w.write(body);
			await w.close();
		};
		window.__meta = (name) => JSON.stringify(
			{ name: name, crystal_version: 0, updated: 1, touched: 1 });
		// The bytes on disk, or null. `store_read` pins the OPFS root, where a
		// Diamond lives whatever folder the user has open; `file_read` is a
		// model-facing rendering and would number every line.
		window.__bytes = async (path) => {
			try { return await __d.mod.store_read(path); } catch (e) { return null; }
		};
		// Key order is not meaning. Two migrations that agree on the data can
		// disagree on the order they emit it in, and a raw string comparison would
		// call that a difference.
		window.__canon = (v) => {
			if (Array.isArray(v)) return '[' + v.map(__canon).join(',') + ']';
			if (v && typeof v === 'object') {
				return '{' + Object.keys(v).sort().map((k) =>
					JSON.stringify(k) + ':' + __canon(v[k])).join(',') + '}';
			}
			return JSON.stringify(v === undefined ? null : v);
		};
		// Where two strings first part company, in a form that survives the console.
		window.__where = (a, b) => {
			if (a === b) return '';
			const n = Math.min(a.length, b.length);
			let i = 0;
			while (i < n && a[i] === b[i]) i++;
			const win = (x) => JSON.stringify(x.slice(Math.max(0, i - 12), i + 24));
			return 'at ' + i + ' of ' + a.length + '/' + b.length
				+ ' want ' + win(a) + ' got ' + win(b);
		};
	});

	const hasModule = await page.evaluate(() => !!(window.DaimondCrystal
		&& typeof DaimondCrystal.fromMarkdown === 'function'
		&& typeof DaimondCrystal.toMarkdown === 'function'
		&& typeof DaimondCrystal.parse === 'function'));
	check(hasModule, 'the crystal module is loaded, with the migration and its inverse',
		hasModule ? '' : 'window.DaimondCrystal is not there, or is missing a half');

	// ── The round trip, over shapes that break different splitters ──
	const trips = await page.evaluate((cases) => cases.map((c) => {
		let data, out, err = '';
		try { data = DaimondCrystal.fromMarkdown(c.md); }
		catch (e) { err = 'fromMarkdown threw: ' + (e && e.message || e); }
		if (!err) {
			try { out = DaimondCrystal.toMarkdown(data); }
			catch (e) { err = 'toMarkdown threw: ' + (e && e.message || e); }
		}
		return {
			name: c.name,
			ok:   !err && out === c.md,
			why:  err || __where(c.md, String(out)),
		};
	}), ROUNDTRIP);

	for (const t of trips) {
		check(t.ok, 'it round-trips ' + t.name, t.why);
	}

	// ── ...and the conversion is a conversion ────────────────────
	//
	// The round trip alone is satisfied by a migration that does nothing: put the
	// whole file in one nameless section and hand it back, and all eighteen cases
	// above pass while no Diamond has ever gained a title, a summary or a section.
	// That is the vacuous pass this file would otherwise ship with, so the ordinary
	// case is also asked what it FOUND. Read by meaning rather than by position:
	// the set of headings, not `sections[1].heading`.
	const shape = await page.evaluate((md) => {
		const d = DaimondCrystal.fromMarkdown(md) || {};
		return {
			title:    d.title || '',
			summary:  String(d.summary || ''),
			headings: (d.sections || []).map((x) => String(x && x.heading || '')),
			bodies:   (d.sections || []).map((x) => String(x && x.body || '')),
		};
	}, ROUNDTRIP[0].md);
	check(shape.title === 'Title', 'the first # heading becomes the title', JSON.stringify(shape.title));
	check(/What this Diamond is for\./.test(shape.summary),
		'the text under it becomes the summary', JSON.stringify(shape.summary));
	check(shape.headings.includes('One') && shape.headings.includes('Two'),
		'and every ## becomes a section of its own', JSON.stringify(shape.headings));
	check(shape.bodies.some((b) => /The second\./.test(b)),
		'carrying the text that was under it', JSON.stringify(shape.bodies));

	// A file with no headings becomes one section with an empty heading, which is
	// what the contract says and what keeps `sections` the place everything ends up
	// when nothing else fits.
	const bare = await page.evaluate((md) => {
		const d = DaimondCrystal.fromMarkdown(md) || {};
		return {
			headings: (d.sections || []).map((x) => String(x && x.heading || '')),
			kept:     JSON.stringify(d).indexOf('Nothing in it is a heading') >= 0,
		};
	}, ROUNDTRIP[1].md);
	check(bare.kept, 'a file with no headings keeps its text somewhere', JSON.stringify(bare));
	check(bare.headings.length > 0 && bare.headings.every((h) => h === ''),
		'under a section with no heading, rather than under an invented one',
		JSON.stringify(bare.headings));

	// `parse` is the door every one of these arrives through, and it must never
	// throw: the ✎ editor and the fallback view both call it on text a person or a
	// model just typed.
	const parsed = await page.evaluate(() => {
		const bad1 = DaimondCrystal.parse('{"title": "unterminated');
		const good = DaimondCrystal.parse('{"title":"fine"}');
		return {
			badOk:  !!(bad1 && bad1.ok === false && bad1.error),
			goodOk: !!(good && good.ok === true && good.data && good.data.title === 'fine'),
		};
	});
	check(parsed.badOk, 'unparseable text is refused by parse() with a reason, not by a throw');
	check(parsed.goodOk, 'and text that parses comes back as data', JSON.stringify(parsed));

	// ── The real migration, through the store ────────────────────
	//
	// Everything above is the JS half. This is the one that runs on every Diamond
	// the user owns, in Rust, on the trigger `migrate_crystal_file` already uses.
	const LEG = 'a11decade001';
	const LEGMD = '# Kept from before\n\nWhy this Diamond exists.\n\n## Notes\n\n```\n## not a heading\n```\n\n## Next\n\nWhat is left to do.\n';
	const migrated = await page.evaluate(async (arg) => {
		const dir = 'diamonds/' + arg.id;
		await __put(dir + '/.daimond/meta.json', __meta('Kept from before'));
		await __put(dir + '/crystal.md', arg.md);
		// The trigger, exactly where it runs today.
		await __d.app.list_diamonds();

		const json  = await __bytes(dir + '/crystal.json');
		const stale = await __bytes(dir + '/crystal.md');
		let back = null, viaApp = null, err = '';
		try { viaApp = await __d.app.read_crystal_data(arg.id); }
		catch (e) { err = String(e && e.message || e); }
		const p = DaimondCrystal.parse(json || viaApp || '');
		if (p && p.ok) { try { back = DaimondCrystal.toMarkdown(p.data); } catch (e) { err = String(e); } }
		return {
			wrote:   json !== null,
			stale:   stale !== null,
			viaApp:  viaApp,
			same:    json !== null && viaApp !== null && json === viaApp,
			back:    back,
			trip:    back === arg.md,
			why:     err || __where(arg.md, String(back)),
			agree:   (p && p.ok)
				? __canon(p.data) === __canon(DaimondCrystal.fromMarkdown(arg.md))
				: false,
			rust:    (p && p.ok) ? __canon(p.data) : 'unparseable: ' + (p && p.error),
			js:      __canon(DaimondCrystal.fromMarkdown(arg.md)),
		};
	}, { id: LEG, md: LEGMD });

	check(migrated.wrote, 'a legacy Diamond gains a crystal.json where it had a crystal.md');
	check(migrated.trip, 'and rendering it back reproduces the original file byte for byte',
		migrated.why);
	check(migrated.same, 'the app reads back the same bytes that are on disk, so the '
		+ 'migration WROTE rather than converting afresh on every read');
	// Two migrations, one in Rust and one in JS, and the JS one is what every test
	// above measures. If they disagree, those eighteen cases prove nothing about
	// the code that will actually touch the user's Diamonds.
	check(migrated.agree, 'the migration in Rust and the migration in JS produce the same data',
		'rust ' + String(migrated.rust).slice(0, 120) + ' | js ' + String(migrated.js).slice(0, 120));
	// NOT a rename, unlike the brief.md migration, and the reason is worth keeping.
	// The self-check proves the BYTES round-trip and structurally cannot prove the
	// STRUCTURE is right: a `##` inside a fence rejoins to identical bytes whether or
	// not the fence was honoured. So the one failure the check cannot see is exactly
	// the one that would justify still having the markdown. And `import_diamond`
	// deletes a Diamond's directory before rewriting it, so a bad conversion
	// propagates back over a good copy on the next sync -- the shape this project
	// has already lost data to once.
	//
	// The cost is a few kilobytes riding in the parcel. The user's real backup was
	// thirteen Diamonds and 15,786 bytes of workspace in total, so it is a few
	// kilobytes of a very small number, and a later release can drop the file once
	// the conversion has run against real workspaces without complaint.
	check(migrated.stale, 'the legacy markdown is KEPT, because a lossless conversion '
		+ 'is not the same as a provably correct one');

	// ── Idempotent ───────────────────────────────────────────────
	const twice = await page.evaluate(async (id) => {
		const path = 'diamonds/' + id + '/crystal.json';
		const before = await __bytes(path);
		await __d.app.list_diamonds();
		await __d.app.list_diamonds();
		const after = await __bytes(path);
		return { ok: before !== null && before === after, why: __where(String(before), String(after)) };
	}, LEG);
	check(twice.ok, 'running the migration again changes nothing', twice.why);

	// ── It never clobbers ────────────────────────────────────────
	//
	// A Diamond holding both files has already been migrated on another device and
	// synced back, or was migrated here and then had a legacy file restored from a
	// backup. Either way a merge would be guessing, and the losing side is work.
	const BOTH = 'b0thf11e5001';
	const KEPT = '{"title":"The data that was already here","summary":"Written after the migration."}';
	const both = await page.evaluate(async (arg) => {
		const dir = 'diamonds/' + arg.id;
		await __put(dir + '/.daimond/meta.json', __meta('Holds both'));
		await __put(dir + '/crystal.md', '# An older markdown crystal\n\nWhich must not win.\n');
		await __put(dir + '/crystal.json', arg.kept);
		await __d.app.list_diamonds();
		const json = await __bytes(dir + '/crystal.json');
		let viaApp = null;
		try { viaApp = await __d.app.read_crystal_data(arg.id); } catch (e) { viaApp = 'ERR ' + e; }
		return { json, viaApp };
	}, { id: BOTH, kept: KEPT });

	check(both.json === KEPT, 'a Diamond holding both files keeps the data it already had',
		String(both.json).slice(0, 120));
	check(!/older markdown crystal/.test(String(both.json) + String(both.viaApp)),
		'and nothing from the markdown is merged into it, whichever way a merge would have gone');

	// ── The redundancy path ──────────────────────────────────────
	//
	// The most destructive failure in this change: a Diamond whose crystal is not
	// found reads as an empty one, and an agent handed an empty crystal will write
	// a new one over work it never saw. The versions are the store's own backup and
	// nothing but this ever reads them.
	const VER = 'c0deca11ab1e';
	const ver = await page.evaluate(async (id) => {
		const dir = 'diamonds/' + id;
		await __put(dir + '/.daimond/meta.json', __meta('Crystal lost, versions kept'));
		await __put(dir + '/versions/0001.json', '{"title":"the first crystal"}');
		await __put(dir + '/versions/0009.json', '{"title":"as it was last left"}');
		await __put(dir + '/versions/0002.json', '{"title":"a middle one"}');
		let text = null, err = '';
		try { text = await __d.app.read_crystal_data(id); }
		catch (e) { err = String(e && e.message || e); }
		const p = DaimondCrystal.parse(text || '');
		return { err, title: (p && p.ok && p.data) ? p.data.title : null, text };
	}, VER);
	check(!ver.err, 'a Diamond whose crystal.json is gone still opens', ver.err);
	check(ver.title === 'as it was last left',
		'reading its NEWEST version snapshot rather than opening empty',
		JSON.stringify(ver.title) + ' from ' + JSON.stringify(String(ver.text).slice(0, 80)));

	// A Diamond that holds only the legacy markdown must read as its own content
	// too, whether it gets there by having been migrated or by a migrated read.
	// The failure being guarded is the same one either way: opening empty.
	const OLD = 'd0c0mdon1y001';
	const old = await page.evaluate(async (id) => {
		const dir = 'diamonds/' + id;
		await __put(dir + '/.daimond/meta.json', __meta('Only markdown'));
		await __put(dir + '/crystal.md', '# Still here\n\nAnd it must not read as empty.\n');
		let text = null, err = '';
		try { text = await __d.app.read_crystal_data(id); }
		catch (e) { err = String(e && e.message || e); }
		return { err, text };
	}, OLD);
	check(!old.err, 'a Diamond holding only a legacy markdown crystal opens', old.err);
	check(/Still here/.test(String(old.text)),
		'with what it says, rather than as an empty crystal an agent would write over',
		JSON.stringify(String(old.text).slice(0, 120)));

	// And the control, without which "never opens empty" could be met by opening
	// something. A Diamond that genuinely has nothing must still open, and must not
	// acquire content from anywhere.
	const NIL = 'e3117n0th1ng1';
	const nil = await page.evaluate(async (id) => {
		await __put('diamonds/' + id + '/.daimond/meta.json', __meta('Nothing at all'));
		try { return { text: await __d.app.read_crystal_data(id) }; }
		catch (e) { return { err: String(e && e.message || e) }; }
	}, NIL);
	check(nil.err === undefined, 'a Diamond that truly holds nothing opens rather than throwing',
		nil.err);

	// A resource the browser could not load is the dev stack, not the page: no
	// gateway runs here, so its probes answer 401 or 502 and neither is a throw.
	const noise = s.errs.filter((e) =>
		!/favicon|ERR_ABORTED|net::ERR|Failed to load resource|i18n: no string/i.test(e));
	check(noise.length === 0, 'the page threw nothing along the way', noise.slice(0, 3).join(' | '));

} catch (e) {
	check(false, 'the run finished', String(e && e.message || e));
} finally {
	await s.close();
}

console.log(bad === 0 ? '\nall checks passed' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
