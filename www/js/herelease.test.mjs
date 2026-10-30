/* Test -- a Here turn holds a lease, so the one dead-writer detector can end it (P2.3c1, design §2 [F3]).
   THE SEAM. P2.3b3 gave the lease view `DaimondLease.takeHere` and the detector reads every lease past its
   deadline; nothing took one for a turn run here, so a tab that died mid-turn left that turn open in the log.
   WHAT IS CHECKED. The REAL `takeHereLease` lifted from the page, run on stubs, and `runTurn`'s source (too large
   to run here): it takes the lease on send, after the prompt reaches the log, for a Here turn only.
   Run:  node --test www/js/herelease.test.mjs */
import { readPage } from '../../dev/pagesrc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readPage(join(HERE, 'daimond.js'), 'utf8');

/// The source of `function name(...) {...}`, brace-balanced, or null.
function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return null;
	let depth = 0, i = src.indexOf('{', start);
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}' && --depth === 0) break;
	}
	return src.slice(start, i + 1);
}

test('runTurn takes the Here lease on send, after the prompt is logged, for a Here turn only', () => {
	const run = lift(SRC, 'runTurn');
	assert.ok(run, 'runTurn is in the page');
	const logged = run.indexOf('logTurnRows(chat, umid);');
	const took = run.indexOf('takeHereLease(chat, umid)');
	assert.ok(took > 0, 'runTurn calls takeHereLease');
	assert.ok(logged > 0 && took > logged, 'after the prompt reaches the log');
	assert.match(run, /hereLease = opts\.turnId \? null : takeHereLease\(chat, umid\)/, 'a hand-off run holds its own lease');
	const end = run.indexOf("logTurnRows(chat, umid, {");
	assert.ok(end > 0 && run.indexOf('if (hereLease) hereLease();', end) > end, 'the end completes the lease');
});

function rig(record, chat) {
	const calls = [], renews = [], done = [], timers = [], watches = {}, aborts = [], cancels = [];
	let rec = record;
	const L = {
		RUN_HOLD_MS: 300,
		record: () => rec,
		verdict: (r, self) => (r.holder !== self ? 'not_ours' : r.mode === 'released' ? (r.settled ? 'stopped' : 'released') : 'ours'),
		watch: (t, f) => { watches[t] = f; return () => { if (watches[t] === f) delete watches[t]; }; },
		takeHere: (...a) => { calls.push(a); rec = { holder: 'dev1', mode: 'claimed', expiry: 1000 }; return Promise.resolve({ won: true }); },
		renew: (...a) => { renews.push(a); rec = Object.assign({}, rec, { mode: 'running', expiry: rec.expiry + 300 }); return Promise.resolve({ ok: true }); },
		complete: (...a) => { done.push(a); return Promise.resolve({ ok: true }); },
	};
	const win = { DaimondLease: L, DaimondPeer: { syncCas: (s) => ({ cas: s }) } };
	const clock = { now: 0 };
	const body = lift(SRC, 'takeHereLease');
	assert.ok(body, 'takeHereLease is in the page');
	const fn = new Function('window', 'DaimondLease', 'DaimondPeer', 'selfDeviceId', 'peerSyncShim', 'leaseClockNow', 'diag',
		'turnLogEnded', 'setInterval', 'clearInterval', 'syncSendMode', 'Workers', 'abortTurn', body + '\nreturn takeHereLease;')(
		win, L, win.DaimondPeer, () => 'dev1', () => 'shim', () => clock.now, () => {}, () => false,
		(f) => { timers.push(f); return timers.length; }, (i) => { timers[i - 1] = null; },
		() => {}, { cancelAwaits: (id) => cancels.push(id) }, (c) => aborts.push(c));
	const tick = async (now) => { clock.now = now; for (const f of timers) if (f) await f(); await null; };
	// Another device's write reaching the lease view: the record moves, and the view's watch fires.
	const move = (r, quiet) => { rec = r; if (!quiet) for (const f of Object.values(watches)) f(); };
	return { fn, calls, renews, done, timers, tick, watches, aborts, cancels, move };
}

test('takeHereLease takes (turn, chat, this device, the sync CAS, the lease clock)', async () => {
	const { fn, calls } = rig(null);
	fn({ id: 'c1' }, 'u1');
	await null;
	assert.equal(calls.length, 1);
	const [turn, chat, self, cas, clock] = calls[0];
	assert.deepEqual([turn, chat, self, cas, clock()], ['u1', 'c1', 'dev1', { cas: 'shim' }, 0]);
});

