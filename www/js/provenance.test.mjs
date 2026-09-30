/* ============================================================
   Test — product provenance (provenance.js) and the catalogue's
   families and classes (pricing.js), against the REAL sources.
   ------------------------------------------------------------
   U1 of the per-product rating design. Claims:

     (a) A rating files by `resolveExact` ONLY. A neighbour the id
         merely contains (`glm-5.3` in `glm-5`'s entry) is an unknown
         model with a guessed family, never the neighbour.
     (b) Every table entry has a family and a class from the list.
     (c) `stamp` is a function of its facts: the same facts give the
         same bytes, which is what a streamed copy and its final copy
         are compared on.
     (d) Handles are the strings src/rating.rs parses.
     (e) The tool path and the length are derived, not stamped.

   Run:  node www/js/provenance.test.mjs
         node www/js/provenance.test.mjs --break near   # identify uses resolve
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BREAK = process.argv.includes('--break') ? process.argv[process.argv.indexOf('--break') + 1] : '';
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const win = {};
let pricing = readFileSync(join(HERE, 'pricing.js'), 'utf8');
if (BREAK === 'near') {
	pricing = pricing.replace('var id = key ? INDEX[key] : null;',
		'var id = key ? (INDEX[key] || (function(){ for (var i=0;i<KEYS.length;i++) if (key.indexOf(KEYS[i])!==-1) return INDEX[KEYS[i]]; return null; })()) : null;');
}
new Function('window', pricing)(win);
new Function('window', readFileSync(join(HERE, 'provenance.js'), 'utf8'))(win);
const P = win.DaimondPricing, V = win.DaimondProvenance;

// (a) resolveExact only.
const exact = P.identify('accounts/fireworks/models/glm-5p2');
check('a router spelling files under the canonical id',
	exact.cm === 'glm-5.2' && exact.fam === 'glm-5' && exact.cls === 'open-frontier' && !exact.fi,
	JSON.stringify(exact));
check('the canonical id and its alias agree', JSON.stringify(P.identify('z-ai/glm-5.2')) === JSON.stringify(exact));
const near = P.identify('z-ai/glm-5.3');
check('a neighbour the id contains is NOT the neighbour',
	near.cm === 'glm-5.3' && near.cls === 'unknown' && near.fi === 1 && near.fam === 'glm-5',
	JSON.stringify(near));
check('a dated id the table lacks keeps its spelling and loses the date from its family',
	(function () { const d = P.identify('anthropic/claude-opus-5-20261001');
		return d.cm === 'claude-opus-5-20261001' && d.fam === 'claude-opus-5' && d.cls === 'unknown'; })(),
	JSON.stringify(P.identify('anthropic/claude-opus-5-20261001')));
check('a minor version after a dash is stripped for the family',
	P.identify('claude-opus-4-9').fam === 'claude-opus-4', JSON.stringify(P.identify('claude-opus-4-9')));
check('a provider spelling of an unknown model is read as a person writes it',
	P.identify('accounts/x/models/foo-2p1').cm === 'foo-2.1');
check('an unversioned unknown model is its own family', P.identify('mystery').fam === 'mystery');

// (b) every entry.
const T = P._core.TABLE, C = P._core.CLASSES;
const unfiled = Object.keys(T).filter(k => !T[k].fam || C.indexOf(T[k].cls) < 0);
check('every table entry has a family and a listed class', unfiled.length === 0, unfiled.join(','));
check('the classes are the seven of §5.3',
	C.join(',') === 'frontier,fast,open-frontier,open-fast,reasoning,coder,vision');

// (c) stamp.
const facts = { h: V.h.answer('cabc', 'm2'), k: 'answer', m: 'accounts/fireworks/models/glm-5p2',
	pv: 'fireworks', role: 'daimon', sp: 'sp1:3f9a0c12', d: 'd-1', c: 'cabc', t: 'm1', dev: 'dev-a',
	at: 1790000000000 };
const one = V.stamp(facts), two = V.stamp(Object.assign({}, facts));
check('the same facts stamp the same bytes', JSON.stringify(one) === JSON.stringify(two));
check('the record is the design\'s, in its order',
	Object.keys(one).join(',') === 'h,k,m,pv,cm,fam,fi,cls,role,sp,d,c,t,dev,at,hash,run' && one.fi === false
	&& one.hash === '' && one.run === '', Object.keys(one).join(','));
check('the record names the model as sent and as catalogued',
	one.m === facts.m && one.cm === 'glm-5.2' && one.cls === 'open-frontier');
const guessed = V.stamp(Object.assign({}, facts, { m: 'glm-5.3' }));
check('a guessed family says so, beside the family',
	Object.keys(guessed).join(',') === Object.keys(one).join(',') && guessed.fi === true);
const row = V.stamp(Object.assign({}, facts, { h: V.h.file('d-1', 4, 'a.md'), k: 'file', role: 'worker',
	hash: 'ab'.repeat(32), run: 'w-mfz3-1-abcde' }));
check('a file row carries its content hash and its worker, last',
	Object.keys(row).slice(-3).join(',') === 'at,hash,run' && row.hash.length === 64);
check('a record is recognised, and a bare object is not', V.isProd(one) && !V.isProd({ k: 'answer' }));
const prop = V.rekind(one, 'proposal', V.h.proposal('p-1'));
check('a proposal keeps its answer\'s provenance under its own handle',
	prop.h === 'p1:proposal:p-1' && prop.k === 'proposal' && prop.m === one.m && one.k === 'answer'
	&& Object.keys(prop).join(',') === Object.keys(one).join(','));

// (d) the strings src/rating.rs test_every_handle_round_trips_00 holds.
const pairs = [
	[V.h.answer('cmfz3-1-abcde', 'mfz3-2-fghij'),	'p1:answer:cmfz3-1-abcde/mfz3-2-fghij'],
	[V.h.file('chat:cabc', 3, 'notes/v2/a b.md'),	'p1:file:chat:cabc/v3/notes/v2/a b.md'],
	[V.h.crystal('d-thesis', 41),			'p1:crystal:d-thesis/v41'],
	[V.h.fold('cabc', 'mfz3-9-zzzzz'),		'p1:crystal:cabc/mfz3-9-zzzzz'],
	[V.h.worker('w-7'),				'p1:worker:w-7'],
	[V.h.mail('mail/drafts/2026/x.eml'),		'p1:mail:mail/drafts/2026/x.eml'],
	[V.h.proposal('p-1'),				'p1:proposal:p-1'],
];
check('every handle is the grammar src/rating.rs parses', pairs.every(p => p[0] === p[1]),
	pairs.filter(p => p[0] !== p[1]).map(p => p[0]).join(' | '));

// (e) derived.
const msgs = [
	{ role: 'user', mid: 'u0', content: 'before' },
	{ role: 'tool_log', mid: 'x', name: 'file_list' },
	{ role: 'assistant', mid: 'a0', content: 'old' },
	{ role: 'user', mid: 'u1', content: 'go' },
	{ role: 'tool_log', mid: 't1', name: 'file_read' },
	{ role: 'tool_log', mid: 't2', name: 'file_read' },
	{ role: 'tool_log', mid: 't3', name: 'file_edit' },
	{ role: 'user', mid: 'i1', content: 'and the tests', interjected: 1 },
	{ role: 'tool_log', mid: 't4', name: 'file_read' },
	{ role: 'assistant', mid: 'a1', content: 'done' },
	{ role: 'user', mid: 'u2', content: 'next' },
	{ role: 'tool_log', mid: 't5', name: 'run' },
];
check('the tool path runs from the turn to its answer, runs collapsed',
	V.toolPath(msgs, 'u1', 'a1').join(',') === 'file_read,file_edit,file_read', V.toolPath(msgs, 'u1', 'a1').join(','));
check('with no answer it stops at the next turn', V.toolPath(msgs, 'u2').join(',') === 'run');
check('a turn not in the transcript has no path', V.toolPath(msgs, 'nope', 'a1').length === 0);
check('length counts what a reader counts', V.lenOf('café \u{1F600}') === 6 && V.lenOf(null) === 0);

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures) process.exit(1);
