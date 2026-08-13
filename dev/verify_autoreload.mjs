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
//
// AND THE PANEL HAS TO BE THERE AT ALL. The last section drives a session whose gateway
// bootstrap is still in flight when Credits is opened, which is the state a loaded machine
// produces by itself. Proved red first:
//
//   node dev/verify_autoreload.mjs --break latefill   # the late fill is caught
//   node dev/verify_autoreload.mjs                    # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, errors } from './harness.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const AR_JS = path.join(HERE, '..', 'www', 'js', 'autoreload.js');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const die = (why) => { console.error('ABORT: ' + why); process.exit(2); };
if (BREAK && BREAK !== 'latefill') die(`no break called "${BREAK}"`);

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
// Wait for the panel, rather than sleeping at where it ought to be.
//
// This was a flat 1800ms, and on the gate of 2026-08-13 that was not enough: the gateway
// session is taken asynchronously at boot — an account POST, a challenge, a signature, a
// verify — and on a loaded machine it had not landed when the panel was read. Five checks
// went red, including the self-test below, which correctly reported that there was nothing
// for it to blind. A fixed sleep made this file's verdict a measurement of how busy the
// machine was.
//
// BOUNDED, so a panel that never arrives still fails, and fails saying so. Waiting for the
// condition is not the same as assuming it: the case where the session lands AFTER Credits
// was opened is a property in its own right, and it is proved at the foot of this file.
await p.waitForFunction(() => {
	const h = document.getElementById('autoreload');
	return !!h && h.textContent.trim().length > 0;
}, null, { timeout: 15000 }).catch(() => { /* the check below reports it */ });

