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

	DaimondStack.on('home', function (el) {
		el.classList.add('home-page');
		bindDrawer(el, rail);
	});
	DaimondStack.on('turn', function () {});

	let booted = false;
	function place() {
		if (isMobile()) {
			// Brought back first: what the wide window opened (a chat, a Diamond) goes on over
			// home, which is laid as the floor here when the window opened wide (phone_stack.js).
			DaimondStack.unpark();
			const home = DaimondStack.top() ? document.querySelector('#phone-stack > [data-page="home"]')
				: DaimondStack.push('home');
			if (home && rail.parentNode !== home) home.appendChild(rail);
			// A phone opens on the drawer over the last chat, a reload on a chat included
			// (UNBLOCK-95): the chat is the floor behind it, a swipe away, and Forward.
			if (!booted && DaimondStack.top() === 'turn') DaimondStack.push('home');
			booted = true;
		} else {
			if (seat.nextSibling !== rail) seat.parentNode.insertBefore(rail, seat.nextSibling);
			DaimondStack.park();
		}
	}
	place();
	window.DaimondPhone.watch(place);

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

const SHUT = 46; // px of leftward travel that puts the drawer away (the stack's back swipe, phone_stack.js)

// The drawer goes away to the chat behind it on a tap of the scrim (the section itself, not
// the rail) or a left swipe, which the rail follows. A row's own left swipe opens its tray
// (phone_swipe.js), so a swipe that starts on a row is left to it.
function bindDrawer(el, rail) {
	const shut = () => { if (DaimondStack.top() === 'home') DaimondStack.push('turn'); };
	el.addEventListener('click', function (ev) { if (ev.target === el) shut(); });
	const G = window.DaimondGesture;
	if (!G) return;
	G.drag(el, {
		passive: true,
		match(ev) {
			if (!isMobile() || DaimondStack.top() !== 'home') return null;
			const t = ev.target;
			if (t && t.closest && t.closest('.session-box')) return null;
			return { x0: ev.clientX, y0: ev.clientY, dx: 0 };
		},
		lift(ev, ctx) {
			// A hold is not a swipe, and nor is a travel more down than across (the rail scrolling).
			if (!ev || Math.abs(ev.clientY - ctx.y0) > Math.abs(ev.clientX - ctx.x0)) return false;
			return ev.clientX < ctx.x0;
		},
		move(pt, ctx) {
			ctx.dx = Math.min(0, pt.clientX - ctx.x0);
			rail.style.transform = 'translateX(' + ctx.dx + 'px)';
		},
		drop(ev, ctx, lifted) {
			rail.style.transform = '';
			if (lifted && ctx.dx <= -SHUT) shut();
		},
		cancel() {
			rail.style.transform = '';
		},
	});
}
