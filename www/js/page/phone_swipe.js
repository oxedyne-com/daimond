// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
// page-split: end imports

// ── A row's actions, behind a swipe (Stack A1, D-20261029-01) ──────────────
// On the phone's home page a row no longer draws its cog and × on every line:
// a swipe left, or a long press, slides the row aside and shows them as the
// tray behind it, as Mail and Messages do. The buttons are the row's own
// `.tile-cog` and `.tile-x`, so the acts are the desktop's, unchanged; only
// where they are drawn moves (css/phone/home.css). The press is gesture.js's
// recogniser, the app's one, so a hand meets the same threshold and the same
// hold here as on the Graph and the Dock.
//
// The row says where it is through two things the stylesheet reads:
// `data-swipe` ("drag" while a finger has it, "open" at rest on its tray) and
// `--swipe-dx`, the row's offset in pixels, never more than the tray is wide.

const ACT = 72;   // fixed: one action's width in the tray, as home.css draws it

/// The tray's width: its actions as laid out, or as home.css sizes them while hidden.
function trayW(row) {
	let w = 0;
	for (const b of row.querySelectorAll('.tile-cog, .tile-x')) w += b.offsetWidth || ACT;
	return w;
}

function rest(row, dx) {
	if (dx) {
		row.dataset.swipe = 'open';
		row.style.setProperty('--swipe-dx', dx + 'px');
	} else {
		delete row.dataset.swipe;
		row.style.removeProperty('--swipe-dx');
	}
}

/// Make the rows of `list` (matched by `rowSel`) open their actions to a swipe or a
/// long press. `isOn` answers whether the list is the phone's home page now; off the
/// phone no press is claimed, so the desktop rail keeps its own cog and ×.
export function bindSwipe(list, rowSel, opts) {
	const o = opts || {};
	const G = o.gesture || (typeof window !== 'undefined' && window.DaimondGesture);
	if (!G || !list) return null;
	const isOn = o.isOn || (() => false);
	let swallow = null;   // the row whose next click is the end of a gesture, not a tap

	function shutAll(but) {
		for (const r of list.querySelectorAll(rowSel)) if (r !== but && r.dataset.swipe) rest(r, 0);
	}
	function open(row) {
		shutAll(row);
		rest(row, -trayW(row));
	}

	// The click a gesture ends with would open the chat under the finger: it is
	// taken here, in the capture phase, before the row's own handler sees it.
	list.addEventListener('click', function (ev) {
		if (!swallow) return;
		const row = ev.target && ev.target.closest ? ev.target.closest(rowSel) : null;
		swallow = null;
		if (!row) return;
		ev.preventDefault();
		ev.stopPropagation();
		// And the home page's own "open this row", bound beside this one (phone_home.js).
		if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
	}, true);

	return G.drag(list, {
		passive: true,            // the list still scrolls and its buttons still click
		match(ev) {
			if (!isOn()) return null;
			const t = ev.target;
			if (!t || !t.closest || t.closest('.tile-cog, .tile-x')) return null;   // an act in the tray
			const row = t.closest(rowSel);
			if (!row) return null;
			return { row, x0: ev.clientX, y0: ev.clientY, base: row.dataset.swipe === 'open' ? -trayW(row) : 0 };
		},
		lift(ev, ctx) {
			// A hold arrives with no event; a travel more down than across is the list scrolling.
			if (ev && Math.abs(ev.clientY - ctx.y0) > Math.abs(ev.clientX - ctx.x0)) return false;
			ctx.row.dataset.swipe = 'drag';
			return true;
		},
		onHold(ctx) {
			open(ctx.row);
			swallow = ctx.row;
			ctx.held = true;
			return 'cancel';
		},
		move(pt, ctx) {
			const w = trayW(ctx.row);
			ctx.dx = Math.max(-w, Math.min(0, ctx.base + pt.clientX - ctx.x0));
			ctx.row.style.setProperty('--swipe-dx', ctx.dx + 'px');
		},
		drop(ev, ctx, lifted) {
			if (!lifted) {
				// A tap while any row is open shuts it, and opens nothing.
				if (Array.prototype.some.call(list.querySelectorAll(rowSel), (r) => r.dataset.swipe === 'open')) {
					shutAll(null);
					swallow = ctx.row;
				}
				return;
			}
			swallow = ctx.row;
			const dx = ctx.dx === undefined ? ctx.base : ctx.dx;
			if (dx < -trayW(ctx.row) / 2) open(ctx.row);
			else rest(ctx.row, 0);
		},
		cancel(ctx) {
			if (ctx.held) return;
			rest(ctx.row, ctx.base);
		},
	});
}
