// unionrefused.test.mjs — a link union the store refuses is said once, and not retried.
//
//	node --test www/js/unionrefused.test.mjs
//
// `unionDiamondLinks` swallowed every refusal as "it goes on the next pull". A sidecar here that
// is not UTF-8 is refused on every pull, so that was a silent retry for ever (d1k45 check, minor).
// The function is lifted out of `www/js/daimond.js` by name and run against stand-ins.
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

// What the store's refusal reads as across the boundary: its tags in brackets (fe2o3's Display).
const REFUSAL = 'UpstreamErr{[Invalid Input] "x"}\nLocalErr{[Invalid Input UTF8] "The link sidecar is not UTF-8"}';
const IO_FAULT = 'LocalErr{[IO File Write] "The disk is full"}';

function rig(refuse) {
	const calls = [], said = [];
	let fault = refuse === true ? REFUSAL : refuse;
	const app = {
		union_links: async (...a) => {
			calls.push(a);
			if (fault) throw new Error(fault);
			return true;
		},
		heal() { fault = null; },
		break() { fault = IO_FAULT; },
	};
	// eslint-disable-next-line no-new-func
	const f = new Function('packLinks', 'trail', 'toast', 't', 'friendlyError',
		'var unionRefused = {}, unionFaultSaid = {};\n' + lift('storeRefusal') + lift('unionLinksSaid') + lift('unionDiamondLinks')
		+ 'return unionDiamondLinks;')(
		(d) => d, () => {}, (text, err) => said.push([text, err]), (k) => k,
		(e) => e.message);
	return { calls, said, f, app };
}

test('a refused union is said once and not asked again for the same copy', async () => {
	const { calls, said, f, app } = rig(true);
	const r = { id: 'd1' };
	assert.equal(await f(app, r, '{"id":"x"}\n'), false);
	assert.equal(await f(app, r, '{"id":"x"}\n'), false);
	assert.equal(calls.length, 1, 'the same copy is not retried');
	assert.equal(said.length, 1);
	assert.match(said[0][0], /not UTF-8/);
	assert.equal(said[0][1], true);
	// A new copy from the other side is a new question.
	await f(app, r, '{"id":"y"}\n');
	assert.equal(calls.length, 2);
});

test('a union taken is not said', async () => {
	const { calls, said, f, app } = rig(false);
	assert.equal(await f(app, { id: 'd1' }, '{"id":"x"}\n'), true);
	assert.equal(await f(app, { id: 'd1' }, '{"id":"x"}\n'), true);
	assert.equal(calls.length, 2);
	assert.equal(said.length, 0);
});

test('a passing I/O failure is said but not remembered: the next pull asks again', async () => {
	const { calls, said, f, app } = rig(IO_FAULT);
	const r = { id: 'd1' };
	assert.equal(await f(app, r, '{"id":"x"}\n'), false);
	assert.equal(said.length, 1);
	assert.match(said[0][0], /disk is full/);
	app.heal();
	assert.equal(await f(app, r, '{"id":"x"}\n'), true, 'the same copy is asked again and taken');
	assert.equal(calls.length, 2);
});

test('a passing I/O failure is toasted once per Diamond: a repeat goes to the trail only', async () => {
	const { calls, said, f, app } = rig(IO_FAULT);
	const r = { id: 'd1' };
	await f(app, r, '{"id":"x"}\n');
	await f(app, r, '{"id":"x"}\n');
	assert.equal(calls.length, 2, 'asked again');
	assert.equal(said.length, 1, 'said once');
});

test('a pull that succeeds resets it: fail, succeed, fail is said twice', async () => {
	const { said, f, app } = rig(IO_FAULT);
	const r = { id: 'd1' };
	await f(app, r, '{"id":"x"}\n');
	app.heal();
	assert.equal(await f(app, r, '{"id":"x"}\n'), true);
	app.break();
	await f(app, r, '{"id":"y"}\n');
	assert.equal(said.length, 2);
});
