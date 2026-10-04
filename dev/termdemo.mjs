// termdemo.mjs — the terminal, exercised without a hand, a wire or the app.
//
//   node dev/termdemo.mjs          # then open http://localhost:8778
//
// It serves the REAL www/js/terminal.js and www/css/terminal.css beside the
// app's own palette variables, and feeds it output recorded from real programs
// on a real pty (dev/termfix/*.bin, captured with script(1)): a coloured `ls`,
// a `git log --graph`, a `grep --color`, a Python REPL, a `sudo` password
// prompt, a progress bar redrawing itself with carriage returns, `top` redrawing
// a whole screen, `less` entering and leaving the alternate screen, and a full
// colour chart — sixteen names, the 256 cube, the grey ramp, twenty-four-bit,
// and every attribute.
//
// There is also a benchmark, because "canvas or DOM" is a question with an
// answer rather than a preference, and the answer is on this page.
//
// Nothing here is installed and nothing is imported from outside the repo. The
// verifier drives this same page: see dev/verify_terminal.mjs.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const FIX  = path.join(HERE, 'termfix');

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js':   'text/javascript; charset=utf-8',
	'.css':  'text/css; charset=utf-8',
	'.bin':  'application/octet-stream',
};

/// The recordings, newest capture wins. Named here so the page can offer them
/// in an order that tells a story rather than in whatever order the disk does.
export const FIXTURES = [
	['colours', 'Colour chart — 16, 256, 24-bit, attributes'],
	['ls',      'ls --color=always -la'],
	['git',     'git log --graph --decorate --color'],
	['grep',    'grep -rn --color'],
	['repl',    'a Python REPL, typed into'],
	['ask',     'sudo asking for a password'],
	['bar',     'a progress bar, redrawn with \\r'],
	['top',     'top — a full-screen redraw'],
	['less',    'less — the alternate screen, entered and left'],
];

const PAGE = `<!doctype html>
<html lang="en" data-theme="dark" data-tone="dark" data-ink="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daimond terminal — demo</title>
<link rel="stylesheet" href="/css/variables.css">
<link rel="stylesheet" href="/css/terminal.css">
<style>
	body { margin: 0; background: var(--bg-secondary); color: var(--text-primary);
		font: var(--fs-base)/1.5 var(--font); }
	header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
		padding: 10px 14px; border-bottom: 1px solid var(--border); }
	h1 { font-size: var(--fs-lg); margin: 0 12px 0 0; font-weight: 600; }
	button, select { font: var(--fs-sm)/1.4 var(--font); padding: 4px 10px;
		background: var(--bg-tertiary); color: var(--text-primary);
		border: 1px solid var(--border-strong); border-radius: var(--radius-sm); cursor: pointer; }
	button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
	main { padding: 14px; }
	#stage { height: 68vh; min-height: 260px; }
	#stage.phone { width: 360px; }
	pre#out { margin: 12px 0 0; padding: 10px; white-space: pre-wrap;
		background: var(--bg-tertiary); border: 1px solid var(--border);
		border-radius: var(--radius-sm); font: var(--fs-xs)/1.5 var(--font-mono);
		max-height: 22vh; overflow: auto; }
	#bench { position: absolute; left: -9999px; top: 0; }
</style>
</head>
<body>
<header>
	<h1>Daimond terminal</h1>
	<select id="theme" aria-label="Palette"></select>
	<select id="fix" aria-label="Recording"></select>
	<button id="play">Play</button>
	<button id="burst">Play instantly</button>
	<button id="flood">Flood (5000 lines)</button>
	<button id="shell">Fake shell</button>
	<button id="clear">Reset</button>
	<button id="phone">Phone width</button>
	<button id="bench-run">Benchmark</button>
	<span id="size" style="font: var(--fs-xs)/1 var(--font-mono); color: var(--text-secondary)"></span>
</header>
<main>
	<div id="stage"></div>
	<pre id="out" aria-label="What the terminal sent"></pre>
</main>
<div id="bench" aria-hidden="true"></div>
<script src="/js/i18n.js"></script>
<script src="/i18n/en.js"></script>
<script src="/js/terminal.js"></script>
<script src="/demo.js"></script>
</body>
</html>`;

