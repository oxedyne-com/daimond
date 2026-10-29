// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { Wasm, kindIcon, kindName, markName, noteFolderLost, readBytes } from './wasm.js';
import { crystalBody, diamondTurning, pg } from './state.js';
import { friendlyError, starterTags, t, tn } from './util.js';
import { bumpDiamonds, persistChats, threadStarted, touchChat, touchChatMeta, trashed,
	underTrashedDiamond } from './chatstore.js';
import { deviceId } from './parcel_collect.js';
import { chatHoldingTurn, deviceLabelFor, deviceNameFor, ownsChat, selfDeviceId } from './handoff.js';
import { Files } from './files_view.js';
import { DaimondPanels } from './layout.js';
import { artefactsIn, harvestArtefacts, signalLinksChanged } from './links.js';
import { toast } from './passkey_phrase.js';
import { renderHistory } from './turns.js';
import { chatHoldsJson, confirmDialog, dialog, noticeDialog } from './consent.js';
import { selectChat } from './chats.js';
import { carriedProdBase } from './tilestyle.js';
import { diamondApp, dropTagFilter, loadDiamonds, relTime, tagChip, tagsOf } from './diamonds.js';
import { fmtBytes } from './agentspanel.js';
import { clearCrystalBody, crystalVersionText, isRestoreRow, refreshDiamondAfterChange,
	renderCrystal, renderCrystalControls, showCrystalHistory, turnFileList, turnFileProds } from './crystal.js';
// page-split: end imports

// ── A runner turn's Undo, on its History row (RUN-HIST, 23 Oct) ──────
//
// The files a handed-off turn made are on the runner, so its Undo is asked of the runner
// and the row says where that stands: asked, waiting for the runner, too late, no longer
// a runner, or what the undo did. Never a button that does nothing.

/// Record a settling report's `turnRec` and send the new version on. Fired, not awaited:
/// a report is folded under the mailbox lock, which no network wait may hold. Where the
/// engine recorded a version (`{version, files, note}`), the turn gets the Files row a Here
/// turn gets and the runner's session the tail note (RT-C); `{}` (recorded already, by run,
/// as on a second device) builds nothing, and the row comes by sync. Answers its promise.
export function recordCarriedTurn(rec, report) {
	if (!window.DaimondVersions || !DaimondVersions.recordCarried) return null;
	return DaimondVersions.recordCarried(rec).then(function (said) {
		if (!said) return;
		if (window.DaimondSync && DaimondSync.flush) DaimondSync.flush().catch(function () {});
		if (histOpenFor(rec.keeper)) showCrystalHistory();
		if (!(said.version > 0)) return;
		var chat = chatHoldingTurn(rec.turnId);
		if (!chat) return;
		return carriedFilesRow(chat, rec, said).then(function (row) {
			// The tail note onto the session the report stored (invariant 8), as the Here
			// session takes it; once.
			var s = chat.session, rs = report && report.session, note = said.note, told = false;
			if (note && note.content && s && Array.isArray(s.msgs) && rs
				&& String(s.upto || '') === String(rs.upto || '')) {
				var tail = s.msgs[s.msgs.length - 1];
				if (!tail || tail.role !== note.role || tail.content !== note.content) { s.msgs.push(note); told = true; }
			}
			if (!row && !told) return;
			touchChat(chat);
			persistChats();
			if (row && ownsChat(chat)) renderHistory(chat.messages);
			// The flush above went before the row was made: the row goes out now, so the
			// other devices draw it from this parcel rather than the next one.
			if (row && window.DaimondSync && DaimondSync.flush) DaimondSync.flush().catch(function () {});
		});
	}).catch(function () { /* the next report of the run, or none: the rows are only History */ });
}

/// The Files row of a runner's turn, `<run>-files`, as the Here turn's end makes it: a chat
/// keeper's `files_log` (`filesLogOf`), a Diamond keeper's `user` row with the tail note, its
/// `prod` and `files` (the turn's end). Credited to the runner device; the line counts come
/// from the turnRec, as this device holds no bodies. Placed before `<run>-end`, else after the
/// turn's last row. Answers the row, or null where it is held already or nothing is credited.
async function carriedFilesRow(chat, rec, said) {
	var store = String(rec.keeper || ''), v = Number(said.version), turnId = String(rec.turnId || '');
	var mid = String(rec.run) + '-files';
	if ((chat.messages || []).some(function (m) { return m && m.mid === mid; })) return null;
	var isChat = store.indexOf('chat:') === 0;
	var counts = {};
	(rec.files || []).forEach(function (f) {
		if (f && f.path && !f.gone && (typeof f.add === 'number' || typeof f.del === 'number'))
			counts[f.path] = { add: f.add || 0, del: f.del || 0 };
	});
	// Credited as the Here turn credits its files: to the turn's author, its prodBase, never the
	// runner's own name for its seat (RT-D1 finding B).
	var prod = await turnFileProds(store, v, chat.id, turnId, isChat ? '' : undefined, null, String(rec.on || ''),
		carriedProdBase(chat, rec.run));
	var row;
	if (isChat) {
		if (!prod.length) return null;
		var delta = Object.keys(counts).map(function (p) {
			return { h: DaimondProvenance.h.file(store, v, p), add: counts[p].add, del: counts[p].del };
		});
		row = { role: 'files_log', mid: mid, iturn: turnId, ts: 0, prod: prod, delta: delta };
	} else {
		if (!said.note || !said.note.content) return null;
		var files = await turnFileList(store, v);
		files.forEach(function (f) {
			var c = counts[f.path];
			if (c && !f.gone && f.add === undefined) { f.add = c.add; f.del = c.del; }
		});
		row = { role: 'user', content: said.note.content, mid: mid, iturn: turnId, ts: 0 };
		if (prod.length) row.prod = prod;
		if (files.length) row.files = files;
	}
	// UNBLOCK-26: the files of his the turn changed, which the runner kept first and marks `his`,
	// each with its change, and the turn's away Undo as History offers it.
	// A file kept first whose authorship the runner could not judge (`unsure`) is shown, but never
	// as his.
	var yours = (rec.files || []).filter(function (f) {
		return f && (f.his === true || f.unsure === true) && !f.created && f.path;
	})
		.map(function (f) {
			var y = { path: String(f.path) };
			if (f.his !== true) y.unsure = true;
			if (typeof f.add === 'number') y.add = f.add;
			if (typeof f.del === 'number') y.del = f.del;
			if (f.change && typeof f.change === 'object') y.change = f.change;
			return y;
		});
	if (yours.length) {
		row.yours = yours;
		row.away = { keeper: store, on: String(rec.on || ''), onName: String(rec.onName || ''), run: String(rec.run),
			since: Number(rec.since) || 0, until: Number(rec.until) || 0 };
	}
	// THE TRANSCRIPT AS IT IS NOW, NOT AS IT WAS (UNBLOCK-46). The awaits above outlast a
	// final frame's adoption and the placeholder's drop, each of which puts a NEW array on
	// `chat.messages`; a row spliced into the array read before them went with the old one,
	// and the Files tile was never the chat's. Held meanwhile: the first one in keeps it.
	var ms = chat.messages || (chat.messages = []);
	if (ms.some(function (m) { return m && m.mid === mid; })) return null;
	var end = -1, last = -1;
	for (var i = 0; i < ms.length; i++) {
		var m = ms[i];
		if (!m) continue;
		if (m.mid === String(rec.run) + '-end') end = i;
		if (m.mid === turnId || m.iturn === turnId) last = i;
	}
	// UNDER ITS ANSWER, as a Here turn's (UNBLOCK-56): past every row of the turn but its end, since
	// a merge orders by (ts, mid) and `-files` sorts before `-final` on a tie. A runner stamps its
	// end a millisecond after its answer, so `end - 1` was the answer's own time.
	var ts = 0;
	for (var k = 0; k < ms.length; k++) {
		var r = ms[k];
		if (r && k !== end && (r.mid === turnId || r.iturn === turnId) && +r.ts > ts) ts = +r.ts;
	}
	ts = ts ? ts + 1 : (rec.ts || Date.now());
	row.ts = ts;
	if (end >= 0 && !(ts < (+ms[end].ts || 0))) end += 1;		// on or past the end's time: after it
	if (end >= 0) ms.splice(end, 0, row);
	else if (last >= 0) ms.splice(last + 1, 0, row);
	else ms.push(row);
	return row;
}

/// The live History rows with an Undo of a runner turn, by run, so an answer redraws its row;
/// and the chat's "Changed your file" tiles with the same Undo (UNBLOCK-26), which History's
/// redraw does not clear.
export var _histUndoRows = new Map();
export var _turnUndoRows = new Map();
// page-split: install 120

/// Is History open on `keeper` now, so a version recorded for it should be drawn?
function histOpenFor(keeper) {
	return !!(pg.currentDiamond && pg.currentDiamond.id === String(keeper || '')
		&& pg._histList && pg._histList.isConnected);
}

/// A runner's `undone` reached this device: keep the result, record the undo's own
/// version, and redraw the row that asked.
export async function undoneFromRunner(env) {
	var got = { mark: null, recorded: false };
	try { got = await DaimondVersions.undoneArrived(env); } catch (e) { return; }
	if (got.recorded && window.DaimondSync && DaimondSync.flush) DaimondSync.flush().catch(function () {});
	[_histUndoRows, _turnUndoRows].forEach(function (rows) {
		var draw = rows.get(String(env.run || ''));
		if (draw) { try { draw(); } catch (e) { /* the next drawing shows it */ } }
	});
	if (got.recorded && histOpenFor(env.keeper)) {
		try { showCrystalHistory(); } catch (e) { /* the panel's next open shows the undo's entry */ }
	}
}

/// How an undo-turn is sent: sealed to the account and put in the post box.
export function undoTurnDeps() {
	return {
		by: selfDeviceId(),
		// An undo is refused while its keeper's turn runs, Here and away alike (QA-A LOW-1).
		busy: function (keeper) { return diamondTurning(keeper); },
		post: async function (env) {
			var body = await DaimondPeer.sealForSelf(env);
			var r = await DaimondPost.post(body);
			return !!(r && r.ok);
		},
	};
}

/// Is runner `id` awake, and is it still one of this account's devices (null: not known)?
export function undoTurnProbe() {
	return {
		online: function (id) {
			try {
				return !!(window.DaimondPresence && DaimondPresence.awake(selfDeviceId())
					.some(function (p) { return p.deviceId === id; }));
			} catch (e) { return false; }
		},
		paired: function (id) {
			try {
				if (!window.DaimondPresence || DaimondPresence.unknown()) return null;
				var snap = DaimondPresence.snapshot();
				return snap ? !!snap[id] : null;
			} catch (e) { return null; }
		},
	};
}

/// The Undo of a runner turn (or of the undo itself), drawn into `box` as one state.
export function histAwayUndo(id, r, rows) {
	var away = r.away, box = document.createElement('div'), live = rows || _histUndoRows;
	box.className = 'hist-away';
	var runner = String(away.onName || deviceNameFor(away.on) || t('devices.another'));
	var label = r.cause === 'restore' ? 'versions.undo_restore' : 'versions.undo_turn';
	var said = '';		// a one-off line from the last press (not sent)
	var draw = function () {
		box.replaceChildren();
		var st = DaimondVersions.undoState(away, Date.now(), undoTurnProbe());
		if (!st.k) { live.delete(String(away.run)); return; }
		var line = function (key, v) {
			var p = document.createElement('div');
			p.className = 'hist-note hist-away-state';
			p.textContent = t(key, Object.assign({ runner: runner }, v || {}));
			box.appendChild(p);
		};
		var button = function (key, fn) {
			var b = document.createElement('button');
			b.className = 'crystal-act hist-undo-turn';
			b.textContent = t(key);
			b.addEventListener('click', fn);
			box.appendChild(b);
		};
		var ask = async function () {
			// As the Here row's "Undo this restore": not while the Diamond's turn runs,
			// which could be writing the very files the runner is asked to put back.
			if (diamondTurning(id)) {
				var f = pg.diamonds.find(function (x) { return x.id === id; }) || {};
				noticeDialog(t('fold.busy_title'), t('fold.busy_body', { diamond: f.name || '' }));
				return;
			}
			said = '';
			var mark = await DaimondVersions.undoTurn(id, away, undoTurnDeps());
			if (!mark) said = 'versions.undo_not_sent';
			draw();
		};
		var res = st.mark && st.mark.result;
		if (said) line(said);
		if (st.k === 'offer') button(label, ask);
		else if (st.k === 'asked' || st.k === 'offline') {
			line(st.k === 'asked' ? 'versions.undo_asked' : 'versions.undo_offline');
		} else if (st.k === 'past') line('versions.undo_past');
		else if (st.k === 'unpaired') line('versions.undo_unpaired');
		else if (st.k === 'done') {
			line('versions.undo_done', { n: res.restored.length, m: res.removed.length });
			if (res.skipped.length) {
				line('versions.undo_skipped', { list: res.skipped.map(function (x) { return shownPath(id, x.path); }).join(', ') });
			}
		} else if (st.k === 'already') line('versions.undo_already');
		else if (st.k === 'expired') line('versions.undo_expired');
		else if (st.k === 'busy') { line('versions.undo_busy'); button(label, ask); }
		else { line('versions.undo_error', { why: (res && res.why) || t('versions.undo_no_why') }); button(label, ask); }
	};
	live.set(String(away.run), draw);
	draw();
	return box;
}

/// Where a runner turn's commands reached the network (U8h HISTORY-NET): one line per
/// destination the runner's proxy logged, in plain words, and "and N more" past the rows it
/// sent. Null where the turn reached none. Nothing to press: it only says what happened.
function histAwayNet(away) {
	var net = (away && Array.isArray(away.net)) ? away.net : [];
	var more = (away && +away.netMore > 0) ? +away.netMore : 0;
	if (!net.length && !more) return null;
	var box = document.createElement('div');
	box.className = 'hist-net';
	var line = function (text) {
		var p = document.createElement('div');
		p.className = 'hist-note hist-net-row';
		p.textContent = text;		// escaped via textContent (H5)
		box.appendChild(p);
	};
	net.forEach(function (d) {
		if (!d || !d.host) return;
		var host = String(d.host);
		if (d.v === 'registry') line(t('versions.net_registry', { host: host, size: fmtBytes(+d.down || 0) }));
		else if (d.v === 'outside') line(t('versions.net_outside', { host: host }));
		else if (d.v === 'refused') line(t('versions.net_refused', { host: host, port: +d.port || 0,
			why: String(d.why || t('versions.net_no_why')) }));
	});
	if (more) line(t('versions.net_more', { n: more }));
	return box;
}

