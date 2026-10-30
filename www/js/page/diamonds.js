// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { DaimondApp, Wasm } from './wasm.js';
import { TAG_MODE_KEY, crystalRunning, diamondBusy, pg } from './state.js';
import { AUTO_MAX, appCfgFor, dsEvent, maxOutFor, readJson, t, tabViewSet } from './util.js';
import { SWEEP_WAIT_MS, bumpDiamonds, chatMsgCount, chatTaintOf, expireChats, loadChatMessages,
	markChatTainted, msgTombsOwed, msgTombsShipped, newMid, persistChats, touchChat, touchChatModel,
	touchMsg, trashSweep, trashed } from './chatstore.js';
import { newChatId, shortModel } from './parcel_apply.js';
import { endHandOffNotRun, errandFence, leaseClockNow, markTurnDispatched, ownsChat, peerSyncShim,
	selfDeviceId } from './handoff.js';
import { _sharedClients, dedupeSession, sessionDoubt, tailAfter } from './send.js';
import { chatWorkerModel } from './steer.js';
import { readOrigins } from './layout.js';
import { errandModelOf, importModelCounts, ratingsDigest, storedEffort, storedPre, turnEffortOf,
	turnModelOf } from './rating.js';
import { chatNeedsFolder, chatSeatHere, maybeAutoDispatch, notRunCause, seatDrawnRunner } from './sourcemenu.js';
import { diag, toast } from './passkey_phrase.js';
import { askOpenIn, honoursModelSet, isNotRunRow, renderHistory } from './turns.js';
import { autonomousPosture, noticeDialog } from './consent.js';
import { diamondAutomated, repaintPause, turnHold } from './chats.js';
import { chatDisplayName, errandProdBase, noteAppProv, renderSessionList } from './tilestyle.js';
import { Instructions, Notes, Pending, Prompts, SYSTEM_PROMPT, steerRaise } from './pending.js';
import { builtInSlot, renderDiamondList, selectDiamond } from './agentspanel.js';
import { crystalJson, doSteer, runSteer } from './crystal.js';
import { rootHere } from './marks.js';
import { applyCrystalCap, applyEffort, applyFoldSettings, applyLiveness, applyProviderRouting,
	applyRoundLimit, applySight, foldModelFor, setFoldPick } from './settingsui.js';
// page-split: end imports
let _seededBeforeLoad; // page-split: hoisted

// ── A DIAMOND'S OWN FOLDER (HATE-7) ──
//
// An absolute path on its runner, where that Diamond's turns start: sent as the errand's
// `scope.root`, which the runner reads as the start directory (`errand_place`), the
// workspace staying its home. Choosing it never swaps the workspace, so a second Diamond
// keeps its own. Kept on this device, keyed by Diamond id, as `daimond-diamond-models` is.
var DIAMOND_FOLDER_KEY = 'daimond-diamond-folder';	// { diamondId: '/abs/path' }

export function diamondFolder(id) {
	if (!id) return '';
	var all = readJson(DIAMOND_FOLDER_KEY, {}) || {};
	var f = all[id];
	return (typeof f === 'string' && f.charAt(0) === '/') ? f : '';
}

