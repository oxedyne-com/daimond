// The chat log's writing side on the tab (P2.3b, design §2). Every turn this device runs,
// Here included, appends its rows to its chat's log: the engine's `row::Writer` gives what
// changed since the last look (`logDiff`), the engine cuts each change into rows within the
// door's row ceiling (`logRows`), identity.js seals each body under the account key, and the
// rows go out in order through `DaimondSync.appendLog`, greedy within the batch ceiling.
//
// OFFLINE ROWS WAIT, UNDER THEIR TURN ID [F9]. A row the gateway did not answer stays in the
// outbox, kept across a reload, and goes again once it is reachable; the log takes each
// `(turn, n)` once, so a row sent twice is one row. A turn run offline therefore reaches the
// other devices through the log, not by parcel alone.
//
// A 409 `ended` STOPS THE TURN'S WRITING [F4]: another device has ended it (usually the
// dead-writer detector, `interrupted`), and first end wins, so the turn's rows still queued are
// dropped and `onEnded` tells the running turn to stop. A 413 halves the batch, and a lone row
// still too large is cut at half its text; a row once sent with no answer is never cut again.
//
// The leaf of the page's log writing: it imports nothing, and reaches the codec, the key and
// the door through `deps()` (window's in the page, a test's own in node).

var OUTBOX_KEY = 'daimond.chatlog.outbox';	// fixed: the outbox's local storage key

var _deps     = null;	// set by `configureTurnLog`; window's otherwise
var _turns    = {};		// turn id -> { chat, writer, n, ended }
var _queue    = [];		// rows not yet taken, in order: { chat, turn, head, body, wire, tried }
var _limits   = { rowMax: 0, batchMax: 0, flushMs: 0 };	// as the door last said; 0 unknown
var _sealOver = -1;		// a sealed body's bytes over its plaintext, measured once
var _timer    = null;
var _flushing = null;
var _loaded   = false;
var _serial   = Promise.resolve();	// the chain `serial` runs looks and cuts on
var _readerEnded = null;	// the reader's `(chat, turn) -> ended?` (`readerEnded`)

/// The page's own codec, key, door and storage, or the ones a test configured.
function deps() {
	if (_deps) return _deps;
	var w = typeof window !== 'undefined' ? window : {};
	return {
		bridge:  w.DaimondSeal,
		wrap:    function (plain, aad) { return w.DaimondIdentity.wrapBytesAad(plain, aad); },
		append:  function (chat, rows) { return w.DaimondSync.appendLog(chat, rows); },
		store:   {
			load: function () { try { return JSON.parse(w.localStorage.getItem(OUTBOX_KEY) || '[]'); } catch (e) { return []; } },
			save: function (rows) { try { w.localStorage.setItem(OUTBOX_KEY, JSON.stringify(rows)); } catch (e) { /* the rows stay in memory */ } },
		},
		onEnded: function (chat, turn) {
			try { w.dispatchEvent(new CustomEvent('daimond:turnlog-ended', { detail: { chat: chat, turn: turn } })); }
			catch (e) { /* nothing listens */ }
		},
		onLanded: function (chat, head) {
			try { w.dispatchEvent(new CustomEvent('daimond:turnlog-landed', { detail: { chat: chat, head: head } })); }
			catch (e) { /* nothing listens */ }
		},
	};
}

/// Set the codec, key, door, storage and `onEnded` the writer uses (a test's, or the page's
/// at install); `null` returns to window's. Forgets every turn and row held.
export function configureTurnLog(d) {
	_deps = d || null;
	_turns = {}; _queue = []; _limits = { rowMax: 0, batchMax: 0, flushMs: 0 };
	_foreign = {};
	_sealOver = -1; _loaded = false; _flushing = null; _serial = Promise.resolve();
	if (_timer) { clearTimeout(_timer); _timer = null; }
}

function b64(bytes) {
	var s = '';
	for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s);
}

/// The outbox kept across a reload: the sealed rows only, never a plaintext body.
function saveQueue() {
	var d = deps();
	if (!d.store) return;
	d.store.save(_queue.map(function (q) { return { chat: q.chat, turn: q.turn, head: q.head, wire: q.wire, tried: true }; }));
}

function loadQueue() {
	if (_loaded) return;
	_loaded = true;
	var d = deps();
	var kept = d.store ? (d.store.load() || []) : [];
	// A row kept across a reload may already be in the log: it goes as it is.
	_queue = kept.concat(_queue);
}

