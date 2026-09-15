/// report.js -- reporting one message, and only one message.
///
/// **The operator cannot read messages.** So when somebody is abused here there
/// is no log for anybody to look at: the only person who can produce the words
/// is the person they were sent to, and this file is them choosing to.
///
/// ## What leaves, and what does not
///
/// Four things go, and they are named on screen before anything moves:
///
///  1. the SIGNED MESSAGE -- the artefact, exactly as it arrived, carrying the
///     sender's signature over its own address;
///  2. the CIPHERTEXT -- the sealed envelope the relay carried, byte for byte;
///  3. the CONTENT KEY for that one envelope;
///  4. a reason, from the closed list the gateway serves;
///  5. and, for a group message alone, the group's signed ROSTER -- the only
///     thing that can show the operator this account was one of the people the
///     message was sealed to. See `send`.
///
/// The content key opens THAT envelope and nothing else. It is not the sealing
/// key of this device, it does not open the conversation, and it does not open
/// the next message from the same person. That granularity is the whole reason
/// this can exist without weakening the seal.
///
/// ## The one screen rule, borrowed from improve.js verbatim
///
/// **What leaves is exactly what is on screen at that moment.** So the sheet
/// does not draw the message out of the panel's own record; it decodes the
/// ARTEFACT it is about to upload and draws the body out of that. A screen
/// showing one string while another travels would be the worst possible defect
/// in this particular file, and this removes the possibility rather than
/// guarding against it.
///
/// ## What this file deliberately does not do
///
/// It does not decode, verify or re-address anything itself. The artefact is
/// read by `DaimondCrypto.read`, which is the format's own crate compiled to
/// wasm and the same reader post.js uses; a second reader written here would be
/// a second opinion about what a message says, in the one place where two
/// opinions must be impossible. It also does not block, hide or delete: those
/// are the panel's and they work whether or not anything is ever reported.
(function () {
	'use strict';

	/// The endpoint. A path of its own and not an `?op=` on the relay, because
	/// the relay's whole contract is that it cannot read what it carries, and
	/// this is the one place a message reaches the gateway on purpose.
	var API = '/api/report';

	/// The reasons, once the gateway has been asked. Null until then.
	var _reasons = null;

	/// Whatever sheet is open, so a second press does not stack two.
	var _open = null;

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A translated string, or the English written here when the key is missing.
	/// The same helper post.js carries, and for the same reason: a build whose
	/// locale files have not caught up shows English rather than a key.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return String(fallback);
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return Object.prototype.hasOwnProperty.call(v, name) ? String(v[name]) : whole;
		});
	}

	function log(/* ...args */) {
		if (window.DaimondDebug) {
			console.log.apply(console, ['[report]'].concat([].slice.call(arguments)));
		}
	}

	// ── Encoding ───────────────────────────────────────────────

	function b64dec(str) {
		var bin = atob(String(str));
		var out = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}

	// ── What a report is made of ───────────────────────────────

	/// The parts of a message this file needs, or the sentence saying which one
	/// is missing.
	///
	/// **Three fields post.js must keep on a collected message**, and they are
	/// named here rather than assumed because a build that does not keep them
	/// cannot report anything and must say so plainly:
	///
	///  * `art` -- the signed artefact, base64, as it came out of the envelope.
	///    Without it there is no signature, and a report with no signature is
	///    an accusation.
	///  * `env` -- the sealed envelope, base64, byte for byte as the relay
	///    handed it over.
	///  * `ck`  -- the content key that opened it, base64.
	///
	/// A message that has none of them is not reportable, and the honest thing
	/// to do about that is refuse and say why. Filing three quarters of a report
	/// would put a person's words on the operator's disk while giving them
	/// nothing to check them against, which is the exact failure the design
	/// exists to prevent.
	function partsOf(m) {
		if (!m || typeof m !== 'object') {
			return { why: tOr('report.err_no_message',
				'That message is not one this device holds.') };
		}
		if (!m.art) {
			return { why: tOr('report.err_no_artefact',
				'This build did not keep the signed form of that message, so there is '
				+ 'nothing to prove who sent it. A report without it would be an '
				+ 'accusation, so nothing was sent.') };
		}
		if (!m.env || !m.ck) {
			return { why: tOr('report.err_no_envelope',
				'This build did not keep the sealed form of that message, so the report '
				+ 'could not be checked against what the relay carried. Nothing was sent.') };
		}
		// `gid` IS NOT A FOURTH REQUIREMENT. It is empty for a one-to-one and is
		// the group's id for a group message, and `send` uses it to decide
		// whether a roster has to travel with the report. A row that has one and
		// no roster fails at `send` with a sentence, rather than here: the
		// roster lives in the group record and reading it is asynchronous, and a
		// control that could not be drawn until a store read finished would be a
		// control that flickers.
		return { art: String(m.art), env: String(m.env), ck: String(m.ck),
			gid: String(m.gid || '') };
	}

	/// The signed roster this device holds for a group, base64, or ''.
	async function rosterOf(gid) {
		try {
			if (!window.DaimondGroup || !DaimondGroup.rosterArt) return '';
			return String((await DaimondGroup.rosterArt(gid)) || '');
		} catch (e) { return ''; }
	}

	/// Whether a message can be reported at all, for a caller drawing a button.
	///
	/// A control that exists only to produce an error explains less than its
	/// absence does, so post.js asks this before it draws one.
	function canReport(m) {
		return !!(m && m.art && m.env && m.ck && m.dir !== 'out' && !m.bad);
	}

	/// The body inside an artefact, read by the format's own crate.
	///
	/// Throws with a sentence a person can read. This is the string the sheet
	/// draws AND the bytes it uploads are the ones it came from, which is the
	/// one-screen rule made structural.
	function bodyOf(artB64) {
		var b = window.DaimondCrypto;
		if (!b || typeof b.read !== 'function') {
			throw new Error(tOr('report.err_no_bridge',
				'This build cannot read the message it is about to send, so it will not '
				+ 'send it.'));
		}
		var got = JSON.parse(b.read(b64dec(artB64)));
		if (got.kind !== 'post') {
			throw new Error(tOr('report.err_not_a_post',
				'That is not a message; it is a {kind}.', { kind: String(got.kind || '?') }));
		}
		return {
			body: String((got.post && got.post.body) || ''),
			addr: String(got.address || ''),
			fp:   String(got.fingerprint || ''),
		};
	}

	// ── The gateway ────────────────────────────────────────────

	/// The reasons the gateway will accept, fetched once.
	///
	/// Asked rather than compiled in, so the picker and the endpoint cannot
	/// drift: a client offering a sixth reason would have every report refused
	/// and the person filing it told nothing useful about why.
	async function reasons() {
		if (_reasons) return _reasons;
		var r = await fetch(API, {
			credentials: 'same-origin',
			headers: { 'x-daimond-api': String(DaimondGateway.clientApi()) },
		});
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok !== true || !Array.isArray(j.reasons)) {
			throw new Error(tOr('report.err_no_reasons',
				'Reporting is not available just now.'));
		}
		_reasons = j.reasons.map(String);
		return _reasons;
	}

	/// Send one report. Answers `{ok, fresh}` or throws with a sentence.
	///
	/// `parts` is what [`partsOf`] returned; `reason` is one of [`reasons`].
	///
	/// A GROUP MESSAGE CARRIES A FIFTH PART, and it is the reason a group
	/// message can be reported at all. Its signed `to` is the GROUP'S id, so the
	/// gateway's "was this addressed to you" check can never match it, and the
	/// gateway holds no group record to ask instead. What it can check is the
	/// roster: signed by the group's creator, addressed to the id that derives
	/// from that creator's own key, and naming this account. So the roster goes,
	/// and nothing else about the group does.
	async function send(parts, reason) {
		var body = {
			artefact: parts.art,
			envelope: parts.env,
			ckey:     parts.ck,
			reason:   String(reason),
		};
		if (parts.gid) {
			var roster = await rosterOf(parts.gid);
			if (!roster) {
				throw new Error(tOr('report.err_no_roster',
					'This device no longer holds the signed roster for that group, so there '
					+ 'is nothing to show the operator that you are in it. Nothing was sent.'));
			}
			body.roster = roster;
		}
		var r = await fetch(API, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', 'x-daimond-api': String(DaimondGateway.clientApi()) },
			body: JSON.stringify(body),
		});
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok !== true) {
			throw new Error((j && j.error) || tOr('report.err_failed',
				'That report was not filed. Nothing was sent.'));
		}
		return { ok: true, fresh: j.fresh === true };
	}

	/// Report one FEED POST. Answers `{ok, fresh}` or throws with a sentence.
	///
	/// A DIFFERENT BODY ON THE SAME DOOR, and it is different because a feed post
	/// is not sealed: the operator holds the words already, so nothing is uploaded
	/// but the post's name and a reason. There is no artefact, no envelope and no
	/// content key in this shape -- a client that sent them would be handing over
	/// evidence for something the gateway can simply read.
	async function sendPost(author, id, reason) {
		var r = await fetch(API, {
			method:      'POST',
			credentials: 'same-origin',
			headers:     { 'Content-Type': 'application/json', 'x-daimond-api': String(DaimondGateway.clientApi()) },
			body: JSON.stringify({
				post:   { author: String(author || ''), id: id | 0 },
				reason: String(reason),
			}),
		});
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok !== true) {
			throw new Error((j && j.error) || tOr('report.err_failed',
				'That report was not filed. Nothing was sent.'));
		}
		return { ok: true, fresh: j.fresh === true };
	}

	// ── The sheet ──────────────────────────────────────────────

	function elt(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	/// Close whatever is open, and let go of it.
	function close() {
		if (_open && _open.parentNode) _open.parentNode.removeChild(_open);
		_open = null;
	}

	/// Open the confirmation sheet for one message.
	///
	/// Everything a person needs to decide is on this one screen: the words
	/// that will travel, the sentence saying what else travels with them, and
	/// the sentence saying what does NOT. The last of those is not decoration.
	/// Somebody deciding whether to report abuse is deciding how much of their
	/// own life to hand over, and "the rest of this conversation stays sealed"
	/// is the fact that decision turns on.
	async function open(m) {
		close();
		var parts = partsOf(m);
		if (parts.why) {
			alertLine(parts.why);
			return null;
		}
		var read;
		try { read = bodyOf(parts.art); }
		catch (e) { alertLine(String((e && e.message) || e)); return null; }

		var list;
		try { list = await reasons(); }
		catch (e) { alertLine(String((e && e.message) || e)); return null; }

		return sheet({
			title: tOr('report.title', 'Report this message'),
			rule:  tOr('report.rule',
				'These exact words go to the operator, with the sender’s signature and '
				+ 'the one key that opens this message. Nothing else from this conversation '
				+ 'goes: not the rest of the thread, not their other messages, not your '
				+ 'other conversations.'),
			body:  read.body,
			who:   tOr('report.signed_by', 'Signed by {fp}', { fp: read.fp || '?' }),
			group: !!parts.gid,
			list:  list,
			send:  function (reason) { return send(parts, reason); },
		});
	}

	/// Open the confirmation sheet for one FEED POST.
	///
	/// The words are read back out of what this device holds (js/feed.js's own
	/// rows), because that is what is on the screen -- and here, unlike a message,
	/// THE WORDS DO NOT TRAVEL AT ALL. What goes is the post's name and a reason;
	/// the operator can already read a feed post, and the rule line says exactly
	/// that rather than leaving a reader to assume this works like a message.
	async function openPost(author, id) {
		close();
		var row = null;
		try {
			row = (window.DaimondFeed && DaimondFeed.find) ? DaimondFeed.find(author, id) : null;
		} catch (e) { row = null; }
		if (!row) {
			alertLine(tOr('report.err_no_post', 'That post is not one this device holds.'));
			return null;
		}
		var list;
		try { list = await reasons(); }
		catch (e) { alertLine(String((e && e.message) || e)); return null; }
		return sheet({
			title: tOr('report.title_post', 'Report this post'),
			rule:  tOr('report.rule_post',
				'This post goes to the operator with your handle. Nothing else does.'),
			body:  String(row.body || ''),
			who:   row.handle ? tOr('report.posted_by', 'Posted by {who}', { who: row.handle }) : '',
			list:  list,
			send:  function (reason) { return sendPost(row.author || author, id, reason); },
			sent:    tOr('report.sent_post', 'Reported. The operator will look at it.'),
			already: tOr('report.already_post', 'You have already reported this post.'),
		});
	}

	/// The frame both reports are drawn in: the words, the rule, the closed list
	/// of reasons and one button. ONE SHEET, TWO BODIES -- what differs between a
	/// message and a feed post is what travels, and that is the rule line.
	function sheet(o) {
		var wrap = elt('div', 'modal');
		wrap.id = 'report-sheet';
		var card = elt('div', 'modal-card');
		card.appendChild(elt('h2', '', o.title));

		card.appendChild(elt('p', 'report-rule', o.rule));

		// AND THE ONE EXTRA THING A GROUP MESSAGE SENDS, said before the press
		// rather than in a comment. The roster is how the operator can tell this
		// account was one of the people the message was sealed to; it names the
		// group's members, so a person handing it over is owed the sentence. A
		// feed post never carries one, so the caller says whether to draw it.
		if (o.group) {
			card.appendChild(elt('p', 'report-rule', tOr('report.rule_group',
				'This went to a group, so the group’s member list goes too, to show '
				+ 'you are in it. It is checked and not kept.')));
		}

		// The words themselves, as this device holds them.
		var body = elt('blockquote', 'post-body report-body', o.body);
		body.id = 'report-body';
		card.appendChild(body);

		if (o.who) card.appendChild(elt('p', 'post-fp report-fp', o.who));
		var list = o.list;

		// The reasons, as radios: a closed list, and the gateway refuses
		// anything else, so a free box would be a box whose contents are
		// thrown away.
		var group = elt('div', 'report-reasons');
		group.setAttribute('role', 'radiogroup');
		group.setAttribute('aria-label', tOr('report.why', 'Why are you reporting it?'));
		list.forEach(function (r, i) {
			var lab = elt('label', 'report-reason');
			var inp = document.createElement('input');
			inp.type    = 'radio';
			inp.name    = 'report-reason';
			inp.value   = r;
			inp.checked = i === 0;
			lab.appendChild(inp);
			lab.appendChild(elt('span', '', tOr('report.reason_' + r, r)));
			group.appendChild(lab);
		});
		card.appendChild(group);

		var status = elt('p', 'report-status');
		status.setAttribute('role', 'status');
		card.appendChild(status);

		var acts = elt('div', 'post-acts');
		var go   = elt('button', 'post-btn report-send',
			tOr('report.send', 'Send this report'));
		go.type = 'button';
		var no = elt('button', 'post-btn report-cancel', tOr('report.cancel', 'Cancel'));
		no.type = 'button';
		acts.appendChild(go);
		acts.appendChild(no);
		card.appendChild(acts);

		no.addEventListener('click', close);
		go.addEventListener('click', async function () {
			var picked = group.querySelector('input:checked');
			go.disabled = true;
			status.textContent = tOr('report.sending', 'Sending…');
			try {
				var out = await o.send(picked ? picked.value : list[0]);
				// WHAT THE OPERATOR CAN NOW READ, which is not the same sentence for
				// the two shapes: a message report hands over the one key that opens
				// one envelope, and a feed post was already readable.
				status.textContent = out.fresh
					? (o.sent || tOr('report.sent',
						'Reported. The operator can now read this one message.'))
					: (o.already || tOr('report.already',
						'You have already reported this message. Nothing new was sent.'));
				go.remove();
				no.textContent = tOr('report.done', 'Close');
			} catch (e) {
				go.disabled = false;
				status.textContent = String((e && e.message) || e);
			}
		});

		wrap.appendChild(card);
		document.body.appendChild(wrap);
		_open = wrap;
		go.focus();
		return wrap;
	}

	/// One line said where a sheet cannot be opened at all.
	///
	/// Deliberately not a `confirm()` or a silent return: somebody who pressed
	/// Report and saw nothing happen will press it again, and then conclude
	/// that reporting does not work.
	function alertLine(msg) {
		close();
		var wrap = elt('div', 'modal');
		wrap.id = 'report-sheet';
		var card = elt('div', 'modal-card');
		card.appendChild(elt('h2', '', tOr('report.title', 'Report this message')));
		card.appendChild(elt('p', 'report-status', String(msg)));
		var no = elt('button', 'post-btn report-cancel', tOr('report.done', 'Close'));
		no.type = 'button';
		no.addEventListener('click', close);
		card.appendChild(no);
		wrap.appendChild(card);
		document.body.appendChild(wrap);
		_open = wrap;
		no.focus();
	}

	// ── The one thing another panel has to do ──────────────────
	//
	// A delegated listener, so post.js adds ONE attribute to a row's control and
	// nothing else. It does not reach into that panel's DOM, does not decorate
	// its rows, and does not run on any element that does not ask for it.

	/// The message a control names, out of whatever the panel holds.
	function find(addr) {
		if (!window.DaimondPost) return null;
		var all = [].concat(DaimondPost.list() || [], DaimondPost.tray() || []);
		for (var i = 0; i < all.length; i++) {
			if (String(all[i].addr) === String(addr)) return all[i];
		}
		return null;
	}

	document.addEventListener('click', function (e) {
		var btn = e.target && e.target.closest && e.target.closest('[data-report-addr]');
		if (!btn) return;
		e.preventDefault();
		var addr = btn.getAttribute('data-report-addr');
		var m = find(addr);
		if (!m) {
			alertLine(tOr('report.err_no_message',
				'That message is not one this device holds.'));
			return;
		}
		open(m).then(null, function (err) { log('sheet failed', err); });
	});

	// Escape closes it, on the rule every other overlay in this app follows.
	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && _open) close();
	});

	// ── Public surface ─────────────────────────────────────────
	window.DaimondReport = {
		/// Whether a message can be reported, for a caller drawing a control.
		canReport: canReport,
		/// The parts of a message a report is made of, or `{why}`.
		partsOf:   partsOf,
		/// The reasons the gateway accepts. Fetched once, then held.
		reasons:   reasons,
		/// Open the confirmation sheet for one message record.
		open:      open,
		/// The same, for one feed post, named by its author's account id and the
		/// post's id. js/feed.js presses this; the words come back out of the rows
		/// that lane holds.
		openPost:  openPost,
		/// Close whatever is open.
		close:     close,
		/// File one without a sheet, for a verifier. `parts` is `partsOf`'s
		/// answer; nothing here is a shortcut past the one-screen rule, since a
		/// caller reaching this has drawn its own screen or is a test.
		send:      send,
		/// The feed post's own body shape: `{post:{author,id}, reason}`, and
		/// nothing else on the wire.
		sendPost:  sendPost,
		/// The body inside an artefact, as the sheet draws it.
		bodyOf:    bodyOf,
		/// Everything this module would say if asked.
		state:     function () {
			return { open: !!_open, reasons: _reasons ? _reasons.slice() : null };
		},
	};
})();
