/* policy.js — which net this page is on, and what this account may do.
 *
 * The same bytes are served on production and on the testnet (DevGuide,
 * Shipping), so the page cannot know its net from anything it was built with.
 * It asks `/api/policy`, which names the net (`network`, "live" or "test") and
 * this caller's capabilities (`capabilities.runner`), beside the two trash
 * figures trash.js reads (design §R11.3, §R7).
 *
 * Loaded in the head, before the first paint, so a cached "test" swaps the
 * home-screen identity (title, icon, manifest) before iOS or the browser has
 * read the live one. One fetch per boot, shared: trash.js takes its figures
 * from `read()` rather than asking again.
 *
 * Anything but an exact "test" is live, and a capability the gateway did not
 * name is allowed, so an older gateway, a garbled answer or no answer at all
 * leaves production exactly as it was.
 */
(function () {
	'use strict';

	var ENDPOINT = '/api/policy';
	var KEY      = 'daimond-net';            // cached {network, capabilities}
	var TEST_ID  = {
		title:    'Daimond TEST',
		icon:     'assets/icons/test-180.png',
		manifest: 'app-test.webmanifest',
	};

	/// The net named by an answer: 'test' only for an exact "test".
	function parseNet(v) { return v === 'test' ? 'test' : 'live'; }

	function parseCaps(c) {
		if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
		var out = {}, k;
		for (k in c) if (Object.prototype.hasOwnProperty.call(c, k) && typeof c[k] === 'boolean') out[k] = c[k];
		return out;
	}

	function load() {
		try {
			var j = JSON.parse(localStorage.getItem(KEY) || 'null');
			if (j && typeof j === 'object') return { network: parseNet(j.network), capabilities: parseCaps(j.capabilities) };
		} catch (e) { /* unreadable cache: start from live */ }
		return { network: 'live', capabilities: null };
	}
	function save(s) {
		try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* private mode: this boot only */ }
	}

	var state = load();

	function network() { return state.network; }
	function isTest()  { return state.network === 'test'; }
	/// May this account use the capability? True when the gateway named none.
	function can(cap) {
		var c = state.capabilities;
		if (!c || !Object.prototype.hasOwnProperty.call(c, cap)) return true;
		return c[cap] === true;
	}

	// The home-screen identity. Live is never touched: index.html already
	// carries it, and leaving it alone is what keeps live unchanged.
	function setAttr(sel, attr, val) {
		try {
			var el = document.querySelector(sel);
			if (el && el.getAttribute(attr) !== val) el.setAttribute(attr, val);
		} catch (e) { /* no DOM in this environment */ }
	}
	function applyIdentity() {
		if (!isTest()) return;
		try { document.title = TEST_ID.title; } catch (e) {}
		setAttr('meta[name="apple-mobile-web-app-title"]', 'content', TEST_ID.title);
		setAttr('link[rel="apple-touch-icon"]', 'href', TEST_ID.icon);
		setAttr('link[rel="manifest"]', 'href', TEST_ID.manifest);
	}

	function announce() {
		try {
			window.dispatchEvent(new CustomEvent('daimond:policy', {
				detail: { network: state.network, capabilities: state.capabilities },
			}));
		} catch (e) { /* no events in this environment */ }
	}

	/// Ask the gateway again. Answers the parsed reply, or null when there was
	/// none, in which case the cached answer stands. Unauthenticated callers
	/// get the net's defaults; a signed-in one gets their own capabilities.
	async function refresh() {
		var j;
		try {
			// index.html loads this file in the head, long before gateway.js, whose
			// clientApi() every /api request carries; so the ask waits for the page's
			// scripts, and the cached answer stands until then.
			await scriptsRun();
			var res = await fetch(ENDPOINT, { credentials: 'same-origin', headers: { 'accept': 'application/json',
				'x-daimond-api': String(DaimondGateway.clientApi()) } });
			if (!res.ok) return null;
			j = await res.json();
		} catch (e) { return null; }		// offline, or no gateway in this build
		if (!j || j.ok !== true) return null;
		state = { network: parseNet(j.network), capabilities: parseCaps(j.capabilities) };
		save(state);
		applyIdentity();
		announce();
		return j;
	}

	/// Resolves once every script in the page has run.
	function scriptsRun() {
		return new Promise(function (done) {
			if (typeof document !== 'undefined' && document.readyState === 'loading') {
				document.addEventListener('DOMContentLoaded', function () { done(); });
			} else {
				done();
			}
		});
	}

	var _read = null;
	/// This boot's answer, fetched once and shared by every reader.
	function read() {
		if (!_read) _read = refresh();
		return _read;
	}

	window.DaimondNet = {
		network:  network,
		isTest:   isTest,
		can:      can,
		read:     read,
		refresh:  refresh,
		parseNet: parseNet,          // exposed for the dev test
	};

	applyIdentity();
	try { read(); } catch (e) { /* no fetch in this environment */ }
})();
