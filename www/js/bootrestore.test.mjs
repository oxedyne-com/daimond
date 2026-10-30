// bootrestore.test.mjs -- boot redraws the panel it was on and moves no page (QA ccp29 F6).
//
//	node --test www/js/bootrestore.test.mjs
//
// A reload on a phone restores the stack from history (phone_stack.js `begin`). Boot's
// `mshow` then pushed the turn page over it, so a reload on Settings landed on the
// conversation. Over the source: boot's call says `restore`, and both of mshow's pushes
// are skipped for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, 'page', f), 'utf8');

test('boot shows its panel as a restore, not a move', () => {
	const calls = read('boot.js').match(/\bmshow\([^;]*\);/g) || [];
	assert.ok(calls.length >= 1, 'boot calls mshow');
	for (const c of calls) assert.match(c, /restore:\s*true/, c);
});

test('mshow pushes no page on a restore', () => {
	const src = read('layout.js');
	const body = src.slice(src.indexOf('export function mshow('), src.indexOf('\n}\n', src.indexOf('export function mshow(')));
	const pushes = body.match(/^.*DaimondStack\.push\(.*$/gm) || [];
	assert.equal(pushes.length, 2, pushes.join('\n'));
	for (const p of pushes) assert.match(p, /!restore/, p);
});
