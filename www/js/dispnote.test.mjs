/* ============================================================
   dispnote.test.mjs — a second device follows a hand-off from its first frame (UNBLOCK-44d)

   WHAT IS CHECKED. The owner, 27 Oct: "gilgamesh activity is seen but nothing on argonaut at
   the same time! activity begins on argonaut, but after a delay". Lens: argonaut's tiles P90
   39.6 s, gilgamesh's 119 ms. The second device learned of the hand-off only from the asker's
   whole parcel (pull 19 s + push 21 s on his road), and watched nothing until it came. Now the
   asker puts the turn's user row and placeholder in its agents frame, which every page follows
   on the progress door and the gateway taps at once.

     (a) carried  — `agentsFrame(..., disp)` carries a note; `agentsFromFrame` reads it back.
     (b) checked  — a note naming another sender than its frame, a non-empty or missing
                    placeholder, too many rows, or past the deadline is refused; an oversized
                    note is left off the frame and the runs still go.
     (c) rows     — `dispatchNoteRows` adds only rows not held; none for the sender itself, for a
                    turn whose placeholder is held, or for a turn that has rows of its own.
     (d) wiring   — a dispatch notes itself and sends the frame at once; the frame carries the
                    live notes; a peer's frame's notes are taken and watched (`updateExpedite`).

   RED on e9a0290d7977: every arm (the note does not exist).

   Run:  node www/js/dispnote.test.mjs
   ============================================================ */
const { makeWindow, loadScript, TREE } = await import('../../dev/syncprobe.mjs');
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}
const NOW = 1_800_000_000_000;
const w = makeWindow({ now: NOW });
try { loadScript(w, 'peer.js'); } catch (e) { /* the builders are defined before any boot step */ }
const P = w.DaimondPeer || {};
const have = ['agentsFrame', 'agentsFromFrame', 'dispatchNote', 'dispatchNoteRows'].every((k) => typeof P[k] === 'function');
check('peer.js exports the dispatch note', have);

const weigh = (t) => ({ chars: String(t).length, bytes: Buffer.byteLength(JSON.stringify(String(t))) - 2 });
const BUDGET = { chars: 48 * 1024, bytes: 63 * 1024 };
const A = 'dev-gilgamesh', B = 'dev-argonaut', T = 'turn-1', C = 'chat-1';
const user = { role: 'user', content: 'what is in the folder?', mid: 'm-user', ts: NOW - 2000 };
const ph = { role: 'assistant', content: '', mid: 'm-ph', interrupted: true, why: 'dispatched', iturn: T, dispatchedBy: A, ts: NOW - 1000 };
const note = (o) => Object.assign({ tid: T, cid: C, by: A, at: NOW - 1000, rows: [user, ph] }, o || {});
const run = { id: 'w1', name: 'w1', status: 'running', turnId: 'T9', deviceId: A };

if (have) {
	const f = P.agentsFrame([run], A, NOW, BUDGET, weigh, [note()]);
	const got = P.agentsFromFrame(f, A);
	check('(a) the note crosses in the agents frame', !!got && got.disp.length === 1 && got.disp[0].tid === T && got.disp[0].cid === C
		&& got.disp[0].rows.length === 2 && got.disp[0].rows[1].mid === 'm-ph', got);
	check('(a) the runs still cross beside it', !!got && got.runs.length === 1 && got.runs[0].id === 'w1');
	check('(a) a frame with no notes still reads', P.agentsFromFrame(P.agentsFrame([run], A, NOW, BUDGET, weigh), A).disp.length === 0);

	check('(b) a note naming another sender than its frame is refused', P.agentsFromFrame(P.agentsFrame([], A, NOW, BUDGET, weigh, [note({ by: B, rows: [user, Object.assign({}, ph, { dispatchedBy: B })] })]), A).disp.length === 0);
	check('(b) a placeholder with content is refused', P.dispatchNote(note({ rows: [user, Object.assign({}, ph, { content: 'x' })] }), NOW) === null);
	check('(b) no placeholder is refused', P.dispatchNote(note({ rows: [user] }), NOW) === null);
	check('(b) a placeholder of another turn is refused', P.dispatchNote(note({ rows: [user, Object.assign({}, ph, { iturn: 'other' })] }), NOW) === null);
	check('(b) more than two rows is refused', P.dispatchNote(note({ rows: [user, user, ph] }), NOW) === null);
	check('(b) a note past the errand deadline is refused', P.dispatchNote(note({ at: NOW - 16 * 60e3 }), NOW) === null);
	const big = note({ rows: [Object.assign({}, user, { content: 'x'.repeat(30000) }), ph] });
	const fb = P.agentsFromFrame(P.agentsFrame([run], A, NOW, BUDGET, weigh, [big]), A);
	check('(b) an oversized note stays off the frame, the runs still go', fb.disp.length === 0 && fb.runs.length === 1, fb);
	check('(b) junk notes do not break the frame', P.agentsFromFrame('{"v":1,"dev":"' + A + '","disp":[1,null,{"tid":5}],"runs":[]}', A).disp.length === 0);

	const held = [{ role: 'user', content: 'earlier', mid: 'm0' }];
	const add = P.dispatchNoteRows(held, note(), B, NOW);
	check('(c) a peer adds the user row and the placeholder', Array.isArray(add) && add.map((m) => m.mid).join() === 'm-user,m-ph', add);
	check('(c) the sender adds nothing', P.dispatchNoteRows(held, note(), A, NOW) === null);
	check('(c) a held user row is not added twice', (P.dispatchNoteRows(held.concat([user]), note(), B, NOW) || []).map((m) => m.mid).join() === 'm-ph');
	check('(c) a held placeholder adds nothing', P.dispatchNoteRows(held.concat([user, ph]), note(), B, NOW) === null);
	check('(c) a turn with its own rows (it ran, or its answer merged) adds nothing',
		P.dispatchNoteRows(held.concat([user, { role: 'assistant', content: 'done', mid: 'e-1-t0', iturn: T }]), note(), B, NOW) === null);
}

const APP = readPage(join(TREE, 'www', 'js', 'daimond.js'), 'utf8');
const mark = (APP.match(/function markTurnDispatched\(chat, mark\) \{[\s\S]*?\n\t\}\n/) || [''])[0];
check('(d) a dispatch notes itself', /noteDispatch\(chat, mark\)/.test(mark));
const nd = (APP.match(/function noteDispatch\([\s\S]*?\n\t\}\n/) || [''])[0];
check('(d) the note is sent at once, not on the spaced timer', /PeerAgents\.publishNow\(\)/.test(nd) && /dispatchedBy[\s\S]*!== self/.test(nd));
check('(d) the agents frame carries the live notes', /DaimondPeer\.agentsFrame\([^;]*liveDispatchNotes\(\)\)/.test(APP));
check('(d) a note lives only while its turn is watched here', /function liveDispatchNotes[\s\S]*?!_watchIx\[t\]/.test(APP));
check('(d) a peer\'s notes are taken from its frame', /takeDispatchNotes\(got\.disp\)/.test(APP));
const take = (APP.match(/function takeDispatchNotes\([\s\S]*?\n\t\}\n/) || [''])[0];
check('(d) a taken note is watched at once', /_dispatchedIx\[String\(n\.tid\)\] = chat\.id/.test(take) && /updateExpedite\(\)/.test(take));
check('(d) a finished or settled turn is never re-opened', /dispatchedTurnFinished\(chat, n\.tid\)/.test(take) && /settledLease/.test(take));

console.log('\n' + (checks - failures) + '/' + checks + ' passed');
process.exit(failures ? 1 : 0);
