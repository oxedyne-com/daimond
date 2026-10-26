/* ============================================================
   agentsacross.test.mjs — every device's Agents panel shows every device's agents (UNBLOCK-28)

   WHAT IS CHECKED. The owner, 20 Oct: "the Agent panel on gilgamesh is still not showing the
   updated info on the argonaut Agent panel". The grid drew `Workers.runs` alone, and no worker
   state crossed devices. Now each device publishes its runs as a sealed frame on the progress
   door under `agents.<deviceId>`, and every peer follows it and draws those runs too.

     (a) across   — device A's runs, framed by `agentsFrame`, read by B's `agentsFromFrame` and
                    held by `peerRunsMerge`, are in B's `peerRunsList` with A's state, and A's
                    run ending reaches B as its ending.
     (b) bounded  — only the whitelisted fields cross (no task, no engine); the working set only
                    (live, or ended within a day); fitted to the door by dropping the OLDEST runs,
                    never by cutting the JSON.
     (c) untrusted— a frame naming another device, an unknown state, an over-long field, junk.
     (d) honest   — a peer not awake cannot still be running: its live runs read `interrupted`;
                    presence unknown leaves them as said; a run this device holds is drawn once.
     (e) wiring   — the grid draws `PeerAgents.list()` beside `Workers.runs`, peer squares are no
                    buttons, every save publishes, the boot starts the follow, a lock forgets, and
                    sync.js's standing watch is not read on every 4 s tick.

   RED before UNBLOCK-28: every arm (the functions and the wiring are absent).

   Run:  node www/js/agentsacross.test.mjs
   ============================================================ */
const { makeWindow, loadScript, TREE } = await import('../../dev/syncprobe.mjs');
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}
const NOW = 1_800_000_000_000, H = 3600e3;
const w = makeWindow({ now: NOW });
try { loadScript(w, 'peer.js'); } catch (e) { /* the builders are defined before any boot step */ }
const P = w.DaimondPeer || {};
const have = ['agentsKey', 'agentsFrame', 'agentsFromFrame', 'peerRunsMerge', 'peerRunsList'].every((k) => typeof P[k] === 'function');
check('peer.js exports the agents-across functions', have);

const weigh = (t) => ({ chars: String(t).length, bytes: Buffer.byteLength(JSON.stringify(String(t))) - 2 });
const BUDGET = { chars: 48 * 1024, bytes: 63 * 1024 };
const A = 'dev-argonaut', B = 'dev-gilgamesh';
const run = (id, status, extra) => Object.assign({ id, name: 'w' + id, status, diamondId: 'D1', diamondName: 'Daimond',
	turnId: 'T1', parentId: 'T1', model: 'deepseek/v4', deviceId: A, costUsd: 0.12, capUsd: 2,
	task: 'SECRET TASK TEXT', text: 'transcript', app: { live: 1 } }, extra || {});

