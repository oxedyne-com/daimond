/* ============================================================
   Test: Pause all stops a turn another device runs (PAUSEP).

   "Pause all" aborted the turns running in this tab and paused its
   workers, but a turn running on argonaut, under Kimberlite or a
   tab, ran on: no page code revoked its lease on a pause, and the
   runner reads the pause record only for its web hold. The pause
   now stops such a turn exactly as his Stop does (`peerStopTurn`):
   the lease is revoked SETTLED, which the runner reads as Stop,
   keeping its partial answer, and which every take refuses.

     PS1  Pause all: a Kimberlite's running turn has its lease
          revoked settled, once, through `peerStopTurn`
     PS2  a tab turn here is still aborted as before
     PS3  a turn whose chat is not held runs on (a chat's pause stops
          only that chat's turn on another device)
     PS4  this device's own lease, and a run already done, are left
     PS5  a turn whose chat record is not on this device is stopped
          by Pause all all the same
     PS6  resume does nothing to a stopped turn, and a second pause
          does not stop it again
     PS7  no stop failed

   Lifts the REAL functions out of daimond.js and runs them in a scope
   of fakes; a free name the fakes lack throws.

   Run:  node www/js/pausestop.test.mjs
   ============================================================ */
import { source, lift } from './testlift.mjs';

const SRC = source('daimond.js');

