/* ============================================================
   Daimond — the Improve panel (improve.js)
   ------------------------------------------------------------
   Where a note is written, and where the proposals made from
   notes are read and voted on. `dev/IMPROVE_CONTRACT.md` is the
   contract; `www/guide/improve.html` is the public promise this
   panel has to keep, and every part of this screen is called what
   that page already calls it: a head, two chips, a closer, rows,
   and the note box.

   ── THE ONE RULE THIS FILE EXISTS TO KEEP ───────────────────

   A NOTE LEAVES THIS DEVICE ONLY WHEN A PERSON PRESSES SEND ON
   THAT ONE NOTE, AND WHAT LEAVES IS EXACTLY THE CHARACTERS ON
   THE SCREEN AT THAT MOMENT.

   Nothing about a note is queued, retried, batched or synced. A
   VOTE is two integers and may queue, because two integers cannot
   carry anything. Numbers may wait; words may not.

   `telemetry.js` keeps the same promise from the other side and
   the contrast is worth stating, because the two files look like
   opposites and are not. That one makes leaking impossible by
   SHAPE: its payload can only ever be integers, so no edit to it
   can carry a sentence. Free text has no shape to hide behind, so
   this file makes leaking impossible by ACT: there is no sender
   until the press, `send()` builds its body from the box and the
   one visible row and from nothing else, and the body IS the note
   -- no JSON envelope, because an envelope is somewhere a field
   can hide. What left is what you read, and dev/verify_improve.mjs
   asserts that by comparing the request against the screen.

   And a note that cannot be sent STAYS HERE AND SAYS SO. There is
   no retry: a queue of text outlives the consent that filled it,
   which is the failure telemetry.js refuses by not remembering
   consent at all. Copy is offered instead.

   ── WHAT GOES WITH A NOTE GOES IN THE NOTE ──────────────────
   The guide asks a user to say which build, which panel was open,
   whether they were on a phone, which palette they were wearing.
   That is gathered for them and shown as one line, in the exact
   characters that will be appended, in a row with a CLOSER on it.
   Closing the row takes the line off the screen and off the wire.
   There is no third state and nothing is gathered silently.

   Attaches one global, `window.DaimondImprove`.
   ============================================================ */
