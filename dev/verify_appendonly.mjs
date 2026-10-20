// gateway: none
// verify_appendonly.mjs — the prompt only grows (r578 U2), proved on the wire.
//
// WHAT IS CLAIMED. A provider's prompt cache pays out only on a byte-identical prefix. Before
// r578 a Diamond's system message carried the crystal, STATE.md, REQUIREMENTS.md, DECISIONS.md
// and "Recently changed", so ANY edit to them between turns rewrote message 0 and every cached
// byte after it was lost. Since U2 the system message holds only what does not change (role,
// tools, model note), and what does change rides as a note at the head of the turn's own user
// message, restating only the blocks that differ from their last copy. So:
//
//   1. the system message is byte-identical in every request of the conversation;
//   2. every request's `messages` array, serialised, is a byte-prefix of the next request's,
//      up to where the next adds its own -- within a turn AND across turns, with a STATE.md
//      edit before turn 2 and an unrelated file write before turn 3;
//   3. turn 2's note restates <state> (it changed) and not <crystal> (it did not);
//   4. no request's system message carries the crystal, STATE, REQUIREMENTS or "Recently
//      changed";
//   5. turn 1 sends the tree whole and turn 3, after a file write, only its changes, said as a
//      change list (r578c, D-20261020-03).  The turn after a fold sending both whole is proved
//      natively: `agent::tests::test_appendonly_a_fold_after_a_change_list_sends_the_tree_whole_00`;
//   6. below the size line nothing is shortened (r578d, D-20261020-11): seven read-heavy turns
//      follow, each reading a file over 4 kB, and across all ten turns no earlier result goes out
//      as a stub.  A break is classed by what parted: a tool result that went out whole and then
//      as a stub is a RETIREMENT break (legitimate once, past the line; never below it), anything
//      else is a DEFECT break.  The two are counted and reported apart.
//
// It reports the size of turn 1's note, which is the standing context a fresh Diamond turn
// pays for once.
//
// IT BITES. Against r577's wasm (ac2fe475f, the www/pkg this lane was branched with) the
// STATE.md edit rewrites the system message, and 1, 2 and 4 go red. And with no engine change:
//
//   node dev/verify_appendonly.mjs --break strippre    # the page hands `prior` back with
//                                                      # each message's pre/post dropped (the
//                                                      # shape `verify_neverforget` keeps), so
//                                                      # turn 1's note vanishes from its own
//                                                      # message and 2 goes red.
//   node dev/verify_appendonly.mjs --break retire0     # `retire_at` 0, the rule before r578d:
//                                                      # every turn boundary retires, so the
//                                                      # read-heavy turns break and 3r goes red.
//
//   eval "$(bash dev/world.sh 92 --up)" ; eval "$(bash dev/world.sh 92 --env)"
//   node dev/verify_appendonly.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, errors } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG  = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const BREAKS = ['strippre', 'retire0'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error('no such break: ' + BREAK + '\nhave: ' + BREAKS.join(' '));
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

// One mark per run, in turn 1's own message: every later request of this conversation
// carries it, and no other request in the world's log does.
const NONCE = 'appendonly-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const STATE_TWO = 'STATE-TWO-' + NONCE;

const logLines = () => {
	try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const ours = (from) => logLines().slice(from).map((l) => { try { return JSON.parse(l); } catch { return null; } })
	.filter((e) => e && Array.isArray(e.messages)
		&& e.messages.some((m) => typeof m.content === 'string' && m.content.includes(NONCE)));

const textOf = (m) => typeof m.content === 'string' ? m.content
	: Array.isArray(m.content) ? m.content.map((p) => p.text || '').join('') : '';
const lastUser = (msgs) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return textOf(msgs[i]); return ''; };
// The body as the engine sent it: serde writes compact JSON and the mock's JSON.parse keeps key
// order, so this is the request's own bytes for the `messages` array.
const ser = (msgs) => JSON.stringify(msgs);
const firstDiff = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
// The tail every retired result's stub ends with (compact.rs RESULT_RETIRED_TAIL).
const STUB = 'retired; call it again if you need it]';
// Why request `b` does not extend request `a`: null when it does; 'retire' when the first message
// that parted is a tool result that went whole in `a` and as a stub in `b`; else 'defect'.
const breakOf = (a, b) => {
	if (ser(b).startsWith(ser(a).slice(0, -1))) return null;
	let k = 0; while (k < a.length && k < b.length && ser(a[k]) === ser(b[k])) k++;
	const x = a[k], y = b[k];
	const retire = x && y && x.role === 'tool' && y.role === 'tool'
		&& !textOf(x).includes(STUB) && textOf(y).includes(STUB);
	return { kind: retire ? 'retire' : 'defect', at: k };
};
const BIG = (tag) => (tag + ' ').padEnd(5 * 1024, 'abcdefghij ');   // a result over 4 kB

