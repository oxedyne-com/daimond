// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
// page-split: end imports
export let appEl, sessionList, newSessionBtn, chatOutput, chatInput, chatSend, sessionNameEl,
	brandLogo, aiMeter, agentsList, agentsGrid, agentTagf, agentsCount, diamondList, diamondFilter,
	diamondSearch, agentSearch, agentFilter, newDiamondBtn, crystalView, crystalBody, crystalControls,
	chatOutputEl, chatInputBar; // page-split: hoisted
// page-split: ctx
/// Every page binding that one module writes and another reads.
export const pg = {
	_askCard: undefined,
	_askJust: undefined,
	_chunkedWhole: undefined,
	_diamondMeter: undefined,
	_docPdf: undefined,
	_handoffTurn: undefined,
	_histList: undefined,
	_jumpAt: undefined,
	_lastDiamondSig: undefined,
	_pdfUrl: undefined,
	_presenceAnswered: undefined,
	_recovering: undefined,
	_renderSynced: undefined,
	_renderedSigs: undefined,
	_syncedWhileHidden: undefined,
	_tileDlgSeq: undefined,
	_turn: undefined,
	_turnMarks: undefined,
	_unloading: undefined,
	_walkPlanCache: undefined,
	agentChatFilter: undefined,
	agentDiamondFilter: undefined,
	agentLens: undefined,
	agentPins: undefined,
	agentQuery: undefined,
	agentTagFilter: undefined,
	agentTagPoolOpen: undefined,
	arteDaimonOpen: undefined,
	centreMode: undefined,
	cfg: undefined,
	chats: undefined,
	chatsUp: undefined,
	collapseBtn: undefined,
	curAsstDiv: undefined,
	curAsstText: undefined,
	curContent: undefined,
	curFile: undefined,
	current: undefined,
	currentDiamond: undefined,
	diamondQuery: undefined,
	diamonds: undefined,
	docRelabel: undefined,
	editing: undefined,
	lastHold: undefined,
	lastToolBlock: undefined,
	linkFor: undefined,
	linkForm: undefined,
	linkNotes: undefined,
	linkPaint: undefined,
	liveThink: undefined,
	locked: undefined,
	openMs: undefined,
	openSaid: undefined,
	packingParcel: undefined,
	pvFile: undefined,
	pvStore: undefined,
	runnerReady: undefined,
	selectTools: undefined,
	sendCtl: undefined,
	storeFile: undefined,
	syncRoomLast: undefined,
	tagExc: undefined,
	tagInc: undefined,
	tagMode: undefined,
	tagPoolOpen: undefined,
};
// page-split: end ctx
// page-split: install 1

// Persist chats (minus the non-serialisable DaimondApp) so they survive a
// reload; the app is rebuilt lazily by ensureApp on the next turn.
//
// Two tabs share one localStorage, and each holds its own in-memory
// `chats` array. Writing that array wholesale means the last tab to
// save silently destroys every chat the other one created. So a save
// MERGES: it reads what is stored, takes the newer of each chat by id,
// keeps chats it has never heard of, and honours tombstones for the
// ones this tab deleted on purpose.
export var CHATS_KEY = 'daimond-chats';
export var TOMBS_KEY = 'daimond-chats-deleted';
// Diamonds live in OPFS, which fires no event when another tab writes to it,
// so two windows of the same account went on showing two different rails for
// ever -- a Diamond made in one was invisible in the other, and re-making it
// there looked like nothing happening. localStorage DOES fire across tabs, so
// a nonce bumped on every Diamond mutation is the signal OPFS does not give:
// the value means nothing, the CHANGE is the whole message.
export var DIAMONDS_KEY = 'daimond-diamonds-rev';
// Diamonds deleted on purpose, by id. A Diamond lives in OPFS, and the sync
// merge carries what the store HAS -- so a Diamond deleted here and still
// present on the other device would simply be handed back on the next pull,
// for ever. A tombstone is how a deletion survives that, exactly as it does
// for chats.
export var DIAMOND_TOMBS_KEY = 'daimond-diamond-tombs';
export var MSG_TOMBS_KEY = 'daimond-msgs-deleted';   // individual messages removed (a continued interrupted turn)

