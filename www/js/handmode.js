/* handmode.js — which permission mode Daimond is in, shown where the work is
 * watched and changed from there.
 *
 * One setting, three rungs, and the axis is what Daimond does WITHOUT ASKING:
 *
 *   ask       every command is put to you before it runs, and every fetch
 *   guarded   commands run; a turn that has read outside content loses the
 *             network and Daimond asks before reaching a page it chose
 *   bypass    nothing is asked
 *
 * No rung moves the fence, the system-call filter, a Diamond's folders or the
 * journal — those are the compartment and the record, and a mode that could
 * switch one off would not be a permission mode. The wording that says so to
 * the user lives in i18n/en.js under `permmode.`, and the wording that says it
 * to the model lives in Rust (src/prompts.rs), so neither can drift alone.
 *
 * A SECOND AXIS lives in the same popover and is not a fourth rung: the rungs
 * are one setting for the whole app, and whether ONE CHAT's commands may reach
 * the network is that chat's own state. It is here rather than in a chip of its
 * own because the button already claims this ground -- its hover text promised
 * "what Daimond does without asking", which is precisely this question -- and a
 * second permissions control beside one making that promise is two answers to
 * one thing. See `netState`/`setNet`.
 *
 * Two rules about the surface, and they pull opposite ways on purpose:
 *
 *   VISIBLE   the mode is a word in the chat header, beside the model. A mode
 *             you have to remember is one you will be wrong about, and being
 *             wrong about this one matters.
 *   QUIET     bypass explains itself ONCE, the first time it is chosen, and
 *             never again. A bypass that keeps interrupting is not a bypass.
 */
