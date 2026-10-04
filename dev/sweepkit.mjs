// sweepkit.mjs — the measurements a person makes with their eyes, made
// mechanically.
//
// The suite this joins has 290-odd verifier files and it was green while the app
// was visibly broken: a Social panel whose twenty notes were all 1565px below the
// fold with nothing to scroll, a closer 248px in from the corner it belongs in,
// four rail tiles where two belong. Every one of those is a thing a person sees
// in the first minute, and none of them is a value a `grep` or an `assertEqual`
// can reach. The difference this file exists to close is between
//
//   IS IT TRUE?      the store holds two Diamonds, the closer has a click handler,
//                    the note was written — all of which were true throughout;
//   IS IT VISIBLE,   an item of the list is inside the panel, the cross is in the
//   REACHABLE AND    corner, the point you would press belongs to the thing you
//   PRESSABLE?       meant to press.
//
// Everything here is MEASURED IN THE RENDERED PAGE. No rule is read out of a
// stylesheet and no state is inferred from a class name, so a fault arriving
// through a cascade nobody expected is caught the same as one that was written
// down.
//
// Four families, and the argument for each is the defect that got past the suite:
//
//   SEEN     a panel's own content is inside the panel, or can be scrolled to.
//            (Social: `.imp-notes` was 2606px tall in a 434px box, `overflow-y:
//            auto` inert because its parent was not a flex column, so the list
//            had no overflow to engage on and nothing would scroll.)
//   ANCHOR   a closer is in its panel's top-right corner, and every persistent
//            control keeps its coordinates when the app's state changes around
//            it. (Web: an ordinary URL moved the closer to 229px in and 65px
//            down. Top bar: a chip appearing shifts every button 86px left.)
//   PRESS    `elementFromPoint` at a control's centre is that control. A click
//            through Playwright with `force: true` lands whatever is on top,
//            so every click-based check passes on a covered button.
//   SINGULAR what should be drawn once is drawn once. (Four "Daimond Optimiser"
//            tiles, unchanged across a reload, and nothing counted them.)
//
// Imported by dev/verify_sweep_seen.mjs and dev/verify_sweep_used.mjs, which
// differ in ONE thing: the second runs the same families after the app has been
// used for a while. A check that only ever meets a freshly seeded world cannot
// find a fault that accumulates, and two of the eighteen defects were exactly
// that.

/// How far, in CSS pixels, a closer may sit from its panel's top-right corner.
///
/// The panel heads carry 8-15px of their own padding, so this is not zero; it is
/// the width of the corner rather than a tolerance on a measurement. Every panel
/// in the app but one measured within 15px on 2026-08-28, and the one that did
/// not was 248px.
export const CORNER = 24;

/// How far a control may move between two states before it counts as having moved.
///
/// Sub-pixel: a fractional layout box may round differently either side of a
/// reflow, and a control that has genuinely been displaced moves by tens of
/// pixels. Nothing in this tree has ever been found 1px out for an interesting
/// reason.
export const DRIFT = 1;

