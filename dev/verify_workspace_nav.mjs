// verify_workspace_nav.mjs — getting back out of a folder in the Workspace
// dock panel.
//
// The report: "When I click a folder, there is not up/return icon or button,
// I'm trapped in lower directories." The plain workspace tree already carried
// a "parent folder" icon in its header (one level per click, easy to miss
// among five others); the System section had nothing of the kind at all —
// only a "📁 .." row mixed into the file listing itself.
//
// The fix put the path line to work: `.files-path` and `.sys-path` now draw a
// clickable breadcrumb trail (Workspace/System › folder › folder …), one click
// to any ancestor rather than one click per level, and the same pattern in
// both trees rather than two different ones.
//
// Two properties, each proved against the ORIGINAL bug shape first:
//
//   1. THE SYSTEM SECTION HAS A WAY BACK OUT AT ALL. It never had a header
//      icon; the inline "…" row was removed as part of this fix on the
//      understanding that the breadcrumb replaces it. `--break crumbs` guts
//      the breadcrumb back to a plain, non-interactive string — precisely
//      what shipped before — and with it gone the System section is provably
//      unreachable from three folders down: nothing on screen can shorten the
//      path.
//
//   2. A BREADCRUMB SEGMENT JUMPS DIRECTLY, NOT ONE LEVEL AT A TIME. Three
//      folders down in the plain tree, clicking the FIRST segment must land
//      at the root in one click. `--break crumbs` removes every clickable
//      segment, so the same click hits nothing and the path does not move.
//
//   node dev/verify_workspace_nav.mjs --break crumbs
//   node dev/verify_workspace_nav.mjs
//
// Needs dev/serve.mjs (dev/world.sh N --up). No gateway needed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, shot } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// The single break: gut `renderCrumbs` to the plain string it replaced, with
// no element ever made clickable. This is not a hypothetical regression —
// it is what `.files-path` and `.sys-path` literally rendered before this fix.
const BREAKS = {
	crumbs: [{
		file: 'js/daimond.js',
		find: `\t\tfunction renderCrumbs(el, root, dir, go) {\n\t\t\tif (!el) return;\n\t\t\tel.innerHTML = '';`,
		with: `\t\tfunction renderCrumbs(el, root, dir, go) {\n\t\t\tif (!el) return;\n\t\t\tel.textContent = dir ? ('/' + dir) : root; return;\n\t\t\tel.innerHTML = '';`,
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. Nothing is served that was not verified
/// to differ from the file on disk — an anchor that no longer matches would
/// silently serve the WORKING file and the run below would prove nothing.
function damaged(spec) {
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

const PROFILE = scratch('pw', 'wsnav' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'wsnav', profile: PROFILE, signIn: false, connect: false });
const { page } = s;

if (BREAK) {
	for (const spec of BREAKS[BREAK]) {
		const body = damaged(spec);
		await page.route('**/' + spec.file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

// The stub (or lack of one) only takes effect on a load that comes after it —
// `open()`'s own navigation ran before routes existed.
await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
const { signInAs } = await import('./harness.mjs');
await signInAs(s, 'wsnav');
await page.waitForTimeout(2000);

/// Click the row named `name` in whichever tree is on screen.
async function clickRowNamed(sel, name) {
	const rows = await page.$$(sel);
	for (const r of rows) {
		const t = await r.$eval('.files-name', e => e.textContent).catch(() => '');
		if (t.includes(name)) { await r.click({ force: true }); return true; }
	}
	return false;
}

const crumbTexts = (sel) => page.$$eval(sel + ' .path-crumb', els => els.map(e => e.textContent));

try {
	// ── Seed three folders deep in the plain workspace tree ────────────
	await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: 'alpha/beta/gamma/deep.md', content: '# deep\n' }));
	});
	await page.waitForTimeout(300);

	await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
	await page.waitForTimeout(600);
	await page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
	await page.waitForTimeout(600);

	await clickRowNamed('.files-tree .files-row', 'alpha');
	await page.waitForTimeout(500);
	await clickRowNamed('.files-tree .files-row', 'beta');
	await page.waitForTimeout(500);
	await clickRowNamed('.files-tree .files-row', 'gamma');
	await page.waitForTimeout(500);

	let pathText = await page.$eval('.files-path', e => e.textContent);
	check('three levels down in the plain tree', /gamma/.test(pathText), pathText);

	// ── 2. The first breadcrumb segment jumps straight to the root ─────
	const crumbs = await crumbTexts('.files-path');
	if (BREAK === 'crumbs') {
		// The whole claim of this half of the break: with the breadcrumb gutted,
		// nothing in the path line can be clicked at all, so the "jump straight
		// to the root" property has nothing to stand on.
		check('(broken) no clickable segment exists in the plain tree’s path line',
			crumbs.length === 0, JSON.stringify(crumbs));
	} else {
		check('the path line offers at least one crumb to click', crumbs.length >= 1, JSON.stringify(crumbs));
		await page.click('.files-path .path-crumb >> nth=0', { force: true });
		await page.waitForTimeout(600);
		const after = await page.$eval('.files-path', e => e.textContent);
		check('one click on the first segment surfaces all the way to the root, not one level',
			!/gamma/.test(after) && !/beta/.test(after), `was "${pathText}", now "${after}"`);
	}

	// ── 1. The System section has a way back out ───────────────────────
	// A Diamond gives the store real depth to descend into: diamonds/<id>/versions.
	const id = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		return await app.create_diamond('Nav probe');
	});
	await page.waitForTimeout(600);

	const head = await page.$('#sys-head');
	const expanded = head ? await head.getAttribute('aria-expanded') : null;
	if (expanded !== 'true') { await page.click('#sys-head', { force: true }); await page.waitForTimeout(500); }

	await clickRowNamed('#sys-tree .sys-row', 'diamonds');
	await page.waitForTimeout(500);
	await clickRowNamed('#sys-tree .sys-row', id);
	await page.waitForTimeout(500);

	const sysPathDeep = await page.$eval('#sys-path', e => e.textContent);
	check('two levels down inside the System section', sysPathDeep.includes(id), sysPathDeep);

	const sysCrumbs = await crumbTexts('#sys-path');
	if (BREAK === 'crumbs') {
		// The whole claim of this break: with the breadcrumb gutted and the old
		// inline ".." row gone, NOTHING on screen can shorten the path.
		check('(broken) no clickable segment exists in the System path line',
			sysCrumbs.length === 0, JSON.stringify(sysCrumbs));
		const upRow = await page.$('#sys-tree .sys-row:has-text("..")');
		check('(broken) and no fallback ".." row either — the section is provably stuck',
			!upRow, upRow ? 'a ".." row still exists' : 'none');
	} else {
		check('the System path line offers clickable ancestors', sysCrumbs.length >= 2, JSON.stringify(sysCrumbs));
		await page.click('#sys-path .path-crumb >> nth=0', { force: true });
		await page.waitForTimeout(500);
		const sysBack = await page.$eval('#sys-path', e => e.textContent);
		check('clicking the root segment gets the System section back out',
			!sysBack.includes(id), `was "${sysPathDeep}", now "${sysBack}"`);
	}
} finally {
	await shot(s, 'wsnav' + (BREAK ? '-' + BREAK : ''));
	await s.close();
}

console.log(bad.length ? `\n${bad.length} FAILED` : `\nALL PASS (${ok.length})`);
process.exit(bad.length ? 1 : 0);
