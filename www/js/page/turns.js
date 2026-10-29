// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { Wasm } from './wasm.js';
import { SEND_ARROW, chatOutput, pg, unseenWhy } from './state.js';
import { dsEvent, fmtCtx, fmtTok, friendlyError, stripAnsi, t, tn, trail } from './util.js';
import { newMid, touchMsg } from './chatstore.js';
import { loadDevices, nominatedDeviceId } from './parcel_collect.js';
import { shortModel } from './parcel_apply.js';
import { cssEsc, deviceLabelFor, drawHandoffWorkers, isMobileDeviceSelf, peerReports, peerUiStateFor,
	reRunParked, selfDeviceId, turnRunnerId } from './handoff.js';
import { curGen, peerLeaseClaimed, sendUserMessage } from './send.js';
import { renderQueue } from './steer.js';
import { Files } from './files_view.js';
import { appendRatingLine, mountFileRates, mountRateControls, turnModelOf } from './rating.js';
import { answerAgain, continueStopped, continueTurn, drawSeatNote, lostRetryMid, mountTurnActions,
	notRunWhyKey, retryTurn, runnerRoad, seatNameOf, seatPlanNow, seatReason } from './sourcemenu.js';
import { fallback } from './passkey_phrase.js';
import { ASK_SILENT_MAX_MS, _openAsk, activeRunnerTurn, answerBlocker, armIdleBound, blockerFor,
	broadcastAskIfHandedOff, changeName, consentActPhrase, dialogIdleMs, runBlockedTurnHere } from './consent.js';
import { clearChat, spinnerEl } from './chats.js';
import { chatWindow, renderSessionList, tileCtxBar } from './tilestyle.js';
import { changeDiff } from './pending.js';
import { diamondModel } from './diamonds.js';
import { paintHeadAvatar, renderDiamondList } from './agentspanel.js';
import { crystalShown, renderCrystal } from './crystal.js';
import { _turnUndoRows, histAwayUndo } from './marks.js';
import { endBtn, jumpBtn, logRowText, renderWire, tOr } from './settingsui.js';
// page-split: end imports
let _contBtn, _saidJust, _endNews; // page-split: hoisted
// page-split: install 79

// A hover-revealed copy button on a message, copying its raw text (never
// the rendered HTML) to the clipboard.
var COPY_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h8"/></svg>';
export var TICK_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>';
// The rating controls, drawn as Copy is: 24 viewBox, stroked by `.ic`, no fill.
export var RATE_UP_SVG   = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
export var RATE_DOWN_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
export var RATE_MORE_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
// The app's closer, drawn rather than typed. The same path the static markup
// uses (www/index.html, every panel head), so a dialog built in JS wears the
// identical cross to one written in HTML.
export var CLOSE_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
function addMsgCopy(div, text) {
	var btn = document.createElement('button');
	btn.className = 'msg-copy';
	btn.title = t('common.copy'); btn.setAttribute('aria-label', t('chat.copy_message'));
	btn.innerHTML = COPY_SVG;
	btn.addEventListener('click', function (e) {
		e.stopPropagation();
		var t = typeof text === 'function' ? text() : text;
		function flash() { btn.innerHTML = TICK_SVG; btn.classList.add('done'); setTimeout(function () { btn.innerHTML = COPY_SVG; btn.classList.remove('done'); }, 1200); }
		if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(flash, function () {});
	});
	div.appendChild(btn);
}

// ── Copying an identifier ──────────────────────────────────
//
// A build id, a fingerprint, a device id: strings a person cannot usefully
// retype and regularly has to hand on -- into a bug report, a support
// message, a config file, the other device. Every one of them gets the SAME
// button from the one function below, so the behaviour, the icon, the
// feedback and the spoken name are decided in a single place.

/// Put `text` on the clipboard, resolving when it is there.
///
/// `navigator.clipboard` is refused often enough on a phone -- an insecure
/// context, a locked page, a permission never granted -- that a button which
/// only tries it is a button that sometimes does nothing and reports success.
/// The select-and-copy `fallback` below is what makes it honest.
export function copyToClipboard(text) {
	return new Promise(function (resolve, reject) {
		var s = String(text == null ? '' : text);
		if (!s) { reject(new Error('nothing to copy')); return; }
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(s).then(resolve, function () {
				fallback(s, resolve, reject);
			});
		} else { fallback(s, resolve, reject); }
	});
}

/// Say something to a screen reader without putting it on the screen.
///
/// The copy buttons are icon-only and their feedback is a tick, which is
/// nothing at all to a reader that does not see. The region is polite, so it
/// waits its turn rather than cutting across whatever is being read.
export function sayQuietly(msg) {
	var out = document.getElementById('copy-say');
	if (!out) return;
	// Cleared first: the same word twice running is otherwise announced once,
	// and pressing two copy buttons in a row is the ordinary case here.
	out.textContent = '';
	setTimeout(function () { out.textContent = msg; }, 30);
}

/// A small button that copies one identifier.
///
/// `what` names the value for a screen reader -- "the build id", "the id of
/// Chrome on macOS" -- because a panel of five buttons all called "Copy"
/// teaches a listener nothing about which is which.
///
/// `get` may be a string or a function. A function is read at the press, so a
/// value that changes after the button was drawn (the build this tab runs, a
/// renamed device) is copied as it stands rather than as it was.
///
/// The tick replaces the icon in place -- same 24-unit grid, same box -- so
/// the confirmation never moves what sits beside it.
export function idCopyBtn(what, get) {
	var b = document.createElement('button');
	b.type = 'button';
	b.className = 'copy-id';
	var name = tOr('copy.aria', 'Copy {what}', { what: what });
	b.title = name;
	b.setAttribute('aria-label', name);
	b.innerHTML = COPY_SVG;			// trusted markup, built here
	var back = null;
	function settle(cls, said) {
		if (back) clearTimeout(back);
		b.classList.remove('copied', 'failed');
		b.classList.add(cls);
		b.innerHTML = cls === 'copied' ? TICK_SVG : COPY_SVG;
		sayQuietly(said);
		back = setTimeout(function () {
			b.classList.remove('copied', 'failed');
			b.innerHTML = COPY_SVG;
			back = null;
		}, 1400);
	}
	b.addEventListener('click', function (e) {
		// Several of these sit inside or beside a row that is itself a button.
		// Copying must not also open what the row opens.
		e.preventDefault();
		e.stopPropagation();
		var text = typeof get === 'function' ? get() : get;
		text = String(text == null ? '' : text);
		if (!text) { settle('failed', tOr('copy.nothing', 'Nothing to copy')); return; }
		copyToClipboard(text).then(function () {
			settle('copied', t('toast.copied'));
		}, function () {
			settle('failed', tOr('copy.failed', 'Could not copy'));
		});
	});
	return b;
}

/// Put (or replace) the copy button beside the rail's version row.
///
/// Rebuilt rather than relabelled when the language changes: a button's
/// spoken name is written into it when it is made, so the one made at boot
/// would keep the language the app booted in for the rest of the session.
export function mountBuildCopy() {
	var host = document.getElementById('astat-release-copy');
	if (!host) return;
	host.innerHTML = '';
	host.appendChild(idCopyBtn(tOr('copy.what_build', 'the build id'), buildId));
}

/// The build id THIS TAB is running, or '' before anything has read it.
///
/// The log entry is preferred because it is the id that has been published;
/// the updater's stamp is the same string read straight from `build.json`,
/// and is the answer whenever the app is running something the log has not
/// caught up with -- which is most of the time, since builds are sealed
/// several times a day.
export function buildId() {
	try {
		var cur = window.DaimondRelease && DaimondRelease.current();
		if (cur && cur.build) return cur.build;
	} catch (e) { /* the log has not been read */ }
	try {
		if (window.DaimondUpdater && DaimondUpdater.booted()) return DaimondUpdater.booted();
	} catch (e) { /* the updater has not polled */ }
	return '';
}

/// The build the fleet SHOULD be on, as this device best knows it: the newer id
/// the updater has already seen on build.json (`pending`), else the id this tab
/// runs. A device on any other KNOWN build is behind what this one knows is
/// current -- the honest "old build" signal a device can compute with no central
/// authority, used by the Devices panel and the hand-off skew guard.
export function fleetCurrentBuild() {
	try {
		var p = window.DaimondUpdater && DaimondUpdater.pending && DaimondUpdater.pending();
		if (p) return String(p);
	} catch (e) { /* the updater has not polled */ }
	return buildId();
}

/// A COPY of a presence map with each record's `build` filled from the roster's
/// last-known build where the live beat did not carry one -- so the hand-off skew
/// guard has a build to judge a peer on even before the gateway relays it in
/// presence. A live presence build always wins; the roster is only the fallback.
/// Returns the map unchanged when nothing needs filling.
function presenceWithBuilds(presence) {
	if (!presence) return presence;
	var reg = null, out = null;
	Object.keys(presence).forEach(function (id) {
		var rec = presence[id];
		if (rec && rec.build) return;                 // the live beat already carries it
		if (reg === null) { try { reg = loadDevices(); } catch (e) { reg = {}; } }
		var rb = (reg[id] && reg[id].build) || '';
		if (!rb) return;
		if (out === null) { out = {}; Object.keys(presence).forEach(function (k) { out[k] = presence[k]; }); }
		var copy = {}; for (var f in rec) { if (Object.prototype.hasOwnProperty.call(rec, f)) copy[f] = rec[f]; }
		copy.build = rb;
		out[id] = copy;
	});
	return out || presence;
}

/// Does a device name read as a MOBILE-VIEW (phone) device? Coarse on purpose: an
/// iOS / Android / "mobile" name is a phone. This is the client-only classifier the
/// hand-off routing uses to keep a mobile-view device from being seated as another
/// device's worker (owner rule 2026-09-09). The gateway does not relay a mobile flag,
/// so the beat's label is the signal for a peer; this device knows its own view
/// precisely below.
function isMobileViewName(s) {
	return /iphone|ipad|ipod|android|\bios\b|\bmobile\b/i.test(String(s || ''));
}

/// Whether a live presence entry is a MOBILE-VIEW device. This device knows its own
/// view exactly (isPhoneViewport); a PEER is classified from the label it beats under
/// (or its roster line as a fallback). Unknown reads as NON-mobile, so a live desktop
/// is never wrongly withheld and the phone never falls to local while a real desktop is
/// present -- the owner's primary complaint. A durable per-device flag carried in the
/// blob is a Phase-B refinement; for Phase A the name is the client-only signal.
function presenceIsMobileView(id, rec) {
	// The device's OWN answer, carried on its beat, is final either way.
	if (rec && typeof rec.mobile === 'boolean') return rec.mobile;
	try { if (String(id) === selfDeviceId()) return isMobileDeviceSelf(); } catch (e) { /* fall through */ }
	// Then its roster line, which carries the same answer for a device that has
	// synced but is not beating in this snapshot.
	try {
		var ln = loadDevices()[id];
		if (ln && typeof ln.mobile === 'boolean') return ln.mobile;
	} catch (e) { /* no roster: the name below */ }
	var nm = (rec && rec.name) || '';
	if (!nm) { try { var r = loadDevices()[id]; nm = (r && (r.label || r.name)) || ''; } catch (e) { nm = ''; } }
	return isMobileViewName(nm);
}

/// A COPY of a presence map with each record stamped `mobileView`, so the election's
/// pure `handoffTarget` can exclude a mobile-view device without reaching for the
/// roster itself. Returns the map unchanged when nothing needs stamping.
function presenceWithMobile(presence) {
	if (!presence) return presence;
	var out = null;
	Object.keys(presence).forEach(function (id) {
		var rec = presence[id];
		var mv  = presenceIsMobileView(id, rec);
		if (rec && !!rec.mobileView === mv) return;			// already correct
		if (out === null) { out = {}; Object.keys(presence).forEach(function (k) { out[k] = presence[k]; }); }
		var copy = {}; for (var f in rec) { if (Object.prototype.hasOwnProperty.call(rec, f)) copy[f] = rec[f]; }
		copy.mobileView = mv;
		out[id] = copy;
	});
	return out || presence;
}

/// The presence map the election reads: build filled from the roster where the beat
/// did not carry one, and each record classified mobile-view. One call, so both
/// send-time and step-away paths annotate identically.
export function annotatePresence(presence) {
	return presenceWithMobile(presenceWithBuilds(presence));
}

/// Has device `id` shown it runs a handed-off turn on the set its asker sent? Its own
/// roster line says so (`modelset`), or, for a paired native runner, which has no roster
/// line, its own signed presence row does (`kind:'runner'`, `modelset:true`, relayed by
/// the gateway only from the runner's signed beat). A runner before the Models menu
/// (14ef947b) runs a following chat's errand, which carries no model of its own, on its
/// own default and says nothing (D-20261018-09 OR). It cannot be changed, so it is never
/// handed a turn: a device that has said it nowhere is a runner that cannot. ONE check,
/// so the election (`turnPresence`) and the door (`dispatchToPeer`) never disagree.
export function honoursModelSet(id) {
	if (!id) return false;
	try {
		var ln = loadDevices()[String(id)];
		if (ln && ln.modelset === true) return true;
	} catch (e) { /* no roster: ask the presence row */ }
	try {
		var pr = (window.DaimondPresence && DaimondPresence.snapshot && DaimondPresence.snapshot()) || {};
		var rec = pr[String(id)];
		return !!(rec && rec.kind === 'runner' && rec.modelset === true);
	} catch (e) { return false; }
}

/// The presence a TURN is seated from: the annotated map without the peers that have not
/// shown they honour the model set (`honoursModelSet`). Every turn's election reads it --
/// the send and the queue, Retry and Continue (`maybeAutoDispatch`), the switch
/// (`seatSwitchFor`, `seatPlanNow`) and the step-away hand-off -- so a runner that cannot
/// is not offered, the switch reads Here, and the turn runs here on this device's set.
/// The door (`dispatchToPeer`) and a say into a running turn (`sayToRunner`) ask it too.
export function turnPresence(presence) {
	var p = annotatePresence(presence) || {}, out = {}, self = selfDeviceId();
	Object.keys(p).forEach(function (id) {
		if (id === self || honoursModelSet(id)) out[id] = p[id];
	});
	return out;
}

/// The device running a turn of `chat` now (a live claim on one of its handed-off
/// turns), or ''. A busy machine is still seated for its own chat: a follow-up waits
/// in that chat's queue there, behind the turn it is running (H1, O3; lead, 12 Oct:
/// "no queue-on-busy" is about a runner busy with ANOTHER chat).
export function chatRunningOn(chat) {
	try {
		var ms = (chat && chat.messages) || [];
		for (var i = ms.length - 1; i >= 0; i--) {
			var m = ms[i];
			if (!m || !m.iturn || m.why !== 'dispatched') continue;
			var h = turnRunnerId(m.iturn);
			if (h) return h;
		}
	} catch (e) { /* no lease view: nothing queues */ }
	return '';
}

/// Presence with `busy` raised for every device this one already sees holding a
/// live claim on a turn of ANOTHER chat (H1, C1). Its own beat says so only on its
/// next beat; the claim says so the moment it lands, which is what a second chat sent
/// seconds after the first needs. Copies; never writes the shared snapshot.
export function presenceWithLeaseBusy(presence, chat) {
	var out = {};
	Object.keys(presence || {}).forEach(function (k) { out[k] = presence[k]; });
	try {
		var mine = Object.create(null);
		((chat && chat.messages) || []).forEach(function (m) { if (m && m.iturn) mine[String(m.iturn)] = 1; });
		var leases = DaimondLease.snapshot() || {};
		Object.keys(leases).forEach(function (tid) {
			if (mine[tid]) return;
			var h = DaimondLease.holder(tid);
			if (!h || !out[h]) return;
			var r = Object.assign({}, out[h]);
			r.busy = Math.max(r.busy | 0, 0) + 1;
			out[h] = r;
		});
	} catch (e) { /* the beat's own word stands */ }
	return out;
}

/// The preferred worker resolved to a LABEL, for the election's last-resort match on
/// a nominee whose id is not in presence. The match is UNIQUE-OR-NOTHING there
/// (`handoffTarget`), so this may be ambiguous without being dangerous; a derived name
/// now carries the device's own id tail, so two machines no longer collide by default.
/// Answers '' when no nominee is set or its label is unknown (a bare id slice is not a
/// label to match on).
export function preferredWorkerLabel() {
	try {
		var nom = nominatedDeviceId();
		if (!nom) return '';
		var lbl = deviceLabelFor(nom);
		if (!lbl || lbl === String(nom).slice(0, 6)) return '';
		return lbl;
	} catch (e) { return ''; }
}
// page-split: install 80

// Select mode: the thread is collapsed to its questions and each carries a tick, so several
// turns can be chosen and folded together.
export var _selectMode = false;
// page-split: install 81

/// Tag a node with the turn it belongs to. Answers and tool steps carry the number of the
/// question above them; the question carries its own.
export function tagTurn(node) {
	node.dataset.turn = String(pg._turn);
	return node;
}

/// Show or hide everything a question produced.
///
/// The question itself never hides -- hiding it would leave nothing to click to bring it back.
function setTurnOpen(userDiv, open) {
	var n = userDiv.dataset.turn;
	userDiv.classList.toggle('collapsed', !open);
	var kids = chatOutput.querySelectorAll('[data-turn="' + n + '"]');
	for (var i = 0; i < kids.length; i++) {
		if (kids[i] === userDiv) continue;
		kids[i].style.display = open ? '' : 'none';
	}
}
function isTurnOpen(userDiv) {
	return !userDiv.classList.contains('collapsed');
}
function userDivs() {
	return chatOutput.querySelectorAll('.chat-msg-user');
}

/// Open or close every turn at once.
export function setAllTurnsOpen(open) {
	var us = userDivs();
	for (var i = 0; i < us.length; i++) setTurnOpen(us[i], open);
}

/// Enter or leave select mode.
///
/// Entering collapses the thread to its questions, which is the view you want in order to
/// choose between them: a page of answers is not a list you can pick from. Leaving opens
/// them again and clears the ticks, so the mode has no residue.
export function setSelectMode(on) {
	_selectMode = on;
	chatOutput.classList.toggle('selecting', on);
	// The header lends select mode its room (see .chead.selecting): with the model picker and
	// the running cost still in place, three new chips crush the chat's own name to "Ch…".
	var head = document.querySelector('.panel.ai .chead');
	if (head) head.classList.toggle('selecting', on);
	if (pg.collapseBtn) pg.collapseBtn.classList.toggle('on', on);
	if (pg.selectTools) pg.selectTools.style.display = on ? '' : 'none';
	// FOLD SELECTED IS FOR AN ORDINARY CHAT ONLY. A daimon folds itself before
	// every round and its engine holds no messages a hand fold could cut, so the
	// control is hidden on a Diamond's chat — the same reason the surface Fold
	// button is (see index.html).
	var sf = document.getElementById('sel-fold');
	if (sf) sf.style.display = (on && pg.current && pg.current.diamondId) ? 'none' : '';
	// The whole-chat copy becomes a copy of what is selected while the mode is on.
	var cb = document.getElementById('chat-copy-btn');
	if (cb) cb.title = on ? tOr('chat.copy_selected', 'Copy selected')
		: tOr('chat.copy_all_help', 'Copy the whole conversation to the clipboard');
	if (!on) pickAll(false);
	updateSelCount();
}

/// Select or clear every LEAF tile — top-level and nested alike — and bring
/// every container's checkbox into line (owner review 2026-09-04: selection is
/// per-tile now, so Select all reaches the Thinking step inside a rollup too).
export function pickAll(on) {
	var tiles = chatOutput.querySelectorAll('.ctile');
	for (var i = 0; i < tiles.length; i++) tiles[i].classList.toggle('sel', on);
	var rolls = chatOutput.querySelectorAll('.crollup');
	for (var r = 0; r < rolls.length; r++) syncContainerSel(rolls[r]);
	updateSelCount();
}

/// The turns folding should act on, read off the selected LEAF tiles. A leaf
/// carries the number of the turn it belongs to; several leaves in one turn fold
/// that one turn once.
export function pickedTurns() {
	var out = [], seen = {};
	var tiles = chatOutput.querySelectorAll('.ctile.sel');
	for (var i = 0; i < tiles.length; i++) {
		var n = Number(tiles[i].dataset.turn);
		if (!isNaN(n) && !seen[n]) { seen[n] = 1; out.push(n); }
	}
	return out;
}

/// Scroll so the question being walked to sits at the top of the thread.
///
/// Pressing again steps back to the one before it, which is the point: a very long answer is
/// walked past by its heading, not scrolled through. A new question resets the walk, so the
/// button always starts from the bottom of the conversation as it now stands.
export function jumpBack() {
	var us = userDivs();
	if (!us.length) return;
	pg._jumpAt = (pg._jumpAt < 0) ? us.length - 1 : Math.max(0, pg._jumpAt - 1);
	var el = us[pg._jumpAt];
	// Measured, not computed from offsetTop: the thread is not necessarily the offset parent.
	setScrollTop(chatOutput.scrollTop
		+ el.getBoundingClientRect().top - chatOutput.getBoundingClientRect().top);
}

/// Back to the bottom of the thread, where the conversation is.
///
/// The walk is reset as well as the scroll: having come back down, the next ↑
/// starts again from the last question rather than from wherever the walk had
/// got to, which is what a user who has just returned to the bottom means by it.
export function jumpEnd() {
	setScrollTop(chatOutput.scrollHeight);
	pg._jumpAt = -1;
}

/// Show each walk-back button only while it has somewhere to go: a contextual control is hidden,
/// not dimmed (`DaimondAnswer.shown`). A rebuild's thread is half drawn and reads as empty, so
/// mid-rebuild the pair KEEPS what it showed -- hiding it and showing it again a moment later
/// shifts the bar under a pointer on its way to Send -- and `renderHistory` asks again at its end.
export function syncJumps() {
	if (!jumpBtn || !endBtn) return;
	if (_renderingHistory) return;
	var s = { users: userDivs().length, top: chatOutput.scrollTop, height: chatOutput.scrollHeight, view: chatOutput.clientHeight };
	DaimondAnswer.show(jumpBtn, DaimondAnswer.shown.jump_back(s));
	DaimondAnswer.show(endBtn, DaimondAnswer.shown.jump_end(s));
	var away = DaimondAnswer.shown.jump_end(s);
	if (!away) _endNews = false;			// back at the end: the activity is seen
	endBtn.classList.toggle('has-news', _endNews && away);
}

// ── The chat tile ──────────────────────────────────────────
//
// One uniform, collapsible tile per unit of a turn, so the transcript reads as
// one system rather than five bespoke bubbles. A coloured label bar is the
// collapse control; the type colours it from the app's own semantic tokens
// (see css/app.css, .ctile). Direction of travel sets a small indent — what is
// SENT to the model (You, System) sits right, what comes FROM it (Thinking,
// Daimond) sits left, and a Tool, which runs locally, is centred.
//
// Every render path in this file builds its content into one of these, so the
// streaming turn and a reload draw the identical shape.
var TILE_DIR  = { user: 'to', wire: 'to', think: 'from', reply: 'from', tool: 'local', handoff: 'local',
	leak: 'local', rating: 'local' };
// The class a tile rolls up under. Thinking and Tool share `work`, so an alternating run
// of the two is one group (D-20261007-04); System rolls up only with System.
var TILE_ROLL = { think: 'work', tool: 'work', wire: 'wire' };

/// The speaker word for a tile type, translated where a key exists.
function tileWho(type) {
	switch (type) {
		case 'user':  return tOr('chat.who_you', 'You');
		case 'think': return tOr('chat.thinking', 'Thinking');
		case 'reply': return tOr('chat.who_daimond', 'Daimond');
		case 'tool':  return tOr('chat.who_tool', 'Tool');
		case 'wire':  return tOr('chat.who_system', 'System');
		case 'handoff': return tOr('chat.who_handoff', 'Hand-off');
		// The APP's own voice, like Tool and System: the model did not say this
		// happened, the app noticed that it had.
		case 'leak':  return tOr('chat.who_leak', 'Tool call');
	}
	return '';
}

/// The short name of the model answering the conversation on screen, for the
/// Thinking and Daimond tile headers — so each response says which model
/// produced it (owner review 2026-09-04). `current` is the chat on an ordinary
/// chat and the daimon's own record on a Diamond's chat face; the daimon's names
/// its Diamond's model (`turnModelOf`), never a copy of its own. The open Diamond
/// and the app default fill in behind them.
export function respModel() {
	var own = pg.current ? turnModelOf(pg.current) : null;
	var dia = (pg.currentDiamond && pg.currentDiamond.id) ? diamondModel(pg.currentDiamond.id) : null;
	var at  = (own && own.model) ? own : (dia && dia.model) ? dia
		: { provider: '', model: (pg.cfg && pg.cfg.model) || '' };
	return at.model ? shortModel(at.model, at.provider) : '';
}

/// The tile header's own local time, right of the peek and left of the
/// controls: terse, muted, no label. `ts` is the message's own epoch-ms
/// instant; falsy (a tile with no timestamp -- a record from before this
/// shipped, or one of the app's own furniture that is not a stored
/// message) draws NOTHING, rather than inventing one. Every caller of
/// `buildTile` is expected to have already decided what `ts` means for
/// its own tile -- a stored message's own `m.ts` when redrawing history,
/// `Date.now()` for one being drawn as it happens -- so this is a pure
/// draw and never a fallback.
///
/// Two child spans carry the full year, on the account's calendar, and the
/// two-digit fallback css/responsive.css swaps to under 380px; both read the
/// same instant, so nothing here has to know which one is on screen.
function tileTimeEl(ts) {
	if (!ts || !window.DaimondTime) return null;
	var el = document.createElement('span');
	el.className = 'ctile-time';
	el.setAttribute('data-ts', String(ts));	// for a calendar change to redraw
	var full = document.createElement('span');
	full.className = 'ctile-time-full';
	var short = document.createElement('span');
	short.className = 'ctile-time-short';
	el.appendChild(full); el.appendChild(short);
	paintTileTime(el);
	return el;
}

function paintTileTime(el) {
	var ts = Number(el.getAttribute('data-ts'));
	el.title = DaimondTime.fmtFull(ts);		// full ISO instant, with zone
	el.firstChild.textContent = DaimondTime.fmt(ts);
	el.lastChild.textContent = DaimondTime.fmtShort(ts);
}
// page-split: install 82

/// One tile shell: the label bar (dot · speaker · meta · grow · peek · time ·
/// copy/checkbox) over a body. `opts.expanded` opens it; `opts.copy` is the
/// text (or a function returning it) the header copy button puts on the
/// clipboard; `opts.ts` is the local time shown at the right of the bar (see
/// `tileTimeEl`). `opts.head === false` draws the body alone, with no header bar: a
/// live hand-off tile's footer already says its state (`appendDispatchedTile`).
export function buildTile(type, opts) {
	opts = opts || {};
	var tile = document.createElement('div');
	tile.className = 'ctile csel-unit' + (opts.expanded ? '' : ' collapsed') + (opts.result ? ' ctile-result' : '');
	tile.dataset.t = type;
	tile.dataset.dir = TILE_DIR[type] || 'from';
	// The message's own time, so the lens tells a line drawn as history from news (`uiScan`).
	if (opts.ts) tile.setAttribute('data-made', String(opts.ts));
	var lbl = document.createElement('div');
	lbl.className = 'ctile-lbl';
	var dot = document.createElement('span'); dot.className = 'ctile-dot';
	var who = document.createElement('span'); who.className = 'ctile-who';
	who.textContent = opts.who != null ? opts.who : tileWho(type);
	var meta = document.createElement('span'); meta.className = 'ctile-meta';
	if (opts.meta) meta.textContent = opts.meta;
	var grow = document.createElement('span'); grow.className = 'ctile-grow';
	var peek = document.createElement('span'); peek.className = 'ctile-peek';
	var time = tileTimeEl(opts.ts);
	var ctl  = document.createElement('span'); ctl.className = 'ctile-ctl';
	var copy = document.createElement('button');
	copy.type = 'button'; copy.className = 'ctile-copy'; copy.innerHTML = COPY_SVG;
	copy.title = t('common.copy'); copy.setAttribute('aria-label', t('chat.copy_message'));
	var chk = document.createElement('span'); chk.className = 'ctile-chk';
	ctl.appendChild(copy); ctl.appendChild(chk);
	lbl.appendChild(dot); lbl.appendChild(who); lbl.appendChild(meta);
	lbl.appendChild(grow); lbl.appendChild(peek);
	if (time) lbl.appendChild(time);
	lbl.appendChild(ctl);
	var body = document.createElement('div'); body.className = 'ctile-body';
	if (opts.head !== false) tile.appendChild(lbl);
	tile.appendChild(body);
	tile._lbl = lbl; tile._body = body; tile._peek = peek; tile._meta = meta; tile._who = who; tile._time = time;
	lbl.addEventListener('click', function (e) {
		if (e.target.closest('.ctile-copy, .ctile-rate')) return;
		if (chatOutput.classList.contains('selecting')) { toggleSelLeaf(tile); return; }
		var sel = window.getSelection();
		if (sel && String(sel).length) return;
		if (type === 'user') { setTurnOpen(tile, !isTurnOpen(tile)); }
		else {
			// A reader who works a live thinking tile owns it from then on, so
			// `postToChat` stops folding it away under them.
			if (type === 'think') tile._held = true;
			tile.classList.toggle('collapsed');
		}
	});
	copy.addEventListener('click', function (e) {
		e.stopPropagation();
		var src = tile._copyText ? tile._copyText()
			: (typeof opts.copy === 'function' ? opts.copy() : opts.copy);
		if (src == null) src = body.innerText || '';
		copyToClipboard(String(src)).then(function () {
			copy.innerHTML = TICK_SVG; copy.classList.add('done');
			setTimeout(function () { copy.innerHTML = COPY_SVG; copy.classList.remove('done'); }, 1200);
		}, function () {});
	});
	return tile;
}

/// Set the one-line peek a collapsed tile shows.
export function tilePeek(tile, text) {
	if (tile && tile._peek) tile._peek.textContent = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 140);
}

// ── Rollups ────────────────────────────────────────────────
//
// A run of consecutive tiles of one class (Thinking and Tools together, or System)
// collapses into one container with a count badge; a run of one stands as an ordinary
// tile. Accreted at `postToChat`, the single door every render path goes through, so
// the live turn and a reload group identically. The run a new tile joins is read off
// the thread itself (`lastContent`): the box standing last, if it is of the tile's class.
// Display only -- the stored messages are one per tile either way.

/// The last element of the conversation, ignoring the turn indicator, the queue box
/// (always kept beneath it) and any tile pinned to the foot while it awaits the reader.
/// Null when a pinned tile's slot lies between it and the end: the run was closed there.
function lastContent() {
	for (var n = chatOutput.lastChild; n; n = n.previousSibling) {
		if (n.nodeType === 8) { if (n._slotOf) return null; continue; }
		if (n.nodeType !== 1) continue;
		if (n === spinnerEl || n.id === 'chat-queued' || n._slot) continue;
		return n;
	}
	return null;
}

