/* ============================================================
   Test -- THE PENDING TILES OF THE OPTIMISER'S PROPOSALS AND WHAT EACH PRESS DOES
   (www/js/daimond.js, "What the ratings propose, as Pending tiles (Rating U7b)"; unit U7b of 5.3.2).
   ------------------------------------------------------------
   Plan: ~/usr/code/ai/claude/specs/daimond_optimiser_532_plan_20261004.md, §5 U7b; invariants J5 (nothing
   from an untrusted cell), J8 (nothing applies without a press; Add writes exactly the line shown), J9 (no
   tile names a reaction); P7 (a dismissal is remembered, on every device, by the note file).

   `daimond.js` is an ES module over the compiled wasm, so it cannot be run here. `Pending` and the `steer*`
   functions are LIFTED from the file's own text (dev/syncprobe.mjs) and run as written; the REAL provenance,
   ratings, ratingroll, steering and pricing modules are loaded beside them. Stand-in: the page's Diamonds, the
   note file (U6b's writer, reached through the one adapter table `STEER_API`, so the test installs a stand-in
   under the names the table holds), the dialog, the toast, the model switch and a fake DOM.

   Each check is proven able to fail:

     node www/js/steerpending.test.mjs --break nostale      # a tile no longer proposed stays up
     node www/js/steerpending.test.mjs --break nocheck      # a press does not ask the notes again first
     node www/js/steerpending.test.mjs --break editline     # Add writes the proposed line, not the edited one
     node www/js/steerpending.test.mjs --break badge        # raising a tile counts on the dock badge
     node www/js/steerpending.test.mjs --break switchtag    # a switch's dismissal is written as a note's
     node www/js/steerpending.test.mjs --break unreadable   # an unreadable note file is read as an empty one
     node www/js/steerpending.test.mjs --break nullnote     # Keep or Remove of a note the file no longer holds is read as done
     node www/js/steerpending.test.mjs --break holdline     # a tile no longer proposed still writes on a press
     node www/js/steerpending.test.mjs                      # and then, clean
   ============================================================ */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, loadScript, liftSource } from '../../dev/syncprobe.mjs';

let failures = 0, cases = 0, bad = null;
function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
async function kase(name, fn) {
	cases++; bad = null;
	try { await fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); } else { console.log('  ok   ' + name); }
}

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? (process.argv[i + 1] || '') : ''; })();
const KNOWN = ['nostale', 'nocheck', 'editline', 'badge', 'switchtag', 'unreadable', 'nullnote', 'holdline'];
if (BREAK && !KNOWN.includes(BREAK)) { console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', ')); process.exit(2); }

