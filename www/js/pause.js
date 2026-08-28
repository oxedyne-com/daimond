/* ============================================================
   Daimond — the pause tree (DaimondPause)
   ------------------------------------------------------------
   One control, six placements, and a rule that makes the top of
   the rail honest.

   Notes2 asks for a pause/play/traffic-light on the rail, on each
   mailbox, on each mail folder, on each Diamond, on each
   triggered action, and globally. Six placements of one control.
   What had to be settled was not how it looks but what AMBER
   means, because a colour that can be set by hand means nothing:

     A leaf is binary: playing or paused. A branch shows green
     when every leaf under it plays, red when none does, and
     amber otherwise. Amber is DERIVED and can never be set.
     Clicking a branch pauses all its leaves, or resumes them.

   That is why the global control is not a seventh setting — it is
   the root of the same tree. It also means only leaves hold
   state, so this module stores a set of paused leaf ids and
   nothing else. Everything a branch shows is computed.

   Two consequences worth stating, because both are deliberate:

     - A leaf that appears later PLAYS. Pause every Diamond, make
       a new one, and the branch goes amber rather than the new
       Diamond arriving paused. A branch has no state to inherit,
       and inventing one would be the settable amber this rule
       exists to forbid. Something that must start paused is
       seeded paused when it is created.

     - Pause is about SPENDING, not access. A paused Diamond still
       opens, its crystal still renders, its files still list. The
       control that greyed out the whole object would be a
       different feature wearing the same icon.

   Enforcement is not here and is not in the widget: it is at the
   points where money is committed — the key mint, the governor's
   dispatch gate, and the gateway calls that spend. A pause the UI
   respects and the network does not is decoration.

   The decision logic here is pure and separately testable; the
   widget and its DOM live in daimond.js, which owns them, exactly
   as the governor is split. This module holds state and answers
   questions.

   Attaches a single global, `window.DaimondPause`. Also exported
   for Node, so the pure core can be unit-tested without a
   browser.
   ============================================================ */
