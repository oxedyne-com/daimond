// trashdamaged.test.mjs -- a trash record that is there but is not a trash
// record is DAMAGED, never empty, and is never written over (HIST-SAFE U2,
// QA A F2). The engine's `marks::trashed_ids` reads the same text as UNREAD.
//
//   node www/js/trashdamaged.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

const m = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
	getItem: (k) => (m.has(k) ? m.get(k) : null),
	setItem: (k, v) => { m.set(k, String(v)); },
	removeItem: (k) => { m.delete(k); },
};
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener: () => {}, getElementById: () => null };
for (const f of ['store.js', 'trash.js']) new Function(readFileSync(join(HERE, f), 'utf8'))();
const T = window.DaimondTrash;
const KEY = 'daimond-trash';
const dmg = () => (typeof T.damaged === 'function' ? T.damaged() : 'no damaged()');
const rst = () => (typeof T.resetDamaged === 'function' ? T.resetDamaged() : 'no resetDamaged()');
const fresh = (text) => { if (text === null) m.delete(KEY); else m.set(KEY, text); T.reset(); };

// ── Absent and well-formed read as before ──────────────────────────
fresh(null);
check('absent: not damaged', dmg() === false);
check('absent: a put lands', T.put('aa', 'diamond') === true && T.has('aa'));
fresh('{}');
check('`{}` is an empty trash, not damaged', dmg() === false && T.ids().length === 0);

// ── Damaged: every shape the engine refuses ────────────────────────
for (const bad of ['{"items":{', 'null', '[]', '{"items":[]}', '{"items":7}', '{"items":null}']) {
	fresh(bad);
	check(`${bad}: damaged`, dmg() === true);
	check(`${bad}: a put is refused`, T.put('bb', 'diamond') === false && !T.has('bb'));
	check(`${bad}: left as it is`, m.get(KEY) === bad, m.get(KEY));
	let threw = false;
	try { T.adopt({ v: 1, items: { cc: { k: 'd', at: 5, back: 0, r: 30 } } }); } catch (e) { threw = true; }
	check(`${bad}: a parcel is not adopted over it`, threw && m.get(KEY) === bad, m.get(KEY));
}

// ── A malformed ENTRY damages the record too (PATHTYPE) ────────────
// `at` as a string, the entry a bare word: the engine's `trashed_ids` reads
// these as UNREAD; dropping the entry here read a trashed Diamond as live.
for (const bad of ['{"v":1,"items":{"aa":{"k":"d","at":"5","back":0}}}',
	'{"v":1,"items":{"aa":"trashed"}}', '{"v":1,"items":{"aa":{"k":"d","at":5,"back":null}}}',
	'{"v":1,"items":{"aa":[5]}}']) {
	fresh(bad);
	check(`${bad}: damaged`, dmg() === true);
	check(`${bad}: a put is refused`, T.put('bb', 'diamond') === false && m.get(KEY) === bad, m.get(KEY));
}
fresh('{"v":1,"items":{"aa":{"k":"d","at":5}}}');
check('an absent `back` is a Diamond never restored, not damage', dmg() === false && T.has('aa'));

// ── The explicit reset is the one way out ──────────────────────────
fresh('{"items":{');
check('resetDamaged writes an empty record', rst() === true && dmg() === false
	&& JSON.parse(m.get(KEY)).items && Object.keys(JSON.parse(m.get(KEY)).items).length === 0, m.get(KEY));
fresh('{"v":1,"items":{"aa":{"k":"d","at":5,"back":0,"a":0,"r":30}}}');
check('resetDamaged refuses a record that is not damaged', rst() === false && T.has('aa'));

console.log(`\n${checks - failures}/${checks} ok${failures ? `, ${failures} FAIL` : ''}`);
process.exit(failures ? 1 : 0);
