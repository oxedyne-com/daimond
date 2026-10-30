// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { chatOutput, diamondBusy, pg } from './state.js';
import { readJson, t } from './util.js';
import { ChatStore, chatTaintOf, ensureDispatchedResident, loadChatMessages, msgJoin, msgTombstone, newMid,
	onChatsChangedElsewhere, persistChats, stampMessages, takeReportTaint, touchChat, touchMsg } from './chatstore.js';
import { DEVICE_ID_RE, loadDevices, nominatedDeviceId } from './parcel_collect.js';
import { ARRIVE_FRESH_MS, noteArrive } from './parcel_apply.js';
import { _threadScope, captureSession, ensureApp, honourGone, scopeTurnApp, settleRunnerAlerts,
	settleRunnerAsk, settleRunnerSession, settleRunnerWords, syncComposer, threadScopeKey } from './send.js';
import { drainAfterHeld, drainHeldQueues, drainQueue, drainSteerQueue, heedUnheard, interjectMessage,
	leaseDoorRead, requeueUnheard, runTurn } from './steer.js';
import { PeerAgents, Workers } from './workers.js';
import { Files } from './files_view.js';
import { _enginePoison, endTurnEngine } from './layout.js';
import { errandModelOf, storedEffort, storedPre, turnEffortOf } from './rating.js';
import { _electionTrace, _handoffStart, answerUnhanded, autoLogHandoffLatency, continueTurn,
	notRunCause, presenceTick, renderSeatSwitch, seatReason, seatSwitchFor } from './sourcemenu.js';
import { diag, toast } from './passkey_phrase.js';
import { logCursor, panelIntent, readChat, turnEnded, turnView, viewMessages } from './turnlog.js';
import { cutAccount, dispatchedAnswerPresent, followActivity, followsEnd, handoffTargetLabel,
	isLostRow, renderHistory, sigsOf, tilePeek } from './turns.js';
import { _openAsk, _peerStopping, _runnerCtx, _runnerParked, adoptRemoteGrant, busyForChat,
	chatHasWork, deliverGrant, noticeDialog, noticePermit, ownTurns, queueBehind, raiseConsentFromPeer,
	reRaiseOpenAsks, runnerCtxBegin, runnerCtxEnd, runnerDeaf, scopeChatTo } from './consent.js';
import { abortTurn, syncSendMode, turnHold } from './chats.js';
import { endInterrupted, logEnd, notRunEnd, readerEnded } from './turnwrite.js';
import { runnerPairPoll } from './pending.js';
import { diamondCanRun, dispatchToPeer, loadDiamonds } from './diamonds.js';
import { claimedModelsOf, runSteerDetached, sentModelsOf, setCrystalBusy } from './crystal.js';
import { recordCarriedTurn, undoTurnDeps, undoTurnProbe, undoneFromRunner } from './marks.js';
// page-split: end imports
let presenceOnReturn; // page-split: hoisted

// ── Hand a turn to a peer (dev/PEER_DESIGN.md §4, step 4) ───
//
// The THIN wiring. The order and the whole errand live in
// `DaimondPeer.buildDispatch`; this runs the order and nothing more, so the
// load-bearing sequence (§4.1) is under test in peer.test.mjs rather than buried
// here. The auto-dispatch path (send-time, `maybeAutoDispatch`) drives this; the
// loss-branch auto-dispatch is step 4b, gated behind the iOS loss classifier, and
// is deliberately NOT wired here.

/// Is `chat` the one on screen right now (and still a live chat)? The IIFE-scope
/// ownership check the peer wiring needs. `runTurn` has its own arg-less `owns`
/// closed over its turn's chat; that closure is invisible out here, so the peer
/// functions must not call a bare `owns()` (a ReferenceError that killed every
/// dispatch) — they call this with the chat they mean.
export function ownsChat(chat) {
	return pg.current === chat && pg.chats.indexOf(chat) !== -1;
}

/// Mark a local turn peer-held, so recoverInterrupted and Continue leave it
/// alone (the record shape the `offline` branch of runTurn's catch writes, with
/// the dispatched reason). An empty placeholder, because a dispatch happens
/// before any token.
export function markTurnDispatched(chat, mark) {
	chat.messages = chat.messages || [];
	// ONE TILE PER TURN (S-HAND #5). A re-dispatch of the same turn (a hand-back
	// re-driven to the runner) marks the SAME turn again; a second `why:'dispatched'` row would
	// draw a SECOND hand-off tile (drawHistoryMessage draws one per row). So an existing
	// EMPTY placeholder for this turn is updated IN PLACE -- the seat, the target and the
	// park count move; its `mid`, its `triedDevices` and its provenance are kept; a
	// stale `refused` is cleared because the turn is being re-tried. Only when none
	// exists is a row pushed.
	var existing = null;
	for (var pi = chat.messages.length - 1; pi >= 0; pi--) {
		var pm = chat.messages[pi];
		if (pm && pm.why === mark.why && String(pm.iturn) === String(mark.iturn)
			&& !(pm.content && pm.content.trim())) { existing = pm; break; }
	}
	if (existing) {
		// WHERE this turn is now sent. Kept: mid, iturn, why, and `triedDevices`.
		existing.toDevice     = mark.toDevice || '';
		existing.toName       = mark.toName || '';
		existing.dispatchedBy = mark.dispatchedBy;
		existing.parkCount    = mark.parkCount | 0;
		existing.itext        = mark.itext;
		existing.ts           = Date.now();
		if (mark.stepAway) existing.stepAway = true; else delete existing.stepAway;
		if (mark.toNative) existing.toNative = 1; else delete existing.toNative;
		delete existing.refused;		// a re-dispatch supersedes the last refusal
		delete existing.busyBy;			// and the last seat's busy hand-back (Q19)
		delete existing.threadBy;		// and its thread hand-back (D2)
		delete existing.overDoor;		// and its session reference (KT-4b): the next seal decides
		// The elected device joins what the retries already recorded, never replaces it.
		(mark.tried || []).forEach(function (id) {
			var had = Array.isArray(existing.triedDevices) ? existing.triedDevices : [];
			if (id && had.indexOf(id) === -1) existing.triedDevices = had.concat([id]);
		});
		// A re-dispatch is an edit: stamped, so every device's union takes the new seat
		// over the copy it holds (`msgJoin`), where first-wins kept the old one.
		touchMsg(existing);
	} else {
		var rec = {
			role:        'assistant',
			content:     '',
			mid:         newMid(),
			interrupted: true,
			why:         mark.why,			// 'dispatched'
			iturn:       mark.iturn,
			itext:       mark.itext,
			dispatchedBy: mark.dispatchedBy,
			// WHERE this turn was sent, for the hand-off tile's "Handed off to <device>"
			// before any lease holder is known. A best guess (the dispatch's chosen
			// peer); once a peer claims the lease, the holder is authoritative and the
			// tile follows it. Undefined on a re-dispatch that named no target.
			toDevice:    mark.toDevice || '',
			toName:      mark.toName || '',
			parkCount:   mark.parkCount | 0,	// the GLOBAL park count, synced on the placeholder
			ts:          Date.now(),
		};
		// The device the errand was elected to, tried from the first send (R4b).
		if (Array.isArray(mark.tried) && mark.tried.length) rec.triedDevices = mark.tried.slice();
		if (mark.stepAway) rec.stepAway = true;
		if (mark.toNative) rec.toNative = 1;	// a native runner's road (RT-C)
		chat.messages.push(touchMsg(rec));
	}
	diag('handoff mark', (chat && chat.id) + ' turn=' + mark.iturn
		+ ' to=' + (mark.toDevice ? mark.toDevice.slice(0, 8) : '?') + ' parks=' + (mark.parkCount | 0));
	// The one place a dispatched placeholder is created: keep the index in step, and
	// start the in-flight poll for the answer.
	if (chat.id && mark.iturn) { _dispatchedIx[String(mark.iturn)] = chat.id; updateExpedite(); }
	if (ownsChat(chat)) renderHistory(chat.messages);
	touchChat(chat);
	persistChats();
	// Guarded: tests lift this function out alone (peer.test R4b, saidrunner).
	if (typeof noteDispatch === 'function') noteDispatch(chat, mark);
}

// ── The dispatch note (UNBLOCK-44d, `DaimondPeer.dispatchNote`) ──
//
// The other devices are told of a hand-off AT ONCE, in this device's agents frame, which
// every page already follows: they hold its user row and placeholder within a second and
// follow the runner's frames from the first, where the parcel (a whole account, 40 s on
// the owner's road) left them starting late. Held in memory: a note lives while its turn
// can stream, and the parcel carries the rows for good.
var _dispNotes = Object.create(null);
var DISP_NOTE_LIVE_MS = 10 * 60 * 1000;

/// Note a hand-off THIS device asked for, and send the frame now.
function noteDispatch(chat, mark) {
	try {
		var tid = String((mark && mark.iturn) || ''), self = selfDeviceId();
		if (!chat || !chat.id || !tid || !self || String(mark.dispatchedBy || '') !== self) return;
		var ms = chat.messages || [], ph = null, user = null;
		for (var i = ms.length - 1; i >= 0; i--) {
			var m = ms[i];
			if (!m) continue;
			if (!ph) { if (m.why === REASON_DISPATCHED_STR && String(m.iturn || '') === tid) ph = m; continue; }
			if (m.role === 'user') { user = m; break; }
		}
		if (!ph) return;
		var rows = JSON.parse(JSON.stringify(user ? [user, ph] : [ph]));
		_dispNotes[tid] = { tid: tid, cid: String(chat.id), by: self, at: Date.now(), rows: rows };
		PeerAgents.publishNow();
	} catch (e) { /* the parcel still carries it */ }
}

/// The notes still worth sending: young, and their turn still watched or unclaimed here.
export function liveDispatchNotes() {
	var now = Date.now(), out = [];
	for (var t in _dispNotes) {
		if (!Object.prototype.hasOwnProperty.call(_dispNotes, t)) continue;
		var n = _dispNotes[t];
		if (now - n.at > DISP_NOTE_LIVE_MS || !dispatchedChat(t) || !_watchIx[t]) { delete _dispNotes[t]; continue; }
		out.push(n);
	}
	return out;
}

/// A peer's notes, read off its agents frame: the rows this device lacks are added to a
/// chat it holds, and the turn is watched at once. A chat not held here, or not resident,
/// waits for the parcel as before.
export function takeDispatchNotes(notes) {
	if (!Array.isArray(notes) || !notes.length || !window.DaimondPeer || !DaimondPeer.dispatchNoteRows) return;
	var self = selfDeviceId(), now = Date.now(), moved = false;
	notes.forEach(function (n) {
		try {
			var chat = null;
			for (var i = 0; i < pg.chats.length; i++) if (pg.chats[i] && pg.chats[i].id === n.cid) { chat = pg.chats[i]; break; }
			if (!chat || !chat._loaded || !Array.isArray(chat.messages)) return;
			// A turn already over here is never re-opened by a late note.
			if (dispatchedTurnFinished(chat, n.tid)) return;
			var lease = (window.DaimondLease && DaimondLease.record) ? DaimondLease.record(n.tid) : null;
			if (lease && DaimondPeer.settledLease && DaimondPeer.settledLease(lease)) return;
			var add = DaimondPeer.dispatchNoteRows(chat.messages, n, self, now);
			if (!add) return;
			chat.messages = chat.messages.concat(JSON.parse(JSON.stringify(add)));
			_dispatchedIx[String(n.tid)] = chat.id;
			moved = true;
			add.forEach(function (m) {
				noteArrive('tile', { via: 'note', cid: chat.id, tid: String(n.tid), mid: m.mid, made: +m.ts, role: m.role });
			});
			diag('handoff note', 'turn=' + String(n.tid).slice(0, 12) + ' ' + add.length + ' row(s) from ' + String(n.by).slice(0, 8));
			if (ownsChat(chat)) renderHistory(chat.messages);
		} catch (e) { /* one note's fault stays its own */ }
	});
	if (moved) updateExpedite();
}

/// Dispatch a turn to a peer of this account. STRICT ORDER (§4.1, seq 223):
/// POST THE ERRAND FIRST -- it carries the thread the runner needs -- mark the
/// local turn peer-held SECOND, and push the parcel LAST, in the background.
///
/// The order was the other way round, and the reason was real: a peer must never
/// claim an errand whose prompt it cannot read. What made it expensive is that the
/// prompt was on the PARCEL, so reading it meant the whole account. Measured on the
/// owner's phone (2026-09-13, build ea8174ff76f6): send→claim 27.6 s, of which
/// 23.3 s was `flush()` of a 7.86 MB parcel BEFORE the errand was posted, and the
/// runner then spent 6 s re-downloading the same parcel to read a one-line prompt.
///
/// So the prompt -- and the thread around it -- rides the ERRAND (`seedFrom`,
/// peer.js). The safety property is kept and is no longer proportional to the
/// account: the runner reads the conversation off the envelope it claimed, and the
/// parcel (the workspace, the Diamonds, the ledger, everything else a later tool
/// call may want) follows on its own time. Nothing the runner waits on is behind it.
///
/// The push is NOT awaited, and that is the point -- but it is also not forgotten:
/// it is kicked off here and its cost is logged when it lands, so a slow parcel is
/// still visible without anybody waiting for it. Answers `{ ok, why }`.
///
/// `handOffTurn` is the ONE ENTRY every caller uses, AND IT OWNS THE REFUSAL
/// (SEND-UNHANDED, diag-elect b). A refusal made
/// before the mark -- a transport this build lacks, a runner that has not shown it
/// runs the turn's set (`unable`), a thread that cannot be built, a throw -- left
/// nothing behind the prompt, and each caller read it its own way: the send had already
/// cleared the composer, so its turn ended in an error line with no Retry and ran
/// nowhere. So the entry answers it, the same for every caller: a person's pause is
/// said as the local run says it (as before), and every other refusal leaves a durable
/// "not run" row on the turn, whose Retry asks it again through `retryTurn` (one turn
/// id, one lease, following the switch). It is never run here in silence instead
/// (owner §1: "if argonaut is selected, it runs there"). A refusal after the mark has
/// its own placeholder, stamp and recovery, and is left to them.
export async function handOffTurn(chat, turnId, promptText, scopePaths, opts) {
	var st = { marked: false }, r;
	try { r = await dispatchToPeer(chat, turnId, promptText, scopePaths, opts, st); }
	catch (e) { r = { ok: false, why: String((e && e.message) || e) }; }
	if (!r) r = { ok: false, why: 'the hand-off door gave no answer' };
	if (!r.ok && !st.marked) {
		if (!r.nr && r.unable) r.nr = notRunCause('unable', opts && opts.runTo, opts && opts.toName);
		answerUnhanded(chat, turnId, promptText, r);
	}
	return r;
}

/// THE FENCE A DISPATCHED TURN CARRIES (R3c2): the absolute roots the engine gives the Hand
/// for this page, `{ rw, ro, deny, net }`, read from the chat's own app confined exactly as a
/// turn here confines it (`scopeTurnApp`), so a runner holds the turn to the same roots and
/// works none out itself. Null where this page has no hand or the scope did not take; a runner
/// refuses an errand without one rather than guess.
export async function errandFence(chat, turnId) {
	try {
		var bounds = null;
		if (chat.diamondId) {
			bounds = await Files.bounds(chat.diamondId);
			if (!chat.app || _threadScope.get(chat.app) !== threadScopeKey(bounds)) chat.app = null;
		}
		var app = ensureApp(chat, String(turnId || ''));
		await scopeTurnApp(chat, app, bounds);
		if (typeof app.command_fence_json !== 'function') return null;
		var j = await app.command_fence_json();
		return j ? JSON.parse(j) : null;
	} catch (e) {
		diag('dispatch fence', 'chat=' + (chat && chat.id) + ' ' + String((e && e.message) || e));
		return null;
	}
}

// ── The peer runner wiring (dev/PEER_DESIGN.md §4.3, step 5) ─
//
// THIN glue. The ordered, tested logic is DaimondPeer.runErrand (take -> run ->
// push -> report -> release, hard-abort on revoke, ack only after commit); this
// supplies the real deps and registers it on DaimondPeer.onErrand, so an errand
// collected on a Channel::Post wake (takeRow -> peek -> absorb, step 2) reaches
// it. Three pieces are running-app integration points, flagged for live
// verification because the node harness cannot exercise them: the reconstruct's
// pull-to-parcelVersion and by-hash chunk fetch, and the renew timer.

/// The sync-like object the lease CAS binds to (DaimondPeer.syncCas). It reads
/// and compare-and-sets the lease's OWN gateway door (DaimondSync.leaseGet /
/// leaseCommit), NOT the content parcel: a claim no longer rides a whole-parcel
/// push, so it does not contend with content churn and cannot 409-storm. The
/// arbitration is unchanged -- DaimondLease's take-if-vacant merge and the
/// merge-trust re-read decide the winner; this only moves the CAS substrate.
export function peerSyncShim() {
	return {
		read:    async function () {
			try { return await DaimondSync.leaseGet(); }
			catch (e) { return { version: 0, leases: {}, unread: true }; }
		},
		commit:  async function (base, proposed) {
			try { return await DaimondSync.leaseCommit(base, proposed); }
			catch (e) { return { ok: false, version: base | 0, leases: {} }; }
		},
		// Kept for the CAS's synchronous fallback and any direct caller.
		version: function () { try { return DaimondSync.leaseVersion() | 0; } catch (e) { return 0; } },
		leases:  function () { try { return DaimondLease.snapshot() || {}; } catch (e) { return {}; } },
	};
}

// Progress-based catch-up bounds for peerReconstruct. The old design gave the pull a
// FIXED 8s and then threw + released the lease -- which threw the turn into a claim
// loop (the next device claims, throws, releases, ...) on a LARGE account whose
// parcel is still syncing tens of seconds past dispatch. That was the live "peers
// claim the lease but nobody runs" failure (production log, build 221: the parcel
// version climbing 6253→6258 with chunk pulls landing at +96s, long past the fixed
// 8s). So the wait is PROGRESS-based: keep the lease and keep pulling AS LONG AS the
// parcel version is still advancing toward the errand's version (or the chat is
// appearing / becoming resident) -- the stall clock resets on every scrap of
// progress. Give up only when it has been genuinely STALLED for RECONSTRUCT_STALL_MS
// with no progress at all, or after the absolute RECONSTRUCT_ABS_CAP_MS ceiling. A
// give-up throws an `undeliverable` error, which runErrand turns into an UNDELIVERABLE
// report + an ack (so peers stop re-claiming) and the dispatcher drops to a local run
// at once rather than after the ~95s backstop.
var RECONSTRUCT_STALL_MS   = 45000;		// no version/chat progress for this long ⇒ stalled
var RECONSTRUCT_ABS_CAP_MS = 300000;	// absolute ceiling regardless of progress (≪ lease deadline)
// A catch-up with no version to reach pulls on a backoff (r52d QA F4)
var RECONSTRUCT_PULL_MIN_MS = 1000;		// the sync engine's wake-pull floor
var RECONSTRUCT_PULL_MAX_MS = 4000;

/// Create the chat an errand's SEED describes, or graft the seed's missing
/// messages into the copy this device already holds. Answers the chat, or null
/// when the errand carries no seed.
///
/// This is what lets a runner start without the parcel. `DaimondPeer.seedGraft`
/// decides WHAT is missing (by `mid`, so a message this device already has is
/// never doubled); this only writes it. The graft is an APPEND of messages the
/// transcript does not carry, which is the same shape `mergeMessages` applies to
/// a pulled parcel -- so when the parcel does land, the union is a no-op over
/// what is already here and there is no second copy of anything.
///
/// `opts.bare` makes the chat even from an errand with no seed (R568-FU F3): a turn's rounds
/// kept by a run a reload cut short need a chat to fold into, and the seed's words are not
/// what they need.
async function graftSeed(errand, opts) {
	var seed = errand && errand.seed;
	if (!seed || !Array.isArray(seed.msgs) || !seed.msgs.length) {
		if (!(opts && opts.bare) || !(errand && errand.chatId)) return null;
		seed = seed || {};
	}
	var chat = null;
	for (var i = 0; i < pg.chats.length; i++) if (pg.chats[i].id === errand.chatId) { chat = pg.chats[i]; break; }
	if (!chat) {
		// A chat this device has never seen. Built from what the seed says about it,
		// so the turn can run NOW; the parcel's copy merges into it by id when it
		// arrives, title and stamps included.
		//
		// A REPLICA, NOT A WRITE (r53 W-rec; SYNC_CONTRACT §5 rule 4): it keeps the
		// stamps the seed carries, 0 where it carries none, so it outranks no record
		// the dispatcher wrote. Stamped `Date.now()` it did: the runner's copy, which
		// had no name and no worker, beat the phone's real choice on every device.
		// The name is the record's `name` (a seed from before r53 sends `title`).
		chat = {
			id:       String(errand.chatId || ''),
			// A daimon errand that beats its parcel still runs through `steer_crystal`.
			diamondId: String(errand.diamondId || ''),
			name:     String(seed.name || seed.title || ''),
			provider: String(seed.provider || ''),
			model:    String(seed.model || ''),
			workerModel:    String(seed.workerModel || ''),
			workerProvider: String(seed.workerProvider || ''),
			effort:   String(seed.effort || ''),
			messages: [],
			holds:    (window.DaimondPeer && DaimondPeer.scopeHolds) ? DaimondPeer.scopeHolds(errand.scope)
				: (Array.isArray(errand.scope) ? errand.scope.slice() : []),
			createdAt: Date.now(),
			updatedAt: 0,
			metaAt:    0,
		};
		// What the dispatcher's record says the conversation has read (H3): one-way, so a seed
		// can only narrow the chat it builds.
		if (chatTaintOf(seed)) chat.taintedAt = chatTaintOf(seed);
		chat._loaded = true;					// its transcript is what we are about to write
		pg.chats.push(chat);
		// Its holdings arrive whole, so what was pressed on it here narrows to them.
		DaimondMarksHere.chatSettle(chat.id, chat.holds);
		diag('seed chat', 'chat=' + chat.id + ' from the errand (never synced here)');
	}
	if (!chat._loaded) {
		try { await loadChatMessages(chat); } catch (e) { /* the graft below still seeds it */ }
		chat._loaded = true;
	}
	chat.messages = chat.messages || [];
	var add = DaimondPeer.seedGraft(chat, errand);
	for (var j = 0; j < add.length; j++) {
		var gm = {
			role: add[j].role, content: add[j].content,
			mid:  add[j].mid,  ts: add[j].ts || Date.now(),
		};
		// The note a person's message took on the device that sent it, and the mark of one the app
		// made, so this copy is the same record.
		if (add[j].role === 'user' && typeof add[j].pre === 'string' && add[j].pre) gm.pre = add[j].pre;
		if (add[j].role === 'user' && add[j].app === true) gm.app = true;
		// A cut turn's landed partial is the same record here, badge and turn included.
		if (add[j].interrupted) { gm.interrupted = 1; if (add[j].iturn) gm.iturn = String(add[j].iturn); }
		chat.messages.push(gm);
	}
	// A graft is a copy of messages the dispatcher wrote, so it moves no stamp: the
	// count it adds is in the store's change stamp, so it is still written.
	if (add.length) {
		persistChats();
		diag('seed graft', 'chat=' + chat.id + ' +' + add.length + ' message(s) from the errand');
	}
	return chat;
}

/// END A RUN OF `er`'s TURN THAT A RELOAD HERE CUT SHORT, `interrupted` (the runner's
/// `interrupted` dep; rulings §1: it ends, never re-runs). Its rows reached the chat log as it
/// ran, so the end is all it lacks, and it goes through the one writer of that end, the
/// dead-writer detector's (`endInterrupted`, design §2 [F3]). The journal's run then goes.
/// Answers whether the journal held one; `always` ends the turn even when it does not (a
/// re-take of this device's own lease, whose run left no journal here).
async function endInterruptedRun(er, always) {
	var tid = String((er && er.turnId) || '');
	if (!tid || !window.DaimondJournal) return false;
	var rec;
	try { rec = await DaimondJournal.recover(); } catch (e) { return false; }
	var t = null;
	(rec.turns || []).forEach(function (x) { if (x && String(x.turnId) === tid && x.meta && x.meta.ho) t = x; });
	if (!t && !always) return false;
	var cid = String((er && er.chatId) || (t && t.chatId) || '');
	try { await endInterrupted(cid, tid); } catch (e) { /* the detector ends it at the deadline */ }
	if (t) { try { DaimondJournal.clearTurn(tid); } catch (e) { /* gone already */ } }
	diag('handoff run interrupted', 'turn=' + tid.slice(0, 12) + ' run=' + String((t && t.meta.run) || '').slice(0, 12)
		+ ' (not rerun)');
	return !!t;
}

