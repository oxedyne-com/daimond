// probe_burger.mjs — does the phone hamburger stop opening the drawer after a
// while, and does it track the SIZE of the transcript or the LIFE of the session?
//
// The report is "in iOS after modestly long chat use, the main hamburger icon
// left in the header for mobile view stops working". Two entirely different
// bugs answer to that sentence, so this drives both arms separately:
//
//   --arm size   a transcript is made big AT ONCE (no turns), so nothing has
//                accumulated except nodes.
//   --arm time   many short turns, each leaving almost nothing on screen, so
//                nothing has accumulated except events and elapsed life.
//   --arm both   (default) size first in one page, then time in a fresh one.
//
// THE PROBE IS PROVED BEFORE IT IS BELIEVED. `--break <name>` makes the
// hamburger dead by one named mechanism and the run must report it dead AND name
// that mechanism; a probe that can only see a scrim will report "not
// reproduced" in a world where the listener was lost.
//
//   node dev/probe_burger.mjs --break h1-cover     # an overlay over the header
//   node dev/probe_burger.mjs --break h2-rebind    # the button node replaced
//   node dev/probe_burger.mjs --break h3-block     # the main thread blocked
//   node dev/probe_burger.mjs --break h4-latch     # the open/closed state desynced
//   node dev/probe_burger.mjs --arm both           # and then, for real
//
// Engine: WebKit by default, because an iPhone runs WebKit. `--engine chromium`
// is for when this host's WebKit will not launch; it is a different engine and
// the report must say so.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { signInAs, connectMock, APP, scratch, MOCK, MODEL } from './harness.mjs';

const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const arg = (name, dflt) => {
	const i = process.argv.indexOf('--' + name);
	return i > 0 ? String(process.argv[i + 1] || '') : dflt;
};
const ARM    = arg('arm', 'both');
const BREAK  = arg('break', '');
const ENGINE = arg('engine', 'webkit');
const TURNS  = Number(arg('turns', '24'));
const GROW   = Number(arg('grow', '4000'));	// synthetic messages for the size arm
const HEADED = process.argv.includes('--headed');

const BREAKS = {
	'h1-cover':  'an invisible fixed overlay lies over the top bar',
	'h2-rebind': 'the button node is replaced, so its listener is on a node that has gone',
	'h3-block':  'the main thread is blocked, so no event is processed',
	'h4-latch':  'the drawer believes it is already open, so the toggle closes nothing',
	// The last two are not simulations: each serves the real file with the real
	// fix taken out, which is what makes them proof rather than illustration.
	'noelse':    "apply()'s phone branch does not put the rail's display back",
	'nomq':      'apply() is not run again when the breakpoint itself flips',
};

/// The two halves of the fix, each removable, so the probe can be pointed at the
/// world before it. Served through `page.route` in place of the real file.
const SOURCE_BREAKS = {
	noelse: {
		file: 'js/daimond.js',
		re:   /\t\t\t\} else \{\n\t\t\t\t\/\/ AND THE RAIL IS PUT BACK[\s\S]*?\n\t\t\t\}/,
		with: '\t\t\t}',
	},
	nomq: {
		file: 'js/daimond.js',
		re:   /\t\t\tif \(mobileMq\.addEventListener\) mobileMq\.addEventListener\('change', apply\);\n\t\t\telse if \(mobileMq\.addListener\) mobileMq\.addListener\(apply\);\n/,
		with: '',
	},
};

/// The file with that half removed, or a hard stop: an anchor that is not there
/// exactly once removed nothing, and the run would prove nothing.
function damagedSource(name) {
	const spec = SOURCE_BREAKS[name];
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = (src.match(new RegExp(spec.re.source, 'g')) || []).length;
	if (n !== 1) {
		console.error(`break '${name}': the shape matches ${n} time(s) in ${spec.file}.`);
		process.exit(2);
	}
	return { file: spec.file, body: src.replace(spec.re, spec.with) };
}
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

const PW = process.env.DAIMOND_PW || path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const pw = await import(pathToFileURL(PW).href);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const iph = pw.devices['iPhone 13'];