/// The most plaintext a row body may be under the door's row ceiling; unbounded until the door
/// has said it (the first batch is one row, and a 413 cuts it).
async function plainMax() {
	if (!_limits.rowMax) return Number.MAX_SAFE_INTEGER;
	if (_sealOver < 0) {
		var d = deps();
		_sealOver = (await d.wrap(new Uint8Array(0), await d.bridge.rowAad())).length;
	}
	return Math.max(0, _limits.rowMax - _sealOver);
}

async function sealRow(head, body) {
	var d = deps();
	var plain = await d.bridge.rowSeal(head, body);
	var sealed = await d.wrap(plain, await d.bridge.rowAad());
	return { head: head, body: body, wire: await d.bridge.rowWire(head, sealed) };
}

async function queueChanges(t, turn, changes) {
	var room = await plainMax();
	var d = deps();
	for (var i = 0; i < changes.length; i++) {
		var rows = await d.bridge.logRows(turn, t.daimon || '', t.n, changes[i], room);
		t.n += rows.length;
		for (var j = 0; j < rows.length; j++) {
			var r = await sealRow(rows[j].head, rows[j].body);
			_queue.push({ chat: t.chat, turn: turn, head: r.head, body: r.body, wire: r.wire, tried: false });
		}
	}
}

/// Local fields (`_x`) never leave the device.
function wireMsg(m) {
	var o = {};
	for (var k in m) {
		if (Object.prototype.hasOwnProperty.call(m, k) && k.charAt(0) !== '_') o[k] = m[k];
	}
	return o;
}

/// The messages of the turn that `umid` (its user message) opens, as the chat holds them:
/// that message and every one after it up to the next user message.
export function turnMessages(messages, umid) {
	var out = [];
	var on = false;
	for (var i = 0; i < (messages || []).length; i++) {
		var m = messages[i];
		if (!m) continue;
		if (!on) { on = String(m.mid || '') === String(umid); if (!on) continue; }
		else if (m.role === 'user') break;
		if (m.mid) out.push(wireMsg(m));
	}
	return out;
}

/// Append turn `turn`'s messages so far to chat `chat`'s log, and its `end` when `end` is given
/// (`{status, totals, ...}`, status done|stopped|interrupted|not_run). Answers false once the
/// turn's log has ended.
///
/// STREAMED TEXT GOES ONCE PER `flush_ms`, NOT ONCE PER CALL. A call without an end only holds
/// `msgs` as the turn's latest; the writer looks at them when the door's `flush_ms` runs out, so
/// a streamed answer called in on every delta is one `more` row per flush, not one per token. A
/// turn's first call, and any while `flush_ms` is unknown (offline from the start), looks at
/// once, so the prompt reaches the log on send and the door's answer gives the period. An `end`
/// looks and goes at once.
export async function logTurn(chat, turn, msgs, end, daimon) {
	chat = String(chat || ''); turn = String(turn || '');
	if (!chat || !turn) return false;
	loadQueue();
	var t = _turns[turn] || (_turns[turn] = { chat: chat, daimon: daimon || '', writer: {}, n: 1, ended: false, msgs: [], due: false, looked: false });
	if (t.ended || (t.writer && t.writer.ended)) return false;
	if (msgs) t.msgs = msgs;	// none: the turn's latest stand
	t.due = true;
	if (end || !t.looked) {
		await serial(function () { return lookTurn(turn, end || null); });
		saveQueue();
		await flushTurnLog();
	} else if (_limits.flushMs) {
		arm();
	}
	return !t.ended;
}

/// The writer's look at turn `turn`'s latest messages: the rows of what changed, queued.
async function lookTurn(turn, end) {
	var t = _turns[turn];
	if (!t || t.ended || (t.writer && t.writer.ended) || !(t.due || end)) return;
	t.due = false;
	t.looked = true;
	var got = await deps().bridge.logDiff(t.writer, t.msgs, end);
	t.writer = got.writer;
	await queueChanges(t, turn, got.changes);
}

/// Every turn's look and every outbox cut, one at a time: a writer and its row numbers are
/// read and replaced across awaits, so two at once would number rows twice.
function serial(fn) {
	var run = _serial.then(fn, fn);
	_serial = run.then(function () {}, function () {});
	return run;
}