/// Each break patches the lifted source and must match exactly once, or the run exits 2.
function patch(src) {
	function swap(needle, to) {
		const n = src.split(needle).length - 1;
		if (n !== 1) { console.error('break ' + BREAK + ': target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
		src = src.replace(needle, to);
	}
	if (BREAK === 'nostale')    swap("if (!x.steer || !want[x.steer.id]) return false;", "if (!x.steer) return false;");
	if (BREAK === 'nocheck')    swap('try { holds = await steerStillHolds(p); } catch (e) { /* unknown */ }', 'holds = true;');
	if (BREAK === 'editline')   swap("cm: p.key, tag: p.tag, line: line || p.line, at: at }", "cm: p.key, tag: p.tag, line: p.line, at: at }");
	if (BREAK === 'switchtag')  swap("{ level: 2, scope: scope, cm: p.key, tag: 'switch', at: at, to: p.to }", "{ level: 2, scope: scope, cm: p.key, tag: p.tag, at: at, to: p.to }");
	if (BREAK === 'unreadable') swap("return r.ok && Array.isArray(r.value) ? r.value : null;", "return r.ok && Array.isArray(r.value) ? r.value : [];");
	if (BREAK === 'nullnote')   swap("if ((act === 'keep' || act === 'remove') && r.value === null) {", "if (false) {");
	if (BREAK === 'holdline')   swap("if (!holds) { toast(t('pending.steer.gone')); Pending.drop(it.id); steerRaise(); return false; }", "");
	return src;
}

const NAMES = ['steerSettle', 'steerRaise', 'steerPress', 'steerEdit', 'steerTile', 'steerLintMsg', 'steerApi', 'steerTarget', 'steerReturn', 'STEER_API'];
const STUBS = ['Pending', 'ratingsAccount', 'diamonds', 'diamondModel', 'changeDiamondModel', 'refreshDiamondAfterChange', 'bumpDiamonds', 'loadDiamonds',
	'currentDiamond', 'promptDialog', 'toast', 't', 'nudgeSync', 'Badge', 'settleConsent', '_parked', 'relTime', 'selectDiamond', 'doSteer',
	'turnHold', 'confirmHold', 'readJson', 'PENDING_KEY', 'PRIORITIES', 'NOTICED_KEY', 'NOTICED_MAX'];

// ── The account: cells made by the real roll from synthetic ratings ──
let N = 0;
function head(d, cm, s, tags) {
	N++;
	return { h: 'p1:answer:c' + d + '/m' + N, mid: 'm' + N, ts: 1000 + N, s: s, tags: tags || [], dims: { correct: -1, followed: -1, length: -1, style: -1 }, len: 300,
		via: '', cm: cm, fam: 'fam-x', cls: 'frontier', role: 'chat', pv: 'p', d: d, c: 'c' + d };
}
/// `up` up-rates and `down` down-rates of one model in one Diamond, `tagged` of the down-rates with the tag `tag`.
function rated(d, cm, up, down, tagged, tag) {
	const heads = [];
	for (let i = 0; i < up; i++) heads.push(head(d, cm, 1));
	for (let i = 0; i < down; i++) heads.push(head(d, cm, -1, i < tagged ? [tag] : []));
	return { heads, made: [] };
}
const NOTE = { id: 'n-1', status: 'active', cm: 'model-a', tag: 'long', level: 2, scope: 'D1', at: { t: 3, n: 5 }, kept: 0, line: 'Keep answers under about 200 words unless asked for detail.', to: '' };

function page(o) {
	o = o || {};
	const win = makeWindow({ now: 1_790_000_000_000 });
	['provenance.js', 'ratings.js', 'ratingroll.js', 'steering.js', 'pricing.js'].forEach((f) => loadScript(win, f));
	const RR = win.DaimondRatingRoll;
	const st = { parts: o.parts || [], notes: (o.notes || []).map((e) => Object.assign({}, e)), readOk: true, failWrite: false, writes: [], toasts: [], bumps: 0, switched: [], prompt: null, lintCode: null, model: { D1: 'model-a' }, prov: { D1: 'p' } };
	const diamonds = [{ id: 'D1', name: 'Thesis' }];
	// U6b's writer, as its log fixes it: `window.DaimondNotes`, and the engine's lint as `DaimondSteering.refusal`. A write is recorded
	// as the call made, and also lands in the entries `list` returns, as the file would hold it.
	let nid = 0;
	const hold = (e) => { st.notes.push(Object.assign({ id: 'n-new' + (++nid), kept: 0, to: '', line: '' }, e)); return st.notes[st.notes.length - 1]; };
	const find = (r) => st.notes.find((e) => e.id === r.id && e.level === r.level && e.scope === r.scope) || null;
	const api = {
		list: async () => { if (!st.readOk) throw new Error('unreadable'); return st.notes.slice(); },
		add: async (e) => { st.writes.push(['add', e]); if (st.failWrite) throw new Error('refused'); return hold({ status: 'active', cm: e.cm, tag: e.tag, level: e.level, scope: e.scope, at: e.at, line: e.line }); },
		dismiss: async (e) => { st.writes.push(['dismiss', e]); return hold({ status: 'dismissed', cm: e.cm, tag: e.tag, level: e.level, scope: e.scope, at: e.at, to: e.to || '' }); },
		keep: async (r, n) => { st.writes.push(['keep', r, n]); if (st.nullNote) return null; const e = find(r); if (e) e.kept = n; return e; },
		retire: async (r, at) => { st.writes.push(['retire', r, at]); const e = find(r); if (e) { e.status = 'retired'; e.at = at; } return e; },
		back: async (r, o) => { st.writes.push(['back', r, o]); const e = find(r); if (!e) return null; e.status = 'retired'; e.at = o.at; hold({ status: 'dismissed', cm: o.cm, tag: 'switch', level: 2, scope: r.scope, at: { t: 0, n: o.n }, to: o.to }); return e; },
		switched: async (o) => { st.writes.push(['switched', o]); if (st.failSwitched) throw new Error('refused'); return hold({ status: 'switched', cm: o.cm, tag: 'switch', level: 2, scope: o.scope, at: o.at, to: o.to, was: o.was }); },
	};
	if (o.writer !== false) {
		win.DaimondNotes = api;
		win.DaimondSteering.refusal = (l) => (st.lintCode ? st.lintCode(l) : '');
	}
	// The Pending list as the page keeps it: read from storage, written whole, redrawn (a count of redraws, never a badge).
	const Pending = { items: [], draws: 0,
		fresh() { const g = stub.readJson('daimond-pending', []); this.items = Array.isArray(g) ? g.filter((it) => it && it.id) : []; },
		save() { win.localStorage.setItem('daimond-pending', JSON.stringify(this.items)); this.draws++; },
		drop(id) { this.fresh(); this.items = this.items.filter((x) => x.id !== id); this.save(); } };
	const stub = {
		Pending,
		ratingsAccount: async () => ({ roll: RR.cells(st.parts, { sides: null }) }),
		diamonds, diamondModel: (id) => ({ provider: st.prov[id] || 'p', model: st.model[id] || 'model-a' }),
		changeDiamondModel: async (id, before, p) => { st.switched.push([id, before.model, p]); },
		refreshDiamondAfterChange: async () => {}, bumpDiamonds: () => {}, loadDiamonds: async () => {}, currentDiamond: null,
		promptDialog: async (title, opts) => { st.prompt = opts; return st.promptAnswer === undefined ? null : st.promptAnswer; },
		toast: (m, bad2) => { st.toasts.push(m); }, t: (k, v) => k + (v ? '|' + Object.keys(v).sort().map((x) => x + '=' + v[x]).join(',') : ''),
		nudgeSync: () => {}, Badge: { bump: () => { st.bumps++; } }, settleConsent: () => false, _parked: {}, relTime: () => 'now',
		selectDiamond: async () => {}, doSteer: async () => {}, turnHold: () => null, confirmHold: async () => {},
		readJson: (k, d) => { try { const v = win.localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
		PENDING_KEY: 'daimond-pending', PRIORITIES: ['high', 'normal', 'low'], NOTICED_KEY: 'daimond-pending-noticed', NOTICED_MAX: 64,
	};
	win.DaimondModels = { all: () => [{ provider: 'p', model: 'model-a' }, { provider: 'p', model: 'model-b' }], resolve: (p, m) => ({ provider: p, model: m }) };
	let src = liftSource(NAMES, STUBS).src;
	src = patch(src);
	const sk = Object.keys(stub);
	const body = 'with (window) { return (function (' + sk.join(', ') + ') {\n' + src + '\nreturn { ' + NAMES.join(', ') + ' };\n}).apply(null, stubs); }';
	const fns = new Function('window', 'stubs', body)(win, sk.map((k) => stub[k]));
	return { win, st, fns, RR, P: Pending, items: () => { Pending.fresh(); return Pending.items; } };
}

/// D1 on model-a: 2 up and 14 down (8 tagged long); model-b in D1: 15 up, 1 down. Trusted, bad and good at L2; model-a bad at L3.
const ACCOUNT = () => [rated('D1', 'model-a', 2, 14, 8, 'long'), rated('D1', 'model-b', 15, 1, 0, 'long')];
const kinds = (pg) => pg.items().filter((x) => x.kind === 'steer').map((x) => x.steer.kind + ':' + x.steer.level).sort();

// A fake DOM, enough for steerTile.
function fakeDoc() {
	const mk = (tag) => ({ tag, className: '', textContent: '', children: [], listeners: {}, disabled: false, type: '',
		appendChild(c) { this.children.push(c); return c; }, addEventListener(e, f) { this.listeners[e] = f; },
		querySelectorAll() { return this.children.filter((c) => c.tag === 'button'); } });
	return { createElement: mk };
}

await kase('the three kinds are raised from trusted cells, as low-priority steer tiles, and count nowhere', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	eq(kinds(pg), ['note:2', 'note:3', 'switch:2'], 'kinds');
	pg.items().forEach((x) => { eq(x.priority, 'low', 'priority'); ok(x.id && x.headline && x.detail, 'tile words'); ok(x.steer && x.steer.id, 'carries its proposal'); });
	eq(pg.st.bumps, 0, 'no dock badge for a proposal (the importance filter)');
	const sw = pg.items().find((x) => x.steer.kind === 'switch');
	eq(sw.diamondId, 'D1', 'switch is for the Diamond'); eq(sw.diamondName, 'Thesis', 'named by the page');
	ok(/to=model-b/.test(sw.headline), 'headline names the target: ' + sw.headline);
});

await kase('nothing below the floor: a cell one rating short raises no tile (J5)', async () => {
	const pg = page({ parts: [rated('D1', 'model-a', 0, 6, 4, 'long')] });
	await pg.fns.steerRaise();
	eq(kinds(pg), [], 'kinds');
});

await kase('raising twice raises each tile once', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise(); const ids = pg.items().map((x) => x.id);
	await pg.fns.steerRaise(); await pg.fns.steerRaise();
	eq(pg.items().map((x) => x.id), ids, 'unchanged');
});

await kase('a note the file already holds is not proposed, and the tile that was is taken down', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	ok(kinds(pg).includes('note:2'), 'raised first');
	pg.st.notes.push(Object.assign({}, NOTE, { at: { t: 8, n: 16 } }));	// answered on another device
	await pg.fns.steerRaise();
	ok(!kinds(pg).includes('note:2'), 'the Diamond note tile is gone: ' + kinds(pg));
});

await kase('a note file that cannot be read raises nothing and takes nothing down', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise(); const before = kinds(pg);
	pg.st.readOk = false; pg.st.notes = [];
	await pg.fns.steerRaise();
	eq(kinds(pg), before, 'tiles as they were');
	const fresh = page({ parts: ACCOUNT() }); fresh.st.readOk = false;
	await fresh.fns.steerRaise();
	eq(kinds(fresh), [], 'nothing raised on an unreadable file');
});