/// One version: what it was, what it changed, and the two ways back.
///
/// `newer` is the row above it, so the state a restore replaced says so.
export function histRow(id, r, files, newer) {
	var v = r.v;
	var row = document.createElement('div');
	row.className = 'hist-row';

	var head = document.createElement('div');
	head.className = 'hist-head';
	var ver = document.createElement('span');
	ver.className = 'hist-ver';
	ver.textContent = 'v' + v;
	var kind = document.createElement('span');
	kind.className = 'hist-kind';
	// The MANIFEST's own word where there is one -- `turn`, `user`, `save`,
	// `fold`, `restore`, `share` -- because it says what caused the version,
	// which is what a reader walking the list is looking for. The log record's
	// `kind` where there is not.
	kind.textContent = r.cause || r.kind || 'change';
	var when = document.createElement('span');
	when.className = 'hist-when';
	when.textContent = r.ts ? relTime(r.ts) : '';
	head.appendChild(ver); head.appendChild(kind); head.appendChild(when);
	row.appendChild(head);
	// THE STATE A RESTORE REPLACED says so (D-20261009-29 item 3): it read as one
	// more save, and the person looking for what they had before the restore had
	// to work out which row it was.
	if (isRestoreRow(newer)) {
		var before = document.createElement('div');
		before.className = 'hist-before-restore';
		before.textContent = t('versions.before_restore', { when: newer.ts ? relTime(newer.ts) : '' });
		row.appendChild(before);
	}
	// What the version WAS. Every record has carried a note since folds were
	// written and the list showed none of them, so a history of a busy Diamond
	// read as a column of "fold, fold, fold, edit" — the versions were all
	// there and none of them said anything about itself.
	if (r.note) {
		var note = document.createElement('div');
		note.className = 'hist-note';
		note.textContent = r.note;             // escaped via textContent (H5)
		row.appendChild(note);
	}

	// ── What this version did to the FILES ───────────────────────
	//
	// Collapsed to a count, because most versions changed one or two files and a
	// list of them under every row would bury the version numbers the panel is
	// for. Expanded once, on the press, and left open.
	if (files && (r.files || []).length) {
		var block = document.createElement('div');
		block.className = 'hist-files';
		var chip = document.createElement('button');
		chip.className = 'hist-files-n';
		chip.textContent = tn('versions.files_n', r.files.length, { n: r.files.length });
		var drawn = false;
		chip.addEventListener('click', function () {
			if (drawn) { block.classList.toggle('open'); return; }
			drawn = true;
			block.classList.add('open');
			r.files.forEach(function (e) { block.appendChild(histFile(id, v, e)); });
		});
		row.appendChild(chip);
		row.appendChild(block);
		if (r.truncated) {
			var more = document.createElement('div');
			more.className = 'hist-note';
			more.textContent = tn('versions.files_n', r.truncated, { n: r.truncated });
			row.appendChild(more);
		}
	}
	// WHERE A RUNNER TURN REACHED THE NETWORK (U8h), under its files: what it downloaded,
	// what outside content turned its later commands offline, and what was blocked.
	var net = r.away ? histAwayNet(r.away) : null;
	if (net) row.appendChild(net);

	var acts = document.createElement('div');
	acts.className = 'hist-acts';
	var view = document.createElement('button');
	view.className = 'crystal-act hist-view';
	view.textContent = t('crystal.view');
	view.addEventListener('click', async function () {
		var was = '';
		try { was = await diamondApp().read_version(pg.currentDiamond.id, v); }
		catch (e) { noticeDialog(t('crystal.read_version_failed'), friendlyError(e)); return; }
		noticeDialog(t('crystal.at_version', { v: v }),
			crystalVersionText(was) || t('crystal.empty_paren'), { pre: true });
	});
	var revert = document.createElement('button');
	revert.className = 'crystal-act hist-restore';
	revert.textContent = t('crystal.restore');
	revert.addEventListener('click', function () { restoreWholeVersion(id, v); });
	acts.appendChild(view); acts.appendChild(revert);
	// A RESTORE IS UNDONE AS ONE (D-20261009-29 item 1): the crystal and every
	// file it put back go back to what it replaced, in one version of its own,
	// which can itself be undone.
	// A TURN THAT RAN ON A RUNNER is undone there (RUN-HIST): its files are not on this
	// device, so the local undo below would put back nothing.
	if (r.away) acts.appendChild(histAwayUndo(id, r));
	else if (files && isRestoreRow(r)) {
		var undo = document.createElement('button');
		undo.className = 'crystal-act hist-undo-restore';
		undo.textContent = t('versions.undo_restore');
		undo.addEventListener('click', async function () {
			if (diamondTurning(id)) {
				var f = pg.diamonds.find(function (x) { return x.id === id; }) || {};
				noticeDialog(t('fold.busy_title'), t('fold.busy_body', { diamond: f.name || '' }));
				return;
			}
			await DaimondVersions.undoVersion(id, v, (r.files || []).map(function (e) { return e.path; }));
			await refreshDiamondAfterChange();
			showCrystalHistory();
		});
		acts.appendChild(undo);
	}
	// A fold retains the raw delta it consumed, in a file the log record
	// points at by `delta_ref`. It was kept but never shown, so the audit
	// trail was write-only; a Delta button now reads that file back.
	if (r.delta_ref) {
		var dref = r.delta_ref;
		var seeDelta = document.createElement('button');
		seeDelta.className = 'crystal-act';
		seeDelta.textContent = t('crystal.delta');
		seeDelta.title = t('crystal.delta_help');
		seeDelta.addEventListener('click', async function () {
			var d = '';
			try { d = await readBytes(dref); }
			catch (e) { noticeDialog(t('crystal.read_delta_failed'), friendlyError(e)); return; }
			noticeDialog(t('crystal.delta_at', { v: v }), d || t('crystal.empty_paren'), { pre: true });
		});
		acts.appendChild(seeDelta);
	}
	row.appendChild(acts);
	return row;
}

/// A version row's path, as the person reading it knows the file.
///
/// Relative to the diamond for its own files; unchanged for a file in a folder
/// the user marked in, which is already spelled the way their own file manager
/// spells it. The store's key is kept on the row's `dataset.path` and in the
/// tooltip, because that is what a restore is asked for.
function shownPath(id, path) {
	var own = 'diamonds/' + id + '/';
	return path.indexOf(own) === 0 ? path.slice(own.length) : path;
}

/// One file inside a version: its path, what it cost in lines, and the way back.
///
/// The row is drawn at once and the two buttons are settled asynchronously,
/// because whether a body is on THIS device is a read (contract §10) and a panel
/// that waited for one read per file before drawing anything would be a panel
/// that looked broken on a version that touched forty of them.
function histFile(id, v, e) {
	var row = document.createElement('div');
	row.className = 'hist-file';
	row.dataset.path = e.path;                 // the store's own spelling, which is what a restore needs
	var p = document.createElement('span');
	p.className = 'hist-file-path';
	// THE PATH AS THE PERSON KNOWS IT, not as the store keys it. Every file of
	// the diamond's own is under `diamonds/<id>/`, so printing that prefix on
	// forty rows says nothing forty times and pushes the name that matters off
	// a phone. A marked file is already the path in the folder they opened.
	p.textContent = shownPath(id, e.path);     // escaped via textContent (H5)
	p.title = e.path;
	row.appendChild(p);
	if (e.mark) {
		// A file on the user's own machine, said beside its path: the same fact
		// the foot says once for the panel, said where it applies.
		var mk = document.createElement('span');
		mk.className = 'hist-file-mark';
		mk.textContent = t('versions.on_machine');
		row.appendChild(mk);
	}
	var delta = document.createElement('span');
	delta.className = 'hist-file-delta';
	row.appendChild(delta);
	var view = document.createElement('button');
	view.className = 'crystal-act hist-file-view';
	view.textContent = t('crystal.view');
	var restore = document.createElement('button');
	restore.className = 'crystal-act hist-file-restore';
	restore.textContent = t('versions.restore_file');
	var why = document.createElement('span');
	why.className = 'hist-file-why';
	row.appendChild(view); row.appendChild(restore);
	// WHAT THIS VERSION REPLACED, put back (D-20261009-29 item 4): Restore puts
	// the file back as the version left it, and a changed file's earlier text
	// had no button at all.
	var before = null;
	if (e.was && !e.gone) {
		before = document.createElement('button');
		before.className = 'crystal-act hist-file-before';
		before.textContent = t('versions.restore_before');
		row.appendChild(before);
	}
	row.appendChild(why);

	/// Refuse both buttons, and say which of the three reasons it is.
	function refuse(text) {
		view.disabled = true;
		restore.disabled = true;
		if (before) before.disabled = true;
		why.textContent = text;
	}
	// Too large to have kept a body at all: the manifest says the file changed
	// and there is nothing to compare or to put back (contract §3).
	if (e.skipped === 'size') { refuse(t('versions.too_big')); return row; }
	// Saved in a folder that was closed by the time it was recorded (HX4).
	if (e.skipped === 'folder') { refuse(t('versions.other_folder')); return row; }
	if (e.skipped) { refuse(t('versions.not_here')); return row; }
	// THE BODY THIS ROW DEPENDS ON. A deletion is restored from what the file
	// WAS; every other change from what it became.
	var need = e.gone ? e.was : e.hash;
	if (need) {
		DaimondVersions.body(id, need).then(function (b) {
			if (b === null) refuse(t('versions.not_here'));
		});
	}
	view.addEventListener('click', async function () {
		var shown = row.querySelector('.hist-diff');
		if (shown) { shown.remove(); return; }      // a second press folds it away
		var d = await DaimondVersions.diff(id, e.was || '', e.hash || '');
		// THREE WAYS THERE IS NO HONEST ANSWER, and the engine refuses all three
		// alike: a binary body, a body this device has not got, and a file past
		// the line cap. Said as one sentence rather than three, because what the
		// reader can do about it is the same in each case -- nothing.
		if (!d) {
			noticeDialog(t('versions.at_v', { name: e.path, v: v }), t('versions.cannot_compare'));
			return;
		}
		var pre = document.createElement('div');
		pre.className = 'hist-diff';
		(d.rows || []).forEach(function (l) {
			var ln = document.createElement('div');
			ln.className = 'hist-diff-line' + (l.op === '+' ? ' add' : l.op === '-' ? ' del' : '');
			ln.textContent = l.text;     // escaped via textContent (H5); the op is drawn by the role
			pre.appendChild(ln);
		});
		delta.textContent = '+' + (d.add || 0) + ' −' + (d.del || 0);
		row.appendChild(pre);
	});
	restore.addEventListener('click', async function () {
		if (diamondTurning(id)) {
			var f = pg.diamonds.find(function (x) { return x.id === id; }) || {};
			noticeDialog(t('fold.busy_title'), t('fold.busy_body', { diamond: f.name || '' }));
			return;
		}
		// A DELETION'S ROW PUTS THE FILE BACK AS IT WAS (D-20261009-29 item 4): the
		// state at the version is "gone", so restoring to it did nothing.
		if (e.gone) { await putBack(); return; }
		// This row, by its folder too: one path can have a row from two places at
		// one version, and the one pressed is the one put back (HX3).
		var res = await DaimondVersions.restoreFile(id, e.path, v, e.folder || '');
		// THE FENCE'S OWN WORDS, in the row. A mark since withdrawn, or a path
		// the fence no longer covers, is refused where the user pressed rather
		// than in a dialog that says nothing about which file (contract §6).
		var ref = res && (res.refused || []).find(function (x) { return x.path === e.path; });
		if (ref) {
			why.textContent = ref.why || t('versions.refused');
			why.title = ref.said || '';         // the fence's whole sentence, a hover away
			return;
		}
		why.textContent = '';
		await refreshDiamondAfterChange();
	});

	/// Put back what this version replaced at this path: its `was`, or the file
	/// it deleted.
	async function putBack() {
		if (diamondTurning(id)) {
			var f = pg.diamonds.find(function (x) { return x.id === id; }) || {};
			noticeDialog(t('fold.busy_title'), t('fold.busy_body', { diamond: f.name || '' }));
			return;
		}
		var res = await DaimondVersions.undoVersion(id, v, [e.path]);
		var ref = res && (res.refused || []).find(function (x) { return x.path === e.path; });
		if (ref) {
			why.textContent = ref.why || t('versions.refused');
			why.title = ref.said || '';
			return;
		}
		why.textContent = '';
		await refreshDiamondAfterChange();
	}
	if (before) before.addEventListener('click', putBack);
	return row;
}

/// What the versions do NOT cover, said once under the list (contract §5).
export function histFoot(g) {
	var foot = document.createElement('div');
	foot.className = 'hist-foot';
	// KEEP-ALL until KEEP-RULE: nothing is pruned, so past the limit History says it keeps growing.
	var over = g && ((g.cap && g.used > g.cap)
		|| (g.manifests_cap && g.manifests > g.manifests_cap));
	if (over) {
		var lim = document.createElement('span');
		lim.className = 'hist-limit';
		lim.textContent = t('versions.limit_note');
		foot.appendChild(lim);
	}
	var head = document.createElement('span');
	head.className = 'hist-foot-head';
	head.textContent = t('versions.on_machine');
	var note = document.createElement('span');
	note.textContent = t('versions.machine_note');
	var more = document.createElement('button');
	more.className = 'crystal-act';
	more.textContent = t('topbar.guide');
	more.addEventListener('click', function () {
		if (window.DaimondWeb && DaimondWeb.guide) DaimondWeb.guide('chats-and-diamonds.html');
		else window.open('guide/chats-and-diamonds.html', '_blank');
	});
	foot.appendChild(head); foot.appendChild(note); foot.appendChild(more);
	return foot;
}

/// Restore a whole version: the crystal as it stood, and every file with it.
///
/// ONE CONFIRM, and it is the only Restore in this panel that asks. A per-file
/// restore is undoable by its own toast; this one moves everything at once, so
/// the sentence names what is kept -- today's state, as a version of its own.
///
/// THE ENGINE PUTS BACK ALL OF IT, in the one version the restore records
/// (D-20261009-29 item 1; hist-safe U3, QA B B2, 2026-10-12): the files, the
/// crystal and the page, a version kept as markdown converted as the migration
/// converts one. The page wrote the crystal itself wherever the engine's answer
/// lacked one, and a refused close lacked one too, so v's crystal went over
/// today's files under no word. Nothing here writes a crystal.
async function restoreWholeVersion(id, v) {
	if (diamondTurning(id)) {
		var f = pg.diamonds.find(function (x) { return x.id === id; }) || {};
		noticeDialog(t('fold.busy_title'), t('fold.busy_body', { diamond: f.name || '' }));
		return;
	}
	if (!(window.DaimondVersions && DaimondVersions.ready())) {
		noticeDialog(t('crystal.restore_failed'), '');
		return;
	}
	var ok = await confirmDialog(
		t('versions.restore_ask', { v: v }),
		t('crystal.restore_v', { v: v }),
		{ title: t('crystal.restore_title'), danger: false });
	if (!ok) return;
	// Asked once, up there, and not again inside.
	var done = await DaimondVersions.restore(id, v, { ask: false });
	if (done.outcome === 'refused' && !done.told) {
		noticeDialog(t('crystal.restore_failed'), done.why ? friendlyError(done.why) : '');
		return;
	}
	if (done.outcome === 'restored') await refreshDiamondAfterChange();
}

/// The Diamond's tags: the user's own filing system, edited here.
///
/// Tags only sort the rail. Nothing here is read by an agent, and no tag
/// reaches a crystal or a prompt -- which is why this sits beside the crystal
/// rather than in it.
export async function showTagEditor() {
	if (!pg.currentDiamond) return;
	var f = pg.diamonds.find(function (x) { return x.id === pg.currentDiamond.id; }) || pg.currentDiamond;
	var tags = tagsOf(f).slice();

	clearCrystalBody();
	var bar = document.createElement('div');
	bar.className = 'crystal-bar';
	var back = document.createElement('button');
	back.className = 'crystal-act lead-back';
	back.textContent = t('crystal.back');
	back.addEventListener('click', function () { renderCrystal(); });
	bar.appendChild(back);
	crystalBody.appendChild(bar);

	var wrap = document.createElement('div');
	wrap.className = 'tag-editor';
	var note = document.createElement('div');
	note.className = 'tag-note';
	note.textContent = t('tag.editor_note');
	wrap.appendChild(note);

	// Two boxes. The upper holds what is ON the Diamond, each chip with a
	// closer; the lower holds every tag the user has anywhere -- close a
	// chip above and it lands back below, click one below and it moves up.
	// The add input belongs to the lower box: typing mints a new tag into
	// the same pool the box shows.
	var curBox = document.createElement('div');
	curBox.className = 'tag-box tag-box-current';
	var curLbl = document.createElement('div');
	curLbl.className = 'tag-box-label';
	curLbl.textContent = t('tag.on_diamond');
	curBox.appendChild(curLbl);
	var current = document.createElement('div');
	current.className = 'tag-row';
	curBox.appendChild(current);
	wrap.appendChild(curBox);

	var allBox = document.createElement('div');
	allBox.className = 'tag-box tag-box-all';
	var allLbl = document.createElement('div');
	allLbl.className = 'tag-box-label';
	allLbl.textContent = t('tag.all');
	allBox.appendChild(allLbl);
	var sug = document.createElement('div');
	sug.className = 'tag-row tag-sug';
	allBox.appendChild(sug);

	var addRow = document.createElement('div');
	addRow.className = 'tag-add';
	var input = document.createElement('input');
	input.className = 'tag-input';
	input.type = 'text';
	input.placeholder = t('tag.add_ph');
	input.maxLength = 24;
	var add = document.createElement('button');
	add.className = 'crystal-act';
	add.textContent = '+ ' + t('tag.add_btn');
	addRow.appendChild(input); addRow.appendChild(add);
	allBox.appendChild(addRow);
	wrap.appendChild(allBox);
	crystalBody.appendChild(wrap);

	// The pool: every tag on any Diamond, the starter set, and anything
	// seen here this session -- so a tag just closed above still has a
	// chip below to bring it back, even if no other Diamond carries it.
	var seen = {};
	starterTags().forEach(function (x) { seen[x] = 1; });
	pg.diamonds.forEach(function (d) { tagsOf(d).forEach(function (x) { seen[x] = 1; }); });
	tags.forEach(function (x) { seen[x] = 1; });

	/// Persist, then repaint from what came back. The store owns
	/// normalisation -- it lowercases, trims, dedupes and caps -- so its
	/// answer is the truth, not what was typed here.
	async function commit(next) {
		try { await diamondApp().set_tags(f.id, JSON.stringify(next)); }
		catch (e) { noticeDialog(t('tag.save_failed'), friendlyError(e)); return; }
		bumpDiamonds();
		await loadDiamonds();
		var g = pg.diamonds.find(function (x) { return x.id === f.id; });
		if (g) { tags = tagsOf(g).slice(); pg.currentDiamond = g; }
		else tags = next;
		paint();
	}

	function paint() {
		current.innerHTML = '';
		if (!tags.length) {
			var none = document.createElement('span');
			none.className = 'tag-none';
			none.textContent = t('tag.none_yet');
			current.appendChild(none);
		}
		tags.forEach(function (tag) {
			var chip = tagChip(tag, 'tag-edit', null);
			var x = document.createElement('button');
			x.className = 'tag-x';
			x.textContent = '×';
			x.title = t('tag.remove', { tag: tag });
			x.setAttribute('aria-label', t('tag.remove', { tag: tag }));
			x.addEventListener('click', function () {
				commit(tags.filter(function (u) { return u !== tag; }));
			});
			chip.appendChild(x);
			current.appendChild(chip);
		});

		tags.forEach(function (x) { seen[x] = 1; });
		sug.innerHTML = '';
		// The starter set leads in its own order; everything else follows
		// alphabetically. Only what is not already on the Diamond is offered.
		var starters = starterTags();
		var rest = Object.keys(seen).filter(function (x) {
			return starters.indexOf(x) === -1;
		}).sort();
		var offer = starters.concat(rest).filter(function (x) {
			return tags.indexOf(x) === -1;
		});
		if (!offer.length) {
			var empty = document.createElement('span');
			empty.className = 'tag-none';
			empty.textContent = t('tag.all_used');
			sug.appendChild(empty);
			return;
		}
		offer.forEach(function (tag) {
			var chip = tagChip(tag, 'tag-offer', function () { commit(tags.concat([tag])); });
			chip.title = t('tag.add', { tag: tag });
			// The pool is the only place that shows every tag the user has, so it is
			// the only place one can be got rid of. The starter suggestions are
			// furniture rather than the user's own data -- they are offered whatever
			// the pool holds -- so they carry no closer: it could not remove them.
			if (starters.indexOf(tag) === -1) chip.appendChild(poolCloser(tag));
			sug.appendChild(chip);
		});
	}

	/// The × on a pool chip: delete the tag itself, everywhere it is filed.
	///
	/// The glyph is drawn in CSS rather than set as text (see `.tag-kill`). A
	/// chip's `textContent` is the tag -- the rail, the filter and the search all
	/// read it -- and a button with an × in it would make every one of them read
	/// "person×".
	function poolCloser(tag) {
		var x = document.createElement('button');
		x.className = 'tag-x tag-kill';
		x.title = t('tag.delete_help', { tag: tag });
		x.setAttribute('aria-label', t('tag.delete_help', { tag: tag }));
		x.addEventListener('click', async function (e) {
			e.stopPropagation();          // closing a chip is not clicking the chip
			// Who else is filed under it. This is the whole reason the removal asks
			// first: it is not this Diamond's tag, it is the user's tag.
			var users = pg.diamonds.filter(function (d) { return tagsOf(d).indexOf(tag) !== -1; });
			var body = users.length
				? tn('tag.delete_body_used', users.length, { tag: tag })
				: t('tag.delete_body_unused', { tag: tag });
			if (!await confirmDialog(body, t('tag.delete_ok'), { title: t('tag.delete_title') })) return;
			for (var i = 0; i < users.length; i++) {
				var d = users[i];
				var next = tagsOf(d).filter(function (u) { return u !== tag; });
				try { await diamondApp().set_tags(d.id, JSON.stringify(next)); }
				catch (e2) { noticeDialog(t('tag.save_failed'), friendlyError(e2)); return; }
			}
			delete seen[tag];             // gone from the pool for this session too
			// A filter on a tag that no longer exists would hide every Diamond
			// there is, with a chip under the rail head as the only clue why
			// -- and an EXCLUSION on one would go on hiding them with no chip
			// at all to click. The tag leaves both lists.
			dropTagFilter(tag);
			bumpDiamonds();
			await loadDiamonds();
			var g = pg.diamonds.find(function (y) { return y.id === f.id; });
			if (g) { tags = tagsOf(g).slice(); pg.currentDiamond = g; }
			paint();
			toast(users.length
				? tn('tag.deleted_from', users.length, { tag: tag })
				: t('tag.deleted', { tag: tag }));
		});
		return x;
	}

	function addTyped() {
		var typed = input.value.trim().toLowerCase();
		input.value = '';
		if (!typed || tags.indexOf(typed) !== -1) return;
		commit(tags.concat([typed]));
	}
	add.addEventListener('click', addTyped);
	input.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') { e.preventDefault(); addTyped(); }
	});

	paint();
	renderCrystalControls();
}