// ── Diamonds state ─────────────────────────────────────────────
/// The toolchains this build can grant, in the order they are offered.
///
/// At the top level since E1: the Workspace panel draws them and the consent door names
/// them when a command first needs one.
///
/// The same five names `Toolkit::all` gives, and they are names rather than labels
/// because the name is what is STORED and what reaches `Toolkit::parse`. The label is
/// only ever how it is written on a button.
///
/// `remote` is NOT here and must not be added back. A Terminal's ssh is a posture the
/// user sets on the COMPUTER -- `hand/install/install.sh --remote`, which makes the
/// key and writes the wrapper -- and the hand reports it in `hello` as `remote:ready`.
/// It was a per-Diamond chip until 2026-08-26 and the owner's objection to that is
/// `dev/BLOCKERS.md` B12: a Terminal is not tied to a Diamond, so neither is what one
/// may reach. There is nothing to press here because there is nothing per Diamond to
/// decide.
export var KITS = [
	{ name: 'rust',   label: 'Rust' },
	{ name: 'node',   label: 'Node' },
	{ name: 'python', label: 'Python' },
	{ name: 'go',     label: 'Go' },
	// Not cosmetic, and the odd one out: `git` itself is already reachable, so
	// what this grants is the user's own configuration -- their name, their
	// email, and `core.hooksPath`. Without it a fenced git runs with NO hooks,
	// and an unreadable hooks directory is indistinguishable from an empty one,
	// so the credential-scanning pre-commit hook silently does not run.
	{ name: 'git',    label: 'Git' },
];

// TOOLCHAIN ASKS NOT GRANTED (Workspace round 2, E3; spec §3.3): a question answered
// "Not now", or that nobody answered, is kept per Diamond on this device and never
// synced, since a grant is a press on a device. It is drawn as a ghost the user can
// press later to grant. Kept here is only the question: the engine still asks afresh
// next time, so a no never stands as a refusal (N2).
var KITS_WAITING_KEY = 'daimond-kits-waiting';	// per account, by accounts.js

function kitsWaitingAll() {
	try {
		var m = JSON.parse(localStorage.getItem(KITS_WAITING_KEY) || '{}');
		return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
	} catch (e) { return {}; }
}

/// The toolchains asked for `diamondId` that nobody answered, by name.
function kitsWaiting(diamondId) {
	var l = kitsWaitingAll()[diamondId];
	return (Array.isArray(l) ? l : []).filter(function (n) {
		return KITS.some(function (k) { return k.name === n; });
	});
}

/// The toolchains waiting for `d` that it does not hold: what a ghost is drawn for.
/// The one reader the drawing uses, so a renderer that moves takes nothing else with it.
export function kitsAwaiting(d) {
	if (!d) return [];
	var on = Array.isArray(d.toolkits) ? d.toolkits : [];
	return kitsWaiting(d.id).filter(function (n) { return on.indexOf(n) < 0; });
}

/// Add (`on`) or take off toolchains waiting for `diamondId`, and repaint.
export function setKitsWaiting(diamondId, names, on) {
	if (!diamondId || !names.length) return;
	var m = kitsWaitingAll();
	var l = kitsWaiting(diamondId).filter(function (n) { return names.indexOf(n) < 0; });
	if (on) l = l.concat(names);
	if (l.length) m[diamondId] = l; else delete m[diamondId];
	try { localStorage.setItem(KITS_WAITING_KEY, JSON.stringify(m)); } catch (e) { /* drawn without it */ }
	document.dispatchEvent(new CustomEvent('daimond-kits-waiting'));
}
// page-split: install 2
// WHAT THE CENTRE IS SHOWING, and the ONLY three values `centreMode` ever
// holds. `showCentre` is the only thing that writes it, and it refuses a
// fourth; `dev/verify_daimonface.mjs` reads this very list and checks that
// nothing in the file compares against a value missing from it, and that
// nothing in the list is a face no call ever enters.
//
// THIS LIST EXISTS BECAUSE ITS PREDECESSOR WAS A COMMENT, AND THE COMMENT WAS
// WRONG. It read `'chat' | 'focus'` for as long as a Diamond has had two
// faces, while `selectDiamond` had been entering `'daimon'` all along. Three
// guards that read `centreMode === 'daimon'` were therefore taken for dead
// branches -- a real feature apiece, none of which had supposedly ever run --
// and a night's work was spent about to make three of them live at once. They
// were live. The comment was not.
export var CENTRE_FACES = ['chat', 'focus', 'daimon'];
// page-split: install 3