await kase('with no writer there is no tile', async () => {
	const pg = page({ parts: ACCOUNT(), writer: false });
	await pg.fns.steerRaise();
	eq(kinds(pg), [], 'kinds');
});

await kase('a switch to a model this device cannot run is not raised', async () => {
	const pg = page({ parts: ACCOUNT() });
	pg.win.DaimondModels.all = () => [{ provider: 'p', model: 'model-a' }];
	await pg.fns.steerRaise();
	ok(!kinds(pg).includes('switch:2'), 'no switch: ' + kinds(pg));
});

await kase('Add writes exactly the line shown, with the counts shown (J8), and the entry is the writer\'s own', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'note' && x.steer.level === 2);
	const shown = it.steer.line;
	ok(shown && shown.length > 20, 'a line is shown');
	eq(await pg.fns.steerPress(it, 'add'), true, 'took effect');
	const w = pg.st.writes[0];
	eq(w[0], 'add', 'one add'); eq(w[1].line, shown, 'the line, byte for byte');
	eq([w[1].cm, w[1].tag, w[1].level, w[1].scope], ['model-a', 'long', 2, 'D1'], 'entry');
	eq(w[1].at, it.steer.at, 'the counts the tile showed');
	ok(!pg.items().some((x) => x.id === it.id), 'tile gone');
	ok(!kinds(pg).includes('note:2'), 'and not proposed again (the note holds it)');
});

