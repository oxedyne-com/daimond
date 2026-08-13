/* mail.js — Daimond's mailboxes.
 *
 * A browser has no TCP socket, so Daimond cannot speak IMAP. The gateway makes the
 * connection and hands back the raw RFC 5322 bytes; everything else happens
 * here. The mail is written into the workspace as a Maildir, which is to say:
 * as ordinary files, in ordinary folders, that the agents' existing file tools
 * already read. Nothing about mail is a special case downstream of the socket.
 *
 *   mail/<address>/INBOX/cur/<uid>.<uidvalidity>.daimond:2,<flags>
 *   mail/<address>/INBOX/index.md      a digest, so an agent can see the shape
 *                                      of an inbox without reading every message
 *
 * The credential is an app password. It is wrapped under the user's passphrase
 * with the same key that wraps their API key, and it is sent to the gateway only
 * as part of a sync — the gateway holds it for one IMAP conversation and then
 * forgets it. Daimond stores no mail server-side, and never sees the passphrase.
 *
 * The UID is the thing that makes an incremental sync possible: `since_uid` is
 * the last message already held, so a sync asks only for what arrived after it.
 * `uidvalidity` is the mailbox's generation — if the server changes it, every
 * UID held locally is meaningless and the mailbox is rebuilt from scratch.
 */
