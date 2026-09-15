// verify_attachtidy.mjs — tidying the Workspace panel's attachment chips.
//
// The owner looked at a Diamond's workspace and asked "are all these chips
// necessary?" They were not. `dev/ATTACH_CONTRACT.md` §2b is the design this
// proves; it is one paragraph per property below.
//
//   1. Only `holds` and `consulted` are marks. `Files.bounds` never turns a
//      `produced` link into a write grant or a reach chip.
//   2. A path already covered by an attached ancestor directory draws no
//      chip of its own — `attachmentsOf`'s nested dedupe.
//   3. `harvestArtefacts` does not harvest a file under an attached `dir:`
//      link, or a dot-prefixed basename.
//   4. A link `by !== 'user'` sits under one collapsed "Added by the daimon"
//      header with a count, and its "Drop all" removes them and keeps `holds`.
//   5. An attachment no longer at its path draws "Gone" and no open action.
//
// EACH CHECK NAMED BELOW IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>`
// serves a deliberately damaged copy of a file through `page.route`, and the
// run is then expected to FAIL exactly the property that name covers.
//
//   node dev/verify_attachtidy.mjs --break producedmark  # 1 fails: produced reaches bounds
//   node dev/verify_attachtidy.mjs --break nestdup       # 2 fails: nested chip drawn twice
//   node dev/verify_attachtidy.mjs --break harvestall    # 3 fails: harvest ignores the mark
//   node dev/verify_attachtidy.mjs --break nogroup       # 4 fails: daimon rows draw plain
//   node dev/verify_attachtidy.mjs --break danglinglive  # 5 fails: a gone row draws live
//   node dev/verify_attachtidy.mjs                       # and then, clean
//
//   eval "$(bash dev/world.sh 39 --up)"
//   eval "$(bash dev/world.sh 39 --env)"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, shot } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The mark filter in `Files.bounds` is removed, so a `produced` link is
	// handed to the fence and the reach chip exactly as a `holds` link is.
	producedmark: {
		file: 'js/daimond.js',
		find: `				var marks = list.filter(function (a) {
					var rel = a.link && a.link.rel;
					return rel === 'holds' || rel === 'consulted';
				});`,
		with: `				var marks = list;`,
	},
	// `attachmentsOf`'s nested-ancestor dedupe is removed, so a file already
	// under an attached folder draws its own chip as well as the folder's.
	nestdup: {
		file: 'js/daimond.js',
		find: `			out = out.filter(function (a, i2) {
				for (var j = 0; j < i2; j++) if (underPath(a.path, out[j].path)) return false;
				return true;
			});`,
		with: `			/* nested paths draw their own chip too */`,
	},
	// `harvestArtefacts` no longer skips a path under an attached directory, so
	// editing three files inside a marked folder leaves three duplicate links.
	harvestall: {
		file: 'js/daimond.js',
		find: `				if (parsedRef.kind === 'file' && dirs.some(function (d) {
					return parsedRef.path === d || parsedRef.path.indexOf(d + '/') === 0;
				})) continue;`,
		with: `				/* harvest everything, marked folder or not */`,
	},
	// The daimon-made rows are never split out, so a fold's own bookkeeping
	// draws one row per file, exactly as a person's own attachment does.
	nogroup: {
		file: 'js/daimond.js',
		find: `			var daimonRows = attached.filter(function (a) { return a.by !== 'user'; });`,
		with: `			var daimonRows = [];`,
	},
	// The lazy stat never marks anything gone, so a row for a deleted file
	// draws exactly as a live one does — openable, shareable, still reaching.
	danglinglive: {
		file: 'js/daimond.js',
		find: `					a.gone = !!names && !names[base];`,
		with: `					a.gone = false;`,
	},
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