if (have) {
	// (a) across
	const aRuns = [run('w164', 'running'), run('w163', 'done', { endedAt: NOW - H })];
	const f1 = P.agentsFrame(aRuns, A, NOW, BUDGET, weigh);
	const g1 = P.agentsFromFrame(f1, A);
	let store = P.peerRunsMerge({}, g1, NOW);
	let list = P.peerRunsList(store, [A], [], NOW);
	check('(a) B holds A\'s live run, running, device A', list.some((r) => r.id === 'w164' && r.status === 'running' && r.deviceId === A), list);
	check('(a) B holds A\'s run ended within the day', list.some((r) => r.id === 'w163' && r.status === 'done'));
	check('(a) the frame is keyed by device', P.agentsKey(A) === 'agents.' + A);
	const f2 = P.agentsFrame([run('w164', 'capped', { endedAt: NOW + 5e3 }), aRuns[1]], A, NOW + 5e3, BUDGET, weigh);
	store = P.peerRunsMerge(store, P.agentsFromFrame(f2, A), NOW + 5e3);
	list = P.peerRunsList(store, [A], [], NOW + 5e3);
	check('(a) A\'s run ending reaches B as its ending', list.some((r) => r.id === 'w164' && r.status === 'capped'), list);
	const again = P.peerRunsMerge(store, P.agentsFromFrame(f2, A), NOW + 5e3);
	check('(a) taking the same frame twice changes nothing', JSON.stringify(again) === JSON.stringify(store));

	// (b) bounded
	const c = JSON.parse(f1).runs[0];
	check('(b) no task, transcript or engine crosses', !('task' in c) && !('text' in c) && !('app' in c), c);
	check('(b) the grid\'s fields cross', c.diamondId === 'D1' && c.parentId === 'T1' && c.capUsd === 2 && c.costUsd === 0.12, c);
	const old = P.agentsFrame([run('x', 'done', { endedAt: NOW - 25 * H })], A, NOW, BUDGET, weigh);
	check('(b) a run ended over a day ago is not sent', JSON.parse(old).runs.length === 0, old);
	check('(b) an empty list is still a frame', JSON.parse(old).dev === A);
	const many = [];
	for (let i = 0; i < 600; i++) many.push(run('r' + i, 'done', { endedAt: NOW - i, name: 'n'.repeat(80), diamondName: 'd'.repeat(120) }));
	const big = P.agentsFrame(many, A, NOW, BUDGET, weigh);
	let parsed = null;
	try { parsed = JSON.parse(big); } catch (e) { parsed = null; }
	check('(b) an oversized list is fitted whole, under the door', !!parsed && big.length <= BUDGET.chars && parsed.runs.length < 600, big.length);
	check('(b) the OLDEST runs are the ones left out', !!parsed && parsed.runs[0].id === 'r0');

	// (c) untrusted
	check('(c) a frame naming another device is refused', P.agentsFromFrame(f1, B) === null);
	check('(c) junk is refused', P.agentsFromFrame('not json', A) === null && P.agentsFromFrame('{"v":2,"dev":"' + A + '","runs":[]}', A) === null);
	const evil = JSON.stringify({ v: 1, dev: A, runs: [{ id: 'a', status: 'pwned' }, { status: 'running' },
		{ id: 'b'.repeat(500), name: 'n'.repeat(500), status: 'running', costUsd: 'lots', deviceId: B }] });
	const ge = P.agentsFromFrame(evil, A);
	check('(c) unknown states and id-less runs are dropped', ge && ge.runs.length === 1, ge);
	check('(c) long fields are clipped, junk numbers dropped, device is the key\'s',
		ge && ge.runs[0].id.length === 64 && ge.runs[0].name.length === 80 && !('costUsd' in ge.runs[0]) && ge.runs[0].deviceId === A, ge && ge.runs[0]);

	// (d) honest
	const s1 = P.peerRunsMerge({}, g1, NOW);
	const gone = P.peerRunsList(s1, [], [], NOW);
	check('(d) a peer not awake: its running run reads interrupted', gone.some((r) => r.id === 'w164' && r.status === 'interrupted'), gone);
	check('(d) and its ended run stands', gone.some((r) => r.id === 'w163' && r.status === 'done'));
	const unk = P.peerRunsList(s1, null, [], NOW);
	check('(d) presence unknown: live runs stand as said', unk.some((r) => r.id === 'w164' && r.status === 'running'));
	const own = P.peerRunsList(s1, [A], [{ id: 'w164' }], NOW);
	check('(d) a run this device holds is drawn once', !own.some((r) => r.id === 'w164'));
	check('(d) a device silent over a day is dropped', P.peerRunsList(s1, [A], [], NOW + 25 * H).length === 0);
}

// (e) wiring
const APP  = readFileSync(join(TREE, 'www', 'js', 'daimond.js'), 'utf8');
const SYNC = readFileSync(join(TREE, 'www', 'js', 'sync.js'), 'utf8');
const grid = (APP.match(/function renderAgentGrid\(\) \{[\s\S]*?\n\t\}\n/) || [''])[0];
check('(e) the grid draws the peers\' runs beside its own', /Workers\.runs\.concat\([\s\S]*PeerAgents[\s\S]*\.list\(\)/.test(grid));
check('(e) a peer square is no button', /createElement\(peer \? 'span' : 'button'\)/.test(grid));
check('(e) no caller hands the grid a local-only list', !/renderAgentGrid\((this|Workers)\.runs\)/.test(APP));
const persist = (APP.match(/\t\tpersistNow: function \(\) \{[\s\S]*?\n\t\t\},\n/) || [''])[0];
check('(e) every save publishes this device\'s frame', /this\.onSaved\(\)/.test(persist) && /Workers\.onSaved\s*= function \(\) \{ self\.publish\(\); \}/.test(APP));
check('(e) the boot starts the follow', /step\('PeerAgents\.start'/.test(APP));
check('(e) the frame goes on the door under the device key', /pushProgressFrame\(DaimondPeer\.agentsKey\(me\)/.test(APP));
check('(e) each peer is followed as a standing watch', /watchProgress\(key, [\s\S]{0,80}\{ quiet: true \}\)/.test(APP));
const lock = (APP.match(/\t\tlockStop: function \(\) \{[\s\S]*?\n\t\t\},\n/) || [''])[0];
check('(e) a lock forgets the peers\' runs', /this\.onLocked\(\)/.test(lock) && /Workers\.onLocked\s*= function \(\) \{ self\.forget\(\); \}/.test(APP));
const tick = (SYNC.match(/function progressTick\(\) \{[\s\S]*?\n\t\}\n/) || [''])[0];
check('(e) a standing watch is not read on every 4 s tick', /quiet/.test(tick) && /PROGRESS_QUIET_TICKS/.test(tick));

console.log(failures ? '\nFAIL agentsacross: ' + failures + ' of ' + checks : '\nPASS agentsacross: ' + checks + ' checks');
process.exit(failures ? 1 : 0);
