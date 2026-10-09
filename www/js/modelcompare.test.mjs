/* ============================================================
   Test -- THE MODEL COMPARE ROLL-UP, PURE (www/js/modelcompare.js), MC2.
   ------------------------------------------------------------
   Plan: ~/usr/code/ai/claude/specs/daimond_model_compare_plan_20261009.md, §1 (kinds),
   §2.4 (columns), §3 (accepted answer), §4 (arithmetic), §6.2 (snapshot); MC2's
   fail-first list. Every expected number below is worked by hand from those
   sections, or by an independent formula in this file, never read back from the
   module.

   The REAL provenance.js, ratings.js, ratingroll.js and modelcompare.js are loaded
   into a bare `window` scope. Each file loads on its own, so with the module absent
   every case FAILs and the count still means something.

   Run:  node www/js/modelcompare.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, cases = 0, bad = null;

function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
function near(got, want, what, eps) {
	if (!(Math.abs(got - want) <= (eps || 1e-9)) && !bad) bad = (what || 'value') + ': got ' + got + ' want ' + want;
}
function kase(name, fn) {
	cases++; bad = null;
	try { fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); }
	else { console.log('  ok   ' + name); }
}

const win = {};
for (const f of ['provenance.js', 'ratings.js', 'ratingroll.js', 'modelcompare.js']) {
	try { new Function('window', readFileSync(join(HERE, f), 'utf8'))(win); }
	catch (e) { console.log('  load ' + f + ': ' + e.message); }
}
const R = win.DaimondRatings, RR = win.DaimondRatingRoll, MC = win.DaimondModelCompare;

// ── Independent arithmetic ─────────────────────────────────
const Z = 1.6448536269514722;
function wilsonRef(p, n) {
	const z2 = Z * Z, d = 1 + z2 / n, c = (p + z2 / (2 * n)) / d;
	const h = Z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
	return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}
function range(a, b) { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; }

// ── Builders: synthetic turns, heads, ledger ───────────────
const T0 = 1790000000000;
let SEQ = 0;
function turn(o) {
	const tid = (o && o.tid) || ('t' + String(++SEQ).padStart(4, '0'));
	return Object.assign({ tid: tid, c: 'c1', d: '', role: 'chat', cm: 'model-a', fam: 'fam-x', pv: 'pv1', kind: 'talk',
		accepted: true, up: false, at: T0, hs: ['p1:answer:c1/a' + tid], nf: [] }, o || {}, { tid: tid });
}
function head(t, o) {
	return Object.assign({ h: t.hs[0], mid: 'r' + t.tid, ts: T0 + (++SEQ), s: 1, tags: [],
		dims: { correct: -1, followed: -1, length: -1, style: -1 }, len: 100, via: '',
		cm: t.cm, fam: t.fam, cls: 'frontier', role: t.role, pv: t.pv, d: t.d, c: t.c }, o || {});
}
function dims(f) { return { correct: -1, followed: f, length: -1, style: -1 }; }
function part(turns, heads) { return { heads: heads || [], made: [], turns: turns }; }
function led(t, o) { return Object.assign({ tid: t.tid, t: t.at, m: t.cm, pv: t.pv, u: 1 }, o || {}); }
function many(n, o) { return range(1, n).map(() => turn(o)); }
function row(g, cm) { return g.rows.find(r => r.cm === cm); }

// ── Builders: a real transcript ────────────────────────────
function prod(o) {
	return Object.assign({ h: '', k: 'answer', m: 'm-a', pv: 'pv1', cm: 'model-a', fam: 'fam-x', fi: false, cls: 'frontier',
		role: 'chat', sp: 'sp1:00000000', d: '', c: 'c1', t: '', dev: 'd-1', at: T0, hash: '', run: '', via: '' }, o);
}
// One chat. Each spec: { text, tools: [[name, args]], files: [path], img, mail, ans: {prod fields},
// content, provisional, why, rate: { s, tags, dims, form, note }, worker: { rid, rate }, noAnswer }.
function chat(c, specs, d) {
	const out = []; let ts = T0;
	specs.forEach((sp, i) => {
		const mid = 'u' + i + '-' + c;
		const um = { role: 'user', mid: mid, ts: ++ts, content: sp.text === undefined ? 'please help me now' : sp.text };
		if (sp.img) um.images = ['img1'];
		out.push(um);
		(sp.tools || []).forEach(([n, a]) => out.push({ role: 'tool_log', mid: 'tl' + (++ts), ts: ts, name: n,
			args: typeof a === 'string' ? a : JSON.stringify(a || {}) }));
		if (sp.files) out.push({ role: 'files_log', mid: 'f' + mid, ts: ++ts,
			prod: sp.files.map(p => prod({ h: 'p1:file:s' + c + '/v1/' + p, k: 'file', c: c, d: d || '', t: mid })) });
		if (sp.mail) out.push({ role: 'mail_log', mid: 'm' + mid, ts: ++ts, prod: [prod({ h: 'p1:mail:' + c + '/' + mid, k: 'mail', c: c, t: mid })] });
		if (!sp.noAnswer) {
			const p = prod(Object.assign({ h: 'p1:answer:' + c + '/a' + mid, c: c, d: d || '', t: mid }, sp.ans || {}));
			const am = { role: 'assistant', mid: 'a' + mid, ts: ++ts, content: sp.content === undefined ? 'an answer' : sp.content, prod: [p] };
			if (sp.provisional) am.provisional = true;
			if (sp.why) am.why = 'stopped';
			out.push(am);
			if (sp.rate) out.push(R.message(R.build({ prod: p, s: sp.rate.s, tags: sp.rate.tags || [], dims: sp.rate.dims || {},
				note: sp.rate.note || '', src: 'tap', form: sp.rate.form, len: 100 }), 'r-' + (++ts).toString(36) + '-00001', ts));
		}
		if (sp.worker) {
			const wp = prod({ h: 'p1:worker:' + sp.worker.rid, k: 'worker', c: c, t: mid, role: 'worker' });
			out.push({ role: 'worker_log', mid: 'w' + mid, ts: ++ts, prod: [wp] });
			if (sp.worker.rate) out.push(R.message(R.build({ prod: wp, s: sp.worker.rate.s, src: 'tap', len: 10 }), 'r-' + (++ts).toString(36) + '-00002', ts));
		}
	});
	return out;
}
function turnsOf(specs) { return MC.turns(chat('c1', specs)); }

// ── The module ─────────────────────────────────────────────
kase('module: attaches DaimondModelCompare with the plan constants', () => {
	ok(MC && typeof MC.grid === 'function' && typeof MC.rank === 'function' && typeof MC.snapshot === 'function', 'functions');
	eq(MC.KIND_V, 1, 'KIND_V');
	eq(MC.KINDS, ['mail', 'image', 'code', 'writing', 'research', 'talk'], 'kinds');
	eq(MC.PRESETS.cheapest, { cost: 3, quality: 2, following: 1 }, 'cheapest');
	eq(MC.PRESETS.fastest, { first: 2, end: 3, stall: 1 }, 'fastest');
	eq(MC.PRESETS.best, { quality: 3, following: 2, honesty: 2, selfverify: 1 }, 'best');
	ok(MC.COLUMNS.every(c => MC.PRESETS.balanced[c] === 1), 'balanced is all 1');
});

kase('purity: no document, storage, network or clock read in the source', () => {
	const src = readFileSync(join(HERE, 'modelcompare.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	ok(!/\bdocument\b|localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|Date\.now|new Date|performance\.now/.test(src), 'impure');
});

// ── Extensions and re-asks ─────────────────────────────────
kase('extOf: from a file-row handle or a path, lower-cased, extension only', () => {
	eq(MC.extOf('p1:file:sc1/v3/src/Main.RS'), 'rs', 'handle');
	eq(MC.extOf('chats/c1/work/notes/a.b.md'), 'md', 'last dot');
	eq(MC.extOf('Makefile'), '', 'none');
	eq(MC.extOf('dir/.bashrc'), '', 'dotfile');
	eq(MC.extOf('x.'), '', 'trailing dot');
	eq(MC.extOf('v.1/readme'), '', 'dot in a directory only');
});

kase('isReask: Jaccard exactly 0.6 on four words is a re-ask', () => {
	// {fix, the, login, bug} vs {fix, the, login, page}: 3 / 5 = 0.6
	eq(MC.isReask('Fix the login bug', 'fix the LOGIN page!'), true);
});

kase('isReask: Jaccard 0.5 is not; three words never are', () => {
	// {a,b,c,d} vs {a,b,c,e,f}: 3 / 6 = 0.5
	eq(MC.isReask('alpha beta gamma delta', 'alpha beta gamma epsilon zeta'), false, '0.5');
	eq(MC.isReask('fix the bug', 'fix the bug'), false, 'three words');
	eq(MC.isReask('', 'one two three four'), false, 'empty first');
});

kase('isReask: case and punctuation are stripped', () => {
	eq(MC.isReask('Write, the README; please now', 'write the readme please now?'), true);
});

// ── Task kind: each rule and the precedence (§1.1) ─────────
const K = f => MC.turnKind(f);
kase('kind 1 mail: a mail_* tool, or a mail product', () => {
	eq(K({ tools: ['mail_send'] }), 'mail', 'tool');
	eq(K({ mail: true }), 'mail', 'product');
});
kase('kind precedence: mail beats image and code', () => {
	eq(K({ tools: ['mail_draft', 'shell'], image: true, written: ['rs'] }), 'mail');
});
kase('kind 2 image: the person sent an image; it beats code', () => {
	eq(K({ image: true }), 'image', 'alone');
	eq(K({ image: true, tools: ['shell'], written: ['js'] }), 'image', 'over code');
});
kase('kind 3 code: a code file written, or shell / command / run_net ran', () => {
	eq(K({ tools: ['file_write'], written: ['py'] }), 'code', 'write');
	eq(K({ tools: ['shell'] }), 'code', 'shell');
	eq(K({ tools: ['command'] }), 'code', 'command');
	eq(K({ tools: ['run_net'] }), 'code', 'run_net');
});
kase('kind 3 code beats writing when shell ran beside a prose write', () => {
	eq(K({ tools: ['shell', 'file_write'], written: ['md'] }), 'code');
});
kase('kind: a code write and a capture is code, not image', () => {
	eq(K({ tools: ['file_edit', 'capture'], written: ['ts'] }), 'code');
});
kase('kind 4 writing: a prose file written, or typst_compile ran', () => {
	eq(K({ tools: ['file_write'], written: ['typ'] }), 'writing', 'write');
	eq(K({ tools: ['typst_compile'] }), 'writing', 'typst');
});
kase('kind: mixed writes take the majority; a tie is code', () => {
	eq(K({ written: ['md', 'md', 'js'] }), 'writing', 'majority prose');
	eq(K({ written: ['md', 'js', 'rs'] }), 'code', 'majority code');
	eq(K({ written: ['md', 'js'] }), 'code', 'tie');
});
kase('kind: failing writes, only code files read is code; only prose read is writing', () => {
	eq(K({ tools: ['file_read', 'file_read'], read: ['rs', 'go'] }), 'code', 'code');
	eq(K({ tools: ['file_read'], read: ['md'] }), 'writing', 'prose');
	eq(K({ tools: ['file_read', 'file_read'], read: ['md', 'rs'] }), 'other', 'mixed reads');
});
kase('kind 5 research: a web_* tool and no file written', () => {
	eq(K({ tools: ['web_search', 'web_fetch'] }), 'research', 'research');
	eq(K({ tools: ['web_search', 'file_write'], written: ['png'] }), 'other', 'with a write');
});
kase('kind 6 talk: no tool at all; a lone capture is other', () => {
	eq(K({}), 'talk', 'talk');
	eq(K({ tools: ['capture'] }), 'other', 'capture');
	eq(K({ tools: ['file_write'], written: ['png'] }), 'other', 'unknown extension');
});

// ── turns(): a real transcript ─────────────────────────────
kase('turns: one answered turn carries its id, model and kind, and is accepted', () => {
	const ts = turnsOf([{ ans: { at: T0 + 5 } }]);
	eq(ts.length, 1, 'count');
	const t = ts[0];
	eq([t.tid, t.c, t.role, t.cm, t.fam, t.pv, t.kind, t.accepted, t.up, t.at], ['u0-c1', 'c1', 'chat', 'model-a', 'fam-x', 'pv1', 'talk', true, false, T0 + 5]);
	eq(t.hs, ['p1:answer:c1/au0-c1'], 'handles');
});
kase('turns: tool_log args as a JSON string give the written extension (code)', () => {
	eq(turnsOf([{ tools: [['file_write', '{"path":"chats/c1/work/src/a.rs","content":"x"}']] }])[0].kind, 'code');
});
kase('turns: a file product of the turn counts as written, and joins hs', () => {
	const t = turnsOf([{ files: ['doc/plan.md'] }])[0];
	eq(t.kind, 'writing', 'kind');
	eq(t.hs, ['p1:answer:c1/au0-c1', 'p1:file:sc1/v1/doc/plan.md'], 'hs');
});
kase('turns: an image on the person\'s message and a mail product set their kinds', () => {
	eq(turnsOf([{ img: true, tools: [['shell', {}]] }])[0].kind, 'image', 'image');
	eq(turnsOf([{ mail: true }])[0].kind, 'mail', 'mail');
});
kase('turns: chatPart carries the same turns', () => {
	const msgs = chat('c1', [{ tools: [['shell', {}]] }, { text: 'thanks' }]);
	eq(RR.chatPart(msgs).turns, MC.turns(msgs));
});
kase('turns: no message text, path or note survives in a turn', () => {
	const j = JSON.stringify(turnsOf([{ text: 'zanzibar quokka', tools: [['file_write', { path: 'secretplans/narwhal.rs' }]],
		content: 'gooseberry', rate: { s: 1, note: 'pomegranate' } }]));
	['zanzibar', 'quokka', 'secretplans', 'narwhal', 'gooseberry', 'pomegranate'].forEach(w => ok(j.indexOf(w) < 0, 'leaked ' + w));
});

// ── Accepted answer: each rule alone (§3) ──────────────────
kase('accept rule 1: a provisional answer is not final', () => {
	eq(turnsOf([{ provisional: true }])[0].accepted, false);
});
kase('accept rule 1: an answer with a why (stopped) is not final', () => {
	eq(turnsOf([{ why: true }])[0].accepted, false);
});
kase('accept rule 1: ledger out failed or interrupted rejects; a later completed run accepts', () => {
	const t = turn();
	eq(MC.accepted(t, [{ out: 'failed' }]), false, 'failed');
	eq(MC.accepted(t, [{ out: 'interrupted' }]), false, 'interrupted (rule 5)');
	eq(MC.accepted(t, [{ out: 'failed' }, { out: 'completed' }]), true, 'retried inside the turn');
	eq(MC.accepted(t, []), true, 'no ledger');
});
kase('accept rule 2: a negative head rejects; a zero head does not', () => {
	eq(turnsOf([{ rate: { s: -1 } }])[0].accepted, false, 'negative');
	eq(turnsOf([{ rate: { s: 0 } }])[0].accepted, true, 'zero');
});
kase('accept rule 3: the next message re-asks -> not accepted; a new ask -> accepted', () => {
	const ts = turnsOf([{ text: 'fix the login bug please' }, { text: 'please fix the login bug' }, { text: 'now write the release notes' }]);
	eq(ts.map(t => t.accepted), [false, true, true]);
});
kase('accept rule 3: the last answer of a chat is accepted on the evidence so far', () => {
	eq(turnsOf([{ text: 'one two three four' }])[0].accepted, true);
});
kase('accept rule 4: a later file_revert of a path it wrote rejects it', () => {
	const ts = turnsOf([{ tools: [['file_write', { path: 'chats/c1/work/a.rs' }]] }, { tools: [['file_revert', { path: 'a.rs' }]], text: 'undo that change' }]);
	eq(ts[0].accepted, false, 'reverted');
	eq(ts[1].accepted, true, 'the reverting turn');
});
kase('accept rule 4: a file_revert of another path does not; nor one before the write', () => {
	eq(turnsOf([{ tools: [['file_write', { path: 'a.rs' }]] }, { tools: [['file_revert', { path: 'b.rs' }]], text: 'undo b instead' }])[0].accepted, true, 'other path');
	const ts = turnsOf([{ tools: [['file_revert', { path: 'a.rs' }]] }, { tools: [['file_write', { path: 'a.rs' }]], text: 'now write it' }]);
	eq(ts[1].accepted, true, 'revert before');
});
kase('accept rule 4: a file_revert names a file product of the turn by its path', () => {
	eq(turnsOf([{ files: ['src/x.go'] }, { tools: [['file_revert', '{"path":"chats/c1/work/src/x.go"}']], text: 'put x back' }])[0].accepted, false);
});
kase('accept rule 4: opts.reverted (a History restore) rejects the turn holding that handle', () => {
	const t = turn({ hs: ['p1:answer:c1/a1', 'p1:file:s/v2/a.rs'] });
	eq(MC.accepted(t, [], ['p1:file:s/v2/a.rs']), false, 'array');
	eq(MC.accepted(t, [], new Set(['p1:file:s/v2/a.rs'])), false, 'set');
	eq(MC.accepted(t, [], ['p1:file:s/v1/a.rs']), true, 'another version');
});
kase('accept rule 2: an up-rating beats a re-ask', () => {
	const ts = turnsOf([{ text: 'fix the login bug please', rate: { s: 1 } }, { text: 'please fix the login bug' }]);
	eq([ts[0].up, ts[0].accepted], [true, true]);
});
kase('accept rule 2: an up-rating beats a failed run and a History restore', () => {
	const t = turn({ up: true, hs: ['h1'] });
	eq(MC.accepted(t, [{ out: 'failed' }], ['h1']), true);
});
kase('worker report: accepted on rules 1, 2, 5 only, with its dispatcher\'s kind', () => {
	const ts = turnsOf([{ text: 'fix the login bug please', tools: [['shell', {}]], worker: { rid: 'w1' } },
		{ text: 'please fix the login bug', worker: { rid: 'w2', rate: { s: -2 } } }]);
	const w1 = ts.find(t => t.tid === 'w1'), w2 = ts.find(t => t.tid === 'w2');
	eq([w1.role, w1.kind, w1.accepted], ['worker', 'code', true], 'w1: a re-ask does not reach a worker');
	eq(w2.accepted, false, 'w2: negative head');
	eq(ts.find(t => t.tid === 'u0-c1').accepted, false, 'the answer itself was re-asked');
});
kase('turns: nf holds only handles rated on form daimond/1.1 or later', () => {
	eq(turnsOf([{ rate: { s: 1, form: 'daimond/1.1' } }])[0].nf, ['p1:answer:c1/au0-c1'], '1.1');
	eq(turnsOf([{ rate: { s: 1 } }])[0].nf, [], '1');
});

// ── Quantiles (§4.2), hand-worked ──────────────────────────
kase('quantile n=10 q=.5: ranks [2, 9], figure rank 5', () => {
	const q = MC.quantile(range(1, 10).map(i => i * 10), 0.5);
	eq([q.rlo, q.rhi, q.value, q.lo, q.hi, q.n], [2, 9, 50, 20, 90, 10]);
});
kase('quantile n=30 q=.5: ranks [10, 21]', () => {
	const q = MC.quantile(range(1, 30).reverse(), 0.5);
	eq([q.rlo, q.rhi, q.value], [10, 21, 15]);
});
kase('quantile n=30 q=.9: ranks [24, 30] (upper clamped from 31)', () => {
	const q = MC.quantile(range(1, 30), 0.9);
	eq([q.rlo, q.rhi, q.value], [24, 30, 27]);
});
kase('quantile n=31 q=.9: ranks [25, 31] (upper clamped from 32)', () => {
	const q = MC.quantile(range(1, 31), 0.9);
	eq([q.rlo, q.rhi, q.value], [25, 31, 28]);
});
kase('quantile floors: P50 needs 10, P90 needs 30, "N more" below', () => {
	eq(MC.quantile(range(1, 9), 0.5), { not_enough: true, n: 9, more: 1 }, 'p50 at 9');
	eq(MC.quantile([], 0.5), { not_enough: true, n: 0, more: 10 }, 'p50 at 0');
	eq(MC.quantile(range(1, 29), 0.9), { not_enough: true, n: 29, more: 1 }, 'p90 at 29');
	eq(MC.quantile(range(1, 10), 0.9).more, 20, 'p90 at 10');
});
kase('quantile: a non-number is not a recorded time', () => {
	eq(MC.quantile(range(1, 9).concat([null, 'x', NaN]), 0.5).not_enough, true);
});

// ── Rates and Wilson (§4.3) ────────────────────────────────
kase('Wilson: rate() bands equal U5a\'s and an independent formula', () => {
	const r = MC.rate(3, 10), w = RR.wilson(0.3, 10), x = wilsonRef(0.3, 10);
	eq([r.lo, r.hi], [w.lo, w.hi], 'U5a');
	near(r.lo, x.lo, 'lo'); near(r.hi, x.hi, 'hi');
	near(r.value, 0.3, 'value');
});
kase('rate floor: 9 turns not enough (1 more), 10 enough', () => {
	eq(MC.rate(5, 9), { not_enough: true, n: 9, more: 1 }, '9');
	eq(MC.rate(5, 10).n, 10, '10');
});
kase('costRatio: the band on a hand fixture (costs 1..10, 5 accepted)', () => {
	const c = MC.costRatio(range(1, 10), 5);
	const se = Math.sqrt(82.5 / 9) / Math.sqrt(10), w = wilsonRef(0.5, 10);
	near(c.value, 11, 'value'); near(c.mean, 5.5, 'mean'); near(c.se, se, 'se');
	near(c.lo, (5.5 - Z * se) / w.hi, 'lo'); near(c.hi, (5.5 + Z * se) / w.lo, 'hi');
	ok(c.lo < c.value && c.value < c.hi, 'contains the figure');
});
kase('costRatio floors: 10 turns and 3 accepted, "N more" is the larger gap', () => {
	eq(MC.costRatio(range(1, 9), 5).more, 1, '9 turns');
	eq(MC.costRatio(range(1, 10), 2).more, 1, '2 accepted');
	eq(MC.costRatio(range(1, 4), 0).more, 6, '4 turns, 0 accepted');
	eq(MC.costRatio(range(1, 10), 3).not_enough, undefined, 'at both floors');
});

// ── The grid: measured columns ─────────────────────────────
kase('grid: cost per accepted answer = sum u / accepted, with its band', () => {
	const ts = many(10, {}); ts.slice(5).forEach(t => { t.accepted = false; });
	const g = MC.grid([part(ts)], ts.map((t, i) => led(t, { u: i + 1, out: 'completed' })), {});
	const c = row(g, 'model-a').cells.cost;
	near(c.value, 11, 'value'); eq([c.n, c.accepted], [10, 5], 'counts');
	eq(row(g, 'model-a').cells.accept.k, 5, 'accept k');
});
kase('grid: old ledger entries (no ft, dur, ro) read not recorded, never 0', () => {
	const ts = many(10, {});
	const c = row(MC.grid([part(ts)], ts.map(t => led(t)), {}), 'model-a').cells;
	['first', 'end', 'stall', 'toolerr', 'images'].forEach(k => eq(c[k], { not_recorded: true }, k));
	near(c.cost.value, 1, 'cost still reads');
});
kase('grid: no ledger at all -> cost not enough, times not recorded', () => {
	const c = row(MC.grid([part(many(10, {}))], [], {}), 'model-a').cells;
	eq([c.cost.not_enough, c.first.not_recorded], [true, true]);
});
kase('grid: first token and end of turn P50 from ledger ft / dur; P90 not enough at 10', () => {
	const ts = many(10, {});
	const c = row(MC.grid([part(ts)], ts.map((t, i) => led(t, { ft: (i + 1) * 100, dur: (i + 1) * 1000, ro: 'r' })), {}), 'model-a').cells;
	eq([c.first.p50.value, c.first.p50.lo, c.first.p50.hi], [500, 200, 900], 'first p50');
	eq([c.end.p50.value, c.first.p90.not_enough, c.first.p90.more], [5000, true, 20], 'end p50, p90');
});
kase('grid: several runs of one turn: cost summed, ft from the latest', () => {
	const ts = many(10, {});
	const L = [];
	ts.forEach(t => { L.push(led(t, { t: T0 + 1, ft: 100, u: 1 })); L.push(led(t, { t: T0 + 2, ft: 300, u: 2 })); });
	const c = row(MC.grid([part(ts)], L, {}), 'model-a').cells;
	eq([c.first.p50.value, c.cost.mean], [300, 3]);
});
kase('grid: stall rate = turns with sg >= 1 over turns with ft', () => {
	const ts = many(12, {});
	const L = ts.slice(0, 10).map((t, i) => led(t, { ft: 100, sg: i < 2 ? 1 : (i === 2 ? 2 : 0) })).concat(ts.slice(10).map(t => led(t)));
	const s = row(MC.grid([part(ts)], L, {}), 'model-a').cells.stall;
	eq([s.k, s.n], [3, 10]); near(s.value, 0.3);
});
kase('grid: tool-error rate is calls, from MC1 entries only (floor 10 calls)', () => {
	const ts = many(3, {});
	const L = [led(ts[0], { ro: 'r', tc: 5, te: 1 }), led(ts[1], { ro: 'r', tc: 5, te: 1 }), led(ts[2], { tc: 50, te: 50 })];
	const e = row(MC.grid([part(ts)], L, {}), 'model-a').cells.toolerr;
	eq([e.k, e.n], [2, 10]); near(e.value, 0.2);
	const few = row(MC.grid([part(ts)], [led(ts[0], { ro: 'r', tc: 4, te: 0 })], {}), 'model-a').cells.toolerr;
	eq(few, { not_enough: true, n: 4, more: 6 }, 'below the floor');
});
kase('grid: images tried and failed from MC1 entries; declared from the catalogue', () => {
	const ts = many(3, {});
	const L = [led(ts[0], { ro: 'r', im: 1, out: 'failed' }), led(ts[1], { ro: 'r', im: 2, out: 'completed' }), led(ts[2], { ro: 'r' })];
	const im = row(MC.grid([part(ts)], L, { declared: cm => cm === 'model-a' }), 'model-a').cells.images;
	eq([im.declared, im.tried, im.failed.not_enough, im.failed.n], [true, 2, true, 2]);
});
kase('grid: spend not tied to an answer is never in a ratio, and is counted', () => {
	const ts = many(10, {});
	const L = ts.map(t => led(t, { u: 1 })).concat([{ tid: 'gone', t: T0, m: 'model-a', u: 4 }, { t: T0, m: 'model-b', u: 2 },
		{ t: T0 - 5, m: 'model-a', u: 100 }]);
	const g = MC.grid([part(ts)], L, { from: T0, identify: m => ({ cm: m }) });
	near(row(g, 'model-a').cells.cost.value, 1, 'cost untouched');
	eq([row(g, 'model-a').untied, g.untied], [4, 6], 'untied, out-of-window excluded');
});
kase('grid: the window is [from, to)', () => {
	const ts = [turn({ at: T0 - 1 }), turn({ at: T0 }), turn({ at: T0 + 9 }), turn({ at: T0 + 10 })];
	eq(row(MC.grid([part(ts)], [], { from: T0, to: T0 + 10 }), 'model-a').n, 2);
});
kase('grid: split by provider gives one row per provider and model', () => {
	const g = MC.grid([part([turn({ pv: 'p1' }), turn({ pv: 'p2' }), turn({ pv: 'p2' })])], [], { split: true });
	eq(g.rows.map(r => [r.key, r.pv, r.n]), [['p1:model-a', 'p1', 1], ['p2:model-a', 'p2', 2]]);
});
kase('grid: a kind keeps only its turns', () => {
	const g = MC.grid([part(many(3, { kind: 'code' }).concat(many(2, { kind: 'talk' })))], [], { kind: 'code' });
	eq([g.kind, row(g, 'model-a').n], ['code', 3]);
});
kase('grid: the same parts in any order give the same grid; a turn in two parts counts once', () => {
	const a = many(6, { kind: 'code' }), b = many(5, { kind: 'talk', cm: 'model-b' });
	const H = a.map(t => head(t, { s: 2 })).concat(b.map(t => head(t, { s: -1 })));
	const L = a.concat(b).map((t, i) => led(t, { u: i, ft: i * 10, ro: 'r', tc: 2, te: i % 2 }));
	const g1 = MC.grid([part(a, H.slice(0, 6)), part(b, H.slice(6))], L, {});
	const g2 = MC.grid([part(b.slice().reverse(), H.slice(6).reverse()), part(a.slice().reverse(), H.slice(0, 6))], L.slice().reverse(), {});
	eq(JSON.stringify(g2), JSON.stringify(g1), 'order');
	eq(row(MC.grid([part(a), part(a)], [], {}), 'model-a').n, 6, 'twice');
});

// ── The Diamond fallback (§1.1) ────────────────────────────
function fallback(code, talk, other) {
	const ts = many(code, { d: 'd1', kind: 'code' }).concat(many(talk, { d: 'd1', kind: 'talk' }), many(other, { d: 'd1', kind: 'other' }));
	return row(MC.grid([part(ts)], [], { kind: 'code' }), 'model-a').n - code;
}
kase('Diamond fallback: 60% and >= 5 classified -> other takes the dominant kind', () => {
	eq(fallback(6, 4, 2), 2);
});
kase('Diamond fallback: 59% stays other', () => {
	eq(fallback(59, 41, 1), 0);
});
kase('Diamond fallback: fewer than 5 of the kind stays other, even at 100%', () => {
	eq(fallback(4, 0, 1), 0);
});
kase('Diamond fallback: a turn with no Diamond stays other', () => {
	const ts = many(6, { d: 'd1', kind: 'code' }).concat([turn({ kind: 'other' })]);
	eq(row(MC.grid([part(ts)], [], { kind: 'code' }), 'model-a').n, 6);
});

// ── Judged columns (§4.1) ──────────────────────────────────
kase('quality (all kinds) is U5a\'s L3 cm cell: same theta, share and band', () => {
	const ts = many(12, {}), H = ts.map((t, i) => head(t, { s: i % 3 ? 1 : -1 }));
	const q = row(MC.grid([part(ts, H)], [], {}), 'model-a').cells.quality;
	const c = RR.cell(RR.cells([part([], H)], { sides: null }), 3, '', 'cm', 'model-a');
	eq([q.theta, q.share, q.lo, q.hi, q.n], [c.theta, c.share, c.lo, c.hi, c.n]);
});
kase('quality below the floor reads not enough with U5a\'s "N more"', () => {
	const ts = many(4, {}), H = ts.map(t => head(t));
	const q = row(MC.grid([part(ts, H)], [], {}), 'model-a').cells.quality;
	const c = RR.cell(RR.cells([part([], H)], { sides: null }), 3, '', 'cm', 'model-a');
	eq([q.not_enough, q.n, q.more], [true, 4, c.more]);
	ok(c.more >= 6, 'more');
});
function thinFixture() {
	const code = many(20, { kind: 'code' }), wr = many(2, { kind: 'writing' }), rs = many(3, { kind: 'research' });
	const H = code.map(t => head(t, { s: 1 })).concat(wr.map(t => head(t, { s: -2 })));
	const all = RR.cell(RR.cells([part([], H)], { sides: null }), 3, '', 'cm', 'model-a');
	const thin = RR.cell(RR.cells([part([], H.slice(20))], { sides: null }), 3, '', 'cm', 'model-a');
	return { parts: [part(code.concat(wr, rs), H)], all: all, thin: thin };
}
kase('quality: a thin kind:cm cell reads as its cm cell (shrunk to it), not "not enough"', () => {
	const f = thinFixture();
	ok(f.all.ok && !f.thin.ok, 'fixture');
	const q = row(MC.grid(f.parts, [], { kind: 'writing' }), 'model-a').cells.quality;
	ok(!q.not_enough, 'reads not enough');
	near(q.value, (f.thin.ws + 5 * f.all.theta) / (f.thin.w + 5), 'theta');
});
kase('quality: a kind with no rating at all reads exactly as the cm cell', () => {
	const f = thinFixture();
	const q = row(MC.grid(f.parts, [], { kind: 'research' }), 'model-a').cells.quality;
	near(q.value, f.all.theta, 'theta');
});
kase('quality: a trusted kind:cm cell reads as itself, shrunk toward the cm cell', () => {
	const code = many(50, { kind: 'code' }), talk = many(20, { kind: 'talk' });
	const H = code.map(t => head(t, { s: 2 })).concat(talk.map(t => head(t, { s: -2 })));
	const all = RR.cell(RR.cells([part([], H)], { sides: null }), 3, '', 'cm', 'model-a');
	const kc = RR.cell(RR.cells([part([], H.slice(0, 50))], { sides: null }), 3, '', 'cm', 'model-a');
	const q = row(MC.grid([part(code.concat(talk), H)], [], { kind: 'code' }), 'model-a').cells.quality;
	near(q.value, (kc.ws + 5 * all.theta) / (kc.w + 5), 'theta');
	ok(q.value > 1.7, 'reads as itself');
});
kase('following: +1 on followed >= 3 or tag; -1 on <= 1, ignored or scope; share over verdicts', () => {
	const ts = many(12, {});
	const H = ts.map((t, i) => head(t, i < 5 ? { dims: dims(3) } : i < 7 ? { tags: ['followed'] } : i < 8 ? { tags: ['ignored'] }
		: i < 9 ? { tags: ['scope'] } : i < 10 ? { dims: dims(1) } : i < 11 ? { dims: dims(4), tags: ['ignored'] } : {}));
	const f = row(MC.grid([part(ts, H)], [], {}), 'model-a').cells.following;
	eq([f.k, f.n], [7, 11]);
});
kase('honesty: 1 - made_up share over answers rated on form >= 1.1 only', () => {
	const nf = many(10, {}); nf.forEach(t => { t.nf = t.hs.slice(); });
	const old = many(4, {});
	const H = nf.map((t, i) => head(t, { tags: i < 2 ? ['made_up'] : [] })).concat(old.map(t => head(t, { tags: ['made_up'] })));
	const h = row(MC.grid([part(nf.concat(old), H)], [], {}), 'model-a').cells.honesty;
	eq([h.k, h.n], [8, 10]); near(h.value, 0.8);
});
kase('self-verify: checked / (checked + unchecked)', () => {
	const ts = many(11, {});
	const H = ts.map((t, i) => head(t, { tags: i < 7 ? ['checked'] : i < 10 ? ['unchecked'] : [] }));
	const s = row(MC.grid([part(ts, H)], [], {}), 'model-a').cells.selfverify;
	eq([s.k, s.n], [7, 10]);
	const w = wilsonRef(0.7, 10); near(s.lo, w.lo); near(s.hi, w.hi);
});
kase('judged: a head outside the window is not counted', () => {
	const inn = many(10, {}), out = many(5, { at: T0 - 100 });
	const H = inn.concat(out).map(t => head(t, { tags: ['checked'] }));
	eq(row(MC.grid([part(inn.concat(out), H)], [], { from: T0 }), 'model-a').cells.selfverify.n, 10);
});
kase('judged: the newest head of a handle counts once across parts', () => {
	const ts = many(12, {});
	const old = ts.map(t => head(t, { s: -2, ts: T0 }));
	const nu = ts.map(t => head(t, { s: 2, ts: T0 + 9, tags: ['checked'] }));
	const c = row(MC.grid([part(ts, old), part([], nu)], [], {}), 'model-a').cells;
	eq([c.quality.n, c.selfverify.k], [12, 12]);
	ok(c.quality.share === 1, 'newest');
});

// ── Ranking (§4.4) ─────────────────────────────────────────
function G(rows) { return { kind: 'all', split: false, from: null, to: null, rows: rows }; }
function R0(key, cells, more) { return Object.assign({ key: key, cm: key, pv: '', cells: cells }, more || {}); }
const V = (v, lo, hi) => ({ value: v, lo: lo === undefined ? v : lo, hi: hi === undefined ? v : hi, n: 20 });
kase('presetOf: each preset by its weights; a moved slider is custom', () => {
	Object.keys(MC.PRESETS).forEach(p => eq(MC.presetOf(MC.PRESETS[p]), p, p));
	eq(MC.presetOf(Object.assign({}, MC.PRESETS.balanced, { cost: 2 })), 'custom', 'moved');
	eq(MC.presetOf({}), 'custom', 'none');
});
kase('rank: cost inverted, min-max to 0..1', () => {
	const r = MC.rank(G([R0('b', { cost: V(2) }), R0('a', { cost: V(1) }), R0('c', { cost: V(1.5) })]), { cost: 1 });
	eq(r.rows.map(x => [x.key, x.rank]), [['a', 1], ['c', 2], ['b', 3]], 'order');
	eq(r.rows.map(x => x.score), [1, 0.5, 0], 'scores');
});
kase('rank: high-is-good columns are not inverted (quality on the theta scale)', () => {
	const q = (v, s) => ({ value: v, theta: v, share: s, lo: s - 0.1, hi: s + 0.1, n: 20 });
	const r = MC.rank(G([R0('lo', { quality: q(-1, 0.3) }), R0('hi', { quality: q(1.5, 0.9) })]), { quality: 1 });
	eq(r.rows.map(x => x.key), ['hi', 'lo']);
});
kase('rank: a weighted mean over the row\'s trusted columns', () => {
	const r = MC.rank(G([R0('a', { cost: V(1), first: { p50: V(400) } }), R0('b', { cost: V(2), first: { p50: V(100) } })]), { cost: 3, first: 1 });
	eq(r.rows.map(x => [x.key, x.score]), [['a', 0.75], ['b', 0.25]]);
});
kase('rank: under half the weight trusted is not ranked and sits below', () => {
	const r = MC.rank(G([R0('a', { cost: V(1) }), R0('b', { cost: V(2), quality: { value: 1, share: 0.8, lo: 0.7, hi: 0.9, n: 20 } })]), { cost: 1, quality: 3 });
	eq(r.rows.map(x => [x.key, x.rank]), [['b', 1], ['a', 'unranked']]);
});
kase('rank: exactly half the weight trusted is ranked', () => {
	eq(MC.rank(G([R0('a', { cost: V(1) })]), { cost: 1, first: 1 }).rows[0].rank, 1);
});
kase('rank: a not-enough or not-recorded cell is not trusted', () => {
	const r = MC.rank(G([R0('a', { cost: { not_enough: true, n: 3, more: 7 }, first: { not_recorded: true } })]), { cost: 1, first: 1 });
	eq(r.rows[0].rank, 'unranked');
});
kase('rank: overlapping bands mark approx; separate bands do not', () => {
	const sep = MC.rank(G([R0('a', { cost: V(1, 0.9, 1.1) }), R0('b', { cost: V(2, 1.9, 2.1) })]), { cost: 1 });
	eq(sep.rows.map(x => x.approx), [false, false], 'separate');
	const ov = MC.rank(G([R0('a', { cost: V(1, 0.5, 3) }), R0('b', { cost: V(2, 0.5, 3) })]), { cost: 1 });
	eq(ov.rows.map(x => x.approx), [false, true], 'overlap');
});
kase('rank: weights clamp to 0..5 and 0 leaves the column out', () => {
	eq(MC.rank(G([]), { cost: 9, first: 0, end: -2, stall: 'x' }).weights, { cost: 5 });
});
kase('rank: the team row is never ranked', () => {
	const r = MC.rank(G([R0('a', { cost: V(1) }), R0('team', { cost: V(0.1) }, { team: true })]), { cost: 1 });
	eq(r.rows.map(x => x.key), ['a']);
});

// ── The snapshot (§6.2) ────────────────────────────────────
kase('countBand: exact counts never leave; bands 10+, 30+, 100+, 300+', () => {
	eq([9, 10, 29, 30, 99, 100, 299, 300, 5000].map(MC.countBand), ['', '10+', '10+', '30+', '30+', '100+', '100+', '300+', '300+']);
});
kase('ymd: civil dates without a Date', () => {
	eq(MC.ymd(0), '1970-01-01', 'epoch');
	eq(MC.ymd(951782400000), '2000-02-29', 'leap day');
	eq(MC.ymd(T0), new Date(T0).toISOString().slice(0, 10), 'T0');
	eq(MC.ymd(null), '', 'none');
});
kase('snapshot: exactly the whitelisted keys, versions and dates', () => {
	const ts = many(10, { at: 951782399000 });
	const g = MC.grid([part(ts)], ts.map(t => led(t, { u: 2 })), { from: 0, to: 951782400000 });
	const s = MC.snapshot(g, { build: 'abc1234', form: 'daimond/1.1', weights: MC.PRESETS.cheapest });
	eq(Object.keys(s).sort(), ['build', 'form', 'from', 'kind', 'kindV', 'preset', 'rows', 'to', 'v', 'weights'], 'keys');
	eq([s.v, s.kindV, s.build, s.form, s.from, s.to, s.kind, s.preset], [1, 1, 'abc1234', 'daimond/1.1', '1970-01-01', '2000-02-29', 'all', 'cheapest']);
	eq(Object.keys(s.rows[0]).sort(), ['cells', 'cm', 'rank'], 'row keys');
	eq(s.rows[0].cells.cost, { value: 2, lo: s.rows[0].cells.cost.lo, hi: s.rows[0].cells.cost.hi, n: '10+' }, 'cost cell');
	eq(s.rows[0].cells.first_p50, 'not_enough', 'not recorded reads not enough');
});
kase('snapshot: a bad build or form is dropped, a split row carries its provider', () => {
	const g = MC.grid([part([turn({ pv: 'pvx' })])], [], { split: true });
	const s = MC.snapshot(g, { build: 'not a sha!', form: 'evil' });
	eq([s.build, s.form, s.rows[0].pv, s.rows[0].rank], ['', 'daimond/1.1', 'pvx', 'unranked']);
});
kase('snapshot: a fixture full of distinctive words carries none of them', () => {
	const W = ['zanzibar', 'quokka', 'pomegranate', 'marmalade', 'xylophone', 'secretplans', 'narwhal', 'gooseberry', 'tangerine'];
	const specs = range(1, 12).map(i => ({ text: 'zanzibar quokka task ' + i, content: 'gooseberry answer',
		tools: [['file_write', { path: 'secretplans/narwhal' + i + '.rs' }]], files: ['secretplans/tangerine' + i + '.md'],
		rate: { s: 1, tags: ['checked'], note: 'pomegranate note' } }));
	const msgs = chat('xylophone', specs, 'marmalade');
	const g = MC.grid([RR.chatPart(msgs)], [], {});
	ok(g.rows.length === 1 && g.rows[0].n === 12, 'fixture rolled');
	const j = JSON.stringify(MC.snapshot(g, { weights: MC.PRESETS.best }));
	W.forEach(w => ok(j.indexOf(w) < 0, 'leaked ' + w));
	ok(JSON.stringify(g.rows).indexOf('secretplans') < 0 && JSON.stringify(g.rows).indexOf('pomegranate') < 0, 'grid leaked');
});

// ── Q27: a retried answer is a rejected answer ───────────────
// `retryTurn` tombstones the turn, so its answer is no turn in any part. What is left is its ledger
// spend, marked `tr` (the turn that replaced it): the grid counts it as a rejected answer, its spend
// in the cost ratio and nothing of it "not tied to an answer".
function retried(tid, at, tr, o) { return Object.assign({ tid: tid, t: at, m: 'model-a', pv: 'pv1', u: 3, tr: tr }, o || {}); }
kase('Q27: a retried answer (gone from the transcript, ledger `tr`) counts as a rejected answer', () => {
	const ts = many(4, { kind: 'code', d: 'd1' }), r = ts[3];
	const L = ts.map(t => led(t, { u: 1 })).concat([retried('x1', T0 - 1, r.tid)]);
	const g = MC.grid([part(ts)], L, { identify: m => ({ cm: m }) });
	// The same account written as if the rejected answer were still a turn.
	const ref = MC.grid([part(ts.concat([turn({ tid: 'x1', kind: 'code', d: 'd1', accepted: false, at: T0 - 1 })]))],
		L.map(e => e.tid === 'x1' ? Object.assign({}, e, { tr: undefined }) : e), { identify: m => ({ cm: m }) });
	eq([row(g, 'model-a').n, row(g, 'model-a').untied, g.untied], [5, 0, 0], 'n, untied');
	eq(row(g, 'model-a').cells.cost, row(ref, 'model-a').cells.cost, 'cost per accepted answer');
	eq(row(g, 'model-a').cells.accept, row(ref, 'model-a').cells.accept, 'accept rate');
});
kase('Q27: the rejected answer takes its kind from the turn that replaced it', () => {
	const r = turn({ kind: 'code' });
	const L = [led(r, { u: 1 }), retried('x1', T0 - 1, r.tid)];
	eq(row(MC.grid([part([r])], L, { kind: 'code' }), 'model-a').n, 2, 'in its kind');
	eq(MC.grid([part([r])], L, { kind: 'talk' }).rows.length, 0, 'not in another');
});
kase('Q27: a retry of a retry follows the chain to the turn that stands', () => {
	const r = turn({ kind: 'research' });
	const L = [led(r, { u: 1 }), retried('x1', T0 - 2, 'x2'), retried('x2', T0 - 1, r.tid)];
	const g = MC.grid([part([r])], L, { kind: 'research' });
	eq([row(g, 'model-a').n, g.untied], [3, 0]);
	eq(row(g, 'model-a').cells.accept, MC.rate(1, 3), 'one accepted of three');
});
kase('Q27: a replacement that never ran leaves the rejected answer as kind other, still counted', () => {
	const r = turn({ kind: 'talk' });
	const L = [led(r, { u: 1 }), retried('x1', T0 - 1, 'never')];
	eq(row(MC.grid([part([r])], L, {}), 'model-a').n, 2, 'all kinds');
	eq(row(MC.grid([part([r])], L, { kind: 'talk' }), 'model-a').n, 1, 'not in talk');
});
kase('Q27: the rejected answer is the model that answered, not the one that replaced it', () => {
	const r = turn({ cm: 'model-b' });
	const L = [led(r, { u: 1 }), retried('x1', T0 - 1, r.tid)];
	const g = MC.grid([part([r])], L, { identify: m => ({ cm: m }) });
	eq([row(g, 'model-a').n, row(g, 'model-a').cells.accept, row(g, 'model-b').n], [1, MC.rate(0, 1), 1]);
});
kase('Q27: a turn still in the transcript whose ledger says it was retried is not accepted', () => {
	// The ledger's mark can reach a device before the tombstone does.
	const t = turn({}), L = [retried(t.tid, T0, 'r9', { u: 1 })];
	eq([MC.accepted(t, L, []), MC.accepted(Object.assign({}, t, { up: true }), L, [])], [false, true], 'retried; an up-rating still accepts');
	eq(row(MC.grid([part([t])], L, {}), 'model-a').n, 1, 'counted once');
});
kase('Q27: same parts and ledger in any order give the same grid', () => {
	const ts = many(3, { kind: 'code' }), r = ts[2];
	const L = ts.map(t => led(t, { u: 1 })).concat([retried('x1', T0 - 2, 'x2'), retried('x2', T0 - 1, r.tid), retried('x2', T0 - 1, r.tid, { m: 'model-a', p: 9 })]);
	eq(MC.grid([part(ts)], L.slice().reverse(), {}), MC.grid([part(ts.slice().reverse())], L, {}));
});

console.log('\n' + cases + ' cases, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
