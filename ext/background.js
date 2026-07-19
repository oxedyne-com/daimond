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

'use strict';

const VERSION = '0.1.0';

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
	reason:		'',	// Why the wheel is with the user.
	noMirror:	false,	// The user said no to the live mirror. Do not nag.
};

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

/// Every origin the user has approved, as match patterns.
async function grants() {
	const all = await chrome.permissions.getAll();
	return all.origins || [];
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

/// Puts the question to the user in a window of our own, and waits.
///
/// chrome.permissions.request needs a user gesture, and a message from a web
/// page is not one. So the extension asks in its own page, where a click is a
/// click. The page's `open` call simply blocks until the user has answered.
async function ask(params) {
	const nonce	= Math.random().toString(36).slice(2);
	const q		= new URLSearchParams(Object.assign({ nonce }, params));
	const W = 480, H = 470;

	// Centre the grant window over the app window. A popup that Chrome drops
	// behind the main window, or off in a corner, is a grant no one sees -- the
	// one surface the whole flow turns on must land where the user is looking.
	let place = {};
	try {
		const cur = await chrome.windows.getLastFaceted();
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
		pending.set(nonce, { resolve, windowId: win.id });
	});
}

/// May Daimond operate this site?
async function askGrant(url) {
	return await ask({ kind: 'site', host: new URL(url).hostname, pattern: pattern(url) });
}

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

/// The grant window answered, or was closed.
function settleGrant(nonce, ok) {
	const p = pending.get(nonce);
	if (!p) return;
	pending.delete(nonce);
	p.resolve(ok);
	if (p.windowId != null) chrome.windows.remove(p.windowId).catch(() => {});
}

/// If the user grants something, they have plainly changed their mind about the
/// mirror, so let it be asked for again.
chrome.permissions.onAdded.addListener(() => {
	set({ noMirror: false });
});

chrome.windows.onRemoved.addListener((windowId) => {
	for (const [nonce, p] of pending) {
		if (p.windowId === windowId) {
			pending.delete(nonce);
			p.resolve(false);
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
			s = await set({ mode: 'user', reason: 'the sign-in page for ' + new URL(s.url).hostname });
			await showResumeOverlay(s.tabId);
		}
		return s;
	}

	// The user has the wheel. We do not touch the page at all.
	if (s.mode === 'user') return s;

	if (FORBIDDEN_SCHEMES.test(s.url)) return s;

	const seen = await arm(s.tabId, s.truce);
	if (seen && seen.private) {
		s = await set({ mode: 'user', reason: seen.reason });
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
	await set({ mode: 'user', reason });
	if (s.tabId != null) { await disarm(s.tabId); await showResumeOverlay(s.tabId); }
}

/// Render the "Resume Daimond" button inside the managed tab -- a trusted
/// gesture surface the web page cannot forge (it lives in a closed shadow root
/// and speaks on the internal channel). Best-effort: an SSO tab we lack
/// permission to script simply shows nothing, and the extension popup remains a
/// second, always-available way back.
async function showResumeOverlay(tabId) {
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
		await chrome.scripting.executeScript({
			target:	{ tabId },
			func:	() => globalThis.__daimond && globalThis.__daimond.handle('showResume', {}),
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
	const after = await set({ mode: 'agent', truce: true, reason: '' });
	await arm(after.tabId, true);
	return { ok: true, mode: 'agent', url: after.url, title: after.title };
}

/// The content script speaks to us here: about privacy, and about the user's
/// own gesture to resume. Both are trusted because they arrive from OUR managed
/// tab (`sender.tab.id === s.tabId`), which the web page cannot impersonate.
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
	(async () => {
		const s = await get();
		if (!sender.tab || sender.tab.id !== s.tabId) { respond({ ok: false }); return; }	// Not our tab.
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
			await askGrant(url);
			// Do NOT trust how the grant window closed. Chrome's own permission
			// prompt takes focus and can dismiss the window at the very instant the
			// user grants the permission -- which the window-close handler would
			// read as a decline, refusing a site the user just allowed (and then
			// "try again" works, because it really is granted now). So ask the
			// permission system itself, which is the only truth.
			if (!(await isGranted(url))) {
				return {
					ok:	false,
					error:	`The user has not approved ${new URL(url).hostname}. Daimond can only operate sites the user explicitly allows. Ask them, or read the page with web_fetch instead.`,
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
		return {
			ok:		true,
			url:		s.url,
			title:		s.title,
			mode:		s.mode,
			reason:		s.mode === 'user' ? s.reason : '',
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
			if (!ok) {
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
chrome.runtime.onMessageExternal.addListener((msg, sender, respond) => {
	(async () => {
		try {
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
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
	if (!msg || sender.tab) return false;	// Extension pages only.

	(async () => {
		try {
			if (msg.type === 'grant') {
				settleGrant(msg.nonce, !!msg.ok);
				return respond({ ok: true });
			}
			if (msg.type === 'panel') {
				const s = await sync();
				return respond({
					ok:		true,
					version:	VERSION,
					mode:		s.mode,
					url:		s.url,
					title:		s.title,
					reason:		s.reason,
					granted:	await grants(),
				});
			}
			if (msg.type === 'revoke') {
				await chrome.permissions.remove({ origins: [msg.pattern] });
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