/// Fill the artefact strip and, when it is open, the list under it.
///
/// Reads the Diamond's links and keeps the ones pointing at something that is not another
/// Diamond: those are the things this pursuit produced or consulted, as against the Diamonds
/// it relates to.
export async function renderArtefacts() {
	var strip = document.getElementById('arte-strip');
	var list  = document.getElementById('arte-list');
	if (!strip || !list || !pg.currentDiamond) return;
	var diamondId = pg.currentDiamond.id;

	var links = [];
	try {
		links = JSON.parse(await diamondApp().links_touching('diamond:' + diamondId) || '[]')
			.filter(function (l) { return l.other && l.other.indexOf('diamond:') !== 0; });
	} catch (e) { links = []; }
	// A link gone since the state was last read leaves an orphan entry in the
	// local Note/Read map -- deletions are never tracked there, on purpose
	// (see pruneAttachState), so every render is the moment that gets noticed.
	pruneAttachState(links.map(function (l) { return l.id; }));

	// TRAINING WHEELS — remove with the DEBUG_SHARE module. The debug feed's
	// `diamond` row: what is mounted on the open Diamond, one `KIND path` string
	// per attached item, derived from the same `links` this strip already draws --
	// never a second read of the workspace. Deduped on (id + item paths) so a
	// repaint that changes nothing does not spam the feed. Lifts out in one grep
	// of `DEBUG_SHARE`.
	//
	// THIS MUST STAY ABOVE THE COLLAPSED-PANEL RETURN BELOW. It used to sit at the
	// foot of this function, after `if (!wsOpen) { … return; }` --
	// which is the panel's OWN fold state, closed by default and left closed by
	// most sessions, so the event was dead code for as long as nobody happened to
	// click the strip open. Moved here, it fires on every render with a Diamond
	// open, which is what "what is mounted" is meant to observe.
	try {
		var _items = links.map(function (l) {
			var kind = l.other.slice(0, l.other.indexOf(':'));
			var rest = l.other.slice(l.other.indexOf(':') + 1);
			var path = (parseRef(l.other).path) || rest;
			return kind.toUpperCase() + ' ' + path;
		});
		var _sig = diamondId + '|' + _items.join(',');
		if (_sig !== pg._lastDiamondSig) {
			pg._lastDiamondSig = _sig;
			if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
				DEBUG_SHARE.event('diamond', { id: diamondId, items: _items });
			}
		}
	} catch (e) { /* the feed must never break the artefact strip */ }

	// THE STRIP STAYS AT ZERO. It used to hide itself, and the list with it, so
	// that a new Diamond was not given an empty shelf to explain -- but the `+`
	// that attaches the first thing lives inside that list, which made the one
	// control unreachable in exactly the state it exists for. At zero the strip
	// reads as the offer rather than as a count of nothing.
	strip.style.display = '';
	// This strip is the Diamond's workspace in one line: the files, folders and
	// pages that are part of this pursuit -- which is the same set the Workspace
	// panel draws as a tree, and the same set its daimon may open. It used to
	// call them artefacts, which named only how most of them got here.
	// "Files (N)" at every count, zero included: it heads the list it opens (UNBLOCK-49).
	markName(strip, t('dws.files_n', { n: links.length }));
	strip.title = t('dws.title');
	// The fold is this Diamond's, on this device, and unchosen it opens only when every
	// file fits under the bound the stylesheet gives (`--crystal-files-cap`).
	var cap = parseInt(getComputedStyle(list).getPropertyValue('--crystal-files-cap'), 10);
	var wsOpen = crystalFilesOpen(diamondId, links.length, cap);
	strip.setAttribute('aria-expanded', wsOpen ? 'true' : 'false');
	if (!wsOpen) { list.style.display = 'none'; return; }
	list.style.display = '';

	// Most recent first: what was last touched is what is being worked on.
	links.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });

	// User-made links draw as the strip always has. What the app wrote for
	// itself -- a fold's harvest, an agent's own `artefact_add` -- is a
	// record, not a choice, and sits under one collapsed header instead of
	// crowding the same shelf one row per file. `dev/ATTACH_CONTRACT.md` §2b.
	var ownLinks    = links.filter(function (l) { return (l.by || 'user') === 'user'; });
	var daimonLinks = links.filter(function (l) { return (l.by || 'user') !== 'user'; });

	// The SAME component the chat footer draws (§5), given this footer's own
	// items. Everything below builds an ITEM; nothing below builds a row, so
	// the two footers cannot drift apart by one of them being edited.
	var body = renderAttachFooter(list, ownLinks.map(function (l) {
		var kind = l.other.slice(0, l.other.indexOf(':'));
		var rest = l.other.slice(l.other.indexOf(':') + 1);
		var parsed = parseRef(l.other);
		var path   = parsed.path || rest;
		// An attachment recorded in the OTHER workspace is not lost and is not
		// broken -- it is somewhere the app is not looking right now. Saying that
		// is the whole point: silence here reads as an empty folder, which is what
		// sent a daimon to report an empty book-shaped container.
		var away   = !refReachable(l.other);
		// Note \u21c4 Read, only for what the paperclip actually wrote (`holds`) --
		// ATTACH_CONTRACT.md \u00a76. What a fold harvested (`produced`) or a tool
		// merely looked at (`consulted`) is bookkeeping, not an attachment a
		// person made, and carries no such choice.
		var state = (l.rel === 'holds' && (kind === 'file' || kind === 'dir'))
			? readAttachState(l.id) : '';
		return {
			kind:   kind,
			path:   path,
			hint:   l.rel ? (l.rel + ' \u00b7 ' + path) : path,
			// Nothing to open, and the tile says where it lives instead (\u00a77).
			shut:   away,
			reason: away ? t('dws.not_here', { where: refWhere(l.other) }) : '',
			state:  state,
			onState: function () {
				writeAttachState(l.id, state === 'read' ? 'note' : 'read');
				renderArtefacts();
				// A still-fresh agent's seeded prefix reads this same store.
				syncAttachPrefix();
			},
			// Opening it is the obvious click, and every kind already has a panel
			// that knows how to show it \u2014 so this routes rather than rendering
			// anything itself.
			onOpen: function () { openArtefact(kind, path); },
			// The quieter, more useful one: put a reference in the composer. The hard
			// part of steering is naming which thing you mean, and this is the picker
			// for it.
			onRefer: function () {
				// The Diamond's composer, which is the chat one -- there is no
				// separate steer box any more, and this used to name it.
				var box = document.getElementById('chat-input');
				if (!box) return;
				box.value = (box.value ? box.value.replace(/\s*$/, ' ') : '') + rest + ' ';
				box.focus();
				box.style.height = 'auto';
				box.style.height = Math.min(box.scrollHeight, 120) + 'px';
			},
			onDrop: async function () {
				try { await removeLinkHere(l); } catch (e) { dropRefused(e); }
				// Dropping an artefact removes a link, so it is a link change too.
				signalLinksChanged();
				renderArtefacts();
			},
		};
	}));

	// The collapsed group, appended after the ordinary tiles. Its own header
	// (count and toggle) plus a "Drop all" that removes every link in it the
	// one way a single row's ◈ removes one -- a loop of `remove_link`,
	// so the group can never do anything a row-by-row drop could not have.
	if (daimonLinks.length) {
		var group = document.createElement('div');
		group.className = 'arte-daimon-group';

		var head = document.createElement('button');
		head.type = 'button';
		head.className = 'arte-daimon-toggle lead-disc';
		head.setAttribute('aria-expanded', pg.arteDaimonOpen ? 'true' : 'false');
		head.textContent = tn('dws.added_by_daimon', daimonLinks.length);
		head.addEventListener('click', function () {
			pg.arteDaimonOpen = !pg.arteDaimonOpen;
			renderArtefacts();
		});
		group.appendChild(head);

		var drop = document.createElement('button');
		drop.type = 'button';
		drop.className = 'arte-daimon-drop';
		drop.textContent = t('dws.drop_all');
		drop.title = t('dws.drop_all_help');
		drop.addEventListener('click', async function () {
			// One refusal said, not one per row.
			var refused = null;
			for (var i = 0; i < daimonLinks.length; i++) {
				try { await removeLinkHere(daimonLinks[i]); }
				catch (e) { refused = refused || e; }
			}
			if (refused) dropRefused(refused);
			signalLinksChanged();
			renderArtefacts();
		});
		group.appendChild(drop);

		if (pg.arteDaimonOpen) {
			group.appendChild(attachBody(daimonLinks.map(function (l) {
				var kind = l.other.slice(0, l.other.indexOf(':'));
				var rest = l.other.slice(l.other.indexOf(':') + 1);
				var parsed = parseRef(l.other);
				var path   = parsed.path || rest;
				var away   = !refReachable(l.other);
				return {
					kind:   kind,
					path:   path,
					hint:   l.rel ? (l.rel + ' · ' + path) : path,
					shut:   away,
					reason: away ? t('dws.not_here', { where: refWhere(l.other) }) : '',
					state:  '',			// never `holds`: nothing here is Note/Read
					onOpen: function () { openArtefact(kind, path); },
					onDrop: async function () {
						try { await removeLinkHere(l); } catch (e) { dropRefused(e); }
						signalLinksChanged();
						renderArtefacts();
					},
				};
			}), { cls: 'arte-daimon-body', label: tn('dws.added_by_daimon', daimonLinks.length) }));
		}
		list.appendChild(group);
	}

	// An empty box with a `+` above it says what to press and not why it is
	// worth pressing. This is the sentence that was written for the state and
	// had nowhere to appear while the state hid itself.
	if (!links.length) {
		var none = document.createElement('div');
		none.className = 'rail-note arte-empty';
		none.textContent = t('dws.empty_add');
		body.appendChild(none);
	}
}

/// The link by which a Diamond holds this reference, or nothing.
///
/// A reference is `file:<path>` for a file and `dir:<path>` for a folder, and
/// both say the same thing: this is in that Diamond's workspace, and its
/// daimon may open it.
// ── An attachment remembers which workspace it was made in ──────────
//
// A path is meaningless without the root it was written against.
// `books/elearnity/CheapThinking` is a folder on the user's disk in the
// Machine workspace and nothing whatever in the Browser sandbox, yet an
// attachment recorded only the path. So a folder attached on the machine and
// opened later in the browser was ALLOWED and ABSENT: `diamond_bounds` put it
// in the scope, the tool door let the daimon reach for it, and OPFS answered
// NotFoundError. The Diamond looked equipped and was not, and the daimon
// reported an empty container -- which is what a person reads as "my Diamond
// is broken". `dev/ROOT_SEPARATION.md` §2.1 says a single tree spanning two
// roots is the confusion to prevent; this is that confusion in the links.

/// Which workspace is open, as an attachment records it. `fid` is a machine folder's
/// id on this device, which only the record of marks reads (`rootHere`); a reference
/// syncs to other devices, where it would mean nothing, so `rootedRef` leaves it out.
function currentRoot() {
	var h = null, fid = '';
	try { h = Files.folder(); fid = Files.folderId(); } catch (e) { /* the panel has not started yet */ }
	return h ? { kind: 'machine', name: String(h.name || ''), fid: String(fid || '') }
		: { kind: 'browser', name: '' };
}

/// A reference carrying the workspace it belongs to:
/// `dir:[machine:usr@<device>]books/x`, or `dir:[browser]books/x`.
///
/// Bracketed and leading, so it cannot be mistaken for part of a path -- and a
/// path is free to contain a colon, which a Maildir name does
/// (`…daimond:2,S`), so the root cannot simply be a second colon-field.
///
/// A MACHINE REFERENCE NAMES THE DEVICE IT WAS MADE ON (owner decision,
/// 2026-09-23). A folder called `usr` on one machine and a folder called `usr`
/// on another are two places, and a mark made on argonaut was matched by name
/// and applied to gilgamesh's disk -- where a daimon then removed four of its
/// top-level folders. The device list after `@` is where the mark is in force;
/// see `refReachable` and `confirmMarkHere`.
export function rootedRef(kind, path) {
	var r = currentRoot();
	return kind + ':[' + (r.kind === 'machine' ? 'machine:' + r.name + '@' + deviceId() : 'browser')
		+ ']' + path;
}

/// Split a reference into its kind, its workspace, and its path -- and, for a
/// machine reference, the folder's name and the devices it was made on. The
/// parse lives in markshere.js, which needs it for the same grant.
export function parseRef(ref) {
	return DaimondMarksHere.parseRef(ref);
}

/// Two references name the same thing when their kind and path agree.
///
/// The workspace is deliberately NOT part of this test. The control is a
/// toggle, and pressing it on a file an older rootless link already holds must
/// take that link off rather than add a second one beside it that the button
/// cannot see. Which of several rows the control acts on is `samePlace`'s answer.
function sameThing(a, b) {
	var x = parseRef(a), y = parseRef(b);
	return x.kind === y.kind && x.path === y.path;
}

