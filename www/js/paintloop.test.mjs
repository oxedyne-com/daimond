// paintloop.test.mjs — no endless animation of a property only the main thread can paint (TAB-MEM-5D).
//
// On 5 Nov 2026 his idle tab held 88% of a core for hours: the debug-share lens's `pulse-ring`
// animated `box-shadow` on an infinite loop, and a paint property cannot run on the compositor,
// so every display frame became a main-thread frame that restyled and repainted the whole
// document (42 a second, ~18 ms each on a 152k-element page). The setup prompt's `astat-pulse`
// (background, box-shadow) was the same fault. An animation that never ends may move only what
// the compositor animates by itself: transform (and its translate/scale/rotate longhands) and
// opacity. A glow is drawn once on a pseudo-element and faded or scaled (css/app.css
// `pulse-ring`). The behaviour is held in a browser by dev/verify_idleframes.mjs; this holds
// the class, everywhere in www, without one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const WWW = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['pkg', 'vendor', 'node_modules']);
// fixed: the properties Chromium, WebKit and Gecko animate on the compositor without a main-thread frame
const COMPOSITED = new Set(['transform', 'translate', 'scale', 'rotate', 'opacity']);

function files(dir, out = []) {
	for (const n of readdirSync(dir)) {
		if (SKIP.has(n)) continue;
		const f = join(dir, n);
		if (statSync(f).isDirectory()) files(f, out);
		else if (/\.(css|html|js)$/.test(n) && !/\.test\.mjs$/.test(n)) out.push(f);
	}
	return out;
}

/// Every `@keyframes name { ... }` in a text, with the properties its frames set.
export function keyframes(text) {
	const out = [];
	const re = /@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{/g;
	let m;
	while ((m = re.exec(text))) {
		let depth = 1, i = re.lastIndex;
		for (; i < text.length && depth; i++) { if (text[i] === '{') depth++; else if (text[i] === '}') depth--; }
		const body = text.slice(re.lastIndex, i - 1);
		const props = new Set();
		for (const frame of body.matchAll(/\{([^{}]*)\}/g))
			for (const decl of frame[1].split(';')) { const k = decl.split(':')[0].trim().toLowerCase(); if (k) props.add(k); }
		out.push({ name: m[1], props: [...props] });
	}
	return out;
}

/// The keyframe names an `animation` shorthand (or animation-name with an infinite count) runs forever.
export function endless(text) {
	const names = new Set();
	for (const m of text.matchAll(/animation\s*:\s*([^;}'"]*infinite[^;}'"]*)/g))
		for (const part of m[1].split(','))
			for (const w of part.trim().split(/\s+/)) if (/^[a-z][\w-]*$/i.test(w) && !/^(infinite|ease|ease-in|ease-out|ease-in-out|linear|both|forwards|backwards|none|alternate|alternate-reverse|normal|reverse|running|paused|steps|start|end)$/.test(w)) names.add(w);
	return names;
}

test('no endless animation moves a property the compositor cannot run', () => {
	const kf = new Map(), runs = new Map();
	for (const f of files(WWW)) {
		const t = readFileSync(f, 'utf8');
		for (const k of keyframes(t)) kf.set(k.name, { props: k.props, at: relative(WWW, f) });
		for (const n of endless(t)) runs.set(n, relative(WWW, f));
	}
	assert.ok(kf.has('pulse-ring') && runs.has('pulse-ring'), 'the scan finds the lens pulse (a scan that finds nothing proves nothing)');
	const bad = [];
	for (const [n, at] of runs) {
		const k = kf.get(n);
		if (!k) continue;
		const paint = k.props.filter(p => !COMPOSITED.has(p));
		if (paint.length) bad.push(`${n} (run forever in ${at}, keyframes in ${k.at}) animates ${paint.join(', ')}`);
	}
	assert.deepEqual(bad, []);
});

test('the scan would catch the 5 Nov fault', () => {
	const t = '@keyframes pulse-ring { 0%, 100% { box-shadow: 0 0 0 0 red; } 50% { box-shadow: 0 0 0 5px red; } }'
		+ '.ds-indicator { animation: pulse-ring 1.6s ease-in-out infinite; }';
	assert.deepEqual(keyframes(t), [{ name: 'pulse-ring', props: ['box-shadow'] }]);
	assert.deepEqual([...endless(t)], ['pulse-ring']);
});