async function launch(tag) {
	const dir = scratch(`burger-${ENGINE}-${tag}-${process.pid}`);
	const common = {
		viewport:          iph.viewport,
		deviceScaleFactor: iph.deviceScaleFactor,
		userAgent:         iph.userAgent,
		hasTouch:          true,
		timeout:           60000,
		headless:          !HEADED,
	};
	if (ENGINE === 'chromium') {
		return pw.chromium.launchPersistentContext(dir, { ...common, isMobile: true });
	}
	// WebKit rejects `isMobile`.
	return pw.webkit.launchPersistentContext(dir, common);
}

// ── The verdict: is the hamburger alive? ─────────────────────────────────
//
// Not "did a click succeed" alone. Every hypothesis leaves a different
// fingerprint, so all of them are read on every pass and the failing one names
// itself.
const READ = `(() => {
	const btn  = document.getElementById('drawer-btn');
	const rail = document.getElementById('panel-rail');
	const out  = document.getElementById('chat-output');
	const r    = btn ? btn.getBoundingClientRect() : null;
	const cx   = r ? Math.round(r.left + r.width / 2) : -1;
	const cy   = r ? Math.round(r.top + r.height / 2) : -1;
	const at   = (r && r.width) ? document.elementFromPoint(cx, cy) : null;
	const desc = e => !e ? '(nothing)'
		: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')
		  + (e.className && typeof e.className === 'string' && e.className.trim()
		     ? '.' + e.className.trim().split(/\\s+/).join('.') : '');
	const rr = rail ? rail.getBoundingClientRect() : null;
	return {
		nodes:     out ? out.querySelectorAll('*').length : 0,
		msgs:      out ? out.children.length : 0,
		btn:       !!btn,
		w:         r ? Math.round(r.width) : 0,
		h:         r ? Math.round(r.height) : 0,
		cx, cy,
		// H1: what is really at the point a thumb lands on.
		at:        desc(at),
		covered:   !!(btn && at && at !== btn && !btn.contains(at)),
		// H2: is this the node the listener was put on?
		sameNode:  !!(btn && window.__pbBtn === btn),
		mark:      !!(btn && btn.dataset && btn.dataset.pbMark === '1'),
		// H4: what the shell believes.
		open:      document.body.classList.contains('drawer-open'),
		railLeft:  rr ? Math.round(rr.left) : null,
		railW:     rr ? Math.round(rr.width) : null,
		// The drawer is on screen when the rail's left edge has come back to 0.
		drawer:    !!(rr && rr.width > 100 && rr.left > -8),
		// H4's own fingerprint: the class can toggle perfectly on a rail that is
		// not drawn at all.
		railDisp:  rail ? getComputedStyle(rail).display : '',
		railInline: rail ? rail.style.display : '',
		pointer:   btn ? getComputedStyle(btn).pointerEvents : '',
		disp:      btn ? getComputedStyle(btn).display : '',
		heap:      (performance.memory && performance.memory.usedJSHeapSize) || 0,
	};
})()`;

/// An `evaluate` that gives up rather than waiting out a blocked thread.
///
/// Waiting is what made the first version of this probe blind to H3: it asked
/// the page a question, the page answered ten seconds later, and by then the
/// block was over and the press worked. A refusal to wait is the observation.
async function ev(page, fn, arg, ms = 1200) {
	let timer;
	const bell = new Promise(r => { timer = setTimeout(() => r('__pbTimeout'), ms); });
	const out = await Promise.race([page.evaluate(fn, arg).catch(() => '__pbTimeout'), bell]);
	clearTimeout(timer);
	return out;
}

/// The longest the page went unattended since this was last called.
async function gap(page) {
	const g = await ev(page, () => { const g = window.__pbGap || 0; window.__pbGap = 0; return g; });
	return g === '__pbTimeout' ? Infinity : g;
}

