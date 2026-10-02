/* ============================================================
   Test -- the engine's session is a function of the chat's converged messages (D-20261002-08, P4).
   ------------------------------------------------------------
   An engine used to be built once and never brought up to its chat again, so a turn that reached the chat by sync, by
   another tab or by the transcript loading after the engine was built never reached the model. `reconcileEngine` (in
   `ensureApp`) now brings it up at every turn start: an engine that has run nothing is laid in again in place, one that
   has run turns takes `append_message` for each prose message it lacks, and one that lacks a message falling BEFORE its
   last (two devices sent at once) is laid again from the transcript in the chat's order.

   The real `sessionPlan`, `seedEngine`, `armEngine`, `reconcileEngine`, `heldRun`, `heldNote`, `tailAfter` and
   `captureSession` are lifted out of daimond.js by source (`dev/syncprobe.mjs` `sliceDaimond`); the engine is a stand-in
   that keeps its session as the wasm does (`restore` takes prose, `restore_session` takes the stored list with its tool
   messages, `append_message` adds one).

   THE PROPERTY, over random interleavings of two devices that send (a turn is two steps, so a sync lands mid-turn),
   sync either way, reload, open a chat (an idle engine) and redraw: at every turn start the engine's prose is the chat's
   converged prose (by ts, then mid) with each message once, `pre` kept beside a person's message, and no message the chat
   does not hold. One corner is named and counted, not hidden: a RELOAD seeds from the stored session and the position of
   its marker (unchanged), so a message that merged in before the marker and that the engine never held is lost to that
   device's model (a hole, never a duplicate); the property then holds up to the holes, and a re-laying from the
   transcript heals them.

   Run:  node www/js/sessionreconcile.test.mjs [--break noreconcile|appendonly|nohold]
   ============================================================ */
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i >= 0 ? process.argv[i + 1] : ''; })();
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const J = JSON.stringify;

// ── The engine stand-in and the lifted code ──────────────────────────────
class Engine {
	constructor() { this.msgs = []; }
	restore(hist) {
		this.msgs = (hist || []).filter((m) => m && m.content && (m.role === 'user' || m.role === 'assistant'))
			.map((m) => (m.role === 'user' ? { role: 'user', content: m.content, pre: m.pre || '' } : { role: 'assistant', content: m.content }));
	}
	restore_session(msgs) { this.msgs = (msgs || []).map((x) => Object.assign({}, x)); return this.msgs.length; }
	append_message(role, content, pre) {
		if (role === 'user') this.msgs.push({ role, content, pre: pre || '' });
		else if (role === 'assistant') this.msgs.push({ role, content });
	}
	export_session() { return this.msgs.map((x) => Object.assign({}, x)); }
}
const heldBy = new WeakMap();
const stub = { diag(a, b) { if (process.env.DIAG) console.log('diag', a, b); }, dedupeSession: (m) => m, _engineHeld: heldBy };
const NAMES = ['seedEngine', 'armEngine', 'reconcileEngine', 'heldRun', 'heldNote', 'tailAfter', 'captureSession'];
const base = sliceDaimond(makeWindow({}), ['sessionPlan'].concat(NAMES), stub).fns;		// the code as it stands
const sessionPlan = base.sessionPlan;
let F = base;
if (BREAK === 'appendonly') {
	// The order case is not told apart: whatever the engine lacks is added behind what it holds.
	const wrapped = (held, ran, msgs, ex) => { const p = base.sessionPlan(held, ran, msgs, ex); return p.act === 'order' ? { act: 'append', add: p.add } : p; };
	F = sliceDaimond(makeWindow({}), NAMES, Object.assign({}, stub, { sessionPlan: wrapped })).fns;
}
if (BREAK === 'noreconcile') F = Object.assign({}, base, { reconcileEngine: (chat) => chat.app });
if (BREAK === 'nohold') F = Object.assign({}, base, { heldRun: () => {}, heldNote: () => {} });

