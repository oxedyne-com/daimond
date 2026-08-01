// The user's own window onto the extension: what mode it is in, what page it is
// holding, and which sites it may touch. Every grant here can be withdrawn here.

'use strict';

(() => {

	const $ = (id) => document.getElementById(id);
	const I = globalThis.DaimondExtI18n;
	const t = (...a) => I.t(...a);

	/// A match pattern, said the way a person would say it.
	function plain(pat) {
		if (pat === '<all_urls>') return t('popup_any_tab');
		const m = /^\*:\/\/\*\.([^/]+)\/\*$/.exec(pat);
		if (m) return t('popup_subdomains', m[1]);
		const n = /^\*:\/\/([^/]+)\/\*$/.exec(pat);
		return n ? n[1] : pat;
	}

	/// A line of state: a sentence, and the small print under it.
	function says(el, head, fine) {
		el.textContent = '';
		const h = document.createElement('div');
		const f = document.createElement('small');
		h.textContent = head;
		f.textContent = fine;
		el.append(h, f);
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
			if (s.pending.kind === 'mirror') {
				says(ask, t('popup_ask_mirror'), t('popup_ask_mirror_fine'));
			} else {
				says(ask, t('popup_ask_site', s.pending.host), t('popup_ask_site_fine', s.pending.host));
			}
			$('raise').hidden = false;
		} else {
			ask.hidden = true;
			$('raise').hidden = true;
		}

		const mode = $('mode');
		mode.className = 'mode ' + s.mode;
		if (s.mode === 'user') {
			says(mode, t('popup_mode_user'), t('popup_mode_user_fine'));
			$('take').hidden = false;
		} else if (s.mode === 'agent') {
			says(mode, t('popup_mode_agent'), t('popup_mode_agent_fine'));
			$('take').hidden = true;
		} else {
			says(mode, t('popup_mode_idle'), t('popup_mode_idle_fine'));
			$('take').hidden = true;
		}

		$('url').textContent = s.url || '';
		// One question at a time. Offering the live view -- the broadest permission
		// Chrome has -- beside a site question the user has not answered is how a
		// clear flow turns back into three surprises.
		$('mirror').hidden = (s.granted || []).includes('<all_urls>') || !!s.pending;

		const ul = $('granted');
		ul.textContent = '';
		if (!s.granted || !s.granted.length) {
			const li = document.createElement('li');
			li.className	= 'none';
			li.textContent	= t('popup_none');
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
			btn.textContent		= t('popup_revoke');
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
	// -- opening another would be the popup flood the live-view guard exists to
	// stop.
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

	// The marked nodes are painted the moment the table is in, and the state is
	// asked for after -- so the window never draws a translated question around
	// English furniture.
	I.ready().then(() => { I.paint(); refresh(); });

})();