/// Of the stored references in `list` (read through `refOf`), the one a press on
/// `ref` acts on: an exact spelling always answers first, whatever `rankOf` says
/// of it -- the caller already has that row's own words, and reachability is a
/// question about a DIFFERENT spelling's workspace, not about the row itself.
/// Failing an exact spelling, the highest-ranked candidate naming the same thing.
///
/// THE PLACE, NOT THE PATH (M3, 2026-09-24). Matched on kind and path alone, the
/// paperclip on `books` in the browser found a mark on `books` in a machine folder
/// on another device, which waits nowhere here and is in force nowhere here, so
/// the press took that mark off -- a removal, which travels and drops the other
/// device's entry -- and added nothing. A row of another workspace is left alone,
/// and the press adds this workspace's own.
///
/// RANKED, NOT MERELY REACHABLE (F2, 2026-09-25). `rankOf`, where given, scores a
/// candidate as `placeRank` (`attachmentsOf`) does: 2 in force here, 1 waiting, 0
/// merely reachable, and below 0 for one this press must never touch. Left out,
/// every reachable candidate ranks 0, the old rule. A Diamond with two rows for
/// one folder -- this device's, in force, and another device's, waiting, BOTH
/// spelt identically -- used to have the paperclip DRAW the row in force
/// (`attachedOf`, which reads the already force-ranked `attached`) while a PRESS,
/// unranked, took the first row in sidecar order: "Use here" then granted a twin
/// nobody meant to touch, and a read-only mark became read-and-change. Ranking is
/// the one resolver both paint (`attachedOf`) and press (`linkTo`) call now, so
/// they can no longer disagree -- and it is what breaks the tie BETWEEN two exact
/// spellings, never what excludes the only one there is: the M4 seed's browser
/// row, asked about by its own exact words from a machine folder where it is
/// unreachable, still answers -- reachability there is the QUESTION, not a
/// reason to skip the one row that answers it.
export function samePlace(list, ref, refOf, rankOf) {
	var rank = rankOf || function (item, r) { return refReachable(r) ? 0 : -1; };
	// `exactRank` starts BELOW every real rank, `rankOf` included: a rank of -1
	// means "never touch this as a NEAR candidate", and the M4 seed's own row,
	// asked about from a machine folder, ranks exactly -1 there (unreachable) --
	// an exact match on -1 must still win over no exact match at all, or the
	// one row that answers the question is skipped for the same reason a near
	// one would have been.
	var exact = null, exactRank = -Infinity;
	var near = null, nearRank = -1;
	for (var i = 0; i < list.length; i++) {
		var item = list[i], r = refOf(item);
		if (r === ref) {
			var re = rank(item, r);
			if (re > exactRank) { exact = item; exactRank = re; }
			continue;
		}
		if (exact !== null || !sameThing(r, ref)) continue;
		var rn = rank(item, r);
		if (rn < 0) continue;
		if (rn > nearRank) { near = item; nearRank = rn; }
	}
	return exact !== null ? exact : near;
}

// ── A mark counts only on a device where it was pressed (R2) ─────────
//
// Until the re-check of 2026-09-23 a row that said `by:"user"` and carried this
// device's id in its reference was in force here -- and a row is bytes in a
// sidecar that syncs whole, so anything that could write those bytes could
// write a grant. The device list in a machine reference stays, as a record of
// where the mark was made, and grants nothing. The grant is the intersection
// of the row and this device's own record of what was pressed on it
// (markshere.js), and `markForce` below is the only test of it.

/// The workspace that is open, as the record names it: `browser`, or
/// `machine:<name>#<folder id>`, so two folders of one name are two places (M2).
export function rootHere() {
	return DaimondMarksHere.rootKey(currentRoot());
}

/// Can this reference be opened from the workspace that is open? Reachability
/// only -- whether a mark is IN FORCE here is `markForce`'s question. The same
/// root, and for a machine folder the same name where the reference carries
/// one; a reference written before roots were recorded fits either, and so
/// does one naming a store path (`diamonds/`, `mail/`, `chats/`), whatever
/// root it was written under (F3, 2026-09-25: a legacy Keep transcript row,
/// written `file:[machine:…]diamonds/<id>/transcript.md` before this build
/// named store paths as such, read as living on another workspace, and one
/// press from here added a second row rather than finding the one already
/// held). Mirrors `DaimondMarksHere.fits`, which asks the same question of
/// `markshere.js`'s own callers.
export function refReachable(ref) {
	var p = parseRef(ref);
	var r = currentRoot();
	if (!p.root || DaimondMarksHere.isStorePath(p.path)) return true;
	if (p.root !== r.kind) return false;
	// A different folder on the same machine is a different place, and a reference
	// carries only the folder's name, so two folders of one name both fit. That is
	// reachability only: the record binds a grant to the folder's id on this device
	// (`rootHere`), so a mark pressed in one of them waits in the other (M2).
	return p.root !== 'machine' || !p.name || p.name === r.name;
}

/// Is this stored link a mark at all -- the user's `holds` or `consulted` on a
/// file or folder, or one from before rows said who wrote them? The only kind a
/// share flag may stand on.
export function isUsersMark(link) {
	return DaimondMarksHere.isMark(link);
}

/// THE ONE TEST OF A DIAMOND'S GRANT ON THIS DEVICE: `{ rel, share }` where
/// `link` is `owner`'s mark in force here, null where it is not. Every reader
/// of a grant -- the fence, the share roots, the panel, the notice, the prefix
/// -- asks this and nothing else. A trashed Diamond grants nothing.
export function markForce(owner, link) {
	if (!owner || !link || trashed(owner)) return null;
	return DaimondMarksHere.force(owner, link, rootHere());
}

/// Is this stored link a mark in force on this device, for the Diamond whose
/// sidecar holds it?
export function markInForce(link) {
	return !!link && !!markForce(link.owner, link);
}

/// Is this stored link a mark NOT in force on this device, that the user can
/// bring into force here with one press? Its Diamond's own, on a root that fits
/// the one open, and with no entry here: made on another device, before R2, or
/// arriving in a copy nobody pressed on this device. A row a model or a fold
/// wrote is never offered: confirming it would be the user rubber-stamping an
/// agent's grant, and it was never a mark to begin with.
export function markWaiting(link) {
	if (!link) return false;
	var rel = link.rel || '';
	if (rel !== 'holds' && rel !== 'consulted') return false;
	if (trashed(link.owner)) return false;
	return DaimondMarksHere.waiting(link.owner, link, rootHere());
}

/// A press here whose record did not land: the mark stays waiting, and says so.
export function marksNotSaved() {
	toast(t('marks.not_saved'), true);
}

/// Bring a mark that is not in force here into force on this device: the user's
/// own act, from the notice above the composer or the paperclip.
///
/// THIS DEVICE'S RECORD ONLY. It used to write the row again with this device
/// added and remove the old one, which moved the Diamond's stamp, cost a sync
/// round, and left two rows where two devices confirmed one between syncs --
/// after which a removal on one of them took one row and the other came back as
/// waiting. The row is left exactly as it is, and the entry is written with the
/// share off whatever the row says: sharing is its own press (`toggleAttachShare`),
/// the grant that lets other devices change and delete files on this disk, and a
/// confirmation, one at a time or all at once, must not give it as a side effect.
export async function confirmMarkHere(diamondId, link) {
	if (!diamondId || !link || link.owner !== diamondId || !markWaiting(link)) return false;
	if (!DaimondMarksHere.grant(diamondId, link, rootHere(), { share: false })) {
		marksNotSaved();
		return false;
	}
	signalLinksChanged();
	return true;
}

/// Ask before a paperclip brings a waiting mark into force: the notice's own "Use here",
/// naming the mark, where it was made, and -- where `ro` is given -- whether the press
/// grants read only or read and change. Resolves true where it is pressed.
///
/// ONE TAP NEVER GRANTS (R2 QA, 2026-09-24). The paperclip is a toggle, drawn pressed
/// on a waiting mark, and it confirmed that mark on one press -- which a touch screen
/// gives no title to warn of, so a tap meant to take a folder off granted it instead.
/// Now the press opens the question and the grant is a second, labelled press. Taking
/// a mark off is the ◈ or the ×, as it is for every mark.
///
/// GUARDED (F1, QA 2026-09-25). One held Enter used to open this question AND answer
/// it: focus landed on "Use here" and the OS's own key-repeat pressed it before the
/// person could read the question. It takes R6's guard now -- focus on Cancel, and the
/// yes disabled for its first second -- exactly as the held delete does, through the
/// one door `dialog` owns rather than a copy of its own.
export function askUseHere(path, where, ro) {
	var kind = ro === undefined ? '' : ('\n' + t(ro ? 'dws.readonly' : 'dws.readwrite'));
	return confirmDialog('\u25c8 ' + path + (where ? '\n' + where : '') + kind + '\n\n' + t('marks.waiting_why'),
		t('marks.use_here'), { title: t('marks.use_ask'), danger: false, guard: true, ask: 'mark-use-here' });
}

/// One of this Diamond's own rows, as the store holds it, by id.
export async function ownLinkById(diamondId, id) {
	if (!diamondId || !id) return null;
	try {
		var links = JSON.parse(await diamondApp().links_touching('diamond:' + diamondId) || '[]');
		for (var i = 0; i < links.length; i++) {
			var l = links[i];
			if (l.id === id && l.owner === diamondId && l.from === 'diamond:' + diamondId) return l;
		}
	} catch (e) { /* unreadable: nothing to record */ }
	return null;
}

/// Record a mark just written here, from the row as the store holds it, read
/// back by the id the add returned -- never from the reference the page passed
/// in, which the store may have spelt otherwise.
export async function markHere(diamondId, id) {
	var row = await ownLinkById(diamondId, id);
	// A row that is not a mark has no grant to record: one on a file in the Diamond's
	// own directory lists it and nothing more (M1).
	if (row && !DaimondMarksHere.isMark(row)) return true;
	if (!row || !DaimondMarksHere.grant(diamondId, row, rootHere(), { share: false })) {
		marksNotSaved();
		return false;
	}
	return true;
}

/// Give `diamondId` a place on this device: the ◈'s add, and a yes to the write question
/// (E2). A row already in force is left; otherwise a `holds` row is written and the press
/// recorded here. With the ◈, the row ⋯ and confirmMarkHere, the only writers (N3).
export async function grantHoldHere(diamondId, path, dir) {
	var ref = rootedRef(dir ? 'dir' : 'file', path);
	var link = await linkTo(diamondId, ref);
	if (link && markForce(diamondId, link)) return true;
	return await markHere(diamondId,
		await diamondApp().add_link(diamondId, 'diamond:' + diamondId, ref, 'holds', '', 'user'));
}

/// The mark at `path` of `diamondId`'s that waits on this device, or null.
export async function waitingMarkAt(diamondId, path) {
	var ks = ['dir', 'file'];
	for (var i = 0; i < ks.length; i++) {
		var l = await linkTo(diamondId, rootedRef(ks[i], path));
		if (l && markWaiting(l)) return l;
	}
	return null;
}

/// The device a waiting mark was made on, as the user calls it.
export function markDevice(link) {
	var p = parseRef(link.other || '');
	var dev = (p.devices || []).filter(function (d) { return d !== deviceId(); })[0];
	return dev ? deviceLabelFor(dev) : t('dws.another_device');
}

/// Take a link off, made here: the row, and this device's entry for it. The one
/// door every removal on this device goes through. The entry goes only once the
/// store has taken the row: a refusal leaves the mark as it was and is thrown to the
/// caller, who says it.
///
/// A hand-written row has no id, and the store refuses a blank one (it named every
/// such row at once), so that row goes by its content (`remove_bare_link`).
export async function removeLinkHere(link) {
	if (!link) return false;
	var to = link.to || link.other || '';
	var id = link.id && String(link.id).trim() ? link.id : '';
	var gone = id
		? await diamondApp().remove_link(link.owner, id)
		: await diamondApp().remove_bare_link(link.owner, link.from || '', to, link.rel || '');
	DaimondMarksHere.drop(link.owner, id, to);
	return gone;
}

/// Say a removal `removeLinkHere` was refused, as the link card's Drop says it. A
/// hand-written row the store cannot single out used to go quietly.
export function dropRefused(e) {
	noticeDialog(t('link.drop_failed'), friendlyError(e));
}

/// Say a share toggle the store refused, as `dropRefused` says a removal.
export function shareRefused(e) {
	noticeDialog(t('link.share_failed'), friendlyError(e));
}

/// How to say where an unreachable attachment actually lives -- and, for a
/// mark made on another device, WHICH device.
export function refWhere(ref) {
	var p = parseRef(ref);
	if (!p.root) {
		return currentRoot().kind === 'machine' && (p.kind === 'file' || p.kind === 'dir')
			? t('dws.on_device', { name: t('dws.a_folder'), device: t('dws.another_device') })
			: '';
	}
	if (p.root !== 'machine') return t('dws.in_browser');
	// A reference that names its devices, none of them this one, lives on one of them,
	// whichever workspace is open here. It said "on this machine" from the browser
	// workspace, of a mark made on another device (M3, 2026-09-24).
	if (p.devices.length && p.devices.indexOf(deviceId()) < 0) {
		return t('dws.on_device', { name: p.name || t('dws.a_folder'), device: deviceLabelFor(p.devices[0]) });
	}
	// One from before references named devices: another device, where a folder of its
	// name is open here and it is still not in force.
	var r = currentRoot();
	if (!p.devices.length && r.kind === 'machine' && (!p.name || p.name === r.name)) {
		return t('dws.on_device', { name: p.name || t('dws.a_folder'), device: t('dws.another_device') });
	}
	return t('dws.in_machine', { name: p.name || t('dws.a_folder') });
}

export async function linkTo(diamondId, ref) {
	return linkAmong(diamondId, await ownLinks(diamondId), ref);
}

/// This Diamond's own rows by a person, read from the store ONCE, for a caller
/// asking about many references at a time.
///
/// The `+` picker used to ask `linkTo` per row, and each ask re-read and
/// re-parsed every link touching the Diamond: 594 rows in one folder were
/// 594 store reads in series, about 20 s of an empty list (D-20261006-32).
export async function ownLinks(diamondId) {
	try {
		var links = JSON.parse(await diamondApp().links_touching('diamond:' + diamondId) || '[]');
		// This Diamond's own rows, by a PERSON, only: one kept in another Diamond's
		// sidecar, or with its ends reversed, is not this Diamond's to take off
		// (R2); one written by a fold, never the person, is not the paperclip's
		// either (open item 3 / item 7, 2026-09-25). A `produced` row used to
		// match here just the same, so a press on a file a fold had harvested
		// deleted the fold's own record and granted nothing; that row is the
		// daimon group's Drop to remove now, never a paperclip meant for a
		// person's mark.
		//
		// BY `by`, NOT `isUsersMark`. A row in the Diamond's own directory --
		// Keep's transcript among them -- is `by:"user"` and is not a mark
		// either (M1), but `linkTo` must still find it, to draw it held and to
		// let the paperclip toggle it off: `isUsersMark` folds both exclusions
		// into one test, and filtering by it here took M1's own rows out of
		// reach along with fold's.
		return links.filter(function (l) {
			return l.owner === diamondId && l.from === 'diamond:' + diamondId && (l.by === 'user' || !l.by);
		});
	} catch (e) { /* unreadable: treat as not held */ }
	return [];
}

/// The row among `own` (from `ownLinks`) that `ref` names, or null.
export function linkAmong(diamondId, own, ref) {
	try {
		// Matched on what it names, not on the string, so an attachment made before
		// roots were recorded is still found by a button that now writes one -- but
		// only in a reference this workspace can open (M3), and ranked exactly as
		// the paint does (F2, `attachedOf`): in force here, then waiting, then
		// merely reachable, so a press can never land on a twin the paperclip drew
		// as something else.
		return samePlace(own, ref, function (l) { return l.other; },
			function (l) {
				if (markForce(diamondId, l)) return 2;
				if (markWaiting(l)) return 1;
				return refReachable(l.other) ? 0 : -1;
			});
	} catch (e) { /* unreadable: treat as not held */ }
	return null;
}

/// The link by which a Diamond holds this file, or nothing.
export async function heldLink(diamondId, path) {
	return await linkTo(diamondId, rootedRef('file', path));
}

// ── Attach to focus — the paperclip's control and states ───────────
//
// ATTACH_CONTRACT.md is the design; this is its implementation. One control
// means the same thing on a folder row, a file row and the Doc header:
// "attach this to whatever is in focus" (§4). What the click DOES depends on
// what is in focus, never on which row it was pressed on.

/// What "current focus" means for the attach control.
///
/// `currentDiamond` is set on BOTH of a Diamond's faces — its crystal and
/// its own daimon chat — so it is checked first and covers both. An
/// ordinary chat is `current` with no `diamondId` of its own; a Diamond's
/// own thread always carries one (see `daimonChat`). Neither means nothing
/// is open, and the control must then be hidden rather than shown inert.
export function attachFocus() {
	if (pg.currentDiamond) return { kind: 'diamond', id: pg.currentDiamond.id, name: pg.currentDiamond.name };
	if (pg.current && !pg.current.diamondId) return { kind: 'chat', id: pg.current.id };
	return null;
}

