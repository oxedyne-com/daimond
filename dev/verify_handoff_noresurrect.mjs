// verify_handoff_noresurrect.mjs — a handed-off turn nobody ran is never run later by
// itself: not on another device, not on the one that sent it.
//
// WHAT HAPPENED. On 2026-09-22 at 13:37Z gilgamesh's recovery pass, started by its tab
// coming back to the foreground, claimed and ran five turns argonaut had handed off on
// 2026-09-17 and nobody had run. The first, `mu4y7fa4-1-du152`, was "Chose: Detach the
// paths" -- the answer to an ask card five days gone -- and it deleted four paths in a
// Diamond nobody was driving. One replay on the phone had already failed (`not_ours`)
// and left the placeholder standing. See
// ~/usr/code/ai/claude/specs/daimond_mass_delete_forensics_20260923.md.
//
// THE RULE: a turn runs when somebody sends it now, or through a hand-off that is
// still valid. These reproduce the incident's shape, each false of 48aa5913:
//
//   (1) ANOTHER DEVICE DOES NOT RESURRECT IT. Two five-day-old placeholders sent by A
//       reach B: the ask answer, whose one replay reported `not_ours`, and a plain
//       prompt whose replay left nothing behind. B reloads (so both are resident, as
//       gilgamesh's were) and its tab comes back to the foreground. Neither runs.
//   (2) NOR DOES THE DEVICE THAT SENT IT, on its own return: neither a five-day-old
//       ask answer of its own nor a five-day-old plain prompt ("Keep going
//       autonomously now", the incident's third turn).
//   (3) THE PERSON IS OFFERED IT INSTEAD: the expired hand-off's tile offers
//       [Run here] and no take-back,
//   (4) and [Run here] runs it on the click.
//   (6) NOR DOES A CLICK SEND AN ANSWER WITHOUT ITS QUESTION. An expired hand-off
//       whose prompt answers a real ask card, asked and answered five days ago, offers
//       [Answer again], not [Run here]. The click sends nothing: it opens the question
//       again, with its options, and silence does not answer it either, with the idle
//       bound cut to three seconds. Only the person's fresh answer reaches the model
//       (replay site 4). (6b) Retry on the stale answer's own bubble does the same.
//   (5) A FRESH ORPHAN IS NOT ANOTHER DEVICE'S EITHER. The cases above are five days
//       old, so each passes on the deadline alone. This one is minutes old: A hands a
//       turn off while B is away, its errand is then taken off the relay (acked, as a
//       failed replay leaves it), and A goes to sleep. B comes back well inside the
//       deadline, holding the placeholder, and must not run it -- the sender gate by
//       itself, the one the incident actually went through (audit F7). Nor may it hand
//       the turn on: the old recovery re-dispatches an orphan to another live desktop
//       before it runs one locally (`retryNextDesktopBeforeLocal`), so (1) and (5)
//       count errands for the turn on the relay as well as model requests.
//   (7) NOR DOES SILENCE ANSWER A QUESTION DAYS OLD. A card five days old, drawn again
//       from the transcript after a reload, stays open past the (shortened) idle bound
//       and sends nothing; a question asked now, on the same page, still answers itself,
//       so the bound is shown to be armed.
//
// The gates themselves -- whose dispatch, how old, whether an ask answer -- are each
// isolated in www/js/peer.test.mjs; this drives them together, as the incident did.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   node dev/verify_handoff_noresurrect.mjs

import {
	checker,
	pair,
	settle,
	storedMsgs,
	placeholders,
	answersFor,
	modelSaw,
	comeBack,
	sendAgo,
	keepErrandsOff,
	reload,
	reopen,
	until,
	freshChat,
} from './handoffpair.mjs';
import { chat } from './harness.mjs';

const FIVE_DAYS = 5 * 86400000;
const QUIET_MS  = 30000;	// how long a return is watched for a run that must not come
const { ok, bad, check } = checker();

/// A hand-off sent five days ago, as the incident's were, then a reload: five days
/// on there is no backstop timer, only what the store holds.
async function staleHandoff(a, prompt) {
	const ph = await sendAgo(a, prompt, FIVE_DAYS);
	await reload(a);
	return ph;
}

