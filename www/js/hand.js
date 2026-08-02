/* hand.js — the machine hand's page-side relay.
 *
 * `window.DaimondHand` is the ONE interface the wasm `run` tool calls, exactly
 * as `window.DaimondWeb` is for the web tools. It hides which transport is
 * attached, so the tool does not change when the second one appears:
 *
 *   'none'     no hand. Every command refuses with a sentence saying so, and
 *              the app is otherwise unaffected — the file tools never needed it.
 *
 *   'machine'  the Daimond Hands extension is installed and a native messaging
 *              host is paired. Chrome launches that host and connects it to
 *              THIS extension only; the extension is reachable from this origin
 *              only. There is no port and no secret, because the browser is the
 *              doorman.
 *
 *   'cloud'    the same host binary over a WebSocket on a machine the user
 *              owns, so a phone can drive a desktop. Not built yet; the shape
 *              is here so that adding it is not a rewrite.
 *
 * Why a native messaging host and not a small server on localhost: a loopback
 * port is reachable by ANY page the user visits, is not secret, and is guessable
 * in a second. The whole defence would come down to one pasted secret. Handing
 * the doorman's job to the browser removes the question instead of answering it.
 *
 * Streaming matters here in a way it does not for the web tools. A `cargo test`
 * says nothing for a minute and then says everything; a person watching an
 * empty panel cannot tell that from a hang. So output is relayed to the panel
 * as it arrives, while the PROMISE resolves only at the end — because a tool
 * result is one blob and the model reads it once. The live stream is for the
 * person; the resolved result is for the daimon.
 *
 * ── One link, greeted once ──────────────────────────────────────────
 *
 * There is ONE port to the extension, opened on the first thing that needs a
 * hand and kept for as long as it lives, and every command travels on it. Not a
 * port per command, for two reasons. Chrome starts a fresh host process per
 * connection, so a port per command would be a process per command and a
 * handshake per command; and the handshake is what tells us the folder the user
 * granted, without which no fence can be expressed and nothing may be run. Runs
 * are told apart by the `id` the wire already carries for exactly that purpose,
 * and so is a terminal session: `send` and `subscribe` put a second KIND of
 * conversation on the one link rather than a second connection to the machine.
 * See js/handpty.js, which owns no transport and asks for exactly those two.
 *
 * The link is opened LAZILY. Opening it is what puts the approval window on the
 * user's screen, and a window that appears because the app started — rather than
 * because a daimon asked to run something — is a question with no context, which
 * is the kind a person learns to dismiss.
 */
