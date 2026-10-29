// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { Wasm, compose_prompt, compose_prompt_for, default_prompt, heap_bytes, readBytes,
	safety_clause } from './wasm.js';
import { DIAMOND_TOMBS_KEY, diamondBusy, pg } from './state.js';
import { appCfgFor, friendlyError, readJson, syncCfgFromModels, t, tn, trail, usdDisplay } from './util.js';
import { bumpDiamonds, nudgeSync, tombMapNow, trashed } from './chatstore.js';
import { confirmHold, sendUserMessage } from './send.js';
import { recordSpend, updateSpend } from './steer.js';
import { Workers, tools } from './workers.js';
import { Files } from './files_view.js';
import { DaimondAdmin } from './admin.js';
import { DaimondPanels, tel } from './layout.js';
import { ratingsAccount } from './rating.js';
import { renderSeatSwitch, seatDrawnRunner } from './sourcemenu.js';
import { commitFold, foldEnvelope } from './links.js';
import { diag, offerRecovery, showIdentity, toast } from './passkey_phrase.js';
import { _parked, changeName, noticeDialog, permitRetry, promptDialog, settleConsent } from './consent.js';
import { turnHold } from './chats.js';
import { changeDiamondModel } from './tilestyle.js';
import { DEFAULT_IDS, Triggers, _daimonApps, _diamondAppModel, _diamondAppProvider, claimDaimon,
	daimonApp, daimonChat, daimonSettled, diamondAppKey, diamondCanRun, diamondEffort, diamondModel,
	everyDiamondClient, loadDiamonds, relTime } from './diamonds.js';
import { renderDiamondList, selectDiamond } from './agentspanel.js';
import { refreshDiamondAfterChange, setCrystalBusy, setCrystalStatus } from './crystal.js';
import { rebuildChatApp } from './marks.js';
import { applyFoldSettings, openSettings } from './settingsui.js';
// page-split: end imports
export let Notes; // page-split: hoisted

// The prompt each kind of agent runs under is the user's, held as a file in
// their workspace (prompts/<role>.md) and read by `Prompts` below. The text
// itself lives in Rust (src/prompts.rs) so there is one definition of what a
// model is really sent -- a copy here would drift from it -- and so the rules
// a user's edit cannot remove travel with every composition.
//
// SYSTEM_PROMPT is what a chat is told, composed from that file plus those
// rules. It is a function, not a constant, because the file can change under
// a running app.
// TAKES THE MODEL, because two of the notes are composed on it. `VERIFY_NOTE` and
// `QUIET_NOTE` were each measured worth their tokens on some models and not on others
// (dev/PROMPT_NOTES.md), and `prompts::measured_spare` drops one only where a measurement
// says so by name. A caller with no model in hand passes nothing and gets every note,
// which is the safe answer: an absent note costs a turn, a needless one costs about a
// hundred tokens.
// `steer` is the steering notes to tell it, one per line, where a chat is built with any (`ensureApp`).
export function SYSTEM_PROMPT(model, steer) { return Prompts.role('chat', model, steer); }

// ── Standing instructions (DAIMOND.md) ─────────────────────
//
// A dispatched worker gets its task and nothing else: it cannot see the
// conversation that dispatched it, it does not know the Diamond's crystal, and it
// does not know the user's house rules. So it starts from zero every time.
//
// `DAIMOND.md` at the workspace root fixes that. A plain file, editable in the
// Workspace panel like anything else, portable with the folder — the same
// idea as a CLAUDE.md. It is prepended to the system prompt of every chat,
// every dispatched worker, the conductor and the reducer.
export var INSTRUCTIONS_FILE = 'DAIMOND.md';
// What the file was called before the app was named Daimond. Kept only so
// that an existing workspace can be carried across; nothing else reads it.
var INSTRUCTIONS_FILE_WAS = 'RED.md';
// ── The file was the mechanism and it started empty ──────────────
//
// `DAIMOND.md` is what makes Daimond know the person using it, and a fresh store held
// none: the chip below was HIDDEN precisely while the file was empty, and the only way
// to make one was to know its exact name and type it into the New file dialog. So the
// app's answer to "does it know me" was a blank nobody could see.
//
// A store that has never held one is given a starter, ONCE, and the flag is what makes
// it once: a user who deletes the file does not get it back, because a file the app
// keeps putting back is exactly the class of snag OBJECTIVES §1 is about.
//
// The TEXT is the wasm's (`prompts::INSTRUCTIONS_SEED`), not this file's, so it can be
// checked natively against the skills the build really carries -- a starter telling the
// user to type a command that would refuse is worse than a starter with nothing in it.
// Asked through the namespace, so a stale `www/pkg` without the export costs the seed
// and not the app.
var INSTRUCTIONS_SEEDED_KEY = 'daimond.instructions.seeded';
export function instructionsSeed() {
	try { return String((Wasm.instructions_seed && Wasm.instructions_seed()) || ''); }
	catch (e) { return ''; }
}
// ── Two layers, because there are two authors ────────────────────
//
// `dev/ROOT_SEPARATION.md` §2.5(d) specifies this and seq 65 deferred it. The
// deferral's reason was that doing it half-way would leave the user's own rules
// surviving a root switch while the agent's prompt silently changed — so it is
// done here, with the role prompts (which move to the same rule below).
//
// * **Yours** lives in Daimond's own store and is always in force. It is who you
//   are and how you like to be worked with, and it does not stop being true
//   because you opened a different folder.
// * **The project's** lives at the root of the folder you have open, and is
//   appended below yours. It is what THIS work needs, it travels with the folder,
//   and it is the file a repository can carry for everyone who opens it.
//
// Yours first, because a project cannot be allowed to quietly overrule how you
// work — and because the later text is the more specific one, which is the order
// a model reads instructions in anyway.
//
// With no folder open the two resolve to the same file and the second read is
// skipped: one workspace, one layer, exactly as before.
/// Is a real folder open, as the ENGINE holds it?
///
/// Asked of the wasm rather than of the page's own `folderHandle`, which lives
/// inside the Files module and is a copy: the question is which root the file
/// tools will actually resolve against, and only one place knows that.
export function folderOpen() {
	try { return Wasm.workspace_mode() === 'folder'; }
	catch (e) { return false; }
}

export var Instructions = {
	md: '',
	/// The user's own, from the store. Always in force.
	mine: '',
	/// The open folder's, or '' when there is no folder or it carries none.
	theirs: '',
	/// What opens a workspace file, handed over by the Files panel when it is built.
	/// Null until then, and a chip clicked before that writes the file and draws.
	opener: null,

	/// Carry a pre-rename `RED.md` over to `DAIMOND.md`, once, in whichever
	/// workspace is active.
	///
	/// The file is the user's house rules and it travels with their folder, so
	/// the rename must not cost them: a workspace written under the old name
	/// would otherwise come up silently rule-less. Checking for the file IS the
	/// check — two reads, no flag, no bookkeeping — so this stays correct for a
	/// folder the app has never seen before. If `DAIMOND.md` is already there it
	/// wins and the old file is left untouched; the user's current rules are
	/// never clobbered by their old ones.
	///
	/// **A file that is the STARTER, to the byte, does not count as already there.**
	/// `seedOnce` below writes one into the store on its first load, so from the day
	/// the starter shipped there is ALWAYS a `DAIMOND.md` standing in the way, and
	/// "if it is there it wins" stopped meaning "if the user has rules of their own".
	/// A `RED.md` that reaches a root after that first load — carried in by sync, or
	/// sitting in a folder opened later — was then never carried over, and the user's
	/// house rules sat unread beside a starter nobody wrote. The starter is this
	/// build's own text and the one thing here that is safe to overwrite unasked.
	migrate: async function () {
		try {
			// `readBytes` and NOT the `file_read` TOOL: the tool numbers every line,
			// so its answer could not be compared with the starter. See the note on
			// `readBytes` — the tool is for asking whether a file EXISTS, and this
			// now has to ask what is IN it.
			var cur = null;
			try { cur = await readBytes(INSTRUCTIONS_FILE); } catch (e) { cur = null; }
			if (typeof cur === 'string' && cur !== instructionsSeed()) return;  // theirs, and it wins
			var old = null;
			try { old = await readBytes(INSTRUCTIONS_FILE_WAS); } catch (e) { old = null; }
			if (typeof old !== 'string') return;          // nothing to carry
			// Written before the old file is dropped, so a failure anywhere in here
			// leaves the rules on disk under one name or the other and never neither.
			await Wasm.write_file(INSTRUCTIONS_FILE, old);
			await tools().run_tool_outcome('file_delete',
				JSON.stringify({ path: INSTRUCTIONS_FILE_WAS }));
		} catch (e) {
			// A workspace we cannot read is a workspace we cannot migrate. The
			// refresh below will find no rules and the app carries on as it does
			// for any folder without them.
		}
	},

	/// Put a starter in the STORE, once, where the store has never held one.
	///
	/// Resolves to the text written, or `''` where nothing was: a store that already has
	/// rules, a build too old to carry the seed, a browser with no local storage, or a
	/// write that failed. Every one of those is the ordinary case somewhere, so none of
	/// them is an error -- the app carries on with no rules, exactly as it did before.
	///
	/// Written to the store and never to an open folder. The user's own layer is the one
	/// that is always in force; a starter written into the project would arrive in their
	/// repository, under their name, saying things they did not write.
	seedOnce: async function () {
		var done = true;
		try { done = localStorage.getItem(INSTRUCTIONS_SEEDED_KEY) === '1'; }
		catch (e) { return ''; }		// no storage means no way to do this once
		if (done) return '';
		var text = instructionsSeed();
		if (!text.trim()) return '';
		try { await Wasm.store_write(INSTRUCTIONS_FILE, text); }
		catch (e) { return ''; }		// the flag is set on the write and not before
		try { localStorage.setItem(INSTRUCTIONS_SEEDED_KEY, '1'); } catch (e) { /* once more, then */ }
		return text;
	},

	/// The path the chip opens, having made sure there is something at it.
	///
	/// Through the FILE TOOLS and not `store_write`, deliberately: `openFile` resolves
	/// against the active root, so creating it any other way would write one file and open
	/// another. With a folder open that means the project's copy, which is the right file
	/// to be making when a project has no rules of its own.
	open: async function () {
		if (this.md.trim()) return INSTRUCTIONS_FILE;
		var text = instructionsSeed();
		if (text.trim()) {
			try {
				var w = await tools().run_tool_outcome('file_write',
					JSON.stringify({ path: INSTRUCTIONS_FILE, content: text }));
				if (w && w.outcome === 'done') await this.refresh();
			} catch (e) { /* the editor says why, and says it where the user is looking */ }
		}
		return INSTRUCTIONS_FILE;
	},

	/// Re-read DAIMOND.md from the ACTIVE workspace root (a real folder when one
	/// is open, else the OPFS sandbox), so the rules travel with the project.
	refresh: async function () {
		var prev = this.md;
		await this.migrate();
		// Yours, from the store. `Wasm.store_read` and not `file_read`: with a
		// folder open, `file_read` resolves against the FOLDER, so this would read
		// the project's copy and call it the user's — and the user's own rules
		// would vanish the moment they opened a project.
		this.mine = '';
		try {
			var own = await Wasm.store_read(INSTRUCTIONS_FILE);
			if (typeof own === 'string') this.mine = own;
		} catch (e) { /* nothing written yet */ }
		// A store that has never held one gets a starter, once, so the FIRST turn in a
		// fresh workspace is already better than nothing and the shape to extend is on
		// the screen rather than in a document nobody opens.
		if (!this.mine.trim()) this.mine = await this.seedOnce();
		// The project's, from the folder — and only when there IS one. With no
		// folder open both paths resolve to the same file, and reading it twice
		// would put the user's own rules into the prompt twice over.
		this.theirs = '';
		if (folderOpen()) {
			try {
				var proj = await tools().run_tool_outcome('file_read',
					JSON.stringify({ path: INSTRUCTIONS_FILE }));
				if (proj && proj.outcome === 'done') this.theirs = proj.text;
			} catch (e) { /* a folder without one is the ordinary case */ }
		}
		this.md = this.layered();
		// Existing agents hold a system prompt composed at construction, so a
		// changed DAIMOND.md only takes effect on their next turn — rebuild them.
		if (this.md !== prev) {
			pg.chats.forEach(rebuildChatApp);
			var md = this.md;
			everyDiamondClient(function (app) {
				try { app.set_instructions(md); } catch (e) { /* ignore */ }
			});
		}
		return this.md;
	},

	/// The two layers as one text, each under a heading that says whose it is.
	///
	/// Headed rather than run together, because a model that cannot tell them
	/// apart cannot resolve a conflict between them — and where they conflict the
	/// project's is the more specific instruction and should win, which is only
	/// legible if it is visibly the project's.
	layered: function () {
		var mine = (this.mine || '').trim(), theirs = (this.theirs || '').trim();
		if (!theirs) return mine;
		if (!mine) return theirs;
		return mine + '\n\n## For this project\n\n' + theirs;
	},

	/// The role prompt, plus the house rules, plus (for a worker) the crystal of
	/// the Diamond that dispatched it.
	///
	/// The crystal arrives from `DaimondApp::crystal_hot_text` -- the hot part and an
	/// outline of the rest -- so it is already prose around a JSON object and goes in as it
	/// stands, unfenced and unrendered. A rendering would drop any key the renderer does not
	/// know, and the keys a reducer has invented are exactly the ones a worker has been told
	/// about nowhere else; a fence around it would put a bullet list inside a JSON block.
	///
	/// **Hot and outline, not the whole crystal**, since the split of 2026-09-13: handing a
	/// worker more than the daimon that dispatched it carries would put the cold half in the
	/// standing context of every round of a turn that cannot even reach the tool that fetches
	/// it. A worker that needs a cold section gets it quoted in its task. An older engine
	/// with no such export hands back `crystal.json` whole, which is what this said before.
	compose: function (role, crystal) {
		var out = role;
		if (this.md.trim()) {
			out += '\n\n## Standing instructions from the user\n\n' + this.md.trim();
		}
		if (crystal && crystal.trim()) {
			var text = crystal.trim();
			// An engine too old for the split answers with the raw object, which still has
			// to be fenced for the reason above.
			if (text.charAt(0) === '{') text = '```json\n' + text + '\n```';
			out += '\n\n## The crystal of the diamond that dispatched you (crystal.json)\n\n'
				+ 'This is what the work is for. Act consistently with it.\n\n' + text;
		}
		return out;
	},
};

// ── The role prompts ───────────────────────────────────────────
//
// DAIMOND.md above is what the user ADDS to every agent. This is what each
// agent is told in the first place -- the prompt itself -- and it is theirs
// to change too: `prompts/chat.md`, `prompts/daimon.md`,
// `prompts/worker.md`, `prompts/reducer.md` and `prompts/compactor.md`,
// ordinary text files edited in the Doc panel like anything else.
//
// They live in DAIMOND'S OWN STORE, not in whatever folder happens to be open.
// That is a change: they used to resolve against the active workspace, so
// opening a project silently put every agent back on its shipped prompt while
// the user's own DAIMOND.md carried on — the agent's instructions changing
// under them with nothing on screen to say so. `dev/ROOT_SEPARATION.md` §2.5(d)
// names this, and it is why the instructions and the prompts move together
// rather than one phase apart: half of it is worse than neither half.
//
// An absent or empty file means the shipped default, so deleting one is how
// a user puts the original back. The defaults themselves live in Rust
// (src/prompts.rs) and are read through the wasm, so what an editor shows is
// what a model is really sent.
//
// What an edit CANNOT remove is the safety clause: the rule that page text is
// data rather than instruction, and the rule that nothing irreversible
// happens unasked. `compose_prompt` appends it to every role that holds
// tools, on the far side of the user's text.
export var PROMPTS_DIR = 'prompts';
export var Prompts = {
	/// Role name -> the user's text, '' where they have written none.
	md: { chat: '', daimon: '', worker: '', reducer: '', compactor: '' },

	/// Every role, with what to call it and what it is for -- the source for
	/// the buttons in the Admin panel.
	// `label` and `blurb` are KEYS, read when the menu is built, so a role
	// reads in whatever language is in force at that moment.
	roles: [
		{ id: 'chat',      label: 'role.chat',      blurb: 'role.chat_help' },
		{ id: 'daimon',    label: 'role.daimon',    blurb: 'role.daimon_help' },
		{ id: 'worker',    label: 'role.worker',    blurb: 'role.worker_help' },
		{ id: 'reducer',   label: 'role.reducer',   blurb: 'role.reducer_help' },
		// The fifth, and the one that has been unreachable since it was written.
		// `Role::Compactor` had a name, a label, a default prompt and a parser in
		// Rust, and this list is the only thing that decides whether a role's file
		// is ever read -- so `prompts/compactor.md` was a file a user could write
		// and nothing would open. It is the model that summarises a conversation
		// being folded: the one prompt whose output BECOMES the session's memory.
		{ id: 'compactor', label: 'role.compactor', blurb: 'role.compactor_help' },
	],

	path: function (id) { return PROMPTS_DIR + '/' + id + '.md'; },

	/// The whole system prompt for `id`: the user's text or the default,
	/// plus the rules their edit cannot remove.
	/// `model` is the model that will carry the request, where the caller knows it.
	/// Absent means unmeasured, which composes every note rather than none.
	role: function (id, model, steer) {
		// The steering notes, where there are any: the engine composes them before the safety
		// clause. An engine without the entry point, or no notes, composes as it always has.
		if (steer) {
			try { return Wasm.compose_prompt_with(id, this.md[id] || '', model || '', steer); }
			catch (e) { /* falls to the composition without them */ }
		}
		try { return compose_prompt_for(id, this.md[id] || '', model || ''); }
		catch (e) {
			// An engine without the three-argument entry point still composes; it simply
			// composes every note, which is what this build did before the findings existed.
			try { return compose_prompt(id, this.md[id] || ''); }
			catch (e2) { return default_prompt(id); }
		}
	},

	/// What the shipped default says, for seeding a file and for the "restore"
	/// path. This is the real text, read out of the wasm.
	defaultFor: function (id) {
		try { return default_prompt(id); } catch (e) { return ''; }
	},

	/// The fixed rules, shown above the editor so what is immovable is plain.
	clause: function () {
		try { return safety_clause(); } catch (e) { return ''; }
	},

	/// Re-read every prompt file from the ACTIVE workspace root, so they
	/// travel with the project exactly as DAIMOND.md does.
	/// A role that has been renamed carries its old file across.
	///
	/// `prompts/conductor.md` was the daimon's, and it is a file the user may
	/// have spent an afternoon on. Renaming the role without this would leave
	/// it in the workspace being read by nothing -- the agent quietly back on
	/// the shipped default, with the edited file still on disk looking as
	/// though it were in force. That is the worst of the three possible
	/// outcomes, because nothing about it looks wrong.
	///
	/// Copies rather than moves, and only when the new name does not exist, so
	/// running twice is harmless and nothing the user wrote is destroyed.
	adoptOldNames: async function () {
		var renamed = [{ from: 'conductor', to: 'daimon' }];
		for (var i = 0; i < renamed.length; i++) {
			var from = this.path(renamed[i].from), to = this.path(renamed[i].to);
			try {
				var already = '';
				try { already = await Wasm.store_read(to); } catch (e2) { already = ''; }
				if (already) continue;
				// The CONTENT is carried into the new file, so it must be the bytes.
				var old = await Wasm.store_read(from);
				if (typeof old !== 'string' || !old.trim()) continue;
				await Wasm.store_write(to, old);
			} catch (e) { /* nothing written yet, or unreadable: nothing to carry */ }
		}
	},

	refresh: async function () {
		var changed = false;
		await this.adoptOldNames();
		for (var i = 0; i < this.roles.length; i++) {
			var id = this.roles[i].id;
			var was = this.md[id];
			try {
				var res = await Wasm.store_read(this.path(id));
				this.md[id] = (typeof res === 'string') ? res : '';
			} catch (e) {
				this.md[id] = '';       // nothing written: the shipped default stands
			}
			if (this.md[id] !== was) changed = true;
		}
		// A chat or a worker is built with its prompt already composed, so a
		// changed file only reaches it on the next construction -- drop them.
		// The daimon and the reducer are built inside the wasm, which is
		// told directly.
		if (changed) {
			pg.chats.forEach(rebuildChatApp);
			var self = this;
			everyDiamondClient(function (app) {
				try {
					app.set_role_prompt('daimon',  self.md.daimon  || '');
					app.set_role_prompt('reducer', self.md.reducer || '');
					// The compactor's is not this app's own prompt at all -- it is what
					// the tool-less model folding its conversation is told -- so it is
					// applied alongside the fold model rather than beside these two.
					applyFoldSettings(app, _diamondAppProvider.get(app) || '');
				} catch (e) { /* an app mid-turn keeps what it has */ }
			});
		}
		return changed;
	},

	/// Open a role's prompt for editing, writing the shipped default into the
	/// file first if there is nothing there yet.
	///
	/// Seeding matters: an empty editor would leave the user guessing at what
	/// they are replacing, and the thing most worth reading is what the agent
	/// is told TODAY. Writing the default also makes the file the plain record
	/// of it -- greppable, diffable, and portable with the folder.
	edit: async function (id) {
		var path = this.path(id);
		var cur = '';
		try { cur = await Wasm.store_read(path); } catch (e) { cur = ''; }
		if (typeof cur !== 'string' || !cur.trim()) {
			// `store_write` creates parents, so there is no directory to make first.
			await Wasm.store_write(path, this.defaultFor(id));
			await this.refresh();
			try { Files.refresh(); } catch (e) { /* the tree redraws on its own next time */ }
		}
		// Opened through the STORE door, so the editor reads and writes the file
		// that is actually in force -- not a same-named one in an open folder.
		Files.open(path, { store: true });
	},
};
// page-split: install 101

