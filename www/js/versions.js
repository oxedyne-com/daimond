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
   `versions_restore_open` names it in `machine[]` and leaves it to
   the fenced door's `file_put_back`, which writes the stored body
   byte for byte under the diamond's own bounds. The engine never
   writes outside the store, and this is where that rule is kept.

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

	/// Mark a path the user's door is ABOUT TO write, keeping what it holds now as the
	/// row's `was` (2026-09-25): a file the store had never seen was recorded as
	/// created, so a Restore to before the edit offered to delete it as "older than
	/// your file". Awaited before the write; it never rejects, and on an engine
	/// without the export it is the plain mark.
	async function dirtyBefore(id, path) {
		if (!id || !path || !ready()) return;
		var a = app();
		if (typeof a.versions_mark_before !== 'function') { dirty(id, path); return; }
		try { await a.versions_mark_before(String(id), String(path)); }
		catch (e) { dirty(id, path); }
	}

	// ── Recorded soon ────────────────────────────────────────────
	//
	// A PAGE'S SAVE IS RECORDED SHORTLY AFTER IT, not at a turn that may never come
	// (D-20261009-29 item 5): a capp logging all day left weeks of appends that no
	// History row held, and a restore ran over them. The mark is in the engine's
	// memory, so it is recorded a quiet spell after the last save, when the person
	// leaves the Diamond, and as the page goes; a restore records whatever is left.

	var SOON_MS = 30000;
	var soon = {};

	/// Record `id`'s marked paths a quiet spell after the last call.
	function recordSoon(id) {
		if (!id) return;
		if (soon[id]) clearTimeout(soon[id]);
		soon[id] = setTimeout(function () { flush(id); }, SOON_MS);
	}

	/// Record `id`'s marked paths now, if any wait. Never rejects.
	async function flush(id) {
		if (!id || !soon[id]) return;
		clearTimeout(soon[id]);
		delete soon[id];
		var a = app();
		if (!a || typeof a.versions_record_dirty !== 'function') return;
		try { await a.versions_record_dirty(String(id)); }
		catch (e) { /* the mark stays; the next turn or restore records it */ }
	}

	window.addEventListener('pagehide', function () {
		Object.keys(soon).forEach(function (id) { flush(id); });
	});

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
			// A TURN THAT RAN ON A RUNNER (RUN-HIST): its files are there, not here, and
			// `away` is where and how long its Undo can reach them. null on every other row.
			row.away = (m.away && typeof m.away === 'object') ? m.away : null;
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
			pruned: prunedRecords(st.pruned),
		};
	}

	/// The engine's prune records (`versions/pruned.json`), newest first, each with
	/// a version list it can be named by. An older engine sends none.
	function prunedRecords(list) {
		if (!Array.isArray(list)) return [];
		return list.filter(function (r) {
			return r && Array.isArray(r.versions) && r.versions.length;
		}).map(function (r) {
			// A renumbering keeps each old number beside its new one; a prune names numbers once.
			var ren = r.on === 'renumber' && Array.isArray(r.to) && r.to.length === r.versions.length;
			var pairs = r.versions.map(function (v, i) { return [Number(v), ren ? Number(r.to[i]) : 0]; })
				.filter(function (p) { return p[0] > 0; })
				.sort(function (a, b) { return a[0] - b[0]; })
				.filter(function (p, i, all) { return !i || p[0] !== all[i - 1][0]; });
			return { ts: +r.ts || 0, on: String(r.on || ''),
				versions: pairs.map(function (p) { return p[0]; }),
				to: ren ? pairs.map(function (p) { return p[1]; }) : [],
				first: +r.first || 0, last: +r.last || 0, bodies: +r.bodies || 0, bytes: +r.bytes || 0 };
		}).sort(function (a, b) { return b.ts - a.ts; });
	}

	/// `[9,10,11,12,13,14,15,18,19]` as `v9-v15, v18, v19` (an en dash): runs collapse, so a
	/// prune of a hundred versions is still one line.
	function versionSpans(vs) {
		var out = [], i = 0;
		while (i < vs.length) {
			var j = i;
			while (j + 1 < vs.length && vs[j + 1] === vs[j] + 1) j++;
			out.push(j > i + 1 ? 'v' + vs[i] + '\u2013v' + vs[j]
				: (j === i + 1 ? 'v' + vs[i] + ', v' + vs[j] : 'v' + vs[i]));
			i = j + 1;
		}
		return out.join(', ');
	}

	/// History as ONE list, newest first: each prune record stands where the newest
	/// version it removed would have stood, so the gap reads in place; a renumbering
	/// stands where it happened. Entries are `{ row }` or `{ prune }`.
	function withPrunes(rows, recs) {
		var out = [], k = 0;
		var at = function (p) { return p.on === 'renumber' ? p.ts : p.last; };
		var ps = (recs || []).slice().sort(function (a, b) { return at(b) - at(a); });
		(rows || []).forEach(function (r) {
			while (k < ps.length && at(ps[k]) >= (r.ts || 0)) out.push({ prune: ps[k++] });
			out.push({ row: r });
		});
		while (k < ps.length) out.push({ prune: ps[k++] });
		return out;
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
	// A restore is OPENED, ACTED ON and CLOSED (2026-09-25, release 5.1's F5 fix
	// and its QA). `versions_restore_open` writes nothing: it names the person's own
	// files -- in the folder they opened, or on the machine -- in `machine[]`, with a
	// ticket. Each goes back through the fenced door under the diamond's current
	// bounds, carrying that ticket, and the door keeps what it replaces or removes AT
	// THE ACT: the person's save since the version, and one made while the question
	// below was open. A mark since withdrawn is refused there, in the fence's own
	// sentence, and the file on disk is untouched. `versions_restore_close` then puts
	// the diamond's own files back and records everything that landed as ONE
	// `restore` version, so what was there is one row up and a restore can itself be
	// restored.

	/// Write back the machine half of a restore, under its ticket. Answers the paths
	/// it refused, to be added to the engine's own list.
	async function writeMachine(id, entries, ticket, isUndo, take) {
		var refused = [];
		if (!(entries || []).length) return refused;
		// THE DIAMOND'S REACH AS IT IS NOW, and not as it was when the file was
		// written: `run_diamond_tool` reads the marks, this device's record of them
		// and the open workspace itself at each call (HIST-SAFE U2), so a mark the
		// user has withdrawn since is refused in the fence's own sentence and the file
		// on disk is untouched. A CHAT'S STORE (`chat:<id>`) goes back through the
		// chat's workspace, and only its holdings travel -- the engine counts each
		// only where this device's record has the press.
		var chat = String(id).indexOf('chat:') === 0 ? String(id).slice(5) : '';
		var holds;
		if (chat) {
			try { holds = DaimondAttach.chatHolds(chat); }
			catch (e) { holds = '[]'; }
		}
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
			return chat
				? eng.run_diamond_tool(String(id), tool, JSON.stringify(args), ticket, holds)
				: eng.run_diamond_tool(String(id), tool, JSON.stringify(args), ticket);
		};
		// HIS ANSWER IS THE ENGINE'S (hist-safe QA A F2, 2026-10-12). Each question's
		// answer is recorded against the bytes he was asked about, and the door refuses an
		// asked file until it holds his yes; a page that skipped the call wrote nothing.
		var answer = async function (list, yes) {
			try {
				await eng.versions_restore_answer(ticket,
					JSON.stringify(list.map(function (x) { return x.path; })), !!yes);
			}
			catch (err) { /* the door refuses each act unanswered */ }
			return yes;
		};
		// A FILE IN THE PERSON'S OWN FOLDER IS NEVER TAKEN AWAY UNASKED (F5, 2026-09-25).
		// A whole-version restore once deleted marked files straight off the open folder
		// under a question that said only "Today's state is kept". A path here that is
		// `gone` is one the store saw being CREATED after the version, so putting the
		// version back would delete it: the person is asked once, naming the files, and
		// nothing is deleted without their yes. Only a file the door can keep a copy of
		// (`kept`: in the open folder, under the size ceiling) is put to them, and the
		// copy is taken as it goes, after their yes -- so a yes is undoable too. One the
		// door could not keep (a hand's path, or past the ceiling) is left where it is
		// and said so.
		// A FILE THE OPEN COULD NOT READ IS LOOKED AT BEFORE ANYTHING IS ASKED (hist-safe,
		// 2026-10-12): one on the machine, through the hand. What stands there now is what
		// the restore's act is bound to, and the engine says whether the person is asked
		// before it goes over it. A look that fails asks. One that found the file there and
		// could not read it is left as it stands and said so (F3): the act would read it
		// again and refuse it as changed, after the person had said yes.
		for (var li = 0; li < (entries || []).length; li++) {
			var le = entries[li];
			if (!le || le.look !== true || le.gone || le.left === true) continue;
			var lr = null;
			try { lr = await run('file_restore_look', { path: le.path }); } catch (err) { lr = null; }
			var seen = (lr && lr.outcome === 'done') ? parse(lr.text, null) : null;
			if (seen && seen.unread === true) { le.unread = true; continue; }
			le.over = !(seen && seen.over === false);
		}
		var gone = (entries || []).filter(function (e) { return e && e.gone && e.kept === true && e.left !== true; });
		var takeGone = gone.length ? await answer(gone, await askGone(gone, isUndo)) : false;
		// A FILE IN THE PERSON'S OWN FOLDER IS NEVER WRITTEN OVER UNASKED EITHER
		// (D-20261009-29 item 6). The engine flags `over` where the bytes there now
		// differ from the version's, and the person is asked once, Keep the default.
		var overs = (entries || []).filter(function (e) {
			return e && e.over === true && !e.gone && !e.skipped && e.left !== true && e.unread !== true;
		});
		var takeOver = overs.length ? await answer(overs, await askTheirs(overs, isUndo)) : true;
		// Decided: the version store before the first write ([`restoreAt`]'s `take`).
		if (take && !(await take())) return refused;
		// A ROW FROM A FOLDER THE ENGINE CANNOT PLACE HERE IS PUT TO THE PERSON (release
		// 5.2's HR, 2026-09-25): one kept before Daimond recorded which folder a file came
		// from, or one recorded in a folder this device does not know -- on another device,
		// moved, or forgotten (HX1) -- whose path holds different bytes now. The door refuses
		// its put-back in the first pass, and the person is asked once for each of the two,
		// after the rest have landed.
		var unplaced = [];
		// A FILE CHANGED SINCE THE PERSON DECIDED ON IT is refused by the door, which reads it
		// at the act (hist-safe R2, 2026-10-12), and put to them once more below, by name.
		var changed = [];
		for (var i = 0; i < (entries || []).length; i++) {
			var e = entries[i];
			var r = null;
			// ANOTHER FOLDER'S FILE IS NOT THIS ONE (HR). The row was written in a folder
			// other than the one its path reaches now -- the browser's storage, a folder
			// opened on this computer, or the machine through a hand -- so the file there
			// is a different file of the same name, and it is left as it stands.
			if (e.left === true) {
				refused.push({ path: e.path, why: tOr('versions.gone_kept', 'Left in your folder') });
				continue;
			}
			if (e.unread === true) {
				refused.push({ path: e.path, why: tOr('versions.unread_now', 'Could not be read now; left as it is') });
				continue;
			}
			try {
				if (e.gone) {
					if (!takeGone || e.kept !== true) {
						refused.push({ path: e.path, why: tOr('versions.gone_kept', 'Left in your folder') });
						continue;
					}
					// The path did not exist at that version, so restoring TO it means
					// taking it away again, through the Diamond's fence.
					r = await run('file_delete', { path: e.path });
				} else if (e.over === true && !takeOver) {
					refused.push({ path: e.path, why: tOr('versions.gone_kept', 'Left in your folder') });
					continue;
				} else if (e.skipped) {
					// A save recorded after its folder closed kept no bytes (HX4): it is in
					// that folder, not too large, and the row says which.
					refused.push({ path: e.path, why: e.skipped === 'folder'
						? tOr('versions.other_folder', 'Saved in another folder; no copy here')
						: tOr('versions.too_big', 'Too large to keep') });
					continue;
				} else {
					// THE STORED BYTES, BY THEIR HASH, and never the text of them (2026-09-25).
					// `file_write` took the body as lossy UTF-8, and turned it into a new document
					// for a `.docx` path, so a person's PNG, PDF or Word file came back corrupt.
					// The door reads the body out of the store and writes it byte for byte; on the
					// machine, whose hand carries text only, bytes that are not text are left.
					r = await run('file_put_back', { path: e.path, hash: e.hash });
				}
			} catch (err) { r = null; }
			if (r && r.outcome !== 'done' && UNPLACED.test(String(r.text || ''))) {
				unplaced.push(Object.assign({}, e, { unknown: UNKNOWN.test(String(r.text || '')) }));
				continue;
			}
			if (r && r.outcome === 'refused' && CHANGED.test(String(r.text || ''))) {
				changed.push(e);
				continue;
			}
			settled(e, r, refused);
		}
		var unknown = unplaced.filter(function (u) { return u.unknown; });
		var unrecorded = unplaced.filter(function (u) { return !u.unknown; });
		var overUnknown = unknown.length ? await answer(unknown, await askOver(unknown, true)) : false;
		var overUnrecorded = unrecorded.length
			? await answer(unrecorded, await askOver(unrecorded, false)) : false;
		if (unplaced.length) {
			for (var k = 0; k < unplaced.length; k++) {
				var u = unplaced[k];
				var over = u.unknown ? overUnknown : overUnrecorded;
				if (!over) {
					refused.push({ path: u.path, why: tOr('versions.gone_kept', 'Left in your folder') });
					continue;
				}
				var ru = null;
				try { ru = await run('file_put_back', { path: u.path, hash: u.hash }); }
				catch (err) { ru = null; }
				settled(u, ru, refused);
			}
		}
		// ONCE MORE, BY NAME, KEEP THE DEFAULT. A yes is bound to what stands there as they
		// are asked; a file changed again after it is left, and said.
		if (changed.length) {
			var again = await answer(changed, await askChanged(changed));
			for (var c = 0; c < changed.length; c++) {
				var ch = changed[c];
				if (!again) {
					refused.push({ path: ch.path, why: tOr('versions.gone_kept', 'Left in your folder') });
					continue;
				}
				var rc = null;
				try {
					rc = ch.gone
						? await run('file_delete', { path: ch.path })
						: await run('file_put_back', { path: ch.path, hash: ch.hash });
				}
				catch (err) { rc = null; }
				settled(ch, rc, refused);
			}
		}
		return refused;
	}

	/// The door's refusal of an act whose file changed since the person decided on
	/// it (`restore_changed_refusal` in src/tools.rs).
	var CHANGED = /changed since you were asked about it/;

	/// The engine's refusal of a second open restore of one Diamond (`claim_restore`
	/// in src/wasm/diamond.rs).
	var BUSY = /A restore of this Diamond is waiting for your answer/;

	/// An engine refusal as the person reads it, through the shared `plainError`.
	/// The engine throws its whole chain (ANSI colour, source frames, error kinds);
	/// the dialog showed the sentence but the API's `why` carried the chain (hist-safe
	/// U3, 2026-10-12), so every `why` a restore returns or asks with is made here.
	function plain(e) {
		var raw = String(e && e.message || e);
		return core() && DaimondCore.plainError ? DaimondCore.plainError(raw) : bare(raw);
	}

	/// Text with the engine's ANSI colour taken out, and nothing else changed.
	function bare(s) { return String(s).replace(/\u001b\[[0-9;]*m/g, ''); }

	/// Ask the person once more whether a restore may write over files that changed
	/// since they were asked, or since the restore opened: by their editor, a
	/// daimon, another tab. Resolves true only on their yes; Keep is the default,
	/// and with no dialog the answer is no.
	///
	/// ONE FILE IS "IT" AND THE BODY SAYS WHAT THE TITLE DOES NOT (hist-safe U3 F3,
	/// 2026-10-12): the body restated the title word for word, said "1 of your files
	/// ... them", and said "since you were asked" of a file no question had named.
	async function askChanged(list) {
		var names = list.map(function (e) { return String(e.path); });
		var shown = names.slice(0, 8).join(', ') + (names.length > 8 ? ', …' : '');
		var one = names.length === 1;
		try {
			if (!core() || !DaimondCore.confirm) return false;
			var yes = await DaimondCore.confirm(
				one
					? tOr('versions.changed_ask.one',
						'{path} changed after this restore began. History keeps its current contents.',
						{ path: names[0] })
					: tOr('versions.changed_ask.other',
						'These changed after this restore began: {paths}. History keeps their current contents.',
						{ n: names.length, paths: shown }),
				one ? tOr('versions.changed_allow.one', 'Replace it')
					: tOr('versions.changed_allow.other', 'Replace them'),
				{ title: one
						? tOr('versions.changed_title.one', 'Replace a changed file?')
						: tOr('versions.changed_title.other', 'Replace {n} changed files?', { n: names.length }),
					danger: true,
					cancelLabel: one ? tOr('versions.changed_keep.one', 'Leave it')
						: tOr('versions.changed_keep.other', 'Leave them'),
					ask: 'restore-changed', guard: true });
			return yes === true;
		} catch (e) { return false; }
	}

	/// Put a refused close's reason to the person: Try again, or Leave it, which
	/// ends the restore with nothing of the Diamond's own files or crystal written.
	/// With no dialog the answer is Leave it.
	async function askRetry(why) {
		try {
			if (!core() || !DaimondCore.confirm) return false;
			var yes = await DaimondCore.confirm(why,
				tOr('versions.close_retry', 'Try again'),
				{ title: tOr('versions.close_title', 'The restore has not finished'),
					cancelLabel: tOr('versions.close_leave', 'Leave it'),
					ask: 'restore-retry' });
			return yes === true;
		} catch (e) { return false; }
	}

	/// The door's refusal of a row it cannot place, over different bytes
	/// (`restore_unplaced_refusal` in src/tools.rs): kept before Daimond recorded
	/// which folder a file came from, or recorded in a folder this device does not
	/// know (`UNKNOWN`).
	var UNPLACED = /recorded which folder it came from|in a folder this device does not know/;
	var UNKNOWN = /in a folder this device does not know/;

	/// What one act left, added to `refused` where it did not land.
	///
	/// A refused tool call RESOLVES, like every other one, so the outcome is what
	/// says whether the bytes went anywhere. Taking the promise for an answer is the
	/// mistake `writeOpenFile`'s own comment records.
	///
	/// THE ROW GETS THE SHORT SENTENCE and the tooltip gets the fence's own. A fence
	/// refusal is a paragraph addressed to a MODEL -- what it may read instead, what
	/// to ask the user for -- and a muted span beside a path is not where a person
	/// reads that. A call that FAILED rather than being refused keeps its own words:
	/// that is not a reach at all, and calling it one would misname a fault. A file
	/// too large to keep a copy of is LEFT by the door, which says so in its own
	/// sentence; the row names it as the other size refusal does. Bytes the machine
	/// hand cannot carry, and a row from another folder than the one its path reaches
	/// now, leave the file where it is, and the row says so in the words a file left
	/// behind is given.
	function settled(e, r, refused) {
		if (r && r.outcome === 'done') return;
		// `said` is the door's own sentence, kept word for word for whoever reads the
		// outcome; `why` is the person's, so a hand's failure (the engine's whole error
		// chain) is put in the shared plainError's words, as every refusal is.
		var said = (r && r.text) ? bare(r.text) : '';
		var why = (r && r.outcome === 'failed' && r.text)
			? plain(said)
			: /bytes Daimond keeps a copy of|larger than the machine hand returns whole/.test(said)
				? tOr('versions.too_big', 'Too large to keep')
				: /carries text only|was written in a different folder/.test(said) || UNPLACED.test(said) || CHANGED.test(said)
					? tOr('versions.gone_kept', 'Left in your folder')
					: /is not on this device/.test(said)
						? tOr('versions.not_here', 'Not on this device')
						: tOr('versions.refused', 'Outside this diamond’s reach');
		refused.push({ path: e.path, why: why, said: said });
	}

	/// Ask the person whether a restore may put back files whose rows cannot be
	/// placed here, over what their paths hold now: kept before Daimond recorded
	/// which folder each came from, or, with `unknown`, recorded in a folder this
	/// device does not know (HX1). Resolves true only on their yes; with no dialog,
	/// the answer is no.
	async function askOver(list, unknown) {
		var names = list.map(function (e) { return String(e.path); });
		var shown = names.slice(0, 8).join(', ') + (names.length > 8 ? ', …' : '');
		try {
			if (!core() || !DaimondCore.confirm) return false;
			var yes = await DaimondCore.confirm(
				unknown
					? tOr('versions.over_ask_unknown',
						'{n} of these files were recorded in a folder on another device, or one Daimond no longer knows: {paths}. The files here may be different ones. Restoring would replace them, and their current contents are kept in History. Replace them?',
						{ n: names.length, paths: shown })
					: tOr('versions.over_ask',
						'Daimond kept {n} of these files before it recorded which folder each came from: {paths}. The files there now may be different ones. Restoring would replace them, and their current contents are kept in History. Replace them?',
						{ n: names.length, paths: shown }),
				tOr('versions.over_allow', 'Replace them'),
				{ title: tOr('versions.over_title', 'Replace files in your folder?'), danger: true,
					cancelLabel: tOr('versions.over_keep', 'Leave my files'),
					ask: 'restore-over', guard: true });
			return yes === true;
		} catch (e) { return false; }
	}

	/// Ask the person whether a restore may delete files from their own folder that
	/// did not exist at the version. Resolves true only on their yes; with no dialog
	/// to ask through, the answer is no.
	///
	/// `isUndo` gives the question its own sentence (UQ, 2026-09-25): an Undo's
	/// question used to borrow the Restore's wording, which says "Restoring it
	/// would delete them" for an act that is not a restore in the person's own
	/// terms. The dialog's `ask` tag and title stay shared -- only the sentence
	/// naming the act differs.
	async function askGone(gone, isUndo) {
		var names = gone.map(function (e) { return String(e.path); });
		var shown = names.slice(0, 8).join(', ') + (names.length > 8 ? ', …' : '');
		try {
			if (!core() || !DaimondCore.confirm) return false;
			var yes = await DaimondCore.confirm(
				isUndo
					? tOr('versions.undo_gone_ask',
						'Undoing this would delete {n} of your files: {paths}. Their current contents are kept in History. Delete them?',
						{ n: names.length, paths: shown })
					: tOr('versions.gone_ask',
						'This version is older than {n} of your files: {paths}. Restoring it would delete them from your folder. Their current contents are kept in History. Delete them?',
						{ n: names.length, paths: shown }),
				tOr('versions.gone_allow', 'Delete them'),
				{ title: tOr('versions.gone_title', 'Delete files from your folder?'), danger: true,
					cancelLabel: tOr('versions.gone_keep', 'Keep them'),
					// Named for a reader that cannot match a translated title, and no key
					// answers it for a second: it can arrive while the person is typing.
					ask: 'restore-gone', guard: true });
			return yes === true;
		} catch (e) { return false; }
	}

	/// Ask the person whether a restore may write over files in their own folder
	/// whose contents differ from the version's. Resolves true only on their yes;
	/// Keep is the default, and with no dialog the answer is no.
	async function askTheirs(list, isUndo) {
		var names = list.map(function (e) { return String(e.path); });
		var shown = names.slice(0, 8).join(', ') + (names.length > 8 ? ', …' : '');
		try {
			if (!core() || !DaimondCore.confirm) return false;
			var yes = await DaimondCore.confirm(
				isUndo
					? tOr('versions.undo_theirs_ask',
						'Undoing this would replace {n} of your files with earlier contents: {paths}. Their current contents are kept in History. Replace them?',
						{ n: names.length, paths: shown })
					: tOr('versions.theirs_ask',
						'Restoring this version would replace {n} of your files with its contents: {paths}. Their current contents are kept in History. Replace them?',
						{ n: names.length, paths: shown }),
				tOr('versions.over_allow', 'Replace them'),
				{ title: tOr('versions.over_title', 'Replace files in your folder?'), danger: true,
					cancelLabel: tOr('versions.over_keep', 'Leave my files'),
					ask: 'restore-theirs', guard: true });
			return yes === true;
		} catch (e) { return false; }
	}

	/// Ask the person whether a restore may delete the Diamond's own files that
	/// the version did not have. Each is named with when it last changed and the
	/// History version that holds it. Resolves true only on their yes; Keep is the
	/// default, and with no dialog the answer is no.
	async function askOwn(own, isUndo, id) {
		var pre = 'diamonds/' + id + '/';
		var named = own.map(function (e) {
			var p = String(e.path);
			if (p.indexOf(pre) === 0) p = p.slice(pre.length);
			var when = Number(e.ts) > 0 ? new Date(Number(e.ts)).toLocaleString() : '';
			return Number(e.v) > 0
				? tOr('versions.own_item', '{path} ({when}, in History as v{v})', { path: p, when: when, v: e.v })
				: p;
		});
		var shown = named.slice(0, 8).join('; ') + (named.length > 8 ? '; …' : '');
		try {
			if (!core() || !DaimondCore.confirm) return false;
			var yes = await DaimondCore.confirm(
				isUndo
					? tOr('versions.undo_own_ask',
						'Undoing this would delete {n} of this Diamond’s files: {paths}. Each stays in History under the version named. Delete them?',
						{ n: named.length, paths: shown })
					: tOr('versions.own_ask',
						'This version is older than {n} of this Diamond’s files: {paths}. Restoring it would delete them. Each stays in History under the version named. Delete them?',
						{ n: named.length, paths: shown }),
				tOr('versions.gone_allow', 'Delete them'),
				{ title: tOr('versions.own_title', 'Delete this Diamond’s newer files?'), danger: true,
					cancelLabel: tOr('versions.own_keep', 'Keep the Diamond’s files'),
					ask: 'restore-own', guard: true });
			return yes === true;
		} catch (e) { return false; }
	}

	/// The undo window a restore opens.
	///
	/// A restore records its own `restore` version, each row carrying what stood
	/// there before it as `was`, so the way back is to put back what THAT version
	/// changed, file by file -- `undoVersion` over the version the restore recorded
	/// and the paths it restored. It restored `res.version` again until 2026-09-25,
	/// which changed nothing. Nothing to commit -- the restore is already on disk.
	function offerUndo(id, res, text) {
		if (!res || res.outcome !== 'restored' || !window.DaimondUndo) return;
		if (!(res.restored || []).length && res.crystal !== 'restored') return;
		if (!(Number(res.recorded) > 0)) return;
		var back = Number(res.recorded), paths = (res.restored || []).slice();
		DaimondUndo.able({
			text: text,
			revert: function () {
				if (!ready()) return;
				undoVersion(id, back, paths);
			},
		});
	}

	/// The call itself, both halves, with no confirm and no toast: the doors below
	/// add what each of them owes. The restore is CLOSED whatever became of its acts,
	/// so every copy they kept is recorded.
	/// # Arguments
	/// * `undo` - The paths of version `n` to undo, which opens its undo instead:
	///   each path back to what `n` replaced there.
	async function restoreAt(id, n, path, undo, folder) {
		var eng = app(id), opened;
		// THE FOLDERS THIS DEVICE KNOWS, AS ITS RECORD STANDS NOW (HK1 of HR's QA round 3,
		// 2026-09-27). The open, its acts and its close ask the engine which rows are another
		// folder's, and the engine held the list from when this tab last opened a folder: a
		// folder picked since in another tab was "one this device cannot name", so its file
		// was offered here under a false sentence and "Replace them" wrote it into this folder.
		try { if (window.DaimondFiles && DaimondFiles.reknow) await DaimondFiles.reknow(); }
		catch (e) { /* the list the engine holds */ }
		try {
			opened = parse(undo
				? await eng.versions_undo_open(String(id), Number(n), JSON.stringify(undo.map(String)))
				: await eng.versions_restore_open(String(id), Number(n), String(path || ''),
					folder ? String(folder) : undefined), null);
		}
		catch (e) {
			// ONE RESTORE OF A DIAMOND AT A TIME (hist-safe R3): another, in this tab or
			// another, is waiting for the person's answer, and this one is refused, said.
			if (BUSY.test(String(e && e.message || e))) {
				if (core() && DaimondCore.toast) {
					DaimondCore.toast(tOr('versions.restore_busy',
						'A restore of this Diamond is waiting for your answer. Answer it first; nothing was changed.'), true);
				}
				return { outcome: 'busy' };
			}
			return { outcome: 'refused', why: plain(e) };
		}
		if (!opened) return { outcome: 'refused', why: '' };
		var refused = [], res = null, keepNew = false, why = null;
		// The close, with every file changed since he decided put to him first.
		var close = async function () {
			var r = parse(await eng.versions_restore_close(String(id), opened.ticket, keepNew), null);
			// THE DIAMOND'S OWN FILES BY THE RULE HIS FOLDER'S GO BY (hist-safe U3 F2,
			// 2026-10-12): one changed since he decided -- another tab's save while a
			// question was open -- is put to him by name, Keep the default, and the
			// engine holds his answer against what stands there now. Nothing of the
			// Diamond's own files is written until every one is answered.
			while (r && (r.changed || []).length) {
				var pre = 'diamonds/' + id + '/';
				var yes = await askChanged(r.changed.map(function (p) {
					p = String(p);
					return { path: p.indexOf(pre) === 0 ? p.slice(pre.length) : p };
				}));
				await eng.versions_restore_answer(opened.ticket, JSON.stringify(r.changed), !!yes);
				r = parse(await eng.versions_restore_close(String(id), opened.ticket, keepNew), null);
			}
			return r;
		};
		// THE STORE IS TAKEN BEFORE THE FIRST WRITE, AND HELD TO THE END (hist-safe U3,
		// lead ruling 2026-10-12). It was taken at the close, after his files were
		// written, so a store another tab held left his files restored and the
		// Diamond's own files and crystal not. Once he has decided, the engine takes
		// it; busy, its reason is put to him before anything is written, Try again
		// asks again, and Leave it ends the restore with nothing changed.
		var left = null;
		var take = async function () {
			for (;;) {
				try { await eng.versions_restore_hold(String(id), opened.ticket); return true; }
				catch (e) {
					var w = plain(e);
					if (!(await askRetry(w))) { left = w; return false; }
				}
			}
		};
		try {
			// THE DIAMOND'S OWN NEWER FILES ARE ASKED ABOUT, KEEP THE DEFAULT
			// (D-20261009-29 item 2): a capp's logs went with no question at all.
			if ((opened.own || []).length) keepNew = !(await askOwn(opened.own, !!undo, id));
			refused = await writeMachine(id, opened.machine || [], opened.ticket, !!undo, take);
		}
		finally {
			if (left === null) {
				try { res = await close(); }
				catch (e) { why = plain(e); }
			}
		}
		if (left !== null) {
			try { await eng.versions_restore_end(String(id), opened.ticket); }
			catch (e) { /* ended already: nothing of it is open */ }
			return { outcome: 'refused', why: left, told: true,
				machine: opened.machine || [], refused: refused };
		}
		// A CLOSE THE ENGINE REFUSED IS NOT A RESTORE (hist-safe U3, QA B B1, 2026-10-12).
		// It was taken for one with nothing in it, called `premigration`, and the page
		// wrote v's crystal over today's files under no word at all. The engine leaves
		// the restore open with nothing of the Diamond's written; its reason is put to
		// him, Try again closes it again, and Leave it ends it.
		while (why !== null) {
			if (!(await askRetry(why))) {
				try { await eng.versions_restore_end(String(id), opened.ticket); }
				catch (e) { /* ended already: nothing of it is open */ }
				return { outcome: 'refused', why: why, told: true,
					machine: opened.machine || [], refused: refused };
			}
			why = null;
			try { res = await close(); }
			catch (e) { why = plain(e); }
		}
		if (!res) return { outcome: 'refused', why: '' };
		res.outcome = 'restored';
		res.machine = opened.machine || [];
		res.refused = (res.refused || []).concat(refused);
		return res;
	}

	/// Put back what one recorded version changed, each file to what that version
	/// replaced: the undo a chat's turn offers (`offerTurnUndo` in daimond.js), and a
	/// restore's toast.
	///
	/// ONE RESTORE, and each path to its own row's `was` (U1 and U4 of the release
	/// 5.1 fix's second QA, 2026-09-25). This restored each path to the version
	/// before, one restore a file: where the person saved a file between two turns,
	/// the Undo of the second put back the FIRST turn's text over their save, and the
	/// Undo of a restore of ten files minted ten versions. A file the version made is
	/// put to the person before it goes, as a whole-version restore's is.
	async function undoVersion(id, n, paths) {
		// No paths is the undo of a restore that put back only the crystal; the engine
		// refuses it for any other version.
		if (!id || !ready() || !(Number(n) > 0) || !Array.isArray(paths)) return null;
		var res = await restoreAt(id, Number(n), '', paths);
		if (res.outcome !== 'restored') return null;
		return { restored: res.restored || [], refused: res.refused || [], recorded: res.recorded };
	}

	/// Restore the WHOLE version: the crystal as it stood, and every file to its
	/// state at `n`. Asks once — it is the only Restore that does, because it moves
	/// everything at once and the per-file one is undoable by toast.
	///
	/// ANSWERS WHAT HAPPENED, BY ITS `outcome` (hist-safe U3 F1, 2026-10-12), never an
	/// overloaded null: `restored`, the files with the crystal and page, whose fate the
	/// engine says in `crystal` (`restored`, `same`, `untouched`), a version kept as
	/// markdown included; `busy`, refused while another restore of the Diamond waits
	/// for an answer, nothing changed and said; `refused` (`why`), nothing of the
	/// Diamond's changed, `told` where the reason was put to him already; `declined`,
	/// the person said no. A caller that took null for "the engine could not" wrote
	/// v's crystal over a refused restore, under "nothing was changed".
	/// # Arguments
	/// * `opts.ask` - `false` where the caller has already asked. The History
	///   panel's whole-version Restore does: two dialogs for one press is one too
	///   many.
	async function restore(id, n, opts) {
		if (!id || !ready()) return { outcome: 'refused', why: '' };
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
		if (!ok) return { outcome: 'declined' };
		var res = await restoreAt(id, n, '');
		offerUndo(id, res, tOr('versions.restored_v', 'Restored v{v}', { v: n }));
		return res;
	}

	/// Restore ONE path. No confirm: the toast is the confirm, and it comes with
	/// the way back.
	/// # Arguments
	/// * `folder` - The folder the chosen row was written in (its `folder`), so
	///   that of two rows of the path at `n` the one pressed is the one put back.
	async function restoreFile(id, path, n, folder) {
		if (!id || !path || !ready()) return null;
		var res = await restoreAt(id, n, String(path), undefined, folder);
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
		// A newline ends a line rather than starting one, as the engine's `line_diff` reads it.
		function lines(t) {
			var s = String(t == null ? '' : t), v = s.split('\n');
			if (s === '' || s.charAt(s.length - 1) === '\n') v.pop();
			return v;
		}
		var a = lines(before);
		var b = lines(after);
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

	// ── The three-way merge ──────────────────────────────────────
	//
	// A capp's page is CODE that its person (or their daimon) may have changed. When
	// the template it came from gets a fix, the fix is brought in AROUND those
	// changes: what moved only in the template is taken, what moved only in the
	// person's copy stays, and a place where both moved differently is a conflict
	// that is SHOWN, never guessed. The person's lines stand at a conflict, so
	// nothing they wrote is lost, and the template's lines there are listed for them.
	//
	// The diff is Myers' O((N+M)·D), not the LCS table above: a capp page is past
	// `DIFF_MAX_LINES` (Life log is ~2,200 lines) and a fork usually differs from its
	// base in a few places, which is exactly where Myers is cheap. The trace it keeps
	// is D² cells, so D is capped and a pair that differs everywhere answers null.

	var MERGE_MAX_EDITS = 2000;

	/// The line arrays of a text. Joining them with '\n' gives the text back exactly.
	function mergeLines(t) { return String(t == null ? '' : t).split('\n'); }

	/// For each line of `a`, the index of the line of `b` it is matched to, or -1.
	/// Null where the two differ by more than `MERGE_MAX_EDITS` lines.
	function lineMatches(a, b) {
		var n = a.length, m = b.length, ma = new Int32Array(n).fill(-1);
		var pre = 0;
		while (pre < n && pre < m && a[pre] === b[pre]) { ma[pre] = pre; pre++; }
		var suf = 0;
		while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) {
			ma[n - 1 - suf] = m - 1 - suf; suf++;
		}
		var N = n - pre - suf, M = m - pre - suf;
		if (N === 0 || M === 0) return ma;
		var max = Math.min(N + M, MERGE_MAX_EDITS), off = max + 1;
		var v = new Int32Array(2 * max + 3), trace = [], D = -1, d, k, x, y;
		for (d = 0; d <= max && D < 0; d++) {
			for (k = -d; k <= d; k += 2) {
				x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]))
					? v[off + k + 1] : v[off + k - 1] + 1;
				y = x - k;
				while (x < N && y < M && a[pre + x] === b[pre + y]) { x++; y++; }
				v[off + k] = x;
				if (x >= N && y >= M) { D = d; break; }
			}
			trace.push(v.slice(off - d, off + d + 1));
		}
		if (D < 0) return null;
		x = N; y = M;
		for (d = D; d > 0; d--) {
			var pv = trace[d - 1];
			k = x - y;
			var down = (k === -d || (k !== d && pv[k - 1 + d - 1] < pv[k + 1 + d - 1]));
			var pk = down ? k + 1 : k - 1;
			var px = pv[pk + d - 1], py = px - pk;
			var sx = down ? px : px + 1;
			while (x > sx && y > sx - k) { x--; y--; ma[pre + x] = pre + y; }
			x = px; y = py;
		}
		while (x > 0 && y > 0) { x--; y--; ma[pre + x] = pre + y; }
		return ma;
	}

	/// `{text, conflicts}`: `theirs`' changes since `base` brought into `mine`, or
	/// null where either side is too far from the base to merge.
	///
	/// Each conflict is `{line, base, mine, theirs}` -- line arrays, and the 1-based
	/// line of `text` where `mine` stands in its place.
	function merge3(base, mine, theirs) {
		var o = mergeLines(base), a = mergeLines(mine), b = mergeLines(theirs);
		var ma = lineMatches(o, a), mb = lineMatches(o, b);
		if (!ma || !mb) return null;
		var out = [], conflicts = [], i = 0, ia = 0, ib = 0;
		function same(x, y) {
			if (x.length !== y.length) return false;
			for (var q = 0; q < x.length; q++) if (x[q] !== y[q]) return false;
			return true;
		}
		for (;;) {
			// The next base line both sides still have: the end of this unstable chunk.
			var k = i;
			while (k < o.length && (ma[k] < 0 || mb[k] < 0)) k++;
			var end = k >= o.length;
			var ea = end ? a.length : ma[k], eb = end ? b.length : mb[k];
			var so = o.slice(i, k), sa = a.slice(ia, ea), sb = b.slice(ib, eb);
			if (same(sa, so))      Array.prototype.push.apply(out, sb);
			else if (same(sb, so)) Array.prototype.push.apply(out, sa);
			else if (same(sa, sb)) Array.prototype.push.apply(out, sa);
			else {
				conflicts.push({ line: out.length + 1, base: so, mine: sa, theirs: sb });
				Array.prototype.push.apply(out, sa);
			}
			if (end) break;
			out.push(o[k]);
			i = k + 1; ia = ea + 1; ib = eb + 1;
		}
		return { text: out.join('\n'), conflicts: conflicts };
	}

	// ── A runner turn's rows, and its Undo (RUN-HIST, 23 Oct) ──────────
	//
	// A turn the asker handed to a runner made its files THERE. The report carries the
	// turn's rows (`turnRec`), recorded here as a version whose manifest has `away`, so
	// History shows the turn on every device. Its Undo is the runner's to do: the page
	// posts `undo-turn` and keeps a mark, which survives a reload, until the runner's
	// `undone` answers it, or the runner's copies expire (`until`).

	var UNDO_KEY = 'daimond.undoTurn.v1';	// run -> { uid, run, on, onName, keeper, asked, until, result? }
	var UNDO_MAX = 200;			// ≤ 1 per carried row, and MANIFESTS_MAX is 200
	// The relay keeps a row a day at most (gateway/src/schema.rs:3444 POST_TTL_MAX_SECS, clamped at
	// gateway/src/handlers/post.rs:512), short of the runner's 7-day keep: an ask older than that
	// is asked again when the runner is seen back (`undoTurnAgain`, on every presence change).
	var RELAY_KEEP_MS = 24 * 3600 * 1000;
	var _carried = [];			// runs recorded this page, so a doubled report records once

	function storeGet() {
		var m = null;
		try { m = window.DaimondStore ? DaimondStore.get(UNDO_KEY, null) : JSON.parse(localStorage.getItem(UNDO_KEY) || 'null'); }
		catch (e) { m = null; }
		return (m && typeof m === 'object') ? m : {};
	}
	function storePut(m) {
		var runs = Object.keys(m);
		if (runs.length > UNDO_MAX) {
			runs.sort(function (a, b) { return (m[a].asked || 0) - (m[b].asked || 0); });
			runs.slice(0, runs.length - UNDO_MAX).forEach(function (r) { delete m[r]; });
		}
		try {
			if (window.DaimondStore) DaimondStore.put(UNDO_KEY, m);
			else localStorage.setItem(UNDO_KEY, JSON.stringify(m));
		} catch (e) { /* the mark is lost with the page; the runner still answers */ }
	}

	/// Record a settling report's turn rows as one version of the keeper. Once per run
	/// on this page (the engine is idempotent by run as well). Answers whether it recorded.
	async function recordCarried(rec) {
		if (!rec || typeof rec !== 'object' || !rec.keeper || !rec.run) return false;
		var run = String(rec.run);
		if (_carried.indexOf(run) >= 0) return false;
		var a = app();
		if (!a || typeof a.versions_record_carried !== 'function') return false;
		_carried.push(run);
		if (_carried.length > UNDO_MAX) _carried.shift();
		try { await a.versions_record_carried(String(rec.keeper), JSON.stringify(rec)); }
		catch (e) { _carried.splice(_carried.indexOf(run), 1); return false; }
		return true;
	}

	/// The mark kept for `run`, or null.
	function undoMark(run) { return storeGet()[String(run || '')] || null; }

	/// Ask the runner that ran `away.run` to undo it. `deps`: `{ by, post(env) -> ok }`,
	/// where `post` seals and posts the envelope. Answers the mark kept, or null when
	/// the ask did not go (nothing is marked, so the row offers the button again).
	async function undoTurn(keeper, away, deps) {
		if (!away || !away.on || !away.run || !deps || !deps.post || !window.DaimondPeer) return null;
		var m = storeGet(), run = String(away.run), was = m[run];
		var mark = {
			uid: (was && was.uid) || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)),
			run: run, on: String(away.on), onName: String(away.onName || ''),
			keeper: String(keeper || ''), asked: Date.now(), until: +away.until || 0,
		};
		var env = DaimondPeer.makeUndo({ uid: mark.uid, to: mark.on, by: deps.by || '', keeper: mark.keeper, run: run });
		var ok = false;
		try { ok = !!(await deps.post(env)); } catch (e) { ok = false; }
		if (!ok) return null;
		m = storeGet(); m[run] = mark; storePut(m);
		return mark;
	}

	/// Ask again, of a runner seen back (`online(id)`), every ask of it still unanswered
	/// and older than the relay keeps a row, so the undo waits for the runner however long
	/// it is away, up to its own `until`. Answers how many were asked again.
	async function undoTurnAgain(deps, online) {
		var m = storeGet(), now = Date.now(), n = 0;
		var runs = Object.keys(m);
		for (var i = 0; i < runs.length; i++) {
			var k = m[runs[i]];
			if (!k || k.result || !(now - (k.asked || 0) > RELAY_KEEP_MS)) continue;
			if (k.until && now > k.until) continue;
			if (!online || !online(k.on)) continue;
			if (await undoTurn(k.keeper, { on: k.on, onName: k.onName, run: k.run, until: k.until }, deps)) n++;
		}
		return n;
	}

	/// A runner's `undone` reached this device. The mark takes the result, and a done
	/// undo is recorded as a version of its own (`versions_record_undone`), whose `away`
	/// is the undo's reference, so History offers "Undo this restore" over the same route.
	/// Answers `{ mark, recorded }`; `mark` null when this device asked nothing for it.
	async function undoneArrived(env) {
		if (!env || env.t !== 'undone' || !env.run) return { mark: null, recorded: false };
		// THE UNDO'S OWN ENTRY is recorded under the keeper the runner names, on whichever
		// device takes the answer: it needs no mark here.
		var recorded = false, a = app();
		if (env.status === 'done' && env.undo && env.keeper && a && typeof a.versions_record_undone === 'function') {
			try { await a.versions_record_undone(String(env.keeper), JSON.stringify(env)); recorded = true; }
			catch (e) { recorded = false; }
		}
		// The mark is the row's state only.
		var m = storeGet(), k = m[String(env.run)];
		if (!k || (env.uid && k.uid && String(env.uid) !== String(k.uid))) return { mark: null, recorded: recorded };
		// The runner keeps its answer a week and says `already` to any later ask, even one
		// made after its first `undone` was taken: the result this row already shows stands.
		if (k.result && k.result.status === 'done' && env.status !== 'done') return { mark: k, recorded: recorded };
		k.result = {
			status: String(env.status || 'error'),
			restored: Array.isArray(env.restored) ? env.restored.map(String) : [],
			removed: Array.isArray(env.removed) ? env.removed.map(String) : [],
			skipped: Array.isArray(env.skipped) ? env.skipped.map(function (x) {
				return { path: String((x && x.path) || x || ''), why: String((x && x.why) || '') };
			}) : [],
			why: env.why ? String(env.why) : '',
			at: Date.now(),
		};
		m[String(env.run)] = k; storePut(m);
		return { mark: k, recorded: recorded };
	}

	/// What a row with `away` shows, as one state (never a silent no-op). `probe`:
	/// `{ online(id) -> true|false, paired(id) -> true|false|null }` (null: not known).
	/// Answers `{ k, mark }`, `k` one of offer, asked, offline, past, unpaired, done,
	/// already, busy, expired, error, or '' when the row has no Undo (nothing was kept).
	function undoState(away, now, probe) {
		if (!away || !away.on || !away.run || !(+away.since > 0)) return { k: '', mark: null };
		var n = now == null ? Date.now() : now, p = probe || {};
		var k = undoMark(away.run);
		if (k && k.result) {
			var st = k.result.status;
			return { k: (st === 'done' || st === 'already' || st === 'busy' || st === 'expired') ? st : 'error', mark: k };
		}
		if (+away.until > 0 && n > +away.until) {
			if (k) { var m = storeGet(); delete m[String(away.run)]; storePut(m); }
			return { k: 'past', mark: null };
		}
		var paired = p.paired ? p.paired(String(away.on)) : null;
		if (paired === false) return { k: 'unpaired', mark: k };
		if (!k) return { k: 'offer', mark: null };
		var online = p.online ? p.online(String(away.on)) : false;
		return { k: online ? 'asked' : 'offline', mark: k };
	}

	window.DaimondVersions = {
		recordCarried: recordCarried,
		undoMark:      undoMark,
		undoTurn:      undoTurn,
		undoTurnAgain: undoTurnAgain,
		undoneArrived: undoneArrived,
		undoState:     undoState,
		merge3:      merge3,
		ready:       ready,
		dirty:       dirty,
		dirtyBefore: dirtyBefore,
		recordSoon:  recordSoon,
		flush:       flush,
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
		versionSpans: versionSpans,
		withPrunes:  withPrunes,
		diff:        diff,
		lineDiff:    lineDiff,
		DIFF_MAX_LINES: DIFF_MAX_LINES,
	};
})();
