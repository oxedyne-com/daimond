// apppathsorder.test.mjs -- UNBLOCK-97: the page modules carry their own path tests.
//
// 2 Nov 2026, 18:46:26, his phone (0af8901, build 892c3ad90a85): `ReferenceError: Can't
// find variable: DaimondAppPaths`, and in the same page 35 chats refused as naming "a
// Diamond id that is not one" (`19fbb77697a3` among them, a plain engine id). The page
// modules read `DaimondAppPaths` from `window`, set by the classic script
// `js/apppaths.js`; a document that did not run that script (the 31 Oct build's
// index.html loads `markshere.js` in its place, and a classic script that fails to load
// is silent) left every module that asks it broken for the life of the page, and two of
// them failed silently: `chatDiamondOk` refused every chat with a Diamond, and
// `syncAppState` let app state and keeper records into the sync census.
//
// The window here holds no `DaimondAppPaths`, as that document's did. The modules must
// answer from their own import, whatever the document loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function page() {
	const win = makeWindow({});
	assert.equal(win.DaimondAppPaths, undefined, 'the window is the one the stale document left');
	return loadPage({ window: win, want: ['chatDiamondOk', 'syncAppState', 'refReachable'] });
}

test('a chat naming a real Diamond id is accepted with no DaimondAppPaths on the window', () => {
	const P = page();
	// UNBLOCK-98: the Diamonds whose chats his phone refused, from his own page load.
	const fx = readFileSync(join(here, '..', '..', 'dev', 'fixtures', 'u97', 'his_phone_refused.txt'), 'utf8')
		.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('provenance:')).join('\n');
	const refused = JSON.parse(fx).refused;
	assert.ok(refused.length >= 3, 'the fixture holds his refused chats');
	for (const r of refused) assert.equal(P.chatDiamondOk({ id: r.chat, diamondId: r.diamondId }), true, r.diamondId);
	assert.equal(P.chatDiamondOk({ id: 'c20', diamondId: '../19fbb77697a3' }), false);
});

test('app state and keeper records stay out of the census with no DaimondAppPaths on the window', () => {
	const P = page();
	assert.equal(P.syncAppState('system/agents/x.md'), true);
	assert.equal(P.syncAppState('chats/c1/versions/0001.files.json'), true);
	assert.equal(P.syncAppState('notes/x.md'), false);
});

test('a store path is reachable from any workspace with no DaimondAppPaths on the window', () => {
	const P = page();
	assert.equal(P.refReachable('file:[machine:usr@x#1]diamonds/19fbb77697a3/transcript.md'), true);
});

test('no page module reads DaimondAppPaths from the window', () => {
	const free = JSON.parse(readFileSync(join(here, '..', '..', 'dev', 'pagesplit', 'free_today.json'), 'utf8'));
	assert.ok(!free.includes('DaimondAppPaths'), 'DaimondAppPaths is not a page global');
	const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
	assert.ok(!/<script[^>]*apppaths\.js/.test(html), 'index.html does not load apppaths.js as a classic script');
});
