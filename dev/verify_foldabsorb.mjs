// verify_foldabsorb.mjs — a fold writes into the three files, and a fold that would
// delete them is refused.
//
// WHAT THIS IS WRITTEN FROM. A Diamond's memory was the CONVERSATION: ~90,000 tokens of
// transcript re-sent every round beside a crystal of half a kilobyte. A context fold
// replaces everything before the cut with one note, the next fold re-summarises that note,
// and what a decision said decays a generation at a time until nothing can recover it. The
// design of 2026-09-15 §4 answers that by writing what a fold is about to forget into three
// files that are not in the conversation at all -- `REQUIREMENTS.md`, `DECISIONS.md` and
// `STATE.md`, which ride in the prompt on every round and survive the session being cleared.
//
// That is one claim with four halves, and any three can pass while the fourth is a lie:
//
//   A. THE CONTEXT FOLD FILES ITS NOTES. Decisions appended dated, open threads under
//      `## Unfiled`, the next step overwriting `STATE.md`'s, the values found under its
//      `## Facts` -- and the notice then SHRINKS to the task, the next step, the ledger and
//      one sentence saying where the rest went. A notice that kept them as well would pay
//      for them twice a round.
//   B. AND IT IS TOTAL. Running it again files nothing twice, and a task that has already
//      retired into `.daimond/` is not resurrected under `## Unfiled` as new work. See
//      memory `reference_ore_fold_must_be_total`: the files must be a function of the notes,
//      not of how many times a fold ran.
//   C. THE CRYSTAL FOLD RETURNS THE FILES TOO. The reducer is shown all four and answers
//      with the crystal plus heading-delimited blocks; a block that arrived EMPTY leaves its
//      file exactly as it was, because a fold never empties a file.
//   D. AND A PROPOSAL THAT DELETES THE RECORD IS REFUSED. A ticked task, a line of the
//      append-only decisions, a populated crystal key, every hot flag: the fold is re-run
//      once with the loss named and then refused, and nothing is written by either round.
//      `crystal_keys_lost` and `hot_flags_lost` had NO CALLER between one-click commit and
//      this change -- which is exactly when a console warning stopped being read.
//
// EACH PROVED AGAINST THE WORLD IT IS AGAINST:
//
//   node dev/verify_foldabsorb.mjs --break noabsorb      # the compactor answers in prose, so
//                                                        # nothing is parsed and nothing is
//                                                        # filed: A goes red, C and D green.
//   node dev/verify_foldabsorb.mjs --break twiceabsorbs  # the archive is deleted after the
//                                                        # first fold retires into it, so the
//                                                        # dedupe has nothing to compare
//                                                        # against: B goes red, alone.
//   node dev/verify_foldabsorb.mjs --break blockempties  # the reducer answers with three bare
//                                                        # headings: C's "the block reached
//                                                        # the file" goes red, and "the file
//                                                        # was not EMPTIED" stays green.
//   node dev/verify_foldabsorb.mjs --break losssilent    # the reducer never deletes anything,
//                                                        # so there is nothing to refuse: D
//                                                        # goes red, alone.
//   node dev/verify_foldabsorb.mjs                       # and then, clean.
//
// THE BREAKS REMOVE THE EFFECT, NOT THE IMPLEMENTATION, exactly as `dev/verify_reqfiles.mjs`
// does and for the same reason: everything here is the ENGINE's -- `Agent::fold_if_needed`
// files, `compact::fold_proposal` parses, `compact::fold_losses` refuses -- and no rewrite of
// a script the page loads can reach any of it. What is proved is that each assertion
// DISCRIMINATES, going red when the thing it is about did not happen.
//
//   eval "$(bash dev/world.sh 36 --up)" ; eval "$(bash dev/world.sh 36 --env)"
//   node dev/verify_foldabsorb.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, mockLog, clearMockLog, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG  = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');
const FOLD = LOG + '.fold';        // how the compactor answers
const RED  = LOG + '.reduce';      // how the reducer answers

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const BREAKS = ['noabsorb', 'twiceabsorbs', 'blockempties', 'losssilent'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error('no such break: ' + BREAK + '\nhave: ' + BREAKS.join(' '));
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

const REQ = 'REQUIREMENTS.md', DEC = 'DECISIONS.md', ST = 'STATE.md';
const ARCH = '.daimond/decisions-archive.md';

// The compactor's shape, which decides whether there are notes to file at all.
fs.writeFileSync(FOLD, BREAK === 'noabsorb' ? 'garbage' : 'structured');
const reduceAs = (mode) => fs.writeFileSync(RED, mode);
reduceAs('');

const s = await open({ name: 'foldabsorb', signIn: false, connect: false });
const { page } = s;

try {
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777',
		{ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'foldabsorb');
	await connectMock(s);
	await page.waitForTimeout(1500);

	const MOCK = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
	await page.evaluate(async (mock) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		window.__m  = m;
		window.__vf = new m.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
		// The smallest cap the app allows, so a fat prior folds on the first round rather
		// than after forty turns. The app's own floor is CONTEXT_CAP_MIN.
		window.__vf.set_context_cap(16000);
	}, MOCK);

	const read  = (p) => page.evaluate((x) => window.__m.read_file(x).catch(() => ''), p);
	const write = (p, t) => page.evaluate((a) => window.__m.write_file(a.p, a.t), { p, t });
	const of    = (id, leaf) => read(`diamonds/${id}/${leaf}`);

	const make = async (name) => {
		await page.click('#new-diamond-btn', { force: true });
		await page.waitForSelector('.dlg-input', { timeout: 10000 });
		await page.fill('.dlg-input', name);
		await page.click('.dlg-ok', { force: true });
		await page.waitForTimeout(1800);
		return page.evaluate(async (nm) => {
			const d = JSON.parse(await window.__vf.list_diamonds()).find((x) => x.name === nm);
			return d ? d.id : '';
		}, name);
	};

	/// One steering turn with a conversation too big to send, so the turn folds.
	///
	/// The prior is many small messages rather than a few large ones: `tail_start` keeps at
	/// least MIN_KEEP_MESSAGES, so a conversation of a few enormous messages has nothing it
	/// is allowed to cut and falls back to shortening, which is a different behaviour.
	const foldingTurn = (id, msgs) => page.evaluate(async (a) => {
		const prior = [];
		for (let i = 0; i < a.msgs; i++) {
			prior.push({ role: i % 2 ? 'assistant' : 'user',
				content: 'turn ' + i + ' ' + 'padding words that fill a window '.repeat(20) });
			// One real tool call in the folded part, so the LEDGER the app builds from the
			// record has something in it: the ledger is the half of the notice no model is
			// asked for, and a shrunk notice that lost it would be a shrink too far.
			if (i === 4) {
				prior.push({ role: 'assistant', content: '', tool_calls: [{
					id: 'call-1', name: 'file_read',
					arguments: JSON.stringify({ path: 'src/mock.js' }) }] });
				prior.push({ role: 'tool', tool_call_id: 'call-1', content: 'the file' });
			}
		}
		const out = await window.__vf.steer_crystal(a.id, '@text done', '[]', '[]', '[]',
			prior, () => {});
		return Array.from(out || []).map((m) => String(m.content || ''));
	}, { id, msgs });

	const noticeIn = (msgs) =>
		msgs.find((c) => c.startsWith('[Daimond folded the earlier part')) || '';

	const dia = await make('Absorb');
	check('A0. a Diamond to work in', !!dia, dia);

	// A ticked task and a decision already on file, so the absorb and the reducer both have
	// a record in front of them that they may not touch.
	await write(`diamonds/${dia}/${REQ}`,
		'# Requirements\n\n## O1 Ship it\n\n- [x] T1 KEEPER shipped it (v4)\n'
		+ '- [ ] T2 still open\n\n## Unfiled\n\n## Done\n');
	await write(`diamonds/${dia}/${DEC}`,
		'# Decisions\n\nOne dated line each.\n\n- 2026-09-01 STANDING the store is authoritative\n');
	await write(`diamonds/${dia}/${ST}`,
		'# State\n\nWhere things are now.\n\n## Facts\n\n## Next step\n\nnothing yet\n');

	clearMockLog();

	// ── A. THE CONTEXT FOLD FILES ITS NOTES ──────────────────────────
	const first = await foldingTurn(dia, 200);
	const notice = noticeIn(first);
	check('A1. the conversation folded, and the notice reached the turn',
		!!notice, notice.length + ' chars');

	const req1 = await of(dia, REQ), dec1 = await of(dia, DEC), st1 = await of(dia, ST);
	// The mock's own structured fold, whose slots are fixed and echoed by dev/mockllm.mjs.
	check('A2. the fold\'s DECISION is appended to DECISIONS.md, dated',
		/-\s*\d{4}-\d{2}-\d{2}\s+answer in the layout/.test(dec1),
		(dec1.split('\n').filter((l) => l.trim()).pop() || '').slice(0, 90));
	check('A3. the fold\'s OPEN thread is filed under ## Unfiled',
		req1.includes('left unfinished')
		&& req1.indexOf('## Unfiled') < req1.indexOf('left unfinished'),
		(req1.match(/## Unfiled[\s\S]{0,70}/) || ['(no Unfiled)'])[0].replace(/\n/g, ' '));
	check('A4. the fold\'s NEXT STEP overwrote STATE.md\'s',
		st1.includes('Carry on from where the transcript stops') && !st1.includes('nothing yet'),
		(st1.match(/## Next step[\s\S]{0,60}/) || ['(none)'])[0].replace(/\n/g, ' '));
	check('A5. the VALUE the fold found is under STATE.md\'s ## Facts, not lost in prose',
		st1.includes('MOCKCAP=4120')
		&& st1.indexOf('## Facts') < st1.indexOf('MOCKCAP')
		&& st1.indexOf('MOCKCAP') < st1.indexOf('## Next step'),
		(st1.match(/## Facts[\s\S]{0,50}/) || ['(none)'])[0].replace(/\n/g, ' '));
	check('A6. the ticked task and the standing decision were not touched',
		req1.includes('- [x] T1 KEEPER shipped it (v4)') && dec1.includes('STANDING the store'),
		'a fold may add, never remove');
	check('A7. and the NOTICE shrank: the task, the next step, and where the rest went',
		notice.includes('## Task') && notice.includes('## Next step')
		&& notice.includes('were filed into DECISIONS.md and REQUIREMENTS.md'),
		notice.replace(/\n/g, ' / ').slice(0, 140));
	check('A8. the lists left the notice, so they are not paid for twice a round',
		!!notice && !/##\s*Decisions/.test(notice) && !/##\s*Open/.test(notice)
		&& !/##\s*Files edited/.test(notice),
		notice ? notice.length + ' chars' : 'no notice');
	check('A9. and the ledger the app builds is still beneath it',
		notice.includes('## What was touched'), 'the record is the app\'s, not the model\'s');

	// A10. AND THE NOTICE IS STILL SEARCHABLE WHILE THE SESSION HOLDS IT. `recall` reads the
	// folds of a conversation as well as the files, and the shrink must not have cost it
	// that. Reported as `fold:<k>:<n>:`, which is what says the hit came from the NOTICE and
	// not from `STATE.md`, where the same sentence now also lives -- which is the point of
	// E1 below: after a daimon Fold clears the session the notice is gone and the file is not.
	const recallWith = (id, q, prior) => page.evaluate(async (a) => {
		const seen = [];
		await window.__vf.steer_crystal(a.id, '@tool recall {"query":"' + a.q + '"}',
			'[]', '[]', '[]', a.prior.map((c) => ({ role: 'user', content: c })),
			(ev) => seen.push({ type: ev.type, name: ev.name || '', content: ev.content || '' }));
		return (seen.find((e) => e.type === 'tool_result' && e.name === 'recall') || {})
			.content || '';
	}, { id, q, prior });
	const inNotice = await recallWith(dia, 'Carry on from where', [notice]);
	check('A10. recall still reads the notice itself while the session holds it',
		/fold:/.test(inNotice), inNotice.slice(0, 130).replace(/\n/g, ' '));

	// ── B. TWICE IS ONCE ─────────────────────────────────────────────
	//
	// The first fold's ruling is moved into the archive, exactly as the retirement does when
	// the file fills. A second fold must not put it back: a task ticked and retired last
	// month coming back under `## Unfiled` as new work is the never-forget file's opposite
	// failure.
	const ruling = (dec1.match(/^-\s*\d{4}-\d{2}-\d{2}\s+answer in the layout.*$/m) || [''])[0];
	await write(`diamonds/${dia}/${DEC}`, dec1.replace(ruling + '\n', ''));
	await write(`diamonds/${dia}/${ARCH}`, BREAK === 'twiceabsorbs' ? '' : ruling + '\n');
	if (BREAK === 'twiceabsorbs') {
		console.log('  (running with the archive deleted, so nothing remembers what retired)');
	}
	const second = await foldingTurn(dia, 200);
	const req2 = await of(dia, REQ), dec2 = await of(dia, DEC), st2 = await of(dia, ST);
	check('B1. a second identical fold files the same ruling nowhere',
		!dec2.includes('answer in the layout'),
		'live file: ' + dec2.split('\n').filter((l) => l.trim()).length + ' lines');
	check('B2. and files the same open thread nowhere twice',
		(req2.match(/left unfinished/g) || []).length
			=== (req1.match(/left unfinished/g) || []).length,
		(req2.match(/left unfinished/g) || []).length + ' copies');
	check('B3. and the same value nowhere twice',
		(st2.match(/MOCKCAP=4120/g) || []).length === (st1.match(/MOCKCAP=4120/g) || []).length,
		(st2.match(/MOCKCAP=4120/g) || []).length + ' copies');
	check('B4. the second fold still folded, so B1-B3 are not measuring a turn that did nothing',
		!!noticeIn(second), noticeIn(second).length + ' chars');

	// ── C. THE CRYSTAL FOLD RETURNS THE FILES TOO ────────────────────
	const reqBefore = await of(dia, REQ);
	reduceAs(BREAK === 'blockempties' ? 'empty' : 'blocks');
	clearMockLog();
	const propose = (id, delta) => page.evaluate(async (a) => {
		try { return { ok: await window.__vf.fold_propose(a.id, a.delta) }; }
		catch (e) { return { err: String((e && e.message) || e).replace(/\x1b\[[0-9;]*m/g, '') }; }
	}, { id, delta });
	const apply = (id, prop) => page.evaluate(async (a) =>
		window.__vf.fold_apply(a.id, a.prop, 'the delta', 'fold via verifier'),
		{ id, prop });

	const p1 = await propose(dia, 'MOCKDELTA the thing that was settled');
	check('C1. the reducer proposed a fold', !!p1.ok, p1.err || (p1.ok || '').slice(0, 60));
	let env = {};
	try { env = JSON.parse(p1.ok || '{}'); } catch (e) { /* named by C2 */ }
	check('C2. and the answer is an envelope carrying the crystal',
		typeof env.crystal === 'string' && env.crystal.includes('{'),
		Object.keys(env).join(','));
	check('C3. the reducer was SHOWN the three files, or it cannot rewrite them',
		mockLog().some((r) => (r.messages || []).some((m) => m.role === 'user'
			&& /Current REQUIREMENTS\.md:/.test(String(m.content || ''))
			&& /Current DECISIONS\.md:/.test(String(m.content || '')))),
		mockLog().length + ' requests');
	if (p1.ok) await apply(dia, p1.ok);
	const reqC = await of(dia, REQ);
	check('C4. the reducer\'s REQUIREMENTS.md block reached the file',
		reqC.includes('MOCKTASK'), (reqC.match(/MOCKTASK.{0,40}/) || ['(no block)'])[0]);
	check('C5. an EMPTY block leaves the file exactly as it was, never emptied',
		reqC.trim().length > 0 && reqC.includes('- [x] T1 KEEPER shipped it (v4)'),
		reqC.length + ' bytes, ticked line intact');
	const stC = await of(dia, ST);
	check('C6. a file the reducer rewrote whole is written whole',
		BREAK === 'blockempties' ? stC.length > 0 : stC.includes('MOCKNEXT'),
		(stC.match(/## Next step[\s\S]{0,40}/) || ['(none)'])[0].replace(/\n/g, ' '));

	// ── D. A PROPOSAL THAT DELETES THE RECORD IS REFUSED ─────────────
	const reqD = await of(dia, REQ), decD = await of(dia, DEC);
	reduceAs(BREAK === 'losssilent' ? 'blocks' : 'untick');
	if (BREAK === 'losssilent') {
		console.log('  (running with a reducer that deletes nothing, so there is nothing to refuse)');
	}
	clearMockLog();
	const p2 = await propose(dia, 'MOCKDELTA2 a delta that costs the record');
	check('D1. a proposal that deletes a TICKED task is refused, not committed',
		!!p2.err, p2.err ? p2.err.slice(0, 110) : 'accepted: ' + (p2.ok || '').slice(0, 60));
	check('D2. and the refusal names what would have gone',
		!!p2.err && /KEEPER/.test(p2.err), (p2.err || '').slice(0, 400));
	check('D3. the fold was re-run ONCE with the loss named before it was refused',
		mockLog().filter((r) => (r.messages || []).some((m) => m.role === 'system'
			&& /What a crystal is/.test(String(m.content || '')))).length === 2,
		mockLog().filter((r) => (r.messages || []).some((m) => m.role === 'system'
			&& /What a crystal is/.test(String(m.content || '')))).length + ' reducer rounds');
	check('D4. and the second round was TOLD what it dropped',
		mockLog().some((r) => (r.messages || []).some((m) => m.role === 'user'
			&& /DELETED things that must be carried through/.test(String(m.content || '')))),
		'the loss is in the prompt, not only in the console');
	check('D5. and nothing was written by either round',
		(await of(dia, REQ)) === reqD && (await of(dia, DEC)) === decD,
		'the files are byte for byte what they were');

	// ── RECALL REACHES WHAT THE SESSION NO LONGER HOLDS ──────────────
	//
	// The half the fold notices cannot answer: a daimon Fold CLEARS the session, so what a
	// context fold wrote into a notice is gone and what it wrote into the files is not.
	const steer = (id, instruction) => page.evaluate(async (a) => {
		const seen = [];
		await window.__vf.steer_crystal(a.id, a.instruction, '[]', '[]', '[]', [],
			(ev) => seen.push({ type: ev.type, name: ev.name || '', content: ev.content || '' }));
		return seen;
	}, { id, instruction });
	const resultOf = (seen, name) => (seen.find((e) => e.type === 'tool_result'
		&& (!name || e.name === name)) || {}).content || '';
	reduceAs('');
	const found = resultOf(await steer(dia, '@tool recall {"query":"MOCKCAP"}'), 'recall');
	check('E1. recall finds the fold\'s value through the FILES, with no session at all',
		found.includes('MOCKCAP') && found.includes(ST),
		found.slice(0, 120).replace(/\n/g, ' '));
	const arch = resultOf(await steer(dia, '@tool recall {"query":"answer in the layout"}'),
		'recall');
	check('E2. and a ruling that has retired into .daimond, which is in no prompt anywhere',
		BREAK === 'twiceabsorbs' ? true : arch.includes('decisions-archive.md'),
		arch.slice(0, 120).replace(/\n/g, ' '));

	const errs = errors(s).filter((e) => !/502|Bad Gateway|account/i.test(e));
	check('F1. no unexpected console errors', errs.length === 0,
		errs.slice(0, 2).join(' | ') || 'clean');
} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
} finally {
	try { fs.unlinkSync(FOLD); } catch { /* the next run writes it again */ }
	try { fs.unlinkSync(RED); } catch { /* ditto */ }
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
