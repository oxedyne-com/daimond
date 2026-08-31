/* ============================================================
   Test — switching a daimon's model is seamless (proposal #1).
   ------------------------------------------------------------
   The daimon settings dialog no longer switches the moment the
   pulldown moves. A "Change" button beside it carries the switch,
   and it shows ONLY while the picked model differs from the one the
   daimon runs on now. Pressing it reuses the existing conversation:
   it re-meters the context against the new model's window and lets
   the engine fold on the next turn; a fresh daimon is never raised.

   The decision this turns on lives in ONE shipped function,
   `DaimondModels.planModelSwitch`, which daimond.js delegates to for
   the button's label and for the fold-vs-fresh question. This drives
   the real www/js/models.js in a minimal browser sandbox and asserts
   the four things the design turns on:

     (a) SAME → NO CHANGE. Picking the model already in force reports
         `changed:false`, so the button stays hidden and no popup can
         be raised — the whole complaint the proposal fixes.

     (b) DIFFERENT → RELABEL. A genuinely different model (by model
         name OR by provider) reports `changed:true`, so the button
         reads "Change".

     (c) RE-METER. The window returned is the NEW model's, never the
         old one's, so the meter is recomputed against the window the
         next turn will actually fold against.

     (d) REUSE, NOT FRESH. A switch whose held context still fits the
         new window reports `needsFresh:false` — the conversation is
         carried across. `needsFresh` trips true only when the context
         exceeds a PUBLISHED new window outright, and never for an
         unknown window, so a fresh daimon is the rare exception the
         proposal describes, not the default.

   Each check is proven able to fail: the four --break modes damage
   the shipped `planModelSwitch` the four ways it could plausibly be
   got wrong, and the checks that guard each defect go red under it.

     node www/js/modelswitch.test.mjs --break neverchange  # the button never relabels
     node www/js/modelswitch.test.mjs --break alwayschange # it relabels for the same model too
     node www/js/modelswitch.test.mjs --break oldwindow    # the meter keeps the old window
     node www/js/modelswitch.test.mjs --break alwaysfresh  # every switch demands a fresh daimon
     node www/js/modelswitch.test.mjs                      # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// ── The patches that prove the checks can fail ─────────────────
// Each damages the ONE shipped function this feature lives in, the
// four ways it could plausibly be got wrong.
//
//   neverchange  the pick is never seen as a change — the button
//                stays hidden and (b) goes red.
//   alwayschange every pick is a change, even the current model —
//                the button relabels when it must not and (a) goes red.
//   oldwindow    the window is read for the OLD model, so the meter
//                measures against the window being left — (c) goes red.
//   alwaysfresh  every switch demands a fresh daimon, throwing away
//                the conversation the proposal exists to keep — (d) red.
function patchModels(src) {
	if (BREAK === 'neverchange') {
		return src.replace(
			"var changed = String(after.model || '')    !== String(before.model || '')\n\t\t\t|| String(after.provider || '') !== String(before.provider || '');",
			'var changed = false;');
	}
	if (BREAK === 'alwayschange') {
		return src.replace(
			"var changed = String(after.model || '')    !== String(before.model || '')\n\t\t\t|| String(after.provider || '') !== String(before.provider || '');",
			'var changed = true;');
	}
	if (BREAK === 'oldwindow') {
		return src.replace(
			"(DaimondPricing.contextWindow(after.model || '', after.provider || '') || 0)",
			"(DaimondPricing.contextWindow(before.model || '', before.provider || '') || 0)");
	}
	if (BREAK === 'alwaysfresh') {
		return src.replace(
			'needsFresh: changed && win > 0 && (used || 0) > win,',
			'needsFresh: changed,');
	}
	return src;
}

// ── A minimal browser sandbox ──────────────────────────────────
// models.js is a classic-script IIFE reading the bare globals
// `window`, `document`, `localStorage` and (guarded) the timers. It
// attaches `DaimondModels` onto window.
const store = new Map();
const localStorage = {
	getItem:    (k) => (store.has(k) ? store.get(k) : null),
	setItem:    (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};
const win = globalThis;
win.dispatchEvent = () => true;
// `visibilityState: 'hidden'` keeps the credit heartbeat from starting — it beats
// only while the tab is in front, and there is no tab here.
const documentShim = {
	addEventListener: () => {},
	getElementById:   () => null,
	visibilityState:  'hidden',
};
function loadScript(rel, transform) {
	let body = readFileSync(join(HERE, rel), 'utf8');
	if (transform) body = transform(body);
	const fn = new Function('window', 'document', 'localStorage', 'console', 'globalThis', body);
	fn(win, documentShim, localStorage, console, globalThis);
}

loadScript('models.js', patchModels);

const M = win.DaimondModels;
if (!M || !M.planModelSwitch) { console.error('ABORT: DaimondModels.planModelSwitch missing'); process.exit(2); }

// A pricing stub keyed by model, so a switch's window differs by which model it
// lands on — the only way to show the meter followed the NEW model rather than
// keeping the old one. `model-x` is deliberately absent: an unknown window is 0.
const WINDOW = { 'model-a': 200000, 'model-b': 32000 };
win.DaimondPricing = {
	contextWindow: (model /*, provider */) => (WINDOW[model] != null ? WINDOW[model] : null),
};

const A  = { provider: 'fw',    model: 'model-a' };	// 200k window, the model in force
const B  = { provider: 'fw',    model: 'model-b' };	//  32k window, a smaller one
const A2 = { provider: 'other', model: 'model-a' };	// same name, a different provider
const X  = { provider: 'fw',    model: 'model-x' };	// no published window

function main() {
	// ── (a) SAME → NO CHANGE ───────────────────────────────────
	console.log('(a) picking the model already in force is not a change');
	const same = M.planModelSwitch(A, A, 5000);
	check('same model reports changed:false', same.changed === false, 'changed=' + same.changed);
	check('same model needs no fresh daimon', same.needsFresh === false);
	check('same model still reports its own window', same.window === WINDOW['model-a'],
		'window=' + same.window);

	// ── (b) DIFFERENT → RELABEL ────────────────────────────────
	console.log('(b) a genuinely different model relabels the button to "Change"');
	const diff = M.planModelSwitch(A, B, 5000);
	check('a different model reports changed:true', diff.changed === true);
	const prov = M.planModelSwitch(A, A2, 5000);
	check('the same model name on a different provider is still a change',
		prov.changed === true);

	// ── (c) RE-METER ───────────────────────────────────────────
	console.log('(c) the meter is recomputed against the NEW model’s window');
	check('the window returned is the new model’s, not the old one’s',
		diff.window === WINDOW['model-b'] && diff.window !== WINDOW['model-a'],
		'window=' + diff.window);

	// ── (d) REUSE, NOT FRESH ───────────────────────────────────
	console.log('(d) the conversation is reused; a fresh daimon is the rare exception');
	check('a switch whose context fits the new window reuses it (needsFresh:false)',
		diff.needsFresh === false, 'used 5000 <= window ' + diff.window);
	const tight = M.planModelSwitch(A, B, 50000);
	check('a context that exceeds the new window is the one case fresh is needed',
		tight.needsFresh === true, 'used 50000 > window ' + tight.window);
	const unknown = M.planModelSwitch(A, X, 999999);
	check('an unknown new window never forces a fresh daimon',
		unknown.changed === true && unknown.window === 0 && unknown.needsFresh === false,
		'window=' + unknown.window + ' needsFresh=' + unknown.needsFresh);

	console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks
		+ ' checks' + (BREAK ? ' (--break ' + BREAK + ')' : ''));
	process.exit(failures ? 1 : 0);
}

main();