let ok = 0, bad = 0;
const check = (name, pass, detail) => {
	if (pass) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const s = await open({ name: 'attachtidy', signIn: false, connect: false });
const { page } = s;

async function installBreak() {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	const type = /\.css$/.test(spec.file) ? 'text/css' : 'application/javascript';
	await page.route('**/' + spec.file, r => r.fulfill({ status: 200, contentType: type, body }));
}
await installBreak();

await page.goto(process.env.DAIMOND_APP || 'http://localhost:8816', { waitUntil: 'domcontentloaded' });
await signInAs(s, 'attachtidy');
// A resolvable model, so `createDiamond`'s validation lets the dialog through --
// this is not about a turn ever running, only about the Diamond getting made.
await connectMock(s);
await page.waitForTimeout(1200);

const T  = (k, v) => page.evaluate(([k, v]) => DaimondI18n.t(k, v || undefined), [k, v || null]);
const Tn = (k, n) => page.evaluate(([k, n]) => DaimondI18n.tn(k, n), [k, n]);

const call = (fn, args = []) => page.evaluate(async ({ fn, args }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await app[fn](...args);
}, { fn, args });

// A workspace with a marked folder, three files a fold "harvested" under it, one
// harvested outside it, one whose basename is a dotfile, and one that no longer
// exists — the owner's literal report plus every other case in the contract.
await call('run_tool', ['file_write', JSON.stringify({ path: 'code/a.rs', content: 'fn a(){}\n' })]);
await call('run_tool', ['file_write', JSON.stringify({ path: 'code/b.rs', content: 'fn b(){}\n' })]);
await call('run_tool', ['file_write', JSON.stringify({ path: 'extra/out.rs', content: 'fn out(){}\n' })]);
await call('run_tool', ['file_write', JSON.stringify({ path: 'misc/.secret', content: 'sh\n' })]);
await page.waitForTimeout(300);

// A Diamond, focused the moment it is created — the same flow every other
// attachment verifier in this tree uses.
await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-input', { timeout: 10000 });
await page.fill('.dlg-input', 'Attach tidy');
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(900);
const diamondId = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const rows = JSON.parse(await app.list_diamonds());
	return rows.find(d => d.name === 'Attach tidy').id;
});
check('a Diamond to work in', !!diamondId, diamondId);
const self = 'diamond:' + diamondId;

// The user's own mark: `code/`, `holds`, `by: user` — the one thing every
// break above must leave standing.
await call('add_link', [diamondId, self, 'dir:[browser]code', 'holds', '', 'user']);
// A dangling reference: attached the way a person's own ◈ would, but nothing
// is at this path — as if the daimon had since deleted the file.
await call('add_link', [diamondId, self, 'file:[browser]misc/ghost.txt', 'holds', '', 'user']);

// The fold's own harvest: two files under the mark, one outside it, one a
// dotfile outside it — `harvestArtefacts` itself, not a re-implementation of it.
const harvestResult = await page.evaluate(async (id) => {
	const msgs = [
		{ role: 'tool_log', name: 'file_edit', args: JSON.stringify({ path: 'code/a.rs' }) },
		{ role: 'tool_log', name: 'file_edit', args: JSON.stringify({ path: 'code/b.rs' }) },
		{ role: 'tool_log', name: 'file_write', args: JSON.stringify({ path: 'extra/out.rs' }) },
		{ role: 'tool_log', name: 'file_write', args: JSON.stringify({ path: 'misc/.secret' }) },
	];
	await window.DaimondArtefacts.harvest(id, { sourceRun: { messages: msgs } });
	return true;
}, diamondId);
check('the fold ran', harvestResult === true);
await page.waitForTimeout(300);

const links = () => call('links_touching', [self]).then(r => JSON.parse(r || '[]'));
let all = await links();
const has = (ref) => all.some(l => l.other === ref);

// ── 3. Harvest less ──────────────────────────────────────────────────
check('code/a.rs, under the mark, was not harvested', !has('file:code/a.rs'), BREAK === 'harvestall' ? 'expected under --break' : '');
check('code/b.rs, under the mark, was not harvested', !has('file:code/b.rs'), BREAK === 'harvestall' ? 'expected under --break' : '');
check('extra/out.rs, outside the mark, WAS harvested', has('file:extra/out.rs'));
check('misc/.secret, a dotfile, was not harvested', !has('file:misc/.secret'));

// ── 1. produced is provenance, not a mark ───────────────────────────────
const bounds = await page.evaluate((id) => DaimondDiamond.bounds(id), diamondId);
check('the `holds` folder is in the fence', (bounds.attached || []).includes('code'), JSON.stringify(bounds.attached));
check('the `produced` file never reaches the fence', !(bounds.attached || []).includes('extra/out.rs'),
	JSON.stringify(bounds.attached));

// ── 2. Nested paths draw once ────────────────────────────────────────────
// A file the USER attaches by hand, directly under the already-marked folder.
await call('add_link', [diamondId, self, 'file:[browser]code/nested.rs', 'holds', '', 'user']);
await page.waitForTimeout(200);
const bounds2 = await page.evaluate((id) => DaimondDiamond.bounds(id), diamondId);
check('a path under an attached folder is not a second entry in the fence',
	!(bounds2.attached || []).includes('code/nested.rs'), JSON.stringify(bounds2.attached));
