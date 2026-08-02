// verify_terminal.mjs — the terminal draws what it was sent, and sends what was typed.
//
// The panel has two boundaries and both of them are testable. On the way in, bytes become a
// grid of cells and then pixels: what is asserted is not "the model says bold" but that the
// PIXEL at a known cell is the palette's own colour, read back off the canvas — a canvas
// renderer that quietly stopped painting would satisfy every DOM assertion ever written.
// On the way out, a keypress becomes bytes: those are asserted against the xterm sequences
// by number, because an arrow key that sends something plausible-but-wrong is exactly the
// bug that makes every REPL feel broken and exactly the bug a loose test misses.
//
// It drives dev/termdemo.mjs, which serves the REAL www/js/terminal.js and www/css/
// terminal.css and feeds them output recorded from real programs on a real pty. The demo
// server is started by this file on a port of its own, so nothing else need be running:
// this verifier needs neither dev/serve.mjs nor dev/mockllm.mjs, because the terminal has
// no model, no gateway and no wasm behind it.
//
//   node dev/verify_terminal.mjs
//
// Eleven of the checks are SELF-TESTS: the property is broken in the live page and the check
// is required to go red, then restored and required to go green. A check that has only ever
// been seen passing has not been seen working.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { start, FIXTURES } from './termdemo.mjs';

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
const HERE  = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(os.homedir(), '.cache/daimond/term-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const PORT = Number(process.env.TERMDEMO_PORT || 8779);

let bad = 0, n = 0;
const out = [];
const check = (ok, what) => {
	n++;
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
	console.log(`${ok ? '  ok   ' : '  FAIL '}${what}`);
	if (!ok) bad++;
};
/// A property proved twice: broken, and required to fail; restored, and required to pass.
const selfTests = [];
const proved = async (name, breakIt, testIt, fixIt) => {
	await breakIt();
	const red = await testIt();
	await fixIt();
	const green = await testIt();
	selfTests.push(name);
	check(!red && green, `SELF-TEST ${name}: fails when broken, passes when whole `
		+ `(broken=${red ? 'passed — the check is blind' : 'failed, correctly'}, whole=${green ? 'passed' : 'FAILED'})`);
};

const server = start(PORT);
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--headless=new'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push('pageerror: ' + e.message));
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const reset = () => page.evaluate(() => { window.__term.reset(); window.__clearSent(); window.__shell = false; });
const write = (s) => page.evaluate(t => { window.__term.write(t); window.__term._paintNow(); }, s);
const play  = (name) => page.evaluate(nm => window.__play(nm, 0), name);

// ── 1. The grid: bytes become cells ─────────────────────────────────

await reset();
await write('\x1b[1mB\x1b[0m\x1b[2mD\x1b[0m\x1b[3mI\x1b[0m\x1b[4mU\x1b[0m\x1b[7mR\x1b[0m\x1b[9mS\x1b[0m');
const attrs = await page.evaluate(() => {
	const s = window.__term.screen, A = DaimondTerminal.ATTR;
	const c = s.cells;
	const at = i => c.attr[i];
	return { bold: !!(at(0) & A.BOLD), dim: !!(at(1) & A.DIM), italic: !!(at(2) & A.ITALIC),
		under: !!(at(3) & A.UNDER), rev: !!(at(4) & A.REVERSE), strike: !!(at(5) & A.STRIKE),
		chars: [0, 1, 2, 3, 4, 5].map(i => String.fromCharCode(c.ch[i])).join('') };
});
check(attrs.chars === 'BDIURS' && attrs.bold && attrs.dim && attrs.italic
	&& attrs.under && attrs.rev && attrs.strike,
	`the six attributes each land on their own cell: ${JSON.stringify(attrs)}`);

await reset();
await write('\x1b[31mA\x1b[38;5;208mB\x1b[38;2;18;52;86mC\x1b[38:2::200:100:50mD\x1b[48;5;21mE');
const cols = await page.evaluate(() => {
	const c = window.__term.screen.cells;
	const un = v => ({ mode: (v >>> 24) & 3, val: v & 0xFFFFFF });
	return { a: un(c.fg[0]), b: un(c.fg[1]), c: un(c.fg[2]), d: un(c.fg[3]), e: un(c.bg[4]) };
});
check(cols.a.mode === 1 && cols.a.val === 1, `a named colour is indexed: ${JSON.stringify(cols.a)} (wanted mode 1, index 1)`);
check(cols.b.mode === 1 && cols.b.val === 208, `a 256-palette colour keeps its index: ${JSON.stringify(cols.b)}`);
check(cols.c.mode === 2 && cols.c.val === 0x123456, `24-bit, semicolon form: ${cols.c.val.toString(16)} (wanted 123456)`);
check(cols.d.mode === 2 && cols.d.val === ((200 << 16) | (100 << 8) | 50),
	`24-bit, COLON form with the empty colour-space slot: ${cols.d.val.toString(16)} (wanted c86432)`);
check(cols.e.mode === 1 && cols.e.val === 21, `a background colour lands on the background: ${JSON.stringify(cols.e)}`);

// ── 2. The pixels: cells become the palette's own colours ───────────
//
// Read back off the canvas. This is the check that a DOM assertion cannot make and the
// only one that would notice a renderer that had stopped drawing.

/// The colour actually painted at the middle of cell (x, y), as [r,g,b].
const pixelAt = (x, y, dx = 0.5, dy = 0.5) => page.evaluate(({ x, y, dx, dy }) => {
	const cv = document.querySelector('.term-canvas');
	const c = window.__term.cell();
	const dpr = cv.width / parseFloat(cv.style.width);
	const px = Math.floor((x + dx) * c.w * dpr), py = Math.floor((y + dy) * c.h * dpr);
	const g = cv.getContext('2d').getImageData(px, py, 1, 1).data;
	return [g[0], g[1], g[2]];
}, { x, y, dx, dy });

/// What the stylesheet says a colour is, resolved by the browser.
const cssColour = (name) => page.evaluate(nm => {
	const v = getComputedStyle(document.querySelector('.term')).getPropertyValue(nm).trim();
	if (!v) return null;			// the variable is not defined at all
	const d = document.createElement('div');
	d.style.color = v;
	document.body.appendChild(d);
	const got = getComputedStyle(d).color;
	d.remove();
	return (got.match(/\d+/g) || []).slice(0, 3).map(Number);
}, name);

const near = (a, b, tol = 6) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);

