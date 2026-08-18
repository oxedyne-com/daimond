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
///  4. a reason, from the closed list the gateway serves.
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
		return { art: String(m.art), env: String(m.env), ck: String(m.ck) };
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
			headers: { 'x-daimond-api': '1' },
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
	async function send(parts, reason) {
		var r = await fetch(API, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({
				artefact: parts.art,
				envelope: parts.env,
				ckey:     parts.ck,
				reason:   String(reason),
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

		var wrap = elt('div', 'modal');
		wrap.id = 'report-sheet';
		var card = elt('div', 'modal-card');
		card.appendChild(elt('h2', '', tOr('report.title', 'Report this message')));

		card.appendChild(elt('p', 'report-rule', tOr('report.rule',
			'These exact words go to the operator, with the sender’s signature and '
			+ 'the one key that opens this message. Nothing else from this conversation '
			+ 'goes: not the rest of the thread, not their other messages, not your '
			+ 'other conversations.')));

		// The words themselves, out of the bytes that are about to travel.
		var body = elt('blockquote', 'post-body report-body', read.body);
		body.id = 'report-body';
		card.appendChild(body);

		var who = elt('p', 'post-fp report-fp', tOr('report.signed_by',
			'Signed by {fp}', { fp: read.fp || '?' }));
		card.appendChild(who);

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
				var out = await send(parts, picked ? picked.value : list[0]);
				status.textContent = out.fresh
					? tOr('report.sent', 'Reported. The operator can now read this one message.')
					: tOr('report.already',
						'You have already reported this message. Nothing new was sent.');
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
		/// Close whatever is open.
		close:     close,
		/// File one without a sheet, for a verifier. `parts` is `partsOf`'s
		/// answer; nothing here is a shortcut past the one-screen rule, since a
		/// caller reaching this has drawn its own screen or is a test.
		send:      send,
		/// The body inside an artefact, as the sheet draws it.
		bodyOf:    bodyOf,
		/// Everything this module would say if asked.
		state:     function () {
			return { open: !!_open, reasons: _reasons ? _reasons.slice() : null };
		},
	};
})();
