// verify_termpanel.mjs — the Terminal panel: the joint between the screen and
// the pty, driven in the real app.
//
// Everything under this panel is proved elsewhere. `dev/verify_terminal.mjs`
// proves that bytes become pixels and that a keypress becomes the right bytes;
// `dev/verify_pty.mjs` proves that the relay carries bytes untouched, says so
// when some are missing, and tells a hand that STOPPED from one that was never
// installed. What is proved here is the JOINT: that the panel builds a terminal
// when a person asks for one and not before, that what comes off the wire is
// written to the screen and what is typed goes back as bytes, that the kernel is
// told when the panel changes size, that a hole in the output is shown beside
// the stream, that closing the panel takes the program with it — and, hardest to
// keep true over time, that the page never composes a fence.
//
// ── The two doubles, and why each is honest ─────────────────────────
//
// A machine hand is a program outside the browser and the Rust half of this app
// is compiled into wasm, so neither can be conjured by a test. Two things are
// stood in for, and NOTHING else is:
//
//   the LINK. `window.DaimondHand` is replaced by a double that records what was
//   sent and replies as a hand would. It supplies no behaviour of handpty.js's:
//   every sequence number, every base64 payload and every ending here is put on
//   the wire by this file and read back through the real relay.
//
//   the RUST ANSWER. `DaimondTerm._setRequestForTest` stands in for the one call
//   that reaches Rust for an `open` request. The fence it returns is a FICTION
//   and is treated as one: no check in this file asserts anything about that
//   fence's contents. What is asserted is that the panel passes the answer
//   through unaltered, refuses when there is none, and refuses when the relay
//   rejects one — which is the whole of the panel's part in the arrangement.
//
// The static half of the file needs no browser at all: it reads the page's own
// source and holds the two properties a reviewer would otherwise have to take on
// trust — that no fence is composed in JavaScript, and that every string the
// panel says exists in every language the app ships.
//
// ── Proving the checks ──────────────────────────────────────────────
//
// A check that has only ever been seen passing has not been seen working. Every
// property below is put through `proved`: the thing is BROKEN in the live page
// (or in the data), the check is required to go red, the thing is restored, and
// the check is required to go green. Where a property cannot be broken from
// outside — the F6 capture, for one — the proof is a negative control instead: a
// key the panel does not own must NOT do what F6 does, on the same assertion.
//
//   node dev/verify_termpanel.mjs
//
// Needs dev/serve.mjs on :8777 and dev/mockllm.mjs on :9099; both are started
// here if they are not already up. Without the mock provider every model turn
// fails and the app reads as broken when it is only unattended.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const INDEX   = path.join(ROOT, 'www/index.html');
const APPJS   = path.join(ROOT, 'www/js/daimond.js');
const RELAYJS = path.join(ROOT, 'www/js/handpty.js');
const I18NDIR = path.join(ROOT, 'www/i18n');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + String(detail).slice(0, 180) : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A property proved twice: broken, and required to fail; whole, and required to
/// pass. `name` is what is being proved, not what is being done to it.
///
/// `breakIt` puts the app in the state where the property does NOT hold and
/// `fixIt` puts it in the state where it does; `testIt` only ever LOOKS. That
/// division is the whole value of the thing: a `testIt` that did any of the
/// breaking itself would answer the same in both worlds and prove nothing, which
/// is how the first draft of this file "proved" three checks that were blind.
const provedNames = [];
async function proved(name, breakIt, testIt, fixIt) {
	await breakIt();
	let red = false;
	try { red = await testIt(); } catch (e) { red = false; }
	await fixIt();
	let green = false;
	try { green = await testIt(); } catch (e) { green = false; }
	provedNames.push(name);
	check(`PROVED ${name}: red when broken, green when whole`,
		!red && green,
		`broken=${red ? 'PASSED — the check is blind' : 'failed, correctly'}, whole=${green ? 'passed' : 'FAILED'}`);
	return !red && green;
}

// ── Phase one: the page's own source ────────────────────────────────

const indexSrc = fs.readFileSync(INDEX, 'utf8');
const appSrc   = fs.readFileSync(APPJS, 'utf8');
const relaySrc = fs.readFileSync(RELAYJS, 'utf8');

