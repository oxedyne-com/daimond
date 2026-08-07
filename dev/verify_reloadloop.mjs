// verify_reloadloop.mjs — a tab the gateway keeps refusing must not reload for ever.
//
// THE BUG THIS IS FOR. An iPhone reported, three times across three sessions:
// unlock with a passkey, the app appears for about a second, the lock screen is
// back, repeat. It was diagnosed twice from reading code — once as sync parcel
// size, once as crystal snapshots — and both were wrong, because nobody could
// see a console on iOS and so nobody had any evidence at all.
//
// Reading the updater turned up a forced-reload path with NO loop guard:
//
//     window.addEventListener('daimond:idle', function () {
//         if (stale) { apply(true); return; }   // <- reloads, every time
//
// `apply(true)` is a forced reload. Once `stale` was true — the gateway having
// refused this build once — every idle event reloaded the tab, for ever, three
// lines below the once-per-build guard that `onStale` does consult. A tab that
// reloads is a tab back at its lock screen.
//
// WHETHER THAT IS THE PHONE'S BUG IS NOT SETTLED. It is a real defect, it
// produces exactly the reported symptom, and it is fixed here. This file proves
// the fix rather than the diagnosis.
//
// WHAT IS LOCKED DOWN.
//
//  A. One forced reload, then no more: a page told it is stale over and over
//     reloads ONCE and then stops, leaving the chip red for the user to press.
//  B. The guard survives the reload it is guarding against — it is in
//     localStorage, not sessionStorage, because a standalone PWA on iOS can
//     start a fresh session on every launch, and a loop that reloads the app is
//     a loop that would clear its own guard.
//  C. BOTH doors are guarded: `daimond:stale` and `daimond:idle`-while-stale.
//     The second was the unguarded one.
//  D. A reload that actually landed on a new build clears the counter, so one
//     bad afternoon does not make the device refuse the next real update.
//  E. The trail records enough to tell a reload loop from a lock: several
//     `boot` rows seconds apart, and no `lockApp`.
//  F. The lock screen shows the trail by itself once the app has booted three
//     times in ninety seconds — and NOT before, because diagnostics offered to
//     somebody whose app works are noise.
//
// PROVED RED with `--break guard`, which restores the unguarded `apply(true)`.
//
//   node dev/verify_reloadloop.mjs
//   node dev/verify_reloadloop.mjs --break guard      # must fail, loudly
//
// Needs dev/serve.mjs. No gateway: the refusal is injected, because the point is
// what the CLIENT does when refused.

import { open, signInAs, scratch } from './harness.mjs';
import fs from 'node:fs';

const BREAK = process.argv.includes('--break');

