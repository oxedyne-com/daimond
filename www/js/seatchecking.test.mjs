// www/js/seatchecking.test.mjs -- UNBLOCK-70 (LENS-SWEEP-1NOV finding H): after a reload the
// page said "argonaut not listening" before it had heard from the presence door at all (31 Oct
// 16:14/16:17/16:20, while Kimberlite was listening). Until the first presence answer after a
// load, the seat says "checking", with no claim either way.
//
//   C1  a cold page, with only a map folded into a content pull (no door answer), names the
//       nominated runner `runner-checking`, never `runner-silent`, in the plan and the switch;
//   C2  a cold page with no row for the runner at all says the same;
//   C3  the first door answer moves the view (a redraw) and from then on a runner that is not
//       listening is `runner-silent`, as before; a forget makes the page cold again;
//   C5  after a gateway restart (`presenceUnknown`, the map blanked) the plan names the runner
//       `runner-checking`, not `runner-silent`, until a presence answer lands again;
//   C4  the page passes `presenceChecking` from `DaimondPresence.heard`, and the reason renders
//       as `runner_checking`, a key every locale holds, label and sentence.
//
//     node www/js/seatchecking.test.mjs

import { readPage } from '../../dev/pagesrc.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
let checks = 0, failures = 0;
function check(name, ok, detail) {
	checks++;
	if (!ok) failures++;
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  (' + detail + ')'));
}

function page() {
	const ls = new Map();
	let moved = 0;
	const win = { addEventListener() {}, dispatchEvent() { moved++; return true; } };
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null),
		setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
	for (const rel of ['stamp.js', 'peer.js']) {
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + readPage(join(HERE, rel), 'utf8') + '\n}')(win, doc, quiet, localStorage,
			{ storage: {} }, function () {});
	}
	win.moved = () => moved;
	win.DaimondPeer.setEngineId(ENGINE);
	win.DaimondPeer.setEngineAbi(1, 1);		// this page knows its own ABI, as a booted page does
	return win;
}

const ENGINE = 'ab'.repeat(32);
const now = Date.now();
const STALE = now - 10 * 60 * 1000;		// a runner row ten minutes old, as a pull fold may carry
const chat = { id: 'c1', model: 'm', provider: 'credits' };
function opts(W) {
	const P = W.DaimondPresence;
	return { selfId: 'me', runnerOnly: true, nominatedId: 'rn', sources: ['credits'],
		freshWindowMs: W.DaimondPeer.DISPATCH_FRESH_MS,
		presenceChecking: !!(P.heard && !P.heard()) };
}
const runnerRow = (seen) => ({ name: 'argonaut', last_seen: seen, runner: true, kind: 'runner',
	mobile: false, busy: 0, engine: ENGINE,
	abi: 1, abiMin: 1 });
const tabRow = { name: 'laptop', last_seen: now, mobile: false };

// C1: a cold page, a stale runner row folded into a content pull.
{
	const W = page();
	check('C1 the presence view says whether the door has answered', typeof W.DaimondPresence.heard === 'function');
	W.DaimondPresence.ingest({ rn: runnerRow(STALE), me: tabRow }, now);	// a pull fold: no answer
	const o = opts(W);
	check('C1 a pull fold is not the door: still checking', o.presenceChecking === true);
	const sp = W.DaimondPeer.seatPlan(chat, W.DaimondPresence.snapshot(), o, now);
	check('C1 the plan says checking, not silent', sp.why === 'runner-checking', JSON.stringify(sp));
	const sw = W.DaimondPeer.seatSwitch(chat, W.DaimondPresence.snapshot(), o, now);
	check('C1 the switch says checking, not silent', sw.why === 'runner-checking' && sw.runnerId === 'rn',
		JSON.stringify(sw));
}

// C2: a cold page with no row for the runner at all.
{
	const W = page();
	W.DaimondPresence.ingest({ me: tabRow }, now);
	const sw = W.DaimondPeer.seatSwitch(chat, W.DaimondPresence.snapshot(), opts(W), now);
	check('C2 no row yet: checking', sw.why === 'runner-checking' && sw.runnerId === 'rn', JSON.stringify(sw));
}

