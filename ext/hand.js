// Daimond Hands -- the machine hand's relay.
//
// A web page cannot create a process. There is no flag and no future API, so
// the capability has to live in a program outside the page, and the only
// question worth arguing about is who may talk to that program. The answer is
// this file: Chrome connects the native messaging host to ONE extension, and
// this extension is connectable from the Daimond origins alone. There is no
// port to find and no secret to steal, because the browser is the doorman. A
// loopback daemon would be reachable by any page the user visits, and its whole
// defence would be one pasted secret. That reasoning is settled; see
// `hand/src/lib.rs`.
//
// So this file is a relay and almost nothing else. It carries wire messages
// between two ports:
//
//	the PAGE port	-- chrome.runtime.connect(extId, {name:'daimond-hand'}),
//			   which externally_connectable already restricts to the
//			   Daimond origins, and which is checked again here;
//	the HOST port	-- chrome.runtime.connectNative('com.oxedyne.daimond.hand'),
//			   a long-lived port rather than sendNativeMessage,
//			   because output STREAMS and a request/response call
//			   cannot carry a stream.
//
// One host process per page port. Chrome starts a fresh binary for every
// connectNative, and pairing them one to one means the handshake is per
// connection exactly as the wire describes it, a page that goes away takes its
// own host with it and nobody else's, and a host that dies kills only the runs
// that belonged to it.
//
// Three things this relay owes the page, which are the whole of its work.
//
// ORDER AND ATTRIBUTION. Every chunk carries an id, a stream and a monotonic
// per-stream seq. The relay forwards one message for one message: it never
// batches, never joins two chunks into a bigger one, and never holds one back
// to send it beside its neighbour. It also WATCHES the seq, and a step that is
// not +1 is announced as a gap before the chunk that revealed it. A gap that is
// hidden is output the reader believes is complete.
//
// THE 1 MB CAP. Chrome caps a host->extension message at 1 MB and drops the
// connection without ceremony when one exceeds it -- no error to the host, no
// event but a disconnect. The hand chunks below that (wire::CHUNK_MAX), so this
// should not happen; when it does, the disconnect is indistinguishable from a
// crash and would otherwise leave the page waiting for an `ended` that is never
// coming. So every disconnect closes out every run in flight and says what it
// might have been, and says it in the sentence the model reads.
//
// THE FIRST RUN. The commonest failure by far is that the host is not
// installed, and Chrome reports it as "Specified native messaging host not
// found." An error that repeats Chrome's sentence tells the user nothing they
// can act on. So that one case gets a sentence naming the host, the install
// script and the one thing to do next.
//
// Two audiences, two languages -- the same rule the broker follows. What the
// DAIMON reads, which is every `t:'error'` and `t:'refused'` sentence crossing
// the boundary, stays English: it is a protocol the model acts on. What the
// USER reads, which is the grant window and the toolbar, is translated.

'use strict';