// ── One lock per Diamond (round F, R1; across tabs, L7) ────────
//
// Two writers read a Diamond's files and then lay them down whole: a note press (`Notes._edit`) and the
// pull that imports another device's copy (`applyDiamonds`, which also joins the note file back). Left
// apart, a press made after the pull read the Diamond's stamp read as a one-sided change, and the import
// replaced the file under it: an Add was gone from both devices and a Remove came back. Both take this lock.
// The lock is the browser's own (Web Locks, one name per Diamond), so a second tab of the same device is held
// off as well: its press cannot read the files while this tab's pull replaces them.
var DIAMOND_LOCKS = {};		// Diamond id -> { tail: this page's line (no Web Locks), n: asks in this page, held or waiting }
export var DIAMOND_LOCK_WAIT = 20000;	// ms a note press waits its turn before it answers that it could not
var DIAMOND_LOCK_NAME = 'daimond-diamond:';
var DIAMOND_LOCK_LATE = 'This Diamond is being brought up to date by a sync, and the change waited too long for it. Try again in a moment.';

/// Run `fn` holding the lock of Diamond `id`: one holder at a time per Diamond, in the order asked, and
/// whatever `fn` returns or throws is the answer. A holder must not ask for the same Diamond's lock again
/// (it would wait for itself): inside, call the `...Held` form of a writer. Where `wait` (ms) is given
/// a caller still queued after that long is answered with an error and never runs `fn`. Where the browser
/// has no Web Locks the line is this page's alone (a second tab is then not held off).
export function holdDiamond(id, fn, wait) {
	var q = DIAMOND_LOCKS[id] || (DIAMOND_LOCKS[id] = { tail: Promise.resolve(), n: 0 });
	var ls = (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function'
		&& typeof AbortController === 'function') ? navigator.locks : null;
	q.n++;
	// This page's own line: each ask waits for the one before it.
	var inPage = function () {
		var prior = q.tail, free = null, late = false, timer = 0;
		q.tail = new Promise(function (r) { free = r; });
		return new Promise(function (resolve, reject) {
			if (wait > 0) timer = setTimeout(function () { late = true; reject(new Error(DIAMOND_LOCK_LATE)); }, wait);
			prior.then(function () {
				clearTimeout(timer);
				if (late) { free(); return; }
				var run;
				try { run = Promise.resolve(fn()); } catch (e) { run = Promise.reject(e); }
				run.then(resolve, reject).then(free);
			});
		});
	};
	// The browser's line: the lock manager grants a name to one holder at a time, across the tabs of the origin, in
	// the order asked. An ask still queued when `wait` runs out is aborted before it is granted, so it never runs.
	var shared = function () {
		var ctl = new AbortController(), timer = 0, entered = false, late = false, got = null;
		if (wait > 0) timer = setTimeout(function () { late = true; ctl.abort(); }, wait);
		try {
			got = ls.request(DIAMOND_LOCK_NAME + id, { mode: 'exclusive', signal: ctl.signal }, function () {
				entered = true; clearTimeout(timer);
				return new Promise(function (r) { r(fn()); });
			});
		} catch (e) { got = Promise.reject(e); }
		return got.catch(function (e) {
			clearTimeout(timer);
			if (entered) throw e;						// `fn`'s own
			if (late) throw new Error(DIAMOND_LOCK_LATE);		// aborted in the queue
			return inPage();							// the lock manager would not take the name (an opaque origin): this page's line
		});
	};
	var leave = function () { if (--q.n === 0 && DIAMOND_LOCKS[id] === q) delete DIAMOND_LOCKS[id]; };
	return (ls ? shared() : inPage()).then(function (v) { leave(); return v; }, function (e) { leave(); throw e; });
}
// page-split: install 102

// ── Pending: what a daimon has proposed and is waiting on you for ──
//
// Notes2: "at this stage we have the user approving all outgoing email, so
// this leads to the need for a new Dock panel, say 'Pending' with tiles for
// each action that must be approved by the user."
//
// Three answers, and all three take the tile away, because a list you have to
// tidy separately is a list that stops being read:
//
//   ✓  do it        the action runs
//   ?  discuss it   you land in that Diamond's chat with the details already
//                   sent -- which is what phase E built somewhere to land IN
//   ✕  drop it      it never happens
//
// PRIORITY IS SET BY THE DAIMON THAT RAISED IT (§5.3, settled with the user),
// and you may override it. Anything else means setting a priority by hand on
// every item, which nobody does twice.
//
// WHAT ACTUALLY RAISES A TILE, and why it took so long to find. For most of
// this panel's life nothing did: it was built for approving outgoing mail,
// that was built instead as the Drafts list at the top of the Email panel, and
// no other caller was ever written. A user had never seen a tile here.
//
// The caller it was missing is CONSENT, asked when nobody can answer it. The
// gate in `egressAllowed` is a dialog, and a dispatched worker acts precisely
// when the user is looking at something else, so a worker's question was being
// put to an empty room and the work died on the dismissal. `parkConsent` puts
// it here instead, as a `consent` tile, and the worker WAITS on the tile: the
// engine is awaiting the promise that `execute` and `drop` resolve. So the
// three answers are the three that question has, they are answerable an hour
// later, and a yes is the tool call carrying on rather than a fresh dispatch.
//
// The one thing a tile cannot survive is a RELOAD, because what it is holding
// is a promise. `load` marks those expired and the tile says so instead of
// offering a tick that would do nothing.
//
// `kind` is `consent` or `proposal`, and nothing else. There were three others.
// `draft` (a message to open and send) and `note` (nothing to run, and approving
// it is acknowledging it) were written for producers nobody ever wrote, and went
// on 2026-08-15 with the `files` icon row and the `sweep` that served them. The
// producer `draft` was waiting for arrived somewhere else, as the paragraph
// above says: outgoing mail is approved from the Drafts list at the top of the
// Email panel. `add` refuses any other kind at the door rather than leaving
// the branches standing, because an unreachable branch is a promise the next
// caller believes -- and this panel has already broken three of those.
//
// `proposal` IS such a kind, and it came back on 2026-09-15 WITH ITS PRODUCER,
// which is the only condition on which a kind belongs here. A Diamond's timer
// fires, its daimon reads `system/usage/digest.md` and states one finding; the
// finding is a thing to do about the account, so it lands where things to do
// about the account land. See `proposeFromTurn`. The three answers mean what
// they say for it too: the tick sends the finding back to the Diamond that
// found it, as an instruction to carry out; `?` opens that conversation
// instead; `✕` drops it. NOTHING IS WAITING on a proposal tile -- no turn is
// held open by one -- so it never expires and its tick is never dimmed.
//
// `notice` is the fourth, and its producer is `DaimondHand`'s own `hello`
// (2026-09-24): a hand older than the deletion meter used to raise a MODAL
// the moment it said so, mid-turn as often as not, so a person's next click
// landed on its backdrop and closed it unread — the click was lost with it.
// A notice is exactly the shape `note` was, before it had a producer: nothing
// runs and nothing waits, so there is nothing to discuss and no diamond for
// `?` to open. `tile` hides that control for it; the tick and `✕` both just
// take the tile down, since acknowledging one IS dismissing it.
//
// `steer` is the fifth (Rating U7b), raised by the PAGE and by no model: after each digest write
// `steerRaise` turns the trusted rating cells into a model switch, a note to add or a note to
// review (`DaimondSteering.proposals`). Nothing applies without a press, and each tile's presses
// are its own (`steerTile`). It is the one kind that raises NO count: a proposal from figures is
// advice with no deadline, so it fails the importance filter that a badge, dot or toast must
// pass, and it waits at low priority where the person looks. `add` refuses it at the door;
// `steerSettle` is the only way in, and the way out of a tile another device has answered.
//
// `alert` is the sixth (D-20261016-17, ALERT-PENDING), and its producer is a Diamond's own daimon:
// `pending_raise` / `pending_clear` (src/tools.rs), which write `DaimondAlerts` (alerts.js), the
// synced record, and never this list. The owner's ruling is that this panel is THE one place a
// person looks for system alerts, so every alert lands here and nowhere else -- not in the
// Diamond's chat. `fresh` lays the live alerts over the stored items as `a:<diamond>:<key>`;
// `save` writes back only what is not an alert, so the two records never cross. An alert says
// whether it `needs` the person: only one that does counts on the chip (the importance filter,
// as `steer` fails it), and one that does not is drawn quietly and lapses after 24 hours by its
// own synced `expires`. Its tile has no priority, no tick and no `?`: it links to the Diamond
// that raised it, and its `✕` is a dismiss, remembered on every device (`DaimondAlerts.dismiss`).
// `add` refuses the kind at the door; only the daimon raises one.
//
// The `kind === 'consent'` tests that remain are NOT dead branch selectors, so
// please do not report them as such: `items` is read back out of localStorage,
// which no build owns, so a record this one did not write can arrive at `tile`,
// `discuss` and `load`, and each answers it without claiming a turn is waiting.
// `execute` needs no such test because it has a better one -- `settleConsent`
// asks the register whether anything is actually parked.
export var PENDING_KEY = 'daimond-pending';
var PRIORITIES  = ['high', 'normal', 'low'];
// The keys of notices a person has dismissed, so the same news is not told twice.
var NOTICED_KEY = 'daimond-pending-noticed';
var NOTICED_MAX = 64;						// bounded: a hand's (host, version) pairs, not a log

