/* ============================================================
   Test -- a daimon's memory belongs to the chat (UNBLOCK-11, C2 MEMORY, JS half).
   ------------------------------------------------------------
   A daimon turn used to start from this device's stored session (`rec.session.msgs`) and nothing else, so on device
   B "continue" after A's answer had synced into B's transcript was read by a model that never saw A's answer; a turn
   that failed part way dropped what it had said; and a runner whose copy differed from the asker's refused the turn
   ("the conversation differs on this device"). Now:

     PRIOR    the turn starts from `daimonPrior`: the stored session where it agrees with the transcript, the turns it
              never heard laid on behind it (`tailAfter`), and on doubt or no session the transcript's prose
     FOLD     a fold the engine made is a record with the chat (`foldFrom`, `mergeFold`, `withRecent`); a rebuild reads
              the fold first, then the prose after its `through`
     FAIL     a turn that throws part way lands its partial answer and evicts the session (`landFailedTurn`)
     THROUGH  the errand carries the last message the asker saw (peer.js `throughOf`); the runner waits a bounded while
              for it, then runs and says what it lacked (`peerReady`), and never refuses
     SEARCH   `DaimondTranscript.search` finds the chat's prose and its fold for `recall`

   The real functions are lifted out of daimond.js by source (`dev/syncprobe.mjs` `sliceDaimond`); peer.js's
   `throughOf` and `holdsThrough` by brace matching. Red on c295864b (the functions are absent, and the base behaviour
   is emulated where the arm needs it), green after.

   Run:  node www/js/daimonmemory.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, sliceDaimond, declLine } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const J = JSON.stringify;
const DJS = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const PJS = readFileSync(join(HERE, 'peer.js'), 'utf8');

function extractFn(src, name) {
	const at = src.indexOf('function ' + name + '(');
	if (at < 0) return '';
	let i = src.indexOf('{', at), depth = 0;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(at, i);
}
function lift(names, stub, win) {
	const have = names.filter((n) => declLine(n) > 0);
	if (!have.length) return {};
	try { return sliceDaimond(win || makeWindow({}), have, Object.assign({ diag() {} }, stub || {})).fns; }
	catch (e) { console.log('  (lift failed: ' + e.message + ')'); return {}; }
}
const F = lift(['daimonPrior', 'foldFrom', 'mergeFold', 'landFailedTurn', 'transcriptSearch', 'withRecent', 'sessionMarker']);
// The base behaviour where the function is absent: the turn sent the stored session as it stood.
const prior = F.daimonPrior || ((rec) => (rec.session && rec.session.msgs) || []);
const said = (list) => list.map((m) => (typeof m.content === 'string' ? m.content : J(m.content)));

// ── PRIOR: "continue" on B, A's answer in B's transcript but not B's session ──
console.log('\nPRIOR: the turn starts from the converged transcript\n');
{
	const rec = {
		id: 'chat-d', diamondId: 'dia-1',
		messages: [
			{ role: 'user', content: 'list the files', mid: 'u1', ts: 1 },
			{ role: 'assistant', content: 'B: here are the files', mid: 'a1', ts: 2 },
			{ role: 'end_log', mid: 'e1', ts: 3 },
			{ role: 'user', content: 'now write the summary', mid: 'u2', ts: 4 },				// asked on A
			{ role: 'assistant', content: 'A: the summary so far, part one', mid: 'a2', ts: 5 },	// answered on A
			{ role: 'user', content: 'continue', mid: 'u3', ts: 6 },								// this turn, on B
		],
		// B's session, stored at the end of ITS last turn: it never held A's turn.
		session: { v: 1, upto: 'a1', uptoTs: 2, msgs: [
			{ role: 'user', content: 'list the files', mid: 'u1' },
			{ role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
			{ role: 'tool', content: 'a.txt b.txt', tool_call_id: 'c1' },
			{ role: 'assistant', content: 'B: here are the files' },
		] },
	};
	const out = prior(rec, 'u3');
	const words = said(out);
	check('the model reads A\'s answer before "continue"', words.includes('A: the summary so far, part one'), J(words));
	check('and A\'s question', words.includes('now write the summary'), J(words));
	check('the stored session\'s tool calls are kept (the cache is used where it agrees)',
		out.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'), J(out.map((m) => m.role)));
	check('the prompt this turn sends is not laid twice', !words.includes('continue'), J(words));
	check('A\'s answer comes once', words.filter((w) => w === 'A: the summary so far, part one').length === 1);

	// A session stored by the old shape (no marker) is doubt: the turn is laid from the transcript.
	const old = Object.assign({}, rec, { session: { v: 1, upto: '', uptoTs: 0, msgs: rec.session.msgs } });
	const w2 = said(prior(old, 'u3'));
	check('an unmarked session is rebuilt from the transcript, in order',
		J(w2) === J(['list the files', 'B: here are the files', 'now write the summary', 'A: the summary so far, part one']), J(w2));

	// A turn it never heard standing BEFORE one it holds ('early'): laid from the transcript too.
	const early = {
		id: 'chat-e', messages: [
			{ role: 'user', content: 'q-a', mid: 'qa', ts: 1 },
			{ role: 'assistant', content: 'r-a', mid: 'ra', iturn: 'qa', ts: 2 },
			{ role: 'user', content: 'q-b', mid: 'qb', ts: 3 },						// A's turn, synced in late
			{ role: 'assistant', content: 'r-b', mid: 'rb', iturn: 'qb', ts: 4 },
			{ role: 'user', content: 'q-c', mid: 'qc', ts: 5 },
			{ role: 'assistant', content: 'r-c', mid: 'rc', iturn: 'qc', ts: 6 },
			{ role: 'user', content: 'q-d', mid: 'qd', ts: 7 },
		],
		session: { v: 1, upto: 'rc', uptoTs: 6, msgs: [
			{ role: 'user', content: 'q-a', mid: 'qa' }, { role: 'assistant', content: 'r-a' },
			{ role: 'user', content: 'q-c', mid: 'qc' }, { role: 'assistant', content: 'r-c' },
		] },
	};
	const w3 = said(prior(early, 'qd'));
	check('a session that missed an earlier turn is rebuilt in the transcript\'s order',
		J(w3) === J(['q-a', 'r-a', 'q-b', 'r-b', 'q-c', 'r-c']), J(w3));
}

// ── FOLD: the record, its merge, and a rebuild from it ──
console.log('\nFOLD: a fold is a record with the chat, and a rebuild reads it\n');
{
	const msgs = [
		{ role: 'user', content: 'old q1', mid: 'u1', ts: 1 },
		{ role: 'assistant', content: 'old a1', mid: 'a1', ts: 2 },
		{ role: 'user', content: 'old q2', mid: 'u2', ts: 3 },
		{ role: 'assistant', content: 'old a2', mid: 'a2', ts: 4 },
		{ role: 'user', content: 'new q3', mid: 'u3', ts: 5 },
		{ role: 'assistant', content: 'new a3', mid: 'a3', ts: 6 },
		{ role: 'user', content: 'go on', mid: 'u4', ts: 7 },
	];
	const FOLD = '[Daimond folded the earlier part of this conversation to keep it inside the model\'s window] we chose blue';
	const rec = { id: 'chat-f', messages: msgs.slice(), session: null,
		fold: { through: 'a2', throughTs: 4, turns: ['u1', 'u2'], at: 10, dev: 'devA', text: FOLD } };	// C2-FOLD: the turns it covers
	const w = said(prior(rec, 'u4'));
	check('no session: the fold first, then only the prose after its through', J(w) === J([FOLD, 'new q3', 'new a3']), J(w));

	const foldFrom = F.foldFrom || (() => null);
	const after = [
		{ role: 'user', content: FOLD },
		{ role: 'user', content: 'new q3', mid: 'u3' }, { role: 'assistant', content: 'new a3' },
		{ role: 'user', content: 'go on', mid: 'u4' }, { role: 'assistant', content: 'went on' },
	];
	const made = foldFrom({ messages: msgs }, after, 'u4', null, 99, 'devB');
	check('the fold a turn leaves runs through the row before the first prompt it still holds',
		!!made && made.through === 'a2' && made.throughTs === 4 && made.text === FOLD && made.at === 99 && made.dev === 'devB', J(made));
	check('a turn that did not fold leaves the record as it was',
		foldFrom({ messages: msgs }, after.slice(1), 'u4', rec.fold, 100, 'devB') === rec.fold);
	const big = foldFrom({ messages: msgs }, [{ role: 'user', content: FOLD + 'x'.repeat(40000) }, after[1]], 'u4', null, 1, 'd');
	check('the fold text is bounded at 16 KiB', !!big && big.text.length <= 16384, big && big.text.length);

	const mergeFold = F.mergeFold || ((a) => a);
	const shortA = { through: 'a1', throughTs: 2, at: 5, dev: 'devA', text: 'S' };
	const longB  = { through: 'a2', throughTs: 4, at: 9, dev: 'devB', text: 'L' };
	check('the longer range wins, from either side', mergeFold(shortA, longB) === longB && mergeFold(longB, shortA) === longB);
	const sameA = { through: 'a2', throughTs: 4, at: 3, dev: 'devZ', text: 'X' };
	check('the same range: the earlier one, from either side', mergeFold(sameA, longB) === sameA && mergeFold(longB, sameA) === sameA);
	const tieA = { through: 'a2', throughTs: 4, at: 9, dev: 'devA', text: 'Y' };
	check('the same range and time: the lesser device, from either side', mergeFold(tieA, longB) === tieA && mergeFold(longB, tieA) === tieA);
	check('one side absent: the other', mergeFold(null, longB) === longB && mergeFold(longB, undefined) === longB);

	const withRecent = F.withRecent || ((c, o) => o);
	check('the record carries its fold', J(withRecent({ fold: longB }, {}).fold) === J(longB));
	check('and no field at all when unset (the bytes are unchanged)', !('fold' in withRecent({}, {})));
}

// ── FAIL: a turn that throws part way lands what it said ──
console.log('\nFAIL: a failed mid-run turn lands its partial answer\n');
{
	const rec = { id: 'chat-x', messages: [
		{ role: 'user', content: 'write the report', mid: 'u1', ts: 1 },
	], session: { v: 1, upto: 'z', uptoTs: 0, msgs: [{ role: 'user', content: 'older', mid: 'u0' }] } };
	const land = F.landFailedTurn || (() => null);
	land(rec, 'The report, first half', 'u1', 'd1', 5);
	const row = rec.messages[rec.messages.length - 1];
	check('the partial answer is a row of the turn, interrupted',
		row.role === 'assistant' && row.content === 'The report, first half' && row.iturn === 'u1' && row.interrupted === true && row.mid === 'd1', J(row));
	check('the stored session is evicted', rec.session === null, J(rec.session));
	rec.messages.push({ role: 'user', content: 'continue', mid: 'u2', ts: 6 });
	check('the next turn reads the partial', said(prior(rec, 'u2')).includes('The report, first half'));
	// C2 r2 F3: a throw AFTER the try landed the answer (`dAns`, mid d9) reaches the same catch; it must not land a
	// second copy of that mid, nor evict the session the try had just stored correctly.
	const good = { v: 1, upto: 'd9', uptoTs: 9, msgs: [{ role: 'user', content: 'go', mid: 'u9' }] };
	const done = { id: 'chat-y', messages: [
		{ role: 'user', content: 'go', mid: 'u9', ts: 8 },
		{ role: 'assistant', content: 'Done, all of it', mid: 'd9', ts: 9 },
	], session: good };
	land(done, 'Done, all of it', 'u9', 'd9', 10);
	check('a turn whose answer already landed gets no second row of that mid',
		done.messages.filter((m) => m.mid === 'd9').length === 1, J(done.messages));
	check('and keeps the session it stored', done.session === good, J(done.session));
	// `runSteer` holds the client and settles it; its body, with the catch and the turn, is `runSteerHeld` (U3a).
	const n = extractFn(DJS, 'runSteerHeld');
	const at = n.indexOf('} catch (e) {\n\t\t\t// A failure BEFORE the turn');
	check('runSteer\'s catch lands it', at > 0 && n.slice(at, at + 1500).indexOf('landFailedTurn(') > 0);
	check('runSteer starts the turn from daimonPrior, with the prompt\'s mid and the device',
		/var prior = daimonPrior\(rec, dumid\);\s*var after = await turnKill\(fa\.steer_crystal\([\s\S]{0,900}\bprior, onEvent[\s\S]{0,200}String\(dumid\), selfDeviceId\(\)\)/.test(n)
		&& /foldFrom\(rec, after, dumid, rec\.fold \|\| null, Date\.now\(\), selfDeviceId\(\), prior\)/.test(n));
}

// ── THROUGH: the errand names what the asker saw; the runner waits, then runs ──
console.log('\nTHROUGH: the errand carries through, the runner waits ≤ 10 s and says what it lacked\n');
{
	// FIRE C2-READY: the real peer.js, so readiness is judged by its own `threadReadiness` on real fingerprints.
	const pw = { console: { log() {}, warn() {}, error() {} }, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
	new Function('window', 'with (window) {\n' + PJS + '\n}')(pw);
	const P = pw.DaimondPeer;
	const chat = { messages: [
		{ role: 'user', content: 'q', mid: 'm1', ts: 10 },
		{ role: 'assistant', content: 'a', mid: 'm2', ts: 20 },
		{ role: 'end_log', mid: 'm3', ts: 21 },
		{ role: 'user', content: 'the turn', mid: 'T', ts: 30 },
	] };
	const th = P.throughOf ? P.throughOf(chat, 'T') : undefined;
	check('through is the last message the asker saw, as (ts, mid)', J(th) === J({ ts: 20, mid: 'm2' }), J(th));
	check('peer.js builds the errand with it', /through: through/.test(extractFn(PJS, 'buildDispatch')) && /through: \(o\.through/.test(extractFn(PJS, 'makeErrand')));

	const win = makeWindow({});
	win.setTimeout = setTimeout; win.Date = Date;	// the wait runs on the real clock
	let pulls = 0, arriveOn = -1;
	const live = { id: 'chat-r', _loaded: true, messages: [{ role: 'user', content: 'q', mid: 'm1', ts: 10 }] };
	win.DaimondPeer = P;
	win.DaimondSync = { version: () => 1, pull: async () => {
		pulls++;
		if (pulls === arriveOn) live.messages.push({ role: 'assistant', content: 'a', mid: 'm2', ts: 20 });
	} };
	const R = lift(['peerReady', 'lackedNote', 'askerReadiness', 'syncHeld', 'THROUGH_WAIT_MS'].concat(declLine('throughDeadline') > 0 ? ['throughDeadline'] : []), {
		chats: [live], loadChatMessages: async () => {}, onChatsChangedElsewhere: async () => {},
	}, win);
	const THR = P.threadSig({ messages: [chat.messages[0], chat.messages[1], chat.messages[3]] }, 'T');	// m1, m2 before T
	const errand = { chatId: 'chat-r', turnId: 'T', through: { ts: 20, mid: 'm2' }, thread: THR };
	if (!R.peerReady) check('peerReady is liftable', false);
	else {
		const t0 = Date.now();
		const v = await R.peerReady(errand, [], 1200);
		const dt = Date.now() - t0;
		check('a copy short of through is not refused', v && v.ok === true, J(v));
		check('it says what it lacked, counted', !!v && typeof v.lacked === 'string' && /had not yet received 1 earlier message /.test(v.lacked), J(v));
		check('it waited the bound, pulling, and no longer', dt >= 1100 && dt < 4000 && pulls >= 1, dt + ' ms, ' + pulls + ' pulls');
		check('the bound is at most 10 s', R.THROUGH_WAIT_MS !== undefined && R.THROUGH_WAIT_MS <= 10000, String(R.THROUGH_WAIT_MS));
		pulls = 0; arriveOn = 1; live.messages = live.messages.slice(0, 1);
		const v2 = await R.peerReady(errand, [], 5000);
		check('through arriving within the wait runs with nothing lacked', v2 && v2.ok === true && v2.lacked === '', J(v2));

		// C2 r2 F4: an older sender's errand carries `thread` and no `through` key at all. It used to pass at once on
		// whatever the runner held, with no note; it now waits the same bound for its whole thread, and says so if it fails.
		live.messages = live.messages.slice(0, 1);
		const old = { chatId: 'chat-r', turnId: 'T', thread: THR };
		pulls = 0; arriveOn = -1;
		const t1 = Date.now();
		const v3 = await R.peerReady(old, [], 1200);
		const dt3 = Date.now() - t1;
		check('an older sender\'s errand waits the bound for its thread', dt3 >= 1100 && dt3 < 4000 && pulls >= 1, dt3 + ' ms, ' + pulls + ' pulls');
		check('and its note counts what it lacked', !!v3 && v3.ok === true && /had not yet received 1 earlier message /.test(v3.lacked || ''), J(v3));
		const older = { chatId: 'chat-r', turnId: 'T' };	// older still: no thread at all
		const v3b = await R.peerReady(older, [], 600);
		check('an errand with no thread says what could not be confirmed', !!v3b && /could not confirm/.test(v3b.lacked || ''), J(v3b));
		live.messages = chat.messages.slice(0, 2).map((m) => Object.assign({}, m));
		const t2 = Date.now();
		const v4 = await R.peerReady(old, [], 1200);
		check('an older errand whose thread is held runs at once, nothing lacked', v4 && v4.lacked === '' && Date.now() - t2 < 500, J(v4));
		live.messages = live.messages.slice(0, 1);
		const fresh = { chatId: 'chat-r', turnId: 'T', thread: P.threadSig({ messages: [] }, 'T'), through: null };
		const t3 = Date.now();
		const v5 = await R.peerReady(fresh, [], 1200);
		check('a new sender with nothing before the prompt (through: null) does not wait', v5 && v5.lacked === '' && Date.now() - t3 < 500, J(v5));

		// C2 r3 (UNBLOCK-11, daimond-rig-b SYNCGATE 18 Oct): the errand CARRIES the asker's last message in its seed,
		// which the graft lays into the chat, so a runner whose own copy lacks it starts at once. It used to log
		// `ready LACKING` and wait the whole bound for a message it already held on the errand.
		live.messages = live.messages.slice(0, 1);
		const seeded = { chatId: 'chat-r', turnId: 'T', through: { ts: 20, mid: 'm2' }, thread: THR,
			seed: { whole: true, msgs: [{ role: 'user', content: 'q', mid: 'm1', ts: 10 }, { role: 'assistant', content: 'a', mid: 'm2', ts: 20 }] } };
		pulls = 0; arriveOn = -1;
		const t5 = Date.now();
		const v6 = await R.peerReady(seeded, [], 1200);
		const dt6 = Date.now() - t5;
		check('through carried in the errand\'s seed starts at once, nothing lacked', v6 && v6.ok === true && v6.lacked === '' && dt6 < 500, dt6 + ' ms ' + J(v6));
		const absent = Object.assign({}, seeded, { chatId: 'chat-absent' });
		const t6 = Date.now();
		const v7 = await R.peerReady(absent, [], 1200);
		check('so does one whose chat is not here yet, the seed making it', v7 && v7.lacked === '' && Date.now() - t6 < 500, J(v7));
		const short = Object.assign({}, seeded, { seed: { whole: true, msgs: [{ role: 'user', content: 'q', mid: 'm1', ts: 10 }] } });
		const t7 = Date.now();
		const v8 = await R.peerReady(short, [], 1200);
		const dt8 = Date.now() - t7;
		check('through in neither the copy nor the seed still waits the bound and says it lacked', dt8 >= 1100 && /had not yet received/.test((v8 && v8.lacked) || ''), dt8 + ' ms ' + J(v8));

		// C2 r3b (check 2d65): the seed counts only BEFORE the claim. A graft that throws after pushing the empty
		// chat leaves it without `through`; the post-graft checks in reconstruct read the real copy, so the turn
		// says it lacked the asker's last message rather than running silently without it.
		const grafted = { id: 'chat-g', _loaded: true, messages: [] };
		const failed = Object.assign({}, seeded, { chatId: 'chat-g' });
		const note = R.lackedNote ? R.lackedNote(grafted, failed, [], true) : '';
		check('a graft that threw after the chat push leaves the reconstruct\'s "lacked" note', /had not yet received/.test(note || ''), J(note));
		check('the copy-only holdsThrough does not count the seed', P.holdsThrough && P.holdsThrough(grafted, failed) === false);

		// C2 r2 F6: ONE deadline. A pull slower than the time left does not stretch the wait, and the deadline is the
		// one the reconstruct reads, not a second 10 s of its own.
		const slow = win.DaimondSync.pull;
		live.messages = live.messages.slice(0, 1);	// short of through again
		win.DaimondSync.pull = () => new Promise((res) => setTimeout(res, 4000));
		const t4 = Date.now();
		await R.peerReady(errand, [], 800);
		const dt4 = Date.now() - t4;
		win.DaimondSync.pull = slow;
		check('a slow pull is cut at the time left', dt4 < 1500, dt4 + ' ms');
		const by = R.throughDeadline ? R.throughDeadline(errand) : undefined;
		check('peerReady leaves its deadline for the reconstruct', typeof by === 'number' && Math.abs(by - (t4 + 800)) < 100, String(by) + ' vs ' + (t4 + 800));
		check('peerReconstruct waits to that deadline, not a fresh 10 s', /throughBy\s*=\s*throughDeadline\(errand\)/.test(extractFn(DJS, 'peerReconstruct')));
	}
}

// ── REFUSAL GONE ──
console.log('\nREFUSAL: "the conversation differs" is gone\n');
{
	check('daimond.js no longer says it', DJS.indexOf('conversation differs on this device') < 0);
	const rc = extractFn(DJS, 'peerReconstruct');
	check('peerReconstruct no longer hands a differing thread back', rc.length > 0 && rc.indexOf('eThread') < 0 && rc.indexOf("=== 'final') break") < 0);
	// C2-NOTE: it hands the turn the errand, and the turn counts the lack when it lays its history.
	check('it hands the turn what it needs to count the lack', /errand: errand, own: own/.test(rc) && /lacked: lacked/.test(rc) === false);
	check('the turn reads its note at the moment it runs', /ropts = runnerTurnOpts\(c, ropts\)/.test(DJS) && /lackedNote\(c\.chat, c\.errand, c\.own, true\)/.test(extractFn(DJS, 'runnerTurnOpts')));
}

// ── SEARCH: recall over the chat's prose and its fold ──
console.log('\nSEARCH: DaimondTranscript.search\n');
{
	const ts = F.transcriptSearch;
	const rec = { fold: { through: 'a2', throughTs: 4, text: '[Daimond folded the earlier part] we chose BLUE for the logo' },
		messages: [{ role: 'user', content: 'what colour?', mid: 'u5', ts: 5 }, { role: 'assistant', content: 'Blue, as agreed.', mid: 'a5', ts: 6 },
			{ role: 'tool_log', content: 'blue', mid: 't5', ts: 7 }] };
	const hits = ts ? ts(rec, { query: 'blue', ignore_case: true }) : [];
	check('it finds the fold and the prose, not the furniture',
		J(hits.map((h) => h.role + ':' + h.mid)) === J(['fold:a2', 'assistant:a5']), J(hits));
	check('each hit is {mid, ts, role, excerpt}', hits.length > 0 && hits.every((h) => 'mid' in h && 'ts' in h && 'role' in h && typeof h.excerpt === 'string'));
	check('a query that is no expression is searched as text', ts && ts({ messages: [{ role: 'user', content: 'f(x', mid: 'q' }] }, { query: 'f(x' }).length === 1);
	check('the window global answers through it', /window\.DaimondTranscript = \{[\s\S]{0,900}transcriptSearch\(rec, args\)/.test(DJS));
}

console.log('\n' + (checks - failures) + ' of ' + checks + ' checks passed' + (failures ? ', ' + failures + ' FAILED' : ''));
process.exit(failures ? 1 : 0);
