/* ============================================================
   Test — a chat that FOLLOWS the default is offered Kimberlite when
   the default runs on credits (QA-B #3, 2026-10-23).
   ------------------------------------------------------------
   A native runner serves credits only (peer.js recEngineOk). A new
   chat stores provider '' (U1c), and the election read that stored
   '' rather than the pair the turn runs on, so a default-following
   chat was never offered the runner. The election now reads
   `electProvider`, the provider the errand carries (`errandModelOf`).

     I1  the switch offers the runner to a following chat, default credits;
     I2  the send's election hands that chat's turn to it;
     I3  the elected provider is the errand's;
     I4  a following chat whose default is an own key is not offered it;
     I5  every send-side election in daimond.js passes the provider.

   Lifts the REAL functions out of daimond.js with the REAL peer.js
   election. Red proof: run against e6594b179.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readPage(join(HERE, 'daimond.js'), 'utf8');
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
function lift(name) {
	const a = SRC.indexOf('\n\tfunction ' + name + '(');
	if (a < 0) { console.log('  (this revision lacks: ' + name + ')'); return ''; }
	return SRC.slice(a, SRC.indexOf('\n\t}\n', a) + 3);
}

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
const ENGINE = 'ab'.repeat(32), now = Date.now();
P.setEngineId(ENGINE);
win.DaimondPresence.ingest({ rn: { name: 'argonaut', last_seen: now, runner: true, kind: 'runner',
	serviced: true, serviced_at: now, mobile: false, busy: 0, engine: ENGINE } }, now);

const NAMES = ['seatOpts', 'electProvider', 'electSources', 'errandModelOf', 'turnModelsOfChat', 'turnModelOf', 'seatSwitchFor'];
function world(def) {
	const env = {
		window: null, String: String, Object: Object, Date: Date,
		current: null,
		selfDeviceId: () => 'me', isPhoneViewport: () => true, isMobileDeviceSelf: () => false,
		preferredWorkerLabel: () => '', fleetCurrentBuild: () => '', nominatedDeviceId: () => 'rn',
		handoffWhenAway: () => false, chatSeatHere: () => false, chatRunningOn: () => '',
		chatNeedsFolder: () => false,	// HT's F4c: no folder rooted here
		turnPresence: (p) => p, presenceWithLeaseBusy: (p) => p,
		chatWorkerModel: () => ({ provider: '', model: '', chosen: false }),
		DaimondPeer: P, DaimondPresence: win.DaimondPresence,
		// The resolver: a chat's own pick, or the default for ''.
		DaimondModels: { effective: (o) => (o.chat.model ? o.chat : def) },
	};
	env.window = env;
	const have = NAMES.map((n) => [n, lift(n)]).filter((x) => x[1]);
	const body = have.map((x) => x[1]).join('\n') + '\nreturn {' + have.map((x) => x[0] + ': ' + x[0]).join(', ') + '};';
	const scope = new Proxy(env, {
		has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
		get: (t, k) => t[k],
		set: (t, k, v) => { t[k] = v; return true; },
	});
	return new Function('scope', 'with (scope) {\n' + body + '\n}')(scope);
}

const follows = { id: 'c2', model: '', provider: '', messages: [] };
{
	const F = world({ provider: 'credits', model: 'm' });
	const sw = F.seatSwitchFor(follows);
	check('I1 the switch offers the runner to a following chat (default credits)',
		!!(sw && sw.runner && sw.runner.deviceId === 'rn' && sw.choice === 'runner'), JSON.stringify(sw));
	const d = P.autoDispatchDecision(follows, win.DaimondPresence.snapshot(), F.seatOpts(follows), now);
	check('I2 the send hands its turn to the runner', !!(d.dispatch && d.peer && d.peer.deviceId === 'rn'),
		JSON.stringify(d));
	check('I3 the elected provider is the errand\'s',
		F.electProvider && F.electProvider(follows) === F.errandModelOf(follows).provider
		&& F.errandModelOf(follows).provider === 'credits', F.electProvider && F.electProvider(follows));
}
{
	const F = world({ provider: 'anthropic', model: 'm' });
	const sw = F.seatSwitchFor(follows);
	check('I4 a following chat whose default is an own key is not offered it',
		!!sw && sw.runner === null, JSON.stringify(sw));
}
{
	const calls = SRC.split('DaimondPeer.autoDispatchDecision(chat, presence, {').slice(1)
		.map((s) => s.slice(0, s.indexOf('}, ')));
	check('I5 every send-side election passes the provider (' + calls.length + ')',
		calls.length >= 2 && calls.every((c) => /\n\s*provider:\s*electProvider\(chat\)/.test(c)));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
