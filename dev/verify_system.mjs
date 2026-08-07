// verify_system.mjs — phase F: Daimond's own store is visible, and the rules
// come in two layers.
//
// Notes2 asks two questions with one answer: *"where are all the system files
// like DAIMOND.md??"* and *"All these settings should exist as text files in an
// intuitive system directory hierarchy."*
//
// Six properties:
//
//   1. The Workspace panel has a System section, and it lists the store —
//      `diamonds/`, `prompts/`, `DAIMOND.md` — which `renderTree` deliberately
//      filters out of the tree above it (a × beside `diamonds/` would delete
//      every Diamond you have).
//   2. It is a section, NOT the tree: nothing from the store leaks into the
//      workspace listing, and nothing in the section carries a delete control.
//   3. Its rows open in the Doc panel and read from the STORE, which is a
//      different root from the workspace whenever a folder is open.
//   4. A role prompt lives in the store, so it does not change under the user
//      when they open a folder. This was the deferral's whole reason: doing the
//      instructions half alone would leave the user's rules surviving a root
//      switch while the agent's own prompt silently changed.
//   5. `DAIMOND.md` is TWO layers: the user's own from the store, always in
//      force, and the project's from the folder, appended below it under a
//      heading that says whose it is.
//   6. With no folder open there is one layer, not the same file counted twice.
//
// Properties 5 and 6 are measured through `DaimondPrompts`/`Instructions`'
// composed text rather than from a screenshot, because what matters is what
// reaches the MODEL.
//
//   node dev/verify_system.mjs
//   node dev/verify_system.mjs --break hidden     # the store stays invisible
//   node dev/verify_system.mjs --break onelayer   # the project's copy wins outright
//
// Needs dev/serve.mjs (dev/world.sh N --up). No gateway and no model needed,
// but a connected provider makes the Diamond path work.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { open, connectMock, scratch, shot } from './harness.mjs';

const OUT = path.join(os.homedir(), '.cache/daimond/system-shots');
fs.mkdirSync(OUT, { recursive: true });

const BI = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const MODEL = 'accounts/fireworks/models/glm-5p2';

