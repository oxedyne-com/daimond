// verify_unbidden.mjs -- every yes-question a running turn raises takes R6's guard: focus
// on the safe answer, and no stray key for about a second (re-check of 2026-09-23, R6;
// this bc3 follow-up carries the same fix to the door's other dialogs).
//
// R6 itself was proved against the held-delete question alone (dev/verify_deletekeep.mjs,
// F8, checks 6). This asserts the same three properties against two more of the dialogs
// the fix now reaches, chosen because each is driven with no chat, no hand and no real
// browser extension:
//
//   THE `run` PERMISSION, through `window.__daimondEgressAllowed` -- the same global
//   `dev/verify_netchip.mjs` drives the network question through -- with `tool: 'run'`.
//
//   THE WEB PANEL'S "Yes, do it", through `DaimondWeb._confirmForTest`. Test only: it
//   calls the production `confirm` callback daimond.js wires into `DaimondWeb.init` at
//   boot -- the same function `confirmAndRetry` calls when the extension flags a
//   consequential act -- without standing up a real extension to flag one.
//
// Needs dev/serve.mjs (DAIMOND_PORT) and dev/mockllm.mjs (DAIMOND_MOCK_PORT):
//   eval "$(bash dev/world.sh N --env)"
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'unbidden' });
const p = s.page;

/// Raise a dialog with `gate` (an UNAWAITED `p.evaluate(...)`, so the call below can watch
/// it appear before it is answered) and assert R6's guard: focus starts on Cancel, the yes
/// starts disabled, a Space and an Enter sent as it appears answer nothing, and past the
/// first second the yes can be pressed. Closes it with Cancel and returns what the raised
/// call finally resolved to.
async function guarded(label, gate) {
	const seen = await p.waitForSelector('.dlg-card', { timeout: 8000 }).then(() => true, () => false);
	// The one live card, matching the `getClientRects().length` filter
	// `verify_deletekeep.mjs` (F8) and `verify_netchip.mjs` both already rely on: a card
	// mid-close can briefly linger in the document with none.
	const state0 = await p.evaluate(() => {
		const c = [...document.querySelectorAll('.dlg-card')].filter((x) => x.getClientRects().length).pop();
		const a = document.activeElement;
		const okBtn = c && c.querySelector('.dlg-ok');
		return {
			focusCancel: !!(a && a.classList && a.classList.contains('dlg-cancel')),
			okDisabled:  !!(okBtn && okBtn.disabled),
		};
	});
	check(label + ': the dialog focuses its safe button, not its yes',
		seen && state0.focusCancel, JSON.stringify({ seen, ...state0 }));
	check(label + ": and the yes cannot be pressed for the guard's first moment",
		seen && state0.okDisabled, JSON.stringify(state0));
	const t0 = Date.now();
	await p.keyboard.press('Space');
	await p.keyboard.press('Enter');
	const ms = Date.now() - t0;
	await p.waitForTimeout(250);
	const stillUp = !!(await p.$('.dlg-card'));
	check(label + ': a Space and an Enter typed as it appears answer nothing',
		ms < 900 && stillUp, JSON.stringify({ pressedWithinMs: ms, stillUp }));
	await p.waitForTimeout(1100);
	const okEnabled = await p.evaluate(() => {
		const c = [...document.querySelectorAll('.dlg-card')].filter((x) => x.getClientRects().length).pop();
		const b = c && c.querySelector('.dlg-ok');
		return !!b && !b.disabled;
	});
	check(label + ': past the first second the yes can be pressed',
		okEnabled, String(okEnabled));
	await p.evaluate(() => {
		const c = [...document.querySelectorAll('.dlg-card')].filter((x) => x.getClientRects().length).pop();
		if (c) c.querySelector('.dlg-cancel').click();
	});
	return gate;
}

// ── The `run` permission ───────────────────────────────────────────────

const runGate = p.evaluate(() => window.__daimondEgressAllowed(JSON.stringify({
	tool: 'run', url: 'echo hello', detail: '/home/jason/usr', alone: false,
})));
const runVerdict = await guarded('run permission', runGate);
check('run permission: Cancel is read as a refusal', runVerdict === 'deny', String(runVerdict));

// ── The Web panel's "Yes, do it" ────────────────────────────────────────

const hasHook = await p.evaluate(() => !!(window.DaimondWeb && window.DaimondWeb._confirmForTest));
check('DaimondWeb exposes the test hook onto the real wired confirm', hasHook);

if (hasHook) {
	const webGate = p.evaluate(() => window.DaimondWeb._confirmForTest(
		'Daimond wants to buy a thing. This cannot be undone.'));
	const webVerdict = await guarded('web "Yes, do it"', webGate);
	check('web "Yes, do it": Cancel is read as a decline', webVerdict === false, String(webVerdict));
}

const errs = s.errs.filter((e) => !/favicon|404|401|net::ERR|Failed to load resource/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