await kase('an account note is written at level 3 with no scope', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'note' && x.steer.level === 3);
	await pg.fns.steerPress(it, 'add');
	eq([pg.st.writes[0][1].level, pg.st.writes[0][1].scope], [3, ''], 'level 3, no scope');
});

await kase('Edit: the line is offered, linted live, and Add writes the edited line', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'note' && x.steer.level === 2);
	pg.st.promptAnswer = 'Be brief, and cite the file.';
	eq(await pg.fns.steerEdit(it), true, 'took effect');
	eq(pg.st.prompt.value, it.steer.line, 'the field starts with the proposed line');
	eq(pg.st.writes[0][1].line, 'Be brief, and cite the file.', 'the edited line');
	ok(typeof pg.st.prompt.live === 'function' && typeof pg.st.prompt.validate === 'function', 'linted live and on submit');
});

await kase('Edit cancelled writes nothing and leaves the tile', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'note' && x.steer.level === 2);
	pg.st.promptAnswer = null;
	eq(await pg.fns.steerEdit(it), false, 'no effect');
	eq(pg.st.writes, [], 'nothing written'); ok(pg.items().some((x) => x.id === it.id), 'tile stays');
});

await kase('the live lint: empty and refused lines are told why; the engine lint is the authority', async () => {
	const pg = page({ parts: ACCOUNT() });
	ok(/empty/.test(pg.fns.steerLintMsg('')), 'empty');
	eq(pg.fns.steerLintMsg('A fine line.'), '', 'admitted');
	const code = (c) => { pg.st.lintCode = () => c; return pg.fns.steerLintMsg('a line'); };
	ok(/why_long/.test(code('long')), 'long'); ok(/why_control/.test(code('control')), 'control'); ok(/empty/.test(code('empty')), 'empty code');
	ok(/why_heading/.test(code('heading')), 'a line that starts with # is told so, in words and not as the engine\'s code (the engine\'s lint refuses it, round F)');
	['pleasing', 'agreeing', 'approval'].forEach((c) => ok(/refused\|why=pending.steer.why_tone|why_tone/.test(code(c)), c + ' is told as the tone it is'));
	ok(/why_rating/.test(code('rating')) && !/why_tone/.test(code('rating')), 'a line that names ratings is told so, not as a tone');
	ok(/refused\|why=zzz/.test(code('zzz')), 'a code the page has no words for is shown as it is');
	eq(code(''), '', 'admitted');
	delete pg.win.DaimondSteering.refusal;
	eq(pg.fns.steerLintMsg('x'.repeat(200)), '', '200 bytes pass without the engine');
	ok(/why_long/.test(pg.fns.steerLintMsg('x'.repeat(201))), '201 bytes do not');
	ok(/why_long/.test(pg.fns.steerLintMsg('é'.repeat(101))), 'bytes, not characters');
});