(() => {

	const I = globalThis.DaimondExtI18n;
	const T = (...a) => I.t(...a);

	// ------------------------------------------------------------------
	// Constants
	// ------------------------------------------------------------------

	/// The native messaging host's name, which is also the manifest's file name
	/// in each browser's NativeMessagingHosts directory. `hand/install/` writes
	/// it; nothing else in the product knows this string.
	const HOST_NAME = 'com.oxedyne.daimond.hand';

	/// The port name a page must connect with. A name rather than an empty
	/// connect, so a later feature can open a second kind of port on the same
	/// boundary without either one guessing which it is.
	const PORT_NAME = 'daimond-hand';

	/// Where the user's approval is kept. `local`, not `session`: a grant that
	/// evaporated when the browser restarted would be asked for again every
	/// morning, and a question asked that often stops being read.
	const GRANT_KEY = 'handGrant';

	/// What the popup lists this grant as, and what its Revoke button sends
	/// back. Not a match pattern, because this grant is not about an origin --
	/// it is about the machine -- so it is deliberately unlike one.
	const PATTERN = 'machine-hand';

	/// The wire protocol version this relay was written against. It is not
	/// interpreted here: the page announces its own in `hello` and the hand
	/// answers with its own, and the two settle it between them. It is held
	/// only so a relay that has drifted can be recognised in a report.
	const PROTO = 1;

	/// Chrome's cap on a message FROM the host, and the reason a disconnect is
	/// ambiguous. Mirrors `wire::FRAME_MAX`.
	const FROM_HOST_MAX = 1000000;

	/// Chrome's cap on a message TO the host is 64 MB. A request over it kills
	/// the connection the same silent way, so an oversized `stdin` is refused
	/// here, with a sentence, rather than being sent and losing everything in
	/// flight. Set below the cap so the envelope cannot push it over.
	const TO_HOST_MAX = 60 * 1024 * 1024;

	/// While a command is running the worker must stay awake, and an MV3 worker
	/// is evicted after five minutes of quiet. A connected port resets that
	/// timer, but a build that prints nothing for six minutes is quiet by any
	/// measure. This is the plain keep-alive: a trivial API call on a timer,
	/// only while something is actually running.
	const AWAKE_MS = 20000;

	// The sentences the daimon reads. English, and phrased so the model can act
	// rather than retry. They are assembled once, here, so the wording of a
	// failure is not scattered through the code that detects it.

	const NOT_INSTALLED =
		`Daimond's machine hand is not installed on this computer, so no command can be run here. `
		+ `Chrome could not find the native messaging host "${HOST_NAME}". `
		+ `The user must build the hand and register it: from the Daimond repository, `
		+ `run "cargo build --release -p daimond-hand" and then "hand/install/install.sh", `
		+ `which writes one small file per browser and nothing else. `
		+ `hand/install/README.md is the whole procedure. `
		+ `Tell them that, and work in the browser instead until it is done.`;

	const FORBIDDEN =
		`Daimond's machine hand is installed but will not talk to this extension. `
		+ `Its host manifest for "${HOST_NAME}" does not list this extension in allowed_origins, `
		+ `which happens when the extension was loaded unpacked without the pinned key, or when the `
		+ `manifest was written for a different build. Re-running hand/install/install.sh repairs it.`;

	const DECLINED_SENTENCE =
		`The user declined: Daimond may not run commands on this computer. Do not ask for it again. `
		+ `Tell them what you wanted to run and why, and do the rest in the browser or in the workspace files.`;

	const DISMISSED_SENTENCE =
		`The approval window for running commands on this computer was closed before it was answered, `
		+ `so nothing may be run. The user may not have seen it -- the Daimond Hands icon carries the `
		+ `question until it is answered. Ask them to allow it and try again, or do the work another way.`;

	const REVOKED_SENTENCE =
		`The user withdrew permission to run commands on this computer, so everything running was stopped. `
		+ `Do not start anything else on this machine until they allow it again from the Daimond Hands icon.`;

	// ------------------------------------------------------------------
	// State
	// ------------------------------------------------------------------

	/// One relay per connected page. The map exists so a revocation can reach
	/// every one of them at once: a permission that is withdrawn while a build
	/// is running has to stop the build, or it was never a permission.
	const relays = new Set();

	/// The keep-alive timer, shared by every relay, running only while at least
	/// one command is in flight anywhere.
	let awake = null;

	/// Asks the user. Wired by background.js, which owns the grant window, the
	/// nonce table and the toolbar mark -- this file does not open a second one.
	let askUser = null;
	let ALLOWED = 'allowed';
	let DECLINED = 'declined';

	/// Hands this file the broker's own grant machinery.
	///
	/// It is passed in rather than reached for. Both scripts share one worker
	/// scope, so `ask` would in fact be visible here by accident of load order,
	/// and a dependency that works by accident is one that breaks silently when
	/// the order changes.
	///
	/// # Arguments
	/// * `fns` - `{ ask, ALLOWED, DECLINED }` from background.js.
	function wire(fns) {
		askUser		= fns.ask;
		ALLOWED		= fns.ALLOWED;
		DECLINED	= fns.DECLINED;
	}

	// ------------------------------------------------------------------
	// The grant
	// ------------------------------------------------------------------

	/// Has the user allowed commands on this machine?
	///
	/// Storage rather than a Chrome permission, because there is no Chrome
	/// permission for this. `nativeMessaging` is granted at install and cannot
	/// be asked for a second time, so it is a capability, not a decision. The
	/// decision is ours to record, and to be able to withdraw.
	async function granted() {
		try {
			const got = await chrome.storage.local.get(GRANT_KEY);
			return !!(got && got[GRANT_KEY] && got[GRANT_KEY].at);
		} catch (e) {
			return false;
		}
	}

	/// Puts the question to the user, in the extension's own window.
	///
	/// The same window, the same nonce, the same three answers as a site
	/// approval: allowed, declined, or a window that went away unseen. The last
	/// is not a refusal, and the daimon is told which it was, because one means
	/// stop asking and the other means ask again.
	///
	/// # Returns
	/// True if commands may now be run.
	async function askFor() {
		if (await granted()) return true;
		if (!askUser) return false;
		const answer = await askUser({ kind: 'hand' });
		if (answer !== ALLOWED) return answer;
		await chrome.storage.local.set({ [GRANT_KEY]: { at: Date.now() } });
		return true;
	}

	/// Withdraws it, and stops everything it allowed.
	///
	/// Revocation that let the current build finish would be a promise with an
	/// asterisk on it. Every host is disconnected, which is what kills the
	/// processes: the hand exits when its port closes.
	async function revoke() {
		await chrome.storage.local.remove(GRANT_KEY);
		for (const r of [...relays]) r.stop(REVOKED_SENTENCE);
		return true;
	}

	// ------------------------------------------------------------------
	// The boundary
	// ------------------------------------------------------------------

	/// Every host the manifest lets speak to us.
	///
	/// externally_connectable has already turned everyone else away by the time
	/// a connection arrives. This checks it again, from the manifest rather than
	/// from a second list that could drift, because the boundary is the product.
	///
	/// The dev origins carry a port and the live one does not, so both spellings
	/// go in and both are accepted below. A set that held only the port-bearing
	/// form would turn away localhost; only the bare form would turn away
	/// nothing, but by accident rather than by rule.
	function ourHosts() {
		const m		= chrome.runtime.getManifest();
		const pats	= (m.externally_connectable && m.externally_connectable.matches) || [];
		const out	= new Set();
		for (const p of pats) {
			const hit = /^[^:]+:\/\/(\*\.)?([^/]+)\//.exec(p);
			if (!hit) continue;
			out.add(hit[2]);			// with the port, where there is one
			out.add(hit[2].replace(/:\d+$/, ''));	// and without
		}
		return out;
	}

	/// Is this connection from a page we answer?
	function mayConnect(sender) {
		try {
			const u		= new URL(sender.url || sender.origin);
			const hosts	= ourHosts();
			return hosts.has(u.host) || hosts.has(u.hostname);
		} catch (e) {
			return false;
		}
	}

	// ------------------------------------------------------------------
	// The relay
	// ------------------------------------------------------------------

	/// One page port, one host port, and the bookkeeping that lets a failure be
	/// described rather than merely noticed.
	///
	/// # Arguments
	/// * `page` - The port the Daimond page opened.
	function relay(page) {
		/// The native port, or null once it has gone.
		let host = null;
		/// True once we have deliberately closed the pair, so the disconnect
		/// that follows is not reported as a surprise.
		let closing = false;
		/// Runs believed to be in flight, by id. The value carries the last seq
		/// seen on each stream, so a gap is a comparison rather than a guess.
		const runs = new Map();
		/// The largest message the host has sent. Only used to make the report
		/// after a silent disconnect more useful than "it went away".
		let biggest = 0;
		/// What the page said before the host was up.
		///
		/// A page connects and greets in the same breath, and between those two
		/// moments sits the grant window, which a person may take a minute over.
		/// Refusing the greeting because we were still asking would make the
		/// first connection of a fresh install fail for a reason that is not a
		/// failure. So it waits here, in order, and goes out in order.
		let outbox = [];

		const self = { stop, page, busy: () => runs.size > 0 };

		/// Says something to the page, if it is still there.
		///
		/// One postMessage per message, always. Coalescing two chunks would
		/// destroy the attribution the seq exists to provide, and buffering to
		/// "smooth" the stream would turn live output into a report.
		function say(m) {
			try {
				page.postMessage(m);
			} catch (e) {
				// The page has gone. Its own disconnect handler is about to run
				// and will take the host with it.
			}
		}

		/// The plain-English shape of an error to the daimon.
		function fail(id, message) {
			say({ t: 'error', id: id || null, message });
		}

		/// Closes out a run the page will otherwise wait for ever on.
		///
		/// An `ended` is owed for every `started`. When the host dies there is
		/// no exit status to report, so it is reported as the absence of one:
		/// exit -1, killed, and the error above it says why.
		function abandon(id) {
			say({ t: 'ended', id, exit: -1, timed_out: false, killed: true, out_bytes: 0, err_bytes: 0 });
		}

		/// Tears the pair down and tells the page why.
		///
		/// # Arguments
		/// * `why` - The sentence the daimon reads, or empty for an orderly close.
		function stop(why) {
			closing = true;
			relays.delete(self);
			if (why) {
				fail(null, why);
				for (const id of runs.keys()) abandon(id);
			}
			runs.clear();
			breathe();
			if (host) {
				// `bye` first, so a hand that is between commands exits of its
				// own accord and does not have to be reaped. The disconnect is
				// what actually guarantees it.
				try { host.postMessage({ t: 'bye' }); } catch (e) { /* already gone */ }
				try { host.disconnect(); } catch (e) { /* already gone */ }
				host = null;
			}
			try { page.disconnect(); } catch (e) { /* already gone */ }
		}

		/// The host sent something. Forward it, in order, having first checked
		/// the one property the page cannot check for itself.
		function fromHost(m) {
			if (!m || typeof m !== 'object' || typeof m.t !== 'string') {
				fail(null, 'The machine hand sent something that is not a wire message. Treat this hand as unusable and tell the user to reinstall it.');
				return;
			}

			try {
				const size = JSON.stringify(m).length;
				if (size > biggest) biggest = size;
			} catch (e) { /* unmeasurable; the forward still happens */ }

			if (m.t === 'started') {
				runs.set(m.id, { out: null, err: null });
				breathe();
			} else if (m.t === 'chunk') {
				checkSeq(m);
			} else if (m.t === 'ended' || m.t === 'refused') {
				runs.delete(m.id);
				breathe();
			}

			say(m);
		}

		/// Watches the per-stream sequence, and says so when it jumps.
		///
		/// The first chunk of a stream sets the baseline -- the hand's own
		/// numbering is its business -- and every one after it must be exactly
		/// one more. A gap is announced BEFORE the chunk that revealed it, so a
		/// reader assembling the output meets the warning at the point the
		/// output is wrong, not after the whole run.
		function checkSeq(m) {
			const r = runs.get(m.id);
			if (!r) return;	// Output for a run we never saw start; the host owns that story.
			const s = m.stream === 'err' ? 'err' : 'out';
			if (typeof m.seq !== 'number') return;
			const last = r[s];
			if (last !== null && m.seq !== last + 1) {
				fail(m.id, m.seq < last
					? `Output from ${m.id} on ${s} went backwards, from sequence ${last} to ${m.seq}. The stream is not in order and what follows cannot be trusted as a transcript.`
					: `Output from ${m.id} on ${s} jumped from sequence ${last} to ${m.seq}, so ${m.seq - last - 1} chunk(s) are missing. What follows has a hole in it.`);
			}
			r[s] = m.seq;
		}

		/// The host port went away. This is the ambiguous event, and the whole
		/// job here is to make it less ambiguous than Chrome left it.
		function hostGone() {
			const why = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
			host = null;
			if (closing) return;

			// Not installed is the first-run failure, and it is worth its own
			// sentence: Chrome's own wording names a string the user has never
			// heard of and no action at all.
			if (/not found|no such native|Specified native messaging host/i.test(why)) {
				stop(NOT_INSTALLED);
				return;
			}
			if (/forbidden|not allowed/i.test(why)) {
				stop(FORBIDDEN);
				return;
			}

			// Everything else is a crash or the 1 MB cap, and Chrome does not
			// say which -- the cap produces exactly this disconnect and nothing
			// else. So both are named, with the evidence we have.
			const n	= runs.size;
			const big = biggest > FROM_HOST_MAX / 2;
			stop(
				`The machine hand disconnected without finishing${why ? ` (${why})` : ''}. `
				+ `Either it crashed, or it sent a message larger than Chrome's 1 MB limit for a native `
				+ `messaging host, which makes Chrome drop the connection silently. `
				+ (big ? `The largest message it sent was ${biggest} bytes, close enough to the limit that this is the likely cause. ` : '')
				+ (n ? `${n} command(s) were running and their output is incomplete; their results are lost. ` : '')
				+ `Reconnect and run them again, and if it keeps happening tell the user to check the hand's journal.`);
		}

		/// The page sent something. Check what a malformed frame would cost,
		/// then forward it unchanged.
		function fromPage(m) {
			if (closing) {
				fail(m && m.id, 'This connection to the machine hand is closing, so nothing more can be sent on it. Open a new one.');
				return;
			}
			if (!m || typeof m !== 'object' || typeof m.t !== 'string') {
				fail(null, 'Every message to the machine hand needs a "t" saying which it is: hello, exec, signal or bye.');
				return;
			}

			switch (m.t) {
			case 'hello':
				break;
			case 'exec': {
				const bad = wrongExec(m);
				if (bad) {
					say({ t: 'refused', id: String(m.id || ''), reason: bad });
					return;
				}
				let size = 0;
				try { size = JSON.stringify(m).length; } catch (e) { size = 0; }
				if (size > TO_HOST_MAX) {
					say({
						t: 'refused',
						id: String(m.id),
						reason: `That command is ${size} bytes to send, over the ${TO_HOST_MAX} byte limit for a message to the machine hand. `
							+ `Chrome would drop the connection rather than deliver it, killing everything else running. `
							+ `Write the input to a file and have the command read the file instead.`,
					});
					return;
				}
				// Registered on the way OUT, not on `started`, so a command the
				// host dies before acknowledging is still one the page is owed
				// an answer about.
				if (!runs.has(m.id)) runs.set(m.id, { out: null, err: null });
				breathe();
				break;
			}
			case 'signal':
				if (!m.id || typeof m.id !== 'string') {
					fail(null, 'A signal needs the id of the run it is for.');
					return;
				}
				break;
			case 'bye':
				closing = true;
				break;
			default:
				fail(m.id, `The machine hand does not know the message "${m.t}". It understands hello, exec, signal and bye.`);
				return;
			}

			if (!host) {
				// Still asking the user, or still starting. Hold it in order.
				if (outbox.length >= 64) {
					fail(m.id, 'Too much was sent to the machine hand before it was ready. Wait for the "hello" it answers with before sending commands.');
					return;
				}
				outbox.push(m);
				return;
			}

			try {
				host.postMessage(m);
			} catch (e) {
				stop(`The machine hand could not be reached: ${(e && e.message) || e}. It has probably exited.`);
			}
		}

		/// What is wrong with this exec, in the sentence the model reads, or
		/// null when there is nothing wrong with it.
		///
		/// This is not the fence and does not pretend to be -- the hand enforces
		/// what a command may touch. It only catches the shapes that would make
		/// the host's own decode fail, where a decode failure costs the whole
		/// connection and every other run on it.
		function wrongExec(m) {
			if (!m.id || typeof m.id !== 'string') {
				return 'Every exec needs an id, which every answer about it is tagged with.';
			}
			if (!Array.isArray(m.argv) || !m.argv.length || !m.argv.every((a) => typeof a === 'string')) {
				return 'exec needs argv: the program and its arguments, as an array of strings. It is never a shell string -- there is no shell to interpret one.';
			}
			if (typeof m.cwd !== 'string' || !m.cwd) {
				return 'exec needs cwd, an absolute working directory inside the fence.';
			}
			return null;
		}

		// -- Wiring --------------------------------------------------------

		/// Opens the host, having established that it may be opened at all.
		async function begin() {
			const allowed = await askFor();
			if (allowed !== true) {
				// Declined and dismissed are different answers, and the daimon
				// must be able to tell them apart: one means stop asking.
				stop(allowed === DECLINED ? DECLINED_SENTENCE : DISMISSED_SENTENCE);
				return;
			}

			try {
				host = chrome.runtime.connectNative(HOST_NAME);
			} catch (e) {
				// A synchronous throw is the extension's own fault -- the
				// permission is missing from the manifest -- not the user's.
				stop(`This build of Daimond Hands cannot open a native messaging host: ${(e && e.message) || e}. `
					+ `The extension needs the "nativeMessaging" permission and has to be reloaded from chrome://extensions.`);
				return;
			}

			host.onMessage.addListener(fromHost);
			host.onDisconnect.addListener(hostGone);
			relays.add(self);

			// Whatever arrived while the question was open, in the order it
			// arrived. `connectNative` returns a port that is usable at once,
			// so a failure here is the host already having gone -- which its
			// own disconnect handler is about to describe properly.
			const held	= outbox;
			outbox		= [];
			for (const m of held) {
				if (!host) break;
				try { host.postMessage(m); } catch (e) { break; }
			}
		}

		page.onMessage.addListener(fromPage);
		page.onDisconnect.addListener(() => {
			// The page has gone: a tab closed, a reload, a crash. Whatever was
			// running belongs to nobody now, so it is stopped rather than left
			// as an orphan holding the machine's CPU.
			closing = true;
			stop('');
		});

		begin();
		return self;
	}

	/// Starts or stops the keep-alive according to whether anything is running.
	///
	/// A connected port already resets the worker's idle timer, but a command
	/// that prints nothing for minutes at a time sends no messages to reset it
	/// with. This is the trivial periodic call that keeps the worker resident;
	/// it does nothing else and stops the moment the last run ends.
	function breathe() {
		let busy = false;
		for (const r of relays) if (r.busy && r.busy()) { busy = true; break; }
		if (busy && !awake) {
			awake = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, AWAKE_MS);
		} else if (!busy && awake) {
			clearInterval(awake);
			awake = null;
		}
	}

	// ------------------------------------------------------------------
	// What the page and the popup may ask
	// ------------------------------------------------------------------

	/// Where things stand, for a page that wants to know before it connects.
	///
	/// It cannot say whether the host is INSTALLED without launching it, and
	/// launching it is the capability itself -- so it does not pretend to. It
	/// says what has been granted and what is connected, and the page learns the
	/// rest from `hello` or from the sentence that comes back instead.
	async function status() {
		return {
			ok:		true,
			proto:		PROTO,
			host:		HOST_NAME,
			port:		PORT_NAME,
			granted:	await granted(),
			connected:	relays.size,
		};
	}

	/// Asks for the grant from a page that would rather ask first than have a
	/// window appear the moment it connects.
	async function request() {
		const allowed = await askFor();
		if (allowed === true) return { ok: true, granted: true };
		return {
			ok:	false,
			granted: false,
			error:	allowed === DECLINED ? DECLINED_SENTENCE : DISMISSED_SENTENCE,
		};
	}

	// Only the Daimond origins reach this event at all -- externally_connectable
	// says so -- and the sender is checked again on the way in.
	chrome.runtime.onConnectExternal.addListener((port) => {
		if (!port || port.name !== PORT_NAME) return;
		if (!mayConnect(port.sender || {})) {
			try { port.disconnect(); } catch (e) { /* already gone */ }
			return;
		}
		relay(port);
	});

	globalThis.DaimondHand = {
		wire,
		status,
		request,
		revoke,
		granted,
		PATTERN,
		HOST_NAME,
		PORT_NAME,
	};

})();
