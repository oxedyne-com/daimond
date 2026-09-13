// verify_crystalcold.mjs — a Diamond's memory is bigger than what rides in the prompt,
// and what is not in the prompt is still reachable.
//
// WHAT THIS IS WRITTEN FROM. The whole of `crystal.json` used to be pushed into the daimon's
// system message on every steering turn (`compose_daimon`), so the crystal's ceiling was a
// per-round bill: one measured turn carried a 16 KiB crystal twenty-seven times, and the only
// way a daimon could record more was to stop recording. Since 2026-09-13 the prompt carries
// the HOT part -- `title`, `summary`, `open` and any section flagged `"hot": true` -- plus an
// OUTLINE of everything else, and the cold half is reached with `crystal_read` and searched
// with `recall`.
//
// That is one claim with four halves, and three of them can pass while the fourth is a lie:
//
//   1. THE COLD BODY IS NOT IN THE PROMPT. The saving is the whole point; if the cold text is
//      still in the system message then nothing has been saved and the outline is decoration.
//   2. THE HOT TEXT IS. A split that dropped the flagged sections would be cheaper still and
//      would have taken the daimon's standing context away from it.
//   3. THE OUTLINE NAMES WHAT IS COLD. A model told there is more, with nothing naming it,
//      cannot ask for any of it -- which is worse than not being told.
//   4. AND THE NAMES WORK. `crystal_read {"section": ...}` must return that body, and `recall`
//      must find a line that is in no prompt anywhere. An outline of unreachable things is the
//      failure this verifier exists for.
//
// Plus the two doors a person meets: the Memory gauge says what the daimon pays, and a hand
// edit that would grow the hot part past its ceiling is refused in words that name the flag.
//
// EACH CHECK PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_crystalcold.mjs --break wholecrystal  # 1 and 3 go red: the prompt carries it all
//   node dev/verify_crystalcold.mjs --break nogauge       # the gauge check goes red, alone
//   node dev/verify_crystalcold.mjs                       # and then, clean
//
// `wholecrystal` is the world before the split and is the important one: it must leave checks
// 2 and 4 GREEN -- the hot text is in a whole crystal too, and the tools read the file rather
// than the prompt -- so a red there would mean this file is measuring the wrong thing.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// The breaks go on what the PAGE does, never on a damaged engine: a break that broke the
// engine would prove only that a broken engine misbehaves.
//
// `wholecrystal` is the world before the split, reached through the app's own setting rather
// than through an edit: a hot ceiling above the whole crystal makes `crystal_split` hand the
// crystal back whole, which is exactly what `compose_daimon` did before this existed. It is
// handled below rather than here, because it is a call and not a source rewrite.
const BREAKS = {
	// The gauge is never drawn, so a user has no way to see what the daimon pays.
	nogauge: {
		file: 'js/daimond.js',
		find: "\t\tbox.appendChild(gauge);",
		with: "\t\tvoid gauge;",
	},
};
const WHOLE = BREAK === 'wholecrystal';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// The fixture. Two hot sections and six cold ones, each body long enough that the split is
// forced rather than incidental, and one marker word that exists ONLY in a cold body.
const HOTMARK  = 'RUBICON-the-hot-marker';
const COLDMARK = 'ZEBRA-the-cold-marker';
const filler   = (w, n) => (w + ' ').repeat(n).trim();
const CRYSTAL  = {
	title:   'Cold storage',
	summary: 'A crystal larger than what rides in the prompt.',
	open:    ['whether the outline is enough to act on'],
	sections: [
		{ heading: 'Ground rules', body: HOTMARK + ' ' + filler('rule', 20), hot: true },
		{ heading: 'Decisions',    body: filler('decided', 30), hot: true },
		{ heading: 'Architecture', body: filler('module', 400) },
		{ heading: 'Cold B',       body: COLDMARK + '\n' + filler('history', 400) },
		{ heading: 'Dead ends',    body: filler('abandoned', 300) },
		{ heading: 'Numbers',      body: filler('measured', 300) },
		{ heading: 'People',       body: filler('who', 200) },
		{ heading: 'Later',        body: filler('someday', 200) },
	],
	facts: [{ k: 'rounding', v: 'half to even' }],
	links: [{ label: 'spec', href: 'https://example.invalid/spec' }],
	mood:  'patient',
};

const s = await open({ name: 'crystalcold', signIn: false, connect: false });
const { page } = s;

if (BREAK && !WHOLE) {
	const spec = BREAKS[BREAK];
	if (!spec) {
		console.error('no such break: ' + BREAK + '\nhave: wholecrystal '
			+ Object.keys(BREAKS).join(' '));
		process.exit(2);
	}
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	await page.route('**/' + spec.file, r => r.fulfill({
		status: 200, contentType: 'application/javascript', body: src.replace(spec.find, spec.with),
	}));
	console.log(`  (running with the app broken: ${BREAK})`);
}

const MOCKURL = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';