// ── The audit, as it runs in the page ────────────────────────────────────
//
// One function, stringified into the page by `audit()` below. It takes nothing
// and answers with plain data, so every judgement about what is a defect is made
// in node where it can be read.
export const AUDIT = function () {
	const out = [];
	const add = (family, what, where, detail) => out.push({ family, what, where, detail });

	/// A short, readable path to an element: enough to find it in the markup.
	const sel = (el) => {
		const bit = (e) => {
			if (e.id) return e.tagName.toLowerCase() + '#' + e.id;
			const cls = (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
			return e.tagName.toLowerCase() + cls.map((c) => '.' + c).join('');
		};
		const parts = [];
		for (let e = el, i = 0; e && e.nodeType === 1 && i < 3; e = e.parentElement, i++) {
			parts.unshift(bit(e));
			if (e.id) break;
		}
		return parts.join('>');
	};

	const cs   = (e) => getComputedStyle(e);
	const rect = (e) => e.getBoundingClientRect();
	/// What of this element is actually painted, after every ancestor entitled to
	/// clip it has had its say -- or null when nothing of it is.
	///
	/// A CLIPPED ELEMENT STILL HAS A FULL RECT, and reading that rect is the
	/// single mistake that would make this whole file cry wolf. The Social
	/// panel's twenty notes each report a 20px-tall box at coordinates inside the
	/// Trash panel next door; they are painted nowhere, because `.social` is
	/// `overflow: hidden` and the browser threw them away. Asked with the naked
	/// rect, every one of them is a control whose centre belongs to something
	/// else -- eleven such findings in the first run of this file, all of them
	/// noise, and noise is how a suite gets ignored.
	const painted = (el) => {
		let r = rect(el);
		if (r.width <= 0 || r.height <= 0) return null;
		const c = cs(el);
		if (c.visibility === 'hidden' || c.display === 'none') return null;
		let top = r.top, left = r.left, right = r.right, bottom = r.bottom;
		for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
			if (parseFloat(cs(e).opacity || '1') < 0.06) return null;
			if (e === el) continue;
			const ec = cs(e);
			// `visible` clips nothing; anything else clips to the padding box, and
			// a scroller clips there too -- what is outside it is reachable by
			// scrolling, which the SEEN family asks about separately.
			if (ec.overflowX === 'visible' && ec.overflowY === 'visible') continue;
			const er = rect(e);
			if (ec.overflowX !== 'visible') { left = Math.max(left, er.left); right = Math.min(right, er.right); }
			if (ec.overflowY !== 'visible') { top = Math.max(top, er.top); bottom = Math.min(bottom, er.bottom); }
			if (right - left <= 0 || bottom - top <= 0) return null;
		}
		return { top, left, right, bottom, width: right - left, height: bottom - top };
	};
	/// Drawn at all: painted somewhere, with area.
	const drawn = (el) => !!painted(el);
	/// Do two boxes share any area?
	const meets = (a, b) => a.right > b.left && a.left < b.right
		&& a.bottom > b.top && a.top < b.bottom;

	/// Can this element scroll on its block axis, and has it anything to scroll?
	const scrolls = (e) => {
		const c = cs(e);
		if (!/auto|scroll/.test(c.overflowY)) return false;
		return e.scrollHeight > e.clientHeight + 2;
	};

	/// The surface an element belongs to: the panel, bar, sheet, popover or
	/// dialog it is drawn inside. `body` for anything loose.
	/// `#admin` is in the list because it is a surface INSIDE a panel: the Admin
	/// drawer draws over the rail's own lists, so a rail tile behind it is behind
	/// a surface exactly as a panel behind the phone sheet is, and reading them
	/// as one surface makes every tile under it a false finding.
	const surface = (el) => el.closest('#admin, #msheet, .pop, [role="dialog"], .drawer, .panel, .topbar, .mnav') || document.body;

	const panels = [...document.querySelectorAll('.panel')].filter(drawn);

	// ── SEEN ──────────────────────────────────────────────────────────
	//
	// A LIST IS THE THING A PANEL IS FOR, so it is the thing asked about. A list
	// is taken to be any element holding three or more drawn children of one
	// tag: the notes, the rail's tiles, the trash, the agent cards, the mail
	// folders. Nothing here knows any of their names.
	//
	// The question is not "is an item on screen" but "CAN AN ITEM BE GOT TO",
	// which is what a person means. So an item that is out of the panel is
	// scrolled towards first, by the browser's own `scrollIntoView`, and asked
	// again. A list inside a working scroller passes whichever way it happens to
	// be scrolled when the audit arrives; a list with no scroller to engage does
	// not move and fails.
	for (const p of panels) {
		const pr = rect(p);
		const lists = [];
		for (const e of p.querySelectorAll('*')) {
			const kids = [...e.children].filter(drawn);
			if (kids.length < 3) continue;
			const tag = kids[0].tagName;
			if (kids.filter((k) => k.tagName === tag).length < 3) continue;
			// The innermost such element only: a list's own parent holds the same
			// three children and would be reported as a second finding.
			if (lists.some((l) => l.el.contains(e))) continue;
			lists.push({ el: e, kids });
		}
		for (const l of lists) {
			const inside = () => l.kids.some((k) => meets(rect(k), rect(p)));
			if (inside()) continue;
			// Ask the browser to bring the first item to the nearest edge, which is
			// exactly what a user's scroll would do, and ask again.
			try { l.kids[0].scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* detached */ }
			if (inside()) continue;
			const lr = rect(l.el);
			add('SEEN', 'a list with no item inside its panel and no way to scroll to one',
				sel(l.el), `${l.kids.length} item(s), ${Math.round(lr.height)}px of list in a `
				+ `${Math.round(pr.height)}px ${p.dataset.panel} panel; the first item's top is `
				+ `${Math.round(lr.top - pr.top)}px from the panel's own top`);
		}

		// AND THE PANEL'S CONTENT AS A WHOLE. A list is the sharp case; this is the
		// general one -- the union of everything drawn inside the panel, against the
		// panel's box, discounting anything a scroller in between can reach.
		let low = pr.top;
		for (const e of p.querySelectorAll('*')) {
			if (!drawn(e)) continue;
			// Under a scroller that works, so it is reachable by definition.
			let held = false;
			for (let a = e.parentElement; a && a !== p.parentElement; a = a.parentElement) {
				if (scrolls(a)) { held = true; break; }
			}
			if (held) continue;
			const r = rect(e);
			if (r.bottom > low) low = r.bottom;
		}
		const over = Math.round(low - pr.bottom);
		if (over > 4) {
			add('SEEN', 'content past the foot of its panel that no scroller can reach',
				`#${p.id}`, `${over}px below the panel's own bottom edge`);
		}

		// A SCROLLER THAT DOES NOT SCROLL is the same defect wearing the right
		// declaration. `overflow-y: auto` on a box whose parent gave it its
		// content's own height has nothing to engage on, and reads in the DOM as
		// a working scroller.
		for (const e of p.querySelectorAll('*')) {
			if (!scrolls(e)) continue;
			const was = e.scrollTop;
			e.scrollTop = was + 60;
			const moved = e.scrollTop !== was;
			e.scrollTop = was;
			if (!moved) {
				add('SEEN', 'a scrollable region that will not scroll', sel(e),
					`scrollHeight ${e.scrollHeight}, clientHeight ${e.clientHeight}`);
			}
		}
	}

	// ── ANCHOR: the corner ────────────────────────────────────────────
	//
	// A cross closes the one thing it sits on, and every panel in this app puts
	// it in the same place, which is the whole reason a person can find it
	// without looking. Measured against the panel's OWN corner and not the
	// window's, so a panel anywhere in any zone is asked the same question.
	for (const p of panels) {
		const pr = rect(p);
		const c = p.querySelector('.panel-close, .railhead .ui-close, .chead .ui-close');
		if (!c || !drawn(c)) continue;
		const cr = rect(c);
		const inRight = Math.round(pr.right - cr.right);
		const down    = Math.round(cr.top - pr.top);
		if (inRight > 24 || down > 24) {
			add('ANCHOR', 'a closer that is not in its panel\'s top-right corner',
				`#${p.id}`, `${inRight}px in from the right edge, ${down}px down from the top`);
		}
	}

	// ── PRESS ─────────────────────────────────────────────────────────
	//
	// The point, not the click. Playwright's `force: true` dispatches at a
	// control's coordinates whatever is on top of it, so a button under a stale
	// overlay passes every click-based check in this suite and fails every user.
	// `elementFromPoint` asks the document the question the browser will answer
	// when a finger lands there.
	const controls = [...document.querySelectorAll('button, a[href], [role="button"], input, select, textarea')];
	for (const c of controls) {
		// The PAINTED centre. A control half under the edge of a scroller is still
		// pressable on the half that shows, and its geometric centre is not where
		// a person aims.
		const r = painted(c);
		if (!r) continue;
		const x = Math.round(r.left + r.width / 2);
		const y = Math.round(r.top + r.height / 2);
		if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
		const hit = document.elementFromPoint(x, y);
		if (!hit) { add('PRESS', 'nothing at all at a control\'s centre', sel(c), `(${x}, ${y})`); continue; }
		if (hit === c || c.contains(hit) || hit.contains(c)) continue;
		// A label wrapping its own input, and the input's own text node, are the
		// same control by any reading a user would give it.
		if (hit.closest('button, a[href], [role="button"], label') === c.closest('button, a[href], [role="button"], label')) continue;
		// SAME SURFACE, OR ANOTHER ONE OVER THE TOP? The two are not the same
		// defect and one of them is not a defect at all. A phone puts a sheet over
		// the panel behind it and every control in that panel is then unpressable,
		// correctly; so is every panel under a dialog. What no surface is entitled
		// to do is cover a control it holds ITSELF, and that is what the header's
		// chips and every overlapping control in this app amount to.
		//
		// The line between a live sheet and a stale one left behind is NOT
		// decidable from geometry -- both are a positioned box over the app -- so
		// it is not guessed at here. `behind` is counted, named by the surface
		// doing the covering, and left for a person; `covered` is the failure.
		if (surface(c) === surface(hit)) {
			add('PRESS', 'a control whose centre belongs to something else in its own surface',
				sel(c), `(${x}, ${y}) is ${sel(hit)}`);
		} else {
			add('BEHIND', 'a control under another surface', sel(c), `under ${sel(surface(hit))}`);
		}
	}

	// ── SINGULAR ──────────────────────────────────────────────────────
	//
	// Four "Daimond Optimiser" tiles in one rail were visible immediately and
	// nothing in 290 verifier files counted them. They were four distinct
	// records, so every check that asked the store agreed with every check that
	// asked the rail, and both were wrong about the same thing.
	{
		const ids = {};
		for (const e of document.querySelectorAll('[id]')) ids[e.id] = (ids[e.id] || 0) + 1;
		for (const k of Object.keys(ids)) {
			if (ids[k] > 1) add('SINGULAR', 'an element id used more than once', '#' + k, `${ids[k]} elements`);
		}
	}
	{
		const seen = {};
		// `.panel` and not `[data-panel]`: the resize handles and the header's chips
		// each carry the attribute to say which panel they act on, so the bare
		// attribute selector counted three "rail" panels and two of everything else.
		for (const e of document.querySelectorAll('.panel[data-panel]')) {
			seen[e.dataset.panel] = (seen[e.dataset.panel] || 0) + 1;
		}
		for (const k of Object.keys(seen)) {
			if (seen[k] > 1) add('SINGULAR', 'a panel declared more than once', `[data-panel="${k}"]`, `${seen[k]}`);
		}
	}
	{
		// THE RAIL, BY THE WORDS ON THE TILES, which is the only reading a person
		// can give it. Two Diamonds may legitimately share a name -- a user may
		// make two -- so this is reported and the verifier decides; against a rail
		// the app seeded itself, two of a name is the defect.
		const list = document.getElementById('diamond-list');
		if (list) {
			const names = {};
			for (const tile of list.children) {
				if (tile.classList.contains('rail-note')) continue;
				const n = (tile.textContent || '').trim().split('\n')[0].trim();
				if (!n) continue;
				names[n] = (names[n] || 0) + 1;
			}
			for (const k of Object.keys(names)) {
				if (names[k] > 1) add('SINGULAR', 'a rail tile name drawn more than once', '#diamond-list', `"${k}" x${names[k]}`);
			}
		}
	}
	for (const p of panels) {
		const n = [...p.querySelectorAll('.panel-close')].filter(drawn).length;
		if (n > 1) add('SINGULAR', 'a panel with more than one closer', `#${p.id}`, `${n}`);
	}

	return out;
};

