// gateway: none
/* ============================================================
   verify_seatline.mjs — WHERE THE NEXT TURN WILL RUN, chosen
   before the send (owner spec 2026-09-12; re-aimed 2026-10-11 to
   the "Here | <runner>" switch by the input box, D-20261009-23).
   ------------------------------------------------------------
   The election was invisible: a turn left for another machine, or
   stayed on the phone, and the only way to find out which was to
   send it and watch. The line under the composer that said so is
   gone; the person now CHOOSES on a switch styled like Crystal |
   Chat, and the send obeys it -- the named runner, or here,
   nothing else.

   `DaimondPeer.seatPlan` and `seatSwitch` are pure over presence
   and take the SAME `autoDispatchDecision` the send takes, with
   the app's `runnerOnly`, so the switch cannot offer one seat and
   the send take another. This drives the real www/js/peer.js in
   pure node and asserts:

     (a) a live nominated runner -> the runner, named; the switch
         reads "Here | argonaut" with the runner chosen;
     (b) the runner silent, another live desktop present -> HERE,
         reason runner-silent; the switch is plain "Here" (was: the
         other desktop, named as a fallback -- now no substitution);
     (c) no runner set, a live desktop -> here, plain "Here" (was:
         that desktop);
     (d) a MOBILE device with nothing live -> here, warn, and why;
     (i) an armed runner posture is the runner with no nominee
         record stored here, and the switch names it;
     (e) a DESKTOP with nothing live -> here, no warning;
     (f) a phone that beats mobile:true is never a seat;
     (k) a chat pinned Here still offers the runner to go back to;
     (h) the switch is the SAME control as Crystal | Chat, and the
         tile's warning is styled, one clause, reason on its title;
     (j) a daimon chat seats like any other;
     (g) every key the switch and tile name is in en.js with its
         placeholders, and the removed seat-line and take-back keys
         are gone.

   Run:  node dev/verify_seatline.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { guardRan } from './verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// The REAL peer.js as the classic IIFE it is, its bare sibling references
// resolved against a fresh `window` (the construct peer.test.mjs uses).
// `seatPlan` is pure, so no other app script is needed.
function loadPeer() {
	const win = {};
	win.addEventListener = () => {};
	win.dispatchEvent    = () => {};
	const body = readFileSync(join(HERE, '..', 'www', 'js', 'peer.js'), 'utf8');
	const fn = new Function(
		'window', 'crypto', 'console', 'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'with (window) {\n' + body + '\n}');
	fn(win, webcrypto, console, TextEncoder, TextDecoder,
		setTimeout, clearTimeout, setInterval, clearInterval);
	return win.DaimondPeer;
}

// en.js registers itself through a global the app provides; stand one in and
// read the table back, so the keys are checked against the file that ships.
function loadEn() {
	const win = { DaimondI18n: null };
	let table = null;
	win.DaimondI18n = { register: (_lang, t) => { table = t; } };
	const body = readFileSync(join(HERE, '..', 'www', 'i18n', 'en.js'), 'utf8');
	const fn = new Function('window', 'console', 'with (window) {\n' + body + '\n}');
	fn(win, console);
	return table;
}

try {
	const P = loadPeer();
	if (!P || !P.seatPlan) throw new Error('peer.js did not expose seatPlan');
	const W   = P.DISPATCH_FRESH_MS;
	const now = Date.now();
	const PHONE = 'p0000000000000000000000000000000';	// this device, in the mobile cases
	const DESK  = 'd0000000000000000000000000000000';	// this device, in the desktop cases
	const ARG   = 'a0000000000000000000000000000000';	// argonaut, the nominated runner
	const GIL   = 'g0000000000000000000000000000000';	// gilgamesh, another desktop

	// A live, servicing desktop that says so itself, and a live phone that does.
	const desk  = (name, ageMs) => ({ name, lastSeen: now - (ageMs || 0),
		servicedAt: now - (ageMs || 0), attended: false, mobile: false });
	const phone = (name, ageMs) => ({ name, lastSeen: now - (ageMs || 0),
		servicedAt: now - (ageMs || 0), attended: true, mobile: true });
	// A machine ARMED AS THE RUNNER (runner.js posture on its beat) whose errand-channel
	// stamp is stale -- the live shape of the 2026-09-13 fault.
	const armed = (name, ageMs) => ({ name, lastSeen: now - (ageMs || 0),
		servicedAt: 0, attended: false, mobile: false, runner: true });
	// The app's own options (`seatOpts`): only the switch's runner may take a turn.
	const opt = (opts) => Object.assign({ selfId: PHONE, isPhone: true, selfMobile: true,
		freshWindowMs: W, runnerOnly: true }, opts || {});
	const CHAT = { id: 'c', provider: 'openrouter', model: 'm' };
	const plan = (presence, opts) => P.seatPlan(CHAT, presence, opt(opts), now);
	const sw   = (presence, opts) => P.seatSwitch(CHAT, presence, opt(opts), now);
	const swStr = (x) => JSON.stringify(x);

	// ── (a) THE RUNNER IS LIVE: it is named, and the switch offers it, chosen. ──
	{
		const pres = { [ARG]: desk('argonaut', 2000) };
		const p = plan(pres, { nominatedId: ARG });
		check('(a) a live nominated runner is the seat, named',
			p.where === 'runner' && p.label === 'argonaut' && p.warn === false,
			'where=' + p.where + ' label=' + p.label);
		const x = sw(pres, { nominatedId: ARG });
		check('(a) the switch reads "Here | argonaut" with the runner chosen',
			!!x.runner && x.runner.deviceId === ARG && x.runner.label === 'argonaut' && x.choice === 'runner', swStr(x));
	}

	// ── (b) THE RUNNER IS SILENT: no substitution; plain Here, and why. ──
	{
		const pres = { [ARG]: desk('argonaut', W + 60000), [GIL]: desk('gilgamesh', 1000) };
		const p = plan(pres, { nominatedId: ARG });
		check('(b) the runner silent, another desktop live -> HERE, not that desktop, reason runner-silent',
			p.where === 'local' && p.why === 'runner-silent' && p.dispatch !== true,
			'where=' + p.where + ' why=' + p.why + ' label=' + p.label);
		const x = sw(pres, { nominatedId: ARG });
		check('(b) and the switch is plain "Here"', x.runner === null && x.choice === 'here', swStr(x));
	}

	// ── (c) NO RUNNER SET: a live desktop is not a seat the switch offers. ──
	{
		const pres = { [GIL]: desk('gilgamesh', 1000) };
		const p = plan(pres);
		check('(c) no runner set, a live desktop -> here', p.where === 'local' && p.why === 'no-desktop',
			'where=' + p.where + ' why=' + p.why);
		const x = sw(pres);
		check('(c) and the switch is plain "Here"', x.runner === null && x.choice === 'here', swStr(x));
	}

	// ── (d) THE LOUD CASE: a phone about to run the turn itself. ──
	{
		const p = plan({});
		check('(d) a MOBILE device with nothing live -> runs here, as a WARNING',
			p.where === 'local' && p.warn === true, 'where=' + p.where + ' warn=' + p.warn);
		check('(d) and it can say WHY: no desktop is awake to take it',
			p.why === 'no-desktop', 'why=' + p.why);
		const silent = plan({ [ARG]: desk('argonaut', W + 60000) }, { nominatedId: ARG });
		check('(d) a runner that is SET but not beating is named as the reason instead',
			silent.where === 'local' && silent.warn === true && silent.why === 'runner-silent',
			'why=' + silent.why);
	}

	// ── (i) THE RUNNER POSTURE IS A SEAT ON ITS OWN (owner, 2026-09-13). ──
	//
	// THE LIVE FAULT. The phone said "Runs here -- keep this screen open" with the reason
	// `no-desktop` while argonaut was beside it: beating, starred, and ARMED. The star lives
	// in the NOMINATING device's localStorage and reaches a phone only on a full parcel
	// round, and argonaut's `serviced_at` was stale. `runner:true` -- the machine's own
	// claim that it is arranged to take a turn -- rode every beat and was read by nothing.
	{
		const pres = { [ARG]: armed('argonaut', 10000) };		// NO nominatedId: the phone knows nothing
		const p = plan(pres);
		check('(i) an ARMED runner is the seat with NO nominee record stored here',
			p.where === 'runner' && p.label === 'argonaut', 'where=' + p.where + ' reason=' + p.reason + ' label=' + p.label);
		check('(i) and it is seated as the RUNNER, not as a generic desktop',
			p.reason === 'runner-posture', 'reason=' + p.reason);
		const x = sw(pres);
		check('(i) the switch names the armed runner', !!x.runner && x.runner.deviceId === ARG, swStr(x));
		const cold = plan({ [ARG]: armed('argonaut', W + 60000) });
		check('(i) an armed runner that has stopped BEATING is still not a seat',
			cold.where === 'local', 'where=' + cold.where);
		const armedPhone = plan({ [GIL]: Object.assign(armed('gilgamesh', 1000), { mobile: true }) });
		check('(i) an armed MOBILE device is still never seated as a worker',
			armedPhone.where === 'local', 'where=' + armedPhone.where);
		const both = plan({ [ARG]: armed('argonaut', 20000), [GIL]: desk('gilgamesh', 1000) },
			{ nominatedId: GIL });
		check('(i) an explicit star still wins over another machine\u2019s posture',
			both.label === 'gilgamesh' && both.reason === 'nominee',
			'label=' + both.label + ' reason=' + both.reason);
	}

	// ── (e) A DESKTOP RUNNING ITS OWN TURN IS THE ORDINARY CASE. ──
	{
		const p = plan({}, { selfId: DESK, isPhone: false, selfMobile: false });
		check('(e) a DESKTOP with nothing live -> runs here, and NOT as a warning',
			p.where === 'local' && p.warn === false, 'where=' + p.where + ' warn=' + p.warn);
	}

	// ── (f) A PHONE IS NEVER A SEAT. ──
	{
		const p = plan({ [GIL]: phone('gilgamesh', 1000) });
		check('(f) another PHONE (mobile:true, desktop name) is not a seat: here',
			p.where === 'local' && sw({ [GIL]: phone('gilgamesh', 1000) }).runner === null, 'where=' + p.where);
	}

	// ── (k) HERE IS THE CHAT'S CHOICE, AND THE RUNNER STAYS ON OFFER. ──
	{
		const x = sw({ [ARG]: desk('argonaut', 2000) }, { nominatedId: ARG, toggle: false });
		check('(k) a chat pinned Here sends here, and still offers argonaut to go back to',
			x.choice === 'here' && !!x.runner && x.runner.deviceId === ARG, swStr(x));
		const p = plan({ [ARG]: desk('argonaut', 2000) }, { nominatedId: ARG, toggle: false });
		check('(k) and the send agrees: the plan for a Here chat is local', p.where === 'local', 'where=' + p.where);
	}

	// ── (h) THE SWITCH IS CRYSTAL | CHAT'S CONTROL; THE TILE'S WARNING IS LOUD. ──
	{
		const css  = readFileSync(join(HERE, '..', 'www', 'css', 'app.css'), 'utf8');
		const html = readFileSync(join(HERE, '..', 'www', 'index.html'), 'utf8');
		const en   = loadEn();
		const js   = readFileSync(join(HERE, '..', 'www', 'js', 'daimond.js'), 'utf8');
		check('(h) the switch is a `dview` group of `dview-btn` segments, as Crystal | Chat is',
			/class="dview seat-switch" id="seat-switch"/.test(html)
				&& /class="dview-btn" id="seat-here"/.test(html)
				&& /class="dview-btn" id="seat-runner"/.test(html)
				&& /class="dview" id="diamond-view"/.test(html));
		check('(h) the old seat line is gone from markup, CSS and the renderer',
			!/id="seat-line"/.test(html) && !/\.seat-line\b/.test(css) && !/getElementById\('seat-line'\)/.test(js));
		check('(h) the tile\u2019s warning class is STYLED',
			/\.seat-note\.seat-warn\s*\{[^}]*var\(--warn\)/.test(css));
		check('(h) each reason the tile can give is in en.js',
			['seat.why_no_desktop', 'seat.why_runner_silent', 'seat.tile_local_mobile'].every((k) => !!en && !!en[k]));
		check('(h) the tile repeats the request in one clause',
			!!en && /keep this open/i.test(String(en['seat.tile_local_mobile']))
				&& String(en['seat.tile_local_mobile']).indexOf('{why}') < 0,
			String(en && en['seat.tile_local_mobile']));
		check('(h) no seat string interpolates the reason inline',
			Object.keys(en || {}).filter((k) => k.indexOf('seat.') === 0
				&& String(en[k]).indexOf('{why}') >= 0).length === 0);
		check('(h) the renderer hands the reason to `title`, not to the text',
			/if \(note\.why\) nd\.title = note\.why/.test(js) && !/seat-why/.test(js));
	}

	// ── (j) A DAIMON CHAT SEATS LIKE ANY OTHER CHAT (daimon hand-off). ──
	{
		const daimon = { id: 'dc', provider: 'openrouter', model: 'm', diamondId: 'x1' };
		const p = P.seatPlan(daimon, { [ARG]: desk('argonaut', 2000) }, opt({ nominatedId: ARG }), now);
		check('(j) a DAIMON chat with a live nominee -> the runner, named',
			p.where === 'runner' && p.label === 'argonaut', 'where=' + p.where + ' label=' + p.label);
		const js = readFileSync(join(HERE, '..', 'www', 'js', 'daimond.js'), 'utf8');
		const sp = js.slice(js.indexOf('\tfunction seatPlanNow('),
			js.indexOf('\tfunction seatPlanNow(') + 700);
		check('(j) seatPlanNow no longer early-returns on a daimon (current.diamondId gate lifted)',
			!/current\.diamondId\)\s*return null/.test(sp), 'gate still present');
	}

	// ── (g) THE KEYS THE SWITCH AND TILE NAME ARE IN en.js; THE OLD ONES ARE GONE. ──
	{
		const en = loadEn();
		const need = ['seat.here', 'seat.switch', 'seat.ran_here'];
		const missing = need.filter((k) => !en || !en[k]);
		check('(g) every key the switch and tile name exists in en.js', missing.length === 0, missing.join(' '));
		check('(g) the ran-here note names the runner that was gone',
			!!en && String(en['seat.ran_here']).indexOf('{name}') >= 0, String(en && en['seat.ran_here']));
		const gone = ['seat.on_runner', 'seat.on_desktop', 'seat.on_desktop_runner_off', 'seat.local',
			'seat.local_mobile', 'turn.peer_takeback', 'turn.peer_takingback', 'seat.retry'].filter((k) => en && en[k]);
		check('(g) the seat-line, take-back and re-seat keys are gone', gone.length === 0, gone.join(' '));
		const p = plan({ [ARG]: desk('argonaut', 2000) }, { nominatedId: ARG });
		check('(g) the plan names no i18n key of its own any more', !('key' in p), Object.keys(p).join(','));
	}
} catch (e) {
	bad.push('crashed: ' + (e && e.message || e));
	console.log('  FAIL crashed — ' + (e && e.stack || e));
}

guardRan(ok.length + bad.length);
console.log('\n' + ok.length + ' ok, ' + bad.length + ' fail');
process.exitCode = bad.length ? 1 : 0;