await reset();
// A background block per named colour, so the pixel read is of a filled cell rather than
// of the antialiased edge of a glyph.
await write([...Array(16).keys()].map(i => `\x1b[48;5;${i}m  \x1b[0m`).join(''));
let wrongColour = [];
for (let i = 0; i < 16; i++) {
	// A background may override its own value; where it does not, the two are the same.
	const want = (await cssColour(`--term-ansi-bg-${i}`)) || (await cssColour(`--term-ansi-${i}`));
	const got = await pixelAt(i * 2, 0);
	if (!near(got, want)) wrongColour.push(`${i}: drew ${got} wanted ${want}`);
}
check(wrongColour.length === 0,
	`all sixteen named backgrounds are painted in the stylesheet's own colours${wrongColour.length ? ': ' + wrongColour.join('; ') : ''}`);

await reset();
await write('\x1b[48;2;18;52;86m \x1b[48;5;208m \x1b[0m');
const trueCol = await pixelAt(0, 0), cubeCol = await pixelAt(1, 0);
check(near(trueCol, [18, 52, 86]), `a 24-bit background is painted exactly: ${trueCol} (wanted 18,52,86)`);
check(near(cubeCol, [255, 135, 0]), `256-palette 208 is the cube's own orange: ${cubeCol} (wanted 255,135,0)`);

// Reverse video really swaps the two, at the pixel.
await reset();
await write('\x1b[31;7mX\x1b[0m');
const revBg = await pixelAt(0, 0, 0.5, 0.9);		// below the glyph, still inside the cell
const red = await cssColour('--term-ansi-1');
check(near(revBg, red, 10), `reverse video paints the FOREGROUND colour as the ground: ${revBg} (wanted the red ${red})`);

// ── 3. A whole screen, from a real recording ────────────────────────

await reset();
await play('colours');
await page.waitForTimeout(250);
await page.evaluate(() => window.__term._paintNow());
await page.screenshot({ path: path.join(SHOTS, 'colours.png') });
const inked = await page.evaluate(() => {
	// How much of the canvas is not the ground: a screen that drew nothing, or drew
	// everything, both look wrong here and neither shows up in the model.
	const cv = document.querySelector('.term-canvas');
	const g = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
	const bg = [g[0], g[1], g[2]];
	let on = 0, total = 0;
	for (let i = 0; i < g.length; i += 4 * 7) {
		total++;
		if (Math.abs(g[i] - bg[0]) + Math.abs(g[i + 1] - bg[1]) + Math.abs(g[i + 2] - bg[2]) > 24) on++;
	}
	return on / total;
});
check(inked > 0.04 && inked < 0.9, `the colour chart puts ink on the screen without flooding it: ${(inked * 100).toFixed(1)}% of sampled pixels differ from the ground`);

await reset();
await play('top');
await page.waitForTimeout(250);
const topDrew = await page.evaluate(() => {
	const s = window.__term.screen;
	return { row0: s.lineText(s.absOfRow(0)), row7: s.lineText(s.absOfRow(7)) };
});
check(/^top - /.test(topDrew.row0) && /\d+ (jason|root)/.test(topDrew.row7),
	`a full-screen program's cursor addressing and clears land where it put them: `
	+ `row 0 ${JSON.stringify(topDrew.row0.slice(0, 34))}, row 7 ${JSON.stringify(topDrew.row7.slice(0, 34))}`);

// The alternate screen, entered and left, which is the property that matters: a pager must
// give back the shell output it covered up.
await reset();
await write('the shell was here\r\n');
const ALT_ENTER = 1253;			// where less.bin leaves the alternate screen
const pager = await page.evaluate(async (n) => {
	await window.__playTo('less', n);
	const s = window.__term.screen;
	const rows = [];
	for (let y = 0; y < s.rows; y++) rows.push(s.lineText(s.absOfRow(y)));
	return { alt: s.modes.alt, sb: s.scrollback(), rows };
}, ALT_ENTER);
check(pager.alt === true, `a pager moves to the alternate screen: modes.alt=${pager.alt}`);
// The pager was told a 24-row terminal by script(1) and this panel has more, so the file
// lands wherever its own cursor addressing put it -- which is the point: it is asserted
// that the TEXT is on the alternate screen, not that it is on a row this test guessed.
const pagerLine = pager.rows.find(r => /serve\.mjs/.test(r));
check(!!pagerLine, `and draws the file there: ${JSON.stringify((pagerLine || '').slice(0, 46))}`);
check(pager.sb === 0, `the alternate screen adds nothing to the scrollback: ${pager.sb} line(s) — a redraw is not a transcript`);
const after = await page.evaluate(async (n) => {
	await window.__playFrom('less', n);
	const s = window.__term.screen;
	return { alt: s.modes.alt, row0: s.lineText(s.absOfRow(0)) };
}, ALT_ENTER);
check(after.alt === false && /the shell was here/.test(after.row0),
	`and when it quits the shell's own screen is back, unharmed: modes.alt=${after.alt}, `
	+ `row 0 ${JSON.stringify(after.row0)}`);

