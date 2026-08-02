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

	/// Where the user's approvals are kept, one entry per origin. `local`, not
	/// `session`: a grant that evaporated when the browser restarted would be
	/// asked for again every morning, and a question asked that often stops
	/// being read.
	///
	/// The value is `{ '<origin>': { at, caps } }`. It was one boolean for the
	/// whole browser until 2026-08-02, and a reviewer showed what that costs:
	/// allowed once from `http://127.0.0.1:8777`, the hand was then reachable
	/// from `http://localhost:8777` with no window shown at all. A site grant
	/// next door is a real per-origin pattern that Chrome itself enforces, and
	/// this is the strongest thing in the product -- it cannot be the laxest.
	const GRANT_KEY = 'handGrants';

	/// What the popup lists these grants under, and the head of what its Revoke
	/// button sends back. Not a match pattern, because the thing granted is not
	/// an origin -- it is the machine, to one origin -- so it is deliberately
	/// unlike one. The whole pattern is `machine-hand:<origin>`.
	const PATTERN = 'machine-hand';

	/// The separator between that head and the origin it is about.
	const PATTERN_SEP = ':';

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

	/// How long the hand is given to say what it can enforce, before the user is
	/// asked without it. The exchange is one message each way over a pipe, so
	/// this is generous; it exists so a wedged host cannot leave the question
	/// unasked for ever.
	const CAPS_MS = 5000;

	// -- What an exec may look like --------------------------------------
	//
	// The hand enforces the fence; this file cannot and does not pretend to.
	// But the page composing the request is not trusted either -- the fence
	// arrived from the page verbatim until 2026-08-02, so a page chose its own
	// compartment and the compartment was decoration. These are the shapes the
	// relay can genuinely rule out from where it stands, and they are a SECOND
	// line: the durable clamp belongs in the hand, which knows what it granted.

	/// The longest caller-chosen run id. It is echoed on every message about the
	/// run, so an unbounded one is a frame the hand cannot send.
	const ID_MAX = 128;

	/// The longest wall-clock limit a command may ask for: a day. Beyond that a
	/// number is not a timeout, it is the absence of one.
	const TIMEOUT_MAX = 24 * 60 * 60 * 1000;

	/// Environment names that decide what code a program loads before its own
	/// `main` runs. `LD_PRELOAD` is the whole family's argument: name it, and the
	/// command that runs is not the command that was asked for. `hand/README.md`
	/// says the environment is not the model's for exactly this reason.
	const ENV_FORBIDDEN = /^(LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|GCONV_PATH|BASH_ENV|ENV|BASH_FUNC_.*)$/i;

	/// A shape a POSIX environment name can actually have.
	const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

	/// Roots no fence may name as writable. `/` is the whole machine, and the
	/// rest are the places from which the whole machine follows. This is a
	/// deny-list and therefore not the guarantee -- the guarantee is that the
	/// hand clamps a fence to what it granted -- but a page asking for `/` is
	/// answered here rather than one layer further in.
	const ROOT_FORBIDDEN = new Set([
		'/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64',
		'/media', '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv',
		'/sys', '/usr', '/var', '/Users', '/Library', '/System', '/Applications',
	]);

	// The sentences the daimon reads. English, and phrased so the model can act
	// rather than retry. They are assembled once, here, so the wording of a
	// failure is not scattered through the code that detects it.

	const NOT_INSTALLED =
		`Daimond's machine hand is not installed on this computer, so no command can be run here. `
		+ `Chrome could not find the native messaging host "${HOST_NAME}". `
		+ `The user must build the hand and register it: from the Daimond repository, `
		+ `run "cargo build --release --manifest-path hand/Cargo.toml" and then "hand/install/install.sh", `
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

	const NOT_OURS =
		`This page is not one Daimond Hands answers, so it cannot be given the machine hand. `
		+ `The extension replies to Daimond's own origins and to nothing else.`;

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

	/// Everything the user has allowed, by origin.
	///
	/// Storage rather than a Chrome permission, because there is no Chrome
	/// permission for this. `nativeMessaging` is granted at install and cannot
	/// be asked for a second time, so it is a capability, not a decision. The
	/// decision is ours to record, per origin, and to be able to withdraw.
	async function all() {
		try {
			const got = await chrome.storage.local.get(GRANT_KEY);
			const map = got && got[GRANT_KEY];
			return (map && typeof map === 'object') ? map : {};
		} catch (e) {
			return {};
		}
	}

	/// Has the user allowed commands on this machine, to this origin?
	///
	/// # Arguments
	/// * `origin` - The origin asking, e.g. `https://daimond.oxedyne.com`. With
	///   none, the question is whether ANY origin holds the grant, which is what
	///   the popup and the tests ask.
	async function granted(origin) {
		const map = await all();
		if (!origin) return Object.keys(map).some((o) => map[o] && map[o].at);
		return !!(map[origin] && map[origin].at);
	}

	/// What the popup lists, one line per origin that holds the grant.
	async function patterns() {
		const map = await all();
		return Object.keys(map)
			.filter((o) => map[o] && map[o].at)
			.map((o) => PATTERN + PATTERN_SEP + o);
	}

	/// The origin a popup pattern is about, or '' when it is not one of ours.
	///
	/// # Arguments
	/// * `pat` - What the Revoke button sent back.
	function originOfPattern(pat) {
		if (typeof pat !== 'string') return '';
		if (pat === PATTERN) return '';
		if (pat.indexOf(PATTERN + PATTERN_SEP) !== 0) return '';
		return pat.slice(PATTERN.length + PATTERN_SEP.length);
	}

	/// Whether a pattern belongs to this grant at all, so the broker can route
	/// a Revoke to us rather than to Chrome's permission system.
	function ours(pat) {
		return pat === PATTERN || !!originOfPattern(pat);
	}

	/// Puts the question to the user, in the extension's own window.
	///
	/// The same window, the same nonce, the same three answers as a site
	/// approval: allowed, declined, or a window that went away unseen. The last
	/// is not a refusal, and the daimon is told which it was, because one means
	/// stop asking and the other means ask again.
	///
	/// `caps` is what the hand said it can enforce on THIS machine, and the
	/// window's wording is chosen from it. A machine with no fence must not be
	/// described in the sentence written for one that has it: the promise the
	/// window makes is the only thing the user has to go on.
	///
	/// # Arguments
	/// * `origin` - Who is asking.
	/// * `caps` - The `caps` list from the hand's `hello`, or null if it never
	///   said.
	///
	/// # Returns
	/// True if commands may now be run for that origin.
	async function askFor(origin, caps) {
		if (!origin) return DECLINED;
		if (await granted(origin)) return true;
		if (!askUser) return false;
		const answer = await askUser({
			kind:	'hand',
			origin:	origin,
			// A space-separated list, because this crosses a URL into the grant
			// window. Absent means the hand never said, which is a third case
			// and is worded as one.
			caps:	Array.isArray(caps) ? caps.join(' ') : '',
		});
		if (answer !== ALLOWED) return answer;
		const map = await all();
		map[origin] = { at: Date.now(), caps: Array.isArray(caps) ? caps : [] };
		await chrome.storage.local.set({ [GRANT_KEY]: map });
		return true;
	}

	/// Withdraws it, and stops everything it allowed.
	///
	/// Revocation that let the current build finish would be a promise with an
	/// asterisk on it. Every host of that origin is disconnected, which is what
	/// kills the processes: the hand exits when its port closes.
	///
	/// # Arguments
	/// * `origin` - The one to withdraw. With none, all of them.
	async function revoke(origin) {
		if (origin) {
			const map = await all();
			delete map[origin];
			await chrome.storage.local.set({ [GRANT_KEY]: map });
		} else {
			await chrome.storage.local.remove(GRANT_KEY);
		}
		for (const r of [...relays]) {
			if (!origin || r.origin === origin) r.stop(REVOKED_SENTENCE);
		}
		return true;
	}

	// ------------------------------------------------------------------
	// The boundary
	// ------------------------------------------------------------------

	/// Every origin pattern the manifest lets speak to us, parsed.
	///
	/// Read from the manifest rather than from a second list that could drift,
	/// because the boundary is the product.
	function ourPatterns() {
		const m		= chrome.runtime.getManifest();
		const pats	= (m.externally_connectable && m.externally_connectable.matches) || [];
		const out	= [];
		for (const p of pats) {
			const hit = /^(\*|https?):\/\/(\*\.)?([^/*]+)\//.exec(p);
			if (!hit) continue;
			out.push({ scheme: hit[1], sub: !!hit[2], host: hit[3].toLowerCase() });
		}
		return out;
	}

	/// The origin this sender is, if the manifest allows it, and '' otherwise.
	///
	/// The PORT IS PART OF IT. The previous version of this function also added
	/// each pattern's host with the port stripped off, so it would have accepted
	/// `127.0.0.1:8778` on the strength of a pattern naming `127.0.0.1:8777` --
	/// a different origin, a different program, a different person. Chrome
	/// honours the port in `externally_connectable` and so nothing was
	/// exploitable through it, which is exactly the trouble with a second check
	/// that is laxer than the first: it is load-bearing only on the day the
	/// first one changes, and on that day it fails open.
	///
	/// `sender.origin` is Chrome's own answer and is preferred; `sender.url` is
	/// the fallback for a Chrome that did not send one.
	///
	/// # Arguments
	/// * `sender` - The `MessageSender` Chrome handed us.
	function allowedOrigin(sender) {
		let u;
		try {
			u = new URL((sender && (sender.origin || sender.url)) || '');
		} catch (e) {
			return '';
		}
		const scheme	= u.protocol.replace(/:$/, '').toLowerCase();
		const host	= u.host.toLowerCase();		// with the port, where there is one
		const name	= u.hostname.toLowerCase();	// without it
		for (const p of ourPatterns()) {
			if (p.scheme !== '*' && p.scheme !== scheme) continue;
			// A pattern that names a port must match it exactly; one that does
			// not is about the default port and is compared without one.
			const want = p.host;
			if (/:\d+$/.test(want) ? want === host : (want === name && want === host)) {
				return u.origin;
			}
			// `*.example.com` covers subdomains, and only downward.
			if (p.sub && !/:\d+$/.test(want) && name.endsWith('.' + want) && name === host) {
				return u.origin;
			}
		}
		return '';
	}

	/// Is this connection from a page we answer?
	function mayConnect(sender) {
		return !!allowedOrigin(sender);
	}

	// ------------------------------------------------------------------
	// Paths
	//
	// Enough of one to compare two the way the hand does, and no more. The
	// authority on what a path means is the machine it is on; these three
	// answer the questions that can be settled without asking it.
	// ------------------------------------------------------------------

	/// Is this path absolute, in either of the two spellings the hand runs on?
	///
	/// # Arguments
	/// * `p` - The path as it was written.
	function absolute(p) {
		return /^\//.test(p) || /^[A-Za-z]:[\\/]/.test(p);
	}

	/// The named components of a path, with the empties dropped.
	function segments(p) {
		return String(p).split(/[\\/]+/).filter(Boolean);
	}

	/// Is `p` the same folder as `root`, or one beneath it?
	///
	/// Compared component by component, so `/workshop` is not inside `/work` --
	/// the same rule `exec.rs` applies with `Path::starts_with`, and the reason a
	/// string prefix will not do. Neither side is resolved: a symbolic link is
	/// the machine's business and this end cannot see one.
	///
	/// # Arguments
	/// * `p` - The candidate path.
	/// * `root` - The root it might sit under.
	function under(p, root) {
		const a = segments(p);
		const b = segments(root);
		if (b.length > a.length) return false;
		for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
		return true;
	}

	// ------------------------------------------------------------------
	// The relay
	// ------------------------------------------------------------------

	/// One page port, one host port, and the bookkeeping that lets a failure be
	/// described rather than merely noticed.
	///
	/// # Arguments
	/// * `page` - The port the Daimond page opened.
	/// * `origin` - Which Daimond origin it is, already checked.
	function relay(page, origin) {
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
		/// The folder the hand says its grant covers, from its `hello`, or ''
		/// while it has not said. When it has, no fence may name a root outside
		/// it; when it has not, the relay can only refuse the roots that are
		/// wrong on any machine.
		let hostRoot = '';
		/// The home directory the hand reports, from its `hello`, or '' while it
		/// has not said.
		///
		/// A toolchain does not live in the workspace: `cargo` is under
		/// `~/.cargo`, `node` under `~/.nvm`, and a fence that must reach one of
		/// them names a folder outside the grant by construction. Refusing every
		/// such root -- which this relay did -- refuses every build the toolkit
		/// feature exists to enable, and the page was left holding a refusal
		/// about a folder the model can do nothing about while the daimon had
		/// been told `cargo` was on its PATH.
		///
		/// So a root outside the grant is allowed through HERE when the same
		/// request says a toolkit was granted and the root is inside this home
		/// directory. That is deliberately the loose half of the answer: WHICH
		/// folders each toolkit reaches, and at which level, is a table the hand
		/// holds and checks exactly (`vet_roots` in `hand/src/exec.rs`). A second
		/// copy of that table here would be a second answer to the same question,
		/// free to drift from the one that is enforced.
		let hostHome = '';
		/// Waiting for the hand to say what it can enforce, before the user is
		/// asked. Null once that is settled, one way or another.
		let capsWait = null;

		const self = { stop, page, origin, busy: () => runs.size > 0 };

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
			// Whoever is waiting on the hand's capabilities is waiting on a hand
			// that has gone. Let them get on with it rather than sit out the
			// timeout.
			if (capsWait) { const settle = capsWait; capsWait = null; settle({ gone: true }); }
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

			if (m.t === 'hello') {
				// What the hand can enforce, and the folder it says the grant
				// covers. Both are read on every hello, not only the first, so a
				// hand that reconnects to a different folder is believed about
				// the folder it is in now. `wire.rs` has no field for the
				// folder, so it arrives as a `root:<path>` capability; a later
				// wire that grows a field of its own is read too, and wins.
				for (const c of (Array.isArray(m.caps) ? m.caps : [])) {
					if (typeof c === 'string' && c.indexOf('root:') === 0) hostRoot = c.slice(5);
					if (typeof c === 'string' && c.indexOf('home:') === 0) hostHome = c.slice(5);
				}
				if (typeof m.root === 'string' && m.root) hostRoot = m.root;
				if (capsWait) {
					const settle = capsWait;
					capsWait = null;
					settle({ caps: Array.isArray(m.caps) ? m.caps : [] });
					// The hello that answered OUR question is ours. Forwarding it
					// would hand the page an answer to a greeting it never sent.
					return;
				}
			}

			if (m.t === 'started' || m.t === 'opened') {
				runs.set(m.id, { out: null, err: null });
				breathe();
			} else if (m.t === 'chunk' || m.t === 'output') {
				checkSeq(m);
			} else if (m.t === 'ended' || m.t === 'refused' || m.t === 'closed') {
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
			// A terminal has one stream by construction and sends no `stream` field, so
			// it is watched on the `out` line. Reading `m.stream` as absent-means-out
			// happens to be right for both, but it is written down because it is a
			// coincidence rather than a shared meaning.
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
				fail(null, 'Every message to the machine hand needs a "t" saying which it is: hello, exec, open, input, resize, signal or bye.');
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
			case 'open': {
				const bad = wrongOpen(m);
				if (bad) {
					say({ t: 'refused', id: String(m.id || ''), reason: bad });
					return;
				}
				// Registered like an exec, and for the same reason: a session the
				// host dies before acknowledging is still one the page is owed an
				// answer about.
				if (!runs.has(m.id)) runs.set(m.id, { out: null, err: null });
				breathe();
				break;
			}
			case 'input':
				if (!m.id || typeof m.id !== 'string') {
					fail(null, 'Input needs the id of the terminal it is for.');
					return;
				}
				if (typeof m.data !== 'string' || !BASE64.test(m.data)) {
					fail(m.id, 'Terminal input must be base64 of the bytes typed. A terminal carries bytes, not text: '
						+ 'an arrow key and a Ctrl-C are not characters.');
					return;
				}
				// Deliberately NOT logged, counted or held anywhere on the way past.
				// This is the message a password is typed into.
				break;
			case 'resize':
				if (!m.id || typeof m.id !== 'string') {
					fail(null, 'A resize needs the id of the terminal it is for.');
					return;
				}
				if (!m.size || !Number.isInteger(m.size.cols) || !Number.isInteger(m.size.rows)
					|| m.size.cols < 1 || m.size.rows < 1 || m.size.cols > 2000 || m.size.rows > 2000) {
					fail(m.id, 'A resize needs size.cols and size.rows as whole numbers of cells, each between 1 and 2000.');
					return;
				}
				break;
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
				fail(m.id, `The machine hand does not know the message "${m.t}". It understands hello, exec, open, input, resize, signal and bye.`);
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
		/// This is not the fence and it does not pretend to be: the hand enforces
		/// what a command may touch, and only the hand knows what it granted. But
		/// until 2026-08-02 this function checked `id`, `argv` and `cwd` and
		/// forwarded `env`, `fence`, `timeout_ms` and `capture` verbatim -- and
		/// forwarded an exec with no `fence` key at all. A page therefore chose
		/// its own compartment, which makes the compartment decoration. A
		/// reviewer sent `fence:{rw:["/"],net:true}` with its own `LD_PRELOAD`
		/// and the hand received it byte for byte.
		///
		/// So this is the SECOND line, and it refuses the four things the relay
		/// can be sure about from where it stands: a missing fence, a fence
		/// naming the machine rather than a folder, an environment that decides
		/// what code a program loads, and an id or a timeout with no bound on it.
		/// Everything else is the hand's to clamp.
		function wrongExec(m) {
			if (!m.id || typeof m.id !== 'string') {
				return 'Every exec needs an id, which every answer about it is tagged with.';
			}
			if (m.id.length > ID_MAX) {
				return `That id is ${m.id.length} characters, over the ${ID_MAX} the hand carries. It is echoed on every `
					+ `message about the run, so a long one makes answers the hand cannot send. Use a short handle.`;
			}
			// eslint-disable-next-line no-control-regex
			if (/[\u0000-\u001f\u007f]/.test(m.id)) {
				return 'That id has a control character in it. An id is a handle, not data: use letters, digits and punctuation.';
			}
			if (!Array.isArray(m.argv) || !m.argv.length || !m.argv.every((a) => typeof a === 'string')) {
				return 'exec needs argv: the program and its arguments, as an array of strings. It is never a shell string -- there is no shell to interpret one.';
			}
			// eslint-disable-next-line no-control-regex
			if (m.argv.some((a) => a.indexOf('\u0000') >= 0)) {
				return 'An argument contains a NUL byte, which no program can be given. Whatever built that argument is broken.';
			}
			if (typeof m.cwd !== 'string' || !m.cwd) {
				return 'exec needs cwd, an absolute working directory inside the fence.';
			}
			if (!absolute(m.cwd) || segments(m.cwd).indexOf('..') >= 0) {
				return `The working directory "${m.cwd}" is not an absolute path without ".." in it. The hand does not guess `
					+ `what a relative path is relative to, and a ".." is a way out of whatever it is written under.`;
			}
			if (typeof m.timeout_ms !== 'number' || !Number.isInteger(m.timeout_ms)
				|| m.timeout_ms <= 0 || m.timeout_ms > TIMEOUT_MAX) {
				return `exec needs timeout_ms: a whole number of milliseconds between 1 and ${TIMEOUT_MAX}. A command with no `
					+ `wall-clock limit is one nothing ever takes back.`;
			}
			if (m.capture !== undefined && ['both', 'out', 'err', 'none'].indexOf(m.capture) < 0) {
				return 'capture must be "both", "out", "err" or "none".';
			}
			if (m.stdin !== undefined && m.stdin !== null && typeof m.stdin !== 'string') {
				return 'stdin must be text, or null for a command that reads none.';
			}

			const env = wrongEnv(m.env);
			if (env) return env;

			return wrongFence(m.fence, m.cwd, m.toolkits);
		}

		/// Base64, strictly: the alphabet, correct padding, whole quanta. The hand
		/// rejects anything else outright, so catching it here turns a dropped
		/// connection into a sentence.
		const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

		/// What is wrong with a request to open a terminal.
		///
		/// The same vetting an exec gets, because it is the same act -- a real
		/// program, on the user's machine, inside a fence this extension did not
		/// choose. Two differences only: there is no timeout, because a terminal
		/// lives until it is closed, and there is a size, because the kernel has to
		/// tell the program how big its screen is.
		function wrongOpen(m) {
			if (!m.id || typeof m.id !== 'string') {
				return 'Every terminal needs an id, which every answer about it is tagged with.';
			}
			if (m.id.length > ID_MAX) {
				return `That id is ${m.id.length} characters, over the ${ID_MAX} the hand carries.`;
			}
			// eslint-disable-next-line no-control-regex
			if (/[\u0000-\u001f\u007f]/.test(m.id)) {
				return 'That id has a control character in it. An id is a handle, not data.';
			}
			if (!Array.isArray(m.argv) || !m.argv.length || !m.argv.every((a) => typeof a === 'string')) {
				return 'open needs argv: the program and its arguments, as an array of strings. A shell is a perfectly '
					+ 'ordinary thing to put in argv[0] here -- what it is never is a single string to be interpreted.';
			}
			// eslint-disable-next-line no-control-regex
			if (m.argv.some((a) => a.indexOf('\u0000') >= 0)) {
				return 'An argument contains a NUL byte, which no program can be given.';
			}
			if (typeof m.cwd !== 'string' || !m.cwd) {
				return 'open needs cwd, an absolute working directory inside the fence.';
			}
			if (!absolute(m.cwd) || segments(m.cwd).indexOf('..') >= 0) {
				return `The working directory "${m.cwd}" is not an absolute path without ".." in it.`;
			}
			if (!m.size || !Number.isInteger(m.size.cols) || !Number.isInteger(m.size.rows)
				|| m.size.cols < 1 || m.size.rows < 1 || m.size.cols > 2000 || m.size.rows > 2000) {
				return 'open needs size.cols and size.rows as whole numbers of cells, each between 1 and 2000. '
					+ 'A program asks the kernel how big its screen is, and a wrong answer draws a wrong screen.';
			}

			const env = wrongEnv(m.env);
			if (env) return env;

			return wrongFence(m.fence, m.cwd, m.toolkits);
		}

		/// What is wrong with an exec's environment.
		///
		/// The hand is adding its own screen for this and that one is the durable
		/// answer; this is the one that can be made today, on the near side of
		/// the boundary, where the page composing the request sits.
		function wrongEnv(env) {
			if (env === undefined || env === null) return null;
			if (!Array.isArray(env)) {
				return 'env must be a list of [name, value] pairs. The command\'s environment is given explicitly -- it never inherits the browser\'s.';
			}
			for (const pair of env) {
				if (!Array.isArray(pair) || pair.length !== 2
					|| typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
					return 'Every env entry is a [name, value] pair of two strings.';
				}
				if (!ENV_NAME.test(pair[0])) {
					return `"${pair[0]}" is not a usable environment variable name. Names are letters, digits and underscores, and do not start with a digit.`;
				}
				if (ENV_FORBIDDEN.test(pair[0])) {
					return `The environment variable "${pair[0]}" decides what code a program loads before its own first line runs, so it `
						+ `is not one a command may be given here. Whatever it was for, do it in the command itself.`;
				}
			}
			return null;
		}

		/// What is wrong with an exec's fence.
		///
		/// # Arguments
		/// * `f` - The `fence` the page sent, if it sent one.
		/// * `cwd` - The working directory, which has to be inside it.
		function wrongFence(f, cwd, kits) {
			if (!f || typeof f !== 'object' || Array.isArray(f)) {
				return 'exec needs a fence saying what the command may touch: {rw, ro, deny, net}. A command with no fence is a command '
					+ 'with no compartment, and this hand does not run one.';
			}
			if (typeof f.net !== 'boolean') {
				return 'The fence needs net: true or false, saying whether the command may reach the network at all.';
			}
			// Absent means no toolchain was granted, which is the ordinary case and the safe one.
			// Present and not a list of names is a caller saying something this end cannot read.
			if (kits !== undefined && kits !== null
				&& (!Array.isArray(kits) || !kits.every((k) => typeof k === 'string'))) {
				return 'toolkits must be a list of toolchain names the user granted, such as ["rust"], or left out '
					+ 'where none was. It is never derived from the program being run.';
			}
			for (const field of ['rw', 'ro', 'deny']) {
				const list = f[field];
				if (!Array.isArray(list) || !list.every((p) => typeof p === 'string')) {
					return `The fence's ${field} must be a list of absolute paths, even where it is empty.`;
				}
				for (const p of list) {
					const bad = wrongRoot(p, field, kits);
					if (bad) return bad;
				}
			}
			const roots = f.rw.concat(f.ro);
			if (!roots.length) {
				return 'That fence names no root at all, so the command could not read the directory it would run in. Say what it may work under.';
			}
			if (!roots.some((r) => under(cwd, r))) {
				return `The working directory "${cwd}" is outside the fence, which reaches ${roots.map((r) => `"${r}"`).join(', ')} `
					+ `and nowhere else. Run it somewhere inside the fence, or say what you would need and let the user widen it.`;
			}
			return null;
		}

		/// What is wrong with one fence root.
		///
		/// # Arguments
		/// * `p` - The path as the page spelled it.
		/// * `field` - Which list it came from, for the sentence.
		/// * `kits` - The toolkit names the same request carried, which is what
		///   lets a root outside the grant be a toolchain rather than a mistake.
		function wrongRoot(p, field, kits) {
			if (!p) {
				return `The fence's ${field} has an empty path in it. An empty root is not "nothing", it is a prefix of every path on `
					+ `the machine, so it is refused rather than interpreted.`;
			}
			if (!absolute(p)) {
				return `The fence root "${p}" is not an absolute path. A fence written against a relative path fences whatever the `
					+ `hand happens to be standing in.`;
			}
			if (segments(p).indexOf('..') >= 0) {
				return `The fence root "${p}" contains "..", which is a way out of the folder it is written under. Name the folder itself.`;
			}
			const norm = p.replace(/\/+$/, '') || '/';
			if (field !== 'deny' && ROOT_FORBIDDEN.has(norm)) {
				return `The fence root "${p}" is the machine, or a folder the machine follows from, not a workspace. A command is run `
					+ `inside the folders the user granted; if that is genuinely what is needed, it is a conversation to have with them.`;
			}
			// The hand knows what it granted and clamps to it; where it has said
			// so, this end holds the page to it as well.
			//
			// With one opening, and it is the toolchain: see `hostHome`. A root
			// outside the grant passes here only when the request names a toolkit
			// AND the root is inside the home directory the hand reported -- and
			// the home directory ITSELF does not pass, because `~` is not a
			// toolchain, it is everything the user owns.
			if (field !== 'deny' && hostRoot && !under(p, hostRoot)) {
				const granted = Array.isArray(kits) && kits.length > 0;
				const inHome = hostHome && under(p, hostHome) && !under(hostHome, p);
				if (!granted || !inHome) {
					return `The fence root "${p}" is outside "${hostRoot}", which is the folder this machine's hand was granted`
						+ (granted
							? `, and is not inside the home directory a granted toolchain would sit in. `
							: ` and this request granted no toolchain. `)
						+ `A command cannot be fenced to somewhere the grant does not reach.`;
				}
			}
			return null;
		}

		// -- Wiring --------------------------------------------------------

		/// Opens the host, having established that it may be opened at all.
		///
		/// The host is opened BEFORE the question is put, and only where the
		/// question has to be put at all. That is the one way the grant window
		/// can say what this machine actually enforces rather than what the
		/// product hopes it does: `caps` arrives in the hand's `hello`, and a
		/// window worded before the hello is a window guessing. Nothing is RUN by
		/// opening it -- the exchange is a greeting -- and a machine with no hand
		/// installed is answered with the install sentence instead of being asked
		/// a question about a capability it does not have.
		async function begin() {
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

			// Asked on every connection, granted or not. The answer carries the
			// folder the hand says its grant covers, and a fence is checked
			// against that -- so a relay that skipped the greeting when it had
			// nothing to ask the user would be the one relay with nothing to
			// check the fence against. The page's own messages wait in the
			// outbox meanwhile, exactly as they wait for the grant window.
			const said = await capabilities();
			if (said.gone) return;	// The host went; hostGone has said why.

			if (!(await granted(origin))) {
				const allowed = await askFor(origin, said.caps);
				if (allowed !== true) {
					// Declined and dismissed are different answers, and the
					// daimon must be able to tell them apart: one means stop
					// asking.
					stop(allowed === DECLINED ? DECLINED_SENTENCE : DISMISSED_SENTENCE);
					return;
				}
			}

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

		/// Asks the hand what it can enforce, and waits a moment for the answer.
		///
		/// # Returns
		/// `{caps}` where it answered, `{caps:null}` where it did not, and
		/// `{gone:true}` where the host went away while we asked.
		function capabilities() {
			return new Promise((resolve) => {
				let settled = false;
				const once = (v) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					capsWait = null;
					resolve(v);
				};
				const timer = setTimeout(() => once({ caps: null }), CAPS_MS);
				capsWait = once;
				try {
					host.postMessage({ t: 'hello', proto: PROTO, client: 'daimond-hands' });
				} catch (e) {
					once({ gone: true });
				}
			});
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
	/// says what has been granted TO THIS ORIGIN and what is connected, and the
	/// page learns the rest from `hello` or from the sentence that comes back
	/// instead.
	///
	/// # Arguments
	/// * `sender` - The `MessageSender` the broker was given, so the answer is
	///   about the page that asked and not about the browser.
	async function status(sender) {
		const origin = allowedOrigin(sender);
		return {
			ok:		true,
			proto:		PROTO,
			host:		HOST_NAME,
			port:		PORT_NAME,
			origin:		origin,
			granted:	origin ? await granted(origin) : false,
			connected:	relays.size,
		};
	}

	/// Asks for the grant from a page that would rather ask first than have a
	/// window appear the moment it connects.
	///
	/// Asked this way there is no host port open, so there are no capabilities to
	/// word the window from and it says so. A page that simply connects gets the
	/// better question, because by then the hand has spoken.
	///
	/// # Arguments
	/// * `sender` - The `MessageSender` the broker was given.
	async function request(sender) {
		const origin = allowedOrigin(sender);
		if (!origin) return { ok: false, granted: false, error: NOT_OURS };
		const allowed = await askFor(origin, null);
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
		const origin = allowedOrigin(port.sender || {});
		if (!origin) {
			try { port.disconnect(); } catch (e) { /* already gone */ }
			return;
		}
		relay(port, origin);
	});

	globalThis.DaimondHand = {
		wire,
		status,
		request,
		revoke,
		granted,
		patterns,
		ours,
		originOfPattern,
		allowedOrigin,
		mayConnect,
		PATTERN,
		PATTERN_SEP,
		HOST_NAME,
		PORT_NAME,
	};

})();