/// Run the in-page audit and answer with its findings.
export async function audit(page) {
	return page.evaluate(`(${AUDIT.toString()})()`);
}

// ── ANCHOR: does it stay there? ──────────────────────────────────────────
//
// The half a single snapshot cannot see. Two of the eighteen defects were a
// control that was perfectly placed until the app's state moved underneath it:
// the Web panel's closer under an ordinary URL, and every button in the top bar
// while a sync chip is on screen. The owner's own words for the rule are the
// ones encoded here -- A TRANSIENT ELEMENT MUST NEVER SIT IN THE FLOW OF
// CLICKABLE TARGETS -- and a rule about two states cannot be checked in one.
//
// Identity across the two measurements is a stamped attribute and not a
// selector: a row of tags all carrying the same class cannot be matched by
// class, and matching by index silently pairs the wrong two the moment the
// number of items changes.

/// Stamp every drawn control, and answer with where each one is.
///
/// `scope` narrows it to one surface. A state change is entitled to reflow
/// things it is about -- opening a page in the Web panel takes the Web chip out
/// of the header's row, and every chip after it moves, correctly -- so a drift
/// check that asks the whole document about a change in one panel is asking the
/// wrong question and gets a wrong answer.
export async function positions(page, scope = null) {
	return page.evaluate((scope) => {
		const root = scope ? document.querySelector(scope) : document;
		if (!root) return {};
		const drawn = (e) => {
			const r = e.getBoundingClientRect();
			if (r.width <= 0 || r.height <= 0) return false;
			const c = getComputedStyle(e);
			return c.visibility !== 'hidden' && c.display !== 'none';
		};
		const out = {};
		// THE COUNTER BELONGS TO THE PAGE, NOT TO THE CALL. It was a local `let n =
		// 0`, so a second reading that met a newly drawn element handed it 'c1' --
		// a key an already-stamped element was holding from the first reading --
		// and `drifted` then compared two different controls and reported a
		// phantom. Seen on 2026-08-28: revealing a chip in the rail's status strip
		// reported the top bar's brand link as having moved 244px across and 754px
		// down, which is not a thing that can happen.
		if (typeof window.__nsweepN !== 'number') window.__nsweepN = 0;
		for (const e of root.querySelectorAll('button, a[href], [role="button"]')) {
			if (!drawn(e)) continue;
			if (!e.dataset.nsweep) e.dataset.nsweep = 'c' + (++window.__nsweepN);
			const r = e.getBoundingClientRect();
			out[e.dataset.nsweep] = {
				x: Math.round(r.x), y: Math.round(r.y),
				name: e.id || (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 28)
					|| String(e.className).slice(0, 28),
			};
		}
		return out;
	}, scope);
}

