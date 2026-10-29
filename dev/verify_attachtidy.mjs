// gateway: none
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
//   4. The Workspace's focus section (Can change) is drawn from those same
//      fence inputs, so the fold-made file is no row there and the marked
//      folder is one row, its nested file none.
//
// Retired with Workspace round 2 P2 (fe78b65f), by design: the collapsed
// "Added by the daimon (n)" group with its Drop all (first-principles design
// row 12: FOLD into Recent, Drop all DROP -- provenance is what Recent shows
// and it ages out), and the composed "This Diamond" tree's "Gone" row, which
// left with that tree.
//
// EACH CHECK NAMED BELOW IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>`
// serves a deliberately damaged copy of a file through `page.route`, and the
// run is then expected to FAIL exactly the property that name covers.
//
//   node dev/verify_attachtidy.mjs --break producedmark  # 1 fails: produced reaches bounds
//   node dev/verify_attachtidy.mjs --break nestdup       # 2 fails: nested chip drawn twice
//   node dev/verify_attachtidy.mjs --break harvestall    # 3 fails: harvest ignores the mark
//   node dev/verify_attachtidy.mjs                       # and then, clean
//
//   eval "$(bash dev/world.sh 39 --up)"
//   eval "$(bash dev/world.sh 39 --env)"
import { readPage } from './pagesrc.mjs';
import { port } from './ports.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, shot, markHere, workMenu } from './harness.mjs';

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
	const src = readPage(path.join(WWW, spec.file), 'utf8');
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

await page.goto(process.env.DAIMOND_APP || 'http://localhost:' + port('app'), { waitUntil: 'domcontentloaded' });
await signInAs(s, 'attachtidy');
// A resolvable model, so `createDiamond`'s validation lets the dialog through --
// this is not about a turn ever running, only about the Diamond getting made.
await connectMock(s);
await page.waitForTimeout(1200);

const T  = (k, v) => page.evaluate(([k, v]) => DaimondI18n.t(k, v || undefined), [k, v || null]);

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
// break above must leave standing. Pressed through the device's own record
// (R2, `f43d15e7`), as a real press does: a raw `add_link` alone is a claim,
// never a grant, and `bounds().attached` reads only what is in force here.
await markHere(s, diamondId, 'dir:[browser]code');
// A dangling reference: attached the way a person's own ◈ would, but nothing
// is at this path — as if the daimon had since deleted the file. Pressed too,
// so the "gone" row below is a real in-force mark whose file vanished, not an
// unconfirmed one that was never in force to begin with.
await markHere(s, diamondId, 'file:[browser]misc/ghost.txt');

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
// Pressed as well, so the dedupe below is proved on two marks both in force —
// otherwise an unpressed nested.rs would never reach the fence regardless of
// the dedupe, and check 2 would prove nothing.
await markHere(s, diamondId, 'file:[browser]code/nested.rs');
await page.waitForTimeout(200);
const bounds2 = await page.evaluate((id) => DaimondDiamond.bounds(id), diamondId);
check('a path under an attached folder is not a second entry in the fence',
	!(bounds2.attached || []).includes('code/nested.rs'), JSON.stringify(bounds2.attached));
check('the folder itself is still the one entry', (bounds2.attached || []).filter(p => p === 'code' || p === 'code/nested.rs').length === 1,
	JSON.stringify(bounds2.attached));

// ── 4. Can change, drawn ─────────────────────────────────────────────────
// The focus section names the Diamond in focus and lists what its daimon can
// change: its own folder and each mark in force. The fold-made file is
// provenance (Recent), never a row here, and the marked folder covers its
// nested file. `--break producedmark` and `--break nestdup` turn these red too.
await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
await page.waitForTimeout(500);
await workMenu(page, 'head', 'refresh');
await page.waitForTimeout(900);
await shot(s, 'attachtidy-workspace-root');
const can = await page.evaluate(() => {
	const sec = document.querySelector('#panel-work .files-focus');
	if (!sec || sec.hidden) return null;
	return [...sec.querySelectorAll('.r[data-path]')]
		.filter(r => r.dataset.kind !== 'recent').map(r => r.dataset.path);
});
check('the focus section draws Can change for the Diamond', Array.isArray(can), JSON.stringify(can));
check('the user\'s `holds` folder is a row in Can change', !!can && can.includes('code'), JSON.stringify(can));
check('the fold-made file is no row in Can change', !!can && !can.includes('extra/out.rs'), JSON.stringify(can));
check('the marked folder is one row, its nested file none',
	!!can && can.filter(p => p === 'code').length === 1 && !can.includes('code/nested.rs'), JSON.stringify(can));

await shot(s, 'attachtidy-final');
await s.close();

console.log(`\n${ok} ok, ${bad} FAIL`);
if (BREAK) {
	console.log(bad ? `break '${BREAK}' correctly failed ${bad} check(s)`
		: `break '${BREAK}': NOTHING FAILED, so the checks above prove nothing`);
	process.exit(bad ? 0 : 1);
}
process.exit(bad ? 1 : 0);
