// verify_compound.mjs — one call reads a list of files, and every answer is
// where the model asked for it.
//
// Measure 1 of the parity plan of 2026-09-14. A daimon spent 8.0 rounds a task
// against Claude Code's 4.1 over eight matched tasks on the 09-13 bank, and
// twelve of the thirty-eight excess rounds were a single file read on its own:
// list a folder, read what it named, search for the name that file used, read
// where the search pointed. `compound` answers an ordered list of read ops in
// ONE round, which is what `ls -R; cat src/*.js` gives a shell for nothing.
//
// WHAT IS UNDER TEST HERE IS NOT THE SAVING, it is the CONTRACT — the four
// things that have to be true before a saved round is worth having:
//
//   §1  the ops are answered in order, each under its own numbered label
//   §2  a refused op keeps its slot, and the ops beside it still run
//   §3  the budget cuts the op it names, and the header says which
//   §4  the tool is in no request until the tune switches it on, and the
//       briefing sentence travels with it
//
// §1's ORDER is the one that looks like tidiness and is not. Six answers in one
// result and nothing to tell them apart is a model reading the second file's
// contents as the first's — and it would do so silently, with the right bytes
// in the wrong place. §2 is the same property under failure: an op that
// vanished rather than keeping its slot renumbers every op after it.
//
// §3 is the half a model has to be able to act on. A compound can ask for six
// results at once, so it cannot hand all of them over; what makes the cut
// survivable is that the header NAMES the op it cut, so the next call asks for
// that one alone instead of re-sending the whole compound.
//
// §4 is what makes the bank's `cur` arm a control. `Tool::Compound` rides on
// every belt and is withheld from the schema array until `set_tune
// {"compound":true}` — so a `cur` round is byte-for-byte what shipped, not even
// paying the 2,209 characters of description and schema.
//
// The fence is NOT a section of its own, and that is deliberate: each op is
// dispatched through `ToolRegistry::dispatch_op`, the same door the primitive
// goes through alone, so what would be tested here is already tested in
// `src/tools.rs` against the primitive's own refusal, verbatim
// (`test_an_op_is_refused_by_the_primitives_own_fence_in_the_primitives_own_words`).
// A browser check could only repeat it more weakly.
//
//   node dev/verify_compound.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open as openApp, MOCK } from './harness.mjs';
import { whyStaleWasm, refuse } from './staleguard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);

// Big enough that the budget in §3 has something to cut, small enough that §1's
// three reads arrive whole under the 32 KiB default.
const BIG = 20 * 1024;

// The whole of this file is a claim about the ENGINE, and it drives the engine
// module directly rather than through the page — so a stale bundle would not
// show up as a broken app, it would show up as yesterday's dispatch reporting
// today's contract.
refuse(whyStaleWasm(path.join(ROOT, 'www/pkg/oxedyne_daimond_bg.wasm'),
	path.join(ROOT, 'src'), {
		subject: 'What one call reads, and what it says about what it cut',
		holds:   '`ToolRegistry::compound` and the ops it dispatches',
	}));

/// The body of one op's slot: everything after its `--- [n] ` header, up to the next.
function slot(text, n) {
	const from = text.indexOf(`--- [${n}] `);
	if (from < 0) return null;
	const rest = text.slice(from);
	const next = rest.indexOf('\n--- [');
	return next < 0 ? rest : rest.slice(0, next);
}

/// The header line, which is the first line of every compound result.
const header = (text) => (text || '').split('\n')[0] || '';