export var Pending = {
	items: [],
	RECOVER:   'r:recover',	// the recovery row's id
	recoverAt: 0,			// when this page first found the identity unrecoverable

	/// Is there an identity here that nothing outside this browser would bring back?
	/// (identity.js `recoverable`.) False where the question cannot be asked.
	unrecoverable: function () {
		try {
			var I = window.DaimondIdentity;
			return !!(I && I.recoverable && I.exists && I.exists() && !I.recoverable());
		} catch (e) { return false; }
	},

	load: function () { this.fresh(); },

	/// Read the stored list again, over what this tab holds.
	///
	/// EVERY TAB OF THIS ACCOUNT SHARES THE LIST, and until 2026-09-24 each read it once,
	/// at boot, and wrote its whole copy back on every change: a proposal raised in one
	/// tab erased a notice another had raised, and the notice's seen-mark then kept it
	/// from ever returning (R2 QA, F5; `pause.js` shed the same fault as D2). So every
	/// change reads the store first and writes in the same synchronous step, and another
	/// tab's write is read here as it lands (the `storage` listener below).
	///
	/// A parked consent request is a PROMISE, held in THIS tab's `_parked`, and a
	/// promise does not survive a reload or cross to another tab. The tile does,
	/// because "an agent asked and got no answer" is worth keeping -- but it is marked
	/// for what it is here, so that nothing on it offers to let through an act this tab
	/// has nothing behind. See `tile` and `execute`. Worked out on every read, never
	/// trusted from the store, since the tab that stored it may be the one waiting.
	fresh: function () {
		var got = readJson(PENDING_KEY, []);
		this.items = Array.isArray(got) ? got.filter(function (it) { return it && it.id; }) : [];
		// Every synced DaimondAlerts item (an alert, the runner's tile, its alarm notice) is the
		// record's, drawn below from it: one a save or an older build left in the local list is
		// not drawn twice, nor kept past its clearing (rafreeze).
		this.items = this.items.filter(function (it) { return !Pending.derived(it); });
		// R1: one row while nothing outside this browser would bring the identity back.
		// Worked out on every read and never stored, so it goes when its cause does.
		if (this.unrecoverable()) {
			if (!this.recoverAt) this.recoverAt = Date.now();
			this.items.push({ id: this.RECOVER, kind: 'recover', priority: 'high', at: this.recoverAt,
				headline: t('recover.not_yet'), detail: t('recover.not_yet_reason') });
		} else this.recoverAt = 0;
		this.items.forEach(function (it) {
			if (it.kind === 'consent') it.expired = !_parked[it.id];
		});
		var al = [];
		try { al = (window.DaimondAlerts && DaimondAlerts.live()) || []; } catch (e) { al = []; }
		var self = this;
		// NOT A DIAMOND'S THAT IS GONE (QA r569qa1 #3). One in the trash is hidden, not taken
		// down, so a restore brings back what is still up; one destroyed, here or on another
		// device, is out of reach for good (its alerts are dismissed by `destroyDiamond`).
		var dtombs = tombMapNow(DIAMOND_TOMBS_KEY);
		var RN = window.DaimondAlerts ? DaimondAlerts.RUNNER : '';
		al = al.filter(function (a) {
			if (RN && a.diamond === RN) { var ri = runnerItem(a); if (ri) self.items.push(ri); return false; }
			return !dtombs[a.diamond] && !trashed(a.diamond);
		});
		al.forEach(function (a) {
			var d = pg.diamonds.find(function (x) { return x.id === a.diamond; });
			self.items.push({
				id: 'a:' + a.id, kind: 'alert', diamondId: a.diamond, diamondName: d ? (d.name || '') : '',
				headline: a.headline, detail: a.detail, needs: !!a.needs,
				priority: a.needs ? 'high' : 'low', at: a.at,
			});
		});
	},
	/// How many tiles count on the chip: what passes the importance filter. A `steer`
	/// proposal and an alert that does not need the person are seen, not counted.
	counted: function () {
		return this.items.filter(function (it) {
			return it.kind !== 'steer' && !(it.kind === 'alert' && !it.needs);
		}).length;
	},
	/// Is this item the synced DaimondAlerts record's (`a:` + its id), and not this list's?
	/// ONE RULE, by id and never by kind: the runner's alarm is drawn as a `notice` and its
	/// update as a `runner`, and a kind list kept a saved alarm tile past the alarm (rafreeze).
	fromAlerts: function (it) { return !!it && String(it.id).indexOf('a:') === 0; },
	/// Is this item drawn from elsewhere on every read (a synced alert, the recovery row),
	/// and so never this list's to store or to reprioritise?
	derived: function (it) { return Pending.fromAlerts(it) || (!!it && it.id === Pending.RECOVER); },
	save: function () {
		var mine = this.items.filter(function (it) { return !Pending.derived(it); });
		try { localStorage.setItem(PENDING_KEY, JSON.stringify(mine)); }
		catch (e) { /* quota: it holds for this session */ }
		this.render();
		// A question raised or answered changes a square's colour in the Agents grid.
		if (typeof Workers !== 'undefined' && Workers && Workers.touch) Workers.touch();
		nudgeSync();
	},

	/// Has a notice with this key been dismissed here?
	noticed: function (key) {
		var seen = readJson(NOTICED_KEY, []);
		return !!key && Array.isArray(seen) && seen.indexOf(key) >= 0;
	},

	/// Is a notice with this key on the panel now, raised by this tab or another?
	noticeUp: function (key) {
		this.fresh();
		return !!key && this.items.some(function (x) { return x.kind === 'notice' && x.key === key; });
	},

	/// Raise one item. Everything but the kind is the daimon's own words.
	///
	/// A kind this panel cannot act on is refused rather than drawn. Drawn, it
	/// would carry the consent tile's "still waiting" line over a turn that was
	/// never parked, and its tick would report a permission granted to nobody.
	///
	/// A caller that names NO kind gets `consent`, which is what every caller
	/// that predates `proposal` meant and is the only reason the default is not
	/// the harmless one: a parked turn asked for and drawn as a proposal would
	/// be a held tool call with no tick that resumes it.
	add: function (item) {
		if (!item || !item.headline) return null;
		var kind = item.kind || 'consent';
		if (kind !== 'consent' && kind !== 'proposal' && kind !== 'notice'
			&& kind !== 'runnerpair') return null;
		// A runner asking to join names its pending device and the key it will be sealed to (R2d1).
		var rp = kind === 'runnerpair' ? runnerPairShape(item.runnerpair) : null;
		if (kind === 'runnerpair' && !rp) return null;
		var rec = {
			id:        'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
			diamondId: item.diamondId || '',
			diamondName: item.diamondName || '',
			headline:  String(item.headline),
			detail:    String(item.detail || ''),
			kind:      kind,
			priority:  PRIORITIES.indexOf(item.priority) >= 0 ? item.priority : 'normal',
			at:        Date.now(),
		};
		// A notice may name the news it carries, so it is told once: `noticed` after
		// it is dismissed, `noticeUp` while it is on the panel.
		if (kind === 'notice' && item.key) rec.key = String(item.key);
		// A refused permit's notice can run its turn again (`permitRetry`).
		if (kind === 'notice' && item.retry && item.retry.turnId) rec.retry = { turnId: String(item.retry.turnId) };
		if (rp) rec.runnerpair = rp;
		// A consent names the run that asked, when one did: the Agents grid turns that
		// square amber, and its pinned tile carries the same Allow and Deny.
		if (kind === 'consent' && item.runId) rec.runId = String(item.runId);
		// A change ask carries the change itself, drawn on the tile (UNBLOCK-26 U5).
		if (kind === 'consent' && item.change && typeof item.change === 'object') rec.change = item.change;
		this.fresh();
		// ONE tile per waiting runner: a second raise for the same device replaces the first.
		if (rp) this.items = this.items.filter(function (x) {
			return x.kind !== 'runnerpair' || !x.runnerpair || x.runnerpair.device !== rp.device;
		});
		// A proposal is the daimon answer it came from, filed under its own handle.
		if (kind === 'proposal' && item.prod && window.DaimondProvenance) {
			var pp = DaimondProvenance.rekind(item.prod, 'proposal', DaimondProvenance.h.proposal(rec.id));
			if (pp) rec.prod = [pp];
		}
		this.items.push(rec);
		this.save();
		// ONLY A QUESTION TAKES THE SCREEN. A consent is a turn held open on the answer,
		// so it is revealed the way a dispatch reveals Agents: the one moment there is
		// something to answer and nobody has asked to watch for it. A notice or a
		// proposal waits on nobody, and at 760px or narrower "revealed" is a sheet
		// risen over the composer -- where a hand's hello, landing mid-turn, took the
		// next keystrokes and the next Send (R2 QA, F4). Those only count on the chip.
		if (kind === 'consent') {
			try { if (!DaimondPanels.isOpen('pending')) DaimondPanels.show('pending'); }
			catch (e) { /* the layout engine is not up */ }
		}
		return rec.id;
	},

	/// Take one item off the list, whatever the reason.
	///
	/// A worker parked on this tile is refused HERE rather than in each of the
	/// three answers, so that no route out — the ✕, `discuss`, anything added
	/// later — can leave a turn waiting on something that is no longer on the
	/// panel. `execute` settles its `allow` first, which takes the request out
	/// of the register, so this deny then finds nothing and does nothing.
	///
	/// A notice that names its news is marked told when it is TAKEN DOWN, and not when
	/// it is raised: marked at raising, a tile lost before anyone saw it could never
	/// come back (R2 QA, F5).
	drop: function (id) {
		if (Pending.fromAlerts({ id: id })) {
			// An alert is the daimon's record, not this list's: the person dismisses it there.
			try { if (window.DaimondAlerts) DaimondAlerts.dismiss(String(id).slice(2)); } catch (e) { /* stays up */ }
			this.fresh();
			this.render();
			return;
		}
		settleConsent(id, 'deny');
		this.fresh();
		var gone = this.items.filter(function (x) { return x.id === id; })[0];
		if (gone && gone.kind === 'notice' && gone.key) Pending.markNoticed(gone.key);
		this.items = this.items.filter(function (x) { return x.id !== id; });
		this.save();
	},

	markNoticed: function (key) {
		var seen = readJson(NOTICED_KEY, []);
		if (!Array.isArray(seen)) seen = [];
		if (seen.indexOf(key) >= 0) return;
		seen.push(key);
		try { localStorage.setItem(NOTICED_KEY, JSON.stringify(seen.slice(-NOTICED_MAX))); }
		catch (e) { /* quota: worst case the same news is told again */ }
	},

	/// Set one tile's priority, by id, onto the list as it is stored now.
	setPriority: function (id, p) {
		this.fresh();
		var it = this.items.filter(function (x) { return x.id === id; })[0];
		if (!it || PRIORITIES.indexOf(p) < 0 || it.priority === p) return;
		it.priority = p;
		this.save();
	},

	/// Take one BROADCAST-consent tile down because it was ALREADY ANSWERED on
	/// another device, not because it was answered here. Unlike `drop`, it does
	/// NOT settle the parked promise -- settling it as a deny would seal and post a
	/// second, conflicting grant for a cid the runner has already spent. The parked
	/// promise is simply forgotten (nothing awaits it once the runner resolved), and
	/// the tile leaves the panel. Called only by `adoptRemoteGrant`.
	dismiss: function (id) {
		delete _parked[id];
		this.fresh();
		this.items = this.items.filter(function (x) { return x.id !== id; });
		this.save();
	},

	/// The sort the user chose. Priority first is the default, because the
	/// question a list of things to approve answers is "what next".
	sorted: function () {
		var how = 'priority';
		try { how = localStorage.getItem(PENDING_KEY + '-sort') || 'priority'; } catch (e) { /* default */ }
		var out = this.items.slice();
		if (how === 'newest') out.sort(function (a, b) { return b.at - a.at; });
		else if (how === 'oldest') out.sort(function (a, b) { return a.at - b.at; });
		else out.sort(function (a, b) {
			var d = PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority);
			// Oldest first WITHIN a priority: two things equally urgent are
			// answered in the order they were asked.
			return d !== 0 ? d : a.at - b.at;
		});
		return out;
	},

	render: function () {
		var list = document.getElementById('pending-list');
		var count = document.getElementById('pending-count');
		if (!list) return;
		var n = this.counted();
		if (count) count.textContent = n ? String(n) : '';
		list.innerHTML = '';
		if (!this.items.length) {
			var none = document.createElement('div');
			none.className = 'rail-note';
			none.textContent = t('pending.empty');
			list.appendChild(none);
			return;
		}
		this.sorted().forEach(function (it) {
			list.appendChild(Pending.tile(it));
		});
	},

	tile: function (it) {
		var box = document.createElement('div');
		box.className = 'pend-card prio-' + it.priority
			+ (it.kind === 'alert' ? ' pend-alert' + (it.needs ? ' pend-needs' : ' pend-quiet') : '');
		box.dataset.id = it.id;

		var head = document.createElement('div');
		head.className = 'pend-head';
		if (it.kind === 'alert') {
			var badge = document.createElement('span');
			badge.className = 'pend-kind';
			badge.textContent = t(it.needs ? 'pending.alert.needs' : 'pending.alert.quiet');
			head.appendChild(badge);
		}
		// A synced item (`a:`) has no priority to set here: the list it would be saved to is not its record.
		var prio = Pending.derived(it) ? null : document.createElement('select');
		if (prio) {
		prio.className = 'pend-prio';
		prio.title = t('pending.priority');
		prio.setAttribute('aria-label', t('pending.priority'));
		PRIORITIES.forEach(function (pv) {
			var o = document.createElement('option');
			o.value = pv; o.textContent = t('pending.prio_' + pv);
			prio.appendChild(o);
		});
		prio.value = it.priority;
		prio.addEventListener('change', function () { Pending.setPriority(it.id, prio.value); });
		head.appendChild(prio);
		}
		if (it.diamondName) {
			var chip = document.createElement('span');
			chip.className = 'pend-diamond';
			chip.textContent = it.diamondName;
			head.appendChild(chip);
		}
		var when = document.createElement('span');
		when.className = 'pend-when';
		when.textContent = relTime(it.at);
		head.appendChild(when);
		box.appendChild(head);
		if (it.kind === 'consent' && it.change) { changeTile(box, it); return box; }

		// The headline, which EXPANDS. A panel of paragraphs cannot be scanned,
		// and a panel of one-liners cannot be judged -- so it is both, and which
		// one is up is the reader's choice.
		var line = document.createElement('button');
		line.type = 'button';
		line.className = 'pend-line';
		line.textContent = it.headline;                 // escaped via textContent
		line.setAttribute('aria-expanded', 'false');
		var body = document.createElement('div');
		body.className = 'pend-detail';
		body.style.display = 'none';
		body.textContent = it.detail || t('pending.no_detail');
		line.addEventListener('click', function () {
			var on = body.style.display === 'none';
			body.style.display = on ? '' : 'none';
			line.setAttribute('aria-expanded', on ? 'true' : 'false');
		});
		box.appendChild(line);
		box.appendChild(body);

		// A parked consent request says whether anything is still on the other
		// end of it. The two states look the same on a tile and mean opposite
		// things — one is a turn held open waiting for this answer, the other
		// is the record of a question that was never answered in time — so the
		// tile says which, in words, above the buttons.
		if (it.kind === 'consent') {
			var held = document.createElement('div');
			held.className = 'rail-note pend-consent';
			held.textContent = it.expired
				? t('pending.consent.expired') : t('pending.consent.waiting');
			box.appendChild(held);
		}
		// A proposal says what its tick DOES, for the opposite reason. Nothing is
		// waiting on it, so the reader's question is not "is this still live" but
		// "what happens if I press it" -- and what happens is a turn, on the
		// Diamond that raised it, which is a thing worth knowing before pressing.
		if (it.kind === 'proposal') {
			var sug = document.createElement('div');
			sug.className = 'rail-note pend-proposal';
			sug.textContent = t('pending.proposal.note');
			box.appendChild(sug);
		}

		// The page's own proposals carry their own verbs (Rating U7b).
		if (it.kind === 'steer') { steerTile(box, it); return box; }
		// A runner update is answered on the approve page, never here (KS-p4).
		if (it.kind === 'runner') { runnerTile(box, it); return box; }
		// A runner asking to join is approved here, with his passkey (R2d1).
		if (it.kind === 'runnerpair') { runnerPairTile(box, it); return box; }
		// Not recoverable yet: its one act is the enrolment (`offerRecovery`), asked again.
		if (it.kind === 'recover') {
			var racts = document.createElement('div');
			racts.className = 'pend-acts';
			var rgo = document.createElement('button');
			rgo.type = 'button';
			rgo.className = 'pend-act pend-go pend-recover-go';
			rgo.textContent = t('recover.not_yet_act');
			rgo.addEventListener('click', function () { offerRecovery(null, true); });
			racts.appendChild(rgo);
			box.appendChild(racts);
			return box;
		}
		// An alert's two: go to the Diamond that raised it, or take it down.
		if (it.kind === 'alert') {
			var aacts = document.createElement('div');
			aacts.className = 'pend-acts';
			var open = document.createElement('button');
			open.type = 'button';
			open.className = 'pend-act pend-open';
			open.textContent = t('pending.alert.open', { name: it.diamondName || t('pending.alert.diamond') });
			open.addEventListener('click', function () {
				var f = pg.diamonds.find(function (x) { return x.id === it.diamondId; });
				if (f) selectDiamond(f, 'chat');
				else toast(t('pending.alert.gone'));
			});
			aacts.appendChild(open);
			var adrop = document.createElement('button');
			adrop.type = 'button';
			adrop.className = 'pend-act pend-no';
			adrop.textContent = '✕'; adrop.title = t('pending.alert.dismiss');
			adrop.setAttribute('aria-label', t('pending.alert.dismiss'));
			adrop.addEventListener('click', function () { Pending.drop(it.id); });
			aacts.appendChild(adrop);
			box.appendChild(aacts);
			return box;
		}

		var acts = document.createElement('div');
		acts.className = 'pend-acts';
		var go = document.createElement('button');
		go.type = 'button'; go.className = 'pend-act pend-go';
		go.textContent = '✓';
		// A notice's tick does not "do" anything -- there is nothing behind it to
		// run -- it only takes the tile down, so it wears the word an ordinary OK
		// button wears rather than `pending.execute`'s "Do it".
		go.title = it.kind === 'notice' ? t('dlg.ok') : t('pending.execute');
		go.setAttribute('aria-label', it.kind === 'notice'
			? t('dlg.ok') : t('pending.execute_named', { what: it.headline }));
		if (it.kind === 'notice' && it.retry) {
			go.className += ' pend-retry';
			go.textContent = t('permit.retry');
			go.title = t('permit.retry');
			go.setAttribute('aria-label', t('permit.retry'));
		}
		go.addEventListener('click', function () { Pending.execute(it); });
		// A tick that cannot do the thing is not offered. The turn this one
		// belonged to went with the page it was asked on, so "do it" would
		// grant a permission to nobody and take the tile away as though
		// something had happened. The other two answers still mean what they
		// say: there is a record to clear, and something to talk about.
		if (it.kind === 'consent' && it.expired) {
			go.disabled = true;
			go.title = t('pending.consent.expired');
			go.setAttribute('aria-label', t('pending.consent.expired'));
			// Dimmed HERE because `app.css` has no `.pend-act:disabled` rule,
			// and a button that reads as live and does nothing is the same lie
			// as a tick that grants a permission to nobody. Move this into the
			// stylesheet the moment that rule exists.
			go.style.opacity = '0.4';
			go.style.cursor = 'not-allowed';
		}
		acts.appendChild(go);
		// A NOTICE carries no Diamond and nothing to discuss -- see `add`'s
		// header -- so the middle control is not drawn for one at all, rather
		// than drawn and left to fall into `discuss`'s "gone" branch.
		if (it.kind !== 'notice') {
			var ask = document.createElement('button');
			ask.type = 'button'; ask.className = 'pend-act pend-ask';
			ask.textContent = '?'; ask.title = t('pending.discuss');
			ask.setAttribute('aria-label', t('pending.discuss_named', { what: it.headline }));
			ask.addEventListener('click', function () { Pending.discuss(it); });
			acts.appendChild(ask);
		}
		var no = document.createElement('button');
		no.type = 'button'; no.className = 'pend-act pend-no';
		no.textContent = '✕'; no.title = t('pending.cancel');
		no.setAttribute('aria-label', t('pending.cancel_named', { what: it.headline }));
		no.addEventListener('click', function () { Pending.drop(it.id); });
		acts.appendChild(no);
		box.appendChild(acts);
		return box;
	},

	/// Do it. The tick IS the yes the worker parked on this tile is waiting on,
	/// and pressing it resumes the tool call where it stopped.
	///
	/// `settleConsent` reports whether anything was still waiting, and that
	/// answer is not decoration: a tile that outlived its turn must say so
	/// rather than report a permission it granted to nobody. The tile is marked
	/// expired at load, so this is the second line of the same defence and
	/// covers the case where the turn ended while the tile was on screen. It is
	/// also what answers a record left over from a build that had other kinds:
	/// nothing is waiting on one, so it is dropped with a word rather than
	/// silently.
	execute: function (it) {
		// A PROPOSAL has no parked turn behind it, so `settleConsent` would find
		// nothing and the tile would be dropped with "that agent has gone" over a
		// question no agent ever asked. It is answered by its own path.
		if (it.kind === 'proposal') return Pending.doProposal(it);
		// A NOTICE has nothing parked either, and nothing to report allowing --
		// the tick is an acknowledgement, not a permission, so it says so with
		// the wording this panel already had for exactly that (`note`, before it
		// lost its one producer on 2026-08-15) rather than "Allowed."
		if (it.kind === 'notice' && it.retry) {
			if (!permitRetry(it.retry.turnId)) { toast(t('permit.retry_busy'), true); return; }
			this.drop(it.id);
			return;
		}
		if (it.kind === 'notice') { toast(t('pending.noted')); this.drop(it.id); return; }
		if (!settleConsent(it.id, 'allow')) {
			toast(t('pending.consent.gone'), true);
			this.drop(it.id);
			return;
		}
		toast(t('pending.consent.allowed'));
		this.drop(it.id);
	},

	/// Do the thing a Diamond proposed, which means asking THAT Diamond to do it.
	///
	/// The tick is not an act of this panel's: the finding came out of one
	/// Diamond's turn, its evidence is in that conversation, and the work is that
	/// Diamond's to carry out. So this lands the user in the chat and sends the
	/// instruction, exactly as `discuss` lands them there with a question -- one
	/// door back into the conversation, with two things to say at it.
	///
	/// The headline and the detail are sent WHOLE and unedited. They are what the
	/// user read before pressing, so they are what the Diamond is told; composing
	/// a tidier instruction here would send something nobody approved.
	doProposal: async function (it) {
		var f = (pg.diamonds || []).find(function (x) { return x.id === it.diamondId; });
		if (!f) {
			toast(t('pending.diamond_gone'), true);
			Pending.drop(it.id);
			return;
		}
		// THE SWITCH AS DRAWN AT THIS PRESS (rulings l.16, l.19; STEER D4), taken before the hold's
		// read and the Diamond's opening can redraw it.
		var drawn = Pending.drawnFor(f);
		if (await Pending.heldFor(f)) return;
		await selectDiamond(f, 'chat');
		if (await Pending.heldFor(f)) return;
		Pending.drop(it.id);
		var text = t('pending.proposal_do', { headline: it.headline })
			+ (it.detail ? '\n' + it.detail : '');
		await Pending.send(f, text, drawn);
	},

	/// The runner the "Here | <runner>" switch draws for `f`'s conversation at a tile's press.
	drawnFor: function (f) {
		try { return seatDrawnRunner(daimonChat(f)); } catch (e) { return ''; }
	},

	/// Send a tile's words into its Diamond, now open, THROUGH THE ONE ENTRY (rulings l.16;
	/// STEER D4): Send's door, so the switch drawn at the tile's press decides where the turn
	/// runs, a turn already running hears it or queues it, and a runner gone since the press
	/// ends it "not run" with Retry. It steered here straight (`doSteer`), whatever the
	/// switch said. A Diamond that did not open keeps the words out of another conversation.
	send: async function (f, text, drawn) {
		if (!pg.current || pg.current.diamondId !== f.id) {
			diag('pending send', 'diamond=' + String(f.id || '') + ' not opened: nothing sent');
			return;
		}
		await sendUserMessage(text, drawn);
	},

	/// Is this Diamond held, so that a tile sending it a turn would be refused? Says
	/// so by name where it is, and the tile stays.
	///
	/// Asked BEFORE the tile goes (R3 QA, Q6-2). The tick dropped the tile and then
	/// steered, and the steer's own pause check refused the turn: the refusal was
	/// shown, the tile was gone, and after play there was nothing left to tick. This is
	/// the question that check asks (`turnHold`), so the two cannot disagree, and it is
	/// asked again after the Diamond opens, for a pause pressed while it did.
	heldFor: async function (f) {
		var hold = turnHold({ diamondId: f.id });
		// Confirmed against the mailbox before the tile is refused (R53-U8b, QU8 Q4).
		if (hold) {
			await confirmHold({ diamondId: f.id });
			hold = turnHold({ diamondId: f.id });
		}
		// In the neutral voice, as the refusal in the thread is (Q6-3): a pause is
		// the person's, not a fault.
		if (hold) toast(DaimondModels.pauseError(hold).message);
		return !!hold;
	},

	// There was a `sweep` here, which took off the tiles whose action had
	// already happened elsewhere. Everything it could remove was a `draft`
	// whose file had gone; with that kind deleted its first test kept every
	// item, so it walked the list and could not change it. Gone with the kind
	// it served, along with its callers at boot and in the mail deps. A consent
	// tile is not swept: it is answered, dropped, or marked expired by `load`.

	/// Discuss it: back to the daimon that raised it, with the details already
	/// sent. Phase E is what gave this somewhere to land -- before it there was
	/// no conversation to return the user TO.
	discuss: async function (it) {
		var f = (pg.diamonds || []).find(function (x) { return x.id === it.diamondId; });
		var drawn = f ? Pending.drawnFor(f) : '';	// at the press (STEER D4), as Do it takes it
		// Where the conversation it would open is held, the discussion cannot start:
		// nothing is declined and the tile stays, for once play is pressed (Q6-2).
		if (f && await Pending.heldFor(f)) return;
		// Discussing an ACT is declining it. The worker cannot wait on a
		// conversation — it is holding a tool call open — and a yes arrived at
		// three messages later would be a yes to a turn that had already been
		// told no. So it is refused first, and the talking happens afterwards.
		if (it.kind === 'consent') settleConsent(it.id, 'deny');
		if (!f) {
			// A consent tile often has no Diamond on it: the engine's payload
			// carries no actor, so the app only names one when exactly one
			// worker was running. Saying that is better than "the Diamond is
			// gone", which would be a claim about something that was never there.
			toast(it.kind === 'consent'
				? t('pending.consent.nochat') : t('pending.diamond_gone'), true);
			Pending.drop(it.id);
			return;
		}
		Pending.drop(it.id);
		await selectDiamond(f, 'chat');
		var text = t('pending.discuss_prompt', { headline: it.headline })
			+ (it.detail ? '\n\n' + it.detail : '');
		await Pending.send(f, text, drawn);
	},
};
// page-split: install 103

