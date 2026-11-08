/* ============================================================
   Daimond — moving a file (moveentry.js)
   ------------------------------------------------------------
   WHY THIS EXISTS (owner, 2026-11-08). Moving a file in the Workspace panel meant
   typing its new path into the Rename dialog. That is a shell with a mouse, and it
   made Rename do two things, so neither could be trusted: a rename could silently
   put a file in another folder, and a move was a string a person had to spell.

   The panel now moves things the way a file manager does — drag a row onto a
   folder, Move to… in the ⋯, drop from the desktop, cut and paste — and every one
   of those doors goes through the arithmetic here, so they cannot disagree about
   what a move is, what is nonsense, or what taking it back means.

   WHAT IS NONSENSE is decided ONCE: a folder into itself, a folder into its own
   descendant, something into the folder it is already in, and a name carrying a
   path (which belongs to the picker, not to Rename).

   AND THE UNDO FOLLOWS THE THING, NOT THE PATH. The owner's own requirement: "Undo
   of a move must put it back even after I've moved something else since." A path is
   a place, and places get re-used; a batch therefore remembers which ITEM it moved,
   and undoing it asks where that item is NOW and brings it back from there. A later
   batch that named the same item is rewritten or dropped, so the log never claims an
   item is somewhere it is not.

   This file is PURE: no DOM, no wasm, no window. That is what lets dev/wsmove.test.mjs
   prove all of the above in a second, and the browser suite prove only the wiring.
   ============================================================ */