await kase('Dismiss writes a dismissed entry, and the tile does not return (a note)', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'note' && x.steer.level === 2);
	await pg.fns.steerPress(it, 'dismiss');
	const e = pg.st.writes[0][1];
	eq([pg.st.writes[0][0], e.cm, e.tag, e.level, e.scope], ['dismiss', 'model-a', 'long', 2, 'D1'], 'entry');
	eq(e.at, it.steer.at, 'the counts, for the cooling');
	await pg.fns.steerRaise();
	ok(!kinds(pg).includes('note:2'), 'not raised again');
});

await kase('Dismiss on a switch is written as tag switch with the model left and the target', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'switch');
	await pg.fns.steerPress(it, 'dismiss');
	const e = pg.st.writes[0][1];
	eq([pg.st.writes[0][0], e.tag, e.cm, e.to, e.level, e.scope], ['dismiss', 'switch', 'model-a', 'model-b', 2, 'D1'], 'entry');
	await pg.fns.steerRaise();
	ok(!kinds(pg).includes('switch:2'), 'not raised again, on this device or another reading the same file');
});

await kase('Switch calls the Diamond-model change with a model this device runs; it writes no note', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'switch');
	eq(await pg.fns.steerPress(it, 'switch'), true, 'took effect');
	eq(pg.st.switched, [['D1', 'model-a', { provider: 'p', model: 'model-b' }]], 'changeDiamondModel');
	eq(pg.st.writes, [['switched', { scope: 'D1', cm: 'model-a', to: 'model-b', at: { t: 0, n: 16 }, was: { provider: 'p', model: 'model-a' } }]], 'the Switch is on file for its review (P5), with the rated answers of model-b in D1 now, the whole model it left, and no note');
	ok(!pg.items().some((x) => x.id === it.id), 'tile gone');
});

await kase('P5: a Switch that cannot be put on file does not switch', async () => {
	const pg = page({ parts: ACCOUNT() });
	pg.st.failSwitched = true;
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'switch');
	eq(await pg.fns.steerPress(it, 'switch'), false, 'took no effect');
	eq(pg.st.switched, [], 'the model was not moved');
	ok(pg.items().some((x) => x.id === it.id), 'the tile stays to be pressed again');
});

