// Daimond Hands -- the broker.
//
// The Daimond page is the mind. This service worker is the only thing standing
// between it and a real tab holding a real session, so every rule that matters
// is enforced here, not in the page and not in the model.
//
// It owns three things:
//	the managed tab,
//	the mode state machine ('idle' | 'agent' | 'user'),
//	the per-origin grants.
//
// Nothing throws across the message boundary. Every failure comes back as
// {ok:false, error:'<plain English>'} because the model on the other side reads
// the error and acts on it.
//
// Two audiences, two languages. What the DAIMON reads -- every `error` string
// crossing the external boundary -- stays English: it is a protocol the model
// acts on, and the model has been steered by those exact words. What the USER
// reads -- the toolbar title, and the reason the wheel is with them, which the
// app prints back to them -- is translated. `i18n.js` is here for the second.

'use strict';

// hand.js is the relay to the machine hand -- the program outside the browser
// that runs commands. It is a separate file because it is a separate boundary:
// this one guards a tab, that one guards the machine. It registers its own
// long-lived port listener (output streams, and a request/response message
// cannot carry a stream) and is handed this file's grant machinery below.
importScripts('i18n.js', 'hand.js');

const VERSION = '0.1.0';

const HAND = globalThis.DaimondHand;

const I = globalThis.DaimondExtI18n;
const T = (...a) => I.t(...a);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// The canonical refusals from the Web panel contract, verbatim.
const REFUSE_PRIVATE	= 'You are not driving. The user is entering something private, and Daimond is not watching. Wait for them to hand back the wheel.';
const REFUSE_NO_PAGE	= 'No page is open. Call web_open first.';

/// Not a refusal on principle, just a capability the user has not switched on.
const MIRROR_OFF	= 'The user has not turned on the live mirror, so the tab cannot be photographed. Work from the snapshot instead. They can turn it on from the Daimond Hands icon.';

/// A click whose accessible name matches this is consequential until the user
/// says otherwise. False positives cost one question; false negatives cost money.
const CONSEQUENTIAL = /buy|pay|purchase|checkout|order|confirm|delete|remove|send|transfer|subscribe/i;

/// Origins that exist to take a credential. We never inject on these, never
/// snapshot them, and never photograph them -- the mode flips on arrival.
const SSO_HOSTS = [
	'accounts.google.com',
	'login.microsoftonline.com',
	'login.live.com',
	'appleid.apple.com',
	'signin.aws.amazon.com',
	'login.yahoo.com',
	'auth.openai.com',
	'id.atlassian.com',
];

/// Suffix match, so any tenant of these identity providers counts.
const SSO_SUFFIXES = [
	'.okta.com',
	'.oktapreview.com',
	'.auth0.com',
	'.onelogin.com',
	'.duosecurity.com',
	'.pingidentity.com',
];

/// Pages an extension may not script, whatever the user grants.
const FORBIDDEN_SCHEMES = /^(chrome|chrome-extension|edge|about|devtools|view-source|file):/i;

// ---------------------------------------------------------------------------
// State
//
// An MV3 service worker is evicted when idle, so module scope is not storage.
// chrome.storage.session lives in memory and never touches the disk, which is
// the right home for "which tab is Daimond driving".
// ---------------------------------------------------------------------------

const BLANK = {
	tabId:		null,
	windowId:	null,
	mode:		'idle',	// 'idle' | 'agent' | 'user'
	url:		'',
	title:		'',
	truce:		false,	// The user handed back with the login form still on screen.
	reason:		'',	// Why the wheel is with the user, in canonical English.
	reasonKey:	'',	// The same reason as a string key, for the user's language.
	reasonArg:	'',	// Its one substitution, where it has one.
	noMirror:	false,	// The user said no to the live mirror. Do not nag.
};

/// Canonical reason -> string key. The canonical English is what the state
/// holds and what the truce is compared against, because a comparison that
/// changed with the interface language would be a security rule with a
/// translation bug in it. The key is only what the user is SHOWN.
const REASON_KEY = {
	'a password field':			'reason_password',
	'a passkey or one-time-code prompt':	'reason_passkey_otc',
	'a passkey prompt':			'reason_passkey',
	'the user is typing':			'reason_typing',
	'something private':			'reason_private',
};

/// The state patch that hands the wheel to the user, for a canonical reason.
function because(reason) {
	return { mode: 'user', reason, reasonKey: REASON_KEY[reason] || '', reasonArg: '' };
}

/// Why the wheel is with the user, in the user's own language.
///
/// The app prints this inside a sentence of its own ("I stopped at …"), so it
/// is a noun phrase in every language, not a sentence. A reason with no key --
/// one the content script invented -- falls through as it arrived, which is
/// English but never blank.
function reasonText(s) {
	if (!s || !s.reason) return '';
	return s.reasonKey ? T(s.reasonKey, s.reasonArg || '') : s.reason;
}