/// Press the hamburger the way a thumb does: at its coordinates, through the
/// hit test, with no `force` to paper over anything lying on top of it.
async function pressBurger(page, s) {
	// NOTHING is reset here. Clearing `drawer-open` before the press would
	// destroy the very desynchronisation H4 is about -- the probe would heal the
	// fault it was built to find, and report the button healthy.
	if (!s.cx || s.cx < 0) return { pressed: false, after: s };
	// A real tap, since a phone has no mouse. Both are dispatched through the
	// engine's hit test, so an overlay eats them exactly as it would a thumb.
	await page.touchscreen.tap(s.cx, s.cy).catch(() => {});
	await sleep(500);
	let after = await ev(page, new Function('return ' + READ));
	// The tap WAS received if it flipped the class -- and a second press would
	// flip it back, hiding the very evidence that the press arrived and the
	// drawer did not. One press is the whole experiment in that case.
	if (after !== '__pbTimeout' && after.open && !after.drawer) return { pressed: true, after };
	if (after === '__pbTimeout' || !after.drawer) {
		// WebKit does not always synthesise a click from a bare tap; a mouse
		// click at the same point is the same hit test and is not a bypass.
		await page.mouse.click(s.cx, s.cy).catch(() => {});
		await sleep(500);
		after = await ev(page, new Function('return ' + READ));
	}
	return { pressed: true, after: after === '__pbTimeout' ? null : after };
}

/// Is some OTHER control in the header still alive? The single observation that
/// separates "the whole thread is dead" from "this one button is dead".
async function neighbourAlive(page) {
	// The drawer slides for 280ms and covers 344 of a 390px screen while it does,
	// About included -- so a click sent the instant the drawer is asked to close
	// lands on the drawer and reports a healthy button dead.
	await ev(page, () => { document.body.classList.remove('drawer-open'); });
	await sleep(600);
	const r = await page.evaluate(() => {
		const b = document.getElementById('about-btn');
		if (!b) return null;
		const q = b.getBoundingClientRect();
		return { cx: Math.round(q.left + q.width / 2), cy: Math.round(q.top + q.height / 2) };
	});
	if (!r) return null;
	await page.mouse.click(r.cx, r.cy).catch(() => {});
	await sleep(400);
	// About is built at the moment it is asked for, as `div.modal.dlg` appended
	// to the body -- there is no markup to look for until the button works.
	const open = await page.evaluate(() => {
		const d = document.querySelector('body > .modal.dlg');
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		return vis(d);
	});
	// Put it back.
	await page.keyboard.press('Escape').catch(() => {});
	await sleep(250);
	return open;
}

/// Which of the five worlds this pass is in.
///
/// The order is not cosmetic. A blocked thread hides every other symptom (the
/// state cannot even be read), and a stuck `drawer-open` puts the scrim over the
/// button — which reads as H1 unless H4 is asked about first.
function verdict(before, res, gapMs) {
	if (!before) return { dead: true, why: `H3 — the page never answered; it went ${gapMs}ms unattended` };
	const a = res.after || before;
	if (a.drawer) return { dead: false, why: 'the drawer opened' };
	if (gapMs > 1500) return { dead: true, why: `H3 — the main thread went ${gapMs}ms unattended, so the press was never processed` };
	if (before.open) return { dead: true, why: `H4 — the shell already believed the drawer was open while it was off screen (press landed on ${before.at})` };
	if (before.covered) return { dead: true, why: `H1 — the press lands on ${before.at}, not on the button` };
	if (!before.sameNode || !before.mark) return { dead: true, why: 'H2 — the button in the document is not the node the listener was bound to' };
	if (a.open && a.railDisp === 'none') return { dead: true, why: `H4 — the class toggled and the rail is display:${a.railDisp} (inline '${a.railInline}'), so nothing is drawn` };
	if (a.open && !a.drawer) return { dead: true, why: 'H4 — the class toggled but the drawer did not come on screen' };
	if (!before.btn || !before.w) return { dead: true, why: `the button is not on screen (display:${before.disp}, ${before.w}x${before.h})` };
	return { dead: true, why: 'the press reached the button and nothing happened (listener gone, or the handler returned early)' };
}

