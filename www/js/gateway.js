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
		// The gateway ANSWERED and said no. `'beta_only'` while the beta is
		// closed, `'unavailable'` when it could not read its own gate; null
		// otherwise. Never both this and `offline`: a refusal is the opposite of
		// silence, and reporting one as the other sends somebody to look at
		// their network for a decision the server took on purpose.
		refused:  null,
		// The gateway's own English sentence behind that refusal, kept verbatim.
		// The app says the refusal in the user's language off `refused`; this is
		// what is shown when the gateway names a reason this build has never
		// heard of, so a refusal added on the server is still legible here.
		refusal:  '',
		pro:      null,     // Pro GRANTING right now? null until asked.
		proPriceMinor: null,// the monthly Pro price, from the gateway.
		// The subscription's standing, so a paused or past-due state can be shown
		// warmly rather than as a bare lapse. `proStatus` is the gateway's word --
		// 'active', 'past_due', 'paused', 'canceled' or 'none'; `proPeriodEnd` is
		// when the current paid month ends (Unix seconds, 0 when none); `proWarned`
		// says the gateway has flagged an approaching auto-pause, so the client
		// shows the notice once; `proNowTs` is the GATEWAY's clock at the moment it
		// answered, so any countdown is drawn against it and not the device's.
		proStatus:    'none',
		proPeriodEnd: null,
		proWarned:    false,
		proNowTs:     null,
		// The console role, once asked for. `undefined` means not yet asked;
		// null means asked and the answer was no. Switching account clears it,
		// because it is an answer about whoever is signed in now.
		role:     undefined,
		// This account's standing in the closed test, as the GATEWAY sees it on
		// this bootstrap. `beta` is membership and `wave` is which intake.
		//
		// Read from the server on every unlock rather than remembered here,
		// which is the whole point of them: a passcode revoked in the console
		// takes the account's status with it, so the next bootstrap says false
		// and the browser has nothing to re-arm a telemetry recorder from. A
		// membership cached on the device would be a membership that outlived
		// its own revocation.
		beta:     false,
		wave:     0,
		// Which account this device is signed in as, as the gateway names it.
		// Carried because a consent is given by an ACCOUNT and not by a device:
		// two people sharing a laptop must not inherit each other's answer, and
		// the only thing that tells them apart here is this.
		accountId: '',
	};

	/// Report one of the module's twenty events, naming an offer from its fixed
	/// table. Never throws, never waits, never changes anything -- the same three
	/// rules every `tel()` in daimond.js keeps, and the reason these two lines
	/// can be read past.
	function telemetry(name, offer) {
		try {
			var T = window.DaimondTelemetry;
			if (T) T.emit(name, T.ordinal(T.OFFERS || [], offer));
		} catch (e) { /* telemetry may never break a checkout */ }
	}

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
	var CLIENT_API = 2;		// v2: the lease moved to its own door; v1 tabs are evicted.

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

	// ── A LOCAL FAILURE IS NOT INFORMATION ABOUT THE WORLD ─────
	//
	// A tool's network call can fail two ways and they are opposite things. "The remote host
	// refused you", "that page is 404", "the API returned an error" are RESULTS: facts about the
	// world, and a model should read them and adapt. "Your user's phone went to sleep and the
	// request never left the device" is not a result at all — it is an infrastructure event, and
	// handing it to a model as though it were a fact is what makes the model apologise for the
	// platform. On iOS a home-screen PWA is put in the back/forward cache on every app switch, so
	// every in-flight request dies; the owner watched a turn come back "I can't get through to the
	// web right now to look this up", and that sentence is now a permanent assistant turn in his
	// transcript, re-sent to the model on every turn after it.
	//
	// THE DISTINCTION IS MADE HERE BECAUSE THIS IS WHERE IT IS KNOWN. A rejected `fetch` is the
	// road; a reply that arrived and said no is the remote. One line further out the two are
	// indistinguishable, and a page away they are two sentences that have to be told apart by
	// their prose — which cannot be done safely. `BROWSER_ROAD` in js/daimond.js holds `refused`,
	// for "connection refused", and the tool layer is full of sentences containing that word for
	// an entirely different reason (`refusal_line` in src/tools.rs prefixes some twenty of them).
	// A prose classifier over tool results would read a permission refusal as a dead road, retry
	// it eight times and then kill the turn. So the mark is POSITIVE and is set at the only point
	// that cannot be wrong about it.
	//
	// It rides on the error as a property AND as a sentence in front of the message. The property
	// is for JavaScript; the sentence is for the engine, because a JS `Error` crosses the wasm
	// boundary as its `message` and nothing else — the same reason `TransportErr::crossed`
	// (src/llm.rs) puts its reason in front of the error rather than beside it.

	/// The sentence that marks a request which never got an answer.
	///
	/// QUOTED VERBATIM in `src/tools.rs` as `ROAD_MARK`, and `dev/verify_toolroad.mjs` asserts the
	/// two are the same string. It is deliberately a sentence nothing else in this application
	/// says: the engine tests for it EXACTLY, not by pattern, so a phrase that happened to appear
	/// in a page's error body cannot be mistaken for one of these.
	var ROAD_MARK = 'daimond-road: the request never left this device';

	/// Mark a rejected `fetch` as a road failure, and hand back the same rejection.
	///
	/// A `TypeError` is the whole of what a page gets when a request dies before its headers —
	/// no status, no response, and a message that is the vendor's own (`Failed to fetch` in
	/// Chromium, `Load failed` in WebKit). What it is NOT is an answer, and this says so.
	function roadMark(e) {
		try {
			if (e && e.daimondRoad) return e;			// already marked; do not say it twice.
			var was = (e && e.message) ? String(e.message) : String(e);
			var out = (e instanceof Error) ? e : new Error(was);
			out.daimondRoad = true;
			out.message = ROAD_MARK + ': ' + was;
			return out;
		} catch (e2) { return e; }			// a frozen or exotic rejection: unchanged, so unmarked.
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
			return real.apply(window, arguments).catch(function (e) { throw roadMark(e); });
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
	var bootstrapping = null;		// the bootstrap in flight, if there is one.
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

	// ── A CALL THE BOOTSTRAP IS MAKING ITSELF ──────────────────
	//
	// Such a call must never answer a 401 by renewing, because the renewal it
	// would join is the one it is running inside: `reauth()` is single-flight, so
	// the call awaits `reauthing`, `reauthing` is awaiting the bootstrap, and the
	// bootstrap is awaiting the call. Nothing settles, ever.
	//
	// THE SYMPTOM THAT DEADLOCK PRODUCES, so nobody undoes this by tidying: a
	// page that has been open an hour goes completely silent. Not slow, not
	// erroring -- silent. No request leaves it and no timer fires, because every
	// panel that meets the expired session joins the same parked `reauthing` and
	// parks with it, and the standing retry in `armReauth()` is never reached to
	// arm itself. Only a reload brings the tab back. `dev/verify_gwretry.mjs`
	// hung on exactly this for two days and reported it as a closed browser.
	//
	// OWNERSHIP TRAVELS WITH THE CALL, and that is the fix. It used to be
	// answered from an `authing` boolean plus a list of paths -- true while a
	// bootstrap was running anywhere, and `/api/balance` and `/api/licence`
	// treated as its own while it was. One flag cannot describe TWO bootstraps,
	// and two is an ordinary state: `reauth()` starts one while a panel calls
	// `DaimondGateway.bootstrap()` directly (tools.js, mail.js, passcode.js all
	// do). The first to finish cleared the flag, and the second one's balance and
	// licence reads -- still in flight, still its own -- were then no longer
	// recognised as its own. They renewed, joined the promise they were inside,
	// and the tab went silent. Measured, at four milliseconds between the two.
	//
	// So `bootstrap()` is single-flight (below) and every call it makes carries
	// `own`. A flag another caller can clear is not evidence about THIS call, and
	// no future read of one can go wrong the same way.

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
	///
	/// IT DOES NOT CLEAR A SESSION SOMEBODY ELSE IS TAKING. `bootstrap()` is
	/// single-flight, so where one is already running this renewal JOINS it
	/// rather than starting another -- and that attempt has very likely set
	/// `state.authed` true already, because it does so the moment the verify
	/// returns and before its balance and licence reads. Clearing the flag on
	/// the way in would then be clearing a session that exists, on an attempt
	/// this call cannot re-run: the joiner gets `true` back and the false stands.
	/// Measured on a held balance read: `authed` false, `pro` null, the gateway
	/// serving that very session 200. It is what put `verify_redeem` at "the code
	/// was spent and the app never took the account it bought", with the whole
	/// round green in the gateway's own log.
	///
	/// So the flag is cleared only where this call is the one about to go and
	/// ask, and it is SET FROM THE ANSWER either way. A renewal that reports a
	/// session and leaves the app saying it has none is the same lie in the other
	/// direction, and the tail of a bootstrap is a wide enough window to hit.
	async function reauth() {
		if (reauthing) return await reauthing;
		// True from here would be a lie, whatever follows -- but only where there
		// is no attempt in flight whose own answer is about to say.
		if (!bootstrapping) state.authed = false;
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return false;
		var gen = reauthGen;
		reauthing = (async function () {
			var got = await bootstrap();
			if (gen !== reauthGen) { state.authed = false; return false; }	// logged out under us.
			state.authed = !!got;		// the answer, not the assumption.
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
	/// The forge's own refusal vocabulary, from the Improve-panel contract §3.1.
	///
	/// Only the two that arrive as 401 are listed, because this is asked ONLY of a
	/// 401 -- a wider list would invite the next reader to use this for something
	/// it was not measured for.
	var FORGE_401 = ['unvoiced', 'unknown'];

	/// Is this 401 the FORGE refusing a voice, rather than the gateway refusing
	/// our session?
	///
	/// Answered from the body, on a clone, so the caller still gets an unread
	/// one. Anything that does not parse, or parses without one of the two
	/// tokens, is treated as ours -- the safe direction, since the cost of
	/// renewing unnecessarily is a round trip and the cost of NOT renewing when
	/// we should is the silent refusal this whole mechanism was built to end.
	async function isForgeRefusal(r) {
		var body = null;
		try { body = await r.clone().json(); } catch (e) { return false; }
		return !!(body && typeof body.error === 'string'
			&& FORGE_401.indexOf(body.error) !== -1);
	}

	/// The one gateway request, as described above.
	///
	/// # Arguments
	/// * `path` - The gateway path, query and all.
	/// * `opts` - The `fetch` options, reused as given on the retry.
	/// * `own`  - True when `bootstrap()` is making this call ITSELF, which is
	///            the one case that must not renew. See the note above.
	async function gwFetch(path, opts, own) {
		// A paused node never reaches the network. Here as well as in the guard
		// over `fetch`, because this is the one copy of the gateway rule and a
		// reader looking for what a call does looks here.
		var stop = spendRefusal(path, opts);
		if (stop) return refusedReply(stop);
		var r = await fetch(path, opts);
		probeVersion(r);
		// A call the bootstrap is making itself cannot answer a 401 by
		// bootstrapping, and neither can a call that IS the authentication.
		// Everything else may.
		if (r.status !== 401 || own || isAuthPath(path)) return r;
		// NOT EVERY 401 IS OURS. `/api/improve` forwards a tester's VOICE to the
		// Oregami forge, which answers 401 in its own right -- `unvoiced` for a
		// missing credential, `unknown` for one it does not recognise. Renewing
		// this app's session cannot make a wrong voice right, so without this the
		// forge's refusal costs a pointless signature round trip AND SENDS THE
		// WRITE A SECOND TIME. Measured at two requests for one refused post.
		//
		// Told apart by the forge's own vocabulary rather than by the path,
		// because the token is the thing that means "this 401 was not about your
		// session" wherever it arrives from. The body is read off a CLONE: the
		// caller is handed the original and must still be able to read it.
		if (await isForgeRefusal(r)) return r;
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
	async function post(path, body, own) {
		var r = await gwFetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			credentials: 'same-origin',
			body: JSON.stringify(body || {}),
		}, own);
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok === false) {
			var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
			throw new Error(msg);
		}
		noteBalance(j);
		return j;
	}

	async function get(path, own) {
		var r = await gwFetch(path, {
			credentials: 'same-origin',
			headers: { 'x-daimond-api': String(CLIENT_API) },
		}, own);
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok === false) {
			var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
			throw new Error(msg);
		}
		noteBalance(j);
		return j;
	}

	// ── A registration the gateway REFUSED ─────────────────────
	//
	// `/api/account` can answer three ways that are not "here is your account",
	// and until this landed the client could tell none of them apart: `post()`
	// throws a bare `Error` and `bootstrap()`'s catch turned every one of them
	// into `offline: true`. So a stranger the beta had deliberately refused was
	// dropped into BYOK-only mode and told the account service could not be
	// reached -- which is untrue, unactionable, and points at their network for
	// something the server decided. The `reason` field exists precisely so the
	// browser can say which; this is the code that reads it.
	//
	// Two reasons are read by name because they are decisions rather than
	// faults, and each has a different answer:
	//
	//   `beta_only`    403 -- the beta is closed. There IS a way in: a passcode.
	//   `unavailable`  503 -- the gateway could not read its own gate, so it
	//                  minted nothing. Temporary; the answer is to ask again.
	//
	// Anything else -- a malformed body, a signature it would not take, a
	// gateway that did not answer at all -- stays `offline`, exactly as before.

	/// The registration round, with its refusal read rather than thrown away.
	///
	/// Not through `post()`, and that is the whole point: `post` reduces every
	/// failure to a message string, and the message is the one part of a refusal
	/// the app must NOT act on -- `reason` is.
	///
	/// Through `gwFetch` all the same, so the shared 401 rule still applies.
	/// `/api/account` is an auth path, so `isBootstrapOwn` answers true for it
	/// and no renewal can be re-entered from here.
	async function register(body) {
		var r = await gwFetch('/api/account', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			credentials: 'same-origin',
			body: JSON.stringify(body),
		}, true);				// the bootstrap's own, always
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (r.ok && j && j.ok !== false) {
			noteBalance(j);
			// The account's own facts, carried out rather than dropped. This
			// returned a bare `{ok:true}` and the reply's other fields died
			// here, which is why the beta wave could not reach the browser on
			// any round except the redemption itself.
			return {
				ok:      true,
				account: typeof j.account_id === 'string' ? j.account_id : '',
				beta:    j.beta === true,
				wave:    typeof j.wave === 'number' ? j.wave : 0,
			};
		}
		return {
			ok:     false,
			status: r.status,
			reason: (j && j.reason) || '',
			error:  (j && (j.error || j.message)) || ('HTTP ' + r.status),
		};
	}

	/// Whether a refusal is one the app can say something useful about.
	function isRefusal(reason) {
		return reason === 'beta_only' || reason === 'unavailable';
	}

	/// Tell the app a registration was refused, and why.
	///
	/// An event rather than a call into a panel, because what the refusal is
	/// SHOWN in is not this file's business: js/passcode.js listens for it and
	/// puts the sentence and the way past it on screen. A page with no `window`
	/// -- a test harness evaluating this file -- simply does not hear it.
	function announceRefusal() {
		try {
			window.dispatchEvent(new CustomEvent('daimond:refused', {
				detail: { reason: state.refused, error: state.refusal },
			}));
		} catch (e) { /* no window to tell */ }
	}

	/// Forget a refusal. Called wherever the answer stops being true: a
	/// registration that took, a redemption, a logout.
	function forgetRefusal() {
		state.refused = null;
		state.refusal = '';
	}

	/// Bind this device's public key to an account, then authenticate.
	///
	/// Both steps are signed with the device key, so this only works while the
	/// identity is unlocked — which is why it hangs off `afterUnlock()` and not
	/// off boot.
	///
	/// SINGLE-FLIGHT, for the same reason `reauth()` is. Five callers reach this
	/// -- daimond.js at unlock, tools.js and mail.js when a panel opens on no
	/// session, passcode.js after a redemption, and `reauth()` itself -- and two
	/// of them landing together used to run two whole registrations: two
	/// signatures, two challenges, two sessions minted for one unlock, the second
	/// quietly replacing the first. Worse, the two tails then straddled: whichever
	/// finished first said no bootstrap was running, and the other one's own
	/// balance and licence reads deadlocked the tab on the renewal they were part
	/// of. See the note above `gwFetch`. They share one attempt now.
	async function bootstrap() {
		if (bootstrapping) return await bootstrapping;
		bootstrapping = bootstrapOnce();
		try { return await bootstrapping; }
		finally { bootstrapping = null; }
	}

	/// One bootstrap, start to finish. Never called directly: `bootstrap()` is
	/// the door, and it is the thing that keeps there being only one of these.
	async function bootstrapOnce() {
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return false;
		state.role = undefined;			// a new unlock is a new question
		state.pro  = null;			// re-asked for whoever unlocked now
		// And so is the beta standing. Cleared BEFORE the round rather than
		// overwritten after it: a bootstrap that fails halfway must leave this
		// device holding no membership, not the last one it heard about.
		state.beta = false;
		state.wave = 0;
		state.accountId = '';
		forgetLicenceTerm();			// and so are its dates
		var pub = DaimondIdentity.publicKeyB64url();
		if (!pub) return false;
		var alg = localStorage.getItem('daimond-id-alg') || 'Ed25519';

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
			var reg = await register(body);
			if (!reg.ok) {
				state.authed = false;
				if (isRefusal(reg.reason)) {
					// It ANSWERED. Saying "offline" here is the defect this
					// replaces: it is not true, and it hides the one thing the
					// person can act on.
					state.offline = false;
					state.refused = reg.reason;
					state.refusal = reg.error;
					announceRefusal();
				} else {
					state.offline = true;
					forgetRefusal();
				}
				return false;
			}
			forgetRefusal();
			// This account's standing in the closed test, straight off the
			// registration reply. Read before the session is taken, because it
			// describes the account and not the session, and a `false` from a
			// gateway that answered is worth having even if the round below
			// fails.
			state.beta = reg.beta === true;
			state.wave = (typeof reg.wave === 'number' && isFinite(reg.wave) && reg.wave > 0)
				? Math.floor(reg.wave) : 0;
			state.accountId = reg.account || '';

			// Prove possession of the key and take a session.
			// `own` on every one of these: they are this bootstrap's own calls,
			// and a 401 on one of them must be handed back rather than answered
			// by re-entering the renewal this is running inside.
			var ch = await post('/api/auth/challenge', { pubkey: pub, alg: alg }, true);
			var chSig = await DaimondIdentity.sign(ch.challenge);
			await post('/api/auth/verify', { challenge_id: ch.challenge_id, sig: chSig }, true);

			state.authed = true;
			state.offline = false;
			await refreshBalance(true);
			await refreshLicence(true);
			return true;
		} catch (e) {
			// The gateway is optional: Daimond is fully usable on a BYOK key with no
			// account at all, so a gateway that is down must not break the app.
			state.authed = false;
			state.offline = true;
			// A refusal read on the LAST attempt is not evidence about this one:
			// the beta may have been opened, or this failure may be the network
			// rather than the door. Held over, it would leave the app offering a
			// passcode field against a gateway nobody has heard from.
			forgetRefusal();
			return false;
		}
	}

	// ── The one door through a closed beta ─────────────────────

	/// What a refused redemption is called, in the reader's own language.
	///
	/// FOUR ANSWERS AND NOT ONE. The gateway distinguishes a code it never
	/// issued from one already used from one that has run out, and the whole
	/// reason it bothers is that they send a person somewhere different: check
	/// what you typed, ask whoever gave you the code who else has it, ask for
	/// another. A single friendly "that did not work" would be easier to write
	/// and would throw all of that away, so nothing here softens which happened.
	///
	/// A reason this build has never heard of falls through to the gateway's own
	/// English sentence rather than to a shrug, so a refusal added on the server
	/// is still legible in an old tab.
	function redeemWords(reason, j, status) {
		switch (reason) {
			case 'unknown':   return t('beta.err_unknown');
			case 'spent':     return t('beta.err_spent');
			case 'expired':   return t('beta.err_expired');
			case 'throttled': return t('beta.err_throttled');
			default:          return (j && (j.error || j.message)) || t('beta.err_generic')
				+ ' (HTTP ' + status + ')';
		}
	}

	/// Redeem a beta passcode onto THIS device, and come out signed in.
	///
	/// Redemption IS the registration. The gateway takes the code and the same
	/// device-binding proof `/api/account` takes, and writes the account inside
	/// the one critical section that spends the code -- so a code that turns out
	/// to be spent leaves nothing behind. There is nothing to do first and
	/// nothing to do after except what an ordinary registration does, which is
	/// why this ends by calling `bootstrap()` rather than by inventing a second
	/// way to be signed in.
	///
	/// DELIBERATELY NOT THROUGH `gwFetch`, for the reasons `redeem()` in
	/// pairing.js gives about its own: this endpoint takes no session, the
	/// device making the call has none and may have no account at all, so a 401
	/// here could not be a session that lapsed and renewing could not change the
	/// answer. And a passcode is single-use -- a blanket retry on a refusal is
	/// exactly the retry that must not exist here.
	///
	/// # Arguments
	/// * `code` - What the user typed. Sent as typed: the gateway folds case and
	///   drops the grouping separators, so `A1B2-C3D4-E5F6` and `a1b2c3d4e5f6`
	///   are one code and neither has to be cleaned up here.
	///
	/// # Returns
	/// `{ created, pro, wave, handle, authed }`. `authed` is whether the session
	/// that follows was actually taken: the code is spent by then either way, so
	/// a redemption is never reported as having failed because the round after
	/// it did.
	async function redeemPasscode(code) {
		code = String(code || '').trim();
		if (!code) throw new Error(t('beta.err_enter_code'));
		if (!window.DaimondIdentity || !DaimondIdentity.exists()) {
			throw new Error(t('beta.err_no_identity'));
		}
		if (!DaimondIdentity.isUnlocked()) throw new Error(t('beta.err_locked'));
		var pub = DaimondIdentity.publicKeyB64url();
		if (!pub) throw new Error(t('beta.err_no_identity'));
		var alg = localStorage.getItem('daimond-id-alg') || 'Ed25519';
		var ts  = Math.floor(Date.now() / 1000);
		// The same string, signed the same way, by the same signer the ordinary
		// registration uses. There is one device signer in this app and this is
		// not a second one.
		var sig = await DaimondIdentity.sign(ACCOUNT_MSG + pub + ':' + ts);

		var r;
		try {
			r = await fetch('/api/passcode/redeem', {
				method:      'POST',
				credentials: 'same-origin',
				headers:     { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
				body:        JSON.stringify({ code: code, pubkey: pub, alg: alg, ts: ts, sig: sig }),
			});
		} catch (e) {
			// The request never arrived, so the code was NOT spent -- and that is
			// the part the person needs, because they hold exactly one. A message
			// about the passcode would be a claim about a credential nothing here
			// has learned anything about.
			throw new Error(t('beta.err_unreachable'));
		}
		probeVersion(r);
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok === false) {
			var reason = (j && j.reason) || '';
			var err = new Error(redeemWords(reason, j, r.status));
			// Carried so a caller can act on WHICH refusal it was rather than on
			// the sentence, which is translated and is not a contract.
			err.reason = reason;
			throw err;
		}

		// The account exists now, so whatever the gateway last refused is no
		// longer true. Cleared BEFORE the bootstrap, so the round below starts
		// from the state it would have had on a device that was never refused.
		forgetRefusal();
		var authed = await bootstrap();
		if (authed) {
			// The event `reauth()` raises for the same fact: there is a session
			// now. Sync hears it and reconciles, pairing reveals its link button.
			// A first `bootstrap()` at unlock does not raise it -- daimond.js
			// drives that path by hand -- but nothing drives this one, and a
			// device that redeemed and then never synced would be the whole
			// point of the account it just got.
			try { window.dispatchEvent(new Event('daimond:authed')); } catch (e) { /* no window */ }
		}
		return {
			created: j.created === true,
			pro:     j.pro === true,
			wave:    typeof j.wave === 'number' ? j.wave : 0,
			handle:  j.handle || '',
			authed:  authed,
			// WHOSE agreement it would be, if they say yes to the question that
			// follows this reply. An agreement is scoped to an account and not to
			// a device, so the card that asks needs the id as much as the wave.
			account: j.account_id || '',
		};
	}

	/// Ask for the balance outright, and keep the recent ledger entries with it.
	///
	/// The figure and the currency are adopted by `noteBalance` inside `get`, and are NOT written
	/// again here. They used to be, and the second write was not a duplicate: `j.credits_minor ||
	/// 0` turns a reply that said nothing about money into an explicit zero balance, which is the
	/// one reading a credit figure must never invent.
	///
	/// `own` is true only where `bootstrap()` calls this as its own last-but-one
	/// step; see the note above `gwFetch` for what that word buys.
	async function refreshBalance(own) {
		if (!state.authed) return null;
		try {
			var j = await get('/api/balance', own);	// `get` adopts the figure through `noteBalance`
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
		// Reaching for the offer, which is the signal; buying is the next one and
		// is reported on the way back from Stripe. Which offer, as a number --
		// never the amount, which is a fact about this person's money.
		telemetry('buy.open', 'credits');
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
		telemetry('buy.open', 'pro');
		window.location = j.url;
		return { held: false };
	}

	/// Drop what is known about THIS account's subscription standing.
	///
	/// One account's status must not sit on screen under the next person's
	/// session, and a stale date is worse than none: a notice drawn from it would
	/// name a day that means nothing to whoever is looking at it.
	function forgetLicenceTerm() {
		state.proStatus    = 'none';
		state.proPeriodEnd = null;
		state.proWarned    = false;
		state.proNowTs     = null;
	}

	/// Whether this account holds Pro, asked of the gateway. Sets `state.pro`
	/// and returns it, or leaves it null when the gateway cannot be reached.
	///
	/// Pro is a monthly SUBSCRIPTION, so `held` is the live answer the gateway
	/// gives from the same check the sync, storage and mail doors ask before
	/// opening -- true while the subscription grants (active, or past-due inside
	/// Stripe's grace window). The status is carried beside it, because a pause is
	/// not a lapse and has to be shown as what it is: the ethical auto-pause stops
	/// billing an idle account and resumes it the moment the account is used, so a
	/// paused subscription is drawn warmly, not as an expiry.
	///
	/// `own` as for `refreshBalance` above: set only by the bootstrap that makes
	/// this call as part of itself.
	async function refreshLicence(own) {
		if (!state.authed) { state.pro = null; return null; }
		try {
			var j = await get('/api/licence', own);
			state.pro = !!(j && j.held);
			state.proStatus = (j && typeof j.status === 'string') ? j.status : 'none';
			state.proPeriodEnd = (j && typeof j.current_period_end === 'number' && j.current_period_end > 0)
				? j.current_period_end : null;
			state.proWarned = !!(j && j.warned);
			if (j && typeof j.now_ts    === 'number') state.proNowTs    = j.now_ts;
			if (j && typeof j.pro_price_minor === 'number') state.proPriceMinor = j.pro_price_minor;
			if (j && j.currency) state.currency = j.currency;
		} catch (e) {
			state.pro = null;
		}
		return state.pro;
	}

	/// Act on this account's own subscription: cancel it at the period end, or
	/// resume a paused or cancel-pending one. Refreshes what is known after, so
	/// the app redraws from the gateway's answer rather than a guess. Returns the
	/// new status string, or throws with a message the caller can show.
	async function subscriptionAction(action) {
		if (!state.authed) throw new Error(t('gateway.acct_unreachable'));
		var r = await gwFetch('/api/subscription', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body: JSON.stringify({ action: action }),
		});
		var j = null; try { j = await r.json(); } catch (e) {}
		if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || t('gateway.session_no_url'));
		await refreshLicence(true);
		return (j && j.status) || state.proStatus;
	}
	function cancelPro() { return subscriptionAction('cancel'); }
	function resumePro() { return subscriptionAction('resume'); }

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
	///
	/// THE MEMO IS NOT WRITTEN BEFORE THE ANSWER. `state.role` was set to null on the way
	/// IN, as a placeholder, so a second caller arriving while the first ask was still in
	/// flight was answered "no role" by a request that had not come back. Home draws its
	/// console entry hidden and reveals it on that answer, and `renderHome` runs more than
	/// once around an unlock -- so whichever draw lost the race kept a hidden entry for the
	/// rest of the session while `state.role` went on to hold 'owner'. An owner then loses
	/// the console until they lock and unlock. Measured 2026-08-21: seven runs of
	/// `dev/verify_operator_button` in thirty-eight failed exactly that way, every ask
	/// answered 200.
	///
	/// A SECOND CALLER MAKES ITS OWN ASK, AND THAT IS DELIBERATE. Sharing one promise
	/// between callers was tried and reverted the same day: it is the shape the block above
	/// `reauth()` exists to forbid -- ownership travels with the call, and a promise another
	/// caller can join is not evidence about THIS call. `whoami` can meet a 401 and renew,
	/// so a joined ask can be a bootstrap's own call and a stranger's at once, which is the
	/// state that parked `reauthing` and took a tab silent for two days. One duplicate
	/// request is the cheaper mistake.
	async function operatorRole() {
		if (state.role !== undefined) return state.role;
		var got = null;
		try {
			var j = await get('/api/admin?view=whoami');
			got = (j && j.role) || null;
		} catch (e) { got = null; }
		// A lock in the middle of the ask has already cleared the memo, and the answer
		// belongs to the session that has gone, so it is not written back.
		if (state.authed) state.role = got;
		return got;
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
		// The beta standing belongs to whoever was signed in. It goes with them,
		// and so does anything recording for them: a recorder left armed across
		// a sign-out would carry the NEXT person's session under the LAST
		// person's wave.
		//
		// `withdraw()` forgets the agreement as well as stopping the recorder,
		// and that is the behaviour wanted here even though signing out is not
		// itself a withdrawal. The alternative is a second function that stops
		// without forgetting, and two near-identical ways to stop is how one of
		// them ends up being the one a later release calls. The cost is that
		// signing back in asks again; the Credits drawer carries the same
		// question with the same words, so there is somewhere to say yes.
		state.beta = false;
		state.wave = 0;
		state.accountId = '';
		try {
			if (window.DaimondTelemetry) DaimondTelemetry.withdraw();
		} catch (e) { /* no telemetry client in this build */ }
		// A refusal is an answer about the identity that was signed in. It must
		// not follow the next one onto the screen.
		forgetRefusal();
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
		/// Redeem a beta passcode onto this device and come out signed in. The
		/// screen that collects the code is js/passcode.js; the contract is
		/// here, beside the registration it IS.
		redeemPasscode: redeemPasscode,
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
		cancelPro:      cancelPro,
		resumePro:      resumePro,
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
		/// The sentence a request that never left the device is marked with, so a
		/// reader can test for it rather than quoting it a second time.
		ROAD_MARK:      ROAD_MARK,
		/// Is this rejection the road rather than an answer? Reads the mark
		/// `guardFetch` set, and never the prose.
		isRoad:         function (e) {
			if (!e) return false;
			if (e.daimondRoad) return true;
			var s = (e && e.message) ? String(e.message) : String(e);
			return s.indexOf(ROAD_MARK) === 0;
		},
	};

	guardFetch();
})();
