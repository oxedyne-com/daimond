// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { Wasm } from './wasm.js';
import { KITS, crystalRunning, pg, setKitsWaiting } from './state.js';
import { friendlyError, getSecret, hideSecret, installSecretMask, mark, secretEye, t, tn, trail } from './util.js';
import { persistChats } from './chatstore.js';
import { chatHoldingTurn, deviceLabelFor, dispatchedChat, handOffTurn, peerSyncShim, peerTakeBack,
	renderDispatchedBadges, selfDeviceId, uiWebUrl } from './handoff.js';
import { sendUserMessage } from './send.js';
import { waitingOn } from './steer.js';
import { Workers } from './workers.js';
import { Files } from './files_view.js';
import { continueTurn, retryTurn } from './sourcemenu.js';
import { signalLinksChanged } from './links.js';
import { diag, toast } from './passkey_phrase.js';
import { ASK_CHOSE, CLOSE_SVG, askDrawable, askHolds } from './turns.js';
import { busySay, selectChat, syncSendMode } from './chats.js';
import { Pending, Prompts } from './pending.js';
import { diamondApp, loadDiamonds, publishWithheld } from './diamonds.js';
import { chatAttachList, chatScopePaths, chatScratchDir, chatWaiting, confirmMarkHere, grantHoldHere,
	linkTo, markDevice, markForce, marksNotSaved, rootHere, rootedRef, waitingMarkAt } from './marks.js';
import { tOr } from './settingsui.js';
// page-split: end imports

// Turn a raw error — which may be an ANSI-coloured fe2o3 `Outcome` chain
// carrying `src/*.rs:line` frames — into one plain, user-facing sentence.
// Terminal codes and internal source locations must never reach the DOM.
// ── In-app dialogs ─────────────────────────────────────────
// Daimond never uses window.prompt/confirm/alert. A native dialog is an OS
// box with the origin in its title, styled nothing like the app, and it
// blocks the whole page; it reads like a phishing prompt over a dark UI.
// These are the in-app replacements: promise-based, escapable, focus-
// trapped, and dismissed by Escape or the backdrop.

/// Build a form's fields into `host`, and hand back the way to read them.
/// The modal dialog and the settings pane both use this, so a form behaves
/// the same wherever it is shown — there is one form, not two that drift.
export function buildForm(host, opts) {
	var inputs = {};
	var first  = null;
	var note   = document.createElement('div');
	note.className = 'dlg-note';
	// A field marked `advanced` lands behind a disclosure instead of in the
	// form proper (CRY-14). Built lazily and appended after the plain fields,
	// so a form with none of them is exactly the form it was and one with
	// them opens on the question it is really asking.
	var adv = null;
	function hostFor(f) {
		if (!f.advanced) return host;
		if (!adv) {
			adv = document.createElement('details');
			adv.className = 'dlg-adv';
			var sum = document.createElement('summary');
			sum.className = 'dlg-adv-sum';
			mark(sum, '', opts.advancedLabel || t('tile.dlg_advanced'));
			adv.appendChild(sum);
		}
		return adv;
	}
	(opts.fields || []).forEach(function (f) {
		var into = hostFor(f);
		var lab = document.createElement('label');
		lab.className = 'cfg-fieldlabel';
		// Marked, so the row follows a language change while the form stands open.
		mark(lab, '', f.label || f.name);
		// A field whose label cannot say what happens if it is left alone carries the
		// sentence on hover instead, on both halves of the row.
		if (f.title) mark(lab, 'title', f.title);
		into.appendChild(lab);

		// A `models` field is a pulldown of every model, grouped by provider, drawn by the
		// one function that draws every such pulldown. A form that asks which model to use
		// must offer the same list the tile does, or the two will come to disagree.
		if (f.kind === 'models') {
			var sel = document.createElement('select');
			sel.className = 'dlg-input dlg-select';
			if (f.title) { mark(sel, 'title', f.title); mark(sel, 'aria-label', f.title); }
			if (window.DaimondModels) DaimondModels.fillSelect(sel, f.provider || '', f.value || '');
			into.appendChild(sel);
			if (window.DaimondModels) DaimondModels.picker(sel);
			inputs[f.name] = sel;
			// Never the field the dialog opens on: a control behind a closed
			// disclosure cannot take the focus, and handing it there leaves the
			// caret nowhere.
			if (!first && !f.advanced) first = sel;
			return;
		}

		var el = document.createElement('input');
		el.className = 'dlg-input';
		el.type = 'text';
		mark(el, 'placeholder', f.placeholder || '');
		el.autocomplete = 'off';
		el.spellcheck = false;
		el.setAttribute('data-1p-ignore', '');
		el.setAttribute('data-lpignore', 'true');
		if (f.secret) installSecretMask(el, f.value || '');
		else el.value = f.value || '';
		if (f.hint) {
			el.addEventListener('input', function () { f.hint(el.value, inputs, note); });
		}
		into.appendChild(f.secret ? secretEye(el) : el);
		// What a field takes when its label cannot say all of it, under the field.
		if (f.note) {
			var sub = document.createElement('p');
			sub.className = 'cfg-fieldnote';
			mark(sub, '', f.note);
			into.appendChild(sub);
		}
		inputs[f.name] = el;
		if (!first && !f.advanced) first = el;
	});
	if (adv) host.appendChild(adv);
	host.appendChild(note);
	if (opts.onInit) opts.onInit(inputs, note);
	return {
		inputs: inputs,
		first:  first,
		note:   note,
		read:   function () {
			var vals = {};
			(opts.fields || []).forEach(function (f) {
				var el = inputs[f.name];
				// A models field answers with BOTH halves -- { provider, model } -- because a
				// model id alone does not say which key runs it.
				if (f.kind === 'models') {
					vals[f.name] = window.DaimondModels
						? DaimondModels.pick(el) : { provider: '', model: '' };
					return;
				}
				vals[f.name] = (f.secret ? getSecret(el) : el.value).trim();
			});
			return vals;
		},
	};
}