async function pass(page, label) {
	let s = await ev(page, new Function('return ' + READ));
	if (s === '__pbTimeout') s = null;
	const res = await pressBurger(page, s || { cx: 20, cy: 30 });
	const gapMs = await gap(page);
	const v = verdict(s, res, gapMs);
	// Leave it closed for the next pass.
	await ev(page, () => { document.body.classList.remove('drawer-open'); });
	const shown = s || res.after || {};
	const line = `  ${label.padEnd(22)} nodes=${String(shown.nodes ?? '?').padStart(6)} msgs=${String(shown.msgs ?? '?').padStart(4)}`
		+ ` gap=${String(gapMs).padStart(5)}ms at=${String(shown.at || '(unread)').slice(0, 40).padEnd(40)}`
		+ ` -> ${v.dead ? 'DEAD  ' : 'alive '} ${v.dead ? v.why : ''}`;
	console.log(line);
	return { label, s: shown, v, gapMs };
}

async function applyBreak(page) {
	if (!BREAK || SOURCE_BREAKS[BREAK]) return;
	await page.evaluate((which) => {
		if (which === 'h1-cover') {
			const d = document.createElement('div');
			d.id = 'pb-cover';
			d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:transparent';
			document.body.appendChild(d);
		} else if (which === 'h2-rebind') {
			const b = document.getElementById('drawer-btn');
			if (b) b.replaceWith(b.cloneNode(true));
		} else if (which === 'h3-block') {
			// Ten seconds of arithmetic, started now, so every event queued
			// behind it waits — which is what a synchronous re-render does.
			setTimeout(() => { const end = Date.now() + 30000; while (Date.now() < end) { /* burn */ } }, 0);
		} else if (which === 'h4-latch') {
			document.body.classList.add('drawer-open');
			const rail = document.getElementById('panel-rail');
			if (rail) rail.style.display = 'none';	// what `hide('rail')` does
		}
	}, BREAK);
	await sleep(50);
}

async function setUp(tag) {
	const ctx = await launch(tag);
	const page = ctx.pages()[0] || await ctx.newPage();
	await ctx.addInitScript(COUNT_LISTENERS);
	if (SOURCE_BREAKS[BREAK]) {
		const { file, body } = damagedSource(BREAK);
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
	const errs = [];
	page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
	page.on('pageerror', e => errs.push('pageerror: ' + e.message));
	const s = { browser: ctx, page, errs, logs: [], name: 'burgertester', close: () => ctx.close() };
	await page.goto(APP, { waitUntil: 'domcontentloaded' });
	await sleep(600);
	await signInAs(s, 'burgertester');
	await connectMock(s, { baseUrl: MOCK, model: MODEL });
	await page.evaluate(() => { try { window.DaimondAdmin.closeModal(); } catch (e) {} });
	await page.evaluate(() => { document.body.classList.remove('drawer-open'); });
	await sleep(400);
	// Mark the button so a later pass can tell whether this is still it.
	//
	// And start a heartbeat. A blocked main thread cannot be measured from
	// outside -- every `evaluate` simply waits for it, and by the time the answer
	// comes back the thread is free again and the press succeeds. The page has to
	// keep its own record of the longest it went unattended, which is read
	// afterwards.
	await page.evaluate(() => {
		const b = document.getElementById('drawer-btn');
		if (b) { b.dataset.pbMark = '1'; window.__pbBtn = b; }
		window.__pbGap = 0;
		let last = Date.now();
		setInterval(() => {
			const now = Date.now();
			if (now - last > window.__pbGap) window.__pbGap = now - last;
			last = now;
		}, 40);
	});
	return { ctx, page, s };
}

/// Start a chat and say something, without the harness's newChat, which is
/// written for a desktop rail.
async function startChat(page) {
	await page.evaluate(() => {
		document.body.classList.remove('drawer-open');
		const b = document.getElementById('new-session-btn');
		if (b) b.click();
	});
	await sleep(600);
	await page.evaluate(() => {
		const t = document.querySelector('.tile-start');
		if (t) t.click();
	});
	await page.waitForSelector('#chat-input', { state: 'visible', timeout: 15000 });
	await sleep(300);
}

async function turn(page, text, timeout = 25000) {
	await page.evaluate(() => { document.body.classList.remove('drawer-open'); });
	await page.fill('#chat-input', text);
	await page.click('#chat-send', { force: true });
	await sleep(250);
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const busy = await page.evaluate(() => {
			const b = document.getElementById('chat-send');
			if (!b) return false;
			const t = (b.getAttribute('title') || '') + (b.className || '');
			return /stop/i.test(t) || b.disabled;
		}).catch(() => false);
		if (!busy) break;
		await sleep(200);
	}
	await sleep(200);
}

