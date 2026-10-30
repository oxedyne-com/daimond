/* ============================================================
   Test: a runner is never busy for the chat it is already running (UNBLOCK-1
   BUSY-SELF, FIRE under D-20261013-02).

   busy3 on dbb39bd3: argonaut ran a Diamond chat's own turn, the phone sent a
   second turn into that chat, and argonaut answered "busy with another chat".
   `busyForChat` skipped the asked chat, then fell back to `anyCrystalBusy()`,
   which counted that chat's own Diamond as work elsewhere.

   Lifts the REAL busy block out of daimond.js (from `busyHere` to the runner
   ctx registry) over fake chats, Diamonds, workers and runner turns, with the
   real peer.js for the shared rule (`DaimondPeer.busyForRec`).

     S1  a Diamond chat's own turn is not busy for that chat (the bug)
     S2  another Diamond's turn is busy for it
     S3  a worker counts for its own chat only
     S4  a Diamond's chatless worker belongs to the Diamond's chat
     S5  one chat's turn and its Diamond are one unit, not two
     S6  `busyHere` names the chats it is busy with
     S7  a runner turn counts for its own chat only
     S8  busy with this chat AND another: not busy for this one (O3: it queues)
     S9  the shared rule on a beat record
   Step 2, the runner queues behind its own work in the chat:
     T1-T4  the thread check reads the runner's own in-flight turns as unseen
     O1-O3  ownTurns / chatHasWork / queueBehind (the lifted daimond.js block)
     R1-R5  runErrand: take, then wait, then rebuild; a take-back or the deadline ends the wait
   Step 3, the beat names the chats (busyChats) and the switch reads them:
     B1-B2  sync.js beatPresence sends busy_chats; presenceIngest / presenceBeat keep busyChats
     B3-B6  the election offers a runner busy with THIS chat, passes one busy with OTHERS

   Run:  node www/js/busyself.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}

// The real peer.js, for the shared rule.
const win = { addEventListener() {}, dispatchEvent() { return true; } };
{
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readPage(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
}
const P = win.DaimondPeer;

const src = readPage(join(HERE, 'daimond.js'), 'utf8');
const a = src.indexOf('\n\tfunction busyHere(');
const b = src.indexOf('\n\tfunction busyForChat(');
const from = a >= 0 && a < b ? a : b;
const to = src.indexOf('\t/// Register / retire a runner', from);
if (b < 0 || to < 0) throw new Error('busy block not found in daimond.js');
const block = src.slice(from, to);

function rig(st) {
	const make = new Function('chats', '_runnerCtx', 'crystalRunning', 'Workers', 'window', 'DaimondPeer',
		'current', 'currentDiamond', '_ask',
		'function waitingOn(c) { return ((c && c._queue) || []).length + ((c && c._interject) || []).length; }\n'
		+ 'function askHolds() { return !!_ask; }\n'
		+ 'function anyCrystalBusy() { for (var k in crystalRunning) if (crystalRunning[k]) return true; return false; }\n'
		+ block
		+ '\nreturn { busyForChat: busyForChat, busyHere: typeof busyHere === "function" ? busyHere : null,'
		+ ' ownTurns: typeof ownTurns === "function" ? ownTurns : null,'
		+ ' chatHasWork: typeof chatHasWork === "function" ? chatHasWork : null,'
		+ ' queueBehind: typeof queueBehind === "function" ? queueBehind : null };');
	return make(st.chats || [], st.ctx || {}, st.crystal || {}, { runs: st.runs || [], active: (st.runs || []).filter(r => r.status === 'running').length },
		win, P, (st.chats || []).find((c) => c && c.id === st.current) || null,
		st.currentDiamond ? { id: st.currentDiamond } : null, !!st.ask);
}
const crig  = (o) => Object.assign({ id: 'crig', diamondId: 'D' }, o);
const other = (o) => Object.assign({ id: 'other', diamondId: 'E' }, o);

console.log('\n— S: busy for this chat —');
{
	const r = rig({ chats: [crig({ _generating: true }), other()], crystal: { D: true } });
	check('S1 a Diamond chat\'s own turn is not busy for that chat', r.busyForChat('crig') === 0, r.busyForChat('crig'));
	check('S1 it is busy for another chat', r.busyForChat('other') === 1, r.busyForChat('other'));
}
{
	const r = rig({ chats: [crig(), other({ _generating: true })], crystal: { E: true } });
	check('S2 another Diamond\'s turn is busy for this chat', r.busyForChat('crig') === 1, r.busyForChat('crig'));
	const f = rig({ chats: [crig(), other()], crystal: { E: true } });
	check('S2 another Diamond\'s fold alone is busy for this chat', f.busyForChat('crig') === 1, f.busyForChat('crig'));
	check('S2 that fold is not busy for its own chat', f.busyForChat('other') === 0, f.busyForChat('other'));
}
{
	const r = rig({ chats: [crig(), other()], runs: [{ id: 'w1', chatId: 'crig', diamondId: '', status: 'running' }] });
	check('S3 a worker of this chat is not busy for it', r.busyForChat('crig') === 0, r.busyForChat('crig'));
	check('S3 it is busy for another chat', r.busyForChat('other') === 1, r.busyForChat('other'));
	const d = rig({ chats: [crig(), other()], runs: [{ id: 'w1', chatId: 'crig', status: 'done' }] });
	check('S3 a finished worker is no work', d.busyForChat('other') === 0, d.busyForChat('other'));
}
{
	const r = rig({ chats: [crig(), other()], runs: [{ id: 'w1', chatId: '', diamondId: 'D', status: 'queued' }] });
	check('S4 a Diamond\'s chatless worker belongs to its chat', r.busyForChat('crig') === 0, r.busyForChat('crig'));
	check('S4 and is busy for another', r.busyForChat('other') === 1, r.busyForChat('other'));
}
{
	const r = rig({ chats: [crig({ _generating: true }), other()], crystal: { D: true },
		runs: [{ id: 'w1', chatId: 'crig', status: 'running' }] });
	check('S5 a chat\'s turn, its Diamond and its worker are one unit', r.busyForChat('') === 1, r.busyForChat(''));
	const two = rig({ chats: [crig({ _generating: true }), other({ _generating: true })], crystal: { D: true, E: true } });
	check('S5 two chats running are two', two.busyForChat('') === 2, two.busyForChat(''));
}
{
	const r = rig({ chats: [crig(), other()], crystal: { D: true }, ctx: { t9: { turnId: 't9', chatId: 'x9' } } });
	const h = r.busyHere ? r.busyHere() : null;
	check('S6 busyHere names the chats it is busy with',
		!!h && JSON.stringify(h.busyChats.slice().sort()) === JSON.stringify(['crig', 'x9']), h && JSON.stringify(h));
	check('S6 and counts them', !!h && h.busy === 2, h && h.busy);
}
{
	// F2: busyHere reads a queue by the same rule as chatHasWork.
	const cp = (o) => Object.assign({ id: 'cq' }, o);
	const live = rig({ chats: [cp({ _queue: [{ text: 'x' }] }), other()], current: 'cq' });
	const lh = live.busyHere ? live.busyHere() : null;
	check('S10 a draining queue is busy for another chat', live.busyForChat('other') > 0 && !!lh && lh.busyChats.includes('cq'), lh && JSON.stringify(lh));
	const park = rig({ chats: [cp({ _queue: [{ text: 'x' }] }), other()], current: 'other' });
	const ph = park.busyHere ? park.busyHere() : null;
	check('S10 a parked queue is no work', park.busyForChat('other') === 0 && !!ph && ph.busy === 0 && ph.busyChats.length === 0, ph && JSON.stringify(ph));
	const held = rig({ chats: [cp({ _queue: [{ text: 'x' }] })], current: 'cq', ask: true });
	check('S10 a queue held by an open question is no work', held.busyForChat('other') === 0, held.busyForChat('other'));
}
{
	const r = rig({ chats: [crig(), other()], ctx: { t1: { turnId: 't1', chatId: 'crig' } } });
	check('S7 a runner turn is not busy for its own chat', r.busyForChat('crig') === 0, r.busyForChat('crig'));
	check('S7 it is busy for another', r.busyForChat('other') === 1, r.busyForChat('other'));
}
{
	const r = rig({ chats: [crig({ _generating: true }), other({ _generating: true })], crystal: { D: true, E: true } });
	check('S8 busy with this chat and another: not busy for this one (it queues)', r.busyForChat('crig') === 0, r.busyForChat('crig'));
	check('S8 busy for a third chat', r.busyForChat('third') === 2, r.busyForChat('third'));
}
{
	const f = P && P.busyForRec;
	check('S9 busyForRec exists', typeof f === 'function');
	if (typeof f === 'function') {
		check('S9 a beat busy with this chat is not busy for it', f({ busy: 1, busyChats: ['crig'] }, 'crig') === 0);
		check('S9 a beat busy with another chat is', f({ busy: 1, busyChats: ['crig'] }, 'other') === 1);
		check('S9 a beat that cannot name its chats is busy by its count', f({ busy: 2 }, 'crig') === 2);
		check('S9 an idle beat is not busy', f({ busy: 0, busyChats: [] }, 'crig') === 0 && f(null, 'crig') === 0);
		check('S9 no chat asked: the whole count', f({ busy: 1, busyChats: ['crig'] }, '') === 1);
	}
}

// ── Step 2: the runner queues behind its own work in the chat ──
console.log('\n— T: the thread check reads the runner\'s own turns as unseen —');
{
	const u = (mid, o) => Object.assign({ role: 'user', content: 'q', mid: mid }, o);
	const as = (mid, it) => ({ role: 'assistant', content: 'a', mid: mid, iturn: it });
	const before = [u('u0'), as('a0', 'u0')];
	const ownRows = [u('o1'), as('ao1', 'o1')];
	const runner = { _loaded: true, messages: before.concat(ownRows, [u('t2')]) };
	const errand = (rows) => ({ turnId: 't2', chatId: 'crig', thread: P.threadSig({ messages: rows.concat([u('t2')]) }, 't2') });
	const unseen = errand(before), asked = errand(before.concat([ownRows[0]])), seen = errand(before.concat(ownRows));
	check('T1 the own turn unseen: no match without own', !P.holdsThread(runner, unseen));
	check('T1 the own turn unseen: a match with own', P.holdsThread(runner, unseen, ['o1']));
	check('T2 only its prompt seen: a match with own', P.holdsThread(runner, asked, ['o1']));
	check('T2 all of it seen: a match either way', P.holdsThread(runner, seen) && P.holdsThread(runner, seen, ['o1']));
	const r0 = P.threadReadiness(runner, unseen, 9), r1 = P.threadReadiness(runner, unseen, 9, ['o1']);
	check('T3 readiness: diverged without own, a match with it', r0.state === 'diverged' && r1.state === 'match', r0.state + '/' + r1.state);
	const stray = { _loaded: true, messages: before.concat(ownRows, [u('x9')], [u('t2')]) };
	const r2 = P.threadReadiness(stray, unseen, 9, ['o1']);
	check('T4 a row that is not own work still differs', r2.state === 'diverged' && r2.have === 3, JSON.stringify(r2));
	const short = { _loaded: true, messages: [u('u0')].concat(ownRows, [u('t2')]) };
	const r3 = P.threadReadiness(short, unseen, 9, ['o1']);
	check('T4 behind is judged with every own row left out', r3.state === 'behind' && r3.have === 1, JSON.stringify(r3));
}

console.log('\n— O: own turns, own work, the wait —');
{
	const st = { chats: [crig({ _generating: true, _jturn: 'u1' }), other({ _generating: true, _jturn: 'u7' })],
		ctx: { t1: { turnId: 't1', chatId: 'crig', seq: 1 }, t2: { turnId: 't2', chatId: 'crig', seq: 2 },
			t3: { turnId: 't3', chatId: 'other', seq: 3 } } };
	const r = rig(st);
	const own = r.ownTurns ? r.ownTurns({ turnId: 't2', chatId: 'crig' }) : null;
	check('O1 own turns: the chat\'s turn and its other runner turns',
		!!own && JSON.stringify(own.slice().sort()) === JSON.stringify(['t1', 'u1']), JSON.stringify(own));
	const idle = rig({ chats: [crig({ _jturn: 'u1' })] });
	check('O1 a finished turn is not own work', !!idle.ownTurns && idle.ownTurns({ turnId: 't2', chatId: 'crig' }).length === 0);
}
{
	const w = (st) => { const r = rig(st); return r.chatHasWork ? r.chatHasWork({ turnId: 't2', chatId: 'crig' }) : null; };
	check('O2 idle chat: no work', w({ chats: [crig(), other({ _generating: true })], crystal: { E: true } }) === false);
	check('O2 its turn is work', w({ chats: [crig({ _generating: true })] }) === true);
	// A queue is work only while it will drain on its own (F2): its chat on screen, no open
	// question holding it, the turn ahead of it not failed. Else it is parked, and nothing runs.
	const cp = (o) => Object.assign({ id: 'crig' }, o);		// a plain chat: drained by drainQueue
	check('O2 a draining queue is work', w({ chats: [cp({ _queue: [{ text: 'x' }] })], current: 'crig' }) === true);
	check('O2 a queue parked on a chat off screen is not', w({ chats: [cp({ _queue: [{ text: 'x' }] }), other()], current: 'other' }) === false);
	check('O2 a queue held by an open question is not', w({ chats: [cp({ _queue: [{ text: 'x' }] })], current: 'crig', ask: true }) === false);
	check('O2 a queue behind a failed turn is not', w({ chats: [cp({ _queue: [{ text: 'x' }], _queueFailed: true })], current: 'crig' }) === false);
	check('O2 a daimon queue drains while its Diamond is on screen', w({ chats: [crig({ _queue: [{ text: 'x' }] })], currentDiamond: 'D' }) === true);
	check('O2 and is parked while it is not', w({ chats: [crig({ _queue: [{ text: 'x' }] })], currentDiamond: 'E' }) === false);
	check('O2 a parked queue behind a running turn: the turn is work', w({ chats: [cp({ _generating: true, _queue: [{ text: 'x' }] })], current: 'other' }) === true);
	check('O2 its own Diamond is work', w({ chats: [crig()], crystal: { D: true } }) === true);
	check('O2 its worker is work', w({ chats: [crig()], runs: [{ chatId: 'crig', status: 'running' }] }) === true);
	check('O2 an earlier runner turn of the chat is work',
		w({ chats: [crig()], ctx: { t1: { chatId: 'crig', seq: 1 }, t2: { chatId: 'crig', seq: 2 } } }) === true);
	check('O2 a later one is not (one lease each, in order)',
		w({ chats: [crig()], ctx: { t2: { chatId: 'crig', seq: 2 }, t3: { chatId: 'crig', seq: 3 } } }) === false);
}
{
	const c = crig({ _generating: true, _jturn: 'u1' });
	const ctx = { t2: { turnId: 't2', chatId: 'crig', seq: 2, queued: false } };
	const r = rig({ chats: [c], ctx });
	if (!r.queueBehind) check('O3 queueBehind exists', false);
	else {
		let marked = null;
		setTimeout(() => { marked = ctx.t2.queued; c._jturn = 'u3'; }, 300);
		setTimeout(() => { c._generating = false; }, 600);
		const t0 = Date.now();
		const out = await r.queueBehind({ turnId: 't2', chatId: 'crig' }, () => false);
		const took = Date.now() - t0;
		check('O3 waits until the chat is idle on two looks', took >= 600 + 400, took + 'ms');
		check('O3 marked queued while waiting, not after', marked === true && ctx.t2.queued === false);
		check('O3 answers the own turns seen meanwhile',
			JSON.stringify(out.own.slice().sort()) === JSON.stringify(['u1', 'u3']), JSON.stringify(out));
		c._generating = true;
		let stop = false;
		setTimeout(() => { stop = true; }, 300);
		const g0 = Date.now();
		await r.queueBehind({ turnId: 't2', chatId: 'crig' }, () => stop);
		check('O3 gone() ends the wait', Date.now() - g0 < 1000, (Date.now() - g0) + 'ms');
	}
}

console.log('\n— R: runErrand takes the lease, then waits, then rebuilds —');
{
	const SELF = 's0000000000000000000000000000000', SND = 'p0000000000000000000000000000000';
	function memCas() {
		const st = { version: 1, leases: {} };
		return { st, read: async () => ({ version: st.version, leases: JSON.parse(JSON.stringify(st.leases)) }),
			write: async (base, leases) => {
				if (base !== st.version) return { ok: false, version: st.version };
				st.version++; st.leases = JSON.parse(JSON.stringify(leases)); return { ok: true, version: st.version };
			} };
	}
	const errandFor = (tid, dl) => P.makeErrand({ turnId: tid, chatId: 'crig', eid: 'e-' + tid, ts: Date.now(),
		deadline: dl || 0, dispatchedBy: SND,
		seed: { chatId: 'crig', title: '', provider: '', model: '', msgs: [{ role: 'user', content: 'p', mid: tid, ts: Date.now() }] } });
	const deps = (cas, seen, over) => Object.assign({
		selfId: SELF, cas, presence: {}, freshWindowMs: P.DISPATCH_FRESH_MS,
		finished: async () => false, busyFor: () => 0,
		ownTurns: () => ['o1'],
		ready: async (e, own) => { seen.push('ready:' + (own || []).join(',')); return { ok: true }; },
		queueBehind: async (e, gone) => {
			const l = cas.st.leases[e.turnId];
			seen.push('queue:' + (l && l.holder === SELF ? 'held' : 'unheld'));
			if (over && over.wait) { while (!gone()) await new Promise((r) => setTimeout(r, 10)); seen.push('gone'); return { own: [] }; }
			return { own: ['o3'] };
		},
		reconstruct: async (e, own) => { seen.push('reconstruct:' + (own || []).join(',')); return { chat: {}, app: {} }; },
		runTurn: async () => { seen.push('run'); },
		abort: () => {}, pushResult: async () => 1, post: async () => {}, ack: async () => {},
		setTimer: (fn) => setInterval(fn, 20), clearTimer: (h) => clearInterval(h),
	}, over || {});
	{
		const cas = memCas(), seen = [];
		const res = await P.runErrand(errandFor('t-r1'), deps(cas, seen));
		check('R1 ready is asked with the own turns', seen[0] === 'ready:o1', seen.join(' '));
		check('R2 the lease is held while it waits', seen[1] === 'queue:held', seen.join(' '));
		check('R3 rebuilt after the wait, with the own turns seen in it',
			seen[2] === 'reconstruct:o1,o3' && seen[3] === 'run', seen.join(' '));
		check('R3 the turn ran', res.ran === true && !res.aborted, JSON.stringify(res));
	}
	{
		const cas = memCas(), seen = [];
		await P.runErrand(errandFor('t-r4'), deps(cas, seen, { ownTurns: () => [] }));
		check('R4 no own work: no wait', seen.join(' ') === 'ready: reconstruct: run', seen.join(' '));
	}
	{
		const cas = memCas(), seen = [];
		setTimeout(() => { const l = cas.st.leases['t-r5']; if (l) { l.holder = SND; cas.st.version++; } }, 100);
		const res = await P.runErrand(errandFor('t-r5'), deps(cas, seen, { wait: true }));
		check('R5 a take-back ends the wait; nothing is rebuilt or run',
			res.why === 'revoked' && res.ran === false && seen.indexOf('gone') >= 0 && !seen.some((x) => /^reconstruct|^run/.test(x)),
			JSON.stringify(res) + ' ' + seen.join(' '));
	}
	{
		const cas = memCas(), seen = [], posts = [];
		let shift = 0;
		setTimeout(() => { shift = 20 * 60 * 1000; }, 100);		// the lease clock passes the claim's deadline
		const res = await Promise.race([P.runErrand(errandFor('t-r6'),
			deps(cas, seen, { wait: true, now: () => Date.now() + shift, post: async (r) => { posts.push(r); } })),
			new Promise((r) => setTimeout(() => r({ hung: seen.join(' ') }), 3000))]);
		check('R6 the deadline ends the wait as a dead run; nothing is rebuilt or run',
			res.aborted === true && (res.why === 'deadline' || res.dead === 'deadline') && !seen.some((x) => /^reconstruct|^run/.test(x)),
			JSON.stringify(res) + ' ' + seen.join(' '));
	}
}

console.log('\n— B: the beat names its chats, and the switch reads them —');
{
	// B1: the gateway beat carries busy_chats beside busy, a list of ids, [] included.
	const ssrc = readPage(join(HERE, 'sync.js'), 'utf8');
	// The beat's body is built in `postureBody` (HT2), sent by `beatOnce`; `beatPresence`
	// is its single-flight door. Before HT2 the body was built in `beatOnce` itself.
	const sp = ssrc.indexOf('\n\tfunction postureBody(');
	const sa = sp >= 0 ? sp : ssrc.indexOf('\n\tasync function beatOnce(');
	const sb = ssrc.indexOf('\n\tasync function refreshPresence(', sa);
	const sent = [];
	const beatPresence = new Function('canBeat', 'call', 'notedRemoval', 'log', 'window',
		'postureNoteSent', 'postureNoteLost', 'presenceAnswer', 'WAKE_ID',
		ssrc.slice(sa, sb) + '\nreturn beatOnce;')(
		() => true, async (m, body) => { sent.push(body); return { status: 500 }; },
		() => false, () => {}, {}, () => {}, () => {}, () => {}, 'wk-test');
	await beatPresence('arg', 'argonaut', false, true, true, false, true, true, 2, ['c1', 'c2']);
	await beatPresence('arg', 'argonaut', false, true, true, false, true, true, 0, []);
	await beatPresence('arg', 'argonaut', false, true, true, false, true, true, 0);
	check('B1 the beat sends busy_chats, [] included, and omits it when unsaid',
		sent.length === 3 && JSON.stringify(sent[0].busy_chats) === '["c1","c2"]'
			&& JSON.stringify(sent[1].busy_chats) === '[]' && !('busy_chats' in sent[2]),
		JSON.stringify(sent));
}
{
	// B2: presence keeps busyChats from the gateway's map and from this device's own beat.
	const PR = win.DaimondPresence;
	const now = Date.now();
	PR.ingest({ arg: { name: 'argonaut', last_seen: now, busy: 1, busy_chats: ['c1', 7] },
		old: { name: 'oldbox', last_seen: now, busy: 1 } }, now);
	const snap = PR.snapshot();
	check('B2a ingest keeps busy_chats as busyChats, strings only; absent stays absent',
		JSON.stringify(snap.arg && snap.arg.busyChats) === '["c1"]' && snap.old && !('busyChats' in snap.old),
		JSON.stringify(snap));
	// B2c (P2.5b): a runner row's `busy` counts tabs only; the runner is busy when its
	// runBusy reaches its runLimit, and a row without them keeps the old rule.
	PR.ingest({ rk1: { name: 'kim', last_seen: now, kind: 'runner', busy: 0, runBusy: 1, runLimit: 2 },
		rk2: { name: 'kim2', last_seen: now, kind: 'runner', busy: 0, runBusy: 2, runLimit: 2 },
		rk3: { name: 'kim3', last_seen: now, kind: 'runner', busy: 1 } }, now);
	const rs = PR.snapshot();
	check('B2c a runner row is busy at runBusy >= runLimit, by busy without them',
		rs.rk1 && rs.rk1.busy === 0 && rs.rk2 && rs.rk2.busy === 2 && rs.rk3 && rs.rk3.busy === 1,
		JSON.stringify([rs.rk1, rs.rk2, rs.rk3]));
	PR.beat('me', 'me', now, false, true, null, true, false, true, true, 1, ['c9']);
	check('B2b this device\'s own beat keeps its busyChats',
		JSON.stringify(PR.snapshot().me && PR.snapshot().me.busyChats) === '["c9"]', JSON.stringify(PR.snapshot().me));
}
{
	const now = Date.now();
	const rec = (o) => Object.assign({ name: 'argonaut', lastSeen: now, servicedAt: now, runner: true, mobile: false }, o);
	const elect = (r, chatId) => P.handoffTarget({ arg: r }, { selfId: 'phone', chatId: chatId }, now);
	const t3 = elect(rec({ busy: 1, busyChats: ['other'] }), 'c1');
	check('B3 a runner busy with ANOTHER chat is passed over', !t3.target && t3.passed.length === 1, JSON.stringify(t3));
	const t4 = elect(rec({ busy: 1, busyChats: ['c1'] }), 'c1');
	check('B4 a runner busy with THIS chat is offered (it queues)', !!t4.target && t4.target.deviceId === 'arg', JSON.stringify(t4));
	const t5 = elect(rec({ busy: 1 }), 'c1');
	check('B5 a record that cannot name its chats is busy by its count', !t5.target, JSON.stringify(t5));
	const d6 = P.autoDispatchDecision({ id: 'c1' }, { arg: rec({ busy: 2, busyChats: ['c1', 'other'] }) },
		{ selfId: 'phone', runnerOnly: true }, now);
	check('B6 the switch reads the chat it is seating', !(d6.passed || []).length, JSON.stringify(d6));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