// ── A tile that awaits the reader stands last ─────────────────────
//
// D-20261007-05, the owner's words: "Decision tiles should go to the end of the
// transcript whilst active ... once it is completed, the Decision tile then should go
// back into its original order in the transcript." The end of a transcript is where the
// reader looks for the latest output and for anything they must do. So an ask card the
// model is waiting on, and a hand-off tile held on a blocker, are drawn after the last
// content tile, in their own order, above the turn indicator and the queue box; and a
// comment node, the SLOT, keeps the place they were asked in. Answered, or the blocker
// gone, the tile moves back to its slot and the Thinking-and-Tools run it interrupted
// splits in two around it. Display only: the stored messages are the same either way.
//
// A tile opts in with `_awaits`, a function that says whether it still awaits. It is
// pinned while `_slot` is set. `_awaits` is read again at the next tile drawn.
//
// THE STATE OF A RUNNING TURN STANDS LAST (D-20261014-02, UNBLOCK-6): "the user is
// looking at the end of the transcript for the state/progress, this needs to always be
// at the end of the transcript". A PROGRESS tile -- the turn indicator, and the live
// hand-off tile of a turn running elsewhere ("<device> is on it", `_progress`) -- is
// pinned too, so the turn's Thinking, Tools and answer tiles land above it as they
// arrive. While a Decision is open, the Decision is that state: it stands below the
// progress tiles. The foot reads: content, progress, Decisions, queue box.

/// The first of the tiles pinned to the foot of the thread, or null.
function firstAwaiting() {
	var first = null;
	for (var n = chatOutput.lastChild; n; n = n.previousSibling) {
		if (n.nodeType !== 1) continue;
		if (n === spinnerEl || n.id === 'chat-queued') continue;
		if (!n._slot) break;
		first = n;
	}
	return first;
}

/// The first pinned Decision at the foot of the thread -- a pinned tile that is not a
/// progress tile -- or null.
function firstDecision() {
	var first = null;
	for (var n = chatOutput.lastChild; n; n = n.previousSibling) {
		if (n.nodeType !== 1) continue;
		if (n === spinnerEl || n.id === 'chat-queued') continue;
		if (!n._slot) break;
		if (!n._progress) first = n;
	}
	return first;
}

/// The element the content of the thread ends above: the turn indicator, else the queue box.
function tailAnchor() {
	return (spinnerEl && spinnerEl.parentNode === chatOutput) ? spinnerEl : document.getElementById('chat-queued');
}

/// Draw a tile that awaits the reader at the foot of the thread, leaving a slot where
/// it would otherwise have stood. The slot is the end of the run it interrupts, so
/// the run goes on past it.
function pinAwaiting(node) {
	if (node._slot) return;
	var slot = document.createComment('');
	slot._slotOf = node;
	node._slot = slot;
	var last = lastContent();
	if (last && last._body && last.classList.contains('crollup') && last.id !== 'wire-head') last._body.appendChild(slot);
	else chatOutput.insertBefore(slot, firstAwaiting() || tailAnchor());
	// A progress tile stands above any open Decision; a Decision stands last of all.
	var q = document.getElementById('chat-queued');
	chatOutput.insertBefore(node, (node._progress && firstDecision()) || q);
	placeFurniture();
}

/// Return a pinned tile to its slot. A slot inside a rollup splits the rollup there:
/// what followed it becomes a rollup of its own, folded as the first is.
function unpinAwaiting(node) {
	var slot = node._slot;
	if (!slot) return;
	node._slot = null;
	var host = slot.parentNode;
	if (!host) return;
	if (host === chatOutput) { host.insertBefore(node, slot); slot.remove(); return; }
	var box = host.parentNode, par = box.parentNode;
	var lead = [], trail = [], seen = false, isEl = function (c) { return c.nodeType === 1; };
	for (var c = host.firstChild; c; c = c.nextSibling) {
		if (c === slot) seen = true; else (seen ? trail : lead).push(c);
	}
	var hasLead = lead.some(isEl), hasTrail = trail.some(isEl);
	slot.remove();
	if (hasLead && hasTrail) {
		var box2 = makeRollup(box._type, trail.filter(isEl)[0]);
		box2.classList.toggle('collapsed', box.classList.contains('collapsed'));
		trail.forEach(function (c) { box2._body.appendChild(c); });
		par.insertBefore(node, box.nextSibling);
		par.insertBefore(box2, node.nextSibling);
		rollUpdate(box); rollUpdate(box2);
		syncContainerSel(box); syncContainerSel(box2);
	} else if (hasLead) {
		// Only other slots follow: they stand after the tile, at the top level.
		var ref = box.nextSibling;
		par.insertBefore(node, ref);
		trail.forEach(function (c) { par.insertBefore(c, ref); });
	} else {
		// Nothing before it in the rollup: the tile stands above it, with any earlier slots.
		lead.forEach(function (c) { par.insertBefore(c, box); });
		par.insertBefore(node, box);
	}
}

/// Send home every pinned tile that no longer awaits the reader.
function reconcileAwaiting() {
	var gone = [];
	for (var n = chatOutput.lastChild; n; n = n.previousSibling) {
		if (n.nodeType !== 1) continue;
		if (n === spinnerEl || n.id === 'chat-queued') continue;
		if (!n._slot) break;
		if (!n._awaits()) gone.push(n);
	}
	for (var i = gone.length - 1; i >= 0; i--) unpinAwaiting(gone[i]);
}

/// Make the container for a run of class `cls` ('work' or 'wire'). `first` is the tile
/// that opens it; it sets the container's direction of travel.
export function makeRollup(cls, first) {
	var box = document.createElement('div');
	box.className = 'crollup csel-unit solo collapsed';
	box.dataset.t = cls;
	box.dataset.dir = TILE_DIR[first.dataset.t || cls] || 'from';
	if (first.dataset.turn != null) box.dataset.turn = first.dataset.turn;
	var lbl = document.createElement('div');
	lbl.className = 'crollup-lbl';
	var dot = document.createElement('span'); dot.className = 'ctile-dot';
	var who = document.createElement('span'); who.className = 'ctile-who';
	who.textContent = cls === 'work' ? tOr('chat.who_work', 'Thinking and Tools') : tileWho(cls);
	var cnt = document.createElement('span'); cnt.className = 'crollup-count';
	var noun = document.createElement('span'); noun.className = 'ctile-meta';
	var grow = document.createElement('span'); grow.className = 'ctile-grow';
	var peek = document.createElement('span'); peek.className = 'crollup-peek';
	var ctl  = document.createElement('span'); ctl.className = 'ctile-ctl';
	var copy = document.createElement('button');
	copy.type = 'button'; copy.className = 'ctile-copy'; copy.innerHTML = COPY_SVG;
	copy.title = t('common.copy');
	var chk = document.createElement('span'); chk.className = 'ctile-chk';
	ctl.appendChild(copy); ctl.appendChild(chk);
	lbl.appendChild(dot); lbl.appendChild(who); lbl.appendChild(cnt); lbl.appendChild(noun);
	lbl.appendChild(grow); lbl.appendChild(peek); lbl.appendChild(ctl);
	var rbody = document.createElement('div'); rbody.className = 'crollup-body';
	box.appendChild(lbl); box.appendChild(rbody);
	box._body = rbody; box._count = cnt; box._noun = noun; box._peek = peek; box._type = cls;
	lbl.addEventListener('click', function (e) {
		if (e.target.closest('.ctile-copy, .ctile-rate')) return;
		if (chatOutput.classList.contains('selecting')) { toggleSelContainer(box); return; }
		box.classList.toggle('collapsed');
	});
	copy.addEventListener('click', function (e) {
		e.stopPropagation();
		copyToClipboard(rbody.innerText || '').then(function () {
			copy.innerHTML = TICK_SVG; copy.classList.add('done');
			setTimeout(function () { copy.innerHTML = COPY_SVG; copy.classList.remove('done'); }, 1200);
		}, function () {});
	});
	return box;
}

// ── The running turn's newest thought stays open ──────────────────
//
// D-20261009-28, the owner's words: "a whole series of Thinking and Tool tiles in
// sequence, I want these progressively folded into a Thinking and Tools tile, but still
// showing the word for word output of the latest Thinking tile." So while the turn on
// screen runs, the group holding its newest Thinking tile stays folded at its head and
// shows that one tile open beneath it, growing as it streams. When the turn ends it
// folds as the stored view draws it. The open state is decided here alone.
var liveLatest = null;      // the running turn's newest Thinking tile, held open

/// Open the running turn's newest Thinking tile in its folded group, folding the one
/// it replaces; with no turn running, fold the last one.
export function liveWork() {
	var next = null;
	if (curGen()) {
		var thinks = chatOutput.querySelectorAll('.crollup[data-t="work"] > .crollup-body > .ctile[data-t="think"]');
		var cand = thinks.length ? thinks[thinks.length - 1] : null;
		var asks = chatOutput.querySelectorAll(':scope > .chat-msg-user');
		var ask = asks.length ? asks[asks.length - 1] : null;
		// Only this turn's: a thought above the question belongs to a settled turn.
		if (cand && (!ask || (ask.compareDocumentPosition(cand) & Node.DOCUMENT_POSITION_FOLLOWING))) next = cand;
	}
	if (next === liveLatest) return;    // a reader who folded it keeps it folded
	var prev = liveLatest;
	liveLatest = next;
	if (prev) {
		prev.classList.remove('live-latest');
		if (!prev._held) prev.classList.add('collapsed');
		var pbox = prev.closest('.crollup');
		if (pbox) pbox.classList.remove('live');
	}
	if (next) {
		next.classList.add('live-latest');
		next.classList.remove('collapsed');
		next.closest('.crollup').classList.add('live');
	}
}

function rollNoun(cls, n) {
	if (cls === 'work') return tn('chat.roll_work', n, { n: n });
	if (cls === 'wire') return tn('chat.roll_system', n, { n: n });
	return '';
}

/// Re-read a rollup's child count and refresh its badge, noun and peek.
export function rollUpdate(box) {
	var kids = box._body.querySelectorAll(':scope > .ctile');
	var n = kids.length;
	// A nested tile is not its own selectable unit and takes no indent — the
	// container gives it both.
	for (var k = 0; k < n; k++) { kids[k].classList.remove('csel-unit'); kids[k].dataset.dir = ''; }
	box.classList.toggle('solo', n < 2);
	box._count.textContent = String(n);
	box._count.style.display = n < 2 ? 'none' : '';
	box._noun.textContent = n < 2 ? '' : rollNoun(box._type, n);
	// The most telling one-liner per kind: a Tool's name-and-outcome, a System
	// part's name, a thinking step's thought.
	var bits = [];
	for (var i = 0; i < kids.length && bits.length < 3; i++) {
		var pick = box._type === 'wire' ? '_who' : kids[i].dataset.t === 'tool' ? '_meta' : '_peek';
		var el = kids[i][pick] || kids[i]._peek || kids[i]._meta || kids[i]._who;
		var m = (el && el.textContent) || '';
		bits.push(m.length > 24 ? m.slice(0, 24) + '…' : m);
	}
	box._peek.textContent = bits.join(' · ');
}

// ── Selection ──────────────────────────────────────────────
//
// SELECTION LIVES ON THE LEAF TILE (owner review 2026-09-04). Every `.ctile`
// carries `.sel` when ticked — a top-level tile, or a Thinking/Tool/System step
// nested in a rollup. A rollup CONTAINER is a control, not a selection: ticking
// its checkbox ticks all its children, and its own box shows filled when they
// are all ticked, a dash when only some are, empty when none. Folding still
// works on TURNS, so `pickedTurns` reads the turn numbers off the ticked leaves.
//
// This replaced a model where a nested tile selected the whole rollup and a
// solo tile's tick landed on a container whose label was hidden — so a child's
// checkbox, and a standalone Thinking tile's, appeared to do nothing.

/// The child leaves of a rollup container.
function rollLeaves(box) {
	return box._body ? box._body.querySelectorAll(':scope > .ctile')
		: box.querySelectorAll('.crollup-body > .ctile');
}

/// Reflect a container's children on its own checkbox. A SOLO container has no
/// visible box — its single child stands as itself — so it never carries the mark.
function syncContainerSel(box) {
	if (box.classList.contains('solo')) { box.classList.remove('sel', 'indeterminate'); return; }
	var kids = rollLeaves(box), n = 0;
	for (var i = 0; i < kids.length; i++) if (kids[i].classList.contains('sel')) n++;
	box.classList.toggle('sel', kids.length > 0 && n === kids.length);
	box.classList.toggle('indeterminate', n > 0 && n < kids.length);
}

/// Tick or untick one leaf tile, then bring its container's box into line.
function toggleSelLeaf(tile) {
	if (!tile) return;
	tile.classList.toggle('sel');
	var box = tile.closest('.crollup');
	if (box) syncContainerSel(box);
	updateSelCount();
}

/// A container's checkbox ticks all its children, or clears them when they are
/// already all ticked.
function toggleSelContainer(box) {
	if (!box) return;
	var kids = rollLeaves(box), allSel = kids.length > 0;
	for (var i = 0; i < kids.length; i++) if (!kids[i].classList.contains('sel')) { allSel = false; break; }
	for (var j = 0; j < kids.length; j++) kids[j].classList.toggle('sel', !allSel);
	syncContainerSel(box);
	updateSelCount();
}
function updateSelCount() {
	var el = document.getElementById('sel-count');
	if (!el) return;
	var n = chatOutput.querySelectorAll('.ctile.sel').length;
	el.textContent = n ? tn('chat.selected_n', n, { n: n }) : '';
}

// ── #22: the changed-files table at the end of a turn ─────────────────
// The engine already ends every file-changing turn with the tail-note user
// message (diamond_versions.rs tail_note → wasm/app.rs:2870). This diverts
// that one message into the table the proposal asked for: one row per file,
// name on the left, +N −M on the right, 6 rows then a fold.
var _TAIL_MORE = 6;   // rows before the "show N more" fold

