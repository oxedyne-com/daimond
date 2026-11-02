// apppaths.test.mjs -- the app's own path tests, re-homed from markshere.js when the
// folder-grant model went (D-20261031-11), and the absence gate for markshere.js itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const P = require('./apppaths.js');
const A = '0123456789abcdef';

test('isStorePath knows the store roots and nothing that only starts with one', () => {
	assert.ok(P.isStorePath('diamonds/' + A + '/x.md') && P.isStorePath('mail/a@b/inbox') && P.isStorePath('chats/c1/work/x'));
	assert.ok(P.isStorePath('system/guide') && P.isStorePath('system/usage/x'));
	assert.ok(!P.isStorePath('diamonds-old/x') && !P.isStorePath('src/diamonds/x') && !P.isStorePath(''));
});

test('isAppStatePath is the system/ app state and nothing else', () => {
	assert.ok(P.isAppStatePath('system/agents') && P.isAppStatePath('system/journal/x'));
	assert.ok(!P.isAppStatePath('system/other') && !P.isAppStatePath('diamonds/x'));
});

test('isKeeperRecordPath knows a keeper record at any depth, and nothing else', () => {
	assert.ok(P.isKeeperRecordPath('chats/c1/versions') && P.isKeeperRecordPath('chats/c1/versions/0002.files.json')
		&& P.isKeeperRecordPath('diamonds/' + A + '/versions/0001.files.json') && P.isKeeperRecordPath('chats/c1/.daimond/log.jsonl')
		&& P.isKeeperRecordPath('chats/c1/.red/x') && P.isKeeperRecordPath('Chats/C1/Versions/x'));
	assert.ok(!P.isKeeperRecordPath('chats/c1/work/versions/x.md') && !P.isKeeperRecordPath('notes/versions/x.md')
		&& !P.isKeeperRecordPath('chats/versions') && !P.isKeeperRecordPath('chats/c1/versionsx/y') && !P.isKeeperRecordPath(''));
});

// The device record of pressed marks is gone with the marks (D-20261031-11): no module, no
// script tag, no reader of `daimond-marks-here` or `DaimondMarksHere` anywhere on the page.
test('absence: markshere.js and the DaimondMarksHere record are gone from the page', () => {
	assert.ok(!existsSync(join(here, 'markshere.js')), 'markshere.js is deleted');
	const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
	assert.ok(!/markshere\.js/.test(html), 'index.html loads no markshere.js');
	assert.ok(/apppaths\.js/.test(html), 'index.html loads apppaths.js');
});