test('a turn the lease view already holds (a retry\'s own lease) is not taken again', async () => {
	const { fn, calls, timers } = rig({ holder: 'dev1', mode: 'claimed' });
	const stop = fn({ id: 'c1' }, 'u1');
	await null;
	assert.equal(calls.length, 0);
	assert.equal(timers.length, 0);
	assert.equal(typeof stop, 'function');
});

test('a Here turn running past its deadline holds its lease, so no detector reads it dead', async () => {
	const { fn, renews, tick } = rig(null);
	fn({ id: 'c1' }, 'u1');
	await null; await null;
	await tick(100);
	assert.equal(renews.length, 0, 'well inside the deadline: no door write');
	await tick(900);
	assert.equal(renews.length, 1, 'within half a hold of lapsing: held');
	assert.deepEqual([renews[0][0], renews[0][1], renews[0][4]], ['u1', 'dev1', { holdMs: 300 }]);
	await tick(950);
	assert.equal(renews.length, 1, 'held ahead: no second write yet');
});

test('the turn\'s end completes its Here lease and stops the hold', async () => {
	const { fn, renews, done, timers, tick } = rig(null);
	const stop = fn({ id: 'c1' }, 'u1');
	await null; await null;
	stop();
	await null;
	assert.deepEqual(done.map(d => [d[0], d[1]]), [['u1', 'dev1']]);
	assert.ok(timers.every(t => t === null), 'the hold is stopped');
	await tick(990);
	assert.equal(renews.length, 0);
});

// UNBLOCK-28 (d), gw:turnlog_two: A's Stop revoked B's Here lease settled, B never heard it, and its
// turn ran on to end `done`. The revoke now ends the run here as its Stop, through the one end path.
test('another device\'s Stop (a settled revoke) ends the Here turn as a Stop pressed here', async () => {
	const chat = { id: 'c1', _generating: true, _turnTag: 'u1' };
	const { fn, watches, aborts, cancels, done, move } = rig(null);
	fn(chat, 'u1');
	await null; await null;
	assert.equal(typeof watches.u1, 'function', 'the won lease is watched');
	move({ holder: 'dev1', mode: 'running', expiry: 1300 });
	assert.equal(aborts.length, 0, 'a renew is not a revoke');
	move({ holder: 'dev1', mode: 'released', settled: 1, expiry: 0 });
	assert.deepEqual([chat._aborted, chat._stopWhy], [true, 'user'], 'read by the end as `stopped`');
	assert.deepEqual([aborts.length, cancels], [1, ['c1']], 'its run and its gathers are stopped');
	assert.equal(watches.u1, undefined, 'the watch ends with it');
	assert.equal(done.length, 0, 'a revoked lease is not completed');
});

test('a revoke not settled, or another holder, cuts the Here turn `lease_revoked`', async () => {
	for (const r of [{ holder: 'dev1', mode: 'released', expiry: 0 }, { holder: 'dev2', mode: 'claimed', expiry: 900 }]) {
		const chat = { id: 'c1', _generating: true, _turnTag: 'u1' };
		const { fn, aborts, move } = rig(null);
		fn(chat, 'u1');
		await null; await null;
		move(r);
		assert.deepEqual([chat._aborted, chat._stopWhy, aborts.length], [true, 'lease_revoked', 1], JSON.stringify(r));
	}
});

test('a revoke heard after the turn moved on leaves the chat\'s next turn running', async () => {
	const chat = { id: 'c1', _generating: true, _turnTag: 'u1' };
	const { fn, aborts, move } = rig(null);
	fn(chat, 'u1');
	await null; await null;
	chat._turnTag = 'u2';
	move({ holder: 'dev1', mode: 'released', settled: 1, expiry: 0 });
	assert.deepEqual([chat._aborted, aborts.length], [undefined, 0]);
});

test('a revoke the view\'s wake missed is read at the next hold beat', async () => {
	const chat = { id: 'c1', _generating: true, _turnTag: 'u1' };
	const { fn, tick, aborts, renews, move } = rig(null);
	fn(chat, 'u1');
	await null; await null;
	move({ holder: 'dev1', mode: 'released', settled: 1, expiry: 0 }, true);	// the wake never came
	await tick(100);
	assert.deepEqual([chat._stopWhy, aborts.length, renews.length], ['user', 1, 0]);
});
