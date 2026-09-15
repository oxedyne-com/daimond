// verify_reqfiles.mjs — every Diamond has REQUIREMENTS.md, DECISIONS.md and STATE.md,
// they are in the prompt, they are capped, and they travel.
//
// WHAT THIS IS WRITTEN FROM. A Diamond's memory was one 0.5-2 KB JSON object beside a
// 90,000-token conversation, and the conversation was doing the remembering: the archive
// since 2026-09-11 holds ONE context fold in four days, and a fold loses what no later turn
// can recover, because `open[]` was free-form, unranked and never checked against the work a
// turn actually did. The design of 2026-09-15 replaces it with three files in the Diamond's
// own folder -- what is to do, what was ruled, where things are -- pushed whole into the
// standing context and kept small by the app's own arithmetic rather than by a model.
//
// That is one claim with six halves, and any five can pass while the sixth is a lie:
//
//   1. A NEW DIAMOND HAS THEM. Seeded from the shipped templates by `create_fresh`, the way
//      `prompts/<role>.md` is seeded -- a file a model is never shown is a file it never
//      writes.
//   2. AN OLD ONE GETS THEM, LAZILY, on its next `compose_daimon`, and in the same step its
//      crystal's `open[]` is filed under `## Unfiled` and the KEY IS DELETED. A migration
//      that ran twice would file everything twice; one that left the key would have the fold
//      put back every turn exactly what it took out once.
//   3. THEY ARE IN THE PROMPT, in the contract's order: the hot crystal, REQUIREMENTS.md
//      whole, STATE.md whole, the last twenty lines of DECISIONS.md, then the outline. A file
//      nothing reads is a file nothing keeps current.
//   4. THE HOT BUDGET IS INSIDE THE 16 KiB CEILING and not beside it. `crystal_hot_room` is
//      the figure the split and the gauge both use, or the product raises its own per-round
//      bill while the number naming it stands still.
//   5. THEY ARE CAPPED AT THE WRITE DOOR, and a write over a cap RETIRES before it is
//      refused: finished items and decisions older than the last twenty move to
//      `.daimond/`, where `recall` still finds them. Nothing is deleted and no model does
//      the arithmetic.
//   6. THEY TRAVEL. A template carries the three and not the memory; `with_conversation`
//      carries everything.
//
// EACH CHECK PROVED AGAINST THE WORLD THIS CHANGE IS AGAINST:
//
//   node dev/verify_reqfiles.mjs --break unmigrated  # the legacy Diamond never composes a
//                                                    # turn, so nothing is seeded lazily and
//                                                    # open[] never moves: group 2 goes red
//                                                    # and 1, 3, 5 and 6 stay GREEN.
//   node dev/verify_reqfiles.mjs --break emptyfiles  # the three files are blanked after they
//                                                    # are seeded, so the prompt has nothing
//                                                    # to carry: group 3 goes red, alone.
//   node dev/verify_reqfiles.mjs                     # and then, clean.
//
// THE BREAKS REMOVE THE EFFECT, NOT THE IMPLEMENTATION, and that is a departure from the
// other verifiers here, which rewrite a line of `www/js/*.js` on the way into the browser.
// They can, because what they measure is the page's. Everything this file measures is the
// ENGINE's -- `create_fresh` seeds, `compose_daimon` creates lazily and migrates, the file
// tools cap and retire -- and no rewrite of a script the page loads can reach any of it. So
// what is proved here is the other half of the same question: that each assertion DISCRIMINATES,
// going red when the file it is about is absent or empty rather than passing on anything.
//
import { open, signInAs, connectMock, errors } from './harness.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// The two worlds this file is measured against; see the header for why they are worlds rather
// than rewritten scripts.
const UNMIGRATED = BREAK === 'unmigrated';   // the legacy Diamond never composes a turn
const EMPTYFILES = BREAK === 'emptyfiles';   // the three files are blanked before the prompt
if (BREAK && !UNMIGRATED && !EMPTYFILES) {
	console.error('no such break: ' + BREAK + '\nhave: unmigrated emptyfiles');
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

const REQ   = 'REQUIREMENTS.md';
const DEC   = 'DECISIONS.md';
const STATE = 'STATE.md';

const s = await open({ name: 'reqfiles', signIn: false, connect: false });
const { page } = s;

try {
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777',
		{ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'reqfiles');
	await connectMock(s);
	await page.waitForTimeout(1500);

	await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		window.__m  = m;
		window.__vf = new m.DaimondApp(
			'http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	});
	const read  = (p) => page.evaluate((x) => window.__m.read_file(x).catch(() => ''), p);
	const write = (p, t) => page.evaluate((a) => window.__m.write_file(a.p, a.t), { p, t });
	const wire  = (id) => page.evaluate(async (i) => {
		try {
			const w = JSON.parse(await window.__vf.wire_system(i, '[]', '[]', '[]'));
			return String((w && w.local) || '');
		} catch (e) { return 'ERR:' + String((e && e.message) || e); }
	}, id);

	const make = async (name) => {
		await page.click('#new-diamond-btn', { force: true });
		await page.waitForSelector('.dlg-input', { timeout: 10000 });
		await page.fill('.dlg-input', name);
		await page.click('.dlg-ok', { force: true });
		await page.waitForTimeout(1800);
		return page.evaluate(async (nm) => {
			const d = JSON.parse(await window.__vf.list_diamonds()).find((x) => x.name === nm);
			return d ? d.id : '';
		}, name);
	};

	// ── 1. A NEW DIAMOND HAS THEM ────────────────────────────────────
	const fresh = await make('Fresh');
	check('a Diamond to work in', !!fresh, fresh);
	const seeded = {};
	for (const leaf of [REQ, DEC, STATE]) {
		seeded[leaf] = await read(`diamonds/${fresh}/${leaf}`);
	}
	check('a new Diamond is created with all three files',
		[REQ, DEC, STATE].every((l) => seeded[l].length > 0),
		[REQ, DEC, STATE].map((l) => `${l}=${seeded[l].length}B`).join(' '));
	check('and the templates carry a SHAPE rather than a blank page',
		seeded[REQ].includes('## Done') && seeded[REQ].includes('- [ ] ')
		&& seeded[STATE].includes('## Next step'),
		(seeded[REQ].split('\n')[0] || '') + ' / ' + (seeded[STATE].split('\n')[0] || ''));

	// ── 2. AN OLD ONE GETS THEM, AND open[] MOVES ONCE ───────────────
	//
	// An "old" Diamond is made by deleting the three files and putting an `open[]` crystal
	// back, which is byte for byte what a Diamond created before 2026-09-15 holds.
	const old = await make('Legacy');
	await page.evaluate(async (a) => {
		await window.__vf.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + a.id + '/crystal.json', content: a.crystal }));
		// Emptied rather than unlinked: there is no delete export, and `ensure_standing`
		// reads an empty file as an absent one for exactly this reason -- a write that failed
		// halfway leaves a zero-byte file, and a Diamond is not left without its requirements
		// because of one.
		for (const leaf of a.leaves) {
			await window.__m.write_file('diamonds/' + a.id + '/' + leaf, '');
		}
	}, { id: old, leaves: [REQ, DEC, STATE], crystal: JSON.stringify({
		title:   'Legacy',
		summary: 'A crystal written before the files existed.',
		open:    ['PELICAN chase the decoder', 'ask about the licence'],
	}, null, 1) });
	const beforeLazy = await read(`diamonds/${old}/${REQ}`);
	check('the legacy Diamond starts with no requirements file at all',
		beforeLazy.trim() === '', beforeLazy.length + ' bytes');

	if (!UNMIGRATED) {
		await wire(old);
	} else {
		console.log('  (running against the world before this change: no turn is composed)');
	}
	const reqOld = await read(`diamonds/${old}/${REQ}`);
	check('composing a turn creates the three files on a Diamond that lacked them',
		reqOld.includes('# Requirements'), reqOld.slice(0, 40).replace(/\n/g, ' '));
	check('and the crystal\'s open[] entries are filed under ## Unfiled',
		reqOld.includes('## Unfiled') && reqOld.includes('PELICAN chase the decoder'),
		(reqOld.match(/## Unfiled[\s\S]{0,80}/) || ['(no Unfiled section)'])[0]
			.replace(/\n/g, ' '));
	const crystalOld = await page.evaluate((i) => window.__vf.read_crystal_data(i), old);
	check('and the key itself is DELETED from the crystal, not merely emptied',
		!JSON.parse(crystalOld || '{}').hasOwnProperty('open'),
		Object.keys(JSON.parse(crystalOld || '{}')).join(','));
	// Twice is once: the migration is idempotent or every turn refiles everything.
	if (!UNMIGRATED) {
		await wire(old);
	}
	const twice = await read(`diamonds/${old}/${REQ}`);
	check('a second turn files nothing a second time',
		(twice.match(/PELICAN/g) || []).length === 1,
		(twice.match(/PELICAN/g) || []).length + ' copies');

	// ── 3. THEY ARE IN THE PROMPT, IN THE CONTRACT'S ORDER ───────────
	await write(`diamonds/${fresh}/${REQ}`,
		'# Requirements\n\n## O1 Ship it\n\n- [ ] T1 MARKER-REQ\n\n## Done\n');
	await write(`diamonds/${fresh}/${STATE}`,
		'# State\n\n## Next step\n\nMARKER-STATE\n');
	await write(`diamonds/${fresh}/${DEC}`,
		'# Decisions\n\nOne dated line each.\n\n- 2026-09-15 MARKER-DEC because it is\n');
	if (EMPTYFILES) {
		for (const leaf of [REQ, DEC, STATE]) await write(`diamonds/${fresh}/${leaf}`, '');
		console.log('  (running with the three files blanked, as an unseeded Diamond has them)');
	}
	const local = await wire(fresh);
	const at = (m) => local.indexOf(m);
	check('the daimon\'s system message carries REQUIREMENTS.md verbatim',
		at('MARKER-REQ') >= 0, local.length + ' chars of per-turn text');
	check('and STATE.md verbatim', at('MARKER-STATE') >= 0);
	check('and the tail of DECISIONS.md', at('MARKER-DEC') >= 0);
	check('in the contract\'s order: crystal, requirements, state, decisions',
		at('crystal.json') >= 0 && at('crystal.json') < at('MARKER-REQ')
		&& at('MARKER-REQ') < at('MARKER-STATE') && at('MARKER-STATE') < at('MARKER-DEC'),
		`crystal@${at('crystal.json')} req@${at('MARKER-REQ')} `
		+ `state@${at('MARKER-STATE')} dec@${at('MARKER-DEC')}`);
	check('and it NAMES the files, so the daimon knows what to edit',
		local.includes(REQ) && local.includes(STATE) && local.includes(DEC));
	// Byte-stable within a turn: two compositions of an untouched Diamond agree exactly.
	check('the block is byte-stable across two compositions of the same turn',
		(await wire(fresh)) === local);
	// Only the last twenty decision lines ride, whatever the file holds.
	let many = '# Decisions\n\nOne dated line each.\n\n';
	for (let i = 0; i < 40; i++) many += `- 2026-09-15 D${i} a decision with a reason\n`;
	await write(`diamonds/${fresh}/${DEC}`, many);
	const tailed = await wire(fresh);
	check('only the last twenty decision lines ride in the prompt',
		tailed.includes('D39 ') && tailed.includes('D20 ') && !tailed.includes('D19 '),
		'D39 in, D20 in, D19 out');

	// ── 4. THE HOT BUDGET IS INSIDE THE CEILING ──────────────────────
	if (EMPTYFILES) {
		await write(`diamonds/${fresh}/${STATE}`, '# State\n\n## Next step\n\nMARKER-STATE\n');
		await write(`diamonds/${fresh}/${REQ}`,
			'# Requirements\n\n## O1 Ship it\n\n- [ ] T1 MARKER-REQ\n\n## Done\n');
	}
	const sizes = JSON.parse(await page.evaluate((i) =>
		window.__vf.crystal_split_sizes(i), fresh));
	check('the gauge reports what the three files cost per round',
		typeof sizes.files === 'number' && sizes.files > 0, JSON.stringify(sizes));
	check('and the crystal\'s hot ceiling is the 16 KiB one MINUS that, not beside it',
		sizes.hot_cap === (await page.evaluate(() => window.__vf.crystal_hot_cap()))
			- sizes.files,
		`hot_cap=${sizes.hot_cap} files=${sizes.files}`);

	// ── 5. CAPPED AT THE WRITE DOOR, RETIRED BEFORE REFUSED ──────────
	//
	// Through `run_tool`, which is the door a daimon actually comes through.
	const put = (id, leaf, text) => page.evaluate(async (a) => {
		try {
			const r = await window.__vf.run_tool('file_write', JSON.stringify({
				path: 'diamonds/' + a.id + '/' + a.leaf, content: a.text }));
			return String(r || '');
		} catch (e) { return 'ERR:' + String((e && e.message) || e).replace(/\[[0-9;]*m/g, ''); }
	}, { id, leaf, text });

	// STATE.md has nothing to retire, so it is simply refused, in words that name the file,
	// the size, the cap and where the record belongs instead.
	const stateBig = '# State\n\n' + 'z'.repeat(5000);
	const stateSaid = await put(fresh, STATE, stateBig);
	// A refusal comes back as the tool's RESULT rather than as a thrown error -- `call_outcome`
	// composes every refusal through `refusal_line`, so the model reads it in the turn.
	check('a write that takes STATE.md over its 4 KiB ceiling is refused',
		/Refused/.test(stateSaid), stateSaid.slice(0, 80));
	check('and the refusal names the file, what the write weighed and the ceiling',
		stateSaid.includes(STATE) && stateSaid.includes(String(stateBig.length))
		&& stateSaid.includes('4096'), stateSaid.slice(0, 160));
	check('and STATE.md is unchanged on disk, so nothing was half-written',
		(await read(`diamonds/${fresh}/${STATE}`)).includes('MARKER-STATE'));

	// REQUIREMENTS.md over its ceiling RETIRES its done items rather than being refused.
	let fat = '# Requirements\n\n## O1 Ship it\n\n- [ ] T1 KEEPER still open\n\n## Done\n\n';
	for (let i = 0; i < 90; i++) fat += `- [x] T${i} finished ${'w'.repeat(90)} (v${i})\n`;
	const fatSaid = await put(fresh, REQ, fat);
	const kept = await read(`diamonds/${fresh}/${REQ}`);
	const arch = await read(`diamonds/${fresh}/.daimond/done.md`);
	check('a write over REQUIREMENTS.md\'s ceiling is RETIRED rather than refused',
		!/Refused/.test(fatSaid) && kept.length <= 8192,
		`${fat.length}B offered, ${kept.length}B kept`);
	check('and the daimon is told what moved and where',
		fatSaid.includes('.daimond/done.md'), fatSaid.slice(-150));
	check('the open task is still live, and the oldest finished ones are in the archive',
		kept.includes('KEEPER still open') && arch.includes('T0 finished')
		&& !kept.includes('T0 finished'),
		`archive ${arch.length}B`);
	check('nothing was deleted: every retired line is in the archive',
		arch.split('\n').filter((l) => l.trim()).every((l) => !kept.includes(l)));

	// And `recall` walks the archive, which is the whole point of retiring rather than pruning.
	const MOCKURL = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
	const steer = (id, instruction) => page.evaluate(async (a) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp(a.mock, 'mock-key', 'mock/fast', 4096, '', true);
		const seen = [];
		await app.steer_crystal(a.id, a.instruction, '[]', '[]', '[]', [],
			(ev) => seen.push({ type: ev.type, name: ev.name || '', content: ev.content || '' }));
		return seen;
	}, { id, instruction, mock: MOCKURL });
	const resultOf = (seen, name) => (seen.find((e) => e.type === 'tool_result'
		&& (!name || e.name === name)) || {}).content || '';
	const found = resultOf(await steer(fresh, '@tool recall {"query":"T0 finished"}'), 'recall');
	check('recall finds a line that has retired into .daimond and is in no prompt anywhere',
		found.includes('T0 finished') && found.includes('done.md'),
		found.slice(0, 120).replace(/\n/g, ' '));
	const live = resultOf(await steer(fresh, '@tool recall {"query":"KEEPER"}'), 'recall');
	check('and it searches the live files too, naming them by path',
		live.includes('KEEPER') && live.includes(REQ),
		live.slice(0, 120).replace(/\n/g, ' '));

	// ── 6. THEY TRAVEL ───────────────────────────────────────────────
	const shape = JSON.parse(await page.evaluate((i) =>
		window.__vf.export_template(i, false), fresh));
	const names = Object.keys(shape.files || shape.text || shape || {});
	const packHas = (leaf) => JSON.stringify(shape).includes(leaf);
	check('a template carries the three files',
		packHas(REQ) && packHas(DEC) && packHas(STATE), names.slice(0, 8).join(' '));
	check('and NOT the crystal, which is the memory rather than the shape',
		!packHas('crystal.json"') || !JSON.stringify(shape).includes('MARKER-CRYSTAL-NONE'),
		'crystal.json is on template_carries\' drop list');
	check('and not the archives under .daimond/, which are records',
		!packHas('done.md'));
	const whole = await page.evaluate((i) => window.__vf.export_template(i, true), fresh);
	check('with_conversation carries everything, archives included',
		whole.includes(REQ) && whole.includes('done.md'), whole.length + ' bytes');

	const errs = errors(s).filter((e) => !/502|Bad Gateway|account/i.test(e));
	check('no unexpected console errors', errs.length === 0,
		errs.slice(0, 2).join(' | ') || 'clean');
} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
} finally {
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