console.log('\nThe panel, as the page declares it');

const asideRe = /<aside[^>]*data-panel="term"[^>]*>/;
const aside = (asideRe.exec(indexSrc) || [''])[0];
check('index.html declares a dock panel with the id `term`',
	/data-panel="term"/.test(aside) && /data-zone="dock"/.test(aside), aside.slice(0, 120));
check('and it carries a label and the key that translates it',
	/data-label="Terminal"/.test(aside) && /data-i18n-label="panel\.term"/.test(aside), aside.slice(0, 160));
check('and it is NOT given the `term` class, which belongs to what terminal.js builds',
	/class="panel termpanel"/.test(aside) && !/class="panel term"/.test(aside), aside.slice(0, 80));
check('the panel body has a host, a state line, a notices region and a way-out hint',
	/id="termp-host"/.test(indexSrc) && /id="termp-state"/.test(indexSrc)
	&& /id="termp-gaps"/.test(indexSrc) && /id="termp-foot"/.test(indexSrc));
check('the notices region is a polite live region, so a hole is spoken as well as drawn',
	/id="termp-gaps"[^>]*role="log"[^>]*aria-live="polite"/.test(indexSrc)
	|| /id="termp-gaps"[^>]*aria-live="polite"[^>]*role="log"/.test(indexSrc));

check('daimond.js opens the panel through the layout engine\'s own seam',
	/id === 'term' && window\.DaimondTerm\) DaimondTerm\.onOpen\(\)/.test(appSrc));
check('and closes it through the matching one',
	/id === 'term' && window\.DaimondTerm\) DaimondTerm\.onClose\(\)/.test(appSrc));
check('a Diamond change reaches the panel',
	/daimond-diamond-changed[\s\S]{0,200}DaimondTerm\.onDiamondChanged\(\)/.test(appSrc));
check('a panel already open in the saved layout is built at boot too',
	/DaimondPanels\.isOpen\('term'\)\) DaimondTerm\.onOpen\(\)/.test(appSrc));
check('locking the app takes the terminal with it',
	/DaimondTerm\.onClose\(\)/.test(appSrc.slice(appSrc.indexOf('function lockApp'))));

// ── The fence is not composed in the page ───────────────────────────
//
// The one property in this file worth more than all the others, and the only one
// that can rot silently: a fence composed in JavaScript would work perfectly and
// be wrong. So the panel's own source is read, and anything that looks like the
// four fields of a `FenceSpec` being built is a failure.

/// The Terminal panel's source, from its banner to the line that publishes it.
function panelSource(src) {
	const from = src.indexOf('var DaimondTerm = (function () {');
	const to   = src.indexOf('window.DaimondTerm = DaimondTerm;', from);
	return (from === -1 || to === -1) ? '' : src.slice(from, to);
}
/// Whether a piece of source builds something shaped like a fence.
///
/// Two of the four names together, as object keys, in one statement. One alone
/// is a false alarm (`ro` is two letters and appears inside words), and all four
/// are what a real `FenceSpec` has.
function composesAFence(src) {
	const stmts = src.split(/[;\n]/);
	return stmts.some((line) => {
		const keys = ['rw', 'ro', 'deny', 'net']
			.filter((k) => new RegExp(`(^|[^\\w$.])${k}\\s*:`).test(line));
		return keys.length >= 2;
	});
}
const panelSrc = panelSource(appSrc);
check('the Terminal panel is where it says it is in daimond.js', panelSrc.length > 2000, `${panelSrc.length} chars`);

// The checker is put through the same door as everything else: it is shown a
// source that DOES compose a fence and required to say so, before its silence on
// the real one is worth anything.
provedNames.push('the fence-composition check is not blind');
check('PROVED the fence-composition check sees a fence when there is one',
	composesAFence(panelSrc + '\nvar f = { rw: [root], ro: [], deny: [], net: false };\n'));
check('and the panel composes no fence of its own', !composesAFence(panelSrc));
check('the panel gets its request from the Rust side, by name',
	/Wasm\s*&&\s*Wasm\.pty_request/.test(panelSrc) && /fence_spec|composed on the Rust side/i.test(panelSrc));