/// Is THIS conversation the one the Centre is drawing?
///
/// Two questions, and both have to be asked, which is why they are asked in
/// one place. `current` says WHICH conversation the thread is drawing;
/// `centreMode` says whether the thread is what the Centre is showing at all
/// — a Diamond has two faces, and the crystal face draws no conversation even
/// though the composer beneath it talks to one. A daimon turn can also run
/// with its Diamond nowhere near the screen, from a gather round or a
/// triggered action, and drawing then would paint one Diamond's words into
/// another's transcript.
///
/// Three sites asked this in three slightly different ways. Three copies of a
/// subtle condition is how one of them drifts, and it is also how all three
/// came to be misread at once: one name, asked the same way everywhere.
///
/// # Arguments
/// * `rec` - A chat record, or nothing.
///
/// # Returns
/// True only when `rec`'s thread is the one on screen.
export function daimonOnScreen(rec) {
	return ownOnScreen(rec) && pg.centreMode === 'daimon';
}

/// Is THIS conversation's own place what the Centre is drawing: an ordinary chat's
/// thread, or either face of the Diamond a daimon belongs to? `daimonOnScreen` is
/// this and the conversation face besides, so the two cannot drift apart.
function ownOnScreen(rec) {
	if (!rec || !pg.current || pg.current.id !== rec.id) return false;
	return rec.diamondId ? (pg.centreMode === 'daimon' || pg.centreMode === 'focus') : pg.centreMode === 'chat';
}

/// Why `rec`'s own place is not what the person sees, in the daimon's language, or
/// '' when it is and the app is on screen. `askUnseenWhy` and capture's fence both
/// answer from this, so a question and a picture are refused for the same reasons.
///
/// # Arguments
/// * `rec` - A chat record, or nothing.
/// * `face` - Whether the conversation face itself is needed (a question), or any
///   face of the Diamond will do (a picture of the screen).
export function unseenWhy(rec, face) {
	if (document.visibilityState === 'hidden') return 'the app is not on screen at all';
	if (face ? daimonOnScreen(rec) : ownOnScreen(rec)) return '';
	var other = pg.centreMode === 'focus' ? 'a Diamond\'s page (its crystal face)' : 'another conversation';
	return 'the person is looking at ' + other + ', not at yours';
}

/// The conversation the person has open, as a turn's keeper names it: a Diamond's id
/// (either face), `chat:<id>` for an ordinary chat, or '' for none.
export function convKey() {
	if (pg.currentDiamond) return pg.currentDiamond.id;
	return pg.current ? (pg.current.diamondId || 'chat:' + pg.current.id) : '';
}

/// Mark a panel as showing what the open conversation put in it (CAPTURE-FENCE QA A F1,
/// 2026-10-12): the Doc and Preview panels belong to the conversation they were filled in.
/// `who` names the conversation whose turn filled it, when a turn did (`file_show`).
export function ownPanel(name, who) {
	var el = document.getElementById('panel-' + name);
	if (el) el.setAttribute('data-owner', who || convKey());
}
// page-split: install 4
// ── Which Diamonds are working ─────────────────────────────
//
// ONE BOOLEAN FOR THE WHOLE APP UNTIL 2026-08-28, and that is the whole of
// tester note 14: *"when I have a daimon in-progress and then prompt a different
// daimon, the new prompt is queued, apparently waiting for the other daimon to
// finish"*. It was, and nothing about the queueing was deliberate. There is no
// governor behind it -- `www/js/governor.js` gates the SIZE of a fan-out and
// nothing else -- and no engine limit: `steer_crystal` composes a fresh `Agent`,
// a fresh `ToolRegistry` and a LOCAL `Session` per call (`src/wasm/app.rs`), so
// two Diamonds sharing one `DaimondApp` can be steered at once. Ordinary chats
// have run concurrently all along, gated per record by `_generating`; the
// daimons were serialised only because one flag stood in for N.
//
// What IS deliberate, and stays, is exclusion per Diamond: a steer and a fold
// both write that Diamond's `crystal.json`, and two writers on one crystal lose
// each other's edits. So the flag became a set, keyed by the Diamond the turn
// belongs to.
export var crystalRunning = Object.create(null);   // diamondId -> true while a steer or fold runs
export var _diamondIdle = Object.create(null);     // diamondId -> wakers of retries waiting on its turn (`awaitDiamondIdle`)
export var _steerApp = Object.create(null);        // diamondId -> the app its steer runs on, while it runs (UNBLOCK-27 R7)
export var _steerDetached = Object.create(null);   // diamondId -> true while that steer is another device's turn (r578)
export var _saidThere = Object.create(null);       // turnId -> [{ chatId, mid, text }] said to its runner, until its report (UNBLOCK-27 R7)

