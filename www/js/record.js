// record.js — turn the way this app is actually used into a check that lasts.
//
// Every defect the owner of this app has personally hit has one shape: a claim
// nobody measured on the path he actually takes.  The network dialog asked three
// times because two sessions shipped a mechanism and left the DEFAULT alone, and
// nothing tested the default.  Vision routing was dead on the one path production
// uses.  Folds never folded because model behaviour was assumed.
//
// So this records the real path — the presses, in order, with the shape of the
// page after each one — and `dev/replay.mjs` drives the app back through it and
// says whether it still works.  A path he trips over once becomes an instrument.
//
// ── WHAT THIS MUST NEVER SEE ────────────────────────────────────────────────
//
// It records a real person using their own private workspace.  So the rule is an
// ALLOWLIST, not a blocklist: a fact reaches the recording only if it is named
// below as safe, and everything else — every attribute, all text, every value —
// is never read at all.  A blocklist would be a list of the leaks somebody
// thought of.
//
// Nothing typed, nothing displayed, no file name, no Diamond name, no chat text,
// no model output, nothing out of localStorage or IndexedDB.  Not one line here
// reads `.textContent`, `.innerText`, `.title`, `.href`, `.src`, `.placeholder`,
// `alt`, `aria-label` or any storage API -- grep the file and see.
//
// THE TWO EXCEPTIONS, NAMED HERE RATHER THAN LEFT TO BE FOUND.  `sizeOf` reads
// `.value` for its LENGTH and keeps a three-way bucket of it, for the reason
// given at that function; `start({ sizes: false })` drops even that.  And
// `buildVocab` GETs the app's own `index.html` to learn which words the app
// authored about itself -- a same-origin read of a file in this repository, with
// no body and nothing of the person's in it.  dev/RECORD.md states the rule, the
// two exceptions, and what would defeat the whole thing.
//
// Off until a person turns it on (Ctrl+Alt+R, or `DaimondRecord.start()`), loud
// while it is on (a badge that cannot be missed and stops it when pressed), and
// local when it finishes: the recording is a file the browser downloads, and
// there is no code here that sends one anywhere.
//
// ── HOW ─────────────────────────────────────────────────────────────────────
//
//   Ctrl+Alt+R          start;  press again to stop and save the file
//   DaimondRecord.dump()          the recording as an object, for a test harness
//   DaimondRecord.start({ sizes: false })   drop even the coarse size bucket
//
// A step's target is named by a SELECTOR built out of the app's own vocabulary —
// ids and classes that appear in the app's own stylesheets and markup, layout
// attributes, and `:nth-child` for position.  A word the app did not author
// cannot get in, because it is not in the vocabulary.
(function () {
	'use strict';

	var VERSION = 1;

	// ── The vocabulary: words this app authored about itself ─────────────
	//
	// Harvested from the same-origin stylesheets and from the served markup, both
	// of which are files in the repository.  A class or id is written into a
	// recording only if it is in here, so a name that came from the person using
	// the app — a Diamond called "tax-return", a folder called "clinic-notes" —
	// has nowhere to land even if it were somehow both lowercase and hyphenated.
	var vocab = null;			// Set, or null until built

	function harvestStyles(into) {
		var sheets = document.styleSheets, i, j, rules, sel, m;
		var re = /[.#](-?[A-Za-z_][-\w]*)/g;
		// `[data-panel="rail"]` and the like: a layout attribute the stylesheet
		// names is a layout attribute the app authored.
		var av = /\[[\w-]+\s*[~^|*$]?=\s*"?([\w.-]+)"?\s*\]/g;
		for (i = 0; i < sheets.length; i++) {
			try { rules = sheets[i].cssRules; } catch (e) { continue; }	// foreign origin
			if (!rules) continue;
			for (j = 0; j < rules.length; j++) {
				sel = rules[j].selectorText;
				if (!sel) continue;
				re.lastIndex = 0;
				while ((m = re.exec(sel))) into.add(m[1]);
				av.lastIndex = 0;
				while ((m = av.exec(sel))) into.add(m[1]);
			}
		}
	}

	function harvestMarkup(text, into) {
		var re = /\b(?:id|class)="([^"]*)"/g, m, k, parts;
		while ((m = re.exec(text))) {
			parts = m[1].split(/\s+/);
			for (k = 0; k < parts.length; k++) if (parts[k]) into.add(parts[k]);
		}
		// The values of the layout attributes too, so an attribute a later change
		// fills from something a person typed has no more of a way in than a class
		// would.  An element built at runtime whose `data-act` is therefore not
		// recognised simply falls back to its classes and its position, which the
		// probe in dev/RECORD.md shows is still a usable selector.
		var da = /\b(data-(?:act|panel|mpanel|view|zone|rail|mode|i18n))="([^"]*)"/g;
		while ((m = da.exec(text))) if (m[2]) into.add(m[2]);
	}

	// The served markup is fetched rather than read off the live document: by the
	// time anything here runs, scripts have already put their own elements in, and
	// an id created at runtime out of a name is exactly the thing being guarded
	// against.  `index.html` on disk is authored, so every id in it is the app's
	// own word.
	function buildVocab() {
		var v = new Set();
		harvestStyles(v);
		return fetch('index.html', { cache: 'no-store' })
			.then(function (r) { return r.ok ? r.text() : ''; })
			.catch(function () { return ''; })
			.then(function (text) {
				harvestMarkup(text, v);
				vocab = v;
				return v;
			});
	}

	// ── The redaction rule, in three predicates ──────────────────────────

	// Lowercase kebab, nothing else: `session-box`, `chat-input`, `admin-close`.
	var KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

	/// Is this token shaped like a word the app wrote, rather than like an id it
	/// minted or a word a person typed?
	///
	/// Capitals, spaces, punctuation, a long run of letters-and-digits (a base-36
	/// stamp, `Date.now().toString(36)`) and a bare number of three digits or more
	/// (a sequence, a year) all fail.  Shape alone is not trusted for anything —
	/// `known()` still has to recognise it — but it throws out the obvious first.
	function safeToken(s) {
		if (typeof s !== 'string' || !s || s.length > 48) return false;
		if (!KEBAB.test(s)) return false;
		var seg = s.split('-'), i, p;
		for (i = 0; i < seg.length; i++) {
			p = seg[i];
			if (p.length > 24) return false;
			if (/^[0-9]{3,}$/.test(p)) return false;			// c1732, 2025
			if (p.length >= 8 && /[0-9]/.test(p)) return false;	// lz4k9x2m
		}
		return true;
	}

	/// Did the app author this word about itself?
	function known(s) { return !!vocab && vocab.has(s); }

	// Layout attributes, by NAME.  Every one of these is set by the app out of a
	// closed set of its own: which panel, which zone, which action.  None of them
	// is ever filled from something a person typed — which is exactly why
	// `data-label` (a translated panel NAME) and `data-id` (an object's id) are
	// not here, and why the list is a list rather than a prefix match on `data-`.
	var ATTR_OK = ['data-act', 'data-panel', 'data-mpanel', 'data-view',
		'data-zone', 'data-rail', 'data-mode'];
	// A catalogue key, e.g. `rail.new_chat`.  Its own shape, because it has dots.
	var I18N_KEY = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
	// `type` on a form control is HTML grammar with a closed set of values, so it
	// is allowed by VALUE rather than by shape.
	var TYPE_OK = ['text', 'button', 'submit', 'reset', 'checkbox', 'radio',
		'file', 'number', 'range', 'search', 'email', 'url', 'tel', 'date',
		'time', 'color', 'hidden'];

	function esc(s) { return s.replace(/["\\]/g, '\\$&'); }

	/// One element's share of a selector, out of the allowlist and nothing else.
	function token(el) {
		var t = el.tagName.toLowerCase(), out = t, i, a, v, cls, n = 0;
		if (safeToken(el.id) && known(el.id)) return '#' + el.id;
		for (i = 0; i < ATTR_OK.length; i++) {
			v = el.getAttribute(ATTR_OK[i]);
			if (v && safeToken(v) && known(v)) { out += '[' + ATTR_OK[i] + '="' + esc(v) + '"]'; break; }
		}
		v = el.getAttribute('data-i18n');
		if (v && v.length <= 48 && I18N_KEY.test(v) && known(v)) out += '[data-i18n="' + esc(v) + '"]';
		if (t === 'input' || t === 'button') {
			v = el.getAttribute('type');
			if (v && TYPE_OK.indexOf(v) >= 0) out += '[type="' + v + '"]';
		}
		cls = (el.getAttribute('class') || '').split(/\s+/);
		for (i = 0; i < cls.length && n < 3; i++) {
			if (safeToken(cls[i]) && known(cls[i])) { out += '.' + cls[i]; n++; }
		}
		return out;
	}

	// What a person means by "I pressed that".
	//
	// A real mouse lands on whatever pixel is under it, which for an icon button
	// is the `<path>` inside the `<svg>` inside the `<button>` -- so the first
	// recording made this way named `#admin-close > svg.ic > path:nth-child(1)`.
	// It works, because the event bubbles either way, but it is a selector that
	// breaks the next time somebody redraws the icon, and it does not say what was
	// pressed.  The control is what was pressed.
	var PRESSABLE = 'button, a, input, select, textarea, label, summary,'
		+ ' [role="button"], [role="tab"], [role="menuitem"], [data-act], [tabindex]';

	function pressed(el) {
		var c = el.closest && el.closest(PRESSABLE);
		return (c && c !== document.body) ? c : el;
	}

	/// Which child of its parent, 1-based, so a token that names a whole row of
	/// identical tiles still names ONE of them.
	function nth(el) {
		var i = 1, s = el;
		while ((s = s.previousElementSibling)) i++;
		return i;
	}

	/// A CSS selector for `el`, as short as still resolves to it alone.
	///
	/// The full chain from `<body>` is built first and then trimmed from the LEFT
	/// while the remainder still picks out the same single element, so an element
	/// with an id of its own comes out as `#chat-send` and one without comes out
	/// as however much of its ancestry it takes to be unambiguous.  Trimming and
	/// then re-testing is what keeps a short selector honest: it is short because
	/// it was measured to be enough, not because it looked like enough.
	function selectorFor(el) {
		var chain = [], cur = el, depth = 0, full, i, cut;
		while (cur && cur.nodeType === 1 && cur !== document.body && depth < 12) {
			var tk = token(cur);
			// A bare tag name says nothing; position rescues it.
			if (/^[a-z]+$/.test(tk)) tk += ':nth-child(' + nth(cur) + ')';
			chain.unshift(tk);
			if (tk.charAt(0) === '#') break;			// an id ends the walk
			cur = cur.parentElement;
			depth++;
		}
		if (!chain.length) return null;
		full = chain.join(' > ');
		for (i = 0; i < chain.length; i++) {
			cut = chain.slice(i).join(' > ');
			try {
				if (document.querySelectorAll(cut).length === 1
					&& document.querySelector(cut) === el) return cut;
			} catch (e) { /* an unparseable token: keep walking */ }
		}
		return full;
	}

	// ── The shape of the page, which is what a step is checked against ───
	//
	// A selector still resolving proves the button is there.  It does not prove
	// the press DID anything, and "the press did nothing" is the whole family of
	// defects this exists for.  So each step also carries the shape of the page
	// immediately after it: which landmarks are on screen, how many tiles are in
	// the rail, how many dialogs are up, whether the focus is a chat or a Diamond.
	//
	// Every field is a count, a boolean or a word out of a closed set.  None of
	// them can carry a name, a path or a sentence.
	var LANDMARKS = ['identity-modal', 'admin-body', 'chat-input', 'chat-send',
		'session-list', 'diamond-view', 'new-session-btn', 'admin-close'];

	function visible(el) {
		return !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
	}

	function shape() {
		var s = { on: {}, n: {} }, i, el;
		for (i = 0; i < LANDMARKS.length; i++) {
			el = document.getElementById(LANDMARKS[i]);
			s.on[LANDMARKS[i]] = visible(el);
		}
		// Counts of things a person can see, by the app's own classes.
		s.n.tiles  = document.querySelectorAll('#session-list .session-box').length;
		s.n.dialog = [].filter.call(document.querySelectorAll('.modal'), visible).length;
		s.n.start  = [].filter.call(document.querySelectorAll('.tile-start'), visible).length;
		// How many things are in the thread -- not one word of what any of them
		// says.  This is what makes "and then the turn happened" checkable: a send
		// that reaches nothing leaves the count where it was.
		s.n.msgs   = document.querySelectorAll('#chat-output .chat-msg').length;
		// KIND of focus, never its id: "a chat" and "a Diamond" are the two words
		// this can hold.
		try {
			var f = window.DaimondAttach && window.DaimondAttach.focus();
			s.focus = (f && f.kind === 'chat') ? 'chat' : (f && f.kind) ? 'diamond' : 'none';
		} catch (e) { s.focus = 'none'; }
		return s;
	}

	// ── Recording ────────────────────────────────────────────────────────

	var on = false, steps = [], t0 = 0, opts = {}, badge = null, countEl = null;

	/// Is this event inside the passphrase gate?
	///
	/// Dropped whole, both halves of the reason.  The gate holds the one field on
	/// the page whose LENGTH is worth guessing at, and a replay signs itself in
	/// through the harness anyway, so a recorded press of it would be a privacy
	/// risk that also could not be replayed.
	function atGate(el) {
		if (!el || !el.closest) return false;
		if (el.closest('#identity-modal')) return true;
		if (el.tagName === 'INPUT' && el.getAttribute('type') === 'password') return true;
		return false;
	}

	/// How much was typed, to the nearest order of magnitude — or nothing.
	///
	/// THIS IS THE ONE FIELD DERIVED FROM CONTENT and it is called out here and in
	/// dev/RECORD.md rather than buried.  It is a bucket, not a length: `short`,
	/// `medium`, `long`.  It earns its place because a pasted essay and a two-word
	/// question take different paths through this app — chunking, compaction, the
	/// reply-length cap — and a replay that always typed the same filler could
	/// never tell those paths apart.  `start({ sizes: false })` drops it, and then
	/// nothing whatever about what was typed is recorded.
	function sizeOf(el) {
		if (opts.sizes === false) return undefined;
		var n = 0;
		try { n = (el.value || '').length; } catch (e) { return undefined; }
		return n === 0 ? 'empty' : n < 40 ? 'short' : n < 400 ? 'medium' : 'long';
	}

	function push(step, el) {
		var sel = selectorFor(el);
		if (!sel) return;
		step.sel = sel;
		step.t   = Date.now() - t0;
		steps.push(step);
		// The shape is taken after the app has had a frame to react, which is what
		// makes it a check on the press rather than on the moment before it.
		setTimeout(function () { step.after = shape(); paint(); }, 250);
	}

	/// Did a person cause this event?
	///
	/// `isTrusted` is false for anything a script dispatched, and this app
	/// dispatches plenty: `input` and `change` on its own form controls, `click`
	/// on a button it is driving itself.  Those are the app talking to itself, and
	/// a recording that carried them would hold steps NOBODY TOOK -- some of them
	/// on elements that were never on the screen -- which a replay could then only
	/// fail on for ever.  A real press, a real keystroke and a real paste are all
	/// trusted, so nothing a person actually does is lost by asking.
	function byHand(ev) { return !!ev && ev.isTrusted; }

	/// Is this the recorder's own badge?  Its press is how a person stops, not a
	/// step in what they were doing, and it is not part of the app under test.
	function mine(el) {
		return !!(el && el.closest && el.closest('#daimond-rec-badge'));
	}

	function onClick(ev) {
		var el = ev.target;
		if (!on || !el || el.nodeType !== 1 || !byHand(ev) || atGate(el) || mine(el)) return;
		// A person cannot press what is not on the screen, so a click on a hidden
		// element came from a script -- and a recorded step nobody could have taken
		// is a step a replay would fail on forever.
		if (!visible(el)) return;
		push({ type: 'click' }, pressed(el));
	}

	// Keys are recorded ONLY where the key IS the command: Enter, Escape, Tab, the
	// arrows, and anything held with Ctrl or Meta.  A character key is a letter
	// somebody typed, so it is not looked at.
	var KEY_OK = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft',
		'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete'];

	function onKey(ev) {
		var el = ev.target;
		if (!on || !byHand(ev) || atGate(el)) return;
		var cmd = ev.ctrlKey || ev.metaKey;
		if (!cmd && KEY_OK.indexOf(ev.key) < 0) return;
		// A chord's letter is a command name, not prose, so it may be named; a
		// bare key is named only because it is in the list above.
		var name = (ev.ctrlKey ? 'Ctrl+' : '') + (ev.metaKey ? 'Meta+' : '')
			+ (ev.altKey ? 'Alt+' : '') + (ev.shiftKey ? 'Shift+' : '')
			+ (ev.key.length === 1 ? ev.key.toUpperCase() : ev.key);
		push({ type: 'key', key: name }, el.nodeType === 1 ? el : document.body);
	}

	// A typing burst becomes ONE step when it stops, so a sentence is one row in
	// the recording rather than forty.
	var typingIn = null, typingTimer = 0;

	function flushTyping() {
		if (!typingIn) return;
		var el = typingIn; typingIn = null;
		push({ type: 'type', size: sizeOf(el) }, el);
	}

	function onInput(ev) {
		var el = ev.target;
		if (!on || !el || el.nodeType !== 1 || !byHand(ev) || atGate(el)) return;
		var t = el.tagName;
		if (t !== 'INPUT' && t !== 'TEXTAREA' && !el.isContentEditable) return;
		if (typingIn && typingIn !== el) flushTyping();
		typingIn = el;
		clearTimeout(typingTimer);
		typingTimer = setTimeout(flushTyping, 600);
	}

	function onChange(ev) {
		var el = ev.target;
		if (!on || !el || el.nodeType !== 1 || !byHand(ev) || atGate(el)) return;
		var t = el.tagName;
		if (t === 'SELECT') {
			// The INDEX of the option, never its text: an option can be a file, a
			// folder or a Diamond, and its position in the list cannot.
			push({ type: 'select', index: el.selectedIndex }, el);
		} else if (t === 'INPUT' && /^(checkbox|radio)$/.test(el.getAttribute('type') || '')) {
			push({ type: 'toggle', checked: !!el.checked }, el);
		} else if (t === 'INPUT' && el.getAttribute('type') === 'file') {
			// That a file was chosen, and how many.  Never which.
			push({ type: 'files', n: (el.files || []).length }, el);
		}
	}

	function onHash() {
		if (!on) return;
		var h = (location.hash || '').replace(/^#/, '');
		steps.push({ type: 'route', route: safeToken(h) ? h : '', t: Date.now() - t0, after: shape() });
		paint();
	}

	// ── The badge, which is how "it is recording" is not a thing to remember ──

	function paint() {
		if (countEl) countEl.textContent = String(steps.length);
	}

	function showBadge() {
		if (badge) return;
		badge = document.createElement('button');
		badge.id = 'daimond-rec-badge';
		badge.type = 'button';
		badge.setAttribute('aria-live', 'polite');
		badge.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;'
			+ 'display:flex;align-items:center;gap:8px;padding:8px 13px;border-radius:999px;'
			+ 'border:1px solid #ff4d4d;background:#2a0d0d;color:#ffd9d9;cursor:pointer;'
			+ 'font:600 13px/1 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.45)';
		var dot = document.createElement('span');
		dot.style.cssText = 'width:9px;height:9px;border-radius:50%;background:#ff3b3b;'
			+ 'animation:daimond-rec-blink 1.1s steps(2,start) infinite';
		countEl = document.createElement('span');
		var label = document.createElement('span');
		label.textContent = 'recording — press to stop';
		badge.appendChild(dot);
		badge.appendChild(countEl);
		badge.appendChild(label);
		badge.addEventListener('click', function (e) { e.stopPropagation(); stop(); });
		var css = document.createElement('style');
		css.id = 'daimond-rec-css';
		css.textContent = '@keyframes daimond-rec-blink{to{opacity:.15}}';
		document.head.appendChild(css);
		document.body.appendChild(badge);
		paint();
	}

	function hideBadge() {
		if (badge) badge.remove();
		var c = document.getElementById('daimond-rec-css');
		if (c) c.remove();
		badge = null; countEl = null;
	}

	// ── The public surface ───────────────────────────────────────────────

	var listening = false;
	// The shape of the page at the moment recording began.
	var startShape = null;

	function listen() {
		if (listening) return;
		listening = true;
		// Capture phase, so a handler that stops propagation cannot make a press
		// invisible to the recording.  Passive, so nothing here can change what
		// the app does with the event.
		var o = { capture: true, passive: true };
		document.addEventListener('click', onClick, o);
		document.addEventListener('keydown', onKey, o);
		document.addEventListener('input', onInput, o);
		document.addEventListener('change', onChange, o);
		window.addEventListener('hashchange', onHash);
	}

	/// Begin recording.  Nothing at all is captured before this is called.
	function start(o) {
		if (on) return Promise.resolve(false);
		opts = o || {};
		return (vocab ? Promise.resolve(vocab) : buildVocab()).then(function () {
			on = true;
			steps = [];
			t0 = Date.now();
			listen();
			showBadge();
			// The shape BEFORE the first press, so a replay can say "this recording
			// began somewhere else" rather than blaming step one.
			startShape = shape();
			return true;
		});
	}

	/// The recording as an object.  This is the whole of what leaves the page.
	function dump() {
		return {
			v:        VERSION,
			at:       new Date().toISOString().slice(0, 19) + 'Z',
			// The window, because a rail that collapses under 900px is a different
			// path and a replay at another width would be testing another app.
			viewport: { w: window.innerWidth, h: window.innerHeight },
			// The page within the app, only if it is one of the app's own words.
			route:    safeToken((location.hash || '').replace(/^#/, ''))
				? location.hash.replace(/^#/, '') : '',
			sizes:    opts.sizes !== false,
			start:    startShape,
			steps:    steps.slice()
		};
	}

	/// Stop, and hand the recording to the person as a file.
	///
	/// A download, because that is a place they can read it, move it and delete
	/// it.  There is no other exit from this module: nothing here posts, fetches
	/// with a body, opens a socket, or writes to any store the app syncs.
	function stop() {
		if (!on) return null;
		flushTyping();
		on = false;
		hideBadge();
		// A press in the last quarter-second has not had its shape taken yet, and a
		// step with no shape is a step a replay can only check halfway.  Take it now.
		var live = shape();
		for (var i = 0; i < steps.length; i++) if (!steps[i].after) steps[i].after = live;
		var rec = dump();
		try {
			var blob = new Blob([JSON.stringify(rec, null, '\t')], { type: 'application/json' });
			var a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = 'daimond-recording-' + rec.at.replace(/[:T]/g, '-').replace('Z', '') + '.json';
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
		} catch (e) { /* the object is still there for `dump()` */ }
		return rec;
	}

	// Ctrl+Alt+R.  Nothing else in this app binds Alt with Ctrl (the one keyboard
	// chord in daimond.js is a bare F6), and the toggle is deliberately awkward so
	// it is not reached by accident.
	window.addEventListener('keydown', function (ev) {
		if (!ev.ctrlKey || !ev.altKey || ev.metaKey) return;
		if ((ev.key || '').toLowerCase() !== 'r') return;
		ev.preventDefault();
		if (on) stop(); else start();
	}, true);

	window.DaimondRecord = {
		start:     start,
		stop:      stop,
		dump:      dump,
		recording: function () { return on; },
		// Exposed for dev/replay.mjs, which asks the live page for the shape it can
		// see so the comparison is made by the same code that made the recording.
		shape:     shape,
		// Exposed so a reader can try the redaction rule on a word themselves.
		selector:  selectorFor,
		_vocab:    function () { return vocab ? vocab.size : 0; }
	};
})();