(function () {
	'use strict';

	var LS_MODE = 'daimond-permission-mode';
	var LS_ACK  = 'daimond-permission-bypass-ack';
	// The STANDING answer to the network question: '' asks once in each chat,
	// 'allow' and 'refuse' answer it in advance and for good.
	//
	// It is persisted, and that is the whole point of it. The answer itself lives on
	// a chat's engine object, which is built per chat and does not survive a reload
	// -- so "you can grant it and not be interrupted again" was true only of a chat
	// you had already gone into the menu to grant it in. Reported, in those words:
	// "I thought we got rid of this bullshit!" It was not got rid of; it was made
	// answerable. This is what gets rid of it.
	var LS_NET  = 'daimond-net-standing';

	/// The rungs, in the order they are offered: strictest first, so the list
	/// reads as a ladder and the last row is the one that gives most away.
	var MODES = ['ask', 'guarded', 'bypass'];
	var FALLBACK = 'guarded';

	var cfg = {};				// { apply, confirm, notice, onChange }
	var current = FALLBACK;
	var pop, chip, chipTxt;

	function t(k, v) {
		return (window.DaimondI18n ? DaimondI18n.t(k, v) : k);
	}

	function label(name) { return t('permmode.' + name); }
	function blurb(name) { return t('permmode.' + name + '_blurb'); }

	/// What this chat's network state says, as a sentence.
	///
	/// A switch of LITERAL keys and not `t('permmode.net_' + state)`, because
	/// `i18ncheck` cannot follow a key a call site builds: a composed one would
	/// have to be declared indirect, and five sentences that no sweep can see are
	/// five sentences that quietly stop being translated.
	function netSays(state) {
		switch (state) {
			case 'open':    return t('permmode.net_open');
			case 'cut':     return t('permmode.net_cut');
			case 'allowed': return t('permmode.net_allowed');
			case 'refused': return t('permmode.net_refused');
			default:        return '';
		}
	}

	/// This chat's network state, or '' where no chat can be asked -- before the
	/// engine exists, or on a surface that holds no conversation.
	///
	/// Bypass is answered here rather than in the wasm, which correctly reports
	/// `open`: the rung withholds nothing, so there is nothing to grant, and a
	/// button offering to grant it would do nothing and say it had.
	function netState() {
		if (current === 'bypass') return 'bypass';
		if (typeof cfg.netGet !== 'function') return '';
		var s = '';
		try { s = String(cfg.netGet() || ''); } catch (e) { s = ''; }
		// A chat with no engine yet has read nothing, which is what a fresh one with
		// an engine also reports. Returning '' would hide the section on exactly the
		// new chat where somebody wants to see what they have standing.
		return s || 'open';
	}

	/// What was saved, or the guarded rung. A stored value this build does not
	/// know is NOT rounded to the nearest thing: it falls back, because the safe
	/// reading of "I do not recognise that" is "give them the careful one".
	function load() {
		var raw = '';
		try { raw = localStorage.getItem(LS_MODE) || ''; } catch (e) { raw = ''; }
		return MODES.indexOf(raw) >= 0 ? raw : FALLBACK;
	}

	function save(name) {
		try { localStorage.setItem(LS_MODE, name); } catch (e) { /* private mode */ }
	}

	/// The standing answer, or '' where the user has not given one.
	///
	/// A value this build does not know falls back to asking, for the same reason a
	/// stored rung does: the safe reading of "I do not recognise that" is the careful
	/// one, and here the careful one is to put the question.
	function standing() {
		var raw = '';
		try { raw = localStorage.getItem(LS_NET) || ''; } catch (e) { raw = ''; }
		return (raw === 'allow' || raw === 'refuse') ? raw : '';
	}

	/// Record it, and push it into every engine that already exists.
	///
	/// BOTH HALVES. Storing it alone would leave every chat already open answering
	/// the old way until it was reloaded, and setting the engines alone would lose it
	/// on the next reload -- which is the defect this whole thing exists to fix.
	function setStanding(v) {
		try { localStorage.setItem(LS_NET, v); } catch (e) { /* private mode */ }
		if (typeof cfg.netApplyAll === 'function') {
			try { cfg.netApplyAll(v); } catch (e) { /* one engine gone is not a failure */ }
		}
		draw();
		if (pop && !pop.hidden) render();
	}

	function acked() {
		try { return localStorage.getItem(LS_ACK) === '1'; } catch (e) { return false; }
	}

	function ack() {
		try { localStorage.setItem(LS_ACK, '1'); } catch (e) { /* private mode */ }
	}

	/// Push the rung into the wasm, which is the only copy that decides anything.
	///
	/// If it will not take — an older wasm without the setter, a name it refuses
	/// — the JavaScript copy is put BACK to whatever the wasm still holds. A page
	/// showing "Bypass" over an engine running guarded is worse than either.
	function push(name) {
		if (typeof cfg.apply !== 'function') return false;
		try { cfg.apply(name); return true; }
		catch (e) { return false; }
	}

	function draw() {
		if (chipTxt) chipTxt.textContent = label(current);
		if (chip) {
			chip.dataset.mode = current;
			// Accent, not alarm. Bypass is the rung many people will live in, so
			// it is marked as "not the default" rather than scolded — and the word
			// carries the state regardless, so nothing rests on the colour.
			chip.classList.toggle('accent', current === 'bypass');
			// The hover names what THIS rung does. It used to name the category --
			// "Permission mode: what Daimond does without asking" -- which is the one
			// thing somebody hovering a button marked Guarded can already see, while
			// the sentence that answers them sat a click away in the popover.
			chip.title = label(current) + ' — ' + blurb(current);
			// A chat whose commands have lost the network says so on the button,
			// because it is a state that changes what a command can do and nothing
			// on screen showed it. The dot was already in the markup doing nothing.
			var ns = netState();
			var cut = (ns === 'cut' || ns === 'refused');
			chip.classList.toggle('net-cut', cut);
			chip.setAttribute('aria-label', t('permmode.chip_aria', { mode: label(current) })
				+ (cut ? ' ' + t('permmode.net_cut_mark') : ''));
		}
		var row = document.getElementById('astat-hand');
		if (row) {
			row.innerHTML = '';
			var dot = document.createElement('span');
			dot.className = 'astat-dot ' + (current === 'bypass' ? 'warn' : 'ok');
			var val = document.createElement('span');
			val.className = 'astat-val';
			val.textContent = t('permmode.astat', { mode: label(current) });
			row.appendChild(dot);
			row.appendChild(val);
			row.title = t('permmode.chip_help');
			row.onclick = function () { open(row); };
		}
		if (pop && !pop.hidden) render();
	}

	/// Move to a rung. Bypass explains itself the first time and never again.
	async function set(name) {
		if (MODES.indexOf(name) < 0) return false;
		if (name === current) { close(); return true; }
		if (name === 'bypass' && !acked()) {
			var ok = await cfg.confirm(
				t('permmode.bypass_body'),
				t('permmode.bypass_ok'),
				{ title: t('permmode.bypass_title'), danger: false });
			if (!ok) { draw(); return false; }
			ack();
		}
		if (!push(name)) {
			// The engine would not take it, so nothing changed. Say so rather than
			// drawing a mode that is not in force.
			if (typeof cfg.notice === 'function') cfg.notice(t('permmode.failed'));
			draw();
			return false;
		}
		current = name;
		save(name);
		draw();
		close();
		if (typeof cfg.onChange === 'function') cfg.onChange(name);
		return true;
	}

	// ── The picker ──────────────────────────────────────────────
	// A `.pop`, like the appearance menu and the panel gallery, so it dismisses
	// on Escape and on a click outside exactly as they do — and a radio group
	// inside it, so the arrow keys work without a line of code.

	function render() {
		pop.innerHTML = '';
		// The way out, in the corner every other closer in the app holds. This
		// popover is 359px wide on a 390px phone and left 8px of screen to its
		// right to tap: Escape and a click outside are not enough on their own.
		if (window.DaimondCloser) {
			pop.appendChild(DaimondCloser.head(t('permmode.title'), { onClose: close }));
		}
		var h = document.createElement('div');
		h.className = 'pop-head';
		h.textContent = t('permmode.lead');
		pop.appendChild(h);
		MODES.forEach(function (name) {
			var row = document.createElement('label');
			row.className = 'mode-row' + (name === current ? ' on' : '');
			var r = document.createElement('input');
			r.type = 'radio';
			r.name = 'daimond-permission-mode';
			r.value = name;
			r.checked = name === current;
			r.addEventListener('change', function () { set(name); });
			var txt = document.createElement('span');
			txt.className = 'mode-row-txt';
			var nm = document.createElement('span');
			nm.className = 'mode-row-name';
			nm.textContent = label(name);
			var bl = document.createElement('span');
			bl.className = 'mode-row-blurb';
			bl.textContent = blurb(name);
			txt.appendChild(nm);
			txt.appendChild(bl);
			row.appendChild(r);
			row.appendChild(txt);
			pop.appendChild(row);
		});
		var foot = document.createElement('p');
		foot.className = 'pop-note';
		foot.textContent = t('permmode.never');
		pop.appendChild(foot);
		renderNet();
	}

	/// This chat's own network, under the rungs and under a head of its own.
	///
	/// The head is what carries the scope: everything above it is the whole app
	/// and everything below it is this conversation, and without that line the
	/// section reads as a fourth rung -- which it is not, and which would make a
	/// per-chat state look like a setting that outlives the chat.
	///
	/// Nothing is drawn where there is no chat to answer for.
	function renderNet() {
		var state = netState();
		if (!state) return;
		var head = document.createElement('div');
		head.className = 'pop-head';
		// It said "This chat", and that became false the moment the control below it
		// became a STANDING answer: the sentence describes this conversation, the
		// three choices govern every one of them. A head naming one scope over a
		// section holding both is the kind of label that teaches somebody the wrong
		// thing and is never corrected. It names the subject instead, and the choices
		// say their own scope -- "Ask once per chat" is a rule about chats, not a
		// state of one.
		head.textContent = t('permmode.net_head');
		pop.appendChild(head);
		var line = document.createElement('p');
		line.className = 'pop-note net-now';
		line.textContent = (state === 'bypass') ? t('permmode.net_bypass') : netSays(state);
		pop.appendChild(line);
		// Bypass withholds nothing, so there is nothing to grant and no control.
		if (state === 'bypass') return;
		// THREE CHOICES AND NOT A TOGGLE, because a toggle has no way back to the
		// default. A two-state button would let a user leave "ask me" and never
		// return to it -- the same no-way-back this section was built to end, rebuilt
		// one level up. They are chips on one row rather than a second ladder: the
		// rungs above are a policy with reasons, this is one answer with three values.
		var now = standing();
		var row = document.createElement('div');
		row.className = 'net-row';
		[['',       'permmode.net_each'],
		 ['allow',  'permmode.net_always'],
		 ['refuse', 'permmode.net_never']].forEach(function (pair) {
			var b = document.createElement('button');
			b.type = 'button';
			b.className = 'chip-btn net-opt' + (pair[0] === now ? ' on' : '');
			b.setAttribute('aria-pressed', pair[0] === now ? 'true' : 'false');
			// Four literal keys, for the reason `netSays` is written the way it is.
			b.textContent = pair[1] === 'permmode.net_each'   ? t('permmode.net_each')
				: pair[1] === 'permmode.net_always' ? t('permmode.net_always')
				: t('permmode.net_never');
			b.addEventListener('click', function () { setStanding(pair[0]); });
			row.appendChild(b);
		});
		pop.appendChild(row);
	}

	function open(anchor) {
		if (!pop) return;
		if (!pop.hidden) { close(); return; }
		// The chip too, and not only the popover about to be drawn over it. Opening
		// the menu is the one moment the state is certainly being read, and a button
		// left saying the opposite of the panel hanging off it is worse than either.
		draw();
		render();
		pop.hidden = false;
		if (chip) chip.setAttribute('aria-expanded', 'true');
		var r = (anchor || chip).getBoundingClientRect();
		pop.style.top = (r.bottom + 6) + 'px';
		var left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8);
		pop.style.left = Math.max(8, left) + 'px';
		var first = pop.querySelector('input[type=radio]:checked') || pop.querySelector('input');
		if (first) first.focus();
	}

	function close() {
		if (!pop || pop.hidden) return;
		pop.hidden = true;
		if (chip) {
			chip.setAttribute('aria-expanded', 'false');
			try { chip.focus(); } catch (e) { /* gone from the page */ }
		}
	}

	/// Wire the surfaces and put the saved rung into the engine.
	///
	/// `apply` is the wasm setter, which only `daimond.js` can reach: this file
	/// is a classic script and the wasm is a module. `confirm` and `notice` are
	/// the app's own dialog and toast, for the same reason.
	///
	/// `netGet` and `netSet` reach the CURRENT chat's engine, which only the app
	/// knows -- this file has no notion of which conversation is on screen, and
	/// must not acquire one: a permission surface that picked its own subject
	/// could answer for a chat the user is not looking at.
	function init(opts) {
		cfg = opts || {};
		chip = document.getElementById('hand-mode-chip');
		chipTxt = document.getElementById('hand-mode-chip-txt');
		pop = document.getElementById('hand-mode-pop');
		current = load();
		// The engine is the authority. If the saved rung will not go in, the page
		// shows the guarded one the wasm is actually still in.
		if (!push(current)) current = FALLBACK;
		if (chip) chip.addEventListener('click', function (e) { e.stopPropagation(); open(chip); });
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape') close();
		});
		document.addEventListener('click', function (e) {
			if (!pop || pop.hidden) return;
			var path = e.composedPath ? e.composedPath() : null;
			var inside = path ? (path.indexOf(pop) >= 0 || path.indexOf(chip) >= 0)
				: (pop.contains(e.target) || (chip && chip.contains(e.target)));
			if (!inside) close();
		});
		if (window.DaimondI18n) DaimondI18n.onChange(draw);
		draw();
	}

	window.DaimondHandMode = {
		init: init,
		/// The standing answer to the network question, for `ensureApp` to put into
		/// each new engine. '' means the engine is left to ask.
		standingNet: standing,
		/// Redraw the chip from what is in force NOW.
		///
		/// The rung only moves when this file moves it, so the chip could always
		/// draw itself. This chat's network cannot: a turn that reads a page marks
		/// the chat while the popover is shut, and the mark on the button is the
		/// only thing on screen that says so. The app calls this where the
		/// conversation on screen changes and where a turn ends.
		refresh: draw,
		get:  function () { return current; },
		set:  set,
		list: function () {
			return MODES.map(function (n) { return { name: n, label: label(n) }; });
		},
	};
})();