/// Is THIS Diamond mid-turn? Asked of an id rather than of the app, which is the
/// distinction the single flag could not make.
export function diamondBusy(id) { return !!(id && crystalRunning[id]); }

/// Is ANY turn keeping into this Diamond's store running: a steer or a fold, or its
/// own thread's turn (a Continue, Run here, Re-run)? What a Restore is refused on
/// (R5 of the release 5.1 fix's QA, 2026-09-25). A thread's turn is not a steer, so
/// `diamondBusy` let a Restore run under one, and the thread's turn end then recorded
/// its rows over the restore's. The engine ends such a turn's run on every file a
/// restore changes, so the History stays true either way; this keeps the two from
/// meeting at all where the page can see them.
export function diamondTurning(id) {
	if (diamondBusy(id)) return true;
	return !!id && pg.chats.some(function (c) { return c && c.diamondId === id && c._generating; });
}

/// Is any Diamond at all working? Only for the readers that really mean "the app
/// is spending money somewhere" -- never for deciding whether a turn may start.
export function anyCrystalBusy() {
	for (var k in crystalRunning) { if (crystalRunning[k]) return true; }
	return false;
}
export var TAG_CHIPS_SHOWN = 3;    // chips on a Diamond box before the +N overflow
// page-split: install 5
export var TAG_MODE_KEY = 'daimond-tag-mode';
// The pool of chips is worth a row of the rail, not four. Standing, a real
// vocabulary of thirty tags sat three and a half rows deep under the search
// box on every screen, filtering or not, and the two lists below live on what
// the furniture leaves. Hidden outright it would be missed -- it was read as
// absent twice. So it sits behind one row that NAMES it and COUNTS it, and
// that row is always there. Which way it was left is a habit of working, like
// the mode above it, and is kept; closed is where it starts.
export var TAG_POOL_KEY = 'daimond-tag-pool-open';

// Diamond-to-Diamond links: the relations a Diamond has with the other
// Diamonds, as against the files and pages the artefact strip holds. Three
// words are offered as a nudge for an empty section; the store knows none of
// them and holds no relation to be special, exactly as it is for tags.
export var DEFAULT_REL_SUGGESTIONS = ['part-of', 'relates-to', 'derives-from'];
export var REL_MAX = 32;           // what the store caps a relation at
// page-split: install 6
export var chatStop      = null; // removed (proposal #19): the second ■ beside the arrow
// Send's arrow, drawn rather than typed: `➤` sat off the button's centre in
// most faces and in none of them matched the stroke of the icons beside it.
export var SEND_ARROW    = '<svg class="ic send-arrow" viewBox="0 -2 24 24" aria-hidden="true"><path d="M12 16V4M8 8l4-4 4 4"/></svg>';
// page-split: install 7
// The grid's lens (think pass §2): State, Cost, Rating or Device. Remembered, since
// it is a way of looking a person keeps rather than a filter on one moment.
export var AGENT_LENS_KEY = 'daimond-agent-lens';
// page-split: install 8

export function install() { // page-split: install
	// page-split: install 1

	// ── State ──────────────────────────────────────────────────
	/* var */ pg.chats = [];             // { id, name, app, messages:[{role,content}], promptTokens, completionTokens }
	/* var */ pg.chatsUp = false;        // the boot's chat load has returned (`migrateInherit` waits on it)
	/* var */ pg.current = null;         // active chat object: changed only by `setCurrent`
	/* var */ pg._unloading = false;     // the page is on its way out — an aborted request is not a failure
} // page-split: end install

