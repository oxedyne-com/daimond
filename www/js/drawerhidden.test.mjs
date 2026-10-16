// drawerhidden.test.mjs -- the phone drawer, put away, is out of Tab and VoiceOver.
//
//	node --test www/js/drawerhidden.test.mjs
//
// The drawer hides by transform, so a closed drawer's controls were still in the
// Tab order and still read by VoiceOver, off the left edge (GATEFIX, r568). The first
// cut set `inert` from mobile.js, but its desktop restore runs on a 60 ms debounce
// after a resize, so a window widened from a phone's width kept a dead rail for that
// beat and the New Chat click fell through to #main (verify_handoff_fault case N).
// The closed drawer is now `visibility: hidden` in the same media query that slides
// it away, the #msheet pattern, so the layout and the hiding can never disagree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS  = fs.readFileSync(path.join(HERE, '..', 'css', 'mobile.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const JS   = fs.readFileSync(path.join(HERE, 'mobile.js'), 'utf8');

// The body of the first `@media (max-width: 760px) {` block, braces balanced.
function phoneBlock() {
	const at = CSS.indexOf('@media (max-width: 760px) {');
	assert.ok(at >= 0, 'mobile.css has no phone block');
	let depth = 0;
	for (let i = CSS.indexOf('{', at); i < CSS.length; i++) {
		if (CSS[i] === '{') depth++;
		else if (CSS[i] === '}' && --depth === 0) return CSS.slice(at, i + 1);
	}
	assert.fail('the phone block never closes');
}
// The declarations of the first rule whose selector list is exactly `sel`.
function rule(src, sel) {
	const re = new RegExp('(^|[};])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
	const m = src.match(re);
	return m ? m[2] : null;
}

test('on a phone the closed drawer is hidden and the open one is not', () => {
	const ph = phoneBlock();
	const closed = rule(ph, 'body:not(.drawer-open) .panel.rail');
	assert.ok(closed && /visibility:\s*hidden/.test(closed),
		'the closed drawer is off screen and must leave Tab and VoiceOver');
	const open = rule(ph, 'body.drawer-open .panel.rail');
	assert.ok(open && /translateX\(0\)/.test(open), 'the open drawer slides in');
	assert.ok(/visibility 0s(?!\s*\.)/.test(open), 'the open drawer unhides at once, or it slides in unseen');
	const base = rule(ph, '.panel.rail');
	assert.ok(base && /visibility 0s \.28s/.test(base), 'the close slide is seen before the drawer hides');
});

test('a widened window has a live rail at once: no script makes the rail inert', () => {
	assert.ok(!/\.inert\s*=/.test(JS), 'mobile.js sets inert, which only its debounced resize undoes');
	assert.ok(!/visibility/.test(rule(CSS.replace(/@media[^{]*\{[\s\S]*$/, ''), '.panel.rail') || ''),
		'the desktop rail must never hide');
});