/// Keep Tab inside `card`, and pull it back if it is already outside.
///
/// Only controls that can ACTUALLY take focus count as stops on the way
/// round: a disabled button, or one in the half of the card the current mode
/// hides, is not one. Treating those as the last stop is what let Tab walk out
/// of the change-passphrase dialog and into the app behind it.
export function keepFocusIn(card, e) {
	var f = [].filter.call(
		card.querySelectorAll('input,button,select,textarea,a[href],[tabindex]:not([tabindex="-1"])'),
		function (n) { return !n.disabled && n.getClientRects().length; });
	if (!f.length) return;
	var first = f[0], last = f[f.length - 1];
	// Outside already -- because whatever was focused on opening could not take
	// it. The next Tab belongs in the dialog, not behind it.
	if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
	if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
	else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/// Put the focus back where a dialog took it from.
///
/// `prev.focus()` on its own is not enough, and the reason is not exotic: the
/// panel underneath can REDRAW while the dialog stands over it. `renderHome`
/// does exactly that -- the console role probe calls it on every answer, and
/// when there is no gateway to answer it retries on a timer -- and the redraw
/// clears `homeView`, so the button the dialog means to hand the focus back to
/// no longer exists. `focus()` on a detached node throws nothing and does
/// nothing; the focus is simply left on `document.body`, and the next Tab
/// starts at the top of the app. Three dialogs failed `verify_focus` on that,
/// and every offline session met it.
///
/// So the opener is tried first, and if the focus did not land, whatever is
/// still standing takes it: an outer dialog if one is open, otherwise the
/// container the opener came from -- captured when the dialog opened, because
/// a redraw replaces a panel's CHILDREN and keeps the panel itself.
///
/// # Arguments
/// * `prev` - Whatever held the focus when the dialog opened.
/// * `host` - The nearest identified ancestor of `prev` at that moment.
export function refocus(prev, host) {
	if (tookFocus(prev)) return;
	// The opener has gone. Hand the focus to whatever is still standing, and
	// VISIBLE, and able to take it.
	//
	// Visibility is not a nicety here. `www/index.html` keeps six modals in the
	// document with `display:none` -- settings, identity and the rest -- so
	// "the topmost .modal-card" picks a hidden one, focusing anything inside it
	// silently does nothing, and the focus is left on the body: the very
	// failure this function exists to prevent, reintroduced by the fix for it.
	// Hence `tookFocus`, which ASKS whether the focus actually moved rather
	// than assuming `focus()` worked.
	var cards = document.querySelectorAll('.modal .modal-card');
	for (var i = cards.length - 1; i >= 0; i--) {
		if (onScreen(cards[i]) && focusWithin(cards[i])) return;
	}
	if (host && host.isConnected && onScreen(host) && focusWithin(host)) return;
	// `host` can itself be a popover control that closed along with the
	// dialog -- About closes the Help menu it opened from (workspace.js),
	// so `about-btn` goes dark too. Climb to whatever names it in an
	// `aria-controls`, which is the button that opened the popover and is
	// still standing.
	for (var n = host; n; n = n.parentElement) {
		if (!n.id) continue;
		var opener = document.querySelector('[aria-controls="' + n.id + '"]');
		if (opener && tookFocus(opener)) return;
	}
	// Nothing standing could take it: a layer left up inside the phone's closed,
	// hidden drawer (Admin opened from it), or an opener that never had the focus.
	// The page's own first stop, never the body (S1MF-live).
	tookFocus(handOverTarget());
}

/// Focus `el` and report whether it actually took it. `focus()` on a detached
/// or hidden element neither throws nor moves anything. The body is never a
/// landing place: it is where the focus goes when it has gone nowhere, and it
/// is "already focused" whenever an opener was missing.
function tookFocus(el) {
	if (!el || !el.isConnected || typeof el.focus !== 'function') return false;
	if (el === document.body || el === document.documentElement) return false;
	try { el.focus(); } catch (e) { return false; }
	return document.activeElement === el;
}

/// Can `el` take the focus? Boxes are not enough: the phone drawer, closed, keeps
/// its layout and is `visibility: hidden` (GATEFIX r568 a2), and `focus()` on it
/// does nothing and throws nothing (S1MF-live).
function canFocus(el) {
	if (!el || !el.isConnected) return false;
	if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
	if (typeof el.checkVisibility === 'function') {
		return el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
	}
	var cs = window.getComputedStyle ? getComputedStyle(el) : null;
	return !cs || (cs.visibility !== 'hidden' && cs.opacity !== '0');
}

/// Whether an element is actually rendered and able to take the focus.
function onScreen(el) { return canFocus(el); }

/// Where the keyboard goes once the gate is gone: the first candidate that can take
/// the focus. On a phone with no chat, New Chat is inside the closed drawer, which is
/// hidden, so the burger that opens the drawer takes it (S1MF-live).
export function handOverTarget() {
	return ['chat-input', 'new-session-btn', 'new-diamond-btn', 'drawer-btn']
		.map(function (id) { return document.getElementById(id); })
		.filter(canFocus)[0] || null;
}

/// Give the focus to the first thing inside `scope` that will take it, or to
/// `scope` itself. `-1` keeps the container out of the tab order: it is a
/// landing place, not a stop.
function focusWithin(scope) {
	var all = scope.querySelectorAll(
		'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])');
	for (var i = 0; i < all.length; i++) {
		if (onScreen(all[i]) && tookFocus(all[i])) return true;
	}
	if (!scope.hasAttribute('tabindex')) scope.setAttribute('tabindex', '-1');
	return tookFocus(scope);
}

/// One closer, named after what it closes. No handler: the callers below bind
/// their own `close`, which is declared after the button is built.
export function closerFor(name, cls) {
	if (window.DaimondCloser) return DaimondCloser.make({ name: name, cls: cls });
	var b = document.createElement('button');
	b.type = 'button';
	b.className = 'ui-close' + (cls ? ' ' + cls : '');
	b.innerHTML = CLOSE_SVG;		// trusted markup, built here
	b.title = t('common.close');
	b.setAttribute('aria-label', t('common.close_named', { name: name }));
	return b;
}

/// A dialog's title row: its heading, and the way out beside it.
///
/// `name` is what the closer says it closes, so a reader hears "Close Change
/// passphrase" rather than the fourth button in the app called Close. The
/// row is in FLOW, never absolute: `.modal-card` scrolls, and a corner
/// pinned to the viewport would slide away from the card under it.
export function closerRow(titleEl, name, onClose, cls) {
	if (window.DaimondCloser) {
		return DaimondCloser.head('', { titleEl: titleEl, name: name, onClose: onClose, closeCls: cls });
	}
	// closer.js absent: the heading alone, rather than no dialog at all.
	var row = document.createElement('div');
	row.className = 'ui-head';
	row.appendChild(titleEl);
	return row;
}

// Half an hour on a screen nobody is touching, whatever kind of turn-blocking
// wait it is. Shortened by a verifier and never lengthened -- the bargain
// `netAskDeadline` and `publishAskDeadline` already strike below -- because
// `dev/verify_updates.mjs` cannot spend thirty real minutes proving this any
// more than `verify_socialpost.mjs` can spend two.
//
// 2026-09-15: a Publish card stood a full day on the owner's own screen.
// `busy()` stayed true throughout (the turn was genuinely still open, waiting
// on this exact dialog), so the automatic update path held behind it with no
// way to say why -- and nothing bounded the wait, because the drive-fixes
// lane's `PUBLISH_ASK_DEADLINE_MS` only fires when NOBODY is there
// (`req.alone || !isAttended()`); attended-but-ignored was left unbounded.
// This is the general case that incident is one instance of.
var DIALOG_IDLE_MS = 30 * 60 * 1000;
// How long an ask card's silence may still answer it, from the question's own stamp:
// the half hour, and a half hour's grace for a card drawn again (a reload, a sync)
// while the question was still being asked. The real bound, not the verifier's
// shortened one, so a test of the idle answer still meets a current question. See
// `armAskIdleBound`.
export var ASK_SILENT_MAX_MS = 2 * DIALOG_IDLE_MS;

// How long a guarded question ignores Enter, Space and a press of its yes: the
// usual defence against a keystroke or a click meant for something else, whether
// the question was raised unbidden or is a person's own press whose yes grants
// more than the one thing they meant to touch. See `dialog`.
var GUARD_MS = 1000;
export function dialogIdleMs() {
	var n = Number(window.__daimondDialogIdleMs);
	return (n > 0) ? Math.min(n, DIALOG_IDLE_MS) : DIALOG_IDLE_MS;
}

/// The one rule every turn-blocking wait obeys, whatever shape it takes: nobody
/// has touched the page -- pointer, key or a visibility change all count, see
/// `noteInteraction` below -- for `dialogIdleMs()` while it stands, so it takes
/// its own safe answer and the turn ends under its own honest word, exactly as
/// the unattended path already does at two minutes. `dialog()`'s modal is one
/// shape this takes; the ask card (`DaimondAsk`, drawn straight into the
/// transcript rather than through `dialog()`) is the other, and both arm this
/// the same way rather than each keeping its own clock.
///
/// The clock starts at the LATER of "this appeared" and "the page was last
/// touched", never at a stale `_lastInteractAt` of 0 -- a tab nobody has ever
/// interacted with (a fresh runner) would otherwise read as idle since boot,
/// and its first dialog would answer itself within one poll of appearing.
///
/// # Arguments
/// * `isStanding` - Still open and still the one waiting? Polling stops the
///   moment this says no, whether that is because it was answered or because
///   something else replaced it.
/// * `onIdle` - What "answer myself" means here.
export function armIdleBound(isStanding, onIdle) {
	var openedAt = Date.now();
	var ms = dialogIdleMs();
	var poll = Math.max(50, Math.min(15000, ms));
	var timer = setInterval(function () {
		if (!isStanding()) { clearInterval(timer); return; }
		if (Date.now() - Math.max(_lastInteractAt, openedAt) < ms) return;
		clearInterval(timer);
		onIdle();
	}, poll);
	return timer;
}

// ── The questions a turn has up, by its tag (QA r578d-A D2) ──
// A Stop ends the turn's Rust future, so an answer to a question it raised -- the run,
// network or delete dialog, the askChange Pending tile -- reaches nobody, and the
// question stood until its own deadline (2 or 10 min). Each one is filed here under
// the tag of the turn that asked (the payload's `turn`, `ToolContext::turn_tag`), and
// `abortTurn` closes the ones filed under the stopped turn, each with its safe answer.
var _turnAsks = Object.create(null);		// turn tag -> the closers of its questions

/// File a question's closer under its turn; the returned function unfiles it, and is
/// called on every exit. A question with no tag is never filed.
function holdTurnAsk(tag, closer) {
	tag = String(tag || '');
	if (!tag) return function () {};
	var set = _turnAsks[tag] || (_turnAsks[tag] = new Set());
	set.add(closer);
	return function () {
		set.delete(closer);
		if (!set.size && _turnAsks[tag] === set) delete _turnAsks[tag];
	};
}

/// Close every question the turn tagged `tag` has up.
export function closeTurnAsks(tag) {
	tag = String(tag || '');
	var set = tag ? _turnAsks[tag] : null;
	if (!set) return;
	delete _turnAsks[tag];
	set.forEach(function (closer) {
		try { closer(); } catch (e) { /* one that fails leaves the rest to close */ }
	});
}

/// The app's one modal. `opts.deadlineMs`, where a caller sets one, is how long
/// it may stand unanswered before it answers itself: the timer calls
/// `opts.onDeadline` (so the caller can SAY that nobody answered) and then closes
/// the card exactly as Escape does. No caller gets a deadline by default -- a
/// dialog somebody is reading must not be withdrawn from under them -- and only a
/// question whose unanswered outcome is the SAFE one may ask for one. Every
/// dialog, deadline or not, ALSO gets `armIdleBound`'s half-hour backstop below.
/// `opts.guard` marks a question whose yes must not fire from a stray or a held
/// key: a running turn's own question (R6), raised while the person may be
/// typing elsewhere, or a person's own press whose yes grants more than the row
/// on screen (F1, 2026-09-25: "Use here" opened focused on itself, and a held
/// Enter granted a mark nobody meant to confirm). It is focused on its safe
/// button and guarded against a stray key; see `guardUntil`. `opts.turn`, the tag of
/// the turn whose question this is, lets that turn's Stop close it (`holdTurnAsk`).
export function dialog(opts) {
	return new Promise(function (resolve) {
		var back = document.createElement('div');
		back.className = 'modal dlg';
		// `data-kind` on the modal ROOT, and not only in a heading the reader sees: the
		// debug feed's screen seam has to say WHAT is up without reading a translated
		// title. See the `dlg` field in `registerScreen`.
		try { back.setAttribute('data-kind', String(opts.kind || 'confirm')); } catch (e) { /* no setAttribute */ }
		// WHICH question, beside WHAT KIND of card it is. `data-kind` says "confirm",
		// which a dozen cards are; a reader that has to tell one of them from the others
		// -- `dev/naive.mjs`, which cancels a publication and stops rather than answering
		// it -- would otherwise have to match the heading, and a heading is translated.
		// The consent card is told apart by its own tick-box; this is that trick with a
		// name on it.
		if (opts.ask) {
			try { back.setAttribute('data-ask', String(opts.ask)); } catch (e) { /* no setAttribute */ }
		}
		var card = document.createElement('div');
		card.className = 'modal-card dlg-card';

		// Marked, not merely set: a dialog is handed finished strings, so
		// nothing else in the app knows what keys to repaint it from. See
		// `mark`. A dialog left open while the language changes was showing the
		// old one until this line.
		//
		// Except a `pre` dialog, which is the app QUOTING something -- a run's
		// name, its output, a list of paths. That is content, and content that
		// happened to read exactly like a button somewhere would otherwise be
		// translated out from under the user.
		var say = opts.pre ? function (n, v) { n.textContent = v; } : function (n, v) { mark(n, '', v); };

		var h = document.createElement('h2');
		say(h, opts.title || '');
		// The heading and the way out, on one row. Every kind of dialog this
		// helper builds already had a Cancel or an OK at its foot, and on a
		// phone that is a button you scroll to: the confirm that erases an
		// identity puts its Cancel 214px down a card that is taller than the
		// screen. The cross does exactly what Cancel and Escape do -- see
		// `nothing()` -- so a notice, a prompt, a form and a picker all answer
		// it the same way.
		card.appendChild(closerRow(h, opts.title || t('common.close'),
			function () { close(nothing()); }));

		if (opts.message) {
			var p = document.createElement(opts.pre ? 'pre' : 'p');
			p.className = opts.pre ? 'dlg-pre' : 'dlg-msg';
			// A message built as nodes (a sentence holding price tags) goes in
			// whole; a string is escaped.
			if (typeof opts.message === 'string') say(p, opts.message);
			else p.appendChild(opts.message);
			card.appendChild(p);
		}

		var input = null;
		var form = null;
		var picked = null;
		// A `pick` dialog is one whose BODY the caller draws — a browsable
		// list, a grid, anything the three fixed kinds cannot express — while
		// the card, the focus trap, Escape, Enter and the two buttons stay the
		// app's own. It exists so that a new picker is not a new modal: this
		// app has one modal and it should go on having one.
		// A pick body says when its yes can act, and why not when it cannot:
		// `allow(false, why)` while its list is still loading or nothing is
		// chosen, so OK is never pressed on a choice that is not there yet
		// (D-20261006-32). Held here and painted onto the button once it exists.
		// Marked by the answer rule (`DaimondAnswer.gate`): aria-disabled with the
		// reason as its title, and a press that still arrives is answered in the
		// card's own error line rather than dropped.
		var okOn = true, okWhy = '', ok = null;
		function paintOk() {
			if (!ok) return;
			if (guardTimer) { ok.disabled = true; return; }
			DaimondAnswer.gate(ok, okOn ? '' : okWhy);
			if (okOn && err && err.textContent === okLastSaid) { err.textContent = ''; okLastSaid = ''; }
		}
		var okLastSaid = '';
		if (opts.kind === 'pick') picked = opts.build(card, {
			allow: function (on, why) { okOn = !!on; okWhy = on ? '' : (why || t('common.not_ready')); paintOk(); },
		});
		if (opts.kind === 'prompt') {
			// `opts.lines` (2 or more) asks for a field that wraps and shows that many rows at least, growing to
			// the whole of what is in it (to ten rows, then it scrolls): a line of 200 bytes is read, not scrolled
			// past. Every other prompt keeps its one-line field. A secret is always one line.
			var multi = opts.lines > 1 && !opts.secret;
			input = document.createElement(multi ? 'textarea' : 'input');
			input.className = 'dlg-input' + (multi ? ' dlg-area' : '');
			if (multi) input.rows = Math.floor(opts.lines); else input.type = 'text';
			mark(input, 'placeholder', opts.placeholder || '');
			// A passphrase must not sit on screen in the clear. Daimond masks
			// secrets itself (a text field with bullets) rather than using
			// type=password, so no password manager offers to save it.
			if (opts.secret) installSecretMask(input, opts.value || '');
			else input.value = opts.value || '';
			card.appendChild(opts.secret ? secretEye(input) : input);
		}
		if (opts.kind === 'form') {
			form = buildForm(card, opts);
			input = form.first;
		}

		var err = document.createElement('div');
		err.className = 'dlg-err';
		card.appendChild(err);

		var row = document.createElement('div');
		row.className = 'dlg-actions';
		var cancel = null;
		if (opts.cancelLabel !== null) {
			cancel = document.createElement('button');
			cancel.type = 'button';          // never submit an enclosing form
			cancel.className = 'modal-close dlg-cancel';
			mark(cancel, '', opts.cancelLabel || t('common.cancel'));
			row.appendChild(cancel);
		}
		ok = document.createElement('button');
		ok.type = 'button';
		ok.className = 'dlg-ok' + (opts.danger ? ' danger' : '');
		mark(ok, '', opts.okLabel || t('dlg.ok'));
		row.appendChild(ok);
		paintOk();
		card.appendChild(row);

		back.appendChild(card);
		document.body.appendChild(back);
		var lid = DaimondLayers.open(DaimondLayers.uid('dialog'), function () { close(nothing()); });
		// A STOPPED TURN'S QUESTION closes as Escape does: nothing it answers reaches anyone.
		var unhold = holdTurnAsk(opts.turn, function () { close(nothing()); });

		var prev = document.activeElement;
	// Captured while the opener is still in the document: a panel that redraws
	// underneath replaces its CHILDREN and keeps its own box, so this survives
	// where `prev` does not. See `refocus`.
	var prevHost = (prev && prev.closest) ? prev.closest('[id]') : null;
		// Cleared on EVERY exit, an answered one included: a card somebody closed at
		// second three must not have its caller told at second 120 that nobody was
		// there. `close` is the single exit, so one line covers all of them.
		var deadline = null;
		var idleTimer = null;
		// A GUARDED QUESTION lands while the person may still be moving toward
		// something else -- a running turn's own question, raised by nothing the
		// person just did (re-check of 2026-09-23, R6: the held delete took focus
		// onto "Let it go on", and one Space in the composer let a turn delete ten
		// files); or a person's own press whose yes reaches wider than what is on
		// screen, where the OS's own key-repeat can fire it before they have read
		// the question (F1, 2026-09-25: one held Enter opened and then granted
		// "Use here" in the same stroke). So such a card takes focus onto the SAFE
		// button, and for `GUARD_MS` after it appears neither Enter nor Space
		// answers it and its yes cannot be pressed: nobody has read a question that
		// has been up for less than a second, so no key or click in that time is an
		// answer to it. Escape, the cross and the backdrop still close it, because
		// each of those is the safe answer.
		var guardUntil = opts.guard ? Date.now() + GUARD_MS : 0;
		var guardTimer = null;
		function guarded(e) {
			return Date.now() < guardUntil
				&& (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar');
		}
		function onKeyUp(e) {
			if (guarded(e)) { e.preventDefault(); e.stopPropagation(); }
		}
		function close(value) {
			if (unhold) { unhold(); unhold = null; }
			if (deadline) { clearTimeout(deadline); deadline = null; }
			if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
			if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; }
			document.removeEventListener('keydown', onKey, true);
			document.removeEventListener('keyup', onKeyUp, true);
			back.remove();
			DaimondLayers.done(lid);
			refocus(prev, prevHost);
			resolve(value);
		}
		async function submit() {
			if (opts.kind === 'pick') {
				if (!okOn) { err.textContent = okLastSaid = okWhy; return; }
				return close(picked.read());
			}
			// Submitted: every secret on the card is masked again (secret.js).
			Array.prototype.forEach.call(card.querySelectorAll('input'), hideSecret);
			if (opts.kind === 'form') {
				var vals = form.read();
				var bad2 = opts.validate ? await opts.validate(vals) : '';
				if (bad2) { err.textContent = bad2; return; }
				return close(vals);
			}
			if (opts.kind !== 'prompt') return close(true);
			var v = (opts.secret ? getSecret(input) : input.value).trim();
			// A validator returns an error string, or nothing when happy. It
			// may be async (checking a passphrase means deriving a key).
			var bad = opts.validate ? await opts.validate(v) : (v ? '' : 'Enter a name.');
			if (bad) { err.textContent = bad; input.focus(); return; }
			close(v);
		}
		// What a dialog answers when it is dismissed rather than accepted. A
		// confirm says false; every kind that returns a VALUE says null,
		// because `false` is a perfectly good value for one to return.
		function nothing() {
			return (opts.kind === 'prompt' || opts.kind === 'form' || opts.kind === 'pick') ? null : false;
		}
		function onKey(e) {
			// Swallowed in the capture phase, before the focused button sees it: a key
			// that reaches a button presses it, whichever button that is.
			if (guarded(e)) { e.preventDefault(); e.stopPropagation(); return; }
			// Escape is the layer stack's: it closes this card through `close(nothing())`.
			// Not on a `pick`: its body is full of buttons -- a folder to walk
			// into, a row to tick -- and swallowing Enter would make the
			// keyboard route into a folder unreachable.
			if (e.key === 'Enter' && (opts.kind === 'prompt' || opts.kind === 'form')) {
				e.preventDefault(); submit();
			}
			else if (e.key === 'Tab') keepFocusIn(card, e);
		}
		document.addEventListener('keydown', onKey, true);
		if (opts.guard) {
			document.addEventListener('keyup', onKeyUp, true);
			ok.disabled = true;
			guardTimer = setTimeout(function () { guardTimer = null; paintOk(); },
				GUARD_MS);
		}
		back.addEventListener('mousedown', function (e) {
			if (e.target === back) close(nothing());
		});
		if (cancel) cancel.addEventListener('click', function () { close(nothing()); });
		ok.addEventListener('click', submit);
		// `opts.live`, asked at every keystroke of a prompt (U7b lints a proposed note as it is edited), answers the
		// message to show where `validate`'s would be; the yes is withheld while there is one.
		if (input && typeof opts.live === 'function') {
			var live = function () { var m = opts.live(input.value.trim()) || ''; err.textContent = m; ok.disabled = !!m; };
			input.addEventListener('input', live);
			live();
		}

		if (input && input.tagName === 'TEXTAREA') {
			var fit = function () {
				input.style.height = 'auto';
				var cs = getComputedStyle(input), lh = parseFloat(cs.lineHeight) || 20, pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
				// A border-box field's height holds its borders, which scrollHeight does not: without them the last row is short by two pixels.
				var bd = cs.boxSizing === 'border-box' ? (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0) : 0;
				input.style.height = Math.min(input.scrollHeight + bd, Math.ceil(lh * 10 + pad + bd)) + 'px';
			};
			input.addEventListener('input', fit);
			fit();
		}
		(input || (opts.guard && cancel) || ok).focus();
		if (input) input.select();
		// The self-answer, wired LAST so nothing above it can fire early. It closes
		// with `nothing()` -- the value Escape, Cancel, the cross and the backdrop all
		// give -- because a question nobody answered is not a different ANSWER from one
		// somebody declined; `onDeadline` is how the caller tells the two apart in what
		// it writes down.
		if (opts.deadlineMs > 0) {
			deadline = setTimeout(function () {
				try { if (opts.onDeadline) opts.onDeadline(); } catch (e) { /* close anyway */ }
				close(nothing());
			}, opts.deadlineMs);
		}
		// THE BACKSTOP EVERY DIALOG GETS, a caller's own deadlineMs or none. A
		// caller's deadline above is a SHORTER, caller-specific judgement about an
		// UNATTENDED screen, and fires first where it applies; this catches what
		// that judgement does not -- an ATTENDED screen nobody is actually looking
		// at any more, which is exactly what stood open for a day on 2026-09-15.
		// Not folded into `opts.onDeadline`: that callback's own wording (e.g. the
		// publish card's "on a screen nobody was at") is written for the SHORT,
		// unattended deadline and would misdescribe this one, so this logs its own
		// generic line instead.
		idleTimer = armIdleBound(function () { return document.body.contains(back); },
			function () {
				trail('dialog idle', 'Nobody touched the page for '
					+ Math.round(dialogIdleMs() / 60000) + ' min while "'
					+ (opts.ask || opts.title || opts.kind || 'a dialog')
					+ '" stood open, so it took its own safe answer and the turn ended.');
				close(nothing());
			});
	});
}

/// Ask the user to confirm. Resolves true when they do.
export function confirmDialog(message, okLabel, opts) {
	opts = opts || {};
	return dialog({
		kind: 'confirm',
		title: opts.title || t('dlg.are_you_sure'),
		message: message,
		okLabel: okLabel || t('dlg.ok'),
		cancelLabel: opts.cancelLabel,        // a caller may rename the second button.
		danger: opts.danger !== false,
		// Forwarded rather than reimplemented by every caller that needs one: `dialog`
		// owns the self-answer and clears it on every exit. `ask` names WHICH question
		// this is, for a reader that cannot match a translated title -- see `dialog`.
		deadlineMs: opts.deadlineMs,
		onDeadline: opts.onDeadline,
		ask: opts.ask,
		guard: opts.guard,
		turn: opts.turn,
	});
}

/// Ask the user for a line of text. Resolves the string, or null if cancelled. `opts.lines` (2 or
/// more) gives the field that many rows to wrap in; the answer is still one line.
export function promptDialog(title, opts) {
	opts = opts || {};
	return dialog({
		kind: 'prompt',
		title: title,
		message: opts.message || '',
		value: opts.value || '',
		placeholder: opts.placeholder || '',
		okLabel: opts.okLabel || 'OK',
		validate: opts.validate,
		live: opts.live,
		secret: !!opts.secret,
		lines: opts.lines,
		danger: false,
	});
}

/// Tell the user something. Resolves when they dismiss it.
export function noticeDialog(title, message, opts) {
	opts = opts || {};
	return dialog({ kind: 'notice', title: title, message: message, okLabel: 'OK',
		danger: false, cancelLabel: null, pre: !!opts.pre, ask: opts.ask })
		.then(function () { return true; });
}

// ── The held delete ─────────────────────────────────────────────────
//
// A turn has deleted as many files from the folder the user opened on this computer
// as a turn may delete there without asking (8 unless they set otherwise), and the
// engine is holding its next delete until the PERSON says whether it may go on --
// decision review of 2026-09-23, decision 2: sixty-four deletes on a real disk, each
// carried off the machine at once by whatever syncs the folder, is a bulk delete
// however well each copy is kept. `src/wasm/deletes.rs` asks through here.
//
// ASKED WITH THE CONFIRM DIALOG DIRECTLY, never through `egressAllowed`, because that
// door answers yes for an unattended turn under the autonomous posture -- and whether
// a model may go on deleting somebody's files is the one question no posture answers
// for them. The machine hand's held command is asked the same way for the same reason.
// Nobody answering is a stop: the dialog answers no on its own before 110 seconds.
//
// ONE QUESTION PER TURN'S STORE. A daimon and its workers share one count, and each
// of them reaching the limit at once is still one decision, so a second ask while the
// first is up is given the first one's answer.
//
// EXCEPT WHERE THE PERSON ASKED TO BE ASKED ABOUT EVERY FILE (re-check of 2026-09-23,
// R7). "Ask before every one" asked once and let the rest of the turn go on the first
// yes. At that setting each file is its own question and a yes covers that file alone,
// so the questions are put one after another, never shared -- and after a stop, which
// is final for the turn, the ones still in line are stopped with it, unasked.
//
// ASKED UNBIDDEN (R6). The question arrives while the person may be typing elsewhere,
// and it took focus onto "Let it go on": one Space in the composer let a turn delete
// ten files. `dialog` now puts it on Stop and lets no key answer it for a second.
//
// DELETING OR WIPING. Since the re-check of 2026-09-23 (R4) the count holds a turn's
// writes there that leave less than half of a file as well -- a file emptied of most of
// itself is the same loss as a file deleted -- so the words say both, and name which one
// the turn wants next: the engine sends `act`, `delete` or `wipe`.
var _deleteAsks = Object.create(null);		// keeper -> the answer to the question up
var _deleteLine = Object.create(null);		// keeper -> the last one-file question in line

/// Who is asking, as the person knows them: the Diamond's name, or the chat's.
function deleteAsker(keeper) {
	var k = String(keeper || '');
	if (k.indexOf('chat:') === 0) {
		var c = pg.chats.find(function (x) { return x.id === k.slice(5); });
		return (c && c.name) ? '"' + c.name + '"' : t('deletes.a_chat');
	}
	var d = pg.diamonds.find(function (x) { return x.id === k; });
	return d ? '"' + d.name + '"' : t('deletes.a_daimon');
}

/// Put one held-delete question to the person; resolves true only on their yes.
function askHeldDelete(body, title, allow, turn) {
	return confirmDialog(body, allow, {
		title: title,
		cancelLabel: t('deletes.held_stop'),
		danger: true,
		deadlineMs: 110000,
		onDeadline: function () { return false; },
		ask: 'delete-held',
		guard: true,
		turn: turn,
	}).then(function (yes) { return yes === true; }, function () { return false; });
}

// ── A change to a file he made, asked first (UNBLOCK-26 U5) ──
// The engine holds an edit, delete or move of a file the keeper did not make and asks
// here (`ask_change`, src/wasm/deletes.rs), the change drawn as a History-style diff. A
// turn handed off from another device is asked on THAT device through the permit route;
// every other turn on a Pending tile here, its chat's caption saying so. NEVER through
// `egressAllowed`: no posture, the autonomous one included, answers this question. Only
// his Apply is 'apply' and only his Don't Change is 'refused'; ten minutes unanswered, a
// reload, a tile that could not be raised: all 'unanswered', and nothing is written.
var CHANGE_WORD = { allow: 'apply', deny: 'refused' };

/// How long a change ask waits for him: the engine's own wait, else ten minutes. The
/// same on a Pending tile here and on the device a handed-off turn came from (lead,
/// r573): never the permit route's 60 s, and silence there is still 'unanswered'.
function changeWaitMs(req) {
	return Math.max(1000, Number(req && req.wait) || 600000);
}

/// A store path as the person reads it: the file's name and the folder it sits in.
export function changeName(path) {
	var p = String(path || ''), i = p.lastIndexOf('/');
	return { name: i >= 0 ? p.slice(i + 1) : p, folder: i > 0 ? p.slice(0, i) : '/' };
}

/// The headline for a change ask, by what the change does.
function changeHead(req) {
	var key = req.act === 'delete' ? 'change.head_delete'
		: req.act === 'move' ? 'change.head_move' : 'change.head';
	return t(key, { name: changeName(req.path).name });
}

/// The chat the keeper's turn is running in, or null: a chat keeper names itself, a
/// Diamond's turn is the one generating on it.
function changeChat(keeper) {
	var k = String(keeper || '');
	if (k.indexOf('chat:') === 0) return pg.chats.find(function (c) { return c && c.id === k.slice(5); }) || null;
	return pg.chats.find(function (c) { return c && c.diamondId === k && c._generating; }) || null;
}

/// Put a change to the person and resolve the engine's word: 'apply', 'refused' or
/// 'unanswered' (`held_change::Answer::from_word`).
function askChange(payload) {
	var req;
	try { req = JSON.parse(String(payload || '')); } catch (e) { req = null; }
	if (!req || typeof req !== 'object' || !req.path) return Promise.resolve('unanswered');
	var rc = permitRunnerTurn({ turn: req.turn });
	if (rc) {
		return Promise.resolve(routePermitAsk(rc, 'change', String(req.path), JSON.stringify(req), changeWaitMs(req)))
			.then(function (w) {
				if (w === DaimondPeer.PERMIT_YES.change) return 'apply';
				return w === DaimondPeer.permitNoWord('refused') ? 'refused' : 'unanswered';
			}, function () { return 'unanswered'; });
	}
	var keeper = String(req.keeper || ''), chat = changeChat(keeper);
	var did = keeper.indexOf('chat:') === 0 ? ((chat && chat.diamondId) || '') : keeper;
	var d = did ? pg.diamonds.find(function (x) { return x.id === did; }) : null;
	var id = null;
	try {
		id = Pending.add({
			kind: 'consent', headline: changeHead(req), detail: '', change: req, priority: 'high',
			diamondId: d ? d.id : '', diamondName: d ? d.name : '',
		});
	} catch (e) { id = null; }
	if (!id) return Promise.resolve('unanswered');
	var words = t('change.waiting', { name: changeName(req.path).name });
	var prev = chat ? chat._busy : null;
	if (chat) busySay(chat, words, true);
	var wait = changeWaitMs(req);
	return new Promise(function (resolve) {
		var timer = setTimeout(function () {
			if (settleConsent(id, 'timeout')) {
				try { Pending.fresh(); Pending.render(); } catch (e) { /* the panel is not up */ }
			}
		}, wait);
		// ITS TURN STOPPED (D2): nobody is left to apply the change, so the tile comes
		// down, answered as unanswered -- he did not refuse it.
		var unhold = holdTurnAsk(req.turn, function () {
			settleConsent(id, 'timeout');
			try { Pending.drop(id); Pending.render(); } catch (e) { /* the panel is not up */ }
		});
		_parked[id] = function (verdict) {
			unhold();
			clearTimeout(timer);
			if (chat && chat._busy === words) busySay(chat, prev || tOr('chat.busy', 'Thinking…'));
			resolve(CHANGE_WORD[verdict] || 'unanswered');
		};
	});
}
// page-split: install 93

// ── Reaching out, after reading a stranger's words ─────────
// The agent reads web pages and email, and a page can carry instructions
// aimed at the agent rather than at the reader. Marking that content as
// untrusted tells the model what it is; it does not stop a model that goes
// along with it anyway. What actually stops it is this: once a turn has taken
// in content from outside, reaching a NEW destination needs the user.
//
// The channel being closed is a URL. Anything the agent knows can be written
// into a path or a query string, so a fetch of
// `https://somewhere/?notes=<your file>` is an exfiltration whatever the page
// at the other end does with it.
//
// The gate is deliberately narrow. An untainted turn is never asked — the
// wasm side does not even call this. So ordinary browsing is untouched, and
// the prompt appears at the one moment it means something.
//
// AND IT IS ASKED ONCE. Reading was gated per SITE here, in `_egressOk`, and
// the note is what is left of it because the shape it had is the reason the
// shape it has now was chosen. A host was remembered in this object, which
// lives as long as the page: so every new site put the question again, and a
// yes given in one chat silently answered for the next one, and for every
// daimon in the tab. The owner ruled on 2026-08-27 that both were wrong —
// "I should only be asked once in a session ... for permission to access ANY
// (not a specific website)". So the answer moved to the engine, where a
// conversation is a thing that exists: see `TurnState::web_consent` and
// `web_step` in src/tools.rs. Nothing on this side remembers a read any more,
// and nothing on this side may, or the first ask of the next conversation
// would be skipped by a yes that conversation never gave.
//
// ACTING ON A PAGE IS UNTOUCHED and stays per host, below. Reading a site and
// operating one are different questions and always have been: a yes about
// reading the web is not a yes about pressing buttons on it.
var _egressAct = Object.create(null);	// hosts approved for ACTING on, this session.
// Search consent, for the turn. Keyed on the DaimondApp instance itself, which
// is not a convenience: the engine keeps its turn state on the `ToolContext`
// built in `DaimondApp::new` and never reset, so THE APP OBJECT IS THE TURN,
// on both sides of the boundary. A chat whose app is rebuilt — a fresh chat, a
// continued interrupted turn — is a fresh turn to the engine and is a fresh
// turn here, with no second rule to keep in step. Weak, so an answer cannot
// outlive the app it belongs to.
var _searchTurn = new WeakMap();

/// The app whose turn is asking, or null when that cannot be told.
///
/// The gate is one global function and the payload names no chat (see
/// `egress_ask_js` in src/wasm/web.rs: it carries tool, url, detail and alone,
/// and nothing that identifies the caller). So the asking app is inferred from
/// which chat is generating, and when that is not exactly one — none, several
/// at once, or a dispatched worker, which has a context of its own and must
/// never share an answer — this says so and the caller asks again.
///
/// FAILS TOWARDS THE DIALOG. Not knowing whose turn it is costs a question
/// that was already going to be asked; guessing would spend somebody else's
/// consent. The proper repair is for the engine to carry a turn id in the
/// payload, at which point this becomes a lookup and the ambiguity goes.
function askingTurn(req) {
	if (!req || req.alone) return null;
	var live = pg.chats.filter(function (c) { return c && c._generating && c.app; });
	return live.length === 1 ? live[0].app : null;
}

function egressHost(url) {
	try { return new URL(String(url), location.href).host || ''; }
	catch (e) { return ''; }
}

// Approving a host cannot be the end of it. The channel being closed is the
// URL itself, so "yes, you may read example.com" would otherwise license
// every later `example.com/?everything-I-know=…` — the same exfiltration,
// waved through on the strength of an answer about something else.
//
// But asking per exact URL would prompt on every page of a documentation
// site, and a question asked that often stops being read. So the host is
// approved for ORDINARY addresses, and an address carrying a payload is
// asked about on its own terms, however familiar the host.
var EGRESS_PAYLOAD_MAX = 120;			// characters of path, query and fragment.
var EGRESS_BLOB = /[A-Za-z0-9+/=_-]{60,}/;	// one long unbroken run: encoded, not typed.

/// The part of a URL that could be carrying data out, and whether it is more
/// than an address plausibly needs.
function egressPayload(url) {
	var u;
	try { u = new URL(String(url), location.href); }
	catch (e) { return { text: '', heavy: false }; }
	var tail = (u.pathname || '') + (u.search || '') + (u.hash || '');
	return {
		text:  tail,
		heavy: tail.length > EGRESS_PAYLOAD_MAX || EGRESS_BLOB.test(tail),
	};
}

/// Whether the agent may reach `url` now that this turn has read untrusted
/// content. Resolves the string the wasm side expects.
/// Put a permission mode into the engine, and prove it went in.
///
/// The engine's copy is the only one that decides anything, so this does not
/// report success from the absence of a throw: it reads the mode back and
/// refuses when the two disagree. Everything that can go wrong here — an older
/// wasm with no such edge, a name this build does not know, a setter that took
/// and did not stick — ends the same way, with the caller told nothing changed
/// and the chip redrawn from what is actually in force.
///
/// # Arguments
/// * `name` - The mode's name, as the Rust `Mode::name` spells it.
export function applyPermissionMode(name) {
	if (!Wasm || typeof Wasm.set_permission_mode !== 'function') {
		throw new Error('This build of the engine has no permission ladder.');
	}
	Wasm.set_permission_mode(name);
	var now = (typeof Wasm.permission_mode === 'function') ? Wasm.permission_mode() : name;
	if (now !== name) {
		throw new Error('The engine is in ' + now + ', not ' + name + '.');
	}
	return now;
}

/// Confine a dispatched agent to one Diamond's workspace, and prove it went in.
///
/// **This is a security boundary and it is set from JavaScript, so it is read back.** A
/// scope that throws and is ignored, or one that silently fails to take, leaves the agent
/// with the reach of an ordinary workspace turn: its file tools may CHANGE anything in the
/// workspace, and — because both doors read the one bound list — its commands are fenced to
/// the whole folder the user granted the machine hand rather than to this Diamond's part of
/// it. That is failing open, so it throws rather than returning false, and the caller does
/// not start a turn on a scope it could not establish.
///
/// **What is read back is `write_allow`.** A scope fences writing and running, and leaves
/// reading free inside the workspace the user already opened (`Bound::OnlyWriteUnder` in
/// src/tools.rs). `allow` — the both-verb list — is empty for every scope this build
/// composes, so a check written against it would refuse every turn.
///
/// **This field and the one in `scopeChatTo` are ONE field with TWO readers, and it has
/// been wrong in both directions inside a week** — `write_allow` when the engine had moved
/// to `allow`, then `allow` when it moved back. Each time every scoped turn on that surface
/// refused to start. Change one of these two and you are changing both: `diamond_scope`
/// reports both lists precisely so a reader has to say which it means.
///
/// The same discipline as `applyPermissionMode`: set it, ask the engine what it now holds,
/// and refuse on disagreement.
///
/// # Arguments
/// * `app` - The freshly built DaimondApp.
/// * `diamondId` - The Diamond this agent works for.
export async function scopeAgentTo(app, diamondId, given) {
	if (!app || typeof app.set_diamond_scope !== 'function'
		|| typeof app.read_scope_reach !== 'function'
		|| typeof app.diamond_scope !== 'function') {
		throw new Error('This build of the engine cannot confine an agent to a diamond.');
	}
	if (!diamondId) {
		throw new Error('An agent was dispatched without a diamond to work in.');
	}
	// `given` is the bounds a caller has just read and will compare against later.
	var b = given || await Files.bounds(diamondId);
	if (!b.own_dir) {
		throw new Error('That diamond has no directory, so there is nothing to confine it to.');
	}
	// The marks are the engine's to read (HIST-SAFE U2); only the toolkits are the page's.
	// The read is an async call and the apply a synchronous one, so the marks are read by the
	// engine and applied in one step (ENGINE-REENTRY; both take `&self` since U3a).
	var reach = await app.read_scope_reach(String(diamondId));
	app.set_diamond_scope(reach, JSON.stringify(b.toolkits || []));

	// What the engine actually holds now. Compared rather than trusted: everything that can
	// go wrong here is silent, and every silent failure is in the direction of more reach.
	var got = {};
	try { got = JSON.parse(app.diamond_scope() || '{}') || {}; }
	catch (e) { throw new Error('The engine could not say what this agent is confined to.'); }
	if (got.nowhere) {
		throw new Error('That diamond\'s workspace named no usable folder, so an agent in it '
			+ 'could not touch anything.');
	}
	var allow = Array.isArray(got.write_allow) ? got.write_allow : [];
	if (!allow.length) {
		throw new Error('The scope did not take: this agent is not confined to anything.');
	}
	if (allow.indexOf(b.own_dir) < 0) {
		throw new Error('The scope took, but not for this diamond: the engine holds '
			+ allow.join(', ') + ' and not ' + b.own_dir + '.');
	}
	// A toolkit the user granted and the engine dropped is a grant that will not work, and
	// the daimon is about to be TOLD it has that toolchain. Better to say so than to let it
	// meet a refusal it can do nothing about.
	var want = (b.toolkits || []).slice().sort().join(',');
	var have = (Array.isArray(got.toolkits) ? got.toolkits : []).slice().sort().join(',');
	if (want !== have) {
		throw new Error('This diamond is granted ' + (want || 'no toolchain')
			+ ', but the engine took ' + (have || 'none') + '.');
	}
	return got;
}

/// Mark a dispatched worker as acting alone, and prove the mark went on.
///
/// **This is a security mark set from JavaScript, so it is read back**, for the same reason
/// `scopeAgentTo` reads its scope back: everything that can go wrong here is silent, and
/// every silent failure is in the direction of LESS asking. A worker that failed to be
/// marked is one that can press a button on a page the user is signed into with nobody
/// asked at all.
///
/// What it buys, and it is not a fence: before a worker clicks or types on a page, the user
/// is shown what is about to happen and decides. `SAFETY_CLAUSE` in src/prompts.rs tells
/// every agent never to do anything irreversible without a plain yes, and `DEFAULT_WORKER`
/// tells a worker two paragraphs earlier that it cannot ask questions. Nothing reconciled
/// those two sentences until this: a fence is a list of paths and the acts in that clause
/// are buttons.
///
/// # Arguments
/// * `app` - The freshly built DaimondApp for one worker.
// ── A worker's two starts (r578c; D-20261020-05) ───────────────────────
//
// THE PATHS SPLIT ON `run.fork`.  A fork worker carries the id of the engine's copy of its
// parent's request (`spawn_agent_page` in src/tools.rs) and adopts it after every build:
// the parent's system message, tools array and messages, byte for byte, then one user
// message with its role and task (`worker_handoff`).  A brief worker -- no id, a copy gone
// (a reload), a continuation or a resume -- keeps the old start: the worker role and crystal
// as its system prompt (`build`) and the task as its first message.

/// Will this run start as a copy?  The parent chose (`spawn_agent`'s `context`, read in the
/// engine, which sends no id for "brief"); a continuation or a resume starts brief.
export function forkable(run) {
	return !!run.fork && !run.resume && !(run._priorSession && run._priorSession.length);
}

/// The kind a worker ran as, for the lens and the report heading: "full" or "brief".
export function workerKind(run) { return run && run.forked ? 'full' : 'brief'; }

/// The kind for a report heading: as `workerKind`, saying so when a copy was asked for and
/// was gone by the time the worker started (n1), since the parent was told it would be full.
export function workerKindSaid(run) {
	return run && run.fellBack ? 'brief: its copy of the conversation was gone when it started'
		: workerKind(run);
}

// THE KIND IS SAID WHEN IT IS KNOWN (n1). A worker's kind is settled at adoption, which is
// after its mint and its fence; `spawn` answers a worker running now only then, so the
// STARTED line never calls full a worker whose copy went while it waited.

/// Settle the kind `run` started as and answer whoever waits on it.  Idempotent: the first
/// settle stands, since a re-mint's adoption cannot change what was already announced.
export function settleKind(run) {
	if (run.kindSettled) return;
	run.kindSettled = true;
	var w = run._kindWait || [];
	run._kindWait = null;
	w.forEach(function (f) { f(workerKind(run)); });
}

/// The kind `run` started as, once it has: at adoption, or at a start that fell short.
export function startedKind(run) {
	if (run.kindSettled) return Promise.resolve(workerKind(run));
	return new Promise(function (f) { (run._kindWait = run._kindWait || []).push(f); });
}

/// Adopt the parent's copy onto `run.app`, or leave a brief worker.  Sets `run.forked`, and
/// `run.fellBack` when a copy was asked for and is gone.
export function adoptFork(run) {
	run.forked = false;
	run.fellBack = false;
	if (forkable(run) && run.app && typeof run.app.adopt_fork === 'function') {
		try { run.app.adopt_fork(run.fork); run.forked = true; }
		catch (e) { run.fellBack = true; /* the copy is gone: the brief start stands */ }
	}
	settleKind(run);
}

/// A worker's first message: the hand-off for a fork worker, the task for a brief one.
export function firstAsk(run) {
	if (!run.forked) return run.task;
	try { return Wasm.worker_handoff((Prompts && Prompts.md.worker) || '', run.task || ''); }
	catch (e) { return run.task; }
}

/// Drop the engine's copy once the worker is over.  Idempotent.
export function forkForget(run) {
	if (!run || !run.fork) return;
	try { Wasm.fork_forget(run.fork); } catch (e) { /* an older engine holds none */ }
}

export function markAlone(app) {
	if (!app || typeof app.set_unsupervised !== 'function'
		|| typeof app.is_unsupervised !== 'function') {
		throw new Error('This build of the engine cannot tell a worker it is working alone.');
	}
	app.set_unsupervised();
	if (app.is_unsupervised() !== true) {
		throw new Error('This worker could not be marked as working alone, so nothing would '
			+ 'ask the user before it acted on a page.');
	}
}

/// A chat's fence inputs, in the shape `Files.bounds` gives a Diamond's. The one
/// source for both `scopeChatTo` and the Workspace "Can change" rows, so the two
/// cannot disagree about what the chat may write.
/// A chat's holdings as the engine reads them, `[{ref, path, ws, state}]`: the synced half
/// only. The engine counts each where this device's record has the press (HIST-SAFE U2).
export function chatHoldsJson(chatId) {
	return JSON.stringify(chatAttachList(chatId).map(function (a) {
		return { ref: String(a.ref || ''), path: String(a.path || ''), ws: !!a.ws,
			state: String(a.state || '') };
	}));
}

export async function chatBounds(chatId) {
	return {
		own_dir:     chatScratchDir(chatId),
		attached:    await chatScopePaths(chatId),
		read_only:   [],
		toolkits:    [],
		unconfirmed: chatWaiting(chatId).filter(function (a) { return !!a.ws; })
			.map(function (a) { return a.path; }),
	};
}

// ── Recent: the files a daimon, chat or worker last wrote ─────
//
// A Diamond's ring is `diamonds/<id>/recent.json`, in its own folder so it travels
// with the Diamond (and never under `.daimond/`, which is this device's record). A
// plain chat's rides on the chat record as `recent`. Appends to one Diamond are
// chained, so two writes landing together cannot each read the old ring.
var _recentChain = {};

/// Note a finished write in the ring of whatever did it.
///
/// # Arguments
/// * `who` - `{ diamond: id }` or `{ chat: id }`.
export function noteRecent(who, tool, args) {
	var path = window.DaimondRecent ? DaimondRecent.pathOf(tool, args) : '';
	if (!path || !who) return;
	var e = { path: path, place: DaimondMarksHere.isStorePath(path) ? '' : rootHere(), at: Date.now() };
	if (who.chat) {
		var c = pg.chats.find(function (x) { return x.id === who.chat; });
		if (!c) return;
		c.recent = DaimondRecent.append(c.recent, e);
		persistChats();
		try { Files.renderFocus(); } catch (er) { /* no panel yet */ }
		return;
	}
	var id = who.diamond;
	if (!id) return;
	_recentChain[id] = (_recentChain[id] || Promise.resolve()).then(async function () {
		var ring = await readRecent(id);
		try { await Wasm.store_write(DaimondRecent.ringPath(id), DaimondRecent.serialise(DaimondRecent.append(ring, e))); }
		catch (er) { return; }		// no store: the ring is a convenience, never a failure
		try { Files.renderFocus(); } catch (er2) { /* no panel yet */ }
	});
}

export async function readRecent(id) {
	if (!id || !window.DaimondRecent) return [];
	try { return DaimondRecent.parse(await Wasm.store_read(DaimondRecent.ringPath(id))); }
	catch (e) { return []; }		// none written yet
}

/// Confine a chat to its WORKSPACE: the folders the user marked into it, and nothing else.
///
/// **One function for the conversation and for every worker it dispatches**, because they
/// are one blast radius. The asymmetry that used to live here was a SURFACE one — a worker
/// fenced, the conversation not — and it was answered on 2026-08-11, when a daimon in an
/// ordinary chat edited two files of the user's own book in a directory under no version
/// control. No worker was involved, so a worker-only fence could not have helped.
/// `chat_bounds` in src/tools.rs IS `diamond_bounds`, so both surfaces are fenced by one
/// rule — and that rule fences the VERB: writing and running go where the user marked, and
/// reading is free inside the workspace they already opened.
///
/// **The mark is the permission, and nothing here asks anything.** The friction is paid once,
/// when a folder is marked into the workspace; inside it the model works as freely as before.
///
/// **What is handed over is the MARKED set and not the paperclip's whole list** — see
/// `chatScopePaths`. Note and Read are a cost decision about what is quoted into the prompt
/// and grant no reach whatever, so a caller passing everything attached would have made Note
/// into a grant.
///
/// Set, then read back and compared, exactly as `scopeAgentTo` is. A scope that failed
/// silently would leave a turn with the reach of the whole workspace.
///
/// # Arguments
/// * `app` - The freshly built DaimondApp — the chat's own, or a worker's.
/// * `chatId` - The chat whose workspace this is.
export async function scopeChatTo(app, chatId) {
	if (!app || typeof app.set_chat_scope !== 'function'
		|| typeof app.diamond_scope !== 'function') {
		throw new Error('This build of the engine cannot confine a chat.');
	}
	if (!chatId) {
		throw new Error('A turn was started without a chat to work for.');
	}
	var b = await chatBounds(chatId);
	var scratch = b.own_dir;
	// THE ENGINE SAYS WHAT IS IN FORCE (HIST-SAFE U2): it is handed the chat's holdings, the
	// synced half, and counts each only where this device's record has the press. What is
	// waiting for a press is worked out there too, and named in a refusal so the model asks
	// the user to confirm it here (audit finding 6).
	// The engine derives the scratch from the chat id itself (QA B F1); `scratch` is only
	// the read-back check below.
	app.set_chat_scope(String(chatId), chatHoldsJson(chatId));

	var got = {};
	try { got = JSON.parse(app.diamond_scope() || '{}') || {}; }
	catch (e) { throw new Error('The engine could not say what this chat is confined to.'); }
	if (got.nowhere) {
		throw new Error('This chat\'s scope named no usable place, so nothing in it could '
			+ 'read or write anything at all.');
	}
	// The WRITE allow-list is what a chat carries, exactly as a Diamond does. This field has
	// now been wrong in both directions inside a week — first `write_allow` when the engine
	// had moved to `allow`, then `allow` when it moved back — and each time every scoped
	// turn refused to start. Fenced in the safe direction, and still a break, which is why
	// `diamond_scope` reports both and this names the one it means.
	var allow = Array.isArray(got.write_allow) ? got.write_allow : [];
	if (!allow.length) {
		throw new Error('The scope did not take: this chat is not confined to anything.');
	}
	if (allow.indexOf(scratch) < 0) {
		throw new Error('The scope took, but without this chat\'s own folder: the engine '
			+ 'holds ' + allow.join(', ') + ' and not ' + scratch + '.');
	}
	return got;
}

// ── The asynchronous half of consent ───────────────────────
//
// Everything above this line is a DIALOG, and a dialog only works on somebody
// who is looking at it. A dispatched worker acts while the user is somewhere
// else — that is what dispatching one is FOR — so the question it cannot ask
// for itself was being put to an empty room: the modal went up behind a tab
// nobody had in front of them, the worker sat on it holding a slot in the
// pool, and the user came back to a dialog with no context and pressed
// Escape. A refusal by dismissal is how the work died.
//
// So when the question cannot be answered where it stands, it is raised on
// the PENDING panel instead and the worker waits on the tile. The three
// answers that panel already offers are exactly the three this question has:
// do it, discuss it first, drop it.
//
// THE WORKER GENUINELY RESUMES. `egressAllowed` returns a promise, the engine
// awaits it (`egress_allowed_act`, src/wasm/web.rs), and answering the tile
// resolves that promise — so a yes is the tool call carrying on from where it
// stopped, not a fresh dispatch, and the driver sees the click at the moment
// the tick is pressed. What does NOT survive is a reload: a promise is
// memory, so a tile whose page has gone is marked expired when it is loaded
// and says so, rather than offering a tick that would do nothing. See
// `Pending.load`.

/// Whether a question put on the screen right now could actually be answered.
///
/// Two ways for the answer to be no, and both are facts rather than guesses
/// about somebody's attention:
///
///   * the document is not on screen — another tab, another window, a locked
///     phone. A modal raised into a hidden page is not asked, it is queued.
///   * a dialog is already up. A second one stacks on the first, neither says
///     which agent it belongs to, and the one underneath cannot be reached.
///
/// A VISIBLE TAB THE USER HAS WALKED AWAY FROM STILL GETS THE DIALOG. There is
/// no honest signal for "in the room", and one invented out of idle time would
/// withdraw a question from under somebody halfway through reading it — which
/// is a worse failure than the one being fixed.
function someoneCanAnswer() {
	try {
		if (document.visibilityState === 'hidden') return false;
		if (document.querySelector('.modal.dlg')) return false;
	} catch (e) { return false; }		// no document at all: nobody to ask.
	return true;
}

// The ATTENTION signal a live consent routes on: not a bare heartbeat but
// foreground + a recent interaction, so a runner sends its question only to a
// device a person is actually ON. Routing to an awake-but-unwatched device would
// simply relocate the invisible stall it exists to fix. `_lastInteractAt` is
// stamped on real input; a device visible but idle past the window is not attended.
//
// The same stamp is `armIdleBound`'s clock, above -- one signal of "somebody is
// there", read on two different windows (90s for routing, 30 min for a
// turn-blocking wait), rather than two clocks that could disagree about it.
var _lastInteractAt = 0;
var ATTENDED_IDLE_MS = 90 * 1000;	// interaction older than this is not "at the device"
function noteInteraction() { _lastInteractAt = Date.now(); }
// page-split: install 94

/// Is a person AT this device now -- foreground and recently interacting? The
/// attention half of the presence beat; the runner's routing reads it (via
/// `attendedPeer`) and, when it cannot be positively determined for any device,
/// parks rather than routing a question nobody will see.
export function isAttended() {
	try {
		if (document.visibilityState !== 'visible') return false;
		return (Date.now() - _lastInteractAt) <= ATTENDED_IDLE_MS;
	} catch (e) { return false; }
}

// This computer's standing answer to "may you act unattended". It lives in
// localStorage and NOWHERE ELSE, because it is a fact about THIS machine — its
// owner has told it to finish dispatched work on its own — and it must not ride
// the sync parcel: arming argonaut must not arm the phone. `collectSync` packs a
// fixed, named set of fields, so a key it does not name never travels, and this
// one is not named there. See `dev/verify_autonomous_posture.mjs`, which asserts
// it stays out of the parcel. The toggle that writes it lives in `handmode.js`,
// which reaches this same key by the same name.
var AUTONOMOUS_KEY = 'daimond-autonomous-posture';

/// Does THIS computer hold the autonomous posture?
///
/// Off by silence: a machine where it was never turned on reads false and keeps
/// today's ask-and-park behaviour untouched. Any read error is false too —
/// private mode, no storage, a value this build cannot make sense of — because
/// the careful reading of "I cannot tell" is "keep asking". Per-computer and
/// never synced; see `AUTONOMOUS_KEY`.
export function autonomousPosture() {
	try { return localStorage.getItem(AUTONOMOUS_KEY) === '1'; }
	catch (e) { return false; }
}

// THIS COMPUTER's step-away posture: whether a turn it is running should be
// handed to another live device when this one is stepped away from — the lid
// closes, the tab is closed, the network drops. Device-local and never synced,
// exactly like the autonomous posture above it and for the same reason: turning
// it on here must not turn it on elsewhere. It is NOT named in `collectSync`, so
// it never rides the parcel. The toggle that writes it lives in `handmode.js`,
// which reaches this same key by the same name.
var HANDOFF_AWAY_KEY = 'daimond-handoff-when-away';

/// Does THIS computer hand its turns to another device when stepped away from?
///
/// Off by silence, and false on any read error, for the reason `autonomousPosture`
/// reads false when it cannot tell: the careful reading of "I do not know" is to
/// leave the turn where it is. Per-computer and never synced; see `HANDOFF_AWAY_KEY`.
export function handoffWhenAway() {
	try { return localStorage.getItem(HANDOFF_AWAY_KEY) === '1'; }
	catch (e) { return false; }
}

// Requests parked on the Pending panel, by tile id, each holding the
// `resolve` of the promise the engine is awaiting. In memory, and
// deliberately so — see the note above on what a reload takes with it.
export var _parked = Object.create(null);

/// Answer a parked request, if it is still parked. Returns whether it was.
///
/// EVERY route out of a tile comes through here, `drop` included, so no
/// removal can leave a worker waiting on a tile that is no longer on the
/// panel. A removal means a refusal, because the safe direction is no.
///
/// # Arguments
/// * `id` - The tile's id, which is also the parked request's.
/// * `verdict` - `'allow'` or `'deny'`, as the engine reads it.
export function settleConsent(id, verdict) {
	var go = _parked[id];
	if (!go) return false;
	delete _parked[id];
	try { go(verdict); } catch (e) { /* the awaiting turn has already gone */ }
	return true;
}

/// Which worker is asking, as far as the app can tell.
///
/// The payload the engine sends carries no actor id — `egress_allowed_act`
/// names the tool, the destination and whether the asker is alone, and
/// nothing else — so this is an inference, and it is only drawn where it
/// cannot be wrong: exactly one worker running means exactly one worker could
/// have asked. With two in flight the tile says "an agent", carries no
/// Diamond, and `discuss` has nowhere to take it, which is why that branch
/// exists rather than a guess.
function askingWorker() {
	var live = (Workers.runs || []).filter(function (r) { return r.status === 'running'; });
	return live.length === 1 ? live[0] : null;
}

/// The headline and body for a consent tile, from the act's shape. Shared by the
/// LOCAL unsupervised-worker park (`parkConsent`) and the REMOTE ask a runner
/// routes here (`raiseConsentFromPeer`), so the two never word one question two
/// ways. The text sent (`detail`) is quoted IN FULL for `web_type`, the same reason
/// the dialog does not cut it: it is the thing being authorised.
function consentTileText(tool, host, detail, kind) {
	var head, body;
	// A runner's change over his file (ASKCH, UNBLOCK-26 on the runner): its own kind, drawn
	// from the change it carries, never as the web-reach question below.
	if (kind === 'change') return changeTileText(detail);
	if (tool === 'web_type') {
		head = t('pending.consent.type_head', { host: host });
		body = tOr('permmode.type_worker_body',
			'An agent working on its own wants to type this into {host} and send it:\n\n{text}\n\nYou are not driving it and it cannot ask you itself, so Daimond is asking. Text sent to a site cannot be recalled. Saying yes allows this one act and nothing after it.',
			{ host: host, text: String(detail || '') || t('egress.nothing') });
	} else if (tool === 'web_click') {
		head = t('pending.consent.click_head', { host: host });
		body = tOr('permmode.act_worker_body',
			'An agent working on its own wants to click something on {host}. You are not driving it and it cannot ask you itself, so Daimond is asking. Clicking can spend your money, send a message or submit a form, and none of that can be taken back. Saying yes allows this one click and nothing after it.',
			{ host: host });
	} else if (tool === 'web_search') {
		head = t('pending.consent.search_head');
		body = tOr('permmode.search_worker_body',
			'An agent working on its own wants to search the web for:\n\n{query}\n\nYou are not driving it and it cannot ask you itself, so Daimond is asking. The query is what leaves this device. Saying yes allows this one search.',
			{ query: String(detail || '') || t('egress.nothing') });
	} else {
		head = t('pending.consent.reach_head', { host: host });
		body = t('egress.reach_body', { host: host });
	}
	return { head: head, body: body + '\n\n' + t('pending.consent.why') };
}

/// The headline and body for a runner's change ask (kind `change`, ASKCH): `detail` is the
/// page's own change question (`held_change::payload` led by `"ask":"change"` and the digest
/// of the bytes shown), so the tile names the file and the act and shows the diff rows and
/// the count of rows not shown. Saying yes here writes exactly what is shown. EP-2's Pending
/// change tile (`DaimondDeletes.change`) replaces this text render when it lands.
function changeTileText(detail) {
	var q = {};
	try { q = JSON.parse(String(detail || '{}')) || {}; } catch (e) { q = {}; }
	var path = String(q.path || ''), to = String(q.to || ''), act = String(q.act || '');
	var vars = { path: path, to: to };
	var what = act === 'delete' ? tOr('pending.change.what_delete', 'delete "{path}"', vars)
		: act === 'move' ? tOr('pending.change.what_move', 'move "{path}" to "{to}"', vars)
		: tOr('pending.change.what_change', 'change "{path}"', vars);
	var head = tOr('pending.change.head', 'An agent wants to {what}', { what: what });
	var lines = [tOr('pending.change.body',
		'An agent running on another of your devices wants to {what}. Saying yes makes exactly this change and nothing after it; the file\'s History keeps what it replaces.',
		{ what: what })];
	var rows = Array.isArray(q.rows) ? q.rows : [];
	if (q.text === false) {
		lines.push(tOr('pending.change.binary', 'This file is not text, so no lines can be shown.'));
	} else if (rows.length) {
		lines.push(tOr('pending.change.counts', '{add} lines added, {del} removed:',
			{ add: String(q.add | 0), del: String(q.del | 0) }));
		lines.push(rows.map(function (r) {
			var k = String((r && r.k) || ' ');
			if (k === '~') return tOr('pending.change.skip', '  … {n} unchanged lines', { n: String((r && r.n) | 0) });
			return k + ' ' + String((r && r.t) || '');
		}).join('\n'));
	}
	if ((q.more | 0) > 0) {
		lines.push(tOr('pending.change.more', '…and {n} more changed lines not shown.', { n: String(q.more | 0) }));
	}
	return { head: head, body: lines.join('\n\n') + '\n\n' + t('pending.consent.why') };
}

/// A short phrase for what a runner is blocked asking about, for the dispatch
/// status ("argonaut needs your permission to {act}"). From the ask's tool and
/// host, so the user knows why the turn is not progressing and the ball is theirs.
export function consentActPhrase(ask) {
	var tool = String((ask && ask.tool) || ''), host = String((ask && ask.host) || '');
	if (DaimondPeer.permitAsk(tool)) return permitActPhrase(tool, ask && ask.about, ask && ask.detail);
	if (ask && ask.kind === 'change') return t('turn.consent_act_change');
	if (tool === 'web_type')   return t('turn.consent_act_type',  { host: host });
	if (tool === 'web_click')  return t('turn.consent_act_click', { host: host });
	if (tool === 'web_search') return t('turn.consent_act_search');
	return t('turn.consent_act_reach', { host: host });
}

/// A permit's `about` (`{ id, kits | place }`), read against THIS device's Diamonds:
/// the Diamond, its name, and the kits named that this build knows.
function permitAbout(about) {
	var a = {};
	try { a = JSON.parse(String(about || '{}')) || {}; } catch (e) { a = {}; }
	var d = pg.diamonds.find(function (x) { return x.id === a.id; }) || null;
	var kits = (Array.isArray(a.kits) ? a.kits : []).filter(function (n) {
		return KITS.some(function (k) { return k.name === n; });
	});
	return {
		diamond: d, name: d ? d.name : '', place: String(a.place || ''), kits: kits,
		labels: kits.map(function (n) { return KITS.find(function (k) { return k.name === n; }).label; }),
	};
}

/// What a handed-off turn wants to do, as a phrase after "permission to".
///
/// `shown` is the ask's quoted thing (a change's path), read when `about` was cut short.
function permitActPhrase(kind, about, shown) {
	var a = permitAbout(about);
	if (kind === 'place')   return t('permit.act_place', { place: a.place });
	if (kind === 'toolkit') return t('permit.act_toolkit', { kits: a.labels.join(', ') });
	if (kind === 'change') {
		var c = changeAbout(about);
		return t('permit.act_change', { name: changeName(c ? c.path : shown).name });
	}
	return t('permit.act_run');
}

/// A change ask's `about` (the engine's payload, quoted whole by the runner), or null.
function changeAbout(about) {
	var c;
	try { c = JSON.parse(String(about || '')); } catch (e) { c = null; }
	return c && typeof c === 'object' && c.path ? c : null;
}

/// The headline and body for a permit asked from another device, in the words the
/// runner's own dialog uses, the device that asked named, and what a yes keeps.
function permitTileText(ask) {
	var kind = String(ask.kind || ''), a = permitAbout(ask.about);
	var dev = deviceLabelFor(String(ask.dispatchedBy || ''));
	var shown = String(ask.detail || '');
	var head;
	if (kind === 'change') {
		var c = changeAbout(ask.about);
		return { head: c ? changeHead(c) : t('permit.act_change', { name: changeName(shown).name }),
			body: t('change.remote', { device: dev }) };
	}
	if (kind === 'toolkit')    head = t('kit.ask_title', { name: a.name, kits: a.labels.join(', ') });
	else if (kind === 'place') head = t('place.ask_title', { name: a.name, place: a.place });
	else                       head = t('permmode.run_title');
	var keep = kind === 'toolkit' ? t('permit.kit_kept', { device: dev }) : t('permit.turn_only', { device: dev });
	return { head: head, body: shown + '\n\n' + keep };
}

/// What THIS device keeps of its yes to a permit. A toolkit is a Diamond's record,
/// synced, so the kits asked for are added to it here, those and no others. A place
/// and a command keep nothing: the place is in force for the turn only (a mark is in
/// force only where it was pressed, markshere.js R2), and a command is asked every time.
async function answerPermitHere(kind, about, verdict) {
	if (kind !== 'toolkit' || verdict !== 'allow') return;
	var a = permitAbout(about);
	if (!a.diamond || !a.kits.length) return;
	var has = Array.isArray(a.diamond.toolkits) ? a.diamond.toolkits.slice() : [];
	a.kits.forEach(function (n) { if (has.indexOf(n) < 0) has.push(n); });
	try {
		await diamondApp().set_toolkits(a.diamond.id, JSON.stringify(has));
	} catch (e) {
		trail('toolkit', 'the yes could not be recorded: ' + friendlyError(e));
		toast(t('kit.save_failed') + ': ' + friendlyError(e), true);
	}
	try { await loadDiamonds(); } catch (e) { /* the list repaints on its next load */ }
}

// The permits this device was asked, by cid, so the runner's word on one can say what it was.
var _permitAsks = Object.create(null);

/// onGrant: a runner says a permit THIS device sent was not granted, and why. Told on
/// the Pending panel, once per question, with a Retry that runs the turn again.
export function noticePermit(grant) {
	try {
		var why = DaimondPeer.permitNotice(grant, selfDeviceId());
		if (!why) return;
		var cid = String(grant.cid || ''), key = 'permit:' + cid;
		if (Pending.noticeUp(key) || Pending.noticed(key)) return;
		var ask = _permitAsks[cid] || null;
		delete _permitAsks[cid];
		var head = why === 'refused' ? t('permit.refused')
			: why === 'timeout' ? t('permit.timeout') : t('permit.unsupported');
		Pending.add({
			kind: 'notice', headline: head, key: key,
			detail: ask ? t('permit.notice_detail', {
				name: deviceLabelFor(String(grant.by || '')),
				act: permitActPhrase(String(ask.kind || ''), ask.about, ask.detail) }) : '',
			retry: { turnId: String(grant.turnId || '') },
		});
	} catch (e) { /* the refusal stands; only the word is lost */ }
}

/// The notice's Retry: run the turn the permit was refused in again, so it is asked
/// again. False when that cannot be done now (the turn is still held elsewhere).
export function permitRetry(turnId) {
	var id = String(turnId || '');
	var chat = chatHoldingTurn(id);
	if (!chat) return false;
	var text = '';
	for (var i = 0; i < chat.messages.length; i++) {
		var m = chat.messages[i];
		if (m && m.role === 'user' && String(m.iturn || m.mid || '') === id) { text = String(m.content || ''); break; }
	}
	if (!text) return false;
	return retryTurn(chat, id, text) !== false;
}

/// Raise this request on the Pending panel, and wait there for its answer.
///
/// # Arguments
/// * `req` - The engine's payload: `{ tool, url, detail, alone }`.
/// * `host` - The destination, already parsed, which is what the tile names.
function parkConsent(req, host) {
	var who  = askingWorker();
	var txt  = consentTileText(String(req.tool || ''), host, String(req.detail || ''));
	var detail = txt.body;
	if (who) {
		detail += '\n\n' + t('pending.consent.agent',
			{ name: who.name || '', task: String(who.task || '').slice(0, 300) });
	}
	var id = Pending.add({
		kind:        'consent',
		headline:    txt.head,
		detail:      detail,
		priority:    'high',		// something is stopped until it is answered.
		diamondId:   who ? (who.diamondId || '') : '',
		diamondName: who ? (who.diamondName || '') : '',
		// Which run is asking, so the Agents grid can show THAT square amber.
		runId:       who ? String(who.id || '') : '',
	});
	// The panel would not take it. Refuse rather than assume: a request that
	// could not be raised is a request nobody answered.
	if (!id) return Promise.resolve('deny');
	return new Promise(function (resolve) { _parked[id] = resolve; });
}

// ── Remote consent for a handed-off turn (dev/HANDOFF_CONSENT_DESIGN.md) ──
//
// A turn dispatched from the phone runs on a runner where nobody is. When it hits
// a genuinely per-turn consent the synced account policy does not cover, the
// runner cannot raise a dialog into an empty room: it seals a `consent-ask` to the
// account, routes it to a device the user is ON, and AWAITS the answer while
// holding its turn in memory -- exactly as it already awaits a local dialog. Only
// the question and the answer travel; the turn never leaves the runner. When no
// attended device exists, or the wait times out, the runner PARKS (abandon +
// re-run, never resume -- there is no mid-turn checkpoint), bounded by MAX_PARKS so
// the pre-consent respend can never run away. peer.js owns the envelopes, the
// signature and the pure decisions; this is the thin wiring over the real channel.

// A runner's ACTIVE dispatched turns, by turnId. Registered around runErrand so
// egressAllowed -- called deep inside the turn, with no turnId in its payload --
// can name the turn a live consent belongs to, seal the ask home, and (on a park)
// abort exactly that turn. Cleared on every exit.
export var _runnerCtx    = Object.create(null);	// turnId -> { turnId, eid, chatId, dispatchedBy, parkCount, abort }
var _runnerSeq    = 0;			// the order runner turns arrived in
// The peer-held turns a Stop has been pressed on, until the revoke has answered
// (`peerStopTurn`), and the placeholder states that mean another device holds a turn.
export var _peerStopping = Object.create(null);
export var PEER_HELD     = { claimed: 1, running: 1, blocked: 1, 'awaiting-consent': 1 };
// A runner AWAITING a grant, by the ask's cid. The grant that names this cid
// resolves the promise egressAllowed is blocked on; a grant for a spent/unknown cid
// matches nothing and authorises nothing (the forged/replayed-grant defence).
var _consentWait  = Object.create(null);	// cid -> { turnId, resolve }
// A turn egressAllowed decided to PARK. runErrand reads this (parkRequested) after
// the turn aborts and reports parked/terminal + releases the lease.
export var _runnerParked = Object.create(null);	// turnId -> { why }
// The dispatcher-side "a runner is blocked on a live question" marker, by turnId,
// so the dispatch status stops lying ("<peer> needs your permission to {act}").
export var _openAsk      = Object.create(null);	// turnId -> ask envelope
// Tiles this device has raised for an incoming BROADCAST ask, by cid, so a
// re-collected ask is not re-raised (dedup) and a resolved one is retired.
var _askTiles     = Object.create(null);	// cid -> pending tile id
var _askSeen      = Object.create(null);	// cid -> when THIS device first saw the ask (its own clock)
var _askHeld      = Object.create(null);	// cid -> the ask, for its wait, while it can be answered
var _askAnswered  = Object.create(null);	// cid -> true once a press here was taken for it
// The RESOLVED-cid ledger: cids for which a grant has been seen on this device.
// A device that was OFFLINE when the ask went out collects the ask AND the grant
// on reconnect; the grant (lower nothing -- higher seq than the ask) records the cid
// here so a re-raise of the already-answered ask is suppressed (askRaiseDecision).
// In memory: a stale ask past its ~60s deadline is suppressed by the deadline check
// regardless, and Pending.load marks any reloaded consent tile expired, so a lost
// ledger across a reload can never grant an act there is no longer anything to grant.
var _askResolved  = Object.create(null);	// cid -> true once a grant for it was seen

/// The one active runner turn, or null when it cannot be told (none, or several at
/// once). Like `askingTurn`, it FAILS TOWARDS SAFETY: not knowing which turn is
/// asking costs a refused act, never a wrong turn parked or a stranger's consent
/// spent. A runner runs its dispatched turns one at a time in the common case.
/// A turn queued behind this device's own work in its chat is not running yet, so
/// it is not the one asking.
export function activeRunnerTurn() {
	var ids = Object.keys(_runnerCtx).filter(function (k) { return !_runnerCtx[k].queued; });
	return ids.length === 1 ? _runnerCtx[ids[0]] : null;
}

/// The work this device is running or holding, as `{ busy, busyChats }`: one unit per
/// chat, a Diamond's own turn, fold and workers belonging to its chat, plus each message
/// waiting in a queue that will drain (`liveQueue`). What the beat says (H1) and what
/// `busyForChat` reads.
///
/// ONE UNIT PER CHAT, NOT A FALLBACK (UNBLOCK-1 BUSY-SELF). This was a count over the
/// OTHER chats, then `anyCrystalBusy()` or a live worker as a last "1" -- and a Diamond
/// chat's own turn sets its Diamond running, so a runner answered "busy with another
/// chat" for the chat it was running and handed the turn back (busy3, diag_busy3.md).
export function busyHere() {
	var units = Object.create(null), on = Object.create(null), queued = 0;
	var ofDiamond = Object.create(null);		// diamondId -> its chat's id
	pg.chats.forEach(function (c) { if (c && c.id && c.diamondId) ofDiamond[c.diamondId] = String(c.id); });
	function add(chatId, diamondId, alone) {
		var cid = String(chatId || '') || ofDiamond[String(diamondId || '')] || '';
		var key = cid ? 'c:' + cid : diamondId ? 'd:' + diamondId : alone;
		units[key] = 1;
		if (cid) on[cid] = 1;
	}
	pg.chats.forEach(function (c) {
		if (!c || !c.id) return;
		var w = liveQueue(c);
		if (c._generating || w) add(c.id);
		queued += w;
	});
	Object.keys(_runnerCtx).forEach(function (k) { add(_runnerCtx[k].chatId, '', 'r:' + k); });
	Object.keys(crystalRunning).forEach(function (d) { if (crystalRunning[d]) add('', d); });
	try {
		(Workers.runs || []).forEach(function (r) {
			if (r && (r.status === 'queued' || r.status === 'running')) add(r.chatId, r.diamondId, 'workers');
		});
	} catch (e) { /* no worker pool: no worker is busy */ }
	return { busy: Object.keys(units).length + queued, busyChats: Object.keys(on) };
}

/// How busy this device is for a turn of `chatId` ('' asks for the whole count): what a
/// collected errand is answered on (H1, C1), by the rule every sender's switch applies
/// to this device's beat (`DaimondPeer.busyForRec`). A chat it is already running is not
/// busy for itself: a second turn there queues behind the first (O3).
export function busyForChat(chatId) {
	return DaimondPeer.busyForRec(busyHere(), chatId);
}

/// The turns of this device's own in the errand's chat that are under way: the chat's
/// journalled turn (a chat turn or a daimon steer) while it generates, and every other
/// runner turn of that chat. Their rows are ones the sender may not have seen.
export function ownTurns(errand) {
	var e = errand || {}, cid = String(e.chatId || ''), tid = String(e.turnId || ''), out = [];
	if (!cid) return out;
	pg.chats.forEach(function (c) {
		if (c && String(c.id) === cid && c._generating && c._jturn && c._jturn !== tid) out.push(String(c._jturn));
	});
	Object.keys(_runnerCtx).forEach(function (k) {
		if (k !== tid && _runnerCtx[k].chatId === cid) out.push(k);
	});
	return out;
}

/// Does this device still hold work in the errand's chat that the errand must wait out
/// (UNBLOCK-1 BUSY-SELF)? Its turn, a queue that will drain (`liveQueue`), its Diamond (a daimon queues
/// behind its own Diamond and nobody else's), its workers, and runner turns of the chat
/// that began before this one: one lease each, run in the order they came.
export function chatHasWork(errand) {
	var e = errand || {}, cid = String(e.chatId || ''), tid = String(e.turnId || '');
	if (!cid) return false;
	var me = _runnerCtx[tid], seq = me ? me.seq : Infinity;
	for (var i = 0; i < pg.chats.length; i++) {
		var c = pg.chats[i];
		if (!c || String(c.id) !== cid) continue;
		if (c._generating || liveQueue(c) > 0) return true;
		if (c.diamondId && crystalRunning[c.diamondId]) return true;
		var did = String(c.diamondId || '');
		var runs = (Workers && Workers.runs) || [];
		for (var j = 0; j < runs.length; j++) {
			var r = runs[j];
			if (!r || (r.status !== 'queued' && r.status !== 'running')) continue;
			if (String(r.chatId || '') === cid || (!r.chatId && did && String(r.diamondId || '') === did)) return true;
		}
		if (Workers && Workers.roundPending && Workers.roundPending[cid]) return true;
		var bk = Object.keys((Workers && Workers.batches) || {});
		for (var q = 0; q < bk.length; q++) if (String(Workers.batches[bk[q]].chatId || '') === cid) return true;
	}
	var ks = Object.keys(_runnerCtx);
	for (var k = 0; k < ks.length; k++) {
		var rc = _runnerCtx[ks[k]];
		if (ks[k] !== tid && rc.chatId === cid && (rc.seq | 0) < seq) return true;
	}
	return false;
}

/// Will a chat's queue drain on its own? Only while its turn would be started here: a chat
/// on screen (a daimon's while its Diamond is), no open question holding the queue, and
/// the turn ahead of it not failed. Otherwise the queue is PARKED until the person comes
/// back to it (`drainQueue`, `drainSteerQueue`), and nothing is running.
function queueDrains(c) {
	if (!c || c._queueFailed || askHolds()) return false;
	return c.diamondId ? !!(pg.currentDiamond && pg.currentDiamond.id === c.diamondId) : pg.current === c;
}

/// How many messages wait in a chat's queue as live work: all of them while it drains,
/// none while it is parked (BUSY-SELF F2). A parked queue counted as work offered this
/// device for the chat and held a runner turn's lease to its deadline, then "Interrupted".
function liveQueue(c) {
	var w = waitingOn(c) | 0;
	return w > 0 && queueDrains(c) ? w : 0;
}

/// Wait, holding the errand's lease, until this device's own work in its chat has
/// ended: idle on two looks running, so a queued message that starts the moment a turn
/// ends is waited out too. `gone()` true (the lease taken back, the deadline past) ends
/// it at once. Answers the own turns seen meanwhile, for the thread check.
export async function queueBehind(errand, gone) {
	var tid = String((errand && errand.turnId) || '');
	var rc = _runnerCtx[tid], seen = ownTurns(errand), idle = 0;
	if (rc) rc.queued = true;
	try {
		while (idle < 2) {
			if (typeof gone === 'function' && gone()) break;
			await new Promise(function (res) { setTimeout(res, 250); });
			ownTurns(errand).forEach(function (k) { if (seen.indexOf(k) < 0) seen.push(k); });
			idle = chatHasWork(errand) ? 0 : idle + 1;
		}
	} finally { if (rc) rc.queued = false; }
	return { own: seen };
}

/// Register / retire a runner's active turn around its run.
export function runnerCtxBegin(errand) {
	var tid = String((errand && errand.turnId) || '');
	if (!tid) return;
	_runnerCtx[tid] = {
		seq: ++_runnerSeq, queued: false,	// arrival order; waiting behind own work (`queueBehind`)
		turnId: tid, eid: String(errand.eid || ''), chatId: String(errand.chatId || ''),
		dispatchedBy: String(errand.dispatchedBy || ''), parkCount: errand.parkCount | 0,
		asks: Array.isArray(errand.asks) ? errand.asks.slice() : [],	// permits the sender can answer
		auto: errand.auto === true,	// the SENDER holds the autonomous posture
		abort: null, tag: '', ui: [],
		chat: null, stopping: false,	// the detached chat it runs on; a Stop pressed here
	};
	syncSendMode();				// the chat on screen may be this turn's
}

/// Note the engine's tag for a runner's turn, so a panel the turn asks for can be
/// traced back to the device that asked it (`runnerAskerOf`). A no-op for a turn
/// this device is not running for anyone.
function runnerTagged(turnId, tag) {
	var rc = _runnerCtx[String(turnId || '')];
	if (rc && tag) rc.tag = String(tag);
}

/// Tag a turn of chat `chatId` for the runner: by its `turnId` when it has one, else, for
/// a gather round (`depth` > 0), by the errand this device runs for the chat. A gather
/// round re-tags the chat inside the errand, and a run whose tag went stale skipped the
/// round when its kill landed (check_l L-R1). A depth-0 turn is never the errand's.
export function runnerRoundTagged(chatId, turnId, tag, depth) {
	if (turnId) return runnerTagged(turnId, tag);
	if ((depth | 0) <= 0) return;
	var rc = runnerTurnOf(chatId);
	if (rc) runnerTagged(rc.turnId, tag);
}

// A turn may ask for this many panels before the oldest are dropped from its frames.
var RUNNER_UI_MAX = 8;

/// The device a turn tagged `tag` was asked from, when this device runs it for
/// another: `{ label, send(intent) }`, or null (D-20261006-27).
///
/// `send` queues a panel intent -- `{ show, page }` -- on the turn, and the turn's
/// progress frames and its final frame carry every intent queued so far to the
/// asker (`runnerUi`), which opens them there (`applyFrameUi`). Cumulative and
/// numbered, because the door keeps only the newest frame: a frame the asker never
/// read loses nothing that a later one does not carry again.
///
/// The dispatcher's own local recovery runs a turn in `_runnerCtx` too; asked here,
/// it is the asking device, and its screen is the right one.
export function runnerAskerOf(owner, tag) {
	var t = String(tag || ''), self = selfDeviceId();
	if (!t) return null;
	for (var k in _runnerCtx) {
		var rc = _runnerCtx[k];
		if (!rc || rc.tag !== t) continue;
		if (!rc.dispatchedBy || rc.dispatchedBy === self) return null;
		return {
			label: deviceLabelFor(rc.dispatchedBy),
			send:  function (intent) {
				// A file show (`{ show, page }`) or a Web page (`{ web }`).
				var path = String((intent && intent.show) || '').slice(0, 1024);
				var web = uiWebUrl(intent && intent.web);
				if (!path && !web) return;
				var n = rc.ui.length ? rc.ui[rc.ui.length - 1].n + 1 : 1;
				rc.ui.push(web ? { n: n, web: web }
					: { n: n, show: path, page: (intent.page | 0) > 0 ? (intent.page | 0) : 0 });
				if (rc.ui.length > RUNNER_UI_MAX) rc.ui.splice(0, rc.ui.length - RUNNER_UI_MAX);
				diag('handoff panel intent', 'turn=' + String(rc.turnId).slice(0, 12)
					+ (web ? ' web ' + web.slice(0, 80) : ' show ' + path)
					+ ' -> ' + String(rc.dispatchedBy).slice(0, 6));
			},
		};
	}
	return null;
}

/// The panel intents a runner's turn has queued, as a frame carries them, or null.
function runnerUi(turnId) {
	var rc = _runnerCtx[String(turnId || '')];
	return (rc && rc.ui && rc.ui.length) ? { ui: rc.ui.slice() } : null;
}

/// The fields a runner's frame carries beside its rows: the panel intents
/// (`runnerUi`) and the turn's workers as they stand (`Workers.frameList`), or null.
/// The workers ride every frame, so a worker changing state changes the payload and
/// the next tick sends it; a frame identical to the last still sends nothing.
export function runnerFrameExtra(turnId) {
	var ui = runnerUi(turnId), ws = [];
	try { ws = Workers.frameList(turnId); } catch (e) { ws = []; }
	if (!ws.length) return ui;
	return Object.assign({}, ui || {}, { workers: ws });
}
/// Can the turn this device runs for another (`turnId`) still hear words said into it
/// (UNBLOCK-27 R7c)? Deaf while its round streams prose with no call (the answer, so no
/// seam follows) and once the turn is over; a call opens a seam again. A word said to a
/// deaf turn is answered `unheard` at once and runs as the next turn.
export function runnerDeaf(turnId, deaf) {
	var rc = _runnerCtx[String(turnId || '')];
	if (rc) rc.deaf = !!deaf;
}
export function runnerCtxEnd(turnId) {
	var tid = String(turnId || '');
	delete _runnerCtx[tid];
	delete _runnerParked[tid];	// consumed by runErrand's parkRequested before this runs
	syncSendMode();
}

/// Is a handed-off turn for this chat running on THIS device right now? A runner
/// reconstructs the errand's chat into a DETACHED `ctx.chat` and never sets the
/// on-screen `current` -- that is `selectChat`'s alone -- so a gather round gated on
/// `current` would never run on the device actually executing the turn. This is the
/// runner's answer to the question `current === chat` answers on screen: the chat is
/// live here because a live errand names it. `_runnerCtx` is registered around
/// `runErrand` (runnerCtxBegin/End) and carries the errand's chatId.
export function chatIsActiveErrand(chatId) { return !!runnerTurnOf(chatId); }

/// The `_runnerCtx` entry of the turn this device is running for chat `chatId` -- for
/// a peer, or as the sender's own reclaimed run -- or null.
export function runnerTurnOf(chatId) {
	var want = String(chatId || '');
	if (!want) return null;
	var ids = Object.keys(_runnerCtx);
	for (var i = 0; i < ids.length; i++) {
		var rc = _runnerCtx[ids[i]];
		if (rc && String(rc.chatId) === want) return rc;
	}
	return null;
}

/// May a gather round steer this chat here -- because the reader is looking at it,
/// or because this device is the runner executing its handed-off turn? Replaces the
/// bare `current === chat` guard so a fan-out's next round runs on the runner, where
/// the turn is, rather than being stranded until the chat happens to be on screen.
export function chatShowingOrRunning(chat) {
	if (!chat) return false;
	if (pg.current && pg.current.id === chat.id) return true;
	return chatIsActiveErrand(chat.id);
}

/// PARK this runner turn: record the intent, hard-abort the in-flight turn, and
/// answer 'deny' so the pending act does not happen while the turn tears down.
/// runErrand then reports parked/terminal and releases the lease.
function parkRunnerTurn(rc, why) {
	if (rc && rc.turnId) _runnerParked[rc.turnId] = { why: why || 'no-attended-device' };
	try { if (rc && rc.abort) rc.abort(); } catch (e) { /* idempotent */ }
	return 'deny';
}

/// Runner side: route a live per-turn consent to an attended device and AWAIT the
/// answer, or PARK. `covered` is false for the acts that reach here (web_type /
/// web_click / an overlong address) -- no standing scope covers them, so the ask
/// always fires; the reading/search path composes with the synced policy ABOVE
/// this, returning 'allow' before it ever gets here.
async function routeConsentAsk(req, host) {
	var rc = runnerTurnOfReq(req);
	if (!rc) return 'deny';				// cannot tell which turn: refuse this act, park nothing
	if (_openAskForTurn(rc.turnId)) return 'deny';	// one open ask per turnId at a time
	var presence = (window.DaimondPresence && DaimondPresence.snapshot)
		? (DaimondPresence.snapshot() || {}) : {};
	// THE SOURCE DEVICE is the one this turn was dispatched from -- `rc.dispatchedBy`,
	// carried on the errand from the dispatcher (peer.js `makeErrand`). A chat's
	// consent belongs THERE, not on whoever is at the runner (owner rule 2026-09-05):
	// `consentRouteDecision` prefers it, and falls back to an attended peer only when
	// the source is offline.
	var decision = DaimondPeer.consentRouteDecision(presence, selfDeviceId(), Date.now(),
		{ windowMs: DaimondPeer.DISPATCH_FRESH_MS, source: rc.dispatchedBy });
	if (decision.action !== 'ask') return parkRunnerTurn(rc, decision.why || 'no-attended-device');
	var wait = DaimondPeer.CONSENT_DEADLINE_MS || 60000;
	var ask = DaimondPeer.makeAsk({
		eid: rc.eid, turnId: rc.turnId, chatId: rc.chatId,
		tool: String(req.tool || ''), host: String(host || ''),
		detail: String(req.detail != null ? req.detail : (req.url || '')),
		deadline: Date.now() + wait, dispatchedBy: selfDeviceId(),
		// BROADCAST (owner rule 2026-09-09): no single target. The ask is sealed to
		// the account and every attended device raises the tile, so a handed-off
		// turn's permission reaches the device the user is actually AT and not only
		// the source (a prompt trapped on the unattended runner dead-ends the turn).
		// `consentRouteDecision` is still consulted ABOVE, but only to decide ask vs
		// PARK -- when NO device is reachable the turn parks (bounded), unchanged.
		// An empty target is what `raiseConsentFromPeer` reads as "raise everywhere".
		target: '',
	});
	var body;
	try { body = await DaimondPeer.sealForSelf(ask); }
	catch (e) { return parkRunnerTurn(rc, 'seal-failed'); }
	try { var r = await DaimondPost.post(body); if (!r || !r.ok) return parkRunnerTurn(rc, 'post-failed'); }
	catch (e) { return parkRunnerTurn(rc, 'post-failed'); }
	// AND ONTO THE LEASE (owner ruling 2026-09-12). The ask on the relay reaches a
	// device that is COLLECTING; the blocker on the lease reaches every device that
	// merely PULLS, which is what the originating phone does while it waits -- so
	// the turn can never sit there as a bare spinner with no account of itself. The
	// two are one question: they share the `cid`, so whichever path the answer comes
	// back on, `blockerAnswerDecision` spends the same record once.
	await raiseBlocker(rc.turnId, {
		kind: 'consent', cid: ask.cid, tool: ask.tool, host: ask.host,
		detail: ask.detail, since: Date.now(),
	});
	// AWAIT the grant keyed by cid, or the deadline. The turn stays in memory; the
	// lease is held to the errand deadline throughout, so it never reads vacant.
	var verdict = await new Promise(function (resolve) {
		var done = false;
		function settle(v) { if (done) return; done = true; delete _consentWait[ask.cid]; resolve(v); }
		_consentWait[ask.cid] = { turnId: rc.turnId, kind: 'consent', resolve: settle };
		setTimeout(function () { settle(null); }, wait);
	});
	// ANSWERED OR TIMED OUT, the blocker comes off: a question nobody is holding any
	// more must not go on showing a live control on three other devices.
	await clearBlocker(rc.turnId);
	if (verdict === 'allow' || verdict === 'deny') return verdict;	// the human answered
	return parkRunnerTurn(rc, 'consent-timeout');					// nobody answered in time
}

/// The turn this device runs FOR ANOTHER device, or null. A dispatcher's own local
/// recovery runs in `_runnerCtx` too, and there the person is here, so its dialogs stay.
///
/// WHICH turn is asking is read from the question itself (F1): the engine names the
/// turn in `req.turn`, and only the turn `runnerTagged` filed under that tag is the
/// handed-off one. This device's own turn on the same Diamond, running beside it,
/// carries another tag or none, and keeps its own dialog; it used to be taken for the
/// handed-off turn because that was the only one registered.
function permitRunnerTurn(req) {
	var rc = runnerTurnByTag(req && req.turn);
	if (!rc || !rc.dispatchedBy || rc.dispatchedBy === selfDeviceId()) return null;
	return rc;
}

/// The runner turn the engine's tag names, or null: an untagged question is this
/// device's own turn.
function runnerTurnByTag(tag) {
	tag = String(tag || '');
	if (!tag) return null;
	for (var k in _runnerCtx) {
		if (_runnerCtx[k] && _runnerCtx[k].tag === tag) return _runnerCtx[k];
	}
	return null;
}

/// The runner turn a web act's question belongs to. A tagged question is its own
/// turn's or nobody's; one with no tag (the search door, which has no request to
/// read) falls back to the one active runner turn, as before.
function runnerTurnOfReq(req) {
	var tag = String((req && req.turn) || '');
	return tag ? runnerTurnByTag(tag) : activeRunnerTurn();
}

/// Runner side: put a permit (`place`, `toolkit`, `run`) to the device the turn was
/// sent from and AWAIT its answer (CONSENT-ROUTE, 10 Oct). Beside `routeConsentAsk`
/// rather than inside it, because the two part on what silence means: a consent
/// nobody answered parks the turn, a permit nobody answered is a refusal and the turn
/// goes on without it, as "Not now" would have it. Answers the engine's word: the
/// kind's own yes, or a no naming why (`DaimondPeer.permitNoWord`), so the model is
/// never told "the user said not now" for a question nobody answered or that could not
/// be put. Every refusal is told to the asking device (`refusePermit`), so a person is
/// never left guessing why the turn did without.
///
/// # Arguments
/// * `shown` - The thing authorised, as the question quotes it (path, command).
/// * `about` - JSON `{ id, kits | place }` the answering device needs to word it.
/// * `waitMs` - How long to wait for the answer; absent is `CONSENT_DEADLINE_MS`. A
///   change ask passes its own ten minutes (`changeWaitMs`).
function routePermitAsk(rc, kind, shown, about, waitMs) {
	// ONE TURN'S PERMITS ARE ASKED ONE AFTER ANOTHER (F5): a turn that writes two files
	// in one round raises both questions at once, and the second used to be refused
	// unasked because the first was still open. It now waits its turn on the chain and
	// is asked when the first settles, whichever way.
	var run = (rc.permitQ || Promise.resolve()).then(function () {
		return putPermitAsk(rc, kind, shown, about, waitMs);
	});
	rc.permitQ = run.catch(function () { /* the next question is still asked */ });
	return run;
}

async function putPermitAsk(rc, kind, shown, about, waitMs) {
	// A web act's question open on this turn: this one was never put to anybody.
	if (_openAskForTurn(rc.turnId)) return DaimondPeer.permitNoWord('unsupported');
	var presence = (window.DaimondPresence && DaimondPresence.snapshot)
		? (DaimondPresence.snapshot() || {}) : {};
	var route = DaimondPeer.consentRouteDecision(presence, selfDeviceId(), Date.now(),
		{ windowMs: DaimondPeer.DISPATCH_FRESH_MS, source: rc.dispatchedBy });
	var d = DaimondPeer.permitRouteDecision(kind, route, rc.dispatchedBy, rc.asks);
	var wait = (Number(waitMs) > 0) ? Number(waitMs) : (DaimondPeer.CONSENT_DEADLINE_MS || 60000);
	var ask = DaimondPeer.makeAsk({
		eid: rc.eid, turnId: rc.turnId, chatId: rc.chatId,
		tool: kind, host: '', detail: String(shown || ''), kind: kind, about: String(about || ''),
		deadline: Date.now() + wait, wait: wait, dispatchedBy: selfDeviceId(),
		target: d.target || '',
	});
	if (d.action !== 'ask') {
		trail(kind, (d.why === 'unsupported' ? 'could not ask on your other device'
			: 'your other device was not there to ask') + ': ' + String(shown || '').slice(0, 120));
		return refusePermit(rc, ask, d.why);
	}
	// An ask that could not be sealed or posted was never put to anybody, so the person
	// and the model are told it could not be asked, never that nobody answered (B6b).
	var body, posted = false;
	try { body = await DaimondPeer.sealForSelf(ask); } catch (e) { body = null; }
	if (body) {
		try { var r = await DaimondPost.post(body); posted = !!(r && r.ok); }
		catch (e) { posted = false; }
	}
	if (!posted) {
		trail(kind, 'could not ask on your other device: ' + String(shown || '').slice(0, 120));
		return refusePermit(rc, ask, 'unsupported');
	}
	await raiseBlocker(rc.turnId, {
		kind: kind, cid: ask.cid, tool: kind, detail: ask.detail, about: ask.about, target: ask.target,
		since: Date.now(),
	});
	var verdict = await new Promise(function (resolve) {
		var done = false;
		var timer = null;
		function settle(v) {
			if (done) return; done = true; clearTimeout(timer); delete _consentWait[ask.cid]; resolve(v);
		}
		_consentWait[ask.cid] = { turnId: rc.turnId, kind: kind, target: ask.target, resolve: settle };
		timer = setTimeout(function () { settle(null); }, wait);
	});
	await clearBlocker(rc.turnId);
	var out = DaimondPeer.permitOutcome(kind, verdict);
	if (out.why) {
		trail(kind, (out.why === 'refused' ? 'your other device said no' : 'your other device did not answer in time')
			+ ': ' + String(shown || '').slice(0, 120));
		tellPermit(rc, ask, out.why);
	}
	return out.word;
}

/// Refuse a permit for `why`: tell the device the turn came from, and answer the
/// engine the word naming that same reason.
function refusePermit(rc, ask, why) {
	tellPermit(rc, ask, why);
	return DaimondPeer.permitNoWord(why);
}

/// Tell the device that sent the turn why its permit was not granted: a deny grant for
/// the ask's cid, the reason in `choice`. It also takes the question down wherever it
/// is drawn (`adoptRemoteGrant`); an older build reads it as an answer to nothing.
/// Not awaited by the turn: a lost notice costs the explanation, never the refusal.
function tellPermit(rc, ask, why) {
	try {
		var grant = DaimondPeer.makeGrant({
			cid: ask.cid, eid: rc.eid, turnId: rc.turnId, kind: ask.kind, verdict: 'deny',
			choice: String(why || ''), by: selfDeviceId(), to: rc.dispatchedBy,
		});
		DaimondPeer.sealForSelf(grant).then(function (body) { return DaimondPost.post(body); })
			.catch(function () { /* the refusal stands; only the word is lost */ });
	} catch (e) { /* likewise */ }
}

/// Is there an outstanding ask for this turn (runner side awaiting, or a source
/// tile up)? Guards one-open-ask-per-turnId.
function _openAskForTurn(turnId) {
	var tid = String(turnId || '');
	for (var cid in _consentWait) {
		if (Object.prototype.hasOwnProperty.call(_consentWait, cid)
			&& _consentWait[cid] && String(_consentWait[cid].turnId) === tid) return true;
	}
	return false;
}

/// onGrant, RUNNER side: an attended device's answer has arrived. Resolve the runner
/// awaiting this cid, if any. FIRST-COMMITTED-WINS and exactly-once: the read of the
/// pending record and its delete happen in one synchronous step (no await between),
/// so the FIRST grant to arrive resolves the turn and SPENDS the cid; a racing second
/// grant -- a conflicting allow/deny, or the same answer reaching the runner by two
/// paths -- finds the record gone and is dropped by `grantDecision`, authorising
/// nothing. A grant whose cid is spent/unknown, or bound to another turn, drops.
export function deliverGrant(grant) {
	try {
		var cid = String(grant.cid || '');
		var w   = _consentWait[cid] || null;
		// `blockerAnswerDecision` IS `grantDecision` with the blocker's two extra
		// guards (the KIND must match what the runner is blocked on, and an `ask`
		// must carry a choice), so one rule covers both the consent this started as
		// and every blocker kind since. A grant from a build that predates the
		// blocker carries no kind and still resolves a consent.
		var d = DaimondPeer.blockerAnswerDecision(w, grant);
		if (!d.commit) return;					// spent / unknown / turn-mismatch: authorises nothing
		delete _consentWait[cid];				// SPEND, before resolving: a racing grant now drops
		w.resolve(d.kind === 'ask' ? d.choice : d.verdict);
	} catch (e) { /* a lost grant times the runner out into a park; no double-charge */ }
}

/// onGrant, EVERY device: adopt a resolution reached elsewhere. Records the cid as
/// resolved (so a device coming back online does not re-raise the already-answered
/// ask), and DISMISSES this device's now-moot tile for that cid without answering it
/// -- `Pending.dismiss` takes the tile down without settling its parked promise, so
/// no second, conflicting grant is sealed for a cid the runner has already spent.
/// Idempotent: a device that answered locally (its tile already retired) or never
/// raised one simply records the cid. Runs alongside `deliverGrant` on onGrant, so
/// the runner both unblocks its turn and clears any tile it itself raised.
export function adoptRemoteGrant(grant) {
	try {
		var cid = String(grant.cid || '');
		if (!cid) return;
		var turnId = String(grant.turnId || '');
		var open = _openAsk[turnId];
		var ask = _permitAsks[cid] || (open && String(open.cid || '') === cid ? open : null);
		if (!DaimondPeer.grantSettlesAsk(ask, grant)) return;	// a third device's word on a permit settles nothing
		_askResolved[cid] = true;				// suppress a later re-raise (offline return)
		var tileId = _askTiles[cid];
		if (!tileId) return;					// no local tile up for this cid
		delete _askTiles[cid];
		if (turnId) delete _openAsk[turnId];
		try { Pending.dismiss(tileId); } catch (e) { /* a stale tile the user can close by hand */ }
		try { renderDispatchedBadges(); } catch (e) {}
	} catch (e) { /* a failed dismiss leaves a stale tile, never a wrong grant */ }
}

/// onAsk (source side): a runner's live question has arrived. Record it for the
/// dispatch status on ANY device; raise the tile ONLY on an attended one (a device
/// that cannot answer must not hold a dialog nobody sees); dedup by cid. Answering
/// seals a `consent-grant` and posts it home, addressed by the ask's dispatchedBy.
export function raiseConsentFromPeer(ask) {
	try {
		var cid = String(ask.cid || ''), turnId = String(ask.turnId || '');
		_openAsk[turnId] = ask;								// the dispatcher's "awaiting" marker, EVERY device
		try { renderDispatchedBadges(); } catch (e) {}
		// BROADCAST (owner rule 2026-09-09, superseding the single-source routing of
		// 2026-09-05): every attended device raises the tile, so a handed-off turn's
		// permission reaches the device the user is actually AT and answering it there
		// unblocks the runner. `askRaiseDecision` is the fail-safe filter -- suppress
		// an already-resolved ask (a device back online must not re-raise it), a stale
		// one past its deadline, and a duplicate; and raise nothing on a device nobody
		// is at (the `_openAsk` marker above still lit the dispatch badge there). The
		// FIRST device to answer resolves it everywhere: its grant dismisses these
		// tiles (adoptRemoteGrant) and unblocks the runner (deliverGrant).
		if (!_askSeen[cid]) { _askSeen[cid] = Date.now(); _askHeld[cid] = ask; }
		var d = DaimondPeer.askRaiseDecision(ask, selfDeviceId(), Date.now(), {
			resolved:  !!_askResolved[cid],
			alreadyUp: !!_askTiles[cid],
			seenAt:    _askSeen[cid],
			canAnswer: someoneCanAnswer(),
		});
		if (!d.raise) return;
		var permit = DaimondPeer.permitAsk(ask.kind);
		if (permit) _permitAsks[cid] = ask;
		var txt = permit ? permitTileText(ask)
			: consentTileText(String(ask.tool || ''), String(ask.host || ''), String(ask.detail || ''),
				String(ask.kind || ''));
		var change = ask.kind === 'change' ? changeAbout(ask.about) : null;
		var id = Pending.add({
			kind: 'consent', headline: txt.head, detail: txt.body, priority: 'high', change: change,
		});
		if (!id) return;
		_askTiles[cid] = id;
		// The tile settles through the ordinary settleConsent -> _parked[id] route;
		// its verdict seals the grant home and retires the local marker. A tile
		// DISMISSED by a remote grant (adoptRemoteGrant -> Pending.dismiss) deletes
		// `_parked[id]` without resolving, so this branch never runs for an adopted
		// dismiss and no second, conflicting grant is posted for a spent cid.
		new Promise(function (resolve) { _parked[id] = resolve; }).then(function (verdict) {
			// A permit's press is taken or turned away HERE, before anything is written
			// or awaited, so the footer's control for the same question cannot answer too.
			var act = permit ? permitAnswerGate(cid) : 'answer';
			if (_askTiles[cid] !== id) return;			// already retired elsewhere (belt-and-braces)
			delete _askTiles[cid];
			delete _openAsk[turnId];
			_askResolved[cid] = true;
			try { renderDispatchedBadges(); } catch (e) {}
			var v = verdict === 'allow' ? 'allow' : 'deny';
			if (!permit) { sealAndPostGrant(ask, v); return; }
			settlePermitAnswer(turnId, ask, v, act, function () { return sealAndPostGrant(ask, v); })
				.catch(function () { /* nothing was written; the runner's wait ends it */ });
		});
	} catch (e) { /* a failure to raise leaves the runner to time out and park */ }
}

// ── The blocker: what stopped the runner, on every device ───
//
// Owner ruling 2026-09-12. A permission popup, a question or a lock raised on the
// runner must be COPIED to the originating device and to every other device,
// CLEARED everywhere by the first to respond, with the runner keeping its own
// local control -- and the originating user must never see a hanging turn.
//
// The record rides the LEASE (peer.js `leaseBlock`), because that is the one thing
// every device already reads about a handed-off turn: `adoptLeaseDoor` folds it
// into an ordinary pull, so a watching phone sees the blocker with no new request
// and no new channel. The ANSWER rides the relay, reusing the consent-grant
// envelope, so `blockerAnswerDecision` is still the single first-answer-wins rule.

/// Raise a blocker on the turn this device is running. Best-effort: a blocker that
/// could not be written costs the other devices their account of the wait, never
/// the turn -- the runner's own dialog is up regardless, which is what "the runner
/// keeps local control" means.
async function raiseBlocker(turnId, blocker) {
	try {
		if (!window.DaimondLease || !DaimondLease.block) return false;
		var r = await DaimondLease.block(String(turnId), selfDeviceId(), blocker,
			DaimondPeer.syncCas(peerSyncShim()));
		return !!(r && r.ok);
	} catch (e) { return false; }
}

/// Clear it again, whatever it was.
async function clearBlocker(turnId) {
	try {
		if (!window.DaimondLease || !DaimondLease.unblock) return false;
		var r = await DaimondLease.unblock(String(turnId), selfDeviceId(),
			DaimondPeer.syncCas(peerSyncShim()));
		return !!(r && r.ok);
	} catch (e) { return false; }
}

/// The blocker on a dispatched turn as THIS device reads it, or null.
export function blockerFor(turnId) {
	try {
		return (window.DaimondLease && DaimondLease.blocker)
			? DaimondLease.blocker(String(turnId)) : null;
	} catch (e) { return null; }
}

/// ANSWER a blocker from a device that is not the runner: seal the answer as a
/// grant and post it home. One door for both answerable kinds -- a consent's
/// allow/deny and an `ask`'s chosen label -- so the runner has one rule to apply.
///
/// It does NOT clear the blocker itself: only the holder may write that record
/// (peer.js refuses a non-holder `not_ours`), and the runner clears it the moment
/// it spends the answer. What this device does clear is its own tile, so the
/// person who answered is not still looking at the question.
export async function answerBlocker(turnId, blocker, verdict, choice) {
	var b = blocker || {};
	// A permit's press is taken or turned away before the first await, for the reason
	// the tile's is: two controls stand for one question, and it takes one answer.
	var isPermit = DaimondPeer.permitAsk(b.kind);
	var act = isPermit ? permitAnswerGate(String(b.cid || '')) : 'answer';
	// AN `ask` IS ANSWERED BY A MESSAGE, not by a verdict: the tool did not hold the
	// turn open, so there is nothing on the runner to unblock -- the answer IS the
	// chat's next message, and it can be sent from here. The grant below still goes,
	// so a runner that is somehow still holding the question clears it.
	if (String(b.kind || '') === 'ask') {
		try { await answerAskHere(turnId, choice); } catch (e) { /* the grant still goes */ }
	}
	var postGrant = async function () {
		// Addressed to the runner holding the turn, so no other device's ack takes it
		// off the relay before the runner has it (D126).
		var runner = '';
		try { runner = (window.DaimondLease && DaimondLease.holder) ? (DaimondLease.holder(String(turnId)) || '') : ''; }
		catch (e) { runner = ''; }
		var grant = DaimondPeer.makeGrant({
			cid: b.cid || '', turnId: String(turnId), kind: String(b.kind || 'consent'),
			verdict: verdict === 'allow' ? 'allow' : 'deny',
			choice: String(choice == null ? '' : choice), by: selfDeviceId(), to: runner,
		});
		var body = await DaimondPeer.sealForSelf(grant);
		var r = await DaimondPost.post(body);
		return !!(r && r.ok);
	};
	try {
		if (isPermit) await settlePermitAnswer(turnId, b, verdict === 'allow' ? 'allow' : 'deny', act, postGrant);
		else await postGrant();
	} catch (e) { /* the runner's deadline is the safe fallback: it parks, bounded */ }
	// The local view moves at once rather than at the next pull, so the button the
	// person pressed stops being a button. The authoritative clear is the runner's.
	try {
		if (b.cid) _askResolved[String(b.cid)] = true;
		var tileId = b.cid ? _askTiles[String(b.cid)] : null;
		if (tileId) { delete _askTiles[String(b.cid)]; Pending.dismiss(tileId); }
	} catch (e) { /* a stale tile the user can close by hand */ }
	try { renderDispatchedBadges(); } catch (e) {}
}

/// A runner's `ask` question, copied onto the lease so every device can see it.
///
/// Fire-and-forget, and a no-op everywhere but a runner mid-errand: a question
/// asked in a chat the user is driving needs no copy, because they are looking at
/// the card. Unlike a consent, an `ask` does NOT hold the turn open -- the tool
/// answers at once and the turn winds up -- so the blocker's life is short and its
/// clear comes for free when the lease is released. What it buys is the window
/// between the question being asked and the transcript carrying it home, which is
/// precisely the window the originator spent staring at a spinner.
export function broadcastAskIfHandedOff(o) {
	try {
		if (!o || !askDrawable(o)) return;
		var rc = activeRunnerTurn();
		if (!rc) return;					// not a hand-off: the card is where the person is
		var opts = (o.options || []).map(function (op) { return String((op && op.label) || ''); });
		// Not awaited: the tool must answer the engine now, and a slow lease write
		// must never delay the card the runner itself draws.
		raiseBlocker(rc.turnId, {
			kind: 'ask', detail: String(o.question || ''), options: opts, since: Date.now(),
		});
	} catch (e) { /* the runner's own card is drawn regardless */ }
}

/// Answer a runner's `ask` from THIS device: send the chosen option as the chat's
/// next message, here.
///
/// This is the same act the card performs -- `askAnswer` sets the composer and
/// sends -- and it is correct from any device because an `ask` is answered by a
/// MESSAGE, which needs nothing left over from the turn that asked. The chat is
/// selected first when it is not the one on screen, so the answer lands in the
/// conversation it belongs to and the reader sees where it went.
async function answerAskHere(turnId, label) {
	var said = String(label || '').trim();
	if (!said) return;
	var chat = dispatchedChat(String(turnId));
	if (!chat) return;
	try { if (pg.current !== chat) selectChat(chat); } catch (e) { return; }
	await sendUserMessage(ASK_CHOSE + said);
}
// page-split: install 95

/// RUN IT HERE INSTEAD -- the one control a report-only blocker offers. The
/// runner needs a click it cannot be given from here (`fsa`), or is locked, or its
/// provider refused: none of those is answerable across the relay, so the honest
/// offer is to take the turn off that device and run it on this one. Revoking the
/// lease is exactly the take-back the phone already has (the runner's read-only
/// liveness check reads `released` and hard-aborts), and `continueTurn` then runs
/// the turn here -- money-safe, because the revoke lands before anything starts.
export async function runBlockedTurnHere(chat, turnId, text) {
	try { await peerTakeBack(turnId); } catch (e) { /* the run below still claims it */ }
	try { continueTurn(chat, turnId, text, false, undefined, false); } catch (e) { /* nothing to run */ }
}

/// Re-decide every still-open ask now that this device is back in front of
/// somebody, and raise the ones that pass.
///
/// `_openAsk` is kept on EVERY device (it is what lights the dispatch badge), but
/// the tile is only drawn where somebody could answer -- so an ask that arrived
/// while this tab was hidden sat in `_openAsk` with nothing on screen, for ever.
/// `DaimondPeer.reRaiseDecision` applies the SAME fail-safe filter a freshly
/// collected ask passes, against the two ledgers, so nothing resolved, expired or
/// already drawn is raised a second time.
export function reRaiseOpenAsks() {
	try {
		if (!window.DaimondPeer || !DaimondPeer.reRaiseDecision) return;
		var list = DaimondPeer.reRaiseDecision(_openAsk, selfDeviceId(), Date.now(), {
			resolved:  _askResolved,
			up:        _askTiles,
			seen:      _askSeen,
			canAnswer: someoneCanAnswer(),
		});
		for (var i = 0; i < list.length; i++) raiseConsentFromPeer(list[i]);
	} catch (e) { /* a failed re-raise leaves the runner to time out and park */ }
}

/// Seal a `consent-grant` for an ask and post it home. A lost grant is not a
/// double-charge risk: the runner times out and parks, and the turn re-runs bounded.
async function sealAndPostGrant(ask, verdict) {
	try {
		// To the runner that asked: a third device that collected an unaddressed grant took
		// it and acked it away before the runner saw it (R3 QA Q4, D126).
		var grant = DaimondPeer.makeGrant({
			cid: ask.cid, eid: ask.eid, turnId: ask.turnId, verdict: verdict, by: selfDeviceId(),
			kind: String(ask.kind || 'consent'),	// a permit's answer must quote its kind
			to: String(ask.dispatchedBy || ''),
		});
		var body = await DaimondPeer.sealForSelf(grant);
		var r = await DaimondPost.post(body);
		return !!(r && r.ok);
	} catch (e) { return false; /* the runner's timeout is the safe fallback */ }
}

/// Take this device's ONE answer to a permit, or say why it takes none
/// (`DaimondPeer.permitAnswerDecision`). Synchronous on purpose: the tile and the
/// footer both stand for the question, and whichever is pressed first must close the
/// other before either awaits. A late press spends the question too.
function permitAnswerGate(cid) {
	cid = String(cid || '');
	var act = DaimondPeer.permitAnswerDecision(_askHeld[cid] || null,
		{ spent: !!_askAnswered[cid], seenAt: _askSeen[cid] || 0 }, Date.now());
	if (cid) _askAnswered[cid] = true;
	return act;
}

/// Carry a permit's answer through, in the order that cannot leave a yes behind
/// that nobody is waiting for (F3). Nothing happens for a press that was spent or
/// late. A toolkit's yes is a WRITE to the Diamond, so before it the lease is read
/// again and the question must still be up there under this cid: the runner takes
/// it down the moment it stops waiting. Then the answer is posted, and only an
/// answer that was posted is kept here. A no, a place and a command keep nothing.
///
/// A runner that stops waiting between the lease read and its receipt of the answer
/// still leaves the kit written with the turn gone on without it; closing that needs
/// the runner to acknowledge the answer, which this does not do.
///
/// # Arguments
/// * `q`    - The question: `{ cid, kind, about }`, an ask or a blocker.
/// * `act`  - `permitAnswerGate`'s word for this press.
/// * `post` - Posts the answer; resolves true when the relay took it.
async function settlePermitAnswer(turnId, q, v, act, post) {
	if (act !== 'answer') return false;
	var kit = String(q.kind) === 'toolkit' && v === 'allow';
	if (kit) {
		try { if (window.DaimondSync && DaimondSync.pull) await DaimondSync.pull(true); }
		catch (e) { /* offline: the lease as held is read, and the post below fails */ }
		var up = null;
		try { up = (window.DaimondLease && DaimondLease.blocker) ? DaimondLease.blocker(String(turnId)) : null; }
		catch (e) { up = null; }
		if (!up || String(up.cid || '') !== String(q.cid || '')) return false;
	}
	var sent = false;
	try { sent = !!(await post()); } catch (e) { sent = false; }
	if (!sent) return false;
	await answerPermitHere(String(q.kind), q.about, v);
	return true;
}

// HOW LONG A NETWORK QUESTION MAY STAND UNANSWERED.
//
// Two minutes, and the number is a judgement rather than a measurement: it is long
// enough that somebody who looked up, read the command and thought about it still
// answers their own question, and short enough that a turn does not hold a lease,
// a worker slot and a provider's context on a screen nobody is at. Turn 54 sat on
// one for eleven minutes and was still sitting on it when the owner found it.
//
// It bounds ONE question and no other: every other dialog in this file is either
// answerable later without cost, or authorises something a silence must never be
// read as agreeing to. This one's unanswered outcome is the refusal, so running
// out is safe in the one direction that matters.
var NET_ASK_DEADLINE_MS = 120 * 1000;

/// The deadline this net question actually gets.
///
/// A caller may SHORTEN it and may never lengthen it, which is what makes the
/// override safe to expose at all: `dev/verify_netchip.mjs` drives the timed path
/// without waiting two minutes for it, and nothing reachable from a page can turn
/// the bound off and bring the hang back.
function netAskDeadline(opts) {
	var n = Number(opts && opts.deadlineMs);
	if (!(n > 0)) return NET_ASK_DEADLINE_MS;
	return Math.min(n, NET_ASK_DEADLINE_MS);
}

// How long a publication may wait on a screen nobody is at before it is declined.
//
// The same two minutes the network question gets, and for the same reason: it is long
// enough that somebody who walks back to the device still answers it, and short enough
// that a turn is not held open for an afternoon. The unanswered outcome is a refusal,
// which is the one direction in which running out is safe -- nothing goes out because
// nobody said anything, which is exactly the owner's ruling.
var PUBLISH_ASK_DEADLINE_MS = 120 * 1000;

/// The deadline an unattended publish question gets. Shortened by a caller, never
/// lengthened -- `netAskDeadline`'s bargain, for `dev/verify_socialpost.mjs`.
function publishAskDeadline(opts) {
	var n = Number(opts && opts.deadlineMs);
	if (!(n > 0)) return PUBLISH_ASK_DEADLINE_MS;
	return Math.min(n, PUBLISH_ASK_DEADLINE_MS);
}

/// Whether this act may happen, now that something from outside has been read.
///
/// # Arguments
/// * `payloadJson` - What the caller wants to do: `{ tool, url, detail, alone, granted }`.
/// * `opts` - `{ strict: true }` to ask EVERY time and to ask about our own host too.
///
/// `granted` is the engine saying that this CONVERSATION has already said yes to reaching
/// the web (`web_step` in src/tools.rs owns that, and this side owns the words). It is
/// read for reading only, it is ignored under `strict`, and a page cannot set it: the one
/// caller that takes a string from a page builds its own payload — see `pageEgressAllowed`.
///
/// Strict mode exists for that caller: a link a crystal page asked the app to follow. The
/// two shortcuts below are right for an agent browsing and wrong for a page that renders
/// a Diamond's memory. The conversation's grant covers every site, so one reasonable yes
/// would license every later `docs.example/?crystal=…`; and `host === location.host` is
/// waved through outright, so the page could walk the memory out one path fragment at a
/// time, under `EGRESS_PAYLOAD_MAX`, to an address that looks like ours because it IS
/// ours. The page is written by a model, is absent from the standing context and unseen
/// by the fold diff, so it is the one thing here that survives a turn — and it syncs to
/// every device. ("Exempt from the cap" stood in that list until 2026-08-28 and has been
/// false since 2026-08-09, when `CRYSTAL_PAGE_CAP_DEFAULT` gave the page its own ceiling.
/// It was never the load-bearing clause: what makes a line survive is that no reader here
/// ever looks at it, not its weight.)
// ONE WEB ANSWER PER CHAT, AND ITS WORKERS INHERIT IT (UNBLOCK-21). A dispatched worker
// has its own engine, so without this it never saw its chat's "may reach any website"
// and asked again for every site. The word is the engine's own (`web_consent_word`):
// `allow`, `deny`, or nothing when the chat was never asked. A no is handed on as a no.
export function chatWebWord(app) {
	try { return (app && app.web_consent_word) ? String(app.web_consent_word() || '') : ''; }
	catch (e) { return ''; }			// an older engine: the worker asks, as before.
}

export function giveWorkerWeb(run) {
	if (run && run.webConsent && run.app && run.app.inherit_web_consent) {
		run.app.inherit_web_consent(run.webConsent);
	}
}

/// Does a standing answer already cover this read? The conversation's own (`granted`) or
/// the account's reading grant, for a reading tool only, never under `strict`, and never
/// for an address carrying a payload, which is always its own question.
function standingRead(req, url, strict) {
	if (strict) return false;
	if (req.tool !== 'web_fetch' && req.tool !== 'web_open') return false;
	var scoped = !!(window.DaimondHandMode && DaimondHandMode.scopeGranted
		&& DaimondHandMode.scopeGranted('reading'));
	if (req.granted !== true && !scoped) return false;
	return !egressPayload(url).heavy;
}

async function egressAllowed(payloadJson, opts) {
	var strict = !!(opts && opts.strict);
	var req = {};
	try { req = JSON.parse(String(payloadJson || '{}')) || {}; } catch (e) { req = {}; }
	// A DIAMOND THAT MAY NOT PUBLISH DOES NOT PUBLISH, and this sits ABOVE the
	// posture below it rather than beside the `social_send` dialog further down.
	// That is the whole point of putting it here: the posture's branch returns
	// `allow-publish` for an unattended turn without drawing anything, and an
	// unattended turn is exactly what the withholding is about. Under the dialog
	// it would guard the case that was never in danger and miss the one that was.
	// See `WITHHELD`.
	if (req.tool === 'social_send' && publishWithheld()) return 'deny';
	// THIS COMPUTER FINISHES WHAT IT WAS DISPATCHED, WITHOUT ASKING. When its
	// owner has set the autonomous posture on this machine (`autonomousPosture`)
	// AND the turn is unattended — a dispatched worker with nobody driving it,
	// or a screen nobody is at — every act below is allowed with no dialog and
	// no tile on the Pending panel. The bound on what it may do is the account's
	// credit at the AI provider and at Daimond, not a question put to an empty
	// room; that is the owner's decision, and it is why there is no spend gate
	// here. It sits at the TOP so it covers every tool below it in one place.
	//
	// `strict` is excluded and stays excluded: a crystal page's own navigation is
	// not a model acting, and no posture waves it through. And the whole guard is
	// a no-op whenever the posture is off — a machine that was never armed reaches
	// none of this, and every dialog and park below stands exactly as before.
	//
	// A PERMIT ON A TURN RUN FOR ANOTHER DEVICE IS THE ASKER'S TO GIVE (B-F1). The
	// three permits (a place, a toolkit, a command) let a turn write or run on its
	// owner's behalf, and the owner of a handed-off turn is at the device it came
	// from. So there the ASKER's posture counts, carried on the errand (`rc.auto`),
	// and this machine's own never grants: an armed runner used to wave through a
	// write its sender was never asked about. With the asker unarmed the permit
	// falls to its branch below and is asked at home. Web acts are untouched: an
	// armed runner still finishes those itself.
	var pkind = DaimondPeer.permitAsk(req.tool) ? String(req.tool) : '';
	var hrc = (!strict && pkind) ? permitRunnerTurn(req) : null;
	if (hrc && hrc.auto) return DaimondPeer.PERMIT_YES[pkind];
	if (!hrc && !strict && autonomousPosture() && (req.alone || !someoneCanAnswer())) {
		// A permit takes its own yes word too: a bare `allow` for a place or a toolkit
		// is read by the engine as "the user said not now".
		if (pkind) return DaimondPeer.PERMIT_YES[pkind];
		// The yes WORD differs by tool: `run_net` and `social_send` read a bare
		// `allow` as a refusal (each takes only its own word, see those branches
		// below), so hand each the one it reads as yes. Every other tool takes the
		// plain word. Without this the posture would silently fence a walked-away
		// turn's network commands and publications while allowing its web acts.
		if (req.tool === 'run_net')     return 'allow-net';
		if (req.tool === 'social_send') return 'allow-publish';
		return 'allow';
	}
	// The conversation's standing answer, as the engine reports it. Never under
	// `strict`, whose whole purpose is that no standing answer covers it.
	var granted = !strict && req.granted === true;
	// The two tools that READ a destination the model chose, which are the two the
	// conversation's grant is about. Named once so the shortcut below and the
	// dialogs at the foot cannot disagree about which question they are answering.
	var reading = (req.tool === 'web_fetch' || req.tool === 'web_open');
	// A command is not a destination. It arrives through this door because it
	// is the same question — may this act happen — and the door already owns
	// the dialog, the translations and the focus handling. It is answered
	// FIRST, above the URL work below, which would read a command line as an
	// address it cannot parse and deny every command in the ask mode.
	if (req.tool === 'run') {
		var cmd = String(req.url || '');
		if (!cmd.trim()) return 'deny';
		// Cut to the same 300 characters every other body in this function is cut to.
		// A command line is `argv.join(" ")` and the model chose every word of it, so an
		// uncapped one is a dialog whose buttons can be pushed off the screen and whose
		// operative argument can be buried under a screenful of padding — in the ONE dialog
		// that authorises a program to run on the user's machine. Shown with an ellipsis
		// rather than silently trimmed: a reader has to be able to tell that there is more,
		// and "the rest of it is not on screen" is itself a reason to say no.
		var shownCmd = cmd.length > 300 ? (cmd.slice(0, 300) + '…') : cmd;
		// A HANDED-OFF TURN ASKS AT HOME (CONSENT-ROUTE): the runner is a machine
		// nobody is at, so the question goes to the device the turn came from.
		var rrc = strict ? null : permitRunnerTurn(req);
		if (rrc) return await routePermitAsk(rrc, 'run', shownCmd,
			JSON.stringify({ cwd: String(req.detail || '').slice(0, 300) }));
		// BOUNDED AS THE NETWORK QUESTION IS (QA r578c A2). Unbounded, a worker's
		// command question stood until somebody came, and its turn with it: Stop
		// could not settle it, and nothing billed, reported or gathered. Running
		// out is a no that says nobody answered, never a yes.
		var runTimedOut = false;
		var runWaitMs = netAskDeadline(opts);
		var okRun = await confirmDialog(
			t('permmode.run_body', { cmd: shownCmd, cwd: String(req.detail || '').slice(0, 300) }),
			t('permmode.run_ok'),
			// Re-check of 2026-09-23: this question is raised by the running turn, not
			// by anything the person just did, so it takes R6's guard (see `dialog`).
			{ turn: req.turn, title: t('permmode.run_title'), danger: false, guard: true,
				deadlineMs: runWaitMs,
				onDeadline: function () { runTimedOut = true; } });
		if (okRun) return 'allow';    // never remembered: every time means every time.
		if (!runTimedOut) return 'deny';
		trail('run consent', 'nobody answered within ' + Math.round(runWaitMs / 1000)
			+ 's, so the command did not run: ' + cmd.slice(0, 120));
		return DaimondPeer.permitNoWord('timeout');
	}
	// A TOOLCHAIN ON FIRST USE (Workspace round 2, E1). The engine asks before a
	// command that needs a toolkit this Diamond has not been granted: "Let <Diamond>
	// use Rust?", the command shown as it will run, Allow / Not now. A yes is written
	// to the Diamond here, as the head's Toolchains entry writes it, and comes back as
	// `allow-kit` and nothing else: the posture above, the same-origin shortcut below
	// and an older bundle all say `allow` or `deny`, and both mean no to the engine.
	// So no path but a press on this card grants a toolkit (N3). A no is not written
	// anywhere: the next command that needs it asks again (N2).
	if (req.tool === 'toolkit') {
		var kcmd = String(req.url || '');
		var kreq = {};
		try { kreq = JSON.parse(String(req.detail || '{}')) || {}; } catch (e) { kreq = {}; }
		var kwant = (Array.isArray(kreq.kits) ? kreq.kits : []).filter(function (n) {
			return KITS.some(function (k) { return k.name === n; });
		});
		var kd = pg.diamonds.find(function (x) { return x.id === kreq.id; });
		if (!kcmd.trim() || !kwant.length || !kd) return 'deny';
		// A HANDED-OFF TURN: this device's own Diamond record is read first, and a kit
		// it already grants needs nobody (arm 7); otherwise the device the turn came
		// from is asked, and it writes the yes (`answerPermitHere`), not this one.
		var krc = strict ? null : permitRunnerTurn(req);
		if (krc) {
			var khave = Array.isArray(kd.toolkits) ? kd.toolkits : [];
			if (kwant.every(function (n) { return khave.indexOf(n) >= 0; })) return 'allow-kit';
			return await routePermitAsk(krc, 'toolkit',
				kcmd.length > 300 ? (kcmd.slice(0, 300) + '…') : kcmd,
				JSON.stringify({ id: kd.id, kits: kwant }));
		}
		if (!someoneCanAnswer()) {
			trail('toolkit', 'nobody could answer, so the command was refused: ' + kcmd.slice(0, 120));
			setKitsWaiting(kd.id, kwant, true);
			return DaimondPeer.PERMIT_ABSENT_WORD;
		}
		var klabels = kwant.map(function (n) {
			return KITS.find(function (k) { return k.name === n; }).label;
		});
		var kshown = document.createElement('pre');
		kshown.className = 'dlg-pre';
		kshown.textContent = kcmd.length > 300 ? (kcmd.slice(0, 300) + '…') : kcmd;
		var kyes = await dialog({
			turn:    req.turn,		// its Stop closes it (D2)
			kind: 'confirm',
			ask: 'toolkit',
			title: t('kit.ask_title', { name: kd.name, kits: klabels.join(', ') }),
			message: kshown,
			okLabel: t('kit.ask_ok'),
			cancelLabel: t('kit.ask_no'),
			danger: false,
			guard: true,
			deadlineMs: netAskDeadline(opts),
		});
		// "Not now", or no answer before the deadline: kept as a ghost to grant later.
		if (!kyes) {
			setKitsWaiting(kd.id, kwant, true);
			return 'deny';
		}
		setKitsWaiting(kd.id, kwant, false);
		var khas = Array.isArray(kd.toolkits) ? kd.toolkits.slice() : [];
		kwant.forEach(function (n) { if (khas.indexOf(n) < 0) khas.push(n); });
		try {
			await diamondApp().set_toolkits(kd.id, JSON.stringify(khas));
		} catch (e) {
			// The press still answers this command; only the record failed, so the grant
			// holds for this turn and the next one asks again. Said where the user is
			// looking, or they would believe it saved.
			trail('toolkit', 'the yes could not be recorded: ' + friendlyError(e));
			toast(t('kit.save_failed') + ': ' + friendlyError(e), true);
		}
		try { await loadDiamonds(); } catch (e) { /* the list repaints on its next load */ }
		return 'allow-kit';
	}
	// A WRITE ON FIRST USE (Workspace round 2, E2). The engine asks after a model's write
	// was refused for being outside what this Diamond may change: "Let <Diamond> change
	// <place>?", the path shown, Allow / Not now. The place is the narrowest folder holding
	// the file, or a mark made on another device, named with that device. A yes writes the
	// same `holds` row and marks-here entry the ◈ writes (`grantHoldHere`), and comes back
	// as `allow-place` alone, so no other answer grants (N3). A no is written nowhere (N2).
	if (req.tool === 'place') {
		var ppath = String(req.url || '');
		var preq = {};
		try { preq = JSON.parse(String(req.detail || '{}')) || {}; } catch (e) { preq = {}; }
		var pplace = String(preq.place || '');
		var pd = pg.diamonds.find(function (x) { return x.id === preq.id; });
		if (!ppath.trim() || !pplace || !pd) return 'deny';
		// A HANDED-OFF TURN: a mark in force on THIS device needs nobody (arm 7).
		// Otherwise the sending device is asked, and its yes is this turn's only: a
		// mark is in force only where it was pressed (markshere.js R2), so no row is
		// written on either device.
		var prc = strict ? null : permitRunnerTurn(req);
		if (prc) {
			var pks = ['dir', 'file'];
			for (var pk = 0; pk < pks.length; pk++) {
				var pl = await linkTo(pd.id, rootedRef(pks[pk], pplace));
				if (pl && markForce(pd.id, pl)) return 'allow-place';
			}
			return await routePermitAsk(prc, 'place',
				ppath.length > 300 ? (ppath.slice(0, 300) + '…') : ppath,
				JSON.stringify({ id: pd.id, place: pplace }));
		}
		if (!someoneCanAnswer()) {
			trail('place', 'nobody could answer, so the write was refused: ' + ppath.slice(0, 120));
			return DaimondPeer.PERMIT_ABSENT_WORD;
		}
		var pwait = preq.waiting ? await waitingMarkAt(pd.id, pplace) : null;
		var pbody = document.createElement('div');
		var pshown = document.createElement('pre');
		pshown.className = 'dlg-pre';
		pshown.textContent = ppath.length > 300 ? (ppath.slice(0, 300) + '…') : ppath;
		pbody.appendChild(pshown);
		if (pwait) {
			var pon = document.createElement('p');
			pon.textContent = t('place.allowed_on', { device: markDevice(pwait) });
			pbody.appendChild(pon);
		}
		var pyes = await dialog({
			turn:    req.turn,		// its Stop closes it (D2)
			kind: 'confirm',
			ask: 'place',
			title: t(pwait ? 'place.ask_here_title' : 'place.ask_title', { name: pd.name, place: pplace }),
			message: pbody,
			okLabel: t('kit.ask_ok'),
			cancelLabel: t('kit.ask_no'),
			danger: false,
			guard: true,
			deadlineMs: netAskDeadline(opts),
		});
		if (!pyes) return 'deny';
		// The press answers this write whatever the record does; a record that did not
		// land is said (`marksNotSaved`), and the next turn asks again.
		try {
			if (pwait) await confirmMarkHere(pd.id, pwait);
			else await grantHoldHere(pd.id, pplace, pplace !== ppath);
		} catch (e) { marksNotSaved(); }
		signalLinksChanged();
		return 'allow-place';
	}
	// MAY THIS TURN REACH THE NETWORK AT ALL — a different question from "may
	// this command run", and asked once per turn rather than every time.
	//
	// A turn that has read outside content used to lose the network in
	// silence, so the second command of every ordinary build session (`cargo
	// fetch` then `cargo build`) failed with an offline error the model had no
	// way to attribute. The engine now asks instead; this is the half that can
	// answer. See hand/REVIEW.md §1.13.
	//
	// A YES IS THE WORD `allow-net` AND NOTHING ELSE, and that is a boundary,
	// not a spelling. `egressHost` resolves its argument against
	// `location.href`, and a command line has no scheme — so it resolves as a
	// RELATIVE url whose host is our own, and the same-origin shortcut below
	// answers `allow` outright. A question that reached that shortcut would
	// hand every tainted turn the network with nobody asked, which is exactly
	// how §7's egress guarantee was voided once already, for `web_search`. So
	// the engine takes a yes only in a word no other path through this
	// function can say: an old bundle, a missing branch and the shortcut all
	// say `allow` or `deny`, and all three correctly mean no here.
	//
	// WHICH IS WHY THIS SITS ABOVE THAT SHORTCUT and not below it. Moving it
	// down would not fail loudly — it would silently start granting.
	//
	// Not remembered across chats unless the user ticks the box in the dialog,
	// and a dispatched worker never arrives here: the engine does not ask when
	// there is nobody to ask, and keeps the fence it had.
	if (req.tool === 'run_net') {
		var ncmd = String(req.url || '');
		if (!ncmd.trim()) return 'deny';
		// THE DIALOG HONOURS ITS OWN LAST SENTENCE. `permmode.net_body` ends "No runs
		// it anyway, with no network -- and so does saying nothing", and until
		// 2026-09-13 nothing made the second half true: `dialog()` had no deadline and
		// nothing else resolved it, so a live daimon's turn sat busy for eleven minutes
		// on a question nobody was at the screen to answer (`dev/HATES.md`, turn 54).
		//
		// Two ways to answer it without a person, and both give the SAME outcome the
		// No button gives -- the command runs, inside the fence it already had, with no
		// network. Nothing here can grant anything; the worst it can do is withhold a
		// network the user would have given, and the turn carries on and says so.
		//
		// FIRST, NOBODY IS THERE AT ALL. `someoneCanAnswer` is the app's own reading of
		// that -- a hidden tab, a locked phone, a modal already up -- and it is the same
		// function the parked-worker branch below keys on. Asked BEFORE the card is
		// built, because building one would make its own answer false.
		if (!someoneCanAnswer()) {
			trail('net consent', 'nobody could answer, so the command ran with no network: '
				+ ncmd.slice(0, 120));
			return 'deny';
		}
		// Cut to the same 300 characters as every other body here, with an
		// ellipsis rather than a silent trim: see the `run` branch above.
		var shownNet = ncmd.length > 300 ? (ncmd.slice(0, 300) + '…') : ncmd;
		// A YES IS ONE-OFF UNLESS THE USER TICKS THE BOX, and the box is the
		// whole of the difference.
		//
		// It used to be that ANY yes here called `setStandingNet('allow')` --
		// which writes `daimond-net-standing`, the app-wide standing answer, and
		// pushes `allow` into every chat that already has an engine
		// (`netApplyAll`). So: two chats open, a no given in one, a yes given in
		// the other about a different command, and the first chat's refusal was
		// gone. Its next command reached the network, nobody was asked, nothing
		// said the answer had been reversed, and the permissions button showed
		// "Always" -- a setting the user had never chosen, surviving every
		// reload. src/tools.rs says of `override_net_consent`, which is what that
		// path ends at, that NOTHING IN THE TOOL LOOP MAY CALL IT; this is the
		// tool loop, and it was calling it.
		//
		// THE ARGUMENT FOR IT POINTED THE WRONG WAY. It read: only a yes becomes
		// standing, because refusing once is not a decision to refuse for ever.
		// True -- and the direction being made permanent and global was the
		// PERMISSIVE one, which is the half that needs the user's word rather
		// than the half that can be inferred from it.
		//
		// AND THE COMPLAINT IT ANSWERED IS STILL ANSWERED. "I thought we got rid
		// of this bullshit!" was reported three times, about being asked again in
		// every new chat, and one yes is still enough to end it -- it is just a
		// tick the user makes rather than a thing that happens to them. A control
		// with a label beats a side effect, and the popover's own "Always allow"
		// is the same setting reached the other way.
		var netStanding = false;
		// SECOND, NOBODY ANSWERED IN TIME. The card goes up on a screen somebody is
		// at, and they walk away from it -- which `someoneCanAnswer` above cannot
		// see and no signal honestly can (see its own header). So the wait is
		// bounded, and `NET_ASK_DEADLINE_MS` is the bound.
		var netTimedOut = false;
		var netWaitMs = netAskDeadline(opts);
		var netAns = await dialog({
			turn:    req.turn,		// its Stop closes it (D2)
			deadlineMs: netWaitMs,
			onDeadline: function () { netTimedOut = true; },
			kind:    'pick',
			title:   t('permmode.net_title'),
			message: t('permmode.net_body', { cmd: shownNet, cwd: String(req.detail || '').slice(0, 300) }),
			okLabel: t('permmode.net_ok'),
			danger:  true,
			// Re-check of 2026-09-23: raised by the running turn: R6's guard applies.
			guard: true,
			build:   function (card) {
				var row = document.createElement('label');
				row.className = 'dlg-tick';
				var box = document.createElement('input');
				box.type = 'checkbox';
				box.className = 'dlg-tick-box net-standing-box';
				var say = document.createElement('span');
				mark(say, '', t('permmode.net_remember'));
				row.appendChild(box);
				row.appendChild(say);
				card.appendChild(row);
				// Read at OK and not on change: a box ticked and then unticked before
				// the button was pressed would otherwise have already been obeyed.
				return { read: function () { return { standing: !!box.checked }; } };
			},
		});
		// Cancel, Escape, the cross and the backdrop all answer null -- see
		// `nothing()`, and so does the deadline. A dialog that was dismissed is a no,
		// which is what the body's last sentence promises; a dialog that ran out is
		// the same no, and it is written down as one so the difference is legible to
		// whoever reads the turn afterwards.
		if (netTimedOut) {
			trail('net consent', 'nobody answered within '
				+ Math.round(netWaitMs / 1000) + 's, so the command ran with no '
				+ 'network: ' + ncmd.slice(0, 120));
		}
		if (!netAns) return 'deny';
		netStanding = !!netAns.standing;
		if (netStanding && window.DaimondHandMode && DaimondHandMode.setStandingNet) {
			try { DaimondHandMode.setStandingNet('allow'); } catch (e) { /* asked again, no worse */ }
		}
		return 'allow-net';
	}
	// PUBLISHING IN THE USER'S NAME, WHERE OTHER PEOPLE READ IT.
	//
	// The Social panel reaches the forge through OUR OWN gateway, so the URL
	// this door is built around resolves same-origin and the shortcut below
	// would answer `allow` outright, with nobody asked. That is the same fault
	// `web_search` had, and it is answered the same way: HERE, above the URL
	// work, and with a yes that is a word no other path through this function
	// can say — `allow-publish`. An old bundle, a missing branch and the
	// shortcut all say `allow`, and all three correctly mean NO here.
	//
	// `url` CARRIES THE TEXT AND NOT AN ADDRESS. The address is not the
	// question. What is being approved is what other people will read, so what
	// is shown is what would be published — composed by the panel, which is the
	// half that knows what the wire will actually carry, and passed through
	// unchanged. An approval given without sight of the content is not consent,
	// and this is the user's name on a public post.
	//
	// NOT CUT, for the reason `web_type` is not cut: this is the one string a
	// person is being asked to authorise SENDING, and a sentence past the cut
	// would be approved unseen by somebody who was told they had read it. The
	// card scrolls already.
	//
	// NEVER REMEMBERED, and that is a decision rather than an omission.
	//
	// The answers this door DOES remember are remembered for reasons that do not
	// apply. Reading the web is granted for a CONVERSATION, because reaching a
	// documentation site twice is the same act twice and reaching the next one is
	// no different in kind. `run_net` and `web_search` were both made standing on
	// a COUNT — one ordinary question fanned out to eight searches and therefore
	// eight dialogs, and a gate answered by tapping through is a gate that
	// protects nobody.
	//
	// Neither holds here. Each publication is its own act with its own content,
	// exactly as each `web_type` is — and that one is marked `never remembered`
	// beside the same reasoning. And there is no count: a turn publishes once,
	// perhaps twice. So the yes is spent on the payload it was given for, and
	// the panel spends the token with it.
	//
	// A DISPATCHED WORKER NEVER ARRIVES HERE. `social_send_step` in
	// src/tools.rs refuses one outright rather than parking the question, so
	// there is no `alone` branch below and there must not be: a public post in
	// somebody's name is not a question to leave on a tile for whoever passes.
	if (req.tool === 'social_send') {
		var what = String(req.url || '');
		if (!what.trim()) return 'deny';		// nothing to show, so nothing to authorise.
		// AND IT IS NOT LEFT UP FOR EVER ON A SCREEN NOBODY IS AT.
		//
		// 2026-09-15: this card rose on the owner's own desktop, mid-drive, with the tab in
		// the background and nobody at it. Nothing answered it and nothing could: the turn
		// held there, the worker behind it went on running, and the record of the whole
		// proposal ends at a dialog. So the wait is bounded WHEN NOBODY IS THERE TO ANSWER
		// -- a dispatched seat (`alone`), or a device that is not foreground-and-recently-
		// touched -- and the unanswered outcome is the refusal the body already promises.
		//
		// AND ONLY THEN. A person who has just typed the sentence that led here is reading
		// a draft they are about to authorise, and a card that withdrew itself from under
		// them at two minutes would be a worse fault than the one this fixes -- see
		// `someoneCanAnswer`, which makes the same argument about idle time.
		var pubTimedOut = false;
		var pubWaitMs = (req.alone || !isAttended()) ? publishAskDeadline(opts) : 0;
		var okPub = await confirmDialog(
			tOr('social.publish_body',
				'Daimond will publish this in your name, for anyone to read. It cannot be taken back.'
					+ '\n\n{what}\n\nDecline if you did not expect it.',
				{ what: what }),
			tOr('social.publish_ok', 'Publish it'),
			{ turn: req.turn, title: tOr('social.publish_title', 'Publish this?'), danger: true,
				ask: 'publish',
				deadlineMs: pubWaitMs,
				onDeadline: function () { pubTimedOut = true; },
				// Re-check of 2026-09-23: raised by the running turn: R6's guard applies.
				guard: true });
		if (pubTimedOut) {
			trail('publish consent', 'nobody answered within '
				+ Math.round(pubWaitMs / 1000) + 's on a screen nobody was at, so nothing '
				+ 'was published: ' + what.slice(0, 120));
		}
		return okPub ? 'allow-publish' : 'deny';	// never remembered: every time means every time.
	}
	// A search is a destination this door cannot see. The wasm posts
	// `/api/web/search`, which is OUR path and resolves same-origin — and the
	// same-origin shortcut below waves our own pages through, so the search
	// tool went out with the user asked nothing at all. §7's whole egress
	// guarantee was a no-op.
	//
	// It is answered HERE, above that shortcut, beside `run`, and for the same
	// reason `run` is: the URL is not the question. The wasm genuinely cannot
	// know which engine will answer — that is the user's setting, resolved two
	// layers down — so the address it can name is a proxy for the real one.
	// THE QUERY IS THE THING LEAVING, so the query is what the dialog shows.
	// Showing the URL instead is precisely what made this morning's prompt
	// unreadable: a wall of percent-encoding where a question should have been.
	//
	// REMEMBERED FOR THE TURN, since 2026-08-16, and this replaces an argument
	// rather than forgetting it.
	//
	// What stood here: never remembered, because `web_type` is not remembered —
	// the text is the payload and each one is a different thing to send — and a
	// query is the same kind of thing, so "you allowed a search once" is not
	// consent to the next one. That reasoning is sound and it is why the rule
	// was written.
	//
	// What overturned it is the count. One ordinary question on a phone fanned
	// out to EIGHT searches and therefore eight dialogs, which is not a person
	// consenting eight times — it is a person tapping through a wall of prompts
	// to get their answer back, and a gate answered that way protects nobody.
	// The owner ruled on 2026-08-16 that one answer covers the turn, matching
	// what the network question beside it does.
	//
	// WHAT IS GIVEN UP, plainly: if the first search returns a page that steers
	// what the second one looks for, the user is no longer asked at the moment
	// that happens. The queries are all still in the transcript, so it is
	// visible after the fact rather than before it — that is the trade, and it
	// is a real one. Anybody minded to restore the old rule should restore the
	// count with it: eight dialogs is what it cost.
	//
	// A REFUSAL IS REMEMBERED AS A REFUSAL. Otherwise the second search asks
	// again and a no is merely the slow way to be worn down into a yes.
	//
	// This memory is the search's alone and never touches the network
	// question's `allow-net`: two questions, two answers, and one may not
	// stand in for the other.
	if (req.tool === 'web_search') {
		var q = String(req.detail || '').trim();
		if (!q) return 'deny';				// nothing to authorise, and nothing to show.
		// THE ACCOUNT'S STANDING POLICY, above the turn memory and the dialog.
		// A search's egress is at the gateway on the account's credit, so a yes
		// the user gave once for the account is a yes here -- and this is the
		// half that stops a RUNNER re-asking for a turn dispatched from another
		// device, where the person is not even at the machine the prompt would
		// appear on. Granted from the tick in the dialog below, and it travels in
		// the sync parcel's `perms`. See handmode.js `scopeGranted`/`grantScope`.
		if (window.DaimondHandMode && DaimondHandMode.scopeGranted
			&& DaimondHandMode.scopeGranted('reading')) {
			return 'allow';
		}
		// A RUNNER with NO standing 'reading' grant: route the question to the chat's
		// SOURCE device. A dispatched turn's chat is driven from another device, and
		// its permission belongs THERE, not on whoever is at the runner (owner rule
		// 2026-09-05) -- so this routes for ANY dispatched runner turn, not only when
		// the runner is unattended (the earlier `!isAttended()` gate let an attended
		// runner raise the dialog locally, which is the bug the owner hit). Every
		// dispatched turn has a source (`dispatchedBy`), so `activeRunnerTurn()` alone
		// is the condition. consent-sync above closes it once 'reading' is granted and
		// never reaches here. The routed verdict is a plain 'allow'/'deny'.
		if (activeRunnerTurn()) {
			return await routeConsentAsk({ tool: 'web_search', detail: q, url: '' }, '');
		}
		var searchTurn = askingTurn(req);
		if (searchTurn && _searchTurn.has(searchTurn)) {
			return _searchTurn.get(searchTurn) ? 'allow' : 'deny';
		}
		// Cut to the same 300 characters every other body here is cut to, with
		// an ellipsis rather than a silent trim: a reader has to be able to see
		// that there is more, and "the rest is not on screen" is itself a reason
		// to say no.
		var shownQ = q.length > 300 ? (q.slice(0, 300) + '…') : q;
		// Who will actually receive it. Read from the setting rather than from
		// the payload, because the payload cannot know and because a dialog that
		// named the model's guess would be the Bing problem wearing a prompt.
		var eng = 'the search engine set in Settings';
		try {
			if (window.DaimondSearch) eng = DaimondSearch.engineName(DaimondSearch.engine());
		} catch (e) { /* the module is not up; the phrase above still reads */ }
		// A `pick` rather than a plain confirm, so the account-level grant is
		// offered as a tick beside the yes -- the same shape the network dialog
		// uses for its "Always allow". Read at OK, not on change, so a box ticked
		// and then unticked before the button is pressed is not already obeyed.
		var searchAns = await dialog({
			turn:    req.turn,		// its Stop closes it (D2)
			kind:    'pick',
			title:   tOr('egress.search_title', 'Search the web?'),
			message: tOr('egress.search_body',
				'This turn has read content from outside your workspace. Daimond now wants '
					+ 'to search the web.\n\nWhat it wants to search for:\n\n{query}\n\nSearching '
					+ 'with {engine}, which is your setting. The query is what leaves this '
					+ 'device.\n\nIf you did not expect this, decline. Nothing is lost but the one '
					+ 'search.',
				{ query: shownQ, engine: eng }),
			okLabel: tOr('egress.search_ok', 'Run this search'),
			danger:  true,
			// Re-check of 2026-09-23: raised by the running turn: R6's guard applies.
			guard: true,
			build:   function (card) {
				var row = document.createElement('label');
				row.className = 'dlg-tick';
				var box = document.createElement('input');
				box.type = 'checkbox';
				box.className = 'dlg-tick-box search-standing-box';
				var say = document.createElement('span');
				mark(say, '', tOr('egress.search_remember',
					'Allow web searches on this account without asking again'));
				row.appendChild(box);
				row.appendChild(say);
				card.appendChild(row);
				return { read: function () { return { ok: true, standing: !!box.checked }; } };
			},
		});
		// Cancel, Escape, the cross and the backdrop all answer null: a dismissed
		// dialog is a no, which is what the body's last sentence promises.
		var okSearch = !!searchAns;
		// A no that is not remembered is a no that gets asked again.
		if (searchTurn) _searchTurn.set(searchTurn, okSearch);
		// The account-level grant is recorded ONLY on a yes with the box ticked:
		// making the permissive, account-wide direction standing is the half that
		// needs the user's explicit word, exactly as the network dialog's tick is.
		if (okSearch && searchAns.standing && window.DaimondHandMode && DaimondHandMode.grantScope) {
			try { DaimondHandMode.grantScope('reading', true); } catch (e) { /* asked again, no worse */ }
		}
		return okSearch ? 'allow' : 'deny';
	}
	var url  = String(req.url || '');
	// An empty address must not be read as "here". `new URL('', href)` resolves
	// to the current page, whose host matches ours, so a missing url would have
	// been waved through as same-origin.
	if (!url.trim()) return 'deny';
	var host = egressHost(url);
	if (!host) return 'deny';						// unparseable: nothing to show the user.
	// DAIMOND'S OWN PAGES, which were never a question. Answered as a ONE-OFF yes
	// on the reading path, because a plain `allow` is now the word that RECORDS a
	// standing grant for the conversation (see `web_step` in src/tools.rs) — and a
	// grant recorded from a shortcut is a grant nobody was asked for. The acting
	// path keeps the plain word: it has no standing answer to be mistaken for, and
	// `verdict_of` on the other side takes nothing else.
	if (!strict && host === location.host) return reading ? 'allow-once' : 'allow';

	// WHEN THERE IS NOBODY HERE TO PUT THE QUESTION TO, it does not stall on a
	// screen nobody is at. Two cases, in order, both below the same-origin
	// shortcut so our own pages are no more gated than for anybody else.
	//
	// A RUNNER turn routes the question to the chat's SOURCE device. This is a turn
	// dispatched from another device, and the person is driving the chat from THAT
	// device -- so its permission (e.g. "operate a site for you") belongs there, not
	// on whoever is at the runner. It routes for ANY dispatched runner turn: the
	// earlier `!isAttended()` gate let an ATTENDED runner raise the dialog locally,
	// which is exactly the bug the owner hit -- the site-operation prompt appeared on
	// the runner (argonaut) instead of the source (gilgamesh) (owner report
	// 2026-09-05). Every dispatched turn has a source (`dispatchedBy`), so
	// `activeRunnerTurn()` alone is the condition. `routeConsentAsk` seals the ask,
	// addresses it to the source (falling back to an attended peer if the source is
	// offline), and awaits the answer in memory; on no reachable device or timeout it
	// parks (abandon + re-run, bounded). Not under `strict`, whose crystal-page
	// navigation is not a model act.
	if (!strict && runnerTurnOfReq(req)) {
		return await routeConsentAsk(req, host);
	}
	// A LOCAL unsupervised WORKER (alone, and no dispatched errand in flight)
	// keeps the on-panel park: nobody dispatched it from elsewhere, so there is
	// nowhere to send the question. The user's own attended turn is neither alone
	// nor a runner and falls through to the dialog below -- they typed the thing
	// that started it, so the question belongs on the screen they are looking at.
	// ALREADY ANSWERED, ABOVE THE PARK (UNBLOCK-21): a worker whose chat has said yes, or on
	// an account that grants reading, is not parked to ask again. Below the runner route,
	// whose source device owns the question, and never for a payload address.
	if (standingRead(req, url, strict)) return 'allow-once';
	if (req.alone && !someoneCanAnswer()) {
		return await parkConsent(req, host);
	}

	// Typing into a page is not reading it. The text is the thing being sent, so
	// it is shown, and consent is for this one act — a form post is exactly the
	// exfiltration the gate exists to catch, and it must not become routine.
	if (req.tool === 'web_type') {
		var typed = String(req.detail || '');
		// NOT cut to 300 characters, unlike every other body on this screen. This
		// is the one string a person is being asked to authorise SENDING, and the
		// sentence around it calls it "this": a card number sitting past the cut
		// would be approved unseen by somebody who was told they had read it. So
		// the whole of it is shown, however long. The card scrolls already
		// (`.modal-card`: max-height 80vh, overflow-y auto) and `.dlg-msg` wraps
		// an unbroken run, so a long form post costs a scrollbar, not a reader's
		// trust.
		var shownText = typed;
		var okType = await confirmDialog(
			req.alone
				? tOr('permmode.type_worker_body',
					'An agent working on its own wants to type this into {host} and send it:\n\n{text}\n\nYou are not driving it and it cannot ask you itself, so Daimond is asking. Text sent to a site cannot be recalled. Saying yes allows this one act and nothing after it.',
					{ host: host, text: shownText || t('egress.nothing') })
				: t('egress.type_body', { host: host, text: shownText || t('egress.nothing') }),
			t('egress.type_ok'),
			{ turn: req.turn, title: req.alone
				? tOr('permmode.act_worker_title', 'An agent wants to act on a page')
				: t('egress.type_title', { host: host }),
				danger: true,
				// Re-check of 2026-09-23: raised by the running turn: R6's guard applies.
				guard: true });
		return okType ? 'allow' : 'deny';		// never remembered.
	}
	// Clicking navigates, and a link's address is written by whoever wrote the
	// page. Acting on a page is approved separately from reading it: a yes about
	// reading a site is not a yes about operating it.
	if (req.tool === 'web_click') {
		// `alone` is a dispatched worker: nobody is reading its transcript and it
		// cannot put a question itself, so the app puts this one for it. The
		// per-host memory is skipped BOTH WAYS — not read, not written — because
		// "you approved a click on this host" is consent about a host and the rule
		// it is standing in for is about the ACT. One yes on shop.test must not
		// license the next click, and a worker's yes must not license the user's
		// own later browsing either.
		if (!req.alone && _egressAct[host]) return 'allow';
		var okAct = await confirmDialog(
			req.alone
				? tOr('permmode.act_worker_body',
					'An agent working on its own wants to click something on {host}. You are not driving it and it cannot ask you itself, so Daimond is asking. Clicking can spend your money, send a message or submit a form, and none of that can be taken back. Saying yes allows this one click and nothing after it.',
					{ host: host })
				: t('egress.act_body', { host: host }),
			t('egress.act_ok', { host: host }),
			{ turn: req.turn, title: req.alone
				? tOr('permmode.act_worker_title', 'An agent wants to act on a page')
				: t('egress.act_title', { host: host }),
				danger: true,
				// Re-check of 2026-09-23: raised by the running turn: R6's guard applies.
				guard: true });
		if (!okAct) return 'deny';
		if (!req.alone) _egressAct[host] = 1;
		return 'allow';
	}

	var load = egressPayload(url);
	var ok;
	// AN ADDRESS CARRYING A PAYLOAD IS ITS OWN QUESTION, and it is asked however
	// much this conversation has granted. That is the point of the grant's limit:
	// approving the web is not approving `example.test/?everything-I-know=…`, which
	// is the exact channel this whole gate exists to close. It sits ABOVE the
	// grant's shortcut for that reason, and moving it below would not fail loudly —
	// it would silently start letting encoded addresses out.
	if (load.heavy) {
		// The address itself is the thing to look at, so show it — trimmed, but
		// enough of it to recognise a file's worth of text where a page name
		// should be.
		var shown = load.text.length > 300 ? (load.text.slice(0, 300) + '…') : load.text;
		ok = await confirmDialog(
			t('egress.heavy_body', { host: host, text: shown }),
			t('egress.heavy_ok'),
			// Re-check of 2026-09-23: R6's guard, but only for the turn's own address --
			// under `strict` this is the crystal page's own link, raised by the click
			// that just happened, not by a turn while the person is elsewhere.
			{ turn: req.turn, title: t('egress.heavy_title', { host: host }), danger: true, guard: !strict });
		// SPENT ON THIS ONE ADDRESS, in words the engine cannot file as the
		// conversation's answer — in either direction. A yes here is not a yes to
		// the web, and a no here is not a no to it: declining one overlong address
		// must not cut the conversation off from everything.
		if (strict) return ok ? 'allow' : 'deny';
		return ok ? 'allow-once' : 'deny-once';
	}
	// The crystal page's own link, which no standing answer covers and which is
	// asked about one address at a time, for ever. See the note on `strict` above.
	//
	// NOT `guard`. Unlike every other dialog this door raises, this one follows
	// directly from a click the person just made inside the page -- it is not the
	// running turn interrupting them elsewhere, which is what R6's guard is for.
	if (strict) {
		ok = await confirmDialog(
			t('egress.reach_body', { host: host }),
			t('egress.reach_ok', { host: host }),
			{ turn: req.turn, title: t('egress.reach_title', { host: host }), danger: true });
		return ok ? 'allow' : 'deny';
	}
	// ALREADY ANSWERED, so nothing is drawn. `allow-once` rather than `allow`
	// because there is nothing new to record and re-recording is how a first
	// answer gets quietly replaced by a later one.
	if (granted) return 'allow-once';
	// The account's standing reading grant is checked by `standingRead`, above the park.
	// THE ONE ASK, AND IT ASKS FOR THE WHOLE THING. The user is agreeing that this
	// conversation may reach ANY website, which is materially bigger than "may
	// reach example.com" — so the dialog says that, in those words, at the moment
	// of asking. A wide grant collected in the words of a narrow one is consent to
	// something the person did not read.
	//
	// The site that provoked it is still named, because it is the fact that makes
	// the question concrete; what changed is that it is no longer the extent of
	// what is being given.
	ok = await confirmDialog(
		t('egress.any_body', { host: host }),
		t('egress.any_ok'),
		// Re-check of 2026-09-23: raised by the running turn (never reached under
		// `strict`, which returns above at `reach`): R6's guard applies.
		{ turn: req.turn, title: t('egress.any_title'), danger: true, guard: true });
	return ok ? 'allow' : 'deny';
}
// page-split: install 96

/// A link a crystal page asked the app to follow, put to the user.
///
/// The request is BUILT here from the href and nothing else. The page hands over a
/// string; if it were allowed to hand over the whole payload it could set `tool` and
/// pick which of the gate's doors it went through.
///
/// # Arguments
/// * `href` - What the page asked for, resolved against nothing and trusted for nothing.
export async function pageEgressAllowed(href) {
	var verdict = await egressAllowed(JSON.stringify({ url: String(href || '') }), { strict: true });
	return verdict === 'allow';
}

export function install() { // page-split: install
	// page-split: install 93

	window.DaimondDeletes = {
		/// Put a change to a file he made to him (`askChange`).
		change: askChange,
		/// Put the held delete to the person; resolves true only on their yes.
		held: function (payload) {
			var req = {};
			try { req = JSON.parse(String(payload || '{}')) || {}; } catch (e) { req = {}; }
			var key = String(req.keeper || '');
			var path = String(req.path || '');
			var wipe = req.act === 'wipe';
			var turn = String(req.turn || '');		// the asking turn's tag: its Stop closes this (D2)
			var next = wipe ? t('deletes.next_wipe', { path: path })
				: t('deletes.next_delete', { path: path });
			var vars = { who: deleteAsker(key), path: path, next: next };
			if (req.limit === 0) {
				var before = _deleteLine[key] || Promise.resolve(true);
				var one = before.then(function (last) {
					if (last === false) return false;
					return wipe
						? askHeldDelete(t('deletes.held_first_wipe', vars),
							t('deletes.held_title_one_wipe'), t('deletes.held_allow_one_wipe'), turn)
						: askHeldDelete(t('deletes.held_first', vars), t('deletes.held_title_one'),
							t('deletes.held_allow_one'), turn);
				});
				_deleteLine[key] = one;
				var off = function () { if (_deleteLine[key] === one) delete _deleteLine[key]; };
				one.then(off, off);
				return one;
			}
			if (_deleteAsks[key]) return _deleteAsks[key];
			var n = Math.max(0, req.count | 0);
			var ask = askHeldDelete(tn('deletes.held_body', n, vars), t('deletes.held_title'),
				t('deletes.held_allow'), turn);
			_deleteAsks[key] = ask;
			var done = function () { delete _deleteAsks[key]; };
			ask.then(done, done);
			return ask;
		},
	};
	// page-split: install 94
	try {
		['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
			window.addEventListener(ev, noteInteraction, { passive: true, capture: true });
		});
		// A visibility change -- switching back to this tab, or away from it -- is
		// also a person doing something with the page, not a script; count it too.
		document.addEventListener('visibilitychange', noteInteraction, { passive: true });
	} catch (e) { /* no window: attention stays false, so a runner parks (fail-safe) */ }
	// page-split: install 95

	// The one door another module in this file reaches the blocker through. The Files
	// panel is its own closure and cannot see these functions, so the FSA loss it
	// detects arrives here by name rather than by reaching across.
	window.DaimondHandoffBlock = {
		/// The folder grant went away under a handed-off turn: tell every device.
		folderLost: function () {
			try {
				var rc = activeRunnerTurn();
				if (!rc) return false;			// nothing handed off: the panel's notice is enough
				raiseBlocker(rc.turnId, {
					kind: 'fsa', detail: 'folder access', since: Date.now(),
				});
				return true;
			} catch (e) { return false; }
		},
	};
	// page-split: install 96

	// The wasm tools call this by name, exactly as the cloud bridge is called: an
	// agent's own tool calls are dispatched inside Rust, not through JS. The wasm
	// passes one argument, so `opts` is undefined and `strict` is false, exactly as
	// before; the second parameter is forwarded only so a verifier can drive the
	// strict path that `pageEgressAllowed` builds in production, and setting
	// `strict` can only make this MORE cautious (it is never auto-allowed).
	//
	// `opts.deadlineMs` is the same bargain: `netAskDeadline` clamps it to
	// `NET_ASK_DEADLINE_MS`, so a caller can only bring the unanswered REFUSAL
	// forward, never push it back and never turn it off.
	window.__daimondEgressAllowed = function (payloadJson, opts) { return egressAllowed(payloadJson, opts); };
	/// Why a publication must not be composed at all, or `''` where there is no
	/// reason. Read by `socialCompose` in `www/js/improve.js`.
	///
	/// The outer of the two doors, and it is the outer one so that the MODEL gets a
	/// sentence it can act on. `egressAllowed` can only answer yes or no, and its
	/// no arrives at the model as "the user was asked, and said no" -- which nobody
	/// asked and which would send the daimon off to apologise for a refusal that
	/// was never the user's. This says what actually happened. `egressAllowed`
	/// stays as the backstop, because a driver that is not loaded cannot refuse.
	window.DaimondPublishGuard = function () {
		if (!publishWithheld()) return '';
		// THE REMEDY IS SOMETHING THE MODEL CAN DO IN THIS TURN, which is the whole of why this
		// sentence exists rather than a bare no. A refusal whose remedy is out of the model's
		// reach becomes a loop: it re-puts the same call, differently worded, until the round
		// budget runs out. So the first thing named here is the thing it CAN do -- write the
		// draft into its answer -- and the user's own control is named second, as the thing
		// that would let it publish next time.
		return 'nothing was published, and nothing was composed. A daimon does not publish in '
			+ 'the user\'s name: a post is theirs, it is read by strangers, and nothing here '
			+ 'can take it back. WRITE WHAT YOU WOULD HAVE PUBLISHED INTO YOUR ANSWER, opening '
			+ '"I would post:" for a proposal, a vote or a comment, naming the proposal number '
			+ 'where there is one, or "I would post to followers:" for a feed post -- they can '
			+ 'then publish it themselves from the Social panel in one press, or tell this '
			+ 'diamond it may publish for them. Do not call this again in this turn.';
	};

	// The reachable hand-a-turn-to-a-peer hook (dev/PEER_DESIGN.md §4, step 4).
	// Exposed so the step-6 state machine that owns the dispatched/claimed/running/
	// done UI and its §5 copy can call the one dispatch path, without reaching into
	// the composer DOM blind. The ORDER and the errand it runs are tested in
	// peer.test.mjs via DaimondPeer.buildDispatch.
	window.__daimondDispatchToPeer = function (chat, turnId, promptText, scopePaths) {
		return handOffTurn(chat, turnId, promptText, scopePaths);
	};
} // page-split: end install
