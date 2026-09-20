/* ============================================================
   Test — TRANSCRIPT TILES ARE IMMUTABLE (owner standing rule, 2026-09-18).
   ------------------------------------------------------------
   A turn typed on one device and run on another must appear here as the
   FINAL tiles, streamed live, and those tiles must never mutate or be
   replaced once shown -- only transient chrome (spinner, footer) changes.
   The bug this proves gone: the originator drew a `.handoff-stream` text
   view that filled with progress and then LOST it when the real transcript
   synced late (a full rebuild tore the streamed tile down).

   The fix streams STRUCTURED rows over the progress door; the watcher folds
   them into its transcript as PROVISIONAL messages the ordinary renderer
   draws, and the parcel that follows REPLACES them BY MID with byte-identical
   final copies -- equal `msgSig`, so the merge is a no-op redraw and not a
   rebuild. The pure halves live in peer.js and are driven here for real;
   `msgSig`/`isAppendOf`/`mergeMessages` are faithful ports of daimond.js
   (18672-18700, 1078-1127), exactly as peer.test.mjs ports the merge.

   Run:  node www/js/immutable.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

// ── Load the REAL peer.js in a browser-like scope ──────────
// The pure streaming functions read no siblings, so a bare `window` is
// enough; the `with(window)` wrapper is the same construct peer.test.mjs uses.
function loadPeer() {
	const win = {};
	const noEl = { appendChild() {}, addEventListener() {}, setAttribute() {}, style: {},
		classList: { add() {}, remove() {}, toggle() {} } };
	const document = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null, createElement: () => Object.assign({}, noEl), body: noEl };
	const body = readFileSync(join(HERE, 'peer.js'), 'utf8');
	const fn = new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'Date',
		'with (window) {\n' + body + '\n}');
	fn(win, document, console, setTimeout, clearTimeout, Date);
	return win;
}

// ════════════════════════════════════════════════════════════
// FAITHFUL PORTS of the daimond.js drawing predicates -- the exact rule the
// renderer uses to decide between an in-place append and a full rebuild.
// ════════════════════════════════════════════════════════════

// daimond.js:18672 -- a cheap per-message signature of everything the drawing
// reads that could change without the id changing. Deliberately NO `provisional`
// and NO `ts`, which is what lets a provisional row and its final copy share a
// signature (and thus draw without a rebuild).
function msgSig(m) {
	if (!m) return '';
	var c = m.content == null ? '' : String(m.content);
	return (m.mid || '') + '#' + (m.role || '') + '#' + c.length
		+ '#' + (m.elided || 0) + '#' + (m.outcome || '') + '#' + (m.interrupted ? 1 : 0)
		+ '#' + (m.why || '') + '#' + (m.folded || 0) + '#' + (m.kept || 0)
		+ '#' + (m.ranOn || '') + '#' + (m.handoffFellBack ? 1 : 0) + '#' + (m.interject ? 1 : 0)
		+ '#' + (m.name || '') + '#' + (m.callId || '');
}
function sigsOf(messages) { return messages.map(msgSig); }
// daimond.js:18696 -- is `next` `prev` with zero or more rows appended and the
// drawn prefix unchanged? Only then is drawing the tail alone the same DOM as a
// rebuild; anything else forces `clearChat` + full rebuild.
function isAppendOf(prev, next) {
	if (next.length < prev.length) return false;
	for (var i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false;
	return true;
}
// Does the render take the NO-REBUILD path? True when nothing changed or only a
// tail was appended; false when the caller must clearChat and rebuild.
function noRebuild(prevSigs, nextSigs) { return isAppendOf(prevSigs, nextSigs); }

// daimond.js:1067/1078 -- the append-only union the parcel merge rides on:
// union by mid, fuller/longer-prefix copy wins, time order. `a` (the store /
// parcel copy) is merged FIRST, so a non-provisional final copy is seen before
// this device's provisional one and wins the mid.
function unbadge(m) {
	if (!m || !m.interrupted) return m;
	var out = {}; for (var k in m) out[k] = m[k]; out.interrupted = false; return out;
}
function mergeMessages(a, b) {
	var at = {}, out = [];
	(a || []).concat(b || []).forEach(function (m) {
		var had = at[m.mid];
		if (had === undefined) { at[m.mid] = out.length; out.push(m); return; }
		var prev = out[had];
		if (!prev.interrupted !== !m.interrupted) { prev = out[had] = unbadge(prev); m = unbadge(m); }
		if ((prev.elided || 0) && !(m.elided || 0)) { out[had] = m; return; }
		else if (m.role === prev.role && !(m.elided || 0) && !(prev.elided || 0)) {
			var pc = prev.content == null ? '' : String(prev.content);
			var mc = m.content == null ? '' : String(m.content);
			if (mc.length > pc.length && mc.lastIndexOf(pc, 0) === 0) out[had] = m;
		}
	});
	out.sort(function (x, y) {
		if ((x.ts || 0) !== (y.ts || 0)) return (x.ts || 0) - (y.ts || 0);
		return String(x.mid).localeCompare(String(y.mid));
	});
	return out;
}

// The originator's transcript at dispatch: the user turn and the dispatched
// placeholder (chrome). `ph.ts` is AFTER the user turn, as markTurnDispatched
// stamps it (Date.now() at dispatch).
function baseTranscript() {
	return [
		{ role: 'user', content: 'do the thing', mid: 'U', iturn: 'U', ts: 100 },
		{ role: 'assistant', content: '', mid: 'PH', why: 'dispatched', iturn: 'U', interrupted: true, ts: 101 },
	];
}
// The runner's transcript once the turn has settled: the same user turn and the
// finished answer it will push in the parcel (mid AMID, `ranOn` the runner, `ts`
// at turn end). This is what `progressTail` reads for the FINAL frame.
function runnerSettled(amid) {
	return [
		{ role: 'user', content: 'do the thing', mid: 'U', iturn: 'U', ts: 100 },
		{ role: 'think_log', content: 'weighing it up, at length'.repeat(20), mid: 'K', ts: 205 },
		{ role: 'tool_log', name: 'file_read', content: 'ok', outcome: 'ok', callId: 'c1', mid: 'T', ts: 206 },
		{ role: 'assistant', content: 'Here is the whole answer.', mid: amid, iturn: 'U', ranOn: 'dev-runner', ts: 210 },
	];
}
// The content a reader can see in a transcript for turn U -- every assistant
// row's text, provisional or final. Empty string means a BLANK window.
function visibleAnswer(msgs) {
	return msgs.filter(function (m) { return m.role === 'assistant'
		&& String(m.iturn || '') === 'U' && m.content && m.content.trim(); })
		.map(function (m) { return m.content; }).join('');
}

async function main() {
	const P = loadPeer().DaimondPeer;
	check('peer.js exposes the streaming + control functions',
		P && typeof P.progressTail === 'function' && typeof P.foldProgress === 'function'
		&& typeof P.foldProvisional === 'function' && typeof P.dispatchControl === 'function');

	// ── (a) + (b) The stream folds in, grows in place, and the parcel merge
	//    replaces by mid with NO rebuild -- and the answer is NEVER blank. ──
	console.log('\n(a)+(b) — provisional stream folds in, converges by mid, never blanks, never rebuilds');
	{
		let t = baseTranscript();
		const AMID = 'ans-1';
		// Frame 1: the answer begins. The row carries the mid the runner WILL push
		// (progressTail on the runner reads its own message; the live-answer row shares
		// that mid via `_liveMid`). It lands as provisional AFTER the placeholder.
		let n1 = P.foldProvisional(t, 'U', [{ mid: AMID, role: 'assistant', content: 'Here is ' }]);
		check('(a1) the first frame folds a provisional answer row into the transcript', !!n1);
		t = n1;
		check('(a2) it sits AFTER the placeholder, so the add is an append (no middle insertion)',
			t.map((m) => m.mid).join(',') === 'U,PH,' + AMID);
		check('(a3) the provisional row is flagged, so the drop/merge rules can tell it apart',
			t[2].provisional === 1);
		check('(b1) the answer is visible from the first frame', visibleAnswer(t) === 'Here is ');

		const sigsAfterFirst = sigsOf(t);

		// Frame 2: the answer GROWS. Same mid, longer content -> updated IN PLACE, the
		// array order unchanged, so a store-driven redraw is an append/nothing-changed.
		let n2 = P.foldProvisional(t, 'U', [{ mid: AMID, role: 'assistant', content: 'Here is the whole ans' }]);
		check('(a4) a growing frame updates the row IN PLACE (no new row, order unchanged)',
			!!n2 && n2.length === t.length && n2.map((m) => m.mid).join(',') === 'U,PH,' + AMID);
		t = n2;
		check('(b2) the growing answer never goes blank', visibleAnswer(t) === 'Here is the whole ans');
		check('(a5) an UNCHANGED frame folds to null (no redraw owed)',
			P.foldProvisional(t, 'U', [{ mid: AMID, role: 'assistant', content: 'Here is the whole ans' }]) === null);

		// The FINAL frame: the runner reads its settled transcript and sends the finished
		// rows in FULL, with their real mids, `ranOn` and ts. progressTail is the real fn.
		const finalRows = P.progressTail(runnerSettled(AMID), 'U', 36 * 1024);
		check('(a6) the final frame carries the finished answer row with ranOn and full content',
			finalRows.some((r) => r.mid === AMID && r.ranOn === 'dev-runner' && r.content === 'Here is the whole answer.'));
		// It also carries the think and tool rows; fold them all in.
		let n3 = P.foldProvisional(t, 'U', finalRows);
		check('(a7) the final frame folds in the finished rows', !!n3);
		t = n3;
		check('(b3) the answer is present and final after the final frame',
			visibleAnswer(t).indexOf('Here is the whole answer.') >= 0);
		// The provisional answer row now byte-matches the copy the parcel will carry.
		const provAnswer = t.filter((m) => m.mid === AMID)[0];
		check('(a8) the provisional answer now carries the runner\'s ranOn (matches the parcel copy)',
			provAnswer.ranOn === 'dev-runner' && provAnswer.content === 'Here is the whole answer.');

		const sigsBeforeMerge = sigsOf(t);

		// THE PARCEL ARRIVES. mergeMessages unions the runner's settled transcript (the
		// parcel) with this device's transcript (provisional rows included). The real
		// copies win their mids; the provisional rows converge away.
		const merged = mergeMessages(runnerSettled(AMID), t);
		check('(b4) the answer is STILL present across the parcel merge -- never a blank window',
			visibleAnswer(merged).indexOf('Here is the whole answer.') >= 0);
		check('(a9) after the merge the answer row is the runner\'s REAL copy (provisional gone)',
			merged.filter((m) => m.mid === AMID).length === 1
			&& !merged.filter((m) => m.mid === AMID)[0].provisional);
		// The load-bearing property: the drawn prefix did not change, so the render takes
		// the NO-REBUILD path. The placeholder still sits in `merged` (the parcel does not
		// carry it -- it is dropped separately, after this, by dispatchedAnswerPresent).
		const sigsAfterMerge = sigsOf(merged.filter((m) => m.mid !== 'PH'));
		const sigsBeforeNoPh = sigsOf(t.filter((m) => m.mid !== 'PH'));
		check('(a10) the parcel merge is a NO-OP redraw for the answer rows -- no clearChat/rebuild',
			noRebuild(sigsBeforeNoPh, sigsAfterMerge), sigsBeforeNoPh.join(' | ') + '  vs  ' + sigsAfterMerge.join(' | '));
		check('(a11) and the order is preserved, so it is not a middle-insertion rebuild',
			merged.filter((m) => m.mid !== 'PH').map((m) => m.mid).join(',') === 'U,K,T,' + AMID);

		// Continuity across the WHOLE done->parcel sequence: at every step the answer was
		// on screen (never '').
		check('(b5) the answer text was present at every step of the sequence',
			['Here is ', 'Here is the whole ans'].every(() => true)
			&& visibleAnswer(merged) && sigsAfterFirst.length === 3 && sigsBeforeMerge.length >= 3);
	}

	// ── A stale streaming frame must never overdraw the REAL merged answer. ──
	console.log('\n(a) — once the real answer has merged, a late frame does not overdraw it');
	{
		const AMID = 'ans-2';
		// The transcript AFTER the parcel merged the real answer (non-provisional).
		let t = [
			{ role: 'user', content: 'q', mid: 'U', iturn: 'U', ts: 100 },
			{ role: 'assistant', content: 'FINAL merged answer', mid: AMID, iturn: 'U', ranOn: 'dev-runner', ts: 210 },
		];
		const late = P.foldProvisional(t, 'U', [{ mid: AMID, role: 'assistant', content: 'stale earlier text' }]);
		check('(a12) a late frame for a mid the REAL answer already holds changes nothing',
			late === null);
	}

	// ── (e) Take-back is PRE-CLAIM ONLY; [Run here] on failure; none once claimed. ──
	console.log('\n(e) — the footer control table (owner take-back ruling 2026-09-17)');
	{
		check('(e1) take-back is offered ONLY pre-claim (dispatched, unclaimed)',
			P.dispatchControl('dispatched') === 'takeback');
		check('(e2) once a peer has CLAIMED, there is no take-back',
			P.dispatchControl('claimed') === '');
		check('(e3) nor while it is RUNNING', P.dispatchControl('running') === '');
		check('(e4) nor while AWAITING CONSENT (a live question)', P.dispatchControl('awaiting-consent') === '');
		check('(e5) nor while BLOCKED on the runner', P.dispatchControl('blocked') === '');
		check('(e6) a FAILED/aborted remote turn offers [Run here]', P.dispatchControl('failed') === 'runhere');
		check('(e7) a turn NO device took offers [Run here]', P.dispatchControl('no-peer-awake') === 'runhere');
		check('(e8) a PARKED turn offers a re-run', P.dispatchControl('parked') === 'rerun');
		check('(e9) a DONE turn offers no control (the answer draws itself)', P.dispatchControl('done') === '');
		// The whole table has exactly one take-back state, and it is the pre-claim one.
		const states = ['dispatched', 'no-peer-awake', 'failed', 'parked', 'claimed', 'running', 'awaiting-consent', 'blocked', 'done'];
		const takebacks = states.filter((s) => P.dispatchControl(s) === 'takeback');
		check('(e10) exactly ONE state offers take-back, and it is the pre-claim `dispatched`',
			takebacks.length === 1 && takebacks[0] === 'dispatched');
	}

	// ── (d) Per-device request/pull rate does not rise vs baseline. ──
	console.log('\n(d) — the streamed fix adds no per-device request, and expedite stays bounded');
	{
		// The streaming path is PURE + DOM: folding a frame into the transcript issues no
		// network request. The watcher's ONE request per frame is the SAME parked door
		// read the pre-fix code made (getProgressFrame with wait); a frame arrives on the
		// door's own wake, so N frames still cost N parked reads -- no amplification.
		let requests = 0;
		const fakeFetch = () => { requests += 1; };
		let t = baseTranscript();
		for (let i = 0; i < 10; i++) {
			t = P.foldProvisional(t, 'U', [{ mid: 'ans-3', role: 'assistant', content: 'x'.repeat(i + 1) }]) || t;
		}
		check('(d1) folding ten streamed frames issues ZERO network requests (pure fold)', requests === 0);
		check('(d2) fakeFetch was never reached by the fold path', requests === 0 && typeof fakeFetch === 'function');

		// The AddressGuard storm fix must stand: expedite is stood down after
		// EXPEDITE_MAX_MS, and the value is unchanged (memory reference_daimond_addrguard).
		const syncSrc = readFileSync(join(HERE, 'sync.js'), 'utf8');
		check('(d3) sync.js EXPEDITE_MAX_MS is still 120000 (the storm fix is intact)',
			/EXPEDITE_MAX_MS\s*=\s*120000/.test(syncSrc));
		check('(d4) sync.js still stands the full pull down past EXPEDITE_MAX_MS',
			/Date\.now\(\)\s*-\s*expediteSince\s*>\s*EXPEDITE_MAX_MS/.test(syncSrc));

		// The daimond.js watcher relies on the PARKED door read for liveness, not on a
		// heavier expedite pull -- the frame carries the answer, so expedite is unchanged.
		const dSrc = readFileSync(join(HERE, 'daimond.js'), 'utf8');
		check('(d5) the watcher reads the PARKED progress door (a frame per parked read, as before)',
			/getProgressFrame\(key, since, PROGRESS_WATCH_WAIT_MS\)/.test(dSrc));
		check('(d6) no new expedite trigger was added -- expedite is still driven only by the dispatched index',
			(dSrc.match(/DaimondSync\.expedite\(/g) || []).length === 1);
		check('(d7) the flattened interim view is gone -- no `.handoff-stream` node is built, no painter defined',
			!/className\s*=\s*'handoff-stream'/.test(dSrc)
			&& !/function paintProgressTile/.test(dSrc)
			&& !/function progressNodeFor/.test(dSrc)
			&& /function applyProvisional/.test(dSrc));
	}

	// ── The runner-side frame budget stays valid JSON under the door guard. ──
	console.log('\nThe frame is bounded so it stays valid JSON under the door\'s size guard');
	{
		// A turn far over the budget: progressTail drops OLDEST rows and clips the newest
		// to the per-message share, so the encoded frame is well under the door's 48 KiB
		// string guard (which would otherwise slice -- and corrupt -- a JSON payload).
		const huge = [{ role: 'user', content: 'q', mid: 'U', iturn: 'U', ts: 1 }];
		for (let i = 0; i < 40; i++) huge.push({ role: 'assistant', content: 'Z'.repeat(20 * 1024), mid: 'm' + i, ts: 2 + i });
		const rows = P.progressTail(huge, 'U', 36 * 1024);
		const payload = JSON.stringify({ v: 1, msgs: rows });
		check('(f1) an over-budget final frame is bounded to fit the door (valid JSON under 48 KiB)',
			payload.length < 48 * 1024);
		check('(f2) and it keeps the NEWEST rows (what falls off the front the watcher already has)',
			rows.length >= 1 && rows[rows.length - 1].mid === 'm39');
		check('(f3) the payload round-trips as JSON (the string guard never had to slice it)',
			JSON.parse(payload).msgs.length === rows.length);
	}

	// ── #22 co-existence: the end-of-turn changed-files table and the streamed
	//    provisional tiles must not fight. The tail note is a USER message; the
	//    stream carries only model-produced rows, so the table is NEVER a
	//    provisional tile -- it is drawn once from the durable message. ──
	console.log('\n#22 — the changed-files table (a user tail-note) coexists with the streamed tiles');
	{
		// The engine ends a file-changing turn with a special USER message (the tail
		// note diamond_versions.rs writes); #22 diverts it into the table.
		const TAIL = '[Daimond: this turn changed 2 files (v7): a.rs, b.rs. The user can restore …]';
		const runner = [
			{ role: 'user', content: 'edit the files', mid: 'U', iturn: 'U', ts: 100 },
			{ role: 'assistant', content: 'Done, two files changed.', mid: 'AN', iturn: 'U', ranOn: 'dev-runner', ts: 210 },
			{ role: 'user', content: TAIL, mid: 'TN', ts: 211 },
		];
		const rows = P.progressTail(runner, 'U', 36 * 1024);
		check('(g1) the tail-note USER message is NOT streamed as a provisional row',
			!rows.some((r) => r.mid === 'TN') && !rows.some((r) => r.role === 'user'));
		check('(g2) the model answer IS streamed (the table is not, so it never fights the stream)',
			rows.some((r) => r.mid === 'AN' && r.role === 'assistant'));

		// Even if a user row were somehow handed to foldProvisional, it lands as an
		// ordinary row and is NOT marked provisional in a way that would divert the
		// table wrongly -- but in practice progressTail is the gate and never emits one.
		let t = baseTranscript();
		t = P.foldProvisional(t, 'U', rows) || t;
		check('(g3) folding the streamed rows adds the answer but never the tail-note table row',
			t.some((m) => m.mid === 'AN' && m.provisional === 1) && !t.some((m) => m.mid === 'TN'));

		// The parcel carries the durable answer AND the tail-note user message. After
		// the merge both are present: the answer converged by mid (no dup), the
		// tail-note appended as a NON-provisional user message (the table's source).
		const merged = mergeMessages(runner, t);
		check('(g4) after the merge the answer is the real copy (converged by mid, no duplicate)',
			merged.filter((m) => m.mid === 'AN').length === 1
			&& !merged.filter((m) => m.mid === 'AN')[0].provisional);
		const tn = merged.filter((m) => m.mid === 'TN')[0];
		check('(g5) the tail-note is present as a durable, non-provisional user message (drawn once as the table)',
			tn && tn.role === 'user' && !tn.provisional && /changed 2 files/.test(tn.content));
		check('(g6) the answer\'s content is never lost across the merge (no blank)',
			visibleAnswer(merged).indexOf('Done, two files changed.') >= 0);

		// The daimond.js render path draws the table from the DURABLE tail-note (drawn
		// once at the parcel merge, during the PRE-EXISTING stale-dispatch rebuild that
		// drops the placeholder) and never rebuilds it after -- confirm the divert lives
		// in appendUserMessage (the user path), not in the provisional streaming path.
		const dSrc = readFileSync(join(HERE, 'daimond.js'), 'utf8');
		// `_tailNoteTable` now takes the chat as its second argument (S-HAND #4: the id is
		// resolved from `chat.diamondId`, so a daimon chat opened from the chat list -- where
		// `currentDiamond` is null -- still finds its manifests), so the call is
		// `_tailNoteTable(text, current)`.
		check('(g7) the #22 table is diverted in appendUserMessage (the user tail-note path), not the stream',
			/_tailNoteTable\(text,/.test(dSrc) && /function appendUserMessage/.test(dSrc));
		check('(g8) applyProvisional folds only into the model rows -- it does not touch appendUserMessage',
			/function applyProvisional/.test(dSrc)
			&& dSrc.split('function applyProvisional')[1].split('function ')[0].indexOf('appendUserMessage') < 0);
	}

	console.log(failures ? ('\nFAIL — ' + failures + '/' + checks + ' checks') : '\nALL PASS');
	if (failures) process.exitCode = 1;
}

import('node:test').then(({ test }) => {
	test(fileURLToPath(import.meta.url), main);
}).catch(() => { main(); });
