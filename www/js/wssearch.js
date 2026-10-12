// wssearch.js -- the Workspace panel's search: one bounded walk over every place the panel shows.
//
// E5 of specs/daimond_workspace_firstprinciples_20261009.md. The panel's filter box used to search from
// the folder in view down, so a file in Daimond's files or in another store was "not there" while the
// person could see it one press away. This walks every root in turn, breadth first, and hands each match
// over as it is found.
//
// TWO LIMITS, each its own flag with its own wording, and never a silent one (WS-SEARCH, 12 Oct):
//   - the RESULT limit (`maxResults`): rows drawn; `stats.capped` only when more results exist;
//   - the WALK limit (`maxVisits`, none by default): entries looked at; `stats.stopped` with
//     `stats.visited`, so the panel can say how much was searched and that the rest was not.
// Until 12 Oct each root had a visit cap of a few thousand that set the same flag as the result
// limit: a file six deep in a real folder of 348k entries was never reached, and four true results
// read "Showing first 4". It yields to the event loop every `batch` entries, so a store answering
// from memory cannot hold the page for the length of the walk, and it is CANCELLED by the next
// keystroke: a walk whose query is gone calls nothing after `cancel()`.
//
// The listing door answers names alone; `o.times(root, dir)` (optional) is asked only of a folder
// holding a match, because opening every file for a time nobody sees cost minutes on a real folder.
//
// Pure: the listing door, the clock and the drawing are the caller's. `www/js/wssearch.test.mjs`.
(function () {
	'use strict';

	/// Does the name answer the query? A case-free substring, as the old filter was.
	function matches(name, q) {
		return !!q && String(name).toLowerCase().indexOf(q) !== -1;
	}

	function join(dir, name) { return dir ? (dir + '/' + name) : name; }

	/// Start one walk and answer `{ cancel, done }`; `done` settles with what bounded it.
	///
	/// `o.roots` is `[{ id, path, skip }]`, walked in order; `skip` lists paths (relative to the
	/// store, as `path` is) that another root covers, so no file is found twice. `o.list(root, dir)`
	/// answers a directory's entries `{ name, dir, at }` (or throws, which skips it). `o.times(root,
	/// dir)`, when given, answers `{ name: at }` for a folder that holds a match. `o.onHit(hit)` is
	/// called per match with `{ root, path, name, at }`.
	function walk(o) {
		var q = String(o.query || '').trim().toLowerCase();
		var maxHits = o.maxResults > 0 ? o.maxResults : 100;
		var maxVisits = o.maxVisits > 0 ? o.maxVisits : Infinity;
		var batch = o.batch > 0 ? o.batch : 200;
		var pause = o.pause || function () { return new Promise(function (r) { setTimeout(r, 0); }); };
		var dead = false;
		var stats = { hits: 0, visited: 0, capped: false, stopped: false, cancelled: false };

		async function run() {
			if (!q) return stats;
			var sinceYield = 0;
			for (var r = 0; r < (o.roots || []).length; r++) {
				var root = o.roots[r];
				var skip = root.skip || [];
				var todo = [root.path || ''];
				while (todo.length) {
					var dir = todo.shift();
					var ents;
					try { ents = await o.list(root, dir); }
					catch (e) { ents = []; }			// gone or refused: nothing here to find
					if (dead) { stats.cancelled = true; return stats; }
					ents = (ents || []).slice().sort(function (a, b) {
						return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
					});
					var found = [];
					for (var i = 0; i < ents.length; i++) {
						var e = ents[i];
						if (!e.name || e.name.charAt(0) === '.') continue;	// the store's own bookkeeping
						var full = join(dir, e.name);
						if (skip.indexOf(full) !== -1) continue;
						if (stats.visited >= maxVisits) { stats.stopped = true; break; }
						stats.visited++; sinceYield++;
						if (e.dir) { todo.push(full); continue; }
						if (matches(e.name, q)) found.push(e);
					}
					if (found.length) {
						var at = null;
						if (o.times) {
							try { at = await o.times(root, dir); }
							catch (e2) { at = null; }	// no times is still a hit
							if (dead) { stats.cancelled = true; return stats; }
						}
						for (var k = 0; k < found.length; k++) {
							if (stats.hits >= maxHits) { stats.capped = true; return stats; }
							stats.hits++;
							var nm = found[k].name;
							o.onHit({ root: root.id, path: join(dir, nm), name: nm,
								at: (at && at[nm]) || found[k].at || 0 });
						}
					}
					if (stats.stopped) return stats;
					if (sinceYield >= batch) {
						sinceYield = 0;
						await pause();
						if (dead) { stats.cancelled = true; return stats; }
					}
				}
			}
			return stats;
		}

		var done = run();
		return {
			cancel: function () { dead = true; },
			done: done,
		};
	}

	/// Where a hit lives, for its row: `own` when it is inside the open diamond's folder (the row says
	/// "Its own folder"), and the folder it sits in, relative to that, with a trailing slash.
	function placeOf(path, ownDir) {
		var p = String(path || '');
		var own = !!ownDir && p.indexOf(ownDir + '/') === 0;
		if (own) p = p.slice(ownDir.length + 1);
		var cut = p.lastIndexOf('/');
		return { own: own, dir: cut > 0 ? p.slice(0, cut + 1) : '' };
	}

	window.DaimondWsSearch = { walk: walk, matches: matches, placeOf: placeOf };
})();