// ── A chat and its model ─────────────────────────────────────────────────
const isProse = (m) => !!m && !!m.content && (m.role === 'user' || m.role === 'assistant') && !m.interrupted && !m.provisional && !m.framed;
const key = (m) => m.role + '|' + m.content + '|' + (m.role === 'user' ? (m.pre || '') : '');
const prose = (msgs) => (msgs || []).filter(isProse).slice().sort((x, y) => ((x.ts || 0) - (y.ts || 0)) || String(x.mid).localeCompare(String(y.mid)));
const engineProse = (app) => app.msgs.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content);
const engineKeys = (app) => engineProse(app).map(key);
function newChat() { return { id: 'c', messages: [], session: null, app: null, _generating: false, updatedAt: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, lastPrompt: 0 }; }
const sortMsgs = (ms) => ms.slice().sort((x, y) => ((x.ts || 0) - (y.ts || 0)) || String(x.mid).localeCompare(String(y.mid)));
const mergeInto = (to, from) => { const seen = new Set(to.map((m) => m.mid)); const add = from.filter((m) => !seen.has(m.mid)); return add.length ? sortMsgs(to.concat(add)) : to; };
/// `ensureApp`'s two halves, as the page has them: build and arm, or reconcile.
function ensure(chat, exceptMid) {
	if (chat.app) return F.reconcileEngine(chat, exceptMid);
	chat.app = new Engine();
	F.armEngine(chat, exceptMid);
	return chat.app;
}

// ── Examples first ───────────────────────────────────────────────────────
const U = (mid, ts, content, pre) => Object.assign({ role: 'user', mid, ts, content }, pre ? { pre } : {});
const A = (mid, ts, content) => ({ role: 'assistant', mid, ts, content });
const tool = (id) => [{ role: 'assistant', content: '', tool_calls: [{ id, name: 'x', arguments: '{}' }] }, { role: 'tool', content: 'r', tool_call_id: id }];

console.log('sessionPlan (pure)');
{
	const ms = [U('u1', 1, 'q1'), A('a1', 2, 'r1'), U('u2', 3, 'q2'), A('a2', 4, 'r2')];
	check('everything held: none', sessionPlan({ u1: 1, a1: 1, u2: 1, a2: 1 }, true, ms).act === 'none', '');
	check('missing after the last held, engine has run: append, in order', J(sessionPlan({ u1: 1, a1: 1 }, true, ms)) === J({ act: 'append', add: [ms[2], ms[3]] }), '');
	check('missing after the last held, engine idle: seed', sessionPlan({ u1: 1, a1: 1 }, false, ms).act === 'seed', '');
	check('missing BEFORE the last held, engine has run: order', sessionPlan({ u2: 1, a2: 1 }, true, ms).act === 'order', '');
	check('missing before the last held, engine idle: seed (the engine has run nothing to protect)', sessionPlan({ u2: 1, a2: 1 }, false, ms).act === 'seed', '');
	check('the prompt about to be re-sent is not missing', sessionPlan({ u1: 1, a1: 1 }, true, ms, 'u2').add.map((m) => m.mid).join() === 'a2', '');
	check('a partial answer, a streamed one and furniture are not missing',
		sessionPlan({ u1: 1 }, true, [ms[0], Object.assign(A('p', 2, 'half'), { interrupted: true }), Object.assign(A('q', 3, 'half'), { provisional: true }),
			Object.assign(A('r', 4, 'half'), { framed: true }), { role: 'error_log', mid: 'e', ts: 5, content: 'x' }, { role: 'user', mid: 'z', ts: 6, content: '' }]).act === 'none', '');
	check('plan is deterministic and does not mutate its input', (() => { const h = { u1: 1 }, s = J(ms); sessionPlan(h, true, ms); return J(h) === '{"u1":1}' && J(ms) === s; })(), '');
}