export function install_2() { // page-split: install
	// page-split: install 2

	/* var */ pg.diamonds = [];              // [{ id, name, crystal_version, updated, tags }]
	/* var */ pg.currentDiamond = null;    // selected Diamond meta, or null
	// page-split: install 3
	//   'chat'   — an ordinary chat's thread.
	//   'focus'  — a Diamond's crystal, which draws no conversation.
	//   'daimon' — a Diamond's own conversation, in the chat's thread and composer.
	/* var */ pg.centreMode = 'chat';    // one of CENTRE_FACES; written only by showCentre
	// page-split: install 4

	/// The fence on a picture of the screen (FIRE-B QA F1, 2026-10-12): it draws only while
	/// the asking conversation's own place is on screen and the app is visible -- a turn left
	/// running while the person opened another Diamond photographed THAT one into its own
	/// folder. `owner` is the turn's keeper: a Diamond's id, or `chat:<id>`.
	///
	/// Every VIEW has an owner too (CAPTURE-FENCE QA A, rc-b rulings, 2026-10-12). The centre is
	/// the open conversation's; a file panel is the conversation's it was filled in (`ownPanel`);
	/// a rail row is its own Diamond's or chat's; the rest (Web, the Guide) is app chrome. So
	/// `unseen` refuses a named view owned by another conversation, and `foreign` lists what a
	/// picture of the screen or the rail draws empty. A conversation this device holds no record
	/// of is "another conversation" too, as it is on a runner: the person is not looking at it.
	window.DaimondScreen = {
		unseen: function (owner, view) {
			var o = String(owner || '');
			var rec = o.indexOf('chat:') === 0
				? pg.chats.find(function (c) { return c.id === o.slice(5); })
				: pg.chats.find(function (c) { return c.diamondId === o; });
			var why = unseenWhy(rec || null, false);
			if (why) return why;
			var p = /^[a-z][a-z0-9_-]*$/.test(String(view || ''))
				? document.querySelector('.panel[data-panel="' + view + '"][data-owner]') : null;
			return p && p.getAttribute('data-owner') !== o
				? 'the ' + view + ' view shows a file opened in another conversation' : '';
		},
		foreign: function (owner) {
			var o = String(owner || '');
			var out = [];
			document.querySelectorAll('.session-box[data-id]').forEach(function (el) {
				var k = el.classList.contains('diamond-box') ? el.dataset.id : 'chat:' + el.dataset.id;
				if (k !== o) out.push(el);
			});
			document.querySelectorAll('.panel[data-owner]').forEach(function (el) {
				if (el.getAttribute('data-owner') !== o) out.push(el);
			});
			// The Graph draws a box per Diamond with its name: another conversation's pixels,
			// as its rail row is (lead ruling, 2026-10-12). The asking Diamond's own box stays.
			document.querySelectorAll('#panel-graph g.graph-node[data-diamond-id]').forEach(function (el) {
				if (el.getAttribute('data-diamond-id') !== o) out.push(el);
			});
			return out;
		},
	};
	// page-split: install 5
	// The rail's search field (RAIL-SEARCH, D-20261015-11), trimmed and lower-cased.
	// A way of looking like the tag lists below, so it lasts as long as the page.
	/* var */ pg.diamondQuery = '';
	// The rail filters on a small boolean rather than one tag: the tags a Diamond
	// must carry, the tags that hide it, and how two or more of the first combine.
	// A tag sits in one of those two lists or in neither, never both -- the cycle
	// that fills them moves it, and moving is not copying (see `cycleTagFilter`).
	// Both lists are a way of looking rather than a setting, so they last exactly
	// as long as the page does; the mode is a preference, and is kept.
	/* var */ pg.tagInc  = [];           // tags a Diamond must carry to show
	/* var */ pg.tagExc  = [];           // tags that hide a Diamond outright
} // page-split: end install

