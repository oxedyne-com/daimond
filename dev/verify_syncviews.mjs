// verify_syncviews.mjs — two views of one account, and whether they agree.
//
// Sync converging is not the same question as a PERSON seeing it converge. Every
// check in dev/verify_sync.mjs either drives the engine by hand or leans on the
// wake channel, and the wake channel is a WebSocket — or a parked request —
// through whatever front door the account is reached by. Where that door will not
// carry one, sync.js turns the channel off for the life of the page, and what is
// left is triggers that all describe something happening HERE. A window nobody is
// typing at has none of them.
//
// That was reported twice, from a real account, as two different faults:
//
//   * turns taken in one desktop browser did not appear in the other, and
//   * the token cost tallies in the rail's footer showed two different figures
//     in two views of the same account.
//
// Both are the one thing: the reading device never asked. So this file runs the
// second device with the channel deliberately shut — the park is answered as a
// front door that dropped the query, which is exactly what sync.js gives up on —
// and then touches it only in the ways a person does.
//
// It needs the dev stack: the app (DAIMOND_PORT), the mock provider, and a
// gateway on DAIMOND_GW_PORT. Sync is Pro-gated, so the account is granted Pro
// the one way the gateway trusts (dev/pro.mjs).

import { open, chat, signInAs, newChat } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Answer this page's wake parks as a front door that dropped the query.
///
/// `waited` is how sync.js tells a real park from an ordinary pull served in its
/// place, so an answer without it is the one thing that shuts the channel for
/// good. Plain pulls carry no `ms` and are passed straight through.
const shutTheChannel = (page) => page.route(
	(u) => {
		try { const x = new URL(u); return x.pathname === '/api/sync' && x.searchParams.has('ms'); }
		catch (e) { return false; }
	},
	(r) => r.fulfill({
		status: 200, contentType: 'application/json',
		body: JSON.stringify({ ok: true, present: false }),
	}));

/// Every chat this device's store holds, id → turns in it.
const census = (pg) => pg.evaluate(() => {
	const out = {};
	window.DaimondCore.chatStore().stored().forEach((c) => { out[c.id] = (c.messages || []).length; });
	return out;
});
const turns = async (pg, id) => (await census(pg))[id] || 0;

/// The conversation as it is drawn, which is the only copy the user can read.
const onScreen = (pg) => pg.evaluate(() => {
	const e = document.getElementById('chat-output');
	return e ? e.innerText : '';
});

/// The rail's footer, as it reads.
///
/// '(hidden)' while there is nothing to show, and `(nothing yet)` where the row
/// is on screen carrying no figure at all.
///
/// The second is the one that matters now. The row used to hide itself while
/// every total was zero, so "is it on screen" happened to answer "has anything
/// been spent"; it is permanent since 2026-08-28 (see `updateSpend` in
/// js/daimond.js -- a row that came and went was moving the rail's controls),
/// and the two checks below ask whether a tally TRAVELLED. Two views both
/// reading $0.00 would satisfy an is-it-there test while proving nothing.
const footer = (pg) => pg.evaluate(() => {
	const e = document.getElementById('spend-row');
	if (!e || e.style.display === 'none') return '(hidden)';
	const said = e.innerText.replace(/\s+/g, ' ').trim();
	return /[1-9]/.test(said) ? said : '(nothing yet)';
});
/// Has this view a tally worth comparing at all?
const tallied = (said) => said !== '(hidden)' && said !== '(nothing yet)';

const version = (pg) => pg.evaluate(() => window.DaimondSync.state().version);
const wake    = (pg) => pg.evaluate(() => window.DaimondSync.wake());

/// Does the mailbox hold a parcel THIS device produced? Read-only: nothing here
/// pushes, so a check that waits on this is waiting on the app's own triggers.
const mailboxIsMine = (pg) => pg.evaluate(async () => {
	const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
	const j = await r.json();
	if (!j.present) return false;
	try { return (await window.DaimondIdentity.unwrap(j.blob)) === JSON.stringify(await window.DaimondSync.parcel()); }
	catch (e) { return false; }
});

