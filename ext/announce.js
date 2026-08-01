// Runs only on the Daimond origins. It does two small things.
//
// One: it lets the page discover the extension without hard-coding an id, by
// stamping the id on <html>. The page then talks to the broker with
// chrome.runtime.sendMessage(id, msg).
//
// Two: it carries the language the user chose in the app across to the
// extension, which has no other way to learn it. Chrome would dress the grant
// window in the BROWSER's UI language -- and a person reading a Japanese app is
// not necessarily running a Japanese Chrome. The one place the extension asks
// the user to trust it is the worst place in the product to change language.
//
// It reads one key of the app's own storage. It sends nothing anywhere else.

'use strict';

(() => {

	const	id	= chrome.runtime.id;
	const	root	= document.documentElement;

	// Stamp for a page that is already parsed, and for one that is not.
	root.dataset.daimondHands	= id;
	root.dataset.daimondHandsVer	= chrome.runtime.getManifest().version;

	// The page may have been listening before we ran.
	window.dispatchEvent(new CustomEvent('daimond-hands', {
		detail: { id, version: chrome.runtime.getManifest().version },
	}));

	// ── The language the app is speaking ────────────────────────────────

	/// Where the app keeps the chosen language. Empty means the user has not
	/// chosen one, and the browser's own language is the honest answer.
	const LS	= 'daimond-locale';
	let	last	= null;

	function mirror() {
		let code = '';
		try {
			code = localStorage.getItem(LS) || '';
		} catch (e) {
			return;	// Private mode. Whatever was mirrored before stands.
		}
		if (code === last) return;
		last = code;
		try { chrome.storage.local.set({ locale: code }); } catch (e) { /* worker asleep */ }
	}

	mirror();

	// The app writes the language to storage and then stamps it on <html>, so
	// the attribute is the signal that a choice has just been made -- and it
	// arrives whether the change came from the picker, a sync, or a reload.
	try {
		new MutationObserver(mirror).observe(root, { attributes: true, attributeFilter: ['lang'] });
	} catch (e) { /* no observer, no live updates; the load-time read stands */ }

	// A change made in another tab reaches this one as a storage event.
	window.addEventListener('storage', (ev) => { if (!ev.key || ev.key === LS) mirror(); });

})();