/// Everything POSITIONED that overlaps the hamburger's centre, whatever it looks
/// like. An overlay that is transparent, or one pixel of a menu that was never
/// removed, is invisible to a screenshot and obvious here.
const CENSUS = `(() => {
	const b = document.getElementById('drawer-btn');
	if (!b) return ['(no button)'];
	const r = b.getBoundingClientRect();
	const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
	const desc = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')
		+ (e.className && typeof e.className === 'string' && e.className.trim()
			? '.' + e.className.trim().split(/\\s+/).join('.') : '');
	const out = [];
	document.querySelectorAll('*').forEach(el => {
		if (el === b || b.contains(el) || el.contains(b)) return;
		const cs = getComputedStyle(el);
		if (cs.position === 'static') return;
		const q = el.getBoundingClientRect();
		if (q.width < 1 || q.height < 1) return;
		if (cx < q.left || cx > q.right || cy < q.top || cy > q.bottom) return;
		out.push(desc(el) + ' z=' + cs.zIndex + ' pe=' + cs.pointerEvents
			+ ' op=' + cs.opacity + ' vis=' + cs.visibility);
	});
	return out;
})()`;

/// Listeners, counted from before the first line of app code runs.
///
/// A handler bound once per turn is invisible in every other reading: the DOM
/// does not grow, nothing covers anything, and the page answers instantly right
/// up to the moment it does not.
const COUNT_LISTENERS = () => {
	window.__pbLis = {};
	const add = EventTarget.prototype.addEventListener;
	const rem = EventTarget.prototype.removeEventListener;
	const key = (t, type) => (t === window ? 'window' : t === document ? 'document'
		: (t && t.nodeType === 1 ? (t.id ? '#' + t.id : t.tagName.toLowerCase()) : 'other')) + ':' + type;
	EventTarget.prototype.addEventListener = function (type, fn, opt) {
		try { const k = key(this, type); window.__pbLis[k] = (window.__pbLis[k] || 0) + 1; } catch (e) {}
		return add.call(this, type, fn, opt);
	};
	EventTarget.prototype.removeEventListener = function (type, fn, opt) {
		try { const k = key(this, type); window.__pbLis[k] = (window.__pbLis[k] || 0) - 1; } catch (e) {}
		return rem.call(this, type, fn, opt);
	};
};

/// The top ten listener keys, so a leak names itself.
async function listeners(page) {
	const l = await ev(page, () => Object.entries(window.__pbLis || {})
		.sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0] + '=' + e[1]));
	return l === '__pbTimeout' ? ['(unread)'] : l;
}

const results = [];

// ── SIZE: a big transcript, at once ──────────────────────────────────────
if (ARM === 'size' || ARM === 'both') {
	console.log(`\n[size] ${GROW} synthetic messages injected at once, no turns\n`);
	const { ctx, page } = await setUp('size');
	await startChat(page);
	await applyBreak(page);
	results.push(await pass(page, 'size: empty'));
	for (const n of [250, 1000, 2500, GROW]) {
		await page.evaluate((n) => {
			const out = document.getElementById('chat-output');
			if (!out) return;
			const have = out.querySelectorAll('.chat-msg-asst, .chat-msg-user').length;
			for (let i = have; i < n; i++) {
				const d = document.createElement('div');
				d.className = i % 2 ? 'chat-msg chat-msg-user' : 'chat-msg chat-msg-asst';
				d.setAttribute('data-turn', String(i >> 1));
				d.innerHTML = '<div class="msg-body"><p>' + 'filler '.repeat(24) + i + '</p></div>';
				out.appendChild(d);
			}
			out.scrollTop = out.scrollHeight;
		}, n);
		await sleep(300);
		results.push(await pass(page, `size: ${n} msgs`));
	}
	await ctx.close();
}