async function main() {
	const s = await openApp({ name: 'compound' });
	const page = s.page;
	try {
		await page.evaluate((m) => { window.__mock = m; }, MOCK);
		await page.evaluate(() => {
			window.__app = async () => {
				const mod = await import('/pkg/oxedyne_daimond.js');
				const app = new mod.DaimondApp(window.__mock, 'k', 'mock/fast', 4096, '', true);
				app.set_max_rounds(3);
				return app;
			};
		});

		// The fixture, written through the engine's own file tools, so the reads come
		// out of the same OPFS everything else uses.
		const built = await page.evaluate(async ({ big }) => {
			const app = await window.__app();
			window.__fix = app;
			// Each file opens with its own word, so an answer in the wrong place is
			// caught by what it SAYS and not merely by where it is.
			await app.run_tool('file_write', JSON.stringify({
				path: 'src/one.js', content: 'MARK-ONE\nexport function formatWhen() {}\n' }));
			await app.run_tool('file_write', JSON.stringify({
				path: 'src/two.js', content: 'MARK-TWO\n' }));
			await app.run_tool('file_write', JSON.stringify({
				path: 'src/big.js', content: 'MARK-BIG\n' + 'x'.repeat(big) }));
			return (await app.run_tool('file_list', JSON.stringify({ path: 'src' }))).length > 0;
		}, { big: BIG });
		check('a workspace of three files is in place', built === true, `built ${built}`);

		// ── §1: answered in order, each under its own label ─────────
		const one = await page.evaluate(async () => {
			const app = await window.__app();
			return await app.run_tool('compound', JSON.stringify({ ops: [
				{ op: 'list',    path: 'src' },
				{ op: 'read',    path: 'src/one.js' },
				{ op: 'read',    path: 'src/two.js' },
				{ op: 'outline', path: 'src/one.js' },
			] }));
		});
		check('§1 the header says four ops ran and all four are done',
			/^compound: 4 ops, 4 done, /.test(header(one)), header(one));
		const at = (needle) => one.indexOf(needle);
		check('§1 every op has its own numbered slot, in the order the model gave',
			at('--- [1] list src') >= 0
			&& at('--- [1] list src') < at('--- [2] read src/one.js')
			&& at('--- [2] read src/one.js') < at('--- [3] read src/two.js')
			&& at('--- [3] read src/two.js') < at('--- [4] outline src/one.js'),
			[1, 2, 3, 4].map((n) => (slot(one, n) ? '' : `op ${n}`)).filter(Boolean).join(', ')
				|| 'all four in place');
		// AND EACH ANSWER IS THE ANSWER TO ITS OWN CALL, which is the property the
		// labels exist for: the right bytes in the wrong slot is a silent fault.
		check('§1 each answer sits in its own slot',
			(slot(one, 2) || '').includes('MARK-ONE')
			&& (slot(one, 3) || '').includes('MARK-TWO')
			&& !(slot(one, 2) || '').includes('MARK-TWO'),
			'op 2 holds ' + JSON.stringify((slot(one, 2) || '').slice(0, 60)));
		check('§1 the outline is an outline and not a second read of the file',
			(slot(one, 4) || '').includes('formatWhen')
			&& !(slot(one, 4) || '').includes('MARK-ONE'),
			JSON.stringify((slot(one, 4) || '').slice(0, 80)));

		// ── §2: a refusal keeps its slot ────────────────────────────
		//
		// An absolute path, which every file tool refuses by the same sentence —
		// `absolute_path_refusal`, applied in `guard`, inside the op's own dispatch.
		const two = await page.evaluate(async () => {
			const app = await window.__app();
			return await app.run_tool('compound', JSON.stringify({ ops: [
				{ op: 'read', path: 'src/one.js' },
				{ op: 'read', path: '/etc/passwd' },
				{ op: 'read', path: 'src/two.js' },
			] }));
		});
		check('§2 the header counts the refusal rather than hiding it',
			/^compound: 3 ops, 2 done, 1 refused, /.test(header(two)), header(two));
		check('§2 the refused op keeps its slot, and the refusal is in it',
			(slot(two, 2) || '').includes('Refused'),
			JSON.stringify((slot(two, 2) || '').slice(0, 100)));
		check('§2 the ops beside it still ran',
			two.includes('MARK-ONE') && two.includes('MARK-TWO'),
			'one: ' + two.includes('MARK-ONE') + ', two: ' + two.includes('MARK-TWO'));
		// The CALL is still work that was done, because two files were read — and
		// `run_tool_outcome` is the tool layer's own verdict, not a reading of prose.
		const twoOut = await page.evaluate(async () => {
			const app = await window.__app();
			const r = await app.run_tool_outcome('compound', JSON.stringify({ ops: [
				{ op: 'read', path: 'src/one.js' },
				{ op: 'read', path: '/etc/passwd' },
			] }));
			return r.outcome;
		});
		check('§2 a compound that read something is booked as work done',
			twoOut === 'done', `outcome ${twoOut}`);
		// And one that read NOTHING is a refusal, which is the half that matters: a
		// refusal booked as a read is how a model comes to believe it has looked.
		const noneOut = await page.evaluate(async () => {
			const app = await window.__app();
			const r = await app.run_tool_outcome('compound', JSON.stringify({ ops: [
				{ op: 'read', path: '/etc/passwd' },
				{ op: 'list', path: '/var' },
			] }));
			return { outcome: r.outcome, head: (r.text || '').split('\n')[0] };
		});
		check('§2 a compound that read nothing is booked as a refusal',
			noneOut.outcome === 'refused', `outcome ${noneOut.outcome} — ${noneOut.head}`);

		// ── §3: the budget cuts the op it names ─────────────────────
		const three = await page.evaluate(async () => {
			const app = await window.__app();
			return await app.run_tool('compound', JSON.stringify({
				ops: [{ op: 'read', path: 'src/two.js' }, { op: 'read', path: 'src/big.js' }],
				budget: 4000,
			}));
		});
		check('§3 the whole result is inside the budget the call asked for',
			three.length <= 4000, `${three.length} bytes of 4000`);
		check('§3 the header names the op the budget cut',
			/op 2 was cut to fit/.test(header(three)), header(three));
		check('§3 the answer that fitted was not cut with it',
			(slot(three, 1) || '').includes('MARK-TWO'),
			JSON.stringify((slot(three, 1) || '').slice(0, 60)));
		// THE ROOM A SMALL ANSWER DOES NOT NEED GOES TO THE ONE THAT DOES. An even
		// split would have left the big read half the budget; it gets nearly all of it.
		const big = slot(three, 2) || '';
		check('§3 the unused room is passed to the answer that needed it',
			big.length > 2500, `op 2 got ${big.length} bytes`);
		check('§3 a cut answer keeps its tail as well as its head',
			big.includes('MARK-BIG') && /cut from the middle/.test(big),
			JSON.stringify(big.slice(-80)));

		// ── §4: in no request until the tune switches it on ─────────
		const four = await page.evaluate(async () => {
			const app = await window.__app();
			const off = JSON.parse(await app.wire_system('', '[]', '[]', '[]'));
			app.set_tune(JSON.stringify({ compound: true }));
			const echoed = JSON.parse(app.turn_limits);
			const on = JSON.parse(await app.wire_system('', '[]', '[]', '[]'));
			return {
				offNames: off.names, offSchemas: off.schemas_len,
				onNames: on.names, onSchemas: on.schemas_len,
				sentence: on.tools_sentence, offSentence: off.tools_sentence,
				echoed: echoed.compound,
			};
		});
		check('§4 the engine echoes the switch, so an arm can prove it landed',
			four.echoed === true, `turn_limits.compound = ${JSON.stringify(four.echoed)}`);
		check('§4 with the switch off the tool is in neither the names nor the schemas',
			!four.offNames.includes('compound') && !four.offSentence.includes('compound'),
			four.offNames.join(', '));
		check('§4 with it on the tool is named to the model',
			four.onNames.includes('compound'), four.onNames.join(', '));
		check('§4 and the schema array grows by the tool rather than by nothing',
			four.onSchemas > four.offSchemas,
			`${four.offSchemas} → ${four.onSchemas} characters`);
		// THE SENTENCE THAT CHANGES THE HABIT. The tool is worth nothing to a model
		// that goes on reading one file per round, so the briefing travels with it.
		check('§4 the briefing tells the model when to reach for it',
			/use compound and get them all in one call/.test(four.sentence),
			JSON.stringify(four.sentence.slice(-140)));
		note(`the tool costs ${four.onSchemas - four.offSchemas} characters of prefix, `
			+ 'and only on an arm that asked for it');
	} finally {
		await s.close();
	}
}

main().then(() => {
	console.log(`\n  ${ok.length} ok, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
}).catch((e) => {
	console.error('ABORT: ' + (e && e.stack || e));
	process.exit(2);
});
