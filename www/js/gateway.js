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

	function fmtMoney(minor, currency) {
		var v = (minor || 0) / 100;
		try {
			return v.toLocaleString(undefined, { style: 'currency', currency: (currency || 'usd').toUpperCase() });
		} catch (e) {
			return '$' + v.toFixed(2);
		}
	}

	async function post(path, body) {
		var r = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			credentials: 'same-origin',
			body: JSON.stringify(body || {}),
		});
		probeVersion(r);
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok === false) {
			var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
			throw new Error(msg);
		}
		return j;
	}

	async function get(path) {
		var r = await fetch(path, {
			credentials: 'same-origin',
			headers: { 'x-daimond-api': String(CLIENT_API) },
		});
		probeVersion(r);
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok === false) {
			var msg = (j && (j.error || j.message)) || ('HTTP ' + r.status);
			throw new Error(msg);
		}
		return j;
	}

	/// Bind this device's public key to an account, then authenticate.
	///
	/// Both steps are signed with the device key, so this only works while the
	/// identity is unlocked — which is why it hangs off `afterUnlock()` and not
	/// off boot.
	async function bootstrap() {
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return false;
		var pub = DaimondIdentity.publicKeyB64url();
		if (!pub) return false;
		var alg = localStorage.getItem('daimond-id-alg') || 'Ed25519';

		try {
			// Register (idempotent: an existing binding is simply re-confirmed).
			var ts  = Math.floor(Date.now() / 1000);
			var sig = await DaimondIdentity.sign(ACCOUNT_MSG + pub + ':' + ts);
			// A best-effort country from the browser locale, so the operator's
			// usage map has something to shade. Omitted when nothing reliable
			// is available; the gateway stores "" for an absent or bad value.
			var body = { pubkey: pub, alg: alg, ts: ts, sig: sig };
			var cc = deriveCountry();
			if (cc) body.country = cc;
			await post('/api/account', body);

			// Prove possession of the key and take a session.
			var ch = await post('/api/auth/challenge', { pubkey: pub, alg: alg });
			var chSig = await DaimondIdentity.sign(ch.challenge);
			await post('/api/auth/verify', { challenge_id: ch.challenge_id, sig: chSig });

			state.authed = true;
			state.offline = false;
			await refreshBalance();
			return true;
		} catch (e) {
			// The gateway is optional: Daimond is fully usable on a BYOK key with no
			// account at all, so a gateway that is down must not break the app.
			state.authed = false;
			state.offline = true;
			return false;
		}
	}

	async function refreshBalance() {
		if (!state.authed) return null;
		try {
			var j = await get('/api/balance');
			state.credits  = j.credits_minor || 0;
			state.currency = j.currency || 'usd';
			state.entries  = j.entries || [];
		} catch (e) {
			state.credits = null;
		}
		return state.credits;
	}

	/// Start a hosted Stripe Checkout for a credit pack. The gateway owns the
	/// price; we send only which pack, and it validates that against its
	/// allowlist before creating the session.
	async function buyCredits(packMinor) {
		if (!state.authed) {
			var ok = await bootstrap();
			if (!ok) throw new Error('Could not reach the Daimond account service. Try again shortly.');
		}
		var j = await post('/api/checkout/credits', { pack_minor: packMinor });
		if (!j.url) throw new Error('The checkout session came back without a URL.');
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
			if (!ok) throw new Error('Could not reach the Daimond account service. Try again shortly.');
		}
		var j = await post('/api/card/setup', {});
		if (!j.url) throw new Error('The card session came back without a URL.');
		window.location = j.url;
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

	window.DaimondGateway = {
		bootstrap:      bootstrap,
		refreshBalance: refreshBalance,
		ledger:         ledger,
		buyCredits:     buyCredits,
		saveCard:       saveCard,
		autoReload:     autoReload,
		setAutoReload:  setAutoReload,
		consumeReturn:  consumeReturn,
		fmtMoney:       fmtMoney,
		packs:          function () { return PACKS.slice(); },
		state:          function () { return Object.assign({}, state); },
		/// The contract version this build speaks, for a caller making its own
		/// gateway request. There is one copy of this number and it lives here.
		clientApi:      function () { return CLIENT_API; },
	};
})();