// ── Every string it says, in every language it says it in ───────────

const KEYS = [
	'panel.term', 'term.notices_label', 'term.start', 'term.restart', 'term.stop',
	'term.leave_hint', 'term.starting', 'term.running', 'term.nothing_running',
	'term.not_paired', 'term.no_composer', 'term.unreadable_request',
	'term.no_relay_script', 'term.no_renderer', 'term.dismiss_notice',
	// A plural pair is two keys, and a language that has only one of them says
	// the key itself to half its users.
	'term.gaps_count.one', 'term.gaps_count.other',
];
const locales = fs.readdirSync(I18NDIR).filter((f) => f.endsWith('.js'));
/// Which of `keys` a locale file does not define.
function missing(src, keys) {
	return keys.filter((k) => !new RegExp(`['"]${k.replace('.', '\\.')}['"]\\s*:`).test(src));
}
const enSrc = fs.readFileSync(path.join(I18NDIR, 'en.js'), 'utf8');
provedNames.push('the missing-string check is not blind');
check('PROVED the missing-string check sees a string that is gone',
	missing(enSrc.replace(/'term\.no_composer':/, "'term.gone':"), KEYS).join(',') === 'term.no_composer');
for (const f of locales) {
	const src = fs.readFileSync(path.join(I18NDIR, f), 'utf8');
	const gone = missing(src, KEYS);
	check(`${f} says every string the panel needs`, gone.length === 0, gone.join(', '));
}
// The boundary matters: without it `createElement('div')` reads as a call to
// `t('div')`, and the check fails on a string nothing ever asks for.
const asks = [...panelSrc.matchAll(/(?:^|[^\w.$])t\('([\w.]+)'/g)].map((m) => m[1]);
const unknown = asks.filter((k) => !new RegExp(`['"]${k.replace(/\./g, '\\.')}['"]\\s*:`).test(enSrc));
check('the page asks for no string the English table does not have',
	asks.length > 5 && unknown.length === 0, unknown.join(' ') || `${asks.length} keys`);

// ── Phase two: the panel in the real app ────────────────────────────

function listening(port) {
	return new Promise((resolve) => {
		const s = net.connect(port, '127.0.0.1');
		s.once('connect', () => { s.destroy(); resolve(true); });
		s.once('error', () => resolve(false));
	});
}
const started = [];
async function serve(name, args, port) {
	if (await listening(port)) { console.log(`  (${name} already up on ${port})`); return; }
	const p = spawn('node', args, { cwd: ROOT, stdio: 'ignore' });
	started.push(p);
	for (let i = 0; i < 100; i++) {
		if (await listening(port)) { console.log(`  (started ${name} on ${port})`); return; }
		await sleep(100);
	}
	throw new Error(`${name} did not come up on ${port}`);
}
await serve('dev server', ['dev/serve.mjs'], 8777);
await serve('mock provider', ['dev/mockllm.mjs'], 9099);

const { open: openApp, shot } = await import('./harness.mjs');

/// The relay's own sentence for a page with no hand relay at all, read out of
/// the file so this test cannot drift into asserting one the product dropped.
const NO_RELAY = (function () {
	const hit = /var\s+NO_RELAY\s*=\s*([\s\S]*?);\n/.exec(relaySrc);
	try { return hit ? new Function('return ' + hit[1])() : ''; } catch (e) { return ''; }
})();
check('handpty.js still has the sentence a page with no relay shows',
	NO_RELAY.length > 80, NO_RELAY.slice(0, 60));

const s = await openApp({ name: 'termpanel' });
const p = s.page;

/// The link double: what hand.js is asked to provide, and nothing more.
async function installLink({ caps = ['fence:linux', 'landlock:abi-8'] } = {}) {
	await p.evaluate((caps) => {
		window.__link = { sent: [], subs: {}, pid: 4242, refuse: null, opens: 0 };
		const fire = (id, msg) => (window.__link.subs[id] || []).slice().forEach((f) => f(msg));
		window.__emit = fire;
		window.DaimondHand = {
			send(m) {
				window.__link.sent.push(m);
				if (m.t === 'open') {
					window.__link.opens++;
					window.__link.lastOpen = m;
					setTimeout(() => {
						if (window.__link.refuse) fire(m.id, { t: 'refused', reason: window.__link.refuse });
						else fire(m.id, { t: 'opened', pid: window.__link.pid });
					}, 0);
				}
				if (m.t === 'signal') {
					setTimeout(() => fire(m.id, { t: 'closed', exit: 0, killed: m.sig !== 'term' }), 0);
				}
				return Promise.resolve();
			},
			subscribe(id, fn) {
				(window.__link.subs[id] = window.__link.subs[id] || []).push(fn);
				return () => {
					const a = window.__link.subs[id] || [];
					const i = a.indexOf(fn);
					if (i >= 0) a.splice(i, 1);
				};
			},
			status() {
				return Promise.resolve(JSON.stringify({
					paired: true, transport: 'machine', machine: 'double', os: 'linux',
					root: '/nowhere/ws', caps: caps,
				}));
			},
			hasHand: () => true,
		};
	}, caps);
}

/// The Rust answer double. `fence` is a fiction and no check reads it; what it
/// stands in for is the SHAPE of an answer and the fact that one arrived.
async function installComposer({ dropFence = false } = {}) {
	await p.evaluate((drop) => {
		window.DaimondTerm._setRequestForTest(async (json) => {
			window.__asked = JSON.parse(json);
			const req = {
				t: 'open', id: 'tp-' + (++window.__reqSeq || (window.__reqSeq = 1)),
				argv: ['bash', '-i'], cwd: '/nowhere/ws', env: [],
				size: { cols: window.__asked.cols, rows: window.__asked.rows },
				fence: { rw: ['/nowhere/ws'], ro: [], deny: [], net: false },
			};
			if (drop) delete req.fence;
			return JSON.stringify(req);
		});
	}, dropFence);
}

/// Open the panel and wait for the attempt to settle.
async function openPanel() {
	await p.evaluate(() => window.DaimondPanels.show('term'));
	await sleep(700);
}
async function closePanel() {
	await p.evaluate(() => window.DaimondPanels.hide('term'));
	await sleep(300);
}
/// The sentence the panel is showing.
const stateText = () => p.evaluate(() => (document.getElementById('termp-state') || {}).textContent || '');
/// The session the panel believes it has.
const sessionId = () => p.evaluate(() => window.DaimondTerm.session());
/// Everything the link has been sent since it was installed.
const sent = () => p.evaluate(() => window.__link.sent.map((m) => JSON.parse(JSON.stringify(m))));
/// What the screen reader is given: the terminal's own text mirror.
const mirror = () => p.evaluate(() =>
	((document.querySelector('#termp-host .term-mirror') || {}).textContent || '').replace(/\s+/g, ' '));

try {
	console.log('\nThe panel in the app');

	// 1. Nothing is built until somebody asks.
	await proved('the terminal is built on the first open and not at page load',
		async () => { await closePanel(); },
		async () => !!(await p.$('#termp-host .term')),
		async () => { await installLink(); await installComposer(); await openPanel(); });

	// 2. With no relay in the page at all, the panel says the relay's own sentence.
	//    The BROKEN world for this property is a page that has a relay.
	await proved('a page with no machine hand shows the relay\'s own refusal, verbatim',
		async () => {
			await closePanel(); await installLink(); await installComposer(); await openPanel();
		},
		async () => (await stateText()).indexOf(NO_RELAY) === 0,
		async () => {
			await closePanel();
			await p.evaluate(() => { window.__handWas = window.DaimondHand; delete window.DaimondHand; });
			await openPanel();
		});
	await p.evaluate(() => { window.DaimondHand = window.__handWas; });

	// 3. Rust refusing means no terminal — and no request on the wire either.
	//
	//    The composer here is the REAL one. `Wasm.pty_request` did not exist when
	//    this was first written, so "no way to ask Rust" was the reachable world;
	//    it exists now, and the world worth proving is the one where the app asks
	//    and is told no. The machine the double describes is a hand that cannot
	//    fence, which is what `pty_request` refuses on — release gate 1, applied
	//    to a session.
	await proved('when Rust refuses a request, nothing is sent and the app says why',
		async () => {
			await closePanel(); await installLink(); await installComposer(); await openPanel();
		},
		async () => {
			const st = await stateText();
			const opens = await p.evaluate(() => window.__link.opens);
			return opens === 0 && /^Refused:/.test(st) && st.length > 40;
		},
		async () => {
			await closePanel();
			await installLink({ caps: ['fence:none'] });
			await p.evaluate(() => window.DaimondTerm._setRequestForTest(null));
			await openPanel();
		});

	// 4. A fenceless answer is passed through and refused BY THE RELAY. The panel
	//    must not repair it, and the sentence the user reads must be the relay's.
	await proved('a request with no fence is refused, and the page does not patch one in',
		async () => {
			await closePanel(); await installLink(); await installComposer(); await openPanel();
		},
		async () => {
			const st = await stateText();
			const opens = await p.evaluate(() => window.__link.opens);
			return opens === 0 && /fence_spec/.test(st);
		},
		async () => {
			await closePanel();
			await installLink();
			await installComposer({ dropFence: true });
			await openPanel();
		});

	// ── A live session ──────────────────────────────────────────
	await closePanel();
	await installLink();
	await installComposer();
	await openPanel();
	const sid = await sessionId();
	const grid = await p.evaluate(() => {
		const el = document.querySelector('#termp-host .term');
		return el ? { cols: +el.dataset.cols, rows: +el.dataset.rows } : null;
	});
	check('the terminal is fitted to the panel it was built into',
		!!grid && grid.cols >= 20 && grid.rows >= 4, JSON.stringify(grid));
	check('a session opens through the relay and the panel holds its id', !!sid, String(sid));
	check('the panel says it is running', /running/i.test(await stateText()), await stateText());

	const asked = await p.evaluate(() => window.__asked);
	check('the request Rust was asked for carries the panel\'s real grid',
		asked && asked.cols === grid.cols && asked.rows === grid.rows,
		JSON.stringify(asked));
	check('and the Diamond scope it should be fenced to',
		asked && typeof asked.own_dir === 'string'
		&& Array.isArray(asked.attached) && Array.isArray(asked.read_only),
		JSON.stringify(asked));

	const openMsg = await p.evaluate(() => window.__link.lastOpen);
	check('the request reached the wire exactly as Rust composed it',
		openMsg && openMsg.fence && openMsg.fence.rw[0] === '/nowhere/ws' && openMsg.cwd === '/nowhere/ws',
		JSON.stringify(openMsg && openMsg.fence));

	/// Push output at the session as the hand would, base64 as the wire carries it.
	///
	/// The wait is long on purpose: what is read back afterwards is the terminal's
	/// TEXT MIRROR, and that is rebuilt when the output settles (600 ms in
	/// terminal.js) rather than on every byte — which is the same reason a screen
	/// reader is not read a build log one line at a time.
	async function output(id, text, seq) {
		await p.evaluate(({ id, text, seq }) => {
			const u8 = new TextEncoder().encode(text);
			let s = '';
			for (const b of u8) s += String.fromCharCode(b);
			window.__emit(id, { t: 'output', seq, data: btoa(s) });
		}, { id, text, seq });
		await sleep(900);
	}

	// 5. Output reaches the screen — read back through the text a screen reader
	//    is given, so the accessible path is proved with the drawing one.
	await proved('bytes off the wire are written to the screen',
		async () => {
			await p.evaluate(() => {
				window.__realCreate = window.DaimondTerminal.create;
				window.DaimondTerminal.create = function (host, opts) {
					const h = window.__realCreate(host, opts);
					h.write = function () {};	// the joint, cut
					return h;
				};
			});
			await closePanel(); await installLink(); await installComposer(); await openPanel();
		},
		async () => {
			const id = await sessionId();
			if (!id) return false;
			await output(id, 'PANEL-OUTPUT-MARK\r\n', 0);
			return /PANEL-OUTPUT-MARK/.test(await mirror());
		},
		async () => {
			await p.evaluate(() => { window.DaimondTerminal.create = window.__realCreate; });
			await closePanel(); await installLink(); await installComposer(); await openPanel();
		});

	// 6. A keystroke goes back as the BYTES it is, never as text about them.
	await proved('a keystroke reaches the pty as the bytes it is',
		async () => {
			await p.evaluate(() => {
				window.__realInput = window.DaimondPty.input;
				window.DaimondPty.input = () => Promise.resolve();	// the joint, cut
			});
		},
		async () => {
			const before = (await sent()).filter((m) => m.t === 'input').length;
			await p.focus('#termp-host .term-input');
			await p.keyboard.type('ls');
			await p.keyboard.press('Control+c');
			await sleep(250);
			const ins = (await sent()).filter((m) => m.t === 'input').slice(before);
			if (!ins.length) return false;
			const joined = ins.map((m) => Buffer.from(m.data, 'base64').toString('binary')).join('');
			return joined.includes('l') && joined.includes('s') && joined.includes('\x03');
		},
		async () => { await p.evaluate(() => { window.DaimondPty.input = window.__realInput; }); });

	// 7. The kernel is told when the panel changes size.
	await proved('a panel resize is carried to the kernel as a new size',
		async () => {
			await p.evaluate(() => {
				window.__realResize = window.DaimondPty.resize;
				window.DaimondPty.resize = () => Promise.resolve();	// the joint, cut
			});
		},
		async () => {
			const before = (await sent()).filter((m) => m.t === 'resize').length;
			// A window a person actually resizes. The dock's WIDTH does not follow
			// the window, so the height is what moves the grid — and it does, which
			// is itself worth knowing: until the panel was made a flex column the
			// terminal sat at its minimum grid however tall the panel got, and this
			// check is what caught it.
			await p.setViewportSize({ width: 1500, height: 640 });
			await sleep(800);
			await p.setViewportSize({ width: 1500, height: 950 });
			await sleep(800);
			const rs = (await sent()).filter((m) => m.t === 'resize').slice(before);
			if (!rs.length) return false;
			const el = await p.evaluate(() => {
				const t = document.querySelector('#termp-host .term');
				return t ? { cols: +t.dataset.cols, rows: +t.dataset.rows } : null;
			});
			const last = rs[rs.length - 1];
			return !!el && last.size.cols === el.cols && last.size.rows === el.rows;
		},
		async () => { await p.evaluate(() => { window.DaimondPty.resize = window.__realResize; }); });

	// 8. A hole is shown BESIDE the stream, and the bytes still arrive.
	await proved('a gap in the output is shown beside the stream, and the bytes still go through',
		async () => {
			await p.evaluate(() => {
				window.__gapsEl = document.getElementById('termp-gaps');
				window.__realAppend = window.__gapsEl.appendChild.bind(window.__gapsEl);
				window.__gapsEl.appendChild = function () {};	// the notice, suppressed
			});
		},
		async () => {
			// A FRESH session both times. The relay counts from the first chunk it
			// is given, so a second run over an old session would open with a hole
			// of its own and the count below would be reading the wrong one.
			await closePanel(); await installLink(); await installComposer(); await openPanel();
			const id = await sessionId();
			if (!id) return false;
			await output(id, 'BEFORE-THE-HOLE\r\n', 40);
			await output(id, 'AFTER-THE-HOLE\r\n', 47);		// six chunks never arrived
			const notices = await p.evaluate(() =>
				[...document.querySelectorAll('#termp-gaps .termp-gap')].map((d) => d.textContent));
			const drew = /AFTER-THE-HOLE/.test(await mirror());
			return drew && notices.length === 1 && /missing/i.test(notices[0]);
		},
		async () => { await p.evaluate(() => { window.__gapsEl.appendChild = window.__realAppend; }); });

	check('the gap notice is the relay\'s own sentence, not a paraphrase',
		await p.evaluate(() => {
			const d = document.querySelector('#termp-gaps .termp-gap');
			return !!d && /chunk\(s\) of output/.test(d.textContent) && /hole in it/.test(d.textContent);
		}));

	// A notice lies OVER the screen, so it must be possible to move out of the
	// way — and the fact it reports must not go with it.
	await proved('a dismissed notice takes the message away and leaves the fact',
		async () => {
			await p.evaluate(() => {
				window.__realX = HTMLButtonElement.prototype.click;
				HTMLButtonElement.prototype.click = function () {};	// the dismiss, cut
			});
		},
		async () => {
			await p.evaluate(() => {
				const b = document.querySelector('#termp-gaps .termp-gap-x');
				if (b) b.click();
			});
			await sleep(200);
			const gone = await p.evaluate(() => !document.querySelector('#termp-gaps .termp-gap'));
			const said = /missing in 1 place/.test(await stateText());
			return gone && said;
		},
		async () => { await p.evaluate(() => { HTMLButtonElement.prototype.click = window.__realX; }); });

	// 9. The way out of a control that swallows keys.
	//
	// The capture handler cannot be reached from outside to be broken, so the
	// proof is a NEGATIVE CONTROL on the same assertion: F7 is a key the panel
	// does not own, and pressing it must leave the focus exactly where F6 moves
	// it from. A check that goes green for F7 is a check that is not reading the
	// keyboard at all.
	let escKey = 'F6';
	await proved('F6 moves the keyboard out of the terminal, and a key the panel does not own does not',
		async () => { escKey = 'F7'; },
		async () => {
			await p.focus('#termp-host .term-input');
			await sleep(100);
			await p.keyboard.press(escKey);
			await sleep(200);
			return await p.evaluate(() => !document.activeElement.classList.contains('term-input')
				&& document.activeElement.closest('#panel-term') !== null);
		},
		async () => { escKey = 'F6'; });

	check('and F6 was not typed at the program on its way out',
		!(await sent()).filter((m) => m.t === 'input')
			.some((m) => Buffer.from(m.data, 'base64').toString('binary').includes('\x1b[17~')));

	// 10. Closing the panel stops the program and destroys the screen.
	await proved('closing the panel asks the program to stop and destroys the screen',
		async () => {
			await p.evaluate(() => {
				window.__realClose = window.DaimondPty.close;
				window.DaimondPty.close = () => Promise.resolve();	// the joint, cut
			});
		},
		async () => {
			await closePanel(); await installLink(); await installComposer(); await openPanel();
			const before = (await sent()).filter((m) => m.t === 'signal').length;
			await closePanel();
			const sigs = (await sent()).filter((m) => m.t === 'signal').slice(before);
			const gone = !(await p.$('#termp-host .term'));
			const idle = !(await sessionId());
			return sigs.length === 1 && sigs[0].sig === 'term' && gone && idle;
		},
		async () => { await p.evaluate(() => { window.DaimondPty.close = window.__realClose; }); });

	// 11. A session belongs to ONE Diamond's bounds, so a Diamond change ends it.
	await proved('changing the Diamond ends the session it was fenced for',
		async () => {
			await p.evaluate(() => {
				window.__realClose2 = window.DaimondPty.close;
				window.DaimondPty.close = () => Promise.resolve();	// the joint, cut
			});
		},
		async () => {
			await closePanel(); await installLink(); await installComposer(); await openPanel();
			const first = await sessionId();
			if (!first) return false;
			const before = (await sent()).filter((m) => m.t === 'signal').length;
			await p.click('#new-diamond-btn', { force: true });
			await p.waitForSelector('.dlg-input', { timeout: 10000 });
			await p.fill('.dlg-input', 'Terminal scope ' + Date.now());
			await p.click('.dlg-ok', { force: true });
			await sleep(1500);
			const sigs = (await sent()).filter((m) => m.t === 'signal').slice(before);
			const second = await sessionId();
			return sigs.length >= 1 && second !== first;
		},
		async () => { await p.evaluate(() => { window.DaimondPty.close = window.__realClose2; }); });

	const scoped = await p.evaluate(() => window.__asked);
	check('and the terminal that replaces it is scoped to the Diamond now open',
		scoped && /^diamonds\//.test(scoped.own_dir || '') && scoped.cwd === scoped.own_dir,
		JSON.stringify(scoped));

	// 12. An ending is reported where the output it belongs to is.
	{
		await closePanel(); await installLink(); await installComposer(); await openPanel();
		const id = await sessionId();
		await p.evaluate((i) => window.__emit(i, { t: 'closed', exit: 3, killed: false }), id);
		await sleep(1000);		// the ending is written into the screen; the mirror settles
		check('an exit is reported in the panel and written into the screen',
			/status 3/.test(await stateText()) && /status 3/.test(await mirror()),
			await stateText());
		check('and the panel no longer believes it has a session', !(await sessionId()));
	}

	// 13. The two buttons in the head, pressed the way a person presses them.
	{
		await closePanel(); await installLink(); await installComposer(); await openPanel();
		const first = await sessionId();
		await p.click('#panel-term [data-act="term-start"]', { force: true });
		await sleep(900);
		const second = await sessionId();
		check('Restart replaces the session with a new one',
			!!first && !!second && first !== second, `${first} -> ${second}`);
		const before = (await sent()).filter((m) => m.t === 'signal').length;
		await p.click('#panel-term [data-act="term-stop"]', { force: true });
		await sleep(400);
		const sigs = (await sent()).filter((m) => m.t === 'signal').slice(before);
		check('Stop asks the program to stop rather than insisting',
			sigs.length === 1 && sigs[0].sig === 'term', JSON.stringify(sigs));
		await p.click('#panel-term [data-act="term-stop"]', { force: true });
		await sleep(300);
		check('and pressing Stop with nothing running says so instead of failing quietly',
			/no program running/i.test(await stateText()), await stateText());
		check('the Start button now offers to start rather than to restart',
			/^Start/.test(await p.evaluate(() =>
				document.querySelector('#panel-term [data-act="term-start"]').getAttribute('aria-label'))),
			await p.evaluate(() => document.querySelector('#panel-term [data-act="term-start"]').getAttribute('aria-label')));
	}

	// 14. What a screen reader is given, and what the keyboard can reach.
	const a11y = await p.evaluate(() => {
		const input = document.querySelector('#termp-host .term-input');
		const head  = document.querySelector('#panel-term .railhead [role="heading"]');
		const btns  = [...document.querySelectorAll('#panel-term .railhead button')];
		return {
			inputName:  input ? input.getAttribute('aria-label') : null,
			inputDesc:  input ? !!document.getElementById(input.getAttribute('aria-describedby')) : false,
			headFocus:  head ? head.getAttribute('tabindex') : null,
			unnamed:    btns.filter((b) => !(b.getAttribute('aria-label') || b.title || '').trim()).length,
			named:      btns.map((b) => b.getAttribute('aria-label')),
			hint:       (document.getElementById('termp-foot') || {}).textContent || '',
			mirrorRole: (document.querySelector('#termp-host .term-mirror') || {}).getAttribute?.('role'),
		};
	});
	check('the terminal control has a name a screen reader can say', !!a11y.inputName, a11y.inputName);
	check('and a description that says which keys it answers to', a11y.inputDesc);
	check('every button in the panel head has a real name, not the glyph on it',
		a11y.unnamed === 0, a11y.named.join(' | '));
	check('the heading can be focused, so F6 has somewhere to land', a11y.headFocus === '-1');
	check('the way out is written on the panel, not left to be guessed',
		/F6/.test(a11y.hint), a11y.hint);
	check('the screen is also there as text, for a reader who cannot see a canvas',
		a11y.mirrorRole === 'region');

	// 15. Two palettes, looked at rather than assumed.
	for (const theme of ['dark', 'light']) {
		await p.evaluate((th) => {
			try { window.DaimondTheme.set(th); } catch (e) { document.documentElement.setAttribute('data-theme', th); }
		}, theme);
		await sleep(400);
		await shot(s, `termpanel-${theme}`);
	}
	check('a screenshot was taken in a dark and a light palette', true);

	const noise = s.errs.filter((e) => !/favicon|ERR_ABORTED|502|Bad Gateway|net::ERR/i.test(e));
	check('the app threw nothing while all that happened', noise.length === 0, noise.slice(0, 3).join(' | '));
} finally {
	await s.close().catch(() => {});
	for (const proc of started) { try { proc.kill(); } catch (e) { /* already gone */ } }
}

console.log(`\n${ok.length} ok, ${bad.length} failed, ${provedNames.length} properties proved against broken code`);
process.exit(bad.length ? 1 : 0);
