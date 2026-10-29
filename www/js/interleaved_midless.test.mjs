// QA ccp3 (A) probe R1: a runner's session sent home is stored where the session here still stands at the runner's
// base (held === base), but the transcript holds a turn the runner never heard between base and the runner's marker
// (another tab or device ran t3 Here before t2's placeholder reached it; its rows synced in, its session did not).
// eb6f4d404's `sessionHeld` with no `holds` marks every row up to the marker as held, so `tailAfter` skips t3/a3.
// Run: node <this> <daimond.js>. FAIL = the next build's model never reads t3 and a3.
// SKIPPED for the gate (CCP3-QAFIX4) as FLOW, kept red on purpose: the root fix is the runner sending its own held
// set in `report.session` (kimberlite/src/errands/settle.rs ~1892, codec, vectors), with U2 in ccp4. Run it by hand
// with QA_FLOW=1 (or node --test with it set) to see it fail until then.
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readPage(process.argv[2] && !process.argv[2].endsWith('.mjs') ? process.argv[2] : join(HERE, 'daimond.js'), 'utf8');
function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return '';
	const brace = src.indexOf('{', start); let d = 0, i = brace;
	for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) { i++; break; } } }
	return src.slice(start + 1, i);
}
test('a mid-less note in the runner\'s turn keeps t3/a3 out of the held set (QA ccp3r A LOW-1)',
	{ skip: process.env.QA_FLOW ? false : 'FLOW: the runner sends its own held set (settle.rs ~1892), with U2 in ccp4' }, () => {
	const names = ['settleRunnerSession', 'staleEngine', 'captureSession', 'keepChatTaint', 'sessionMarker', 'engineHolds', 'tailAfter', 'sessionDoubt', 'sessionHeld'];
	const st = { held: null, diags: [] };
	const deps = { loadMsgTombs: () => ({}), window: { DaimondPeer: { settlingReport: (r) => !!r && r.t === 'report' } },
		diag: (t, d) => st.diags.push(t + ' ' + d), chatHoldingTurn: () => st.held, touchChat() {}, persistChats() {}, markChatTainted: () => false };
	const keys = Object.keys(deps);
	const api = new Function(...keys, names.map((n) => lift(SRC, n)).join('\n') + '\nreturn { settleRunnerSession, tailAfter, sessionDoubt };')(...keys.map((k) => deps[k]));
	const T0 = 1790000000000;
	const c = { id: 'c1', app: null, messages: [
			{ role: 'user', mid: 'u1', iturn: 'u1', ts: T0, content: 'q1' },
			{ role: 'assistant', mid: 'a1', iturn: 'u1', ts: T0 + 1, content: 'a1-words' },
			{ role: 'user', mid: 't2', iturn: 't2', ts: T0 + 2, content: 'read it' },
			{ role: 'user', mid: 't3', iturn: 't3', ts: T0 + 3, content: 'other q' },
			{ role: 'assistant', mid: 'a3', iturn: 't3', ts: T0 + 4, content: 'a3-words' },
			{ role: 'assistant', mid: 'e-t2-final', iturn: 't2', ts: T0 + 5, content: 'it says 7', framed: 1 }],
		session: { v: 1, upto: 'a1', uptoTs: T0 + 1, marks: { u1: 0 }, msgs: [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1-words' }] } };
	st.held = c;
	const out = api.settleRunnerSession({ t: 'report', status: 'done', turnId: 't2', chatId: 'c1',
		session: { v: 1, base: 'a1', upto: 'e-t2-final', uptoTs: T0 + 5, msgs: [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1-words' },
			{ role: 'user', content: 'read it', mid: 't2' }, { role: 'user', content: 'and the next page' }, { role: 'assistant', content: 'it says 7' }] } });
	const tail = api.tailAfter(c, c.session);
	const doubt = api.sessionDoubt(c, c.session, tail, '');
	console.log('settle ->', out, '| held', JSON.stringify(c.session.held || null), '| tail', JSON.stringify(tail.map((m) => m.mid)), '| doubt', JSON.stringify(doubt));
	const ok = !!doubt || (tail.some((m) => m.mid === 't3') && tail.some((m) => m.mid === 'a3'));
	console.log(ok ? 'PASS t3 and a3 reach the model' : 'FAIL t3 and a3 never reach the model: the stored session claims it holds them');
	if (!ok) throw new Error('t3 and a3 never reach the model');
});
