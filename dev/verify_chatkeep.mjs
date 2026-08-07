// verify_chatkeep.mjs — a chat leaves the store on a tombstone, and on nothing
// else; and a read never overtakes a write of this tab's own.
//
// WHY. `ChatStore.write()` deleted by ABSENCE: every id the list it was handed
// did not mention was removed from the database. Every other merge in this app
// deletes on a tombstone and nothing else, and there was one reason for the
// asymmetry — with `localStorage.setItem` of the whole array there was no window
// in which a list could be short. Transcripts moved to IndexedDB today, and an
// asynchronous store has one: `save()` sets the in-memory mirror and returns,
// and a `refresh()` taken before the write behind it lands reads the contents
// from BEFORE the save and installs them as the mirror. The next caller to build
// a list out of that mirror hands `write()` a short one, and the chats it left
// out are deleted, permanently, with no tombstone and nothing said.
//
// `applyChats` does exactly that pair — save the merge, then refresh — so the
// window is not hypothetical. This project has a data-loss incident on record
// from a field doing double duty (the tags, seq 48), and the rule out of it is
// that the safe direction is the one that keeps the data.
//
//   1. A chat left out of a save with no tombstone SURVIVES.
//   2. A chat with a tombstone is still deleted — the fix must not turn the
//      store into a place nothing can leave.
//   3. A tombstone that arrives from the OTHER device deletes here too, because
//      the merge persists it before it saves.
//   4. `refresh()` does not read past a write of this tab's own.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.
import { open, chat, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// The ids the DATABASE holds, read from outside the app so the answer is the
/// disk's and not the app's belief about it.
const onDisk = (s) => s.page.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats', 1);
	req.onsuccess = () => {
		const db = req.result;
		let t;
		try { t = db.transaction('chats', 'readonly'); } catch (e) { res([]); return; }
		const out = [];
		const cur = t.objectStore('chats').openCursor();
		cur.onsuccess = () => { const c = cur.result; if (c) { out.push(c.value.id); c.continue(); } else res(out.sort()); };
		cur.onerror = () => res(out.sort());
	};
	req.onerror = () => res([]);
}));

const s = await open({ name: 'chatkeep' });
const p = s.page;

try {
	// Three real chats, each with a turn in it, so there is something to lose.
	await chat(s, '@text keep one');
	await p.click('#new-session-btn'); await p.waitForTimeout(300);
	await chat(s, '@text keep two');
	await p.click('#new-session-btn'); await p.waitForTimeout(300);
	await chat(s, '@text keep three');
	await p.waitForTimeout(800);

	const start = await onDisk(s);
	check('three chats are on disk to begin with', start.length >= 3, start.length + ' rows');

	// ── 1. A short list is not a deletion ──────────────────────────────
	// The store is handed a list naming ONE of them, with no tombstone for the
	// others: exactly the shape a refresh() that overtook a write produces.
	const shortSave = await p.evaluate(async () => {
		const store = window.DaimondCore.chatStore();
		const all   = store.stored();
		const one   = all.slice(0, 1);
		store.save(one);
		await new Promise(r => setTimeout(r, 600));
		return { asked: one.map(c => c.id), had: all.map(c => c.id).sort() };
	});
	const afterShort = await onDisk(s);
	check('a chat left out of a save with NO tombstone is still on disk',
		shortSave.had.every(id => afterShort.indexOf(id) !== -1),
		'asked to hold ' + shortSave.asked.length + ' of ' + shortSave.had.length
			+ ', disk holds ' + afterShort.length);

	// ── 2. A tombstone still deletes ───────────────────────────────────
	const victim = shortSave.had.find(id => id !== shortSave.asked[0]);
	await p.evaluate(async (id) => {
		const k = 'daimond-chats-deleted';
		const t = JSON.parse(localStorage.getItem(k) || '{}');
		t[id] = Date.now();
		localStorage.setItem(k, JSON.stringify(t));
		const store = window.DaimondCore.chatStore();
		store.save(store.stored().filter(c => c.id !== id));
		await new Promise(r => setTimeout(r, 600));
	}, victim);
	const afterTomb = await onDisk(s);
	check('a chat WITH a tombstone is deleted — the store is not a place nothing leaves',
		afterTomb.indexOf(victim) === -1, victim + ' still present: ' + (afterTomb.indexOf(victim) !== -1));
	check('and the ones beside it are untouched',
		shortSave.had.filter(id => id !== victim).every(id => afterTomb.indexOf(id) !== -1),
		afterTomb.join(','));

	// ── 3. A tombstone from the other device deletes here too ──────────
	// `applySync` merges the remote tombstone map into localStorage before it
	// saves, so by the time `write()` looks there is a tombstone to find. Without
	// that, a deletion made on the other device would never travel.
	const remoteVictim = afterTomb.find(id => id !== shortSave.asked[0]) || afterTomb[0];
	await p.evaluate(async (id) => {
		await window.DaimondCore.applySync({ chats: [], tombs: { [id]: Date.now() } });
		await new Promise(r => setTimeout(r, 800));
	}, remoteVictim);
	const afterRemote = await onDisk(s);
	check('a deletion made on the OTHER device travels and takes the chat with it',
		afterRemote.indexOf(remoteVictim) === -1, remoteVictim);

	// ── 4. A read does not overtake a write ────────────────────────────
	// `save()` then `refresh()` with no wait between them is the pair
	// `applyChats` makes. The refresh must come back with what was just saved,
	// not with what was on disk before it.
	const race = await p.evaluate(async () => {
		const store = window.DaimondCore.chatStore();
		const all   = store.stored();
		const born  = {
			id: 'raced-' + Date.now(), name: 'Raced In', messages: [{ role: 'user', content: 'raced', mid: 'r1', ts: Date.now() }],
			updatedAt: Date.now(), status: 'active',
		};
		// TWO saves, the second queued behind the first. That is the shape that
		// actually loses the read: IndexedDB orders a transaction after the ones
		// already created, so a read taken while ONE write is in flight is served
		// after it — but a save still sitting in `queued` has no transaction yet,
		// and the read goes in front of it and comes back without its contents.
		store.save(all);
		store.save(all.concat([born]));
		// No wait: straight into the read, which is what applyChats does.
		const read = await store.refresh();
		// And then the round that follows, built out of whatever the refresh left
		// in the mirror. THIS is where the loss actually happened: a short mirror
		// becomes a short list, and a short list used to be a deletion.
		store.save(store.stored());
		await new Promise(r => setTimeout(r, 700));
		return { id: born.id, seen: read.some(c => c.id === born.id), count: read.length };
	});
	check('a refresh taken straight after a save comes back with the save in it',
		race.seen === true, race.id + ' in a mirror of ' + race.count);
	const afterRace = await onDisk(s);
	check('and the next save does not delete what the refresh dropped',
		afterRace.indexOf(race.id) !== -1, afterRace.join(','));

	const errs = errors(s).filter(e => !/favicon|ERR_|Failed to load resource|401|402|502/.test(e));
	check('nothing else threw', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally {
	await s.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