const s = await open({ name: 'system', profile: scratch('pw', 'system-' + process.pid) });
const { page: p } = s;
try {
	await connectMock(s, { model: MODEL });
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);
	if (BREAK === 'hidden') {
		// The section removed: what the panel looked like before this phase, when
		// the only answer to "where is DAIMOND.md" was "in a place you cannot see".
		await p.addStyleTag({ content: '#sys-sec { display: none !important; }' });
	}

	// Something in the store to look at: a Diamond, and a role prompt seeded from
	// its shipped default.
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate(() => {
		const c = [...document.querySelectorAll('.dlg-card')]
			.filter(x => x.getClientRects().length).pop();
		const i = c.querySelector('input.dlg-input');
		i.value = 'Dee';
		i.dispatchEvent(new Event('input', { bubbles: true }));
		c.querySelector('.dlg-ok').click();
	});
	await p.waitForTimeout(1200);
	await p.evaluate(() => DaimondPrompts.edit('compactor'));
	await p.waitForTimeout(1800);

	// ══ 1. The section lists the store ════════════════════════════════
	// Opened the way a person does: the section is collapsed until asked for.
	const collapsed = await p.evaluate(() => {
		const h = document.getElementById('sys-head');
		return h ? h.getAttribute('aria-expanded') : null;
	});
	await p.evaluate(() => { const h = document.getElementById('sys-head'); if (h) h.click(); });
	await p.waitForTimeout(700);
	const sec = await p.evaluate(() => {
		const el = document.getElementById('sys-sec');
		if (!el) return null;
		return {
			shown: el.getClientRects().length > 0,
			rows: [...document.querySelectorAll('#sys-tree .sys-row')]
				.map(r => (r.querySelector('.files-name') || r).textContent.trim()),
		};
	});
	check(sec !== null, 'the Workspace panel has a System section');
	check(!!(sec && sec.shown), 'and it is on screen');
	check(collapsed === 'false',
		'collapsed by default — it answers a question rather than being where the work is',
		String(collapsed));
	check(!!(sec && sec.rows.some(r => /diamonds/.test(r))),
		'diamonds/ is listed', sec && sec.rows.join(', '));
	check(!!(sec && sec.rows.some(r => /prompts/.test(r))),
		'prompts/ is listed', sec && sec.rows.join(', '));

	// ══ 2. It is a section, not the tree ══════════════════════════════
	const tree = await p.evaluate(() =>
		[...document.querySelectorAll('.files-tree .files-row')]
			.map(r => (r.querySelector('.files-name') || r).textContent.trim()));
	check(!tree.some(r => /diamonds/.test(r)),
		'and the workspace tree above it still does NOT list the store',
		tree.join(', ') || '(empty)');
	const dels = await p.evaluate(() =>
		[...document.querySelectorAll('#sys-tree .sys-row')]
			.filter(r => r.querySelector('.files-del')
				&& getComputedStyle(r.querySelector('.files-del')).display !== 'none').length);
	check(dels === 0, 'no row in the section carries a delete control', String(dels));

	// ══ 3. A row opens, and reads from the STORE ══════════════════════
	const opened = await p.evaluate(async () => {
		const row = [...document.querySelectorAll('#sys-tree .sys-row')]
			.find(r => /prompts/.test(r.textContent || ''));
		if (!row) return 'no prompts row';
		row.click();
		return 'ok';
	});
	check(opened === 'ok', 'the prompts/ row can be opened', opened);
	await p.waitForTimeout(900);
	const inside = await p.evaluate(() =>
		[...document.querySelectorAll('#sys-tree .sys-row')]
			.map(r => (r.querySelector('.files-name') || r).textContent.trim()));
	check(inside.some(r => /compactor\.md/.test(r)),
		'and the role prompt is inside it', inside.join(', '));

	// ══ 4. A role prompt lives in the store, not the folder ═══════════
	//
	// Proved where it can be: the file is READ through the store door. A real
	// folder cannot be opened here (`showDirectoryPicker` needs a user gesture
	// the harness cannot supply), so what is checked is that the read goes to
	// the store at all — which is what makes it survive a root switch.
	const promptSrc = await p.evaluate(async () => {
		const W = await import('/pkg/oxedyne_daimond.js');
		let store = null, ws = null;
		try { store = await W.store_read('prompts/compactor.md'); } catch (e) { store = null; }
		try { ws = await W.read_file('prompts/compactor.md'); } catch (e) { ws = null; }
		return { store: (store || '').slice(0, 60), ws: (ws || '').slice(0, 60),
			held: (DaimondPrompts.md.compactor || '').slice(0, 60) };
	});
	check(!!promptSrc.store, 'the compactor prompt is written in the store',
		promptSrc.store.slice(0, 40));
	check(promptSrc.held === promptSrc.store,
		'and what the app holds is what the STORE says', promptSrc.held.slice(0, 40));

	// ══ 5–6. DAIMOND.md in two layers ═════════════════════════════════
	const layers = await p.evaluate(async (brk) => {
		const W = await import('/pkg/oxedyne_daimond.js');
		await W.store_write('DAIMOND.md', 'Always answer in British English.');
		const I = window.DaimondInstructions;
		if (!I) return null;
		// One layer: no folder is open, so the project's copy is the same file and
		// must not be counted twice.
		await I.refresh();
		const one = { md: I.md, mine: I.mine, theirs: I.theirs };
		// Two layers, simulated at the seam the folder would arrive through. A real
		// folder needs a user gesture the harness cannot make; what is under test is
		// the COMPOSITION, and that is this function.
		I.theirs = brk === 'onelayer' ? 'Use tabs, not spaces.' : 'Use tabs, not spaces.';
		if (brk === 'onelayer') I.mine = '';   // the project's wins outright
		const two = { md: I.layered(), mine: I.mine, theirs: I.theirs };
		return { one, two };
	}, BREAK);
	if (!layers) {
		check(false, 'the instructions module is reachable');
	} else {
		check(layers.one.mine === 'Always answer in British English.',
			'your own DAIMOND.md is read from the store', layers.one.mine);
		check(layers.one.theirs === '',
			'with no folder open there is no second layer', `"${layers.one.theirs}"`);
		check(layers.one.md === layers.one.mine,
			'so the composed text is exactly yours, not yours twice over',
			layers.one.md);
		check(/British English/.test(layers.two.md),
			'with a folder open, YOUR rules are still in force', layers.two.md.slice(0, 80));
		check(/Use tabs/.test(layers.two.md),
			'and the project’s are too', layers.two.md.slice(0, 120));
		check(layers.two.md.indexOf('British English') < layers.two.md.indexOf('Use tabs'),
			'yours first: a project cannot quietly overrule how you work',
			layers.two.md.replace(/\n+/g, ' / '));
		check(/## For this project/.test(layers.two.md),
			'and the project’s are headed, so a model can tell whose is whose',
			layers.two.md.replace(/\n+/g, ' / '));
	}
	await shot(s, 'system');

} catch (e) {
	check(false, 'the run finished', String(e && e.message || e));
	try { await shot(s, 'threw'); } catch {}
} finally {
	await s.close();
}

console.log(failures === 0
	? `\nverify_system: all checks pass.`
	: `\nverify_system: ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
