// The one place permission is given.
//
// chrome.permissions.request needs a real user gesture, and a message from a web
// page is not one -- deliberately. So the question is put here, in the
// extension's own window, where a click is a click and Chrome will honour it.
//
// Three questions are asked here, never together:
//	'site'   -- may Daimond operate this one site?
//	'mirror' -- may Daimond photograph the tab, so the panel can show it?
//	'hand'   -- may Daimond run commands on this computer?
//
// The third is not a Chrome permission and cannot be: `nativeMessaging` is
// granted at install and there is nothing to ask Chrome for a second time. So
// for that one, this window IS the approval rather than the step before it, and
// the extension records the answer itself -- which is also what makes it
// revocable, since Chrome has nothing to take away.
//
// It is asked in the language the app is speaking. This is the one window in
// the product that asks the user to trust something, and a question nobody can
// read is not a question.
//
// TWO SCREENS, NOT TWO WINDOWS. What a person needs in order to decide is on
// the surface: what is being asked, which folder, which page asked, and the two
// buttons. Everything else -- the reasoning, the caveats, what the compartment
// does and does not stop -- is behind one disclosure, a Tab and a keypress away.
// Nothing was cut. A window nobody finishes reading is a window nobody
// understands, and an approval given without understanding is the failure this
// whole flow exists to avoid; but so is a short window that hides the fact that
// a website is being handed the ability to run programs. So the first screen
// still says, in its own words, that programs would run as this user with this
// user's files, whether the machine can hold them to a folder, and that this is
// the strongest thing Daimond can be allowed to do.

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
	const origin	= q.get('origin') || '';
	/// What the hand said it can enforce on this machine, space separated, from
	/// its `hello`. Empty means it never said, which is a third answer and not
	/// the same as saying no.
	const caps	= (q.get('caps') || '').split(/\s+/).filter(Boolean);

	/// Is a compartment actually in force on this machine?
	///
	/// `fence.rs` answers `fence:none` rather than an empty list when there is
	/// nothing, precisely so silence and "no fence" are told apart, and
	/// `fence:waived` is what a user who turned it off gets. Anything else
	/// beginning `fence:` is a mechanism that is really there.
	function fenced() {
		if (caps.indexOf('fence:none') >= 0 || caps.indexOf('fence:waived') >= 0) return false;
		return caps.some((c) => c.indexOf('fence:') === 0);
	}

	/// Is every run written down where the user can read it?
	function journalled() {
		return caps.some((c) => c === 'journal' || c.indexOf('journal:') === 0);
	}

	/// The folder the hand says the grant covers, or '' where it named none.
	///
	/// It travels as a `root:` capability because `wire.rs` has no field for it
	/// -- see `hand/src/main.rs`. The page cannot work the path out for itself:
	/// the File System Access API hands it a handle and never a name. So this is
	/// the only place the folder can come from, and a window that did not show
	/// it would be asking about a compartment without saying where it is.
	function rootDir() {
		const c = caps.find((s) => s.indexOf('root:') === 0);
		return c ? c.slice(5) : '';
	}

	/// Puts a node behind the disclosure, keeping the order it is given in.
	function conceal() {
		$('moreBody').prepend.apply($('moreBody'), arguments);
	}

	/// Sizes the window to its first screen.
	///
	/// The window is created before anything is known about the language it will
	/// be written in, and a height measured against English clips German while
	/// leaving an inch of nothing under Chinese. The sheet scrolls rather than
	/// clipping, so nothing is ever lost -- but a sentence a person has to scroll
	/// to is a sentence they did not read, and the whole point of the split is
	/// that the first screen IS read. So the height in background.js is a
	/// starting guess and this corrects it, in either direction, once, before the
	/// window has been shown long enough for anyone to have dragged it.
	///
	/// Bounded both ways: never past the screen, and never so small that the two
	/// buttons and the brand have nowhere to sit.
	function fit() {
		try {
			const sheet	= document.querySelector('.sheet');
			const have	= sheet.clientHeight;
			// What the sheet WANTS. `scrollHeight` alone cannot say: it is
			// clamped to the box, so it reports the overflow and never the slack,
			// and a window sized from it could grow but never give anything back.
			// Letting the sheet take its content height for one measurement is
			// the only way to see both.
			const flex	= sheet.style.flex;
			sheet.style.flex = '0 0 auto';
			const need	= Math.ceil(sheet.scrollHeight);
			sheet.style.flex = flex;
			const delta	= need - have;
			if (Math.abs(delta) < 4) return;
			chrome.windows.getCurrent((w) => {
				if (!w || w.height == null) return;
				const room = Math.max(320, (screen.availHeight || 900) - 60);
				chrome.windows.update(w.id,
					{ height: Math.max(300, Math.min(w.height + delta + 2, room)) });
			});
		} catch (e) { /* no windows API here; the sheet still scrolls */ }
	}

	/// Writes the question. Called once the table is in, so the window is never
	/// read half in one language and half in another.
	function draw() {
		I.paint();
		if (kind === 'mirror') {
			$('head').textContent	= t('grant_mirror_head');
			$('body').textContent	= t('grant_mirror_body');
			$('fine').textContent	= t('grant_mirror_fine');
			$('allow').textContent	= t('grant_mirror_allow');
		} else if (kind === 'hand') {
			$('head').textContent	= t('grant_hand_head');
			// The short of it, and the line on the first screen that decides the
			// question. `hand/README.md`'s first release gate is that the wording
			// is chosen from `caps` rather than hard-coded: a sentence about
			// folders, on a machine with no fence, is a promise the code does not
			// keep, and a promise about safety that is not kept is worse than
			// none. Three answers, because there are three: it fences, it does
			// not, or it did not say.
			$('lead').hidden	= false;
			$('lead').textContent	= caps.length === 0	? t('grant_hand_lead_unknown')
						: fenced()		? t('grant_hand_lead')
						: t('grant_hand_lead_nofence');
			// Which folder. A fact about the decision rather than a detail of
			// it: approving this for a project folder and approving it for a
			// home directory are different answers to different questions.
			const dir = rootDir();
			// Shown only where there is a fact to put in it: an empty grid is a
			// gap the reader has to account for.
			$('facts').hidden = !dir && !origin;
			if (dir) {
				$('folderlab').hidden		= false;
				$('folderlab').textContent	= t('grant_hand_folder');
				$('folder').hidden		= false;
				$('folder').textContent		= dir;
			}
			// The question is about the machine, not about a site -- but it is
			// asked BY a page, and only that page is answered by it, so the page
			// is named. A user with the app open in two places should be able to
			// see which one is asking.
			if (origin) {
				$('hostlab').hidden		= false;
				$('hostlab').textContent	= t('grant_hand_asked_by');
				$('host').hidden		= false;
				$('host').textContent		= origin;
				// A row of the facts grid here, not the boxed headline it is on
				// the site question -- there the name IS the question, here it
				// is one fact among several.
				$('host').className		= 'val';
				$('facts').appendChild($('host'));
			}
			// Kept on the first screen deliberately, and lifted out of the fine
			// print to get there. It is the one sentence that stops a click, and
			// a sentence that stops a click cannot sit behind a control that a
			// hurried person does not press.
			$('strongest').hidden		= false;
			$('strongest').textContent	= t('grant_hand_strongest');
			// The long form of the same three answers, the capability list
			// verbatim, and the fine print. All still said, all one click away.
			$('body').textContent	= caps.length === 0	? t('grant_hand_body_unknown')
						: fenced()		? t('grant_hand_body')
						: t('grant_hand_body_nofence');
			$('scope').hidden	= false;
			$('scope').textContent	= caps.length
				? t('grant_hand_caps', caps.join(', '))
				: t('grant_hand_caps_unknown');
			// The journal is the other half of the same promise, and it is not
			// this machine's to make either until the hand says it keeps one.
			$('fine').textContent	= journalled() ? t('grant_hand_fine') : t('grant_hand_fine_nojournal');
			$('allow').textContent	= t('grant_hand_allow');
			conceal($('body'), $('scope'));
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
		// The cautious button holds the focus, so a keyboard alone can answer the
		// window and a reflexive Return refuses rather than approves. Everything
		// else -- the disclosure, then Allow -- is a Tab away.
		$('deny').focus();
		fit();
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
		// The machine hand has no Chrome permission behind it, so there is no
		// second prompt to defer to. This click is the whole approval, and the
		// broker writes it down.
		if (kind === 'hand') return answer('allowed');
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