/// What moved between two `positions()` readings, for controls present in both.
///
/// A control that appeared or went away is not drift and is not reported: the
/// question is whether the things that STAYED kept their coordinates.
export function drifted(before, after, tol = DRIFT) {
	const out = [];
	for (const k of Object.keys(before)) {
		const a = after[k];
		if (!a) continue;
		const b = before[k];
		const dx = a.x - b.x, dy = a.y - b.y;
		if (Math.abs(dx) <= tol && Math.abs(dy) <= tol) continue;
		out.push({ name: b.name, dx, dy, from: [b.x, b.y], to: [a.x, a.y] });
	}
	return out;
}

/// Every transient this page holds in a row of persistent controls.
///
/// A transient is an element the app itself shows and hides: `hidden` in the
/// markup, or an inline `display: none` its own module lifts. `#update-chip`,
/// `#chunk-chip` and `#sync-chip` are all of them in the top bar, and the third
/// is built lazily by sync.js on the first status it has to report -- so a page
/// that has never reached a gateway does not hold one, and this answers with
/// what is actually there rather than with a list somebody has to keep.
export async function transients(page, rowSel) {
	return page.evaluate((rowSel) => {
		const row = document.querySelector(rowSel);
		if (!row) return [];
		const out = [];
		// AND THIS COUNTER BELONGS TO THE PAGE TOO, for the reason the one in
		// `positions` does and with a sharper edge: this function is now asked
		// about MORE THAN ONE ROW in a run, and a per-call counter gives the first
		// hidden element of the second row the same `t1` the first row's already
		// holds. `reveal` looks its element up by that key alone, document-wide,
		// so it would have shown the wrong row's transient and measured the drift
		// of a control nobody touched.
		if (typeof window.__nsweepT !== 'number') window.__nsweepT = 0;
		// DESCENDANTS, NOT CHILDREN, and named ones. `row.children` missed every
		// transient that had been nested one level to make it stop displacing
		// things -- which is the fix, so the check went quiet exactly when it had
		// most to prove. An id is what separates a hidden CONTROL from the hidden
		// spans inside one: every transient this app shows and hides has one, and
		// `.astat-dot` and `.stext` do not.
		for (const e of row.querySelectorAll('[id]')) {
			const c = getComputedStyle(e);
			const hidden = e.hasAttribute('hidden') || c.display === 'none'
				|| e.getBoundingClientRect().width === 0;
			if (!hidden) continue;
			if (!e.dataset.nsweepT) e.dataset.nsweepT = 't' + (++window.__nsweepT);
			out.push({ key: e.dataset.nsweepT, name: e.id || String(e.className) || e.tagName });
		}
		return out;
	}, rowSel);
}

