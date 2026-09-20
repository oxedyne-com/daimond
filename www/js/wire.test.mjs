/* ============================================================
   Test — the measure-before-send seam (www/js/wire.js).
   ------------------------------------------------------------
   Loads the REAL wire.js as the classic IIFE it is, onto a bare
   `window`, and proves the four things the lease door and the
   post door rest on:

     - the FALLBACK table equals today's live pins, so Phase A is
       byte-for-byte the gateway's rule with no gateway change;
     - `fits` is the gateway's own pre-decode estimate, VERBATIM,
       at the boundary (`b64.len()/4*3 <= cap`);
     - `learn` moves an entry ONLY for a positive finite number of
       a kind the table knows, so a missing or older gateway, or a
       junk value, changes nothing;
     - an unknown kind has cap 0 and `fits` refuses it.

   There is no --break here: wire.js is pure arithmetic with no
   prior bug to revert. It is the seam the other two fail-first
   tests weigh their payloads against.

   Run:  node www/js/wire.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

/// wire.js published onto a fresh `window`, exactly as the browser loads it.
function loadWire() {
	const win = {};
	const body = readFileSync(join(HERE, 'wire.js'), 'utf8');
	const fn = new Function('window', 'console', 'with (window) {\n' + body + '\n}');
	fn(win, { warn: () => {} });
	return win.DaimondWire;
}

const W = loadWire();
check('wire.js published DaimondWire', !!W && typeof W.fits === 'function');

console.log('\nthe fallback table equals the live pins\n');
check('limit(lease) === 65536 (sync.rs:378)',      W.limit('lease') === 65536, String(W.limit('lease')));
check('limit(post) === 65536 (app.jdat:158)',      W.limit('post') === 65536, String(W.limit('post')));
check('limit(post_rows) === 500 (app.jdat:159)',   W.limit('post_rows') === 500, String(W.limit('post_rows')));
check('limit(collect) === 1048576 (app.jdat:161)', W.limit('collect') === 1048576, String(W.limit('collect')));
check('limit(share) === 3145728 (share.js:125)',   W.limit('share') === 3145728, String(W.limit('share')));

console.log('\nthe boundary arithmetic is the gateway\'s, verbatim (b64/4*3 <= cap)\n');
// 87381 -> floor(87381/4)*3 = 21845*3 = 65535 <= 65536 : fits
check('fits(lease, 87381) is TRUE  (-> 65535 bytes, at the edge)', W.fits('lease', 87381) === true);
// 87384 -> floor(87384/4)*3 = 21846*3 = 65538 > 65536 : does not fit
check('fits(lease, 87384) is FALSE (-> 65538 bytes, one step over)', W.fits('lease', 87384) === false);
check('fits(post, 0) is TRUE (an empty door always fits)', W.fits('post', 0) === true);

console.log('\nlearn moves an entry only for a positive finite known kind\n');
check('before learning, source(lease) is the fallback', W.source('lease') === 'fallback');
W.learn({ lease: 131072 });
check('learn({lease:131072}) moved the cap', W.limit('lease') === 131072, String(W.limit('lease')));
check('and source(lease) is now served', W.source('lease') === 'served');
// The served value is what fits weighs against now.
check('fits(lease, 174760) is TRUE against the served 128 KiB', W.fits('lease', 174760) === true);

W.learn({ lease: 0 });        check('learn({lease:0}) moved nothing',       W.limit('lease') === 131072);
W.learn({ lease: 'x' });      check('learn({lease:"x"}) moved nothing',     W.limit('lease') === 131072);
W.learn({ lease: -5 });       check('learn({lease:-5}) moved nothing',      W.limit('lease') === 131072);
W.learn({ lease: Infinity }); check('learn({lease:Infinity}) moved nothing', W.limit('lease') === 131072);
W.learn(null);                check('learn(null) moved nothing',            W.limit('lease') === 131072);
W.learn({ bogus: 9 });        check('learn({bogus:9}) added no new kind',   W.limit('bogus') === 0 && W.source('bogus') === 'fallback');

console.log('\nan unknown kind has no cap and never fits\n');
check('limit(nope) === 0', W.limit('nope') === 0);
check('fits(nope, 1) is FALSE (refuse, never guess)', W.fits('nope', 1) === false);

console.log('\n' + checks + ' checks, ' + failures + ' failed');
process.exit(failures > 0 ? 1 : 0);
