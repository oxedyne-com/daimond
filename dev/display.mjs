// display.mjs — where a headed browser is allowed to paint, and what has to be
// taken out of its environment first.
//
// Small, and with no imports at all, on purpose. Thirty-four files in `dev/`
// launch a browser and four of them import `harness.mjs`, so the rule cannot
// live only there; twelve of the thirty-four launch HEADED, and each of those
// needs this. A module with no dependencies can be imported by any of them for
// nothing, and importing it is enough -- the strip at the bottom edits this
// process's own environment, so a launcher that spreads `process.env` into its
// options is covered without another line.
//
//	import './display.mjs';		// the strip, and nothing else wanted
//	import { displayFault, cleanDisplayEnv } from './display.mjs';
//
// `dev/harness.mjs` re-exports both, so the older spelling still works and
// `dev/verify_harness.mjs` keeps putting the cases to them.

// ┌───────────────────────────────────────────────────────────────┐
// │ Where a headed browser paints, and why xvfb alone does not say │
// └───────────────────────────────────────────────────────────────┘
//
// `xvfb-run` sets `DISPLAY` and nothing else, and on argonaut that is not enough.
// The seat is a Wayland session, so `WAYLAND_DISPLAY=wayland-0` is in the
// environment of every rc session -- and Chromium's ozone platform is chosen by
// AUTODETECTION, which prefers Wayland whenever that variable is set. It never
// looks at `DISPLAY` at all. So a verifier started under `xvfb-run`, by an agent
// that had done everything it was told, connected to the compositor instead and
// OPENED A REAL WINDOW ON THE OWNER'S DESKTOP while he was working. Measured on
// 2026-08-24: `verify_ptyedge.mjs`, `--ozone-platform=wayland` in its own command
// line, killed two and a half minutes in.
//
// `displayFault` could not see it, because it was given the `DISPLAY` string and
// a string cannot say what else is in the environment. That is the whole of the
// fault: the check was right about the question it was asked and was asked the
// wrong question.
//
// The two variables are STRIPPED rather than refused, which is the opposite of
// what is done to a forwarded `DISPLAY`, and the difference is whether the run
// can be saved. A forwarded display cannot be: there is no local screen to fall
// back to, so the only honest answer is to stop. A Wayland variable can be, and
// the fallback is exactly what was wanted -- with it gone, Chromium takes the X
// path and lands on xvfb's `:99`. Refusing instead would make every headed
// verifier on this machine unrunnable until each caller learned an incantation,
// which is the failure this file exists to prevent.
//
// Watching a run on argonaut's own seat still works. That is `DISPLAY=:0`, which
// has no host part, and Xwayland answers it; where a browser paints is still
// decided by the display check below and not by this.

/// The variables that send Chromium to a compositor instead of to `DISPLAY`.
///
/// `XDG_RUNTIME_DIR` is deliberately NOT here. Chromium needs it for things that
/// have nothing to do with the display, and removing it breaks a headless run.
export const WAYLAND_VARS = ['WAYLAND_DISPLAY', 'XDG_SESSION_TYPE'];

// No session bus for a browser. Chromium's main process otherwise asks systemd over
// it for a scope of its own and leaves the one it was launched in (rc-build's, the
// nightly's) for app.slice, escaping its MemoryMax: 4,289 escapes in three days to
// 2026-10-10. `disabled:` is the bus address that refuses every connection.
export const NO_BUS = { DBUS_SESSION_BUS_ADDRESS: 'disabled:' };

/// A copy of `env` that a browser may be launched with.
///
/// Every headed launch in `dev/` should pass its environment through this. There
/// were thirty-four files launching a browser on 2026-08-24 and four of them
/// imported this module, so there is no import that reaches them all and no
/// amount of care in one file can cover the rest -- see `dev/HATES.md`.
///
/// # Arguments
/// * `env` - The environment to clean, defaulting to this process's own.
export function cleanDisplayEnv(env = process.env) {
	const out = { ...env };
	for (const v of WAYLAND_VARS) delete out[v];
	return Object.assign(out, NO_BUS);
}