(function () {
	'use strict';

	// Per-account; accounts.js namespaces every `daimond-*` key.
	var STORE_KEY = 'daimond-pause';

	// ── Node ids ───────────────────────────────────────────────
	// Slash-delimited paths, so an ancestor is a string prefix and
	// the tree can be walked without the tree being present. The
	// shapes in use, all built by `DaimondPause.id`:
	//
	//   root
	//   root/diamonds
	//   root/diamonds/<diamondId>              branch, when it has triggers
	//   root/diamonds/<diamondId>/self         leaf: the daimon's own turns
	//   root/diamonds/<diamondId>/triggers/<n> leaf: one triggered action
	//   root/chats/<chatId>                    leaf
	//   root/mail/<accountId>                  branch
	//   root/mail/<accountId>/<folder>         leaf
	//   root/workers                           leaf: the global worker pump
	//   root/web                               leaf: fetching a page through the gateway
	//
	// `root/web` is not one of notes2's six placements. It is here because a web
	// fetch spends and had nowhere to be charged: without it the enforcement had
	// to fall back to the global control, which means a page fetch was held only
	// when EVERYTHING was — and on a new account, whose tree has no leaves at all,
	// the global control read green, so it was never held. A spend with no node
	// is a spend with no pause. (That account's control reads RED now, since the
	// light counts armed leaves; the argument for the node is unchanged, because
	// it was never about the colour.)
	//
	// A node that both spends and has children is modelled as a
	// branch with a `self` leaf, so the "only leaves hold state"
	// rule never needs an exception.

	var ROOT = 'root';

	/// Build a node id from parts, escaping any slash a name carries.
	/// A Diamond id or a mail folder is user- or server-named, and one
	/// containing a slash would otherwise invent a level in the tree.
	function id() {
		var parts = [];
		for (var i = 0; i < arguments.length; i++) {
			var s = arguments[i];
			if (s == null || s === '') continue;
			parts.push(String(s).replace(/%/g, '%25').replace(/\//g, '%2F'));
		}
		return parts.join('/');
	}

	// ── Pure core ──────────────────────────────────────────────
	// No DOM, no storage, no clock. A tree is `{ id, kind, label,
	// children }`; a node with no `children` array is a leaf.

	/// Every leaf id at or under `node`. A leaf returns itself.
	///
	/// A leaf is a node with **no `children` array at all**, not one whose array
	/// is empty. An empty branch — a mailbox whose folders have not loaded, a
	/// Diamonds section on a new account — is still a branch: treating it as a
	/// leaf gave it a pause flag of its own, so pausing the root wrote a phantom
	/// id that nothing would ever resume, and the empty-branch rule in `stateOf`
	/// could never fire.
	function leavesUnder(node) {
		if (!node) return [];
		if (!node.children) return [node.id];
		var out = [];
		for (var i = 0; i < node.children.length; i++) {
			out = out.concat(leavesUnder(node.children[i]));
		}
		return out;
	}

	/// Find a node by id within a tree, or null.
	function findNode(tree, wanted) {
		if (!tree) return null;
		if (tree.id === wanted) return tree;
		for (var i = 0; tree.children && i < tree.children.length; i++) {
			var hit = findNode(tree.children[i], wanted);
			if (hit) return hit;
		}
		return null;
	}

	/// Every leaf id at or under `node` that is ARMED -- that is, that has
	/// something set up to spend WITHOUT ANYBODY ASKING.
	///
	/// ── WHAT THE LIGHT IS ABOUT, WHICH CHANGED ─────────────────
	///
	/// It used to be about whether anything had been PAUSED, so a node nobody had
	/// touched read green and green was taken to mean "running". The owner read
	/// the Email panel exactly that way and said so: it "shows green when all
	/// mailboxes are updated manually", which is to say green while no automation
	/// existed at all, and "in the default case, the light should show red, since
	/// there is no automation running".
	///
	/// He is right, and the old reading has a second fault the first hides. A
	/// triggered action turned OFF is not paused, so its leaf read green and its
	/// light said running -- while `DaimondTriggers.ready` refused to fire it. The
	/// light reported a surface flag; the thing that decides is `allowed()`, which
	/// is `ready(t) && !paused(leaf)`. Two of the three colours were being drawn
	/// from half of that expression.
	///
	/// So a leaf now counts towards the light only when it is armed, and the light
	/// says the whole of `allowed()`: red where nothing under here can go off on
	/// its own, green where everything that can, will, amber in between.
	///
	/// `armed` is a field on the tree node and its ABSENCE MEANS ARMED. A leaf
	/// added later without thinking about this behaves exactly as it did before
	/// rather than silently dropping out of every light above it.
	function armedUnder(node) {
		if (!node) return [];
		if (!node.children) return (node.armed === false) ? [] : [node.id];
		var out = [];
		for (var i = 0; i < node.children.length; i++) {
			out = out.concat(armedUnder(node.children[i]));
		}
		return out;
	}

	/// The four states, derived. `paused` is a set-like object whose
	/// own keys are the paused leaf ids.
	///
	///   idle    nothing under here runs on its own. RED.
	///   pause   everything that could is held. RED.
	///   mixed   some are held. AMBER, and only ever arrived at.
	///   play    everything that could, will. GREEN.
	///
	/// `idle` and `pause` are both red and are not the same fact, which is why
	/// they are not one value: "there is no automation here" and "the automation
	/// here is stopped" are different things to say to somebody, and the widget
	/// says them differently. They offer the same two buttons.
	///
	/// A branch with no ARMED leaf under it is `idle`, and that replaces the old
	/// rule that made it green. The argument for green was that calling an empty
	/// mailbox red "would make the global control red for a new account that has
	/// done nothing wrong" -- but red here is not an accusation and never was. It
	/// is the answer to "is anything running by itself?", and on a new account the
	/// honest answer is no.
	function stateOf(node, paused) {
		var leaves = armedUnder(node);
		if (!leaves.length) return 'idle';
		var n = 0;
		for (var i = 0; i < leaves.length; i++) {
			if (paused && paused[leaves[i]]) n++;
		}
		if (n === 0) return 'play';
		if (n === leaves.length) return 'pause';
		return 'mixed';		// amber, and only ever arrived at
	}

	/// The set that results from setting `node` to playing or paused.
	/// Returns a NEW object; the caller decides whether it changed.
	function applySet(node, paused, playing) {
		var next = {};
		for (var k in paused) if (paused[k]) next[k] = true;
		var leaves = leavesUnder(node);
		for (var i = 0; i < leaves.length; i++) {
			if (playing) delete next[leaves[i]];
			else next[leaves[i]] = true;
		}
		return next;
	}

	/// What clicking a node does. A branch showing amber resumes —
	/// the alternative is a click that pauses the leaves already
	/// playing, which reads as the control fighting the user.
	///
	/// `idle` resumes too, and that is deliberate rather than incidental: a node
	/// with nothing armed may still hold leaves somebody paused before they turned
	/// the automation off, and play is the way to let those go. It is the only
	/// press on this control that can look like it did nothing, which is why the
	/// state word says "nothing set up" rather than "paused".
	function clickWould(node, paused) {
		return stateOf(node, paused) === 'play' ? 'pause' : 'play';
	}

	/// The stored form: a SORTED array and a stamp that moves only
	/// when the set does.
	///
	/// Sorted because the sync parcel has to be a fixed point — a set
	/// serialised in hash order differs between two collects, the
	/// device then always has news, and two devices push at each other
	/// for ever. That has happened here twice; see
	/// `dev/verify_parcelstable.mjs`.
	function toRecord(paused, stamp) {
		var out = [];
		for (var k in paused) if (paused[k]) out.push(k);
		out.sort();
		return { paused: out, stamp: stamp || 0 };
	}

	/// The set from a stored record, tolerating anything.
	function fromRecord(rec) {
		var set = {};
		var list = (rec && rec.paused) || [];
		for (var i = 0; i < list.length; i++) {
			if (typeof list[i] === 'string' && list[i]) set[list[i]] = true;
		}
		return set;
	}

	/// Merge two records for the sync. The later stamp wins whole;
	/// EQUAL stamps take the union, which errs towards paused.
	///
	/// Union at an equal stamp is the lesson of the tag-loss incident:
	/// two devices that changed within the same millisecond otherwise
	/// silently discard one side's change. Erring towards paused is
	/// the safe direction — the cost of a wrong pause is a click, the
	/// cost of a wrong resume is money.
	function mergeRecords(a, b) {
		var sa = (a && a.stamp) || 0;
		var sb = (b && b.stamp) || 0;
		if (sa > sb) return toRecord(fromRecord(a), sa);
		if (sb > sa) return toRecord(fromRecord(b), sb);
		var set = fromRecord(a);
		var other = fromRecord(b);
		for (var k in other) set[k] = true;
		return toRecord(set, sa);
	}

	// ── Stateful shell ─────────────────────────────────────────
	// Storage, the clock, the live tree and the subscribers. None of
	// this runs under Node; the export at the foot hands out the pure
	// core only.

	var _paused = null;		// lazily loaded set
	var _stamp  = 0;
	var _tree   = null;		// a function returning the live tree
	var _subs   = [];

	function now() {
		return (typeof Date !== 'undefined') ? Date.now() : 0;
	}

	function load() {
		if (_paused) return;
		_paused = {};
		_stamp = 0;
		try {
			var raw = localStorage.getItem(STORE_KEY);
			if (raw) {
				var rec = JSON.parse(raw);
				_paused = fromRecord(rec);
				_stamp = (rec && rec.stamp) || 0;
			}
		} catch (e) { /* storage blocked or corrupt: everything plays */ }
	}

	function save() {
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify(toRecord(_paused, _stamp)));
		} catch (e) { /* quota */ }
	}

	function announce() {
		for (var i = 0; i < _subs.length; i++) {
			try { _subs[i](); } catch (e) { /* a listener must not stop the others */ }
		}
		try {
			if (typeof window !== 'undefined' && window.dispatchEvent) {
				window.dispatchEvent(new CustomEvent('daimond:pause'));
			}
		} catch (e) { /* no CustomEvent in this context */ }
	}

	/// Register the function that returns the live tree. daimond.js
	/// builds it from the Diamonds, chats, mailboxes and triggers that
	/// exist at the moment it is asked.
	function setTree(fn) { _tree = fn; }

	function tree() {
		try { return (typeof _tree === 'function') ? _tree() : null; } catch (e) { return null; }
	}

	/// Is this leaf paused? The whole answer for a leaf is its own
	/// flag: branches hold no state, so there is no ancestor to
	/// consult and no tree to walk. Enforcement calls this, and it
	/// must stay cheap enough to sit in front of every spend.
	function isPaused(nodeId) {
		if (!nodeId) return false;
		load();
		return !!_paused[nodeId];
	}

	/// The state of any node, leaf or branch: 'play', 'pause' or
	/// 'mixed'. Needs the tree, so an unknown id answers from its own
	/// flag alone rather than pretending.
	function state(nodeId) {
		load();
		var t = tree();
		var node = t ? findNode(t, nodeId) : null;
		if (!node) return _paused[nodeId] ? 'pause' : 'play';
		return stateOf(node, _paused);
	}

	/// Set a node playing or paused, writing every leaf under it.
	/// Returns true when something actually changed — the stamp moves
	/// only then, which is what keeps the sync parcel a fixed point.
	function set(nodeId, playing) {
		load();
		var t = tree();
		var node = (t ? findNode(t, nodeId) : null) || { id: nodeId };
		var next = applySet(node, _paused, playing);
		var before = JSON.stringify(toRecord(_paused, 0));
		var after  = JSON.stringify(toRecord(next, 0));
		if (before === after) return false;
		_paused = next;
		_stamp = now();
		save();
		announce();
		return true;
	}

	/// Click a node: a branch that is wholly playing pauses, anything
	/// else resumes.
	function toggle(nodeId) {
		load();
		var t = tree();
		var node = (t ? findNode(t, nodeId) : null) || { id: nodeId };
		return set(nodeId, clickWould(node, _paused) === 'play');
	}

	/// Seed a leaf as paused at the moment it is created, without
	/// touching anything else. Phase H's two default Diamonds start
	/// paused this way, rather than by a branch that remembers.
	function seedPaused(nodeId) {
		if (!nodeId) return false;
		load();
		if (_paused[nodeId]) return false;
		_paused[nodeId] = true;
		_stamp = now();
		save();
		announce();
		return true;
	}

	/// Forget a leaf entirely, for an object being deleted. A stale id
	/// is harmless to `isPaused` but would keep a branch amber for
	/// ever and would travel in the parcel for the life of the
	/// account.
	function forget(prefix) {
		load();
		var hit = false;
		for (var k in _paused) {
			if (k === prefix || k.indexOf(prefix + '/') === 0) { delete _paused[k]; hit = true; }
		}
		if (hit) { _stamp = now(); save(); announce(); }
		return hit;
	}

	/// What travels in the sync parcel. Stable bytes for stable state.
	function snapshot() {
		load();
		return toRecord(_paused, _stamp);
	}

	/// Take a record from the sync, merged against what is held here.
	/// Returns true when the local state moved.
	function adopt(rec) {
		load();
		var merged = mergeRecords(toRecord(_paused, _stamp), rec);
		var before = JSON.stringify(toRecord(_paused, _stamp));
		var after  = JSON.stringify(merged);
		if (before === after) return false;
		_paused = fromRecord(merged);
		_stamp = merged.stamp || 0;
		save();
		announce();
		return true;
	}

	/// Called when a listener wants to know the tree has moved.
	function subscribe(fn) {
		if (typeof fn === 'function') _subs.push(fn);
	}

	/// Drop everything held, for an account switch: one account's
	/// pauses must never colour another's.
	function reset() { _paused = null; _stamp = 0; }

	/// Every paused leaf, for a verifier or a diagnostic.
	function pausedIds() { load(); return toRecord(_paused, _stamp).paused; }

	/// A human name for a node, for a refusal that has to be readable.
	///
	/// The tree carries a `label` on each node, but only the widget could see it,
	/// so every refusal at the spend boundary said `root/diamonds/a1b2/self` —
	/// which names the node exactly and tells the person nothing. Falls back to
	/// the last meaningful segment of the id, unescaped, so a node the tree has
	/// not heard of still reads as something rather than as a path.
	function label(nodeId) {
		if (!nodeId) return '';
		var t = tree();
		var node = t ? findNode(t, nodeId) : null;
		if (node && node.label) return node.label;
		var parts = String(nodeId).split('/');
		// `…/self` is the object's own spending, so the name wanted is its parent's.
		if (parts.length > 1 && parts[parts.length - 1] === 'self') parts.pop();
		var last = parts[parts.length - 1] || nodeId;
		return decodeURIComponent(last.replace(/%2F/g, '/'));
	}

	var api = {
		// Live API.
		id:         id,
		ROOT:       ROOT,
		setTree:    setTree,
		isPaused:   isPaused,
		state:      state,
		set:        set,
		toggle:     toggle,
		seedPaused: seedPaused,
		forget:     forget,
		snapshot:   snapshot,
		adopt:      adopt,
		subscribe:  subscribe,
		reset:      reset,
		pausedIds:  pausedIds,
		label:      label,
		// Pure core, exposed for tests and for reuse.
		_core: {
			leavesUnder:   leavesUnder,
			armedUnder:    armedUnder,
			findNode:      findNode,
			stateOf:       stateOf,
			applySet:      applySet,
			clickWould:    clickWould,
			toRecord:      toRecord,
			fromRecord:    fromRecord,
			mergeRecords:  mergeRecords,
			consts: { STORE_KEY: STORE_KEY, ROOT: ROOT },
		},
	};

	if (typeof window !== 'undefined') window.DaimondPause = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
