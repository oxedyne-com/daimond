// The one place permission is given.
//
// chrome.permissions.request needs a real user gesture, and a message from a web
// page is not one -- deliberately. So the question is put here, in the
// extension's own window, where a click is a click and Chrome will honour it.
//
// Two questions are asked here, never together:
//	'site'   -- may Daimond operate this one site?
//	'mirror' -- may Daimond photograph the tab, so the panel can show it?
//
// It is asked in the language the app is speaking. This is the one window in
// the product that asks the user to trust something, and a question nobody can
// read is not a question.

'use strict';

(() => {

	const $		= (id) => document.getElementById(id);
	const I		= globalThis.DaimondExtI18n;
	const t		= (...a) => I.t(...a);
	const q		= new URLSearchParams(location.search);
	const nonce	= q.get('nonce');
	const kind	= q.get('kind') || 'site';
	const host	= q.get('host') || '';
	const pat	= q.get('pattern') || '';

	/// Writes the question. Called once the table is in, so the window is never
	/// read half in one language and half in another.
	function draw() {
		I.paint();
		if (kind === 'mirror') {
			$('head').textContent	= t('grant_mirror_head');
			$('body').textContent	= t('grant_mirror_body');
			$('fine').textContent	= t('grant_mirror_fine');
			$('allow').textContent	= t('grant_mirror_allow');
		} else {
			$('head').textContent	= t('grant_site_head');
			$('host').hidden	= false;
			$('host').textContent	= host;
			// Say what is actually being granted. The pattern is `*://*.host/*`, so it
			// covers subdomains -- which is what a person means by "this site", and
			// what a click that crosses to an app subdomain needs -- but a window that
			// showed the bare host alone would be asking for more than it said.
			$('scope').hidden	= false;
			$('scope').textContent	= t('grant_site_scope', host);
			$('body').textContent	= t('grant_site_body');
			// Set the expectation before it happens: clicking Allow hands off to
			// Chrome's own permission prompt, whose wording is alarming by design.
			// A user warned it is coming, and told it is the real approval, is not
			// ambushed by it after already clicking Allow once. Chrome says it in
			// its OWN language, which is why this sentence quotes it rather than
			// promising the words the user will see.
			$('fine').textContent	= t('grant_site_fine');
			$('allow').textContent	= t('grant_site_allow');
		}
	}

	/// Tells the broker how the user answered, then closes.
	///
	/// 'allowed' or 'declined' -- both are ANSWERS. A window that goes away
	/// without sending one is a dismissal, and the broker reads that from the
	/// window closing, not from here.
	function answer(how) {
		chrome.runtime.sendMessage({ type: 'grant', nonce, answer: how }, () => window.close());
	}

	$('allow').addEventListener('click', async () => {
		try {
			// Chrome's own prompt is the real approval. Refusing it there is a
			// refusal, however this window was clicked.
			const ok = await chrome.permissions.request({ origins: [pat] });
			answer(ok ? 'allowed' : 'declined');
		} catch (e) {
			answer('declined');
		}
	});

	$('deny').addEventListener('click', () => answer('declined'));

	I.ready().then(draw);

})();
