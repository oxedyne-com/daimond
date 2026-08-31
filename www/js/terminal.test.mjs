/* ============================================================
   Test — the terminal parser survives a control string split
   between two `write` calls.
   ------------------------------------------------------------
   Drives the REAL www/js/terminal.js screen model. The String
   Terminator that ends an OSC or DCS sequence is two bytes,
   ESC then '\' (0x1b 0x5c). A pty read splits a burst of output
   anywhere, so those two bytes routinely arrive in DIFFERENT
   `write` calls -- the comment at the top of the parser says a
   split sequence is "the normal case, not the odd one".

   The bug this proves against: the ST was recognised by looking
   BACK one byte in the current chunk (`s.charCodeAt(i - 1)`),
   which is NaN when the ESC ended the previous chunk. The
   terminator was then missed and the parser went on swallowing
   the rest of the session into the string payload, drawing
   nothing -- a live terminal that looks hung, which is exactly
   what an interactive `ssh` produced (its remote shell and tmux
   emit OSC/DCS strings, and ssh delivers the remote's output in
   many small, arbitrarily split writes).

   Run:  node www/js/terminal.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

// The file is a browser IIFE that assigns window.DaimondTerminal.
// It touches `window` only inside functions, so a bare object is
// enough to load it; the screen model needs no DOM at all.
globalThis.window = globalThis.window || {};
(0, eval)(readFileSync(join(HERE, 'terminal.js'), 'utf8'));
const T = globalThis.window.DaimondTerminal;

const enc = new TextEncoder();
let failures = 0;
function check(name, cond) {
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name); failures++; }
}

// The first row's text, trailing blanks trimmed.
function row0(chunks) {
	const S = T.screen(40, 4, {});
	for (const c of chunks) S.write(c);
	return S.lineText(S.absOfRow(0)).replace(/\s+$/, '');
}

console.log('String Terminator handling');

// The sequences that already worked, kept so a fix cannot regress them.
check('OSC ended by ST in one write draws the text after it',
	row0(['\x1b]0;title\x1b\\AFTER']) === 'AFTER');
check('OSC ended by BEL in one write draws the text after it',
	row0(['\x1b]0;title\x07AFTER']) === 'AFTER');

// The bug: the ST split across two writes -- ESC ends the first,
// '\' begins the second. Everything after it must still draw.
check('ST split across writes still terminates the string',
	row0(['\x1b]0;title\x1b', '\\AFTER']) === 'AFTER');
check('ST split across writes, at the byte level (Uint8Array)',
	row0([enc.encode('\x1b]0;title\x1b'), enc.encode('\\AFTER')]) === 'AFTER');

// A semantic-prompt marker (OSC 133) split the same way: the ground
// text before it and the shell prompt after it must both survive.
check('a split OSC-133 prompt marker does not swallow the prompt',
	row0(['pre\x1b]133;A\x1b', '\\$ hi']) === 'pre$ hi');

// A DCS string (ESC P ... ST) split the same way: the payload is
// discarded, but the text after the ST draws.
check('DCS payload split at its ST discards cleanly and keeps drawing',
	row0(['\x1bPq;junk\x1b', '\\AFTER']) === 'AFTER');

// Preserved oddities: an ESC inside a string that is NOT part of an ST
// is dropped and the string continues to its real terminator, exactly
// as before the fix.
check('ESC not followed by \\ inside a string is dropped, string continues',
	row0(['\x1b]0;a\x1bXb\x07AFTER']) === 'AFTER');
check('ESC ESC \\ within one write terminates on the real ST',
	row0(['\x1b]0;t\x1b\x1b\\AFTER']) === 'AFTER');

console.log(failures === 0 ? '\nALL PASS' : ('\n' + failures + ' FAILURE(S)'));
if (failures) process.exitCode = 1;
