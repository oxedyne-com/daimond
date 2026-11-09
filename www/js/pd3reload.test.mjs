// pd3reload.test.mjs -- a reload with a hand-off in flight draws the unlock gate, and the chats after it (PD3).
//
//	node --test www/js/pd3reload.test.mjs
//
// W1-B walk, 08 Nov 2026 (shots 35-41): a tab reloaded while a Kimberlite turn was in flight came
// up locked with no unlock gate ("Browser-only", "No model"), because the boot awaited the chat
// store's read before it asked whether to lock, and that store had stopped answering. After an
// unlock the rail then read "No chats yet": an empty list from a store that was never read.
//
//	R1  a locked boot draws the unlock gate while the chat read is still out;
//	R2  an unlock pressed before the read returns draws the app only from the chats it returns,
//	    so the chat and its sent turn are listed;
//	R3  a rail drawn from a store that was not read says so, never "No chats yet";
//	R4  a diamond's chat drawn from a store that was not read says so, never "No conversation yet";
//	R5  `__DAIMOND_READY` is set where boot ends, not at the engine's load: a boot still asking
//	    whether to lock is not ready, and a drive waiting on it must not read it as such;
//	R6  the real store, beside a live tab on an older build that holds it open: the upgrade is
//	    blocked, the unlock gate is drawn, and after the unlock the rail says the chats were not
//	    read rather than "No chats yet";
//	R7  once that store answers again (Try again, a new save, or a stall that ends) it is read,
//	    his chat comes back, and a write alone never vouches for a store that was not read;
//	R8  a lock that lands while the unlock waits on the read draws nothing of his;
//	R9  two presses of Unlock during the wait run the unlock once, and the button is off meanwhile;
//	R10 the no-identity and removed-device draws wait on the read, and ready is set once, after it;
//	R11 the logs an unlock reads are read for the chats the boot's read returns, not the empty list;
//	R12 a pull once the older tab has closed reads the store again before it judges the merge, so
//	    with no save and no Try again the pull merges and his chat comes back.
//	R13 the refresh whose read lands on a store that was not read clears its "not read" alarm;
//	R14 a boot that moves the old localStorage chats into the store has read it first, so the
//	    move's write sets the count an empty read is judged against.
//	R15 a pull that reads a store whose boot read failed loads the deletions held in IndexedDB first,
//	    so a peer's copy of a chat deleted here is not taken back;
//	R16 the same over Try again;
//	R17 a pull whose re-read runs out on a stalled store reads it once it answers, with no further pull;
//	R18 a boot whose read of the deletions fails leaves the store unread, and the read that lands
//	    loads them;
//	R19 the cross-tab re-read of a store whose boot failed takes the deletions after the read, so a
//	    deleted chat whose row is still on disk is not listed;
//	R20 pulls during a stall open nothing more until the store answers;
//	R21 a later read starts no second slim pass;
//	R22 a read of a store already read clears no alarm it did not raise (a write failure's).
//
// The real boot.js, passkey_phrase.js, tilestyle.js and agentspanel.js; everything they call
// outside this path is stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';
import { fakeIdb } from './test/chatidb.mjs';
import { loadScript } from '../../dev/syncprobe.mjs';

const ticks = (n = 20) => new Promise((r) => setTimeout(r, n));
const noop = () => {};
const el = () => ({ textContent: '', style: { removeProperty: noop, setProperty: noop }, dataset: {}, children: [],
	classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
	addEventListener: noop, appendChild(c) { this.children.push(c); return c; }, setAttribute: noop,
	querySelector: () => null, querySelectorAll: () => [], remove: noop, getAttribute: () => null,
	get innerHTML() { return ''; }, set innerHTML(v) { this.children = []; },
	getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) });

