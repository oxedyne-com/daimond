// verify_safemode.mjs — the app can be asked to start without the sync engine,
// and it never does so quietly.
//
// THE BUG THIS IS FOR. An iPhone loops: unlock with a passkey, the app appears
// for about a second, the lock screen is back, repeat. Six diagnoses have been
// made across four sessions and ALL SIX WERE WRONG, every one of them reasoned
// from source rather than from evidence, because a phone has no console.
//
// A safe start is not a fix. It is an EXPERIMENT the user can run, and a phone
// they can use while it runs. If the app stays up with sync skipped, the cause
// is inside what was skipped; if it loops anyway, sync is exonerated. Nothing so
// far has been able to say either.
//
// WHAT IS LOCKED DOWN.
//
//  A. `DaimondSafe.on()` gates the sync engine at `ready()`, which is the single
//     place every entry point in sync.js already consults — so a pull, a push, a
//     nudge and the wake channel are all refused by one rule rather than five.
//  B. It arms ITSELF at three boots in ninety seconds. A user whose app will not
//     stay open long enough to be used cannot be asked to find a button.
//  C. It is never silent: the top bar carries a chip saying sync is off, and the
//     chip is what turns it back on. A device that quietly stopped saving to the
//     account would be a worse bug than the one this is armed against.
//  D. The lock screen — the only screen a looping device stays on long enough to
//     read — offers the control too, and says which way it will go.
//  E. It survives the reload it exists because of: localStorage, not session.
//  F. A safe start writes a line in the durable trail, on EVERY boot and not
//     only the one that armed it, or a later cycle reads as an ordinary boot
//     that happened not to sync.
//
// PROVED RED with `--break gate`, which removes the check from `ready()` — the
// one line that makes any of it do anything.
//
//   node dev/verify_safemode.mjs
//   node dev/verify_safemode.mjs --break gate     # must fail, loudly
//
// Needs dev/serve.mjs. No gateway: what is under test is whether the CLIENT
// starts its engine at all.

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

const PROFILE = scratch('pw', 'safemode-' + process.pid);
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'safemode', connect: false, profile: PROFILE });
const p = s.page;

if (BREAK) {
	// The gate removed from `ready()`. Everything else stays: the flag is still
	// written, the chip is still asked for, the trail is still marked. Only the
	// one line that makes the engine obey it is gone.
	await p.route('**/js/sync.js', async (route) => {
		const res = await route.fetch();
		let body = await res.text();
		body = body.replace('if (window.DaimondSafe && DaimondSafe.on()) return false;', '');
		await route.fulfill({ response: res, body,
			headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
	});
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'safemode');
	await p.waitForTimeout(800);
}

// ── The module exists at all ────────────────────────────────────────
check(await p.evaluate(() => !!(window.DaimondSafe && DaimondSafe.on && DaimondSafe.set)),
	'the app has a safe start to offer');

// ── A. Off by default, and the engine runs ──────────────────────────
{
	const st = await p.evaluate(() => ({
		safe:  window.DaimondSafe.on(),
		ready: !!(window.DaimondSync && DaimondSync.status && DaimondSync.status()),
	}));
	check(st.safe === false, 'an ordinary start is not a safe one', JSON.stringify(st));
}

// ── E. The flag is where a reload cannot clear it ───────────────────
{
	await p.evaluate(() => DaimondSafe.set(true, 'user'));
	const where = await p.evaluate(() => ({
		local:   Object.keys(localStorage).filter((k) => /safe-mode/.test(k)),
		session: Object.keys(sessionStorage).filter((k) => /safe-mode/.test(k)),
	}));
	check(where.local.length > 0 && where.session.length === 0,
		'a safe start is remembered where the reload it guards against cannot clear it',
		JSON.stringify(where));
}

// ── A. With it on, the engine refuses to run ────────────────────────
//
// Measured at the engine and not at the flag: `ready()` is private, so what is
// asked is whether a PULL reaches the mailbox at all.
//
// THE SESSION HAS TO BE FAKED, and this is the whole difficulty. There is no
// gateway in this world, so `ready()` is already false on the OTHER three
// grounds it tests — and a check written without noticing that passes whether
// the safe gate is there or not. It did: the first `--break gate` run went 13/13
// green, which is a check that cannot fail and therefore is not evidence.
//
// So `DaimondGateway.state()` is made to answer "authed", leaving the safe gate
// as the ONLY thing standing between `pull()` and a request. Stubbed in both
// runs, so what the two are compared on is one line of the app.
{
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'safemode');
	await p.waitForTimeout(600);

	const posed = await p.evaluate(() => {
		try {
			var real = DaimondGateway.state;
			DaimondGateway.state = function () {
				return Object.assign({}, real(), { authed: true });
			};
			return DaimondGateway.state().authed === true;
		} catch (e) { return false; }
	});
	check(posed, 'a session can be posed, so the safe gate is the only thing left in the way');

	const asked = [];
	p.on('request', (r) => { if (/\/api\/sync/.test(r.url())) asked.push(r.method()); });

	const answer = await p.evaluate(async () => {
		try { return await DaimondSync.pull(); } catch (e) { return 'threw: ' + e; }
	});
	await p.evaluate(() => { try { DaimondSync.nudge(); } catch (e) {} });
	await p.waitForTimeout(1500);

	check(answer === -1 && asked.length === 0,
		'with a safe start armed, the sync engine does not run at all',
		`pull returned ${JSON.stringify(answer)}, ${asked.length} request(s) to the mailbox`);
}

