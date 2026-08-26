/* handpty.js — the machine hand's terminal relay, page side.
 *
 * `window.DaimondPty` is to a terminal what `window.DaimondHand` is to a
 * command: the ONE interface above the wire, so the thing drawing the screen
 * never learns which transport is attached. It is the sibling of hand.js and it
 * shares hand.js's link — see "One link, shared" below — because a terminal
 * session is not a second kind of connection to the machine, it is a second kind
 * of conversation on the one that already exists.
 *
 * ── Why a terminal is not an exec ───────────────────────────────────
 *
 * `Req::Exec` decides its input before the command starts and reads its output
 * afterwards. That covers nearly everything an agent does. It cannot cover
 * `sudo` asking for a password, `ssh` asking for a passphrase, or anything that
 * asks the kernel whether it is talking to a terminal and behaves differently
 * when it is not. Those need a pty, and a pty is a conversation: bytes both
 * ways, for as long as the program lives, with a size the kernel has to be told
 * about and told again.
 *
 * ── Bytes, not text ─────────────────────────────────────────────────
 *
 * `output` arrives as base64 and is decoded HERE, once, at this boundary. What
 * a subscriber receives is a `Uint8Array` of exactly what the program wrote.
 * Nothing above this line ever sees base64, and nothing below it ever sees a
 * string: a pty carries a `cat` of a binary file, a half-written UTF-8 character
 * at the edge of a read, and control sequences whose meaning is their exact
 * bytes. One mangled byte draws the rest of the screen wrong, and a lossy
 * conversion corrupts precisely the case a terminal exists to handle.
 *
 * ── A hole is shown, not stitched ───────────────────────────────────
 *
 * `output` carries a monotonic `seq`, and a step that is not +1 means a chunk is
 * missing. hand.js writes a marker INTO the stream at that point, because its
 * stream is text a model reads and the marker is a sentence. This file must not:
 * bytes written into a terminal stream are drawn, so a marker would be an escape
 * sequence's worth of damage on top of the loss. So the gap is surfaced BESIDE
 * the stream — `onGap` — and the bytes still go through. A terminal stitched
 * silently over a missing chunk draws a screen that never existed, which is the
 * one outcome worth going to any length to avoid.
 *
 * ── One link, shared ────────────────────────────────────────────────
 *
 * hand.js holds ONE port to the extension, opened lazily on the first thing that
 * needs a hand, and multiplexes runs by the `id` the wire already carries. A
 * terminal session travels on that same link and is told apart by the same id.
 * Opening a second port would start a second host process, ask a second approval
 * question, and give the user two hands where they granted one.
 *
 * So this file owns no transport at all. It needs exactly two things from
 * hand.js, and nothing else:
 *
 *	DaimondHand.send(msg) -> Promise<void>
 *		Post one wire message on the one link, opening and greeting it
 *		first if need be. Rejects with the sentence the model reads,
 *		verbatim: not installed, declined, stopped part-way.
 *
 *	DaimondHand.subscribe(id, fn) -> unsubscribe()
 *		Every message the hand sends carrying that `id`, in arrival
 *		order. Plus `{t:'__gone', message, met}` when the link dies,
 *		where `message` is the sentence hand.js already writes and `met`
 *		says whether a hand ever answered in this page.
 *
 * ── The fence is not this file's to invent ──────────────────────────
 *
 * A terminal session runs a real program on the user's machine, so it goes
 * through the same fence and the same grant as `Tool::Run`: `fence_spec` in
 * src/tools.rs computes the compartment, the extension vets it, and the hand
 * enforces it. This file composes no fence and relaxes none. It refuses an
 * `open` that arrives without one — not as a security boundary, which it is not
 * placed to be, but because a caller that forgot the fence has a bug, and the
 * sentence saying so is more use than a refusal from two layers down.
 */
