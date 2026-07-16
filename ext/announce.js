// Runs only on the Daimond origins. Its entire job is to let the page discover
// the extension without hard-coding an id, by stamping the id on <html>. The
// page then talks to the broker with chrome.runtime.sendMessage(id, msg).
//
// This script reads nothing and sends nothing. It writes one attribute.

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

})();