// A Diamond's Note/Read is local to this device, on purpose, kept OUTSIDE
// the link record — link id → 'read' (Note is the unwritten default, so
// nothing is stored for it).
//
// The link's own `note` field looked like the obvious place, and was tried
// first: rejected because `note` is a user-facing free-text field, already
// editable from a different dialog (the Diamond-to-Diamond Link form), and
// this project has already lost data once to a field carrying two meanings
// at once — the tag-loss incident, where `updated` served both "when this
// changed" and "when this synced", and a union between two devices'
// disagreement silently dropped tags on the loser. That the UI does not
// surface `note` for a `holds` link TODAY was exactly the argument made
// for the field that lost the tags; it is not a safe argument twice.
//
// The cost of a dedicated local store is real and is written down rather
// than discovered later: it does not sync, so a second device shows Note
// for a link until it is set on THAT device too. This is the direction the
// safe default protects: Note is the cheap one, so a device this state has
// never reached is never the device that spends the user's money unasked.
var ATTACH_STATE_KEY = 'daimond-attach-state';

function loadAttachStateMap() {
	try { return JSON.parse(localStorage.getItem(ATTACH_STATE_KEY) || '{}'); }
	catch (e) { return {}; }
}
function saveAttachStateMap(map) {
	try { localStorage.setItem(ATTACH_STATE_KEY, JSON.stringify(map)); }
	catch (e) { /* private mode: state holds for this session only */ }
}

/// Drop whatever this map holds for a link that is no longer live.
///
/// Deletions are never tracked -- there is no event for "a link went away"
/// that this map listens for -- so an orphan is found the only way it can
/// be: by comparing against the set of ids that ARE live, whenever that set
/// is next read. Called once per render, with every id the render just saw,
/// not once per link -- pruning against a partial set would read a link
/// merely off-screen as gone.
function pruneAttachState(liveIds) {
	var map = loadAttachStateMap(), changed = false, live = liveIds || [];
	Object.keys(map).forEach(function (id) {
		if (live.indexOf(id) < 0) { delete map[id]; changed = true; }
	});
	if (changed) saveAttachStateMap(map);
}

/// This link's Note/Read, defaulting to Note for one the map has never
/// heard of — an id from another device, or one this device has not yet
/// set (ATTACH_CONTRACT.md §6: Note is what an attachment starts as).
function readAttachState(linkId) {
	return loadAttachStateMap()[linkId] === 'read' ? 'read' : 'note';
}
function writeAttachState(linkId, state) {
	var map = loadAttachStateMap();
	if (state === 'read') map[linkId] = 'read'; else delete map[linkId];
	saveAttachStateMap(map);
}

// A chat's attachments live here and nowhere else — ATTACH_CONTRACT.md §4:
// "writes NOTHING to the store". Keyed by chat id so switching away and back
// keeps what is queued; cleared the moment that chat's turn is sent.
// A chat's scope lives ON THE CHAT RECORD, in `holds`, and that is the whole of
// its lifetime rule: it persists because the record does, it travels because the
// record is in the sync parcel, and it dies when the chat dies with nothing to
// sweep up afterwards. Two lifetimes, one meaning — a Diamond's holdings persist
// because a Diamond does, a chat's expire with the chat.
//
// Not the Diamond link store, and the reason is where that store puts a record
// rather than what the record says: `links_path` in src/wasm/diamond.rs is
// `diamonds/<owner>/…`, and `all_links` walks those directories rather than the
// rail — so a chat owning links would be a directory in the Diamond store and a
// node in the Diamond graph, which is the one thing a throw-away conversation
// must not become. What IS reused is everything the paperclip actually means:
// `rootedRef`, `parseRef`, `sameThing`, `refReachable` and the tile, so the
// control behaves identically on both surfaces.
export function chatAttachList(chatId) {
	var c = pg.chats.find(function (x) { return x.id === chatId; });
	if (!c) return [];
	if (!Array.isArray(c.holds)) c.holds = [];
	return c.holds;
}

/// The holding a press on `ref` acts on: that reference, or the same thing in one this
/// workspace can open (`samePlace`, M3). Another workspace's holding of the same path is
/// left alone, so the paperclip adds this workspace's own rather than taking it off.
export function chatAttachFind(chatId, ref) {
	return samePlace(chatAttachList(chatId), ref, function (a) { return a.ref; });
}

/// A chat's holdings that claim a workspace mark or a Read NOT in force on this
/// device, and that one press here brings into force: pressed on another device,
/// before R2, or arriving in a record nobody pressed here. The chat record rides
/// the sync parcel, so what it claims is only a claim (R2).
export function chatWaiting(chatId) {
	if (!chatId || trashed(chatId)) return [];
	var root = rootHere();
	return chatAttachList(chatId).filter(function (a) {
		return DaimondMarksHere.chatWaiting(chatId, a, root) && !underTrashedDiamond(a.path);
	});
}

/// Record a press here on one of a chat's holdings (`opts.ws`, `opts.read`).
function chatGrantHere(chatId, a, opts) {
	if (DaimondMarksHere.chatGrant(chatId, a, rootHere(), opts)) return true;
	marksNotSaved();
	return false;
}

/// Bring one of a chat's holdings into force on this device: the user's own press.
/// This device's record only -- the reference is not rewritten and `metaAt` does
/// not move, so a confirmation is not a change that travels.
export function chatConfirmHere(chatId, ref) {
	var rec = chatAttachFind(chatId, ref);
	if (!rec || !DaimondMarksHere.chatWaiting(chatId, rec, rootHere())) return false;
	if (!chatGrantHere(chatId, rec, { ws: !!rec.ws, read: rec.state === 'read' })) return false;
	attachChanged();
	dropChatApp(chatId);
	return true;
}

/// Take one holding off a chat: the record's claim and this device's entry.
/// Never a confirmation, whatever it waits for here: the × means remove, and a
/// person taking off a folder they do not recognise must not grant it instead
/// (QA 2026-09-24, F7). The Diamond's × has the same door, `removeLinkHere`.
function chatAttachRemove(chatId, ref) {
	var list = chatAttachList(chatId);
	// The chat's `holds` are a METADATA scalar (S-SYNC #5): stamp `metaAt` so a
	// change made here is not reverted when a later turn lands from another
	// device. Found on the live rail rather than through `chatAttachList` so the
	// same object the list belongs to is stamped.
	var _hc = pg.chats.find(function (x) { return x.id === chatId; });
	// The holding the press names, by the same rule as every other door (M3).
	var i = list.indexOf(chatAttachFind(chatId, ref));
	if (i < 0) return false;
	DaimondMarksHere.chatDrop(chatId, list[i]);
	list.splice(i, 1);
	touchChatMeta(_hc);
	persistChats(); attachChanged();
	dropChatApp(chatId);
	return true;
}

/// Add or remove one, from the paperclip -- a row's, or the Doc header's.
/// Persisted, because a chat's scope is now as durable as the chat: attaching
/// is a decision the user makes once.
export function chatAttachToggle(chatId, ref, dir, path) {
	var list = chatAttachList(chatId);
	var _hc = pg.chats.find(function (x) { return x.id === chatId; });
	var had = chatAttachFind(chatId, ref);
	if (had) {
		// A holding not in force here is never dropped by the paperclip: it asks to
		// confirm it on this device, the same question as a Diamond's paperclip
		// (`askUseHere`), and the answer writes this device's record only. The
		// paperclip alone: a × never gets here.
		if (DaimondMarksHere.chatWaiting(chatId, had, rootHere())) {
			var heldRef = had.ref;
			askUseHere(had.path, refWhere(heldRef)).then(function (yes) {
				if (yes) chatConfirmHere(chatId, heldRef);
			});
			return;
		}
		chatAttachRemove(chatId, ref);
		return;
	}
	// Note is the default — ATTACH_CONTRACT.md §6: the cheaper of the two by
	// a wide margin, and a default that spends the user's money unasked is
	// the wrong default. It is a READING state, here as there: neither Note
	// nor Read grants a worker permission to change anything, which is why
	// the write fence is drawn from the LIST and not from the state.
	list.push({ ref: ref, dir: !!dir, path: path, state: 'note' });
	// ── `ws`: is this in the chat's WORKSPACE? ──────────────────────
	//
	// The second, INDEPENDENT thing an attachment carries, and the only one that
	// reaches the fence. `state` is a cost decision about the prompt and grants
	// nothing; `ws` is the blast radius. A path can be in the workspace and Read
	// at once, so they are two fields and never one with three values.
	//
	// Written here rather than in the object literal above so that
	// `verify_attachfocus --break notedefault`, which anchors on that line
	// verbatim, still finds it.
	//
	// FALSE, always, whatever was attached. Attaching a folder used to grant
	// write reach to it by the mere fact of the attachment, and inheriting that
	// as a default would carry the old meaning through the change under a new
	// name. Marking in is its own press.
	list[list.length - 1].ws = false;
	touchChatMeta(_hc);
	persistChats(); attachChanged();
	dropChatApp(chatId);
}

/// Note or Read. A Read quotes the file into the message, which is a grant, so
/// the press is recorded here as well as on the record that travels.
function chatAttachSetState(chatId, ref, state) {
	var rec = chatAttachFind(chatId, ref);
	if (!rec) return;
	if (rec.state !== state) {
		rec.state = state;
		touchChatMeta(pg.chats.find(function (x) { return x.id === chatId; }));   // holds is metadata (S-SYNC #5)
		persistChats();
	}
	chatGrantHere(chatId, rec, { read: state === 'read' });
	attachChanged();
}

/// Mark this folder into the chat's workspace, or take it back out.
///
/// THE PRESS THAT IS THE PERMISSION. Nothing is asked here and nothing is asked
/// later: the fence is geography, and this is where the geography is drawn.
///
/// The app is dropped because `compose` in src/tools.rs INTERSECTS — which is
/// what makes it safe to call from anywhere — so re-scoping the app a live chat
/// already holds can only ever narrow it. A folder marked in while an app exists
/// would then be a control that visibly did something and reached nothing, which
/// is the defect class this whole surface was rebuilt to end.
function chatAttachSetWorkspace(chatId, ref, on) {
	var rec = chatAttachFind(chatId, ref);
	if (!rec) return;
	if (!!rec.ws !== !!on) {
		rec.ws = !!on;
		touchChatMeta(pg.chats.find(function (x) { return x.id === chatId; }));   // holds is metadata (S-SYNC #5)
		persistChats();
	}
	// The press is the grant on THIS device; the record carries only the claim.
	chatGrantHere(chatId, rec, { ws: !!on });
	attachChanged();
	dropChatApp(chatId);
}

/// Throw away the engine instance a chat holds, so the next turn builds one with
/// the workspace as it stands now.
///
/// A chat MID-TURN keeps its app: the running turn owns it — abort and interject
/// both go through it — and its scope was settled when it started. The mark is
/// applied at the top of the next turn instead, which is what `_scopeStale` is
/// read for. An underscore field, so `slimChat` leaves it out of the record and
/// it never rides the sync parcel.
export function dropChatApp(chatId) {
	var c = pg.chats.find(function (x) { return x.id === chatId; });
	if (c) rebuildChatApp(c);
}

/// The engine session a chat holds is to be built again (its workspace, its prompt, its notes,
/// a setting or a key have moved): the one door, for a chat and for every chat at once. A chat
/// mid-turn keeps the session its turn runs on, which Stop, a pause and an interjection all reach
/// it by, and the mark is applied at the top of the next turn.
export function rebuildChatApp(c) {
	if (c._generating) { c._scopeStale = true; return; }
	c.app = null;
}

/// The folders this chat's workspace is MADE OF, as workspace-relative paths.
///
/// The INPUT to a fence and not a fence: the bounds are composed in Rust, by
/// `chat_bounds`, and a page that built its own would be a second opinion
/// about what a worker may touch, free to drift from the one enforced.
///
/// **Marked only.** Note and Read are a cost decision about what is quoted into
/// the prompt, and neither grants any reach — so a path attached as Read and not
/// marked in is not here, and the engine will refuse to open it. Handing over the
/// whole attachment list is exactly the mistake that would make Note a grant.
///
/// Unreachable holdings are left out for the reason `Files.bounds` leaves
/// them out of a Diamond's: a path that is allowed and absent reads to the
/// model as an empty folder rather than as a folder that is somewhere else.
export async function chatScopePaths(chatId) {
	// A trashed chat has no scope. Asked HERE, where the list is BUILT, which is
	// the rule stated at `function trashed`: a chat in the trash is gone from the
	// rail and from every scope, and a worker still holding its folders would be
	// the half-alive state the trash exists to refuse. It does not come free from
	// the record being intact — the record is intact precisely so a restore works.
	if (trashed(chatId)) return [];
	var root = rootHere();
	return chatAttachList(chatId)
		// The MARK, and nothing else, is what widens the fence -- and only a mark
		// pressed on this device (R2): the record is in the sync parcel, so a mark
		// it claims is a claim until it is pressed here.
		.filter(function (a) {
			var f = DaimondMarksHere.chatForce(chatId, a, root);
			return !!(f && f.ws);
		})
		// A door onto a Diamond the user deleted, closed for the same reason
		// `attachmentsOf` closes it: the path resolves, and reads as an empty
		// folder rather than as a Diamond that is gone.
		.filter(function (a) { return !underTrashedDiamond(a.path); })
		.map(function (a) { return a.path; })
		.filter(function (p) { return !!p; });
}

/// Drop everything a destroyed chat leaves behind: its holdings, and its
/// workers' scratch.
///
/// TRASHING a chat needs none of this and must not do it — the record is
/// untouched, so Restore brings the whole scope back, exactly as it does for a
/// Diamond. This is for DESTROYING, which is now the ordinary end of every
/// abandoned conversation rather than a deliberate act, so what leaks here
/// leaks once per chat nobody came back to.
///
/// The holdings go with the record, which the caller is about to tombstone, so
/// there is nothing to unpick there: a chat's scope lives ON the chat and dies
/// with it. The scratch does not — it is a directory in the store, under an id
/// that is about to name nothing.
///
/// Best-effort and never fatal: a scratch that cannot be removed is wasted
/// bytes, and refusing to finish the deletion over it would leave the chat
/// half-destroyed, which is worse than the bytes.
///
/// # Arguments
/// * `chatId` - The chat being destroyed.
export function dropChatScope(chatId) {
	if (!chatId) return;
	var c = pg.chats.find(function (x) { return x.id === chatId; });
	if (c) c.holds = [];
	// And what was pressed on it here: a chat id is reused from a counter.
	DaimondMarksHere.chatDropAll(chatId);
	// Under `chats/<id>/`, which is store state and therefore always in the
	// browser's own sandbox whatever workspace is open — so this can never
	// reach into the user's real folder, whichever one they have open.
	try {
		var app = diamondApp();
		if (app && typeof app.remove_dir === 'function') {
			// The ID alone. The engine composes the path and refuses one that is not
			// a plain id, because this deletes a directory recursively.
			app.remove_dir(chatId).catch(function () { /* already gone */ });
		}
	} catch (e) { /* the engine is not up; the record still goes */ }
}

/// A chat's own working folder: where a worker it dispatched may always write.
///
/// Under `chats/`, which `is_store_path` in src/tools.rs answers for, and
/// three things follow from that one fact: it resolves to the browser's own
/// storage even with a real machine folder open, `default_cwd` skips it, and
/// `fence_spec` cannot map it onto the machine. Which together are the whole
/// of "no attachment, no command".
export function chatScratchDir(chatId) {
	return 'chats/' + String(chatId || '') + '/work';
}

/// `Note <path1>, <path2>, …` / `Read <path1>, <path2>, … in full.` —
/// ATTACH_CONTRACT.md §6. An unreachable attachment is left out entirely: a
/// path handed to a model that cannot open it produces a turn spent
/// apologising (§7).
///
/// With `chatId`, the list is that chat's holdings, and a Read is named only
/// where it is in force here (R2): the record travels, and a Read it claims is a
/// claim until it is pressed on this device. Without, it is a Diamond's list of
/// marks already in force here.
export function attachPrefixText(list, chatId) {
	var notes = [], reads = [], root = rootHere();
	(list || []).forEach(function (a) {
		if (!refReachable(a.ref)) return;
		if (a.state !== 'read') { notes.push(a.path); return; }
		if (chatId) {
			var f = DaimondMarksHere.chatForce(chatId, a, root);
			if (!f || !f.read) return;
		}
		reads.push(a.path);
	});
	var out = [];
	if (notes.length) out.push(t('attach.prefix_note', { paths: notes.join(', ') }));
	if (reads.length) out.push(t('attach.prefix_read', { paths: reads.join(', ') }));
	return out.length ? out.join('\n') + '\n' : '';
}

// Where a quoted file starts and stops. A fence rather than a sentence, so no
// closing word needs translating and nothing in the file can be mistaken for the
// end of it; four backticks because three are what a file of code contains.
var ATTACH_FENCE = '````';
// How much of one file is quoted. A person who presses Read on a 40 MB log has
// asked for something the composer cannot hold and the model would not read; the
// cut is said in words rather than made silently.
var ATTACH_READ_MAX = 40000;

