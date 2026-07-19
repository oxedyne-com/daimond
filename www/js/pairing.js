/* ============================================================
   Daimond — device pairing (pairing.js)
   ------------------------------------------------------------
   Carry an identity to a second device so it becomes the SAME
   account and can decrypt that account's sync blobs.

   The logged-in device exports its identity bundle (salt + public
   key + the passphrase-WRAPPED private key — no passphrase, no
   derived key; see DaimondIdentity.exportBundle) and parks it on the
   gateway under a short one-time code. The new device redeems the
   code, imports the bundle, and unlocks with the same passphrase.

   The gateway only ever holds passphrase-encrypted material for a
   few minutes, keyed by a code that is single-use and short-lived —
   the same opaque-parcel posture as the sync mailbox.

   This module builds its own small dialogs so it needs no markup of
   its own beyond one <script> tag; styles are injected once.
   ============================================================ */
(function () {
	'use strict';

	var CLIENT_API = 1;

	// ── Transport ──────────────────────────────────────────────

	/// Create a pairing: export this device's identity and park it. Returns
	/// { code, expires_in }. Throws with a readable message on any failure.
	async function create() {
		if (!window.DaimondIdentity || !DaimondIdentity.exists()) {
			throw new Error('There is no identity on this device to link.');
		}
		var bundle = DaimondIdentity.exportBundle();
		if (!bundle) throw new Error('Could not read this device’s identity.');
		var r = await fetch('/api/pair', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body: JSON.stringify({ bundle: JSON.stringify(bundle) }),
		});
		var j = null; try { j = await r.json(); } catch (e) {}
		if (r.status === 401) throw new Error('Sign in on this device before linking another.');
		if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status));
		return { code: j.code, expiresIn: j.expires_in || 600 };
	}

	/// Redeem a code on a NEW device: fetch the bundle and import it, so this
	/// device now holds the same (still-locked) identity. Returns true on
	/// success. The caller then prompts for the passphrase to unlock.
	async function redeem(code) {
		code = String(code || '').trim();
		if (!code) throw new Error('Enter the pairing code from your other device.');
		var r = await fetch('/api/pair/redeem', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body: JSON.stringify({ code: code }),
		});
		var j = null; try { j = await r.json(); } catch (e) {}
		if (r.status === 404) throw new Error('That code is invalid or has expired. Make a new one on your other device.');
		if (!r.ok || !j || j.ok === false || !j.bundle) throw new Error((j && j.error) || ('HTTP ' + r.status));
		var bundle;
		try { bundle = JSON.parse(j.bundle); } catch (e) { throw new Error('The linked identity was unreadable.'); }
		if (!DaimondIdentity.importBundle(bundle)) throw new Error('The linked identity could not be imported.');
		return true;
	}

	// ── Minimal UI ─────────────────────────────────────────────

	function injectStyles() {
		if (document.getElementById('pairing-styles')) return;
		var s = document.createElement('style');
		s.id = 'pairing-styles';
		s.textContent =
			'.pair-scrim{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;' +
			'align-items:center;justify-content:center;z-index:9999;padding:16px}' +
			'.pair-box{background:var(--bg-secondary,#1b1b1f);color:var(--text-primary,#eee);' +
			'border:1px solid var(--border,#333);border-radius:12px;max-width:380px;width:100%;' +
			'padding:20px;box-shadow:0 12px 40px rgba(0,0,0,.5)}' +
			'.pair-box h3{margin:0 0 8px;font-size:var(--fs-xl)}' +
			'.pair-box p{margin:0 0 12px;font-size:var(--fs-base);line-height:1.4;opacity:.85}' +
			'.pair-code{font-family:ui-monospace,monospace;font-size:var(--fs-5xl);letter-spacing:.15em;' +
			'text-align:center;padding:12px;border:1px dashed var(--border,#444);border-radius:8px;' +
			'margin:0 0 12px;user-select:all}' +
			'.pair-input{width:100%;box-sizing:border-box;font-family:ui-monospace,monospace;' +
			'font-size:var(--fs-3xl);letter-spacing:.1em;text-align:center;padding:10px;border-radius:8px;' +
			'border:1px solid var(--border,#444);background:var(--bg-primary,#111);color:inherit;margin:0 0 12px}' +
			'.pair-row{display:flex;gap:8px;justify-content:flex-end}' +
			'.pair-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--border,#444);' +
			'background:var(--accent,#4a7);color:#fff;cursor:pointer;font-size:var(--fs-base)}' +
			'.pair-btn.ghost{background:transparent;color:inherit}' +
			'.pair-err{color:#e66;font-size:var(--fs-sm);min-height:1.1em;margin:0 0 8px}' +
			'.pair-note{font-size:var(--fs-xs);opacity:.7;margin:8px 0 0}' +
			'.pair-qr{display:block;margin:0 auto 12px;width:220px;height:220px;max-width:80%;' +
			'image-rendering:pixelated;border-radius:8px;background:#fff;padding:8px;box-sizing:border-box}';
		document.head.appendChild(s);
	}

	/// Draw a pairing URL as a QR onto a crisp canvas, using the wasm encoder.
	///
	/// Returns the canvas, or null when the text could not be encoded -- the
	/// caller then shows the typed code alone. The symbol is always dark-on-white
	/// with the standard 4-module quiet zone, whatever the theme, because a camera
	/// needs that contrast to read it.
	function qrCanvas(text) {
		var QR = window.DaimondQR;
		if (!QR || !QR.matrix) return null;
		var cells = QR.matrix(text);
		if (!cells || !cells.length) return null;
		var n = Math.round(Math.sqrt(cells.length));
		if (n * n !== cells.length || n < 21) return null;
		var quiet = 4;						// the standard quiet zone, in modules
		var dim   = n + quiet * 2;
		var scale = 6;						// device pixels per module, for a crisp image
		var size  = dim * scale;
		var c = el('canvas', 'pair-qr');
		c.width = size;
		c.height = size;
		var ctx = c.getContext('2d');
		if (!ctx) return null;
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, size, size);
		ctx.fillStyle = '#000000';
		for (var y = 0; y < n; y++) {
			for (var x = 0; x < n; x++) {
				if (cells[y * n + x]) {
					ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
				}
			}
		}
		return c;
	}

	function overlay(build) {
		injectStyles();
		var scrim = document.createElement('div');
		scrim.className = 'pair-scrim';
		var box = document.createElement('div');
		box.className = 'pair-box';
		scrim.appendChild(box);
		function close() { try { document.body.removeChild(scrim); } catch (e) {} }
		scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
		build(box, close);
		document.body.appendChild(scrim);
		return close;
	}

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	/// Device A: create a pairing and show the code to carry to the other device.
	function showLink() {
		overlay(function (box, close) {
			box.appendChild(el('h3', null, 'Link another device'));
			var p = el('p', null, 'Making a one-time code…');
			box.appendChild(p);
			var err = el('div', 'pair-err');
			box.appendChild(err);
			var row = el('div', 'pair-row');
			var done = el('button', 'pair-btn ghost', 'Done');
			done.addEventListener('click', close);
			row.appendChild(done);
			box.appendChild(row);

			create().then(function (res) {
				// The friction-free path: a QR of the pairing URL that the other
				// phone's own camera opens. Falls back to the typed code below it
				// wherever a QR cannot be shown or scanned.
				var url = location.origin + '/#pair=' + encodeURIComponent(res.code);
				var qr = qrCanvas(url);
				if (qr) {
					p.textContent = 'On your other phone, point its camera at this to open Daimond and link it:';
					box.insertBefore(qr, err);
					var or = el('p', 'pair-note', 'No camera? Open Daimond there, choose “Have a pairing code?”, and enter:');
					box.insertBefore(or, err);
				} else {
					p.textContent = 'On your other device, open Daimond, choose “Have a pairing code?”, and enter:';
				}
				var code = el('div', 'pair-code', res.code);
				box.insertBefore(code, err);
				var mins = Math.round((res.expiresIn || 600) / 60);
				var note = el('p', 'pair-note', 'This code works once and expires in about ' + mins + ' minutes. You will unlock the other device with your usual passphrase.');
				box.insertBefore(note, err);
			}).catch(function (e) {
				p.textContent = '';
				err.textContent = e.message || 'Could not create a pairing code.';
			});
		});
	}

	/// Device B: enter a code, import the identity, then hand off to unlock.
	///
	/// `prefill` is the code carried in a `#pair=` deep link (from scanning the
	/// QR), so a scan lands here with the field already filled and only the tap
	/// to confirm left.
	function showRedeem(prefill) {
		overlay(function (box, close) {
			box.appendChild(el('h3', null, 'Link this device'));
			box.appendChild(el('p', null, 'On the device you already use, choose “Link another device” and type the code it shows here.'));
			var input = el('input', 'pair-input');
			input.setAttribute('placeholder', 'pairing code');
			input.setAttribute('autocapitalize', 'off');
			input.setAttribute('autocomplete', 'off');
			input.setAttribute('spellcheck', 'false');
			if (typeof prefill === 'string' && prefill) input.value = prefill;
			box.appendChild(input);
			var err = el('div', 'pair-err');
			box.appendChild(err);
			var row = el('div', 'pair-row');
			var cancel = el('button', 'pair-btn ghost', 'Cancel');
			cancel.addEventListener('click', close);
			var go = el('button', 'pair-btn', 'Link this device');
			row.appendChild(cancel);
			row.appendChild(go);
			box.appendChild(row);

			function submit() {
				err.textContent = '';
				go.disabled = true;
				redeem(input.value).then(function () {
					box.innerHTML = '';
					box.appendChild(el('h3', null, 'This device is linked'));
					box.appendChild(el('p', null, 'It now holds your identity. Unlock it with your usual passphrase to see your chats and files here.'));
					var r2 = el('div', 'pair-row');
					var ok = el('button', 'pair-btn', 'Unlock');
					ok.addEventListener('click', function () { close(); location.reload(); });
					r2.appendChild(ok);
					box.appendChild(r2);
				}).catch(function (e) {
					go.disabled = false;
					err.textContent = e.message || 'Could not link this device.';
				});
			}
			go.addEventListener('click', submit);
			input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
			setTimeout(function () { try { input.focus(); } catch (e) {} }, 50);
		});
	}

	// ── Entry points (injected, so no shared markup to edit) ────

	function injectEntryPoints() {
		// The injected buttons carry `.pair-btn` classes, so their styles must be
		// present from the start, not only once a dialog first opens.
		injectStyles();
		// Device B: a way in from the locked identity screen.
		var modal = document.getElementById('identity-modal');
		if (modal && !document.getElementById('pair-redeem-entry')) {
			var b = el('button', 'pair-btn ghost', 'Have a pairing code?');
			b.id = 'pair-redeem-entry';
			b.type = 'button';
			b.style.cssText = 'margin-top:12px;width:100%';
			b.addEventListener('click', showRedeem);
			// Place it inside the card, at the end. The identity modal's card is
			// `.modal-card`; without it in this list the button fell back to the
			// modal itself and became a second flex child, splitting the row and
			// squeezing the card until its wordmark and inputs clipped on a phone.
			var content = modal.querySelector('.modal-card, .modal-content, .id-content, form') || modal;
			content.appendChild(b);
		}
		// Device A: a link button in the top actions, shown once there is a session.
		var actions = document.getElementById('top-actions') || document.querySelector('.top-actions');
		if (actions && !document.getElementById('pair-link-btn')) {
			var l = el('button', 'icon-btn', '🔗');
			l.id = 'pair-link-btn';
			l.type = 'button';
			l.title = 'Link another device';
			l.setAttribute('aria-label', 'Link another device');
			l.style.display = 'none';
			l.addEventListener('click', function () {
				if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return;
				showLink();
			});
			var guide = document.getElementById('guide-btn');
			if (guide && guide.parentNode === actions) actions.insertBefore(l, guide);
			else actions.appendChild(l);
		}
		// Reveal the link button once a session exists.
		window.addEventListener('daimond:authed', function () {
			var lb = document.getElementById('pair-link-btn');
			if (lb) lb.style.display = '';
		});
	}

	/// The pairing code carried in the URL, if this load came from a scanned QR
	/// (`…/#pair=<code>`). Empty when there is none.
	function pendingPairCode() {
		var m = /[#&]pair=([^&]+)/.exec(location.hash || '');
		return m ? decodeURIComponent(m[1]) : '';
	}

	/// Strip `pair=` from the URL so a reload does not reopen the dialog and the
	/// one-time code does not linger in history.
	function consumePairHash() {
		try {
			var h = (location.hash || '').replace(/[#&]?pair=[^&]*/, '');
			if (h === '#') h = '';
			history.replaceState({}, '', location.pathname + location.search + h);
		} catch (e) {}
	}

	/// Open the redeem dialog for a `#pair=` code in the URL, once, code filled
	/// in. Handles both arrival paths: a fresh load from a scanned QR, and a hash
	/// change on a tab that was already open when the QR was scanned.
	function maybeOpenFromHash() {
		var code = pendingPairCode();
		if (!code) return;
		if (document.querySelector('.pair-scrim')) return;	// a dialog is already up
		consumePairHash();
		showRedeem(code);
	}

	function start() {
		injectEntryPoints();
		maybeOpenFromHash();									// arrived via a fresh load
		window.addEventListener('hashchange', maybeOpenFromHash);	// or an already-open tab
	}

	// ── Public surface ─────────────────────────────────────────
	window.DaimondPairing = { create: create, redeem: redeem, showLink: showLink, showRedeem: showRedeem };

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();
})();
