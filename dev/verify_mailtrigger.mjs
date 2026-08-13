// verify_mailtrigger.mjs — the mail-arrival trigger fires on mail that arrived,
// and on nothing else.
//
// A triggered action is a Diamond spending WITHOUT BEING ASKED, so the occasion
// that fires one is not a detail — it is the whole safety of the feature. The
// mail arm of it had never been driven by any verifier in this tree (219 of
// them; `grep -rl mail-arrived dev/` found only the Pending panel, which
// dispatches the event ITSELF and never asks mail.js to). It shipped announcing
// an arrival on any sync that returned messages, which is three different lies:
//
//   * A "FETCH OLDER" BACKFILL. `syncOne(address, older, …)` had `older` in
//     scope at the dispatch and did not test it, so a user pressing "the next 25
//     older" woke every Diamond armed on that folder and paid for a turn about
//     mail they had had for months.
//   * A `uidValidity` REBUILD. The mailbox generation changing re-fetches the
//     folder from uid 0 (mail.js), and the whole mailbox came back looking new.
//     A generation change RENUMBERS every uid, so the new numbers are commonly
//     far above the old watermark and no high-water test can catch it — the
//     rebuild has to say so itself. That is a bill the size of the mailbox.
//   * THE FIRST FETCH OF A FOLDER. Adding an account with a trigger already
//     armed announced everything already in it.
//
// The properties, each asserted in BOTH directions — because a check that only
// ever proves silence passes with the feature entirely absent:
//
//   1. A GENUINE ARRIVAL FIRES IT, ONCE, NAMING THE MESSAGES THAT ARRIVED. The
//      event's uids are the new ones and not the folder's, and a turn really
//      reaches the model carrying the action's instruction. Measured at the
//      MOCK PROVIDER'S LOG, which is where the money is: a check on the event
//      alone would pass with the whole trigger chain unwired.
//   2. A FETCH OLDER FIRES NOTHING. Pressed on the real button in the panel.
//   3. A uidValidity REBUILD FIRES NOTHING, though every uid it returns is above
//      the old watermark.
//   4. A FIRST FETCH FIRES NOTHING.
//   5. AND THE TRIGGER IS STILL ARMED AFTERWARDS: mail arriving after a rebuild
//      fires it again. Hiding the feature would satisfy 2, 3 and 4 and be worse
//      than the defect.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// damaged `www/js/mail.js` to the real page through `page.route`; the run is
// expected to fail, and an anchor that does not appear exactly once aborts.
//
//   node dev/verify_mailtrigger.mjs --break shipped   # the code as it shipped: 1-5 all fail
//   node dev/verify_mailtrigger.mjs --break older     # a backfill counts as arrival: 2 fails
//   node dev/verify_mailtrigger.mjs --break rebuild   # a rebuild counts as arrival: 3 fails
//   node dev/verify_mailtrigger.mjs --break baseline  # a first fetch counts as arrival: 4 fails
//   node dev/verify_mailtrigger.mjs                   # and then, clean
//
//   eval "$(bash dev/world.sh 20 --up)"
//   node dev/verify_mailtrigger.mjs
//
// NO IMAP FIXTURE AND NO GATEWAY. Every mail route is stubbed here, exactly as
// `dev/verify_mailrefresh.mjs` does, and everything below the stub is the real
// code: the sync, the Maildir on disk, the panel, the event, the trigger engine,
// the daimon and the wire to the model. The one thing the stub cannot prove is
// that a REAL IMAP server's `since_uid` / `before_uid` / `uid_validity`
// behaviour matches this fixture's; `dev/verify_mailsync.mjs` and
// `dev/verify_mailfolders.mjs` own that against the fixture on :1143.
//
// The fixture's `since_uid` is EXCLUSIVE, matching the shipped gateway
// (gateway/src/handlers/mail.rs:589, `u.retain(|x| *x > since_uid)`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, shot, scratch, errors, mockLog } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'mailtrigger' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
//
// The guard reads `(older || rebuilt || !known)`; each break removes one term,
// and `shipped` puts back the line the app actually carried.
const GUARD = '\t\t\tvar fresh = (older || rebuilt || !known)\n'
	+ '\t\t\t\t? []\n'
	+ '\t\t\t\t: msgs.filter(function (m) { return m.uid > mark; });';