const panel = await p.evaluate(() => {
	const h = document.getElementById('autoreload');
	return {
		there:   !!h && h.textContent.trim().length > 0,
		text:    h ? h.textContent : '',
		// The LEAD, on its own. The panel's own furniture says "card" and "budget"
		// in its labels, so a claim tested against the whole panel is answered by
		// the widgets and passes whether or not a sentence explains anything.
		lead:    (h && h.querySelector('.cfg-lead') || {}).textContent || '',
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
// ── The panel explains itself ──────────────────────────────────────────
//
// A standing instruction to spend the user's money must SAY, before it is armed, the three
// things a person would otherwise find out from a statement: that the money comes off the
// CARD, that it happens WITHOUT THEM BEING ASKED, and that their own LIMIT bounds it.
//
// Those three facts are the property. The sentence carrying them is not: this check used to
// match `charges the card below, without asking` verbatim and went red on 2026-08-11 when a
// concision pass over 222 catalogue strings dropped two commas — the panel explained itself
// exactly as well before and after. A check that cannot survive a comma is measuring the
// author, not the product.
const SAYS = {
	'what is charged':   /\bcards?\b/i,
	'that it is unasked': /without (being )?ask|without asking|automatic|on its own|by itself|unprompted/i,
	'the user’s ceiling': /\b(limit|cap|ceiling|budget|no more than|up to)\b/i,
	'that it spends':     /\bcharg|\bbuy|\bbuys\b|\bbought\b|top[- ]?up|purchas/i,
};
const explains = (s) => Object.entries(SAYS).filter(([, re]) => !re.test(String(s || ''))).map(([k]) => k);
const missing = explains(panel.lead);
check('the panel says what it will do, in words',
	panel.lead.trim().length > 0 && missing.length === 0,
	missing.length ? 'the lead never says: ' + missing.join(', ') + ' — “' + panel.lead + '”'
		: '“' + panel.lead.trim() + '”');

// And the same check, over copy that genuinely explains nothing — read back out of the DOM
// by the same path, so what is proved red is the whole check and not just its regexes.
const blinded = await p.evaluate(() => {
	const el = document.querySelector('#autoreload .cfg-lead');
	if (!el) return null;
	const was = el.textContent;
	el.textContent = 'Auto-reload settings.';
	const seen = (document.querySelector('#autoreload .cfg-lead') || {}).textContent || '';
	el.textContent = was;
	return { seen, restored: (document.querySelector('#autoreload .cfg-lead') || {}).textContent };
});
check('and it is a check that can fail — a lead that explains nothing is caught',
	!!blinded && explains(blinded.seen).length === Object.keys(SAYS).length
		&& blinded.restored === panel.lead,
	blinded ? 'a bare “' + blinded.seen + '” is missing all ' + Object.keys(SAYS).length
		: 'there was no lead paragraph to blind');

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
// 402 joins the ambient list: a free account's idle sync push is refused
// (sync is Pro), which the browser logs while this test is about auto-reload.
const errs = errors(s).filter(e => !/favicon|404|401|402|422|Unprocessable|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
check('nothing throws', errs.length === 0, errs[0] || '');

await s.close();

// ── A session that lands AFTER Credits was opened fills the panel in ────
//
// Everything above is measured on a session that had already landed. This is the case where
// it has not, and until 2026-08-13 it was a permanent blank: `render` draws nothing without
// `state.authed`, the flag is set five round trips into the boot, and NOTHING redrew the
// panel when it flipped. A user who reached Credits a second early was shown an empty space
// where the standing instruction to spend their money should be, for the life of the page.
// The only way back was a reload, and nothing on screen said so.
//
// That is also what made the gate red rather than this file: the failure arrived as a timing
// flake, so it read as a slow machine instead of a missing panel.
//
// Driven by holding the LAST leg of the bootstrap, so the app is in exactly the state a
// loaded machine puts it in: unlocked, drawn, and not yet authed. The precondition is
// ASSERTED and not assumed — a run where the session beat the click proves nothing, and must
// say so rather than going green.
const HOLD_MS = 8000;
const late = await open({
	name: 'autoreload-late', connect: false,
	route: async (pg) => {
		await pg.route('**/api/auth/verify', async (r) => {
			await new Promise((f) => setTimeout(f, HOLD_MS));
			await r.continue();
		});
		if (BREAK === 'latefill') {
			// The listener taken back out, and only that: the panel is drawn by
			// exactly the code that drew it before, and nothing redraws it late.
			const src  = fs.readFileSync(AR_JS, 'utf8');
			const hurt = src.replace(/\twindow\.addEventListener\('daimond:authed'[\s\S]*?\n\t\}\);\n/, '');
			if (hurt === src) die('the latefill break did not reach the daimond:authed listener');
			await pg.route('**/js/autoreload.js', (r) =>
				r.fulfill({ status: 200, contentType: 'text/javascript', body: hurt }));
		}
	},
});
const lp = late.page;
await lp.waitForTimeout(1500);
await lp.evaluate(() => {
	const row = document.getElementById('astat-credits')
		|| [...document.querySelectorAll('.astat-row')].find(r => /credit/i.test(r.textContent));
	if (row) row.click();
});
await lp.waitForTimeout(600);
const early = await lp.evaluate(() => {
	const h = document.getElementById('autoreload');
	return {
		empty:  !h || h.textContent.trim().length === 0,
		authed: !!(window.DaimondGateway && DaimondGateway.state().authed),
	};
});
// The panel AND the session, so a blank that stays blank cannot be read as a session that
// never came.
const filled = await lp.waitForFunction(() => {
	const h = document.getElementById('autoreload');
	return !!h && !!h.querySelector('.cfg-lead')
		&& !!(window.DaimondGateway && DaimondGateway.state().authed);
}, null, { timeout: 20000 }).then(() => true).catch(() => false);
const lateAuthed = await lp.evaluate(() =>
	!!(window.DaimondGateway && DaimondGateway.state().authed));
check('Credits opened before the session lands is filled in when it does',
	early.empty && !early.authed && filled,
	!early.empty || early.authed
		? 'nothing was proved: the session had already landed when Credits was opened'
		: filled ? 'blank while unauthed, drawn once authed'
			: `still blank ${lateAuthed ? 'WITH' : 'without'} a session, 20s on`);
await shot(late, 'autoreload-late');
await late.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
if (BREAK) {
	if (bad.length) { console.log('the break was caught, as it should be'); process.exit(0); }
	console.log('THE BREAK WAS NOT CAUGHT: this check proves nothing');
	process.exit(1);
}
process.exit(bad.length ? 1 : 0);