function page(over, store) {
	const w = makeWindow({ now: 1_800_000_000_000 });
	if (store) store(w);
	const els = {};
	const body = el();
	body.locked = false;
	body.classList = { add: (c) => { if (c === 'locked') body.locked = true; },
		remove: (c) => { if (c === 'locked') body.locked = false; }, contains: () => false, toggle: noop };
	w.document = { body, documentElement: el(), fonts: null, visibilityState: 'visible',
		getElementById: (id) => (els[id] = els[id] || el()), createElement: () => el(),
		querySelector: () => null, querySelectorAll: () => [], addEventListener: noop };
	w.DaimondCore = {};
	w.DaimondTime = { fmtLocal: () => '' };
	let unlocked = true;
	w.DaimondIdentity = { existsSettled: async () => true, restoring: async () => ({ ok: false }), removed: () => false,
		isUnlocked: () => unlocked, _set: (v) => { unlocked = v; } };
	w.performance = { now: () => 1 };
	const seen = { gate: [], drawn: [], after: 0, ready: 0 };
	let ready;
	Object.defineProperty(w, '__DAIMOND_READY', { configurable: true, get: () => ready,
		set: (v) => { if (v === true) seen.ready++; ready = v; } });
	let P;
	const stub = {
		initTheme: noop, initSkin: noop, initView: noop, fitComposer: noop, installSecretMask: noop,
		secretEye: noop, watchAgentsPanel: noop, initPauseUi: noop, initCompose: noop,
		Files: { init: noop, retireMachineFolder: async () => {} }, Workers: { render: noop },
		mshow: noop, init: async () => {}, install_panic_hook: noop, watchHeap: noop,
		learnEngineId: async () => {}, set_account_ns: noop,
		takePendingTaint: noop, rebuildDispatchedIndex: noop, ensureDispatchedResident: noop,
		updateUserRow: noop, identityAvailable: () => true,
		showIdentity: (mode) => seen.gate.push(mode), hideIdentity: noop,
		renderAll: () => seen.drawn.push(P.pg.chats.map((c) => c.id + ':' + c.messages.length)),
		fillSettings: noop, orphanIdentityEvidence: () => false, showRecover: noop,
		cfgReady: () => true, openSettings: noop,
		chatInputBar: el(), sessionNameEl: el(),
		syncAccountFromIdentity: noop, trail: noop, afterUnlock: async () => { seen.after++; }, noteHeldPasskey: noop,
		dsEvent: noop, browserOf: () => '', unmigrateInherit: noop,
		t: (k) => k, tOr: (k) => k,
		DaimondPanels: { init: noop }, DaimondAdmin: { init: noop, homeContent: noop, status: noop },
		...over,
	};
	P = loadPage({ window: w, stub, want: ['boot', 'completeUnlock', 'renderSessionList', 'ChatStore', 'readLogsAtBoot', 'selectDiamond', 'applyChats'] });
	return { P, w, seen, els, body };
}

// The chat the walk sent its turn in, with its hand-off out to Kimberlite.
const sent = { id: 'c-walk', name: 'drive-w1b-2033', diamondId: '', updatedAt: 2,
	messages: [{ role: 'user', content: 'Move the workspace entry.', mid: 'm1', handoff: { iturn: 'i-1', state: 'dispatched' } }] };

// The page's real ChatStore over the in-memory IndexedDB `data`.
const realStore = (data, gate) => (w) => {
	w.indexedDB = fakeIdb(data, gate).idb;
	w.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
	w.setTimeout = setTimeout;
	w.clearTimeout = clearTimeout;
	w.DaimondPolicy = { storeWaitMs: () => 200, storePieceBytes: () => 32768, tombTtlMs: () => 37 * 86400e3 };
	loadScript(w, 'storewait.js');
};

// A store an older tab holds open at v3 and will not let go of, with the walk's chat on disk.
function blockedStore() {
	const data = new Map();
	data.ver = 3;
	data.conns = new Set([{ close() {} }]);
	data.set('chats', new Map([[sent.id, sent]]));
	return data;
}