let checks = 0, failures = 0;
function check(name, ok, detail) {
	checks++;
	if (ok) { console.log('  ok   ' + name); return; }
	failures++;
	console.log('  FAIL ' + name + (detail ? '\n       ' + detail : ''));
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

const SELF = 'desk1', KIMB = 'argonaut-k';
const FNS = ['brakeHeld', 'turnHold', 'chatSpendNode', 'peerHeldTurns', 'peerLeaseHeld', 'peerStopTurn'];

// The world: `chats` are this device's records, `leases` the lease table, `paused` the held nodes
// (a node is held when it or a branch above it is).
function world(chats, leases) {
	const W = { revokes: [], aborted: [], pausedWorkers: 0, paused: new Set(), toasts: [] };
	const env = {
		Date, String, Object, Array, JSON, Math, Promise, Error,
		chats, current: null,		// the page view reads `pg.chats` as `chats`
		t: (k) => k, diag: () => {}, toast: (m) => { W.toasts.push(m); },
		selfDeviceId: () => SELF,
		Workers: { cancelAwaits: () => {}, pauseHeld: () => { W.pausedWorkers++; } },
		abortTurn: (c) => { W.aborted.push(c.id); },
		DaimondPause: {
			ROOT: 'root',
			id: (...a) => a.filter((s) => s != null && s !== '').join('/'),
			isPaused: (n) => { for (let p = n; p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') if (W.paused.has(p)) return true; return false; },
		},
		DaimondModels: { held: (n) => !!(n && env.DaimondPause.isPaused(n)) },
		DaimondLease: {
			snapshot: () => (Object.keys(leases).length ? leases : null),
			record: (tid) => leases[tid] || null,
			holder: (tid) => { const r = leases[tid]; return r && (r.mode === 'running' || r.mode === 'claimed' || r.mode === 'done') ? r.holder : null; },
			revoke: async (tid, cas, now, opts) => {
				await tick();
				W.revokes.push({ tid, settle: !!(opts && opts.settle) });
				const r = leases[tid];
				if (r) { r.mode = 'released'; if (opts && opts.settle) r.settled = 1; }
				return { ok: true };
			},
		},
		DaimondPeer: { syncCas: () => ({}), retryUnread: (f) => f() },
		peerSyncShim: () => ({}), syncSendMode: () => {},
		clearDispatchFallback: () => {}, dropDispatchedPlaceholder: () => {}, renderDispatchedBadges: () => {},
		_peerStopping: Object.create(null), _handoffStart: {},
	};
	env.window = env;
	const L = lift(SRC, FNS);
	W.missing = L.missing;
	const body = L.body + '\nreturn {' + FNS.map((n) => n + ': ' + (L.missing.includes(n) ? 'null' : n)).join(', ') + '};';
	const scope = new Proxy(env, {
		has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
		get: (t, k) => { if (!(k in t) && typeof k === 'string' && !(k in globalThis)) throw new ReferenceError(k + ' is not in the fakes'); return t[k]; },
		set: (t, k, v) => { t[k] = v; return true; },
	});
	W.f = new Function('scope', 'with (scope) {\n' + body + '\n}')(scope);
	W.leases = leases;
	return W;
}

const kimbLease = (tid, chatId) => ({ turnId: tid, holder: KIMB, mode: 'running', chatId, dispatchedBy: SELF, renewedAt: 1 });

async function main() {
	// One account: chat k1 sent to argonaut's Kimberlite and running there, chat k2 also running
	// there, chat h1 running in this tab, chat o1 this device's own run for another, chat d1 done.
	const chats = [
		{ id: 'k1', messages: [{ role: 'user', content: 'ocr these pages', mid: 'tk1', iturn: 'tk1' }] },
		{ id: 'k2', messages: [{ role: 'user', content: 'write the report', mid: 'tk2', iturn: 'tk2' }] },
		{ id: 'h1', messages: [], _generating: true },
		{ id: 'o1', messages: [] },
		{ id: 'd1', messages: [] },
	];
	const leases = {
		tk1: kimbLease('tk1', 'k1'),
		tk2: kimbLease('tk2', 'k2'),
		to1: { turnId: 'to1', holder: SELF, mode: 'running', chatId: 'o1', renewedAt: 1 },
		td1: { turnId: 'td1', holder: KIMB, mode: 'done', chatId: 'd1', renewedAt: 1 },
		tx1: kimbLease('tx1', 'elsewhere'),	// a chat whose record is not on this device
	};

	// A chat's own pause first: only that chat's turn on argonaut stops.
	{
		const W = world(chats.map((c) => Object.assign({}, c)), JSON.parse(JSON.stringify(leases)));
		if (W.missing.length) console.log('  note: absent on this revision: ' + W.missing.join(', '));
		W.paused.add('root/chats/k2');
		try { W.f.brakeHeld(); } catch (e) { console.log('  note: brakeHeld threw ' + e.message); }
		await settle();
		const tids = W.revokes.map((r) => r.tid);
		check('PS3 a chat\'s pause stops that chat\'s turn on argonaut and no other',
			tids.length === 1 && tids[0] === 'tk2' && W.revokes[0].settle, JSON.stringify(W.revokes));
	}

	// Pause all.
	const W = world(chats, leases);
	W.paused.add('root');
	try { W.f.brakeHeld(); } catch (e) { console.log('  note: brakeHeld threw ' + e.message); }
	await settle();
	const by = (tid) => W.revokes.filter((r) => r.tid === tid);
	check('PS1 Pause all revokes the Kimberlite turn\'s lease settled, once',
		by('tk1').length === 1 && by('tk1')[0].settle && by('tk2').length === 1 && by('tk2')[0].settle
			&& leases.tk1.mode === 'released' && leases.tk1.settled === 1,
		JSON.stringify(W.revokes));
	check('PS2 the tab turn here is aborted and the workers paused, as before',
		W.aborted.length === 1 && W.aborted[0] === 'h1' && W.pausedWorkers === 1, JSON.stringify(W.aborted));
	check('PS4 this device\'s own lease and a run already done are left',
		by('to1').length === 0 && by('td1').length === 0 && leases.to1.mode === 'running' && leases.td1.mode === 'done',
		JSON.stringify(W.revokes));
	check('PS5 a turn whose chat is not on this device is stopped by Pause all',
		by('tx1').length === 1 && by('tx1')[0].settle, JSON.stringify(W.revokes));

	// Resume, then pause again: the stopped turns stay stopped and are not revoked twice.
	const before = W.revokes.length;
	W.paused.delete('root');
	try { W.f.brakeHeld(); } catch (e) { /* counted below */ }
	await settle();
	const resumed = W.revokes.length === before && leases.tk1.mode === 'released' && leases.tk1.settled === 1;
	W.paused.add('root');
	try { W.f.brakeHeld(); } catch (e) { /* counted below */ }
	await settle();
	check('PS6 resume leaves a stopped turn stopped, and a second pause stops nothing twice',
		resumed && W.revokes.length === before && before > 0, 'revokes ' + before + ' -> ' + W.revokes.length);
	check('PS7 no stop failed', W.toasts.length === 0, JSON.stringify(W.toasts));

	console.log('\n' + checks + ' checks, ' + failures + ' FAIL');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.log('  FAIL threw ' + (e && e.stack || e)); process.exit(1); });
