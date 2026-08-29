/* ============================================================
   Daimond — the approve-list (approvelist.js)
   ------------------------------------------------------------
   ONE PRESS SENDS THE ONES YOU TICKED. js/triage.js drafts a
   plan from the whole list of notes and hands the drafts HERE --
   it no longer has a send of its own. This is the ONE review
   surface: the drafts land in a QUEUE, each in a row a person can
   read, edit and tick, and one "Send selected" posts the ticked
   ones as a batch through improve.js's forge door.

   ── WHAT LEAVES IS STILL WHAT IS ON THE SCREEN ──────────────

   The rule js/improve.js and js/triage.js keep is kept here too:
   nothing leaves until a person presses a button beside the
   characters, and what leaves is exactly the characters in the
   box at the instant of the press. `boxed()` reads the textarea
   and nothing else -- not the record a draft was enqueued from --
   so an edit made in the queue is what is sent. A batch is still
   one press per SEND, not one press per draft: the person read
   every ticked row and pressed once, and the send reads each of
   those rows at the moment it posts it.

   ── THE QUEUE IS LOCAL, LIKE THE NOTES IT CAME FROM ─────────

   Drafts are ephemeral. They live under `daimond-approvelist`,
   which sync.js's `collectParcel` does not gather -- the parcel
   is an allowlist of named sources, so a key it was never told
   about is out of it by construction, the same way notes are
   (improve.js keeps notes out at its own store; this keeps drafts
   out for the same reason). A draft is a proposal not yet made;
   it belongs to the device the notes were written on until a
   person sends it.

   ── THE FORGE DOOR IS improve.js's, NOT A SECOND ONE ────────

   Every send goes through `DaimondImprove.forge` -- `open` for a
   new proposal, `say` for a comment, `amend` for a revision of
   the user's OWN proposal. This file holds no route, no voice
   header and no copy of the nine refusal wordings; `forge.saying`
   answers those. A revision amends the author's own proposal
   only: `forge.mayAmend(n)` gates it, and a row the forge has not
   granted offers no tick, exactly as the panel's own Revise
   control is dark until the forge answers.

   Attaches `window.DaimondApproveList`.
   ============================================================ */