/// The CONTENTS of everything marked Read, quoted under the prefix.
///
/// **The app quotes the file rather than telling the model to open it**, and the
/// reason is the fence. `Read notes/spec.md in full.` was an instruction the app
/// then refused to let the model carry out: a chat may open only what is marked
/// into its workspace, and Read grants no reach. So the very first Read a user
/// pressed produced a refusal caused by the app itself.
///
/// Quoting is also what Read has always claimed to be — "the contents are wanted
/// now" — it costs the same tokens, it saves a round trip, and it is the whole
/// point of separating the two ideas: a file the chat may QUOTE need not be a
/// folder the chat may CHANGE.
///
/// Read through `Wasm.read_file`, the raw door, and NOT through the `file_read`
/// TOOL: the tool is model-facing and numbers every line, so the tool's answer
/// quoted into a prompt is the user's file with a gutter down it that nobody
/// asked for. This project has shipped that mistake twice. The raw door is also
/// unfenced, which is right here: it is the USER quoting their own file into
/// their own message, and the fence governs what the MODEL may open on its own.
/// A file that will not read is passed over in silence; it is still named in the
/// prefix line above.
///
/// **Only a Read pressed on this device** (R2). The chat record rides the sync
/// parcel, so a record carrying a Read of a file the user never chose would
/// otherwise quote it into their message through this unfenced door.
///
/// # Arguments
/// * `list` - A chat's holdings.
/// * `chatId` - The chat they are held by; without it nothing is quoted.
async function attachReadBodies(list, chatId) {
	var root = rootHere();
	var want = (list || []).filter(function (a) {
		if (!chatId || a.state !== 'read' || !a.path) return false;
		var f = DaimondMarksHere.chatForce(chatId, a, root);
		return !!(f && f.read);
	});
	var out = '';
	for (var i = 0; i < want.length; i++) {
		var body = null;
		try { body = await Wasm.read_file(want[i].path); }
		catch (e) { noteFolderLost(e); body = null; }
		if (typeof body !== 'string') continue;
		var cut = body.length > ATTACH_READ_MAX;
		out += '\n' + t('attach.read_block', { path: want[i].path }) + '\n'
			+ ATTACH_FENCE + '\n'
			+ (cut ? body.slice(0, ATTACH_READ_MAX) : body).replace(/\n?$/, '\n')
			+ ATTACH_FENCE + '\n';
		if (cut) out += t('attach.read_cut', { path: want[i].path }) + '\n';
	}
	return out;
}

var attachPrefixSeq = 0;			// the latest `syncAttachPrefix`; an older one landing late is dropped

// A single `Note …` / `Read …` line, the shape `attachPrefixText` builds one
// of. Used only as the LOOSE fallback below, for a draft whose attach list
// has since changed so the exact text can no longer be recomputed to match.
var ATTACH_PREFIX_LOOSE_LINE = /^(?:Note|Read) [^\n]*\n/;

/// A draft written before 5ede1ba could pick up one more copy of the attach
/// prefix every reload or unlock (owner report, 2026-09-13: six stacked
/// copies on one chat). This collapses what is ALREADY sitting in storage,
/// once, on restore — `syncAttachPrefix` itself only ever seeds one
/// copy now, but a draft corrupted before that fix is not self-healing.
///
/// `current` is what `attachPrefixText` would build for this thread RIGHT
/// NOW — reused, so an exact repeat is recognised by the rule that
/// generates it rather than a re-guessed pattern — and is tried first,
/// as a whole unit, so a legitimate single seed that pairs one Note line
/// with one Read line is never mistaken for two stacked copies. Only when
/// that finds nothing does the loose single-line fallback run, for a draft
/// whose attach list no longer matches what it was written under.
///
/// A thread with turns keeps NONE of it back — the prefix belongs only to
/// a first turn, and one already happened here whether or not this ever
/// got to run before now. A thread with none keeps exactly one copy, so a
/// still-unstarted chat is not left with no seed at all.
export function scrubAttachPrefixDup(text, current, hasTurns) {
	if (typeof text !== 'string' || !text) return text;
	var rest = text, copies = 0, block = '';
	if (current) {
		while (rest.indexOf(current) === 0) { rest = rest.slice(current.length); copies++; }
		block = current;
	}
	if (!copies) {
		var m = text.match(ATTACH_PREFIX_LOOSE_LINE);
		if (m) {
			block = m[0];
			rest = text;
			while (rest.indexOf(block) === 0) { rest = rest.slice(block.length); copies++; }
		}
	}
	if (!copies) return text;                     // no prefix here at all: nothing to scrub
	// A STARTED thread keeps none of it back, however many copies are stacked --
	// the one-copy case included. A single copy left alone here (the old
	// `copies < 2` return) is exactly the keeper the owner kept hitting on
	// gilgamesh: `composerDraft` restores it on every boot, this scrub leaves
	// it standing because there is only one, and `composerDraft` re-persists
	// it as a draft for ever.
	if (hasTurns) return rest;
	if (copies < 2) return text;                  // unstarted, already just the one: leave it
	return block + rest;                          // unstarted with several: collapse to one
}

/// Work out the attach prefix the focused thread's first message will carry (HATE-10), and
/// keep it on the thread as `_attachPre`, which `pushUserRecord` takes into that message's
/// note: beside the words and never in them, so the composer holds only what was typed.
/// Transient, like `_draft`, and kept out of the store by `slimChat`'s whitelist. Called
/// wherever the attachment set or the focus changes.
///
/// `threadStarted`, not `current.messages.length` and not `chatMsgCount` alone: a chat
/// just opened from the rail is often not yet RESIDENT (seq 213), and a daimon chat that
/// arrived by SYNC metadata-only reads `chatMsgCount` as zero for good.
export async function syncAttachPrefix() {
	var f = attachFocus();
	if (!f) return;
	var mine = ++attachPrefixSeq;
	var thread = pg.current;			// the thread in focus now; `current` may move during the awaits
	if (!thread) return;
	if (threadStarted(thread)) { delete thread._attachPre; return; }
	var list;
	if (f.kind === 'chat') {
		list = chatAttachList(f.id);
	} else {
		var links = [];
		try { links = JSON.parse(await diamondApp().links_touching('diamond:' + f.id) || '[]'); }
		catch (e) { links = []; }
		pruneAttachState(links.map(function (l) { return l.id; }));
		list = [];
		links.forEach(function (l) {
			// A mark in force here, `holds` once the record has had its say (R2).
			var fz = markForce(f.id, l);
			if (!fz || fz.rel !== 'holds') return;
			var p = parseRef(l.other);
			if ((p.kind !== 'file' && p.kind !== 'dir') || !p.path) return;
			list.push({ ref: l.other, path: p.path, state: readAttachState(l.id) });
		});
	}
	var text = attachPrefixText(list, f.kind === 'chat' ? f.id : '');
	// A CHAT quotes what it marked Read; a Diamond does not. A daimon may open
	// everything its Diamond holds, so the instruction there is one it can carry
	// out, and quoting the same file into a seeded composer would pay for it
	// twice. Two surfaces, one control, and the difference is the fence.
	if (text && f.kind === 'chat') text += await attachReadBodies(list, f.id);
	if (mine !== attachPrefixSeq || threadStarted(thread)) return;
	if (text) thread._attachPre = text;
	else delete thread._attachPre;
}

/// One tile in a footer or a panel, in whichever view is chosen. The
/// crystal's footer (`renderArtefacts`), the chat's
/// (`renderChatAttachments`) and the Trash panel all draw it, so a chat's
/// footer shows exactly what the crystal footer shows (§5) and the trash
/// shows the same tile again rather than a second one that resembles it
/// (§9).
///
/// # Arguments
/// * `item.kind`    - 'file', 'dir', 'url', 'chat', 'diamond' — the badge.
/// * `item.path`    - shown, and named in the generated prefix. A caller
///   whose subject has a name rather than a path passes the name.
/// * `item.hint`    - said on hover where the tile has no room for it.
/// * `item.shut`    - there is NO opening this one, for the reason below.
/// * `item.reason`  - why, in a sentence, drawn on the tile.
/// * `item.note`    - a quiet line of FACTS about it: a date, a size.
/// * `item.state`   - 'note' | 'read', or nothing for a tile that has neither.
/// * `item.view`    - force 'stack' or 'icons'; otherwise the user's choice.
/// * `item.actions` - extra controls, in the caller's order:
///   `{ cls, text, title, aria, pressed, on }`.
/// * `item.onOpen`, `onRefer`, `onState`, `onDrop` - each optional; a tile
///   grows only the controls it is given.
export function attachTile(item) {
	// The user's choice of view belongs to the ATTACHMENT footers, which is
	// where the toggle that sets it lives. A caller with no toggle of its own
	// says which view it wants and is not silently switched into the other
	// one by a preference set somewhere else — the Trash panel's tiles carry
	// a date and a size that an 88px cell cannot show, and it has no control
	// to get back with.
	var icons = (item.view || attachView()) === 'icons';
	// One item, two shapes, ONE function. A second function per view is how
	// the crystal footer and the chat footer came to disagree in the first
	// place -- and §9's trash arrived wanting a third caller, not a third
	// renderer.
	//
	// `shut` is not "away": it is "there is no opening this", which is what
	// §7's unreachable attachment and §9's trashed Diamond have in common,
	// and §9 says to build it once. The reason is drawn as TEXT and not
	// only as a hover title, because a tooltip is unavailable to a touch
	// and an item that is silently inert on a phone is the empty-folder
	// failure this exists to end.
	var row = document.createElement('div');
	row.className = (icons ? 'attach-icon' : 'arte-row') + (item.shut ? ' shut' : '');

	var tag = document.createElement('span');
	tag.className = 'arte-kind';
	if (icons) tag.appendChild(kindIcon(item.kind === 'dir' ? 'dir' : 'file'));
	else tag.textContent = item.kind;
	if (icons) tag.setAttribute('aria-hidden', 'true');
	row.appendChild(tag);

	var name = document.createElement(item.onOpen && !item.shut ? 'button' : 'span');
	name.className = 'arte-open' + (item.shut ? ' away' : '');
	name.textContent = icons ? attachLeaf(item.path) : item.path;
	// `hint` is the crystal footer's relation -- `holds`, `produced`,
	// `consulted` -- which says how a thing got here, and is worth a
	// hover where it will not fit on the tile.
	name.title = item.reason || item.hint || item.path;
	if (name.tagName === 'BUTTON') {
		name.type = 'button';
		name.addEventListener('click', function (ev) { ev.stopPropagation(); item.onOpen(); });
	}
	row.appendChild(name);

	if (item.reason) {
		var why = document.createElement('span');
		why.className = 'arte-why';
		why.textContent = item.reason;
		row.appendChild(why);
	}

	// The facts about the item, on a line of their own BELOW the reason.
	// Its own element rather than words added to `reason`, because the two
	// are different kinds of thing -- one says why this cannot be opened,
	// the other what keeping it costs and until when -- and anything reading
	// the reason has to find the reason and nothing else. It wraps for the
	// same reason `.arte-why` does: a dock column is narrow, and a fact the
	// user is meant to act on may not be the thing that gets shortened.
	if (item.note) {
		var note = document.createElement('span');
		note.className = 'arte-note';
		note.textContent = item.note;
		row.appendChild(note);
	}

	if (item.state) {
		var read = item.state === 'read';
		var stateBtn = document.createElement('button');
		stateBtn.type = 'button';
		stateBtn.className = 'attach-state' + (read ? ' read' : '');
		stateBtn.textContent = t(read ? 'attach.read' : 'attach.note');
		stateBtn.title = t(read ? 'attach.read_help' : 'attach.note_help');
		stateBtn.setAttribute('aria-pressed', read ? 'true' : 'false');
		stateBtn.addEventListener('click', function (ev) { ev.stopPropagation(); item.onState(); });
		row.appendChild(stateBtn);
	}

	// Controls this component has no name for, in the caller's own order.
	// Note/Read, refer and drop are the attachment footers' verbs and stay
	// named above, because a footer's own controls should not be assembled
	// from a list. A THIRD caller with a third verb -- the trash's Restore --
	// would otherwise need either a fourth named slot that two of the three
	// callers never use, or a second renderer. Before the refer arrow and
	// the drop cross, so `×` stays where it is on every other tile in the
	// app: last.
	(item.actions || []).forEach(function (a) {
		if (!a) return;
		var b = document.createElement('button');
		b.type = 'button';
		b.className = a.cls || 'arte-act';
		b.textContent = a.text || '';
		if (a.title) b.title = a.title;
		if (a.aria) b.setAttribute('aria-label', a.aria);
		if (a.pressed !== undefined) b.setAttribute('aria-pressed', a.pressed ? 'true' : 'false');
		b.addEventListener('click', function (ev) { ev.stopPropagation(); a.on(); });
		row.appendChild(b);
	});

	// The refer arrow is the crystal footer's own: it puts a reference in the
	// composer. A chat has nothing to refer to that its prefix does not
	// already name, so it passes none and the tile simply has no arrow.
	if (item.onRefer) {
		var useBtn = document.createElement('button');
		useBtn.type = 'button';
		useBtn.className = 'arte-use';
		useBtn.textContent = '↳';
		useBtn.title = t('arte.refer_help');
		useBtn.addEventListener('click', function (ev) { ev.stopPropagation(); item.onRefer(); });
		row.appendChild(useBtn);
	}

	if (item.onDrop) {
		var drop = document.createElement('button');
		drop.type = 'button';
		drop.className = 'arte-drop';
		drop.textContent = '×';
		drop.title = t('arte.drop_help');
		drop.setAttribute('aria-label', t('arte.drop_named', { name: item.path }));
		drop.addEventListener('click', function (ev) { ev.stopPropagation(); item.onDrop(); });
		row.appendChild(drop);
	}

	return row;
}

/// The last segment of a path — what an icon has room to say.
function attachLeaf(path) {
	var s = String(path || '');
	var i = s.lastIndexOf('/');
	return i < 0 ? s : s.slice(i + 1);
}

// ── The footer, and the chrome both footers wear ───────────────────
//
// ATTACH_CONTRACT.md §5 gives a Diamond's crystal footer and a chat's
// `#chat-attachments` the same three additions: a cap past which the stack
// scrolls, a view toggle, and a `+`. They get them by BEING the same
// component -- `renderAttachFooter` draws both -- rather than by two
// renderers being kept in step, which is a promise nobody can keep.

// Which view the footer is in, remembered PER USER and not per Diamond
// (§5), so it is a device preference, and not a property of the thing
// being looked at.
var ATTACH_VIEW_KEY = 'daimond-attach-view';
// This session's answer, held in memory as well as in storage, so that the
// toggle still works where `localStorage` throws -- a private window, or a
// browser with site data switched off. Reading the store on every render
// would make the control silently inert there, which is worse than not
// remembering the choice.
var attachViewNow = null;

function attachView() {
	if (attachViewNow) return attachViewNow;
	try { attachViewNow = localStorage.getItem(ATTACH_VIEW_KEY) === 'icons' ? 'icons' : 'stack'; }
	catch (e) { attachViewNow = 'stack'; }
	return attachViewNow;
}
function setAttachView(v) {
	attachViewNow = v === 'icons' ? 'icons' : 'stack';
	try { localStorage.setItem(ATTACH_VIEW_KEY, attachViewNow); }
	catch (e) { /* private mode: the choice holds for this session only */ }
	renderChatAttachments();
	renderArtefacts();
}

// ── The two folds in a footer, remembered on this device ────────────
//
// D-20261008-04: the workspace list and the linked diamonds were drawn open (a chat's
// list) or one full row each (a diamond's two strips), and the transcript paid for it.
// Both now sit behind a toggle that starts shut. The choice is a device preference, like
// the view above, so it lives in the same kind of place and is held the same way: in
// memory as well as in storage, so the toggle still works where `localStorage` throws.
//
// `ws` is a chat's workspace list. A Diamond's crystal list shared it until UNBLOCK-49 and
// now has a fold of its own per Diamond (`crystalFilesOpen`, below).
var FOOT_KEYS = { ws: 'daimond-foot-ws', links: 'daimond-foot-links' };
var footNow   = {};
export function footOpen(k) {
	if (footNow[k] === undefined) {
		try { footNow[k] = localStorage.getItem(FOOT_KEYS[k]) === '1'; }
		catch (e) { footNow[k] = false; }
	}
	return footNow[k];
}
export function setFootOpen(k, on) {
	footNow[k] = !!on;
	try { localStorage.setItem(FOOT_KEYS[k], on ? '1' : '0'); }
	catch (e) { /* private mode: the choice holds for this session only */ }
}

// THE CRYSTAL'S FILE LIST IS PER DIAMOND (UNBLOCK-49, D-20261027-02: "the file list that
// grows underneath the crystal view can become so big as to completely obscure it"). It
// left the shared `ws` key above: one Diamond holding two hundred files and another
// holding three want different answers, and a device-wide fold gave them one. A chat's
// workspace list keeps `ws`.
var CRYSTAL_FILES_KEY = 'daimond-crystal-files:';
var crystalFilesNow   = {};
/// Is this Diamond's file list open on this device? Unchosen, it is open only while all
/// `n` files fit under `cap`, so a long list never arrives drawn over the crystal; a cap
/// the stylesheet did not give (NaN) answers shut.
function crystalFilesOpen(id, n, cap) {
	if (crystalFilesNow[id] === undefined) {
		var v = null;
		try { v = localStorage.getItem(CRYSTAL_FILES_KEY + id); }
		catch (e) { /* private mode: nothing stored */ }
		if (v !== '1' && v !== '0') return n <= cap;   // no choice made: follow the count
		crystalFilesNow[id] = v === '1';
	}
	return crystalFilesNow[id];
}
export function setCrystalFilesOpen(id, on) {
	crystalFilesNow[id] = !!on;
	try { localStorage.setItem(CRYSTAL_FILES_KEY + id, on ? '1' : '0'); }
	catch (e) { /* private mode: the choice holds for this session only */ }
}

