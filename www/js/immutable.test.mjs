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

   P2.3a: the watcher's frame fold (`foldProvisional`, `applyProvisional`)
   is gone; a handed-off turn draws from the chat log (turnlog.test.mjs).
   What stays here: the frame's shape, the control table and the merge laws.

   Run:  node www/js/immutable.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
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
	const body = readPage(join(HERE, 'peer.js'), 'utf8');
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
// at turn end).
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
	check('peer.js exposes the control functions', P && typeof P.dispatchControl === 'function');

	// ── (e) No take-back at all (D-20261009-23); [Run here] on failure. ──
	console.log('\n(e) — the footer control table (owner, D-20261009-23: no take back)');
	{
		check('(e1) a healthy hand-off (dispatched, unclaimed) offers no control',
			P.dispatchControl('dispatched') === '');
		check('(e2) once a peer has CLAIMED, there is no take-back',
			P.dispatchControl('claimed') === '');
		check('(e3) nor while it is RUNNING', P.dispatchControl('running') === '');
		check('(e4) nor while AWAITING CONSENT (a live question)', P.dispatchControl('awaiting-consent') === '');
		check('(e5) nor while BLOCKED on the runner', P.dispatchControl('blocked') === '');
		check('(e6) a FAILED/aborted remote turn offers [Run here]', P.dispatchControl('failed') === 'runhere');
		check('(e7) a turn NO device took offers [Run here]', P.dispatchControl('no-peer-awake') === 'runhere');
		check('(e8) a PARKED turn offers a re-run', P.dispatchControl('parked') === 'rerun');
		check('(e9) a DONE turn offers no control (the answer draws itself)', P.dispatchControl('done') === '');
		// No state of the whole table offers a take-back.
		const states = ['dispatched', 'no-peer-awake', 'failed', 'parked', 'claimed', 'running', 'awaiting-consent', 'blocked', 'done'];
		const takebacks = states.filter((s) => P.dispatchControl(s) === 'takeback');
		check('(e10) NO state offers take-back', takebacks.length === 0, JSON.stringify(takebacks));
	}

	// ── (d) Per-device request/pull rate does not rise vs baseline. ──
	console.log('\n(d) — the streamed fix adds no per-device request, and expedite stays bounded');
	{
		// The AddressGuard storm fix must stand: expedite is stood down after
		// EXPEDITE_MAX_MS, and the value is unchanged (memory reference_daimond_addrguard).
		const syncSrc = readPage(join(HERE, 'sync.js'), 'utf8');
		check('(d3) sync.js EXPEDITE_MAX_MS is still 120000 (the storm fix is intact)',
			/EXPEDITE_MAX_MS\s*=\s*120000/.test(syncSrc));
		check('(d4) sync.js still stands the full pull down past EXPEDITE_MAX_MS',
			/Date\.now\(\)\s*-\s*expediteSince\s*>\s*EXPEDITE_MAX_MS/.test(syncSrc));

		const dSrc = readPage(join(HERE, 'daimond.js'), 'utf8');
		check('(d6) no new expedite trigger was added -- expedite is still driven only by the dispatched index',
			(dSrc.match(/DaimondSync\.expedite\(/g) || []).length === 1);
		check('(d7) the flattened interim view is gone -- no `.handoff-stream` node is built, no painter defined',
			!/className\s*=\s*'handoff-stream'/.test(dSrc)
			&& !/function paintProgressTile/.test(dSrc)
			&& !/function progressNodeFor/.test(dSrc));
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
		// The parcel carries the durable answer AND the tail-note user message. After
		// the merge both are present: the answer converged by mid (no dup), the
		// tail-note appended as a NON-provisional user message (the table's source).
		const merged = mergeMessages(runner, baseTranscript());
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
		const dSrc = readPage(join(HERE, 'daimond.js'), 'utf8');
		// `_tailNoteTable` now takes the chat as its second argument (S-HAND #4: the id is
		// resolved from `chat.diamondId`, so a daimon chat opened from the chat list -- where
		// `currentDiamond` is null -- still finds its manifests), so the call is
		// `_tailNoteTable(text, current)`.
		check('(g7) the #22 table is diverted in appendUserMessage (the user tail-note path), not the stream',
			/_tailNoteTable\(text,/.test(dSrc) && /function appendUserMessage/.test(dSrc));
	}

	// ── (h) U1 provenance: a handed-off answer's provisional and final copies carry
	//    BYTE-IDENTICAL `prod`, stamped once at turn start (rating design §3.5). ──
	console.log('\n(h) — the answer\'s product record is the same bytes on every copy');
	{
		const win = {};
		new Function('window', readPage(join(HERE, 'pricing.js'), 'utf8'))(win);
		new Function('window', readPage(join(HERE, 'provenance.js'), 'utf8'))(win);
		const V = win.DaimondProvenance;
		const AMID = 'ans-h';
		// What runTurn stamps before a token streams, on the RUNNER.
		const PROD = V.stamp({ h: V.h.answer('cX', AMID), k: 'answer', m: 'accounts/fireworks/models/glm-5p2',
			pv: 'fireworks', role: 'chat', sp: 'sp1:0badf00d', d: '', c: 'cX', t: 'U', dev: 'dev-runner',
			at: 1790000000000 });
		const bytes = JSON.stringify(PROD);
		const settled = runnerSettled(AMID);
		settled[settled.length - 1].prod = PROD;
		// And the record is chrome: `msgSig` does not read it, so it can never force a rebuild.
		const bare = Object.assign({}, settled[settled.length - 1]); delete bare.prod;
		check('(h7) the drawing signature ignores the record', msgSig(bare) === msgSig(settled[settled.length - 1]));
		const dSrc = readPage(join(HERE, 'daimond.js'), 'utf8');
		const sigSrc = dSrc.split('function msgSig(')[1].split('\n\t}')[0];
		check('(h8) daimond.js msgSig does not read `prod` either', sigSrc.indexOf('prod') < 0);
		// The streamed live row went with the turn frames (P2.3, design §5); the log's live
		// row and the finished answer are one `answerRow`, with the record stamped at turn start.
		check('(h9) the answer takes the record stamped at turn start (answerRow)',
			/_liveProd\[String\(umid\)\] = aprod/.test(dSrc) && /if \(prod\) row\.prod = \[prod\]/.test(dSrc)
			&& /var amsg = answerRow\(String\(umid\), amid, turnText, aprod,/.test(dSrc));

	}

	// ── (i) P1b: a chat's Files row (`files_log`) is appended last, under its answer, so the thread
	//    already drawn is never rebuilt for it. ──
	console.log('\n(i) — a chat\'s files_log is an append, and never leaves its answer');
	{
		const turn = [
			{ role: 'user', content: 'write the files', mid: 'U', ts: 100 },
			{ role: 'tool_log', name: 'file_write', content: 'ok', outcome: 'done', callId: 't1', mid: 'T', ts: 101 },
			{ role: 'assistant', content: 'Written.', mid: 'AN', ts: 120 },
		];
		const FL = { role: 'files_log', mid: 'FL', ts: 121, prod: [{ h: 'p1:file:chat:c1/v2/chats/c1/work/n.md', k: 'file' }] };
		const END = { role: 'end_log', how: 'done', offered: 1, mid: 'EN', ts: 122 };
		check('(i1) the row appended after the answer keeps the drawn prefix, so the thread is not rebuilt',
			noRebuild(sigsOf(turn), sigsOf(turn.concat([FL]))));
		check('(i2) and the ending after it is one more append',
			noRebuild(sigsOf(turn.concat([FL])), sigsOf(turn.concat([FL, END]))));
		check('(i3) a row inserted BEFORE the answer changes the drawn prefix and would force a rebuild (the mutation this guards)',
			!noRebuild(sigsOf(turn), sigsOf([turn[0], turn[1], FL, turn[2]])));
		check('(i4) the row\'s signature reads its id and role and no record, so a rating on it never changes it',
			msgSig(FL) === msgSig(Object.assign({}, FL, { prod: [] })) && /#files_log#0#/.test(msgSig(FL)), msgSig(FL));
		const merged = mergeMessages(turn, turn.concat([FL]));
		check('(i5) a parcel that carries the row merges it once, after the answer',
			merged.map((m) => m.mid).join() === 'U,T,AN,FL', merged.map((m) => m.mid));
		const again = mergeMessages(merged, merged);
		check('(i6) and merging it again is a no-op (first copy wins, nothing doubles)',
			again.length === merged.length && sigsOf(again).join('|') === sigsOf(merged).join('|'));
	}

	console.log(failures ? ('\nFAIL — ' + failures + '/' + checks + ' checks') : '\nALL PASS');
	if (failures) process.exitCode = 1;
}

import('node:test').then(({ test }) => {
	test(fileURLToPath(import.meta.url), main);
}).catch(() => { main(); });
