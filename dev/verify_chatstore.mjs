// verify_chatstore.mjs — where a transcript lives, and what happens when it cannot be saved.
//
// Chats were persisted to localStorage, which holds about five megabytes for the
// WHOLE ORIGIN — shared with the ledger, the provider table, the mail state and
// everything else the app keeps. `setItem` throws when that is full, and the throw
// was caught and dropped:
//
//     catch (e) { /* quota or unavailable — chats stay in-memory this session */ }
//
// So the work went on being shown and went on being answered, and simply stopped
// being saved. The user found out on the next reload, when it was gone.
//
// Three properties are asserted here, and each is the failure written out:
//
//   1. A transcript lands in IndexedDB, and what localStorage already held is
//      carried across rather than stranded.
//   2. With localStorage at its real ceiling — filled here, in this browser,
//      until it actually refuses — a turn taken afterwards SURVIVES A RELOAD.
//   3. When the store itself fails, the user is TOLD, standing on screen, with
//      the one action that rescues the work: write it to a file now.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099).
import { open, chat, signInAs, errors, contentText } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Everything the IndexedDB chat store holds, read from OUTSIDE the app so the
/// answer is the disk's and not the app's belief about it.
const readStore = (s) => s.page.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats', 1);
	req.onsuccess = () => {
		const db = req.result;
		let t;
		try { t = db.transaction('chats', 'readonly'); } catch (e) { res([]); return; }
		const out = [];
		const cur = t.objectStore('chats').openCursor();
		cur.onsuccess = () => { const c = cur.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
		cur.onerror = () => res(out);
	};
	req.onerror = () => res([]);
}));

async function reloadAndIn(s, name) {
	await s.page.reload({ waitUntil: 'domcontentloaded' });
	await s.page.waitForTimeout(1200);
	await signInAs(s, name);
	await s.page.waitForTimeout(1000);
}

const NAME = 'chatstore';
const s = await open({ name: NAME });
const p = s.page;

// ── 1. The transcript goes to IndexedDB, and localStorage is left alone ────

await chat(s, '@text first thing');
const rows = await readStore(s);
check('a turn is stored in IndexedDB', rows.length > 0 && (rows[0].messages || []).length > 0,
	`${rows.length} chats, ${rows.length ? (rows[0].messages || []).length : 0} messages`);

const lsAfter = await p.evaluate(() => ({
	chats:  localStorage.getItem('daimond-chats'),
	rev:    localStorage.getItem('daimond-chats-rev'),
}));
check('and localStorage is no longer where transcripts are written', !lsAfter.chats,
	lsAfter.chats ? `${lsAfter.chats.length} bytes still there` : 'absent');
check('a nonce is written instead, so the other tab still learns of the change', !!lsAfter.rev);

// ── 2. A store already in localStorage is carried across, not stranded ─────

const SEEDED_ID = 'c9001';
await p.evaluate((id) => {
	localStorage.setItem('daimond-chats', JSON.stringify([{
		id: id,
		name: 'From The Old Store',
		model: 'mock/fast',
		provider: 'custom',
		status: 'active',
		updatedAt: Date.now(),
		messages: [
			{ role: 'user', content: 'a question from before the move', mid: 'm-old-1', ts: 1 },
			{ role: 'assistant', content: 'an answer from before the move', mid: 'm-old-2', ts: 2 },
		],
	}]));
}, SEEDED_ID);

// The chat this test writes its transcript into, held by id so every later
// step drives THAT one whatever order the rail chooses to draw.
const workingChatId = await p.evaluate(() => {
	const on = document.querySelector('#session-list .chat-box.active')
		|| document.querySelector('#session-list .chat-box');
	return on ? on.dataset.id : '';
});

await reloadAndIn(s, NAME);

const migrated = await readStore(s);
const found = migrated.find(c => c.id === SEEDED_ID);
check('a chat sitting in the old localStorage store is migrated on the next boot',
	!!found, found ? `"${found.name}", ${(found.messages || []).length} messages` : 'not migrated');
check('with its transcript intact',
	!!(found && (found.messages || []).some(m => m.content === 'a question from before the move')));
// The tile's name is an <input>, so its value is the label — textContent is blank.
const onRail = await p.evaluate(() => [...document.querySelectorAll('#session-list .chat-box')]
	.map(b => { const i = b.querySelector('.tile-when'); return (i ? i.textContent.trim() : '') + ' ' + b.textContent; }).join(' | '));
check('and it is on the rail, where the user can see it', /From The Old Store/.test(onRail));

