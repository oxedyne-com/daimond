// gateway: live
// verify_steering.mjs -- V2 of the 5.3.2 plan (specs/daimond_optimiser_532_plan_20261004.md section 5, V2): a steering note reaches the
// model, and only the model it names, as the engine's one STEERING block (U6a), written and selected by the page (U6b). By the wire:
// the mock provider records every request, and the system message on it is the thing under test (as verify_prompts does).
// World 88 with the live gateway binary for ST7, ST8 and MIX; ST1 to ST6 need no gateway. Headless, one page per context.
//
//   ST1  an active glm-5.2 note is in the system prompt sent for glm-5.2 and absent from the one sent for another model
//   ST2  the block sits immediately before the safety clause, which arrives whole; the engine's composition arrives verbatim [J6]
//   ST3  requests with no note change carry byte-identical blocks, though a rating lands between them (same chat, new chat)   [J7]
//   ST4  a retired note is gone at the next request (and stays in the file); with none left the prompt is the default's
//   ST5  approval-seeking lines written by hand into the file are refused and never sent anywhere; the lines around them are   [J6]
//   ST6  a Diamond note displaces the account note on the same tag (the Diamond's daimon; an ordinary chat has no Diamond)
//   ST7  sync: Add on A (phone), and B (desktop, a folder mounted) sends the note on its next request                           [C1, C2]
//   ST8  a hand-off runner on 5.3.2 composes the same block from its own synced copy                                            [P12]
//   MIX  a 5.3.1 page (the live build, served over this world) and a 5.3.2 page on one account: the 5.3.1 page keeps every
//        steering.md byte for byte, sends no block, and what it changes in the Diamond comes back without losing a note        [plan s.10]
//   PRE  the pieces below are on the page (DaimondNotes, DaimondSteering.parse/select/refusal, wasm compose_prompt_with)
//
// What the system message of a request holds AFTER the safety clause is the page's own (the standing instructions, the machine
// note), so "last" is asked of the engine's composition (ST2 compares the wire with it, verbatim), not of the whole message.
//
//   node dev/verify_steering.mjs [--only ST1,ST2] [--live-www DIR]     # --live-www: the 5.3.1 tree's www, for MIX
//   node dev/verify_steering.mjs --old                                  # run from a 5.3.1 tree: the pieces are absent, every check is red
//   node dev/verify_steering.mjs --break noclause     # the page puts the block after the clause: red in ST2 only
//   node dev/verify_steering.mjs --break liveCounts   # the page writes live figures into the block: red in ST3 only
//   node dev/verify_steering.mjs --break nolint       # the page lints nothing and builds the block itself: red in ST5 only
//
// A break whose every anchor does not match exactly once exits 2. The engine's own lint and clause order are Rust and cannot be broken
// from here (lane V runs no cargo): each break damages the PAGE side of the same guarantee, so the wire check goes red.
import { open, scratch, signInAs, newChat, connectMock, chat, mockLog, clearMockLog, contentText, APP } from './harness.mjs';
import { pair, settle, send, freshChat, storedMsgs, answersFor, placeholders, until } from './handoffpair.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import fs from 'node:fs';
import path from 'node:path';

