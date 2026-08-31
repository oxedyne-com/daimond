/* ============================================================
   Test — the dock count badge is GONE (proposal #4).
   ------------------------------------------------------------
   The owner decided to remove the unsolicited circled count that
   the Social header chip and the Email chip carried. This guards
   the removal: the count no longer renders, and the chips that
   carried it stay.

   Why a SOURCE guard and not a rendering test: the count lived in
   the `Badge` closure inside `www/js/daimond.js`, which is an ES
   module that imports the compiled wasm surface
   (`import * as Wasm from '../pkg/oxedyne_daimond.js'`). The other
   `.test.mjs` files here load classic IIFE scripts into a
   hand-rolled `with(window)` sandbox; a wasm-importing module
   cannot be instantiated that way, so daimond.js cannot be driven
   in this harness. The removal is therefore guarded where it can
   be: the render path that created the `.dock-count` element, and
   the CSS that styled it, are asserted absent, while the chip row
   that opens each panel is asserted still built.

   The checks are proven able to fail: `--break` scans a copy of
   the source with the count-rendering re-introduced, and every
   "it is gone" check goes red under it.

     node www/js/badge.test.mjs --break readd   # the count comes back
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
	return i >= 0 ? (process.argv[i + 1] || 'readd') : '';
})();

function read(rel) { return readFileSync(join(HERE, rel), 'utf8'); }

function main() {
	let js  = read('daimond.js');
	let css = read('../css/app.css');
	const post = read('post.js');
	const sync = read('sync.js');

	// `--break readd`: put the count-rendering back, exactly the way it stood,
	// so the "it is gone" checks below have something to catch. If they pass
	// under this, they are not really checking.
	if (BREAK === 'readd') {
		js = js
			+ '\nvar Badge = (function(){return{set:function(){},bump:function(){},seen:function(){},paint:function(){}};})();'
			+ '\nwindow.DaimondBadge = Badge;'
			+ '\nfunction postBadge(){ Badge.set("social", 0); }'
			+ '\nfunction markCount(host,n){ var b=document.createElement("span"); b.className="dock-count"; host.appendChild(b); }'
			+ '\ndocument.querySelector("#panel-social .rail-count-host");';
		css = css + '\n.dock-count { display: inline-block; }\n';
	}

	// ── the count no longer renders ────────────────────────────
	console.log('(a) the circled count no longer renders');
	check('daimond.js creates no `.dock-count` element',
		js.indexOf("'dock-count'") === -1 && js.indexOf('"dock-count"') === -1,
		'a dock-count span is still built');
	check('daimond.js marks no `.rail-count-host`',
		js.indexOf('rail-count-host') === -1,
		'a panel head is still decorated with a count');
	check('daimond.js publishes no `DaimondBadge`',
		js.indexOf('DaimondBadge') === -1,
		'the badge module is still exported');
	check('daimond.js defines no `postBadge`',
		js.indexOf('postBadge') === -1,
		'the social-count recompute is still wired');
	check('app.css styles no `.dock-count`',
		css.indexOf('.dock-count') === -1,
		'the count is still styled');

	// ── nothing downstream still calls the badge ───────────────
	console.log('(b) no caller reaches for the removed badge');
	check('post.js does not call DaimondBadge', post.indexOf('DaimondBadge') === -1);
	check('sync.js does not call DaimondBadge', sync.indexOf('DaimondBadge') === -1);

	// ── the chips themselves stay ──────────────────────────────
	console.log('(c) the chips that carried the count are kept');
	check('the chip row #panel-tags is still rendered', js.indexOf('panel-tags') !== -1);
	check('a chip is still built with class `ptag`', js.indexOf("'ptag ") !== -1);
	check('the Social and Email panels are still opened',
		js.indexOf("DaimondSocial.onOpen()") !== -1 && js.indexOf('DaimondMail.onOpen()') !== -1);

	console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks
		+ ' checks' + (BREAK ? ' (--break ' + BREAK + ')' : ''));
	process.exit(failures ? 1 : 0);
}

main();
