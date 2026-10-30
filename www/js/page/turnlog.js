// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
// page-split: end imports
// ── The chat log, read (P2.3a; design daimond_p2_turnlog_design_20261030 §2) ──
//
// Every turn, wherever it runs, writes its rows to the chat's numbered log, and the
// gateway orders them. This is the reading side: the rows above the chat's cursor are
// read, opened (the sealed body under the space key, AAD `daimond/chatlog/1`) and folded
// one at a time through the engine's TurnView (`turnview_apply`), which is the ONE
// end-of-turn decision. A turn has ended exactly when its view says so; nothing here
// reads a lease, a frame or a report to decide it. Rows are never parsed here: a `more`
// or a split body is the view's business, so the engine can change how a row is cut
// without this changing.
//
// What the view folds is drawn into the chat as messages keyed by `mid`, the chat's own
// message id, so a row that also arrives in the parcel is one message (`msgJoin`). The
// log orders them: each carries its row's `seq`, its `at` as `ts`, and the `member` who
// wrote it. While the turn is open its rows are provisional and the turn's state tile
// (the hand-off placeholder) stays last; at its end the rows stand real and `onEnd` is
// told, once.
//
// Kept free of page imports, so a node test can run it with the real wasm and stand-ins
// for the key and the door.

/// The chat's read cursor: the highest seq it has folded.
export function logCursor(chat) {
	return Math.max(0, +(chat && chat.logSeq) || 0);
}

/// The turn's state as this device's log has folded it: `{state: 'open'}` while its view is
/// held, `{state: 'ended', status}` once its end row folded (done | stopped | interrupted |
/// not_run), and null for a turn the log has not named here. Every end-of-turn check reads
/// this, never a lease, a frame or a report.
export function turnView(chat, turn) {
	var t = String(turn);
	if (chat && chat.logEnds && chat.logEnds[t]) return { state: 'ended', status: String(chat.logEnds[t]) };
	if (chat && chat.logViews && chat.logViews[t]) return { state: 'open' };
	return null;
}

/// Open the door's wire rows into `{head, body}` rows, in seq order. A row that does not
/// open (another key, a damaged body) is skipped and counted, never drawn.
///
/// `seal` is the wasm bridge (`DaimondSeal`), `unwrap(bytes, aad)` identity.js's
/// `unwrapBytesAad`.
export async function openRows(wires, seal, unwrap) {
	var aad = await seal.rowAad();
	var out = [], bad = 0;
	var list = (wires || []).slice().sort(function (a, b) { return (+a.seq || 0) - (+b.seq || 0); });
	for (var i = 0; i < list.length; i++) {
		var wire = JSON.stringify(list[i]);
		try {
			var plain = await unwrap(await seal.rowSealed(wire), aad);
			out.push(JSON.parse(await seal.rowOpen(wire, plain)));
		} catch (e) { bad++; }
	}
	return { rows: out, bad: bad, top: list.length ? (+list[list.length - 1].seq || 0) : 0 };
}

/// The messages a turn's view holds, as the chat stores them.
export function viewMessages(view) {
	var open = view.state !== 'ended';
	return (view.rows || []).map(function (f) {
		var m = {};
		var meta = f.meta;
		if (meta && typeof meta === 'object') for (var k in meta) m[k] = meta[k];
		m.mid     = f.mid;
		m.role    = f.role;
		m.content = f.text;
		m.iturn   = view.turn;
		m.seq     = f.seq;
		m.ts      = f.at;
		m.member  = f.member;
		if (f.daimon) m.daimon = f.daimon;
		if (open) m.provisional = 1;
		else delete m.provisional;
		return m;
	});
}

