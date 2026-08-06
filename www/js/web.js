/* web.js — the Web panel's driver.
 *
 * `window.DaimondWeb` is the ONE interface the wasm tools call. It hides which
 * driver is attached, so the model's tools do not change when the extension
 * appears.
 *
 * There are three drivers, and the difference between them is not a detail —
 * it is the whole security model:
 *
 *   'none'   nothing open.
 *
 *   'frame'  the page is in an iframe. It can be SHOWN, never operated. A
 *            cross-origin document is opaque to us: we cannot read its DOM,
 *            cannot dispatch a click into it, cannot photograph it. That is the
 *            same-origin policy, and it is not a gap to be engineered around —
 *            it is the boundary the whole web rests on. The exception is a
 *            SAME-ORIGIN page (one we serve ourselves, or a file the agent has
 *            just written into the workspace), which is fully operable, and is
 *            how the agent tests a page it has built.
 *
 *   'ext'    Daimond Hands is installed. The page is a real tab with the user's
 *            real session, and the panel mirrors it. Everything works.
 *
 * The point that makes the whole design cohere: a page CANNOT both hide the
 * user's password from the agent and let the agent drive. Those are the same
 * capability seen from two sides. The isolation that protects the credential is
 * the isolation that blocks the automation. So the privilege has to leave the
 * page — and once it has, credential-safety must be re-established by a
 * mechanism we build and the user can audit. That mechanism is the handoff:
 * while the user is signing in, the extension sends NOTHING. Not redacted —
 * not sent.
 */