/// '' clears.
export function setDiamondFolder(id, path) {
	if (!id) return;
	var all = readJson(DIAMOND_FOLDER_KEY, {}) || {};
	if (path) all[id] = path; else delete all[id];
	try { localStorage.setItem(DIAMOND_FOLDER_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
}

/// Does a runner that said where it may go reach `path`? Read from every runner row
/// carrying `reach` (gateway HATE-2); true while none does, the runner's own clamp then
/// being the only judge.
export function folderInReach(path, presence) {
	var p = String(path || '').replace(/\/+$/, '') || '/';
	var roots = [];
	Object.keys(presence || {}).forEach(function (id) {
		var r = presence[id];
		if (r && Array.isArray(r.reach)) roots = roots.concat(r.reach);
	});
	if (!roots.length) return true;
	return roots.some(function (r) {
		var b = String(r || '').replace(/\/+$/, '');
		return p === (b || '/') || p.indexOf(b + '/') === 0;
	});
}

/// THE SCOPE A DISPATCHED TURN CARRIES (UNBLOCK-32 F2b): its holds, and, for a turn whose
/// folder is rooted here in a machine folder, that folder's NAME (`usr`, never a path),
/// as `{ root, holds }`, so the runner starts the turn in its own folder of that name and reads
/// relative paths from it. The plain array otherwise, as before; readers take either
/// (`DaimondPeer.scopeHolds`).
///
/// ONE PREDICATE with the switch (F2-FIX M1): the folder is sent exactly where
/// `chatNeedsFolder` makes the turn need one, a plain chat whose workspace holding is opened
/// in the folder as much as a Diamond's mark, so a runner seated for the folder starts in it.
///
/// A Diamond with its own folder (HATE-7) sends that absolute path instead, ahead of all.
export function errandScope(chat, holds) {
	try {
		var own = (chat && chat.diamondId) ? diamondFolder(chat.diamondId) : '';
		if (own) return { root: own, holds: holds };
		if (chatNeedsFolder(chat)) {
			var r = DaimondMarksHere._core.rootOf(rootHere());
			if (r.kind === 'machine' && r.name) return { root: r.name, holds: holds };
		}
	} catch (e) {
		diag('dispatch scope', 'chat=' + (chat && chat.id) + ' ' + String((e && e.message) || e));
	}
	return holds;
}

/// The door itself, called only by `handOffTurn`, the entry: `st.marked` is set the
/// moment the turn's placeholder is written, so the entry can tell a refusal before it.
export async function dispatchToPeer(chat, turnId, promptText, scopePaths, opts, st) {
	diag('dispatch start', 'chat=' + (chat && chat.id) + ' turn=' + turnId
		+ (opts && opts.toName ? ' to=' + String(opts.toId || '').slice(0, 8) : ''));
	// A PERSON'S PAUSE HOLDS A HAND-OFF AS IT HOLDS A TURN RUN HERE (R2 QA, F2). This is
	// the one door every hand-off passes, so it is asked here, before anything is marked
	// or posted: a held turn leaves no placeholder and no errand. `paused` tells the
	// caller to answer it where the person is, as the local run would.
	var hold = turnHold(chat);
	if (hold) {
		diag('dispatch refused', 'turn=' + turnId + ' paused at ' + hold);
		return { ok: false, paused: true, node: hold, why: DaimondModels.pauseError(hold).message };
	}
	if (!window.DaimondPeer || !DaimondPeer.buildDispatch
		|| !window.DaimondPost || !DaimondPost.post
		|| !window.DaimondSync  || !DaimondSync.push) {
		return { ok: false, why: 'the peer transport is not available in this build' };
	}
	// ONLY TO A RUNNER THAT RUNS THE TURN'S SET (D-20261018-09 OR). Every hand-off comes
	// through here, so here the errand is addressed, and only to a device that has shown it
	// honours the model set the errand carries: one before the Models menu runs a following
	// chat on its own default and says nothing. Asked before anything is marked or posted,
	// in the same run as the election that named it; `unable` is answered by the entry: not run, with Retry.
	var runTo = String((opts && opts.runTo) || '');
	if (!honoursModelSet(runTo)) {
		diag('dispatch refused', 'turn=' + turnId + ' runner ' + (runTo ? runTo.slice(0, 8) : 'unnamed')
			+ ' has not shown it runs the model set');
		return { ok: false, unable: true, why: 'no runner here runs this turn on its models' };
	}
	var pause = null;
	try { if (window.DaimondPause) pause = DaimondPause.snapshot(); } catch (e) { pause = null; }
	// This device's stable id, for "waiting for <machine>" and so a peer never
	// claims its own dispatch. The PER-DEVICE id, not the account key: pairing
	// shares the key, so a key-derived `by` could not tell a device from its twin.
	var by = selfDeviceId();
	// The GLOBAL park count this dispatch inherits (0 on a first dispatch, the
	// carried total on a re-run of a parked turn), so the ≤MAX_PARKS respend bound
	// holds across devices.
	var parkCount = (opts && (opts.parkCount | 0)) || 0;
	// THE CHAT'S ENGINE AS IT STANDS BEFORE THE FENCE IS READ, because `errandFence` may drop
	// it and build another, which starts with no mark (U4).
	var heldApp = chat && chat.app;
	var fence = await errandFence(chat, turnId);
	var cleanDia = (opts && opts.diamondId) || (chat && chat.diamondId) || '';
	var dispatchOpts = {
		turnId: turnId,
		// The Diamond this chat belongs to (a daimon chat), so the runner services it
		// through `steer_crystal`. '' for an ordinary chat. Falls back to the chat's own
		// `diamondId` when the caller did not name one.
		diamondId: (opts && opts.diamondId) || (chat && chat.diamondId) || '',
		prompt: promptText,
		// The note the person's message took when it was sent, READ from that record. A
		// re-dispatch, a parked re-run and a recovery all come through here, and none
		// composes one: the model hears what the original send was going to tell it.
		pre: storedPre(chat, turnId),
		// And the Effort it was sent with, read the same way, so a handed-off turn thinks as
		// hard as the person asked when they sent it (D-20261014-08).
		effort: (function () { var e = storedEffort(chat, turnId); return e === null ? turnEffortOf(chat) : e; })(),
		// THE THREAD, taken from the chat as it stands now -- after `maybeAutoDispatch`
		// pushed this turn's user message, so the seed ends at the prompt itself.
		// Built by `buildDispatch` from this same chat; named here only so a caller
		// that has a reason to suppress it (`seed: false`) has somewhere to say so.
		seed:   (opts && opts.seed === false) ? false : undefined,
		// The model the turn runs on, as this device resolved it: the chat's own, or its
		// Diamond's (C3). The url is resolved by the peer from the provider (models.js).
		model:  errandModelOf(chat),
		scope:  errandScope(chat, scopePaths || (Array.isArray(chat.holds) ? chat.holds : [])),
		fence:  fence,
		// THE CHAT HAS READ NOTHING FROM OUTSIDE (U4 ERRAND-TAINT): sent only when that is so,
		// and never as false. The runner reads a missing `clean` as tainted, so it only narrows.
		clean:  errandClean(chat, cleanDia, heldApp) ? true : undefined,
		// THE PACKS THIS ACCOUNT HAS NOT BOUGHT (U13a PACK-CARRY), as this tab holds them: the
		// runner never hears `pushLocks`, and it reads a missing list as every pack locked.
		locked: errandLocked(),
		// THE LIMITS THIS PAGE WOULD RUN THE TURN UNDER (KT-2): the runner applies them, and hands
		// back an errand that carries none rather than guess the model's window.
		limits: errandLimits(chat),
		pause:  pause,
		dispatchedBy: by,
		// THIS device's posture goes with the turn: on the runner it is the asker's
		// word, the only posture that answers the turn's permits there (B-F1).
		auto:   autonomousPosture(),
		tried:  (opts && Array.isArray(opts.handedBack)) ? opts.handedBack : [],	// Q19
		parkCount: parkCount,
		pendingOnly: !!(opts && opts.pendingOnly),	// a mail trigger's turn (§16)
		// The removals no parcel has carried yet, so the errand need not wait on one
		// (UNBLOCK-1), and the device the switch elected, which alone takes the turn.
		// `runTo`, not the tile's `toId`: the tile names the starred nominee, while the
		// election may seat another desk (a nominee busy elsewhere), and a `to` naming
		// the nominee made the elected desk stand down and the nominee bounce the turn.
		gone:   msgTombsOwed(),
		to:     runTo,
	};
	// A THREAD IS NEVER FINGERPRINTED FROM AN UNLOADED CHAT (D2). Every hand-off --
	// a send, a re-dispatch, a parked re-run -- comes through here, so it is made
	// resident here; `buildDispatch` refuses one that is not, and nothing is marked.
	if (chat && chat._loaded === false) {
		try { await loadChatMessages(chat); } catch (e) { /* refused below */ }
	}
	// THE CONVERSATION TRAVELS (KT-4, binding 15): the engine session this page would restore,
	// its reach and its today line, taken once the chat is resident, so the runner's turn sends
	// the same history and the same blocks as this page's.
	dispatchOpts.session = errandSession(chat, turnId);
	dispatchOpts.reach   = await errandReach(dispatchOpts.diamondId);
	dispatchOpts.today   = errandToday();
	dispatchOpts.words   = await errandWordsFor(chat, runTo);
	dispatchOpts.prodBase = errandProdBase(chat, dispatchOpts.model);
	var plan;
	try { plan = DaimondPeer.buildDispatch(chat, dispatchOpts); }
	catch (e) {
		var whyB = String((e && e.message) || e);
		diag('dispatch refused', 'turn=' + turnId + ' ' + whyB);
		return { ok: false, why: whyB };
	}
	var t0 = (opts && opts.t0) || Date.now();		// turn-send origin, if the caller gave one
	// Carry the chosen target onto the mark, so the tile names the device before a
	// lease holder exists.
	if (opts && (opts.toId || opts.toName)) {
		plan.mark.toDevice = opts.toId || '';
		plan.mark.toName   = opts.toName || '';
	}
	// And the device the errand was elected to, whether or not the tile names it, so the
	// backstop does not hand the turn straight back to it (`electedTried`, R4b).
	if (opts && Array.isArray(opts.tried) && opts.tried.length) plan.mark.tried = opts.tried.slice();
	// A step-away hand-off (a turn already running here, handed on as the page went) is
	// marked so, since one its runner did not take is run here, not ended "not run".
	if (opts && opts.stepAway) plan.mark.stepAway = true;
	// And whether the runner is native (its presence row, as `honoursModelSet` reads it), so
	// the asker folds its figures into the totals on adoption (RT-C): a page runner's own
	// record carries them home.
	try {
		var prN = (window.DaimondPresence && DaimondPresence.snapshot && DaimondPresence.snapshot()) || {};
		if (runTo && prN[runTo] && prN[runTo].kind === 'runner') plan.mark.toNative = 1;
	} catch (e) { /* no presence: the adoption falls back on the answer's `ranOn` */ }
	// 1. MARK THE LOCAL TURN FIRST. The DURABLE `why:'dispatched'` placeholder --
	//    and, through `drawHistoryMessage`, its hand-off tile -- is written BEFORE
	//    the post, so a refused post is a TRANSCRIPT event a store-driven rebuild
	//    reproduces, not DOM chrome the rebuild wipes into an empty turn
	//    (D-20260918-27). It is a local write, so it does not reintroduce the seq-223
	//    flush wait: the errand is still posted ahead of the parcel PUSH below.
	markTurnDispatched(chat, plan.mark);
	if (st) st.marked = true;
	// The placeholder AS THE CHAT HOLDS IT NOW. Read again after every await: a sync
	// merge in that window (`mergeMessages`) replaces the object, and a refusal stamped
	// on the old one was lost with it (UNBLOCK-1 DISPATCH-FAIL).
	function placeholderNow() {
		var ms = chat.messages || [];
		for (var pmi = ms.length - 1; pmi >= 0; pmi--) {
			var pmm = ms[pmi];
			if (pmm && pmm.why === DaimondPeer.REASON_DISPATCHED && String(pmm.iturn) === String(turnId)) return pmm;
		}
		return null;
	}
	// A HAND-OFF REFUSED AFTER ITS MARK ENDS "NOT RUN", by one door for every refusal (an
	// unpostable prompt, a refused post). It used to run here at once (UNBLOCK-1
	// DISPATCH-FAIL, I9); the rulings (§1 l.17, rig law NR) say a turn the switch sent
	// never runs elsewhere: the placeholder is stamped with the refusal, and
	// `endHandOffNotRun` takes and settles the turn's lease (a post whose answer was lost
	// may still have landed), writes the "not run" row with Retry and drops the placeholder.
	function refuseAndEndNotRun(status, why, cause) {
		var ph = placeholderNow();
		if (!ph) return;
		ph.refused = { status: status | 0, why: why, ts: Date.now() };
		touchMsg(ph);
		try { touchChat(chat); persistChats(); } catch (e) { /* the record stands regardless */ }
		try { endHandOffNotRun(chat, ph, 'refused after the mark: ' + why, notRunCause(cause, ph.toDevice, ph.toName)); } catch (e) { /* backstop + recovery-on-return remain */ }
	}
	// 2. SEAL THE ERRAND, dropping the thread seed if the sealed envelope would not
	//    fit the relay. A large recent tail both DUPLICATES what a synced peer already
	//    holds and would 413 the whole hand-off; the errand is then re-sealed seedless
	//    and the runner reconstructs from the parcel (peerReconstruct) -- the
	//    documented fallback (§, `seed:null` = "pull the parcel as before").
	var tPost = Date.now();
	var sealed;
	try { sealed = await DaimondPeer.sealFittingErrand(chat, dispatchOpts, plan); }
	catch (e) {
		// The identity is locked or absent: the errand cannot be sealed and the turn
		// cannot be run locally either (a local run needs the same identity). The
		// durable placeholder stands, so `recoverInterrupted` picks the turn up on the
		// next unlock rather than it being lost.
		var whyS = 'the errand could not be sealed: ' + (e && e.message || e);
		diag('dispatch FAILED', 'turn=' + turnId + ' seal: ' + whyS);
		var placeholder = placeholderNow();
		if (placeholder) {
			placeholder.refused = { status: 0, why: whyS, ts: Date.now() };
			touchMsg(placeholder);
			try { touchChat(chat); persistChats(); if (ownsChat(chat)) renderHistory(chat.messages); } catch (e2) { /* the record stands regardless */ }
		}
		return { ok: false, why: whyS };
	}
	// THE SESSION CAN GO NO WAY (ERRAND-REF): over the 8 MB a hand-off carries (`size`), or
	// its chunks could not be put (`post`). Nothing was posted; the turn ends "not run" with
	// that cause, which NOTRUN-WHY draws ("Too large to hand off", with Run here).
	if (sealed.notRun) {
		var whyN = sealed.notRun === 'size' ? t('errand.session_too_large') : t('errand.session_unsent');
		diag('dispatch FAILED', 'turn=' + turnId + ' ' + sealed.notRun + ': ' + sealed.why);
		// NOTRUN-WHY's call site: fire/notrunwhy gives refuseAndEndNotRun its `cause`; until it
		// merges, the third argument is unread and the row keeps the plain "not run" words.
		refuseAndEndNotRun(0, whyN, sealed.notRun);
		return { ok: false, why: whyN, refused: true };
	}
	var body = sealed.body;
	// THE SESSION WENT AS A REFERENCE (KT-4b): a runner that cannot read it hands the turn
	// back `thread`, and the note says the chat was too big to send, not too long to take.
	if (sealed.sessionRef) {
		var phRef = placeholderNow();
		if (phRef && !phRef.overDoor) { phRef.overDoor = true; touchMsg(phRef); }
	}
	// 2a. AN UNPOSTABLE PROMPT (S-HAND #6). Even seedless, the errand is over the relay
	//     door -- the prompt alone is larger than the relay accepts (a shortened seed
	//     always fits by construction, so this is only ever the prompt). Posting would
	//     413, so do NOT post: stamp the durable placeholder refused and recover the turn
	//     LOCALLY at once (this device holds the chat), which tells the user why rather
	//     than retrying into a wall. No 413 round trips.
	function fitsPostDoor(env) {
		var len = String(env || '').length;
		if (window.DaimondWire && DaimondWire.fits) return DaimondWire.fits('post', len);
		if (window.DaimondPost && DaimondPost.fitsRelay) return DaimondPost.fitsRelay(len);
		return true;
	}
	if (!fitsPostDoor(body && body.envelope)) {
		var whyBig = t('errand.prompt_too_large');
		diag('dispatch FAILED', 'turn=' + turnId + ' unpostable: prompt over the relay door');
		refuseAndEndNotRun(0, whyBig, 'size');
		return { ok: false, why: whyBig, refused: true };
	}
	// 2b. THE ERRAND IS NEVER BEHIND THE PARCEL (UNBLOCK-1, D-20261013-02). A whole-
	//     account flush ahead of the post (7ae6427e for an unflushed removal, 448f951b for
	//     a dropped seed) outlasted the sender's 95 s backstop on a slow link, so the
	//     sender ran the turn itself and the errand landed late or never (13 Oct, four
	//     of six Life log hand-offs). What that flush bought now rides the errand: the
	//     removals as `gone`, which the runner leaves out of the thread it judges and
	//     runs, and the thread as `thread`, which a seedless runner already holding the
	//     conversation matches at once. A runner that lacks it waits on the parcel below
	//     or hands the turn back -- the documented fallback, never a stalled send.
	var seedDropped = !!sealed.seedDropped;
	// THE ERRAND IT WAS SENT AS goes on the placeholder before the post, so a report
	// that answers another errand of the same turn id is known for one (`otherErrandReport`).
	var phE = placeholderNow(), sentEid = String((sealed.plan && sealed.plan.fields && sealed.plan.fields.eid) || '');
	if (phE && sentEid && phE.eid !== sentEid) { phE.eid = sentEid; touchMsg(phE); }
	// 3. POST THE ERRAND. It carries the prompt, the model, the scope, the pause
	//    snapshot and (where it fit) the thread, so a peer that claims reads
	//    everything the turn needs without waiting for a parcel. `parcelVersion` is 0 on
	//    every dispatch -- the receiver reads that as "no target version" and its
	//    progress-based catch-up handles it.
	var res = await DaimondPost.post(body);
	if (!res || !res.ok) {
		// A REFUSED POST IS NOT A LOST TURN (the D-20260918-27 / 413 failure). Stamp
		// the durable placeholder with the refusal and run the turn HERE at once: this
		// device holds the chat, so the take-if-vacant lease makes the local run
		// money-safe and it carries the seq-207 "Ran here -- hand-off didn't finish"
		// provenance on completion. A post refusal is relay-wide -- the errand goes to
		// the account's OWN box, collected by any device -- so re-posting to another
		// desktop cannot succeed where this did not; local recovery is the terminating,
		// correct route (it is the same money-safe path the +95 s backstop takes).
		var whyR = (res && res.why) || 'the relay would not take the errand';
		diag('dispatch FAILED', 'turn=' + turnId + ' ' + whyR + ' status=' + (res && res.status | 0));
		refuseAndEndNotRun((res && res.status) | 0, whyR, 'post');
		return { ok: false, why: whyR, refused: true };
	}
	// (a) THE ERRAND POSTED, and WHAT IT WEIGHED. The seed count is named -- and a
	// dropped-because-too-large seed flagged -- so a thread that outgrew the door is
	// visible rather than inferred.
	var seedMsgs = (sealed.plan.fields.seed && sealed.plan.fields.seed.msgs) ? sealed.plan.fields.seed.msgs.length : 0;
	var goneN = (sealed.plan.fields.gone || []).length;
	diag('dispatch posted', 'turn=' + turnId + ' post=' + (Date.now() - tPost) + 'ms'
		+ ' send->posted=' + (Date.now() - t0) + 'ms seed=' + seedMsgs + 'msg'
		+ (seedDropped ? '(dropped:too-large)' : '') + '/'
		+ String((body && body.envelope) || '').length + 'B gone=' + goneN);
	// The lens sees the stage too, so "elected, then never posted" is read off the
	// feed rather than inferred (diag.md fix 3).
	dsEvent('handoff', {
		act:  'post',
		turn: String(turnId).slice(0, 24),
		to:   String(dispatchOpts.to || '').slice(0, 12),
		ms:   Date.now() - t0,
		seed: seedMsgs,
		drop: seedDropped ? 1 : 0,
		gone: goneN,
		b:    String((body && body.envelope) || '').length,
	});
	// 4. PUSH THE PARCEL, IN THE BACKGROUND. Everything the turn may reach for that
	//    the errand does not carry -- the workspace, the Diamonds, the models, the
	//    ledger -- and the durable copy of this turn's own prompt. When the seed was
	//    dropped this push is also what the runner reconstructs the thread from. Not
	//    awaited: the
	//    runner is not waiting for it, and neither should the person who sent the
	//    turn. Its cost is logged when it lands, so a slow parcel stays visible.
	var tFlush = Date.now();
	(async function () {
		var v = 0;
		try {
			// An unconfirmed flush logs v=0: its rounds already pushed, and the work it
			// could not land is owed, so the retry ladder carries it.
			var fl = DaimondSync.flush ? await DaimondSync.flush() : null;
			if (fl && fl.ok) { v = fl.version | 0; msgTombsShipped(tFlush); }
			else if (!DaimondSync.flush) await DaimondSync.push();
		} catch (e) {
			// NOT a dispatch failure any more. The errand is already on the relay and
			// carries the thread, so the turn runs; what is lost is only the durable
			// copy, which the next ordinary push sends.
			diag('dispatch parcel FAILED', 'turn=' + turnId
				+ ' push/flush threw after ' + (Date.now() - tFlush) + 'ms');
			dsEvent('handoff', { act: 'parcel', turn: String(turnId).slice(0, 24), ok: 0, ms: Date.now() - tFlush });
			return;
		}
		diag('dispatch parcel', 'turn=' + turnId + ' v=' + v
			+ ' flush=' + (Date.now() - tFlush) + 'ms (background, after the post)');
		dsEvent('handoff', { act: 'parcel', turn: String(turnId).slice(0, 24), ok: v > 0 ? 1 : 0, v: v, ms: Date.now() - tFlush });
	})();
	return { ok: true, turnId: turnId, parcelVersion: 0 };
}

// ── Diamonds / crystal / fold ────────────────────────────────────
// A Diamond is a durable crystal the user steers and folds deltas into.
// ── A Diamond runs on the model it was created with ──────────────
//
// Which model a Diamond thinks with is a browser-side choice about how to RUN it, not part of
// the crystal it holds, so it lives in localStorage beside the app rather than in the Diamond's
// own OPFS record -- and no Rust has to learn about it.
var DIAMOND_MODELS_KEY = 'daimond-diamond-models';
// The record's two halves: the models, whose three pairs (daimon, Workers, Images) each sync on
// their own stamp, `dat`, `wat` and `vat`; and the Effort, on `eat`. The fourth pair is no pick:
// it is the pair the daimon's last turn ran on, on `rat` (U2c, `noteModelInForce`), merged as
// the picks are so a turn run on another device counts here. One line, so the pairs travel
// with the half wherever it is lifted.
//
// `at` STAYS THE WHOLE MODEL HALF'S CLOCK, the latest of `dat`, `wat` and `vat` (QA-A, S): a
// build before the split decides the half on `at` alone, so a pick that moved only its own
// stamp never reached it, and its next edit wrote the old pick back as newer. `dat` is written
// only where it differs from `at`; absent, the daimon pair is stamped at `at`.
var DIAMOND_MODEL_HALF  = ['provider', 'model', 'workerProvider', 'workerModel', 'visionProvider', 'visionModel', 'ranProvider', 'ranModel'], DIAMOND_MODEL_PAIRS = [['dat', 'provider', 'model'], ['wat', 'workerProvider', 'workerModel'], ['vat', 'visionProvider', 'visionModel'], ['rat', 'ranProvider', 'ranModel']];
var DIAMOND_EFFORT_HALF = ['effort', 'effortProvider', 'effortModel'];

export function diamondModels() { return readJson(DIAMOND_MODELS_KEY, {}) || {}; }

/// Record what a Diamond thinks with, and what its workers think with.
///
/// `pick` carries every pair -- `{ provider, model, workerProvider, workerModel,
/// visionProvider, visionModel }` -- so the one record travels in the parcel's Diamonds
/// section as it always did, and a device on an older build simply arrives with the later
/// halves empty.
///
/// The secondary is a MAP keyed by modality, not one pair: notes2 asks for a worker model
/// per modality, and text and vision are the two the app can tell apart today. It is
/// stored flat rather than nested because the record is already in the sync parcel and a
/// nested object would have to be merged rather than adopted.
///
/// Fields absent from `pick` are left as they were, so a caller changing one model does
/// not have to carry the other two -- the first version of this took the whole record and
/// a dialog that set the worker model alone would have silently cleared the vision one.
///
/// THE RECORD SYNCS AS A SETTING, ON ITS OWN STAMPS (check_f1 B1). `dat` moves when the daimon's
/// model changes, `wat` when the Workers' does, `vat` when the Images' does and `eat` when the
/// Effort does, and `at` with any of the first three, for builds that read only it, and `applyDiamonds` adopts each pair of an arriving record by its stamp,
/// whichever way the Diamond's own stamp falls. Stamping the whole Diamond instead let a press
/// of the Effort step win a whole-Diamond race and put another device's crystal edit off the
/// head; one stamp for the models let a clear on one device and an Images pick on another
/// lose one of the two (D-20261018-09). `at` here is given only where a change is not the
/// user's (a dropped level) and must not outrank theirs.
///
/// A clear is a write: emptying a pick leaves a stamped tombstone, so the clear travels. Only a
/// Diamond with no record and nothing to say writes none.
export function setDiamondModel(id, pick, at) {
	if (!id || !pick) return;
	var all = diamondModels();
	var was = (all[id] && typeof all[id] === 'object') ? all[id] : {};
	var keep = function (field, given) {
		return (given === undefined || given === null) ? (was[field] || '') : (given || '');
	};
	var model  = keep('model', pick.model);
	var effort = keep('effort', pick.effort);
	// A Diamond on the default holds a record only for its Effort, and never a model: a
	// pinned model would stop it following the default. Back at the default Effort it keeps
	// a tombstone, so the clearing travels and outranks an older level elsewhere (B2). The
	// tombstone blanks the Effort half only: a worker or vision model pinned under the
	// default primary stays (check_b1).
	var next = {
		provider:       keep('provider', pick.provider),
		model:          model,
		workerProvider: keep('workerProvider', pick.workerProvider),
		workerModel:    keep('workerModel', pick.workerModel),
		visionProvider: keep('visionProvider', pick.visionProvider),
		visionModel:    keep('visionModel', pick.visionModel),
		ranProvider:    keep('ranProvider', pick.ranProvider),	// the pair the last
		ranModel:       keep('ranModel', pick.ranModel),		// turn ran on
		effort:         effort,							// the daimon's Effort, '' for its model's default
		effortProvider: effort ? keep('effortProvider', pick.effortProvider) : '',	// the model
		effortModel:    effort ? keep('effortModel', pick.effortModel) : '',		// it was set for
	};
	var bare = DIAMOND_MODEL_HALF.concat(DIAMOND_EFFORT_HALF).every(function (k) { return !next[k]; });
	if (bare && !all[id]) return;	// no record and nothing to say: none is made
	// The stamp a model pair of `r` holds. A record from a build before the split carries one
	// `at` for all three pairs, so the daimon pair, or a Workers or Images pick, with no stamp
	// of its own reads as the record's `at`; an empty Workers or Images pair with none is
	// unstamped. `at` was never the ran pair's clock, so a ran pair with no `rat` is unstamped:
	// the migration's seed, which any real turn's `rat` outranks.
	var pairStamp = function (r, p) {
		if (p[0] === 'dat') return typeof r.dat === 'number' ? r.dat : (+r.at || 0);	// 0 is a stamp
		if (p[0] === 'rat') return +r.rat || 0;
		return +r[p[0]] || ((r[p[1]] || r[p[2]]) ? (+r.at || 0) : 0);
	};
	var moved = function (half) { return half.some(function (k) { return (was[k] || '') !== next[k]; }); };
	var pm = DIAMOND_MODEL_PAIRS.map(function (p) { return moved(p.slice(1)); });
	var em = moved(DIAMOND_EFFORT_HALF);
	// An unchanged pair keeps its stamp: a call that restates it must not outrank a change
	// made elsewhere.
	if (!em && !pm.some(Boolean)) return;
	// Each moved pair outranks the stamp it replaces, whatever this clock says (stamp.js). A
	// moved daimon, Workers or Images pair also outranks `at`, which an old peer compares
	// alone, so a slow clock's pick is not lost to that peer's echo of the older half.
	var stamp = function (prev) { return at !== undefined ? at : DaimondStamp.next(prev); };
	var ps = DIAMOND_MODEL_PAIRS.map(function (p, i) {
		var prev = pairStamp(was, p);
		return pm[i] ? stamp(i < 3 ? Math.max(prev, +was.at || 0) : prev) : prev;
	});
	// `at` (the latest pick's) and `eat` are always written, as before; `dat` after them only
	// where it is not `at`, and `wat`, `vat` and `rat` only once they say something, so a
	// record that never had a Workers or Images pick keeps the bytes it always had.
	// `mergeDiamondModel` writes the same order.
	next.at  = Math.max(ps[0], ps[1], ps[2]);
	next.eat = em ? stamp(was.eat) : (+was.eat || 0);
	DIAMOND_MODEL_PAIRS.forEach(function (p, i) { if (i ? ps[i] : ps[i] !== next.at) next[p[0]] = ps[i]; });
	all[id] = next;
	try { localStorage.setItem(DIAMOND_MODELS_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
	// Another model is another client, and the notes are chosen per model (C6). The last-run
	// pair alone is no pick: its turn re-applies them itself (`noteModelInForce`).
	var picked = em || pm.some(function (m, i) { return m && DIAMOND_MODEL_PAIRS[i][0] !== 'rat'; });
	if (picked) {
		try { if (typeof Notes === 'object' && Notes) Notes.reapply(id); } catch (e) { /* the notes are not up yet */ }
	}
}

function blankDiamondModel() {
	var r = {};
	DIAMOND_MODEL_HALF.concat(DIAMOND_EFFORT_HALF).forEach(function (k) { r[k] = ''; });
	return r;
}

/// The record this device holds once the one arriving from another device is merged in, or
/// null where nothing here moves.
///
/// Each half by its own stamp, strictly newer. An absent record never clears a present one,
/// and an unstamped half (a build before the stamps) never beats a stamped one. Where a half
/// is stamped on neither side, the old rule stands for that half: a strictly newer Diamond
/// being imported brings it, when it says something. Per half, because one Effort stamp here
/// must not turn the old rule off for an old build's model change (check_b1).
function mergeDiamondModel(mine, theirs, importing) {
	if (!theirs || typeof theirs !== 'object') return null;
	var m = (mine && typeof mine === 'object') ? mine : {};
	var str = function (o, k) { return typeof o[k] === 'string' ? o[k] : ''; };
	var pairStamp = function (r, p) {	// as in setDiamondModel
		if (p[0] === 'dat') return typeof r.dat === 'number' ? r.dat : (+r.at || 0);	// 0 is a stamp
		if (p[0] === 'rat') return +r.rat || 0;
		return +r[p[0]] || ((r[p[1]] || r[p[2]]) ? (+r.at || 0) : 0);
	};
	var te = +theirs.eat || 0, me = +m.eat || 0;
	var out = blankDiamondModel(), moved = false;
	var take = function (half, t, mn) {
		var theirsWins = (t || mn) ? t > mn
			: importing && half.some(function (k) { return str(theirs, k); });
		var from = theirsWins ? theirs : m;
		half.forEach(function (k) { out[k] = str(from, k); });
		if (theirsWins) moved = true;
	};
	var ps = DIAMOND_MODEL_PAIRS.map(function (p) {
		var t = pairStamp(theirs, p), mn = pairStamp(m, p);
		take(p.slice(1), t, mn);
		return Math.max(t, mn);
	});
	take(DIAMOND_EFFORT_HALF, te, me);
	if (!moved) return null;
	// The stamps in the order `setDiamondModel` writes them.
	out.at  = Math.max(ps[0], ps[1], ps[2]);
	out.eat = Math.max(te, me);
	DIAMOND_MODEL_PAIRS.forEach(function (p, i) { if (i ? ps[i] : ps[i] !== out.at) out[p[0]] = ps[i]; });
	// An Effort paired with no model in force is the model's own default: kept as a level.
	if (!out.effort) { out.effortProvider = ''; out.effortModel = ''; }
	return out;
}

/// Merge the arriving record in (`mergeDiamondModel`). Did anything here move?
export function adoptDiamondModel(id, theirs, importing) {
	if (!id) return false;
	var all = diamondModels();
	var next = mergeDiamondModel(all[id], theirs, importing);
	if (!next) return false;
	all[id] = next;
	try { localStorage.setItem(DIAMOND_MODELS_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
	try { if (typeof Notes === 'object' && Notes) Notes.reapply(id); } catch (e) { /* the notes are not up yet */ }
	return true;
}

// ── Copies become follows (D-20261018-09 U1f) ────────────────────
//
// Until U1c every chat and New Diamond stored a COPY of the default, so moving the default moved
// nothing he could see. This clears, once per device, every stored pick that only restates
// what it would follow anyway, so it follows from now on. Nothing changes which model runs,
// except Summarising: equal to the default, it now follows the conversation's own model, as
// the spec's §3 has it.
// This device's pre-migration copy, and the run-once marker.
var INHERIT_KEY = 'daimond-inherit-v1';

/// Clear the copies (above). Did it run? It runs once, and never against an empty default or
/// a models store with no provider, which is what a cold WebKit read looks like (models.js
/// `migrate`): there the copy is not written either, so a later boot tries again.
///
/// Equal is the same provider AND the same model, both against the STORED default
/// (`storedChoice`), not this device's fallback. A pick naming no provider names the default's,
/// as `resolve` reads it. A Diamond's or chat's daimon equal to the default is cleared; its
/// Workers when equal to the daimon in force; a Diamond's Images when equal to the Workers in
/// force, which is what an empty Images pick falls back to (`diamondVisionModel`). Drafting
/// and Summarising when equal to the default. Effort is left alone.
///
/// Every clear is the ordinary stamped write (`setDiamondModel`, `touchChatModel`, `setDraft`),
/// all in this one synchronous task, so the next parcel carries them together. So does each
/// Diamond's last-run pair, seeded where it has none with the pair in force before the
/// migration, so the history notes a move made after it (`noteModelInForce`, QA B #1).
function migrateInherit() {
	var M = window.DaimondModels;
	if (!M || typeof M.storedChoice !== 'function' || !pg.chatsUp) return false;
	try { if (localStorage.getItem(INHERIT_KEY) !== null) return false; } catch (e) { return false; }
	var d = M.storedChoice('def');
	if (!d || !d.provider || !d.model) return false;
	var norm = function (p, m) { return { provider: m ? (p || d.provider) : '', model: m || '' }; };
	var same = function (a, b) { return !!a.model && a.model === b.model && a.provider === b.provider; };
	var all = diamondModels();
	var dr  = M.storedChoice('draft') || { provider: '', model: '' };
	// A cleared Workers pick falls to the global Workers pick, and a cleared Images pick to the
	// global Images pick, before either reaches the daimon, so a pick equal to its daimon is a
	// copy only where that global link is unset or equal too.
	var gw  = norm((M.storedChoice('workers') || {}).provider, (M.storedChoice('workers') || {}).model);
	var gi  = norm((M.storedChoice('images') || {}).provider, (M.storedChoice('images') || {}).model);
	var via = function (g, p) { return !g.model || same(g, p); };
	var mine = { at: Date.now(), diamondModels: JSON.parse(JSON.stringify(all)), chats: {},
		draft: { provider: dr.provider, model: dr.model },
		fold: { provider: pg.cfg.foldProvider || '', model: pg.cfg.foldModel || '' } };
	var own = pg.chats.filter(function (c) { return c && c.id && !c.diamondId; });
	own.forEach(function (c) {
		mine.chats[c.id] = { provider: c.provider || '', model: c.model || '',
			workerProvider: c.workerProvider || '', workerModel: c.workerModel || '' };
	});
	// The plan before the copy, so the copy names exactly what was cleared and
	// `unmigrateInherit` puts back that and nothing else (QA B #4).
	var picks = {}, clearedD = {}, clearedC = {};
	// Every Diamond with no last-run pair takes the pair in force before the migration, which
	// is what its last old-build turn ran on, so the next turn on another model writes the
	// history note (QA B #1). A Diamond with no record follows the default. The seed is
	// unstamped (0), so a turn another device ran before this one migrated keeps its `ran`
	// when they sync and its note is not written twice (qa_mmB_migrate M3).
	var seeds = {};
	var ids = Object.keys(all);
	if (typeof pg.diamonds !== 'undefined' && Array.isArray(pg.diamonds)) {
		pg.diamonds.forEach(function (x) { if (x && x.id && ids.indexOf(x.id) < 0) ids.push(x.id); });
	}
	ids.forEach(function (id) {
		var r = all[id];
		if (r !== undefined && (!r || typeof r !== 'object')) return;
		r = r || {};
		var dm = norm(r.provider, r.model), wk = norm(r.workerProvider, r.workerModel);
		var vm = norm(r.visionProvider, r.visionModel);
		var inForce = dm.model ? dm : d, pick = {}, cl = [];
		if (same(dm, d)) { pick.provider = ''; pick.model = ''; cl.push('daimon'); }
		var wKept = !!wk.model && !(same(wk, inForce) && via(gw, inForce));
		if (wk.model && !wKept) { pick.workerProvider = ''; pick.workerModel = ''; cl.push('workers'); }
		var vNext = gi.model ? gi : wKept ? wk : gw.model ? gw : inForce;	// what a cleared Images runs on
		if (same(vm, wKept ? wk : inForce) && same(vm, vNext)) { pick.visionProvider = ''; pick.visionModel = ''; cl.push('images'); }
		if (!r.ranModel) seeds[id] = { ranProvider: inForce.provider, ranModel: inForce.model };
		if (cl.length) clearedD[id] = cl;
		if (Object.keys(pick).length) picks[id] = pick;
	});
	var plan = own.map(function (c) {
		var cm = norm(c.provider, c.model), wk = norm(c.workerProvider, c.workerModel);
		var p = { c: c, m: same(cm, d), w: same(wk, cm.model ? cm : d) && via(gw, wk) };
		if (p.m || p.w) clearedC[c.id] = [].concat(p.m ? ['daimon'] : [], p.w ? ['workers'] : []);
		return p;
	});
	var clearDraft = same(norm(dr.provider, dr.model), d);
	var clearFold  = same(norm(pg.cfg.foldProvider, pg.cfg.foldModel), d);
	mine.cleared = { diamonds: clearedD, chats: clearedC, draft: clearDraft, fold: clearFold };
	// The copy first: a migration that cannot be undone does not run.
	try { localStorage.setItem(INHERIT_KEY, JSON.stringify(mine)); } catch (e) { return false; }
	Object.keys(picks).forEach(function (id) { setDiamondModel(id, picks[id]); });
	Object.keys(seeds).forEach(function (id) { setDiamondModel(id, seeds[id], 0); });
	var moved = false;
	plan.forEach(function (p) {
		if (!p.m && !p.w) return;
		if (p.m) { p.c.provider = ''; p.c.model = ''; }
		if (p.w) { p.c.workerProvider = ''; p.c.workerModel = ''; }
		touchChatModel(p.c);
		moved = true;
	});
	if (moved) persistChats();
	if (clearDraft) M.setDraft('', '');
	if (clearFold) setFoldPick('', '');
	return true;
}

// Has the boot's migration run, and who waits for it.
var _inheritDone = { ran: false, waiters: [] };

/// The boot's migration (above), run once its Diamond list is read, so a Diamond with no model
/// record (a template, or one made without a key) is in it and gets its last-run pair. The
/// models store has settled at unlock and the chats before it (`chatsUp`). Whether it ran or
/// declined, the parcel it held back may go now (`inheritGate`).
export function bootInherit() {
	try { migrateInherit(); } catch (e) { diag('inherit-migrate', { why: String(e && e.message || e) }); }
	_inheritDone.ran = true;
	_inheritDone.waiters.splice(0).forEach(function (r) { r(); });
}

/// Resolves once the boot's migration has run, so the first parcel carries its clears, or after
/// `ms`: a Diamond list that never comes back delays sync, it does not stop it.
export function inheritGate(ms) {
	if (_inheritDone.ran) return Promise.resolve();
	return new Promise(function (r) {
		var tm = setTimeout(r, ms);
		_inheritDone.waiters.push(function () { clearTimeout(tm); r(); });
	});
}

/// Put back what `migrateInherit` cleared on this device, from its copy, as new stamped writes
/// that travel like any change. For the console (`DaimondModels.unmigrateInherit()`); the copy
/// stays, so the migration does not run again.
///
/// Compare-and-set, as `undoEveryone` is (QA B #4): a pair is put back only where the migration
/// cleared it and it still holds the '' the migration wrote. A pick made since, here or on
/// another device, is a newer decision and stays, and the last-run pair is never touched. A
/// copy from before the copy named its clears counts each pair it held as cleared.
export function unmigrateInherit() {
	var was = readJson(INHERIT_KEY, null);
	if (!was || typeof was !== 'object' || was.undoneAt) return false;
	var M = window.DaimondModels;
	var str = function (o, k) { return (o && typeof o[k] === 'string') ? o[k] : ''; };
	var cl  = (was.cleared && typeof was.cleared === 'object') ? was.cleared : null;
	var HALVES = { daimon: ['provider', 'model'], workers: ['workerProvider', 'workerModel'],
		images: ['visionProvider', 'visionModel'] };
	// The halves of `w` (the copy) to put back on `now`, as one pick: cleared, and still ''.
	var restore = function (now, w, cleared, names) {
		var pick = {};
		names.forEach(function (h) {
			var ks = HALVES[h];
			if (!str(w, ks[1])) return;
			if (cleared && cleared.indexOf(h) < 0) return;
			if ((now && (now[ks[0]] || now[ks[1]]))) return;
			pick[ks[0]] = str(w, ks[0]); pick[ks[1]] = str(w, ks[1]);
		});
		return pick;
	};
	var dms = was.diamondModels || {}, live = diamondModels();
	Object.keys(dms).forEach(function (id) {
		var cleared = cl ? ((cl.diamonds || {})[id] || []) : null;
		var pick = restore(live[id], dms[id], cleared, ['daimon', 'workers', 'images']);
		if (Object.keys(pick).length) setDiamondModel(id, pick);
	});
	var moved = false;
	pg.chats.forEach(function (c) {
		var w = c && (was.chats || {})[c.id];
		if (!w || c.diamondId) return;
		var cleared = cl ? ((cl.chats || {})[c.id] || []) : null;
		var pick = restore(c, w, cleared, ['daimon', 'workers']);
		if (!Object.keys(pick).length) return;
		Object.keys(pick).forEach(function (k) { c[k] = pick[k]; });
		touchChatModel(c);
		moved = true;
	});
	if (moved) persistChats();
	var dr = M && M.storedChoice ? M.storedChoice('draft') : null;
	if (dr && !dr.model && str(was.draft, 'model') && (!cl || cl.draft)) {
		M.setDraft(str(was.draft, 'provider'), str(was.draft, 'model'));
	}
	if (!pg.cfg.foldModel && str(was.fold, 'model') && (!cl || cl.fold)) {
		setFoldPick(str(was.fold, 'provider'), str(was.fold, 'model'));
	}
	was.undoneAt = Date.now();
	try { localStorage.setItem(INHERIT_KEY, JSON.stringify(was)); } catch (e) { /* quota: the writes above stand */ }
	return true;
}

/// THE HISTORY FOLLOWS THE MODEL IN FORCE, NOT THE BUTTON (D-20261018-09 U2c; Models spec §3).
/// Called as a daimon turn starts, before its request, with the pair it runs on. Where that
/// pair is not the one its last turn ran on (the record's `ran` pair), the steering notes are
/// re-applied and the model-change note goes into the crystal's history. A Diamond that follows
/// the default is never written to when the default moves, so a note written on Change missed
/// it; this covers Change, a moved default, a pick synced from another device and *Everyone
/// uses* alike, with no toast. The `ran` pair syncs on `rat`, so a turn another device ran on
/// the new pair has already said it. A first turn, with no `ran`, writes it and nothing else.
/// `ran` moves only once the note is in, so a note that failed is tried again next turn. Does
/// the history say the model changed?
///
/// # Arguments
/// * `app` - The turn's engine, which writes the note (`record_model_change`).
export async function noteModelInForce(id, pair, app) {
	if (!id || !pair) return false;
	var rec  = diamondModels()[id] || {};
	var to   = { provider: pair.provider || '', model: pair.model || '' };
	var from = { provider: rec.ranProvider || '', model: rec.ranModel || '' };
	if (!to.model || (from.provider === to.provider && from.model === to.model)) return false;
	if (from.model) {
		try { if (typeof Notes === 'object' && Notes) Notes.reapply(id); } catch (e) { /* the notes are not up yet */ }
		try {
			await app.record_model_change(id, t('tile.model_change_note', { from: from.model, to: to.model }));
		} catch (e) {
			// The turn runs on the new model all the same; the history line waits for the next.
			diag('model change', 'note for ' + id + ' not written, ' + from.model + ' -> ' + to.model
				+ ': ' + ((e && e.message) || e));
			return false;
		}
	}
	setDiamondModel(id, { ranProvider: to.provider, ranModel: to.model });
	return !!from.model;
}

/// The daimon's Effort on the model this Diamond runs on now. A level the model in force does
/// not offer (the default moved under a Diamond that follows it) is forgotten, quietly.
export function diamondEffort(id) {
	var rec = diamondModels()[id];
	if (!rec || !rec.effort || typeof DaimondModels !== 'object' || !DaimondModels) return '';
	var m = diamondModel(id);
	var r = DaimondModels.effortInForce(rec, m.provider || '', m.model || '');
	if (r.dropped) setDiamondModel(id, { effort: '' }, +rec.eat || 0);	// not the user's change
	return r.effort;
}

/// Set the daimon's Effort, paired with the model in force and pinning none.
export function setDiamondEffort(id, effort) {
	var m = diamondModel(id);
	setDiamondModel(id, { effort: effort || '',
		effortProvider: effort ? (m.provider || '') : '', effortModel: effort ? (m.model || '') : '' });
}

/// The model a Diamond runs on. A Diamond made before Diamonds had models falls back to the default,
/// which is exactly what it was silently doing already. The chain is `DaimondModels.effective`'s.
export function diamondModel(id) {
	return window.DaimondModels
		? DaimondModels.effective({ kind: 'diamond', id: id }, 'daimon') : { provider: '', model: '' };
}

/// A model record's own picks, as `DaimondModels.effective` reads them: '' where unset. The
/// daimon's Effort rides along as `{ level, provider, model, at }`, the model it was set for
/// and its stamp, so the Undo of *Everyone uses* can put back a level dropped meanwhile.
function modelPicksOf(rec) {
	rec = rec || {};
	return {
		daimon:  { provider: rec.provider || '',       model: rec.model || '' },
		workers: { provider: rec.workerProvider || '', model: rec.workerModel || '' },
		images:  { provider: rec.visionProvider || '', model: rec.visionModel || '' },
		effort:  { level: rec.effort || '', provider: rec.effortProvider || '', model: rec.effortModel || '',
			at: +rec.eat || 0 },
	};
}

/// A Diamond's own picks, from its record.
export function diamondPicks(id) { return modelPicksOf(diamondModels()[id]); }

/// A chat's own picks. A chat inside a Diamond owns no model (`chatOwnsModel`): its daimon is
/// the Diamond's, and its workers follow that daimon unless a Jobs pick says otherwise.
export function chatPicks(chat) {
	if (chat && chat.diamondId) return modelPicksOf(diamondPicks(chat.diamondId).daimon);
	return modelPicksOf(chat && { provider: chat.provider, model: chat.model,
		workerProvider: chat.workerProvider, workerModel: chat.workerModel });
}

/// The global Summarising pick (`cfg.foldModel`), which stays a device setting.
export function summarisingPick() { return { provider: pg.cfg.foldProvider || '', model: pg.cfg.foldModel || '' }; }

// ── The writers *Everyone uses* reaches through (D-20261018-09 U2a) ──
// `DaimondModels.setEveryone` decides what to clear; these do the clearing, each as the
// ordinary stamped write, so the change set is the one a hand edit would make.

/// Every Diamond, and every chat that owns a model, named as the rail names it. A record whose
/// Diamond the rail has not listed yet is a target still, so its pick is not left behind.
export function everyoneTargets() {
	var out = [], seen = {};
	var add = function (id, name) {
		if (!id || seen[id]) return;
		seen[id] = true;
		out.push({ target: { kind: 'diamond', id: id }, name: name || '' });
	};
	pg.diamonds.forEach(function (d) { if (d) add(d.id, d.name); });
	Object.keys(diamondModels()).forEach(function (id) { add(id, ''); });
	pg.chats.forEach(function (c) {
		if (c && c.id && !c.diamondId) out.push({ target: { kind: 'chat', chat: c }, name: chatDisplayName(c) });
	});
	return out;
}

// A chat cleared and not yet saved (`settlePicks`).
var _picksDirty = false;

/// Clear one text pick: a Diamond's or chat's `'daimon'` or `'workers'`, or `'summarising'`
/// on `{ kind: 'jobs' }`. Never Images. A chat is saved by `settlePicks`, once for the run.
export function clearPick(target, role) { setPick(target, role, null); }

/// Write one text pick, `pair` as `{ provider, model }` (null clears it), as `clearPick`
/// names them: the Undo of *Everyone uses* puts a cleared pick back through here (U2b),
/// and a Diamond's `'effort'`, `{ level, provider, model }` as `modelPicksOf` reads it.
/// An unchanged pick writes nothing, so it keeps its stamp.
export function setPick(target, role, pair) {
	if (!target) return;
	var pv = (pair && pair.model) ? (pair.provider || '') : '', md = (pair && pair.model) || '';
	if (target.kind === 'jobs') { if (role === 'summarising') setFoldPick(pv, md); return; }
	if (role === 'effort') {
		var lv = (pair && pair.level) || '';
		if (target.kind === 'diamond') setDiamondModel(target.id, { effort: lv,
			effortProvider: lv ? pv : '', effortModel: lv ? md : '' });
		return;
	}
	var ks = role === 'daimon' ? ['provider', 'model'] : role === 'workers' ? ['workerProvider', 'workerModel'] : null;
	if (!ks) return;
	if (target.kind === 'diamond') {
		var pick = {};
		pick[ks[0]] = pv; pick[ks[1]] = md;
		setDiamondModel(target.id, pick);
		return;
	}
	var c = target.chat || pg.chats.filter(function (x) { return x && x.id === target.id; })[0];
	if (!c || c.diamondId || ((c[ks[0]] || '') === pv && (c[ks[1]] || '') === md)) return;
	c[ks[0]] = pv; c[ks[1]] = md;
	touchChatModel(c);
	_picksDirty = true;
}

/// Save the chats a run of `clearPick` or `setPick` changed.
export function settlePicks() {
	if (!_picksDirty) return;
	_picksDirty = false;
	persistChats();
}

// ── What a chat pays with (OWNKEY SW-1, D-20261024-19) ───────
// "and it should be easy to switch between credit sources!!!!!!" The composer row's first
// control names the provider the chat's daimon runs on and moves THIS chat (or, inside a
// Diamond, the Diamond) to another. The global default never moves here; it stays Models →
// model → "Make this the model new chats and diamonds start on".

/// The pair a chat's daimon runs on now: the Diamond's inside one, else the chat's own pick
/// or the default's.
function sourcePairOf(chat) {
	if (!chat) return { provider: '', model: '' };
	if (chat.diamondId) return diamondModel(chat.diamondId);
	var e = DaimondModels.effective({ kind: 'chat', chat: chat }, 'daimon');
	return { provider: e.provider || '', model: e.model || '' };
}

/// The provider a chat pays with.
export function sourceOf(chat) { return sourcePairOf(chat).provider; }

/// A source's name as the switch shows it: "Credits", or the provider's row name.
export function sourceLabel(id) {
	if (!id) return '';
	return id === DaimondModels.CREDITS ? t('astat.credits') : DaimondModels.providerName(id);
}

/// The `{ from, to }` a source move's toast says: the models, or the sources where the model
/// keeps its name across them, which would otherwise read "Thinker to Thinker".
export function sourceMovedPair(out) {
	var from = shortModel(out.before.model, out.before.provider) || t('tile.model_none');
	var to   = shortModel(out.after.model, out.after.provider);
	if (from === to) return { from: sourceLabel(out.before.provider), to: sourceLabel(out.after.provider) };
	return { from: from, to: to };
}

/// The switch's menu for `chat`: each source as `DaimondModels.sources` lists it, with the
/// current one `checked`, then the "Add a provider…" row (`add`).
export function sourceMenuRows(chat) {
	var cur = sourceOf(chat);
	return DaimondModels.sources().map(function (s) {
		return { id: s.id, name: s.name, credits: s.credits, balance: s.balance, checked: s.id === cur };
	}).concat([{ add: true }]);
}

/// Move `chat` to source `to`, as one stamped write on the record that owns its model: the
/// chat's own picks, or its Diamond's model set. The model is mapped across
/// (`DaimondModels.planSource`), the workers and images halves on the old source go with it,
/// and the Effort is re-clamped to the new model's levels. Answers `{ before, after, eff }`,
/// or null when nothing moved: the same source, or one that lists no model here.
export function switchChatSource(chat, to) {
	if (!chat || !to) return null;
	var M = DaimondModels, before = sourcePairOf(chat);
	if (before.provider === to) return null;
	var did = chat.diamondId;
	var plan = M.planSource(did ? diamondPicks(did) : chatPicks(chat), before, to);
	var res = plan && M.resolve(plan.daimon.provider, plan.daimon.model);
	if (!res) return null;
	var after = { provider: res.provider, model: res.model };
	var eff = M.effortClamp(did ? diamondEffort(did) : (chat.effort || ''), after.provider, after.model);
	if (did) {
		var pick = { provider: after.provider, model: after.model, effort: eff.effort,
			effortProvider: eff.effort ? after.provider : '', effortModel: eff.effort ? after.model : '' };
		if (plan.workers) { pick.workerProvider = plan.workers.provider; pick.workerModel = plan.workers.model; }
		if (plan.images)  { pick.visionProvider = plan.images.provider;  pick.visionModel = plan.images.model; }
		// A record with no last-run pair takes `before`, as `changeDiamondModel` does, so the
		// next turn writes its note of the move.
		var rec = diamondModels()[did] || {};
		if (!rec.ranModel && before.model) { pick.ranProvider = before.provider; pick.ranModel = before.model; }
		setDiamondModel(did, pick);
		resetDiamondApps();
		bumpDiamonds();
	} else {
		// A deliberate pin, stored as given, as the Diamond branch does: not through
		// `storedPick`, which would read a pair equal to the default as "follow it" and let a
		// later move of the default move this chat unasked (D-20261024-19, QA-B F1).
		chat.provider = after.provider;
		chat.model    = after.model;
		if (plan.workers) {
			chat.workerProvider = plan.workers.provider;
			chat.workerModel    = plan.workers.model;
		}
		chat.effort = eff.effort;
		chat.app = null;		// a DaimondApp's model and key are fixed at construction
		touchChatModel(chat);
		persistChats();
	}
	return { before: before, after: after, eff: eff };
}

/// The model this Diamond's WORKERS run on: what the user chose for them, and otherwise the
/// Diamond's own model.
///
/// Never the starred default. A worker used to be built straight out of `cfg` -- a view of
/// whatever is starred -- so a Diamond deliberately pinned to a strong model fanned its workers
/// out onto whatever the user happened to have starred, and the whole fan-out was billed to that
/// provider's key. A Diamond made before this setting existed carries no worker model, and
/// "absent" therefore has to mean the Diamond's own model: reading it as the default would
/// preserve the defect for every Diamond that already exists.
///
/// A worker model whose provider has since lost its key falls through to the next link
/// (`DaimondModels.effective`): the global Workers pick, then the Diamond's own model.
export function diamondWorkerModel(id) {
	if (!window.DaimondModels) return diamondModel(id);
	var e = DaimondModels.effective({ kind: 'diamond', id: id }, 'workers');
	return { provider: e.provider, model: e.model };
}

/// Which file extensions this app can actually hand a model as an image.
///
/// Not a general list of picture formats: it is what `ImageMedia` in `src/protocol.rs`
/// sniffs, plus what `file_read` converts to one of those before attaching it (BMP,
/// TIFF, ICO and HEIC, through `converted_picture` in `src/tools.rs`, UNBLOCK-25).
///
/// DO NOT WIDEN IT to `avif`. Nothing here decodes one, `file_read` hands it over as
/// bytes, and the only effect would be to send the task to the dearer model for a file
/// no model can be shown. A worker that meets a picture this cannot predict is moved
/// by `Workers.unseeable`, which asks the model rather than the filename.
var IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|dib|tiff?|ico|heic|heif)\b/i;

/// Does this task look as though it will put an image in front of a model?
///
/// The signal available at dispatch, and the only one: `spawn_agent`'s schema is
/// `{name, task}` and stays that way, because the model must never be the thing that
/// decides what to spend money on. So the task TEXT is read for a path the daimon has
/// named, which is how a daimon asks a worker to look at a screenshot.
///
/// It is a guess, and a guess in one direction only: a task that names no image runs on
/// the text model, which is what every task did before there was a second one. What it
/// can get wrong is a worker that discovers an image for itself, and that one is not
/// knowable here at all -- so it is not decided here. `Workers.unseeable` moves that
/// worker when the model actually refuses the picture; dispatch is no longer the only
/// place routing happens.
export function taskWantsVision(task) {
	return IMAGE_EXT.test(String(task || ''));
}

/// The model this Diamond's workers run on for a task that carries an image.
///
/// Falls back to the text worker model. There is still no `vision` flag anywhere in
/// `models.js`, and inventing one would be a guess maintained by hand and wrong for
/// every model released after it was written — so the choice of WHICH image model
/// stays the user's. What the app can now check is the other half: it cannot know
/// before the first request, and it acts on what the first refusal teaches. See
/// `Workers.unseeable`. A Diamond with no vision model set falls back to the text one —
/// the run says which model it got, so a fallback is visible rather than silent.
export function diamondVisionModel(id) {
	if (!window.DaimondModels) return diamondWorkerModel(id);
	var e = DaimondModels.effective({ kind: 'diamond', id: id }, 'images');
	return { provider: e.provider, model: e.model };
}

/// THE MODELS A TURN RUNS ON, resolved once at its start (D-20261018-09 U1d; Models spec §3,
/// "A turn keeps the models it started with"). The turn holds this set on its run state and
/// every fan-out round of it dispatches on it, so a default moved mid-turn applies from the
/// next turn and never splits one turn across two models. `images.chosen` says the images
/// pair was picked (its own or the Jobs pick) rather than inherited from the workers, the
/// question `imagesModelFor` asks.
///
/// # Arguments
/// * `daimon` - The pair the daimon runs on this turn (`steerModelFor`), so a runner's
///   marked errand pair is the set's daimon as well.
export function turnModelsOfDiamond(id, daimon) {
	var d  = daimon || diamondModel(id) || {};
	var im = window.DaimondModels
		? DaimondModels.effective({ kind: 'diamond', id: id }, 'images') : diamondVisionModel(id);
	return {
		daimon:  { provider: d.provider || '', model: d.model || '' },
		workers: diamondWorkerModel(id),
		images:  { provider: im.provider || '', model: im.model || '',
			chosen: im.from === 'own' || im.from === 'jobs' },
	};
}

/// A copy of a held turn set, so a round that adjusts its own (`runTurn` does, when the engine fell
/// back) never edits the batch's.
export function copyTurnSet(m) {
	var c = function (p) { return p ? Object.assign({}, p) : { provider: '', model: '' }; };
	return { daimon: c(m.daimon), workers: c(m.workers), images: c(m.images || m.workers) };
}

/// The same set for a chat. Its workers ride its own pair, `chosen` (`chatWorkerModel`), and a
/// chat has no images setting, so its images half is its workers'.
export function turnModelsOfChat(chat, daimon) {
	var d = daimon || turnModelOf(chat);
	var w = chatWorkerModel(chat);
	return { daimon: { provider: d.provider || '', model: d.model || '' }, workers: w, images: w };
}

/// The set a chat's turn runs on: `sent`, the set a hand-off's errand carried and the runner
/// resolved (`sentModelsOf`), or this device's own. A set holding only a daimon half (an
/// older asker's) takes its workers here.
export function turnModelsOfRun(chat, sent) {
	if (!sent || !sent.daimon) return turnModelsOfChat(chat);
	if (!sent.workers) return turnModelsOfChat(chat, sent.daimon);
	return { daimon: sent.daimon, workers: sent.workers, images: sent.images || sent.workers };
}

// ── A Diamond has two faces (a phone, three) ──────────────────────────────────────
//
// Notes2, in the user's own words: *"The idea of just having a prompt box and
// hiding the chat sequence doesn't work. We need to reconceptualise Daimond as
// consisting of two types of chats, diamonds and chats, the first carrying context
// and scope. So a diamond should offer the crystal view and a chat view."*
//
// The crystal is the daimon's OUTPUT. The chat is its conversation, and until now
// there was not one: every steer built a fresh session, so the daimon could not be
// asked a follow-up question, and an answer that changed no file went into a
// dismissable box and was gone by the next steer. It is persistent now — the
// conversation goes to the engine and comes back on every turn — and this is where
// it is read.

/// Which face this Diamond is showing. Per Diamond, beside the app: it is a fact
/// about how you are working, not about the Diamond, and it should not travel to
/// another device any more than a scroll position should.
var DIAMOND_VIEW_KEY = 'daimond-diamond-view';

function diamondViews() { return readJson(DIAMOND_VIEW_KEY, {}) || {}; }

/// `'crystal'` or `'chat'`. Absent means CRYSTAL, and the user's own words for
/// why: *"the opening when clicking a diamond should be the crystal, that's
/// the entire point, it['s] a summary of the diamond"*.
///
/// Worth stating what this costs, because it was briefly changed and changed
/// back. The crystal face carries NO COMPOSER -- the steer box that used to
/// sit under it is gone, since a daimon is a persistent conversation and one
/// composer is enough. So landing here means landing somewhere you cannot
/// type, and the way to type is the face switch in the header.
///
/// That is acceptable, and only because the switch is ALWAYS VISIBLE beside
/// the Diamond's name. The rule it has to satisfy is the one the whole
/// Simple view is built on: hide information, never the affordance. A reader
/// who wants to say something can see, without hunting, where to go.
///
/// A phone adds `'files'` (Stack A4): the Diamond's Workspace tree in the crystal's place.
export function diamondView(id) {
	var v = diamondViews()[id];
	return (v === 'chat' || v === 'files') ? v : 'crystal';
}

export function setDiamondView(id, view) {
	if (!id) return;
	var all = diamondViews();
	all[id] = (view === 'chat' || view === 'files') ? view : 'crystal';
	try { localStorage.setItem(DIAMOND_VIEW_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
	// The face this TAB is on, for its own reload. See TAB_VIEW_KEY.
	if (pg.currentDiamond && pg.currentDiamond.id === id) tabViewSet({ face: all[id] });
}

export function forgetDiamondView(id) {
	var all = diamondViews();
	if (!(id in all)) return;
	delete all[id];
	try { localStorage.setItem(DIAMOND_VIEW_KEY, JSON.stringify(all)); } catch (e) { /* quota */ }
}

/// This Diamond's daimon conversation, made on first use.
///
/// An ordinary chat record with a `diamondId`, which buys the existing renderer,
/// the existing store, the existing merge and the existing sync for nothing. What
/// it deliberately does NOT get is a tile in the Chats rail: it is reached through
/// its Diamond, because it is not a chat you started, it is a daimon you have been
/// talking to.
///
/// It holds NO MODEL (UNBLOCK-5, C3). A Diamond's primary may be changed at any time
/// (§1.3), and the copy this record used to keep, refreshed here by an unstamped write,
/// went stale and won merges by value: Lifelog's turns said glm with the Diamond on
/// deepseek. The Diamond's record is the one owner; `turnModelOf` reads it.
export function daimonChat(f) {
	if (!f || !f.id) return null;
	var rec = pg.chats.find(function (c) { return c.diamondId === f.id; });
	if (!rec) {
		rec = {
			id: newChatId(),
			diamondId: f.id,
			name: f.name || t('rail.unnamed_diamond'),
			app: null,                 // a daimon runs on `diamondApp`, never its own
			messages: [],
			status: 'active',
			promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0,
			prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0,
			lastPrompt: 0,
			updatedAt: 0,
		};
		pg.chats.push(rec);
		persistChats();
	}
	// The Diamond's name is the conversation's name. Renaming the Diamond has to
	// carry, or a merged store ends up with two records claiming one Diamond under
	// two names and no way to tell which is current.
	if (f.name && rec.name !== f.name) rec.name = f.name;
	return rec;
}

// ── Triggered actions, and what they leave for you to answer ─────
//
// `www/js/triggers.js` holds the decisions -- what a TA is, when one is due,
// what text it sends, and whether the context goes with it. This is the half
// that touches the world: the files, the clock, the daimon and the panel.
//
// The files are at `diamonds/<id>/triggers.json`, in the open where the
// System section shows them, and they are the setting rather than a copy of
// it: edit the file and the next tick reads what you wrote.

function triggersPath(id) { return 'diamonds/' + id + '/triggers.json'; }

/// Every Diamond's TAs, read once and kept, because a tick that opened a file
/// per Diamond per minute would be a tick nobody could afford to leave on.
/// Reloaded when the file changes under us -- a save, a sync, an agent edit --
/// which is what `Triggers.reload` is for.
var _triggers = {};       // diamondId -> { v, actions: [...] }

/// Mail arrivals a Diamond refused, held to be asked again: `diamondId \0 mailbox \0 folder`
/// -> `{ id, mailbox, folder }`.
///
/// A timer that is refused keeps its minutes and is asked at the next tick. A mail
/// arrival is announced ONCE, so before this a refusal -- a turn already running in
/// that Diamond, an open question in its thread, somebody mid-sentence, a key that
/// cannot run -- lost the alert for good. Keyed by folder rather than by message:
/// one turn answers whatever has arrived, so three refused arrivals are one owed turn.
var _mailOwed = {};

/// Hold a refused mail occasion for `Triggers.retryMail`. Anything else is a timer,
/// which keeps its own minutes.
///
/// The entry is only a reminder to ask again, never the word on whether the arrival was
/// answered: that is the synced mark (`mailMarkKey`), which every retry's claim reads.
/// So nothing here goes on the clock, and a reload that forgets it loses nothing:
/// `owedByMark` puts it back from the mail this device holds above the mark.
function oweMail(id, occasion) {
	if (!occasion || occasion.kind !== 'mail') return;
	var k = id + '\u0000' + (occasion.mailbox || '') + '\u0000' + (occasion.folder || '');
	_mailOwed[k] = { id: id, mailbox: occasion.mailbox, folder: occasion.folder,
		uids: occasion.uids, uidValidity: occasion.uidValidity };
}

/// What this page has in flight, by key, so it is not taken again (and then released) from
/// under itself: this device's own live claim is one the lease door lets it RE-TAKE
/// (`leaseTakeFrom`, RUNNER-READY F2), so the door cannot be the guard here.
///
/// A MAIL ARRIVAL IS KEYED BY ITS FOLDER and held from before its claim until its settle has
/// raised the mark (MAIL-TWICE, 2026-10-26). Keyed by claim id and held only while its turn
/// ran, the 60 s tick's `retryMail` that fell while the mark's write was on the wire read the
/// mark still under the arrival, owed it, re-took the claim and bought a second turn (two in
/// four C1b `verify_mailtrigger` runs). Whatever uid set a later occasion names, one turn
/// at a time answers a folder here; what arrived meanwhile waits owed, and the mark decides it.
/// A timer's firing is keyed by its claim id (`keepMailClaim`, `claimTimerFire`).
var _mailRunning = {};
// The failed runs of each arrival on this device, by claim id, and the bound on them
// (post-QA r569qa2 Q4; see `settleMailClaim`). In memory: a reload counts afresh, so it
// bounds the cost of one page's life, and it holds one small entry per failed arrival.
var MAIL_TRIES_MAX = 3;
var _mailTries = {};

// ── One turn per arrival, however many devices are open (MO-1) ──
//
// Every open, unlocked device polls the synced mailbox and announces the same arrival
// above its own mark, and since mail fires off screen each one ran the turn: N devices,
// N turns, N bills, and N daimons writing the same alerts. So an arrival is CLAIMED on
// the lease door before its turn runs -- the one-turn-id, one-lease rule a handed-off
// turn already lives by (`DaimondLease.take`). The device that loses does nothing and
// holds the arrival owed; the winner raises the folder's ANSWERED MARK when its turn
// ends, and the owed copies stand down on reading it.
//
// The claim only arbitrates the live race. It is held one lease TTL at a time and
// renewed while the turn runs, so a slow turn stays claimed however long it takes (r569
// R2) and a winner that dies lets it lapse in 90 s, when the next device to ask takes it.
// Whether an arrival was answered is the mark's to say, not the claim's: a settled
// claim drains from the door within minutes, after which a device that woke late read
// the arrival as vacant and ran it again (R1), and a loser that dropped its owed copy on
// the clock lost it when the winner died (R3). The mark is synced, monotone and never
// drained, one per Diamond, mailbox and folder.

/// A folder's generation, its UIDVALIDITY, as the unsigned 32-bit number IMAP sends: read
/// signed, a value above 2^31 went negative (r569 A1). It names a generation and orders
/// nothing; the mark compares it only for equality.
function mailGen(v) { return (+v >>> 0) || 0; }

/// The lease key of a Diamond's answered mark for one folder: "answered through uid N"
/// in the folder's uidValidity, which the record carries.
function mailMarkKey(id, occasion) {
	return 'mark:mail:' + id + ':' + ((occasion && occasion.mailbox) || '')
		+ ':' + ((occasion && occasion.folder) || '');
}

/// The lease turnId of one arrival for one Diamond: mailbox, folder, generation, and the
/// highest uid announced -- one turn answers whatever has arrived, so the newest message
/// names it. Two devices that saw the same messages name the same arrival; one that saw
/// a later message names a new one, which is a new message and its own turn. Empty when
/// the occasion carries no uids, which then runs unclaimed as it always did.
function mailClaimId(id, occasion) {
	var u = 0;
	((occasion && occasion.uids) || []).forEach(function (x) { if (+x > u) u = +x; });
	if (!u) return '';
	return 'mail:' + id + ':' + (occasion.mailbox || '') + ':' + (occasion.folder || '')
		+ ':' + mailGen(occasion.uidValidity) + ':' + u;
}

/// Claim an arrival for this device. Answers `{ go }` to run it (with what
/// `settleMailClaim` needs when it was claimed), `{ drop }` when the folder's mark says
/// it was answered, or `{ go: false }` to hold it owed: lost to a live claim, or a door that
/// could not decide. One this page already has in flight never reaches here (`Triggers.fire`).
/// A refusal that will not change by asking again -- a device behind the epoch chain, a
/// full door -- runs unclaimed, as every arrival did before this: a turn too many is a
/// cost, an alert lost is a fault nobody hears of.
async function claimMailArrival(id, occasion) {
	var tid = mailClaimId(id, occasion), self = selfDeviceId();
	if (!tid || !self || !window.DaimondLease || !DaimondLease.take
		|| !window.DaimondPeer || !DaimondPeer.syncCas) return { go: true };
	// A page that can NEVER coordinate -- no identity, Safe mode, no sync tier -- has no peer
	// to defer to: its door would only ever read `unread`, and standing down on that would
	// silence every mail trigger for good (S1MF-live).
	var sync = window.DaimondSync;
	if (!syncsHere() || (sync.entitled && !sync.entitled())) return { go: true };
	// A syncing page that has not heard back YET is another matter: the arrival may be one
	// another device already claimed and ran, so it is held owed, never run blind, and asked
	// again when this page first hears the mailbox (QA r572w B N2). A door unreachable for
	// good keeps it held, retried every tick and on the pull that finally answers.
	if (sync.heard && !sync.heard()) {
		retryMailOnHeard();
		return { go: false, why: 'unheard' };
	}
	if ((_mailTries[tid] | 0) >= MAIL_TRIES_MAX) return { drop: true, why: 'tries' };	// tried enough here (Q4)
	var lo = 0, hi = 0;
	occasion.uids.forEach(function (x) {
		if (+x > hi) hi = +x;
		if (+x > 0 && (!lo || +x < lo)) lo = +x;
	});
	// The mark: dropped at or below it; seeded just under this arrival when unwritten.
	var gen = mailGen(occasion.uidValidity);
	var mark = { key: mailMarkKey(id, occasion), gen: gen, upTo: hi, floor: lo - 1 };
	var cas = DaimondPeer.syncCas(peerSyncShim()), took = null;
	// No `ts`, so no deadline: the claim is one TTL long and `keepMailClaim` renews it.
	try { took = await DaimondLease.take(tid, { holder: self, mark: mark }, cas, leaseClockNow); }
	catch (e) { took = { won: false, why: 'unread' }; }
	if (took && took.won) return { go: true, tid: tid, self: self, cas: cas, mark: mark };
	var why = String((took && took.why) || '');
	diag('mail claim', tid + ' lost why=' + (why || 'held') + ' holder=' + String((took && took.holder) || '').slice(0, 8));
	if (why === 'settled') return { drop: true, why: why };
	if (!why) return { go: false, why: 'held' };
	if (DaimondPeer.standDownUndecided && DaimondPeer.standDownUndecided(why)) return { go: false, why: why };
	return { go: true };
}

/// The lease id of one timer firing: the Diamond, the action, and the stretch of its period
/// the firing falls in, so two devices whose timers come due together name one firing.
function timerFireId(f, ta, now) {
	var per = Math.max(1, +(ta && ta.minutes) || 30) * 60000;
	return 'timer:' + String(f.id || '') + ':' + String((ta && ta.id) || '') + ':' + Math.floor(now / per);
}

/// Claim a timer's firing for this device (rulings l.16; STEER-2), as `claimMailArrival`
/// claims an arrival: `{ go }` to run it, with what `settleMailClaim` needs; `{ elsewhere }`
/// when another device holds or has run this firing, or the one just before it (a firing
/// that fell either side of a period's edge), so this one stands down as fired; `{ go: false }`
/// to keep the minutes and ask again at the next tick (a door that could not decide). A page
/// that cannot coordinate runs it unclaimed, as every timer did before.
async function claimTimerFire(f, ta) {
	var self = selfDeviceId();
	if (!self || !window.DaimondLease || !DaimondLease.take || !window.DaimondPeer || !DaimondPeer.syncCas) return { go: true };
	var sync = window.DaimondSync;
	if (!syncsHere() || (sync && sync.entitled && !sync.entitled())) return { go: true };
	if (sync && sync.heard && !sync.heard()) return { go: false, why: 'unheard' };
	var now = Date.now(), tid = timerFireId(f, ta, now);
	var per = Math.max(1, +(ta && ta.minutes) || 30) * 60000;
	var prev = DaimondLease.record ? DaimondLease.record(timerFireId(f, ta, now - per)) : null;
	if (prev && prev.holder && prev.holder !== self && !prev.retired) {
		diag('timer claim', tid + ' stood down: the firing before it is ' + String(prev.holder).slice(0, 8) + '\'s');
		return { elsewhere: true };
	}
	if (_mailRunning[tid]) return { elsewhere: true };
	var cas = DaimondPeer.syncCas(peerSyncShim()), took = null;
	try { took = await DaimondLease.take(tid, { holder: self }, cas, leaseClockNow); }
	catch (e) { took = { won: false, why: 'unread' }; }
	if (took && took.won) return { go: true, tid: tid, self: self, cas: cas, mark: null };
	var why = String((took && took.why) || '');
	diag('timer claim', tid + ' lost why=' + (why || 'held') + ' holder=' + String((took && took.holder) || '').slice(0, 8));
	if (!why || why === 'held' || why === 'settled') return { elsewhere: true };
	if (DaimondPeer.standDownUndecided && DaimondPeer.standDownUndecided(why)) return { go: false, why: why };
	return { go: true };
}

/// Ask the owed mail again the moment this page first hears the mailbox (`daimond:heard`),
/// rather than at the next tick. Armed once per page.
var _mailHeardArmed = false;
function retryMailOnHeard() {
	if (_mailHeardArmed) return;
	_mailHeardArmed = true;
	try {
		window.addEventListener('daimond:heard', function () {
			Triggers.retryMail().catch(function () { /* asked again next tick */ });
		}, { once: true });
	} catch (e) { /* the tick asks again */ }
}

/// A mail trigger that did not run, written to the trail and the debug feed: a refusal is
/// never silent, or a device whose triggers have stopped cannot be told from a quiet inbox.
function trailTrigger(what, d) {
	var text = what + (d === undefined ? '' : ': ' + String((d && d.message) || d));
	diag('trigger', text);
	try { window.DaimondTrail.note('trigger', text); } catch (e) { /* no trail is not an error */ }
}

/// Write a folder's mark just under an arrival refused before it could be claimed, when
/// the folder has none yet, so `owedByMark` still finds it after a reload. Best effort:
/// one write per folder, once.
function seedMailMark(id, occasion) {
	if (!mailClaimId(id, occasion) || !window.DaimondLease || !DaimondLease.mark
		|| !window.DaimondPeer || !DaimondPeer.syncCas) return;
	var gen = mailGen(occasion.uidValidity), key = mailMarkKey(id, occasion);
	var have = DaimondLease.record ? DaimondLease.record(key) : null;
	if (have && typeof have.mark === 'number' && !have.retired && (+have.gen || 0) === gen) return;
	var lo = 0;
	occasion.uids.forEach(function (x) { if (+x > 0 && (!lo || +x < lo)) lo = +x; });
	DaimondLease.mark(key, gen, lo - 1, DaimondPeer.syncCas(peerSyncShim()), leaseClockNow, true)
		.catch(function () { /* asked again at the next refusal */ });
}

/// Keep a won claim live while its turn runs: renewed every `RENEW_EVERY_MS` to one TTL
/// ahead, its mode held, so other devices read a slow turn as running and a dead one as
/// lapsed. Answers the stop.
function keepMailClaim(claim) {
	if (!claim || !claim.tid) return function () {};
	_mailRunning[claim.tid] = 1;
	var every = (window.DaimondLease && DaimondLease.RENEW_EVERY_MS) || 30000;
	var timer = setInterval(function () {
		return DaimondLease.renew(claim.tid, claim.self, claim.cas, leaseClockNow, { hold: true })
			.catch(function () { /* the next renew, or the claim lapses */ });
	}, every);
	return function () { clearInterval(timer); delete _mailRunning[claim.tid]; };
}

/// End this device's claim on an arrival: when its turn answered it, the folder's mark is
/// raised through it FIRST, so a page that dies after it leaves the arrival answered, then
/// the claim is settled; when it did not run, released unsettled, so whichever device asks
/// next may.
///
/// A TURN THAT RAN AND FAILED (`answered` false, review R569 B-1) settles the claim but
/// leaves the mark down. The settled claim keeps this tid from running again at once; it
/// is read as gone after the lease life (`leaseTakeFromCas`), and `owedByMark` owes the
/// arrival again. Each device runs one arrival at most `MAIL_TRIES_MAX` times (`_mailTries`,
/// post-QA r569qa2 Q4), so a failure seen on Pending is retried a bounded number of times
/// rather than marked answered for good: past the bound it waits for the next arrival,
/// whose turn reads the whole mailbox and whose answer raises the mark over it. A turn the
/// person `stopped` is not counted: it failed at nobody's hand but theirs.
async function settleMailClaim(claim, went, answered, stopped) {
	if (!claim || !claim.tid) return;
	if (went && !answered && !stopped) _mailTries[claim.tid] = (_mailTries[claim.tid] | 0) + 1;
	try {
		if (went && answered && claim.mark) {
			await DaimondLease.mark(claim.mark.key, claim.mark.gen, claim.mark.upTo, claim.cas, leaseClockNow);
		}
		if (went) await DaimondPeer.settleLease('mail', claim.tid, claim.self, 'done', claim.cas, leaseClockNow);
		await DaimondPeer.settleLease('mail', claim.tid, claim.self, 'released', claim.cas, leaseClockNow);
	} catch (e) { /* the claim lapses at its deadline */ }
}
/// What this device owes from the marks: for each folder a live mail action watches, the
/// mail it holds above the folder's answered mark, in the same generation, put back on
/// `_mailOwed`. That is how an arrival survives a reload, or a winner that died, with
/// nothing remembered here. No mark yet is owed nothing: what a folder held before any
/// arrival was claimed is a baseline, as `mail.js` treats a first fetch.
///
/// A PAUSED ACTION NEVER FIRES, LATE OR NOT (r569 A4). While no action on a folder is live
/// here, its floor follows the mail held, so what arrived in the pause is owed nothing
/// when it is released. The floor is this device's, not the synced mark: a release is
/// given per device, and an action live on another device still owes that mail there.
function owedByMark() {
	if (!window.DaimondMail || !DaimondMail.held || !window.DaimondLease || !DaimondLease.record) return;
	var floors = mailFloors(), next = {}, seen = {};
	Object.keys(_triggers).forEach(function (id) {
		(Triggers.of(id) || []).forEach(function (t) {
			if (!t || t.kind !== 'mail' || !t.mailbox) return;
			var k = id + '\u0000' + t.mailbox + '\u0000' + (t.folder || '');
			var live = DaimondTriggers.allowed(id, t);
			if (seen[k]) { seen[k].live = seen[k].live || live; return; }
			seen[k] = { id: id, mailbox: t.mailbox, folder: t.folder || '', live: live };
		});
	});
	Object.keys(seen).forEach(function (k) {
		var w = seen[k], occ = { mailbox: w.mailbox, folder: w.folder };
		var h = DaimondMail.held(w.mailbox, w.folder), m = DaimondLease.record(mailMarkKey(w.id, occ));
		var gen = h ? mailGen(h.uidValidity) : 0, top = h ? (+h.lastUid || 0) : 0;
		var mark = (m && typeof m.mark === 'number' && !m.retired && (+m.gen || 0) === gen) ? m.mark : null;
		if (!w.live) { if (h) next[k] = { gen: gen, uid: top }; return; }
		var fl = floors[k], floor = (fl && fl.gen === gen) ? +fl.uid || 0 : 0;
		if (mark !== null && floor > mark) next[k] = fl;	// kept until the mark passes it
		if (_mailOwed[k] || mark === null || top <= Math.max(mark, floor)) return;
		_mailOwed[k] = { id: w.id, mailbox: w.mailbox, folder: w.folder, uids: [top], uidValidity: gen };
	});
	mailFloorsWrite(next);
}

/// This device's mail floors, by Diamond, mailbox and folder: `{ gen, uid }`, the mail
/// held while every action on the folder was paused here.
var MAIL_FLOOR_KEY = 'daimond.mail.floor';
var _mailFloor = null;

function mailFloors() {
	if (!_mailFloor) {
		try { _mailFloor = JSON.parse(localStorage.getItem(MAIL_FLOOR_KEY) || '{}') || {}; }
		catch (e) { _mailFloor = {}; }
	}
	return _mailFloor;
}

/// Replace the floors; only folders an action still watches are passed, so the record
/// stays bounded.
function mailFloorsWrite(next) {
	var was = JSON.stringify(mailFloors()), now = JSON.stringify(next);
	_mailFloor = next;
	if (now === was) return;
	try {
		if (now === '{}') localStorage.removeItem(MAIL_FLOOR_KEY);
		else localStorage.setItem(MAIL_FLOOR_KEY, now);
	} catch (e) { /* private mode: held in memory for this page */ }
}

/// Retire the answered marks of a Diamond's folders that no mail action of it watches
/// any more (r569 A3): an action deleted or moved to another folder, or, with no
/// actions, the Diamond itself destroyed (`gone`). Best effort: a door that cannot be reached
/// leaves the mark, which the next save asks again.
export function pruneMailMarks(id, gone) {
	if (!id || !window.DaimondLease || !DaimondLease.retire || !window.DaimondPeer || !DaimondPeer.syncCas) return;
	var keep = {};
	((!gone && _triggers[id] && _triggers[id].actions) || []).forEach(function (t) {
		if (t && t.kind === 'mail' && t.mailbox) keep[mailMarkKey(id, { mailbox: t.mailbox, folder: t.folder || '' })] = 1;
	});
	DaimondLease.retire('mark:mail:' + id + ':', keep, DaimondPeer.syncCas(peerSyncShim()), leaseClockNow)
		.catch(function () { /* asked again at the next save */ });
}
// page-split: install 108

export var Triggers = {
	/// This Diamond's actions, from the cache.
	of: function (id) {
		return (_triggers[id] && _triggers[id].actions) || [];
	},

	/// Read one Diamond's file. An absent file means the defaults, which is
	/// now NO actions: a Diamond nobody has automated acts when it is prompted
	/// and at no other time.
	load: async function (id) {
		var raw = null;
		try {
			var text = await Wasm.store_read(triggersPath(id));
			if (text && text.trim()) raw = JSON.parse(text);
		} catch (e) { raw = null; }
		_triggers[id] = raw
			? DaimondTriggers.normalise(raw)
			: DaimondTriggers.defaults();
		// A file that was READ: an action no longer in it takes its release here
		// with it. Not on a read that failed, which would drop every release on a
		// Diamond for a store that merely did not answer.
		if (raw) {
			try {
				DaimondPause.pruneHere(id,
					_triggers[id].actions.map(function (t) { return DaimondTriggers.node(id, t.id); }));
			} catch (e) { /* module not up */ }
		}
		return _triggers[id];
	},

	/// Read every Diamond's, for the tick and the pause tree.
	reload: async function () {
		var ids = (pg.diamonds || []).map(function (f) { return f.id; });
		var had = ids.filter(diamondAutomated).join();
		for (var i = 0; i < ids.length; i++) await Triggers.load(ids[i]);
		// A Diamond that has gone takes its cache with it, or the tree keeps a
		// branch for something nobody can reach.
		Object.keys(_triggers).forEach(function (id) {
			if (ids.indexOf(id) === -1) delete _triggers[id];
		});
		// THE RAIL, for the reason `save` gives: whether a tile carries a light
		// depends on whether its Diamond has actions, and the walk draws the rail
		// BEFORE it reads them. An action that arrived by sync or a daimon's file
		// write, held, had no light on its tile until something else redrew it.
		if (ids.filter(diamondAutomated).join() !== had) {
			try { renderDiamondList(); } catch (e) { /* nothing drawn yet */ }
		}
		repaintPause();
	},

	/// Write one Diamond's file, through the store door so a folder open in the
	/// workspace cannot capture it.
	save: async function (id) {
		var rec = _triggers[id] || DaimondTriggers.defaults();
		await Wasm.store_write(triggersPath(id), JSON.stringify(rec, null, '\t') + '\n');
		bumpDiamonds();
		// THE RAIL, not only the lights. Whether a Diamond's tile carries a
		// traffic light at all now depends on whether it has any actions, so
		// adding the first one and deleting the last one both change the tile
		// itself -- and `repaintPause` only repaints widgets that are already
		// drawn. `bumpDiamonds` tells the other TABS; nothing told this one.
		// Cheap on purpose: `renderDiamondList` redraws from the Diamonds
		// already in hand, where `loadDiamonds` would walk the store again --
		// seven seconds of it on the phone, for a fact we have just written.
		try { renderDiamondList(); } catch (e) { /* nothing drawn yet */ }
		repaintPause();
	},

	/// Add, change or drop one action, and write the file.
	///
	/// The app's own editor is the one caller, so a change made here is the
	/// person in front of it, and a release they gave on this device follows
	/// the action to what it now says. `carry` moves only a release that was
	/// good for the action before the edit: a new action arrives held, as it
	/// does from a daimon's file tool or a sync.
	set: async function (id, action) {
		// An action with no id is named by the next READ of the file (`normalise`),
		// so until then its leaf here is one the file never names: a release given
		// to it was pruned by the reload after the next turn (Q21). Every caller names it.
		if (!action || !action.id) throw new Error('Triggers.set: the action for Diamond ' + id + ' has no id');
		var rec = _triggers[id] || (_triggers[id] = DaimondTriggers.defaults());
		var i = rec.actions.findIndex(function (t) { return t.id === action.id; });
		if (i >= 0) {
			try {
				DaimondPause.carry(DaimondTriggers.node(id, action.id),
					DaimondTriggers.terms(rec.actions[i]), DaimondTriggers.terms(action));
			} catch (e) { /* module not up: the edit leaves it held, which is safe */ }
		}
		if (i >= 0) rec.actions[i] = action; else rec.actions.push(action);
		await Triggers.save(id);
		pruneMailMarks(id);	// an action moved to another folder leaves the old one's mark
	},
	remove: async function (id, actionId) {
		var rec = _triggers[id];
		if (!rec) return;
		rec.actions = rec.actions.filter(function (t) { return t.id !== actionId; });
		try { DaimondPause.forget(DaimondTriggers.node(id, actionId)); }
		catch (e) { /* module not up */ }
		await Triggers.save(id);
		pruneMailMarks(id);
	},

	/// Fire every action of every Diamond that this occasion is due on.
	///
	/// One turn per Diamond at most, however many of its actions matched: two
	/// instructions arriving as two turns is two bills and a daimon answering
	/// itself, and the second is what a conductor does when it is confused.
	/// The one that waits keeps what it accrued and goes first on the next
	/// tick, since only the one that fired has its clock restarted -- so two
	/// due timers on one Diamond alternate rather than the earlier in the file
	/// winning for ever.
	///
	/// Returns what ACTUALLY DISPATCHED, as `{ id, actionId }`. Three refusals
	/// here are silent by design -- the Diamond's model cannot run, a turn is
	/// already in flight, the Diamond is not the one on screen -- and a caller
	/// has no other way to tell a refusal from a firing. It needs to: a timer
	/// that was refused must keep the time it accrued and try again, where one
	/// that fired starts from zero. Working it out by asking `due` a second
	/// time cannot do it, because `due` is pure and can see neither a busy
	/// crystal nor which Diamond is on screen -- it would report the refused TA
	/// as owed and the clock would be zeroed anyway.
	fire: async function (occasion) {
		var fired = [];
		var ids = Object.keys(_triggers);
		for (var i = 0; i < ids.length; i++) {
			var id = ids[i];
			// A retried mail occasion is owed to the Diamonds that refused it, and
			// only to them: the others have already answered it.
			if (occasion.ids && occasion.ids.indexOf(id) < 0) continue;
			var f = (pg.diamonds || []).find(function (x) { return x.id === id; });
			if (!f) continue;
			var owed = DaimondTriggers.due(id, Triggers.of(id), occasion);
			if (!owed.length) continue;
			// The Diamond's own model has to be able to run, exactly as a hand
			// steer checks. A trigger that opened the settings dialog on a timer
			// would be the worst possible moment to ask.
			var mail = occasion.kind === 'mail';
			var arrival = mail ? id + ' ' + (occasion.mailbox || '') + '/' + (occasion.folder || '') : '';
			if (!diamondCanRun(id)) {
				if (mail) trailTrigger('mail held', arrival + ' cannot run');
				oweMail(id, occasion); seedMailMark(id, occasion); continue;
			}
			var t = owed[0];
			// ONE ARRIVAL IN FLIGHT PER FOLDER HERE (MAIL-TWICE), taken before the first await
			// and given back only once the settle has raised the mark: see `_mailRunning`.
			var folder = mail ? id + '\u0000' + (occasion.mailbox || '') + '\u0000' + (occasion.folder || '') : '';
			if (mail && _mailRunning[folder]) {
				trailTrigger('mail held', arrival + ' an arrival of this folder is in flight here');
				oweMail(id, occasion); continue;
			}
			if (mail) _mailRunning[folder] = 1;
			var claim = null, msg = null, out = null;
			try {
				// ONE DEVICE PER ARRIVAL (MO-1): a mail occasion is claimed before it runs.
				claim = mail ? await claimMailArrival(id, occasion) : null;
				if (claim && claim.drop) {
					if (claim.why !== 'settled') trailTrigger('mail dropped', arrival + ' why=' + claim.why);
					continue;
				}
				if (claim && !claim.go) {
					trailTrigger('mail held', arrival + ' claim not won why=' + claim.why);
					oweMail(id, occasion); continue;
				}
				msg = DaimondTriggers.compose(t, occasion.said);
				var stop = keepMailClaim(claim);
				// A turn that threw may still have run, so it settles as one that went; it answered
				// the arrival only when it ran through and the judgement found no failure (B-1).
				try { out = await steerFromTrigger(f, msg.text, t); }
				finally {
					stop();
					if (claim) await settleMailClaim(claim, !out || out.went, !!out && out.went && !out.failed, !!out && out.stopped);
				}
			} finally {
				if (mail) delete _mailRunning[folder];
			}
			// Run by another device (`claimTimerFire`): fired, so its stopwatch restarts here too.
			if (out.elsewhere) { fired.push({ id: id, actionId: t.id }); continue; }
			if (!out.went) {
				if (mail) trailTrigger('mail held', arrival + ' turn not gone');
				oweMail(id, occasion); continue;
			}
			fired.push({ id: id, actionId: t.id });
			// One turn answers whatever has arrived, so a folder this turn has answered is
			// owed nothing more: an arrival refused earlier would be a second turn (MO-2).
			if (occasion.kind === 'mail') {
				delete _mailOwed[id + '\u0000' + (occasion.mailbox || '') + '\u0000' + (occasion.folder || '')];
			}
			// What the turn SAID, offered to the Pending panel. Last of the three
			// things a firing does, because it is the only one that can be skipped
			// without the others being wrong: a turn that found nothing still fired,
			// still consumed its clock and still recorded its context.
			// Not for mail: its one way to Pending is `pending_raise`, so one arrival makes at
			// most one item, and its words are never offered as a second (review R569 R4).
			if (occasion.kind !== 'mail') proposeFromTurn(f, t, out.reply);
			// Only now. A refused or failed dispatch must not consume the one
			// chance the context had to be delivered.
			if (msg.sentContext !== t.contextSent) {
				t.contextSent = msg.sentContext;
				await Triggers.save(id);
			}
		}
		return fired;
	},

	/// Ask again every mail occasion a Diamond refused, each of the Diamond that
	/// refused it alone. Taken off the list first, so one that is refused again is
	/// put back by `fire` and one that is no longer due -- its leaf paused, its
	/// action deleted -- is simply dropped: a paused action never fires, late or not,
	/// and `owedByMark` owes nothing for what arrived while it was paused.
	///
	/// Nothing is dropped on the clock: an entry goes when it runs, or when its claim reads
	/// the folder's mark and finds it answered.
	retryMail: async function () {
		owedByMark();
		var keys = Object.keys(_mailOwed);
		for (var i = 0; i < keys.length; i++) {
			var o = _mailOwed[keys[i]];
			delete _mailOwed[keys[i]];
			await Triggers.fire({ kind: 'mail', mailbox: o.mailbox, folder: o.folder, ids: [o.id],
				uids: o.uids, uidValidity: o.uidValidity });
		}
	},
};

// ── Held here until released here ───────────────────────────────
//
// Since 2026-09-24 a triggered action runs only where a person released it
// (`releasedHereOnly` in pause.js). The stored state from before cannot prove
// where an action was released -- the pause record travels between devices, so a
// leaf it does not hold may have been released here, released elsewhere, or never
// seeded at all -- so every action that was live before arrives held, as marks
// went out of force at the deploy of 2026-09-23. This says so ONCE per device,
// naming them, rather than leaving a timer that simply stopped.
//
// ONLY ON A DEVICE THAT RAN THE OLD RULE. A device on its first boot of the
// account has run nothing, so there is nothing to tell it, and it is marked told
// on its first walk, before a pull or a seed can bring it a Diamond. Asked of the
// synced record, as it was until the P6 regression of 2026-09-24, a device that
// joined later was told its actions "ran here before" whenever the seed's hold on
// a default's action had lost the merge -- which it may, a seed made before the
// first pull being stamped below any press made elsewhere (FA, `seedEntry` in
// pause.js) -- and the modal that told it took the person's next click (`verify_markshere_sync`,
// P6). `DEFAULTS_KEY` is the mark of a boot that has finished reading the rail:
// every device writes it on its first, after the walk that asks this -- with an
// account or before one, since a browser that is paired later has booted too.
var TRIG_HERE_NOTICE_KEY = 'daimond-trig-here-notice';

function noteTriggersHeldHere() {
	if (!window.DaimondPause || !window.DaimondTriggers) return;
	var booted = false;
	try {
		if (localStorage.getItem(TRIG_HERE_NOTICE_KEY)) return;
		booted = localStorage.getItem(DEFAULTS_KEY) === '1';
	} catch (e) { return; }
	if (!booted) {
		try { localStorage.setItem(TRIG_HERE_NOTICE_KEY, '1'); } catch (e) { /* asked again next walk */ }
		return;
	}
	if (!(pg.diamonds || []).length) return;
	var paused = {};
	DaimondPause.pausedIds().forEach(function (k) { paused[k] = true; });
	var lines = [];
	Object.keys(_triggers).forEach(function (id) {
		var f = (pg.diamonds || []).find(function (x) { return x.id === id; });
		if (!f) return;
		Triggers.of(id).forEach(function (ta) {
			var leaf = DaimondTriggers.node(id, ta.id);
			// What would have run before: ready, and not held on the tree.
			if (!DaimondTriggers.ready(ta) || paused[leaf]) return;
			if (!DaimondPause.isPaused(leaf, DaimondTriggers.terms(ta))) return;
			lines.push((f.name || t('rail.unnamed_diamond')) + ': ' + triggerLabel(ta));
		});
	});
	try { localStorage.setItem(TRIG_HERE_NOTICE_KEY, '1'); } catch (e) { /* shown again next load */ }
	if (!lines.length) return;
	noticeDialog(t('trig.here_title'), t('trig.here_body') + '\n\n' + lines.join('\n'), { pre: true });
}

// ── What a triggered turn LEAVES BEHIND ─────────────────────────
//
// A triggered turn's answer had nowhere to go. It went into that Diamond's own
// chat record, which is correct and is also a thread nobody opens: the whole
// point of a timer is that it runs while the user is doing something else, so
// its findings arrived in a conversation they were by definition not in. The
// Optimiser had run exactly once in the app's life, by hand, and had never in
// its life put anything in front of anybody.
//
// So the reply is offered to the Pending panel, which is the one surface this
// app has for "here is a thing to do about your account, and three answers".
// See the Pending header for why a kind may only come back with its producer;
// this function IS that producer.
//
// THE SHAPE IS THE INSTRUCTION'S. The action tells the daimon to state one
// finding as a title line and the evidence beneath it, or to say in one line
// that nothing stands out -- so the first line is the headline, the rest is the
// detail, and the one-line refusal raises nothing. Nothing here parses the
// model's prose beyond that split: a producer that tried to understand a
// finding would be a second, worse reader of it standing between the daimon and
// the user, and the user can read.

/// The one-line "nothing stands out" the instruction asks for, in the shapes a
/// model actually writes it in.
///
/// ONE LINE AND THE WORD, both. A finding whose headline happens to contain
/// "nothing" -- "nothing records what a worker cost" is a finding -- is a
/// finding, and it has evidence under it; the refusal has nothing under it.
var NOTHING_STANDS_OUT =
	/\bnothing\b[^.\n]*\b(stands? out|stood out|to report|of note|worth reporting)\b/i;

/// Is this reply the daimon declining to find anything?
function nothingStandsOut(text) {
	var lines = String(text || '').split('\n').filter(function (l) { return l.trim(); });
	return lines.length === 1 && NOTHING_STANDS_OUT.test(lines[0]);
}

/// The headline, taken off a title line a model may have dressed as markdown.
///
/// `#`, `**` and a leading bullet are the three it reaches for unprompted. They
/// are stripped rather than rendered, because a Pending headline is drawn with
/// `textContent` -- so left on, they would be shown as the characters they are.
function headlineOf(line) {
	return String(line || '')
		.replace(/^[\s>#*_-]+/, '')
		.replace(/[\s*_]+$/, '')
		.trim()
		.slice(0, 200);
}

/// Offer what a triggered turn said to the Pending panel.
///
/// Silent in every case where there is nothing honest to raise, and each
/// silence is a decision:
///
///   * UNDER THE AUTONOMOUS POSTURE, nothing. That posture is this computer
///     finishing what it was dispatched without asking, and a turn run under it
///     is a turn nobody watched -- so its words are not a proposal put to
///     somebody, and a tile claiming otherwise would be the app answering its
///     own question. It is also the posture under which `egressAllowed` waves
///     a publication through, which is the other half of the same reasoning.
///   * NOTHING SAID, nothing raised. A turn that only edited files has already
///     done its work.
///   * "Nothing stands out", nothing raised. A quiet week needs no findings, and
///     an Optimiser that always finds three things is inventing them.
///
/// # Arguments
/// * `f` - The Diamond whose turn this was, named on the tile.
/// * `ta` - The action that fired it.
/// * `reply` - The turn's final assistant prose.
function proposeFromTurn(f, ta, reply) {
	try {
		if (autonomousPosture()) return;
		var text = String(reply || '').trim();
		if (!text || nothingStandsOut(text)) return;
		var lines = text.split('\n');
		var headline = headlineOf(lines.shift());
		if (!headline) return;
		// The rest, whole. It is the evidence the instruction asked for, and the
		// tile expands to show it; cut only against a localStorage quota, since
		// `Pending.save` is the thing that would fail.
		var detail = lines.join('\n').trim().slice(0, 4000);
		Pending.add({
			kind:        'proposal',
			diamondId:   f.id,
			diamondName: f.name || '',
			headline:    headline,
			detail:      detail,
			// The daimon that raised it sets the priority (Pending's §5.3), and
			// nothing in a triggered instruction asks one for. So: normal, and the
			// user may override it on the tile.
			priority:    'normal',
			// The answer's record, when this reply is the one the turn just gave.
			prod:        (_lastSteer[f.id] && _lastSteer[f.id].reply === reply)
				? (_lastSteer[f.id].prod || null) : null,
		});
	} catch (e) { /* a panel that will not draw must not fail the turn */ }
}

// ── The two Diamonds that are there when you arrive ──────────────
//
// Notes2: "Lets create two default diamonds, 'Daimond Help' and 'Daimond
// Optimiser'. They have no special functionality different to a user-created
// diamond, and can be deleted by the user. Default diamonds start paused."
//
// Three things follow, and all three are the point:
//
//   * ORDINARY. They are made through `create_diamond` like any other, with
//     an ordinary crystal and an ordinary daimon. Nothing reads a flag on
//     them, and deleting one deletes it.
//   * PAUSED. Seeded paused at the leaf (`seedPaused`), not by setting a
//     branch — pause.js is explicit that a branch has no state and that
//     something which must start paused is seeded when it is created.
//   * ONCE. A user who deletes one has said something, and an app that put it
//     back on the next boot would be arguing. The flag records that they were
//     OFFERED, not that they exist.
// The `-2` is a one-time re-ask, and it is deliberate. Every account that was
// already using the app when this feature shipped had the old flag written
// against a rule that then refused to seed -- the rail was not empty -- so the
// offer was recorded as made and never was. Bumping the name asks those
// accounts once more, now that the rule is right. Nobody gets a duplicate: the
// name check in `seedDefaultDiamonds` skips a Diamond that is already there.
var DEFAULTS_KEY = 'daimond-defaults-seeded-2';

// ── The two defaults are seeded AT A FIXED ID ─────────────────────────
//
// Reported live: several copies of the two built-in tiles in one rail. The cause
// is a sync meeting a per-device flag. `DEFAULTS_KEY` lives in `localStorage`, which does not
// travel, so every device seeds these two for itself; `create_diamond` minted a RANDOM id, so
// two devices produced two Optimisers with different ids and the merge -- correctly, knowing
// nothing about names -- kept both. A third device would have made a third.
//
// The name check below cannot catch it: it reads the local list, and the other device's copy
// has not arrived when the check runs.
//
// A fixed id makes two devices create the SAME object, so the merge has one thing to keep
// rather than two to add. `create_diamond_at` is idempotent, so the second device's call finds
// the meta already written and returns without touching a crystal the first may have grown.
//
// The ids are deliberately unmistakable rather than hashed: they are hex, in the shape
// `generate_session_id` produces, and anybody reading a store can see at a glance that these
// two were not minted by a clock.
//
// The KEYS are the names they are seeded under, and NEVER what identifies one (NAMES N1): a
// built-in is its fixed id or the `builtin` marker in its own record (`builtInSlot`), because
// Neil and Lucy are names a person gives their own Diamonds. NAMES (D-20261015-12) renamed
// them; `LEGACY_NAMES` maps the names they were seeded under before, which `markBuiltIns`
// uses with the crystal to prove an old random-id copy, and `renameLegacyBuiltIns` moves a
// proved built-in's tile to the new name.
export var DEFAULT_IDS = {
	'Neil': '0da1000000e1',
	'Lucy': '0da1000000f2',
};
var LEGACY_NAMES = {
	'Daimond Help':      'Neil',	// names-gate: legacy (verify_names skips this line)
	'Daimond Optimiser': 'Lucy',	// names-gate: legacy
};
// page-split: install 109

// ── WHAT THE OPTIMISER MAY NOT DO ───────────────────────────────
//
// It is an ordinary Diamond and stays one -- "no special functionality", per
// notes2 -- but it is the only Diamond in this app that RUNS WITHOUT BEING
// ASKED, on a timer, while nobody is looking at it. Two things on the daimon
// belt are unsafe under exactly that condition, and neither is unsafe for any
// other Diamond, so what is withheld is withheld from THIS ONE.
//
//   * `social_send` PUBLISHES IN THE USER'S NAME on a public forge. Every call
//     is put to the user first -- except under the autonomous posture, whose
//     whole purpose is to answer an unattended turn's questions without a
//     dialog (`egressAllowed`). An unattended turn is precisely what a timer
//     produces, so the two features compose into a publication nobody saw.
//     (This one turned out not to be particular to the Optimiser at all; see
//     `diamondMayPublish`, which now answers it for every Diamond.)
//   * `spawn_agent` DISPATCHES WORKERS, which is how a turn reading a 2 KB
//     digest becomes a bill. The instruction forbids it; the instruction is
//     text, and text is advice.
//
// **THE BELT ITSELF IS PER ROLE AND NOT PER DIAMOND**, and that is the shape of
// the thing rather than an oversight: `Tool::daimon()` in `src/tools.rs` is one
// vector every daimon shares, and `ToolRegistry::offered` filters it by the
// account's packs, the machine, the model family and the turn's supervision --
// never by which Diamond is steering, because the engine is not told. Nothing
// short of a wasm change can take a tool out of the schema for one Diamond.
//
// So these are withheld where this side actually decides: at the two doors the
// acts pass through on their way out, both of which are in this file and both
// of which already own the refusal. It is the smallest honest withholding
// available without a new engine surface, and it fails CLOSED -- see
// `publishWithheld`.
//
// PUBLISHING IS NO LONGER ONE OF THEM, and not because the Optimiser may: since
// 2026-09-15 no Diamond's daimon publishes in the user's name, so a per-Diamond clause
// here would be a second rule saying the same thing about one of them. See
// `diamondMayPublish`. What is left is the worker cap, which IS particular to this one.
var WITHHELD = {};
// page-split: install 110

/// May this Diamond's daimon publish on the Social panel?
///
/// **NO, AND THAT IS THE RULE RATHER THAN A SETTING.** It was the other way round -- every
/// Diamond could publish and the "Publish this?" dialog was what stood between a daimon and
/// the forge -- until 2026-09-15, when the owner's own daimon, given a forge proposal to work
/// on, called `social_send` with a comment in his name. The card rose on a tab he was not
/// looking at, nothing answered it, and the turn sat there until he was told about it.
///
/// The dialog is the wrong instrument for this one act. A publication is the user's name on
/// something strangers read, it happens once, and it cannot be taken back -- and a daimon is
/// the turn the user is LEAST likely to be watching: it runs on a trigger, on a timer, or
/// while they are reading something else. What the daimon can do instead costs nothing and
/// loses nothing: say what it would publish, in its answer, where they will read it and can
/// publish it themselves from the Social panel in one press. `DaimondPublishGuard` is where
/// that is put to the model, and it is put as the REMEDY rather than as a rule, because a
/// refusal whose remedy is out of the model's reach becomes a loop.
///
/// THE USER'S OWN CHAT IS UNTOUCHED. No Diamond is steering there, so nothing here answers
/// and `egressAllowed` asks exactly as it always has: they typed the sentence that led to
/// it and they are at the screen.
///
/// It keeps its `id` and stays a function of one, because the caller asks it per Diamond
/// (`publishWithheld` sweeps the turns in flight) and because the answer was once per
/// Diamond -- see `WITHHELD`, which withheld this from the Optimiser alone.
export function diamondMayPublish(id) {
	return false;
}

/// How many workers may this Diamond's daimon dispatch at once? Everything but
/// a withheld Diamond answers `Infinity`, which is the cap the app has always
/// had -- the governor prices a fan-out, and nothing counts it.
export function diamondWorkerCap(id) {
	var w = WITHHELD[String(id || '')];
	return (w && typeof w.workers === 'number') ? w.workers : Infinity;
}

/// Is a publication being asked for on behalf of a Diamond that may not make
/// one?
///
/// **ASKED OF THE TURNS IN FLIGHT, because the question that reaches this side
/// carries no Diamond.** `social_send` composes through
/// `window.DaimondSocial.compose` and asks through `egress_allowed_publish`,
/// and neither hands over an actor: the engine knows whose turn it is and the
/// wire between them does not say. What this side does know is which Diamonds
/// have a daimon turn running, because it marked them itself (`crystalRunning`).
///
/// So the answer is FAIL-CLOSED: if a Diamond that may not publish is mid-turn,
/// no publication goes out, even in the rare case where a second Diamond is
/// steering at the same time and the call is that one's. A refusal a model can
/// read and re-put a minute later is the cheap error; a post in somebody's name
/// that nobody saw is the expensive one.
export function publishWithheld() {
	for (var id in crystalRunning) {
		if (crystalRunning[id] && !diamondMayPublish(id)) return true;
	}
	return false;
}

var DEFAULT_DIAMONDS = [
	{
		name: 'Neil',
		// What the seed's opening said before NAMES, and says now: `legacySeedCrystal`.
		was: ['# Daimond Help\n\nAsk me', '# Neil\n\nI am Neil, Daimond\'s help. Ask me'],	// names-gate: legacy
		crystal: '# Neil\n\n'
			+ 'I am Neil, Daimond\'s help. Ask me how Daimond works. I answer from this build itself: its '
			+ 'panels, its tools, its settings.\n\n'
			+ 'The user guide is mirrored at `system/guide/`, one file per page. '
			+ 'Search it before answering, and say which page an answer came from.\n\n'
			+ '## What I know\n\n'
			+ '- Nothing yet. Press play, ask a question, and this fills in.\n',
		// Granted sight of system/guide. See writeGuideMirror.
		guide: true,
		triggers: [],
	},
	{
		name: 'Lucy',
		was: ['# Daimond Optimiser\n\nI find', '# Lucy\n\nI am Lucy, Daimond\'s optimiser. I find'],	// names-gate: legacy
		crystal: '# Lucy\n\n'
			+ 'I am Lucy, Daimond\'s optimiser. I find what should have been written down, what should have been '
			+ 'cheaper and what should have been automatic, and I hand you the '
			+ 'change to make.\n\n'
			+ 'I read `system/usage/digest.md`: counts of turns, spend, models '
			+ 'and tool calls, kept on this device. I never see what any '
			+ 'conversation was about.\n\n'
			+ '## How to start me\n\n'
			+ 'I am stopped until you say otherwise. Open my settings with the cog on '
			+ 'my tile, find the action "After 30 minutes of your activity", and press '
			+ 'play on the light beside it. After that I read the digest every half '
			+ 'hour you actually work, and anything I find arrives as a tile in the '
			+ 'Pending panel -- wherever you happen to be.\n\n'
			+ '## What I have noticed\n\n'
			+ '- Nothing yet.\n',
		// Notes2 asks for this one specifically: "the Daimond Optimiser starts
		// with an inactive 'Minutes of User Activity' TA, set for every 30 min."
		// Inactive means its pause leaf is seeded held (see the loop in
		// `seedDefaultDiamonds`), and NOT `on: false` in the record: the tree
		// is the switch the light throws, and a record switched off beside it
		// is a second switch nothing in the app can reach. See the `+` handler
		// in `mountTriggers` for what that cost.
		// Granted sight of system/usage, where the signal index writes what it
		// has counted. See writeUsageDigest.
		usage: true,
		// `offScreen` because this one's answer does not go to a thread: it goes
		// to the Pending panel, where the user meets it whatever they were doing
		// (`proposeFromTurn`). Without it the action could only ever fire while
		// the Optimiser itself was the Diamond on screen -- and nobody sits
		// looking at the Optimiser, so in the app's whole life it never fired
		// once.
		triggers: [{
			kind: 'activity', minutes: 30, offScreen: true,
			// THE SHAPE IS PART OF THE INSTRUCTION, because the first line becomes
			// a headline on a tile and everything under it becomes the evidence
			// behind that headline. And the two refusals are the ones this Diamond
			// gets wrong when it is not told: naming the user's reaction rather than
			// the defect (`www/js/signals.js` -- detect, never mention), and
			// answering a question about the account by dispatching a team to it.
			instruction: 'Read system/usage/digest.md. State ONE finding as a title '
				+ 'line, then the evidence, citing the digest\'s number; or say in one '
				+ 'line that nothing stands out. Name the defect, never the reaction. '
				+ 'Do not dispatch workers.',
		}],
	},
];

/// Where the Optimiser reads about how the account is being used.
///
/// notes2 #51 asks for the two default Diamonds to be given a scope covering
/// what they need, and for the Optimiser that is "a lot of things, possibly
/// everything, but as a minimum all LLM sessions". A scope cannot express
/// that: a scope is workspace folders, and the ledger is `localStorage`
/// while chats are in IndexedDB. Neither is a path, so a scope naming them
/// would grant reach over nothing.
///
/// So the shape is turned around. What the Optimiser needs is WRITTEN INTO A
/// FOLDER, and the folder is what it is granted -- which it then reads with
/// the file tools it already has, with no new tool and no new capability.
export var USAGE_DIR = 'system/usage';

/// Write the digest, and make sure the Optimiser can read it.
///
/// Called after a turn, after a burst of ratings and on demand. The signals are counters; the
/// Ratings section is the account's rating cells (`ratingsAccount`), which read a transcript
/// only where its memo has gone stale, and the old Models-page counts close it (O4).
///
/// THROUGH `Wasm.store_write`, NEVER `Files.writeBytes` (2026-09-25). The
/// latter is `tools().write_bytes`, which lands in whatever workspace is
/// open -- so with a machine folder open the digest was rewritten onto the
/// person's own disk after every metered turn, at `<folder>/system/usage/
/// digest.md`. `system/` names none of `diamonds/`, `mail/` or `chats/`
/// (`is_store_path`, `src/tools.rs`), so nothing on the Rust side pinned it
/// to the sandbox the way a Diamond's own state is pinned; `Wasm.store_write`
/// is that pin, applied here directly. `grantConsulted`'s seed now always
/// names `dir:[browser]…`, which is in force only in the browser workspace
/// (M4) -- the one place this write and that grant now agree.
export async function writeUsageDigest() {
	if (!window.DaimondSignals) return;
	await importModelCounts();
	var tail = await ratingsDigest();
	var md;
	try {
		md = DaimondSignals.digest((pg.diamonds || []).map(function (d) {
			return { id: d.id, name: d.name };
		}));
	} catch (e) { return; }
	try {
		await Wasm.store_write(USAGE_DIR + '/digest.md', String(md).replace(/\s+$/, '') + '\n' + tail);
	} catch (e) { /* no store yet, or no room; the next turn tries again */ }
	steerRaise();		// the figures the digest just carried are the ones a proposal reads
}

/// Where Neil reads the user guide.
///
/// The guide ships INSIDE the bundle, at `www/guide/`, as HTML. A daimon's
/// file tools reach the workspace and nothing else, so Help -- the Diamond
/// whose whole job is explaining the app -- could not read the manual it
/// exists to explain. notes2 #51 asks for it to be given "the Browser
/// folders they need"; there is no such folder, so one is made.
///
/// Mirrored from `guide/search-index.js`, which already ships for the human
/// search box, so there is no second copy of the guide to drift. One file per
/// guide page rather than one big one: a daimon then searches for the page it
/// needs and reads that, instead of pulling eighty kilobytes into its context
/// to answer one question.
var GUIDE_DIR = 'system/guide';
var GUIDE_STAMP = 'daimond-guide-mirror';

/// Write the mirror, if this build has not already written it.
///
/// Keyed by build id: the guide changes with the app, so a copy made by an
/// older build is a copy that describes an app the user is no longer running.
/// Called at seeding and again on every unlock (`afterUnlock`), so an account
/// already seeded still picks up a newer build's guide; the stamp check above
/// makes every call after the first a no-op until the build changes.
///
/// THROUGH `Wasm.store_write`, NEVER `Files.writeBytes` (2026-09-25), for the
/// same reason `writeUsageDigest` is: `system/` follows the open workspace on
/// the Rust side, so a mirror written with a machine folder open landed on
/// the person's own disk at `<folder>/system/guide/`, one file per page.
export async function writeGuideMirror() {
	// Read from `build.json` rather than from whatever updater.js last
	// noticed: this has to be right on a first boot too, and on a first boot
	// nothing has noticed anything yet.
	var build = '';
	try {
		var bj = await (await fetch('build.json', { cache: 'no-store' })).json();
		build = (bj && bj.build) || '';
	} catch (e) { build = ''; }         // unstamped dev tree: mirror every boot
	try { if (build && localStorage.getItem(GUIDE_STAMP) === build) return; }
	catch (e) { return; }               // private mode: skip rather than rewrite every boot

	var idx;
	try {
		var txt = await (await fetch('guide/search-index.js', { cache: 'no-store' })).text();
		// The file is `window.GUIDE_INDEX = {...};` -- parsed rather than
		// executed, because a mirror is not a reason to run a script.
		idx = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
	} catch (e) { return; }             // no guide in this build; nothing to mirror
	var secs = (idx && idx.sections) || [];
	if (!secs.length) return;

	// Group by page, keeping the order the guide itself uses.
	var pages = {}, order = [];
	secs.forEach(function (s) {
		var p = (s.p || 'guide.html').replace(/\.html$/, '');
		if (!pages[p]) { pages[p] = []; order.push(p); }
		pages[p].push(s);
	});

	var contents = ['# The Daimond user guide',
		'',
		'A plain-text mirror of the guide that ships with this build (' + (build || 'unstamped') + ').',
		'Search these files rather than guessing; each is one page of the guide.',
		''];
	for (var i = 0; i < order.length; i++) {
		var name = order[i];
		var rows = pages[name];
		var out = ['# ' + (rows[0].t || name), ''];
		rows.forEach(function (s) {
			if (s.t) out.push('## ' + s.t);
			if (s.b) { out.push(''); out.push(s.b); }
			out.push('');
		});
		try { await Wasm.store_write(GUIDE_DIR + '/' + name + '.md', out.join('\n')); }
		catch (e) { return; }           // no store, or no room: leave the stamp unset
		contents.push('- `' + name + '.md` — ' + (rows[0].t || name));
	}
	try { await Wasm.store_write(GUIDE_DIR + '/README.md', contents.join('\n')); }
	catch (e) { return; }
	try { if (build) localStorage.setItem(GUIDE_STAMP, build); } catch (e) {}
}

/// Grant a Diamond read-only sight of a folder, the way an attachment does.
///
/// `consulted` is the relation `attachmentsOf` reads as read-only, so this
/// is the same grant a user makes by attaching a folder and marking it so --
/// not a private back door with different rules.
///
/// ALWAYS `dir:[browser]…`, NEVER `rootedRef` (2026-09-25). `system/guide` and
/// `system/usage` are written with `Wasm.store_write` now, always the app's
/// own store, so the row that grants sight of them must always name the
/// browser workspace too -- not whichever machine folder happened to be open
/// when the account was seeded. `DaimondMarksHere.seeded` already narrows the
/// grant to the browser root (M4); this is what makes the row itself agree.
async function grantConsulted(diamondId, path) {
	try {
		await diamondApp().add_link(diamondId, 'diamond:' + diamondId,
			'dir:[browser]' + path, 'consulted', '', 'user');
	} catch (e) { /* the Diamond simply will not see it; nothing else breaks */ }
}

/// Offer the two default Diamonds, once per account.
///
/// This was withheld for a release. `migrate_root` (`src/wasm/diamond.rs`) used
/// to REFUSE to move an older root -- `foci/`, `facets/` -- once `diamonds/`
/// existed, and creating a Diamond is what makes `diamonds/` exist. So seeding
/// two on the first boot of a fresh account made every LATER arrival of an old
/// store -- a restored backup, a sync from an older device, a folder adopted
/// afterwards -- unmigratable for ever, with the user's Diamonds in a directory
/// nothing reads.
///
/// `migrate_root` now MERGES the entries that do not collide, so the act of
/// creating a Diamond no longer strands anything. The two guards below stay:
/// they were right on their own terms, and one of them still is.

/// Put the SPARE copies of a seeded Diamond in the trash, and say so.
///
/// The duplicates are this app's own doing: a per-device flag plus a random id meant every
/// device seeded its own Optimiser and its own Help, and the merge kept them all. Fixed ids
/// (see `DEFAULT_IDS`) stop it happening again; they cannot undo what is already there.
///
/// **ONLY THE UNTOUCHED ONES, and to the TRASH rather than out of existence.** A copy whose
/// crystal has been folded even once, or whose daimon has been spoken to, is a Diamond
/// somebody has used, and no automatic tidy may take it — however certainly this app created
/// it by mistake. What is removed goes where a deleted Diamond goes, so a wrong call here is
/// one press to undo in the Trash panel.
///
/// It is said out loud. A rail that quietly loses two tiles is indistinguishable from a bug,
/// and this runs on a boot the user did not ask anything of.
///
/// A COPY IS ONE BY ITS FIXED ID OR ITS MARKER, never by its name (NAMES N1): a Diamond he
/// called "Lucy" himself is his. And the sweep runs BEFORE the rename, so spare copies are
/// still under the old names when it looks; the rename follows it here, every boot.
export async function sweepSeededDuplicates() {
	try { await sweepSeededSpares(); }
	finally {
		try { await renameLegacyBuiltIns(); } catch (e) { /* asked again next boot */ }
	}
}
async function sweepSeededSpares() {
	if (!window.DaimondTrash || typeof DaimondTrash.put !== 'function') return;
	var names = Object.keys(DEFAULT_IDS);
	var moved = 0, kept = 0;
	for (var n = 0; n < names.length; n++) {
		var name  = names[n];
		var group = (pg.diamonds || []).filter(function (f) { return builtInSlot(f) === name; });
		if (group.length < 2) continue;
		// What to KEEP: the copy at the fixed id if one is there, since that is the one both
		// devices will agree on from now on; otherwise the most worked-on.
		var keep = group.find(function (f) { return f.id === DEFAULT_IDS[name]; })
			|| group.slice().sort(function (a, b) {
				return (b.crystal_version || 0) - (a.crystal_version || 0)
					|| (b.updated || 0) - (a.updated || 0);
			})[0];
		for (var i = 0; i < group.length; i++) {
			var f = group[i];
			if (f.id === keep.id) continue;
			var chat = (pg.chats || []).find(function (c) { return c.diamondId === f.id; });
			// `chatMsgCount`, not `messages.length`: a daimon chat that has not been
			// opened this session is non-resident (empty `messages`, true `msgCount`),
			// and reading the array alone would take a used Diamond for an unused one
			// and trash it (seq 213, Stage 1).
			var used = (f.crystal_version || 0) > 0
				|| chatMsgCount(chat) > 0;
			if (used) { kept++; continue; }
			try { DaimondTrash.put(f.id); moved++; }
			catch (e) { /* the panel will still show it; better than throwing on boot */ }
		}
	}
	if (!moved && !kept) return;
	renderDiamondList();
	if (moved) toast(t('rail.dupes_trashed', { n: moved }), true);
	// Said separately, because it is the sentence that needs a decision: these are copies the
	// app made and the user has since worked in, so only they can say which to keep.
	if (kept) toast(t('rail.dupes_kept', { n: kept }), true);
}

/// Play the seeded default Diamonds' own conversation, on a device that ran the old
/// seed, once.
///
/// Until 2026-09-24 the seed held `self` beside the Optimiser's action, and a typed
/// turn asks `self` at dispatch, so on every account seeded before then the app's own
/// hold refused whatever the person typed there (R2 QA, F0). `self` gates only the
/// turns a person types and the work sent from them, so playing it arms nothing: the
/// action keeps its own hold and still waits for a release on this device.
///
/// ONLY ON A DEVICE THAT RAN THE OLD SEED (R3 QA, Q6-1). The flag below is per device
/// and does not travel, so the repair ran once on every device new to an account --
/// whose seed had never held `self` -- and took back a pause the person had made on
/// another device, one past its stamp, which then won on every device. A device whose
/// `DEFAULTS_KEY` was unset when this page loaded has never seeded, so it has nothing
/// to repair and is marked done: the rule the held-actions notice keeps (P6,
/// `noteTriggersHeldHere`). The key is read at load (`_seededBeforeLoad`), not here,
/// because the seed below writes it and a reorder of the boot would otherwise break
/// this without a sound.
///
/// Only the Diamonds the seed held -- those that ship with actions, found by the fixed
/// id or, on an account seeded before the fixed ids, by name -- and never a hold that
/// is a person's. `unseed` refuses one on its own, pressed on this build in any tab or
/// on any device: on `self`, on its Diamond's light, on the Diamonds branch or on the
/// global light (see `unseedEntry` in pause.js). A hold carried over from a record an
/// older build wrote says nothing of who made it, so a "Pause all" or a Diamonds-branch
/// pause made there is asked for here, as every leaf under that light held: the old
/// seed held the Optimiser's `self` and its action and nothing else, so it can never
/// hold either of those lights whole. The Optimiser's own light it did hold whole, so
/// a pause of that light carried over from an older build is taken for the seed (FC,
/// accepted: the action stays held, and the turn is one the person typed).
///
/// AFTER THE FIRST PULL, AND NOT AS A PRESS (FU QA, FA). The leaf is taken back by
/// `unseed`, one past its own entry and never by the clock, so a press made elsewhere
/// since still wins -- including one that arrives after the wait for the pull ran
/// out. Where one does, the Optimiser stays held and says so when typed into.
var SELF_PLAYED_KEY = 'daimond-default-self-played';
var _selfRepairArmed = false;
// page-split: install 111
function releaseSeededSelf() {
	try { if (localStorage.getItem(SELF_PLAYED_KEY) === '1') return; }
	catch (e) { return; }
	if (!_seededBeforeLoad) {
		try { localStorage.setItem(SELF_PLAYED_KEY, '1'); } catch (e) { /* asked again next boot */ }
		return;
	}
	if (!window.DaimondPause || _selfRepairArmed) return;	// asked again on the next boot
	_selfRepairArmed = true;
	afterFirstPull(function () {
		try {
			var P = DaimondPause;
			if (!P.heldByHand(P.ROOT) && !P.heldByHand(P.id('root', 'diamonds'))) {
				DEFAULT_DIAMONDS.forEach(function (d) {
					if (!d.triggers.length) return;
					(pg.diamonds || []).forEach(function (f) {
						if (builtInSlot(f) !== d.name) return;
						P.unseed(P.id('root', 'diamonds', f.id, 'self'));
					});
				});
			}
		} catch (e) { return; }					// module not up: asked again next boot
		try { localStorage.setItem(SELF_PLAYED_KEY, '1'); } catch (e) { /* asked again next boot */ }
	});
}

/// Has this page anything to pull from: sync loaded, an identity, and not a safe start?
function syncsHere() {
	try {
		return !!(window.DaimondSync && window.DaimondIdentity
			&& !(window.DaimondSafe && window.DaimondSafe.on())
			&& (window.DaimondIdentity.exists() || window.DaimondIdentity.everExisted()));
	} catch (e) { return false; }
}

/// Run `fn` once this session has heard from the account's other devices: after its
/// first pull has run, or at once on a device with nothing to pull from -- no
/// identity, or a safe start.
///
/// Not for ever, for the sweep's reason and after the sweep's wait: a device whose
/// gateway is down has no news coming. What runs here must therefore be safe on a
/// record older than the account's, which `unseed`'s stamp is.
function afterFirstPull(fn) {
	var done = false;
	function go() { if (done) return; done = true; fn(); }
	if (!syncsHere() || (DaimondSync.pulled && DaimondSync.pulled())) { go(); return; }
	window.addEventListener('daimond:pulled', go, { once: true });
	setTimeout(go, SWEEP_WAIT_MS);
}

/// Move a built-in still wearing its old name to its new one (NAMES, D-20261015-12).
///
/// Only a Diamond whose name is EXACTLY an old seed name, so one the person has renamed
/// themselves keeps the name they gave it. Asked on every boot, because the flag that stops
/// a second seed is per device and an old-named copy can arrive by sync at any time; with
/// nothing to do it is one scan of the list. Two devices renaming the same fixed id to the
/// same name converge, so there is nothing to coordinate.
///
/// The crystal is rewritten only where it is still the old seed's text byte for byte
/// (`refreshLegacySeedCrystal`); a worked-on crystal keeps its words.
///
/// ONLY A BUILT-IN (NAMES N1): one at a fixed id or carrying the marker. A Diamond of his own
/// that happens to bear an old seed name is his, and keeps it.
///
/// ONCE PER DIAMOND (R568-FU F2). The rename is recorded in the Diamond's own record beside
/// the marker (`builtin_named`), so it travels: a built-in he renamed back to its old seed
/// name keeps that name on every boot and every device, where it used to be renamed again on
/// the next boot.
async function renameLegacyBuiltIns() {
	var moved = false, list = (pg.diamonds || []).slice();
	for (var i = 0; i < list.length; i++) {
		var f = list[i], now = builtInSlot(f);
		if (!now) continue;
		try { await refreshLegacySeedCrystal(f, now); } catch (e) { /* asked again next boot */ }
		if (!LEGACY_NAMES[f.name] || f.builtin_named) continue;
		try { await diamondApp().name_built_in(f.id, now); f.name = now; f.builtin_named = true; moved = true; }
		catch (e) { /* asked again next boot */ }
	}
	if (moved) await loadDiamonds();
}

/// The seed text a built-in was given before NAMES, from the one it is given now.
///
/// Derived rather than kept as a second copy, so the two can differ only in the opening the
/// rename changed: `was` holds that opening, then and now. Null when the seed no longer opens
/// as `was` says, which writes nothing.
function legacySeedCrystal(d) {
	if (!d || !d.was || String(d.crystal).indexOf(d.was[1]) !== 0) return null;
	return d.was[0] + String(d.crystal).slice(d.was[1].length);
}

/// Give a built-in's crystal its new heading, ONLY while it is still the old seed's own text
/// byte for byte (NAMES N2).
///
/// The crystal is the Diamond's memory and the text its daimon reads, so the old name in its
/// heading is the name that daimon goes by. But it may have been worked on, and then every
/// word is the person's or the daimon's and none is this app's to change: an edited crystal
/// keeps its old heading. The rewrite goes through `write_crystal_data`, which snapshots a new
/// version, so the old text stays in History.
async function refreshLegacySeedCrystal(f, slot) {
	var d = (DEFAULT_DIAMONDS || []).find(function (x) { return x.name === slot; });
	var old = legacySeedCrystal(d);
	if (!old) return;
	var text = await diamondApp().read_crystal_data(f.id);
	if (text !== crystalJson(old) && text !== old) return;
	await diamondApp().write_crystal_data(f.id, crystalJson(d.crystal));
}

/// Write the lasting built-in marker on every copy that is provably one (NAMES N1).
///
/// The copies at the fixed ids are marked as they are found. One seeded at a random id, by an
/// engine too old to fix the id, is marked only on two proofs together: it still bears an old
/// seed name EXACTLY, and its crystal still names it, which the seed text did. Nobody chooses
/// "Daimond Optimiser" for a Diamond of their own, but nobody can promise it either, so the
/// name alone proves nothing. Asked on every boot, before the sweep and the rename read it;
/// with nothing to mark it is one scan of the list.
async function markBuiltIns() {
	var app = diamondApp();
	if (!app || typeof app.mark_built_in !== 'function') return;
	var marked = false, list = (pg.diamonds || []).slice();
	for (var i = 0; i < list.length; i++) {
		var f = list[i];
		if (!f) continue;
		var fixed = '';
		for (var n in DEFAULT_IDS) if (DEFAULT_IDS[n] === f.id) fixed = f.id;
		if (!fixed && !f.builtin && LEGACY_NAMES[f.name] && await legacySeedProved(f)) {
			fixed = DEFAULT_IDS[LEGACY_NAMES[f.name]];
		}
		if (!fixed || f.builtin === fixed) continue;
		try { await app.mark_built_in(f.id, fixed); f.builtin = fixed; marked = true; }
		catch (e) { /* asked again next boot */ }
	}
	if (marked) await loadDiamonds();
}

/// Does this old-named Diamond's crystal still name it, as the seed text did?
async function legacySeedProved(f) {
	var text = '';
	try { text = String(await diamondApp().read_crystal_data(f.id) || ''); } catch (e) { return false; }
	return text.indexOf(f.name) >= 0;
}

export async function seedDefaultDiamonds() {
	try { await markBuiltIns(); } catch (e) { /* asked again next boot */ }
	releaseSeededSelf();
	try { if (localStorage.getItem(DEFAULTS_KEY) === '1') return; }
	catch (e) { return; }                       // private mode: never seed twice
	// Not on an empty app that has not finished booting: a create against a
	// store that is not up would leave a half-made Diamond.
	if (!window.DaimondPause || !window.DaimondTriggers) return;
	// NOT ONLY INTO AN EMPTY RAIL, and the reasoning that said otherwise was
	// wrong about what these two ARE.
	//
	// It read them as onboarding furniture -- "so that somebody arriving does
	// not face an empty rail" -- and concluded that a person with thirteen
	// Diamonds is not that person. But Help and the Optimiser are not
	// decoration: Help is the only thing that reads the guide mirror, and the
	// Optimiser is the only thing that reads the usage digest. They are
	// FEATURES, and withholding them from everybody who was already using the
	// app meant the author himself never saw either of them -- notes3: "I do not
	// see the Daimond Help or Daimond Optimiser diamonds at all."
	//
	// So the rail's contents no longer decide it. Two things still hold the
	// line: the name check below never makes a second copy, and the flag means
	// a Diamond somebody DELETES stays deleted rather than returning at the next
	// boot.
	//
	// (`verify_diamondroot`'s reason for a guard here was never the rail's
	// contents -- it was a boot that is still MIGRATING, and that guard is the
	// separate one below, which stays.)
	// AND NOT WHILE AN OLDER STORE IS STILL PART-MIGRATED.
	//
	// `migrate_root` now merges what does not collide, so creating a Diamond no
	// longer strands an old root, and this guard is no longer what stands between
	// this feature and data loss. What it still answers is narrower and true: an
	// id present in BOTH roots is one the merge deliberately left behind, and a
	// boot that is still resolving a user's own Diamonds is not a boot to put two
	// unasked ones into.
	//
	// The flag below is NOT set on this branch: the question has to be asked
	// again once the collision is gone. A Diamond the user creates themselves is
	// not affected -- they asked.
	try {
		if (await diamondApp().legacy_diamond_root_waiting()) return;
	} catch (e) { return; }     // an older wasm cannot answer; do not risk it
	try { localStorage.setItem(DEFAULTS_KEY, '1'); } catch (e) { return; }
	var grants = [];
	for (var i = 0; i < DEFAULT_DIAMONDS.length; i++) {
		var d = DEFAULT_DIAMONDS[i];
		// A built-in of this slot, by fixed id or marker, and never a Diamond of his that only
		// shares the name (NAMES N1).
		if ((pg.diamonds || []).some(function (f) { return builtInSlot(f) === d.name; })) continue;
		var id;
		try {
			// At the fixed id where there is one, so two devices seed one Diamond. An older
			// engine has no such export, and falls back to a minted id -- which is the
			// behaviour that produced the duplicates, so it is a fallback and not a choice.
			id = (DEFAULT_IDS[d.name] && typeof diamondApp().create_diamond_at === 'function')
				? await diamondApp().create_diamond_at(d.name, DEFAULT_IDS[d.name])
				: await diamondApp().create_diamond(d.name);
		}
		catch (e) { continue; }                 // no store yet; the flag stops a retry loop
		// The lasting marker, on the fixed-id copy and above all on a fallback's minted one,
		// which nothing else could tell from a Diamond of his own (NAMES N1).
		if (DEFAULT_IDS[d.name] && typeof diamondApp().mark_built_in === 'function') {
			try { await diamondApp().mark_built_in(id, DEFAULT_IDS[d.name]); }
			catch (e) { /* the next boot's markBuiltIns asks again for a fixed id */ }
		}
		// The seeds are written as markdown above, because that is the readable way to
		// write a paragraph in a source file, and converted here. `crystalJson` is the
		// same migration a legacy crystal takes, so the two cannot drift apart.
		try { await diamondApp().write_crystal_data(id, crystalJson(d.crystal)); }
		catch (e) { /* empty is fine */ }
		// Its ACTIONS held before they can ever run, and nothing else. A Diamond
		// with no triggered actions spends when prompted and at no other time, so
		// there is nothing of its to hold. (It is still IN the pause tree, so
		// "pause Everything" holds it.)
		//
		// NOT `self`, which is the person's own conversation (`armed: false`). It
		// was seeded held beside the action until 2026-09-24, when a typed turn
		// began asking `self` at dispatch: the app's own seed then read as a
		// person's pause and refused everything typed into the Optimiser (R2 QA,
		// F0). `releaseSeededSelf` plays it on the accounts already seeded.
		if (d.triggers.length) {
			var rec = DaimondTriggers.defaults();
			d.triggers.forEach(function (spec, n) {
				var ta = DaimondTriggers.blank(spec.kind);
				Object.keys(spec).forEach(function (k) { ta[k] = spec[k]; });
				ta.id = spec.kind + '-' + (n + 1);
				rec.actions.push(ta);
				try { DaimondPause.seedPaused(DaimondTriggers.node(id, ta.id)); }
				catch (e) { /* module not up */ }
			});
			_triggers[id] = rec;
			try { await Triggers.save(id); } catch (e) { /* it holds in memory */ }
		}
		if (d.usage) grants.push({ id: id, dir: USAGE_DIR, write: writeUsageDigest });
		if (d.guide) grants.push({ id: id, dir: GUIDE_DIR, write: writeGuideMirror });
	}
	await loadDiamonds();

	// The FOLDERS come after every Diamond is made and rendered, and that
	// ordering is not tidiness.
	//
	// Writing them is slow -- the guide mirror fetches an 87 KB index, parses
	// it and writes nine files -- and doing it inside the loop put seconds
	// between creating one Diamond and seeding the NEXT one's triggers. A
	// render landing in that gap shows a Diamond that should carry a traffic
	// light without one, which is a spending control briefly missing from a
	// tile. `verify_triggers` caught exactly that, intermittently: green run
	// alone, red under the load of a full suite.
	//
	// The grants are what notes2 #51 asks for -- the Optimiser given sight of
	// how the account is worked, Help given the guide it exists to explain --
	// each read-only, by the same `consulted` relation any attached folder
	// uses.
	for (var g = 0; g < grants.length; g++) {
		try { await grants[g].write(); } catch (e) { continue; }
		await grantConsulted(grants[g].id, grants[g].dir);
	}
}

/// One triggered action, in words. Used on its pause light and in its row, so
/// the two say the same thing.
export function triggerLabel(ta) {
	if (ta.kind === 'activity') return t('trig.activity', { n: ta.minutes || 30 });
	if (ta.kind === 'mail') {
		return t('trig.mail', { folder: ta.folder || 'INBOX', mailbox: ta.mailbox || '?' });
	}
	return ta.kind;
}

// ── The clock a timer trigger counts on ──────────────────────────
//
// "N minutes of USER ACTIVITY". A timer on the wall clock would greet
// somebody returning to an overnight tab with eight turns they did not ask
// for and a bill to match, which is what this whole section of notes2 exists
// to prevent. So the page reports signs of life and the clock counts only the
// minutes something happened in.
var TRIGGER_TICK_MS = 60000;

export function startTriggerClock() {
	if (!window.DaimondTriggers) return;
	// Mail arriving is the other occasion a TA fires on, and `mail.js`
	// announces it rather than calling here: mail must not have to know what a
	// triggered action is.
	window.addEventListener('daimond:mail-arrived', function (ev) {
		var d = (ev && ev.detail) || {};
		Triggers.fire({ kind: 'mail', mailbox: d.mailbox, folder: d.folder,
			uids: d.uids, uidValidity: d.uidValidity })
			.catch(function (e) { trailTrigger('mail fire failed', e); });	// not a failed sync, but never silent
	});
	['keydown', 'pointerdown', 'wheel'].forEach(function (ev) {
		window.addEventListener(ev, DaimondTriggers.noteActivity, { passive: true });
	});
	/// One minute of the activity clock.
	///
	/// Named rather than written into the interval so `verify_triggers` can
	/// drive it a minute at a time, instead of holding a browser open for half
	/// an hour of wall clock to reach the case it is checking.
	async function triggerTick() {
		DaimondTriggers.tickActivity(TRIGGER_TICK_MS);
		// Every TA is measured against ITS OWN stopwatch, so the reading goes in
		// as a lookup: `due` stays pure and asks the occasion, and the occasion
		// asks the clock. There is no early return on "less than a minute" any
		// more -- there is no longer a single reading to test, and no TA can be
		// due inside its first minute anyway.
		var fired = await Triggers.fire({
			kind: 'activity',
			minutesFor: function (id, ta) { return DaimondTriggers.activityMinutes(id, ta.id); },
		});
		// Only what actually went. A dispatch refused because a turn was already
		// running, or because that Diamond is not the one on screen, keeps the
		// time it accrued and tries again on the next tick.
		fired.forEach(function (x) { DaimondTriggers.resetActivity(x.id, x.actionId); });
		// And any mail a Diamond could not take when it arrived.
		await Triggers.retryMail().catch(function () { /* asked again next tick */ });
	}
	/// Published for `verify_triggers`, which has to advance the clock by hand:
	/// a check on what a timer does after thirty minutes cannot wait thirty
	/// minutes, and a check that a REFUSED firing keeps its accrued time has to
	/// see two ticks either side of the refusal.
	window.DaimondTriggerTick = triggerTick;
	setInterval(triggerTick, TRIGGER_TICK_MS);
}

/// How often a running app rechecks whether a chat has run out of time.
///
/// Hourly, against a window measured in days. A desktop left open for a
/// fortnight would otherwise expire nothing at all — the boot is the only
/// other occasion, and this app is one people leave open. Named rather than
/// written into the interval so a verifier can drive it by hand instead of
/// holding a browser open for three days.
var EXPIRY_TICK_MS = 3600 * 1000;

/// The expiry clock. Its own timer rather than a line inside the trigger
/// clock: that one does not start unless triggers are built, and a chat's
/// lifetime must not depend on whether this account uses timed actions.
export function startExpiryClock() {
	async function expiryTick() {
		// Expire first, then destroy: expiring moves a trash record, and the
		// retention sweep is what acts on one whose term is up. In that order
		// a chat that has been sitting in the trash since long before this
		// device booted is dealt with in a single tick.
		if (expireChats()) renderSessionList();
		await trashSweep();
	}
	window.DaimondExpiryTick = expiryTick;		// see `verify_chat_expiry`
	setInterval(function () { expiryTick(); }, EXPIRY_TICK_MS);
}

/// May this action's turn run for a Diamond NOBODY IS LOOKING AT?
///
/// Two conditions, and the first is the one that keeps every other timer
/// behaving exactly as it did.
///
/// **The action has to have asked**, with `offScreen` on its own record. It is
/// not a property of the kind: an `activity` action whose instruction is "draft
/// the reply and show me" wants the screen, and running it behind the user's
/// back would leave its answer in a conversation they are not in. The one
/// action seeded with it is the Optimiser's, whose whole output goes to the
/// Pending panel rather than to a thread -- see `proposeFromTurn`. A timer that
/// has not asked is refused exactly as before, keeps the minutes it accrued and
/// tries again on the next tick (`verify_triggers` check 8).
///
/// **A mail action has asked by being one** (D-20261016-17). The rule above was
/// written for timers, which lose nothing by waiting: a refused timer keeps its
/// minutes. A mail arrival is one occasion, not a clock, and the screen it waited
/// for was the Diamond's own -- so a watch on alerts@ fired only while somebody
/// happened to be looking at the Email Diamond, which is the one time it is not
/// needed. Its answer goes into its own Diamond's thread (`runSteer` writes its
/// chat record), which is where an alert's reply belongs; and a refusal for any
/// reason below is held and asked again (`oweMail`), never dropped.
///
/// **And nobody may be mid-sentence.** A background turn touches no face of the
/// app, but it does redraw the rail and the crystal when it lands, and half a
/// typed line is the one thing on screen that a redraw could cost somebody.
/// Cheap to wait: the minutes are kept and the next tick asks again.
///
/// # Arguments
/// * `ta` - The triggered action, or nothing for a caller with no action.
function offScreenSteerAllowed(ta) {
	if (!ta) return false;
	if (!(ta.kind === 'mail' || (ta.kind === 'activity' && ta.offScreen === true))) return false;
	var box = document.getElementById('chat-input');
	if (box && String(box.value || '').trim()) return false;
	return true;
}

/// Judge how a triggered turn ended, once, and put a failed one on the Pending panel, taking
/// it down when one ends well. Answers whether the turn failed, alert panel or not.
///
// THE r569 MAIL FAILURE IS RETIRED (FIRE MAIL-FU3, post-QA r569cqa2 CQA2-2). r569 raised a mail
// turn's failure under the bare `turn-failed`, and a routine mail on a reasoning model raised it
// falsely; r569c keys a mail failure `turn-failed.mail`, so nothing took the old one down. On a
// Diamond whose every action is a mail action no turn raises the bare key any more, so one that
// is up there is r569's, and it is cleared: here at each Diamond walk, and by an answered mail
// turn (`judgeTriggeredTurn`). The clear is a stamped register riding the sync parcel, so it
// lands once for the account and every device agrees; after it, this finds nothing up and
// writes nothing. Not one-shot by a flag: a tab still on r569 may raise it again until it
// reloads, and this takes that down too. A Diamond with no actions read is left alone -- a
// read that failed reads as no actions.
function retireR569MailFailures() {
	var A = window.DaimondAlerts;
	if (!A || !A.live || !A.clear) return;
	A.live().forEach(function (a) {
		if (a.key !== 'turn-failed') return;
		var acts = Triggers.of(a.diamond);
		if (acts.length && acts.every(function (t) { return t && t.kind === 'mail'; })) A.clear(a.diamond, 'turn-failed');
	});
}

/// A turn run off screen answers into a thread nobody is looking at, and a failed one --
/// no credit, a revoked key, a provider down, a turn that said nothing -- cannot report
/// itself, so without this the fault is seen nowhere (MO-3; rulings §16, Pending is the
/// one place for system alerts). A mail turn reports on Pending alone wherever it runs, so
/// it is judged on screen too. The PAGE raises it, as the Diamond's own `turn-failed`
/// alert (`DaimondAlerts`, fire/alertpending), needing the person. The time is in the
/// words, so a failure after one the person dismissed is raised again, not held down.
///
/// The same judgement decides a mail arrival's answered mark (`settleMailClaim`), so an
/// arrival is never marked answered by a turn that failed unseen (review R569 B-1).
///
/// # Arguments
/// * `before` - `_lastSteer[f.id]` before the turn: the same record after it means the
///   engine never reported an ending, which is a turn that did not run through.
/// * `threw` - The turn threw.
/// * `mail` - A mail turn: only `answered` answered it (a whitelist, post-QA r569qa2 Q1).
///   Routine mail ends `answered` on its `pending_none`, so anything else -- `silent`,
///   `reasoned_only`, a `capped` turn whose rounds ran out, a `stopped` one halted by a lock,
///   a pause or Stop -- reached no verdict and is owed again. All raise `turn-failed` but
///   `stopped`: the person halted it, the turn is owed, and this device's pause floor keeps a
///   paused device from re-running it while a live one still owes it. Any other triggered
///   turn counts `silent` / `reasoned_only` a failure only over a call that failed or was
///   refused.
/// * `more` - The endings of the turn's report-back rounds (`followVerdicts`): a mail turn
///   that dispatched agents answered nothing until the round that reads their reports did.
function judgeTriggeredTurn(f, before, threw, mail, more) {
	var end = f ? _lastSteer[f.id] : null;
	var ends = [(threw || !end || end === before) ? { how: 'failed' } : end].concat(more || []);
	var failed = false, tell = false;
	ends.forEach(function (e) {
		var how = String(e.how || '');
		var hard = !!{ failed: 1, malformed: 1, spend_cap: 1 }[how];
		var soft = !!{ silent: 1, reasoned_only: 1 }[how]
			&& (!!mail || ((e.failed | 0) + (e.refused | 0)) > 0);
		if (!(hard || soft || (!!mail && how !== 'answered'))) return;
		failed = true;
		if (how !== 'stopped') tell = true;	// halted by the person: owed, nothing to tell him
	});
	var A = window.DaimondAlerts;
	if (!A || !A.raise || !f) return failed;
	// A MAIL TURN'S FAILURE IS ITS OWN ALERT (FIRE MAIL-FIX2 r2, check defect 2). Only an
	// answered mail turn may take it down: a timer turn that ran well says nothing about an
	// arrival held out past `MAIL_TRIES_MAX`, whose one trace this alert is.
	var key = mail ? 'turn-failed.mail' : 'turn-failed';
	try {
		if (!failed) {
			A.clear(f.id, key);
			// The r569 mail failure, on a Diamond with no other kind of action (`retireR569MailFailures`).
			var acts = (mail && typeof Triggers !== 'undefined' && Triggers.of) ? Triggers.of(f.id) : [];
			if (mail && acts.length && !acts.some(function (a) { return !a || a.kind !== 'mail'; })) A.clear(f.id, 'turn-failed');	// unread actions: leave it, as the sweep does
			return failed;
		}
		if (!tell) return failed;
		var name = String(f.name || '').slice(0, 60);
		var at = new Date(), when = ('0' + at.getHours()).slice(-2) + ':' + ('0' + at.getMinutes()).slice(-2);
		A.raise(f.id, key, t('pending.turn_failed', { name: name }),
			t('pending.turn_failed_detail', { name: name, when: when }), true);
	} catch (e) { /* the turn's own thread still holds what happened */ }
	return failed;
}

/// Run one daimon turn on behalf of a trigger, wherever the user happens to be.
///
/// Answers `{ went, reply, failed }`: whether the turn actually started, the prose
/// it finished with, and whether `judgeTriggeredTurn` found it failed. `went` is what tells a refusal from a firing, which is
/// what decides whether the action's stopwatch is restarted; `reply` is what
/// `Triggers.fire` reads to decide whether there is a finding to raise.
///
/// A trigger fires into a Diamond that may not be the one on screen, and
/// `doSteer` works on `currentDiamond` -- so this is where the two meet. It
/// steers the NAMED Diamond through `runSteer` when the action has asked to run
/// off screen, and refuses otherwise rather than moving the centre out from
/// under somebody.
///
/// # Arguments
/// * `ta` - The action that came due, which is what `offScreenSteerAllowed` reads.
async function steerFromTrigger(f, text, ta) {
	var no = { went: false, reply: '' };
	// A MAIL TURN REPORTS ON THE PENDING PANEL ALONE (rulings §16), so the engine lets it end
	// in silence when nothing went wrong (`Agent::set_pending_only`, review R569 R4).
	var mail = !!(ta && ta.kind === 'mail');
	var how = mail ? { pendingOnly: true, follow: [] } : undefined;
	if (diamondBusy(f.id)) return no;           // this Diamond's own turn is already running
	// A QUESTION OPEN IN ITS THREAD HOLDS IT (Q18, D-20261009-20). Its words are not the
	// person's, so they may not reach the daimon as the answer. Refused, the action keeps the
	// time it accrued and is asked again at the next tick: it goes once the person answers.
	if (askOpenIn(daimonChat(f))) return no;
	// The Diamond's OWN app, its own chat record, its own crystal -- and no `selectDiamond`,
	// so the screen does not move. `runSteer` asks at every write whether this Diamond is
	// the one being looked at, and answers no to all of them.
	var off = !!(pg.currentDiamond && pg.currentDiamond.id !== f.id);
	if (off && !offScreenSteerAllowed(ta)) return no;
	// ONE DEVICE PER FIRING (rulings l.16; STEER-2): a timer counts on each device that has
	// it, so two that fire together claim the firing and one runs it; the other stands
	// down as fired, its stopwatch restarted. A mail arrival is claimed by `Triggers.fire`.
	var claim = mail ? null : await claimTimerFire(f, ta);
	if (claim && claim.elsewhere) return { went: false, reply: '', elsewhere: true };
	if (claim && !claim.go) return no;
	var stop = keepMailClaim(claim), ran = false;
	try {
		// WHERE THE SWITCH POINTS NOW (rulings l.16, l.19): a trigger has no press, so the
		// runner the switch draws for the Diamond's conversation at this moment takes the
		// turn, through Send's door. A runner that cannot take it ends it as the "not run"
		// row with Retry; a switch drawing Here runs it here, as before.
		var handed = await triggerHandOff(f, text, mail);
		if (handed) { ran = true; return handed; }
		if (!pg.currentDiamond) await selectDiamond(f);
		ran = true;
		return await steerTriggerHere(f, text, mail, how, off);
	} finally {
		stop();
		if (claim) await settleMailClaim(claim, ran, ran, false);
	}
}

/// Hand a trigger's turn to the runner the switch draws for `f`'s conversation now, or
/// null where it draws Here or no runner. `{ went, reply: '', handed }`: the answer arrives
/// with the sync, so there is nothing to offer or judge here; `failed` where the turn
/// ended "not run".
async function triggerHandOff(f, text, mail) {
	// A MAIL TURN STAYS HERE (STEER-3 N2, rc's review of STEER delta 1; rulings §16 l.261, "the
	// Email Diamond posts nothing in chat"). Send's door writes the prompt as a user row in the
	// thread and a `dispatched` placeholder whose failure ends as a "not run" row there, and no
	// runner yet advertises that it runs a turn pending-only. Until both hold, a mail turn runs
	// here pending-only, as live does; timer turns follow the switch. RESUME_MAILHANDOFF.md.
	if (mail) return null;
	var chat = daimonChat(f), drawn = '';
	try { drawn = chat ? seatDrawnRunner(chat) : ''; } catch (e) { drawn = ''; }
	if (!drawn || chatSeatHere(chat)) return null;
	// The thread goes with the errand, so it is read first: a chat not resident here has
	// no fingerprint to hand off with.
	if (chat._loaded === false) {
		try { await loadChatMessages(chat); } catch (e) { /* the hand-off ends "not run" */ }
	}
	var mid = newMid();
	if (!(await maybeAutoDispatch(chat, text, '', mid, true, drawn, mail ? { pendingOnly: true } : undefined))) return null;
	var nr = (chat.messages || []).some(function (m) { return String(m.iturn || '') === mid && isNotRunRow(m); });
	diag('trigger', 'diamond=' + String(f.id || '') + ' turn=' + mid + (nr ? ' not run' : ' handed to ' + drawn));
	return { went: true, reply: '', failed: nr, handed: true };
}

/// Run a trigger's turn here, as it always ran: `runSteer` off screen, `doSteer` on it.
async function steerTriggerHere(f, text, mail, how, off) {
	// Judged where nobody may see the thread: off screen, and any mail turn (B-1).
	var judged = off || mail;
	var before = _lastSteer[f.id], reply = '';
	try { reply = off ? await runSteer(f, text, undefined, null, how) : await doSteer(text, undefined, how); }
	catch (e) { if (judged) judgeTriggeredTurn(f, before, true, mail); throw e; }
	var end = _lastSteer[f.id];
	var stopped = !!end && end !== before && end.how === 'stopped';
	// The report-back rounds overwrite `_lastSteer`, so the turn's own ending is judged as
	// it stood here: the record is restored for the judgement, which reads it.
	var more = mail ? await followVerdicts(how) : [];
	if (more.length) {
		_lastSteer[f.id] = end;
		stopped = stopped || more.some(function (e) { return e.how === 'stopped'; });
	}
	var failed = judged ? judgeTriggeredTurn(f, before, false, mail, more) : false;
	return { went: true, reply: reply, failed: failed, stopped: stopped };
}

/// The endings a pending-only turn's fan-outs owe it, each batch's report-back round
/// judged with the turn (post-QA r569qa2 Q3). A round that dispatches again adds to the
/// list as it runs, so it is read until nothing more is owed. Bounded by
/// `FOLLOW_MAX_MS` in all: a worker parked on a person's answer is not finished, and the
/// arrival is then owed again rather than held for ever, the claim with it.
export var FOLLOW_MAX_MS = 20 * 60 * 1000;
async function followVerdicts(how) {
	var out = [];
	if (!how || !how.follow || !how.follow.length) return out;
	var timer = null, late = new Promise(function (res) {
		timer = setTimeout(function () { res({ how: 'failed', late: true }); }, FOLLOW_MAX_MS);
	});
	try {
		for (var i = 0; i < how.follow.length; i++) {
			var e = await Promise.race([how.follow[i], late]);
			out.push(e);
			if (e.late) break;
		}
	} finally { clearTimeout(timer); }
	return out;
}

/// Can this Diamond actually think? That is a question about ITS provider's key, not the starred
/// provider's -- and they are not always the same one.
export function diamondCanRun(id) {
	var m = diamondModel(id);
	return !!(window.DaimondModels && DaimondModels.resolve(m.provider, m.model));
}

// The pure OPFS operations (create/list/read/write/log/fold_apply) run through a DaimondApp per
// model configuration, `diamondApp`, and work on any instance, so a placeholder provider is fine
// when none is configured. That client is a STORE DOOR: no conversation runs on it.
//
// A Diamond's daimon conversation -- its steers, fold proposals, System band, turn tags, Stop,
// taint, web consent and bill -- runs on `daimonApp(id)`, one client per Diamond, because each
// client owns one conversation and runs one turn at a time (U1 ACTOR). Two Diamonds on one
// model used to share a client, and with it one meter and one set of turn tags.
export var _diamondApps     = {};           // "provider model" -> DaimondApp, the store door
export var _daimonApps      = new Map();    // "provider model id" -> DaimondApp, least recently used first
// How each Diamond's last daimon turn ended, by Diamond id. In memory only: it is a
// fact about the turn just run, and a reload has no turn. See `DaimondCore.lastTurn`.
export var _lastSteer       = {};
export var _diamondAppModel = new Map();    // DaimondApp -> the model id it runs, for the ledger
// And whose key it runs on. A ledger entry without it cannot be attributed to a provider, and
// a live rate captured from that provider cannot be preferred over the baked-in table.
export var _diamondAppProvider = new Map(); // DaimondApp -> the provider id
// The Diamonds whose daimon has read something from outside, this page load. Kept here as well
// as in the engine, because a daimon client can be dropped (evicted, or a reset) and rebuilt, and
// taint must never fail open across that: `daimonApp` puts it back on every client it builds.
var _daimonTaint     = new Set();
// Which Diamond each daimon client runs for, so its engine's verdict can be read back into
// `_daimonTaint` before the client is dropped. The engine marks a real read (`wrap_untrusted`)
// on the client alone; without this a drop lost the only copy.
var _daimonOf        = new WeakMap();    // DaimondApp -> diamond id
// Busy daimon clients a reset left behind to finish their turn. Each later reset carries them
// forward with their meter, model and provider, as it does the busy clients it finds itself;
// otherwise a second reset mid-turn dropped the baseline and billed the whole conversation
// again at the starred model. Their settle takes them out and shuts them down.
var _daimonDraining  = new Set();
// Hand-outs not yet settled: a client a turn has been handed is not evicted in the awaits
// before its first engine call, when the engine itself does not yet count it busy.
var _daimonClaims    = new Map();    // DaimondApp -> claims outstanding
// Idle daimon clients kept built. Past this the least recently used idle one is shut down.
var DAIMON_IDLE_KEPT = 8;
/// How a built daimon client is filed: by the provider and model it runs on rather
/// than by the Diamond, because two Diamonds on one model share one client. Its own
/// function so a reader of the cache and its writer cannot spell the key differently.
export function diamondAppKey(a) { return (a.provider || '') + '\u0000' + (a.model || ''); }

/// Tell a Diamond's daimon its steering notes. Before the notes service exists (a call made while
/// the page is still starting) there is nothing to tell.
function noteSteer(app, diamondId, model) {
	try { if (typeof Notes === 'object' && Notes) Notes.applyTo(app, diamondId, model); } catch (e) { /* the turn goes unsteered */ }
}

/// Build and seed one Diamond client for `a`, the resolved provider and model. Both caches build
/// through here, so a daimon client is seeded exactly as the store door is: window, routing,
/// sight, Effort, fold settings, role prompts, instructions, provenance, and the two ledger maps.
function buildDiamondClient(a, eff) {
	var app;
	var base = a.baseUrl || 'http://127.0.0.1/v1/chat/completions';
	try {
		app = new DaimondApp(base, a.apiKey || '', a.model || 'none',
			maxOutFor(a.model, a.provider), SYSTEM_PROMPT(a.model), true);
		// A Diamond's daimon, likewise.
		try { DaimondModels.noteUse(a.provider, a.model); } catch (e) { /* never block a turn */ }
	} catch (e) {
		app = new DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none',
			AUTO_MAX, SYSTEM_PROMPT(''), true);
	}
	// The conductor's and the reducer's system prompts are composed in Rust,
	// so the house rules are handed across rather than baked into the ctor.
	try { app.set_instructions(Instructions.md); } catch (e) { /* ignore */ }
	// The daimon's and the reducer's own prompts, as `Prompts.refresh` tells every built client.
	// Only that refresh used to say them, so a client rebuilt after a reset (a fold-point or key
	// change) ran on the shipped defaults until the files next changed.
	try {
		if (typeof Prompts === 'object' && Prompts && typeof app.set_role_prompt === 'function') {
			app.set_role_prompt('daimon',  Prompts.md.daimon  || '');
			app.set_role_prompt('reducer', Prompts.md.reducer || '');
		}
	} catch (e) { /* the shipped defaults stand */ }
	// How big this model's window is, exactly as a chat and a worker are told (see
	// `ensureApp`). Without it a Diamond's daimon folded against the agent's ASSUMED
	// default rather than the model's published one — and `adopt_limits` hands whatever
	// this app holds to every worker the daimon dispatches, so one wrong figure here
	// became the wrong figure for the whole team. A null means nobody publishes a window
	// and the agent's own assumption is the better guess.
	try {
		var cw = window.DaimondPricing
			? DaimondPricing.contextWindow(a.model || '', a.provider || '')
			: null;
		if (cw && app.set_context_window) app.set_context_window(cw);
	} catch (e) { /* an older wasm build has no setter */ }
	applyRoundLimit(app);
	applyLiveness(app);
	applyFoldSettings(app, a.provider || '');
	applyProviderRouting(app, a.provider || '', a.model || '');
	applySight(app, a.provider || '', a.model || '');
	if (typeof eff === 'string') applyEffort(app, a.provider || '', a.model || '', eff);
	applyCrystalCap(app);
	_sharedClients.add(app);
	_diamondAppModel.set(app, a.model || '');
	_diamondAppProvider.set(app, a.provider || '');
	// The daimon and the reducer name themselves per turn; the engine needs only the
	// provider, which nothing but the page knows.
	noteAppProv(app, 'daimon', a.model || '', a.provider || '', '', '');
	return app;
}

/// The store door for `diamondId`'s model: the client the stateless store calls go through.
/// No conversation runs here; that is `daimonApp`.
///
/// `eff`, a string, is the Effort the work this hand-out starts thinks at. Without it the
/// client's Effort is left as it stands.
export function diamondApp(diamondId, pick, eff) {
	var m = pick && pick.model ? pick : diamondModel(diamondId);
	var a = appCfgFor(m);
	var k = diamondAppKey(a);
	// ONE CLIENT SERVES EVERY DIAMOND ON ITS MODEL, so the Effort is put on it by the hand-outs
	// that start model work, and only by those (check_final F1).
	if (typeof eff !== 'string' && pick && pick.model) eff = pick.effort || '';
	if (_diamondApps[k]) {
		if (typeof eff === 'string') applyEffort(_diamondApps[k], a.provider || '', a.model || '', eff);
		return _diamondApps[k];
	}
	var app = buildDiamondClient(a, eff);
	_diamondApps[k] = app;
	return app;
}

/// The client `diamondId`'s daimon conversation runs on: its own, on the Diamond's own provider
/// and model, built and seeded as `diamondApp`'s is. Every hand-out makes it the most recently
/// used, and a build trims the idle ones past `DAIMON_IDLE_KEPT`. Taint marked on the Diamond
/// this page load is put back on a client built again.
///
/// # Arguments
/// * `diamondId` - The Diamond.
/// * `pick` - Optional `{ provider, model, effort }` in place of the Diamond's own.
/// * `eff` - Optional string: the Effort the model work this hand-out starts thinks at. Put on
///   only by the hand-outs that start model work, so a mid-turn hand-out (a taint mark, a
///   wire read) never resets a handed-off turn's Effort (check_final F1).
export function daimonApp(diamondId, pick, eff) {
	var id = String(diamondId || '');
	var m = pick && pick.model ? pick : diamondModel(id);
	var a = appCfgFor(m);
	var k = diamondAppKey(a) + '\u0000' + id;
	if (typeof eff !== 'string' && pick && pick.model) eff = pick.effort || '';
	var app = _daimonApps.get(k);
	if (app) {
		_daimonApps.delete(k);
		_daimonApps.set(k, app);
		noteSteer(app, id, a.model);
		if (typeof eff === 'string') applyEffort(app, a.provider || '', a.model || '', eff);
		return app;
	}
	app = buildDiamondClient(a, eff);
	if (id) _daimonOf.set(app, id);
	// The daimon's record remembers past a reload what `_daimonTaint` forgets (H3).
	if (id && daimonRecordTainted(id)) _daimonTaint.add(id);
	if (id && _daimonTaint.has(id) && typeof app.set_tainted === 'function') {
		try { app.set_tainted(id); } catch (e) { /* an older engine has no taint */ }
	}
	_daimonApps.set(k, app);
	noteSteer(app, id, a.model);
	trimDaimonApps();
	return app;
}

/// Every built Diamond client, the store doors and the daimon clients both. For what each must
/// be told: instructions, role prompts, fold settings, a forgotten web consent.
export function everyDiamondClient(fn) {
	Object.keys(_diamondApps).forEach(function (k) { if (_diamondApps[k]) fn(_diamondApps[k]); });
	_daimonApps.forEach(function (app) { if (app) fn(app); });
}

/// Is anything in flight on this daimon client, or about to be? The engine's own answer
/// (`busy`: a turn running, one sent, or a steer child) and this page's claims.
function daimonBusy(app) {
	if ((_daimonClaims.get(app) || 0) > 0) return true;
	try { return !!app.busy; } catch (e) { return true; }
}

/// Hold `app` against eviction from its hand-out until `daimonSettled`.
export function claimDaimon(app) {
	if (app) _daimonClaims.set(app, (_daimonClaims.get(app) || 0) + 1);
	return app;
}

/// Keep the engine's taint verdict on `app` for its Diamond before the client can be dropped:
/// into `_daimonTaint`, and onto that Diamond's current client if a reset has built another
/// while this one ran. One-way, as the engine's own mark is.
function keepDaimonTaint(app) {
	var id = app ? _daimonOf.get(app) : '';
	if (!id) return;
	var t = false;
	try { t = typeof app.is_tainted === 'function' && !!app.is_tainted(id); } catch (e) { t = false; }
	if (!t) return;
	_daimonTaint.add(id);
	markDaimonRecord(id);
	_daimonApps.forEach(function (other) {
		if (other !== app && _daimonOf.get(other) === id && typeof other.set_tainted === 'function') {
			try { other.set_tainted(id); } catch (e) { /* an older engine has no taint */ }
		}
	});
}

/// A turn on `app` has settled: its taint is kept, its claim goes, a client a reset left
/// draining is shut down once idle, and the idle clients are trimmed.
export function daimonSettled(app) {
	keepDaimonTaint(app);
	var n = (_daimonClaims.get(app) || 0) - 1;
	if (n > 0) _daimonClaims.set(app, n); else _daimonClaims.delete(app);
	if (_daimonDraining.has(app) && !daimonBusy(app)) {
		_daimonDraining.delete(app);
		try { if (typeof app.shutdown === 'function') app.shutdown(); } catch (e) { /* dropped all the same */ }
	}
	trimDaimonApps();
}

/// Shut down the least recently used idle daimon clients past `DAIMON_IDLE_KEPT`. A busy one is
/// never evicted. A shut client still answers its getters with its last figures, so a reader
/// holding it past an await reads true counters; its next turn is refused, and `daimonApp`
/// builds it again.
function trimDaimonApps() {
	var idle = [];
	_daimonApps.forEach(function (app, k) { if (!daimonBusy(app)) idle.push(k); });
	for (var i = 0; i < idle.length - DAIMON_IDLE_KEPT; i++) {
		var app = _daimonApps.get(idle[i]);
		keepDaimonTaint(app);
		_daimonApps.delete(idle[i]);
		try { if (app && typeof app.shutdown === 'function') app.shutdown(); } catch (e) { /* dropped all the same */ }
	}
}

/// The daimon conversation's record for Diamond `id`, if this device holds one.
function daimonRecordOf(id) {
	return pg.chats.find(function (c) { return c && c.diamondId === id; }) || null;
}
/// Has Diamond `id`'s daimon conversation read outside content, by its RECORD (H3)? What a
/// reload or another device knows, where `_daimonTaint` is this page load's alone.
function daimonRecordTainted(id) { return !!chatTaintOf(daimonRecordOf(id)); }
/// Put the daimon's taint on its conversation's record, one-way, and save it when it changed.
/// A Diamond with no record yet has nothing to carry it; `daimonChat` makes one on first use,
/// before any turn can read anything.
function markDaimonRecord(id) {
	if (markChatTainted(daimonRecordOf(id))) persistChats();
}

/// Mark `diamondId`'s daimon as having read something from outside: on its client, and in
/// `_daimonTaint`, so a client built again for it starts tainted.
export function taintDaimon(diamondId) {
	var id = String(diamondId || '');
	if (!id) return false;
	_daimonTaint.add(id);
	markDaimonRecord(id);
	var da = daimonApp(id);
	if (da && da.set_tainted) { da.set_tainted(id); return true; }
	return false;
}

/// Has this chat read nothing from outside, so its errand may say `clean` (U4 ERRAND-TAINT)?
/// The runner reads a missing `clean` as tainted, so this only ever narrows: every doubt
/// answers no. Tainted when the Diamond is in `_daimonTaint` (what `markRead` and a kept
/// verdict write), when any built daimon client for it has the engine's own mark and the set
/// has not taken it yet (a read mid-turn), or when the chat's engine -- the one held before
/// `errandFence` may have rebuilt it, and the one after -- says so. No engine to ask is tainted.
///
/// # Arguments
/// * `chat`      - The chat being handed off.
/// * `diamondId` - The Diamond the errand names, '' for an ordinary chat.
/// * `held`      - The chat's engine before the fence was read, or nothing.
function errandClean(chat, diamondId, held) {
	var id = String(diamondId || '');
	function marked(app) {
		if (!app || typeof app.is_tainted !== 'function') return false;
		return !!app.is_tainted() || (!!id && !!app.is_tainted(id));
	}
	try {
		if (id && _daimonTaint.has(id)) return false;
		var any = false;
		if (id) {
			_daimonApps.forEach(function (a) { if (_daimonOf.get(a) === id && marked(a)) any = true; });
			_daimonDraining.forEach(function (a) { if (_daimonOf.get(a) === id && marked(a)) any = true; });
		}
		if (any || marked(held)) return false;
		var app = chat && chat.app;
		if (!app || typeof app.is_tainted !== 'function') return false;
		return !marked(app);
	} catch (e) {
		return false;
	}
}

/// The limits this page puts on an agent for `chat`'s turn, for an errand to carry (KT-2, engine
/// `TurnLimits`): the model's window, then what `applyFoldSettings` and `applyRoundLimit` apply,
/// each zero or '' where this page leaves the engine's own default. A runner hands back an
/// errand without them rather than run the turn on a guessed window.
export function errandLimits(chat) {
	var m = errandModelOf(chat) || {};
	var win = 0;
	try {
		win = (window.DaimondPricing && DaimondPricing.contextWindow)
			? (DaimondPricing.contextWindow(m.model || '', m.provider || '') || 0) : 0;
	} catch (e) { win = 0; }
	return {
		window:     win,
		foldAt:     pg.cfg.foldAt || 0,
		contextCap: pg.cfg.contextCap || 0,
		spendCap:   pg.cfg.spendCap || 0,
		maxRounds:  pg.cfg.maxRounds || 0,
		foldModel:  foldModelFor(m.provider || ''),
		foldPrompt: (Prompts && Prompts.md && Prompts.md.compactor) || '',
		tune:       pg.cfg.tune || '',
	};
}

/// The engine session `seedEngine` would lay into a fresh engine for `chat`, less the turn
/// `turnId` about to be sent, for an errand's seed to carry (KT-4): the stored session cleaned
/// as it is cleaned there, with the prose after `upto` as its `tail`; or, where the stored one
/// is absent or out of order, no folded part and the whole prose as the tail, as the transcript
/// path lays it. Pure over the chat: nothing is written back to it.
export function errandSession(chat, turnId) {
	var c = chat || {}, id = String(turnId || '');
	function row(m) {
		var r = { role: m.role, content: String(m.content || ''), mid: String(m.mid || '') };
		if (m.role === 'user' && typeof m.pre === 'string' && m.pre) r.pre = m.pre;
		if (m.role === 'user' && m.interject) r.interject = true;
		return r;
	}
	function rows(list) {
		return list.filter(function (m) {
			return m && m.content && (m.role === 'user' || m.role === 'assistant') && String(m.mid || '') !== id;
		}).map(row);
	}
	var sess = c.session;
	if (sess && Array.isArray(sess.msgs) && sess.msgs.length) {
		var clean = dedupeSession(sess.msgs, c.messages, sess.upto, sess.uptoTs);
		var held  = (clean !== sess.msgs) ? Object.assign({}, sess, { msgs: clean, marks: {} }) : sess;
		var tail  = tailAfter(c, held);
		var doubt = sessionDoubt(c, held, tail, id);
		if (held.msgs.length && !doubt) {
			return { v: held.v || 1, msgs: held.msgs, upto: String(held.upto || ''), uptoTs: +held.uptoTs || 0,
				marks: held.marks || {}, tail: rows(tail) };
		}
	}
	return { v: 1, msgs: [], upto: '', uptoTs: 0, marks: {}, tail: rows(c.messages || []) };
}

/// What the Diamond `did` reaches here, as the engine composes its `Attached` block from
/// (`diamond_reach`), for an errand to carry (KT-4); `undefined` for an ordinary chat, whose turn
/// composes none, and where the engine cannot say.
async function errandReach(did) {
	if (!did) return undefined;
	try {
		var eng = diamondApp(did);
		if (!eng || typeof eng.diamond_reach !== 'function') return undefined;
		return JSON.parse(await eng.diamond_reach(String(did)));
	} catch (e) {
		return undefined;
	}
}

/// The words log for an errand's seed (U2), only when runner `runTo` stages words home
/// (`takesWords`, from its presence row, as the offer rule reads its ABI); `undefined` for any
/// other, so an older runner is not sent a log it would ignore.
async function errandWordsFor(chat, runTo) {
	var rec = null;
	try {
		var pr = (window.DaimondPresence && DaimondPresence.snapshot && DaimondPresence.snapshot()) || {};
		rec = runTo ? pr[String(runTo)] : null;
	} catch (e) { rec = null; }
	if (!(window.DaimondPeer && DaimondPeer.takesWords && DaimondPeer.takesWords(rec))) return undefined;
	return errandWords(chat);
}

/// The words log of `chat`'s keeper (a Diamond's id, else `chat:<id>`), as `words_read` gives it,
/// for an errand's seed (U2), so the runner's folds file over the log this tab files into.
/// `undefined` where it cannot be read, which the diagnostics say: an empty log would be a
/// claim the log is empty.
async function errandWords(chat) {
	if (!chat) return undefined;
	var keeper = chat.diamondId ? String(chat.diamondId) : 'chat:' + String(chat.id || '');
	try {
		var t = await Wasm.words_read(keeper);
		return typeof t === 'string' ? t : undefined;
	} catch (e) {
		diag('runner words', 'chat=' + String(chat.id || '').slice(0, 12) + ' log not read for the seed: '
			+ String((e && e.message) || e));
		return undefined;
	}
}

/// This browser's `Today` line (`today_line`), for an errand to carry (KT-4), so the runner tells
/// the model the asker's day; '' where the module cannot say.
export function errandToday() {
	try {
		var t = Wasm.today_line();
		return typeof t === 'string' ? t : '';
	} catch (e) {
		return '';
	}
}

/// The packs this account has not bought, as the wasm holds them (`set_locked_packs`), for an
/// errand to carry (U13a). `undefined` when the module cannot say -- not up, or a throw --
/// which the runner reads as every pack locked, so a doubt never unlocks a paid tool.
export function errandLocked() {
	try {
		var csv = Wasm.locked_packs();
		if (typeof csv !== 'string') return undefined;
		return csv.split(',')
			.map(function (k) { return k.trim().toLowerCase(); })
			.filter(function (k) { return k !== ''; });
	} catch (e) {
		return undefined;
	}
}

/// Forget what one Diamond's daimon said about reaching websites, because its conversation
/// has ended.
///
/// The grant is scoped to a conversation (`web_step` in src/tools.rs), so Fresh daimon has to
/// end it with the rest: a new conversation inheriting a yes from the one just discarded would
/// be a grant outliving the thing it was given to.
///
/// OFFERED TO EVERY BUILT CLIENT, the store doors as well as the daimon clients, so no client
/// that ever ran the conversation keeps the answer. Clearing a key that is not there does
/// nothing, which is what makes that safe.
///
/// # Arguments
/// * `id` - The Diamond whose daimon is starting afresh.
export function forgetDiamondWebConsent(id) {
	everyDiamondClient(function (app) {
		if (typeof app.forget_web_consent === 'function') {
			try { app.forget_web_consent(String(id || '')); }
			catch (e) { /* an older engine has no such edge; it will simply ask again */ }
		}
	});
}

/// Forget the built clients. A key that has just changed -- or been locked away -- must not go
/// on being used by a client that closed over the old one. A daimon client with a turn in flight
/// is left to finish (`_daimonDraining`, carried across every later reset until it settles); it
/// is not handed out again. `_daimonTaint` is kept, and every dropped client's engine verdict
/// put into it first: taint outlives a reset.
export function resetDiamondApps() {
	var was = _daimonApps, meter = pg._diamondMeter, model = _diamondAppModel, prov = _diamondAppProvider;
	var draining = _daimonDraining;
	_daimonDraining = new Set();
	was.forEach(function (app) { keepDaimonTaint(app); });
	draining.forEach(function (app) { keepDaimonTaint(app); });
	_diamondApps = {};
	_daimonApps = new Map();
	_diamondAppModel = new Map();
	_diamondAppProvider = new Map();
	pg._diamondMeter = new Map();
	var drop = function (app) {
		if (daimonBusy(app)) {
			// Its turn is still to be billed, at its own model and from its own last reading:
			// a baseline lost here would bill the whole conversation again.
			if (meter.has(app)) pg._diamondMeter.set(app, meter.get(app));
			if (model.has(app)) _diamondAppModel.set(app, model.get(app));
			if (prov.has(app)) _diamondAppProvider.set(app, prov.get(app));
			_daimonDraining.add(app);
			return;
		}
		try { if (typeof app.shutdown === 'function') app.shutdown(); } catch (e) { /* dropped all the same */ }
	};
	was.forEach(drop);
	draining.forEach(drop);		// never in `was`: a reset took it out of `_daimonApps`
}

/// A short relative-time label from an epoch-ms value. Spoken through the
/// sync.when_* keys, which every locale already carries -- the hard-coded
/// English here was the one line of the app a translated drawer still
/// showed raw.
export function relTime(ms) {
	if (!ms) return '';
	var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return t('sync.when_just_now');
	var m = Math.round(s / 60);
	if (m < 60) return t('sync.when_mins', { n: m });
	var h = Math.round(m / 60);
	if (h < 24) return t('sync.when_hours', { n: h });
	return t('sync.when_days', { n: Math.round(h / 24) });
}

/// Reload the Diamonds list from the store and re-render the rail.
// A walk of the store that is already running, and whether anyone asked for
// another while it ran. See `loadDiamonds`.
var _diamondWalk  = null;
var _diamondAgain = false;

/// Read the Diamonds from the store and draw the rail.
///
/// SINGLE FLIGHT, and this is not a tidiness measure. `list_diamonds` walks
/// the whole root and reads each Diamond's metadata, which is one round trip
/// through OPFS per Diamond. On a desktop that is a few milliseconds each and
/// nobody notices. On the iPhone that has been looping for four sessions it is
/// 100-500ms each across FIFTEEN Diamonds -- several seconds for one walk --
/// and the trail from the device shows a second walk starting while the first
/// was on its fourth entry, and a third starting after that:
///
///     list_diamonds start ... list entry (4 of 15) ... list_diamonds start
///
/// Fourteen callers reach this function and most are event-driven, so on a
/// slow store they overlap by construction rather than by accident. Coalescing
/// them is correct wherever it is called from, which is why it is fixed here
/// and not at the callers.
///
/// A caller that has just WRITTEN to the store needs fresh data, not a join
/// onto a walk that began before their write -- so an ask that arrives during
/// a walk sets `_diamondAgain` and gets one more walk afterwards. At most two,
/// never concurrent.
export function loadDiamonds() {
	if (_diamondWalk) { _diamondAgain = true; return _diamondWalk; }
	_diamondWalk = (async function () {
		for (;;) {
			_diamondAgain = false;
			try {
				var json = await diamondApp().list_diamonds();
				// Trashed Diamonds are still in the store and are left out here.
				// `diamonds` is what the rail, the tag pool, the fold picker and
				// the graph are all built from, so one filter is what makes a
				// trashed Diamond gone from every one of them at once.
				pg.diamonds = JSON.parse(json).filter(function (d) {
					return d && d.id && !trashed(d.id);
				});
			} catch (e) { pg.diamonds = []; }
			// Where each one came from, BEFORE the rail is drawn: `diamondBox` is
			// synchronous and would otherwise draw the name with no line under it
			// and never come back to it.
			try { await readOrigins(pg.diamonds); } catch (e) { /* the store said no */ }
			renderDiamondList();
			// The triggers travel with the Diamonds: the pause tree needs a leaf
			// per action, and the tick needs to know what is armed. Read here
			// rather than on a timer, because this is every occasion on which the
			// set can change.
			try { await Triggers.reload(); } catch (e) { /* the module is not up */ }
			try { retireR569MailFailures(); } catch (e) { /* the next walk asks again */ }
			try { noteTriggersHeldHere(); } catch (e) { /* a notice must not stop the walk */ }
			// The notes travel in the Diamonds too, so this is every occasion on which they can change.
			// Not waited for: a rail does not wait on a file, and a turn built before they are read is
			// built again when they are (`Notes.changed`).
			try { Notes.reload().catch(function () { /* the next walk tries again */ }); } catch (e) { /* not up */ }
			if (!_diamondAgain) return;
		}
	})();
	var done = function () { _diamondWalk = null; };
	_diamondWalk.then(done, done);
	return _diamondWalk;
}

/// A Diamond's tags, tolerating the Diamonds written before tags existed.
export function tagsOf(f) {
	return Array.isArray(f && f.tags) ? f.tags : [];
}

// The hues a tag chip can take: a fixed spread rather than the raw hash,
// so two tags rarely land on near-indistinguishable colours.
var TAG_HUES = [10, 40, 75, 145, 190, 220, 265, 315];

/// A tag's hue, hashed from its name, so one tag is one colour everywhere
/// and stays that colour across reloads. Only the hue is chosen here; the
/// theme supplies saturation and lightness (see `.tag-chip` in app.css),
/// so each theme keeps its own contrast.
export function tagHue(tag) {
	var h = 0;
	for (var i = 0; i < tag.length; i++) {
		h = ((h << 5) - h + tag.charCodeAt(i)) | 0;   // 31*h + c, 32-bit
	}
	// The low bits of that hash barely move between short similar strings,
	// and a remainder takes exactly those bits -- unmixed, 'project' and
	// 'topic' come out the same colour. Stir the high bits down first.
	h ^= h >>> 15;
	h = Math.imul(h, 0x85ebca6b) | 0;
	h ^= h >>> 13;
	return TAG_HUES[Math.abs(h) % TAG_HUES.length];
}

/// One tag chip. With an `onclick` it is a button, otherwise inert text.
/// The caller sets the title, because what a chip does depends on where
/// it sits: the rail filters, the editor adds.
export function tagChip(tag, cls, onclick) {
	var el = document.createElement(onclick ? 'button' : 'span');
	el.className = 'tag-chip' + (cls ? ' ' + cls : '');
	el.style.setProperty('--tag-h', tagHue(tag));
	el.textContent = tag;                      // escaped via textContent (H5)
	if (onclick) {
		el.addEventListener('click', function (e) { e.stopPropagation(); onclick(tag); });
	}
	return el;
}

/// Is any tag filter on at all?
export function tagFiltering() {
	return pg.tagInc.length > 0 || pg.tagExc.length > 0;
}

/// Does a Diamond's tag set survive the boolean the rail is holding?
///
/// An exclusion is absolute: a tag you have said you do not want to see hides
/// its Diamond however well the rest of it matches, so "not this one" cannot
/// be talked round by an inclusion. Past that, an empty include list includes
/// everything, and two or more included tags combine as the mode says.
function tagsPass(tags) {
	for (var i = 0; i < pg.tagExc.length; i++) {
		if (tags.indexOf(pg.tagExc[i]) !== -1) return false;
	}
	if (pg.tagInc.length === 0) return true;
	if (pg.tagMode === 'any') {
		return pg.tagInc.some(function (t) { return tags.indexOf(t) !== -1; });
	}
	return pg.tagInc.every(function (t) { return tags.indexOf(t) !== -1; });
}

/// Does a Diamond survive the tag filter AND the search field? Both apply: the
/// filter decides which Diamonds are in the list and the search narrows that
/// list (RAIL-SEARCH, D-20261015-11, ruled 16 Oct 2026).
///
/// NAMES AND TAGS ONLY. A name matches anywhere in it, a tag from its start --
/// "ork" is not a search for "work". The pages inside a Diamond are not read:
/// that was variant E, rejected as the default for its cost on a large vault.
export function diamondMatches(f) {
	var tags = tagsOf(f);
	if (!tagsPass(tags)) return false;
	if (!pg.diamondQuery) return true;
	if ((f.name || '').toLowerCase().indexOf(pg.diamondQuery) !== -1) return true;
	return tags.some(function (t) { return String(t).toLowerCase().indexOf(pg.diamondQuery) === 0; });
}

/// Write a Diamond's name into `el`, its letters matching the search in the
/// accent colour. Text nodes only, so a name is never parsed as markup (H5).
/// A name whose lower case changes its length (a Turkish dotted I) is written
/// plain rather than marked in the wrong place.
export function paintDiamondName(el, name) {
	name = name || '';
	var low = name.toLowerCase();
	var i = pg.diamondQuery && low.length === name.length ? low.indexOf(pg.diamondQuery) : -1;
	if (i === -1) { el.textContent = name; return; }
	el.textContent = '';
	el.appendChild(document.createTextNode(name.slice(0, i)));
	var hit = document.createElement('span');
	hit.className = 'rail-hit';
	hit.textContent = name.slice(i, i + pg.diamondQuery.length);
	el.appendChild(hit);
	el.appendChild(document.createTextNode(name.slice(i + pg.diamondQuery.length)));
}

/// Which list a tag is in: 'inc', 'exc', or '' for neither.
export function tagState(tag) {
	if (pg.tagInc.indexOf(tag) !== -1) return 'inc';
	if (pg.tagExc.indexOf(tag) !== -1) return 'exc';
	return '';
}

/// One click on a tag chip in the rail, cycling that tag through the three
/// things it can be -- off, wanted, unwanted -- and round to off again.
///
/// The three branches are exclusive and each MOVES the tag rather than
/// copying it, so a tag can never be in both lists -- which is why nothing
/// downstream has to decide what "include and exclude the same tag" would
/// mean. Clicked from a Diamond box the last leg is out of reach, since
/// refusing a tag takes every Diamond carrying it off the rail and the chip
/// goes with them; the standing pool under the rail's head holds all three,
/// because it is drawn from the store rather than from the rail.
export function cycleTagFilter(tag) {
	var i = pg.tagInc.indexOf(tag), j = pg.tagExc.indexOf(tag);
	if (i !== -1) { pg.tagInc.splice(i, 1); pg.tagExc.push(tag); }   // wanted -> unwanted
	else if (j !== -1) { pg.tagExc.splice(j, 1); }                // unwanted -> off
	else { pg.tagInc.push(tag); }                                 // off -> wanted
	renderDiamondList();
}

/// Take a tag out of the filter altogether, whichever list it was in. Not a
/// leg of the cycle: it is what a tag being DELETED does on its way out, so
/// a filter is never left holding a tag that no longer exists.
export function dropTagFilter(tag) {
	pg.tagInc = pg.tagInc.filter(function (t) { return t !== tag; });
	pg.tagExc = pg.tagExc.filter(function (t) { return t !== tag; });
	renderDiamondList();
}

/// How two or more included tags combine. Kept, because it is a habit of
/// reading rather than a thing being looked at.
export function setTagMode(mode) {
	pg.tagMode = mode === 'any' ? 'any' : 'all';
	try { localStorage.setItem(TAG_MODE_KEY, JSON.stringify(pg.tagMode)); } catch (e) { /* best effort */ }
	renderDiamondList();
}

export function install() { // page-split: install
	// page-split: install 108

	/// Published for `dev/verify_mailclaim_sync.mjs`, which races two real devices on one door.
	window.DaimondMailClaim = { id: mailClaimId, claim: claimMailArrival, settle: settleMailClaim };
	// page-split: install 109

	// THEIR SIGHT OF THEIR FOLDERS, AS BUILT-IN ENTRIES (R2). `grantConsulted` writes
	// each grant once per account, and it reaches every other device by sync -- where
	// no press was ever made, so a stored entry would leave Help and the Optimiser
	// blind on every device but the first. These two are in force wherever their row
	// is, under any root, and read-only and unshared whatever the row says, so a forged
	// row on either can turn it into neither a write nor a share.
	DaimondMarksHere.seeds([
		{ owner: DEFAULT_IDS.Neil,      path: 'system/guide' },	// GUIDE_DIR
		{ owner: DEFAULT_IDS.Lucy, path: 'system/usage' },	// USAGE_DIR
	]);
	// page-split: install 110
	WITHHELD[DEFAULT_IDS.Lucy] = { workers: 0 };
	// page-split: install 111
	/* var */ _seededBeforeLoad = (function () {
		try { return localStorage.getItem(DEFAULTS_KEY) === '1'; }
		catch (e) { return false; }
	})();
} // page-split: end install
