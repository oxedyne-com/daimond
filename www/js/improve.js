/* ============================================================
   Daimond — the Social panel (improve.js)
   ------------------------------------------------------------
   Where a note is written, and where the proposals made from
   notes are read and voted on. `dev/IMPROVE_CONTRACT.md` is the
   contract; `www/guide/social.html` is the public promise this
   panel has to keep, and every part of this screen is called what
   that page already calls it: a head, chips, a closer, rows,
   and the note box.

   THE PANEL IS SOCIAL AND THIS FILE IS TWO OF ITS FOUR CHIPS.
   Decision 13 renamed the `improve` dock panel to `social` and gave
   it Messages, People, Notes and Proposals. Notes and Proposals are
   this file's, whole. Messages and People are empty containers with
   an honest line in each, rendered into by other modules — so this
   file also owns the SHELL: the chips, the view switch, and the
   `window.DaimondSocial` those modules talk to. It is one file
   rather than two because the shell has no life of its own: the
   chips, the head and the i18n surface are the same head Notes and
   Proposals already hang on.

   The `/api/improve` ROUTE is unchanged. The panel was renamed, not
   the door the forge is behind.

   ── A NOTE IS A PROPOSAL NOW ────────────────────────────────

   This panel used to post a note to `/api/note` and read its
   proposals out of a file that shipped with the build. There has
   never been a `/api/note` handler in the gateway, so every note a
   tester pressed Send on was answered 404 and kept; and
   `assets/proposals.json` shipped permanently empty, so the
   proposals half drew nothing. Two carefully reasoned halves of one
   feature that had never met.

   Both now go through the one door the gateway actually has:

       GET  /api/improve?account=&repo=[&state=][&from=][&limit=]
       GET  /api/improve?account=&repo=&n=<number>
       POST /api/improve?account=&repo=                 open one
       POST /api/improve?account=&repo=&n=<number>      comment
       POST /api/improve?account=&repo=&n=&vote=1       vote

   which the gateway forwards over loopback to the Oregami forge.
   The compose box OPENS A PROPOSAL: the first line is its title and
   the rest is its body. Keep still keeps, and a note that could not
   be sent is still kept here and says so.

   ── THE ONE RULE THIS FILE EXISTS TO KEEP ───────────────────

   A NOTE LEAVES THIS DEVICE ONLY WHEN A PERSON PRESSES SEND ON
   THAT ONE NOTE, AND WHAT LEAVES IS EXACTLY THE CHARACTERS ON
   THE SCREEN AT THAT MOMENT.

   Nothing about a note is queued, retried, batched or synced.

   `telemetry.js` keeps the same promise from the other side and
   the contrast is worth stating, because the two files look like
   opposites and are not. That one makes leaking impossible by
   SHAPE: its payload can only ever be integers, so no edit to it
   can carry a sentence. Free text has no shape to hide behind, so
   this file makes leaking impossible by ACT: there is no sender
   until the press, `outgoing()` reads the screen and `split()` CUTS
   what it read into the two fields a proposal is -- a cut, never an
   addition, so putting the two back together with one newline gives
   the characters that were on the screen, and dev/verify_improve.mjs
   settles that by comparing two strings.

   The old form had no envelope at all, and said so: an envelope is
   somewhere a field can hide. A proposal has a title and a body, so
   an envelope there must be, and what replaces the argument is a
   check rather than a shape -- the request's FIELD SET is asserted
   to be exactly `title`, `body` and at most `build`, so a fifth
   field has to defeat a check rather than merely be forgotten.

   ── AND WHAT PRESSING SEND MEANS IS SAID BEFORE IT ──────────

   The forge refuses on a repository's `public` flag before it
   examines any credential, and renders public repositories only,
   so this panel can read nothing at all unless `oxedyne/daimond`
   is public. It is. A proposal there is therefore readable by
   ANYBODY, with NO credential, the voice name it was written
   under included. The rule above is unchanged by that -- a note
   still leaves only on a press -- but the press now means more
   than it did, so `drawPublic()` puts that in the box, above the
   button, where the person acts. It is on the screen exactly when
   Send is, and a person with no voice is told nothing of the kind,
   because they cannot send and it would not be true.

   And a note that cannot be sent STAYS HERE AND SAYS SO. There is
   no retry: a queue of text outlives the consent that filled it,
   which is the failure telemetry.js refuses by not remembering
   consent at all. Copy is offered instead.

   ── WHAT GOES WITH A NOTE GOES IN THE NOTE ──────────────────
   The guide asks a user to say which build, which panel was open,
   whether they were on a phone, which palette they were wearing.
   That is gathered for them and shown as one line, in the exact
   characters that will be appended, in a row with a CLOSER on it.
   Closing the row takes the line off the screen and off the wire --
   and off the `build` field with it, since that field carries the
   same characters the row's first item shows. There is no third
   state and nothing is gathered silently.

   ── VOTES ARE BUILT DARK ────────────────────────────────────
   Contract §9 puts voting on the forge, and the forge's vote route
   is not built yet. So the control is here and DRAWS ONLY WHEN THE
   ANSWER CARRIES `votes`. A visible control that reaches nothing is
   the defect this file was rewritten to remove; adding a second one
   while removing the first would be a poor trade. When the forge
   starts answering `votes`, the control appears on its own with no
   edit here.

   Attaches two globals, `window.DaimondSocial` (the panel
   shell) and `window.DaimondImprove` (notes and proposals).
   ============================================================ */