// ── A runner update waiting for his tap, as one Pending tile (KS-p4) ────────
//
// A runner on this machine that has built a new version of itself parks a request on the
// relay (gateway `runner_relay.rs`) and waits for the person to approve it with his passkey
// on `runner.daimond.app/approve#<nonce>`. Before this, that request was a URL and a QR in a
// log nobody reads (design 20261018 §3.4 rev 2). So the page asks the relay, and anything
// waiting on him reaches the one place he looks: Pending.
//
// THE INSTALL ID COMES FROM THE HAND, as its `runner-install:` cap, read from the runner's
// world-readable `/etc/kimberlite/trust.jdat` (ksgpe_plan L4). No hand, or a hand on a
// machine with no runner, and there is nothing to ask about: no request is made at all.
//
// AT MOST ONE TILE, the newest open request by its manifest `seq` (the build's UTC seconds):
// an older build waiting under a newer one is not a second thing to do, since approving the
// newer one supersedes it. The tile goes when its entry is gone from the relay (swapped, or
// lapsed), or once the runner marks it DONE; a relay that cannot be read takes nothing down. An entry the
// runner's witness has raised an alarm on is NOT offered for approval: it becomes a
// high-priority notice instead, told once. Nothing else the relay holds (an enrol, an
// answered entry) raises anything -- the importance filter.
//
// Polled once a minute while the page is visible, at once when it becomes visible, and
// never while it is hidden. The relay answers same-origin only (no CORS), so the path is
// relative.
//
// The tile carries the Approve link, which on his phone opens the approve page directly,
// and its QR for a desktop viewer. THE ITEM RIDES DaimondAlerts (ALERT-PENDING, lead ruling
// L3): raised under `DaimondAlerts.RUNNER` as a needs-him item, it syncs to every device, so a
// request a desktop's runner parked reaches his phone. `runnerSettle` is its ONE writer:
// `Pending.add` refuses the kind, and the engine's door refuses the keys.
//
// DONE, AND THE TAPPING DEVICE (RA-DONE). An answered guarded entry stays open, since the
// answer may be one the runner refuses, so "answered" alone takes nothing down; the tile
// used to stay on every device until the entry lapsed (600 s after the runner's last
// re-post). Now the runner, once it has swapped to a verified binary, marks the entry `done`
// on the relay (gateway `Relay::done`, by its own key), and every device takes the tile down
// on that mark. The mark follows the verified swap, not the answer: under the default
// Unattended policy the runner ignores the answer; only under an attended policy is the
// answer checked before the swap. And the device he tapped
// on does not wait for a runner that may be offline. THE RULE: a device that opened this
// tile's Approve link for nonce N (`runnerTapped`, kept in this device's own storage, never
// synced) holds N's tile down ON THIS DEVICE ALONE while the relay lists N answered, not
// done, with more answers than this device saw when he tapped, AND N has not been posted
// since the tap (the post time read off `expires_in` against the relay's TTL, on this
// device's clock, with `RUNNER_TAP_SLACK_MS`; once held, against the post time first held
// (`pt`), within `RUNNER_POST_JITTER_MS`). The synced item is neither raised nor
// cleared for it, so every other device keeps the tile until the done mark. A runner that
// refuses the answer re-posts the entry at once (kimberlite `relay.rs`), and a re-post after
// the tap ends the hold, so a refusal brings the tile back here too; a new request (a new
// nonce and seq) was never tapped, and shows.
//
// A DEVICE WITH NO RUNNER OF ITS OWN (his phone, the common case) polls nothing above, so
// the item carries its install id (the synced detail, `<commit> <install>`: the install id
// is no secret, relay_v2), the tap keeps it, and `runnerTapPoll` reads that install's
// listing at the same cadence, ONLY while a tap there is waiting for its answer or held.
// The same rule judges the tapped entry, and the tap's state is kept with it: `held` (down
// here), `done` (the runner's mark: down here, and the poll stops), `back` (re-posted after
// the tap: shown, and the poll stops). It also stops when the entry is no longer listed (the
// tap is dropped) or, never answered, after the relay's TTL. This poll raises and clears
// nothing synced: the runner's own machine stays the one writer. A tap WAITING for its
// answer (not yet held, done or back) is polled at once, on visibility return, and every
// `RUNNER_TAP_POLL_MS` for `RUNNER_TAP_WINDOW_MS` after the tap (`runnerTapFast`), since the
// minute poll left the tile up a minute after his tap; then the minute poll alone.
var RUNNER_POLL_MS    = 60 * 1000;
var RUNNER_APPROVE    = 'https://runner.daimond.app/approve#';
var RUNNER_RELAY      = '/api/runner/relay?install=';
var RUNNER_RELAY_ONE  = '/api/runner/relay?nonce=';
var RUNNER_INSTALL_RE = /^[A-Za-z0-9_-]{16,64}$/;
var RUNNER_NONCE_RE   = /^[A-Za-z0-9_-]{22}$/;
var RUNNER_KEY        = 'runner.';			// alerts.js page keys: the tile ...
var RUNNER_ALARM      = 'runner-alarm.';		// ... and a witness alarm
var RUNNER_TTL_S      = 600;				// the relay's TTL (gateway RELAY_TTL_SECS)
var RUNNER_TAPPED     = 'daimond-runner-tapped';	// this device's taps, by nonce: never synced
var RUNNER_TAP_SLACK_MS = 5000;				// a post this near the tap is not after it (first held read)
var RUNNER_POST_JITTER_MS = 1500;			// expires_in rounding (1 s) and a little: the same post
var RUNNER_TAP_POLL_MS   = 3000;			// a waiting tap's short cadence ...
var RUNNER_TAP_WINDOW_MS = 3 * 60 * 1000;		// ... for this long after the tap
var _runnerTapTimer   = null;
var _runnerWatching   = false;
var _runnerSeen       = {};				// nonce -> answers the last poll listed
var _runnerHeld       = {};				// nonce -> held down on this device (see the header)

/// How many answers a relay entry lists: its `answers` when read by the nonce, else one
/// for `answered`.
function runnerAnswers(e) {
	if (Array.isArray(e.answers)) return e.answers.length;
	return e.answered ? 1 : 0;
}

/// This device's taps, `{nonce: {at, n}}`.
function runnerTaps() {
	var v = null;
	try { v = JSON.parse(localStorage.getItem(RUNNER_TAPPED) || '{}'); } catch (e) { v = null; }
	return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

function runnerTapsSave(v) {
	try { localStorage.setItem(RUNNER_TAPPED, JSON.stringify(v)); } catch (e) { /* storage full or off: no hold */ }
}

/// He opened the Approve link for `nonce` on this device: note when, and the request's
/// `install` (from the synced item) for a device with no runner to poll by. How many answers
/// the entry lists is UNKNOWN at the tap (`n: null`; a count from an older poll may be stale,
/// and his phone has none): the tap's own immediate read, fired here before the approve page
/// can land his answer, fills it in, so an answer already there (a junk one) holds nothing
/// down, and a tap whose count is still unknown holds nothing down (QA-B LOW-3').
/// A second tap on a request whose tile is still his to answer keeps the first's count, so
/// his own first answer is not taken for a junk one; after a re-post (`back`) it starts again.
function runnerTapped(nonce, install) {
	if (!RUNNER_NONCE_RE.test(String(nonce || ''))) return;
	var v = runnerTaps();
	var was = v[nonce];
	var inst = RUNNER_INSTALL_RE.test(String(install || '')) ? String(install) : (was && was.inst) || '';
	if (was && typeof was.at === 'number' && was.state !== 'back') {
		v[nonce] = { at: was.at, n: runnerTapCount(was), inst: inst, pt: was.pt };
	} else {
		v[nonce] = { at: Date.now(), n: null, inst: inst };
	}
	runnerTapsSave(v);
	runnerTapFast();
	return runnerPoll();			// the own listing (settle) and any tapped install's
}

/// A tap's answer count, or null while no read since the tap has filled it in.
function runnerTapCount(tp) {
	return (tp && typeof tp.n === 'number' && isFinite(tp.n) && tp.n >= 0) ? tp.n : null;
}

/// Whether a tap here waits for its answer inside the short window.
function runnerTapWaiting() {
	var taps = runnerTaps(), now = Date.now();
	return Object.keys(taps).some(function (n) {
		var tp = taps[n];
		return !!(tp && tp.inst && typeof tp.at === 'number' && !tp.state && now - tp.at < RUNNER_TAP_WINDOW_MS);
	});
}

/// The short cadence while a tap waits: one timer, re-armed only while one still waits.
function runnerTapFast() {
	if (_runnerTapTimer || !runnerTapWaiting()) return;
	_runnerTapTimer = setTimeout(async function () {
		_runnerTapTimer = null;
		if (!runnerTapWaiting()) return;
		if (!document.hidden) await runnerTapPoll(runnerInstall());
		runnerTapFast();
	}, RUNNER_TAP_POLL_MS);
}

/// Whether this device's tap holds `nonce` down by its kept state (`runnerTapPoll`). The
/// kept state judges only a tap on ANOTHER install: on the runner's own machine the live
/// `_runnerHeld` is the one judge, so a state kept before the hand reported (QA-B MED-4)
/// cannot outlive a refusal there.
function runnerTapHolds(nonce) {
	var tp = runnerTaps()[nonce], own = runnerInstall();
	if (!tp || (own && tp.inst === own)) return false;
	return tp.state === 'held' || tp.state === 'done';
}

/// A tap's next state from its entry `e` as the relay lists it now (see the header), or
/// null when the tap is over and dropped.
function runnerTapState(tp, e, now) {
	if (!e) return null;
	if (e.done === true) return 'done';
	if (runnerHeld(e, { x: tp }, now, 'x')) return 'held';
	if (e.answered && runnerAnswers(e) > (Number(tp.n) || 0)) return 'back';
	if (tp.state === 'held') return 'back';			// held, and no longer: re-posted
	return now - tp.at > RUNNER_TTL_S * 1000 ? null : '';
}

/// The listing for one install with each release entry read whole by its nonce (its
/// `answers`), or null when it could not be read.
async function runnerRead(inst) {
	var j = null;
	try {
		var r = await fetch(RUNNER_RELAY + encodeURIComponent(inst), { cache: 'no-store', credentials: 'omit' });
		if (!r || !r.ok) return null;
		j = await r.json();
	} catch (e) { return null; }
	if (!j || j.ok !== true || !Array.isArray(j.entries)) return null;
	// A guarded entry (relay_v2, QA-B 2) is listed by its nonce and flags alone: its body
	// and alarm note are read by the nonce, which this page holds and the install id does not give.
	return Promise.all(j.entries.map(async function (e) {
		if (!e || typeof e.body === 'string' || !RUNNER_NONCE_RE.test(String(e.nonce || ''))) return e;
		if (!e.alarmed && e.kind !== 'release') return e;
		try {
			var r1 = await fetch(RUNNER_RELAY_ONE + encodeURIComponent(e.nonce), { cache: 'no-store', credentials: 'omit' });
			var one = (r1 && r1.ok) ? await r1.json() : null;
			return (one && one.ok === true) ? one : e;
		} catch (err) { return e; }
	}));
}

/// The poll of a device's taps on requests another machine's runner made (see the header):
/// each install with a tap waiting or held is read once, and nothing synced is written.
/// Resolves true when any listing was read.
async function runnerTapPoll(own) {
	var taps = runnerTaps(), now = Date.now(), byInst = {}, read = false, changed = false;
	Object.keys(taps).forEach(function (n) {
		var tp = taps[n];
		if (!tp || typeof tp.at !== 'number' || now - tp.at > 24 * 3600 * 1000) { delete taps[n]; changed = true; return; }
		if (!tp.inst || tp.inst === own || tp.state === 'done' || tp.state === 'back') return;
		(byInst[tp.inst] = byInst[tp.inst] || []).push(n);
	});
	for (var inst in byInst) {
		var list = await runnerRead(inst);
		if (!list) continue;
		read = true;
		var by = {};
		list.forEach(function (e) { if (e && RUNNER_NONCE_RE.test(String(e.nonce || ''))) by[e.nonce] = e; });
		byInst[inst].forEach(function (n) {
			var e = by[n];
			if (e) _runnerSeen[n] = runnerAnswers(e);
			if (e && runnerTapCount(taps[n]) === null) { taps[n].n = runnerAnswers(e); changed = true; }	// the first read since the tap
			var pt0 = taps[n].pt;
			var st = runnerTapState(taps[n], e || null, now);
			if (taps[n].pt !== pt0) changed = true;				// the post it first held against
			if (st === null) { delete taps[n]; changed = true; return; }
			if (st !== (taps[n].state || '')) { taps[n].state = st || undefined; changed = true; }
		});
	}
	if (changed) runnerTapsSave(taps);
	if (read || changed) { Pending.fresh(); Pending.render(); }
	return read;
}

/// Whether entry `e` is held down on this device by his tap here. See the header.
function runnerHeld(e, taps, now, at) {
	var tp = taps[at || e.nonce];
	if (!tp || typeof tp.at !== 'number' || !e.answered || e.done === true) return false;
	var n0 = runnerTapCount(tp);
	if (n0 === null || runnerAnswers(e) <= n0) return false;		// no count yet: holds nothing
	var left = Number(e.expires_in);
	if (!isFinite(left)) return false;
	var posted = now - (RUNNER_TTL_S - left) * 1000;
	// Held against the post seen when the tap first read as held, never the tap time: a
	// refusal re-posted within seconds of the tap is a new post, and the tile comes back.
	if (typeof tp.pt === 'number' && isFinite(tp.pt)) return posted <= tp.pt + RUNNER_POST_JITTER_MS;
	if (posted > tp.at + RUNNER_TAP_SLACK_MS) return false;
	tp.pt = posted;			// the first held read: kept with the tap by the caller
	return true;
}

/// The runner install id the hand reported, or '' when it reported none.
function runnerInstall() {
	var v = '';
	try { v = (window.DaimondHand && DaimondHand.runnerInstall) ? String(DaimondHand.runnerInstall() || '') : ''; }
	catch (e) { v = ''; }
	return RUNNER_INSTALL_RE.test(v) ? v : '';
}

/// What one relay entry's body says of its release: `{commit, seq}`. The body is the
/// runner's own JSON, the manifest's fields at the top or under `manifest`; anything
/// unreadable is an empty commit and seq 0, so it still shows, and sorts as the oldest.
function runnerBody(e) {
	var b = null;
	try { b = JSON.parse(String(e.body || '')); } catch (err) { b = null; }
	if (b && b.manifest && typeof b.manifest === 'object') b = b.manifest;
	var commit = (b && typeof b.commit === 'string') ? b.commit.slice(0, 64) : '';
	var seq = (b && typeof b.seq === 'number' && isFinite(b.seq) && b.seq > 0) ? Math.floor(b.seq) : 0;
	return { commit: commit, seq: seq };
}

/// Put the panel as the relay's entries for this install say. See the header.
function runnerSettle(entries) {
	var A = window.DaimondAlerts;
	if (!A || !A.RUNNER) return;
	var list = Array.isArray(entries) ? entries : [];
	var best = null;
	var taps = runnerTaps(), now = Date.now(), listed = {}, tapsChanged = false;
	_runnerSeen = {};
	_runnerHeld = {};
	list.forEach(function (e, i) {
		if (!e || !RUNNER_NONCE_RE.test(String(e.nonce || ''))) return;
		listed[e.nonce] = true;
		_runnerSeen[e.nonce] = runnerAnswers(e);
		var tp0 = taps[e.nonce];
		if (tp0 && typeof tp0 === 'object' && runnerTapCount(tp0) === null) { tp0.n = runnerAnswers(e); tapsChanged = true; }	// the first read since the tap
		if (e.alarmed) {
			// Raised again in the same words it answers `same` or `dismissed`: told once.
			A.raise(A.RUNNER, RUNNER_ALARM + e.nonce, 'runner alarm', String(e.alarm || '').slice(0, 200), true);
			return;
		}
		// A guarded entry's answer may be one the runner refuses, and the request stays open
		// until the runner marks it done, or the relay no longer lists it.
		if (e.kind !== 'release' || e.done === true || (e.answered && !Array.isArray(e.answers))) return;
		var pt0 = tp0 && tp0.pt;
		if (runnerHeld(e, taps, now)) _runnerHeld[e.nonce] = true;
		if (tp0 && tp0.pt !== pt0) tapsChanged = true;			// the post it first held against
		var seq = runnerBody(e).seq;
		if (!best || seq > best.seq || (seq === best.seq && i > best.i)) best = { e: e, seq: seq, i: i };
	});
	var newest = best ? best.e : null;
	var r = newest ? runnerBody(newest) : null;
	var want = newest ? runnerKey(newest.nonce, r.seq, r.commit) : '';
	A.live().forEach(function (a) {
		if (a.diamond === A.RUNNER && a.key.indexOf(RUNNER_KEY) === 0 && a.key !== want) A.clear(A.RUNNER, a.key);
	});
	// A tap here holds the newest down on this device alone: not raised, and not cleared, so
	// the other devices keep it until the done mark.
	var held = !!(newest && _runnerHeld[newest.nonce]);
	// Locale-free words, so two devices in two languages raise the very same item and do not
	// rewrite it in turn; the panel words it (`runnerItem`).
	// The detail carries the install id, for a device with no runner of its own to poll by.
	if (want && !held) A.raise(A.RUNNER, want, 'runner update', (r.commit || '?') + ' ' + runnerInstall(), true);
	var kept = {}, pruned = false, own = runnerInstall();
	Object.keys(taps).forEach(function (n) {
		var tp = taps[n];
		if (!(listed[n] || (tp && tp.inst && tp.inst !== own))) { pruned = true; return; }
		// An own-install tap is judged live here (`_runnerHeld`), never by a kept state (MED-4).
		if (tp && own && tp.inst === own && tp.state !== undefined) { delete tp.state; pruned = true; }
		kept[n] = tp;
	});
	if (pruned || tapsChanged) runnerTapsSave(kept);
	Pending.fresh();
	Pending.render();
}

/// The synced key of one request: its nonce, then what the tile shows of it (the build's
/// seq and a short commit), so the item carries all it draws. Within `KEY_MAX` (64).
function runnerKey(nonce, seq, commit) {
	var n = (typeof seq === 'number' && isFinite(seq) && seq > 0 && seq < 1e12) ? Math.floor(seq) : 0;
	return RUNNER_KEY + nonce + '.' + n + '.' + String(commit || '').replace(/[^0-9A-Za-z]/g, '').slice(0, 12);
}

/// One synced runner item as a Pending tile, or null for a key this build cannot read.
function runnerItem(a) {
	var k = String(a.key || '');
	if (k.indexOf(RUNNER_ALARM) === 0) {
		return { id: 'a:' + a.id, kind: 'notice', priority: 'high', at: a.at, needs: true,
			headline: t('pending.runner.alarm'), detail: t('pending.runner.alarm_detail', { note: a.detail || '' }) };
	}
	var p = k.indexOf(RUNNER_KEY) === 0 ? k.slice(RUNNER_KEY.length).split('.') : [];
	if (p.length !== 3 || !RUNNER_NONCE_RE.test(p[0])) return null;
	if (_runnerHeld[p[0]] || runnerTapHolds(p[0])) return null;	// his tap here holds it down (RA-DONE)
	var seq = Number(p[1]) || 0;
	var inst = String(a.detail || '').split(' ')[1] || '';
	return { id: 'a:' + a.id, kind: 'runner', priority: 'high', at: a.at, needs: true,
		headline: t('pending.runner.headline'), detail: t('pending.runner.detail', { commit: p[2] || '?' }),
		runner: { nonce: p[0], commit: p[2], seq: seq, install: RUNNER_INSTALL_RE.test(inst) ? inst : '' } };
}

/// Ask the relay once: this machine's own install, if its hand reported one, then any
/// install this device tapped a request of (`runnerTapPoll`). Resolves true when a listing
/// was read, false when there was nothing to ask (hidden, no install id, no tap) or no
/// answer to trust.
async function runnerPoll() {
	if (document.hidden) return false;
	var inst = runnerInstall();
	var read = false;
	if (inst) {
		var full = await runnerRead(inst);
		if (full) { runnerSettle(full); read = true; }
	}
	if (await runnerTapPoll(inst)) read = true;
	return read;
}

/// Start the minute poll, once per page.
export function runnerWatch() {
	if (_runnerWatching) return;
	_runnerWatching = true;
	setInterval(function () { runnerPoll(); }, RUNNER_POLL_MS);
	document.addEventListener('visibilitychange', function () { if (!document.hidden) { runnerPoll(); runnerTapFast(); } });
	runnerPoll();
}

/// The runner tile's own body: what is waiting, the Approve link and its QR. It has no
/// tick, no `?` and no ✕: it is answered on the approve page, and it goes when the relay
/// says the request is over.
function runnerTile(box, it) {
	var rn = it.runner || {};
	var url = RUNNER_APPROVE + String(rn.nonce || '');
	var when = document.createElement('div');
	when.className = 'rail-note pend-runner';
	var built = rn.seq ? new Date(rn.seq * 1000).toLocaleString() : '';
	when.textContent = t('pending.runner.built', { commit: rn.commit || '?', when: built || '?' });
	box.appendChild(when);
	var acts = document.createElement('div');
	acts.className = 'pend-acts';
	var go = document.createElement('a');
	go.className = 'pend-act pend-go pend-runner-approve';
	go.href = url;
	go.target = '_blank';
	go.rel = 'noopener noreferrer';
	go.textContent = t('pending.runner.approve');
	go.setAttribute('aria-label', t('pending.runner.approve'));
	go.addEventListener('click', function () { runnerTapped(rn.nonce, rn.install); });
	acts.appendChild(go);
	box.appendChild(acts);
	var qr = null;
	try {
		if (window.DaimondPairing && DaimondPairing.ui && DaimondPairing.ui.qrCanvas) qr = DaimondPairing.ui.qrCanvas(url);
	} catch (e) { qr = null; }
	if (qr) {
		qr.setAttribute('aria-label', t('pending.runner.qr'));
		box.appendChild(qr);
	}
}

// ── A runner asking to join, approved with his passkey (R2d1) ───────────────
//
// A computer of his that ran the install line has joined the gateway with its pairing token
// and its Ed25519 device key, and waits as a PENDING runner (gateway `runner_pair.rs`), which
// is no device until he approves it on a device he holds (native runner design §5). This
// raises that wait as one Pending tile per runner -- it NEEDS HIM, so it counts on the chip
// (the importance filter: a runner waiting on his approval is the one thing in the list
// that is his to do; an approved or removed runner raises nothing).
//
// APPROVE IS HIS PASSKEY, NOTHING LESS. The press asks the authenticator for the PRF secret
// (passkey.js `approveRunner`), which opens the account's sealed identity bundle; the tab
// seals that to the runner's device key with the Rust seal (`seal_runner_bundle`, S1) and
// posts only the sealed bytes with the approval. No assertion, no post: the gateway refuses
// an approve without the passkey handle, and never holds anything that opens the bundle.
//
// Refuse removes the pending runner (a join he does not recognise). The tile goes when the
// list no longer shows the runner pending -- approved, removed or lapsed, here or from
// another of his devices; a list that cannot be read takes nothing down. Polled with the
// relay poll's rhythm: once a minute while visible, at once on becoming visible, never hidden.
var RUNNER_PAIR_LIST      = '/api/runner/pair/list';
var RUNNER_PAIR_REMOVE    = '/api/runner/pair/remove';
var RUNNER_PAIR_DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;
var RUNNER_PAIR_KEY_RE    = /^[A-Za-z0-9_-]{43}$/;
var _runnerPairBusy       = {};
// The domain of a device key's fingerprint: must match kimberlite's DEVICE_FP_DOMAIN
// (kimberlite/src/pair.rs); the shared vector in runnerpairfp.test.mjs pins both.
var RUNNER_PAIR_FP_DOMAIN = 'kimberlite/device-fp/v1\0';

/// The fingerprint of a runner's device key (base64url, 32 bytes) as `kimberlite pair`
/// prints it: the first 8 bytes of SHA-256(domain || key) in four groups of four hex
/// digits (QA-B #1). '' for a key that is not 32 bytes or with no SubtleCrypto.
async function runnerPairFingerprint(pubkey) {
	try {
		var b64 = String(pubkey || '').replace(/-/g, '+').replace(/_/g, '/');
		while (b64.length % 4) b64 += '=';
		var bin = atob(b64);
		if (bin.length !== 32) return '';
		var dom = new TextEncoder().encode(RUNNER_PAIR_FP_DOMAIN);
		var msg = new Uint8Array(dom.length + 32);
		msg.set(dom, 0);
		for (var i = 0; i < 32; i++) msg[dom.length + i] = bin.charCodeAt(i);
		var d = new Uint8Array(await crypto.subtle.digest('SHA-256', msg));
		var hex = '';
		for (var j = 0; j < 8; j++) {
			if (j && j % 2 === 0) hex += ' ';
			hex += (d[j] < 16 ? '0' : '') + d[j].toString(16);
		}
		return hex;
	} catch (e) { return ''; }
}
// page-split: install 104

/// A pending runner as the tile keeps it, or null for one that is not usable.
function runnerPairShape(r) {
	if (!r || !RUNNER_PAIR_DEVICE_RE.test(String(r.device || ''))) return null;
	if (!RUNNER_PAIR_KEY_RE.test(String(r.pubkey || ''))) return null;
	return { device: String(r.device), pubkey: String(r.pubkey),
		name: String(r.name || '').slice(0, 64),
		joined: typeof r.joined === 'number' && isFinite(r.joined) ? r.joined : 0 };
}

/// Put the panel as the account's runner list says. See the header.
function runnerPairSettle(runners) {
	var waiting = {};
	(Array.isArray(runners) ? runners : []).forEach(function (r) {
		if (!r || r.state !== 'pending') return;
		var sh = runnerPairShape(r);
		if (sh) waiting[sh.device] = sh;
	});
	Pending.fresh();
	var kept = Pending.items.filter(function (x) {
		return x.kind !== 'runnerpair' || (!!x.runnerpair && !!waiting[x.runnerpair.device]);
	});
	if (kept.length !== Pending.items.length) { Pending.items = kept; Pending.save(); }
	Object.keys(waiting).forEach(function (dev) {
		var up = Pending.items.some(function (x) { return x.kind === 'runnerpair' && x.runnerpair && x.runnerpair.device === dev; });
		if (up) return;
		var w = waiting[dev];
		Pending.add({ kind: 'runnerpair', priority: 'high',
			headline: t('pending.runnerpair.headline', { name: w.name || t('pending.runnerpair.unnamed') }),
			detail: t('pending.runnerpair.detail'), runnerpair: w });
	});
}

/// Ask the gateway once. True when the list was read and the panel settled.
export async function runnerPairPoll() {
	if (document.hidden) return false;
	// No unlocked identity, no session to ask with: nothing to settle, and no 401 a minute.
	try { if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return false; }
	catch (e) { return false; }
	var j = null;
	try {
		var r = await fetch(RUNNER_PAIR_LIST, { cache: 'no-store', credentials: 'same-origin' });
		if (!r || !r.ok) return false;
		j = await r.json();
	} catch (e) { return false; }
	if (!j || j.ok !== true || !Array.isArray(j.runners)) return false;
	runnerPairSettle(j.runners);
	// A re-approval from any device clears this page's re-approval mark (M2).
	if (window.DaimondPeer && DaimondPeer.rekeyApproved && DaimondPeer.rekeyApproved(j.runners)) {
		try { renderSeatSwitch(); } catch (e) { /* the next beat redraws */ }
	}
	return true;
}

/// The press on Approve: his passkey, the seal, the approval. Resolves the passkey module's
/// answer, `{ ok }` or `{ ok:false, error }`; the tile is taken down only on success.
async function runnerPairApprove(it) {
	var rp = it && it.runnerpair;
	if (!rp || _runnerPairBusy[rp.device]) return { ok: false, error: '' };
	if (!window.DaimondPasskey || typeof DaimondPasskey.approveRunner !== 'function') {
		return { ok: false, error: t('pending.runnerpair.no_passkey') };
	}
	_runnerPairBusy[rp.device] = true;
	var res = null;
	try { res = await DaimondPasskey.approveRunner(rp.device, rp.pubkey); }
	catch (e) { res = { ok: false, error: t('pending.runnerpair.failed') }; }
	finally { delete _runnerPairBusy[rp.device]; }
	if (!res || !res.ok) return { ok: false, error: (res && res.error) || t('pending.runnerpair.failed') };
	Pending.drop(it.id);
	// Approved again: the keys sealed since a passphrase change open there now (M2). Other
	// devices clear their mark from the list's later `approved` stamp (`rekeyApproved`).
	if (window.DaimondPeer && DaimondPeer.clearRekey) { DaimondPeer.clearRekey(rp.device); try { renderSeatSwitch(); } catch (e) { /* next beat */ } }
	return { ok: true };
}

/// The press on Refuse: remove the pending runner at the gateway, then the tile.
async function runnerPairRefuse(it) {
	var rp = it && it.runnerpair;
	if (!rp) return false;
	try {
		var r = await DaimondGateway.gwFetch(RUNNER_PAIR_REMOVE, {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ device: rp.device }),
		});
		if (!r || !r.ok) return false;
	} catch (e) { return false; }
	Pending.drop(it.id);
	return true;
}

