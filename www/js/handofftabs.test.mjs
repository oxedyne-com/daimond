/* ============================================================
   Test — one run of a handed-off turn per DEVICE, not per tab,
   and a handed-off prompt sent to the model once
   (www/js/daimond.js, hand-off QA for 5.1, F1-F3, 2026-09-25).
   ------------------------------------------------------------
   F1: two tabs of the sending device ran a handed-back turn
   twice. `_localRecovering` is one tab's memory, and the lease
   cannot tell two tabs apart (they share the device id), so the
   sending tab's backstop took its sibling's live lease as its
   own and ran the turn again, paid twice.

   F2: focusing an idle tab freed the lease its sibling was
   running under (`releaseOwnStaleLeases` read only this tab's
   `_runnerCtx`), and the sibling aborted a paid turn.

   The fix, one mechanism: every run of a turn on a device holds
   the turn's work claim (post.js `claimWork`, the Web Lock
   `daimond-post-work:turn:<id>` a runner's collect already
   takes). `recoverOneLocally` stands down while another tab holds
   it, and re-seats under it; the self-release takes it before it
   frees a lease.

   F3: `ensureApp` dropped the turn's own message (`exceptMid`)
   only on the no-session path; a chat with a stored session
   appended it from the tail, and `run_turn` sent it again.

   The functions are lifted from the REAL daimond.js and post.js
   by a brace-balanced scan and run in two tabs that share one
   faithful `navigator.locks`; peer.js is loaded whole.

   Run:  node www/js/handofftabs.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const APP  = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const POST = readFileSync(join(HERE, 'post.js'), 'utf8');
const PEER = readFileSync(join(HERE, 'peer.js'), 'utf8');

/// Lifts `function name(...) { ... }` (or `async function`) by counting braces.
function extractFn(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) throw new Error('function not found: ' + name);
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

const drain = () => new Promise((r) => setImmediate(r));
async function ticks(n = 30) { for (let i = 0; i < n; i++) await drain(); }

/// `navigator.locks` for one origin: exclusive, FIFO per name, `ifAvailable` answering
/// null at once when the name is held. Every tab given the same instance shares it.
function makeLocks() {
	const held = new Set();
	const waiting = new Map();
	function grant(name, fn, resolve, reject) {
		held.add(name);
		Promise.resolve().then(() => fn({ name, mode: 'exclusive' })).then(
			(v) => { next(name); resolve(v); },
			(e) => { next(name); reject(e); });
	}
	function next(name) {
		const q = waiting.get(name) || [];
		const g = q.shift();
		if (g) g(); else held.delete(name);
	}
	return {
		held: () => [...held],
		request(name, opts, fn) {
			if (typeof opts === 'function') { fn = opts; opts = {}; }
			return new Promise((resolve, reject) => {
				if (!held.has(name)) { grant(name, fn, resolve, reject); return; }
				if (opts && opts.ifAvailable) { Promise.resolve().then(() => fn(null)).then(resolve, reject); return; }
				if (!waiting.has(name)) waiting.set(name, []);
				waiting.get(name).push(() => grant(name, fn, resolve, reject));
			});
		},
	};
}

function makeGate() {
	let open = null;
	const p = new Promise((r) => { open = r; });
	return { wait: () => p, open: () => open() };
}

/// The real peer.js, for `turnWorkKey`, `staleOwnLeaseDecision` and `workKey`.
function loadPeer() {
	const win = { addEventListener() {}, dispatchEvent() { return true; },
		localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
	const document = { readyState: 'complete', addEventListener() {}, querySelector() { return null; }, getElementById() { return null; } };
	new Function('window', 'document', 'with (window) {\n' + PEER + '\n}')(win, document);
	return win.DaimondPeer;
}
const P = loadPeer();

const LIFTED = [
	'var _claimed = {};',
	extractFn(POST, 'claimWork'),
	'var _localRecovering = Object.create(null);',
	extractFn(APP, 'recoverOneLocally'),
	extractFn(APP, 'claimTurnHere'),
	extractFn(APP, 'releaseOwnStaleLeases'),
	extractFn(APP, 'ensureApp'),
	extractFn(APP, 'tailAfter'),
	extractFn(APP, 'dedupeSession'),
	'return { claimWork, recoverOneLocally, releaseOwnStaleLeases, ensureApp, dedupeSession, _localRecovering };',
].join('\n');

/// One tab of the device `SELF`: the lifted functions over this tab's own memory, the
/// shared lock manager, and a shared world (`w`: the lease server, the post box).
function makeTab(name, locks, w) {
	const stat = { runs: 0, reseats: 0, released: [], reports: [], appended: [], restored: null };
	const tab = { stat, runnerCtx: Object.create(null), gate: null, reseatAnswer: false };
	const scope = {
		navigator: { locks },
		DaimondPeer: Object.assign(Object.create(P), {
			runErrand: async () => { stat.runs++; w.runs++; if (tab.gate) await tab.gate.wait(); return { ran: true, done: true }; },
			sealForSelf: async (x) => x,
		}),
		DaimondPost: null,		// set below, from the lifted claimWork
		DaimondLease: { release: async (tid) => { stat.released.push(tid); w.released.push(name + ':' + tid); } },
		DaimondSync: { leaseGet: async () => ({ leases: w.leases }) },
		diag: () => {},
		selfDeviceId: () => 'SELF',
		leaseClockNow: () => 1000,
		peerSyncShim: () => ({}),
		errandForRecovery: (chat, m) => ({ turnId: String(m.iturn), chatId: chat.id }),
		peerRunErrandDeps: () => ({}),
		dropDispatchedPlaceholder: () => {},
		renderDispatchedBadges: () => {},
		retryNextDesktopBeforeLocal: async () => { stat.reseats++; return tab.reseatAnswer; },
		// ensureApp's world: an agent that records what it was given.
		appCfgFor: () => ({ baseUrl: '', apiKey: '', model: 'm', provider: 'p' }),
		creditsGen: () => 0,
		maxOutFor: () => 1,
		Instructions: { compose: () => '' },
		SYSTEM_PROMPT: () => '',
		cfg: { tools: false },
		DaimondModels: { noteUse() {} },
		applyRoundLimit() {}, applyFoldSettings() {}, applyProviderRouting() {}, applyCrystalCap() {},
		DaimondApp: class {
			restore_session(msgs) { stat.restored = { session: msgs.map((m) => m.content) }; return msgs.length; }
			restore(hist) { stat.restored = { hist: hist.map((m) => m.content) }; }
			append_message(role, content) { stat.appended.push(role + ':' + content); }
		},
	};
	scope.window = scope;
	scope.window.DaimondPricing = null;
	scope.window.DaimondHandMode = null;
	Object.defineProperty(scope, '_runnerCtx', { get: () => tab.runnerCtx });
	const fns = new Function('scope', 'with (scope) {\n' + LIFTED + '\n}')(scope);
	scope.DaimondPost = { claimWork: fns.claimWork,
		post: async (r) => { if (tab.postGate) await tab.postGate.wait(); stat.reports.push(r); w.reports.push(name); } };
	return Object.assign(tab, fns);
}

function world() {
	return { runs: 0, released: [], reports: [],
		leases: { T: { holder: 'SELF', mode: 'running', expiry: 9000, renewedAt: 1, turnId: 'T' } } };
}
const chatOf = () => ({ id: 'c', messages: [] });
const turn = { why: 'dispatched', iturn: 'T', dispatchedBy: 'SELF' };

// ── The key is the collect's own. ─────────────────────────
check('the local run claims the key a runner\'s collect claims',
	P.turnWorkKey('T') === P.workKey({ t: 'errand', turnId: 'T' }) && P.turnWorkKey('T') === 'turn:T');

// ── F1. A2 runs the handed-back turn; A1's backstop fires meanwhile. ──
{
	const locks = makeLocks(), w = world();
	const A1 = makeTab('A1', locks, w), A2 = makeTab('A2', locks, w);
	A2.gate = makeGate();
	const run2 = A2.recoverOneLocally(chatOf(), turn, { reseat: {} });
	await ticks();
	check('F1: A2\'s local run holds the turn\'s claim across the device', locks.held().includes('daimond-post-work:turn:T'));
	await A1.recoverOneLocally(chatOf(), turn, { reseat: {} });
	check('F1: A1\'s backstop stands down while A2 runs it: one model run, not two', w.runs === 1, w.runs);
	check('F1: nor does A1 re-seat a turn its sibling is running', A1.stat.reseats === 0, A1.stat.reseats);
	A2.gate.open(); await run2; await ticks();
	check('F1: the claim is let go when the run ends', !locks.held().includes('daimond-post-work:turn:T'));
	// Control: with no sibling running it, the same call runs -- the stand-down was the claim.
	await A1.recoverOneLocally(chatOf(), turn, { reseat: {} });
	check('F1 control: unclaimed, A1 offers the re-seat and then runs it', w.runs === 2 && A1.stat.reseats === 1, [w.runs, A1.stat.reseats]);
	// A re-seat that lands elsewhere runs nothing here.
	A1.reseatAnswer = true;
	await A1.recoverOneLocally(chatOf(), turn, { reseat: {} });
	check('F1 control: a re-seat to another desktop runs nothing here', w.runs === 2, w.runs);
}

// ── F1'. The wake path and a take-back, in the same tab as a running recovery. ──
{
	const locks = makeLocks(), w = world();
	const A = makeTab('A', locks, w);
	A.gate = makeGate();
	const r = A.recoverOneLocally(chatOf(), turn);
	await ticks();
	await A.recoverOneLocally(chatOf(), turn, { explicit: true });
	check('F1: a second driver in the same tab stands down too', w.runs === 1, w.runs);
	A.gate.open(); await r;
}

// ── F2 (runner). B2's collect is running the turn; B1 comes to the foreground. ──
{
	const locks = makeLocks(), w = world();
	const B1 = makeTab('B1', locks, w);
	const B2 = makeTab('B2', locks, w);
	const claim = await B2.claimWork('turn:T');			// what B2's collect holds for the run
	B2.runnerCtx.T = { turnId: 'T' };
	const n = await B1.releaseOwnStaleLeases();
	check('F2: the idle tab frees no lease its sibling is running under', n === 0 && w.released.length === 0, w.released);
	check('F2: and sends the sender no "runner restarted" report', w.reports.length === 0, w.reports);
	claim.release(); delete B2.runnerCtx.T; await ticks();
	// Control: once no tab runs it, the stale lease is freed as before (the 09-12 hang fix).
	const n2 = await B1.releaseOwnStaleLeases();
	check('F2 control: a lease nobody here runs is still freed, with its report', n2 === 1
		&& w.released.join() === 'B1:T' && w.reports.join() === 'B1', [n2, w.released, w.reports]);
}

// ── F2 (sender). A1 runs its own hand-off locally; A2 is focused. ──
{
	const locks = makeLocks(), w = world();
	const A1 = makeTab('A1', locks, w), A2 = makeTab('A2', locks, w);
	A1.gate = makeGate();
	const r = A1.recoverOneLocally(chatOf(), turn);
	await ticks();
	const n = await A2.releaseOwnStaleLeases();
	check('F2: a sender\'s focused tab frees no lease its sibling\'s local run holds', n === 0 && w.released.length === 0, w.released);
	await A2.recoverOneLocally(chatOf(), turn, { reseat: { requireGenuine: true } });
	check('F2: nor does its wake path re-seat or run the turn again', w.runs === 1 && A2.stat.reseats === 0, [w.runs, A2.stat.reseats]);
	A1.gate.open(); await r;
}

// ── A release in flight holds the claim, so no run of the turn starts under it. ──
{
	const locks = makeLocks(), w = world();
	const B1 = makeTab('B1', locks, w), B2 = makeTab('B2', locks, w);
	B1.postGate = makeGate();					// the report's post is slow to land
	const rel = B1.releaseOwnStaleLeases();
	await ticks();
	check('a self-release holds the turn\'s claim while it reports and frees', locks.held().includes('daimond-post-work:turn:T'));
	await B2.recoverOneLocally(chatOf(), turn);
	check('so no run of the turn starts in another tab until the lease is freed', w.runs === 0, w.runs);
	B1.postGate.open();
	check('then the lease is freed, once', (await rel) === 1 && w.released.join() === 'B1:T', w.released);
}

// ── F3. The session path leaves the re-sent message out, as the no-session path does. ──
{
	const w = world(), locks = makeLocks();
	const T = makeTab('T', locks, w);
	const msgs = [
		{ role: 'user', content: 'q1', mid: 'u1', ts: 1 },
		{ role: 'assistant', content: 'a1', mid: 'a1', ts: 2 },
		{ role: 'user', content: 'q2', mid: 'TURN2', ts: 3 },
	];
	const sess = { v: 1, msgs: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }], upto: 'a1', uptoTs: 2 };
	const withSess = { id: 'c', messages: msgs, session: sess };
	T.ensureApp(withSess, 'TURN2');
	check('F3: with a stored session, the turn\'s own message is not appended (run_turn sends it)',
		T.stat.appended.length === 0, T.stat.appended);
	const T2 = makeTab('T2', locks, w);
	T2.ensureApp({ id: 'c', messages: msgs, session: sess }, '');
	check('F3 control: without exceptMid the tail still carries it (a local turn, or another tab\'s)',
		T2.stat.appended.join() === 'user:q2', T2.stat.appended);
	const T3 = makeTab('T3', locks, w);
	T3.ensureApp({ id: 'c', messages: msgs }, 'TURN2');
	check('F3: the no-session path leaves it out as before',
		T3.stat.restored && T3.stat.restored.hist.join() === 'q1,a1', T3.stat.restored);
	// The marker gone: the tail is taken by time, and the message still left out.
	const T4 = makeTab('T4', locks, w);
	T4.ensureApp({ id: 'c', messages: msgs, session: Object.assign({}, sess, { upto: 'gone' }) }, 'TURN2');
	check('F3: by the clock too (the marker tombstoned), the turn\'s message is left out',
		T4.stat.appended.length === 0, T4.stat.appended);
}

// ── F4 (the seed part). A provisional row never rides a seed. ──
{
	const chat = { id: 'c', messages: [
		{ role: 'user', content: 'q1', mid: 'u1', ts: 1 },
		{ role: 'assistant', content: 'A'.repeat(16384), mid: 'ans1', provisional: true, ts: 2 },
		{ role: 'user', content: 'q2', mid: 'TURN', ts: 3 },
	] };
	const seed = P.seedFrom(chat, 'TURN');
	check('F4: a cut provisional answer is not carried in a seed marked whole',
		seed && seed.whole === 1 && seed.msgs.map((m) => m.mid).join() === 'u1,TURN', seed && seed.msgs.map((m) => m.mid));
	const rc = { messages: [{ role: 'user', content: 'q1', mid: 'u1', ts: 1 }] };
	check('F4: so a runner lacking the answer grafts no cut copy of it',
		P.seedGraft(rc, { turnId: 'TURN', seed }).every((m) => m.mid !== 'ans1'));
}

// ── The saved duplicates (lane C, round 2). A session stored before 5.1 holds a handed-off
//    turn's prompt twice; the restore takes out the copies the screen does not hold, and
//    never a prompt the person really sent twice. ──
{
	const w = world(), locks = makeLocks();
	const T = makeTab('Tdup', locks, w);
	const u = (c) => ({ role: 'user', content: c }), a = (c) => ({ role: 'assistant', content: c });
	const S = (...m) => [{ role: 'system', content: 'sys' }].concat(m);
	const scr = (rows) => rows.map((r, i) => Object.assign({ mid: r.mid || ('m' + i), ts: i + 1 }, r));
	const said = (ms) => ms.map((m) => m.role.charAt(0) + ':' + m.content).join(' ');
	// 1. A handed-off turn 2: the prompt twice in the session, once on screen.
	const screen1 = scr([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
		{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2', mid: 'A2' }]);
	const s1 = S(u('q1'), a('a1'), u('q2'), u('q2'), a('a2'));
	check('dup: a handed-off turn\'s second copy goes', said(T.dedupeSession(s1, screen1, 'A2', 0)) === 's:sys u:q1 a:a1 u:q2 a:a2',
		said(T.dedupeSession(s1, screen1, 'A2', 0)));
	// 2. Turns 2 and 3 both handed off (QA's `suauuauu`).
	const screen2 = scr([{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' },
		{ role: 'assistant', content: 'a2' }, { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3', mid: 'A3' }]);
	const s2 = S(u('q1'), a('a1'), u('q2'), u('q2'), a('a2'), u('q3'), u('q3'), a('a3'));
	check('dup: every handed-off turn\'s copy goes, newest to oldest', said(T.dedupeSession(s2, screen2, 'A3', 0))
		=== 's:sys u:q1 a:a1 u:q2 a:a2 u:q3 a:a3', said(T.dedupeSession(s2, screen2, 'A3', 0)));
	// 3. The person sent it twice: a failed turn (no reply in the session, a half one on screen), then the same words again.
	const screen3 = scr([{ role: 'user', content: 'go on' }, { role: 'assistant', content: 'par', interrupted: 1 },
		{ role: 'user', content: 'go on' }, { role: 'assistant', content: 'done', mid: 'D' }]);
	const s3 = S(u('go on'), u('go on'), a('done'));
	check('dup: a prompt really sent twice stays twice (the same array back)', T.dedupeSession(s3, screen3, 'D', 0) === s3);
	// 4. Sent twice AND handed off: one copy goes, the person's two stay.
	const s4 = S(u('go on'), u('go on'), u('go on'), a('done'));
	check('dup: sent twice and handed off, only the hand-off\'s copy goes', said(T.dedupeSession(s4, screen3, 'D', 0)) === 's:sys u:go on u:go on a:done');
	// 5. The same word on two turns, each answered: not adjacent, not a duplicate.
	const screen5 = scr([{ role: 'user', content: 'continue' }, { role: 'assistant', content: 'x' },
		{ role: 'user', content: 'continue' }, { role: 'assistant', content: 'y', mid: 'Y' }]);
	const s5 = S(u('continue'), a('x'), u('continue'), a('y'));
	check('dup: the same prompt on two answered turns is left alone', T.dedupeSession(s5, screen5, 'Y', 0) === s5);
	// 6. A disagreement stops the walk: an older pair past it is not touched on a guess.
	const screen6 = scr([{ role: 'user', content: 'old' }, { role: 'assistant', content: 'ao' },
		{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2', mid: 'A2' }]);
	const s6 = S(u('old'), u('old'), a('ao'), u('not on screen'), a('z'), u('q2'), u('q2'), a('a2'));
	check('dup: the walk stops where session and screen disagree; the newer copy still goes',
		said(T.dedupeSession(s6, screen6, 'A2', 0)) === 's:sys u:old u:old a:ao u:not on screen a:z u:q2 a:a2', said(T.dedupeSession(s6, screen6, 'A2', 0)));
	// 7. Turns after the marker (another tab's, not in the session) are not part of the walk.
	const screen7 = screen1.concat(scr([{ role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' }]).map((m) => Object.assign(m, { mid: 'late' + m.mid, ts: 90 + m.ts })));
	check('dup: rows past the session\'s marker are left to the tail', said(T.dedupeSession(s1, screen7, 'A2', 0)) === 's:sys u:q1 a:a1 u:q2 a:a2');
	// 8. The marker gone: by the clock.
	check('dup: with the marker gone, the clock places it', said(T.dedupeSession(s1, screen7, 'gone', 4)) === 's:sys u:q1 a:a1 u:q2 a:a2');
	// 9. A provisional row on screen is not a message the agent saw.
	const screen9 = screen1.concat([{ role: 'user', content: 'q2', mid: 'p', ts: 3.5, provisional: 1 }]);
	check('dup: a provisional row does not count as the person\'s second send', said(T.dedupeSession(s1, screen9, 'A2', 0)) === 's:sys u:q1 a:a1 u:q2 a:a2');
	// 10. Through the restore: the model is given the clean session, and it is kept for the next save.
	const chat = { id: 'c', messages: screen1, session: { v: 1, msgs: s1, upto: 'A2', uptoTs: 4 } };
	T.ensureApp(chat, '');
	check('dup: the restore hands the model the session without the copy', T.stat.restored && T.stat.restored.session.join() === 'sys,q1,a1,q2,a2',
		T.stat.restored);
	check('dup: and the chat keeps the clean session for its next save', chat.session.msgs.length === 5 && chat.session.upto === 'A2');
}

console.log('\n' + checks + ' checks, ' + failures + ' failed');
if (failures) process.exitCode = 1;