(function () {
	'use strict';

	/// What a caller reads when this page has no hand relay at all. Distinct
	/// from "no hand is paired": the relay is part of the app, so its absence
	/// means the page is broken rather than the machine unequipped.
	var NO_RELAY = 'This page has no machine hand relay loaded, so no terminal can be opened. '
		+ 'That is a fault in the app rather than anything about the user\'s machine: '
		+ 'js/hand.js has not been loaded. Nothing else is affected.';

	/// What a caller reads when hand.js is present but predates terminals.
	///
	/// Kept apart from `NO_RELAY` because the instruction differs: one is a page
	/// missing a file, the other a page whose relay cannot carry these messages,
	/// and telling a user their hand is broken when the page is old would send
	/// them to reinstall software that is working.
	var NO_CARRY = 'The machine hand relay in this page cannot carry terminal messages. '
		+ 'The hand itself may be perfectly healthy — it is this page that is older than '
		+ 'the terminal. Reload the app, and if it persists the app needs updating. '
		+ 'Commands can still be run; only the interactive terminal is unavailable.';

	/// The longest the page waits for `opened` after asking for a terminal.
	///
	/// Long, because a human sits inside it: the first thing on this link puts
	/// the approval window on the user's screen, and hand.js holds the request
	/// in order until it is answered. Bounded all the same, because a question
	/// nobody answers must still end as a refusal rather than as a terminal that
	/// never draws anything and never says why.
	var OPEN_WAIT = 60000;

	/// How much output is held for a session nobody has subscribed to yet.
	///
	/// A program can write its first screen before the caller has attached a
	/// renderer, and a terminal that misses its own first screen is broken. What
	/// will not fit is dropped from the OLDEST end and counted, and the count is
	/// reported as a gap on attachment — the same rule as everywhere else in
	/// this file: what is lost is said, never smoothed over.
	var BUFFER_MAX = 256 * 1024;

	/// The largest terminal this page will ask for. A size is two `u16`s on the
	/// wire and a number outside that is not a big terminal, it is a bug on its
	/// way to becoming a frame the hand cannot read.
	var CELLS_MAX = 65535;

	/// Sessions believed to be open, by id.
	var live = {};

	/// Serial for minted ids, so two terminals in one page never collide.
	var serial = 0;

	// ── The link ────────────────────────────────────────────────────

	/// The hand relay, or null when this page has none.
	function hand() {
		return (window.DaimondHand && typeof window.DaimondHand === 'object')
			? window.DaimondHand : null;
	}

	/// Whether the relay in this page can carry terminal messages at all.
	///
	/// Feature-detected rather than assumed, so a page whose hand.js predates
	/// terminals refuses with a sentence instead of throwing on a missing
	/// method — the difference between a user who knows to reload and one
	/// watching a blank panel.
	function carries() {
		var h = hand();
		return !!(h && typeof h.send === 'function' && typeof h.subscribe === 'function');
	}

	/// Why this page cannot carry a terminal, or '' when it can.
	function whyNot() {
		if (!hand()) return NO_RELAY;
		if (!carries()) return NO_CARRY;
		return '';
	}

	// ── Bytes ───────────────────────────────────────────────────────

	/// Base64 to the bytes it stands for.
	///
	/// `atob` yields a binary string — one UTF-16 unit per byte, each below
	/// 256 — which is masked back down to bytes. Going through a string is not
	/// elegant and is the only decoder a page has without a dependency; the mask
	/// is what makes it exact rather than nearly right.
	function bytesOf(b64) {
		var s = atob(b64);
		var out = new Uint8Array(s.length);
		for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
		return out;
	}

	/// Bytes to the base64 the wire carries them as.
	///
	/// Chunked, because `String.fromCharCode.apply` on a large array overflows
	/// the argument stack — a paste of a long file is exactly the case that
	/// finds it.
	function b64Of(u8) {
		var s = '';
		for (var i = 0; i < u8.length; i += 0x8000) {
			s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
		}
		return btoa(s);
	}

	/// Whatever a caller typed, as bytes.
	///
	/// A string is taken as text and encoded UTF-8, which is what a keyboard
	/// produces; anything array-like is taken as the bytes it already is.
	function asBytes(data) {
		if (data == null) return new Uint8Array(0);
		if (typeof data === 'string') return new TextEncoder().encode(data);
		if (data instanceof Uint8Array) return data;
		if (data instanceof ArrayBuffer) return new Uint8Array(data);
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		if (Array.isArray(data)) return new Uint8Array(data);
		return new TextEncoder().encode(String(data));
	}

	// ── Sessions ────────────────────────────────────────────────────

	/// A fresh session record.
	function session(id) {
		return {
			id:      id,
			pid:     0,
			seq:     null,   // set by the FIRST output; where the hand starts counting is its business
			subs:    null,   // the handlers, once someone attaches
			off:     null,   // unsubscribe from the link
			buf:     [],     // output held for a subscriber that has not attached
			bufLen:  0,
			dropped: 0,      // bytes the buffer could not hold
			gaps:    0,      // holes seen, for a caller that wants to say so on screen
			done:    false,
			timer:   null,
			resolve: null,
			reject:  null,
		};
	}

	/// Call one handler without letting it take the relay down with it.
	///
	/// A renderer that throws on one frame must not stop the next one arriving:
	/// the bytes are the machine's, and losing them because the drawing code has
	/// a bug turns a visual fault into a lost session.
	function fire(s, name, arg) {
		if (!s.subs || typeof s.subs[name] !== 'function') return;
		try { s.subs[name](arg); } catch (e) { /* the renderer's problem, not the link's */ }
	}

	/// Give a subscriber the bytes, or hold them until there is one.
	function deliver(s, u8) {
		if (!u8.length) return;
		if (s.subs) { fire(s, 'onOutput', u8); return; }
		s.buf.push(u8);
		s.bufLen += u8.length;
		while (s.bufLen > BUFFER_MAX && s.buf.length > 1) {
			var old = s.buf.shift();
			s.bufLen -= old.length;
			s.dropped += old.length;
		}
	}

	/// Hand a newly attached subscriber everything that arrived before it.
	function flush(s) {
		var held = s.buf;
		var lost = s.dropped;
		s.buf = [];
		s.bufLen = 0;
		s.dropped = 0;
		if (lost) {
			s.gaps++;
			fire(s, 'onGap', {
				dropped: lost,
				reason:  'Output arrived before anything was drawing it, and more of it than the page '
					+ 'would hold, so the oldest ' + lost + ' bytes were dropped. The screen below '
					+ 'starts part-way through.',
			});
		}
		for (var i = 0; i < held.length; i++) fire(s, 'onOutput', held[i]);
	}

	/// Finish a session once, whichever way it finished.
	///
	/// `how` is the ending as a caller reads it: an exit status where the
	/// program had one, and a sentence where the link died instead.
	function settle(s, how) {
		if (s.done) return;
		s.done = true;
		clearTimeout(s.timer);
		delete live[s.id];
		// A caller still waiting on the opening is owed the sentence rather than
		// a promise that never settles: `reject` is cleared the moment `opened`
		// arrives, so its presence here means the terminal never opened at all.
		if (s.reject) {
			var rej = s.reject;
			s.resolve = null;
			s.reject  = null;
			rej(new Error(how.refusal || how.reason || 'The terminal closed before it opened.'));
		}
		fire(s, 'onClosed', how);
		if (s.off) { try { s.off(); } catch (e) { /* already gone */ } s.off = null; }
	}

	/// Accumulate one `output`, in order, and pass it on.
	///
	/// The FIRST output sets the baseline — where the hand starts counting is
	/// the hand's business, and hand.js's `absorb` and the extension's own check
	/// both say the same. Assuming zero would open every session with a hole it
	/// did not have, which is the same failure as hiding one: the marker stops
	/// meaning anything.
	function absorb(s, msg) {
		var want = s.seq;
		if (want !== null && msg.seq !== want) {
			s.gaps++;
			fire(s, 'onGap', {
				expected:  want,
				got:       msg.seq,
				missing:   msg.seq - want,
				backwards: msg.seq < want,
				reason:    msg.seq < want
					? 'The terminal\'s output went backwards, from ' + want + ' to ' + msg.seq
						+ '. What is drawn after this point is not what the program wrote.'
					: 'The terminal is missing ' + (msg.seq - want) + ' chunk(s) of output, '
						+ 'between sequence ' + want + ' and ' + msg.seq + '. The screen below '
						+ 'has a hole in it and cannot be trusted as a transcript.',
			});
		}
		s.seq = msg.seq + 1;
		var u8;
		try { u8 = bytesOf(String(msg.data == null ? '' : msg.data)); }
		catch (e) {
			fire(s, 'onError', 'The machine hand sent a chunk of terminal output that is not '
				+ 'base64, so those bytes are lost. The rest of the session carries on.');
			return;
		}
		deliver(s, u8);
	}

	/// One message about a session, routed.
	///
	/// Only a RECOGNISED type does anything, exactly as in hand.js: a host
	/// sending something the page does not understand is not evidence that a
	/// terminal is alive, and treating it as such is how a promise is held open
	/// for ever.
	function fromHand(s, msg) {
		if (!msg || typeof msg.t !== 'string') return;

		if (msg.t === 'opened') {
			s.pid = Number(msg.pid) || 0;
			clearTimeout(s.timer);
			if (s.resolve) {
				var res = s.resolve;
				s.resolve = null;
				s.reject = null;
				res({ id: s.id, pid: s.pid });
			}
			return;
		}
		if (msg.t === 'output') { absorb(s, msg); return; }
		if (msg.t === 'closed') {
			settle(s, {
				id:     s.id,
				exit:   typeof msg.exit === 'number' ? msg.exit : -1,
				killed: !!msg.killed,
				gaps:   s.gaps,
			});
			return;
		}
		if (msg.t === 'refused') {
			// Whole sentences, written for a person or a model to act on. Passed
			// through untouched: wrapping one loses the only instruction it gives.
			settle(s, { id: s.id, exit: -1, killed: false, gaps: s.gaps, refusal: msg.reason || '' });
			return;
		}
		if (msg.t === 'error') {
			// An error ABOUT a session is a note, not an ending — the same rule
			// hand.js follows. The extension reports a sequence gap this way and
			// then carries on sending output; treating it as a settlement throws
			// away a session that was going to keep working.
			fire(s, 'onError', msg.message || 'The machine hand reported a problem with this terminal.');
			return;
		}
		if (msg.t === '__gone') {
			// The link died. `met` is hand.js's own record of whether a hand ever
			// answered in this page, and it is the whole difference between "you
			// have not installed it" and "it stopped" — two different instructions
			// to a user, and telling someone to install what they already have
			// wastes their afternoon.
			settle(s, {
				id:      s.id,
				exit:    -1,
				killed:  true,
				gaps:    s.gaps,
				stopped: !!msg.met,
				absent:  !msg.met,
				reason:  msg.message || NO_RELAY,
			});
		}
	}

	// ── Opening one ─────────────────────────────────────────────────

	/// A caller-supplied id, checked, or a fresh one.
	///
	/// The id is echoed on every message about the session, so an unbounded or
	/// unprintable one is a frame the hand cannot send. The extension enforces
	/// the same limits on the way past; this refuses earlier, where the caller
	/// can still be told which of its own values was wrong.
	function idFor(spec) {
		var id = spec && typeof spec.id === 'string' ? spec.id : '';
		if (!id) {
			serial++;
			return 'pty-' + serial + '-' + Math.random().toString(36).slice(2, 8);
		}
		return id;
	}

	/// What is wrong with an `open`, in a whole sentence, or '' when nothing is.
	///
	/// Deliberately short. The compartment is checked by the extension and
	/// ENFORCED by the hand, which knows what it granted; nothing here pretends
	/// otherwise. What it does is catch a caller that forgot the fence, because
	/// a refusal naming `fence_spec` is more use than one from two layers down
	/// that can only say the fence was missing.
	function wrongOpen(spec) {
		if (!spec || typeof spec !== 'object') {
			return 'A terminal needs a request saying what to run: {argv, cwd, env, size, fence}.';
		}
		if (!Array.isArray(spec.argv) || !spec.argv.length
			|| !spec.argv.every(function (a) { return typeof a === 'string'; })) {
			return 'A terminal needs argv: the program and its arguments, as an array of strings. '
				+ 'A shell is a perfectly ordinary thing to put in argv[0] — it is a shell STRING '
				+ 'that has no meaning here, because there is nothing to interpret one.';
		}
		if (typeof spec.cwd !== 'string' || spec.cwd.charAt(0) !== '/') {
			return 'A terminal needs cwd: an absolute working directory inside the fence. '
				+ 'The hand does not guess what a relative path is relative to.';
		}
		if (!spec.fence || typeof spec.fence !== 'object' || Array.isArray(spec.fence)) {
			return 'A terminal needs a fence saying what the session may touch: {rw, ro, deny, net}. '
				+ 'It is composed by fence_spec in src/tools.rs from the Diamond\'s bounds and the '
				+ 'folder the user granted, exactly as it is for a command — this relay does not '
				+ 'compose one, and a session with no compartment is not opened.';
		}
		var rw = Array.isArray(spec.fence.rw) ? spec.fence.rw : [];
		var ro = Array.isArray(spec.fence.ro) ? spec.fence.ro : [];
		if (!rw.length && !ro.length) {
			return 'That fence names no root at all, so the session could not read the directory it '
				+ 'would start in. Say what it may work under.';
		}
		return '';
	}

	/// A size the wire can carry, from whatever the caller offered.
	function sizeOf(size) {
		var cols = Math.floor(Number((size && size.cols) || 80));
		var rows = Math.floor(Number((size && size.rows) || 24));
		if (!(cols > 0)) cols = 80;
		if (!(rows > 0)) rows = 24;
		return { cols: Math.min(cols, CELLS_MAX), rows: Math.min(rows, CELLS_MAX) };
	}

	/// Open a terminal and attach a program to it.
	///
	/// `spec` is the wire's own `open` request, composed by the caller that owns
	/// the fence — the Rust side, via `fence_spec`. It is passed through
	/// unchanged but for an id and a size, so there is ONE place a request is
	/// composed and it is the one that holds the compartment.
	///
	/// `subs` is optional and may also be attached later with `subscribe`;
	/// passing it here is the safe order, because a program can write its first
	/// screen before this promise resolves.
	///
	/// # Returns
	/// A promise resolving to `{id, pid}` when the hand says `opened`, and
	/// rejecting with the refusal verbatim when it will not.
	function open(spec, subs) {
		if (typeof spec === 'string') {
			try { spec = JSON.parse(spec); }
			catch (e) { return Promise.reject(new Error('The terminal request could not be read: ' + e.message)); }
		}
		var no = whyNot();
		if (no) return Promise.reject(new Error(no));
		var bad = wrongOpen(spec);
		if (bad) return Promise.reject(new Error(bad));

		var id = idFor(spec);
		var s  = session(id);
		if (subs) s.subs = subs;
		live[id] = s;

		// EVERY FIELD THE COMPOSER SENT, and not a list of the ones this file
		// happened to know about.
		//
		// It WAS such a list until 2026-08-24, and the list was one field out of
		// date. `pty_request` grew `toolkits` when a Diamond's granted toolchain
		// began travelling beside the fence — the hand cannot check a fence naming
		// `~/.cargo/registry` against the granted root unless it is TOLD which
		// toolchain was granted — and this end went on sending the same six
		// fields. So a session in a Diamond granted git arrived at the extension
		// with `~/.gitconfig` in its fence and no toolchain named, was refused by
		// the extension's own correct rule, and the owner could not open a
		// terminal at all. The two ends had not disagreed about the fence; one of
		// them had simply stopped copying part of the request.
		//
		// The compartment is composed in ONE place, in Rust, and `wrongOpen` above
		// says so in as many words. A relay that re-lists the fields is a second
		// composer holding an older idea of what a request is, so this one
		// re-lists nothing: what arrived is forwarded whole, and only what this
		// end OWNS is set over the top of it. The id is this end's because only it
		// knows which sessions this page already has open; the size is normalised
		// because the wire carries two cell counts and a caller may hand over
		// anything; `env` and `argv` are pinned to the shapes the wire requires.
		// The extension checks what arrives and the hand enforces it, so a field
		// this end does not understand is not this end's to drop.
		var msg = {};
		for (var k in spec) {
			if (Object.prototype.hasOwnProperty.call(spec, k)) msg[k] = spec[k];
		}
		msg.t    = 'open';
		msg.id   = id;
		msg.argv = spec.argv.slice();
		msg.env  = Array.isArray(spec.env) ? spec.env : [];
		msg.size = sizeOf(spec.size);

		return new Promise(function (resolve, reject) {
			s.resolve = resolve;
			s.reject  = reject;
			s.off = hand().subscribe(id, function (m) { fromHand(s, m); });
			s.timer = setTimeout(function () {
				settle(s, {
					id: id, exit: -1, killed: false, gaps: s.gaps,
					refusal: 'Daimond asked for a terminal and the machine hand did not open one. The '
						+ 'approval window may still be waiting — the Daimond Hands toolbar icon carries '
						+ 'the question until it is answered. Answer it and try again.',
				});
			}, OPEN_WAIT);
			hand().send(msg).catch(function (e) {
				// hand.js's rejection is already a whole sentence about a hand
				// that is missing, declined or stopped. Verbatim, or the user is
				// told to fix the wrong thing.
				settle(s, { id: id, exit: -1, killed: false, gaps: s.gaps, refusal: (e && e.message) || NO_RELAY });
			});
		});
	}

	/// Attach a renderer to a session, and receive everything it has already
	/// said.
	///
	/// `subs` is `{onOutput, onGap, onClosed, onError}`, all optional:
	///
	///	onOutput(Uint8Array)	exactly the bytes the program wrote
	///	onGap({expected, got, missing, backwards, dropped, reason})
	///				output is missing; what follows is not continuous
	///	onClosed({exit, killed, gaps, stopped, absent, reason, refusal})
	///				the session is over, one way or another
	///	onError(sentence)	a note about the session that did not end it
	///
	/// # Returns
	/// A function that detaches. Detaching does not close the session; use
	/// `close` for that.
	function subscribe(id, subs) {
		var s = live[id];
		if (!s) return function () {};
		s.subs = subs || null;
		if (s.subs) flush(s);
		return function () { s.subs = null; };
	}

	/// Send keystrokes to a terminal.
	///
	/// Raw, and not a line: a terminal is a byte stream, and `Ctrl-C`, an arrow
	/// key and a bracketed paste are all just bytes the program is entitled to
	/// see as they were typed. A string is encoded UTF-8; anything array-like is
	/// sent as the bytes it already is.
	function input(id, data) {
		var no = whyNot();
		if (no) return Promise.reject(new Error(no));
		if (!live[id]) {
			return Promise.reject(new Error('There is no terminal "' + id + '" in this page to type into. '
				+ 'It has closed, or it was never opened here.'));
		}
		var u8 = asBytes(data);
		if (!u8.length) return Promise.resolve();
		return hand().send({ t: 'input', id: id, data: b64Of(u8) });
	}

	/// Tell the kernel the window changed size, which tells the program.
	///
	/// A program asks the kernel how big its terminal is, not the page, so it
	/// has to be told at the pty and told again on every change — a `less` that
	/// thinks it has 24 rows on an 80-row screen is the visible symptom of
	/// forgetting the second half.
	function resize(id, cols, rows) {
		var no = whyNot();
		if (no) return Promise.reject(new Error(no));
		if (!live[id]) {
			return Promise.reject(new Error('There is no terminal "' + id + '" in this page to resize.'));
		}
		return hand().send({ t: 'resize', id: id, size: sizeOf({ cols: cols, rows: rows }) });
	}

	/// Ask a terminal's program to stop.
	///
	/// **There is no `close` on the wire, and that is deliberate.** A session
	/// ends when the program does, and the way to end a program is to signal it
	/// — the same `Req::Signal` any other run is ended with, carrying this
	/// session's id. So this asks, and the authoritative ending remains the
	/// `closed` message the hand sends when the program has actually gone.
	///
	/// # Arguments
	/// * `id` - The session.
	/// * `sig` - `'term'` to ask, `'kill'` to insist, `'int'` to interrupt as
	///   `Ctrl-C` would. Asking is the default: a shell given `SIGTERM` writes
	///   out its history, and one given `SIGKILL` does not.
	function close(id, sig) {
		var no = whyNot();
		if (no) return Promise.reject(new Error(no));
		if (!live[id]) return Promise.resolve();
		var which = (sig === 'kill' || sig === 'int') ? sig : 'term';
		return hand().send({ t: 'signal', id: id, sig: which });
	}

	/// Forget a session locally, without asking the machine anything.
	///
	/// For a caller tearing down its own view: the program is still running and
	/// the hand still owns it. Ending the LINK is what ends the program, and
	/// hand.js does that when the page goes away.
	function forget(id) {
		var s = live[id];
		if (!s) return;
		settle(s, {
			id: id, exit: -1, killed: false, gaps: s.gaps,
			reason: 'The page let go of this terminal. The program is the hand\'s until the link closes.',
		});
	}

	/// What can be said about terminals here, without opening anything.
	///
	/// It never rejects: a caller asking what is attached is owed an answer, and
	/// the sentence explaining a "no" is otherwise lost. `carries` is about THIS
	/// PAGE — whether its relay can carry these messages at all — and is a
	/// different question from whether the machine's hand can allocate a pty,
	/// which the hand answers in its own `caps` and which is read from there.
	function status() {
		var no = whyNot();
		var mine = { carries: carries(), sessions: Object.keys(live).length };
		if (no) {
			return Promise.resolve(JSON.stringify(Object.assign({
				paired: false, transport: 'none', caps: [], reason: no,
			}, mine)));
		}
		return hand().status().then(function (raw) {
			var j;
			try { j = JSON.parse(raw); } catch (e) { j = { paired: false, caps: [], reason: String(raw) }; }
			return JSON.stringify(Object.assign(j, mine));
		}, function (e) {
			return JSON.stringify(Object.assign({
				paired: false, transport: 'none', caps: [], reason: (e && e.message) || no || NO_RELAY,
			}, mine));
		});
	}

	/// The sessions this page believes are open.
	function sessions() {
		return Object.keys(live);
	}

	window.DaimondPty = {
		open:      open,
		subscribe: subscribe,
		input:     input,
		resize:    resize,
		close:     close,
		forget:    forget,
		status:    status,
		sessions:  sessions,
		/// Test only. The waits are tens of seconds by design, and a test cannot
		/// spend a minute proving a terminal never opened. Same-origin callers
		/// only, and the worst one can do with it is make its own sessions give
		/// up sooner.
		_setWaitsForTest: function (o) {
			o = (typeof o === 'number') ? { open: o } : (o || {});
			if (o.open   > 0) OPEN_WAIT  = o.open;
			if (o.buffer > 0) BUFFER_MAX = o.buffer;
			return { open: OPEN_WAIT, buffer: BUFFER_MAX };
		},
	};
})();