/// Start the minute poll, once per page.
var _runnerPairWatching = false;
export function runnerPairWatch() {
	if (_runnerPairWatching) return;
	_runnerPairWatching = true;
	setInterval(function () { runnerPairPoll(); }, RUNNER_POLL_MS);
	document.addEventListener('visibilitychange', function () { if (!document.hidden) runnerPairPoll(); });
	runnerPairPoll();
}

/// The tile's body: which computer, when it joined, Approve with passkey and Refuse.
function runnerPairTile(box, it) {
	var rp = it.runnerpair || {};
	var note = document.createElement('div');
	note.className = 'rail-note pend-runnerpair';
	var when = rp.joined ? new Date(rp.joined * 1000).toLocaleString() : '?';
	note.textContent = t('pending.runnerpair.joined', { when: when });
	box.appendChild(note);
	// The key, not the name, is what the approval seals to (QA-B #1): its fingerprint,
	// the one `kimberlite pair` printed. Approve waits until it is shown.
	var key = document.createElement('div');
	key.className = 'rail-note pend-runnerpair-key';
	box.appendChild(key);
	var acts = document.createElement('div');
	acts.className = 'pend-acts';
	var go = document.createElement('button');
	go.type = 'button';
	go.className = 'pend-act pend-go pend-runnerpair-approve';
	go.textContent = t('pending.runnerpair.approve');
	var no = document.createElement('button');
	no.type = 'button';
	no.className = 'pend-act pend-no pend-runnerpair-refuse';
	no.textContent = t('pending.runnerpair.refuse');
	go.addEventListener('click', async function () {
		go.disabled = true; no.disabled = true;
		var res = await runnerPairApprove(it);
		if (res.ok) { toast(t('pending.runnerpair.approved', { name: rp.name || t('pending.runnerpair.unnamed') })); return; }
		go.disabled = false; no.disabled = false;
		if (res.error) toast(res.error);
	});
	no.addEventListener('click', async function () {
		go.disabled = true; no.disabled = true;
		if (await runnerPairRefuse(it)) return;
		go.disabled = false; no.disabled = false;
		toast(t('pending.runnerpair.refuse_failed'));
	});
	acts.appendChild(go);
	acts.appendChild(no);
	box.appendChild(acts);
	go.disabled = true;
	return runnerPairFingerprint(rp.pubkey).then(function (fp) {
		if (!fp) return;
		key.textContent = t('pending.runnerpair.key', { fp: fp });
		go.disabled = no.disabled;
	});
}
// page-split: install 105
// ── What the ratings propose, as Pending tiles (Rating U7b) ─────────────────
//
// The PAGE, not a model, turns the trusted rating cells into at most a few tiles
// (`DaimondSteering.proposals`, steering.js; plan daimond_optimiser_532_plan_20261004.md
// §5 U7b): switch a Diamond's model (Switch, Dismiss), add a note (Add, Edit, Dismiss),
// review an active note (Keep, Remove). NOTHING APPLIES WITHOUT A PRESS (design decision
// 6 (a), J8) and Add writes exactly the line the tile shows, or the one the person edited it to.
//
// Raised after each digest write (`writeUsageDigest`), against the notes as the note file
// holds them: a proposal already answered, here or on another device, is not in the list,
// and its tile is taken down. Pending does not sync, so the note file is what makes a
// dismissal stick on every device (P7). Every press asks the same question again first,
// since a tile can be minutes old.
//
// THE NOTE FILE IS NOT THIS UNIT'S. U6b (lane S) writes it, as `window.DaimondNotes` (its log, "The note
// writer U7b calls"), and every write there re-applies the steering before it resolves. It is reached
// through `steerApi` alone, by the names in one table, so that a rename is made in one place. With no
// writer nothing is raised: a tile whose Add had nowhere to write would be a lie.
var STEER_API = {
	read:    ['DaimondNotes',    'list'],		// () -> Promise<entry[]>, every Diamond's notes and the account's
	add:     ['DaimondNotes',    'add'],			// ({ level, scope, cm, tag, line, at })
	keep:    ['DaimondNotes',    'keep'],		// ({ level, scope, id }, n) -> entry, or null when the file holds no such id
	retire:  ['DaimondNotes',    'retire'],		// ({ level, scope, id }, at) -> entry, or null
	dismiss: ['DaimondNotes',    'dismiss'],		// ({ level, scope, cm, tag, at, to })
	switched:['DaimondNotes',    'switched'],	// ({ scope, cm, to, at }): a Switch pressed, on file for its review (P5)
	back:    ['DaimondNotes',    'back'],			// ({ level, scope, id }, { at, cm, to, n }) -> entry, or null: Switch back closes the review and dismisses the switch
	lint:    ['DaimondSteering', 'refusal'],		// (line) -> '' when admitted, else the engine's code
};
var STEER_LINE_MAX = 200;							// bytes: the engine's own limit, for the page that has no lint to ask
var _steerRun = null, _steerAgain = false;

/// The one door to the note file: the function the table names for `op`, or null.
function steerApi(op) {
	var e = STEER_API[op], o = e && window[e[0]];
	return o && typeof o[e[1]] === 'function' ? o[e[1]].bind(o) : null;
}

/// Run one note-file operation. Never throws: `{ ok: false }` where there is no writer or it rejected.
async function steerStore(op, a, b) {
	var f = steerApi(op);
	if (!f) return { ok: false, why: 'unavailable' };
	try { return { ok: true, value: await f(a, b) }; }
	catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
}

/// Every note the files hold, or null when they cannot be read (and nothing is then raised or taken down).
async function steerNotes() {
	var r = await steerStore('read', true);			// forced: a press and a raise take the files as they are now
	return r.ok && Array.isArray(r.value) ? r.value : null;
}

/// A model this device can run for the catalogue id `cm`, on the provider the Diamond uses where it can; or null.
function steerTarget(cm, id) {
	if (!window.DaimondModels || !window.DaimondPricing || !cm) return null;
	var now = id ? diamondModel(id) : { provider: '' }, got = null;
	DaimondModels.all().forEach(function (m) {
		if (DaimondPricing.identify(m.model).cm !== cm || !DaimondModels.resolve(m.provider, m.model)) return;
		if (!got || (m.provider === now.provider && got.provider !== now.provider)) got = { provider: m.provider, model: m.model };
	});
	return got;
}

/// The model a Switch back puts a Diamond on: the one it left, provider and id as the `switched` entry
/// holds them, where this device can still run it; else the same model on a provider it can run (an
/// entry with no record of the provider, or one whose provider has since lost its key); or null.
function steerReturn(p) {
	var w = p && p.was;
	if (w && w.model && window.DaimondModels && DaimondModels.resolve(w.provider || '', w.model)) return { provider: w.provider || '', model: w.model };
	return steerTarget(p && p.to, p && p.scope);
}

/// What `proposals` needs of the page: each Diamond with the catalogue id of the model it runs on now.
function steerCtx() {
	return {
		diamonds: (pg.diamonds || []).map(function (f) {
			var m = diamondModel(f.id);
			return { d: f.id, name: f.name || '', cm: window.DaimondPricing && m.model ? DaimondPricing.identify(m.model).cm : '' };
		}),
		t: function (k) { return t(k); },
	};
}

/// The proposals, less a switch (or a switch back) to a model this device cannot run (its press could do nothing).
function steerProposals(roll, notes) {
	return DaimondSteering.proposals(roll, notes, steerCtx()).filter(function (p) {
		return (p.kind !== 'switch' && p.kind !== 'back') || !!(p.kind === 'back' ? steerReturn(p) : steerTarget(p.to, p.scope));
	});
}

/// The tile for one proposal, in words. Numbers and model ids only: no note, no name of a reaction (J9).
function steerRecord(p) {
	var ev = p.evidence || {}, head, why, acct = p.level !== 2;
	if (p.kind === 'switch') {
		head = t('pending.steer.switch_head', { to: p.to });
		why  = t('pending.steer.switch_why', { from: p.key, to: p.to, fn: (ev.from && ev.from.n) | 0, tn: (ev.to && ev.to.n) | 0 });
	} else if (p.kind === 'back') {
		head = t('pending.steer.back_head', { model: p.key, to: p.to });
		why  = t('pending.steer.back_why', { n: ev.n | 0, up: ev.up | 0, down: ev.down | 0 });
	} else if (p.kind === 'note') {
		head = t('pending.steer.note_head', { model: p.key });
		why  = t('pending.steer.note_why', { down: ev.down | 0, n: ev.n | 0, tagged: ev.tagged | 0 });
	} else {
		var b = ev.before || {}, a = ev.after || {};
		head = t('pending.steer.review_head', { model: p.key });
		why  = t('pending.steer.review_why', { bt: b.t | 0, bn: b.n | 0, at: a.t | 0, an: a.n | 0 });
	}
	return {
		id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
		diamondId: acct ? '' : p.scope, diamondName: acct ? t('pending.steer.account') : (p.name || ''),
		headline: head, detail: why, kind: 'steer', priority: 'low', at: Date.now(), steer: p,
	};
}

/// Make the `steer` tiles what `list` (the page's current proposals) says: raise the ones not
/// yet here, and take down the ones no longer proposed, because another device pressed them, a
/// rating moved the figures or the model changed. One read and one write, as `Pending.add`
/// does, and no badge: see the Pending header. A tile already up is left as it was raised, so
/// that what Add writes is what the person was shown (J8). `make` builds a tile from a proposal.
function steerSettle(list, make) {
	Pending.fresh();
	var want = {}, have = {};
	list.forEach(function (p) { want[p.id] = p; });
	var kept = Pending.items.filter(function (x) {
		if (x.kind !== 'steer') return true;
		if (!x.steer || !want[x.steer.id]) return false;
		have[x.steer.id] = 1;
		return true;
	});
	var fresh = list.filter(function (p) { return !have[p.id]; }).map(make);
	if (kept.length === Pending.items.length && !fresh.length) return;
	Pending.items = kept.concat(fresh);
	Pending.save();
}