const s = await open({ name: 'appendonly' + (BREAK ? '-' + BREAK : '') });
const { page } = s;

try {
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
	await signInAs(s, 'appendonly');
	await connectMock(s);
	await page.waitForTimeout(1500);

	const MOCK = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
	await page.evaluate(async (a) => {
		const mock = a.mock;
		const m = await import('/pkg/oxedyne_daimond.js');
		window.__m  = m;
		window.__vf = new m.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
		if (a.retire0) window.__vf.set_tune('{"retire_at":0}');
		window.__prior = [];
	}, { mock: MOCK, retire0: BREAK === 'retire0' });

	const write = (p, t) => page.evaluate((a) => window.__m.write_file(a.p, a.t), { p, t });
	const dia = await page.evaluate((nm) => window.__vf.create_diamond(nm), 'Appendonly');
	check('0. a Diamond to work in', !!dia, dia);
	await write(`diamonds/${dia}/STATE.md`, '# State\n\nSTATE-ONE\n');
	await write(`diamonds/${dia}/REQUIREMENTS.md`, '# Requirements\n\n## O1 Keep the prefix\n\n- [ ] T1 Hold it\n');

	// One turn. `prior` stays in the page and goes back WHOLE, as daimond.js stores `after`
	// (rec.session.msgs): a copy through the test would be a different object shape.
	const steer = (instruction) => Promise.race([
		page.evaluate(async (a) => {
			const out = Array.from(await window.__vf.steer_crystal(a.id, a.instruction, '[]',
				window.__prior, () => {}) || []);
			window.__prior = a.strip
				? out.map((m) => ({ role: m.role, content: m.content || '', tool_calls: m.tool_calls,
					tool_call_id: m.tool_call_id }))
				: out;
			return out.length;
		}, { id: dia, instruction, strip: BREAK === 'strippre' }),
		new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT: ' + instruction.slice(0, 40))), 30000)),
	]);

	const turns = [];
	const mark = logLines().length;
	const turn = async (n, instruction) => {
		const from = logLines().length;
		const len = await steer(instruction);
		await page.waitForTimeout(300);
		const reqs = ours(from);
		turns.push({ n, instruction, reqs });
		console.log(`  .. turn ${n}: ${reqs.length} request(s), ${len} message(s) after`);
	};

	const i1 = `@tools file_write {"path":"diamonds/${dia}/one.md","content":"turn one ${NONCE}"}`;
	await turn(1, i1);
	await write(`diamonds/${dia}/STATE.md`, `# State\n\n${STATE_TWO}\n`);           // a STATE edit
	await turn(2, `@tools file_write {"path":"diamonds/${dia}/two.md","content":"turn two"}`);
	await write(`diamonds/${dia}/notes/three.md`, 'written between turns 2 and 3\n'); // a file write
	await turn(3, '@text turn three noted');
	// Read-heavy: each turn reads a file over 4 kB, so every finished turn leaves a result big
	// enough to retire.  Ten turns stay far below the size line (~80k tokens).
	for (let n = 4; n <= 10; n++) {
		const src = `diamonds/${dia}/src${n}.md`;
		await write(src, BIG('source ' + n));
		await turn(n, `@seq file_read {"path":"${src}"} ;; file_write {"path":"diamonds/${dia}/out${n}.md","content":"summary ${n}"}`);
	}

	const all = turns.flatMap((t) => t.reqs.map((r) => ({ n: t.n, msgs: r.messages })));
	// Turns 1 and 2 call a tool, so each sends two requests: the prefix is then proved within a
	// turn as well as across one. One request means the mock read the directive as prose.
	check('1. every turn reached the mock, the tool turns in two rounds',
		turns.every((t) => t.reqs.length >= (t.n !== 3 ? 2 : 1)),
		turns.map((t) => t.reqs.length).join('/') + ' requests; ' + all.length + ' in all');

	// ── 1. ONE SYSTEM MESSAGE ─────────────────────────────────────────────
	const sys = all.map((r) => (r.msgs[0] && r.msgs[0].role === 'system') ? textOf(r.msgs[0]) : '');
	const sysOdd = sys.findIndex((x) => x !== sys[0]);
	check('2. the system message is byte-identical in every request', all.length > 1 && sysOdd < 0,
		sysOdd < 0 ? `${sys[0].length} chars × ${sys.length}`
			: `request ${sysOdd} (turn ${all[sysOdd].n}) differs at char ${firstDiff(sys[0], sys[sysOdd])}`);

	// ── 2. EACH BODY A PREFIX OF THE NEXT ─────────────────────────────────
	// Retirement breaks are counted apart from defect breaks: past the size line one retirement
	// is the ruling working, below it any is the fault D-20261020-11 removed.
	let broke = null;
	const retired = [];
	for (let i = 0; i + 1 < all.length; i++) {
		const k = breakOf(all[i].msgs, all[i + 1].msgs);
		if (!k) continue;
		const where = `request ${i}→${i + 1} (turn ${all[i].n}→${all[i + 1].n}) message ${k.at}`;
		if (k.kind === 'retire') { retired.push(where); continue; }
		if (!broke) {
			const a = ser(all[i].msgs).slice(0, -1), b = ser(all[i + 1].msgs), at = firstDiff(a, b);
			broke = `${where} parts at byte ${at}: ` + JSON.stringify(a.slice(Math.max(0, at - 40), at + 40));
		}
	}
	check('3. each request\'s messages are a byte-prefix of the next\'s, but for retirement (defect breaks 0)',
		all.length > 1 && !broke, broke || `${all.length - 1} pairs`);
	const reads = (all[all.length - 1]?.msgs || []).filter((m) => m.role === 'tool' && textOf(m).length > 4096).length;
	const most = Math.max(...all.map((r) => ser(r.msgs).length));
	check('3r. below the size line no result retires across ten turns, seven of them read-heavy (retirement breaks 0)',
		turns.length === 10 && reads > 0 && retired.length === 0,
		retired.length ? `${retired.length}: ${retired.slice(0, 2).join('; ')}`
			: `${reads} results over 4 kB sent whole; largest request ${most} chars ≈ ${Math.round(most / 4)} tokens`);

	// ── 3. THE NOTE SAYS ONLY WHAT CHANGED ────────────────────────────────
	const pre = (t) => { const u = lastUser(t.reqs[0]?.messages || []); const k = u.indexOf(t.instruction); return k < 0 ? u : u.slice(0, k); };
	const note1 = pre(turns[0]), note2 = pre(turns[1]);
	check('4. turn 1\'s note carries the standing blocks', /<state>/.test(note1) && note1.includes('STATE-ONE'),
		`${note1.length} chars ≈ ${Math.round(note1.length / 4)} tokens`);
	check('5. turn 2\'s note restates <state> with the edit, and not <crystal>',
		note2.includes(STATE_TWO) && !/<crystal>/.test(note2),
		`${note2.length} chars; tags ${(note2.match(/<([a-z]+)>/g) || []).join(' ')}`);

	// ── 3b. THE TREE AND THE ACTIVITY GO AS CHANGES (r578c, D-20261020-03) ──
	// Turn 1 sends the tree whole; turn 3, after a file write between the turns, sends only the
	// tree's changes, said as a change list, and never the tree's own heading again.
	const note3 = pre(turns[2]);
	const blockOf = (note, tag) => { const m = note.match(new RegExp('(^|\\n)<' + tag + '>\\n([\\s\\S]*?)\\n</' + tag + '>')); return m ? m[2] : null; };
	const tree1 = blockOf(note1, 'tree'), tree3 = blockOf(note3, 'tree');
	check('5b. turn 1 sends the tree whole', !!tree1 && tree1.includes('## Where you are'),
		tree1 ? `${tree1.length} chars` : 'no <tree> in turn 1');
	check('5c. turn 3, after a file write, sends the tree as a change list, not whole',
		!!tree3 && /change list/.test(tree3.split('\n')[0]) && !tree3.includes('## Where you are')
			&& /^[+~-] diamonds\//m.test(tree3),
		tree3 ? `${tree3.length} chars vs ${tree1 ? tree1.length : 0} whole: ${JSON.stringify(tree3.slice(0, 160))}`
			: 'no <tree> in turn 3');

	// ── 4. NOTHING THAT CHANGES IS IN THE SYSTEM MESSAGE ──────────────────
	const leak = ['Current crystal.json', 'STATE-ONE', STATE_TWO, 'O1 Keep the prefix', 'Recently changed']
		.filter((x) => sys.some((y) => y.includes(x)));
	check('6. no system message carries the crystal, STATE, REQUIREMENTS or "Recently changed"',
		leak.length === 0, leak.join(', ') || 'clean');

	const errs = errors(s).filter((e) => !/502|Bad Gateway|account/i.test(e));
	check('7. no unexpected console errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
	console.log(`\nturn-1 note: ${note1.length} chars ≈ ${Math.round(note1.length / 4)} tokens (mock log from line ${mark})`);
} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
} finally {
	await s.close?.().catch(() => {});
}

guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