const afterMig = await p.evaluate(() => ({
	live:    localStorage.getItem('daimond-chats'),
	archive: localStorage.getItem('daimond-chats-legacy'),
}));
check('the old key is consumed, so nothing unions it back in and resurrects a deletion',
	!afterMig.live);
check('but it is kept under an archive name, so an old transcript is still readable',
	!!afterMig.archive && afterMig.archive.indexOf('From The Old Store') !== -1,
	afterMig.archive ? `${afterMig.archive.length} bytes` : 'gone');

// ── 3. With localStorage genuinely full, the work still survives a reload ──
//
// Filled here, in this browser, until `setItem` actually refuses — not simulated.
// One chunk is then freed, so the small unrelated writes the app makes (a chat
// counter, a tombstone) still land: the case under test is "the transcript no
// longer fits", not "nothing at all fits".

const filled = await p.evaluate(() => {
	const CHUNK = 64 * 1024;
	const pad = 'x'.repeat(CHUNK);
	let n = 0;
	let err = '';
	try {
		for (; n < 400; n++) localStorage.setItem('__fill_' + n, pad);
	} catch (e) { err = e.name || String(e); }
	try { localStorage.removeItem('__fill_' + (n - 1)); } catch (e) { /* nothing to free */ }
	return { chunks: n, bytes: n * CHUNK, err };
});
check('localStorage really does run out, and says so', filled.err === 'QuotaExceededError',
	`${(filled.bytes / 1048576).toFixed(1)} MB in, then ${filled.err}`);

const wouldHaveFailed = await p.evaluate(() => {
	// The write the old code made on every turn, with a transcript no bigger than
	// a morning's work. This is the line that used to throw and be swallowed.
	const oneDay = JSON.stringify([{ id: 'x', messages: Array.from({ length: 40 },
		(_, i) => ({ role: 'tool_log', content: 'y'.repeat(8192), mid: 'k' + i })) }]);
	try { localStorage.setItem('daimond-chats', oneDay); localStorage.removeItem('daimond-chats'); return ''; }
	catch (e) { return e.name || String(e); }
});
check('and a day of tool results is exactly what it refuses',
	wouldHaveFailed === 'QuotaExceededError', wouldHaveFailed || 'it fitted, which it should not have');

// Now work, with the origin's localStorage in that state.
// THE CHAT THIS TEST MEANS, not whichever tile happens to be first. Chat tiles
// now list newest-touched first, which put the MIGRATED chat at the top — a
// chat carrying no model, so the turn typed into it went nowhere and ten checks
// failed for a reason that had nothing to do with storage. The house rule is to
// assert meaning rather than position; it applies to what a test DRIVES just as
// much as to what it checks.
await p.evaluate((id) => {
	const b = [...document.querySelectorAll('#session-list .chat-box')]
		.find(x => x.dataset.id === id);
	if (b) b.click();
}, workingChatId);
await p.waitForTimeout(500);
await chat(s, '@text written while localStorage was full');
const fullRows = await readStore(s);
check('a turn taken with localStorage full still reaches the store',
	JSON.stringify(fullRows).includes('written while localStorage was full'));

await reloadAndIn(s, NAME);
const survived = await p.evaluate(() => document.body.innerText);
const survivedStore = await readStore(s);
check('and it is still there after a reload — the failure this replaces, undone',
	JSON.stringify(survivedStore).includes('written while localStorage was full'),
	survived.includes('written while localStorage was full') ? 'and on the rail' : '');

const quota = await p.evaluate(() => navigator.storage.estimate().then(e => e.quota));
check('the store it moved to is sized for the job', quota > 100 * 1024 * 1024,
	`${(quota / 1073741824).toFixed(1)} GB quota`);

// ── 4. A tool result is shortened on its way in, and says how much went ────

