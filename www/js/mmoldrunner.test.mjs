/* ============================================================
   Test — a turn is never handed to a runner that cannot honour
   the model set (D-20261018-09 OR).
   ------------------------------------------------------------
   A runner before the Models menu (14ef947b) runs a following
   chat's errand on its own default and says nothing. It cannot be
   changed, so the asker refuses it: a runner shows it honours the
   set on its own roster line (`modelset`), and every hand-off reads
   that one rule (`honoursModelSet`, through `turnPresence` and the
   door, `dispatchToPeer`).

     O1  a runner without it is not offered the turn: the switch
         reads Here, and the door posts nothing, so the turn runs here
         on this device's set;
     O2  a runner with it is offered, and the door hands it the errand;
     O3  Retry (the parked re-run) and a say into a running turn obey
         the same rule; a refused re-run is "not run", with Retry;
     O4  a paired native runner has no roster line: its own signed
         presence row (`kind:'runner'`, `modelset:true`) says it, so it
         is offered and the door hands it the errand;
     O5  the same runner's row without `modelset` is refused at both.

   Lifts the REAL functions out of daimond.js and runs them with the
   REAL peer.js election. Red proof: git stash; node this file.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(join(HERE, 'daimond.js'), 'utf8');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
function lift(name) {
	let a = SRC.indexOf('\n\tfunction ' + name + '(');
	if (a < 0) a = SRC.indexOf('\n\tasync function ' + name + '(');
	if (a < 0) { console.log('  (this revision lacks: ' + name + ')'); return ''; }
	return SRC.slice(a, SRC.indexOf('\n\t}\n', a) + 3);
}

// ── peer.js, loaded as the page loads it ──
const win = { addEventListener() {}, dispatchEvent() { return true; } };
{
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
}
const P = win.DaimondPeer;

const NAMES = ['honoursModelSet', 'turnPresence', 'seatSwitchFor', 'handOffTurn', 'dispatchToPeer', 'answerUnhanded', 'reRunParked', 'sayToRunner'];
function world(rosterLine, presRec, provider) {
	const now = Date.now();
	const W = { built: [], ran: [], said: [],
		roster: rosterLine ? { argonaut1: Object.assign({ name: 'argonaut' }, rosterLine) } : {} };
	const presence = { argonaut1: Object.assign({ name: 'argonaut', lastSeen: now, servicedAt: now, runner: true,
		mobile: false, build: '' }, presRec || {}) };
	const env = {
		window: null, diag: () => {}, Date: Date, String: String, Object: Object, Array: Array, JSON: JSON, Math: Math,
		Promise: Promise, setTimeout: setTimeout,
		loadDevices: () => W.roster,
		selfDeviceId: () => 'phone1',
		annotatePresence: (p) => p,
		presenceWithLeaseBusy: (p) => p,
		chatRunningOn: () => '',
		seatOpts: () => Object.assign({ selfId: 'phone1', nominatedId: 'argonaut1', isPhone: true, runnerOnly: true,
			freshWindowMs: P.DISPATCH_FRESH_MS }, provider ? { provider: provider } : {}),
		turnHold: () => null,
		DaimondPeer: Object.assign({}, P, {
			buildDispatch: () => { W.built.push(1); throw new Error('posted'); },
			turnInWindow: () => true, MAX_PARKS: 2,
		}),
		DaimondPresence: { snapshot: () => presence },
		DaimondPost: { post: () => {} }, DaimondSync: { push: () => {} },
		DaimondLease: { holder: () => 'argonaut1', say: async (tid, w) => { W.said.push(w.text); return { ok: true }; } },
		peerReports: {}, placeholderParkCount: () => 0,
		continueTurn: (c, tid) => { W.ran.push(tid); },
		_peerStopping: {}, _progressView: {}, _saidThere: {},
		commitRatings: () => {}, ratingPre: () => '', newMid: () => 'm1', peerSyncShim: () => ({}),
		giveUpSent: () => {}, pushUserRecord: () => {}, appendInterjected: () => {}, syncSendMode: () => {},
		current: null, storedPre: () => '', storedEffort: () => null, turnEffortOf: () => null, errandModelOf: () => ({}), errandFence: async () => null, errandClean: () => false, errandLocked: () => undefined, errandLimits: () => undefined, errandSession: () => undefined, errandReach: async () => undefined, errandToday: () => '', errandScope: (c, h) => h,
		autonomousPosture: () => false, msgTombsOwed: () => [], selfDeviceIdOf: () => 'phone1',
		touchMsg: (m) => m, touchChat: () => {}, persistChats: () => {}, ownsChat: () => false, renderHistory: () => {},
	};
	env.window = env;
	const have = NAMES.map((n) => [n, lift(n)]).filter((x) => x[1]);
	const body = have.map((x) => x[1]).join('\n') + '\nreturn {' + have.map((x) => x[0] + ': ' + x[0]).join(', ') + '};';
	const scope = new Proxy(env, {
		has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
		get: (t, k) => t[k],
		set: (t, k, v) => { t[k] = v; return true; },
	});
	W.f = new Function('scope', 'with (scope) {\n' + body + '\n}')(scope);
	return W;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const chat = { id: 'c1', name: 'Chat', model: '', provider: '', messages: [] };

async function main() {
	for (const [label, line, able] of [['O1 a runner before the Models menu', {}, false],
		['O2 a runner that honours the model set', { modelset: true }, true]]) {
		console.log(label);
		const W = world(line);
		const sw = W.f.seatSwitchFor(chat);
		check(able ? 'the switch offers it the turn' : 'the switch does not offer it: Here',
			able ? !!(sw && sw.runner && sw.runner.deviceId === 'argonaut1') : !!sw && !sw.runner && sw.choice === 'here', JSON.stringify(sw));
		let r = null;
		try { r = await W.f.dispatchToPeer(chat, 't1', 'hi', [], { runTo: 'argonaut1' }); } catch (e) { r = { threw: String(e) }; }
		check(able ? 'the door hands it the errand' : 'the door posts nothing and says the turn runs here',
			able ? W.built.length === 1 : (W.built.length === 0 && !!r && r.unable === true), JSON.stringify(r));

		console.log('O3 (' + label.slice(0, 2) + ')' + ' Retry and say obey the same rule');
		W.built.length = 0;
		const parked = { id: 'c1', messages: [] };
		W.f.reRunParked(parked, 't2', 'again');
		await tick(); await tick();
		// SEND-UNHANDED (lead ruling): a turn the door cannot hand to the runner the switch
		// names is not run here in silence; it says "not run", with Retry.
		const notRun = parked.messages.filter((m) => !!m.notRun && m.iturn === 't2').length;
		check(able ? 'the parked re-run is handed to it' : 'the parked re-run is not handed to it, nor run here: not run, with Retry',
			able ? (W.built.length === 1 && W.ran.length === 0) : (W.built.length === 0 && W.ran.length === 0 && notRun === 1),
			'built=' + W.built.length + ' ran=' + JSON.stringify(W.ran) + ' notrun=' + notRun);
		const said = W.f.sayToRunner ? await W.f.sayToRunner(chat, { iturn: 't3' }, 'and this', 'and this') : null;
		check(able ? 'words said into its running turn reach it' : 'words are not said into its running turn: they go as the next turn',
			able ? (said === true && W.said.length === 1) : (said === false && W.said.length === 0), 'said=' + said + ' sent=' + W.said.length);
	}
	// A paired native runner: no roster line, only its signed presence row (E-PORT ELECT).
	const E = 'ab'.repeat(32);
	P.setEngineId(E);
	for (const [label, rec, able] of [
		['O4 a native runner whose signed presence row says modelset', { kind: 'runner', engine: E, modelset: true }, true],
		['O5 the same native runner, its row without modelset', { kind: 'runner', engine: E }, false]]) {
		console.log(label);
		const W = world(null, rec, 'credits');
		const sw = W.f.seatSwitchFor(Object.assign({}, chat, { provider: 'credits' }));
		check(able ? 'the switch offers it the turn' : 'the switch does not offer it: Here',
			able ? !!(sw && sw.runner && sw.runner.deviceId === 'argonaut1') : !!sw && !sw.runner && sw.choice === 'here', JSON.stringify(sw));
		let r = null;
		try { r = await W.f.dispatchToPeer(chat, 't1', 'hi', [], { runTo: 'argonaut1' }); } catch (e) { r = { threw: String(e) }; }
		check(able ? 'the door hands it the errand' : 'the door posts nothing and says the turn runs here',
			able ? (W.built.length === 1 && !(r && r.unable)) : (W.built.length === 0 && !!r && r.unable === true), JSON.stringify(r));
	}
	P.setEngineId('');
	// The REAL ingest keeps a runner's signed `modelset` and never a tab's.
	console.log('O6 presence ingest keeps modelset from a runner\'s row only');
	{
		const now = Date.now();
		win.DaimondPresence.ingest({
			rn:  { name: 'argonaut', last_seen: now, runner: true, kind: 'runner', engine: E, modelset: true },
			rn2: { name: 'argonaut2', last_seen: now, runner: true, kind: 'runner', engine: E },
			tab: { name: 'laptop', last_seen: now, modelset: true },
		}, now);
		const snap = win.DaimondPresence.snapshot() || {};
		check('a runner\'s signed modelset is kept', !!snap.rn && snap.rn.modelset === true, JSON.stringify(snap.rn));
		check('a runner that did not say it has none', !!snap.rn2 && snap.rn2.modelset === undefined, JSON.stringify(snap.rn2));
		check('a tab\'s row never carries it', !!snap.tab && snap.tab.modelset === undefined, JSON.stringify(snap.tab));
	}
	console.log((failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks + ' checks');
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('FAIL — threw: ' + (e && e.stack || e)); process.exit(1); });
