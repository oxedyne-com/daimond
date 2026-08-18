// dev/verify_doorbell.mjs -- the email doorbell: the switch that three published
// texts promised and the app did not have.
//
// The doorbell defaults ON for a beta account (decision 11,
// gateway/src/doorbell.rs:333): with push declined it is the only thing a closed
// tab ever hears. Three surfaces told people they could turn it off --
// www/guide/legal/privacy.html, landing/privacy.html, and the doorbell email's
// own body, which names "Settings" -- while `?op=doorbell` had no caller
// anywhere in www/ and no i18n string existed for the notice decision 11 asks
// for. Beta accounts were emailed by default, told nothing, and pointed at a
// switch that was not there.
//
// FIVE PROPERTIES, and each one is a way the switch could exist and still be a
// lie:
//
//   1. IT IS REACHABLE. Not "the element is in the DOM": measured with
//      `getBoundingClientRect()` and required to have real area on screen after
//      pressing the cog a person presses. An absent element reports itself to a
//      locator as hidden, so everything here is COUNTED before it is asserted.
//   2. IT READS BEFORE IT DRAWS. The row must ask `?view=doorbell` and paint the
//      answer -- never paint a guess. A switch that showed "off" while the
//      answer was unknown would tell somebody no mail is being sent when it is.
//   3. THE REACH IS DRAWN AS WELL AS THE STATE. "On" and "will ring" are
//      different answers, which is why the gateway sends both. An account with
//      no address on file has the second without the first, and a screen showing
//      only the switch would be lying to the one person who could fix it.
//   4. PRESSING IT WRITES, AND DRAWS WHAT CAME BACK. `?op=doorbell` with the
//      opposite of the state on screen, and the row then shows the SERVER's
//      answer rather than the request -- a write that did not land must not
//      leave the switch showing the state it failed to reach.
//   5. THE NOTICE COMES FIRST, ONCE, AND SAYS HOW TO STOP IT. Only where the
//      default is in force and a bell could actually ring; never twice; and it
//      changes nothing on its own, because a person who taps past a modal has
//      not decided anything.
//
// No gateway: `/api/post` is routed in the browser, so what is measured is the
// CLIENT -- which request it makes, when, and what it puts on screen. The
// gateway's own half has its tests in gateway/src/doorbell.rs.
//
//   node dev/verify_doorbell.mjs
//   node dev/verify_doorbell.mjs --break noread   # 2: the row paints a guess
//   node dev/verify_doorbell.mjs --break noreach  # 3: the reach is dropped
//   node dev/verify_doorbell.mjs --break twice    # 5: the notice repeats

import { open, shot, errors } from './harness.mjs';

const BREAK = (process.argv.indexOf('--break') >= 0)
	? process.argv[process.argv.indexOf('--break') + 1] : '';