/// The next flush, `flush_ms` from now (once; a flush already armed stands).
function arm() {
	if (_timer || !_limits.flushMs) return;
	_timer = setTimeout(function () { _timer = null; flushTurnLog(); }, _limits.flushMs);
}

/// End turn `turn` with `end` alone (a turn this device does not hold the rows of, such as the
/// dead-writer detector's `interrupted`): its first row is the `end`.
///
/// The messages this device last gave for it stand: an empty list would tomb every one.
export async function logEnd(chat, turn, end) {
	return logTurn(chat, turn, null, end);
}

/// The `end` body of a turn not run (engine `End.not_run`): its reason `{why, cause, to, name,
/// said}`, the set fields only, `nr` being a `notRunCause` or null.
export function notRunEnd(why, nr) {
	var o = {}, r = nr || {};
	if (why) o.why = String(why);
	['cause', 'to', 'name', 'said'].forEach(function (f) { if (r[f]) o[f] = String(r[f]); });
	return { status: 'not_run', not_run: o };
}

var _ending = {};	// turn id -> an `interrupted` end on its way from here
var _foreign = {};	// turn id -> chat: an end written here for a run this tab did not draw

/// Tell this device's reader that a foreign end of `rows`' turns is in chat `chat`'s log, up to
/// `head` (0 unknown). The gateway taps every device but the writer (sync.rs `log_put`), so an
/// end the detector wrote here would otherwise reach this screen only on some later read.
function landed(chat, turns, head) {
	var hit = false;
	turns.forEach(function (t) { if (_foreign[t] === chat) { delete _foreign[t]; hit = true; } });
	if (!hit) return;
	var d = deps();
	try { if (d.onLanded) d.onLanded(chat, +head || 0); } catch (e) { /* the next tap or look reads it */ }
}

/// THE ONE DEAD-WRITER DETECTOR (design §2 [F3]). `dead` is the lease view's turns past their
/// deadline with no live holder (`DaimondLease.pastAll`, `[{turnId, chatId}]`); each still open
/// is ended `interrupted`. Every key-holding device runs it, and the log's first end wins, so
/// two detectors write one end. Answers how many ends it wrote or queued.
export async function endDeadTurns(dead) {
	var n = 0;
	for (var i = 0; i < (dead || []).length; i++) {
		var d = dead[i] || {};
		if (await endInterrupted(d.chatId, d.turnId)) n++;
	}
	return n;
}

/// End turn `turn` of chat `chat` `interrupted`: the one writer of that end, for the detector
/// and for a runner that reloads holding the lease of a run it no longer runs (rulings §1: it
/// ends, never re-runs). Not for a turn whose end this tab has seen or sent, nor one this tab is
/// still writing: that run ends itself. False when it wrote nothing.
export async function endInterrupted(chat, turn) {
	chat = String(chat || ''); turn = String(turn || '');
	if (!chat || !turn || _ending[turn]) return false;
	var t = _turns[turn];
	if (t) return false;	// ended from here already, or this tab's own run, which ends itself
	var d = deps();
	var seen = d.ended || _readerEnded;
	try { if (seen && seen(chat, turn)) return false; } catch (e) { /* the log decides */ }
	_ending[turn] = 1;
	_foreign[turn] = chat;
	try { return await logEnd(chat, turn, { status: 'interrupted' }); }
	catch (e) { delete _turns[turn]; delete _foreign[turn]; return false; }	// no key to seal with: another device, or a later look, ends it
	finally { delete _ending[turn]; }
}

/// Give the detector the reader's check of a turn it has read ended (`null` forgets it), so a
/// lease left past its deadline by a turn that ended costs no write on every look.
export function readerEnded(fn) {
	_readerEnded = typeof fn === 'function' ? fn : null;
}

/// Has the log refused turn `turn` as ended, or taken its end from here?
export function turnLogEnded(turn) {
	var t = _turns[String(turn)];
	return !!(t && (t.ended || (t.writer && t.writer.ended && !_queue.some(function (q) { return q.turn === String(turn); }))));
}

/// The rows not yet taken (offline, or between flushes).
export function turnLogPending() {
	loadQueue();
	return _queue.length;
}

function dropTurn(turn) {
	_queue = _queue.filter(function (q) { return q.turn !== turn; });
	var t = _turns[turn];
	if (t) { t.ended = true; t.due = false; }
}