// C3: the first door answer.
{
	const W = page();
	W.DaimondPresence.ingest({ rn: runnerRow(STALE), me: tabRow }, now);
	const before = W.moved();
	const map = { rn: runnerRow(STALE), me: tabRow };
	W.DaimondPresence.ingest(map, now, { presence: map, now: now });
	check('C3 the first door answer redraws, even on the same map', W.moved() > before, W.moved() + ' vs ' + before);
	const o = opts(W);
	check('C3 the door has answered', o.presenceChecking === false);
	const sw = W.DaimondPeer.seatSwitch(chat, W.DaimondPresence.snapshot(), o, now);
	check('C3 a stale runner after the answer is silent', sw.why === 'runner-silent', JSON.stringify(sw));
	const live = { rn: Object.assign(runnerRow(now), { serviced: true, serviced_at: now }), me: tabRow };
	W.DaimondPresence.ingest(live, now, { presence: live, now: now });
	const sw2 = W.DaimondPeer.seatSwitch(chat, W.DaimondPresence.snapshot(), opts(W), now);
	check('C3 a listening runner is offered', !!sw2.runner && sw2.runner.deviceId === 'rn', JSON.stringify(sw2));
	W.DaimondPresence.forget();
	check('C3 a forget makes the page cold again', opts(W).presenceChecking === true);
}

// C5: a gateway restart after the door had answered: the map held is unknown, so the plan
// makes no claim about the runner until the next answer lands (UNBLOCK-70, the lead's ruling).
{
	const W = page();
	const map = { rn: runnerRow(STALE), me: tabRow };
	W.DaimondPresence.ingest(map, now, { presence: map, now: now });
	W.DaimondPresence.lost();
	const o = Object.assign(opts(W), { presenceUnknown: W.DaimondPresence.unknown() });
	check('C5 the door had answered, and the map is now unknown', o.presenceChecking === false && o.presenceUnknown === true);
	const sp = W.DaimondPeer.seatPlan(chat, W.DaimondPresence.snapshot(), o, now);
	check('C5 the plan after a restart says checking, not silent',
		sp.why === 'runner-checking' && sp.runnerId === 'rn' && sp.where === 'local', JSON.stringify(sp));
	W.DaimondPresence.ingest(map, now, { presence: map, now: now });
	const o2 = Object.assign(opts(W), { presenceUnknown: W.DaimondPresence.unknown() });
	const sp2 = W.DaimondPeer.seatPlan(chat, W.DaimondPresence.snapshot(), o2, now);
	check('C5 the next answer settles it: a stale runner is silent', o2.presenceUnknown === false
		&& sp2.why === 'runner-silent', JSON.stringify(sp2));
}

// C4: the page wiring and the copy.
{
	const src = readPage(join(HERE, 'daimond.js'), 'utf8');	// the page, its modules joined
	check('C4 seatOpts passes presenceChecking from DaimondPresence.heard',
		/presenceChecking:\s*!!\(window\.DaimondPresence && DaimondPresence\.heard && !DaimondPresence\.heard\(\)\)/.test(src));
	check('C4 runner-checking renders as runner_checking',
		/case 'runner-checking':\s*return \{ k: 'runner_checking'/.test(src));
	check('C4 the mobile hand-off tile names checking too', /plan\.why === 'runner-checking' \? 'runner_checking'/.test(src));
	const I18N = join(HERE, '..', 'i18n');
	for (const f of readdirSync(I18N).filter((x) => /\.js$/.test(x))) {
		let got = null;
		const ctx = vm.createContext({});
		ctx.window = ctx;
		ctx.DaimondI18n = { register: (_l, t) => { got = t; }, add: (_l, t) => { got = t; } };
		vm.runInContext(readPage(join(I18N, f), 'utf8'), ctx);
		if (!got) for (const k of Object.keys(ctx)) if (ctx[k] && typeof ctx[k] === 'object' && ctx[k]['seat.here']) got = ctx[k];
		const lab = got && got['seat.label_runner_checking'], why = got && got['seat.why_runner_checking'];
		check('C4 ' + f + ' holds the checking label and sentence, naming {name}',
			typeof lab === 'string' && typeof why === 'string' && lab.includes('{name}') && why.includes('{name}'),
			JSON.stringify([lab, why]));
	}
}

console.log(checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
