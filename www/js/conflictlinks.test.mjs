// conflictlinks.test.mjs — a sync conflict's link merge says the store's refusal, as the ordinary union does.
//
//	node --test www/js/conflictlinks.test.mjs
//
// On a two-sided conflict the merge takes off the rows this device removed and unions the rows it
// added. Both calls swallowed a refusal with `catch (e) {}`, so a refused merge was silent (d1k6
// check, Q5). `mergeConflictLinks` now goes through the same door as `unionDiamondLinks`
// (`unionLinksSaid`): a refusal is toasted once per Diamond and per copy, and a refused removal is
// gathered into one notice. The functions are lifted out of `www/js/daimond.js` by name.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = readPage(path.join(HERE, 'daimond.js'), 'utf8');

function lift(name) {
	let at = SRC.indexOf('\tasync function ' + name + '(');
	if (at < 0) at = SRC.indexOf('\tfunction ' + name + '(');
	assert.ok(at >= 0, 'daimond.js has no ' + name);
	const end = SRC.indexOf('\n\t}\n', at);
	return SRC.slice(at, end + 3);
}

const REFUSAL = 'LocalErr{[Invalid Input UTF8] "The link sidecar is not UTF-8"}';

function rig({ refuseUnion = false, refuseRemove = false } = {}) {
	const calls = [], toasts = [], notices = [];
	const app = {
		union_links: async (...a) => { calls.push(['union_links', ...a]); if (refuseUnion) throw new Error(REFUSAL); return true; },
		remove_link: async (...a) => { calls.push(['remove_link', ...a]); if (refuseRemove) throw new Error(REFUSAL); return true; },
		remove_bare_link: async (...a) => { calls.push(['remove_bare_link', ...a]); if (refuseRemove) throw new Error(REFUSAL); return true; },
	};
	const marks = {
		drop: (...a) => { calls.push(['drop', ...a]); },
		parseSidecar: (line) => [JSON.parse(line)],
	};
	// eslint-disable-next-line no-new-func
	const f = new Function('DaimondMarksHere', 'diamondApp', 'trail', 'toast', 't', 'friendlyError', 'noticeDialog',
		'var unionRefused = {}, unionFaultSaid = {};\n' + lift('storeRefusal') + lift('unionLinksSaid') + lift('removeLinkHere')
		+ lift('dropRefused') + lift('mergeConflictLinks') + 'return mergeConflictLinks;')(
		marks, () => app, () => {}, (text, err) => toasts.push([text, err]), (k) => k, (e) => e.message,
		(title, body) => notices.push([title, body]));
	return { calls, toasts, notices, f, app };
}

const DROP = (id) => ({ id, line: JSON.stringify({ id, from: 'diamond:d1', to: 'file:/' + id, rel: 'holds' }) });

test('a refused merge union is said, once for the same copy', async () => {
	const { calls, toasts, f, app } = rig({ refuseUnion: true });
	const plan = { drop: [], add: '{"id":"x"}\n' };
	await f(app, 'd1', plan);
	await f(app, 'd1', plan);
	assert.equal(toasts.length, 1, 'said once');
	assert.match(toasts[0][0], /link\.union_failed/);
	assert.equal(toasts[0][1], true);
	assert.equal(calls.filter((c) => c[0] === 'union_links').length, 1, 'the same copy is not asked again');
});

test('refused merge removals are gathered into one notice, and their entries stay', async () => {
	const { calls, notices, toasts, f, app } = rig({ refuseRemove: true });
	await f(app, 'd1', { drop: [DROP('a'), DROP('b')], add: '' });
	assert.equal(notices.length, 1, 'one notice for the lot');
	assert.equal(notices[0][0], 'link.drop_failed');
	assert.equal(calls.filter((c) => c[0] === 'remove_link').length, 2, 'every removal is still tried');
	assert.ok(!calls.some((c) => c[0] === 'drop'), 'no entry dropped under a refusal');
	assert.equal(toasts.length, 0);
});

test('a merge the store takes says nothing', async () => {
	const { calls, notices, toasts, f, app } = rig();
	await f(app, 'd1', { drop: [DROP('a')], add: '{"id":"x"}\n' });
	assert.equal(notices.length + toasts.length, 0);
	assert.deepEqual(calls.map((c) => c[0]), ['remove_link', 'drop', 'union_links']);
});