try {
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
	await signInAs(s, 'crystalcold');
	await connectMock(s);
	await page.waitForTimeout(1500);

	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Cold storage');
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(2000);

	const id = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		window.__free = app;
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Cold storage');
		return d ? d.id : '';
	});
	check('a Diamond to fill', !!id, id);

	// The break: a hot ceiling above the whole crystal, which is the world before the split.
	if (WHOLE) {
		await page.evaluate(() => { window.__free.set_crystal_hot_cap(1024 * 1024); });
		console.log('  (running with the hot ceiling lifted above the whole crystal)');
	}

	// Seeded through the file tool, so what is on disk is exactly the fixture.
	const seeded = await page.evaluate(async (a) => {
		await window.__free.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + a.id + '/crystal.json', content: a.crystal }));
		return String(await window.__free.read_crystal_data(a.id)).length;
	}, { id, crystal: JSON.stringify(CRYSTAL, null, 1) });
	check('the crystal is larger than the hot ceiling, so the split is forced',
		seeded > 4096, seeded + ' bytes');

	// ── 1 to 3: what the daimon is composed with ──────────────────────
	const wire = await page.evaluate(async (a) => {
		try {
			const w = JSON.parse(await window.__free.wire_system(a.id, '[]', '[]', '[]'));
			return String(w && w.local || '');
		} catch (e) { return 'ERR:' + String(e && e.message || e); }
	}, { id });

	check('the hot section text IS in the system message the daimon is composed with',
		wire.indexOf(HOTMARK) >= 0, wire.length + ' chars of local text');
	check('and the COLD section body is NOT',
		wire.indexOf(COLDMARK) < 0,
		wire.indexOf(COLDMARK) < 0 ? 'absent, as it must be' : 'the cold body is still in the prompt');
	check('the outline names the cold section anyway, so it can be asked for',
		wire.indexOf('Cold B') >= 0 && /\d+ bytes/.test(wire),
		(wire.match(/- "Cold B"[^\n]*/) || ['(no outline row)'])[0]);
	check('and it names the cold KEYS as well, the unknown one included',
		wire.indexOf('facts') >= 0 && wire.indexOf('mood') >= 0);
	check('and it says how to move a section into the hot part',
		/"hot": true/.test(wire));

	// ── 4: the names work, through a real daimon turn ─────────────────
	//
	// `@tool` makes the mock answer with the call named, so what runs is a tool inside a
	// daimon's own context rather than a call this file made on its behalf.
	const steer = async (instruction) => await page.evaluate(async (a) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp(a.mock, 'mock-key', 'mock/fast', 4096, '', true);
		const seen = [];
		await app.steer_crystal(a.id, a.instruction, '[]', '[]', '[]', [],
			(ev) => { seen.push({ type: ev.type, name: ev.name || '', content: ev.content || '' }); });
		return seen;
	}, { id, instruction, mock: MOCKURL });
	const resultOf = (seen, name) => (seen.find(e => e.type === 'tool_result'
		&& (!name || e.name === name)) || {}).content || '';

	const rOutline = resultOf(await steer('@tool crystal_read {}'), 'crystal_read');
	check('crystal_read with no arguments answers with the outline',
		/Cold B/.test(rOutline) && /cold/.test(rOutline) && /Ground rules/.test(rOutline),
		rOutline.slice(0, 90).replace(/\n/g, ' '));
	check('and the outline still does not carry a cold body',
		rOutline.indexOf(COLDMARK) < 0, rOutline.length + ' chars');

	const rSection = resultOf(await steer('@tool crystal_read {"section":"Cold B"}'), 'crystal_read');
	check('crystal_read by heading returns the cold body the prompt did not carry',
		rSection.indexOf(COLDMARK) >= 0, rSection.slice(0, 90).replace(/\n/g, ' '));
	check('and returns that section and not its neighbour',
		rSection.indexOf('abandoned') < 0);

	const rKey = resultOf(await steer('@tool crystal_read {"key":"facts"}'), 'crystal_read');
	check('crystal_read by key reaches a cold top-level key',
		/half to even/.test(rKey), rKey.slice(0, 80).replace(/\n/g, ' '));

	const rRecall = resultOf(await steer('@tool recall {"query":"' + COLDMARK + '"}'), 'recall');
	check('recall finds a line that is in no prompt anywhere',
		rRecall.indexOf(COLDMARK) >= 0 && /crystal:Cold B:/.test(rRecall),
		rRecall.slice(0, 110).replace(/\n/g, ' '));
	check('and says what it searched, rather than answering as though it had looked everywhere',
		/\[recall\]/.test(rRecall), (rRecall.match(/\[recall\][^\n]*/) || [''])[0]);

	// ── The two doors a person meets ──────────────────────────────────
	await page.$$eval('.diamond-box', els => els[0] && els[0].click());
	await page.waitForTimeout(2500);
	const gauge = await page.$eval('.crystal-memory-gauge', el => el.textContent).catch(() => '');
	check('the Memory panel says what the daimon pays for this crystal',
		/hot /.test(gauge) && /total /.test(gauge) && /KB/.test(gauge), gauge || '(no gauge)');

	// A hand edit that grows the hot part past its ceiling is refused at the store's door --
	// the one a fold and a hand edit come through, which is the door the file tools never see.
	const refused = await page.evaluate(async (a) => {
		const big = JSON.parse(JSON.stringify(a.crystal));
		big.summary = 'x'.repeat(8000);
		try { await window.__free.write_crystal_data(a.id, JSON.stringify(big)); return ''; }
		catch (e) { return String((e && e.message) || e).replace(/\[[0-9;]*m/g, ''); }
	}, { id, crystal: CRYSTAL });
	check('a hand edit that grows the hot part past its ceiling is refused',
		!!refused, refused.slice(0, 100));
	check('and the refusal names the flag that resolves it rather than telling anyone to delete',
		/"hot"/.test(refused) && /crystal_read/.test(refused), refused.slice(0, 140));

	const errs = errors(s).filter(e => !/502|Bad Gateway|account/i.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
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