// D1 now runs model-b, switched to when model-b held 16 rated answers there; 20 more have been rated.
const SW = { id: 'n-sw1', status: 'switched', cm: 'model-a', tag: 'switch', level: 2, scope: 'D1', at: { t: 0, n: 16 }, kept: 0, line: '', to: 'model-b' };
const AFTER = (more) => [rated('D1', 'model-a', 2, 14, 8, 'long'), rated('D1', 'model-b', 15 + more, 1, 0, 'long')];
const backPage = (more, extra) => { const pg = page(Object.assign({ parts: AFTER(more), notes: [SW] }, extra || {})); pg.st.model.D1 = 'model-b'; return pg; };

await kase('P5: after 20 new rated answers on the model switched to, one review tile asks Keep or Switch back', async () => {
	const few = backPage(19);
	await few.fns.steerRaise();
	ok(!kinds(few).some((k) => k.indexOf('back') === 0 || k === 'back:2'), 'not at 19: ' + kinds(few));
	const pg = backPage(20);
	pg.win.document = fakeDoc();
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'back');
	ok(it, 'raised at 20: ' + kinds(pg));
	eq(it.diamondId, 'D1', 'for the Diamond'); eq(it.priority, 'low', 'low priority'); eq(pg.st.bumps, 0, 'no badge');
	ok(/model=model-b/.test(it.headline) && /to=model-a/.test(it.headline), 'names both models: ' + it.headline);
	ok(/n=36/.test(it.detail), 'counts only: ' + it.detail);
	const box = pg.win.document.createElement('div');
	pg.fns.steerTile(box, it);
	eq(box.children.find((c) => c.className === 'pend-acts').children.map((b) => b.textContent), ['pending.steer.keep', 'pending.steer.back'], 'buttons');
});

await kase('P5: Keep closes the review with a retirement and moves no model; the tile never comes back', async () => {
	const pg = backPage(20);
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'back');
	eq(await pg.fns.steerPress(it, 'keep'), true, 'took effect');
	eq(pg.st.writes, [['retire', { level: 2, scope: 'D1', id: 'n-sw1' }, { t: 0, n: 36 }]], 'one retirement of the switch entry');
	eq(pg.st.switched, [], 'the model stays');
	await pg.fns.steerRaise();
	ok(!kinds(pg).includes('back:2'), 'not raised again on this device');
	const other = backPage(60, { notes: pg.st.notes });
	await other.fns.steerRaise();
	ok(!kinds(other).includes('back:2'), 'nor in a second context reading the same file, after more answers');
});

await kase('P5: Switch back closes the review, then restores the previous model through the path Switch used', async () => {
	const pg = backPage(20);
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'back');
	eq(await pg.fns.steerPress(it, 'back'), true, 'took effect');
	eq(pg.st.writes, [['back', { level: 2, scope: 'D1', id: 'n-sw1' }, { at: { t: 0, n: 36 }, cm: 'model-a', to: 'model-b', n: 16 }]],
		'the review is closed in one write, with the switch dismissed (the model it returns to, the one it tried, the returned-to model\'s rated answers now)');
	eq(pg.st.switched, [['D1', 'model-b', { provider: 'p', model: 'model-a' }]], 'changeDiamondModel, back to model-a');
	pg.st.model.D1 = 'model-a';
	await pg.fns.steerRaise();
	ok(!kinds(pg).includes('back:2'), 'not raised again');
});

// The model left was on provider q; D1 now runs model-b on provider p, and p hosts model-a too (the provider a Switch back would pick on its own).
const SWQ = Object.assign({}, SW, { was: { provider: 'q', model: 'model-a' } });
const twoProviders = (pg, dead) => {
	pg.win.DaimondModels = { all: () => [{ provider: 'p', model: 'model-a' }, { provider: 'q', model: 'model-a' }, { provider: 'p', model: 'model-b' }],
		resolve: (p, m) => ((dead || []).includes(p) ? null : { provider: p, model: m }) };
	return pg;
};