(function () {
	'use strict';

	// ── Saying things ──────────────────────────────────────────

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string with the English written at the call site as its fallback, on
	/// the same terms improve.js and triage.js state: `t` answers with the KEY
	/// when the table has no entry, and every string this file adds is new.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return v[name] != null ? String(v[name]) : whole;
		});
	}

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[approve]'].concat([].slice.call(arguments))); }
		catch (e) { /* no console */ }
	}

	function el(id) { return document.getElementById(id); }

	function panel() { return window.DaimondImprove || null; }

	function hasVoice() {
		try { return !!(window.DaimondVoice && DaimondVoice.has()); } catch (e) { return false; }
	}

	// ── The store ──────────────────────────────────────────────
	//
	// One key, namespaced per account by accounts.js like every other
	// `daimond-*`. NOT in the sync parcel and not coming: a draft is a proposal
	// nobody has pressed Send on yet, and it belongs to the device the notes
	// were written on. See the header.

	var KEY = 'daimond-approvelist';
	var MAX = 200;					// a queue nobody empties cannot fill the quota

	var KINDS = { 'new': 1, comment: 1, revision: 1 };

	var _q   = null;				// the queue, loaded lazily
	var _busy = false;				// a batch send is in flight
	var _say  = '';					// one line under the control

	/// A whole number, or 0.
	function whole(v) {
		return (typeof v === 'number' && isFinite(v)) ? Math.floor(v) : 0;
	}

	/// One queued draft, defended against whatever was in storage or handed in.
	/// The same field shapes js/triage.js's `cleanDraft` produces, plus a queue
	/// id and the selected flag. Nothing here is drawn as markup.
	function cleanDraft(d) {
		if (!d || typeof d !== 'object') return null;
		var kind = (typeof d.kind === 'string') ? d.kind : '';
		if (!KINDS[kind]) return null;
		var n = whole(d.n);
		if ((kind === 'comment' || kind === 'revision') && n < 1) return null;
		var title = (typeof d.title === 'string') ? d.title.replace(/[\r\n]+/g, ' ').trim() : '';
		var body  = (typeof d.body  === 'string') ? d.body  : '';
		if (kind !== 'comment' && !title) return null;
		if (kind === 'comment' && !body.trim()) return null;
		var from = [];
		(Array.isArray(d.from) ? d.from : []).forEach(function (id) {
			if (typeof id === 'string' && id && from.indexOf(id) === -1 && from.length < 64) from.push(id);
		});
		return {
			id:    String(d.id || '') || ('d' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
			kind:  kind,
			n:     Math.max(0, n),
			title: title.slice(0, 300),
			body:  body.slice(0, 16000),
			from:  from,
			why:   (typeof d.why === 'string') ? d.why.slice(0, 400) : '',
			// Ticked to send. Off by default: a person chooses what leaves, and a
			// queue that arrived pre-ticked would send on the first press of a
			// button they had not read the rows above.
			sel:   d.sel === true,
			// The panel's own sentence about why a send did not go, drawn beside
			// the draft. A failed send stays in the queue with this set.
			err:   (typeof d.err === 'string') ? d.err.slice(0, 400) : '',
		};
	}

	function load() {
		if (_q) return _q;
		_q = [];
		try {
			var raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
			(Array.isArray(raw.drafts) ? raw.drafts : []).forEach(function (d) {
				var c = cleanDraft(d);
				if (c) _q.push(c);
			});
		} catch (e) { _q = []; }
		return _q;
	}

	function save() {
		var q = load();
		if (q.length > MAX) q.length = MAX;
		try { localStorage.setItem(KEY, JSON.stringify({ v: 1, drafts: q })); }
		catch (e) { log('could not write the queue', e); }
	}

	// ── Filling the queue ──────────────────────────────────────

	/// Add drafts to the queue. Takes js/triage.js's own draft shape (or the
	/// verifier's), cleans each, and drops a draft already queued whose content
	/// matches one on the list -- so pulling the same plan twice does not double
	/// it. Returns how many were added.
	function enqueue(drafts) {
		if (!Array.isArray(drafts)) return 0;
		var q = load(), added = 0;
		drafts.forEach(function (d) {
			var c = cleanDraft(d);
			if (!c) return;
			var dup = q.some(function (x) {
				return x.kind === c.kind && x.n === c.n && x.title === c.title && x.body === c.body;
			});
			if (dup) return;
			if (q.length >= MAX) return;
			q.push(c);
			added++;
		});
		if (added) { save(); draw(); }
		return added;
	}

	// ── Editing one row, in place ──────────────────────────────

	/// The characters in one draft's box, RIGHT NOW. The twin of triage's
	/// `boxed()` and improve.js's `outgoing()`: it reads the textarea and
	/// nothing else, so an edit made in the queue is what is sent.
	function boxed(id) {
		var box = document.querySelector('.apl-row[data-draft="' + cssId(id) + '"] .apl-box');
		return box ? String(box.value || '') : '';
	}

	/// A draft id, safe to put in a CSS attribute selector. Ids are minted from
	/// base36 above, so this is belt-and-braces against a hand-fed one.
	function cssId(id) { return String(id).replace(/["\\\]]/g, '\\$&'); }

	/// A draft cut into the two fields a proposal is made of. A cut and never an
	/// addition: `title + '\n' + body` is what was on screen.
	function cut(text) {
		var i     = text.indexOf('\n');
		var title = (i < 0) ? text : text.slice(0, i);
		var body  = (i < 0) ? ''   : text.slice(i + 1);
		if (!title.trim()) return null;
		return { title: title, body: body };
	}

	// ── Ticking, and taking one off ────────────────────────────

	function find(id) {
		var q = load();
		for (var i = 0; i < q.length; i++) if (q[i].id === String(id)) return q[i];
		return null;
	}

	/// Set whether a draft is ticked to send. A revision the forge has not
	/// granted can never be ticked: it would reach a route this asker may not
	/// use, which is the defect improve.js was rewritten to remove.
	function select(id, on) {
		var d = find(id);
		if (!d) return false;
		if (on && !sendable(d)) return false;
		d.sel = !!on;
		save();
		return true;
	}

	/// Tick, or untick, every row that CAN be sent.
	function selectAll(on) {
		load().forEach(function (d) { d.sel = on ? sendable(d) : false; });
		save();
		draw();
	}

	/// Take one draft off the queue. Nothing is sent and no note is touched.
	function remove(id) {
		var q = load();
		var i = q.findIndex(function (d) { return d.id === String(id); });
		if (i === -1) return false;
		q.splice(i, 1);
		save();
		draw();
		return true;
	}

	/// Empty the queue. The notes it was drafted from are where they were.
	function clear() {
		_q = [];
		save();
		_say = '';
		draw();
	}

	/// Whether this draft can be sent at all. A voice is needed for every write;
	/// a revision needs the forge to have said this asker may amend proposal `n`.
	function sendable(d) {
		if (!hasVoice()) return false;
		if (d.kind !== 'revision') return true;
		var p = panel();
		try { return !!(p && p.forge.mayAmend(d.n)); } catch (e) { return false; }
	}

	// ── The one press: send the ticked ones ────────────────────

	/// Send every ticked draft, in order, through improve.js's forge door.
	///
	/// THE BOXES ARE READ FIRST, all of them, before the first send -- because a
	/// send redraws the queue and a redraw replaces the textareas, so reading
	/// them as the batch went would read the characters off a row that had
	/// already been rebuilt. What is read is what is on the screen at the press.
	///
	/// A sent draft LEAVES the queue; a refused one STAYS, with the forge's own
	/// sentence beside it, and is never retried on its own. The notes a sent
	/// draft was written from are folded, which improve.js decides the meaning of.
	async function sendSelected() {
		var p = panel();
		if (!p || _busy) return null;
		var q = load();
		var picked = q.filter(function (d) { return d.sel && sendable(d); });
		if (!picked.length) {
			_say = tOr('approve.none_ticked', 'Tick a draft first.');
			draw();
			return null;
		}
		if (!hasVoice()) {
			_say = tOr('approve.novoice', 'No voice yet — a draft can only wait here.');
			draw();
			return null;
		}

		// Read every ticked row NOW, off the screen, before anything is sent.
		var batch = picked.map(function (d) { return { id: d.id, text: boxed(d.id) }; });

		_busy = true; _say = ''; draw();
		var sent = 0, failed = 0;
		try {
			for (var i = 0; i < batch.length; i++) {
				var d = find(batch[i].id);
				if (!d) continue;					// taken off the queue meanwhile
				var ok = await one(d, batch[i].text);
				if (ok) sent++; else failed++;
			}
		} finally {
			_busy = false;
			_say = tOr('approve.sent_batch', 'Sent {sent}. {failed} still waiting.',
				{ sent: sent, failed: failed });
			save();
			draw();
			// The notes list may now show a folded row; let the panel redraw it.
			try { p.render(); } catch (e) { draw(); }
		}
		return { sent: sent, failed: failed };
	}

	/// Send one draft. On success it leaves the queue and its notes are folded;
	/// on a refusal it stays, with the sentence the refusal earned. Returns
	/// whether it went.
	async function one(d, text) {
		text = String(text || '');
		var p = panel();
		if (!text.trim()) { d.err = tOr('approve.empty', 'Nothing to send.'); return false; }

		var a;
		if (d.kind === 'comment') {
			a = await p.forge.say(d.n, text);
		} else {
			var parts = cut(text);
			if (!parts) {
				d.err = tOr('approve.no_title', 'First line is the title — write one, then what happened.');
				return false;
			}
			a = (d.kind === 'revision') ? await p.forge.amend(d.n, parts) : await p.forge.open(parts);
		}

		if (!a || !a.ok) {
			d.err = p.forge.saying(a) + ' ' + tOr('approve.kept', 'Kept here; nothing tried again.');
			return false;
		}

		// The number the forge gave it: from the ANSWER, never assumed. A comment
		// and a revision land on the proposal they named; a new one on whatever
		// number the forge answered with.
		var num = Math.max(0, (a.data && typeof a.data.number === 'number') ? Math.floor(a.data.number) : 0) || d.n;
		try { if (num && d.from.length) p.fold(d.from, num); }
		catch (e) { log('the notes would not be marked', e); }
		remove(d.id);							// a sent draft leaves the queue
		return true;
	}

	// ── Drawing ────────────────────────────────────────────────
	//
	// Into `#improve-approve`, a sibling of `#improve-triage` under the note
	// box. Built here rather than in the markup on the same argument triage.js
	// and improve.js make: the markup is another lane's file and every part of
	// this list is drawn from this one anyway. The host is made if it is not
	// there, so the module needs no line in index.html beyond its <script>.

	function host() {
		var h = el('improve-approve');
		if (h) return h;
		var trg = el('improve-triage');
		var list = el('improve-list');
		var into = (trg && trg.parentNode) || (list && list.parentNode);
		if (!into) return null;
		h = document.createElement('div');
		h.className = 'imp-approve';
		h.id = 'improve-approve';
		// After the triage row, before the notes list: the queue reads as the
		// step between drafting and the notes it came from.
		if (list && list.parentNode === into) into.insertBefore(h, list);
		else if (trg && trg.nextSibling) into.insertBefore(h, trg.nextSibling);
		else into.appendChild(h);
		return h;
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

	function line(cls, text) {
		var s = document.createElement('div');
		s.className = cls;
		s.textContent = text;
		return s;
	}

	/// The word a draft's kind is read as, and what it promises.
	function kindWord(d) {
		if (d.kind === 'comment')  return tOr('approve.kind_comment', 'Comment on #{n}', { n: d.n });
		if (d.kind === 'revision') return tOr('approve.kind_revision', 'Revision of #{n}', { n: d.n });
		return tOr('approve.kind_new', 'New proposal');
	}

	/// The characters a draft's box starts with: the same cut, put back
	/// together, so what is read is what would leave.
	function bodyOf(d) {
		if (d.kind === 'comment') return d.body;
		return d.body ? (d.title + '\n' + d.body) : d.title;
	}

	function draw() {
		var h = host();
		if (!h) return;
		h.innerHTML = '';
		var q = load();
		if (!q.length) { _say = _say && _busy ? _say : ''; return; }

		h.appendChild(drawHead(q));
		if (_say) h.appendChild(line('rail-note apl-say', _say));
		q.forEach(function (d) { h.appendChild(drawRow(d)); });
	}

	/// The head: what the queue is, and the one press that sends the ticked ones.
	function drawHead(q) {
		var box = document.createElement('div');
		box.className = 'apl-head';

		var ticked = q.filter(function (d) { return d.sel && sendable(d); }).length;
		box.appendChild(line('imp-asat apl-count', tOr('approve.count',
			'{n} drafts waiting, {sel} ticked. Edit any, tick the ones to send.',
			{ n: q.length, sel: ticked })));

		var acts = document.createElement('div');
		acts.className = 'imp-acts apl-acts';

		var send = button('imp-send apl-send', 'approve-send',
			_busy ? tOr('approve.sending', 'Sending…')
				: tOr('approve.send', 'Send selected'),
			tOr('approve.send_help', 'Sends exactly the ticked drafts, each as it is in its box.'));
		if (_busy || !ticked) send.disabled = true;
		acts.appendChild(send);

		acts.appendChild(button('imp-note-copy apl-all', 'approve-all',
			tOr('approve.all', 'Tick all'),
			tOr('approve.all_help', 'Tick every draft that can be sent.')));
		acts.appendChild(button('imp-note-copy apl-none', 'approve-none',
			tOr('approve.clear_sel', 'Untick all')));
		acts.appendChild(button('imp-note-copy apl-clear', 'approve-clear',
			tOr('approve.clear', 'Empty the queue'),
			tOr('approve.clear_help', 'Remove every draft. Nothing is sent.')));

		box.appendChild(acts);
		return box;
	}

	/// One draft: a checkbox, what it is and where it lands, a box to edit it,
	/// and a way to take it off.
	function drawRow(d) {
		var row = document.createElement('div');
		row.className = 'apl-row';
		row.dataset.draft = String(d.id);
		row.dataset.kind  = d.kind;

		var head = document.createElement('div');
		head.className = 'apl-rowhead';

		var can = sendable(d);
		if (can) {
			var box = document.createElement('input');
			box.type = 'checkbox';
			box.className = 'apl-tick';
			box.checked = d.sel;
			box.dataset.act = 'approve-tick';
			box.setAttribute('aria-label', tOr('approve.tick', 'Send this one'));
			head.appendChild(box);
		}

		var kind = document.createElement('span');
		kind.className = 'apl-kind';
		kind.textContent = kindWord(d);
		head.appendChild(kind);

		// The target, said plainly: which proposal a comment or revision lands on.
		var target = document.createElement('span');
		target.className = 'imp-note-state apl-target';
		target.textContent = (d.kind === 'new')
			? tOr('approve.target_new', 'opens a new proposal')
			: tOr('approve.target_on', 'on proposal #{n}', { n: d.n });
		head.appendChild(target);

		row.appendChild(head);

		if (d.why) row.appendChild(line('imp-as apl-why', d.why));

		// A revision the forge has not granted: no tick, and a plain sentence
		// saying why, rather than a control that reaches a route this asker may
		// not use. Never a path that edits someone else's proposal.
		if (d.kind === 'revision' && !can && hasVoice()) {
			row.appendChild(line('imp-as apl-dark', tOr('approve.not_yours',
				'Only the proposal’s author can revise it.')));
		} else if (!hasVoice()) {
			row.appendChild(line('imp-as apl-novoice', tOr('approve.novoice',
				'No voice yet — a draft can only wait here.')));
		}

		var ta = document.createElement('textarea');
		ta.className = 'imp-box apl-box';
		ta.rows = d.kind === 'comment' ? 3 : 6;
		ta.value = bodyOf(d);
		ta.setAttribute('aria-label', kindWord(d));
		row.appendChild(ta);

		if (d.err) row.appendChild(line('rail-note imp-err apl-err', d.err));

		var acts = document.createElement('div');
		acts.className = 'imp-acts apl-rowacts';
		acts.appendChild(button('imp-note-copy apl-drop', 'approve-drop',
			tOr('approve.drop', 'Not this one'),
			tOr('approve.drop_help', 'Take this draft off the queue. Nothing is sent.')));
		row.appendChild(acts);

		return row;
	}

	// ── Wiring ─────────────────────────────────────────────────

	document.addEventListener('click', function (e) {
		var h = e.target && e.target.closest ? e.target.closest('#improve-approve') : null;
		if (!h) return;
		var b = e.target.closest('[data-act]');
		if (!b) return;
		var act = b.dataset.act;
		if (act === 'approve-send')  { e.preventDefault(); sendSelected(); return; }
		if (act === 'approve-all')   { e.preventDefault(); selectAll(true); return; }
		if (act === 'approve-none')  { e.preventDefault(); selectAll(false); return; }
		if (act === 'approve-clear') { e.preventDefault(); clear(); return; }
		var row = b.closest('.apl-row');
		if (!row) return;
		var id = row.dataset.draft;
		if (act === 'approve-drop') { e.preventDefault(); remove(id); return; }
	});

	// A tick is a change, not a click, and it must not redraw the row from under
	// the pointer: `select` records it and leaves the box alone. The head's count
	// is refreshed so "N ticked" and the Send button keep pace.
	document.addEventListener('change', function (e) {
		var box = e.target;
		if (!box || box.dataset.act !== 'approve-tick') return;
		var row = box.closest('.apl-row');
		if (!row) return;
		select(row.dataset.draft, box.checked);
		var h = el('improve-approve');
		if (h) {
			var head = h.querySelector('.apl-head');
			if (head) head.replaceWith(drawHead(load()));
		}
	});

	// Say this list's words again in a new language, on the same surface improve.js
	// and triage.js register -- a locale change redraws it with them.
	try {
		DaimondI18n.surface(function () { return el('improve-approve'); },
			function () { draw(); });
	} catch (e) { /* no i18n in this build */ }

	window.DaimondApproveList = {
		/// Drawn by improve.js's `render()`, beside the triage row, so the queue
		/// and the notes it counts can never disagree.
		draw:     draw,
		/// Add drafts (triage's own shape) to the queue. Returns how many landed.
		/// js/triage.js calls this after a run; it is the one way drafts arrive.
		enqueue:  enqueue,
		/// The one press: send every ticked draft as a batch through the forge
		/// door. Sent drafts leave; refused ones stay with an error.
		send:     sendSelected,
		/// Tick or untick one draft, or all.
		select:   select,
		selectAll: selectAll,
		/// Take one draft off, or empty the queue.
		remove:   remove,
		clear:    clear,
		/// The queue on screen, a copy, for a verifier or an account switch.
		queue:    function () { return JSON.parse(JSON.stringify(load())); },
		/// Whether a batch send is in flight.
		busy:     function () { return _busy; },
		/// For a verifier that wants a cold list.
		reset:    function () { _q = null; _busy = false; _say = ''; },
	};
})();