/// The bar above the tiles: the view toggle, and `+`.
///
/// It carries no count. The crystal footer already has one on the strip
/// that opens it, and a number printed twice a few pixels apart is a
/// number the reader has to check against itself.
/// # Arguments
/// * `o.title` - What this band names, where it heads a GROUP rather than a whole
///   footer. A group without a name is two lists of tiles nobody can tell apart.
/// * `o.help`  - The one sentence the title says on hover.
/// * `o.view`  - `false` to leave the view toggle off this band.
/// * `o.add`   - `false` to leave the `+` off it.
/// * `o.fold`  - `{ open, text, help, onClick }` to put a fold toggle at the band's left,
///   in the strip drawing the diamond footer uses, so that the band IS the collapsed row.
function attachFooterHead(o) {
	o = o || {};
	var head = document.createElement('div');
	head.className = 'attach-head' + (o.title ? ' attach-group-head' : '') + (o.fold ? ' attach-fold' : '');

	if (o.fold) {
		var fold = document.createElement('button');
		fold.type = 'button';
		fold.className = 'arte-strip foot-toggle';
		fold.dataset.act = 'foot-fold';
		fold.setAttribute('aria-expanded', o.fold.open ? 'true' : 'false');
		markName(fold, o.fold.text);
		if (o.fold.help) fold.title = o.fold.help;
		fold.addEventListener('click', function (ev) { ev.stopPropagation(); o.fold.onClick(); });
		head.appendChild(fold);
	}

	if (o.title) {
		var name = document.createElement('span');
		name.className = 'attach-group-title';
		name.textContent = o.title;
		if (o.help) name.title = o.help;
		head.appendChild(name);
	}

	// One control, two positions -- not two buttons, one of which is always
	// inert. Its word is the view it will GIVE you, which is the only thing
	// a person wants to know before pressing it.
	if (o.view !== false) {
		var to = attachView() === 'icons' ? 'stack' : 'icons';
		var view = document.createElement('button');
		view.type = 'button';
		view.className = 'attach-view-btn';
		view.dataset.act = 'attach-view';
		view.dataset.view = to;
		view.textContent = t(to === 'icons' ? 'attach.view_icons' : 'attach.view_stack');
		view.title = view.textContent;
		view.setAttribute('aria-label', view.textContent);
		view.addEventListener('click', function (ev) { ev.stopPropagation(); setAttachView(to); });
		head.appendChild(view);
	}

	if (o.add !== false) {
		// A CONTROL MEANS WHAT ITS POSITION SAYS, this used to argue, and it was
		// true of whoever laid the panel out and false of everybody else. Two `+`
		// buttons a few pixels apart read the same, one of them granting a daimon
		// the run of a folder and the other putting a file in front of a model,
		// and the only difference on screen was a tooltip. On 2026-08-23 the owner
		// could not find the control that marks a folder in; neither could the
		// agent sent to read the source.
		//
		// Worse, the position was not even the whole answer. The crystal footer's
		// `+` passes no `mark` and was labelled "Attach", while on a Diamond every
		// folder it adds becomes a mark anyway -- `Files.attachAdd` writes a
		// `holds` link and `Files.bounds` turns each of those into an
		// `OnlyWriteUnder`. So the word is asked of the FOCUS as well as the group,
		// through one function the picker reads too, and a `+` that widens a fence
		// wears the accent that every other granting control in the app wears.
		var grants = attachAddGrants(o);
		var add = document.createElement('button');
		add.type = 'button';
		add.className = 'attach-add' + (grants ? ' grants' : '') + (o.icon ? ' icon' : '');
		add.dataset.act = 'attach-add';
		add.dataset.grants = grants ? '1' : '';
		if (o.icon) {
			add.textContent = '+';
		} else {
			add.textContent = '+ ' + t(grants ? 'attach.add_mark' : 'attach.add');
		}
		add.title = grants ? t('attach.ws_add') : t('attach.add');
		add.setAttribute('aria-label', add.title);
		add.addEventListener('click', function (ev) {
			ev.stopPropagation();
			attachPicker({ mark: !!o.mark });
		});
		head.appendChild(add);
	}

	return head;
}

/// Does pressing this `+` widen what the thing in focus may reach?
///
/// The group is half the answer and the FOCUS is the other half. A chat's
/// workspace group marks what it adds and its prompt group does not; a Diamond
/// marks whatever is added from anywhere, because there is only one mechanism
/// on that surface and attaching IS marking. One function, so the word the
/// button wears and the words the picker says cannot come apart.
function attachAddGrants(o) {
	var f = attachFocus();
	if (!f) return false;
	if (f.kind === 'diamond') return true;
	return !!(o && o.mark);
}

/// A scrolling region is a keyboard stop while it scrolls, and not otherwise.
///
/// With more than fits, the keyboard has no other way to the rows past the edge
/// (axe `scrollable-region-focusable`). With nothing to scroll, a stop is a place
/// Tab lands and nothing happens, which reads as a dead control. So the stop is set
/// from the box's own size and read again when the box is resized or its content
/// changes. Attribute writes are not watched, so the write cannot wake its own reader.
function scrollStop(el) {
	var ro = null, mo = null, seen = false;
	function mark() {
		if (el.isConnected) seen = true;
		else if (seen) {
			// Drawn again elsewhere and this one dropped: let the observers go.
			if (ro) ro.disconnect();
			if (mo) mo.disconnect();
			return;
		}
		if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) el.tabIndex = 0;
		else el.removeAttribute('tabindex');
	}
	if (typeof ResizeObserver !== 'undefined') {
		ro = new ResizeObserver(mark);
		ro.observe(el);
	}
	if (typeof MutationObserver !== 'undefined') {
		mo = new MutationObserver(mark);
		mo.observe(el, { childList: true, subtree: true, characterData: true });
	}
	mark();
}

/// The scrolling box of tiles, in whichever view is chosen.
///
/// Its own function because a chat's footer has TWO of them -- the workspace and
/// the attachments -- and a second copy of the scroll region is how the two would
/// come to scroll, name and cap themselves differently.
function attachBody(items, o) {
	o = o || {};
	var icons = !o.stack && attachView() === 'icons';
	var body = document.createElement('div');
	body.className = (o.cls || 'attach-body') + (icons ? ' icons' : '');
	// A scrolling region needs a name, or a screen reader announces "group"
	// and nothing else; it is a keyboard stop only while it scrolls.
	body.setAttribute('role', 'group');
	body.setAttribute('aria-label', o.label || t('attach.list'));
	items.forEach(function (it) { body.appendChild(attachTile(it)); });
	scrollStop(body);
	return body;
}

/// Draw a footer: the chrome, then the tiles, in whichever view is chosen.
///
/// The tiles go in their own scrolling box rather than the footer itself
/// scrolling, so the toggle and the `+` stay put while the stack moves
/// under them -- chrome that scrolls away is chrome nobody finds twice.
function renderAttachFooter(box, items) {
	box.innerHTML = '';
	box.appendChild(attachFooterHead());
	var body = attachBody(items);
	box.appendChild(body);
	return body;
}

/// Which workspace is open, in the app's own words — the ones the account strip
/// and the guide already use for it, so the footer is not a second vocabulary
/// for one idea.
function workspaceTitle() {
	return t(currentRoot().kind === 'machine'
		? 'astat.workspace_native' : 'astat.workspace_browser');
}

/// The chat footer: `#chat-attachments`, above the composer. TWO GROUPS,
/// workspace first, because they are two different kinds of claim:
///
///  * **The workspace** is what this chat may READ AND CHANGE. Its meaning is
///    COLLECTIVE — take a folder out and the fence shrinks — so it is drawn as
///    one bounded thing made of parts rather than as tiles that happen to be
///    adjacent, and it is the stack whatever view the tiles below it are in.
///  * **The attachments** are what has merely been put in front of the model.
///    Each is its own decision: drop one and nothing about reach changes.
///
/// A folder that is both wears both marks and appears ONCE, in the workspace:
/// the groups are by primary role, not a partition of the record.
///
/// **THE WORKSPACE GROUP IS DRAWN WHEN IT IS EMPTY**, which is the state that
/// most needs saying — the chat can reach nothing, and the control that fixes
/// that lives in this group's own header. The crystal footer hid itself at zero
/// until 4216383 and took the `+` inside it out of reach in exactly the state it
/// exists for; this is that lesson, not a second discovery of it.
export function renderChatAttachments() {
	// The notice over the composer is about the same holdings, on either surface, and
	// is redrawn wherever they are: every focus change, root switch and language change
	// comes through here. The Workspace focus section is about the same focus.
	renderMarkNotice();
	try { Files.renderFocus(); } catch (e) { /* the panel is not built yet */ }
	var box = document.getElementById('chat-attachments');
	if (!box) return;
	var f = attachFocus();
	if (!f || f.kind !== 'chat') { box.innerHTML = ''; box.style.display = 'none'; return; }
	var held = chatAttachList(f.id);
	var marked = [], noted = [];
	held.forEach(function (a) { (a.ws ? marked : noted).push(a); });

	/// One holding as a tile, whichever group it is in. The SAME component the
	/// crystal footer and the Trash panel draw, so the three cannot drift.
	var toTile = function (a) {
		var away = !refReachable(a.ref);
		// Claiming a mark or a Read nobody pressed here (R2): it opens, and says
		// why it grants nothing yet. The notice above the composer offers the press.
		var wait = !away && DaimondMarksHere.chatWaiting(f.id, a, rootHere());
		return {
			kind:   a.dir ? 'dir' : 'file',
			path:   a.path,
			// Attached from a workspace that is not open: there is nothing to
			// open, and the tile says where it lives instead (§7). In the CHAT's
			// own words: `dws.not_here` says "kept with this Diamond" and "its
			// daimon", which named the wrong thing entirely on a surface where
			// there is no Diamond and no daimon.
			shut:   away,
			reason: away ? t('attach.not_here', { where: refWhere(a.ref) }) : (wait ? t('marks.waiting_why') : ''),
			state:  a.state,
			// Folders take the chosen view like files do: the icon toggle above
			// governs the whole list, so a folder gets an icon cell in icon view
			// rather than being pinned to a row of its own.
			// A folder in the workspace list is obviously in the workspace, so it
			// wears no redundant "Workspace" chip -- the row is the claim, and the
			// × takes it back out. Reach is untouched: the a.ws flag still drives
			// `scopeChatTo`; only the pointless toggle is gone from the row.
			actions: [],
			onState: function () { chatAttachSetState(f.id, a.ref, a.state === 'read' ? 'note' : 'read'); },
			// The × TAKES IT OFF, and only that. Through the paperclip's toggle it
			// confirmed a holding waiting here, so a person removing a mark they did
			// not recognise granted it write reach and a Read instead (QA 2026-09-24, F7).
			onDrop:  function () { chatAttachRemove(f.id, a.ref); },
		};
	};

	box.style.display = '';
	box.innerHTML = '';

	// ── One list ───────────────────────────────────────────────────
	//
	// Two sections, and a heading over each, is what the owner objected to on
	// 2026-08-24: "apparently separated folder and file inclusion between
	// 'WORKSPACE MACHINE' and 'IN FRONT OF THE MODEL'. I hate that." He is
	// right, and the reason is in the tiles rather than in his taste. Every row
	// already says which claim it is making -- `Note` or `Read` for the cost,
	// and a `Workspace` pill, pressed or not, on a folder -- so a heading over
	// each half restated the rows and charged him a split list for it.
	//
	// WHAT A HEADING SAID AND A ROW DOES NOT is one thing only: which
	// workspace, browser or machine, the marks belong to. That is not lost --
	// the account strip says it in the same words (`astat.workspace_*`) and a
	// tile that lives in the OTHER one already says so on itself, through
	// `attach.not_here`. So it is said once now instead of twice.
	//
	// The head band stays, without a title in it: the `+` lives there, and the
	// lesson of 4216383 is that the control which ends the empty state must be
	// reachable FROM the empty state.
	//
	// The view toggle KEEPS its place on that band. It governed the lower group
	// alone before, and it governs the one list now -- with marked folders
	// staying full-width rows either way, through the per-tile `view` that
	// `attachTile` already reads. An 88px icon cell has no room for the
	// `Workspace` pill, and the pill is the whole of what tells the fence from
	// the prompt now that the headings are gone.
	//
	// D-20261008-04: the band is also the COLLAPSED footer. The list sits behind the
	// toggle at its left and starts shut; the `+` stays on the band in both states, which
	// is the 4216383 lesson kept (the control that ends the empty state is reachable
	// from the empty state). The view toggle has nothing to act on while shut, so it
	// waits for the list.
	var wsOpen = footOpen('ws');
	var ws = document.createElement('section');
	ws.className = 'attach-group ws-group' + (wsOpen ? '' : ' folded');
	ws.appendChild(attachFooterHead({
		help:  t('attach.ws_help'),
		mark:  true,
		// A `+` here reads as a `+` and nothing else. The two buttons that
		// could be confused are in different places, and it is the crystal
		// footer's that grants -- see `attachFooterHead`.
		icon:  true,
		view:  wsOpen,
		fold:  {
			open:    wsOpen,
			text:    held.length ? tn('dws.count', held.length) : t('dws.none_yet'),
			help:    t('attach.ws_help'),
			onClick: function () {
				setFootOpen('ws', !wsOpen);
				renderChatAttachments();
				renderArtefacts();
			},
		},
	}));
	if (!wsOpen) { box.appendChild(ws); return; }
	// Marked first, because the fence is the more consequential claim and a
	// reader scanning for "what can this chat reach" should not have to sort.
	var body = attachBody(marked.concat(noted).map(toTile),
		{ cls: 'ws-body', label: workspaceTitle() });
	if (!marked.length) {
		// The sentence the empty state exists to say, and it is said whenever
		// NOTHING IS MARKED IN -- not merely when the list is empty. A footer
		// holding three attached files and no mark is exactly the state that
		// reads as "the chat has my files" and is not.
		var none = document.createElement('div');
		none.className = 'rail-note ws-empty';
		none.textContent = t('attach.ws_empty');
		body.appendChild(none);
	}
	ws.appendChild(body);
	box.appendChild(ws);
}

// ── Marks not in force on this device ──────────────────────────────
//
// A mark applies only on the device it was made or confirmed on (owner decision,
// 2026-09-23), so at that deploy every mark on every desktop went inactive at once --
// and the only sign was the paperclip's tooltip, which a touch screen never shows,
// while the daimon met a plain refusal and reported the folder as out of bounds
// (audit finding 6). This says it where nobody can miss it: over the composer, on
// both faces of a Diamond and on a chat, naming each mark and where it was made,
// with the one press that brings it into force here.

var _markNoticeSeq = 0;

/// What the notice lists: the marks in focus that are not in force here, with the
/// press that confirms each. Empty with nothing in focus.
async function markNoticeItems() {
	var f = attachFocus();
	if (!f) return { focus: null, items: [] };
	if (f.kind === 'diamond') {
		var list = [];
		try { list = await Files.waiting(f.id); } catch (e) { list = []; }
		return { focus: f, items: list.map(function (a) {
			return { path: a.path, ref: a.ref, old: (a.link && !a.link.by) || false,
				confirm: function () { return confirmMarkHere(f.id, a.link); } };
		}) };
	}
	return { focus: f, items: chatWaiting(f.id).map(function (a) {
		return { path: a.path, ref: a.ref, old: false,
			confirm: function () { return Promise.resolve(chatConfirmHere(f.id, a.ref)); } };
	}) };
}

/// Draw the notice, or hide it where there is nothing to confirm. Called without an
/// await from every redraw, so it never rejects: a notice that cannot be drawn is hidden.
async function renderMarkNotice() {
	try { await drawMarkNotice(); }
	catch (e) {
		var box = document.getElementById('mark-notice');
		if (box) { box.innerHTML = ''; box.hidden = true; }
	}
}