/// How many answers device `s` (and `t`, when given) store for `ph`, or -1 without one.
async function answerCount(ph, s, t) {
	if (!ph) return -1;
	let n = answersFor(await storedMsgs(s), ph.iturn).length;
	if (t) n += answersFor(await storedMsgs(t), ph.iturn).length;
	return n;
}

/// How many answers device `s` stores to a user turn that said `prompt`: a non-empty
/// assistant reply after it and before the next prompt. A [Run here] runs the prompt as
/// a fresh local turn, whose records need not carry the placeholder's turn id.
async function answersToPrompt(s, prompt) {
	const ms = await storedMsgs(s);
	let n = 0, open = false;
	for (const m of ms) {
		if (!m) continue;
		if (m.role === 'user') { open = m.content === prompt; continue; }
		if (open && m.role === 'assistant' && !m.why && m.content && String(m.content).trim()) { n++; open = false; }
	}
	return n;
}

/// Bring `s` back to the foreground and watch QUIET_MS. Answers, per phrase, how many
/// model requests carried it since `before` -- counted from the send, so a run by any
/// device at any point after the hand-off counts, not only one the return started.
async function returnAndWatch(s, phrases, before) {
	await comeBack(s.page);
	await s.page.waitForTimeout(QUIET_MS);
	return phrases.map((p, i) => modelSaw(p) - before[i]);
}

/// How many errands for turn `iturn` stand on the relay now, read by `s` without folding
/// or acking anything, or -1 when the box cannot be read. A recovery that hands the
/// orphan on to another desktop instead of running it is a resurrection too, only a
/// later one, and to a device that is asleep a count of model requests alone reads it
/// as nothing having happened.
const errandsFor = (s, iturn) => s.page.evaluate(async (tid) => {
	const r = await window.DaimondPost.call('GET', undefined, '?since=0');
	if (!r || !r.json || !Array.isArray(r.json.rows)) return -1;
	let n = 0;
	for (const row of r.json.rows) {
		let o = null;
		try { o = await window.DaimondPeer.peek(row.envelope); } catch (e) { o = null; }
		if (o && o.t === 'errand' && String(o.turnId) === tid) n++;
	}
	return n;
}, String(iturn)).catch(() => -1);

/// The labels of the controls on turn `tid`'s hand-off tile, or null with no tile.
const tileControls = (s, tid) => s.page.evaluate((id) => {
	const tile = document.querySelector('[data-handoff-turn="' + id + '"]');
	if (!tile) return null;
	return [...tile.querySelectorAll('.ti-continue')].map((x) => String(x.textContent || '').trim());
}, String(tid));

/// Whether the last question card on screen is drawn answered (closed), or null with none.
const lastCardAnswered = (s) => s.page.evaluate(() => {
	const cards = document.querySelectorAll('#chat-output .ask-card');
	return cards.length ? cards[cards.length - 1].classList.contains('answered') : null;
}).catch(() => null);

const P_DETACH = 'Chose: Detach the paths';
const P_FENCE  = 'The fence problem is fixed. Take ONE accepted forge proposal and mark it done';
const P_MARKS  = 'Chose: Remove the marks';
const P_GOON   = 'Keep going autonomously now';
const P_ORPHAN = 'Tidy the fresh orphan whose errand is gone';

