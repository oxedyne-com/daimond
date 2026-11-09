/* Test -- one definition of the phone layout (RAIL-STUCK landscape, 9 Nov).
   His iPhone held sideways is 852 px wide and 393 tall; the layout keyed on width alone gave it
   the desktop panels, and he was stuck on the rail. A phone is a narrow viewport OR a touch
   screen whose short side is phone-sized, and every CSS and JS site asks that one question:
   PHONE      the phone layout, in every `@media` and `matchMedia`
   DESKTOP    its exact negation, for the rules kept off a phone
   TOUCH      phone or any coarse pointer (touch sizing), a superset of PHONE
   Any other query naming the 760 cliff, any other width query in a `matchMedia`, or a bare
   `innerWidth` test of it would let a phone be laid out as a desktop again. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const WWW = join(dirname(fileURLToPath(import.meta.url)), '..');
const PHONE   = '(max-width: 760px), (pointer: coarse) and (max-height: 500px)';
const DESKTOP = 'not ((max-width: 760px) or ((pointer: coarse) and (max-height: 500px)))';
const TOUCH   = '(max-width: 760px), (pointer: coarse)';

function files(d) {
	const out = [];
	for (const e of readdirSync(d, { withFileTypes: true })) {
		const p = join(d, e.name);
		if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'pkg' && e.name !== 'node_modules') out.push(...files(p)); }
		else if (/\.(css|js|mjs|html)$/.test(e.name) && !/\.test\.mjs$/.test(e.name)) out.push(p);
	}
	return out;
}
const SRC = files(WWW).map((f) => ({ f: relative(WWW, f), s: readFileSync(f, 'utf8') }));

test('every @media naming the 760 cliff is PHONE, DESKTOP or TOUCH', () => {
	const bad = []; let n = 0;
	for (const { f, s } of SRC) for (const m of s.matchAll(/@media\s+([^{;`]+?)\s*\{/g)) {
		if (!/76[01]px/.test(m[1])) continue;
		n++;
		if (m[1] !== PHONE && m[1] !== DESKTOP && m[1] !== TOUCH) bad.push(f + ': ' + m[1]);
	}
	assert.ok(n > 20, 'found only ' + n + ' phone @media rules');
	assert.deepEqual(bad, []);
});

test('every width matchMedia is PHONE', () => {
	const bad = []; let n = 0;
	for (const { f, s } of SRC) for (const m of s.matchAll(/matchMedia\(\s*(['"])([^'"]*)\1/g)) {
		if (!/width/.test(m[2])) continue;
		n++;
		if (m[2] !== PHONE) bad.push(f + ': ' + m[2]);
	}
	assert.ok(n >= 8, 'found only ' + n + ' width matchMedia calls');
	assert.deepEqual(bad, []);
});

test('no bare innerWidth test of the 760 cliff', () => {
	const bad = [];
	for (const { f, s } of SRC) for (const line of s.split('\n')) {
		if (!/innerWidth\s*(<=?|>=?)\s*76[01]\b/.test(line)) continue;
		bad.push(f + ': ' + line.trim());
	}
	assert.deepEqual(bad, []);
});

// RAIL-STUCK portrait (9 Nov): WebKit settled his woken tab's true width without the query's 'change',
// and the rail stayed in its desktop seat. A flip is heard from js/phone.js alone, which asks again on
// every event that can move the viewport; a 'change' listener anywhere else is the one-shot again.
test('only phone.js listens to the phone query; every other site watches DaimondPhone', () => {
	const bad = [];
	for (const { f, s } of SRC) {
		if (f === 'js/phone.js') continue;
		for (const line of s.split('\n')) {
			if (/addEventListener\(\s*'change'|\.addListener\(/.test(line) && /mq|MQ|Mq/.test(line)) bad.push(f + ': ' + line.trim());
		}
	}
	assert.deepEqual(bad, []);
	const own = SRC.find((x) => x.f === 'js/phone.js');
	assert.ok(own, 'js/phone.js is missing');
	for (const ev of ['resize', 'orientationchange', 'pageshow', 'visibilitychange']) assert.match(own.s, new RegExp("'" + ev + "'"), 'phone.js does not ask again on ' + ev);
	const watchers = SRC.filter((x) => /DaimondPhone\.watch\(/.test(x.s)).map((x) => x.f).sort();
	assert.deepEqual(watchers, ['js/fullscreen.js', 'js/mobile.js', 'js/page/admin.js', 'js/page/layout.js', 'js/page/phone_home.js', 'js/page/sourcemenu.js', 'js/workspace.js']);
	const html = SRC.find((x) => x.f === 'index.html').s;
	const at = (n) => html.indexOf('<script src="js/' + n + '"');
	for (const n of ['workspace.js', 'mobile.js', 'fullscreen.js']) assert.ok(at('phone.js') > 0 && at('phone.js') < at(n), 'phone.js must load before ' + n);
});