check('the folder itself is still the one entry', (bounds2.attached || []).filter(p => p === 'code' || p === 'code/nested.rs').length === 1,
	JSON.stringify(bounds2.attached));

// ── The Workspace panel, drawn ────────────────────────────────────────────
async function openWorkspace() {
	await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
	await page.waitForTimeout(500);
	// "This Diamond", not "Everything" -- the composed workspace tree is only
	// drawn in the former (`diamondScope`).
	await page.click('[data-scope="diamond"]', { force: true }).catch(() => {});
	await page.waitForTimeout(500);
	await page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
	await page.waitForTimeout(900);
}
await openWorkspace();
await shot(s, 'attachtidy-workspace-root');

const rows = await page.evaluate(() => [...document.querySelectorAll('#panel-work .files-row.attached')].map(r => ({
	path: r.dataset.path || '',
	gone: r.classList.contains('gone'),
})));
const groupHead = await page.$('#panel-work .files-group-toggle');

// ── 4. Added-by-the-daimon group ─────────────────────────────────────────
check('extra/out.rs (fold-made) does not draw as a plain row', !rows.some(r => r.path === 'extra/out.rs'),
	JSON.stringify(rows));
check('a collapsed daimon group exists', !!groupHead, BREAK === 'nogroup' ? 'expected under --break' : '');
const groupText = groupHead ? await groupHead.evaluate(e => e.textContent) : '';
const wantCount = await Tn('dws.added_by_daimon', 1);
check('its count reads one', groupText.indexOf(String(1)) >= 0 && groupText === wantCount || /\(1\)|（1）/.test(groupText),
	JSON.stringify({ groupText, wantCount }));
if (groupHead) {
	await groupHead.click();
	await page.waitForTimeout(500);
	const opened = await page.evaluate(() => [...document.querySelectorAll('#panel-work .files-row.attached')]
		.map(r => r.dataset.path || ''));
	check('opening the group reveals extra/out.rs', opened.includes('extra/out.rs'), JSON.stringify(opened));
	// The row's title carries the age and the `rel · by` hint, item 5 and the
	// hint half of item 4.
	const hintTitle = await page.evaluate(() => {
		const row = [...document.querySelectorAll('#panel-work .files-row.attached')]
			.find(r => r.dataset.path === 'extra/out.rs');
		return row ? row.title : '';
	});
	check('the row names how it got here', /produced/.test(hintTitle) && /fold/.test(hintTitle), hintTitle);
	const drop = await page.$('#panel-work .files-group-drop');
	check('a Drop all control is offered', !!drop);
	if (drop) {
		await drop.click();
		await page.waitForTimeout(500);
		all = await links();
		check('Drop all removed the fold-made link', !has('file:extra/out.rs'), JSON.stringify(all.map(l => l.other)));
		check('and left the user\'s `holds` mark standing', has('dir:[browser]code'), JSON.stringify(all.map(l => l.other)));
	}
}

// ── 5. A dangling row says so ────────────────────────────────────────────
await openWorkspace();
const goneRow = await page.evaluate(() => {
	const r = [...document.querySelectorAll('#panel-work .files-row.attached')]
		.find(r => r.dataset.path === 'misc/ghost.txt');
	return r ? { gone: r.classList.contains('gone'), badge: !!r.querySelector('.files-badge.files-gone') } : null;
});
check('the deleted-path row exists', !!goneRow, JSON.stringify(goneRow));
check('and is marked gone', !!goneRow && goneRow.gone && goneRow.badge,
	BREAK === 'danglinglive' ? 'expected under --break' : JSON.stringify(goneRow));
const liveRow = await page.evaluate(() => {
	const r = [...document.querySelectorAll('#panel-work .files-row.attached')]
		.find(r => r.dataset.path === 'code');
	return r ? r.classList.contains('gone') : null;
});
check('a real attachment is not marked gone', liveRow === false, String(liveRow));

await shot(s, 'attachtidy-final');
await s.close();

console.log(`\n${ok} ok, ${bad} FAIL`);
if (BREAK) {
	console.log(bad ? `break '${BREAK}' correctly failed ${bad} check(s)`
		: `break '${BREAK}': NOTHING FAILED, so the checks above prove nothing`);
	process.exit(bad ? 0 : 1);
}
process.exit(bad ? 1 : 0);
