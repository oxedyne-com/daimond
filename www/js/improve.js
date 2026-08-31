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

   ── A CONTROL DRAWS FROM THE ANSWER, NOT FROM A DATE ────────
   Contract §9 puts voting on the forge, and the forge answers it:
   `views/proposals.rs` dispatches `proposals/<n>/vote`, and both
   the listing and the whole record carry `votes`, checked against
   the deployed host on 2026-08-27. So the control DRAWS, and it
   draws for the reason it was built to -- BECAUSE THE ANSWER
   CARRIES `votes`, never because a comment here said the day had
   come. A visible control that reaches nothing is the defect this
   file was rewritten to remove, and a control gated on the answer
   cannot become one.

   That is the whole point of the shape, and it has now been paid
   off once: nothing in this file changed when the forge started
   answering. The three sentences that said otherwise -- here, at
   `cleanProp`, and in the contract's §9 -- were prose that had gone
   stale while the code stayed right, which is the failure mode a
   dated claim has and a derived one does not.

   AMENDMENT IS THE SAME SHAPE AGAIN, and it has now paid off
   twice. The forge answers `POST proposals/<n>/amend` and carries
   `mine_to_amend` beside `mine`; the gateway's door was already
   open (`&amend=1`), and `drawAmendControl` below draws only when
   that flag is PRESENT. Absent is not false -- see `cleanProp`.
   The whole proposal also carries `revisions`, a LIST oldest
   first and EMPTY rather than absent, which is not the count
   `comments` beside it is.

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
	// What one note may be. NOT the gateway's cap, which is what this said until
	// 2026-08-28: the improve route forwards at most 64 KiB (`MAX_BODY`,
	// gateway/src/handlers/improve.rs:227) and no 20000 exists anywhere under
	// `gateway/src/`. This is a client-side choice and a defensible one -- 20,000
	// characters is a long report and well inside the door, so a note trimmed here
	// is never a note the hop refuses -- but it was justified by a number nobody
	// wrote, and the next reader would have moved it to match a cap it does not track.
	var MAX_CHARS = 20000;

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
			mode: (r.mode === 'polish') ? 'polish' : 'verbatim',
			build: (typeof r.build === 'string') ? r.build : '',
			sent: ms(r.sent),
			/// The proposal this note became, or 0. Kept so a row can name it: a
			/// tester who sent something and was told only "Sent" has no way back
			/// to what happened to it.
			n:    Math.max(0, whole(r.n)),
			// Folded, which is not sent
			//
			// NOT `n`, and the difference is this panel's only copy of somebody's
			// words. `n` is the proposal this note BECAME: the forge holds these
			// exact characters, so what is here is a second copy. `into` is a
			// proposal that js/triage.js DRAFTED from this note, usually beside
			// others -- the forge holds the drafting, which is not what this
			// person wrote, and where several notes were folded together it holds
			// a fragment of each. A folded note is therefore still the only copy
			// of what somebody wrote, and `save()` must never evict one.
			//
			// A LIST, because one note holding two faults is drafted into two
			// proposals. This tree has lost user data once already to a field
			// doing double duty; `n` doing this one as well would be the same
			// mistake with the same consequence.
			into: intoList(r.into),
		};
	}

	/// The proposal numbers on a stored note's `into`, cleaned. Whole numbers
	/// above zero, no repeats, and capped: a record that arrived from anywhere
	/// but this file's own `fold()` is still only a list of numbers.
	function intoList(v) {
		if (!Array.isArray(v)) return [];
		var out = [];
		for (var i = 0; i < v.length && out.length < 32; i++) {
			var n = Math.max(0, whole(v[i]));
			if (n > 0 && out.indexOf(n) === -1) out.push(n);
		}
		return out;
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

	/// Does the forge hold this note's own characters?
	///
	/// The one question `save()`'s cap turns on, and the reason it is a function
	/// with a name. `sent` says these exact characters went to the forge as a
	/// proposal, so a second copy here is spare. `into` says a DRAFT written from
	/// this note went instead -- the forge holds the drafting, and where several
	/// notes were folded into one proposal it holds a fragment of each. So a
	/// folded note is still the only copy of what somebody wrote and is never
	/// spare, whatever else is true of it.
	///
	/// Both are tested rather than only `sent`, although no path here sets both:
	/// a rule this file cannot afford to get wrong should not also depend on a
	/// rule kept somewhere else.
	function delivered(rec) {
		return !!(rec && rec.sent && !(rec.into && rec.into.length));
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
		//
		// A FOLDED NOTE IS NOT A DELIVERED ONE, and `delivered()` is where that
		// is decided rather than here, so the one question this rule turns on is
		// asked in one place and can be proved on its own.
		if (s.notes.length > MAX_NOTES) {
			var over = s.notes.length - MAX_NOTES;
			for (var i = s.notes.length - 1; i >= 0 && over > 0; i--) {
				if (delivered(s.notes[i])) { s.notes.splice(i, 1); over--; }
			}
			if (over > 0) s.notes.length = MAX_NOTES;
		}
		try { localStorage.setItem(KEY, JSON.stringify({ v: 3, notes: s.notes })); }
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
	///
	/// THE ROW IS REDRAWN FIRST, in the same breath as the read. The line names
	/// the palette and the panels that are open, and both of those change under a
	/// panel that is already on screen: on a desktop the Social panel stays put
	/// while somebody switches palette or opens something else, and a row rendered
	/// when the panel opened then describes a screen they have left behind. Notes
	/// went out for weeks naming a palette nobody was looking at. Redrawing here,
	/// rather than listening for every way the app can move, is what makes that a
	/// closed class instead of two patched instances -- there is no signal left to
	/// forget, because the line is computed at the moment of the press, shown, and
	/// then read off the node exactly as before. Still a read of the screen: the
	/// characters returned are the characters the row is showing when it returns.
	///
	/// CLOSING THE ROW STILL TAKES THE LINE OFF THE WIRE. The `contextOff()` line
	/// below returns before the redraw is reached, and `drawContext()` leaves a
	/// closed row shut in any case.
	function outgoing() {
		var box = el('improve-box');
		var body = box ? String(box.value || '').trim() : '';
		if (!body) return '';
		if (contextOff()) return body;
		drawContext();
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
	// is the only surface that has ever needed one. Without a place to GET it the
	// whole write half would be unreachable, which is the defect this file was
	// rewritten to remove -- so the place is here, beside the button that needs
	// it, rather than in a settings screen a tester would have to be told about.
	//
	// ONE TAP, NOT A PASTE. A first voice is now GOT rather than pasted: `Get my
	// voice` posts to `/api/voice/provision`, the gateway has the forge mint one,
	// and the secret it answers with is handed straight to `DaimondVoice.set` and
	// dropped in the same breath. Nothing here logs it, draws it, or keeps it past
	// the wrap. Pasting survives only as an unobtrusive fallback for a voice the
	// forge made elsewhere -- kept because a secret can arrive out of band, not
	// because a first voice is got that way.
	//
	// WHY A TAP AND NOT SILENT. Provisioning is a forge WRITE, so it happens on a
	// press and never on its own: the button says what it will do, and a tester
	// who only wants to read is never surprised by a voice appearing in their name.

	function voice() { return window.DaimondVoice || null; }

	/// The gateway module, or null in a build without it.
	function gw() { return window.DaimondGateway || null; }

	/// Is a voice held on this device? Presence only -- reading it needs the
	/// passphrase, and that question is asked at the moment of a request.
	function hasVoice() {
		var v = voice();
		try { return !!(v && v.has()); } catch (e) { return false; }
	}

	var _voiceOpen    = false;		// whether the manual-paste fallback form is showing
	var _voiceBusy    = false;		// a provision request is in flight
	var _voiceAlready = false;		// the forge holds a voice this device has not got yet

	/// Whether a voice is held, and how to change it -- drawn in the Settings view
	/// now, not beside the compose box. Built here rather than in the markup because
	/// every word of it is drawn from this file anyway. `drawSettings` calls this
	/// after it has put the section heading in place.
	function drawVoice() {
		var write = el('improve-settings');
		if (!write) return;
		var host = el('improve-voice');
		if (!host) {
			host = document.createElement('div');
			// `.imp-acts` lays a row of buttons out with a sentence above them, which
			// is exactly this row's shape, so the panel needs no new rule to be
			// legible.
			host.className = 'imp-acts imp-voice';
			host.id = 'improve-voice';
			write.appendChild(host);
		}
		host.innerHTML = '';
		if (!voice()) return;			// no voice.js in this build

		var line = document.createElement('span');
		line.className = 'imp-as';
		line.id = 'improve-voice-say';
		line.textContent = hasVoice()
			? tOr('social.voice_held', 'Voice held on this device, encrypted under your passphrase.')
			: tOr('social.voice_none', 'No voice yet: you can read proposals, but only Keep a note to this device.');
		host.appendChild(line);

		// THE MANUAL-PASTE FALLBACK, shared by "Replace the voice" (a voice is
		// held) and the unobtrusive "I already have a voice" affordance (none is).
		// It is no longer how a FIRST voice is got -- that is one tap now -- but a
		// voice the forge made elsewhere can still be pasted in, so the form stays.
		if (_voiceOpen) {
			var input = document.createElement('input');
			input.type = 'password';
			input.className = 'imp-box';
			input.id = 'improve-voice-in';
			input.autocomplete = 'off';
			input.spellcheck = false;
			input.placeholder = tOr('social.voice_ph', 'Paste the line the forge showed you');
			input.setAttribute('aria-label', tOr('social.voice_ph', 'Paste the line the forge showed you'));
			host.appendChild(input);
			host.appendChild(button('imp-send', 'improve-voice-save', tOr('social.voice_save', 'Save the voice')));
			host.appendChild(button('imp-keep', 'improve-voice-cancel', t('common.cancel')));
			return;
		}

		// A VOICE IS HELD: replace it, or forget the copy on this device.
		if (hasVoice()) {
			host.appendChild(button('imp-note-copy', 'improve-voice-open',
				tOr('social.voice_replace', 'Replace the voice'),
				tOr('social.voice_help', 'The line the forge showed you. Kept encrypted on this device.')));
			host.appendChild(button('imp-note-copy', 'improve-voice-forget',
				tOr('social.voice_forget', 'Forget it'),
				tOr('social.voice_forget_help', 'Remove the copy on this device.')));
			return;
		}

		// NO VOICE HELD. One tap gets one, and there is nothing to paste.
		//
		// The old empty state told a reader to ask Oxedyne for an invitation link
		// and paste 45 characters back in -- true of how the forge issues a voice,
		// but a dead end for a person who just wants to write, which is what the
		// owner met. Provisioning makes the voice for them: the honest instruction
		// is now "tap the button", and the button does exactly what it says.

		// THE FORGE ALREADY HOLDS ONE, on another device -- the provision call said
		// `already`. It is not minted again here; it arrives by sync. Say so, and
		// offer the one way out if it never comes: a re-issue, which is destructive.
		if (_voiceAlready) {
			var arriving = document.createElement('span');
			arriving.className = 'imp-as';
			arriving.id = 'improve-voice-arriving';
			arriving.textContent = tOr('social.voice_already',
				'Your voice is set on another device and will sync here shortly.');
			host.appendChild(arriving);
			host.appendChild(button('imp-note-copy', 'improve-voice-reissue',
				tOr('social.voice_reissue', 'I lost my voice \u2014 re-issue'),
				tOr('social.voice_reissue_help',
					'Makes a new voice; the old one stops working everywhere. Cannot be undone.')));
			return;
		}

		var how = document.createElement('span');
		how.className = 'imp-as';
		how.id = 'improve-voice-how';
		how.textContent = tOr('social.voice_intro',
			'A voice lets you post, reply and vote on the forge; reading needs none.',
			{ host: FORGE_HOST });
		host.appendChild(how);

		// THE PRIMARY PATH: one tap. Disabled and relabelled while the request is
		// in flight, so a second press cannot mint a second voice.
		var get = button('imp-send', 'improve-voice-get',
			_voiceBusy
				? tOr('social.voice_getting', 'Making your voice on the forge\u2026')
				: tOr('social.voice_get', 'Get my voice'),
			tOr('social.voice_get_help',
				'Makes your voice on the forge. One tap.'));
		if (_voiceBusy) get.disabled = true;
		host.appendChild(get);

		// THE UNOBTRUSIVE FALLBACK, kept per the owner's instruction behind an "I
		// already have a voice" affordance rather than as the primary path: for a
		// voice the forge made elsewhere and handed over out of band.
		host.appendChild(button('imp-keep', 'improve-voice-open',
			tOr('social.voice_have', 'I already have a voice'),
			tOr('social.voice_have_help',
				'Paste a voice the forge already gave you.')));
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
		_voiceOpen    = false;
		_voiceAlready = false;
		flash(tOr('social.voice_saved', 'Your voice is held here, encrypted.'));
		render();
		return true;
	}

	/// A Daimond-session POST that keeps the STATUS and the BODY.
	///
	/// The gateway's own `post()` reduces every failure to a message string and
	/// throws it, but this panel has to tell a 402 `pro_required` from a 200
	/// `already` and from an ordinary failure, and those live in the status and the
	/// body. So it goes through `DaimondGateway.gwFetch` -- the one copy of the
	/// session rule, renew once and retry once -- and reads the answer itself.
	///
	/// NOT `DaimondVoice.send`: provisioning is how a voice is GOT, so there is no
	/// voice to carry and this is a Daimond-account call rather than a forge one.
	async function gwPost(path, body) {
		var g = gw();
		if (!g || !g.gwFetch) return { ok: false, status: 0, data: null };
		var r;
		try {
			r = await g.gwFetch(path, {
				method:      'POST',
				credentials: 'same-origin',
				headers: {
					'content-type': 'application/json',
					'x-daimond-api': String(g.clientApi ? g.clientApi() : ''),
				},
				body: JSON.stringify(body || {}),
			});
		} catch (e) {
			// A network failure throws a `TypeError` whose message is the browser's
			// own English; it must not reach a screen this app has translated. The
			// caller says its own sentence off `ok:false`.
			return { ok: false, status: 0, data: null };
		}
		var data = null;
		try { data = await r.json(); } catch (e) { data = null; }
		return { ok: r.ok, status: r.status, data: data };
	}

	/// Make this device a voice, on a press.
	///
	/// POST `/api/voice/provision` -- body `{}` to mint or adopt, `{reissue:true}`
	/// to replace a voice the forge holds that this device cannot read. The gateway
	/// forwards to the forge and answers one of:
	///
	///   200 { provisioned:true, secret:"<45>" }   a voice was minted -- hold it
	///   200 { provisioned:true, already:true }      one exists already -- it syncs
	///   402 { error:"pro_required" }                a voice is part of Pro
	///
	/// A minted secret is handed straight to `DaimondVoice.set`, which wraps it
	/// under the passphrase, and the local reference is dropped in the same breath.
	/// NOTHING HERE LOGS, DRAWS OR KEEPS THE SECRET -- the same rule voice.js opens
	/// with, kept on this side of the call as well.
	async function provision(reissue) {
		var v = voice();
		if (!v || _voiceBusy) return false;
		// A voice is wrapped at rest under the passphrase, so `set()` needs an
		// unlocked identity. Say so before a round trip that would only fail at the
		// end of it -- and before a forge write is made that could not be held.
		try {
			if (window.DaimondIdentity && !DaimondIdentity.isUnlocked()) {
				flash(tOr('voice.err.locked',
					'Unlock Daimond first: your voice is kept encrypted under your passphrase.'));
				return false;
			}
		} catch (e) { /* no identity module: let set() below speak */ }

		_voiceBusy = true;
		drawVoice();
		var a = await gwPost('/api/voice/provision', reissue ? { reissue: true } : {});
		_voiceBusy = false;

		// A VOICE IS PART OF PRO. Say it once and hand the person to the offer that
		// already exists -- the Pro block at the top of the Credits drawer, the same
		// door mail.js and sync.js send a buyer to -- rather than drawing a second
		// one here. Read off the status OR the token, so a body-less 402 still lands.
		if (a.status === 402 || (a.data && a.data.error === 'pro_required')) {
			flash(tOr('social.voice_pro', 'A voice is part of Daimond Pro.'));
			try {
				if (window.DaimondAdmin && DaimondAdmin.credits) {
					DaimondAdmin.credits(tOr('social.voice_pitch',
						'A voice on the forge is part of Daimond Pro.'));
				}
			} catch (e) { /* the drawer is absent; the sentence still stood */ }
			drawVoice();
			return false;
		}

		if (!a.ok || !a.data || a.data.provisioned !== true) {
			flash(tOr('social.voice_get_failed',
				'Could not make your voice. Try again shortly.'));
			drawVoice();
			return false;
		}

		// THE FORGE ALREADY HOLDS ONE and did not hand a secret back: it exists on
		// another device and arrives by sync, not by minting a second here. Say so,
		// and `drawVoice` offers the destructive re-issue as the one way out.
		if (a.data.already === true || typeof a.data.secret !== 'string') {
			_voiceAlready = true;
			_voiceOpen    = false;
			flash(tOr('social.voice_already',
				'Your voice is set on another device and will sync here shortly.'));
			drawVoice();
			return true;
		}

		// A VOICE WAS MINTED. Hold it, then drop the plaintext at once.
		try {
			await v.set(a.data.secret);
		} catch (e) {
			// `set()` throws a sentence a person can act on -- a locked identity, a
			// wrap that refused. Never quote the value.
			flash(e && e.message ? String(e.message)
				: tOr('social.voice_get_failed',
					'Could not make your voice. Try again shortly.'));
			drawVoice();
			return false;
		}
		a.data.secret = '';			// in the clear only for the wrap above
		_voiceOpen    = false;
		_voiceAlready = false;
		flash(tOr('social.voice_saved', 'Your voice is held here, encrypted.'));
		render();
		return true;
	}

	/// Re-issue a voice the forge holds but this device cannot read.
	///
	/// DESTRUCTIVE, so it asks first: a re-issue mints a new voice and the old one
	/// stops working on every device, and there is no undo. Offered only after a
	/// provision answered `already` -- the one case where a person genuinely lost
	/// the copy the forge made for them.
	async function reissueVoice() {
		var ok = true;
		try {
			if (window.DaimondCore && DaimondCore.confirm) {
				ok = await DaimondCore.confirm(
					tOr('social.voice_reissue_ask',
						'Re-issue your voice? The old one stops working on every device, and this cannot be undone.'),
					tOr('social.voice_reissue_do', 'Re-issue'),
					{ title: tOr('social.voice_reissue_title', 'Re-issue your voice'), danger: true });
			}
		} catch (e) { ok = true; }
		if (!ok) return false;
		return await provision(true);
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
						'Forget your voice here? It was shown once and will not be shown again.'),
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
				: tOr('social.novoice_set', 'No voice yet — set one in Settings to post.');
		}
		// Without a voice there is nothing to post AS, and the forge would refuse
		// it. The button is hidden rather than shown-and-inert: a control that
		// does nothing when pressed teaches people to distrust every control. The
		// polish button rides with it -- both post, and neither can without a voice.
		if (send) send.hidden = !hasVoice();
		var polish = el('panel-social') ? document.querySelector('[data-act="improve-polish"]') : null;
		if (polish) polish.hidden = !hasVoice();
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
		// Terse (#6): the whole address and the "no account needed" detail sit in the
		// Post button's tooltip; the line under the box is the one fact that must be
		// read before pressing -- it goes out in public, under your name.
		line.textContent = tOr('social.compose_public',
			'Posted publicly, under your voice name — anyone can read it.');
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
			'First line is the title; what happened goes below.');
	}

	// ── The queue, and posting from it ─────────────────────────

	/// Put a note in the queue, with the mode a flush will send it in. There is no
	/// "kept" state any more -- a note is here only because it has not been sent
	/// yet, and it leaves the moment it is.
	function store(text, mode) {
		var s = load();
		var rec = {
			id:   'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
			at:   Date.now(),
			text: String(text).slice(0, MAX_CHARS),
			// How a flush will send it: 'verbatim' posts the words as they are;
			// 'polish' has the model rewrite it into a proposal first. Remembered so
			// a note queued offline is sent the way its author chose when the browser
			// comes back.
			mode: (mode === 'polish') ? 'polish' : 'verbatim',
			// The sealed build identifier, captured NOW -- while the "what goes with
			// it" row is in the state the author left it. A note may sit in the queue
			// past a reconnect, by when the live row has been reset, so the build
			// cannot be read again at send time or a closed row would put it back.
			build: contextOff() ? '' : _build,
			sent: 0,
			n:    0,
			into: [],
		};
		s.notes.unshift(rec);
		save();
		return rec;
	}

	/// Take one note off the queue. Called when a send takes it (the note becomes a
	/// proposal, so the copy here is spare) and when a person drops it by hand.
	function removeNote(id) {
		var s = load();
		var i = s.notes.findIndex(function (n) { return n.id === String(id); });
		if (i === -1) return false;
		s.notes.splice(i, 1);
		save();
		return true;
	}

	/// One queued note by id, or null.
	function find(id) {
		var s = load();
		for (var i = 0; i < s.notes.length; i++) if (s.notes[i].id === String(id)) return s.notes[i];
		return null;
	}

	/// Is the browser online? `navigator.onLine` is only reliably FALSE (a true can
	/// still fail to reach the forge), so a submit tries to send and leaves the note
	/// queued if it does not go -- this only stops a pointless attempt while plainly
	/// offline, and gates the reconnect flush.
	function onLine() {
		try { return navigator.onLine !== false; } catch (e) { return true; }
	}

	/// Mark the notes a draft was written from as folded into proposal `n`.
	///
	/// WHAT THIS DOES NOT DO IS SET `sent`, and that is the whole of it. These
	/// characters did not leave: a drafting of them did, and this panel is still
	/// holding the only copy of what the person actually wrote. `delivered()`
	/// reads the difference, so a folded note survives the cap that a sent one
	/// does not.
	///
	/// Called by js/triage.js after the forge took a draft, and by nothing else.
	function fold(ids, n) {
		var num = Math.max(0, whole(n));
		if (!num || !Array.isArray(ids) || !ids.length) return 0;
		var s = load(), hit = 0;
		ids.forEach(function (id) {
			var rec = s.notes.find(function (x) { return x.id === String(id); });
			if (!rec) return;
			if (rec.into.indexOf(num) === -1) rec.into.push(num);
			hit++;
		});
		if (hit) save();
		return hit;
	}

	function clearBox() {
		var box = el('improve-box');
		if (box) box.value = '';
		// AT ONCE, not on the settle timer. This runs when a note has been kept or
		// sent, and a draft of a note that has already gone is words the user would
		// find sitting in the box afterwards looking unsent.
		try { if (drafts()) drafts().drop(draftKey('note')); } catch (e) { /* storage blocked */ }
		var row = el('improve-with');
		if (row) delete row.dataset.off;		// the next note starts with its details on
		drawContext();
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

	/// What a refusal leaves on the screen after a send: why it did not go, and that
	/// the note is still waiting in the queue.
	function keptAfter(a) {
		return saying(a) + ' ' + tOr('social.waiting_here',
			'Waiting to send; it will go when the forge is reachable.');
	}

	/// Put one already-stored note on the wire and take the answer back into the
	/// record. THE ONE DOOR a note leaves by, whether the press came from the box,
	/// from the queue, or from a daimon that was told yes -- so a fourth caller
	/// cannot quietly acquire a different idea of what "sent" means. On success the
	/// note LEAVES the queue (#3): the forge holds the proposal, so the copy here
	/// is spare and there is no list for it to sit in.
	async function through(rec, parts) {
		var a = await post(parts);
		if (a.ok) {
			removeNote(rec.id);
			absorb(cleanProp(a.data));
		}
		return a;
	}

	// ── The compose box: two ways to post, both auto-send ──────
	//
	// One box, two verbs. "Post" sends the words as they are; "Polish & post" has
	// the model rewrite them into a proposal first. NEITHER keeps -- both queue the
	// note and immediately try to send it, so the only holding area is the queue,
	// and only for a note that could not go yet. A note remembers which verb made
	// it, so a reconnect flush sends it the way its author chose.

	/// Post the box, in one of the two modes. Queues the note, then -- if the
	/// browser is online -- tries to send it at once. If the send does not go (or
	/// the browser is offline) the note stays in the queue and the reconnect flush
	/// will take it later.
	async function submit(mode) {
		var text = outgoing();
		if (!text) { flash(tOr('social.nothing', 'Write something first.')); return null; }
		// A verbatim post needs a first line to be its title; a polished one does
		// not, because the model writes the title.
		if (mode !== 'polish' && !split(text)) {
			flash(tOr('social.no_title', 'First line is the title — write one, then what happened.'));
			return null;
		}
		if (!hasVoice()) { flash(tOr('social.novoice_set', 'No voice yet — set one in Settings to post.')); return null; }
		var rec = store(text, mode);
		clearBox();
		render();
		if (onLine()) { await sendOne(rec); }
		render();
		return rec;
	}

	/// Send one queued note, in its own mode. Verbatim goes straight through the
	/// door; polish runs the model first and posts what it drafted.
	async function sendOne(rec) {
		var cur = find(rec.id);
		if (!cur) return false;					// already gone
		return (cur.mode === 'polish') ? await sendPolished(cur) : await sendVerbatim(cur);
	}

	async function sendVerbatim(rec) {
		var parts = split(rec.text);
		if (!parts) { flash(tOr('social.no_title', 'First line is the title — write one, then what happened.')); return false; }
		// The build is the note's OWN, captured when it was written -- not whatever
		// the live "what goes with it" row happens to say now. `split` reads the live
		// row, so its build is overwritten here.
		parts.build = rec.build || '';
		var a = await through(rec, parts);
		if (!a.ok) flash(keptAfter(a));
		return a.ok;
	}

	/// Polish one note into a proposal with the model, then post it. The drafting
	/// is js/triage.js's, the one place the model machinery and its metering live;
	/// this posts what it drafted through the same door a verbatim note leaves by.
	/// A failure -- no model, offline, an unreadable answer -- leaves the note in
	/// the queue for the next flush.
	async function sendPolished(rec) {
		var got = null;
		try { if (window.DaimondTriage && DaimondTriage.polish) got = await DaimondTriage.polish(rec.text); }
		catch (e) { got = null; }
		if (!got || !got.title) {
			flash(tOr('social.polish_wait', 'The model could not draft it just now; it is still waiting to send.'));
			return false;
		}
		var a = await through(rec, { title: got.title, body: got.body || '', build: rec.build || '' });
		if (!a.ok) flash(keptAfter(a));
		return a.ok;
	}

	/// Send one queued note now, by id -- the queue row's own "Send now". The same
	/// one act the flush makes, from a press instead of from a reconnect.
	async function resend(id) {
		var rec = find(id);
		if (!rec) return false;
		if (!hasVoice()) { flash(tOr('social.novoice_set', 'No voice yet — set one in Settings to post.')); return false; }
		var ok = await sendOne(rec);
		render();
		return ok;
	}

	// ── Draining the queue when the browser comes back ─────────
	//
	// THE NET-NEW PIECE. A note written offline (or one whose send failed) waits in
	// the queue; when the browser fires `online`, js/daimond.js calls this and every
	// waiting note is sent in the mode it was written in -- a polish note drafts on
	// reconnect, because the model needs the network too. One flush at a time, and
	// it stops the moment the browser drops again rather than throwing every note at
	// a dead forge.

	var _flushing = false;

	async function flushQueue() {
		if (_flushing || !onLine()) return { sent: 0, waiting: load().notes.length };
		if (!hasVoice()) return { sent: 0, waiting: load().notes.length };
		_flushing = true;
		var sent = 0;
		try {
			var q = load().notes.slice();		// a snapshot of ids; the list changes under us
			for (var i = 0; i < q.length; i++) {
				if (!onLine()) break;
				var rec = find(q[i].id);
				if (!rec) continue;				// taken meanwhile
				var ok = await sendOne(rec);
				if (ok) sent++;
			}
		} finally {
			_flushing = false;
			render();
		}
		return { sent: sent, waiting: load().notes.length };
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
					tOr('social.drop_ask', 'Delete this note? It is only here — no other copy.'),
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

	/// Tag a refusal with the act it refused, so `saying()` can say the sentence
	/// that act needs. A copy, because the caller's record is what is drawn and a
	/// tag written onto it in place would outlive the request that earned it.
	function onAmend(a) {
		if (!a || a.ok) return a;
		var out = {};
		Object.keys(a).forEach(function (k) { out[k] = a[k]; });
		out.on = 'amend';
		return out;
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
			// The one route where this refusal has a single cause worth naming. The
			// forge refuses a stranger's revision with `unpermitted` and writes
			// nothing, so the honest sentence is who may, not that somebody may not.
			if (a.on === 'amend') {
				return tOr('social.err_amend_unpermitted',
					'Only the person who opened this proposal may revise it.');
			}
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

	/// What the forge calls its per-asker "you may amend this" flag.
	///
	/// SETTLED, AND READ OFF THE DEPLOYED FORGE rather than guessed. Two lanes
	/// built this half against a forge that did not answer the flag yet, and each
	/// picked its own spelling -- `amend` and `may_amend` -- because a name nobody
	/// has published is a name everybody invents. Neither was right. The forge
	/// answers `mine_to_amend`, carried in `shared_dat` so it sits on the listing
	/// entry and on the whole proposal alike, and an unvoiced read of
	/// `/oxedyne/ore/proposals/20?format=json` carries no such key at all --
	/// confirmed against the deployed host on 2026-08-28.
	//
	// It is spelled beside `mine`, which is what it is a second of: `mine` is this
	// asker's vote and `mine_to_amend` is whether this proposal is this asker's to
	// revise. The gateway's own words are DIFFERENT WORDS on purpose -- `&amend=1`
	// in the query, `/amend` as the forge's route segment -- because those name the
	// ACT and this names a fact about the record.
	//
	// Held once so that the next rename is one line here rather than a search. The
	// fixtures do not get their own copy: dev/verify_triage.mjs takes the spelling
	// from this file, because a fixture answering the old key would keep a broken
	// client green.
	var AMEND_FLAG = 'mine_to_amend';

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
			// PRESENCE FIRST, NUMBER SECOND, and null where the answer was silent.
			// `whole()` would have turned an absent `changed` into 0, and a 0 here
			// is a real reading: "revised at the epoch", which is older than every
			// proposal there is. A panel that compared it would find either every
			// tile stale for ever or none of them ever, and both look exactly like a
			// cache that is not being invalidated -- which is the week somebody
			// spends before finding this line. Same rule as `mine`/`asked` and as
			// `mine_to_amend`/`askedAmend` below.
			changed:    (typeof p.changed === 'number') ? Math.max(0, whole(p.changed)) : null,
			mark:       (typeof p.mark === 'string') ? p.mark : '',
			build:      (typeof p.build === 'string') ? p.build : '',
			body:       (typeof p.body === 'string') ? p.body : '',
			discussion: null,
			// NULL WHERE THE ANSWER CARRIED NONE, and `[]` where it carried an empty
			// one, which are different facts: the listing does not answer this field
			// at all and the whole proposal always does, so `[]` means "read, and
			// never revised" and `null` means "not read yet". `absorb` keeps the
			// list across a listing record for the reason it keeps the body.
			revisions:  null,
			detail:     false,
			votes:      null,		// null: the answer carried no tally at all
			asked:      false,		// whether the answer carried `mine` at all
			mine:       null,
			askedAmend: false,		// whether the answer carried the amend flag at all
			amendable:  false,		// and, if it did, whether this asker may amend
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
		// A LIST, NOT A COUNT, and that is the whole of the care this needs. `comments`
		// beside it IS a count on both routes, so a reader working by analogy reaches
		// for `whole()` and gets `NaN` from an array -- or worse, a length that looks
		// like an answer. The forge answers `revisions` on the WHOLE PROPOSAL ONLY,
		// oldest first, EMPTY rather than absent where nothing has been amended.
		if (Array.isArray(p.revisions)) {
			rec.revisions = p.revisions.map(function (r) {
				return {
					title: (r && typeof r.title === 'string') ? r.title : '',
					body:  (r && typeof r.body  === 'string') ? r.body  : '',
					when:  Math.max(0, whole(r && r.when)),
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
		// PRESENCE FIRST, BOOLEAN SECOND, and the two are kept apart for the same
		// reason `mine` and `asked` are. The flag is ABSENT when no voice asked --
		// not `false` -- so a reader that tested only its truth would draw "you
		// may not amend this" at a person who was never asked, and would go on
		// drawing it after they set a voice. `hasOwnProperty`, so a `false` that
		// really was answered is still an answer.
		//
		// NOTHING ABOVE COERCES IT. Every other field on this record has a
		// defaulting cast, which is right for a value whose absence means
		// nothing; it is wrong for one whose absence IS the fact.
		if (Object.prototype.hasOwnProperty.call(p, AMEND_FLAG)) {
			rec.askedAmend = true;
			rec.amendable  = (p[AMEND_FLAG] === true);
		}
		return rec;
	}

	/// May this asker revise that proposal?
	///
	/// ONE PREDICATE FOR THE THREE PLACES THAT ASK, because the two halves have to
	/// be read together and any reader that forgets one of them is wrong in a way
	/// nothing shows: `amendable` alone offers the control to a proposal nobody was
	/// asked about, and `askedAmend` alone offers it to a voice that was told no.
	/// The exported `forge.mayAmend` is this same question by proposal number.
	function canAmend(rec) {
		return !!(rec && rec.askedAmend && rec.amendable);
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
			rec.revisions  = cur.revisions;
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

	// ── Revising one's own proposal ────────────────────────────
	//
	// THE SECOND DOOR ON THE SAME SEAM, and it was built dark for the reason the
	// vote control was: `drawAmendControl` draws only when the answer carried the
	// flag. The forge answers it now, and NOTHING IN THIS FILE CHANGED WHEN IT DID
	// -- which is the second time that shape has paid off here, and the argument for
	// gating a control on the answer rather than on a comment about a date.
	//
	// TWO QUESTIONS, KEPT APART. The forge's flag answers ONE thing -- is this
	// asker the person who opened the proposal -- and deliberately does not fold in
	// whether the proposal is still open. That second half is a UI opinion, it is
	// reversible, and this panel already holds `state`; asking the forge to answer
	// the combined question would entangle a decision anybody may change with a
	// fold rule that is replicated and cannot be. So the test is written as two:
	// `canAmend(rec) && rec.state === 'open'`.

	var _amending = {};			// proposal number -> the row is in amend mode

	/// Cut a proposal's own characters back into the two boxes an amendment is.
	///
	/// The inverse of `split()` and the same rule: what goes back on the wire is
	/// what is on the screen, so the boxes must open holding exactly what the
	/// record holds and nothing composed on the way in.
	function amendBoxes(n) {
		var row = document.querySelector('.imp-prop[data-prop="' + n + '"]');
		if (!row) return null;
		var title = row.querySelector('.imp-amend-title');
		var body  = row.querySelector('.imp-amend-body');
		if (!title || !body) return null;
		return { title: title, body: body };
	}

	/// Publish a revision of one's own proposal.
	///
	/// The same one rule as a note and a comment: what leaves is exactly the
	/// characters in those two boxes at the moment the button is pressed, and a
	/// refusal is SAID rather than queued -- the boxes keep their words so a person
	/// can read and copy them.
	///
	/// The field set is `title` and `body`, and that is the whole of it. Asserted
	/// rather than intended, for the reason `post` states: a fifth field must have
	/// to defeat a check.
	async function amend(n) {
		var rec = _by[n];
		if (!canAmend(rec)) return false;
		var box = amendBoxes(n);
		if (!box) return false;
		var title = String(box.title.value || '').trim();
		var body  = String(box.body.value || '');
		if (!title) { _list.err = null; flash(tOr('social.nothing', 'Write something first.')); return false; }
		if (!hasVoice()) { _list.err = { why: 'unvoiced' }; drawProps(); return false; }
		// THROUGH THE SAME DOOR THE TRIAGE PLAN USES. Two callers with their own idea
		// of the request shape is how two halves of a feature stop meeting, which is
		// what §0 of the contract records -- and this file had exactly that, twice
		// over, until the two `amend`s were found colliding.
		var a = await revise(n, { title: title, body: body });
		if (!a.ok) { _list.err = a; drawProps(); return false; }
		delete _amending[String(n)];
		try { if (drafts()) drafts().dropUnder(draftKey('amend', n)); } catch (e) { /* storage blocked */ }
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
		var a = await say(n, text);
		if (!a.ok) { _list.err = a; drawProps(); return false; }
		box.value = '';
		try { if (drafts()) drafts().drop(draftKey('reply', n)); } catch (e) { /* storage blocked */ }
		absorb(cleanProp(a.data));
		_list.err = null;
		drawProps();
		return true;
	}

	/// Put one comment on the wire. THE ONE DOOR a comment leaves by, whichever
	/// box it was read out of -- the reply box under an open proposal, or a
	/// drafted comment in the Notes view. A second caller with its own idea of
	/// the request shape is how two halves of a feature stop meeting, which is
	/// the fault §0 of the contract exists to record.
	///
	/// It takes the CHARACTERS and never the element: what leaves is decided by
	/// whoever read the screen, and that reading happens once, at the press.
	async function say(n, text) {
		var f = new URLSearchParams();
		f.set('said', text);
		return await ask(route('n=' + n), {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    f.toString(),
		});
	}

	/// Put a revision of one proposal on the wire. THE ONE DOOR a revision leaves
	/// by, whichever screen read it -- the boxes under an open proposal, or a
	/// revision draft in the triage plan. `post` and `say` are its siblings and it
	/// is named apart from them for the same reason they are named apart from
	/// `send` and `comment`: a door takes CHARACTERS somebody else read, and the
	/// panel action that read them is `amend` below.
	///
	/// IT WAS CALLED `amend` AND THAT WAS A DEFECT. Two lanes built the two halves
	/// of this seam a fortnight apart, each declared `async function amend` in this
	/// one closure, and a function declaration does not collide -- it wins. The
	/// later one silently replaced the earlier, so pressing "Publish the revision"
	/// called this with no `parts` at all and threw on the first line. Nothing in
	/// either lane's own tests could see it, because each half was right.
	///
	/// The fields are a proposal's own: a revision restates the proposal, so it
	/// carries what opening one carries and the same cut applies -- `title` is the
	/// characters before the first newline, `body` the characters after it.
	async function revise(n, parts) {
		var f = new URLSearchParams();
		f.set('title', parts.title);
		f.set('body',  parts.body);
		var a = await ask(route('n=' + n + '&amend=1'), {
			method:  'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body:    f.toString(),
		});
		// A REFUSAL IS NAMED WHERE IT HAPPENED, AT THE DOOR, so both callers get the
		// sentence without either of them remembering to ask for it. `unpermitted` on
		// this route has one cause and only one -- somebody else opened this proposal
		// -- and `saying()` cannot know that from the token alone. Untagged it reads
		// "Your voice may not do that here", which is true of nine routes and useless
		// on this one.
		return a.ok ? a : onAmend(a);
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

	/// One line of text in a `div`, its text set as textContent so nothing here is
	/// ever markup. The queue head and the Settings sections are drawn with it.
	function line(cls, text) {
		var d = document.createElement('div');
		d.className = cls;
		d.textContent = text;
		return d;
	}

	/// The queue: notes that could not be sent yet, newest first. Empty when there
	/// is nothing waiting, so the compose box sits straight above the proposals in
	/// the ordinary case; it fills only when a send did not go -- offline, or a
	/// forge that refused. Each row shows the words, how it will be sent, and offers
	/// a Send-now and a Delete. The reconnect flush drains it on its own.
	function drawQueue() {
		var host = el('improve-queue');
		if (!host) return;
		var q = load().notes.slice();
		host.innerHTML = '';
		if (!q.length) return;

		host.appendChild(line('imp-asat imp-queue-head', tnOr('social.queue', q.length,
			'Waiting to send ({n})', 'Waiting to send ({n})', { n: q.length })));

		q.forEach(function (n) {
			var row = document.createElement('div');
			row.className = 'imp-note imp-queue-row';
			row.dataset.note = n.id;

			var text = document.createElement('div');
			text.className = 'imp-note-text';
			text.textContent = n.text;
			row.appendChild(text);

			var foot = document.createElement('div');
			foot.className = 'imp-note-foot';

			var state = document.createElement('span');
			state.className = 'imp-note-state';
			state.dataset.state = 'waiting';
			state.textContent = (n.mode === 'polish')
				? tOr('social.q_polish', 'Waiting to polish and post')
				: tOr('social.q_verbatim', 'Waiting to post');
			foot.appendChild(state);

			if (hasVoice()) {
				foot.appendChild(button('imp-note-send', 'improve-resend',
					tOr('social.send_now', 'Send now'),
					tOr('social.send_now_help', 'Try to send this one now, in the way it was written.')));
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
			host.appendChild(row);
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
	/// DARK UNTIL THE ANSWER CARRIES A TALLY, which it now does. The forge dispatches
	/// `proposals/<n>/vote` and both the listing and the whole record carry `votes`,
	/// checked against the deployed host on 2026-08-27 -- so this control draws, and it
	/// draws BECAUSE THE ANSWER CARRIES `votes` rather than because a date arrived.
	/// Nothing here changed when the forge started answering, which is the whole point
	/// of gating a control on the answer. This comment said "the vote route is not built
	/// there yet" until 2026-08-28: it was the FOURTH site of the claim the file header
	/// records correcting three of, and it was missed because it reads as a note about
	/// the branch below rather than as a claim about the forge.
	///
	/// The branch below is still right and still cheap. A record with no `votes` key at
	/// all draws nothing -- not a disabled button, not a zero.
	///
	/// This is NOT the test §9 warns a client off. That warning is against
	/// treating an UNVOTED proposal as one with no tally: `votes` on a proposal
	/// nobody has voted on is `{"for":0,"against":0}`, the zero object, and it is
	/// drawn like any other. What is tested here is the key's ABSENCE, which
	/// under §9 cannot happen at all -- so the branch is unreachable against a
	/// conforming forge and costs nothing against one that stops being conforming.
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

	/// The amend control, which draws ONLY when the answer carried the flag.
	///
	/// DARK UNTIL THE FORGE ANSWERS, exactly as the vote control was until it did.
	/// The test is `=== true` and never `!p.amendable`, and the difference is the
	/// whole reason the forge leaves the field OUT rather than answering `false`:
	/// absent means no voice asked, `false` means a voice asked and is not the
	/// author, and a reader with no voice at all must never be shown a control that
	/// belongs to somebody. `null` cannot be read as an answer; a coerced `false`
	/// can, and would be the same bug wearing the right shape.
	///
	/// A SETTLED PROPOSAL IS THIS SIDE'S JUDGEMENT and is asked separately. The
	/// forge answers who the author is, which is a replicated fact; whether a
	/// declined proposal may still be revised is an opinion about a screen, and
	/// folding the two into one flag would put a reversible decision inside a fold
	/// rule that cannot be reversed.
	function drawAmendControl(p, into) {
		if (!canAmend(p)) return;
		if (p.state !== 'open') return;
		if (!_amending[String(p.n)]) {
			var acts = document.createElement('div');
			acts.className = 'imp-acts';
			acts.appendChild(button('imp-note-copy', 'improve-amend-open',
				tOr('social.amend', 'Revise this'),
				tOr('social.amend_help', 'Replace what this proposal says; everyone sees the new words.')));
			into.appendChild(acts);
			return;
		}
		var title = document.createElement('input');
		title.type = 'text';
		title.className = 'imp-box imp-amend-title';
		title.value = p.title;
		title.setAttribute('aria-label', tOr('social.amend_title_ph', 'The one line this proposal is about'));
		title.placeholder = tOr('social.amend_title_ph', 'The one line this proposal is about');
		into.appendChild(title);
		try { if (drafts()) drafts().bind(title, draftKey('amend', p.n, 'title')); } catch (e) { /* storage blocked */ }

		var body = document.createElement('textarea');
		body.className = 'imp-box imp-amend-body';
		body.rows = 4;
		body.value = p.body;
		body.setAttribute('aria-label', tOr('social.amend_body_ph', 'What happened, and what was expected instead'));
		body.placeholder = tOr('social.amend_body_ph', 'What happened, and what was expected instead');
		into.appendChild(body);
		try { if (drafts()) drafts().bind(body, draftKey('amend', p.n, 'body')); } catch (e) { /* storage blocked */ }

		var row = document.createElement('div');
		row.className = 'imp-acts';
		row.appendChild(button('imp-send', 'improve-amend-save',
			tOr('social.amend_save', 'Publish the revision'),
			tOr('social.amend_save_help', 'Sends exactly these two boxes. Nothing else.')));
		row.appendChild(button('imp-keep', 'improve-amend-cancel', t('common.cancel')));
		into.appendChild(row);
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
			// AN EMPTY LIST SAYS NOTHING HERE, and that is not the same as saying
			// nothing about it: `[]` is the forge's answer that this proposal has
			// never been revised, `null` is a listing record that was never asked.
			// Drawing "revised 0 times" would be reporting a fact nobody wanted; the
			// two silences differ where it matters, in `revisions` itself.
			if (p.revisions && p.revisions.length) {
				parts.push(tnOr('social.revised_n', p.revisions.length,
					'revised once', 'revised {n} times', { n: p.revisions.length }));
			}
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
					'A note follows its content across files only when the change counts as a move — the floor is '
					+ '64 bytes. Cut less, and the history holds a delete and an insert, so the note reports its '
					+ 'content deleted.');
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
			// A REVISION CHANGES ITS TILE IN PLACE AND NEVER FLOATS TO THE TOP, and
			// nothing here sorts. `_order` is the walk's order, which is the forge's:
			// proposal number descending, with `from` a CEILING on the number rather
			// than a since-cursor, because an offset does not stay stable while new
			// proposals arrive. `changed` orders nothing, filters nothing and pages
			// nothing -- the forge never consults it and neither does this.
			//
			// Anybody minded to add "recently revised first" here should not: a
			// re-sort inside a page is right within the page and wrong across pages,
			// and the symptom is indistinguishable from a stale cache. It would also
			// be the wrong behaviour -- a revision is a correction to something
			// already said, not new news, so a triage pass that revised eight
			// proposals would bury everything genuinely new underneath them.
			drawAmendControl(p, body);

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
				// The redraw is already survived by `typed` above. THE RELOAD is what
				// this adds, and it is the same words and the same loss: a reply
				// three sentences in, and a refresh takes it. Bound after the row is
				// in the tree so a restored value is on screen rather than on a node
				// nobody has attached.
				try { if (drafts()) drafts().bind(reply, draftKey('reply', p.n)); } catch (e) { /* storage blocked */ }
				var acts = document.createElement('div');
				acts.className = 'imp-acts';
				acts.appendChild(button('imp-send', 'improve-comment',
					tOr('social.reply', 'Say it'),
					tOr('social.reply_help', 'Sends exactly this box. Nothing else.')));
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

	/// The Settings view: the voice this device posts with, and the drafts the
	/// model prepared. Both used to sit beside the compose box; the owner moved them
	/// out so the box is just a box (#7). `drawVoice` fills the voice section;
	/// "Forget this plan" clears anything the model drafted that has not been sent.
	function drawSettings() {
		var host = el('improve-settings');
		if (!host) return;
		host.innerHTML = '';

		host.appendChild(line('imp-with-label imp-set-head', tOr('social.set_voice', 'Your voice')));
		drawVoice();

		host.appendChild(line('imp-with-label imp-set-head', tOr('social.set_drafts', 'Prepared drafts')));
		host.appendChild(line('imp-as imp-set-note', tOr('social.set_drafts_note',
			'Forgets any proposals the model drafted from your notes that you have not sent. '
			+ 'Your notes waiting to send are not touched.')));
		var acts = document.createElement('div');
		acts.className = 'imp-acts';
		acts.appendChild(button('imp-note-copy', 'improve-forget-plan',
			tOr('social.triage_clear', 'Forget this plan'),
			tOr('social.triage_clear_help', 'Clear the drafts. Nothing is sent.')));
		host.appendChild(acts);
	}

	function render() {
		bindNoteBox();
		drawContext();
		drawAs();
		drawQueue();
		// The approve-list draws only where its host exists; with the Notes view
		// gone it is dormant, but kept called so a build that restores a batch
		// surface needs no change here. Same for the triage row.
		try { if (window.DaimondApproveList) DaimondApproveList.draw(); } catch (e) { log('the approve-list would not draw', e); }
		try { if (window.DaimondTriage) DaimondTriage.draw(); } catch (e) { log('the triage row would not draw', e); }
		drawProps();
		drawSettings();
	}

	// ── WHAT IS HALF-WRITTEN SURVIVES A RELOAD ─────────────────
	//
	// A screen refresh used to empty the note box, and the words were gone with
	// nothing anywhere saying anything had been lost. Reported by the owner:
	// "I would expect all live text input to persist."
	//
	// THIS IS NOT THE QUEUE §4 FORBIDS, and the reasoning is in `drafts.js`'s
	// header rather than restated here. In one line: nothing is kept for later
	// SENDING, because nothing here sends -- `outgoing()` still reads the box at
	// the moment of the press, and restoring the box is what puts the words in
	// front of the person who has to press it. The draft is dropped by every
	// path that empties the box, so a sent note is never also a draft of itself.

	function drafts() { return window.DaimondDrafts || null; }

	/// The key one box's draft is kept under. Namespaced by SURFACE, so that
	/// `dropUnder` can forget everything belonging to one proposal when it is
	/// gone without knowing how many boxes that proposal drew.
	function draftKey() {
		var parts = ['social'];
		for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
		return parts.join('/');
	}

	function bindNoteBox() {
		var d = drafts(), box = el('improve-box');
		if (d && box) d.bind(box, draftKey('note'));
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
	// The panel is Social. It holds five things -- Messages, People, Share,
	// Proposals, Settings. Note-capture MERGED INTO PROPOSALS: the standalone Notes
	// view is gone, its compose box now sits at the top of the Proposals view, and
	// Settings is the new fifth. It defaults to Proposals, which is where a person
	// both writes and reads.
	//
	// The count is deliberately not in the heading. A heading that names a number
	// goes stale the next time somebody adds a chip, and the panel is the only
	// honest count.
	//
	// The views are looked up by NAME rather than listed twice: a chip is a
	// `data-view` on the head and an element id in the table below, and a sixth
	// chip is one line here.

	var VIEWS = {
		messages:  'social-messages',
		people:    'social-people',
		// js/share.js renders into `#social-share-list` the way post.js renders
		// into the messages list; this file shows and hides it and nothing more.
		share:     'social-share',
		proposals: 'improve-props-view',
		// This file's own, drawn by `drawSettings`: the voice and the drafts.
		settings:  'social-settings',
	};

	var _view = 'proposals';

	/// Callbacks a lane registers to be told its own view was opened, so it can
	/// read what it needs LAZILY. Ten chips resolved on panel open is ten
	/// requests nobody asked for.
	var _watch = [];

	function show(view) {
		_view = VIEWS[view] ? view : 'proposals';
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
		} else if (_view === 'settings') {
			drawSettings();
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
		// Opening the panel is a good moment to drain anything that could not be
		// sent while it was shut, so a queue does not sit full when the network is
		// plainly back. The reconnect event is the main path; this is the belt.
		if (onLine()) { try { flushQueue(); } catch (e) { /* best effort */ } }
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
		if (act === 'improve-post')   { e.preventDefault(); submit('verbatim'); return; }
		if (act === 'improve-polish') { e.preventDefault(); submit('polish'); return; }
		if (act === 'improve-more')   { e.preventDefault(); loadList(true); return; }
		if (act === 'improve-forget-plan') {
			e.preventDefault();
			try { if (window.DaimondTriage) DaimondTriage.clear(); } catch (err) { /* no triage in this build */ }
			try { if (window.DaimondApproveList) DaimondApproveList.clear(); } catch (err) { /* no queue */ }
			return;
		}
		if (act === 'improve-voice-get')    { e.preventDefault(); provision(false); return; }
		if (act === 'improve-voice-reissue'){ e.preventDefault(); reissueVoice(); return; }
		if (act === 'improve-voice-open')   { e.preventDefault(); _voiceOpen = true; _voiceAlready = false; drawVoice(); return; }
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
			if (act === 'improve-amend-open')   { e.preventDefault(); _amending[String(n)] = 1; drawProps(); return; }
			if (act === 'improve-amend-cancel') {
				e.preventDefault();
				delete _amending[String(n)];
				// Cancelling is a decision not to revise, so the revision goes with it.
				// A draft that survived Cancel would reappear the next time the control
				// was opened, which is the app arguing with a person who said no.
				try { if (drafts()) drafts().dropUnder(draftKey('amend', n)); } catch (err) { /* storage blocked */ }
				drawProps();
				return;
			}
			if (act === 'improve-amend-save')   { e.preventDefault(); amend(n); return; }
		}
	});

	// The row that says what goes with a note is a PREVIEW of the line, kept in
	// step while somebody is looking at it. What travels is redrawn and read at
	// the press, in `outgoing()`, so being late here costs a stale preview and
	// never a stale note.
	//
	// `daimond:layout` and `daimond:theme` used to be in this list and NOTHING IN
	// THE TREE HAS EVER DISPATCHED EITHER -- `setTheme` in daimond.js writes the
	// palette and says nothing, and the layout engine's `apply()` runs on every
	// panel open with no announcement. So the two facts most likely to move under
	// an open panel were the two this row never heard about, which is the defect
	// the redraw in `outgoing()` closes.
	try { window.addEventListener('resize', function () { if (!contextOff()) drawContext(); }); }
	catch (e) { /* no window */ }

	// And on the way to the button. A hand coming back to this panel to press Send
	// passes through it, so the last state of the preview a person can read is the
	// state that was in force when they pressed.
	['pointerdown', 'focusin'].forEach(function (ev) {
		try {
			document.addEventListener(ev, function (e) {
				var t = e.target;
				if (!t || typeof t.closest !== 'function' || !t.closest('#panel-social')) return;
				if (!contextOff()) drawContext();
			}, true);
		} catch (err) { /* no document */ }
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
		/// THE DAIMON'S DOOR ONTO THIS PANEL, which the engine binds to by this
		/// name (`src/wasm/social.rs`). Three methods and the split between them
		/// is the point; the section above `socialRead` says why.
		///
		/// ON THE PANEL'S OWN OBJECT and not on a second global beside it. The
		/// first draft of this lane installed `window.DaimondSocial` afresh and
		/// clobbered everything above -- `Panels.show('social')` calls `onOpen()`
		/// with no guard on the method, so the panel threw on its first open. A
		/// surface has one object; what a model may do with it is part of it.
		read:    socialRead,
		compose: socialCompose,
		commit:  socialCommit,
		/// What is composed and not yet sent, for a verifier. A token nobody has
		/// approved is a publication that has not happened.
		drafts:  function () { return Object.keys(_drafts); },
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

	// ── The daimon's door onto this panel ──────────────────────
	//
	// WHY THIS EXISTS, WHICH IS NOT WHAT IT DOES. On 2026-08-24 two real daimons,
	// on two accounts and two different models, were each asked to do one side of
	// this panel's work -- one to report a defect in Daimond, one to find that
	// report and agree with it. Neither could reach the panel, and neither said
	// so. One told its user to go and open "Daimond's feedback/issue reporting
	// interface (typically accessible from a menu in the app)", which is this
	// panel, and which it had just failed to find. The other spent eighteen calls
	// searching the workspace for "where the Social panel stores its reports" and
	// finished by telling the user "The gateway isn't running." The gateway was
	// running.
	//
	// A working surface the model cannot reach is a surface the model will deny.
	// That rule is `Tool::FileShow`'s and it is written out in full in
	// `src/tools.rs`; this file is its second instance.
	//
	// THREE METHODS AND THE SPLIT BETWEEN THEM IS THE POINT.
	//
	//   read     answers what is on a view, in prose. Nobody is asked anything:
	//            the owner ruled on 2026-08-24 that seeing is immediate, because
	//            it is information and because a daimon that can see the panel
	//            stops denying the panel is there.
	//   compose  works out exactly what one act would put on the wire, and mints
	//            a token standing for those bytes. NOTHING IS SENT.
	//   commit   sends what a token holds, and only what it holds.
	//
	// COMPOSE AND COMMIT ARE TWO CALLS SO THAT CONSENT IS BOUND TO BYTES. The
	// user is shown what `compose` composed and answers about that; `commit`
	// sends that same payload. One call taking the model's arguments and asking
	// on the way past would mean the person approved a rendering and the app sent
	// a rebuild of it -- and the two part company at exactly the field somebody
	// would have wanted to see, the build identifier that travels with a note or
	// the title of the proposal a vote lands on.
	//
	// A TOKEN IS SPENT ONCE. Left spendable, a yes about one publication would be
	// a licence to publish it again, which is the per-host memory mistake this
	// panel must not repeat: what is being approved here is a payload, not a
	// destination.
	//
	// WHAT THIS FILE ANSWERS AND WHAT RUST ANSWERS. Every sentence about a
	// RECORD is composed here -- which proposals exist, their tallies, their
	// states, what a message says -- because this is where the record lives and
	// because a second renderer in Rust would disagree with the screen the user
	// is looking at the first time either changed. Every sentence that DECIDES
	// something is composed in Rust: the refusals about arguments, the refusal a
	// dispatched worker gets, and the question put to the user.

	var _drafts = Object.create(null);	// tokens minted by compose(), spent by commit()
	var _draftN = 0;
	var DRAFT_LIFE = 300000;			// five minutes for a person to read and answer

	/// Forget drafts nobody answered.
	///
	/// A DECLINED DRAFT IS NEVER TOLD SO. The engine discards the token when the
	/// user says no and there is no message back to here, so without this a
	/// refused publication would sit in memory with a live handle on it for as
	/// long as the tab is open. Nothing can reach one -- the engine composes a
	/// fresh draft each time -- but "nothing can reach it" is an argument about
	/// today's callers, and the payload is a public post in somebody's name.
	function sweepDrafts() {
		var cut = Date.now() - DRAFT_LIFE;
		Object.keys(_drafts).forEach(function (k) {
			if (!_drafts[k] || _drafts[k].at < cut) delete _drafts[k];
		});
	}

	/// The request, as the engine wrote it.
	function req(json) {
		try { return JSON.parse(String(json || '{}')) || {}; }
		catch (e) { return {}; }
	}

	/// A refusal a model reads and acts on. The opening word is what the fold's
	/// ledger reads (see `call_outcome` in src/tools.rs), so a refusal that did
	/// not open with it would be booked as work that was done.
	function no(why) { return 'Refused: ' + why; }

	/// Why the forge would not, said for a model rather than for the screen.
	///
	/// The nine tokens are the contract's and are stable; `saying()` beside this
	/// is prose for a person, translated eight ways and reworded whenever it
	/// reads badly. A model branching on that would branch on a translation.
	function whyNot(a) {
		var w = (a && a.why) || 'gateway';
		if (w === 'unvoiced') {
			return 'this account has no voice on the forge, so it cannot write there. '
				+ 'Tell the user: the Social panel has a control for setting one.';
		}
		if (w === 'unpermitted') {
			if (a && a.on === 'amend') {
				return 'only the person who opened that proposal may revise it, and this '
					+ 'account did not open it. The forge wrote nothing.';
			}
			return 'this account\'s voice is not allowed to do that on the forge.';
		}
		if (w === 'throttled') {
			return 'the forge is rate-limiting this account'
				+ (a.because ? ' (' + a.because + ')' : '') + '. Wait rather than retrying now.';
		}
		if (w === 'no_proposal' || w === 'absent') {
			return 'the forge has no such proposal. Read the proposals again -- the number may '
				+ 'have been wrong.';
		}
		if (w === 'offline')  return 'the request never reached the forge.';
		if (w === 'gateway')  return 'Daimond\'s gateway would not carry it'
			+ (a && a.status ? ' (' + a.status + ')' : '') + '.';
		return 'the forge answered \'' + w + '\'.';
	}

	/// One proposal as a model should read it: the number first, because that is
	/// what every later call is aimed with.
	function sayProp(p, full) {
		var out = '#' + p.n + '  ' + (p.title || '(no title)')
			+ '  [' + p.state + ']';
		if (p.votes) {
			out += '  ' + p.votes.for + ' for, ' + p.votes.against + ' against';
			if (p.asked && p.mine === 1)  out += ' (this account voted for it)';
			if (p.asked && p.mine === -1) out += ' (this account voted against it)';
		}
		if (p.author)   out += '  by ' + p.author;
		if (p.comments) out += '  ' + p.comments + ' comment' + (p.comments === 1 ? '' : 's');
		if (full && p.body) out += '\n' + p.body;
		if (full && p.discussion && p.discussion.length) {
			out += '\n--- discussion ---';
			p.discussion.forEach(function (d) {
				out += '\n' + (d.author || 'somebody') + ': ' + d.said;
			});
		}
		return out;
	}

	/// Read one view of the panel.
	///
	/// THE PANEL IS DRIVEN AND THEN READ, rather than a second request being made
	/// beside it. What the model is told is therefore what is on the user's
	/// screen -- which is the whole point of a daimon being able to see this at
	/// all, and it is also why a listing here can never drift from the listing
	/// somebody is looking at.
	async function socialRead(reqJson) {
		var r     = req(reqJson);
		var view  = String(r.view || 'proposals');
		var limit = Math.max(1, Math.min(50, r.limit | 0 || 12));
		if (view === 'proposals') {
			var ok = await loadList(false);
			if (!ok) return no('nothing was read: ' + whyNot(_list.err));
			// A PAGE IS NOT A LISTING, and the difference only shows on a busy
			// repository. `loadList(false)` fetches PAGE records and the panel
			// offers a button for the rest; a tool call has no button, so a
			// daimon asking for 50 was answered with 25 and never saw the older
			// ones at all -- while this tool's own description tells it to read
			// the proposals first so it does not open a second one about
			// something already there. It could not.
			//
			// The walk is the PANEL'S walk, called again rather than written
			// again: every guard on it -- never `from=0`, stop on a short page,
			// stop on a page that did not descend -- is why a client of this
			// contract does not loop for ever, and a second walk here would be a
			// second set of them to keep right. Bounded by the limit, which the
			// schema caps at 50, so it is at most two more requests.
			var steps = 0;
			while (_order.length < limit && !_list.done && steps++ < 8) {
				if (!(await loadList(true))) break;
			}
			var rows = _order.slice(0, limit).map(function (n) { return sayProp(_by[n], false); });
			if (!rows.length) {
				return 'Nobody has proposed anything about Daimond yet. Yours would be the '
					+ 'first: social_send with act "propose".';
			}
			return 'What people have reported or asked for about Daimond, newest first '
				+ '(' + _list.total + ' in all, ' + rows.length + ' shown). Read one in full '
				+ 'with view "proposal" and its number; back one with social_send.\n\n'
				+ rows.join('\n');
		}
		if (view === 'proposal') {
			var n = r.n | 0;
			var got = await loadOne(n);
			if (!got) return no('nothing was read: ' + whyNot(_list.err));
			var p = _by[n];
			if (!p) return no('the forge answered about no proposal numbered ' + n + '.');
			return sayProp(p, true);
		}
		if (view === 'notes') {
			var notes = load().notes.slice(0, limit);
			if (!notes.length) {
				return 'This device has no notes waiting to send.';
			}
			return 'Notes waiting to send on this device (' + notes.length + '):\n\n'
				+ notes.map(function (rec) {
					return '[' + (rec.mode === 'polish' ? 'to polish & post' : 'to post') + ']  ' + rec.text;
				}).join('\n\n');
		}
		if (view === 'messages') {
			if (!window.DaimondPost) return no('this build has no messaging.');
			var msgs = (DaimondPost.list() || []).slice(0, limit);
			var tray = (DaimondPost.tray() || []).length;
			if (!msgs.length) {
				return 'This account\'s message list is empty.'
					+ (tray ? ' ' + tray + ' are waiting to be accepted, which only the user can do.' : '');
			}
			return 'Messages on this account (' + msgs.length + ' shown'
				+ (tray ? ', ' + tray + ' more waiting to be accepted' : '') + '):\n\n'
				+ msgs.map(function (m) {
					return (m.dir === 'out' ? 'to ' : 'from ')
						+ (m.dir === 'out' ? (m.to || m.gid || '?') : (m.from || '?'))
						+ ': ' + String(m.body || '').slice(0, 400);
				}).join('\n');
		}
		if (view === 'people') {
			if (!window.DaimondPost) return no('this build has no messaging.');
			var who = (DaimondPost.people() || []).slice(0, limit);
			if (!who.length) {
				return 'Nobody is in this account\'s directory yet, so there is nobody to write to.';
			}
			return 'People this account can reach (' + who.length + '):\n\n'
				+ who.map(function (p) { return (p.label || '(unnamed)') + '  [' + p.state + ']'; }).join('\n');
		}
		return no('\'' + view + '\' is not one of this panel\'s views.');
	}

	/// Work out what one act would publish, and mint a token standing for it.
	///
	/// The characters in `shown` are what the user is asked about, so everything
	/// that would travel is in them -- including the sealed build identifier,
	/// which the user's own box carries and which a person approving a report in
	/// their name is entitled to see before it goes.
	async function socialCompose(reqJson) {
		var r = req(reqJson);
		var act = String(r.act || '');
		if (!hasVoice()) {
			return JSON.stringify({ refusal: no('nothing was composed: this account has no voice '
				+ 'on the forge, so it cannot publish there. Tell the user, and say what you '
				+ 'wanted to publish -- the Social panel has a control for setting a voice.') });
		}
		var shown = '', payload = null;
		if (act === 'propose') {
			// The build identifier travels with a note the user sends, so it travels
			// with this one -- and it is therefore SHOWN. Consent to a report that
			// silently also names the build would be consent to something the person
			// did not read.
			var build = contextOff() ? '' : _build;
			payload = { act: 'propose', title: String(r.title || ''), body: String(r.body || ''), build: build };
			shown = 'A NEW PROPOSAL at ' + FORGE_HOST + ', under this account\'s voice name.\n\n'
				+ payload.title + '\n' + payload.body
				+ (build ? '\n\nand the build identifier ' + build : '');
		} else if (act === 'vote') {
			var n = r.n | 0;
			var p = _by[n];
			if (!p) {
				var got = await loadOne(n);
				if (!got) return JSON.stringify({ refusal: no('nothing was composed: ' + whyNot(_list.err)) });
				p = _by[n];
			}
			if (!p) return JSON.stringify({ refusal: no('there is no proposal numbered ' + n + '.') });
			var d = (r.d | 0);
			payload = { act: 'vote', n: n, d: d };
			shown = (d === 1 ? 'A VOTE FOR' : d === -1 ? 'A VOTE AGAINST' : 'TAKING BACK THE VOTE ON')
				+ ' proposal #' + n + ' at ' + FORGE_HOST + ', under this account\'s voice name.\n\n'
				+ (p.title || '(no title)')
				+ (p.votes ? '\n\nIt stands at ' + p.votes.for + ' for and ' + p.votes.against + ' against.' : '');
		} else if (act === 'comment') {
			var cn = r.n | 0;
			payload = { act: 'comment', n: cn, said: String(r.said || '') };
			shown = 'A COMMENT on proposal #' + cn + ' at ' + FORGE_HOST
				+ ', under this account\'s voice name.\n\n' + payload.said;
		} else {
			return JSON.stringify({ refusal: no('\'' + act + '\' is not an act this panel has.') });
		}
		var token = 'd' + (++_draftN) + '-' + Math.random().toString(36).slice(2, 10);
		_drafts[token] = { at: Date.now(), payload: payload };
		sweepDrafts();
		return JSON.stringify({ shown: shown, token: token });
	}

	/// Publish what a token holds. The token is spent whatever happens: a yes was
	/// a yes to ONE publication, and a failed send does not license a second
	/// attempt nobody was asked about.
	async function socialCommit(token) {
		sweepDrafts();
		var held = _drafts[String(token || '')];
		delete _drafts[String(token || '')];
		var d = held && held.payload;
		if (!d) {
			return no('nothing was published: that draft is not one this panel composed, or it '
				+ 'has already been sent. Compose it again, and the user will be asked again.');
		}
		if (d.act === 'propose') {
			var text = d.body ? (d.title + '\n' + d.body) : d.title;
			var rec  = store(text, 'verbatim');
			render();
			var a = await through(rec, { title: d.title, body: d.body, build: d.build });
			render();
			if (!a.ok) return no('nothing was published: ' + whyNot(a)
				+ ' The note is kept on this device and nothing was retried.');
			return 'Published as proposal #' + rec.n + ' on the Daimond forge. It is on the '
				+ 'user\'s Social panel now, and other people can read and vote on it.';
		}
		if (d.act === 'vote') {
			var body = voteBody(d.d);
			if (!body) return no('nothing was published: ' + d.d + ' is not a vote.');
			var av = await ask(route('n=' + d.n + '&vote=1'), {
				method:  'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body:    body,
			});
			if (!av.ok) { _list.err = av; drawProps(); return no('nothing was published: ' + whyNot(av)); }
			var pv = absorb(cleanProp(av.data));
			_list.err = null;
			drawProps();
			return 'The vote is cast on proposal #' + d.n + '. It now stands at '
				+ ((pv && pv.votes) ? (pv.votes.for + ' for and ' + pv.votes.against + ' against')
					: 'whatever the forge reports') + '.';
		}
		if (d.act === 'comment') {
			var f = new URLSearchParams();
			f.set('said', d.said);
			var ac = await ask(route('n=' + d.n), {
				method:  'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body:    f.toString(),
			});
			if (!ac.ok) { _list.err = ac; drawProps(); return no('nothing was published: ' + whyNot(ac)); }
			absorb(cleanProp(ac.data));
			_list.err = null;
			drawProps();
			return 'The comment is on proposal #' + d.n + ', where everybody reading it can see it.';
		}
		return no('nothing was published: that draft names no act.');
	}

	window.DaimondImprove = {
		onOpen:   onOpen,
		render:   render,
		show:     show,
		/// The two compose verbs, and the queue. Published so a verifier drives the
		/// same path a person does rather than a second one written for it.
		/// `submit('verbatim')` posts the words as they are; `submit('polish')` has
		/// the model rewrite them first. Both queue then try to send.
		submit:   submit,
		resend:   resend,
		drop:     drop,
		/// Drain the queue: send every waiting note in its own mode. Called by
		/// js/daimond.js on the browser's `online` event, and on panel open.
		flushQueue: flushQueue,
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
		/// Revising one's own proposal: the PANEL ACTION, which reads the two boxes
		/// under the open row. `forge.amend` below is the door it sends through.
		amend:    amend,
		/// What is drawn, for a verifier that wants the record rather than the
		/// pixels.
		proposal: function (n) { return _by[n] ? JSON.parse(JSON.stringify(_by[n])) : null; },
		listing:  function () { return { total: _list.total, shown: _order.slice(), done: _list.done, err: _list.err ? _list.err.why : '' }; },
		/// The store, for a verifier and for an account switch.
		notes:    function () { return load().notes.slice(); },
		/// Whether the forge holds this note's own characters, which is the one
		/// question the cap in `save()` turns on. Published so a verifier asks it
		/// rather than inferring it from which note survived.
		delivered: delivered,
		/// Mark notes as folded into a proposal a draft was written from. What
		/// js/triage.js calls after the forge took a draft, and nothing else.
		fold:     fold,
		/// THE FORGE, AS THIS PANEL REACHES IT, for the module that drafts from the
		/// whole list of notes at once.
		///
		/// One door and one copy of it. `route()`, `ask()` and `saying()` live
		/// here; the nine refusal wordings exist once, and a second module holding
		/// its own copy of them is a second copy to get wrong -- which is the same
		/// argument `DaimondRefs` is kept in this file by. Every function here
		/// takes CHARACTERS and returns the panel's own `{ ok, data }` or
		/// `{ ok: false, why }`.
		forge: {
			/// Open a proposal from a draft's own characters, already cut in two.
			open:    post,
			/// Say something on one proposal.
			say:     say,
			/// Revise one proposal, from characters somebody else read. The door
			/// `amend` sends through as well, so the panel and the triage plan
			/// cannot drift apart about what a revision is.
			amend:   revise,
			/// What a refusal says on the screen, in the reader's language.
			saying:  saying,
			/// The proposals as they are drawn, newest first. A copy, so nothing
			/// outside this file can move the record the panel is showing.
			props:   function () { return _order.map(function (n) { return _by[n] ? JSON.parse(JSON.stringify(_by[n])) : null; }).filter(Boolean); },
			/// Read the listing, and walk downwards through it.
			list:    loadList,
			/// Whether the forge has said this asker may revise proposal `n`.
			/// ABSENT is not false: a proposal nobody asked about answers `false`
			/// here and `false` from `askedAmend`, and the control is drawn on
			/// neither.
			mayAmend: function (n) { return canAmend(_by[n]); },
			/// Fold a forge answer into the panel's proposal store, and hand back the
			/// record it landed as.
			///
			/// A door PUTS a write on the wire and answers with the DETAIL SHAPE of the
			/// record it changed; the panel's own send, comment and vote each absorb
			/// that answer, so a DOOR CALLER must too. The approve-list's batch did not,
			/// and so a proposal it opened never entered `_by`/`_order` -- the Proposals
			/// view silently omitted every one the queue sent, which is why a run of
			/// eight drafts showed only the one proposal some other path had absorbed.
			/// Defended by `cleanProp`, so an answer shaped in a way this build does not
			/// know is dropped rather than drawn.
			absorb:   function (data) { return absorb(cleanProp(data)); },
		},
		// `_amending` with the rest: a row left in amend mode across an account
		// switch would offer somebody else's proposal with this account's boxes
		// already open on it.
		reset:    function () { _st = null; _by = {}; _order = []; _open = {}; _amending = {}; _list = { total: 0, lowest: null, done: false, loading: false, err: null, read: false }; },
	};
})();
