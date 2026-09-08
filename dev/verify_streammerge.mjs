// verify_streammerge.mjs — the mergeMessages streamed-growth rule, in isolation.
//
// The streaming hand-off relies on a peer's IN-PROGRESS transcript converging as
// successive progress frames carry the same message id at a growing length. This
// extracts the REAL mergeMessages + stampMessages source out of www/js/daimond.js
// (by literal slice, so it is the shipped code, not a paraphrase) and drives the
// properties the streaming path needs and the ones it must not break.
//
//   node dev/verify_streammerge.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'www/js/daimond.js'), 'utf8');

// Pull the two functions out by name, verbatim, so this tests the shipped bodies.
function slice(name) {
	const start = SRC.indexOf('\tfunction ' + name + '(');
	if (start < 0) throw new Error('could not find ' + name);
	// Walk braces from the first '{' after the signature to its match.
	let i = SRC.indexOf('{', start);
	let depth = 0, end = -1;
	for (; i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
	}
	return SRC.slice(start, end);
}

const OLD_LEGACY = /^legacy-\d/;			// matches the guard daimond.js uses
function loadMsgTombs() { return {}; }		// no tombstones in these cases

// eslint-disable-next-line no-eval
const factory = new Function('OLD_LEGACY', 'loadMsgTombs',
	slice('stampMessages') + '\n' + slice('mergeMessages') + '\n return mergeMessages;');
const mergeMessages = factory(OLD_LEGACY, loadMsgTombs);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const contentOf = (out, mid) => { const m = out.find((x) => x.mid === mid); return m ? m.content : undefined; };
const countOf = (out, mid) => out.filter((x) => x.mid === mid).length;

// 1. A think_log that GROWS across frames converges to the longest, never dupes.
{
	const a = [{ mid: 'u1', role: 'user', content: 'hi', ts: 1 },
		{ mid: 't1', role: 'think_log', content: 'Let me', ts: 2 }];
	const b = [{ mid: 't1', role: 'think_log', content: 'Let me think about it', ts: 2 }];
	const out = mergeMessages(a, b, 'c1');
	check('a growing think_log adopts the longer (prefix-extended) copy',
		contentOf(out, 't1') === 'Let me think about it', 'got ' + JSON.stringify(contentOf(out, 't1')));
	check('the grown message is not duplicated', countOf(out, 't1') === 1);
}

// 2. Direction independence: the longer wins whether it is a or b.
{
	const long = [{ mid: 't1', role: 'think_log', content: 'Let me think about it', ts: 2 }];
	const short = [{ mid: 't1', role: 'think_log', content: 'Let me', ts: 2 }];
	check('longer-in-a wins', contentOf(mergeMessages(long, short, 'c1'), 't1') === 'Let me think about it');
	check('longer-in-b wins', contentOf(mergeMessages(short, long, 'c1'), 't1') === 'Let me think about it');
}

// 3. An out-of-order OLD (shorter) frame never shrinks a message already grown.
{
	const grown = [{ mid: 't1', role: 'think_log', content: 'Let me think about it', ts: 2 }];
	const stale = [{ mid: 't1', role: 'think_log', content: 'Let', ts: 2 }];
	check('a late shorter frame does not shrink the stored message',
		contentOf(mergeMessages(grown, stale, 'c1'), 't1') === 'Let me think about it');
}

// 4. An empty tool_log result filled by a later frame converges (empty is a prefix).
{
	const a = [{ mid: 'k1', role: 'tool_log', name: 'read', content: '', ts: 3 }];
	const b = [{ mid: 'k1', role: 'tool_log', name: 'read', content: 'file contents here', outcome: 'done', ts: 3 }];
	const out = mergeMessages(a, b, 'c1');
	check('an empty tool result is filled by the later frame',
		contentOf(out, 'k1') === 'file contents here');
	check('the filled tool_log carries its outcome',
		(out.find((x) => x.mid === 'k1') || {}).outcome === 'done');
}

// 5. NON-prefix divergent content under one mid is NOT adopted (keeps first-wins),
//    so a genuine edit or a re-generation never silently overwrites by this rule.
{
	const a = [{ mid: 'x1', role: 'assistant', content: 'The answer is 42.', ts: 4 }];
	const b = [{ mid: 'x1', role: 'assistant', content: 'A completely different reply.', ts: 4 }];
	check('a divergent (non-prefix) same-mid copy does NOT overwrite (first wins)',
		contentOf(mergeMessages(a, b, 'c1'), 'x1') === 'The answer is 42.');
}

// 6. A DIFFERENT role with a prefix-matching content is not adopted (role guard).
{
	const a = [{ mid: 'r1', role: 'think_log', content: 'abc', ts: 5 }];
	const b = [{ mid: 'r1', role: 'assistant', content: 'abcdef', ts: 5 }];
	check('a role change is not treated as growth',
		contentOf(mergeMessages(a, b, 'c1'), 'r1') === 'abc');
}

// 7. The elision recovery still wins over the length rule: a slimmed (elided) copy
//    yields to the full one regardless of the prefix test (which is guarded off).
{
	const full  = [{ mid: 'e1', role: 'tool_log', content: 'the whole big result', ts: 6 }];
	const slim  = [{ mid: 'e1', role: 'tool_log', content: 'the whole big', elided: 7, ts: 6 }];
	check('a full copy replaces an elided one (a first)',
		contentOf(mergeMessages(slim, full, 'c1'), 'e1') === 'the whole big result');
	check('a full copy replaces an elided one (b first)',
		contentOf(mergeMessages(full, slim, 'c1'), 'e1') === 'the whole big result');
}

// 8. Ordinary distinct messages still union and sort by ts — the base behaviour.
{
	const a = [{ mid: 'm1', role: 'user', content: 'q', ts: 1 }];
	const b = [{ mid: 'm2', role: 'assistant', content: 'a', ts: 2 }];
	const out = mergeMessages(a, b, 'c1');
	check('distinct messages union in ts order',
		out.length === 2 && out[0].mid === 'm1' && out[1].mid === 'm2');
}

// 9. Multi-step monotone growth converges to the final full content across 3 frames.
{
	let store = [{ mid: 't9', role: 'think_log', content: 'one', ts: 7 }];
	store = mergeMessages(store, [{ mid: 't9', role: 'think_log', content: 'one two', ts: 7 }], 'c1');
	store = mergeMessages(store, [{ mid: 't9', role: 'think_log', content: 'one two three', ts: 7 }], 'c1');
	check('three successive frames converge to the final content',
		contentOf(store, 't9') === 'one two three' && countOf(store, 't9') === 1);
}

console.log('\n' + (bad.length ? 'FAILED ' + bad.length + '/' + (ok.length + bad.length) : 'ALL PASS ' + ok.length + '/' + ok.length));
process.exit(bad.length ? 1 : 0);