(function () {
	'use strict';

	/// What a person reads in the panel. Model-facing strings — what a tool call
	/// returns — stay in the language the system prompt is written in, as in web.js.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// The wire protocol this page speaks. The hand answers with its own and the
	/// two settle it between them; a mismatch is the hand's sentence to write,
	/// not ours, because it is the end that knows both numbers.
	var PROTO = 1;

	var state = {
		transport: 'none',   // 'none' | 'machine' | 'cloud'
		extId:     '',
		machine:   '',       // what the hand calls the box it runs on
		version:   '',       // which build of the hand answered
		os:        '',       // in the wire's own vocabulary: linux | macos | windows
		root:      '',       // the absolute folder the grant covers
		caps:      [],       // what the hand can actually enforce here
	};

	var deps = {};           // { onChunk, onStart, onEnd, note, client } — supplied by daimond.js
	var live = {};           // id -> run record
	var link = null;         // the one port: { port, greeted, waiters, note }

	/// Handlers watching one id, for a conversation this file does not itself
	/// carry. A terminal session is the first: it travels on THIS link, told
	/// apart by the same `id` a run is, because a second port would be a second
	/// host process and a second approval question for a hand the user granted
	/// once (see the header, and js/handpty.js).
	var subs = {};           // id -> [fn, ...]

	/// Whether a hand has ever answered in this page. It is the difference
	/// between "you have not installed it" and "it stopped", and those are
	/// different instructions to a user (see §1.16 of `hand/REVIEW.md`): telling
	/// someone to install software they already have wastes their afternoon.
	var met = false;

	/// The prefix the granted root arrives under, inside `caps`.
	///
	/// **A workaround, and recorded as one.** `Resp::Hello` in `hand/src/wire.rs`
	/// has no `root` field, and the wire is fixed, so the host reports the folder
	/// it was granted as a capability entry — `root:/home/u/work` — and the page
	/// reads it back out. `hello.root` is preferred when it exists, so the day
	/// the wire grows the field this line stops being load-bearing on its own.
	var ROOT_CAP = 'root:';

	/// The prefix the FOLDER IDENTITY arrives under, inside `caps`.
	///
	/// `root:` says WHERE the hand will work; this is what lets the page find out whether that
	/// is the folder it is itself looking at. A path cannot settle it: the File System Access
	/// API hands the page a handle and never a path, so the two ends compare a token written
	/// into a file both can reach.
	///
	/// The hand writes a random 32-hex token to `<root>/.daimond/workspace.id`, once, and keeps
	/// it — so it identifies the FOLDER rather than the run, and a page that remembers it
	/// notices its workspace being swapped underneath it. The file lives inside `.daimond`
	/// deliberately: a fence always denies that directory, so a command cannot read the token,
	/// and a command that has been talked into helping cannot answer a challenge about a folder
	/// it is not in.
	var WS_CAP = 'ws:';

	/// What the hand publishes where it could not establish an identity at all.
	///
	/// A literal word, and a token can never be it: a token is 32 hexadecimal characters. One
	/// string therefore settles both questions — "what is the identity" and "is there one".
	var WS_UNPROVEN = 'unproven';

	/// The name of the folder Daimond writes its own things into, and where the token lives.
	var WS_DIR  = '.daimond';
	var WS_FILE = 'workspace.id';

	/// The refusal a missing hand produces. It is the most-read sentence in this
	/// file — a user who has not installed the hand meets it on their first
	/// command — so it says what is missing and what still works, rather than
	/// merely that something failed.
	var NO_HAND = 'There is no machine hand paired with this browser, so there is '
		+ 'nothing to run commands on. Daimond runs in the browser, and a browser '
		+ 'cannot start a program; the hand is a small companion that can. Tell the '
		+ 'user it is not installed, and carry on with the file tools, which do not need it.';

	/// What a hand that HAS answered before, and has now gone, produces.
	///
	/// Kept apart from `NO_HAND` on purpose. Every disconnect used to be reported
	/// as "not installed", so a host that crashed, was killed, or blew Chrome's
	/// 1 MB cap made the daimon tell the user to install what they already had.
	var HAND_GONE = 'The machine hand answered earlier and has now gone. It is installed; '
		+ 'something stopped it — a crash, the user quitting it, or a message too large for '
		+ 'the browser to carry. Do not tell the user to install it. Say it stopped, and try '
		+ 'again once; if it stops a second time, ask them to look at the hand\'s journal.';

	/// The longest the page waits for an acknowledgement of a command it has sent.
	///
	/// Not the same as the command's own timeout, which the hand enforces and
	/// which is the real limit. This is the wait after which the page stops
	/// believing the hand is going to reply at all — a hand that has crashed
	/// sends nothing, and a tool call that never returns is a daimon that never
	/// speaks again. It covers the gap between `exec` and `started` ONLY; once a
	/// command is running the deadline becomes the command's own (see `arm`).
	var REPLY_GRACE = 30000;

	/// What the page adds to a command's own timeout before giving up on the
	/// answer. The hand kills at the timeout and then owes an `ended`; this is
	/// the room that reply is given, and nothing more.
	var REPLY_SLACK = 30000;

	/// The longest the handshake may take.
	///
	/// Long, because a human sits inside it: opening the port is what puts the
	/// approval window on screen, and the extension holds the greeting in order
	/// until it is answered. Bounded all the same, because a question nobody ever
	/// answers must still end as a refusal the model can act on rather than as a
	/// tool call that hangs for ever.
	var HELLO_WAIT = 60000;

	/// What a command's timeout is taken to be when the request does not say.
	/// It mirrors `Tool::RUN_TIMEOUT_DEFAULT_MS`; the page never enforces it, it
	/// only decides how long to believe in an answer.
	var TIMEOUT_DEFAULT = 120000;

	/// How much of one stream the page keeps, at each end.
	///
	/// A frame is bounded by the wire (`CHUNK_MAX`) and the total was not, so a
	/// command printing gigabytes — `yes`, a runaway build, a `cat` of a disk
	/// image — grew an array in the tab until it died. Both ends are kept rather
	/// than the first: a build says what it is doing at the start and WHY IT
	/// FAILED at the end, and a cap that keeps only the head throws away the half
	/// the model needs. What is dropped is stated in the middle, in the stream
	/// itself, so nobody reads a hole as continuity.
	var KEEP_HEAD = 256 * 1024;
	var KEEP_TAIL = 256 * 1024;

	// ── The extension bridge ────────────────────────────────────────

	/// Whether the extension is reachable at all from this page.
	function hasExt() {
		return !!(state.extId && window.chrome && chrome.runtime && chrome.runtime.connect);
	}

	/// Learn the extension's id the way the Web panel learns it.
	///
	/// The extension stamps its own id on `<html>` and fires an event for a page
	/// that was not listening yet (see `ext/announce.js`). That is the ONE
	/// discovery mechanism — the page hard-codes no id, so a rebuilt extension
	/// with a different id still finds its way home, and the ABSENCE of the stamp
	/// is exactly how we know there is no hand.
	function detect() {
		window.addEventListener('daimond-hands', function (e) {
			var id = e && e.detail && e.detail.id;
			if (id) state.extId = id;
		});
		try { state.extId = document.documentElement.dataset.daimondHands || state.extId; }
		catch (e) { /* no dataset; the event may still arrive */ }
	}

	// ── The link ────────────────────────────────────────────────────

	/// Open the one port and greet whatever answers on it.
	///
	/// Resolves once the hand has said hello, which is the only moment the page
	/// knows the granted root — and therefore the only moment a fence can be
	/// expressed. Rejects with the sentence the extension gave us, which is
	/// already written for the model to act on (not installed, declined,
	/// dismissed, forbidden), or with `NO_HAND` when there is nothing to ask.
	function open() {
		if (link && link.greeted) return Promise.resolve(link);
		if (link) {
			// A handshake is already in flight; a second caller waits on the
			// first rather than opening a second port, which would be a second
			// host process and a second approval window.
			return new Promise(function (resolve, reject) { link.waiters.push({ resolve: resolve, reject: reject }); });
		}
		if (!hasExt()) return Promise.reject(new Error(NO_HAND));

		var port;
		try { port = chrome.runtime.connect(state.extId, { name: 'daimond-hand' }); }
		catch (e) { return Promise.reject(new Error(NO_HAND)); }

		var rec = { port: port, greeted: false, waiters: [], note: '', timer: null, dead: false };
		link = rec;

		port.onMessage.addListener(function (msg) { fromHand(rec, msg); });
		port.onDisconnect.addListener(function () { gone(rec); });

		var p = new Promise(function (resolve, reject) { rec.waiters.push({ resolve: resolve, reject: reject }); });
		rec.timer = setTimeout(function () {
			// Nobody answered the question, or nobody answered the port. Either
			// way the daimon is owed a sentence rather than a hang.
			drop(rec, rec.note || 'The machine hand was asked to start and did not answer. '
				+ 'The user may not have seen the approval window — the Daimond Hands icon carries '
				+ 'the question until it is answered. Ask them to allow it, and try again.');
		}, HELLO_WAIT);

		try {
			port.postMessage({ t: 'hello', proto: PROTO, client: deps.client || 'daimond-web' });
		} catch (e) {
			drop(rec, NO_HAND);
		}
		return p;
	}

	/// Settle everyone waiting on the handshake, one way or the other.
	function greeted(rec) {
		clearTimeout(rec.timer);
		rec.greeted = true;
		var w = rec.waiters;
		rec.waiters = [];
		for (var i = 0; i < w.length; i++) w[i].resolve(rec);
	}

	/// Give up on this link, tell everyone why, and close it.
	///
	/// Once per link, whichever of the three ways it ends: the handshake timing
	/// out, Chrome reporting the disconnect, or a `postMessage` throwing into a
	/// port that has already gone. Chrome fires `onDisconnect` a turn AFTER the
	/// throw, so without the guard the second arrival would tell every
	/// subscriber the link died twice — and a terminal reads that as two
	/// endings for one session.
	function drop(rec, why) {
		if (rec.dead) return;
		rec.dead = true;
		clearTimeout(rec.timer);
		if (link === rec) link = null;
		var w = rec.waiters;
		rec.waiters = [];
		for (var i = 0; i < w.length; i++) w[i].reject(new Error(why));
		// Every run on this link is over, whatever it was doing.
		for (var id in live) {
			if (Object.prototype.hasOwnProperty.call(live, id) && live[id].link === rec) {
				endWith(live[id], why);
			}
		}
		// And every other conversation on it. `met` travels with the sentence
		// because it is the whole difference between "you have not installed it"
		// and "it stopped", and the subscriber is as entitled to that as a run is.
		sayGone(why);
		if (state.transport !== 'none') forget();
		try { rec.port.disconnect(); } catch (e) { /* already gone */ }
	}

	/// Tell every subscriber the link has died, and why.
	///
	/// A handler that throws must not stop the next one being told: the link is
	/// gone either way, and a renderer's bug is not a reason to leave another
	/// session waiting for an ending that never comes.
	function sayGone(why) {
		var msg = { t: '__gone', message: why || (met ? HAND_GONE : NO_HAND), met: met };
		for (var id in subs) {
			if (!Object.prototype.hasOwnProperty.call(subs, id)) continue;
			var fns = subs[id].slice();
			for (var i = 0; i < fns.length; i++) {
				try { fns[i](msg); } catch (e) { /* the subscriber's problem, not the link's */ }
			}
		}
	}

	/// Hand one message to whoever is watching that id, in arrival order.
	function toSubs(id, msg) {
		var fns = subs[id];
		if (!fns) return;
		fns = fns.slice();
		for (var i = 0; i < fns.length; i++) {
			try { fns[i](msg); } catch (e) { /* as above */ }
		}
	}

	/// The link went away. This is the ambiguous event, and the page's one job
	/// here is to be honest about which of the two it was.
	function gone(rec) {
		var why = rec.note
			|| (rec.greeted || met ? HAND_GONE : NO_HAND);
		drop(rec, why);
		if (deps.note) { try { deps.note(why); } catch (e) {} }
	}

	// ── What the hand says ──────────────────────────────────────────

	/// One message from the hand, routed to whoever it is about.
	///
	/// Only a RECOGNISED type does anything at all. A message the page does not
	/// understand is not evidence that the hand is alive and well — a hostile or
	/// broken host sending `{"t":"noop"}` every 700 ms used to hold a promise
	/// open for ever, because the grace timer was refreshed before the type was
	/// looked at (§4.2). Unknown types now touch no timer and no run.
	function fromHand(rec, msg) {
		if (!msg || typeof msg.t !== 'string') return;

		if (msg.t === 'hello') {
			adopt(msg);
			greeted(rec);
			return;
		}
		// A connection-level error — no id — is the extension speaking about the
		// link itself: not installed, declined, dismissed, forbidden, or the host
		// disconnecting. It is written for the model, so it is kept verbatim and
		// used as the reason when the port closes a moment later.
		if (msg.t === 'error' && !msg.id) {
			rec.note = msg.message || rec.note;
			if (!rec.greeted) drop(rec, rec.note || NO_HAND);
			return;
		}

		// A conversation this file does not carry itself — a terminal session —
		// is handed on whole, before the run switch below looks at the type. It
		// has to be: `opened`, `output` and `closed` mean nothing to a run, and a
		// relay that only forwarded what it understood would be a second, older
		// opinion about what the wire says.
		if (msg.id) toSubs(msg.id, msg);

		var run = msg.id ? live[msg.id] : null;
		if (!run) return;   // about a run that is over, or one that was never ours

		if (msg.t === 'started') {
			// The one timer change there is: the wait stops being "acknowledge
			// me" and becomes the command's own limit. A quiet command is no
			// longer a dead one (§4.3) — a `cargo test` that says nothing for
			// four minutes is the case this file exists for.
			run.started = true;
			arm(run, run.limit + REPLY_SLACK, 'The machine hand started the command and never said '
				+ 'how it ended, past the time the command itself was given. Treat the result as unknown.');
			if (deps.onStart) { try { deps.onStart(msg.id, msg.pid); } catch (e) {} }
			return;
		}
		if (msg.t === 'chunk')   { absorb(run, msg); return; }
		if (msg.t === 'error') {
			// An error ABOUT a run is a note, not an ending. The extension
			// reports a gap in the sequence this way and then carries on
			// sending the rest of the output, so treating it as a settlement
			// threw away a run that was going to finish.
			note(run, msg.message || 'The machine hand reported a problem with this run.');
			return;
		}
		if (msg.t === 'refused') {
			settle(run, 'resolve', JSON.stringify({ refused: msg.reason }));
			return;
		}
		if (msg.t === 'ended') {
			if (deps.onEnd) { try { deps.onEnd(msg.id, msg.exit); } catch (e) {} }
			settle(run, 'resolve', JSON.stringify({
				exit:      msg.exit,
				timed_out: !!msg.timed_out,
				killed:    !!msg.killed,
				stdout:    text(run.out),
				stderr:    text(run.err),
				out_bytes: msg.out_bytes,
				err_bytes: msg.err_bytes,
				note:      run.note,
			}));
		}
	}

	/// Record what a paired hand told us about itself, from its `hello`.
	///
	/// `caps` is a list rather than a version number on purpose: the fence lands
	/// on one platform before another, so the app must be able to say WHICH
	/// guarantee it is offering on this machine. A hand that cannot fence is not
	/// dressed up as one that can.
	function adopt(hello) {
		if (!hello) { return; }
		state.transport = hello.transport || 'machine';
		state.machine   = hello.host || '';
		state.version   = hello.version || '';
		state.os        = hello.os || '';
		state.caps      = Array.isArray(hello.caps) ? hello.caps.slice() : [];
		state.root      = hello.root || rootCap(state.caps);
		// A hand that reconnects may be in a different folder, or the same folder with a new
		// identity — which means somebody deleted the file. Either way the last answer is about
		// something else now, so it is dropped rather than reused.
		wsProof = null;
		met = true;
	}

	/// The granted root, as the `caps` list carries it. See `ROOT_CAP`.
	function rootCap(caps) {
		return capValue(caps, ROOT_CAP);
	}

	/// The value of a `key:<value>` capability entry, or '' where the hand sent none.
	///
	/// # Arguments
	/// * `caps` - What the hand reported in its `hello`.
	/// * `prefix` - The entry's name, colon included.
	function capValue(caps, prefix) {
		for (var i = 0; i < caps.length; i++) {
			if (typeof caps[i] === 'string' && caps[i].indexOf(prefix) === 0) {
				return caps[i].slice(prefix.length);
			}
		}
		return '';
	}

	// ── Is the hand's folder the folder this page is looking at? ────
	//
	// `hand/REVIEW.md` §1.14. Every workspace-relative path a command is fenced by is joined onto
	// the folder the hand reports, and nothing checked that the two ends meant the same folder.
	// With an OPFS-only workspace, or an FSA folder that is not the grant, the fence names paths
	// on the machine that have nothing to do with the files the model just read — and the command
	// runs, correctly fenced, against the wrong files.
	//
	// The hand holds one of the two names and can only supply evidence. The comparison belongs
	// where both names meet, which is here — and it REFUSES, in `settled()`, rather than merely
	// reporting what it found.

	/// The last comparison, cached per grant and per folder: `{ key, dir, ok, why }`.
	///
	/// Keyed by the root and the token together, so a hand that reconnects to a different folder
	/// — or the same folder with a new identity, which means somebody deleted the file — is asked
	/// again rather than believed on the strength of an older answer.
	///
	/// The HANDLE is part of the key too, and that half is what makes the cache safe to arm on. A
	/// user who opens a different folder in the Workspace panel changes one of the two names being
	/// compared while the hand says nothing at all, and a verdict remembered by grant alone would
	/// answer for a folder it never read — passing a swap in the direction that runs the command.
	var wsProof = null;

	/// Whether this page's folder is the folder the hand was granted, and what to say if not.
	///
	/// Four outcomes, and the ordinary one is silent. It has to be: a check that puts a sentence
	/// in front of somebody every time it passes is a check people learn to dismiss.
	///
	/// The folder's NAME is never compared. Two projects called `site` on one machine is the
	/// ordinary case, not the exotic one, and a check that passes for the wrong folder is worse
	/// than no check at all.
	///
	/// # Returns
	/// `{ ok: true }`, or `{ ok: false, why: '<the sentence the model and the user read>' }`.
	async function proveFolder() {
		var token = capValue(state.caps, WS_CAP);
		var key   = state.root + '\u0000' + token;
		var dir   = (deps.folder && deps.folder()) || null;
		if (wsProof && wsProof.key === key && wsProof.dir === dir) return wsProof;

		var out = await folderVerdict(token, dir);
		wsProof = { key: key, dir: dir, ok: out.ok, why: out.why || '' };
		return wsProof;
	}

	/// The verdict itself, without the caching.
	///
	/// # Arguments
	/// * `token` - The `ws:` value the hand published, or '' where it published none.
	/// * `dir` - The folder the page has open, or null where it has none.
	async function folderVerdict(token, dir) {
		if (!token) {
			// A hand that says nothing about its folder, which is a hand from before the token
			// existed. §1.14 enumerates four outcomes and every one of them presupposes a `ws:`
			// value, so this is not one of them, and refusing here would be this file inventing a
			// fifth rule rather than implementing the four.
			//
			// **It is a compatibility seam and it is recorded as one.** A hand this old cannot be
			// checked at all, so a page that meets one is back where it was before §1.14: it will
			// run a command in whatever folder the hand names. The reason not to close it here is
			// that a page cannot tell an old hand from any other silent thing on that wire — a
			// mock, a different implementation — and the closing move belongs at the protocol
			// version, where "this hand is too old to serve" can be said once and plainly, rather
			// than as a folder complaint the user cannot act on.
			return { ok: true, why: '' };
		}
		if (token === WS_UNPROVEN) {
			return { ok: false, why: 'The machine hand could not write its identity file into the '
				+ 'folder it was granted, so the two ends cannot confirm they mean the same '
				+ 'folder. The hand\'s own error output names the path that failed.' };
		}
		if (!dir) {
			// Its own case, and NOT one to skip for want of a handle. There is nothing to read
			// the token through, so the check cannot pass — and a check that is skipped when it
			// cannot pass is not a check.
			return { ok: false, why: 'This workspace lives in the browser and not in a folder on '
				+ 'this machine, so there is nothing for the hand\'s commands to run against. Open '
				+ 'a folder for this workspace before using the machine hand.' };
		}
		var mine = '';
		try {
			// No `{create: true}`, on either call. A page that creates the file proves nothing:
			// it would be comparing a token it had just written with one it was given.
			var sub  = await dir.getDirectoryHandle(WS_DIR);
			var file = await sub.getFileHandle(WS_FILE);
			mine = await (await file.getFile()).text();
		} catch (e) {
			return { ok: false, why: mismatch(dir) };
		}
		if (firstLine(mine) !== token) return { ok: false, why: mismatch(dir) };
		return { ok: true, why: '' };
	}

	/// The identity a `workspace.id` carries: the first line that is neither blank nor a comment.
	///
	/// The file opens with four comment lines explaining itself to whoever finds it, so the token
	/// is not simply the first line.
	///
	/// # Arguments
	/// * `text` - The file's whole contents.
	function firstLine(text) {
		var lines = String(text || '').split(/\r?\n/);
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].trim();
			if (!line || line.charAt(0) === '#') continue;
			return line;
		}
		return '';
	}

	/// The sentence for a folder that is not the granted one, or has no identity in it.
	///
	/// Both ends are named, because the user cannot otherwise tell which one is wrong — and the
	/// two fixes are different: change `root.txt`, or open the other folder here.
	///
	/// # Arguments
	/// * `dir` - The directory handle the page holds.
	function mismatch(dir) {
		return 'The folder you opened in Daimond is not the folder the machine hand was told to '
			+ 'work in, so a command would run against different files from the ones Daimond has '
			+ 'been reading. Daimond has \u201c' + ((dir && dir.name) || 'this folder')
			+ '\u201d; the hand has \u201c' + (state.root || 'nowhere named')
			+ '\u201d. Fix the path in the hand\'s root.txt, or open the other folder here.';
	}

	// ── Output ──────────────────────────────────────────────────────

	/// A bounded accumulator for one stream: a head, a tail, and the truth about
	/// what fell between them.
	function stream() {
		return { head: [], headLen: 0, tail: [], tailLen: 0, dropped: 0 };
	}

	/// Split a string at `n` UTF-16 units without cutting a surrogate pair in
	/// half, which would leave a lone surrogate in the model's transcript.
	function cut(s, n) {
		if (n >= s.length) return s.length;
		var c = s.charCodeAt(n - 1);
		return (c >= 0xD800 && c <= 0xDBFF) ? n - 1 : n;
	}

	/// Keep what we can of one run of output, and count what we cannot.
	function keep(st, data) {
		var s = String(data == null ? '' : data);
		if (!s) return;
		if (st.headLen < KEEP_HEAD) {
			var room = KEEP_HEAD - st.headLen;
			if (s.length <= room) { st.head.push(s); st.headLen += s.length; return; }
			var at = cut(s, room);
			if (at > 0) { st.head.push(s.slice(0, at)); st.headLen += at; }
			s = s.slice(at);
		}
		st.tail.push(s);
		st.tailLen += s.length;
		while (st.tailLen > KEEP_TAIL && st.tail.length > 1) {
			var old = st.tail.shift();
			st.tailLen -= old.length;
			st.dropped += old.length;
		}
	}

	/// One stream as the model reads it, with any hole named where it happened.
	function text(st) {
		if (!st.dropped) return st.head.join('') + st.tail.join('');
		return st.head.join('')
			+ '\n[… ' + st.dropped + ' characters of output are missing here: the command printed '
			+ 'more than the page will hold, so the middle was dropped and the two ends kept …]\n'
			+ st.tail.join('');
	}

	/// Accumulate a chunk, in order, and pass it to whoever is drawing.
	///
	/// A gap in `seq` is SURFACED rather than hidden. Silently stitching over a
	/// missing chunk would hand the daimon output that never existed, and a
	/// build log with a hole in it is worse than one that says it has a hole.
	///
	/// The FIRST chunk of a stream sets the baseline — where the hand starts
	/// counting is the hand's business, and the extension's own check says the
	/// same. Assuming zero made every run open with a hole it did not have,
	/// which is the same failure as hiding one: the marker stops meaning
	/// anything.
	function absorb(run, msg) {
		var s = msg.stream === 'err' ? 'err' : 'out';
		var st = run[s];
		var want = run.seq[s];
		if (want !== null && msg.seq !== want) {
			keep(st, '\n[output missing: expected chunk ' + want + ', got ' + msg.seq + ']\n');
			run.gap = true;
		}
		run.seq[s] = msg.seq + 1;
		keep(st, msg.data);
		if (deps.onChunk) { try { deps.onChunk(msg.id, s, msg.data); } catch (e) {} }
	}

	// ── Running a command ───────────────────────────────────────────

	/// Set the deadline for this run, replacing whatever it had.
	function arm(run, ms, why) {
		clearTimeout(run.timer);
		run.timer = setTimeout(function () { endWith(run, why); }, ms);
	}

	/// Add to what the page has to say about this run, over and above what the
	/// command printed. It travels in `note`, never in `stdout`: a page's account
	/// of a broken link dressed as a program's output is a model debugging the
	/// wrong thing.
	function note(run, line) {
		if (!line) return;
		run.note = run.note ? (run.note + ' ' + line) : line;
	}

	/// End a run that will not answer, with the sentence saying why.
	function endWith(run, why) {
		note(run, why);
		settle(run, 'reject', new Error(run.note));
	}

	/// Finish a run once, whichever way it finished.
	function settle(run, how, value) {
		if (run.done) return;
		run.done = true;
		clearTimeout(run.timer);
		delete live[run.id];
		if (how === 'resolve') run.resolve(value); else run.reject(value);
	}

	/// Run one command. `specJson` is the wire's own `exec` request, built by the
	/// wasm side; this function does not interpret it beyond reading the id and
	/// the timeout, so there is one place the request is composed and it is the
	/// one that holds the fence.
	function run(specJson) {
		var spec;
		try { spec = JSON.parse(specJson); }
		catch (e) { return Promise.reject(new Error('The command could not be read: ' + e.message)); }

		return open().then(function (rec) {
			return new Promise(function (resolve, reject) {
				var id = spec.id || 'run';
				var r = {
					id:      id,
					link:    rec,
					resolve: resolve,
					reject:  reject,
					seq:     { out: null, err: null },   // set by the first chunk of each stream
					out:     stream(),
					err:     stream(),
					gap:     false,
					note:    '',
					started: false,
					done:    false,
					timer:   null,
					limit:   Number(spec.timeout_ms) > 0 ? Number(spec.timeout_ms) : TIMEOUT_DEFAULT,
				};
				live[id] = r;
				// Until the hand says it has started the command, this is the
				// wait. After that it is the command's own (see `fromHand`).
				arm(r, REPLY_GRACE, 'The machine hand did not acknowledge the command. It may have '
					+ 'stopped; ask the user to check it is still running.');
				try { rec.port.postMessage(spec); }
				catch (e) { endWith(r, met ? HAND_GONE : NO_HAND); }
			});
		});
	}

	// ── One message, on the one link ────────────────────────────────
	//
	// `run` is the shape a command has: send one thing, wait for its whole
	// result. A terminal is the other shape — bytes both ways, for as long as
	// the program lives — and it needs the link rather than a second copy of the
	// wire. So these two are the whole of what js/handpty.js asks for, and they
	// share `open`, the port and the greeting with `run`. Opening a second port
	// would start a second host process and ask a second approval question for a
	// hand the user granted once.

	/// Post one wire message on the one link, opening and greeting it first if
	/// need be.
	///
	/// # Arguments
	/// * `msg` - The wire message, already composed by whoever holds the fence.
	///
	/// # Returns
	/// A promise that resolves when the message has been handed to the
	/// extension, and rejects with the sentence a reader acts on — not
	/// installed, declined, stopped part-way — verbatim.
	function send(msg) {
		return open().then(function (rec) {
			// The port may have died between the handshake and here, and Chrome
			// reports that a turn LATE: `postMessage` throws "Attempting to use a
			// disconnected port object" while `onDisconnect` has not yet run, so
			// `link` still points at a corpse. Both halves are handled here rather
			// than waited on, because a caller is owed an answer now.
			if (rec.dead || link !== rec) {
				return Promise.reject(new Error(rec.note || (met ? HAND_GONE : NO_HAND)));
			}
			try {
				rec.port.postMessage(msg);
			} catch (e) {
				var why = rec.note || (met ? HAND_GONE : NO_HAND);
				// Ends the link ONCE, for everybody: the runs on it, the callers
				// waiting on it, and every subscriber. Chrome's own disconnect
				// arrives afterwards and finds it already settled.
				drop(rec, why);
				return Promise.reject(new Error(why));
			}
			return undefined;
		});
	}

	/// Watch everything the hand says about one id.
	///
	/// # Arguments
	/// * `id` - The identifier the wire carries on every message about it.
	/// * `fn` - Called with each message, in arrival order, and with
	///   `{t:'__gone', message, met}` when the link dies.
	///
	/// # Returns
	/// A function that stops the watching. It does not end whatever is being
	/// watched: a terminal is the hand's until the link closes.
	function subscribe(id, fn) {
		if (!id || typeof fn !== 'function') return function () {};
		if (!subs[id]) subs[id] = [];
		subs[id].push(fn);
		return function () {
			var a = subs[id];
			if (!a) return;
			var i = a.indexOf(fn);
			if (i >= 0) a.splice(i, 1);
			if (!a.length) delete subs[id];
		};
	}

	// ── What the hand is ────────────────────────────────────────────

	/// Ask the hand who and where it is, greeting it first if need be.
	///
	/// The `root` it reports is load-bearing: the page CANNOT know a real
	/// folder's path, because the File System Access API hands over a handle and
	/// never a path, so the fence the wasm side builds is expressed against
	/// whatever the hand says its grant covers. A hand that will not say has to
	/// be treated as no hand at all — guessing a root would be guessing what a
	/// command may touch.
	///
	/// It never rejects. A caller asking what is attached is owed an answer, and
	/// `reason` carries the sentence the model should read when the answer is
	/// "nothing" — which is otherwise lost, and was: every failure to pair, for
	/// whatever cause, came out as the same "it did not say which folder".
	function status() {
		if (state.transport !== 'none' && state.root) return settled();
		if (!hasExt()) {
			return Promise.resolve(JSON.stringify({
				paired: false, transport: 'none', caps: [], reason: NO_HAND,
			}));
		}
		return open().then(function () {
			if (!state.root) {
				return JSON.stringify({
					paired: false, transport: state.transport, caps: state.caps,
					machine: state.machine,
					reason: 'The machine hand answered but did not say which folder it was granted, '
						+ 'so there is no way to say what a command may touch. It is not safe to '
						+ 'guess. Ask the user to re-run the hand\'s installer, and carry on with '
						+ 'the file tools meanwhile.',
				});
			}
			return settled();
		}, function (e) {
			return JSON.stringify({
				paired: false, transport: 'none', caps: [],
				reason: (e && e.message) || NO_HAND,
			});
		});
	}

	/// What we know about the hand, with the folder comparison made and ACTED ON.
	///
	/// The comparison is made HERE, at the door every caller already goes through, rather than
	/// beside each of them: `Tool::run` reads this, and so does the terminal.
	///
	/// # The refusal
	///
	/// `hand/REVIEW.md` §1.14. A folder that cannot be shown to be this page's folder makes this
	/// answer `paired: false`, and `reason` carries the sentence §1.14 wrote for whichever of the
	/// four outcomes was reached. Every route to a command reads this first — `Tool::run` refuses
	/// on `paired`, `pty_request` refuses on `paired`, and the Terminal panel shows `reason` — so
	/// one refusal here closes all of them. The ORDINARY case is silent: an equal token adds
	/// `workspace: 'ok'` and nothing else, because a check that speaks every time it passes is a
	/// check people learn to dismiss.
	///
	/// What the hand said about itself is kept on the refusal — `root`, `caps`, `os` — because it
	/// is true and useful: the hand really did report those, and what is refused is that they
	/// describe the folder this page has open. Nothing composes a fence from it: every caller
	/// gates on `paired` before reading a root.
	///
	/// **No automated test can satisfy this check**, and that is structural rather than a gap in
	/// the tests. A page holds a real folder only through `showDirectoryPicker()`, a native dialog
	/// no harness can answer, so every headless run has an OPFS workspace — §1.14's third outcome,
	/// and a refusal. `dev/verify_wsident.mjs` therefore tests the refusal itself, with two real
	/// directory handles standing in for the two folders; `dev/verify_ptyedge.mjs` and
	/// `dev/verify_handreal.mjs` assert the refusal once against the real hand and then stand in
	/// for `status` for the rest, as `dev/verify_scope.mjs` does.
	function settled() {
		return proveFolder().then(function (p) {
			var out = JSON.parse(mine());
			out.workspace = p.ok ? 'ok' : 'mismatch';
			if (!p.ok) {
				out.paired = false;
				out.reason = p.why;
				out.workspace_reason = p.why;
			}
			return JSON.stringify(out);
		}, function () {
			// The check could not answer, which is not the same as answering yes. A folder that
			// cannot be compared is refused for the same reason a missing one is: the comparison
			// is what stands between a command and the wrong files.
			var out = JSON.parse(mine());
			out.paired = false;
			out.workspace = 'unchecked';
			out.workspace_reason = 'Daimond could not check whether the folder you have open is '
				+ 'the folder the machine hand was granted, so it will not run a command that '
				+ 'might reach different files from the ones it has been reading. Reopen the '
				+ 'folder for this workspace and try again.';
			out.reason = out.workspace_reason;
			return JSON.stringify(out);
		});
	}

	/// What we know about the hand now, as the tool reads it.
	function mine() {
		return JSON.stringify({
			paired:    true,
			transport: state.transport,
			machine:   state.machine,
			version:   state.version,
			os:        state.os,
			root:      state.root,
			caps:      state.caps,
		});
	}

	/// Forget the hand. Called when the user revokes the grant, so the next
	/// command refuses rather than reaching a hand they have withdrawn.
	function forget() {
		// The proof goes with it: a grant that has been withdrawn cannot vouch for a folder,
		// and the next hand may be a different one in a different place.
		wsProof = null;
		state.transport = 'none';
		state.machine   = '';
		state.version   = '';
		state.os        = '';
		state.root      = '';
		state.caps      = [];
	}

	/// Let go of the link, without forgetting that a hand was ever there.
	function close() {
		if (link) drop(link, 'The page let go of the machine hand.');
	}

	detect();

	// A tab that goes away should take its host with it rather than leave a
	// process holding the machine. The extension does this on its own when the
	// port dies, and saying `bye` first is the orderly half of the same thing.
	window.addEventListener('pagehide', close);

	window.DaimondHand = {
		init: function (d) {
			deps = d || {};
			if (deps.extId) state.extId = deps.extId;
		},
		setExtId: function (id) { state.extId = id || ''; },
		adopt: adopt,
		forget: forget,
		close: close,
		status: status,
		run: run,
		send: send,
		subscribe: subscribe,
		hasHand: function () { return state.transport !== 'none'; },
		/// Whether this page's folder is the folder the hand was granted, and the sentence to
		/// show when it is not. Resolves `{ ok, why }`; see `proveFolder`.
		workspaceProof: proveFolder,
		/// Test only. The waits are tens of seconds by design, and a test cannot
		/// spend a minute proving a hand is unresponsive. Same-origin callers
		/// only, and the worst one can do with it is make its own commands give
		/// up sooner.
		_setWaitsForTest: function (o) {
			if (typeof o === 'number') o = { grace: o };
			o = o || {};
			if (o.grace > 0) REPLY_GRACE = o.grace;
			if (o.slack > 0) REPLY_SLACK = o.slack;
			if (o.hello > 0) HELLO_WAIT  = o.hello;
			if (o.keep  > 0) { KEEP_HEAD = o.keep; KEEP_TAIL = o.keep; }
			return { grace: REPLY_GRACE, slack: REPLY_SLACK, hello: HELLO_WAIT, keep: KEEP_HEAD };
		},
	};
})();