const DEMO_JS = String.raw`
/* The demo's own driver. Not part of the app. */
(function () {
	'use strict';
	var out = document.getElementById('out');
	var stage = document.getElementById('stage');
	var sent = [];

	var THEMES = {
		light: 'dark', mist: 'dark', linen: 'dark', lollypop: 'dark', sage: 'dark',
		dusk: 'light', dark: 'light', amber: 'light', midnight: 'light', forest: 'light', plum: 'light',
	};
	var sel = document.getElementById('theme');
	Object.keys(THEMES).forEach(function (k) {
		var o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o);
	});
	sel.value = 'dark';
	sel.addEventListener('change', function () {
		document.documentElement.setAttribute('data-theme', sel.value);
		document.documentElement.setAttribute('data-ink', THEMES[sel.value]);
	});

	var fixSel = document.getElementById('fix');
	window.__FIXTURES.forEach(function (f) {
		var o = document.createElement('option'); o.value = f[0]; o.textContent = f[1]; fixSel.appendChild(o);
	});

	// Everything the terminal has sent, as raw byte values, for the verifier.
	window.__sentRaw = [];
	window.__clearSent = function () { window.__sentRaw = []; sent = []; out.textContent = ''; };

	var term = DaimondTerminal.create(stage, {
		onData: function (u8) {
			window.__sentRaw.push(Array.prototype.slice.call(u8));
			var hex = [], txt = '';
			for (var i = 0; i < u8.length; i++) {
				hex.push(('0' + u8[i].toString(16)).slice(-2));
				txt += u8[i] >= 32 && u8[i] < 127 ? String.fromCharCode(u8[i]) : '·';
			}
			sent.push(hex.join(' ') + '   ' + txt);
			while (sent.length > 12) sent.shift();
			out.textContent = sent.join('\n');
			if (window.__shell) shellIn(u8);
		},
		onResize: function (c, r) {
			document.getElementById('size').textContent = c + '×' + r;
			window.__lastResize = { cols: c, rows: r, at: Date.now() };
		},
		onTitle: function (s) { window.__title = s; },
		onBell:  function () { window.__bell = (window.__bell || 0) + 1; },
	});
	window.__term = term;
	term.focus();

	function bytes(name) {
		return fetch('/fix/' + name + '.bin').then(function (r) { return r.arrayBuffer(); })
			.then(function (b) { return new Uint8Array(b); });
	}
	/// Only the first n bytes of a recording, for the cases where the interesting
	/// state is in the middle of one — a pager is on the alternate screen right up
	/// until it quits and puts the shell back.
	window.__playTo = function (name, n) {
		return bytes(name).then(function (u8) { term.write(u8.subarray(0, n)); });
	};
	window.__playFrom = function (name, n) {
		return bytes(name).then(function (u8) { term.write(u8.subarray(n)); });
	};
	window.__play = function (name, chunk, gap) {
		return bytes(name).then(function (u8) {
			if (!chunk) { term.write(u8); return; }
			return new Promise(function (done) {
				var i = 0;
				(function step() {
					if (i >= u8.length) { done(); return; }
					term.write(u8.subarray(i, i + chunk));
					i += chunk;
					setTimeout(step, gap || 16);
				})();
			});
		});
	};

	document.getElementById('play').addEventListener('click', function () { window.__play(fixSel.value, 64, 16); });
	document.getElementById('burst').addEventListener('click', function () { window.__play(fixSel.value, 0); });
	document.getElementById('clear').addEventListener('click', function () { term.reset(); });
	document.getElementById('phone').addEventListener('click', function () { stage.classList.toggle('phone'); });

	/// The load case: a build printing faster than a screen refreshes.
	window.__flood = function (n) {
		n = n || 5000;
		var t0 = performance.now();
		var s = '';
		for (var i = 1; i <= n; i++) {
			s += '\x1b[2m[' + i + ']\x1b[0m \x1b[32mCompiling\x1b[0m oxedyne_fe2o3_' +
				['core', 'jdat', 'text', 'net', 'steel'][i % 5] + ' v0.5.0 (/home/u/code/rust/fe2o3)\r\n';
			if (i % 250 === 0) { term.write(s); s = ''; }
		}
		if (s) term.write(s);
		return performance.now() - t0;
	};
	document.getElementById('flood').addEventListener('click', function () {
		var ms = window.__flood(5000);
		sent.push('flood 5000 lines parsed in ' + ms.toFixed(1) + ' ms');
		out.textContent = sent.join('\n');
	});

	// ── A fake shell, so the keyboard can be felt as well as measured ──
	var line = '';
	function prompt() { term.write('\x1b[32mdemo\x1b[0m:\x1b[34m~\x1b[0m$ '); }
	function shellIn(u8) {
		for (var i = 0; i < u8.length; i++) {
			var b = u8[i];
			if (b === 13) {
				term.write('\r\n');
				if (line === 'clear') term.write('\x1b[2J\x1b[H');
				else if (line === 'colours') window.__play('colours', 0);
				else if (line.length) term.write('bash: ' + line + ': command not found\r\n');
				line = '';
				prompt();
			} else if (b === 127) {
				if (line.length) { line = line.slice(0, -1); term.write('\b \b'); }
			} else if (b === 3) { term.write('^C\r\n'); line = ''; prompt(); }
			else if (b === 4) { term.write('exit\r\n'); window.__shell = false; }
			else if (b >= 32) { line += String.fromCharCode(b); term.write(String.fromCharCode(b)); }
			else if (b === 27) { /* an escape sequence: swallowed, as a shell without readline would */ i = u8.length; }
		}
	}
	document.getElementById('shell').addEventListener('click', function () {
		window.__shell = true; term.write('\r\n'); prompt(); term.focus();
	});

	// ── The benchmark ────────────────────────────────────────
	//
	// The same content, drawn both ways, timed the same way. The DOM figure is
	// the optimistic one: one span per cell, textContent and colour set on each,
	// layout forced once per frame — no stylesheet of any size to recalculate
	// against, which a real app most certainly has.

	/// A screenful. 'run' is how many cells share a colour before it changes:
	/// 1 is the pathological case (a colour chart, where every cell is its own
	/// run and every glyph its own draw), 12 is about what a build log or a
	/// a git log --graph actually looks like.
	function fill(term, cols, rows, run) {
		run = run || 1;
		var s = '\x1b[H';
		for (var y = 0; y < rows; y++) {
			for (var x = 0; x < cols; x++) {
				if (x % run === 0) s += '\x1b[3' + ((x / run | 0) % 8) + (x % 3 === 0 ? ';1' : '') + 'm';
				s += String.fromCharCode(33 + ((x + y) % 90));
			}
			if (y < rows - 1) s += '\r\n';
		}
		term.write(s + '\x1b[0m');
	}

	function benchDom(cols, rows, frames) {
		var host = document.getElementById('bench');
		host.innerHTML = '';
		var grid = document.createElement('div');
		grid.style.font = '13px monospace';
		var cells = [];
		for (var y = 0; y < rows; y++) {
			var row = document.createElement('div');
			row.style.whiteSpace = 'pre';
			for (var x = 0; x < cols; x++) {
				var sp = document.createElement('span');
				row.appendChild(sp);
				cells.push(sp);
			}
			grid.appendChild(row);
		}
		host.appendChild(grid);
		var pal = ['#EE7A6B', '#8FCE7A', '#DCAE58', '#68AEE8', '#CE93E2', '#5FCBC8', '#C9C4BB', '#F3F0E9'];
		var t0 = performance.now();
		for (var f = 0; f < frames; f++) {
			for (var i = 0; i < cells.length; i++) {
				var c = cells[i];
				c.textContent = String.fromCharCode(33 + ((i + f) % 90));
				c.style.color = pal[(i + f) % 8];
				c.style.fontWeight = (i % 3) ? '400' : '700';
			}
			void grid.offsetHeight;		// force the layout the frame would have paid for
		}
		var ms = (performance.now() - t0) / frames;
		host.innerHTML = '';
		return ms;
	}

	/// A terminal of a given grid, off screen, with a screenful of coloured text
	/// already in it.
	function benchTerm(cols, rows, run) {
		var box = document.createElement('div');
		box.style.cssText = 'position:absolute;left:-9999px;top:0;width:' + (cols * 9 + 20)
			+ 'px;height:' + (rows * 18 + 20) + 'px';
		document.body.appendChild(box);
		var tm = DaimondTerminal.create(box, { onData: function () {}, onResize: function () {} });
		tm.screen.resize(cols, rows);
		tm.fit();
		fill(tm, cols, rows, run);
		tm._paintNow();
		tm._box = box;
		return tm;
	}

	/// PAINTING only, which is what the DOM figure beside it measures. Parsing
	/// is timed on its own below — mixing the two into one number would let a
	/// fast parser flatter a slow painter and hide which is which.
	function benchCanvasFull(cols, rows, frames, run) {
		var tm = benchTerm(cols, rows, run);
		var t0 = performance.now();
		for (var f = 0; f < frames; f++) tm._paintNow();
		var ms = (performance.now() - t0) / frames;
		tm.destroy(); tm._box.remove();
		return ms;
	}

	/// The load case: one more line arrives, the screen scrolls, and the
	/// renderer moves the pixels rather than redrawing them.
	function benchCanvasScroll(cols, rows, frames, run) {
		var tm = benchTerm(cols, rows, run);
		var t0 = performance.now();
		for (var f = 0; f < frames; f++) {
			tm.write('\x1b[33mline ' + f + ' of a build that is going quite fast now\x1b[0m\r\n');
			tm._paintFrame();
		}
		var ms = (performance.now() - t0) / frames;
		tm.destroy(); tm._box.remove();
		return ms;
	}

	/// How fast bytes become a grid, with no drawing at all.
	function benchParse(cols, rows, lines) {
		var s = '';
		for (var i = 0; i < lines; i++) {
			s += '\x1b[2m[' + i + ']\x1b[0m \x1b[32mCompiling\x1b[0m something v0.5.0 (/home/u/code)\r\n';
		}
		var sc = DaimondTerminal.screen(cols, rows, { scrollback: 5000 });
		var t0 = performance.now();
		sc.write(s);
		var ms = performance.now() - t0;
		return { ms: ms, bytesPerSec: (s.length / ms) * 1000 };
	}

	window.__bench = function () {
		var r = {};
		[[80, 24], [200, 50]].forEach(function (g) {
			var k = g[0] + 'x' + g[1];
			r['dom rebuild ' + k]        = benchDom(g[0], g[1], 20);
			r['canvas full ' + k]        = benchCanvasFull(g[0], g[1], 40, 12);
			r['canvas full worst ' + k]  = benchCanvasFull(g[0], g[1], 40, 1);
			r['canvas scroll ' + k]      = benchCanvasScroll(g[0], g[1], 40, 12);
		});
		var p = benchParse(200, 50, 5000);
		r['parse 5000 lines (ms)'] = p.ms;
		r['parse MB/s'] = p.bytesPerSec / 1e6;
		r['devicePixelRatio'] = window.devicePixelRatio;
		return r;
	};
	document.getElementById('bench-run').addEventListener('click', function () {
		var r = window.__bench();
		out.textContent = Object.keys(r).map(function (k) {
			return k.padEnd(22) + r[k].toFixed(2) + ' ms/frame';
		}).join('\n');
	});
})();
`;