let a, b;
try {
	({ a, b } = await pair(check, 'nrlead', 'nrmate'));
	const idA = await a.page.evaluate(() => window.DaimondIdentity.deviceId());

	console.log('\n(1) Two five-day-old hand-offs A sent, one replay failed `not_ours`, and B comes back');
	const saw1 = [modelSaw('Detach the paths'), modelSaw('Take ONE accepted forge proposal')];
	const phX = await staleHandoff(a, P_DETACH);
	check('(1) A holds the handed-off ask answer, stamped five days ago and sent by A',
		!!phX && Date.now() - Number(phX.ts) > 4 * 86400000 && phX.dispatchedBy === idA,
		phX ? JSON.stringify({ iturn: phX.iturn, ageDays: ((Date.now() - phX.ts) / 86400000).toFixed(1),
			byA: phX.dispatchedBy === idA }) : 'no placeholder');
	// The phone's failed replay on 09-17: its run ended and its lease write came back
	// `not_ours`, and the account of it is a report that the turn did not complete.
	if (phX) {
		await a.page.evaluate(async (tid) => {
			const env = await window.DaimondPeer.sealForSelf(window.DaimondPeer.makeReport({
				turnId: tid, status: 'error', why: 'not_ours' }));
			await window.DaimondPost.post(env);
		}, String(phX.iturn));
	}
	// A replay that left nothing at all behind, which the settle rule cannot see.
	const phF = await staleHandoff(a, P_FENCE);
	check('(1) A holds a second, plain five-day-old hand-off with no report', !!phF);
	let bHas = false;
	for (let i = 0; i < 60 && phX && phF && !bHas; i++) {
		await b.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
		const ids = placeholders(await storedMsgs(b)).map((m) => String(m.iturn));
		bHas = ids.includes(String(phX.iturn)) && ids.includes(String(phF.iturn));
		if (!bHas) await b.page.waitForTimeout(500);
	}
	check('(1) B holds both placeholders, synced from A', bHas);
	// Reloaded, B boots with both transcripts resident, as gilgamesh held the Daimond
	// chat's: the recovery scan reads only resident placeholders.
	await reload(b);
	const [ranX, ranF] = await returnAndWatch(b, ['Detach the paths', 'Take ONE accepted forge proposal'], saw1);
	const ansX = await answerCount(phX, b, a);
	const ansF = await answerCount(phF, b, a);
	const reX  = phX ? await errandsFor(b, phX.iturn) : -1;
	const reF  = phF ? await errandsFor(b, phF.iturn) : -1;
	check('(1) B\'s return does NOT run the stale ask answer A sent (nothing reaches the model, no answer, nothing handed on)',
		!!phX && ranX === 0 && ansX === 0 && reX === 0,
		'model requests carrying it: ' + ranX + ', answers stored: ' + ansX + ', errands for it on the relay: ' + reX);
	check('(1) nor the plain one whose replay left no report',
		!!phF && ranF === 0 && ansF === 0 && reF === 0,
		'model requests carrying it: ' + ranF + ', answers stored: ' + ansF + ', errands for it on the relay: ' + reF);

	console.log('\n(2) The same age, and A itself comes back');
	const saw2 = [modelSaw('Remove the marks'), modelSaw(P_GOON)];
	const phY = await staleHandoff(a, P_MARKS);
	const phZ = await staleHandoff(a, P_GOON);
	check('(2) A holds a five-day-old ask answer and a five-day-old plain prompt of its own', !!phY && !!phZ);
	const [ranY, ranZ] = await returnAndWatch(a, ['Remove the marks', P_GOON], saw2);
	const ansY = await answerCount(phY, a, b);
	const ansZ = await answerCount(phZ, a, b);
	check('(2) A\'s return does NOT replay its own stale ask answer, here or on B',
		!!phY && ranY === 0 && ansY === 0, 'model requests carrying it: ' + ranY + ', answers stored: ' + ansY);
	check('(2) nor its own stale plain prompt',
		!!phZ && ranZ === 0 && ansZ === 0, 'model requests carrying it: ' + ranZ + ', answers stored: ' + ansZ);

	// What the person is offered instead: the hand-off has expired, so the tile says so
	// and offers [Run here], which runs only on a click. Not "Take back", which is the
	// pre-claim control of a hand-off still in flight. Z's chat is the one on screen.
	const tileZ = phZ ? await tileControls(a, phZ.iturn) : null;
	check('(3) the expired hand-off\'s tile offers [Run here] and no take-back',
		Array.isArray(tileZ) && tileZ.includes('Run here') && !tileZ.includes('Take back'),
		'controls on the tile: ' + JSON.stringify(tileZ));

	// (4) The click is what runs it.
	let ranClick = 0, ansClick = 0;
	if (Array.isArray(tileZ) && tileZ.includes('Run here')) {
		const before = modelSaw(P_GOON);
		await a.page.locator('[data-handoff-turn="' + String(phZ.iturn) + '"] .ti-continue',
			{ hasText: 'Run here' }).first().click({ force: true });
		for (let i = 0; i < 60 && !(ranClick && ansClick); i++) {
			await a.page.waitForTimeout(500);
			ranClick = modelSaw(P_GOON) - before;
			ansClick = await answersToPrompt(a, P_GOON);
		}
	}
	check('(4) [Run here] runs the expired hand-off on the click',
		ranClick > 0 && ansClick > 0, 'model requests carrying it: ' + ranClick + ', answers stored: ' + ansClick);

	console.log('\n(6) An expired hand-off that answers a real question: the click asks it again');
	const Q6 = {
		question: 'Which folders should go?',
		options: [
			{ label: 'Unhook the folders', means: 'Detach them from the Diamond.' },
			{ label: 'Keep the folders',   means: 'Leave them where they are.' },
		],
		recommend: 'Keep the folders',
		why:       'Unhooking removes them from every device.',
		if_silent: 'I will keep them.',
	};
	const OPEN_OPT = '#chat-output .ask-card:not(.answered) .ask-opt';
	const SILENT6  = 'Other: ' + Q6.if_silent;	// what the card sends on silence
	await freshChat(a);
	// Asked AND answered five days ago, as the incident's card was: the question is as old
	// as its answer, so the card [Answer again] reopens is a question days old.
	await a.page.evaluate((ms) => {
		const real = Date.now.bind(Date);
		window.__verifyRealNow = real;
		Date.now = () => real() - ms;
	}, FIVE_DAYS);
	await chat(a, '@tool ask ' + JSON.stringify(Q6), { timeout: 60000 });
	const cardUp = await until(a.page, (sel) => !!document.querySelector(sel), OPEN_OPT, 60000);
	check('(6) A shows the question, with its options', cardUp);
	// Answered at a phone's width, so it is handed off and nobody runs it: five days on
	// its errand is gone from the relay, so it is kept off it (`keepErrandsOff`).
	const saw6 = [modelSaw('Chose: Unhook the folders'), modelSaw('Chose: Keep the folders'), modelSaw(SILENT6)];
	const off6 = await keepErrandsOff(a.page);
	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(300);
	if (cardUp) {
		await a.page.locator(OPEN_OPT, { hasText: 'Unhook the folders' }).first().click({ force: true }).catch(() => {});
	}
	let ph6 = null;
	for (let i = 0; i < 120 && cardUp && !ph6; i++) {
		ph6 = placeholders(await storedMsgs(a)).find((m) => m.itext === 'Chose: Unhook the folders') || null;
		if (!ph6) await a.page.waitForTimeout(250);
	}
	await off6.release();
	await a.page.evaluate(() => { if (window.__verifyRealNow) Date.now = window.__verifyRealNow; });
	await settle(a.page);
	check('(6) the answer went out as a hand-off, stamped five days ago', !!ph6,
		ph6 ? JSON.stringify({ iturn: ph6.iturn, ageDays: ((Date.now() - ph6.ts) / 86400000).toFixed(1) }) : 'no placeholder');
	await reload(a);
	const tile6 = ph6 ? await tileControls(a, ph6.iturn) : null;
	// So that "open again" below means the click opened it: before the click the question
	// is drawn answered, its answer standing in the transcript after it.
	const shut6 = await lastCardAnswered(a);
	check('(6) before the click the question is drawn answered, as its stored answer says', shut6 === true,
		'last card answered: ' + shut6);
	check('(6) its tile offers [Answer again] and no [Run here]',
		Array.isArray(tile6) && tile6.includes('Answer again') && !tile6.includes('Run here'),
		'controls on the tile: ' + JSON.stringify(tile6));
	// The click, whatever the tile offers: it must send nothing until the person answers.
	// NOT EVEN ON SILENCE. The idle bound, which answers an open card with its `if_silent`
	// after half an hour untouched, is cut to three seconds for the wait below: a reopened
	// question days old must not answer itself on it, here or on any device it reaches.
	const ctl6 = Array.isArray(tile6) ? (tile6.includes('Answer again') ? 'Answer again' : tile6[0]) : '';
	await a.page.evaluate(() => { window.__daimondDialogIdleMs = 3000; });
	if (ctl6) {
		await a.page.locator('[data-handoff-turn="' + String(ph6.iturn) + '"] .ti-continue',
			{ hasText: ctl6 }).first().click({ force: true }).catch(() => {});
	}
	await a.page.waitForTimeout(10000);
	const ran6 = modelSaw('Chose: Unhook the folders') - saw6[0];
	check('(6) clicking the expired answer\'s tile sends NO model request (no answer without its question)',
		!!ctl6 && ran6 === 0, 'clicked ' + JSON.stringify(ctl6) + ', model requests carrying the answer: ' + ran6);
	const quiet6 = modelSaw(SILENT6) - saw6[2];
	check('(6) nor does silence answer the reopened question: 10 s untouched past a 3 s idle bound',
		!!ctl6 && quiet6 === 0, 'model requests carrying ' + JSON.stringify(SILENT6) + ': ' + quiet6);
	const reopened = await a.page.evaluate((sel) => [...document.querySelectorAll(sel)]
		.map((b) => String((b.querySelector('.ask-label') || b).textContent || '').trim()), OPEN_OPT).catch(() => []);
	await a.page.evaluate(() => { window.__daimondDialogIdleMs = 0; });
	check('(6) and the question is open again, with its options',
		reopened.includes('Unhook the folders') && reopened.includes('Keep the folders'),
		'open options: ' + JSON.stringify(reopened));
	// The person answers it fresh, beside the question, and that is what runs.
	if (reopened.includes('Keep the folders')) {
		await a.page.setViewportSize({ width: 1280, height: 900 });
		await a.page.waitForTimeout(300);
		await a.page.locator(OPEN_OPT, { hasText: 'Keep the folders' }).first().click({ force: true }).catch(() => {});
	}
	let fresh6 = 0;
	for (let i = 0; i < 60 && !fresh6; i++) {
		fresh6 = modelSaw('Chose: Keep the folders') - saw6[1];
		if (!fresh6) await a.page.waitForTimeout(500);
	}
	check('(6) the fresh answer, given beside the question, is what reaches the model',
		fresh6 > 0 && modelSaw('Chose: Unhook the folders') - saw6[0] === 0,
		'requests carrying the fresh answer: ' + fresh6 + ', carrying the old one: ' + (modelSaw('Chose: Unhook the folders') - saw6[0]));
	await settle(a.page);

	// (6b) The same stale answer, and the person presses Retry on it instead: the other
	// control that would send it bare. The last turn's bubble carries Retry, and here the
	// last turn is the hand-off nobody ran.
	console.log('\n(6b) The same shape, and Retry on the answer rather than the tile');
	const Q6B = Object.assign({}, Q6, {
		question: 'Which old folders should go?',
		options: [
			{ label: 'Unhook the old folders', means: 'Detach them from the Diamond.' },
			{ label: 'Keep the old folders',   means: 'Leave them where they are.' },
		],
		recommend: 'Keep the old folders',
	});
	const OLD6B = 'Chose: Unhook the old folders';
	const saw6b = modelSaw(OLD6B);
	await freshChat(a);
	await a.page.evaluate((ms) => {
		const real = Date.now.bind(Date);
		window.__verifyRealNow = real;
		Date.now = () => real() - ms;
	}, FIVE_DAYS);
	await chat(a, '@tool ask ' + JSON.stringify(Q6B), { timeout: 60000 });
	const card6b = await until(a.page, (sel) => !!document.querySelector(sel), OPEN_OPT, 60000);
	const off6b = await keepErrandsOff(a.page);			// five days on, its errand is gone
	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(300);
	if (card6b) {
		await a.page.locator(OPEN_OPT, { hasText: 'Unhook the old folders' }).first().click({ force: true }).catch(() => {});
	}
	let ph6b = null;
	for (let i = 0; i < 120 && card6b && !ph6b; i++) {
		ph6b = placeholders(await storedMsgs(a)).find((m) => m.itext === OLD6B) || null;
		if (!ph6b) await a.page.waitForTimeout(250);
	}
	await off6b.release();
	await a.page.evaluate(() => { if (window.__verifyRealNow) Date.now = window.__verifyRealNow; });
	await settle(a.page);
	await reload(a);
	await a.page.setViewportSize({ width: 1280, height: 900 });
	await a.page.waitForTimeout(300);
	const retry6b = await until(a.page, () => {
		const us = document.querySelectorAll('#chat-output .chat-msg-user');
		return !!(us.length && us[us.length - 1].querySelector('.ctile-retry'));
	}, null, 30000);
	check('(6b) the stale hand-off\'s answer carries Retry, the last turn\'s control', !!ph6b && retry6b,
		ph6b ? 'placeholder ' + ph6b.iturn : 'no placeholder');
	const shut6b = await lastCardAnswered(a);
	check('(6b) and before Retry the question is drawn answered', shut6b === true, 'last card answered: ' + shut6b);
	if (retry6b) {
		await a.page.locator('#chat-output .chat-msg-user').last().locator('.ctile-retry')
			.click({ force: true }).catch(() => {});
	}
	await a.page.waitForTimeout(10000);
	const ran6b = modelSaw(OLD6B) - saw6b;
	const open6b = await a.page.evaluate((sel) => [...document.querySelectorAll(sel)]
		.map((b) => String((b.querySelector('.ask-label') || b).textContent || '').trim()), OPEN_OPT).catch(() => []);
	check('(6b) Retry on the stale answer sends NO model request, and opens the question again',
		retry6b && ran6b === 0 && open6b.includes('Unhook the old folders') && open6b.includes('Keep the old folders'),
		'model requests carrying the old answer: ' + ran6b + ', open options: ' + JSON.stringify(open6b));
	await settle(a.page);

	console.log('\n(5) A fresh hand-off A sent, its errand gone, and B comes back inside the deadline');
	await b.close(); b = null;
	const saw5 = [modelSaw('fresh orphan whose errand is gone')];
	const phO = await sendAgo(a, P_ORPHAN, 0);
	const ageO = phO ? Date.now() - Number(phO.ts) : -1;
	check('(5) A holds a fresh hand-off of its own, minutes inside its deadline',
		!!phO && phO.dispatchedBy === idA && ageO >= 0 && ageO < 5 * 60000,
		phO ? JSON.stringify({ iturn: phO.iturn, ageS: Math.round(ageO / 1000), byA: phO.dispatchedBy === idA }) : 'no placeholder');
	// The errand leaves the relay: A collects the row, lets go of its own hold on it and
	// acks, so no device can collect it again -- what a replay that failed leaves.
	const gone = phO ? await a.page.evaluate(async (tid) => {
		const P = window.DaimondPost;
		const c = await P.collect().catch((e) => ({ err: String(e) }));
		const st = await P.settle(tid).catch((e) => ({ err: String(e) }));
		const ak = await P.ack().catch((e) => ({ err: String(e) }));
		return { collected: !!c && !c.err, settled: st, acked: ak };
	}, String(phO.iturn)) : null;
	console.log('  ..    errand off the relay: ' + JSON.stringify(gone));
	await settle(a.page);
	await a.page.evaluate(() => window.DaimondSync.flush && window.DaimondSync.flush()).catch(() => {});
	await a.close(); a = null;
	check('(5) nothing ran it while B was away (so what follows is B\'s doing)',
		modelSaw('fresh orphan whose errand is gone') - saw5[0] === 0);
	b = await reopen({ name: 'nrmate', account: 'nrlead' });
	let bHasO = false;
	for (let i = 0; i < 60 && phO && !bHasO; i++) {
		await b.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
		bHasO = placeholders(await storedMsgs(b)).some((m) => String(m.iturn) === String(phO.iturn));
		if (!bHasO) await b.page.waitForTimeout(500);
	}
	check('(5) B holds A\'s fresh placeholder, synced from A', bHasO);
	await reload(b);
	const [ranO] = await returnAndWatch(b, ['fresh orphan whose errand is gone'], saw5);
	const ansO = await answerCount(phO, b);
	const reO  = phO ? await errandsFor(b, phO.iturn) : -1;
	const ageB = phO ? Date.now() - Number(phO.ts) : -1;
	check('(5) B\'s return inside the deadline does NOT run A\'s fresh orphan, nor hand it on',
		!!phO && bHasO && ranO === 0 && ansO === 0 && reO === 0 && ageB < 15 * 60000,
		'model requests carrying it: ' + ranO + ', answers stored: ' + ansO + ', errands for it on the relay: '
		+ reO + ', age at the return: ' + Math.round(ageB / 1000) + 's');

	console.log('\n(7) A question five days old, drawn again after a reload, and nobody touches the page');
	const Q7 = {
		question: 'Should the old drafts go?',
		options: [
			{ label: 'Archive the drafts', means: 'Move them out of the Diamond.' },
			{ label: 'Leave the drafts',   means: 'Keep them where they are.' },
		],
		recommend: 'Leave the drafts',
		why:       'Archiving moves them off every device.',
		if_silent: 'I will archive the drafts myself.',
	};
	const Q7N = Object.assign({}, Q7, { question: 'Should the new notes go?',
		if_silent: 'I will tidy the new notes myself.' });
	const SILENT7 = 'Other: ' + Q7.if_silent, SILENT7N = 'Other: ' + Q7N.if_silent;
	const saw7 = [modelSaw(SILENT7), modelSaw(SILENT7N)];
	await freshChat(b);
	await b.page.evaluate((ms) => {
		const real = Date.now.bind(Date);
		window.__verifyRealNow = real;
		Date.now = () => real() - ms;
	}, FIVE_DAYS);
	await chat(b, '@tool ask ' + JSON.stringify(Q7), { timeout: 60000 });
	const card7 = await until(b.page, (sel) => !!document.querySelector(sel), OPEN_OPT, 60000);
	await b.page.evaluate(() => { if (window.__verifyRealNow) Date.now = window.__verifyRealNow; });
	// The idle bound cut to three seconds from the page's first script, so the card drawn
	// at boot is armed (or not) with it. The reload is what a device coming back does: the
	// question is drawn from the stored transcript, five days after it was asked.
	await b.page.context().addInitScript(() => { window.__daimondDialogIdleMs = 3000; });
	await reload(b);
	const drawn7 = await until(b.page, (sel) => !!document.querySelector(sel), OPEN_OPT, 60000);
	check('(7) B asked a question five days ago and draws it open again after its reload', card7 && drawn7);
	await b.page.waitForTimeout(15000);
	const ran7 = modelSaw(SILENT7) - saw7[0];
	const open7 = await b.page.evaluate((sel) => !!document.querySelector(sel), OPEN_OPT).catch(() => false);
	check('(7) the five-day-old question does NOT answer itself on silence (15 s untouched, 3 s bound)',
		drawn7 && ran7 === 0 && open7,
		'model requests carrying ' + JSON.stringify(SILENT7) + ': ' + ran7 + ', card still open: ' + open7);
	// THE CONTROL: the same page, the same three seconds, a question asked now. It must still
	// answer itself, or a pass above could be a bound that never arms at all.
	await freshChat(b);
	await chat(b, '@tool ask ' + JSON.stringify(Q7N), { timeout: 60000 });
	let ran7n = 0;
	for (let i = 0; i < 60 && !ran7n; i++) {
		ran7n = modelSaw(SILENT7N) - saw7[1];
		if (!ran7n) await b.page.waitForTimeout(500);
	}
	check('(7) control: a question asked now still answers itself after the (3 s) idle bound',
		ran7n > 0, 'model requests carrying ' + JSON.stringify(SILENT7N) + ': ' + ran7n);

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	try { await a?.close(); } catch (e) {}
	try { await b?.close(); } catch (e) {}
}
process.exit(bad.length ? 1 : 0);