console.log('\nreconcileEngine, one case at a time');
{
	// A live engine takes a peer's turn behind its own, with `pre` as the record holds it, and tool messages are kept.
	const c = newChat();
	c.messages = [U('u1', 1, 'q1'), A('a1', 2, 'r1')];
	ensure(c); F.heldRun(c, c.app, 'u2');
	c.messages.push(U('u2', 3, 'q2')); c.app.append_message('user', 'q2'); c.app.msgs.push(...tool('t1'));
	c.app.append_message('assistant', 'r2'); c.messages.push(A('a2', 4, 'r2')); F.heldNote(c, c.app, 'a2');
	F.captureSession(c, c.app);
	c.messages = sortMsgs(c.messages.concat([U('p1', 5, 'peer q', '[note]'), A('p2', 6, 'peer r')]));
	ensure(c);
	check('append: the peer turn is behind the engine\'s own, once, with `pre`', J(engineKeys(c.app)) === J(['user|q1|', 'assistant|r1|', 'user|q2|', 'assistant|r2|', 'user|peer q|[note]', 'assistant|peer r|']), J(engineKeys(c.app)));
	check('append: the tool messages the engine holds are untouched', c.app.msgs.filter((m) => m.role === 'tool').length === 1, '');
	ensure(c); ensure(c);
	check('append: reconciling again adds nothing (idempotent)', engineProse(c.app).length === 6, engineProse(c.app).length + ' messages');
}
{
	// The order case: a message falling before the engine's last is laid from the transcript, in the chat's order.
	const c = newChat();
	c.messages = [U('u1', 1, 'q1'), A('a1', 2, 'r1')];
	ensure(c); F.heldRun(c, c.app, 'u9');
	c.messages.push(U('u9', 9, 'mine')); c.app.append_message('user', 'mine'); c.app.append_message('assistant', 'mine-r'); c.messages.push(A('a9', 10, 'mine-r')); F.heldNote(c, c.app, 'a9');
	c.messages = sortMsgs(c.messages.concat([U('p1', 5, 'theirs'), A('p2', 6, 'theirs-r')]));
	ensure(c);
	check('order: the model reads the chat\'s order, each once', J(engineKeys(c.app)) === J(['user|q1|', 'assistant|r1|', 'user|theirs|', 'assistant|theirs-r|', 'user|mine|', 'assistant|mine-r|']), J(engineKeys(c.app)));
	ensure(c);
	check('order: and it is stable afterwards', engineProse(c.app).length === 6, '');
}
{
	// An idle engine is laid in again IN PLACE (same object), keeping the stored session where the marker covers the gap.
	const c = newChat();
	c.messages = [U('u1', 1, 'q1'), A('a1', 2, 'r1')];
	c.session = { v: 1, msgs: [{ role: 'user', content: 'q1', pre: '' }, ...tool('s1'), { role: 'assistant', content: 'r1' }], upto: 'a1', uptoTs: 2 };
	const e0 = ensure(c);
	check('seed: the build holds the session, tool messages and all', e0.msgs.length === 4 && e0.msgs[2].role === 'tool', e0.msgs.length + ' messages');
	c.messages = sortMsgs(c.messages.concat([U('p1', 5, 'late q', '[n]'), A('p2', 6, 'late r')]));
	const e1 = ensure(c);
	check('seed: the same engine object (consent and taint live on it)', e1 === e0, '');
	check('seed: the stored session is kept and the late turn follows the marker, with `pre`', e1.msgs.length === 6 && e1.msgs[2].role === 'tool' && J(engineKeys(e1).slice(-2)) === J(['user|late q|[n]', 'assistant|late r|']), J(engineKeys(e1)));
	// A message BEFORE the marker cannot ride the session: laid from the transcript.
	c.messages = sortMsgs(c.messages.concat([U('p0', 1.5, 'early q'), A('p0a', 1.6, 'early r')]));
	ensure(c);
	check('seed: a message before the marker is laid from the transcript, in the chat\'s order', J(engineKeys(c.app)) === J(prose(c.messages).map(key)), J(engineKeys(c.app)));
}
{
	// An empty engine built from a chat that had not loaded, then the chat loads (F1).
	const c = newChat();
	ensure(c);
	check('F1: an engine built from nothing holds nothing', c.app.msgs.length === 0, '');
	c.messages = [U('u1', 1, 'q1'), A('a1', 2, 'r1'), U('u2', 3, 'q2'), A('a2', 4, 'r2')];
	ensure(c);
	check('F1: the loaded transcript is laid in at the next turn start', engineKeys(c.app).length === 4, J(engineKeys(c.app)));
}
{
	// exceptMid: the prompt a peer turn is about to send again is neither seeded nor appended.
	const c = newChat();
	c.messages = [U('u1', 1, 'q1'), A('a1', 2, 'r1'), U('d1', 3, 'dispatched')];
	ensure(c, 'd1');
	check('exceptMid: not seeded', engineKeys(c.app).join() === 'user|q1|,assistant|r1|', engineKeys(c.app).join());
	ensure(c, 'd1'); F.heldRun(c, c.app, 'd1'); c.app.append_message('user', 'dispatched');
	ensure(c); ensure(c, 'd1');
	check('exceptMid: nor appended, and once the turn holds it, never again', engineKeys(c.app).filter((k) => k.includes('dispatched')).length === 1, J(engineKeys(c.app)));
}
{
	// Safe moments only: never during a turn or a fold, never on an engine this chat did not build.
	const c = newChat();
	c.messages = [U('u1', 1, 'q1'), A('a1', 2, 'r1')];
	ensure(c); F.heldRun(c, c.app, 'u2');
	c.messages = sortMsgs(c.messages.concat([U('p1', 5, 'peer q'), A('p2', 6, 'peer r')]));
	c._generating = true; ensure(c);
	check('a turn is running: the engine is not touched', engineProse(c.app).length === 2, '');
	c._generating = false; heldBy.set(c.app, [Promise.resolve()]); ensure(c);
	check('a fold or a wire call holds the engine: it is not touched', engineProse(c.app).length === 2, '');
	heldBy.delete(c.app); ensure(c);
	check('and the next turn start takes it', engineProse(c.app).length === 4, '');
	const stranger = newChat(); stranger.messages = [U('u1', 1, 'q')];
	stranger.app = new Engine(); ensure(stranger);
	check('an engine this chat did not build is not touched', stranger.app.msgs.length === 0, '');
}

