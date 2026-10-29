/* ============================================================
   Test -- a long running turn is not killed at 15 minutes, and every cut ends with
   words (UNBLOCK-25 TURN-CUT, U3 + U4).

   THE BUG (Reit Hoogland, 18 Oct 2026, turn mvcihd5w-1-lhkix). The hand-off's
   `DISPATCH_DEADLINE_MS` says how late another device may START a turn. The runner
   claimed its lease straight to that deadline and raced the run against it, so a
   healthy turn still working at 15 minutes was killed mid-reply (`lease_deadline`),
   and the page then recorded the cut as `out:'error'` with no words to him.

   THE FIX.
     U3  The deadline bounds only the start. A running turn holds its lease by
         renewing it through the door ahead of its expiry (`RUN_HOLD_MS`), so the
         asking device reads it live and never re-runs or takes it; it is bounded by
         the take-back read and the 30-minute hung cap. A lease that cannot be held
         (the door refuses the renew) lapses, and the run ends there: Interrupted +
         Retry on the asker, as before, and never two runs.
     U4  Every cut (start deadline, lapse, lease cap, take-back, Stop) is recorded
         as stopped, never as error, and ends with a plain account written by the
         page: why it stopped and what it had done (`cutAccount`).

   Drives the REAL peer.js (DaimondPeer.runErrand, DaimondLease) on a virtual clock
   and lifts the page's helpers from daimond.js.   `node www/js/turncut.test.mjs`
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

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
		let body = readPage(join(HERE, rel), 'utf8');
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

const { P, L } = loadPeer();
check('peer.js loads DaimondPeer and DaimondLease', !!P && !!L && typeof P.runErrand === 'function');

// ── U3 (a): a turn still RUNNING 16 minutes after its birth is not killed, and while
//    the runner holds it the asking device neither re-runs nor takes it. ──
{
	L.forget();
	const TID = 'turn-long';
	const door = makeDoor();
	const timer = makeFakeTimer();
	const born = 1792248499940;
	let clock = born + 700;
	const whys = [], posts = [];
	let finish = null;
	const errand = sentErrand(P, { turnId: TID, chatId: 'c', prompt: 'OCR the letters', eid: 'e1',
		ts: born, deadline: born + 15 * MIN, dispatchedBy: 'PHONE' });
	const running = P.runErrand(errand, {
		selfId: 'ARGONAUT', selfName: 'argonaut', cas: P.syncCas(door), now: () => clock,
		setTimer: timer.set, clearTimer: timer.clear, livenessGapMs: 0,
		reconstruct: async () => ({ chat: { id: 'c', messages: [] } }),
		runTurn: () => new Promise((r) => { finish = r; }),
		abort: (why) => { whys.push(why); },
		endLocal: async () => {},
		pushResult: async () => 9, post: async (r) => { posts.push(r); }, ack: async () => {},
	});
	let settled = null;
	running.then((r) => { settled = r; });
	await flush();
	const tick = timer.handles[0] && timer.handles[0].fn;
	check('U3: the run started its liveness ticker', typeof tick === 'function');
	// The ticker runs every 30 s; step the virtual clock through 16 minutes of a busy turn.
	for (let t = 30000; t <= 16 * MIN && settled === null; t += 30000) {
		clock = born + 700 + t;
		await tick(); await flush(2);
	}
	check('U3: a turn running 16 minutes after its birth is NOT killed',
		settled === null && whys.length === 0, JSON.stringify({ settled, whys }));
	const lz = door.leases()[TID];
	check('U3: its lease is still live on the door past the start window',
		!!lz && L.live(lz, clock) && lz.holder === 'ARGONAUT', JSON.stringify(lz));
	const placeholder = { why: 'dispatched', iturn: TID, mid: TID, ts: born, deadline: born + 15 * MIN, dispatchedBy: 'PHONE' };
	check('U3: the asking device reads it running', P.uiState(placeholder, lz, null, 'PHONE', clock) === 'running',
		P.uiState(placeholder, lz, null, 'PHONE', clock));
	check('U3: and does not recover (re-run) it', P.recoverDecision(placeholder, lz, false, 'PHONE', clock) === false);
	const other = await L.take(TID, { holder: 'PHONE', eid: 'e1', deadline: born + 15 * MIN, ts: born }, P.syncCas(door), () => clock);
	check('U3: nor can it take the turn (no double run)', other && other.won === false, JSON.stringify(other));
	// The turn ends on its own: answered, never cut.
	finish({ ok: true });
	await flush(10);
	check('U3: the long turn finishes as done, not aborted',
		!!settled && settled.done === true && !settled.aborted, JSON.stringify(settled));
	check('U3: and nothing aborted the engine', whys.length === 0, JSON.stringify(whys));
}

// ── U3 (b): a lease the runner CANNOT hold (the door refuses the renew) lapses, and
//    the run ends there, so the asker's Interrupted + Retry can never be a second run. ──
{
	L.forget();
	const TID = 'turn-lapse';
	const door = makeDoor();
	const timer = makeFakeTimer();
	const born = 1792248499940;
	let clock = born + 700;
	const whys = [], posts = [];
	const errand = sentErrand(P, { turnId: TID, chatId: 'c', prompt: 'p', eid: 'e2',
		ts: born, deadline: born + 15 * MIN, dispatchedBy: 'PHONE' });
	const running = P.runErrand(errand, {
		selfId: 'ARGONAUT', selfName: 'argonaut', cas: P.syncCas(door), now: () => clock,
		setTimer: timer.set, clearTimer: timer.clear, livenessGapMs: 0,
		reconstruct: async () => ({ chat: { id: 'c', messages: [] } }),
		runTurn: () => new Promise(() => {}),
		abort: (why) => { whys.push(why); }, endLocal: async () => {},
		pushResult: async () => 9, post: async (r) => { posts.push(r); }, ack: async () => {},
	});
	let settled = null;
	running.then((r) => { settled = r; });
	await flush();
	const tick = timer.handles[0].fn;
	door.refuseWrites(true);
	for (let t = 30000; t <= 16 * MIN && settled === null; t += 30000) {
		clock = born + 700 + t;
		await tick(); await flush(4);
	}
	check('U3: a lease that could not be held ends the run once it lapses',
		!!settled && settled.aborted === true, JSON.stringify(settled));
	check('U3: and the engine is told it lapsed, not that a deadline passed',
		whys[0] === 'lease_lapsed', JSON.stringify(whys));
	const lz = door.leases()[TID];
	const placeholder = { why: 'dispatched', iturn: TID, mid: TID, ts: born, deadline: born + 15 * MIN, dispatchedBy: 'PHONE' };
	const ui = P.uiState(placeholder, lz, null, 'PHONE', clock);
	check('U3: the asker reads the lapsed lease as stopped mid-run (Interrupted + Retry)', ui === 'failed', ui);
}

// ── U4: every cut is recorded as stopped and ends with a plain account. ──
function extractFn(src, name) {
	const start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return null;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}
{
	const src = readPage(join(HERE, 'daimond.js'), 'utf8');
	const en = readPage(join(HERE, '..', 'i18n', 'en.js'), 'utf8');
	const fns = ['cutReason', 'cutAccount'].map((n) => extractFn(src, n));
	check('U4: the page has cutReason and cutAccount', fns.every(Boolean));
	if (fns.every(Boolean)) {
		const table = {};
		for (const m of en.matchAll(/'(cut\.[a-z_.]+)':\s*'((?:[^'\\]|\\.)*)'/g)) table[m[1]] = m[2].replace(/\\'/g, "'");
		const tOr = (k, fb, p) => String(table[k] != null ? table[k] : fb).replace(/\{(\w+)\}/g, (_, x) => (p && p[x] != null ? p[x] : ''));
		const tn = (k, n, p) => tOr(k + (n === 1 ? '.one' : '.other'), k, p);
		const api = new Function('tOr', 'tn', fns.join('\n') + '\nreturn { cutReason: cutReason, cutAccount: cutAccount };')(tOr, tn);
		for (const why of ['lease_cap', 'lease_lapsed', 'lease_revoked', 'lease_deadline', 'user']) {
			check('U4: a ' + why + ' stop is a cut', api.cutReason(why) === why, String(api.cutReason(why)));
		}
		check('U4: an engine poison or an unnamed abort is not a cut it explains', api.cutReason('') === '' && api.cutReason('stream_abort') === '');
		const tools = [
			{ role: 'tool_log', name: 'file_read', outcome: 'failed' },
			{ role: 'tool_log', name: 'file_write', args: '{"path":"ocr/p001.typ","content":"x"}', outcome: 'ok' },
			{ role: 'tool_log', name: 'ocr', outcome: 'refused' },
		];
		const acc = api.cutAccount('lease_cap', tools);
		check('U4: the account says why it stopped', /30-minute/.test(acc), acc);
		check('U4: and what it had done: the calls and the file it wrote', /3 tool calls/.test(acc) && /ocr\/p001\.typ/.test(acc), acc);
		const none = api.cutAccount('lease_revoked', []);
		check('U4: a cut before any tool still has words', /another device/.test(none) && none.length > 20, none);
		for (const why of ['lease_cap', 'lease_lapsed', 'lease_revoked', 'lease_deadline', 'user']) {
			const a = api.cutAccount(why, tools);
			check('U4: the ' + why + ' account is written in English words, no raw key', a && !/cut\./.test(a), a);
		}
	}
	// The ending: a cut is `stopped`, never `error` (the turn.end `out`).
	const outAt = src.indexOf("out:  (chat._aborted || pausedBack");
	const outLine = outAt >= 0 ? src.slice(outAt, src.indexOf('\n', outAt)) : '';
	check('U4: the turn.end record reads a cut as stopped before it reads a throw as error',
		/cutWhy/.test(outLine), outLine.trim());
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures) process.exit(1);