// ── C. And says so, on a chip that turns it back off ────────────────
{
	const chip = await p.evaluate(() => {
		const c = document.getElementById('sync-chip');
		if (!c) return null;
		return {
			state:   c.dataset.state,
			text:    (c.querySelector('.stext') || {}).textContent || '',
			title:   c.title || '',
			shown:   getComputedStyle(c).display !== 'none',
			pointer: getComputedStyle(c).cursor,
		};
	});
	check(!!chip && chip.state === 'off' && /safe/i.test(chip.text),
		'the top bar says sync is off, so a safe start is never a silent one',
		JSON.stringify(chip));
	check(!!chip && chip.pointer === 'pointer' && /click/i.test(chip.title),
		'and the thing that says it is the thing that undoes it',
		JSON.stringify(chip && chip.title));
}

// ── F. The trail records it, on this boot and not only the arming one ──
{
	const trail = await p.evaluate(() => { try { return DaimondTrail.text(); } catch (e) { return ''; } });
	check(/safe start/.test(trail),
		'a safe start is written into the durable trail',
		JSON.stringify((trail.split('\n').filter((l) => /safe/.test(l)) || []).slice(-2)));
	check(!/[A-Za-z0-9_-]{32,}/.test(trail),
		'and the trail still carries nothing that looks like a key or a token',
		JSON.stringify((trail.match(/[A-Za-z0-9_-]{32,}/) || [])[0] || 'none'));
}

// ── D. The lock screen offers it, and says which way the button goes ──
{
	await p.evaluate(() => {
		try {
			DaimondSafe.set(false, 'user');
			DaimondTrail.clear();
			for (var i = 0; i < 3; i++) DaimondTrail.note('boot', 'test');
			DaimondCore.showIdentity('unlock');
		} catch (e) {}
	});
	await p.waitForTimeout(300);
	const offered = await p.evaluate(() => {
		const b = document.getElementById('id-trail-safe');
		const el = document.getElementById('id-trail');
		return b && el ? {
			label: b.textContent,
			note:  [...el.querySelectorAll('.id-trail-lead')].map((n) => n.textContent).join(' | ').slice(0, 90),
		} : null;
	});
	check(!!offered, 'the lock screen offers a safe start where a looping device can reach it',
		JSON.stringify(offered && offered.label));

	// And with it already ON, the same button is the way BACK.
	await p.evaluate(() => {
		try { DaimondSafe.set(true, 'user'); DaimondCore.showIdentity('unlock'); } catch (e) {}
	});
	await p.waitForTimeout(300);
	const back = await p.evaluate(() => {
		const b = document.getElementById('id-trail-safe');
		return b ? b.textContent : null;
	});
	check(!!offered && !!back && offered.label !== back,
		'and reads as the way back once it is on, rather than offering the same thing twice',
		JSON.stringify([offered && offered.label, back]));
}

// ── B. It arms itself on a loop, with nobody pressing anything ───────
//
// Through the module's own code path, which is what runs at a boot: clear the
// flag, write three boot rows, and reload. safe.js reads the trail at script
// load and must arm without being asked.
{
	await p.evaluate(() => {
		try {
			DaimondSafe.set(false, 'user');
			DaimondTrail.clear();
			// Two, not three: this page's own reload writes the third.
			for (var i = 0; i < 2; i++) DaimondTrail.note('boot', 'test');
		} catch (e) {}
	});
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(400);
	const armed = await p.evaluate(() => ({
		on:    window.DaimondSafe.on(),
		why:   window.DaimondSafe.why(),
		boots: window.DaimondSafe.boots(),
	}));
	check(armed.on === true && armed.why === 'auto',
		'three boots in ninety seconds arms a safe start with nobody pressing anything',
		JSON.stringify(armed));

	// NOT VACUOUS. It must NOT arm on an app that is merely being used.
	await p.evaluate(() => {
		try { DaimondSafe.set(false, 'user'); DaimondTrail.clear(); } catch (e) {}
	});
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(400);
	const quiet = await p.evaluate(() => ({ on: window.DaimondSafe.on(), boots: window.DaimondSafe.boots() }));
	check(quiet.on === false,
		'and a single ordinary start does not arm one',
		JSON.stringify(quiet));
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
		+ (bad > 0 ? 'Good — the gate in ready() is what makes a safe start mean anything.'
			: 'BAD — a check that cannot fail is not evidence.'));
	process.exit(bad > 0 ? 0 : 1);
}
console.log(bad === 0 ? `\nALL ${total} CHECKS PASSED` : `\n${bad} of ${total} FAILED`);
process.exit(bad === 0 ? 0 : 1);
