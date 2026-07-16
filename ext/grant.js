// The one place permission is given.
//
// chrome.permissions.request needs a real user gesture, and a message from a web
// page is not one -- deliberately. So the question is put here, in the
// extension's own window, where a click is a click and Chrome will honour it.
//
// Two questions are asked here, never together:
//	'site'   -- may Daimond operate this one site?
//	'mirror' -- may Daimond photograph the tab, so the panel can show it?

'use strict';

(() => {

	const $		= (id) => document.getElementById(id);
	const q		= new URLSearchParams(location.search);
	const nonce	= q.get('nonce');
	const kind	= q.get('kind') || 'site';
	const host	= q.get('host') || '';
	const pat	= q.get('pattern') || '';

	if (kind === 'mirror') {
		$('head').textContent	= 'Daimond wants to show you the tab it is driving';
		$('body').textContent	= 'To mirror the tab inside the Daimond panel, the extension needs to take a picture of it. Chrome will not allow that site by site, so this permission covers any tab.';
		$('fine').textContent	= 'It changes nothing about the handoff: while you are entering a password, no picture is taken and none is sent. You can withdraw this at any time from the Daimond Hands icon. If you say no, Daimond simply works from the page structure instead.';
		$('allow').textContent	= 'Allow the live mirror';
	} else {
		$('head').textContent	= 'Daimond wants to operate a site for you';
		$('host').hidden	= false;
		$('host').textContent	= host;
		$('body').textContent	= "Daimond can read this site's page structure and click and type on it, in this browser, as you.";
		// Set the expectation before it happens: clicking Allow hands off to
		// Chrome's own permission prompt, whose wording is alarming by design.
		// A user warned it is coming, and told it is the real approval, is not
		// ambushed by it after already clicking Allow once.
		$('fine').textContent	= "When you click below, Chrome asks once more — it will say “read and change your data on this site”, which is Chrome's standard wording for any extension, not something extra Daimond does. That prompt is the real approval, and it only appears the first time for a site. Daimond never sees a password: the moment a login form appears it stops receiving anything until you hand the wheel back, and you can withdraw this at any time from the Daimond Hands icon.";
		$('allow').textContent	= 'Allow, then confirm in Chrome →';
	}

	/// Tells the broker how the user answered, then closes.
	function answer(ok) {
		chrome.runtime.sendMessage({ type: 'grant', nonce, ok }, () => window.close());
	}

	$('allow').addEventListener('click', async () => {
		try {
			const ok = await chrome.permissions.request({ origins: [pat] });
			answer(!!ok);
		} catch (e) {
			answer(false);
		}
	});

	$('deny').addEventListener('click', () => answer(false));

})();
