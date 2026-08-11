// verify_sessionrenew.mjs — a gateway session that ends mid-sitting is taken
// again, without a reload; and when it cannot be, the user is told and the
// device stops hammering the door.
//
// THE BUG THIS EXISTS FOR. The gateway's session lives exactly an hour
// (SESSION_TTL_SECS, gateway/src/handlers/common.rs) and the only thing that
// ever minted one was `DaimondGateway.bootstrap()`, called once per unlock. So
// an hour into a sitting every request became a 401, and every path swallowed
// it: the pull hid the chip, the push logged one console line, the wake channel
// reconnected on a backoff for ever, and the account dot went on being drawn
// from `state.authed`, which nothing ever cleared. One real account: session
// opened 07:27:28, gone at 08:27:30, then four hours and fifty minutes of
// refused wake upgrades at about two hundred and forty an hour, and seven
// pushes of the user's work discarded with nothing said anywhere.
//
// HOW HONESTLY THIS REPRODUCES IT. The session is ended SERVER-SIDE with a raw
// POST to /api/auth/logout — not `DaimondGateway.logout()`, which would tell the
// client. That leaves precisely the production state: a live page that believes
// it is signed in, holding a cookie that names nothing. Everything below runs
// against the REAL gateway on :9002 over that state.
//
//   1. The client does not notice by itself — asserted, so that a pass below
//      cannot come from the session having quietly survived.
//   2. A push after the session died lands anyway: the version advances, the
//      work is in the mailbox, and the PAGE WAS NEVER RELOADED (a marker set
//      before the kill is still in the window).
//   3. One renewal, however many callers were refused at once.
//   4. When the renewal cannot work, the chip says so — held, with the reason on
//      hover, and no dialog over the app — and the app stops claiming a session
//      it does not have.
//   5. The wake channel STOPS. That is the free consequence of clearing
//      `state.authed`, and it is measured rather than assumed: no /api/sync
//      request and no new WebSocket after the teardown.
//   6. And it comes back on its own. A gateway that was down for a minute must
//      not cost the tab the rest of the day, because every trigger that would
//      retry is itself gated on there being a session.
//   7. The standing refusals keep their order: a parcel that will not fit is
//      true whatever the session is doing, so it is still the thing said first.
import { open, chat } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Is the gateway answering?
async function gatewayUp() {
	try {
		const r = await fetch('http://127.0.0.1:9002/api/health', { signal: AbortSignal.timeout(2000) });
		return r.ok;
	} catch (e) { return false; }
}

if (!await gatewayUp()) {
	console.log('SKIP verify_sessionrenew — no gateway on :9002 (build it: cd gateway && cargo build --release)');
	process.exit(0);
}

const s = await open({ name: 'sessrenew', signIn: true, connect: true });
const { page } = s;

/// Push, and wait until the parcel has actually LANDED. A single push() that
/// finds another in flight only reschedules, so awaiting it proves nothing.
async function pushLanded(pg, ms = 8000) {
	return await pg.evaluate(async (limit) => {
		const v0 = window.DaimondSync.state().version;
		const t0 = Date.now();
		while (window.DaimondSync.state().version <= v0 && Date.now() - t0 < limit) {
			await window.DaimondSync.push();
			await new Promise(r => setTimeout(r, 150));
		}
		return window.DaimondSync.state().version > v0;
	}, ms);
}

/// End the session on the GATEWAY without telling the client — what an expiry
/// looks like from inside the page.
const killSession = () => page.evaluate(async () => {
	await window.__realFetch('/api/auth/logout', {
		method: 'POST', credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
	});
});

/// A genuine local change, so a push is not skipped as a no-op.
///
/// A message-tombstone for an id that never existed. Transcripts moved into
/// IndexedDB, so the old trick of editing `daimond-chats` in localStorage no
/// longer changes anything `collectSync()` reads; the tombstone maps are still
/// localStorage and still travel in the parcel. Inert by construction — it names
/// nothing — so it moves the parcel and touches no work.
const bump = tag => page.evaluate((t) => {
	const k = 'daimond-msgs-deleted';
	const m = JSON.parse(localStorage.getItem(k) || '{}');
	m['ghost-' + t] = Date.now();
	localStorage.setItem(k, JSON.stringify(m));
	return true;
}, tag);

