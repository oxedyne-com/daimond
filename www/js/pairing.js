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

   HOW IT LOOKS TRAVELS ONCE. A linked device should not have to be
   dressed twice, so the link carries a snapshot of the parent's
   presentation — theme, skin, language, display currency, reading size
   and the whole panel layout — and the child writes it before it next
   paints. It is a HANDOVER, not a synced setting: the screen
   configuration is a fact about a screen, and a phone is not a 27-inch
   monitor. That the snapshot applies exactly once falls out of where it
   lives: it exists only inside one redeemed pairing parcel, which is
   consumed in the act of redeeming it, so there is nothing left for a
   later sync to re-impose. The parcel never carries it either.

   The snapshot rides INSIDE the bundle string. The gateway's pair
   handler reads exactly one field out of the body -- `bundle`, as a
   string -- and parks that; a sibling field would be dropped on the
   floor without a word (see gateway/src/handlers/pair.rs). Nesting is
   therefore the form that needs no gateway change at all, and
   DaimondIdentity.importBundle ignores fields it does not know, so the
   extra one costs the identity path nothing. The gateway does cap a
   parked bundle at 8 KiB, so the snapshot is budgeted below that and
   sheds the layout — much the largest part — rather than fail a link.

   This module builds its own small dialogs so it needs no markup of
   its own beyond one <script> tag; styles are injected once.
   ============================================================ */
