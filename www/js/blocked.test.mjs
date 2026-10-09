// A turn that ended BLOCKED (T3, 2026-10-09): the engine sends `how: "failed"` with
// `why: "blocked"` and the sentence it ended on in `said`, so a page from before it reads a
// failure.  This page draws a plain stop that gives the reason.
//
// The functions live in a 50,000-line IIFE this harness cannot load, so each is cut out of the
// source by its own name and run alone.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const src  = readFileSync(join(HERE, 'daimond.js'), 'utf8');

// One top-level function of the IIFE, from its `function` line to its closing brace.
function cut(name) {
	const at = src.indexOf('\tfunction ' + name + '(');
	assert.ok(at >= 0, name + ' is not in daimond.js');
	const end = src.indexOf('\n\t}\n', at);
	return src.slice(at, end + 3);
}

const lift = (name, deps) => new Function(...Object.keys(deps),
	cut(name) + '\nreturn ' + name + ';')(...Object.values(deps));

const blocked = { how: 'failed', why: 'blocked', said: 'Not done: file_write was refused.',
	offered: 0, rounds: 2, calls: 1, refused: 1, failed: 0 };

test('the feed names a blocked turn, and an old failure stays an error', () => {
	const endedHow = lift('endedHow', {});
	assert.equal(endedHow('failed', 'blocked'), 'blocked');
	assert.equal(endedHow('failed'), 'error');
	assert.equal(endedHow('failed', ''), 'error');
});

test('a blocked turn is stored with its mark and its sentence, even with no tools offered', () => {
	// The halt test lives in endHalted since qab's endings (r541 QA B F2) met G T3.
	const END_HALTS = { stopped: 1, paused: 1, capped: 1, spend_cap: 1 };
	const endHalted = lift('endHalted', { END_HALTS });
	const endLogOf = lift('endLogOf', { newMid: () => 'm1', endHalted });
	const rec = endLogOf(blocked, '');
	assert.ok(rec, 'a blocked turn with nothing offered stored nothing');
	assert.equal(rec.how, 'failed', 'the wire word is kept, so an older device reads a failure');
	assert.equal(rec.why, 'blocked');
	assert.equal(rec.said, blocked.said);
	// And an ordinary failure with nothing offered still stores nothing.
	assert.equal(endLogOf({ how: 'failed', offered: 0 }, ''), null);
});

test('a blocked turn draws its stop line even though it drew text', () => {
	const fn = cut('appendEnding');
	assert.match(fn, /var blocked = e\.how === 'failed' && e\.why === 'blocked';/);
	assert.match(fn, /var stopped = endHalted\(e\);/);
	assert.match(cut('endHalted'), /\|\| \(e\.how === 'failed' && e\.why === 'blocked'\)/, 'endHalted counts a blocked turn as halted');
	assert.match(fn, /e\.how === 'stopped' \|\| blocked \? String\(e\.why/);
	assert.match(fn, /if \(blocked && !shown && e\.said\) word = String\(e\.said\);/);
	const parts = cut('endingParts');
	assert.match(parts, /if \(!endHalted\(e\) && !\(\(e\.offered \| 0\) > 0\)\) return null;/,
		'endingParts drops a blocked turn with nothing offered');
});

test('end.why_blocked is in every locale', () => {
	for (const loc of ['en', 'de', 'es', 'fr', 'pt-BR', 'ja', 'ko', 'zh-Hans']) {
		const t = readFileSync(join(HERE, '..', 'i18n', loc + '.js'), 'utf8');
		assert.match(t, /'end\.why_blocked':\s+'[^']+'/, loc + ' has no end.why_blocked');
	}
});

// r543 QA F-A2-3: the engine's own Decision on a blocked turn is marked `app: "blocked"`, and
// the page draws it in the user's language rather than in the engine's English.
const BLOCKED_KEYS = ['ask.blocked_q', 'ask.blocked_retry', 'ask.blocked_retry_means',
	'ask.blocked_stop', 'ask.blocked_stop_means', 'ask.blocked_why', 'ask.blocked_silent'];

test('the blocked Decision is drawn in the user\'s words and language', () => {
	const said = {};
	const blockedAsk = lift('blockedAsk', { t: (k) => { said[k] = 1; return '«' + k + '»'; } });
	const o = blockedAsk({ app: 'blocked', question: 'How should I go on?',
		options: [{ label: 'Try another way', means: 'x' }, { label: 'Stop here', means: 'y' }],
		recommend: 'Try another way', why: 'w', if_silent: 's' });
	assert.equal(o.question, '«ask.blocked_q»');
	assert.deepEqual(o.options.map((p) => p.label), ['«ask.blocked_retry»', '«ask.blocked_stop»']);
	assert.equal(o.recommend, o.options[0].label, 'the recommendation no longer names an option');
	for (const k of BLOCKED_KEYS) assert.ok(said[k], k + ' is not used');
	// A daimon's own question is drawn as it was asked.
	const own = { question: 'Which?', options: [] };
	assert.equal(blockedAsk(own), own);
	assert.match(cut('renderAsk'), /o = blockedAsk\(o\);/, 'renderAsk does not use it');
});

test('the blocked Decision is in every locale', () => {
	for (const loc of ['en', 'de', 'es', 'fr', 'pt-BR', 'ja', 'ko', 'zh-Hans']) {
		const t = readFileSync(join(HERE, '..', 'i18n', loc + '.js'), 'utf8');
		for (const k of BLOCKED_KEYS) {
			assert.match(t, new RegExp("'" + k.replace('.', '\\.') + "':\\s+'[^']+'"),
				loc + ' has no ' + k);
		}
	}
});
