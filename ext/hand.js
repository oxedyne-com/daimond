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
// ONE QUALIFICATION, AND IT IS THE RELOAD. A page that goes away does not take
// its host with it AT ONCE: the pair is parked for thirty seconds and the same
// tab, reloaded, adopts it. What arrives meanwhile is held and handed over on
// re-attach; what the grace runs out on is stopped, named, and reported to the
// next page from that tab. See "The reload grace" below.
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
	const PROTO = 2;

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

	// -- The reload grace -------------------------------------------------
	//
	// A page that goes away used to take the machine hand with it, on the spot.
	// That is right for a tab closed for good and wrong for the commonest way a
	// page goes away, which is a RELOAD: F5, a crash, `dev/serve.mjs` restarting,
	// or the app's own 426 heal.  A daimon that started a dev server and a build
	// lost both to a keypress, and the listing afterwards was honestly empty --
	// which is the worst of both, because nothing anywhere said a thing had been
	// stopped.
	//
	// The owner chose this shape on 2026-08-25, over "keep them until stopped"
	// and over "keep killing them, but say so": HOLD FOR ABOUT THIRTY SECONDS
	// AND RE-ATTACH.  So a relay whose page has gone is PARKED rather than
	// stopped -- the host stays connected, its runs keep running -- and the next
	// page from the same tab adopts it.
	//
	// THE TAB IS THE KEY, NOT THE ORIGIN.  A reload keeps `sender.tab.id`; a
	// second tab of the same origin does not.  Parking by origin alone would
	// hand a new tab the runs of a tab that had just been closed, which is
	// somebody else's compartment.  Where Chrome names no tab -- which it does
	// not for a page connection, but the field is not ours to guarantee -- the
	// relay is stopped as it always was, because a hold that cannot be aimed is
	// a hold that reaches the wrong page.
	//
	// A PAGE THAT SAYS `bye` IS TAKEN AT ITS WORD and stopped on the spot. The
	// grace is for a page that VANISHED, which cannot be told from a crash; a
	// goodbye is a page saying it is finished with this host, and a hold that
	// ignored it would make the wire's own word mean nothing.
	//
	// WHAT ARRIVES WHILE THE PAGE IS AWAY IS HELD, NOT DROPPED.  A daimon that
	// re-attaches and silently misses thirty seconds of a build's output is
	// being lied to, which is worse than a process that was honestly killed.  So
	// every page-bound message is buffered while parked, and the buffer is
	// BOUNDED -- a `cargo build` outruns any buffer worth keeping in a service
	// worker.  When the bound bites the oldest go, and how many went is said on
	// re-attach beside the rest.  This file already refuses to hide a sequence
	// gap for the same reason (`checkSeq`): output the reader believes is
	// complete is the fault, not output that is short.
	const HOLD_MS = 30000;

	/// The most a parked relay holds for a page that may be coming back, in
	/// bytes of JSON and in messages. Two bounds because one message can be a
	/// megabyte and a thousand can be a byte each.
	const HELD_BYTES = 512 * 1024;
	const HELD_MSGS  = 4000;

	/// How long the hand is given to name what it is about to lose, when the
	/// grace runs out. One message each way over a pipe, and a listing that does
	/// not arrive leaves the count unknown rather than the report unwritten.
	const RITES_MS = 2000;

	/// Relays whose page has gone and whose thirty seconds have not run out, by
	/// tab id. At most one per tab: a second park for the same tab can only mean
	/// the first was never adopted, and it is stopped rather than forgotten.
	const parked = new Map();

	/// What lapsed, by tab id, so the page that comes back LATE is told rather
	/// than meeting an empty listing. Read once and cleared -- it is news about
	/// one gap, not a standing condition.
	const lapses = new Map();

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
		+ `To install it: from the Daimond repository, `
		+ `run "cargo build --release --manifest-path hand/Cargo.toml" and then `
		+ `"hand/install/install.sh --workspace <the folder Daimond may work in>" -- naming the folder `
		+ `in that same command is what saves a second pass, because the hand refuses to serve a page `
		+ `until it has been told which folder it may touch, and it never guesses. `
		+ `Then restart the browser, which reads the registration only at startup. `
		+ `"hand/install/install.sh --check" says what is still wrong, one line each. `
		+ `hand/install/README.md is the whole procedure. `
		+ `Until it is installed, Daimond works in the browser and cannot touch this computer.`;

	// The sentence for a disconnect the hand said nothing about.
	//
	// Written for a PERSON, because a person is who reads it: the Terminal panel puts
	// this line on the screen where the terminal would have been. It used to offer two
	// causes -- a crash, or a message over the browser's 1 MB frame limit -- which
	// nobody at the keyboard can tell apart, and then instructed a daimon to "tell the
	// user to check the hand's journal", to a reader who WAS the user.
	//
	// One line, and the one thing worth doing. The second clause names what has been
	// the real cause on this machine every time it has been chased: one hand per page
	// port, one record, and a second Daimond window takes the record's lock first.
	const GONE_UNSAID =
		`Daimond's machine hand stopped without saying why, so nothing can run on this computer until it is back. `
		+ `Reload the page to start it again -- and if it stops a second time, close any other browser window that has Daimond open, `
		+ `because only one of them at a time can hold the hand.`;

	const FORBIDDEN =
		`Daimond's machine hand is installed but will not talk to this extension. `
		+ `Its host manifest for "${HOST_NAME}" does not list this extension in allowed_origins, `
		+ `which happens when the extension was loaded unpacked without the pinned key, or when the `
		+ `manifest was written for a different build. Re-running hand/install/install.sh repairs it.`;

	const DECLINED_SENTENCE =
		`Daimond was refused permission to run commands on this computer, so it will not ask again. `
		+ `To change that, reload the page and allow it when the Daimond Hands window asks; `
		+ `until then the work has to happen in the browser or in the workspace files.`;

	const DISMISSED_SENTENCE =
		`The approval window for running commands on this computer was closed before it was answered, `
		+ `so nothing may be run. The user may not have seen it -- the Daimond Hands icon carries the `
		+ `question until it is answered. Answer it and try again, or do the work another way.`;

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
	/// * `tabId` - The tab it came from, which a reload keeps and a new tab does
	///   not, or 0 where Chrome named none.
	function relay(page, origin, tabId) {
		/// The port to the page, swapped for a new one when a reloaded page
		/// adopts this relay, and null while nothing is attached.
		let wire = page;
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
		/// The sentence the hand sent on its way out, where it sent one.
		///
		/// A hand that will not start -- no granted root, a record it cannot open,
		/// a second hand already holding one -- knows exactly why, and used to
		/// write it to a standard error the browser discards. It now sends it as a
		/// `fault` frame before it exits, so `hostGone` has the hand's own answer
		/// instead of a guess between two causes it cannot tell apart.
		let lastFault = '';
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
		/// The folders this machine will let a TERMINAL be fenced to, from `terminal-ceiling:`
		/// in the hand's own `hello`.
		///
		/// A terminal is the user at a keyboard and a command is a daimon, so the two are
		/// allowed different sizes -- and the list comes from the MACHINE, never from the page,
		/// which is what keeps this a clamp rather than a formality. Empty on an older hand,
		/// and then a terminal is held to the granted root exactly as it always was.
		let hostCeilings = [];
		/// Waiting for the hand to say what it can enforce, before the user is
		/// asked. Null once that is settled, one way or another.
		let capsWait = null;
		/// Waiting for the hand to name what the grace is about to take with it.
		/// Null except during those two seconds.
		let ritesWait = null;
		/// The timer counting out the grace, or null while a page is attached.
		let holding = null;
		/// The grace has run out and the last rites are being read. The relay is
		/// still in `parked` through those two seconds, so a page arriving in
		/// them adopts it and the lapse is abandoned rather than stopping a hand
		/// the page has just taken back.
		let dying = false;
		/// When the page went, so a re-attach can say how long it was away.
		let wentAt = 0;
		/// What arrived while nothing was attached, oldest first, and what had
		/// to be let go to keep it bounded.
		let held = [];
		let heldBytes = 0;
		let dropped = 0;
		let droppedBytes = 0;

		const self = {
			stop,
			adopt,
			lapsed,
			origin,
			tabId,
			// A parked relay is BUSY. Not because anything is necessarily
			// running -- it may be holding nothing but a buffer -- but because
			// an MV3 worker evicted mid-grace takes the native port with it, and
			// the grace would then be thirty seconds that sometimes happen.
			busy: () => runs.size > 0 || holding !== null || dying,
		};

		/// Says something to the page, if it is still there.
		///
		/// One postMessage per message, always. Coalescing two chunks would
		/// destroy the attribution the seq exists to provide, and buffering to
		/// "smooth" the stream would turn live output into a report.
		function say(m) {
			if (!wire) { hold(m); return; }
			try {
				wire.postMessage(m);
			} catch (e) {
				// The page has gone. Its own disconnect handler is about to run
				// and will park or stop this relay.
			}
		}

		/// Keeps one page-bound message for a page that may be coming back.
		///
		/// The bound is on the BUFFER and the loss is COUNTED, so a re-attach
		/// that is short of output says how short. Dropping the oldest rather
		/// than refusing the newest is deliberate: the end of a build is what a
		/// reader wants, and the beginning is what they already saw.
		function hold(m) {
			let size = 0;
			try { size = JSON.stringify(m).length; } catch (e) { size = 0; }
			held.push({ m, size });
			heldBytes += size;
			while (held.length > HELD_MSGS || heldBytes > HELD_BYTES) {
				const gone = held.shift();
				if (!gone) break;
				heldBytes -= gone.size;
				dropped++;
				droppedBytes += gone.size;
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
			// Stopped while parked -- revoked, or the hand died in the grace --
			// so the page that comes back must be told rather than meeting an
			// empty listing with nothing to explain it. `lapse` has already
			// written its own record; this covers every other way out.
			if (holding !== null || dying) {
				clearTimeout(holding);
				holding = null;
				dying   = false;
				parked.delete(tabId);
				if (!lapses.has(tabId)) {
					lapses.set(tabId, {
						at:      Date.now(),
						away:    Math.max(0, Date.now() - wentAt),
						ids:     [...runs.keys()],
						unknown: true,
						why:     why || '',
						dropped,
						droppedBytes,
					});
				}
			}
			if (ritesWait) { const settle = ritesWait; ritesWait = null; settle({ ids: [], unknown: true }); }
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
			if (wire) { try { wire.disconnect(); } catch (e) { /* already gone */ } }
			wire = null;
			held = [];
			heldBytes = 0;
		}

		// -- The grace ------------------------------------------------------

		/// The page went. Hold what it left running, for the length of the grace.
		///
		/// Stopping outright is kept for the two cases a hold cannot serve: no
		/// host, so there is nothing to hold; and no tab id, so a hold could not
		/// be aimed at the page that comes back and would be offered to whichever
		/// page connected next.
		function park() {
			// A PAGE THAT SAID GOODBYE IS NOT A PAGE THAT VANISHED. The grace is
			// for the second, which cannot be told from a crash or a tab closing
			// for good; `bye` is the wire's word for "I am finished with this
			// host", and honouring it at once is what makes the two different
			// things. `fromPage` sets `closing` on one and nothing else does.
			//
			// It is also a LEAK if it is not honoured: a relay whose page said
			// bye and then disconnected would sit in `relays` with a live host
			// on the end of it and no timer to end it.
			if (closing) { stop(''); return; }
			if (!host || !tabId) { stop(''); return; }
			const was = parked.get(tabId);
			if (was && was !== self) was.stop('');
			wire   = null;
			wentAt = Date.now();
			parked.set(tabId, self);
			holding = setTimeout(() => { lapse(); }, HOLD_MS);
			breathe();
		}

		/// The grace ran out and nothing came back.
		async function lapse() {
			holding = null;
			dying   = true;
			const what = await lastRites();
			// Adopted while the hand was being asked. The page has it back, so
			// there is nothing to report and nothing to stop.
			if (!dying) return;
			dying = false;
			parked.delete(tabId);
			lapses.set(tabId, {
				at:      Date.now(),
				away:    HOLD_MS,
				ids:     what.ids,
				unknown: what.unknown,
				why:     '',
				dropped,
				droppedBytes,
			});
			stop('');
		}

		/// Asks the hand what the stop is about to take with it.
		///
		/// The relay's own `runs` map holds what is IN FLIGHT and not what is
		/// STANDING -- a `sleep 300 &` left by a command that already ended has
		/// no entry here and is the commonest thing a reload loses. So the hand
		/// is asked, because the hand is the one that knows.
		function lastRites() {
			return new Promise((resolve) => {
				if (!host) { resolve({ ids: [...runs.keys()], unknown: true }); return; }
				let settled = false;
				const once = (v) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					ritesWait = null;
					resolve(v);
				};
				const timer = setTimeout(() => once({ ids: [...runs.keys()], unknown: true }), RITES_MS);
				ritesWait = once;
				try { host.postMessage({ t: 'runs' }); }
				catch (e) { once({ ids: [...runs.keys()], unknown: true }); }
			});
		}

		/// A reloaded page takes this relay, and everything held for it, over.
		///
		/// # Arguments
		/// * `port` - The port the returning page opened.
		function adopt(port) {
			if (holding !== null) { clearTimeout(holding); holding = null; }
			dying = false;
			parked.delete(tabId);
			wire = port;
			port.onMessage.addListener(fromPage);
			port.onDisconnect.addListener(pageGone);
			const away  = Math.max(0, Date.now() - wentAt);
			const batch = held;
			const lost  = dropped;
			const bytes = droppedBytes;
			wentAt       = 0;
			held         = [];
			heldBytes    = 0;
			dropped      = 0;
			droppedBytes = 0;
			// Said BEFORE the replay, so a reader meets the warning about a hole
			// ahead of the output that has one -- the same order `checkSeq` puts
			// a gap in.
			say({
				t:        'resumed',
				away_ms:  away,
				held:     batch.length,
				dropped:  lost,
				dropped_bytes: bytes,
				ids:      [...runs.keys()],
			});
			for (const h of batch) say(h.m);
			breathe();
		}

		/// Tells a fresh page what the grace took, when it came back too late.
		///
		/// # Arguments
		/// * `gap` - The record `lapse` or `stop` left behind for this tab.
		function lapsed(gap) {
			say({
				t:       'lapsed',
				away_ms: gap.away,
				hold_ms: HOLD_MS,
				ids:     Array.isArray(gap.ids) ? gap.ids : [],
				unknown: !!gap.unknown,
				why:     gap.why || '',
				dropped: gap.dropped || 0,
			});
		}

		/// The host sent something. Forward it, in order, having first checked
		/// the one property the page cannot check for itself.
		function fromHost(m) {
			if (!m || typeof m !== 'object' || typeof m.t !== 'string') {
				fail(null, 'The machine hand sent something that is not a wire message, so it cannot be used. Reinstall it with hand/install/install.sh and reload the page.');
				return;
			}

			try {
				const size = JSON.stringify(m).length;
				if (size > biggest) biggest = size;
			} catch (e) { /* unmeasurable; the forward still happens */ }

			if (m.t === 'fault') {
				// The hand's own last word, and the only message that arrives before
				// the greeting. It is a whole sentence written for a PERSON, so it is
				// passed on unchanged rather than wrapped in this file's vocabulary.
				lastFault = typeof m.reason === 'string' ? m.reason : '';
				stop(lastFault || GONE_UNSAID);
				return;
			}

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
					if (typeof c === 'string' && c.indexOf('terminal-ceiling:') === 0) {
						const cp = c.slice('terminal-ceiling:'.length);
						if (cp && hostCeilings.indexOf(cp) < 0) hostCeilings.push(cp);
					}
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

			if (m.t === 'runs' && ritesWait) {
				// Ours, not the page's: nobody out there asked for it, and a page
				// that met it would settle a waiter it never armed.
				const settle = ritesWait;
				ritesWait = null;
				const rows = Array.isArray(m.runs) ? m.runs : [];
				settle({
					ids: rows.map((r) => (r && r.id)).filter((x) => typeof x === 'string' && x),
					unknown: false,
				});
				return;
			}

			// A HANDSHAKE REFUSAL IS THE HAND'S LAST WORD, and it is followed by an
			// exit. Held here so `hostGone` says what the hand said rather than
			// composing a guess over the top of it: on 2026-08-26 the one sentence
			// that ended the hunt was produced, delivered, and then overwritten by
			// `GONE_UNSAID` before anyone could read it.
			if (m.t === 'refused' && m.id === 'hello' && typeof m.reason === 'string') {
				lastFault = m.reason;
			}

			// A GRANT CHANGES THE FOLDER THE NEXT HAND WILL WORK IN, and a hand reads its
			// root once at startup -- so the change is invisible until one actually starts.
			// A page reload does not do it: the relay parks its host for the grace and the
			// returning page adopts the SAME process, so the folder went on being the old one
			// and the settings row went on showing it. That read exactly like a grant that had
			// not worked, which is what the owner reported on 2026-08-27 with `root.txt`
			// already correct on disk.
			//
			// So the host is let go here, after the answer has been forwarded. The next thing
			// the page asks for launches a hand that reads the file.
			if (m.t === 'granted') {
				say(m);
				// `hostGone` fires on the disconnect below, and without a sentence of its own it
				// would tell the page the hand stopped without saying why -- which is the one
				// thing that did not happen. `lastFault` is the seam that already exists for
				// "the hand's own last word", and this is one.
				lastFault = 'The folder was changed, so the machine hand was let go. It starts '
					+ 'again with the new folder the next time anything needs it.';
				try { host.disconnect(); } catch (e) { /* already gone */ }
				hostGone();
				return;
			}

			if (m.t === 'started' || m.t === 'opened') {
				runs.set(m.id, { out: null, err: null });
				breathe();
			} else if (m.t === 'chunk' || m.t === 'output') {
				checkSeq(m);
			} else if (m.t === 'ended' || m.t === 'refused' || m.t === 'closed' || m.t === 'filed') {
				// A `filed` is the whole of a file operation's answer: there is no `started`
				// before it and no `ended` after it, so it is what closes the registry entry
				// `fromPage` opened. Left out, the entry would be permanent -- and the
				// abandonment path below would owe the page an `ended` for something that
				// never started.
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

			// The hand's own last word, where it managed to send one. Always better
			// than anything composable here: it knows which reason it was, and this
			// end can only guess between reasons Chrome reports identically.
			if (lastFault) {
				stop(lastFault);
				return;
			}

			// Nothing said. A crash and a message over the browser's frame limit
			// arrive as the same disconnect, so the two are not handed over as a
			// choice the reader cannot make: what is said is the thing to do, and the
			// measurement only where it actually points at the limit.
			const n	= runs.size;
			const big = biggest > FROM_HOST_MAX / 2;
			stop(GONE_UNSAID
				+ (big ? ` The largest message it sent was ${biggest} bytes, near the ${FROM_HOST_MAX} byte limit a browser drops a connection over, so a narrower command may get through.` : '')
				+ (n ? ` ${n} command(s) were running; their results are lost.` : ''));
		}

		/// The page sent something. Check what a malformed frame would cost,
		/// then forward it unchanged.
		function fromPage(m) {
			if (closing) {
				fail(m && m.id, 'This connection to the machine hand is closing, so nothing more can be sent on it. Open a new one.');
				return;
			}
			if (!m || typeof m !== 'object' || typeof m.t !== 'string') {
				fail(null, 'Every message to the machine hand needs a "t" saying which it is: hello, exec, open, file, verify, input, resize, signal, runs or bye.');
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
			case 'file': {
				const bad = wrongFile(m);
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
						reason: `That file request is ${size} bytes to send, over the ${TO_HOST_MAX} byte limit for a message to the machine hand. `
							+ `Chrome would drop the connection rather than deliver it, killing everything else running. `
							+ `Change the file in smaller pieces: file_edit sends only the two strings, not the whole file.`,
					});
					return;
				}
				// Registered like an exec, and for the same reason: an operation the host dies
				// before acknowledging is still one the page is owed an answer about -- and it
				// is the one whose answer matters most, because "did the write land" cannot be
				// inferred from silence.
				if (!runs.has(m.id)) runs.set(m.id, { out: null, err: null });
				breathe();
				break;
			}
			case 'verify': {
				const bad = wrongVerify(m);
				if (bad) {
					say({ t: 'refused', id: String(m.id || ''), reason: bad });
					return;
				}
				// Registered like an exec, and for the same reason: a sequence the host dies
				// before acknowledging is still one the page is owed an answer about.
				if (!runs.has(m.id)) runs.set(m.id, { out: null, err: null });
				breathe();
				break;
			}
			case 'signal':
				if (!m.id || typeof m.id !== 'string') {
					fail(null, 'A signal needs the id of the run it is for.');
					return;
				}
				// The wire takes three and no more, and a word outside them is
				// refused HERE rather than at the host: the host answers an
				// unreadable frame with a decode error naming the field, which
				// reads as the hand being broken rather than as the word being
				// wrong. There is deliberately no default: a signal nobody named
				// is not a `term` somebody would have chosen.
				if (m.sig !== 'term' && m.sig !== 'kill' && m.sig !== 'int') {
					fail(m.id, `A signal must name "term" (ask it to stop), "kill" (insist) or "int" (interrupt, as Ctrl-C would); this one named ${JSON.stringify(m.sig)}.`);
					return;
				}
				break;
			// Takes nothing, so there is nothing to check. It was reaching the
			// default below -- which refuses -- so a page could be TOLD by the
			// hand that a command had left a server standing and had no way to
			// ask what was standing or to stop it. The hand grew `runs` on
			// 2026-08-23 and this end went on denying it.
			case 'runs':
				break;
			// A folder browser: directory NAMES, so a person can choose a folder and get its
			// real path. Nothing is run and nothing is read, and the hand bounds it to what it
			// would fence a terminal to -- so this end checks the shape and forwards.
			// Recording the folder the user chose after walking the machine's own. The page
			// proposes; the HAND refuses `/`, a non-directory, and any folder containing its
			// own record -- a fenced command able to reach the record could rewrite the record
			// of what it did.
			case 'grant':
				if (typeof m.path !== 'string' || !m.path) {
					fail(m.id, 'A grant needs the folder as an absolute path.');
					return;
				}
				break;
			case 'dirs':
				if (m.path !== undefined && typeof m.path !== 'string') {
					fail(m.id, 'A folder listing takes a path as a string, or nothing at all to ask where to start.');
					return;
				}
				break;
			case 'bye':
				closing = true;
				break;
			default:
				fail(m.id, `The machine hand does not know the message "${m.t}". It understands hello, exec, open, file, verify, input, resize, signal, runs, dirs, grant and bye.`);
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

		/// What is wrong with a request to change one file.
		///
		/// The same shape of check as `wrongExec`, and deliberately no more: there is no argv,
		/// no environment and no shell here, so the only things this end can be sure about are
		/// the id, the operation's name, the absoluteness of the paths and the fence. What may
		/// be READ or WRITTEN is not this end's question at all -- it is the kernel's, one
		/// process further on, from the same plan a command's fence is built from.
		function wrongFile(m) {
			if (!m.id || typeof m.id !== 'string') {
				return 'Every file request needs an id, which the answer about it is tagged with.';
			}
			if (m.id.length > ID_MAX) {
				return `That id is ${m.id.length} characters, over the ${ID_MAX} the hand carries. Use a short handle.`;
			}
			// eslint-disable-next-line no-control-regex
			if (/[\u0000-\u001f\u007f]/.test(m.id)) {
				return 'That id has a control character in it. An id is a handle, not data: use letters, digits and punctuation.';
			}
			// A CLOSED SET, checked here as well as at the host. A word outside it reaches the
			// host as a decode error naming a field, which reads as the hand being broken
			// rather than as the request being wrong.
			if (['read', 'write', 'edit', 'move', 'list', 'mkdir', 'search', 'glob'].indexOf(m.op) < 0) {
				return `A file request must name one of read, write, edit, move, list, mkdir, search or glob; this one named ${JSON.stringify(m.op)}.`;
			}
			// EVERY path, and a walk carries a list of them. Checking `path` alone would leave
			// the starts of a search unvetted, which is the half that decides where it looks.
			const paths = [m.path, m.to, m.base].concat(Array.isArray(m.paths) ? m.paths : []);
			for (const p of paths) {
				if (p === undefined || p === null) continue;
				if (typeof p !== 'string' || !p) {
					return 'A file request\'s paths must each be a path.';
				}
				if (!absolute(p) || segments(p).indexOf('..') >= 0) {
					return `The path "${p}" is not an absolute path without ".." in it. The hand does not guess `
						+ `what a relative path is relative to, and a ".." is a way out of whatever it is written under.`;
				}
			}
			if ((m.op === 'search' || m.op === 'glob')) {
				if (typeof m.query !== 'string' || !m.query) {
					return `A ${m.op} needs a pattern in "query".`;
				}
				if (!Array.isArray(m.paths) || !m.paths.length) {
					return `A ${m.op} needs "paths": where to start. A walk with nowhere to start would `
						+ 'look at nothing and answer as though it had looked everywhere.';
				}
				if (m.skip !== undefined && (!Array.isArray(m.skip) || !m.skip.every((d) => typeof d === 'string'))) {
					return 'A walk\'s "skip" is the directory NAMES to pass over, as an array of strings.';
				}
				if (!Number.isInteger(m.budget) || m.budget < 1) {
					return 'A walk needs "budget": how many directory entries it may look at. A walk with no '
						+ 'ceiling is a walk that never comes back.';
				}
			}
			if (typeof m.cwd !== 'string' || !m.cwd) {
				return 'A file request needs cwd, an absolute working directory inside the fence.';
			}
			if (!absolute(m.cwd) || segments(m.cwd).indexOf('..') >= 0) {
				return `The working directory "${m.cwd}" is not an absolute path without ".." in it.`;
			}
			for (const k of ['text', 'text2']) {
				if (m[k] !== undefined && m[k] !== null && typeof m[k] !== 'string') {
					return `A file request's ${k} must be text.`;
				}
			}

			return wrongFence(m.fence, m.cwd, m.toolkits);
		}

		/// What is wrong with a request to run a verifier.
		///
		/// Shorter than `wrongExec` because there is far less to be wrong with,
		/// and that IS the security argument for this message existing rather
		/// than being an exec with a convention attached. A verify carries no
		/// argv, no cwd, no env and no fence: it carries a NAME the hand looks up
		/// in its own granted `dev/` directory, and at most a BREAK the hand
		/// looks up in that file's own source. There is nothing here for a page
		/// to turn into a program or a path, so there is nothing here for this
		/// second line to have to defend.
		///
		/// What it does check is the shape of the two selectors, so that a
		/// malformed one becomes a sentence rather than a dropped connection.
		function wrongVerify(m) {
			if (!m.id || typeof m.id !== 'string') {
				return 'Every verify needs an id, which every answer about it is tagged with.';
			}
			if (m.id.length > ID_MAX) {
				return `That id is ${m.id.length} characters, over the ${ID_MAX} the hand carries. Use a short handle.`;
			}
			// eslint-disable-next-line no-control-regex
			if (/[\u0000-\u001f\u007f]/.test(m.id)) {
				return 'That id has a control character in it. An id is a handle, not data.';
			}
			if (typeof m.name !== 'string' || !NAME.test(m.name)) {
				return 'verify needs a name: the verifier\'s short name, lower-case letters, digits and underscores -- '
					+ '"graph" for dev/verify_graph.mjs. It is a NAME and not a path or a command line, and the hand '
					+ 'looks it up in the folder it was granted.';
			}
			if (['all', 'one', 'none'].indexOf(m.breaks) < 0) {
				return 'verify needs breaks: "all" to run every break the verifier declares, "one" with a "break" naming '
					+ 'a declared break, or "none" for a clean run whose result proves nothing and says so.';
			}
			if (m.breaks === 'one' && (typeof m.break !== 'string' || !NAME.test(m.break))) {
				return 'A verify asking for one break did not name a usable one. A break is lower-case letters, digits '
					+ 'and underscores, and it has to be one the verifier itself declares.';
			}
			if (typeof m.timeout_ms !== 'number' || !Number.isInteger(m.timeout_ms)
				|| m.timeout_ms <= 0 || m.timeout_ms > TIMEOUT_MAX) {
				return `verify needs timeout_ms: a whole number of milliseconds between 1 and ${TIMEOUT_MAX}, covering `
					+ `the WHOLE sequence -- the clean run and every break after it.`;
			}
			return null;
		}

		/// The one alphabet a verifier's name and a break's name are spelled in.
		///
		/// Deliberately narrow: no dot, so ".." cannot be written; no slash; no
		/// dash, so nothing can begin with one and be read as an option. The hand
		/// applies the same rule again -- this is a second line, never the only one.
		const NAME = /^[a-z0-9_]{1,64}$/;

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

			return wrongFence(m.fence, m.cwd, m.toolkits, true);
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
		function wrongFence(f, cwd, kits, terminal) {
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
					const bad = wrongRoot(p, field, kits, terminal);
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
		function wrongRoot(p, field, kits, terminal) {
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
			// A TERMINAL may be fenced to a folder the machine offered as a ceiling, which is
			// wider than the grant on purpose. The list is the hand's, arriving in its `hello`,
			// so this is still the page being held to something it could not choose.
			if (field !== 'deny' && terminal && hostCeilings.some((c) => under(p, c))) {
				return null;
			}
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

		/// The page has gone: a tab closed, a reload, a crash. Which of those it
		/// was cannot be told from here and does not have to be -- the commonest
		/// by far is a reload, so what it left is HELD for the length of the
		/// grace and stopped only when nothing comes back for it.
		function pageGone() {
			park();
		}

		page.onMessage.addListener(fromPage);
		page.onDisconnect.addListener(pageGone);

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
		// The tab is what tells a reload from a second window. Chrome names it
		// on a page connection; where it does not, this is 0 and no relay is
		// ever parked for it, so the old behaviour stands unchanged.
		const sender = port.sender || {};
		const tab = (sender.tab && Number.isInteger(sender.tab.id)) ? sender.tab.id : 0;

		const waiting = tab ? parked.get(tab) : null;
		if (waiting) {
			if (waiting.origin === origin) { waiting.adopt(port); return; }
			// The same tab at a different Daimond origin. Its runs were started
			// under the other origin's grant and are not this page's to have.
			waiting.stop('');
		}

		const r = relay(port, origin, tab);
		// A page that came back after the grace had run out. Told once, and the
		// record cleared: it is news about one gap, not a standing condition.
		const gap = tab ? lapses.get(tab) : null;
		if (gap) {
			lapses.delete(tab);
			r.lapsed(gap);
		}
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