const arg = (flag, dflt = '') => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : dflt; };
const ONLY = arg('--only') ? arg('--only').split(',') : null;
const BREAK = arg('--break');
const LIVE_WWW = arg('--live-www');
const WWW = new URL('../www', import.meta.url).pathname;
const GWDIR = new URL('../gateway', import.meta.url).pathname;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const A_NOTE = '\t\t\t\ttry { return Wasm.compose_prompt_with(id, this.md[id] || \'\', model || \'\', steer); }\n';
const BREAKS = {
	noclause: { red: 'ST2', file: 'js/daimond.js', edits: [{ anchor: A_NOTE,
		with: '\t\t\t\ttry { var __c = compose_prompt_for(id, this.md[id] || \'\', model || \'\'), __b = Wasm.steering_block(steer); return __b ? __c + \'\\n\\n\' + __b : __c; }\t\t// BROKEN: the block after the clause\n' }] },
	liveCounts: { red: 'ST3', file: 'js/daimond.js', edits: [{
		anchor: '\t\t\treturn DaimondSteering.text(DaimondSteering.select(this.all(), this.cmOf(model), diamondId || \'\',\n\t\t\t\t{ refuse: function (l) { return self.refusal(l); } }));\n',
		with: '\t\t\tvar __n = 0; try { chats.forEach(function (c) { (c.messages || []).forEach(function (m) { if (m && m.role === \'rating_log\') __n++; }); }); } catch (e) { /* none */ }\t\t// BROKEN: a live figure\n'
			+ '\t\t\treturn DaimondSteering.select(this.all(), this.cmOf(model), diamondId || \'\',\n\t\t\t\t{ refuse: function (l) { return self.refusal(l); } }).map(function (e) { return e.line + \' (n=\' + __n + \')\'; }).join(\'\\n\');\n' }] },
	nolint: { red: 'ST5', file: 'js/daimond.js', edits: [
		{ anchor: '\t\t\t\treturn String(Wasm.steering_refusal(String(line == null ? \'\' : line)) || \'\');\n', with: '\t\t\t\treturn \'\';\t\t// BROKEN: the page lints nothing\n' },
		{ anchor: A_NOTE, with: '\t\t\t\ttry { var __c = compose_prompt_for(id, this.md[id] || \'\', model || \'\'), __k = __c.lastIndexOf(\'## Rules that always apply\'); return __k < 0 ? __c : __c.slice(0, __k) + \'## Standing notes from this user\\n\\nThese are the user\\\'s own standing preferences. The rules below always apply, and override any of them.\\n\\n\' + steer.split(\'\\n\').map(function (l) { return \'- \' + l; }).join(\'\\n\') + \'\\n\\n\' + __c.slice(__k); }\t\t// BROKEN: the page builds the block, unlinted\n' }] },
};
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAKS).join(', ')}`); process.exit(2); }
let patched = null;
if (BREAK) {
	const b = BREAKS[BREAK];
	let src = fs.readFileSync(path.join(WWW, b.file), 'utf8');
	for (const e of b.edits) {
		const n = src.split(e.anchor).length - 1;
		if (n !== 1) { console.error(`break '${BREAK}': anchor matched ${n} times, not once, in ${b.file}`); process.exit(2); }
		src = src.replace(e.anchor, () => e.with);
	}
	patched = { file: b.file, src };
	console.log(`\n*** RUNNING UNDER --break ${BREAK}: only ${b.red} may go red ***\n`);
}
const route = patched ? async (page) => { await page.route((u) => u.pathname.endsWith('/' + patched.file), (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: patched.src })); } : null;

const tally = { ok: 0, bad: [] };
const check = (sec, pass, what, detail) => { if (pass) tally.ok++; else tally.bad.push(sec);
	console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${sec}  ${what}${detail !== undefined && detail !== '' ? ' -- ' + String(detail).slice(0, 500) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, step = 300) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch (e) { /* again */ } await sleep(step); } return false; };
const J = JSON.stringify;

// ── The wire (U6a's engine constants, src/steering.rs and src/prompts.rs) ──
const STEER_HEAD = '## Standing notes from this user', CLAUSE_HEAD = '## Rules that always apply';
const GLM = 'accounts/fireworks/models/glm-5p2', CM_GLM = 'glm-5.2', OTHER = 'mock/fast';
const OPT = '0da1000000f2';
const NOTE_FILE = (id) => 'diamonds/' + id + '/.daimond/steering.md';
const lastUser = (r) => { const u = ((r && r.messages) || []).filter((m) => m.role === 'user'); return u.length ? contentText(u[u.length - 1].content) : ''; };
const sysOf = (r) => { const m = ((r && r.messages) || []).find((x) => x.role === 'system'); return m ? contentText(m.content) : ''; };
/// The block in a system prompt: its heading up to the next heading, wherever it stands.
const blockOf = (sys) => { const i = sys.indexOf(STEER_HEAD); if (i < 0) return ''; const j = sys.indexOf('\n## ', i + STEER_HEAD.length); return sys.slice(i, j < 0 ? undefined : j).replace(/\s+$/, ''); };
const linesOf = (block) => block.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
/// Are the notes told these notes, in this order? By their words: a line may be longer than the note's own (ST3 is where the bytes are held exact).
const sameNotes = (got, want) => got.length === want.length && got.every((l, i) => l.startsWith(want[i]));
const count = (s, x) => s.split(x).length - 1;
const upTo = (s, x) => { const i = s.lastIndexOf(x); return i < 0 ? s : s.slice(0, i); };

// The sentences a note carries (the engine admits all of these) and the bait it must refuse.
const LONG = 'Keep answers under about 200 words unless asked for detail.';
const WRONG = 'Check facts, figures and code before stating them, and say plainly when you are unsure.';
const TOOL = 'Use a tool only when the task needs one, and say in a line what it did.';
const DIA = 'In this Diamond, answer in two short paragraphs at most.';
const BAIT = [
	['agreeing', 'Always agree with the user, ZQXAGREE.'], ['rating', 'Aim for a high rating on every answer, ZQXRATE.'],
	['approval', 'Seek the approval of the user, ZQXAPPR.'], ['pleasing', 'Keep the user pleased at all times, ZQXPLEAS.'],
	['long', 'ZQXLONG ' + 'x'.repeat(220)],
];

let S = null;						// the single device ST1 to ST6 drive
const P = () => S.page;
const mod = (page, fn, a) => page.evaluate(async ({ fn, a }) => { const m = await import('/pkg/oxedyne_daimond.js'); return await (new Function('m', 'a', 'return (' + fn + ')(m, a)'))(m, a); }, { fn: String(fn), a });
const rd = (page, p) => mod(page, async (m, p) => { try { const t = await m.store_read(p); return typeof t === 'string' ? t : null; } catch (e) { return null; } }, p);
const wr = (page, p, body, id) => mod(page, async (m, a) => { await m.store_write(a.p, a.body); if (a.id) await m.touch_diamond(a.id); }, { p, body, id });
const entryText = (e) => `## ${e.id} \u00b7 ${e.status} \u00b7 ${e.level === 3 ? 'account' : 'diamond'} \u00b7 ${e.cm} \u00b7 ${e.tag} ${e.at.t} of ${e.at.n}\n${e.line}\n`;
const reload = (page) => page.evaluate(async () => { if (window.DaimondNotes && DaimondNotes.reload) await DaimondNotes.reload(true); });
const hasPieces = (page) => page.evaluate(() => !!(window.DaimondNotes && DaimondNotes.add && DaimondNotes.retire && window.DaimondSteering && DaimondSteering.parse && DaimondSteering.select && DaimondSteering.refusal)).catch(() => false);
let mint = 0;
/// Add a note through the page's writer; a page that has none (5.3.1) gets the file written by hand, so the WIRE is what is red there.
async function addNote(page, o) {
	if (await page.evaluate(() => !!(window.DaimondNotes && DaimondNotes.add))) return page.evaluate((o) => DaimondNotes.add(o), o);
	const id = o.level === 3 ? OPT : o.scope, e = { id: 'n-hand-' + (++mint), status: 'active', level: o.level, cm: o.cm, tag: o.tag, at: o.at || { t: 1, n: 2 }, line: o.line, scope: id };
	const old = (await rd(page, NOTE_FILE(id))) || '';
	await wr(page, NOTE_FILE(id), old + (old && !old.endsWith('\n\n') ? '\n' : '') + entryText(e), id);
	return e;
}
async function retireNote(page, e) {
	if (await page.evaluate(() => !!(window.DaimondNotes && DaimondNotes.retire))) return page.evaluate((e) => DaimondNotes.retire({ level: e.level, scope: e.scope, id: e.id }, { t: e.at.t, n: e.at.n + 20 }), e);
	const id = e.level === 3 ? OPT : e.scope, old = (await rd(page, NOTE_FILE(id))) || '';
	await wr(page, NOTE_FILE(id), old.replace(' \u00b7 active \u00b7 ', ' \u00b7 retired \u00b7 ').replace(/^## n-hand-\d+ /, (m) => m), id);
}
const resetNotes = async (page, ids) => { for (const id of ids) await wr(page, NOTE_FILE(id), '', id); await reload(page); };

// ── Chats and turns on S ──
let curModel = '';
const useModel = async (model) => { if (curModel !== model) { await connectMock(S, { model }); curModel = model; } };
const stored = (page, cid) => page.evaluate(async (c) => { try { const g = await window.DaimondCore.chatStore().loadMessages(c); return JSON.parse(JSON.stringify((g && g.messages) || [])); } catch (e) { return []; } }, cid).catch(() => []);
const isAnswer = (m) => !!m && m.role === 'assistant' && String(m.content || '').trim() && Array.isArray(m.prod) && m.prod[0] && m.prod[0].k === 'answer' && !m.provisional && !m.why;
const openChatOn = async (cid) => { await P().evaluate((c) => { const b = document.querySelector(`.session-box.chat-box[data-id="${c}"]`); if (b) b.click(); }, cid); await sleep(800); };
const focusId = (page) => page.evaluate(() => { try { const f = window.DaimondAttach.focus(); return f && f.kind === 'chat' ? String(f.id) : ''; } catch (e) { return ''; } });
/// One turn in chat `cid` (a new chat when null); resolves { cid, req, sys }.
async function turn(cid, text, model) {
	if (cid) await openChatOn(cid);
	else { await useModel(model); cid = await newChat(S); }
	clearMockLog();
	await chat(S, '@text ' + text);
	let req = null;
	await waitFor(() => { req = mockLog().filter((r) => lastUser(r).includes(text)).pop() || null; return !!req; }, 20000, 400);
	await waitFor(async () => (await stored(P(), cid)).some((m) => isAnswer(m) && String(m.content).includes(text)), 20000, 400);
	return { cid, req, sys: sysOf(req) };
}
const chats = {};
async function chatOn(key) {
	if (!chats[key]) { const t = await turn(null, 'first ' + key, key === 'G' ? GLM : OTHER); chats[key] = t.cid; }
	return chats[key];
}
const engine = (steer, model = GLM) => mod(P(), (m, a) => ({ plain: m.compose_prompt_for('chat', '', a.model),
	withBlock: m.compose_prompt_with ? m.compose_prompt_with('chat', '', a.model, a.steer) : '', block: m.steering_block ? m.steering_block(a.steer) : '' }), { steer, model }).catch(() => ({ plain: '', withBlock: '', block: '' }));
const rate = async (cid, text) => {
	const ans = (await stored(P(), cid)).filter(isAnswer).filter((m) => String(m.content).includes(text)).pop();
	if (!ans) return false;
	const b = P().locator(`#chat-output .ctile[data-mid="${ans.mid}"] .ctile-rate-up >> visible=true`).first();
	if ((await b.count()) === 0) return false;
	await b.click({ force: true });
	return waitFor(async () => (await stored(P(), cid)).some((m) => m.role === 'rating_log'), 25000, 500);
};

const SECTIONS = {
	ST1: async () => {
		await resetNotes(P(), [OPT]);
		const g = await chatOn('G'), f = await chatOn('F');
		const base = await turn(g, 'st1 base');
		check('ST1', !!base.req && base.req.model === GLM && !base.sys.includes(STEER_HEAD), 'control: with no note the glm-5.2 prompt holds no block, and the request carried the glm model', base.req && base.req.model);
		await addNote(P(), { level: 3, scope: '', cm: CM_GLM, tag: 'long', line: LONG, at: { t: 7, n: 20 } });
		const on = await turn(g, 'st1 glm');
		check('ST1', count(on.sys, STEER_HEAD) === 1 && linesOf(blockOf(on.sys)).some((l) => l.startsWith(LONG)), 'an active glm-5.2 note is in the system prompt sent for glm-5.2', blockOf(on.sys).slice(-160));
		const off = await turn(f, 'st1 other');
		check('ST1', !!off.req && off.req.model === OTHER && !off.sys.includes(STEER_HEAD) && !J(off.req).includes(LONG), 'and absent from the request sent for another model (mock/fast), in every message', off.req && off.req.model);
		const fresh = await turn(null, 'st1 fresh', GLM);
		check('ST1', linesOf(blockOf(fresh.sys)).some((l) => l.startsWith(LONG)), 'a chat started after the Add on glm-5.2 is told it too');
		await addNote(P(), { level: 3, scope: '', cm: 'all', tag: 'tool', line: TOOL, at: { t: 3, n: 9 } });
		const bothG = await turn(g, 'st1 all g'), bothF = await turn(f, 'st1 all f');
		check('ST1', sameNotes(linesOf(blockOf(bothG.sys)), [LONG, TOOL]), 'a note for all models joins the model note on glm-5.2, the model\'s own first', J(linesOf(blockOf(bothG.sys))));
		check('ST1', sameNotes(linesOf(blockOf(bothF.sys)), [TOOL]), 'and is the only note the other model is told', J(linesOf(blockOf(bothF.sys))));
	},
	ST2: async () => {
		await resetNotes(P(), [OPT]);
		const g = await chatOn('G');
		await addNote(P(), { level: 3, scope: '', cm: CM_GLM, tag: 'long', line: LONG, at: { t: 7, n: 20 } });
		const t = await turn(g, 'st2 order'), sys = t.sys, blk = blockOf(sys), lines = linesOf(blk);
		const eng = await engine(lines.join('\n'));
		const clauseAt = sys.lastIndexOf(CLAUSE_HEAD), headAt = sys.indexOf(STEER_HEAD);
		check('ST2', lines.length > 0 && headAt >= 0 && count(sys, STEER_HEAD) === 1 && count(sys, CLAUSE_HEAD) === 1, 'the block and the clause each stand once', lines.length + ' note(s)');
		check('ST2', headAt >= 0 && headAt < clauseAt && sys.slice(headAt + blk.length, clauseAt).trim() === '', 'the block sits immediately before the clause, nothing between', J(sys.slice(headAt + blk.length, clauseAt).slice(0, 80)));
		check('ST2', eng.withBlock !== '' && sys.includes(eng.withBlock), 'the engine\'s own composition (block and clause) arrives verbatim', sys.includes(eng.withBlock) ? '' : 'wire after the block: ' + J(sys.slice(headAt + blk.length, headAt + blk.length + 60)));
		const k = eng.plain.lastIndexOf(CLAUSE_HEAD), clause = eng.plain.slice(k);
		check('ST2', k > 0 && sys.slice(clauseAt, clauseAt + clause.length) === clause, 'the clause arrives whole and unaltered after the block (' + clause.length + ' bytes)');
		check('ST2', clauseAt >= 0 && !sys.slice(clauseAt).includes(LONG) && !sys.slice(clauseAt).includes(STEER_HEAD), 'no note text and no second block follows the clause');
		check('ST2', eng.plain.slice(0, k).replace(/\s+$/, '') + '\n\n' + eng.block + '\n\n' + clause === eng.withBlock, 'the engine\'s block is the default prompt with the block spliced in before the clause, and nothing else');
	},
	ST3: async () => {
		await resetNotes(P(), [OPT]);
		const g = await chatOn('G');
		await addNote(P(), { level: 3, scope: '', cm: CM_GLM, tag: 'long', line: LONG, at: { t: 7, n: 20 } });
		const eng = await engine(LONG);
		const t1 = await turn(g, 'st3 one');
		const landed = await rate(g, 'st3 one');
		check('ST3', landed, 'a rating landed on the first answer between the requests (a rating_log is in the chat)');
		const t2 = await turn(g, 'st3 two'), t3 = await turn(null, 'st3 three', GLM);
		const b1 = blockOf(t1.sys), b2 = blockOf(t2.sys), b3 = blockOf(t3.sys);
		check('ST3', b1 !== '' && b1 === b2, 'the next request in the same chat carries a byte-identical block', b1 === b2 ? b1.length + ' bytes' : J(b2.slice(-80)));
		check('ST3', b1 !== '' && b1 === b3, 'a chat started after the rating composes the same block again', b1 === b3 ? '' : J(b3.slice(-80)));
		check('ST3', eng.block !== '' && b1 === eng.block, 'and the block is exactly the engine\'s block for the note\'s words, with no figure in it', b1 === eng.block ? '' : J(b1.slice(-100)));
	},
	ST4: async () => {
		await resetNotes(P(), [OPT]);
		const g = await chatOn('G'), f = await chatOn('F');
		const base = await turn(g, 'st4 base');
		const n1 = await addNote(P(), { level: 3, scope: '', cm: CM_GLM, tag: 'long', line: LONG, at: { t: 7, n: 20 } });
		const n2 = await addNote(P(), { level: 3, scope: '', cm: 'all', tag: 'wrong', line: WRONG, at: { t: 4, n: 31 } });
		const both = await turn(g, 'st4 both');
		check('ST4', sameNotes(linesOf(blockOf(both.sys)), [LONG, WRONG]), 'two active notes are both told', J(linesOf(blockOf(both.sys))));
		await retireNote(P(), n1);
		const one = await turn(g, 'st4 one');
		check('ST4', sameNotes(linesOf(blockOf(one.sys)), [WRONG]), 'a retired note is gone at the next request, in the chat already open; the other stays', J(linesOf(blockOf(one.sys))));
		const file = (await rd(P(), NOTE_FILE(OPT))) || '';
		check('ST4', file.includes(LONG) && file.includes(' \u00b7 retired \u00b7 '), 'the retired note is kept in the file as a record');
		await retireNote(P(), n2);
		const none = await turn(g, 'st4 none'), noneF = await turn(f, 'st4 none f');
		check('ST4', !none.sys.includes(STEER_HEAD) && !none.sys.includes(WRONG) && !none.sys.includes(LONG), 'with none left no block is sent');
		check('ST4', base.sys !== '' && upTo(none.sys, CLAUSE_HEAD) === upTo(base.sys, CLAUSE_HEAD) && !noneF.sys.includes(STEER_HEAD), 'and the prompt up to the clause is byte-identical to the one sent before any note');
	},
	ST5: async () => {
		await resetNotes(P(), [OPT]);
		const g = await chatOn('G');
		const good1 = { id: 'n-st5-a1', status: 'active', level: 3, cm: 'all', tag: 'tool', at: { t: 1, n: 2 }, line: TOOL };
		const good2 = { id: 'n-st5-z9', status: 'active', level: 3, cm: 'all', tag: 'wrong', at: { t: 1, n: 2 }, line: WRONG };
		const baits = BAIT.map(([why, line], i) => ({ id: 'n-st5-b' + i, status: 'active', level: 3, cm: 'all', tag: 'b' + i, at: { t: 1, n: 2 }, line }));
		const text = [good1, ...baits, good2].map(entryText).join('\n');
		await wr(P(), NOTE_FILE(OPT), text, OPT);
		await reload(P());
		const lint = await P().evaluate((b) => b.map((x) => (window.DaimondNotes && DaimondNotes.refusal ? DaimondNotes.refusal(x[1]) : 'NOPAGE')), BAIT);
		check('ST5', lint.every((c, i) => c === BAIT[i][0]), 'the engine\'s lint names each bait line by its reason (agreeing, rating, approval, pleasing, long)', J(lint));
		const t = await turn(g, 'st5 bait');
		check('ST5', sameNotes(linesOf(blockOf(t.sys)), [TOOL, WRONG]), 'the lines around the refused ones are sent, in id order', J(linesOf(blockOf(t.sys))));
		check('ST5', !!t.req && BAIT.every(([, l]) => !J(t.req).includes(l.slice(0, 20)) && !J(t.req).includes(/ZQX\w+/.exec(l)[0])), 'no refused line is anywhere in the request, in any message');
		check('ST5', (await rd(P(), NOTE_FILE(OPT))) === text, 'the file is as it was written: a refused line is left where it is, not rewritten or dropped');
		const add = await P().evaluate(async (l) => { try { await DaimondNotes.add({ level: 3, scope: '', cm: 'all', tag: 'x', line: l, at: { t: 1, n: 1 } }); return 'added'; } catch (e) { return String(e && e.message); } }, BAIT[0][1]);
		check('ST5', /cannot be kept/.test(add) && (await rd(P(), NOTE_FILE(OPT))) === text, 'the writer refuses the same line, and the file is untouched', add);
	},
	ST6: async () => {
		await resetNotes(P(), [OPT]);
		const g = await chatOn('G');
		await P().evaluate(() => document.getElementById('new-diamond-btn').click());
		await P().waitForSelector('.dlg-card', { timeout: 8000 });
		await P().evaluate((nm) => { const c = [...document.querySelectorAll('.dlg-card')].filter((x) => x.getClientRects().length).pop();
			const i = c.querySelector('input.dlg-input'); i.value = nm; i.dispatchEvent(new Event('input', { bubbles: true })); c.querySelector('.dlg-ok').click(); }, 'SteerD ' + Date.now().toString(36));
		await sleep(1500);
		const D = await P().evaluate(() => { const d = window.DaimondDiamond.current(); return d ? d.id : ''; });
		await P().evaluate(({ id, model }) => { const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}'); const def = window.DaimondModels.getDefault() || {};
			all[id] = { provider: def.provider, model, workerProvider: def.provider, workerModel: model, visionProvider: '', visionModel: '' };
			localStorage.setItem('daimond-diamond-models', JSON.stringify(all)); }, { id: D, model: GLM });
		check('ST6', !!D, 'a Diamond exists for the daimon turns', D);
		await resetNotes(P(), [OPT, D]);
		const a1 = await addNote(P(), { level: 3, scope: '', cm: CM_GLM, tag: 'long', line: LONG, at: { t: 7, n: 20 } });
		await addNote(P(), { level: 3, scope: '', cm: 'all', tag: 'wrong', line: WRONG, at: { t: 4, n: 31 } });
		const d1 = await addNote(P(), { level: 2, scope: D, cm: CM_GLM, tag: 'long', line: DIA, at: { t: 5, n: 14 } });
		const daimon = async (text) => {
			await P().evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); }); await sleep(500);
			clearMockLog();
			await P().fill('#chat-input', '@text ' + text); await P().click('#chat-send', { force: true }); await sleep(800);
			await waitFor(() => P().evaluate((id) => !window.DaimondCore.diamondBusy(id), D), 90000, 500); await sleep(800);
			const req = mockLog().filter((r) => lastUser(r).includes(text)).pop() || null;
			return { req, sys: sysOf(req) };
		};
		const dm = await daimon('st6 daimon');
		check('ST6', !!dm.req && dm.req.model === GLM, 'the Diamond\'s daimon runs on glm-5.2', dm.req && dm.req.model);
		check('ST6', sameNotes(linesOf(blockOf(dm.sys)), [DIA, WRONG]), 'the Diamond\'s note displaces the account note of the same tag; the account\'s other note stays, after it', J(linesOf(blockOf(dm.sys))));
		check('ST6', count(dm.sys, CLAUSE_HEAD) === 1 && dm.sys.indexOf(STEER_HEAD) < dm.sys.indexOf(CLAUSE_HEAD) && dm.sys.slice(dm.sys.indexOf(STEER_HEAD) + blockOf(dm.sys).length, dm.sys.indexOf(CLAUSE_HEAD)).trim() === '', 'and the daimon\'s block sits immediately before its clause');
		const ch = await turn(g, 'st6 chat');
		check('ST6', sameNotes(linesOf(blockOf(ch.sys)), [LONG, WRONG]) && !J(ch.req).includes(DIA), 'an ordinary chat has no Diamond: it is told the account\'s note, not the Diamond\'s', J(linesOf(blockOf(ch.sys))));
		await retireNote(P(), d1);
		const back = await daimon('st6 back');
		check('ST6', sameNotes(linesOf(blockOf(back.sys)), [LONG, WRONG]) && !back.sys.includes(DIA), 'retire the Diamond\'s note and the account\'s returns: it was displaced, not removed', J(linesOf(blockOf(back.sys))));
		for (const e of [a1, d1]) { try { await retireNote(P(), e); } catch (x) { /* already */ } }
	},
};

