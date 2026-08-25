// verify_harness.mjs — the harness's own rules about where a browser is allowed
// to paint, put to it without launching one.
//
// `dev/harness.mjs` has named this file since `displayFault` was made "separate
// and pure so `dev/verify_harness.mjs` can put the cases to it". The file did not
// exist. Nothing in the tree tested that function, and on 2026-08-24 it was
// measured wrong -- it refused a forwarded `DISPLAY`, correctly, and had nothing
// to say about `WAYLAND_DISPLAY`, so a verifier started under `xvfb-run` opened a
// real window on the owner's desktop while he was working. A doc comment naming a
// test is not a test.
//
// Nothing here starts a browser, a server or a model. It imports the two pure
// functions and puts environments to them, so it costs a second and can be run
// before anything headed.
//
//	node dev/verify_harness.mjs
//	node dev/verify_harness.mjs --prove   # and show each check failing against
//	                                      # the code as it stood before the fix
//	node dev/verify_harness.mjs --break oldguard   # 1: display.mjs before it could
//	                                      # tell an unattended run from a watched one
//
// ── The break, and why it is a patched copy of the module ────────────
//
// `--prove` above is a paraphrase of the old function written out by hand, and a
// paraphrase proves that the paraphrase disagrees.  The break below is not: it
// reads `dev/display.mjs` off the disk, cuts the unattended rule out of it, writes
// the result to the scratch directory and imports THAT.  So the red is the module
// as it stood, in the layer the change was made in -- which is the standard the
// rest of this tree's breaks are held to, and this file was the exception.
//
// It can be done here and almost nowhere else because `display.mjs` has no imports
// at all, so a copy of it anywhere on the disk is the same module.  That property
// is stated at the top of that file for a different reason and pays twice.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import * as GUARD from './harness.mjs';

const { cleanDisplayEnv, WAYLAND_VARS } = GUARD;

const PROVE = process.argv.includes('--prove');

/// The one break this file declares, or `''` for the clean run.
const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : '';
})();
if (BREAK && BREAK !== 'oldguard') {
	console.log(`no such break: ${BREAK}. This file declares: oldguard.`);
	process.exit(1);
}

/// The two lines inside `displayFault` that ask the question at all.
///
/// A marker rather than a line number: the file is edited by hand and a number
/// would rot into a break that silently removed the wrong thing -- or nothing,
/// which is the failure `normalise()` in the hand calls the most damning.
const CALL_MARK = '\tconst nobody = unattendedFault(e);';

/// The banner the rule and the three names it is spelled with all sit under.
const BLOCK_MARK = '// │ A display nobody is looking at, and the seat that is           │';

/// The last line of that block, so the cut ends where the old file ended.
const BLOCK_END = '\nexport function unattendedFault(e) {';

/// `dev/display.mjs` as it stood before the unattended rule, as a module.
///
/// BOTH halves go -- the rule and its three names, and the two lines in
/// `displayFault` that call it -- because the file before this change had neither,
/// and a break that left the names behind would leave one check unreddenable and
/// therefore unmeasured. What is left is byte for byte the old `displayFault`:
/// nothing is paraphrased, which is what `--prove` below does and why it is not
/// enough on its own. Refused if either cut changes nothing, so a break that has
/// stopped reproducing anything says so rather than passing quietly.
async function guardBefore() {
	const src = fs.readFileSync(path.join(HERE, 'display.mjs'), 'utf8');
	let cut = src;
	const at = cut.indexOf(CALL_MARK);
	if (at < 0) {
		throw new Error('the call to unattendedFault was not found in dev/display.mjs, so '
			+ 'this break reproduces nothing. Fix CALL_MARK here.');
	}
	// Back over the comment the call sits under, and forward past the `if`.
	const top = cut.lastIndexOf('\t// UNATTENDED FIRST', at);
	const after = cut.indexOf('\n', cut.indexOf('if (nobody) return nobody;', at)) + 1;
	cut = cut.slice(0, top < 0 ? at : top) + cut.slice(after);
	const nb = cut.indexOf(BLOCK_MARK);
	const ne = cut.indexOf(BLOCK_END);
	if (nb < 0 || ne < nb) {
		throw new Error('the unattended block was not found in dev/display.mjs; fix '
			+ 'BLOCK_MARK and BLOCK_END here.');
	}
	// Back to the top of the box-drawn banner, and forward to the end of the
	// function the banner introduces.
	const bt = cut.lastIndexOf('// ┌', nb);
	const be = cut.indexOf('\n}\n', ne) + 4;	// and the blank line after it
	cut = cut.slice(0, bt < 0 ? nb : bt) + cut.slice(be);
	if (cut === src) throw new Error('the cut changed nothing.');
	if (cut.includes('UNATTENDED_VAR')) {
		throw new Error('the cut left the rule behind, so this break reproduces nothing.');
	}
	const dir = path.join(process.env.DAIMOND_SCRATCH
		|| path.join(os.homedir(), '.cache/daimond'), 'harness-break');
	fs.mkdirSync(dir, { recursive: true });
	const f = path.join(dir, `display.before.${process.pid}.mjs`);
	fs.writeFileSync(f, cut);
	const m = await import(pathToFileURL(f).href);
	fs.rmSync(f, { force: true });
	return m;
}

