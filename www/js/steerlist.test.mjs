/* ============================================================
   Test -- THE STEERING LIST AND THE SWITCH REVIEW, PURE (www/js/steering.js), U7c of 5.3.2.
   ------------------------------------------------------------
   Plan: ~/usr/code/ai/claude/specs/daimond_optimiser_532_plan_20261004.md §3 P5, §5 U7c;
   canon §9.5. The REAL provenance.js, ratings.js, ratingroll.js and steering.js are loaded into
   a bare `window`, as steering.test.mjs loads them.

   What is proved here:
     * the list's data: only active notes, grouped (the account first, then each Diamond by
       name), the exact line, the scope, the model, the day the note was added; the same
       whichever order the notes arrived in; one Diamond's view holds its own and the account's;
     * Remove STICKS: a note retired with `retireAt` is not proposed again until 20 more rated
       answers, where one retired with a bare zero would come straight back;
     * P5's trigger: a Switch is recorded as a `switched` entry, and 20 new rated answers on the
       model switched to raise one review, which a Keep or Switch back (a retirement) closes for
       good; and the note file reads and writes the new status byte for byte.

   Run:  node www/js/steerlist.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', '..');
let failures = 0, bad = null;

function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
function kase(name, fn) {
	bad = null;
	try { fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); }
	else { console.log('  ok   ' + name); }
}

const win = {};
for (const f of ['provenance.js', 'ratings.js', 'ratingroll.js', 'steering.js']) {
	new Function('window', readFileSync(join(HERE, f), 'utf8'))(win);
}
const R = win.DaimondRatings, RR = win.DaimondRatingRoll, S = win.DaimondSteering;
const FORM = JSON.parse(readFileSync(join(APP, 'dev', 'fixtures', 'rating_form_daimond1.json'), 'utf8'));
const SIDES = {};
FORM.tags.forEach(t => { SIDES[t.id] = t.side; });
const OPTS = { sides: SIDES };

// ── Builders (as steering.test.mjs) ────────────────────────
const BASE = { h: '', k: 'answer', m: 'accounts/fireworks/models/glm-5p2', pv: 'fireworks', cm: 'glm-5.2', fam: 'glm-5', fi: false,
	cls: 'open-frontier', role: 'chat', sp: 'sp1:3f9a0c12', d: '', c: 'c1', t: 'mfq19-0-abcde', dev: 'd-4f2a', at: 1790000000000,
	hash: '', run: '', via: '' };
let CLOCK = 1790000000000, SEQ = 0;
function tick() { CLOCK += 1000; SEQ++; return CLOCK; }
function pair(o) {
	const mid = 'a' + SEQ + 'x' + (o.c || 'c1');
	const h = 'p1:answer:' + (o.c || 'c1') + '/' + mid;
	const prod = Object.assign({}, BASE, { h: h, c: o.c || 'c1', d: o.d || '' }, ['cm', 'fam', 'cls', 'role', 'pv', 'via'].reduce((a, f) => { if (o[f] !== undefined) a[f] = o[f]; return a; }, {}));
	const ts = o.ts || tick();
	const rec = R.build({ prod: prod, s: o.s, tags: o.tags || [], dims: {}, note: '', src: 'tap', sup: '', burst: '', tools: '', len: 300 });
	const ans = { role: 'assistant', mid: mid, ts: ts - 1, content: 'an answer', prod: [prod] };
	return [ans, R.message(rec, 'r-' + ts.toString(36) + '-' + String(SEQ).padStart(5, '0'), ts)];
}
function chat(specs) { const out = []; specs.forEach(sp => { out.push.apply(out, pair(sp)); }); return out; }
function roll(chats) { return RR.cells(chats.map(m => RR.chatPart(m)), OPTS); }
function mk(g) {
	const out = [], base = { d: g.d || '', c: g.c || 'c1', cm: g.cm, fam: g.fam || 'fam-x', cls: 'frontier' };
	for (let i = 0; i < (g.up || 0); i++) out.push(Object.assign({}, base, { s: 1 }));
	const queue = [];
	Object.keys(g.tags || {}).forEach(t => { for (let i = 0; i < g.tags[t]; i++) queue.push(t); });
	for (let i = 0; i < (g.down || 0); i++) out.push(Object.assign({}, base, { s: -1, tags: queue[i] ? [queue[i]] : [] }));
	return out;
}
function ent(o) { return Object.assign({ id: 'n-1', status: 'active', cm: 'model-a', tag: 'long', level: 3, scope: '', at: { t: 3, n: 12 }, kept: 0, line: 'Keep answers under about 200 words unless asked for detail.', to: '' }, o); }
const idAt = (ms, r) => 'n-' + ms.toString(36) + '-' + (r || 'abcde');
const T1 = 1790000000000, T2 = 1790100000000;

// ── The list's data ────────────────────────────────────────
kase('the module has listing, addedMs and retireAt', () => {
	ok(typeof S.listing === 'function' && typeof S.addedMs === 'function' && typeof S.retireAt === 'function', 'functions');
});

kase('addedMs: the day a note was made is in its own id, and an id that does not say is 0', () => {
	eq(S.addedMs(idAt(T1)), T1);
	eq(S.addedMs('n-1'), 0, 'a short id');
	eq(S.addedMs('r-abc-defgh'), 0, 'not a note id');
	eq(S.addedMs(''), 0);
	eq(S.addedMs(null), 0);
	eq(S.addedMs('n-zzzzzzzzzzzzzz-abcde'), 0, 'out of range');
});

const DIAS = [{ d: 'dB', name: 'Thesis' }, { d: 'dA', name: 'Atlas' }];
const NOTES = [
	ent({ id: idAt(T2, 'bbbbb'), level: 2, scope: 'dB', cm: 'model-a', tag: 'long', line: 'Keep answers short.' }),
	ent({ id: idAt(T1, 'aaaaa'), level: 3, scope: '', cm: 'all', tag: 'tool', line: 'Use a tool only when the task needs one.' }),
	ent({ id: idAt(T1, 'ccccc'), level: 2, scope: 'dA', cm: 'all', tag: 'wrong', line: 'Check facts first.' }),
	ent({ id: idAt(T2, 'ddddd'), level: 2, scope: 'dA', cm: 'model-b', tag: 'style', line: 'Plain tone.' }),
	ent({ id: idAt(T1, 'eeeee'), level: 2, scope: 'dA', status: 'retired', tag: 'slow', line: 'Retired, never listed.' }),
	ent({ id: idAt(T1, 'fffff'), level: 2, scope: 'dB', status: 'dismissed', tag: 'scope', line: '' }),
	ent({ id: idAt(T1, 'ggggg'), level: 2, scope: 'dB', status: 'switched', tag: 'switch', cm: 'model-a', to: 'model-b', line: '' }),
];

kase('listing: only active notes; the account first, then each Diamond by name; the exact line, scope, model and day', () => {
	const g = S.listing(NOTES, { diamonds: DIAS });
	eq(g.map(x => [x.level, x.scope, x.name]), [[3, '', ''], [2, 'dA', 'Atlas'], [2, 'dB', 'Thesis']]);
	eq(g[0].notes, [{ id: idAt(T1, 'aaaaa'), level: 3, scope: '', cm: 'all', tag: 'tool', line: 'Use a tool only when the task needs one.', added: T1 }]);
	eq(g[1].notes.map(n => [n.line, n.cm, n.added]), [['Check facts first.', 'all', T1], ['Plain tone.', 'model-b', T2]], 'by id within a Diamond');
	eq(g[2].notes.map(n => n.line), ['Keep answers short.']);
	const text = JSON.stringify(g);
	ok(text.indexOf('Retired, never listed') < 0 && text.indexOf('switch') < 0, 'a retired, dismissed or switched entry is not a note');
});

kase('listing: one Diamond\'s view holds that Diamond\'s notes and the account\'s, and no other Diamond\'s', () => {
	const g = S.listing(NOTES, { diamonds: DIAS, diamond: 'dB' });
	eq(g.map(x => [x.level, x.scope]), [[3, ''], [2, 'dB']]);
	eq(S.listing(NOTES, { diamonds: DIAS, diamond: 'nope' }).map(x => x.level), [3], 'a Diamond with none still sees the account\'s');
});

kase('listing: nothing active is an empty list, and bad input is too', () => {
	eq(S.listing([], { diamonds: DIAS }), []);
	eq(S.listing([ent({ status: 'retired' }), ent({ status: 'dismissed' })], { diamonds: DIAS }), []);
	eq(S.listing(null, null), []);
	eq(S.listing('x', {}), []);
});

kase('listing: the same whichever order the notes and the Diamonds arrive in', () => {
	eq(JSON.stringify(S.listing(NOTES.slice().reverse(), { diamonds: DIAS.slice().reverse() })), JSON.stringify(S.listing(NOTES, { diamonds: DIAS })));
});

kase('listing: a Diamond the page does not list is named by an empty string, not dropped', () => {
	const g = S.listing([ent({ id: idAt(T1), level: 2, scope: 'gone' })], { diamonds: DIAS });
	eq(g.map(x => [x.scope, x.name, x.notes.length]), [['gone', '', 1]]);
});

// ── Remove sticks ──────────────────────────────────────────
// model-a at the account: 5 up, 20 down, `long` on 8 of the downs, so the cell is trusted and bad and a `long` note is proposed.
function big() { return roll([chat(mk({ cm: 'model-a', up: 5, down: 20, tags: { long: 8 } }))]); }
const ctx = { diamonds: [] };
const noteProps = r => S.proposals(r, [], ctx).filter(p => p.kind === 'note');

kase('retireAt: the tag count and the rated count of the note\'s own cell now', () => {
	const r = big(), c = RR.cell(r, 3, '', 'cm', 'model-a');
	eq(S.retireAt(r, ent({ cm: 'model-a', tag: 'long' })), { t: c.tags.long, n: c.n });
	eq(c.n, 25, 'precondition');
	eq(S.retireAt(r, ent({ cm: 'model-z' })), { t: 0, n: 0 }, 'no cell, no count');
	eq(S.retireAt(null, ent()), { t: 0, n: 0 });
});

kase('retireAt: a note for every model counts from the busiest model at its level', () => {
	const r = roll([chat(mk({ cm: 'model-a', up: 5, down: 20 }).concat(mk({ cm: 'model-b', c: 'c2', up: 3, down: 2 })))]);
	eq(S.retireAt(r, ent({ cm: 'all', tag: 'long' })).n, 25);
});

kase('Remove sticks: the note is not proposed again, and a bare zero would bring it straight back', () => {
	const r = big();
	eq(noteProps(r).length, 1, 'precondition: nothing holds it, so it is proposed');
	const kept = ent({ status: 'retired', tag: noteProps(r)[0].tag, at: S.retireAt(r, ent({ cm: 'model-a', tag: noteProps(r)[0].tag })) });
	eq(S.proposals(r, [kept], ctx).filter(p => p.kind === 'note'), [], 'retired with the count now: held');
	const bare = Object.assign({}, kept, { at: { t: 0, n: 0 } });
	eq(S.proposals(r, [bare], ctx).filter(p => p.kind === 'note').length, 1, 'retired with a bare zero: proposed at once (the fault retireAt prevents)');
});

kase('Remove sticks for 20 more rated answers, then frees', () => {
	const r0 = big(), tag = noteProps(r0)[0].tag;
	const kept = ent({ status: 'retired', tag: tag, at: S.retireAt(r0, ent({ cm: 'model-a', tag: tag })) });
	const more = n => roll([chat(mk({ cm: 'model-a', up: 5, down: 20, tags: { long: 8 } }).concat(mk({ cm: 'model-a', c: 'c2', down: n, tags: { long: n } })))]);
	eq(S.proposals(more(19), [kept], ctx).filter(p => p.kind === 'note').length, 0, '19 more');
	ok(S.proposals(more(20), [kept], ctx).filter(p => p.kind === 'note').length === 1, '20 more');
});

// ── P5: the review of a switch ─────────────────────────────
// Diamond dia1 now runs model-b. A switch to it was recorded when its cell held `n0` rated answers.
const DB = { diamonds: [{ d: 'dia1', name: 'Thesis', cm: 'model-b' }] };
function after(n) { return roll([chat(mk({ d: 'dia1', cm: 'model-b', up: Math.ceil(n * 0.7), down: n - Math.ceil(n * 0.7) }))]); }
function sw(o) { return ent(Object.assign({ id: idAt(T1, 'sssss'), status: 'switched', level: 2, scope: 'dia1', cm: 'model-a', to: 'model-b', tag: 'switch', at: { t: 0, n: 0 }, line: '' }, o)); }
const backs = (r, notes, c) => S.proposals(r, notes, c || DB).filter(p => p.kind === 'back');

kase('P5: 19 new rated answers on the model switched to raise nothing; 20 raise one review', () => {
	eq(backs(after(19), [sw()]), []);
	const b = backs(after(20), [sw()]);
	eq(b.length, 1);
	eq([b[0].kind, b[0].level, b[0].scope, b[0].name, b[0].key, b[0].to, b[0].tag, b[0].line], ['back', 2, 'dia1', 'Thesis', 'model-b', 'model-a', '', '']);
	eq(b[0].evidence, { note: idAt(T1, 'sssss'), n: 20, up: 14, down: 6 }, 'numbers and the entry only');
});

kase('P5: new means since the switch: the count the entry recorded is taken off', () => {
	eq(backs(after(30), [sw({ at: { t: 0, n: 11 } })]), [], '19 since');
	eq(backs(after(31), [sw({ at: { t: 0, n: 11 } })]).length, 1, '20 since');
});

kase('P5: it asks only while the Diamond still runs the model it was switched to', () => {
	eq(backs(after(40), [sw()], { diamonds: [{ d: 'dia1', name: 'Thesis', cm: 'model-c' }] }), []);
	eq(backs(after(40), [sw()], { diamonds: [] }), [], 'no such Diamond');
});

kase('P5: a Keep or a Switch back is a retirement, and the tile never comes back', () => {
	const r = after(40);
	eq(backs(r, [sw()]).length, 1);
	eq(backs(r, [sw({ status: 'retired', at: { t: 0, n: 40 } })]), []);
	eq(backs(after(400), [sw({ status: 'retired', at: { t: 0, n: 40 } })]), [], 'not after more answers either');
});

kase('P5: the newest switch of a Diamond is the one asked about; an older one is not', () => {
	const older = sw({ id: idAt(T1, 'aaaaa'), at: { t: 0, n: 0 } }), newer = sw({ id: idAt(T2, 'bbbbb'), at: { t: 0, n: 30 } });
	eq(backs(after(40), [older, newer]), [], '10 since the newer');
	eq(backs(after(50), [newer, older]).map(p => p.evidence.note), [idAt(T2, 'bbbbb')]);
});

kase('P5: the review is a count, not a claim: a thin or mixed cell still asks', () => {
	const r = roll([chat(mk({ d: 'dia1', cm: 'model-b', up: 10, down: 10 }))]);
	eq(RR.cell(r, 2, 'dia1', 'cm', 'model-b').claim, '', 'precondition: no claim');
	eq(backs(r, [sw()]).length, 1);
});

kase('P5: a switch entry is never a note: not listed, not a review, not composed', () => {
	eq(S.listing([sw()], { diamonds: DB.diamonds }), []);
	eq(S.proposals(after(40), [sw()], DB).filter(p => p.kind === 'review'), []);
	eq(S.select([sw()], 'model-b', 'dia1'), []);
});

kase('P5: the review sorts after a switch, a note and a review, and its id names the entry', () => {
	const r = roll([chat(mk({ d: 'dia1', cm: 'model-b', up: 20, down: 5, tags: { long: 2 } }).concat(mk({ cm: 'model-a', c: 'c2', up: 5, down: 20, tags: { long: 8 } })))]);
	const ps = S.proposals(r, [sw(), ent({ id: idAt(T2, 'nnnnn'), cm: 'model-b', level: 3, tag: 'wrong', at: { t: 0, n: 0 } })], DB);
	ok(ps.length >= 2, 'a back and more');
	eq(ps[ps.length - 1].kind, 'back');
	ok(ps[ps.length - 1].id.indexOf(idAt(T1, 'sssss')) > 0, 'the id names the entry');
});

// ── The note file holds the new status byte for byte ───────
kase('file: a switched entry is written and read back exactly', () => {
	const e = sw({ at: { t: 0, n: 12 } });
	eq(S.check(e, {}), '', 'check');
	const doc = S.put({ items: [], nl: false }, e), text = S.serialise(doc);
	eq(text, '## ' + idAt(T1, 'sssss') + ' · switched · diamond · model-a · switch 0 of 12 · to model-b\n\n');
	const back = S.parse(text, 'dia1', false);
	eq(back.ignored, [], 'nothing unreadable');
	eq(back.entries.length, 1);
	eq([back.entries[0].status, back.entries[0].cm, back.entries[0].to, back.entries[0].at], ['switched', 'model-a', 'model-b', { t: 0, n: 12 }]);
	eq(S.serialise(back.doc), text, 'byte for byte');
});

kase('file: a switched entry needs a target and a Diamond', () => {
	ok(S.check(sw({ to: '' }), {}) !== '', 'no target');
	ok(S.check(sw({ level: 3, scope: '' }), {}) !== '', 'not at the account');
});

// ── The model a Diamond left, provider included (Switch back restores it exactly) ──
const WAS = { provider: 'fireworks', model: 'accounts/fireworks/models/glm-5p2' };

kase('file: a switched entry holds the full model it left, provider and id, and reads it back byte for byte', () => {
	const e = sw({ at: { t: 0, n: 12 }, was: WAS });
	eq(S.check(e, {}), '', 'check');
	const text = S.serialise(S.put({ items: [], nl: false }, e));
	eq(text, '## ' + idAt(T1, 'sssss') + ' · switched · diamond · model-a · switch 0 of 12 · to model-b · was fireworks/accounts/fireworks/models/glm-5p2\n\n');
	const back = S.parse(text, 'dia1', false);
	eq(back.ignored, [], 'nothing unreadable');
	eq(back.entries[0].was, WAS, 'the pair');
	eq(S.serialise(back.doc), text, 'byte for byte');
});

kase('file: a model id the header cannot hold as it stands is escaped and comes back whole; an empty provider is kept', () => {
	for (const was of [{ provider: 'p q', model: 'm · 1 %' }, { provider: '', model: 'model-a' }, { provider: 'or', model: 'anthropic/claude:beta' }]) {
		const e = sw({ at: { t: 0, n: 3 }, was });
		eq(S.check(e, {}), '', 'check ' + JSON.stringify(was));
		const text = S.serialise(S.put({ items: [], nl: false }, e));
		const back = S.parse(text, 'dia1', false);
		eq(back.ignored, [], 'readable ' + JSON.stringify(was));
		eq(back.entries[0].was, was, 'the pair');
		eq(S.serialise(back.doc), text, 'byte for byte');
	}
});

kase('file: an entry with no model left is as before, and a model with no id is refused', () => {
	eq(S.serialise(S.put({ items: [], nl: false }, sw())).indexOf(' was '), -1, 'no was field');
	ok(S.check(sw({ was: { provider: 'p', model: '' } }), {}) !== '', 'a pair with no model');
	ok(S.check(sw({ was: 'p/m' }), {}) !== '', 'not a pair');
});

kase('file: closing a switch by retirement keeps the model left on file', () => {
	const e = sw({ at: { t: 0, n: 12 }, was: WAS }), closed = Object.assign({}, e, { status: 'retired', at: { t: 0, n: 40 } });
	const back = S.parse(S.serialise(S.put(S.put({ items: [], nl: false }, e), closed)), 'dia1', false);
	eq(back.entries.map(x => [x.status, x.was]), [['retired', WAS]]);
});

kase('P5: the review carries the model the Diamond left, provider included', () => {
	const b = backs(after(20), [sw({ was: WAS })]);
	eq(b.length, 1);
	eq(b[0].was, WAS, 'the pair, for the press that restores it');
	eq(backs(after(20), [sw()])[0].was, undefined, 'an older entry has none');
});

// ── The list calls a note "not in use" when the selection would not send it (U6b's own select) ──
const DU = { diamonds: [{ d: 'dA', name: 'Atlas', cm: 'model-a' }, { d: 'dB', name: 'Thesis', cm: 'model-b' }] };
const offOf = (g, id) => { let r; g.forEach(x => x.notes.forEach(n => { if (n.id === id) r = n.off; })); return r; };
const N = (id, o) => ent(Object.assign({ id: idAt(T1, id) }, o));

kase('not in use: a Diamond note for a model the Diamond is not running is not in use, with that reason', () => {
	const g = S.listing([N('aaaaa', { level: 2, scope: 'dA', cm: 'model-a', tag: 'long' }), N('bbbbb', { level: 2, scope: 'dB', cm: 'model-a', tag: 'long' })], DU);
	eq(offOf(g, idAt(T1, 'aaaaa')), undefined, 'dA runs model-a: in use');
	eq(offOf(g, idAt(T1, 'bbbbb')), 'model', 'dB runs model-b');
});

kase('not in use: a note for all models is in use whatever the Diamond runs', () => {
	eq(offOf(S.listing([N('aaaaa', { level: 2, scope: 'dB', cm: 'all' })], DU), idAt(T1, 'aaaaa')), undefined);
});

kase('not in use: one note per tag. Of two on one tag at one rank, the earlier id is told and the later is not', () => {
	const g = S.listing([N('aaaaa', { level: 2, scope: 'dA', cm: 'all', tag: 'tool', line: 'First.' }), N('bbbbb', { level: 2, scope: 'dA', cm: 'all', tag: 'tool', line: 'Second.' })].map((e, i) => Object.assign(e, { id: idAt(T1 + i, 'xxxx' + i) })), DU);
	const ids = g[0].notes.map(n => n.id);
	eq([offOf(g, ids[0]), offOf(g, ids[1])], [undefined, 'taken']);
});

kase('not in use: model before all. A Diamond note for the model displaces the Diamond\'s note for all, which still serves another model', () => {
	const mA = N('aaaaa', { level: 2, scope: 'dA', cm: 'model-a', tag: 'style', line: 'For a.' }), all = N('bbbbb', { level: 2, scope: 'dA', cm: 'all', tag: 'style', line: 'For all.' });
	eq(offOf(S.listing([mA, all], DU), all.id), 'taken', 'dA runs model-a: the model note is told');
	eq(offOf(S.listing([mA, all], { diamonds: [{ d: 'dA', name: 'Atlas', cm: 'model-z' }] }), all.id), undefined, 'dA runs model-z: the note for all is told');
	eq(offOf(S.listing([mA, all], { diamonds: [{ d: 'dA', name: 'Atlas', cm: 'model-z' }] }), mA.id), 'model', 'and the model note is not');
});

kase('not in use: Diamond before account. In a Diamond\'s view the account note its own note displaces is not in use here; on the account list it is in use (an ordinary chat is told it)', () => {
	const mine = N('aaaaa', { level: 2, scope: 'dA', cm: 'all', tag: 'wrong', line: 'Mine.' }), acct = N('bbbbb', { level: 3, scope: '', cm: 'all', tag: 'wrong', line: 'Yours.' });
	eq(offOf(S.listing([mine, acct], Object.assign({ diamond: 'dA' }, DU)), acct.id), 'diamond', 'dA view');
	eq(offOf(S.listing([mine, acct], DU), acct.id), undefined, 'account list: told in an ordinary chat');
	eq(offOf(S.listing([mine, acct], Object.assign({ diamond: 'dB' }, DU)), acct.id), undefined, 'dB has no note of its own on the tag');
});

kase('not in use: it is the selection\'s answer, not a copy. For every note and every view, off is set exactly when select does not return it', () => {
	const notes = [
		N('aaaaa', { level: 2, scope: 'dA', cm: 'model-a', tag: 'long' }), N('bbbbb', { level: 2, scope: 'dA', cm: 'all', tag: 'long' }),
		N('ccccc', { level: 3, scope: '', cm: 'model-b', tag: 'long' }), N('ddddd', { level: 3, scope: '', cm: 'all', tag: 'long' }),
		N('eeeee', { level: 2, scope: 'dB', cm: 'all', tag: 'tool' }), N('fffff', { level: 3, scope: '', cm: 'model-a', tag: 'tool' }),
	];
	DU.diamonds.forEach(d => {
		const picked = new Set(S.select(notes, d.cm, d.d).map(e => e.id));
		S.listing(notes, Object.assign({ diamond: d.d }, DU)).forEach(g => g.notes.forEach(n => {
			ok((n.off === undefined) === picked.has(n.id), d.d + ' view: ' + n.id + ' off=' + n.off + ' picked=' + picked.has(n.id));
		}));
	});
});

kase('not in use: where the page does not say what a Diamond runs, nothing is claimed about its notes', () => {
	eq(offOf(S.listing([N('aaaaa', { level: 2, scope: 'dA', cm: 'model-a' })], { diamonds: [{ d: 'dA', name: 'Atlas' }] }), idAt(T1, 'aaaaa')), undefined);
	eq(offOf(S.listing([N('aaaaa', { level: 2, scope: 'gone', cm: 'model-a' })], DU), idAt(T1, 'aaaaa')), undefined, 'a Diamond not listed');
});

kase('not in use: a line the engine refuses is not in use, by the same lint the turn is composed with', () => {
	const g = S.listing([N('aaaaa', { level: 3, scope: '', cm: 'all', line: 'bad line' })], Object.assign({ refuse: l => l === 'bad line' ? 'rating' : '' }, DU));
	eq(offOf(g, idAt(T1, 'aaaaa')), 'refused');
});

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