(function () {
	'use strict';

	/// What the app says. Model-facing strings -- the notes a tool call returns,
	/// which the daimon reads and acts on -- are NOT here: they stay in the
	/// language the system prompt is written in. These are the ones a person
	/// reads in the panel.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	var state = {
		driver: 'none',      // 'none' | 'frame' | 'local' | 'ext'
		url:    '',
		title:  '',
		mode:   'idle',      // 'idle' | 'user' | 'agent'
		reason: '',          // why the current page is view-only, if it is
		extId:  '',
	};

	var els = {};
	var deps = {};           // { onOpen, onClose, note } — supplied by daimond.js
	var mirrorTimer = null;
	var mirrorTick  = null;  // the running tick, so a button can ask for a picture at once
	var mirrorOn    = false; // the user has asked for the live picture
	var mirrorWhy   = '';    // '' a picture is arriving | 'wait' | 'silent' | 'refused'

	// ── The extension bridge ────────────────────────────────────────

	/// The wait ran out. This is NOT a refusal — the question may still be on
	/// screen — so it is marked, and everything that reads it treats "nobody has
	/// answered yet" differently from "they said no".
	function slowOpen() {
		var e = new Error('Daimond is asking the user to approve this site. It cannot be opened '
			+ 'until they do. Tell them what you want to do there, and try web_open '
			+ 'again once they have said yes — or read the page with web_fetch instead.');
		e.timeout = true;
		return e;
	}

	/// Ask the extension something. Resolves its reply, or rejects with a plain
	/// sentence the model can act on.
	///
	/// `limit` overrides the default bound, which is what an `open` uses: its own
	/// wait is the whole late window (see below), because the reply is worth
	/// having long after the caller has stopped waiting for it.
	function ext(cmd, extra, limit) {
		return new Promise(function (resolve, reject) {
			if (!state.extId || !window.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
				reject(new Error(NO_DRIVER));
				return;
			}
			// Opening a site the user has not approved puts a question to a HUMAN,
			// and a human may be making a cup of tea. Every call is bounded, because
			// a tool call that never returns is a model that never speaks again — it
			// simply hangs, with the user watching a spinner and no idea why.
			var done = false;
			if (!limit) limit = (cmd === 'open') ? OPEN_WAIT : 12000;
			var timer = setTimeout(function () {
				if (done) return;
				done = true;
				if (cmd === 'open') { reject(slowOpen()); return; }
				var e = new Error('Daimond Hands did not answer in time. The page may be busy; try again.');
				e.timeout = true;
				reject(e);
			}, limit);
			function settle(fn, v) {
				if (done) return;
				done = true;
				clearTimeout(timer);
				fn(v);
			}
			var msg = Object.assign({ cmd: cmd }, extra || {});
			try {
				chrome.runtime.sendMessage(state.extId, msg, function (reply) {
					// A missing extension surfaces here, not as a throw.
					if (chrome.runtime.lastError || !reply) { settle(reject, new Error(NO_DRIVER)); return; }
					if (reply.ok === false) {
						var e = new Error(reply.error || 'Daimond Hands refused that.');
						e.confirm = !!reply.confirm;
						settle(reject, e);
						return;
					}
					settle(resolve, reply);
				});
			} catch (e) { settle(reject, new Error(NO_DRIVER)); }
		});
	}

	var NO_DRIVER = 'No driver is attached, so this page can be shown but not '
		+ 'operated. Ask the user to install Daimond Hands, or use web_fetch to read it instead.';
	var NO_PAGE   = 'No page is open. Call web_open first.';
	var NOT_YOURS = 'You are not driving. The user is entering something private, '
		+ 'and Daimond is not watching. Wait for them to hand back the wheel.';

	// ── A late answer ───────────────────────────────────────────────
	//
	// The wait above is bounded so the model is never left hanging. The
	// EXTENSION, though, does not give up when we do: the grant window stays on
	// screen, the toolbar keeps the question, and when the user finally clicks
	// Allow the tab really does open and really is driven. That reply used to be
	// dropped on the floor — so a user who answered slowly watched Daimond drive
	// a real tab while the panel said the site was never approved and the model
	// was told to try again. Two things follow.
	//
	// First, the REQUEST outlives our wait: it is bounded by the whole late
	// window, and whatever it finally answers is reconciled with what the panel
	// is showing — the page is adopted, or the stale note is replaced by the real
	// refusal. Then, after the late window, we genuinely give up: the record is
	// dropped and a further reply changes nothing.
	//
	// Second, a retry while the question is still on screen ATTACHES to the
	// answer already coming rather than sending a second `open`. The extension
	// asks per request, so two requests would be two grant windows stacked on the
	// user — and the attach is what lets a retried web_open pick up the slow
	// answer as its own proper tool result.

	var OPEN_WAIT = 45000;     // what a caller waits for a human to answer
	var LATE_WAIT = 240000;    // how much longer the request is kept alive, then dropped

	/// The one `open` the extension has not answered yet.
	var liveOpen = null;       // { url, seq, settled, waiters }

	/// What the panel was last ASKED to show. A late answer may touch the panel
	/// only while this still names its page: anything newer — another site, the
	/// guide, a close — owns the panel now, and repainting over it would be the
	/// panel lying about what is on screen.
	var claim = { seq: 0, url: '' };

	/// The failed-open note now on screen, and which request left it there.
	var stale = null;          // { seq, url }

	/// A line to put above the driving note, when the panel had already given up.
	var lateLead = '';

	/// Claim the panel for a page. Returns the sequence number the caller must
	/// carry, so anything that answers later can tell whether it is still wanted.
	function claimPage(url) {
		stale    = null;
		lateLead = '';
		claim    = { seq: claim.seq + 1, url: url || '' };
		return claim.seq;
	}

	/// Has the panel moved on since this page was asked for?
	function superseded(seq, url) {
		return claim.seq !== seq && !sameTarget(claim.url, url);
	}

	/// Whether two addresses name the same page. Deliberately literal: this is
	/// about the request the panel made, not about where the site redirected to.
	function sameTarget(a, b) {
		if (!a || !b) return false;
		return norm(a) === norm(b);
		function norm(u) {
			try {
				var x = new URL(u, location.href);
				return x.origin + (x.pathname === '/' ? '' : x.pathname) + x.search;
			} catch (e) { return String(u); }
		}
	}

	/// Ask the extension to open a page, and keep the request alive past our own
	/// wait. Rejects with a marked timeout error when the human has not answered
	/// in time; the request itself carries on.
	function openViaExt(url, seq) {
		var rec = (liveOpen && !liveOpen.settled && sameTarget(liveOpen.url, url))
			? liveOpen : startLive(url);
		rec.seq = seq;                      // the newest asker owns the outcome
		return new Promise(function (resolve, reject) {
			var w = { done: false, timer: null };
			w.settle = function (ok, v) {
				if (w.done) return;
				w.done = true;
				clearTimeout(w.timer);
				if (ok) resolve(v); else reject(v);
			};
			w.timer = setTimeout(function () {
				if (w.done) return;
				w.done = true;
				reject(slowOpen());
			}, OPEN_WAIT);
			rec.waiters.push(w);
		});
	}

	function startLive(url) {
		var rec = { url: url, seq: claim.seq, settled: false, waiters: [] };
		liveOpen = rec;
		ext('open', { url: url }, OPEN_WAIT + LATE_WAIT).then(
			function (r) { settleLive(rec, true, r); },
			function (e) { settleLive(rec, false, e); });
		return rec;
	}

	/// The extension answered — or the late window closed. Anyone still waiting
	/// gets it as their own tool result; if nobody is, the panel is reconciled.
	function settleLive(rec, ok, v) {
		if (rec.settled) return;
		rec.settled = true;
		if (liveOpen === rec) liveOpen = null;
		var heard = false;
		for (var i = 0; i < rec.waiters.length; i++) {
			if (!rec.waiters[i].done) heard = true;
			rec.waiters[i].settle(ok, v);
		}
		rec.waiters = [];
		if (!heard) lateAnswer(rec, ok, v);
	}

	/// The answer came after everyone had stopped waiting.
	function lateAnswer(rec, ok, v) {
		if (superseded(rec.seq, rec.url)) return;
		// Only the note this very request left behind may be replaced. If it is
		// gone, the panel is showing something else and this is no longer its
		// business.
		if (!stale || stale.seq !== rec.seq) return;
		if (!ok) {
			// Our own giving up is not an answer; only a real refusal is.
			if (v && v.timeout) return;
			notApproved(rec.url, (v && v.message) || '', true);
			render();
			return;
		}
		showPanel();
		adoptPage(v, rec.url, t('web.approved_late', { host: esc(hostOf(rec.url)) }));
	}

	/// Take the page the extension has opened as the panel's own.
	function adoptPage(r, url, lead) {
		stale        = null;
		lateLead     = lead || '';
		state.driver = 'ext';
		state.url    = r.url || url;
		state.title  = r.title || '';
		state.mode   = r.mode || 'agent';
		state.reason = '';
		hideText();
		note('');
		startMirror();
		render();
	}

	/// The panel's word on an open that did not happen. `late` marks an answer
	/// that arrived after Daimond had stopped waiting, which is the difference
	/// between "nobody answered" and "they answered, slowly".
	function notApproved(url, msg, late) {
		note(t('web.not_approved', { host: esc(hostOf(url)) })
			+ (late ? t('web.answer_late') : '')
			+ (/not approved|declined/i.test(msg) ? t('web.approval_closed') : esc(msg)));
	}

	/// Look for the hands. They are optional, and their absence is a normal state,
	/// not an error.
	///
	/// The extension stamps its own id on <html> — the page hard-codes nothing, so
	/// a rebuilt extension with a different id still finds its way home, and the
	/// ABSENCE of the stamp is exactly how we know there is no driver.
	async function detect() {
		async function adopt(id) {
			if (!id || id === state.extId) return;
			state.extId = id;
			try { await ext('ping'); } catch (e) { state.extId = ''; }
			render();
		}
		// It may have stamped before we ran, or it may be about to.
		window.addEventListener('daimond-hands', function (e) {
			adopt(e.detail && e.detail.id);
		});
		await adopt(document.documentElement.dataset.daimondHands || '');
	}
	function hasExt() { return !!state.extId; }

	// ── Same-origin detection ───────────────────────────────────────

	/// Can we reach into this frame? Only if it is ours. Everything else is
	/// opaque, and pretending otherwise would be the one lie in the app.
	function sameOrigin(url) {
		try {
			var u = new URL(url, location.href);
			return u.origin === location.origin || u.protocol === 'blob:';
		} catch (e) { return false; }
	}

	// ── The gateway ─────────────────────────────────────────────────

	async function gw(path, body) {
		var r = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify(body),
		});
		var j = null;
		try { j = await r.json(); } catch (e) { /* not JSON */ }
		if (!r.ok) {
			throw new Error((j && j.error) || 'The web service could not reach that page.');
		}
		// Fetching a page costs credits, and the reply says what is left. One place owns that
		// number; this hands it over rather than letting the header go stale.
		if (window.DaimondGateway && DaimondGateway.noteBalance) DaimondGateway.noteBalance(j);
		return j;
	}

	// ── The interface ───────────────────────────────────────────────

	function status() {
		// `reason` says WHY a page is view-only (cross-origin, no driver, a
		// private address), so a caller need not guess from an empty `mode`.
		return { driver: state.driver, url: state.url, title: state.title,
			mode: state.mode, reason: state.reason || '' };
	}

	/// Bring the panel forward. Guarded, because the driver is loaded on pages
	/// that have no layout engine (the harness), and an open that throws before
	/// it has started is worse than one that cannot reveal itself.
	function showPanel() {
		if (!window.DaimondPanels) return;
		DaimondPanels.show('web');
		DaimondPanels.reflow();
	}

	/// Show a page. Under the extension this is a real tab with the user's real
	/// session; otherwise it is an iframe, which many sites simply refuse. We ask
	/// the gateway FIRST whether the site will frame, because a parent page
	/// cannot detect frame refusal reliably — the load event fires either way.
	async function open(url) {
		url = String(url || '').trim();
		// Whatever was shown before — a read-only text copy especially — is torn
		// down before the new page, so the panel never shows one site through
		// the remains of another.
		hideText();
		state.reason = '';   // cleared each open; set only where a page is view-only
		// A blob: URL is how a page the agent has just WRITTEN gets rendered, and it
		// is same-origin — so it is not merely allowed here, it is the one case
		// where the agent can drive the page it made. Rejecting it as "not a web
		// address" would have shut the door on the only automation that needs no
		// extension at all.
		var blob = /^blob:/i.test(url);
		// A page the agent built in the workspace is opened by its path, not a
		// URL. That is the headline local-driver case -- "drive the page you
		// made" -- and it used to be lost: `page.html` matched the bare-domain
		// rule and was rewritten to `https://page.html`, a dead cross-origin
		// frame. An HTML file path is now read from the workspace and rendered in
		// the sandboxed local driver instead.
		if (!blob && !/^https?:\/\//i.test(url) && /\.x?html?$/i.test(url) && deps.readFile) {
			var html;
			try { html = await deps.readFile(url); }
			catch (e) { throw new Error('No such page in the workspace: ' + url); }
			showPanel();
			stopMirror();
			claimPage(url);
			state.driver = 'local';
			state.url    = url;
			state.title  = url.split('/').pop();
			state.mode   = 'agent';
			els.frame.src = URL.createObjectURL(new Blob([wrap(html)], { type: 'text/html' }));
			note('');
			render();
			return {
				url: url, framed: true, driver: 'local', title: state.title, mode: 'agent',
				note: 'This page is Daimond\'s own, built in the workspace, so it can be '
					+ 'operated: snapshot it and click.',
			};
		}
		if (!blob && !/^https?:\/\//i.test(url)) {
			if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url)) url = 'https://' + url;
			else throw new Error('That is not a web address. Give a full http(s) URL.');
		}
		showPanel();
		// From here the panel is claimed for this page, and anything still
		// speaking for the last one has been superseded.
		var seq = claimPage(url);

		if (hasExt()) {
			// Opening a site the user has not approved before pops up a small
			// Daimond Hands window asking them to allow it — a separate window
			// that is easy to miss. Say it is coming, so the panel is not just a
			// blank wait while an approval window sits unnoticed behind it.
			//
			// And say what will happen AFTER they allow it, before it happens: the
			// page arrives as a browser window of its own, and a user who was not
			// told that reads it as Daimond having launched a browser instead of
			// using the panel.
			state.driver = 'ext';
			state.url    = url;
			// The last page's title and mode do not describe this one. Left as they
			// were, a site opened while the user still had the wheel on the previous
			// tab drew the blindfold over the new site's opening note — the panel
			// saying "you're driving" about a page nobody has opened yet.
			state.title  = '';
			state.mode   = 'idle';
			note(t('web.opening', { host: esc(hostOf(url)) }) + '<br>' + t('web.real_tab'));
			render();
			var r;
			try {
				r = await openViaExt(url, seq);
			} catch (e) {
				// Declined, closed, or timed out: say what to do, not just the raw
				// error. The note is stamped with this request, so a late answer can
				// tell whether it is still the one on screen.
				stale = { seq: seq, url: url };
				notApproved(url, e.message, false);
				render();
				throw e;
			}
			// The wait is long, and the user or the model may have moved on. The
			// model is still told its page is open — that is true, and the tab is
			// there — but the panel now belongs to whatever was asked for since.
			if (superseded(seq, url)) {
				return { url: r.url || url, framed: false, driver: 'ext',
					title: r.title || '', mode: r.mode || 'agent' };
			}
			adoptPage(r, url);
			return { url: state.url, framed: false, driver: 'ext', title: state.title, mode: state.mode };
		}

		// No hands. Show it if the site allows framing, and say so plainly if not.
		// Our own blob has nothing to ask the gateway about.
		var framable = true, why = '';
		try {
			if (blob) throw new Error('skip');
			var h = await gw('/api/web/head', { url: url });
			framable = !!h.framable;
			if (!framable) why = 'refuses to be shown inside another page';
		} catch (e) {
			// The gateway is optional, so a frame is tried even without it — but
			// never for a loopback or private-network address. Those are the
			// gateway's own control port and the machine's neighbours, not the
			// public web, and framing one on a failed probe once loaded them
			// straight into the panel.
			if (isPrivateHost(url)) {
				framable = false;
				why = 'is a private address Daimond will not load';
			} else {
				framable = true;
			}
		}
		stopMirror();
		var ours = sameOrigin(url);
		state.driver = ours ? 'local' : 'frame';
		state.url    = url;
		state.title  = '';
		state.mode   = ours ? 'agent' : 'idle';
		// An operable page has no reason to give; a shown-only one records why, so
		// status() can tell the user rather than leaving them to guess.
		state.reason = ours ? ''
			: 'This page is cross-origin' + (why ? ' — it ' + why : '')
				+ ', so it can be shown but not operated. Read it with web_fetch, '
				+ 'or install Daimond Hands to drive it.';
		if (ours) {
			// Our page, wrapped with the bridge and dropped into the SANDBOX. It runs
			// in an opaque origin — it cannot touch our localStorage or our OPFS —
			// and it answers us over postMessage. Isolated and operable at once.
			els.frame.src = await localPage(url);
			note('');
		} else if (framable) {
			els.frame.src = url;
			note('');
		} else {
			els.frame.removeAttribute('src');
			blocked(url);
		}
		render();
		return {
			url: url, framed: framable, driver: state.driver, title: '',
			mode: state.mode,
			// The model is told, in the tool result, exactly what it may do next.
			note: ours
				? 'This page is Daimond\'s own, so it can be operated: snapshot it and click.'
				: 'This page is cross-origin. It is SHOWN to the user, but it cannot be '
					+ 'operated from the browser. Use web_fetch to read it, or ask the user '
					+ 'to install Daimond Hands to drive it.',
		};
	}

	async function close() {
		stopMirror();
		// The live view was a choice about a page that is now gone. It survives an
		// open — see the mirror section — but not a close, which is the user
		// putting the whole thing away.
		mirrorOn  = false;
		mirrorWhy = '';
		claimPage('');           // nothing still coming may repaint this panel
		if (hasExt() && state.driver === 'ext') { try { await ext('close'); } catch (e) { /* gone */ } }
		els.frame.removeAttribute('src');
		state.driver = 'none';
		state.url = '';
		state.title = '';
		state.mode = 'idle';
		note('');
		DaimondPanels.hide('web');
		render();
		return { ok: true };
	}

	/// Show Daimond's own user guide — a real static site at `/guide`, shown here in the panel.
	///
	/// It is our own trusted page, not something the agent drives, so it needs none of the
	/// sandbox-bridge machinery an external site gets: it is loaded straight into the frame and
	/// navigates between its own pages by itself. Reachable directly at `/guide` too.
	function guide(sub, noShow) {
		stopMirror();
		claimPage('');           // the guide owns the panel now
		state.driver = 'guide';
		state.url    = 'guide/';
		state.title  = t('web.guide');
		state.mode   = 'idle';
		note('');
		els.frame.style.visibility = '';
		els.frame.src = 'guide/' + (sub || 'index.html');
		render();
		// `noShow` is set when the guide is loaded as the panel's own resting
		// content (see render), where forcing the panel open would be wrong. The
		// header "?" and an explicit request leave it unset, and do open the panel.
		if (!noShow && window.DaimondPanels) DaimondPanels.show('web');
		return { ok: true };
	}

	/// Read any page, whatever it does about framing. This goes through the
	/// gateway, so it is the one route that always works — and the one route the
	/// user must never log in through, because a page served from our origin is a
	/// page we can read.
	async function fetchPage(url) {
		var j = await gw('/api/web/fetch', { url: String(url || '').trim() });
		return {
			url: j.url, title: j.title, text: j.text, bytes: j.bytes,
			readOnly: true,
			note: 'Read through the gateway. This is a copy of the page, not a session on it — '
				+ 'do not try to sign in here.',
		};
	}

	/// The accessibility tree, with refs to act on. Never raw HTML: page text is
	/// the least trustworthy string in the application, and a model that acts on
	/// a selector it invented from page text is a model a page can steer.
	async function snapshot() {
		if (state.driver === 'none') throw new Error(NO_PAGE);
		if (state.driver === 'ext') {
			if (state.mode === 'user') throw new Error(NOT_YOURS);
			var r = await ext('snapshot');
			state.url = r.url || state.url;
			state.title = r.title || state.title;
			render();
			return { url: r.url, title: r.title, nodes: r.nodes, truncated: !!r.truncated };
		}
		if (state.driver !== 'local') throw new Error(NO_DRIVER);
		var r = await bridge('snapshot');
		state.title = r.title || '';
		return { url: state.url, title: r.title, nodes: r.nodes, truncated: !!r.truncated };
	}

	/// The rendered TEXT of the page being driven — the reliable way to READ a
	/// page (a price, a table, an article), as opposed to snapshot, which is for
	/// acting. Works on a real tab (ext) and on Daimond's own pages (local); a
	/// cross-origin page merely SHOWN can only be read through web_fetch.
	async function read() {
		if (state.driver === 'none') throw new Error(NO_PAGE);
		if (state.driver === 'ext') {
			if (state.mode === 'user') throw new Error(NOT_YOURS);
			var r = await ext('read');
			return { url: r.url, title: r.title, text: r.text, chars: r.chars, truncated: !!r.truncated };
		}
		if (state.driver !== 'local') {
			throw new Error('This page is only being shown, not driven, so its rendered '
				+ 'text is out of reach. Use web_fetch to read a cross-origin page.');
		}
		var b = await bridge('read');
		return { url: state.url, title: b.title, text: b.text, chars: b.chars, truncated: !!b.truncated };
	}

	/// A consequential action — a purchase, a send, a POST to a new origin — is
	/// put to the USER, not confirmed by the model. A prompt-injected model that
	/// could confirm its own action would have no gate at all; the whole point is
	/// that a human, not the agent, says yes. So when the extension flags an
	/// action, Daimond asks the user here and only re-issues it on their word.
	async function confirmAndRetry(cmd, args, reason) {
		var ok = false;
		if (deps.confirm) ok = await deps.confirm(reason);
		if (!ok) {
			// The model is told the human declined — it must not try again.
			throw new Error('The user was asked to confirm this and declined, so it '
				+ 'was not done. Do not retry it; move on or ask them what to do instead.');
		}
		return await ext(cmd, Object.assign({}, args, { confirmed: true }));
	}

	async function click(ref) {
		if (state.driver === 'none') throw new Error(NO_PAGE);
		if (state.driver === 'ext') {
			if (state.mode === 'user') throw new Error(NOT_YOURS);
			var r;
			try {
				r = await ext('click', { ref: ref });
			} catch (e) {
				if (e && e.confirm) r = await confirmAndRetry('click', { ref: ref }, e.message.replace(/^CONFIRM:\s*/, ''));
				else throw e;
			}
			state.url = r.url || state.url;
			render();
			return { ok: true, url: state.url };
		}
		if (state.driver !== 'local') throw new Error(NO_DRIVER);
		await bridge('click', { ref: ref });
		return { ok: true, url: state.url };
	}

	async function type(ref, text, submit) {
		if (state.driver === 'none') throw new Error(NO_PAGE);
		if (state.driver === 'ext') {
			if (state.mode === 'user') throw new Error(NOT_YOURS);
			try {
				await ext('type', { ref: ref, text: text, submit: !!submit });
			} catch (e) {
				// Typing that SUBMITS a consequential form is gated exactly as a
				// click on that form's button — and the user, not the model, decides.
				if (e && e.confirm) await confirmAndRetry('type', { ref: ref, text: text, submit: !!submit }, e.message.replace(/^CONFIRM:\s*/, ''));
				else throw e;
			}
			return { ok: true };
		}
		if (state.driver !== 'local') throw new Error(NO_DRIVER);
		await bridge('type', { ref: ref, text: text, submit: !!submit });
		return { ok: true };
	}

	/// `amount` is in SCREENS, not pixels — that is what the model's tool
	/// description promises it, and the two have to agree or it will scroll a
	/// long page six hundred pixels at a time and conclude the page is stuck.
	async function scroll(dir, amount) {
		if (state.driver === 'none') throw new Error(NO_PAGE);
		var screens = Math.max(0.1, Math.min(10, Number(amount) || 1));
		if (state.driver === 'ext') {
			if (state.mode === 'user') throw new Error(NOT_YOURS);
			await ext('scroll', { direction: dir, amount: screens });
			return { ok: true };
		}
		if (state.driver !== 'local') throw new Error(NO_DRIVER);
		await bridge('scroll', { direction: dir, amount: screens });
		return { ok: true };
	}

	// ── The local driver: isolate by sandbox, talk by postMessage ───
	//
	// The agent writes a page into the workspace and Daimond renders it, so the
	// agent can drive the page it just built and see whether it works. The naive
	// way to do that is a same-origin iframe we reach into. It is also a hole
	// straight through the app.
	//
	// A blob: URL INHERITS OUR ORIGIN. A page rendered that way, unsandboxed,
	// runs as us: it can read localStorage — where the user's API key lives — and
	// reach OPFS. And the page is written BY THE AGENT, which may itself have been
	// steered by a web page it read a moment ago. That is the whole prompt-
	// injection chain, ending in exfiltration, and it would have been our own
	// preview feature that closed it.
	//
	// So the frame keeps its sandbox and never gets `allow-same-origin`: it runs
	// in an opaque origin with no access to our storage at all. We cannot reach
	// into it — and we do not need to. We control the HTML we put in it, so we
	// wrap it with a small BRIDGE that walks its own DOM and clicks its own
	// buttons, and answers us over postMessage. Isolation and automation at once,
	// which is exactly what the cross-origin case cannot have.

	var pending = {};        // id -> {resolve, reject}
	var msgSeq  = 0;

	/// The script wrapped around a page we render, so it can be driven from
	/// outside without being trusted from inside.
	function bridgeSource() {
		return '(' + function () {
			var refs = [];
			function vis(el) {
				if (el.hidden) return false;
				var r = el.getBoundingClientRect();
				if (!r.width && !r.height) return false;
				var st = getComputedStyle(el);
				return st.visibility !== 'hidden' && st.display !== 'none';
			}
			function inter(el) { return /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName); }
			function secret(el) {
				var ty = (el.type || '').toLowerCase();
				if (ty === 'password' || ty === 'hidden') return true;
				var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
				return /^cc-|password|one-time-code/.test(ac);
			}
			function role(el) {
				var explicit = el.getAttribute('role');
				if (explicit) return explicit;
				switch (el.tagName) {
					case 'A': return 'link';
					case 'BUTTON': return 'button';
					case 'SELECT': return 'combobox';
					case 'TEXTAREA': return 'textbox';
					case 'SUMMARY': return 'summary';
					case 'LI': return 'listitem';
					case 'P': return 'text';
					case 'H1': case 'H2': case 'H3': case 'H4': return 'heading';
					case 'LABEL': return 'label';
					case 'INPUT':
						var ty = (el.type || 'text').toLowerCase();
						if (ty === 'submit' || ty === 'button') return 'button';
						if (ty === 'checkbox') return 'checkbox';
						if (ty === 'radio') return 'radio';
						if (ty === 'password') return 'password';
						return 'textbox';
				}
				return '';
			}
			function name(el) {
				var n = el.getAttribute('aria-label')
					|| (el.labels && el.labels[0] && el.labels[0].textContent)
					|| el.getAttribute('placeholder') || el.getAttribute('title')
					|| el.getAttribute('alt')
					|| (el.tagName === 'INPUT' && el.type === 'submit' ? el.value : '')
					|| el.textContent || '';
				return String(n).replace(/\s+/g, ' ').trim();
			}
			function snapshot() {
				refs = [];
				var nodes = [], CAP = 200;
				var all = document.body.querySelectorAll(
					'a[href],button,input,select,textarea,[role],h1,h2,h3,h4,li,p,label,summary');
				for (var i = 0; i < all.length && nodes.length < CAP; i++) {
					var el = all[i];
					if (!vis(el)) continue;
					var r = role(el);
					if (!r) continue;
					var nm = name(el);
					if (!nm && !inter(el)) continue;
					var ref = refs.push(el) - 1;
					var n = { ref: ref, role: r, name: nm.slice(0, 160) };
					// A password is never serialised, even here, where we are the ones
					// driving. There is no reason a model needs it.
					if (inter(el) && 'value' in el && !secret(el)) n.value = String(el.value || '').slice(0, 160);
					nodes.push(n);
				}
				return { title: document.title, nodes: nodes, truncated: all.length > CAP };
			}
			addEventListener('message', function (e) {
				var m = e.data;
				if (!m || m.dw !== 1 || !m.cmd) return;
				var out = { dw: 1, id: m.id, ok: true };
				try {
					if (m.cmd === 'snapshot') {
						var s = snapshot();
						out.title = s.title; out.nodes = s.nodes; out.truncated = s.truncated;
					} else if (m.cmd === 'read') {
						var main = document.querySelector('main, [role="main"], article') || document.body;
						var txt = (main.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
						out.title = document.title; out.chars = txt.length;
						out.truncated = txt.length > 40000;
						out.text = txt.slice(0, 40000);
					} else if (m.cmd === 'click') {
						var el = refs[m.ref];
						if (!el) throw new Error('There is no element with ref ' + m.ref
							+ '. Snapshot the page again — refs go stale when the page changes.');
						el.click();
					} else if (m.cmd === 'type') {
						var f = refs[m.ref];
						if (!f) throw new Error('There is no element with ref ' + m.ref + '. Snapshot the page again.');
						f.focus();
						f.value = m.text;
						f.dispatchEvent(new Event('input', { bubbles: true }));
						f.dispatchEvent(new Event('change', { bubbles: true }));
						if (m.submit && f.form) {
							f.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
						}
					} else if (m.cmd === 'scroll') {
						scrollBy(0, (m.direction === 'up' ? -1 : 1) * (m.amount || 1) * innerHeight * 0.9);
					} else {
						throw new Error('Unknown command.');
					}
				} catch (err) {
					out.ok = false;
					out.error = String((err && err.message) || err);
				}
				parent.postMessage(out, '*');
			});
			parent.postMessage({ dw: 1, ready: 1, title: document.title }, '*');
		} + ')()';
	}

	/// Ask the page in the frame to do something. It answers, or it refuses; it
	/// never gets to reach back out.
	function bridge(cmd, extra) {
		return new Promise(function (resolve, reject) {
			var win = els.frame.contentWindow;
			if (!win) { reject(new Error(NO_PAGE)); return; }
			var id = ++msgSeq;
			pending[id] = { resolve: resolve, reject: reject };
			win.postMessage(Object.assign({ dw: 1, id: id, cmd: cmd }, extra || {}), '*');
			setTimeout(function () {
				if (!pending[id]) return;
				delete pending[id];
				reject(new Error('The page did not answer. It may still be loading, or it '
					+ 'may be a page Daimond cannot operate — try web_fetch to read it instead.'));
			}, 5000);
		});
	}

	/// The frame's only way back to us. We ONLY listen when the frame is our own
	/// bridged page: a cross-origin site we are merely displaying gets `allow-
	/// scripts`, so it too can `postMessage` at us, and without this gate a page
	/// we promised only to SHOW could push a forged `ready` title into the
	/// model's context. The driver being `local` is the proof the frame is ours.
	/// Beyond that we check the sender is the frame, and never eval or trust a
	/// word of what it says.
	function onBridgeMessage(e) {
		if (state.driver !== 'local') return;
		if (!els.frame || e.source !== els.frame.contentWindow) return;
		var m = e.data;
		if (!m || m.dw !== 1) return;
		if (m.ready) { state.title = m.title || ''; render(); return; }
		var p = pending[m.id];
		if (!p) return;
		delete pending[m.id];
		if (m.ok === false) p.reject(new Error(m.error || 'The page refused.'));
		else p.resolve(m);
	}

	/// Wrap a page we are about to render with the bridge. The page stays exactly
	/// what the agent wrote; the bridge is appended, and it is the only script we
	/// add.
	function wrap(html) {
		var b = '<script>' + bridgeSource() + '<\/script>';
		return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, b + '</body>') : html + b;
	}

	/// A page Daimond itself is rendering — from the workspace, or from anywhere
	/// else we control. Returns a blob: URL for the SANDBOXED frame.
	async function localPage(url) {
		var r = await window.fetch(url);       // our own blob; no network
		var html = await r.text();
		return URL.createObjectURL(new Blob([wrap(html)], { type: 'text/html' }));
	}


	// ── The mirror ──────────────────────────────────────────────────
	// Under the extension the real page is a real tab. The panel can show a LIVE
	// PICTURE of that tab — but photographing a tab needs Chrome's broadest
	// permission ("all your data on all websites"), so it is strictly OPT-IN.
	// It is NEVER asked for automatically: a user who just approved one site
	// should not be hit with the scariest prompt in the browser a second later,
	// and polling for a picture we may not photograph is what turned into an
	// endless stream of permission windows. By default the tab is simply open
	// and visible — the user watches it there — and a button pulls the live view
	// into the panel if they want it.
	//
	// The answer to that button belongs to the SESSION, not to the page.
	// `mirrorOn` used to be cleared on every open, so a user who had already
	// pulled the picture in was put back to the note at the next site with no
	// word about why — and, having watched a browser window open, had every
	// reason to read that as the panel not working. Turning it off is what stops
	// the polling; opening a page is not.
	//
	// `mirrorWhy` is the other half. A panel with no picture must say WHICH kind
	// of no it is: nobody has answered yet, or this tab cannot be photographed
	// at all. Blank is the one thing it may not be.

	function startMirror() {
		stopMirror();
		// A new page has no picture yet, however the last one ended.
		mirrorWhy = mirrorOn ? 'wait' : '';
		var inFlight = false;                 // one tick at a time; never overlap
		mirrorTick  = tick;
		mirrorTimer = setInterval(tick, 1200);
		extNote();
		tick();
		/// Ask only `status` — the tab's URL and mode, nothing off the page and no
		/// permission needed. This is all we poll unless the live view is on.
		async function pollStatus() {
			try {
				var st = await ext('status');
				// Keep the broker's reason for the wheel being with the user, so the
				// blindfold can name the cause ("the sign-in page for …") rather than
				// only ever saying it stopped.
				if (st && typeof st.reason === 'string') state.reason = st.reason;
				if (st && st.mode && st.mode !== state.mode) {
					state.mode = st.mode;
					// The wheel handed back is a panel with no picture yet, whatever was
					// on screen before the user took it.
					if (mirrorOn && state.mode === 'agent') mirrorWhy = 'wait';
					render();
					extNote();
				}
				if (st && st.url) { state.url = st.url; state.title = st.title || state.title; render(); }
			} catch (e) { /* no hands; nothing to poll */ }
		}
		async function tick() {
			if (inFlight) return;             // the previous tick is still resolving
			inFlight = true;
			try {
				// Poll pictures ONLY when the user has turned the live view on and we
				// are not blindfolded. Otherwise poll status alone — no permission,
				// no popup.
				if (state.mode === 'user' || !mirrorOn) { await pollStatus(); return; }
				try {
					var r = await ext('frame');
					if (r && r.png) {
						mirrorWhy = '';
						els.mirror.src = r.png;
						els.mirror.style.display = '';
						els.frame.style.display = 'none';
						note('');
					}
					if (r && r.mode && r.mode !== state.mode) { state.mode = r.mode; render(); }
					if (r && r.url) { state.url = r.url; state.title = r.title || state.title; render(); }
				} catch (e) {
					var msg = (e && e.message) || '';
					if (/not driving/i.test(msg)) { state.mode = 'user'; render(); }
					// The mirror was declined, or Chrome will not grant it. Stop asking
					// — the button is how it is asked for again — and say why, rather
					// than leaving the last photograph up as though it were live.
					else if (/mirror|photograph/i.test(msg)) { mirrorOn = false; mirrorWhy = 'refused'; extNote(); }
					// Anything else is silence, not a refusal: the hands may be busy,
					// or gone. Nobody having answered is not the same as this being
					// impossible, and the panel has to tell the two apart — this branch
					// used to swallow the error, which left the panel blank or, worse,
					// still showing the last photograph.
					else { mirrorWhy = 'silent'; extNote(); }
				}
			} finally { inFlight = false; }
		}
	}

	/// What the panel says while the extension is driving a real tab.
	///
	/// EVERY ext state a person can see comes through here, because a browser
	/// window appearing beside a silent panel is indistinguishable from Daimond
	/// having simply launched a browser and stopped. The one state it does not
	/// own is the blindfold: there the user has the wheel, and render() speaks.
	function extNote() {
		if (state.driver !== 'ext') return;
		// Under the extension the iframe is never the page. It still holds
		// whatever it last showed — the guide, usually — and the guide under a
		// header naming a site is the panel lying about what it displays.
		els.frame.style.display = 'none';
		if (state.mode === 'user') return;
		if (mirrorOn && !mirrorWhy) return;   // a live picture is on screen
		els.mirror.style.display = 'none';
		els.note.className = 'web-note on';
		els.note.innerHTML = '';
		function line(html) {
			var d = document.createElement('div');
			d.innerHTML = html;               // built here, from our own strings
			els.note.appendChild(d);
		}
		// When the panel had already given up on this page, say so above the rest:
		// the user was last told the site was not approved, and it is.
		if (lateLead) line(lateLead);
		line(t('web.driving_tab', { host: esc(hostOf(state.url)) }));
		// The relationship, in one sentence: the window that just appeared IS the
		// page, and this panel is its mirror.
		line(t('web.real_tab'));
		if (mirrorWhy === 'wait')         line(t('web.mirror_wait'));
		else if (mirrorWhy === 'silent')  line(t('web.mirror_silent'));
		else if (mirrorWhy === 'refused') line(t('web.mirror_refused'));
		if (mirrorOn) return;                 // already asked for; the button would say nothing
		var btn = document.createElement('button');
		btn.textContent = t('web.show_live');
		btn.addEventListener('click', function () {
			// The panel says it is waiting BEFORE the ask, and asks at once rather
			// than at the next tick: the next thing the user sees may be Chrome's
			// permission window, and an empty panel behind it is what made this
			// look broken.
			mirrorOn  = true;
			mirrorWhy = 'wait';
			extNote();
			if (mirrorTick) mirrorTick();
		});
		els.note.appendChild(btn);
	}
	function stopMirror() {
		if (mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null; }
		mirrorTick = null;
		els.mirror.style.display = 'none';
		els.frame.style.display = '';
	}

	/// The panel's own control cannot take the wheel — only a trusted gesture in
	/// the tab (the Resume overlay) or the extension popup can, and this page is
	/// neither. So the button just re-checks whether the user has already resumed
	/// there, in case the 1.2s poll has not yet caught up.
	async function takeover() {
		try {
			var st = await ext('status');
			state.mode = (st && st.mode) || state.mode;
			render();
		} catch (e) { /* no hands; nothing to check */ }
	}

	// ── The panel ───────────────────────────────────────────────────

	function render() {
		if (!els.url) return;
		// An empty iframe is a blank white rectangle, which reads as a broken panel
		// rather than an idle one. Say what the panel is for instead.
		var idle = (state.driver === 'none');
		if (idle) {
			// The panel opens straight onto the guide, not a prompt to open it.
			// guide() flips the driver off 'none', so the follow-up render is not
			// idle and this does not recurse; noShow keeps a background render from
			// forcing the panel open.
			guide('index.html', true);
			return;
		}
		els.frame.style.visibility = '';
		// The header names what is on screen. Our own guide says "Guide"; an external page shows
		// its host and path; an idle panel says what the panel is FOR, rather than "No page",
		// which read as broken.
		els.url.textContent = state.driver === 'guide' ? t('web.guide')
			: state.url ? hostOf(state.url) + pathOf(state.url)
			: t('web.panel_for');
		els.url.title = state.driver === 'guide' ? t('web.guide_title') : (state.url || '');
		var m = els.mode;
		m.className = 'web-mode' + (state.mode === 'user' ? ' user' : state.mode === 'agent' ? ' agent' : '');
		m.textContent = state.mode === 'user' ? t('web.who_you')
			: state.mode === 'agent' ? t('web.who_daimond')
			: (hasExt() ? t('web.who_ready') : t('web.who_view_only'));
		m.title = state.mode === 'user'
			? t('web.who_you_help')
			: state.mode === 'agent'
				? t('web.who_daimond_help')
				: hasExt() ? t('web.who_ready_help') : t('web.who_view_only_help');
		els.blind.style.display = (state.mode === 'user') ? 'flex' : 'none';
		// Name why the wheel is with the user, when the broker told us. A specific
		// cause ("stopped at the sign-in page for …") reassures far more than the
		// generic "I'm not watching", so the title carries it whenever it is known.
		if (state.mode === 'user') {
			var bt = els.blind.querySelector('.web-blind-title');
			if (bt) bt.textContent = state.reason
				? t('web.blind_title_at', { where: state.reason })
				: t('web.blind_title');
		}
	}

	function note(html) {
		els.note.innerHTML = '';
		if (!html) { els.note.className = 'web-note'; return; }
		els.note.className = 'web-note on';
		var p = document.createElement('div');
		p.innerHTML = html;                 // built here, from our own strings
		els.note.appendChild(p);
	}

	/// A site that will not be embedded — which is MOST of them. This is not an
	/// error; it is the web's own clickjacking defence (X-Frame-Options / CSP),
	/// and it is the same in every browser. Say so plainly, and offer the three
	/// things that actually work: open it in a real tab, read its text, or — with
	/// Daimond Hands — drive it live.
	function blocked(url) {
		els.note.innerHTML = '';
		els.note.className = 'web-note on';
		var msg = document.createElement('div');
		msg.innerHTML = t('web.blocked', { host: esc(hostOf(url)) }) + ' '
			+ (hasExt() ? t('web.blocked_hands') : t('web.blocked_install'));
		els.note.appendChild(msg);

		var row = document.createElement('div');
		row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center';

		var tab = document.createElement('button');
		tab.textContent = t('web.open_new_tab');     // free, no gateway, no extension
		tab.addEventListener('click', function () { window.open(url, '_blank', 'noopener'); });
		row.appendChild(tab);

		var read = document.createElement('button');
		read.textContent = t('web.read_as_text');
		read.addEventListener('click', async function () {
			read.disabled = true;
			read.textContent = t('web.reading');
			try {
				var j = await fetchPage(url);
				note('');
				els.frame.removeAttribute('src');
				showText(j.title, j.text);
			} catch (e) {
				read.disabled = false;
				read.textContent = t('web.read_as_text');
				msg.innerHTML = t('web.read_failed', { reason: esc(e.message) });
			}
		});
		row.appendChild(read);
		els.note.appendChild(row);
	}

	/// Tear down the read-only text copy, if one is showing. A new page must
	/// never be seen through the text of the last one: the copy overlays the
	/// frame, so leaving it up made the panel show one site's words under
	/// another site's header and URL — the panel lying about what it displays.
	function hideText() {
		var pre = document.getElementById('web-text');
		if (pre) { pre.style.display = 'none'; pre.innerHTML = ''; }
		els.frame.style.display = '';
	}

	/// A page the gateway read for us, rendered as text. It is a copy, not a
	/// session — the panel says so, because a user who mistakes it for the real
	/// site might try to sign in to it.
	function showText(title, text) {
		els.mirror.style.display = 'none';
		els.frame.style.display = 'none';
		var pre = document.getElementById('web-text');
		if (!pre) {
			pre = document.createElement('div');
			pre.id = 'web-text';
			pre.className = 'web-text';
			els.body.appendChild(pre);
		}
		pre.style.display = '';
		pre.innerHTML = '';
		var badge = document.createElement('div');
		badge.className = 'web-readonly';
		badge.textContent = t('web.readonly_badge');
		var b = document.createElement('div');
		b.className = 'web-text-body';
		b.textContent = text || '';         // text, never markup
		pre.appendChild(badge);
		pre.appendChild(b);
	}

	/// Whether a URL names a loopback or private-network host — the addresses a
	/// browser can reach but the public web cannot, and so the ones the panel
	/// must not be tricked into loading. A rough check on the literal host is
	/// enough here; the gateway does the authoritative resolve-and-vet.
	function isPrivateHost(u) {
		var h;
		try { h = new URL(u).hostname.toLowerCase(); } catch (e) { return false; }
		if (h === 'localhost' || h.endsWith('.localhost')) return true;
		if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
		if (/^127\./.test(h)) return true;
		if (/^10\./.test(h)) return true;
		if (/^192\.168\./.test(h)) return true;
		if (/^169\.254\./.test(h)) return true;                 // link-local
		if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;  // 172.16–31
		return false;
	}

	function hostOf(u) { try { return new URL(u).host; } catch (e) { return u; } }
	function pathOf(u) { try { var p = new URL(u).pathname; return p === '/' ? '' : p; } catch (e) { return ''; } }
	function esc(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function init(d) {
		deps = d || {};
		els.frame  = document.getElementById('web-frame');
		els.mirror = document.getElementById('web-mirror');
		els.note   = document.getElementById('web-note');
		els.blind  = document.getElementById('web-blind');
		els.url    = document.getElementById('web-url');
		els.mode   = document.getElementById('web-mode');
		els.body   = document.getElementById('web-body');
		if (!els.frame) return;

		window.addEventListener('message', onBridgeMessage);
		document.getElementById('web-takeover').addEventListener('click', takeover);
		document.getElementById('web-reload').addEventListener('click', function () {
			if (state.url) open(state.url);
		});
		document.getElementById('web-pop').addEventListener('click', function () {
			if (state.url) window.open(state.url, '_blank', 'noopener');
		});
		document.getElementById('web-back').addEventListener('click', function () {
			// A cross-origin frame's history is not ours to walk, so this is a real
			// back only where we own the page.
			try { els.frame.contentWindow.history.back(); } catch (e) { /* not ours */ }
		});
		detect();
		render();
	}

	// The panel's header names what is on screen and who has the wheel, and it
	// stays on screen, so a language change has to redraw it where it stands.
	if (window.DaimondI18n) {
		DaimondI18n.onChange(function () { if (els.url) render(); });
	}

	window.DaimondWeb = {
		init: init,
		status: status,
		open: open,
		guide: guide,
		close: close,
		fetch: fetchPage,
		snapshot: snapshot,
		read: read,
		click: click,
		type: type,
		scroll: scroll,
		hasHands: hasExt,
		/// Test only. The late-answer rule is minutes long by design, and a test
		/// cannot spend minutes proving it; shortening the two waits changes
		/// nothing else. Same-origin callers only, and the worst a caller can do
		/// with it is make its own opens give up sooner.
		_setWaitsForTest: function (o) {
			if (o && o.open > 0) OPEN_WAIT = o.open;
			if (o && o.late > 0) LATE_WAIT = o.late;
			return { open: OPEN_WAIT, late: LATE_WAIT };
		},
	};
})();
