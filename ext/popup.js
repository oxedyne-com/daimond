// The user's own window onto the extension: what mode it is in, what page it is
// holding, and which sites it may touch. Every grant here can be withdrawn here.

'use strict';

(() => {

	const $ = (id) => document.getElementById(id);

	/// Paints the current state.
	function paint(s) {
		$('ver').textContent = `v${s.version}`;

		const mode = $('mode');
		mode.className = 'mode ' + s.mode;
		if (s.mode === 'user') {
			mode.innerHTML = 'You are driving.<small>Daimond is not watching this tab: no page, no pixels, no keystrokes.</small>';
			$('take').hidden = false;
		} else if (s.mode === 'agent') {
			mode.innerHTML = 'Daimond is driving.<small>Passwords and payment fields are never sent, even now.</small>';
			$('take').hidden = true;
		} else {
			mode.innerHTML = 'Idle.<small>No page is open.</small>';
			$('take').hidden = true;
		}

		$('url').textContent = s.url || '';
		$('mirror').hidden = (s.granted || []).includes('<all_urls>');

		const ul = $('granted');
		ul.textContent = '';
		if (!s.granted || !s.granted.length) {
			const li = document.createElement('li');
			li.className	= 'none';
			li.textContent	= 'None yet. Daimond must ask before it touches any site.';
			ul.append(li);
			return;
		}
		for (const pat of s.granted) {
			const li	= document.createElement('li');
			const span	= document.createElement('span');
			const btn	= document.createElement('button');
			span.textContent	= pat;
			btn.textContent		= 'Revoke';
			btn.addEventListener('click', async () => {
				const res = await chrome.runtime.sendMessage({ type: 'revoke', pattern: pat });
				if (res && res.ok) refresh();
			});
			li.append(span, btn);
			ul.append(li);
		}
	}

	async function refresh() {
		const s = await chrome.runtime.sendMessage({ type: 'panel' });
		if (s && s.ok) paint(s);
	}

	$('take').addEventListener('click', async () => {
		await chrome.runtime.sendMessage({ type: 'takeover' });
		refresh();
	});

	// A click in the popup is a user gesture, which is what Chrome insists on
	// before it will widen a permission. So the request is made from here.
	$('mirror').addEventListener('click', async () => {
		try {
			await chrome.permissions.request({ origins: ['<all_urls>'] });
		} catch (e) {
			// The user said no. Nothing changes.
		}
		refresh();
	});

	refresh();

})();
