// page-split: imports (by hand; dev/pagesplit/modcheck.mjs checks every name)
// page-split: end imports

// ── Phone page stack (Stack A0, D-20261029-01; history A2) ─────
// The phone shell is a stack of whole-screen pages: home, a Diamond, a turn,
// Settings. A page registers how to draw itself with `on(name, mount)`; `push`
// shows it on top, `pop` goes back one, `top` names the page in view. A page is
// built once, on its first push, and is only hidden and shown after that, so
// going back never redraws what was there.
//
// Every push is a history entry carrying the whole stack, so Back (the browser's,
// a tab's own edge swipe, `pop`, or the installed app's edge swipe from
// `bindEdgeBack`) is one `popstate`, and a reload lands on the page it left.
// The stack follows the entry it is shown, never the other way round: `pop` and
// a push of a page lower down move history, and `popstate` sets the stack.
// The first page pushed is the floor (`start` says so outright): the stack, and
// its history, begin there. The host `#phone-stack` is made inside `#app` then.

const EDGE  = 24; // px from the left edge a back swipe starts within (iOS's own)
const SWIPE = 46; // px of travel before it counts
const DRIFT = 40; // px of vertical travel that makes it a scroll instead

/// A page stack of its own, for a test; the page uses `DaimondStack`. `win` is
/// the window whose history it keeps, through its one mover `win.DaimondHistory`
/// (js/history.js, which alone moves history, for this stack and the layers);
/// without one (a test of the contract alone) there is no history and no swipe.
export function newStack(win) {
	const w = win || (typeof window !== 'undefined' ? window : null);
	const hist = w && w.DaimondHistory ? w.DaimondHistory : null;
	const pages = new Map(); // name -> { mount, el }
	const stack = [];        // names, root first
	const opts  = {};        // name -> the opts it was last pushed with
	const seen  = [];        // watchers of the top page
	let root = null;         // the page `start` set as the floor

	// Inside the shell's `#app`, not on the body: the body takes menus only, through
	// DaimondLayers.hang (MENUGATE), and the stack is the shell itself, not a menu.
	function host() {
		let h = document.getElementById('phone-stack');
		if (!h) {
			const app = document.getElementById('app');
			if (!app) throw new Error('DaimondStack: no #app to hold the page stack');
			h = document.createElement('div');
			h.setAttribute('id', 'phone-stack');
			app.appendChild(h);
		}
		return h;
	}

	function build(name) {
		const p = pages.get(name);
		if (p.el) return p.el;
		p.el = document.createElement('section');
		p.el.className = 'phone-page';
		p.el.dataset.page = name;
		host().appendChild(p.el);
		p.mount(p.el, opts[name] || {});
		return p.el;
	}

	// The top page shown, the rest hidden; the host and `#app` say which page and
	// which way it went, for the stack bar and the slide (css/phone/stack.css).
	function show(dir) {
		const t = stack[stack.length - 1];
		for (const [name, p] of pages) if (p.el) p.el.hidden = name !== t;
		const app = document.getElementById('app');
		if (app && app.dataset) { app.dataset.stack = t || ''; app.dataset.stackDir = dir || ''; }
		for (const f of seen) f(t, stack.length, opts[t] || {});
	}

	function entry() {
		const o = {};
		for (const n of stack) if (opts[n]) o[n] = opts[n];
		return { stack: stack.slice(), opts: o };
	}

	// The stack an entry holds, or the floor alone for an entry from before the
	// stack (the page's first load) or one naming no page registered here.
	function adopt(state, dir) {
		const want = state && Array.isArray(state.stack) ? state.stack.filter((n) => pages.has(n)) : [];
		if (state && state.opts) for (const n of want) if (state.opts[n]) opts[n] = state.opts[n];
		stack.length = 0;
		for (const n of (want.length ? want : (root ? [root] : []))) stack.push(n);
		for (const n of stack) build(n);
		show(dir);
	}

	// The floor, and the pages above it a reload left in the history entry.
	function begin(name) {
		root = name;
		const st = hist ? hist.state() : null;
		adopt(st && Array.isArray(st.stack) && st.stack[0] === name ? st : null, '');
		if (hist) hist.replace(entry());
		at = stack.slice();
	}

	// History follows the stack. `at` is the stack of the entry history stands on. The
	// mover runs one traversal at a time, for this stack and the layers alike, so `move`
	// is run when none is in flight and against the entry history then stands on: a pop
	// and a push in one task (QA ccp29 F4), or a page put away while a menu closes
	// (phone_shell HX), end where the stack ends and never build on an old position.
	let at = [];          // the stack of the entry history is on
	function same(a, b) { return a.length === b.length && a.every((n, i) => n === b[i]); }
	function stackOf(st) {
		const got = st && Array.isArray(st.stack) ? st.stack.filter((n) => pages.has(n)) : [];
		return got.length ? got : [root];
	}
	function move() {
		if (!hist || !root) return;
		if (hist.busy()) { hist.run(move); return; }
		let c = 0;
		while (c < at.length && c < stack.length && at[c] === stack[c]) c++;
		if (c < at.length) {
			if (hist.go(-(at.length - c))) return;	// moves again when it lands
			// The floor is in the way (a reload above it): the entry is rewritten to the stack instead.
			hist.replace(entry());
			at = stack.slice();
			return;
		}
		// One entry per page, so each Back is one page.
		const want = stack.slice();
		for (let i = c + 1; i <= want.length; i++) {
			stack.length = 0;
			for (const n of want.slice(0, i)) stack.push(n);
			hist.push(entry());
		}
		at = want;
	}

	// Back by `n` pages, history with it at the end of the task.
	function back(n) {
		stack.length -= n;
		show('pop');
		move();
	}

	if (hist) hist.listen((st, how) => {
		if (!root) return;	// not started: this width has no stack
		if (!how.back) {
			// A traversal has landed, ours or the layers': no Back of a person's. The stack keeps its
			// pages and history is brought to them.
			at = stackOf(st);
			if (!same(at, stack)) move();
			return;
		}
		if (parked) { at = stackOf(st); return; }	// a desktop Back: the phone's stack is put away
		const was = stack.length;
		adopt(st, st && Array.isArray(st.stack) && st.stack.length > was ? 'push' : 'pop');
		at = stack.slice();
	});

	// A wider window has no stack (QA ccp29 F7): history goes back to the floor's
	// entry, so the desktop's Back is never spent on a page it does not show, and the
	// pages above are kept to come back when the window narrows again.
	let parked = null;	// [name, opts] above the floor, while put away
	function park() {
		if (!root || parked) return;
		parked = stack.slice(1).map((n) => [n, opts[n] || {}]);
		if (stack.length > 1) back(stack.length - 1);
		else show('');
	}
	function unpark() {
		if (!root || !parked) return;
		const ps = parked;
		parked = null;
		for (const [n, o] of ps) if (pages.has(n) && stack.indexOf(n) < 0) {
			opts[n] = o;
			stack.push(n);
			build(n);
		}
		show('push');
		move();
	}

	return {
		on(name, mount) {
			if (typeof mount !== 'function') throw new Error('DaimondStack.on: page "' + name + '" needs a mount function');
			pages.set(name, { mount, el: null });
		},
		push(name, o) {
			const p = pages.get(name);
			if (!p) throw new Error('DaimondStack.push: no page "' + name + '" is registered');
			if (!root) { if (o) opts[name] = o; begin(name); return p.el; }
			const at = stack.indexOf(name);
			// A page already on the stack is gone back to, never shown twice.
			if (at >= 0) {
				if (o) opts[name] = o;
				const n = stack.length - 1 - at;
				if (n > 0) back(n);
				return build(name);
			}
			opts[name] = o || {};
			stack.push(name);
			build(name);
			show('push');
			move();
			return p.el;
		},
		pop() {
			// The root page is the floor: there is nothing behind it to go back to.
			if (stack.length < 2) return null;
			const name = stack[stack.length - 1];
			back(1);
			return name;
		},
		top() {
			return stack.length ? stack[stack.length - 1] : null;
		},
		depth() {
			return stack.length;
		},
		/// The pages on the stack, floor first (a copy).
		pages() {
			return stack.slice();
		},
		/// Put the stack away at a wider width, and bring it back (phone_home.js).
		park,
		unpark,
		/// Begin with `name` as the floor, or where the history entry left off (a reload).
		start(name) {
			if (!pages.has(name)) throw new Error('DaimondStack.start: no page "' + name + '" is registered');
			if (!root) begin(name);
		},
		/// Has the stack begun (on a phone)?
		started() {
			return !!root;
		},
		/// Be told of each new top page: `f(top, depth, opts)`.
		watch(f) {
			seen.push(f);
			if (stack.length) f(stack[stack.length - 1], stack.length, opts[stack[stack.length - 1]] || {});
		},
		/// Bind a left-edge swipe to Back, in an installed PWA only: a standalone app
		/// has no browser back swipe, and in a Safari tab the browser's own does it,
		/// so binding one there would go back twice. Is it bound?
		bindEdgeBack(when) {
			const nav = w && w.navigator;
			const mm = w && w.matchMedia ? w.matchMedia('(display-mode: standalone)') : null;
			if (!((mm && mm.matches) || (nav && nav.standalone))) return false;
			const doc = (w && w.document) || document;
			let x0 = 0, y0 = 0, live = false;
			doc.addEventListener('touchstart', (e) => {
				live = false;
				if (stack.length < 2 || (when && !when())) return;
				const t = e.touches[0];
				if (t.clientX <= EDGE) { live = true; x0 = t.clientX; y0 = t.clientY; }
			}, { passive: true });
			doc.addEventListener('touchmove', (e) => {
				if (!live) return;
				const t = e.touches[0];
				if (Math.abs(t.clientY - y0) >= DRIFT) { live = false; return; }
				if (t.clientX - x0 > SWIPE) { live = false; if (hist) hist.back(); }	// a person's Back
			}, { passive: true });
			doc.addEventListener('touchend', () => { live = false; }, { passive: true });
			return true;
		},
	};
}

export const DaimondStack = newStack();
// For the classic shell scripts (js/mobile.js), which load before the modules.
if (typeof window !== 'undefined') window.DaimondStack = DaimondStack;