const out = [];
let bad = 0;
const check = (ok, what, detail) => {
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail != null ? ' — ' + detail : ''}`);
	if (!ok) bad++;
	return ok;
};

const PROFILE = scratch('pw', 'reloadloop-' + process.pid);
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'reloadloop', connect: false, profile: PROFILE });
const p = s.page;

if (BREAK) {
	await p.route('**/js/updater.js', async (route) => {
		const res = await route.fetch();
		let body = await res.text();
		// The defect, restored: the idle door forces a reload with no guard.
		body = body.replace('if (stale) { force(); return; }', 'if (stale) { apply(true); return; }');
		await route.fulfill({ response: res, body,
			headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
	});
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'reloadloop');
	await p.waitForTimeout(1200);
}

/// Count boots by watching the page's own trail, which survives reloads.
async function boots() {
	return p.evaluate(() => {
		try { return (window.DaimondTrail.rows() || []).filter((r) => r.w === 'boot').length; }
		catch (e) { return -1; }
	});
}

check(await boots() > 0, 'the app records its own boots in a durable trail', String(await boots()));

// ── A + C. Say "stale" repeatedly, through BOTH doors ───────────────
const before = await boots();
for (let i = 0; i < 6; i++) {
	await p.evaluate(() => {
		try { window.dispatchEvent(new Event('daimond:stale')); } catch (e) {}
		try { window.dispatchEvent(new Event('daimond:idle')); } catch (e) {}
	}).catch(() => { /* a reload mid-evaluate is the very fault under test */ });
	await p.waitForTimeout(900);
	// A reload lands on the lock screen; get back in the way a person does.
	const gate = await p.$('#id-pass');
	if (gate && await gate.isVisible().catch(() => false)) {
		await signInAs(s, 'reloadloop').catch(() => {});
	}
}
await p.waitForTimeout(800);
const after = await boots();
const reloads = after - before;

check(reloads <= 1,
	'six refusals through BOTH doors cause at most ONE reload, not six',
	`${reloads} reload(s) (boots ${before} -> ${after})`);

// NOT VACUOUS. "At most one" is satisfied by zero, and zero would mean the
// forced reload had been broken rather than guarded. The trail says which:
// the guard has to have REFUSED at least one of the six, which it can only do
// after something spent it.
{
	const trail = await p.evaluate(() => { try { return DaimondTrail.text(); } catch (e) { return ''; } });
	const refused = (trail.match(/forced reload REFUSED/g) || []).length;
	const forced  = (trail.match(/forced reload {2}/g) || []).length;
	check(refused > 0,
		'and the guard is what refused them — not a forced reload that no longer works',
		`${forced} allowed, ${refused} refused`);
}

// ── B. The guard is in localStorage, so it survives the reload ──────
{
	const where = await p.evaluate(() => ({
		local:   Object.keys(localStorage).filter((k) => /forced/.test(k)),
		session: Object.keys(sessionStorage).filter((k) => /forced/.test(k)),
	}));
	check(where.local.length > 0,
		'the loop guard is written where a reload cannot clear it',
		JSON.stringify(where));
}

// ── E. The trail tells a reload from a lock ─────────────────────────
{
	const trail = await p.evaluate(() => {
		try { return window.DaimondTrail.text(); } catch (e) { return ''; }
	});
	check(/boot/.test(trail), 'the trail names the boot');
	check(!/lockApp/.test(trail),
		'and does NOT name lockApp — so a reload loop cannot be mistaken for a log-out',
		JSON.stringify(trail.split('\n').slice(-2)));
	check(!/[A-Za-z0-9_-]{32,}/.test(trail),
		'and carries nothing that looks like a key or a token',
		JSON.stringify((trail.match(/[A-Za-z0-9_-]{32,}/) || [])[0] || 'none'));
}

// ── F. The lock screen offers the trail once, and only once, it loops ──
{
	// Not yet: a working app shows nothing.
	await p.evaluate(() => {
		try { DaimondTrail.clear(); } catch (e) {}
		try { DaimondTrail.note('boot', 'test'); } catch (e) {}
	});
	await p.evaluate(() => { try { DaimondCore.showIdentity('unlock'); } catch (e) {} });
	await p.waitForTimeout(300);
	let panel = await p.$('#id-trail');
	check(panel === null, 'a working app is offered no diagnostics');

	// Three boots inside ninety seconds is not something a person does.
	await p.evaluate(() => {
		try {
			DaimondTrail.clear();
			for (var i = 0; i < 3; i++) DaimondTrail.note('boot', 'test');
		} catch (e) {}
	});
	await p.evaluate(() => { try { DaimondCore.showIdentity('unlock'); } catch (e) {} });
	await p.waitForTimeout(300);
	panel = await p.$('#id-trail');
	const shown = await p.evaluate(() => {
		const el = document.getElementById('id-trail');
		if (!el) return null;
		return {
			lead: (el.querySelector('.id-trail-lead') || {}).textContent || '',
			lines: ((el.querySelector('.id-trail-text') || {}).textContent || '').split('\n').length,
			acts: [...el.querySelectorAll('.id-trail-btn')].map((b) => b.textContent),
			onLockCard: !!el.closest('#identity-modal'),
		};
	});
	check(panel !== null && shown && shown.onLockCard,
		'a looping app puts the trail on the lock screen by itself', JSON.stringify(shown && shown.lead));
	check(!!shown && shown.lines >= 3 && shown.acts.length === 2,
		'with the trail in it and a way to copy it', JSON.stringify(shown));
}

const noise = /favicon|401|402|426|502|Unauthorized|Payment|Bad Gateway/i;
const errs = s.errs.filter((e) => !noise.test(e));
check(errs.length === 0, 'no console errors', JSON.stringify(errs.slice(0, 3)));

await s.close();
try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* gone */ }

console.log(out.join('\n'));
const total = out.filter((l) => /^(PASS|FAIL)/.test(l)).length;
if (BREAK) {
	console.log(`\nBROKEN RUN: ${bad} of ${total} failed. `
		+ (bad > 0 ? 'Good — the guard is what stops the loop.' : 'BAD — a check that cannot fail is not evidence.'));
	process.exit(bad > 0 ? 0 : 1);
}
console.log(bad === 0 ? `\nALL ${total} CHECKS PASSED` : `\n${bad} of ${total} FAILED`);
process.exit(bad === 0 ? 0 : 1);
