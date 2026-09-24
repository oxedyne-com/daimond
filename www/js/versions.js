/* ============================================================
   Daimond — file versions (versions.js)
   ------------------------------------------------------------
   The client half of `dev/VERSIONS_CONTRACT.md`. Every file a
   diamond holds gets what its crystal already had: a version at
   every change, a History row to read it from, and a Restore that
   is never destructive.

   THIS FILE OWNS NO POLICY. The manifests, the bodies, the prune
   order and the restore are all in Rust, behind the `versions_*`
   exports. What is here is the reading of them, the join with the
   log so History is ONE list, and the one thing Rust deliberately
   does not do: writing a restored MACHINE file back. A file in a
   folder marked into the diamond does not live in the store, so
   `versions_restore` names it in `machine[]` and leaves it to the
   fenced `file_write` door -- the same door `writeOpenFile` uses,
   under the diamond's own bounds. The engine never writes outside
   the store, and this is where that rule is kept.

   IT ANSWERS ON A BUILD THAT HAS NONE OF IT. `ready()` asks the
   engine whether the exports are there, and every call answers
   empty rather than throwing where they are not: the Rust and the
   page ship on their own clocks, and a History panel that threw on
   an older wasm would take the crystal's own history down with it.
   ============================================================ */
(function () {
	'use strict';

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	/// The English at the call site, so the panel reads before the tables land.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return v[name] != null ? String(v[name]) : whole;
		});
	}

	function core() { return window.DaimondCore || null; }
	/// The engine, and where it matters WHICH engine: a restore drops the restored
	/// paths from that engine's read cache, so it has to be the one the diamond's
	/// own turns run on or the daimon's next write to a restored file is refused as
	/// another agent's edit. One app is kept per provider and model, so a diamond on
	/// the starred model gets the same object either way.
	function app(id) {
		try { return (core() && DaimondCore.diamondApp) ? DaimondCore.diamondApp(id) : null; }
		catch (e) { return null; }
	}

	/// Does this build's engine carry the versions exports?
	///
	/// Asked of `versions_list` and answered for all of them: they land together in
	/// one `#[wasm_bindgen]` block, so a build with one has them all. Every door
	/// below is gated on it, which is what lets the History panel mount whole on a
	/// wasm that has never heard of a file version.
	function ready() {
		var a = app();
		return !!(a && typeof a.versions_list === 'function');
	}

	function parse(text, fallback) {
		try { return JSON.parse(String(text || '')); }
		catch (e) { return fallback; }
	}

	/// Mark a path as changed by the USER, so the next turn snapshots what is on
	/// disk before the daimon touches it. Every user-owned write door calls this:
	/// the Doc panel's save, the Files panel's create and delete, the capp page's
	/// own save.
	///
	/// Synchronous in the engine and deliberately silent here. A door that had to
	/// handle a failure from this would be a save that could fail because a version
	/// could not be recorded, and the write is the thing the user asked for.
	function dirty(id, path) {
		if (!id || !path || !ready()) return;
		try { app().versions_mark_dirty(String(id), String(path)); }
		catch (e) { /* the walk at turn start still catches it */ }
	}

	/// Everything a share just landed is a change the user made (cause `share`).
	function landed(id) {
		if (!id || !ready() || typeof app().versions_landed !== 'function') return null;
		try { return app().versions_landed(String(id)); }
		catch (e) { return null; }
	}

	/// The manifests of a diamond, newest first, as the engine answers them.
	async function manifests(id) {
		if (!id || !ready()) return [];
		var out;
		try { out = await app().versions_list(String(id)); }
		catch (e) { return []; }
		var got = parse(out, []);
		return Array.isArray(got) ? got : [];
	}

	/// Every version of a diamond, newest first, with the log record and the file
	/// manifest of each joined by version number.
	///
	/// `crystal` says whether the crystal itself moved at this version, which is
	/// what decides whether the row draws View / Restore / Delta for it. A
	/// files-only version carries `kind: "files"` in the log and never a snapshot.
	async function rows(id) {
		if (!id) return [];
		var recs = [], a = app();
		if (a) {
			try { recs = parse(await a.log_read(String(id)), []) || []; }
			catch (e) { recs = []; }
		}
		var byV = {};
		recs.forEach(function (r) {
			// A record written before the rename says `brief_version`. Reading only
			// the new name would drop every historical fold out of this list.
			var v = (r.crystal_version !== undefined && r.crystal_version !== null)
				? r.crystal_version : r.brief_version;
			if (v === undefined || v === null) return;
			byV[v] = {
				v: v, ts: r.ts || 0, kind: r.kind || 'change', cause: '',
				note: r.note || '', files: [], truncated: 0,
				delta_ref: r.delta_ref || '',
				crystal: (r.kind || '') !== 'files',
			};
		});
		(await manifests(id)).forEach(function (m) {
			var v = (m.version !== undefined && m.version !== null) ? m.version : m.v;
			if (v === undefined || v === null) return;
			var row = byV[v];
			if (!row) {
				byV[v] = row = { v: v, ts: m.ts || 0, kind: 'files', cause: '',
					note: '', files: [], truncated: 0, delta_ref: '', crystal: false };
			}
			row.cause = m.cause || '';
			row.files = m.files || [];
			row.truncated = m.truncated || 0;
			if (!row.note && m.note) row.note = m.note;
			if (!row.ts && m.ts) row.ts = m.ts;
		});
		return Object.keys(byV).map(function (k) { return byV[k]; })
			.sort(function (x, y) { return y.v - x.v; });
	}

	/// What the gauge draws: bodies on disk against the cap, both in bytes, with
	/// the two constants beside them a reader may want (`manifests_cap`, `file_max`).
	async function gauge(id) {
		var empty = { used: 0, cap: 0, manifests: 0 };
		if (!id || !ready()) return empty;
		var st;
		try { st = parse(await app().versions_state(String(id)), null); }
		catch (e) { st = null; }
		if (!st) return empty;
		return {
			used: st.bytes || 0, cap: st.cap || 0, manifests: st.manifests || 0,
			manifests_cap: st.manifests_cap || 0, file_max: st.file_max || 0,
		};
	}

	/// One body, by content hash. `null` where this device does not hold it — a
	/// diamond imported from a peer that had already pruned it. The row says
	/// `versions.not_here` and greys Restore; nothing throws.
	///
	/// The engine answers `""` for a body it has not got, which is also what an
	/// empty file reads as. The ambiguity is the engine's and is harmless here:
	/// there is nothing to draw and nothing to write back either way.
	async function body(id, hash) {
		if (!id || !hash || !ready()) return null;
		var out;
		try { out = await app().versions_body(String(id), String(hash)); }
		catch (e) { return null; }
		return (out === '' || out == null) ? null : out;
	}

	/// The OPFS store PATH of a body, `diamonds/<id>/versions/b/<hash>`, so the file viewer
	/// can probe and read a BINARY changed file's bytes through the store door
	/// (`store_read_bytes`) rather than `body`'s lossy UTF-8 text (S-HAND #4). The path is
	/// formed whether or not the body is present; a subsequent read decides that.
	function bodyPath(id, hash) {
		if (!id || !hash || !ready()) return '';
		try { return String(app().versions_body_path(String(id), String(hash)) || ''); }
		catch (e) { return ''; }
	}

	/// The user's own Save a version. `null` when nothing had changed — a save
	/// that wrote a row saying nothing would be worse than no row (D2).
	async function save(id, name) {
		if (!id || !ready()) return null;
		var out;
		try { out = await app().versions_save_user(String(id), String(name == null ? '' : name)); }
		catch (e) { return null; }
		var made = parse(out, null);
		return (made && made.version !== undefined && made.version !== null) ? made : null;
	}

	// ── Restore ──────────────────────────────────────────────────
	//
	// The engine writes the store half and records the `restore` manifest first, so
	// what was there is one row up and a restore can itself be restored. What it
	// does NOT write is a file on the user's own machine: those are named in
	// `machine[]` and go back through the fenced `file_write` door, under the
	// diamond's current bounds. A mark since withdrawn is refused there, in the
	// fence's own sentence, and the file on disk is untouched.

	/// Write back the machine half of a restore. Answers the paths it refused, to
	/// be added to the engine's own list.
	async function writeMachine(id, entries) {
		var refused = [];
		if (!(entries || []).length) return refused;
		// THE DIAMOND'S REACH AS IT IS NOW, and not as it was when the file was
		// written. `run_diamond_tool` builds the fence per call from these, so a mark
		// the user has withdrawn since is refused in the fence's own sentence and the
		// file on disk is untouched -- which the shared `toolsApp` could never do,
		// because it carries no diamond's bounds and `set_diamond_scope` composes
		// rather than assigns.
		var marks = { attached: [], read_only: [] };
		// A CHAT'S STORE (`chat:<id>`) goes back through the CHAT'S marks, which are
		// what its turn was fenced to; a Diamond's through its own.
		var chat = String(id).indexOf('chat:') === 0 ? String(id).slice(5) : '';
		try {
			marks = chat
				? { attached: await DaimondAttach.chatScope(chat), read_only: [] }
				: await DaimondDiamond.bounds(id);
		}
		catch (e) { marks = { attached: [], read_only: [] }; }
		var eng = app(id);
		// FAILS CLOSED. An engine without the fenced door is not a reason to write
		// through an unfenced one: the whole property of this half is that a restore
		// reaches exactly what the diamond reaches.
		if (!eng || typeof eng.run_diamond_tool !== 'function') {
			(entries || []).forEach(function (e) {
				refused.push({ path: e.path, why: tOr('versions.refused', 'Outside this diamond’s reach') });
			});
			return refused;
		}
		var run = function (tool, args) {
			return eng.run_diamond_tool(String(id),
				JSON.stringify(marks.attached || []), JSON.stringify(marks.read_only || []),
				tool, JSON.stringify(args));
		};
		for (var i = 0; i < (entries || []).length; i++) {
			var e = entries[i];
			var r = null;
			try {
				if (e.gone) {
					// The path did not exist at that version, so restoring TO it means
					// taking it away again. Recorded in the `restore` manifest first by
					// the engine, so the bytes are one row up.
					r = await run('file_delete', { path: e.path });
				} else if (e.skipped) {
					refused.push({ path: e.path, why: tOr('versions.too_big', 'Too large to keep') });
					continue;
				} else {
					var text = await body(id, e.hash);
					if (text === null) {
						refused.push({ path: e.path, why: tOr('versions.not_here', 'Not on this device') });
						continue;
					}
					r = await run('file_write', { path: e.path, content: text });
				}
			} catch (err) { r = null; }
			// A refused tool call RESOLVES, like every other one, so the outcome is
			// what says whether the bytes went anywhere. Taking the promise for an
			// answer is the mistake `writeOpenFile`'s own comment records.
			//
			// THE ROW GETS THE SHORT SENTENCE and the tooltip gets the fence's own.
			// A fence refusal is a paragraph addressed to a MODEL -- what it may read
			// instead, what to ask the user for -- and a muted span beside a path is
			// not where a person reads that. The two other refusals here are already
			// four words each; this is the same shape, with the whole of it a hover
			// away. A call that FAILED rather than being refused keeps its own words:
			// that is not a reach at all, and calling it one would misname a fault.
			if (!r || r.outcome !== 'done') {
				var why = (r && r.outcome === 'failed' && r.text)
					? String(r.text)
					: tOr('versions.refused', 'Outside this diamond’s reach');
				refused.push({ path: e.path, why: why, said: (r && r.text) ? String(r.text) : '' });
			}
		}
		return refused;
	}

	/// The undo window a restore opens.
	///
	/// A restore writes its own `restore` manifest FIRST, so the way back is simply
	/// to restore THAT: the state before the press is one row up, and the revert is
	/// the same call pointed at the version the restore itself recorded. Nothing to
	/// commit -- the restore is already on disk.
	function offerUndo(id, res, text) {
		if (!res || !window.DaimondUndo) return;
		if (!(res.restored || []).length) return;
		var back = res.version;
		DaimondUndo.able({
			text: text,
			revert: function () {
				if (back === undefined || back === null || !ready()) return;
				restoreAt(id, back, '');
			},
		});
	}

	/// The call itself, both halves, with no confirm and no toast: the two doors
	/// below add what each of them owes.
	async function restoreAt(id, n, path) {
		var out;
		try { out = await app(id).versions_restore(String(id), Number(n), String(path || '')); }
		catch (e) { return null; }
		var res = parse(out, null);
		if (!res) return null;
		res.refused = (res.refused || []).concat(await writeMachine(id, res.machine || []));
		return res;
	}

	/// Put back what one recorded version changed, each file to how it stood just
	/// before it: the undo a chat's turn offers (`offerTurnUndo` in daimond.js).
	///
	/// File by file and never the whole version at `n - 1`, because a whole-version
	/// restore takes a path the store first met at `n` to have been absent before
	/// it -- which for a file the turn deleted is the opposite of the truth. A
	/// per-path restore reads the row's own `was`.
	async function undoVersion(id, n, paths) {
		if (!id || !ready() || !(Number(n) > 0)) return null;
		var restored = [], refused = [];
		for (var i = 0; i < (paths || []).length; i++) {
			var res = await restoreAt(id, Number(n) - 1, String(paths[i]));
			if (!res) continue;
			restored = restored.concat(res.restored || []);
			refused = refused.concat(res.refused || []);
		}
		return { restored: restored, refused: refused };
	}

	/// Restore the WHOLE version: the crystal as it stood, and every file to its
	/// state at `n`. Asks once — it is the only Restore that does, because it moves
	/// everything at once and the per-file one is undoable by toast.
	/// # Arguments
	/// * `opts.ask` - `false` where the caller has already asked. The History
	///   panel's whole-version Restore does, because it puts the CRYSTAL back in
	///   the same breath (the engine restores files and nothing else) and two
	///   dialogs for one press is one too many.
	async function restore(id, n, opts) {
		if (!id || !ready()) return null;
		var ok = true;
		try {
			if (opts && opts.ask === false) ok = true;
			else if (core() && DaimondCore.confirm) {
				ok = await DaimondCore.confirm(
					tOr('versions.restore_ask', 'Restore v{v}? Today’s state is kept.', { v: n }),
					tOr('crystal.restore_v', 'Restore v{v}', { v: n }),
					{ title: tOr('crystal.restore_title', 'Restore a version'), danger: false });
			}
		} catch (e) { ok = false; }
		if (!ok) return null;
		var res = await restoreAt(id, n, '');
		offerUndo(id, res, tOr('versions.restored_v', 'Restored v{v}', { v: n }));
		return res;
	}

	/// Restore ONE path. No confirm: the toast is the confirm, and it comes with
	/// the way back.
	async function restoreFile(id, path, n) {
		if (!id || !path || !ready()) return null;
		var res = await restoreAt(id, n, String(path));
		var name = String(path).split('/').pop();
		offerUndo(id, res, tOr('undo.restored', 'Restored {name}', { name: name }));
		return res;
	}

	// ── The before/after ─────────────────────────────────────────
	//
	// `versions_diff` is the engine's, and it THROWS rather than answering for the
	// three cases a line diff has no honest answer to: a binary body, a body this
	// device has not got, and a file past the 2,000-line cap. Each of those is
	// "Cannot compare" in the row, which is why the throw is caught and not passed
	// on. The LCS below is the fallback for a build without the export, over the
	// two bodies the row already has.

	var DIFF_MAX_LINES = 2000;

	/// `{add, del, rows: [{op, text}]}`, or null where the two cannot be compared.
	async function diff(id, was, now) {
		if (!id || !ready()) return null;
		if (typeof app().versions_diff === 'function') {
			var out;
			try { out = await app().versions_diff(String(id), String(was || ''), String(now || '')); }
			catch (e) { return null; }
			var d = parse(out, null);
			if (!d) return null;
			return {
				add: d.add || 0, del: d.del || 0,
				rows: (d.rows || []).map(function (r) { return { op: r.k, text: r.t }; }),
			};
		}
		var before = was ? await body(id, was) : '';
		var after  = now ? await body(id, now) : '';
		if (before === null || after === null) return null;
		return lineDiff(before, after);
	}

	/// An LCS over lines, which is what a before/after of two text bodies is. The
	/// cap is the whole of the memory discipline: an LCS table is O(n·m), so two
	/// 40,000-line files would be 1.6 billion cells.
	function lineDiff(before, after) {
		var a = String(before == null ? '' : before).split('\n');
		var b = String(after == null ? '' : after).split('\n');
		if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return null;
		var n = a.length, m = b.length, i, j;
		var lcs = new Array(n + 1);
		for (i = 0; i <= n; i++) lcs[i] = new Int32Array(m + 1);
		for (i = n - 1; i >= 0; i--) {
			for (j = m - 1; j >= 0; j--) {
				lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1
					: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
			}
		}
		var out = [], add = 0, del = 0;
		i = 0; j = 0;
		while (i < n && j < m) {
			if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
			else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ op: '-', text: a[i] }); del++; i++; }
			else { out.push({ op: '+', text: b[j] }); add++; j++; }
		}
		while (i < n) { out.push({ op: '-', text: a[i] }); del++; i++; }
		while (j < m) { out.push({ op: '+', text: b[j] }); add++; j++; }
		return { add: add, del: del, rows: out };
	}

	window.DaimondVersions = {
		ready:       ready,
		dirty:       dirty,
		landed:      landed,
		rows:        rows,
		manifests:   manifests,
		body:        body,
		bodyPath:    bodyPath,
		save:        save,
		restore:     restore,
		restoreFile: restoreFile,
		undoVersion: undoVersion,
		gauge:       gauge,
		diff:        diff,
		lineDiff:    lineDiff,
		DIFF_MAX_LINES: DIFF_MAX_LINES,
	};
})();