/// Put the tiles as the figures and the notes say. Coalesced: a call during a pass asks for one more.
export function steerRaise() {
	if (_steerRun) { _steerAgain = true; return _steerRun; }
	_steerRun = (async function () {
		try {
			do {
				_steerAgain = false;
				if (!window.DaimondSteering || !window.DaimondSteering.proposals || !window.DaimondRatingRoll) return;
				var notes = await steerNotes();
				if (!notes) continue;				// the note file cannot be read: raise nothing, take nothing down
				var acct = await ratingsAccount();
				steerSettle(steerProposals(acct.roll, notes), steerRecord);
			} while (_steerAgain);
		} catch (e) { /* a panel that will not draw must not fail the digest */ }
		finally { _steerRun = null; _steerAgain = false; }
	})();
	return _steerRun;
}

/// Is this proposal still one the figures and the notes make? null when that cannot be known.
async function steerStillHolds(p) {
	var notes = await steerNotes();
	if (!notes) return null;
	var acct = await ratingsAccount();
	return steerProposals(acct.roll, notes).some(function (q) { return q.id === p.id; });
}

/// Why a line may not be added, or '' when it may. The engine's lint where there is one; its code is worded here.
function steerLintMsg(v) {
	if (!v) return t('pending.steer.empty');
	var f = steerApi('lint'), code = '';
	if (f) { try { code = String(f(v) || ''); } catch (e) { code = ''; } }
	else if (new TextEncoder().encode(v).length > STEER_LINE_MAX) code = 'long';
	if (!code) return '';
	if (code === 'empty') return t('pending.steer.empty');
	var why = code === 'long' ? t('pending.steer.why_long')
		: code === 'rating' ? t('pending.steer.why_rating')
		: (code === 'pleasing' || code === 'agreeing' || code === 'approval') ? t('pending.steer.why_tone')
		: code === 'control' ? t('pending.steer.why_control')
		: code === 'heading' ? t('pending.steer.why_heading') : code;
	return t('pending.steer.refused', { why: why });
}

/// One press. Returns whether it took effect. Checked against the notes and figures as they are now first.
async function steerPress(it, act, line) {
	var p = it.steer, ok = false;
	if (!p) { Pending.drop(it.id); return false; }
	var holds = null;
	try { holds = await steerStillHolds(p); } catch (e) { /* unknown */ }
	if (holds === null) { toast(t('pending.steer.failed'), true); return false; }
	if (!holds) { toast(t('pending.steer.gone')); Pending.drop(it.id); steerRaise(); return false; }
	var note = p.evidence && p.evidence.note, scope = p.level === 2 ? p.scope : '';
	var at = { t: p.at.t | 0, n: p.at.n | 0 }, r;
	if (act === 'switch' || act === 'back') {
		var f = (pg.diamonds || []).find(function (x) { return x.id === p.scope; }), tg = act === 'back' ? steerReturn(p) : steerTarget(p.to, p.scope);
		if (!f || !tg) { toast(t('pending.steer.no_model', { to: p.to }), true); return false; }
		if (act === 'switch') {
			// On file first, so that no Switch goes without its review (P5): the rated answers of the model it
			// goes to, in this Diamond, as they stand now.
			// The whole model it leaves goes with it, provider and id, so that Switch back restores that one.
			var acct = await ratingsAccount(), c0 = acct && acct.roll ? DaimondRatingRoll.cell(acct.roll, 2, f.id, 'cm', p.to) : null, left = diamondModel(f.id);
			r = await steerStore('switched', { scope: f.id, cm: p.key, to: p.to, at: { t: 0, n: c0 ? c0.n | 0 : 0 }, was: { provider: left.provider || '', model: left.model || '' } });
			if (!r.ok) { toast(t('pending.steer.failed'), true); return false; }
		} else {
			// Switch back closes the review the way Keep does, and dismisses the switch it undoes in the same write
			// (the cooling rule's own entry: the model it returns to, the one it tried, the returned-to model's
			// rated answers now), so that the same Switch is not offered again at once; then it moves the model.
			var acctB = await ratingsAccount(), cB = acctB && acctB.roll ? DaimondRatingRoll.cell(acctB.roll, 2, scope, 'cm', p.to) : null;
			r = await steerStore('back', { level: 2, scope: scope, id: note }, { at: at, cm: p.to, to: p.key, n: cB ? cB.n | 0 : 0 });
			if (!r.ok) { toast(t('pending.steer.failed'), true); return false; }
			if (r.value === null) { toast(t('pending.steer.gone')); Pending.drop(it.id); steerRaise(); return false; }
		}
		// `setDiamondModel` re-applies the steering for the model now in force (U6b, C6).
		await changeDiamondModel(f.id, diamondModel(f.id), tg);
		if (pg.currentDiamond && pg.currentDiamond.id === f.id) await refreshDiamondAfterChange();
		else { bumpDiamonds(); await loadDiamonds(); }
		ok = true;
	} else {
		if (act === 'add') {
			r = await steerStore('add', { level: p.level, scope: scope, cm: p.key, tag: p.tag, line: line || p.line, at: at });
		} else if (act === 'dismiss') {
			r = await steerStore('dismiss', p.kind === 'switch'
				? { level: 2, scope: scope, cm: p.key, tag: 'switch', at: at, to: p.to }
				: { level: p.level, scope: scope, cm: p.key, tag: p.tag, at: at });
		} else if (act === 'keep') {
			// A switch review has no note to mark: its Keep closes it, as a Remove closes a note.
			r = p.kind === 'back' ? await steerStore('retire', { level: p.level, scope: scope, id: note }, at)
				: await steerStore('keep', { level: p.level, scope: scope, id: note }, at.n);
		} else if (act === 'remove') {
			r = await steerStore('retire', { level: p.level, scope: scope, id: note }, at);
		} else return false;
		if (!r.ok) { toast(t('pending.steer.failed'), true); return false; }
		// The file holds no such note any more: nothing was written, and the tile has no note to answer.
		if ((act === 'keep' || act === 'remove') && r.value === null) { toast(t('pending.steer.gone')); Pending.drop(it.id); steerRaise(); return false; }
		ok = true;
	}
	Pending.drop(it.id);
	steerRaise();
	return ok;
}

/// Edit: the line in a field, linted as it is typed, then Add with the line as edited.
async function steerEdit(it) {
	var v = await promptDialog(t('pending.steer.edit_title'), {
		value: it.steer.line, okLabel: t('pending.steer.add'), live: steerLintMsg, validate: steerLintMsg, lines: 4,
	});
	return v ? steerPress(it, 'add', v) : false;
}

/// The change `c` (`{ text, rows, more }`, as `held_change::diff` makes it) drawn into `box` as
/// History draws a diff: the change ask's tile and a runner turn's "Changed your file" alike.
export function changeDiff(box, c) {
	if (c.text === false) {
		var none = document.createElement('div');
		none.className = 'rail-note pend-change-none';
		none.textContent = t('versions.cannot_compare');
		box.appendChild(none);
	} else if (Array.isArray(c.rows) && c.rows.length) {
		var pre = document.createElement('div');
		pre.className = 'hist-diff';
		c.rows.forEach(function (r) {
			var ln = document.createElement('div');
			var k = String((r && r.k) || ' ');
			// The marker column (+, -, blank) is drawn by the role in CSS, as in History, so every
			// line's text starts at one edge; a fold says its count in words, not a typed glyph.
			ln.className = 'hist-diff-line' + (k === '+' ? ' add' : k === '-' ? ' del' : k === '~' ? ' fold' : '');
			ln.textContent = k === '~' ? tn('change.same', r.n | 0, { n: r.n | 0 }) : String(r.t || '');	// escaped via textContent
			pre.appendChild(ln);
		});
		box.appendChild(pre);
	}
	if ((c.more | 0) > 0) {
		var more = document.createElement('div');
		more.className = 'rail-note pend-change-more';
		more.textContent = tn('change.more', c.more | 0, { n: c.more | 0 });
		box.appendChild(more);
	}
}

/// The body and the buttons of a change ask's tile (called by `Pending.tile`, UNBLOCK-26
/// U5): where the file is, the change as History draws one, Apply and Don't Change. No
/// discuss: the turn is held on this answer, and a turn sent to talk about it would be a
/// second one beside it.
function changeTile(box, it) {
	var c = it.change || {}, at = changeName(c.path);
	var line = document.createElement('div');
	line.className = 'pend-line pend-change-head';
	line.textContent = it.headline;
	box.appendChild(line);
	var where = document.createElement('div');
	where.className = 'rail-note pend-change-in';
	where.textContent = t('change.in', { folder: at.folder })
		+ (c.act === 'move' && c.to ? ' · ' + t('change.move_to', { to: String(c.to) }) : '');
	box.appendChild(where);
	// Asked here for a turn another device is running: which one.
	if (it.detail) {
		var from = document.createElement('div');
		from.className = 'rail-note pend-change-from';
		from.textContent = it.detail;
		box.appendChild(from);
	}
	changeDiff(box, c);
	if (it.expired) {
		var gone = document.createElement('div');
		gone.className = 'rail-note pend-consent';
		gone.textContent = t('change.expired');
		box.appendChild(gone);
	}
	var acts = document.createElement('div');
	acts.className = 'pend-acts';
	function btn(cls, label, fn) {
		var b = document.createElement('button');
		b.type = 'button'; b.className = 'pend-act pend-verb ' + cls; b.textContent = label;
		b.addEventListener('click', fn);
		acts.appendChild(b);
		return b;
	}
	// An expired tile has nothing behind it: only the record is left to clear.
	if (!it.expired) btn('pend-go', t('change.apply'), function () { Pending.execute(it); });
	btn('pend-no', it.expired ? t('common.dismiss') : t('change.keep'), function () { Pending.drop(it.id); });
	box.appendChild(acts);
}

/// The body and the buttons of a `steer` tile (called by `Pending.tile`): the line Add would write, always in view.
function steerTile(box, it) {
	var p = it.steer, acts = document.createElement('div');
	acts.className = 'pend-acts';
	function btn(cls, label, fn) {
		var b = document.createElement('button');
		b.type = 'button'; b.className = 'pend-act pend-verb ' + cls; b.textContent = label;
		b.addEventListener('click', async function () {
			var all = acts.querySelectorAll('button');
			all.forEach(function (x) { x.disabled = true; });		// one press at a time
			try { await fn(); } finally { all.forEach(function (x) { x.disabled = false; }); }
		});
		acts.appendChild(b);
	}
	if (!p) btn('pend-no', t('common.dismiss'), function () { Pending.drop(it.id); });
	else {
		if (p.line) {
			var ln = document.createElement('div');
			ln.className = 'pend-detail pend-steer-line';
			ln.textContent = p.line;
			box.appendChild(ln);
		}
		if (p.kind === 'switch') {
			btn('pend-go', t('pending.steer.switch'), function () { return steerPress(it, 'switch'); });
			btn('pend-no', t('common.dismiss'),       function () { return steerPress(it, 'dismiss'); });
		} else if (p.kind === 'note') {
			btn('pend-go', t('pending.steer.add'),    function () { return steerPress(it, 'add'); });
			btn('',        t('pending.steer.edit'),   function () { return steerEdit(it); });
			btn('pend-no', t('common.dismiss'),       function () { return steerPress(it, 'dismiss'); });
		} else if (p.kind === 'back') {
			btn('pend-go', t('pending.steer.keep'),   function () { return steerPress(it, 'keep'); });
			btn('',        t('pending.steer.back'),   function () { return steerPress(it, 'back'); });
		} else {
			btn('pend-go', t('pending.steer.keep'),   function () { return steerPress(it, 'keep'); });
			btn('pend-no', t('pending.steer.remove'), function () { return steerPress(it, 'remove'); });
		}
	}
	box.appendChild(acts);
}

// ── The Steering list (Rating U7c) ──────────────────────────
//
// Every active note, so that a person can see what the model is told and take any of it away at any
// time (design §9.5, the Steering view, in its smallest real form; U9 grows the prompt-as-sent and
// the evidence from this same component). Each row has the line exactly as it is sent, the scope (this
// diamond or the account), the model (one, or all) and the day it was added. Remove is `retire`, through
// `steerStore` and the `STEER_API` table: the one write path every note press uses, so a removal re-applies
// the steering and, because it records the figures of that day (`retireAt`), the note is not proposed
// again until 20 more rated answers. A list is drawn where a person looks for it: the Diamond's Models
// area (its notes and the account's) and the account's Model stats page (every note).

function steerEl(tag, cls, text) {
	var e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
}

/// Take a note away: record the figures of today and retire it. Never throws.
async function steerRemove(n) {
	var roll = null;
	try { roll = (await ratingsAccount()).roll; } catch (e) { roll = null; }
	var at = DaimondSteering.retireAt(roll, { level: n.level, scope: n.scope, cm: n.cm, tag: n.tag });
	var r = await steerStore('retire', { level: n.level, scope: n.scope, id: n.id }, at);
	if (!r.ok) { toast(t('pending.steer.failed'), true); return false; }
	steerRaise();			// a review tile for this note, or a proposal it was holding, is settled again
	return true;
}

/// Draw the Steering list into `host`, and again whenever the notes change. `opts.diamond` is a
/// Diamond's id for its view (its notes and the account's), else every note; `opts.empty` is the class
/// the empty-state line wears where it is drawn.
export function steerListMount(host, opts) {
	opts = opts || {};
	host.classList.add('steer-list');
	host.setAttribute('data-steer-list', opts.diamond ? 'diamond' : 'account');
	var seq = 0;
	async function draw() {
		var mine = ++seq, notes = await steerNotes();
		if (mine !== seq || !host.isConnected) return;			// a later draw has the say, or the page was redrawn
		host.textContent = '';
		if (!notes) { host.appendChild(steerEl('div', opts.empty || 'mdash-empty', t('steer.unreadable'))); return; }
		// The model each Diamond runs, as the notes name it, so that the list can say which note a turn would not be told.
		var groups = DaimondSteering.listing(notes, {
			diamonds: (pg.diamonds || []).map(function (f) { return { d: f.id, name: f.name || '', cm: Notes.cmOf(diamondModel(f.id).model) }; }),
			diamond: opts.diamond || '', refuse: function (l) { return Notes.refusal(l); } });
		if (!groups.length) { host.appendChild(steerEl('div', (opts.empty || 'mdash-empty') + ' steer-empty', t('steer.empty'))); return; }
		groups.forEach(function (g) {
			g.notes.forEach(function (n) {
				var row = steerEl('div', 'steer-row'), foot = steerEl('div', 'steer-foot');
				row.setAttribute('data-note', n.id);
				row.appendChild(steerEl('div', 'pend-detail pend-steer-line steer-line', n.line));
				if (n.off) {
					var why = n.off === 'model' ? t('steer.off_model') : n.off === 'diamond' ? t('steer.off_diamond')
						: n.off === 'refused' ? t('steer.off_refused') : t('steer.off_taken');
					var off = steerEl('div', 'pend-head steer-meta steer-off', why);
					off.setAttribute('data-off', n.off);
					row.appendChild(off);
				}
				var who = n.level === 3 ? t('steer.scope_account') : t('steer.scope_diamond', { name: g.name || g.scope.slice(0, 8) });
				var day = n.added ? window.DaimondTime.fmtLocal(n.added, 'day') : '';
				foot.appendChild(steerEl('div', 'pend-head steer-meta', [who, n.cm === 'all' ? t('steer.model_all') : n.cm]
					.concat(day ? [t('steer.added', { date: day })] : []).join(' \u00b7 ')));
				var rm = steerEl('button', 'pend-act pend-verb pend-no steer-rm', t('pending.steer.remove'));
				rm.type = 'button';
				rm.setAttribute('aria-label', t('steer.remove_aria', { line: n.line }));
				rm.addEventListener('click', async function () {
					rm.disabled = true;
					try { await steerRemove(n); } finally { rm.disabled = false; }
				});
				foot.appendChild(rm);
				row.appendChild(foot);
				host.appendChild(row);
			});
		});
	}
	Notes.views.push({ live: function () { return host.isConnected; }, draw: draw });
	draw();
	return draw;
}
// page-split: install 106

// ── Credits (the Daimond gateway) ──────────────────────────────
// Daimond is free and BYOK by default; credits are for the user who does not want
// to hold a provider key at all. The gateway is optional — if it is down, the
// app carries on exactly as before and simply offers nothing here.
// ── The five-year term ─────────────────────────────────────
//
// Pro is a FIVE-YEAR licence. It gates sync, cloud storage and Email, which
// are services Oxedyne has to keep running, and a licence with no end to a
// service is a promise to run it for ever. Terms §7 says so and the gateway
// enforces it, so no surface in this app may imply otherwise -- least of all
// the two that stand at the point of sale, `showPro` and `renderPro`.
//
// Three functions, used from both this scope and `DaimondAdmin`'s.

/// The day the current paid month ends, in the reader's language, or '' when
/// the gateway has not named one.
/// Is the subscription paused for inactivity? The ethical auto-pause, shown
/// warmly rather than as a lapse: billing stopped while the account was away
/// and resumes the moment it is used again.
export function proPaused(st)  { return !!(st && st.proStatus === 'paused'); }
/// Is a payment failing, with Stripe still retrying inside the grace window?
function proPastDue(st) { return !!(st && st.proStatus === 'past_due'); }
/// Has the subscription ended -- cancelled, and no longer granting?
export function proHasEnded(st) { return !!(st && st.proStatus === 'canceled' && !st.pro); }

/// The one sentence a subscriber sees about where their subscription stands:
/// paused, past-due, renewing, or -- with none -- what a fresh one costs.
export function proTermLine(st) {
	if (proPaused(st))  return t('pro.paused_note');
	if (proPastDue(st)) return t('pro.past_due_note');
	var when = st && st.proPeriodEnd ? window.DaimondTime.fmtLocal(st.proPeriodEnd * 1000, 'dayLong') : '';
	if (st && st.pro && when) return t('pro.renews_on', { date: when });
	return t('pro.term_note');
}

/// What the button on a Pro offer says, and it must match what the checkout
/// will do. A paused subscription is resumed, not bought again; anything else
/// with no live subscription is a fresh monthly subscribe.
export function proBuyLabel(st, price) {
	if (proPaused(st)) return t('pro.resume');
	return price ? t('pro.subscribe_priced', { price: price }) : t('pro.subscribe');
}

/// The Pro block at the top of the Credits drawer: an offer to subscribe to
/// Daimond Pro, the confirmation that it is held with a way to cancel, or the
/// warm note that billing is paused with a way to resume. Pro is the $8/month
/// subscription that turns on cross-device sync, cloud storage and Email;
/// credits are separate and pay for metered use (inference, bandwidth),
/// whether or not Pro is held.
function renderPro() {
	var host = document.getElementById('credits-pro');
	if (!host || !window.DaimondGateway) return;
	var st = DaimondGateway.state();
	host.innerHTML = '';
	// No account, or the gateway is unreachable: the Pro offer needs one, so
	// say nothing here rather than a dead button. The packs area below
	// already carries the "create an account" path.
	if (st.offline || !st.authed || st.pro === null) return;

	// Held and active: confirm it, show where it stands, and offer to cancel
	// at the period end. An approaching auto-pause is noted once.
	if (st.pro && !proPaused(st)) {
		var owned = document.createElement('div');
		owned.className = 'pro-owned';
		owned.innerHTML = t('pro.owned') + ' ' + proTermLine(st)
			+ (st.proWarned ? '<p class="pro-fine">' + t('pro.warned_soon') + '</p>' : '')
			+ '<button class="pro-link" id="pro-cancel">' + t('pro.cancel') + '</button>'
			+ '<div class="pro-err" id="pro-err"></div>';
		host.appendChild(owned);
		var cbtn = document.getElementById('pro-cancel');
		if (cbtn) cbtn.addEventListener('click', function () { showPro(); });
		return;
	}

	// Paused for inactivity: shown warmly, with one tap to resume. No trip to
	// Stripe and no re-purchase -- the subscription is still theirs.
	if (proPaused(st)) {
		var paused = document.createElement('div');
		paused.className = 'pro-offer';
		paused.innerHTML =
			'<p><b>' + t('pro.paused_head') + '</b></p>'
			+ '<p>' + t('pro.paused_note') + '</p>'
			+ '<button class="pro-buy" id="pro-buy">' + t('pro.resume') + '</button>'
			+ '<div class="pro-err" id="pro-err"></div>';
		host.appendChild(paused);
		bindProAction('resume');
		return;
	}

	// Otherwise an offer to subscribe. The price says US dollars out loud and
	// hangs the converted figure off it. See `billing.usd_note` below.
	var price = st.proPriceMinor ? DaimondGateway.fmtBilled(st.proPriceMinor, st.currency) : '';
	var box = document.createElement('div');
	box.className = 'pro-offer';
	box.innerHTML =
		t('pro.offer')
		+ '<p class="pro-fine">' + t('pro.fine') + '</p>'
		+ '<button class="pro-buy" id="pro-buy">' + proBuyLabel(st, price) + '</button>'
		+ (usdDisplay() ? '' : '<p class="pro-fine">' + t('billing.usd_note') + '</p>')
		+ '<div class="pro-err" id="pro-err"></div>';
	host.appendChild(box);
	bindProAction('buy');
}