/// A Web page address a panel intent may carry: http(s) only and at most 2048
/// characters, or `''`. A runner names pages the asker's panel will navigate to, so a
/// `javascript:` or `blob:` address (which means nothing on another device) is refused.
export function uiWebUrl(v) {
	var u = (typeof v === 'string') ? v.trim() : '';
	return (u && u.length <= 2048 && /^https?:\/\//i.test(u)) ? u : '';		// fixed: the URL length browsers keep
}

/// The panel a tool row put on screen, as the asker opens it (P2.3a5, D-20261006-27):
/// `{ show, page }` for `file_show`, `{ web }` for `web_open`, else null. A runner turned
/// a handed-off turn's show to the asker's screen; the asker reads it here from the row's
/// name and args, which are off the log and so untrusted.
export function panelIntent(m) {
	if (!m || m.role !== 'tool_log' || (m.name !== 'file_show' && m.name !== 'web_open')) return null;
	var a;
	try { a = JSON.parse(String(m.args || '')); } catch (e) { return null; }
	if (!a || typeof a !== 'object') return null;
	if (m.name === 'web_open') {
		var web = uiWebUrl(a.url);
		return web ? { web: web } : null;
	}
	var path = (typeof a.path === 'string') ? a.path.slice(0, 1024) : '';		// fixed: the viewer's path cap
	if (!path) return null;
	var page = Math.floor(+a.page || 0);
	return { show: path, page: page > 0 ? page : 0 };
}

/// Draw one turn's view into `chat.messages`: its rows by mid (joined with a copy already
/// held, through `join`), a log row the view no longer holds (a `tomb`) taken out, and,
/// while the turn is open, its state tile moved after its last row.
///
/// `deps.join(prev, m)` is the message law (`msgJoin`); `deps.isTile(m, turn)` names the
/// turn's state tile.
/// `deps.onRows(chat, turn, fresh, changed)`, when given, is told the rows this draw added (none
/// already held, by mid) and the held ones an edit changed (a tool's result lands so), in the
/// view's order.
export function drawTurn(chat, view, deps) {
	var turn = String(view.turn);
	var rows = viewMessages(view);
	var want = {};
	rows.forEach(function (m) { want[String(m.mid)] = m; });
	var ms = (chat.messages || []).filter(function (m) {
		// A row this log drew earlier that the view has since dropped.
		return !(m && m.seq && String(m.iturn || '') === turn && !want[String(m.mid)]);
	});
	var at = {}, fresh = [], changed = [];
	ms.forEach(function (m, i) { if (m && m.mid != null) at[String(m.mid)] = i; });
	rows.forEach(function (m) {
		var i = at[String(m.mid)];
		if (i === undefined) { at[String(m.mid)] = ms.length; ms.push(m); fresh.push(m); return; }
		var was = ms[i];
		// The view is newer than its own earlier draw; a copy from elsewhere (the parcel)
		// meets it under the message law.
		ms[i] = (was && was.provisional && was.seq) ? m : deps.join(was, m);
		if (!was || was.content !== m.content || was.outcome !== m.outcome) changed.push(m);
	});
	if (view.state !== 'ended') {
		var last = 0;
		ms.forEach(function (m) { if (m && String(m.iturn || '') === turn && !deps.isTile(m, turn)) last = Math.max(last, +m.ts || 0); });
		ms = ms.map(function (m) {
			if (!m || !deps.isTile(m, turn) || (+m.ts || 0) > last) return m;
			var t = {};
			for (var k in m) t[k] = m[k];
			t.ts = last + 1;
			return t;
		});
	}
	ms.sort(function (x, y) {
		if ((x.ts || 0) !== (y.ts || 0)) return (x.ts || 0) - (y.ts || 0);
		var p = String(x.mid), q = String(y.mid);
		return p < q ? -1 : (p > q ? 1 : 0);
	});
	chat.messages = ms;
	if (deps.onRows) deps.onRows(chat, turn, fresh, changed);
}

/// Draw an ended turn's end from its `end` row, as the transcript drew each end before the
/// log: `done` and `stopped` add nothing (the rows stand); `interrupted` is the runner-lost
/// tile (`why: 'runner'`) on the turn's last answer, or an empty one where it has none;
/// `not_run` is the "not run" row with Retry (`isNotRunRow`), mid `<turn>-nr` as
/// `answerUnhanded` writes it, so a copy already held is joined, not doubled. Its reason is
/// the end's `not_run` (`{why, cause, to, name, said}`, the set fields only).
export function drawEnd(chat, view, deps) {
	var end = view.end || { status: view.status };
	var status = String(end.status || view.status || '');
	if (status !== 'interrupted' && status !== 'not_run') return;
	var turn = String(view.turn);
	var ms = (chat.messages || []).slice();
	var ask = '', last = 0, top = 0, ans = -1;
	ms.forEach(function (m, i) {
		if (!m) return;
		top = Math.max(top, +m.ts || 0);
		if (String(m.iturn || '') !== turn && String(m.mid) !== turn) return;
		last = Math.max(last, +m.ts || 0);
		if (m.role === 'user') ask = m.content || '';
		else if (m.role === 'assistant' && !deps.isTile(m, turn) && m.content) ans = i;
	});
	var tried = Array.isArray(end.tried) ? end.tried.slice() : [];
	var row;
	if (status === 'interrupted' && ans >= 0) {
		row = {};
		for (var k in ms[ans]) row[k] = ms[ans][k];
		row.interrupted = true;
		row.why = 'runner';
		row.itext = ask;
		if (tried.length) row.triedDevices = tried;
		ms[ans] = row;
		chat.messages = ms;
		return;
	}
	row = { role: 'assistant', content: '', interrupted: true, iturn: turn, itext: ask, ts: (last || top) + 1 };
	if (tried.length) row.triedDevices = tried;
	if (status === 'interrupted') {
		row.why = 'runner';
		row.mid = turn + '-end';
	} else {
		// The tag each build routes as one turn: a chat's lost turn, a Diamond's "not run".
		row.why = chat.diamondId ? 'notrun' : 'runner';
		row.mid = turn + '-nr';
		var nr = end.not_run || {};
		row.notRun = { why: String(nr.why || 'not_run'), unable: false };
		['cause', 'to', 'name', 'said'].forEach(function (f) { if (nr[f]) row.notRun[f] = String(nr[f]); });
	}
	for (var i = 0; i < ms.length; i++) {
		if (ms[i] && String(ms[i].mid) === row.mid) { ms[i] = deps.join(ms[i], row); chat.messages = ms; return; }
	}
	ms.push(row);
	chat.messages = ms;
}

/// Fold opened rows into `chat`, each through its turn's view, and draw each turn moved.
/// Answers the turns that ended in this fold. A row at or below the cursor is a re-read
/// and is not folded again. An open turn's view is kept on the chat (`logViews`), so a
/// reload resumes it; an ended one is dropped once drawn, its status kept (`logEnds`).
///
/// `deps`: `seal` (`turnviewApply`), `join`, `isTile`, and `onEnd(chat, turn, view)`.
export async function foldRows(chat, rows, deps) {
	var views = chat.logViews || {};
	var cur = logCursor(chat);
	var moved = {}, ended = [];
	for (var i = 0; i < rows.length; i++) {
		var row = rows[i], seq = +row.head.seq || 0;
		if (seq <= cur) continue;
		var turn = String(row.head.turn);
		var v = views[turn] || { turn: turn, last: 0, state: 'open', rows: [] };
		var was = v.state;
		var out = JSON.parse(await deps.seal.turnviewApply(JSON.stringify(v), JSON.stringify(row)));
		views[turn] = out.view;
		moved[turn] = 1;
		if (was !== 'ended' && out.view.state === 'ended') ended.push(turn);
		cur = seq;
	}
	chat.logSeq = cur;
	for (var t in moved) drawTurn(chat, views[t], deps);
	var ends = chat.logEnds || {};
	ended.forEach(function (t) {
		var v = views[t];
		delete views[t];
		ends[t] = String(v.status || (v.end && v.end.status) || 'ended');	// its view goes; its end stays
		chat.logEnds = ends;
		drawEnd(chat, v, deps);
		if (deps.onEnd) deps.onEnd(chat, t, v);
	});
	chat.logViews = views;
	return ended;
}

/// Has this device read turn `turn` of `chat` ended in the log? The dead-writer detector asks
/// before it writes an `interrupted` end the log would refuse.
export function turnEnded(chat, turn) {
	var t = String(turn || ''), v = chat && chat.logViews && chat.logViews[t];
	return !!(chat && ((chat.logEnds && chat.logEnds[t]) || (v && v.state === 'ended')));
}

/// Read `chat`'s log above its cursor and fold it, page after page while the door says
/// there is more. A `gap` (the cursor is below what the gateway still holds) resets the
/// cursor to just under `low` and reads again, once: what lies below came with the
/// parcel. Answers `{ok, ended, bad}`.
///
/// `deps`: `read(chat, since)` (`DaimondSync.readLog`), `unwrap`, and `foldRows`'s.
/// A chat whose transcript is not loaded is not read: `{ok: false, resident: false}`.
export async function readChat(chat, deps) {
	var ended = [], bad = 0, gaps = 0;
	// NOT RESIDENT (`_loaded` false): `messages` is the empty placeholder, not the transcript.
	// Folded, the log's rows became the whole chat and its first line the rail's title
	// (REL-1pg: "@err 500" on a paired WebKit device). The cursor stays, so the read after
	// `loadChatMessages` folds the same rows under the real transcript.
	if (chat && chat._loaded === false) return { ok: false, ended: ended, bad: bad, resident: false };
	for (;;) {
		var since = logCursor(chat);
		var got = await deps.read(chat.id, since);
		if (!got) return { ok: false, ended: ended, bad: bad };
		if (got.gap) {
			if (gaps++) return { ok: false, ended: ended, bad: bad };
			chat.logSeq = Math.max(0, (+got.low || 0) - 1);
			continue;
		}
		var open = await openRows(got.rows, deps.seal, deps.unwrap);
		bad += open.bad;
		ended = ended.concat(await foldRows(chat, open.rows, deps));
		// A row that did not open still moves the cursor: it is never going to open.
		if (open.top > logCursor(chat)) chat.logSeq = open.top;
		if (!got.more || !got.rows || !got.rows.length) return { ok: true, ended: ended, bad: bad };
	}
}
