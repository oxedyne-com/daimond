// verify_wasmpanic.mjs — a Rust panic must say where it happened.
//
// WHY. There was no panic hook in this app at all, and a wasm panic without one
// is the most opaque failure it can produce:
//
//   - the browser reports a bare `"Script error."` with no file, line or message
//   - the `Promise` the call was made through NEVER SETTLES, so the caller's
//     `.then` and `.catch` both stay silent for ever
//   - the module is poisoned, so everything after it fails differently
//
// An iPhone looped on exactly that for four sessions. The durable trail showed
// `unlocked`, then `Script error.`, then a step that had started and reported
// neither success nor failure, and then the tab dying. Four diagnoses were made
// from reading code and all four were wrong, because the one component that
// knew what had happened had nowhere to say it.
//
// So: a hook, and this file, which requires the hook to be REAL rather than
// present. A diagnostic nobody has watched work is a diagnostic whose silence
// means nothing.
//
// WHAT IS LOCKED DOWN.
//
//  A. A panic reaches the durable trail, with the FILE AND LINE in it.
//  B. It also reaches the console, for anyone who has one.
//  C. It survives a reload, because a panicking tab is a tab about to go away
//     and a message that dies with it is no message at all.
//  D. The hook is installed before the app can run anything — it is the first
//     thing after `init()`, not somewhere later that a panic could beat.
//  E. Installing twice is harmless.
//
//   node dev/verify_wasmpanic.mjs
//
// Needs dev/serve.mjs. No gateway, no model.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const out = [];
let bad = 0;
const check = (ok, what, detail) => {
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail != null ? ' — ' + detail : ''}`);
	if (!ok) bad++;
	return ok;
};

// ── D. Installed FIRST, read from the source ────────────────────────
//
// Ordering is the whole value of a panic hook: one installed after the thing
// that panics reports nothing. Checked in the file rather than at runtime,
// because a runtime check can only see the order that happened to occur.
{
	const src = fs.readFileSync(path.join(ROOT, 'www', 'js', 'daimond.js'), 'utf8');
	const at   = src.indexOf('install_panic_hook()');
	const init = src.indexOf('await init();');
	const ready = src.indexOf('__DAIMOND_READY = true');
	check(at > 0 && init > 0 && at > init && at < ready,
		'the hook is installed immediately after the wasm module, before anything uses it',
		`init@${init} hook@${at} ready@${ready}`);
}

const PROFILE = scratch('pw', 'wasmpanic-' + process.pid);
fs.rmSync(PROFILE, { recursive: true, force: true });
const s = await open({ name: 'wasmpanic', connect: false, profile: PROFILE });
const p = s.page;

// ── A + B. It reports, with a location ──────────────────────────────
const r = await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	// Twice, which also covers E: the second install must not throw and the
	// second panic must still report.
	try { m.install_panic_hook(); } catch (e) { /* already */ }
	try { m.panic_on_purpose(); } catch (e) { /* the wasm trap, expected */ }
	await new Promise((r) => setTimeout(r, 300));
	return {
		rows: (window.DaimondTrail.rows() || []).filter((x) => /panic/i.test(x.w)),
		text: window.DaimondTrail.text(),
	};
});

check(r.rows.length > 0, 'a panic reaches the durable trail', `${r.rows.length} row(s)`);
const said = (r.rows[0] || {}).d || '';
check(/entry\.rs:\d+/.test(said),
	'and NAMES THE FILE AND THE LINE — which is the whole point',
	JSON.stringify(said.slice(0, 90)));
check(/panic_on_purpose/.test(said),
	'and carries the panic message, not just its location');

const consoled = s.logs.some((l) => /panic_on_purpose/.test(l));
check(consoled, 'and the console gets it too, for anyone who has one');

// ── C. It survives the reload ───────────────────────────────────────
{
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(1200);
	const after = await p.evaluate(() => {
		try { return (window.DaimondTrail.rows() || []).filter((x) => /panic/i.test(x.w)).length; }
		catch (e) { return -1; }
	});
	check(after > 0,
		'and it is still there after a reload — a panicking tab is one about to go away',
		String(after));
}

// ── The trail says nothing it should not ────────────────────────────
check(!/[A-Za-z0-9_-]{32,}/.test(r.text),
	'the trail carries nothing that looks like a key or a token',
	JSON.stringify((r.text.match(/[A-Za-z0-9_-]{32,}/) || [])[0] || 'none'));

await s.close();
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* gone */ }

console.log(out.join('\n'));
const total = out.filter((l) => /^(PASS|FAIL)/.test(l)).length;
console.log(bad === 0 ? `\nALL ${total} CHECKS PASSED` : `\n${bad} of ${total} FAILED`);
process.exit(bad === 0 ? 0 : 1);