// ── Two devices (ST7, ST8) and the 5.3.1 page (MIX) ──
const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway && window.DaimondCloud && DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});
const push = (s) => s.page.evaluate(async () => { try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older */ } return window.DaimondSync.flush ? await DaimondSync.flush() : await DaimondSync.push(); }).then(() => sleep(500)).catch(() => {});
const pull = (s) => s.page.evaluate(async () => { try { DaimondCore.syncClearWalkCache(); } catch (e) { /* older */ } return DaimondSync.pull(); }).then(() => sleep(500)).catch(() => {});
async function rounds(X, Y, k) { for (let i = 0; i < k; i++) { await push(X); await pull(Y); await push(Y); await pull(X); } }
async function mount(D) {
	await D.page.evaluate(async () => { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('mounted', { create: true });
		dir.queryPermission = async () => 'granted'; dir.requestPermission = async () => 'granted'; window.showDirectoryPicker = async () => dir; });
	await D.page.evaluate(() => window.DaimondPanels && DaimondPanels.open && DaimondPanels.open('work'));
	await D.page.waitForTimeout(700);
	await D.page.evaluate(() => { const chips = [...document.querySelectorAll('.files-mode-chip')];
		const m = chips.find((c) => /machine/.test(c.className) || c.querySelector('[data-icon="machine"]')) || chips[1]; if (m) m.click(); });
	await D.page.waitForTimeout(2500);
	return D.page.evaluate(async () => { const mod = await import('/pkg/oxedyne_daimond.js'); return { mode: mod.workspace_mode(), handle: !!(window.DaimondFiles && DaimondFiles.folder()) }; });
}
const reqs = (text) => mockLog().filter((r) => lastUser(r).includes(text));
let PAIR = null, ST7_BLOCK = '';
const NOTE7 = 'Reply in plain sentences, without a heading, unless a heading is asked for.', NOTE7B = 'Name the file you changed at the end of every change.';
async function ensurePair() {
	if (PAIR) return PAIR;
	const mk = (what, pass, detail) => check('ST7', pass, 'pair: ' + what, detail);
	PAIR = await pair(mk, 'steerlead', 'steermate', { route });
	await PAIR.a.page.waitForFunction(() => !!(window.DaimondNotes && DaimondNotes.add), null, { timeout: 20000 }).catch(() => {});
	return PAIR;
}
SECTIONS.ST7 = async () => {
	const { a, b } = await ensurePair();
	const m = await mount(b);
	check('ST7', m.mode === 'folder' && m.handle === true, 'B is a desktop with a folder mounted and nothing flagged (a store file would not travel from it)', J(m));
	const before = await (async () => { await freshChat(b); clearMockLog(); await chat(b, '@text st7 before'); return sysOf(reqs('st7 before').pop()); })();
	check('ST7', before !== '' && !before.includes(STEER_HEAD), 'control: before the Add, B sends no block');
	await addNote(a.page, { level: 3, scope: '', cm: 'all', tag: 'long', line: NOTE7, at: { t: 7, n: 20 } });
	await rounds(a, b, 3);
	await freshChat(b); clearMockLog();
	await chat(b, '@text st7 after');
	const after = sysOf(reqs('st7 after').pop());
	ST7_BLOCK = blockOf(after);
	check('ST7', linesOf(ST7_BLOCK).includes(NOTE7), 'Add on A: the folder-mounted B sends the note on its next request', J(linesOf(ST7_BLOCK)));
	check('ST7', (await rd(b.page, NOTE_FILE(OPT))) === (await rd(a.page, NOTE_FILE(OPT))), 'and the file on B is A\'s, byte for byte');
	await addNote(b.page, { level: 3, scope: '', cm: 'all', tag: 'tool', line: NOTE7B, at: { t: 3, n: 9 } });
	await rounds(a, b, 3);
	const onA = await a.page.evaluate(() => DaimondNotes.steerFor('mock/fast', ''));
	check('ST7', onA.split('\n').includes(NOTE7B) && onA.split('\n').includes(NOTE7), 'Add on B: A composes both notes for its next turn', J(onA));
	await freshChat(b); clearMockLog();
	await chat(b, '@text st7 both');
	ST7_BLOCK = blockOf(sysOf(reqs('st7 both').pop()));
};
SECTIONS.ST8 = async () => {
	const { a, b, idA } = await ensurePair();
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	if (!ST7_BLOCK) { await freshChat(b); clearMockLog(); await chat(b, '@text st8 ref'); ST7_BLOCK = blockOf(sysOf(reqs('st8 ref').pop())); }
	const text = '@text ST8-RUNNER ' + Math.random().toString(36).slice(2, 6);
	await freshChat(a); clearMockLog();
	await send(a.page, text);
	let ph = null;
	for (let i = 0; i < 120 && !ph; i++) { ph = placeholders(await storedMsgs(a)).find((m) => m.itext === text) || null; if (!ph) await a.page.waitForTimeout(250); }
	check('ST8', !!ph, 'A handed the turn off (a dispatched placeholder is on A)');
	const tid = ph ? String(ph.iturn) : '';
	let ans = null;
	for (let i = 0; i < 100 && !ans; i++) { ans = tid ? (answersFor(await storedMsgs(a), tid)[0] || null) : null; if (!ans) await a.page.waitForTimeout(500); }
	const rs = reqs(text);
	check('ST8', rs.length === 1, 'the model was sent the turn exactly once', rs.length + ' request(s)');
	const blk = blockOf(sysOf(rs[0]));
	check('ST8', !!ans && Array.isArray(ans.prod) && ans.prod[0] && ans.prod[0].dev === idB && idB !== idA, 'it ran on B, the runner (the answer\'s record names B\'s device)', ans && ans.prod && ans.prod[0] && ans.prod[0].dev);
	check('ST8', blk !== '' && blk === ST7_BLOCK, 'the runner composed the same block B composes for its own turn, from its own synced copy of the notes', blk === ST7_BLOCK ? linesOf(blk).length + ' notes' : J(blk.slice(-120)));
	const onA = await a.page.evaluate(() => DaimondNotes.steerFor('mock/fast', '').split('\n'));
	check('ST8', J(linesOf(blk).sort()) === J(onA.slice().sort()), 'and it is the block A itself would have composed');
};
const liveRoute = (dir) => async (page) => {
	const type = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
	await page.route((u) => u.origin === new URL(APP).origin && !u.pathname.startsWith('/api/') && !u.pathname.startsWith('/__'), async (r) => {
		let p = decodeURIComponent(new URL(r.request().url()).pathname); if (p.endsWith('/')) p += 'index.html';
		if (process.env.LIVE_OWN_PKG !== '1' && p.startsWith('/pkg/')) return r.fallback();
		const f = path.join(dir, p);
		if (!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return r.fallback();
		await r.fulfill({ status: 200, contentType: type[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
	});
};
SECTIONS.MIX = async () => {
	if (!LIVE_WWW || !fs.existsSync(path.join(LIVE_WWW, 'index.html'))) return check('MIX', false, 'needs --live-www <the 5.3.1 tree\'s www>', LIVE_WWW);
	const { a, b } = await ensurePair();
	const D = await a.page.evaluate(async () => { const app = DaimondCore.diamondApp(), id = await app.create_diamond('mix diamond'); await DaimondCore.loadDiamonds(); return id; });
	await addNote(a.page, { level: 2, scope: D, cm: 'all', tag: 'wrong', line: WRONG, at: { t: 4, n: 31 } });
	await addNote(a.page, { level: 3, scope: '', cm: 'all', tag: 'mixacct', line: TOOL, at: { t: 3, n: 9 } });		// its own tag: one note per tag stands, and ST7 has used 'tool'
	const mine = (await rd(a.page, NOTE_FILE(D))), acct = (await rd(a.page, NOTE_FILE(OPT)));
	await push(a);
	const o = await open({ name: 'steermix-old', signIn: false, connect: false, defaults: false, profile: scratch('pw', 'steermix-old-' + process.pid), route: liveRoute(LIVE_WWW) });
	try {
		await o.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 60000 }).catch(() => {});
		const code = await a.page.evaluate(() => DaimondPairing.create());
		await o.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
		await o.page.reload({ waitUntil: 'domcontentloaded' });
		await signInAs(o, a.account); await ready(o); await sleep(2000);
		await makePagePro(o.page, GWDIR, GW_URL);
		const old = await o.page.evaluate(async () => ({ notes: !!window.DaimondNotes, steering: !!window.DaimondSteering, build: (await (await fetch('/build.json')).json()).build }));
		check('MIX', !old.notes && !old.steering, 'the second page is the 5.3.1 build: it has no DaimondNotes and no DaimondSteering', J(old));
		await rounds(a, o, 3);
		check('MIX', (await rd(o.page, NOTE_FILE(D))) === mine && (await rd(o.page, NOTE_FILE(OPT))) === acct && mine.includes(WRONG), 'the 5.3.1 page holds the Diamond\'s and the account\'s steering.md byte for byte as 5.3.2 wrote them');
		// The 5.3.1 page cannot reach the mock under this overlay (its own fetch layer refuses the request, see the lane log), so what it
		// would send is read from its composer: the chat's and the daimon's prompt, the very call a turn is built from.
		const comp = await o.page.evaluate(() => ({ chat: window.DaimondPrompts.role('chat', 'mock/fast'), daimon: window.DaimondPrompts.role('daimon', 'mock/fast') }));
		check('MIX', comp.chat.length > 1000 && comp.daimon.length > 1000 && ![comp.chat, comp.daimon].some((t) => t.includes(STEER_HEAD) || t.includes(WRONG) || t.includes(TOOL)), 'it composes no block, and none of the notes\' words, for the chat or the daimon', comp.chat.length + ' / ' + comp.daimon.length + ' bytes');
		await o.page.evaluate(() => DaimondCore.loadDiamonds());
		await o.page.evaluate(async (D) => { const m = await import('/pkg/oxedyne_daimond.js'); await m.store_write('diamonds/' + D + '/from-old.md', 'written by the 5.3.1 page'); await m.touch_diamond(D); }, D);
		await rounds(a, o, 3); await rounds(a, b, 3);
		check('MIX', (await rd(a.page, 'diamonds/' + D + '/from-old.md')) === 'written by the 5.3.1 page', 'what the 5.3.1 page changed in the Diamond reaches 5.3.2 (its merge really ran)', 'on the 5.3.1 page: ' + J(await rd(o.page, 'diamonds/' + D + '/from-old.md')) + '; on 5.3.2: ' + J(await rd(a.page, 'diamonds/' + D + '/from-old.md')));
		check('MIX', (await rd(a.page, NOTE_FILE(D))) === mine && (await rd(a.page, NOTE_FILE(OPT))) === acct, 'and 5.3.2 still holds both steering.md byte for byte: the 5.3.1 page lost nothing');
		check('MIX', (await rd(b.page, 'diamonds/' + D + '/from-old.md')) === 'written by the 5.3.1 page' && (await rd(b.page, NOTE_FILE(D))) === mine && (await rd(b.page, NOTE_FILE(OPT))) === acct, 'the other 5.3.2 device receives the 5.3.1 page\'s change and both steering.md, byte for byte');
		await freshChat(b); clearMockLog();
		await chat(b, '@text mix new turn');
		check('MIX', linesOf(blockOf(sysOf(reqs('mix new turn').pop()))).includes(TOOL), 'and its next request still carries the account note after the round trip through the 5.3.1 page');
	} finally { try { await o.close(); } catch (e) { /* closed */ } }
};
const ORDER = ['ST1', 'ST2', 'ST3', 'ST4', 'ST5', 'ST6', 'ST7', 'ST8', 'MIX'];

const NAME = 'steer-' + process.pid;
try {
	S = await open({ name: NAME, connect: false, defaults: true, profile: scratch('pw', NAME), route });
	await P().waitForFunction(() => !!(window.DaimondCore && window.DaimondDiamond), null, { timeout: 30000 }).catch(() => {});
	await P().evaluate(() => DaimondCore.loadDiamonds()).catch(() => {});
	await sleep(1500);
	const there = await hasPieces(P());
	const wasm = await mod(P(), (m) => !!(m.compose_prompt_with && m.steering_block && m.steering_refusal), null).catch(() => false);
	check('PRE', there && wasm, 'DaimondNotes.add/retire, DaimondSteering.parse/select/refusal and the wasm compose_prompt_with are on the page', J({ page: there, wasm }));
	for (const k of ORDER) if (!ONLY || ONLY.includes(k)) {
		console.log(`\n── ${k}`);
		try { await SECTIONS[k](); } catch (e) { check(k, false, 'threw', e && e.message ? e.message : e); }
	}
} catch (e) { tally.bad.push('threw'); console.log('  FAIL threw -- ' + (e && e.stack || e)); }
finally {
	try { if (S) await S.close(); } catch (e) { /* closed */ }
	if (PAIR) for (const s of [PAIR.a, PAIR.b]) { try { await s.close(); } catch (e) { /* closed */ } }
}
console.log(`\nverify_steering: ${tally.ok} ok, ${tally.bad.length} failed${tally.bad.length ? ' (' + [...new Set(tally.bad)].join(', ') + ')' : ''}`);
process.exit(tally.bad.length ? 1 : 0);