await kase('P5: Switch back restores the exact model the Diamond left, provider included, not the current provider\'s copy of it', async () => {
	const pg = twoProviders(backPage(20, { notes: [SWQ] }));
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'back');
	ok(it, 'raised');
	eq(await pg.fns.steerPress(it, 'back'), true, 'took effect');
	eq(pg.st.switched, [['D1', 'model-b', { provider: 'q', model: 'model-a' }]], 'changeDiamondModel, back to q / model-a');
});

await kase('P5: Switch back to a provider this device no longer holds still goes back to the model, on one it can run', async () => {
	const pg = twoProviders(backPage(20, { notes: [SWQ] }), ['q']);
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'back');
	ok(it, 'still raised: the model can run on p');
	await pg.fns.steerPress(it, 'back');
	eq(pg.st.switched, [['D1', 'model-b', { provider: 'p', model: 'model-a' }]], 'the same model on the provider that can run it');
});

await kase('P5: the model left, whole, is what Switch then Switch back round trips through the real entry', async () => {
	const pg = twoProviders(page({ parts: ACCOUNT() }));
	pg.st.prov.D1 = 'q';
	await pg.fns.steerRaise();
	await pg.fns.steerPress(pg.items().find((x) => x.steer.kind === 'switch'), 'switch');
	eq(pg.st.writes[0][1].was, { provider: 'q', model: 'model-a' }, 'on file: the provider the Diamond was on');
	pg.st.model.D1 = 'model-b'; pg.st.prov.D1 = 'p';
	pg.st.parts = AFTER(20);
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'back');
	ok(it, 'the review is raised after 20 more');
	await pg.fns.steerPress(it, 'back');
	eq(pg.st.switched[pg.st.switched.length - 1], ['D1', 'model-b', { provider: 'q', model: 'model-a' }], 'back where it was');
});

await kase('P5: a review whose model this device cannot run is not raised (its Switch back could do nothing)', async () => {
	const pg = backPage(20);
	pg.win.DaimondModels = { all: () => [{ provider: 'p', model: 'model-b' }], resolve: (p, m) => ({ provider: p, model: m }) };
	await pg.fns.steerRaise();
	ok(!kinds(pg).includes('back:2'), kinds(pg).join());
});

await kase('Keep records the count it was shown; Remove retires the note; a review is raised for an active note after 20 more', async () => {
	const parts = [rated('D1', 'model-a', 4, 26, 12, 'long')];
	const pg = page({ parts, notes: [NOTE] });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'review');
	ok(it, 'review raised: ' + kinds(pg));
	eq(it.steer.line, NOTE.line, 'the note\'s own words are shown');
	await pg.fns.steerPress(it, 'keep');
	eq(pg.st.writes[0], ['keep', { level: 2, scope: 'D1', id: 'n-1' }, 30], 'kept at the count shown');
	const pg2 = page({ parts, notes: [NOTE] });
	await pg2.fns.steerRaise();
	const it2 = pg2.items().find((x) => x.steer.kind === 'review');
	await pg2.fns.steerPress(it2, 'remove');
	eq(pg2.st.writes[0], ['retire', { level: 2, scope: 'D1', id: 'n-1' }, { t: 12, n: 30 }], 'retired with the counts');
});

await kase('Keep or Remove of a note the file no longer holds says so, writes nothing and takes the tile down', async () => {
	const pg = page({ parts: [rated('D1', 'model-a', 4, 26, 12, 'long')], notes: [NOTE] });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'review');
	pg.st.nullNote = true;
	eq(await pg.fns.steerPress(it, 'keep'), false, 'no effect');
	eq(pg.st.toasts.length, 1, 'told once'); ok(!pg.items().some((x) => x.id === it.id), 'tile gone');
});

await kase('a writer that rejects (a refused line, a Diamond gone) is told, writes nothing and keeps the tile', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'note' && x.steer.level === 2);
	pg.st.failWrite = true;
	eq(await pg.fns.steerPress(it, 'add'), false, 'no effect');
	eq(pg.st.toasts.length, 1, 'told'); ok(pg.items().some((x) => x.id === it.id), 'tile stays');
	ok(!pg.st.notes.some((e) => e.status === 'active'), 'no entry held');
});

