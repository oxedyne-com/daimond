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
   the root of the same tree. A press is kept where it was made:
   one entry at the node pressed, held or played, when, and by
   whom, and a leaf is held when the latest entry on its path says
   so. Everything a branch SHOWS is still computed from its leaves,
   so amber is still never set.

   Two consequences worth stating, because both are deliberate:

     - A leaf that appears later under a branch a person held is
       HELD. Pause everything, make a new chat, and it arrives
       paused: "everything" includes what the pressing device had
       not yet seen. Until the R3 QA of 2026-09-24 only leaves held
       state, so a new leaf played and "Pause all" meant "every leaf
       this device knew of then" -- which a second device's later
       press on one chat could undo whole (M-merge; see the record,
       below). A triggered action's leaf is also held until a person
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
	// branch with a `self` leaf, so what its light shows is always
	// its leaves' and never needs an exception.

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
	// person on THIS device releases it -- play on ITS OWN light -- and the release
	// is kept here and never travels in the parcel: a release on the phone does not
	// arm the desktop, as a folder marked on one device is not in force on another.
	// The release is bound to the action's TERMS, the text of what it does, which
	// the tree node carries. An action changed anywhere but the app's own editor is
	// therefore held again, and a daimon cannot keep a released leaf while
	// rewriting its instruction.
	//
	// Pausing is untouched and still travels: a hold from any device holds here.
	// A hold on the action's own light, pressed on any device, also ends the
	// release given here (`settle`), so resuming it is a new decision made on this
	// device. A hold on a branch above it -- its Diamond's light, the Diamonds
	// section's, Pause all -- only SUSPENDS the release, and a play there ends the
	// hold and releases nothing.
	//
	// UNTIL THE REOPEN REHEARSAL OF 2026-09-25 A PLAY ON ANY BRANCH RELEASED EVERY
	// ACTION UNDER IT, and every hold ended the releases under it. So Pause all
	// then its resume released every action on the device, including ones the
	// person had never pressed: a reopen's "press play on the ones wanted" was
	// undone by the first Pause all. A resume now ends the pause and puts back
	// exactly the releases that stood before it.
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

	// ── The record: one entry per id, merged id by id ──────────
	//
	// Each id a press or the app wrote carries `[p, t, o]`: `p` 1 held or 0
	// played, `t` its stamp, `o` its origin `"<kind>:<device>"`, where kind `h` is
	// a person's press and `a` a write the app made -- a seed, a repair, a tidy, a
	// conversion from an old record. A tombstone carries a fourth element, the
	// wall-clock time it was written, so that it can be pruned.
	//
	// UNTIL THE R3 QA OF 2026-09-24 THE RECORD WAS ONE SET AND ONE STAMP, and the
	// later stamp won whole. A press on one leaf spoke for every leaf in the
	// pressing device's set, stale or not: A pressed Pause all, B -- which had not
	// pulled it -- paused one chat five seconds later, and B's set won on both
	// devices, so nearly everything played again (M-merge). The runner of a
	// hand-off adopted an errand's snapshot the same way, and lost its own Pause
	// all to any sender who had pressed anything since. And an app write stamped
	// one past the record could climb over a person's press: two of them from a
	// device whose clock ran behind (the skew case), the repair in one tab over a
	// press in another (X2), the repair on a new device over a pause made on the
	// first (FC, Q6-1). Now:
	//
	//   merge    id by id: the higher `t` wins; at an equal `t`, held beats
	//            played, a person's entry beats the app's, and then the smaller
	//            origin, so that two collects stay byte-identical. Commutative,
	//            associative and idempotent.
	//   resolve  of the entries at an id and at every `/`-prefix of it, the one
	//            with the highest `t` decides, ties held. None anywhere plays. No
	//            tree is needed, so an id this device has never seen resolves.
	//   press    ONE entry, at the node pressed, stamped past every entry on its
	//            path and under it, so it decides for everything under it.
	//   app      may HOLD anything that plays, and may PLAY only what the app
	//            itself held: never an id whose own entry is a person's, and
	//            never under a person's hold on the path above it. Its plays are
	//            stamped one past the id's own entry and never by the clock, so a
	//            press made anywhere since still wins. A person's hold can be
	//            ended only by a person.

	var LEGACY  = 'a:legacy';				// the origin of an id an old record held
	var TOMB_MS = 30 * 24 * 3600 * 1000;	// how long a tombstone travels

	// The branch shapes `id` builds (see "Node ids"). An old build keeps only leaf
	// ids, so none of these may ever be handed to one; see `heldLeaves`.
	var BRANCH_ID = /^root(\/(diamonds|chats|mail))?$|^root\/(diamonds|mail)\/[^/]+$/;

	function own(map, k) {
		return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
	}

	function goodId(k) {
		return typeof k === 'string' && k !== '' && k !== '__proto__';
	}

	/// Is this a well-formed entry? Anything else in a record is dropped.
	function isEntry(e) {
		return Array.isArray(e) && (e.length === 3 || e.length === 4)
			&& (e[0] === 0 || e[0] === 1)
			&& typeof e[1] === 'number' && isFinite(e[1]) && e[1] >= 0
			&& typeof e[2] === 'string' && e[2] !== ''
			&& (e.length === 3 || (typeof e[3] === 'number' && isFinite(e[3])));
	}

	/// Did a person press this entry?
	function byPerson(e) { return !!e && e[2].charAt(0) === 'h'; }

	/// Does entry `x` win over entry `y` for one id? A strict total order, so a
	/// merge is the same whichever side it starts from.
	///
	/// A person's entry beats the app's at an equal stamp and state, or a seed that
	/// happened to land on a press's millisecond could stand in for it and then be
	/// taken back by a repair, as the app's.
	function beats(x, y) {
		if (!y) return !!x;
		if (!x) return false;
		if (x[1] !== y[1]) return x[1] > y[1];
		if (x[0] !== y[0]) return x[0] > y[0];		// an equal stamp goes to held
		var hx = byPerson(x), hy = byPerson(y);
		if (hx !== hy) return hx;					// then to a person
		if (x[2] !== y[2]) return x[2] < y[2];		// then the smaller origin
		if (x.length !== y.length) return x.length > y.length;	// then a tombstone
		return (x[3] || 0) > (y[3] || 0);			// then one writer's later tombstone
	}

	/// A copy of an entry map, keeping only well-formed entries.
	function copyEntries(map) {
		var out = Object.create(null);
		if (!map || typeof map !== 'object') return out;
		for (var k in map) {
			var e = own(map, k);
			if (goodId(k) && isEntry(e)) out[k] = e.slice();
		}
		return out;
	}

	/// The ids from the root down to `id`, `id` last.
	function pathOf(id) {
		var parts = String(id).split('/'), out = [], k = '';
		for (var i = 0; i < parts.length; i++) {
			k = i ? k + '/' + parts[i] : parts[i];
			out.push(k);
		}
		return out;
	}

	function isUnder(k, prefix) {
		return k === prefix || k.indexOf(prefix + '/') === 0;
	}

	/// Of the entries at the first `n` ids of `path`, the latest, ties held; or
	/// null. `person` keeps a person's entries only.
	function latest(map, path, n, person) {
		var best = null;
		for (var i = 0; i < n; i++) {
			var e = own(map, path[i]);
			if (!e || (person && !byPerson(e))) continue;
			if (!best || e[1] > best[1] || (e[1] === best[1] && e[0] > best[0])) best = e;
		}
		return best;
	}

	/// The entry that decides `id`: the latest at it or on its path, ties held.
	function decider(map, id) {
		var path = pathOf(id);
		return latest(map, path, path.length, false);
	}

	/// Is `id` held by the record?
	function resolve(map, id) {
		var d = decider(map, id);
		return !!d && d[0] === 1;
	}

	/// Is a person's latest word on the path ABOVE `id` a hold? What the app may
	/// never play under, whatever the stamps: a Pause all, a Diamond's light or a
	/// branch's, pressed on any device and in any tab.
	function heldAbove(map, id) {
		var path = pathOf(id);
		var e = latest(map, path, path.length - 1, true);
		return !!e && e[0] === 1;
	}

	/// Is `id`'s own entry a hold? Whether or not a later press on a branch above
	/// now decides it, so the answer does not hang on which states a device saw.
	function heldAt(map, id) {
		var e = own(map, id);
		return !!e && e[0] === 1;
	}

	function mergeEntries(a, b) {
		var out = copyEntries(a), other = copyEntries(b);
		for (var k in other) if (beats(other[k], own(out, k))) out[k] = other[k];
		return out;
	}

	/// Would pressing `node` to `p` change nothing? True where a person's word
	/// already decides `node` to `p` -- or nothing was ever written and the press
	/// is play -- and no entry under it that says otherwise is late enough to
	/// decide anything. Where it cannot tell cheaply it says no, and the press is
	/// written.
	///
	/// A hold the APP made is not settled by a person's pause. The press is what
	/// makes the hold theirs, so that a repair cannot take it back: pressing pause
	/// on the Optimiser the seed held was the whole of FC, and it read as nothing
	/// to write.
	function settled(map, node, p) {
		var d = decider(map, node);
		if (d ? (d[0] !== p || !byPerson(d)) : p !== 0) return false;
		var dt = d ? d[1] : -1;
		var pre = node + '/';
		for (var k in map) {
			var e = map[k];
			if (k.indexOf(pre) !== 0 || e[0] === p) continue;
			if (e[1] > dt || (e[1] === dt && e[0] === 1)) return false;
		}
		return true;
	}

	/// A person's press: one entry at `node`, stamped past every entry on its path
	/// and under it, with the entries under it dropped, since they lose to it now.
	/// `when` is the clock, so a press made later anywhere reads as later.
	function press(map, node, p, when, dev) {
		var on = Object.create(null), path = pathOf(node), top = 0;
		for (var i = 0; i < path.length; i++) on[path[i]] = true;
		var out = Object.create(null);
		for (var k in map) {
			if (on[k] || isUnder(k, node)) top = Math.max(top, map[k][1]);
			if (!isUnder(k, node)) out[k] = map[k].slice();
		}
		out[node] = [p, Math.max(when || 0, top + 1), 'h:' + (dev || '')];
		return out;
	}

	/// Seed `id` held, for an object created held: past every entry on its path,
	/// so it holds even under an older play -- a Play all pressed before the
	/// object existed was not about it. Null where it is held already, which
	/// includes a leaf created under a person's Pause all. Holding is the safe
	/// direction, so a seed needs no leave; see `unseedEntry` for the other one.
	function seedEntry(map, id, dev) {
		if (resolve(map, id)) return null;
		var path = pathOf(id), top = 0;
		for (var i = 0; i < path.length; i++) {
			var e = own(map, path[i]);
			if (e) top = Math.max(top, e[1]);
		}
		var out = copyEntries(map);
		out[id] = [1, top + 1, 'a:' + (dev || '')];
		return out;
	}

	/// Take back a hold the app made at `id`: one past its stamp, as the app. Null
	/// unless `id`'s own entry is the app's hold, and null under a person's hold on
	/// the path above: a hold a person pressed, in any tab or on any device, on the
	/// leaf or on a branch over it, is theirs to end.
	function unseedEntry(map, id, dev) {
		var mine = own(map, id);
		if (!mine || mine[0] !== 1 || byPerson(mine) || heldAbove(map, id)) return null;
		var out = copyEntries(map);
		out[id] = [0, mine[1] + 1, 'a:' + (dev || '')];
		return out;
	}

	/// Forget everything at and under `prefix`, for an object being deleted.
	///
	/// Dropping an entry here only drops it here: the next merge brings it back
	/// from any device that still has it. So where the app wrote all of it, one
	/// tombstone at `prefix` replaces it, plays, outranks every entry it replaces,
	/// and travels. Where a person wrote any of it, or holds the path above it,
	/// the tombstone would be the app playing what a person held, so only the
	/// app's entries are dropped, here, which is harmless: a stale id rides on
	/// until every device forgets the object. Null where there is nothing to
	/// forget.
	function forgetEntries(map, prefix, dev, when) {
		var keys = [], hand = false, top = 0;
		for (var k in map) {
			if (!isUnder(k, prefix)) continue;
			keys.push(k);
			if (byPerson(map[k])) hand = true;
			top = Math.max(top, map[k][1]);
		}
		if (!keys.length) return null;
		var only = own(map, prefix);
		if (keys.length === 1 && only && only[0] === 0 && only.length === 4) return null;	// a tombstone already
		var tomb = !hand && !heldAbove(map, prefix);
		var out = copyEntries(map), gone = false;
		for (var i = 0; i < keys.length; i++) {
			if (byPerson(map[keys[i]])) continue;
			delete out[keys[i]];
			gone = true;
		}
		if (tomb) out[prefix] = [0, top + 1, 'a:' + (dev || ''), when || 0];
		return (tomb || gone) ? out : null;
	}

	/// The latest time the record knows of: every stamp, and every tombstone's
	/// time. The same on every device holding the same record, so a prune that
	/// reads it is too.
	function newest(map) {
		var n = 0;
		for (var k in map) {
			var e = map[k];
			n = Math.max(n, e[1], e.length === 4 ? e[3] : 0);
		}
		return n;
	}

	/// Drop the tombstones more than `TOMB_MS` older than the newest time in the
	/// record. Null where there are none.
	///
	/// Measured against the record and not this device's clock, so two devices
	/// holding the same record prune the same entries: a prune by each device's own
	/// clock would drop a tombstone on one, bring it back from the other at the
	/// next merge, and drop it again, and the parcel would never settle. A device
	/// offline for longer brings a deleted object's id back, which nothing asks
	/// about any more.
	function prune(map) {
		var out = null, cut = newest(map) - TOMB_MS;
		for (var k in map) {
			var e = map[k];
			if (e.length !== 4 || e[0] !== 0 || e[3] >= cut) continue;
			if (!out) out = copyEntries(map);
			delete out[k];
		}
		return out;
	}

	/// The held LEAVES, sorted: every leaf `tree` knows and every id with an entry
	/// that the record holds on its path. What `pausedIds` answers, and what a
	/// build before v2 reads as `paused`, a set of leaf ids. No branch id is ever
	/// in it -- one the tree has, one of the shapes `id` builds (`BRANCH_ID`), or a
	/// prefix of another id -- whether or not the tree is up: an old build never
	/// takes one out of its set, because none of its presses writes one, so a
	/// `root` it echoed back after a Play all here would hold everything again.
	function heldLeaves(map, tree) {
		var ids = Object.create(null), branch = Object.create(null), kids = Object.create(null);
		(function walk(n) {
			if (!n) return;
			if (!n.children) { if (goodId(n.id)) ids[n.id] = true; return; }
			branch[n.id] = true;
			for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
		})(tree);
		for (var k in map) ids[k] = true;
		for (var id in ids) {
			var path = pathOf(id);
			for (var j = 0; j < path.length - 1; j++) kids[path[j]] = true;
		}
		var out = [];
		for (var x in ids) {
			if (branch[x] || kids[x] || BRANCH_ID.test(x) || !resolve(map, x)) continue;
			out.push(x);
		}
		out.sort();
		return out;
	}

	// ── The wire: v2 beside the fields an older build reads ────
	//
	// `{ v: 2, leaves, paused, stamp }`, stored under the same key and carried in
	// the parcel and in an errand. `leaves` is the record, sorted by id so that
	// stable state gives stable bytes -- the sync parcel has to be a fixed point,
	// or two devices push at each other for ever (`dev/verify_parcelstable.mjs`).
	// `paused` and `stamp` are for a build before v2, which merges them whole as
	// it always did: `paused` is the held leaves (`heldLeaves`), and `stamp` moves
	// with every change made here, as the old one did, and is never below an
	// entry's `t`. Drop both from the wire once no pre-v2 device has pushed for
	// thirty days.

	function toRecord(map, stamp, tree) {
		var keys = Object.keys(map).sort(), leaves = {}, top = stamp || 0;
		for (var i = 0; i < keys.length; i++) {
			leaves[keys[i]] = map[keys[i]].slice();
			top = Math.max(top, map[keys[i]][1]);
		}
		return { v: 2, leaves: leaves, paused: heldLeaves(map, tree), stamp: top };
	}

	function isV2(rec) {
		return !!rec && rec.v === 2 && !!rec.leaves && typeof rec.leaves === 'object';
	}

	function stampOf(rec) {
		var s = rec && rec.stamp;
		return (typeof s === 'number' && isFinite(s) && s > 0) ? s : 0;
	}

	/// Read a record from a build before v2 -- `{ paused, stamp }` -- onto `map`.
	///
	/// Its ids arrive held at its stamp, as the app's (`a:legacy`): the old record
	/// cannot say whether a person or a seed held them. One is written only where
	/// it decides -- where nothing on the id's path is later than that stamp -- so
	/// an old device's older view adds nothing. An id held here by the app's own
	/// entry and absent from it arrives played at its stamp, where that entry is
	/// older, so an old device can still play what the app held.
	///
	/// Nothing in it ends a person's hold: not one on the id, and not one on a
	/// branch over it, since the old record cannot say whether its sender played
	/// the id or never heard of the hold. An old device's play of a leaf a person
	/// held on a v2 device does not arrive, and the leaf errs held.
	function adoptLegacy(map, rec) {
		var S = stampOf(rec), list = (rec && Array.isArray(rec.paused)) ? rec.paused : [];
		var out = copyEntries(map), named = Object.create(null);
		for (var i = 0; i < list.length; i++) {
			var id = list[i];
			if (!goodId(id)) continue;
			named[id] = true;
			if (resolve(map, id)) continue;
			var d = decider(map, id);
			if (d && d[1] > S) continue;				// played later than that old view
			var e = [1, S, LEGACY];
			if (beats(e, own(out, id))) out[id] = e;
		}
		for (var k in map) {
			var mine = map[k];
			if (named[k] || mine[0] !== 1 || byPerson(mine) || mine[1] >= S) continue;
			if (resolve(map, k) && !heldAbove(map, k)) out[k] = [0, S, LEGACY];
		}
		return out;
	}

	// ── Stateful shell ─────────────────────────────────────────
	// Storage, the clock, the live tree and the subscribers. None of
	// this runs under Node; the export at the foot hands out the pure
	// core only.

	var _leaves = null;		// id -> entry, lazily loaded
	var _stamp  = 0;		// the stamp a build before v2 reads
	var _here   = null;		// leaf -> the terms it was released on, here
	var _tree   = null;		// a function returning the live tree
	var _subs   = [];

	function now() {
		return (typeof Date !== 'undefined') ? Date.now() : 0;
	}

	/// This device, for the origin of what it writes. Asked at each write, because
	/// identity.js loads after this file.
	function device() {
		try {
			return (typeof window !== 'undefined' && window.DaimondIdentity
				&& window.DaimondIdentity.deviceId()) || '';
		} catch (e) { return ''; }
	}

	function load() {
		if (_leaves) return;
		_leaves = Object.create(null);	// storage blocked or corrupt: everything plays
		_stamp = 0;
		_here = {};
		fresh();
	}

	/// Merge a record from the store, the sync or an errand onto what this tab holds.
	function take(rec) {
		if (!rec || typeof rec !== 'object') return;
		if (isV2(rec)) _leaves = mergeEntries(_leaves, rec.leaves);
		else if (Array.isArray(rec.paused)) _leaves = adoptLegacy(_leaves, rec);
		else return;
		_stamp = Math.max(_stamp, stampOf(rec));
	}

	/// What this tab holds, as bytes that move only when it does.
	function stateKey() {
		var keys = Object.keys(_leaves).sort(), out = [];
		for (var i = 0; i < keys.length; i++) out.push([keys[i], _leaves[keys[i]]]);
		return JSON.stringify([out, _stamp]);
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
	/// The record is merged id by id, as the sync merges one, so the other tab's
	/// play arrives as well as its pause, and a change this tab made but could not
	/// store is kept. A store an older build wrote is read as its record would be.
	/// The releases carry no stamp and are read whole, so one this tab could not
	/// store is lost to the next read, which errs held.
	///
	/// Both are read through `DaimondStore`, so a record this tab could not store is
	/// held owed and read back here rather than lost to the next read (SIM-11).
	function fresh() {
		take(window.DaimondStore.get(STORE_KEY, null));
		var got = {}, here = window.DaimondStore.get(HERE_KEY, {});
		if (here && typeof here === 'object') {
			for (var k in here) {
				if (releasedHereOnly(k) && typeof here[k] === 'string' && here[k]) got[k] = here[k];
			}
		}
		_here = got;
		if (settle()) saveHere();
	}

	/// Before a change: what the store holds now, so this tab writes its change
	/// onto another tab's rather than over it.
	function current() {
		if (_leaves) fresh(); else load();
	}

	function record() {
		return toRecord(_leaves, _stamp, tree());
	}

	/// Store the record. True when it landed; a record the box refuses is held owed
	/// by `DaimondStore`, retried under `law` and said on screen, never dropped.
	function save() {
		return window.DaimondStore.put(STORE_KEY, record(), law);
	}

	/// Two stored records as one, id by id, as the sync merges them.
	function law(a, b) {
		var map = Object.create(null), stamp = 0;
		[a, b].forEach(function (rec) {
			if (!rec || typeof rec !== 'object') return;
			if (isV2(rec)) map = mergeEntries(map, rec.leaves);
			else if (Array.isArray(rec.paused)) map = adoptLegacy(map, rec);
			else return;
			stamp = Math.max(stamp, stampOf(rec));
		});
		return toRecord(map, stamp, tree());
	}

	function saveHere() {
		return window.DaimondStore.put(HERE_KEY, _here);
	}

	/// A hold on the action's own light, from this device or another, ends the
	/// release given here; a hold on a branch above it does not (see "A leaf only
	/// this device can release"). Returns true when one was ended.
	function settle() {
		var hit = false;
		for (var k in _here) {
			if (heldAt(_leaves, k)) { delete _here[k]; hit = true; }
		}
		return hit;
	}

	/// The held set as a light must read it under `node`: every leaf there that
	/// the record holds or that waits on a release here, judged on the terms its
	/// tree node carries -- the same terms the trigger is judged on when it fires.
	function heldUnder(node) {
		var out = {};
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

	/// Is this leaf paused? The record answers from the id and its path alone, so
	/// no tree is walked and an id the tree does not know still answers.
	/// Enforcement calls this, and it must stay cheap enough to sit in front of
	/// every spend.
	///
	/// A triggered action's leaf is also held until it is released on this
	/// device (see `releasedHereOnly`). `terms` is what the action does now;
	/// given, a release made on any other terms does not count.
	function isPaused(nodeId, terms) {
		if (!nodeId) return false;
		load();
		if (resolve(_leaves, nodeId)) return true;
		if (!releasedHereOnly(nodeId)) return false;
		var got = _here[nodeId];
		if (!got) return true;
		return terms !== undefined && got !== terms;
	}

	/// The state of any node, leaf or branch: 'play', 'pause' or
	/// 'mixed'. Needs the tree, so an unknown id answers from its own
	/// record alone rather than pretending.
	function state(nodeId) {
		load();
		var t = tree();
		var node = t ? findNode(t, nodeId) : null;
		if (!node) return isPaused(nodeId) ? 'pause' : 'play';
		return stateOf(node, heldUnder(node));
	}

	/// Has the record held everything under this node? A person's press or the
	/// app's hold, and not a release that has yet to be given here.
	///
	/// Not `state(nodeId) === 'pause'`, which since the per-device release also
	/// counts a triggered action that only waits for a release here. That is
	/// right for the light -- it will not run by itself -- and wrong for a spend
	/// that falls back on the global control: a daimon's file write would then
	/// read as the person holding everything, and refuse their page fetches.
	///
	/// Also not `stateOf` alone, which walks ARMED leaves only. A fresh account
	/// seeds one armed, held leaf (the Optimiser's own trigger) alongside unarmed
	/// ones nobody has touched, and `stateOf` called that "everything held" --
	/// refusing the person's first search on a `root/web` leaf nobody had paused.
	/// Every leaf under the node counts, armed or not.
	function heldByHand(nodeId) {
		load();
		var t = tree();
		var node = t ? findNode(t, nodeId) : null;
		if (!node) return resolve(_leaves, nodeId);
		var leaves = leavesUnder(node);
		if (!leaves.length) return false;
		for (var i = 0; i < leaves.length; i++) if (!resolve(_leaves, leaves[i])) return false;
		return true;
	}

	/// A person's press: set a node playing or paused. It writes one entry, at
	/// the node, which decides for everything under it -- including a leaf made
	/// later, or one only another device has heard of. Returns true when
	/// something actually changed: a press that changes nothing writes nothing,
	/// which is what keeps the sync parcel a fixed point.
	///
	/// This is the one door a release on this device comes through, and every
	/// caller of it is a person pressing play or pause. Play on a triggered
	/// action's OWN light releases it on the terms its tree node carries; a leaf
	/// the tree does not know, or one with no terms, is not released, because
	/// nothing can be released that the app cannot show. Pause on its own light
	/// ends the release. A branch's press releases and ends nothing here: a hold
	/// there suspends the releases under it, and its play puts them back as they
	/// stood.
	function set(nodeId, playing) {
		if (!nodeId) return false;
		current();
		var t = tree();
		var node = (t ? findNode(t, nodeId) : null) || { id: nodeId };
		var p      = playing ? 0 : 1;
		var moved  = !settled(_leaves, nodeId, p);
		var here   = false;
		if (releasedHereOnly(nodeId) && !node.children) {
			if (playing) {
				var terms = (typeof node.terms === 'string') ? node.terms : '';
				if (terms && _here[nodeId] !== terms) { _here[nodeId] = terms; here = true; }
				// Its own hold, outranked by a later branch play, would end this
				// release at the next `settle`: the play is written over it.
				if (terms && heldAt(_leaves, nodeId)) moved = true;
			} else if (_here[nodeId]) {
				delete _here[nodeId];
				here = true;
			}
		}
		if (moved) {
			_leaves = press(_leaves, nodeId, p, now(), device());
			// Forward for an older build too, even past a stamp adopted from a
			// device whose clock runs ahead.
			_stamp = Math.max(_stamp + 1, _leaves[nodeId][1]);
			if (settle()) here = true;
		}
		if (!moved && !here) return false;
		if (moved) save();
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

	/// An app write made here, stored, and announced. The old build's stamp moves
	/// one past what is held, never to the clock, as the app's writes always have
	/// (FU QA, FA): a device new to the account writes before its first pull.
	function wrote(next) {
		if (!next) return false;
		_leaves = next;
		_stamp = _stamp + 1;
		save();
		if (settle()) saveHere();
		announce();
		return true;
	}

	/// Seed a leaf as paused at the moment it is created, without
	/// touching anything else. The default Diamonds' actions start
	/// paused this way. It only ever holds, so it can never end a
	/// person's hold (`seedEntry`).
	function seedPaused(nodeId) {
		if (!nodeId) return false;
		current();
		return wrote(seedEntry(_leaves, nodeId, device()));
	}

	/// Take back a hold the app itself made, for a repair of an earlier seed. The
	/// mirror of `seedPaused`: a hold a person pressed, in any tab or on any
	/// device, is left alone. Releases nothing on this device.
	function unseed(nodeId) {
		if (!nodeId) return false;
		current();
		return wrote(unseedEntry(_leaves, nodeId, device()));
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

	/// Forget an object being deleted: its record (`forgetEntries`) and the
	/// releases given here under it. A stale id is harmless to `isPaused` but
	/// would keep a branch amber for ever and travel in the parcel for the life
	/// of the account. Tidying, not a press -- the retention sweep calls it with
	/// nobody present.
	function forget(prefix) {
		if (!prefix) return false;
		current();
		var gone = false;
		for (var h in _here) {
			if (isUnder(h, prefix)) { delete _here[h]; gone = true; }
		}
		if (gone) saveHere();
		return wrote(forgetEntries(_leaves, prefix, device(), now()));
	}

	/// What travels in the sync parcel and in an errand. Stable bytes for stable
	/// state; a tombstone past its time is pruned here (`prune`).
	function snapshot() {
		load();
		var next = prune(_leaves);
		if (next) { _leaves = next; save(); }
		return record();
	}

	/// Take a record from the sync or an errand, merged id by id against what is
	/// held here, so it can add only what is newer. Returns true when the local
	/// state moved.
	///
	/// A merged record the box refuses still holds here, owed, and still reaches the
	/// lights; then it THROWS, so the sync section is re-pulled rather than read as
	/// applied (SIM-16, A5).
	function adopt(rec) {
		current();
		var before = stateKey();
		take(rec);
		if (stateKey() === before) return false;
		var landed = save();
		// A hold that arrived ends the release given here. A leaf that arrives
		// UNPAUSED gains nothing: what another device released is not released here.
		if (settle()) saveHere();
		announce();
		if (!landed) throw window.DaimondStore.refusal(STORE_KEY);
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
		if (!_leaves || !e || !ours(e.key)) return;	// not read yet: the first read is fresh
		var was = stateKey() + JSON.stringify(_here);
		fresh();
		if (stateKey() + JSON.stringify(_here) !== was) announce();
	}

	if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		window.addEventListener('storage', onStorage);
	}

	/// Drop everything held, for an account switch: one account's
	/// pauses must never colour another's.
	function reset() { _leaves = null; _stamp = 0; _here = null; }

	/// Every held leaf, for a verifier or a diagnostic: the tree's, and any other
	/// id with an entry (`heldLeaves`). A branch held by a press is not in it; the
	/// leaves under it are.
	function pausedIds() { load(); return heldLeaves(_leaves, tree()); }

	/// The entry recorded at exactly this id, as `[p, t, o]`, or null.
	function entry(nodeId) {
		load();
		var e = nodeId ? own(_leaves, nodeId) : null;
		return e ? e.slice() : null;
	}

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
		releasedHere: releasedHere,
		carry:      carry,
		pruneHere:  pruneHere,
		forget:     forget,
		snapshot:   snapshot,
		adopt:      adopt,
		subscribe:  subscribe,
		reset:      reset,
		pausedIds:  pausedIds,
		entry:      entry,
		label:      label,
		// Pure core, exposed for tests and for reuse.
		_core: {
			leavesUnder:   leavesUnder,
			leafNodesUnder: leafNodesUnder,
			releasedHereOnly: releasedHereOnly,
			armedUnder:    armedUnder,
			findNode:      findNode,
			stateOf:       stateOf,
			clickWould:    clickWould,
			pathOf:        pathOf,
			beats:         beats,
			mergeEntries:  mergeEntries,
			decider:       decider,
			resolve:       resolve,
			settled:       settled,
			press:         press,
			heldAbove:     heldAbove,
			heldAt:        heldAt,
			seedEntry:     seedEntry,
			unseedEntry:   unseedEntry,
			forgetEntries: forgetEntries,
			newest:        newest,
			prune:         prune,
			heldLeaves:    heldLeaves,
			toRecord:      toRecord,
			adoptLegacy:   adoptLegacy,
			consts: { STORE_KEY: STORE_KEY, HERE_KEY: HERE_KEY, ROOT: ROOT, LEGACY: LEGACY, TOMB_MS: TOMB_MS },
		},
	};

	if (typeof window !== 'undefined') window.DaimondPause = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
