// removelinkhere.test.mjs — the one door every removal on this device goes through.
//
//	node --test www/js/removelinkhere.test.mjs
//
// A hand-written sidecar row has no id. `removeLinkHere` sent that blank id to `remove_link`,
// which now refuses it, and dropped this device's entry first: ◈/× on such a row did nothing and
// left the mark waiting (FLOW LINK-BLANK review, follow-up). It now removes such a row by its
// content; since D-20261031-11 there is no device entry, only the store row. The function is lifted
// out of `www/js/daimond.js` by name and run against stand-ins, so what is proved is what the page runs.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = readPage(path.join(HERE, 'daimond.js'), 'utf8');

function lift(name) {
	const at = SRC.indexOf('\tasync function ' + name + '(');
	assert.ok(at >= 0, 'daimond.js has no ' + name);
	const end = SRC.indexOf('\n\t}\n', at);
	return SRC.slice(at, end + 3);
}

function rig(refuse) {
	const calls = [];
	const app = {
		remove_link: async (...a) => {
			calls.push(['remove_link', ...a]);
			if (refuse) throw new Error('refused');
			return true;
		},
		remove_bare_link: async (...a) => {
			calls.push(['remove_bare_link', ...a]);
			if (refuse) throw new Error('refused');
			return true;
		},
	};
	// eslint-disable-next-line no-new-func
	const f = new Function('diamondApp',
		lift('removeLinkHere') + 'return removeLinkHere;')(() => app);
	return { calls, f };
}

const ROW = { owner: 'd1', from: 'diamond:d1', to: 'file:/a.txt', other: 'file:/a.txt', rel: 'holds' };

test('a link with an id goes by its id, and only the store is written', async () => {
	const { calls, f } = rig(false);
	assert.equal(await f({ ...ROW, id: 'k1' }), true);
	assert.deepEqual(calls, [['remove_link', 'd1', 'k1']]);
});

test('a hand-written row goes by its content, never by a blank id', async () => {
	const { calls, f } = rig(false);
	assert.equal(await f({ ...ROW, id: '' }), true);
	assert.ok(!calls.some((c) => c[0] === 'remove_link'), 'no blank-id remove_link');
	assert.deepEqual(calls, [['remove_bare_link', 'd1', 'diamond:d1', 'file:/a.txt', 'holds']]);
});

test('a refused removal, by id or by content, is said, never swallowed', async () => {
	await assert.rejects(() => rig(true).f({ ...ROW, id: '  ' }), /refused/);
	await assert.rejects(() => rig(true).f({ ...ROW, id: 'k1' }), /refused/);
});