await reset();
await play('bar');
await page.waitForTimeout(250);
const bar = await page.evaluate(() => {
	const s = window.__term.screen;
	const rows = [];
	for (let y = 0; y < 4; y++) rows.push(s.lineText(s.absOfRow(y)));
	return rows;
});
check(/100%/.test(bar[0]) && !/\[#*\]\s*\[/.test(bar[0]),
	`a progress bar redrawn with carriage returns leaves ONE line, not twenty-one: ${JSON.stringify(bar[0])}`);

await reset();
await play('ask');
await page.waitForTimeout(200);
const ask = await page.evaluate(() => {
	const s = window.__term.screen;
	return [0, 1, 2, 3].map(y => s.lineText(s.absOfRow(y)));
});
check(/\[sudo\] password for/.test(ask[0]) && /Sorry, try again/.test(ask[1]),
	`a sudo prompt and its refusal land on their own lines: ${JSON.stringify(ask.slice(0, 2))}`);

// ── 4. The damage model ─────────────────────────────────────────────

await reset();
await write('hello\r\nworld\r\n');
const dmg = await page.evaluate(() => {
	const s = window.__term.screen;
	s.compose();				// clear whatever is outstanding
	s.write('!');				// one character, one row
	const d = s.compose();
	let rows = 0;
	for (let i = 0; i < d.rows.length; i++) if (d.rows[i]) rows++;
	return { all: d.all, rows, scrolled: d.scrolled };
});
check(!dmg.all && dmg.rows === 1, `one character damages exactly one row: ${JSON.stringify(dmg)}`);

const scrollDmg = await page.evaluate(() => {
	const s = window.__term.screen;
	// Fill to the bottom so the next line scrolls.
	for (let i = 0; i < s.rows + 2; i++) s.write('line ' + i + '\r\n');
	s.compose();
	s.write('one more\r\n');
	const d = s.compose();
	return { all: d.all, scrolled: d.scrolled };
});
check(!scrollDmg.all && scrollDmg.scrolled === 1,
	`a scroll is reported AS a scroll rather than as a whole-screen repaint: ${JSON.stringify(scrollDmg)}`);

// The blit has to produce the same pixels as a full repaint, or the optimisation is a
// rendering bug with a stopwatch attached.
await reset();
await write('\x1b[H');
for (let i = 0; i < 40; i++) await write(`\x1b[3${i % 8}mrow ${i} with some text on it\x1b[0m\r\n`);
const same = await page.evaluate(() => {
	const cv = document.querySelector('.term-canvas');
	const grab = () => cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
	window.__term.write('\x1b[36ma newly scrolled line\x1b[0m\r\n');
	window.__term._paintFrame();			// the damage path: blit, then the new row
	const blitted = Array.from(grab());
	window.__term._paintNow();				// the whole grid, from scratch
	const full = Array.from(grab());
	let diff = 0;
	for (let i = 0; i < full.length; i += 4) {
		if (Math.abs(full[i] - blitted[i]) > 2 || Math.abs(full[i + 1] - blitted[i + 1]) > 2
			|| Math.abs(full[i + 2] - blitted[i + 2]) > 2) diff++;
	}
	return { diff, of: full.length / 4 };
});
check(same.diff === 0,
	`the scroll blit draws the same pixels as a full repaint: ${same.diff} of ${same.of} pixels differ`);

// ── 5. Keys become the right bytes ──────────────────────────────────

const typed = async (key, opts = {}) => {
	await page.evaluate(() => window.__clearSent());
	await page.focus('.term-input');
	await page.keyboard.press(key, opts);
	await page.waitForTimeout(30);
	const got = await page.evaluate(() => window.__sentRaw.flat());
	return got;
};
const bytesOf = (s) => Array.from(new TextEncoder().encode(s));
const keyIs = async (key, want, what) => {
	const got = await typed(key);
	const w = bytesOf(want);
	check(JSON.stringify(got) === JSON.stringify(w),
		`${what || key} sends ${JSON.stringify(want).replace(/\\u001b/g, 'ESC')} — got `
		+ `[${got.map(b => b.toString(16)).join(' ')}], wanted [${w.map(b => b.toString(16)).join(' ')}]`);
};

await reset();
await keyIs('Enter', '\r', 'Enter (CR, not LF — the line discipline makes the newline)');
await keyIs('Backspace', '\x7f', 'Backspace (DEL, not BS)');
await keyIs('Control+Backspace', '\x08', 'Ctrl-Backspace (BS: readline\'s delete-word)');
await keyIs('Tab', '\t');
await keyIs('Shift+Tab', '\x1b[Z', 'Shift-Tab (CBT)');
await keyIs('Escape', '\x1b');
await keyIs('ArrowUp', '\x1b[A');
await keyIs('ArrowDown', '\x1b[B');
await keyIs('ArrowRight', '\x1b[C');
await keyIs('ArrowLeft', '\x1b[D');
await keyIs('Home', '\x1b[H');
await keyIs('End', '\x1b[F');
await keyIs('PageUp', '\x1b[5~');
await keyIs('PageDown', '\x1b[6~');
await keyIs('Delete', '\x1b[3~');
await keyIs('Insert', '\x1b[2~');
await keyIs('Control+c', '\x03', 'Ctrl-C (ETX — the interrupt, and it must never be the copy)');
await keyIs('Control+d', '\x04', 'Ctrl-D (EOT)');
await keyIs('Control+z', '\x1a', 'Ctrl-Z (SUB)');
await keyIs('Control+l', '\x0c', 'Ctrl-L');
await keyIs('Control+Space', '\x00', 'Ctrl-Space (NUL)');
await keyIs('Control+[', '\x1b', 'Ctrl-[');
await keyIs('Control+\\', '\x1c', 'Ctrl-\\ (QUIT)');
await keyIs('F1', '\x1bOP');
await keyIs('F4', '\x1bOS');
await keyIs('F5', '\x1b[15~');
await keyIs('F12', '\x1b[24~');
await keyIs('Control+ArrowRight', '\x1b[1;5C', 'Ctrl-Right (the modifier is a parameter, not a different key)');
await keyIs('Shift+ArrowLeft', '\x1b[1;2D', 'Shift-Left');
await keyIs('Alt+ArrowUp', '\x1b[1;3A', 'Alt-Up');
await keyIs('Alt+b', '\x1bb', 'Alt-b (ESC prefix — readline\'s back-word)');
await keyIs('a', 'a', 'an ordinary letter');

// Application cursor keys: the same arrow, a different sequence, because that is what a
// REPL in readline asks for and what vi assumes.
await write('\x1b[?1h');
await keyIs('ArrowUp', '\x1bOA', 'ArrowUp in application cursor mode');
await keyIs('Home', '\x1bOH', 'Home in application cursor mode');
await keyIs('Control+ArrowUp', '\x1b[1;5A', 'a MODIFIED arrow stays CSI even in application mode');
await write('\x1b[?1l');
await keyIs('ArrowUp', '\x1b[A', 'ArrowUp back in normal mode');

// UTF-8, not a code unit.
await page.evaluate(() => window.__clearSent());
await page.keyboard.type('é');
await page.waitForTimeout(30);
const acc = await page.evaluate(() => window.__sentRaw.flat());
check(JSON.stringify(acc) === JSON.stringify([0xC3, 0xA9]),
	`a non-ASCII letter is sent as UTF-8: [${acc.map(b => b.toString(16)).join(' ')}] (wanted c3 a9)`);

// A query the program made must be answered, or it waits for ever.
await page.evaluate(() => window.__clearSent());
await write('\x1b[10;5H\x1b[6n');
await page.waitForTimeout(50);
const dsr = await page.evaluate(() => window.__sentRaw.flat().map(b => String.fromCharCode(b)).join(''));
check(dsr === '\x1b[10;5R', `a cursor-position report is answered: ${JSON.stringify(dsr)} (wanted ESC[10;5R)`);

// ── 6. Paste ────────────────────────────────────────────────────────

/// Paste through the REAL clipboard event, not the internal function, so the listener is
/// covered too.
const pasteEvent = (text) => page.evaluate(t => {
	const dt = new DataTransfer();
	dt.setData('text/plain', t);
	document.querySelector('.term-input').dispatchEvent(
		new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, text);

await reset();
await write('\x1b[?2004h');			// the program asks to be told
await pasteEvent('one\ntwo\nthree');
await page.waitForTimeout(60);
const bracketed = await page.evaluate(() => window.__sentRaw.flat().map(b => String.fromCharCode(b)).join(''));
check(bracketed === '\x1b[200~one\rtwo\rthree\x1b[201~',
	`a program that asked for bracketed paste gets it wrapped: ${JSON.stringify(bracketed)}`);

await page.evaluate(() => window.__clearSent());
await pasteEvent('a\x1b[201~; rm -rf /\nb');
await page.waitForTimeout(60);
const spoof = await page.evaluate(() => window.__sentRaw.flat().map(b => String.fromCharCode(b)).join(''));
check(spoof.indexOf('\x1b[201~') === spoof.length - 6 && spoof.split('\x1b[201~').length === 2,
	`a paste carrying its own terminator cannot end the bracket early: ${JSON.stringify(spoof)}`);

await reset();
await write('\x1b[?2004l');			// the program did NOT ask
await pasteEvent('echo one\necho two\necho three');
await page.waitForTimeout(80);
const asked = await page.evaluate(() => ({
	sent: window.__sentRaw.flat().length,
	shown: !document.querySelector('.term-paste').hidden,
	says: (document.querySelector('.term-paste-say') || {}).textContent || '',
	buttons: [...document.querySelectorAll('.term-paste-btn')].map(b => b.textContent),
	focused: document.activeElement && document.activeElement.className,
}));
check(asked.sent === 0 && asked.shown,
	`a multi-line paste into a program that did NOT ask sends nothing until the person answers: `
	+ `${asked.sent} byte(s) sent, question ${asked.shown ? 'shown' : 'NOT SHOWN'}`);
check(/3/.test(asked.says) && asked.buttons.length === 3,
	`and the question says how many lines and offers three ways out: ${JSON.stringify(asked.says)} `
	+ `${JSON.stringify(asked.buttons)}`);
check(/term-paste-btn/.test(asked.focused || ''),
	`focus moves into the question, so it can be answered from the keyboard: ${asked.focused}`);
await page.click('.term-paste-btn.primary');
await page.waitForTimeout(60);
const firstOnly = await page.evaluate(() => window.__sentRaw.flat().map(b => String.fromCharCode(b)).join(''));
check(firstOnly === 'echo one', `"paste the first line" sends the first line and no newline: ${JSON.stringify(firstOnly)}`);

// Ctrl-Shift-V must reach the BROWSER: preventing it stops the paste event ever firing,
// and the shortcut the hint tells people about would silently do nothing.
await reset();
const shortcuts = await page.evaluate(async () => {
	const ta = document.querySelector('.term-input');
	const fire = (key, shift, ctrl) => {
		const e = new KeyboardEvent('keydown', { key, shiftKey: shift, ctrlKey: ctrl, bubbles: true, cancelable: true });
		ta.dispatchEvent(e);
		return e.defaultPrevented;
	};
	return { pasteShortcut: fire('V', true, true), quotedInsert: fire('v', false, true) };
});
check(shortcuts.pasteShortcut === false && shortcuts.quotedInsert === true,
	`Ctrl-Shift-V is left to the browser so the paste event fires, while plain Ctrl-V is the `
	+ `terminal's own quoted-insert: prevented? shift=${shortcuts.pasteShortcut} plain=${shortcuts.quotedInsert}`);

await reset();
await pasteEvent('one line only');
await page.waitForTimeout(60);
const oneLine = await page.evaluate(() => ({
	sent: window.__sentRaw.flat().map(b => String.fromCharCode(b)).join(''),
	shown: !document.querySelector('.term-paste').hidden,
}));
check(oneLine.sent === 'one line only' && !oneLine.shown,
	`a single-line paste is not worth a question: ${JSON.stringify(oneLine)}`);

// ── 7. Size ─────────────────────────────────────────────────────────

await reset();
const sized = await page.evaluate(async () => {
	const stage = document.getElementById('stage');
	stage.style.width = '700px';
	stage.style.height = '400px';
	await new Promise(r => setTimeout(r, 500));
	const c = window.__term.cell();
	const box = document.querySelector('.term').getBoundingClientRect();
	const s = window.__term.size();
	return { cols: s.cols, rows: s.rows, cw: c.w, ch: c.h, w: box.width, h: box.height,
		reported: window.__lastResize, attrCols: +document.querySelector('.term').dataset.cols };
});
const wantCols = Math.floor((sized.w - 8) / sized.cw);
const wantRows = Math.floor((sized.h - 8) / sized.ch);
check(sized.cols === wantCols && sized.rows === wantRows,
	`the box becomes columns and rows by MEASURING the font: ${sized.w.toFixed(1)}×${sized.h.toFixed(1)}px `
	+ `at ${sized.cw.toFixed(3)}×${sized.ch}px per cell → ${sized.cols}×${sized.rows} (arithmetic says ${wantCols}×${wantRows})`);
check(Math.abs(sized.cw - 8) > 0.01 && sized.cw > 3 && sized.cw < 40,
	`the cell width is measured rather than assumed: ${sized.cw.toFixed(4)}px, which is not the 8 a guess would give`);
check(sized.reported && sized.reported.cols === sized.cols && sized.reported.rows === sized.rows,
	`and the host is TOLD, which is the only way the kernel ever finds out: `
	+ `${JSON.stringify(sized.reported && { cols: sized.reported.cols, rows: sized.reported.rows })}`);

// Debounced: a drag is many resize events and must not be many SIGWINCHes.
const debounce = await page.evaluate(async () => {
	const stage = document.getElementById('stage');
	let count = 0;
	const seen = new Set();
	window.__lastResize = null;
	const t0 = Date.now();
	for (let i = 0; i < 12; i++) {
		stage.style.width = (480 + i * 9) + 'px';
		await new Promise(r => setTimeout(r, 16));
	}
	await new Promise(r => setTimeout(r, 400));
	return { last: window.__lastResize, ms: Date.now() - t0 };
});
const settledSize = await page.evaluate(() => window.__term.size());
check(!!debounce.last && debounce.last.cols === settledSize.cols,
	`a drag across twelve widths ends with a report of the FINAL size and not of the ones in between: `
	+ `reported ${JSON.stringify(debounce.last && { cols: debounce.last.cols, rows: debounce.last.rows })}, `
	+ `settled at ${JSON.stringify(settledSize)}`);

// ── 8. Selection and copy ───────────────────────────────────────────

await page.evaluate(() => { const s = document.getElementById('stage'); s.style.width = ''; s.style.height = ''; });
await page.waitForTimeout(400);
await reset();
await write('alpha bravo charlie\r\ndelta echo foxtrot\r\n');
const selText = await page.evaluate(() => {
	const t = window.__term, s = t.screen;
	t.screen.setViewOffset(0);
	// Two full rows, chosen through the same path a drag takes.
	const cv = document.querySelector('.term-canvas');
	const box = cv.getBoundingClientRect();
	const c = t.cell();
	const at = (col, row) => ({ clientX: box.left + col * c.w + 1, clientY: box.top + row * c.h + 1,
		button: 0, bubbles: true, detail: 1 });
	cv.dispatchEvent(new MouseEvent('mousedown', at(0, 0)));
	window.dispatchEvent(new MouseEvent('mousemove', at(18, 1)));
	window.dispatchEvent(new MouseEvent('mouseup', at(18, 1)));
	return t.selection();
});
check(selText === 'alpha bravo charlie\ndelta echo foxtrot',
	`a drag selects what lies between the two cells: ${JSON.stringify(selText)}`);

// A line the TERMINAL wrapped is one line, and copying it must not invent a newline that
// would break the path or the command it holds.
await reset();
const wrapJoin = await page.evaluate(() => {
	const t = window.__term;
	const cols = t.size().cols;
	const long = '/home/u/' + 'x'.repeat(cols + 10);
	t.write(long);
	t._paintNow();
	t.selectAll();
	return { text: t.selection(), cols, long };
});
check(wrapJoin.text.indexOf(wrapJoin.long) === 0,
	`a wrapped line copies back as ONE line: ${JSON.stringify(wrapJoin.text.slice(0, 30))}… `
	+ `(${wrapJoin.text.split('\n').length} line(s) for ${wrapJoin.long.length} characters in ${wrapJoin.cols} columns)`);

// Selection is drawn, not merely recorded.
await reset();
await write('selected text here');
const selPixel = await page.evaluate(() => {
	const cv = document.querySelector('.term-canvas');
	const g = () => Array.from(cv.getContext('2d').getImageData(2, 2, 1, 1).data).slice(0, 3);
	const before = g();
	window.__term.selectAll();
	const after = g();
	window.__term.clearSelection();
	return { before, after };
});
check(JSON.stringify(selPixel.before) !== JSON.stringify(selPixel.after),
	`and the selection is PAINTED: the ground under the first cell went ${selPixel.before} → ${selPixel.after}`);

// ── 9. What a screen reader is given ────────────────────────────────

const a11y = await page.evaluate(() => {
	const root = document.querySelector('.term');
	const cv = root.querySelector('.term-canvas');
	const input = root.querySelector('.term-input');
	const mirror = root.querySelector('.term-mirror');
	const log = root.querySelector('[role="log"]');
	const cs = getComputedStyle(mirror);
	return {
		canvasHidden: cv.getAttribute('aria-hidden'),
		inputTag: input.tagName,
		inputLabel: input.getAttribute('aria-label'),
		describedBy: input.getAttribute('aria-describedby'),
		hintText: (document.getElementById(input.getAttribute('aria-describedby')) || {}).textContent || '',
		mirrorRole: mirror.getAttribute('role'),
		mirrorLabel: mirror.getAttribute('aria-label'),
		mirrorDisplay: cs.display,
		mirrorVisibility: cs.visibility,
		logLive: log && log.getAttribute('aria-live'),
	};
});
check(a11y.canvasHidden === 'true',
	`the canvas is kept OUT of the accessibility tree: aria-hidden=${a11y.canvasHidden} — a picture of a terminal is nothing to a screen reader, and announcing it as "canvas" is worse than silence`);
check(a11y.inputTag === 'TEXTAREA' && !!a11y.inputLabel && a11y.inputLabel !== 'term.label',
	`the focusable control is a real field with a spoken name: <${a11y.inputTag}> "${a11y.inputLabel}"`);
check(!!a11y.describedBy && a11y.hintText.length > 40,
	`and it is described, so the shortcuts are discoverable by ear: ${JSON.stringify(a11y.hintText.slice(0, 60))}…`);
check(a11y.mirrorRole === 'region' && !!a11y.mirrorLabel
	&& a11y.mirrorDisplay !== 'none' && a11y.mirrorVisibility !== 'hidden',
	`the screen is mirrored as ordinary text a reader can browse: role=${a11y.mirrorRole} `
	+ `label=${JSON.stringify(a11y.mirrorLabel)} display=${a11y.mirrorDisplay} — clipped, NOT display:none, `
	+ `because either of those would take it out of the tree as well`);
check(a11y.logLive === 'polite', `and there is a polite log for what has just happened: aria-live=${a11y.logLive}`);

await reset();
await write('the first line\r\nthe second line\r\n');
await page.waitForTimeout(900);			// past the settle
const mirrored = await page.evaluate(() => ({
	text: document.querySelector('.term-mirror').textContent,
	said: [...document.querySelectorAll('[role="log"] p')].map(p => p.textContent),
}));
check(/the first line/.test(mirrored.text) && /the second line/.test(mirrored.text),
	`the mirror holds what the screen holds: ${JSON.stringify(mirrored.text.trim().slice(0, 40))}…`);
check(mirrored.said.length === 1 && /the first line/.test(mirrored.said[0]),
	`the log speaks ONCE, after the output settles: ${JSON.stringify(mirrored.said)}`);

// A torrent must not be recited. This is the same reasoning the guide gives for announcing
// an answer once rather than as it is typed.
await reset();
await page.evaluate(() => { window.__flood(2000); });
await page.waitForTimeout(1200);
const torrent = await page.evaluate(() => [...document.querySelectorAll('[role="log"] p')].map(p => p.textContent));
check(torrent.length <= 2 && /2000|\d+ lines/.test(torrent.join(' ')),
	`two thousand lines produce a summary, not a recital: ${torrent.length} announcement(s), `
	+ `${JSON.stringify((torrent[torrent.length - 1] || '').slice(0, 70))}…`);

// Focus, drawn outside the control against the surface behind it.
await page.focus('.term-input');
await page.waitForTimeout(80);
const ring = await page.evaluate(() => {
	const cs = getComputedStyle(document.querySelector('.term'));
	return { style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset, colour: cs.outlineColor };
});
check(ring.style !== 'none' && parseFloat(ring.width) >= 2 && parseFloat(ring.offset) > 0,
	`focus is a ring OUTSIDE the control, standing off from its edge: ${JSON.stringify(ring)}`);
await page.screenshot({ path: path.join(SHOTS, 'focus.png') });

// ── 10. The palette, on all eleven ──────────────────────────────────

const THEMES = {
	light: 'dark', mist: 'dark', linen: 'dark', lollypop: 'dark', sage: 'dark',
	dusk: 'light', dark: 'light', amber: 'light', midnight: 'light', forest: 'light', plum: 'light',
};
const lum = ([r, g, b]) => {
	const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
	return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => { const [x, y] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]; return (x + 0.05) / (y + 0.05); };

const CHROMATIC = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14];
const GREY = [0, 8, 7, 15];
const lowest = [];
const axisBad = [];
for (const [theme, ink] of Object.entries(THEMES)) {
	const vals = await page.evaluate(({ theme, ink }) => {
		document.documentElement.setAttribute('data-theme', theme);
		document.documentElement.setAttribute('data-ink', ink);
		const el = document.querySelector('.term');
		const cs = getComputedStyle(el);
		const resolve = (v) => {
			const d = document.createElement('div');
			d.style.color = v; document.body.appendChild(d);
			const got = getComputedStyle(d).color; d.remove();
			return (got.match(/\d+/g) || []).slice(0, 3).map(Number);
		};
		const ansi = [], ansiBg = [];
		for (let i = 0; i < 16; i++) {
			ansi.push(resolve(cs.getPropertyValue('--term-ansi-' + i).trim()));
			const o = cs.getPropertyValue('--term-ansi-bg-' + i).trim();
			ansiBg.push(o ? resolve(o) : ansi[i]);
		}
		return { ansi, ansiBg, bg: resolve(cs.getPropertyValue('--term-bg').trim()) };
	}, { theme, ink });
	let worst = 99, worstAt = -1;
	for (let i = 0; i < 16; i++) {
		const r = ratio(vals.ansi[i], vals.bg);
		if (r < worst) { worst = r; worstAt = i; }
	}
	lowest.push({ theme, worst, worstAt });
	// The BACKGROUND table is where the black-to-white axis has to survive, because a
	// program filling a status bar with colour 15 means white and a program filling one
	// with colour 0 means black. The foreground table is deliberately not an axis on a
	// paper ground -- see terminal.css -- so it is held to readability instead, above.
	const L = GREY.map(i => lum(vals.ansiBg[i]));
	const rising = L[0] < L[1] && L[1] < L[2] && L[2] < L[3];
	const steps = [ratio(vals.ansiBg[0], vals.ansiBg[8]), ratio(vals.ansiBg[8], vals.ansiBg[7]),
		ratio(vals.ansiBg[7], vals.ansiBg[15])];
	if (!rising || steps.some(s => s < 1.25)) {
		axisBad.push(`${theme}: order=${rising ? 'rising' : 'BROKEN'} steps=${steps.map(s => s.toFixed(2)).join(',')}`);
	}
}
const floor = Math.min(...lowest.map(l => l.worst));
check(floor >= 3.0,
	`every one of the sixteen named colours clears 3.0 AS LETTERING against every palette's own ground: worst is `
	+ lowest.slice().sort((a, b) => a.worst - b.worst).slice(0, 3)
		.map(l => `${l.theme} colour ${l.worstAt} at ${l.worst.toFixed(2)}`).join(', '));
check(axisBad.length === 0,
	`and AS A GROUND the black-to-white axis stays in order and stepped on all eleven`
	+ `${axisBad.length ? ': ' + axisBad.join('; ') : ''}`);

// A palette change repaints, rather than leaving the last palette's pixels on screen.
await page.evaluate(() => {
	document.documentElement.setAttribute('data-theme', 'dark');
	document.documentElement.setAttribute('data-ink', 'light');
});
await page.waitForTimeout(200);
await reset();
await write('\x1b[31msome red text\x1b[0m');
const beforeTheme = await pixelAt(0, 0, 0.1, 0.5);
await page.evaluate(() => {
	document.documentElement.setAttribute('data-theme', 'light');
	document.documentElement.setAttribute('data-ink', 'dark');
});
await page.waitForTimeout(300);
const afterTheme = await pixelAt(0, 0, 0.1, 0.5);
check(!near(beforeTheme, afterTheme, 20),
	`the drawn pixels follow a palette change with no redraw asked for: ground went ${beforeTheme} → ${afterTheme}`);
await page.screenshot({ path: path.join(SHOTS, 'light.png') });
await page.evaluate(() => {
	document.documentElement.setAttribute('data-theme', 'dark');
	document.documentElement.setAttribute('data-ink', 'light');
});
await page.waitForTimeout(200);

// ── 11. A phone ─────────────────────────────────────────────────────

await page.setViewportSize({ width: 390, height: 780 });
await page.evaluate(() => { document.getElementById('stage').style.height = '50vh'; });
await page.waitForTimeout(500);
await reset();
await play('ls');
await page.waitForTimeout(300);
const phone = await page.evaluate(() => ({
	cols: window.__term.size().cols,
	scrollW: document.documentElement.scrollWidth,
	clientW: document.documentElement.clientWidth,
	canvasW: document.querySelector('.term-canvas').getBoundingClientRect().width,
	termW: document.querySelector('.term').getBoundingClientRect().width,
}));
check(phone.scrollW <= phone.clientW,
	`at phone width the page does not scroll sideways: scrollWidth ${phone.scrollW} vs clientWidth ${phone.clientW}`);
check(phone.canvasW <= phone.termW && phone.cols >= 20,
	`and the grid fits the panel rather than the panel fitting the grid: ${phone.cols} columns, `
	+ `canvas ${phone.canvasW.toFixed(1)}px inside a ${phone.termW.toFixed(1)}px panel`);
await page.screenshot({ path: path.join(SHOTS, 'phone.png') });
await page.setViewportSize({ width: 1200, height: 800 });
await page.waitForTimeout(500);

// ── 12. Self-tests: each of these checks is proved on broken code ────
//
// Every property below is broken in the live page, the check that guards it is required to
// go RED, and then it is restored and required to go green. Freezing a check that cannot
// fail into a suite is worse than having no check, because it reads as cover.

await reset();

// (a) The pixel check would notice a renderer that stopped drawing.
await proved('the pixel check catches a renderer that stops painting',
	// The break is at the drawing itself rather than at the entry point: a stubbed
	// `_paintNow` would be quietly covered by the animation frame the write already
	// scheduled, and the check would pass over a renderer that had stopped.
	() => page.evaluate(() => {
		window.__savedFillRect = CanvasRenderingContext2D.prototype.fillRect;
		CanvasRenderingContext2D.prototype.fillRect = function () {};
	}),
	async () => {
		await page.evaluate(() => {
			window.__term.reset();
			window.__term.write('\x1b[48;5;1m  \x1b[0m');
			window.__term._paintNow();
		});
		await page.waitForTimeout(60);
		const px = await pixelAt(0, 0);
		const want = await cssColour('--term-ansi-1');
		return near(px, want);
	},
	() => page.evaluate(() => {
		CanvasRenderingContext2D.prototype.fillRect = window.__savedFillRect;
		window.__term._paintNow();
	}));

// (b) The key mapping check would notice an arrow that sent the wrong bytes.
await proved('the key check catches an arrow sending the wrong bytes',
	() => page.evaluate(() => {
		window.__realOnData = window.__sentRaw;
		window.__breakArrow = true;
		const ta = document.querySelector('.term-input');
		window.__evilKey = (e) => {
			if (e.key === 'ArrowUp' && window.__breakArrow) {
				e.stopImmediatePropagation();
				e.preventDefault();
				window.__sentRaw.push([0x1b, 0x5b, 0x42]);		// down, not up
			}
		};
		ta.addEventListener('keydown', window.__evilKey, true);
	}),
	async () => {
		const got = await typed('ArrowUp');
		return JSON.stringify(got) === JSON.stringify(bytesOf('\x1b[A'));
	},
	() => page.evaluate(() => {
		window.__breakArrow = false;
		document.querySelector('.term-input').removeEventListener('keydown', window.__evilKey, true);
	}));

// (c) The bracketed-paste check would notice the wrapper being dropped.
await proved('the paste check catches bracketed paste being sent bare',
	// The break is the program's request never arriving, which is the realistic
	// failure: a parser that dropped DECSET 2004 would look exactly like this.
	() => page.evaluate(() => {
		window.__savedWrite = window.__term.write;
		window.__term.write = function (d) {
			return window.__savedWrite(typeof d === 'string' ? d.split('\x1b[?2004h').join('') : d);
		};
	}),
	async () => {
		await reset();
		await page.evaluate(() => { window.__term.write('\x1b[?2004h'); window.__clearSent(); });
		await pasteEvent('one\ntwo');
		await page.waitForTimeout(60);
		const got = await page.evaluate(() => window.__sentRaw.flat().map(b => String.fromCharCode(b)).join(''));
		return got === '\x1b[200~one\rtwo\x1b[201~';
	},
	() => page.evaluate(() => { window.__term.write = window.__savedWrite; }));

// (d) The multi-line guard would notice the question being skipped.
await proved('the paste-guard check catches a multi-line paste going straight through',
	// Broken by making the terminal believe the program asked for bracketed paste when it
	// did not -- which is the same thing as the guard being skipped, from the outside.
	() => page.evaluate(() => {
		window.__savedReset = window.__term.reset;
		window.__term.reset = function () { window.__savedReset(); window.__term.screen.modes.bracketed = true; };
	}),
	async () => {
		await reset();
		await page.evaluate(() => { window.__clearSent(); });
		await pasteEvent('echo a\necho b\necho c');
		await page.waitForTimeout(80);
		return await page.evaluate(() => window.__sentRaw.flat().length === 0
			&& !document.querySelector('.term-paste').hidden);
	},
	() => page.evaluate(() => { window.__term.reset = window.__savedReset; }));
await page.evaluate(() => { const p = document.querySelector('.term-paste'); p.hidden = true; p.innerHTML = ''; });

// (e) The accessibility check would notice the mirror being hidden the wrong way.
await proved('the mirror check catches display:none, which empties the accessibility tree',
	() => page.evaluate(() => { document.querySelector('.term-mirror').style.display = 'none'; }),
	() => page.evaluate(() => {
		const m = document.querySelector('.term-mirror');
		const cs = getComputedStyle(m);
		return m.getAttribute('role') === 'region' && !!m.getAttribute('aria-label')
			&& cs.display !== 'none' && cs.visibility !== 'hidden';
	}),
	() => page.evaluate(() => { document.querySelector('.term-mirror').style.display = ''; }));

// (f) The focus-ring check would notice the ring moving inside the control.
await proved('the focus check catches a ring drawn with no offset',
	() => page.evaluate(() => {
		window.__ringStyle = document.createElement('style');
		window.__ringStyle.textContent = '.term:focus-within { outline-offset: 0 !important; }';
		document.head.appendChild(window.__ringStyle);
	}),
	async () => {
		await page.focus('.term-input');
		return await page.evaluate(() => {
			const cs = getComputedStyle(document.querySelector('.term'));
			return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && parseFloat(cs.outlineOffset) > 0;
		});
	},
	() => page.evaluate(() => { window.__ringStyle.remove(); }));

// (g) The damage check would notice a model that marked everything dirty.
await proved('the damage check catches a model that repaints the whole grid on every byte',
	() => page.evaluate(() => {
		const s = window.__term.screen;
		window.__savedCompose = s.compose;
		s.compose = function () { const d = window.__savedCompose.call(s); d.all = true; return d; };
	}),
	() => page.evaluate(() => {
		const s = window.__term.screen;
		s.compose();
		s.write('!');
		const d = s.compose();
		let rows = 0;
		for (let i = 0; i < d.rows.length; i++) if (d.rows[i]) rows++;
		return !d.all && rows === 1;
	}),
	() => page.evaluate(() => { window.__term.screen.compose = window.__savedCompose; }));

// (h) The scroll-blit check would notice a blit that drew the wrong pixels.
await proved('the blit check catches a scroll that shifts by the wrong number of rows',
	() => page.evaluate(() => {
		const s = window.__term.screen;
		window.__savedCompose2 = s.compose;
		s.compose = function () { const d = window.__savedCompose2.call(s); if (d.scrolled) d.scrolled += 1; return d; };
	}),
	() => page.evaluate(() => {
		const cv = document.querySelector('.term-canvas');
		const t = window.__term;
		t.reset();
		for (let i = 0; i < 40; i++) t.write('\x1b[3' + (i % 8) + 'mrow ' + i + ' with text\x1b[0m\r\n');
		t._paintNow();
		const grab = () => cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
		t.write('\x1b[36ma newly scrolled line\x1b[0m\r\n');
		t._paintFrame();
		const a = Array.from(grab());
		t._paintNow();
		const b = Array.from(grab());
		let diff = 0;
		for (let i = 0; i < b.length; i += 4) if (Math.abs(b[i] - a[i]) > 2) diff++;
		return diff === 0;
	}),
	() => page.evaluate(() => { window.__term.screen.compose = window.__savedCompose2; }));

// (i) The size check would notice a cell width that was assumed rather than measured.
await proved('the size check catches a grid computed from a guessed cell width',
	() => page.evaluate(() => {
		window.__savedCell = window.__term.cell;
		window.__term.cell = function () { return { w: 8, h: 16 }; };
	}),
	() => page.evaluate(() => {
		const c = window.__term.cell();
		return Math.abs(c.w - 8) > 0.01 && c.w > 3 && c.w < 40;
	}),
	() => page.evaluate(() => { window.__term.cell = window.__savedCell; }));

// (j) The selection check would notice a copy that lost the second row.
await proved('the selection check catches a copy that stops at the first row',
	() => page.evaluate(() => {
		window.__savedSel = window.__term.selection;
		window.__term.selection = function () { return window.__savedSel().split('\n')[0]; };
	}),
	async () => {
		await reset();
		await write('alpha bravo charlie\r\ndelta echo foxtrot\r\n');
		return await page.evaluate(() => {
			const t = window.__term, cv = document.querySelector('.term-canvas');
			const box = cv.getBoundingClientRect(), c = t.cell();
			const at = (col, row) => ({ clientX: box.left + col * c.w + 1, clientY: box.top + row * c.h + 1, button: 0, bubbles: true, detail: 1 });
			cv.dispatchEvent(new MouseEvent('mousedown', at(0, 0)));
			window.dispatchEvent(new MouseEvent('mousemove', at(18, 1)));
			window.dispatchEvent(new MouseEvent('mouseup', at(18, 1)));
			return t.selection() === 'alpha bravo charlie\ndelta echo foxtrot';
		});
	},
	() => page.evaluate(() => { window.__term.selection = window.__savedSel; }));

// (k) The announcement check would notice a live region reciting every line.
await proved('the announcement check catches a log that recites a build',
	() => page.evaluate(() => {
		const log = document.querySelector('[role="log"]');
		window.__spam = setInterval(() => {
			const p = document.createElement('p'); p.textContent = 'chatter'; log.appendChild(p);
		}, 40);
	}),
	async () => {
		await page.evaluate(() => { document.querySelector('[role="log"]').innerHTML = ''; window.__flood(2000); });
		await page.waitForTimeout(1100);
		return await page.evaluate(() => document.querySelectorAll('[role="log"] p').length <= 2);
	},
	() => page.evaluate(() => { clearInterval(window.__spam); document.querySelector('[role="log"]').innerHTML = ''; }));

// ── 13. Throughput, reported rather than asserted ───────────────────
//
// A number that depends on the machine is not a pass/fail, so it is printed. The one thing
// asserted is that the load case does not take longer than the frame it is drawn in.

const bench = await page.evaluate(() => window.__bench());
const notes = Object.entries(bench).map(([k, v]) => `      ${k.padEnd(26)} ${(+v).toFixed(2)}`);
check(bench['canvas scroll 200x50'] < 16.7,
	`a build log's frame — 200×50, one more line, blitted — fits inside a 60 Hz frame: `
	+ `${bench['canvas scroll 200x50'].toFixed(2)} ms`);
check(bench['canvas full 200x50'] < bench['dom rebuild 200x50'],
	`and a full canvas repaint beats the DOM alternative at the same grid: `
	+ `${bench['canvas full 200x50'].toFixed(2)} ms vs ${bench['dom rebuild 200x50'].toFixed(2)} ms`);

// ── 14. Every recording plays, and none of them throws ──────────────

for (const [name, what] of FIXTURES) {
	await reset();
	const before = errs.length;
	await play(name);
	await page.waitForTimeout(120);
	const drew = await page.evaluate(() => {
		const s = window.__term.screen;
		let ink = 0;
		for (let y = 0; y < s.rows; y++) if (s.lineText(s.absOfRow(y)).trim()) ink++;
		return ink;
	});
	// `less` is the one that should leave NOTHING behind: it draws on the alternate
	// screen and gives the primary one back exactly as it found it, which on a screen
	// this test cleared first means empty.
	const restores = name === 'less';
	check((restores ? drew === 0 : drew > 0) && errs.length === before,
		`${name} — ${what} — plays into ${drew} non-empty row(s)`
		+ `${restores ? ', which is the alternate screen giving the primary one back untouched' : ''}`
		+ ` and throws nothing`);
}

// ── The console ─────────────────────────────────────────────────────

const noise = /favicon|404 \(Not Found\)/;
const real = errs.filter(e => !noise.test(e));
check(real.length === 0, `no console errors${real.length ? ': ' + JSON.stringify(real.slice(0, 3)) : ''}`);

await browser.close();
server.close();

console.log('\n' + out.join('\n'));
console.log(`\n    Measured on this machine (headless Chromium, software rasterisation, dpr 1):`);
console.log(notes.join('\n'));
console.log(`\n    Screenshots: ${SHOTS}`);
console.log(bad === 0 ? `\nALL ${n} CHECKS PASSED (${selfTests.length} of them proved on broken code)`
	: `\n${bad} of ${n} FAILED`);
process.exit(bad === 0 ? 0 : 1);