/// Wire the primary button in the Pro block: 'buy' navigates to Stripe
/// checkout, 'resume' resumes a paused subscription in place. Kept in one
/// place so the two paths share the same disable/redraw/error handling and
/// the Credits drawer never loses its balance to a fault here.
function bindProAction(kind) {
	var btn = document.getElementById('pro-buy');
	if (!btn) return;
	btn.addEventListener('click', async function () {
		btn.disabled = true;
		try {
			if (kind === 'resume') {
				await DaimondGateway.resumePro();
				renderPro();
			} else {
				var r = await DaimondGateway.buyPro();   // navigates to Stripe, or returns {held}
				if (r && r.held) { await DaimondGateway.refreshLicence(); renderPro(); }
			}
		} catch (e) {
			var err = document.getElementById('pro-err');
			if (err) err.textContent = friendlyError(e);
			btn.disabled = false;
		}
	});
}

/// Any amount in the gateway's range, typed in the display currency and
/// billed as the presets are: the dollars charged are shown beside it.
function otherAmount(note) {
	var row = document.createElement('div');
	row.className = 'credit-other';
	var inp = document.createElement('input');
	inp.type = 'text';
	inp.id = 'credit-other-input';
	inp.setAttribute('inputmode', 'decimal');
	inp.autocomplete = 'off';
	inp.placeholder = usdDisplay() ? t('credits.other') : t('credits.other') + ' · ' + DaimondI18n.currency();
	inp.setAttribute('aria-label', inp.placeholder);
	var bil = document.createElement('span');
	bil.className = 'pack-billed';
	var buy = document.createElement('button');
	// The row's one primary action, drawn as Subscribe and Unlock are; the packs beside it are amounts.
	buy.className = 'credit-buy';
	buy.textContent = t('credits.buy');
	buy.disabled = true;
	// Either separator, so "12,50" reads as twelve and a half wherever typed.
	var tier = function () { return DaimondI18n.tierFor(inp.value.trim().replace(',', '.')); };
	// What the typed amount charges, said under the row as each preset says its own.
	var quo = document.createElement('span');
	quo.className = 'pack-billed pack-quote';
	inp.addEventListener('input', function () {
		var tr = tier();
		buy.disabled = !tr;
		note.textContent = '';
		bil.textContent = (tr && !usdDisplay()) ? tr.billedText : '';
		var qt = tr ? DaimondGateway.quoteText(tr.billedMinor) : null;
		quo.textContent = qt ? qt.charged + ' · ' + qt.breakdown : '';
	});
	inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !buy.disabled) buy.click(); });
	buy.addEventListener('click', async function () {
		var tr = tier();
		if (!tr) return;
		var why = DaimondGateway.creditRefusal(tr.billedMinor);
		if (why) { note.textContent = why; return; }
		buy.disabled = true;
		try { await DaimondGateway.buyCredits(tr.billedMinor); }   // navigates to Stripe
		catch (e) { note.textContent = friendlyError(e); buy.disabled = false; }
	});
	row.appendChild(inp);
	row.appendChild(bil);
	row.appendChild(buy);
	row.appendChild(quo);
	return row;
}

export function renderCredits() {
	var sec  = document.getElementById('credits-section');
	var bal  = document.getElementById('credits-balance');
	var wrap = document.getElementById('credits-packs');
	var note = document.getElementById('credits-note');
	if (!sec || !bal || !wrap || !window.DaimondGateway) return;
	// The Pro block is a self-contained offer at the top of the drawer. It
	// must never take the rest of Credits down with it, so a fault in it is
	// contained here rather than left to break the balance and the packs.
	try { renderPro(); } catch (e) { /* the offer is absent; Credits still works. */ }
	var st = DaimondGateway.state();

	if (st.offline || !st.authed) {
		bal.textContent = '';
		wrap.innerHTML = '';
		if (st.offline) {
			note.textContent = t('credits.offline');
		} else {
			// A stranger with no account was told to "create an account" with no
			// way to do so from here. The way forward is now a button, not a
			// sentence: buying credits needs an account, so offer to make one.
			// Not while the gateway is refusing NEW accounts. This device already
			// has an identity, so `showIdentity('create')` would mint a SECOND
			// local one -- which is not the way in, and cannot become one while
			// the beta is closed. `DaimondPasscode` draws the way in just above
			// this, so say the true thing and offer nothing that would refuse.
			var refused = (DaimondGateway.state() || {}).refused;
			note.textContent = t(refused ? 'credits.need_passcode' : 'credits.need_account');
			if (!refused) {
				var make = document.createElement('button');
				make.className = 'credit-pack';
				make.textContent = t('credits.create_account');
				make.addEventListener('click', function () { showIdentity('create'); });
				wrap.appendChild(make);
			}
		}
		return;
	}

	note.textContent = '';
	// The balance is a meter, not a charge: it is a price tag like any other
	// estimate, converted where the reader asked for another currency.
	DaimondI18n.fillPrices(bal, st.credits === null
		? t('credits.balance_unavailable')
		: t('credits.balance', { amount: DaimondI18n.priceMarkMinor(st.credits, st.currency) }));

	// A door to the full breakdown of where credits (and inference) go. The
	// header spend meter is the other door, but it hides when there is no
	// inference spend, so a credits-only user needs this one. Added once.
	// Made once, but LABELLED every time: built inside the creation guard, the
	// text kept whatever language the drawer was first opened in and every
	// later language change went past it.
	var seeSpend = document.getElementById('credits-see-spend');
	if (!seeSpend) {
		seeSpend = document.createElement('button');
		seeSpend.id = 'credits-see-spend';
		seeSpend.className = 'admin-item';
		seeSpend.addEventListener('click', function () { if (window.DaimondSpend) DaimondSpend.show(); });
		bal.insertAdjacentElement('afterend', seeSpend);
	}
	seeSpend.textContent = t('credits.see_spend');

	wrap.innerHTML = '';
	// The amounts on sale are the gateway's (UNBLOCK-19/20): asked once, then
	// drawn. Until it answers there is nothing to offer; if it cannot, say so.
	if (!DaimondGateway.hasOffer()) {
		DaimondGateway.creditOffer().then(renderCredits, function () {
			note.textContent = t('credits.offer_unavailable');
		});
		return;
	}
	// A shop offers €10, not €9.26. The tiers are snapped to round prices in
	// whatever currency is on show, and the dollar amount that will actually
	// reach the card is printed beside each one. With dollars selected these
	// are the gateway's own presets, unchanged.
	var tiers = DaimondI18n.niceTiers(DaimondGateway.packs());
	tiers.forEach(function (tier) {
		var b = document.createElement('button');
		b.className = 'credit-pack';
		if (usdDisplay()) {
			b.textContent = tier.localText;
		} else {
			var loc = document.createElement('span');
			loc.className = 'pack-local';
			loc.textContent = tier.localText;
			var bil = document.createElement('span');
			bil.className = 'pack-billed';
			// The separator is in the text rather than the stylesheet, so the
			// two figures never run together whatever the skin does with them.
			bil.textContent = ' · ' + tier.billedText;
			b.appendChild(loc);
			b.appendChild(bil);
			b.title = t('billing.usd_note');
		}
		// WHAT THE CARD IS CHARGED (r578e G1): the credit, the model host's fee and the card
		// and conversion fees, as the gateway prices them, so Stripe's page holds no surprise.
		var qt = DaimondGateway.quoteText(tier.billedMinor);
		if (qt) {
			var tot = document.createElement('span');
			tot.className = 'pack-billed pack-quote';
			tot.textContent = qt.charged;
			var brk = document.createElement('span');
			brk.className = 'pack-billed pack-quote';
			brk.textContent = qt.breakdown;
			b.appendChild(tot);
			b.appendChild(brk);
		}
		b.addEventListener('click', async function () {
			b.disabled = true;
			// The charge is the DOLLAR figure. The round local price is what
			// was chosen; what is billed is what is shown beside it.
			try { await DaimondGateway.buyCredits(tier.billedMinor); }   // navigates to Stripe
			catch (e) { note.textContent = friendlyError(e); b.disabled = false; }
		});
		wrap.appendChild(b);
	});
	wrap.appendChild(otherAmount(note));
	if (!usdDisplay()) {
		var pn = document.createElement('p');
		pn.className = 'cfg-fieldnote pack-note';
		pn.textContent = t('billing.usd_note') + ' ' + t('billing.rates_as_of', { date: DaimondI18n.ratesAsOf() });
		wrap.appendChild(pn);
	}
}

/// Attach to the gateway once the identity is unlocked (its auth is a signed
/// challenge, so it cannot run while locked), then show what came back.
/// Turn a credit balance into models to run.
///
/// Credits bought everything the app does except the thing the app is for: a user with $10
/// in their account could fetch pages, send mail and sync with it, and the model picker
/// still said "no model connected". A balance is now a provider row like any other -- the
/// key is minted by the gateway instead of pasted by the user, and the browser calls the
/// provider directly with it exactly as it does with a key of the user's own. Daimond is
/// not in the inference path here either, which is the entire point of the product and the
/// reason this is a minted key rather than a proxy.
///
/// Fire-and-forget, like everything hanging off the gateway: a credits row that cannot be
/// built must never disturb a user who only ever wanted their own key.
export async function syncCredits() {
	if (!window.DaimondModels || !window.DaimondGateway) return;
	var st = DaimondGateway.state();
	try {
		await DaimondModels.syncCredits({
			authed:   st.authed,
			credits:  st.credits,
			currency: st.currency,
			offline:  st.offline,
		});
	} catch (e) { /* the row says why; nothing else needs to know. */ }
	syncCfgFromModels();
	DaimondAdmin.status();
}

export async function connectGateway() {
	if (!window.DaimondGateway) return;
	// THE HEAP, PART BY PART, AND THIS IS WHY.
	//
	// The phone's trail says the heap is 1 MB through five boot steps and
	// 235 MB by the time this function resolves, then 1639 MB half a second
	// later, and then the tab is killed. It was first read as the Diamond walk,
	// because the walk's `list entry` lines were the only clock ticks visible
	// in that window — but `probe_diamondheap` then showed fifteen Diamonds
	// with seven hundred and fifty version files between them cost NOTHING.
	// So the walk is not it, and this function is where the growth actually
	// straddles. Its parts are separated here so the next trail says which.
	//
	// Growth only, so a healthy boot writes nothing at all.
	var was = 0;
	try { was = Math.round(heap_bytes() / 1048576); } catch (e) { /* older bundle */ }
	var grew = function (part) {
		var now = 0;
		try { now = Math.round(heap_bytes() / 1048576); } catch (e) { return; }
		if (now > was) { trail('HEAP GREW', part + ' +' + (now - was) + 'M -> ' + now + 'M'); was = now; }
	};
	await DaimondGateway.bootstrap();
	grew('gw.bootstrap');
	renderCredits();
	updateSpend();
	DaimondAdmin.status();          // the credits and the account dot just changed
	grew('credits+spend+admin');
	// bootstrap() has just read the balance, so this is the first moment the models a
	// balance buys can be known. A first-time user with credits and no key of their own
	// goes from "no model connected" to several hundred models here, and nowhere else.
	//
	// STILL FIRE-AND-FORGET. It was tempting to `await` it so its cost landed
	// against its own name, and that would have been a behaviour change wearing
	// an instrument's clothes: a slow or hanging credits row would then hold up
	// the boot, which is the one thing the comment above forbids. Measured in a
	// callback instead, settled either way so a rejection cannot escape.
	var afterCredits = function () { grew('syncCredits'); };
	try { syncCredits().then(afterCredits, afterCredits); }
	catch (e) { afterCredits(); }
	// And the same for the lists behind the user's OWN keys. `syncCredits` above re-asks the
	// minted row's catalogue after every mint, so that one row has been current since the
	// day it was built; a key the user pasted had nothing whatever doing this for it, and a
	// catalogue read once at pasting is the catalogue that provider had that day. Keys are
	// unsealed by this point in the boot, so there is something to ask with.
	//
	// Fire-and-forget like everything else on this path, and silent: the gate inside decides
	// whether any of it becomes a request, and a provider that refuses says nothing to a
	// user who did not ask.
	if (window.DaimondModels) DaimondModels.refreshLists();
	// The Email panel's entitlement is a signed read, so it could not have
	// been fetched at boot -- the identity was still locked. Ask now that
	// there is a session, or a returning user is told the account service is
	// unreachable when it is fine.
	if (window.DaimondMail && DaimondPanels.isOpen('mail')) { DaimondMail.onOpen(); }
	grew('mail.onOpen');
	// And what this account has unlocked, for the same reason: at boot there was no
	// session to ask under, so the rail could count what Daimond is born with and
	// nothing the user has bought.
	if (window.DaimondTools) DaimondTools.reload();
	grew('tools.reload');
	// There is a session now, so the sync engine can reach its mailbox: pull
	// the other devices' state and begin pushing this one's. Fire-and-forget,
	// like everything else that hangs off the gateway.
	try { window.dispatchEvent(new Event('daimond:authed')); } catch (e) { /* best effort */ }
	grew('authed dispatch');
	// IMMEDIATELY AFTER THE DISPATCH, and that is the whole reason it is
	// here. `passcode.js` listens for the same event and restores a recorder
	// for an account that has already agreed; its listener has run by the
	// time this line does, so this is the first moment in the session at
	// which there can be one. In a FIRST session -- where the consent card
	// has not been answered yet -- there is none, and the number is dropped
	// rather than kept for later. Consent is not retroactive.
	if (!pg.openSaid && pg.openMs) { pg.openSaid = true; tel('app.open', pg.openMs); }
}
// page-split: install 107

/// Bill one Diamond turn -- a steer, a fold proposal -- to the Diamond that ran it.
///
/// `diamondId` is a parameter, not derived from `app`: the object knows nothing of the Diamond
/// it was built for. It used to be read off `currentDiamond` inside `recordSpend`
/// instead, which is a different variable with the same name in it -- every caller here is
/// past an await, and a fold that lands after the user has moved on was billed to wherever
/// they moved to.
// `turnId` is passed through to `recordSpend` for a caller that IS one turn (a
// daimon steer); a fold proposal is not, and its callers pass none -- see the
// parameter comment on `recordSpend`.
export function meterDiamondTurn(app, diamondId, turnId) {
	if (!app || !window.DaimondLedger) return null;
	// A held app reads zero, and a zero kept as the reading bills its whole total again
	// next time; it is read once it has settled (r578c T, `appSpend`).
	if (app.turn_held) return null;
	var prev = pg._diamondMeter.get(app) || { p: 0, c: 0, ca: 0, cost: 0 };
	var p = app.prompt_tokens || 0, c = app.completion_tokens || 0;
	var ca = app.cached_tokens || 0, cost = app.cost_usd || 0;
	var dp = Math.max(0, p - prev.p), dc = Math.max(0, c - prev.c);
	var dca = Math.max(0, ca - prev.ca), dcost = Math.max(0, cost - prev.cost);
	pg._diamondMeter.set(app, { p: p, c: c, ca: ca, cost: cost });
	if (dp + dc === 0) return null;
	try {
		return recordSpend(_diamondAppModel.get(app) || pg.cfg.model, dp, dc, dca, dcost,
			_diamondAppProvider.get(app) || '', diamondId || '', turnId || '');
	} finally {
		updateSpend();
	}
}

/// Fold an arbitrary delta (an agent's summary, say) into a Diamond, through
/// the same advisory path a chat fold takes: propose, show the diff, and let
/// the user accept or veto.
export async function foldDeltaInto(diamondId, delta, sourceName, sourceRun) {
	var f = pg.diamonds.find(function (x) { return x.id === diamondId; });
	if (!f) { noticeDialog(t('fold.diamond_gone'), t('fold.diamond_gone_body')); return; }
	if (!diamondCanRun(diamondId)) {
		openSettings(t('fold.no_key'));
		return;
	}
	// One writer per crystal; see `foldChatInto`.
	if (diamondBusy(diamondId)) {
		noticeDialog(t('fold.busy_title'), t('fold.busy_body', { diamond: f.name }));
		return;
	}
	await selectDiamond(f);
	setCrystalBusy(diamondId, true); setCrystalStatus('Proposing fold…', true);
	var cur, proposed;
	var fa = claimDaimon(daimonApp(diamondId, null, diamondEffort(diamondId)));	// the Diamond's own client and model, not the starred one
	try {
		cur = await fa.read_crystal_data(diamondId);
		proposed = await fa.fold_propose(diamondId, delta);
	} catch (e) {
		meterDiamondTurn(fa, diamondId);
		setCrystalStatus(friendlyError(e)); setCrystalBusy(diamondId, false); return;
	} finally {
		daimonSettled(fa);
	}
	meterDiamondTurn(fa, diamondId);
	setCrystalStatus(''); setCrystalBusy(diamondId, false);
	// A reducer that returned nothing has FAILED: applying it would wipe the crystal.
	// The same guard `foldChatInto` keeps, kept here too — it is not the review, and
	// it reads the envelope's crystal for the reason given there.
	if (!foldEnvelope(proposed) || !String(foldEnvelope(proposed).crystal || '').trim()) {
		noticeDialog(t('fold.stage_failed'), t('fold.empty_reply'));
		return;
	}
	// One click commits (owner decision 2026-09-04): a worker's summary folds
	// straight into the crystal, no Accept/Reject. `commitFold` marks the source
	// run folded so its tile does not offer the same text again.
	var st = {
		base: cur, proposed: proposed, delta: delta,
		chatId: null, chatName: sourceName, sourceRun: sourceRun || null,
	};
	var landed;
	try {
		landed = await commitFold(diamondId, st);
	} catch (e) {
		setCrystalStatus(friendlyError(e));
		noticeDialog(t('fold.stage_failed'), friendlyError(e));
		return;
	}
	if (!landed.changed) {
		noticeDialog(t('fold.stage_unchanged'), t('fold.unchanged_body', { diamond: f.name }));
		return;
	}
	renderDiamondList();
	toast(landed.said || t('fold.committed', { diamond: f.name }));
}

