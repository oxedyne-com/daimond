// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
import { isMobile } from './layout.js';
import { DaimondStack } from './phone_stack.js';
import { bindSwipe } from './phone_swipe.js';
// page-split: end imports

// ── The phone's home page: the rail (Stack A1, D-20261029-01) ──────────────
// On a phone the rail is no longer a drawer slid over the chat: it is the root
// page of the stack, the first thing on screen, and a Diamond or a chat is
// pushed over it. The rail element itself is moved into the home page, so every
// renderer, fold and fit that already draws it draws the home page; at a desktop
// width it goes back to its seat in `#main`, where the layout engine places it.
//
// `turn` is today's shell floor, the conversation, standing in as a page until
// Stack B1 draws the turn view into it: it has nothing to mount, and while it is
// on top the home page is hidden and the floor shows. Going back to home is
// A2's stack bar; until it lands the hamburger's drawer class shows the home
// page over the floor (css/phone/home.css).

export function install() {
	const rail = document.getElementById('panel-rail');
	if (!rail || !rail.parentNode) return;
	const seat = document.createComment(' the rail\'s seat off the phone (phone_home.js) ');
	rail.parentNode.insertBefore(seat, rail);

	DaimondStack.on('home', function (el) { el.classList.add('home-page'); });
	DaimondStack.on('turn', function () {});

	function place() {
		if (isMobile()) {
			const home = DaimondStack.top() ? document.querySelector('#phone-stack > [data-page="home"]')
				: DaimondStack.push('home');
			if (home && rail.parentNode !== home) home.appendChild(rail);
			DaimondStack.unpark();
		} else {
			if (seat.nextSibling !== rail) seat.parentNode.insertBefore(rail, seat.nextSibling);
			DaimondStack.park();
		}
	}
	place();
	const mq = window.matchMedia('(max-width: 760px)');
	if (mq.addEventListener) mq.addEventListener('change', place);
	else if (mq.addListener) mq.addListener(place);

	// Swipe or hold a row for its cog and Delete; then the tap that opens a row
	// pushes the turn, after the swipe has had the chance to take the click.
	['diamond-list', 'session-list'].forEach(function (id) {
		const list = document.getElementById(id);
		if (!list) return;
		bindSwipe(list, '.session-box', { isOn: function () { return isMobile() && rail.parentNode !== seat.parentNode; } });
		list.addEventListener('click', function (ev) {
			if (!isMobile()) return;
			const t = ev.target;
			if (!t || !t.closest || !t.closest('.session-box')) return;
			// A control inside the row (its icon, its pause, a tray act) does its own thing.
			const ctl = t.closest('button, input, a, select, [role="menu"]');
			if (ctl && !ctl.classList.contains('tile-label')) return;
			DaimondStack.push('turn');
		}, true);
	});

	// The head's two acts are the rail's own: search opens the find box over the
	// Diamonds, compose is New Chat.
	const find = document.getElementById('home-search-btn');
	if (find) find.addEventListener('click', function () {
		const on = rail.dataset.search !== 'on';
		if (on) rail.dataset.search = 'on'; else delete rail.dataset.search;
		find.setAttribute('aria-expanded', on ? 'true' : 'false');
		const box = document.getElementById('diamond-search');
		if (on && box) box.focus();
	});
	const compose = document.getElementById('home-compose-btn');
	const newChat = document.getElementById('new-session-btn');
	if (compose && newChat) compose.addEventListener('click', function () { newChat.click(); });
}