function heldLoad() {
	let give;
	const p = new Promise((r) => { give = r; });
	return { load: () => p, give };
}

test('R1: a locked boot draws the unlock gate while the chat read is still out', async () => {
	const h = heldLoad();
	const { P, w, seen, body } = page({ loadChatsHeld: h.load });
	P.boot();
	await ticks();
	assert.deepEqual(seen.gate, ['unlock'], 'the unlock gate is drawn though the chat store has not answered');
	assert.equal(w.__DAIMOND_READY, true, 'and the boot has ended, so it is ready');
	assert.ok(body.locked, 'the page is locked behind it');
	assert.deepEqual(seen.drawn, [], 'nothing of his is drawn behind the gate');
	h.give([sent]);
});

test('R2: an unlock before the read returns waits for it, and lists the chat with its sent turn', async () => {
	const h = heldLoad();
	const { P, seen, els } = page({ loadChatsHeld: h.load });
	P.boot();
	await ticks();
	assert.deepEqual(seen.gate, ['unlock'], 'the gate is up');
	const unlocked = P.completeUnlock();
	await ticks();
	assert.deepEqual(seen.drawn, [], 'the app is not drawn from the empty list the chats start as');
	assert.equal(els['id-error'].textContent, 'identity.reading_chats', 'the gate says what it waits on');
	h.give([sent]);
	await unlocked;
	assert.deepEqual(seen.drawn, [['c-walk:1']], 'the chat and its sent turn are listed');
	assert.equal(els['id-error'].textContent, '', 'and the wait line is gone');
});

function rail(usable) {
	const list = el();
	const { P } = page({ loadChatsHeld: async () => [], sessionList: list, repaintPause: noop,
		ChatStore: { read: () => usable } });
	P.pg.locked = false;
	P.pg.chats = [];
	P.renderSessionList();
	return list.children.map((c) => c.textContent);
}

test('R3: a rail drawn from a store that was not read says so', () => {
	assert.deepEqual(rail(false), ['store.chats_unread']);
	assert.deepEqual(rail(true), ['rail.no_chats'], 'a store that was read and is empty still says so');
});

// The diamond's chat face drawn on an empty thread, the store read or not.
async function diamondThread(read) {
	const out = el();
	const rec = { id: 'd-1:daimon', messages: [], _loaded: true };
	const { P } = page({ loadChatsHeld: async () => [], ChatStore: { read: () => read },
		chatOutput: out, daimonChat: () => rec, DaimondLayers: { leave: noop }, moveComposerTo: noop,
		signalDiamondChanged: noop, updateActiveDiamond: noop, setDiamondWhen: noop, diamondView: () => 'chat',
		setDiamondView: noop, tabViewSet: noop, setCurrent: noop, updateActiveSession: noop, showCentre: noop,
		renderHistory: noop, syncComposer: noop, renderChatAttachments: noop, syncAttachPrefix: noop,
		renderQueue: noop, resumeSteerQueue: noop });
	await P.selectDiamond({ id: 'd-1', name: 'Walk' }, 'chat');
	return out.children.map((c) => c.textContent);
}

test('R4: a diamond chat drawn from a store that was not read says so', async () => {
	assert.deepEqual(await diamondThread(false), ['store.chats_unread']);
	assert.deepEqual(await diamondThread(true), ['crystal.chat_empty'], 'a store that was read and is empty still says so');
});

test('R5: a boot still asking whether to lock is not ready', async () => {
	let say;
	const { P, w, seen } = page({ loadChatsHeld: async () => [sent] });
	w.DaimondIdentity.existsSettled = () => new Promise((r) => { say = r; });
	P.boot();
	await ticks();
	assert.notEqual(w.__DAIMOND_READY, true, 'not ready while the identity question is open');
	assert.deepEqual(seen.gate, [], 'and no gate yet');
	say(true);
	await ticks();
	assert.deepEqual(seen.gate, ['unlock']);
	assert.equal(w.__DAIMOND_READY, true, 'ready once the gate is drawn');
});