export function install() { // page-split: install
	// page-split: install 101
	// A service like the others: what each agent is told, and the way to change
	// it. Exposed so the Admin panel, the verifiers and anything added later all
	// go through the one implementation rather than reading the files again.
	window.DaimondPrompts = Prompts;
	// page-split: install 102

	// ── The steering notes ─────────────────────────────────────────
	//
	// A note is one line told to one model (or to every model) in a turn. `steering.js` holds the
	// rules and the file's format; this is the half that touches the world: the files, the
	// engine and the apps built from it (U6b of 5.3.2).
	//
	// WHERE THEY LIVE. A Diamond's notes are `.daimond/steering.md` inside that Diamond, and the
	// account's notes (which also reach an ordinary chat) are the same file inside the Daimond
	// Optimiser. A Diamond travels in its export from every device, a folder-mounted desktop
	// included, where a file in Daimond's own store would not (checked: C1). INSIDE `.daimond/`
	// AND NOT BESIDE THE CRYSTAL, for two reasons the engine already settles: every tool a daimon
	// holds is refused a write there (`is_keeper_record`), so a page a daimon read cannot talk it
	// into rewriting its own instructions for good; and a share or a template never carries it.
	//
	// A WRITE IS TWO CALLS. `store_write` is a raw write and moves no stamp, so the file would be
	// the one thing in the Diamond the next sync did not carry (checked: C2). `touch_diamond` is
	// what stamps it, as every other page door does (`writeCappRecord`).
	//
	// WHAT A TURN READS is kept in memory and read synchronously, because a chat is built
	// and a daimon's app handed out by synchronous calls. The files are re-read when a Diamond's
	// stamp moves (a sync, an edit), through `loadDiamonds`, and the apps and chats are told
	// when what a turn would be told has changed.
	/* var */ Notes = {
		by:      {},                   // Diamond id -> { stamp, entries }, as the file read at that stamp
		views:   [],                   // the Steering lists on screen, each a function that draws itself again
		applied: new WeakMap(),        // app -> { Diamond id -> the text its daimon was last given }
		_load:   Promise.resolve(),

		home: function (level, scope) {
			return level === 3 ? DEFAULT_IDS.Lucy : String(scope || '');
		},

		path: function (id) { return 'diamonds/' + id + '/' + DaimondSteering.FILE; },

		/// The engine's lint on a line: '' where it may enter a prompt, else why not. Where the engine
		/// has no lint (an older one) every line is let through here and the engine composes as it can.
		refusal: function (line) {
			try {
				if (typeof Wasm.steering_refusal !== 'function') return '';
				return String(Wasm.steering_refusal(String(line == null ? '' : line)) || '');
			} catch (e) { return ''; }
		},

		/// The model's id as the ratings file it: the catalogue's `cm`, else the string as it stands.
		cmOf: function (model) {
			try {
				var id = window.DaimondPricing && DaimondPricing.identify(model || '');
				if (id && id.cm) return String(id.cm);
			} catch (e) { /* the string stands */ }
			return String(model || '');
		},

		/// Is `cm` a family (what several models share) and not one model? A note is for a model.
		isFamily: function (cm) {
			try {
				var id = window.DaimondPricing && DaimondPricing.identify(cm);
				return !!(id && id.fam && id.fam === cm && id.cm !== cm);
			} catch (e) { return false; }
		},

		/// Every note the page holds, as `proposals` reads them.
		all: function () {
			var out = [], by = this.by;
			Object.keys(by).forEach(function (id) { out.push.apply(out, by[id].entries); });
			return out;
		},

		/// What one turn is told, one note per line: `diamondId` is '' for an ordinary chat.
		steerFor: function (model, diamondId) {
			var self = this;
			return DaimondSteering.text(DaimondSteering.select(this.all(), this.cmOf(model), diamondId || '',
				{ refuse: function (l) { return self.refusal(l); } }));
		},

		/// Hand a Diamond's daimon the notes it is to be told on `model`. A Diamond's client is shared by
		/// every Diamond on one provider and model, so the engine keeps the notes per Diamond id and
		/// this is called with the Diamond's own. Cheap where nothing changed.
		applyTo: function (app, diamondId, model) {
			if (!app || !diamondId || typeof app.set_steering !== 'function') return;
			var text = this.steerFor(model, diamondId), held = this.applied.get(app);
			if (!held) { held = {}; this.applied.set(app, held); }
			if ((held[diamondId] || '') === text) return;
			try { app.set_steering('daimon', diamondId, text); held[diamondId] = text; }
			catch (e) { trail('steering apply failed', diamondId + ': ' + ((e && (e.message || e)) || '?')); }
		},

		/// A Diamond's model has changed (`setDiamondModel`): the client it now uses is another one,
		/// and the old one must not go on holding its notes.
		reapply: function (id) {
			var self = this;
			try {
				var a = appCfgFor(diamondModel(id)), now = _daimonApps.get(diamondAppKey(a) + '\u0000' + String(id || ''));
				everyDiamondClient(function (app) {
					if (app === now) self.applyTo(app, id, a.model);
					else if (app && (self.applied.get(app) || {})[id]) {
						try { app.set_steering('daimon', id, ''); self.applied.get(app)[id] = ''; } catch (e) { /* an older engine */ }
					}
				});
			} catch (e) { /* the page is not up yet */ }
			// Which notes a turn is told depends on the model, so a list on screen says it again.
			this.views = this.views.filter(function (v) { return v.live(); });
			this.views.forEach(function (v) { try { v.draw(); } catch (e) { /* a list that will not draw */ } });
		},

		/// What a note change reaches: every built daimon client, and the chats whose own notes moved.
		changed: function () {
			var self = this;
			this.views = this.views.filter(function (v) { return v.live(); });
			this.views.forEach(function (v) { try { v.draw(); } catch (e) { /* a list that will not draw */ } });
			try {
				(pg.diamonds || []).forEach(function (d) {
					var a = appCfgFor(diamondModel(d.id)), app = _daimonApps.get(diamondAppKey(a) + '\u0000' + String(d.id || ''));
					if (app) self.applyTo(app, d.id, a.model);
				});
			} catch (e) { /* no Diamonds yet */ }
			try {
				// A chat is built with its prompt composed, so one told something else is built again.
				// Told that Diamond's notes too where the chat is a Diamond's own thread; and a chat mid-turn waits for
				// its turn to end (`rebuildChatApp`), since a dropped app leaves Stop and a pause nothing to stop.
				pg.chats.forEach(function (c) {
					if (!c.app) return;
					var a = appCfgFor(c);
					if ((c._steer || '') !== self.steerFor(a.model, c.diamondId || '')) rebuildChatApp(c);
				});
			} catch (e) { /* no chats yet */ }
		},

		/// One Diamond's file, parsed. A line it could not read is named in the trail and left where it is.
		read: async function (id) {
			var text = '';
			try { text = await Wasm.store_read(this.path(id)); } catch (e) { text = ''; }
			var r = DaimondSteering.parse(typeof text === 'string' ? text : '', id, id === DEFAULT_IDS.Lucy);
			if (r.ignored.length) trail('steering unreadable', id + ': ' + r.ignored.length + ' line(s) kept as written');
			return r;
		},

		/// Re-read the files of the Diamonds whose stamp has moved (all of them where `force`).
		reload: function (force) {
			var self = this;
			this._load = this._load.then(function () { return self._reload(force); }, function () { return self._reload(force); });
			return this._load;
		},
		_reload: async function (force) {
			var self = this, list = Array.isArray(pg.diamonds) ? pg.diamonds : [], keep = {}, moved = false;
			await Promise.all(list.map(async function (d) {
				keep[d.id] = true;
				var stamp = Number(d.touched) || 0, was = self.by[d.id];
				if (!force && was && was.stamp === stamp) return;
				var r = await self.read(d.id);
				if (!was || JSON.stringify(was.entries) !== JSON.stringify(r.entries)) moved = true;
				self.by[d.id] = { stamp: stamp, entries: r.entries };
			}));
			Object.keys(this.by).forEach(function (id) {
				if (!keep[id]) { delete self.by[id]; moved = true; }
			});
			if (moved) this.changed();
			return moved;
		},

		/// Every note, from every file: `[entry]` in the shape `DaimondSteering.proposals` reads. Where
		/// `force`, every file is read again and not only those whose Diamond's stamp has moved: a raise
		/// and a press ask it, since a stamp this tab has not seen yet may stand over a file it has not read.
		list: async function (force) {
			await this.reload(!!force);
			return this.all();
		},

		// Read the file, let `change(doc, entries)` return the entry to write (or null to write
		// nothing; or a list of entries, written together in one file write), write it and stamp the
		// Diamond, and announce the write so that the device's other tabs and the sync hear of it. One at a time
		// per Diamond, and with the import of that Diamond (`holdDiamond`): a file is read, changed and written whole.
		_edit: function (level, scope, change) {
			var self = this, id = this.home(level, scope);
			var run = async function () {
				if (level !== 2 && level !== 3) throw new Error('A note is for a Diamond (2) or the account (3), not ' + level + '.');
				if (!id || !(pg.diamonds || []).some(function (d) { return d.id === id; })) {
					throw new Error(level === 3 ? 'Lucy, who keeps the account\'s notes, is not here.'
						: 'There is no Diamond ' + id + ' to keep a note in.');
				}
				var r = await self.read(id), made = change(r.doc, r.entries);
				if (!made) return null;
				var all = Array.isArray(made) ? made : [made], doc = r.doc;
				all.forEach(function (m) {
					var why = DaimondSteering.check(m, { refuse: function (l) { return self.refusal(l); }, isFamily: function (c) { return self.isFamily(c); } });
					if (why) throw new Error('This note cannot be kept (' + why + ').');
				});
				all.forEach(function (m) { doc = DaimondSteering.put(doc, m); });
				await Wasm.store_write(self.path(id), DaimondSteering.serialise(doc));
				try { await Wasm.touch_diamond(id); }
				catch (e) { trail('steering unstamped', id + ': a sync may replace it — ' + ((e && (e.message || e)) || '?')); }
				// The file is what it was just written as; the stamp is read again with the next list.
				self.by[id] = { stamp: -1, entries: DaimondSteering.parse(DaimondSteering.serialise(doc), id, id === DEFAULT_IDS.Lucy).entries };
				self.changed();
				// A Diamond's file is worked on without a turn, so the write is announced as every Diamond change is:
				// another tab of this device re-reads the files (a Remove here is not told again there), and the sync
				// is nudged so that it goes out.
				bumpDiamonds();
				return all[0];
			};
			return holdDiamond(id, run, DIAMOND_LOCK_WAIT);
		},

		/// A two-sided sync has just laid another device's copy of a Diamond over this one's, and with it that
		/// copy's note file. Join the file this device held (`there`) into the one now in force, entry by entry
		/// (`DaimondSteering.join`), write it and stamp the Diamond so the result travels on. True where
		/// something was written; one at a time with every other write to that Diamond.
		unite: function (id, there) {
			var self = this;
			return holdDiamond(id, function () { return self.uniteHeld(id, there); }, DIAMOND_LOCK_WAIT);
		},
		/// `unite` for the caller that already holds the Diamond's lock, which is the import that has just laid the copy down.
		uniteHeld: async function (id, there) {
			var self = this, acct = id === DEFAULT_IDS.Lucy;
			var here = '';
			try { here = String(await Wasm.store_read(self.path(id)) || ''); } catch (e) { here = ''; }
			var text = DaimondSteering.join(here, there, id, acct);
			if (text === null) return false;
			await Wasm.store_write(self.path(id), text);
			try { await Wasm.touch_diamond(id); }
			catch (e) { trail('steering unstamped', id + ': a sync may replace it — ' + ((e && (e.message || e)) || '?')); }
			self.by[id] = { stamp: -1, entries: DaimondSteering.parse(text, id, acct).entries };
			self.changed();
			return true;
		},

		_mint: function () {
			var r = '';
			while (r.length < 5) r += Math.random().toString(36).slice(2);
			return 'n-' + Date.now().toString(36) + '-' + r.slice(0, 5);
		},

		/// A new note, active, with `line` written exactly as given. `at` is `{ t, n }` as a proposal carries it.
		add: function (o) {
			var self = this;
			o = o || {};
			return this._edit(o.level, o.scope, function () {
				return { id: self._mint(), status: 'active', cm: String(o.cm || ''), tag: String(o.tag || ''), level: o.level,
					scope: o.level === 2 ? String(o.scope || '') : '', at: { t: Number(o.at && o.at.t) || 0, n: Number(o.at && o.at.n) || 0 },
					kept: 0, line: String(o.line == null ? '' : o.line), to: '' };
			});
		},

		/// Keep, on a review: the cell's count `n` becomes the new mark the next review waits from.
		keep: function (ref, n) {
			ref = ref || {};
			return this._edit(ref.level, ref.scope, function (doc, entries) {
				var e = entries.filter(function (x) { return x.id === ref.id; })[0];
				return e ? Object.assign({}, e, { kept: Math.max(0, Math.floor(Number(n) || 0)) }) : null;
			});
		},

		/// Remove, on a review: the note is kept as a record and never told to a model again.
		retire: function (ref, at) {
			ref = ref || {};
			return this._edit(ref.level, ref.scope, function (doc, entries) {
				var e = entries.filter(function (x) { return x.id === ref.id; })[0];
				return e ? Object.assign({}, e, { status: 'retired', at: { t: Number(at && at.t) || 0, n: Number(at && at.n) || 0 } }) : null;
			});
		},

		/// Dismiss a proposal. A switch is `tag: 'switch'` at level 2, `cm` the model left and `to` the target.
		dismiss: function (o) {
			var self = this;
			o = o || {};
			return this._edit(o.level, o.scope, function () {
				return { id: self._mint(), status: 'dismissed', cm: String(o.cm || ''), tag: String(o.tag || ''), level: o.level,
					scope: o.level === 2 ? String(o.scope || '') : '', at: { t: Number(o.at && o.at.t) || 0, n: Number(o.at && o.at.n) || 0 },
					kept: 0, line: String(o.line == null ? '' : o.line), to: String(o.to || '') };
			});
		},

		/// A Switch pressed on a tile, on file so that 20 new rated answers on the model it went to can ask Keep
		/// or Switch back (P5). `cm` is the model left, `to` the model gone to, `at.n` the rated answers of
		/// `to` in this Diamond then and `was` the whole model left, `{ provider, model }`, which Switch back
		/// restores. A Keep or a Switch back closes it with `retire`, the one write that closes a note.
		switched: function (o) {
			var self = this;
			o = o || {};
			return this._edit(2, o.scope, function () {
				return { id: self._mint(), status: 'switched', cm: String(o.cm || ''), tag: 'switch', level: 2, scope: String(o.scope || ''),
					at: { t: 0, n: Number(o.at && o.at.n) || 0 }, kept: 0, line: '', to: String(o.to || ''),
					was: o.was && o.was.model ? { provider: String(o.was.provider || ''), model: String(o.was.model) } : null };
			});
		},

		/// Switch back, on the review of a Switch: the `switched` entry `ref` is closed (`retire`, at `o.at`) and the
		/// switch is dismissed in the same file write, so that the page does not offer the same switch again at once.
		/// The dismissal is the cooling rule's own: `o.cm` the model the Diamond is back on, `o.to` the model it
		/// tried and `o.n` the rated answers of `o.cm` now, so 20 more of them free it. Null where the file holds
		/// no such entry.
		back: function (ref, o) {
			var self = this;
			ref = ref || {};
			o = o || {};
			return this._edit(2, ref.scope, function (doc, entries) {
				var e = entries.filter(function (x) { return x.id === ref.id; })[0];
				if (!e) return null;
				return [Object.assign({}, e, { status: 'retired', at: { t: Number(o.at && o.at.t) || 0, n: Number(o.at && o.at.n) || 0 } }),
					{ id: self._mint(), status: 'dismissed', cm: String(o.cm || ''), tag: 'switch', level: 2, scope: String(ref.scope || ''),
						at: { t: 0, n: Number(o.n) || 0 }, kept: 0, line: '', to: String(o.to || '') }];
			});
		},
	};
	DaimondSteering.refusal = function (line) { return Notes.refusal(line); };
	window.DaimondNotes = Notes;
	// page-split: install 103

	// ANOTHER TAB'S WRITE, READ HERE AS IT LANDS (F5). The browser raises `storage` in
	// every tab but the writer, so a tab never answers itself. The key comes as stored,
	// with this account's prefix, so another account's list is not ours; a null key is
	// the whole store cleared. What arrived that this tab had not seen counts on the chip
	// here too, as it did in the tab that raised it.
	window.addEventListener('storage', function (e) {
		var pre = '';
		try { if (window.DaimondAccounts) pre = DaimondAccounts.prefix() || ''; }
		catch (err) { /* no accounts module: the raw key */ }
		if (!e || (e.key !== null && e.key !== pre + PENDING_KEY)) return;
		Pending.fresh();
		Pending.render();
	});
	// An alert raised, cleared, dismissed, synced in or lapsed (alerts.js): redraw.
	window.addEventListener('daimond:alerts', function () {
		Pending.fresh();
		Pending.render();
	});
	// page-split: install 104
	// Published for pairing.js's QR and code approval (PAIR-QR), so the key shown there is
	// this one rendering and not a second copy of it.
	window.DaimondRunnerPair = { fingerprint: runnerPairFingerprint };
	// page-split: install 105

	// One Diamond's triggered actions, read-only. Published so that anything
	// building a picture of the pause tree -- the widget verifier does exactly
	// this -- can ask what the leaves ARE rather than assuming a shape.
	window.DaimondTriggersOf = function (id) { return Triggers.of(id).slice(); };

	// The Pending panel's whole surface to the rest of the world. The production
	// caller is `parkConsent`, which reaches `Pending.add` directly rather than
	// through here -- it is in the same module -- so what this publishes is for
	// the verifiers and for anything later that wants to raise or read a tile
	// from outside. It is not in the sync parcel, and no daimon tool writes to it.
	window.DaimondPendingView = {
		/// `add` takes `kind: 'consent'`, `kind: 'proposal'`, `kind: 'notice'`,
		/// `kind: 'runnerpair'`, or no kind at all -- which means consent -- and returns
		/// null for anything else, `alert` and `runner` among them: those ride DaimondAlerts.
		/// See the header.
		add:   function (item) { return Pending.add(item); },
		items: function () { Pending.fresh(); return Pending.items.slice(); },
		drop:  function (id) { return Pending.drop(id); },
		/// Raise the page's own proposals now, and resolve when the tiles are as they should be.
		steer: function () { return steerRaise(); },
	};
	// page-split: install 106
	if (window.DaimondModelDash && DaimondModelDash.useSteering) {
		DaimondModelDash.useSteering(function (host) { steerListMount(host, { empty: 'mdash-empty' }); });
	}

	// The two layers of standing instructions, for the same reason: what reaches
	// every agent should be askable from outside the one function that composes it.
	window.DaimondInstructions = Instructions;
	// page-split: install 107

	// A Diamond DaimondApp's counters are cumulative across every steer and fold IT has run, so a
	// turn's cost is the growth since that app was last read.
	//
	// There is one app per Diamond (`daimonApp`), so the previous reading is kept per app, not in a
	// pair of module variables. With a single pair, a fold on a cheap model followed by a steer on an
	// expensive one would have billed the difference between two unrelated counters -- and priced
	// the turn at whatever the starred model happened to cost. Each app is priced at the model it
	// was built on (`_diamondAppModel`), and its counters are only its own Diamond's spend.
	// The cached share and the provider's own cost figure are metered the same way and kept in the
	// same per-app reading: the engine publishes all four together as each response lands, so they
	// grow together, a read mid-turn is the real spend so far, and one delta rule serves them all.
	/* var */ pg._diamondMeter = new Map();       // app -> { p, c, ca, cost } at the last reading
} // page-split: end install