/// Parse the engine's own tail note into { count, v, files, rest }.
/// The shape is diamond_versions.rs:726's, and this is the only string that
/// ever reaches here — anything else draws as an ordinary user message.
export function _parseTailNote(text) {
	var m = /^\[Daimond: this turn changed (\d+) files? \(v(\d+)\): (.+?)\. The user can restore/.exec(String(text || ''));
	if (!m) return null;
	var shown = m[3].split(',').map(function (x) { return x.trim(); }).filter(Boolean);
	var rest = 0;
	var last = shown.length ? shown[shown.length - 1] : '';
	var rm = /^(.+) and (\d+) more$/.exec(last);
	if (rm) { rest = Number(rm[2]); shown[shown.length - 1] = rm[1].trim(); }
	return { count: Number(m[1]), v: Number(m[2]), files: shown, rest: rest };
}

/// What a Files tile is drawn from, or null when the text is not a tail note: the parse, the Diamond
/// the note's chat belongs to, and the handles of the rows the note's own records name. A row whose
/// handle is not in `have` is drawn without one, and so is never offered for a rating.
function _tailNoteParts(text, chat, prod) {
	var p = _parseTailNote(text);
	if (!p) return null;
	var have = new Set();
	(Array.isArray(prod) ? prod : []).forEach(function (r) {
		if (r && r.k === 'file' && typeof r.h === 'string') have.add(r.h);
	});
	// THE CHAT IS THE AUTHORITY (S-HAND #4/#6-tile). The note lives in this chat's
	// transcript, so the Diamond it belongs to is `chat.diamondId` -- NOT `currentDiamond`,
	// which is null for a daimon chat opened from the CHAT LIST (chats select the chat but
	// no Diamond). With id '' the manifest lookup was empty, every row's delta undefined,
	// and `openTurnFile` had no hash to fall back to -- the whole tile was dead on click,
	// which is the owner-hit bug. `currentDiamond` remains the fallback for a note drawn
	// while a Diamond is open the ordinary way.
	var id = (chat && chat.diamondId) || (pg.currentDiamond ? pg.currentDiamond.id : '');
	return { p: p, id: id, have: have };
}

/// The Files table from what the note itself says: every file it names and no counts, at once, on
/// any device. A tile draws from the data the device has and is enriched when more arrives, so
/// this never waits on the version store (`_tailNoteTable` adds the counts).
///
/// `files` is the structured list the turn row carries (`turnFileList`, #8): every file the turn
/// wrote, with the `+N −M` counted at the turn's end. Where it is present the rows are drawn from
/// it alone, like a chat's `files_log` row (J6), because the note names only six and then "and N
/// more", which no row can be drawn from. A row from before the list falls back to the note.
function _tailNoteNames(text, chat, prod, files) {
	var q = _tailNoteParts(text, chat, prod);
	if (!q) return null;
	var names = [], byPath = {};
	(Array.isArray(files) ? files : []).forEach(function (f) {
		if (!f || typeof f.path !== 'string' || !f.path || byPath[f.path]) return;
		names.push(f.path);
		byPath[f.path] = { path: f.path, hash: f.gone ? '' : (f.hash || ''), gone: !!f.gone,
			add: typeof f.add === 'number' ? f.add : null, del: typeof f.del === 'number' ? f.del : null };
	});
	if (names.length) return _filesBox(q.id, names.length, q.p.v, names, 0, byPath, q.have, true);
	return _filesBox(q.id, q.p.count, q.p.v, q.p.files, q.p.rest || 0, {}, q.have, false);
}

/// The changed-files table for one turn, or null when the text is not the tail note, with the
/// +N −M of the version store folded in where the store holds this version (`box._counted`).
/// Names open the file (openFile); the +N −M loads the version store's diff and folds it in
/// under the row, History-style.
async function _tailNoteTable(text, chat, prod) {
	var q = _tailNoteParts(text, chat, prod);
	if (!q) return null;
	// The manifest rows for this version: was→hash per file, so the delta
	// comes from the version store, never re-derived from the bytes on disk.
	var ms = [], mv = null;
	try {
		ms = (await DaimondVersions.manifests(q.id)) || [];
		mv = ms.find(function (m) { return m && m.version === q.p.v; }) || null;
	} catch (e) { ms = []; mv = null; }
	var byPath = {}, names = [];
	((mv && mv.files) || []).forEach(function (e) {
		if (e && e.path && !byPath[e.path]) { byPath[e.path] = e; names.push(e.path); }
	});
	if (!mv) _filesNoStore(q.id, q.p.v, ms);
	// The manifest names every file; the note only six and "and N more" (#8).
	var box = names.length ? _filesBox(q.id, names.length, q.p.v, names, 0, byPath, q.have, false)
		: _filesBox(q.id, q.p.count, q.p.v, q.p.files, q.p.rest || 0, byPath, q.have, false);
	box._counted = !!mv;
	return box;
}

/// Say once a version, through the feed, that a Files tile was drawn without its version on this
/// device. A Diamond travels whole, so a device that has the note should have the version too: the
/// tile falls back to the names, and this keeps the fallback from hiding a sync that is behind.
/// A version the store has since pruned (it holds newer ones) is not a fault and says nothing.
var _noStoreSaid = {};
function _filesNoStore(id, v, ms) {
	if (!id || String(id).indexOf('chat:') === 0) return;   // a chat keeps no version store
	var top = 0;
	(ms || []).forEach(function (m) { if (m && m.version > top) top = m.version; });
	if (top > v) return;
	var k = id + '@' + v;
	if (_noStoreSaid[k]) return;
	if (Object.keys(_noStoreSaid).length > 200) _noStoreSaid = {};
	_noStoreSaid[k] = 1;
	dsEvent('files.nostore', { id: String(id), v: v, held: top, dev: String(selfDeviceId() || '').slice(0, 12) });
}

/// Fill a Files tile's body from a tail note: at once from the names the note carries, then again with
/// the counts when the version store answers. Never blank: a note that does not parse is shown as the
/// words it is, so a tile never opens on nothing.
function _fillFilesTile(tile, text, chat, prod, files) {
	var body = tile.querySelector('.ctile-body');
	if (!body) return;
	var first = _tailNoteNames(text, chat, prod, files);
	if (!first) { body.textContent = text; return; }
	body.replaceChildren(first);
	mountFileRates(first);
	// A row carrying its list has its counts already, and needs no store to be whole.
	if (Array.isArray(files) && files.length) return;
	_tailNoteTable(text, chat, prod).then(function (tbl) {
		if (!tbl || !tbl._counted) return;
		body.replaceChildren(tbl);
		mountFileRates(tbl);
	}).catch(function () { /* the names stay */ });
}

/// The Files box: a head, one row a file, and a fold after `_TAIL_MORE` rows. The Diamond's tail
/// note and a chat's `files_log` draw through here, so a row is one drawing. `byPath` holds each
/// row's manifest entry. `still` is a row drawn from its record alone (a chat's), whose delta
/// never asks the version store, so it reads the same on a device that does not hold it (J6).
function _filesBox(id, count, v, names, rest, byPath, have, still) {
	var box = document.createElement('div');
	box.className = 'turn-files';
	var head = document.createElement('div');
	head.className = 'turn-files-head';
	head.textContent = tn('chat.turn_files', count, { n: count });
	box.appendChild(head);
	var rows = document.createElement('div');
	rows.className = 'turn-files-rows';
	var shown = names.slice(0, _TAIL_MORE);
	var restCount = names.length - shown.length;	// held, behind the fold
	shown.forEach(function (name) { rows.appendChild(_turnFileRow(id, name, byPath[name], v, have, still)); });
	// Files the note only counts ("and N more") have no name on this device, so no fold can
	// show them: the count is said as text, never offered as a button with nothing behind it.
	var unknown = null;
	if (rest > 0) {
		unknown = document.createElement('div');
		unknown.className = 'turn-file-rest';
		unknown.textContent = tn('chat.turn_files_rest', rest, { n: rest });
	}
	if (restCount > 0) {
		var more = document.createElement('button');
		more.type = 'button';
		more.className = 'turn-file-more';
		// #22 vision pass: the plural lookup (tn → '.one'/'.other') shows the raw key
		// on screen because only the flat key exists in every catalogue; the flat key is it.
		more.textContent = t('chat.turn_files_more', { n: restCount });
		more.addEventListener('click', function () {
			// Unfold in place: the fold button goes, the remaining rows follow.
			names.slice(_TAIL_MORE).forEach(function (nm) {
				rows.insertBefore(_turnFileRow(id, nm, byPath[nm], v, have, still), more);
			});
			restCount = 0; more.remove();
			mountFileRates(rows);
		});
		rows.appendChild(more);
	}
	if (unknown) rows.appendChild(unknown);
	box.appendChild(rows);
	return box;
}

/// A chat's Files row from the `prod` records of its `files_log`, and nothing else: the path comes
/// from each record's handle and a hash of '' means the file is gone. Null where there is no row.
function _filesLogBox(recs, delta) {
	var names = [], byPath = {}, have = new Set(), store = '', v = 0, cnt = {};
	(Array.isArray(delta) ? delta : []).forEach(function (d) { if (d && typeof d.h === 'string') cnt[d.h] = d; });
	recs.forEach(function (r) {
		var f = window.DaimondRatings ? DaimondRatings.fileOf(r.h) : null;
		if (!f || !f.path) return;
		store = store || f.store; v = v || f.v;
		names.push(f.path); have.add(r.h);
		var c = cnt[r.h];
		byPath[f.path] = { path: f.path, hash: r.hash || '', gone: !r.hash, h: r.h,
			add: c && typeof c.add === 'number' ? c.add : null, del: c && typeof c.del === 'number' ? c.del : null };
	});
	return names.length ? _filesBox(store, names.length, v, names, 0, byPath, have, true) : null;
}

/// Open a changed file from a turn tile, landing on the file whatever its kind.
///
/// The live file is tried first: a store file (`diamonds/…`) and a workspace file
/// under a mounted folder both open editable. A `code/…` workspace path with no
/// folder mounted resolves into OPFS, where it is not, and the live read throws --
/// so on failure the version-store SNAPSHOT this tile is already about is shown
/// read-only. The click therefore always lands on the file, never on nothing.
async function openTurnFile(id, name, hash) {
	try { await Files.open(name, { line: 0 }); return true; }
	catch (liveErr) {
		if (!hash) {
			try { console.warn('Daimond: could not open "' + name + '": '
				+ ((liveErr && liveErr.message) ? liveErr.message : liveErr)); }
			catch (e0) { /* no console */ }
			return false;
		}
		// The live file is not here (a `code/…` path with no folder mounted lands in
		// OPFS, where it is not), so show the version-store SNAPSHOT this tile is about.
		// PROBE the store body first: a BINARY changed file (a PNG, a PDF) is shown
		// through the viewer door by path, never decoded as lossy UTF-8 (S-HAND #4); an
		// editable one takes today's read-only text path.
		var bodyPath = '';
		try { bodyPath = DaimondVersions.bodyPath(id, hash); } catch (e) { bodyPath = ''; }
		var info = null;
		if (bodyPath && window.DaimondViewer && DaimondViewer.probe) {
			try { info = await DaimondViewer.probe(bodyPath, { store: true }); } catch (e) { info = null; }
		}
		if (info && DaimondViewer.editable && !DaimondViewer.editable(info)) {
			try { await Files.view(bodyPath, info, { store: true, label: name }); return true; }
			catch (e2) { /* fall through to the text snapshot / notice */ }
		}
		// Editable, or no probe: the snapshot as read-only text (the pre-#4 path).
		var snap = null;
		try { snap = await DaimondVersions.body(id, hash); }
		catch (e) { snap = null; }
		if (snap != null) {
			try { await Files.open(name, { content: snap, readOnly: true }); return true; }
			catch (e3) { /* fall through to the notice */ }
		}
		try { console.warn('Daimond: could not open "' + name + '": '
			+ ((liveErr && liveErr.message) ? liveErr.message : liveErr)); }
		catch (e4) { /* no console */ }
		return false;
	}
}

/// One file row: the name opens the file in the Doc panel; the delta shows the
/// count and, for an UPDATE, folds the version store's diff in under the row
/// (History's own .hist-diff classes). A NEW file has no before, so its delta
/// opens the file rather than a two-column diff with an empty side.
///
/// `still` is a row drawn from its record alone (a chat's Files row): `e` is `{ path, hash, gone, h }`
/// built from the record (with its `add` and `del`, counted when the record was made), the handle is
/// the record's own, and the delta draws its `+N −M` from it without asking the version store, so the
/// row reads the same where the store is not held (J6). A file that is gone has a minus. A press asks
/// the store, as a Diamond row's does, and finds the diff only where it is held.
function _turnFileRow(id, name, e, v, have, still) {
	var row = document.createElement('div');
	row.className = 'turn-file-row';
	// A press that cannot act answers in the box it is in (the answer rule), never silently.
	function say(text) {
		var box = row.closest ? row.closest('.turn-files') : null;
		if (box && window.DaimondAnswer && DaimondAnswer.note) DaimondAnswer.note(box, text, true);
	}
	// The row's handle is built in, not mounted, so the rows read the same before and after a
	// rating. Only a row the note holds a record for has one (`mountFileRates` dresses those).
	if (have && have.size && window.DaimondProvenance) {
		var fh = still && e && e.h ? e.h : DaimondProvenance.h.file(id, v, name);
		if (have.has(fh)) row.dataset.h = fh;
	}
	var nm = document.createElement('button');
	nm.type = 'button';
	nm.className = 'turn-file-name';
	// The directory and the file's own name in two spans, so a long path gives way in its
	// directory and the part that tells one row from the next stays. `textContent` is the path.
	// A file in this Diamond is shown from its root, so the app's own id is not on screen; the title has the full path.
	var shown = window.DaimondProvenance ? DaimondProvenance.rel(name, id) : name;
	var cut = shown.lastIndexOf('/') + 1;
	if (cut > 0 && cut < shown.length) {
		var nd = document.createElement('span'); nd.className = 'turn-file-dir'; nd.textContent = shown.slice(0, cut);
		var nb = document.createElement('span'); nb.className = 'turn-file-base'; nb.textContent = shown.slice(cut);
		nm.appendChild(nd); nm.appendChild(nb);
	} else nm.textContent = shown;
	nm.title = name;
	nm.addEventListener('click', function (ev) {
		ev.stopPropagation();
		// The opener is `openTurnFile`: it tries the live file (a store path, or a
		// workspace path under a mounted folder) and, when that read fails (a
		// `code/…` path with no folder mounted lands in OPFS, where it is not),
		// falls back to the version-store snapshot this tile is about, read-only.
		// The earlier fix called `Files.open` directly, which threw NotFound for
		// exactly those workspace files and left the click doing nothing. A
		// deletion opens what the file WAS; every other change what it became.
		Promise.resolve(openTurnFile(id, name, e && e.gone ? (e.was || '') : (e && e.hash ? e.hash : '')))
			.then(function (landed) { if (landed === false) say(t('chat.turn_file_nofile')); });
	});
	row.appendChild(nm);
	var de = document.createElement('button');
	de.type = 'button';
	de.className = 'turn-file-delta';
	// was→hash for this file, straight from the manifest: a NEW file has no
	// `was` (all-add), a deleted one has `gone` (all-del), an update has both.
	var was = e && !e.gone && e.was ? e.was : '';
	var now = e && !e.gone ? (e.hash || '') : '';
	de.textContent = '·';
	row.appendChild(de);
	var was = e && !e.gone && e.was ? e.was : '';
	var now = e && !e.gone ? (e.hash || '') : '';
	function paintDelta(d) {
		// #22 live-fix: green additions, red deletions — two spans, one count.
		if (!d) { de.textContent = '·'; return; }
		de.replaceChildren();
		var a = document.createElement('span'); a.className = 'tf-add'; a.textContent = '+' + (d.add || 0);
		var s = document.createElement('span'); s.className = 'tf-del'; s.textContent = '−' + (d.del || 0);
		de.appendChild(a); de.appendChild(s);
	}
	function paintDiff(d) {
		// #22 live-fix: a SIDE-BY-SIDE diff with foldable unchanged runs, not a
		// flat one-line-per-change listing. Left = before (was), right = after
		// (hash); runs of context longer than the fold gap collapse to a bar.
		var wrap = document.createElement('div');
		wrap.className = 'tf-sbs';
		var rows = (d && d.rows) || [];
		// Pair '-' lines with the '+' lines that follow into one side-by-side row.
		var pairs = [], li = 0;
		while (li < rows.length) {
			var r = rows[li];
			if (r.op === '-') {
				var before = r.text, after = null, nj = li + 1;
					while (nj < rows.length && rows[nj].op === '-') { before += '\n' + rows[nj].text; nj++; }
					if (nj < rows.length && rows[nj].op === '+') {
						after = rows[nj].text; var pj = nj + 1;
						while (pj < rows.length && rows[pj].op === '+') { after += '\n' + rows[pj].text; pj++; }
						nj = pj;
					}
				pairs.push({ op: '!', before: before, after: after }); li = nj; continue;
			}
			if (r.op === '+') { pairs.push({ op: '+', before: null, after: r.text }); li++; continue; }
			pairs.push({ op: ' ', before: r.text, after: r.text }); li++;
		}
		var GAP = 3, built = 0, hunk = [];
		pairs.forEach(function (p) {
			if (p.op === ' ') { hunk.push(p); return; }
			built += hunk.length + 1; hunk.forEach(drawPair); hunk = [];
			drawPair(p);
		});
		built += hunk.length; hunk.forEach(drawPair);
		if (built > GAP * 2) wrap.classList.add('tf-sbs-folded');
		function drawPair(p) {
			var line = document.createElement('div');
			line.className = 'tf-sbs-row' + (p.op === '!' ? ' chg' : p.op === '+' ? ' add' : '');
			var L = document.createElement('div'); L.className = 'tf-sbs-cell tf-sbs-l' + (p.op === '!' || p.op === ' ' ? '' : ' empty');
			var R = document.createElement('div'); R.className = 'tf-sbs-cell tf-sbs-r' + (p.op === '+' ? ' add' : '');
			// #22 root-fix: a pure addition (`op '+'`) has its OWN branch. It used
			// to fall into the deletion branch below (the `p.op === '+'` guard),
			// which puts the empty `before` on the LEFT and BLANKS the right cell --
			// so the added text was thrown away and an all-add diff (a new file, or
			// `+N −0`) rendered as a block of empty rows. The added line belongs on
			// the right (add) side; the left stays empty.
			if (p.op === '+') { L.textContent = ''; R.textContent = p.after || ''; R.classList.add('add'); }
			else if (p.after === null) { L.textContent = p.before || ''; L.classList.add('del'); R.textContent = ''; }
			else if (p.op === '!') { L.textContent = p.before || ''; L.classList.add('del'); R.textContent = p.after || ''; R.classList.add('add'); }
			else { L.textContent = p.before || ''; R.textContent = p.after || ''; }
			line.appendChild(L); line.appendChild(R); wrap.appendChild(line);
		}
		return wrap;
	}
	if (still && e && e.gone) {
		// A file that has gone: a minus, and nothing to press (as a Diamond's row reads it).
		de.classList.add('turn-file-delta-none');
		de.textContent = '−';
	} else if (still) {
		// FROM THE RECORD ALONE (J6): the count was made when the row was, so it draws the same where
		// the store is not held. A press does what a Diamond row's does, asking the store only now.
		if (e && typeof e.add === 'number') paintDelta({ add: e.add, del: e.del });
		de.addEventListener('click', async function (ev) {
			ev.stopPropagation();
			var open = row.querySelector('.tf-sbs');
			if (open) { open.remove(); return; }   // a second press folds it away
			// The version before this one is not in the record; the store has it, if it is here.
			var ent = null;
			try {
				var ms = await DaimondVersions.manifests(id);
				var mv = (ms || []).find(function (m) { return m && m.version === v; });
				ent = ((mv && mv.files) || []).find(function (x) { return x && x.path === name; }) || null;
			} catch (err) { ent = null; }
			if (!ent || !ent.hash) { de.textContent = '·'; say(t('chat.turn_file_nocount')); return; }   // not held: no honest count
			if (!ent.was) { openTurnFile(id, name, ent.hash); return; }
			try {
				var d = await DaimondVersions.diff(id, ent.was, ent.hash);
				if (!d) { de.textContent = '·'; return; }
				paintDelta(d);
				row.appendChild(paintDiff(d));
			} catch (err) { /* the store was pruned or the body was not kept: the delta stays as it was */ }
		});
	} else if (was || now) {
		// #22 vision pass: a NEW file (no `was`) never got its all-add count — the
		// auto-paint gate demanded both hashes. The empty `was` is legal to diff
		// (an empty before is an all-add after), so gate on either hash existing.
		de.addEventListener('click', async function (ev) {
			ev.stopPropagation();
			// A NEW file has no "before": a two-column side-by-side with an empty
			// left column rendered as a broken mess (the filename crushed into a
			// narrow column beside a wall of added lines). There is nothing to diff,
			// so open the file itself — exactly what the name does.
			if (now && !was) { openTurnFile(id, name, now); return; }
			var shown = row.querySelector('.tf-sbs');
			if (shown) { shown.remove(); return; }   // a second press folds it away
			try {
				var d = await DaimondVersions.diff(id, was, now);
				if (!d) { de.textContent = '·'; return; }   // binary or not kept: no honest count
				paintDelta(d);
				var sbs = paintDiff(d);
				if (sbs) row.appendChild(sbs);
			} catch (err) { /* the store was pruned or the body was not kept: the delta stays · */ }
		});
		if (now && !was) {
			// A new file: all-add, no press needed. (`was` empty is legal: the Rust
			// side reads an empty before, so the whole after body is additions.)
			DaimondVersions.diff(id, '', now).then(paintDelta).catch(function () { });
		} else if (was && now) {
			// The count is shown without a press on the common path (an update
			// with both bodies kept) — a press then folds the diff in/out.
			DaimondVersions.diff(id, was, now).then(paintDelta).catch(function () { });
		}
	} else {
		de.classList.add('turn-file-delta-none');
		de.textContent = e && e.gone ? '−' : '·';
		// No manifest row here: the version store has not got this version on this device, so
		// there is no count to show and no diff to fold. The press says so.
		if (!e) {
			if (window.DaimondAnswer && DaimondAnswer.gate) DaimondAnswer.gate(de, t('chat.turn_file_nocount'));
			de.addEventListener('click', function (ev) { ev.stopPropagation(); say(t('chat.turn_file_nocount')); });
		}
	}
	return row;
}

/// A chat's Files row: the tile a turn that changed files leaves under its answer, drawn from the
/// records of its `files_log` alone. It is display only (never in the model's context) and it
/// wears the Diamond tail note's own Files tile, rows and rating controls.
export function appendFilesLog(m) {
	var recs = (window.DaimondProvenance && window.DaimondRatings)
		? DaimondProvenance.of(m).filter(function (p) { return p.k === 'file' && DaimondRatings.isFile(p.h); }) : [];
	var box = recs.length ? _filesLogBox(recs, m.delta) : null;
	if (!box) return null;
	var names = [].map.call(box.querySelectorAll('.turn-file-name'), function (n) { return n.title; });
	var tile = buildTile('tool', { who: tOr('chat.who_files', 'Files'), expanded: true, result: true, copy: names.join('\n'), ts: m.ts });
	tile._body.appendChild(box);
	tilePeek(tile, box.querySelector('.turn-files-head').textContent);
	postToChat(tile);
	mountFileRates(box);
	pinBottom();
	return tile;
}

/// "Changed your file <name>" (UNBLOCK-26, his ruling 26 Oct: "Change it, show it, Undo"). A
/// runner turn changes a file of his without asking, having kept it first, so the turn shows
/// each such change as his ask would have, and the runner turn's own Undo under them. Which
/// files were his is the runner's word (`yours`, from its `his` rows), never guessed here.
function appendYoursTile(m) {
	var ys = (m && Array.isArray(m.yours)) ? m.yours : [];
	if (!ys.length) return null;
	var box = document.createElement('div');
	box.className = 'turn-yours';
	var names = [];
	var first = null;	// the file the peek names
	ys.forEach(function (y) {
		if (!y || !y.path) return;
		var at = changeName(y.path);
		if (!first) first = y;
		names.push(at.name);
		var head = document.createElement('div');
		head.className = 'turn-yours-head';
		head.textContent = t(y.unsure ? 'change.file' : 'change.yours', { name: at.name });
		box.appendChild(head);
		var where = document.createElement('div');
		where.className = 'rail-note pend-change-in';
		where.textContent = t('change.in', { folder: at.folder });
		box.appendChild(where);
		// A change the runner's record had no room for is still counted.
		var n = ((y.add | 0) + (y.del | 0));
		changeDiff(box, (y.change && typeof y.change === 'object') ? y.change : { text: true, rows: [], more: n });
	});
	if (!names.length) return null;
	if (m.away && m.away.run) box.appendChild(histAwayUndo(String(m.away.keeper || ''), { away: m.away, cause: 'turn' }, _turnUndoRows));
	var tile = buildTile('tool', { who: tOr('chat.who_files', 'Files'), expanded: true, result: true, copy: names.join('\n'), ts: m.ts });
	tile._body.appendChild(box);
	tilePeek(tile, t(first.unsure ? 'change.file' : 'change.yours', { name: names[0] }));
	postToChat(tile);
	pinBottom();
	return tile;
}

export function appendUserMessage(text, ts, prod, files, app) {
	// #22 live-fix: the tail note is the daimon's WORK, not the user's words — it
	// renders as a tool-style tile (the same furniture #17's fold tiles use),
	// never as a "You" bubble.
	if (/^\[Daimond: this turn changed /.test(text)) {
		// #22: the changed-files summary is the app noticing files changed, not a
		// model tool call — so it wears a "Files" header, not the generic "Tool".
		var d2 = buildTile('tool', { who: tOr('chat.who_files', 'Files'), expanded: true, result: true, copy: text, ts: ts });
		// The list is the turn's RESULT, not a step (the Steps switch leaves it), drawn from the
		// note's own names at once and enriched with the counts.
		_fillFilesTile(d2, text, pg.current, prod, files);
		tilePeek(d2, text);
		postToChat(d2);
		pinBottom();
		return d2;
	}
	// THE NEXT MESSAGE ANSWERS AN OPEN QUESTION (owner ruling D-20261009-20). Here, the one
	// door a person's message is drawn through, live and on a reload alike, so the two cannot
	// disagree about whether a card was answered. Nothing is stored to say so: the message
	// itself is the record. A message the app sent (`app`: a trigger, a preset) is not one.
	pg._turnMarks[pg._turn + 1] = { ask: pg._askCard, askJust: pg._askJust, said: _saidJust, handoff: pg._handoffTurn };
	askMarkAnswered(text, app);
	var div = buildTile('user', { expanded: true, copy: text, ts: ts });
	div.classList.add('chat-msg-user');           // kept for older hooks
	_tailNoteTable(text, pg.current, prod).then(function (tbl) {
		if (!tbl) return;
		var content = div.querySelector('.chat-msg-content');
		if (content) { content.replaceChildren(tbl); mountFileRates(tbl); }
		var _h = div.querySelector('.chat-msg-head');
		if (_h) _h.classList.add('is-turn-files');
	}).catch(function () { /* never reached: _tailNoteTable does not throw */ });
	var content = document.createElement('div');
	content.className = 'chat-msg-content';
	content.textContent = text;                    // escaped
	div._body.appendChild(content);
	// The question's own words are a fold switch too, the way they always were —
	// click the question to hide its answers. Its TEXT is still selectable, so a
	// click that ends a selection is one that was selecting, not one that meant to
	// fold; and while choosing, a click ticks the turn rather than folding it.
	content.addEventListener('click', function (e) {
		if (chatOutput.classList.contains('selecting')) { toggleSelLeaf(div); return; }
		var sel = window.getSelection();
		if (sel && String(sel).length) return;
		setTurnOpen(div, !isTurnOpen(div));
	});
	pg._turn += 1;
	tagTurn(div);
	tilePeek(div, text);
	postToChat(div);
	pinBottom();
	// A new question is a new place to jump back to, so the walk starts again from the bottom.
	pg._jumpAt = -1;
	return div;
}

/// Draw a message that was said INTO a running turn, at the point it landed.
///
/// Where it is drawn is the whole point of it. A correction shown at the end,
/// under the work it was meant to redirect, reads as one that was ignored;
/// drawn here -- between the step that had just finished and the one that
/// followed it -- it reads as what it was. So the assistant's text so far is
/// closed off first, the same way a tool step closes it, and whatever the model
/// says next begins a fresh bubble below this one.
///
/// It carries the CURRENT turn's number and is deliberately not
/// `.chat-msg-user`: it belongs to the turn it cut into rather than starting one
/// of its own, so folding that turn away takes it too, and the numbering a fold
/// maps through is untouched.
///
/// The bubble is styled here rather than in the stylesheet only because this
/// change did not own `app.css`; the rule belongs beside `.chat-msg-user`.
export function appendInterjected(text) {
	finalizeAssistant();
	var div = document.createElement('div');
	div.className = 'chat-msg chat-msg-interjected';
	div.style.textAlign = 'right';
	// The same small right-aligned caption the waiting bubbles wear, saying the
	// opposite thing: this one has arrived.
	var note = document.createElement('div');
	note.className = 'chat-queued-head';
	note.textContent = '↳ ' + t('chat.interjected');
	note.title = t('chat.interjected_help');
	var body = document.createElement('div');
	body.className = 'chat-msg-content';
	body.textContent = text;                     // escaped (H5)
	body.title = t('chat.interjected_help');
	body.style.display = 'inline-block';
	body.style.background = 'var(--accent-soft)';
	body.style.color = 'var(--accent-text)';
	body.style.borderRadius = 'var(--radius-lg)';
	body.style.borderLeft = '3px solid var(--accent)';
	body.style.padding = '8px 14px';
	body.style.maxWidth = '82%';
	body.style.textAlign = 'left';
	div.appendChild(note);
	div.appendChild(body);
	tagTurn(div);
	postToChat(div);
	if (nearBottom()) setScrollTop(chatOutput.scrollHeight);
}
// page-split: install 83

/// A device hand-off, drawn as its own tile at the point the turn left this
/// device. `dir:'local'` gives it the centred dual indent a Tool tile has —
/// like a tool, it is the app's own act rather than either speaker's words. It
/// is minimal by design: one line naming the device that took the turn, no
/// body, sitting quietly in the flow above the answer that came back. It
/// replaces the "ran on <device>" meta the answer header used to carry, so the
/// provenance is said once and in one place.
/// A run duration in the terse form the hand-off body uses: sub-minute in
/// seconds to one decimal under ten, whole seconds above; a minute or more as
/// `Nm Ns`. Empty for a missing or zero figure, so a body drops it rather than
/// claiming a run took no time.
function fmtRunDur(ms) {
	var n = ms | 0;
	if (n <= 0) return '';
	if (n < 60000) {
		var s = n / 1000;
		return (s < 10 ? s.toFixed(1).replace(/\.0$/, '') : String(Math.round(s))) + 's';
	}
	var m = Math.floor(n / 60000), r = Math.round((n % 60000) / 1000);
	return r ? (m + 'm ' + r + 's') : (m + 'm');
}

/// The body of a hand-off tile: a concise, honest account of what happened when a
/// turn did not run on this device. `kind` is 'peer' (it ran on another device and
/// the answer synced back) or 'ranhere' (a hand-off that fell back to run here);
/// `name` is the other device. `meta` is the answer message, which for a
/// dispatched turn carries the runner's own figures (`ranMs`, `ranModel`,
/// `ranTokIn`/`ranTokOut`, `ranCost`, `ranCached`, `ranCtx` — stamped in `runTurn`). Only figures that
/// are actually present are drawn, so the body says what is known and no more; a
/// message from before those were stamped shows just the provenance line.
function handoffBody(kind, name, meta) {
	var wrap = document.createElement('div');
	wrap.className = 'ct-handoff';
	var lead = document.createElement('div');
	lead.className = 'ct-handoff-lead';
	lead.textContent = kind === 'ranhere'
		? (meta && meta.handoffBusy
			? tOr('chat.handoff_ran_here_busy', 'Ran on this device because {name} was busy with another chat.', { name: String(meta.handoffBusy) })
			: meta && meta.handoffThread
			? tOr('chat.handoff_ran_here_thread', 'Ran on this device because {name} didn’t have the whole conversation.', { name: String(meta.handoffThread) })
			: name
			? tOr('chat.handoff_ran_here', 'Ran on this device after the hand-off to {name} didn’t finish.', { name: String(name) })
			: tOr('chat.handoff_ran_here_plain', 'Ran on this device.'))
		: tOr('chat.handoff_ran_on', 'Ran on {name}; the answer synced back to this device.', { name: String(name || '') });
	wrap.appendChild(lead);
	// The runner's own figures, each shown only if the message carries it.
	var facts = [];
	var d = meta ? fmtRunDur(meta.ranMs) : '';
	if (d) facts.push(d);
	if (meta && meta.ranModel) facts.push(String(meta.ranModel));
	var toks = meta ? ((meta.ranTokIn | 0) + (meta.ranTokOut | 0)) : 0;
	if (toks > 0) facts.push(tOr('chat.handoff_tokens', '{n} tok', { n: fmtCtx(toks) }));
	if (meta && (meta.ranCached | 0) > 0) facts.push(tOr('chat.handoff_cached', '{n} cached', { n: fmtCtx(meta.ranCached | 0) }));
	// The cost is a price tag after the rest; its glyph is the separator.
	var cost = meta && (meta.ranCost || 0) > 0 ? meta.ranCost : null;
	var peek = facts.concat(cost !== null ? [DaimondI18n.priceText(cost)] : []).join(' · ');
	// How full the runner's context was, as the chat meter draws it: the meter's own bar
	// and title, against this chat's window.
	var bar = meta && (meta.ranCtx | 0) > 0 && pg.current
		? tileCtxBar({ lastPrompt: meta.ranCtx | 0 }, chatWindow(pg.current)) : null;
	if (facts.length || cost !== null || bar) {
		var row = document.createElement('div');
		row.className = 'ct-handoff-facts';
		row.textContent = facts.join(' · ');
		if (cost !== null) {
			if (facts.length) row.appendChild(document.createTextNode(' '));
			row.appendChild(DaimondI18n.priceTag(cost));
		}
		if (bar) {
			if (facts.length || cost !== null) row.appendChild(document.createTextNode(' '));
			row.appendChild(bar);
		}
		wrap.appendChild(row);
	}
	return { node: wrap, peek: peek };
}

function appendHandoff(ranOn, meta) {
	var dl = deviceLabelFor(ranOn);
	if (!dl) return;
	// Past tense: the turn is over. "{name} is on it" read as a progress line left behind (UNBLOCK-56).
	var line = tOr('chat.ran_on', 'Ran on {name}', { name: dl });
	var tile = buildTile('handoff', { expanded: false, who: line, ts: meta && meta.ts });
	tile.classList.add('chat-msg-handoff');
	var body = handoffBody('peer', dl, meta);
	tile._body.appendChild(body.node);
	if (body.peek) tilePeek(tile, body.peek);
	tagTurn(tile);
	postTurnLead(tile);
}

/// A hand-off that FELL BACK to this device: the turn was dispatched to
/// `toLabel`, that device never finished, and the turn ran HERE. Drawn so
/// provenance is never silent — the failure it fixes was a hand-off tile that
/// vanished when the fallback ran locally, leaving no way to tell where a turn
/// ran (owner report 2026-09-06). `toLabel` is the target's display name,
/// captured off the dispatch placeholder as it was dropped (see
/// `dropDispatchedPlaceholder`); absent, it degrades to a plain "ran here".
export function appendRanHere(toLabel, meta, refusedWhy) {
	// The relay REFUSED the hand-off (S-HAND #6): it never reached a peer, so the turn
	// ran here. Named distinctly from a peer that took it and failed, because the cause
	// is the relay, not the runner. The reason rides the tooltip.
	// THE SEAT WAS BUSY (Q19): the runner handed it back because it was running another
	// chat, which is a different cause from a runner that took it and did not finish.
	var busyName = meta && meta.handoffBusy ? String(meta.handoffBusy) : '';
	// THE SEAT COULD NOT REBUILD THE CONVERSATION AS SENT (D2): it handed the turn back
	// before claiming it, so the cause is the thread, not a runner that failed.
	var threadName = meta && meta.handoffThread ? String(meta.handoffThread) : '';
	var line = refusedWhy
		? tOr('chat.ran_here_refused', 'Ran here — the relay refused the hand-off')
		: busyName
		? tOr('chat.ran_here_busy', 'Ran here — {name} was busy with another chat', { name: busyName })
		: threadName
		? tOr('chat.ran_here_thread', 'Ran here — {name} didn’t have the whole conversation', { name: threadName })
		: toLabel
		? tOr('chat.ran_here_failed', 'Ran here — hand-off to {name} didn’t finish', { name: String(toLabel) })
		: tOr('chat.ran_here', 'Ran on this device');
	var tile = buildTile('handoff', { expanded: false, who: line, ts: meta && meta.ts });
	tile.classList.add('chat-msg-handoff');
	if (refusedWhy) try { tile.title = String(refusedWhy); } catch (e) { /* no title support */ }
	// Refused, the hand-off never reached `toLabel`, so the body does not say it "didn't finish" there.
	var body = handoffBody('ranhere', refusedWhy ? null : toLabel, meta);
	tile._body.appendChild(body.node);
	if (body.peek) tilePeek(tile, body.peek);
	tagTurn(tile);
	postTurnLead(tile);
}

/// Put a round's working on the record, growing the entry rather than adding one.
///
/// The same coalescing as the drawing, and for the same reason: a reload reads these
/// back and would otherwise redraw four hundred tiles where the live turn showed one.
/// A `think_log` is only ever grown while it is the LAST message, and every other
/// kind of event pushes something after it, so being last is what says the round is
/// still reasoning.
export function logThinking(conv, text, turnId) {
	if (!text) return;
	var msgs = conv.messages;
	var last = msgs.length ? msgs[msgs.length - 1] : null;
	if (last && last.role === 'think_log' && String(last.iturn || '') === String(turnId || '')) {
		last.content = (last.content || '') + text; touchMsg(last); return;
	}
	var row = { role: 'think_log', content: text, mid: newMid(), ts: Date.now() };
	if (turnId) row.iturn = String(turnId);		// its turn's, as every row a turn writes (check_fix5 H1)
	msgs.push(row);
}

/// The model's own working, in a tile that OPENS while the round runs and shuts once
/// there is an answer.
///
/// Reasoning is not the answer, so it must never sit where the reply goes -- but the
/// user pays for these tokens and they decide what the model then does, so drawing
/// none of them was the app holding back something already bought.
///
/// It was shut from the moment it was drawn until 2026-08-28, on three reasons, and
/// two of them still hold: the working is long, and it is not addressed to the
/// reader. The third -- that an answer buried under its own working is worse than
/// one without it -- is about a FINISHED turn, and it is what makes the tile shut
/// itself the instant anything else is drawn. But for the minute BEFORE that, on a
/// reasoning model, there is no answer to bury and the alternative is a blank
/// spinner. So the tile is open for exactly as long as it is the only thing there is
/// to see.
///
/// A `<details>` and not a bespoke widget: the browser gives the disclosure, the
/// keyboard behaviour and the open state for nothing, and `.md-fold` already styles
/// exactly this shape for the two-depth answer. `textContent` and never the markdown
/// renderer -- this is the model talking to itself, and running it through a parser
/// would turn a stray backtick or angle bracket into layout.
///
/// # Arguments
/// * `live` - True while the round that is producing this is still running, which is
///   what earns the tile its open state and lets the next delta grow it. A reload
///   passes nothing: those rounds are over, and a thread that opened every one of
///   them would be a wall of working with the answers lost in it.
/// * `ts` - The tile's own local time (see `tileTimeEl`), read only on the delta that
///   creates the tile -- a live caller's own `Date.now()`, or the stored `think_log`'s
///   `ts` on reload. Later deltas grow the same tile and never call `buildTile` again.
/// * `mid` - The stored `think_log`'s id, so a provisional row that grows with each
///   hand-off frame is found and grown in place (`growProvisionalTiles`).
export function appendThinking(text, live, ts, mid) {
	var body = String(text == null ? '' : text);
	if (!body) return;                       // most endpoints return none; draw nothing
	// GROW THE TILE THAT IS OPEN. A delta is a fragment of one thought, not a
	// thought; appending to a node already in the document is what makes hundreds
	// of them cost nothing.
	if (live && pg.liveThink && pg.liveThink.parentNode) {
		// PINNED IS READ BEFORE THE APPEND, as `drawAsst` reads it: afterwards the
		// thread is taller than it was and `nearBottom` answers about the new height,
		// so a reader who WAS at the bottom is judged not to be and the working
		// scrolls away under them.
		var pinned = nearBottom();
		pg.liveThink._body.textContent += body;
		tilePeek(pg.liveThink, pg.liveThink._body.textContent);
		if (pinned) setScrollTop(chatOutput.scrollHeight);
		return;
	}
	if (!body.trim()) return;                // whitespace does not start a thought
	finalizeAssistant();
	// A think tile — muted, from the model, collapsed by default; opened while
	// live for the reason the note above records. The body is `textContent` and
	// deliberately not parsed: this is the model talking to itself, and a stray
	// backtick run through markdown would become layout.
	var d = buildTile('think', { expanded: !!live, meta: respModel(), ts: ts });
	d.classList.add('chat-msg-thinking');
	var pre = document.createElement('div');
	pre.className = 'chat-thinking-body';
	pre.textContent = body;                  // escaped, and deliberately not parsed
	d._body.appendChild(pre);
	d._pre = pre;
	// `liveThink._body` is where a delta grows, so point it at the text node.
	d._body = pre;
	if (mid) d.dataset.mid = String(mid);
	tilePeek(d, body);
	if (live) pg.liveThink = d;
	var wasDown = nearBottom();
	tagTurn(d); postToChat(d);
	if (wasDown) setScrollTop(chatOutput.scrollHeight);
}

/// Draw a tool call that arrived as PROSE, as the code it is.
///
/// NOT an assistant tile and not markdown. On 2026-09-14 this fragment reached the reader
/// as `namedaimonfoldtimeout_ms600000worldtrue` — a run of prose in the model's own voice,
/// drawn as its answer — because the sanitiser's unknown-wrapper rule keeps an unknown
/// tag's text and drops its markup, and the app had no idea anything was wrong. So the
/// fragment goes through `DaimondRender.leakBlock`, which escapes it into a `<pre>` under
/// a one-line note, and the tile opens rather than hiding behind a control: this is the
/// thing the turn produced instead of an answer, and it is not tucked away.
export function appendLeak(fragment, ts) {
	var body = String(fragment == null ? '' : fragment);
	if (!body.trim()) return;
	finalizeAssistant();
	var d = buildTile('leak', { expanded: true, ts: ts });
	d.classList.add('chat-msg-leak');
	d._body.innerHTML = window.DaimondRender
		? DaimondRender.leakBlock(body)
		: ('<pre class="leak-frag"><code>' + body.replace(/&/g, '&amp;').replace(/</g, '&lt;')
			+ '</code></pre>');
	var wasDown = nearBottom();
	tagTurn(d); postToChat(d);
	// Through `setScrollTop`, like every other write in this file. Written on a lane
	// that branched before the anchor existed, a raw write here is read back by the
	// scroll listener as the READER having moved -- so a leaked tool call stamped
	// `_lastScrollAt` and left `_wasAtEnd` stale, and the resize anchor stopped
	// holding the live end for the rest of the turn.
	if (wasDown) setScrollTop(chatOutput.scrollHeight);
}

/// Say that the conversation was folded, and DRAW THE LINE IT WAS FOLDED AT.
///
/// The line is the whole of the change made on 2026-08-28, and the defect behind it is the
/// most serious one a tester reported: "all of a conversation is not being fed back into
/// context in long chats". Nothing was dropping messages -- a twenty-turn chat reaches the
/// model whole, and so does one reloaded from the store, both measured against the provider's
/// own log. What happens is that the conversation FOLDS, exactly as designed, and the app said
/// so in one sentence at the bottom of the thread.
///
/// One sentence at the bottom is not enough, because THE TRANSCRIPT ABOVE IT DOES NOT CHANGE.
/// The screen keeps every message at full fidelity; only the model's own copy is replaced by a
/// summary. So a reader scrolls up, sees their first answer sitting there in full, asks the
/// model about it, is told it does not have it, and concludes the app is losing their
/// conversation. Every step of that reading is reasonable and the app supplied all of it.
///
/// So the notice becomes a BOUNDARY. It is drawn across the thread, it says which side of it
/// the model still has, and the messages above it are marked -- once, here, at the single door
/// every path comes through, so a reload draws the same line in the same place.
///
/// # Arguments
/// * `note` - The engine's own sentence, counts and all.
/// * `folded` - How many messages of the model's conversation were replaced; absent for the
///   sighted-model notice, which shares this drawing and is NOT a fold.
/// * `kept` - How many the model still holds verbatim, the summary included.  Its absence is
///   also what tells a compaction notice from the sighted-model one, which shares this
///   drawing and passes neither count.
export function appendCompacted(note, folded, kept, ts) {
	finalizeAssistant();
	// A FOLD IS THE ONE THAT REPLACED SOMETHING, and only a fold draws the line.
	//
	// `kept` used to be enough to make one, and `kept` is the size of the model's whole
	// conversation, so it is never zero: a compaction that only SHORTENED the older answers
	// on their way out drew a boundary saying the model had a summary in their place, which
	// it did not, and marked every message above it. Since 2026-08-28 the shortening is done
	// to the request and never to the record (`Agent::fold_if_needed`, src/agent.rs), so
	// there is nothing above such a notice that the model does not still hold. It gets a
	// heading of its own and no line.
	var isFold  = (folded | 0) > 0;
	var isShort = !isFold && kept !== undefined && kept !== null;
	var div = document.createElement('div');
	div.className = 'chat-msg chat-msg-compacted' + (isFold ? ' chat-fold-line' : '');
	var head = document.createElement('div');
	head.className = 'chat-queued-head';
	var headLabel = document.createElement('span');
	headLabel.textContent = '\u229f ' + (isShort
		? tOr('chat.shortened', 'Answers shortened for the model')
		: t('chat.compacted'));
	head.appendChild(headLabel);
	head.title = isShort
		? tOr('chat.shortened_help', 'Daimond sent the older answers shortened so the '
			+ 'conversation fits the model\u2019s context window. Every word of them stays '
			+ 'on your screen and in your record.')
		: t('chat.compacted_help');
	// The fold's own time, right of the label -- a fold notice is a tile like any
	// other, and `ts` is the same field `buildTile` reads (see `tileTimeEl`). Its
	// own modifier class rather than a change to `.chat-queued-head` itself: that
	// class also draws the queue box's headings, which carry no timestamp and must
	// not gain the flex layout this needs.
	var timeEl = tileTimeEl(ts);
	if (timeEl) { head.classList.add('chat-queued-head-time'); head.appendChild(timeEl); }
	var body = document.createElement('div');
	body.className = 'chat-msg-content';
	body.textContent = note;                     // escaped (H5)
	div.appendChild(head); div.appendChild(body);
	if (isFold) {
		// WHAT IS ABOVE THE LINE, said in the second person and in messages rather than in
		// tokens. The engine's own sentence counts tokens because a budget is what it folded
		// to; a reader is looking at messages on a screen.
		var says = document.createElement('div');
		says.className = 'chat-fold-boundary';
		says.textContent = tOr('chat.fold_boundary',
			'The model no longer has what is above this line as it was written \u2014 it has the '
			+ 'summary in this note instead, plus the {kept} most recent messages. Everything '
			+ 'above stays on your screen, so you can still read it and quote from it.',
			{ kept: Math.max(0, (kept | 0) - 1) });
		div.appendChild(says);
		markAboveFold();
	}
	tagTurn(div); postToChat(div);
	if (nearBottom()) setScrollTop(chatOutput.scrollHeight);
}

/// Is this compaction notice worth another line in the thread?
///
/// A FOLD ALWAYS IS. It replaced messages, it happened once, and the line it draws is where.
///
/// A compaction that only SHORTENED the older answers on their way to the model is not an
/// event but a state. Since the shortening moved off the record and onto the request it is
/// redone from the whole conversation on every turn from here on, so the engine says so on
/// every turn — and twenty identical grey notices down a thread is exactly the noise a quiet
/// disclosure must not become. It is said once, and said again after the next real fold,
/// which is the point at which the answer has changed.
///
/// Read from the transcript rather than from a flag, so it survives a reload and holds for a
/// daimon's thread as well as a chat's — neither keeps an agent across turns, and both keep
/// their messages.
///
/// # Arguments
/// * `rec` - The chat or Diamond record whose thread this would go in.
/// * `ev` - The `compacted` event, whose `folded` says which kind it is.
export function worthSaying(rec, ev) {
	if (((ev && ev.folded) | 0) > 0) return true;
	var ms = (rec && rec.messages) || [];
	for (var i = ms.length - 1; i >= 0; i--) {
		if (!ms[i] || ms[i].role !== 'fold_log') continue;
		// The last thing said was a fold, so the state is news again.
		return (ms[i].folded | 0) > 0;
	}
	return true;
}

/// Mark every message already in the thread as one the model has only in summary.
///
/// Idempotent, and re-run by each fold, so a second fold marks what the first left behind
/// without having to know where the first one was. The mark is a rule down the side and NOT a
/// change of ink: the words above the line are still the reader's to read, and dimming them
/// would be the app hiding a conversation it has already been accused of losing.
function markAboveFold() {
	if (!chatOutput) return;
	var kids = chatOutput.children;
	for (var i = 0; i < kids.length; i++) {
		var n = kids[i];
		if (!n.classList) continue;
		// FURNITURE IS NOT CONVERSATION. The queue box and the turn indicator are children
		// of this element and are moved to the bottom by `postToChat` on every later
		// message, so marking them would leave a rule beside the two things that are
		// permanently BELOW the line.
		if (n.id === 'chat-queued' || n === spinnerEl) continue;
		// Marked by an earlier fold: written again, it would be a page mutation per tile on
		// every redraw that draws a fold (the lens's observer sees each, UNBLOCK-47).
		if (!n.classList.contains('chat-above-fold')) n.classList.add('chat-above-fold');
	}
}

// ── How the turn ended ─────────────────────────────────────
//
// `AgentEvent::Ended` closes every turn, and `dev/CONTRACT_CLAIMS.md` §3 is
// the whole of how it is drawn. It exists because a model announced work --
// "let me rewrite from line 43 through 49" -- and ended its turn having
// written nothing. The spinner stopped, correctly, because the turn HAD
// ended, and the owner was left saying "I have no visibility on what occurred
// here".
//
// So it is FURNITURE: one quiet line closing the turn, in the register of a
// timestamp, wearing neither the error nor the alert styling and using no
// word that claims a fault. Two rules follow and neither is optional.
//
//   1. A turn that did what it was asked reads as furniture. An app that
//      appends a warning to every turn teaches its reader to skip the one
//      that mattered, which is the failure this exists to prevent. Only
//      `refused`, `failed` or `missing` promotes it to a notice.
//   2. `offered === 0` draws NOTHING AT ALL. A pure chat has no tool log, so
//      its ending carries no news, and a line under every message in a
//      conversation with no tools in it is noise with nothing behind it.

/// What an ending says, or `null` where it says nothing.
///
/// Answers `{ line, paths, notice, title }`. Nothing here reads the model's
/// words: every figure is the engine's own tally, which is the rule the whole
/// mechanism is built on.
// ENDINGS THAT CUT A TURN SHORT. Each says so whatever the turn drew, because the words
// that arrived are exactly what makes it look finished. A step limit and a spend limit are
// stops the person did not make, just as a lease cap is (r541 QA B, F2). A blocked turn
// (`failed` with why `blocked`, G T3) cuts it short too, and endHalted says so.
var END_HALTS = { stopped: 1, paused: 1, capped: 1, spend_cap: 1 };

/// Did this ending cut the turn short?
function endHalted(e) {
	return !!e && (END_HALTS[String(e.how || '')] === 1
		|| (e.how === 'failed' && e.why === 'blocked'));
}

/// May the person carry this stopped turn on? Only where nothing they did stopped it: a
/// lease that ran out, or the step limit. A spend limit is theirs to raise first.
export function endContinuable(e) {
	return !!e && (e.how === 'capped' || (e.how === 'stopped' && String(e.why || '') === 'lease_cap'));
}

export function endingParts(e) {
	if (!e) return null;
	// A TURN THE USER STOPPED IS NEWS WHATEVER WAS ON THE TABLE. Rule 2 is about a
	// tally nobody needs; being stopped is not a tally, and a pure chat with no tools
	// in it is exactly where a stopped answer looked finished (UX run B05). Every
	// other ending still obeys the rule, first, so no caller can forget it. A turn a
	// pause caught part way (`brakeHeld`) is the same news in the person's own word.
	if (!endHalted(e) && !((e.offered | 0) > 0)) return null;
	var calls = e.calls | 0, refused = e.refused | 0, failed = e.failed | 0;
	var missing = Array.isArray(e.missing) ? e.missing : [];
	// The wire word, or the word itself where a later engine has learnt a
	// sixth: an ending nobody recognises is still better said than swallowed.
	// A blocked turn travels as `failed`, and says what it is: not done, not an error.
	var bits = [e.how === 'failed' && e.why === 'blocked'
		? t('end.why_blocked')
		: tOr('end.how_' + (e.how || ''), String(e.how || ''))];
	// THE CASE THIS WAS BUILT FOR: tools on the table and no call made. Said
	// as a fact, not as a fault -- what the model PROMISED is the reader's
	// business, and whether it did anything is the app's.
	bits.push(calls ? tn('end.calls', calls, { n: calls })
		: tOr('end.no_calls', 'no tools used'));
	if (refused) bits.push(tn('end.refused', refused, { n: refused }));
	if (failed)  bits.push(tn('end.broke', failed, { n: failed }));
	return {
		line:   bits.join(' · '),
		// The paths THEMSELVES. It is a short list or it is empty, and a turn
		// that produces a long one has a real fault whose names the reader wants.
		paths:  missing.length
			? tOr('end.missing', 'not written: {paths}', { paths: missing.join(', ') })
			: '',
		// A LEAKED TOOL CALL IS A NOTICE. The turn ran rounds and called nothing,
		// which is exactly the silence `unaccounted` exists to break.
		notice: !!(refused || failed || missing.length || (e.malformed | 0) || (e.reasoned | 0)),
		// `offered` and `rounds` are here rather than on the line, so the line
		// stays quiet and no figure is lost.
		title:  tOr('end.help',
			'How this turn ended. Tools available: {offered}. Requests sent: {rounds}. '
			+ 'Tool calls made: {calls}.',
			{ offered: e.offered | 0, rounds: e.rounds | 0, calls: calls }),
	};
}

/// Does this node show the turn's outcome, rather than its question or its reasoning?
///
/// A GROUP IS JUDGED BY WHAT IS IN IT. Since D-20261007-04 every Thinking tile, a lone
/// one included, sits inside a `.crollup` whose own `data-t` is `work` -- the class it
/// rolls up under, not what it holds -- so testing the wrapper made a group of thinking
/// alone count as shown, and a turn that only reasoned, went silent or failed lost its
/// ending line (r541 QA B, F1). A group shows something only when a tile in it does.
///
/// AN ALLOW-LIST, NOT A DENY-LIST (r542 QA B, F-B1). Anything that was not the question or
/// Thinking used to count, so the "picture was left out" note and the fold note -- both
/// `chat-msg-compacted`, both tagged to the turn -- swallowed the line of a turn that then
/// reasoned and went silent. Only an answer, a tool, a hand-off or an error is an outcome;
/// a note, a fold, the question, Thinking, a leaked fragment or a rating never is.
var OUTCOME_TILE = { reply: true, tool: true, handoff: true };
function tileShows(k) {
	if (!k || !k.classList) return false;
	if (k.classList.contains('crollup')) {
		var mem = k.querySelectorAll('.ctile');
		for (var j = 0; j < mem.length; j++) if (tileShows(mem[j])) return true;
		return false;
	}
	if (k.classList.contains('chat-msg-error')) return true;
	return OUTCOME_TILE[k.dataset.t] === true;
}

/// Close the turn on screen, but ONLY where the turn drew nothing else.
///
/// THE END-OF-TURN SUMMARY IS GONE (owner review 2026-09-05, asked
/// repeatedly). The furniture line "Answered · N tool calls" went on
/// 2026-09-04; the trailing NOTICE — "1 failed", "1 refused", "Ended on an
/// error" — is the remnant, and it went here. A refused or failed tool already
/// shows its state ON ITS OWN TOOL TILE (`.ctile[data-t="tool"].failed` /
/// `.refused`, named "· failed" / "· refused" on the label), and the absence
/// of the spinner is what says the turn is over — so a line under the whole
/// turn restating the tally is noise, not news.
///
/// The ONE case still worth a word is a HARD ERROR WITH NOTHING TO SHOW: a
/// turn that produced no tile at all — no thinking, no tool, no answer — where
/// the failure would otherwise be invisible. So a single minimal notice
/// survives, and only then: it is gated on the turn having drawn nothing, not
/// on what the tally says.
export function appendEnding(e, isLast, ch) {
	var p = endingParts(e);
	if (!p) return;
	// What this turn actually drew, its own question aside. A tool tile or an
	// answer counts as "something was shown"; the You tile is discounted because
	// it is the question and not the outcome -- and, since proposal 15
	// (2026-09-15), so is a THINKING tile on its own: a round that reasoned for
	// 3,372 tokens and said nothing left a thinking tile on screen, `shown` read
	// true, and the line below that would have said "Ended without an answer"
	// never drew. A thinking tile is furniture for an answer that follows it,
	// not evidence one arrived.
	var kids = chatOutput.querySelectorAll('[data-turn="' + String(pg._turn) + '"]');
	var shown = false;
	for (var i = 0; i < kids.length && !shown; i++) shown = tileShows(kids[i]);
	// A STOPPED TURN SAYS SO EVEN THOUGH IT DREW SOMETHING, and that is the one
	// ending for which `shown` is not the test. The words that arrived are exactly
	// what makes it look finished: the partial reads as an answer, and only the
	// missing tail says otherwise (UX run B05, annoyance 1). Everything else here
	// is unchanged -- a line under a turn that drew its own outcome is the noise
	// this function exists to withhold.
	// A BLOCKED TURN draws its line too, drawn or not: it stopped on something it could
	// not get past (a refusal left standing, a failure repeated, a page put back), and the
	// text above it reads like an answer unless something says the work is not done.
	var blocked = e.how === 'failed' && e.why === 'blocked';
	var stopped = endHalted(e);
	var bad = stopped || p.notice || e.how === 'failed' || e.how === 'silent'
		|| e.how === 'reasoned_only';
	if ((shown && !stopped) || !bad) return;
	finalizeAssistant();
	var div = document.createElement('div');
	// A STOP IS NOT FURNITURE (r541 QA B, F3). The owner did not see "Stopped" in the
	// timestamp register (2026-10-06, 21:48), so a turn cut short reads as transcript text.
	div.className = 'chat-msg chat-msg-ended ended-notice' + (stopped ? ' ended-stop' : '');
	div.title = p.title;
	var line = document.createElement('div');
	line.className = 'end-line';
	// Minimal: the ending word alone (e.g. "Ended on an error"), not the tool
	// tally — there were no tools to tally, which is the whole reason we are here.
	var word = tOr('end.how_' + (e.how || ''), String(e.how || '')) || p.line;
	// A STOP SAYS WHY (D-20261006-30 (a)). The reason is the engine's own, stamped where
	// the abort was raised; a stop the person made keeps plain "Stopped", and a record
	// from before `why` existed has none and reads as it always did. `data-why` is the
	// locale-neutral mark the gate reads.
	var why = e.how === 'stopped' || blocked ? String(e.why || '') : '';
	div.dataset.how = String(e.how || '');
	if (why) {
		div.dataset.why = why;
		if (why !== 'user') word = tOr('end.why_' + why, word);
	}
	// The reason itself, where nothing above says it: the engine's own sentence is drawn
	// as the turn's text, so it is repeated here only when the turn drew nothing.
	if (blocked && !shown && e.said) word = String(e.said);
	// A CUT'S ACCOUNT (UNBLOCK-25 U4): why it stopped and what it had done, as its line.
	else if (e.how === 'stopped' && e.said) word = String(e.said);
	line.textContent = word;
	div.appendChild(line);
	// CONTINUE, ONLY WHERE IT IS THE THING TO DO: a turn that ran out its lease is
	// unfinished through no act of the person's, and the stop is the newest thing in
	// the thread. A stop higher up has been overtaken, and a second device pressing it
	// would run the turn twice.
	var cont = null;
	if (isLast && endContinuable(e)) {
		cont = document.createElement('button');
		cont.className = 'ti-continue';
		cont.textContent = t('turn.continue');
		cont.title = t('turn.continue_help');
		cont.addEventListener('click', function () { continueStopped(ch || pg.current, cont); });
		div.classList.add('has-continue');
		div.appendChild(cont);
	}
	tagTurn(div); postToChat(div);
	_contBtn = cont;
	if (nearBottom()) setScrollTop(chatOutput.scrollHeight);
}

/// The stored form of an ending, or `null` where there is nothing to store.
///
/// Written into the conversation the way `think_log` and `fold_log` are, so a
/// reload still shows how a turn ended. A turn that draws nothing stores
/// nothing: a record kept for a line no build will ever draw is a message per
/// turn in every pure chat, which is the noise rule 2 exists to prevent.
export function endLogOf(ev, why) {
	if (!ev) return null;
	// Stored on the same rule `endingParts` draws on: a stopped turn is kept whatever
	// was offered, so the line is still there after a reload.
	var blocked = String(ev.how || '') === 'failed' && ev.why === 'blocked';
	if (!endHalted(ev) && !((ev.offered | 0) > 0)) return null;
	var rec = {
		role:    'end_log',
		how:     String(ev.how || ''),
		offered: ev.offered | 0,
		rounds:  ev.rounds  | 0,
		calls:   ev.calls   | 0,
		refused: ev.refused | 0,
		failed:  ev.failed  | 0,
		// Rounds thrown away to a tool call that arrived as text; see the `leaked`
		// arm. Stored, so a reload still says the turn ended on a wire fault.
		malformed: ev.malformed | 0,
		// Rounds thrown away to a reply that reasoned and answered nothing; see
		// `TurnEnd::ReasonedOnly` (src/agent.rs). Stored for the same reason
		// `malformed` is, above.
		reasoned: ev.reasoned | 0,
		missing: Array.isArray(ev.missing) ? ev.missing.slice(0) : [],
		mid:     newMid(),
		ts:      Date.now(),
	};
	// WHY A STOP STOPPED, stored with the record so every device draws the same words.
	// `user` is a Stop the person pressed; a reason nobody named is `stream_abort`
	// (the caller's fallback), so no stop is left unexplained.
	if (rec.how === 'stopped' && why) rec.why = String(why);
	// A blocked turn keeps its mark and its sentence, so a reload draws the same stop.
	if (blocked) {
		rec.why  = 'blocked';
		rec.said = String(ev.said || '');
	}
	return rec;
}

/// The cut a stop reason names, or '' for a stop nobody named (UNBLOCK-25 U4). A cut is
/// a turn ended from outside its own reply: a Stop, a lease cap, lapse, take-back or
/// start deadline. An engine poisoned by a trap is not one, and keeps its own path.
export function cutReason(why) {
	var w = String(why || '');
	return (w === 'lease_cap' || w === 'lease_lapsed' || w === 'lease_revoked'
		|| w === 'lease_deadline' || w === 'user') ? w : '';
}

/// The plain account a cut turn ends with (UNBLOCK-25 U4): why it stopped, then what it
/// had done -- its tool calls and the paths a write that succeeded touched. Written by
/// the page, so a turn cut mid-reply still ends with words.
export function cutAccount(why, rows) {
	var calls = 0, paths = [];
	(rows || []).forEach(function (m) {
		if (!m || m.role !== 'tool_log') return;
		calls++;
		var nm = String(m.name || ''), oc = String(m.outcome || '');
		if (nm !== 'file_write' && nm !== 'file_edit' && nm !== 'dir_create') return;
		if (!oc || oc === 'failed' || oc === 'refused') return;
		var a = null;
		try { a = JSON.parse(String(m.args || '')); } catch (e) { a = null; }
		var p = a && typeof a === 'object' ? String(a.path || a.file_path || '') : '';
		if (p && paths.indexOf(p) < 0) paths.push(p);
	});
	var w = cutReason(why) || 'user';
	var s = tOr('cut.why_' + w, 'Stopped.');
	if (!calls) return s + ' ' + tOr('cut.none', 'It had not called any tools yet.');
	s += ' ' + tn('cut.calls', calls, { n: calls });
	if (paths.length) {
		var shown = paths.slice(0, 5).join(', ');
		s += ' ' + (paths.length > 5
			? tOr('cut.wrote_more', 'It wrote {paths} and {more} more.', { paths: shown, more: paths.length - 5 })
			: tOr('cut.wrote', 'It wrote {paths}.', { paths: shown }));
	}
	return s;
}

/// Fit an end record into a transcript so it sorts AFTER everything already there.
///
/// A transcript is merged by `(ts, mid)`. The record was stamped when the engine's
/// `ended` event arrived and pushed after the answer or partial, which took a later
/// stamp -- so on every merged device the line sorted above the tile it closes (owner,
/// 21:48, 2026-10-07). Restamped at push time, past the newest stamp in the thread.
export function stampAfter(msgs, rec) {
	var top = 0;
	for (var i = 0; i < (msgs || []).length; i++) top = Math.max(top, +(msgs[i] && msgs[i].ts) || 0);
	rec.ts = Math.max(Date.now(), top + 1);
	return rec;
}

/// Take the Continue button off the stop line that offered it.
export function retireContinue() {
	var b = _contBtn;
	_contBtn = null;
	if (!b) return;
	try {
		var line = b.parentNode;
		b.remove();
		if (line && line.classList) line.classList.remove('has-continue');
	} catch (e) { /* the line is gone already */ }
}
// page-split: install 84

/// Put something into the thread, taking the placeholder away first.
///
/// `.empty-state` is `height:100%`, so anything appended while one is still
/// on screen lands BELOW a full-height box: the thread opens scrolled past
/// its own first message, with a screen of nothing above it. Every render
/// path goes through here, so a path added later cannot forget.
///
/// It is also where a stop line's Continue is withdrawn: a tile that lands after the
/// line makes it no longer the newest thing in the thread.
export function postToChat(node) {
	if (_contBtn) { retireContinue(); }
	// A tile reached the thread from somewhere OTHER than a history render -- the
	// live turn, a streamed answer. The append fast path in `renderHistory` may only
	// draw a tail onto a thread whose tiles it put there itself, so a draw through
	// this door outside a render means the next render must rebuild rather than
	// append. `_renderedChatId` is deliberately left alone: the scroll-keeping in
	// `renderHistory` still needs to know the same chat is on screen.
	if (!_renderingHistory) pg._renderSynced = false;
	var ph = chatOutput.querySelector('.empty-state');
	if (ph) ph.remove();
	// A ROUND'S WORKING IS ONE TILE, and it ends where the round does. Anything else
	// reaching the thread -- the first token of the answer, a tool call, an ending --
	// says the reasoning is over, so the tile stops taking deltas and folds itself
	// away. Unless the reader opened it, in which case it is theirs and it stays.
	if (pg.liveThink && node !== pg.liveThink) {
		if (!pg.liveThink._held && !curGen()) pg.liveThink.classList.add('collapsed');
		pg.liveThink = null;
	}
	// A tile pinned to the foot goes home once it no longer awaits the reader; one that
	// awaits is pinned, and whatever comes after it is drawn above it.
	reconcileAwaiting();
	if (node._awaits && node._awaits()) {
		pinAwaiting(node);
		placeFurniture();
		return;
	}
	// ROLL UP A RUN OF TILES OF ONE CLASS. A rollable tile joins the box standing last
	// in the thread when that box is of its class; anything else lying between closes
	// the run, as it must.
	// A RESULT IS NOT A STEP (UNBLOCK-56): the Files list a turn leaves (`ctile-result`) stands on
	// its own however it is ordered. A runner's Files row sorts beside its answer by (ts, mid),
	// and one stamped at the answer's time drew straight after the steps, rolled into them, unseen.
	var cls = node.classList && node.classList.contains('ctile') && !node.classList.contains('ctile-result')
		&& TILE_ROLL[node.dataset.t];
	if (cls) {
		var prev = lastContent();
		if (prev && prev.classList.contains('crollup') && prev._type === cls && prev.id !== 'wire-head') {
			node.classList.remove('csel-unit');
			node.dataset.dir = '';               // the container carries the indent
			prev._body.appendChild(node);
			rollUpdate(prev);
			liveWork();
			placeFurniture();
			return;
		}
		var box = makeRollup(cls, node);
		node.classList.remove('csel-unit');
		node.dataset.dir = '';
		box._body.appendChild(node);
		rollUpdate(box);
		node = box;
	}
	// What is waiting to be sent stays at the bottom, under what has happened -- and
	// under the tiles that await the reader, which stand last of all.
	var q = firstAwaiting() || document.getElementById('chat-queued');
	if (q) chatOutput.insertBefore(node, q);
	else chatOutput.appendChild(node);
	liveWork();
	placeFurniture();
}

/// Post a tile so it LEADS its turn — inserted ahead of the turn's thinking/tool/
/// answer tiles, right after the question that started it. The hand-off announcement
/// belongs at the top of the turn (the hand-off happened before any work), but it is
/// drawn when the answer arrives (`appendAssistantText`), by which point the turn's
/// thinking and tool tiles are already on the thread. So rather than append at the
/// end, find the first tile of THIS turn that is not the question and insert before
/// it. Falls back to a plain append when the turn has no other tile yet.
function postTurnLead(node) {
	if (!_renderingHistory) pg._renderSynced = false;
	var ph = chatOutput.querySelector('.empty-state'); if (ph) ph.remove();
	// A non-rollable tile reaching the thread closes any open thinking tile,
	// exactly as `postToChat` does.
	if (pg.liveThink && node !== pg.liveThink) {
		if (!pg.liveThink._held && !curGen()) pg.liveThink.classList.add('collapsed');
		pg.liveThink = null;
	}
	reconcileAwaiting();
	var turn = node.dataset ? node.dataset.turn : null;
	var before = null;
	if (turn != null) {
		var kids = chatOutput.children;
		for (var i = 0; i < kids.length; i++) {
			var k = kids[i];
			if (!k.dataset || k.dataset.turn !== turn) continue;
			if (k.classList && k.classList.contains('chat-msg-user')) continue;	// the question leads; the hand-off follows it
			if (k === spinnerEl || k.id === 'chat-queued' || k._slot) continue;
			before = k; break;
		}
	}
	if (before) chatOutput.insertBefore(node, before);
	else {
		var q = firstAwaiting() || document.getElementById('chat-queued');
		if (q) chatOutput.insertBefore(node, q); else chatOutput.appendChild(node);
	}
	placeFurniture();
}

/// Is `node` the last piece of conversation in the thread — ignoring the queue
/// box and the turn indicator, which are always kept beneath it?
export function isLastContent(node) {
	var n = node.nextSibling;
	while (n) {
		if (n.nodeType === 1 && n !== spinnerEl && n.id !== 'chat-queued' && !n._slot) return false;
		n = n.nextSibling;
	}
	return true;
}

/// Keep the queue box and the turn indicator beneath everything said so far, and the
/// indicator above an open Decision, which is the turn's state while it waits.
///
/// Sinking the indicator above each new tool tile would leave the thread saying
/// "running file_read" halfway up itself while the real work went on below.
function placeFurniture() {
	var q = document.getElementById('chat-queued');
	if (spinnerEl && spinnerEl.parentNode === chatOutput) {
		var at = firstDecision() || q;
		if (at) chatOutput.insertBefore(spinnerEl, at);
		else chatOutput.appendChild(spinnerEl);
	}
}

// True when the thread is scrolled to (near) the bottom, so streaming
// auto-scroll can be suppressed while the user reads earlier output.
export function nearBottom() {
	// Reading `scrollHeight`/`scrollTop`/`clientHeight` forces a layout flush, so a
	// per-tile `if (nearBottom()) setScrollTop(...)` in the draw path is one more reflow
	// per tile -- and evaluating the `chatOutput.scrollHeight` argument would flush again
	// even if the write no-oped. So during a rebuild answer FALSE without touching layout:
	// the caller short-circuits (no read, no write) and the single end-pin in
	// `renderHistory` decides the final position with one reflow.
	if (_renderingHistory) return false;
	return chatOutput.scrollHeight - chatOutput.scrollTop - chatOutput.clientHeight < 48;
}

// ── A fold the model wrote, drawn while it is still being written ──
//
// The tool this replaces did not stream at all: an unchanging spinner for the
// whole of a generation, one to three minutes on a hard question, and then
// the answer all at once.  Folding in the text itself is only worth having
// because it streams, so the streaming is the part to be careful with.
//
// The whole accumulated message is re-parsed every frame -- that is what
// makes streaming markdown work at all -- and a `<details>` rebuilt every
// frame is a `<details>` that snaps shut sixty times a second, taking the
// reader's place in it with it.  So the CONTROL is made once and kept, and
// only its body is redrawn.  A message with no fold in it never reaches any
// of this and takes the same single `innerHTML` it always did.
//
// Each entry is `{ id, node, body, text }`.  `id` is what lets a frame tell
// "the same fold, longer" from "a different fold in that place".
var _asstSegs = [];

function newTextSeg() {
	var d = document.createElement('div');
	d.className = 'md-seg';
	return { id: '', node: d, body: d, text: null };
}

/// Is there nothing on screen above this fold?
///
/// Judged on what was RENDERED, not on the source. An empty heading or a
/// stray blank list item is markdown that produces no visible text, and to a
/// reader that is the same as nothing at all.
function nothingAbove(upTo) {
	for (var i = 0; i < upTo && i < _asstSegs.length; i++) {
		var n = _asstSegs[i].node;
		if (n && String(n.textContent || '').trim()) return false;
	}
	return true;
}

/// The control, made ONCE per fold per stream.
function newFoldSeg(seg, headless) {
	var d = document.createElement('details');
	d.className = 'md-fold';
	d.dataset.foldKey = seg.key;
	var sum = document.createElement('summary');
	// The label as HTML rather than as markdown: `marked` hands a `<details>`
	// block through raw, so this is the same label a reader saw before folds
	// were drawn a piece at a time.
	sum.innerHTML = DaimondRender.sanitize(seg.label);
	var body = document.createElement('div');
	body.className = 'md-fold-body';
	d.appendChild(sum);
	d.appendChild(body);
	// A FOLD WITH NOTHING ABOVE IT IS NOT A FOLD, it is the whole answer behind
	// a control the reader has to press to find out there was nothing else.
	// `say` could refuse that -- src/tools.rs calls an empty summary "the one
	// failure worth refusing" -- but markup cannot be refused, so it is drawn
	// OPEN instead. Not unwrapped: unwrapping throws the model's own label
	// away, and it leaves the screen showing a body the open set calls closed.
	//
	// Decided ONCE, where the control is made, and it cannot thrash: the text
	// above a fold is final the moment that fold's opening marker completes,
	// because the message only ever grows at its end.
	if (headless) d.classList.add('md-fold-bare');
	// A fold the model itself marked `open`, or one drawn open for the reason
	// above, is on screen from the first frame -- so it belongs in the open set
	// too, and the next redraw keeps it open.
	if ((seg.open || headless) && !(seg.key in _openFolds)) _openFolds[seg.key] = 1;
	d.open = !!_openFolds[seg.key];
	d.addEventListener('toggle', function () { foldToggled(d); });
	return { id: '', node: d, body: body, text: null };
}

/// Carry a fold-inside-a-fold's open state across the frame that rebuilds it.
///
/// A nested fold takes no key of its own (dev/CONTRACT_FOLD.md §8): it belongs
/// to the OUTER body. So there is nothing to restore one from, and it is
/// remembered by its label for the length of a single redraw instead --
/// enough that a reader who opens one while the answer is still arriving does
/// not have it shut in their face on the next frame.
function foldLabels(root, openOnly) {
	var out = Object.create(null);
	var got = root.querySelectorAll('details.md-fold');
	for (var i = 0; i < got.length; i++) {
		if (openOnly && !got[i].open) continue;
		var sm = got[i].querySelector('summary');
		out[sm ? String(sm.textContent || '').replace(/\s+/g, ' ').trim() : ''] = got[i];
	}
	return out;
}

function reopenNested(root, was) {
	var got = foldLabels(root, false);
	Object.keys(was).forEach(function (k) { if (got[k]) got[k].open = true; });
}

/// A reader opened or closed a fold, so the next redraw and a reload keep it so.
///
/// The first `toggle` a fold fires is the initial state settling rather than
/// a gesture, and it is told apart here by the set already agreeing with the
/// element -- which also keeps a reloaded thread of open folds from writing
/// the store back once per fold.
function foldToggled(el) {
	var k = el.dataset ? el.dataset.foldKey : '';
	if (!k) return;
	if (!!el.open === !!_openFolds[k]) return;
	if (el.open) _openFolds[k] = 1; else delete _openFolds[k];
	saveTextFolds();
}

/// Draw the accumulated assistant text into its bubble.  See `_asstSegs`.
///
/// `settled` says the turn is over, which is the difference between "this fold
/// has not been finished yet" and "this fold never was".
function drawAsst(settled) {
	var host = pg.curAsstDiv && pg.curAsstDiv.querySelector('.chat-msg-content');
	if (!host) return;
	var segs = null;
	// A scan that throws must not cost the reader their answer: the whole
	// message still renders, it simply renders unfolded.
	try { segs = DaimondRender.foldSegments(pg.curAsstText, settled); }
	catch (e) { segs = null; }
	if (!segs) {
		_asstSegs = [];
		host.innerHTML = DaimondRender.md(pg.curAsstText);	// sanitised (H5)
		return;
	}
	var folded = false;
	for (var f = 0; f < segs.length; f++) { if (segs[f].kind === 'fold') { folded = true; break; } }
	if (!folded) {
		_asstSegs = [];
		// The SEGMENTS, not the raw text. A `<details>` half written at the end
		// of the buffer is held back until it is a fold (`foldPending`), and
		// rendering the whole of `curAsstText` here would put the browser's own
		// half-formed disclosure on screen anyway -- which is the flicker the
		// hold-back exists to prevent.
		var flat = '';
		for (var k = 0; k < segs.length; k++) flat += segs[k].text;
		host.innerHTML = DaimondRender.md(flat);	// sanitised (H5)
		return;
	}
	if (!_asstSegs.length) host.innerHTML = '';
	for (var i = 0; i < segs.length; i++) {
		var s = segs[i];
		var id = s.kind === 'fold' ? 'f' + s.key : 't';
		var cur = _asstSegs[i];
		if (!cur || cur.id !== id) {
			// A segment that changed kind -- or a fold whose label changed
			// while the summary was still being typed -- is a different thing
			// on screen.  Everything after it is stale with it, so the tail is
			// dropped rather than patched.
			dropSegsFrom(i);
			cur = s.kind === 'fold' ? newFoldSeg(s, nothingAbove(i)) : newTextSeg();
			cur.id = id;
			host.appendChild(cur.node);
			_asstSegs[i] = cur;
		}
		var src = s.kind === 'fold' ? s.body : s.text;
		// Only when the text under it moved.  A frame in which the fold grew
		// must not rebuild the answer above it, or every code block's copy
		// button in it is remade sixty times a second.
		if (cur.text !== src) {
			cur.text = src;
			var was = foldLabels(cur.body, true);
			cur.body.innerHTML = DaimondRender.md(src);	// sanitised (H5)
			reopenNested(cur.body, was);
		}
	}
	dropSegsFrom(segs.length);
}

function dropSegsFrom(i) {
	for (var j = _asstSegs.length - 1; j >= i; j--) {
		var n = _asstSegs[j] && _asstSegs[j].node;
		if (n && n.parentNode) n.parentNode.removeChild(n);
	}
	if (_asstSegs.length > i) _asstSegs.length = i;
}

var _asstRenderPending = false;
function renderAsst() {
	_asstRenderPending = false;
	if (!pg.curAsstDiv) return;
	var pinned = nearBottom();
	drawAsst();
	if (pinned) setScrollTop(chatOutput.scrollHeight);
}
/// What an answer that ran on this device says of a hand-off before it: `{ to, why }`,
/// or null for a plain local turn. `why` is the relay's refusal (S-HAND #6), which
/// outranks the target: a refused hand-off never reached `to`, so it did not "not
/// finish" there (UNBLOCK-1 DISPATCH-FAIL). A `to` naming this device is dropped, since
/// a turn run where it was sent fell back nowhere -- this also mends a record stamped
/// so before the fix, on the runner and on the phone alike.
function ranHereProvenance(fellBack, meta) {
	var why = meta && meta.handoffRefused ? String(meta.handoffRefused) : '';
	var to  = fellBack ? String(fellBack) : '';
	if (to && to === runnerLabel(String(selfDeviceId() || ''))) to = '';
	return (to || why) ? { to: to, why: why } : null;
}

export function appendAssistantText(text, ranOn, handoffFellBack, meta) {
	if (!pg.curAsstDiv) {
		// WHICH DEVICE RAN THE TURN, when it was not this one: a turn dispatched to
		// the always-on runner (or grabbed by another device) carries `ranOn` on the
		// stored assistant message. It used to ride as a "ran on <device>" meta on
		// the answer header; the owner asked for it as a proper tile instead, so a
		// hand-off is drawn in the flow above the answer (see `appendHandoff`), once
		// per turn. A plain local turn (`ranOn` equal to self, and never handed off)
		// is quiet. But a turn that WAS handed off and then FELL BACK to run here is
		// not quiet: `handoffFellBack` names the device it was sent to, so provenance
		// is drawn ("Ran here — hand-off to X didn't finish") rather than the tile
		// vanishing and leaving the owner unable to tell where it ran.
		if (pg._handoffTurn !== pg._turn) {
			var rh = null;			// the ran-here provenance
			if (ranOn && String(ranOn) !== selfDeviceId()) {
				appendHandoff(ranOn, meta);
				pg._handoffTurn = pg._turn;
			} else if ((rh = ranHereProvenance(handoffFellBack, meta))) {
				appendRanHere(rh.to || null, meta, rh.why);
				pg._handoffTurn = pg._turn;
			}
		}
		// The model's prose — the ANSWER — in a Daimond tile: accent-coloured,
		// from the model (left indent), expanded. `drawAsst` streams into the
		// `.chat-msg-content` inside its body exactly as it did into the bubble.
		//
		// ITS TIME IS SET ONCE, HERE, ON THE FIRST DELTA. `meta` is the STORED
		// message on a reload (drawHistoryMessage passes `m`) and is absent while
		// the answer is still streaming in -- there is no stored record yet to read
		// a `ts` off, and the honest time for a tile appearing right now is now.
		var replyTs = (meta && meta.ts) || Date.now();
		pg.curAsstDiv = buildTile('reply', { expanded: true, meta: respModel(), ts: replyTs });
		pg.curAsstDiv.classList.add('chat-msg-assistant');
		// The message's own id on the tile, so a PROVISIONAL streamed answer can be
		// grown in place by mid (`growProvisionalTiles`) rather than rebuilt as it
		// arrives, and so the tile is the one the parcel's real answer converges onto.
		if (meta && meta.mid) pg.curAsstDiv.dataset.mid = String(meta.mid);
		pg.curAsstDiv._copyText = function () { return pg.curAsstText; };
		var content = document.createElement('div');
		content.className = 'chat-msg-content';
		pg.curAsstDiv._body.appendChild(content);
		tagTurn(pg.curAsstDiv);
		postToChat(pg.curAsstDiv);
		pg.curAsstText = '';
		_asstSegs = [];
	}
	pg.curAsstText += text;
	// Throttle to one markdown re-render per frame: re-parsing the whole
	// message per token is O(n^2) and rebuilds code blocks/copy buttons.
	if (!_asstRenderPending) {
		_asstRenderPending = true;
		(window.requestAnimationFrame || function (f) { setTimeout(f, 16); })(renderAsst);
	}
}

/// Close the open run of prose as WORKING rather than as an answer.
///
/// **Text that is followed by a tool call is not the answer**, and until 2026-08-23 it was
/// drawn as one. A turn that made twenty calls put twenty paragraphs of "let me pin the line
/// numbers", "all pinned down", "now the ledger" into the thread at full weight, and the
/// owner read the lot looking for the reply. He asked where the folding was. `FOLD_NOTE`
/// governs the ANSWER and exempts anything a sentence or two long, so every one of those
/// lines was exempt by the rule -- correctly, and uselessly.
///
/// Decided at the moment a tool call arrives, which is when the question is answerable: a
/// run of prose with a call after it was the model thinking out loud on its way somewhere.
/// The run after the LAST call is untouched, and that is the answer.
///
/// Drawn as the thinking tile is drawn, because it is the same thing arriving by a different
/// door -- the model's own working, addressed to nobody. One sentence gets a quiet line and
/// no disclosure, since a control that opens on the words already on screen is the
/// "opens on nothing" fault; more than one gets the first sentence as its summary.
///
/// **AND IT NO LONGER HIDES WITH THE TOOL STEPS.** It did, from the decision above until
/// 2026-08-28, on the reasoning that `.hide-tools` is the switch a reader already uses to say
/// they do not want the working. The owner reversed that, and the reversal is written here
/// rather than only in the diff because the paragraph above states the opposite and would
/// otherwise go on stating it.
///
/// What the rule did was hide the MODEL'S OWN PROSE. A demoted run is still the model
/// speaking; the tile it goes into measured zero by zero with the switch on, so a turn of
/// twenty tool calls drew one final answer and nothing else, and the sentences the reader had
/// watched arrive were gone with no sign that anything had been there. That is note 05 of the
/// 2026-08-27 round arriving by its other door, and the likelier cause of it -- the collapsed
/// control the merged fix made legible is only reachable when the switch is off.
///
/// The switch is called Steps and it hides the steps. The working is collapsed here rather
/// than hidden, which is why the count below still earns its place: the prose is behind a
/// control either way, and a control has to say there is something to open.
function demoteToWorking() {
	var text = (pg.curAsstText || '').trim();
	if (!pg.curAsstDiv || !text) { finalizeAssistant(); return; }
	var div = pg.curAsstDiv;
	// Cleared BEFORE the rebuild, so nothing that runs below can append into a div that is
	// about to be replaced.
	pg.curAsstDiv = null; pg.curAsstText = ''; _asstRenderPending = false; _asstSegs = [];
	// The first sentence, which is what a model's narration opens with and is already a
	// summary of the rest. Cut on the sentence end, never mid-word.
	//
	// AND IT USED TO CUT MID-WORD, in the one branch the sentence above does not describe:
	// with no sentence end inside 160 characters it took `slice(0, 160)` and stopped
	// wherever that landed. A model that opens with a long clause -- which is most of them,
	// since this is narration -- got a summary ending in half a word, and the reader who
	// had just watched that text arrive was given a mangled version of it as the label for
	// where it went. See note 05 of 2026-08-27.
	var cut = text.search(/[.!?](\s|$)/);
	var head;
	if (cut > 0 && cut < 160) {
		head = text.slice(0, cut + 1);
	} else {
		head = text.slice(0, 160);
		// Back to the last space, unless there is none to go back to -- a 160-character
		// run with no break in it is one word, and half of it is better than none.
		var sp = head.lastIndexOf(' ');
		if (sp > 40) head = head.slice(0, sp);
	}
	// The reply tile becomes a WORKING tile: same muted register as Thinking,
	// because it is the same thing — the model narrating on its way to a tool —
	// arriving by a different door. Collapsed, with the first sentence as the
	// peek, so the run is behind a control that says there is something to open.
	div.classList.remove('chat-msg-assistant');
	div.classList.add('chat-msg-working');
	// No longer the answer, so no longer carrying its mid: two tiles must not answer to one.
	delete div.dataset.mid;
	div.dataset.t = 'think';
	div.dataset.dir = 'from';
	div._copyText = null;
	if (div._who) div._who.textContent = tileWho('think');
	div.classList.add('collapsed');
	div._body.innerHTML = '';
	var pre = document.createElement('div');
	pre.className = 'chat-thinking-body';
	pre.textContent = text;                  // escaped: this is not an answer to parse
	div._body.appendChild(pre);
	// THE "+N characters" COUNT IS GONE (owner review 2026-09-05). The peek
	// already shows the first sentence whole and the fold control already says
	// there is more behind it, so a character count on a collapsed working tile
	// is the end-of-turn furniture the owner asked to remove. Where a peer ran
	// the turn, the hand-off tile above says so; the meta stays empty here.
	if (div._meta) div._meta.textContent = '';
	// The peek is the summary sentence itself (the head), whole — the CSS clips it
	// with an ellipsis, but the full sentence stays in the node.
	if (div._peek) div._peek.textContent = head;
	// ITS TYPE IS FINAL ONLY NOW, so only now is it grouped. It was drawn as an answer,
	// which closed the run of working before it; left there, every round of prose and
	// call stood as a tile and a box of its own, and the turn folded into one group only
	// when a later render redrew it from the stored rows. Posted again through the one
	// door, it joins the run as a reload would draw it (D-20261009-28).
	div.remove();
	postToChat(div);
}

/// Take the live reply tile away without drawing what is in it.
///
/// The one caller is the leaked tool call: its markup streamed token by token into an
/// assistant tile, and finalising that tile would put the fault on screen as the model's
/// answer — which is the whole of the 2026-09-14 defect. `appendLeak` redraws the same
/// bytes as code immediately afterwards, so nothing is lost, only re-labelled.
export function dropAssistant() {
	if (pg.curAsstDiv && pg.curAsstDiv.parentNode) pg.curAsstDiv.parentNode.removeChild(pg.curAsstDiv);
	pg.curAsstDiv = null; pg.curAsstText = ''; _asstRenderPending = false;
	_asstSegs = [];
}

export function finalizeAssistant() {
	if (pg.curAsstDiv && pg.curAsstText) {
		var pinned = nearBottom();
		drawAsst(true);
		// The tile's own header copy takes the answer (`_copyText`); no in-body button.
		if (pinned) setScrollTop(chatOutput.scrollHeight);
	}
	pg.curAsstDiv = null; pg.curAsstText = ''; _asstRenderPending = false;
	_asstSegs = [];
}
// page-split: install 85

/// An answer folded in two: the summary on the face of it, the detail behind.
///
/// Drawn from the `say` call's own arguments, which is what makes this work on BOTH paths for
/// free -- the live turn and a reload both arrive here through `renderToolCall`.
///
/// The transcript record keeps the whole call, which is why the fold still opens after a
/// reload. The wire carries it whole too (daimond_rulings.md §17).
///
/// It is drawn as an ASSISTANT message and not as a tool step, because that is what it is: the
/// answer. A `say` in the Steps drawer would be an answer the user has to turn on a debugging
/// view to read.
///
/// # Arguments
/// * `args` - The call's arguments, as JSON. Unparseable ones return false and fall through to
///   the ordinary tool block, which is honest: a fold nobody can read is not a fold.
/// Which text folds the reader has open, by fold key, so a redraw and a reload draw each one
/// as they left it. Display state only: the wire carries every fold whole.
var _openFolds = Object.create(null);

// Which TEXT folds the reader has open, kept across a reload.
//
// A text fold's key is an ordinal and a label and carries no message identity
// (dev/CONTRACT_FOLD.md §2), which is exactly what lets the open set outlive a
// reload -- there is no message id to have gone stale. It is stored PER CHAT:
// one global set would have two threads opening each other's folds, and the
// chat record itself is not this change's to alter.
//
// Only text-fold keys are held, and `TEXT_FOLD` is their shape.
var FOLDS_KEY = 'daimond-open-folds';
var TEXT_FOLD = /^[0-9]+:/;

function foldStore() {
	try {
		var o = JSON.parse(localStorage.getItem(FOLDS_KEY) || '{}');
		return (o && typeof o === 'object') ? o : {};
	} catch (e) { return {}; }
}

/// Put this chat's open text folds back, and take the last chat's away.
function loadTextFolds() {
	Object.keys(_openFolds).forEach(function (k) {
		if (TEXT_FOLD.test(k)) delete _openFolds[k];
	});
	if (!pg.current || !pg.current.id) return;
	var keys = foldStore()[pg.current.id];
	if (Array.isArray(keys)) keys.forEach(function (k) { _openFolds[String(k)] = 1; });
}

function saveTextFolds() {
	if (!pg.current || !pg.current.id) return;
	var all = foldStore();
	var keys = Object.keys(_openFolds).filter(function (k) { return TEXT_FOLD.test(k); });
	if (keys.length) all[pg.current.id] = keys; else delete all[pg.current.id];
	// Bounded, because nothing else prunes it: a chat deleted a year ago would
	// otherwise keep its folds open forever inside a string that only grows.
	var ids = Object.keys(all);
	while (ids.length > 60) delete all[ids.shift()];
	try { localStorage.setItem(FOLDS_KEY, JSON.stringify(all)); } catch (e) { /* best effort */ }
}

/// Draw a stored `say` call: the summary in the open, the detail behind a control.
///
/// **`say` IS NO LONGER A TOOL and this is not dead code.** An answer is written at two
/// depths in the model's own prose now, as a `<details>` element -- but a conversation
/// saved before that still carries `say` tool_calls, and the history-replay path draws
/// them through here. Delete this and those answers render as NOTHING the moment tool
/// steps are hidden: silent loss, in conversations the user already has.
function renderSaid(args) {
	var o;
	try { o = JSON.parse(args || '{}'); } catch (e) { return false; }
	if (!o || typeof o.summary !== 'string' || !o.summary.trim()) return false;
	finalizeAssistant();
	var div = document.createElement('div');
	div.className = 'chat-msg chat-msg-assistant said';
	var body = document.createElement('div');
	body.className = 'chat-msg-content';
	body.innerHTML = DaimondRender.md(o.summary);
	div.appendChild(body);
	var detail = String(o.detail == null ? '' : o.detail);
	if (detail.trim()) {
		var btn = document.createElement('button');
		btn.className = 'said-more lead-disc';
		btn.setAttribute('aria-expanded', 'false');
		// The size is on the control on purpose: it is the whole of what the reader needs to
		// decide whether to open it.
		var size = fmtTok(Math.round(detail.length / 4));
		// A caret and a number. Everything that used to be on the button -- what it holds,
		// that it is kept here, that it is not re-sent -- is true, worth knowing once, and
		// noise on every message after the first. It moves to the tooltip, where it is there
		// when somebody wonders and gone when they do not.
		btn.textContent = size;
		btn.title = t('say.more_help', { n: size });
		var more = document.createElement('div');
		more.className = 'said-detail';
		more.style.display = 'none';
		div.appendChild(btn); div.appendChild(more);
		btn.addEventListener('click', function () {
			var open = more.style.display === 'none';
			// Rendered on first open, not on draw: a thread of forty folded answers would
			// otherwise parse and lay out forty documents nobody has asked to see.
			if (open && !more.dataset.drawn) {
				more.innerHTML = DaimondRender.md(detail);
				more.dataset.drawn = '1';
			}
			more.style.display = open ? '' : 'none';
			btn.setAttribute('aria-expanded', open ? 'true' : 'false');
			btn.textContent = size;
			btn.title = t(open ? 'say.less_help' : 'say.more_help', { n: size });
		});
		addMsgCopy(div, o.summary + '\n\n' + detail);
	} else {
		addMsgCopy(div, o.summary);
	}
	var lead = firstAwaiting();
	if (lead) chatOutput.insertBefore(div, lead); else chatOutput.appendChild(div);
	if (nearBottom()) setScrollTop(chatOutput.scrollHeight);
	return true;
}
// page-split: install 86

/// The two words an answer travels under, which are NOT translated.
///
/// This is a wire format between the page and the model, in the way
/// `allow-net` is one between the page and the engine: the tool's description
/// tells the model that an answer opens with one of exactly these, and that is
/// how it tells "he chose the option I recommended" from "he rejected every
/// option I offered". A translated marker would be a different marker in eight
/// languages, and the model reads one. What the USER reads is the part after
/// it, which is the label the model itself wrote, in the conversation's own
/// language.
///
/// peer.js holds the same two (`isAskAnswer`), because an answer is never
/// recovered on its own: it means something only beside its card.
export var ASK_CHOSE = 'Chose: ';
var ASK_OTHER = 'Other: ';

/// Is this something the card can actually draw?
///
/// The same shape `ask_step` requires, asked of the raw arguments. Anything
/// else falls through to the ordinary tool block, which is honest: a question
/// nobody can read is not a question.
///
/// # Arguments
/// * `o` - The parsed arguments, or the checked payload; they carry the same fields.
export function askDrawable(o) {
	if (!o || typeof o.question !== 'string' || !o.question.trim()) return false;
	if (!Array.isArray(o.options) || o.options.length < 2 || o.options.length > 4) return false;
	for (var i = 0; i < o.options.length; i++) {
		var op = o.options[i];
		if (!op || typeof op.label !== 'string' || !op.label.trim()) return false;
		if (typeof op.means !== 'string' || !op.means.trim()) return false;
	}
	// A recommendation that names none of the options cannot be marked, and an
	// unmarked recommendation is the failure the field exists to stop.
	return o.options.some(function (op) {
		return op.recommended === true || (typeof o.recommend === 'string'
			&& op.label.trim() === o.recommend.trim());
	});
}

/// Send one answer, as the composer would send it.
///
/// THROUGH `sendUserMessage` AND NOTHING ELSE. That is the one door a message
/// leaves by: it knows whether this is a chat or a Diamond, whether a turn is
/// already running (in which case the answer is queued rather than dropped),
/// and which engine to hand it to. A second send written here would be a
/// second answer to all of those questions, and the two would part company.
///
/// # Arguments
/// * `card` - The card being answered, which is marked and closed.
/// * `text` - The message, already carrying its `Chose: ` or `Other: ` marker.
/// * `shown` - What to tell the reader they answered.
function askAnswer(card, text, shown) {
	if (!card || card.dataset.answered) return;
	askClose(card, shown);
	sendUserMessage(text);
}

/// Mark a card answered: the buttons stop being buttons, and everything stays.
///
/// NOTHING IS REMOVED BUT THE WAY IN. A thread where the question vanished the
/// moment it was answered cannot be read back -- and neither can one that keeps
/// the question and throws the alternatives away, which is the more insidious
/// half: "You answered: On the device" over an empty card says what was decided
/// and hides what it was decided AGAINST, which is the part somebody comes back
/// to a month later to check.
///
/// The chosen option is marked as well as named, so the answer is legible from
/// the card alone rather than only from the sentence under it.
///
/// # Arguments
/// * `card` - The card being closed.
/// * `shown` - What the reader is told they answered: a label, or the words typed in the card.
/// * `how` - `'own'` for a message sent from the composer, `'later'` for a question a later
///   one replaced; either way no option is marked, since none was chosen.
function askClose(card, shown, how) {
	card.dataset.answered = '1';
	card.classList.add('answered');
	[].forEach.call(card.querySelectorAll('.ask-opt'), function (b) {
		b.disabled = true;
		var lab = b.querySelector('.ask-label');
		if (!how && lab && lab.textContent.trim() === String(shown).trim()) b.classList.add('chosen');
	});
	var other = card.querySelector('.ask-other');
	if (other) other.remove();
	var done = document.createElement('div');
	done.className = 'ask-done';
	done.textContent = how === 'own' ? t('ask.answered_own')
		: how === 'later' ? t('ask.superseded')
		: t('ask.answered', { what: shown });
	card.appendChild(done);
	unpinAwaiting(card);			// back to the place it was asked in
	// A queue held under the card (`askHolds`) goes on once this answer's turn ends.
	if (pg.current && (pg.current._queue || []).length) renderQueue();
}

/// The person's next message closes the open question: it is the answer (D-20261009-20).
///
/// A tap or the card's own box sends under `Chose: ` / `Other: `, and the card names what
/// was chosen. Anything else typed is the answer in the person's own words: the card closes
/// with no option marked. That needs no stored flag, because a message queued during the
/// asking turn is held rather than sent (`askHolds`), so the next message after a question
/// is always one sent with the question on screen.
///
/// A message the app sent in the person's place (stored `app: true`: a Diamond's trigger, a
/// preset, a gather round) is drawn as a user message but is not the person's words, so it
/// answers nothing (Q18). Such a message waits behind an open card (`askOpenIn`); one stored
/// before that rule leaves the card open here, as it does on a reload.
///
/// # Arguments
/// * `text` - The user message just drawn, live or replayed.
/// * `app` - Did the app send it, rather than the person?
function askMarkAnswered(text, app) {
	if (!pg._askCard || app) return;
	var card = pg._askCard, s = String(text || '');
	if (!s.trim()) return;
	pg._askCard = null;
	if (card.dataset.answered) return;
	if (s.indexOf(ASK_CHOSE) === 0)      askClose(card, s.slice(ASK_CHOSE.length).trim());
	else if (s.indexOf(ASK_OTHER) === 0) askClose(card, s.slice(ASK_OTHER.length).trim());
	else                                 askClose(card, '', 'own');
}

/// Is a question open in the thread on screen? Then a queue is held under its card rather
/// than sent: the model asked and is waiting, and a message typed before the question was
/// seen must not reach it as the answer (r543 QA-B2 F-B2-1). The next message the person
/// sends answers it, and the queue goes on after that answer's turn.
export function askHolds() {
	return !!(pg._askCard && !pg._askCard.dataset.answered && chatOutput && chatOutput.contains(pg._askCard));
}

/// The engine's own Decision on a blocked turn, in the user's language.
///
/// The engine marks it `app: "blocked"` and words it in English for the model; the reason
/// is the turn's text just above it, so the card only asks (r543 QA F-A2-3). Any other
/// question is a daimon's and is drawn as it was asked.
///
/// # Arguments
/// * `o` - The call's arguments, parsed.
function blockedAsk(o) {
	if (!o || o.app !== 'blocked') return o;
	var retry = t('ask.blocked_retry');
	return {
		app:       o.app,
		question:  t('ask.blocked_q'),
		options:   [
			{ label: retry,                  means: t('ask.blocked_retry_means') },
			{ label: t('ask.blocked_stop'), means: t('ask.blocked_stop_means') },
		],
		recommend: retry,
		why:       t('ask.blocked_why'),
		if_silent: t('ask.blocked_silent'),
	};
}

/// Does the thread of `rec` end on a question still open? Read from the record, so it is
/// answered for a Diamond that is not on screen: the latest question put that no message of
/// the person's has followed, while it is current (`askCurrent`). What the app sent after it
/// (`app`) and the turn's changed-files note are not answers; neither is a message said into
/// the running turn, which does not close the card either (`appendInterjected`).
export function askOpenIn(rec) {
	var ms = (rec && rec.messages) || [];
	for (var i = ms.length - 1; i >= 0; i--) {
		var m = ms[i];
		if (!m) continue;
		if (m.role === 'user' && m.app !== true && !m.interject
			&& !/^\[Daimond: this turn changed /.test(String(m.content || ''))) return false;
		if (m.role === 'tool_log' && m.name === 'ask' && m.outcome === 'done') return askCurrent(m.ts);
	}
	return false;
}

/// Draw one question, with its options as buttons.
///
/// Returns whether it drew one; false falls through to the ordinary tool block.
///
/// # Arguments
/// * `args` - The call's arguments, as JSON.
/// * `askedAt` - When the question was asked, in ms: the tool call's own stamp,
///   which a card drawn again from the transcript keeps. See `armAskIdleBound`.
function renderAsk(args, askedAt) {
	var o;
	try { o = JSON.parse(args || '{}'); } catch (e) { return false; }
	o = blockedAsk(o);
	if (!askDrawable(o)) return false;
	finalizeAssistant();
	var card = document.createElement('div');
	card.className = 'ask-card';
	// A GROUP AND NOT A DIALOG. `role="dialog"` is what a permission prompt is,
	// and the two must not read alike to anybody -- least of all to a screen
	// reader, where the difference between "may I do this" and "which of these
	// do you want" is the whole of the meaning. Nothing here is modal, nothing
	// takes focus, and the thread stays scrollable behind it.
	card.setAttribute('role', 'group');
	card.setAttribute('aria-label', String(o.question));

	var n = Number(o.n) || 0, of = Number(o.of) || 0;
	if (n > 0 && of >= n) {
		var count = document.createElement('div');
		count.className = 'ask-count';
		count.textContent = t('ask.of', { n: String(n), of: String(of) });
		card.appendChild(count);
	}
	var q = document.createElement('div');
	q.className = 'ask-q';
	q.textContent = String(o.question);		// escaped via textContent
	card.appendChild(q);

	var opts = document.createElement('div');
	opts.className = 'ask-opts';
	o.options.forEach(function (op) {
		var rec = op.recommended === true || (typeof o.recommend === 'string'
			&& String(op.label).trim() === o.recommend.trim());
		var b = document.createElement('button');
		b.type = 'button';
		b.className = 'ask-opt' + (rec ? ' recommended' : '');
		var head = document.createElement('span');
		head.className = 'ask-label';
		head.textContent = String(op.label);
		b.appendChild(head);
		if (rec) {
			// NAMED, not merely first. A recommendation implied by ordering is
			// not one, which is the rule `ask_step` refuses a call for breaking;
			// drawing it as position alone here would break the same rule on the
			// one surface the user actually reads.
			var badge = document.createElement('span');
			badge.className = 'ask-rec';
			badge.textContent = t('ask.recommended');
			b.appendChild(badge);
		}
		var means = document.createElement('span');
		means.className = 'ask-means';
		means.textContent = String(op.means);
		b.appendChild(means);
		b.addEventListener('click', function () {
			askAnswer(card, ASK_CHOSE + String(op.label).trim(), String(op.label).trim());
		});
		opts.appendChild(b);
	});
	card.appendChild(opts);

	if (typeof o.why === 'string' && o.why.trim()) {
		var why = document.createElement('div');
		why.className = 'ask-why';
		why.textContent = t('ask.why', { why: o.why.trim() });
		card.appendChild(why);
	}
	if (typeof o.if_silent === 'string' && o.if_silent.trim()) {
		// WHAT HAPPENS IF HE SAYS NOTHING, on the card and not only in the
		// model's context. Saying nothing is an answer people give, and it is
		// only a knowing one if the consequence is on the screen beside the
		// buttons.
		var sil = document.createElement('div');
		sil.className = 'ask-silent';
		sil.textContent = t('ask.silent', { what: o.if_silent.trim() });
		card.appendChild(sil);
	}

	// OTHER IS ALWAYS THERE. He may reject every option, and an answer he types
	// has to reach the model as THE ANSWER rather than as a fresh remark -- so
	// it travels under its own marker and the model is told to expect it.
	var other = document.createElement('div');
	other.className = 'ask-other';
	var open = document.createElement('button');
	open.type = 'button';
	open.className = 'ask-other-open';
	open.textContent = t('ask.other');
	var row = document.createElement('div');
	row.className = 'ask-other-row';
	row.style.display = 'none';
	var box = document.createElement('input');
	box.type = 'text';
	box.className = 'ask-other-box';
	box.placeholder = t('ask.other_ph');
	box.setAttribute('aria-label', t('ask.other_ph'));
	var go = document.createElement('button');
	go.type = 'button';
	go.className = 'ask-other-go';
	go.innerHTML = SEND_ARROW;
	go.title = t('ask.send');
	go.setAttribute('aria-label', t('ask.send'));
	var send = function () {
		var said = box.value.trim();
		if (!said) return;
		askAnswer(card, ASK_OTHER + said, said);
	};
	go.addEventListener('click', send);
	box.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { e.preventDefault(); send(); }
	});
	open.addEventListener('click', function () {
		row.style.display = '';
		open.style.display = 'none';
		try { box.focus(); } catch (e) { /* no focus to take */ }
	});
	row.appendChild(box); row.appendChild(go);
	other.appendChild(open); other.appendChild(row);
	card.appendChild(other);

	// AWAITING THE READER until it is answered, while it is current: then it stands last
	// (see `pinAwaiting`). The person's next message answers it (`askMarkAnswered`), and a
	// later question replaces it (`renderToolResult`), so either sends it back to its place.
	card._awaits = function () {
		return !card.dataset.answered && askCurrent(askedAt);
	};
	if (card._awaits()) pinAwaiting(card);
	else {
		var lead = firstAwaiting();
		if (lead) chatOutput.insertBefore(card, lead); else chatOutput.appendChild(card);
	}
	// The question still open, if any: closed once this one is put, kept if this one is refused.
	card._prev = (pg._askCard && !pg._askCard.dataset.answered) ? pg._askCard : null;
	pg._askCard = card;
	if (pg.current && (pg.current._queue || []).length) renderQueue();
	if (nearBottom()) setScrollTop(chatOutput.scrollHeight);
	armAskIdleBound(card, typeof o.if_silent === 'string' ? o.if_silent.trim() : '', askedAt);
	return true;
}

/// The ask card's own half of `armIdleBound`: it is drawn straight into the
/// transcript rather than through `dialog()`, so it cannot share that seam's
/// timer, only the same RULE. Half an hour untouched answers it on the model's
/// OWN word for what silence means -- `if_silent`, said on the card already
/// (see `renderAsk`) -- so this never invents a choice among the options; where
/// the model declared none, it says plainly that none came, which is the ask
/// card's version of `nothing()`.
///
/// ONLY WHILE THE QUESTION IS CURRENT (2026-09-23). An answer on silence is a turn
/// nobody sent, and `if_silent` is the model's plan for a silence in the sitting it
/// asked in. A card is drawn again long after that: by every reload, on every device
/// the transcript reaches, and by [Answer again] on a hand-off that expired. Armed
/// there, a question days old answered itself on a page nobody was at, which is the
/// shape of the 2026-09-22 delete. So the bound is armed, and fires, only while the
/// question's own stamp is inside `ASK_SILENT_MAX_MS`; past that the card stays open
/// until the person answers it.
function armAskIdleBound(card, ifSilent, askedAt) {
	if (!askCurrent(askedAt)) return;
	armIdleBound(
		function () {
			return pg._askCard === card && !card.dataset.answered && document.body.contains(card)
				&& askCurrent(askedAt);
		},
		function () {
			var said = ifSilent || t('ask.no_answer');
			trail('ask idle', 'Nobody touched the page for '
				+ Math.round(dialogIdleMs() / 60000) + ' min while this question stood open, '
				+ 'so it answered itself: ' + said);
			askAnswer(card, ASK_OTHER + said, said);
		});
}

/// Is a question asked at `askedAt` still current enough for its silence to answer
/// it? No stamp is never current, and neither is a stamp from far ahead of this
/// clock, which would otherwise stay current for as long as the skew.
function askCurrent(askedAt) {
	var at = Number(askedAt) || 0;
	return at > 0 && Math.abs(Date.now() - at) <= ASK_SILENT_MAX_MS;
}
// page-split: install 87

/// Why a question was not drawn, in the daimon's language, so its refusal opens with the
/// cause rather than a bare "did not draw" (2026-10-12: the owner was on the crystal face and
/// the daimon was told only about a key it had not sent). The rule itself stands (2026-09-12):
/// a question is drawn only on a screen showing the conversation that asks it.
function askUnseenWhy(o) {
	if (!askDrawable(o)) {
		return 'the question cannot be drawn as given: it needs a question and 2 to 4 options, '
			+ 'each with a label and a meaning, and a recommendation naming one of them';
	}
	var where = unseenWhy(null, true);
	return where + ', and a question is drawn only on a screen showing the conversation that asks it';
}

export function renderToolCall(name, args, callId, ts) {
	// The answer, not a step. Only ever a STORED call -- see `renderSaid`, which says
	// why the reader outlives the tool.
	if (name === 'say' && renderSaid(args)) { _saidJust = true; return; }
	_saidJust = false;
	// The QUESTION, not a step. A tool block would put the thing the turn is
	// waiting on behind a debugging view that is off by default.
	if (name === 'ask' && renderAsk(args, ts)) { pg._askJust = true; return; }
	pg._askJust = false;
	// Not `finalizeAssistant`: prose with a tool call after it is working, not an answer.
	// See `demoteToWorking`.
	demoteToWorking();
	// A Tool tile — run locally, so centred (indented both sides), collapsed by
	// default, expanding to Sent → Result. The old `.tool-block`/`.running`/
	// `.tool-result` hooks ride along so the result, live output and Steps switch
	// find it unchanged.
	var argsText = typeof args === 'string' ? args : JSON.stringify(args);
	var block = buildTile('tool', { expanded: false, meta: name, ts: ts });
	block.classList.add('tool-block', 'running');
	block._toolName = name;
	var io = document.createElement('div'); io.className = 'ctile-io';
	var sc = document.createElement('div');
	sc.innerHTML = '<div class="cap"></div>';
	sc.querySelector('.cap').textContent = tOr('chat.tool_sent', 'Sent');
	var argsPre = document.createElement('pre');
	argsPre.className = 'tool-args sent';
	argsPre.textContent = argsText;
	sc.appendChild(argsPre);
	var rc = document.createElement('div');
	rc.innerHTML = '<div class="cap"></div>';
	rc.querySelector('.cap').textContent = tOr('chat.tool_result', 'Result');
	var resPre = document.createElement('pre');
	resPre.className = 'tool-result result';
	resPre.style.display = 'none';
	rc.appendChild(resPre);
	rc.style.display = 'none';
	io.appendChild(sc); io.appendChild(rc);
	block._body.appendChild(io);
	block._resWrap = rc; block._resPre = resPre;
	tilePeek(block, argsText.replace(/^\{|\}$/g, '').trim());
	tagTurn(block);
	postToChat(block);
	pg.lastToolBlock = block;
	pinBottom();
}

/// How a tool call ended, read back out of its RESULT TEXT.
///
/// FOR A LOG WRITTEN BEFORE THE OUTCOME WAS A FIELD, and for nothing else --
/// dev/CONTRACT_OUTCOME.md §4. A live event carries `ev.outcome`, which is the
/// engine's own word; calling this on one puts back the defect the field was
/// added to remove. `Refused:` is `refusal_line`'s unconditional prefix
/// (src/tools.rs) across some twenty sites and was missing from the test that
/// used to stand here, so every fence refusal drew as a COMPLETED step, was
/// journalled as a success, and told `DaimondSignals.noteTool` the tool had
/// worked.
///
/// The set of conversations it has to serve stops growing: a tool log written
/// from here on stores the outcome beside the result.
export function outcomeOfStoredText(result) {
	var s = String(result || '');
	if (/^\s*Refused\b/i.test(s)) return 'refused';
	if (/^\s*Error\b/i.test(s))   return 'failed';
	return 'done';
}
// page-split: install 88

/// Draw a finished tool call in the state the ENGINE said it ended in.
///
/// `outcome` is `AgentEvent::ToolResult`'s third field -- exactly `done`,
/// `refused` or `failed` -- and the result text is never asked about it. An
/// outcome that is none of the three is drawn as a failure rather than quietly
/// as a success, so a build whose engine has stopped sending one says so on the
/// first tool call instead of going green. `paused` is the pause node that
/// refused the call, the event's own field, and '' for any other call.
export function renderToolResult(name, result, outcome, paused) {
	if (name === 'say' && _saidJust) { _saidJust = false; return; }
	// The result of a question is a sentence written for the model about what it
	// has just done, so it is not drawn under the card the user is reading.
	//
	// EXCEPT WHEN THE QUESTION WAS NOT PUT. `ask_step` refuses things this page
	// cannot see -- a second question in one turn, a dispatched worker -- and the
	// card was drawn from the call rather than from the answer. So a card whose
	// call came back anything but `done` is taken away again: leaving it would
	// offer buttons for a question the model was told it never asked.
	if (name === 'ask' && pg._askJust) {
		pg._askJust = false;
		if (!pg._askCard) return;
		var prev = pg._askCard._prev;
		pg._askCard._prev = null;
		if (outcome !== 'done') {
			if (pg._askCard._slot) { pg._askCard._slot.remove(); pg._askCard._slot = null; }
			pg._askCard.remove();
			// The question this one would have followed is still the open one.
			pg._askCard = (prev && !prev.dataset.answered && document.body.contains(prev)) ? prev : null;
		} else if (prev && !prev.dataset.answered) {
			// ONE OPEN QUESTION AT A TIME (D-20261009-20): a later question replaces an
			// earlier one nobody answered, which closes and goes back to its place.
			askClose(prev, '', 'later');
		}
		return;
	}
	var refused = outcome === 'refused';
	var failed  = !refused && outcome !== 'done';
	if (pg.lastToolBlock) {
		pg.lastToolBlock.classList.remove('running');
		pg.lastToolBlock.classList.toggle('failed', failed);
		// A REFUSAL IS NOT A BREAKAGE. The fence did its job and the text under it
		// is the rule, written for the person: the remedy is to grant a path or ask
		// for something else, not to debug. So it is drawn in the warning colour
		// rather than the danger one -- and NAMED as well as coloured, because amber
		// against red is the one distinction a red-green reader cannot make, and
		// until this seam landed there were not two states to tell apart at all.
		pg.lastToolBlock.classList.toggle('refused', refused);
		markOutcome(pg.lastToolBlock, refused ? 'refused' : failed ? 'failed' : 'done',
			refused ? paused : '');
		if (pg.lastToolBlock._resWrap) pg.lastToolBlock._resWrap.style.display = '';
		var resPre = pg.lastToolBlock.querySelector('.tool-result');
		// A tool that SUCCEEDS can be colourful too, so the plain path is stripped
		// as well; ONLY A STATED FAILURE goes through friendlyError. Neither a refusal
		// nor an outcome this build does not recognise does: `friendlyError` is for raw
		// fe2o3 frames, and it collapses paragraphs, strips punctuation and swallows any
		// string naming a number into its status-code arm -- which turns a refusal's own
		// sentence, and a plain "Wrote 6 bytes", into "Could not reach that endpoint".
		// So an unknown outcome is FLAGGED but its text is left alone: saying loudly
		// that something is wrong is right, and rewriting the tool's words to say it is
		// not.
		resPre.textContent = outcome === 'failed' ? friendlyError(result) : stripAnsi(result);
		resPre.style.color  = refused ? 'var(--warn)' : '';
		resPre.style.display = '';
		// COMPUTED FROM THE RESULT, at every drawing of it, so a thread redrawn
		// after a reload says the same thing the live one said without a flag
		// having had to survive the journey.
		noNetLine(pg.lastToolBlock, ranWithoutNet(result));
	}
	pinBottom();
}

/// Say on the block itself that this command ran with the network withheld.
///
/// THE USER-FACING HALF OF A THING THAT ONLY EVER HAD A MODEL-FACING ONE.
/// `src/tools.rs`'s `NO_NET_NOTE` is appended to the result so the model knows
/// why a fetch, install or clone failed and does not report the project as
/// broken; the person watching `cargo build` stop halfway had nothing at all,
/// and learned the reason only if the model chose to relay a bracketed English
/// note written for itself.
///
/// It is not a failure and is not drawn as one: the app did what it was asked
/// -- something written by somebody else had been read, and the network went
/// with it -- so this is the warning colour the fence's own refusals use and
/// not the danger one. It sits inside the tool block because it is about that
/// one command, and so goes away with the Steps switch that takes the block.
function noNetLine(block, on) {
	// On the tile itself, AFTER the body, so the warning stays visible when the
	// tool step is folded away — it is a notice, not part of the result.
	var line = block.querySelector('.ctile-nonet');
	if (!on) { if (line) line.remove(); return; }
	if (!line) {
		line = document.createElement('div');
		line.className = 'ctile-nonet';
		block.appendChild(line);
	}
	// Bound rather than written, so a language change reaches it where it stands.
	if (!DaimondI18n.bind(line, '', 'chat.tool_no_net')) {
		line.textContent = tOr('chat.tool_no_net',
			'This ran with no network, because Daimond had read something written by '
				+ 'somebody else. Anything in it that tried to fetch, install or clone got '
				+ 'nothing. The permissions button gives it back.');
	}
}

/// Did the command behind this result run with the network withheld?
///
/// ASKED OF THE ENGINE, ABOUT THE RESULT. `Tool::run` writes its note beside
/// the fence it built, so the answer is in the characters that came back and
/// nothing here has to re-derive it -- and `Wasm.ran_without_net` matches the
/// note's opening rather than its wording, so the sentence can be improved
/// without this going quiet.
///
/// NOT `net_state()`, which was the first draft of this and answers a
/// different question: that says what the NEXT command would get, and a line
/// drawn under the command that has just come back has to say what THAT one
/// got. The two differ on a `run` the fence refused outright -- nothing ran,
/// so there is nothing to say -- and on a chat whose answer moved while the
/// command was in flight.
function ranWithoutNet(result) {
	try {
		// `Wasm` is this module's own namespace import and is never on `window`;
		// an older bundle simply has no such export, and then nothing is drawn.
		return !!(Wasm && Wasm.ran_without_net
			&& Wasm.ran_without_net(String(result || '')));
	} catch (e) { return false; }
}

/// Name a tool call's outcome on the tile's label bar, beside the colour.
///
/// Amber against red is the one distinction a red-green reader cannot make, so
/// the state is a WORD as well as a hue: "web_search · ok", "· refused", "· failed".
///
/// A refusal a PAUSE made says so, and names the control by its label --
/// "web_search · Paused — Web access" -- because the sentence saying what to press
/// is otherwise only in the collapsed body (QA-1). The node is the engine's
/// `paused` field on the event, never read back out of the translated sentence.
function markOutcome(block, outcome, paused) {
	if (!block._meta) return;
	var word = paused                ? tOr('pause.refused_title', 'Paused')
		: outcome === 'refused' ? tOr('chat.tool_refused', 'refused')
		: outcome === 'failed'   ? tOr('chat.tool_failed', 'failed')
		:                          tOr('chat.tool_ok', 'ok');
	var label = (block._toolName || '') + ' · ' + word;
	if (paused) {
		var name = paused;
		try { if (window.DaimondPause) name = DaimondPause.label(paused) || paused; } catch (e) { name = paused; }
		label += ' — ' + name;
		block.dataset.pauseNode = paused;
	}
	block._meta.textContent = label;
}

/// The most a live command's output may occupy in the chat.
///
/// The whole of it is kept by the relay and bounded there; this is the
/// smaller bound on what one DOM node holds, because a build that prints for
/// ten minutes would otherwise grow a text node until the tab suffers for it.
var RUN_LIVE_MAX = 16000;

/// Show what a running command is printing, while it runs.
///
/// A tool result arrives in one blob, which is right for the model and wrong
/// for a person: a `cargo test` says nothing for a minute and then says
/// everything, and a still panel is indistinguishable from a hang. So the
/// machine hand's output is written into the running tool block as it
/// arrives, and `renderToolResult` replaces it with the finished result.
export function runLive(text) {
	if (!pg.lastToolBlock || !pg.lastToolBlock.classList.contains('running')) return;
	var pre = pg.lastToolBlock.querySelector('.tool-result');
	if (!pre) return;
	pg.lastToolBlock.classList.remove('collapsed');
	if (pg.lastToolBlock._resWrap) pg.lastToolBlock._resWrap.style.display = '';
	pre.style.display = '';
	var s = pre.textContent + String(text == null ? '' : text);
	if (s.length > RUN_LIVE_MAX) s = '… ' + s.slice(s.length - RUN_LIVE_MAX);
	pre.textContent = s;                 // escaped via textContent
	if (nearBottom()) setScrollTop(chatOutput.scrollHeight);
}

export function appendError(msg, m) {
	var div = document.createElement('div');
	div.className = 'chat-msg chat-msg-error';
	// A stored row's own time (one from before `ts` reads as old), or now for one made now (`uiScan`).
	div.setAttribute('data-made', String(m ? (+m.ts || 1) : Date.now()));
	div.innerHTML = '<div class="chat-msg-content" style="color: var(--danger);"></div>';
	var body = div.querySelector('.chat-msg-content');
	// A road that broke on the runner names the runner, as a seat reason: its label here, its
	// sentence on hover, and a tap swaps the one for the other (RUNNER-ROAD). The tab's own
	// text would send the reader to this device's Settings for a fault that is not here.
	var road = runnerRoad(m);
	if (road) {
		body.className += ' chat-err-why';
		body.textContent = road.label;
		body.title = road.why;
		body.setAttribute('aria-label', road.why);
		body.setAttribute('aria-expanded', 'false');
		body.addEventListener('click', function () {
			var open = body.getAttribute('aria-expanded') !== 'true';
			body.textContent = open ? road.why : road.label;
			body.setAttribute('aria-expanded', open ? 'true' : 'false');
		});
	} else {
		body.textContent = friendlyError(msg);
	}
	// D-20260920-02 (#4): the chat's own error line is where a person
	// actually IS when a turn fails -- give the one-tap report a home here,
	// not only on the unhandled-rejection toast (`errorToastWithReport`)
	// and not only behind a hunt for the Settings button, which is the
	// exact "number in a column" B2 exists to fix. Arm before offering it:
	// an `appendError` not already preceded by a `DaimondSupport.arm` call
	// elsewhere (e.g. "Could not start agent") must still have something
	// for the tap to send; `arm()` is a no-op once already armed.
	if (window.DaimondSupport) {
		try { DaimondSupport.arm('chat.error'); } catch (eArm) {}
		var reportBtn = document.createElement('button');
		reportBtn.type = 'button';
		reportBtn.className = 'post-btn chat-err-report';
		reportBtn.textContent = tOr('support.report_link', 'Report this');
		reportBtn.addEventListener('click', function () {
			reportBtn.disabled = true;
			DaimondSupport.report('chat.error', function (said) { reportBtn.textContent = said; });
		});
		div.appendChild(reportBtn);
	}
	tagTurn(div);
	postToChat(div);
	pinBottom();
}

/// Say in the thread why a turn did not run: a pause's refusal in the app's own
/// neutral voice (`appendNote`), anything else as the error it is. `failRole` is the
/// role the same line is stored under, so a reload draws it the same way.
///
/// A person's own pause is not a fault (R3 QA, Q6-3). Drawn by `appendError`, the
/// refusal at dispatch wore the danger colour and a "Report this" that armed a support
/// report for a turn that had done exactly what the person asked -- held. A turn a
/// pause catches part way is handed back as paused, not as an error (FB), and a turn
/// a pause refused before it began is said the same way. `pauseError` marks it.
export function appendFailure(e) {
	if (e && e.paused) appendNote(friendlyError(e));
	else appendError(e);
}

export function failRole(e) { return (e && e.paused) ? 'note_log' : 'error_log'; }

/// The app's own neutral voice in a thread — a status line, not a failure.
///
/// A fan-out's handover ("Worker w34 finished") is a STATUS, and `appendError`
/// drew it in --danger red, which taught the reader to read a normal handover as a
/// fault. This draws the quiet register a fold notice uses (`chat-msg-compacted`):
/// left-aligned and dashed, a note ABOUT the thread rather than something said in it.
/// No `friendlyError` -- the text is the app's own plain sentence, not a raw Outcome.
export function appendNote(msg) {
	var div = document.createElement('div');
	div.className = 'chat-msg chat-msg-compacted';
	var body = document.createElement('div');
	body.className = 'chat-msg-content';
	body.textContent = String(msg == null ? '' : msg);      // escaped
	div.appendChild(body);
	tagTurn(div);
	postToChat(div);
	pinBottom();
}

	// ── The Admin panel ────────────────────────────────────────

// The chat whose transcript is currently drawn in the thread, so a re-render can
// tell opening a NEW chat (land at the bottom) from redrawing the OPEN one (hold
// the reader's place). See renderHistory.
var _renderedChatId = null;
// page-split: install 89

// True only while `renderHistory` is drawing its own tiles, so `postToChat` and
// `clearChat` can tell a render's draws from a live turn's and leave `_renderSynced`
// alone for the former.
export var _renderingHistory = false;
// page-split: install 90

// ms the reader last scrolled the thread, and how recent counts as "still
// scrolling". A store-driven re-render (a sync progress frame, another tab's write)
// that would CLEAR and rebuild the thread while the reader is mid-gesture writes
// scrollTop under them -- which on iOS kills the momentum, the "shaking" the
// reverted seq-228 resume storm caused. renderHistory defers exactly that case a
// beat; see the guard there. A pull-driven APPEND is unaffected (it clears nothing
// and touches scrollTop only when the reader is pinned to the bottom).
var _lastScrollAt = 0;
var SCROLL_SETTLE_MS = 220;
var _deferredRenderTimer = null;
// The last position THIS CODE put the thread at. A programmatic write raises a
// `scroll` event exactly as a finger does, so without this the restores below would
// read their own work as the reader scrolling -- which would cancel the hold that
// made the write and defer the next render for a gesture nobody made. Compared by
// position rather than by a flag and a timer: a user scroll always lands somewhere
// else, and at worst one event is missed by a reader who scrolls back to the exact
// pixel the app had chosen.
var _selfTop = -1;

// Was the reader at the live end the last time the thread moved? Read on a RESIZE
// of the thread's own box, below.
var _wasAtEnd = true;

/// Move the thread, and remember that WE moved it.
export function setScrollTop(v) {
	// REFLOW-FREE BATCH DRAW. A full rebuild (and the tail-only append) draws every
	// tile through `drawHistoryMessage`, and several of those tiles pin the thread to
	// the bottom as they land (a question, a tool call, a tool result). Each such write
	// reads `scrollTop` back on the next line, which forces the browser to flush the
	// layout the just-appended tile invalidated -- so a transcript of n tiles costs n
	// synchronous reflows, quadratic on a switch to a long chat. The per-tile pin is
	// wasted anyway: `renderHistory` pins the thread ONCE at the end (see the end-pin at
	// the close of the rebuild and of the append). So drop every scroll write while the
	// rebuild owns the thread; the single end-pin does the work with one reflow.
	if (_renderingHistory) return;
	chatOutput.scrollTop = v;
	_selfTop = chatOutput.scrollTop;		// read back: the browser clamps to the range
	_wasAtEnd = nearBottom();
	syncJumps();
}

/// Pin the thread to the live end. The unconditional draw-path idiom, kept in one
/// place so the `scrollHeight` read -- which flushes the layout the just-drawn tile
/// invalidated -- happens AFTER the rebuild guard, not while evaluating an argument.
/// A no-op during a rebuild: the single end-pin in `renderHistory` does the one write.
export function pinBottom() {
	if (_renderingHistory) return;
	setScrollTop(chatOutput.scrollHeight);
}

/// Is the reader following the live end (UNBLOCK-45)? At it now, or at it when the thread last
/// moved and not scrolled away since. A tile that grows in place moves no scroll, so the
/// geometry alone said "not at the end" after one grown answer, and every frame after it was
/// drawn below a reader who had never left: CC keeps the last tile's bottom in view.
export function followsEnd() {
	return _wasAtEnd || nearBottom();
}
// page-split: install 91

/// New rows or growth landed: keep a following reader's last tile in view, or mark the end
/// button for one who has scrolled up. `follow` is `followsEnd()` read before the drawing.
export function followActivity(follow) {
	if (follow) { pinBottom(); return; }
	_endNews = true;
	syncJumps();
}
// page-split: install 92

// ── The Rating tile ────────────────────────────────────────

/// A cheap per-message signature: its id and everything the drawing reads that could
/// change WITHOUT the id changing (content length, elision, outcome, the hand-off and
/// interruption marks, a fold's counts). Deliberately not a stringify of the whole
/// message -- the point is to diff a megabyte of transcript without touching a
/// megabyte, so only scalars and a length are read.
function msgSig(m) {
	if (!m) return '';
	var c = m.content == null ? '' : String(m.content);
	return (m.mid || '') + '#' + (m.role || '') + '#' + c.length
		+ '#' + (m.elided || 0) + '#' + (m.outcome || '') + '#' + (m.interrupted ? 1 : 0)
		+ '#' + (m.why || '') + '#' + (m.folded || 0) + '#' + (m.kept || 0)
		+ '#' + (m.ranOn || '') + '#' + (m.handoffFellBack ? 1 : 0) + '#' + (m.interject ? 1 : 0)
		// The hand-off REFUSAL marks (S-HAND #6): the placeholder's own `refused` (so the
		// seat note appears/clears) and the answer's `handoffRefused` (so its provenance
		// line survives a redraw). Both change the drawing without changing the id.
		+ '#' + (m.refused ? 1 : 0) + '#' + (m.handoffRefused ? 1 : 0) + '#' + (m.handoffBusy || '') + '#' + (m.handoffThread || '')
		+ '#' + (m.toDevice || '') + '#' + (m.claimedBy || '') + '#' + (m.seatNote || '')
		+ '#' + (m.name || '') + '#' + (m.callId || '') + '#' + (m.say ? JSON.stringify(m.say) : '');
}

export function sigsOf(messages) {
	var out = [];
	for (var i = 0; i < messages.length; i++) out.push(msgSig(messages[i]));
	return out;
}

/// Is `next` the already-drawn `prev` with zero or more messages appended, and nothing
/// in the drawn prefix changed? Only then is drawing the tail alone the same DOM as a
/// full rebuild would have produced. Any shortening, any change to a message already on
/// screen, or a middle insertion answers no, and the caller rebuilds.
function isAppendOf(prev, next) {
	if (next.length < prev.length) return false;
	for (var i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false;
	return true;
}

/// Draw one stored message as its tile(s). The SINGLE per-message drawing path, shared
/// by the full rebuild and the tail-only append, so the two cannot draw a message
/// differently. Every path reaches `postToChat`, which coalesces a run of same-type
/// tiles onto the box standing last -- so a tail drawn onto a thread whose last box is a
/// rollup groups exactly as a rebuild would have grouped it.
export function drawHistoryMessage(m, i, arr) {
	// A message said into a running turn is a user message to the model and
	// not a turn of its own here, so it is drawn where it landed rather than
	// as the question that started something.
	if (m.role === 'user' && m.interject) appendInterjected(m.content);
	else if (m.role === 'user') {
		// A question already answered is drawn as answered (`askMarkAnswered`, inside).
		var ut = appendUserMessage(m.content, m.ts, m.prod, m.files, m.app === true);
		if (m.seatNote) drawSeatNote(ut, String(m.seatNote));
		// A runner turn's Files row names the files of his it changed (UNBLOCK-26).
		if (m.yours) appendYoursTile(m);
	}
	else if (m.role === 'assistant') {
		// A turn HANDED TO A PEER, still in flight: an empty `dispatched`
		// placeholder. It draws as its OWN hand-off tile (naming the device,
		// a live spinner, the §5 status and control) rather than as an empty
		// Daimond bubble with a footer under it — so a handed-off turn reads
		// as a tile in the flow from the moment it leaves, and the spinner is
		// visible for the whole wait (owner review 2026-09-05). Skipped once
		// the answer has merged (finished), so the tile does not sit spinning
		// beside the reply in the window before the placeholder is dropped.
		if (m.interrupted && m.why === 'dispatched' && !(m.content && m.content.trim())
			&& window.DaimondPeer && DaimondPeer.uiState) {
			appendDispatchedTile(m);
		} else {
			appendAssistantText(logRowText(m), m.ranOn, m.handoffFellBack, m);
			var div = pg.curAsstDiv;
			finalizeAssistant();
			// A turn the tab died in the middle of: show what arrived, badge it, and offer to
			// run it again. The mark rides on the message so it survives further reloads.
			if (m.interrupted && div) markInterrupted(div, m);
		}
	}
	else if (m.role === 'error_log') { appendError(logRowText(m), m); }
	// A rating, drawn as one tile for its whole burst. Anything this build cannot read
	// (`isRatingMsg`) draws nothing, as a role it had never heard of would.
	else if (m.role === 'rating_log') { appendRatingLine(m); }
	// A chat turn's changed files, drawn from its records (display only, never sent to the model).
	else if (m.role === 'files_log') { appendFilesLog(m); if (m.yours) appendYoursTile(m); }
	// The app's own NEUTRAL voice -- a fan-out handover, drawn as a status line
	// rather than the red of an error. Its own role so a reload draws it that way.
	else if (m.role === 'note_log') { appendNote(m.content); }
	// THE COUNTS TRAVEL, so a reload draws the boundary where the live turn drew it.
	// A `vision_log` shares this drawing and is not a fold, so it passes none and gets
	// the plain notice -- see `appendCompacted`.
	else if (m.role === 'fold_log') { appendCompacted(m.content || '', m.folded, m.kept, m.ts); }
	else if (m.role === 'vision_log') { appendCompacted(logRowText(m) || '', undefined, undefined, m.ts); }
	else if (m.role === 'think_log') { appendThinking(m.content || '', false, m.ts, m.mid); }
	// A tool call that arrived as prose. Its own role rather than an assistant
	// message, because it is not the model's answer and must never be redrawn as
	// one -- which is precisely what happened on 2026-09-14.
	else if (m.role === 'leak_log') { appendLeak(m.content || '', m.ts); }
	// How the turn ended, redrawn from the record: a reload that dropped it
	// would leave a reader who had walked away with the same silence the
	// line exists to replace.
	else if (m.role === 'end_log') { appendEnding(m, !!arr && i === arr.length - 1); }
	// The runner's stand-in for the oldest rows of a frame it had to cut ("N steps not
	// shown"): a silent cut reads as a turn that did less than it did.
	else if (m.role === 'cut_log') { appendNote(logRowText(m)); }
	else if (m.role === 'tool_log') {
		// A record of a tool the agent ran. Display only: it is not sent
		// back to the model, which cannot replay a tool call it has no
		// call-id for.
		renderToolCall(m.name || '', m.args || '', m.callId || '', m.ts);
		// THE ONE PLACE PROSE IS STILL READ. A tool log stored before the outcome
		// was a field has the text and nothing else; one stored since carries it.
		renderToolResult(m.name || '', m.content || '',
			m.outcome || outcomeOfStoredText(m.content || ''), m.paused || '');
	}
}

// THE READER'S PLACE, AS A THING IN THE TRANSCRIPT RATHER THAN A NUMBER.
//
// `scrollTop` alone is only the reader's place while everything ABOVE the viewport
// keeps its height, and across an unrequested re-render it does not: the System band
// is rebuilt at the head of the thread, an image or a KaTeX font lands late, a tile
// two turns up gains a line. Restoring the number then puts the reader somewhere
// else and calls it the same place. So the place is recorded as a TILE and an
// offset -- the tile nearest the top of the viewport, and how far its top sits above
// or below that edge -- and restored by putting that tile back at that offset, which
// is the idiom `jumpBack` already uses to walk the questions.
//
// The key is the tile's turn number and its ordinal within that turn, because a
// rebuild draws new nodes and the old element is gone: `data-turn` is on every tile
// `tagTurn` drew, and the ordinal distinguishes the question from the answer beneath
// it. A tile the rebuild did not redraw (the turn was folded away) answers null and
// the caller falls back to the raw scrollTop, which is what it had before.
var ANCHOR_HOLD_MS = 1200;		// how long a restore keeps re-asserting itself
var _anchorHold = null;			// the live re-assert, cancelled by the next render

/// Where the reader is: the tile nearest the top of the viewport, and its offset
/// from that edge. Null when the thread holds no tile to anchor on.
function takeAnchor() {
	if (!chatOutput) return null;
	var or = chatOutput.getBoundingClientRect();
	var kids = chatOutput.children, seen = {};
	for (var i = 0; i < kids.length; i++) {
		var k = kids[i];
		if (!k.dataset || k.dataset.turn == null) continue;
		var turn = String(k.dataset.turn);
		seen[turn] = (seen[turn] || 0) + 1;
		var r = k.getBoundingClientRect();
		// The first tile whose bottom is still on screen is the one the reader is
		// reading from; everything before it is above the fold.
		if (r.bottom - or.top > 1) return { turn: turn, nth: seen[turn], off: r.top - or.top };
	}
	return null;
}

/// Put the anchored tile back where it was. True when it could be found.
function applyAnchor(a) {
	if (!a || !chatOutput) return false;
	var kids = chatOutput.children, n = 0;
	for (var i = 0; i < kids.length; i++) {
		var k = kids[i];
		if (!k.dataset || String(k.dataset.turn) !== a.turn) continue;
		if (++n !== a.nth) continue;
		// Measured, not computed from offsetTop: the thread is not necessarily the
		// offset parent. Same reading `jumpBack` takes.
		var d = k.getBoundingClientRect().top - chatOutput.getBoundingClientRect().top - a.off;
		if (Math.abs(d) > 0.5) setScrollTop(chatOutput.scrollTop + d);
		return true;
	}
	return false;
}

/// Hold the reader's place THROUGH the layout that has not happened yet.
///
/// A restore made the instant the tiles are drawn is made before the browser has
/// loaded the images in them, before KaTeX's fonts have swapped, and before an
/// embedded page has reported its height -- each of which changes the height of
/// something above the viewport and moves the reader. So `reassert` is run on the
/// next frame and for a short window afterwards, and the hold stops the moment the
/// reader touches the thread themselves: one that fought a real scroll would be the
/// same bug with better manners. Null cancels a hold and starts none.
export function hold(reassert) {
	if (_anchorHold) { clearInterval(_anchorHold.iv); _anchorHold = null; }
	if (!reassert) return;
	var startedAt = Date.now(), scrollMark = _lastScrollAt;
	var h = { iv: 0 };
	var beat = function () {
		if (_lastScrollAt !== scrollMark || Date.now() - startedAt > ANCHOR_HOLD_MS) {
			clearInterval(h.iv);
			if (_anchorHold === h) _anchorHold = null;
			return;
		}
		reassert();
	};
	try { requestAnimationFrame(beat); } catch (e) { /* no rAF in this context */ }
	h.iv = setInterval(beat, 100);
	_anchorHold = h;
}

/// Hold the anchored tile where the render put it.
function holdAnchor(a) { hold(a ? function () { applyAnchor(a); } : null); }

/// Hold a reader who was at the live end ON it. The same need as `holdAnchor`
/// from the other side: the pin is written before the images and equations in
/// the tail have laid out, so a thread that grows afterwards leaves the reader
/// short of the end they were just pinned to.
function holdBottom() { hold(function () { setScrollTop(chatOutput.scrollHeight); }); }

/// Redraw the parts of the thread that are NOT the transcript: the queue box, the
/// System band, the permissions chip. Runs on every render -- full or append -- because
/// each can differ between two chats and the append path does not otherwise touch them.
function renderHistoryFurniture() {
	// A tile that awaited the reader may not any longer (a blocker cleared, a stamp aged).
	reconcileAwaiting();
	renderQueue();
	// The band belongs to the conversation on screen, and every part of it can differ between
	// two: a Diamond's fence is not a chat's, and a user may have rewritten one role prompt
	// and not the other.
	if (typeof renderWire === 'function') renderWire();
	// And the permissions chip, which carries the same kind of fact: whether THIS
	// conversation's commands have the network. Two chats side by side differ, and
	// the mark is on a button that does not otherwise redraw.
	if (window.DaimondHandMode && DaimondHandMode.refresh) DaimondHandMode.refresh();
	// Retry and Edit & resend, which belong to the LAST turn and so move with
	// every question asked. Here because this is the one call every render path
	// makes -- the rebuild, the append fast path, and the nothing-changed early
	// return, which still has furniture to put right.
	mountTurnActions();
	// The rating arrows on each answer, kept in step with the transcript.
	mountRateControls();
}

export function renderHistory(messages) {
	// KEEP THE READER'S PLACE across a re-render they did not ask for.
	//
	// renderHistory runs when a chat is opened, and also whenever the chats store
	// changes under the one already open -- a sync parcel arriving
	// (onChatsChangedElsewhere), another tab writing, a dispatch report landing, a
	// trashed chat restored. Rebuilding the thread resets the scroll (clearChat
	// empties it) and pins each turn to the bottom as it is drawn
	// (appendUserMessage), so before this every such change hauled a reader who had
	// scrolled up back down to the newest message on its own -- the transcript
	// "jumping around" when focus returned to the tab and a sync pull fired.
	//
	// Opening a DIFFERENT chat still lands at the bottom, where the conversation
	// is. Redrawing the SAME chat holds the reader exactly where they were, unless
	// they were already at the live end, in which case they stay pinned to it so a
	// turn added elsewhere comes into view. Both readings are taken BEFORE the
	// rebuild, while the old scroll state is still on screen.
	var sameChat = pg.current && pg.current.id && pg.current.id === _renderedChatId;
	var wasDown  = followsEnd();
	var keepTop  = chatOutput.scrollTop;
	// And the reader's place as a TILE, which survives a height change above the
	// viewport that the number cannot. See `takeAnchor`.
	var anchor   = sameChat ? takeAnchor() : null;

	// DO NOT REBUILD UNDER AN ACTIVE SCROLL. A store-driven re-render (a streamed
	// progress frame, another tab's write) that lands while the reader is mid-gesture
	// on a scrolled-up thread would clearChat (resetting scroll to the top) and then
	// write scrollTop back to hold their place -- and writing scrollTop mid-momentum
	// is what iOS reads as a yank, the "shaking" the reverted resume storm caused.
	// So when a SAME-CHAT change that is NOT a clean append arrives within a scroll's
	// settle window and the reader is not pinned to the live end, defer it a beat and
	// coalesce: when the gesture settles, the render runs and puts them back exactly.
	// A chat OPEN (`!sameChat`) is never deferred -- it is the reader's own action --
	// and an append is never deferred (it clears nothing and writes scrollTop only
	// when pinned), so the streaming common case stays immediate. A reader pinned to
	// the bottom is following the stream, not scrolling away, so it renders at once.
	var nextSigs = Array.isArray(messages) ? sigsOf(messages) : [];
	if (sameChat && !wasDown && Array.isArray(messages)
		&& (Date.now() - _lastScrollAt) < SCROLL_SETTLE_MS
		&& !isAppendOf(pg._renderedSigs, nextSigs)) {
		if (_deferredRenderTimer) clearTimeout(_deferredRenderTimer);
		_deferredRenderTimer = setTimeout(function () {
			_deferredRenderTimer = null;
			// The live messages, which may have grown again while the reader scrolled.
			if (pg.current && Array.isArray(pg.current.messages)) renderHistory(pg.current.messages);
		}, SCROLL_SETTLE_MS);
		return;
	}
	if (_deferredRenderTimer) { clearTimeout(_deferredRenderTimer); _deferredRenderTimer = null; }

	// THE APPEND FAST PATH. The same chat is on screen and the only change is turns
	// added on the end -- the common case behind every store-change nonce, a sync
	// pull, another tab's write, a landed dispatch. Draw the new tail onto the tiles
	// already standing (nothing cleared, the counters continue) rather
	// than clearing thousands of tiles and rebuilding every one. `drawHistoryMessage`
	// is the same door as the rebuild below, so the tail draws identically; the drawn
	// prefix is proven byte-for-byte unchanged by `isAppendOf`, so the result is the
	// same DOM. Falls through to the rebuild for a chat switch, a shortening, an edit,
	// or a middle insertion.
	// A DISPATCHED PLACEHOLDER WHOSE ANSWER HAS NOW MERGED forces the full rebuild
	// below: the append fast path would draw only the new tail (the answer) and leave
	// the placeholder's spinner tile -- drawn before the answer arrived -- standing.
	// The full rebuild re-runs `appendDispatchedTile`, which suppresses the spinner
	// beside a present reply (`dispatchedAnswerPresent`). Belt-and-braces to the
	// sync-path drop in `onChatsChangedElsewhere`, for any answer that merged without
	// dropping the placeholder (a chat not on screen at merge time, a legacy record).
	// AND A HAND-OFF TILE WHOSE STATE HAS MOVED since it was drawn (2026-09-25). A
	// report or a lease change moves the state without touching the transcript, so
	// the nothing-changed return below kept the old tile: "Sent to your other
	// devices" and its spinner stood beside a turn whose `done` report was in.
	var _staleDispatch = false, _staleAt = -1;
	if (sameChat && pg.current && Array.isArray(messages)) {
		for (var _sdi = 0; _sdi < messages.length; _sdi++) {
			var _sdm = messages[_sdi];
			if (!_sdm || _sdm.why !== 'dispatched' || (_sdm.content && _sdm.content.trim())) continue;
			if (dispatchedAnswerPresent(pg.current, _sdm) || handoffTileMoved(_sdm)) { _staleDispatch = true; _staleAt = _sdi; break; }
		}
	}
	// NOTHING CHANGED, SO NOTHING IS DRAWN AND NOTHING IS SCROLLED.
	//
	// Most pulls carry no news for the chat on screen: a parcel whose only
	// difference is the chunk index, another device's touch on a DIFFERENT chat, a
	// push acknowledged back. `onChatsChangedElsewhere` re-reads the open chat's
	// row unconditionally and calls this with an array that is message-for-message
	// what is already drawn -- and this used to fall into the append path, which
	// draws no tile but still re-pins a reader at the live end. That pin is where
	// the 2026-09-14 drift came from, and a transcript that did not change has no
	// reason to be re-pinned at all. The furniture is still redrawn: the queue, the
	// System band and the permissions chip belong to the chat and not to the
	// message list, and any of them can differ while the transcript does not.
	if (sameChat && pg._renderSynced && !_staleDispatch && Array.isArray(messages)
		&& nextSigs.length === pg._renderedSigs.length && isAppendOf(pg._renderedSigs, nextSigs)) {
		renderHistoryFurniture();
		return;
	}
	if (sameChat && pg._renderSynced && !_staleDispatch && Array.isArray(messages)) {
		// `nextSigs` was taken at the top of this function, before the defer guard.
		if (isAppendOf(pg._renderedSigs, nextSigs)) {
			_renderingHistory = true;
			loadTextFolds();
			for (var i = pg._renderedSigs.length; i < messages.length; i++) {
				drawHistoryMessage(messages[i], i, messages);
			}
			_renderingHistory = false;
			syncJumps();
			renderHistoryFurniture();
			// Pinned to the live end only if they were already there; otherwise put
			// back where the reader had it. NOT "left where it was": the tail was
			// drawn through `drawHistoryMessage`, and `appendUserMessage` pins the
			// thread to the bottom for every question it draws -- which is what a
			// live turn wants and is why a reader scrolled up used to be hauled
			// 600px down the moment another device's turn merged. Either way the
			// place is then HELD through the layout still to come: an image or an
			// equation in that tail lands after this line.
			if (wasDown) { setScrollTop(chatOutput.scrollHeight); holdBottom(); }
			else { if (!applyAnchor(anchor)) anchor = null; holdAnchor(anchor); }
			pg._renderedSigs = nextSigs;
			_renderedChatId = pg.current && pg.current.id ? pg.current.id : null;
			pg._renderSynced = true;
			return;
		}
	}

	// THE CHANGED TURN, NOT THE THREAD (UNBLOCK-47, 27 Oct). A handed-off turn's frame grows
	// the row the last frame ended on and adds the next: not an append, so every frame cleared
	// and redrew the whole thread, 558 messages on gilgamesh, until the page stopped. A change
	// confined to the last turns redraws from the question that opened the first of them, and
	// the turns above stand as drawn.
	if (sameChat && pg._renderSynced && Array.isArray(messages) && redrawFromTurn(messages, nextSigs, _staleAt)) {
		syncJumps();
		renderHistoryFurniture();
		if (wasDown) { setScrollTop(chatOutput.scrollHeight); holdBottom(); }
		else { if (!applyAnchor(anchor)) anchor = null; holdAnchor(anchor); }
		pg._renderedSigs = nextSigs;
		_renderedChatId = pg.current && pg.current.id ? pg.current.id : null;
		pg._renderSynced = true;
		return;
	}

	_renderingHistory = true;
	// THE SYSTEM BAND CROSSES THE REBUILD, because it is not part of the transcript
	// and it is at the HEAD of it. `clearChat` empties the thread, and `renderWire`
	// puts the band back only after an await into the engine -- so without this the
	// place is restored against a thread missing the band's height, and the reader
	// is moved by it when the band lands a frame later. Held out and put straight
	// back for the SAME chat; a chat SWITCH lands at the live end anyway and gets
	// the new chat's own band from `renderWire`.
	var heldWire = sameChat ? document.getElementById('wire-head') : null;
	if (heldWire) heldWire.remove();
	clearChat();
	// Before a single fold is drawn: which of them this chat's reader had open.
	loadTextFolds();
	if (!Array.isArray(messages)) { _renderingHistory = false; syncJumps(); pg._renderedSigs = []; pg._renderSynced = true; return; }
	messages.forEach(drawHistoryMessage);
	if (heldWire) chatOutput.insertBefore(heldWire, chatOutput.firstChild);
	_renderingHistory = false;
	syncJumps();
	renderHistoryFurniture();
	// Put the reader back where the head of this function measured them: at the
	// live end when they were already there or when this is a freshly opened chat,
	// otherwise exactly where they had scrolled to. The per-turn pin above is what
	// this overrides -- it fired for every user message the replay drew.
	if (!sameChat || wasDown) { setScrollTop(chatOutput.scrollHeight); holdBottom(); }
	else {
		// The number first, so a thread with nothing to anchor on (a transcript of
		// fold notices, a turn the rebuild dropped) lands where it always did, and
		// then the TILE, which is the reading that survives the band being rebuilt
		// above it and the images in it loading after it.
		setScrollTop(keepTop);
		if (!applyAnchor(anchor)) anchor = null;
		holdAnchor(anchor);
	}
	pg._renderedSigs = sigsOf(messages);
	_renderedChatId = pg.current && pg.current.id ? pg.current.id : null;
	pg._renderSynced = true;
}

/// Does `m` open a turn when drawn (`appendUserMessage`'s `_turn += 1`)?
function opensTurn(m) {
	return !!m && m.role === 'user' && !m.interject && !/^\[Daimond: this turn changed /.test(String(m.content || ''));
}

/// Redraw from the question opening the turn the first change in `messages` is in (or the
/// stale hand-off at `staleAt`), leaving the turns above it as drawn. The drawing state is
/// put back as that turn started (`_turnMarks`), so the result is what a whole rebuild draws.
/// False, with nothing touched, where it cannot be: no turn opens above the change, the
/// turn's question is not on screen, or a fold row whose marks stand above it has gone.
function redrawFromTurn(messages, nextSigs, staleAt) {
	var prev = pg._renderedSigs, n = Math.min(prev.length, nextSigs.length), i0 = 0;
	while (i0 < n && prev[i0] === nextSigs[i0]) i0++;
	if (staleAt >= 0 && staleAt < i0) i0 = staleAt;
	var sigKey = function (g) { var p = String(g).split('#'); return { role: p[1], key: p[0] || String(g) }; };
	var folds = {};
	for (var k = i0; k < nextSigs.length; k++) { var nk = sigKey(nextSigs[k]); if (nk.role === 'fold_log') folds[nk.key] = 1; }
	for (var r = i0; r < prev.length; r++) { var pk = sigKey(prev[r]); if (pk.role === 'fold_log' && !folds[pk.key]) return false; }
	var u = -1, turnN = 0;
	for (var i = 0; i < i0 && i < messages.length; i++) if (opensTurn(messages[i])) { u = i; turnN++; }
	if (u < 0 || turnN > pg._turn) return false;
	var mark = pg._turnMarks[turnN], head = null;
	var kids = chatOutput.children;
	for (var c = kids.length - 1; c >= 0; c--) {
		var kc = kids[c];
		if (kc.classList.contains('chat-msg-user') && kc.dataset.turn === String(turnN)) { head = kc; break; }
	}
	if (!mark || !head) return false;
	_renderingHistory = true;
	// Furniture stays, and so does a tile an earlier turn pinned last (`pinAwaiting`).
	for (var node = head, nx; node; node = nx) {
		nx = node.nextSibling;
		if (node === spinnerEl || node.id === 'chat-queued') continue;
		if (node.dataset && node.dataset.turn != null && +node.dataset.turn < turnN) continue;
		node.remove();
	}
	pg.curAsstDiv = null; pg.curAsstText = ''; pg.liveThink = null; pg.lastToolBlock = null;
	pg._askCard = mark.ask; pg._askJust = mark.askJust; _saidJust = mark.said; pg._handoffTurn = mark.handoff;
	pg._turn = turnN - 1; pg._jumpAt = -1; pg._turnMarks.length = turnN;
	loadTextFolds();
	for (var j = u; j < messages.length; j++) drawHistoryMessage(messages[j], j, messages);
	_renderingHistory = false;
	return true;
}

/// Is `m` the "not run" row? Read off its `notRun`, whatever its tag (SUHT-R F1). Its tag is the
/// one each old build routes as ONE turn retried as `-rt` under one lease, so an old page's Retry
/// cannot run it unrouted under a fresh id: a chat's row is `why: 'runner'` (the lost-turn tag),
/// a Diamond's `why: 'notrun'`, since the live build (4c94152fd) sends only a chat's `runner` row
/// to `retryTurn` and runs a Diamond's here under a fresh id (review MED-2). The rows SUHT wrote
/// before carry `why: 'notrun'` and no `notRun`.
export function isNotRunRow(m) { return !!m && !!m.interrupted && (!!m.notRun || m.why === 'notrun'); }

/// Is `m` a lost turn's row, whose Retry asks the turn again as `lostRetryMid(m.iturn)`? A run
/// the runner lost, or a turn that ran nowhere ("not run").
export function isLostRow(m) { return !!m && !!m.interrupted && (m.why === 'runner' || isNotRunRow(m)); }

/// The prompt a "not run" row asks again: the one it carries, else its turn's own.
function notRunAsk(chat, m) {
	var ask = String((m && m.itext) || '');
	if (ask) return ask;
	((chat && chat.messages) || []).forEach(function (x) {
		if (x && x.role === 'user' && (x.mid === m.iturn || x.iturn === m.iturn)) ask = x.content || '';
	});
	return ask;
}

/// A lost row whose retry another device has CLAIMED: its `-rt` lease names another holder,
/// in any phase of its life (N1, review of STEER delta 1; D2-1, delta 2). Drawn "<device> is
/// doing this." with no Retry, as a handed-off turn's tile is, until the retraction arrives
/// and removes the row. A run that has ENDED there (`done`, or settled) still owns the turn:
/// the `-rt` id is single-use, so a Retry would stand down until the tombstone drains, a
/// dead button saying "not run" about an answered turn. Only a vacant, unsettled lease (the
/// busy give-back, or one aged out) draws Retry, which can win. The lease view's onChange,
/// on a write and at an expiry (D2-2), redraws the history. True when it drew.
function drawLostRowRunning(div, foot, m) {
	var rt = lostRetryMid(m.iturn);
	var who = '';
	try { who = peerLeaseClaimed(rt); } catch (e) { return false; }
	if (!who) return false;
	var name = '';
	try { name = who === '?' ? '' : runnerLabel(who); } catch (e) { name = ''; }
	var spin = document.createElement('span');
	spin.className = 'ti-spin';
	spin.innerHTML = '<span class="chat-spinner-dot"></span>'
		+ '<span class="chat-spinner-dot"></span><span class="chat-spinner-dot"></span>';
	var label = document.createElement('span');
	label.className = 'ti-label';
	label.textContent = name ? t('turn.peer_running_named', { name: name }) : t('turn.peer_running');
	foot.appendChild(spin); foot.appendChild(label);
	div.appendChild(foot);
	return true;
}

/// THE "NOT RUN" LINE SAYS WHY (NOTRUN-WHY; rulings §7 "Seat reasons are short"): "Not run ·"
/// and its cause's 2-4 word label, through the one renderer (`seatReason`), the sentence on
/// hover and, tapped, in its place; the runner's own words follow it where it gave them
/// (RUN-HIST E). A row with no cause keeps the plain words, its diagnostic on hover.
function drawNotRunReason(label, nr) {
	var r = seatReason(notRunWhyKey(nr));
	if (!r) {
		label.textContent = t('turn.not_run');
		if (nr && nr.why) label.title = String(nr.why);
		return;
	}
	var said = (nr.said && (nr.cause === 'refused' || nr.cause === 'keys' || nr.cause === 'oversize')) ? ' ' + String(nr.said) : '';
	var short = t('turn.not_run_because', { why: r.label }), whole = r.why + said;
	label.textContent = short;
	label.title = whole;
	label.dataset.why = String(nr.cause);
	label.setAttribute('role', 'button');
	label.setAttribute('tabindex', '0');
	label.setAttribute('aria-label', whole);
	label.setAttribute('aria-expanded', 'false');
	var flip = function (e) {
		if (e && e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
		if (e && e.preventDefault) e.preventDefault();
		var open = label.getAttribute('aria-expanded') !== 'true';
		label.textContent = open ? whole : short;
		label.setAttribute('aria-expanded', open ? 'true' : 'false');
	};
	label.addEventListener('click', flip);
	label.addEventListener('keydown', flip);
}

/// Badge a recovered assistant message as interrupted, with a Continue button that runs the
/// turn again. `m.iturn` groups every message of the interrupted turn; `m.itext` is the prompt
/// to re-run.
function markInterrupted(div, m) {
	div.classList.add('interrupted');
	var foot = document.createElement('div');
	foot.className = 'turn-interrupted';
	// A turn handed to a peer draws the §5 state machine, not the local
	// interrupted copy: its words and its control depend on the lease and the
	// report, which DaimondPeer.uiState decides (step 6).
	if (m.why === 'dispatched' && window.DaimondPeer && DaimondPeer.uiState) {
		renderDispatchedFooter(foot, m);
		div.appendChild(foot);
		return;
	}
	var label = document.createElement('span');
	label.className = 'ti-label';
	// A HAND-OFF THE DOOR TURNED AWAY BEFORE IT LEFT (SEND-UNHANDED): the turn ran nowhere,
	// and says so. Retry asks it again as a send is asked, through `retryTurn`'s lost route:
	// the switch decides where it runs, and every device's Retry names one turn, one lease.
	// Asked before the runner-lost row below, whose tag it shares (`isNotRunRow`).
	if (isLostRow(m) && drawLostRowRunning(div, foot, m)) return;
	if (isNotRunRow(m)) {
		label.className = 'ti-label lead-warn';
		drawNotRunReason(label, m.notRun);
		// RETRY FOLLOWS THE SWITCH; RUN HERE IS HIS CHOICE OF THIS DEVICE (NOTRUN-WHY 2). Both go
		// through the one fenced retry path (rulings l.16-18: one turn id, one lease); Run here
		// passes the switch by. A press disables both, so one tile asks once.
		var nb = document.createElement('button');
		nb.className = 'ti-continue';
		nb.textContent = t('turn.retry');
		var hb = document.createElement('button');
		hb.className = 'ti-continue';
		hb.textContent = t('turn.peer_runhere');
		var press = function (here) {
			return function () {
				if (nb.disabled) return;
				nb.disabled = hb.disabled = true;
				retryTurn(pg.current, m.iturn, notRunAsk(pg.current, m), here ? { lost: true, here: true } : { lost: true });
			};
		};
		nb.addEventListener('click', press(false));
		hb.addEventListener('click', press(true));
		foot.appendChild(label); foot.appendChild(nb); foot.appendChild(hb);
		div.appendChild(foot);
		return;
	}
	// A HANDED-OFF RUN THE RUNNER LOST (r545 F-C2-1): the device running it reloaded,
	// and the turn ended there as it stood rather than run again from its first round.
	// What it had done is above; Retry runs the whole turn afresh, a new turn, never a
	// continuation of a run whose state went with the reload.
	if (m.why === 'runner') {
		label.className = 'ti-label lead-warn';	// the glyph is drawn by the role; see `.lead-ok` in app.css
		label.textContent = runnerLostLabel(m);
		var rb = document.createElement('button');
		rb.className = 'ti-continue';
		rb.textContent = t('turn.retry');
		rb.addEventListener('click', function () {
			var ask = m.itext || '';
			if (!ask && pg.current) {
				(pg.current.messages || []).forEach(function (x) {
					if (x && x.role === 'user' && (x.mid === m.iturn || x.iturn === m.iturn)) ask = x.content || '';
				});
			}
			continueTurn(pg.current, m.iturn, ask, false, true);
		});
		foot.appendChild(label); foot.appendChild(rb);
		div.appendChild(foot);
		return;
	}
	// WHICH interruption. A turn that died on the road and a turn that died with the tab
	// are both interrupted and are not the same sentence, and until the road case existed
	// there was only one to say. A phone showing "the browser closed before this finished"
	// to somebody who had just walked out of wifi range is a small lie that makes the app
	// look like it does not know what happened to it.
	// Four literal calls rather than a key chosen in an expression: `dev/i18ncheck.mjs`
	// reads the key out of the source, and a key it cannot read is a key nothing can prove
	// exists in en.js -- where an absence is English for every language, silently.
	// A turn a pause caught part way (`brakeHeld`) says what to press to carry on.
	label.className = 'ti-label lead-warn';
	label.textContent = (m.why === 'offline'
		? (m.content ? t('turn.offline')      : t('turn.offline_early'))
		: m.why === 'paused'
			? (m.content ? t('turn.paused')   : t('turn.paused_early'))
			: (m.content ? t('turn.interrupted')  : t('turn.interrupted_early')));
	var btn = document.createElement('button');
	btn.className = 'ti-continue';
	// A DAIMON TURN IS RETRIED, not continued (D-20261010-22: "Retry now, Resume
	// later"). Continue re-enters through the chat path, which a Diamond's daimon
	// does not run on; Retry asks his question again through `runSteer`.
	if (pg.current && pg.current.diamondId && !m.why) {
		btn.textContent = t('turn.retry');
		btn.addEventListener('click', function () { continueTurn(pg.current, m.iturn, m.itext, false, true); });
		foot.appendChild(label); foot.appendChild(btn);
		div.appendChild(foot);
		return;
	}
	btn.textContent = t('turn.continue');
	btn.title = t('turn.continue_help');
	btn.addEventListener('click', function () { continueTurn(pg.current, m.iturn, m.itext); });
	foot.appendChild(label); foot.appendChild(btn);
	div.appendChild(foot);
}

/// Draw the §5 footer for a turn handed to a peer: the words for its current
/// state and the one control that state offers. The state is decided by the pure
/// `DaimondPeer.uiState` (peerUiStateFor); this only renders it. Literal `t()`
/// keys, so dev/i18ncheck.mjs can read every one out of the source.
function renderDispatchedFooter(foot, m) {
	var st = peerUiStateFor(m);
	if (st === 'done') return;			// the merged answer draws itself; no badge
	// BLOCKED -- the runner is stopped on something, and the tile says what and
	// offers the runner's own controls (owner ruling 2026-09-12). Drawn by its own
	// function and returned from here, so a blocker's words and buttons are one
	// place and the state machine below is untouched.
	if (st === 'blocked') { renderBlockerFooter(foot, m); return; }
	// A LIVE spinner for the whole in-flight wait, so a handed-off turn never
	// looks dead. Up while the turn is on the road or running on a peer — from
	// the moment it is dispatched, through the claim and the run, until the
	// answer syncs back (the placeholder is then dropped, or a report settles it
	// to parked/failed and the spinner rests). The dots are the SAME class the
	// thread's own turn spinner uses, so the two indications cannot drift and the
	// reduced-motion rest state applies to both (owner review 2026-09-05).
	if (st === 'dispatched' || st === 'claimed' || st === 'running' || st === 'awaiting-consent') {
		var spin = document.createElement('span');
		spin.className = 'ti-spin';
		spin.innerHTML = '<span class="chat-spinner-dot"></span>'
			+ '<span class="chat-spinner-dot"></span><span class="chat-spinner-dot"></span>';
		foot.appendChild(spin);
	}
	var label = document.createElement('span');
	label.className = 'ti-label';
	// The machine's NAME when we have it ("argonaut is doing this."), else the
	// generic wording ("Running on your other device."). The name comes from the
	// presence beat of whoever holds the lease.
	var holder = turnRunnerId(m.iturn);
	var name = runnerLabel(holder);
	if      (st === 'no-peer-awake') label.textContent = t('turn.peer_none');
	else if (st === 'ending')        { label.className = 'ti-label lead-warn'; label.textContent = t('turn.not_run'); }
	else if (st === 'claimed')       label.textContent = name ? t('turn.peer_claimed_named', { name: name }) : t('turn.peer_claimed');
	else if (st === 'running')       label.textContent = name ? t('turn.peer_running_named', { name: name }) : t('turn.peer_running');
	else if (st === 'awaiting-consent') {
		// The dispatch status stops lying: the runner is blocked on a live question
		// the user must answer, so it names the act and the machine rather than
		// sitting on "Sent to your other devices."
		var ask = _openAsk[String(m.iturn)] || null;
		var act = consentActPhrase(ask);
		label.textContent = name
			? t('turn.peer_consent_named', { name: name, act: act })
			: t('turn.peer_consent', { act: act });
	}
	else if (st === 'parked')        label.textContent = t('turn.peer_parked');
	else if (st === 'failed' || st === 'interrupted') {
		// INTERRUPTED, NOT REFUSED (UNBLOCK-7 F3): a runner that was cut off -- an aborted
		// report, a lease that expired under it, or a claim that went silent -- is named,
		// and the turn offered again. A hand-back (`error`) keeps "couldn't finish".
		// `interrupted` is the runner's own settled cut (check_f234 fix 1), always named.
		var iname = interruptedRunner(m, name, st === 'interrupted');
		if (iname != null) label.textContent = iname ? t('turn.peer_interrupted_named', { name: iname }) : t('turn.peer_interrupted');
		else label.textContent = pausedBack(m) || t('turn.peer_failed');
	}
	else {												// dispatched (pre-claim)
		// Name the CHOSEN target tentatively while the errand is out but unclaimed,
		// so the owner sees WHERE it is going -- "Sending to X…", present-progressive,
		// an intention not a claim, so seq 217's honesty holds (no past-tense "Handed
		// off to X" until a device has actually taken the lease). Generic only when no
		// target was named (a re-dispatch with no chosen peer).
		var tgt = handoffTargetLabel(m);
		label.textContent = tgt ? t('turn.peer_sending_named', { name: tgt }) : t('turn.peer_sent');
	}
	foot.appendChild(label);
	// The one control this state offers, from the pure table. A healthy hand-off
	// offers NOTHING (owner, D-20261009-23: no take back -- the person chose the seat
	// before sending). A stall or a failure offers RUN HERE; a parked turn a RE-RUN.
	// `DaimondPeer.dispatchControl` is the table; this owns the words and the wiring,
	// so a state can never draw a control the ruling forbids.
	var control = (window.DaimondPeer && DaimondPeer.dispatchControl)
		? DaimondPeer.dispatchControl(st, m)
		: (st === 'parked' ? 'rerun'
			: ((st === 'failed' || st === 'no-peer-awake') ? 'runhere' : ''));
	if (control === 'runhere' && st === 'failed' && interruptedRunner(m, name) != null) control = 'retry';
	if (control === 'retry') {
		var rt = document.createElement('button');
		rt.className = 'ti-continue';
		rt.textContent = t('turn.retry');
		// ASKED AGAIN AS A SEND IS (ruling D-20261010-22): the switch decides where it runs,
		// and the new turn is named from the cut one, so two devices' Retries are one turn
		// under one lease (`retryTurn`'s lost route, as a runner-lost row's Retry).
		rt.addEventListener('click', function () { retryTurn(pg.current, m.iturn, m.itext, { lost: true }); });
		foot.appendChild(rt);
	} else if (control === 'rerun') {
		var rr = document.createElement('button');
		rr.className = 'ti-continue';
		rr.textContent = t('turn.peer_rerun');
		rr.addEventListener('click', function () { reRunParked(pg.current, m.iturn, m.itext); });
		foot.appendChild(rr);
	} else if (control === 'runhere') {
		var rh = document.createElement('button');
		rh.className = 'ti-continue';
		rh.textContent = t('turn.peer_runhere');
		rh.addEventListener('click', function () { continueTurn(pg.current, m.iturn, m.itext, false, undefined, false); });
		foot.appendChild(rh);
	} else if (control === 'answeragain') {
		// An ask-card answer is never sent after the fact, even on a click: the
		// question is opened again instead, and answered beside its options.
		var aa = document.createElement('button');
		aa.className = 'ti-continue';
		aa.textContent = t('turn.peer_answeragain');
		aa.addEventListener('click', function () { answerAgain(pg.current, m.iturn); });
		foot.appendChild(aa);
	}
}

/// The runner a failed hand-off was interrupted on: its name, '' when it cannot be named,
/// or null when the failure was not an interruption (a hand-back, a refusal). `name` is
/// the live lease holder's, when there is one; `cut` says the state already knows it was one.
/// The words of a handed-off run the runner lost: "Interrupted on <device>" where the
/// row names the runner (`lostOn`, stamped where it wrote the row) and the name is
/// known here, else the unnamed sentence (check_f234 fix 6, I9).
function runnerLostLabel(m) {
	var who = (m && m.lostOn) ? deviceLabelFor(m.lostOn) : '';
	return who ? t('turn.peer_interrupted_named', { name: who }) : t('turn.runner_lost');
}

function interruptedRunner(m, name, cut) {
	var rep = peerReports[String(m && m.iturn)] || null;
	var lease = (window.DaimondLease && DaimondLease.record) ? DaimondLease.record(m.iturn) : null;
	cut = cut || (rep ? rep.status === 'aborted' : (!!(lease && lease.mode !== 'released') || !!m.claimedBy));
	if (!cut) return null;
	if (name) return name;
	var who = String((lease && lease.holder) || (rep && rep.by) || m.claimedBy || '');
	var nm = who ? deviceLabelFor(who) : '';
	return String(nm || m.toName || '');
}

/// The pause a runner turned this hand-off away for, in the words every door refuses
/// a pause with, or '' when it was not a pause (R53-U8b, QU8 Q3). The runner's report
/// names the node (`paused`); the tile said "couldn't finish" and its [Run here] was
/// the first anyone heard of a pause. [Run here] stays: it confirms the hold against
/// the mailbox, then runs, or says the same words again while the pause holds.
function pausedBack(m) {
	var rep = peerReports[String(m && m.iturn)] || null;
	if (!rep || rep.status !== 'error' || !rep.paused) return '';
	try { return DaimondModels.pauseError(String(rep.paused)).message; }
	catch (e) { return String(rep.why || ''); }
}

/// Draw the footer for a turn whose runner is BLOCKED: what stopped it, and the
/// same controls the runner itself is showing.
///
/// `DaimondPeer.blockerTileSpec` decides the SHAPE (which controls, and whether the
/// thing can be answered away from the runner at all); this owns the words, with a
/// literal `t()` per kind so `dev/i18ncheck.mjs` can read every key out of the
/// source. A kind this build does not know draws as a report with "Run here
/// instead", never as a button that would do nothing.
///
/// The three report-only kinds are report-only for a reason that is not a policy:
/// `requestPermission` needs a user gesture on the runner's own page, and a lock or
/// a refused provider key is a fact about that machine. Offering a remote "Allow"
/// for any of them would be a button that cannot work.
function renderBlockerFooter(foot, m) {
	var b = blockerFor(m.iturn);
	if (!b) { foot.appendChild(document.createTextNode('')); return; }
	var holder = (window.DaimondLease && DaimondLease.holder) ? DaimondLease.holder(m.iturn) : null;
	var name = holder ? deviceLabelFor(holder) : '';
	var spec = DaimondPeer.blockerTileSpec(b, name, selfDeviceId());

	// A live spinner for as long as the turn is held up, the same dots the thread's
	// own turn spinner uses: the turn has not stopped, it is waiting on a person.
	var spin = document.createElement('span');
	spin.className = 'ti-spin';
	spin.innerHTML = '<span class="chat-spinner-dot"></span>'
		+ '<span class="chat-spinner-dot"></span><span class="chat-spinner-dot"></span>';
	foot.appendChild(spin);

	var label = document.createElement('span');
	label.className = 'ti-label';
	var act = consentActPhrase({ tool: spec.tool, host: spec.host, about: spec.about, detail: spec.detail });
	var q   = spec.detail || t('egress.nothing');
	var permit = DaimondPeer.permitAsk(spec.kind);
	if (spec.kind === 'consent' || permit) {
		label.textContent = name ? t('turn.block_consent_named', { name: name, act: act })
			: t('turn.block_consent', { act: act });
	} else if (spec.kind === 'ask') {
		label.textContent = name ? t('turn.block_ask_named', { name: name, q: q })
			: t('turn.block_ask', { q: q });
	} else if (spec.kind === 'fsa') {
		label.textContent = name ? t('turn.block_fsa_named', { name: name }) : t('turn.block_fsa');
	} else if (spec.kind === 'lock') {
		label.textContent = name ? t('turn.block_lock_named', { name: name }) : t('turn.block_lock');
	} else if (spec.kind === 'provider') {
		label.textContent = name ? t('turn.block_provider_named', { name: name }) : t('turn.block_provider');
	} else {
		label.textContent = name ? t('turn.block_unknown_named', { name: name }) : t('turn.block_unknown');
	}
	foot.appendChild(label);

	// THE EXACT STRING being authorised, for a consent -- the same rule the dialog
	// keeps: what is being agreed to is not summarised.
	if ((spec.kind === 'consent' || permit) && spec.detail) {
		var quote = document.createElement('div');
		quote.className = 'ti-block-detail';
		quote.textContent = spec.detail;
		foot.appendChild(quote);
	}

	function btn(text, title, onClick) {
		var x = document.createElement('button');
		x.className = 'ti-continue';
		x.textContent = text;
		if (title) x.title = title;
		x.addEventListener('click', onClick);
		foot.appendChild(x);
		return x;
	}
	for (var i = 0; i < spec.controls.length; i++) {
		var c = spec.controls[i];
		if (c === 'grant') {
			btn(t('turn.block_allow'), '', function () { answerBlocker(m.iturn, b, 'allow'); });
		} else if (c === 'deny') {
			btn(t('turn.block_deny'), '', function () { answerBlocker(m.iturn, b, 'deny'); });
		} else if (c === 'choose') {
			// ONE BUTTON PER OPTION, in the model's own words. Answering an `ask`
			// from here is the same act the card performs on the runner -- choosing a
			// label -- so the answer travels as the choice and nothing is translated.
			spec.options.forEach(function (opt) {
				btn(String(opt), '', function () { answerBlocker(m.iturn, b, 'allow', String(opt)); });
			});
		} else {
			btn(t('turn.block_runhere'), t('turn.block_runhere_help'), function () {
				runBlockedTurnHere(pg.current, m.iturn, m.itext);
			});
		}
	}
	// NO TAKE-BACK on a blocked turn (owner take-back ruling 2026-09-17): a blocker
	// means a peer has CLAIMED and is running the turn, and take-back is pre-claim
	// only. The turn is answered here (the controls above) or run here, never revoked.
}

/// Has this dispatched turn's REAL answer already arrived? The merged reply is found
/// positionally, because a peer's answer syncs back with no `iturn` on it (runTurn
/// stamps only the interrupted branches) — so the answer that belongs to a dispatched
/// turn is the first non-empty, non-interrupted assistant message after its
/// placeholder and before the next question. Used to drop the placeholder and to stop
/// the hand-off chrome once the durable answer has landed.
///
/// A PROVISIONAL streamed row does NOT count (owner standing rule 2026-09-18): the
/// answer streams as provisional tiles WHILE the turn runs, and the placeholder's
/// chrome (the spinner) must stay until the durable answer merges. A bare `done`
/// report no longer counts either -- the report is a nudge, not the answer; dropping
/// the placeholder on it (before the answer was in the transcript) is what forced the
/// rebuild that lost the streamed tile.
export function dispatchedAnswerPresent(chat, m) {
	if (!chat || !chat.messages) return false;
	var msgs = chat.messages;
	// A merged answer may still carry the turn's iturn (the interrupted-then-
	// finished paths do stamp it); match that first, wherever it sits. Provisional
	// rows are skipped -- only the durable, merged copy counts.
	for (var k = 0; k < msgs.length; k++) {
		var a = msgs[k];
		if (a.role === 'assistant' && !a.interrupted && !a.provisional && a.content && a.content.trim()
			&& String(a.iturn) === String(m.iturn)) return true;
	}
	// Positional: from the placeholder to the next question, a real reply is this
	// turn's answer. A synthetic send-time `m` is not in the array (indexOf -1);
	// nothing has merged yet then, so this correctly finds nothing.
	//
	// A ROW TAGGED WITH ANOTHER TURN IS THAT TURN'S WHEREVER IT STANDS (HATE-3, as
	// `turnSpan`). A cut-in re-sent as the next turn is pushed while the turn before it
	// is still settling, and a merge orders by `ts`: that turn's answer, stamped by its
	// runner a moment later, sorted below this placeholder and was taken for this turn's.
	// The placeholder was dropped, the watch ended before the runner ran, and the reply
	// it then sent was never read.
	var i = msgs.indexOf(m);
	if (i < 0) return false;
	for (var j = i + 1; j < msgs.length; j++) {
		var mm = msgs[j];
		if (mm.role === 'user' && !mm.interject) break;		// the next turn began
		if (mm.iturn && String(mm.iturn) !== String(m.iturn)) continue;	// another turn's row
		if (mm.role === 'assistant' && !mm.interrupted && !mm.provisional && mm.content && mm.content.trim()) return true;
	}
	return false;
}

/// The device a dispatched placeholder names while it waits: the lease HOLDER
/// once a peer has claimed it, else the target this device dispatched TO (stored
/// on the placeholder at dispatch, before any lease exists), so the tile can say
/// "Handed off to argonaut" from the first instant rather than "…to a device".
export function handoffTargetLabel(m) {
	try {
		var holder = (window.DaimondLease && DaimondLease.holder) ? DaimondLease.holder(m.iturn) : null;
		// THIS DEVICE'S OWN CLAIM IS ITS FALLBACK, NOT THE TARGET (UNBLOCK-1 DISPATCH-FAIL):
		// read while a local run held the lease, the answer's provenance said "Ran here --
		// hand-off to <this device> didn't finish".
		if (holder && String(holder) !== String(selfDeviceId())) { var hn = deviceLabelFor(holder); if (hn) return hn; }
	} catch (e) { /* presence/lease not up */ }
	// A turn handed TO this device names no target from here: run here, it reached its
	// runner, so "hand-off to <this device>" is never its provenance (rig busy3, r567bs).
	if (m.toDevice && String(m.toDevice) === String(selfDeviceId() || '')) return '';
	if (m.toName) return String(m.toName);
	if (m.toDevice) { var dn = deviceLabelFor(m.toDevice); if (dn) return dn; }
	return '';
}

/// Is the hand-off tile drawn for the placeholder `m` in a state it is no longer in?
/// A tile that was never drawn (a turn already done, or its answer present) cannot
/// have moved.
function handoffTileMoved(m) {
	var tile = chatOutput && chatOutput.querySelector('.chat-msg-handoff[data-handoff-turn="'
		+ cssEsc(String(m.iturn || '')) + '"]');
	return !!tile && tile.dataset.handoffState !== peerUiStateFor(m);
}

/// The name to put on the LIVE hand-off tile header -- the device that has ACTUALLY
/// CLAIMED the turn (holds a live lease), or '' when none has. Unlike
/// `handoffTargetLabel` it does NOT fall back to the chosen/guessed target: a tile
/// must not say "Handed off to gilgamesh" while gilgamesh has taken no lease and may
/// never run it (owner report 2026-09-06). Until a real claim the header stays generic
/// and the footer says "Sent to your other devices".
function handoffClaimLabel(m) {
	var holder = turnRunnerId(m && m.iturn);
	return holder ? deviceLabelFor(holder) : '';
}

/// The name the footer gives runner `id`: a peer's from its presence beat ('' reads
/// generic), this device's from the roster. This device has no beat of its own, so
/// it read '' while the turn ran here: "Another device is picking this up"
/// (UNBLOCK-1 DISPATCH-FAIL).
function runnerLabel(id) {
	if (!id) return '';
	try {
		if (String(id) === String(selfDeviceId() || '')) return deviceLabelFor(id);
		return (window.DaimondPresence && DaimondPresence.name) ? (DaimondPresence.name(id) || '') : '';
	} catch (e) { return ''; }
}

/// Is a hand-off tile in display state `st` the state of a turn still running? Done,
/// failed and interrupted are how a turn ended, not how it is going.
function handoffLive(st) {
	return st !== 'done' && st !== 'failed' && st !== 'interrupted' && st !== 'ending' && st !== 'not-dispatched';
}

/// Draw a turn HANDED TO A PEER as its own hand-off tile, live for the whole
/// wait: a header naming the device, a spinner and the §5 status/control in the
/// body. This is what a handed-off turn looks like in the flow from the moment
/// it leaves this device until its answer syncs back — the tile the owner asked
/// for, with the in-progress spinner that was missing (owner review 2026-09-05).
///
/// `m` is the dispatched placeholder (or, at send time, a synthetic stand-in
/// carrying the same fields). Nothing is drawn once the answer has merged: the
/// merged reply draws its own quiet "Handed off to <device>" provenance tile
/// (see `appendHandoff`), and a spinning tile beside a finished answer would lie.
function appendDispatchedTile(m) {
	var st = peerUiStateFor(m);
	if (st === 'done') return;			// the merged answer draws itself
	// The answer may already be in the transcript while the placeholder still
	// stands (the parcel synced back before its report was collected): treat that
	// as done here too, so the spinner does not linger beside the reply.
	try { if (pg.current && dispatchedAnswerPresent(pg.current, m)) return; } catch (e) { /* draw it */ }
	// Name the runner ONLY once a real lease claim exists; until then the header is
	// generic and the footer carries "Sent to your other devices" (owner 2026-09-06).
	// The header names the CLAIMANT once a real lease exists ("Handed off to X"),
	// else the CHOSEN target tentatively ("Sending to X…") -- present-progressive, an
	// intention not a claim, so seq 217's honesty holds. Generic only when no target.
	var dl   = handoffClaimLabel(m);				// the real lease holder, or ''
	var tgt  = (dl || st === 'ending') ? '' : handoffTargetLabel(m);	// the chosen target, pre-claim
	var line = dl  ? tOr('chat.ran_on', 'Ran on {name}', { name: dl })
		: tgt ? t('turn.peer_sending_named', { name: tgt })
		:       tOr('chat.who_handoff', 'Hand-off');
	// ONE STATUS LINE WHILE IT RUNS, as a Here turn has (owner, Nancy run: "the double
	// "argonaut is on it", "argonaut is doing this" are redundant"). The footer's dots
	// and line carry every live state, so a live tile draws no header; a turn that
	// ended keeps it, over the footer that says how.
	var tile = buildTile('handoff', { expanded: true, who: line, ts: m.ts, head: !handoffLive(st) });
	tile.classList.add('chat-msg-handoff');
	// The turn this tile is for, and the state it was drawn in (`handoffTileMoved`).
	tile.dataset.handoffTurn = String(m.iturn || '');
	tile.dataset.handoffState = st;
	var foot = document.createElement('div');
	foot.className = 'turn-interrupted ti-handoff';
	renderDispatchedFooter(foot, m);
	tile._body.appendChild(foot);
	// CHROME ONLY (owner standing rule 2026-09-18). The hand-off tile is now the
	// header, spinner and footer -- transient chrome. The turn's answer is not drawn
	// here: it STREAMS into its own real transcript tiles as provisional messages
	// (`onProgressFrame` -> `applyProvisional`), which grow like a live local turn and
	// are never discarded. The flattened `.handoff-stream` text view this once held
	// was exactly the interim view that filled and was then lost.
	// WHAT HAPPENED TO THE SEAT, under the status, which the footer cannot say: a
	// refused hand-off, and a turn that found nobody and is running on this phone,
	// which needs the screen kept open.
	var note = seatTileNote(m, st);
	if (note) {
		var nd = document.createElement('div');
		nd.className = 'seat-note' + (note.warn ? ' seat-warn' : '');
		nd.textContent = note.text;
		if (note.why) nd.title = note.why;
		tile._body.appendChild(nd);
	}
	drawHandoffWorkers(tile, m.iturn);
	tagTurn(tile);
	// It is the running turn's state, so it stands last while the turn is live
	// (UNBLOCK-6), and awaits the reader while the runner is blocked on a question or
	// a consent. Settled, or its answer in, it goes back to the head of its turn.
	tile._progress = true;
	tile._awaits = function () {
		if (blockerFor(m.iturn)) return true;
		if (!handoffLive(peerUiStateFor(m))) return false;
		try { return !(pg.current && dispatchedAnswerPresent(pg.current, m)); } catch (e) { return true; }
	};
	postToChat(tile);
}

/// The seat's own line on a dispatched tile, or null when there is nothing to add.
///
/// A turn that reached NOBODY
/// (`no-peer-awake`) on a MOBILE device is the loud case: it is about to run here, and
/// here is the device that cannot be backgrounded without stalling it.
function seatTileNote(m, st) {
	if (!m) return null;
	// REFUSED (S-HAND #6). The relay turned the errand away (a 413, or a prompt larger
	// than the door), so it never reached a peer and the turn is running HERE. Said out
	// loud rather than left as a silent local run, with the status on the tooltip. A
	// re-dispatch clears `refused` (markTurnDispatched), so this shows only while the
	// refusal stands. A refusal the turn then ran here for is said once, on the
	// person's own message (`seatNote`), which outlives this tile.
	if (m.refused && !m.refused.noted) {
		return { text: t('seat.refused', { name: seatNameOf(m.toDevice, m.toName) }),
			why: String(m.refused.why || ''), warn: true };
	}
	if (st === 'no-peer-awake' && isMobileDeviceSelf()) {
		var plan = seatPlanNow();
		var why  = seatReason((plan && plan.why === 'runner-silent')
			? { k: 'runner_silent',
				vars: { name: (plan.runnerId && deviceLabelFor(plan.runnerId)) || t('devices.unknown') } }
			: { k: 'no_desktop' }).why;
		// One clause on the tile, the reason on its tooltip -- the seat switch's rule.
		return { text: t('seat.tile_local_mobile'), why: why, warn: true };
	}
	return null;
}

export function install() { // page-split: install
	// page-split: install 79

	// ── Chat rendering ─────────────────────────────────────────
	/* var */ pg.curAsstDiv = null;
	/* var */ pg.curAsstText = '';
	// page-split: install 80

	// ── Turns ──────────────────────────────────────────────────
	//
	// A turn is one thing you asked and everything that came back from it: the answer, and any
	// tool steps along the way. The thread is a flat list of messages, so the grouping is carried
	// as a number on each node -- every output written after a question belongs to that question,
	// until the next one. That number is what lets an answer be folded away behind the thing that
	// prompted it, and what lets a selected few turns be folded into a Diamond.
	/* var */ pg._turn = 0;
	// The drawing state each turn started from, by turn number: what `redrawFromTurn` puts back
	// to draw a changed turn again without the turns above it (UNBLOCK-47).
	/* var */ pg._turnMarks = [];

	// Where the walk back through the questions has got to. -1 means "at the bottom, not walking",
	// so the next jump lands on the most recent question.
	/* var */ pg._jumpAt = -1;
	// page-split: install 81

	// Bound once the DOM is up (see the chat header wiring).
	/* var */ pg.collapseBtn = null;     // the − that collapses the thread and latches select mode
	/* var */ pg.selectTools = null;     // Select all / Deselect all / Fold selected, shown only in select mode
	// page-split: install 82

	// The calendar changed, here or on another device (D-20261006-34): every tile time on
	// screen is drawn again, and so is the Diamond page, whose frame was given the calendar
	// it was made with.
	window.addEventListener('daimond:calendar', function () {
		try { document.querySelectorAll('.ctile-time[data-ts]').forEach(paintTileTime); } catch (e) { /* no transcript */ }
		try {
			if (pg.centreMode === 'focus' && crystalShown.sig !== null && pg.currentDiamond && pg.currentDiamond.id === crystalShown.id) renderCrystal();
		} catch (e) { /* no crystal up */ }
	});

	// AN ICON CHANGED, here or on another device (D-20261015-13): the rail and the panel
	// head draw it again. And the head follows its title, which a dozen paths set, so it
	// watches the title rather than each of them.
	window.addEventListener('daimond:avatars', function () {
		try { renderDiamondList(); } catch (e) { /* not built yet */ }
		try { renderSessionList(); } catch (e) { /* not built yet */ }
		try { paintHeadAvatar(); } catch (e) { /* no head yet */ }
	});
	(function () {
		var el = document.getElementById('current-session-name');
		if (!el || typeof MutationObserver === 'undefined') return;
		new MutationObserver(function () { try { paintHeadAvatar(); } catch (e) { /* no head yet */ } })
			.observe(el, { childList: true, characterData: true, subtree: true });
	})();
	// page-split: install 83

	/// Draw the app's own edit of the conversation, where it happened.
	///
	/// Not a tool row: a fold is something Daimond did, not something the model
	/// called, and it is lossy. A user who is not shown one has no way to tell a
	/// model that forgot from a model that never knew.
	/// The thinking tile now being filled, if a round is reasoning.
	///
	/// A round's working arrives in HUNDREDS of pieces -- 1,378 chunks in one measured
	/// DeepSeek round -- and one tile each would be four hundred disclosures for one
	/// thought. So consecutive deltas grow the tile already open, and anything else
	/// reaching the thread closes it off (`postToChat`, the single door every render
	/// path goes through).
	/* var */ pg.liveThink = null;

	/// The turn a hand-off tile has already been drawn for, so a turn that a peer
	/// ran gets ONE hand-off tile however many answer segments it merges. Reset in
	/// `clearChat` with the rest of the per-thread state.
	/* var */ pg._handoffTurn = -1;
	// page-split: install 84

	/* var */ _contBtn = null;			// the Continue button on screen, if any
	// page-split: install 85

	/* var */ pg.lastToolBlock = null;
	// page-split: install 86


	// ── A question the model put, answered with one tap ─────────
	//
	// THE ONE THING A MODEL COULD NOT DO. It could write a question in prose and
	// stop, which is a question answered by TYPING, and a decision answered by
	// typing is a decision put off. `ask` (src/tools.rs) is the tool; this is the
	// card.
	//
	// DRAWN FROM THE CALL'S OWN ARGUMENTS, which is what makes it work on both
	// paths for free -- the live turn and a reload both arrive here through
	// `renderToolCall`, exactly as `renderSaid` does for a stored fold. It is
	// also the whole of the durability story: the buttons need NOTHING left over
	// from the turn that asked, because answering is only sending a message. So
	// a question survives an hour, a reload and a closed tab, and there is
	// nothing to expire -- which is the opposite of `parkConsent`, whose tiles
	// hold a `resolve` in memory and are marked expired when the page comes back.
	//
	// THE SHAPE IS CHECKED HERE AS WELL AS IN RUST, and not out of distrust: the
	// card is drawn from the ToolCall event, which fires BEFORE `ask_step` has
	// seen the arguments. A malformed question would otherwise flash on screen
	// and be taken away again. What Rust refuses that this cannot see -- a second
	// question in one turn, a dispatched worker -- is caught by `renderToolResult`
	// taking the card down when the outcome is not `done`.

	/// The card most recently drawn, so a refused call can take it away again and
	/// so a reload can mark one that was already answered.
	/* var */ pg._askCard = null;

	/// Set by `renderToolCall` when the call it drew was a question, so its RESULT
	/// -- a sentence written for the model about what it just did -- is not drawn
	/// underneath the card.
	/* var */ pg._askJust = false;
	// page-split: install 87

	/// The question card's whole surface to the engine: `window.DaimondAsk`.
	///
	/// It draws nothing. `renderToolCall` has already drawn the card by the time
	/// this is called, on the ToolCall event that precedes the dispatch -- so what
	/// is left for this to do is the one thing Rust cannot find out for itself:
	/// whether the question is on a screen: this page's own paint, or a
	/// runner's lease blocker that every device reads. A native build paints none, and
	/// so does a page served from a bundle older than this one; both must fail
	/// LOUDLY, or the model tells the user it has asked a question that nobody
	/// can see.
	///
	/// It does not wait for the answer and holds nothing. See src/wasm/ask.rs.
	window.DaimondAsk = {
		put: function (payload) {
			var o = null;
			try { o = JSON.parse(String(payload || '{}')); } catch (e) { o = null; }
			// A QUESTION ASKED ON A RUNNER GOES TO EVERY DEVICE (owner ruling
			// 2026-09-12). The card is drawn here by `renderToolCall` -- on the RUNNER's
			// own page, where nobody is -- and until the turn ends and the transcript
			// syncs back, the originating device has nothing but a spinner: a question
			// it cannot see is a hanging turn. So a runner also writes the question onto
			// the lease as an `ask` blocker carrying its options, which every device
			// reads off the door it already pulls. THE RUNNER'S OWN CARD STAYS: this adds
			// a copy, it does not move the question.
			broadcastAskIfHandedOff(o);
			// Answered from the PAINT and not from the shape: an ack that says
			// the question is on the user's screen must mean a card is on A
			// screen. `renderToolCall` painted this call's card on the ToolCall
			// event -- the events strictly alternate, so `_askJust` is this
			// call's and no other's -- and a page that painted nothing says so:
			// the wasm edge (src/wasm/ask.rs) then refuses, the turn does not
			// end, and the model asks in prose instead of waiting on an answer
			// nobody can see. Until 2026-09-12 this answered from the payload's
			// shape, so an ask made from the crystal face -- where
			// `renderToolCall` is gated on `onScreen()` and nothing painted --
			// still acked success and the turn ended as Done (turn 47).
			//
			// THE RUNNER IS THE ONE EXCEPTION: its own page painted nothing (the
			// errand it grabbed is not the thread it is showing), but the
			// broadcast above just wrote the question onto the lease as a blocker
			// every device reads off its door -- so the question IS on a screen,
			// and `handed` uses the broadcast's own predicate so the two can
			// never disagree.
			var handed = !!(o && askDrawable(o) && activeRunnerTurn());
			var drawn = handed || (pg._askJust && !!pg._askCard);
			return Promise.resolve(JSON.stringify(drawn ? { drawn: true } : { drawn: false, reason: askUnseenWhy(o) }));
		},
	};
	// page-split: install 88

	/// Set by `renderToolCall` when the call it just drew was a fold, so its RESULT -- which is a
	/// sentence written for the model about what it just did -- is not drawn under the answer.
	/* var */ _saidJust = false;
} // page-split: end install

export function install_2() { // page-split: install
	// page-split: install 89

	// The identity-and-shape signature of every message the thread currently holds, in
	// draw order, so a re-render can tell an APPEND (the same chat with turns added on the
	// end) from a rebuild (a switch, an edit, a middle insertion). See renderHistory: when
	// only the tail is new, the tail alone is drawn onto the tiles already standing rather
	// than the whole transcript being cleared and rebuilt -- which for a chat of thousands
	// of turns is the difference between redrawing one tile and redrawing thousands on
	// every store-change nonce. See `_renderedSigs`.
	/* var */ pg._renderedSigs = [];
	// page-split: install 90

	// Whether the thread on screen is exactly what `renderHistory` last drew -- so the
	// append fast path, which draws only the new tail, can trust the tiles beneath it.
	// A live turn, a streamed answer or an external `clearChat` reaches the thread
	// without `renderHistory` and turns this off; the next full render turns it back on.
	/* var */ pg._renderSynced = false;
	// page-split: install 91

	// Activity drawn below a reader who has scrolled up: the end button wears a mark until he is
	// back at the end, rather than the thread being pulled down under him.
	/* var */ _endNews = false;
	// page-split: install 92
	try {
		if (chatOutput && chatOutput.addEventListener) {
			chatOutput.addEventListener('scroll', function () {
				_wasAtEnd = nearBottom();
				syncJumps();
				if (chatOutput.scrollTop === _selfTop) return;
				_lastScrollAt = Date.now();
			}, { passive: true });
		}
	} catch (e) { /* no thread element in this context */ }

	// A READER AT THE LIVE END STAYS THERE WHEN THE THREAD'S BOX CHANGES SIZE.
	//
	// `#chat-output` is the flexible row of the chat panel, so anything else in that
	// column taking or giving back height resizes it -- and the two that do so on a
	// SYNC are the seat switch by the composer, which appears and disappears on a
	// presence beat, and the composer itself when its text is reseeded. A scroll
	// container keeps its `scrollTop` when it shrinks, so a reader who was at the live
	// end is left above it by exactly the height that arrived: measured at 25px for the
	// seat switch, on a pull that changed nothing in the chat. A reader scrolled UP is not
	// moved by this and is deliberately left alone.
	try {
		if (window.ResizeObserver && chatOutput) {
			new ResizeObserver(function () {
				syncJumps();
				if (_wasAtEnd) setScrollTop(chatOutput.scrollHeight);
			}).observe(chatOutput);
		}
	} catch (e) { /* no ResizeObserver: the thread keeps the behaviour it had */ }
} // page-split: end install
