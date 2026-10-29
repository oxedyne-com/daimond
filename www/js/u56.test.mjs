/* ============================================================
   Test: UNBLOCK-56 and UNBLOCK-57.

     FILES   a runner turn's Files row (`<run>-files`) is stamped past every row of its turn but
             the end, so the (ts, mid) merge keeps it under the answer when the runner stamped its
             end a millisecond after the answer (`-files` sorts before `-final` on a tie);
     RESULT  a result tile (`ctile-result`, the Files list) never rolls into the steps group;
     PAST    a finished turn's provenance tile says "Ran on {name}", not "{name} is on it";
     NATIVE  a native runner's row is never busy by the tabs' depth the gateway sums into it.

   Run:  node www/js/u56.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
function extractFn(src, name) {
	let start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) return '';
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}
const src  = readPage(join(HERE, 'daimond.js'), 'utf8');
const psrc = readPage(join(HERE, 'peer.js'), 'utf8');
const en   = readPage(join(HERE, '..', 'i18n', 'en.js'), 'utf8');

// FILES: the row as the Diamond keeper's road makes it, then the merge's own order.
{
	const make = new Function('DaimondProvenance', 'turnFileProds', 'turnFileList', 'carriedProdBase',
		extractFn(src, 'carriedFilesRow') + '\nreturn carriedFilesRow;')(
		{ h: { file: () => 'h' } }, async () => [{ p: 1 }], async () => [{ path: 'a.md' }], () => '');
	// mergeMessages' order: by ts, then mid by code point.
	const order = (ms) => ms.slice().sort((x, y) => ((x.ts || 0) - (y.ts || 0)) || (x.mid < y.mid ? -1 : x.mid > y.mid ? 1 : 0));
	const T = 'T1', R = 'e-R';
	const chat = { messages: [
		{ role: 'user', mid: T, content: 'Chose: Apply', ts: 100 },
		{ role: 'think_log', mid: R + '-t0', iturn: T, ts: 200 },
		{ role: 'assistant', mid: R + '-final', iturn: T, content: 'done', ts: 300 },
		{ role: 'end_log', mid: R + '-end', iturn: T, ts: 301 },
	] };
	const row = await make(chat, { keeper: 'd1', turnId: T, run: R, ts: 299, files: [] },
		{ version: 3, note: { role: 'user', content: '[Daimond: this turn changed 1 file (v3): a.md. The user can restore' } });
	check('FILES: the row was made', !!row && row.mid === R + '-files');
	const local = chat.messages.map((m) => m.mid);
	const merged = order(chat.messages).map((m) => m.mid);
	check('FILES: under the answer, here', local.indexOf(R + '-files') > local.indexOf(R + '-final'), local.join());
	check('FILES: and after a merge', merged.indexOf(R + '-files') > merged.indexOf(R + '-final'), merged.join());
	check('FILES: the merge keeps the order drawn', merged.join() === local.join(), merged.join() + ' vs ' + local.join());
}

// RESULT: postToChat's roll-up skips a result tile.
{
	const f = extractFn(src, 'postToChat');
	check('RESULT: a result tile never joins a roll-up', /var cls = [^;]*!node\.classList\.contains\('ctile-result'\)[^;]*TILE_ROLL/.test(f));
}

// PAST: the provenance and an ended hand-off tile's header.
{
	check('PAST: en says "Ran on {name}"', /'chat\.ran_on':\s*'Ran on \{name\}'/.test(en));
	check('PAST: no tile says "{name} is on it"', !/chat\.handed_off/.test(src) && !/is on it'/.test(en));
}

// NATIVE: recBusy, the real one.
{
	const recBusy = new Function(extractFn(psrc, 'busyDepth') + extractFn(psrc, 'busyForRec') + extractFn(psrc, 'recBusy') + '\nreturn recBusy;')();
	check('NATIVE: a native runner row with a busy tab is not busy',
		!recBusy({ kind: 'runner', busy: 1, busyChats: ['other'] }, 'r1', { chatId: 'mine' }));
	check('NATIVE: a browser device busy with another chat still is',
		recBusy({ busy: 1, busyChats: ['other'] }, 'd1', { chatId: 'mine' }));
}

if (failures) { console.log('\n' + failures + ' FAIL'); process.exit(1); }
console.log('\nall pass');