/// A deliberate damage, applied to the live page rather than to a served file:
/// each replaces one behaviour of the row with the mistake the check opposite it
/// is there to catch. A break that produces a GREEN run means that check is
/// checking nothing, and the run says so and exits 1.
const BREAKS = {
	// 2. Paint without asking: the row decides it is off and never reads.
	noread:  () => { window.DaimondPost.doorbell = async () =>
		({ ok: true, on: false, set: true, reach: 'declined', why: '' }); },
	// 3. Drop the reach, keeping the switch. This is the exact shape the audit
	//    warned about: "on" drawn for an account that cannot be rung.
	noreach: () => {
		const real = window.DaimondPost.doorbell;
		window.DaimondPost.doorbell = async () => {
			const r = await real();
			if (r && r.ok) { r.reach = 'ready'; r.why = ''; }
			return r;
		};
	},
	// 5. Never remember that the notice was shown, so it comes back every time.
	//
	// The shim goes on the INSTANCE, not on `Storage.prototype`: the app holds
	// `localStorage` directly. And it swallows only this one key -- a shim that
	// broke every write would fail the run for reasons that have nothing to do
	// with the notice, which is a break passing by breaking something else.
	twice:   () => {
		const real = localStorage.setItem.bind(localStorage);
		localStorage.setItem = function (k, v) {
			if (k === 'daimond-doorbell-told') return;
			return real(k, v);
		};
	},
};
if (BREAK && !BREAKS[BREAK]) {
	console.log(`no such break '${BREAK}'; have: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

const ok = [], bad = [];
function check(name, pass, detail) {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Real area, inside the viewport. Not an ancestry check and not `hidden`:
/// a row can be unhidden and still be nowhere a person could press it.
const onScreen = (page, sel) => page.evaluate((s) => {
	const el = document.querySelector(s);
	if (!el) return { found: false, w: 0, h: 0 };
	const r = el.getBoundingClientRect();
	return {
		found: true,
		w: Math.round(r.width), h: Math.round(r.height),
		inView: r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0,
		text: (el.textContent || '').trim(),
	};
}, sel);

const s = await open({ name: 'doorbell', connect: false });
const { page } = s;

// ── The relay, in the browser ────────────────────────────────
//
// `state` is what the gateway would hold. The route reads it at each request
// rather than closing over a copy, so a write really changes what the next read
// answers -- otherwise property 4 would pass against a fixture that cannot move.
const server = { on: true, set: false, reach: 'ready', writes: [], reads: 0, fail: false };

await page.route('**/api/post**', async (route) => {
	const req = route.request();
	const url = new URL(req.url());
	const answer = () => ({
		ok: true, on: server.on, set: server.set, reach: server.reach,
		why: server.reach === 'no_address'
			? 'No address on file, so nothing can be sent. This waits until they next open Daimond.'
			: 'A doorbell will ring for this account.',
		last_ts: 0, status: '', reason: '', attempts: 0,
	});
	if (req.method() === 'GET' && url.searchParams.get('view') === 'doorbell') {
		server.reads += 1;
		return route.fulfill({ status: 200, contentType: 'application/json',
			body: JSON.stringify(answer()) });
	}
	if (req.method() === 'POST' && url.searchParams.get('op') === 'doorbell') {
		const body = JSON.parse(req.postData() || '{}');
		server.writes.push(body);
		if (server.fail) {
			return route.fulfill({ status: 500, contentType: 'application/json',
				body: JSON.stringify({ ok: false }) });
		}
		server.on = !!body.on;
		server.set = true;
		return route.fulfill({ status: 200, contentType: 'application/json',
			body: JSON.stringify(answer()) });
	}
	// Anything else on this path is not this file's business.
	return route.fulfill({ status: 200, contentType: 'application/json',
		body: JSON.stringify({ ok: true, seq: 0, rows: [], more: false }) });
});

/// The session the row needs. There is no gateway here, so `authed` is false and
/// the row would correctly hide itself -- which would make every check below
/// pass by measuring nothing. Faked at `DaimondGateway.state`, the one door the
/// row reads, and nowhere deeper.
async function authed() {
	await page.evaluate(() => {
		const st = window.DaimondGateway.state;
		window.DaimondGateway.state = () => Object.assign({}, st(), { authed: true });
	});
}

try {

// ── 5a. The notice, which must come before anything else ─────
//
// FIRST, because "before the first email could go" is the whole property and a
// check that ran it after opening Settings would be measuring a notice the
// person had already been given the switch for.

await authed();
if (BREAK) await page.evaluate(BREAKS[BREAK]);
const toldBefore = await page.evaluate(() => localStorage.getItem('daimond-doorbell-told'));
check('nothing has been said about the doorbell yet', !toldBefore, String(toldBefore));

await page.evaluate(() => window.dispatchEvent(new Event('daimond:authed')));
await sleep(900);

const notice = await onScreen(page, '.dlg-card, .dialog-card, [role="dialog"] .dlg-msg, #dlg-msg');
const noticeAll = await page.evaluate(() => {
	// COUNTED, not asked whether it is hidden: a dialog that was never built
	// reports itself to a locator exactly as one that is hidden does.
	const cards = Array.from(document.querySelectorAll('[role="dialog"], .dlg, .dialog'));
	const live = cards.filter(c => {
		const r = c.getBoundingClientRect();
		return r.width > 40 && r.height > 40;
	});
	return { cards: cards.length, live: live.length,
		text: live.map(c => (c.textContent || '').replace(/\s+/g, ' ').trim()).join(' | ') };
});
check('a notice is on screen before any doorbell could ring',
	noticeAll.live >= 1, JSON.stringify({ cards: noticeAll.cards, live: noticeAll.live }));
check('it says what will happen: one email, and no sender or subject',
	/one email/i.test(noticeAll.text) && /no sender/i.test(noticeAll.text),
	noticeAll.text.slice(0, 160));
check('and it says how to stop it, naming Settings and the row',
	/Settings/i.test(noticeAll.text) && /Email doorbell/i.test(noticeAll.text),
	noticeAll.text.slice(0, 160));
check('and it changed nothing: the account is still on, still unchosen',
	server.writes.length === 0 && server.on === true && server.set === false,
	JSON.stringify({ writes: server.writes, on: server.on, set: server.set }));

// Dismiss it the way a person does.
await page.evaluate(() => {
	const btn = Array.from(document.querySelectorAll('[role="dialog"] button, .dlg button'))
		.filter(b => b.offsetParent !== null)[0];
	if (btn) btn.click();
});
await sleep(400);

// ── 5b. Once. ───────────────────────────────────────────────
const before = noticeAll.live;
await page.evaluate(() => window.dispatchEvent(new Event('daimond:authed')));
await sleep(900);
const again = await page.evaluate(() => Array.from(
	document.querySelectorAll('[role="dialog"], .dlg, .dialog'))
	.filter(c => { const r = c.getBoundingClientRect(); return r.width > 40 && r.height > 40; })
	.length);
check('and it is said once, not at every session', before >= 1 && again === 0,
	JSON.stringify({ before, again }));

// ── 1. The control is reachable, by pressing what a person presses ──
//
// THE COG, and nothing else. It opens the admin drawer's home view, which is
// where the sync switch lives and where daimond.js:8323 says a control has to
// be if anybody is to find it. A check that reached the row by calling
// `DaimondAdmin.settings()` would be proving the row exists somewhere in the
// app, which is a weaker claim than the one the privacy page makes.

await page.evaluate(() => { document.getElementById('settings-btn').click(); });
await sleep(900);

// COUNTED FIRST. An absent element reports itself to a locator as hidden, so
// asking "is it visible" before asking "is it there" gets the same answer for a
// row that is scrolled away and a row that was never built.
const count = await page.evaluate(() => ({
	btn:   document.querySelectorAll('#doorbell-btn').length,
	note:  document.querySelectorAll('#doorbell-note').length,
	reach: document.querySelectorAll('#doorbell-reach').length,
}));
check('the drawer the cog opens has exactly one doorbell row',
	count.btn === 1 && count.note === 1 && count.reach === 1, JSON.stringify(count));

// The drawer is long, so the row is brought into view the way a finger would.
// The property is that it is ON the page the cog opened and can be scrolled to,
// not that it happened to land in the first screenful.
await page.evaluate(() => {
	const el = document.getElementById('doorbell-btn');
	if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
});
await sleep(500);

const btn = await onScreen(page, '#doorbell-btn');
check('and the switch has real area on screen, where a hand could reach it',
	btn.found && btn.w > 20 && btn.h > 10 && btn.inView, JSON.stringify(btn));
check('and it is named for what it is', /doorbell/i.test(btn.text), btn.text);

// ── 2. It read before it drew ───────────────────────────────

check('the row asked the gateway what the state is', server.reads >= 1,
	'reads: ' + server.reads);
check('and drew the state the server sent: on, so it offers OFF',
	/turn the email doorbell off/i.test(btn.text), btn.text);

const note1 = await onScreen(page, '#doorbell-note');
check('the default is drawn AS a default, not as somebody\'s choice',
	/default for a beta account/i.test(note1.text), note1.text.slice(0, 200));
const reach1 = await onScreen(page, '#doorbell-reach');
check('and with a bell that CAN ring, the reach line says nothing twice',
	reach1.found && reach1.text === '', JSON.stringify(reach1).slice(0, 160));

// ── 3. The reach, which is not the switch ───────────────────
//
// The account loses its address; the switch stays exactly where it was. The
// switch must not move, and the row must now say a bell cannot ring.

server.reach = 'no_address';
// Closed and reopened, which is what a person does and what re-reads the state.
await page.evaluate(() => { document.getElementById('settings-btn').click(); });
await sleep(300);
await page.evaluate(() => { window.DaimondPost.doorbell().then(() => {}); });
await page.evaluate(() => { document.getElementById('settings-btn').click(); });
await sleep(900);
await page.evaluate(() => {
	const el = document.getElementById('doorbell-btn');
	if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
});
await sleep(400);

const reachBtn  = await onScreen(page, '#doorbell-btn');
const reachLine = await onScreen(page, '#doorbell-reach');
check('the switch has not moved: it is still on, and still offers OFF',
	/turn the email doorbell off/i.test(reachBtn.text), reachBtn.text);
check('and the row says a bell CANNOT ring, which the switch alone never would',
	reachLine.found && /no email address/i.test(reachLine.text),
	JSON.stringify(reachLine).slice(0, 220));

// ── 4. Pressing it writes, and draws what came back ─────────

server.reach = 'ready';
const writesBefore = server.writes.length;
await page.evaluate(() => { const b = document.getElementById('doorbell-btn'); if (b) b.click(); });
await sleep(900);

check('pressing it made exactly one write', server.writes.length === writesBefore + 1,
	JSON.stringify(server.writes));
check('and it asked for the OPPOSITE of what was on screen',
	server.writes[server.writes.length - 1] &&
	server.writes[server.writes.length - 1].on === false,
	JSON.stringify(server.writes[server.writes.length - 1]));

const after = await onScreen(page, '#doorbell-btn');
check('and the row now offers to turn it back ON, which is the server\'s answer',
	/turn the email doorbell on/i.test(after.text), after.text);
const note2 = await onScreen(page, '#doorbell-note');
check('and says plainly that no email will be sent',
	/no email will be sent/i.test(note2.text), note2.text.slice(0, 160));
check('and no longer calls it a default, because it is now a choice',
	!/default for a beta account/i.test(note2.text), note2.text.slice(0, 160));

// A write that does not land must not leave the switch showing the state it
// failed to reach. This is the check that a fixture which cannot fail would miss.
server.fail = true;
const writesBeforeFail = server.writes.length;
await page.evaluate(() => { const b = document.getElementById('doorbell-btn'); if (b) b.click(); });
await sleep(900);
const afterFail = await onScreen(page, '#doorbell-btn');
check('a refused write was attempted', server.writes.length === writesBeforeFail + 1,
	String(server.writes.length));
check('and the switch still shows OFF, the state the server is actually in',
	/turn the email doorbell on/i.test(afterFail.text), afterFail.text);
const note3 = await onScreen(page, '#doorbell-note');
check('and the row says the save did not take', /did not save/i.test(note3.text),
	note3.text.slice(0, 160));
server.fail = false;

} finally {
	await shot(s, 'doorbell' + (BREAK ? '-' + BREAK : ''));
	const errs = errors(s).filter(e => !/Failed to load resource|status of 4\d\d/.test(e));
	check('no console errors along the way', errs.length === 0, errs.slice(0, 3).join(' | '));
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) {
	console.log('failed: ' + bad.join('; '));
	process.exit(1);
}
if (BREAK) {
	console.log(`\nbreak '${BREAK}' produced a GREEN run, which means the check it is `
		+ 'aimed at is not checking anything.');
	process.exit(1);
}