(function () {
	'use strict';

	var CLIENT_API = 1;

	/// Where a name typed on THIS device while linking it waits for the device
	/// roster to exist.
	///
	/// Naming it here is the moment the user actually knows which device this is
	/// -- they are holding it -- but the roster has no line for it yet: the line is
	/// minted on the first collect, which happens after the reload below. So the
	/// name is parked in storage and the mint consumes it (daimond.js
	/// pendingDeviceLabel). It is the user's own words, so it goes nowhere near
	/// the gateway: nothing reads this key but this browser.
	var PAIR_LABEL_KEY = 'daimond-pair-label';
	/// The roster's own ceiling on a name, kept in step (DEVICE_NAME_MAX).
	var PAIR_LABEL_MAX = 64;

	/// Park the name chosen while linking, or clear it when nothing was typed.
	function stashName(name) {
		var v = String(name == null ? '' : name).trim().slice(0, PAIR_LABEL_MAX);
		try {
			if (v) localStorage.setItem(PAIR_LABEL_KEY, v);
			else localStorage.removeItem(PAIR_LABEL_KEY);
		} catch (e) { /* private mode: the device keeps its own description */ }
		return v;
	}

	/// How many presentation keys the last redeem brought over, so the dialog can
	/// mention it. A user whose new device suddenly speaks German is owed a
	/// sentence saying why.
	var lastLookApplied = 0;

	// ── How this device looks, carried to the next one ─────────
	// A whitelist, in both directions. On the way out it is what "how it looks"
	// means, written down; on the way in it is the only thing a redeemed parcel
	// may write, so a bundle cannot reach into storage it has no business in.
	//
	// Every one of these is read at boot -- the theme, skin and language before
	// first paint by the inline script in index.html, the reading size and the
	// layout by their own modules as they load -- so writing them and letting the
	// page start is the whole of applying them. There is no second mechanism, and
	// there must not be one: a snapshot applied by poking the live DOM would drift
	// from what a reload produces.
	var LOOK_KEYS = [
		'daimond-theme',		// dark | light | lollypop
		'daimond-skin',			// sharp | warm
		'daimond-locale',		// the interface language
		'daimond-currency',		// the display currency (billing is unaffected)
		'daimond-fs-scale',		// the reading size (workspace.js)
		'daimond-layout',		// the dock's tiling, open and pinned panels, widths, splits
	];
	/// One value's ceiling. The layout is the only large one and is a few hundred
	/// bytes; anything past this is not a preference, it is a mistake.
	var LOOK_VALUE_MAX = 4096;
	/// What the whole parked bundle may weigh. The gateway refuses over 8 KiB
	/// (MAX_BUNDLE_BYTES in pair.rs); this leaves room and is checked here so the
	/// failure is a smaller snapshot rather than a link that will not form.
	var PARK_BUDGET = 7 * 1024;

	/// This device's presentation, as the keys that hold it. A key never set does
	/// not travel, so the child keeps its own default rather than being told the
	/// parent's absence of a choice.
	function snapshotLook() {
		var out = {};
		for (var i = 0; i < LOOK_KEYS.length; i++) {
			var k = LOOK_KEYS[i], v = null;
			try { v = localStorage.getItem(k); }
			catch (e) { v = null; }							// private mode: nothing to carry
			if (typeof v === 'string' && v !== '' && v.length <= LOOK_VALUE_MAX) out[k] = v;
		}
		return out;
	}

	/// Write a redeemed snapshot, once, before the page next starts.
	///
	/// Only the whitelisted keys, only strings, and only on this one redeem. A
	/// value the receiving device cannot store is skipped: arriving with a slightly
	/// different look is a far better outcome than a link that fails on quota.
	function applyLook(look) {
		if (!look || typeof look !== 'object') return 0;
		var n = 0;
		for (var i = 0; i < LOOK_KEYS.length; i++) {
			var k = LOOK_KEYS[i], v = look[k];
			if (typeof v !== 'string' || v === '' || v.length > LOOK_VALUE_MAX) continue;
			try { localStorage.setItem(k, v); n++; }
			catch (e) { /* quota or private mode: this one stays as it was */ }
		}
		return n;
	}

	// ── Transport ──────────────────────────────────────────────
	//
	// `create()` goes through `DaimondGateway.gwFetch`, which meets a 401 by
	// renewing the session once and asking once more. The gateway's session lives
	// an hour and only an unlock ever minted one, so an hour into a sitting
	// `POST /api/pair` came back 401 and the dialog told the user to sign in on a
	// device they were already signed in on -- with no control anywhere in the
	// app that would do it.
	//
	// Safe to repeat, and this is why: `create_impl` in gateway/src/handlers/
	// pair.rs checks the session BEFORE it parses the body, so a 401 leaves no
	// parked bundle and mints no code. A retry cannot leave a second code
	// standing.
	//
	// ONLY `create()`. `redeem()` must not -- see the note there. This file used
	// to carry its own copy of the retry rule, one of five identical copies; the
	// rule lives in gateway.js now, beside the renewal it drives.

	/// Create a pairing: export this device's identity and park it. Returns
	/// { code, expires_in }. Throws with a readable message on any failure.
	async function create() {
		if (!window.DaimondIdentity || !DaimondIdentity.exists()) {
			throw new Error(t('pair.err_no_identity'));
		}
		var bundle = DaimondIdentity.exportBundle();
		if (!bundle) throw new Error(t('pair.err_unreadable_local'));
		bundle.look = snapshotLook();
		var parked = JSON.stringify(bundle);
		// Shed the layout first, then the snapshot entirely. The identity is the
		// thing being carried and nothing about how the app looks may put it at
		// risk of not fitting.
		if (parked.length > PARK_BUDGET && bundle.look['daimond-layout']) {
			delete bundle.look['daimond-layout'];
			parked = JSON.stringify(bundle);
		}
		if (parked.length > PARK_BUDGET) {
			delete bundle.look;
			parked = JSON.stringify(bundle);
		}
		var r = await DaimondGateway.gwFetch('/api/pair', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body: JSON.stringify({ bundle: parked }),
		});
		var j = null; try { j = await r.json(); } catch (e) {}
		if (r.status === 401) throw new Error(t('pair.err_sign_in_first'));
		if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status));
		return { code: j.code, expiresIn: j.expires_in || 600 };
	}

	/// Redeem a code on a NEW device: fetch the bundle and import it, so this
	/// device now holds the same (still-locked) identity. Returns true on
	/// success. The caller then prompts for the passphrase to unlock.
	///
	/// The parent's presentation is written here, after the identity and before
	/// anything repaints, because the reload the dialog already does on the way to
	/// the unlock screen is what applies it. Nothing else in the app writes these
	/// keys from a bundle, so this is the one and only moment they arrive: from
	/// here on the device's look is its own to change.
	///
	/// DELIBERATELY NOT through `gwFetch`, on three counts. `redeem_impl` takes no
	/// session at all -- the redeeming device has none, which is the whole point --
	/// so a 401 here could not be a session that lapsed and re-authenticating
	/// could not change the answer. There is nothing to re-authenticate WITH: this
	/// device's identity arrives in the reply, so `reauth()` would find nothing
	/// unlocked, return false, and leave `state.authed` stamped false on a device
	/// whose gateway account is not yet a thing that exists. And a code is
	/// single-use: it is consumed in the act of redeeming it, so a blanket retry
	/// on any refusal is exactly the retry that must not exist here.
	async function redeem(code) {
		code = String(code || '').trim();
		if (!code) throw new Error(t('pair.err_enter_code'));
		var r = await fetch('/api/pair/redeem', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body: JSON.stringify({ code: code }),
		});
		var j = null; try { j = await r.json(); } catch (e) {}
		if (r.status === 404) throw new Error(t('pair.err_bad_code'));
		if (!r.ok || !j || j.ok === false || !j.bundle) throw new Error((j && j.error) || ('HTTP ' + r.status));
		var bundle;
		try { bundle = JSON.parse(j.bundle); } catch (e) { throw new Error(t('pair.err_bundle_unreadable')); }
		if (!DaimondIdentity.importBundle(bundle)) throw new Error(t('pair.err_bundle_import'));
		lastLookApplied = applyLook(bundle.look);
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
			// The name for this device: prose, not a code, so it is a plain field
			// at reading size rather than the big spaced-out one above it.
			'.pair-label{display:block;font-size:var(--fs-sm);opacity:.85;margin:0 0 4px}' +
			'.pair-name{width:100%;box-sizing:border-box;font-size:var(--fs-base);padding:9px 10px;' +
			'border-radius:8px;border:1px solid var(--border,#444);background:var(--bg-primary,#111);' +
			'color:inherit;margin:0 0 12px}' +
			'.pair-row{display:flex;gap:8px;justify-content:flex-end}' +
			'.pair-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--border,#444);' +
			'background:var(--accent,#4a7);color:#fff;cursor:pointer;font-size:var(--fs-base)}' +
			'.pair-btn.ghost{background:transparent;color:inherit}' +
			// --danger, not a literal: #e66 was chosen against a dark card and reads
			// at about 3:1 on the light and lollypop ones, which is under the floor
			// for the one line on this dialog that says something went wrong.
			'.pair-err{color:var(--danger);font-size:var(--fs-sm);min-height:1.1em;margin:0 0 8px}' +
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
		// Where the keyboard was before this went up, so it can be given back.
		var prev = document.activeElement;
		function close() {
			document.removeEventListener('keydown', onKey, true);
			try { document.body.removeChild(scrim); } catch (e) { /* already gone */ }
			if (prev && prev.focus && prev.getClientRects && prev.getClientRects().length) {
				try { prev.focus(); } catch (e) { /* gone with the redraw */ }
			}
		}
		/// The controls in here that can actually take focus.
		function stops() {
			return [].filter.call(box.querySelectorAll('button,input,a[href],[tabindex]:not([tabindex="-1"])'),
				function (n) { return !n.disabled && n.getClientRects().length; });
		}
		// Escape, and a Tab that stays put. This dialog answered only to the scrim
		// and to Done: a keyboard user had no way to put it down, and Tab walked
		// straight past it into an app they could not see behind the scrim.
		function onKey(e) {
			if (e.key === 'Escape') { e.preventDefault(); close(); return; }
			if (e.key !== 'Tab') return;
			var f = stops();
			if (!f.length) return;
			var first = f[0], last = f[f.length - 1];
			if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
			if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
		}
		document.addEventListener('keydown', onKey, true);
		scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
		build(box, close);
		// The way out, in the corner. The only pointer dismissal this dialog
		// offered was a "Done" 64x37 at its foot -- under the thumb's floor, and
		// at the wrong end of a card that on a phone is 358px of a 390px screen.
		// The heading is lifted into the closer's row rather than a second title
		// being invented, so the card still names itself once.
		if (window.DaimondCloser) {
			var h3 = box.querySelector('h3');
			var row = h3
				? DaimondCloser.head(h3.textContent || '', { titleEl: h3, onClose: close })
				: DaimondCloser.head('', { name: t('common.close'), onClose: close });
			box.insertBefore(row, box.firstChild);
		}
		document.body.appendChild(scrim);
		// Once it is in the document and can be focused: the first control in it,
		// so the keyboard starts inside the thing covering the screen. Not the
		// closer, which is first in the document now -- landing on it would offer
		// the way out before the code the dialog exists to show.
		var f0 = stops().filter(function (n) { return !n.classList.contains('ui-close'); })[0]
			|| stops()[0];
		if (f0) { try { f0.focus(); } catch (e) { /* not focusable */ } }
		return close;
	}

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	/// Device A: create a pairing and show the code to carry to the other device.
	function showLink() {
		overlay(function (box, close) {
			box.appendChild(el('h3', null, t('pair.link_another')));
			var p = el('p', null, t('pair.making_code'));
			box.appendChild(p);
			var err = el('div', 'pair-err');
			box.appendChild(err);
			// No Done at the foot. This dialog shows a code and decides nothing, so
			// its way out is the cross in the corner -- and the old button was a
			// 64x37 ghost at the bottom right, below the thumb's floor and at the
			// far end of a card that fills a phone.
			create().then(function (res) {
				// The friction-free path: a QR of the pairing URL that the other
				// phone's own camera opens. Falls back to the typed code below it
				// wherever a QR cannot be shown or scanned.
				var url = location.origin + '/#pair=' + encodeURIComponent(res.code);
				var qr = qrCanvas(url);
				if (qr) {
					p.textContent = t('pair.scan_lead');
					box.insertBefore(qr, err);
					var or = el('p', 'pair-note', t('pair.no_camera'));
					box.insertBefore(or, err);
				} else {
					p.textContent = t('pair.type_lead');
				}
				var code = el('div', 'pair-code', res.code);
				box.insertBefore(code, err);
				var mins = Math.round((res.expiresIn || 600) / 60);
				var note = el('p', 'pair-note', t('pair.code_expiry', { mins: mins }));
				box.insertBefore(note, err);
			}).catch(function (e) {
				p.textContent = '';
				err.textContent = e.message || t('pair.err_create');
			});
		});
	}

	/// Device B: enter a code, import the identity, then hand off to unlock.
	///
	/// `prefill` is the code carried in a `#pair=` deep link (from scanning the
	/// QR), so a scan lands here with the field already filled and only the tap
	/// to confirm left.
	function showRedeem(prefill) {
		var scanned = typeof prefill === 'string' && !!prefill;
		overlay(function (box, close) {
			box.appendChild(el('h3', null, t('pair.link_this')));
			if (scanned) {
				// Arrived by scanning the QR: the code is already filled in, so the
				// only thing left is to tap the button. Say exactly that, and that
				// the code is shown only so it can be checked against the other
				// device -- otherwise a code and a button read as "type this
				// somewhere", which is what confused people.
				box.appendChild(el('p', null, t('pair.scanned_lead')));
			} else {
				box.appendChild(el('p', null, t('pair.manual_lead')));
			}
			var input = el('input', 'pair-input');
			input.setAttribute('placeholder', t('pair.code_ph'));
			input.setAttribute('autocapitalize', 'off');
			input.setAttribute('autocomplete', 'off');
			input.setAttribute('spellcheck', 'false');
			if (scanned) { input.value = prefill; input.readOnly = true; }
			box.appendChild(input);
			if (scanned) {
				box.appendChild(el('p', 'pair-note', t('pair.code_check')));
			}
			// What to call this device. Asked HERE because this is the moment the
			// user knows the answer -- the device is in their hands -- and skippable
			// because a device that is never named is still a device that syncs.
			// The placeholder is what it will be called if nothing is typed, so the
			// empty field is an honest preview rather than a blank.
			var derived = '';
			try { derived = (window.DaimondCore && DaimondCore.deviceSelfName && DaimondCore.deviceSelfName()) || ''; }
			catch (e) { derived = ''; }
			var lab = el('label', 'pair-label', t('pair.name_this'));
			lab.setAttribute('for', 'pair-name-input');
			box.appendChild(lab);
			var nameIn = el('input', 'pair-name');
			nameIn.id = 'pair-name-input';
			nameIn.setAttribute('placeholder', derived || t('pair.name_ph'));
			nameIn.setAttribute('maxlength', String(PAIR_LABEL_MAX));
			nameIn.setAttribute('autocomplete', 'off');
			box.appendChild(nameIn);
			var err = el('div', 'pair-err');
			box.appendChild(err);
			var row = el('div', 'pair-row');
			var cancel = el('button', 'pair-btn ghost', t('common.cancel'));
			cancel.addEventListener('click', close);
			var go = el('button', 'pair-btn', t('pair.link_this'));
			row.appendChild(cancel);
			row.appendChild(go);
			box.appendChild(row);

			function submit() {
				err.textContent = '';
				go.disabled = true;
				redeem(input.value).then(function () {
					// Park the name for this device before the reload, for the roster
					// to take up when it first mints this device's line.
					var named = stashName(nameIn.value);
					// Name the account, and leave a note the unlock screen picks up
					// after the reload -- on a phone the passphrase box reappears
					// with a different name on it, and it must be clear that the
					// passphrase to type is the ONE FROM THE OTHER DEVICE, not a new
					// one for this phone.
					var who = '';
					try { who = (window.DaimondIdentity && DaimondIdentity.displayName()) || ''; } catch (e) { /* none */ }
					try { sessionStorage.setItem('daimond-just-linked', who || '1'); } catch (e) { /* private mode */ }
					box.innerHTML = '';
					box.appendChild(el('h3', null, t('pair.linked')));
					box.appendChild(el('p', null, who
						? t('pair.linked_named', { name: who })
						: t('pair.linked_note')));
					if (named) box.appendChild(el('p', 'pair-note', t('pair.named_note', { name: named })));
					if (lastLookApplied > 0) box.appendChild(el('p', 'pair-note', t('pair.look_carried')));
					var r2 = el('div', 'pair-row');
					var ok = el('button', 'pair-btn', t('identity.unlock'));
					ok.addEventListener('click', function () { close(); location.reload(); });
					r2.appendChild(ok);
					box.appendChild(r2);
				}).catch(function (e) {
					go.disabled = false;
					err.textContent = e.message || t('pair.err_link');
				});
			}
			go.addEventListener('click', submit);
			input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
			nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
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
			var b = el('button', 'pair-btn ghost', t('pair.have_code'));
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
			var l = el('button', 'icon-btn');
			// A line icon matching the header's own (a phone, with a small arc to
			// a second device), rather than an emoji that clashes with them.
			l.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
				+ '<rect x="3" y="7" width="9" height="14" rx="1.6"/>'
				+ '<path d="M7.5 18h0"/>'
				+ '<path d="M15 4.2a6 6 0 015 5M15 8a2.4 2.4 0 012 2"/></svg>';
			l.id = 'pair-link-btn';
			l.type = 'button';
			// Bound rather than set: a name written once at mount is fixed in
			// whichever language the button happened to be built in, and stays
			// there through every later `setLocale`. It is spoken text, so it is
			// the kind nobody sees go wrong.
			if (window.DaimondI18n && DaimondI18n.bind) {
				DaimondI18n.bind(l, 'title', 'pair.link_another');
				DaimondI18n.bind(l, 'aria-label', 'pair.link_another');
			} else {
				l.title = t('pair.link_another');
				l.setAttribute('aria-label', l.title);
			}
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
	// `stashName` is published because the naming and the roster are two modules:
	// this one takes the name, daimond.js consumes it when the device's line is
	// minted, and the seam between them is worth being able to exercise.
	window.DaimondPairing = { create: create, redeem: redeem, showLink: showLink, showRedeem: showRedeem,
		stashName: stashName };

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();
})();
