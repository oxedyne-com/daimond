// workerweb.test.mjs -- a dispatched worker inherits its chat's one web answer (UNBLOCK-21,
// D-20261015-24).
//
//	node --test www/js/workerweb.test.mjs
//
// The owner was asked about each website again by every worker a search sent out. Each worker
// has its own engine, so it never saw the chat's "may reach any website" answer, and the page's
// door parked a lone worker's question before it looked at any standing answer. Now:
//
//   W1  a chat's answer is read off its engine as one word, and an older engine gives none;
//   W2  a worker is handed that word, and a "no" is handed on as a no, never dropped;
//   W3  both ways a worker starts (the chat's collector and the bridged spawn) carry the word,
//       the dispatch puts it on the run, and both build branches hand it to the engine;
//   W4  the standing reading answer covers a light address and nothing else;
//   W5  the door checks that answer BEFORE it parks a lone worker, and after the runner route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, 'daimond.js'), 'utf8');

// The body of a function at any indentation, by counting braces.
function body(name) {
	const m = new RegExp('\\n\\t+(async )?function ' + name + '\\(').exec(APP);
	assert.ok(m, 'no function ' + name);
	let i = APP.indexOf('{', m.index), d = 0;
	for (let j = i; j < APP.length; j++) {
		if (APP[j] === '{') d++;
		else if (APP[j] === '}' && --d === 0) return APP.slice(m.index, j + 1);
	}
	throw new Error('unbalanced ' + name);
}

function lift(names, scope) {
	const w = makeWindow({ now: 1_000_000_000 });
	if (scope) w.DaimondHandMode = { scopeGranted: (s) => s === scope };
	return sliceDaimond(w, names, {}).fns;
}

test('W1 a chat answer is read off its engine as one word', () => {
	const { chatWebWord } = lift(['chatWebWord']);
	assert.equal(chatWebWord({ web_consent_word: () => 'allow' }), 'allow');
	assert.equal(chatWebWord({ web_consent_word: () => 'deny' }), 'deny');
	assert.equal(chatWebWord({}), '', 'an older engine handed on an answer');
	assert.equal(chatWebWord({ web_consent_word: () => { throw new Error('x'); } }), '');
	assert.equal(chatWebWord(null), '');
});

test('W2 a worker is handed the word, a no included', () => {
	const { giveWorkerWeb } = lift(['giveWorkerWeb']);
	for (const word of ['allow', 'deny']) {
		const got = [];
		giveWorkerWeb({ webConsent: word, app: { inherit_web_consent: (x) => got.push(x) } });
		assert.deepEqual(got, [word], 'the chat\'s ' + word + ' did not reach the worker');
	}
	const none = [];
	giveWorkerWeb({ webConsent: '', app: { inherit_web_consent: (x) => none.push(x) } });
	assert.deepEqual(none, [], 'an unasked chat handed its worker an answer');
	giveWorkerWeb({ webConsent: 'allow', app: {} });		// an older engine: no throw
});

test('W3 both starts carry the word to the engine', () => {
	const collect = /Workers\.dispatch\('', '', dispatched, chatTainted,[\s\S]{0,200}?web: chatWebWord\(app\)/;
	assert.match(APP, collect, 'the chat collector does not pass the chat\'s answer');
	assert.match(APP, /turnId: turn, how: live\.how \|\| null, web: String\(\(o && o\.web\) \|\| ''\)/,
		'the bridged spawn does not pass the answer it was handed');
	const disp = /dispatch: function \(diamondId[\s\S]*?tools: \[\],/.exec(APP);
	assert.ok(disp, 'no Workers.dispatch');
	assert.match(disp[0], /webConsent: \(owner && owner\.web\) \? String\(owner\.web\) : ''/,
		'the dispatch does not put the answer on the run');
	const b = /var build = function \(\) \{[\s\S]*?\n\t\t\t\};/.exec(APP);
	assert.ok(b, 'no worker build');
	assert.equal((b[0].match(/giveWorkerWeb\(run\)/g) || []).length, 2,
		'a build branch does not hand the answer to the worker\'s engine');
});

test('W4 the standing answer covers a light reading address only', () => {
	const { standingRead } = lift(['standingRead']);
	const fetch = { tool: 'web_fetch', granted: true };
	assert.equal(standingRead(fetch, 'https://docs.test/page', false), true);
	assert.equal(standingRead({ tool: 'web_open', granted: true }, 'https://docs.test/page', false), true);
	assert.equal(standingRead(fetch, 'https://docs.test/page', true), false, 'strict covered');
	assert.equal(standingRead({ tool: 'web_fetch', granted: false }, 'https://docs.test/', false), false,
		'no answer covered a page');
	assert.equal(standingRead({ tool: 'web_click', granted: true }, 'https://docs.test/', false), false,
		'a reading answer covered an act');
	const heavy = 'https://docs.test/?q=' + 'A1b2C3d4E5f6G7h8'.repeat(40);
	assert.equal(standingRead(fetch, heavy, false), false, 'a payload address was covered');
	const scoped = lift(['standingRead'], 'reading').standingRead;
	assert.equal(scoped({ tool: 'web_fetch', granted: false }, 'https://docs.test/', false), true,
		'the account reading grant did not cover a page');
});

test('W5 the door checks the answer before parking a lone worker', () => {
	const e = body('egressAllowed');
	const route = e.indexOf('runnerTurnOfReq(req)');
	const stand = e.indexOf('standingRead(req, url, strict)');
	const park  = e.indexOf('parkConsent(');
	assert.ok(stand > 0, 'the door does not ask for the standing answer');
	assert.ok(route < stand, 'the standing answer jumps the runner route');
	assert.ok(stand < park, 'a lone worker is parked before its chat\'s answer is checked');
});