await kase('a press asks the notes again: a tile another device answered writes nothing (OP4)', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'note' && x.steer.level === 2);
	pg.st.notes.push(Object.assign({}, NOTE, { at: { t: 8, n: 16 } }));
	eq(await pg.fns.steerPress(it, 'add'), false, 'no effect');
	eq(pg.st.writes, [], 'nothing written'); eq(pg.st.toasts.length, 1, 'told once');
	ok(!pg.items().some((x) => x.id === it.id), 'the stale tile is gone');
});

await kase('a press on a note file that cannot be read says so and keeps the tile', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const it = pg.items().find((x) => x.steer.kind === 'note' && x.steer.level === 2);
	pg.st.readOk = false;
	eq(await pg.fns.steerPress(it, 'add'), false, 'no effect');
	eq(pg.st.writes, [], 'nothing written'); ok(pg.items().some((x) => x.id === it.id), 'tile stays');
});

await kase('no tile, evidence or line names a reaction, and none holds a rating\'s note (J9, J4)', async () => {
	const parts = ACCOUNT(); parts[0].heads.forEach((h) => { h.note = 'ZEBRAWORD I was furious and annoyed'; });
	const pg = page({ parts, notes: [NOTE] });
	await pg.fns.steerRaise();
	const text = JSON.stringify(pg.items());
	ok(pg.items().length > 0, 'tiles raised');
	ok(!/ZEBRAWORD|furious|annoy|frustrat|angry|upset|disappoint|irritat|hate/i.test(text), 'no reaction, no note text');
});

await kase('a tile survives storage: what is read back is what was raised', async () => {
	const pg = page({ parts: ACCOUNT() });
	await pg.fns.steerRaise();
	const a = JSON.stringify(pg.items());
	const raw = pg.win.localStorage.getItem('daimond-pending');
	ok(raw, 'stored'); eq(JSON.stringify(JSON.parse(raw)), a, 'round trip');
});

await kase('each tile draws its own presses, the line in view, and a press disables the row while it runs', async () => {
	const pg = page({ parts: ACCOUNT(), notes: [] });
	pg.win.document = fakeDoc();
	const labels = {};
	await pg.fns.steerRaise();
	const run = (it) => { const box = pg.win.document.createElement('div'); pg.fns.steerTile(box, it); return box; };
	pg.items().forEach((it) => {
		const box = run(it), acts = box.children.find((c) => c.className === 'pend-acts');
		labels[it.steer.kind + it.steer.level] = acts.children.map((b) => b.textContent);
		const line = box.children.find((c) => /pend-steer-line/.test(c.className));
		eq(!!line, !!it.steer.line, 'the line is in view where there is one');
		if (line) eq(line.textContent, it.steer.line, 'the very line');
	});
	{	// a press disables the whole row while it runs, and gives it back after
		const it = pg.items().find((x) => x.steer.kind === 'note' && x.steer.level === 2), box = run(it), acts = box.children.find((c) => c.className === 'pend-acts');
		const running = acts.children[0].listeners.click();
		eq(acts.children.map((b) => b.disabled), [true, true, true], 'disabled while the press runs');
		await running;
		eq(acts.children.map((b) => b.disabled), [false, false, false], 'enabled again after');
		eq(pg.st.writes.length, 1, 'and the press ran once');
	}
	eq(labels.switch2, ['pending.steer.switch', 'common.dismiss'], 'switch');
	eq(labels.note2, ['pending.steer.add', 'pending.steer.edit', 'common.dismiss'], 'note');
	const pg2 = page({ parts: [rated('D1', 'model-a', 4, 26, 12, 'long')], notes: [NOTE] });
	pg2.win.document = fakeDoc();
	await pg2.fns.steerRaise();
	const rv = pg2.items().find((x) => x.steer.kind === 'review'), box = pg2.win.document.createElement('div');
	pg2.fns.steerTile(box, rv);
	eq(box.children.find((c) => c.className === 'pend-acts').children.map((b) => b.textContent), ['pending.steer.keep', 'pending.steer.remove'], 'review');
});

console.log('\n' + (cases - failures) + ' of ' + cases + ' cases passed' + (BREAK ? ' (break ' + BREAK + ')' : ''));
process.exit(failures ? 1 : 0);