/// The environment as this process INHERITED it, before the line below edits it.
///
/// Kept because the strip and the refusal want different answers to the same
/// question: the browser must be launched with the variables gone, and
/// `displayFault` must still be able to say that they were there. Reading
/// `process.env` after the strip would make the refusal's sentence quietly
/// forget the reason it was written.
export const INHERITED_ENV = { ...process.env };

// And this process's own, at import time, so that a file which imports this
// module for `scratch()` and then launches a browser of its own is covered
// without having to know any of the above. A side effect on import is worth it
// here: what it protects is somebody else's screen.
for (const v of WAYLAND_VARS) delete process.env[v];
Object.assign(process.env, NO_BUS);

// ┌───────────────────────────────────────────────────────────────┐
// │ A display nobody is looking at, and the seat that is           │
// └───────────────────────────────────────────────────────────────┘
//
// `:0` is allowed by the check below, and the comment beside it gives the reason:
// watching a headed run on argonaut's own seat is a thing people do.  That
// permission is also the whole of the hole `dev/BLOCKERS.md` B13 walks a daimon
// through.
//
// A daimon reaches a headed instrument through `verify`, which runs a TRACKED
// script outside the command fence -- and until this was written that script
// inherited the hand's environment, whatever it happened to be.  The hand is a
// native messaging host, so the browser starts it, so that environment carries the
// browser's `DISPLAY=:0`.  The very door built to let a daimon check its own work
// would have painted a browser on the owner's screen, with the guard returning
// `null` and being right about the question it was asked.  Which is the SAME SHAPE
// as the fault of 2026-08-24 recorded above: there, a check was given the display
// string and could not see the environment; here, a check was given the
// environment and could not see who had asked.
//
// So a launcher may say that nobody is at the keyboard.  An unattended run takes
// the display it STARTED and no other: the launcher names it, and a display it did
// not name -- an inherited one, `:0` however it is spelled -- is refused.  The
// declaration is an ENVIRONMENT NAME rather than an argument because there is no
// import that reaches all thirty-four launchers in this directory, which is the
// argument this whole file is built on.  `hand/src/verify.rs` sets it for every
// verifier it spawns, so a daimon cannot arrive without it.
//
// An attended run is untouched.  Nothing sets these names, `unattendedFault`
// answers `null` on its first line, and a person watching a run on their own seat
// still can.

/// The name a launcher sets to say that nobody is at the keyboard for this run.
export const UNATTENDED_VAR = 'DAIMOND_UNATTENDED';

/// The name carrying the display the launcher started for itself.
export const OWNED_VAR = 'DAIMOND_OWNED_DISPLAY';

/// The display this machine's own seat answers on.
///
/// Refused outright to an unattended run rather than only compared against
/// [`OWNED_VAR`], so that a launcher which names its own display WRONGLY is still
/// stopped.  An Xvfb never takes this number: `xvfb-run -a` starts at `:99` and
/// counts up, and X will not bind a display another server already holds.
export const SEAT_DISPLAY = ':0';