// ── TIME: many short turns ───────────────────────────────────────────────
if (ARM === 'time' || ARM === 'both') {
	console.log(`\n[time] ${TURNS} short turns, each leaving one line on screen\n`);
	const { ctx, page } = await setUp('time');
	await startChat(page);
	await applyBreak(page);
	results.push(await pass(page, 'time: turn 0'));
	for (let i = 1; i <= TURNS; i++) {
		await turn(page, `@text ok ${i}`);
		if (i % 2 === 0 || i === TURNS) results.push(await pass(page, `time: turn ${i}`));
	}
	const alive = await neighbourAlive(page);
	console.log(`  neighbour (#about-btn) alive: ${alive}`);
	await ctx.close();
}


// ── SOAK: a session lived rather than driven ─────────────────────────────
//
// The two arms above each isolate one variable, which is what they are for. A
// phone session is neither: long answers, a sheet raised and dropped, the
// composer focused, the chat scrolled, and the app put in the background every
// few turns because that is what a phone does. The hamburger is NOT pressed
// until the end -- pressing it every other turn is how the first version of this
// probe healed anything that might have gone wrong.
if (ARM === 'soak') {
	console.log(`\n[soak] ${TURNS} turns of a lived session; the burger is left alone until the end\n`);
	const { ctx, page } = await setUp('soak');
	await startChat(page);
	await applyBreak(page);
	results.push(await pass(page, 'soak: turn 0'));
	console.log('  listeners at start: ' + (await listeners(page)).join(' '));
	for (let i = 1; i <= TURNS; i++) {
		const long = 'word'.repeat(1) + ' lorem ipsum dolor sit amet '.repeat(60);
		await turn(page, i % 3 === 0 ? `@text ${long}` : `@text short answer ${i}`);
		// The composer, focused and blurred: on a phone that is the keyboard
		// coming up and going down, and with it a visualViewport resize.
		await ev(page, () => {
			const c = document.getElementById('chat-input');
			if (c) { c.focus(); c.blur(); }
			if (window.visualViewport) window.visualViewport.dispatchEvent(new Event('resize'));
		});
		// Scrolling back and forward through the transcript.
		await ev(page, () => {
			const o = document.getElementById('chat-output');
			if (o) { o.scrollTop = 0; o.dispatchEvent(new Event('scroll')); o.scrollTop = o.scrollHeight; }
		});
		if (i % 4 === 0) {
			// A sheet up and down: the one surface a phone has that a desktop does not.
			await ev(page, () => { try { window.DaimondPanels.show('web'); } catch (e) {} });
			await sleep(400);
			await ev(page, () => { try { window.DaimondSheet.close(); } catch (e) {} });
			await sleep(300);
		}
		if (i % 5 === 0) {
			// The app switch. Playwright cannot really background a tab, so the
			// events a background raises are dispatched instead -- which is what
			// the app's own handlers listen for.
			await ev(page, () => {
				Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
				document.dispatchEvent(new Event('visibilitychange'));
				window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
			});
			await sleep(400);
			await ev(page, () => {
				Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
				document.dispatchEvent(new Event('visibilitychange'));
				window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
				window.dispatchEvent(new Event('resize'));
			});
			await sleep(400);
		}
		if (i % 6 === 0) {
			const c = await ev(page, new Function('return ' + CENSUS));
			if (Array.isArray(c) && c.length) console.log(`  turn ${i} over the burger: ${c.join(' | ')}`);
		}
	}
	console.log('  listeners at end:   ' + (await listeners(page)).join(' '));
	const c = await ev(page, new Function('return ' + CENSUS));
	console.log('  over the burger:    ' + (Array.isArray(c) && c.length ? c.join(' | ') : '(nothing)'));
	results.push(await pass(page, `soak: turn ${TURNS}`));
	const alive = await neighbourAlive(page);
	console.log(`  neighbour (#about-btn) alive: ${alive}`);
	await ctx.close();
}