/// Show one transient exactly as its own module shows it, and answer with an
/// undo.
///
/// `hidden` comes off and an inline `display: none` is replaced with the value
/// the module writes (`inline-flex` for both chips in the top bar). Text is put
/// in an empty label, because a chip with no words is a chip with no width and
/// would prove nothing.
export async function reveal(page, key, word) {
	return page.evaluate(({ key, word }) => {
		const e = document.querySelector(`[data-nsweep-t="${key}"]`);
		if (!e) return false;
		e.dataset.nsweepWas = JSON.stringify({
			hidden: e.hasAttribute('hidden'), display: e.style.display,
		});
		e.removeAttribute('hidden');
		if (getComputedStyle(e).display === 'none') e.style.display = 'inline-flex';
		const label = e.querySelector('.stext, .ctext');
		if (label && !label.textContent.trim()) label.textContent = word;
		return true;
	}, { key, word });
}

/// Put a revealed transient back exactly as it was.
export async function restore(page, key) {
	return page.evaluate((key) => {
		const e = document.querySelector(`[data-nsweep-t="${key}"]`);
		if (!e || !e.dataset.nsweepWas) return false;
		const was = JSON.parse(e.dataset.nsweepWas);
		if (was.hidden) e.setAttribute('hidden', '');
		e.style.display = was.display;
		delete e.dataset.nsweepWas;
		return true;
	}, key);
}