/// Serve the demo. Returns the server, listening.
export function start(port = 8778) {
	const server = http.createServer((req, res) => {
		const url = decodeURIComponent((req.url || '/').split('?')[0]);
		const send = (body, type, code = 200) => {
			res.writeHead(code, { 'content-type': type, 'cache-control': 'no-cache' });
			res.end(body);
		};
		try {
			if (url === '/' || url === '/index.html') return send(PAGE, TYPES['.html']);
			if (url === '/demo.js') {
				return send(`window.__FIXTURES = ${JSON.stringify(FIXTURES)};\n${DEMO_JS}`, TYPES['.js']);
			}
			if (url.startsWith('/fix/')) {
				const name = path.basename(url.slice(5));
				return send(fs.readFileSync(path.join(FIX, name)), TYPES['.bin']);
			}
			// Everything else comes out of the real www tree, so the demo is
			// exercising the shipped file and never a copy of it.
			const p = path.normalize(path.join(WWW, url));
			if (!p.startsWith(path.normalize(WWW))) return send('no', 'text/plain', 403);
			return send(fs.readFileSync(p), TYPES[path.extname(p)] || 'application/octet-stream');
		} catch (e) {
			return send('Not found: ' + url, 'text/plain', 404);
		}
	});
	server.listen(port, 'localhost');
	return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const port = Number(process.env.TERMDEMO_PORT || 8778);
	start(port);
	console.log(`Daimond terminal demo → http://localhost:${port}`);
	console.log(`  recordings: ${FIXTURES.map(f => f[0]).join(', ')}`);
}
