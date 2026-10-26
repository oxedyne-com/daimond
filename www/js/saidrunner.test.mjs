/* ============================================================
   Test -- his words said into a running daimon turn reach it once (UNBLOCK-27 R7).

   "50 min? to ocr 7 pages??!!!": a message sent while a daimon turn ran only queued
   behind it, so "put it together now" waited for the turn it was meant to end.

   RUNNER  Words said over the turn's lease (`DaimondLease.say`) are handed to the run
           at its liveness read, once per id, retried while nothing can take them; the
           hold's renew keeps them; the report names those the model read (`heard`).
   PAGE    A Diamond whose turn runs here takes the words into that turn, not the
           queue; a landing under a known id is one message; words a runner never
           heard come out of the thread and are queued once, for the next turn.

   Drives the REAL peer.js on a virtual clock and lifts the page's helpers from
   daimond.js.   `node www/js/saidrunner.test.mjs`
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { fakeIDB, tabJournal, journalQueueOver } from './journalfixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const MIN = 60 * 1000;

function loadPeer() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	win.matchMedia = () => ({ matches: false, addListener: () => {}, addEventListener: () => {} });
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
	};
	const document = {
		readyState: 'complete', addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	function EventShim(t) { this.type = t; }
	function loadScript(rel, extra) {
		let body = readFileSync(join(HERE, rel), 'utf8');
		if (extra) body += extra;
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'Event',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
			'console', 'globalThis',
			'with (window) {\n' + body + '\n}');
		fn(win, document, webcrypto, localStorage, btoa, atob,
			TextEncoder, TextDecoder, EventShim,
			setTimeout, clearTimeout, setInterval, clearInterval,
			console, globalThis);
	}
	loadScript('vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;');
	loadScript('curvefallback.js');
	loadScript('identity.js');
	loadScript('post.js');
	loadScript('peer.js');
	return { P: win.DaimondPeer, L: win.DaimondLease };
}

// The door: a CAS over one lease map. `refuseWrites` models a door that reads but will
// not take a write (too large), so a renew cannot land.
function makeDoor() {
	let version = 5, leases = {}, refuse = false, writes = 0;
	return {
		version: () => version,
		leases:  () => JSON.parse(JSON.stringify(leases)),
		writes:  () => writes,
		refuseWrites: (v) => { refuse = !!v; },
		commit:  (base, next) => {
			if (refuse) return { ok: false, why: 'too_large' };
			if (base !== version) return { ok: false, version, leases: JSON.parse(JSON.stringify(leases)) };
			version += 1; leases = JSON.parse(JSON.stringify(next)); writes += 1;
			return { ok: true, version };
		},
	};
}

function makeFakeTimer() {
	const handles = [];
	return {
		handles,
		set:   (fn, ms) => { const h = { fn, ms, live: true }; handles.push(h); return h; },
		clear: (h) => { if (h) h.live = false; },
		live:  () => handles.filter((h) => h.live).length,
	};
}

function sentErrand(P, f) {
	const o = Object.assign({}, f);
	o.seed = { chatId: String(o.chatId || ''), title: '', provider: '', model: '',
		msgs: [{ role: 'user', content: String(o.prompt || ''), mid: String(o.turnId || ''), ts: o.ts }] };
	return P.makeErrand(o);
}

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function extractFn(src, name) {
	let start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) return null;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

const { P, L } = loadPeer();
check('peer.js loads DaimondPeer and DaimondLease', !!P && !!L && typeof P.runErrand === 'function');
check('DaimondLease.say exists', typeof L.say === 'function');

// ── RUNNER: said once, retried, kept by the hold, reported as heard. ──
if (typeof L.say === 'function') {
	L.forget();
	const TID = 'turn-said';
	const door = makeDoor();
	const cas = P.syncCas(door);
	const timer = makeFakeTimer();
	const born = 1792248499940;
	let clock = born + 700;
	const got = [], posts = [], landedIds = new Set();
	let finish = null, takeNow = true;
	const errand = sentErrand(P, { turnId: TID, chatId: 'c', prompt: 'OCR the letters', eid: 'e1',
		ts: born, deadline: born + 15 * MIN, dispatchedBy: 'PHONE' });
	const running = P.runErrand(errand, {
		selfId: 'ARGONAUT', selfName: 'argonaut', cas, now: () => clock,
		setTimer: timer.set, clearTimer: timer.clear, livenessGapMs: 0,
		reconstruct: async () => ({ chat: { id: 'c', messages: [] } }),
		runTurn: () => new Promise((r) => { finish = r; }),
		interject: (w) => { if (!takeNow) return false; got.push(w); return true; },
		landed: (id) => landedIds.has(id),
		abort: () => {}, endLocal: async () => {},
		pushResult: async () => 9, post: async (r) => { posts.push(r); }, ack: async () => {},
	});
	let settled = null;
	running.then((r) => { settled = r; });
	await flush();
	const tick = timer.handles[0] && timer.handles[0].fn;
	check('runner: the run started its liveness ticker', typeof tick === 'function');
	const step = async () => { clock += 30000; await tick(); await flush(4); };

	const s1 = await L.say(TID, { id: 'w1', text: 'put it together now', pre: '' }, cas, () => clock);
	check('runner: a word said into a running turn is held by the door', s1 && s1.ok === true, JSON.stringify(s1));
	await step();
	check('runner: the run hands it to the turn at its next read', got.length === 1 && got[0].id === 'w1'
		&& got[0].text === 'put it together now', JSON.stringify(got));
	await step();
	check('runner: and only once, however many reads follow', got.length === 1, JSON.stringify(got));
	const again = await L.say(TID, { id: 'w1', text: 'put it together now', pre: '' }, cas, () => clock);
	const saidNow = (door.leases()[TID] || {}).said || [];
	check('runner: the same id said twice is one word on the door', again.ok === true && saidNow.length === 1, JSON.stringify(saidNow));
	await step();
	check('runner: and still delivered once', got.length === 1, JSON.stringify(got));

	takeNow = false;
	await L.say(TID, { id: 'w2', text: 'and stop the loop', pre: '' }, cas, () => clock);
	await step();
	check('runner: a word the turn cannot take yet is not marked delivered', got.length === 1, JSON.stringify(got));
	takeNow = true;
	await step();
	check('runner: it is offered again and taken at the next read', got.length === 2 && got[1].id === 'w2', JSON.stringify(got));
	for (let i = 0; i < 4; i++) await step();
	const kept = (door.leases()[TID] || {}).said || [];
	check('runner: the hold renewing the lease keeps what was said', kept.length === 2, JSON.stringify(door.leases()[TID]));
	check('runner: no word delivered twice across those renews', got.length === 2, JSON.stringify(got));

	const none = await L.say('no-such-turn', { id: 'w9', text: 'hello', pre: '' }, cas, () => clock);
	check('runner: a word for a turn nobody runs is refused, so the sender queues it', none.ok === false, JSON.stringify(none));

	// The model read w1 (it landed in the thread); w2 was taken but the turn ended first.
	landedIds.add('w1');
	finish({ ok: true });
	await flush(12);
	check('runner: the turn finishes', !!settled && settled.done === true, JSON.stringify(settled));
	const done = posts.filter((r) => r.status === 'done')[0];
	check('runner: the done report names the words the model read, and only those',
		!!done && Array.isArray(done.heard) && done.heard.length === 1 && done.heard[0] === 'w1', JSON.stringify(done));
	const late = await L.say(TID, { id: 'w3', text: 'too late', pre: '' }, cas, () => clock);
	check('runner: a word said after the turn settled is refused', late.ok === false, JSON.stringify(late));
	check('report: makeReport carries heard, [] when absent',
		JSON.stringify(P.makeReport({ heard: ['a', 'a', 'b'] }).heard) === '["a","b"]'
		&& JSON.stringify(P.makeReport({}).heard) === '[]');
}

// ── PAGE: delivered into the turn running here, once; unheard words re-queued once. ──
{
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const must = ['interjectMessage', 'interjectInto', 'landInterjection', 'sayToRunner', 'requeueUnheard', 'drainAfterHeld', 'lapsedByClock', 'confirmLapse', 'leaseDoorRead'];
	// R7c's helpers, lifted where they exist, so the arms above them still run on a tree without them.
	const r7c = ['resendUnheard', 'heedUnheard', 'sendToDiamondTurn'];
	const fns0 = must.map((n) => extractFn(src, n));
	check('page: the helpers exist', fns0.every(Boolean), must.filter((n, i) => !fns0[i]).join(','));
	const names = must.concat(r7c.filter((n) => extractFn(src, n)));
	const fns = names.map((n) => extractFn(src, n));
	if (fns0.every(Boolean)) {
		const S = {
			_steerApp: {}, _steerDetached: {}, _saidThere: {}, _peerStopping: {}, _progressView: {}, chats: [], current: null, tombs: [], drained: [], said: [], mids: 0,
			dispatched: [], dispatchOk: true, queuedHere: [], clock: 0,
			enqueueMessage: (c, text) => { S.queuedHere.push(text); },
			// The hand-off: the turn's message pushed under the id given, else a fresh one.
			maybeAutoDispatch: async (chat, text, words, mid) => {
				S.dispatched.push({ chat: chat.id, text, mid: mid || '', at: S.clock });
				if (!S.dispatchOk) return false;
				const umid = mid || ('mid' + (++S.mids));
				chat.messages.push({ role: 'user', content: text, mid: umid, iturn: umid });
				return true;
			},
			commitRatings: () => {}, ratingPre: () => '', journalQueue: journalQueueOver(src, tabJournal(fakeIDB(), new Set())), giveUpSent: () => {},
			syncSendMode: () => {}, renderQueue: () => {}, heldNote: () => {}, diag: () => {},
			appendInterjected: () => {}, touchChat: () => {}, persistChats: () => {}, ownsChat: () => false,
			renderHistory: () => {}, updateQueueBadges: () => {}, recoveringHere: () => false, diamondBusy: () => false,
			peerHeldTurnOf: () => null, dispatchInFlight: () => null, peerSyncShim: () => ({}),
			// Nothing out lapsed by the clock alone: no lease door is read (QA ccp3 A R3).
			peerUiStateFor: () => 'running', peerReports: {}, _localEnding: {}, _localRecovering: {}, _lapseReading: {},
			honoursModelSet: () => true,		// its runner runs the model set (D-20261018-09 OR)
			newMid: () => 'mid' + (++S.mids),
			msgTombstone: (ids) => { S.tombs.push(...ids); },
			drainSteerQueue: (c) => { S.drained.push(c._queue.slice()); },
			drainQueue: (c) => { S.drained.push(c._queue.slice()); },
			pushUserRecord: (chat, rec) => { chat.messages.push(rec); return rec; },
		};
		const receipts = {};
		const win = {
			DaimondLease: { say: async (tid, w) => { S.said.push([tid, w]); return { ok: true }; },
				record: (tid) => receipts[tid] || null },
			DaimondPeer: { syncCas: () => ({}), frameHears: P.frameHears },
		};
		const keys = Object.keys(S);
		const api = new Function('S', 'window',
			'var DaimondLease = window.DaimondLease, DaimondPeer = window.DaimondPeer;\n'
			+ keys.map((k) => 'var ' + k + ' = S.' + k + ';').join('\n')
			+ '\nObject.defineProperty(S, "current", { set: function (v) { current = v; }, get: function () { return current; } });\n'
			+ fns.join('\n') + '\nreturn { ' + names.map((n) => n + ': ' + n).join(', ') + ' };')(S, win);

		// A Diamond whose daimon turn runs here.
		const into = [];
		S._steerApp['D1'] = { interject_daimon: (id, text, pre) => { into.push([id, text]); } };
		const chat = { id: 'dc', diamondId: 'D1', messages: [{ role: 'user', content: 'ocr 7 pages', mid: 'm0' }] };
		S.chats.push(chat);
		const ok = api.interjectMessage(chat, 'put it together now');
		check('page: a word sent during a turn running here goes into that turn',
			ok === true && into.length === 1 && into[0][0] === 'D1' && into[0][1] === 'put it together now', JSON.stringify(into));
		check('page: and is not queued after it', !(chat._queue || []).length, JSON.stringify(chat._queue));
		api.landInterjection(chat, 'put it together now');
		const users = chat.messages.filter((m) => m.content === 'put it together now');
		check('page: it lands in the thread as one message, where he sent it', users.length === 1 && users[0].interject === true, JSON.stringify(chat.messages));
		check('page: delivered once in all', into.length === 1);

		// The runner's copy of a word said under an id this thread already holds is one message.
		const rchat = { id: 'rc', diamondId: 'D2', messages: [{ role: 'user', interject: true, content: 'stop', mid: 'x1' }] };
		S._steerApp['D2'] = { interject_daimon: () => {} };
		api.interjectMessage(rchat, 'stop', undefined, { id: 'x1', pre: '' });
		api.landInterjection(rchat, 'stop');
		check('page: a word landing under an id already in the thread is not drawn twice',
			rchat.messages.filter((m) => m.mid === 'x1').length === 1, JSON.stringify(rchat.messages));

		// Said to a runner: in the thread at once; heard -> stays; unheard -> queued once.
		const hchat = { id: 'hc', diamondId: 'D3', messages: [] };
		S.chats.push(hchat);
		const r1 = await api.sayToRunner(hchat, { iturn: 'T1' }, 'heard me', 'heard me');
		const r2 = await api.sayToRunner(hchat, { iturn: 'T1' }, 'too late', 'too late');
		const m1 = hchat.messages[0] && hchat.messages[0].mid, m2 = hchat.messages[1] && hchat.messages[1].mid;
		check('page: words said to the runner go over the lease, each under its own id',
			r1 === true && r2 === true && S.said.length === 2 && S.said[0][1].id === m1 && S.said[1][1].id === m2 && m1 !== m2,
			JSON.stringify(S.said));
		check('page: and join his thread at once', hchat.messages.length === 2 && !(hchat._queue || []).length);
		const n = api.requeueUnheard({ turnId: 'T1', heard: [m1] });
		await flush();
		// R7c (b): sent as the next turn under the id it was said as, not tombstoned and re-minted.
		check('page: the word the runner did not hear goes out as the next turn, once, under its own id', n === 1
			&& S.dispatched.length === 1 && S.dispatched[0].mid === m2 && S.dispatched[0].text === 'too late'
			&& !(hchat._queue || []).length, JSON.stringify(S.dispatched));
		check('page: and is one row in the thread, the turn\'s message, never tombstoned',
			hchat.messages.filter((m) => m.mid === m2).length === 1 && hchat.messages[1].iturn === m2
			&& S.tombs.indexOf(m2) === -1, JSON.stringify(hchat.messages));
		check('page: the heard one stays where he sent it', hchat.messages[0].content === 'heard me' && hchat.messages[0].mid === m1);
		const n2 = api.requeueUnheard({ turnId: 'T1', heard: [] });
		await flush();
		check('page: a second report of the turn sends nothing more', n2 === 0 && S.dispatched.length === 1);
		const n3 = api.requeueUnheard({ turnId: 'T-other', heard: [] });
		check('page: a report for a turn nothing was said into queues nothing', n3 === 0);

		// A word unheard where nothing can be handed off now: queued as before, its said copy out of every thread.
		const qchat = { id: 'qc', diamondId: 'D5', messages: [] };
		S.chats.push(qchat);
		await api.sayToRunner(qchat, { iturn: 'T5' }, 'queue me', 'queue me');
		const qm = qchat.messages[0] && qchat.messages[0].mid;
		S.dispatchOk = false;
		api.requeueUnheard({ turnId: 'T5', heard: [] });
		await flush();
		S.dispatchOk = true;
		check('page: unheard and not handed off, it is queued once and its said copy tombstoned',
			JSON.stringify(qchat._queue) === '[{"text":"queue me"}]' && !qchat.messages.length && S.tombs.indexOf(qm) !== -1
			&& S.drained.length === 1, JSON.stringify(qchat));

		// ── R7c T1: a turn past its last model round is not said to; the words go out as the next turn at once. ──
		const tchat = { id: 'tc', diamondId: 'D6', messages: [{ role: 'user', content: 'write it', mid: 'T6', iturn: 'T6' }] };
		S.chats.push(tchat);
		S._progressView['T6'] = { turn: 'T6', seq: 4, final: false, msgs: [
			{ mid: 't1', role: 'tool_log', content: 'read a.txt' },
			{ mid: 'live-T6', role: 'assistant', content: 'Mock reply to: @tail 5000 the answer' }] };
		const saidBefore = S.said.length, sentBefore = S.dispatched.length;
		S.peerHeldTurnOf = () => ({ iturn: 'T6' });
		const t0 = S.clock;
		const said6 = await api.sayToRunner(tchat, { iturn: 'T6' }, 'and the second', 'and the second');
		check('T1: a turn writing its answer is not said to', said6 === false && S.said.length === saidBefore
			&& tchat.messages.length === 1, JSON.stringify({ said6, said: S.said.length, msgs: tchat.messages }));
		const routed = api.sendToDiamondTurn ? await api.sendToDiamondTurn(tchat, 'and the second', 'and the second') : false;
		const post = S.dispatched.slice(sentBefore);
		check('T1: it goes out as the next turn at once, within 300 ms, said to nobody',
			routed === true && post.length === 1 && post[0].text === 'and the second' && post[0].at - t0 < 300
			&& S.said.length === saidBefore, JSON.stringify({ routed, post }));
		S._progressView['T6'].msgs.push({ mid: 't2', role: 'tool_log', content: 'write b.txt' });
		check('T1: a turn whose newest row is a call can still hear: said to', await api.sayToRunner(tchat, { iturn: 'T6' }, 'mid-loop', 'mid-loop') === true
			&& S.said.length === saidBefore + 1, JSON.stringify(S.said.slice(saidBefore)));
		check('T1: the frame rule (peer.js frameHears)', typeof P.frameHears === 'function'
			&& P.frameHears(null) === true && P.frameHears({ msgs: [] }) === true
			&& P.frameHears({ final: true, msgs: [] }) === false
			&& P.frameHears({ msgs: [{ role: 'think_log', content: 'let me look' }, { role: 'tool_log', content: 'ls' }] }) === true
			&& P.frameHears({ msgs: [{ role: 'assistant', content: 'Done.' }] }) === false
			&& P.frameHears({ msgs: [{ role: 'end_log', content: '' }] }) === false);
		S.peerHeldTurnOf = () => null;

		// ── R7c T2 (page): the runner's unheard receipt on the lease sends the word at once. ──
		const rcchat = { id: 'rcc', diamondId: 'D7', messages: [] };
		S.chats.push(rcchat);
		await api.sayToRunner(rcchat, { iturn: 'T7' }, 'late word', 'late word');
		const lm = rcchat.messages[0] && rcchat.messages[0].mid;
		const d7 = S.dispatched.length;
		receipts['T7'] = { holder: 'ARGONAUT', mode: 'running', unheard: [lm] };
		const h1 = api.heedUnheard ? api.heedUnheard() : 0;
		await flush();
		check('T2: a receipt on the lease sends the unheard word as the next turn at once, under its id',
			h1 === 1 && S.dispatched.length === d7 + 1 && S.dispatched[d7].mid === lm, JSON.stringify(S.dispatched.slice(d7)));
		const h2 = api.heedUnheard ? api.heedUnheard() : 0;
		const late7 = api.requeueUnheard({ turnId: 'T7', heard: [] });
		await flush();
		check('T2: and once: a second look and the turn\'s report send nothing more',
			h2 === 0 && late7 === 0 && S.dispatched.length === d7 + 1, JSON.stringify(S.dispatched.slice(d7)));
		// ── R7c T3 (page): the said copy and the turn's message are one row, one id. ──
		check('T3: the thread holds the word once, as the turn\'s message, under the id every device has it by',
			rcchat.messages.length === 1 && rcchat.messages[0].mid === lm && rcchat.messages[0].iturn === lm
			&& S.tombs.indexOf(lm) === -1, JSON.stringify(rcchat.messages));
	}
}

// ── R7c T2/T3 (runner): a word said to a turn that can no longer hear it is answered at once, never taken. ──
if (typeof L.say === 'function') {
	L.forget();
	const TID = 'turn-late';
	const door = makeDoor();
	const cas = P.syncCas(door);
	const timer = makeFakeTimer();
	const born = 1792248499940;
	let clock = born + 700;
	const got = [], posts = [];
	let finish = null, deaf = false;
	const errand = sentErrand(P, { turnId: TID, chatId: 'c', prompt: 'write the answer', eid: 'e2',
		ts: born, deadline: born + 15 * MIN, dispatchedBy: 'PHONE' });
	const running = P.runErrand(errand, {
		selfId: 'ARGONAUT', selfName: 'argonaut', cas, now: () => clock,
		setTimer: timer.set, clearTimer: timer.clear, livenessGapMs: 0,
		reconstruct: async () => ({ chat: { id: 'c', messages: [] } }),
		runTurn: () => new Promise((r) => { finish = r; }),
		interject: (w) => { if (deaf) return 'late'; got.push(w); return true; },
		landed: () => false,
		abort: () => {}, endLocal: async () => {},
		pushResult: async () => 9, post: async (r) => { posts.push(r); }, ack: async () => {},
	});
	await flush();
	deaf = true;			// the last round is writing the answer, its tail held open
	const w = await L.say(TID, { id: 'late1', text: 'and the second', pre: '' }, cas, () => clock);
	await flush(12);		// no ticker step: the say landing on the view is what wakes the run
	const rec = door.leases()[TID] || {};
	check('T2: the runner answers a word it can no longer hear at once, with an unheard receipt on the lease',
		w.ok === true && Array.isArray(rec.unheard) && rec.unheard.length === 1 && rec.unheard[0] === 'late1', JSON.stringify(rec));
	check('T3: and never takes it, so it is never a second row on the runner', got.length === 0, JSON.stringify(got));
	const tick = timer.handles[0] && timer.handles[0].fn;
	if (tick) { clock += 30000; await tick(); await flush(4); }
	check('T3: a later read neither takes it nor answers it again', got.length === 0
		&& ((door.leases()[TID] || {}).unheard || []).length === 1, JSON.stringify(door.leases()[TID]));
	check('T2: the hold renewing the lease keeps the receipt', ((door.leases()[TID] || {}).unheard || [])[0] === 'late1');
	finish && finish({ ok: true });
	await flush(12);
	const done = posts.filter((r) => r.status === 'done')[0];
	check('T2: the report does not name it heard', !!done && Array.isArray(done.heard) && done.heard.length === 0, JSON.stringify(done));
	await running;
}

// ── HATE-3: a cut-in re-sent as the next turn draws its reply, and keeps it (26 Oct 2026). ──
// A word said into a native runner's turn that its report does not name heard goes out as turn 2
// under the id it was said as (`resendUnheard`). Turn 2 ran and settled done, its report reached the
// page, and nothing drew: no frame folded and the placeholder went with no answer. Drives the page's
// REAL say, re-send, watch, last read, fold, adoption, merge and placeholder drop, on peer.js's rules.
await (async () => {
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const { liftSource } = await import('../../dev/syncprobe.mjs');
	const FNS = ['touchMsg', 'sayToRunner', 'requeueUnheard', 'resendUnheard', 'pushUserRecord', 'tsPast', 'markTurnDispatched',
		'refreshHandoffWatch', 'dispatchedPlaceholderIn', 'dispatchedTurnFinished', 'dispatchedTurnSettled',
		'handoffLeaseSettled', 'handoffDone', 'dispatchedAnswerPresent', 'updateExpedite', 'updateProgressWatch',
		'onLastFrame', 'applyProvisional', 'adoptFinalFrame', 'finalFrameChat', 'dropOtherRunRows', 'isNotRunRow',
		'isLostRow', 'dropDispatchedPlaceholder', 'dispatchedChat', 'chatHoldingTurn', 'chatHoldsTurn'];
	const lifted = FNS.map((n) => extractFn(src, n));
	check('HATE-3: the page functions exist', lifted.every(Boolean), FNS.filter((n, i) => !lifted[i]).join(','));
	if (!lifted.every(Boolean)) return;
	// The merge reconcile a parcel pull runs (`onChatsChangedElsewhere`), lifted from its own text.
	const r0 = src.indexOf('var dispTurns = Object.keys(_dispatchedIx);');
	const r1 = src.indexOf('} catch (e) { /* a reconcile must never break the merge */ }', r0);
	const reconcile = 'function reconcileMerged() {\n' + src.slice(r0, r1) + '}\n';
	check('HATE-3: the merge reconcile is found', r0 > 0 && r1 > r0);
	const stampSrc = readFileSync(join(HERE, 'stamp.js'), 'utf8');

	let clock = 1793000000000;
	const D = { now: () => clock };
	let seq = 0;
	const mid = () => clock.toString(36) + '-' + (++seq).toString(36) + '-hate3';
	const leases = {}, watched = [], lastReads = {}, tombs = {}, events = [];
	const W = {};
	W.DaimondPeer = P;
	W.DaimondLease = {
		say: async () => ({ ok: true }),
		record: (t) => leases[t] || null,
		holder: (t) => (leases[t] && leases[t].holder) || '',
	};
	W.DaimondSync = {
		watchProgress: (k) => { watched.push(k); },
		unwatchProgress: (k, last) => { lastReads[k] = last || null; },		// a read started before the frame finds none
	};
	W.DaimondPresence = { snapshot: () => ({}) };
	let gate = null;
	const S = {
		chats: [], current: null, peerReports: {}, _saidThere: {}, _peerStopping: {}, _progressView: {},
		_dispatchedIx: {}, _watchIx: {}, _progressWatched: {}, _progressSent: {}, _frameWorkers: {}, _finalMids: {},
		_finalRun: {}, _abiRefused: {}, _handoffStart: {}, _watchTick: 1, msgFpSeen: new WeakMap(), _expediting: false, _renderedSigs: null,
		WATCH_RECHECK_MS: 1000, ARRIVE_FRESH_MS: 60000, REASON_DISPATCHED_STR: 'dispatched',
		honoursModelSet: () => true, commitRatings: () => {}, ratingPre: () => '', giveUpSent: () => {},
		appendInterjected: () => {}, syncSendMode: () => {}, diag: () => {}, persistChats: () => {}, touchChat: () => {},
		ownsChat: () => false, renderHistory: () => {}, renderQueue: () => {}, updateQueueBadges: () => {},
		journalQueue: () => {}, drainAfterHeld: () => {}, renderDispatchedBadges: () => {}, growProvisionalTiles: () => {},
		sigsOf: () => null, selfDeviceId: () => 'PAGE', deviceLabelFor: () => 'runner', handoffTargetLabel: () => 'runner',
		autoLogHandoffLatency: () => {}, clearDispatchFallback: () => {}, ChatStore: { compact: () => {} },
		frameAbiOk: () => true, refuseAbiFrame: () => {}, applyFrameUi: () => {}, setFrameWorkers: () => {},
		fetchFinalRef: () => {}, foldRunnerTotals: () => {}, onProgressFrame: () => {}, frameUi: () => [],
		// `parseFrameRef` for a frame with no chunks (its `'{'` test defeats the brace lift).
		parseFrameRef: (t) => { try { const o = JSON.parse(t); return { msgs: o.msgs, ref: null, n: 0, ui: [], workers: [] }; } catch (e) { return null; } },
		noteArrive: (k, o) => { events.push(['arrive', k, o && o.tid]); },
		newMid: mid, peerSyncShim: () => ({}),
		msgTombstone: (ids) => { ids.forEach((i) => { tombs[i] = 1; events.push(['tomb', i]); }); },
		loadMsgTombs: () => tombs,
		// The hand-off as `maybeAutoDispatch` makes it: a presence read awaited, then the turn's
		// stamped message under the id given and its dispatched placeholder (`handOffTurn` → mark).
		maybeAutoDispatch: async (chat, text, words, m) => {
			await new Promise((r) => { gate = r; });
			const umid = m || mid();
			api.pushUserRecord(chat, api.touchMsg({ role: 'user', content: text, mid: umid, iturn: umid, ts: clock }), true);
			api.markTurnDispatched(chat, { why: 'dispatched', iturn: umid, itext: text, dispatchedBy: 'PAGE',
				toDevice: 'RUNNER', toNative: 1, ts: clock });
			return true;
		},
	};
	const keys = Object.keys(S);
	const api = new Function('S', 'window', 'Date',
		'var DaimondPeer = window.DaimondPeer, DaimondLease = window.DaimondLease, DaimondSync = window.DaimondSync,'
		+ ' DaimondPresence = window.DaimondPresence;\n'
		+ 'var DaimondStamp = (function () { var window = {}; ' + stampSrc + '\n return window.DaimondStamp; })();\n'
		+ keys.map((k) => 'var ' + k + ' = S.' + k + ';').join('\n') + '\n'
		+ liftSource(['mergeMessages'], ['loadMsgTombs', 'window', 'DaimondStamp']).src + '\n'
		+ lifted.join('\n') + '\n' + reconcile
		+ 'return { ' + FNS.map((n) => n + ': ' + n).join(', ') + ', mergeMessages: mergeMessages,'
		+ ' reconcileMerged: reconcileMerged, chats: chats };')(S, W, D);

	const chat = { id: 'hc3', _loaded: true, messages: [] };
	S.chats.push(chat);
	const live = (t) => { leases[t] = { holder: 'RUNNER', mode: 'running', expiry: clock + 10 * MIN, renewedAt: clock }; api.updateExpedite(); };
	const settle = (t) => { leases[t] = { holder: 'RUNNER', mode: 'released', settled: 1, expiry: 0, renewedAt: clock }; api.updateExpedite(); };
	const frame = (t, run, text, ts) => ({ turn: t, seq: 1, final: true, tail: JSON.stringify({ v: 1, msgs: [
		{ mid: run + '-final', role: 'assistant', content: text, ts, run, ranOn: 'RUNNER', whole: 1 },
		{ mid: run + '-end', role: 'end_log', content: '', ts, run, whole: 1 }] }) });
	// A parcel pull: the store's copy unioned in, then the merge's reconcile of placeholders.
	const pull = () => {
		chat.messages = api.mergeMessages(JSON.parse(JSON.stringify(chat.messages)), chat.messages, chat.id, tombs);
		api.reconcileMerged();
	};
	// The page's `onReport`, in its order (daimond.js DaimondPeer.onReport).
	const report = (t, heard) => {
		const rep = { t: 'report', turnId: t, chatId: chat.id, status: 'done', heard: heard || [] };
		S.peerReports[t] = rep;
		delete lastReads[t];		// only a read the report starts finds the final frame
		api.requeueUnheard(rep);
		api.updateExpedite();
		api.adoptFinalFrame(t);
	};
	const lastRead = (t, f) => { const fn = lastReads[t]; if (fn) fn(f); return !!fn; };
	const answerOf = (t) => chat.messages.filter((m) => m.role === 'assistant' && String(m.iturn) === t
		&& !m.provisional && m.content && m.content.trim());
	const phOf = (t) => api.dispatchedPlaceholderIn(chat, t);
	// A plain hand-off: sent, claimed, reported, its frame read last, pulled.
	const handOff = async (text, run, ans) => {
		const p = S.maybeAutoDispatch(chat, text, '', '');
		clock += 50; gate(); await p; await flush();
		const t = chat.messages.filter((m) => m.role === 'user').slice(-1)[0].mid;
		clock += 1000; live(t);
		clock += 5000; report(t, []); settle(t);
		lastRead(t, frame(t, run, ans, clock - 10)); pull();
		return t;
	};

	// Turn 1 is sent and claimed; a cut-in is said into it while it runs.
	clock += 1000;
	const p1 = S.maybeAutoDispatch(chat, 'review the plan', '', '');
	clock += 50; gate(); await p1; await flush();
	const T1 = chat.messages[0].mid;
	clock += 1000; live(T1);
	clock += 60000;
	const said2 = await api.sayToRunner(chat, { iturn: T1 }, 'and check the tests', 'and check the tests');
	check('HATE-3: the cut-in is said into turn 1', said2 === true, String(said2));
	const T2 = chat.messages[chat.messages.length - 1].mid;
	// Turn 1 ends without hearing it: the report re-sends it as turn 2 under the said id, and the
	// watch's last read of turn 1 lands while that hand-off's presence read is out. The runner
	// stamped turn 1's rows at its settle, a moment after the page's clock read for turn 2.
	clock += 60000;
	report(T1, []);
	settle(T1);
	clock += 300;
	gate(); await flush();
	lastRead(T1, frame(T1, 'R1', 'answer one', clock + 400));
	pull();
	check('HATE-3: turn 1 answered and its placeholder gone', answerOf(T1).length === 1 && !phOf(T1), JSON.stringify(chat.messages));
	check('HATE-3: the cut-in went out as turn 2, under its said id, with its placeholder', !!phOf(T2)
		&& chat.messages.filter((m) => m.mid === T2).length === 1, JSON.stringify(chat.messages));
	// Turn 2 is claimed, runs and settles done; a pull lands meanwhile.
	clock += 1000; live(T2);
	clock += 1000; pull();
	check('HATE-3 (a): turn 2 is watched while its runner holds it', watched.indexOf(T2) !== -1 && !!S._progressWatched[T2],
		JSON.stringify({ watched, ph: !!phOf(T2), fin: api.dispatchedAnswerPresent(chat, phOf(T2) || {}) }));
	check('HATE-3 (c): no pull drops turn 2\'s placeholder before its answer', !!phOf(T2), JSON.stringify(chat.messages));
	clock += 120000;
	report(T2, []);
	const read2 = lastRead(T2, frame(T2, 'R2', 'answer two', clock - 50));
	check('HATE-3 (a): its report ends the watch with a last read', read2, JSON.stringify(Object.keys(lastReads)));
	settle(T2); pull();
	const a2 = answerOf(T2);
	check('HATE-3 (b): turn 2\'s final frame is folded and adopted as its answer', a2.length === 1 && a2[0].content === 'answer two',
		JSON.stringify(chat.messages));
	const phTomb = events.findIndex((e) => e[0] === 'tomb' && !chat.messages.some((m) => m.mid === e[1]) && e[1] !== T2);
	check('HATE-3: and its placeholder goes only with the answer drawn', !phOf(T2) && events.some((e) => e[0] === 'arrive' && e[2] === T2),
		JSON.stringify({ events, phTomb }));
	// The next two hand-offs leave turn 2's answer standing.
	await handOff('next one', 'R3', 'answer three');
	await handOff('and another', 'R4', 'answer four');
	const kept2 = answerOf(T2);
	check('HATE-3 (c): turn 2\'s answer survives the next two hand-offs', kept2.length === 1 && !tombs[kept2[0].mid]
		&& !tombs[T2] && chat.messages.some((m) => m.mid === T2), JSON.stringify(chat.messages.map((m) => [m.mid, m.role, m.iturn, m.content])));
})();

console.log('\n' + (checks - failures) + '/' + checks + ' passed');
if (failures) process.exit(1);
