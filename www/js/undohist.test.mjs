// UNDO-HISTORY (06 Nov): an undo enters the model's history. Turn 1 changed /w/notes.txt; it is
// undone (by its runner, by the Here toast, by "Undo this restore", by a History file restore);
// turn 3's local history and its Kimberlite errand must both carry a note naming the file.
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let fail = 0; const check = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + d)); if (!c) fail++; };
const J = JSON.stringify, FILE = '/w/notes.txt';
const has = (list, word) => (list || []).some((m) => /^\[Daimond: the user (undid|restored) /.test(String(m.content || '')) && String(m.content).includes(word));
function page(rows) {
	const w = makeWindow({});
	w.DaimondVersions = { undoneArrived: async () => ({ mark: null, recorded: false }), rows: async () => rows,
		undoVersion: async (k, v, files) => ({ restored: files.slice(), refused: [], recorded: 9 }),
		ready: () => true, restore: async () => ({ outcome: 'restored', restored: [FILE], refused: [], recorded: 6 }) };
	w.DaimondUndo = { able: (o) => { w.$revert = o.revert; } };
	w.DaimondI18n = { t: (k) => k };
	// A name the base page lacks is a no-op, so each arm goes red on base by its own checks.
	let want = ['undoneFromRunner', 'offerTurnUndo', 'errandSession', 'daimonPrior', 'pg', 'noteRestoreUndone', 'noteHistRestore', 'untoldOf', 'restoreWholeVersion', 'restoreUndoneHeard'];
	const lack = [];
	let P = null;
	while (!P) {
		try {
			P = loadPage({ window: w, want,
				stub: { diag() {}, confirmDialog: async () => true, refreshDiamondAfterChange: async () => {}, diamondTurning: () => false, persistChats() {}, touchChat() {}, renderHistory() {}, ownsChat() { return false; }, trashed(id) { return id === 'gone'; } } });
		} catch (e) {
			const m = /declares no (\w+)/.exec(String(e && e.message));
			if (!m) throw e;
			lack.push(m[1]); want = want.filter((n) => n !== m[1]);
		}
	}
	P = Object.assign({}, P);
	lack.forEach((n) => { P[n] = n === 'untoldOf' ? () => [] : async () => null; });
	return { P, w };
}
function chatOf(id) {
	return { id: id || 'c1', diamondId: 'd1', _loaded: true,
		messages: [
			{ role: 'user', content: 'tidy the notes', mid: 'u1', ts: 10 },
			{ role: 'assistant', content: 'I rewrote /w/notes.txt', mid: 'a1', iturn: 'u1', ts: 20 },
			{ role: 'user', content: '[Daimond: this turn changed /w/notes.txt]', mid: 'e-R1-files', iturn: 'u1', ts: 21 },
		],
		session: { v: 1, msgs: [{ role: 'user', content: 'tidy the notes' }, { role: 'assistant', content: 'I rewrote /w/notes.txt' }], upto: 'e-R1-files', uptoTs: 21 } };
}
function turn3(P, chat, word, label) {
	chat.messages.push({ role: 'user', content: 'what is in the notes now?', mid: 'u3', ts: Date.now() + 5000 });
	const e = P.errandSession(chat, 'u3'), prior = P.daimonPrior(chat, 'u3');
	check(label + ': the Kimberlite errand\'s session carries the note naming ' + word, has(e.tail, word) || has(e.msgs, word), J(e.tail));
	check(label + ': the local history carries the note naming ' + word, has(prior, word), J(prior));
	const note = chat.messages.find((m) => m.undone);
	check(label + ': the note is an app row with a mid', !!note && note.app === true && !!note.mid && note.role === 'user', J(note));
}
const TURN = [{ v: 3, cause: 'turn', turn: 'u1', away: { run: 'e-R1' }, files: [{ path: FILE }] }];
// 1. The runner's undo of the turn.
{
	const { P } = page(TURN), chat = chatOf();
	P.pg.chats = [chat];
	await P.undoneFromRunner({ t: 'undone', run: 'e-R1', keeper: 'd1', status: 'done', restored: [FILE], removed: [], skipped: [] });
	turn3(P, chat, FILE, 'runner undo');
}
// 2. The Here toast's undo.
{
	const { P, w } = page([]), chat = chatOf();
	P.pg.chats = [chat];
	P.offerTurnUndo({ files: [FILE], keeper: 'chat:c1', version: 4 }, () => true, { chat, mid: 'u1', ask: 'tidy the notes' });
	if (w.$revert) await w.$revert();
	turn3(P, chat, FILE, 'Here toast undo');
}
// 3. Undoing the undo: the runner's "Undo this restore" (run u-<uid>), and the local one.
{
	const rows = TURN.concat([{ v: 5, cause: 'restore', turn: 'u1', away: { run: 'u-k1' }, files: [{ path: FILE }] }]);
	const { P } = page(rows), chat = chatOf();
	P.pg.chats = [chat];
	await P.undoneFromRunner({ t: 'undone', run: 'e-R1', keeper: 'd1', status: 'done', restored: [FILE], removed: [], skipped: [] });
	await P.undoneFromRunner({ t: 'undone', run: 'u-k1', keeper: 'd1', status: 'done', restored: [FILE], removed: [], skipped: [] });
	const redo = chat.messages.find((m) => m.mid === 'u-k1-undone');
	check('runner undo of the undo: a note names what came back', !!redo && /came back/i.test(redo.content) && redo.content.includes(FILE), J(chat.messages.slice(-2)));
	const { P: Q } = page([]), c2 = chatOf();
	Q.pg.chats = [c2];
	c2.messages.push({ role: 'user', app: true, mid: 'x-undone', content: '[Daimond: the user undid the turn]', ts: 30,
		undone: { how: 'undo', turn: 'u1', ask: 'tidy the notes', keeper: 'chat:c1', recorded: 7, restored: [FILE], removed: [], skipped: [] } });
	await Q.noteRestoreUndone('chat:c1', 7, { restored: [FILE], refused: [], recorded: 8 });
	const back = c2.messages[c2.messages.length - 1];
	check('local undo of the undo: a note names what came back', back.mid !== 'x-undone' && /came back/i.test(back.content) && back.content.includes(FILE), J(back));
}
// 4. One file restored from History: the note goes to the chat of the turn whose change it took back;
//    a turn whose chat is gone has nothing added anywhere.
{
	const { P } = page(TURN), chat = chatOf(), other = chatOf('c2');
	other.messages = other.messages.map((m) => Object.assign({}, m, { mid: 'o' + m.mid, iturn: m.iturn && 'o' + m.iturn }));
	P.pg.chats = [other, chat];
	await P.noteHistRestore('d1', 3, FILE, { outcome: 'restored', restored: [FILE], refused: [], recorded: 6 }, true);
	check('History restore: the note is in the turn\'s chat only', chat.messages.some((m) => m.undone) && !other.messages.some((m) => m.undone), J(chat.messages.slice(-1)));
	turn3(P, chat, FILE, 'History restore');
	const { P: G } = page(TURN), dead = chatOf('gone');
	G.pg.chats = [dead];
	await G.noteHistRestore('d1', 3, FILE, { outcome: 'restored', restored: [FILE], refused: [], recorded: 6 }, true);
	check('History restore, chat in Trash: no chat gets a note', !dead.messages.some((m) => m.undone), J(dead.messages.slice(-1)));
	check('History restore, chat in Trash: the History row records it', J(G.untoldOf('d1', 3)) === J([FILE]), J(G.untoldOf('d1', 3)));
}
// 5. A whole-version Restore: the chat of each later turn it took back gets the note.
{
	const { P } = page(TURN), chat = chatOf();
	P.pg.chats = [chat];
	await P.restoreWholeVersion('d1', 2);
	turn3(P, chat, FILE, 'whole-version Restore');
}
// 6. The restore toast's Undo (versions.js offerUndo): the real versions.js says so by an event,
//    and the page notes what came back in the chat told of the restore.
{
	const events = [];
	let revert = null;
	const engine = {
		versions_list: () => '[]',
		versions_restore_open: async () => JSON.stringify({ ticket: 't1', machine: [] }),
		versions_undo_open: async () => JSON.stringify({ ticket: 't2', machine: [] }),
		versions_restore_hold: async () => '{}', versions_restore_answer: async () => '{}', versions_restore_end: async () => '{}',
		versions_restore_close: async () => JSON.stringify({ version: 5, recorded: 5, restored: [FILE], missing: [], refused: [] }),
	};
	const win = { DaimondCore: { diamondApp: () => engine, confirm: () => Promise.resolve(true) },
		DaimondUndo: { able: (o) => { revert = o.revert; } }, DaimondI18n: { t: (k) => k },
		addEventListener: () => {}, dispatchEvent: (e) => { events.push(e); return true; } };
	win.window = win;
	new Function('window', 'with (window) {\n' + readFileSync(fileURLToPath(new URL('./versions.js', import.meta.url)), 'utf8') + '\n}')(win);
	await win.DaimondVersions.restoreFile('d1', FILE, 3, '');
	if (revert) await revert();
	const ev = events.find((e) => e && e.type === 'daimond:restore-undone');
	check('restore toast Undo: versions.js says so by daimond:restore-undone', !!ev && ev.detail && ev.detail.v === 5, J(events.map((e) => e.type)));
	const { P } = page(TURN), chat = chatOf();
	P.pg.chats = [chat];
	await P.noteHistRestore('d1', 3, FILE, { outcome: 'restored', restored: [FILE], refused: [], recorded: 5 }, true);
	if (ev) await P.restoreUndoneHeard(ev.detail);
	const back = chat.messages[chat.messages.length - 1];
	check('restore toast Undo: a note names what came back', !!back.undone && back.undone.how === 'redo' && back.content.includes(FILE), J(back));
}
console.log(fail ? fail + ' FAILED' : 'all ok');
process.exit(fail ? 1 : 0);
