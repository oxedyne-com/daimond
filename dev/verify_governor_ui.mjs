// verify_governor_ui.mjs — the spend governor, wired into the real page.
//
// The pure decision core is covered by verify_governor.mjs under Node. This
// drives the actual app (governor.js loaded in index.html, alongside the real
// ledger) to prove the wiring: the module is present, its live decision runs,
// its state escalates to amber after a burst, and no console error is thrown.
//
// Needs dev/serve.mjs on :8777 and dev/mockllm.mjs on :9099. The gateway is
// NOT needed — the governor never touches it.
import { open, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'governor', signIn: true, connect: true });
const { page } = s;

// 1. The module and the ledger getter it depends on are both present.
const present = await page.evaluate(() => ({
	gov: !!window.DaimondGovernor,
	samples: !!(window.DaimondLedger && typeof window.DaimondLedger.samples === 'function'),
	assess: !!(window.DaimondGovernor && typeof window.DaimondGovernor.assessDispatch === 'function'),
}));
check('DaimondGovernor is loaded', present.gov);
check('DaimondLedger.samples exists', present.samples);
check('assessDispatch is exposed', present.assess);

// 2. The live decision: a normal fan-out clears, a big one asks. This runs the
//    real module against the real (empty) ledger, so it exercises the fallback
//    baseline and the auto budget as they ship.
const decision = await page.evaluate(() => ({
	few: window.DaimondGovernor.assessDispatch(3),
	many: window.DaimondGovernor.assessDispatch(60),
}));
check('a few agents clear silently in-page', decision.few && decision.few.needsConfirm === false,
	'predicted ' + (decision.few && decision.few.predicted));
check('a big fan-out needs confirming in-page', decision.many && decision.many.needsConfirm === true,
	'predicted ' + (decision.many && decision.many.predicted));

// 3. State escalates to amber after a synthetic burst. Feeding the real module
//    a run of costly turns at "now" should push the live rate well past the
//    fallback baseline.
const level = await page.evaluate(() => {
	const now = Date.now();
	for (let i = 0; i < 8; i++) window.DaimondGovernor.observe({ t: now - i * 2000, u: 0.60 });
	return window.DaimondGovernor.status().level;
});
check('a costly burst reads as amber (or tripped)', level === 'amber' || level === 'tripped', 'level ' + level);

// 4. Setting a budget is honoured by the next decision.
const budgeted = await page.evaluate(() => {
	window.DaimondGovernor.setBudget(0.05);		// a tiny pace budget
	const a = window.DaimondGovernor.assessDispatch(1);
	window.DaimondGovernor.setBudget(null);		// back to auto
	return a.needsConfirm;
});
check('a tiny user budget makes even one agent ask', budgeted === true);

// 5. No console errors from the governor. The gateway is deliberately not run
//    in this minimal stack, so its proxied /api/ calls answer 502 — that noise
//    is expected and filtered; anything else is a real fault.
const real = s.errs.filter(e => !/502|Bad Gateway|Failed to load resource/i.test(e));
check('no governor-related console errors', real.length === 0, real.slice(0, 3).join(' | '));

await shot(s, 'governor');
await s.close();

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
