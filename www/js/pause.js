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
       seeded paused when it is created. The one exception is a
       triggered action's leaf, which is held until a person
       releases it on this device: see `releasedHereOnly`.

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
	var HERE_KEY  = 'daimond-pause-here';	// releases given on THIS device; never synced

	// ── Node ids ───────────────────────────────────────────────
	// Slash-delimited paths, so an ancestor is a string prefix and
	// the tree can be walked without the tree being present. The
	// shapes in use, all built by `DaimondPause.id`, but for a trigger's,
	// which `triggerLeaf` builds:
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

	/// One name as one level of a node id. A Diamond id, a mail folder or a
	/// triggered action's id is user-, server- or model-named, and one containing
	/// a slash would otherwise invent a level in the tree. `%` is escaped first so
	/// that no name can pass for another's escape. The one escaping helper: every
	/// id built from a name goes through it, by `id` or by `triggerLeaf`.
	function seg(s) {
		return String(s).replace(/%/g, '%25').replace(/\//g, '%2F');
	}

	/// Build a node id from parts, each escaped by `seg`. An empty part is
	/// dropped.
	function id() {
		var parts = [];
		for (var i = 0; i < arguments.length; i++) {
			var s = arguments[i];
			if (s == null || s === '') continue;
			parts.push(seg(s));
		}
		return parts.join('/');
	}

	// ── A leaf only this device can release ────────────────────
	//
	// A triggered action spends with nobody present, so for its leaf being out of
	// the paused set is not enough to let it run. On 2026-09-24 a daimon wrote its
	// own `triggers.json`; the new action's leaf had never been seeded, a leaf that
	// appears later PLAYS, and the next mail to arrive started a turn nobody sent.
	// The `+` button seeded its leaf held. A file write, a synced copy and an
	// import did not, and could not be made to.
	//
	// So for this one kind of leaf the default is reversed. It is held until a
	// person on THIS device releases it -- play on its light, its Diamond's or the
	// global one -- and the release is kept here and never travels in the parcel:
	// a release on the phone does not arm the desktop, as a folder marked on one
	// device is not in force on another. The release is bound to the action's
	// TERMS, the text of what it does, which the tree node carries. An action
	// changed anywhere but the app's own editor is therefore held again, and a
	// daimon cannot keep a released leaf while rewriting its instruction.
	//
	// Pausing is untouched and still travels: a hold from any device holds here,
	// and ends the release given here (`settle`), so resuming it is a new decision
	// made on this device.
	//
	// THE SHAPE AND THE TEST THAT KNOWS IT LIVE HERE TOGETHER. Until the delta
	// re-check of 2026-09-24 (D1) the leaf was joined in triggers.js with the id
	// raw, and this test knew a one-segment id only. A daimon that wrote
	// `"id": "m/arm"` made a leaf the test did not recognise, the leaf fell back
	// to the paused set, where it was not, and the next mail fired it with nobody
	// pressing play. Now `triggerLeaf` escapes each name, so every leaf is exactly
	// one level, and the test takes ANYTHING under a Diamond's `triggers/` as
	// waiting for a release: a leaf built some other way still holds rather than
	// arms. An id with neither `%` nor `/` in it -- every id the app writes --
	// names the same leaf it always did, so existing holds and releases carry over.
	var HERE_LEAF = /^root\/diamonds\/[^/]*\/triggers\//;

	/// The leaf of one triggered action. Every level is kept, even an empty one,
	/// where `id` would fold it into the branch above.
	function triggerLeaf(diamondId, actionId) {
		return ROOT + '/diamonds/' + seg(diamondId) + '/triggers/' + seg(actionId);
	}

	/// Does this leaf wait for a release on this device?
	function releasedHereOnly(nodeId) {
		return HERE_LEAF.test(String(nodeId || ''));
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

	/// Every leaf NODE at or under `node`, for the fields a leaf carries.
	function leafNodesUnder(node) {
		if (!node) return [];
		if (!node.children) return [node];
		var out = [];
		for (var i = 0; i < node.children.length; i++) {
			out = out.concat(leafNodesUnder(node.children[i]));
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
	var _here   = null;		// leaf -> the terms it was released on, here
	var _tree   = null;		// a function returning the live tree
	var _subs   = [];
	var _pressed = {};		// leaves a person pressed on in this tab since it loaded

	function now() {
		return (typeof Date !== 'undefined') ? Date.now() : 0;
	}

	function load() {
		if (_paused) return;
		_paused = {};			// storage blocked or corrupt: everything plays
		_stamp = 0;
		_here = {};
		fresh();
	}

	/// Read both records again, over what this tab holds.
	///
	/// Every tab of this account on this device shares the store, and until the
	/// delta re-check of 2026-09-24 (D2) each read it once, at load. "Pause all"
	/// in one tab left a second one playing -- its triggers fired and its turns
	/// reached the provider -- and the second tab's next save wrote back a set it
	/// had never loaded. So another tab's write re-reads here (`onStorage`), and
	/// every change re-reads before it writes (`current`).
	///
	/// The paused set is merged by stamp, as the sync merges one: the later wins
	/// whole, so the other tab's play arrives as well as its pause, and a change
	/// this tab made but could not store is not thrown away for an older set. The
	/// releases carry no stamp and are read whole, so one this tab could not store
	/// is lost to the next read, which errs held.
	function fresh() {
		try {
			var raw = localStorage.getItem(STORE_KEY);
			var merged = mergeRecords(toRecord(_paused, _stamp), raw ? JSON.parse(raw) : null);
			_paused = fromRecord(merged);
			_stamp = merged.stamp || 0;
		} catch (e) { /* storage blocked or corrupt: what this tab holds stands */ }
		var got = {};
		try {
			var here = JSON.parse(localStorage.getItem(HERE_KEY) || '{}') || {};
			for (var k in here) {
				if (releasedHereOnly(k) && typeof here[k] === 'string' && here[k]) got[k] = here[k];
			}
		} catch (e) { /* storage blocked or corrupt: every triggered action is held */ }
		_here = got;
		if (settle()) saveHere();
	}

	/// Before a change: what the store holds now, so this tab writes its change
	/// onto another tab's rather than over it.
	function current() {
		if (_paused) fresh(); else load();
	}

	/// Move the stamp for a change made here. Always forward, even past a stamp
	/// adopted from a device whose clock runs ahead: a change made after it has to
	/// read as later to every tab's re-read, and to the sync.
	function bump() {
		_stamp = Math.max(now(), _stamp + 1);
	}

	/// Move the stamp for a change NOBODY PRESSED: a seed, a repair, a leaf tidied
	/// away with its object. One past the record held here, never the clock.
	///
	/// The record merges whole and the later stamp wins, so a write stamped `now`
	/// claims to be later than every record this device has not yet pulled. Until
	/// the FU QA of 2026-09-24 (FA) the Optimiser's repair was stamped that way at
	/// boot, before the first pull: it out-dated a Pause all pressed on another
	/// device, won the merge, and its next push undid the Pause all everywhere.
	/// One past what is held orders the write after everything this device has
	/// seen and below any press made elsewhere since, which carries its clock and
	/// wins. Where one does, the app's own write is what is lost, and a leaf the
	/// app meant to play stays held -- the safe way to be wrong.
	function follow() {
		_stamp = _stamp + 1;
	}

	function save() {
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify(toRecord(_paused, _stamp)));
		} catch (e) { /* quota */ }
	}

	function saveHere() {
		try { localStorage.setItem(HERE_KEY, JSON.stringify(_here)); }
		catch (e) { /* quota: the release lasts this session, and errs held after */ }
	}

	/// A hold, from this device or another, ends the release given here. Returns
	/// true when one was ended.
	function settle() {
		var hit = false;
		for (var k in _here) {
			if (_paused[k]) { delete _here[k]; hit = true; }
		}
		return hit;
	}

	/// The held set as a light must read it under `node`: every paused leaf, and
	/// every leaf there that waits on a release here, judged on the terms its tree
	/// node carries -- the same terms the trigger is judged on when it fires.
	function heldUnder(node) {
		var out = {};
		for (var k in _paused) if (_paused[k]) out[k] = true;
		var leaves = leafNodesUnder(node);
		for (var i = 0; i < leaves.length; i++) {
			if (isPaused(leaves[i].id, leaves[i].terms)) out[leaves[i].id] = true;
		}
		return out;
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
	///
	/// A triggered action's leaf is also held until it is released on this
	/// device (see `releasedHereOnly`). `terms` is what the action does now;
	/// given, a release made on any other terms does not count.
	function isPaused(nodeId, terms) {
		if (!nodeId) return false;
		load();
		if (_paused[nodeId]) return true;
		if (!releasedHereOnly(nodeId)) return false;
		var got = _here[nodeId];
		if (!got) return true;
		return terms !== undefined && got !== terms;
	}

	/// The state of any node, leaf or branch: 'play', 'pause' or
	/// 'mixed'. Needs the tree, so an unknown id answers from its own
	/// flag alone rather than pretending.
	function state(nodeId) {
		load();
		var t = tree();
		var node = t ? findNode(t, nodeId) : null;
		if (!node) return isPaused(nodeId) ? 'pause' : 'play';
		return stateOf(node, heldUnder(node));
	}

	/// Has a PERSON held everything under this node? The paused set alone.
	///
	/// Not `state(nodeId) === 'pause'`, which since the per-device release also
	/// counts a triggered action that only waits for a release here. That is
	/// right for the light -- it will not run by itself -- and wrong for a spend
	/// that falls back on the global control: a daimon's file write would then
	/// read as the person holding everything, and refuse their page fetches.
	///
	/// Also not `stateOf(node, _paused)`, which walks ARMED leaves only. A
	/// fresh account seeds one armed, held leaf (the Optimiser's own trigger)
	/// alongside unarmed ones nobody has touched, and `stateOf` called that
	/// "everything held" -- refusing the person's first search on a `root/web`
	/// leaf nobody had paused. "Pause all" writes every leaf via `applySet`,
	/// armed or not, so that is what held-by-hand has to check.
	function heldByHand(nodeId) {
		load();
		var t = tree();
		var node = t ? findNode(t, nodeId) : null;
		if (!node) return !!_paused[nodeId];
		var leaves = leavesUnder(node);
		if (!leaves.length) return false;
		for (var i = 0; i < leaves.length; i++) if (!_paused[leaves[i]]) return false;
		return true;
	}

	/// Set a node playing or paused, writing every leaf under it.
	/// Returns true when something actually changed — the stamp moves
	/// only then, which is what keeps the sync parcel a fixed point.
	///
	/// This is the one door a release on this device comes through, and every
	/// caller of it is a person pressing play or pause. Playing a node releases
	/// each triggered action under it on the terms its tree node carries; a leaf
	/// the tree does not know, or one with no terms, is not released, because
	/// nothing can be released that the app cannot show. Pausing ends the release.
	function set(nodeId, playing) {
		current();
		var t = tree();
		var node = (t ? findNode(t, nodeId) : null) || { id: nodeId };
		var next = applySet(node, _paused, playing);
		var before = JSON.stringify(toRecord(_paused, 0));
		var after  = JSON.stringify(toRecord(next, 0));
		var moved  = before !== after;
		var here   = false;
		var leaves = leafNodesUnder(node);
		for (var i = 0; i < leaves.length; i++) {
			var l = leaves[i];
			_pressed[l.id] = true;
			if (!releasedHereOnly(l.id)) continue;
			if (playing) {
				var terms = (typeof l.terms === 'string') ? l.terms : '';
				if (terms && _here[l.id] !== terms) { _here[l.id] = terms; here = true; }
			} else if (_here[l.id]) {
				delete _here[l.id];
				here = true;
			}
		}
		if (!moved && !here) return false;
		if (moved) {
			_paused = next;
			bump();
			save();
		}
		if (here) saveHere();
		announce();
		return true;
	}

	/// Click a node: a branch that is wholly playing pauses, anything
	/// else resumes.
	function toggle(nodeId) {
		current();
		var t = tree();
		var node = (t ? findNode(t, nodeId) : null) || { id: nodeId };
		return set(nodeId, clickWould(node, heldUnder(node)) === 'play');
	}

	/// Seed a leaf as paused at the moment it is created, without
	/// touching anything else. Phase H's two default Diamonds start
	/// paused this way, rather than by a branch that remembers.
	///
	/// Not a person's press, so stamped by `follow`: a device new to the account
	/// seeds before its first pull, and must not out-date the account's own record.
	function seedPaused(nodeId) {
		if (!nodeId) return false;
		current();
		if (_paused[nodeId]) return false;
		_paused[nodeId] = true;
		follow();
		save();
		if (settle()) saveHere();
		announce();
		return true;
	}

	/// Has a person pressed play or pause on this leaf, or on a branch over it, in this
	/// tab since it loaded? A repair that waits for the first pull must not take back a
	/// hold that was pressed while it waited.
	function pressedHere(nodeId) {
		return !!(nodeId && _pressed[nodeId]);
	}

	/// Take back a leaf the app itself held, for a repair of an earlier seed. The
	/// mirror of `seedPaused`, and like it stamped by `follow`, never as a press.
	/// Releases nothing on this device.
	function unseed(nodeId) {
		if (!nodeId) return false;
		current();
		if (!_paused[nodeId]) return false;
		delete _paused[nodeId];
		follow();
		save();
		announce();
		return true;
	}

	/// The terms this leaf was released on here, or '' where it was not.
	function releasedHere(nodeId) {
		load();
		return (nodeId && _here[nodeId]) || '';
	}

	/// Drop the releases given here to a Diamond's actions for leaves no longer in
	/// `live`. An action gone from its file takes its release with it, so the same
	/// action written back later -- by a daimon, a sync or a hand -- arrives held.
	function pruneHere(diamondId, live) {
		current();
		var under = triggerLeaf(diamondId, '');
		var keep = {};
		for (var i = 0; i < (live || []).length; i++) keep[live[i]] = true;
		var gone = false;
		for (var k in _here) {
			if (k.indexOf(under) === 0 && !keep[k]) { delete _here[k]; gone = true; }
		}
		if (gone) saveHere();
		return gone;
	}

	/// Carry a release given here across an edit made in the app's own editor:
	/// only a release that was good for the action as it read before (`from`) is
	/// moved to what it reads now (`to`), so this cannot arm anything that was not
	/// already running on this device. Returns true when it moved one.
	function carry(nodeId, from, to) {
		current();
		if (!releasedHereOnly(nodeId) || !from || !to || _here[nodeId] !== from) return false;
		if (from === to) return false;
		_here[nodeId] = to;
		saveHere();
		return true;
	}

	/// Forget a leaf entirely, for an object being deleted. A stale id
	/// is harmless to `isPaused` but would keep a branch amber for
	/// ever and would travel in the parcel for the life of the
	/// account.
	///
	/// Tidying, not a press -- the retention sweep calls it with nobody present --
	/// so it is stamped by `follow`. Where a newer record wins, the stale id rides
	/// on in it until that device forgets the object too.
	function forget(prefix) {
		current();
		var hit = false;
		for (var k in _paused) {
			if (k === prefix || k.indexOf(prefix + '/') === 0) { delete _paused[k]; hit = true; }
		}
		var gone = false;
		for (var h in _here) {
			if (h === prefix || h.indexOf(prefix + '/') === 0) { delete _here[h]; gone = true; }
		}
		if (gone) saveHere();
		if (hit) { follow(); save(); announce(); }
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
		current();
		var merged = mergeRecords(toRecord(_paused, _stamp), rec);
		var before = JSON.stringify(toRecord(_paused, _stamp));
		var after  = JSON.stringify(merged);
		if (before === after) return false;
		_paused = fromRecord(merged);
		_stamp = merged.stamp || 0;
		save();
		// A hold that arrived ends the release given here. A leaf that arrives
		// UNPAUSED gains nothing: what another device released is not released here.
		if (settle()) saveHere();
		announce();
		return true;
	}

	/// Called when a listener wants to know the tree has moved.
	function subscribe(fn) {
		if (typeof fn === 'function') _subs.push(fn);
	}

	/// Is this `storage` event about one of this account's two records? The key
	/// comes as stored, so a second account's carries its accounts.js prefix, and
	/// another account's is not ours. A null key is the whole store cleared.
	function ours(key) {
		if (key === null) return true;
		var pre = '';
		try { if (window.DaimondAccounts) pre = window.DaimondAccounts.prefix() || ''; }
		catch (e) { /* no accounts module: the raw keys */ }
		return key === pre + STORE_KEY || key === pre + HERE_KEY;
	}

	/// Another tab of this account moved a record: read both again, and tell the
	/// lights, the pump and the mail poll if anything here moved. The browser
	/// raises this in every tab but the writer, so a tab never answers itself.
	function onStorage(e) {
		if (!_paused || !e || !ours(e.key)) return;	// not read yet: the first read is fresh
		var was = JSON.stringify([toRecord(_paused, _stamp), _here]);
		fresh();
		if (JSON.stringify([toRecord(_paused, _stamp), _here]) !== was) announce();
	}

	if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		window.addEventListener('storage', onStorage);
	}

	/// Drop everything held, for an account switch: one account's
	/// pauses must never colour another's.
	function reset() { _paused = null; _stamp = 0; _here = null; _pressed = {}; }

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
		triggerLeaf: triggerLeaf,
		ROOT:       ROOT,
		setTree:    setTree,
		isPaused:   isPaused,
		state:      state,
		heldByHand: heldByHand,
		set:        set,
		toggle:     toggle,
		seedPaused: seedPaused,
		unseed:     unseed,
		pressedHere: pressedHere,
		releasedHere: releasedHere,
		carry:      carry,
		pruneHere:  pruneHere,
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
			leafNodesUnder: leafNodesUnder,
			releasedHereOnly: releasedHereOnly,
			armedUnder:    armedUnder,
			findNode:      findNode,
			stateOf:       stateOf,
			applySet:      applySet,
			clickWould:    clickWould,
			toRecord:      toRecord,
			fromRecord:    fromRecord,
			mergeRecords:  mergeRecords,
			consts: { STORE_KEY: STORE_KEY, HERE_KEY: HERE_KEY, ROOT: ROOT },
		},
	};

	if (typeof window !== 'undefined') window.DaimondPause = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