/// Why a run nobody asked for must not have this display, or `null` where it may.
///
/// Answers `null` -- rather than a sentence of its own -- wherever `displayFault`
/// below has the better one to say, which is every case about the screen being on
/// another MACHINE.  A run that is both forwarded and unattended is refused either
/// way, and the reader is better served by the sentence naming the host.
///
/// # Arguments
/// * `e` - The environment a headed launch would inherit.
export function unattendedFault(e) {
	if (!(e[UNATTENDED_VAR] || '').trim()) {
		return null;
	}
	const d = (e.DISPLAY || '').trim();
	// Everything before the colon, as below: a host part means another machine, and
	// the refusal for that is the one that names it.
	if (d && d.slice(0, d.indexOf(':') < 0 ? d.length : d.indexOf(':'))) {
		return null;
	}
	const owned = (e[OWNED_VAR] || '').trim();
	if (!d) {
		// `xvfb-run` wraps a COMMAND LINE, and the hand's `verify` builds the command
		// line itself -- `node <script>`, and at most a `--break`. So a verifier
		// reached that way cannot be wrapped in anything, and sending its reader to
		// `xvfb-run` sends them nowhere.
		return 'A headed run needs a display, DISPLAY is unset, and this run is marked '
			+ `unattended (${UNATTENDED_VAR}) -- so it will not be given one either: the `
			+ 'display it would inherit is whoever launched it, which on this machine is '
			+ 'the owner\'s own seat. Start an Xvfb of your own, put its display in '
			+ `${OWNED_VAR} and in DISPLAY, and hand both to the browser. `
			+ '`dev/verify_reflux.mjs` does exactly that and is the shortest example.';
	}
	if (!owned) {
		return `This run is marked unattended (${UNATTENDED_VAR}), and an unattended run may `
			+ 'only paint on a display it started for itself. It named none, so there is '
			+ `nothing to check "${d}" against. Start an Xvfb, put its display in `
			+ `${OWNED_VAR}, and hand both to the child.`;
	}
	if (d === SEAT_DISPLAY || owned === SEAT_DISPLAY) {
		return `This run is marked unattended (${UNATTENDED_VAR}) and the display is "${d}" `
			+ `with "${owned}" claimed as its own. ${SEAT_DISPLAY} is THIS MACHINE'S OWN `
			+ 'SEAT -- the owner\'s screen, with the owner in front of it -- and no run '
			+ 'nobody asked for may take it, however it came to be in the environment. '
			+ 'Start an Xvfb of your own and hand on its display instead.';
	}
	if (d !== owned) {
		return `This run is marked unattended (${UNATTENDED_VAR}), the display it started `
			+ `for itself is "${owned}", and DISPLAY is "${d}" -- a display it did not `
			+ 'start and cannot say who is looking at. Refused. An inherited DISPLAY is '
			+ 'the ordinary way this happens: strip it and set your own.';
	}
	return null;
}

/// Why this environment must not be handed to a headed browser, or `null` where it may be.
///
/// Separate and pure so `dev/verify_harness.mjs` can put the cases to it without launching
/// anything -- a check that had to start a browser to test where a browser would appear is a
/// check nobody runs.
///
/// # Arguments
/// * `env` - The environment a headed launch would inherit. A bare string is read as the
///   `DISPLAY`, which is how this was called before it could see anything else.
export function displayFault(env) {
	const e = (typeof env === 'string' || env == null) ? { DISPLAY: env } : env;
	// UNATTENDED FIRST, and it hands back to the checks below wherever they have the
	// better sentence to say. Everything under this is about WHOSE MACHINE the screen
	// is on; this is about whether anybody is in front of it.
	const nobody = unattendedFault(e);
	if (nobody) return nobody;
	// Read BEFORE the display, because a machine offering only Wayland has no
	// local X screen to fall back to and "DISPLAY is unset" is then the true
	// sentence rather than the confusing one.
	const wayland = WAYLAND_VARS.filter((v) => (e[v] || '').trim());
	const d = (e.DISPLAY || '').trim();
	if (!d) {
		return 'A headed run needs a display and DISPLAY is unset. Start it under '
			+ '`xvfb-run -a -s "-screen 0 1500x950x24"`, which is what every headed verifier '
			+ 'in this tree expects.'
			+ (wayland.length
				? ` ${wayland.join(' and ')} ${wayland.length > 1 ? 'are' : 'is'} set, and `
					+ 'Chromium would have taken the compositor instead -- which is the '
					+ 'owner\'s own screen. That is not a display this may use.'
				: '');
	}
	// Everything before the colon. X puts the host there, and only there.
	const host = d.slice(0, d.indexOf(':') < 0 ? d.length : d.indexOf(':'));
	if (host) {
		return `DISPLAY is "${d}", which names the host "${host}" -- a display on another `
			+ 'machine, forwarded over SSH. A headed browser started with it PAINTS ITSELF '
			+ 'THERE, on somebody else\'s screen, across the network. Refused. Start this under '
			+ '`xvfb-run -a -s "-screen 0 1500x950x24"` so it renders on a virtual display here.';
	}
	return null;
}
