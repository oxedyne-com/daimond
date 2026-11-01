// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { changeName } from './consent.js';
import { Files } from './files_view.js';
import { selfDeviceId } from './handoff.js';
import { _turnUndoRows, histAwayUndo } from './marks.js';
import { changeDiff } from './pending.js';
import { mountFileRates } from './rating.js';
import { tOr } from './settingsui.js';
import { pg } from './state.js';
import { buildTile, pinBottom, postToChat, tilePeek } from './turns.js';
import { dsEvent, t, tn } from './util.js';
// page-split: end imports
// page-split: turnfiles.js -- the changed-files table at the end of a turn, moved whole out of
// turns.js (1 Nov 2026) to keep that module under modcheck's 5,000 lines; no behaviour changed.

// ── #22: the changed-files table at the end of a turn ─────────────────
// The engine already ends every file-changing turn with the tail-note user
// message (diamond_versions.rs tail_note → wasm/app.rs:2870). This diverts
// that one message into the table the proposal asked for: one row per file,
// name on the left, +N −M on the right, 6 rows then a fold.
var _TAIL_MORE = 6;   // rows before the "show N more" fold

/// Parse the engine's own tail note into { count, v, files, rest }.
/// The shape is diamond_versions.rs:726's, and this is the only string that
/// ever reaches here — anything else draws as an ordinary user message.
export function _parseTailNote(text) {
	var m = /^\[Daimond: this turn changed (\d+) files? \(v(\d+)\): (.+?)\. The user can restore/.exec(String(text || ''));
	if (!m) return null;
	var shown = m[3].split(',').map(function (x) { return x.trim(); }).filter(Boolean);
	var rest = 0;
	var last = shown.length ? shown[shown.length - 1] : '';
	var rm = /^(.+) and (\d+) more$/.exec(last);
	if (rm) { rest = Number(rm[2]); shown[shown.length - 1] = rm[1].trim(); }
	return { count: Number(m[1]), v: Number(m[2]), files: shown, rest: rest };
}

/// What a Files tile is drawn from, or null when the text is not a tail note: the parse, the Diamond
/// the note's chat belongs to, and the handles of the rows the note's own records name. A row whose
/// handle is not in `have` is drawn without one, and so is never offered for a rating.
function _tailNoteParts(text, chat, prod) {
	var p = _parseTailNote(text);
	if (!p) return null;
	var have = new Set();
	(Array.isArray(prod) ? prod : []).forEach(function (r) {
		if (r && r.k === 'file' && typeof r.h === 'string') have.add(r.h);
	});
	// THE CHAT IS THE AUTHORITY (S-HAND #4/#6-tile). The note lives in this chat's
	// transcript, so the Diamond it belongs to is `chat.diamondId` -- NOT `currentDiamond`,
	// which is null for a daimon chat opened from the CHAT LIST (chats select the chat but
	// no Diamond). With id '' the manifest lookup was empty, every row's delta undefined,
	// and `openTurnFile` had no hash to fall back to -- the whole tile was dead on click,
	// which is the owner-hit bug. `currentDiamond` remains the fallback for a note drawn
	// while a Diamond is open the ordinary way.
	var id = (chat && chat.diamondId) || (pg.currentDiamond ? pg.currentDiamond.id : '');
	return { p: p, id: id, have: have };
}

/// The Files table from what the note itself says: every file it names and no counts, at once, on
/// any device. A tile draws from the data the device has and is enriched when more arrives, so
/// this never waits on the version store (`_tailNoteTable` adds the counts).
///
/// `files` is the structured list the turn row carries (`turnFileList`, #8): every file the turn
/// wrote, with the `+N −M` counted at the turn's end. Where it is present the rows are drawn from
/// it alone, like a chat's `files_log` row (J6), because the note names only six and then "and N
/// more", which no row can be drawn from. A row from before the list falls back to the note.
function _tailNoteNames(text, chat, prod, files) {
	var q = _tailNoteParts(text, chat, prod);
	if (!q) return null;
	var names = [], byPath = {};
	(Array.isArray(files) ? files : []).forEach(function (f) {
		if (!f || typeof f.path !== 'string' || !f.path || byPath[f.path]) return;
		names.push(f.path);
		byPath[f.path] = { path: f.path, hash: f.gone ? '' : (f.hash || ''), gone: !!f.gone,
			add: typeof f.add === 'number' ? f.add : null, del: typeof f.del === 'number' ? f.del : null };
	});
	if (names.length) return _filesBox(q.id, names.length, q.p.v, names, 0, byPath, q.have, true);
	return _filesBox(q.id, q.p.count, q.p.v, q.p.files, q.p.rest || 0, {}, q.have, false);
}

/// The changed-files table for one turn, or null when the text is not the tail note, with the
/// +N −M of the version store folded in where the store holds this version (`box._counted`).
/// Names open the file (openFile); the +N −M loads the version store's diff and folds it in
/// under the row, History-style.
export async function _tailNoteTable(text, chat, prod) {
	var q = _tailNoteParts(text, chat, prod);
	if (!q) return null;
	// The manifest rows for this version: was→hash per file, so the delta
	// comes from the version store, never re-derived from the bytes on disk.
	var ms = [], mv = null;
	try {
		ms = (await DaimondVersions.manifests(q.id)) || [];
		mv = ms.find(function (m) { return m && m.version === q.p.v; }) || null;
	} catch (e) { ms = []; mv = null; }
	var byPath = {}, names = [];
	((mv && mv.files) || []).forEach(function (e) {
		if (e && e.path && !byPath[e.path]) { byPath[e.path] = e; names.push(e.path); }
	});
	if (!mv) _filesNoStore(q.id, q.p.v, ms);
	// The manifest names every file; the note only six and "and N more" (#8).
	var box = names.length ? _filesBox(q.id, names.length, q.p.v, names, 0, byPath, q.have, false)
		: _filesBox(q.id, q.p.count, q.p.v, q.p.files, q.p.rest || 0, byPath, q.have, false);
	box._counted = !!mv;
	return box;
}

/// Say once a version, through the feed, that a Files tile was drawn without its version on this
/// device. A Diamond travels whole, so a device that has the note should have the version too: the
/// tile falls back to the names, and this keeps the fallback from hiding a sync that is behind.
/// A version the store has since pruned (it holds newer ones) is not a fault and says nothing.
var _noStoreSaid = {};
function _filesNoStore(id, v, ms) {
	if (!id || String(id).indexOf('chat:') === 0) return;   // a chat keeps no version store
	var top = 0;
	(ms || []).forEach(function (m) { if (m && m.version > top) top = m.version; });
	if (top > v) return;
	var k = id + '@' + v;
	if (_noStoreSaid[k]) return;
	if (Object.keys(_noStoreSaid).length > 200) _noStoreSaid = {};
	_noStoreSaid[k] = 1;
	dsEvent('files.nostore', { id: String(id), v: v, held: top, dev: String(selfDeviceId() || '').slice(0, 12) });
}

/// Fill a Files tile's body from a tail note: at once from the names the note carries, then again with
/// the counts when the version store answers. Never blank: a note that does not parse is shown as the
/// words it is, so a tile never opens on nothing.
export function _fillFilesTile(tile, text, chat, prod, files) {
	var body = tile.querySelector('.ctile-body');
	if (!body) return;
	var first = _tailNoteNames(text, chat, prod, files);
	if (!first) { body.textContent = text; return; }
	body.replaceChildren(first);
	mountFileRates(first);
	// A row carrying its list has its counts already, and needs no store to be whole.
	if (Array.isArray(files) && files.length) return;
	_tailNoteTable(text, chat, prod).then(function (tbl) {
		if (!tbl || !tbl._counted) return;
		// Only its own list is swapped: a runner turn's lines (`appendYoursTile`) share the body.
		body.replaceChildren.apply(body, [tbl].concat([].filter.call(body.children, function (c) { return c !== first; })));
		mountFileRates(tbl);
	}).catch(function () { /* the names stay */ });
}

/// The Files box: a head, one row a file, and a fold after `_TAIL_MORE` rows. The Diamond's tail
/// note and a chat's `files_log` draw through here, so a row is one drawing. `byPath` holds each
/// row's manifest entry. `still` is a row drawn from its record alone (a chat's), whose delta
/// never asks the version store, so it reads the same on a device that does not hold it (J6).
function _filesBox(id, count, v, names, rest, byPath, have, still) {
	var box = document.createElement('div');
	box.className = 'turn-files';
	var head = document.createElement('div');
	head.className = 'turn-files-head';
	head.textContent = tn('chat.turn_files', count, { n: count });
	box.appendChild(head);
	var rows = document.createElement('div');
	rows.className = 'turn-files-rows';
	var shown = names.slice(0, _TAIL_MORE);
	var restCount = names.length - shown.length;	// held, behind the fold
	shown.forEach(function (name) { rows.appendChild(_turnFileRow(id, name, byPath[name], v, have, still)); });
	// Files the note only counts ("and N more") have no name on this device, so no fold can
	// show them: the count is said as text, never offered as a button with nothing behind it.
	var unknown = null;
	if (rest > 0) {
		unknown = document.createElement('div');
		unknown.className = 'turn-file-rest';
		unknown.textContent = tn('chat.turn_files_rest', rest, { n: rest });
	}
	if (restCount > 0) {
		var more = document.createElement('button');
		more.type = 'button';
		more.className = 'turn-file-more';
		// #22 vision pass: the plural lookup (tn → '.one'/'.other') shows the raw key
		// on screen because only the flat key exists in every catalogue; the flat key is it.
		more.textContent = t('chat.turn_files_more', { n: restCount });
		more.addEventListener('click', function () {
			// Unfold in place: the fold button goes, the remaining rows follow.
			names.slice(_TAIL_MORE).forEach(function (nm) {
				rows.insertBefore(_turnFileRow(id, nm, byPath[nm], v, have, still), more);
			});
			restCount = 0; more.remove();
			mountFileRates(rows);
		});
		rows.appendChild(more);
	}
	if (unknown) rows.appendChild(unknown);
	box.appendChild(rows);
	return box;
}

/// A chat's Files row from the `prod` records of its `files_log`, and nothing else: the path comes
/// from each record's handle and a hash of '' means the file is gone. Null where there is no row.
function _filesLogBox(recs, delta) {
	var names = [], byPath = {}, have = new Set(), store = '', v = 0, cnt = {};
	(Array.isArray(delta) ? delta : []).forEach(function (d) { if (d && typeof d.h === 'string') cnt[d.h] = d; });
	recs.forEach(function (r) {
		var f = window.DaimondRatings ? DaimondRatings.fileOf(r.h) : null;
		if (!f || !f.path) return;
		store = store || f.store; v = v || f.v;
		names.push(f.path); have.add(r.h);
		var c = cnt[r.h];
		byPath[f.path] = { path: f.path, hash: r.hash || '', gone: !r.hash, h: r.h,
			add: c && typeof c.add === 'number' ? c.add : null, del: c && typeof c.del === 'number' ? c.del : null };
	});
	return names.length ? _filesBox(store, names.length, v, names, 0, byPath, have, true) : null;
}

/// Open a changed file from a turn tile, landing on the file whatever its kind.
///
/// The live file is tried first: a store file (`diamonds/…`) and a workspace file
/// under a mounted folder both open editable. A `code/…` workspace path with no
/// folder mounted resolves into OPFS, where it is not, and the live read throws --
/// so on failure the version-store SNAPSHOT this tile is already about is shown
/// read-only. The click therefore always lands on the file, never on nothing.
async function openTurnFile(id, name, hash) {
	try { await Files.open(name, { line: 0 }); return true; }
	catch (liveErr) {
		if (!hash) {
			try { console.warn('Daimond: could not open "' + name + '": '
				+ ((liveErr && liveErr.message) ? liveErr.message : liveErr)); }
			catch (e0) { /* no console */ }
			return false;
		}
		// The live file is not here (a `code/…` path with no folder mounted lands in
		// OPFS, where it is not), so show the version-store SNAPSHOT this tile is about.
		// PROBE the store body first: a BINARY changed file (a PNG, a PDF) is shown
		// through the viewer door by path, never decoded as lossy UTF-8 (S-HAND #4); an
		// editable one takes today's read-only text path.
		var bodyPath = '';
		try { bodyPath = DaimondVersions.bodyPath(id, hash); } catch (e) { bodyPath = ''; }
		var info = null;
		if (bodyPath && window.DaimondViewer && DaimondViewer.probe) {
			try { info = await DaimondViewer.probe(bodyPath, { store: true }); } catch (e) { info = null; }
		}
		if (info && DaimondViewer.editable && !DaimondViewer.editable(info)) {
			try { await Files.view(bodyPath, info, { store: true, label: name }); return true; }
			catch (e2) { /* fall through to the text snapshot / notice */ }
		}
		// Editable, or no probe: the snapshot as read-only text (the pre-#4 path).
		var snap = null;
		try { snap = await DaimondVersions.body(id, hash); }
		catch (e) { snap = null; }
		if (snap != null) {
			try { await Files.open(name, { content: snap, readOnly: true }); return true; }
			catch (e3) { /* fall through to the notice */ }
		}
		try { console.warn('Daimond: could not open "' + name + '": '
			+ ((liveErr && liveErr.message) ? liveErr.message : liveErr)); }
		catch (e4) { /* no console */ }
		return false;
	}
}

/// One file row: the name opens the file in the Doc panel; the delta shows the
/// count and, for an UPDATE, folds the version store's diff in under the row
/// (History's own .hist-diff classes). A NEW file has no before, so its delta
/// opens the file rather than a two-column diff with an empty side.
///
/// `still` is a row drawn from its record alone (a chat's Files row): `e` is `{ path, hash, gone, h }`
/// built from the record (with its `add` and `del`, counted when the record was made), the handle is
/// the record's own, and the delta draws its `+N −M` from it without asking the version store, so the
/// row reads the same where the store is not held (J6). A file that is gone has a minus. A press asks
/// the store, as a Diamond row's does, and finds the diff only where it is held.
function _turnFileRow(id, name, e, v, have, still) {
	var row = document.createElement('div');
	row.className = 'turn-file-row';
	// A press that cannot act answers in the box it is in (the answer rule), never silently.
	function say(text) {
		var box = row.closest ? row.closest('.turn-files') : null;
		if (box && window.DaimondAnswer && DaimondAnswer.note) DaimondAnswer.note(box, text, true);
	}
	// The row's handle is built in, not mounted, so the rows read the same before and after a
	// rating. Only a row the note holds a record for has one (`mountFileRates` dresses those).
	if (have && have.size && window.DaimondProvenance) {
		var fh = still && e && e.h ? e.h : DaimondProvenance.h.file(id, v, name);
		if (have.has(fh)) row.dataset.h = fh;
	}
	var nm = document.createElement('button');
	nm.type = 'button';
	nm.className = 'turn-file-name';
	// The directory and the file's own name in two spans, so a long path gives way in its
	// directory and the part that tells one row from the next stays. `textContent` is the path.
	// A file in this Diamond is shown from its root, so the app's own id is not on screen; the title has the full path.
	var shown = window.DaimondProvenance ? DaimondProvenance.rel(name, id) : name;
	var cut = shown.lastIndexOf('/') + 1;
	if (cut > 0 && cut < shown.length) {
		var nd = document.createElement('span'); nd.className = 'turn-file-dir'; nd.textContent = shown.slice(0, cut);
		var nb = document.createElement('span'); nb.className = 'turn-file-base'; nb.textContent = shown.slice(cut);
		nm.appendChild(nd); nm.appendChild(nb);
	} else nm.textContent = shown;
	nm.title = name;
	nm.addEventListener('click', function (ev) {
		ev.stopPropagation();
		// The opener is `openTurnFile`: it tries the live file (a store path, or a
		// workspace path under a mounted folder) and, when that read fails (a
		// `code/…` path with no folder mounted lands in OPFS, where it is not),
		// falls back to the version-store snapshot this tile is about, read-only.
		// The earlier fix called `Files.open` directly, which threw NotFound for
		// exactly those workspace files and left the click doing nothing. A
		// deletion opens what the file WAS; every other change what it became.
		Promise.resolve(openTurnFile(id, name, e && e.gone ? (e.was || '') : (e && e.hash ? e.hash : '')))
			.then(function (landed) { if (landed === false) say(t('chat.turn_file_nofile')); });
	});
	row.appendChild(nm);
	var de = document.createElement('button');
	de.type = 'button';
	de.className = 'turn-file-delta';
	// was→hash for this file, straight from the manifest: a NEW file has no
	// `was` (all-add), a deleted one has `gone` (all-del), an update has both.
	var was = e && !e.gone && e.was ? e.was : '';
	var now = e && !e.gone ? (e.hash || '') : '';
	de.textContent = '·';
	row.appendChild(de);
	var was = e && !e.gone && e.was ? e.was : '';
	var now = e && !e.gone ? (e.hash || '') : '';
	function paintDelta(d) {
		// #22 live-fix: green additions, red deletions — two spans, one count.
		if (!d) { de.textContent = '·'; return; }
		de.replaceChildren();
		var a = document.createElement('span'); a.className = 'tf-add'; a.textContent = '+' + (d.add || 0);
		var s = document.createElement('span'); s.className = 'tf-del'; s.textContent = '−' + (d.del || 0);
		de.appendChild(a); de.appendChild(s);
	}
	function paintDiff(d) {
		// #22 live-fix: a SIDE-BY-SIDE diff with foldable unchanged runs, not a
		// flat one-line-per-change listing. Left = before (was), right = after
		// (hash); runs of context longer than the fold gap collapse to a bar.
		var wrap = document.createElement('div');
		wrap.className = 'tf-sbs';
		var rows = (d && d.rows) || [];
		// Pair '-' lines with the '+' lines that follow into one side-by-side row.
		var pairs = [], li = 0;
		while (li < rows.length) {
			var r = rows[li];
			if (r.op === '-') {
				var before = r.text, after = null, nj = li + 1;
					while (nj < rows.length && rows[nj].op === '-') { before += '\n' + rows[nj].text; nj++; }
					if (nj < rows.length && rows[nj].op === '+') {
						after = rows[nj].text; var pj = nj + 1;
						while (pj < rows.length && rows[pj].op === '+') { after += '\n' + rows[pj].text; pj++; }
						nj = pj;
					}
				pairs.push({ op: '!', before: before, after: after }); li = nj; continue;
			}
			if (r.op === '+') { pairs.push({ op: '+', before: null, after: r.text }); li++; continue; }
			pairs.push({ op: ' ', before: r.text, after: r.text }); li++;
		}
		var GAP = 3, built = 0, hunk = [];
		pairs.forEach(function (p) {
			if (p.op === ' ') { hunk.push(p); return; }
			built += hunk.length + 1; hunk.forEach(drawPair); hunk = [];
			drawPair(p);
		});
		built += hunk.length; hunk.forEach(drawPair);
		if (built > GAP * 2) wrap.classList.add('tf-sbs-folded');
		function drawPair(p) {
			var line = document.createElement('div');
			line.className = 'tf-sbs-row' + (p.op === '!' ? ' chg' : p.op === '+' ? ' add' : '');
			var L = document.createElement('div'); L.className = 'tf-sbs-cell tf-sbs-l' + (p.op === '!' || p.op === ' ' ? '' : ' empty');
			var R = document.createElement('div'); R.className = 'tf-sbs-cell tf-sbs-r' + (p.op === '+' ? ' add' : '');
			// #22 root-fix: a pure addition (`op '+'`) has its OWN branch. It used
			// to fall into the deletion branch below (the `p.op === '+'` guard),
			// which puts the empty `before` on the LEFT and BLANKS the right cell --
			// so the added text was thrown away and an all-add diff (a new file, or
			// `+N −0`) rendered as a block of empty rows. The added line belongs on
			// the right (add) side; the left stays empty.
			if (p.op === '+') { L.textContent = ''; R.textContent = p.after || ''; R.classList.add('add'); }
			else if (p.after === null) { L.textContent = p.before || ''; L.classList.add('del'); R.textContent = ''; }
			else if (p.op === '!') { L.textContent = p.before || ''; L.classList.add('del'); R.textContent = p.after || ''; R.classList.add('add'); }
			else { L.textContent = p.before || ''; R.textContent = p.after || ''; }
			line.appendChild(L); line.appendChild(R); wrap.appendChild(line);
		}
		return wrap;
	}
	if (still && e && e.gone) {
		// A file that has gone: a minus, and nothing to press (as a Diamond's row reads it).
		de.classList.add('turn-file-delta-none');
		de.textContent = '−';
	} else if (still) {
		// FROM THE RECORD ALONE (J6): the count was made when the row was, so it draws the same where
		// the store is not held. A press does what a Diamond row's does, asking the store only now.
		if (e && typeof e.add === 'number') paintDelta({ add: e.add, del: e.del });
		de.addEventListener('click', async function (ev) {
			ev.stopPropagation();
			var open = row.querySelector('.tf-sbs');
			if (open) { open.remove(); return; }   // a second press folds it away
			// The version before this one is not in the record; the store has it, if it is here.
			var ent = null;
			try {
				var ms = await DaimondVersions.manifests(id);
				var mv = (ms || []).find(function (m) { return m && m.version === v; });
				ent = ((mv && mv.files) || []).find(function (x) { return x && x.path === name; }) || null;
			} catch (err) { ent = null; }
			if (!ent || !ent.hash) { de.textContent = '·'; say(t('chat.turn_file_nocount')); return; }   // not held: no honest count
			if (!ent.was) { openTurnFile(id, name, ent.hash); return; }
			try {
				var d = await DaimondVersions.diff(id, ent.was, ent.hash);
				if (!d) { de.textContent = '·'; return; }
				paintDelta(d);
				row.appendChild(paintDiff(d));
			} catch (err) { /* the store was pruned or the body was not kept: the delta stays as it was */ }
		});
	} else if (was || now) {
		// #22 vision pass: a NEW file (no `was`) never got its all-add count — the
		// auto-paint gate demanded both hashes. The empty `was` is legal to diff
		// (an empty before is an all-add after), so gate on either hash existing.
		de.addEventListener('click', async function (ev) {
			ev.stopPropagation();
			// A NEW file has no "before": a two-column side-by-side with an empty
			// left column rendered as a broken mess (the filename crushed into a
			// narrow column beside a wall of added lines). There is nothing to diff,
			// so open the file itself — exactly what the name does.
			if (now && !was) { openTurnFile(id, name, now); return; }
			var shown = row.querySelector('.tf-sbs');
			if (shown) { shown.remove(); return; }   // a second press folds it away
			try {
				var d = await DaimondVersions.diff(id, was, now);
				if (!d) { de.textContent = '·'; return; }   // binary or not kept: no honest count
				paintDelta(d);
				var sbs = paintDiff(d);
				if (sbs) row.appendChild(sbs);
			} catch (err) { /* the store was pruned or the body was not kept: the delta stays · */ }
		});
		if (now && !was) {
			// A new file: all-add, no press needed. (`was` empty is legal: the Rust
			// side reads an empty before, so the whole after body is additions.)
			DaimondVersions.diff(id, '', now).then(paintDelta).catch(function () { });
		} else if (was && now) {
			// The count is shown without a press on the common path (an update
			// with both bodies kept) — a press then folds the diff in/out.
			DaimondVersions.diff(id, was, now).then(paintDelta).catch(function () { });
		}
	} else {
		de.classList.add('turn-file-delta-none');
		de.textContent = e && e.gone ? '−' : '·';
		// No manifest row here: the version store has not got this version on this device, so
		// there is no count to show and no diff to fold. The press says so.
		if (!e) {
			if (window.DaimondAnswer && DaimondAnswer.gate) DaimondAnswer.gate(de, t('chat.turn_file_nocount'));
			de.addEventListener('click', function (ev) { ev.stopPropagation(); say(t('chat.turn_file_nocount')); });
		}
	}
	return row;
}

/// A chat's Files row: the tile a turn that changed files leaves under its answer, drawn from the
/// records of its `files_log` alone. It is display only (never in the model's context) and it
/// wears the Diamond tail note's own Files tile, rows and rating controls.
export function appendFilesLog(m) {
	var recs = (window.DaimondProvenance && window.DaimondRatings)
		? DaimondProvenance.of(m).filter(function (p) { return p.k === 'file' && DaimondRatings.isFile(p.h); }) : [];
	var box = recs.length ? _filesLogBox(recs, m.delta) : null;
	if (!box) return null;
	var names = [].map.call(box.querySelectorAll('.turn-file-name'), function (n) { return n.title; });
	var tile = buildTile('tool', { who: tOr('chat.who_files', 'Files'), expanded: true, result: true, copy: names.join('\n'), ts: m.ts });
	tile._body.appendChild(box);
	tilePeek(tile, box.querySelector('.turn-files-head').textContent);
	postToChat(tile);
	mountFileRates(box);
	pinBottom();
	return tile;
}

/// The line a turn's file says: made by the turn (UNDO-REACH), his, or one not judged his.
function _yoursKey(y) {
	return y.created ? 'change.made' : (y.unsure ? 'change.file' : 'change.yours');
}

/// "Changed your file <name>" (UNBLOCK-26, his ruling 26 Oct: "Change it, show it, Undo"). A
/// runner turn changes a file of his without asking, having kept it first, so the turn shows
/// each such change as his ask would have, and the runner turn's own Undo under them. Which
/// files were his is the runner's word (`yours`, from its `his` rows), never guessed here.
/// U83-TIDY (D-20261101-48, "the chat ends with the answer and one collapsed files line"): the
/// lines join the turn's own Files tile `into` when there is one, never a second Files tile, and
/// the tile stays folded unless a file of his changed. A file the turn made says its count and
/// shows its text only on a press; one this device cannot compare says where it is kept.
export function appendYoursTile(m, into) {
	var ys = (m && Array.isArray(m.yours)) ? m.yours : [];
	if (!ys.length) return null;
	var box = document.createElement('div');
	box.className = 'turn-yours';
	var names = [], lines = [];
	var open = false;	// a change to a file of his is shown, so the tile is not folded
	var dev = String((m.away && m.away.onName) || '');
	ys.forEach(function (y) {
		if (!y || !y.path) return;
		var at = changeName(y.path);
		var c = (y.change && typeof y.change === 'object') ? y.change : null;
		names.push(at.name);
		var line, quiet = false, press = false;
		if (y.created && c && c.text === false) {
			line = dev ? t('change.kept_on', { name: at.name, device: dev }) : t('change.kept_away', { name: at.name });
			quiet = true;
		} else if (y.created && typeof y.add === 'number') {
			line = tn('change.made_n', y.add, { name: at.name, n: y.add });
			press = true;
		} else {
			line = t(_yoursKey(y), { name: at.name });
			if (!y.created) open = true;
		}
		lines.push(line);
		var head = document.createElement(press ? 'button' : 'div');
		head.className = 'turn-yours-head' + (press ? ' turn-yours-toggle' : '');
		head.textContent = line;
		box.appendChild(head);
		var where = document.createElement('div');
		where.className = 'rail-note pend-change-in';
		where.textContent = t('change.in', { folder: at.folder });
		box.appendChild(where);
		if (quiet) return;
		// A change the runner's record had no room for is still counted.
		var n = ((y.add | 0) + (y.del | 0));
		var ch = c || { text: true, rows: [], more: n };
		if (!press) { changeDiff(box, ch); return; }
		head.type = 'button';
		var shown = null;
		head.addEventListener('click', function (e) {
			if (e && e.stopPropagation) e.stopPropagation();
			if (!shown) { shown = document.createElement('div'); shown.className = 'turn-yours-diff'; changeDiff(shown, ch); where.after(shown); return; }
			shown.hidden = !shown.hidden;
		});
	});
	if (!names.length) return null;
	if (m.away && m.away.run) box.appendChild(histAwayUndo(String(m.away.keeper || ''), { away: m.away, cause: 'turn' }, _turnUndoRows));
	var peek = lines.join(' · ');
	if (into && into._body) {
		into._body.appendChild(box);
		if (!open) into.classList.add('collapsed');
		tilePeek(into, peek);
		pinBottom();
		return into;
	}
	var tile = buildTile('tool', { who: tOr('chat.who_files', 'Files'), expanded: open, result: true, copy: names.join('\n'), ts: m.ts });
	tile._body.appendChild(box);
	tilePeek(tile, peek);
	postToChat(tile);
	pinBottom();
	return tile;
}