(function () {
	'use strict';

	// ── Saying things ──────────────────────────────────────────

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string with the English written at the call site as its fallback.
	///
	/// `t` answers with the KEY when the table has no entry, so a panel built
	/// against keys the locale files have not been given yet would read
	/// "social.send" on screen. Every string this panel adds is new, and they
	/// are routed to the catalogue separately from this file, so all of them go
	/// through here: the English shows until the tables catch up, and not one
	/// moment longer. trash.js keeps the same discipline for the same reason.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return v[name] != null ? String(v[name]) : whole;
		});
	}

	function tnOr(k, n, one, other, v) {
		var s = window.DaimondI18n ? DaimondI18n.tn(k, n, v) : k;
		if (s.indexOf(k) !== 0) return s;
		return String(n === 1 ? one : other).replace(/\{(\w+)\}/g, function (whole, name) {
			return v && v[name] != null ? String(v[name]) : whole;
		});
	}

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[improve]'].concat([].slice.call(arguments))); }
		catch (e) { /* no console */ }
	}

	function el(id) { return document.getElementById(id); }

	// ── The repository this panel reads ────────────────────────
	//
	// One account, one repository, one panel: the contract has no
	// cross-repository listing and this is not a setting. It names Daimond's own
	// forge repository, which is the same for every tester, so a knob for it
	// would be a knob whose only correct value is this one.

	var ACCOUNT = 'oxedyne';
	var REPO    = 'daimond';

	/// How many proposals one page carries. Well inside the contract's 1..200,
	/// and small enough that opening the panel on a large repository draws
	/// something immediately rather than after two hundred records.
	var PAGE = 25;

	// ── The store ──────────────────────────────────────────────
	//
	// One key, namespaced per account by accounts.js like every other
	// `daimond-*`. Notes are NOT in the sync parcel and are not coming: a note is
	// a report of a moment on the device it happened on, and making them travel
	// needs a merge rule this contract does not have.
	//
	// VOTES ARE NOT HERE ANY MORE. They used to be, with a queue that carried one
	// made offline. Contract §9 puts the tally on the forge, and a copy here
	// would be a second store of truth about one proposal -- which is exactly
	// what §9 rejected both alternatives for. What the forge says is what is
	// drawn.

	var KEY = 'daimond-improve';
	var MAX_NOTES = 200;			// past this the oldest KEPT note goes; sent ones stay
	var MAX_CHARS = 20000;			// what one note may be, matching the gateway's cap

	var _st = null;

	/// A millisecond stamp, or 0. Not `n | 0`: epoch-ms is past 32 bits.
	function ms(v) {
		return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0;
	}

	/// A whole number, or 0.
	function whole(v) {
		return (typeof v === 'number' && isFinite(v)) ? Math.floor(v) : 0;
	}

	/// One stored note, defended against whatever was in storage.
	function cleanNote(r) {
		if (!r || typeof r !== 'object') return null;
		var text = (typeof r.text === 'string') ? r.text : '';
		if (!text) return null;
		return {
			id:   String(r.id || '') || ('n' + ms(r.at)),
			at:   ms(r.at) || Date.now(),
			text: text.slice(0, MAX_CHARS),
			sent: ms(r.sent),
			/// The proposal this note became, or 0. Kept so a row can name it: a
			/// tester who sent something and was told only "Sent" has no way back
			/// to what happened to it.
			n:    Math.max(0, whole(r.n)),
		};
	}

	function load() {
		if (_st) return _st;
		_st = { notes: [] };
		try {
			var raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
			(Array.isArray(raw.notes) ? raw.notes : []).forEach(function (n) {
				var c = cleanNote(n);
				if (c) _st.notes.push(c);
			});
		} catch (e) { _st = { notes: [] }; }
		return _st;
	}

	function save() {
		var s = load();
		// Newest first on disk as well as on screen, so a person reading the raw
		// key finds what they just wrote at the top of it.
		s.notes.sort(function (a, b) { return b.at - a.at || (a.id < b.id ? 1 : -1); });
		// A cap, so a panel nobody empties cannot fill the quota.
		//
		// THE OLDEST SENT NOTES GO FIRST. A sent note has a copy at the other end;
		// a kept one is the ONLY copy of what somebody wrote, and dropping it to
		// make room for a note that has already been delivered is losing the one
		// that mattered. Kept notes are dropped only if there is nothing else
		// left to drop, and then oldest first like anything else.
		if (s.notes.length > MAX_NOTES) {
			var over = s.notes.length - MAX_NOTES;
			for (var i = s.notes.length - 1; i >= 0 && over > 0; i--) {
				if (s.notes[i].sent) { s.notes.splice(i, 1); over--; }
			}
			if (over > 0) s.notes.length = MAX_NOTES;
		}
		try { localStorage.setItem(KEY, JSON.stringify({ v: 2, notes: s.notes })); }
		catch (e) { log('could not write the notes', e); }
	}

	// ── What goes with a note ──────────────────────────────────
	//
	// The guide's fourth piece of advice, gathered rather than asked for. Every
	// item here is one the guide names by name, and each is a fact about the
	// APP, never about the person: no user agent string, no screen fingerprint,
	// no id of any kind.

	var _build = '';

	/// Read the build id once, from the same `build.json` the updater reads.
	/// A failure leaves it empty, and the line simply does not name a build --
	/// which is honest, where a guessed one would not be.
	function readBuild() {
		try {
			return fetch('build.json', { cache: 'no-store' })
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(function (j) { _build = (j && typeof j.build === 'string') ? j.build : ''; })
				.catch(function () { /* no build id; the line says less */ });
		} catch (e) { return Promise.resolve(); }
	}

	/// Which panels are open, by the label the user reads on their chips -- not
	/// by their ids, which mean nothing to the person writing the note and
	/// nothing to a reader who has only ever seen the screen.
	function openPanels() {
		try {
			if (!window.DaimondPanels || !DaimondPanels.panels) return [];
			return DaimondPanels.panels()
				.filter(function (p) { return DaimondPanels.isOpen(p.id); })
				.map(function (p) { return p.label; });
		} catch (e) { return []; }
	}

	/// The one line that is appended to a note, in the characters that will
	/// travel. Built here and shown verbatim; nothing is added on the way out.
	function context() {
		var bits = [];
		if (_build) bits.push(tOr('social.ctx_build', 'Build {id}', { id: _build }));
		try {
			var loc = window.DaimondI18n ? DaimondI18n.locale() : '';
			if (loc) bits.push(loc);
		} catch (e) { /* no i18n */ }
		try { bits.push(window.innerWidth + '×' + window.innerHeight); } catch (e) { /* no window */ }
		try {
			var coarse = window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches;
			bits.push(coarse
				? tOr('social.ctx_touch', 'touch')
				: tOr('social.ctx_pointer', 'pointer'));
		} catch (e) { /* no matchMedia */ }
		try {
			var theme = localStorage.getItem('daimond-theme');
			var skin  = localStorage.getItem('daimond-skin');
			if (theme) bits.push(tOr('social.ctx_palette', 'palette {name}', { name: theme + (skin ? ' ' + skin : '') }));
		} catch (e) { /* private mode */ }
		var panels = openPanels();
		if (panels.length) bits.push(tOr('social.ctx_panels', 'panels open: {list}', { list: panels.join(', ') }));
		return bits.join(' · ');
	}

	// ── The note box ───────────────────────────────────────────

	/// Whether the "What goes with it" row has been closed for this note.
	function contextOff() {
		var row = el('improve-with');
		return !!(row && row.dataset.off === '1');
	}

	/// The exact characters a Send would put on the wire, right now.
	///
	/// THE ONE FUNCTION THAT DECIDES WHAT LEAVES. The box's value and, when the
	/// row is still on screen, the text that row is showing -- read off the node,
	/// not rebuilt, so a line the user cannot see cannot be in it. `send()` calls
	/// this, `split()` cuts the result in two, and nothing else contributes.
	function outgoing() {
		var box = el('improve-box');
		var body = box ? String(box.value || '').trim() : '';
		if (!body) return '';
		if (contextOff()) return body;
		var line = el('improve-with-text');
		var ctx  = line ? String(line.textContent || '').trim() : '';
		return ctx ? (body + '\n\n' + ctx) : body;
	}

	/// The note, cut into the fields a proposal is made of, or null when there is
	/// no title to make one with.
	///
	/// A CUT AND NEVER AN ADDITION. `title` is the characters before the first
	/// newline and `body` is the characters after it, both verbatim, so
	/// `title + '\n' + body` is exactly what `outgoing()` read off the screen --
	/// which is the property the verifier settles by comparing two strings. A
	/// note with no newline in it is all title and an empty body.
	///
	/// `build` is the sealed build identifier contract §6 asks a panel to write,
	/// and it travels ONLY while the "What goes with it" row is on screen: those
	/// are the same characters that row's first item shows, so closing the row
	/// takes them off the wire here as well as out of the body.
	function split(text) {
		var i     = text.indexOf('\n');
		var title = (i < 0) ? text : text.slice(0, i);
		var body  = (i < 0) ? ''   : text.slice(i + 1);
		if (!title.trim()) return null;
		return { title: title, body: body, build: contextOff() ? '' : _build };
	}

	/// Redraw the row that says what goes with the note. Left closed if the user
	/// closed it: a row that reappeared on every keystroke would be a control
	/// that does not stay pressed.
	function drawContext() {
		var row = el('improve-with'), line = el('improve-with-text');
		if (!row || !line) return;
		if (row.dataset.off === '1') { row.hidden = true; return; }
		var ctx = context();
		line.textContent = ctx;
		row.hidden = !ctx;
	}

	// ── The voice a proposal is written with ───────────────────
	//
	// `voice.js` holds it, encrypted under the user's passphrase, and this panel
	// is the only surface that has ever needed one. Without a place to SET it the
	// whole write half would be unreachable, which is the defect this file was
	// rewritten to remove -- so the place is here, beside the button that needs
	// it, rather than in a settings screen a tester would have to be told about.
	//
	// The secret never leaves this function's arguments: it is read off the input,
	// handed to `DaimondVoice.set`, and the input is emptied. Nothing here logs
	// it, draws it, or puts it anywhere a later reader could find it.

	function voice() { return window.DaimondVoice || null; }

	/// Is a voice held on this device? Presence only -- reading it needs the
	/// passphrase, and that question is asked at the moment of a request.
	function hasVoice() {
		var v = voice();
		try { return !!(v && v.has()); } catch (e) { return false; }
	}

	var _voiceOpen = false;			// whether the "set a voice" form is showing

	/// The row under the buttons: whether a voice is held, and how to change it.
	/// Built here rather than in the markup because the markup is another lane's
	/// file and every part of it is drawn from this one anyway.
	function drawVoice() {
		var write = document.querySelector('#panel-social .imp-write');
		var say   = el('improve-say');
		if (!write) return;
		var host = el('improve-voice');
		if (!host) {
			host = document.createElement('div');
			// `.imp-acts` as well as `.imp-voice`: the first is an existing rule
			// that lays a row of buttons out with a sentence above them, which is
			// exactly this row's shape. Reusing it means this panel needs no new
			// stylesheet rule to be legible, the same trick `#improve-hint` plays
			// with `.imp-as`. Without it the sentence and the buttons run together
			// on one line, which is what the first draft did.
			host.className = 'imp-acts imp-voice';
			host.id = 'improve-voice';
			if (say) write.insertBefore(host, say);
			else write.appendChild(host);
		}
		host.innerHTML = '';
		if (!voice()) return;			// no voice.js in this build

		var line = document.createElement('span');
		line.className = 'imp-as';
		line.id = 'improve-voice-say';
		line.textContent = hasVoice()
			? tOr('social.voice_held', 'A voice is held on this device, encrypted under your passphrase.')
			: tOr('social.voice_none', 'No voice is held here, so a note can only be kept.');
		host.appendChild(line);

		if (!_voiceOpen) {
			host.appendChild(button('imp-note-copy', 'improve-voice-open',
				hasVoice() ? tOr('social.voice_replace', 'Replace the voice')
					: tOr('social.voice_set', 'Set a voice'),
				tOr('social.voice_help', 'The line the forge printed for you. It is kept encrypted here and never put in an address.')));
			if (hasVoice()) {
				host.appendChild(button('imp-note-copy', 'improve-voice-forget',
					tOr('social.voice_forget', 'Forget it'),
					tOr('social.voice_forget_help', 'Remove the copy on this device.')));
			}
			return;
		}

		var input = document.createElement('input');
		input.type = 'password';
		input.className = 'imp-box';
		input.id = 'improve-voice-in';
		input.autocomplete = 'off';
		input.spellcheck = false;
		input.placeholder = tOr('social.voice_ph', 'Paste the line the forge printed for you');
		input.setAttribute('aria-label', tOr('social.voice_ph', 'Paste the line the forge printed for you'));
		host.appendChild(input);
		host.appendChild(button('imp-send', 'improve-voice-save', tOr('social.voice_save', 'Save the voice')));
		host.appendChild(button('imp-keep', 'improve-voice-cancel', t('common.cancel')));
	}

	/// Take the secret off the input and hand it to voice.js, which wraps it.
	/// The input is emptied whatever happened: a secret left in a field is a
	/// secret in a screenshot.
	async function saveVoice() {
		var input = el('improve-voice-in');
		if (!input) return false;
		var raw = String(input.value || '');
		input.value = '';
		var v = voice();
		if (!v) return false;
		var why = '';
		try { why = v.check(raw); } catch (e) { why = ''; }
		if (why) { flash(why); return false; }
		try { await v.set(raw); }
		catch (e) { flash(e && e.message ? String(e.message) : tOr('social.voice_failed', 'That voice could not be stored.')); return false; }
		_voiceOpen = false;
		flash(tOr('social.voice_saved', 'Your voice is held here, encrypted.'));
		render();
		return true;
	}

	/// Forget the voice on this device. It asks, because the forge cannot give it
	/// back: a voice is minted once and shown once.
	async function forgetVoice() {
		var v = voice();
		if (!v) return false;
		var ok = true;
		try {
			if (window.DaimondCore && DaimondCore.confirm) {
				ok = await DaimondCore.confirm(
					tOr('social.voice_ask_forget',
						'Forget your voice on this device? The forge showed it once and cannot show it again.'),
					tOr('social.voice_forget', 'Forget it'),
					{ title: tOr('social.voice_forget', 'Forget it') });
			}
		} catch (e) { ok = true; }
		if (!ok) return false;
		try { v.clear(); } catch (e) { /* nothing was stored */ }
		flash(tOr('social.voice_forgotten', 'The copy on this device is gone.'));
		render();
		return true;
	}

	/// The Send button, asked for the way the markup really carries it.
	///
	/// `#improve-acts .imp-send` AND NOT `#improve-send`, which does not exist: the
	/// markup gives that button a class and no id. This file asked for it by id,
	/// got null, and the guard that hides it silently did nothing -- so Send was
	/// offered on every build to every user with nothing to send as, from the day
	/// the panel was written. A verifier that asked for the same missing id would
	/// have agreed with it: an absent locator reports itself hidden.
	///
	/// One function, because two things now hang off this element -- whether Send
	/// is offered, and whether the sentence saying what Send does is on the screen.
	/// Two copies of a locator are two things to get separately wrong.
	function sendBtn() {
		return document.querySelector('#panel-social #improve-acts .imp-send');
	}

	/// Where the forge this panel writes to is read, in public.
	///
	/// The panel talks to `/api/improve` and the gateway forwards from there, so
	/// the browser is never told this address and cannot ask for it: it is a
	/// deployment fact, written here once. If the gateway is ever pointed at a
	/// different forge, THIS LINE IS A LIE UNTIL IT IS CHANGED, which is the price
	/// of naming a host at all -- and naming it is the point, because "published
	/// online" is a claim nobody can go and check.
	var FORGE_HOST = 'oregami.oxegen.io';

	/// The line beside Send, saying what a note goes as.
	///
	/// A user must never find out AFTERWARDS that something about them went too,
	/// so this is beside the button and not in a help text. It no longer names a
	/// handle: what the forge attributes a proposal to is the VOICE, and the
	/// browser never learns that voice's name -- there is no name on the wire.
	///
	/// WITH a voice, this line says nothing: `drawPublic()` says all of it and
	/// more, above the button rather than under it. The two sentences said the
	/// same thing in different words, and four grey sentences stacked under one
	/// box is how a panel starts reading as a warning against using it.
	function drawAs() {
		var as = el('improve-as');
		var send = sendBtn();
		if (as) {
			as.hidden = hasVoice();
			as.textContent = hasVoice() ? ''
				: tOr('social.as_novoice', 'You have no voice, so a note can only be kept here.');
		}
		// Without a voice there is nothing to send AS, and the forge would refuse
		// it. The button is hidden rather than shown-and-inert: a control that
		// does nothing when pressed teaches people to distrust every control.
		if (send) send.hidden = !hasVoice();
		drawPublic(send);
		drawHint();
	}

	/// What pressing Send does to a note, said ABOVE Send.
	///
	/// The forge refuses on a repository's `public` flag before it looks at any
	/// credential and draws only public repositories, so this panel can only read
	/// anything at all while `oxedyne/daimond` is public -- and a proposal on a
	/// public repository is readable by ANYBODY, with NO credential of any kind,
	/// the voice name it was written under included. That is now part of what
	/// pressing Send means, so it belongs where the press happens: in the box,
	/// above the button, in front of the hand on its way there. Not a help page,
	/// not an info mark, and not a dialogue -- a dialogue is dismissed once and
	/// then never seen by the person who most needed it.
	///
	/// It is drawn here rather than written into the markup for the reason
	/// `drawHint()` and `drawVoice()` are: `www/index.html` is another lane's file
	/// and every other word in this box is already drawn from this one.
	///
	/// IT IS ON THE SCREEN EXACTLY WHEN SEND IS. A tester with no voice cannot
	/// send, so telling them their notes will be published would be simply false;
	/// and it is keyed off the BUTTON rather than off `hasVoice()` read a second
	/// time, so the sentence cannot drift away from the control it describes.
	function drawPublic(send) {
		var write = document.querySelector('#panel-social .imp-write');
		var acts  = el('improve-acts');
		if (!write || !acts) return;
		var line = el('improve-public');
		if (!line) {
			line = document.createElement('p');
			line.className = 'imp-public';
			line.id = 'improve-public';
			write.insertBefore(line, acts);		// above the buttons, under the box
		}
		// The host rides as a placeholder so that eight translations carry the
		// address without any of them retyping it.
		line.textContent = tOr('social.public_note',
			'Sending publishes this note at {host}, with your voice name on it. '
			+ 'Anyone can read it there without an account. '
			+ 'A note you keep stays on this device.',
			{ host: FORGE_HOST });
		line.hidden = !(send && !send.hidden);
	}

	/// The one sentence a person needs before they press Send: the first line is
	/// the title. Drawn beside the buttons rather than in the placeholder, which
	/// vanishes the moment anybody types.
	function drawHint() {
		var acts = el('improve-acts');
		if (!acts) return;
		var hint = el('improve-hint');
		if (!hint) {
			hint = document.createElement('span');
			hint.className = 'imp-as';
			hint.id = 'improve-hint';
			acts.appendChild(hint);
		}
		hint.textContent = tOr('social.title_hint',
			'The first line is the title of the proposal. What happened goes underneath it.');
	}

	// ── Keeping and sending ────────────────────────────────────

	/// Store what is in the box, and clear it. `sentAt` is 0 for a note that has
	/// not left and must not pretend it has.
	function store(text, sentAt) {
		var s = load();
		var rec = {
			id:   'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
			at:   Date.now(),
			text: String(text).slice(0, MAX_CHARS),
			sent: ms(sentAt),
			n:    0,
		};
		s.notes.unshift(rec);
		save();
		return rec;
	}

	function clearBox() {
		var box = el('improve-box');
		if (box) box.value = '';
		var row = el('improve-with');
		if (row) delete row.dataset.off;		// the next note starts with its details on
		drawContext();
	}

	/// Keep this note here. Nothing is sent, now or ever: a kept note reaches
	/// the network only if somebody presses Send on it afterwards.
	function keep() {
		var text = outgoing();
		if (!text) { flash(tOr('social.nothing', 'Write something first.')); return null; }
		var rec = store(text, 0);
		clearBox();
		render();
		return rec;
	}

	/// Open a proposal from one note's characters.
	///
	/// THE WHOLE OF WHAT LEAVES is these three fields, and all three came out of
	/// `split()`, which cut what `outgoing()` read off the screen. The field set
	/// is asserted by dev/verify_improve.mjs, so a fourth field has to defeat a
	/// check rather than merely be forgotten.
	///
	/// A failure is not retried and nothing is queued. The note is kept, the row
	/// says so, and Copy is there for a person who wants to carry it themselves.
	async function post(parts) {
		var f = new URLSearchParams();
		f.set('title', parts.title);
		f.set('body',  parts.body);
		if (parts.build) f.set('build', parts.build);
		return await ask(route(''), {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    f.toString(),
		});
	}

	/// What a refusal leaves on the screen after a Send: why it did not go, and
	/// that the note is still here.
	function keptAfter(a) {
		return saying(a) + ' ' + tOr('social.kept_here',
			'Your note is kept here and nothing tried again.');
	}

	async function send() {
		var text = outgoing();
		if (!text) { flash(tOr('social.nothing', 'Write something first.')); return null; }
		var parts = split(text);
		if (!parts) {
			flash(tOr('social.no_title', 'The first line is the title. Write one, then what happened underneath.'));
			return null;
		}
		if (!hasVoice()) { flash(tOr('social.as_novoice', 'You have no voice, so a note can only be kept here.')); return null; }
		var rec = store(text, 0);
		clearBox();
		render();
		var a = await post(parts);
		if (a.ok) {
			rec.sent = Date.now();
			rec.n    = Math.max(0, whole(a.data && a.data.number));
			save();
			absorb(cleanProp(a.data), true);
		} else flash(keptAfter(a));
		render();
		return rec;
	}

	/// Send a note that is already kept. The same one act, from the row instead
	/// of from the box, and it opens a proposal from the note's stored
	/// characters unchanged.
	async function resend(id) {
		var s = load();
		var rec = s.notes.find(function (n) { return n.id === id; });
		if (!rec || rec.sent) return false;
		var parts = split(rec.text);
		if (!parts) { flash(tOr('social.no_title', 'The first line is the title. Write one, then what happened underneath.')); return false; }
		if (!hasVoice()) { flash(tOr('social.as_novoice', 'You have no voice, so a note can only be kept here.')); return false; }
		var a = await post(parts);
		if (a.ok) {
			rec.sent = Date.now();
			rec.n    = Math.max(0, whole(a.data && a.data.number));
			save();
			absorb(cleanProp(a.data), true);
		} else flash(keptAfter(a));
		render();
		return a.ok;
	}

	/// Delete one note. It is only on this device, so this is the whole of it --
	/// which is why it asks, and why the question says so.
	async function drop(id) {
		var s = load();
		var i = s.notes.findIndex(function (n) { return n.id === id; });
		if (i === -1) return false;
		var ok = true;
		try {
			if (window.DaimondCore && DaimondCore.confirm) {
				ok = await DaimondCore.confirm(
					tOr('social.drop_ask', 'Delete this note? It is only on this device, so there is no other copy.'),
					tOr('social.drop_ok', 'Delete'),
					{ title: tOr('social.drop', 'Delete this note') });
			}
		} catch (e) { ok = true; }
		if (!ok) return false;
		s.notes.splice(i, 1);
		save();
		render();
		return true;
	}

	/// Put a note on the clipboard, so somebody with no voice, or no gateway,
	/// can still carry their own report out by hand.
	async function copy(id) {
		var s = load();
		var rec = s.notes.find(function (n) { return n.id === id; });
		if (!rec) return false;
		try { await navigator.clipboard.writeText(rec.text); }
		catch (e) { flash(t('copy.failed')); return false; }
		flash(tOr('social.copied', 'Copied.'));
		return true;
	}

	/// One line under the box, for the answers that are not worth a dialog.
	function flash(text) {
		var n = el('improve-say');
		if (!n) return;
		n.textContent = text;
		clearTimeout(flash._t);
		flash._t = setTimeout(function () { if (n.textContent === text) n.textContent = ''; }, 8000);
	}

	// ── The wire ───────────────────────────────────────────────
	//
	// One door: `/api/improve`, which the gateway forwards over loopback to the
	// forge. The account and the repository ride in the QUERY on both methods, so
	// the body stays whatever the forge reads and the proxy in between never has
	// to parse it.
	//
	// Every request goes through `DaimondVoice.send`, which spreads the voice
	// header and goes on through `DaimondGateway.gwFetch` -- the one copy of the
	// session rule. A read of a public repository carries no voice at all, which
	// `header()` answers `{}` for by design, so this same door serves both.

	/// The route, with the repository this panel reads. Built here and nowhere
	/// else, and the voice is never in it: a query string is written into every
	/// access log it passes.
	function route(extra) {
		var q = 'account=' + encodeURIComponent(ACCOUNT) + '&repo=' + encodeURIComponent(REPO);
		return '/api/improve?' + q + (extra ? '&' + extra : '');
	}

	/// The nine refusals the forge speaks, per contract §3.1. A client branches
	/// on `error` and NEVER on `said`, which is a sentence a person reads and may
	/// be reworded at any time.
	var TOKENS = {
		absent: 1, unvoiced: 1, unknown: 1, unpermitted: 1, throttled: 1,
		malformed: 1, no_proposal: 1, unsupported: 1, internal: 1,
	};

	/// The three reasons a `throttled` carries. Anything else is read as none.
	var BECAUSE = { address: 1, voice: 1, failing: 1 };

	/// One exchange with the forge, as this panel reads it.
	///
	/// `{ ok: true, data }`, or `{ ok: false, why, because, status }` where `why`
	/// is one of the nine tokens, `gateway` for a refusal this side generated, or
	/// `offline` for a request that never got an answer at all. Three sources of
	/// refusal and one shape, because every caller has to handle all three.
	async function ask(path, opts) {
		var v = voice();
		var r;
		try {
			r = v ? await v.send(path, opts || {}) : await fetch(path, opts || {});
		} catch (e) {
			// `header()` throws a SENTENCE a person can act on -- a locked
			// identity, a voice that cannot be read under this passphrase -- and
			// those are worth showing. A network failure throws a `TypeError`
			// whose message is the browser's own English ("Failed to fetch"),
			// which must never reach a screen this app has translated eight ways.
			var mine = (e && e.name !== 'TypeError' && e.message) ? String(e.message) : '';
			return { ok: false, why: 'offline', said: mine };
		}
		var text = '';
		try { text = await r.text(); } catch (e) { text = ''; }
		var data = null;
		try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
		// The forge's refusal. Told from a record by the token, and from the
		// gateway's own refusal by the token being one of the nine: the gateway
		// answers `{ok:false, error:"<a sentence>"}`, which is not a token.
		if (data && typeof data === 'object' && typeof data.error === 'string' && TOKENS[data.error]) {
			return {
				ok:      false,
				why:     data.error,
				because: (typeof data.because === 'string' && BECAUSE[data.because]) ? data.because : '',
				status:  r.status,
			};
		}
		if (r.ok && data && typeof data === 'object') return { ok: true, data: data };
		return { ok: false, why: 'gateway', status: r.status };
	}

	/// What a refusal says on the screen.
	///
	/// EVERY ONE OF THE NINE IS SAID. A refusal a panel swallows is a panel that
	/// looks broken for a reason nobody can find, and this file shipped for weeks
	/// telling every tester the same sentence about a 404 that was really a route
	/// that did not exist.
	///
	/// `absent` covers BOTH "no such repository" and "this repository is
	/// private", deliberately and permanently: any wording, status or timing that
	/// separated the two would republish exactly what a private repository is
	/// withholding. So the sentence has to be TRUE IN BOTH CASES. "There is no
	/// such repository" is false when it is private; "This repository is private"
	/// leaks.
	///
	/// None of these names which allowance ran out, either. A limit that reports
	/// its own state is one somebody can pace against, and a vote and a proposal
	/// draw on different budgets -- so a sentence about "submissions" shown to
	/// somebody who tapped a vote button twice is wrong as well as leaky.
	function saying(a) {
		if (!a) return tOr('social.err_offline', 'Nothing could be sent just now.');
		switch (a.why) {
		case 'absent':
			return tOr('social.err_absent', 'This repository is not available to you.');
		case 'unvoiced':
			return tOr('social.err_unvoiced', 'The forge was given no voice, so it refused.');
		case 'unknown':
			return tOr('social.err_unknown', 'The forge does not recognise your voice. Set it again from the line the forge printed for you.');
		case 'unpermitted':
			return tOr('social.err_unpermitted', 'Your voice may not do that here.');
		case 'throttled':
			if (a.because === 'address') {
				return tOr('social.err_throttled_address', 'Too many requests from this address just now. Wait a little, then try again.');
			}
			if (a.because === 'failing') {
				return tOr('social.err_throttled_failing', 'Too many failing requests just now. Wait a little, then try again.');
			}
			return tOr('social.err_throttled', 'Too many requests just now. Wait a little, then try again.');
		case 'malformed':
			return tOr('social.err_malformed', 'The forge could not read what Daimond asked it. That is a fault in Daimond, not in what you wrote.');
		case 'no_proposal':
			return tOr('social.err_no_proposal', 'There is no such proposal here.');
		case 'unsupported':
			return tOr('social.err_unsupported', 'The forge does not answer that.');
		case 'internal':
			return tOr('social.err_internal', 'Something went wrong at the forge. This is not your fault.');
		case 'gateway':
			if (a.status === 401) {
				return tOr('social.err_session', 'Daimond is not signed in just now, so it could not reach the forge.');
			}
			if (a.status === 413) {
				return tOr('social.err_toolong', 'That is longer than the forge accepts. Shorten it, or send it in two.');
			}
			return tOr('social.err_gateway', 'Daimond could not reach the forge just now.');
		default:
			return a.said || tOr('social.err_offline', 'Nothing could be sent just now.');
		}
	}

	// ── Proposals ──────────────────────────────────────────────
	//
	// Read from the forge as the panel is opened, NEWEST FIRST. `from` is a
	// numeric CEILING that counts DOWN and not an offset -- an offset slides as
	// proposals arrive, so a client paging through a growing list silently skips
	// or repeats records.
	//
	// THE WALK'S TERMINATION IS THE SUBTLE PART, and it is why `from=0` is never
	// sent from here. There is NO value of `from` that says "nothing below this":
	// zero is not a proposal number, so a forge either refuses it or reads it as
	// "no ceiling", which is BACK TO THE NEWEST. A client that pages by asking
	// for `lowest - 1` therefore wraps to the start and loops for ever the moment
	// it reaches proposal 1, with every answer along the way looking perfectly
	// valid and nothing anywhere reporting a fault. So the walk ends on a page
	// SHORTER than the limit it asked for, on proposal 1, or on a page that did
	// not descend -- and the last of those three holds even if the other two are
	// wrong, which is why it is there.

	var _by    = {};			// proposal number -> the record, listing or detail
	var _order = [];			// the numbers, in the order they are drawn
	var _open  = {};			// which rows are open, so a redraw does not shut them
	var _list  = {
		total:   0,
		lowest:  null,			// the lowest number drawn so far, the ceiling counts down from
		done:    false,			// the walk has ended and there is nothing below
		loading: false,
		err:     null,			// the last refusal, drawn under the list until it is gone
		read:    false,			// whether the listing has ever been read
	};

	/// The four states a proposal takes on the forge. The vocabulary is closed:
	/// anything else is drawn as open rather than as a state nobody has a word
	/// for.
	var STATES = { open: 1, accepted: 1, declined: 1, done: 1 };

	/// One proposal as it arrived, defended against a shape this build does not
	/// know.
	///
	/// `mine` is the delicate one. Contract §9: it is `1`, `-1` or `null` when a
	/// voice was sent and ABSENT ENTIRELY when none was, so that "I have not
	/// voted" and "I was not asked" cannot be confused. `asked` carries that
	/// distinction here, because `undefined` and `null` are the same thing to
	/// anything that round-trips this record through JSON.
	function cleanProp(p) {
		if (!p || typeof p !== 'object') return null;
		var n = whole(p.number);
		if (n < 1) return null;
		var rec = {
			n:          n,
			title:      (typeof p.title === 'string') ? p.title : '',
			state:      STATES[p.state] ? p.state : 'open',
			author:     (typeof p.author === 'string') ? p.author : '',
			comments:   Math.max(0, whole(p.comments)),
			opened:     Math.max(0, whole(p.opened)),
			changed:    Math.max(0, whole(p.changed)),
			mark:       (typeof p.mark === 'string') ? p.mark : '',
			build:      (typeof p.build === 'string') ? p.build : '',
			body:       (typeof p.body === 'string') ? p.body : '',
			discussion: null,
			detail:     false,
			votes:      null,		// null: this forge does not answer votes yet
			asked:      false,		// whether the answer carried `mine` at all
			mine:       null,
		};
		if (Array.isArray(p.discussion)) {
			rec.detail = true;
			rec.discussion = p.discussion.map(function (d) {
				return {
					author: (d && typeof d.author === 'string') ? d.author : '',
					// `said` on a discussion entry is what a person wrote, which is
					// not the `said` of a refusal. One word, two contracts.
					said:   (d && typeof d.said === 'string') ? d.said : '',
					when:   Math.max(0, whole(d && d.when)),
				};
			});
		}
		if (typeof p.body === 'string') rec.detail = true;
		if (p.votes && typeof p.votes === 'object' && !Array.isArray(p.votes)) {
			rec.votes = {
				for:     Math.max(0, whole(p.votes.for)),
				against: Math.max(0, whole(p.votes.against)),
			};
		}
		if (Object.prototype.hasOwnProperty.call(p, 'mine')) {
			rec.asked = true;
			rec.mine  = (p.mine === 1 || p.mine === -1) ? p.mine : null;
		}
		return rec;
	}

	/// Take one record in, keeping what a listing does not carry.
	///
	/// A listing record has no body and no discussion, so absorbing one over a
	/// detail that has already been read must not wipe them -- otherwise opening
	/// a proposal and then paging would empty it.
	function absorb(rec) {
		if (!rec) return null;
		var cur = _by[rec.n];
		if (cur && !rec.detail) {
			rec.body       = cur.body;
			rec.discussion = cur.discussion;
			rec.detail     = cur.detail;
		}
		if (!cur) _order.push(rec.n);
		_by[rec.n] = rec;
		return rec;
	}

	/// Read a page of the listing. `more` walks downwards from what is drawn.
	async function loadList(more) {
		if (_list.loading) return false;
		if (more && _list.done) return false;
		var extra = 'limit=' + PAGE;
		if (more) {
			// Never `from=0`. See the note above: there is no value of `from` that
			// says "nothing below this", and zero means back to the newest.
			if (!(_list.lowest > 1)) { _list.done = true; drawProps(); return false; }
			extra += '&from=' + (_list.lowest - 1);
		}
		_list.loading = true;
		_list.err     = null;
		drawProps();
		var a = await ask(route(extra), { method: 'GET' });
		_list.loading = false;
		if (!a.ok) { _list.err = a; drawProps(); return false; }

		if (!more) { _by = {}; _order = []; _list.lowest = null; _list.done = false; }
		var raw = Array.isArray(a.data.proposals) ? a.data.proposals : [];
		var got = 0, lowest = null;
		raw.forEach(function (p) {
			var rec = cleanProp(p);
			if (!rec) return;
			got++;
			if (lowest === null || rec.n < lowest) lowest = rec.n;
			absorb(rec);
		});
		// `total` is the count AFTER `state` and BEFORE `from` and `limit`, so it
		// is how "no more" is told from "more to come".
		_list.total = Math.max(0, whole(a.data.total));
		_list.read  = true;

		// A short page is the end of the walk.
		if (got < PAGE) _list.done = true;
		// So is proposal 1: there is nothing below it to ask for.
		if (lowest === null || lowest <= 1) _list.done = true;
		// AND SO IS A PAGE THAT DID NOT DESCEND. This is the belt: a forge that
		// read `from` as a lower bound, or aliased a value of it back to the
		// newest, would hand the same page again for ever and every answer would
		// look valid. Stopping the moment the walk stops descending turns that
		// into a list that ends rather than a tab that never settles.
		if (more && lowest !== null && _list.lowest !== null && lowest >= _list.lowest) {
			_list.done = true;
		}
		if (lowest !== null && (_list.lowest === null || lowest < _list.lowest)) _list.lowest = lowest;
		drawProps();
		return true;
	}

	/// Read one proposal in full, for its body and its discussion.
	async function loadOne(n) {
		var a = await ask(route('n=' + n), { method: 'GET' });
		if (!a.ok) { _list.err = a; drawProps(); return false; }
		absorb(cleanProp(a.data));
		drawProps();
		return true;
	}

	// ── Voting ─────────────────────────────────────────────────
	//
	// Contract §9: one store of truth, and it is the forge. Nothing is queued
	// here and nothing is kept here, because a tally in two places is a tally
	// that disagrees with itself. Every write answers with the DETAIL SHAPE of
	// the record it changed, so a vote's answer carries the new tally and the
	// caller's own `mine` and the control is redrawn from it -- never from a
	// second request, and never from a guess about what the press must have done.

	/// A vote's whole body: one field, one of three values, and nothing else.
	///
	/// Form-encoded, like every other write on this surface. Written as a
	/// function that returns the exact characters rather than assembled at the
	/// call site, so an edit that wants to send a fifth thing has to defeat this
	/// rather than merely forget it -- the same discipline the old integers-only
	/// gate kept, in the shape the contract now asks for.
	///
	/// A vote with no `d` at all is `malformed` at the forge and NOT a
	/// withdrawal, which is right: reading a lost field as an instruction to
	/// delete turns a dropped parameter into silent data loss. So there is no
	/// path here that sends one.
	function voteBody(d) {
		if (d !== 1 && d !== -1 && d !== 0) return '';
		return 'd=' + d;
	}

	/// Cast, move, or take back a vote.
	///
	/// Pressing the side you already chose withdraws it, which is the only way
	/// back and is what a pressed control that stays pressed has to offer.
	async function vote(n, dir) {
		var rec = _by[n];
		if (!rec || !rec.votes || !rec.asked) return false;
		var want = (dir === 'do') ? 1 : -1;
		var body = voteBody(rec.mine === want ? 0 : want);
		if (!body) return false;
		var a = await ask(route('n=' + n + '&vote=1'), {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    body,
		});
		if (!a.ok) { _list.err = a; drawProps(); return false; }
		absorb(cleanProp(a.data));
		_list.err = null;
		drawProps();
		return true;
	}

	// ── Saying something on a proposal ─────────────────────────

	/// Add one comment to a proposal.
	///
	/// The same one rule as a note: what leaves is exactly the characters in that
	/// one box, at the moment the button beside it is pressed, and a failure is
	/// said rather than queued. The box is emptied only when the forge took it,
	/// so a refusal leaves the words where the person can still read and copy
	/// them.
	async function comment(n) {
		var box = document.querySelector('.imp-prop[data-prop="' + n + '"] .imp-reply');
		if (!box) return false;
		var text = String(box.value || '').trim();
		if (!text) { _list.err = null; flash(tOr('social.nothing', 'Write something first.')); return false; }
		if (!hasVoice()) { _list.err = { why: 'unvoiced' }; drawProps(); return false; }
		var f = new URLSearchParams();
		f.set('said', text);
		var a = await ask(route('n=' + n), {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    f.toString(),
		});
		if (!a.ok) { _list.err = a; drawProps(); return false; }
		box.value = '';
		absorb(cleanProp(a.data));
		_list.err = null;
		drawProps();
		return true;
	}

	// ── Drawing ────────────────────────────────────────────────

	/// The day something happened, in the language the APP is in — not the
	/// browser's. trash.js records why.
	function fmtDate(at) {
		var loc;
		try { loc = window.DaimondI18n ? DaimondI18n.locale() : undefined; }
		catch (e) { loc = undefined; }
		try { return new Date(at).toLocaleDateString(loc || undefined, { day: 'numeric', month: 'short' }); }
		catch (e) { return ''; }
	}

	/// A forge stamp is in seconds; everything else here is in milliseconds.
	function fmtWhen(secs) { return secs ? fmtDate(secs * 1000) : ''; }

	function button(cls, act, text, title) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = cls;
		if (act) b.dataset.act = act;
		b.textContent = text;
		if (title) b.title = title;
		return b;
	}

	/// Your own notes, newest first: what you wrote, when, and whether it went.
	function drawNotes() {
		var list = el('improve-list');
		if (!list) return;
		var notes = load().notes.slice();
		list.innerHTML = '';
		if (!notes.length) {
			var none = document.createElement('div');
			none.className = 'rail-note';
			none.textContent = tOr('social.no_notes', 'No notes yet.');
			list.appendChild(none);
			return;
		}
		notes.forEach(function (n) {
			var row = document.createElement('div');
			row.className = 'imp-note';
			row.dataset.note = n.id;

			var text = document.createElement('div');
			text.className = 'imp-note-text';
			text.textContent = n.text;
			row.appendChild(text);

			var foot = document.createElement('div');
			foot.className = 'imp-note-foot';

			var state = document.createElement('span');
			state.className = 'imp-note-state';
			state.dataset.state = n.sent ? 'sent' : 'kept';
			state.textContent = n.sent
				? (n.n
					? tOr('social.state_sent_n', 'Sent {date}, and is proposal {n}', { date: fmtDate(n.sent), n: n.n })
					: tOr('social.state_sent', 'Sent {date}', { date: fmtDate(n.sent) }))
				: tOr('social.state_kept', 'Kept here');
			foot.appendChild(state);

			if (!n.sent && hasVoice()) {
				foot.appendChild(button('imp-note-send', 'improve-resend',
					tOr('social.send', 'Send'),
					tOr('social.send_help', 'Send exactly what is above to Oxedyne. Nothing else goes with it.')));
			}
			foot.appendChild(button('imp-note-copy', 'improve-copy', t('common.copy'), t('common.copy')));

			try {
				foot.appendChild(DaimondCloser.make({
					name: tOr('social.drop', 'Delete this note'),
					cls:  'imp-note-drop',
					onClose: function () { drop(n.id); },
				}));
			} catch (e) {
				foot.appendChild(button('imp-note-drop', 'improve-drop', '×', tOr('social.drop', 'Delete this note')));
			}

			row.appendChild(foot);
			list.appendChild(row);
		});
	}

	/// The word a state is read as. The forge's vocabulary is
	/// open/accepted/declined/done; the guide's words are Open, Being done, Done
	/// and Declined, and those are what a reader has been promised.
	///
	/// `accepted` reads through `social.state_taken`, which is the key those
	/// eight locales already hold "Being done" in. The key's name is older than
	/// the forge's word and renaming it would throw eight translations away to
	/// tidy a string nobody sees.
	function stateWord(s) {
		if (s === 'accepted') return tOr('social.state_taken', 'Being done');
		if (s === 'done')     return tOr('social.state_done', 'Done');
		if (s === 'declined') return tOr('social.state_declined', 'Declined');
		return tOr('social.state_open', 'Open');
	}

	/// The vote control, which draws ONLY when the answer carried a tally.
	///
	/// DARK UNTIL THE FORGE ANSWERS. The vote route is not built there yet, so a
	/// record arrives with no `votes` at all and nothing is drawn -- not a
	/// disabled button, not a zero. The day the forge starts answering it, this
	/// lights up on its own with no edit here.
	///
	/// This is NOT the test §9 warns a client off. That warning is against
	/// treating an UNVOTED proposal as one with no tally: `votes` on a proposal
	/// nobody has voted on is `{"for":0,"against":0}`, the zero object, and it is
	/// drawn like any other. What is tested here is the key's ABSENCE, which
	/// under §9 cannot happen at all -- so the day §9 ships this branch stops
	/// being reachable and stops costing anything.
	///
	/// `mine` ABSENT and `mine` NULL are different and are drawn differently: the
	/// first says the request carried no voice, so the buttons are not offered at
	/// all and a line says why; the second says a voice asked and has not voted,
	/// which is two buttons with neither pressed. A control that drew those the
	/// same way would show an unvoted button to somebody who cannot vote.
	function drawVoteControl(p, into) {
		if (!p.votes) return;
		var box = document.createElement('div');
		box.className = 'imp-votes';

		var tally = document.createElement('span');
		tally.className = 'imp-prop-tally';
		tally.textContent = tOr('social.tally', '{yes} for, {no} against',
			{ yes: p.votes.for, no: p.votes.against });
		box.appendChild(tally);

		if (!p.asked) {
			var line = document.createElement('span');
			line.className = 'imp-as';
			line.textContent = tOr('social.vote_novoice', 'Set a voice to vote on this.');
			box.appendChild(line);
			into.appendChild(box);
			return;
		}
		[['do', 1, tOr('social.do', 'Do this')], ['not', -1, tOr('social.not', 'Not this')]]
			.forEach(function (pair) {
				var b = button('imp-vote', 'improve-vote', pair[2], pair[2]);
				b.dataset.dir = pair[0];
				if (p.mine === pair[1]) {
					b.classList.add('on');
					b.setAttribute('aria-pressed', 'true');
					b.title = tOr('social.vote_off', 'Press again to take your vote back off.');
				} else {
					b.setAttribute('aria-pressed', 'false');
				}
				box.appendChild(b);
			});
		into.appendChild(box);
	}

	/// One proposal, as a row that opens what it names: a coloured dot, the
	/// title, and the tally as its value — the admin panel's shape exactly,
	/// which is what the guide's "row" entry describes.
	function drawProps() {
		var list = el('improve-props'), asAt = el('improve-asat');
		if (!list) return;
		// WHAT SOMEBODY IS HALF-WAY THROUGH TYPING SURVIVES THE REDRAW, for the
		// same reason an open row does: a vote or a language change redraws this
		// whole list, and a reply box emptied by it would take the words with it.
		var typed = {};
		list.querySelectorAll('.imp-prop').forEach(function (r) {
			var box = r.querySelector('.imp-reply');
			if (box && box.value) typed[r.dataset.prop] = box.value;
		});
		list.innerHTML = '';

		if (asAt) {
			// WHAT THIS PANEL WILL NEVER DO, said on the surface rather than in a
			// help page. Contract §7: there is no change feed, so a tester is never
			// TOLD their proposal was answered -- they find out by looking. A panel
			// that implied otherwise, with a badge or an unread count it cannot
			// honour, would be promising something nothing behind it can deliver.
			asAt.textContent = tOr('social.live_note',
				'These are read from the forge as you look at them. Nothing tells you when a proposal is answered; look again to find out.');
		}

		if (_list.err) {
			var err = document.createElement('div');
			err.className = 'rail-note imp-err';
			err.dataset.why = _list.err.why || '';
			err.textContent = saying(_list.err);
			list.appendChild(err);
		}

		if (!_order.length) {
			var none = document.createElement('div');
			none.className = 'rail-note';
			none.textContent = _list.loading
				? tOr('social.loading', 'Reading the proposals…')
				// NOT `social.no_props`, whose English in the catalogue says
				// proposals "arrive with a new build". They do not any more: they
				// arrive when somebody opens one, and a translated sentence that is
				// now false is worse than an English one that is true.
				: (_list.err
					? tOr('social.none_shown', 'Nothing could be read just now.')
					: tOr('social.none_yet', 'No proposals here yet. Yours would be the first.'));
			list.appendChild(none);
			return;
		}

		_order.forEach(function (n) {
			var p = _by[n];
			if (!p) return;
			var row = document.createElement('div');
			row.className = 'imp-prop';
			row.dataset.prop = String(p.n);
			row.dataset.state = p.state;

			var head = document.createElement('button');
			head.type = 'button';
			head.className = 'imp-prop-row';
			head.dataset.act = 'improve-open';

			var dot = document.createElement('span');
			dot.className = 'imp-dot';
			dot.title = stateWord(p.state);
			head.appendChild(dot);

			var title = document.createElement('span');
			title.className = 'imp-prop-title';
			title.textContent = p.title;
			head.appendChild(title);

			// The row's value is the tally, and there is no tally until the forge
			// answers one. A row that showed a zero there would be reporting a
			// count nothing has taken.
			if (p.votes) {
				var tally = document.createElement('span');
				tally.className = 'imp-prop-tally';
				tally.textContent = String(p.votes.for);
				tally.title = tOr('social.tally', '{yes} for, {no} against',
					{ yes: p.votes.for, no: p.votes.against });
				head.appendChild(tally);
			}
			row.appendChild(head);

			var body = document.createElement('div');
			body.className = 'imp-prop-body';
			// WHICH ROWS WERE OPEN SURVIVES THE REDRAW. Casting a vote redraws the
			// list, and the first build of this closed the proposal the user was
			// reading at the moment they pressed a button on it -- the answer
			// vanishing along with the question.
			body.hidden = !_open[String(p.n)];
			head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');

			var says = document.createElement('p');
			says.className = 'imp-prop-says';
			says.textContent = p.detail
				? p.body
				: tOr('social.reading', 'Reading it…');
			body.appendChild(says);

			var facts = document.createElement('div');
			facts.className = 'imp-prop-facts';
			var parts = [stateWord(p.state)];
			if (p.author) parts.push(tOr('social.by', 'from {who}', { who: p.author }));
			if (p.opened) parts.push(fmtWhen(p.opened));
			parts.push(tnOr('social.said_n', p.comments, '{n} reply', '{n} replies', { n: p.comments }));
			if (p.build) parts.push(tOr('social.built_on', 'written on build {build}', { build: p.build }));
			if (p.mark)  parts.push(tOr('social.closed_by', 'closed by mark {mark}', { mark: p.mark }));
			facts.textContent = parts.join(' · ');
			body.appendChild(facts);

			// WHERE A READER MEETS THE CASE, not in a help page. A proposal that
			// names a mark is one whose code has moved, and "did my note follow
			// it?" is the question a reader has at exactly this moment. Contract §5.
			if (p.mark) {
				var floor = document.createElement('p');
				floor.className = 'imp-prop-says imp-floor';
				floor.textContent = tOr('social.move_floor',
					'A note follows its content across a file boundary only when the change is recognised as a move, '
					+ 'and the floor for that is 64 bytes. Cut less than that from one file into another and the '
					+ 'history holds a deletion and an insertion, so a note anchored there honestly reports its '
					+ 'content deleted. The note is right and the history is right.');
				body.appendChild(floor);
			}

			if (p.discussion && p.discussion.length) {
				var disc = document.createElement('div');
				disc.className = 'imp-disc';
				p.discussion.forEach(function (d) {
					var one = document.createElement('div');
					one.className = 'imp-disc-one';
					var who = document.createElement('span');
					who.className = 'imp-note-state';
					who.textContent = d.author + (d.when ? ' · ' + fmtWhen(d.when) : '');
					var said = document.createElement('p');
					said.className = 'imp-prop-says';
					said.textContent = d.said;
					one.appendChild(who);
					one.appendChild(said);
					disc.appendChild(one);
				});
				body.appendChild(disc);
			}

			drawVoteControl(p, body);

			// Saying something back. Offered only with a voice, because the forge
			// refuses a comment without one and a box that cannot be sent is a box
			// that teaches people to distrust every box.
			if (p.detail && hasVoice()) {
				var reply = document.createElement('textarea');
				reply.className = 'imp-box imp-reply';
				reply.rows = 2;
				reply.placeholder = tOr('social.reply_ph', 'Say something about this proposal.');
				reply.setAttribute('aria-label', tOr('social.reply_ph', 'Say something about this proposal.'));
				if (typed[String(p.n)]) reply.value = typed[String(p.n)];
				body.appendChild(reply);
				var acts = document.createElement('div');
				acts.className = 'imp-acts';
				acts.appendChild(button('imp-send', 'improve-comment',
					tOr('social.reply', 'Say it'),
					tOr('social.reply_help', 'Send exactly what is in this box. Nothing else goes with it.')));
				body.appendChild(acts);
			}

			row.appendChild(body);
			list.appendChild(row);
		});

		// The foot: how many there are, and the one control that walks downwards.
		var foot = document.createElement('div');
		foot.className = 'rail-note imp-foot';
		var count = document.createElement('span');
		count.id = 'improve-count';
		count.textContent = tnOr('social.count', _list.total,
			'{n} proposal', '{n} proposals', { n: _list.total });
		foot.appendChild(count);
		if (!_list.done) {
			foot.appendChild(button('imp-note-copy', 'improve-more',
				_list.loading ? tOr('social.loading', 'Reading the proposals…') : tOr('social.more', 'Show older')));
		}
		list.appendChild(foot);
	}

	function render() {
		drawContext();
		drawAs();
		drawVoice();
		drawNotes();
		drawProps();
	}

	// ── A REFERENCE, DRAWN AS A CHIP ───────────────────────────
	//
	// Four things a message may point at — a proposal, a build, a panel, a guide
	// page — and the five rules the code has to keep. They are written out here
	// because every one of them is a rule somebody would otherwise "simplify"
	// away, and four of the five look like extra work until the thing they
	// prevent happens.
	//
	//   R1  RESOLVED BY THE READER, NEVER RENDERED BY THE SENDER. What travels
	//       is `{ kind, id, fallback_label }`. The title on screen is read from
	//       the forge, this build's own stamp, this build's own panel table or
	//       this build's own guide — by the reader, now. A title supplied by the
	//       sender is a lie waiting to happen, because proposals get renamed and
	//       closed, AND it is an injection surface: arbitrary text drawn as
	//       though it were a forge record. `fallback_label` is drawn ONLY when
	//       the resolution fails, as plain text, and framed as the sender's own
	//       description rather than as the name of anything.
	//   R2  NEVER DISCLOSE THE EXISTENCE OF WHAT THE READER CANNOT SEE. The nine
	//       refusal wordings are `saying()`'s, unchanged and not re-worded here:
	//       `absent` covers both "no such repository" and "it is private", which
	//       is exactly why it must not be sharpened. A signed-out reader is
	//       refused by the gateway before the forge is asked, so they are told to
	//       sign in and NEVER that a thing was not found.
	//   R3  A REFERENCE IS NOT A URL. There is no `href` in this file. Every chip
	//       is a `<button>` that calls into this app.
	//   R4  AT MOST FOUR PER MESSAGE. Enforced here as well as in the payload, so
	//       a sender that got past the seal still cannot draw a fifth.
	//   R5  RESOLUTION IS LAZY AND CACHED. Nothing is fetched until somebody
	//       presses the chip open, and an answer is kept. `improve.rs` meters per
	//       tester: ten proposal chips resolved eagerly on an inbox opening is
	//       ten metered requests against that reader's OWN Improve allowance,
	//       which could throttle them out of the Improve half of this panel
	//       entirely. That is the whole reason R5 exists.

	/// The four kinds. An enum, not a string test: a fifth arrives by being
	/// added here and nowhere else, and a `kind` this build does not know draws
	/// the sender's description and no control at all.
	// i18n-family: ref.kind_ = proposal build panel guide
	var REFS = { proposal: 'Proposal', build: 'Build', panel: 'Panel', guide: 'Guide' };

	/// Resolutions already paid for, by `kind + ':' + id`. R5's cache. Kept for
	/// the life of the tab: a proposal's title moving under a reader who is
	/// looking at a chip costs nothing, and a second metered request does.
	var _refs = {};

	/// The one place a reference off the wire is read. Everything else in this
	/// section takes the result of this and never the raw thing.
	///
	/// A reference is three fields and there is no fourth. Anything else on the
	/// object is dropped here rather than ignored later, which is the difference
	/// between a field that cannot be smuggled and one that merely is not read.
	function cleanRef(r) {
		if (!r || typeof r !== 'object') return null;
		var kind = (typeof r.kind === 'string') ? r.kind : '';
		if (!REFS[kind]) return null;
		var id = (r.id == null) ? '' : String(r.id);
		if (!id || id.length > 128) return null;
		var said = (typeof r.fallback_label === 'string') ? r.fallback_label.slice(0, 200) : '';
		return { kind: kind, id: id, said: said };
	}

	/// The references a message carries, cleaned and capped. R4.
	function cleanRefs(list) {
		if (!Array.isArray(list)) return [];
		var out = [];
		for (var i = 0; i < list.length && out.length < 4; i++) {
			var r = cleanRef(list[i]);
			if (r) out.push(r);
		}
		return out;
	}

	/// Whether this reader has a session at all. Without one `improve.rs` refuses
	/// before the forge is asked, so a proposal chip must say "sign in" rather
	/// than anything about whether the proposal is there.
	function signedIn() {
		try {
			if (window.DaimondGateway && DaimondGateway.hasSession) return !!DaimondGateway.hasSession();
			if (window.DaimondIdentity && DaimondIdentity.unlocked) return !!DaimondIdentity.unlocked();
		} catch (e) { /* neither module in this build */ }
		return true;			// not knowable here: let the refusal say it instead
	}

	/// Resolve one reference. Answers `{ ok, title, note, act }` or
	/// `{ ok: false, why }` with `why` already a SENTENCE from `saying()`.
	async function resolve(ref) {
		var key = ref.kind + ':' + ref.id;
		if (_refs[key]) return _refs[key];
		var out;
		if (ref.kind === 'proposal') {
			var n = parseInt(ref.id, 10);
			if (!(n > 0)) out = { ok: false, why: tOr('ref.unopenable', 'There is no opening this here.') };
			else if (!signedIn()) out = { ok: false, why: tOr('ref.signin', 'Sign in to open this.') };
			else {
				var a = await ask(route('n=' + n), { method: 'GET' });
				if (!a.ok) out = { ok: false, why: saying(a) };
				else {
					var p = cleanProp(a.data);
					out = p
						? {
							ok:    true,
							title: p.title,
							note:  tnOr('ref.said_n', p.comments, '{n} comment, public',
								'{n} comments, public', { n: p.comments }),
							act:   tOr('ref.open_proposal', 'Open the proposal'),
							go:    function () { absorb(p); show('proposals'); openProp(p.n); },
						}
						: { ok: false, why: saying(null) };
				}
			}
		} else if (ref.kind === 'build') {
			// Not a request: this build's own stamp is already in hand, and the
			// reader's own is the only other half of the answer.
			var here = (_build && _build === ref.id);
			out = {
				ok:    true,
				title: tOr('ref.build', 'Build {id}', { id: ref.id }),
				note:  here
					? tOr('ref.build_here', 'This is the build you are on.')
					: tOr('ref.build_other', 'You are on build {id}.', { id: _build || '?' }),
				act:   here ? '' : tOr('ref.build_update', 'Update to it'),
				go:    here ? null : function () {
					try { if (window.DaimondUpdater) DaimondUpdater.check(); } catch (e) { /* no updater */ }
				},
			};
		} else if (ref.kind === 'panel') {
			// A surface, not an object. It discloses nothing and needs no
			// resolution machinery -- but a panel this build does not have is
			// still a chip that would always fail, so it is asked for by name.
			var host = /^[a-z0-9_-]+$/i.test(ref.id)
				? document.querySelector('[data-panel="' + ref.id + '"]')
				: null;
			out = host
				? {
					ok:    true,
					title: tOr('ref.panel', 'The {name} panel',
						{ name: host.dataset.label || ref.id }),
					note:  '',
					act:   tOr('ref.open_panel', 'Open it'),
					go:    function () { try { DaimondPanels.show(ref.id); } catch (e) { /* no engine */ } },
				}
				: { ok: false, why: tOr('ref.unopenable', 'There is no opening this here.') };
		} else {
			var page = /^[a-z0-9-]+\.html(#[a-z0-9-]+)?$/i.test(ref.id) ? ref.id : '';
			out = page
				? {
					ok:    true,
					title: tOr('ref.guide', 'Guide: {page}', { page: page.replace(/\.html.*$/, '') }),
					note:  '',
					act:   tOr('ref.open_guide', 'Open the page'),
					// The guide renders IN the app. "Never link out" honoured
					// rather than dodged: this is the same route the header's own
					// guide button takes.
					go:    function () {
						try { if (window.DaimondWeb && DaimondWeb.guide) DaimondWeb.guide(page); }
						catch (e) { /* no web panel in this build */ }
					},
				}
				: { ok: false, why: tOr('ref.unopenable', 'There is no opening this here.') };
		}
		_refs[key] = out;
		return out;
	}

	/// Open a proposal in the Proposals view, as pressing its row does.
	function openProp(n) {
		_open[String(n)] = 1;
		drawProps();
		var row = document.querySelector('.imp-prop[data-prop="' + n + '"]');
		if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
	}

	/// What a chip is called before anything has been read.
	///
	/// The id is this app's own words only where it is SHAPED like an id of that
	/// kind: a proposal number, a build stamp, a panel this build has, a guide
	/// page. Anything else and the name is EMPTY -- the kind label beside it
	/// already says what sort of thing this is, and repeating it there says
	/// nothing twice. Because an id is the one field a sender fills in, and a
	/// hundred and twenty-eight characters of their choosing sitting where a name
	/// goes is R1 defeated by the back door.
	function refName(ref) {
		if (ref.kind === 'proposal') {
			return /^[0-9]{1,9}$/.test(ref.id)
				? tOr('ref.proposal', 'Proposal #{n}', { n: ref.id }) : '';
		}
		if (ref.kind === 'build') {
			return /^[0-9a-f]{6,64}$/i.test(ref.id)
				? tOr('ref.build', 'Build {id}', { id: ref.id }) : '';
		}
		if (ref.kind === 'panel') {
			var p = /^[a-z0-9_-]+$/i.test(ref.id)
				? document.querySelector('[data-panel="' + ref.id + '"]') : null;
			return p ? tOr('ref.panel', 'The {name} panel', { name: p.dataset.label || ref.id }) : '';
		}
		return /^[a-z0-9-]+\.html(#[a-z0-9-]+)?$/i.test(ref.id)
			? tOr('ref.guide', 'Guide: {page}', { page: ref.id.replace(/\.html.*$/, '') }) : '';
	}

	/// One chip, SHUT until somebody opens it. The shape is `attachTile`'s: a
	/// kind, a name, a reason and a note, with `shut` meaning "there is no
	/// opening this" -- the same thing an unresolvable reference is.
	function refChip(ref) {
		var box = document.createElement('div');
		box.className = 'ref-chip';
		box.dataset.kind = ref.kind;
		box.dataset.ref  = ref.id;

		var kind = document.createElement('span');
		kind.className = 'ref-kind';
		kind.textContent = tOr('ref.kind_' + ref.kind, REFS[ref.kind]);
		box.appendChild(kind);

		// What it is called BEFORE anything has been read: the kind and the id.
		// Never the sender's words -- and never a raw id either unless it is
		// SHAPED like an id of that kind. An id is the one field a sender fills
		// in, so an unrecognisable one is drawn as nothing at all rather than as
		// 128 characters of their choosing sitting where a name goes.
		var name = document.createElement('span');
		name.className = 'ref-name';
		name.textContent = refName(ref);
		box.appendChild(name);

		var note = document.createElement('span');
		note.className = 'ref-note';
		box.appendChild(note);

		var act = document.createElement('button');
		act.type = 'button';
		act.className = 'ref-act';
		act.textContent = tOr('ref.expand', 'Show what this is');
		box.appendChild(act);

		var done = false;
		act.addEventListener('click', async function () {
			if (done) return;
			done = true;
			act.disabled = true;
			note.textContent = tOr('ref.reading', 'Reading it…');
			var r = await resolve(ref);
			if (!r.ok) {
				box.classList.add('shut');
				note.textContent = r.why;
				// R1: the sender's description, drawn only now, as plain text and
				// said to be theirs. `textContent` and not markup, which is the
				// other half of why a sender-supplied title is refused.
				if (ref.said) {
					var said = document.createElement('span');
					said.className = 'ref-said';
					said.textContent = tOr('ref.said', 'Described as: {text}', { text: ref.said });
					box.appendChild(said);
				}
				act.remove();
				return;
			}
			if (r.title) name.textContent = r.title;
			note.textContent = r.note || '';
			if (r.act && r.go) {
				act.disabled = false;
				act.textContent = r.act;
				act.onclick = r.go;
			} else act.remove();
		});
		return box;
	}

	/// Draw a message's references into `host`. What a message renderer calls.
	function drawRefs(host, list) {
		if (!host) return 0;
		host.innerHTML = '';
		var refs = cleanRefs(list);
		refs.forEach(function (r) { host.appendChild(refChip(r)); });
		return refs.length;
	}

	// ── The chips on the head ──────────────────────────────────
	//
	// Decision 13: the panel is Social. It held four things — Messages, People,
	// Notes, Proposals — and now holds five, Share being the fifth. Two of them
	// are this file's; the other three are containers other modules render into,
	// and this file only shows and hides them. It defaults to Notes, which is the
	// one that works in every build.
	//
	// The count is deliberately no longer in the heading. A heading that names a
	// number is a heading that goes stale the next time somebody adds a chip, and
	// the table below is the only honest count.
	//
	// The views are looked up by NAME rather than listed twice: a chip is a
	// `data-view` on the head and an element id in the table below, and a fifth
	// chip is one line here.

	var VIEWS = {
		messages:  'social-messages',
		people:    'social-people',
		// The fifth, and it cost the one line this table was built to cost.
		// js/share.js renders into `#social-share-list` the way post.js renders
		// into the messages list; this file shows and hides it and nothing more.
		share:     'social-share',
		notes:     'improve-notes',
		proposals: 'improve-props-view',
	};

	var _view = 'notes';

	/// Callbacks a lane registers to be told its own view was opened, so it can
	/// read what it needs LAZILY. Ten chips resolved on panel open is ten
	/// requests nobody asked for.
	var _watch = [];

	function show(view) {
		_view = VIEWS[view] ? view : 'notes';
		Object.keys(VIEWS).forEach(function (v) {
			var e = el(VIEWS[v]);
			if (e) e.hidden = (v !== _view);
		});
		document.querySelectorAll('#panel-social .imp-chip').forEach(function (c) {
			var on = c.dataset.view === _view;
			c.classList.toggle('on', on);
			c.setAttribute('aria-pressed', on ? 'true' : 'false');
		});
		if (_view === 'proposals') {
			if (!_list.read && !_list.loading) loadList(false);
			else drawProps();
		} else drawProps();
		_watch.forEach(function (f) { try { f(_view); } catch (e) { /* one lane's fault is its own */ } });
	}

	/// A lane says how many rows it drew in its own view. The honest line under
	/// the chip goes away exactly when there is something else to read there, and
	/// comes back when there is not — so an emptied list never leaves a blank.
	function filled(view, n) {
		var off = el('social-' + view + '-off');
		if (off) off.hidden = !!(n | 0);
	}

	// ── Wiring ─────────────────────────────────────────────────

	/// The panel was opened. The listing is read again, because there is no change
	/// feed and looking IS how a tester finds out.
	function onOpen() {
		render();
		if (_view === 'proposals') loadList(false);
		_watch.forEach(function (f) { try { f(_view); } catch (e) { /* as above */ } });
	}

	document.addEventListener('click', function (e) {
		var host = e.target && e.target.closest ? e.target.closest('#panel-social') : null;
		if (!host) return;
		var chip = e.target.closest('.imp-chip');
		if (chip) { e.preventDefault(); show(chip.dataset.view); return; }
		var b = e.target.closest('[data-act]');
		if (!b) return;
		var act = b.dataset.act;
		if (act === 'improve-keep')   { e.preventDefault(); keep(); return; }
		if (act === 'improve-send')   { e.preventDefault(); send(); return; }
		if (act === 'improve-more')   { e.preventDefault(); loadList(true); return; }
		if (act === 'improve-voice-open')   { e.preventDefault(); _voiceOpen = true;  drawVoice(); return; }
		if (act === 'improve-voice-cancel') { e.preventDefault(); _voiceOpen = false; drawVoice(); return; }
		if (act === 'improve-voice-save')   { e.preventDefault(); saveVoice(); return; }
		if (act === 'improve-voice-forget') { e.preventDefault(); forgetVoice(); return; }
		if (act === 'improve-with-off') {
			e.preventDefault();
			var row = el('improve-with');
			if (row) { row.dataset.off = '1'; row.hidden = true; }
			return;
		}
		var noteEl = b.closest('.imp-note');
		if (noteEl) {
			if (act === 'improve-copy')   { e.preventDefault(); copy(noteEl.dataset.note); return; }
			if (act === 'improve-resend') { e.preventDefault(); resend(noteEl.dataset.note); return; }
			if (act === 'improve-drop')   { e.preventDefault(); drop(noteEl.dataset.note); return; }
		}
		var propEl = b.closest('.imp-prop');
		if (propEl) {
			var n = Number(propEl.dataset.prop);
			if (act === 'improve-open') {
				e.preventDefault();
				var body = propEl.querySelector('.imp-prop-body');
				var shut = !body || body.hidden;
				if (body) body.hidden = !shut;
				b.setAttribute('aria-expanded', shut ? 'true' : 'false');
				if (shut) {
					_open[String(n)] = 1;
					// Opening it is what reads it: one proposal, one request, and
					// only for the one somebody asked to see.
					if (_by[n] && !_by[n].detail) loadOne(n);
				} else delete _open[String(n)];
				return;
			}
			if (act === 'improve-vote')    { e.preventDefault(); vote(n, b.dataset.dir); return; }
			if (act === 'improve-comment') { e.preventDefault(); comment(n); return; }
		}
	});

	// The row that says what goes with a note is redrawn as the app moves around
	// it: open a panel, change the palette, turn the phone, and the line has to
	// say what is true when Send is pressed rather than what was true when the
	// panel was opened.
	['resize', 'daimond:layout', 'daimond:theme'].forEach(function (ev) {
		try { window.addEventListener(ev, function () { if (!contextOff()) drawContext(); }); }
		catch (e) { /* no window */ }
	});

	// Another tab wrote a note, or an account switch emptied the store.
	window.addEventListener('storage', function (e) {
		if (e.key !== KEY && !(e.key && e.key.indexOf(KEY) !== -1)) return;
		_st = null;
		render();
	});

	// Say the panel's own words again in a new language. Every string on a row is
	// built here rather than marked up, so a language change reaches none of them
	// unless this surface is registered.
	try {
		DaimondI18n.surface(function () { return document.getElementById('panel-social'); },
			function () { render(); });
	} catch (e) { /* no i18n in this build */ }

	function start() {
		if (!el('panel-social')) return;		// this build has no Improve panel
		readBuild().then(function () { render(); }, function () { render(); });
		show('notes');
		render();
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();

	/// The panel SHELL, which is what the app and the other lanes talk to.
	///
	/// Separate from `DaimondImprove` below on purpose: the Social panel holds
	/// four things and this file owns two of them. A lane rendering into
	/// `#social-messages-list` or `#social-people-list` needs the chips, the
	/// view switch and the empty line, and has no business with a note or a
	/// proposal.
	window.DaimondSocial = {
		/// The panel was shown. Every view is told, so a lane can read lazily.
		onOpen: onOpen,
		/// Switch to one of `messages`, `people`, `notes`, `proposals`.
		show:   show,
		/// Show the panel AND switch to a view. What a reference chip presses.
		open:   function (view) {
			try { if (window.DaimondPanels) DaimondPanels.show('social'); } catch (e) { /* no engine */ }
			show(view);
		},
		/// Which view is showing.
		view:   function () { return _view; },
		/// A lane drew `n` rows in `view`; the honest empty line follows.
		filled: filled,
		/// Be told when a view is opened, by name. Called on every switch and on
		/// every panel open, so a lane refreshes when somebody looks.
		watch:  function (fn) { if (typeof fn === 'function') _watch.push(fn); },
	};

	/// References, for whatever renders a message. Kept here rather than in the
	/// module that draws messages, because a proposal reference resolves through
	/// THIS file's `route()`, `ask()` and `saying()` — the nine refusal wordings
	/// exist once, and a second copy of them is a second copy to get wrong.
	window.DaimondRefs = {
		/// Draw the references a message carries into `host`; answers how many
		/// were drawn, which is at most four.
		draw:  drawRefs,
		/// One chip, for a caller placing them itself.
		chip:  refChip,
		/// What a wire reference reduces to, for a verifier and for a sender
		/// that wants to know what will survive. Everything else is dropped.
		clean: cleanRefs,
		/// Resolve one, for a verifier. Cached exactly as the chip's own press is.
		resolve: function (r) {
			var c = cleanRef(r);
			return c ? resolve(c) : Promise.resolve({ ok: false, why: '' });
		},
		/// Forget what has been resolved, for a test that wants a cold cache.
		forget: function () { _refs = {}; },
	};

	window.DaimondImprove = {
		onOpen:   onOpen,
		render:   render,
		show:     show,
		/// Writing, keeping and sending. Published so a verifier drives the same
		/// path a person does rather than a second one written for it.
		keep:     keep,
		send:     send,
		resend:   resend,
		drop:     drop,
		/// The exact characters a Send would put on the wire right now, and the
		/// cut that turns them into a proposal. The verifier compares both against
		/// what actually left.
		outgoing: outgoing,
		split:    split,
		/// Reading the forge, and the walk downwards through it.
		load:     loadList,
		one:      loadOne,
		/// Voting and saying something. Both go straight to the forge; neither is
		/// kept here.
		vote:     vote,
		comment:  comment,
		voteBody: voteBody,
		/// What is drawn, for a verifier that wants the record rather than the
		/// pixels.
		proposal: function (n) { return _by[n] ? JSON.parse(JSON.stringify(_by[n])) : null; },
		listing:  function () { return { total: _list.total, shown: _order.slice(), done: _list.done, err: _list.err ? _list.err.why : '' }; },
		/// The store, for a verifier and for an account switch.
		notes:    function () { return load().notes.slice(); },
		reset:    function () { _st = null; _by = {}; _order = []; _open = {}; _list = { total: 0, lowest: null, done: false, loading: false, err: null, read: false }; },
	};
})();
