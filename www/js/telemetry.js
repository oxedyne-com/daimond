/* telemetry.js — what a beta tester agrees to send, written out in full.
 *
 * ── Read this part even if you do not read code ─────────────────────
 *
 * Daimond's promise is that your content never reaches our server. Your chats,
 * your files, your Diamonds' names, the paths on your disk: none of it leaves
 * the browser except to the model provider you chose. A beta tester agrees to
 * one narrow exception, and this file is the whole of it.
 *
 * What is sent is a list of NUMBERS. Nothing else. Each line of a batch is
 * three integers -- which event, how many milliseconds into the session, and
 * one count -- and the envelope around them is five more integers. There is no
 * text field in this file's payload: not a message, not a file name, not a
 * stack trace, not a "what were you doing" box. You can check that claim by
 * reading `pack()` below, which is the only function that builds what is sent,
 * and `onlyIntegers()`, which refuses to send anything it cannot prove is a
 * number.
 *
 * The full list of events is `EVENTS`, a little way down. Every event Daimond
 * can ever send is in that list, by name, with what its number means and the
 * question it exists to answer. If an event is not in that list it cannot be
 * sent, because `emit()` turns a name into its code by looking it up here and
 * sends the CODE; a name it does not recognise is dropped and the name itself
 * is never transmitted either way.
 *
 * ── The cost of that, stated plainly ────────────────────────────────
 *
 * When Daimond breaks for you, we get an event name and a count -- never the
 * error message, never the file it happened in. That is a real cost and it was
 * accepted deliberately, because the alternative is a text field, and a text
 * field is how a chat fragment ends up on a server no matter how careful the
 * scrubbing is. What stands in for a stack trace here is the ORDER: a batch
 * carries its events in sequence with the milliseconds between them, so
 * "opened the Files panel, ran two file tools, then threw" localises a fault
 * without a single character of your data.
 *
 * ── Not to be confused with signals.js ──────────────────────────────
 *
 * `signals.js` is the Optimiser's index of how YOU work. It never leaves the
 * device and it is not sent anywhere by anything. This file is the opposite
 * arrangement: a small, fixed, numeric thing that does leave, and only from an
 * account that asked to be in the beta.
 *
 * ── Consent, and why it is not a checkbox ───────────────────────────
 *
 * There is no `enabled` flag here, because a flag is a thing a future release
 * forgets to check. Instead, the recorder does not exist until a beta grant
 * makes one: `rec` is null, `emit()` has nowhere to put an event, `flush()`
 * has nothing to send and no address to send it to. `consent()` is the only
 * function that mints one, it needs a beta wave number it cannot invent, and
 * nothing in the shipped tree calls it yet -- the consent moment is passcode
 * redemption, which is not built. So today this module records nothing and
 * sends nothing, and `dev/verify_telemetry.mjs` proves that at the network.
 *
 * Nor is consent REMEMBERED here. There is no `daimond-telemetry` key and no
 * flag in any parcel: a reload starts with no recorder, exactly like a first
 * boot, and something has to hand this module a grant again. That is on
 * purpose. A remembered "yes" is a flag by another name -- it outlives the
 * account it was given for, survives a passcode being revoked, and is the one
 * piece of state a later release could inherit without meaning to. Membership
 * of the beta lives on the gateway, where it can be taken away.
 *
 * Attaches a single global, `window.DaimondTelemetry`. Also exported for Node,
 * so the vocabulary can be read by a checker without a browser.
 */
