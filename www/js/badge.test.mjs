/* ============================================================
   Test — the dock count badge is WIRED, and to both callers.
   ------------------------------------------------------------
   messaging_plan §10.1 makes the in-app count REQUIRED: with Web
   Push declined it is "the app's only notification". It was
   built, removed on 2026-08-31 at the owner's word while
   messaging had no caller at all, and is back with both callers
   wired — Mail from `daimond:mail-arrived`, messages from
   `DaimondPost.unread()` — which is the shape §10.1 asks for.

   This file guarded the REMOVAL. It now guards the wiring, and
   the reason it is a SOURCE guard is unchanged: the count lives
   in the `Badge` closure inside `www/js/daimond.js`, an ES
   module that imports the compiled wasm surface
   (`import * as Wasm from '../pkg/oxedyne_daimond.js'`). The
   other `.test.mjs` files here load classic IIFE scripts into a
   hand-rolled `with(window)` sandbox; a wasm-importing module
   cannot be instantiated that way. What the badge DRAWS is
   proved in a real browser by `dev/verify_social.mjs` §2; what
   is asserted here is that every seam it needs exists, because a
   seam quietly deleted is how it came to be unreachable before.

   The checks are proven able to fail: `--break` scans a copy of
   the source with one seam cut, and the checks that name it go
   red under it.

     node www/js/badge.test.mjs --break unwire   # the callers go
     node www/js/badge.test.mjs --break nocss    # the mark is unstyled
     node www/js/badge.test.mjs                  # and then, clean
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

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || 'unwire') : '';
})();

function read(rel) { return readFileSync(join(HERE, rel), 'utf8'); }

function main() {
	let js   = read('daimond.js');
	let css  = read('../css/app.css');
	let post = read('post.js');
	const sync = read('sync.js');

	// The breaks. Each cuts ONE seam, so the check that names it is the check
	// that reddens — a break that broke everything would prove nothing about
	// which assertion was doing the work.
	if (BREAK === 'unwire') {
		js   = js.split("window.DaimondBadge.post = postBadge;").join('var _gone =');
		post = post.split('DaimondBadge.post()').join('void 0');
	}
	if (BREAK === 'nocss') {
		css = css.split('.dock-count').join('.dock-count-was');
	}

	// ── the count renders ──────────────────────────────────────
	console.log('(a) the circled count is built and styled');
	check('daimond.js creates a `.dock-count` element',
		js.indexOf("'dock-count'") !== -1,
		'nothing builds the mark');
	check('and never draws it holding a zero',
		js.indexOf("b.textContent = n ? String(n) : '';") !== -1
		&& js.indexOf('b.hidden = !n;') !== -1,
		'a count of nothing would draw a 0');
	check('and marks a panel head where one offers a place',
		js.indexOf('rail-count-host') !== -1);
	check('app.css styles `.dock-count`',
		css.indexOf('.dock-count {') !== -1,
		'the mark is unstyled');
	check('and lifts it out of the chip\'s flow, so an arrival moves no chip',
		css.indexOf('.ptag .dock-count') !== -1 && css.indexOf('position: absolute;') !== -1);

	// ── it does not mark what is in front of the reader ────────
	console.log('(b) it counts only what the reader is not looking at');
	check('an arrival at a visible panel is refused',
		js.indexOf('if (!n || visible(id)) return;') !== -1,
		'`bump` would mark a panel on screen');
	check('and opening a panel clears its count',
		js.indexOf("Badge.seen('mail')") !== -1,
		'nothing clears the mail count');

	// ── both callers ───────────────────────────────────────────
	console.log('(c) both callers are wired, which is what §10.1 asks for');
	check('daimond.js publishes `DaimondBadge`', js.indexOf('window.DaimondBadge = Badge;') !== -1);
	check('Mail bumps it from its own arrival event',
		js.indexOf("window.addEventListener('daimond:mail-arrived'") !== -1
		&& js.indexOf("Badge.bump('mail', d.count)") !== -1);
	check('messages set it from the honest tally',
		js.indexOf('function postBadge()') !== -1
		&& js.indexOf("Badge.set('social', DaimondPost.unread())") !== -1);
	check('and the tally is recomputed when a message lands',
		js.indexOf("window.addEventListener('daimond:post-arrived'") !== -1,
		'an arrival would raise no mark');
	check('post.js raises that arrival event',
		post.indexOf("var ARRIVED = 'daimond:post-arrived';") !== -1);
	check('post.js tells the badge when the tally moves',
		post.indexOf('DaimondBadge.post()') !== -1,
		'reading a message would leave the mark up');
	check('sync.js tells it too, for a message read on another device',
		sync.indexOf('DaimondBadge.post()') !== -1);
	check('and `postBadge` is published for both of them',
		js.indexOf('window.DaimondBadge.post = postBadge;') !== -1);

	// ── the chips themselves ───────────────────────────────────
	console.log('(d) the chips the count sits on');
	check('the chip row #panel-tags is still rendered', js.indexOf('panel-tags') !== -1);
	check('a chip is still built with class `ptag`', js.indexOf("'ptag ") !== -1);
	check('the counts are repainted after the row is rebuilt',
		js.indexOf('Badge.paint();') !== -1);
	check('the Social and Email panels are still opened',
		js.indexOf("DaimondSocial.onOpen()") !== -1 && js.indexOf('DaimondMail.onOpen()') !== -1);

	console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks
		+ ' checks' + (BREAK ? ' (--break ' + BREAK + ')' : ''));
	process.exit(failures ? 1 : 0);
}

main();