/// Reconstruct the chat and its workspace for an errand. It SEEDS THE THREAD FROM
/// THE ERRAND FIRST, then finds the chat, builds its app and scopes it to the
/// errand's fence -- pulling the parcel only where the seed could not answer.
///
/// The catch-up is load-bearing, and its absence was the live "argonaut showed
/// 'Sent to another device' but never ran it" failure. The post-box wake that
/// routed this errand here (post.js `parkOnce` -> `round`) is a SEPARATE channel
/// from the sync pull, and the dispatcher posts the errand only AFTER it has
/// pushed the prompt parcel (dispatchToPeer). So on a fast dispatch the errand
/// arrives before this device's own poll has pulled that parcel: the chat would
/// be absent (reconstruct throws, the row is already consumed by takeRow, and no
/// peer re-runs it) or stale (runTurn against a transcript missing the prompt and
/// the added files). `parcelVersion` is read AFTER the prompt push, so a local
/// version at or past it holds the prompt, the chat, and the offloaded-file chunk
/// manifests -- the large files themselves hydrate on demand from those manifests
/// at file-read time (chunks.js), so the manifests being present is the gate.
/// Before the claim (runErrand's `ready`): wait up to `THROUGH_WAIT_MS` for the copy, with the
/// errand's seed laid in, to hold the asker's whole history (`askerReadiness`), pulling, then
/// claim regardless. Always `{ ok: true, lacked }`, `lacked` the note for the model saying how
/// many messages it lacks ('' when it is ready). The "conversation differs" refusal is gone (UNBLOCK-11): memory belongs to the
/// chat, so a runner whose copy differs runs on the converged transcript it holds.
// This device's sync version, for threadReadiness: below the errand's parcel version a
// copy is still behind (a deletion may be in flight).
function syncHeld() {
	try { return (window.DaimondSync && DaimondSync.version) ? (DaimondSync.version() | 0) : undefined; }
	catch (e) { return undefined; }
}
// THE MOST A RUNNER WAITS for the message the asker last saw (UNBLOCK-11): then it runs
// with what it holds and tells the model what it lacked. A turn is never refused here.
var THROUGH_WAIT_MS = 10000;
/// Is this copy ready to run the errand's turn? `DaimondPeer.threadReadiness`, the one check
/// (FIRE C2-READY), judged on the asker's whole history: the seed counts unless `copy` asks of
/// the copy alone, as the post-graft checks do (C2 r3b).
function askerReadiness(c, e, own, copy) {
	return DaimondPeer.threadReadiness(c, e, syncHeld(), own, copy ? { copy: true } : null);
}
/// What this device's copy lacks of the asker's view, said for the model, or '' when it is
/// ready (`askerReadiness`).
function lackedNote(c, e, own, copy) {
	if (!e) return '';
	var rd = askerReadiness(c, e, own, copy);
	if (rd.ready) return '';
	if (rd.want < 0) return '[Daimond: this device could not confirm it held the conversation as the asker saw it (the turn came from an older build of Daimond). '
		+ 'It answers from what it holds, which may be missing the most recent exchange; say so if it matters.]\n';
	var when = (e.through && e.through.ts) ? ' (sent ' + new Date(e.through.ts).toISOString() + ')' : '';
	var n = rd.lack + ' earlier message' + (rd.lack === 1 ? '' : 's');
	return '[Daimond: this device had not yet received ' + n + ' of the conversation up to the asker\'s last message'
		+ when + '. It answers from what it holds, which lacks them; say so if it matters.]\n';
}
/// The options a runner's turn runs with: the copy's lack note laid ahead of the turn's own,
/// read at the moment the turn lays its history (C2-NOTE, UNBLOCK-11). The note and the rows
/// come from one reading: a pull that lands the missing rows between `peerReconstruct` and the
/// turn leaves no stale note on a turn that holds them all.
function runnerTurnOpts(c, ropts) {
	var lacked = (c && c.chat && c.errand) ? lackedNote(c.chat, c.errand, c.own, true) : '';
	if (!lacked) return ropts;
	diag('turn LACKING', 'chat=' + c.chat.id + ' through=' + (c.errand.through ? c.errand.through.mid : '(older sender)')
		+ '; running with what is held');
	return Object.assign({}, ropts, { pre: lacked + ((ropts && typeof ropts.pre === 'string') ? ropts.pre : '') });
}
// ONE DEADLINE FOR THE WAIT (C2 r2 F6): `peerReady` sets it before the claim, and
// `peerReconstruct` waits to the same instant rather than starting a second 10 s of its own.
// Keyed by the errand object, which `runErrandOnce` passes to both, so nothing rides on it.
var readyBy = new WeakMap();
/// The instant the wait for what the asker saw ends, for this errand: the one `peerReady`
/// set, or `THROUGH_WAIT_MS` from now where it never ran (a local recovery).
function throughDeadline(errand) {
	var by = (errand && typeof errand === 'object') ? readyBy.get(errand) : undefined;
	if (typeof by === 'number') return by;
	by = Date.now() + THROUGH_WAIT_MS;
	if (errand && typeof errand === 'object') readyBy.set(errand, by);
	return by;
}
/// `p`, or nothing once `by` has passed, whichever comes first: a slow pull does not stretch
/// the bound. The pull itself runs on; its failure is the bound's to answer.
function withinDeadline(p, by) {
	var left = by - Date.now();
	var quiet = Promise.resolve(p).catch(function () { /* offline: the bound ends it */ });
	if (left <= 0) return Promise.resolve();
	return Promise.race([quiet, new Promise(function (res) { setTimeout(res, left); })]);
}
/// Why this device cannot run errand `e`'s models, or '' when it can (D-20261018-09 PR): the
/// rule the run dep throws its 401 by, asked before the claim. A marked set is `sentModelsOf`'s
/// to judge; an unmarked Diamond turn runs the Diamond's own model, judged where its record is
/// resident (one that is not is reconstruct's to hand back).
function errandUnrunnable(e, chat) {
	var marked = null;
	try { marked = sentModelsOf(e && e.model); }
	catch (err) { return (err && err.code === 401) ? String(err.message) : ''; }	// any other: runTurn's
	var did = String((e && e.diamondId) || (chat && chat.diamondId) || '');
	if (marked || !did || !pg.diamonds.some(function (x) { return x.id === did; })) return '';
	return diamondCanRun(did) ? '' : 'the diamond’s model has no usable api key on this device';
}

/// The verdict on errand `e`'s models at the asker's horizon (HT3, design §3.3): `{ verdict:
/// 'can' | 'never' | 'behind', why, line }`. The synced providers `e.model.at` names are judged
/// by `DaimondModels.judgeAt`, pure on `(at, rows held, keyState)`; a half `at` does not name
/// (`credits`, minted per device) on this device's own key, with no wait; and a set that
/// judges `can` is then resolved as the run will (`errandUnrunnable`). An errand with no `at`
/// (an older asker) is judged as before: `can` or `never`, at once.
function modelsAt(e, chat) {
	var M = window.DaimondModels, sent = (e && e.model) || null;
	var at = (sent && sent.at && typeof sent.at === 'object' && M && M.judgeAt) ? sent.at : null;
	if (!at) {
		var why0 = errandUnrunnable(e, chat);
		return { verdict: why0 ? 'never' : 'can', why: why0, line: 'horizon=none' };
	}
	var held = {};
	Object.keys(at).forEach(function (pid) { held[pid] = M.heldAt(pid); });
	var j = M.judgeAt(at, held);
	var line = 'model=' + String(sent.provider || '') + '/' + String(sent.model || '') + ' pid=' + (j.pid || '-')
		+ ' named=' + j.named + ' held=' + (j.held === null ? 'none' : j.held) + ' key=' + (j.key || '-');
	// The halves the horizon does not name: this device's own key decides them, at once.
	var halves = [sent, sent.workers, sent.images].filter(function (h) { return h && h.model && h.provider; });
	for (var i = 0; i < halves.length; i++) {
		var h = halves[i];
		if (Object.prototype.hasOwnProperty.call(at, h.provider) || M.resolve(h.provider, h.model)) continue;
		return { verdict: 'never', why: 'the turn’s model ' + h.provider + '/' + h.model + ' has no usable api key on this device',
			line: line + ' unnamed=' + h.provider + ' key=' + M.keyState(h.provider) };
	}
	if (j.verdict === 'never') return { verdict: 'never', line: line,
		why: 'the turn’s model ' + j.pid + ' has no usable api key on this device (key ' + j.key + ')' };
	if (j.verdict === 'behind') return { verdict: 'behind', line: line,
		why: 'this device had not yet received the turn’s model ' + j.pid + ' as the asker saw it (key ' + j.key + ')' };
	var why = errandUnrunnable(e, chat);
	return { verdict: why ? 'never' : 'can', why: why, line: line };
}

async function peerReady(errand, own, waitMs) {
	var e = errand || {}, t0 = Date.now();
	var by = t0 + (typeof waitMs === 'number' ? waitMs : THROUGH_WAIT_MS);
	if (errand && typeof errand === 'object') readyBy.set(errand, by);
	function find() {
		for (var i = 0; i < pg.chats.length; i++) if (pg.chats[i].id === e.chatId) return pg.chats[i];
		return null;
	}
	// A RUNNER NEVER CLAIMS A TURN WHOSE MODELS IT CANNOT RUN (D2 applied to models), and says
	// "cannot" only at the asker's horizon (HT3): `never` is refused here at once, before any
	// lease, and the asker's hand-back runs it on the device that has the key; `behind` is
	// waited on below, to the same deadline as the thread, pulling, and refused as
	// `models-behind` only when the deadline passes with the horizon unreached.
	var md = errand ? modelsAt(e, find()) : { verdict: 'can' };
	function refused(m) {
		var cause = m.verdict === 'never' ? 'models' : 'models-behind';
		diag(m.verdict === 'never' ? 'ready MODELS' : 'ready MODELS-BEHIND', 'chat=' + e.chatId + ' turn=' + e.turnId
			+ ' ' + (m.line || '') + ' -- ' + m.why);
		return { ok: false, cause: cause, why: m.why };
	}
	if (md.verdict === 'never') return refused(md);
	async function holds() {
		var c = find();
		if (c && c._loaded === false) { try { await withinDeadline(loadChatMessages(c), by); } catch (err) { /* waited for below */ } }
		// Before the claim the errand's seed counts: the graft lays it in, and makes a chat not
		// here yet. The post-graft checks in `peerReconstruct` ask the real copy.
		return askerReadiness(c, e, own, false).ready;
	}
	if (!errand) return { ok: true, lacked: '' };
	var got = await holds(), behind = md.verdict === 'behind', md0 = md;
	if (behind) diag('ready models-wait', 'chat=' + e.chatId + ' turn=' + e.turnId + ' ' + md.line);
	while ((!got || behind) && Date.now() < by) {
		if (window.DaimondSync && DaimondSync.pull) { try { await withinDeadline(DaimondSync.pull(true), by); } catch (err) { /* offline: the bound ends it */ } }
		try { await withinDeadline(onChatsChangedElsewhere(), by); } catch (err) { /* asked again regardless */ }
		if (behind) {
			md = modelsAt(e, find());
			if (md.verdict === 'never') return refused(md);
			behind = md.verdict === 'behind';
		}
		if (!got) got = await holds();
		// A models wait asks again sooner: a key opening lands in milliseconds once it does.
		if ((!got || behind) && Date.now() < by) await new Promise(function (res) {
			setTimeout(res, Math.min(behind ? 250 : 500, Math.max(0, by - Date.now()))); });
	}
	if (behind) {
		md = modelsAt(e, find());
		if (md.verdict !== 'can') return refused(md);
	}
	if (md0.verdict === 'behind') diag('ready models-can', 'chat=' + e.chatId + ' turn=' + e.turnId + ' ' + md.line
		+ ' waited=' + (Date.now() - t0) + 'ms');
	if (got) return { ok: true, lacked: '' };
	var rd = askerReadiness(find(), e, own, false);
	diag('ready LACKING', 'chat=' + e.chatId + ' turn=' + e.turnId + ' have=' + rd.have + ' want=' + rd.want
		+ ' through=' + (e.through ? e.through.mid : '(older sender)') + '; running with what is held');
	return { ok: true, lacked: lackedNote(find(), e, own, false) };
}

