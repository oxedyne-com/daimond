/* ============================================================
   Test — UNBLOCK-32 F2a: the native runner's beat says it holds
   the folder, so a task that needs the folder seats it, and one
   that needs the hand does not (www/js/peer.js `placeTask`).
   ------------------------------------------------------------
   The gateway half (runner_pair.rs, R2f) asserts the native
   beat's `folder: Some(true)` and `hand: None`. This is the
   reading half: a native presence row as that beat makes it,
   `{ kind:'runner', native:true, runner:true, folder:true }`,
   listening and on a matching engine, is elected for a turn whose
   folder is rooted on the asker (`require:'folder'`) but never for a
   compile (F2-FIX M2: it serves none), and a publish (`n.hand`) stays nobody,
   because `hand` was left out (it would change placeTask's
   outcome for every hand task).

   Run:    node www/js/f2native.test.mjs
   Break:  node www/js/f2native.test.mjs --break nofolder
           (the row as the base's beat made it, no `folder`): red.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? String(process.argv[i + 1] || '') : ''; })();
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); return; }
	failures++;
	console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
}

const PEER = readFileSync(join(HERE, 'peer.js'), 'utf8');
const win = { addEventListener() {}, dispatchEvent() { return true; },
	localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
const document = { readyState: 'complete', addEventListener() {}, querySelector() { return null; }, getElementById() { return null; } };
new Function('window', 'document', 'with (window) {\n' + PEER + '\n}')(win, document);
const P = win.DaimondPeer;

const NOW = 1_800_000_000_000;
const row = { kind: 'runner', native: true, runner: true, listening: true, name: 'argonaut',
	lastSeen: NOW - 1000, engine: 'eng-1', folder: true };
if (BREAK === 'nofolder') delete row.folder;
const presence = { 'dev-native': row };
const opts = { selfId: 'dev-phone', provider: 'credits', engineId: 'eng-1', roster: [] };
const ledger = { deviceId: 'dev-phone', files: { missing: ['a.typ'] }, budgetMB: 100, heapMB: 0 };

// F2-FIX M2: the folder does not make a compile server. Kimberlite has none, so a compile that
// needs the folder never seats the native runner (it would never take it); a tab holding the
// folder still does.
const compile = P.placeTask({ kind: 'compile' }, ledger, presence, opts, NOW);
check('M2 a compile that needs the folder does not seat the native runner',
	compile.where === 'nobody' && compile.deviceId !== 'dev-native', JSON.stringify(compile));
const tabRow = { kind: 'tab', runner: true, listening: true, name: 'laptop', lastSeen: NOW - 1000, folder: true };
const compileTab = P.placeTask({ kind: 'compile' }, ledger, { 'dev-native': row, 'dev-tab': tabRow }, opts, NOW);
check('M2 a compile still seats a tab that holds the folder',
	compileTab.where === 'runner' && compileTab.deviceId === 'dev-tab', JSON.stringify(compileTab));
const turnSeat = P.handoffTarget(presence, { selfId: 'dev-phone', provider: 'credits', engineId: 'eng-1', require: 'folder' }, NOW);
check('a turn whose folder is rooted on the asker seats the native runner (F2a)',
	!!turnSeat.target && turnSeat.target.deviceId === 'dev-native', JSON.stringify(turnSeat.target || null));

const publish = P.placeTask({ kind: 'publish', hand: true }, { deviceId: 'dev-phone' }, presence, opts, NOW);
check('a hand task does not seat it (hand left out of the beat)',
	publish.where === 'nobody', JSON.stringify(publish));

check('scopeHolds reads the array and the { root, holds } scope',
	JSON.stringify(P.scopeHolds(['a'])) === '["a"]'
	&& JSON.stringify(P.scopeHolds({ root: 'usr', holds: ['b'] })) === '["b"]'
	&& JSON.stringify(P.scopeHolds(null)) === '[]');
check("makeReport keeps the 'place' cause",
	P.makeReport({ eid: 'e', turnId: 't', status: 'undeliverable', cause: 'place' }).cause === 'place');

// ── F2-FIX M1: errandScope sends the folder exactly where chatNeedsFolder needs one ──
// Lifted from daimond.js with the switch's own predicate: a plain chat (no diamondId) whose
// workspace holding is opened in the folder carries `scope.root` as a Diamond's turn does.
const DSRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
function lift(name) {
	let a = DSRC.indexOf('\n\tfunction ' + name + '(');
	if (a < 0) throw new Error('not found: ' + name);
	return DSRC.slice(a, DSRC.indexOf('\n\t}\n', a) + 3);
}
const rooted = { 'plain-ws': 1, 'dia-chat': 1 };
const dwin = {
	DaimondMarksHere: {
		rootedHere: (dia, chatId, root) => root === 'fid-usr' && !!rooted[chatId],
		_core: { rootOf: (root) => root === 'fid-usr' ? { kind: 'machine', fid: 'fid-usr', name: 'usr' } : { kind: 'store' } },
	},
};
const scopeOf = new Function('window', 'with (window) {\n'
	+ 'var DaimondMarksHere = window.DaimondMarksHere;\n'
	+ 'function rootHere() { return "fid-usr"; }\n'
	+ 'function selfHoldsFolder() { return true; }\n'
	+ 'function diag() {}\n'
	+ 'function diamondFolder() { return ""; }\n'		// no Diamond names its own (HATE-7)
	+ lift('chatNeedsFolder') + lift('errandScope')
	+ '\nreturn errandScope;\n}')(dwin);
const plain = scopeOf({ id: 'plain-ws' }, ['a']);
check('M1 a plain chat whose workspace is rooted in the folder sends scope.root',
	!!plain && plain.root === 'usr' && JSON.stringify(plain.holds) === '["a"]', JSON.stringify(plain));
const dia = scopeOf({ id: 'dia-chat', diamondId: 'd1' }, ['b']);
check("M1 a Diamond's rooted chat still sends scope.root",
	!!dia && dia.root === 'usr', JSON.stringify(dia));
const loose = scopeOf({ id: 'elsewhere' }, ['c']);
check('M1 a chat not rooted here sends the plain holds',
	Array.isArray(loose) && loose[0] === 'c', JSON.stringify(loose));

console.log((failures ? 'FAIL' : 'PASS') + ' f2native: ' + (checks - failures) + '/' + checks);
process.exit(failures ? 1 : 0);