(function () {
	'use strict';

	function joinPath(dir, name) {
		dir = String(dir == null ? '' : dir).replace(/\/+$/, '');
		name = String(name == null ? '' : name);
		return dir ? (dir + '/' + name) : name;
	}

	function parentOf(path) {
		var p = String(path == null ? '' : path).replace(/\/+$/, '');
		var i = p.lastIndexOf('/');
		return i < 0 ? '' : p.slice(0, i);
	}

	function nameOf(path) {
		var p = String(path == null ? '' : path).replace(/\/+$/, '');
		var i = p.lastIndexOf('/');
		return i < 0 ? p : p.slice(i + 1);
	}

	/// Why `name` cannot be a file's own name, or '' when it can.
	///
	/// A NAME, not a path: this is what Rename asks for, and the one thing Rename may
	/// not do is put the file somewhere else. The dialog says the reason in its own
	/// error line, so the sentence is a whole one and names the door that does move.
	function badName(name) {
		var n = String(name == null ? '' : name).trim();
		if (!n) return 'A file needs a name.';
		if (n === '.' || n === '..') return 'That name is not a name.';
		if (n.indexOf('/') !== -1) return 'A name cannot carry a path. Use Move to… to put it in a folder.';
		if (/[\u0000-\u001f]/.test(n)) return 'That name holds a character a file cannot have.';
		return '';
	}

	/// Whether `path` is `dir` or sits inside it.
	function within(path, dir) {
		if (!dir) return false;
		return path === dir || path.indexOf(dir + '/') === 0;
	}

	/// What moving `paths` into `dir` would do: { moves: [{from, to}], refused: [{path, why}] }.
	///
	/// `opts.isDir(path)` says which of them are folders; a folder may not be moved into
	/// itself or into anything under it. Everything else about the target is the fence's
	/// business and is answered by the `file_move` call itself.
	function plan(paths, dir, opts) {
		opts = opts || {};
		var isDir = typeof opts.isDir === 'function' ? opts.isDir : function () { return false; };
		var to = String(dir == null ? '' : dir).replace(/\/+$/, '');
		var moves = [], refused = [];
		var norm = (paths || []).map(function (p) {
			return String(p == null ? '' : p).replace(/\/+$/, '');
		});

		// A batch is ONE gesture — a multi-select drag, a paste of four files — and
		// two things in it can collide. Three collisions, all of which would lose a
		// file silently or move a path that the batch itself has just invalidated:
		//
		//   1. the same path named twice (a Shift range overlapping a Ctrl-click)
		//   2. two files of one name arriving in the same folder — both plan the same
		//      `to`, and the second write lands on the first
		//   3. a folder and something inside it — the folder's own move carries the
		//      child along, so the child's move would address a path already gone
		//
		// So the batch is planned against a set of paths it has already claimed, and
		// the losers are REFUSED and named rather than quietly dropped: `moveTo` says
		// what it would not do, and the person sees it.
		var claimedFrom = {};		// from -> true, so a repeat is one move
		var claimedTo = {};			// to -> the from that holds it
		var batched = {};			// from -> true, for the ancestor test below

		norm.forEach(function (p) { if (p) batched[p] = true; });

		norm.forEach(function (from) {
			if (!from) { refused.push({ path: from, why: 'Nothing to move.' }); return; }
			if (claimedFrom[from]) { refused.push({ path: from, why: 'Named twice in one batch.' }); return; }
			if (from === to) { refused.push({ path: from, why: 'It is already there.' }); return; }
			if (isDir(from) && within(to, from)) {
				refused.push({ path: from, why: 'A folder cannot go inside itself.' });
				return;
			}

			// 3. Its parent is moving too, so this move would address a path that the
			//    parent's move has already taken away.
			var par = parentOf(from);
			while (par) {
				if (batched[par]) {
					refused.push({ path: from, why: 'Its folder is moving with it.' });
					return;
				}
				par = parentOf(par);
			}

			var name = nameOf(from);
			if (parentOf(from) === to) { refused.push({ path: from, why: 'It is already there.' }); return; }

			// 2. Something else in this batch has already claimed the name it lands on.
			var target = joinPath(to, name);
			if (claimedTo[target] !== undefined) {
				refused.push({ path: from, why: 'Another item of this name is moving to the same folder.' });
				return;
			}

			claimedFrom[from] = true;
			claimedTo[target] = from;
			moves.push({ from: from, to: target });
		});
		return { moves: moves, refused: refused };
	}

	/// The log of moves that can be taken back.
	///
	/// One ITEM per entry, held by a token, because a path is a place and places are
	/// re-used: `where(origin)` answers where that item is now, and an undo asks it
	/// rather than trusting the path it recorded.
	function createLog() {
		var batches = [];			// [{ id, entries: [{ token, from, to }] }]
		var cur = {};				// token -> the path it is at now
		var origin = {};			// token -> the path it was first seen at
		var seq = 0;

		function tokenAt(path) {
			for (var k in cur) if (cur[k] === path) return k;
			var t = 't' + (++seq);
			cur[t] = path;
			origin[t] = path;
			return t;
		}

		function at(path) {
			for (var k in cur) if (cur[k] === path) return k;
			return null;
		}

		/// Record a batch of moves that HAVE happened, and hand back its handle.
		function add(moves) {
			var entries = [];
			(moves || []).forEach(function (m) {
				var t = tokenAt(m.from);
				entries.push({ token: t, from: m.from, to: m.to });
				cur[t] = m.to;
			});
			var b = { id: 'b' + (++seq), entries: entries };
			batches.push(b);
			return b;
		}

		/// The batch a press of "Undo move" takes back: the newest one still open.
		function newest() { return batches.length ? batches[batches.length - 1] : null; }

		/// Where the item that started at `originPath` is now; the path itself when it
		/// is not one this log has moved.
		function where(originPath) {
			for (var k in origin) if (origin[k] === originPath) return cur[k];
			return originPath;
		}

		function count() { return batches.length; }

		/// The moves that would take `batch` back, given where its items are NOW.
		///
		/// A move back onto a path something else has since taken is REFUSED rather
		/// than performed: an undo that overwrote a newer file would be a worse act
		/// than the one it was undoing.
		function inverse(batch) {
			var touched = {}, i;
			for (i = 0; i < batch.entries.length; i++) touched[batch.entries[i].token] = 1;
			var moves = [], refused = [];
			for (i = batch.entries.length - 1; i >= 0; i--) {
				var e = batch.entries[i], here = cur[e.token], there = e.from;
				if (here === undefined) continue;
				if (here === there) continue;
				var held = at(there);
				if (held && !touched[held]) {
					refused.push({ path: there, why: 'Something else is there now.' });
					continue;
				}
				moves.push({ from: here, to: there });
			}
			return { moves: moves, refused: refused };
		}

		/// Take a batch back. The caller performs `moves` and then calls `done`.
		///
		/// Returns { moves, refused }. The log is settled at once, because the caller's
		/// moves are the ones the panel has just made: a failed `file_move` says so on
		/// the next listing, and the log is not the place to keep a half-truth.
		function undo(batch) {
			if (!batch || batches.indexOf(batch) < 0) return { moves: [], refused: [] };
			var r = inverse(batch);
			var touched = {}, i;
			for (i = 0; i < batch.entries.length; i++) touched[batch.entries[i].token] = 1;
			r.moves.forEach(function (m) {
				var t = at(m.from);
				if (t) cur[t] = m.to;
			});
			// A LATER batch that named one of these items is rewritten without it: its
			// path is no longer that item's, and a batch kept whole would undo a move
			// that is no longer there. An EARLIER batch is left exactly as it was -- it
			// is the one still worth taking back, and `inverse` reads where the item is
			// now rather than the path it recorded.
			var at0 = batches.indexOf(batch);
			batches = batches.filter(function (b, i) {
				if (i < at0) return true;		// an earlier batch stands as it was
				if (i === at0) return false;	// this one is taken back
				b.entries = b.entries.filter(function (e) { return !touched[e.token]; });
				return b.entries.length > 0;
			});
			return r;
		}

		function undoNewest() {
			if (!batches.length) return null;
			return undo(batches[batches.length - 1]);
		}

		function clear() { batches = []; cur = {}; origin = {}; seq = 0; }

		return { add: add, where: where, count: count, newest: newest, undo: undo, undoNewest: undoNewest, clear: clear };
	}

	var M = {
		joinPath: joinPath,
		parentOf: parentOf,
		nameOf: nameOf,
		badName: badName,
		within: within,
		plan: plan,
		createLog: createLog,
	};

	if (typeof window !== 'undefined') window.DaimondMove = M;
	if (typeof module !== 'undefined' && module.exports) module.exports = M;
})();
