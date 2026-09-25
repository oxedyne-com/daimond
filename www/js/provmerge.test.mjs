/* ============================================================
   Test — a streamed copy never outlives the real one (mergeMessages).
   ------------------------------------------------------------
   A handed-off turn's final frame is folded on the sending device as
   PROVISIONAL rows carrying the mids the runner pushes, and the frame's
   copy of the answer is byte-identical to the one the runner's parcel
   brings. `mergeMessages` kept the first copy of a mid unless a later
   one was strictly longer, so a device that drew the frame before the
   parcel landed kept the provisional answer for good: the placeholder
   never dropped, and nothing that asks for a real answer found one
   (gateway r5 §6; slowparcel CASE 1 with the progress tap, 2026-09-25).

   Lifts the REAL `stampMessages`, `unbadge` and `mergeMessages` out of
   daimond.js and asserts that the real copy wins in either order, and
   that nothing else about the union moved.
     node www/js/provmerge.test.mjs      # ALL PASS
   On 82a0e52f's daimond.js: 1, 3 and 5 fail.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

/// Lifts `function name(...) { ... }` out of `src` by counting braces.
function extractFn(src, name) {
	const start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) throw new Error('function not found in daimond.js: ' + name);
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

const src = readFileSync(process.env.DAIMOND_JS || join(HERE, 'daimond.js'), 'utf8');
const lifted = [
	'var OLD_LEGACY = /^legacy-\\d+$/;',
	'function loadMsgTombs() { return {}; }',
	extractFn(src, 'stampMessages'),
	extractFn(src, 'unbadge'),
	extractFn(src, 'mergeMessages'),
	'return mergeMessages;',
].join('\n');
const mergeMessages = new Function(lifted)();

const user  = () => ({ mid: 'u1', role: 'user', content: 'what is three plus three', ts: 10 });
const place = () => ({ mid: 'p1', role: 'assistant', content: '', why: 'dispatched', iturn: 'u1', ts: 11 });
const real  = () => ({ mid: 'a1', role: 'assistant', content: 'six', ts: 12, ranOn: 'b' });
const prov  = () => ({ mid: 'a1', role: 'assistant', content: 'six', ts: 12, ranOn: 'b', iturn: 'u1', provisional: 1 });
const find  = (out, mid) => out.filter((m) => m.mid === mid);

console.log('\nthe final frame first, the parcel after\n');
{
	const out = mergeMessages([user(), place(), prov()], [user(), real()], 'c1', {});
	const a = find(out, 'a1');
	check('1. the parcel\'s real copy replaces the provisional one of the same mid',
		a.length === 1 && !a[0].provisional, JSON.stringify(a));
}
{
	const out = mergeMessages([user(), real()], [user(), place(), prov()], 'c1', {});
	const a = find(out, 'a1');
	check('2. and in the other order the real copy stays',
		a.length === 1 && !a[0].provisional, JSON.stringify(a));
}
{
	const shorter = Object.assign(real(), { content: 'si' });
	const out = mergeMessages([user(), prov()], [user(), shorter], 'c1', {});
	const a = find(out, 'a1');
	check('3. a real copy wins even where the streamed one is longer',
		a.length === 1 && !a[0].provisional && a[0].content === 'si', JSON.stringify(a));
}

console.log('\nnothing else about the union moved\n');
{
	const grown = Object.assign(prov(), { content: 'six, because three and three' });
	const out = mergeMessages([user(), prov()], [user(), grown], 'c1', {});
	const a = find(out, 'a1');
	check('4. two streamed copies still converge on the longer (prefix growth)',
		a.length === 1 && a[0].content === grown.content && a[0].provisional === 1, JSON.stringify(a));
}
{
	const out = mergeMessages([user(), place(), prov()], [user(), real()], 'c1', {});
	check('5. the union keeps every mid once, in time order',
		out.map((m) => m.mid).join() === 'u1,p1,a1' && !out[2].provisional, out.map((m) => m.mid + (m.provisional ? '*' : '')).join());
}
{
	const out = mergeMessages([user(), prov()], [user(), real()], 'c1', { a1: 1 });
	check('6. a tombstoned mid stays gone whichever copy arrives', find(out, 'a1').length === 0);
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PASS');
process.exit(failures ? 1 : 0);