const BREAKS = {
	shipped: [{
		file: 'js/mail.js',
		find: GUARD,
		with: '\t\t\tvar fresh = msgs;',
	}],
	// BOTH fences that cover a backfill, because a backfill has two: the `older`
	// term, and the high-water filter (a message BELOW what is held cannot be
	// above the mark, so a well-behaved server is caught twice). Removing one
	// alone fails nothing, which is the point of keeping both — and a break that
	// removed one alone would report a passing run as proof of a check that the
	// other fence had quietly carried.
	older: [{
		file: 'js/mail.js',
		find: GUARD,
		with: '\t\t\tvar fresh = (rebuilt || !known) ? [] : msgs;',
	}],
	rebuild: [{
		file: 'js/mail.js',
		find: GUARD,
		with: '\t\t\tvar fresh = (older || !known)\n'
			+ '\t\t\t\t? []\n'
			+ '\t\t\t\t: msgs.filter(function (m) { return m.uid > mark; });',
	}],
	baseline: [{
		file: 'js/mail.js',
		find: GUARD,
		with: '\t\t\tvar fresh = (older || rebuilt)\n'
			+ '\t\t\t\t? []\n'
			+ '\t\t\t\t: msgs.filter(function (m) { return m.uid > mark; });',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

function damaged(spec) {
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

// ── The stubbed gateway, and the mailbox behind it ───────────────────

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (body, status = 200) => ({
	status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body),
});

const BOX   = 'alice@test.local';
const LIMIT = 2;                       // messages per batch, so there is a backlog to reach into

/// The server's INBOX: what it holds, and under which generation.
const server = {
	validity: 42,
	msgs: [1, 2, 3, 4, 5, 6].map(uid => ({ uid, subject: 'old ' + uid })),
};

/// A generation change, which is what `uidValidity` means: every UID now names a
/// DIFFERENT message, so the server renumbers. The new numbers here are far
/// ABOVE the old watermark, which is the case a high-water test cannot catch and
/// the reason the rebuild has to announce itself.
function renumber(base) {
	server.validity += 1;
	server.msgs = server.msgs.map((m, i) => ({ uid: base + i, subject: m.subject }));
}

/// A message on the wire, as the gateway serves it: base64 RFC 5322.
const wire = (m) => ({
	uid: m.uid,
	flags: ['\\Seen'],
	raw: Buffer.from(
		'From: Someone <someone@example.com>\r\n'
		+ `Subject: ${m.subject}\r\n`
		+ 'Date: Thu, 7 Aug 2026 09:00:00 +1000\r\n'
		+ 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
		+ `${m.subject} body\r\n`, 'utf8').toString('base64'),
});

/// Every sync request that LEFT the page, so a check can say which fetch it is
/// talking about rather than counting events and hoping.
const syncs = [];

/// What the fixture answers, by the rules the real gateway follows.
///
/// `before_uid` reaches BACKWARDS and returns the highest batch below it;
/// `since_uid` walks forwards and is EXCLUSIVE. The one departure is the
/// rebuild's re-fetch — the request mail.js sends carries `since_uid: 0` AND
/// `before_uid: 0` together, and is answered with the WHOLE folder, because
/// "the whole mailbox comes back" is the case under test.
function answer(b) {
	const all = server.msgs.slice().sort((x, y) => x.uid - y.uid);
	const since  = b.since_uid | 0;
	const before = b.before_uid | 0;
	const rebuild = since === 0 && b.before_uid === 0;
	let out;
	if (rebuild)         out = all;
	else if (before > 0) out = all.filter(m => m.uid < before).slice(-LIMIT);
	else                 out = all.filter(m => m.uid > since).slice(-LIMIT);
	return {
		ok: true,
		uid_validity: server.validity,
		messages: out.map(wire),
		// What the cap left behind, so the panel offers the "older" button at all.
		held_back: all.length - out.length,
		limit: LIMIT,
		credits_minor: 4990,
	};
}

async function stub(page) {
	if (BREAK) {
		for (const spec of BREAKS[BREAK]) {
			const body = damaged(spec);
			await page.route('**/' + spec.file, r => r.fulfill({
				status: 200, contentType: 'application/javascript', body,
			}));
		}
	}
	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-mt', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: 5000, currency: 'usd', entries: [] })));
	await page.route('**/api/licence',        r => r.fulfill(json({ ok: true, licence: true, currency: 'usd' })));
	await page.route('**/api/mail/accounts',  r => r.request().method() === 'GET'
		? r.fulfill(json({ ok: true, unlocked: true, max_accounts: 3 }))
		: r.fulfill(json({ ok: true })));
	await page.route('**/api/mail/folders',   r => r.fulfill(json({ ok: true, folders: [{ name: 'INBOX' }] })));
	await page.route('**/api/mail/send',      r => r.fulfill(json({ ok: true })));
	await page.route('**/api/mail/sync', r => {
		let b = {};
		try { b = JSON.parse(r.request().postData() || '{}'); } catch (e) { b = {}; }
		const j = answer(b);
		syncs.push({
			mailbox: b.mailbox, since: b.since_uid, before: b.before_uid,
			gave: j.messages.map(m => m.uid),
		});
		return r.fulfill(json(j));
	});
}

// ── Driving ──────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Unique to this run, so a turn found in the mock's log cannot be an earlier
// run's: the log belongs to the WORLD, not to the run.
const SAYS = 'MAIL TRIGGER CHECK ' + Date.now().toString(36);

const s = await open({ name: 'mailtrigger', profile: PROFILE, signIn: false, connect: false, route: stub });
const { page } = s;

/// Everything `daimond:mail-arrived` has announced so far, as the listener in
/// daimond.js sees it.
const arrivals = () => page.evaluate(() => window.__arrivals || []);

/// Turns that reached the model carrying this run's instruction. THE MONEY: a
/// trigger that fires is a turn nobody asked for.
const turns = (from) => mockLog().slice(from).filter(r => JSON.stringify(r).includes(SAYS)).length;

/// Wait for a sync to finish and any turn it caused to land. Generous, and the
/// same wait on every step: a check that gave the firing step longer than the
/// silent ones would be measuring the clock.
const settle = (ms = 6000) => sleep(ms);

let logBase = 0;
try {
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);
	await signInAs(s, 'mailtrigger');
	await connectMock(s);

	// The recorder goes on BEFORE anything can sync, so a missed announcement is
	// a missed announcement and not a late listener.
	await page.evaluate(() => {
		window.__arrivals = [];
		window.addEventListener('daimond:mail-arrived', (e) => window.__arrivals.push(e.detail));
	});

	// A Diamond to be woken. `Daimond Help` is seeded with no actions and no hold,
	// so anything that fires here is the action this file armed.
	await page.evaluate(() => DaimondDiamond.seedDefaults());
	await page.waitForFunction(() =>
		[...document.querySelectorAll('#diamond-list .session-box-name')]
			.some(n => /Daimond Help/.test(n.textContent)), null, { timeout: 20000 });
	const helpId = await page.evaluate(() => {
		const b = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find(x => /Daimond Help/.test(x.textContent));
		return b ? b.dataset.id : '';
	});
	check('a Diamond is there to be woken', !!helpId, helpId || '(none)');

	// Armed on THIS mailbox and THIS folder, and its pause leaf left playing —
	// said out loud rather than assumed, because a held TA is dropped before
	// anything else is asked and every check below would then pass for the wrong
	// reason.
	await page.evaluate(async (a) => {
		const T = window.DaimondTriggers;
		const ta = T.blank('mail');
		ta.id = 'mailwatch';
		ta.mailbox = a.box;
		ta.folder = 'INBOX';
		ta.instruction = a.says;
		await DaimondCore.triggerSet(a.id, ta);
		DaimondPause.set(T.node(a.id, ta.id), true);
	}, { id: helpId, box: BOX, says: SAYS });
	const armed = await page.evaluate((a) => {
		const T = window.DaimondTriggers;
		const ta = (window.DaimondTriggersOf(a.id) || []).find(x => x.id === 'mailwatch');
		return { ready: !!ta && T.ready(ta), allowed: !!ta && T.allowed(a.id, ta) };
	}, { id: helpId });
	check('the mail trigger is armed and not held', armed.ready && armed.allowed,
		JSON.stringify(armed));

	// It is the Diamond ON SCREEN, because a trigger deliberately refuses to move
	// the centre out from under somebody: with another Diamond up, every firing
	// below would be refused and the checks would prove nothing.
	await page.evaluate((id) => {
		document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`).click();
	}, helpId);
	await page.waitForTimeout(900);

	// The mailbox, seeded the way the add-dialog would but pointed nowhere real.
	await page.evaluate(async (box) => {
		const pass = await window.DaimondIdentity.wrap('test-app-password');
		localStorage.setItem('daimond-mail', JSON.stringify({
			accounts: [{
				address: box, host: '127.0.0.1', port: 1143, security: 'plain',
				smtpHost: '127.0.0.1', smtpPort: 1587, smtpSecurity: 'plain',
				user: box, pass, folder: 'INBOX', folders: {}, lastSync: 0, touched: 1,
			}],
			sel: box,
		}));
		window.DaimondMail.reload();
		window.DaimondPanels.show('mail');
		window.DaimondMail.onOpen();
	}, BOX);
	await page.waitForTimeout(1500);

	logBase = mockLog().length;

	// Each step is measured against the one before it, not against a running
	// total: "this fetch announced nothing" is the property, and a cumulative
	// count would let one step's failure redden every step after it and hide
	// which line is responsible.
	let seenArr = 0, seenTurns = 0;
	/// What the step just driven announced, and what it cost.
	async function step() {
		const all = await arrivals();
		const t   = turns(logBase);
		const out = { fresh: all.slice(seenArr), turns: t - seenTurns, fetched: syncs[syncs.length - 1] };
		seenArr = all.length;
		seenTurns = t;
		return out;
	}

	// ══ 4. The first fetch of a folder is a baseline ══════════════════
	await page.evaluate(() => window.DaimondMail.sync());
	await settle();
	const first = await step();
	check('THE FIRST FETCH OF A FOLDER ANNOUNCES NOTHING — the messages were already '
		+ 'there and none of them arrived',
		first.fresh.length === 0 && !!first.fetched && first.fetched.gave.length > 0,
		`fetched ${JSON.stringify(first.fetched && first.fetched.gave)}, `
		+ `announced ${JSON.stringify(first.fresh)}`);
	check('and no turn was bought for them', first.turns === 0, `${first.turns} turn(s)`);

	// ══ 1. A genuine arrival ══════════════════════════════════════════
	server.msgs.push({ uid: 7, subject: 'new A' }, { uid: 8, subject: 'new B' });
	await page.evaluate(() => window.DaimondMail.sync());
	await settle();
	const arrived = await step();
	check('MAIL THAT ACTUALLY ARRIVED IS ANNOUNCED, ONCE', arrived.fresh.length === 1,
		JSON.stringify(arrived.fresh));
	// Meaning, not arity: the event names the two messages that arrived and not
	// the six the folder holds, and it names the mailbox and folder they came to.
	check('and it names THOSE messages — uids 7 and 8, not the folder',
		arrived.fresh.length === 1
			&& JSON.stringify((arrived.fresh[0].uids || []).slice().sort((a, b) => a - b)) === '[7,8]'
			&& arrived.fresh[0].count === 2
			&& arrived.fresh[0].mailbox === BOX && arrived.fresh[0].folder === 'INBOX',
		JSON.stringify(arrived.fresh[0] || {}));
	check('AND A TURN REALLY REACHED THE MODEL carrying the action\'s instruction — the '
		+ 'chain is wired end to end, so the silences below are refusals and not a dead wire',
		arrived.turns === 1, `${arrived.turns} turn(s) on the wire`);

	// ══ 2. A fetch older ══════════════════════════════════════════════
	// Pressed on the real button in the panel, which is how a person reaches it.
	const pressed = await page.evaluate(() => {
		const b = document.querySelector('.mail-older');
		if (!b) return false;
		b.click();
		return true;
	});
	check('the panel offers "fetch older", so this is the control the user presses',
		pressed, pressed ? '' : 'no .mail-older button was drawn');
	await settle();
	const older = await step();
	check('A FETCH OLDER ANNOUNCES NOTHING, though it returned messages',
		older.fresh.length === 0 && !!older.fetched && older.fetched.before > 0
			&& older.fetched.gave.length > 0,
		`the backfill returned ${JSON.stringify(older.fetched && older.fetched.gave)}, `
		+ `announced ${JSON.stringify(older.fresh)}`);
	check('and it bought no turn — pressing the button was the asking',
		older.turns === 0, `${older.turns} turn(s)`);

	// ══ 3. A uidValidity rebuild ══════════════════════════════════════
	renumber(101);
	await page.evaluate(() => window.DaimondMail.sync());
	await settle();
	const rebuilt = await step();
	check('A uidValidity REBUILD ANNOUNCES NOTHING, though the whole folder came back '
		+ 'and every uid in it is above the old watermark',
		rebuilt.fresh.length === 0 && !!rebuilt.fetched && rebuilt.fetched.gave.length >= 6
			&& Math.min(...rebuilt.fetched.gave) > 8,
		`the rebuild returned ${JSON.stringify(rebuilt.fetched && rebuilt.fetched.gave)}, `
		+ `announced ${JSON.stringify(rebuilt.fresh)}`);
	check('and it bought no turn — a rebuild is not a delivery',
		rebuilt.turns === 0, `${rebuilt.turns} turn(s)`);

	// ══ 5. Still armed ════════════════════════════════════════════════
	server.msgs.push({ uid: 109, subject: 'new C' });
	await page.evaluate(() => window.DaimondMail.sync());
	await settle();
	const again = await step();
	check('AND THE TRIGGER IS STILL ARMED: mail arriving after all that fires it again, '
		+ 'naming the one message that came',
		again.fresh.length === 1 && JSON.stringify(again.fresh[0].uids || []) === '[109]',
		JSON.stringify(again.fresh));
	check('and that one did buy a turn — the guards refuse occasions, not the feature',
		again.turns === 1, `${again.turns} turn(s)`);

	// A refusal is a decision, not a fault.
	const errs = errors(s).filter(e => !/Failed to load resource/.test(e) && !/Paused:/.test(e));
	check('nothing was refused by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | '));

	await shot(s, 'mailtrigger' + (BREAK ? '-' + BREAK : ''));
} catch (e) {
	check('the run finished', false, String((e && e.message) || e));
	try { await shot(s, 'mailtrigger-threw'); } catch { /* nothing to show */ }
} finally {
	await s.close();
}

console.log('\nsyncs: ' + syncs.map(x => `${x.before ? 'before ' + x.before : 'since ' + x.since}`
	+ `→[${x.gave}]`).join('  '));
if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
