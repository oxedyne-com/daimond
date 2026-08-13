/* gateway.js — Daimond's account and credits, against the Daimond gateway.
 *
 * The gateway (a Steel app-side binary) already implements account binding,
 * a device-key challenge/response, a credit ledger and Stripe Checkout, and it
 * was proven end to end against Stripe's sandbox. Nothing in the client ever
 * called it: `DaimondIdentity.sign()` and `publicKeyRaw()` — the exact primitives
 * its auth expects — sat implemented and unused. This is that wiring.
 *
 * There is no password anywhere. The device keypair IS the credential: the
 * gateway binds an account to the public key, then proves possession with a
 * signed nonce. So the account follows the passphrase, and the passphrase never
 * leaves the browser.
 *
 * Endpoints are same-origin (`/api/*`); Steel front-proxies them to the gateway
 * on loopback, so the session cookie is a plain same-origin cookie.
 */
(function () {
	'use strict';

	var ACCOUNT_MSG   = 'daimond-gw-account:v1:';
	var state = {
		authed:   false,
		credits:  null,     // minor units (cents), or null when unknown
		currency: 'usd',
		entries:  [],
		offline:  false,    // the gateway could not be reached
		pro:      null,     // Pro RUNNING right now? null until asked.
		proPriceMinor: null,// the one-time Pro price, from the gateway.
		// The five-year term, so a lapse can be explained rather than merely
		// obeyed. `proExpiresTs` is when the licence ends (Unix seconds, null
		// when none is held), `proExpired` says a licence exists and its term
		// has run out, `proTermSecs` is the term itself, and `proNowTs` is the
		// GATEWAY's clock at the moment it answered -- a countdown drawn
		// against the device's own clock would be wrong on a device set wrong.
		proExpiresTs: null,
		proExpired:   false,
		proTermSecs:  null,
		proNowTs:     null,
		// The console role, once asked for. `undefined` means not yet asked;
		// null means asked and the answer was no. Switching account clears it,
		// because it is an answer about whoever is signed in now.
		role:     undefined,
	};

	/// The credit packs the gateway will accept. The price is server-owned; this
	/// is only what we offer, and the gateway re-checks it against its allowlist.
	var PACKS = [1000, 2000, 5000, 10000];

	/// The API contract version this build speaks. Bumped in lockstep with the
	/// gateway's GATEWAY_API/MIN_CLIENT_API (gateway/src/handlers/common.rs)
	/// whenever the HTTP contract changes in a way an old tab cannot survive.
	/// Sent on every call so the gateway can refuse a tab too old to serve.
	///
	/// Exported as `clientApi()`, because a caller outside this file needs the
	/// number and must not carry its own copy: two constants that have to match
	/// are two constants that will eventually not. `models.js` mints inference
	/// keys against `/api/inference-key` and reads it from here.
	var CLIENT_API = 1;

	/// Every gateway reply advertises the gateway's version and the oldest client
	/// it will serve. If this tab is below that floor -- or a call was refused
	/// with 426 -- it is out of date: tell the updater, which reloads onto the
	/// current build. Checked on success and failure alike, so a tab notices the
	/// moment it falls behind, not only when a call breaks.
	function probeVersion(r) {
		var stale = r.status === 426;
		if (!stale) {
			var min = parseInt(r.headers.get(HDR_MIN_API), 10);
			if (isFinite(min) && min > CLIENT_API) stale = true;
		}
		if (stale) { try { window.dispatchEvent(new Event('daimond:stale')); } catch (e) {} }
	}
	var HDR_MIN_API = 'x-daimond-min-api';

	/// A compact IANA-timezone → ISO-3166 alpha-2 table, the fallback when the
	/// browser locale carries no region subtag. Not exhaustive — a few hundred
	/// common zones — and an unknown zone simply yields no country, which the
	/// gateway stores as "". Only ever used to shade the operator's usage map.
	var TZ_COUNTRY = {
		'Africa/Cairo':'EG','Africa/Johannesburg':'ZA','Africa/Lagos':'NG','Africa/Nairobi':'KE',
		'Africa/Casablanca':'MA','Africa/Algiers':'DZ','Africa/Accra':'GH','Africa/Addis_Ababa':'ET',
		'Africa/Tunis':'TN','Africa/Khartoum':'SD','Africa/Dar_es_Salaam':'TZ','Africa/Kampala':'UG',
		'America/New_York':'US','America/Chicago':'US','America/Denver':'US','America/Los_Angeles':'US',
		'America/Phoenix':'US','America/Anchorage':'US','America/Detroit':'US','Pacific/Honolulu':'US',
		'America/Toronto':'CA','America/Vancouver':'CA','America/Edmonton':'CA','America/Winnipeg':'CA',
		'America/Halifax':'CA','America/Mexico_City':'MX','America/Monterrey':'MX','America/Tijuana':'MX',
		'America/Bogota':'CO','America/Lima':'PE','America/Santiago':'CL','America/Caracas':'VE',
		'America/Sao_Paulo':'BR','America/Fortaleza':'BR','America/Manaus':'BR','America/Argentina/Buenos_Aires':'AR',
		'America/Montevideo':'UY','America/Asuncion':'PY','America/La_Paz':'BO','America/Guayaquil':'EC',
		'America/Panama':'PA','America/Costa_Rica':'CR','America/Guatemala':'GT','America/Havana':'CU',
		'America/Santo_Domingo':'DO','America/Puerto_Rico':'PR','America/Jamaica':'JM',
		'Asia/Dubai':'AE','Asia/Qatar':'QA','Asia/Riyadh':'SA','Asia/Kuwait':'KW','Asia/Bahrain':'BH',
		'Asia/Muscat':'OM','Asia/Baghdad':'IQ','Asia/Tehran':'IR','Asia/Jerusalem':'IL','Asia/Amman':'JO',
		'Asia/Beirut':'LB','Asia/Damascus':'SY','Asia/Istanbul':'TR','Europe/Istanbul':'TR',
		'Asia/Karachi':'PK','Asia/Kolkata':'IN','Asia/Calcutta':'IN','Asia/Colombo':'LK','Asia/Dhaka':'BD',
		'Asia/Kathmandu':'NP','Asia/Yangon':'MM','Asia/Bangkok':'TH','Asia/Ho_Chi_Minh':'VN',
		'Asia/Phnom_Penh':'KH','Asia/Vientiane':'LA','Asia/Jakarta':'ID','Asia/Makassar':'ID',
		'Asia/Kuala_Lumpur':'MY','Asia/Singapore':'SG','Asia/Manila':'PH','Asia/Hong_Kong':'HK',
		'Asia/Taipei':'TW','Asia/Shanghai':'CN','Asia/Urumqi':'CN','Asia/Seoul':'KR','Asia/Tokyo':'JP',
		'Asia/Ulaanbaatar':'MN','Asia/Almaty':'KZ','Asia/Tashkent':'UZ','Asia/Baku':'AZ','Asia/Tbilisi':'GE',
		'Asia/Yerevan':'AM','Asia/Yekaterinburg':'RU','Asia/Novosibirsk':'RU','Asia/Vladivostok':'RU',
		'Europe/London':'GB','Europe/Dublin':'IE','Europe/Lisbon':'PT','Europe/Madrid':'ES',
		'Europe/Paris':'FR','Europe/Brussels':'BE','Europe/Amsterdam':'NL','Europe/Luxembourg':'LU',
		'Europe/Berlin':'DE','Europe/Zurich':'CH','Europe/Vienna':'AT','Europe/Rome':'IT',
		'Europe/Copenhagen':'DK','Europe/Oslo':'NO','Europe/Stockholm':'SE','Europe/Helsinki':'FI',
		'Europe/Warsaw':'PL','Europe/Prague':'CZ','Europe/Bratislava':'SK','Europe/Budapest':'HU',
		'Europe/Bucharest':'RO','Europe/Sofia':'BG','Europe/Athens':'GR','Europe/Zagreb':'HR',
		'Europe/Belgrade':'RS','Europe/Ljubljana':'SI','Europe/Vilnius':'LT','Europe/Riga':'LV',
		'Europe/Tallinn':'EE','Europe/Kyiv':'UA','Europe/Kiev':'UA','Europe/Minsk':'BY',
		'Europe/Moscow':'RU','Europe/Reykjavik':'IS',
		'Australia/Sydney':'AU','Australia/Melbourne':'AU','Australia/Brisbane':'AU','Australia/Perth':'AU',
		'Australia/Adelaide':'AU','Australia/Hobart':'AU','Australia/Darwin':'AU',
		'Pacific/Auckland':'NZ','Pacific/Fiji':'FJ','Pacific/Port_Moresby':'PG','Pacific/Guam':'GU',
	};

	/// Derive a 2-letter country for this browser, or `undefined` when nothing
	/// reliable is available. The locale's region subtag is tried first
	/// (`en-AU` → `AU`); failing that, the IANA time zone is looked up. An
	/// undefined result is simply omitted from the registration body.
	function deriveCountry() {
		try {
			var langs = [];
			if (navigator.languages && navigator.languages.length) langs = navigator.languages.slice();
			if (navigator.language) langs.push(navigator.language);
			for (var i = 0; i < langs.length; i++) {
				var m = /[-_]([A-Za-z]{2})(?:$|[-_])/.exec(langs[i] || '');
				if (m) return m[1].toUpperCase();
			}
		} catch (e) {}
		try {
			var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
			if (tz && TZ_COUNTRY[tz]) return TZ_COUNTRY[tz];
		} catch (e) {}
		return undefined;
	}

	/// Minor units as money. The display currency is applied in i18n.js, which
	/// is the only place in the app that decides what a figure looks like.
	function fmtMoney(minor, currency) {
		return DaimondI18n.moneyMinor(minor, currency);
	}

	/// The same figure at a point where the user is actually charged: US
	/// dollars, said out loud, with the converted figure beside it.
	function fmtBilled(minor, currency) {
		return DaimondI18n.billedMinor(minor, currency);
	}

	/// The header, the Spending panel and anything else watching money get told once, here,
	/// rather than each of them polling. A page with no `window` (a test harness evaluating this
	/// file) simply does not hear it.
	///
	/// Only ever called for a figure that MOVED. The Spending panel refreshes on this event and
	/// its refresh fetches the balance, so an unconditional dispatch closed a loop: every reply
	/// refreshed the panel, every refresh produced a reply, and an open panel drove the gateway
	/// at hundreds of requests a second for as long as it stayed on screen.
	function announce() {
		try {
			window.dispatchEvent(new CustomEvent('daimond:credits', {
				detail: { credits: state.credits, currency: state.currency },
			}));
		} catch (e) { /* no window to tell */ }
	}

	/// Take the balance out of any gateway reply that carries one.
	///
	/// Nearly every credit-spending endpoint already returns the resulting balance in
	/// `credits_minor`, and the app was throwing all of them away — so the account figure in the
	/// header stayed at whatever the last explicit `/api/balance` call had said, and a page that
	/// fetched twenty web pages showed the balance it started with until something happened to
	/// re-ask. Every reply is now read, and each one that says refreshes the number.
	///
	/// Silent about anything else: an absent field, a null, a string. `state.credits` is `null`
	/// for "unknown", and writing that from a reply that simply did not mention money would
	/// erase a figure the app legitimately holds.
	///
	/// ## WHY THE FIGURE SITS STILL WHILE A CHAT RUNS, AND WHY THAT IS NOT THIS FILE'S FAULT
	///
	/// Reported as a bug twice, and looked for twice in the client, so it is written down here
	/// where the next reader will be standing.
	///
	/// Daimond does not proxy inference — that is the privacy claim, not an implementation
	/// detail. The gateway sells a spend-capped key at the model host and the browser talks to
	/// the host directly, so the gateway is not in the request path and learns nothing about a
	/// turn as it happens. The account's ledger is debited only when that key is RECONCILED,
	/// which `/api/inference-key` does at the top of a mint (gateway `handlers::inference_key`,
	/// `reconcile`) — that is, when the key's float is exhausted, or when the daily sweep finds
	/// it. `/api/balance` folds the ledger, so between reconciliations it returns the same figure
	/// however often it is asked, and `noteBalance` correctly says nothing about a number that
	/// has not moved. The session/week/month meters below it move every turn because they are
	/// built from what the PROVIDER reported, on the device, and never touch the ledger at all.
	///
	/// So a client-side poll cannot fix this and no amount of it will: the balance really has not
	/// changed where the balance lives. Two things do fix it, in this order — `/api/inference-key`
	/// carries the freshly reconciled figure in its reply and its caller must hand it to this
	/// function rather than keeping a private copy; and `/api/balance` should reconcile before it
	/// folds, which `reconcile()` is already re-entrant and non-fatal enough to allow.
	///
	/// # Arguments
	/// * `j` - A parsed gateway reply, or anything at all.
	function noteBalance(j) {
		if (!j || typeof j !== 'object') return;
		if (typeof j.credits_minor !== 'number' || !isFinite(j.credits_minor)) return;
		var moved = state.credits !== j.credits_minor;
		state.credits = j.credits_minor;
		if (typeof j.currency === 'string' && j.currency && j.currency !== state.currency) {
			state.currency = j.currency;
			moved = true;
		}
		if (moved) announce();
	}

	// ── The pause, refused where credits are committed ─────────
	//
	// A pause the widget respects and the network does not is decoration, so the
	// gateway routes that COST are refused here rather than in the interface. The
	// refusal is an ordinary 423 with `ok: false` and a sentence, so every caller
	// shows it through the error path it already has and none of them needs to
	// learn a second one.
	//
	// SYNC IS DELIBERATELY ABSENT from this table, and that is a decision rather
	// than an omission. `/api/sync` is how a paired device catches up; a device
	// that stopped syncing while paused would come back holding stale work,
	// resolve it against the parcel, and the failure — a device stranded, or a
	// merge fought out days later — is worse than the fraction of a cent a parcel
	// costs. Pause is a control on what SPENDS on the user's behalf while they
	// are not looking; a sync is the account being itself.
	//
	// Reading is likewise absent: `/api/mail/folders`, `/api/mail/accounts` and
	// `/api/balance` list what is already there, and a paused Diamond still
	// opens.

	/// What the app says. The table lives in i18n/en.js.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// The words for a refusal: the table's sentence, or the whole English one the
	/// caller wrote, so nothing ever shows a bare key.
	///
	/// IT APPENDS NOTHING. It used to add "Press play on it to resume." to every
	/// fallback, and that is how the app came to give advice it could not honour:
	/// `root/web` had no control anywhere, so a user who paused Everything was
	/// told to press a play button that did not exist, and their only way back was
	/// to resume everything — which also resumed a Diamond that ships paused on
	/// purpose. The control exists now and the sentence would be true again, which
	/// is exactly why the assembly is still wrong: a clause bolted on here is a
	/// claim about a node this function knows nothing about, and it will be wrong
	/// again the next time a leaf arrives before its control does. Each caller
	/// writes its own complete sentence, and owns whether it can promise a button.
	/// `english` is the WHOLE sentence, `{node}` included, so it is a byte-for-byte
	/// copy of the catalogue entry rather than a second assembly of one. A fallback
	/// stitched together here drifted from `en.js` the first time the wording was
	/// revised, and nothing noticed because it only shows when the table is absent.
	function pauseWords(key, node, english) {
		var s = t(key, { node: node });
		return (s === key) ? english.replace(/\{node\}/g, node) : s;
	}

	/// Is this node paused? A leaf's own flag, and cheap enough to sit in front
	/// of every request.
	function held(node) {
		return !!(node && window.DaimondPause && DaimondPause.isPaused(node));
	}

	/// A node id, escaped the way the tree escapes one. Only ever reached with
	/// the module present; `spendRefusal` answers null before it gets here.
	function pid() {
		return DaimondPause.id.apply(null, arguments);
	}

	/// Is EVERYTHING paused? The global control at the top of the rail is the
	/// root of the same tree, so this is what it means when a spend cannot be
	/// attributed to a leaf of its own.
	function allHeld() {
		if (!window.DaimondPause) return false;
		return DaimondPause.state(DaimondPause.ROOT) === 'pause';
	}

	/// The body a request carries, parsed, or an empty object. Every body in
	/// this app is a JSON string; anything else simply names no node.
	function bodyOf(opts) {
		try {
			var b = opts && opts.body;
			return (typeof b === 'string' && b) ? (JSON.parse(b) || {}) : {};
		} catch (e) { return {}; }
	}

	/// Whether this request is refused by the pause tree, and in whose name.
	/// Returns `{ node, message }`, or null for the great majority of calls that
	/// cost nothing and are never held.
	///
	/// The path is matched on its own, before the query: `path === query` is a
	/// mistake this tree has made before.
	function spendRefusal(path, opts) {
		if (!window.DaimondPause) return null;
		var p = String(path || '').split('?')[0];
		if (p.indexOf('/api/mail/') === 0 || p.indexOf('/api/web/') === 0) {
			var b = bodyOf(opts);
			if (p === '/api/mail/sync' || p === '/api/mail/send') {
				var own = pid(DaimondPause.ROOT, 'mail', b.address, 'self');
				// A sync is the FOLDER's spend; a send, and a poll that names no
				// folder, is the mailbox's own. Either leaf holds it: a paused
				// mailbox must not go on reaching the server one folder at a time.
				var leaf = (p === '/api/mail/sync' && b.mailbox)
					? pid(DaimondPause.ROOT, 'mail', b.address, b.mailbox)
					: own;
				var stop = held(leaf) ? leaf : (held(own) ? own : '');
				if (stop) {
					// The whole sentence, clause included: every mail leaf has had a
					// control on it since phase G, so this one can promise a button.
					return { node: stop, message: pauseWords('pause.refused.mail', stop,
						'{node} is paused. The mailbox was not contacted and nothing was spent. '
						+ 'Press play on it to resume.') };
				}
				return null;
			}
			// Reaching out of the browser, however it is done: a page fetch, the
			// HEAD that asks whether a site will frame, and a SEARCH. One leaf
			// governs all three, because they are one question — may this app
			// contact the outside world on the user's behalf right now.
			//
			// The search route was missing here, and its absence was total: it
			// matched no arm, so it fell out of the bottom of this function and
			// was governed by NOTHING — not the Web leaf, not a Diamond's, and not
			// the global control. A user who paused Everything this morning to stop
			// outbound requests would have gone on searching, and paying for it.
			if (p === '/api/web/fetch' || p === '/api/web/head' || p === '/api/web/search') {
				// Charged to whoever asked for it, when the caller says so — and
				// otherwise to the Web panel's own leaf, with the global control
				// behind that. That leaf now has a control of its own, in the Web
				// panel header, so a refusal here points at something a user can
				// press rather than at the whole tree.
				var who = (typeof b.node === 'string' && b.node) ? b.node
					: pid(DaimondPause.ROOT, 'web');
				var hold = held(who) ? who : (allHeld() ? DaimondPause.ROOT : '');
				if (hold) {
					// One key for one leaf, and the sentence names the leaf rather
					// than the route: `pause.refused.web` is translated into eight
					// languages already, and a second key saying almost the same
					// thing would be a second thing to keep in step for the sake of
					// one noun. What was held is the web, whichever door was tried.
					return { node: hold, message: pauseWords('pause.refused.web', hold,
						'{node} is paused. The page was not fetched and nothing was spent. '
						+ 'Press play on it to resume.') };
				}
			}
		}
		return null;
	}

	/// The refusal as a reply, so a caller reads it the way it reads every other
	/// refusal: a status, `ok: false`, and a sentence. 423 Locked, because the
	/// request was well formed and the door is shut on purpose — and because
	/// nothing in this app treats a 423 as anything but its message (401 renews,
	/// 426 reloads, and both would be wrong here).
	function refusedReply(r) {
		return new Response(JSON.stringify({ ok: false, paused: true, node: r.node, error: r.message }), {
			status:  423,
			headers: { 'content-type': 'application/json' },
		});
	}

	/// The last point before a request leaves the page, for the two callers that
	/// hold their own `fetch` rather than coming through `gwFetch`: the Web
	/// panel's `gw()` (web.js) and anything added beside it. Narrow on purpose —
	/// a path not in the spend table is handed straight to the real `fetch`,
	/// untouched and unwrapped.
	///
	/// Cooperative would be better and is the follow-up: a caller that asked
	/// `spendRefusal` itself could show the sentence in its own panel instead of
	/// taking it off a 423. This is the guard that holds until then, and it is
	/// here because the alternative — a spend boundary that only the honest
	/// callers respect — is the decoration this whole phase exists to avoid.
	function guardFetch() {
		if (typeof window === 'undefined' || !window.fetch || window.fetch.__daimondPause) return;
		var real = window.fetch;
		var wrapped = function (input, init) {
			var url = '';
			try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { url = ''; }
			var p = url;
			// Same-origin absolute forms reduce to their path; anything else is
			// somebody else's host and is not ours to hold.
			if (p.indexOf('http') === 0) {
				try { var u = new URL(p); p = (u.origin === location.origin) ? u.pathname : ''; }
				catch (e) { p = ''; }
			}
			if (p.indexOf('/api/') === 0) {
				var r = spendRefusal(p, init || (typeof input === 'object' ? input : null));
				if (r) return Promise.resolve(refusedReply(r));
			}
			return real.apply(window, arguments);
		};
		wrapped.__daimondPause = true;
		window.fetch = wrapped;
	}

	// ── A session that has gone ────────────────────────────────
	//
	// The gateway's session lives an hour and nothing ever renewed it. The only
	// thing that has ever minted one is `bootstrap()`, called once per unlock, so
	// an hour into a sitting every call became a 401 -- and every caller in this
	// file swallowed it. `state.authed` stayed true, so the app went on saying it
	// was connected while sync's pushes were being refused, one an hour after
	// another, with the user's work never leaving the device.
	//
	// So a 401 is now acted on. The device key is the credential and it is still
	// in the page, so the session can simply be taken again -- which also covers a
	// gateway that restarted and a session ended from another tab.
	//
	// SINGLE-FLIGHT. Several callers are refused in the same moment -- sync's
	// push, its wake channel, the balance -- and each one minting its own session
	// would be a burst of signatures for one thing that needs doing once. They all
	// wait on the same attempt.
	var reauthing   = null;			// the attempt in flight, if there is one.
	// True while `bootstrap()` is running. Its own calls must never answer a 401
	// by re-entering the renewal they are part of: the balance read at the end of
	// a bootstrap that raced a logout would otherwise await the very promise it
	// is running inside, and the tab would hang there for good.
	var authing     = false;
	var reauthTimer = null;			// the standing retry, while the identity is unlocked.
	var reauthGen   = 0;			// bumped by logout, so a deliberate exit is not undone.
	var REAUTH_MIN_MS = 5000;		// first retry after a failed renewal.
	var REAUTH_MAX_MS = 120000;		// and no slower than this, ever.
	var reauthWait  = REAUTH_MIN_MS;

	/// The calls that ARE the authentication, and so cannot answer a 401 by
	/// authenticating again.
	function isAuthPath(path) {
		return path.indexOf('/api/account') === 0 || path.indexOf('/api/auth/') === 0;
	}

	/// Is this request one that a bootstrap in flight is making ITSELF?
	///
	/// Such a request must not answer a 401 by renewing: it would await the very
	/// promise it is running inside, and the tab would hang there for good. The
	/// authentication calls are one class of those; the other two are the balance
	/// and licence reads at the end of `bootstrap()`, and only while one is
	/// running.
	///
	/// Named by PATH rather than taken from the `authing` flag alone, and that
	/// distinction is the whole point. A flag says only that a bootstrap is
	/// happening SOMEWHERE, and refusing to renew on the strength of that breaks
	/// the case this mechanism exists for: several panels are refused in the same
	/// moment, one of them starts the renewal, and the rest land in the middle of
	/// it. Those are not the bootstrap's calls and cannot deadlock on it -- they
	/// simply wait for the attempt in flight and ask again, which is what the
	/// single-flight `reauth()` is for.
	function isBootstrapOwn(path) {
		if (isAuthPath(path)) return true;
		if (!authing) return false;
		return path.indexOf('/api/balance') === 0 || path.indexOf('/api/licence') === 0;
	}

	/// Take a session again after one was refused, once, however many callers ask.
	///
	/// Guarded on the identity: the account IS the device key, so with the app
	/// locked there is nothing to sign with and nothing to renew. That guard is
	/// also what stops a stray in-flight call resurrecting a session the user has
	/// just logged out of -- every logout path locks the identity first.
	///
	/// Returns whether there is a session now.
	///
	/// The attempt in flight is cleared in a `finally`, and that is not tidiness.
	/// It used to be cleared on the way past a value, so an attempt that THREW
	/// left the rejected promise standing as `reauthing` -- and every later call
	/// took the `if (reauthing)` arm and re-threw the same failure, for the life
	/// of the page. One renewal that fell over meant no session again, ever,
	/// short of a reload. `bootstrap()` catches broadly, but the six lines before
	/// its `try` -- `isUnlocked()`, `publicKeyB64url()`, a `localStorage` read --
	/// are outside it, and localStorage throws outright where storage access is
	/// denied. So the wedge is reachable, and it is one keystroke away from being
	/// reachable again whatever those lines become next.
	async function reauth() {
		if (reauthing) return await reauthing;
		state.authed = false;			// true from here would be a lie, whatever follows.
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return false;
		var gen = reauthGen;
		reauthing = (async function () {
			var got = await bootstrap();
			if (gen !== reauthGen) { state.authed = false; return false; }	// logged out under us.
			if (got) {
				reauthWait = REAUTH_MIN_MS;
				if (reauthTimer) { clearTimeout(reauthTimer); reauthTimer = null; }
				// The same event a first unlock raises, for the same reason: there
				// is a session now. Sync hears it and reconciles; without it a
				// device whose renewal only worked on the third go would hold a
				// live session and never use it.
				try { window.dispatchEvent(new Event('daimond:authed')); } catch (e) { /* no window */ }
			} else {
				armReauth();
			}
			return got;
		})();
		try { return await reauthing; }
		finally { reauthing = null; }
	}

	/// Come back to a renewal that did not work, after a wait that grows.
	///
	/// Without this a gateway that was down for a minute would leave the tab
	/// signed out for the rest of the day: every trigger in the app that would
	/// have retried is itself gated on there being a session. Jittered, so a
	/// gateway restart does not bring every device back in the same millisecond.
	function armReauth() {
		if (reauthTimer) return;
		var wait = reauthWait * (0.5 + Math.random());
		reauthWait = Math.min(REAUTH_MAX_MS, reauthWait * 2);
		reauthTimer = setTimeout(function () {
			reauthTimer = null;
			if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return;
			reauth();
		}, wait);
	}

	/// One gateway request, with the one refusal the app can put right itself.
	///
	/// THE ONE COPY. Four sibling files -- mail, tools, pairing, passkey -- each
	/// held an identical private version of this, and sync a fifth in a different
	/// shape; five copies of a rule that has to be the same rule in all five
	/// places. It lives here now, beside the renewal it drives, and every caller
	/// reaches it through `DaimondGateway.gwFetch`.
	///
	/// RENEW ONCE, RETRY ONCE, AND OTHERWISE HAND BACK THE ORIGINAL 401. An
	/// identity that genuinely cannot authenticate must surface rather than spin
	/// against a door that is not going to open, and when it does not come back
	/// `reauth()` has already cleared `state.authed` -- which is what the Admin
	/// drawer's Account row and the sync chip draw "not signed in" from. Nothing
	/// is raised over the app from here.
	///
	/// SAFE TO REPEAT. Every session-authed handler in the gateway takes the
	/// session before it does anything else: `common::authed_account` is the
	/// first statement after the method check in `pro_impl`, `credits_impl`,
	/// `pack_impl`, `card_impl`, `tools_impl`, `create_impl`, the mail handlers
	/// and the passkey blob's write and delete. So a 401 is proof that nothing
	/// happened -- no body parsed, no code minted, no charge, no message sent --
	/// and the second attempt cannot duplicate a side effect the first never had.
	/// The options object is reused as given, which holds because every body in
	/// this app is a string rather than a stream.
	///
	/// NOT FOR EVERY PATH. `/api/pair/redeem` and the passkey blob READ take no
	/// session at all and run on a device mid-adoption that has no identity to
	/// authenticate with; a redeem code is single-use besides, so a blanket retry
	/// is exactly the retry that must not exist. Both deliberately call `fetch`
	/// directly -- see the notes at `redeem()` in pairing.js and `getBlob()` in
	/// passkey.js.
	async function gwFetch(path, opts) {
		// A paused node never reaches the network. Here as well as in the guard
		// over `fetch`, because this is the one copy of the gateway rule and a
		// reader looking for what a call does looks here.
		var stop = spendRefusal(path, opts);
		if (stop) return refusedReply(stop);
		var r = await fetch(path, opts);
		probeVersion(r);
		// A call the bootstrap is making itself cannot answer a 401 by
		// bootstrapping; see isBootstrapOwn. Everything else may.
		if (r.status !== 401 || isBootstrapOwn(path)) return r;
		var back = false;
		try { back = !!(await reauth()); } catch (e) { back = false; }
		if (!back) return r;
		r = await fetch(path, opts);
		probeVersion(r);
		return r;
	}

	/// The reply, or an error. Through `gwFetch`, so a lapsed session costs the
	/// round a renewal and not the round itself.
	///
	/// This file used to renew and then throw the result away: the 401 arm called
	/// `reauth()` and fell straight through to the `throw`, so every caller here
	/// lost its answer at the hour mark having just paid for a new session. Two
	/// of those losses were worse than a blank: `state.pro` going null HIDES the
	/// Pro row rather than showing it unbought, and `operatorRole()` caches its
	/// null for the rest of the unlock, so a signed-in operator's console entry
	/// disappeared until they locked and unlocked again.
	async function post(path, body) {
		var r = await gwFetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			credentials: 'same-origin',
			body: JSON.stringify(body || {}),
		});
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok === false) {
			var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
			throw new Error(msg);
		}
		noteBalance(j);
		return j;
	}

	async function get(path) {
		var r = await gwFetch(path, {
			credentials: 'same-origin',
			headers: { 'x-daimond-api': String(CLIENT_API) },
		});
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok === false) {
			var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
			throw new Error(msg);
		}
		noteBalance(j);
		return j;
	}

	/// Bind this device's public key to an account, then authenticate.
	///
	/// Both steps are signed with the device key, so this only works while the
	/// identity is unlocked — which is why it hangs off `afterUnlock()` and not
	/// off boot.
	async function bootstrap() {
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return false;
		state.role = undefined;			// a new unlock is a new question
		state.pro  = null;			// re-asked for whoever unlocked now
		forgetLicenceTerm();			// and so are its dates
		var pub = DaimondIdentity.publicKeyB64url();
		if (!pub) return false;
		var alg = localStorage.getItem('daimond-id-alg') || 'Ed25519';

		authing = true;
		try {
			// Register (idempotent: an existing binding is simply re-confirmed).
			var ts  = Math.floor(Date.now() / 1000);
			var sig = await DaimondIdentity.sign(ACCOUNT_MSG + pub + ':' + ts);
			// NO COUNTRY IS DERIVED. It used to be guessed from the browser's
			// locale and time zone so the operator's map had something to shade,
			// which meant the one item taken without the user's involvement was
			// the one nobody had asked about. The privacy policy now says the
			// country is optional, entered by the user, and never worked out
			// from the browser: `deriveCountry` is kept, unused, until a field
			// exists to pass one here deliberately.
			var body = { pubkey: pub, alg: alg, ts: ts, sig: sig };
			await post('/api/account', body);

			// Prove possession of the key and take a session.
			var ch = await post('/api/auth/challenge', { pubkey: pub, alg: alg });
			var chSig = await DaimondIdentity.sign(ch.challenge);
			await post('/api/auth/verify', { challenge_id: ch.challenge_id, sig: chSig });

			state.authed = true;
			state.offline = false;
			await refreshBalance();
			await refreshLicence();
			return true;
		} catch (e) {
			// The gateway is optional: Daimond is fully usable on a BYOK key with no
			// account at all, so a gateway that is down must not break the app.
			state.authed = false;
			state.offline = true;
			return false;
		} finally {
			authing = false;
		}
	}

	/// Ask for the balance outright, and keep the recent ledger entries with it.
	///
	/// The figure and the currency are adopted by `noteBalance` inside `get`, and are NOT written
	/// again here. They used to be, and the second write was not a duplicate: `j.credits_minor ||
	/// 0` turns a reply that said nothing about money into an explicit zero balance, which is the
	/// one reading a credit figure must never invent.
	async function refreshBalance() {
		if (!state.authed) return null;
		try {
			var j = await get('/api/balance');	// `get` adopts the figure through `noteBalance`
			state.entries = j.entries || [];
		} catch (e) {
			// Unknown is a change like any other, and the row that shows this says "—" for it.
			// Without the announcement the figure was set to null here and nothing was told, so
			// the header went on showing money the app had stopped believing in until something
			// unrelated repainted it. Only on the way from a figure to none, so a gateway that
			// stays down is silent after the first failure.
			if (state.credits !== null) { state.credits = null; announce(); }
		}
		return state.credits;
	}

	/// Start a hosted Stripe Checkout for a credit pack. The gateway owns the
	/// price; we send only which pack, and it validates that against its
	/// allowlist before creating the session.
	async function buyCredits(packMinor) {
		if (!state.authed) {
			var ok = await bootstrap();
			if (!ok) throw new Error(t('gateway.acct_unreachable'));
		}
		var j = await post('/api/checkout/credits', { pack_minor: packMinor });
		if (!j.url) throw new Error(t('gateway.session_no_url'));
		window.location = j.url;
	}

	/// Put a card on file, charging nothing.
	///
	/// The same hosted Stripe page as a purchase, in `setup` mode: the card is collected and
	/// checked by Stripe and attached to a customer this account owns. No card detail ever
	/// reaches Daimond -- the gateway learns the brand and the last four digits, off the webhook,
	/// and nothing else.
	async function saveCard() {
		if (!state.authed) {
			var ok = await bootstrap();
			if (!ok) throw new Error(t('gateway.acct_unreachable'));
		}
		var j = await post('/api/card/setup', {});
		if (!j.url) throw new Error(t('gateway.card_no_url'));
		window.location = j.url;
	}

	/// Start a hosted Stripe Checkout for the one-time Pro unlock. The gateway
	/// owns the price and refuses a second purchase, so the client sends nothing
	/// but the intent to buy.
	///
	/// Through `gwFetch`, like everything else here. This was a bare `fetch` with
	/// no answer to a 401 at all, so an expired session ended the purchase where
	/// it stood: the button reported the gateway's own "No valid session.", which
	/// says nothing the buyer can act on, and its fallback line -- "The checkout
	/// session came back without a URL." -- is a sentence about a URL for a
	/// problem about a session, reached whenever the refusal arrives without a
	/// body of its own. On the one screen where being wrong costs a sale.
	///
	/// A RETRY ON A PAYMENT PATH, AND WHY IT IS SOUND. `pro_impl`
	/// (gateway/src/handlers/checkout.rs) takes the session immediately after the
	/// method check -- before the licence lookup, before Stripe is configured,
	/// long before a session is created -- so a 401 is proof that no hosted
	/// checkout exists and no money has moved. And should the two attempts ever
	/// both reach Stripe, they carry the same idempotency key over the same form,
	/// which is what makes a second attempt land on the first session rather than
	/// a second charge.
	async function buyPro() {
		if (!state.authed) {
			var ok = await bootstrap();
			if (!ok) throw new Error(t('gateway.acct_unreachable'));
		}
		var r = await gwFetch('/api/checkout/pro', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body: '{}',
		});
		var j = null; try { j = await r.json(); } catch (e) {}
		// Already held is not an error to shout about: reflect it and stop.
		if (r.status === 409) { state.pro = true; return { held: true }; }
		if (!r.ok || !j || !j.url) throw new Error((j && j.error) || t('gateway.session_no_url'));
		window.location = j.url;
		return { held: false };
	}

	/// Drop what is known about THIS account's licence dates.
	///
	/// One account's expiry date must not sit on screen under the next person's
	/// session, and a stale date is worse than none: a notice drawn from it would
	/// name a day that means nothing to whoever is looking at it. `proTermSecs`
	/// is not cleared -- five years is a fact about the product, not about
	/// whoever is signed in.
	function forgetLicenceTerm() {
		state.proExpiresTs = null;
		state.proExpired   = false;
		state.proNowTs     = null;
	}

	/// Whether this account holds Pro, asked of the gateway. Sets `state.pro`
	/// and returns it, or leaves it null when the gateway cannot be reached.
	///
	/// Pro is a FIVE-YEAR licence, not a perpetual one, so the presence of a
	/// licence record is no longer the answer: this reads `held`, which the
	/// gateway sets from the same term check the sync, storage and mail doors
	/// ask before opening. Reading `j.licence` -- as this did -- would have shown
	/// Pro for a licence the gateway had already stopped honouring, which is the
	/// worst of both: the app claims a capability every request then refuses.
	///
	/// The dates are carried through beside it, because a lapse has to be
	/// EXPLAINED and not merely obeyed. The gateway deliberately still returns
	/// the record and its expiry after the term ends, so the app can say which
	/// licence ended and when, and offer another.
	async function refreshLicence() {
		if (!state.authed) { state.pro = null; return null; }
		try {
			var j = await get('/api/licence');
			state.pro = !!(j && j.held);
			state.proExpiresTs = (j && typeof j.expires_ts === 'number' && j.expires_ts > 0)
				? j.expires_ts : null;
			state.proExpired = !!(j && j.expired);
			if (j && typeof j.term_secs === 'number') state.proTermSecs = j.term_secs;
			if (j && typeof j.now_ts    === 'number') state.proNowTs    = j.now_ts;
			if (j && typeof j.pro_price_minor === 'number') state.proPriceMinor = j.pro_price_minor;
			if (j && j.currency) state.currency = j.currency;
		} catch (e) {
			state.pro = null;
		}
		return state.pro;
	}

	/// The whole categorised credit ledger, for the spending view: every
	/// movement, newest first, each tagged with a `category` the breakdown
	/// groups by. Returns the entries array, or an empty one when there is no
	/// account or the gateway is unreachable -- the view degrades to "nothing
	/// spent here yet" rather than an error.
	async function ledger() {
		if (!state.authed) return [];
		try {
			var j = await get('/api/ledger');
			return Array.isArray(j.entries) ? j.entries : [];
		} catch (e) {
			return [];
		}
	}

	/// The account's auto-reload settings, and the card behind them.
	async function autoReload() {
		if (!state.authed) return null;
		try { return await get('/api/autoreload'); }
		catch (e) { return null; }
	}

	/// Save the standing instruction. The gateway refuses anything that cannot work -- on with no
	/// card, a budget under one top-up -- and says why, so the message is shown rather than
	/// second-guessed here.
	async function setAutoReload(s) {
		return await post('/api/autoreload', {
			enabled:              !!s.enabled,
			threshold_minor:      s.threshold_minor | 0,
			topup_minor:          s.topup_minor | 0,
			monthly_budget_minor: s.monthly_budget_minor | 0,
		});
	}

	/// Read the marker Stripe sends us back with, and clear it from the URL so a reload does not
	/// re-announce it. `buy` is a purchase; `card` is a card saved with nothing charged.
	function consumeReturn() {
		var q = new URLSearchParams(location.search);
		var buy = q.get('buy');
		var card = q.get('card');
		if (!buy && !card) return null;
		q.delete('buy'); q.delete('card');
		var url = location.pathname + (q.toString() ? '?' + q : '');
		history.replaceState({}, '', url);
		// 'credits' | 'cancel' | 'pro' | 'card:saved' | 'card:cancel'
		return buy || ('card:' + card);
	}

	/// The console role this account holds, or null if it holds none.
	///
	/// Asked once per unlock and remembered, so drawing the Home panel does not
	/// hit the network. Every failure -- offline, no session, a gateway that
	/// does not know the view -- is the same answer as "no role": the console
	/// is offered only on a definite yes, because an entry that leads to a
	/// locked door is worse than no entry at all.
	async function operatorRole() {
		if (state.role !== undefined) return state.role;
		state.role = null;
		try {
			var j = await get('/api/admin?view=whoami');
			state.role = (j && j.role) || null;
		} catch (e) { state.role = null; }
		return state.role;
	}

	/// End this device's session on the gateway.
	///
	/// Called when the app is locked or the identity forgotten. Best effort by
	/// design: a gateway that cannot be reached must not stop a person locking
	/// their own app, and the session expires on its own within the hour. But it
	/// is awaited where the caller can afford to, because the whole point is that
	/// the door is shut before the person walks away.
	async function logout() {
		state.authed = false;
		state.role   = undefined;
		var had = state.credits !== null;
		state.credits = null;
		state.pro    = null;
		forgetLicenceTerm();
		// One account's money must not sit on screen under the next person's session, and the
		// header only repaints when it is told to.
		if (had) announce();
		// A person leaving is not a session that lapsed, so the renewal above must
		// not put back what they have just ended: the standing retry is cancelled
		// and anything mid-flight is told, by the generation, to drop its result.
		reauthGen++;
		reauthWait = REAUTH_MIN_MS;
		if (reauthTimer) { clearTimeout(reauthTimer); reauthTimer = null; }
		try {
			await fetch('/api/auth/logout', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'x-daimond-api': String(CLIENT_API) },
			});
			return true;
		} catch (e) { return false; }
	}

	window.DaimondGateway = {
		bootstrap:      bootstrap,
		/// Take a session again after one was refused. Single-flight, so a file
		/// holding its own `fetch` -- sync, the Web panel, mail -- answers its own
		/// 401 through the one renewal rather than starting another.
		reauth:         reauth,
		/// One gateway request that answers its own lapsed session: renew once,
		/// retry once, and otherwise hand back the original 401. Every file that
		/// holds its own gateway call -- mail, tools, pairing, passkey, sync --
		/// goes through this rather than carrying a copy of the rule. See the
		/// note on `gwFetch` for which paths must NOT use it.
		gwFetch:        gwFetch,
		refreshBalance: refreshBalance,
		/// Read a balance out of a reply this file did not make itself — the Web panel, the mail
		/// panel and the inference mint each hold their own `fetch` wrapper, and their replies
		/// carry the balance too. There is one place that owns `state.credits`, and this is how
		/// they reach it. The mint's reply is the one that matters most: `/api/inference-key`
		/// reconciles the account before it answers, so its figure is the only one in an ordinary
		/// chat session that has actually moved. See the note at `noteBalance`.
		noteBalance:    noteBalance,
		ledger:         ledger,
		buyCredits:     buyCredits,
		buyPro:         buyPro,
		refreshLicence: refreshLicence,
		saveCard:       saveCard,
		autoReload:     autoReload,
		setAutoReload:  setAutoReload,
		consumeReturn:  consumeReturn,
		operatorRole:   operatorRole,
		logout:         logout,
		fmtMoney:       fmtMoney,
		fmtBilled:      fmtBilled,
		packs:          function () { return PACKS.slice(); },
		state:          function () { return Object.assign({}, state); },
		/// The contract version this build speaks, for a caller making its own
		/// gateway request. There is one copy of this number and it lives here.
		clientApi:      function () { return CLIENT_API; },
		/// Whether the pause tree refuses this call, and in whose name. For a
		/// caller that holds its own `fetch` and would rather show the sentence
		/// in its own panel than read it off a 423.
		spendRefusal:   spendRefusal,
	};

	guardFetch();
})();
