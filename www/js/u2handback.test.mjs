/* ============================================================
   Test: a turn handed back runs here without waiting on a push (U2FIX fix 2,
   rig r572w modelunrun, DIAG_U2R572W §3).

   The runner refused a turn whose models it could not run; the phone took it
   back and `runDispatchFallback` awaited a whole gated `DaimondSync.pull()`,
   which waits out the phone's own push in flight: 9.3 s, 12.46 s in all against
   the 10 s bound. The decision reads only the lease door and the chat, so the
   door's own read (`leaseGet`) is all it needs.

     H1  with a push holding the round gate, the turn is still decided at once
         (since SEND-UNHANDED part 3: "not run" with Retry, not run here)
     H2  the door's lease map is adopted before the decision reads it
     H3  an unreadable door adopts nothing, and the view held here decides
     H4  a live foreign claim on the door stands the fallback down

   Run:  node --test www/js/u2handback.test.mjs
   Red:  MM_SRC_REV=529df246 node --test www/js/u2handback.test.mjs
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { source, lift } from './testlift.mjs';

const SRC = source('daimond.js');
const tick = () => new Promise((r) => setTimeout(r, 0));

function world(over) {
	const log = [];
	const tid = 'T1';
	const m = { why: 'dispatched', iturn: tid, dispatchedBy: 'PHONE' };
	const chat = { id: 'c1', messages: [m] };
	let view = {};
	const env = {
		log, chat, m,
		chats: [chat], _handBack: { T1: 'c1' }, _handBackCause: {}, _localRecovering: {}, _fallbackInFlight: {},
		endHandOffNotRun: async (c, mm) => { log.push(['notRun', mm.iturn]); },
		door: { version: 3, leases: { T1: { holder: 'PHONE', vacated: true } }, unread: false },
		DaimondPost: { collect: async () => { log.push('collect'); } },
		// A push holds the round gate for the whole test: a pull waits behind it, as `gatedPull` does.
		DaimondSync: {
			pull: () => { log.push('pull'); return new Promise(() => {}); },
			leaseGet: async () => { log.push('leaseGet'); return env.door; },
		},
		DaimondLease: {
			adopt: (map) => { log.push(['adopt', Object.keys(map)]); view = map; },
			record: (t) => view[t] || null,
		},
		DaimondPeer: {
			REASON_DISPATCHED: 'dispatched',
			recoverDecision: (mm, lease) => { log.push(['decide', lease]); return !(lease && lease.live); },
			dispatchState: () => 'peer-held',
			runErrand: () => {},
		},
		dispatchedChat: () => null,
		dispatchedTurnFinished: () => false,
		selfDeviceId: () => 'PHONE',
		recoverOneLocally: async (c, mm) => { log.push(['runHere', mm.iturn]); },
		diag: () => {},
		Date, JSON, String, Object, Array, Promise,
	};
	env.window = env;
	return Object.assign(env, over || {});
}

function rig(env) {
	const l = lift(SRC, ['runDispatchFallback']);
	assert.deepEqual(l.missing, []);
	const scope = new Proxy(env, { has: (t, k) => typeof k === 'string' && k in t, get: (t, k) => t[k], set: (t, k, v) => { t[k] = v; return true; } });
	return new Function('scope', 'with (scope) {\n' + l.body + '\nreturn runDispatchFallback;\n}')(scope);
}

// The fallback, given 300 ms: far inside the 10 s bound, and far outside a push's round.
async function within(p) {
	await Promise.race([p, new Promise((r) => setTimeout(r, 300))]);
	for (let i = 0; i < 4; i++) await tick();
}

// Since SEND-UNHANDED part 3 (rulings §1 l.17) a handed-back turn the switch sent is decided at once
// as "not run" with Retry (`endHandOffNotRun`), never run here; H1 and H3 asserted `runHere` before.
const ended = (w) => w.log.some((x) => Array.isArray(x) && x[0] === 'notRun')
	&& !w.log.some((x) => Array.isArray(x) && x[0] === 'runHere');

test('H1: with a push holding the round gate, the handed-back turn is decided at once (not run)', async () => {
	const w = world();
	await within(rig(w)('c1', 'T1'));
	assert.ok(ended(w), 'decided: ' + JSON.stringify(w.log));
	assert.ok(w.log.indexOf('pull') < 0, 'no gated pull: ' + JSON.stringify(w.log));
	assert.equal(w.log[0], 'collect', 'the post box is still collected first');
});

test('H2: the door\'s lease map is adopted before the decision reads it', async () => {
	const w = world();
	await within(rig(w)('c1', 'T1'));
	const a = w.log.findIndex((x) => Array.isArray(x) && x[0] === 'adopt');
	const d = w.log.findIndex((x) => Array.isArray(x) && x[0] === 'decide');
	assert.ok(a >= 0 && d > a, JSON.stringify(w.log));
	assert.deepEqual(w.log[d][1], { holder: 'PHONE', vacated: true });
});

test('H3: an unreadable door adopts nothing; the view held here decides', async () => {
	const w = world();
	w.door = { version: 0, leases: {}, unread: true };
	await within(rig(w)('c1', 'T1'));
	assert.ok(!w.log.some((x) => Array.isArray(x) && x[0] === 'adopt'), JSON.stringify(w.log));
	assert.ok(ended(w), JSON.stringify(w.log));
});

test('H4: a live foreign claim on the door stands the fallback down', async () => {
	const w = world();
	w.door = { version: 4, leases: { T1: { holder: 'ARGONAUT', live: true } }, unread: false };
	await within(rig(w)('c1', 'T1'));
	assert.ok(!w.log.some((x) => Array.isArray(x) && (x[0] === 'runHere' || x[0] === 'notRun')), JSON.stringify(w.log));
});