test('R6: a blocked upgrade beside a live older tab draws the gate, and the rail says the chats were not read', async () => {
	const data = new Map();
	data.ver = 3;
	data.conns = new Set([{ close() {} }]);	// the live tab: it holds v3 open and does not close on versionchange
	data.set('chats', new Map([[sent.id, sent]]));
	const list = el();
	const { P, seen } = page({ sessionList: list, repaintPause: noop }, realStore(data));
	P.boot();
	await ticks(400);
	assert.deepEqual(seen.gate, ['unlock'], 'the unlock gate is drawn though the upgrade is blocked');
	assert.equal(data.ver, 3, 'the upgrade was blocked');
	await P.completeUnlock();
	assert.equal(P.ChatStore.usable(), false, 'the store is not usable');
	P.pg.locked = false;
	P.renderSessionList();
	assert.deepEqual(list.children.map((c) => c.textContent), ['store.chats_unread'], 'never "No chats yet"');
});

const ids = (P) => P.pg.chats.map((c) => c.id).sort();
const railOf = (list) => list.children.map((c) => c.textContent || c.className);

async function blockedAndUnlocked(over = {}, data = blockedStore()) {
	const list = el();
	const got = page({ sessionList: list, repaintPause: noop, renderHistory: noop, renderEmptyState: noop, ...over }, realStore(data));
	got.P.boot();
	await ticks(400);
	await got.P.completeUnlock();
	got.P.pg.locked = false;
	got.P.renderSessionList();
	assert.deepEqual(railOf(list), ['store.chats_unread']);
	return { ...got, data, list };
}

test('R7a: Try again once the older tab has closed reads the store and lists his chat', async () => {
	const { P, data, list } = await blockedAndUnlocked();
	data.conns.clear();
	P.ChatStore.retry();
	await ticks(400);
	assert.deepEqual(ids(P), ['c-walk'], 'his chat is back');
	assert.ok(!railOf(list).includes('rail.no_chats') && !railOf(list).includes('store.chats_unread'), 'the rail lists it, with no note');
});

test('R7b: a new save once the older tab has closed reads the store and keeps both chats', async () => {
	const { P, data, list } = await blockedAndUnlocked();
	const fresh = { id: 'c-new', name: 'new', updatedAt: 3, messages: [{ role: 'user', content: 'hi', mid: 'n1' }] };
	P.pg.chats.push(fresh);
	P.renderSessionList();
	assert.equal(railOf(list)[0], 'store.chats_unread', 'the note stands beside a chat made since');
	data.conns.clear();
	P.ChatStore.save(P.pg.chats.slice());
	await ticks(400);
	assert.deepEqual(ids(P), ['c-new', 'c-walk'], 'his chat comes back beside the new one');
});

test('R7c: a write that lands before any read does not vouch for the store', async () => {
	const { P, data } = await blockedAndUnlocked();
	let readAtWrite = null;
	data.conns.clear();
	P.ChatStore.save([]);
	await ticks(0);
	for (let i = 0; i < 50 && readAtWrite === null; i++) {
		if (P.ChatStore.usable()) readAtWrite = P.ChatStore.read();
		await new Promise((r) => setImmediate(r));
	}
	assert.equal(readAtWrite, false, 'the landed write alone leaves it unread');
	await ticks(400);
	assert.equal(P.ChatStore.read(), true, 'the read that follows reads it');
});

test('R7d: a store that stalled at boot is read once it answers', async () => {
	const data = new Map();
	data.set('chats', new Map([[sent.id, sent]]));
	let hold = true;
	const held = [];
	const gate = (fn) => (hold ? held.push(fn) : fn());
	const list = el();
	const { P } = page({ sessionList: list, repaintPause: noop, renderHistory: noop, renderEmptyState: noop }, realStore(data, gate));
	P.boot();
	await ticks(400);
	await P.completeUnlock();
	assert.equal(P.ChatStore.stalled(), true, 'the boot read ran out');
	assert.deepEqual(ids(P), []);
	hold = false;
	held.splice(0).forEach((fn) => fn());
	await ticks(400);
	assert.deepEqual(ids(P), ['c-walk'], 'read once it answered');
});