(function () {
	'use strict';

	// ── Saying things ──────────────────────────────────────────

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string with the English written at the call site as its fallback.
	///
	/// `t` answers with the KEY when the table has no entry, so a panel built
	/// against keys the locale files have not been given yet would read
	/// "improve.send" on screen. Every string this panel adds is new, and they
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

	// ── The store ──────────────────────────────────────────────
	//
	// One key, namespaced per account by accounts.js like every other
	// `daimond-*`. Notes are NOT in the sync parcel and are not coming: a note is
	// a report of a moment on the device it happened on, and making them travel
	// needs a merge rule this contract does not have.

	var KEY = 'daimond-improve';
	var MAX_NOTES = 200;			// past this the oldest KEPT note goes; sent ones stay
	var MAX_CHARS = 20000;			// what one note may be, matching the gateway's cap

	var _st = null;

	/// A millisecond stamp, or 0. Not `n | 0`: epoch-ms is past 32 bits.
	function ms(v) {
		return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0;
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
		};
	}

	/// One stored vote. `d` is 1 for "do this" and 2 for "not this"; anything
	/// else is not a vote and is dropped rather than guessed at.
	function cleanVote(r) {
		if (!r || typeof r !== 'object') return null;
		var d = (r.d === 1 || r.d === 2) ? r.d : 0;
		if (!d) return null;
		return { d: d, at: ms(r.at) || Date.now(), sent: r.sent ? 1 : 0 };
	}

	function load() {
		if (_st) return _st;
		_st = { notes: [], votes: {} };
		try {
			var raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
			(Array.isArray(raw.notes) ? raw.notes : []).forEach(function (n) {
				var c = cleanNote(n);
				if (c) _st.notes.push(c);
			});
			var votes = raw.votes || {};
			Object.keys(votes).forEach(function (id) {
				var c = cleanVote(votes[id]);
				if (c) _st.votes[String(id)] = c;
			});
		} catch (e) { _st = { notes: [], votes: {} }; }
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
		try { localStorage.setItem(KEY, JSON.stringify({ v: 1, notes: s.notes, votes: s.votes })); }
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
		if (_build) bits.push(tOr('improve.ctx_build', 'Build {id}', { id: _build }));
		try {
			var loc = window.DaimondI18n ? DaimondI18n.locale() : '';
			if (loc) bits.push(loc);
		} catch (e) { /* no i18n */ }
		try { bits.push(window.innerWidth + '×' + window.innerHeight); } catch (e) { /* no window */ }
		try {
			var coarse = window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches;
			bits.push(coarse
				? tOr('improve.ctx_touch', 'touch')
				: tOr('improve.ctx_pointer', 'pointer'));
		} catch (e) { /* no matchMedia */ }
		try {
			var theme = localStorage.getItem('daimond-theme');
			var skin  = localStorage.getItem('daimond-skin');
			if (theme) bits.push(tOr('improve.ctx_palette', 'palette {name}', { name: theme + (skin ? ' ' + skin : '') }));
		} catch (e) { /* private mode */ }
		var panels = openPanels();
		if (panels.length) bits.push(tOr('improve.ctx_panels', 'panels open: {list}', { list: panels.join(', ') }));
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
	/// this and posts the result; nothing else contributes.
	function outgoing() {
		var box = el('improve-box');
		var body = box ? String(box.value || '').trim() : '';
		if (!body) return '';
		if (contextOff()) return body;
		var line = el('improve-with-text');
		var ctx  = line ? String(line.textContent || '').trim() : '';
		return ctx ? (body + '\n\n' + ctx) : body;
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

	/// Who a sent note goes as. An account's public handle, minted by the
	/// gateway; identity.js only ever copies it.
	///
	/// A user must never find out AFTERWARDS that their name went too, so this
	/// is beside the Send button and not in a help text.
	function handle() {
		try { return (window.DaimondIdentity && DaimondIdentity.handle()) || ''; }
		catch (e) { return ''; }
	}

	function drawAs() {
		var as = el('improve-as'), send = el('improve-send');
		if (!as) return;
		var h = handle();
		as.textContent = h
			? tOr('improve.as', 'Goes as @{handle}', { handle: h })
			: tOr('improve.as_none', 'You have no account, so a note can only be kept here.');
		// Without an account there is nothing to send AS, and the gateway would
		// refuse it. The button is hidden rather than shown-and-inert: a control
		// that does nothing when pressed teaches people to distrust every control.
		if (send) send.hidden = !h;
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
		if (!text) { flash(tOr('improve.nothing', 'Write something first.')); return null; }
		var rec = store(text, 0);
		clearBox();
		render();
		return rec;
	}

	/// Send one note, and store it either way.
	///
	/// THE WHOLE OF WHAT LEAVES IS `text`, and `text` is what `outgoing()` read
	/// off the screen. `text/plain`, no envelope, no query string, no header
	/// carrying anything -- so "what left is what you read" is a claim a verifier
	/// can settle by comparing two strings.
	///
	/// A failure is not retried and nothing is queued. The note is kept, the row
	/// says so, and Copy is there for a person who wants to carry it themselves.
	async function post(text) {
		var res;
		try {
			res = await fetch('/api/note', {
				method:      'POST',
				credentials: 'same-origin',
				headers:     { 'Content-Type': 'text/plain; charset=utf-8' },
				body:        text,
			});
		} catch (e) { return false; }			// offline, or no gateway in this build
		return !!(res && res.ok);
	}

	async function send() {
		var text = outgoing();
		if (!text) { flash(tOr('improve.nothing', 'Write something first.')); return null; }
		if (!handle()) { flash(tOr('improve.as_none', 'You have no account, so a note can only be kept here.')); return null; }
		var rec = store(text, 0);
		clearBox();
		render();
		var ok = await post(text);
		if (ok) { rec.sent = Date.now(); save(); }
		else flash(tOr('improve.not_sent', 'It could not be sent, so it is kept here. Nothing has gone anywhere.'));
		render();
		return rec;
	}

	/// Send a note that is already kept. The same one act, from the row instead
	/// of from the box, and it posts the note's stored characters unchanged.
	async function resend(id) {
		var s = load();
		var rec = s.notes.find(function (n) { return n.id === id; });
		if (!rec || rec.sent) return false;
		if (!handle()) { flash(tOr('improve.as_none', 'You have no account, so a note can only be kept here.')); return false; }
		var ok = await post(rec.text);
		if (ok) { rec.sent = Date.now(); save(); }
		else flash(tOr('improve.not_sent', 'It could not be sent, so it is kept here. Nothing has gone anywhere.'));
		render();
		return ok;
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
					tOr('improve.drop_ask', 'Delete this note? It is only on this device, so there is no other copy.'),
					tOr('improve.drop_ok', 'Delete'),
					{ title: tOr('improve.drop', 'Delete this note') });
			}
		} catch (e) { ok = true; }
		if (!ok) return false;
		s.notes.splice(i, 1);
		save();
		render();
		return true;
	}

	/// Put a note on the clipboard, so somebody with no account, or no gateway,
	/// can still carry their own report out by hand.
	async function copy(id) {
		var s = load();
		var rec = s.notes.find(function (n) { return n.id === id; });
		if (!rec) return false;
		try { await navigator.clipboard.writeText(rec.text); }
		catch (e) { flash(t('copy.failed')); return false; }
		flash(tOr('improve.copied', 'Copied.'));
		return true;
	}

	/// One line under the box, for the answers that are not worth a dialog.
	function flash(text) {
		var n = el('improve-say');
		if (!n) return;
		n.textContent = text;
		clearTimeout(flash._t);
		flash._t = setTimeout(function () { if (n.textContent === text) n.textContent = ''; }, 6000);
	}

	// ── Proposals ──────────────────────────────────────────────
	//
	// Read from `assets/proposals.json`, which SHIPS WITH THE BUILD. There is no
	// live tally and none is wanted: a tally served on request is a service that
	// must answer for ever and be right, where a tally shipped with the build is
	// a fact with a date on it that is still true on an aeroplane. The panel says
	// which build the counts are from, in a line, so nobody reads them as live.
	//
	// UNDER `assets/`, and not at the app root, because that is where the service
	// worker's shell begins (`SHELL_DIRS` in sw.js). At the root it would be
	// fetched from the network every time and be missing from the one place the
	// whole design was chosen for -- a device with no connection. Read with the
	// ordinary cache for the same reason: the cache is keyed by build id, so the
	// answer it gives is this build's answer, which is exactly what is wanted.

	var _props = null;			// the parsed file, or null before the first read
	var _asAt  = '';			// the build those counts were taken at

	var STATES = { open: 1, taken: 1, done: 1, declined: 1 };

	function cleanProp(p) {
		if (!p || typeof p !== 'object') return null;
		var id = Number(p.id);
		if (!isFinite(id) || Math.floor(id) !== id || id < 1) return null;
		var title = (typeof p.title === 'string') ? p.title.trim() : '';
		if (!title) return null;
		return {
			id:    id,
			state: STATES[p.state] ? p.state : 'open',
			title: title,
			body:  (typeof p.body === 'string') ? p.body : '',
			from:  Math.max(0, Number(p.from) | 0),
			yes:   Math.max(0, Number(p.yes)  | 0),
			no:    Math.max(0, Number(p.no)   | 0),
			build: (typeof p.build === 'string') ? p.build : '',
		};
	}

	async function readProposals() {
		if (_props) return _props;
		var j = null;
		try {
			var r = await fetch('assets/proposals.json');
			if (r.ok) j = await r.json();
		} catch (e) { j = null; }		// no file in this build: an empty list, honestly
		_props = [];
		_asAt  = (j && typeof j.built === 'string') ? j.built : '';
		var list = (j && Array.isArray(j.proposals)) ? j.proposals : [];
		list.forEach(function (p) { var c = cleanProp(p); if (c) _props.push(c); });
		// Open first, then what is being done, then what is finished. Within each,
		// the ones most people asked for first: the list's whole job is to say
		// what is next.
		var rank = { open: 0, taken: 1, done: 2, declined: 3 };
		_props.sort(function (a, b) {
			return (rank[a.state] - rank[b.state]) || (b.yes - a.yes) || (a.id - b.id);
		});
		return _props;
	}

	/// What this device says about one proposal, or null.
	function myVote(id) { return load().votes[String(id)] || null; }

	/// Cast, or take back, a vote.
	///
	/// Pressing the side you already chose takes the vote off, which is the only
	/// way back and is what a pressed control that stays pressed has to offer.
	function vote(id, dir) {
		var s = load(), k = String(id), d = (dir === 'do') ? 1 : 2;
		if (s.votes[k] && s.votes[k].d === d) delete s.votes[k];
		else s.votes[k] = { d: d, at: Date.now(), sent: 0 };
		save();
		render();
		flushVotes();
		return true;
	}

	/// The build id as an integer, the way telemetry.js reads it: the first eight
	/// hex characters. It is how the operator maps a vote back to a release
	/// without a string going anywhere near the wire.
	function buildOrdinal(id) {
		if (typeof id !== 'string' || !/^[0-9a-f]{8}/.test(id)) return 0;
		var n = parseInt(id.slice(0, 8), 16);
		return isFinite(n) ? n : 0;
	}

	/// Is this vote integers all the way down?
	///
	/// The last gate before the wire, and the reason a vote is allowed to queue
	/// when a note is not. It is here so that an edit which adds a field to a
	/// vote has to defeat a check rather than merely forget one.
	function onlyIntegers(body) {
		if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
		var keys = Object.keys(body);
		var allowed = ['v', 'b', 'p', 'd'];
		for (var i = 0; i < keys.length; i++) {
			if (allowed.indexOf(keys[i]) === -1) return false;
		}
		return keys.every(function (k) {
			var x = body[k];
			return typeof x === 'number' && isFinite(x) && Math.floor(x) === x && x >= 0;
		});
	}

	var _flushing = false;

	/// Send every vote that has not been counted yet.
	///
	/// THIS IS ALLOWED TO QUEUE AND A NOTE IS NOT, and the asymmetry is the
	/// design rather than an oversight: there is nothing in `{v,b,p,d}` that
	/// could carry a syllable of anybody's work. Called when a vote is cast and
	/// when the panel opens, so a vote made on an aeroplane is counted on the
	/// ground without anybody having to press anything again.
	async function flushVotes() {
		if (_flushing) return false;
		var s = load();
		var pending = Object.keys(s.votes).filter(function (k) { return !s.votes[k].sent; });
		if (!pending.length) return false;
		_flushing = true;
		var moved = false;
		try {
			for (var i = 0; i < pending.length; i++) {
				var k = pending[i];
				var body = { v: 1, b: buildOrdinal(_build), p: Number(k), d: s.votes[k].d };
				if (!onlyIntegers(body)) continue;		// unreachable by construction
				var ok = false;
				try {
					var r = await fetch('/api/vote', {
						method:      'POST',
						credentials: 'same-origin',
						headers:     { 'Content-Type': 'application/json' },
						body:        JSON.stringify(body),
					});
					ok = !!(r && r.ok);
				} catch (e) { ok = false; }
				if (!ok) break;							// no gateway; the rest wait too
				s.votes[k].sent = 1;
				moved = true;
			}
		} finally { _flushing = false; }
		if (moved) { save(); render(); }
		return moved;
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
			none.textContent = tOr('improve.no_notes', 'No notes yet.');
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
				? tOr('improve.state_sent', 'Sent {date}', { date: fmtDate(n.sent) })
				: tOr('improve.state_kept', 'Kept here');
			foot.appendChild(state);

			if (!n.sent && handle()) {
				foot.appendChild(button('imp-note-send', 'improve-resend',
					tOr('improve.send', 'Send'),
					tOr('improve.send_help', 'Send exactly what is above to Oxedyne. Nothing else goes with it.')));
			}
			foot.appendChild(button('imp-note-copy', 'improve-copy', t('common.copy'), t('common.copy')));

			try {
				foot.appendChild(DaimondCloser.make({
					name: tOr('improve.drop', 'Delete this note'),
					cls:  'imp-note-drop',
					onClose: function () { drop(n.id); },
				}));
			} catch (e) {
				foot.appendChild(button('imp-note-drop', 'improve-drop', '×', tOr('improve.drop', 'Delete this note')));
			}

			row.appendChild(foot);
			list.appendChild(row);
		});
	}

	function stateWord(s) {
		if (s === 'taken')    return tOr('improve.state_taken', 'Being done');
		if (s === 'done')     return tOr('improve.state_done', 'Done');
		if (s === 'declined') return tOr('improve.state_declined', 'Declined');
		return tOr('improve.state_open', 'Open');
	}

	/// One proposal, as a row that opens what it names: a coloured dot, the
	/// title, and the tally as its value — the admin panel's shape exactly,
	/// which is what the guide's "row" entry describes.
	function drawProps() {
		var list = el('improve-props'), asAt = el('improve-asat');
		if (!list) return;
		// WHICH ROWS WERE OPEN SURVIVES THE REDRAW. Casting a vote redraws the
		// list, and the first build of this closed the proposal the user was
		// reading at the moment they pressed a button on it -- the answer
		// vanishing along with the question.
		var wasOpen = {};
		list.querySelectorAll('.imp-prop').forEach(function (r) {
			var body = r.querySelector('.imp-prop-body');
			if (body && !body.hidden) wasOpen[r.dataset.prop] = 1;
		});
		list.innerHTML = '';
		var props = _props || [];

		if (asAt) {
			asAt.textContent = props.length
				? (_asAt
					? tOr('improve.as_at', 'Counts as at build {build}. They move when Daimond updates.', { build: _asAt })
					: tOr('improve.as_at_none', 'Counts move when Daimond updates.'))
				: '';
		}

		if (!props.length) {
			var none = document.createElement('div');
			none.className = 'rail-note';
			none.textContent = tOr('improve.no_props',
				'No proposals yet. They are made from notes, and they arrive with a new build.');
			list.appendChild(none);
			return;
		}

		props.forEach(function (p) {
			var row = document.createElement('div');
			row.className = 'imp-prop';
			row.dataset.prop = String(p.id);
			row.dataset.state = p.state;

			var head = document.createElement('button');
			head.type = 'button';
			head.className = 'imp-prop-row';
			head.dataset.act = 'improve-open';
			head.setAttribute('aria-expanded', 'false');

			var dot = document.createElement('span');
			dot.className = 'imp-dot';
			dot.title = stateWord(p.state);
			head.appendChild(dot);

			var title = document.createElement('span');
			title.className = 'imp-prop-title';
			title.textContent = p.title;
			head.appendChild(title);

			var tally = document.createElement('span');
			tally.className = 'imp-prop-tally';
			tally.textContent = String(p.yes);
			tally.title = tOr('improve.tally', '{yes} for, {no} against', { yes: p.yes, no: p.no });
			head.appendChild(tally);
			row.appendChild(head);

			var body = document.createElement('div');
			body.className = 'imp-prop-body';
			body.hidden = !wasOpen[String(p.id)];
			head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');

			var says = document.createElement('p');
			says.className = 'imp-prop-says';
			says.textContent = p.body;
			body.appendChild(says);

			var facts = document.createElement('div');
			facts.className = 'imp-prop-facts';
			var parts = [stateWord(p.state)];
			if (p.from) parts.push(tnOr('improve.from_notes', p.from, 'From {n} note', 'From {n} notes', { n: p.from }));
			if (p.state === 'done' && p.build) {
				parts.push(tOr('improve.shipped_in', 'Shipped in build {build}', { build: p.build }));
			}
			parts.push(tOr('improve.tally', '{yes} for, {no} against', { yes: p.yes, no: p.no }));
			facts.textContent = parts.join(' · ');
			body.appendChild(facts);

			var mine = myVote(p.id);
			var votes = document.createElement('div');
			votes.className = 'imp-votes';
			[['do', tOr('improve.do', 'Do this')], ['not', tOr('improve.not', 'Not this')]].forEach(function (pair) {
				var b = button('imp-vote', 'improve-vote', pair[1], pair[1]);
				b.dataset.dir = pair[0];
				var want = pair[0] === 'do' ? 1 : 2;
				if (mine && mine.d === want) {
					b.classList.add('on');
					// A vote nobody has counted yet says so rather than looking
					// counted: the tally beside it is as at a build, and this one is
					// not in it.
					if (!mine.sent) {
						b.classList.add('held');
						b.title = tOr('improve.vote_held', 'Your vote is here and has not been counted yet.');
					}
				}
				votes.appendChild(b);
			});
			body.appendChild(votes);

			row.appendChild(body);
			list.appendChild(row);
		});
	}

	function render() {
		drawContext();
		drawAs();
		drawNotes();
		drawProps();
	}

	// ── The two chips on the head ──────────────────────────────

	var _view = 'notes';

	function show(view) {
		_view = (view === 'proposals') ? 'proposals' : 'notes';
		var n = el('improve-notes'), p = el('improve-props-view');
		if (n) n.hidden = (_view !== 'notes');
		if (p) p.hidden = (_view !== 'proposals');
		document.querySelectorAll('#panel-improve .imp-chip').forEach(function (c) {
			var on = c.dataset.view === _view;
			c.classList.toggle('on', on);
			c.setAttribute('aria-pressed', on ? 'true' : 'false');
		});
		if (_view === 'proposals') readProposals().then(drawProps, drawProps);
	}

	// ── Wiring ─────────────────────────────────────────────────

	/// The panel was opened. Proposals are re-read and any vote that has not
	/// been counted is offered again; the notes are already drawn.
	function onOpen() {
		readProposals().then(function () { drawProps(); flushVotes(); },
			function () { drawProps(); });
		render();
	}

	document.addEventListener('click', function (e) {
		var host = e.target && e.target.closest ? e.target.closest('#panel-improve') : null;
		if (!host) return;
		var chip = e.target.closest('.imp-chip');
		if (chip) { e.preventDefault(); show(chip.dataset.view); return; }
		var b = e.target.closest('[data-act]');
		if (!b) return;
		var act = b.dataset.act;
		if (act === 'improve-keep')   { e.preventDefault(); keep(); return; }
		if (act === 'improve-send')   { e.preventDefault(); send(); return; }
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
			if (act === 'improve-open') {
				e.preventDefault();
				var body = propEl.querySelector('.imp-prop-body');
				var shut = !body || body.hidden;
				if (body) body.hidden = !shut;
				b.setAttribute('aria-expanded', shut ? 'true' : 'false');
				return;
			}
			if (act === 'improve-vote') { e.preventDefault(); vote(propEl.dataset.prop, b.dataset.dir); return; }
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
	try { window.addEventListener('daimond:handle', drawAs); } catch (e) { /* no window */ }

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
		DaimondI18n.surface(function () { return document.getElementById('panel-improve'); },
			function () { render(); });
	} catch (e) { /* no i18n in this build */ }

	function start() {
		if (!el('panel-improve')) return;		// this build has no Improve panel
		readBuild().then(function () { render(); }, function () { render(); });
		show('notes');
		render();
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();

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
		/// The exact characters a Send would put on the wire right now. The
		/// verifier compares this against what actually left.
		outgoing: outgoing,
		/// Voting, and the queue that carries a vote made offline.
		vote:      vote,
		myVote:    myVote,
		flushVotes: flushVotes,
		onlyIntegers: onlyIntegers,
		/// The store, for a verifier and for an account switch.
		notes:    function () { return load().notes.slice(); },
		votes:    function () { return JSON.parse(JSON.stringify(load().votes)); },
		reset:    function () { _st = null; _props = null; },
	};
})();
