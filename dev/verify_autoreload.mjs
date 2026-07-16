// verify_autoreload.mjs — the standing instruction to buy your own credits.
//
// This one is driven against the REAL gateway on :9002, not a stub, because the thing worth
// proving is not that the form renders. It is that the gateway REFUSES the settings that cannot
// work, and that the browser shows the refusal rather than pretending it saved:
//
//   * on, with no card       -> 422. There is nothing to charge, and the user would not find out
//                               until the balance ran dry.
//   * budget < one top-up    -> 400. The first reload already crosses the cap, so the setting
//                               would look on and never act.
//
// Both are the gateway's rules. The browser must not have its own copy of them — it must ask, and
// say what it is told. A client that guesses is a client that will one day guess differently from
// the till.
import { open, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'autoreload', connect: false });
const p = s.page;
await p.waitForTimeout(2000);

// The gateway must be up, or nothing below means anything.
const up = await p.evaluate(async () => {
	const r = await fetch('/api/autoreload', { credentials: 'same-origin' });
	return { status: r.status };
});
check('the gateway is up and the route is reachable',
	up.status === 200 || up.status === 401, 'HTTP ' + up.status);

// Open Credits — the panel lives with the credits, not in a settings page of its own.
await p.evaluate(() => {
	const row = document.getElementById('astat-credits')
		|| [...document.querySelectorAll('.astat-row')].find(r => /credit/i.test(r.textContent));
	if (row) row.click();
});
await p.waitForTimeout(1800);

const panel = await p.evaluate(() => {
	const h = document.getElementById('autoreload');
	return {
		there:   !!h && h.textContent.trim().length > 0,
		text:    h ? h.textContent : '',
		hasCard: !!document.querySelector('.ar-card-has'),
		noCard:  !!document.querySelector('.ar-card-none'),
		switchDisabled: !!(document.getElementById('ar-on') || {}).disabled,
	};
});
check('auto-reload appears inside Credits, where the balance is',
	panel.there, panel.there ? '(rendered)' : '(empty — is the account authed?)');
check('a fresh account is told it has no card', panel.noCard === true);
check('and the switch cannot be turned on without one',
	panel.switchDisabled === true,
	panel.switchDisabled ? 'disabled, and says why' : 'ENABLED WITH NO CARD');
check('the panel says what it will do, in words',
	/charges the card below, without asking/i.test(panel.text));

await shot(s, 'autoreload');

// ── The gateway's refusals, seen from the browser ──────────────────────
//
// The switch is disabled in the UI, so the "on with no card" case is forced at the API — which is
// where it must hold anyway, since a client can always be lied to but the gateway cannot.

const noCard = await p.evaluate(async () => {
	const r = await fetch('/api/autoreload', {
		method: 'POST', credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ enabled: true, threshold_minor: 500, topup_minor: 2000, monthly_budget_minor: 10000 }),
	});
	return { status: r.status, body: await r.text() };
});
check('turning it on with no card is refused by the gateway',
	noCard.status === 422, 'HTTP ' + noCard.status);
check('and the refusal says what to do about it',
	/save a card/i.test(noCard.body), noCard.body.slice(0, 90));

const tooSmall = await p.evaluate(async () => {
	const r = await fetch('/api/autoreload', {
		method: 'POST', credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		// Off, so the card rule does not fire first — but the budget is still nonsense.
		body: JSON.stringify({ enabled: false, threshold_minor: 500, topup_minor: 2000, monthly_budget_minor: 1000 }),
	});
	return { status: r.status, body: await r.text() };
});
// With `enabled: false` the gateway saves it: an instruction that is off cannot misfire, and
// refusing to let a user write down a plan before switching it on would be officious.
check('settings that are OFF are saved without argument, nonsense or not',
	tooSmall.status === 200, 'HTTP ' + tooSmall.status);

// The same nonsense, ON. It is refused — but for the CARD, not the budget: the card is asked
// about first, because it is the refusal the user can act on. Told the budget was too small while
// also having no card, they would fix the budget and be refused all over again.
//
// Which means the budget rule is unreachable from here, and from any browser test: it lies behind
// the card check, and no test can put a real card on a real Stripe customer. It is therefore
// tested where it CAN be — `autoreload::tests::test_a_budget_under_one_topup_is_refused`, against
// the pure `refuse()` the handler calls. This check exists to pin the ORDER, so that if the two
// rules are ever swapped, this fails and says so.
const nonsenseOn = await p.evaluate(async () => {
	const r = await fetch('/api/autoreload', {
		method: 'POST', credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ enabled: true, threshold_minor: 500, topup_minor: 2000, monthly_budget_minor: 1000 }),
	});
	return { status: r.status, body: await r.text() };
});
check('switching on with no card complains about the CARD, not the budget — the fixable thing first',
	nonsenseOn.status === 422 && /saved card/i.test(nonsenseOn.body),
	'HTTP ' + nonsenseOn.status + ' — ' + nonsenseOn.body.slice(0, 60));

// ── What is saved is what comes back ──────────────────────────────────

const roundTrip = await p.evaluate(async () => {
	await fetch('/api/autoreload', {
		method: 'POST', credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ enabled: false, threshold_minor: 750, topup_minor: 2500, monthly_budget_minor: 15000 }),
	});
	const r = await fetch('/api/autoreload', { credentials: 'same-origin' });
	return await r.json();
});
check('what is written is what is read back',
	roundTrip.threshold_minor === 750 && roundTrip.topup_minor === 2500
		&& roundTrip.monthly_budget_minor === 15000 && roundTrip.enabled === false,
	`${roundTrip.threshold_minor}/${roundTrip.topup_minor}/${roundTrip.monthly_budget_minor} enabled=${roundTrip.enabled}`);
check('and the month\'s spend is reported against the ceiling',
	typeof roundTrip.spent_this_month_minor === 'number',
	'spent ' + roundTrip.spent_this_month_minor + ' of ' + roundTrip.monthly_budget_minor);
check('the card is always the same shape, never null',
	roundTrip.card && typeof roundTrip.card.saved === 'boolean',
	JSON.stringify(roundTrip.card));

// The panel must show what the gateway now holds, not what it drew before.
await p.evaluate(() => window.DaimondAutoReload.render());
await p.waitForTimeout(900);
const shown = await p.evaluate(() => {
	const v = id => (document.getElementById(id) || {}).value;
	return { th: v('ar-threshold'), tu: v('ar-topup'), bu: v('ar-budget') };
});
check('the panel shows the saved numbers, in whole units',
	shown.th === '7.5' && shown.tu === '25' && shown.bu === '150',
	`${shown.th} / ${shown.tu} / ${shown.bu}`);

// The 422s are the refusals this test went looking for, so they are not faults — the browser logs
// every non-2xx fetch as a console error.
const errs = errors(s).filter(e => !/favicon|404|401|422|Unprocessable|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
check('nothing throws', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
