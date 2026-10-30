/* ============================================================
   leasecontend.test.mjs -- does one lease record per account contend once Here turns
   take leases too? (P2.3, design "Open for the P2.3 builder")

   Two Here turns on two devices and one hand-off on a third run at once against ONE
   lease door, each through its whole life: take, done, released. The door is the
   gateway's compare-and-set (a write at a stale base is a 409) with a round trip of
   latency. The test counts the 409s the door answers and checks every write landed.
   Printed: the 409 count for simultaneous starts and for starts spread over a window.

   Run: node www/js/leasecontend.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
const J = JSON.stringify;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPeer() {
	const win = { addEventListener() {}, dispatchEvent() { return true; } };
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
	return win;
}

// The lease door: one versioned record per `key(turn)`, `rtt` ms per call.
function makeDoor(rtt, key) {
	const recs = new Map();						// key -> { version, leases }
	let conflicts = 0, writes = 0;
	const rec = (k) => { if (!recs.has(k)) recs.set(k, { version: 1, leases: {} }); return recs.get(k); };
	return {
		cas(turn) {
			const k = key(turn);
			return {
				read: async () => { await wait(rtt / 2); const r = rec(k); const out = { version: r.version, leases: JSON.parse(J(r.leases)) }; await wait(rtt / 2); return out; },
				write: async (base, next) => {
					await wait(rtt / 2);
					const r = rec(k);
					writes++;
					let out;
					if (base !== r.version) { conflicts++; out = { ok: false, version: r.version, leases: JSON.parse(J(r.leases)) }; }
					else { r.version += 1; r.leases = JSON.parse(J(next)); out = { ok: true, version: r.version }; }
					await wait(rtt / 2);
					return out;
				},
			};
		},
		lease: (turn) => rec(key(turn)).leases[turn],
		conflicts: () => conflicts,
		writes: () => writes,
	};
}

// One turn's lease life on its own device.
async function life(L, door, t, startAt) {
	await wait(startAt);
	const cas = door.cas(t.turn);
	const now = () => Date.now();
	const took = t.here
		? await L.takeHere(t.turn, t.chat, t.dev, cas, now)
		: await L.take(t.turn, { holder: t.dev, eid: 'e-' + t.turn, chatId: t.chat, deadline: Date.now() + 600000 }, cas, now);
	if (!took.won) return { turn: t.turn, ok: false, why: 'take ' + (took.why || took.holder) };
	await wait(t.runMs);
	const d = await L.complete(t.turn, t.dev, cas, now);
	if (!d.ok) return { turn: t.turn, ok: false, why: 'done ' + d.why };
	const r = await L.release(t.turn, t.dev, cas, now);
	return { turn: t.turn, ok: !!r.ok, why: r.ok ? '' : 'released ' + r.why };
}

async function trial(key, spreadMs, rtt) {
	const door = makeDoor(rtt, key);
	const turns = [
		{ turn: 'here-a', chat: 'chat-a', dev: 'PHONE',  here: true,  runMs: 400 },
		{ turn: 'here-b', chat: 'chat-b', dev: 'LAPTOP', here: true,  runMs: 400 },
		{ turn: 'hand-c', chat: 'chat-c', dev: 'DESK',   here: false, runMs: 400 },
	];
	const out = await Promise.all(turns.map((t) => {
		const L = loadPeer().DaimondLease;
		return life(L, door, t, Math.round(Math.random() * spreadMs));
	}));
	const settled = turns.every((t) => { const l = door.lease(t.turn); return l && l.mode === 'released' && l.settled === 1; });
	return { conflicts: door.conflicts(), writes: door.writes(), ok: out.every((o) => o.ok) && settled,
		why: out.filter((o) => !o.ok).map((o) => o.turn + ':' + o.why).join(',') };
}

const TRIALS = 8, RTT = 80;
const perAccount = (turn) => 'lease:acct';
const perTurn    = (turn) => 'lease:acct:' + turn;
for (const [name, key] of [['lease:<account>', perAccount], ['lease:<account>:<turn>', perTurn]]) {
	for (const spread of [0, 1000]) {
		const rs = [];
		for (let i = 0; i < TRIALS; i++) rs.push(await trial(key, spread, RTT));
		const c = rs.map((r) => r.conflicts), w = rs.map((r) => r.writes);
		const sum = (a) => a.reduce((x, y) => x + y, 0);
		console.log('  ' + name + ', starts within ' + spread + ' ms, rtt ' + RTT + ' ms: 409s per trial ['
			+ c.join(' ') + '] (total ' + sum(c) + ' of ' + sum(w) + ' writes, max ' + Math.max(...c) + ')');
		check(name + ' spread ' + spread + ': every take, done and release lands', rs.every((r) => r.ok),
			rs.map((r) => r.why).filter(Boolean).join(' | '));
		if (key === perTurn) check(name + ' spread ' + spread + ': no 409 between turns', sum(c) === 0, c.join(' '));
	}
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