export function install_3() { // page-split: install
	// page-split: install 6
	// The section's own state lives here rather than in the DOM: the controls are
	// rebuilt whole on every crystal repaint, and a half-typed link form must
	// survive one -- a resize, a steer, a fold -- rather than vanishing with
	// everything typed into it.
	// Whether the section is expanded is the device's (`footOpen('links')`), not this file's.
	/* var */ pg.arteDaimonOpen = false; // the "added by the daimon" group in renderArtefacts; see there
	/* var */ pg._lastDiamondSig = '';   // dedup key for the `ev diamond` debug row; see renderArtefacts
	/* var */ pg.linkForm  = null;       // { target, query, rel, note } while adding, else null
	/* var */ pg.linkNotes = {};         // link id -> its note is expanded
	/* var */ pg.linkFor   = null;       // the Diamond id the three above belong to
	/* var */ pg.linkPaint = 0;          // paint token, so a slow read cannot overwrite a fresh one

	// ── DOM refs ───────────────────────────────────────────────
	/* var */ appEl         = document.getElementById('app');
	/* var */ sessionList   = document.getElementById('session-list');
	/* var */ newSessionBtn = document.getElementById('new-session-btn');
	/* var */ chatOutput    = document.getElementById('chat-output');
	/* var */ chatInput     = document.getElementById('chat-input');
	/* var */ chatSend      = document.getElementById('chat-send');
	/* var */ pg.sendCtl       = null;		// Send, once `bindSend` has built it through the answer rule
	// page-split: install 7
	/* var */ sessionNameEl = document.getElementById('current-session-name');
	// The word logo on the identity gate. It was looked up by `.brand-logo`, a
	// class the markup no longer carries, so the lookup found nothing and the
	// dark-ink/light-ink swap below had been dead for as long as that class was.
	/* var */ brandLogo     = document.getElementById('id-logo');
	/* var */ aiMeter       = document.getElementById('ai-meter');
	/* var */ agentsList    = document.getElementById('agents-list');
	/* var */ agentsGrid    = document.getElementById('agents-grid');
	/* var */ agentTagf     = document.getElementById('agent-tagf');
	// The runs a person pressed in the grid, in the order pressed. The lower half of the
	// panel draws these and nothing else (rulings §15, D-20261015-10): a run is never
	// added here by the app, only by a hand, and leaves when its close cross is pressed
	// or the run itself is cleared away.
	/* var */ pg.agentPins     = [];
	/* var */ pg.agentTagPoolOpen = false;   // the Agents panel's "Filter by tag" disclosure
	// page-split: install 8
	/* var */ pg.agentLens = (function () {
		var v = '';
		try { v = localStorage.getItem(AGENT_LENS_KEY) || ''; } catch (e) { /* no storage */ }
		return DaimondAgentGrid.LENSES.indexOf(v) !== -1 ? v : 'state';
	})();
	/* var */ agentsCount   = document.getElementById('agents-count');
	/* var */ diamondList     = document.getElementById('diamond-list');
	/* var */ diamondFilter   = document.getElementById('diamond-filter');
	/* var */ diamondSearch   = document.getElementById('diamond-search');
	/* var */ agentSearch   = document.getElementById('agent-search');
	/* var */ agentFilter   = document.getElementById('agent-filter');
	/* var */ pg.agentQuery       = '';   // the agents panel search text, lower-cased
	/* var */ pg.agentDiamondFilter = null; // filter agents to one Diamond id, or null
	// A run dispatched from an ordinary chat has no Diamond, so it cannot be
	// filtered by one. Its chip names the conversation, and this is what that
	// chip sets -- a second variable rather than a second meaning for the first,
	// because a chat id and a Diamond id are different keys on the run.
	/* var */ pg.agentChatFilter  = null; // filter agents to one chat id, or null
	/* var */ pg.agentTagFilter   = null; // filter agents to one tag, or null
	/* var */ newDiamondBtn   = document.getElementById('new-diamond-btn');
	/* var */ crystalView     = document.getElementById('crystal-view');
	/* var */ crystalBody     = document.getElementById('crystal-body');
	/* var */ crystalControls = document.getElementById('crystal-controls');
	/* var */ chatOutputEl  = document.getElementById('chat-output');
	/* var */ chatInputBar  = document.querySelector('.chat-input-bar');
} // page-split: end install
