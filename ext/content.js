// Daimond Hands -- the hands.
//
// Injected on demand into the isolated world of the managed tab. It builds the
// accessibility snapshot, performs the actions, and watches for the moment the
// page starts asking for a credential -- at which point it takes its own hands
// off and tells the broker.
//
// Two rules govern everything below.
//
//	1. Refs, not selectors. The model acts on an opaque integer that this
//	   script alone can resolve to an element. It never sees, and never
//	   invents, a selector.
//	2. A secret is never serialised. Not redacted, not starred out: the value
//	   is simply not put in the object that crosses the boundary.
//
// The isolated world is torn down on navigation, so the ref table has exactly
// the right lifetime for free.

'use strict';

(() => {

	if (!globalThis.__daimond) {

		// -------------------------------------------------------------------
		// Refs
		// -------------------------------------------------------------------

		/// ref -> element, weakly, so a detached node does not keep the page alive.
		const byRef	= new Map();
		/// element -> ref, so an element keeps the same ref between snapshots.
		const toRef	= new WeakMap();
		let next	= 1;

		/// The stable integer for an element, minted on first sight.
		function refOf(el) {
			let r = toRef.get(el);
			if (r === undefined) {
				r = next++;
				toRef.set(el, r);
				byRef.set(r, new WeakRef(el));
			}
			return r;
		}

		/// The element for a ref, or null if it has left the page.
		function elOf(ref) {
			const w = byRef.get(ref);
			if (!w) return null;
			const el = w.deref();
			if (!el || !el.isConnected) return null;
			return el;
		}

		// -------------------------------------------------------------------
		// Secrets
		// -------------------------------------------------------------------

		/// A field whose name smells of a secret has its value withheld even when
		/// the type does not say so. Cheap, and wrong only in the safe direction.
		const SECRET_NAME = /pass|pwd|secret|token|otp|2fa|mfa|totp|cvv|cvc|csc|card|iban|sort.?code|routing|ssn|api[-_ ]?key|auth|session|nonce|csrf/i;

		/// Values that look like credentials whatever the field is called.
		function looksSecret(v) {
			if (typeof v !== 'string' || v.length < 8) return false;
			if (/^ey[A-Za-z0-9_-]{8,}\./.test(v))			return true;	// JWT
			if (/^(sk|pk|rk|ghp|gho|xox[abposr])[-_][A-Za-z0-9]{8,}/i.test(v))	return true;	// API keys
			if (/^[A-Za-z0-9_-]{24,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)) return true;	// Opaque blob
			const digits = v.replace(/[\s-]/g, '');
			if (/^\d{13,19}$/.test(digits))				return true;	// Card number
			return false;
		}

		/// Is this element a place a credential is typed?
		function isCredentialField(el) {
			if (el.tagName !== 'INPUT') return false;
			const t	= (el.getAttribute('type') || 'text').toLowerCase();
			const ac	= (el.getAttribute('autocomplete') || '').toLowerCase();
			if (t === 'password')				return true;
			if (ac.includes('current-password'))		return true;
			if (ac.includes('new-password'))		return true;
			if (ac.includes('webauthn'))			return true;
			if (ac === 'one-time-code')			return true;
			return false;
		}

		/// The value of a field, or null when it must never cross the boundary.
		/// Returns undefined when the element has no value at all.
		function valueOf(el) {
			const tag = el.tagName;
			if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
				if (el.isContentEditable) return el.textContent.trim().slice(0, 200);
				return undefined;
			}

			const t		= (el.getAttribute('type') || 'text').toLowerCase();
			const ac	= (el.getAttribute('autocomplete') || '').toLowerCase();

			if (isCredentialField(el))	return null;
			if (t === 'hidden')		return null;
			if (ac.startsWith('cc-'))	return null;

			const label = [el.name, el.id, el.getAttribute('aria-label'), el.placeholder]
				.filter(Boolean).join(' ');
			if (SECRET_NAME.test(label))	return null;

			if (t === 'checkbox' || t === 'radio') return el.checked ? 'checked' : 'unchecked';

			let v;
			if (tag === 'SELECT') {
				const opt = el.selectedOptions && el.selectedOptions[0];
				v = opt ? (opt.label || opt.value || '') : '';
			} else {
				v = el.value || '';
			}

			if (looksSecret(v))	return null;
			return v.length > 200 ? v.slice(0, 200) + '…' : v;
		}

		// -------------------------------------------------------------------
		// Roles and names
		// -------------------------------------------------------------------

		const LANDMARKS = {
			NAV:	'navigation',
			MAIN:	'main',
			HEADER:	'banner',
			FOOTER:	'contentinfo',
			ASIDE:	'complementary',
			FORM:	'form',
			SEARCH:	'search',
		};

		/// The ARIA role: the explicit one if the page gave one, else inferred.
		function roleOf(el) {
			const explicit = el.getAttribute('role');
			if (explicit) return explicit.trim().split(/\s+/)[0].toLowerCase();

			const tag = el.tagName;
			if (LANDMARKS[tag]) return LANDMARKS[tag];
			if (/^H[1-6]$/.test(tag)) return 'heading';

			switch (tag) {
				case 'A':		return el.hasAttribute('href') ? 'link' : 'generic';
				case 'BUTTON':		return 'button';
				case 'SUMMARY':		return 'button';
				case 'SELECT':		return el.multiple ? 'listbox' : 'combobox';
				case 'TEXTAREA':	return 'textbox';
				case 'IMG':		return 'img';
				case 'LI':		return 'listitem';
				case 'TABLE':		return 'table';
				case 'OPTION':		return 'option';
				case 'INPUT': {
					const t = (el.getAttribute('type') || 'text').toLowerCase();
					if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
					if (t === 'checkbox')	return 'checkbox';
					if (t === 'radio')	return 'radio';
					if (t === 'range')	return 'slider';
					if (t === 'hidden')	return 'hidden';
					if (t === 'search')	return 'searchbox';
					return 'textbox';
				}
				default:		return 'text';
			}
		}

		/// Text the user can actually see, collapsed.
		function visibleText(el) {
			return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
		}

		/// The accessible name: aria-label, then a label element, then the
		/// placeholder, then the trimmed text.
		function nameOf(el) {
			const aria = el.getAttribute('aria-label');
			if (aria && aria.trim()) return aria.trim();

			const by = el.getAttribute('aria-labelledby');
			if (by) {
				const txt = by.split(/\s+/)
					.map((id) => document.getElementById(id))
					.filter(Boolean)
					.map(visibleText)
					.join(' ')
					.trim();
				if (txt) return txt.slice(0, 200);
			}

			if (el.id) {
				const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
				if (lab) {
					const txt = visibleText(lab);
					if (txt) return txt.slice(0, 200);
				}
			}
			const wrap = el.closest && el.closest('label');
			if (wrap && wrap !== el) {
				const txt = visibleText(wrap);
				if (txt) return txt.slice(0, 200);
			}

			const ph = el.getAttribute('placeholder');
			if (ph && ph.trim()) return ph.trim();

			if (el.tagName === 'INPUT') {
				const t = (el.getAttribute('type') || 'text').toLowerCase();
				if (t === 'submit' || t === 'button' || t === 'reset') return (el.value || '').trim();
				if (t === 'hidden') return (el.getAttribute('name') || '').trim();
			}

			const alt = el.getAttribute('alt');
			if (alt && alt.trim()) return alt.trim();

			const title = el.getAttribute('title');
			if (title && title.trim()) return title.trim();

			const txt = visibleText(el);
			return txt.slice(0, 200);
		}

		// -------------------------------------------------------------------
		// The walk
		// -------------------------------------------------------------------

		const CAP		= 300;
		const SKIP_TAGS		= new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'PATH', 'LINK', 'META', 'HEAD']);
		const TEXT_TAGS		= new Set(['P', 'LI', 'TD', 'TH', 'DT', 'DD', 'SPAN', 'DIV', 'STRONG', 'EM', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION', 'SMALL', 'CODE', 'PRE', 'LABEL', 'OUTPUT', 'TIME']);
		const INTERACTIVE_ROLES	= new Set(['link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'option']);

		/// Is the element rendered at all? A display:none subtree is not worth
		/// walking, so this rejects the whole branch.
		function rendered(el) {
			const cs = getComputedStyle(el);
			if (cs.display === 'none') return false;
			if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
			return true;
		}

		/// Does the element occupy space on screen? A hidden input never does,
		/// and is still worth reporting -- without its value.
		function occupies(el) {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		}

		/// The text this element owns itself, not the text of its children.
		function ownText(el) {
			let out = '';
			for (const n of el.childNodes) {
				if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue;
			}
			return out.replace(/\s+/g, ' ').trim();
		}

		function isInteractive(el, role) {
			if (INTERACTIVE_ROLES.has(role)) return true;
			if (el.hasAttribute('onclick')) return true;
			const ti = el.getAttribute('tabindex');
			if (ti !== null && ti !== '-1') return true;
			return false;
		}

		/// Walks the document and returns the accessibility tree, flattened.
		/// The rendered TEXT of the page — what a person reads, JavaScript and all.
		///
		/// This is the antidote to the accessibility tree's two failings: it does
		/// not truncate at a node budget, and it does not depend on how well the
		/// site marks up its roles. It reads the MAIN content region (a docs page's
		/// nav and chrome are dropped), returns plain text, and so works for every
		/// model, vision or not. Snapshot is for ACTING (refs to click); this is
		/// for READING (a price, a table, an article) -- and reading a page should
		/// never cost twenty-five rounds of scroll-and-hope.
		function readText() {
			const CHARS = 40000;
			// Prefer the main content; fall back to the body. `innerText` gives the
			// visually rendered text (respecting display:none and, for tables,
			// tab/newline-separating cells), which is exactly the reading order.
			const main = document.querySelector('main, [role="main"], article')
				|| document.body || document.documentElement;
			let text = (main.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
			const full = text.length;
			let truncated = false;
			if (text.length > CHARS) { text = text.slice(0, CHARS); truncated = true; }
			return {
				ok:		true,
				url:		location.href,
				title:		document.title,
				text,
				chars:		full,
				truncated,
			};
		}

		function snapshot() {
			const nodes	= [];
			let truncated	= false;
			let total	= 0;

			// Content first. A docs page or an app puts a huge navigation sidebar
			// and header in the tree, and walked top-to-bottom they eat the whole
			// node budget before the actual content -- which is how a pricing table
			// stayed invisible for twenty-five rounds. When the page marks a main
			// region, the chrome (nav, header, footer, sidebar) is dropped so the
			// budget lands on what the model came to read or act on. Where there is
			// no main region, nothing is dropped.
			const root = document.querySelector('main, [role="main"]');
			const hasMain = !!root;
			const CHROME = 'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"]';

			const walker = document.createTreeWalker(
				root || document.body || document.documentElement,
				NodeFilter.SHOW_ELEMENT,
				{
					acceptNode(el) {
						if (SKIP_TAGS.has(el.tagName))			return NodeFilter.FILTER_REJECT;
						if (el.getAttribute('aria-hidden') === 'true')	return NodeFilter.FILTER_REJECT;
						// Drop the page chrome so the content is not starved -- but
						// only when we are walking the whole body (no main region);
						// inside a main region there is no chrome to drop.
						if (!hasMain && el.matches && el.matches(CHROME))	return NodeFilter.FILTER_REJECT;
						if (el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') {
							return NodeFilter.FILTER_ACCEPT;
						}
						if (!rendered(el))				return NodeFilter.FILTER_REJECT;
						return NodeFilter.FILTER_ACCEPT;
					},
				}
			);

			for (let el = walker.nextNode(); el; el = walker.nextNode()) {

				const role	= roleOf(el);
				const hidden	= role === 'hidden';
				const inter	= isInteractive(el, role);
				const landmark	= Object.values(LANDMARKS).includes(role) && el.tagName in LANDMARKS;
				const heading	= role === 'heading';

				let keep = false;
				if (hidden)					keep = true;
				else if (!occupies(el))				keep = false;
				else if (inter || heading || landmark)		keep = true;
				else if (TEXT_TAGS.has(el.tagName)) {
					const t = ownText(el);
					keep = t.length >= 2 && t.length <= 400;
				}

				if (!keep) continue;

				total++;
				if (nodes.length >= CAP) {
					truncated = true;
					continue;
				}

				const node = {
					ref:	refOf(el),
					role,
					name:	nameOf(el),
				};

				const v = valueOf(el);
				if (v === null) {
					// A secret. The node exists, so the model can act on it;
					// the value does not, so the model can never read it.
					node.redacted = true;
				} else if (v !== undefined) {
					node.value = v;
				}

				if (el.disabled) node.disabled = true;

				nodes.push(node);
			}

			return { ok: true, nodes, truncated, total };
		}

		// -------------------------------------------------------------------
		// Actions
		// -------------------------------------------------------------------

		/// Describes a click target so the broker can judge whether it is
		/// consequential. The judgement lives in the broker, which knows the
		/// grants; the facts live here, which knows the DOM.
		function describe(ref) {
			const el = elOf(ref);
			if (!el) return gone(ref);

			const tag	= el.tagName.toLowerCase();
			const type	= (el.getAttribute('type') || '').toLowerCase();
			const form	= el.form || (el.closest && el.closest('form'));

			const isSubmit	= !!form && (
				(tag === 'button' && (type === 'submit' || type === '')) ||
				(tag === 'input' && (type === 'submit' || type === 'image'))
			);

			let action = null;
			if (form) {
				const raw = el.getAttribute('formaction') || form.getAttribute('action') || location.href;
				try {
					action = new URL(raw, location.href).href;
				} catch (e) {
					action = location.href;
				}
			}

			// The name of the button this field's form would submit through, so a
			// type(field, submit:true) can be judged by the button it fires --
			// "Buy now" -- and not by the innocent field it is typed into.
			let submitName = '';
			if (form && !isSubmit) {
				const btn = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
				if (btn) submitName = nameOf(btn) || (btn.value || '');
			}

			return {
				ok:		true,
				ref,
				tag,
				type,
				role:		roleOf(el),
				name:		nameOf(el),
				submitName,
				href:		el.getAttribute('href') ? new URL(el.getAttribute('href'), location.href).href : null,
				isSubmit,
				formMethod:	form ? (el.getAttribute('formmethod') || form.getAttribute('method') || 'get').toLowerCase() : null,
				formAction:	action,
				pageUrl:	location.href,
			};
		}

		function gone(ref) {
			return {
				ok:	false,
				error:	`There is nothing at ref ${ref} any more. The page has changed. Take a fresh snapshot.`,
			};
		}

		function click(ref) {
			const el = elOf(ref);
			if (!el) return gone(ref);
			if (el.disabled) return { ok: false, error: `"${nameOf(el)}" is disabled.` };

			el.scrollIntoView({ block: 'center', inline: 'center' });
			try {
				el.focus({ preventScroll: true });
			} catch (e) {
				// Not focusable. Clicking still works.
			}
			el.click();
			return { ok: true, url: location.href };
		}

		/// Sets a value the way the page's own framework will believe.
		///
		/// The native setter is preferred, because React and friends track it and
		/// ignore a plain assignment. But that setter is grabbed from THIS isolated
		/// world's prototype, and calling it on the page's element throws "Illegal
		/// invocation" in some builds -- so a plain assignment is the fallback, not
		/// a crash. Typing must never fail just because a framework optimisation did.
		function setValue(el, text) {
			try {
				const proto = el instanceof HTMLTextAreaElement
					? HTMLTextAreaElement.prototype
					: HTMLInputElement.prototype;
				const desc = Object.getOwnPropertyDescriptor(proto, 'value');
				if (desc && desc.set) { desc.set.call(el, text); return; }
			} catch (e) { /* the native setter refused; fall back */ }
			el.value = text;
		}

		function type(ref, text, submit) {
			const el = elOf(ref);
			if (!el) return gone(ref);

			if (isCredentialField(el)) {
				return {
					ok:	false,
					error:	'That is a credential field. Only the user types there, and Daimond does not watch while they do.',
				};
			}
			if (el.disabled || el.readOnly) {
				return { ok: false, error: `"${nameOf(el)}" cannot be typed into.` };
			}

			el.scrollIntoView({ block: 'center' });
			try {
				el.focus({ preventScroll: true });
			} catch (e) {
				return { ok: false, error: `"${nameOf(el)}" cannot take the keyboard.` };
			}

			if (el.isContentEditable) {
				el.textContent = text;
			} else {
				setValue(el, '');
				el.dispatchEvent(new Event('input', { bubbles: true }));
				setValue(el, text);
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
			}

			if (submit) {
				const form = el.form || (el.closest && el.closest('form'));
				el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
				el.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
				if (form && typeof form.requestSubmit === 'function') {
					const btn = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
					form.requestSubmit(btn || undefined);
				} else if (form) {
					form.submit();
				}
			}

			return { ok: true, url: location.href };
		}

		function scroll(direction, amount) {
			const step = amount > 0 ? amount : Math.round(window.innerHeight * 0.8);
			switch ((direction || 'down').toLowerCase()) {
				case 'up':	window.scrollBy(0, -step);				break;
				case 'down':	window.scrollBy(0, step);				break;
				case 'left':	window.scrollBy(-step, 0);				break;
				case 'right':	window.scrollBy(step, 0);				break;
				case 'top':	window.scrollTo(0, 0);					break;
				case 'bottom':	window.scrollTo(0, document.body.scrollHeight);		break;
				default:
					return { ok: false, error: `Scroll where? Try up, down, top or bottom, not "${direction}".` };
			}
			return { ok: true, y: Math.round(window.scrollY) };
		}

		// -------------------------------------------------------------------
		// The detector -- and the detaching
		// -------------------------------------------------------------------

		let observer	= null;
		let armed	= false;
		let truce	= false;	// The user has already handed back on this page.

		/// What, if anything, on this page is asking for a credential?
		function private_() {
			if (!truce && document.querySelector('input[type=password]')) {
				return { private: true, reason: 'a password field' };
			}
			if (document.querySelector('input[autocomplete*="webauthn"], input[autocomplete="one-time-code"]')) {
				return { private: true, reason: 'a passkey or one-time-code prompt' };
			}
			return { private: false, reason: '' };
		}

		function tell(reason) {
			try {
				chrome.runtime.sendMessage({ type: 'private', reason });
			} catch (e) {
				// The worker is asleep or the context is gone. We have already
				// detached, which is the part that matters.
			}
		}

		/// A trusted keystroke into a field means a human is at the wheel.
		function onKey(ev) {
			if (!ev.isTrusted) return;	// Our own typing is not a user.
			const t = ev.target;
			if (!t) return;
			const tag = t.tagName;
			const editable = tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
			if (!editable) return;
			if (ev.key && ev.key.length > 1 && ev.key !== 'Backspace') return;	// Tab, arrows, etc.
			detach();
			try {
				chrome.runtime.sendMessage({ type: 'typing' });
			} catch (e) {
				// Detached regardless.
			}
		}

		function onWebAuthn(ev) {
			const reason = (ev.detail && ev.detail.reason) || 'a passkey prompt';
			detach();
			tell(reason);
		}

		/// Arms the detector. Returns what it sees right now, so the broker can
		/// flip the mode before it answers anything.
		function arm(isTruce) {
			truce = !!isTruce;

			const seen = private_();
			if (seen.private) {
				detach();
				return seen;
			}

			if (!armed) {
				armed = true;
				document.addEventListener('keydown', onKey, true);
				document.addEventListener('__daimond_private', onWebAuthn, true);
				observer = new MutationObserver(() => {
					const now = private_();
					if (now.private) {
						detach();
						tell(now.reason);
					}
				});
				observer.observe(document.documentElement, {
					childList:	true,
					subtree:	true,
					attributes:	true,
					attributeFilter: ['type', 'autocomplete'],
				});
			}

			return { private: false, reason: '' };
		}

		/// Takes the hands off the page entirely. No observer, no listeners, no
		/// refs. There is nothing left here that could see a keystroke.
		function detach() {
			if (observer) {
				observer.disconnect();
				observer = null;
			}
			document.removeEventListener('keydown', onKey, true);
			document.removeEventListener('__daimond_private', onWebAuthn, true);
			armed = false;
			byRef.clear();
			return true;
		}

		// -------------------------------------------------------------------
		// Handing the wheel BACK -- from inside the tab, where the user is
		// -------------------------------------------------------------------
		//
		// The takeover must originate from a real gesture the web page cannot
		// forge. So the "resume" button is not in the Daimond page -- which is
		// driven by an agent that may itself have been steered by a web page --
		// it is HERE, in the tab the user just signed into, rendered in a shadow
		// root the page cannot see or fake. Its click is a trusted event in this
		// isolated world, and it messages the broker on the internal channel,
		// which the page has no way to reach. The page can ask for many things;
		// it can never ask to stop being watched-not.

		let resumeHost = null;
		function showResume() {
			if (resumeHost) return true;
			const host = document.createElement('div');
			// `all:initial` FIRST — it resets everything, so anything after it wins.
			// Put it last and it would reset the fixed positioning back to static.
			host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px';
			const root = host.attachShadow({ mode: 'closed' });
			const btn = document.createElement('button');
			btn.textContent = 'Resume Daimond ▸';
			btn.style.cssText = 'font:600 13px system-ui,sans-serif;color:#fff;background:#c0392b;'
				+ 'border:0;border-radius:8px;padding:10px 16px;box-shadow:0 4px 16px rgba(0,0,0,.35);cursor:pointer';
			btn.addEventListener('click', () => {
				// A trusted click. The broker will verify it arrived internally.
				try { chrome.runtime.sendMessage({ type: 'resume' }); } catch (e) { /* worker asleep; it re-checks */ }
			});
			root.appendChild(btn);
			(document.body || document.documentElement).appendChild(host);
			resumeHost = host;
			return true;
		}
		function hideResume() {
			if (resumeHost) { resumeHost.remove(); resumeHost = null; }
			return true;
		}

		// -------------------------------------------------------------------
		// The one entry point
		// -------------------------------------------------------------------

		function handle(cmd, a) {
			try {
				switch (cmd) {
					case 'snapshot':	return snapshot();
					case 'read':		return readText();
					case 'describe':	return describe(a.ref);
					case 'click':		return click(a.ref);
					case 'type':		return type(a.ref, a.text, a.submit);
					case 'scroll':		return scroll(a.direction, a.amount);
					case 'showResume':	return showResume();
					case 'hideResume':	return hideResume();
					default:		return { ok: false, error: `The hands do not know "${cmd}".` };
				}
			} catch (e) {
				return { ok: false, error: `The page could not be operated: ${(e && e.message) || String(e)}` };
			}
		}

		/// What the hands are doing, for the extension's own tests and for anyone
		/// auditing the claim that 'user' mode really does mean detached.
		function state() {
			return { armed, observing: observer !== null, refs: byRef.size, truce };
		}

		globalThis.__daimond = { arm, detach, handle, state };
	}

	return true;
})();