// THE CHAT THIS TEST MEANS, not whichever tile happens to be first. Chat tiles
// now list newest-touched first, which put the MIGRATED chat at the top — a
// chat carrying no model, so the turn typed into it went nowhere and ten checks
// failed for a reason that had nothing to do with storage. The house rule is to
// assert meaning rather than position; it applies to what a test DRIVES just as
// much as to what it checks.
await p.evaluate((id) => {
	const b = [...document.querySelectorAll('#session-list .chat-box')]
		.find(x => x.dataset.id === id);
	if (b) b.click();
}, workingChatId);
await p.waitForTimeout(400);
// THE CHAT'S OWN SCRATCH, not the workspace root, and it has to stay that way.
// This wrote `big.txt` at the root until 2026-08-14; since the chat fence landed on
// 2026-08-12 a chat is confined to `chats/<id>/work` (`scopeChatTo`,
// www/js/daimond.js) and `Tool::guard` (src/tools.rs:5490) refuses a root path before
// the write. The refusal arrives as an ordinary tool result — a SHORT one — so
// nothing was written, the read that follows found nothing, and the 20 KB tool
// result these three checks are about never existed.
const BIGPATH = await p.evaluate((id) => window.DaimondAttach.chatScratch(id), workingChatId) + '/big.txt';
const BIG = 'Z'.repeat(20000);
const bigWrite = await chat(s, '@tool file_write {"path":"' + BIGPATH + '","content":"' + BIG + '"}');
check('the big file was really written — a refused write leaves no large result to shorten',
	!/Refused/.test(bigWrite) && /Wrote \d+ bytes/.test(bigWrite),
	bigWrite.slice(-140).replace(/\n/g, ' | '));
await chat(s, '@tool file_read {"path":"' + BIGPATH + '"}');

const withTool = await readStore(s);
const toolRows = [];
withTool.forEach(c => (c.messages || []).forEach(m => { if (m.role === 'tool_log') toolRows.push(m); }));
const bigRow = toolRows.find(m => (m.elided || 0) > 0);
check('a large tool result is shortened on its way into storage', !!bigRow,
	bigRow ? `${bigRow.content.length} chars kept, ${bigRow.elided} elided` : 'nothing was shortened');
check('and the record says how much went, rather than quietly losing it',
	!!(bigRow && /more characters of this result were not saved/.test(bigRow.content)));
// The TOOL REPLY specifically, not merely the bytes somewhere in the session: the
// same 20 KB is also in the call's arguments, so a looser search would pass even
// with the reply shortened.
check('the model\'s own copy is NOT shortened — it had the whole thing',
	withTool.some(c => c.session && (c.session.msgs || []).some(m =>
		m.role === 'tool' && typeof m.content === 'string' && m.content.length > 10000)),
	JSON.stringify(withTool.map(c => (c.session ? (c.session.msgs || []).filter(m => m.role === 'tool')
		.map(m => contentText(m.content).length) : [])).flat()));

// ── 5. When the store fails, the user is told, and can act ────────────────
//
// The failure is injected — a browser cannot be made to lose IndexedDB on
// request — but it is injected at the store's own door, and what is asserted is
// entirely the app's response to it. The old code's response was nothing at all.

await p.evaluate(() => {
	window.__realPut = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = function () {
		if (this.name === 'chats') throw new DOMException('injected failure', 'QuotaExceededError');
		return window.__realPut.apply(this, arguments);
	};
});
await chat(s, '@text this one cannot be saved');
await p.waitForTimeout(900);

const alarm = await p.evaluate(() => {
	const box = document.querySelector('.storage-alarm');
	if (!box) return null;
	const r = box.getBoundingClientRect();
	return {
		text:    box.innerText,
		visible: r.width > 0 && r.height > 0,
		role:    box.getAttribute('role'),
		buttons: [...box.querySelectorAll('button')].map(b => b.textContent),
	};
});
check('a write that fails puts a standing warning on screen', !!(alarm && alarm.visible),
	alarm ? alarm.text.replace(/\n/g, ' / ').slice(0, 110) : 'nothing was shown');
check('it says the conversations are not being saved, in those words',
	!!(alarm && /not being saved/i.test(alarm.text)));
check('it names the cause the user can act on',
	!!(alarm && /no room left/i.test(alarm.text)), alarm ? '' : 'no alarm');
check('and it carries the move that rescues the work now',
	!!(alarm && alarm.buttons.some(b => /download/i.test(b))),
	alarm ? alarm.buttons.join(', ') : '');
check('it is announced, not only drawn', !!(alarm && alarm.role === 'alert'));

// It clears itself when saving works again, rather than crying wolf for ever.
await p.evaluate(() => { IDBObjectStore.prototype.put = window.__realPut; });
await p.evaluate(() => {
	const b = [...document.querySelectorAll('.storage-alarm button')].find(x => /try again/i.test(x.textContent));
	if (b) b.click();
});
await p.waitForTimeout(1200);
const gone = await p.evaluate(() => !document.querySelector('.storage-alarm'));
check('and it goes when a save lands again', gone);

// The app's own console.error is part of what is asserted above — a failure
// that reaches the console as well as the screen — so it is not counted here.
const errs = errors(s).filter(e => !/502|Bad Gateway|injected failure|conversations are not being saved/.test(e));
check('nothing else threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
