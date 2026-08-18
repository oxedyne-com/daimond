/* capp.js — the one control in this guide that asks Daimond to do something.
 *
 * The guide is framed inside Daimond's Web panel WITHOUT `allow-same-origin`
 * (see the head of frame.js, which says why). An opaque origin cannot reach the
 * app's document, so this cannot call a function in the app: it posts a request
 * and waits to be told what happened, exactly as the palette does.
 *
 * WHAT IS SENT IS A REQUEST AND NOT AN INSTRUCTION. The app decides: it reads
 * the message only from its own guide frame, it puts a dialog in its own chrome
 * where a click is provably a person's, and what it will do at most is make one
 * Diamond -- a second ask opens the first one's. Nothing here can be turned into
 * a way of reading anything, because nothing comes back but a status word.
 *
 * Opened outside Daimond -- the guide is a real site and stands on its own --
 * there is nobody to ask, and the button says so rather than doing nothing.
 */
(function () {
	'use strict';

	/// How long a request may go unanswered before the control is offered again.
	/// Long, because the app's answer waits on a person reading a dialog, and a
	/// button that re-arms while the question is still on screen invites a second
	/// dialog behind the first.
	var PATIENCE = 90000;

	/// What each answer says. The app sends the word; the sentence is here,
	/// because it is the reader's language that decides the wording and this page
	/// is the thing they are looking at.
	var SAID = {
		made:      'Made. Log Life is open in the Diamonds rail.',
		opened:    'You already had one. It is open in the Diamonds rail.',
		cancelled: 'Nothing was made.',
		missing:   'This build of Daimond does not carry the Log Life template, so nothing was made.',
		failed:    'Daimond could not finish making it. It said so on screen.',
	};

	function ready() {
		var btn = document.getElementById('make-lifelog');
		var say = document.getElementById('lifelog-say');
		if (!btn || !say) return;

		var timer = 0;

		function tell(text) { say.textContent = text || ''; }

		function rearm() {
			if (timer) { clearTimeout(timer); timer = 0; }
			btn.disabled = false;
		}

		btn.addEventListener('click', function () {
			// Standing on its own, with no Daimond around it. Said plainly: a
			// control that silently does nothing teaches a reader to distrust every
			// control on the page.
			if (!window.parent || window.parent === window) {
				tell('Open this page inside Daimond, with the ? in its top bar, and this '
					+ 'button will make the Diamond for you.');
				return;
			}
			btn.disabled = true;
			tell('Asked Daimond. Answer the question it puts up.');
			timer = setTimeout(function () {
				timer = 0;
				btn.disabled = false;
				tell('No answer from Daimond. Try again, or ask your daimon for a page.');
			}, PATIENCE);
			try {
				window.parent.postMessage({ daimondGuide: 'make', what: 'lifelog' }, '*');
			} catch (e) {
				rearm();
				tell('This page could not reach Daimond.');
			}
		});

		window.addEventListener('message', function (e) {
			// Only from the framer we asked, mirroring the check the app makes on
			// its own side. Nothing here does more than write a sentence, so this
			// is not what keeps the channel safe -- it is that the question is
			// asked in app chrome. It is here because a listener that answers to
			// anybody is a habit, and the next one may do more.
			if (!e || e.source !== window.parent) return;
			var d = e.data;
			if (!d || d.daimondGuide !== 'made' || d.what !== 'lifelog') return;
			rearm();
			tell(SAID[d.status] || 'Daimond answered, and this page does not know that word.');
		});
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
	else ready();
})();