/// Photographing a tab is the one thing Chrome will not do on a per-site grant:
/// captureVisibleTab wants <all_urls> or a user gesture on the tab itself. So the
/// mirror is a separate, second question, asked the first time the page wants a
/// picture -- never at install, and never bundled with a site grant.
const ALL_URLS = '<all_urls>';

/// Reads the whole state. Cheap, and always correct after an eviction.
async function get() {
	const got = await chrome.storage.session.get('s');
	return Object.assign({}, BLANK, got.s || {});
}

/// Merges a patch into the state and returns the result.
async function set(patch) {
	const s = Object.assign(await get(), patch);
	await chrome.storage.session.set({ s });
	return s;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/// The match pattern for an origin, e.g. https://example.com/*
/// Chrome ignores the port in host permissions, so this is per host, per scheme.
/// The match pattern a site's approval grants. Chrome's `*.host` form matches
/// the host AND all its subdomains, so approving `fireworks.ai` covers
/// `app.fireworks.ai` too -- which is what a user means by "this site", and
/// without which a click that crosses to the app subdomain dies for lack of
/// permission. The expansion is only ever DOWNWARD, to subdomains of what was
/// approved, never up to a parent, so there is no over-reach.
function pattern(url) {
	return `*://*.${new URL(url).hostname}/*`;
}

/// The hosts the extension holds by its own manifest: Daimond's own pages, where
/// announce.js runs and which may speak to the broker. Chrome reports them among
/// the permissions, but the user never granted them and cannot withdraw them --
/// they came with the install. Listing them under "sites you have allowed" would
/// be untrue twice over: a permission they did not give, beside a Revoke button
/// that can do nothing.
function ownHosts() {
	const m		= chrome.runtime.getManifest();
	const pats	= [].concat(
		(m.externally_connectable && m.externally_connectable.matches) || [],
		...(m.content_scripts || []).map((cs) => cs.matches || []));
	return new Set(pats.map(hostOfPattern).filter(Boolean));
}

/// The host part of a match pattern, e.g. `*://*.example.com/*` -> `example.com`.
function hostOfPattern(pat) {
	const m = /^[^:]+:\/\/(\*\.)?([^/]+)\//.exec(pat);
	return m ? m[2] : '';
}

/// Every origin the USER has approved, as match patterns.
///
/// The machine hand rides in this list too, as `machine-hand`. It is not an
/// origin and is deliberately not spelled like one, but it is a thing the user
/// allowed and must be able to take back, and the popup is where they take
/// things back. A grant that could not be found where every other grant is
/// listed would be a grant nobody remembers giving.
async function grants() {
	const all	= await chrome.permissions.getAll();
	const own	= ownHosts();
	const list	= (all.origins || []).filter((o) => !own.has(hostOfPattern(o)));
	// One line per origin that holds it, not one line for the browser. A grant
	// the user cannot see the extent of is a grant they cannot withdraw the
	// right part of.
	return list.concat(await HAND.patterns());
}

/// Has the user approved this url's origin?
async function isGranted(url) {
	try {
		// Check the EXACT host being accessed. `contains` is coverage-based, so a
		// subdomain grant (`*://*.fireworks.ai/*`) correctly answers true for the
		// exact host (`*://app.fireworks.ai/*`) it covers.
		return await chrome.permissions.contains({ origins: [`*://${new URL(url).hostname}/*`] });
	} catch (e) {
		return false;
	}
}

/// Pending grant questions, keyed by nonce.
const pending = new Map();

/// How a question ended. Not a boolean, because "the user said no" and "nobody
/// ever answered" call for different words -- to the user, and to the daimon,
/// which must stop asking after the first and may ask again after the second.
const ALLOWED	= 'allowed';
const DECLINED	= 'declined';
const DISMISSED	= 'dismissed';

/// The toolbar icon is the one surface that is always there. While a question is
/// waiting it carries a mark, so a window that landed behind something is still
/// findable -- and the popup below it says what is being asked and offers the
/// way back. This paints the mark; it never opens anything.
async function markPending() {
	const q = [...pending.values()][0];
	if (!q) {
		chrome.action.setBadgeText({ text: '' });
		chrome.action.setTitle({ title: 'Daimond Hands' });
		return;
	}
	chrome.action.setBadgeText({ text: '?' });
	chrome.action.setBadgeBackgroundColor({ color: '#2f6fed' });
	await I.ready();
	chrome.action.setTitle({
		title: q.kind === 'mirror'	? T('action_pending_mirror')
			: q.kind === 'hand'	? T('action_pending_hand')
			: T('action_pending_site', q.host),
	});
}

/// What the user is being asked, for the popup to say in its own words.
function pendingQuestion() {
	const q = [...pending.values()][0];
	return q ? { kind: q.kind, host: q.host || '' } : null;
}

/// Brings the pending question's window back to the front. The popup's way out
/// of a lost window -- and it RAISES, never creates: a second window per ask is
/// the popup flood the mirror guard exists to prevent.
async function raisePending() {
	const q = [...pending.values()][0];
	await I.ready();
	if (!q || q.windowId == null) return { ok: false, error: T('raise_none') };
	try {
		await chrome.windows.update(q.windowId, { focused: true, drawAttention: true });
		return { ok: true };
	} catch (e) {
		return { ok: false, error: T('raise_gone') };
	}
}

/// Puts the question to the user in a window of our own, and waits.
///
/// chrome.permissions.request needs a user gesture, and a message from a web
/// page is not one. So the extension asks in its own page, where a click is a
/// click. The page's `open` call simply blocks until the user has answered.
///
/// Resolves ALLOWED, DECLINED or DISMISSED.
async function ask(params) {
	const nonce	= Math.random().toString(36).slice(2);
	const q		= new URLSearchParams(Object.assign({ nonce }, params));
	const W = 480, H = 470;

	// Centre the grant window over the app window. A popup that Chrome drops
	// behind the main window, or off in a corner, is a grant no one sees -- the
	// one surface the whole flow turns on must land where the user is looking.
	let place = {};
	try {
		const cur = await chrome.windows.getLastFocused();
		if (cur && cur.width) {
			place = {
				left: Math.max(0, Math.round(cur.left + (cur.width  - W) / 2)),
				top:  Math.max(0, Math.round(cur.top  + (cur.height - H) / 2)),
			};
		}
	} catch (e) { /* fall back to Chrome's own placement */ }

	const win = await chrome.windows.create(Object.assign({
		url:		chrome.runtime.getURL(`grant.html?${q}`),
		type:		'popup',
		focused:	true,
		width:		W,
		height:		H,
	}, place));

	// `focused: true` on create is not always honoured, so raise it again and
	// flash it, making sure it comes to the front rather than hiding.
	try { await chrome.windows.update(win.id, { focused: true, drawAttention: true }); }
	catch (e) { /* best effort */ }

	return await new Promise((resolve) => {
		pending.set(nonce, { resolve, windowId: win.id, kind: params.kind || 'site', host: params.host || '' });
		markPending();
	});
}

/// May Daimond operate this site?
async function askGrant(url) {
	return await ask({ kind: 'site', host: new URL(url).hostname, pattern: pattern(url) });
}

// The relay asks the same question, through the same window, with the same
// three answers. It is handed the machinery rather than reaching for it: both
// scripts share one worker scope, so `ask` would be visible to it by accident
// of load order, and a dependency that works by accident breaks silently when
// the order changes.
HAND.wire({ ask, ALLOWED, DECLINED });

/// May Daimond photograph the tab, so the panel can mirror it?
///
/// At most ONE mirror window is ever open. The panel polls `frame` on a timer,
/// and without this guard each poll that arrived before the user answered would
/// open another window -- a popup every second or so, faster than anyone can
/// dismiss. While a request is pending, later callers share its answer.
let mirrorAsk = null;
async function askMirror() {
	if (!mirrorAsk) {
		mirrorAsk = ask({ kind: 'mirror', pattern: ALL_URLS }).finally(() => { mirrorAsk = null; });
	}
	return await mirrorAsk;
}

/// The grant window answered.
function settleGrant(nonce, answer) {
	const p = pending.get(nonce);
	if (!p) return;
	pending.delete(nonce);
	markPending();
	p.resolve(answer === ALLOWED ? ALLOWED : DECLINED);
	if (p.windowId != null) chrome.windows.remove(p.windowId).catch(() => {});
}

// The pending map lives in module scope, so an evicted service worker forgets
// every question it was waiting on -- but the toolbar mark it painted would
// outlive it. Clear it on every wake: nothing is pending in a worker that has
// just started.
markPending();

/// If the user grants something, they have plainly changed their mind about the
/// mirror, so let it be asked for again.
chrome.permissions.onAdded.addListener(() => {
	set({ noMirror: false });
});

/// A window that goes away without answering was DISMISSED, not refused. The
/// difference is the whole point: a user who never saw the question has not said
/// no, and telling the daimon they did would end an errand they still want run.
chrome.windows.onRemoved.addListener((windowId) => {
	for (const [nonce, p] of pending) {
		if (p.windowId === windowId) {
			pending.delete(nonce);
			markPending();
			p.resolve(DISMISSED);
		}
	}
});

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

/// Does the managed tab still exist?
async function alive(tabId) {
	if (tabId == null) return false;
	try {
		await chrome.tabs.get(tabId);
		return true;
	} catch (e) {
		return false;
	}
}

/// Waits for a tab to finish loading, or gives up quietly.
async function settled(tabId, ms = 10000) {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		let tab;
		try {
			tab = await chrome.tabs.get(tabId);
		} catch (e) {
			return null;
		}
		if (tab.status === 'complete') return tab;
		await sleep(80);
	}
	try {
		return await chrome.tabs.get(tabId);
	} catch (e) {
		return null;
	}
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/// Waits for what an action did.
///
/// A click on a submit button returns before the browser has even begun to
/// navigate, so asking the tab where it is straight afterwards gets the old
/// answer. This gives the page a grace period to start moving; once it has
/// started, it waits for it to arrive.
async function settledAfter(tabId, before, grace = 1200, limit = 12000) {
	const start	= Date.now();
	let moved	= false;

	while (Date.now() - start < limit) {
		let tab;
		try {
			tab = await chrome.tabs.get(tabId);
		} catch (e) {
			return null;
		}
		if (tab.status === 'loading' || (tab.url && tab.url !== before)) moved = true;
		if (moved && tab.status === 'complete' && tab.url !== before) return tab;
		if (!moved && Date.now() - start > grace) return tab;	// The click did not navigate.
		if (moved && tab.status === 'complete' && Date.now() - start > grace) return tab;
		await sleep(60);
	}
	try {
		return await chrome.tabs.get(tabId);
	} catch (e) {
		return null;
	}
}

/// Is this url an identity provider, i.e. a place a password gets typed?
function isSSO(url) {
	let h;
	try {
		h = new URL(url).hostname.toLowerCase();
	} catch (e) {
		return false;
	}
	if (SSO_HOSTS.includes(h)) return true;
	return SSO_SUFFIXES.some((sfx) => h.endsWith(sfx));
}

// ---------------------------------------------------------------------------
// The content script
// ---------------------------------------------------------------------------

/// Puts the hands on the page and arms the login detector.
///
/// Returns what the detector saw, so the caller can flip the mode *before* it
/// decides whether to answer. Returns null when the page cannot be scripted.
async function arm(tabId, truce) {
	try {
		// The isolated world survives between calls but dies on navigation,
		// which is exactly the lifetime a ref should have. Re-injecting is
		// cheap and idempotent.
		await chrome.scripting.executeScript({
			target:	{ tabId },
			world:	'MAIN',
			func:	shimWebAuthn,
		});
		await chrome.scripting.executeScript({
			target:	{ tabId },
			files:	['content.js'],
		});
		const [res] = await chrome.scripting.executeScript({
			target:	{ tabId },
			func:	(t) => globalThis.__daimond.arm(t),
			args:	[!!truce],
		});
		return res && res.result ? res.result : null;
	} catch (e) {
		return null;
	}
}

/// Takes the hands off: observers disconnected, refs dropped, listeners removed.
async function disarm(tabId) {
	try {
		await chrome.scripting.executeScript({
			target:	{ tabId },
			func:	() => globalThis.__daimond && globalThis.__daimond.detach(),
		});
	} catch (e) {
		// The page is already gone, or was never ours. Either way, detached.
	}
}

/// Runs one command in the page.
async function call(tabId, cmd, args) {
	let out;
	try {
		out = await chrome.scripting.executeScript({
			target:	{ tabId },
			func:	(c, a) => globalThis.__daimond.handle(c, a),
			args:	[cmd, args || {}],
		});
	} catch (e) {
		// executeScript rejects when the page NAVIGATES and tears down the content
		// script's context mid-call. For a click or a submit that is not a failure
		// -- it is exactly what success looks like -- so flag it for the caller to
		// interpret rather than throwing.
		return { ok: false, error: String((e && e.message) || e), contextLost: true };
	}
	const res = out && out[0];
	if (!res || res.result === undefined) {
		return { ok: false, error: 'The page did not answer. It may have navigated. Take a fresh snapshot.', contextLost: true };
	}
	return res.result;
}

/// Injected into the page's own world. Wraps the WebAuthn entry points so that
/// a passkey prompt announces itself. It reads no arguments and keeps no data:
/// it raises a DOM event and gets out of the way.
function shimWebAuthn() {
	if (window.__daimondShim) return;
	window.__daimondShim = true;
	const cred = navigator.credentials;
	if (!cred) return;
	const wrap = (name) => {
		const orig = cred[name];
		if (typeof orig !== 'function') return;
		cred[name] = function (...args) {
			try {
				document.dispatchEvent(new CustomEvent('__daimond_private', {
					detail: { reason: 'a passkey prompt' },
				}));
			} catch (e) {
				// Never break the page we are guests on.
			}
			return orig.apply(this, args);
		};
	};
	wrap('get');
	wrap('create');
}

// ---------------------------------------------------------------------------
// The mode machine
// ---------------------------------------------------------------------------

/// Brings the state up to date with the tab, and flips to 'user' if the page is
/// asking for a credential. Call this before answering anything.
///
/// Returns the fresh state.
async function sync() {
	let s = await get();
	if (!(await alive(s.tabId))) {
		return await set(Object.assign({}, BLANK));
	}

	const tab = await chrome.tabs.get(s.tabId);
	s = await set({ url: tab.url || '', title: tab.title || '', windowId: tab.windowId });

	// An identity provider is a login by definition. Do not even inject.
	if (isSSO(s.url)) {
		if (s.mode !== 'user') {
			const h = new URL(s.url).hostname;
			s = await set(Object.assign(because('the sign-in page for ' + h),
				{ reasonKey: 'reason_sso', reasonArg: h }));
			await showResumeOverlay(s.tabId);
		}
		return s;
	}

	// The user has the wheel. We do not touch the page at all.
	if (s.mode === 'user') return s;

	if (FORBIDDEN_SCHEMES.test(s.url)) return s;

	const seen = await arm(s.tabId, s.truce);
	if (seen && seen.private) {
		s = await set(because(seen.reason));
		await disarm(s.tabId);
		await showResumeOverlay(s.tabId);
	}
	return s;
}

/// The wheel goes to the user. Called by the page's own detectors and by the
/// keystroke listener. It is one-way: only an explicit takeover comes back.
async function toUser(reason) {
	const s = await get();
	if (s.mode === 'user') return;
	await set(because(reason));
	if (s.tabId != null) { await disarm(s.tabId); await showResumeOverlay(s.tabId); }
}

/// Render the "Resume Daimond" button inside the managed tab -- a trusted
/// gesture surface the web page cannot forge (it lives in a closed shadow root
/// and speaks on the internal channel). Best-effort: an SSO tab we lack
/// permission to script simply shows nothing, and the extension popup remains a
/// second, always-available way back.
async function showResumeOverlay(tabId) {
	try {
		await I.ready();
		await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
		// The label is carried in rather than looked up in the page: a content
		// script would have to be handed the whole `_locales` tree to read it
		// for itself, and the hands have no business holding the strings.
		await chrome.scripting.executeScript({
			target:	{ tabId },
			func:	(label) => globalThis.__daimond && globalThis.__daimond.handle('showResume', { label }),
			args:	[T('resume_button')],
		});
	} catch (e) { /* tab gone, or a page we may not script */ }
}
async function hideResumeOverlay(tabId) {
	try {
		await chrome.scripting.executeScript({
			target:	{ tabId },
			func:	() => globalThis.__daimond && globalThis.__daimond.handle('hideResume', {}),
		});
	} catch (e) { /* nothing to hide */ }
}

/// The wheel comes back to the agent. This is the ONLY way out of user mode,
/// and it is reachable only from a trusted surface: the in-tab resume overlay
/// or the extension popup, never the web page.
async function doTakeover() {
	const s = await get();
	if (s.tabId == null || !(await alive(s.tabId))) {
		return { ok: false, error: REFUSE_NO_PAGE };
	}
	await hideResumeOverlay(s.tabId);
	// The user has said, with a gesture of their own, that Daimond may look
	// again. Honour it even if the login form is still on the page: the truce
	// stops the detector from snatching the wheel straight back, and the
	// snapshot still refuses to serialise any password either way.
	const after = await set({ mode: 'agent', truce: true, reason: '', reasonKey: '', reasonArg: '' });
	await arm(after.tabId, true);
	return { ok: true, mode: 'agent', url: after.url, title: after.title };
}

/// The content script speaks to us here: about privacy, and about the user's
/// own gesture to resume. Both are trusted because they arrive from OUR managed
/// tab (`sender.tab.id === s.tabId`), which the web page cannot impersonate.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
	// Answer ONLY what a content script sends. The extension's own pages speak on
	// this same channel and are answered by the listener at the foot of the file;
	// Chrome hands a message to every listener and keeps the FIRST answer, so a
	// listener that answers everything steals theirs. Sorting by the shape of the
	// sender is what went wrong before: a popup has no tab, but the grant window
	// DOES -- it is a tab in a window of its own -- so one listener swallowed the
	// popup's questions and the other ignored the grant window's answer. The
	// message type says which channel a message belongs to; the sender says
	// whether it may be trusted. Both are checked, and separately.
	if (!msg || !['private', 'typing', 'resume'].includes(msg.type)) return false;
	if (!sender.tab) { respond({ ok: false }); return false; }
	(async () => {
		const s = await get();
		if (sender.tab.id !== s.tabId) { respond({ ok: false }); return; }	// Not our tab.
		if (msg && msg.type === 'private') {
			if (s.truce && msg.reason === 'a password field') { respond({ ok: true }); return; }
			await toUser(msg.reason || 'something private');
			respond({ ok: true });
		} else if (msg && msg.type === 'typing') {
			await toUser('the user is typing');
			respond({ ok: true });
		} else if (msg && msg.type === 'resume') {
			// The resume overlay lives in this tab's shadow root; a click on it is
			// a trusted gesture the page cannot make. This is a real hand-back.
			respond(await doTakeover());
		} else {
			respond({ ok: false });
		}
	})();
	return true;	// The answer may be async (resume).
});