async function drawMarkNotice() {
	var box = document.getElementById('mark-notice');
	if (!box) return;
	var seq = ++_markNoticeSeq;
	var got = await markNoticeItems();
	// The store was read across an await, and the user may have moved on.
	if (seq !== _markNoticeSeq) return;
	var items = got.items;
	box.innerHTML = '';
	// A record that is there but is not a record refuses every press (QA A F5), so
	// it is said instead of the list, with the one press that replaces it.
	if (DaimondMarksHere.damaged()) { drawMarksDamaged(box); return; }
	if (!items.length) { box.hidden = true; return; }
	box.hidden = false;
	box.dataset.count = String(items.length);

	var head = document.createElement('p');
	head.className = 'mark-notice-head';
	head.textContent = tn('marks.waiting', items.length);
	box.appendChild(head);
	var why = document.createElement('p');
	why.className = 'mark-notice-why';
	// With no record on this device at all -- the first start after R2, or
	// cleared site data -- that is the reason, and it is said instead.
	why.textContent = DaimondMarksHere.absent() ? t('marks.no_record') : t('marks.waiting_why');
	box.appendChild(why);

	// One press at a time: a second press while the first is still writing would
	// confirm a row the store has already rewritten.
	var busy = false;
	var press = async function (list) {
		if (busy) return;
		busy = true;
		box.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
		try {
			for (var i = 0; i < list.length; i++) {
				try { await list[i].confirm(); } catch (e) { /* the redraw says what took */ }
			}
		} finally {
			// Redrawn from the store, never from what was pressed. A Diamond's
			// confirmation also signals the links changed, which repaints the panel
			// and the fence row; a chat's repaints through `attachChanged`. A press
			// whose record did not land has said so (`marksNotSaved`) and still waits.
			busy = false;
			renderMarkNotice();
		}
	};

	items.forEach(function (it) {
		var row = document.createElement('div');
		row.className = 'mark-notice-row';
		row.dataset.path = it.path;
		var name = document.createElement('span');
		name.className = 'mark-notice-path';
		markName(name, it.path);
		name.title = it.path;
		row.appendChild(name);
		var where = document.createElement('span');
		where.className = 'mark-notice-where';
		where.textContent = it.old ? t('marks.made_before') : refWhere(it.ref);
		row.appendChild(where);
		var b = document.createElement('button');
		b.type = 'button';
		b.className = 'chip-btn accent';
		b.dataset.act = 'mark-use-here';
		b.textContent = t('marks.use_here');
		b.title = t('marks.use_help');
		b.setAttribute('aria-label', t('marks.use_here') + ': ' + it.path);
		b.addEventListener('click', function () { press([it]); });
		row.appendChild(b);
		box.appendChild(row);
	});
	if (items.length > 1) {
		var all = document.createElement('button');
		all.type = 'button';
		all.className = 'chip-btn accent mark-notice-all';
		all.dataset.act = 'mark-use-all';
		all.textContent = t('marks.use_all');
		all.addEventListener('click', function () { press(items); });
		box.appendChild(all);
	}
}

/// This device's marks record is damaged: say so, and offer the reset, asked first.
function drawMarksDamaged(box) {
	box.hidden = false;
	box.dataset.count = '0';
	var head = document.createElement('p');
	head.className = 'mark-notice-head';
	head.textContent = t('marks.damaged');
	box.appendChild(head);
	var b = document.createElement('button');
	b.type = 'button';
	b.className = 'chip-btn accent';
	b.dataset.act = 'mark-reset';
	b.textContent = t('marks.reset');
	b.addEventListener('click', async function () {
		if (!(await confirmDialog(t('marks.reset_ask'), t('marks.reset'), { title: t('marks.reset') }))) return;
		DaimondMarksHere.resetDamaged();
		renderMarkNotice();
	});
	box.appendChild(b);
}

/// The `+`: attach files and folders without leaving what you are reading.
///
/// ATTACH_CONTRACT.md §5 calls this a SUPPLEMENT to the Workspace panel,
/// not a replacement — so it browses the panel's own tree through the
/// panel's own listing, and does one thing the panel does not: several at
/// once, from where you already are.
/// # Arguments
/// * `opts.mark` - Also mark the FOLDERS it adds into the CHAT's workspace,
///   which is what the `+` in the workspace group means. It says nothing about
///   a Diamond, where attaching is already marking and this flag is not passed.
async function attachPicker(opts) {
	var f0 = attachFocus();
	if (!f0) return;			// no focus, nothing to attach to
	// TWO NAMES BECAUSE THEY ARE TWO QUESTIONS, and one name doing both was how a
	// picker came to say "Attach files and folders" while widening a write fence.
	// `wsMark` is the chat's own flag and is the one thing here a Diamond must not
	// have; `grants` is whether a folder ticked in this picker ends up inside a
	// fence at all, which on a Diamond is true however it was opened. The heading,
	// the legend and the button's word are read off `grants`, so the picker says
	// what will happen; only `chatAttachSetWorkspace` below reads `wsMark`.
	var wsMark = !!(opts && opts.mark) && f0.kind === 'chat';
	var grants = attachAddGrants(opts);
	var dir = '';
	var ticked = {};				// path -> { dir }
	var relist = null;				// the open picker's re-read of the folder it shows
	var picked;
	try { picked = await dialog({
		kind:  'pick',
		title: grants ? t('attach.pick_mark_title') : t('attach.pick_title'),
		okLabel: t(grants ? 'attach.select' : 'attach.add'),
		build: function (card, ctl) {
			if (grants) {
				// What a tick will DO, at the top of the thing doing it. A folder and
				// a file are ticked with the same box here and mean two different
				// things, and the row cannot say so without a legend per row.
				var note = document.createElement('div');
				note.className = 'attach-pick-note';
				note.textContent = t('attach.mark_note');
				card.appendChild(note);
			}
			var crumbs = document.createElement('div');
			crumbs.className = 'files-path attach-pick-path';
			card.appendChild(crumbs);
			var listEl = document.createElement('div');
			listEl.className = 'attach-pick';
			card.appendChild(listEl);
			// The yes acts only on a listing that is in and a choice that is made.
			// Pressed while the folder is still loading it would add nothing and
			// close, which reads as "added" (D-20261006-32).
			var loaded = false;
			var unread = false;
			function gate() {
				var why = DaimondAnswer.reasons.pick({ loaded: loaded, unread: unread,
					ticked: Object.keys(ticked).length });
				ctl.allow(!why, why ? t(why) : '');
			}
			var showing = 0;			// the latest `show`; an older one that lands late is dropped
			show('');
			// THE DISK AS IT IS NOW (HATE-8). Opening and entering a folder each read it
			// afresh, but a picker left open while a folder is made in a terminal kept the
			// listing it opened with until Workspace › Refresh. Coming back to the tab reads
			// the folder shown again, through the same listing; the ticks are kept by path.
			relist = function () { show(dir); };
			window.addEventListener('daimond:tabfocus', relist);
			async function show(next) {
				var mine = ++showing;
				dir = next || '';
				loaded = false; unread = false;
				gate();
				Files.crumbs(crumbs, t('panel.work'), dir, show);
				// The wait is SHOWN, with the app's own dots: an empty list while the
				// folder is read looked exactly like an empty folder.
				listEl.innerHTML = '';
				listEl.setAttribute('aria-busy', 'true');
				var wait = document.createElement('div');
				wait.className = 'chat-spinner attach-pick-loading';
				wait.setAttribute('role', 'status');
				wait.innerHTML = '<span class="chat-spinner-dot"></span>'
					+ '<span class="chat-spinner-dot"></span><span class="chat-spinner-dot"></span>';
				var waitSay = document.createElement('span');
				waitSay.className = 'chat-spinner-say';
				waitSay.textContent = t('files.loading');
				wait.appendChild(waitSay);
				listEl.appendChild(wait);
				var got = await Files.listing(dir);
				var rows = got.rows;
				// Whether each row is already attached, asked before the row is drawn
				// -- a tick that appears empty and is then found to be attached would
				// be a row that lies -- and asked of the store ONCE for the folder.
				var have = rows.length ? await Files.attachedAll(rows.map(function (e) {
					return { path: dir ? (dir + '/' + e.name) : e.name, dir: !!e.dir };
				})) : [];
				if (mine !== showing) return;
				listEl.innerHTML = '';
				listEl.removeAttribute('aria-busy');
				loaded = true; unread = !got.ok;
				gate();
				if (!got.ok || !rows.length) {
					var none = document.createElement('div');
					none.className = 'files-empty';
					none.textContent = got.ok ? t('attach.pick_empty') : t('attach.pick_unread');
					listEl.appendChild(none);
					return;
				}
				rows.forEach(function (e, j) {
					var full = dir ? (dir + '/' + e.name) : e.name;
					var row = document.createElement('div');
					row.className = 'attach-pick-row';

					var box2 = document.createElement('input');
					box2.type = 'checkbox';
					box2.className = 'attach-pick-tick';
					box2.dataset.path = full;
					// Already attached: shown ticked so the set reads honestly,
					// and fixed, because unticking here would mean OK both
					// attaches and detaches and nothing on the row says which.
					box2.checked = have[j] || !!ticked[full];
					box2.disabled = have[j];
					box2.title = have[j] ? t('attach.already') : t('attach.add');
					box2.setAttribute('aria-label', full);
					box2.addEventListener('change', function () {
						if (box2.checked) ticked[full] = { dir: !!e.dir };
						else delete ticked[full];
						gate();
					});
					row.appendChild(box2);

					// A folder is two things at once here: something to attach
					// whole, and something to walk into. The tick does the
					// first, the name does the second.
					var nameEl = document.createElement(e.dir ? 'button' : 'label');
					nameEl.className = 'attach-pick-name' + (e.dir ? ' dir' : '');
					kindName(nameEl, e.dir ? 'dir' : 'file', e.name);
					if (e.dir) {
						nameEl.type = 'button';
						nameEl.addEventListener('click', function () { show(full); });
					} else {
						nameEl.addEventListener('click', function () {
							if (box2.disabled) return;
							box2.checked = !box2.checked;
							box2.dispatchEvent(new Event('change'));
						});
					}
					row.appendChild(nameEl);
					listEl.appendChild(row);
				});
			}
			return { read: function () { return ticked; } };
		},
	}); }
	finally { if (relist) window.removeEventListener('daimond:tabfocus', relist); }
	if (!picked) return;
	var paths = Object.keys(picked);
	for (var i = 0; i < paths.length; i++) {
		await Files.attachAdd(paths[i], picked[paths[i]].dir);
		// A file cannot be marked in -- the workspace is a union of folders --
		// so it is attached and nothing more, whichever `+` was pressed.
		if (wsMark && picked[paths[i]].dir) {
			chatAttachSetWorkspace(f0.id, rootedRef('dir', paths[i]), true);
		}
	}
	// A Diamond's attachments are links, and everything that draws links
	// redraws off that one signal; a chat's are not, so it is told directly.
	attachChanged();
}

/// Everywhere the attachment set is drawn redraws: the chat footer, and the
/// note a fresh thread's first message carries.
export function attachChanged() {
	renderChatAttachments();
	syncAttachPrefix();
}
// page-split: install 121

/// Say why an artefact will not open, and say the two apart.
///
/// A file that was renamed or deleted and a path the fence closed look identical from
/// here, and they are not the same thing to the person in front of it: a deletion has
/// no next step, and a refusal has an exact one -- grant the folder to this Diamond, or
/// move the file into one it already holds. Told apart on the OUTCOME. There is no
/// wording either message could be read out of, which is the whole reason the outcome
/// travels.
function artefactMissing(r, path) {
	if (r && r.outcome === 'refused') {
		noticeDialog(t('arte.file_fenced'), t('arte.file_fenced_body'));
	} else {
		noticeDialog(t('arte.file_gone'), t('arte.file_gone_body', { path: path }));
	}
}

/// Show an artefact in whichever panel already owns that kind of thing.
///
/// A file that has since been renamed or deleted is said to be missing rather than
/// quietly doing nothing: a list of dead links that pretends otherwise is worse than no
/// list at all.
async function openArtefact(kind, rest) {
	if (kind === 'url') {
		if (window.DaimondWeb && DaimondWeb.open) DaimondWeb.open(rest);
		else window.open(rest, '_blank', 'noopener');
		return;
	}
	if (kind === 'file') {
		// An existence test, so the OUTCOME is the whole answer -- and a read the
		// fence refuses is not a file that is there.
		var fr = null;
		try { fr = await diamondApp().run_tool_outcome('file_read', JSON.stringify({ path: rest })); }
		catch (e) { fr = null; }
		if (!fr || fr.outcome !== 'done') { artefactMissing(fr, rest); return; }
		Files.open(rest);
		return;
	}
	// A folder in this Diamond's workspace: browsed in the panel that browses
	// folders, like a file is read in the panel that reads files.
	if (kind === 'dir') {
		var res = null;
		try { res = await diamondApp().run_tool_outcome('file_list', JSON.stringify({ path: rest })); }
		catch (e) { res = null; }
		if (!res || res.outcome !== 'done') {
			artefactMissing(res, rest);
			return;
		}
		try { DaimondPanels.markUsed('work'); DaimondPanels.show('work'); } catch (e) { /* no panels */ }
		Files.browse(rest);
		return;
	}
	if (kind === 'chat') {
		var chat = pg.chats.find(function (c) { return c.id === rest; });
		if (chat) { selectChat(chat); return; }
	}
	noticeDialog(t('arte.nothing_to_open'), t('arte.no_viewer', { kind: kind }));
}
// page-split: install 122

export function install() { // page-split: install
	// page-split: install 120
	/* var */ pg._histList = null;		// the History list last drawn
	// page-split: install 121

	// A Diamond's own links changing — attaching or detaching a folder or file,
	// or flipping a tile's Note ⇄ Read — can change what a still-fresh agent
	// would be seeded with.
	document.addEventListener('daimond-links-changed', function () {
		syncAttachPrefix();
		renderMarkNotice();
	});

	// ANOTHER TAB OF THIS ACCOUNT PRESSED A MARK, or took one off (markshere.js hears
	// the `storage` event). Every grant reads the record afresh, so what is left is
	// what a press here does: redraw everything that draws marks, and let each chat's
	// engine go, since an app holds the scope it was built with. A chat mid-turn keeps
	// its app and is re-scoped at its next turn (`dropChatApp`).
	window.addEventListener('daimond:markshere', function () {
		signalLinksChanged();
		pg.chats.forEach(function (c) { if (c && c.id) dropChatApp(c.id); });
		renderChatAttachments();
	});

	// A small surface for tests, and for anything that later wants to inspect or
	// drive an attachment from outside this module — same reason
	// `window.DaimondArtefacts` exists. `chatToggle` is also the only way to put
	// an unreachable (machine-rooted) chat attachment in place for a test: the
	// native folder picker that makes one for real cannot be driven headless
	// (see dev/verify_attachroot.mjs).
	window.DaimondAttach = {
		focus:        attachFocus,
		chatList:     chatAttachList,
		chatToggle:   chatAttachToggle,
		chatRemove:   chatAttachRemove,
		chatState:    chatAttachSetState,
		// The workspace mark: the one thing on a holding that widens the fence.
		// Published beside `chatState` so a verifier can prove the two are
		// INDEPENDENT -- that setting either leaves the other where it was.
		chatWs:       chatAttachSetWorkspace,
		// What a chat's worker may write in, and where it always may. Published
		// because it is exactly what `scopeChatTo` hands the engine, so a verifier
		// can ask what the fence was built from without dispatching anything.
		chatScope:    chatScopePaths,
		chatScratch:  chatScratchDir,
		// A chat's holdings as JSON, for an engine door that reads the marks itself.
		chatHolds:    chatHoldsJson,
		// Where a mark is in force, and the user's confirmation of another device's
		// mark on this one (2026-09-23): what the paperclip writes, whether a stored
		// reference is in force here, what the page says about where it lives, and
		// the press that brings it into force.
		ref:          rootedRef,
		reachable:    refReachable,
		where:        refWhere,
		// The workspace as this device's record of marks names it, id and all.
		root:         rootHere,
		confirmHere:  async function (diamondId, ref) {
			return confirmMarkHere(diamondId, await linkTo(diamondId, ref));
		},
		// THE ONE TEST, for a verifier: the grant this device holds on a Diamond's mark
		// on this reference, `{ rel, share }`, or null (R2).
		inForce:      async function (diamondId, ref) {
			return markForce(diamondId, await linkTo(diamondId, ref));
		},
		chatInForce:  function (chatId, ref) {
			var rec = chatAttachFind(chatId, ref);
			return rec ? DaimondMarksHere.chatForce(chatId, rec, rootHere()) : null;
		},
		chatConfirm:  chatConfirmHere,
		prefixText:   attachPrefixText,
		readBodies:   attachReadBodies,
		syncPrefix:   syncAttachPrefix,
		render:       renderChatAttachments,
		// The local, unsynced Note/Read map -- see its own comment above.
		diamondState:    readAttachState,
		diamondSetState: writeAttachState,
		// The footer's own chrome: which view it is in, and the `+` picker.
		view:         attachView,
		setView:      setAttachView,
		pick:         attachPicker,
	};
	// page-split: install 122

	// The strip is a reading of the Diamond's links, so it is stale the moment
	// they change -- and they change from three places now: a fold's harvest, the
	// ◈ on an open file, and the Workspace panel's tree. Redrawing on the signal
	// costs one read and removes the class of bug where a count is right
	// everywhere except the line the user is looking at.
	document.addEventListener('daimond-links-changed', function () { renderArtefacts(); });

	// A small surface for tests, and for anything that later wants to record an
	// artefact from outside a fold.
	window.DaimondArtefacts = {
		harvest: harvestArtefacts,
		render:  renderArtefacts,
		of:      artefactsIn,        // pure: messages -> [{ref, rel}]
	};
} // page-split: end install
