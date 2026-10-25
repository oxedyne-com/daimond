/* ============================================================
   Test -- his words log rides only to a runner that stages it home (CCP4-U2ABI, qa-ccp4-a LOW).
   ------------------------------------------------------------
   A runner below `words_abi` ignores `seed.words` and files nothing, so a page that sends it
   the whole log only grows the errand towards the reference rung. The page reads the drawn
   runner's ABI from its presence row, as the offer rule reads it, and sends the log only to
   a runner at `words_abi` or above.

   WHAT IS CHECKED, over the REAL peer.js and the REAL daimond.js functions lifted by source:
     (a) takesWords: an in-range runner at words_abi or above, and no other record;
     (b) a wasm with no words_abi takes none;
     (c) errandWordsFor reads the log for such a runner, and for any other reads none;
     (d) wasmWordsAbi reads the wasm's export, 0 for a build without one or a malformed one;
     (e) the dispatch seeds its words through errandWordsFor, for the runner it addresses.

   Run:  node www/js/u2abiwords.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  (' + JSON.stringify(detail) + ')')); }
}

/// The index just past the brace that closes the one at `open`.
function balanced(src, open) {
	let depth = 0, i = open;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
	}
	return i;
}
/// The source of `[async] function name(...) {...}`, or null.
function lift(src, name) {
	const m = new RegExp('\\n\\t(async )?function ' + name + '\\(').exec(src);
	if (!m) return null;
	return src.slice(m.index + 1, balanced(src, src.indexOf('{', m.index)));
}

// ── The real peer.js ──
const pw = { addEventListener() {}, dispatchEvent() { return true; } };
{
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(pw, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
}
const P = pw.DaimondPeer;
const SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const runner = (abi, min) => ({ kind: 'runner', abi: abi, abiMin: min });

// (a) An in-range runner at words_abi or above takes his words; no other record does.
{
	const ok = typeof P.takesWords === 'function' && typeof P.setEngineAbi === 'function';
	check('a takesWords is exported beside setEngineAbi', ok);
	if (ok) {
		P.setEngineAbi(2, 1, 2);
		check('a an ABI-2 runner takes them', P.takesWords(runner(2, 1)) === true);
		check('a an ABI-3 runner in range takes them', P.takesWords(runner(3, 2)) === true);
		check('a an ABI-1 runner does not', P.takesWords(runner(1, 1)) === false);
		check('a a legacy runner, naming no ABI, does not', P.takesWords({ kind: 'runner' }) === false);
		check('a a runner out of range does not', P.takesWords(runner(4, 3)) === false);
		check('a a tab does not', P.takesWords({ kind: 'tab', abi: 2 }) === false);
		check('a no record does not', P.takesWords(null) === false && P.takesWords(undefined) === false);
		// (b) A page whose wasm names no words_abi sends none.
		P.setEngineAbi(2, 1);
		check('b a wasm with no words_abi sends none', P.takesWords(runner(2, 1)) === false);
		P.setEngineAbi(2, 1, 2);
	}
}

// (c) errandWordsFor reads the log only for a runner that takes it.
{
	const a = lift(SRC, 'errandWordsFor'), b = lift(SRC, 'errandWords');
	check('c errandWordsFor and errandWords are in daimond.js', !!a && !!b);
	if (a && b) {
		const presence = { R2: runner(2, 1), R1: runner(1, 1), T: { kind: 'tab', abi: 2 } };
		let reads = 0;
		const win = { DaimondPeer: P, DaimondPresence: { snapshot: () => presence } };
		const Wasm = { words_read: async (k) => { reads++; return 'LOG ' + k; } };
		const make = new Function('window', 'DaimondPeer', 'DaimondPresence', 'Wasm', 'diag',
			a + '\n' + b + '\nreturn errandWordsFor;');
		const fn = make(win, win.DaimondPeer, win.DaimondPresence, Wasm, function () {});
		const chat = { id: 'c1' };
		check('c an ABI-2 runner is seeded the log', await fn(chat, 'R2') === 'LOG chat:c1');
		const before = reads;
		const r1 = await fn(chat, 'R1'), rt = await fn(chat, 'T'), rn = await fn(chat, ''), rx = await fn(chat, 'gone');
		check('c an ABI-1 runner, a tab, none and an unknown one are seeded none',
			r1 === undefined && rt === undefined && rn === undefined && rx === undefined, [r1, rt, rn, rx]);
		check('c and the log is not read for them', reads === before, reads - before);
		const dia = await fn({ id: 'c2', diamondId: 'd-9' }, 'R2');
		check('c a Diamond chat is keyed by its Diamond', dia === 'LOG d-9', dia);
	}
}

// (d) wasmWordsAbi reads the export.
{
	const a = lift(SRC, 'wasmWordsAbi');
	check('d wasmWordsAbi is in daimond.js', !!a);
	if (a) {
		const fn = new Function(a + '\nreturn wasmWordsAbi;')();
		check('d words_abi() is read', fn({ words_abi: () => 2 }) === 2);
		check('d a wasm without it is 0', fn({}) === 0 && fn(null) === 0);
		check('d a malformed one is 0', [() => 'x', () => 1.5, () => -1, () => 0, () => { throw new Error('x'); }]
			.every((f) => fn({ words_abi: f }) === 0));
	}
}

// (e) The dispatch seeds its words through the gate, for the runner it addresses.
{
	check('e the dispatch seeds words by errandWordsFor(chat, runTo)',
		/dispatchOpts\.words\s*=\s*await errandWordsFor\(chat, runTo\);/.test(SRC)
		&& !/dispatchOpts\.words\s*=\s*await errandWords\(/.test(SRC));
	check('e the page hands the peer its wasm\'s words_abi',
		/DaimondPeer\.setEngineAbi\(ab\[0\], ab\[1\], wasmWordsAbi\(Wasm\)\)/.test(SRC));
}

console.log((failures ? 'FAIL' : 'PASS') + ' u2abiwords ' + (checks - failures) + '/' + checks);
process.exit(failures ? 1 : 0);