async function peerReconstruct(errand, own) {
	var want    = (errand && errand.parcelVersion) | 0;
	var startAt = Date.now();
	var absBy   = startAt + RECONSTRUCT_ABS_CAP_MS;
	diag('reconstruct start', 'chat=' + (errand && errand.chatId) + ' want=v' + want
		+ ' have=v' + (function () { try { return (DaimondSync.version() | 0); } catch (e) { return '?'; } })());
	function haveVer() {
		try { return (window.DaimondSync && DaimondSync.version) ? (DaimondSync.version() | 0) : 0; }
		catch (e) { return 0; }
	}
	function findErrandChat() {
		for (var i = 0; i < pg.chats.length; i++) if (pg.chats[i].id === errand.chatId) return pg.chats[i];
		return null;
	}
	function pause(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

	// THE PROGRESS-BASED CATCH-UP. Keep the lease and keep pulling/materialising as
	// long as ANYTHING is still moving toward having the chat resident: the parcel
	// version advancing toward `want`, the chat appearing in `chats[]`, or it becoming
	// resident. `stallBy` is reset on every scrap of that progress; only a genuine
	// stall (no progress for RECONSTRUCT_STALL_MS) or the absolute cap ends the wait
	// unsatisfied. `have >= want` is the "we hold everything the dispatcher committed"
	// signal, but the chat can arrive before that, so a materialise is attempted every
	// pass rather than gated behind reaching `want`.
	//
	// This replaces a FIXED 8s window that threw + released the lease the moment it
	// expired -- which claim-looped a turn whose (large) parcel was still syncing, the
	// production failure. It also still closes the seq-220 rebuild race below: the pull
	// merges the parcel into the STORE, but `applyChats` fires `onChatsChangedElsewhere`
	// WITHOUT awaiting it (its first act is an async summaries read), so `chats[]` can
	// lag the store; driving that rebuild ourselves each pass finds the chat.
	// THE SEED, FIRST. An errand posted ahead of its parcel (seq 223) carries the
	// thread, so the chat and the prompt are here before any pull -- which is the
	// whole of why the claim no longer waits on a 7.86 MB flush. A seed that supplies
	// the turn ends the catch-up before it starts; one that does not (an older
	// dispatcher's errand, which carries none) leaves the loop below exactly as it
	// was, so a mixed-build fleet hands off in both directions.
	try {
		var seeded = await graftSeed(errand);
		if (seeded) { try { await onChatsChangedElsewhere(); } catch (e) { /* the chat is in `chats` regardless */ } }
	} catch (e) { diag('seed FAILED', 'chat=' + (errand && errand.chatId) + ' ' + (e && e.message || e)); }

	var have    = haveVer();
	var chat    = findErrandChat();
	var stallBy = startAt + RECONSTRUCT_STALL_MS;
	var pulled  = false;
	// WITH NO VERSION TO REACH, PULL ON A BACKOFF (r52d QA F4). An errand whose
	// parcel-first flush was unconfirmed carries want 0 (`7509b8d7`), and this loop
	// pulled the whole parcel every 150 ms for up to 45 s. The sync engine's wake
	// channel pulls on its own the moment the version moves, and `have` follows it;
	// these pulls are the net for a device whose channel is down, from the wake
	// floor up to a few seconds apart, and back to the floor on any movement.
	var pullGap = RECONSTRUCT_PULL_MIN_MS, pullAt = 0;
	// READY: resident and holding the asker's whole history, or more (`askerReadiness`, the copy
	// alone now the graft has run). A resident copy still behind once the one deadline is spent
	// runs anyway, and the model is told how much it lacked (UNBLOCK-11).
	var throughBy = throughDeadline(errand);
	function threadReady(c) {
		if (!c || !c._loaded) return false;
		return askerReadiness(c, errand, own, true).ready || Date.now() > throughBy;
	}
	function chatHeldN(c) { return (c && c._loaded) ? DaimondPeer.threadReadiness(c, errand, syncHeld(), own).have : -1; }
	while (true) {
		chat = findErrandChat();
		// READY means the chat is resident AND HOLDS THIS THREAD -- the same model-facing
		// prefix the dispatcher would feed, by content-free fingerprint (S-HAND #3).
		// Residency, or even "holds the turn's user message", alone let a chat synced to a
		// DIFFERENT point break out of the catch-up and run the model against a stale or
		// truncated conversation. With the errand carrying the thread's sig this is
		// normally true on the first pass (the seed grafted it); where it is not, the
		// loop below pulls exactly as it did.
		if (threadReady(chat)) break;
		// Present but a NON-RESIDENT summary (empty transcript beside a real msgCount,
		// seq 213): make it resident before building the agent, or ensureApp would seed
		// the runner from an empty transcript.
		if (chat && !chat._loaded) {
			try { await loadChatMessages(chat); } catch (e) { /* retry within the window */ }
			if (threadReady(chat)) break;
		}
		var now = Date.now();
		var heldN = chatHeldN(chat);
		if (now > absBy) break;						// absolute ceiling
		if (pulled && now > stallBy) break;			// genuinely stalled (after ≥ one pull)
		// Pull toward `want`. Always at least once (a dispatcher whose version read 0
		// carries want 0 and no target, but the receiver may still be behind and one
		// fresh pull is cheap); thereafter only while still behind.
		var before = have;
		var blind  = want <= 0 && pulled;			// no target: paced, see `pullGap`
		if (window.DaimondSync && DaimondSync.pull && (!pulled || have < want || (blind && now - pullAt >= pullGap))) {
			if (blind) pullGap = Math.min(pullGap * 2, RECONSTRUCT_PULL_MAX_MS);
			pullAt = now;
			try { await DaimondSync.pull(true); } catch (e) { /* offline: the window retries */ }
			pulled = true;
		}
		have = haveVer();							// the wake channel's pulls move it too
		// Drive the in-memory rebuild ourselves (the seq-220 gap above).
		var hadChat = !!chat;
		try { await onChatsChangedElsewhere(); } catch (e) { /* retry within the window */ }
		var appeared = !hadChat && !!findErrandChat();
		// PROGRESS IS PROGRESS TOWARD THIS THREAD (D2). Any parcel movement used to reset
		// the stall clock, so the sender's own unrelated pushes held a turn that could not
		// match for minutes. The version counts only while it is short of the errand's or
		// the chat is still absent; once the chat is here, only its thread growing counts.
		var grew = chatHeldN(findErrandChat()) > heldN;
		var verMoved = have > before && (before < want || !findErrandChat());
		if (verMoved || appeared || grew) {
			stallBy = Date.now() + RECONSTRUCT_STALL_MS;	// progress ⇒ reset
			pullGap = RECONSTRUCT_PULL_MIN_MS;
		}
		await pause(have < want ? 400 : 150);
	}

	chat = findErrandChat();
	if (!chat) {
		// GENUINELY UNDELIVERABLE: the errand's chat never synced here in the window.
		// Marked so runErrand ACKS the errand (peers stop re-claiming) and the
		// dispatcher drops to local at once. Nothing ran, so the release is money-safe.
		diag('reconstruct UNDELIVERABLE', 'chat=' + (errand && errand.chatId) + ' never synced');
		var eAbsent = new Error('the errand names a chat this device could not sync in time');
		eAbsent.undeliverable = true;
		throw eAbsent;
	}
	if (!chat._loaded) {
		try { await loadChatMessages(chat); } catch (e) { /* one last attempt below decides */ }
	}
	if (!chat._loaded) {
		diag('reconstruct UNDELIVERABLE', 'chat=' + (errand && errand.chatId) + ' not resident in time');
		var eResident = new Error('the errand\'s chat could not be made resident in time');
		eResident.undeliverable = true;
		throw eResident;
	}
	// A COPY THAT DIFFERS RUNS ON WHAT IT HOLDS (UNBLOCK-11). It used to hand the turn back
	// that the conversation differed, so a turn was refused, or run on a stale
	// session; memory now belongs to the converged transcript (`daimonPrior`, `seedEngine`),
	// and a copy still short of the asker's last message says so to the model. The note is
	// read when the turn lays its history (`runnerTurnOpts`), not here: the awaits below and
	// in runErrand can land the missing rows first (C2-NOTE).
	// THE SENDER'S REMOVALS, HONOURED (UNBLOCK-1). The errand names the rows the sender
	// removed and has not yet shipped (`gone`); the prefix above was proven without them,
	// so they leave this copy now -- the same removal, recorded as the same tombstone the
	// parcel will bring -- and the model is fed the sender's thread, not a retracted turn.
	honourGone(chat, errand);
	// THE PREFIX IS PROVEN; the turn's own user message may still be absent (the seed
	// was clipped below it, or the parcel delivered the prefix but not the turn). The
	// prompt is on the errand, so complete the thread: write the turn's user message
	// from the envelope, at the mid `runTurn(promptInTranscript)` anchors to. The union
	// with the parcel's own copy is by mid, so a later pull adds nothing and duplicates
	// nothing.
	if (!DaimondPeer.holdsTurn(chat, errand.turnId)) {
		chat.messages = chat.messages || [];
		chat.messages.push({
			role:    'user',
			content: String(errand.prompt == null ? '' : errand.prompt),
			mid:     String(errand.turnId || ''),
			iturn:   String(errand.turnId || ''),
			ts:      Date.now(),
		});
		touchChat(chat); persistChats();
		diag('reconstruct prompt from errand', 'chat=' + chat.id + ' turn=' + errand.turnId
			+ ' (the prefix is proven; the turn message had not landed)');
	}
	// A DAIMON ERRAND NEEDS THE DIAMOND RECORD RESIDENT, not just the chat: the turn
	// runs on `diamondApp(diamondId)` and reads the Diamond from `diamonds[]`, and a
	// Diamond's content is chunk-offloaded, so it can lag the chat that names it. Wait
	// the same bounded way the chat waited above -- pull, rebuild, re-check -- and on
	// failure throw UNDELIVERABLE so runErrand hands the turn back (the backstop re-hands
	// or the phone runs local) rather than the runner steering a Diamond it does not
	// hold. The chat's `diamondId` is the authority; the errand's is the older-build
	// fallback. `rec.session` rides the chat record, so `loadChatMessages` above (which
	// `_loaded` gates) has already made it resident.
	var wantDia = String(chat.diamondId || errand.diamondId || '');
	if (wantDia) {
		var diaBy = Date.now() + RECONSTRUCT_ABS_CAP_MS;
		var haveDia = false;
		while (true) {
			try { await loadDiamonds(); } catch (e) { /* retry within the window */ }
			if (pg.diamonds.find(function (x) { return x.id === wantDia; })) { haveDia = true; break; }
			if (Date.now() > diaBy) break;
			if (window.DaimondSync && DaimondSync.pull) { try { await DaimondSync.pull(true); } catch (e) { /* offline: retry */ } }
			await pause(300);
		}
		if (!haveDia) {
			diag('reconstruct UNDELIVERABLE', 'diamond=' + wantDia + ' not resident');
			var eDia = new Error('the diamond this errand names could not be synced in time');
			eDia.undeliverable = true;
			throw eDia;
		}
		// THIS DEVICE IS ALREADY STEERING THIS DIAMOND. `steer_crystal` borrows the
		// Diamond's session mutably for a whole turn, so a second concurrent turn on the
		// same Diamond cannot run here -- and `runSteer`'s busy-guard would SWALLOW a
		// detached run (a preset returns '' without queueing), leaving the errand to
		// report an empty `done`: a silent hand-off failure. Hand it back UNDELIVERABLE
		// instead, from here (the fast path: report + release + ack), so the dispatcher
		// drops to a local run or the backstop re-hands -- never a blank steer, never a
		// turn reported done with no answer. Thrown before the lease goes busy.
		if (typeof diamondBusy === 'function' && diamondBusy(wantDia)) {
			diag('reconstruct UNDELIVERABLE', 'diamond=' + wantDia + ' busy with a local turn here');
			var eBusy = new Error('this device is already running a turn for this diamond');
			eBusy.undeliverable = true;
			throw eBusy;
		}
	}
	// D3 — rebuild the agent from the freshly-synced transcript (a stale app from
	// before the sync would carry neither the dispatched prompt nor whatever the
	// phone did since), and SEED IT WITHOUT the errand's own user prompt: runTurn
	// re-sends that prompt through `run_turn`, so seeding it too would feed the
	// model the same message twice. `ensureApp`'s `exceptMid` drops exactly the one
	// message whose mid is the turn id; runTurn (promptInTranscript) then does not
	// append a duplicate to the transcript either. A daimon runs on `diamondApp`, not
	// this app, but building it is harmless and keeps the ctx shape uniform.
	chat.app = null;
	// On the asker's daimon (U1e) when it runs here. One that does not was refused before the
	// claim (`peerReady`); a key removed since makes `runTurn` throw its 401 before anything
	// runs, so the engine is built on this device's own meanwhile.
	var sentPair = null;
	try { var ss = sentModelsOf(errand && errand.model); sentPair = ss ? ss.daimon : null; } catch (e) { /* runTurn throws it */ }
	var app = ensureApp(chat, String(errand.turnId || ''), sentPair);
	await scopeChatTo(app, chat.id);
	diag('reconstruct ready', 'chat=' + chat.id + ' turn=' + (errand && errand.turnId)
		+ ' after=' + Math.round((Date.now() - startAt) / 1000) + 's');
	return { chat: chat, app: app, errand: errand, own: own };
}

// How long the runner waits for a handed-off turn's fan-out to settle before it
// reports the errand done. The ABSOLUTE cap sits well below the lease deadline, so a
// wedged fan-out hands back rather than holding the lease to its end; the STALL cap
// ends the wait when nothing is progressing at all (a worker parked for a consent no
// one will grant on a runner), while a live worker or a running round keeps resetting
// it so a genuinely iterating turn is never cut short.
var AGENTIC_SETTLE_ABS_CAP_MS = 10 * 60 * 1000;
var AGENTIC_SETTLE_STALL_MS   = 60 * 1000;

/// Is this chat's agentic fan-out still in flight? True while a worker of its is
/// queued or running, a batch of its is awaiting its last worker, a gather round is
/// pending across the setTimeout gap (`roundPending`), or a turn of it is generating.
/// The runner waits on exactly this going false before it reports the errand done, so
/// a turn that fanned out is never called finished with its workers unresolved.
function chatAgenticActive(chatId) {
	var want = String(chatId || '');
	if (!want) return false;
	if (Workers.roundPending && Workers.roundPending[want]) return true;
	for (var i = 0; i < pg.chats.length; i++) {
		if (pg.chats[i] && pg.chats[i].id === want && pg.chats[i]._generating) return true;
	}
	for (var j = 0; j < Workers.runs.length; j++) {
		var r = Workers.runs[j];
		if (r && String(r.chatId) === want
			&& (r.status === 'queued' || r.status === 'running')) return true;
	}
	var bk = Object.keys(Workers.batches);
	for (var k = 0; k < bk.length; k++) {
		var b = Workers.batches[bk[k]];
		if (b && String(b.chatId) === want) return true;
	}
	return false;
}

/// Is anything actually PROGRESSING this chat's fan-out -- a live worker, a running
/// round, or a round pending -- rather than merely waiting (a batch held open by a
/// worker parked for a consent that will not come)? The stall clock resets on
/// progress and runs on its absence, so a genuinely iterating turn waits as long as
/// it needs while a wedged one is handed back at the stall cap.
function chatAgenticProgressing(chatId) {
	var want = String(chatId || '');
	if (Workers.roundPending && Workers.roundPending[want]) return true;
	for (var i = 0; i < pg.chats.length; i++) {
		if (pg.chats[i] && pg.chats[i].id === want && pg.chats[i]._generating) return true;
	}
	for (var j = 0; j < Workers.runs.length; j++) {
		var r = Workers.runs[j];
		if (r && String(r.chatId) === want
			&& (r.status === 'queued' || r.status === 'running')) return true;
	}
	return false;
}

/// Drive a handed-off agentic turn's fan-out to completion ON THE RUNNER, so the
/// errand reports `done` only after the whole iteration has settled -- not after the
/// fan-out was merely launched. The rounds themselves run through the ordinary
/// gather path (`gather` -> `deliverToChat`), whose on-screen guard now also admits
/// the runner (`chatShowingOrRunning`); this only WAITS on them, reading worker and
/// batch state, so it re-dispatches nothing and cannot double-run. Bounded by an
/// absolute cap and a stall cap, so a fan-out wedged on a consent no one will grant
/// hands the turn back rather than holding the lease open to its deadline.
async function drainAgenticRounds(chat) {
	if (!chat || !chat.id) return;
	var id = chat.id;
	if (!chatAgenticActive(id)) return;			// the common non-dispatching turn returns at once
	var startAt = Date.now();
	var absBy   = startAt + AGENTIC_SETTLE_ABS_CAP_MS;
	var stallBy = startAt + AGENTIC_SETTLE_STALL_MS;
	function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
	while (chatAgenticActive(id)) {
		var now = Date.now();
		if (now > absBy) break;						// absolute ceiling, well under the lease deadline
		if (chatAgenticProgressing(id)) stallBy = now + AGENTIC_SETTLE_STALL_MS;
		else if (now > stallBy) break;				// held open with nothing progressing
		await pause(120);
	}
}

/// Is an errand's turn already SETTLED on THIS device: its TurnView has folded its end
/// (any status), or the lease view says the run finished (`handoffLeaseSettled`)? The ONE
/// predicate three callers share, so they cannot drift:
///  - the runner's D1(b) `finished` guard, so a released lease is never re-taken;
///  - the dispatcher's `holdOwnDispatch` probe (DaimondPeer.onSettled), so a settled
///    OWN errand stops holding its relay row -- the moment `takeRow` re-decides it, the
///    cursor passes it and no peer waking inside the deadline re-runs and re-bills it
///    (S-HAND #1, the money defect);
///  - `dispatchedTurnFinished`, the local-recovery decision.
/// Every end settles it, `interrupted` and `not_run` included: the log's first end wins, so
/// a turn run again is a new turn. A report or an answer row read off the transcript
/// decides nothing (P2.3a4): the log's end is the one decision. The lease view stays for
/// a device that has not read the chat's log, as these are run-or-not decisions, never
/// display. Errand-shaped input `{ turnId, chatId }`; when `chatId` is given only that
/// chat is searched (every caller has it), else every chat.
function dispatchedTurnSettled(er) {
	try {
		var tid = String(er && er.turnId);
		var v = turnLogState(tid, String((er && er.chatId) || ''));
		if (v && v.state === 'ended') return true;
		return handoffLeaseSettled(tid);
	} catch (e) { /* on any doubt, let the lease decide */ }
	return false;
}

/// A turn's TurnView state (`turnView`) in `chatId`, else in the first chat whose log
/// names it; null where none does.
function turnLogState(turnId, chatId) {
	var tid = String(turnId), cid = String(chatId || '');
	for (var ci = 0; ci < pg.chats.length; ci++) {
		var c = pg.chats[ci];
		if (!c || (cid && c.id !== cid)) continue;
		var v = turnView(c, tid);
		if (v) return v;
	}
	return null;
}

/// Does a report answer an errand other than the one its turn's placeholder was last
/// sent as (NANCY, UNBLOCK-42)? A turn id can be sent more than once -- a lost run's
/// retry is named from the turn it replaces (`lostRetryMid`), so every press on every
/// device names one id -- and a report left from an earlier errand of that id must not
/// settle the one in flight and end its watch. Matched on the exact errand id; a report
/// or a placeholder from an older build names none, and decides nothing.
function otherErrandReport(report) {
	var eid = String((report && report.eid) || '');
	if (!eid) return false;
	var tid = String(report.turnId || ''), chat = dispatchedChat(tid);
	var ph = chat ? dispatchedPlaceholderIn(chat, tid) : null;
	return !!(ph && ph.eid && String(ph.eid) !== eid);
}

/// Does the lease this device holds for `turnId` say the turn ran to completion?
function handoffLeaseSettled(turnId) {
	if (!window.DaimondPeer || !DaimondPeer.settledLease || !window.DaimondLease || !DaimondLease.record) return false;
	return DaimondPeer.settledLease(DaimondLease.record(String(turnId)));
}

/// The chat an errand's turn is in, as this device holds it, or null.
function errandChat(er) {
	var cid = String((er && er.chatId) || '');
	for (var i = 0; i < pg.chats.length; i++) if (pg.chats[i] && cid && pg.chats[i].id === cid) return pg.chats[i];
	return dispatchedChat(String((er && er.turnId) || ''));
}

/// The birth stamps THIS device holds for an errand's turn, read off its own copy of
/// the chat: the turn's user message and its dispatched placeholder. A re-hand
/// refreshes the stamps on the errand; it cannot reach these.
function turnBirthsHeld(er) {
	var c = errandChat(er);
	return (c && c.messages) ? DaimondPeer.turnBirthHints(c.messages, String((er && er.turnId) || '')) : [];
}

/// The local half of a runner's dropped run (`endLocal`, UNBLOCK-7 F4) on `chat`, the
/// detached chat the run's turn went out on.
async function endRunnerLocal(chat, e, why) {
	if (!chat) return;
	// THE RUN'S OWN TURN ONLY (check_k K-R1). The door answers a second or more after the
	// abort, and a Continue pressed meanwhile starts the next turn on this chat. A turn is
	// tagged before it goes busy, so a chat whose tag is not the run's has closed the run's
	// turn already: nothing of it is left to kill, and only the relabel below applies.
	var rc = _runnerCtx[String((e && e.turnId) || '')];
	var ours = !!(rc && rc.tag && String(chat._turnTag || '') === rc.tag);
	// THE STOP LABEL FOLLOWS THE VERDICT, NOT THE ABORT (check_f1stop P2): the abort
	// lands before the lease door says whether the sender's Stop crossed the kill.
	// A 'user' end is that Stop (R3 F1), marked as a Stop pressed here marks it: on
	// the turn still closing, and on the stopped row of one that closed already.
	if (why === 'user') {
		if (ours && chat._generating) { chat._aborted = true; chat._stopWhy = 'user'; }
		turnSpan(chat, e && e.turnId).forEach(function (m) {
			if (m && m.role === 'end_log' && m.how === 'stopped' && m.why !== 'user') {
				m.why = 'user';
				if (m.said) m.said = cutAccount('user', turnSpan(chat, e && e.turnId));
				touchMsg(m);
			}
		});
	}
	// Started, not awaited: a hung engine call poisons after its grace, and the run's
	// end has settled and posted long before that reload.
	if (!ours) return;
	endTurnEngine(chat, why);
	for (var w = 0; w < 10 && chat._generating; w++) await new Promise(function (r) { setTimeout(r, 50); });
	if (chat._generating) {
		chat._generating = false; chat._runApp = null; chat._busy = '';
		if (chat.diamondId) { try { setCrystalBusy(chat.diamondId, false); } catch (e2) { /* display */ } }
		try { syncComposer(); } catch (e2) { /* display */ }
	}
}

/// Build the deps `DaimondPeer.runErrand` runs an errand over. Shared by the
/// collector's onErrand handler (a PEER running a dispatched errand) and by the
/// dispatching device's own recovery-on-return (`allowSelf`), so BOTH go through
/// the identical take-if-vacant lease, `finished` guard, renew/abort, push,
/// report, ack and release -- the money-safety is one implementation, not two.
/// `opts.allowSelf` lifts ONLY runErrand's blanket refusal to run this device's
/// own dispatch (D1(a)); every other guard is untouched, so recovery is as
/// single-run-safe as a peer.
function peerRunErrandDeps(opts) {
	var o = opts || {};
	var ctx = null;
	return {
		// A poisoned engine, its page reloading: runErrand stands down unclaimed (UNBLOCK-7).
		poisoned:  function () { return !!_enginePoison; },
		// THE TURN'S AGE (E-R1): what `DaimondPeer.turnAgeVerdict` ages a turn by. The
		// relay's arrival stamp for the row that carried the errand -- none on a
		// recovery, which ages its own turn on this device's clock -- the relay's clock
		// now, and the birth stamps this device holds for the turn itself.
		rowTs:     (o.row && +o.row.ts) || 0,
		// The relay's stamp of the turn's FIRST post (gateway release 5), 0 from an
		// older relay: an age no device's clock can move.
		rowFirst:  (o.row && +o.row.first) || 0,
		relayNow:  function () {
			try { return (window.DaimondPresence && DaimondPresence.relayNow) ? DaimondPresence.relayNow() : null; }
			catch (e) { return null; }
		},
		// THE CLOCK EVERY LEASE AGE AND EXPIRY IS MEASURED ON (SIM-4). Named
		// explicitly here, not left to `DaimondLease`'s own fallback, because this
		// is the deps object the census's money-critical path (`runErrand`'s take,
		// renew, complete, release) reads `now` from: the gateway-corrected clock,
		// never this device's raw one, so a device whose clock has drifted past
		// the 90s TTL from a still-running peer's still reads that peer's lease as
		// live rather than re-running -- and re-billing -- its turn.
		now:       leaseClockNow,
		births:    turnBirthsHeld,
		busyFor:   function (e) { return busyForChat(e && e.chatId); },
		selfId:    selfDeviceId(),
		// This machine's label, for the sentence a HANDED-BACK failure carries home
		// ("The AI provider refused the turn on argonaut"). The originator reads it in
		// the tile, so a bare device id would be no use to them.
		selfName:  deviceLabelFor(selfDeviceId()),
		cas:       DaimondPeer.syncCas(peerSyncShim()),
		allowSelf: !!o.allowSelf,
		// DEFER TO THE NOMINATED RUNNER. runErrand stands down before the lease take
		// if the account has named an always-on runner and it is FRESHLY awake and
		// this device is not it -- so a closable laptop leaves the turn for the
		// desktop. The nominee's freshness is judged against the same tight window a
		// dispatch uses (DISPATCH_FRESH_MS) over the LIVE presence view, so a nominee
		// that actually slept reads offline and this device claims. Skipped on
		// recovery (`allowSelf`), which is the guaranteed net and must never stall.
		nominatedId:   nominatedDeviceId(),
		presence:      (window.DaimondPresence && DaimondPresence.snapshot()) || {},
		freshWindowMs: DaimondPeer.DISPATCH_FRESH_MS,
		// Beat presence while the turn runs (from the lease liveness ticker), so a
		// backgrounded nominee stays fresh through a long turn -- peers are handed the
		// long ones. The non-waking off-parcel presence path, not the lease.
		heartbeat: function () { try { presenceTick(); } catch (e) {} },
		// D1(b). Whether this errand's turn is already FINISHED, so a released
		// lease (which reads vacant) is not re-taken and re-run. Two proofs the
		// turn completed: a done report collected for it, or the answer already
		// merged into the transcript (a non-empty assistant message under the
		// turn's iturn). Either means stand down before the take.
		finished: async function (er) { return dispatchedTurnSettled(er); },
		// A PERSON'S PAUSE, AS THE SENDER HAD IT (R2 QA, F2). The errand carries the
		// sender's pause set at dispatch and nothing here read it, so a runner whose own
		// copy lagged -- the parcel follows the errand -- ran a turn the person had
		// stopped. It is merged as the parcel will merge it, id by id, so this device
		// never answers from an older view than the sender's, and a sender's press
		// on one leaf cannot lift a hold of this device's elsewhere (R3 QA, M-merge);
		// then the question every other door asks is asked here. `{ node, why }`
		// refuses the turn before the take.
		pauseHold: function (er) {
			try { if (er && er.pause && window.DaimondPause) DaimondPause.adopt(er.pause); }
			catch (e) { /* this device's own set still answers */ }
			var held = errandChat(er);
			var node = turnHold({ id: String((er && er.chatId) || ''),
				diamondId: String((er && er.diamondId) || (held && held.diamondId) || '') });
			return node ? { node: node, why: DaimondModels.pauseError(node).message } : null;
		},
		ownTurns:    function (er) { return ownTurns(er); },
		queueBehind: function (er, gone) { return queueBehind(er, gone); },
		ready:       function (er, own) { return peerReady(er, own); },
		reconstruct: async function (er, own) { ctx = await peerReconstruct(er, own); return ctx; },
		// A run of this turn a reload here cut short (r545 F-C2-1): the journal still
		// holds it open (`recoverInterrupted` leaves a handed-off turn to this). Folded
		// into the reconstructed chat as interrupted, its rows named for that run, and
		// the turn ends without running again.
		// The boot recovery (`recoverRunnerTurn`) reconstructs nothing and hands it the
		// chat it holds as `c`.
		// A re-take of this device's own live lease (RUNNER-READY F2) asks BEFORE any
		// reconstruct, with no `c`: the chat is then the one this device holds, found by
		// the journal's own chat id, so the fold needs no engine.
		interrupted: function (er, c, always) { return endInterruptedRun(er, always); },
		// The ordinary turn engine. No heartbeat is created here: the lease no longer
		// renews (it is claimed straight to the errand's deadline), and runErrand owns
		// the READ-ONLY liveness ticker that detects a take-back and caps a hung turn.
		// This dep used to setInterval a renew and clear it in a finally, which both
		// churned the parcel every 30s and leaked the timer whenever `runTurn` never
		// settled -- the permanent 409 push-loop. `onProgress` is still passed so a
		// real journal-event piggyback can check liveness between ticks; chat.app.abort
		// is the hard stop.
		// The GLOBAL park bound and the park signal. `maxParks` is peer.js's MAX_PARKS;
		// `parkRequested` reports whether egressAllowed decided to park THIS turn (no
		// attended device, or the consent wait timed out), so runErrand reports parked
		// / terminal and releases the lease rather than treating the abort as a crash.
		maxParks:      (window.DaimondPeer && DaimondPeer.MAX_PARKS) || 2,
		parkRequested: function (er) { return _runnerParked[String(er.turnId)] || null; },
		runTurn: async function (c, prompt, ropts) {
			// A copy short of the asker's last message runs anyway and says so (UNBLOCK-11): the
			// note leads the turn's own, so the model reads what this device lacked -- counted
			// now, from the rows the turn is about to read (C2-NOTE).
			ropts = runnerTurnOpts(c, ropts);
			// Publish this turn's hard-stop to the runner context, so egressAllowed can
			// abort exactly this turn when it parks. The app exists now (reconstruct ran).
			var tid = String((ropts && ropts.turnId) || '');
			// A DAIMON ERRAND IS NOT A CHAT TURN. The reconstructed chat carries a
			// `diamondId`, so this turn runs the crystal-agent (`steer_crystal`) against
			// the Diamond's own app and fence, NOT the chat engine. `steer_crystal` is
			// fenced per call to the RUNNER's own `Files.bounds(diamondId)` -- the marks
			// sync, the folder is the runner's -- and fails closed to the Diamond's
			// directory on an empty scope, so the authority is correct here.
			var did = String((c && c.chat && c.chat.diamondId) || '');
			if (did) {
				// THIS RUNNER MUST BE ABLE TO RUN THE DIAMOND'S MODEL. `peerReady` refuses a
				// turn it cannot run before the claim (`errandUnrunnable`), and the asker runs
				// it at once. This is the guard for a key removed since then: a runner that
				// lacks it would otherwise `openSettings` and answer nothing. It fails as a
				// provider refusal (runnerErrorKind), so the lease releases unsettled and the
				// asker's tile reads failed with [Run here]; its dispatch backstop runs it there
				// if still open. Nothing was spent. The asker's marked set (C3, U1e) is
				// `sentModelsOf`'s to judge, which throws this same 401 (logged here, as the
				// hand-back it is, by `claimedModelsOf`); an unmarked one runs the Diamond's.
				var marked = claimedModelsOf(ropts && ropts.model);
				if (!marked && typeof diamondCanRun === 'function' && !diamondCanRun(did)) {
					var eKey = new Error('the diamond’s model has no usable api key on this device');
					eKey.code = 401;
					throw eKey;
				}
				var f = pg.diamonds.find(function (x) { return x.id === did; });
				if (!f) {
					// The Diamond record never became resident (a chunk-offload the parcel
					// did not deliver). Hand the turn back undeliverable rather than steer a
					// blank -- the backstop re-hands or the phone runs local.
					var eDia = new Error('the diamond this errand names is not resident');
					eDia.undeliverable = true;
					throw eDia;
				}
				// The hard-stop reaches the DIAMOND'S app (a daimon runs on `diamondApp`,
				// not `chat.app`), so a take-back or a park actually stops the turn.
				if (tid && _runnerCtx[tid]) {
					_runnerCtx[tid].chat = (c && c.chat) || null;
					_runnerCtx[tid].abort = function () {
						try { if (c && c.chat) Workers.cancelAwaits(c.chat.id); } catch (e) { /* best effort */ }
						// THIS turn, by its tag: the Diamond's app is shared (`abortTurn`).
						if (c && c.chat) abortTurn(c.chat);
					};
				}
				// The crystal-agent turn, streamed to the dispatcher through the same
				// progress door a chat uses (pushProgress reads this daimon record by the
				// turn's mid). `ropts.onProgress` is the lease-liveness piggyback.
				await runSteerDetached(f, prompt, c.chat, ropts);
				runnerDeaf(tid, true);		// the turn is over: nothing said now reaches it
				// A daimon that fanned out settles here too, so `done` is posted after the
				// real end of the turn -- `drainAgenticRounds` reads worker/batch state
				// and re-dispatches nothing, so it cannot double-run.
				await drainAgenticRounds(c.chat);
				dropOwnPlaceholderIfAnswered(tid);	// a local recovery's answer is in
				return;
			}
			if (tid && _runnerCtx[tid]) {
				_runnerCtx[tid].chat = (c && c.chat) || null;
				_runnerCtx[tid].abort = function () {
					try { if (c && c.chat) Workers.cancelAwaits(c.chat.id); } catch (e) { /* best effort */ }
					if (c && c.chat) abortTurn(c.chat);
				};
			}
			// THE ASKER'S SET (U1e): the turn runs the models the asker resolved and showed. A set
			// this device cannot run was refused before the claim (`peerReady`); a key removed since
			// throws the 401 here, before anything runs. An unmarked pair (an older asker's) is null,
			// and the turn resolves on this device as it always did.
			var sentSet = claimedModelsOf(ropts && ropts.model);
			// D3 — the prompt is already in the reconstructed transcript, so tell
			// runTurn to run against it rather than append a second copy.
			// The errand's own note (sealed with it) is written as given: the runner's copy of the person's
			// message, if it has to push one, is the person's and carries it.
			await runTurn(c.chat, prompt, { promptInTranscript: !!(ropts && ropts.promptInTranscript), turnId: ropts && ropts.turnId,
				told: (ropts && typeof ropts.pre === 'string') ? ropts.pre : undefined,
				effort: ropts && ropts.effort, models: sentSet });
			runnerDeaf(tid, true);		// the turn is over: nothing said now reaches it
			// The turn has ended, but if it fanned out workers the answer is not in
			// yet: the gather round that reads their reports runs a macrotask later,
			// and on a runner it runs at all only because `chatShowingOrRunning` now
			// admits it. Wait for the whole fan-out to settle here, INSIDE the errand
			// turn runErrand awaits -- so `done` is posted after the real end of the
			// turn, not after the fan-out was merely launched, and the workers' output
			// is synced back in `pushResult` rather than stranded in the runner's
			// local transcript. A turn that fanned out nothing returns from here at once.
			await drainAgenticRounds(c.chat);
			// Every row the run wrote carries its name before anything leaves this device.
			if (tid && stampTurnRun(c.chat, tid)) { touchChat(c.chat); try { persistChats(); } catch (e) { /* the parcel push persists */ } }
			dropOwnPlaceholderIfAnswered(tid);		// a local recovery's answer is in
		},
		// THE LOCAL RUN DROPPED (UNBLOCK-7 F4): the run's engine await is killed, so the
		// turn's own catch closes it -- the interrupted row, `_generating` and the crystal's
		// busy flag down. A turn stuck on an await that is not raced is forced down after.
		endLocal: function (e, why) { return endRunnerLocal(ctx && ctx.chat, e, why); },
		// Words the sender said into this run over its lease (UNBLOCK-27 R7): true once the turn
		// running here has them, false while nothing runs to hear them.
		// 'late' where the turn can hear nothing more, its last round writing the answer
		// (`runnerDeaf`): the runner answers the sender at once and never takes them (R7c).
		interject: function (said) {
			var c = ctx && ctx.chat;
			if (!c || !said || !said.text) return false;
			var rcx = said.turn ? _runnerCtx[String(said.turn)] : null;
			if (rcx && rcx.deaf) return 'late';
			if (!c.diamondId && !c._generating) return false;
			return interjectMessage(c, String(said.text), undefined, { id: said.id, pre: said.pre });
		},
		// Whether those words reached the model: landed in the thread under the id they were said as.
		landed: function (id) {
			var c = ctx && ctx.chat;
			return !!c && (c.messages || []).some(function (m) { return m && m.mid === String(id); });
		},
		abort: function (why) {
			try { if (ctx && ctx.chat) Workers.cancelAwaits(ctx.chat.id); } catch (e) { /* best effort */ }
			// The reason first, so the engine's `ended` event finds it when the stop lands. A
			// 'user' stop is the sender's Stop already read; one read later is labelled by `endLocal`.
			if (ctx && ctx.chat) {
				if (why === 'user') ctx.chat._aborted = true;
				ctx.chat._stopWhy = String(why || '');
				abortTurn(ctx.chat);
			}
		},
		pushResult: async function () {
			// A DAIMON'S session is written by `runSteer` itself, straight from
			// `steer_crystal`'s return (its turn runs on the Diamond's app, not `ctx.app`).
			// Capturing `ctx.app`'s session here would overwrite the real one with the
			// chat app's empty conversation, so the daimon is skipped -- its `rec.session`
			// is already on the record and rides the parcel push below.
			try { if (ctx && ctx.chat && !ctx.chat.diamondId) captureSession(ctx.chat, ctx.app); }
			catch (e) { /* best effort */ }
			// CONFIRM the final answer committed, resilient to a streaming progress push
			// still settling. A progress push holds the one-round gate for a moment; a
			// bare push() arriving in that window would see `inFlight`, defer to the
			// debounce and return a version that PREDATES the final answer -- so the
			// report would carry a version the peer pulls to find the answer not yet
			// there. flush() loops past a transient gate (FLUSH_RETRY_MS x rounds) and
			// answers the version that genuinely contains the parcel, which is exactly
			// what the report needs. A flush that could not confirm (over a live turn,
			// too large) answers 0, no version: the mailbox's version then predates the
			// answer, and its rounds already pushed, the work owed to the retry ladder.
			// The receiver's own progress-based catch-up is the further net.
			try {
				if (DaimondSync.flush) {
					var fl = await DaimondSync.flush();
					return (fl && fl.ok) ? (fl.version | 0) : 0;
				}
				await DaimondSync.push();
			} catch (e) { /* the report still nudges */ }
			return 0;
		},
		post: async function (report) {
			try { var body = await DaimondPeer.sealForSelf(report); await DaimondPost.post(body); }
			catch (e) { /* the answer is already in the parcel */ }
		},
		// FREE THE SENDER'S OWN HOLD FIRST, then ack (S-HAND #1). `settle(turnId)` drops
		// this device's hold on its OWN errand's relay row the moment the turn is settled
		// here, so the following ack takes the row off the shared relay and no peer waking
		// inside the deadline re-runs and re-bills it. On a PEER it drops the hold the
		// collector keeps on the errand's row while the turn runs (post.js `takeRow`), so
		// the row leaves the relay now and not before. On the dispatcher's own local
		// recovery it is the whole fix. `ackThrough` still proves the durable local commit
		// before it tells the relay (WS-BRICK), so this only moves the local watermark
		// ahead of the network ack -- the order the plan's box-fill analysis requires.
		// Both calls take the mailbox lock, so this dep must never run under it: the
		// collector starts a turn only after letting go (E-R4, post.js `startWork`).
		ack: async function (er) {
			delete _turnRun[String((er && er.turnId) || '')];		// the run is over
			try {
				if (DaimondPost.settle) await DaimondPost.settle(er && er.turnId);
				await DaimondPost.ack();
			} catch (e) { /* re-collect is idempotent */ }
		},
	};
}

// One pending fallback re-collect after a stand-down, so many held errands do not
// pile timers. Cleared when it fires; the re-collect it triggers re-schedules if
// this device still stands down.
var _nomineeFallbackTimer = null, _nomineeFallbackAt = 0;
var UNDECIDED_RECOLLECT_MS = 30000;	// the re-look after a take that could not read the lease door

/// After an undecided stand-down (`DaimondPeer.standDownUndecided`), re-collect once.
/// For the nominated runner the wait is its freshness window, so a nominee that slept
/// without running the turn does not leave this awake device idle; for a take that could
/// not read the lease door it is `fastMs`, since nobody has the turn and the door is
/// likely back. A sooner request replaces a later timer, never the reverse. Idempotent: a
/// re-collect that finds the turn run (nominee collected it, or the lease is taken)
/// simply stands down or is a no-op.
function scheduleStandDownRecollect(fastMs) {
	var wait = (fastMs != null) ? fastMs
		: ((window.DaimondPeer && DaimondPeer.DISPATCH_FRESH_MS) || 90000) + 5000;
	var at = Date.now() + wait;
	if (_nomineeFallbackTimer) {
		if (at >= _nomineeFallbackAt) return;
		clearTimeout(_nomineeFallbackTimer);
	}
	_nomineeFallbackAt = at;
	_nomineeFallbackTimer = setTimeout(async function () {
		_nomineeFallbackTimer = null;			// null FIRST, so a route's re-arm can take the slot
		// AWAITED, and RE-ARMED on failure. On a genuine route the re-collected errand
		// stands down again and reschedules THROUGH onErrand; because the handle was
		// nulled first that arm takes the one live slot, so on SUCCESS this must not arm
		// a second timer -- and it does not. But a TRANSIENT failure (an offline blip:
		// collect returns !ok, or rejects) routes nothing and so re-arms nothing, which
		// would DROP the only prompt re-collect driver until an unrelated later collect
		// or the dispatcher's recovery-on-return. So re-arm here on failure. The guard
		// at the top makes any overlap a no-op, so the onErrand re-arm and this failure
		// re-arm can never both leave a timer live (no double-arm).
		var res = null;
		try { if (window.DaimondPost && DaimondPost.collect) res = await DaimondPost.collect(); }
		catch (e) { res = null; }
		if (!res || !res.ok) scheduleStandDownRecollect(fastMs);
	}, wait);
}

/// Register the runner. Idempotent (DaimondPeer.onErrand just sets the handler),
/// so it is safe to call on every unlock.
function registerPeerRunner() {
	if (!window.DaimondPeer || !DaimondPeer.onErrand || !DaimondPeer.runErrand) return false;
	// THE COMPILE HAND-OFF GOES ON THE SAME DOOR. Registered here rather than in its
	// own wiring so there is one moment at which this device becomes able to take
	// work from a peer, whatever kind of work it is.
	try { if (Files && Files.wireCompileHandoff) Files.wireCompileHandoff(); }
	catch (e) { /* the turn half still registers */ }
	// S-HAND #1. Teach post.js `takeRow` when to STOP holding this device's own errand:
	// once the turn is settled here (a peer answered it, or this device recovered it
	// locally), `holdOwnDispatch` reads this and answers false, so the cursor passes the
	// row and the relay drops it -- no peer waking inside the deadline re-runs and re-bills.
	try { if (DaimondPeer.onSettled) DaimondPeer.onSettled(dispatchedTurnSettled); }
	catch (e) { /* an older peer.js holds on the deadline alone */ }
	try { if (DaimondPeer.onBusyProbe) DaimondPeer.onBusyProbe(busyForChat); }
	catch (e) { /* an older peer.js: a busy runner reaches the errand when it is free */ }
	try { if (DaimondPeer.onChatWorkProbe) DaimondPeer.onChatWorkProbe(chatHasWork); }
	catch (e) { /* an older peer.js: a second turn of a chat waits on the work chain */ }
	// The lease `holder` this peer writes: the PER-DEVICE id, so its claim is
	// distinguishable from a paired twin's (a key-derived id would collide and let
	// both run the turn). Read at each errand, not captured here, so a device that
	// mints its id lazily still holds the right one.
	DaimondPeer.onErrand(async function (errand, row) {
		// D1(a/c). The AUTOMATIC collect path NEVER runs this device's OWN dispatch.
		// On its return from the background the phone re-collects its own self-posted
		// errand (peerCollectOnReturn); routed here and run it would re-take the
		// peer's released lease and re-run the finished turn -- a second completion
		// and a second charge. Skip it: the collector lets the row go once this
		// returns (post.js `runWork`), and the peer that RAN it acked the
		// relay row on commit, so nothing re-collects it. Deliberately NOT acked here
		// -- a phone still awake that collects before the peer has picked the errand
		// up must not yank it from the relay. Deliberate LOCAL RECOVERY of an orphan
		// is a SEPARATE path (recoverDispatchedTurns) that passes `allowSelf` and has
		// already confirmed the turn is unrun and unclaimed; it never comes through
		// here. runErrand carries the same guard, so this is belt-and-braces.
		if (errand && String(errand.dispatchedBy) && String(errand.dispatchedBy) === String(selfDeviceId())) {
			return { ran: false, why: 'self-dispatched' };
		}
		// MONEY-CRITICAL: the nominee stand-down inside runErrand decides against
		// this device's LOCAL presence snapshot. A backgrounded/throttled tab woken
		// by the errand's own wake never refreshes that snapshot on the collect path,
		// so a still-awake nominee reads as stale and this device grabs the turn.
		// Refresh presence from the gateway (the source of truth) FIRST, awaited, so
		// the snapshot peerRunErrandDeps() reads below is current. BOUNDED: gwFetch has
		// no AbortController, so a truly hung connection would otherwise block the errand
		// until the browser's own multi-minute fetch timeout. Race a 4s cap; on timeout
		// or any failure, proceed on the local snapshot, which fails toward LIVENESS (a
		// stale/absent nominee reads offline, so this device CLAIMS rather than stranding
		// the turn). The lease still guarantees a single runner. The cap is the send's
		// (PRESENCE_READ_CAP_MS, 2 s, HT2 M1), down from 4 s.
		try {
			if (window.DaimondSync && DaimondSync.refreshPresence) {
				await Promise.race([
					DaimondSync.refreshPresence(),
					new Promise(function (r) { setTimeout(r, PRESENCE_READ_CAP_MS); }),
				]);
			}
		} catch (e) { /* the local snapshot stands */ }
		// THIS DEVICE'S OWN COPY OF THE CHAT, resident before the turn is aged: its user
		// message and its placeholder are birth stamps a re-hand cannot refresh
		// (`turnBirthsHeld`). A summary synced without its transcript is read in here,
		// as the reconstruct would read it anyway; the errand's own stamps age it if not.
		try {
			var held = errandChat(errand);
			if (held && !held._loaded) await loadChatMessages(held);
		} catch (e) { /* the errand's own id and seed still age the turn */ }
		// Register this turn as ACTIVE for the run, so a live consent inside it can
		// name it, seal the ask home and (on a park) abort exactly this turn. Cleared
		// on every exit -- runErrand has already consumed the park flag by then.
		// A BUSY ANSWER IS NOT A RUN (H1): it is decided before anything starts, and it
		// must not register as this device's active turn beside the one it is running.
		var busyNow = !!(DaimondPeer.decideNow && DaimondPeer.decideNow(errand));
		// BEAT AS THE TURN BEGINS AND ENDS (BUSY-SELF F1). The beat names the chats this
		// device is busy with, and a sender that has not synced this turn reads its lease
		// as another chat's (`presenceWithLeaseBusy`), so until the beat names the chat it
		// passed this device over for the chat's next turn and ran it itself.
		if (!busyNow) {
			runnerCtxBegin(errand);
			try { presenceTick(); } catch (e) { /* best-effort: the next beat names it */ }
		}
		var res;
		try { res = await DaimondPeer.runErrand(errand, peerRunErrandDeps({ row: row })); }
		finally { if (!busyNow) runnerCtxEnd(errand && errand.turnId); }
		// A just-run turn is the strongest proof this device is awake, but running an
		// errand emits no presence beat, so a backgrounded nominee's throttled ~45s beat
		// can drift past the 90s window between consecutive turns, and the next turn's
		// stand-down then reads it offline and a fallback grabs the turn. Beat the instant
		// a turn ends, so back-to-back turns in a chat stay with this device -- and the
		// chat leaves the beat's busy list with it.
		if (!busyNow) { try { presenceTick(); } catch (e) { /* best-effort liveness */ } }
		// STOOD DOWN for the nominated runner (or UNDECIDED: the take could not read the
		// lease door, or won no try at it): the errand is HELD on the relay
		// (takeRow), not acked, so it survives for the nominee. But the 45s presence
		// beat does not re-collect, so nothing here would retry until an unrelated
		// wake -- and a nominee that slept just after its last beat would leave this
		// awake fallback idle. Schedule ONE re-collect past the nominee's freshness
		// window: by then a slept nominee reads offline and this device claims;
		// a nominee that kept beating (still fresh) stands this down again and
		// reschedules. Bounds the fallback stall to about one freshness window
		// rather than the dispatcher's much longer deadline.
		if (res && DaimondPeer.standDownUndecided(res.why)) {
			scheduleStandDownRecollect(res.why === 'nominee' || res.why === 'addressee' ? undefined : UNDECIDED_RECOLLECT_MS);
		}
		return res;
	});
	// The DISPATCHING side: a report is the nudge that a dispatched turn is settled.
	// Stash it by turnId for the UI state machine. The placeholder is NOT dropped on
	// a bare `done` report (owner standing rule 2026-09-18): the report is only a
	// nudge, and dropping the placeholder before the real answer was in the transcript
	// is what forced the rebuild that lost the streamed tile. The drop happens when
	// the durable answer actually merges -- the sync-path reconcile in
	// `onChatsChangedElsewhere`, guarded by `dispatchedAnswerPresent`. Until then the
	// streamed provisional tiles carry the answer and the chrome keeps its spinner.
	//
	// HIS WORDS ARE FILED BEFORE THE SESSION LANDS (U2): a report carrying words its run's folds
	// staged waits for them to be in this tab's words log, so a session is never stored ahead of
	// the words it folded away. A report with none settles at once, as it always has.
	DaimondPeer.onReport(async function (report) {
		try {
			var tid = String(report.turnId);
			// A REPORT ON ANOTHER ERRAND of this turn id is not this hand-off's, and settles nothing.
			if (otherErrandReport(report)) {
				diag('handoff report ignored', 'turn=' + tid + ' eid=' + String(report.eid).slice(0, 12)
					+ ' ' + String(report.status) + ': not the errand the turn was sent as');
				return;
			}
			// A REPORT BELOW THE PAGE'S MIN (OWNKEY H3, lead ruling 25 Oct): made by an engine
			// whose shapes this page no longer reads, so nothing of it is applied -- not its
			// rows, its session, its cost. The turn goes down the hand-back path with cause
			// `abi` and ends as the visible "not run" row with Retry (rulings §1 l.17); any
			// partial the progress door streamed for it is taken down (`dropRefusedTiles`),
			// never left standing as if it were the answer.
			var snap0 = (window.DaimondPresence && DaimondPresence.snapshot()) || {};
			if (DaimondPeer.reportAbiOk && !DaimondPeer.reportAbiOk(report, snap0)) {
				diag('handoff report refused', 'turn=' + tid + ' abi=' + String(report.abi || 0) + ' below the page\'s min');
				refuseAbiTurn(tid, report.chatId, report);
				return;
			}
			// A PASSPHRASE CHANGE strands his keys on the runner (M2): its own-key sources are
			// not offered until it is approved again, on any device (`rekeyApproved`).
			var rk = DaimondPeer.rekeyFrom ? DaimondPeer.rekeyFrom(report) : '';
			if (rk) {
				DaimondPeer.noteRekey(rk);
				try { renderSeatSwitch(); } catch (e) { /* the next beat redraws */ }
				// Read the list now, so a mark set before any was read takes its generation
				// from the gateway's clock at once (QA-OWNKEY-B F2).
				runnerPairPoll().catch(function () { /* the next poll names it */ });
			}
			peerReports[tid] = report;
			takeReportTaint(report);
			var filed = report.words ? await settleRunnerWords(report) : true;
			settleRunnerSession(report, filed);
			await settleRunnerAlerts(report);
			await settleRunnerAsk(report);
			// THE TURN'S ROWS COME HOME WITH IT (RUN-HIST): a settling report that names the
			// files the turn made or changed on the runner is recorded as a version of its
			// keeper, so History shows the turn here and, through the parcel, everywhere.
			if (report.turnRec && DaimondPeer.settlingReport(report)) recordCarriedTurn(report.turnRec, report);
			// Its own-key spend, booked to each source's pool (OWNKEY §5.4).
			if (DaimondPeer.settlingReport(report)) bookReportCost(report);
			requeueUnheard(report);
			// A hand-off that ended without its answer (failed, cut short, refused) sends what queued
			// behind it now; a `done` one sends it when its answer lands (`dropDispatchedPlaceholder`).
			if (report.status !== 'done' && DaimondPeer.settlingReport(report)) {
				var _behind = chatHoldingTurn(tid);
				if (_behind && (_behind._queue || []).length) setTimeout(function () { drainAfterHeld(_behind); }, 0);
			}
			// A parked / terminal report settles the live question, so retire the
			// dispatcher's "awaiting" marker; the footer then reads the report state.
			// A parked, terminal or HANDED-BACK report settles the live question, so
			// retire the dispatcher's "awaiting" marker; the footer then reads the report
			// state ('failed' -> [Run here]). `error` joined this list with the 2026-09-12
			// hand-backs: a runner that restarted, or whose provider refused it, reports
			// `error` and the question it was holding is gone with it.
			if (report.status === 'parked' || report.status === 'aborted'
				|| report.status === 'error') delete _openAsk[tid];
			// UNDELIVERABLE — a peer could not sync the chat's parcel and handed the turn
			// back (having acked the errand off the relay so no peer re-claims it). Drop
			// to a LOCAL run on THIS device AT ONCE, rather than wait out the ~95s
			// dispatch backstop, through the SAME money-safe take-if-vacant lease the
			// backstop uses. runDispatchFallback re-reads server truth first and stands
			// down under a live foreign lease, so a peer that IS genuinely on it still
			// wins. Every device holds the placeholder -- it syncs in the transcript --
			// so it is `recoverDecision` that makes this a no-op elsewhere: it runs only
			// the dispatching device's own hand-off, inside its deadline. _localRecovering
			// dedupes it against the backstop timer.
			//
			// THE REPORT OUTRUNS THE RELEASE (slowparcel CASE 3). The runner reports, then
			// releases its lease, then acks, so this device can read the lease door between
			// the report and the release, see the runner's claim still live, and stand
			// down. It used to cancel the backstop first, so nothing ever ran the turn.
			// The hand-back is now held until the lease view moves off the runner
			// (`redriveHandBacks`, on every lease change), and the backstop stays armed
			// as the last net; the placeholder's drop clears it.
			//
			// AND THE SENDER RELEASES THE CLAIM ITSELF (hand-off QA F7). A runner that died
			// between its report and its release held the turn to the errand's deadline,
			// fifteen minutes, with [Run here] silent under its live claim. The report is
			// the runner's word that nothing ran, so the claim it names is vacated here
			// (`DaimondLease.reclaim`: that holder, that errand, never started) before the
			// decision. An older runner names no claim, and its release re-drives the hold.
			//
			// A BUSY RUNNER HANDS BACK THE SAME WAY (H1; r544, QA F-A1): an `undeliverable`
			// carrying `busy`, or r543's own `busy` status, which `handBackReport` reads as
			// one. r543 kept `busy` apart and counted it as settled, so nothing ran the turn.
			if (DaimondPeer.handBackReport(report)) {
				delete _openAsk[tid];
				noteHandBack(report);
				if (report.cause) _handBackCause[tid] = String(report.cause);
				_handBack[tid] = String(report.chatId || '');
				reclaimHandBack(report).then(function () {
					if (_handBack[tid] == null) return;		// decided meanwhile
					try { runDispatchFallback(_handBack[tid], tid); } catch (e) { /* the lease re-drive and the backstop remain */ }
				});
			}
			// Carry the GLOBAL park count onto the synced placeholder, so a re-run
			// from ANY device bumps from the true total rather than a device-local
			// zero. A parked (survivable) turn can re-run; a terminal one cannot.
			if (report.status === 'parked') markPlaceholderParked(tid, report.parkCount | 0);
			// A settling report ends the watch now; the turn's rows and end come from its log.
			try { updateExpedite(); } catch (e) { /* the next reindex re-decides it */ }
			renderDispatchedBadges();
		} catch (e) { /* a report is only a nudge */ }
	});
	// Remote consent: an attended device raises a runner's BROADCAST question and
	// seals the answer home. A grant does two things on EVERY device that collects
	// it, so onGrant runs both handlers: `deliverGrant` resolves the runner awaiting
	// its cid (first-committed-wins, exactly once); `adoptRemoteGrant` dismisses any
	// tile this device raised for that cid and records the cid resolved (so a device
	// back online does not re-raise an answered ask). Idempotent on both sides.
	try {
		if (DaimondPeer.onAsk)   DaimondPeer.onAsk(raiseConsentFromPeer);
		if (DaimondPeer.onGrant) DaimondPeer.onGrant(function (grant) {
			deliverGrant(grant);
			adoptRemoteGrant(grant);
			noticePermit(grant);
		});
		// A runner's account of a turn it undid (RUN-HIST), and the asks still waiting on one.
		if (DaimondPeer.onUndone) DaimondPeer.onUndone(undoneFromRunner);
		// An ask the relay let lapse goes again when its runner is seen back.
		window.addEventListener('daimond:presence', function () {
			if (!window.DaimondVersions || !DaimondVersions.undoTurnAgain) return;
			DaimondVersions.undoTurnAgain(undoTurnDeps(), undoTurnProbe().online)
				.catch(function () { /* the next presence change asks again */ });
		});
	} catch (e) { /* remote consent unavailable: a runner falls back to a park */ }
	// D4 — a lease learned through a SYNC pull (the phone watching the peer claim,
	// then run, its turn) moves the local lease view but touches no message record,
	// so the dispatched footer would sit on "Sent to your other devices" and never
	// advance to "running" or show "[Take back]". Re-render the badges whenever the
	// lease view moves, so a sync update advances the footer the way a report does.
	// (C) — and STAMP the actual claimant onto the placeholder first, so the
	// originator's tile converges to the device that really runs the turn even when
	// its initial target guess differed, and stays correct after the lease releases.
	try { if (DaimondLease && DaimondLease.onChange) DaimondLease.onChange(function () {
		try { stampDispatchHolders(); } catch (e) { /* the re-render still advances the footer */ }
		// A runner's receipt for words its turn could no longer hear: sent as the next turn now.
		try { heedUnheard(); } catch (e) { /* the turn's report still sends them */ }
		renderDispatchedBadges();
		// A claim starts a watch and a release ends one. See `refreshHandoffWatch`.
		updateExpedite();
		// A handed-back turn waits for its runner's release to show here.
		redriveHandBacks();
		// A claim makes the runner busy and a release frees it: the switch follows.
		try { renderSeatSwitch(); } catch (e) { /* the next beat redraws it */ }
		// A lease that moved may have ended the hold a queue waits behind (QA ccp2 M1).
		try { drainHeldQueues(); } catch (e) { /* the hold's wake asks again */ }
	}); }
	catch (e) { /* no lease module: the footer still advances on a report */ }
	// The hand-off memory a reload lost, once the first pull has read the lease door.
	try {
		if (window.DaimondSync && DaimondSync.pulled && DaimondSync.pulled()) setTimeout(rearmDispatchedAtBoot, 0);
		else window.addEventListener('daimond:pulled', function () { rearmDispatchedAtBoot(); }, { once: true });
	} catch (e) { /* the backstop of a later send and the deadline remain */ }
	return true;
}
// page-split: install 28

// ── The dispatching side: state, controls, return collect ──

/// Reports collected for dispatched turns, by turnId, for the UI state machine.
export var peerReports = {};


// ── The dispatched-placeholder index ───────────────────────
//
// A CACHE over `chats`: iturn -> chatId for every `why:'dispatched'` placeholder.
// The three peer-recovery scans below (`peerCollectOnReturn`, which runs on every
// tab-foreground, and the park/drop pair) each walked EVERY chat × EVERY message.
// This makes the lookup proportional to the number of dispatched turns instead. It
// is ONLY a cache -- rebuilt wholesale from `chats` by `rebuildDispatchedIndex`
// whenever the array is reloaded or merged, and kept in step between rebuilds by
// `markTurnDispatched` (append) and `dropDispatchedPlaceholder` (drop). Every
// consumer resolves the id against the LIVE `chats` array and re-checks the
// placeholder is really there, so a stale entry costs a wasted lookup and never a
// wrong action.
//
// The interrupted-reason a dispatched placeholder carries -- the literal
// `DaimondPeer.REASON_DISPATCHED`, held here so the index can be built before the
// peer module has loaded and matched against `markPlaceholderParked`, which uses
// the same literal.
var REASON_DISPATCHED_STR = 'dispatched';
export var _dispatchedIx = Object.create(null);

/// Rebuild the dispatched-placeholder index. Since seq 213 it reads the SUMMARIES,
/// not the transcripts: each summary carries the `iturns` of its dispatched turns
/// (blocker B3), so the index is built without a transcript resident -- which is the
/// whole point of the lazy read path. `ensureDispatchedResident` then loads the few
/// chats this names, so the mutators that DO touch the placeholder find it in memory.
/// Falls back to scanning any resident transcript, so a chat made this session (not
/// yet summarised on disk, but resident) is still indexed.
export function rebuildDispatchedIndex() {
	var ix = Object.create(null);
	try {
		ChatStore.stored().forEach(function (s) {
			if (s && s.id && Array.isArray(s.iturns)) {
				s.iturns.forEach(function (it) { if (it) ix[String(it)] = s.id; });
			}
		});
	} catch (e) { /* mirror not up yet; the resident scan below still runs */ }
	for (var i = 0; i < pg.chats.length; i++) {
		var c = pg.chats[i];
		if (!c || !c.id || !c._loaded || !c.messages) continue;
		for (var j = 0; j < c.messages.length; j++) {
			var m = c.messages[j];
			if (m && m.why === REASON_DISPATCHED_STR && m.iturn) ix[String(m.iturn)] = c.id;
		}
	}
	_dispatchedIx = ix;
	updateExpedite();
}

// ── The watched hand-offs ──────────────────────────────────
//
// THE SUBSET OF `_dispatchedIx` THAT CAN STILL STREAM, and the only thing the
// progress watch and the prompt pull follow. The index itself keeps every
// dispatched placeholder, because the recovery scans need the orphans; watching
// them was the fault of 2026-09-22. A placeholder whose hand-off never returned
// was rebuilt into the index on every reload and watched for ever -- no age limit,
// no check that any device held the turn -- and on gilgamesh two such watches held
// reads open at the gateway for twelve hours.
//
// Recomputed wherever the index moves (through `updateExpedite`), when the lease
// view moves (a claim, a release), and on a slow tick while anything is watched,
// because the one bound that moves on its own is the clock. The rule is
// `DaimondPeer.watchDecision`; this only gathers what it reads.
var _watchIx = Object.create(null);
var _watchTick = null;
var WATCH_RECHECK_MS = 60000;

/// Recompute `_watchIx` from `_dispatchedIx`. A placeholder not resident yet (its
/// chat named by a summary and not loaded) cannot be aged and is left out until
/// `ensureDispatchedResident` loads it and asks again.
function refreshHandoffWatch() {
	var next = Object.create(null);
	var self = selfDeviceId();
	var now  = Date.now();
	for (var k in _dispatchedIx) {
		if (!Object.prototype.hasOwnProperty.call(_dispatchedIx, k)) continue;
		try {
			var chat = dispatchedChat(k);
			var m = chat ? dispatchedPlaceholderIn(chat, k) : null;
			if (!m) continue;
			var lease = (window.DaimondLease && DaimondLease.record) ? DaimondLease.record(k) : null;
			var fin = dispatchedTurnFinished(chat, k) || dispatchedAnswerPresent(chat, m);
			if (DaimondPeer.watchDecision(m, lease, fin, self, now)) next[k] = true;
		} catch (e) { /* peer or lease not up: nothing is watched on a guess */ }
	}
	_watchIx = next;
	var any = false;
	for (var j in _watchIx) { if (Object.prototype.hasOwnProperty.call(_watchIx, j)) { any = true; break; } }
	if (any && !_watchTick) {
		_watchTick = setTimeout(function () { _watchTick = null; updateExpedite(); }, WATCH_RECHECK_MS);
	}
}

/// The empty dispatched placeholder of `turnId` in `chat`, or null.
function dispatchedPlaceholderIn(chat, turnId) {
	var ms = chat && chat.messages;
	for (var i = 0; ms && i < ms.length; i++) {
		var m = ms[i];
		if (m && m.why === REASON_DISPATCHED_STR && String(m.iturn) === String(turnId)
			&& !(m.content && m.content.trim())) return m;
	}
	return null;
}

// ── The chat log, drawn (P2.3a, design §2) ─────────────────
//
// Every turn writes its rows to its chat's log, and this is where a device draws them:
// page/turnlog.js reads above the chat's cursor, opens each row and folds it through the
// engine's TurnView, which alone says when a turn has ended. Read when the gateway taps
// `c<chat>:<head>` past the cursor, when a hand-off is watched, and on the slow floor
// (`updateExpedite`) where no tap comes.
//
// The cursor and an open turn's view are this device's, not the chat's: they never ride
// the parcel (a record carries no reader's place), and a device with none reads the log
// from its start, which folds what it already holds by mid and adds nothing twice.
var LOG_PLACE_KEY = 'daimond.chatlog.place';
var _logBusy = Object.create(null);		// chat id -> a read in flight
var _logAgain = Object.create(null);	// chat id -> tapped again while it ran

function logPlaces() {
	try { return JSON.parse(localStorage.getItem(LOG_PLACE_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function saveLogPlace(chat) {
	var all = logPlaces();
	all[chat.id] = { seq: logCursor(chat), views: chat.logViews || {}, ends: chat.logEnds || {} };
	try { localStorage.setItem(LOG_PLACE_KEY, JSON.stringify(all)); } catch (e) { /* re-read next boot */ }
}
function loadLogPlace(chat) {
	if (chat.logSeq != null) return;
	var p = logPlaces()[chat.id];
	chat.logSeq   = p ? (+p.seq || 0) : 0;
	chat.logViews = (p && p.views) || {};
	chat.logEnds  = (p && p.ends) || {};
}

/// Has this device read turn `turn` of chat `chatId` ended? The dead-writer detector's check
/// (`readerEnded`), from the chat if resident, else from this device's log place.
export function chatLogEnded(chatId, turn) {
	var id = String(chatId || ''), chat = (pg.chats || []).find(function (c) { return c && c.id === id; });
	if (chat && chat.logSeq != null) return turnEnded(chat, turn);
	var p = logPlaces()[id];
	return !!p && turnEnded({ logEnds: p.ends, logViews: p.views }, turn);
}

/// The turn's state tile: its empty hand-off placeholder.
function isStateTile(m, turnId) {
	return !!m && m.why === REASON_DISPATCHED_STR && String(m.iturn) === String(turnId)
		&& !(m.content && m.content.trim());
}

/// Read and draw `chat`'s log above its cursor, its transcript loaded first. Single-flight
/// per chat: a tap during a read reads once more after it.
export async function readChatLog(chat) {
	if (!chat || !chat.id || !chat.messages || !window.DaimondSync || !DaimondSync.readLog
		|| !window.DaimondSeal || !window.DaimondIdentity || !DaimondIdentity.unwrapBytesAad
		|| (DaimondIdentity.isUnlocked && !DaimondIdentity.isUnlocked())) return null;
	if (_logBusy[chat.id]) { _logAgain[chat.id] = true; return null; }
	_logBusy[chat.id] = true;
	try {
		// A tap or a watch reads a chat the rail holds only as a summary: its transcript
		// first, so the log folds under it (turnlog.js `readChat` refuses one not loaded).
		if (chat._loaded === false) await loadChatMessages(chat);
		if (window.DaimondGateway && DaimondGateway.account) pg.member = DaimondGateway.account() || pg.member;
		var out;
		do {
			delete _logAgain[chat.id];
			loadLogPlace(chat);
			var follow = (pg.current && pg.current.id === chat.id) ? followsEnd() : true;
			var held = chat.messages;
			out = await readChat(chat, {
				seal:   window.DaimondSeal,
				unwrap: function (b, aad) { return DaimondIdentity.unwrapBytesAad(b, aad); },
				read:   function (id, since) { return DaimondSync.readLog(id, since); },
				join:   msgJoin,
				isTile: isStateTile,
				onRows: onLogRows,
				onEnd:  onLogEnd,
			});
			for (var vt in chat.logViews || {}) {
				_progressView[vt] = { turn: vt, msgs: viewMessages(chat.logViews[vt]), final: false };
			}
			saveLogPlace(chat);
			if (chat.messages !== held) {
				touchChat(chat);
				try { persistChats(); } catch (e) { /* drawn; the next save takes it */ }
				if (pg.current && pg.current.id === chat.id && ownsChat(chat)) {
					renderHistory(chat.messages);
					followActivity(follow);
				}
			}
		} while (_logAgain[chat.id]);
		return out;
	} finally { delete _logBusy[chat.id]; }
}

/// The logs a boot owes (P2.3a2), read on every unlock: the chat on screen, every chat with
/// a turn the log holds open here (a view in this device's place), and every chat holding a
/// hand-off placeholder, each once its transcript is resident. One at a time.
export async function readLogsAtBoot() {
	var places = logPlaces(), held = {};
	try { ChatStore.stored().forEach(function (s) { if (s && s.id && Array.isArray(s.iturns) && s.iturns.length) held[s.id] = 1; }); }
	catch (e) { /* placeholders unknown: the screen and the open turns still read */ }
	var list = (pg.chats || []).filter(function (c) {
		if (!c || !c.id) return false;
		var p = places[c.id];
		return (pg.current && pg.current.id === c.id) || held[c.id]
			|| !!(p && p.views && Object.keys(p.views).length);
	});
	for (var i = 0; i < list.length; i++) {
		try {
			if (!list[i]._loaded) await loadChatMessages(list[i]);
			await readChatLog(list[i]);
		} catch (e) { /* the next wake or open reads it */ }
	}
}

/// A turn's end row folded (P2.3a2): its view is final, a native runner's figures on its
/// answer join the chat's totals once, and its hand-off placeholder goes.
function onLogEnd(chat, turnId, view) {
	_progressView[turnId] = { turn: turnId, msgs: [], final: true };
	var ph = dispatchedPlaceholderIn(chat, turnId);
	var mids = {};
	((view && view.rows) || []).forEach(function (f) { if (f && f.role === 'assistant') mids[String(f.mid)] = 1; });
	(chat.messages || []).forEach(function (m) { if (m && mids[String(m.mid)]) foldRunnerTotals(chat, m, ph); });
	dropDispatchedPlaceholder(turnId);
}

// ── What a handed-off turn shows the asker (P2.3a5) ──────────────
//
// A runner turning a handed-off turn's show (`file_show`, `web_open`) to the asker's screen
// (D-20261006-27) leaves the tool row in the log, and the asker opens it from that row
// (`panelIntent`): nothing rides beside the rows. Each row once, in order, and only for a
// turn this device handed off and still holds open (its placeholder, dispatched from here).
var _uiDone  = Object.create(null);		// tool row mid -> opened (or being opened) here
var _uiChain = Object.create(null);		// turn -> the shows still to finish, one at a time
// How long after a failed show it is tried again, in turn.
var UI_RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/// The rows a log read drew first or changed here for `turnId`: open the panels its tool rows
/// showed, each once its result has landed. A show the runner refused (`outcome` `refused`)
/// put nothing on the asker's screen, so it is given up, never retried here.
///
/// ONE AT A TIME. The Doc and Preview panels share the stage, and the one that comes to the
/// front is the one whose show finished last, so each show waits for the one before it.
function onLogRows(chat, turnId, fresh, changed) {
	var ph = dispatchedPlaceholderIn(chat, turnId);
	if (!ph || String(ph.dispatchedBy || '') !== selfDeviceId()) return;
	var owner = String((chat && chat.diamondId) || '');
	(fresh || []).concat(changed || []).forEach(function (m) {
		var u = panelIntent(m), id = String((m && m.mid) || '');
		if (!u || !id || _uiDone[id]) return;
		var how = String(m.outcome || '');
		if (!how) return;		// the call is logged before its result: wait for the edit
		_uiDone[id] = 1;
		if (how === 'refused') {
			diag('handoff panel refused', 'turn=' + String(turnId).slice(0, 12) + ' ' + (u.web || u.show));
			return;
		}
		var chain = (_uiChain[turnId] || Promise.resolve()).then(function () { return openIntent(turnId, u, owner); });
		_uiChain[turnId] = chain;
		chain.then(function () { if (_uiChain[turnId] === chain) delete _uiChain[turnId]; });
	});
}

/// Show one intent, retrying on the ladder; settles once it is shown or given up. A file the
/// runner has just written may not have reached this device yet (the workspace sync carries
/// it, 1.6-3.3 s after the claim on world 99), so a failed show is tried again.
function openIntent(key, u, owner) {
	return new Promise(function (done) {
		var tries = 0;
		(function attempt() {
			Promise.resolve().then(function () {
				// A page goes through the Web panel's own door, whose owner rule keeps it for a
				// conversation not on screen, as a file show is kept.
				if (u.web) return (window.DaimondWeb && DaimondWeb.open) ? DaimondWeb.open(u.web, owner) : null;
				return (window.DaimondDoc && DaimondDoc.show) ? DaimondDoc.show(u.show, u.page || undefined, owner) : null;
			}).then(function () {
				diag('handoff panel opened', 'turn=' + String(key).slice(0, 12) + ' ' + (u.web || u.show));
				done();
			}, function (e) {
				if (tries >= UI_RETRY_MS.length) {
					diag('handoff panel lost', 'turn=' + String(key).slice(0, 12) + ' ' + (u.web || u.show) + ': '
						+ String((e && e.message) || e).slice(0, 120));
					done();
					return;
				}
				setTimeout(attempt, UI_RETRY_MS[tries++]);
			});
		})();
	});
}

// ── The hand-off tile's workers (P2.3a5) ─────────────────────────
//
// The workers a handed-off turn runs on the other device, read from that device's agents
// frame (`agents.<device>`, PeerAgents), which names each run's turn.

/// Draw, on a hand-off tile, the workers its turn is running on the other device: each by
/// name with the status pill this device's own agents list draws (`Workers.pill`). Replaces
/// the row it drew before; nothing when there are none.
export function drawHandoffWorkers(tile, key) {
	var body = tile._body || tile;
	var old = body.querySelector('.handoff-workers');
	var list = [];
	try { list = DaimondPeer.turnWorkers(PeerAgents.list(), String(key || '')); } catch (e) { list = []; }
	if (!list.length) { if (old) old.remove(); return; }
	var row = document.createElement('div');
	row.className = 'handoff-workers';
	list.forEach(function (w) {
		var one = document.createElement('span');
		one.className = 'hw';
		var nm = document.createElement('span');
		nm.className = 'hw-name';
		nm.textContent = w.name;
		one.appendChild(nm);
		one.appendChild(Workers.pill(w.status));
		row.appendChild(one);
	});
	if (old) body.replaceChild(row, old);
	else body.appendChild(row);
}

/// A peer's agents frame came: redraw the workers on every hand-off tile on screen.
export function redrawHandoffWorkers() {
	var out = document.getElementById('chat-output');
	var tiles = out ? out.querySelectorAll('[data-handoff-turn]') : [];
	for (var i = 0; i < tiles.length; i++) drawHandoffWorkers(tiles[i], tiles[i].getAttribute('data-handoff-turn'));
}

/// `c<chat>:<head>`: read a loaded chat whose cursor is below the head.
function onLogTap(chatId, head) {
	for (var i = 0; i < pg.chats.length; i++) {
		var c = pg.chats[i];
		if (!c || c.id !== chatId) continue;
		loadLogPlace(c);
		if ((+head || 0) > logCursor(c)) readChatLog(c);
		return;
	}
}

// ── The streamed view of a handed-off turn ─────────────────
//
// WHAT THE OWNER ASKED FOR (2026-09-12): a turn typed HERE and run THERE must
// appear here as it is produced, not when the next parcel sync happens to land.
//
// The runner sends a small frame every couple of seconds (peer.js's progress
// timer -> the `pushProgress` dep above -> sync.js pushProgressFrame), and this is
// the other end: while a dispatched placeholder is outstanding, read that turn's
// frames and draw the tail into the hand-off tile in place. Each frame REPLACES
// the last -- the tail is the whole tail -- and the whole streamed view is replaced
// by the ordinary transcript the moment the real answer merges, so nothing is ever
// shown twice.
//
// The gateway taps the account's wake channel as each frame is stored, and the sync
// engine then reads the door once per watched turn, so a frame is drawn within a
// moment of being stored while the page holds one channel however many turns it
// watches. Until 2026-09-23 each watched turn parked a read of its own at the door,
// and on an HTTP/1.1 front door those reads took the browser's six connections. The
// 4s expedite pull below stays as the floor for a device whose channel is down, and
// for the answer itself.

// Runner side: the text of each turn currently in flight, which is the only place
// the answer being produced exists until the turn settles (see the `text` arm of
// runTurn's onEvent). `_liveMid` is the mid the finished answer WILL carry, minted at
// turn start, so the message that syncs back converges by mid.
export var _liveTurn = {};
export var _liveMid = {};
// And the answer's `prod`, stamped at turn start, so the live row carries the record the
// final message will: a provisional copy persisted before the parcel lands must not differ.
export var _liveProd = {};
// Watcher side: each watched turn's view as its log stands (`{ turn, msgs, final }`), which
// `DaimondPeer.frameHears` reads; set by `readChatLog`.
export var _progressView = {};

// ── A native runner's figures in the chat's totals, derived once per run (RT-C) ──
//
// A page runner bills a dispatched turn into its own totals and its record syncs home; a
// native runner has no chat record, so its answer's figures (`ran*`) are the only account
// of the turn. The totals are therefore DERIVED, never last-write:
//
//   total = here (`hereP`/`hereC`/`hereCa`/`hereUsd`, billed on a page, last-write as the
//           totals always were) + `nativeBase` (runs trimmed past the bound) + the sum of
//           `foldedRuns` ([{r, at, p, c, ca, usd, ctx}], one per run, a union by r).
//
// So a device holding the newer record without a run still ends with that run counted
// once, in either sync order. A page runner's own run is held with no figures: its bill is
// in its here part. Every field is ABSENT on a chat no native run touched, so its record
// travels as the same bytes it always did (the push-skip fixed point).
var FOLDED_RUNS_MAX = 64;
var NATIVE_FIGS = ['p', 'c', 'ca', 'usd'];
var HERE_FIELDS = { p: 'hereP', c: 'hereC', ca: 'hereCa', usd: 'hereUsd' };
var TOTAL_FIELDS = { p: 'promptTokens', c: 'completionTokens', ca: 'cachedTokens', usd: 'costUsd' };

/// Order two runs by (at, r), the one order every device trims by.
function runKeyCmp(x, y) {
	return ((+x.at || 0) - (+y.at || 0)) || (x.r < y.r ? -1 : x.r > y.r ? 1 : 0);
}

/// Does `chat` hold any native-run state?
function hasNativeRuns(chat) {
	return !!(chat && ((Array.isArray(chat.foldedRuns) && chat.foldedRuns.length) || chat.nativeBase));
}

/// The part of `chat`'s totals billed on a page, with `at` its last Here turn. A chat no
/// native run touched is all here.
export function hereOf(chat) {
	var h = { at: +(chat && chat.hereAt) || 0 }, own = !!chat && typeof chat.hereP === 'number';
	NATIVE_FIGS.forEach(function (k) { h[k] = +(chat && chat[own ? HERE_FIELDS[k] : TOTAL_FIELDS[k]]) || 0; });
	return h;
}

/// The trimmed base of the two that covers more runs: the larger count, then the later
/// last key, then the larger figures, so every device picks the same one.
function nativeBaseWinner(a, b) {
	if (!a || !a.n) return (b && b.n) ? b : null;
	if (!b || !b.n) return a;
	if (a.n !== b.n) return a.n > b.n ? a : b;
	var k = runKeyCmp(a, b);
	if (k) return k > 0 ? a : b;
	return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

/// The native-run state of records `x` and `y` joined: the runs a union by r (the earlier
/// stamp, then the canonically smaller entry), those at or before the winning base's last
/// key dropped as already in it, and the oldest past `FOLDED_RUNS_MAX` added into the base.
export function nativeJoin(x, y) {
	var base = nativeBaseWinner(x && x.nativeBase, y && y.nativeBase), by = {};
	[x && x.foldedRuns, y && y.foldedRuns].forEach(function (l) {
		(Array.isArray(l) ? l : []).forEach(function (f) {
			if (!f || typeof f.r !== 'string' || !f.r) return;
			var had = by[f.r];
			if (!had || runKeyCmp(f, had) < 0 || (!runKeyCmp(f, had) && JSON.stringify(f) < JSON.stringify(had))) by[f.r] = f;
		});
	});
	var runs = Object.keys(by).map(function (r) { return by[r]; })
		.filter(function (f) { return !base || runKeyCmp(f, base) > 0; });
	runs.sort(runKeyCmp);
	if (runs.length > FOLDED_RUNS_MAX) {
		var cut = runs.slice(0, runs.length - FOLDED_RUNS_MAX), nb = { n: base ? base.n : 0 };
		NATIVE_FIGS.forEach(function (k) { nb[k] = base ? (+base[k] || 0) : 0; });
		cut.forEach(function (f) { NATIVE_FIGS.forEach(function (k) { nb[k] += +f[k] || 0; }); nb.n++; });
		nb.r = cut[cut.length - 1].r; nb.at = +cut[cut.length - 1].at || 0;
		base = nb;
		runs = runs.slice(runs.length - FOLDED_RUNS_MAX);
	}
	return { runs: runs, base: base };
}

/// Set `chat`'s native-run state to `nat` (`nativeJoin`) and derive its totals from
/// `here` (`hereOf`) and it. The context meter takes the newest run's `ctx` when that run is
/// newer than the last Here turn.
export function deriveNativeTotals(chat, here, nat) {
	var on = !!(nat && (nat.runs.length || nat.base));
	NATIVE_FIGS.forEach(function (k) {
		var v = here[k] + (on && nat.base ? (+nat.base[k] || 0) : 0);
		if (on) nat.runs.forEach(function (f) { v += +f[k] || 0; });
		chat[TOTAL_FIELDS[k]] = v;
		if (on) chat[HERE_FIELDS[k]] = here[k]; else delete chat[HERE_FIELDS[k]];
	});
	if (!on) { delete chat.foldedRuns; delete chat.nativeBase; delete chat.hereAt; return; }
	if (nat.runs.length) chat.foldedRuns = nat.runs; else delete chat.foldedRuns;
	if (nat.base) chat.nativeBase = nat.base; else delete chat.nativeBase;
	if (here.at) chat.hereAt = here.at; else delete chat.hereAt;
	for (var i = nat.runs.length - 1; i >= 0; i--) {
		var f = nat.runs[i];
		if (!(+f.ctx > 0)) continue;
		if ((+f.at || 0) > here.at) chat.lastPrompt = +f.ctx;
		break;
	}
}

/// A Here turn has just set `chat.lastPrompt`: stamp when, so a derive leaves it standing
/// over an older native run's context. Only on a chat a native run has touched.
export function noteHerePrompt(chat) {
	if (hasNativeRuns(chat)) chat.hereAt = Date.now();
}

/// Are run `run`'s figures (its answer stamped `at`) already in `chat`'s totals?
function runFolded(chat, run, at) {
	if (!chat || !run) return false;
	var l = chat.foldedRuns, b = chat.nativeBase;
	if (Array.isArray(l) && l.some(function (f) { return f && f.r === String(run); })) return true;
	return !!(b && b.n && at != null && runKeyCmp({ r: String(run), at: +at || 0 }, b) <= 0);
}

/// Hold run `run` (stamped `at`, default the clock) in `chat`'s totals with figures `d`
/// (`{p, c, ca, usd, ctx}`; none for a page runner, whose bill is in its here part), and
/// derive them again.
export function markRunFolded(chat, run, at, d) {
	if (!chat || !run) return;
	var f = { r: String(run), at: +at || Date.now() };
	NATIVE_FIGS.concat(['ctx']).forEach(function (k) { if (d && +d[k] > 0) f[k] = +d[k]; });
	deriveNativeTotals(chat, hereOf(chat), nativeJoin(chat, { foldedRuns: [f] }));
}

/// Did answer `row` come from a native runner? The dispatch mark says so (`toNative`); a
/// mark from before it falls back on the presence row of the device that ran it.
function runnerRoadNative(ph, row) {
	if (ph && ph.toNative) return true;
	try {
		var dp = window.DaimondPresence;
		var pr = (dp && dp.snapshot && dp.snapshot()) || {};
		var rec = row && row.ranOn ? pr[String(row.ranOn)] : null;
		return !!(rec && rec.kind === 'runner');
	} catch (e) { return false; }
}

/// Fold answer `row`'s figures into `chat`'s totals, once per run and for a native runner
/// only, `ph` being the turn's dispatch mark. Answers whether it folded. `prev*` is left
/// alone: it is this device's own app baseline, and the runner's turn was not one.
function foldRunnerTotals(chat, row, ph) {
	if (!chat || !row || !row.run || runFolded(chat, row.run, row.ts)) return false;
	var d = { p: +row.ranTokIn || 0, c: +row.ranTokOut || 0, ca: +row.ranCached || 0,
		usd: +row.ranCost || 0, ctx: +row.ranCtx || 0 };
	if (!(d.p || d.c || d.ca || d.usd || d.ctx)) return false;	// an old runner said nothing
	if (!runnerRoadNative(ph, row)) return false;			// a page runner's record carries its own
	markRunFolded(chat, row.run, +row.ts || Date.now(), d);
	return true;
}

/// Read the log of every chat holding a watched hand-off (P2.3a): the turn's rows and its
/// end are there, not on a frame.
function readWatchedLogs() {
	var seen = Object.create(null);
	for (var w in _watchIx) {
		if (!Object.prototype.hasOwnProperty.call(_watchIx, w)) continue;
		var wc = dispatchedChat(w);
		if (wc && !seen[wc.id]) { seen[wc.id] = true; try { readChatLog(wc).catch(function () {}); } catch (e) { /* no log reader */ } }
	}
}

/// One string safe inside a CSS attribute selector. `CSS.escape` where the engine
/// has it, and a conservative strip where it does not -- a turn id is a mid, so
/// nothing legitimate is lost.
export function cssEsc(s) {
	try { if (window.CSS && CSS.escape) return CSS.escape(String(s)); } catch (e) {}
	return String(s).replace(/[^A-Za-z0-9_-]/g, '');
}

// Whether the sync engine is currently being asked to poll promptly for a
// hand-off's answer, so the verb is called only on a real change of state.
var _expediting = false;

/// A hand-off is in flight exactly while a dispatched placeholder is outstanding:
/// on the device that dispatched it, and on any paired device holding the synced
/// placeholder, `_dispatchedIx` is non-empty from the moment the turn leaves until
/// its answer merges (the placeholder is then dropped). Ask the sync engine to pull
/// promptly for that whole window and to stand down the rest of the time, so a
/// watching phone catches the answer in seconds rather than at the 45s wake tick --
/// the residual latency the streaming push does not by itself close on a tab whose
/// wake park iOS has frozen.
export function updateExpedite() {
	// The WATCHED hand-offs, not every placeholder: a hand-off nothing can answer any
	// more has no answer to pull for. See `refreshHandoffWatch`.
	refreshHandoffWatch();
	var on = false;
	for (var k in _watchIx) { if (Object.prototype.hasOwnProperty.call(_watchIx, k)) { on = true; break; } }
	// The watched hand-offs' logs follow the SAME index, read on every reindex -- not
	// only when the expedite flag flips -- because a second hand-off arriving while the
	// first is outstanding does not change the flag but does need its own read.
	try { readWatchedLogs(); } catch (e) { /* sync not up on this device */ }
	if (on === _expediting) return;
	_expediting = on;
	try { if (window.DaimondSync && DaimondSync.expedite) DaimondSync.expedite(on); }
	catch (e) { /* sync not up on this device */ }
}

/// The live chat holding a turn's dispatched placeholder, via the index, or null.
/// Resolves the cached id against the live `chats` array, so a chat deleted since
/// the entry was made simply comes back null.
export function dispatchedChat(turnId) {
	var cid = _dispatchedIx[String(turnId)];
	if (cid == null) return null;
	for (var i = 0; i < pg.chats.length; i++) if (pg.chats[i] && pg.chats[i].id === cid) return pg.chats[i];
	return null;
}

/// Did THIS device dispatch `turnId`? Read from the turn's dispatched placeholder, which
/// carries `dispatchedBy`; no placeholder resident here answers false.
///
/// Published for sync.js `ownDispatch`, which decides whether a push stands off a running
/// hand-off. It read a `DaimondCore.chats` this object never published, so it answered false
/// on the asker too, and the asker held its own dispatch parcel for the whole of the run: a
/// second device never received the waiting row and never followed the turn (UNBLOCK-44).
export function dispatchedHere(turnId) {
	var self = selfDeviceId();
	var chat = self ? dispatchedChat(turnId) : null;
	var ms = (chat && chat.messages) || [];
	for (var i = 0; i < ms.length; i++) {
		var m = ms[i];
		if (m && m.why === REASON_DISPATCHED_STR && String(m.iturn) === String(turnId)) {
			return String(m.dispatchedBy || '') === String(self);
		}
	}
	return false;
}

/// The loaded chat holding `turnId`'s own user message, or null.
///
/// What a RUNNER needs, and why it is not `dispatchedChat`: a runner has no
/// dispatched placeholder for the turn it is running -- it reconstructed the chat
/// and is running the turn in it -- so the index that answers for a watcher says
/// nothing here. The chat on screen is not it either: a runner streams a turn
/// whose chat the reader may never have opened.
// The run each handed-off turn running on this device is on, by turn id.
export var _turnRun = {};

/// The run a handed-off turn starts on `chat`: a fresh id, and the mids of the turn's
/// span already held, which belong to whatever came before this run and are never
/// stamped as its own.
export function beginTurnRun(chat, turnId) {
	var pre = {};
	turnSpan(chat, turnId).forEach(function (m) { if (m.mid) pre[String(m.mid)] = 1; });
	return { id: newMid(), tid: String(turnId), pre: pre };
}

/// The rows of turn `turnId` in `chat` (`DaimondPeer.turnSpan`).
export function turnSpan(chat, turnId) {
	return DaimondPeer.turnSpan((chat && chat.messages) || [], turnId);
}

/// Stamp the running run's id on every row of its turn it wrote and has not yet
/// stamped (`beginTurnRun`). Lazy, at the points a row leaves this device -- a frame,
/// the turn's end -- rather than at each of the many places a row is pushed. Answers
/// how many rows it stamped.
function stampTurnRun(chat, turnId) {
	var r = _turnRun[String(turnId || '')];
	if (!r || !r.id) return 0;
	var n = 0;
	turnSpan(chat, r.tid).forEach(function (m) {
		if (m.run || !m.mid || r.pre[String(m.mid)] || m.provisional) return;
		m.run = r.id; touchMsg(m); n++;
	});
	return n;
}

/// Drop the rows of turn `turnId` in `chat` that no run but `keepRun` may hold
/// (`DaimondPeer.otherRunRows`): a provisional one is filtered out, a real one
/// tombstoned, so a parcel's union cannot bring it back. Answers how many went.
function dropOtherRunRows(chat, turnId, keepRun, keepMids) {
	if (!chat || !chat.messages || !window.DaimondPeer || !DaimondPeer.otherRunRows) return 0;
	var gone = DaimondPeer.otherRunRows(chat.messages, turnId, keepRun, keepMids);
	if (!gone.length) return 0;
	var drop = {}, real = [];
	gone.forEach(function (g) { drop[g.mid] = 1; if (!g.provisional) real.push(g.mid); });
	chat.messages = chat.messages.filter(function (m) { return !(m && m.mid && drop[String(m.mid)]); });
	if (real.length) { try { msgTombstone(real); } catch (e) { /* the filter still stands here */ } }
	diag('handoff other-run rows', 'turn=' + String(turnId).slice(0, 12) + ' dropped ' + gone.length
		+ ' (' + real.length + ' real) keep=' + String(keepRun || 'none').slice(0, 12));
	return gone.length;
}

/// The run whose rows stand for turn `turnId` on `chat`: the one running here, else
/// the one a reload interrupted (`foldJournalTurn` names it on the badged answer),
/// else '' -- a turn no run of which this device knows.
function runOfTurn(chat, turnId) {
	var r = _turnRun[String(turnId || '')];
	if (r && r.id) return r.id;
	var span = turnSpan(chat, turnId);
	for (var i = span.length - 1; i >= 0; i--) {
		if (span[i].interrupted && span[i].why === 'runner' && span[i].run) return String(span[i].run);
	}
	return '';
}

export function chatHoldingTurn(turnId) {
	if (!String(turnId || '')) return null;
	for (var i = 0; i < pg.chats.length; i++) {
		if (pg.chats[i] && pg.chats[i]._loaded && chatHoldsTurn(pg.chats[i], turnId)) return pg.chats[i];
	}
	return null;
}

/// Does resident chat `c` hold turn `turnId`: a user row whose `mid` or `iturn` it is?
function chatHoldsTurn(c, turnId) {
	var id = String(turnId || '');
	if (!id || !c || !c.messages) return false;
	for (var j = c.messages.length - 1; j >= 0; j--) {
		var m = c.messages[j];
		if (m && m.role === 'user' && (String(m.mid || '') === id || String(m.iturn || '') === id)) return true;
	}
	return false;
}

/// The chat holding `report`'s turn, loaded on demand (QA ccp4-b K2): a resident one, else the
/// chat the report names once its transcript is read and seen to hold the turn, so a report
/// heard after a reload finds its chat, and a chatId alone never chooses one. Null for none.
export async function chatHoldingReport(report) {
	var c = chatHoldingTurn(report && report.turnId);
	if (c) return c;
	var id = String((report && report.chatId) || '');
	for (var i = 0; id && i < pg.chats.length; i++) if (pg.chats[i] && pg.chats[i].id === id) { c = pg.chats[i]; break; }
	if (!c || c._loaded) return null;
	try { await loadChatMessages(c); } catch (e) { return null; }
	return chatHoldsTurn(c, report.turnId) ? c : null;
}

/// This device's stable id -- a PER-DEVICE random id (identity.js:deviceId), NOT
/// the account public key. Pairing copies the account key onto every device, so
/// two paired devices would share a key-derived id: presence would self-exclude
/// the only peer, and both twins would write the same lease `holder` and both
/// run and bill the turn. The device id is distinct per device, which is what the
/// lease's foreign-holder test and presence rely on.
export function selfDeviceId() {
	try { return (window.DaimondIdentity && DaimondIdentity.deviceId()) || ''; }
	catch (e) { return ''; }
}

/// THE CLOCK EVERY LEASE-LIVENESS CHECK READS (SIM-4). A device's raw
/// `Date.now()` disagrees with a peer's by however far the two clocks have
/// drifted, so a call site that judged a lease's liveness against it could read
/// a peer's still-running lease as dead once that drift passed the 90s TTL, and
/// re-run -- and re-bill -- the turn. `DaimondLease.authorityNow` corrects for
/// the drift with the offset learned from the gateway's own answers; this is
/// the one place a lease-facing call site falls back to the raw clock, only
/// before any gateway round trip has taught that offset.
export function leaseClockNow() {
	try { return (window.DaimondLease && DaimondLease.authorityNow) ? DaimondLease.authorityNow() : Date.now(); }
	catch (e) { return Date.now(); }
}

// THE LAST NAME EACH DEVICE WAS SHOWN BY HERE (Q23). A device taken off the
// roster, or one that only ever beat, has no line to name it by, and a slice of
// its id ("Allowed on 3fa9c1") means nothing to a person. LOCAL and bounded:
// it is a memory of what this screen has already said, not a record to sync.
var DEVICE_NAMES_KEY = 'daimond-device-names';	// id -> { n: name, at: ms }
var DEVICE_NAMES_MAX = 64;
var _deviceNames = null;				// the parsed store, read once

function deviceNamesKnown() {
	if (!_deviceNames) {
		var raw = readJson(DEVICE_NAMES_KEY, {});
		_deviceNames = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
	}
	return _deviceNames;
}

/// Keep `name` as what `id` was last called here. Writes only on a change, so
/// a label drawn on every render costs a lookup and nothing more.
function rememberDeviceName(id, name) {
	if (!DEVICE_ID_RE.test(id) || !name) return;
	var known = deviceNamesKnown();
	if (known[id] && known[id].n === name) return;
	known[id] = { n: String(name), at: Date.now() };
	var ids = Object.keys(known);
	if (ids.length > DEVICE_NAMES_MAX) {
		ids.sort(function (a, b) { return (known[a].at | 0) - (known[b].at | 0); })
			.slice(0, ids.length - DEVICE_NAMES_MAX)
			.forEach(function (old) { delete known[old]; });
	}
	try { localStorage.setItem(DEVICE_NAMES_KEY, JSON.stringify(known)); }
	catch (e) { /* the name is still held for this page */ }
}

/// A readable name for a device id. The presence beat carries each awake
/// device's own label, so it is asked first; the roster is the durable
/// fallback for a device not presently beating; then the last name this
/// device saw it by; and "another device" for one never named here. Never a
/// slice of the id.
export function deviceLabelFor(id) {
	var n = deviceNameFor(id);
	if (n || !id) return n;
	// This device unnamed is "This device", never "another device" (UNBLOCK-1).
	return String(id) === String(selfDeviceId() || '') ? t('devices.unknown') : t('devices.another');
}

/// The name a device id is known by, or '' when it has none: `deviceLabelFor`
/// without the relative fallback, for words read on ANOTHER device, where
/// "This device" would name the wrong one (UNBLOCK-32 F4b).
export function deviceNameFor(id) {
	var sid = String(id || '');
	if (!sid) return '';
	var n = '';
	try {
		if (window.DaimondPresence && DaimondPresence.name) n = DaimondPresence.name(sid) || '';
	} catch (e) { /* presence not up */ }
	if (!n) {
		try {
			var e2 = loadDevices()[sid];
			if (e2) n = e2.label || e2.name || '';
		} catch (e) { /* roster not readable */ }
	}
	if (n) { rememberDeviceName(sid, n); return n; }
	var was = deviceNamesKnown()[sid];
	return (was && was.n) || '';
}

/// The §5 display state of a dispatched turn message, via the pure classifier. The
/// open consent-ask (if the runner is blocked on a live question) is passed so the
/// status can say so ("awaiting-consent") rather than sit on "Sent to your devices".
export function peerUiStateFor(m) {
	if (!window.DaimondPeer || !DaimondPeer.uiState) return 'dispatched';
	var lease  = (window.DaimondLease && DaimondLease.record) ? DaimondLease.record(m.iturn) : null;
	var report = peerReports[String(m.iturn)] || null;
	var ask    = _openAsk[String(m.iturn)] || null;
	var tid = String(m.iturn);
	return DaimondPeer.uiState(m, lease, report, selfDeviceId(), leaseClockNow(), ask,
		_localEnding[tid] ? 'end' : !!_localRecovering[tid], turnLogState(tid, ''));
}

/// Stamp the GLOBAL park count onto a turn's synced dispatched placeholder, so a
/// re-run from any device bumps from the true total. The placeholder rides the
/// content parcel, so the count travels; the parked report is the authority a
/// re-dispatch reads, and this keeps the UI and any device's re-run in step.
function markPlaceholderParked(turnId, parkCount) {
	var tid = String(turnId || '');
	// The one chat holding this turn's placeholder, via the index; iturn is unique
	// to a turn, so the old all-chats sweep only ever moved this one.
	var c = dispatchedChat(tid);
	if (!c || !c.messages) return;
	var moved = false;
	for (var j = 0; j < c.messages.length; j++) {
		var m = c.messages[j];
		if (m.why === 'dispatched' && String(m.iturn) === tid) {
			if ((m.parkCount | 0) !== (parkCount | 0)) { m.parkCount = parkCount | 0; touchMsg(m); moved = true; }
		}
	}
	if (moved) { touchChat(c); persistChats(); if (ownsChat(c)) renderDispatchedBadges(); }
}

/// Re-run a PARKED turn from the start -- a FRESH DISPATCH, not a resume (no
/// checkpoint exists). Offered only when a human is here on an attended device,
/// which is exactly the condition under which the re-dispatched runner's own ask is
/// answerable, so the loop reaches the bound only in the pathological case (a human
/// who surfaces, triggers a re-run, then leaves before the runner asks). Gated hard
/// on the GLOBAL parkCount: at MAX_PARKS it does not re-dispatch -- it runs LOCALLY
/// here (where the person is), which cannot park because the dialog is answerable.
export function reRunParked(chat, turnId, text) {
	var tid = String(turnId || '');
	var rep = peerReports[tid] || null;
	// The authoritative count: the parked report the runner posted, else the synced
	// placeholder. A terminal report means the turn already failed clean -- do not
	// re-run it.
	if (rep && rep.status === 'aborted') return;
	var count = (rep && rep.status === 'parked') ? (rep.parkCount | 0) : placeholderParkCount(chat, tid);
	var max = (window.DaimondPeer && DaimondPeer.MAX_PARKS) || 2;
	if (count >= max) { continueTurn(chat, tid, text, false, undefined, false); return; }	// at the bound: run here, no more re-dispatch
	// PAST THE WINDOW, IT RUNS HERE (E-R1). A parked turn waits for a person to come
	// back, which is usually longer than any device may start a handed-off turn, so a
	// re-dispatch would be refused by every collector (`turnAgeVerdict`). The person
	// pressed the button, so the turn is theirs to run, here.
	var ph = (chat && chat.messages || []).filter(function (x) {
		return x && x.why === 'dispatched' && String(x.iturn) === tid;
	})[0];
	if (window.DaimondPeer && DaimondPeer.turnInWindow
		&& !DaimondPeer.turnInWindow([tid, ph && ph.mid], [], Date.now())) { continueTurn(chat, tid, text, false, undefined, false); return; }
	// A re-dispatch that would hand it to a peer again, carrying the GLOBAL count.
	// A turn a person's pause holds is not handed on (F2): it is continued HERE, where the
	// same pause refuses it in words, rather than left parked with nothing said.
	// It goes to the runner the switch offers, the one election every hand-off reads; any
	// other refusal before the mark (none that runs the turn's set, D-20261018-09 OR) is
	// answered by the entry: a "not run" row with Retry, never a silent run here.
	try {
		var sw = seatSwitchFor(chat);
		handOffTurn(chat, tid, text, Array.isArray(chat.holds) ? chat.holds : [],
			{ parkCount: count, runTo: (sw && sw.runner) ? sw.runner.deviceId : '' })
			.then(function (r) { if (r && r.paused) continueTurn(chat, tid, text, false, undefined, false); });
	} catch (e) { continueTurn(chat, tid, text, false, undefined, false); }
}

/// The park count stamped on a turn's dispatched placeholder, or 0.
function placeholderParkCount(chat, turnId) {
	var tid = String(turnId || '');
	if (!chat || !chat.messages) return 0;
	for (var j = 0; j < chat.messages.length; j++) {
		var m = chat.messages[j];
		if (m.why === 'dispatched' && String(m.iturn) === tid) return m.parkCount | 0;
	}
	return 0;
}

/// The lease REVOKE primitive, used only as the reclaim half of [Run here] on a
/// BLOCKED turn (`runBlockedTurnHere`). It is NOT a standalone take-back control any
/// more (owner ruling 2026-09-17: no mid-run take-back) -- a claimed turn is answered
/// or run here, never revoked to nothing. The peer's next renew reads `released` and
/// hard-aborts (proven in peer.test.mjs), then `continueTurn` runs the turn here.
export async function peerTakeBack(turnId) {
	if (!window.DaimondLease || !DaimondLease.revoke) return;
	var res;
	var cas = DaimondPeer.syncCas(peerSyncShim());
	// One more try at a door that would not read, as every release has.
	try { res = await DaimondPeer.retryUnread(function () { return DaimondLease.revoke(turnId, cas); }); }
	catch (e) { res = { ok: false, why: 'threw ' + String((e && e.message) || e).slice(0, 60) }; }
	try { renderDispatchedBadges(); } catch (e) { /* a redraw is only a redraw */ }
	if (res && res.ok) return;
	// A revoke that did not land leaves the peer running and `continueTurn` gated off, so
	// [Run here] would otherwise do nothing and say nothing (QA LQ4, 2026-10-04). The
	// person is told, once, and only for a take-back that really failed.
	diag('take-back failed', 'turn=' + turnId + ' why=' + String((res && res.why) || '?'));
	toast(t('turn.peer_takeback_failed'), true);
}

/// Stop a turn another device is running (D-20261011-21): revoke its lease SETTLED.
/// The runner's liveness check reads the revoke and aborts within one gap, and the
/// settled stamp makes every take refuse the turn, so no backstop, recovery or other
/// collector runs it again. The runner reads the settled revoke as this person's Stop
/// (R3 F1): its partial answer is kept, marked stopped, and sent back, exactly as a
/// Stop pressed on the runner itself ends the turn.
export async function peerStopTurn(turnId) {
	var tid = String(turnId || '');
	if (!tid || _peerStopping[tid] || !window.DaimondLease || !DaimondLease.revoke) return;
	_peerStopping[tid] = true;
	syncSendMode();				// "Stopping…" from the press
	var res;
	var cas = DaimondPeer.syncCas(peerSyncShim());
	try {
		res = await DaimondPeer.retryUnread(function () {
			return DaimondLease.revoke(tid, cas, null, { settle: true });
		});
	}
	catch (e) { res = { ok: false, why: 'threw ' + String((e && e.message) || e).slice(0, 60) }; }
	if (res && res.ok) {
		try { clearDispatchFallback(tid); } catch (e) { /* no backstop armed */ }
		delete _handoffStart[tid];	// a stopped turn is no hand-off latency
		try { dropDispatchedPlaceholder(tid); } catch (e) { /* the settled lease reads done anyway */ }
	} else {
		diag('peer stop failed', 'turn=' + tid + ' why=' + String((res && res.why) || '?'));
		toast(t('turn.peer_stop_failed'), true);
	}
	delete _peerStopping[tid];
	try { renderDispatchedBadges(); } catch (e) { /* a redraw is only a redraw */ }
	syncSendMode();
}

/// A turn this device sent has just finished running HERE, a local recovery: drop its
/// placeholder once its end is in (r545, Q19). Waiting for `runErrand` to return left
/// "Sending to X… Another device is picking this up" beside the finished answer, for as
/// long as the report, lease and ack writes took. The end is the TurnView's: folded
/// already, the placeholder goes now; else the chat's log is read at once, and its end,
/// folded, drops it (`onLogEnd`). A peer's run is not this: its end comes with the log.
function dropOwnPlaceholderIfAnswered(turnId) {
	var tid  = String(turnId || '');
	var chat = tid ? dispatchedChat(tid) : null;
	var ph   = chat ? dispatchedPlaceholderIn(chat, tid) : null;
	if (!ph || String(ph.dispatchedBy || '') !== String(selfDeviceId())) return;
	var v = turnView(chat, tid);
	if (v && v.state === 'ended') dropDispatchedPlaceholder(tid);
	else readChatLog(chat);
}

/// Drop the empty "dispatched" placeholder for a turn once its answer has merged,
/// so the real assistant message (same iturn, different mid) stands alone.
/// Tombstoned, so a later merge does not resurrect it.
export function dropDispatchedPlaceholder(turnId) {
	// (e) THE ANSWER HAS LANDED HERE. The placeholder is dropped because the peer's
	// reply merged back, so this is when the hand-off actually paid off on the
	// dispatcher -- the total from turn-send is the user-visible hand-off latency.
	if (_handoffStart[turnId]) {
		var _dispatchTs = _handoffStart[turnId];
		diag('handoff answer', 'turn=' + turnId + ' send->answer=' + (Date.now() - _dispatchTs) + 'ms');
		// AUTO-LAND the hand-off latency and the advertised-vs-real-runner gap on the
		// gateway, bypassing the Diagnostics toggle, now the answer has merged here.
		try { autoLogHandoffLatency(turnId, _dispatchTs); } catch (e) { /* best-effort */ }
		delete _handoffStart[turnId];
	}
	// The one chat holding this turn's placeholder, via the index. iturn is unique
	// to a turn, so the old all-chats sweep only ever touched this one; the answer
	// (same iturn) lives in it too. The index entry goes once the placeholder does.
	var only = dispatchedChat(turnId);
	var scan = only ? [only] : [];
	for (var i = 0; i < scan.length; i++) {
		var c = scan[i];
		if (!c.messages) continue;
		// Provenance must OUTLIVE the placeholder. If this turn was handed off but
		// then ran HERE (the target never finished; it fell back to this device),
		// carry the hand-off target onto the real answer before the placeholder —
		// the sole record of WHERE it was sent — is dropped. Without this the answer
		// reads as a plain local turn and "where did it run?" is lost on reload
		// (owner report 2026-09-06). No-op when a peer ran it (`ranOn` is the peer,
		// not this device), which draws its own "Handed off to X" tile.
		var _phTo = null, _phRefused = null, _phBusy = null, _phThread = null, _ans = null;
		for (var s = 0; s < c.messages.length; s++) {
			var sm = c.messages[s];
			if (sm.why === 'dispatched' && sm.iturn === turnId && !(sm.content && sm.content.trim())) {
				_phTo = handoffTargetLabel(sm) || _phTo;
				// The relay REFUSED this hand-off (S-HAND #6): the reason must OUTLIVE the
				// placeholder too, so the answer tile can say the turn ran here because the
				// relay would not carry it -- not read as a plain local turn on reload.
				if (sm.refused && sm.refused.why) _phRefused = String(sm.refused.why);
				// The seat handed it back BUSY (Q19): the tile names that as the cause.
				if (sm.busyBy) _phBusy = deviceLabelFor(sm.busyBy) || _phBusy;
				// The seat could not rebuild the conversation as sent (D2): named too.
				if (sm.threadBy) _phThread = deviceLabelFor(sm.threadBy) || _phThread;
			} else if (sm.role === 'assistant' && String(sm.iturn) === String(turnId)
				&& sm.content && sm.content.trim()) {
				_ans = sm;
			}
		}
		if (_ans && String(_ans.ranOn || '') === String(selfDeviceId())) {
			var _sig = function () { return (_ans.handoffFellBack || '') + '\u0000' + (_ans.handoffRefused || '')
				+ '\u0000' + (_ans.handoffBusy || '') + '\u0000' + (_ans.handoffThread || ''); };
			var _was = _sig();
			if (_phTo && !_ans.handoffFellBack) _ans.handoffFellBack = _phTo;
			if (_phRefused && !_ans.handoffRefused) _ans.handoffRefused = _phRefused;
			if (_phBusy && !_ans.handoffBusy) _ans.handoffBusy = _phBusy;
			if (_phThread && !_ans.handoffThread) _ans.handoffThread = _phThread;
			if (_sig() !== _was) touchMsg(_ans);
		}
		var kept = [];
		for (var j = 0; j < c.messages.length; j++) {
			var m = c.messages[j];
			if (m.why === 'dispatched' && m.iturn === turnId && !(m.content && m.content.trim())) {
				msgTombstone([m.mid]);
				continue;			// drop the empty placeholder
			}
			kept.push(m);
		}
		if (kept.length !== c.messages.length) {
			c.messages = kept;
			if (ownsChat(c)) renderHistory(c.messages);
			touchChat(c); persistChats();
			if (c.id) ChatStore.compact(c.id);   // drop the tombstoned placeholder from the chunks (Stage 2)
		}
	}
	// What its runner never heard goes now, as the next turn (UNBLOCK-27 R7). After the index
	// entry goes, below, so the turn no longer reads as held.
	var _after = only;
	// The placeholder is gone: its index entry goes with it, and any armed
	// dispatcher-side recovery backstop (Fix B) has nothing left to recover.
	delete _dispatchedIx[String(turnId)];
	try { clearDispatchFallback(turnId); } catch (e) { /* no timer armed */ }
	if (_after && (_after._queue || []).length) setTimeout(function () { drainAfterHeld(_after); }, 0);
	// The hand-off is settled: if it was the last one outstanding, the in-flight
	// poll stands down.
	updateExpedite();
}

/// Redraw the interrupted badges, so a state change (a lease claimed, a report
/// arrived) reaches the footer. Cheap: re-renders the current chat's history.
export function renderDispatchedBadges() {
	try { if (pg.current && ownsChat(pg.current) && pg.current.messages) renderHistory(pg.current.messages); }
	catch (e) { /* nothing drawn */ }
	syncSendMode();				// a peer's claim, run or end moves Send/Stop too
}

/// (C) Record the device that ACTUALLY claimed a dispatched turn onto its placeholder,
/// so the originator's tile names the real runner rather than its send-time guess. The
/// dispatch target is a best guess (the nominee or freshest peer); the lease HOLDER is
/// the truth. When a live claim is observed for a dispatched turn, copy the holder onto
/// the placeholder's toDevice/toName — which persists and syncs, so every device agrees
/// and the name stays correct after the lease releases (holder() then reads null). Only
/// writes on a real change, so it cannot loop against its own persist.
function stampDispatchHolders() {
	if (!window.DaimondLease || !DaimondLease.holder) return;
	var changed = false;
	var turns = Object.keys(_dispatchedIx);
	for (var i = 0; i < turns.length; i++) {
		var tid = turns[i];
		var holder = '';
		try { holder = String(DaimondLease.holder(tid) || ''); } catch (e) { holder = ''; }
		if (!holder || holder === selfDeviceId()) continue;		// no claim yet, or our own recovery
		// (trace) The FIRST time the real claimant differs from the up-front advertised
		// target, and how long after dispatch it landed -- carried onto the answer-arrival
		// auto-log so the advertised-vs-real gap is quantified. Best-effort.
		try {
			var _et = _electionTrace[tid];
			if (_et && _et.correctedAfterMs < 0 && holder && holder !== _et.advertisedId) {
				_et.correctedHolder  = holder;
				_et.correctedAfterMs = Date.now() - _et.dispatchTs;
			}
		} catch (e) { /* trace is best-effort */ }
		var c = dispatchedChat(tid);
		if (!c || !c.messages) continue;
		for (var j = 0; j < c.messages.length; j++) {
			var m = c.messages[j];
			if (m.why !== 'dispatched' || String(m.iturn) !== tid) continue;
			// UNBLOCK-7 F3: the claim itself is stamped too (`claimedBy`), so a runner that
			// later goes silent reads as failed past the deadline, not "no peer awake". Not
			// skipped when the claimant was already the named target, the usual case.
			if (String(m.toDevice) === holder && String(m.claimedBy || '') === holder) continue;
			if (String(m.toDevice) !== holder) {
				m.toDevice = holder;
				var nm = deviceLabelFor(holder); if (nm) m.toName = nm;
			}
			if (String(m.claimedBy || '') !== holder) { m.claimedBy = holder; m.claimedAt = Date.now(); }
			touchMsg(m);
			changed = true;
		}
	}
	if (changed) { try { persistChats(); } catch (e) { /* the in-memory record still renders */ } }
}

/// Whether an errand's turn is already FINISHED on this device: its TurnView ended, or
/// its lease settled (`dispatchedTurnSettled`). The dispatching-side twin of the runner's D1(b) `finished` guard, read by the
/// recovery decision so a turn a peer already answered is never re-run locally.
function dispatchedTurnFinished(chat, turnId) {
	return dispatchedTurnSettled({ turnId: turnId, chatId: (chat && chat.id) || '' });
}

/// Rebuild the errand for a local recovery from the dispatched turn's own record.
/// The turn already holds everything an errand needs -- its id (`iturn`), its
/// prompt (`itext`), the chat, its model and scope.
///
/// THE PLACEHOLDER'S OWN SENDER AND DEADLINE, NOT THIS DEVICE'S AND 0 (2026-09-23).
/// This used to stamp `dispatchedBy: self` and `deadline: 0` ("runs however old the
/// orphan is"), which turned any device's orphan into this device's own and put it
/// past both of `runErrand`'s guards: the own-dispatch refusal and the deadline. That
/// is how gilgamesh ran argonaut's five-day-old turn. Now `runErrand` refuses a
/// recovery of a turn another device sent, and the lease take refuses one past its
/// deadline.
function errandForRecovery(chat, m) {
	return DaimondPeer.makeErrand({
		eid:          m.eid ? String(m.eid) : undefined,	// the errand it was sent as, so its reports are its own
		turnId:       String(m.iturn),
		chatId:       String(chat.id || ''),
		prompt:       String(m.itext == null ? '' : m.itext),
		pre:          storedPre(chat, m.iturn),		// read from the original record, never composed
		effort:       (function () { var e = storedEffort(chat, m.iturn); return e === null ? turnEffortOf(chat) : e; })(),
		model:        errandModelOf(chat),		// the chat's, or its Diamond's (C3)
		scope:        Array.isArray(chat.holds) ? chat.holds : [],
		parcelVersion: (function () { try { return DaimondSync.version() | 0; } catch (e) { return 0; } })(),
		deadline:     DaimondPeer.handoffDeadline(m),
		dispatchedBy: String(m.dispatchedBy || ''),
		ts:           m.ts || Date.now(),
	});
}

// The turnIds a LOCAL recovery is running RIGHT NOW on this device, so the two
// recovery drivers -- the Fix B backstop timer (`runDispatchFallback`) and the
// visibilitychange rescue (`peerCollectOnReturn`) -- can never both run the same
// orphan and double-bill it. It is the ONE guard that is safe here, because it is
// SYNCHRONOUS: the other guards do not close the window. `chat._generating` is set
// LATE, inside runTurn after a long async prelude (finished -> leaseTake ->
// reconstruct -> leaseRenew -> scopeChatTo), so two drivers both pass it before
// either sets it; `_recovering` guards only `peerCollectOnReturn`, not the timer;
// and the take-if-vacant lease treats two SAME-holder self-recoveries as mutually
// reclaimable (holder === self is not "foreign"), so both claim. Adding the turnId
// here before the first await, and clearing it in the finally, dedupes at the one
// point both drivers funnel through. (Found by adversarial QA, 2026-09-07: two
// concurrent same-device recoveries billed the turn twice.)
export var _localRecovering = Object.create(null);
// The turnIds this device is ENDING "not run" right now (`endHandOffNotRun`): taken on to
// be ended, never to run, so nothing reads this device as their runner (SUHT-I9).
export var _localEnding = Object.create(null);

/// The device running dispatched turn `tid` as this device knows it: the lease holder,
/// else this device from the moment it takes a hand-off that fell back here on itself
/// (`_localRecovering`), before its own claim lands; '' when nobody is. The ONE answer
/// the switch (`chatRunningOn`), the tile and its header read, so none of them names
/// the runner a failed dispatch never reached (UNBLOCK-1 DISPATCH-FAIL, I9).
export function turnRunnerId(tid) {
	var id = String(tid || '');
	if (!id) return '';
	try {
		// A lease held only to end the turn names nobody (`DaimondPeer.endingLease`). While
		// this device ends it, only a foreign holder is a runner: its own run claim left
		// live (a reload) is not, as no run of the turn is under way here (I9-LOWS LOW-2).
		var h = (window.DaimondLease && DaimondLease.holder) ? DaimondLease.holder(id) : null;
		if (h && !(_localEnding[id] && String(h) === String(selfDeviceId() || ''))) return String(h);
	} catch (e) { /* no lease view: only this tab's own run is known */ }
	return (_localRecovering[id] && !_localEnding[id]) ? String(selfDeviceId() || '') : '';
}

/// Is a turn of this chat being taken back to run here (`_localRecovering`), its claim not
/// yet landed and the chat not yet generating? A send queues behind it as behind a turn
/// that is generating (R568-FU F4), so turns run in the order they were sent.
export function recoveringHere(chat) {
	var cid = String((chat && chat.id) || '');
	if (!cid) return false;
	for (var k in _localRecovering) if (_localRecovering[k] === cid) return true;
	return false;
}

/// Run ONE orphaned dispatched turn locally, through the same lease as a peer.
/// Money-safe: a SYNCHRONOUS per-turnId in-flight guard stops the two local
/// recovery drivers double-running it (see `_localRecovering`); and `runErrand`
/// with `allowSelf` still TAKES the lease (a peer that already holds it wins the
/// take-if-vacant merge and this stands down), still checks `finished` first, and on
/// completion pushes the answer and posts the done report. It then SETTLES its own
/// errand and acks: the ack dep calls `DaimondPost.settle(turnId)` first, which frees
/// the local hold on the relay row so the following ack actually drops it -- before
/// this fix `takeRow` re-HELD the row unconditionally, so the ack was a no-op and a peer
/// waking inside the 15-min deadline re-ran and re-billed the turn (S-HAND #1). Finally
/// it releases the lease as `done->released`, which stamps `settled:1` (peer.js) so any
/// taker whose collect delivered the errand and the report together stands down anyway.
/// On done, drop the empty "dispatched" placeholder so the real answer stands alone.
///
/// ONE RUN PER DEVICE, NOT PER TAB (F1, 2026-09-25). `_localRecovering` is this tab's
/// memory, and the lease cannot tell two tabs apart: they share the device id, so a
/// sibling's live lease reads as this device's own and reclaimable. A second tab's
/// backstop therefore ran a turn its sibling was already running, and paid for it
/// twice. So the run holds the turn's work claim (`claimTurnHere`), the one a
/// runner's collect takes, for its whole life, and stands down when another tab
/// holds it.
async function recoverOneLocally(chat, m) {
	var tid = String((m && m.iturn) || '');
	// SYNCHRONOUS dedupe, BEFORE the first await: if a local recovery of this turn is
	// already in flight on this device, do not start a second (the double-bill QA hit).
	if (tid && _localRecovering[tid]) return;
	if (chat._generating) return;			// a live turn already owns this chat
	// The value names the chat, so a send into it waits behind this run (`recoveringHere`).
	if (tid) _localRecovering[tid] = String(chat.id || '') || true;
	// From this moment the turn is this device's: the tile, its header and the switch
	// say so now, not when its own claim lands (UNBLOCK-1 DISPATCH-FAIL, I9).
	redrawRunner();
	var claim = null;
	try {
		claim = await claimTurnHere(tid);
		if (!claim) {
			diag('local run stand-down', 'turn=' + tid + ' another tab of this device is running it');
			return;
		}
		// NO RE-SEAT (owner, D-20261009-23: "If argonaut is selected, it runs there, no
		// take back"). A turn the runner did not run is run here, never chased to
		// another desktop; its tile names the runner in one line.
		if (chat._generating) return;			// a live turn already owns this chat
		var errand = errandForRecovery(chat, m);
		var res = null;
		// Registered as a runner's turn is (`collect`), so the chat on screen reads it
		// running, Stop reaches its abort, and a consent inside it can name it. A busy
		// answer is not a run, and registers nothing.
		var busyNow = !!(DaimondPeer.decideNow && DaimondPeer.decideNow(errand));
		if (!busyNow) runnerCtxBegin(errand);
		try { res = await DaimondPeer.runErrand(errand, peerRunErrandDeps({ allowSelf: true })); }
		catch (e) { return; }				// a failed recovery leaves the footer as it was
		finally { if (!busyNow) runnerCtxEnd(errand && errand.turnId); }
		diag('handoff local run', 'turn=' + tid + ' ' + (res && res.done ? 'done'
			: 'ran=' + !!(res && res.ran) + ' why=' + String((res && res.why) || '?')));
		// A take that could not read the lease door, or won no try at it, has decided
		// nothing: nobody is running the turn. The backstop that brought this run is spent,
		// so it is armed again, to look once more rather than leave the turn to its deadline.
		if (res && !res.ran && DaimondPeer.standDownUndecided(res.why)) {
			try { scheduleDispatchFallback(chat.id, tid, UNDECIDED_RECOLLECT_MS); }
			catch (e) { /* recovery-on-return still nets it */ }
		}
		if (res && res.done) {
			try { dropDispatchedPlaceholder(String(m.iturn)); } catch (e) { /* nothing drawn */ }
			renderDispatchedBadges();
		}
	} finally {
		if (claim) claim.release();
		if (tid) delete _localRecovering[tid];	// clear on EVERY exit -- no leaked in-flight key
		redrawRunner();
		// WHAT WAITED ON IT GOES NOW (R568-FU F4). A turn that ran here sent the next as it
		// ended, and the rest wait on that one; a take-back that stood down, or never
		// started, leaves the queue, and nothing else would send a follow-up behind it.
		if (!(res && res.ran) && !chat._generating && !recoveringHere(chat) && chat._queue && chat._queue.length) {
			try { if (chat.diamondId) drainSteerQueue(chat, chat.diamondId, false); else drainQueue(chat, false); }
			catch (e) { /* the queue stays, badged */ }
		}
	}
}

/// Redraw what names a dispatched turn's runner: the tiles and the seat switch.
function redrawRunner() {
	try { renderDispatchedBadges(); } catch (e) { /* no tiles up */ }
	try { renderSeatSwitch(); } catch (e) { /* no switch up */ }
}

/// Claim the run of one turn on this device, across all its tabs: `{ release }`, or
/// null when a run of it already holds the claim here -- a runner's collect, or a
/// local run in this tab or another. Never waits. Without the claim's machinery (an
/// older post.js) it answers a claim that guards nothing, the behaviour before it.
export async function claimTurnHere(turnId) {
	var none = { release: function () {} };
	var tid = String(turnId || '');
	if (!tid || !window.DaimondPost || !DaimondPost.claimWork
		|| !window.DaimondPeer || !DaimondPeer.turnWorkKey) return none;
	try { return await DaimondPost.claimWork(DaimondPeer.turnWorkKey(tid)); }
	catch (e) { return none; }
}

/// RELEASE every lease this device still holds for a turn it is not running.
///
/// The hang the owner reported on 2026-09-12. A runner that locked, reloaded or
/// was closed mid-turn left its own lease claimed straight to the errand's
/// deadline -- ~15 minutes -- because the claim deliberately does not renew (a
/// busy turn cannot push one). On the originating phone `recoverDecision` then read
/// a LIVE FOREIGN lease, concluded correctly that a peer was on it, and stood down;
/// the user watched a spinner for a quarter of an hour for a turn that had stopped
/// in its first second.
///
/// Only this device's OWN leases are touched, and only where no turn of that id is
/// running on this device -- which on a fresh page load is all of them, because a
/// turn is memory and the page has just started. A peer's lease is never ours to
/// free: that is still the deadline's job.
///
/// NOT RUNNING IN THIS TAB IS NOT NOT RUNNING ON THIS DEVICE (F2, 2026-09-25).
/// `_runnerCtx` is this tab's alone, so focusing an idle tab freed the lease its
/// sibling was running under; the sibling read `released` and aborted a turn the
/// model had already been paid for. Every run of a turn here holds the turn's work
/// claim (`claimTurnHere`), so each release takes that claim first, stands down when
/// another run holds it, and keeps it until the lease is freed, so no run of the turn
/// can start in between.
///
/// An `error` report goes with each release, so the originator is told WHY it is
/// being handed back rather than left to infer it from a state change.
/// END A HANDED-OFF RUN THIS DEVICE WAS RUNNING WHEN IT WENT AWAY (R3 F3), the caller
/// holding the turn's work claim. The journal holds the run open (`runTurn`, or
/// `runSteer`'s detached branch for a daimon), so it is folded back Interrupted and
/// reported, and the lease settled done, by the same door the errand's re-collect takes
/// (`DaimondPeer.reportInterrupted`): the sender reads "interrupted" with its Retry,
/// never a re-run and never a hand-back. Answers whether it ended the turn; false when
/// the journal holds no run of it here, or the chat is not on this device.
async function endRunnerTurn(tid, lr) {
	if (!window.DaimondJournal || !window.DaimondPeer || !DaimondPeer.reportInterrupted) return false;
	var rec;
	try { rec = await DaimondJournal.recover(); } catch (e) { return false; }
	var t = null;
	(rec.turns || []).forEach(function (x) { if (x && String(x.turnId) === String(tid) && x.meta && x.meta.ho) t = x; });
	if (!t) return false;
	var chat = null;
	for (var i = 0; i < pg.chats.length; i++) if (pg.chats[i] && pg.chats[i].id === t.chatId) { chat = pg.chats[i]; break; }
	if (!chat) return false;
	var l = lr || {};
	var e = { turnId: String(tid), chatId: t.chatId, eid: l.eid, dispatchedBy: l.dispatchedBy };
	var res = null;
	// The claim's own deadline, so a record the door lost before it reads unknown, not revoked.
	try { res = await DaimondPeer.reportInterrupted(e, peerRunErrandDeps({}), { chat: chat }, null, l.deadline); }
	catch (err) { res = null; }
	diag('runner restart interrupted', 'turn=' + String(tid).slice(0, 12) + ' ' + (res ? (res.why === 'revoked' ? 'revoked' : 'reported') : 'not reported'));
	if (res) { try { renderDispatchedBadges(); } catch (err) { /* no tiles up */ } }
	return !!res;
}

/// The boot half of the runner's recovery (R3 F3): every handed-off run the journal holds
/// open whose lease THIS device still holds live is ended here, at once. It used to wait
/// for the errand to be collected again, and a runner that reloads keeps no hold on the
/// errand's row, so it never was: the sender sat on Stop to the lease's deadline. A door
/// that cannot be read is asked again a few times; a lease that is another device's, or
/// gone, leaves the entry to the errand and the deadline.
export async function recoverRunnerTurns(tids, tries) {
	if (!tids.length || !window.DaimondPeer || !DaimondPeer.readTwice || !DaimondPeer.syncCas) return;
	var door = null;
	try { door = await DaimondPeer.readTwice(DaimondPeer.syncCas(peerSyncShim())); } catch (e) { door = null; }
	if (!door || door.unread) {
		if ((tries | 0) < 6) setTimeout(function () { recoverRunnerTurns(tids, (tries | 0) + 1); }, 10000);
		return;
	}
	var snap = door.leases || {}, self = selfDeviceId(), busy = [];
	for (var i = 0; i < tids.length; i++) {
		var tid = tids[i], lr = snap[tid];
		if (!lr || String(lr.holder) !== self || !DaimondLease.live(lr, leaseClockNow())) continue;
		var claim = await claimTurnHere(tid);
		// THE CLAIM IS BUSY: ASK AGAIN, DO NOT DROP IT (RUNNER-READY F3). At boot it is
		// usually the collect of this very errand, and a collect that then fails releases
		// the lease with the journal's run unfolded; dropped here, that run was never
		// ended, and its rounds were lost on both devices. A later look finds the lease
		// settled (the collect ended it) and leaves it, or still this device's, and ends it.
		if (!claim) { busy.push(tid); continue; }
		try { await endRunnerTurn(tid, lr); }
		finally { claim.release(); }
	}
	if (busy.length && (tries | 0) < 6) setTimeout(function () { recoverRunnerTurns(busy, (tries | 0) + 1); }, 10000);
}

async function releaseOwnStaleLeases() {
	try {
		if (!window.DaimondPeer || !DaimondPeer.staleOwnLeaseDecision) return 0;
		if (!DaimondPeer.settleLease || !DaimondPeer.readTwice) return 0;
		var cas = DaimondPeer.syncCas(peerSyncShim());
		// AN UNREAD DOOR IS NOT AN EMPTY ONE. It is read once more after a pause, as a
		// release's write is; still unread, nothing is freed, and that is said, since the
		// sweep next runs on the next foreground return.
		var door = await DaimondPeer.readTwice(cas);
		if (door.unread) { diag('lease self-release skipped', 'unread'); return 0; }
		var snap = door.leases || {};
		var self = selfDeviceId();
		var stale = DaimondPeer.staleOwnLeaseDecision(snap, self, _runnerCtx, leaseClockNow());
		var freed = 0;
		for (var i = 0; i < stale.length; i++) {
			var tid = stale[i];
			var claim = await claimTurnHere(tid);
			if (!claim) {
				diag('lease self-release skipped', 'turn=' + tid + ' another tab of this device is running it');
				continue;
			}
			try {
				if (await endRunnerTurn(tid, snap[tid])) { freed++; continue; }
				diag('lease self-release', 'turn=' + tid + ' by=' + String(self).slice(0, 8));
				// REPORT then RELEASE, the order every other hand-back keeps, so the
				// account of the stop is on its way before the turn becomes claimable.
				// Built from the LEASE, which names the device the turn was run for: with
				// no `to` the report was this runner's own to collect and ack off the relay
				// before the phone had it (R3 QA Q6). A lease an older build took names
				// nobody, and its report is taken as before.
				try {
					await DaimondPost.post(await DaimondPeer.sealForSelf(DaimondPeer.reportFor(
						snap[tid] || { turnId: tid }, { status: 'error', why: 'runner-restarted' })));
				} catch (e) { /* the release below still frees the turn */ }
				try { await DaimondPeer.settleLease('turn', tid, self, 'released', cas, leaseClockNow); }
				catch (e) { /* an unreleased lease still expires at its deadline */ }
				freed++;
			} finally { claim.release(); }
		}
		if (freed) { try { renderDispatchedBadges(); } catch (e) {} }
		return freed;
	} catch (e) { return 0; }
}
// page-split: install 29
async function peerCollectOnReturn() {
	if (pg._recovering) return;
	pg._recovering = true;
	try {
		try { if (window.DaimondPost && DaimondPost.collect) await DaimondPost.collect(); } catch (e) { /* offline */ }
		try { if (window.DaimondSync && DaimondSync.pull) await DaimondSync.pull(); } catch (e) { /* offline */ }
		// OUR OWN STALE LEASES FIRST, before the recovery decision reads them: a
		// lease this device still holds for a turn it is plainly not running is the
		// hanging turn the owner reported, and `recoverDecision` would read it as live
		// and stand down. See `releaseOwnStaleLeases`.
		await releaseOwnStaleLeases();
		if (!window.DaimondPeer || !DaimondPeer.recoverDecision || !DaimondPeer.runErrand) return;
		var self = selfDeviceId();
		var now  = Date.now();
		// A snapshot of the candidates first, because recoverOneLocally mutates
		// chats/messages (drops the placeholder) as it goes. Driven off the
		// dispatched-placeholder index rather than a walk of every chat × every
		// message: only turns that carry a dispatched placeholder can be orphans.
		// The chat is resolved against the live array (a stale id comes back null)
		// and the placeholder re-found inside it, so the candidate set is exactly
		// what the full scan produced.
		var jobs = [];
		var byId = {};
		for (var bi = 0; bi < pg.chats.length; bi++) if (pg.chats[bi] && pg.chats[bi].id) byId[pg.chats[bi].id] = pg.chats[bi];
		// The lease section, read ONCE for the whole rescue rather than per placeholder.
		// It is an in-memory map (`DaimondLease.snapshot` is the section `_leases`), so a
		// per-turn `record()` is cheap -- but a storm-time rescue can carry several held
		// placeholders, and there is no reason to re-index the map for each. Indexed by
		// turnId below, exactly as `record` would have.
		var leaseSnap = (window.DaimondLease && DaimondLease.snapshot) ? DaimondLease.snapshot() : null;
		var turns = Object.keys(_dispatchedIx);
		for (var ti = 0; ti < turns.length; ti++) {
			var chat = byId[_dispatchedIx[turns[ti]]];
			// A DAIMON turn nets here too (#12 dropped the daimon exclusion from the
			// dispatch path but left it here, so a daimon dispatched to a peer that never
			// claimed it just hung -- recoverOneLocally -> runErrand(allowSelf) already
			// handles a daimon chat, so recovery-on-return must not skip it).
			if (!chat || !chat.messages) continue;
			for (var j = 0; j < chat.messages.length; j++) {
				var m = chat.messages[j];
				if (!m || m.why !== DaimondPeer.REASON_DISPATCHED || String(m.iturn) !== turns[ti]) continue;
				var lease = leaseSnap ? (leaseSnap[String(m.iturn)] || null) : null;
				var fin   = dispatchedTurnFinished(chat, m.iturn);
				if (DaimondPeer.recoverDecision(m, lease, fin, self, now)) jobs.push({ chat: chat, m: m });
				// An end this device settled but did not finish (QA-SUHT-B F4), as the backstop.
				else if (DaimondPeer.endedHere && DaimondPeer.endedHere(lease, self)
					&& String(m.dispatchedBy || '') === String(self)) jobs.push({ chat: chat, m: m, ended: true });
			}
		}
		for (var k = 0; k < jobs.length; k++) {
			// Skip a turn already being recovered locally here (a refused hand-off runs
			// it at once and holds the SELF lease); the wake path must not run it again.
			if (_localRecovering[String(jobs[k].m.iturn)]) continue;
			if (jobs[k].ended) {
				diag('handoff not run', 'turn=' + String(jobs[k].m.iturn) + ' ended here under its settled ending lease: row rebuilt (on return)');
				endTurnNotRun(jobs[k].chat, jobs[k].m, 'ended not run on this device (rebuilt from its lease, found on return)');
				continue;
			}
			// A STEP-AWAY HAND-OFF nobody ran is run here (owner, D-20261009-23: no re-seat to
			// another desktop), under the turn's work claim (`recoverOneLocally`), so a turn
			// another tab of this device is running is not run again. A turn the switch sent
			// that its runner did not take ends "not run" with Retry (rulings §1 l.17), as the
			// backstop ends it (`runDispatchFallback`); it is never run here.
			if (jobs[k].m.stepAway) await recoverOneLocally(jobs[k].chat, jobs[k].m);
			else await endHandOffNotRun(jobs[k].chat, jobs[k].m, 'runner '
				+ (String(jobs[k].m.toDevice || '').slice(0, 8) || '?') + ' never claimed it (found on return)',
				placeholderNotRun(jobs[k].m) || notRunCause('unclaimed', jobs[k].m.toDevice, jobs[k].m.toName));
		}
	} finally { pg._recovering = false; }
}

// ── Fix B: the dispatcher-side recovery-timer backstop ─────
//
// After the phone hands a turn off, nothing recovers it while the tab stays
// FOREGROUND: recovery-on-return fires only on a visibilitychange, and the
// no-peer-awake deadline is ~15 minutes away. So a hand-off to a peer that never
// claims (a phantom background tab; or a genuine peer that then stalls) leaves the
// spinner on "Sent to your other devices" for the whole deadline while the owner
// watches (owner report 2026-09-06). This arms ONE short timer per dispatch: about
// one freshness window on (DISPATCH_FRESH_MS + 5 s ~ 95 s), by which a genuine peer
// would have claimed, run it HERE if none did. It is the LAST-RESORT backstop, not
// the preferred path -- the phone being the least reliably connected device -- so it
// fires only when no peer took the turn. Money-safe: it goes through the SAME
// recoverOneLocally -> runErrand({allowSelf}) take-if-vacant lease, so a peer that
// DID claim in the meantime wins the merge and this device stands down.
var _dispatchFallbackTimers = Object.create(null);

// Nominee dispatch timing (send-time, maybeAutoDispatch).
export var NOMINEE_REFRESH_CAP_MS = 4000;		// how long a stale nominee's presence refresh may block the send
export var NOMINEE_TRUST_MS       = 300000;	// presume a set nominee live this long when the refresh could not confirm it
export var PRESUMED_FALLBACK_MS   = 12000;		// tight backstop when a nominee was seated UNCONFIRMED (presumed live)
export var PRESENCE_READ_CAP_MS   = 2000;		// the send-time and collect-time presence read (HT2 M1)

/// THE SEND-TIME READ (HT2 M1, design 2.6). Against a gateway that derives presence, a
/// send that could hand off reads presence first, bounded at PRESENCE_READ_CAP_MS, and
/// decides on what it read. The fresh snapshot, or null where the read did not land in
/// time or failed: no read, and the turn stays Here rather than going on a guess.
export async function sendPresenceRead() {
	var landed = false;
	try {
		await Promise.race([
			Promise.resolve(DaimondSync.refreshPresence()).then(function (j) { landed = !!(j && j.presence); }),
			new Promise(function (r) { setTimeout(r, PRESENCE_READ_CAP_MS); }),
		]);
	} catch (e) { landed = false; }
	if (landed) return (window.DaimondPresence && DaimondPresence.snapshot()) || {};
	// NOT LANDED IS UNKNOWN, a timeout as much as a failure (QA-HT-B F1): `refreshPresence`
	// marks the map lost only on a non-200 or a throw, so a read still in flight at the cap
	// left the switch drawing the runner the send could not confirm. Marked here, so the
	// switch redraws to Here on `daimond:presence` until a read lands.
	try { if (window.DaimondPresence && DaimondPresence.lost) DaimondPresence.lost(); }
	catch (e) { /* the switch keeps what it drew */ }
	return null;
}

/// Arm the recovery backstop for one dispatched turn. Idempotent per turn.
/// `fastMs` (optional) shortens the wait for a turn seated on a PRESUMED-live
/// nominee (an unconfirmed snapshot): if that nominee was in fact asleep it never
/// claims, so recover locally in seconds rather than after a full freshness window.
export function scheduleDispatchFallback(chatId, turnId, fastMs) {
	var tid = String(turnId || '');
	if (!tid || _dispatchFallbackTimers[tid]) return;
	var wait = (fastMs != null) ? fastMs
		: ((window.DaimondPeer && DaimondPeer.DISPATCH_FRESH_MS) || 90000) + 5000;
	_dispatchFallbackTimers[tid] = setTimeout(function () {
		delete _dispatchFallbackTimers[tid];
		runDispatchFallback(chatId, tid);
	}, wait);
}

// Turns a runner handed back (`undeliverable`) whose local run has not started, by
// turnId -> chatId. The runner releases its lease just AFTER the report, so the first
// decision can still see its claim live; this is re-decided on every lease change.
var _handBack = Object.create(null);

/// Vacate the claim a hand-back report names, on the device the turn was sent from.
/// Never throws: a reclaim that could not land leaves the hold, its re-drive and the
/// backstop as they were.
async function reclaimHandBack(report) {
	try {
		if (!report || !report.by || !window.DaimondLease || !DaimondLease.reclaim) return;
		if (String(report.to || '') !== String(selfDeviceId())) return;
		var res = await DaimondLease.reclaim(String(report.turnId), report.by, report.eid,
			DaimondPeer.syncCas(peerSyncShim()));
		diag('handoff handback reclaim', 'turn=' + report.turnId + ' holder='
			+ String(report.by).slice(0, 8) + ' ' + (res && res.ok ? 'vacated' : 'left: ' + ((res && res.why) || '?')));
	} catch (e) { /* the hold and the backstop remain */ }
}

/// Re-decide every held hand-back whose runner's lease no longer reads live here.
/// Local reads only: the fallback's own pull adopts the lease door and lands here
/// again, so a turn still held by its runner is skipped without a network call.
function redriveHandBacks() {
	Object.keys(_handBack).forEach(function (tid) {
		if (_localRecovering[tid]) return;
		var lease = null;
		try { lease = DaimondLease.record(tid); } catch (e) { lease = null; }
		var held = DaimondPeer.dispatchState({ why: DaimondPeer.REASON_DISPATCHED }, lease, selfDeviceId(), leaseClockNow());
		if (held === 'peer-held') return;
		diag('handoff handback redrive', 'turn=' + tid + ' the runner\'s lease no longer holds it');
		try { runDispatchFallback(_handBack[tid], tid); } catch (e) { /* the backstop remains */ }
	});
}

/// RE-DERIVE THE HAND-OFF'S TAB MEMORY AT BOOT (hand-off QA F6, 2026-09-25). `_handBack`
/// and the backstop timers live in the tab, and a report is collected and acknowledged
/// once, so a reload between a runner's hand-back and its release left "Sent to your
/// other devices" with nothing to run the turn until its deadline. Once the first pull
/// has read the lease door, every turn this device sent that is neither settled nor past
/// its deadline gets its backstop back with the time it had left. One whose runner let
/// go without settling it is re-decided now; one a runner still holds is re-decided when
/// that lease moves (`redriveHandBacks`), as a held hand-back is.
var _bootRearmed = false;
async function rearmDispatchedAtBoot() {
	if (_bootRearmed) return;
	_bootRearmed = true;
	try {
		if (!window.DaimondPeer || !DaimondPeer.recoverDecision || !window.DaimondLease) return;
		try { await ensureDispatchedResident(); } catch (e) { /* the resident ones still count */ }
		var self = selfDeviceId(), now = Date.now();
		var wait = (DaimondPeer.DISPATCH_FRESH_MS || 90000) + 5000;
		Object.keys(_dispatchedIx).forEach(function (tid) {
			var chat = dispatchedChat(tid);
			var m = chat && chat.messages ? dispatchedPlaceholderIn(chat, tid) : null;
			if (!m || String(m.dispatchedBy || '') !== String(self)) return;
			if (dispatchedTurnFinished(chat, tid) || DaimondPeer.handoffExpired(m, now)) return;
			var lease = null;
			try { lease = DaimondLease.record(tid); } catch (e) { lease = null; }
			var sent = +m.ts || now;
			scheduleDispatchFallback(chat.id, tid, Math.max(1000, sent + wait - now));
			var st = DaimondPeer.dispatchState(m, lease, self, now);
			var letGo = !!lease && lease.mode === 'released' && !DaimondPeer.settledLease(lease);
			if (st !== 'peer-held' && !letGo) return;
			_handBack[tid] = String(chat.id);
			diag('handoff boot rearm', 'turn=' + tid + ' ' + (letGo ? 'released unsettled: re-decided now' : 'held: re-decided on its release'));
			if (letGo) { try { runDispatchFallback(chat.id, tid); } catch (e) { /* the backstop remains */ } }
		});
	} catch (e) { /* the backstop of a later send and the deadline remain */ }
}

/// Clear a turn's backstop timer -- its answer arrived, or it was taken back.
function clearDispatchFallback(turnId) {
	var tid = String(turnId || '');
	if (_dispatchFallbackTimers[tid]) { try { clearTimeout(_dispatchFallbackTimers[tid]); } catch (e) {} delete _dispatchFallbackTimers[tid]; }
}

/// The backstop body: learn server truth (a peer's claim or answer), then, if the
/// turn is STILL dispatched, NOT finished, and NOT held by a live foreign lease, run
/// it locally through the same money-safe lease as recovery-on-return.
/// Put a runner's hand-back on the placeholder of a turn this device sent (r545, Q19).
/// The runner joins `triedDevices` and `handedBack`, which a re-dispatch's errand
/// carries (`tried`), so a busy runner does not hold the row for it again. A BUSY runner is the cause the tile names if
/// the turn then runs here (`busyBy`, read by `dropDispatchedPlaceholder`). On the
/// placeholder rather than in the tab, so a reload keeps all three.
function noteHandBack(report) {
	try {
		var tid  = String(report.turnId || '');
		var chat = dispatchedChat(tid);
		var m    = chat ? dispatchedPlaceholderIn(chat, tid) : null;
		if (!m || String(m.dispatchedBy || '') !== String(selfDeviceId()) || !report.by) return;
		var tried  = DaimondPeer.triedAfterHandBack(m.triedDevices, report);
		var handed = DaimondPeer.triedAfterHandBack(m.handedBack, report);
		var busy   = (report.status === 'busy' || report.busy > 0) ? String(report.by) : '';
		var thread = report.cause === 'thread' ? String(report.by) : '';	// D2
		// THE CAUSE, KEPT ON THE PLACEHOLDER (QA-HT-B F3): a `models-behind` hand-back ends the
		// turn "not run" (`runDispatchFallback`), and a reload between the report and that
		// decision must still know it.
		var cause  = report.cause ? String(report.cause) : '';
		var was    = JSON.stringify([m.triedDevices || [], m.handedBack || [], m.busyBy || '', m.threadBy || '', m.handBackCause || '']);
		m.triedDevices = tried;
		m.handedBack   = handed;
		if (busy) m.busyBy = busy;
		if (thread) m.threadBy = thread;
		if (cause) m.handBackCause = cause;
		// A busy runner's hand-back no longer runs the turn here: it ends "not run" with
		// Retry (`runDispatchFallback`), so no "ran here" line goes on the prompt.
		if (JSON.stringify([m.triedDevices, m.handedBack, m.busyBy || '', m.threadBy || '', m.handBackCause || '']) === was) return;
		touchMsg(m);
		try { touchChat(chat); persistChats(); }
		catch (e) { /* the in-memory record still guides a re-dispatch */ }
		diag('handoff handback noted', 'turn=' + tid + ' by=' + String(report.by).slice(0, 8)
			+ ' handedBack=' + handed.length + (busy ? ' busy' : '') + (thread ? ' thread' : '')
			+ (report.cause && report.cause !== 'thread' ? ' cause=' + report.cause : ''));
	} catch (e) { /* the hand-back still runs the turn here */ }
}

var _fallbackInFlight = Object.create(null);	// turn id -> a runDispatchFallback awaiting its reads
var _handBackCause    = Object.create(null);	// turn id -> a hand-back's cause, should the placeholder miss it
export var _abiRefused       = Object.create(null);	// turn id -> its report or a frame was below the page's min (OWNKEY H3, A2)

/// End a turn whose runner's report is below the page's min (OWNKEY H3, A2): nothing of it is
/// applied. On the device that sent it, the turn goes down the hand-back path with cause `abi`
/// (`runDispatchFallback`), as a refused report always has, and ends as the visible "not run" row
/// with Retry, whose mid is the turn's on every device. What was drawn of it is taken down first
/// (`dropRefusedTiles`).
function refuseAbiTurn(tid, chatId, rep) {
	_abiRefused[tid] = true;
	peerReports[tid] = Object.assign({}, rep, { status: 'undeliverable', cause: 'abi', why: '' });
	delete _openAsk[tid];
	_handBackCause[tid] = 'abi';
	_handBack[tid] = String(chatId || '');
	var rc = null;
	for (var ci = 0; ci < pg.chats.length; ci++) if (pg.chats[ci] && pg.chats[ci].id === _handBack[tid]) { rc = pg.chats[ci]; break; }
	if (!rc) rc = dispatchedChat(tid) || chatHoldingTurn(tid);
	if (dropRefusedTiles(rc, tid)) {
		touchChat(rc);
		try { persistChats(); } catch (e) { /* the not-run row persists it */ }
		if (pg.current && pg.current.id === rc.id && ownsChat(rc)) { try { renderHistory(rc.messages); } catch (e) { /* the next draw */ } }
	}
	var ph = rc ? dispatchedPlaceholderIn(rc, tid) : null;
	if (ph && String(ph.dispatchedBy || '') !== String(selfDeviceId())) {
		delete _handBack[tid];
		endTurnNotRun(rc, ph, handBackNote('abi', deviceNameFor(ph.toDevice)));
		return;
	}
	try { runDispatchFallback(_handBack[tid], tid); } catch (e) { /* the lease re-drive and the backstop remain */ }
}

/// Take down what was drawn for a turn whose report was refused (`abi`): its provisional
/// rows, so the "not run" row is the turn's only ending. The placeholder stays for `endTurnNotRun` to replace. Did any go?
/// The caller draws and persists.
function dropRefusedTiles(chat, tid) {
	delete _progressView[tid];
	if (!chat || !chat.messages) return false;
	var kept = chat.messages.filter(function (x) {
		return !(x && String(x.iturn || '') === tid && x.role !== 'user' && x.why !== 'dispatched'
			&& x.provisional);
	});
	if (kept.length === chat.messages.length) return false;
	chat.messages = kept;
	return true;
}

/// The cause a dispatched placeholder `m` carries, as a `notRunCause`: its runner's hand-back
/// cause (a busy runner's and a thread hand-back's by their own marks), or null. For an ending
/// rebuilt from a lease or found on return, where the caller knows no more than the record.
function placeholderNotRun(m) {
	if (!m) return null;
	var c = m.busyBy ? 'busy' : (m.threadBy ? (m.overDoor ? 'door' : 'thread')
		: String(m.handBackCause || _handBackCause[String(m.iturn || '')] || ''));
	return notRunCause(c, m.toDevice, m.toName, (peerReports[String(m.iturn || '')] || {}).why);
}

/// Give a sent turn its "not run" ending and drop its placeholder (QA-SUHT-B F4). The row is
/// `answerUnhanded`'s, which adds nothing where the turn already has a row of its own past
/// its prompt (a journal-recovered partial, say); that row is then the turn's ending, so the
/// placeholder goes either way and never stands as "not run" with no control. Idempotent.
function endTurnNotRun(chat, m, why, nr) {
	var tid = String((m && m.iturn) || '');
	if (!chat || !tid) return;
	if (_abiRefused[tid]) dropRefusedTiles(chat, tid);	// `answerUnhanded` draws and persists
	var cause = nr || placeholderNotRun(m);
	answerUnhanded(chat, tid, String(m.itext || ''), { ok: false, why: why, nr: cause });
	// The turn's one `end` (design §5): not_run with its reason, in its chat's log, for every
	// device. The hand-off's not-run, the `abi` refusal and the backstop's fallback all end
	// here; first end wins.
	logEnd(chat.id, tid, notRunEnd(why, cause)).catch(function () { /* the outbox keeps it */ });
	var ended = (chat.messages || []).some(function (x) {
		return !!x && String(x.iturn || '') === tid && x.role !== 'user' && x.why !== 'dispatched';
	});
	if (!ended) return;
	try { dropDispatchedPlaceholder(tid); } catch (e) { /* the row stands either way */ }
	try { clearDispatchFallback(tid); } catch (e) { /* the timer finds no placeholder */ }
}

/// The plain note a hand-back leaves on the chat for `cause` (`thread`, `door` for a session
/// sent as a reference, `limits`, `abi` for a report this page would not apply, or `keys` and
/// `oversize`, an answer too large to send back whole, which keep the runner's own words `why`),
/// naming the device it was sent to, or "another device" where its name is not known.
function handBackNote(cause, name, why) {
	var n = name || t('devices.another');
	return cause === 'limits' ? t('chat.handback_old_page', { name: n })
		: cause === 'door' ? t('chat.handback_too_big', { name: n })
		: cause === 'abi' ? seatReason({ k: 'runner_engine', vars: { name: n } }).why
		: ((cause === 'keys' || cause === 'oversize') && why) ? String(why)
		: t('chat.handback_long', { name: n });
}

/// Book a runner's report to each own-key source's pool (OWNKEY §5.4): one ledger entry per
/// source in `cost.by` that is not credits (the gateway meters those), with the model of the
/// half on that source. The ledger's key (`ts`, `turnId`, source) makes a repeat harmless.
/// The count booked.
function bookReportCost(rep) {
	var by = rep && rep.cost && rep.cost.by;
	var ran = (rep && rep.cost && rep.cost.models && typeof rep.cost.models === 'object') ? rep.cost.models : null;
	if (!by || typeof by !== 'object' || !window.DaimondLedger) return 0;
	var chat = null;
	for (var i = 0; i < pg.chats.length; i++) if (pg.chats[i] && pg.chats[i].id === String(rep.chatId || '')) { chat = pg.chats[i]; break; }
	var m = null;
	try { m = chat ? errandModelOf(chat) : null; } catch (e) { m = null; }
	var credits = (window.DaimondModels && DaimondModels.CREDITS) || 'credits';
	var n = 0;
	Object.keys(by).forEach(function (pid) {
		var usd = +by[pid];
		if (pid === credits || !(usd > 0)) return;
		// The model the turn ran on that source, as the runner says (`cost.models`); only a
		// report without it falls back to the chat's model now, which a switch since may have moved.
		var half = [m, m && m.workers, m && m.images].filter(function (h) { return h && h.provider === pid && h.model; })[0];
		var model = (ran && typeof ran[pid] === 'string' && ran[pid]) ? ran[pid] : (half ? String(half.model) : '');
		try {
			DaimondLedger.record({ ts: +rep.ts || Date.now(), model: model, provider: pid,
				costUsd: usd, turnId: String(rep.turnId || '') });
			n++;
		} catch (e) { /* the ledger is best-effort */ }
	});
	return n;
}

/// END A SENT TURN "NOT RUN" RATHER THAN RUN IT HERE (rulings §1 l.17; QA-HT-B F3). For a
/// turn the switch sent to a runner that did not take it -- withdrawn on loss (HT2 M9), or
/// handed back `models-behind` -- after `recoverDecision` found no live foreign lease and no
/// answer. The turn's lease is first taken here and settled, so the errand still in the box
/// can never run late on the runner beside the person's Retry; then the "not run" row is
/// written (`answerUnhanded`) and the placeholder goes. A take a runner's claim won leaves
/// the turn to that runner; a door that could not be read decides nothing and looks again.
///
/// THE TAKE SAYS WHY IT IS HELD (SUHT-I9). Read as a run, the asker's own claim drew
/// "iphone is picking this up." with Stop for the 3.5 s before the row, here and on every
/// device the lease synced to. So the take carries `intent: 'end'` (`DaimondPeer.endingLease`),
/// and this device marks the turn as ending (`_localEnding`) before its first await: from
/// the first frame to the row, every runner reader reads nobody's run.
export async function endHandOffNotRun(chat, m, why, nr) {
	var tid = String((m && m.iturn) || '');
	if (!tid || _localRecovering[tid]) return;
	_localRecovering[tid] = String(chat.id || '') || true;
	_localEnding[tid] = true;
	var claim = null;
	try {
		claim = await claimTurnHere(tid);
		if (!claim) { diag('handoff not run stand-down', 'turn=' + tid + ' a run of it is under way on this device'); return; }
		if (window.DaimondLease && DaimondLease.take && window.DaimondPeer && DaimondPeer.syncCas && DaimondPeer.settleLease) {
			var self = selfDeviceId();
			var cas  = DaimondPeer.syncCas(peerSyncShim());
			var took = await DaimondLease.take(tid, { holder: self, ts: Date.now(), intent: 'end' }, cas, leaseClockNow);
			if (!took || !took.won) {
				var tw = String((took && took.why) || '?');
				diag('handoff not run stand-down', 'turn=' + tid + ' lease ' + tw + ' holder=' + String((took && took.holder) || '').slice(0, 8));
				if (DaimondPeer.standDownUndecided && DaimondPeer.standDownUndecided(tw)) {
					try { scheduleDispatchFallback(chat.id, tid, UNDECIDED_RECOLLECT_MS); } catch (e) { /* recovery-on-return still nets it */ }
				}
				return;
			}
			// THE ROW BEFORE THE SETTLE (QA-SUHT-B F4). The take won, so the turn is this
			// device's to end: its ending is written and persisted first, so a tab that dies
			// between here and the settle leaves the row, and one that dies after the settle
			// leaves an `ending` lease the backstop and recovery-on-return finish from
			// (`DaimondPeer.endedHere`).
			diag('handoff not run', 'turn=' + tid + ' ' + why);
			endTurnNotRun(chat, m, why, nr);
			try {
				await DaimondPeer.settleLease('turn', tid, self, 'done', cas, leaseClockNow);
				await DaimondPeer.settleLease('turn', tid, self, 'released', cas, leaseClockNow);
			} catch (e) { /* the lease ages out at its deadline */ }
			return;
		}
		diag('handoff not run', 'turn=' + tid + ' ' + why);
		endTurnNotRun(chat, m, why, nr);
	} finally {
		if (claim) claim.release();
		delete _localRecovering[tid];
		delete _localEnding[tid];
		redrawRunner();
		// The turn is ended, or another device ends it: what waited behind it goes (QA ccp2 M1).
		try { drainAfterHeld(chat); } catch (e) { /* the queue stays, badged */ }
	}
}

/// `opts.notRun` (a reason): the turn this device sent is withdrawn (HT2 M9), so where the
/// backstop would run it here it ends "not run" instead (`endHandOffNotRun`).
async function runDispatchFallback(chatId, turnId, opts) {
	var tid = String(turnId || ''), mine = false;
	try {
		if (!window.DaimondPeer || !DaimondPeer.recoverDecision || !DaimondPeer.runErrand) return;
		// ONE AT A TIME PER TURN. The backstop timer and a withdrawal on loss (HT2 M9) can
		// both arrive while the other awaits its reads; a second run would then find this
		// device's own fresh claim, which `runErrand` reads as a re-take and ends Interrupted.
		if (_fallbackInFlight[tid]) return;
		_fallbackInFlight[tid] = mine = true;
		// Collect the post box and read the lease door first, so a peer's answer (post) or
		// claim (lease) is seen before the decision.
		//
		// THE LEASE DOOR ALONE, OFF THE ROUND GATE (U2FIX, rig r572w modelunrun). This was a
		// whole `DaimondSync.pull()`, which waits out any sync round in flight, up to its 18 s
		// bound: a turn handed back by a runner that could not run its models waited 9.3 s
		// behind this device's own push before it ran here. The decision reads only the lease
		// (`recoverDecision`: a live foreign claim, or a settled one) and the chat, so the
		// door's own read is all it needs (`leaseGet`, the read the lease CAS and a lease wake
		// use), adopted as a wake adopts it.
		try { if (window.DaimondPost && DaimondPost.collect) await DaimondPost.collect(); } catch (e) { /* offline */ }
		await leaseDoorRead();	// unread or offline: the lease view this device holds decides
		var chat = null;
		for (var i = 0; i < pg.chats.length; i++) if (pg.chats[i] && pg.chats[i].id === chatId) { chat = pg.chats[i]; break; }
		// A report-driven call may carry no/empty chatId; resolve by the turn's
		// dispatched-placeholder index instead.
		if (!chat) { try { chat = dispatchedChat(tid); } catch (e) { chat = null; } }
		// Same daimon fix as peerCollectOnReturn above: the backstop must also net an
		// unclaimed daimon dispatch, not early-return and leave it hung forever.
		if (!chat || !chat.messages) { delete _handBack[tid]; return; }
		var m = null;
		for (var j = 0; j < chat.messages.length; j++) {
			var x = chat.messages[j];
			if (x && x.why === DaimondPeer.REASON_DISPATCHED && String(x.iturn) === tid) { m = x; break; }
		}
		if (!m) { delete _handBack[tid]; return; }	// placeholder gone: already answered / dropped
		var lease = (window.DaimondLease && DaimondLease.record) ? DaimondLease.record(tid) : null;
		var fin   = dispatchedTurnFinished(chat, tid);
		// recoverDecision stands down if a peer holds a LIVE foreign lease or the turn
		// is finished -- so a genuine peer that DID claim keeps it; the phone reclaims
		// only a turn nobody ran. dropDispatchedPlaceholder on completion stamps the
		// "Ran here — hand-off to X didn't finish" provenance (seq 207), so the owner
		// can always tell where it ran. A held hand-back stays held while the lease is
		// a peer's: the runner's release is on its way (`redriveHandBacks`).
		if (!DaimondPeer.recoverDecision(m, lease, fin, selfDeviceId(), Date.now())) {
			// AN END THIS DEVICE SETTLED BUT DID NOT FINISH (QA-SUHT-B F4): its own `ending`
			// lease, settled, beside the placeholder of a turn it sent. The tab died after the
			// take; the row is rebuilt from the lease and the placeholder goes. Nothing runs:
			// an ending lease is nobody's run (SUHT-I9).
			if (DaimondPeer.endedHere && DaimondPeer.endedHere(lease, selfDeviceId())
				&& String(m.dispatchedBy || '') === String(selfDeviceId()) && !_localRecovering[tid]) {
				delete _handBack[tid];
				diag('handoff not run', 'turn=' + tid + ' ended here under its settled ending lease: row rebuilt');
				endTurnNotRun(chat, m, 'ended not run on this device (rebuilt from its lease)');
				return;
			}
			// A HAND-BACK UNDER A SETTLED LEASE IS NOT RUN, AND SAYS SO (SEND-UNHANDED, r4a6
			// fault B). The runner reported it could not take the turn, but its claim settled
			// (`done`) on the way out, which reads as finished here: no answer is coming, so the
			// turn ran nowhere. It ends in the "not run" row with Retry, as a refusal before the
			// mark does, and the placeholder goes, so the row is the turn's one ending.
			if (_handBack[tid] != null && DaimondPeer.settledLease && DaimondPeer.settledLease(lease)
				&& String(m.dispatchedBy || '') === String(selfDeviceId()) && !dispatchedAnswerPresent(chat, m)) {
				delete _handBack[tid];
				diag('handoff handback settled', 'turn=' + tid + ' handed back under a settled lease: not run');
				// A report refused after the runner ran (`abi`), or an answer it could not send
				// back whole (`oversize`, PIPE_MAX), settled its lease: its line says why.
				var sc = String(m.handBackCause || _handBackCause[tid] || '');
				endTurnNotRun(chat, m, (sc === 'abi' || sc === 'oversize')
					? handBackNote(sc, deviceNameFor(m.toDevice), (peerReports[tid] || {}).why)
					: 'handed back under a settled lease');
				return;
			}
			// Held only for a turn this device sent: no other device will run it.
			if (String(m.dispatchedBy || '') !== String(selfDeviceId())
				|| DaimondPeer.dispatchState(m, lease, selfDeviceId(), leaseClockNow()) !== 'peer-held') delete _handBack[tid];
			else if (_handBack[tid] != null) diag('handoff handback held', 'turn=' + tid + ' the runner\'s lease still reads live here');
			return;
		}
		delete _handBack[tid];
		// Stand down while a local recovery of this turn is already in flight: a refused
		// hand-off recovers locally at once (dispatchToPeer -> recoverOneLocally) and holds
		// the lease as SELF for the whole run, so the +95s backstop would otherwise run
		// the still-running turn a second time. `_localRecovering` is the synchronous "this device is running that turn"
		// set; the lease stays the cross-device arbiter.
		if (_localRecovering[tid]) return;
		// A TURN THE SWITCH SENT THAT ITS RUNNER DID NOT TAKE ENDS "NOT RUN" (rulings §1 l.17,
		// QA-HT-B F3): withdrawn because its runner stopped listening, or handed back because
		// the runner had not reached this device's models by the deadline. Never run here.
		//
		// AND A RUNNER'S REFUSAL BEFORE THE RUN (kfix f94184180, E-PORT): it hands the lease
		// back (`LeaseAct::HandBack`), which reads `released`, unsettled, `cut: 'refused'`,
		// never `done`, so `settledLease` is false and `recoverDecision` lets it through. The
		// runner said it did not run the turn: it ends "not run" the same way.
		//
		// THE REFUSAL KEEPS ITS WORDS (RUN-HIST E): a runner's hand-back with cause `refused`
		// carries why ("argonaut has no model key
		// for this turn: ..."), and the row says it.
		var hbCause = String(m.handBackCause || _handBackCause[tid] || '');
		var refRep  = peerReports[tid];
		var refWhy  = (refRep && refRep.why) ? ': ' + String(refRep.why) : '';
		var notRun = (opts && opts.notRun) ? String(opts.notRun)
			: (hbCause === 'models-behind' ? 'handed back: the runner had not reached this turn\'s models'
			: ((hbCause === 'refused' || (lease && lease.mode === 'released' && String(lease.cut || '') === 'refused')) ? 'the runner refused it before the run' + refWhy : ''));
		if (notRun) {
			var nrc = (opts && opts.notRun) ? String(opts.cause || '') : (hbCause === 'models-behind' ? hbCause : 'refused');
			await endHandOffNotRun(chat, m, notRun, notRunCause(nrc, m.toDevice, m.toName, refRep && refRep.why));
			return;
		}
		// A STEP-AWAY HAND-OFF (`stepAway`) is a turn already running here that this device
		// handed on as it went to the background; the switch did not send it. One its runner
		// did not take is run here (owner, D-20261009-23), never re-seated on another desktop.
		// Money-safe: recoverDecision above confirmed no live foreign lease holds it, and the
		// run takes the turn's work claim, so a sibling tab running it stands this down (F1).
		if (m.stepAway) { await recoverOneLocally(chat, m); return; }
		// EVERY OTHER TURN THE SWITCH SENT ENDS "NOT RUN" TOO (rulings §1 l.17 as extended: one
		// ending for every turn the switch sent that its runner did not take). A busy runner,
		// a runner that could not take the thread or run the models, and a runner that never
		// claimed it within the backstop window (D-20261009-23: "If argonaut is selected, it
		// runs there") each leave the "not run" row with Retry; none runs here.
		var rn    = String(m.toDevice || '').slice(0, 8) || '?';
		var cause = String(m.handBackCause || _handBackCause[tid] || '');
		if (m.busyBy) { await endHandOffNotRun(chat, m, 'handed back: runner ' + String(m.busyBy).slice(0, 8) + ' was busy'); return; }
		// THE TWO HAND-BACKS THE PERSON CAN ACT ON say why in plain words, naming the device
		// (rc ruling, 24 Oct): a chat longer than it can take yet, and a page older than it.
		if (m.threadBy || cause === 'thread') { await endHandOffNotRun(chat, m, handBackNote(m.overDoor ? 'door' : 'thread', deviceNameFor(m.toDevice))); return; }
		if (cause === 'limits') { await endHandOffNotRun(chat, m, handBackNote('limits', deviceNameFor(m.toDevice))); return; }
		// OWNKEY: a report this page would not apply (`abi`), and sealed keys that would not
		// open there (`keys`, in the runner's own words): "not run" with Retry, never run here.
		if (cause === 'abi' || cause === 'keys' || cause === 'oversize') {
			await endHandOffNotRun(chat, m, handBackNote(cause, deviceNameFor(m.toDevice), refRep && refRep.why)); return;
		}
		if (cause === 'models') { await endHandOffNotRun(chat, m, 'handed back: runner ' + rn + ' could not run this turn\'s models'); return; }
		await endHandOffNotRun(chat, m, cause ? 'handed back by runner ' + rn + ': ' + cause
			: (lease && lease.mode === 'released') ? 'runner ' + rn + ' let it go unrun'
			: 'runner ' + rn + ' never claimed it within the backstop window',
			placeholderNotRun(m) || notRunCause((lease && lease.mode === 'released') ? 'released' : 'unclaimed', m.toDevice, m.toName));
	} catch (e) { /* the 15-min deadline + [Run here] remain the ultimate backstop */ }
	finally { if (mine) delete _fallbackInFlight[tid]; }
}

/// WITHDRAW ON LOSS (HT2 M9, design 2.6). On each presence change: a turn this device
/// handed to a runner that has since stopped listening, with no claim on it, is taken
/// back now through the backstop's own path (`runDispatchFallback`: the lease door read,
/// then `endHandOffNotRun`, which takes the lease by CAS and settles it), never by taking
/// the lease first. A runner's claim that landed first wins the CAS and the turn runs
/// there. Otherwise the turn ends "not run" with Retry, never run here (rulings §1 l.17,
/// QA-HT-B F3). The backstop timer stays armed behind it.
export function withdrawLostHandoffs() {
	if (!window.DaimondPeer || !DaimondPeer.withdrawOnLoss) return;
	var snap = (window.DaimondPresence && DaimondPresence.snapshot()) || {};
	var self = selfDeviceId(), now = Date.now();
	Object.keys(_dispatchedIx).forEach(function (tid) {
		if (_fallbackInFlight[tid] || _localRecovering[tid]) return;
		var chat = dispatchedChat(tid);
		var m    = chat ? dispatchedPlaceholderIn(chat, tid) : null;
		if (!m) return;
		var lease = (window.DaimondLease && DaimondLease.record) ? DaimondLease.record(tid) : null;
		if (!DaimondPeer.withdrawOnLoss(m, lease, snap[String(m.toDevice)], self, now, turnView(chat, tid))) return;
		diag('handoff withdraw', 'turn=' + tid + ' runner ' + String(m.toDevice).slice(0, 8) + ' stopped listening unclaimed');
		runDispatchFallback(chat.id, tid, { notRun: 'withdrawn: runner ' + String(m.toDevice).slice(0, 8) + ' stopped listening, unclaimed', cause: 'gone' });
	});
}

/// Start LISTENING for dispatched errands: park on the gateway's Post channel and
/// collect once now. Until this, a device only parked while the Social panel was
/// open (post.js `onOpen`), so a genuinely-awake peer that beat presence NEVER
/// received an errand -- presence said "available" while nothing was listening,
/// which is the live "no peer ran it" failure. An awake device that beats
/// presence must also be reachable for the errand that beat invites; idempotent,
/// self-disabling when not entitled, so it is safe to call on every unlock.
function startErrandListener() {
	// A REMOVED DEVICE HAS NOTHING TO LISTEN FOR. The gateway refuses its park and
	// its beat (owner ruling 2026-09-12), so re-arming on every unlock and every
	// return to the foreground would be a loop against a door that is never going to
	// open. `post.js` sticks its own stop for the same reason; this is the other end
	// of it, so nothing re-arms what that stopped.
	try { if (window.DaimondSync && DaimondSync.removedSelf && DaimondSync.removedSelf()) return; }
	catch (e) { /* cannot tell: arm as before */ }
	try { if (window.DaimondPost && DaimondPost.parkStart) DaimondPost.parkStart(); } catch (e) { /* no transport */ }
	try { if (window.DaimondPost && DaimondPost.collect) DaimondPost.collect(); } catch (e) { /* offline */ }
}
// page-split: install 30

// ── THIS DEVICE WAS REMOVED ─────────────────────────────────
//
// Owner ruling 2026-09-12: "Remove device" must REALLY remove -- the gateway
// refuses that id for presence and for wake, and the device sees "this device was
// removed from the account" at its next beat and LOCKS.
//
// Pairing copies the account keypair whole, so the removal cannot be enforced BY
// the removed device: it is enforced AT the gateway, and what happens here is the
// device finding out. What it then does is the honest consequence -- close the
// session, wipe this account's key material, and say so. After that the device
// holds no key for the account and has to be paired again, which is exactly what
// the notice tells the person holding it.
//
// LATCHED in sync.js (`notedRemoval`), so a second door answering the same way
// raises nothing further; idempotent here regardless.
var _removedHandled = false;
async function onThisDeviceRemoved() {
	if (_removedHandled) return;
	_removedHandled = true;
	diag('device removed', 'self=' + String(selfDeviceId()).slice(0, 8));
	// The session FIRST, while there is still a key here to close it with -- the
	// order the forget-me path keeps, and for the same reason.
	try { if (window.DaimondGateway && DaimondGateway.logout) await DaimondGateway.logout(); }
	catch (e) { /* wipe anyway */ }
	// Stop everything that would go on asking: the errand park, the sync loop.
	try { if (window.DaimondPost && DaimondPost.parkStop) DaimondPost.parkStop('removed'); } catch (e) {}
	// Drop every ciphertext this device holds under the account's key, WHILE
	// the participants can still tell what they hold -- before the key itself
	// goes. The registry runs every registered `purge`; a participant with
	// none (out of this build's scope today, see the handover) simply takes
	// no part, same as one with no `forget`.
	try { if (window.DaimondRekey && DaimondRekey.purgeAll) DaimondRekey.purgeAll(); } catch (e) {}
	// NOT calling DaimondPasskey.remove() here. The plan named it (as
	// `.forget()`, a stale name -- `passkey.js` exports `remove`), but reading
	// it shows it revokes the ACCOUNT'S gateway-held passkey record, not only
	// this device's local copy ("Dropping only the local copy would be a
	// false revocation now that the gateway holds one" -- passkey.js, beside
	// `remove()`). Calling it here would strip passkey unlock from every
	// SURVIVING device over the removal of just this one. Flagged rather than
	// guessed; see the build report.
	// THE KEY MATERIAL for this account, so nothing here can seal, open, sign or
	// claim a lease on it again. `retire` is `reset` plus the "removed" marker
	// the boot gate needs -- see identity.js -- so the device does not come
	// back to the lost-keys recover screen, whose "Try again" can never work
	// for a removal. It locks as it goes, which is the "and locks" half of
	// the ruling.
	try { if (window.DaimondIdentity && DaimondIdentity.retire) DaimondIdentity.retire(); }
	catch (e) { /* the lock below is the fallback */ }
	try { if (window.DaimondIdentity && DaimondIdentity.lock) DaimondIdentity.lock(); } catch (e) {}
	try { noticeDialog(t('devices.removed_self_title'), t('devices.removed_self_body')); }
	catch (e) { /* no dialog: the lock is still the operative half */ }
}
// page-split: install 31

// ── Presence beat + smart auto-dispatch (step 7) ───────────

/// The agentic signal: full-autonomy hand mode means the user runs tool-heavy
/// turns, which are worth offloading. A worker chat is caught by the pure
/// decision itself. Conservative on purpose -- an ordinary quick turn stays
/// local for instant streaming.
export function chatToolsEnabled(chat) {
	try { return !!(window.DaimondHandMode && DaimondHandMode.get && DaimondHandMode.get() === 'bypass'); }
	catch (e) { return false; }
}

/// Is this a phone-sized viewport? On a phone a send auto-routes to an awake
/// persistent peer; on desktop it does not (you are already on the persistent
/// instance). Read through the shell's own 760px signal, so there is one cliff.
export function isPhoneViewport() {
	try { return !!(window.DaimondShell && DaimondShell.isPhone && DaimondShell.isPhone()); }
	catch (e) { return false; }
}

/// Is this MACHINE a phone or tablet? The HARDWARE question, which `isPhoneViewport`
/// is not: that one answers "is the window under 760px", and a desktop window dragged
/// narrow answered yes to it. Decided once at boot from real signals (touch, pointer,
/// UA mobility, standalone PWA -- mobile.js `isMobileDevice`) and beaten to the fleet,
/// so every other device seats this one on what it IS rather than on what it is
/// called. Falls back to the viewport only where the shell is not up.
export function isMobileDeviceSelf() {
	try {
		if (window.DaimondShell && DaimondShell.isMobileDevice) return !!DaimondShell.isMobileDevice();
	} catch (e) { /* fall through */ }
	return isPhoneViewport();
}
// page-split: install 32

export function install() { // page-split: install
	// page-split: install 28
	// Registered on unlock, by which point every peer module is loaded; idempotent,
	// so re-registering on a later unlock simply replaces the handler.
	try { window.addEventListener('daimond:unlock', registerPeerRunner); } catch (e) { /* no window */ }
	// The chat log's taps (P2.3a): sync.js may load after this module, so on unlock too.
	function hearLog() { try { if (window.DaimondSync && DaimondSync.onLog) DaimondSync.onLog(onLogTap); } catch (e) { /* no sync */ } }
	hearLog();
	try { window.addEventListener('daimond:unlock', hearLog); } catch (e) { /* no window */ }
	// An end this device's detector wrote is tapped to the others only (turnwrite.js `landed`):
	// read it here as a tap would. A head of 0 (a 409's) is unknown, so the chat is read.
	try {
		window.addEventListener('daimond:turnlog-landed', function (ev) {
			var d = (ev && ev.detail) || {};
			onLogTap(String(d.chat || ''), +d.head || Number.MAX_SAFE_INTEGER);
		});
	} catch (e) { /* no window */ }
	try { window.addEventListener('daimond:unlock', function () { readLogsAtBoot().catch(function () {}); }); } catch (e) { /* no window */ }
	// The one dead-writer detector asks the reader before it ends a turn (P2.3c1).
	readerEnded(chatLogEnded);
	// page-split: install 29

	/// On return to a foregrounded tab: learn the latest, then RESCUE any orphan.
	///
	/// ONLY ITS OWN, AND ONLY WHILE THE HAND-OFF IS VALID. The index this walks holds
	/// every placeholder synced from every device, and until 2026-09-23 the decision
	/// below asked neither whose turn it was nor how old: gilgamesh re-ran five turns
	/// sent five days earlier, and one of them deleted files in a Diamond nobody was
	/// driving. `recoverDecision` now refuses both; see it in peer.js.
	///
	/// The reported failure is a phone that dispatched a turn no peer ran, then came
	/// back to nothing. This closes it. First collect the post box (a `report` clears
	/// the "waiting" UI) and pull the parcel (a peer's answer and any lease it took),
	/// so the recovery decision reads server truth. Then, for every turn still marked
	/// `dispatched` that is neither finished nor held by a LIVE peer lease, run it
	/// HERE -- through the lease, so if a peer is genuinely on it we stand down. A
	/// backgrounded phone cannot fire the deadline fallback, so this is the fallback.
	/* var */ pg._recovering = false;
	// page-split: install 30
	try { window.addEventListener('daimond:unlock', startErrandListener); } catch (e) { /* no window */ }
	// page-split: install 31
	try {
		window.addEventListener('daimond:device-removed', function () {
			Promise.resolve(onThisDeviceRemoved()).catch(function () {});
		});
	} catch (e) { /* no window */ }
	// A page back from the bfcache or a frozen state has a presence view from before it went,
	// and under the derived truth no beat refreshes it: the display reads once (HT2 M1).
	try {
		/* var */ presenceOnReturn = function () {
			try { if (window.DaimondSync && DaimondSync.refreshPresence) DaimondSync.refreshPresence(); } catch (e) { /* local snapshot stands */ }
		};
		window.addEventListener('pageshow', function (ev) { if (ev && ev.persisted) presenceOnReturn(); });
		document.addEventListener('resume', presenceOnReturn);
	} catch (e) { /* no window */ }
	try {
		document.addEventListener('visibilitychange', function () {
			if (document.visibilityState === 'visible') {
				// The errand listener re-arms on wake, but the 45s presence beat is throttled
				// while hidden, so a woken tab's local view of who is awake can be minutes
				// stale. Kick a presence refresh on wake so consumers of the snapshot see a
				// current map. Belt-and-braces: the collect path also refreshes, awaited,
				// before the money-critical stand-down.
				try { if (window.DaimondSync && DaimondSync.refreshPresence) DaimondSync.refreshPresence(); } catch (e) { /* local snapshot stands */ }
				startErrandListener();
				peerCollectOnReturn();
				// AN ASK RAISED WHILE THIS DEVICE WAS HIDDEN WAS NEVER RAISED. The
				// fail-safe filter `askRaiseDecision` refuses to draw a tile on a device
				// nobody is at (`canAnswer` is false while the page is hidden), and nothing
				// re-asked the question when the person came back -- so an ask collected at
				// the wrong moment was recorded for the badge and never shown. Re-evaluate
				// every still-open ask on return, which is exactly when the answer to
				// "could somebody answer this" has just changed.
				reRaiseOpenAsks();
				// REPAINT WHAT ARRIVED WHILE HIDDEN. A chat that synced into the store while
				// this tab was backgrounded may not have had its in-memory rebuild/render run
				// (a throttled or suspended tab), so it would stay invisible until a manual
				// refresh. Rebuild from the store on return, so the rail and the open transcript
				// reflect what came in while away. Only when a merge actually ran while hidden,
				// so an ordinary tab switch pays nothing.
				if (pg._syncedWhileHidden) {
					pg._syncedWhileHidden = false;
					try { Promise.resolve(onChatsChangedElsewhere()).catch(function () {}); }
					catch (e) { /* the rail is not up yet */ }
				}
			}
		});
	} catch (e) { /* no document */ }
} // page-split: end install

export function install_2() { // page-split: install
	// page-split: install 32

	/* var */ pg._recovering = false;
} // page-split: end install