const chipOf = () => page.evaluate(() => {
	const c = document.getElementById('sync-chip');
	if (!c) return null;
	return {
		state: c.dataset.state || '',
		text:  (c.querySelector('.stext') || {}).textContent || '',
		title: c.title || '',
		shown: c.style.display !== 'none',
	};
});

try {
	await page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondCore && !!window.DaimondGateway
			&& DaimondGateway.state().authed,
		null, { timeout: 12000 },
	).catch(() => {});
	check('a gateway session exists to begin with',
		await page.evaluate(() => DaimondGateway.state().authed));

	// Sync is a Pro capability, so without the licence the gateway answers 402
	// and there is no 401 to measure.
	const GWDIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gateway');
	const lic = await makePagePro(page, GWDIR);
	check('the account holds Pro, so sync may run at all', lic.pro === true,
		`webhook ${lic.status}, pro=${lic.pro}`);

	// Something real to lose, and a first parcel in the mailbox.
	await chat(s, 'Remember the codeword SESSMARK-1 for later.');
	await pushLanded(page);

	// Instruments: how many sessions were minted, how many /api/sync requests
	// were made, and how many WebSockets were opened. `__realFetch` is kept back
	// so this file can ask the gateway things without its own questions landing
	// in its own counters.
	//
	// `__sessRenewPage` is what says the recovery below happened in THIS page. A
	// reload would take it with it, and "recovered after a reload" is not a fix,
	// it is the workaround the user already had.
	await page.evaluate(() => {
		window.__sessRenewPage = 'alive';
		window.__gw = { verify: 0, account: 0, sync: 0, socket: 0 };
		const real = window.fetch;
		window.__realFetch = real;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/auth/verify') !== -1) window.__gw.verify++;
			if (url.indexOf('/api/account')     !== -1) window.__gw.account++;
			if (url.indexOf('/api/sync')        !== -1) window.__gw.sync++;
			return real.apply(this, arguments);
		};
		const WS = window.WebSocket;
		window.WebSocket = function (url, p) { window.__gw.socket++; return p ? new WS(url, p) : new WS(url); };
		window.WebSocket.prototype = WS.prototype;
	});
	// The wake channel is a caller like any other, and it would mint a session of
	// its own in the middle of the two measurements below. It is turned off for
	// them and brought back at (5), which is where it is the thing under test.
	await page.evaluate(() => window.DaimondSync.wakeVia('off'));

	// ── (1) The client does not notice ─────────────────────────────────
	await killSession();
	const unaware = await page.evaluate(async () => {
		const r = await window.__realFetch('/api/sync', {
			credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
		});
		return { status: r.status, authed: DaimondGateway.state().authed };
	});
	check('the session really is gone on the gateway (a bare /api/sync is 401)',
		unaware.status === 401, 'status=' + unaware.status);
	check('and the page still believes it is signed in — which is the bug',
		unaware.authed === true);

	// ── (2) Sync recovers, in the same page ────────────────────────────
	const before = await page.evaluate(() => ({
		version: window.DaimondSync.state().version, verify: window.__gw.verify,
	}));
	// Real work, made AFTER the session died: a turn through the model, appended
	// to a transcript and persisted exactly as a user's would be. A synthetic
	// edit would prove the request recovered; this proves the WORK travelled.
	const MARK2 = 'SESSMARK-' + '2';
	await chat(s, 'And remember the codeword ' + MARK2 + ' too.');
	const landed = await pushLanded(page, 15000);
	const after = await page.evaluate(async () => {
		const r = await window.__realFetch('/api/sync', {
			credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
		});
		const j = r.status === 200 ? await r.json() : {};
		let plain = '';
		try { plain = await window.DaimondIdentity.unwrap(j.blob); } catch (e) { plain = ''; }
		return {
			version:  j.version | 0,
			carries:  plain,
			// `state.authed` is what the app SAYS, and it is what was lying before
			// the fix -- so it is not evidence on its own. The status of a request
			// the gateway actually served is.
			authed:   DaimondGateway.state().authed,
			served:   r.status,
			verify:   window.__gw.verify,
			pageSame: window.__sessRenewPage === 'alive',
		};
	});
	check('a push after the session died still lands — the version advances',
		landed && after.version > before.version,
		'version ' + before.version + ' -> ' + after.version);
	check('and the mailbox really holds the work that was pushed over the dead session',
		after.carries.indexOf(MARK2) !== -1,
		after.carries ? 'blob opened, ' + after.carries.length + ' bytes' : 'blob did not open');
	check('the client is signed in again, without anybody asking it to be',
		after.authed === true && after.served === 200,
		'authed=' + after.authed + ' /api/sync=' + after.served);
	check('one session was taken to do it, not one per refused request',
		after.verify - before.verify === 1, (after.verify - before.verify) + ' /api/auth/verify calls');
	check('and it was the SAME page throughout — no reload',
		after.pageSame === true);

	// ── (3) One renewal, however many callers are refused at once ──────
	await killSession();
	const flight = await page.evaluate(async () => {
		const v0 = window.__gw.verify;
		// Four independent gateway reads, all of which believe there is a session
		// and all of which are about to be told there is not.
		await Promise.all([
			DaimondGateway.refreshBalance(),
			DaimondGateway.refreshLicence(),
			DaimondGateway.ledger(),
			DaimondGateway.autoReload(),
		]);
		const r = await window.__realFetch('/api/sync', {
			credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
		});
		return { minted: window.__gw.verify - v0, authed: DaimondGateway.state().authed, served: r.status };
	});
	check('four callers refused in the same moment mint ONE session between them',
		flight.minted === 1, flight.minted + ' minted');
	check('and all four end up on a session the gateway will actually serve',
		flight.authed === true && flight.served === 200,
		'authed=' + flight.authed + ' /api/sync=' + flight.served);

	// ── (4) When it cannot be renewed, the user is told ────────────────
	// The session is ended AND the way back is blocked, which is what a gateway
	// that is down, a revoked binding or a network that has gone all look like.
	// The engine must not go quiet about it.
	//
	// The wake channel is brought back first, because (5) measures it going away
	// and a channel that was never open proves nothing.
	await page.evaluate(() => window.DaimondSync.wakeVia(''));
	await page.waitForFunction(() => window.DaimondSync.wake().open === true,
		null, { timeout: 20000 }).catch(() => {});
	const chanUp = await page.evaluate(() => window.DaimondSync.wake());
	check('the wake channel is open before the session is taken away',
		chanUp.open === true, JSON.stringify(chanUp));

	await killSession();
	const told = await page.evaluate(async () => {
		const gated = window.fetch;
		// Only the authentication is blocked; /api/sync answers its honest 401.
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/auth/') !== -1 || url.indexOf('/api/account') !== -1) {
				return Promise.reject(new TypeError('blocked for the test'));
			}
			return gated.apply(this, arguments);
		};
		window.__unblock = function () { window.fetch = gated; };
		await window.DaimondSync.pull();
		await new Promise(r => setTimeout(r, 200));
		const c = document.getElementById('sync-chip');
		const modals = [...document.querySelectorAll('.modal')]
			.filter(m => getComputedStyle(m).display !== 'none')
			.map(m => (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60));
		// A bland title, read back out of the same attribute by the same path, so the
		// hover check below can be shown going red. Set and restored with no await
		// between, so no repaint of the chip can land in the gap and nothing else in
		// this run can see it.
		let blinded = null;
		if (c) {
			const was = c.title;
			c.title = 'Sync paused.';
			blinded = document.getElementById('sync-chip').title;
			c.title = was;
		}
		return {
			chip:   c ? { state: c.dataset.state || '', text: (c.querySelector('.stext') || {}).textContent || '',
				title: c.title || '', shown: c.style.display !== 'none' } : null,
			blinded: blinded,
			api:    window.DaimondSync.state(),
			authed: DaimondGateway.state().authed,
			modals: modals,
		};
	});
	check('a session that cannot be renewed puts a held, stalled state on the chip',
		!!(told.chip && told.chip.shown && told.chip.state === 'stalled'),
		JSON.stringify(told.chip));
	// ── What the hover has to carry ────────────────────────────────────
	//
	// A chip that says only "Sync paused" tells a person their work has stopped and
	// nothing else. The hover owes them two facts: WHY it stopped — this device has no
	// session — and WHAT HAPPENS NEXT, so that they know whether to sit still or act.
	//
	// Those two facts are the property; the sentence is not. This matched `signed in`
	// literally and went red on 2026-08-11 when a concision pass turned "no longer signed
	// in to" into "signed out of" — the same two facts, better said. Each fact is now
	// asked for in any of the ways English states it.
	const HOVER = {
		'that this device has no session':
			/signed[- ]out|not signed in|no longer signed in|could not sign in|cannot sign in|signed in again/i,
		'what happens next':
			/resume|comes? back|carry on|carries on|will sign in|starts? again|picks? up again|as soon as/i,
	};
	const hoverSays = (s) => Object.entries(HOVER).filter(([, re]) => !re.test(String(s || ''))).map(([k]) => k);
	const hoverGaps = hoverSays(told.chip && told.chip.title);
	check('and the hover says the device is not signed in, and what happens next',
		!!(told.chip && told.chip.title) && hoverGaps.length === 0,
		hoverGaps.length ? 'the hover never says: ' + hoverGaps.join('; ') + ' — '
				+ (told.chip && told.chip.title || '').replace(/\n/g, ' | ').slice(0, 160)
			: (told.chip && told.chip.title || '').replace(/\n/g, ' | ').slice(0, 160));
	check('and that is a check that can fail — a hover saying only “paused” is caught',
		told.blinded !== null && hoverSays(told.blinded).length === Object.keys(HOVER).length
			&& told.chip.title !== told.blinded,
		told.blinded === null ? 'there was no chip to blind'
			: '“' + told.blinded + '” is missing both facts');
	check('the engine reports it through its own surface, named',
		!!(told.api && told.api.stalled === true && told.api.stalledWhy === 'signed_out'
			&& told.api.sessionGone === true),
		JSON.stringify({ stalled: told.api.stalled, why: told.api.stalledWhy }));
	check('the app stops claiming to be connected', told.authed === false);
	check('and nothing was raised over the app — nobody asked for the round that failed',
		told.modals.length === 0, told.modals.join(' | '));

	// ── (5) The wake channel stops hammering ───────────────────────────
	// `ready()` is false the moment `state.authed` is cleared, so `wakeWanted()`
	// is false and the supervisor tears the channel down on its next tick. That
	// is the difference between a device that is quiet and one that is refused an
	// upgrade every fifteen seconds for five hours.
	await page.waitForFunction(() => window.DaimondSync.wake().open === false,
		null, { timeout: 25000 }).catch(() => {});
	const quiet0 = await page.evaluate(() => ({
		wake: window.DaimondSync.wake(), sync: window.__gw.sync, socket: window.__gw.socket,
	}));
	check('the wake channel that WAS open is shut once there is no session',
		chanUp.open === true && quiet0.wake.open === false, JSON.stringify(quiet0.wake));
	await sleep(8000);
	const quiet1 = await page.evaluate(() => ({
		wake: window.DaimondSync.wake(), sync: window.__gw.sync,
		socket: window.__gw.socket, account: window.__gw.account,
	}));
	check('and it stays shut: no /api/sync request in the eight seconds after',
		quiet1.sync === quiet0.sync, quiet0.sync + ' -> ' + quiet1.sync);
	check('and no further WebSocket upgrade is attempted',
		quiet1.socket === quiet0.socket, quiet0.socket + ' -> ' + quiet1.socket);
	check('the standing retry that will bring it back is bounded, not a spin',
		quiet1.account <= 8, quiet1.account + ' /api/account attempts in all');

	// ── (6) And it comes back on its own ───────────────────────────────
	// Nothing else in the app would ever ask again: every trigger is gated on
	// there being a session, so without a retry of its own the tab is signed out
	// until somebody reloads it.
	await page.evaluate(() => { window.__unblock(); });
	// Asked of the GATEWAY, not of `state.authed`: the flag was the thing lying
	// before the fix, so a live session is the only honest evidence.
	let back = null;
	for (let i = 0; i < 45 && !(back && back.authed && back.served === 200); i++) {
		await sleep(2000);
		back = await page.evaluate(async () => {
			const r = await window.__realFetch('/api/sync', {
				credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
			});
			return { authed: DaimondGateway.state().authed, served: r.status };
		});
	}
	check('the tab signs itself back in once the way is open again, unprompted',
		!!(back && back.authed === true && back.served === 200), JSON.stringify(back));
	await bump('SESSMARK-3');
	const moved = await pushLanded(page, 15000);
	const healed = await page.evaluate(() => ({
		api: window.DaimondSync.state(), pageSame: window.__sessRenewPage === 'alive',
	}));
	check('and pushes again once it has', moved === true, 'version ' + healed.api.version);
	check('the standing refusal is cleared, not left over a working engine',
		healed.api.sessionGone === false && healed.api.stalledWhy !== 'signed_out',
		JSON.stringify({ why: healed.api.stalledWhy }));
	check('still the same page — the whole recovery needed no reload',
		healed.pageSame === true);
	const chipEnd = await chipOf();
	check('the chip does not sit on a stall the engine has cleared',
		!!(chipEnd && (chipEnd.state === 'synced' || !chipEnd.shown)), JSON.stringify(chipEnd));

	// ── (7) The standing refusals keep their order ─────────────────────
	// A parcel over the gateway's ceiling is a state of the parcel, true whatever
	// the session is doing, and a person cannot act on it by signing in. So it
	// stays on the chip when the session goes as well. The 413 is stubbed: the
	// real ceiling is 32 MB and building that to test a status chip would cost
	// more than the behaviour it proves.
	await page.evaluate(() => window.DaimondSync.wakeVia('off'));
	await bump('rank-1');
	const ranked = await page.evaluate(async () => {
		const gated = window.fetch;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/sync') !== -1 && o && o.method === 'POST') {
				return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'too large' }),
					{ status: 413, headers: { 'content-type': 'application/json' } }));
			}
			return gated.apply(this, arguments);
		};
		await window.DaimondSync.push();
		const c = () => {
			const e = document.getElementById('sync-chip');
			return e ? { state: e.dataset.state || '', title: e.title || '', shown: e.style.display !== 'none' } : null;
		};
		const big = c();
		// Now take the session away underneath it, and block the way back.
		await window.__realFetch('/api/auth/logout', {
			method: 'POST', credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
		});
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/auth/') !== -1 || url.indexOf('/api/account') !== -1) {
				return Promise.reject(new TypeError('blocked for the test'));
			}
			return gated.apply(this, arguments);
		};
		await window.DaimondSync.pull();
		await new Promise(r => setTimeout(r, 200));
		const both = c();
		const api = window.DaimondSync.state();
		window.fetch = gated;
		return { big, both, api };
	});
	check('a 413 stalls the chip on its own', !!(ranked.big && ranked.big.state === 'stalled'
		&& /too large/i.test(ranked.big.title)), JSON.stringify(ranked.big).slice(0, 120));
	check('and a session going as well does not push the parcel refusal off the chip',
		!!(ranked.both && /too large/i.test(ranked.both.title) && !/signed in/i.test(ranked.both.title)),
		(ranked.both && ranked.both.title || '').replace(/\n/g, ' | ').slice(0, 140));
	check('the engine names the same one first', ranked.api.stalledWhy === 'too_big',
		ranked.api.stalledWhy + ' (sessionGone=' + ranked.api.sessionGone + ')');
	check('while still knowing the session is gone underneath it',
		ranked.api.sessionGone === true);

	// Console noise from a deliberately refused round is expected; anything else
	// is not.
	const errs = s.errs.filter(e =>
		!/favicon|ERR_|Failed to load resource|401|402|409|413|426|502|Unauthorized|blocked for the test/.test(e)
		&& !/WebSocket connection to '[^']*\/api\/sync\/ws/.test(e));
	check('no unexpected console errors through the whole recovery', errs.length === 0,
		errs.slice(0, 3).join(' | '));
} finally {
	await s.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
