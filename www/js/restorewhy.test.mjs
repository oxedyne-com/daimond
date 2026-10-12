/* ============================================================
   Test — a refused restore's `why` is the person's sentence
   (www/js/versions.js `restoreAt`, hist-safe U3, 2026-10-12).
   ------------------------------------------------------------
   The engine refuses with its whole error chain: ANSI colour,
   source frames and error kinds. The dialog put the shared
   `DaimondCore.plainError` sentence to him, but the outcome the
   API returned (`{ outcome: 'refused', why }`) carried the raw
   chain, so any caller showing `why` showed escape codes.

   Drives the REAL versions.js in a simulated tab with a fake
   engine that throws such a chain at each of the three places a
   restore can be refused: the open, the hold and the close. The
   stub `plainError` marks what it made, so the test proves the
   SHARED function made `why`, and that no escape code is left.
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

const RAW = '\u001b[31mError\u001b[0m: \u001b[1m[IO Busy]\u001b[0m src/wasm/diamond.rs:5190: the store is held by another tab';
const plainError = (raw) => 'P:' + String(raw).replace(/\u001b\[[0-9;]*m/g, '').replace(/src\/[^\s:]+\.rs:\d+:?/g, '').trim();

/// One simulated tab whose engine throws `RAW` at `at` ('open', 'hold' or 'close').
function makeTab(at) {
	const asked = [];
	const boom = () => Promise.reject(new Error(RAW));
	const engine = {
		versions_list: () => '[]',
		versions_restore_open: at === 'open' ? boom : async () => JSON.stringify({
			ticket: 't1',
			machine: [{ path: 'x.md', hash: 'h1' }],
		}),
		versions_restore_hold: at === 'hold' ? boom : async () => '{}',
		versions_restore_close: at === 'close' ? boom : async () => JSON.stringify(
			{ version: 1, recorded: 1, restored: [], missing: [], refused: [] }),
		versions_restore_end: async () => '{}',
		run_diamond_tool() {
			// The engine answers an object, not JSON text (versions.js reads r.outcome).
			return Promise.resolve(at === 'write' ? { outcome: 'failed', text: RAW } : { outcome: 'done' });
		},
	};
	const win = {
		DaimondCore: {
			diamondApp: () => engine,
			plainError,
			// Leave it: every Try again is answered no.
			confirm(msg, okLabel, opts) { asked.push({ msg, opts }); return Promise.resolve(false); },
		},
		DaimondDiamond: { bounds: async () => ({ attached: [], read_only: [] }) },
		DaimondI18n: { t: (k) => 'T:' + k },
	};
	win.window = win;
	win.addEventListener = () => {};
	const src = readFileSync(join(HERE, 'versions.js'), 'utf8');
	new Function('window', 'with (window) {\n' + src + '\n}')(win);
	return { asked, V: () => win.DaimondVersions };
}

async function main() {
	for (const at of ['open', 'hold', 'close']) {
		console.log('\nrestorewhy: refused at the ' + at);
		const tab = makeTab(at);
		const res = await tab.V().restore('dia-1', 3, { ask: false });
		check('refused', res && res.outcome === 'refused', JSON.stringify(res));
		check('why carries no escape code', res && !/\u001b/.test(String(res.why)), JSON.stringify(res && res.why));
		check('why is the shared plainError sentence', res && res.why === plainError(RAW), JSON.stringify(res && res.why));
		const retry = tab.asked.filter((a) => a.opts && a.opts.ask === 'restore-retry');
		check('any Try again put to him is that sentence too',
			retry.every((a) => a.msg === plainError(RAW)), JSON.stringify(retry.map((a) => a.msg)));
	}
	// A file the hand failed to write: the restore lands, and that file's row says why.
	console.log('\nrestorewhy: one file refused by the hand that writes it');
	{
		const tab = makeTab('write');
		const res = await tab.V().restore('dia-1', 3, { ask: false });
		const row = res && (res.refused || []).find((r) => r.path === 'x.md');
		check('restored, with x.md refused', res && res.outcome === 'restored' && !!row, JSON.stringify(res));
		check('its why is the shared plainError sentence', row && row.why === plainError(RAW), JSON.stringify(row));
		check('no escape code anywhere in the row', row && !Object.values(row).some((v) => /\u001b/.test(String(v))), JSON.stringify(row));
	}
	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	process.exit(failures > 0 ? 1 : 0);
}

await main();
