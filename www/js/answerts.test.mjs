/* Test -- the answer's ts is stamped once, at its first token (lead ruling, P2.3c1).
   THE SEAM. The live answer row carried no ts and the finished answer was stamped at the end, so
   their meta differed and every answer ended with an `edit` row re-sending its whole text.
   NOW. One shape for both (`answerRow`), the ts stamped once at the first token and kept to the end:
   the writer grows the row with `more` rows and its end, never an `edit`. Prose turned into
   thinking stamps the next answer afresh. Checked on the REAL writer (wasm log_diff).
   Run:  node --test www/js/answerts.test.mjs */
import { readPage } from '../../dev/pagesrc.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', 'pkg');
const SRC = readPage(join(HERE, 'daimond.js'), 'utf8');

function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return null;
	let depth = 0, i = src.indexOf('{', start);
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}' && --depth === 0) break;
	}
	return src.slice(start, i + 1);
}

function rig() {
	const sent = [];
	const env = { _liveMid: { u1: 'a1' }, _liveTurn: {}, _liveProd: { u1: 'p1' }, _liveAns: { u1: { ts: 0, extra: { handoffFellBack: 'dev9' } } } };
	const body = (lift(SRC, 'answerRow') || '') + '\n' + (lift(SRC, 'logTurnRows') || '');
	const f = new Function('_liveMid', '_liveTurn', '_liveProd', '_liveAns', 'selfDeviceId', 'turnMessages', 'logTurn', 'diag',
		body + '\nreturn { answerRow: typeof answerRow === "function" ? answerRow : null, logTurnRows };')(
		env._liveMid, env._liveTurn, env._liveProd, env._liveAns, () => 'dev1',
		(msgs, u) => msgs.filter((m) => m.mid === u).map((m) => Object.assign({}, m)),
		(chat, u, msgs) => { sent.push(JSON.parse(JSON.stringify(msgs))); return Promise.resolve(true); }, () => {});
	return { env, sent, f };
}

const realNow = Date.now;
function at(t, fn) { Date.now = () => t; try { return fn(); } finally { Date.now = realNow; } }

test('the live answer and the finished one carry one ts, from the first token, in one shape', () => {
	const { env, sent, f } = rig();
	assert.ok(f.answerRow, 'answerRow is in the page');
	const chat = { id: 'c1', messages: [{ role: 'user', content: 'q', mid: 'u1', ts: 1 }] };
	env._liveTurn.u1 = 'Hel';
	at(1000, () => f.logTurnRows(chat, 'u1'));
	env._liveTurn.u1 = 'Hello';
	at(2000, () => f.logTurnRows(chat, 'u1'));
	const live1 = sent[0][1], live2 = sent[1][1];
	assert.equal(live1.ts, 1000, 'stamped at the first token');
	assert.equal(live2.ts, 1000, 'and kept');
	const fin = at(3000, () => f.answerRow('u1', 'a1', 'Hello there', 'p1', env._liveAns.u1));
	const meta = (r) => JSON.stringify(Object.entries(r).filter(([k]) => k !== 'content'));
	assert.equal(meta(fin), meta(live2), 'the finished answer is the live row grown, nothing else changed');
	assert.equal(fin.handoffFellBack, 'dev9');
});

test('prose turned into thinking: the next answer is stamped at its own first token', () => {
	const src = lift(SRC, 'runTurn') || '';
	assert.match(src, /logThinking\(chat, turnText, umid\); turnText = '';[^\n]*_liveAns\[String\(umid\)\]\.ts = 0/,
		'the thinking reset clears the stamp');
	assert.match(src, /var amsg = answerRow\(/, 'the finished answer is built by answerRow');
});

test('on the real writer: the answer grows by more rows and ends, with no edit', { skip: !existsSync(join(PKG, 'oxedyne_daimond_bg.wasm')) }, async () => {
	const m = await import(join(PKG, 'oxedyne_daimond.js'));
	m.initSync({ module: readPage(join(PKG, 'oxedyne_daimond_bg.wasm')) });
	const { env, sent, f } = rig();
	const chat = { id: 'c1', messages: [{ role: 'user', content: 'q', mid: 'u1', ts: 1 }] };
	env._liveTurn.u1 = 'Hel';
	at(1000, () => f.logTurnRows(chat, 'u1'));
	env._liveTurn.u1 = 'Hello';
	at(2000, () => f.logTurnRows(chat, 'u1'));
	const fin = at(3000, () => f.answerRow('u1', 'a1', 'Hello there', 'p1', env._liveAns.u1));
	let w = {}; const kinds = [];
	for (const msgs of [sent[0], sent[1], [sent[1][0], fin]]) {
		const got = JSON.parse(m.log_diff(JSON.stringify(w), JSON.stringify(msgs), ''));
		w = got.writer; got.changes.forEach((c) => kinds.push(c.kind));
	}
	const end = JSON.parse(m.log_diff(JSON.stringify(w), JSON.stringify([sent[1][0], fin]), JSON.stringify({ status: 'done' })));
	end.changes.forEach((c) => kinds.push(c.kind));
	assert.ok(!kinds.includes('edit'), kinds.join());
	assert.deepEqual(kinds.filter((k) => k !== 'msg'), ['more', 'more', 'end']);
});