// ── The property ─────────────────────────────────────────────────────────
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const cov = { scenarios: 0, starts: 0, none: 0, append: 0, seed: 0, order: 0, holes: 0, reloads: 0, midTurnSync: 0, build: 0 };
const bad = [];
function scenario(seed, steps, reloads) {
	const R = rng(seed);
	let now = 10, n = 0;
	const D = [{ name: 'A', chat: newChat(), lost: new Set(), turn: null }, { name: 'B', chat: newChat(), lost: new Set(), turn: null }];
	const tick = () => (now += 1 + Math.floor(R() * 4));
	const fail = (what, d, extra) => bad.push(`seed ${seed} ${d.name}: ${what}${extra ? ' -- ' + extra : ''}`);
	// The judgement at a turn start (and at a redraw): the engine against the chat.
	// A device's `ensure`: a build from the stored session leaves a hole where a message sits BEFORE the session's marker and
	// the stored session does not hold it (the marker is a position; unchanged by this fix, named in the header).
	function ensureD(d, exceptMid) {
		const c = d.chat, had = !!c.app;
		ensure(c, exceptMid);
		if (!had && c.session && Array.isArray(c.session.msgs)) {
			const ps = prose(c.messages), mk = ps.findIndex((m) => m.mid === c.session.upto);
			const sk = new Set(c.session.msgs.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).map((m) => m.role + '|' + m.content + '|' + (m.role === 'user' ? (m.pre || '') : '')));
			if (mk >= 0) ps.forEach((m, i) => { if (i < mk && !sk.has(key(m))) d.lost.add(m.mid); });
		}
	}
	function judge(d, where) {
		const c = d.chat, E = prose(c.messages).map(key), G = engineKeys(c.app);
		const missing = E.filter((k) => !G.includes(k));
		const dup = G.filter((k, i) => G.indexOf(k) !== i);
		const phantom = G.filter((k) => !E.includes(k));
		// Order: what the engine holds is the chat's order restricted to what it holds.
		const inOrder = J(E.filter((k) => G.includes(k))) === J(G);
		if (process.env.TRACE && String(seed) === process.env.TRACE) console.log('  [' + d.name + ' ' + where + '] chat ' + c.messages.map((m) => m.mid + '@' + m.ts).join(' ') + ' | held ' + J(c._held && c._held.mids) + ' ran ' + (c._held && c._held.ran) + ' | engine ' + G.join(' ; ') + ' | lost ' + J([...d.lost]));
		const lostKeys = new Set(prose(c.messages).filter((m) => d.lost.has(m.mid)).map(key));
		const unexplained = missing.filter((k) => !lostKeys.has(k));
		if (dup.length) fail(where + ': duplicates', d, J(dup));
		if (phantom.length) fail(where + ': a message the chat does not hold', d, J(phantom));
		if (!inOrder) fail(where + ': not the chat\'s order', d, 'engine ' + J(G) + ' chat ' + J(E));
		if (unexplained.length) fail(where + ': missing from the model', d, J(unexplained) + ' engine ' + J(G));
		if (!missing.length) d.lost.clear();
		else { cov.holes += 1; d.lost = new Set(prose(c.messages).filter((m) => missing.includes(key(m))).map((m) => m.mid)); }
	}
	for (let s = 0; s < steps; s++) {
		const d = D[Math.floor(R() * 2)], o = D[d === D[0] ? 1 : 0], c = d.chat, roll = R();
		if (roll < 0.30) {					// begin a turn
			if (d.turn) continue;
			const had = !!c.app;
			const plan = had && c._held && c._held.app === c.app ? sessionPlan(c._held.mids, c._held.ran, c.messages) : null;
			ensureD(d); cov.starts++;
			if (!had) cov.build++; else if (plan) cov[plan.act]++;
			judge(d, 'turn start');
			const umid = 'u' + (++n), pre = R() < 0.4 ? '[note ' + n + ']' : '';
			F.heldRun(c, c.app, umid);
			const um = U(umid, tick(), 'q' + n, pre);
			c.messages = c.messages.concat([um]); c.app.append_message('user', um.content, pre || undefined);
			c._generating = true; d.turn = { n, umid };
		} else if (roll < 0.55) {			// end a turn
			if (!d.turn) continue;
			const t = d.turn, k = R() < 0.4;
			if (k) c.app.msgs.push(...tool('t' + t.n));
			const am = A('a' + t.n, tick(), 'r' + t.n);
			c.app.append_message('assistant', am.content);
			c.messages = c.messages.concat([am]); F.heldNote(c, c.app, am.mid);
			F.captureSession(c, c.app);
			c.updatedAt = am.ts; c._generating = false; d.turn = null;
		} else if (roll < 0.80) {			// sync one way
			if (d.turn || o.turn) cov.midTurnSync++;
			const fromMsgs = o.chat.messages;
			const wasGen = c._generating;
			c.messages = mergeInto(c.messages, fromMsgs);
			if (o.chat.session && o.chat.updatedAt > c.updatedAt && !wasGen) c.session = o.chat.session;
			if (!wasGen) c.updatedAt = Math.max(c.updatedAt, o.chat.updatedAt);
		} else if (roll < 0.88) {			// reload
			if (d.turn || !reloads) continue;
			cov.reloads++;
			c.app = null;
		} else if (roll < 0.94) {			// open: an idle engine built from the resident chat
			if (!c.app) { ensureD(d); }
		} else {							// a redraw: the display path asks for the engine
			if (c.app) F.reconcileEngine(c);
		}
	}
	cov.scenarios++;
}
const N = 4000;
for (let seed = 1; seed <= N; seed++) scenario(seed, 40, false);
const strict = { bad: bad.slice(), cov: Object.assign({}, cov) };
bad.length = 0; Object.keys(cov).forEach((k) => { cov[k] = 0; });
for (let seed = 1; seed <= N; seed++) scenario(seed, 40, true);