(function () {
	'use strict';

	/// What the app says. The table lives in i18n/en.js; this is the one name
	/// the rest of this file uses. Guarded, because a page that failed to load
	/// the engine should still show its mail rather than nothing.
	function t(k, v)     { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	function tn(k, n, v) { return window.DaimondI18n ? DaimondI18n.tn(k, n, v) : k; }

	/// The same, with English standing in for a key the tables do not carry yet.
	///
	/// The string tables are not this phase's to edit, and a key added here
	/// before the translator reaches it would otherwise put `mail.every.off` on
	/// screen. `t` answers a missing key with the key itself, which is the test.
	/// Same device as gateway.js's `pauseWords`, for the same reason.
	function tf(k, english, v) {
		var s = t(k, v);
		if (s !== k) return s;
		return String(english).replace(/\{(\w+)\}/g, function (_, n) {
			return (v && v[n] != null) ? String(v[n]) : '';
		});
	}

	var LS      = 'daimond-mail';
	// Mailboxes removed on purpose, by address. The parcel merges by union, so an
	// account deleted here and still held on the other device would be handed
	// straight back on the next pull — password and all — and the seat given up at
	// the gateway would be taken again. See the sync section below.
	var TOMBS   = 'daimond-mail-tombs';
	var deps    = null;              // { writeBytes, openFile, refreshFiles, runTool, showDoc }

	/// Read a message file's BYTES, as bytes.
	///
	/// NOT `run_tool('file_read')`. That is the model-facing rendering: it prefixes
	/// every line with its number and a TAB, and everything under `mail/` is an
	/// untrusted path, so the result also arrives wrapped in an envelope. Handed to
	/// `parseHeaders`, `1\tFrom: …` matches nothing — which is why every message in
	/// the panel read "(unknown)" and "(no subject)".
	///
	/// The Doc panel had exactly this fault and was fixed by reading through
	/// `Wasm.read_file`; mail was not, and stayed broken. `Wasm` is an ES module
	/// import inside daimond.js and unreachable from here, so it arrives as
	/// `deps.readText`. If it is absent the panel says so rather than quietly
	/// showing the numbered rendering as if it were the message.
	async function readText(path) {
		if (deps && typeof deps.readText === 'function') {
			// `Wasm.read_file` REJECTS on a missing path; `run_tool('file_read')`,
			// which this replaced, returned an "Error: …" STRING. Every caller
			// below still tests the returned value for that string, so the switch
			// left four call sites whose error branch could never be reached and
			// whose rejection escaped instead.
			//
			// On a device with no `mail/` directory -- a phone that has never
			// opened the Email panel -- that produced two unhandled rejections on
			// every boot, which is what the first usable trail from an iPhone
			// showed. Restoring the contract here fixes all four at once.
			try {
				return await deps.readText(path);
			} catch (e) {
				return 'Error: ' + ((e && (e.message || e)) || 'unreadable');
			}
		}
		console.error('mail: deps.readText is missing, so message headers cannot be read; '
			+ 'see DaimondMail.init in daimond.js');
		return '';
	}

	var els     = {};
	var state   = {
		accounts: [],                // [{address, host, port, user, pass (wrapped), folder, folders:{}}]
		sel:      null,              // the selected address
		msgs:     [],                // the digest of the selected mailbox
		drafts:   [],                // unsent messages held for the selected mailbox
		// address -> { list: [{name, dir, label, role, selectable, delimiter}], err, busy }
		// The folder list is the SERVER's answer, cached per account for as long
		// as the page lives. Nothing is stored: a folder that was renamed on the
		// server should not go on being offered after a reload.
		folders:  {},
		unlocked: null,              // null = not yet asked the gateway
		// The cap is the gateway's to state — it is the only place it means anything — so this
		// is what the panel says before the gateway has answered, and it must not promise more
		// than the unlock actually covers.
		cap:      3,
		price:    null,              // minor units, from the gateway's catalogue
		busy:     false,
		draining: false,             // a "fetch all" is walking the mailbox down
		note:     '',
		err:      '',
	};

	/// What each provider calls its IMAP server, and what it demands instead of
	/// a password. Guessed from the address so the user is asked for as little
	/// as possible; every field stays editable, because a guess is not a fact.
	/// Reading a mailbox and posting from it are two different servers, so a preset names
	/// both. Submission runs on 587 (which starts in the clear and upgrades) or 465 (which
	/// is encrypted from the first byte); the gateway dials no other port.
	/// The guidance a preset carries is a `note` KEY, not a sentence: the dialog
	/// is built when it opens, so it reads the table then and gets whatever
	/// language is in force at that moment.
	var PRESETS = {
		'gmail.com':      { host: 'imap.gmail.com',        port: 993, smtpHost: 'smtp.gmail.com',        smtpPort: 587, note: 'mail.preset.gmail' },
		'googlemail.com': { host: 'imap.gmail.com',        port: 993, smtpHost: 'smtp.gmail.com',        smtpPort: 587, note: 'mail.preset.gmail_short' },
		'outlook.com':    { host: 'outlook.office365.com', port: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587, note: 'mail.preset.outlook' },
		'hotmail.com':    { host: 'outlook.office365.com', port: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587, note: 'mail.preset.outlook' },
		'live.com':       { host: 'outlook.office365.com', port: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587, note: '' },
		'yahoo.com':      { host: 'imap.mail.yahoo.com',   port: 993, smtpHost: 'smtp.mail.yahoo.com',   smtpPort: 465, note: 'mail.preset.yahoo' },
		'icloud.com':     { host: 'imap.mail.me.com',      port: 993, smtpHost: 'smtp.mail.me.com',      smtpPort: 587, note: 'mail.preset.icloud' },
		'me.com':         { host: 'imap.mail.me.com',      port: 993, smtpHost: 'smtp.mail.me.com',      smtpPort: 587, note: 'mail.preset.icloud' },
		'fastmail.com':   { host: 'imap.fastmail.com',     port: 993, smtpHost: 'smtp.fastmail.com',     smtpPort: 465, note: 'mail.preset.fastmail' },
		'fastmail.fm':    { host: 'imap.fastmail.com',     port: 993, smtpHost: 'smtp.fastmail.com',     smtpPort: 465, note: '' },
		'zoho.com':       { host: 'imap.zoho.com',         port: 993, smtpHost: 'smtp.zoho.com',         smtpPort: 587, note: '' },
		'aol.com':        { host: 'imap.aol.com',          port: 993, smtpHost: 'smtp.aol.com',          smtpPort: 465, note: '' },
	};

	/// Providers that have no IMAP server anyone else can reach. Saying so is
	/// the honest thing; letting the user type a password into a form that
	/// cannot work is not. The value is a key, as with the presets above.
	var UNREACHABLE = {
		'proton.me':      'mail.unreachable.proton',
		'protonmail.com': 'mail.unreachable.proton',
		'pm.me':          'mail.unreachable.proton',
		'tutanota.com':   'mail.unreachable.tuta',
		'tuta.io':        'mail.unreachable.tuta',
	};

	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}
	function domainOf(addr) {
		var i = String(addr || '').lastIndexOf('@');
		return i < 0 ? '' : addr.slice(i + 1).toLowerCase().trim();
	}
	function load() {
		try {
			var j = JSON.parse(localStorage.getItem(LS) || '{}');
			state.accounts = Array.isArray(j.accounts) ? j.accounts : [];
			state.accounts.forEach(liftFolders);
			state.sel = j.sel || (state.accounts[0] && state.accounts[0].address) || null;
		} catch (e) { state.accounts = []; }
	}

	/// An account's sync watermarks used to be the account's, because there was
	/// one mailbox and it was the inbox. They belong to a FOLDER — `uidvalidity`
	/// is per-mailbox and so is every UID under it — so an older record has its
	/// four numbers lifted into the inbox's slot rather than being discarded,
	/// which would re-download an inbox that is already on disk.
	function liftFolders(a) {
		if (!a.folder) a.folder = 'INBOX';
		if (a.folders && a.folders[a.folder]) return;
		a.folders = a.folders || {};
		a.folders.INBOX = a.folders.INBOX || {
			dir:         'INBOX',
			uidValidity: a.uidValidity || 0,
			lastUid:     a.lastUid  || 0,
			firstUid:    a.firstUid || 0,
			heldBack:    a.heldBack || 0,
			limit:       a.limit    || 0,
			lastSync:    a.lastSync || 0,
		};
		if (!a.folders[a.folder]) a.folders[a.folder] = blankFolder(a.folder);
	}

	function blankFolder(name) {
		return {
			dir: dirFor(name), uidValidity: 0, lastUid: 0, firstUid: 0,
			// `count` is how many messages this folder held at `lastSync`, which is
			// the only honest reading of a number on a folder row. Zero and
			// never-synced are different states and the row says so.
			heldBack: 0, limit: 0, lastSync: 0, lastTry: 0, count: 0,
		};
	}

	/// The per-folder record for an account, made if this is the first time the
	/// folder has been looked at.
	function fld(a, name) {
		if (!a) return null;
		name = name || a.folder || 'INBOX';
		a.folders = a.folders || {};
		if (!a.folders[name]) a.folders[name] = blankFolder(name);
		return a.folders[name];
	}
	function save() {
		localStorage.setItem(LS, JSON.stringify({ accounts: state.accounts, sel: state.sel }));
		// A mailbox added or removed outside a turn must travel like any edit.
		// The engine coalesces and skips an unchanged parcel, so this is cheap.
		try { if (window.DaimondSync && DaimondSync.nudge) DaimondSync.nudge(); } catch (e) { /* not up yet */ }
	}
	function acct(address) {
		return state.accounts.find(function (a) { return a.address === address; }) || null;
	}

	// ── The pause tree, as mail sees it ─────────────────────────────
	// The ids are DaimondPause's and are built with its own escaper: a folder
	// called `INBOX/Sub` would otherwise invent a level in the tree.
	//
	//   root/mail/<address>            the mailbox      branch
	//   root/mail/<address>/self       its own polling  LEAF
	//   root/mail/<address>/<folder>   one folder       LEAF
	//
	// Nothing here draws a control. The widget is daimond.js's, asked for through
	// `pptw()` below, so there is one drawing of it in the app.

	function pauseId() {
		if (!window.DaimondPause) return Array.prototype.join.call(arguments, '/');
		return DaimondPause.id.apply(null, arguments);
	}
	function mailNode()                { return pauseId('root', 'mail'); }
	function boxNode(address)          { return pauseId('root', 'mail', address); }
	function selfNode(address)         { return pauseId('root', 'mail', address, 'self'); }
	function folderNode(address, name) { return pauseId('root', 'mail', address, name); }

	function heldNode(node) {
		return !!(node && window.DaimondPause && DaimondPause.isPaused(node));
	}

	/// Which node refuses a poll of this folder, or '' when none does. The
	/// folder's own leaf answers first, then the mailbox's.
	///
	/// The tree does NOT derive this. `self` is a SIBLING of the folders, not
	/// their ancestor, so a mailbox whose `self` is held and whose folders play
	/// is 'mixed' to `stateOf` and 'not paused' to `isPaused` on any folder leaf.
	/// "A paused mailbox must not go on reaching the server one folder at a time"
	/// is a rule laid OVER the tree rather than read out of it, which is why it
	/// is written twice: here, so a held folder is never scheduled, and at the
	/// wire in gateway.js:275, so one that is scheduled anyway never leaves.
	function pollStop(address, name) {
		var f = folderNode(address, name);
		if (heldNode(f)) return f;
		var s = selfNode(address);
		if (heldNode(s)) return s;
		return '';
	}

	/// The refusal, in words: what was not done, and where the control is.
	/// The key is gateway.js's, so the sentence is translated once.
	function pausedWords(node) {
		return tf('pause.refused.mail',
			'{node} is paused. The mailbox was not contacted and nothing was spent. '
				+ 'Press play on it to resume.', { node: node });
	}

	/// One pause control, from the module that owns the drawing of it.
	///
	/// THE MOUNT POINT for the shared widget. `DaimondUI.pauseWidget(nodeId,
	/// name)` returns a painted `<span class="pptw">` — a light and two verb
	/// buttons — that repaints itself on
	/// `daimond:pause`; mail.js only says where one goes. Absent — the widget is
	/// another phase's — the slot stays empty and everything else in the panel
	/// still works, which is the whole reason it is asked for rather than drawn.
	function pptw(nodeId, name) {
		var slot = document.createElement('span');
		slot.className = 'pptw-slot';
		var mk = window.DaimondUI && DaimondUI.pauseWidget;
		if (typeof mk !== 'function') return slot;
		try { slot.appendChild(mk(nodeId, name)); } catch (e) { /* leave it empty */ }
		return slot;
	}

	// ── How often a folder refreshes itself ─────────────────────────
	//
	// WHERE THE SETTING LIVES, and why it is not in `a.folders`.
	//
	// `a.folders[name]` is this DEVICE's account of what is on this device's
	// disk — uidvalidity, watermarks, the last sync — and the sync parcel
	// deliberately carries none of it (see the section below). A refresh
	// frequency is the opposite kind of fact: it is what the user asked for, it
	// is true of the mailbox rather than of the disk, and a person who sets
	// their inbox to fifteen minutes on the laptop means it on the phone too.
	// So it lives in its own map on the account, `a.refresh`, and it travels.
	//
	// TRAVELLING MEANS STABLE BYTES. sync.js skips a push when the parcel
	// stringifies to what it last sent, so a map serialised in enumeration order
	// would make this device always have news and two devices would push at each
	// other for ever. That has happened here twice; `dev/verify_parcelstable.mjs`
	// is the check. Hence `sortedRefresh`: sorted keys, integer seconds, no
	// stamp of its own — the account's existing `touched` decides the merge, and
	// it moves only when the user changes something.
	//
	// Seconds, not minutes, because the unit a test needs is not the unit a
	// person picks from and the store should not make them the same choice.

	/// The frequencies the dialog offers, in seconds. 0 is "manual only", which
	/// is what every folder is until someone says otherwise: a mailbox that
	/// started polling on its own the moment it was added would spend the user's
	/// credits on a decision they never made.
	var EVERY = [0, 300, 900, 1800, 3600, 14400, 43200, 86400];

	function refreshMap(a) {
		if (!a) return {};
		if (!a.refresh || typeof a.refresh !== 'object') a.refresh = {};
		return a.refresh;
	}

	/// How often this folder refreshes itself, in seconds; 0 for manual only.
	function refreshOf(a, name) {
		var v = refreshMap(a)[name];
		return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0;
	}

	/// Set it. `touched` moves because this is a statement about the mailbox and
	/// has to win the cross-device merge against a device that has not heard it.
	function setRefresh(address, name, secs) {
		var a = acct(address);
		if (!a || !name) return false;
		secs = (typeof secs === 'number' && isFinite(secs) && secs > 0) ? Math.floor(secs) : 0;
		var m = refreshMap(a);
		if (refreshOf(a, name) === secs) return false;
		if (secs) m[name] = secs; else delete m[name];
		// The folder needs a record for its watermarks and for the pause tree,
		// which daimond.js builds out of this map (daimond.js:6819). A folder
		// scheduled but never opened would otherwise have no leaf, and pausing
		// the mailbox would walk straight past it.
		fld(a, name);
		a.touched = Math.max(Date.now(), ms(a.touched) + 1);
		save();
		arm();
		render();
		return true;
	}

	/// The map as it travels: sorted keys, integer seconds, nothing else.
	function sortedRefresh(a) {
		var m = refreshMap(a), out = {};
		Object.keys(m).sort().forEach(function (k) {
			var v = refreshOf(a, k);
			if (v) out[k] = v;
		});
		return out;
	}

	// ── The schedule ────────────────────────────────────────────────
	// One timer for the whole app, re-armed to the next folder that falls due.
	// Not one timer per folder: a dozen folders across three mailboxes would be
	// a dozen timers to cancel on every account change, and the one thing this
	// must never do is go on polling a mailbox that has been removed.

	var timer     = null;
	var TICK_MIN  = 250;		// never busier than this, whatever a folder asks for
	var TICK_MAX  = 60000;		// and never asleep longer, so a resume is felt

	/// When this folder is next due, in epoch ms; 0 when it is never due.
	/// A folder with a frequency and no attempt behind it is due NOW, which is
	/// what setting one means.
	///
	/// The clock runs from the last ATTEMPT, not the last success. A sync that
	/// failed leaves `lastSync` where it was, so scheduling off that alone would
	/// find the folder overdue on the very next tick and hammer a server that is
	/// down four times a second. An interval is how often to try.
	function dueAt(a, name) {
		var secs = refreshOf(a, name);
		if (!secs) return 0;
		var f = a.folders && a.folders[name];
		var last = Math.max((f && ms(f.lastSync)) || 0, (f && ms(f.lastTry)) || 0);
		return last ? last + secs * 1000 : 1;
	}

	/// Can anything be polled at all? A locked device cannot unwrap the
	/// password, and an account without the entitlement has no mailbox to poll.
	function canPoll() {
		if (state.unlocked === false) return false;
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return false;
		return true;
	}

	/// Poll the one folder that is furthest overdue, then re-arm.
	///
	/// One per tick on purpose: `syncAccount` refuses to run while another sync
	/// is in flight, so firing six at once would drop five of them silently and
	/// leave their watermarks unmoved. Re-arming after each is the queue.
	async function tick() {
		timer = null;
		var now = Date.now(), pick = null, worst = 0;
		state.accounts.forEach(function (a) {
			Object.keys(refreshMap(a)).sort().forEach(function (n) {
				var d = dueAt(a, n);
				if (!d || d > now) return;
				if (pollStop(a.address, n)) return;	// held: not polled, not stamped
				if (!pick || d < worst) { pick = { address: a.address, name: n }; worst = d; }
			});
		});
		if (pick && !state.busy && !state.draining) {
			await syncAccount(pick.address, false, pick.name, true);
		}
		arm();
	}

	/// Re-arm the timer to whichever folder falls due first.
	///
	/// Called from `render()`, so every state change that could move a due time —
	/// a sync finishing, a frequency changing, an account arriving in a parcel,
	/// the device unlocking — re-arms without each of them having to remember to.
	function arm() {
		if (timer) { clearTimeout(timer); timer = null; }
		if (typeof setTimeout !== 'function') return;
		var scheduled = false, soonest = 0, now = Date.now();
		state.accounts.forEach(function (a) {
			Object.keys(refreshMap(a)).forEach(function (n) {
				var d = dueAt(a, n);
				if (!d) return;
				scheduled = true;
				if (pollStop(a.address, n)) return;
				if (!soonest || d < soonest) soonest = d;
			});
		});
		if (!scheduled) return;
		// A schedule exists but nothing can act on it — the device is locked, or
		// every folder is held. Look again shortly rather than never: the unlock
		// and the resume both happen outside this module.
		if (!soonest || !canPoll()) {
			timer = setTimeout(function () { tick(); }, TICK_MAX);
			return;
		}
		// A sync already in flight makes every overdue folder look due on the next
		// tick, and `syncAccount` refuses a second one. Look again in a second
		// rather than spinning at the floor while a large fetch runs.
		var floor = (state.busy || state.draining) ? 1000 : TICK_MIN;
		var wait = Math.max(floor, Math.min(TICK_MAX, soonest - now));
		timer = setTimeout(function () { tick(); }, wait);
	}

	// A resume has to be felt without waiting out the current sleep.
	try { if (window.DaimondPause) DaimondPause.subscribe(arm); } catch (e) { /* not up */ }

	// ── Travelling in the sync parcel ───────────────────────────────
	// A user who has linked two devices has one account, and mail configured on
	// one of them and not the other is half a mailbox. So the accounts ride in the
	// parcel beside the chats, the Diamonds and the provider keys.
	//
	// WHAT TRAVELS, and why:
	//
	//   * The server configuration — address, host, port, SMTP host and port, and
	//     the login user. Facts about the mailbox, true wherever it is read.
	//   * The WRAPPED password. Both paired devices hold the same identity, so the
	//     ciphertext opens on both; the gateway in the middle can open neither, and
	//     the parcel is sealed again over the top of it. It is exactly the trust
	//     model the sealed provider keys already travel under, and it is what makes
	//     the second device WORK rather than merely list a mailbox it cannot read.
	//     The plaintext password exists only for the length of one request and is
	//     never stored, so there is nothing readable here to carry.
	//   * `sel`, which mailbox is being looked at — a small courtesy, and cheap.
	//   * `refresh`, how often each folder polls itself. A statement about the
	//     mailbox, not about this device's disk: a person who sets their inbox to
	//     fifteen minutes on the laptop means it on the phone. Sorted keys and
	//     integer seconds, for the determinism rule at the foot of this comment.
	//   * NOT `folders`, and nothing under it. Every UID, uidvalidity, watermark
	//     and lastSync in there describes what is on THIS device's disk. Carrying
	//     it would tell the other device it already holds mail it has never
	//     downloaded, and the merge would have to reconcile two independent
	//     Maildirs. Rebuilding is one sync per folder and cannot be wrong.
	//   * NOT `folder`, the folder on screen, for the same reason as the rest of
	//     the per-folder state: a fresh device starts in INBOX, which is right.
	//
	// DETERMINISM IS A REQUIREMENT. sync.js skips a push when the parcel
	// stringifies to what it last sent, so an export whose field or account order
	// followed enumeration would make the app push for ever. Accounts are sorted
	// by address and every row is assembled in a fixed field order.

	/// A millisecond stamp, or 0 when there is none to be had. NOT `n | 0`: a
	/// bitwise operator coerces to 32 bits and an epoch-ms value is far past that,
	/// so the truncation would be not merely wrong but inconsistently wrong — a
	/// fresher stamp can truncate below an older one, and the freshest side then
	/// loses the merge.
	function ms(v) {
		return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0;
	}

	/// A refresh map off the wire, reduced to what this module will act on:
	/// string keys, whole positive seconds, sorted. A parcel is another device's
	/// word for it, and a `-1` in there would arm a timer that fires for ever.
	function cleanRefresh(m) {
		var out = {};
		if (!m || typeof m !== 'object') return out;
		Object.keys(m).sort().forEach(function (k) {
			var v = m[k];
			if (!k) return;
			if (typeof v === 'number' && isFinite(v) && v > 0) out[k] = Math.floor(v);
		});
		return out;
	}

	/// The mailboxes deleted on purpose, by address, with anything past its TTL
	/// pruned. The map, the TTL and the union rule are DaimondCore's — one deletion
	/// policy for chats, Diamonds, providers and mailboxes rather than four.
	function tombs() {
		return (window.DaimondCore && DaimondCore.tombs) ? DaimondCore.tombs(TOMBS) : {};
	}
	function tombstone(address) {
		if (window.DaimondCore && DaimondCore.tombstone) DaimondCore.tombstone(TOMBS, address);
	}
	function mergeTombs(incoming) {
		return (window.DaimondCore && DaimondCore.mergeTombs)
			? DaimondCore.mergeTombs(TOMBS, incoming) : tombs();
	}

	/// The tombstone map with sorted keys, for the same reason the accounts are
	/// sorted: enumeration order must never reach the wire.
	function sortedTombs() {
		var t = tombs(), out = {};
		Object.keys(t).sort().forEach(function (addr) { out[addr] = ms(t[addr]); });
		return out;
	}

	/// The mailboxes as they should travel: JSON-safe, deterministic, and carrying
	/// no per-device state.
	function exportSync() {
		var out = { v: 1, sel: state.sel || '', accounts: [], tombs: sortedTombs() };
		state.accounts.slice().sort(function (x, y) {
			return String(x.address).localeCompare(String(y.address));
		}).forEach(function (a) {
			if (!a || !a.address) return;
			var row = {
				address:  String(a.address),
				host:     String(a.host || ''),
				port:     a.port | 0,
				smtpHost: String(a.smtpHost || ''),
				smtpPort: a.smtpPort | 0,
				user:     String(a.user || ''),
				pass:     String(a.pass || ''),		// wrapped; see above
				// Always present, even empty: absent has to keep meaning "that
				// device predates the setting", or clearing the last schedule
				// could never travel.
				refresh:  sortedRefresh(a),
				touched:  ms(a.touched),
			};
			// Only where it has been set: it decides whether the gateway opens the
			// connection in the clear and upgrades, so losing it would change how
			// the mailbox is dialled on the other device.
			if (a.security) row.security = String(a.security);
			out.accounts.push(row);
		});
		return out;
	}

	/// Merge another device's mailboxes into this one.
	///
	/// A union, never a replacement: a mailbox only this device has is left alone,
	/// one only the other device has arrives whole and working, and where both have
	/// the same address the later `touched` decides — strictly, so an unchanged
	/// account is not rewritten on every pull.
	///
	/// A deletion travels as a tombstone, and beats any copy of the account stamped
	/// before it; an account re-added after the deletion carries a later stamp and
	/// wins in its turn.
	///
	/// The arriving account brings no folder state, so it is given the blank INBOX a
	/// new mailbox starts with and fills it from the server on its first sync. A
	/// parcel with no `mail` section — a device that predates this — is a no-op.
	async function applySync(remote) {
		if (!remote || typeof remote !== 'object') return { added: 0, updated: 0, removed: 0 };
		var added = 0, updated = 0, removed = 0;
		var dead = mergeTombs(remote.tombs);
		state.accounts = state.accounts.filter(function (a) {
			if (!dead[a.address]) return true;
			if (ms(a.touched) > ms(dead[a.address])) return true;	// re-added here since
			removed++;
			delete state.folders[a.address];
			return false;
		});
		(Array.isArray(remote.accounts) ? remote.accounts : []).forEach(function (r) {
			if (!r || !r.address) return;
			if (dead[r.address] && !(ms(r.touched) > ms(dead[r.address]))) return;	// buried
			var mine = acct(r.address);
			if (!mine) {
				var fresh = {
					address:  String(r.address),
					host:     String(r.host || ''),
					port:     r.port | 0,
					smtpHost: String(r.smtpHost || ''),
					smtpPort: r.smtpPort | 0,
					user:     String(r.user || r.address),
					pass:     String(r.pass || ''),
					touched:  ms(r.touched),
					refresh:  cleanRefresh(r.refresh),
					// This device's own view of the mailbox, built fresh: the mail
					// itself is fetched here rather than carried.
					folder:   'INBOX',
					folders:  { INBOX: blankFolder('INBOX') },
					lastSync: 0,
				};
				if (r.security) fresh.security = String(r.security);
				state.accounts.push(fresh);
				added++;
				return;
			}
			if (!(ms(r.touched) > ms(mine.touched))) return;		// ours is newer, or the same
			mine.host     = String(r.host || mine.host || '');
			mine.port     = (r.port | 0) || mine.port;
			mine.smtpHost = String(r.smtpHost || mine.smtpHost || '');
			mine.smtpPort = (r.smtpPort | 0) || mine.smtpPort;
			mine.user     = String(r.user || mine.user || r.address);
			// An empty password on the other side is not an instruction to forget
			// the one that works here: it means that device never had one.
			if (r.pass) mine.pass = String(r.pass);
			if (r.security) mine.security = String(r.security);
			// Absent means the other device predates the setting and has nothing
			// to say about it; an empty map is a real answer and clears ours.
			if (r.refresh && typeof r.refresh === 'object') mine.refresh = cleanRefresh(r.refresh);
			mine.touched  = ms(r.touched);
			updated++;
		});
		// The selection is this device's, as long as it still names something real;
		// only then does the other device's choice get a say.
		if (!state.sel || !acct(state.sel)) {
			state.sel = (remote.sel && acct(remote.sel)) ? remote.sel
				: ((state.accounts[0] && state.accounts[0].address) || null);
			state.msgs = [];
		}
		if (!added && !updated && !removed) return { added: 0, updated: 0, removed: 0 };
		save();
		// Show what landed, but only where there is a panel to show it in: init()
		// has not run on a page whose Mail panel was never opened, and the digest
		// cannot be read before the file tools exist.
		if (els.state) {
			if (state.sel) {
				try { await Promise.all([loadDigest(state.sel, folderOf(state.sel)), refreshDrafts()]); }
				catch (e) { /* the panel still draws what it has */ }
			}
			render();
			if (state.sel) loadFolders(state.sel);
		}
		return { added: added, updated: updated, removed: removed };
	}

	/// The folder an account is looking at, defaulting to the inbox.
	function folderOf(address) {
		var a = acct(address);
		return (a && a.folder) || 'INBOX';
	}

	// ── RFC 5322, enough of it ──────────────────────────────────────
	// Enough to show a message to a person: the headers that matter, and the
	// readable part of the body. An agent gets the raw file and can do better.

	/// Unfold the header block (a header may continue on an indented line) and
	/// return it as an ordered list of [name, value].
	function parseHeaders(text) {
		var end = text.search(/\r?\n\r?\n/);
		var block = end < 0 ? text : text.slice(0, end);
		var lines = block.split(/\r?\n/);
		var out = [], cur = null;
		lines.forEach(function (l) {
			if (/^[ \t]/.test(l) && cur) { cur[1] += ' ' + l.trim(); return; }
			var i = l.indexOf(':');
			if (i < 0) return;
			cur = [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
			out.push(cur);
		});
		return out;
	}
	function header(hs, name) {
		var h = hs.find(function (x) { return x[0] === name; });
		return h ? h[1] : '';
	}
	function bodyOf(text) {
		var m = text.match(/\r?\n\r?\n/);
		return m ? text.slice(m.index + m[0].length) : '';
	}

	/// Decode an RFC 2047 encoded-word (`=?utf-8?B?...?=`), which is how a
	/// subject line carries anything that is not ASCII.
	function decodeWords(s) {
		return String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, function (_, cs, enc, txt) {
			try {
				var bytes;
				if (enc.toLowerCase() === 'b') {
					bytes = Uint8Array.from(atob(txt), function (c) { return c.charCodeAt(0); });
				} else {
					var q = txt.replace(/_/g, ' ');
					var arr = [];
					for (var i = 0; i < q.length; i++) {
						if (q[i] === '=' && /[0-9a-f]{2}/i.test(q.substr(i + 1, 2))) {
							arr.push(parseInt(q.substr(i + 1, 2), 16)); i += 2;
						} else { arr.push(q.charCodeAt(i)); }
					}
					bytes = new Uint8Array(arr);
				}
				return new TextDecoder(cs.toLowerCase().replace(/^utf8$/, 'utf-8')).decode(bytes);
			} catch (e) { return txt; }
		}).replace(/\?=\s*=\?/g, '');
	}

	/// A date the reader can read, in the language the interface is speaking.
	/// `toDateString` is English whatever the locale, which is what this quoted
	/// a reply's date in for every user in the world.
	function longDate(d) {
		var loc = window.DaimondI18n ? DaimondI18n.locale() : undefined;
		try {
			return d.toLocaleDateString(loc,
				{ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
		} catch (e) { return d.toDateString(); }
	}

	/// Thousands separators, because "69635 older messages" is a number the eye has to count.
	function fmtCount(n) {
		return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	}

	function decodeQP(s) {
		return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, function (_, h) {
			return String.fromCharCode(parseInt(h, 16));
		});
	}
	function decodeB64(s) {
		try { return atob(s.replace(/\s+/g, '')); } catch (e) { return s; }
	}

	/// Re-read a decoded byte-string as UTF-8. `atob` and quoted-printable both
	/// yield one character per byte, so a multi-byte character arrives as
	/// mojibake unless it is decoded again.
	function asUtf8(bytes, charset) {
		try {
			var arr = Uint8Array.from(bytes, function (c) { return c.charCodeAt(0) & 0xff; });
			var cs = (charset || 'utf-8').toLowerCase().replace(/^utf8$/, 'utf-8');
			return new TextDecoder(cs, { fatal: false }).decode(arr);
		} catch (e) { return bytes; }
	}

	/// The readable text of a message: the `text/plain` part of a multipart, or
	/// the body itself, decoded out of whatever transfer encoding it arrived in.
	function readableText(raw) {
		var hs   = parseHeaders(raw);
		var ctype = header(hs, 'content-type') || 'text/plain';
		var body  = bodyOf(raw);

		var mb = ctype.match(/boundary="?([^";]+)"?/i);
		if (/multipart/i.test(ctype) && mb) {
			var parts = body.split('--' + mb[1]);
			var plain = null, html = null;
			parts.forEach(function (p) {
				var phs = parseHeaders(p.replace(/^\r?\n/, ''));
				var pct = header(phs, 'content-type') || '';
				var pte = (header(phs, 'content-transfer-encoding') || '').toLowerCase();
				var pb  = bodyOf(p.replace(/^\r?\n/, ''));
				if (!pb) return;
				if (pte === 'base64')           pb = decodeB64(pb);
				else if (pte === 'quoted-printable') pb = decodeQP(pb);
				var pcs = (pct.match(/charset="?([^";]+)"?/i) || [])[1];
				pb = asUtf8(pb, pcs);
				if (/text\/plain/i.test(pct) && plain === null) plain = pb;
				else if (/text\/html/i.test(pct) && html === null) html = pb;
				else if (/multipart/i.test(pct) && plain === null) {
					// One level of nesting: multipart/alternative inside
					// multipart/mixed is the common shape of a message with an
					// attachment, and the text is inside the inner part.
					var inner = readableText('content-type: ' + pct + '\r\n\r\n' + pb);
					if (inner) plain = inner;
				}
			});
			if (plain) return plain.trim();
			if (html) return stripHtml(html).trim();
			return '';
		}

		var te = (header(hs, 'content-transfer-encoding') || '').toLowerCase();
		if (te === 'base64')                 body = decodeB64(body);
		else if (te === 'quoted-printable')  body = decodeQP(body);
		var cs = (ctype.match(/charset="?([^";]+)"?/i) || [])[1];
		body = asUtf8(body, cs);
		if (/text\/html/i.test(ctype)) return stripHtml(body).trim();
		return body.trim();
	}

	/// Reduce HTML to its text. The message is never inserted as markup: a mail
	/// body is the least trustworthy string in the application.
	function stripHtml(html) {
		var bare = String(html)
			.replace(/<style[\s\S]*?<\/style>/gi, '')
			.replace(/<script[\s\S]*?<\/script>/gi, '')
			.replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]+>/g, '');
		var d = document.createElement('textarea');
		d.innerHTML = bare;                              // entity decode only
		return d.value.replace(/\n{3,}/g, '\n\n');
	}

	// ── Maildir ─────────────────────────────────────────────────────

	/// A Maildir filename: `<unique>:2,<flags>`, flags in ASCII order. The
	/// unique part is derived from the UID and the mailbox generation rather
	/// than from the clock, so syncing the same message twice overwrites one
	/// file instead of making two.
	function maildirName(uid, uidValidity, flags) {
		var f = '';
		var has = function (n) { return (flags || []).some(function (x) { return x.toLowerCase() === n; }); };
		if (has('\\draft'))    f += 'D';
		if (has('\\flagged'))  f += 'F';
		if (has('\\answered')) f += 'R';
		if (has('\\seen'))     f += 'S';
		if (has('\\deleted'))  f += 'T';
		return uid + '.' + uidValidity + '.daimond:2,' + f;
	}
	/// Where one account's mail sits: `mail/<address>`, with anything a directory name
	/// cannot carry flattened out of the address.
	///
	/// A MAILBOX DOES NOT FOLLOW THE WORKSPACE FOLDER, and the engine is what makes that
	/// true rather than anything here: `mail/` is one of Daimond's own roots
	/// (`is_store_path`, src/tools.rs), so every path this module hands to a file tool
	/// resolves in the browser's own storage whichever folder the user has open. It used
	/// not to, and mail is per ACCOUNT rather than per piece of work, so the same mailbox
	/// landed inside whichever folder was open, disappeared when none was, and was written
	/// somewhere else again after a switch. A real folder would not take the names either —
	/// a Maildir file carries a colon, which nothing outside the sandbox accepts.
	///
	/// Messages an older build left in a folder are copied home on the next activation, and
	/// the folder's copies are left where they are (`bring_mail_home`, src/wasm/diamond.rs).
	function mailDir(address) {
		return 'mail/' + String(address || '').replace(/[^A-Za-z0-9@._-]/g, '_');
	}

	/// A folder name as one path segment.
	///
	/// A server names its folders in its own alphabet, with its own separator:
	/// `[Gmail]/All Mail`, `Работа`, `INBOX.Sent`. None of that can be a
	/// directory name here, so it is flattened — and, because flattening can
	/// collide (`A/B` and `A_B` both give `A_B`), anything that had to be
	/// changed carries a short hash of the ORIGINAL name. The server's own
	/// spelling is what a sync sends; this is only where the files sit.
	function dirFor(name) {
		name = String(name == null ? '' : name);
		if (name === 'INBOX') return 'INBOX';           // the shape already on disk
		var safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
		// A name of nothing but dots is `.` or `..`, which are not folder names
		// but instructions to a filesystem. They never reach one from here.
		if (/^\.+$/.test(safe)) safe = '';
		if (safe === name && safe) return safe;
		return (safe || 'folder') + '-' + hash36(name);
	}

	/// A short, stable hash of a string. Not a security property: it is a
	/// suffix that keeps two different folder names in two different folders.
	function hash36(s) {
		var h = 5381;
		for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
		return h.toString(36);
	}

	function mailboxDir(address, folder) {
		var a = acct(address);
		var name = folder || (a && a.folder) || 'INBOX';
		var f = a ? fld(a, name) : null;
		return mailDir(address) + '/' + ((f && f.dir) || dirFor(name));
	}

	// ── Writing a message ───────────────────────────────────────────
	// RFC 5322 in the other direction. The gateway posts bytes rather than
	// intentions — it opens one submission conversation with the user's provider and
	// hands over a finished document — so the document is built here, in full, and
	// nothing server-side decides what a message says or who it goes to.

	function utf8(s) {
		return new TextEncoder().encode(String(s == null ? '' : s));
	}
	/// Base64 a byte array, in chunks: `String.fromCharCode` blows the argument
	/// limit on an attachment of any size.
	function b64(bytes) {
		var s = '', CH = 0x8000;
		for (var i = 0; i < bytes.length; i += CH) {
			s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
		}
		return btoa(s);
	}
	function isAscii(s) {
		return !/[^\x20-\x7e]/.test(String(s == null ? '' : s));
	}

	/// A header value with anything but plain ASCII in it, as RFC 2047 encoded-words.
	///
	/// The words are chunked so no line runs past the 76-character limit, and the chunk
	/// boundary is taken at a *character*, never inside a multi-byte one — split a
	/// character across two encoded-words and the recipient decodes rubbish.
	function encodeWord(s) {
		s = String(s == null ? '' : s);
		if (isAscii(s)) return s;
		var out = [], chunk = '', bytes = 0;
		for (var i = 0; i < s.length; i++) {
			var ch = s[i];
			// A surrogate pair is one character and must not be halved.
			if (/[\uD800-\uDBFF]/.test(ch) && i + 1 < s.length) ch += s[++i];
			var n = utf8(ch).length;
			if (bytes + n > 39 && chunk) {
				out.push('=?utf-8?B?' + b64(utf8(chunk)) + '?=');
				chunk = ''; bytes = 0;
			}
			chunk += ch; bytes += n;
		}
		if (chunk) out.push('=?utf-8?B?' + b64(utf8(chunk)) + '?=');
		return out.join('\r\n ');
	}

	/// One address as a header writes it: `Name <addr>`, with the name encoded if it
	/// needs it and quoted if it holds a character that would otherwise punctuate.
	function encodeAddr(a) {
		if (typeof a === 'string') a = splitAddr(a);
		if (!a || !a.addr) return '';
		if (!a.name) return a.addr;
		var nm = isAscii(a.name)
			? (/[(),:;<>@\[\]".]/.test(a.name) ? '"' + a.name.replace(/(["\\])/g, '\\$1') + '"' : a.name)
			: encodeWord(a.name);
		return nm + ' <' + a.addr + '>';
	}
	/// Split a header's worth of addresses on the commas that separate them, ignoring
	/// the ones inside a quoted display name.
	function addrList(s) {
		var out = [], cur = '', q = false;
		String(s || '').split('').forEach(function (c) {
			if (c === '"') q = !q;
			if (c === ',' && !q) { out.push(cur); cur = ''; return; }
			cur += c;
		});
		out.push(cur);
		return out.map(function (x) { return x.trim(); }).filter(Boolean);
	}
	/// Just the addresses, which is what the envelope carries: a display name is for
	/// the reader, and the provider is not the reader.
	function addrsOf(s) {
		return addrList(s).map(function (x) { return splitAddr(x).addr; }).filter(Boolean);
	}

	/// Quoted-printable, over the UTF-8 bytes.
	///
	/// The rules that bite: a space or tab at the end of a line is invisible and would be
	/// stripped in transit, so it is encoded; a line is folded with a soft break before it
	/// reaches 76 characters; and a line beginning `From ` is escaped, because some
	/// software still treats one as the start of a new message.
	function encodeQP(text) {
		var bytes = utf8(String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
		var lines = [], line = '', held = '';
		function flush() { lines.push(line); line = ''; }
		function push(tok) {
			if (line.length + tok.length > 75) { lines.push(line + '='); line = ''; }
			line += tok;
		}
		for (var i = 0; i < bytes.length; i++) {
			var b = bytes[i];
			if (b === 0x0a) {                                   // end of line
				if (held) { push(held === ' ' ? '=20' : '=09'); held = ''; }
				flush();
				continue;
			}
			if (held) { push(held); held = ''; }
			if (b === 0x20) { held = ' '; continue; }
			if (b === 0x09) { held = '\t'; continue; }
			if (b >= 33 && b <= 126 && b !== 61) push(String.fromCharCode(b));
			else push('=' + ('0' + b.toString(16).toUpperCase()).slice(-2));
			if (line === 'From' && i + 1 < bytes.length && bytes[i + 1] === 0x20) {
				line = '=46rom';                                // a line may not begin "From "
			}
		}
		if (held) push(held === ' ' ? '=20' : '=09');
		flush();
		return lines.join('\r\n');
	}
	/// Base64, wrapped to the 76-character line a MIME body is allowed.
	function b64Lines(bytes) {
		return (b64(bytes).match(/.{1,76}/g) || []).join('\r\n');
	}

	/// The date, as a mail header spells it. Built by hand rather than through
	/// `toLocaleString`, because the format is fixed and English and the user's locale
	/// is neither.
	function mailDate(d) {
		var DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		var pad = function (n) { return ('0' + n).slice(-2); };
		var off = -d.getTimezoneOffset();
		var sign = off < 0 ? '-' : '+';
		off = Math.abs(off);
		return DAY[d.getDay()] + ', ' + d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear()
			+ ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
			+ ' ' + sign + pad(Math.floor(off / 60)) + pad(off % 60);
	}
	function rand(n) {
		var a = new Uint8Array(n || 8);
		crypto.getRandomValues(a);
		return Array.from(a).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
	}
	function messageId(from) {
		return '<' + rand(10) + '.' + Date.now() + '@' + (domainOf(from) || 'daimond.local') + '>';
	}

	/// Build the RFC 5322 document a draft describes.
	///
	/// A draft with no attachment is one `text/plain` part; a draft with attachments is a
	/// `multipart/mixed` whose first part is that text. Nothing here is optional
	/// decoration: the `Message-ID` is what a reply to this message will point back at,
	/// and `In-Reply-To` / `References` are what make a reply *thread* in the recipient's
	/// client rather than arrive as an unrelated message with a similar subject.
	function buildMessage(d) {
		var from = { name: d.fromName || '', addr: d.from };
		var id   = d.messageId || messageId(d.from);
		var h    = [];
		h.push('Message-ID: ' + id);
		h.push('Date: ' + mailDate(new Date()));
		h.push('From: ' + encodeAddr(from));
		h.push('To: ' + addrList(d.to).map(encodeAddr).join(', '));
		if (String(d.cc || '').trim()) h.push('Cc: ' + addrList(d.cc).map(encodeAddr).join(', '));
		h.push('Subject: ' + encodeWord(d.subject || ''));
		if (d.inReplyTo) {
			h.push('In-Reply-To: ' + d.inReplyTo);
			h.push('References: ' + (d.references || d.inReplyTo));
		}
		h.push('MIME-Version: 1.0');
		h.push('User-Agent: Daimond');

		var atts = d.attachments || [];
		if (!atts.length) {
			h.push('Content-Type: text/plain; charset=utf-8');
			h.push('Content-Transfer-Encoding: quoted-printable');
			return h.join('\r\n') + '\r\n\r\n' + encodeQP(d.body || '') + '\r\n';
		}

		var bnd = '=_daimond_' + rand(12);
		h.push('Content-Type: multipart/mixed; boundary="' + bnd + '"');
		var out = h.join('\r\n') + '\r\n\r\n'
			+ 'This is a message in MIME format.\r\n'
			+ '--' + bnd + '\r\n'
			+ 'Content-Type: text/plain; charset=utf-8\r\n'
			+ 'Content-Transfer-Encoding: quoted-printable\r\n\r\n'
			+ encodeQP(d.body || '') + '\r\n';
		atts.forEach(function (att) {
			var name = att.name || 'attachment';
			out += '--' + bnd + '\r\n'
				+ 'Content-Type: ' + (att.type || 'application/octet-stream') + '\r\n'
				+ 'Content-Transfer-Encoding: base64\r\n'
				+ 'Content-Disposition: attachment; filename="' + encodeWord(name).replace(/"/g, '') + '"\r\n\r\n'
				+ b64Lines(att.bytes) + '\r\n';
		});
		out += '--' + bnd + '--\r\n';
		return out;
	}

	/// Where a message is posted from, which is not where it was read from: submission is
	/// a different server on a different port, and a preset knows both. An account the
	/// user configured by hand wins over the guess.
	function smtpFor(a) {
		var p = PRESETS[domainOf(a.address)] || {};
		var host = a.smtpHost || p.smtpHost || ('smtp.' + domainOf(a.address));
		var port = parseInt(a.smtpPort || p.smtpPort || 587, 10);
		// 465 is encrypted from the first byte; 587 starts in the clear and must upgrade
		// before the password is spoken. A mailbox may say otherwise — a test server on
		// loopback speaks neither — and what the account says wins over what the port implies.
		return {
			host:     host,
			port:     port,
			security: a.smtpSecurity || (port === 465 ? 'tls' : 'starttls'),
		};
	}

	// ── Drafts ──────────────────────────────────────────────────────
	// A draft is a file: `mail/<address>/drafts/<id>.eml`, the same RFC 5322 bytes that
	// would go on the wire. That makes it legible to every file tool the agent already
	// has — which is the whole of the agent's access to sending. It may WRITE a draft
	// here for the user to read, correct and send; it has no tool that puts a message on
	// the wire, and it is not going to be given one. Only a person pressing Send sends.
	//
	// A draft is also the one thing here that exists NOWHERE ELSE. A synced message can be
	// fetched again from the server; a draft is on no server and in no gateway, which is why
	// the mail migration copies rather than moves and never deletes anything.

	function draftsDir(address) { return mailDir(address) + '/drafts'; }
	function sentDir(address)   { return mailDir(address) + '/sent'; }

	async function saveDraft(d) {
		if (!d.from) throw new Error(t('mail.err.draft_needs_mailbox'));
		d.id = d.id || ('draft-' + Date.now() + '-' + rand(3));
		d.messageId = d.messageId || messageId(d.from);
		var path = draftsDir(d.from) + '/' + d.id + '.eml';
		await deps.writeBytes(path, utf8(buildMessage(d)));
		if (deps.refreshFiles) deps.refreshFiles();
		return path;
	}

	/// Every draft held for a mailbox, newest first — including any an agent wrote.
	async function listDrafts(address) {
		var dir = draftsDir(address);
		var listing;
		try { listing = await deps.runTool('file_list', { path: dir }); }
		catch (e) { return []; }
		if (typeof listing !== 'string' || /^\s*Error\b/i.test(listing)) return [];
		var names = listing.split('\n').map(function (l) {
			var m = l.match(/^\s*(?:[-*]\s*)?(\S.*?)(?:\s+\(\d+.*\))?\s*$/);
			return m ? m[1].trim().replace(/\/$/, '') : '';
		}).filter(function (n) { return /\.eml$/i.test(n); });

		var out = [];
		for (var i = 0; i < names.length; i++) {
			var path = dir + '/' + names[i];
			var raw = await readText(path);
			if (typeof raw !== 'string' || /^\s*Error\b/i.test(raw)) continue;
			var hs = parseHeaders(raw);
			out.push({
				path:    path,
				id:      names[i].replace(/\.eml$/i, ''),
				to:      decodeWords(header(hs, 'to')),
				subject: decodeWords(header(hs, 'subject')) || t('mail.no_subject'),
				date:    header(hs, 'date'),
			});
		}
		out.sort(function (x, y) { return (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0); });
		return out;
	}

	/// Read a draft file back into the thing the compose panel edits. A draft an agent
	/// wrote is an ordinary message file, so it opens the same way.
	async function readDraft(address, path) {
		var raw = await readText(path);
		if (typeof raw !== 'string' || /^\s*Error\b/i.test(raw)) {
			throw new Error(t('mail.err.draft_unreadable'));
		}
		var hs   = parseHeaders(raw);
		var mime = parseMime(raw, 0);
		var f    = splitAddr(header(hs, 'from'));
		return {
			id:          (path.split('/').pop() || '').replace(/\.eml$/i, ''),
			path:        path,
			from:        f.addr || address,
			fromName:    f.name,
			to:          decodeWords(header(hs, 'to')),
			cc:          decodeWords(header(hs, 'cc')),
			subject:     decodeWords(header(hs, 'subject')),
			body:        mime.plain || (mime.html ? stripHtml(mime.html) : ''),
			inReplyTo:   header(hs, 'in-reply-to'),
			references:  header(hs, 'references'),
			messageId:   header(hs, 'message-id'),
			attachments: mime.attachments,
		};
	}

	async function discardDraft(d) {
		if (!d.path && !d.id) return;
		var path = d.path || (draftsDir(d.from) + '/' + d.id + '.eml');
		try { await deps.runTool('file_delete', { path: path }); } catch (e) { /* never existed */ }
		if (deps.refreshFiles) deps.refreshFiles();
	}

	// ── Sending ─────────────────────────────────────────────────────

	/// Post a draft through the user's own provider.
	///
	/// The envelope recipients are the addresses in To and Cc, and they are named to the
	/// gateway explicitly: a `To:` header is text a person reads, and the envelope is the
	/// instruction the provider acts on. Keeping them one list built here means the two
	/// cannot drift apart.
	async function sendDraft(d) {
		var a = acct(d.from);
		if (!a) throw new Error(t('mail.err.send_from_added'));
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			throw new Error(t('mail.err.unlock_first'));
		}
		var rcpt = addrsOf(d.to).concat(addrsOf(d.cc));
		if (!rcpt.length) throw new Error(t('mail.err.no_recipients'));

		var smtp    = smtpFor(a);
		var raw     = buildMessage(d);
		var payload = b64(utf8(raw));
		var password = await DaimondIdentity.unwrap(a.pass);

		var j = await post('/api/mail/send', {
			address:  a.address,
			host:     smtp.host,
			port:     smtp.port,
			security: smtp.security,
			user:     a.user || a.address,
			password: password,
			rcpt:     rcpt,
			raw:      payload,
		});

		// A sent message is a file too, so "what did I send them" is answerable by the
		// same agent, with the same tools, as "what did they send me".
		try {
			await deps.writeBytes(sentDir(a.address) + '/' + (d.id || rand(6)) + '.eml', utf8(raw));
		} catch (e) { /* the mail is gone whatever the local copy did */ }
		await discardDraft(d);
		return j;
	}

	// ── The sync ────────────────────────────────────────────────────

	/// Sync a mailbox.
	///
	/// A sync normally walks *forwards*: it asks for what arrived after the newest message already
	/// held. With `older` set it reaches *backwards* instead, for the batch just below the oldest
	/// message held — which is the only way to reach mail older than the first batch, since a
	/// mailbox is never pulled down whole.
	/// `auto` marks a poll the schedule asked for rather than the user. It changes
	/// nothing about what is fetched — only how loudly the panel narrates it, and
	/// whether a refusal is worth saying out loud to somebody who did not ask.
	/// What is running now, so a second sync can wait for it instead of vanishing.
	///
	/// `state.busy` used to make `syncAccount` return at once, and every caller is
	/// fire-and-forget -- so a fetch asked for while another was in flight simply did
	/// not happen, silently, with the panel showing whatever was already on disk.
	/// That is how `selectFolder` opened a folder for the first time and never
	/// fetched it: it fires its first-batch sync without awaiting, and the folder
	/// LIST refresh that runs beside it is enough to be holding `busy`.
	///
	/// Phase G made it much worse rather than causing it, by adding a background
	/// poll that holds `busy` on its own schedule.
	var syncTurn = Promise.resolve();

	/// Fetch one folder.
	///
	/// A sync the USER asked for waits its turn; one the SCHEDULE asked for is still
	/// dropped when something else is running, because the schedule comes round again
	/// and a queue of automatic polls is a queue of bills. `auto` already carries
	/// exactly that distinction.
	function syncAccount(address, older, folder, auto) {
		if (auto && state.busy) return Promise.resolve();
		// `finally` on both arms: a sync that threw must not stop the next one, and
		// a rejected chain would strand every later fetch for the life of the tab.
		var next = syncTurn.then(
			function () { return syncOne(address, older, folder, auto); },
			function () { return syncOne(address, older, folder, auto); });
		syncTurn = next.then(function () {}, function () {});
		return next;
	}

	async function syncOne(address, older, folder, auto) {
		var a = acct(address);
		if (!a) return;
		var name = folder || a.folder || 'INBOX';
		var f    = fld(a, name);
		if (older && !f.firstUid) return;      // nothing held, so nothing to reach back from

		// REFUSED WHERE THE REQUEST IS MADE. `gwFetch` refuses it again at the
		// wire (gateway.js:269), which is what makes the hold real; this is the
		// half that keeps a held folder from starting a sync it cannot finish,
		// and that names the control to press. A scheduler that respected a pause
		// and a fetch that did not would be decoration.
		var stop = pollStop(address, name);
		if (stop) {
			if (!auto) { state.err = pausedWords(stop); state.note = ''; render(); }
			return;
		}

		state.busy = true; state.err = '';
		// When this folder was last TRIED, which is what the schedule counts from.
		// See `dueAt`: a failure must cost an interval, not nothing.
		f.lastTry = Date.now();
		// An automatic poll says nothing on the way in. A line that appeared every
		// five minutes to announce a sync nobody asked for would train the reader
		// to ignore the one place this panel has to say anything.
		state.note = auto ? state.note
			: t(older ? 'mail.note.fetching_older' : 'mail.note.syncing',
				{ address: address, folder: labelFor(a, name) });
		render();
		try {
			if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
				throw new Error(t('mail.err.unlock_first'));
			}
			var password = await DaimondIdentity.unwrap(a.pass);

			var body = {
				address:   a.address,
				host:      a.host,
				port:      a.port || 993,
				// 993 is TLS from the first byte; 143 starts in the clear and
				// must upgrade before the password is sent. Without this the
				// gateway assumed TLS on both, so port 143 could never work.
				security:  a.security || (a.port === 143 ? 'starttls' : 'tls'),
				user:      a.user || a.address,
				password:  password,
				// The SERVER's spelling, not the flattened directory name: this
				// is the string it will SELECT.
				mailbox:   name,
			};
			if (older) body.before_uid = f.firstUid;
			else       body.since_uid  = f.lastUid || 0;

			// Read BEFORE the fetch, because the rebuild below moves both of them
			// and the arrival test at the bottom is a question about the folder as
			// it stood a moment ago.
			var mark    = f.lastUid || 0;   // the high-water mark this fetch starts from
			var known   = !!f.lastSync;     // has this folder ever been fetched?
			var rebuilt = false;            // did the generation change under us?

			var j = await post('/api/mail/sync', body);

			// The mailbox generation changed, so every UID held locally names a
			// different message now — or no message. Start again. It is the
			// FOLDER's generation: two folders on one server have two of them.
			if (f.uidValidity && j.uid_validity && j.uid_validity !== f.uidValidity) {
				f.lastUid = 0;
				f.firstUid = 0;
				// The re-fetch below asks for the folder from uid 0, so everything in
				// it comes back. That is a rebuild, not a delivery, and the arrival
				// test at the bottom of this function has to be told.
				rebuilt = true;
				// KNOWN AND NOT FIXED HERE: the old generation's files stay on disk.
				// A Maildir name carries the generation it was fetched under
				// (`<uid>.<uidValidity>.daimond:2,`), so the re-fetch below writes
				// every message again under a new name and nothing removes the old
				// copies -- the panel then shows each message twice, and the folder
				// row's count climbs with every change of generation. Measured, in a
				// session that left thirteen copies of three messages on disk.
				//
				// Not fixed in this pass because the fix DELETES A USER'S MAIL, and
				// `verify_mailfolders` cannot currently tell one run's files from
				// another's (see the generation check in that file) -- so there is no
				// way to prove the deletion right before shipping it. It needs a test
				// that can see, and that needs the instrument fixed first.
				f.uidValidity = j.uid_validity;
				save();
				state.note = t('mail.note.rebuilt');
				render();
				j = await post('/api/mail/sync', Object.assign({}, body, { since_uid: 0, before_uid: 0 }));
			}
			f.uidValidity = j.uid_validity || f.uidValidity;

			var msgs = j.messages || [];
			for (var i = 0; i < msgs.length; i++) {
				var m = msgs[i];
				var bytes = Uint8Array.from(atob(m.raw), function (c) { return c.charCodeAt(0); });
				var path = mailboxDir(a.address, name) + '/cur/'
					+ maildirName(m.uid, f.uidValidity, m.flags);
				await deps.writeBytes(path, bytes);
				if (m.uid > (f.lastUid || 0)) f.lastUid = m.uid;
				// The oldest UID held is the floor a later "fetch older" reaches back from.
				if (!f.firstUid || m.uid < f.firstUid) f.firstUid = m.uid;
			}
			// A trigger watches for mail ARRIVING, and this is the only place that
			// knows any has. Announced rather than called directly: mail must not
			// have to know what a triggered action is, and a second listener --
			// a badge, a sound, a notification -- costs nothing to add later.
			//
			// ARRIVING IS NARROWER THAN "MESSAGES CAME BACK", and the difference is
			// money: what hears this fires a triggered action, which is a Diamond
			// spending without being asked. Three occasions return messages and are
			// not arrivals:
			//
			//   * a "fetch older" backfill, which reaches BELOW what is held. Every
			//     message it brings is one the user has had for months, and pressing
			//     the button was itself the asking;
			//   * a `uidValidity` rebuild, which has just re-fetched the folder from
			//     uid 0. The whole mailbox comes back, so announcing it is a bill the
			//     size of the mailbox;
			//   * the first fetch of a folder nobody has fetched before. That is a
			//     baseline, not a delivery: a trigger armed before the account was
			//     added would otherwise fire on everything already in it. It costs
			//     one missed firing, once per folder, and bounds the worst case.
			//
			// What is left is what came in ABOVE the mark this fetch started from.
			// The uids travel with it so a listener can say WHICH messages it acted
			// on, rather than only how many.
			//
			// The mark and the `older` test OVERLAP deliberately: a backfill cannot
			// return anything above the mark while the server honours `before_uid`,
			// so a well-behaved one is refused twice. The rebuild is the case where
			// the mark is no defence at all -- a generation change RENUMBERS, and the
			// new uids are commonly far above the old ones -- which is why it has to
			// say so itself. See dev/verify_mailtrigger.mjs, which breaks each fence
			// in turn.
			var fresh = (older || rebuilt || !known)
				? []
				: msgs.filter(function (m) { return m.uid > mark; });
			if (fresh.length) {
				try {
					window.dispatchEvent(new CustomEvent('daimond:mail-arrived', {
						detail: {
							mailbox: a.address,
							folder:  name,
							count:   fresh.length,
							uids:    fresh.map(function (m) { return m.uid; }),
						},
					}));
				} catch (e) { /* an old browser: the sync still happened */ }
			}
			// What the cap left behind, so the panel can offer to go back for it.
			f.heldBack = j.held_back || 0;
			f.limit    = j.limit || f.limit || 0;
			f.lastSync = Date.now();
			a.lastSync = f.lastSync;           // the account's row shows its latest sync
			save();

			await rebuildIndex(a, name);
			await loadDigest(a.address, name);
			save();		// the count `loadDigest` just took, kept across a reload
			var parts = [];
			if (!msgs.length) {
				// An automatic poll that found nothing leaves the panel as it was.
				// The folder row already carries the count and its as-at, which is
				// where "I looked and there was nothing" belongs.
				if (auto) { state.note = state.note || ''; return; }
				parts.push(t(older ? 'mail.note.no_older' : 'mail.note.up_to_date'));
			} else {
				parts.push(tn(older ? 'mail.note.older' : 'mail.note.new', msgs.length));
				if (j.charged_minor) parts.push(fmtMinor(j.charged_minor));
				if (f.heldBack) parts.push(tn('mail.note.still_older', f.heldBack));
			}
			state.note = parts.join(' · ');
			if (deps.refreshFiles) deps.refreshFiles();
		} catch (e) {
			state.err = friendly(e);
			state.note = '';
		} finally {
			state.busy = false;
			render();
		}
	}

	/// Walk the whole mailbox down, a batch at a time, until nothing is left on the server.
	///
	/// This is the one action that can pull ten years of mail across the wire, so it says what it
	/// is about to do before it does it, reports progress while it runs, and stops the moment it
	/// is asked to. Every batch is an ordinary sync, so a run that is stopped — or that fails
	/// halfway — leaves the mailbox exactly as consistent as it would have been anyway, and can be
	/// resumed later.
	async function fetchAll(address) {
		var a = acct(address);
		if (!a || state.busy) return;
		var name = a.folder || 'INBOX';
		var f = fld(a, name);
		if (!f.heldBack) return;

		var total = f.heldBack;
		var ok = await deps.confirm(
			t('mail.all.title', { n: fmtCount(total) }),
			t('mail.all.body',  { batch: f.limit || 25 }),
			{ ok: t('mail.all.ok') });
		if (!ok) return;

		state.draining = true;
		var got = 0;
		while (state.draining) {
			var before = f.firstUid;
			await syncAccount(address, true, name);       // one batch older
			a = acct(address);
			if (!a) break;
			f = fld(a, name);
			// No progress means the server has nothing further below what we hold: stop, rather
			// than ask again forever.
			if (!f.firstUid || f.firstUid === before) break;
			got = total - (f.heldBack || 0);
			if (!f.heldBack) break;
			if (state.draining) {
				state.note = t('mail.all.progress',
					{ got: fmtCount(got), total: fmtCount(total) });
				render();
			}
		}
		var stopped = !state.draining;
		state.draining = false;
		a = acct(address);
		f = a ? fld(a, name) : null;
		var count = tn('mail.all.count', got, { n: fmtCount(got) });
		state.note = (f && f.heldBack)
			? t(stopped ? 'mail.all.stopped_left' : 'mail.all.done_left',
				{ count: count, left: fmtCount(f.heldBack) })
			: t(stopped ? 'mail.all.stopped' : 'mail.all.done', { count: count });
		render();
	}

	/// A digest of the mailbox, written where the agents look. Without it, an
	/// agent asked "what is in my inbox" has to open every message to find out.
	async function rebuildIndex(a, folder) {
		var name = folder || a.folder || 'INBOX';
		var f    = fld(a, name);
		var msgs = await readMailbox(a.address, name);
		// English, and deliberately so: this file is written for the agents'
		// file tools to read, and a digest whose column headings move with the
		// interface language would be a moving target for every prompt.
		var lines = [
			'# ' + a.address + ' — ' + name,
			'',
			'Synced ' + new Date(f.lastSync || Date.now()).toISOString() + '. '
				+ msgs.length + ' message' + (msgs.length === 1 ? '' : 's') + '.',
			'The full message is the file named in the last column.',
			'',
			'| UID | Date | From | Subject | File |',
			'|----:|------|------|---------|------|',
		];
		msgs.slice().reverse().forEach(function (m) {
			var cell = function (s) { return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' '); };
			lines.push('| ' + m.uid + ' | ' + cell(m.date) + ' | ' + cell(m.from)
				+ ' | ' + cell(m.subject) + ' | `' + cell(m.file) + '` |');
		});
		await deps.runTool('file_write', {
			path: mailboxDir(a.address, name) + '/index.md',
			content: lines.join('\n') + '\n',
		});
	}

	/// Read the mailbox back off disk. The files are the truth; nothing about a
	/// message is cached anywhere else, so a mailbox survives a wiped
	/// localStorage and is legible to anything that can read a folder.
	async function readMailbox(address, folder) {
		var dir = mailboxDir(address, folder) + '/cur';
		var listing;
		try {
			listing = await deps.runTool('file_list', { path: dir });
		} catch (e) {
			return [];                       // the workspace is not up yet
		}
		if (typeof listing !== 'string' || /^\s*Error\b/i.test(listing)) return [];
		var out = [];
		var names = listing.split('\n').map(function (l) {
			var m = l.match(/^\s*(?:[-*]\s*)?(\S.*?)(?:\s+\(\d+.*\))?\s*$/);
			return m ? m[1].trim() : '';
		}).filter(function (n) { return n && n.indexOf(':2,') > 0; });

		for (var i = 0; i < names.length; i++) {
			var name = names[i].replace(/\/$/, '');
			var raw = await readText(dir + '/' + name);
			if (typeof raw !== 'string' || /^\s*Error\b/i.test(raw)) continue;
			var hs = parseHeaders(raw);
			out.push({
				uid:     parseInt(name.split('.')[0], 10) || 0,
				file:    dir + '/' + name,
				from:    decodeWords(header(hs, 'from')),
				subject: decodeWords(header(hs, 'subject')) || t('mail.no_subject'),
				date:    header(hs, 'date'),
				seen:    /:2,[^,]*S/.test(name),
			});
		}
		out.sort(function (x, y) { return x.uid - y.uid; });
		return out;
	}

	/// Read one folder's digest, and adopt it as what the panel SHOWS only when
	/// that folder is the one on screen.
	///
	/// `state.msgs` is a property of the SELECTION; a count is a property of the
	/// folder. Conflating them made the list flicker on every manual refresh:
	/// `refreshAll` walks every folder of every mailbox in turn, each sync ends
	/// here, and an unconditional assignment let Sent, then Spam, then Trash each
	/// replace the INBOX the user was reading — appearing, emptying and
	/// reappearing as the walk went by, and leaving whichever folder happened to
	/// sync last on screen. A Gmail account, with its labels, does this a dozen
	/// times per refresh.
	async function loadDigest(address, folder) {
		var a = acct(address);
		// The same defaulting as `mailboxDir`, so the folder read is the folder
		// counted and the folder compared.
		var name = folder || (a && a.folder) || 'INBOX';
		var msgs = await readMailbox(address, name);
		if (address === state.sel && a && name === (a.folder || 'INBOX')) {
			state.msgs = msgs;
		}
		// What the folder holds, recorded where a row can read it without listing
		// the directory again — the panel draws a dozen rows and reads none of
		// them off disk. These are the messages the server handed over, so the
		// number's as-at is the folder's last sync and nothing fresher: nothing
		// new lands in a Maildir without a sync putting it there. Recorded for
		// every folder, selected or not, because that is what a row shows.
		if (!a) return;
		var f = fld(a, name);
		if (f) f.count = msgs.length;
	}

	// ── The gateway ─────────────────────────────────────────────────

	// Every call below goes through `DaimondGateway.gwFetch`, which meets a 401 by
	// renewing the session once and asking once more -- single-flight, so mail and
	// sync refused in the same moment share one renewal.
	//
	// The gateway's session lives an hour and only an unlock ever minted one, so
	// an hour into a sitting every mail call came back 401: a sync showed the
	// gateway's own "No valid session." where the new-message count belongs, the
	// entitlement read fell back to "unknown" and the panel offered the Pro pitch
	// to an account that holds Pro, and freeing a seat on a removed mailbox was
	// discarded without a word.
	//
	// Safe to repeat, INCLUDING `/api/mail/send`, and this is why: every
	// session-authed handler in the gateway checks the session BEFORE it parses
	// the body and before it opens a connection to anybody's mail server
	// (`common::authed_account` is the first statement of `send_impl`,
	// `sync_impl`, `folders_impl` and `accounts_impl`), so a 401 is proof that
	// nothing happened -- no message left, no seat moved.
	//
	// This file used to carry its own copy of that rule, one of five identical
	// copies across the app. There is one now, in gateway.js, beside the renewal
	// it drives.

	async function post(path, body) {
		if (!window.DaimondGateway) throw new Error(t('mail.err.service_unavailable'));
		var st = DaimondGateway.state();
		if (!st.authed) {
			var ok = await DaimondGateway.bootstrap();
			if (!ok) throw new Error(t('mail.err.service_unreachable'));
		}
		var r = await DaimondGateway.gwFetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify(body || {}),
		});
		// A 401 that survived the renewal is this device signed out, and it is
		// said in those terms. The gateway's "No valid session." was appearing
		// verbatim on the mail panel where a sync result belongs.
		if (r.status === 401) throw new Error(t('mail.err.service_unreachable'));
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok === false) {
			throw new Error((j && j.error) || ('HTTP ' + r.status));
		}
		// Syncing and sending cost credits, and the reply says what is left. One place owns
		// that number; this hands it over rather than letting the header go stale.
		if (window.DaimondGateway && DaimondGateway.noteBalance) DaimondGateway.noteBalance(j);
		return j;
	}

	/// Ask the gateway what this account may do. Called when the panel opens, so
	/// the panel never advertises a mailbox the account cannot have.
	async function refreshEntitlement() {
		try {
			var st = DaimondGateway.state();
			if (!st.authed) await DaimondGateway.bootstrap();
			var r = await DaimondGateway.gwFetch('/api/mail/accounts', { credentials: 'same-origin' });
			var j = await r.json();
			if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
			state.unlocked = !!j.unlocked;
			state.cap = j.max_accounts || state.cap;

			// Email is part of Pro now, not a separate purchase, so there is no
			// à la carte price to fetch: the pitch points at Pro instead.
		} catch (e) {
			state.unlocked = null;               // unknown, not "locked"
		}
		render();
	}

	// ── Folders ─────────────────────────────────────────────────────
	// A mailbox is not an inbox. The gateway asks the server what it has
	// (`LIST`) and hands back each folder's own spelling — which may be
	// localised (`[Gmail]/Gesendet`), nested, or a container holding no mail at
	// all. What is NOT localised is the RFC 6154 role, so a folder the server
	// declares `\Sent` is called Sent here whatever the server calls it.
	//
	// Nothing about the list is stored. A folder renamed on the server should
	// stop being offered the moment the page is reloaded, and the files already
	// pulled out of it stay where they are either way.

	/// The order roles are offered in — the order a mail client has put them in
	/// for thirty years, rather than the order the server happened to answer.
	var ROLE_ORDER = ['drafts', 'sent', 'archive', 'flagged', 'junk', 'trash', 'all'];

	/// What a folder is called on screen: the role's name where the server
	/// declares one, and the server's own spelling where it does not.
	function labelFor(a, name) {
		if (name === 'INBOX') return t('mail.folder.inbox');
		var e = folderEntry(a, name);
		if (e && e.role && ROLE_ORDER.indexOf(e.role) >= 0) return t('mail.folder.' + e.role);
		return name;
	}

	function folderEntry(a, name) {
		var c = a && state.folders[a.address];
		if (!c || !c.list) return null;
		for (var i = 0; i < c.list.length; i++) if (c.list[i].name === name) return c.list[i];
		return null;
	}

	/// Put the server's answer in the order and shape the panel draws.
	function shapeFolders(raw) {
		var out = (raw || []).map(function (f) {
			return {
				name:       String(f.name || ''),
				role:       f.role || '',
				selectable: f.selectable !== false,
				delimiter:  f.delimiter || '',
			};
		}).filter(function (f) { return f.name; });
		// A server that does not name its inbox in LIST still has one.
		if (!out.some(function (f) { return f.name === 'INBOX'; })) {
			out.unshift({ name: 'INBOX', role: '', selectable: true, delimiter: '' });
		}
		// The inbox first, then the roles every mail client has put in that
		// order for thirty years, then the folders the user made — and All Mail
		// below all of them. It is a copy of everything already listed above it,
		// so it is the one entry that is never what somebody meant to open.
		var rank = function (f) {
			if (f.name === 'INBOX')  return -1;
			if (f.role === 'all')    return ROLE_ORDER.length + 1;
			var i = ROLE_ORDER.indexOf(f.role);
			return i < 0 ? ROLE_ORDER.length : i;
		};
		out.sort(function (x, y) {
			var d = rank(x) - rank(y);
			if (d) return d;
			return x.name.localeCompare(y.name);
		});
		return out;
	}

	/// Ask the server what folders it has. Free — the gateway charges nothing
	/// for a LIST — so it runs when the panel opens and when the account
	/// changes, and again whenever the user asks.
	async function loadFolders(address, force) {
		var a = acct(address);
		if (!a) return;
		var cur = state.folders[address];
		if (cur && cur.busy) return;
		if (cur && cur.list && !force) return;
		// The password is encrypted under the passphrase. A locked device is not
		// an error here; it simply means the inbox is all that can be offered.
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return;
		state.folders[address] = { busy: true, err: '', list: (cur && cur.list) || null };
		render();
		try {
			var password = await DaimondIdentity.unwrap(a.pass);
			var j = await post('/api/mail/folders', {
				address:  a.address,
				host:     a.host,
				port:     a.port || 993,
				security: a.security || (a.port === 143 ? 'starttls' : 'tls'),
				user:     a.user || a.address,
				password: password,
			});
			state.folders[address] = { busy: false, err: '', list: shapeFolders(j.folders) };
			// A record per selectable folder. It is what the folder rows read their
			// count out of, and it is what daimond.js builds the pause tree from
			// (daimond.js:6819) — so without it, a folder the gear dialog offers a
			// control for would not be walked when the mailbox itself is paused.
			// A record is watermarks at zero; it fetches nothing and says nothing
			// beyond "this folder exists".
			state.folders[address].list.forEach(function (e) { if (e.selectable) fld(a, e.name); });
			save();
			// A folder that is no longer there cannot go on being the selected
			// one, or every sync would ask for a mailbox the server has not got.
			var list = state.folders[address].list;
			if (a.folder && !list.some(function (f) { return f.name === a.folder && f.selectable; })) {
				a.folder = 'INBOX';
				save();
				await loadDigest(address, 'INBOX');
			}
		} catch (e) {
			state.folders[address] = {
				busy: false,
				err:  t('mail.folders_err', { reason: friendly(e) }),
				list: (cur && cur.list) || null,
			};
		}
		render();
	}

	/// Move to another folder of the same account. The messages already on disk
	/// are read straight back; nothing is fetched until a sync is asked for.
	async function selectFolder(name) {
		var a = acct(state.sel);
		if (!a || a.folder === name) return;
		a.folder = name;
		fld(a, name);
		save();
		state.note = '';
		state.err  = '';
		await loadDigest(a.address, name);
		render();
		// A folder opened for the first time holds nothing, and an empty list
		// looks like an empty folder rather than one never fetched. Go and get
		// its first batch, which is what the user meant by opening it.
		if (!state.msgs.length && !fld(a, name).lastSync) syncAccount(a.address, false, name);
	}

	/// The folders this app has anything to say about: the ones it already holds
	/// mail from, the ones with a schedule, and the one on screen. The inbox is
	/// always among them, because every mailbox has one.
	///
	/// NOT every folder the server lists. `a.folders` carries a record for each of
	/// those, so that the pause tree has a leaf for each — but a record is not the
	/// same as a folder anybody has asked for, and a refresh that pulled a first
	/// batch out of forty Gmail labels would be a bill rather than a refresh.
	function trackedFolders(a) {
		var seen = {}, out = [];
		var add = function (n) { if (n && !seen[n]) { seen[n] = 1; out.push(n); } };
		add('INBOX');
		add(a.folder || 'INBOX');
		Object.keys(a.folders || {}).forEach(function (n) {
			if (ms(a.folders[n] && a.folders[n].lastSync)) add(n);
		});
		Object.keys(refreshMap(a)).forEach(add);
		return out;
	}

	/// Every folder of a mailbox that could be refreshed: the server's own list
	/// where it has answered, and what this device tracks where it has not.
	function allFolders(a) {
		var cache = a && state.folders[a.address];
		var list  = (cache && cache.list) || null;
		if (!list) return trackedFolders(a);
		var out = list.filter(function (f) { return f.selectable; })
			.map(function (f) { return f.name; });
		return out.length ? out : trackedFolders(a);
	}

	/// How many folders the manual refresh would touch, across how many
	/// mailboxes. The button's tooltip carries it, so the size of the thing is
	/// known BEFORE it is pressed rather than reported afterwards: every folder
	/// costs a call whether or not anything has arrived in it.
	function refreshScale() {
		var n = 0;
		state.accounts.forEach(function (a) { n += allFolders(a).length; });
		return { folders: n, boxes: state.accounts.length };
	}

	/// The manual refresh, doing what its name has always claimed: every folder
	/// of every mailbox.
	///
	/// It used to re-list the folders of the selected mailbox and nothing else,
	/// which is neither what the tooltip said nor what anybody reading "refresh"
	/// expects. Listing is free and is done first, so the walk that follows is of
	/// the folders the server has NOW.
	///
	/// Held folders are skipped and counted, not silently dropped: a refresh that
	/// quietly did less than it said is the thing this function exists to end.
	async function refreshAll() {
		if (state.busy || state.draining) return;
		var boxes = state.accounts.map(function (a) { return a.address; });
		if (!boxes.length) return;
		var done = 0, held = 0;
		for (var i = 0; i < boxes.length; i++) {
			await loadFolders(boxes[i], true);
		}
		for (var j = 0; j < boxes.length; j++) {
			var a = acct(boxes[j]);
			if (!a) continue;
			var names = allFolders(a);
			for (var k = 0; k < names.length; k++) {
				if (pollStop(a.address, names[k])) { held++; continue; }
				await syncAccount(a.address, false, names[k], true);
				done++;
			}
		}
		state.note = held
			? tf('mail.refreshed_held', '{done} folders refreshed in {boxes} mailboxes; '
				+ '{held} held by a pause.', { done: done, boxes: boxes.length, held: held })
			: tf('mail.refreshed', '{done} folders refreshed in {boxes} mailboxes.',
				{ done: done, boxes: boxes.length });
		render();
	}

	/// Email rides Pro now, so the button opens the Pro surface in Credits
	/// rather than a checkout of its own. The purchase, the return handling and
	/// the "you own it" confirmation all live in one place.
	function unlock() {
		if (window.DaimondAdmin && DaimondAdmin.credits) DaimondAdmin.credits(t('mail.pro_pitch'));
	}

	function friendly(e) {
		var m = (e && e.message) ? e.message : String(e);
		return m.replace(/\[[0-9;]*m/g, '');
	}
	function fmtMinor(n) {
		return window.DaimondGateway ? DaimondGateway.fmtMoney(n, 'usd') : ('$' + (n / 100).toFixed(2));
	}
	var HOUR = 3600000;

	/// What a folder row says about how much is in it, and when that was true.
	///
	/// The number is the messages the server handed over as at the folder's last
	/// sync, which is not the same thing as what is in the folder now — so the
	/// row never shows a bare figure. A folder never fetched shows no number at
	/// all: zero would say "I looked and it is empty", and that is a lie somebody
	/// will act on. A figure gone stale carries its age beside it in the row,
	/// because a `title` is a thing nobody can hover on a phone.
	function countPhrase(a, name) {
		var f    = a && a.folders && a.folders[name];
		var last = (f && ms(f.lastSync)) || 0;
		if (!last) {
			return {
				text: '—', when: ago(0), stale: true,
				title: tf('mail.count.never',
					'Not fetched yet, so there is no count.'),
			};
		}
		var n = (f && f.count) | 0;
		// Stale at twice its own period, or after an hour where it has none: a
		// folder polled every five minutes whose figure is twenty minutes old has
		// missed a poll, and an unscheduled one is only ever as fresh as the last
		// time somebody pressed refresh.
		var stale = (Date.now() - last) > Math.max(refreshOf(a, name) * 2000, HOUR);
		var title = tf('mail.count.asat', '{n} messages, as at {when}.',
			{ n: fmtCount(n), when: ago(last) });
		if (f && f.heldBack) {
			title += ' ' + tf('mail.count.more',
				'{n} more were waiting on the server then.', { n: fmtCount(f.heldBack) });
		}
		return { text: fmtCount(n), when: ago(last), stale: stale, title: title };
	}

	function ago(ts) {
		if (!ts) return t('mail.ago.never');
		var s = Math.floor((Date.now() - ts) / 1000);
		if (s < 60)    return t('mail.ago.just_now');
		if (s < 3600)  return t('mail.ago.mins',  { n: Math.floor(s / 60) });
		if (s < 86400) return t('mail.ago.hours', { n: Math.floor(s / 3600) });
		return t('mail.ago.days', { n: Math.floor(s / 86400) });
	}

	// ── The panel ───────────────────────────────────────────────────

	function render() {
		if (!els.state) return;

		// The unlock, or the reason there is nothing to show.
		els.state.innerHTML = '';
		if (state.unlocked === false) {
			els.state.appendChild(html(
				'<div class="mail-pitch">'
				+ '<p>' + t('mail.pitch.head') + '</p>'
				+ '<p class="mail-fine">' + t('mail.pitch.fine', { cap: state.cap }) + '</p>'
				+ '<p class="mail-fine">' + t('mail.pitch.privacy') + '</p>'
				+ '<button class="mail-unlock"' + (state.busy ? ' disabled' : '') + '>'
				+ esc(t('pro.buy')) + '</button>'
				+ '</div>'));
			var ub = els.state.querySelector('.mail-unlock');
			if (ub) ub.addEventListener('click', unlock);
		} else if (state.unlocked === null) {
			els.state.appendChild(html('<div class="mail-fine">'
				+ esc(t('mail.pitch.unknown')) + '</div>'));
		}
		if (state.err) els.state.appendChild(html('<div class="mail-err">' + esc(state.err) + '</div>'));
		else if (state.note) els.state.appendChild(html('<div class="mail-note">' + esc(state.note) + '</div>'));

		// The mailboxes.
		els.accounts.innerHTML = '';
		if (state.unlocked !== false) {
			els.accounts.appendChild(globalRow());
			state.accounts.forEach(function (a) {
				var row = document.createElement('div');
				row.className = 'mail-acct' + (a.address === state.sel ? ' on' : '');
				// The mailbox's own control leads the row, as it leads every row on
				// the rail. It governs the BRANCH: pressing it pauses the mailbox's
				// own polling and every folder under it at once, and it shows amber
				// when only some of them are held.
				row.appendChild(pptw(boxNode(a.address), a.address));
				row.appendChild(html('<span class="mail-addr">' + esc(a.address) + '</span>'));
				row.appendChild(html('<span class="mail-when">' + esc(ago(a.lastSync)) + '</span>'));
				var gear = document.createElement('button');
				gear.className = 'mail-gear';
				gear.title = tf('mail.settings', 'Mailbox settings');
				gear.setAttribute('aria-label',
					tf('mail.settings_named', 'Settings for {address}', { address: a.address }));
				// A cog, drawn as the app draws its icons: a stroked path in a
				// 24-unit box, so it sits on the same grid as the railhead's.
				// One drawing of the cog for the whole app. This file used to hold its
				// own copy of the same path, which is how an icon set drifts.
				if (window.DaimondUI && DaimondUI.cogIcon) gear.appendChild(DaimondUI.cogIcon());
				gear.addEventListener('click', function (ev) {
					ev.stopPropagation();
					openSettings(a.address);
				});
				row.appendChild(gear);
				// The closer cross is gone, and Remove is at the foot of what the gear
				// opens. It was `opacity: 0` until hover -- no control at all on a phone
				// -- and it put the one irreversible act on the row's most reachable
				// pixel, beside the act of SELECTING the mailbox. Exactly the reasoning
				// phase C applied to a tile, and exactly what notes2 asks for here.
				//
				// The one exception is a container with no dialog of its own to put it
				// in: `openSettings` says so, and the cross stays for that case alone.
				if (!(deps && typeof deps.bodyDialog === 'function')) {
					var del = document.createElement('button');
					del.className = 'mail-del';
					del.title = t('mail.remove_mailbox');
					del.setAttribute('aria-label', t('mail.remove_mailbox_named', { address: a.address }));
					del.textContent = '×';
					del.addEventListener('click', function (ev) {
						ev.stopPropagation();
						removeAccount(a.address);
					});
					row.appendChild(del);
				}
				rowAsButton(row, function () {
					state.sel = a.address; save();
					Promise.all([loadDigest(a.address), refreshDrafts()]).then(render);
					loadFolders(a.address);
				}, a.address);
				// Which mailbox is being shown, said rather than only coloured.
				if (a.address === state.sel) row.setAttribute('aria-current', 'true');
				els.accounts.appendChild(row);
			});
			if (!state.accounts.length && state.unlocked) {
				els.accounts.appendChild(html('<div class="mail-fine">'
					+ t('mail.no_mailbox') + '</div>'));
			}
		}

		renderFolders();

		// The drafts. Unsent mail sits above the inbox because it is the only thing in the
		// panel that is waiting on the user — and because a draft an agent wrote for them
		// to check would otherwise be written into a folder nobody looks in.
		els.list.innerHTML = '';
		if (state.sel && state.drafts.length) {
			var box = html('<div class="mail-drafts"><div class="mail-drafts-head">'
				+ esc(t('mail.drafts_head', { n: state.drafts.length })) + '</div></div>');
			state.drafts.forEach(function (d) {
				var row = document.createElement('div');
				row.className = 'mail-draft';
				row.innerHTML = '<div class="mail-subj">' + esc(d.subject) + '</div>'
					+ '<div class="mail-from">' + esc(d.to || t('mail.no_recipient')) + '</div>';
				rowAsButton(row, function () { openDraft(d.path); });
				box.appendChild(row);
			});
			els.list.appendChild(box);
		}

		// The messages.
		if (state.sel && state.msgs.length) {
			state.msgs.slice().reverse().forEach(function (m) {
				var row = document.createElement('div');
				row.className = 'mail-msg' + (m.seen ? '' : ' unread');
				row.innerHTML = '<div class="mail-from">' + esc(m.from || t('mail.unknown_sender')) + '</div>'
					+ '<div class="mail-subj">' + esc(m.subject) + '</div>'
					+ '<div class="mail-date">' + esc((m.date || '').replace(/\s*\(.*\)$/, '')) + '</div>';
				rowAsButton(row, function () { openMessage(m); });
				els.list.appendChild(row);
			});

			// A sync stops at the cap, and a list that just stops looks like a mailbox that ends.
			// Say what is still up there, and offer to go and get it.
			var sel = acct(state.sel);
			var sf  = sel ? fld(sel) : null;
			if (sf && sf.heldBack > 0) {
				var n = Math.min(sf.limit || 0, sf.heldBack) || sf.heldBack;
				var more = html(
					'<div class="mail-more">'
					+ '<div class="mail-fine">'
					+ esc(tn('mail.more.note', sf.heldBack,
						{ n: fmtCount(sf.heldBack), batch: sf.limit || n }))
					+ '</div>'
					+ '<div class="mail-more-btns">'
					+ '<button class="mail-older"' + (state.busy ? ' disabled' : '') + '>'
					+ esc(t('mail.more.next', { n: n })) + '</button>'
					+ (state.draining
						? '<button class="mail-stop">' + esc(t('mail.more.stop')) + '</button>'
						: '<button class="mail-all"' + (state.busy ? ' disabled' : '') + '>'
							+ esc(t('mail.more.all')) + '</button>')
					+ '</div>'
					+ '</div>');
				var ob = more.querySelector('.mail-older');
				if (ob) ob.addEventListener('click', function () { syncAccount(state.sel, true); });
				var ab = more.querySelector('.mail-all');
				if (ab) ab.addEventListener('click', function () { fetchAll(state.sel); });
				var sb = more.querySelector('.mail-stop');
				if (sb) sb.addEventListener('click', function () { state.draining = false; });
				els.list.appendChild(more);
			}
		} else if (state.sel && state.unlocked !== false) {
			els.list.appendChild(html('<div class="mail-fine">' + t('mail.nothing_yet') + '</div>'));
		}

		// One re-arming point for the schedule. Every change that could move a due
		// time — a sync finishing, a frequency changing, a mailbox arriving in a
		// parcel, the device unlocking — already ends here, so none of them has to
		// remember the timer.
		arm();
	}

	/// The row above the mailbox list: one control for all of mail, and the one
	/// manual refresh.
	///
	/// The pause control governs `root/mail`, the branch every mailbox hangs
	/// from — the honest "global" for this panel. It is deliberately NOT `root`:
	/// the rail already carries that one, and a second control for the same node
	/// in a second place is two answers to one question.
	///
	/// Sentence case and a rule under it, not a section heading. The rail learnt
	/// that the hard way: dressed as a heading, a row led by a light reads as a
	/// section that has lost its alignment (see `.pptw-head`, app.css:207).
	function globalRow() {
		var row = document.createElement('div');
		row.className = 'mail-globals';
		row.appendChild(pptw(mailNode(), tf('pause.mail', 'Mail')));
		row.appendChild(html('<span class="mail-globals-label">'
			+ esc(tf('mail.all_mailboxes', 'All mailboxes')) + '</span>'));
		var b = document.createElement('button');
		b.className = 'mail-refresh';
		// The size of it, before it is pressed. Every folder costs a call whether
		// or not anything has arrived in it, and a person with forty Gmail labels
		// should be able to see that coming.
		var sc = refreshScale();
		b.title = tf('mail.refresh_all',
			'Refresh all {folders} folders in {boxes} mailboxes',
			{ folders: sc.folders, boxes: sc.boxes });
		b.setAttribute('aria-label', b.title);
		b.textContent = '⟳';
		b.disabled = !!(state.busy || state.draining) || !state.accounts.length;
		b.addEventListener('click', function () { refreshAll(); });
		row.appendChild(b);
		return row;
	}

	/// The folder picker: which of the account's mailboxes the list below is
	/// showing. It is drawn only when there is an account to have folders, and
	/// stays a single row — the inbox — until the server has answered.
	function renderFolders() {
		if (!els.folders) return;
		els.folders.innerHTML = '';
		var a = acct(state.sel);
		if (!a || state.unlocked === false) return;

		var cache = state.folders[a.address] || {};
		var list  = cache.list || [{ name: 'INBOX', role: '', selectable: true }];

		// The refresh that used to sit here now leads the panel, beside the pause
		// control that supplements it: it acts on every mailbox, so a head scoped
		// to one mailbox was the wrong place to press it from.
		els.folders.appendChild(html('<div class="mail-folders-head">'
			+ '<span>' + esc(t('mail.folders')) + '</span></div>'));

		var box = document.createElement('div');
		box.className = 'mail-folder-list';
		list.forEach(function (f) {
			var row = document.createElement('div');
			// `mail-acct` carries the row's shape and its selected state already:
			// a folder is the same kind of choice as a mailbox, one level down.
			row.className = 'mail-acct mail-folder' + (f.name === (a.folder || 'INBOX') ? ' on' : '');
			row.setAttribute('data-folder', f.name);
			if (f.role) row.setAttribute('data-role', f.role);
			var depth = f.delimiter ? f.name.split(f.delimiter).length - 1 : 0;
			if (depth > 0) row.style.setProperty('--folder-depth', depth);
			row.innerHTML = '<span class="mail-addr">' + esc(labelFor(a, f.name)) + '</span>';
			// How much is in it, and when that was true. A container holds no mail,
			// so it gets no number rather than a nought.
			var c = null;
			if (f.selectable) {
				c = countPhrase(a, f.name);
				// The age comes FIRST and the number last, so the numbers make a
				// column down the right edge. Put the age after and every count
				// with an age beside it steps left, which is exactly the reading
				// the column exists to give: which folder holds the most.
				//
				// It is shown only where the figure can no longer be trusted on its
				// own. On a fresh one it is noise, and the title carries it anyway.
				if (c.stale) {
					row.appendChild(html('<span class="mail-when">' + esc(c.when) + '</span>'));
				}
				var cnt = document.createElement('span');
				cnt.className = 'mail-count' + (c.stale ? ' stale' : '');
				cnt.textContent = c.text;
				cnt.title = c.title;
				row.appendChild(cnt);
			}
			if (!f.selectable) {
				// A container, not a mailbox: `[Gmail]` holds folders, not mail. It is
				// not made operable and stays out of the tab order, which is the whole
				// of what `aria-disabled` is claiming here.
				row.setAttribute('aria-disabled', 'true');
			} else {
				// The count is read out with the name: a screen reader cannot hover
				// the title, and "as at" is the half of the number that matters.
				rowAsButton(row, function () { selectFolder(f.name); },
					labelFor(a, f.name) + ' — ' + c.title);
				if (f.name === (a.folder || 'INBOX')) row.setAttribute('aria-current', 'true');
			}
			box.appendChild(row);
		});
		els.folders.appendChild(box);

		if (cache.busy) {
			els.folders.appendChild(html('<div class="mail-fine">'
				+ esc(t('mail.folders_loading')) + '</div>'));
		} else if (cache.err) {
			els.folders.appendChild(html('<div class="mail-fine">' + esc(cache.err) + '</div>'));
		}
	}

	function html(s) {
		var d = document.createElement('div');
		d.innerHTML = s;
		return d.firstElementChild || d;
	}

	// ── A mailbox's settings ────────────────────────────────────────

	/// How often, in words. The frequencies are a fixed list and each gets its
	/// own key: "every {n} minutes" is a sentence a translator cannot decline
	/// without knowing the number, and there are only eight of them.
	var EVERY_EN = {
		0:     'Manual only',
		300:   'Every 5 minutes',
		900:   'Every 15 minutes',
		1800:  'Every 30 minutes',
		3600:  'Every hour',
		14400: 'Every 4 hours',
		43200: 'Every 12 hours',
		86400: 'Once a day',
	};
	function everyLabel(secs) {
		return EVERY_EN[secs] ? tf('mail.every.' + secs, EVERY_EN[secs])
			: tf('mail.every.secs', 'Every {n} seconds', { n: secs });
	}

	/// The frequency picker for one folder.
	function everySelect(a, name) {
		var sel = document.createElement('select');
		sel.className = 'mail-every';
		var cur  = refreshOf(a, name);
		var opts = EVERY.slice();
		// A frequency set from outside the list — a test, or a parcel from a
		// build that offered a different list — stays offered rather than being
		// silently rounded to whatever is nearest.
		if (opts.indexOf(cur) < 0) opts.push(cur);
		opts.sort(function (x, y) { return x - y; });
		opts.forEach(function (v) {
			var o = document.createElement('option');
			o.value = String(v);
			o.textContent = everyLabel(v);
			if (v === cur) o.selected = true;
			sel.appendChild(o);
		});
		sel.setAttribute('aria-label',
			tf('mail.every_for', 'How often {folder} refreshes itself',
				{ folder: labelFor(a, name) }));
		sel.addEventListener('change', function () {
			setRefresh(a.address, name, parseInt(sel.value, 10) || 0);
		});
		return sel;
	}

	/// The body of a mailbox's settings dialog: one tile per folder, each with
	/// its own pause control and how often it refreshes itself.
	///
	/// Returns the element and nothing else. The dialog that carries it is phase
	/// C's tile dialog, and so is the Delete that belongs at its foot in place of
	/// the closer cross on the mailbox row — neither is built here.
	function settingsBody(address) {
		var a = acct(address);
		var box = document.createElement('div');
		box.className = 'mail-cfg';
		if (!a) return box;

		box.appendChild(html('<p class="mail-fine">'
			+ esc(tf('mail.cfg.head', 'How often each folder goes and looks, and which of them may. Every refresh '
				+ 'costs credits, so nothing polls until you say so.')) + '</p>'));

		// The mailbox's own leaf, first, because it governs everything below it.
		// It carries no frequency of its own: what the user schedules is folders,
		// and this is the switch that holds all of them at once.
		var self = document.createElement('div');
		self.className = 'mail-tile mail-tile-self';
		self.appendChild(pptw(selfNode(address), tf('pause.mail_polling', 'Mailbox polling')));
		self.appendChild(html('<span class="mail-tile-name">'
			+ esc(tf('pause.mail_polling', 'Mailbox polling')) + '</span>'));
		self.appendChild(html('<span class="mail-fine">'
			+ esc(tf('mail.cfg.self', 'Holds every folder below.')) + '</span>'));
		box.appendChild(self);

		// The server's list where it has answered, and what this device tracks
		// where it has not: a locked or offline device should still show the
		// folders it holds mail for rather than the inbox alone.
		var cache = state.folders[address] || {};
		var names = (cache.list || []).filter(function (f) { return f.selectable; })
			.map(function (f) { return f.name; });
		if (!names.length) names = trackedFolders(a);

		names.forEach(function (n) {
			var tile = document.createElement('div');
			tile.className = 'mail-tile';
			tile.setAttribute('data-folder', n);
			tile.appendChild(pptw(folderNode(address, n), labelFor(a, n)));
			tile.appendChild(html('<span class="mail-tile-name">'
				+ esc(labelFor(a, n)) + '</span>'));
			// The same reading as the folder row, in the same order: the age where
			// the figure can no longer be trusted, then the figure. This is the one
			// screen where somebody is deciding how often a folder should look, so
			// a `title` nobody can hover on a phone is not enough on its own.
			var c = countPhrase(a, n);
			if (c.stale) tile.appendChild(html('<span class="mail-when">' + esc(c.when) + '</span>'));
			var cnt = html('<span class="mail-count' + (c.stale ? ' stale' : '') + '">'
				+ esc(c.text) + '</span>');
			cnt.title = c.title;
			tile.appendChild(cnt);
			tile.appendChild(everySelect(a, n));
			box.appendChild(tile);
		});
		return box;
	}

	/// Open a mailbox's settings, with Remove at the foot.
	///
	/// `deps.bodyDialog` is the container's own dialog -- phase C's, the one every
	/// tile uses -- and it owns the focus trap, the Escape handling and the
	/// destructive button at the foot. Notes2 asks for the mailbox's closer cross to
	/// become "a delete button at bottom", which is word for word what it asks for a
	/// tile, so it had better be the same dialog: two copies drift the first time
	/// either is touched.
	///
	/// The stand-in below survives for a container that does not offer one. It has no
	/// Remove, and that is the honest version rather than a second implementation of
	/// the destructive path -- the row's own control is still there in that case.
	function openSettings(address) {
		var body  = settingsBody(address);
		var title = tf('mail.cfg.title', 'Settings for {address}', { address: address });
		if (deps && typeof deps.bodyDialog === 'function') {
			// No Done. Everything in this dialog has already taken effect by the
			// time you would press it, so the way out is the cross in the corner
			// and the foot is left to the one act that decides something.
			return deps.bodyDialog(title, body, {
				deleteLabel: t('mail.remove_mailbox'),
				onDelete:    function () { return removeAccount(address); },
			});
		}
		var back = html('<div class="modal dlg"></div>');
		var card = html('<div class="modal-card dlg-card"></div>');
		var h = document.createElement('h2');
		h.id = 'mail-cfg-title';
		h.textContent = title;
		// Named and declared, which the app's own dialogs are not yet
		// (dev/a11y_report.md §5). A stand-in is no reason to repeat a defect.
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-modal', 'true');
		card.setAttribute('aria-labelledby', h.id);
		card.appendChild(h);
		card.appendChild(body);
		var row = html('<div class="dlg-actions"></div>');
		var ok  = document.createElement('button');
		ok.type = 'button';
		ok.className = 'dlg-ok';
		ok.textContent = tf('dlg.done', 'Done');
		row.appendChild(ok);
		card.appendChild(row);
		back.appendChild(card);
		document.body.appendChild(back);

		var prev = document.activeElement;
		function close() {
			document.removeEventListener('keydown', onKey, true);
			back.remove();
			if (prev && prev.focus) { try { prev.focus(); } catch (e) { /* gone */ } }
		}
		function onKey(e) {
			if (e.key === 'Escape') { e.preventDefault(); close(); return; }
			if (e.key !== 'Tab') return;
			// Keep Tab inside the card. Without it the focus ring walks off into the
			// panel behind and a keyboard user cannot get back to Done.
			var f = card.querySelectorAll('button, select, [tabindex]:not([tabindex="-1"])');
			if (!f.length) return;
			var first = f[0], last = f[f.length - 1];
			if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
		}
		document.addEventListener('keydown', onKey, true);
		back.addEventListener('mousedown', function (e) { if (e.target === back) close(); });
		ok.addEventListener('click', close);
		ok.focus();
		return Promise.resolve(true);
	}

	/// Make a row behave as the button it already is.
	///
	/// Every choice in this panel -- a mailbox, a folder, a draft, a message -- was a
	/// `<div>` with a click handler, so the whole of Email could be reached only with a
	/// pointer: not picking a mailbox, not changing folder, not opening anything. This is
	/// the same treatment the Diamond rows in the rail already carry, and it is deliberately
	/// the same code, because a second way of doing it is a second thing to keep right.
	///
	/// `label` is optional. A `role="button"` takes its spoken name from its own contents,
	/// which for a draft or a message is exactly the right name -- sender, subject, date, in
	/// the order they are read. It is passed only where the contents would mislead: the
	/// mailbox row ends in a `×` closer whose text would otherwise be read out as part of
	/// the mailbox's name.
	///
	/// @param row     The element to make operable.
	/// @param onPress What a click or an Enter/Space does.
	/// @param label   An explicit accessible name, where the contents will not serve.
	function rowAsButton(row, onPress, label) {
		row.setAttribute('role', 'button');
		row.setAttribute('tabindex', '0');
		if (label) row.setAttribute('aria-label', label);
		row.addEventListener('click', onPress);
		row.addEventListener('keydown', function (e) {
			if (e.key !== 'Enter' && e.key !== ' ') return;
			// Not when the press belongs to something inside the row -- the closer answers
			// for itself, and Space on a nested button must not also open the row.
			if (e.target !== row) return;
			e.preventDefault();
			onPress();
		});
	}

	/// Show a message where there is room to read it. The body is inserted as
	/// text, never as markup — a mail body is the least trustworthy string in
	/// the application, and this is the one place it meets the DOM.
	/// Walk a MIME tree and collect what a reader needs: the plain part, the HTML part, and every
	/// attachment. `readableText` answers "what does this message say" in one string, which is the
	/// right answer for an index and the wrong one for a person reading their mail — it throws
	/// away the markup, the pictures and the files.
	///
	/// Returns `{ plain, html, attachments: [{ name, type, size, bytes }] }`.
	function parseMime(raw, depth) {
		var out = { plain: '', html: '', attachments: [] };
		if ((depth || 0) > 8) return out;                 // a malformed message must not recurse forever

		var hs    = parseHeaders(raw);
		var ctype = header(hs, 'content-type') || 'text/plain';
		var body  = bodyOf(raw);
		var mb    = ctype.match(/boundary="?([^";]+)"?/i);

		if (/^multipart\//i.test(ctype.trim()) && mb) {
			var parts = body.split('--' + mb[1]);
			parts.forEach(function (p) {
				p = p.replace(/^\r?\n/, '');
				if (!p.trim() || /^--/.test(p)) return;   // the closing delimiter, not a part
				var sub = parseMime(p, (depth || 0) + 1);
				if (!out.plain && sub.plain) out.plain = sub.plain;
				if (!out.html  && sub.html)  out.html  = sub.html;
				out.attachments = out.attachments.concat(sub.attachments);
			});
			return out;
		}

		// A leaf part.
		var enc  = (header(hs, 'content-transfer-encoding') || '').toLowerCase();
		var disp = header(hs, 'content-disposition') || '';
		var name = decodeWords(
			(disp.match(/filename="?([^";]+)"?/i) || ctype.match(/name="?([^";]+)"?/i) || [])[1] || '');

		var decoded = body;
		if (enc === 'base64')                 decoded = decodeB64(body);
		else if (enc === 'quoted-printable')  decoded = decodeQP(body);

		// An attachment is anything the sender marked as one, or any leaf that is not text and
		// carries a filename. Inline images (a signature logo) are attachments too as far as we
		// are concerned: we do not render remote or embedded pictures.
		var isText = /^text\/(plain|html)/i.test(ctype.trim());
		if (/attachment/i.test(disp) || (!isText && name)) {
			var bytes = new Uint8Array(decoded.length);
			for (var i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i) & 0xff;
			out.attachments.push({
				name: name || 'attachment',
				type: (ctype.split(';')[0] || '').trim(),
				size: bytes.length,
				bytes: bytes,
			});
			return out;
		}

		var cs = (ctype.match(/charset="?([^";]+)"?/i) || [])[1];
		var txt = asUtf8(decoded, cs);
		if (/text\/html/i.test(ctype))       out.html  = txt;
		else if (/text\/plain/i.test(ctype)) out.plain = txt;
		else if (!/^multipart\//i.test(ctype.trim()) && !name) out.plain = txt;
		return out;
	}

	/// Split "Jason Hoogland <jason@example.com>" into the two things a reader wants shown
	/// differently: a name to read, and an address to check.
	function splitAddr(s) {
		s = decodeWords(s || '').trim();
		var m = s.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
		if (m) {
			var nm = m[1].replace(/^["']|["']$/g, '').trim();
			return { name: nm, addr: m[2].trim() };
		}
		return { name: '', addr: s };
	}

	async function openMessage(m) {
		var raw = await readText(m.file);
		if (typeof raw !== 'string' || /^\s*Error\b/i.test(raw)) {
			state.err = t('mail.err.msg_unreadable');
			render();
			return;
		}
		var hs    = parseHeaders(raw);
		var mime  = parseMime(raw, 0);
		var view = {
			subject: decodeWords(header(hs, 'subject')) || t('mail.no_subject'),
			from:    splitAddr(header(hs, 'from')),
			to:      decodeWords(header(hs, 'to')),
			cc:      decodeWords(header(hs, 'cc')),
			replyTo: decodeWords(header(hs, 'reply-to')),
			date:    header(hs, 'date'),
			html:    mime.html,
			text:    mime.plain || (mime.html ? '' : readableText(raw)),
			attachments: mime.attachments,
			mailbox: state.sel,
			// The folder it was read from, so an attachment saved out of it
			// lands beside the message rather than in the inbox.
			folder:  (acct(state.sel) || {}).folder || 'INBOX',
			file:    m.file,
			// What a reply to this message must point back at, so it threads rather than
			// arriving as an unrelated message with a similar subject.
			messageId:  header(hs, 'message-id'),
			references: header(hs, 'references'),
			// Saving an attachment is the panel's job, but the workspace is the mail module's:
			// it knows where this mailbox lives on disk.
			save:    async function (att) {
				var dir  = mailboxDir(state.sel, view.folder) + '/attachments';
				var safe = String(att.name || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_');
				var path = dir + '/' + safe;
				await deps.writeBytes(path, att.bytes);
				if (deps.refreshFiles) deps.refreshFiles();
				return path;
			},
		};
		// The verbs live on the message, where the reader is when they decide to answer it.
		view.reply    = function () { replyTo(view, false); };
		view.replyAll = function () { replyTo(view, true); };
		view.forward  = function () { forward(view); };
		view.canReplyAll = others(view, view.mailbox).length > 0;
		deps.showMessage(view);
	}

	// ── Composing ───────────────────────────────────────────────────

	/// Hand a draft to the compose panel, with the three things it can do to it.
	///
	/// The panel edits fields and hands them back; the draft's threading — its own
	/// `Message-ID`, and what it is a reply to — is not on screen and not editable, so it
	/// is carried here rather than through the DOM.
	function openCompose(d) {
		if (!deps.showCompose) return;
		if (!state.accounts.length) {
			state.err = t('mail.err.add_mailbox_first');
			render();
			return;
		}
		d.from = d.from || state.sel || state.accounts[0].address;
		deps.showCompose({
			draft:   d,
			from:    state.accounts.map(function (a) { return a.address; }),
			send:    async function (fields) { return sendDraft(Object.assign({}, d, fields)); },
			save:    async function (fields) {
				var path = await saveDraft(Object.assign(d, fields));
				await refreshDrafts();
				return path;
			},
			discard: async function () {
				await discardDraft(d);
				await refreshDrafts();
			},
			sent:    function (note) {
				state.note = note;
				state.err = '';
				refreshDrafts().then(render);
			},
		});
	}

	/// The quoted body of a message being answered, in the shape every mail client has
	/// used for thirty years: a line saying who said it, then their words behind `>`.
	function quote(v) {
		var who  = (v.from && (v.from.name || v.from.addr)) || t('mail.quote.they');
		var when = v.date ? new Date(v.date) : null;
		var dated = when && !isNaN(when.getTime());
		// A quote with no readable date used to put the phrase "an earlier date"
		// into a slot the sentence was built around a DATE for, which every
		// translator then had to work around. An undated quote gets its own
		// sentence instead.
		var head = dated
			? t('mail.quote.head', { date: longDate(when), who: who })
			: t('mail.quote.head_undated', { who: who });
		var text = v.text || (v.html ? stripHtml(v.html) : '');
		var body = String(text).split('\n').map(function (l) { return '> ' + l; }).join('\n');
		return '\n\n' + head + '\n' + body + '\n';
	}

	/// Everyone on the message except me: a reply-all that copies the sender back to
	/// themselves is a nuisance, and one that copies *me* is noise in my own inbox.
	function others(v, mine) {
		var seen = {};
		return addrList([v.to, v.cc].filter(Boolean).join(', '))
			.filter(function (x) {
				var a = splitAddr(x).addr.toLowerCase();
				if (!a || a === String(mine || '').toLowerCase() || seen[a]) return false;
				seen[a] = 1;
				return true;
			});
	}

	function replyTo(v, all) {
		var mine = v.mailbox || state.sel;
		var to   = v.replyTo || (v.from && (v.from.name ? v.from.name + ' <' + v.from.addr + '>' : v.from.addr)) || '';
		var subj = /^re:/i.test(v.subject || '') ? v.subject : 'Re: ' + (v.subject || '');
		openCompose({
			from:       mine,
			to:         to,
			cc:         all ? others(v, mine).join(', ') : '',
			subject:    subj,
			body:       quote(v),
			inReplyTo:  v.messageId || '',
			// A thread is the chain of every message before this one, so the reply carries
			// the parent's references and adds the parent itself.
			references: [v.references, v.messageId].filter(Boolean).join(' ').trim(),
			attachments: [],
		});
	}

	function forward(v) {
		var subj = /^fwd?:/i.test(v.subject || '') ? v.subject : 'Fwd: ' + (v.subject || '');
		// The separator is what the reader sees; the four field names below it
		// are the message's own headers, and stay spelled as headers are.
		var head = '\n\n' + t('mail.fwd.sep') + '\n'
			+ 'From: ' + ((v.from && (v.from.name ? v.from.name + ' <' + v.from.addr + '>' : v.from.addr)) || '') + '\n'
			+ (v.date ? 'Date: ' + v.date + '\n' : '')
			+ 'Subject: ' + (v.subject || '') + '\n'
			+ (v.to ? 'To: ' + v.to + '\n' : '') + '\n';
		openCompose({
			from:        v.mailbox || state.sel,
			to:          '',
			cc:          '',
			subject:     subj,
			body:        head + (v.text || (v.html ? stripHtml(v.html) : '')),
			// A forward that dropped the attachments would forward the wrong message.
			attachments: (v.attachments || []).slice(),
		});
	}

	async function refreshDrafts() {
		state.drafts = state.sel ? await listDrafts(state.sel) : [];
	}

	async function openDraft(path) {
		try {
			openCompose(await readDraft(state.sel, path));
		} catch (e) {
			state.err = friendly(e);
			render();
		}
	}

	// ── Adding a mailbox ────────────────────────────────────────────

	async function addAccount() {
		if (state.unlocked === false) { unlock(); return; }
		if (state.accounts.length >= state.cap) {
			state.err = tn('mail.err.cap', state.cap);
			render();
			return;
		}
		var v = await deps.mailDialog(PRESETS, UNREACHABLE);
		if (!v) return;
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			state.err = t('mail.err.unlock_first');
			render();
			return;
		}
		var wrapped = await DaimondIdentity.wrap(v.password);
		state.accounts.push({
			address:     v.address,
			host:        v.host,
			port:        v.port,
			// Reading and posting are different servers, and the account holds both, so a
			// message can be sent from the mailbox it was read in without asking again.
			smtpHost:    v.smtpHost,
			smtpPort:    v.smtpPort,
			user:        v.user || v.address,
			pass:        wrapped,
			// The inbox is where a new mailbox starts; the rest of its folders
			// arrive when the server is asked what it has.
			folder:      'INBOX',
			folders:     { INBOX: blankFolder('INBOX') },
			lastSync:    0,
			// When this configuration was last stated. The cross-device merge decides
			// on it, and on nothing else: a device that merely SYNCED a mailbox has
			// not thereby won an argument about which server it lives on. It must
			// also beat any tombstone this address already carries -- removing a
			// mailbox and adding it straight back is one action to the user and two
			// to the store, and a re-add stamped in the same millisecond as its own
			// deletion would lose to it and vanish again on the next pull.
			touched:     Math.max(Date.now(), ms(tombs()[v.address]) + 1),
		});
		state.sel = v.address;
		save();
		render();
		syncAccount(v.address);
		loadFolders(v.address, true);
	}

	async function removeAccount(address) {
		var ok = await deps.confirm(t('mail.remove.title', { address: address }),
			t('mail.remove.body'),
			{ ok: t('mail.remove.ok'), danger: true });
		if (!ok) return;
		// Before the list is written, so the very next push carries the deletion:
		// without a tombstone the other device still holds this mailbox and simply
		// hands it back — with its password — on the following pull.
		tombstone(address);
		state.accounts = state.accounts.filter(function (a) { return a.address !== address; });
		delete state.folders[address];
		// Every pause flag under the mailbox goes with it. A stale leaf id is
		// harmless to `isPaused`, but it would hold `root/mail` amber for ever and
		// travel in the parcel for the life of the account.
		try { if (window.DaimondPause) DaimondPause.forget(boxNode(address)); }
		catch (e) { /* module not up */ }
		if (state.sel === address) {
			state.sel = (state.accounts[0] && state.accounts[0].address) || null;
			state.msgs = [];
		}
		save();
		// Free the seat at the gateway, which is the only place the cap is real.
		// Through DaimondGateway.gwFetch: an hour into a sitting this was a 401 into a swallowed
		// catch, so the mailbox left the panel and the seat stayed taken -- and
		// the next add met a cap the user could see no reason for.
		try {
			await DaimondGateway.gwFetch('/api/mail/accounts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ address: address }),
			});
		} catch (e) { /* the local list is what the user sees; the seat is retried on the next add */ }
		render();
	}

	// ── Wiring ──────────────────────────────────────────────────────

	function init(d) {
		deps = d;
		var panel = document.getElementById('panel-mail');
		if (!panel) return;
		els.state    = document.getElementById('mail-state');
		els.accounts = document.getElementById('mail-accounts');
		els.folders  = document.getElementById('mail-folders');
		els.list     = document.getElementById('mail-list');
		var add  = panel.querySelector('[data-act="mail-add"]');
		var sync = panel.querySelector('[data-act="mail-sync"]');
		var neu  = panel.querySelector('[data-act="mail-new"]');
		if (add)  add.addEventListener('click', addAccount);
		if (sync) sync.addEventListener('click', function () {
			if (state.sel) syncAccount(state.sel);
		});
		if (neu) neu.addEventListener('click', function () {
			openCompose({ to: '', cc: '', subject: '', body: '', attachments: [] });
		});
		load();
		render();
		// The digest is NOT read here: init runs during boot, before the wasm
		// module that backs the file tools exists, and reading it threw a
		// TypeError into the console. It is read in onOpen(), which runs once
		// the app is up.
	}

	/// Called when the panel is opened, and after a returning Stripe checkout.
	function onOpen() {
		refreshEntitlement();
		if (state.sel) {
			var a = acct(state.sel);
			Promise.all([loadDigest(state.sel, a && a.folder), refreshDrafts()]).then(render);
			// Free, so it can be asked every time the panel is opened; cached,
			// so it is asked of the server once per account per page.
			loadFolders(state.sel);
		}
	}

	/// Logging out clears the user's content from the DOM. Mail is theirs.
	function clear() {
		// Before the accounts go: a timer armed against a mailbox that has just
		// left the page would poll a mailbox nobody is signed in to.
		if (timer) { clearTimeout(timer); timer = null; }
		state.accounts = [];
		state.msgs = [];
		state.drafts = [];
		state.folders = {};
		state.sel = null;
		state.unlocked = null;
		state.note = '';
		state.err = '';
		render();
	}

	// The panel stays mounted once it is open, so a language change has to
	// redraw it where it stands rather than waiting for it to be built again.
	if (window.DaimondI18n) {
		DaimondI18n.onChange(function () { if (els.state) render(); });
	}

	window.DaimondMail = {
		init:    init,
		/// Whether any account is configured. The Message and Compose panels are
		/// held off the chip row until one is, since neither means anything
		/// without somewhere for mail to come from.
		hasAccounts: function () { return state.accounts.length > 0; },
		/// The addresses configured, for a trigger that watches one of them. Names
		/// only: nothing outside this module has any business with a password.
		accounts: function () {
			return state.accounts.map(function (a) { return a.address; });
		},
		onOpen:  onOpen,
		clear:   clear,
		// Cross-device sync (driven by sync.js through DaimondCore): what to put in
		// the parcel, and what to do with what comes back.
		exportSync: exportSync,
		applySync:  applySync,
		sync:    function () { if (state.sel) syncAccount(state.sel); },
		/// Open a draft the daimon wrote, for the user to check and send. Exposed
		/// because the Pending panel is where an outgoing message is approved, and
		/// approving one means opening it -- notes2 is explicit that the user
		/// approves all outgoing mail, so nothing here sends on their behalf.
		openDraft:    openDraft,
		reload:  function () { load(); render(); },
		/// The folder list held for an account, and the way to ask for it
		/// again. Exposed so a test can see what the server offered without
		/// reading it back out of the DOM.
		folders:      function (address) {
			var c = state.folders[address || state.sel];
			return (c && c.list) ? c.list.slice() : [];
		},
		loadFolders:  function (address, force) { return loadFolders(address || state.sel, force); },
		folder:       function () { var a = acct(state.sel); return (a && a.folder) || 'INBOX'; },
		selectFolder: selectFolder,
		/// How often a folder refreshes itself, in seconds; 0 for manual only.
		/// Seconds rather than the dialog's eight choices, so a verifier can ask
		/// for an interval short enough to watch without waiting five minutes.
		refreshOf:    function (address, name) { return refreshOf(acct(address || state.sel), name); },
		setRefresh:   setRefresh,
		/// Every folder of every mailbox, which is what the panel's one refresh
		/// button does.
		refreshAll:   refreshAll,
		/// What the folder rows say they hold, and when that was true. Exposed so
		/// a test can read the number without parsing it back out of the DOM.
		counts:       function (address) {
			var a = acct(address || state.sel);
			if (!a) return {};
			var out = {};
			Object.keys(a.folders || {}).sort().forEach(function (n) {
				var f = a.folders[n] || {};
				out[n] = {
					count:    f.count | 0,
					lastSync: ms(f.lastSync),
					every:    refreshOf(a, n),
					// The row's own words, so a test asserts what the user reads
					// rather than a number the row might be dressing differently.
					says:     countPhrase(a, n),
				};
			});
			return out;
		},
		/// The gear dialog's body, for the container that will carry it and for a
		/// test that wants to read the tiles without opening a modal.
		settingsBody: settingsBody,
		openSettings: openSettings,
		/// Where a folder's messages sit in the workspace.
		folderDir:    function (address, name) { return mailboxDir(address || state.sel, name); },
		compose: function () {
			openCompose({ to: '', cc: '', subject: '', body: '', attachments: [] });
		},
		// Exposed for the tests, which have no business driving the DOM to find out whether
		// a message they built is the message that would go on the wire.
		build:   buildMessage,
	};
})();