test('R8: a lock while the unlock waits on the read draws nothing of his', async () => {
	const h = heldLoad();
	const { P, w, seen, body } = page({ loadChatsHeld: h.load });
	P.boot();
	await ticks();
	const u = P.completeUnlock();
	await ticks();
	w.DaimondIdentity._set(false);
	h.give([sent]);
	await u;
	assert.deepEqual(seen.drawn, [], 'nothing drawn after the identity locked');
	assert.equal(P.pg.locked, true);
	assert.ok(body.locked, 'the page stays locked');
});

test('R9: two presses of Unlock while the read is out run the unlock once', async () => {
	const h = heldLoad();
	const { P, w, seen } = page({ loadChatsHeld: h.load });
	const btn = w.document.getElementById('id-primary');
	P.boot();
	await ticks();
	const a = P.completeUnlock();
	const b = P.completeUnlock();
	await ticks();
	assert.equal(btn.disabled, true, 'Unlock is off while the read is out');
	h.give([sent]);
	await a; await b;
	assert.equal(seen.after, 1, 'the unlock ran once');
	assert.deepEqual(seen.drawn, [['c-walk:1']], 'and drew once');
	assert.equal(btn.disabled, false, 'and Unlock is on again');
});

for (const path of ['none', 'removed']) {
	test('R10 ' + path + ': the draw waits on the read, and ready is set once, after it', async () => {
		const h = heldLoad();
		const { P, w, seen } = page({ loadChatsHeld: h.load });
		w.DaimondIdentity.existsSettled = async () => false;
		if (path === 'removed') w.DaimondIdentity.removed = () => true;
		const done = P.boot();
		await ticks();
		assert.deepEqual(seen.drawn, [], 'nothing drawn from the empty list the chats start as');
		assert.equal(seen.ready, 0, 'not ready before the read lands');
		h.give([sent]);
		await done;
		assert.deepEqual(seen.drawn, [['c-walk:1']], 'drawn with his chat');
		assert.equal(seen.ready, 1, 'ready once');
	});
}

test('R11: the logs an unlock reads wait for the boot\'s chats', async () => {
	const h = heldLoad();
	const got = [];
	const { P } = page({ loadChatsHeld: h.load, logPlaces: () => ({ 'c-walk': { views: { v: 1 } } }),
		loadChatMessages: async () => {}, readChatLog: async (c) => { got.push(c.id); } });
	P.boot();
	await ticks();
	const reading = P.readLogsAtBoot();
	await ticks();
	assert.deepEqual(got, [], 'nothing read from the empty list the chats start as');
	h.give([sent]);
	await reading;
	assert.deepEqual(got, ['c-walk'], 'the chat with a view in this place has its log read');
});

test('R12: a pull once the older tab has closed reads the store and merges, with no save or Try again', async () => {
	const { P, data } = await blockedAndUnlocked();
	data.conns.clear();
	let threw = null;
	try { await P.applyChats({ chats: [], tombs: {}, msgTombs: {} }, 'peer'); } catch (e) { threw = e.message; }
	assert.equal(threw, null, 'the pull merges');
	assert.equal(P.ChatStore.read(), true, 'the pull read the store');
	assert.deepEqual(ids(P), ['c-walk'], 'his chat is back');
});

