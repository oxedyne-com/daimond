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
 */
(function () {
	'use strict';

	/// What a person reads in the panel. Model-facing strings — what a tool call
	/// returns — stay in the language the system prompt is written in, as in web.js.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	var state = {
		transport: 'none',   // 'none' | 'machine' | 'cloud'
		extId:     '',
		machine:   '',       // what the hand calls the box it runs on
		root:      '',       // the absolute folder the grant covers
		caps:      [],       // what the hand can actually enforce here
	};

	var deps = {};           // { onChunk, onStart, onEnd, note } — supplied by daimond.js
	var live = {};           // id -> { seq: {out, err}, out: [], err: [] }

	/// The refusal a missing hand produces. It is the most-read sentence in this
	/// file — a user who has not installed the hand meets it on their first
	/// command — so it says what is missing and what still works, rather than
	/// merely that something failed.
	var NO_HAND = 'There is no machine hand paired with this browser, so there is '
		+ 'nothing to run commands on. Daimond runs in the browser, and a browser '
		+ 'cannot start a program; the hand is a small companion that can. Tell the '
		+ 'user it is not installed, and carry on with the file tools, which do not need it.';

	/// The longest the page waits on one command before giving up on the ANSWER.
	///
	/// Not the same as the command's own timeout, which the hand enforces and
	/// which is the real limit. This is the wait after which the page stops
	/// believing the hand is going to reply at all — a hand that has crashed
	/// sends nothing, and a tool call that never returns is a daimon that never
	/// speaks again.
	var REPLY_GRACE = 30000;

	// ── The extension bridge ────────────────────────────────────────

	/// Whether the extension is reachable at all from this page.
	function hasExt() {
		return !!(state.extId && window.chrome && chrome.runtime && chrome.runtime.connect);
	}

	/// Open a port to the extension for one command.
	///
	/// A PORT, not `sendMessage`: output streams, and `sendMessage` is one
	/// question and one answer. The port also gives an honest disconnect — if
	/// the native host dies, or Chrome drops the connection because a message
	/// exceeded its 1 MB cap, `onDisconnect` fires and the command can be
	/// reported as broken rather than left hanging.
	function connect() {
		if (!hasExt()) return null;
		try { return chrome.runtime.connect(state.extId, { name: 'daimond-hand' }); }
		catch (e) { return null; }
	}

	// ── Running a command ───────────────────────────────────────────

	/// Accumulate a chunk, in order, and pass it to whoever is drawing.
	///
	/// A gap in `seq` is SURFACED rather than hidden. Silently stitching over a
	/// missing chunk would hand the daimon output that never existed, and a
	/// build log with a hole in it is worse than one that says it has a hole.
	function absorb(run, msg) {
		var s = msg.stream === 'err' ? 'err' : 'out';
		var want = run.seq[s];
		if (msg.seq !== want) {
			run[s].push('\n[output missing: expected chunk ' + want + ', got ' + msg.seq + ']\n');
			run.gap = true;
		}
		run.seq[s] = msg.seq + 1;
		run[s].push(msg.data);
		if (deps.onChunk) { try { deps.onChunk(msg.id, s, msg.data); } catch (e) {} }
	}

	/// Run one command. `specJson` is the wire's own `exec` request, built by the
	/// wasm side; this function does not interpret it beyond reading the id, so
	/// there is one place the request is composed and it is the one that holds
	/// the fence.
	function run(specJson) {
		return new Promise(function (resolve, reject) {
			var spec;
			try { spec = JSON.parse(specJson); }
			catch (e) { reject(new Error('The command could not be read: ' + e.message)); return; }

			var port = connect();
			if (!port) { reject(new Error(NO_HAND)); return; }

			var id = spec.id || 'run';
			var run = { seq: { out: 0, err: 0 }, out: [], err: [], gap: false };
			live[id] = run;

			var done = false;
			function settle(fn, v) {
				if (done) return;
				done = true;
				clearTimeout(timer);
				delete live[id];
				try { port.disconnect(); } catch (e) {}
				fn(v);
			}
			var timer = setTimeout(function () {
				settle(reject, new Error('The machine hand did not answer. It may have stopped; '
					+ 'ask the user to check it is still running.'));
			}, REPLY_GRACE);

			port.onMessage.addListener(function (msg) {
				if (!msg || !msg.t) return;
				// Every message about a live command refreshes the grace period: a
				// long build is not an unresponsive hand, and the two must not be
				// confused.
				clearTimeout(timer);
				timer = setTimeout(function () {
					settle(reject, new Error('The machine hand stopped part-way through the command.'));
				}, REPLY_GRACE);

				if (msg.t === 'started') {
					if (deps.onStart) { try { deps.onStart(msg.id, msg.pid); } catch (e) {} }
					return;
				}
				if (msg.t === 'chunk')   { absorb(run, msg); return; }
				if (msg.t === 'refused') {
					settle(resolve, JSON.stringify({ refused: msg.reason }));
					return;
				}
				if (msg.t === 'error') {
					settle(reject, new Error(msg.message || 'The machine hand failed.'));
					return;
				}
				if (msg.t === 'ended') {
					if (deps.onEnd) { try { deps.onEnd(msg.id, msg.exit); } catch (e) {} }
					settle(resolve, JSON.stringify({
						exit:      msg.exit,
						timed_out: !!msg.timed_out,
						killed:    !!msg.killed,
						stdout:    run.out.join(''),
						stderr:    run.err.join(''),
						out_bytes: msg.out_bytes,
						err_bytes: msg.err_bytes,
					}));
				}
			});

			port.onDisconnect.addListener(function () {
				// The most likely cause by far is that the native host is not
				// installed, which Chrome reports only as a disconnect. Say the
				// actionable thing rather than the literal one.
				settle(reject, new Error(NO_HAND));
			});

			try { port.postMessage(spec); }
			catch (e) { settle(reject, new Error(NO_HAND)); }
		});
	}

	// ── What the hand is ────────────────────────────────────────────

	/// Ask the hand who and where it is.
	///
	/// The `root` it reports is load-bearing: the page CANNOT know a real
	/// folder's path, because the File System Access API hands over a handle and
	/// never a path, so the fence the wasm side builds is expressed against
	/// whatever the hand says its grant covers. A hand that will not say has to
	/// be treated as no hand at all — guessing a root would be guessing what a
	/// command may touch.
	function status() {
		return new Promise(function (resolve) {
			if (state.transport === 'none' || !state.root) {
				resolve(JSON.stringify({ paired: false, transport: 'none', caps: [] }));
				return;
			}
			resolve(JSON.stringify({
				paired:    true,
				transport: state.transport,
				machine:   state.machine,
				root:      state.root,
				caps:      state.caps,
			}));
		});
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
		state.root      = hello.root || '';
		state.caps      = hello.caps || [];
	}

	/// Forget the hand. Called when the user revokes the grant, so the next
	/// command refuses rather than reaching a hand they have withdrawn.
	function forget() {
		state.transport = 'none';
		state.machine   = '';
		state.root      = '';
		state.caps      = [];
	}

	window.DaimondHand = {
		init: function (d) { deps = d || {}; if (deps.extId) state.extId = deps.extId; },
		setExtId: function (id) { state.extId = id || ''; },
		adopt: adopt,
		forget: forget,
		status: status,
		run: run,
		hasHand: function () { return state.transport !== 'none'; },
		/// Test only. The grace period is thirty seconds by design, and a test
		/// cannot spend thirty seconds proving a hand is unresponsive.
		_setGraceForTest: function (ms) { if (ms > 0) REPLY_GRACE = ms; return REPLY_GRACE; },
	};
})();
