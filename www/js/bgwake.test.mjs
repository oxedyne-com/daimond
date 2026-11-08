/* ============================================================
   Test: a background command's end wakes its chat once (BG-WAKE, page half).

   Kimberlite posts the end of a background command whose run's turn has ended
   as a row of the chat (`bg`, mid `bg-<run>-<id>`, the engine's words). The page
   starts one turn on it, on the chat's seat, and one device only.

   Lifts the REAL wake block out of the page (`withTurnLock` to the start of
   `runTurn`) and the real `drainQueue`, over fake chats, a fake lease door and a
   fake Web Locks shared by two tabs, with the real peer.js for `bgOwed`.

     S1  an ended chat with the row: exactly one turn, its first message the event
     S2  two tabs sharing one lease door and one lock: one turn between them
     S3  a running turn defers it; that turn's end (`drainQueue`) starts it
     S4  a reload with the row already taken: none
     S5  here, but the chat off screen: none, unclaimed; opened, it runs
     S6  handed to a runner: the row is the prompt, tagged, never written twice
     S7  the rule (`DaimondPeer.bgOwed`)
     S8  Kimberlite's `bg-note` (T_BG_NOTE, `codec::bg_note_js`) taken on two devices: one row
         on each, one turn between them; taken again, or synced, still one; a bad or trashed
         one adds nothing

   Run:  node www/js/bgwake.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}

const win = { addEventListener() {}, dispatchEvent() { return true; } };
{
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readPage(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
}
const realP = win.DaimondPeer;

const src = readPage(join(HERE, 'daimond.js'), 'utf8');
function lift(from, to) {
	const a = src.indexOf(from), b = src.indexOf(to, a + 1);
	if (a < 0 || b < 0) throw new Error('block not found: ' + from);
	return src.slice(a, b);
}
const wakeBlock = lift('/// Hold an exclusive lock for a chat\'s turn', '/// Run one turn of a chat');
const drainBlock = lift('function drainQueue(', '/// Send a message that waited');

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
// The fakes yield as microtasks: a timer under a loaded host can fire after the check's own wait,
// which then reads a wake not yet run. The checks' waits are timers, so every fake step is done first.
const yieldNow = () => Promise.resolve();

// The lease door both tabs (devices) write through: take-if-vacant, as `DaimondLease.take`.
function door() {
	const recs = {};
	return {
		recs,
		async take(tid, o) {
			await yieldNow();
			const r = recs[tid];
			if (r && r.settled) return { won: false, why: 'settled' };
			if (r && r.holder !== o.holder) return { won: false, why: 'held', holder: r.holder };
			recs[tid] = { holder: o.holder };
			return { won: true };
		},
		async settle(tid, holder, mode) {
			const r = recs[tid];
			if (!r || r.holder !== holder) return { ok: false };
			if (mode === 'done') r.settled = true;
			else if (mode === 'released' && !r.settled) delete recs[tid];
			return { ok: true };
		},
	};
}

// navigator.locks, shared by the tabs of one device: one holder per name at a time.
function locks() {
	const tail = {};
	return {
		request(name, opts, fn) {
			const prev = tail[name] || Promise.resolve();
			const run = prev.then(() => fn());
			tail[name] = run.catch(() => {});
			return run;
		},
	};
}

const EVENT = { t: 'bg_end', kind: 'end', run: 'r1', chat: 'c1', id: '7', command: 'cargo test',
	exit: 0, timed_out: false, stopped: false, ms: 1263000, out_bytes: 10, err_bytes: 0, tail: 'ok', spill: '/s/bg-7', lost: '' };
const NOTE = 'Background command `cargo test` (id 7) exited 0 after 21 min 3 s; 10 bytes out, 0 bytes err.';
function transcript() {
	return [
		{ role: 'user', mid: 'u1', iturn: 'u1', content: 'run the suite in the background', ts: 1 },
		{ role: 'assistant', mid: 'a1', iturn: 'u1', content: 'Started.', ts: 2 },
		{ role: 'user', app: true, mid: 'bg-r1-7', content: NOTE, bg: EVENT, ts: 3 },
	];
}

/// One tab: its own copy of the chat, the device's lock and the account's door.
function tab(o) {
	const chat = Object.assign({ id: 'c1', _loaded: true, messages: o.messages || transcript() }, o.chat || {});
	const pg = { chats: [chat], current: o.offScreen ? null : chat, _unloading: false };
	const runs = [], dispatched = [], settled = [];
	const d = o.door;
	const P = {
		bgOwed: realP.bgOwed,
		bgNoteRow: realP.bgNoteRow,
		syncCas: () => d,
		async settleLease(what, tid, holder, mode) { settled.push(mode); return d.settle(tid, holder, mode); },
	};
	const L = { take: (tid, opts) => d.take(tid, opts), RENEW_EVERY_MS: 30000 };
	const S = { heard: () => true, flush: async () => {} };
	const w = { DaimondPeer: P, DaimondLease: L, DaimondSync: S };
	const nav = { locks: o.locks };
	const fakes = {
		pg, window: w, navigator: nav, DaimondPeer: P, DaimondLease: L, DaimondSync: S,
		ChatStore: { stored: () => [] },
		trashed: (id) => !!(o.trashed && o.trashed[id]),
		touchMsg: (m) => m, touchChat() {}, persistChats() {}, renderHistory() {},
		loadChatMessages: async (c) => c,
		recoveringHere: () => false,
		dispatchInFlight: () => null,
		askOpenIn: () => false,
		turnHold: () => false,
		ownsChat: (c) => pg.current === c,
		selfDeviceId: () => o.self || 'dev-a',
		peerSyncShim: () => ({}),
		leaseClockNow: () => Date.now(),
		diag() {},
		keptPrompt(m, tid) { if (m.iturn !== tid) m.iturn = tid; },
		async maybeAutoDispatch(c, text, words, mid, app, drawn, how) {
			await yieldNow();
			if (o.seat !== 'runner') return false;
			if (how && how.kept) fakes.keptPrompt(how.kept, mid);
			else c.messages.push({ role: 'user', mid: mid, iturn: mid, content: text });
			dispatched.push({ text, mid, app });
			return true;
		},
		runTurn(c, text, opts) { runs.push({ text, opts }); return Promise.resolve(); },
		returnQueue() {}, askHolds: () => false, updateQueueBadges() {}, renderQueue() {}, sendQueued: async () => 'here',
	};
	const names = Object.keys(fakes);
	// The page's view of the source reads `pg.chats` as `chats` (dev/pagesrc.mjs): live, through `pg`.
	const make = new Function(...names, 'with (pg) {\n' + wakeBlock + '\n' + drainBlock
		+ '\nreturn { wakeBgEnds: wakeBgEnds, drainQueue: drainQueue,'
		+ ' bgNoteFromRunner: typeof bgNoteFromRunner === \'function\' ? bgNoteFromRunner : null };\n}');
	const api = make(...names.map((k) => fakes[k]));
	return Object.assign(api, { chat, pg, runs, dispatched, settled });
}

console.log('\n— S1: an ended chat —');
{
	const t = tab({ door: door(), locks: locks() });
	t.wakeBgEnds();
	await tick(30);
	check('S1 exactly one turn', t.runs.length === 1, t.runs.length);
	check('S1 its first message is the event, in the engine\'s words', t.runs[0] && t.runs[0].text === NOTE);
	check('S1 on the row already in the transcript', t.runs[0] && t.runs[0].opts.promptInTranscript === true
		&& t.runs[0].opts.mid === 'bg-r1-7', JSON.stringify(t.runs[0] && t.runs[0].opts));
	check('S1 no second prompt row', t.chat.messages.length === 3, t.chat.messages.length);
	check('S1 the row is tagged as the turn\'s', t.chat.messages[2].iturn === 'bg-r1-7');
	t.wakeBgEnds();
	await tick(30);
	check('S1 asked again, still one', t.runs.length === 1, t.runs.length);
}

console.log('\n— S2: two tabs, one door —');
{
	const d = door(), lk = locks();
	const a = tab({ door: d, locks: lk, self: 'dev-a' });
	const b = tab({ door: d, locks: lk, self: 'dev-a' });
	a.wakeBgEnds(); b.wakeBgEnds();
	await tick(40);
	check('S2 one turn between two tabs', a.runs.length + b.runs.length === 1, a.runs.length + '+' + b.runs.length);
	const p = tab({ door: d, locks: locks(), self: 'dev-b' });		// another device
	p.wakeBgEnds();
	await tick(30);
	check('S2 another device stands down', p.runs.length === 0, p.runs.length);
}

console.log('\n— S3: a running turn defers it —');
{
	const d = door();
	const t = tab({ door: d, locks: locks(), chat: { _generating: true } });
	t.wakeBgEnds();
	await tick(30);
	check('S3 nothing while the turn runs', t.runs.length === 0, t.runs.length);
	check('S3 not claimed while it waits', !d.recs['bgw:bg-r1-7']);
	t.chat._generating = false;
	t.drainQueue(t.chat, false);		// the turn's end
	await tick(30);
	check('S3 the turn\'s end starts it', t.runs.length === 1, t.runs.length);
}

console.log('\n— S4: a reload with the row taken —');
{
	const m = transcript();
	m[2].iturn = 'bg-r1-7';
	m.push({ role: 'assistant', mid: 'a2', iturn: 'bg-r1-7', content: 'All green.', ts: 4 });
	const t = tab({ door: door(), locks: locks(), messages: m });
	t.wakeBgEnds();
	await tick(30);
	check('S4 no turn', t.runs.length === 0, t.runs.length);
}

console.log('\n— S5: here, off screen —');
{
	const d = door();
	const t = tab({ door: d, locks: locks(), offScreen: true });
	t.wakeBgEnds();
	await tick(30);
	check('S5 no turn into another thread', t.runs.length === 0, t.runs.length);
	check('S5 the claim is let go', !d.recs['bgw:bg-r1-7'], JSON.stringify(d.recs));
	check('S5 the row is still owed', !t.chat.messages[2].iturn);
	t.pg.current = t.chat;
	t.wakeBgEnds(t.chat);		// `resumeQueue`, on opening it
	await tick(30);
	check('S5 opened, it runs', t.runs.length === 1, t.runs.length);
}

console.log('\n— S6: handed to a runner —');
{
	const t = tab({ door: door(), locks: locks(), seat: 'runner' });
	t.wakeBgEnds();
	await tick(30);
	check('S6 handed off once', t.dispatched.length === 1 && t.runs.length === 0, t.dispatched.length + '/' + t.runs.length);
	check('S6 as the app\'s, with the event as its words', t.dispatched[0] && t.dispatched[0].app === true && t.dispatched[0].text === NOTE);
	check('S6 the row is the prompt, tagged, not written twice', t.chat.messages.length === 3 && t.chat.messages[2].iturn === 'bg-r1-7');
	check('S6 the claim is settled done', t.settled.join(',') === 'done,released', t.settled.join(','));
}

console.log('\n— S7: the rule —');
{
	const m = transcript();
	check('S7 an untaken row is owed', realP.bgOwed(m).length === 1);
	m.push({ role: 'assistant', mid: 'a9', iturn: 'bg-r1-7', content: 'x' });
	check('S7 a row any turn names is not', realP.bgOwed(m).length === 0);
	check('S7 a plain prompt is not', realP.bgOwed([{ role: 'user', mid: 'u', content: 'hi' }]).length === 0);
}

console.log('\n— S8: Kimberlite\'s bg-note, two devices —');
{
	// As `codec::bg_note_js` seals it (kimb/runshell 17ccddd52): no iturn, and the event no turn field.
	const note = () => ({ t: 'bg-note', v: 1, to: 'dev-a', chatId: 'c1', run: 'r1',
		row: { role: 'user', app: true, mid: 'bg-r1-7', content: NOTE, bg: EVENT, ts: 3 }, ts: 3 });
	const ended = () => transcript().slice(0, 2);
	check('S8 the tag is a peer type', realP.peerType('bg-note') === true);
	const meta = realP.relayMeta ? realP.relayMeta(note(), Date.now()) : {};
	check('S8 held on the relay for its asker', meta['for'] === 'dev-a' && meta.ttl > 0, JSON.stringify(meta));
	const d = door();
	const a = tab({ door: d, locks: locks(), self: 'dev-a', messages: ended() });
	const b = tab({ door: d, locks: locks(), self: 'dev-b', messages: ended(), offScreen: true, seat: 'runner' });
	const ingest = (t, env) => t.bgNoteFromRunner ? t.bgNoteFromRunner(env) : Promise.resolve();
	await ingest(a, note());
	await ingest(b, note());
	await ingest(a, note());		// pumped again: Kimberlite keeps it until posted
	await tick(60);
	const rows = (t) => t.chat.messages.filter((m) => m.mid === 'bg-r1-7');
	check('S8 one row on each device', rows(a).length === 1 && rows(b).length === 1, rows(a).length + '/' + rows(b).length);
	check('S8 the row as Kimberlite sent it', rows(a)[0] && rows(a)[0].content === NOTE && rows(a)[0].app === true
		&& rows(a)[0].bg && rows(a)[0].bg.id === '7' && rows(a)[0].role === 'user');
	const woke = a.runs.length + a.dispatched.length + b.runs.length + b.dispatched.length;
	check('S8 exactly one turn across the two devices', woke === 1,
		a.runs.length + '+' + a.dispatched.length + ' / ' + b.runs.length + '+' + b.dispatched.length);
	check('S8 its prompt is the event', (a.runs[0] || b.dispatched[0] || {}).text === NOTE);

	// Taken on one device only: the other has it by sync and stands down at the door.
	const d2 = door();
	const p = tab({ door: d2, locks: locks(), self: 'dev-a', messages: ended() });
	const q = tab({ door: d2, locks: locks(), self: 'dev-b', messages: ended() });
	await ingest(p, note());
	await tick(40);
	q.chat.messages.push(Object.assign({}, rows(p)[0] || {}));
	q.wakeBgEnds();
	await tick(40);
	check('S8 synced to the other device, still one turn', p.runs.length + q.runs.length === 1,
		p.runs.length + '+' + q.runs.length);

	const bad = tab({ door: door(), locks: locks(), messages: ended() });
	const wrongRun = note(); wrongRun.row.mid = 'bg-r9-7';
	const noEvent = note(); delete noEvent.row.bg;
	const otherChat = note(); otherChat.chatId = 'c9';
	for (const e of [wrongRun, noEvent, otherChat]) await ingest(bad, e);
	await tick(40);
	check('S8 a bad note adds nothing and wakes nothing', bad.chat.messages.length === 2 && bad.runs.length === 0,
		bad.chat.messages.length + '/' + bad.runs.length);
	const gone = tab({ door: door(), locks: locks(), messages: ended(), trashed: { c1: 1 } });
	await ingest(gone, note());
	await tick(40);
	check('S8 a trashed chat takes none', gone.chat.messages.length === 2 && gone.runs.length === 0);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