test('R13: the refresh whose read lands clears the "not read" alarm', async () => {
	const alarm = { up: [], cleared: [] };
	const { P, data } = await blockedAndUnlocked({ storageAlarm: (why, src) => alarm.up.push(src),
		storageAlarmClear: (src) => alarm.cleared.push(src) });
	assert.ok(alarm.up.includes(undefined), 'the failed boot read raised the "not read" alarm');
	data.conns.clear();
	const before = alarm.cleared.length;
	await P.ChatStore.refresh();
	assert.equal(P.ChatStore.read(), true, 'the refresh read the store');
	assert.ok(alarm.cleared.slice(before).includes(undefined), 'and cleared the alarm: ' + JSON.stringify(alarm.cleared));
});

test('R14: moving the old localStorage chats sets the count an empty read is judged against', async () => {
	const data = new Map();
	const { P, w } = page({}, realStore(data));
	w.localStorage.setItem('daimond-chats', JSON.stringify([sent]));
	await P.ChatStore.boot();
	assert.equal(P.ChatStore.read(), true, 'the store was read');
	assert.equal(w.localStorage.getItem('daimond-chats'), null, 'the old key was moved');
	assert.equal(w.localStorage.getItem('daimond-chats-count'), '1', 'the move\'s write set the count');
});

// A chat deleted here an hour ago, its deletion held in IndexedDB and not in the localStorage cache.
const DEAD = { id: 'c-dead', name: 'deleted', diamondId: '', updatedAt: 1,
	messages: [{ role: 'user', content: 'gone', mid: 'd1' }] };
const DEAD_AT = 1_800_000_000_000 - 3600e3;
function withTomb(data) {
	data.set('tombs', new Map([['daimond-chats-deleted\u0000c-dead', { map: 'daimond-chats-deleted', id: 'c-dead', at: DEAD_AT }]]));
	return data;
}
const peerDead = { chats: [DEAD], tombs: {}, msgTombs: {} };
function stillDeleted(P, data) {
	assert.equal(P.ChatStore.read(), true, 'the store was read');
	assert.ok(Object.keys(P.loadTombs()).includes('c-dead'), 'the deletion held in IndexedDB is known');
	assert.ok(!data.get('chats').has('c-dead') && !data.get('chatsum').has('c-dead'), 'the deleted chat is not written back');
	assert.ok(!ids(P).includes('c-dead'), 'and not listed');
}

test('R15: a pull that reads a store whose boot read failed honours the deletions held in IndexedDB', async () => {
	const { P, data } = await blockedAndUnlocked({}, withTomb(blockedStore()));
	data.conns.clear();
	try { await P.applyChats(peerDead, 'peer'); } catch (e) { /* judged below */ }
	await ticks(400);
	stillDeleted(P, data);
});

test('R16: Try again on a store whose boot read failed honours the deletions held in IndexedDB', async () => {
	const { P, data } = await blockedAndUnlocked({}, withTomb(blockedStore()));
	data.conns.clear();
	P.ChatStore.retry();
	await ticks(400);
	try { await P.applyChats(peerDead, 'peer'); } catch (e) { /* judged below */ }
	await ticks(400);
	stillDeleted(P, data);
});

test('R17: a pull whose re-read runs out reads the store once it answers, with no further pull', async () => {
	let hold = false;
	const held = [];
	const gate = (fn) => (hold ? held.push(fn) : fn());
	const data = blockedStore();
	const { P } = page({ sessionList: el(), repaintPause: noop, renderHistory: noop, renderEmptyState: noop }, realStore(data, gate));
	P.boot();
	await ticks(400);
	await P.completeUnlock();
	assert.equal(P.ChatStore.read(), false, 'the boot read was refused');
	data.conns.clear();
	hold = true;
	try { await P.applyChats({ chats: [], tombs: {}, msgTombs: {} }, 'peer'); } catch (e) { /* refused: still unread */ }
	assert.equal(P.ChatStore.stalled(), true, 'the pull\'s re-read ran out');
	assert.equal(P.ChatStore.read(), false);
	hold = false;
	held.splice(0).forEach((fn) => fn());
	await ticks(400);
	assert.equal(P.ChatStore.read(), true, 'read once it answered');
	assert.deepEqual(ids(P), ['c-walk'], 'his chat is back');
});

