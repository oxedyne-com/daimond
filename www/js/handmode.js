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
			chip.setAttribute('aria-label', t('permmode.chip_aria', { mode: label(current) }));
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
	}

	function open(anchor) {
		if (!pop) return;
		if (!pop.hidden) { close(); return; }
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
		get:  function () { return current; },
		set:  set,
		list: function () {
			return MODES.map(function (n) { return { name: n, label: label(n) }; });
		},
	};
})();