// ── The world the panels are asked about ─────────────────────────────────

/// The four shapes a person actually holds the app in.
///
/// The phone is an iPhone 14/15's CSS viewport at DPR 3, which is what
/// `verify_sweep_mobile` uses and what the owner's own device reports. It is
/// emulated geometry in a Chromium, and the limits of that are stated in each
/// verifier's header rather than here.
export const SHAPES = [
	{ name: 'desktop', width: 1500, height: 950 },
	{ name: 'laptop',  width: 1280, height: 800 },
	{ name: 'narrow',  width: 1024, height: 768 },
	{ name: 'iphone',  width: 390,  height: 844 },
];

/// Twenty notes kept, which is the state the Social panel was reported in.
///
/// Written to the key improve.js reads and then reloaded, rather than driven
/// through twenty presses of Keep: the panel's own write path is exercised by
/// dev/verify_improve.mjs, and what is wanted here is the FULL panel that path
/// eventually produces.
export async function seedNotes(page, n = 20) {
	await page.evaluate((n) => {
		const now = Date.now();
		const notes = [];
		for (let i = 0; i < n; i++) {
			notes.push({
				id: 'nsweep' + i, at: now - i * 1000,
				text: 'Note ' + (i + 1) + ': a sentence of the length somebody actually writes '
					+ 'when they have just been irritated by something.',
				sent: 0, n: 0, into: [],
			});
		}
		localStorage.setItem('daimond-improve', JSON.stringify({ v: 3, notes }));
	}, n);
}

/// Open exactly this set of panels, closing whatever else is open first.
///
/// THE CLOSING IS NOT TIDINESS. A zone seats a fixed number -- the dock's is its
/// grid, `cols x rows` -- and `show` on a full zone evicts to make room. Asked
/// for six dock panels in three rounds without closing between them, the third
/// round's two were seated and then immediately evicted by the reflow, and the
/// round reported them as never having opened. Every measurement in it would
/// otherwise have been of the previous round's panels under this round's name.
///
/// THE RAIL IS KEPT unless it is asked for by name. It is a zone of its own and
/// it is where the app's own controls live -- the new-chat button among them --
/// so closing it turns every later step into "element is not visible" on a
/// button that is perfectly fine. It is still swept: it is a panel like any
/// other and the audit walks whatever is drawn.
export async function showPanels(page, ids) {
	await page.evaluate((ids) => {
		const P = window.DaimondPanels;
		if (!P) return;
		const keep = ids.includes('rail') ? ids : ids.concat(['rail']);
		for (const d of P.panels()) {
			if (keep.includes(d.id)) continue;
			try { P.hide(d.id); } catch (e) { /* a panel that will not close says so below */ }
		}
		if (!P.isOpen('rail')) { try { P.show('rail'); } catch (e) { /* no rail here */ } }
		for (const id of ids) { try { P.show(id); } catch (e) { /* not a panel here */ } }
		try { P.reflow(); } catch (e) { /* no engine */ }
	}, ids);
	await page.waitForTimeout(700);
}

/// Which panels are open, as the engine sees them.
export async function openPanels(page) {
	return page.evaluate(() => {
		try {
			return window.DaimondPanels.panels().map((p) => p.id)
				.filter((id) => window.DaimondPanels.isOpen(id));
		} catch (e) { return []; }
	});
}