test('R18: a boot whose read of the deletions fails is not read, and the read that lands loads them', async () => {
	const data = withTomb(new Map([['chats', new Map([[sent.id, sent]])]]));
	let broken = true;
	data.failTx = (names) => broken && [].concat(names).includes('tombs');
	const { P } = page({ sessionList: el(), repaintPause: noop, renderHistory: noop, renderEmptyState: noop }, realStore(data));
	P.pg.chats = await P.ChatStore.boot();
	assert.equal(P.ChatStore.read(), false, 'not read over deletions that did not load');
	broken = false;
	try { await P.applyChats(peerDead, 'peer'); } catch (e) { /* judged below */ }
	await ticks(400);
	stillDeleted(P, data);
	assert.deepEqual(ids(P), ['c-walk'], 'his chat is listed');
});

test('R19: the cross-tab re-read of a store whose boot failed does not list a deleted chat whose row is still there', async () => {
	const data = withTomb(blockedStore());
	data.get('chats').set(DEAD.id, DEAD);
	const { P } = await blockedAndUnlocked({}, data);
	data.conns.clear();
	await P.onChatsChangedElsewhere();
	assert.equal(P.ChatStore.read(), true, 'read');
	assert.ok(!ids(P).includes('c-dead'), 'the deleted chat is not listed: ' + JSON.stringify(ids(P)));
});

test('R20: pulls during a stall open nothing more until the store answers', async () => {
	let hold = false;
	const held = [];
	const gate = (fn) => (hold ? held.push(fn) : fn());
	const data = blockedStore();
	let opens = 0;
	const store = (w) => { realStore(data, gate)(w); const o = w.indexedDB.open.bind(w.indexedDB); w.indexedDB.open = (...a) => { opens++; return o(...a); }; };
	const { P } = page({ sessionList: el(), repaintPause: noop, renderHistory: noop, renderEmptyState: noop }, store);
	P.boot();
	await ticks(400);
	await P.completeUnlock();
	data.conns.clear();
	hold = true;
	try { await P.applyChats({ chats: [], tombs: {}, msgTombs: {} }, 'peer'); } catch (e) { /* refused */ }
	assert.equal(P.ChatStore.stalled(), true, 'stalled');
	const at = opens;
	for (let i = 0; i < 3; i++) { try { await P.applyChats({ chats: [], tombs: {}, msgTombs: {} }, 'peer'); } catch (e) { /* refused */ } }
	assert.equal(opens, at, 'no open while stalled');
	hold = false;
	held.splice(0).forEach((fn) => fn());
	await ticks(400);
	assert.equal(P.ChatStore.read(), true, 'read once it answered');
});

test('R21: a later read starts no second slim pass', async () => {
	const data = new Map([['chats', new Map([[sent.id, sent]])]]);
	const { P } = page({ sessionList: el(), repaintPause: noop, renderHistory: noop, renderEmptyState: noop }, realStore(data));
	await P.ChatStore.boot();
	const s1 = P.ChatStore.slimSettled();
	await P.ChatStore.refresh();
	assert.equal(P.ChatStore.slimSettled(), s1, 'the same slim pass');
});

test('R22: a read of a store already read clears no alarm it did not raise', async () => {
	const cleared = [];
	const data = new Map([['chats', new Map([[sent.id, sent]])]]);
	const { P } = page({ sessionList: el(), repaintPause: noop, renderHistory: noop, renderEmptyState: noop,
		storageAlarm: noop, storageAlarmClear: (src) => cleared.push(src) }, realStore(data));
	await P.ChatStore.boot();
	assert.equal(P.ChatStore.read(), true);
	const before = cleared.length;
	await P.ChatStore.refresh();
	assert.equal(cleared.length, before, 'a write failure\'s alarm stays up: ' + JSON.stringify(cleared.slice(before)));
});
