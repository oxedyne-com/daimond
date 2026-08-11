// verify_naming.mjs — two Diamonds must never be offered the same name.
//
// THIS FILE USED TO BE ABOUT CHATS, and the change is worth recording rather
// than losing in a diff. The bug the user reported was: with Chat-0001 and
// Chat-0002 in the rail, the next new chat was called Chat-0002.
//
// The cause is a shape worth remembering, because this codebase has had it more
// than once: ONE FACT STORED IN TWO PLACES THAT DO NOT TRAVEL TOGETHER. The
// counter lives in localStorage, which is per device. The things it names live
// in the synced store, shared across every device on the account. So one made on
// the other machine arrives here having advanced ITS counter and not this one,
// and the next one made here is handed a number already in use. A backup import
// opens the same gap: it restores the records, not the counter.
//
// CHATS ARE NO LONGER NUMBERED AT ALL, which retires half of that. A chat is
// throw-away — get in, get out, and spend the time curating Diamonds — and an
// accession number is what a museum gives a thing it is keeping, so the number
// was the interface arguing the opposite of what the app is for. It was also
// never true: the counter was per device while the chats were shared, so the
// numbers implied a chronology they did not have. A chat is now identified by
// WHEN it was last touched, which is derived, needs no counter, and cannot
// collide. `dev/verify_chatlife.mjs` holds that ground.
//
// A DIAMOND IS STILL NUMBERED, and should be: it is the thing being kept, it is
// named on purpose at the moment it is made, and the number is only what the
// dialog opens on. Which means the collision above is still live for Diamonds
// and still needs guarding — so this file follows it there rather than being
// deleted along with its old subject. The fix under test is the same one:
// `nextDiamondNumber` treats the counter as a FLOOR and lets whatever number is
// actually in use win over it.
//
// It drives the real path: it plants the higher-numbered Diamond the way sync
// would (straight into the store, counter untouched), reloads, and asks what the
// New Diamond dialog would offer.
import { open, signInAs } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	return pass;
};

// NOT a fixed profile, and no default Diamonds: this asserts what the FIRST
// Diamond would be offered, so it needs a rail with nothing in it. On a fixed
// profile the second run inherits the first run's Diamonds and counter and goes
// red for a reason that has nothing to do with the product. That trap has bitten
// verify_durability and verify_mailfolders already.
const s = await open({ name: 'naming', defaults: false });
const p = s.page;
await p.waitForTimeout(1500);

/// Every Diamond name in the rail, in rail order.
const names = () => p.evaluate(() =>
	[...document.querySelectorAll('#diamond-list .diamond-box')]
		.map((e) => (e.querySelector('.session-box-name') || {}).textContent || '')
		.map((t) => t.trim()));

/// What the New Diamond dialog would put in its name field.
const offered = () => p.evaluate(() => window.DaimondCore.nextDiamondLabel());

/// Make one Diamond, straight through the engine, with the counter advanced the
/// way the dialog advances it. Not through the dialog itself: this file is about
/// the NUMBER, and driving three modals to get at it would make a naming test
/// into a dialog test that fails for unrelated reasons.
const makeDiamond = (name) => p.evaluate(async (n) => {
	const id = await window.DaimondCore.diamondApp().create_diamond(n);
	window.DaimondCore.takeDiamondLabel();
	return id;
}, name);

try {
	check('a fresh rail offers the first number', (await offered()) === 'Diamond-0001',
		await offered());

	await makeDiamond('Diamond-0001');
	await p.evaluate(() => window.DaimondCore.loadDiamonds());
	await p.waitForTimeout(600);
	check('the first Diamond is in the rail', (await names()).includes('Diamond-0001'),
		JSON.stringify(await names()));

	const counterAfterFirst = await p.evaluate(() =>
		localStorage.getItem('daimond-diamond-counter'));
	check('the counter is at 1', counterAfterFirst === '1', String(counterAfterFirst));

	// ── The arrival from the other device ───────────────────────────
	//
	// Created WITHOUT touching the counter, which is exactly what a sync pull
	// does: the parcel carries the Diamonds and the counter is not in it.
	await p.evaluate(async () => {
		await window.DaimondCore.diamondApp().create_diamond('Diamond-0002');
	});
	await p.reload();
	// A reload lands on the lock gate: boot stops there and nothing behind it
	// runs, so a test that reloads and reads the rail reads an empty one. Sign in
	// the way a person would.
	await p.waitForTimeout(800);
	if (await p.$('#id-primary')) await signInAs(s, 'naming');
	await p.waitForTimeout(2000);

	const both = await names();
	check('both Diamonds are in the rail',
		both.includes('Diamond-0001') && both.includes('Diamond-0002'), JSON.stringify(both));
	const counterStill = await p.evaluate(() => localStorage.getItem('daimond-diamond-counter'));
	check('and the counter did NOT move when the second one arrived', counterStill === '1',
		String(counterStill));

	// ── The next one must not collide ───────────────────────────────
	const next = await offered();
	check('the next Diamond is not offered a name already in use',
		!both.includes(next), `offered ${next}, rail ${JSON.stringify(both)}`);
	check('it is offered the next free number', next === 'Diamond-0003', next);

	// ── Proved red ──────────────────────────────────────────────────
	//
	// The old behaviour, reconstructed: take the counter as the answer and ignore
	// what is in use. It must produce the collision the user reported, or this
	// file is testing something that was never broken.
	console.log('');
	const wouldCollide = await p.evaluate(() => {
		const used = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.map((e) => ((e.querySelector('.session-box-name') || {}).textContent || '').trim());
		// The counter as it stands, incremented — which is what the old rule did.
		const n = parseInt(localStorage.getItem('daimond-diamond-counter') || '0', 10) || 0;
		const oldWay = 'Diamond-' + ('000' + (n + 1)).slice(-4);
		return { oldWay, collides: used.includes(oldWay) };
	});
	check(`self-test: counter-only naming would have offered ${wouldCollide.oldWay}, `
		+ 'which is already in the rail', wouldCollide.collides === true,
		'the fixture never reached the state under test, so the checks above prove nothing');
} finally {
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (bad.length) { console.log('failed: ' + bad.join('; ')); process.exit(1); }
process.exit(0);