const HERE = path.dirname(new URL(import.meta.url).pathname);

/// The module the checks below are put to: this tree's, or this tree's as it stood.
const UNDER = BREAK === 'oldguard' ? await guardBefore() : GUARD;
const displayFault = UNDER.displayFault;
const { UNATTENDED_VAR, OWNED_VAR, SEAT_DISPLAY } = UNDER;
if (BREAK) {
	console.log(`\n── BREAK ${BREAK}: dev/display.mjs with the unattended rule cut out ──`);
}

let ok = 0, bad = 0;

/// One check, named as a property rather than as a step.
function check(name, pass, detail) {
	if (pass) { ok++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── The seat this machine actually has ──────────────────────────
//
// Every case below is spelled the way argonaut spells it, because that is the
// machine the fault happened on: a Wayland session, `WAYLAND_DISPLAY=wayland-0`
// and `XDG_SESSION_TYPE=wayland` in every rc session, and `xvfb-run` adding a
// `DISPLAY` beside them rather than instead of them.
const UNDER_XVFB = { DISPLAY: ':99', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' };
const OWN_SEAT   = { DISPLAY: ':0',  WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' };
const FORWARDED  = { DISPLAY: 'localhost:10.0' };
const NOTHING    = {};
const WAYLAND_ONLY = { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' };

console.log('\n── What is taken out of a launch environment ─────────');

{
	const cleaned = cleanDisplayEnv(UNDER_XVFB);
	check('the Wayland variables are taken out, so Chromium takes the X path',
		WAYLAND_VARS.every((v) => cleaned[v] === undefined),
		JSON.stringify(cleaned));
	check('and the display xvfb provided is left alone, or there is nowhere to paint',
		cleaned.DISPLAY === ':99');
}

{
	// The variable Chromium needs for reasons that have nothing to do with the
	// screen. Taking it out breaks a headless run, so a check says it is kept.
	const cleaned = cleanDisplayEnv({ ...UNDER_XVFB, XDG_RUNTIME_DIR: '/run/user/1000' });
	check('XDG_RUNTIME_DIR survives, since it is not about the display at all',
		cleaned.XDG_RUNTIME_DIR === '/run/user/1000');
}

{
	const src = { ...UNDER_XVFB };
	cleanDisplayEnv(src);
	check('the environment handed in is not edited, only the copy handed back',
		src.WAYLAND_DISPLAY === 'wayland-0');
}

console.log('\n── What a headed run is refused ──────────────────────');

check('a run under xvfb is allowed, Wayland variables and all',
	displayFault(UNDER_XVFB) === null, JSON.stringify(displayFault(UNDER_XVFB)));

check('argonaut\'s own seat is allowed, because watching a run is a thing people do',
	displayFault(OWN_SEAT) === null);

{
	const said = displayFault(FORWARDED);
	check('a display forwarded from another machine is refused, and named',
		typeof said === 'string' && /localhost/.test(said) && /somebody else/.test(said));
}

{
	// The case the fix is for: a headed run with no xvfb on a Wayland seat. Before
	// the fix this returned the bare "DISPLAY is unset" sentence, which is true and
	// says nothing about the compositor the browser would have found instead.
	const said = displayFault(WAYLAND_ONLY);
	check('a Wayland seat with no X display is refused, and the refusal says why',
		typeof said === 'string' && /WAYLAND_DISPLAY/.test(said) && /owner's own screen/.test(said),
		JSON.stringify(said));
}

check('an environment with no display at all is refused',
	typeof displayFault(NOTHING) === 'string');

check('a bare DISPLAY string is still read the way it always was',
	displayFault(':99') === null && typeof displayFault('gilgamesh:0') === 'string');

check('and so is nothing at all, rather than throwing',
	typeof displayFault(undefined) === 'string');

console.log('\n── A display nobody is looking at, and the seat that is ─');

// B13: a daimon reaches a headed instrument through `verify`, which runs a tracked
// script OUTSIDE the command fence -- so the script inherits the hand's own
// environment. Start the hand from a desktop session and that environment carries
// `DISPLAY=:0`, and the check above says yes to it, correctly, because a person
// watching their own run is the case it was written for. Nobody is watching this one.
const UNATT = { DAIMOND_UNATTENDED: '1', DAIMOND_OWNED_DISPLAY: ':99' };

{
	const said = displayFault({ ...OWN_SEAT, ...UNATT });
	check('an unattended run is refused the seat, which an attended one is given',
		typeof said === 'string' && said.includes('OWN SEAT'),
		JSON.stringify(said));
}

check('and the same environment without the mark is still allowed, so watching still works',
	displayFault(OWN_SEAT) === null);

check('an unattended run on the display it started for itself is allowed',
	displayFault({ ...UNDER_XVFB, ...UNATT }) === null,
	JSON.stringify(displayFault({ ...UNDER_XVFB, ...UNATT })));

{
	// The ordinary way a wrong display arrives: inherited from whatever started the
	// process, never chosen. `:98` is somebody else's xvfb, which is not this run's
	// to paint on either.
	const said = displayFault({ DISPLAY: ':98', ...UNATT });
	check('an unattended run on a display it did not start is refused',
		typeof said === 'string' && said.includes(':98') && said.includes(':99'),
		JSON.stringify(said));
}

{
	const said = displayFault({ DISPLAY: ':99', DAIMOND_UNATTENDED: '1' });
	check('an unattended run that claims no display of its own is refused',
		typeof said === 'string' && said.includes(String(OWNED_VAR)),
		JSON.stringify(said));
}

{
	// A launcher that names the seat AS its own must not be believed. This is the
	// belt beside the brace: the comparison above would pass a launcher whose two
	// names agree, and agreeing on the wrong display is exactly the accident.
	const said = displayFault({ DISPLAY: ':0', DAIMOND_UNATTENDED: '1', DAIMOND_OWNED_DISPLAY: ':0' });
	check('a launcher that claims the seat as its own display is refused anyway',
		typeof said === 'string' && said.includes('OWN SEAT'),
		JSON.stringify(said));
}

{
	const said = displayFault({ ...FORWARDED, ...UNATT });
	check('a forwarded display is refused for an unattended run as it always was, and named',
		typeof said === 'string' && /localhost/.test(said) && /somebody else/.test(said));
}

check('the two names and the seat are exported, so a launcher spells none of them itself',
	UNATTENDED_VAR === 'DAIMOND_UNATTENDED' && OWNED_VAR === 'DAIMOND_OWNED_DISPLAY'
		&& SEAT_DISPLAY === ':0',
	`${UNATTENDED_VAR} ${OWNED_VAR} ${SEAT_DISPLAY}`);

// ── Proved against the code as it stood ─────────────────────────
//
// The old `displayFault` in one line: it saw a DISPLAY string and nothing else.
// Every check above that the fix is FOR must fail against it, and every check
// that was already right must still pass -- otherwise the fix is doing something
// other than what it says.
if (PROVE) {
	console.log('\n── The same cases, against displayFault as it stood ───');
	const before = (display) => {
		const d = (display || '').trim();
		if (!d) return 'A headed run needs a display and DISPLAY is unset.';
		const host = d.slice(0, d.indexOf(':') < 0 ? d.length : d.indexOf(':'));
		if (host) return `DISPLAY is "${d}" ... on somebody else's screen`;
		return null;
	};
	// It was handed `env.DISPLAY`, so that is what it is handed here.
	const said = before(WAYLAND_ONLY.DISPLAY);
	console.log(`  ${/WAYLAND_DISPLAY/.test(String(said)) ? 'ok  ' : 'FAIL'} a Wayland seat with no X display is refused, and the refusal says why`
		+ ` — ${JSON.stringify(said)}`);
	console.log(`  ${typeof before !== 'function' ? 'ok  ' : 'FAIL'} the Wayland variables are taken out, so Chromium takes the X path`
		+ ' — there was no such function to call');
	console.log(`  ok   a display forwarded from another machine is refused, and named`
		+ ' — this half was always right, and is unmoved');
}

console.log(`\n${ok} ok, ${bad} failed.`);
if (bad) { console.log('failed checks above.'); process.exit(1); }
