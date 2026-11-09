// fakemailbox.test.mjs -- no dev/ probe's in-process cloud takes a side door of `/api/sync` as a push.
//
//	node --test www/js/fakemailbox.test.mjs
//
// The page posts its presence beat, its removal check and its lease to `/api/sync?presence=1`,
// `?removed=1` and `?lease=1`. A fake cloud that strips the query and writes every POST over the
// mailbox turns a beat on an empty mailbox into a blobless v1: no device can open it, so none is
// whole again and none commits. The COLLECT-GATE browser probe went red that way about one run in
// ten (QA PD3-r3 F2).
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dev');

/// Does this source stand up a mailbox that a POST writes, without answering the side doors first?
export function doorless(src) {
	if (!/p === '\/api\/sync'/.test(src) || !/cloud\.mailbox = \{/.test(src)) return false;
	return !/method !== 'GET' && String\(rawPath\)\.indexOf\('\?'\) !== -1/.test(src);
}

test('the detector flags a mailbox stub that writes a side door', () => {
	const bad = "if (p === '/api/sync') { if (method === 'GET') return x; cloud.mailbox = { version: 1 }; }";
	const good = "if (p === '/api/sync') { if (method !== 'GET' && String(rawPath).indexOf('?') !== -1) return y; cloud.mailbox = { version: 1 }; }";
	assert.equal(doorless(bad), true);
	assert.equal(doorless(good), false);
	assert.equal(doorless('const unrelated = 1;'), false);
});

test('every dev/ fake cloud answers the side doors before the mailbox', () => {
	const files = fs.readdirSync(DEV).filter((f) => /\.(mjs|js)$/.test(f));
	const hit = files.filter((f) => doorless(readPage(path.join(DEV, f), 'utf8')));
	assert.deepEqual(hit, []);
});
