// The user's own window onto the extension: what mode it is in, what page it is
// holding, and which sites it may touch. Every grant here can be withdrawn here.

'use strict';

(() => {

	const $ = (id) => document.getElementById(id);

	/// A match pattern, said the way a person would say it.
	function plain(pat) {
		if (pat === '<all_urls>') return 'Any tab, for the live mirror';
		const m = /^\*:\/\/\*\.([^/]+)\/\*$/.exec(pat);
		if (m) return `${m[1]} and its subdomains`;
		const n = /^\*:\/\/([^/]+)\/\*$/.exec(pat);
		return n ? n[1] : pat;
	}

	/// Paints the current state.
	function paint(s) {
		$('ver').textContent = `v${s.version}`;

		// A question is waiting. Its own window is in front, but a window can be
		// covered, minimised or lost behind the app -- and then this icon is the
		// only place left that knows. Say what is being asked and offer the way
		// back to it. This RAISES that window; it never opens a second one.
		const ask = $('ask');
		if (s.pending) {
			ask.hidden = false;
			ask.textContent = '';
			const head = document.createElement('div');
			const fine = document.createElement('small');
			if (s.pending.kind === 'mirror') {
				head.textContent = 'Waiting for you: may Daimond show the tab it is driving?';
				fine.textContent = 'It needs to photograph the tab, which Chrome cannot allow site by site. Saying no costs nothing — Daimond works from the page structure instead.';
			} else {
				head.textContent = `Waiting for you: may Daimond operate ${s.pending.host}?`;
				fine.textContent = `Approving covers ${s.pending.host} and its subdomains, and nothing else. Chrome asks once more to confirm.`;
			}
			ask.append(head, fine);
			$('raise').hidden = false;
		} else {
			ask.hidden = true;
			$('raise').hidden = true;
		}

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
		// One question at a time. Offering the mirror -- the broadest permission
		// Chrome has -- beside a site question the user has not answered is how a
		// clear flow turns back into three surprises.
		$('mirror').hidden = (s.granted || []).includes('<all_urls>') || !!s.pending;

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
			// The pattern is what was granted; the plain form is what it MEANS.
			// A user auditing what they have given away should not have to read
			// a match pattern to find out that it covers subdomains.
			span.textContent	= plain(pat);
			span.title		= pat;
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

	// Bring the waiting question back to the front. It is the same window, raised
	// -- opening another would be the popup flood the mirror guard exists to stop.
	$('raise').addEventListener('click', async () => {
		const r = await chrome.runtime.sendMessage({ type: 'raise' });
		if (r && r.ok) window.close();
		else refresh();
	});

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
