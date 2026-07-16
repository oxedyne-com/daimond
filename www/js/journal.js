/* journal.js — a write-ahead log, so work in flight survives the tab dying.
 *
 * Daimond persists a COMPLETED turn to localStorage (the snapshot). Everything between the moment
 * you press Send and the moment the turn finishes lived only in memory: a crash, a shut browser,
 * a discarded tab took the whole turn — the prompt included — with it. This is the other half.
 *
 * The model is crash-only (Candea & Fox): assume the tab can vanish between any two instructions,
 * keep the durable log ALWAYS CURRENT, and make recovery the only startup path. There is no
 * clean-shutdown step to rely on, because on the web there is no clean shutdown to rely on.
 *
 * Division of labour:
 *   - The SNAPSHOT (localStorage `daimond-chats`) is the durable record of COMPLETED turns.
 *   - The JOURNAL (this, in IndexedDB) is the write-ahead log of the IN-FLIGHT turn: the prompt,
 *     the reply as it streams, each tool as it is called and as it returns. When a turn finishes
 *     it is folded into the snapshot and its journal events are pruned, so the journal only ever
 *     holds what has not yet been made durable elsewhere.
 *
 * On the next boot, whatever is still in the journal was interrupted. Recovery reconstructs it —
 * the prompt, the partial reply, the tools that ran — hands it back to the app to show as
 * interrupted, and offers to continue it.
 *
 * IndexedDB, not localStorage: it is roomy, structured, appends without rewriting the whole value,
 * and its writes commit to disk. It is async, but that is fine because we journal CONTINUOUSLY as
 * events happen, never in a last-gasp unload handler (async writes do not finish there, and the
 * events would already be safe). Per account, via the same namespace the rest of storage uses.
 */
