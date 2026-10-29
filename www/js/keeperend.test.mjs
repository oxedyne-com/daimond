// keeperend.test.mjs -- U4b TURN DRIVER + KEEPER END: the page no longer ends a keeper's turn.
//
//	node --test www/js/keeperend.test.mjs
//
// `engine::turn::drive` ends the keeper's turn once per turn, inside the engine, whichever way the
// turn went; the page only says whose turn it is (`run_turn`'s `own`, a Diamond thread's). The lease
// a hand-off runs under reaches the engine's TurnSpec from the claim's deadline (`deadAt`), and an
// ordinary send's spec names its chat without making one.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readPage(join(HERE, 'daimond.js'), 'utf8');
const PEER = readPage(join(HERE, 'peer.js'), 'utf8');

function lift(src, name) {
	const at = src.indexOf('function ' + name + '(');
	if (at < 0) return '';
	const end = src.indexOf('\n\t}\n', at);
	return src.slice(at, end < 0 ? undefined : end);
}

test('no page script calls end_keeper_turn (the engine ends the keeper turn)', () => {
	const calls = [];
	for (const f of readdirSync(HERE)) {
		if (!/\.(m?js)$/.test(f) || /\.test\.mjs$/.test(f)) continue;
		const src = readPage(join(HERE, f), 'utf8');
		src.split('\n').forEach((l, i) => { if (/end_keeper_turn\s*\(/.test(l)) calls.push(f + ':' + (i + 1)); });
	}
	assert.deepEqual(calls, [], 'the page calls end_keeper_turn at ' + calls.join(', '));
});

test('runTurn tells the engine a Diamond thread turn is its own', () => {
	const calls = PAGE.match(/app\.run_turn\(text, onEvent, turnPre[^\n]*?: undefined[^)]*\)/g) || [];
	assert.equal(calls.length, 3, 'three run_turn calls in runTurn');
	for (const c of calls) assert.match(c, /: undefined, !!chat\.diamondId\)$/, c);
});

test('an ordinary send names its chat in the TurnSpec, without making one', () => {
	const body = lift(PAGE, 'turnSpecFor');
	assert.ok(body, 'turnSpecFor present');
	assert.match(body, /chats\.find\(/, 'looks the Diamond chat up');
	assert.doesNotMatch(body, /daimonChat\(/, 'never daimonChat, which makes a record');
});

test('a hand-off turn carries its lease deadline into the TurnSpec', () => {
	assert.match(lift(PAGE, 'runSteerDetached'), /until:\s*Number\(\(ropts && ropts\.until\)/, 'runSteerDetached passes until');
	assert.match(PEER, /d\.runTurn\(ctx, e\.prompt, \{[^}]*until: deadAt/, 'runErrand hands the claim deadline to runTurn');
});