/// Wait until this device's own work has reached the mailbox, by its own doing.
const sent = async (pg, ms = 25000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await mailboxIsMine(pg)) return true;
		await pg.waitForTimeout(400);
	}
	return false;
};

/// Wait for a chat on `pg` to hold `want` turns, and answer with what it holds.
/// Bounded, and it returns what it last read rather than throwing, so a check
/// fails with the number it actually found.
const turnsSettle = async (pg, id, want, ms) => {
	const t0 = Date.now();
	let seen = 0;
	do {
		seen = await turns(pg, id);
		if (seen >= want) return seen;
		await pg.waitForTimeout(500);
	} while (Date.now() - t0 < ms);
	return seen;
};

const a = await open({ name: 'views', signIn: true, connect: true, defaults: false });
let b = null;
try {
	await a.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondCore && window.DaimondGateway
			&& DaimondGateway.state().authed,
		null, { timeout: 15000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('the account holds Pro, so sync can run at all', pro.pro === true, JSON.stringify(pro));

	// Plain pulls this device makes of its own accord, so check (5) can say
	// whether a working channel was turned into a poll.
	let aPulls = 0;
	a.page.on('request', (r) => {
		try {
			const u = new URL(r.url());
			if (u.pathname === '/api/sync' && r.method() === 'GET' && !u.searchParams.has('ms')) aPulls++;
		} catch (e) { /* not a URL this counts */ }
	});

	const chatId = await newChat(a);
	await chat(a, 'ALPHA in the first browser');
	check('the first browser sends its own work without being asked', await sent(a.page));

	// ── The second view: a browser of its own, with no channel ─────────
	b = await open({ name: 'viewsmate', signIn: false, connect: false });
	await shutTheChannel(b.page);
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'views');
	await b.page.waitForFunction(
		() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	await turnsSettle(b.page, chatId, 3, 15000);
	// The channel does not decide it is out until its first park comes back
	// unparked, which is a request in flight at this moment. Waited for, or the
	// check below reads the channel mid-probe and reports a mode of ''.
	await b.page.waitForFunction(
		() => window.DaimondSync.wake().mode === 'off', null, { timeout: 20000 }).catch(() => {});
	const shut = await wake(b.page);
	check('the second view is running with no wake channel, as a shut front door leaves it',
		shut.mode === 'off' && shut.open === false, JSON.stringify(shut));
	check('and it has the first browser’s work to begin with',
		(await turns(b.page, chatId)) >= 3, String(await turns(b.page, chatId)));

	// ── (1) Nobody touches it ──────────────────────────────────────────
	// The whole complaint. The second window is open on a desk, focused, and
	// its owner is typing in the other browser. No focus event, no turn ending,
	// nothing renamed: the engine's own catch-up is the only thing that can
	// bring it level, and until it existed nothing did.
	const had = await turns(b.page, chatId);
	await chat(a, 'BETA in the first browser');
	check('the first browser sends the second turn too', await sent(a.page));
	const learned = await turnsSettle(b.page, chatId, had + 3, 45000);
	check('a second view nobody touches catches up on its own',
		learned >= had + 3, learned + ' turns, was ' + had);
	// And the footer with it, WITHOUT a refresh. This is the second report in
	// its own words: the tallies are built from the ledger, the ledger travels
	// in the same parcel as the transcripts, so a view that is behind on one is
	// behind on the other. Measured here rather than after the refresh below,
	// where a pull is guaranteed and the check would prove nothing.
	const fa1 = await footer(a.page);
	let fb1 = await footer(b.page);
	for (let i = 0; i < 30 && fb1 !== fa1; i++) { await b.page.waitForTimeout(500); fb1 = await footer(b.page); }
	check('and its token cost tally follows, with no refresh and nothing touched',
		fb1 === fa1 && tallied(fa1), JSON.stringify(fa1) + ' vs ' + JSON.stringify(fb1));

	// ── (2) Coming back to the window ──────────────────────────────────
	// The trigger a person actually uses, and the one they use OFTEN: working
	// in one browser and glancing at the other is a thing done all afternoon.
	// So the return is made TWICE — once to arm whatever throttle stands behind
	// it, and once a few seconds later with news waiting. The second is the one
	// that matters, and it is the one a person makes.
	await b.page.evaluate(() => {
		window.dispatchEvent(new Event('focus'));
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await b.page.waitForTimeout(3000);
	await chat(a, 'GAMMA in the first browser');
	check('the first browser sends the third turn too', await sent(a.page));
	const hadG = await turns(b.page, chatId);
	const moved = await b.page.evaluate(async () => {
		const v0 = window.DaimondSync.state().version;
		window.dispatchEvent(new Event('focus'));
		document.dispatchEvent(new Event('visibilitychange'));
		await new Promise((r) => setTimeout(r, 6000));
		return { v0, v1: window.DaimondSync.state().version };
	});
	const gotG = await turns(b.page, chatId);
	check('coming back to the second window pulls, seconds after the last time',
		gotG >= hadG + 3,
		'version ' + moved.v0 + ' -> ' + moved.v1 + ', ' + gotG + ' turns, was ' + hadG);

	// ── (3) The hard refresh, and what is ON SCREEN ────────────────────
	// The store agreeing is not the claim; the claim is that the person reading
	// the conversation sees the turns. A refresh is what the reporter reached
	// for, so a refresh is what is measured.
	await chat(a, 'DELTA in the first browser');
	check('the first browser sends the fourth turn too', await sent(a.page));
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await shutTheChannel(b.page);
	await signInAs(b, 'views');
	await b.page.waitForFunction(
		() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	await turnsSettle(b.page, chatId, 12, 25000);
	let drawn = '';
	for (let i = 0; i < 24; i++) {
		drawn = await onScreen(b.page);
		if (/DELTA/.test(drawn)) break;
		await b.page.waitForTimeout(500);
	}
	check('a refresh brings the second view level, on the screen and not merely in the store',
		/ALPHA/.test(drawn) && /DELTA/.test(drawn), JSON.stringify(drawn.slice(-90)));

	// ── (4) The two footers ────────────────────────────────────────────
	// The tallies are built from the ledger, and the ledger travels in the same
	// parcel as the transcripts. So a view that is behind on one is behind on
	// the other, and the report of two different figures is this same fault
	// wearing the footer's clothes.
	const fa = await footer(a.page);
	let fb = await footer(b.page);
	for (let i = 0; i < 24 && fb !== fa; i++) { await b.page.waitForTimeout(500); fb = await footer(b.page); }
	check('the two views show the same token cost tally', fa === fb && tallied(fa),
		JSON.stringify(fa) + ' vs ' + JSON.stringify(fb));

	// ── (5) And a device that CAN be told is not made to poll ───────────
	// The catch-up above must cost nothing on a device the gateway can reach.
	// A pull every so often on every open tab is a real bill on a real account,
	// so the guard is here rather than in a comment. The wake channel's own
	// pulls are subtracted: those are the gateway saying there is something to
	// fetch, which is the opposite of a poll.
	const chan = await wake(a.page);
	const was  = aPulls;
	await a.page.waitForTimeout(35000);
	const after = await wake(a.page);
	const unprompted = (aPulls - was) - (after.wakes - chan.wakes);
	check('a device whose channel is carrying does not start polling for itself',
		chan.open === true && unprompted <= 0,
		'channel ' + chan.mode + (chan.open ? '/open' : '/shut') + ', ' + (aPulls - was)
			+ ' pulls in 35s of which ' + (after.wakes - chan.wakes) + ' were the gateway asking');
} catch (e) {
	check('the run finished', false, String((e && e.stack) || e));
} finally {
	if (b) await b.close();
	await a.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { for (const l of bad) console.log('  FAILED: ' + l); }
process.exit(bad.length ? 1 : 0);