// ── ROTATE: the phone turned on its side and back ────────────────────────
//
// An iPhone in landscape is 844 CSS pixels wide, which is above the 760 the
// phone shell is bounded by and below the 1280 at which the desktop layout keeps
// its rail. So a rotation takes the app out of phone mode and into the band
// where the rail folds away on its own.
if (ARM === 'rotate') {
	console.log('\n[rotate] portrait -> landscape -> portrait, with turns in between\n');
	const { ctx, page } = await setUp('rotate');
	await startChat(page);
	await applyBreak(page);
	results.push(await pass(page, 'rotate: before'));
	for (let i = 1; i <= Math.max(2, Math.min(TURNS, 4)); i++) await turn(page, `@text ok ${i}`);
	results.push(await pass(page, 'rotate: after turns'));

	await page.setViewportSize({ width: 844, height: 390 });
	await sleep(700);
	const land = await ev(page, () => ({
		w: window.innerWidth,
		mobile: window.matchMedia('(max-width: 760px)').matches,
		railDisp: (document.getElementById('panel-rail') || {}).style
			? document.getElementById('panel-rail').style.display : '?',
	}));
	console.log(`  landscape: innerWidth=${land.w} phoneMode=${land.mobile} rail inline display='${land.railDisp}'`);

	// What the app is told, and when. The media query is known to lag the
	// resize event, and which of the two `apply()` believes decides the branch.
	await ev(page, () => {
		window.__pbTrace = [];
		const mq = window.matchMedia('(max-width: 760px)');
		window.addEventListener('resize', () => window.__pbTrace.push(
			'resize w=' + window.innerWidth + ' mq=' + mq.matches
			+ ' railDisp=' + document.getElementById('panel-rail').style.display), true);
		mq.addEventListener('change', () => window.__pbTrace.push(
			'mqchange w=' + window.innerWidth + ' mq=' + mq.matches
			+ ' railDisp=' + document.getElementById('panel-rail').style.display));
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await sleep(900);
	const trace = await ev(page, () => window.__pbTrace || []);
	console.log('  trace: ' + JSON.stringify(trace));
	const port = await ev(page, () => ({
		w: window.innerWidth,
		mobile: window.matchMedia('(max-width: 760px)').matches,
		railDisp: document.getElementById('panel-rail').style.display,
		computed: getComputedStyle(document.getElementById('panel-rail')).display,
	}));
	console.log(`  back to portrait: innerWidth=${port.w} phoneMode=${port.mobile} rail inline display='${port.railDisp}' computed=${port.computed}`);
	results.push(await pass(page, 'rotate: after'));
	const alive = await neighbourAlive(page);
	console.log(`  neighbour (#about-btn) alive: ${alive}`);
	await ctx.close();
}

// ── The answer ───────────────────────────────────────────────────────────
const dead = results.filter(r => r.v.dead);
console.log('');
if (BREAK) {
	// A source break is a fault that only bites after a rotation, so only the
	// rotate arm can be blind to it. Reporting "the probe is blind" from an arm
	// that was never pointed at the fault would be a false accusation against a
	// working instrument -- and, worse, a habit of ignoring the line.
	if (SOURCE_BREAKS[BREAK] && ARM !== 'rotate') {
		console.log(`BREAK ${BREAK} bites only after a rotation; run it with --arm rotate.`);
		process.exit(2);
	}
	const seen = dead.length > 0;
	console.log(`BREAK ${BREAK} (${BREAKS[BREAK]}): the probe reported it ${seen ? 'DEAD' : 'ALIVE — THE PROBE IS BLIND TO IT'}`);
	if (seen) console.log(`  and named it: ${dead[0].v.why}`);
	process.exit(seen ? 0 : 1);
}
if (!dead.length) {
	console.log(`NOT REPRODUCED on ${ENGINE}: the hamburger opened the drawer at every pass.`);
} else {
	console.log(`REPRODUCED on ${ENGINE}: first dead at "${dead[0].label}" — ${dead[0].v.why}`);
	for (const d of dead) console.log(`  dead: ${d.label} — ${d.v.why}`);
}
process.exit(0);