/// Look at every turn with messages not yet looked at, then post the outbox in order: runs of
/// one chat's rows, greedy within the batch ceiling (one row while it is unknown). Stops at the
/// first unanswered post and keeps the rest for the next.
export async function flushTurnLog() {
	if (_flushing) return _flushing;
	_flushing = (async function () {
		loadQueue();
		for (var id in _turns) {
			if (_turns[id].due) await serial(function () { return lookTurn(id, null); });
		}
		var cap = Infinity;
		while (_queue.length) {
			var chat = _queue[0].chat;
			var k = 0, size = 0;
			for (var i = 0; i < _queue.length && _queue[i].chat === chat; i++) {
				var len = String(_queue[i].wire.body || '').length;
				if (k >= cap || (k > 0 && (!_limits.batchMax || size + len > _limits.batchMax))) break;
				size += len; k++;
			}
			var batch = _queue.slice(0, k);
			var res = await deps().append(chat, batch.map(function (q) { return q.wire; }));
			var j = (res && res.json) || {};
			if (j.row_max)   _limits.rowMax   = j.row_max;
			if (j.batch_max) _limits.batchMax = j.batch_max;
			if (j.flush_ms)  _limits.flushMs  = j.flush_ms;
			var st = res ? res.status : 0;
			if (st === 200) {
				_queue.splice(0, k);
				landed(chat, batch.map(function (q) { return q.turn; }), j.head);
				cap = Infinity;
			} else if (st === 409) {
				var ended = String(j.turn || batch[0].turn);
				dropTurn(ended);
				try { deps().onEnded(chat, ended); } catch (e) { /* the turn stops itself */ }
				landed(chat, [ended], 0);
			} else if (st === 413 && k > 1) {
				cap = Math.max(1, Math.floor(k / 2));
			} else if (st === 413) {
				if (!(await serial(recutFront))) {
					// A row too large that cannot be cut is dropped, never left to wedge the log.
					_queue.shift();
				}
			} else if (st === 0 || st >= 500 || st === 401 || st === 429) {
				batch.forEach(function (q) { q.tried = true; });
				break;	// unreachable or busy: the rows wait for the next flush
			} else {
				_queue.splice(0, k);	// a refusal no retry changes
			}
			saveQueue();
		}
		saveQueue();
	})();
	try { await _flushing; } finally { _flushing = null; }
	// Messages that came in while this flush ran go on the next.
	for (var id in _turns) { if (_turns[id].due && !_turns[id].ended) { arm(); break; } }
}

/// The front row, refused alone as too large, cut at half its plaintext and the rows of its
/// turn after it renumbered. False when it cannot be cut (sent before, an end or a tomb, or a
/// body no longer held).
async function recutFront() {
	var f = _queue[0];
	if (!f || f.tried || !f.body || f.head.kind === 'end' || f.head.kind === 'tomb') return false;
	if (_queue.some(function (q) { return q.turn === f.turn && q.tried; })) return false;
	var d = deps();
	var plain = (await d.bridge.rowSeal(f.head, f.body)).length;
	var rows = await d.bridge.logRows(f.turn, f.head.daimon || '', f.head.n,
		{ kind: f.head.kind, body: f.body }, Math.floor(plain / 2));
	var shift = rows.length - 1;
	var later = _queue.slice(1);
	for (var i = 0; i < later.length; i++) {
		if (later[i].turn !== f.turn) continue;
		var h = Object.assign({}, later[i].head, { n: later[i].head.n + shift });
		var r = await sealRow(h, later[i].body);
		later[i].head = r.head; later[i].wire = r.wire;
	}
	if (_turns[f.turn]) _turns[f.turn].n += shift;
	var front = [];
	for (var k = 0; k < rows.length; k++) {
		var s = await sealRow(rows[k].head, rows[k].body);
		front.push({ chat: f.chat, turn: f.turn, head: s.head, body: s.body, wire: s.wire, tried: false });
	}
	_queue = front.concat(later);
	return true;
}

// page-split: install 135

export function install() { // page-split: install
	// page-split: install 135
	// The outbox goes again whenever the gateway may be reachable again.
	if (typeof window !== 'undefined' && window.addEventListener) {
		window.addEventListener('online', function () { flushTurnLog(); });
	}
	// The one dead-writer detector, told by the lease view of every turn past its deadline.
	if (typeof window !== 'undefined' && window.DaimondLease && window.DaimondLease.onDead) window.DaimondLease.onDead(endDeadTurns);
} // page-split: end install
