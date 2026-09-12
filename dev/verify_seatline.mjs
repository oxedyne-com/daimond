/* ============================================================
   verify_seatline.mjs — WHERE THE NEXT TURN WILL RUN, stated
   before the send (owner spec, 2026-09-12).
   ------------------------------------------------------------
   The election was invisible. A turn left for another machine, or
   stayed on the phone, and the only way to find out which was to
   send it and watch. That is not cosmetic on a phone: a turn that
   runs locally needs the app in the foreground and the screen
   awake, so the user has to be told while they can still plan for
   it.

   `DaimondPeer.seatPlan` is the lifted formatter -- pure over
   presence, taking the SAME `autoDispatchDecision` the send takes,
   so the line cannot promise one seat and the send take another --
   and it answers the i18n key, the device label, and whether
   running here is something the user must act on. This drives the
   real www/js/peer.js in pure node and asserts:

     (a) a live nominated runner   -> seat.on_runner, named;
     (b) the runner silent, another live desktop present ->
         seat.on_desktop_runner_off, named: the fallback is VISIBLE
         rather than a silent substitution;
     (c) no runner set, a live desktop -> seat.on_desktop;
     (d) a MOBILE device with nothing live -> seat.local_mobile,
         warn, and the reason it can give;
     (e) a DESKTOP with nothing live -> seat.local, no warning:
         running here is the ordinary case on a machine that stays
         awake;
     (f) a phone that beats mobile:true is not a seat, so the line
         on another phone still says "runs here" -- the seating
         rule and the line cannot disagree;
     (g) every key the plan can name exists in www/i18n/en.js, and
         each carries the {name} the line substitutes.

   Run:  node dev/verify_seatline.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

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
	const plan = (presence, opts) => P.seatPlan({ id: 'c', provider: 'openrouter', model: 'm' },
		presence, Object.assign({ selfId: PHONE, isPhone: true, selfMobile: true,
			freshWindowMs: W }, opts || {}), now);

	// ── (a) THE RUNNER IS LIVE: it is named, and named as the runner. ──
	{
		const p = plan({ [ARG]: desk('argonaut', 2000) }, { nominatedId: ARG });
		check('(a) a live nominated runner is the seat, named',
			p.where === 'runner' && p.key === 'seat.on_runner' && p.label === 'argonaut' && p.warn === false,
			'key=' + p.key + ' label=' + p.label);
	}

	// ── (b) THE RUNNER IS SILENT: the fallback is named AND the reason given. ──
	//
	// The substitution used to be silent: the turn simply went somewhere else. A user
	// who set a runner and sees another machine named has to be told which of the two
	// facts is true, or the line looks like the app ignoring the setting.
	{
		const p = plan({ [ARG]: desk('argonaut', W + 60000), [GIL]: desk('gilgamesh', 1000) },
			{ nominatedId: ARG });
		check('(b) the runner silent, another desktop live -> that desktop, with the runner named offline',
			p.where === 'desktop' && p.key === 'seat.on_desktop_runner_off' && p.label === 'gilgamesh',
			'key=' + p.key + ' label=' + p.label);
	}

	// ── (c) NO RUNNER SET: a live desktop is simply the seat. ──
	{
		const p = plan({ [GIL]: desk('gilgamesh', 1000) });
		check('(c) no runner set, a live desktop -> that desktop, no runner-offline clause',
			p.where === 'desktop' && p.key === 'seat.on_desktop' && p.label === 'gilgamesh',
			'key=' + p.key);
	}

	// ── (d) THE LOUD CASE: a phone about to run the turn itself. ──
	{
		const p = plan({});
		check('(d) a MOBILE device with nothing live -> runs here, as a WARNING',
			p.where === 'local' && p.key === 'seat.local_mobile' && p.warn === true,
			'key=' + p.key + ' warn=' + p.warn);
		check('(d) and it can say WHY: no desktop is awake to take it',
			p.why === 'no-desktop', 'why=' + p.why);
		const silent = plan({ [ARG]: desk('argonaut', W + 60000) }, { nominatedId: ARG });
		check('(d) a runner that is SET but not beating is named as the reason instead',
			silent.where === 'local' && silent.warn === true && silent.why === 'runner-silent',
			'why=' + silent.why);
	}

	// ── (e) A DESKTOP RUNNING ITS OWN TURN IS THE ORDINARY CASE. ──
	{
		const p = P.seatPlan({ id: 'c', provider: 'openrouter', model: 'm' }, {},
			{ selfId: DESK, isPhone: false, selfMobile: false, freshWindowMs: W }, now);
		check('(e) a DESKTOP with nothing live -> runs here, and NOT as a warning',
			p.where === 'local' && p.key === 'seat.local' && p.warn === false,
			'key=' + p.key + ' warn=' + p.warn);
	}

	// ── (f) THE LINE AND THE SEATING RULE CANNOT DISAGREE. ──
	//
	// A phone is never seated as another device's worker, so a phone that is the only
	// live peer must leave the line saying "runs here" -- the line is drawn from the
	// same decision, so this is a property of one function, not two kept in step.
	{
		const p = plan({ [GIL]: phone('gilgamesh', 1000) });
		check('(f) another PHONE (mobile:true, desktop name) is not a seat, and the line says runs here',
			p.where === 'local' && p.key === 'seat.local_mobile', 'key=' + p.key);
	}

	// ── (h) THE LOUD CASE IS ACTUALLY LOUD. ──
	//
	// "Runs here" on a phone is a request, not a statement: the app must stay in the
	// foreground or the turn stalls. So the line is styled as a warning and says WHY,
	// and the in-flight tile says it again for a turn that found nobody -- which is the
	// moment it matters. Read off the files that ship, because the styling is the whole
	// point of this one and a plan that merely SAYS warn is not a visible warning.
	{
		const css  = readFileSync(join(HERE, '..', 'www', 'css', 'app.css'), 'utf8');
		const en   = loadEn();
		const js   = readFileSync(join(HERE, '..', 'www', 'js', 'daimond.js'), 'utf8');
		check('(h) the warning class is STYLED, on the line and inside the tile',
			/\.seat-line\.seat-warn\s*\{[^}]*var\(--warn\)/.test(css)
			&& /\.seat-note\.seat-warn\s*\{[^}]*var\(--warn\)/.test(css));
		check('(h) the renderer puts that class on exactly the plans that warn',
			/classList\.toggle\('seat-warn', !!txt\.warn\)/.test(js));
		check('(h) each reason the line can give is in en.js',
			['seat.why_no_desktop', 'seat.why_runner_silent', 'seat.why_chat_local',
				'seat.tile_local_mobile'].every((k) => !!en && !!en[k]));
		check('(h) the tile repeats the request and carries the reason',
			!!en && /keep this screen/i.test(String(en['seat.tile_local_mobile']))
				&& String(en['seat.tile_local_mobile']).indexOf('{why}') >= 0,
			String(en && en['seat.tile_local_mobile']));
	}

	// ── (g) EVERY KEY THE PLAN CAN NAME IS IN en.js, WITH ITS {name}. ──
	//
	// The line names its own key, so no call-site read can check it; i18ncheck takes
	// the declared set on trust. This closes that: the set the code can produce is
	// enumerated here and each member looked up in the file that ships.
	{
		const en = loadEn();
		const named = ['seat.on_runner', 'seat.on_desktop', 'seat.on_desktop_runner_off'];
		const bare  = ['seat.local', 'seat.local_mobile'];
		const missing = [...named, ...bare, 'seat.retry'].filter((k) => !en || !en[k]);
		check('(g) every key the plan can name exists in en.js', missing.length === 0,
			missing.join(' '));
		check('(g) each device-naming key carries its {name} placeholder',
			named.every((k) => en && String(en[k]).indexOf('{name}') >= 0));
		check('(g) the re-seat line names BOTH machines',
			!!en && String(en['seat.retry']).indexOf('{from}') >= 0
				&& String(en['seat.retry']).indexOf('{to}') >= 0,
			String(en && en['seat.retry']));
		check('(g) the phone’s local line asks for the screen, the desktop’s does not',
			!!en && /keep this screen/i.test(String(en['seat.local_mobile']))
				&& !/keep this screen/i.test(String(en['seat.local'])),
			String(en && en['seat.local_mobile']));
	}
} catch (e) {
	bad.push('crashed: ' + (e && e.message || e));
	console.log('  FAIL crashed — ' + (e && e.stack || e));
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' fail');
process.exitCode = bad.length ? 1 : 0;
