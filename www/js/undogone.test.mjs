/* ============================================================
   Test — the Undo's own question (www/js/versions.js `askGone`).
   ------------------------------------------------------------
   Drives the REAL www/js/versions.js in a simulated tab (a fake
   `DaimondCore.diamondApp` engine and a capturing `confirm`) to
   prove the one thing release 5.1's round-3 QA found (UQ): before
   this fix, `undoVersion` asked its "delete files from your
   folder?" question with the Restore's own sentence -- "Restoring
   it would delete them" -- which is the wrong act's name for an
   Undo. The two calls must now ask through two different i18n
   keys, so a translated build shows the Undo its own words.

   No browser, no wasm: the fake engine's `versions_undo_open` and
   `versions_restore_open` each answer one `gone` file, and the
   test reads which key `askGone` handed to `DaimondCore.confirm`.
   `window.DaimondI18n.t` is stubbed to echo its key back inside the
   string it returns, which is what lets the test tell the two
   calls apart without needing a translated table.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

/// One simulated tab, with a fake engine that answers one `gone` file (`x.md`)
/// from both `versions_undo_open` and `versions_restore_open`, and a `confirm`
/// that records what it was asked and always answers `answer`.
function makeTab(answer) {
	const asked = [], runCalls = [];
	const engine = {
		versions_list: () => '[]',
		versions_undo_open: async () => JSON.stringify({
			ticket: 't-undo',
			machine: [{ path: 'x.md', gone: true, kept: true, left: false, hash: 'h1' }],
		}),
		versions_restore_open: async () => JSON.stringify({
			ticket: 't-restore',
			machine: [{ path: 'x.md', gone: true, kept: true, left: false, hash: 'h1' }],
		}),
		versions_restore_close: async () => JSON.stringify(
			{ version: 1, recorded: 1, restored: [], missing: [], refused: [] }),
		// Called only where `askGone` answered yes: a no refuses every `gone`
		// entry before the loop reaches a door, so a call here proves the
		// answer actually gated the delete, not only the question shown.
		run_diamond_tool(diaId, attached, readOnly, tool, argsJson) {
			runCalls.push({ tool: String(tool), args: JSON.parse(argsJson) });
			return Promise.resolve(JSON.stringify({ outcome: 'done' }));
		},
	};
	const win = {
		DaimondCore: {
			diamondApp: () => engine,
			confirm(msg, okLabel, opts) {
				asked.push({ msg, okLabel, opts });
				return Promise.resolve(!!answer);
			},
		},
		DaimondDiamond: { bounds: async () => ({ attached: [], read_only: [] }) },
		// Echoes the key inside the string, so a test can tell WHICH key a call
		// asked for without a translated table. `tOr` takes this as "translated"
		// (it differs from the bare key) and returns it as-is.
		DaimondI18n: { t: (k) => 'T:' + k },
	};
	win.window = win;

	const src = readFileSync(join(HERE, 'versions.js'), 'utf8');
	const fn = new Function('window', 'with (window) {\n' + src + '\n}');
	fn(win);

	return { win, asked, runCalls, V: () => win.DaimondVersions };
}

async function main() {
	console.log('undogone: a whole-version Restore asks through versions.gone_ask');
	{
		const tab = makeTab(false);
		await tab.V().restore('dia-1', 3, { ask: false });
		check('asked exactly once', tab.asked.length === 1, JSON.stringify(tab.asked.length));
		check('through versions.gone_ask, not the Undo key',
			tab.asked[0] && tab.asked[0].msg === 'T:versions.gone_ask', JSON.stringify(tab.asked[0]));
		check('a no takes nothing (the delete door never ran)', tab.runCalls.length === 0,
			JSON.stringify(tab.runCalls));
	}

	console.log('\nundogone: the toast\'s Undo asks through its OWN key, not the Restore\'s');
	{
		const tab = makeTab(false);
		await tab.V().undoVersion('dia-1', 3, ['x.md']);
		check('asked exactly once', tab.asked.length === 1, JSON.stringify(tab.asked.length));
		check('through versions.undo_gone_ask',
			tab.asked[0] && tab.asked[0].msg === 'T:versions.undo_gone_ask', JSON.stringify(tab.asked[0]));
		check('never the Restore\'s versions.gone_ask',
			tab.asked[0] && tab.asked[0].msg !== 'T:versions.gone_ask', JSON.stringify(tab.asked[0]));
		check('a no takes nothing (the delete door never ran)', tab.runCalls.length === 0,
			JSON.stringify(tab.runCalls));
	}

	console.log('\nundogone: a turn\'s Undo (offerTurnUndo\'s own door) is the same call, so it too gets its own key');
	{
		// `offerTurnUndo` (daimond.js) and the restore toast's Undo both call
		// `DaimondVersions.undoVersion` -- there is only one Undo door in
		// versions.js, so proving it here proves both callers.
		const tab = makeTab(true);
		const res = await tab.V().undoVersion('dia-1', 5, ['x.md']);
		check('through versions.undo_gone_ask',
			tab.asked[0] && tab.asked[0].msg === 'T:versions.undo_gone_ask', JSON.stringify(tab.asked[0]));
		check('the shared title and buttons are unchanged (only the sentence differs)',
			tab.asked[0] && tab.asked[0].opts
				&& tab.asked[0].opts.title === 'T:versions.gone_title'
				&& tab.asked[0].okLabel === 'T:versions.gone_allow'
				&& tab.asked[0].opts.cancelLabel === 'T:versions.gone_keep'
				&& tab.asked[0].opts.ask === 'restore-gone',
			JSON.stringify(tab.asked[0] && tab.asked[0].opts));
		check('a yes takes the file: the delete door ran, on this path',
			tab.runCalls.length === 1 && tab.runCalls[0].tool === 'file_delete'
				&& tab.runCalls[0].args.path === 'x.md',
			JSON.stringify(tab.runCalls));
		check('and the engine reports it restored', !!res, JSON.stringify(res));
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	process.exit(failures > 0 ? 1 : 0);
}

await main();