(function () {
	'use strict';

	// ── The event vocabulary ────────────────────────────────────
	//
	// The whole of what Daimond can send. Each entry is:
	//
	//   code  the integer that goes on the wire. ASSIGNED, never positional:
	//         reordering this list must not silently change what an old batch
	//         meant. A code is never reused for a different event.
	//   name  what the code is called in this codebase. Never transmitted.
	//   n     what this event's one number means.
	//   asks  the question it exists to answer. An event nobody would act on
	//         is an event that should not be here.

	var EVENTS = [
		{ code:  1, name: 'app.open',     n: 'milliseconds from opening the page to a usable app',
		  asks: 'Does Daimond start on a real machine, and how long does it make people wait?' },
		{ code:  2, name: 'app.close',    n: 'seconds this session lasted',
		  asks: 'Is Daimond used for two minutes or for two hours? Sitting length is the honest measure of whether it is being worked in.' },
		{ code:  3, name: 'onboard.step', n: 'the step reached, from STEPS',
		  asks: 'Where do new testers stop? The one number a beta most needs: passphrase, model, first turn, first answer.' },
		{ code:  4, name: 'panel.open',   n: 'which panel, from PANELS',
		  asks: 'Which panels earn their place, and which has nobody ever opened?' },
		{ code:  5, name: 'diamond.new',  n: 'how many Diamonds exist afterwards',
		  asks: 'Do people build a workspace of their own, or stay with the two Daimond seeds?' },
		{ code:  6, name: 'chat.new',     n: 'how many chats exist afterwards',
		  asks: 'Is work divided into many short chats or kept in a few long ones? It decides what the rail should be optimised for.' },
		{ code:  7, name: 'turn.send',    n: 'which turn of that chat this is, counting from one',
		  asks: 'How deep does a conversation actually go before it is left?' },
		{ code:  8, name: 'turn.done',    n: 'seconds the turn took, end to end',
		  asks: 'What is a real turn worth of waiting, away from a developer machine on a fast line?' },
		{ code:  9, name: 'turn.stop',    n: 'seconds into the turn when the user stopped it',
		  asks: 'Giving up early means it was going wrong; giving up late means it was too slow. Two different fixes.' },
		{ code: 10, name: 'turn.fail',    n: 'which failure, from FAILURES',
		  asks: 'Which provider failure do testers actually meet, as against the ones we imagine?' },
		{ code: 11, name: 'chat.leave',   n: 'how many turns the chat had when it was left',
		  asks: 'Abandoned after one turn is a different story from finished after twenty. This is where people give up.' },
		{ code: 12, name: 'tool.run',     n: 'which tool, from TOOLS',
		  asks: 'Which capabilities are reached for? A tool nobody runs is a tool to remove or to explain better.' },
		{ code: 13, name: 'tool.fail',    n: 'which tool, from TOOLS',
		  asks: 'Which capability breaks in the field, on machines we do not have?' },
		{ code: 14, name: 'error.thrown', n: 'how many uncaught errors so far this session, counting this one',
		  asks: 'Is the app throwing? The events before it in the same batch say roughly where, without a stack trace.' },
		{ code: 15, name: 'sync.done',    n: 'seconds the push took',
		  asks: 'Is syncing usable on a real connection, or only on ours?' },
		{ code: 16, name: 'sync.fail',    n: 'which failure, from FAILURES',
		  asks: 'Which sync failure is worth fixing first?' },
		{ code: 17, name: 'storage.high', n: 'megabytes held when the storage warning appeared',
		  asks: 'Does anybody reach the storage wall, and at what size?' },
		{ code: 18, name: 'buy.open',     n: 'which offer, from OFFERS',
		  asks: 'Does anyone try to pay at all? Reaching for the offer is the signal; buying is the next one.' },
		{ code: 19, name: 'buy.done',     n: 'which offer, from OFFERS',
		  asks: 'And does checkout finish? The gap between this and buy.open is where money is lost.' },
		{ code: 20, name: 'update.take',  n: 'seconds from the new build being offered to the reload',
		  asks: 'Do testers get onto the fix, or stay on the build that has the fault?' },
	];

	// ── The ordinal tables ──────────────────────────────────────
	//
	// The fields above that say "from PANELS" and so on take a number out of one
	// of these fixed lists. This is the discipline that keeps a name off the
	// wire: a panel, tool or failure that is not listed here becomes 0, which
	// means "something else". It is never sent as text, and never added to at
	// runtime.

	/// The panels of the three-zone layout, in the order they were built.
	var PANELS = ['other', 'chat', 'files', 'diamonds', 'mail', 'terminal',
		'web', 'graph', 'spend', 'trash', 'search', 'journal', 'viewer', 'settings'];

	/// The tools a Diamond can run. Mirrors the wasm tool registry; a tool not
	/// named here is reported as 'other'.
	var TOOLS = ['other', 'file_read', 'file_write', 'file_list', 'file_move',
		'file_delete', 'dir_create', 'web_fetch', 'web_search', 'web_click',
		'web_type', 'mail_send', 'mail_sync', 'shell', 'agent'];

	/// Why something did not work. Deliberately coarse: a class of failure is
	/// actionable and a message is not sendable.
	var FAILURES = ['other', 'offline', 'refused', 'rate_limited', 'too_long',
		'server_error', 'conflict', 'too_large', 'timed_out'];

	/// What is on sale.
	var OFFERS = ['other', 'credits', 'pro', 'pack'];

	/// How far into a first run somebody got.
	var STEPS = ['other', 'gate_shown', 'identity_made', 'unlocked',
		'model_connected', 'turn_sent', 'turn_answered'];

	/// The locales Daimond ships. The envelope carries the index, so we can see
	/// whether a translation is being used without asking anybody.
	var LOCALES = ['other', 'en', 'es', 'de', 'fr', 'pt-BR', 'zh-Hans', 'ja', 'ko'];

	/// Every key that may appear in a batch. Nothing outside this set is built
	/// by `pack()`, and `onlyIntegers()` refuses a batch carrying one.
	///
	///   v  this payload's version
	///   b  which build, as an integer (see `buildOrdinal`)
	///   l  which locale, from LOCALES
	///   w  the beta wave this account was let into
	///   t  the moment the batch was sent, in whole seconds since 1970
	///   d  events dropped since the last batch, because the buffer was full
	///   e  the events: [code, milliseconds since the session began, n]
	var PAYLOAD_KEYS = ['v', 'b', 'l', 'w', 't', 'd', 'e'];

	/// This payload's shape. Bumped only if the three-integer line changes.
	var PAYLOAD_VERSION = 1;

	/// Where a batch goes. A constant with no query string, so the address
	/// itself cannot carry anything either.
	var ENDPOINT = '/api/telemetry';

	/// The most events one batch may carry. Beyond this the OLDEST are dropped
	/// and counted into `d`: a session that throws five hundred times should
	/// cost one batch, not five hundred, and the count is what says it happened.
	var MAX_BATCH = 256;

	/// How often a non-empty buffer is sent, in milliseconds.
	var FLUSH_MS = 60000;

	/// The largest number that may travel. Anything above it, below zero, or not
	/// a whole number becomes 0 -- a wrong count is a nuisance, an unbounded one
	/// is a way to smuggle.
	var MAX_N = 2147483647;

	// ── The recorder ────────────────────────────────────────────
	//
	// This is the consent gate, and it is a shape rather than a flag.
	//
	// `rec` holds the buffer, the session clock, the beta wave and the closure
	// that reaches the network. All four are minted together by `consent()` and
	// exist nowhere else. Until then `emit()` has nowhere to put an event --
	// there is no buffer, so nothing accumulates to be sent later either -- and
	// `flush()` has neither anything to send nor an address to send it to.
	//
	// Deleting the check in `emit()` would not open a channel; it would throw on
	// a null. That is the difference between this and a boolean.

	var rec = null;

	/// Agree to the beta, and start recording.
	///
	/// Called from ONE place, once it exists: the handler for a redeemed beta
	/// passcode, which is what turns an account into a beta account on the
	/// gateway. Nothing else may call it, and nothing in the tree calls it
	/// today.
	///
	/// # Arguments
	/// * `grant` - What redemption returned. Must carry `wave`, a whole number
	///   above zero naming the beta intake this account was let into. There is
	///   no default: a recorder cannot be minted from nothing, which is what
	///   makes a forgotten `if` unable to start one.
	///
	/// # Returns
	/// True if a recorder was minted.
	function consent(grant) {
		if (rec) return true;
		var wave = grant && grant.wave;
		if (typeof wave !== 'number' || !isFinite(wave) || Math.floor(wave) !== wave || wave < 1) {
			return false;
		}
		rec = makeRecorder(wave);
		return true;
	}

	/// Everything a consenting session needs, and the only path to the network.
	///
	/// The `fetch` below is inside this closure on purpose: there is no
	/// module-level function that posts, so no other code in this file -- or a
	/// later edit to it -- can send a batch without a grant having produced this
	/// object first.
	function makeRecorder(wave) {
		var buf     = [];
		var t0      = Date.now();
		var dropped = 0;
		var build   = 0;
		var timer   = null;

		// Which build this is, as a number. Read from the same `build.json` the
		// updater reads; failing that it stays 0, which the gateway takes as
		// "unknown" rather than refusing the batch.
		//
		// A flush WAITS on this read. It is the difference between a batch that
		// can be attributed to a release and one that cannot, and the first
		// batch of a session -- the one carrying how the app started -- is
		// exactly the one a race would rob of its build. `dev/verify_telemetry`
		// asserts a real build ordinal for that reason; it caught this racing.
		var known;
		try {
			known = fetch('build.json', { cache: 'no-store' })
				.then(function (r) { return r.ok ? r.json() : null; })
				.then(function (j) { build = buildOrdinal(j && j.build); })
				.catch(function () { /* unknown build; batches still count */ });
		} catch (e) { known = null; /* no fetch, no build id */ }
		if (!known || typeof known.then !== 'function') known = Promise.resolve();

		var self = {
			wave: wave,

			push: function (code, n) {
				var dt = Date.now() - t0;
				if (!(dt >= 0)) dt = 0;
				buf.push([code, Math.min(Math.floor(dt), 86400000), n]);
				// Oldest out first. The newest events are the ones nearest
				// whatever went wrong.
				while (buf.length > MAX_BATCH) { buf.shift(); dropped++; }
				if (!timer) {
					timer = setTimeout(function () { timer = null; self.flush(); }, FLUSH_MS);
				}
			},

			/// Build a batch and send it. Resolves true if one went.
			flush: function () {
				if (!buf.length) return Promise.resolve(false);
				return known.then(function () {
					if (!buf.length) return false;		// a flush overtook us
					var body = pack(self.wave, build, buf, dropped);
					if (!onlyIntegers(body)) {
						// Unreachable by construction -- `pack` builds integers
						// and nothing else -- so reaching it means this file has
						// been changed in a way that breaks its promise. Drop
						// the batch rather than send an unknown shape.
						buf.length = 0; dropped = 0;
						return false;
					}
					buf.length = 0; dropped = 0;
					return fetch(ENDPOINT, {
						method:      'POST',
						credentials: 'same-origin',
						headers:     { 'Content-Type': 'application/json' },
						body:        JSON.stringify(body),
						keepalive:   true,
					}).then(function (r) { return !!r && r.ok; })
					  .catch(function () { return false; });
				});
			},
		};
		return self;
	}

	// ── Emitting ────────────────────────────────────────────────

	/// Code for a name, or 0 if it is not one of ours.
	var CODES = {};
	EVENTS.forEach(function (e) { CODES[e.name] = e.code; });

	/// Record one event.
	///
	/// The name is looked up and the CODE is what is kept; the name itself never
	/// reaches the buffer, so it cannot reach the wire even by mistake. An
	/// unknown name is dropped entirely rather than passed through, because
	/// passing it through is exactly how a caller's string would travel.
	///
	/// # Arguments
	/// * `name` - One of the names in EVENTS.
	/// * `n` - This event's one number, per its `n` line in EVENTS. Anything
	///   that is not a whole number in [0, MAX_N] becomes 0.
	function emit(name, n) {
		if (!rec) return false;
		var code = CODES[name];
		if (!code) return false;
		rec.push(code, whole(n));
		return true;
	}

	/// A whole number in range, or 0.
	function whole(n) {
		if (typeof n !== 'number' || !isFinite(n)) return 0;
		n = Math.floor(n);
		if (n < 0 || n > MAX_N) return 0;
		return n;
	}

	/// The position of `name` in one of the ordinal tables, or 0 for "something
	/// else". Exported so callers pass a number rather than inventing one, and
	/// so a name outside the table can only ever become 0.
	function ordinal(table, name) {
		var i = table.indexOf(name);
		return i > 0 ? i : 0;
	}

	// ── The payload ─────────────────────────────────────────────

	/// The only function that builds what is sent. Integers throughout, keys
	/// drawn from PAYLOAD_KEYS, and no argument reaches it except numbers that
	/// have already been through `whole()`.
	function pack(wave, build, events, dropped) {
		var e = [];
		for (var i = 0; i < events.length; i++) {
			e.push([whole(events[i][0]), whole(events[i][1]), whole(events[i][2])]);
		}
		return {
			v: PAYLOAD_VERSION,
			b: whole(build),
			l: localeOrdinal(),
			w: whole(wave),
			t: Math.floor(Date.now() / 1000),
			d: whole(dropped),
			e: e,
		};
	}

	/// A build id is twelve hex characters. The first eight of them, read as a
	/// number, identify the build without carrying a string: the operator maps
	/// it back through `build.json` or the transparency log.
	function buildOrdinal(id) {
		if (typeof id !== 'string' || !/^[0-9a-f]{8}/.test(id)) return 0;
		var n = parseInt(id.slice(0, 8), 16);
		return isFinite(n) ? n : 0;
	}

	/// Which of the shipped locales is in use, from LOCALES.
	function localeOrdinal() {
		var code = '';
		try { code = window.DaimondI18n ? window.DaimondI18n.locale() : ''; }
		catch (e) { code = ''; }
		return ordinal(LOCALES, code);
	}

	/// Is this batch numbers all the way down?
	///
	/// The last gate before the wire, and a belt over the braces: `pack()`
	/// already builds nothing but integers. It is here so that a future edit
	/// which adds a field has to defeat a check rather than merely forget one --
	/// and so that this file states its promise as code a reader can run, not
	/// only as a paragraph they have to believe.
	function onlyIntegers(body) {
		if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
		var keys = Object.keys(body);
		for (var i = 0; i < keys.length; i++) {
			if (PAYLOAD_KEYS.indexOf(keys[i]) === -1) return false;
		}
		return keys.every(function (k) {
			return k === 'e' ? rowsAreIntegers(body[k]) : isInt(body[k]);
		});
	}

	function rowsAreIntegers(rows) {
		if (!Array.isArray(rows)) return false;
		return rows.every(function (row) {
			return Array.isArray(row) && row.length === 3 && row.every(isInt);
		});
	}

	function isInt(x) {
		return typeof x === 'number' && isFinite(x) && Math.floor(x) === x
			&& x >= 0 && x <= MAX_N;
	}

	// ── What the rest of the app sees ───────────────────────────

	var api = {
		// The vocabulary, exported so a checker can compare it with the
		// gateway's copy and so nothing else invents an event name.
		EVENTS:        EVENTS,
		PANELS:        PANELS,
		TOOLS:         TOOLS,
		FAILURES:      FAILURES,
		OFFERS:        OFFERS,
		STEPS:         STEPS,
		LOCALES:       LOCALES,
		PAYLOAD_KEYS:  PAYLOAD_KEYS,
		PAYLOAD_VERSION: PAYLOAD_VERSION,
		ENDPOINT:      ENDPOINT,
		MAX_BATCH:     MAX_BATCH,

		// Recording.
		emit:          emit,
		ordinal:       ordinal,

		// Consent, and a way for a test or a settings pane to ask whether it
		// has been given. `armed` READS; it can never grant.
		consent:       consent,
		armed:         function () { return !!rec; },
		wave:          function () { return rec ? rec.wave : 0; },

		// Send now. Nothing to send and nowhere to send it, until consent.
		flush:         function () { return rec ? rec.flush() : Promise.resolve(false); },

		// Exported for the checker only.
		onlyIntegers:  onlyIntegers,
	};

	if (typeof window !== 'undefined') window.DaimondTelemetry = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