/// A navigation ends the truce and invalidates every ref.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
	const s = await get();
	if (tabId !== s.tabId) return;
	if (info.url && info.url !== s.url) {
		await set({ url: info.url, truce: false });
	}
	if (info.status === 'complete') {
		await sync();
	}
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
	const s = await get();
	if (tabId === s.tabId) await set(Object.assign({}, BLANK));
});

// ---------------------------------------------------------------------------
// Consequence
// ---------------------------------------------------------------------------

/// Reads a click before it happens. Returns a plain-English description of what
/// makes it consequential, or null when it is ordinary.
async function consequence(d) {
	const name = (d.name || '').trim();

	if (name && CONSEQUENTIAL.test(name)) {
		const where = d.formAction ? ` It submits a form to ${originOf(d.formAction)}.` : '';
		return `Click "${name}".${where} That name suggests it spends money, sends something, or cannot be undone.`;
	}

	if (d.isSubmit && (d.formMethod || '').toLowerCase() === 'post') {
		const dest = d.formAction || d.pageUrl;
		if (!(await isGranted(dest))) {
			return `Click "${name || d.role}", which POSTs a form to ${originOf(dest)}. The user has not approved that origin.`;
		}
	}

	return null;
}

function originOf(url) {
	try {
		return new URL(url).origin;
	} catch (e) {
		return url;
	}
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

/// Every command that needs a live tab in agent mode passes through here.
async function driving() {
	const s = await sync();
	if (s.tabId == null) return { err: { ok: false, error: REFUSE_NO_PAGE } };
	if (s.mode !== 'agent') return { err: { ok: false, error: REFUSE_PRIVATE, mode: s.mode } };
	return { s };
}

const HANDLERS = {

	async ping() {
		return { ok: true, version: VERSION };
	},

	async open(msg) {
		if (!msg.url) return { ok: false, error: 'open needs a url.' };

		let url;
		try {
			url = new URL(msg.url).href;
		} catch (e) {
			return { ok: false, error: `That is not a url I can open: ${msg.url}` };
		}
		if (!/^https?:/.test(url)) {
			return { ok: false, error: 'Daimond Hands only opens http and https pages.' };
		}

		if (!(await isGranted(url))) {
			const answer = await askGrant(url);
			// Do NOT trust how the grant window closed. Chrome's own permission
			// prompt takes focus and can dismiss the window at the very instant the
			// user grants the permission -- which the window-close handler would
			// read as a decline, refusing a site the user just allowed (and then
			// "try again" works, because it really is granted now). So ask the
			// permission system itself, which is the only truth.
			//
			// The answer decides only the WORDS of the refusal, never whether it is
			// one. A decline is final and the daimon must stop asking; a window
			// closed unseen is not an answer at all, and saying otherwise would
			// abandon an errand the user still wants run.
			if (!(await isGranted(url))) {
				const host = new URL(url).hostname;
				return {
					ok:	false,
					error:	answer === DECLINED
						? `The user declined: Daimond may not operate ${host}. Do not ask for it again. Tell them what you wanted to do there, or read the page with web_fetch instead.`
						: `The approval window for ${host} was closed before it was answered, so the site is not approved. The user may not have seen it -- the Daimond Hands icon carries the question until it is answered. Ask them to allow it and try web_open again, or read the page with web_fetch instead.`,
				};
			}
		}

		let s	= await get();
		let tab	= null;

		if (await alive(s.tabId)) {
			tab = await chrome.tabs.update(s.tabId, { url, active: true });
		} else {
			const win = await chrome.windows.create({
				url,
				focused:	true,
				width:		1180,
				height:		860,
			});
			tab = win.tabs[0];
		}

		await set({ tabId: tab.id, windowId: tab.windowId, mode: 'agent', truce: false, reason: '' });
		const done = await settled(tab.id);
		s = await sync();

		return {
			ok:	true,
			tabId:	tab.id,
			url:	s.url,
			title:	s.title || (done && done.title) || '',
			mode:	s.mode,
		};
	},

	async close() {
		const s = await get();
		if (s.tabId != null && (await alive(s.tabId))) {
			try {
				await chrome.tabs.remove(s.tabId);
			} catch (e) {
				// Already gone.
			}
		}
		await set(Object.assign({}, BLANK));
		return { ok: true };
	},

	async status() {
		const s = await sync();
		await I.ready();
		return {
			ok:		true,
			url:		s.url,
			title:		s.title,
			mode:		s.mode,
			// The app prints this one back to the user, inside a sentence of its
			// own, so it is the one field of the protocol that is translated.
			reason:		s.mode === 'user' ? reasonText(s) : '',
			granted:	await grants(),
		};
	},

	async snapshot() {
		const { err, s } = await driving();
		if (err) return err;

		const res = await call(s.tabId, 'snapshot', {});
		if (!res.ok) return res;

		return {
			ok:		true,
			url:		s.url,
			title:		s.title,
			nodes:		res.nodes,
			truncated:	res.truncated,
			total:		res.total,
		};
	},

	/// The rendered text of the page Daimond is driving -- JavaScript and all,
	/// no node budget, no dependence on the site's accessibility markup.
	async read() {
		const { err, s } = await driving();
		if (err) return err;
		const res = await call(s.tabId, 'read', {});
		if (!res.ok) return res;
		return { ok: true, url: s.url, title: s.title, text: res.text, chars: res.chars, truncated: res.truncated };
	},

	async click(msg) {
		const { err, s } = await driving();
		if (err) return err;
		if (!Number.isInteger(msg.ref)) return { ok: false, error: 'click needs a ref from the last snapshot.' };

		const d = await call(s.tabId, 'describe', { ref: msg.ref });
		if (!d.ok) return d;

		if (!msg.confirmed) {
			const why = await consequence(d);
			if (why) {
				return { ok: false, error: `CONFIRM: ${why}`, confirm: true };
			}
		}

		const before	= s.url;
		const res	= await call(s.tabId, 'click', { ref: msg.ref });
		// A genuine failure is reported; a lost context is a NAVIGATION -- the
		// click worked and took the page elsewhere -- confirmed by settling.
		if (!res.ok && !res.contextLost) return res;

		const after	= await settledAfter(s.tabId, before);
		const now	= await sync();
		return { ok: true, url: (now && now.url) || (after && after.url) || before, mode: now.mode };
	},

	async type(msg) {
		const { err, s } = await driving();
		if (err) return err;
		if (!Number.isInteger(msg.ref)) return { ok: false, error: 'type needs a ref from the last snapshot.' };
		if (typeof msg.text !== 'string') return { ok: false, error: 'type needs text.' };

		// Typing with submit:true presses Enter and posts the form, which is a
		// click on that form's submit button by another name. It must pass the
		// SAME consequence gate the click handler applies, or a checkout could be
		// completed by choosing `type` instead of `click` -- the one verb the
		// gate did not cover. "Do as I mean, or nothing done" cannot have a back
		// door.
		if (msg.submit && !msg.confirmed) {
			const d = await call(s.tabId, 'describe', { ref: msg.ref });
			if (d && d.ok) {
				// Judge the submit by the BUTTON it fires, not the field it is
				// typed into: a password field is innocent, "Complete purchase" is
				// not, and pressing Enter in the former fires the latter.
				const why = await consequence({
					...d,
					name:     d.submitName || d.name,
					isSubmit: true,
				});
				if (why) return { ok: false, error: `CONFIRM: ${why}`, confirm: true };
			}
		}

		const before	= s.url;
		const res	= await call(s.tabId, 'type', { ref: msg.ref, text: msg.text, submit: !!msg.submit });
		// As with click: a submit that navigates loses the context, which is
		// success, not failure.
		if (!res.ok && !res.contextLost) return res;

		if (msg.submit) await settledAfter(s.tabId, before);
		const now = await sync();
		return { ok: true, url: (now && now.url) || before, mode: now.mode };
	},

	async scroll(msg) {
		const { err, s } = await driving();
		if (err) return err;
		return await call(s.tabId, 'scroll', {
			direction:	msg.direction || 'down',
			amount:		Number(msg.amount) || 0,
		});
	},

	async frame() {
		const { err, s } = await driving();
		if (err) return err;

		// The mirror is a second question, and it is asked here rather than at
		// install: Chrome will not photograph a tab on a per-site grant alone.
		if (!(await chrome.permissions.contains({ origins: [ALL_URLS] }))) {
			if (s.noMirror) {
				return { ok: false, error: MIRROR_OFF };
			}
			const ok = await askMirror();
			if (ok !== ALLOWED) {
				await set({ noMirror: true });
				return { ok: false, error: MIRROR_OFF };
			}
		}

		try {
			const png = await chrome.tabs.captureVisibleTab(s.windowId, { format: 'png' });
			return { ok: true, png, url: s.url, title: s.title };
		} catch (e) {
			return {
				ok:	false,
				error:	`The tab could not be photographed: ${(e && e.message) || e}. It may be minimised or behind another window. Work from the snapshot instead.`,
			};
		}
	},

	// ── The machine hand ────────────────────────────────────────────────
	//
	// Three questions, and no command among them. Running something is not a
	// message-and-answer -- output streams, and a reply that arrives once cannot
	// carry a stream -- so `exec`, `signal` and `bye` travel on the long-lived
	// port hand.js listens for, and only the STATE of the thing is asked here.
	// That keeps the two shapes honestly apart: this table is for questions with
	// one answer.

	/// What the hand is, and whether it may be used. It does not claim to know
	/// whether the host is installed: finding that out means launching it, and
	/// launching it is the capability itself.
	///
	/// All three of these are about the ORIGIN that asked, which is why each of
	/// them is handed the sender. A page asking whether it may run commands is
	/// not asking whether some other page may.
	async hand_status(msg, sender) {
		return await HAND.status(sender);
	},

	/// Ask for the grant now, rather than have a window appear the instant the
	/// page opens its port. Same window, same three answers.
	async hand_grant(msg, sender) {
		return await HAND.request(sender);
	},

	/// Give it back. Everything running stops, because a permission that let the
	/// current build finish would be a promise with an asterisk on it.
	async hand_revoke(msg, sender) {
		await HAND.revoke(HAND.allowedOrigin(sender));
		return { ok: true, granted: false };
	},

	// `takeover` is deliberately NOT here. It is the one command that must never
	// be reachable from the web page, because the page is driven by an agent the
	// page's own text may have steered, and letting it end user mode would let it
	// read a login form the user is filling in. It lives at `doTakeover`, reached
	// only from the in-tab resume overlay or the extension popup -- both trusted.
};

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

/// The page speaks to us here. externally_connectable already restricts who may
/// call; this checks it again, because the boundary is the whole product.
///
/// It says "checks it again" and now it does. Until 2026-08-02 the sentence was
/// there and the check was not: `sender` was passed to the handlers and never
/// read, so the second look at the boundary was a comment. Chrome's own list is
/// what stops a stranger today, and a re-check that is only a comment is one
/// that fails open the day that list is edited -- which is exactly what the dev
/// origins were.
chrome.runtime.onMessageExternal.addListener((msg, sender, respond) => {
	(async () => {
		try {
			if (!HAND.allowedOrigin(sender)) {
				return respond({
					ok:	false,
					error:	'Daimond Hands answers Daimond\'s own pages and no others. This message came from somewhere else.',
				});
			}
			if (!msg || typeof msg.cmd !== 'string') {
				return respond({ ok: false, error: 'Every message needs a cmd.' });
			}
			const h = HANDLERS[msg.cmd];
			if (!h) {
				return respond({ ok: false, error: `Daimond Hands does not know the command "${msg.cmd}".` });
			}
			respond(await h(msg, sender));
		} catch (e) {
			// Nothing throws across the boundary, ever.
			respond({ ok: false, error: `Daimond Hands failed: ${(e && e.message) || String(e)}` });
		}
	})();
	return true;	// The answer is async.
});

/// The popup, and the grant window, speak to us on the internal channel.
///
/// "Our own page" is decided by the sender's URL, not by whether it sits in a
/// tab. The grant window is a tab -- a popup window holding one -- so a test for
/// `!sender.tab` shut this listener out of it, and the answer the user clicked
/// never arrived: every grant settled through the window merely CLOSING, which is
/// why a decline and an unseen dismissal were once the same event. A content
/// script on a web page can never match this prefix, so nothing is loosened.
const OURS = chrome.runtime.getURL('');
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
	if (!msg || !sender.url || !sender.url.startsWith(OURS)) return false;

	(async () => {
		try {
			if (msg.type === 'grant') {
				settleGrant(msg.nonce, msg.answer);
				return respond({ ok: true });
			}
			if (msg.type === 'panel') {
				const s = await sync();
				await I.ready();
				return respond({
					ok:		true,
					version:	VERSION,
					mode:		s.mode,
					url:		s.url,
					title:		s.title,
					reason:		reasonText(s),
					granted:	await grants(),
					pending:	pendingQuestion(),
				});
			}
			if (msg.type === 'raise') {
				return respond(await raisePending());
			}
			if (msg.type === 'revoke') {
				// The machine hand is our grant, not Chrome's, so it comes back
				// a different way -- but it comes back from the same button, in
				// the same list, which is the only part the user should notice.
				// It comes back for ONE origin, because that is how it was given.
				if (HAND.ours(msg.pattern)) await HAND.revoke(HAND.originOfPattern(msg.pattern));
				else await chrome.permissions.remove({ origins: [msg.pattern] });
				return respond({ ok: true, granted: await grants() });
			}
			if (msg.type === 'takeover') {
				return respond(await doTakeover());
			}
			respond({ ok: false, error: 'unknown' });
		} catch (e) {
			respond({ ok: false, error: String((e && e.message) || e) });
		}
	})();
	return true;
});