console.log('\nthe property, ' + N + ' random interleavings of two devices, without a reload, then with');
console.log('  coverage, no reload:   ' + J(strict.cov));
console.log('  coverage, with reload: ' + J(cov));
check('NO RELOAD: at every turn start the engine is the chat\'s converged prose, each message once and in order, nothing missing, nothing extra',
	strict.bad.length === 0 && strict.cov.holes === 0, strict.bad.length + ' violations, ' + strict.cov.holes + ' holes; first: ' + strict.bad.slice(0, 3).join(' || '));
check('NO RELOAD: every branch was exercised: appends, in-place seeds, re-layings in order, builds and syncs that land mid-turn',
	strict.cov.append > 100 && strict.cov.seed > 50 && strict.cov.order > 100 && strict.cov.build > 100 && strict.cov.midTurnSync > 200, J(strict.cov));
check('WITH RELOADS: no duplicate, no message the chat does not hold, always the chat\'s order, and no loss but the named corner (a hole at a build from the stored session)',
	bad.length === 0, bad.length + ' violations; first: ' + bad.slice(0, 3).join(' || '));
check('WITH RELOADS: the reloads happened and a build from the stored session met a hole only where its marker could not tell (counted, not hidden)',
	cov.reloads > 200 && cov.build > 200, J(cov));

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${failures ? failures + ' check(s) failed' : 'NOTHING FAILED, so the checks prove nothing'}`);
	process.exit(failures ? 0 : 1);
}
console.log(failures ? `\n${failures} of ${checks} FAILED` : `\nall ${checks} sessionreconcile checks passed`);
process.exit(failures ? 1 : 0);