(function () {
	'use strict';

	var DB_BASE = 'daimond-journal';
	var STORE   = 'events';
	var VERSION = 1;

	var db      = null;
	var dbOpen  = null;        // the name `db` is open on, to notice an account switch
	var pending = [];          // events buffered since the last flush
	var timer   = null;
	var FLUSH_MS = 200;        // deltas coalesce inside this window; markers flush at once
	var _seq    = 0;

	function dbName() {
		var ns = (window.DaimondAccounts && DaimondAccounts.opfsNs()) || '';
		return ns ? DB_BASE + '-' + ns : DB_BASE;
	}

	function open(name) {
		return new Promise(function (resolve, reject) {
			var req = indexedDB.open(name || dbName(), VERSION);
			req.onupgradeneeded = function () {
				var d = req.result;
				if (!d.objectStoreNames.contains(STORE)) {
					var os = d.createObjectStore(STORE, { keyPath: 'k', autoIncrement: true });
					os.createIndex('by_stream', 'stream', { unique: false });
				}
			};
			req.onsuccess = function () { resolve(req.result); };
			req.onerror   = function () { reject(req.error); };
		});
	}

	async function init() {
		var want = dbName();
		// The account can change under us (a switch points storage at a different namespace). The
		// cached handle is for the OLD account's store, so reopen on the new name — and drop any
		// buffered events, which belonged to the account we are leaving (a real switch reloads the
		// page, so this only bites a same-session namespace change, but it must still isolate).
		if (db && dbOpen === want) return db;
		if (db && dbOpen !== want) { try { db.close(); } catch (e) { /* already */ } db = null; pending = []; }
		try { db = await open(want); dbOpen = want; } catch (e) { db = null; dbOpen = null; }
		// A tab that dies while a transaction is open leaves the connection unusable on the next
		// event; drop the handle so the next call reopens.
		if (db) {
			db.onclose = function () { db = null; dbOpen = null; };
			// Let a delete (forgetIdentity's deleteDatabase) proceed instead of blocking on this
			// open connection: close on the version-change request.
			db.onversionchange = function () { try { db.close(); } catch (e) { /* already */ } db = null; dbOpen = null; };
		}
		return db;
	}

	function tx(mode) {
		var t = db.transaction(STORE, mode);
		return { store: t.objectStore(STORE), done: new Promise(function (res, rej) {
			t.oncomplete = res; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); };
		}) };
	}

	/// Push an event onto the buffer. Markers (anything but a delta) flush immediately, so the
	/// write-ahead record of a tool call or a turn boundary is on disk without waiting; deltas
	/// coalesce, so a fast stream is not one disk write per token.
	function push(ev, immediate) {
		ev.stream = ev.stream || ev.chatId || (ev.runId ? 'agent:' + ev.runId : 'x');
		ev.t = ev.t || 0;                       // ts is stamped by the caller (Date.now is fine in JS)
		pending.push(ev);
		if (immediate) return flush();
		if (!timer) timer = setTimeout(function () { timer = null; flush(); }, FLUSH_MS);
		return Promise.resolve();
	}

	/// Coalesce consecutive text deltas for the same stream (one turn has one assistant stream) into
	/// one event, so a burst of tokens costs one row, not hundreds.
	function coalesce(evs) {
		var out = [];
		for (var i = 0; i < evs.length; i++) {
			var e = evs[i], last = out[out.length - 1];
			if (e.type === 'delta' && last && last.type === 'delta' && last.stream === e.stream) {
				last.text += e.text;
			} else {
				out.push(e);
			}
		}
		return out;
	}

	async function flush() {
		if (!pending.length) return;
		// Always through init(), which reopens if the account changed — so buffered events can
		// never be written into the wrong account's store.
		await init();
		if (!db) return;                              // storage unavailable: stay in memory
		var batch = coalesce(pending);
		pending = [];
		try {
			var t = tx('readwrite');
			// The key `k` is auto-generated: it must be ABSENT from the value, not present-and-
			// undefined (which IndexedDB rejects as an invalid key rather than auto-filling).
			batch.forEach(function (e) { if ('k' in e) delete e.k; t.store.add(e); });
			await t.done;
		} catch (e) {
			// A failed flush must not lose the events; put them back to try again next tick.
			pending = batch.concat(pending);
		}
	}

	function stamp(ev) { ev.t = nowMs(); return ev; }
	// Date.now() is available in the browser (this is not a workflow script); wrapped for one place.
	function nowMs() { try { return Date.now(); } catch (e) { return 0; } }

	// ── The turn ────────────────────────────────────────────────────
	//
	// Every event of ONE turn shares a `stream` = its turn id (the user message's id), NOT the
	// chat id. Keying by chat conflated successive turns of the same chat and let one turn's prune
	// wipe the next turn's events; keying by turn means each turn is opened, closed and pruned in
	// isolation. `chatId` rides on every event too, so a turn can always be placed back in its
	// chat even if its opening event is the one that was lost.

	function turnOpen(turnId, chatId, text, meta) {
		return push(stamp({ type: 'turn_open', stream: turnId, chatId: chatId, text: text, meta: meta || null }), true);
	}
	function delta(turnId, chatId, text) {
		if (!text) return Promise.resolve();
		return push(stamp({ type: 'delta', stream: turnId, chatId: chatId, text: text }), false);
	}
	function toolOpen(turnId, chatId, callId, name, args) {
		return push(stamp({ type: 'tool_open', stream: turnId, chatId: chatId, callId: callId, name: name, args: args }), true);
	}
	function toolDone(turnId, chatId, callId, result, failed) {
		return push(stamp({ type: 'tool_done', stream: turnId, chatId: chatId, callId: callId, result: result, failed: !!failed }), true);
	}
	function turnError(turnId, chatId, message) {
		return push(stamp({ type: 'turn_error', stream: turnId, chatId: chatId, message: message }), true);
	}
	/// Close a turn: flush the last of it, then prune only THIS turn's events. Scoped to the turn,
	/// so a newer turn already opened on the same chat is never in range.
	async function turnClose(turnId, chatId, pTok, cTok) {
		await push(stamp({ type: 'turn_close', stream: turnId, chatId: chatId, pTok: pTok || 0, cTok: cTok || 0 }), true);
		await clearStream(turnId);
	}
	function clearTurn(turnId) { return clearStream(turnId); }

	// ── Agents (the conductor's dispatched workers) ─────────────────

	function agentOpen(runId, rec) {
		return push(stamp({ type: 'agent_open', runId: runId, rec: rec }), true);
	}
	function agentDelta(runId, text) {
		if (!text) return Promise.resolve();
		return push(stamp({ type: 'agent_delta', runId: runId, text: text }), false);
	}
	function agentClose(runId, status, pTok, cTok) {
		var p = push(stamp({ type: 'agent_close', runId: runId, status: status, pTok: pTok || 0, cTok: cTok || 0 }), true);
		return p.then(function () { return clearStream('agent:' + runId); });
	}

	// ── Pruning ─────────────────────────────────────────────────────

	async function clearStream(stream) {
		await flush();                          // land anything buffered first
		if (!db) return;
		try {
			var t = tx('readwrite');
			var idx = t.store.index('by_stream');
			var range = IDBKeyRange.only(stream);
			await new Promise(function (res) {
				var cur = idx.openCursor(range);
				cur.onsuccess = function () { var c = cur.result; if (c) { c.delete(); c.continue(); } else res(); };
				cur.onerror = function () { res(); };
			});
			await t.done;
		} catch (e) { /* best effort */ }
	}

	function clearAgent(runId) { return clearStream('agent:' + runId); }

	/// Wipe the whole journal — used when an account is forgotten.
	async function clearAll() {
		await init();
		if (!db) return;
		try { var t = tx('readwrite'); t.store.clear(); await t.done; } catch (e) { /* ignore */ }
	}

	// ── Recovery ────────────────────────────────────────────────────

	/// Read the whole journal back, grouped per TURN into what was in flight when the tab died.
	/// Returns { turns: [ {turnId, chatId, userText, text, tools, closed} ], agents: [ {runId, rec, text} ] }.
	/// A turn is returned only if it never closed — i.e. it was interrupted — and can be placed in a
	/// chat (its chatId is known). Because each turn is its own stream, successive turns of one chat
	/// never conflate, and one turn's failed prune can never hide another's interruption.
	async function recover() {
		await init();
		await flush();                          // land anything still buffered before we read
		var empty = { turns: [], agents: [] };
		if (!db) return empty;
		var rows = [];
		try {
			var t = tx('readonly');
			await new Promise(function (res) {
				var cur = t.store.openCursor();
				cur.onsuccess = function () { var c = cur.result; if (c) { rows.push(c.value); c.continue(); } else res(); };
				cur.onerror = function () { res(); };
			});
			await t.done;
		} catch (e) { return empty; }

		rows.sort(function (a, b) { return (a.k || 0) - (b.k || 0); });

		var turns = {}, agents = {};
		rows.forEach(function (e) {
			if (e.type && e.type.indexOf('agent_') === 0 && e.runId) {
				var a = agents[e.runId] || (agents[e.runId] = { runId: e.runId, rec: null, text: '', closed: false });
				if (e.type === 'agent_open')       a.rec = e.rec;
				else if (e.type === 'agent_delta') a.text += (e.text || '');
				else if (e.type === 'agent_close') a.closed = true;
				return;
			}
			var tid = e.stream;
			if (!tid) return;
			var c = turns[tid] || (turns[tid] = { turnId: tid, chatId: '', userText: '', text: '', tools: [], closed: false });
			if (e.chatId) c.chatId = e.chatId;   // present on every turn event, so placement survives a lost open
			if (e.type === 'turn_open')       { c.userText = e.text || ''; }
			else if (e.type === 'delta')      { c.text += (e.text || ''); }
			else if (e.type === 'tool_open')  { c.tools.push({ callId: e.callId, name: e.name, args: e.args, result: null, failed: false, done: false }); }
			else if (e.type === 'tool_done')  { for (var i = c.tools.length - 1; i >= 0; i--) { if (c.tools[i].callId === e.callId) { c.tools[i].result = e.result; c.tools[i].failed = e.failed; c.tools[i].done = true; break; } } }
			else if (e.type === 'turn_close') { c.closed = true; }
			else if (e.type === 'turn_error') { c.closed = true; }   // errored is terminal, not interrupted
		});

		var interruptedTurns = [];
		Object.keys(turns).forEach(function (id) { var t = turns[id]; if (!t.closed && t.chatId) interruptedTurns.push(t); });
		var interruptedAgents = [];
		Object.keys(agents).forEach(function (id) { if (!agents[id].closed && agents[id].rec) interruptedAgents.push(agents[id]); });

		return { turns: interruptedTurns, agents: interruptedAgents };
	}

	window.DaimondJournal = {
		init:      init,
		flush:     flush,
		turnOpen:  turnOpen,
		delta:     delta,
		toolOpen:  toolOpen,
		toolDone:  toolDone,
		turnError: turnError,
		turnClose: turnClose,
		clearTurn: clearTurn,
		agentOpen: agentOpen,
		agentDelta: agentDelta,
		agentClose: agentClose,
		clearAgent: clearAgent,
		clearAll:  clearAll,
		recover:   recover,
		available: function () { return !!window.indexedDB; },
	};
})();
