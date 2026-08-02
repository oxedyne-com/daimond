// verify_naming.mjs — two chats must never be called the same thing.
//
// The bug the user reported: with Chat-0001 and Chat-0002 in the rail, the next
// new chat was called Chat-0002.
//
// The cause is a shape worth remembering, because this codebase has had it
// before: ONE FACT STORED IN TWO PLACES THAT DO NOT TRAVEL TOGETHER. The name
// counter lives in localStorage, which is per device. The chats live in the
// synced store, which is shared across every device on the account. So a chat
// made on the other machine arrives here having advanced ITS counter and not
// this one, and the next chat made here is handed a number already in use. A
// backup import opens the same gap: it restores the chats, not the counter.
//
// The fix makes the counter a floor rather than the answer -- whatever number is
// actually in use wins over it -- so the two cannot disagree for long. This
// verifier drives the real path: it plants the higher-numbered chat the way sync
// would (straight into the store, counter untouched), reloads, and asks for a new
// chat.
import { open, newChat, signInAs } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	return pass;
};

// NOT a fixed profile. This test asserts that the FIRST chat is Chat-0001, so it
// needs a store with no chats in it; on a fixed profile the second run inherits
// the first run's chats and counter and goes red for a reason that has nothing to
// do with the product. That trap has bitten verify_durability and
// verify_mailfolders already.
const s = await open({ name: 'naming' });
const p = s.page;
await p.waitForTimeout(1500);

/// Every chat name in the rail, in rail order.
const names = () => p.evaluate(() =>
	[...document.querySelectorAll('.session-box.chat-box .tile-label')].map((e) => e.value));

// One chat the ordinary way, so the counter is genuinely at 1.
await newChat(s);
await p.waitForTimeout(400);
const first = await names();
check('the first chat is Chat-0001', first.includes('Chat-0001'), JSON.stringify(first));

const counterAfterFirst = await p.evaluate(() =>
	localStorage.getItem('daimond-chat-counter'));
check('the counter is at 1', counterAfterFirst === '1', String(counterAfterFirst));

// ── The arrival from the other device ───────────────────────────────
//
// Written into the store WITHOUT touching the counter, which is exactly what a
// sync pull does: the parcel carries the chats and the counter is not in it.
await p.evaluate(() => {
	const raw = localStorage.getItem('daimond-chats');
	const list = raw ? JSON.parse(raw) : [];
	const one = list[0] || {};
	list.push(Object.assign({}, one, {
		id: 'from-the-other-device',
		name: 'Chat-0002',
		messages: [],
		updatedAt: Date.now(),
	}));
	localStorage.setItem('daimond-chats', JSON.stringify(list));
});
await p.reload();
// A reload lands on the lock gate: boot stops there and nothing behind it runs,
// so a test that reloads and reads the rail reads an empty one. Sign in the way
// a person would.
await p.waitForTimeout(800);
if (await p.$('#id-primary')) await signInAs(s, 'tester');
await p.waitForTimeout(2000);

const both = await names();
check('both chats are in the rail', both.includes('Chat-0001') && both.includes('Chat-0002'),
	JSON.stringify(both));
const counterStill = await p.evaluate(() => localStorage.getItem('daimond-chat-counter'));
check('and the counter did NOT move when the chat arrived', counterStill === '1',
	String(counterStill));

// ── The new chat must not collide ───────────────────────────────────
// The Admin drawer opens over the rail on a not-connected profile and swallows
// the click at the + button's coordinates, so it is closed first -- the same
// step harness.newChat takes, which cannot be reused here because it returns
// early whenever a composer is already open.
const drawerClose = p.locator('#admin-close');
if (await drawerClose.isVisible().catch(() => false)) {
	await drawerClose.click({ force: true });
	await p.waitForTimeout(300);
}
await p.click('#new-session-btn', { force: true });
await p.waitForTimeout(600);
const start = p.locator('.tile-start').first();
if (await start.count()) await start.click({ force: true });
await p.waitForTimeout(1500);

const after = await names();
const dupes = after.filter((n, i) => after.indexOf(n) !== i);
check('the new chat did not take a name already in use', dupes.length === 0,
	`names ${JSON.stringify(after)}${dupes.length ? ', duplicated ' + JSON.stringify(dupes) : ''}`);
check('it took the next free number', after.includes('Chat-0003'), JSON.stringify(after));

// ── Proved red ──────────────────────────────────────────────────────
//
// The old behaviour, reconstructed: take the counter as the answer and ignore
// what is in use. It must produce the collision the user reported, or this file
// is testing something that was never broken.
console.log('');
const wouldCollide = await p.evaluate(() => {
	const used = [...document.querySelectorAll('.session-box.chat-box .tile-label')].map((e) => e.value);
	// The counter at the moment the second chat arrived, which is what the old
	// code would have incremented.
	const oldWay = 'Chat-' + ('000' + (1 + 1)).slice(-4);
	return { oldWay, collides: used.includes(oldWay) };
});
console.log((wouldCollide.collides ? '  ok   ' : '  FAIL ')
	+ `self-test: counter-only naming would have produced ${wouldCollide.oldWay}, `
	+ `which is already in the rail`);
(wouldCollide.collides ? ok : bad).push('self-test: the old rule collides');

console.log('');
console.log(bad.length
	? `${bad.length} FAILED of ${ok.length + bad.length}:\n  - ${bad.join('\n  - ')}`
	: `naming: all ${ok.length} checks pass — a name already in use is never handed out again.`);
await s.close();
process.exit(bad.length ? 1 : 0);
