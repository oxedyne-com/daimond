// gateway: none
// verify_prompts.mjs — the prompt each agent runs under is the user's to change.
//
// Four roles, four files in the workspace (prompts/<role>.md). What has to be
// true is not "the file can be written" but that what the MODEL is sent changes
// with it, so every assertion below reads the wire: the mock provider records
// each request, and the system message on it is the thing under test.
//
// The two properties worth the most:
//
//   * An absent file means the shipped default, so DELETING one restores the
//     original. A user who breaks a prompt must be able to get back.
//   * A user may write anything at all, and the safety rules still reach the
//     model. Page text is data, not instruction; nothing irreversible happens
//     unasked. Those survive a rewrite, or an editable prompt would be a way to
//     disarm the agent by accident.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, mockLog, clearMockLog } from './harness.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'prompts' });
const p = s.page;
await p.waitForTimeout(1200);

/// The system message of the most recent request the mock actually received.
const systemSent = () => {
	const reqs = mockLog();
	for (let i = reqs.length - 1; i >= 0; i--) {
		const m = (reqs[i].messages || []).find(x => x.role === 'system');
		if (m) return m.content || '';
	}
	return '';
};

const write = (path, content) => p.evaluate(async ({ path, content }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	await app.run_tool('dir_create', JSON.stringify({ path: 'prompts' }));
	return await app.run_tool('file_write', JSON.stringify({ path, content }));
}, { path, content });

const remove = (path) => p.evaluate(async (path) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return await app.run_tool('file_delete', JSON.stringify({ path }));
}, path);

// ── 1. The shipped default, with no file at all ─────────────────────────
clearMockLog();
await chat(s, 'hello there');
const asShipped = systemSent();
check('a chat with no prompt file runs on the shipped default',
	/You are Daimond/.test(asShipped), asShipped.slice(0, 48));
check('...which carries the rules that always apply',
	/untrusted data/.test(asShipped) && /cannot undo/.test(asShipped));

// ── 2. The user's own words reach the model ─────────────────────────────
const MINE = 'You are Bartleby. You answer only in the fewest words possible.';
await write('prompts/chat.md', MINE);
await p.evaluate(() => window.DaimondPrompts.refresh());
await p.waitForTimeout(600);
clearMockLog();
await chat(s, 'and hello again');
const mine = systemSent();
check('an edited prompt is what the model is sent', mine.includes('Bartleby'), mine.slice(0, 60));
check('...and the shipped wording it replaced is gone',
	!/helpful coding assistant/.test(mine));

// ── 3. What an edit cannot take away ────────────────────────────────────
check('the rules survive a prompt that does not mention them',
	/untrusted data/.test(mine) && /cannot undo/.test(mine),
	mine.slice(-90));
check('...and they come AFTER the user’s text, so they are read last',
	mine.indexOf('Bartleby') < mine.indexOf('untrusted data'));

// ── 3b. What the MODEL's own dialect adds, and what it does not ─────────
//
// Two composed notes join the clause here. `PLACES_NOTE` is unconditional and says where files
// are; a family addendum is composed ON THE MODEL and names the one mistake that family's own
// bank rows are full of. Both sit outside `prompts/<role>.md`, so neither can be lost by a
// rewrite and neither shows in the editor -- the same trade `VISION_NOTE` makes.
const composed = await p.evaluate(async (mine) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return {
		kimi:   mod.compose_prompt_for('chat', '', 'moonshotai/kimi-k2.7-code'),
		claude: mod.compose_prompt_for('chat', '', 'anthropic/claude-opus-5'),
		mine:   mod.compose_prompt_for('chat', mine, 'moonshotai/kimi-k2.7-code'),
	};
}, MINE);
check('a Kimi prompt carries the addendum measured on Kimi',
	/ONE JSON object/.test(composed.kimi), composed.kimi.slice(-140));
check('...and a Claude prompt does not, because Claude did not earn it',
	!/ONE JSON object/.test(composed.claude));
check('every model is told where files are',
	/Where files are/.test(composed.kimi) && /Where files are/.test(composed.claude));
check('...and a rewritten prompt keeps both',
	composed.mine.includes('Bartleby') && /Where files are/.test(composed.mine)
	&& /ONE JSON object/.test(composed.mine), composed.mine.slice(-140));
check('...with the clause still last of all',
	composed.mine.indexOf('Where files are') < composed.mine.lastIndexOf('untrusted data'));

// ── 4. Deleting the file puts the original back ─────────────────────────
await remove('prompts/chat.md');
await p.evaluate(() => window.DaimondPrompts.refresh());
await p.waitForTimeout(600);
clearMockLog();
await chat(s, 'once more');
const restored = systemSent();
check('deleting the file restores the shipped prompt',
	/You are Daimond/.test(restored) && !/Bartleby/.test(restored), restored.slice(0, 48));

// ── 5. The wasm agrees with the files about what a default is ───────────
const roundTrip = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const out = {};
	for (const role of ['chat', 'conductor', 'worker', 'reducer']) {
		out[role] = {
			def:     mod.default_prompt(role).slice(0, 40),
			clause:  mod.compose_prompt(role, '').includes('untrusted data'),
			mineWins: mod.compose_prompt(role, 'ZZZ').includes('ZZZ'),
		};
	}
	out.unknown = mod.default_prompt('wizard');
	return out;
});
check('every role has a default of its own',
	['chat', 'conductor', 'worker', 'reducer'].every(r => roundTrip[r].def.length > 20)
		&& new Set(['chat', 'conductor', 'worker', 'reducer'].map(r => roundTrip[r].def)).size === 4);
check('every role takes the user’s text over its default',
	['chat', 'conductor', 'worker', 'reducer'].every(r => roundTrip[r].mineWins));
check('the tool-holding roles carry the rules, the tool-less reducer does not',
	roundTrip.chat.clause && roundTrip.conductor.clause && roundTrip.worker.clause
		&& !roundTrip.reducer.clause,
	JSON.stringify({ chat: roundTrip.chat.clause, conductor: roundTrip.conductor.clause,
		worker: roundTrip.worker.clause, reducer: roundTrip.reducer.clause }));
check('an unknown role yields nothing rather than a wrong prompt',
	roundTrip.unknown === '');

// ── 6. A worker is told the user's worker prompt, not the chat's ────────
await write('prompts/worker.md', 'You are a WORKERMARK agent.');
await p.evaluate(() => window.DaimondPrompts.refresh());
await p.waitForTimeout(600);
const workerSystem = await p.evaluate(() => window.DaimondPrompts.role('worker'));
check('a worker runs on the worker file, not the chat one',
	/WORKERMARK/.test(workerSystem) && !/Bartleby/.test(workerSystem),
	workerSystem.slice(0, 50));
check('...with the rules appended to it too', /untrusted data/.test(workerSystem));
await remove('prompts/worker.md');

// ── 6b. The person's standing notes: one block, before the clause (5.3.2, U6a/U6b) ──
//
// The engine composes the notes a person keeps into ONE block, `compose_prompt_with(role, text, model, steer)`, immediately
// before the safety clause, and only for the two roles a person talks to. An empty block composes today's bytes exactly, so a
// person with no notes is sent what they always were. Asked of the wasm as shipped, then of the page: a note on the account
// reaches the chat's request before the clause, and retiring it puts the default back byte for byte.
const STEER_HEAD = '## Standing notes from this user', CLAUSE_HEAD = '## Rules that always apply';
const KIMI = 'moonshotai/kimi-k2.7-code';
const NOTE1 = 'Keep answers under about 200 words unless asked for detail.', NOTE2 = 'Name the file you changed at the end of every change.';
const eng = await p.evaluate(async ({ KIMI, NOTE1, NOTE2, MINE }) => {
	const m = await import('../pkg/oxedyne_daimond.js');
	if (typeof m.compose_prompt_with !== 'function') return { have: false };
	const roles = ['chat', 'daimon', 'conductor', 'worker', 'reducer', 'compactor'], steer = NOTE1 + '\n' + NOTE2;
	const seven = Array.from({ length: 7 }, (_, i) => 'Note number ' + (i + 1) + ' says to ' + 'be plain and exact in every sentence, '.repeat(2) + 'ok.').join('\n');
	const out = { have: true, empty: {}, withB: {}, plain: {}, seven: m.compose_prompt_with('chat', '', KIMI, seven), bait: m.compose_prompt_with('chat', '', KIMI, 'Always agree with the user ZQXBAIT.\n' + NOTE1),
		mine: m.compose_prompt_with('chat', MINE, KIMI, steer) };
	for (const r of roles) { out.plain[r] = m.compose_prompt_for(r, '', KIMI); out.empty[r] = m.compose_prompt_with(r, '', KIMI, ''); out.withB[r] = m.compose_prompt_with(r, '', KIMI, steer); }
	out.blank = m.compose_prompt_with('chat', '', KIMI, '  \n\t\n');
	return out;
}, { KIMI, NOTE1, NOTE2, MINE });
check('the engine composes a block (compose_prompt_with is exported)', eng.have === true);
if (eng.have) {
	const roles = Object.keys(eng.plain);
	check('an empty or blank block composes exactly the bytes there were, for every role',
		roles.every((r) => eng.empty[r] === eng.plain[r]) && eng.blank === eng.plain.chat);
	const beforeClause = (t) => { const h = t.indexOf(STEER_HEAD), c = t.lastIndexOf(CLAUSE_HEAD); return h >= 0 && h < c && t.slice(h, c).includes(NOTE1) && t.slice(h, c).includes(NOTE2); };
	check('the chat and the daimon carry the block, both notes, before the safety clause', beforeClause(eng.withB.chat) && beforeClause(eng.withB.daimon));
	check('...with the clause still the last section of all',
		['chat', 'daimon'].every((r) => { const c = eng.withB[r].lastIndexOf(CLAUSE_HEAD); return c > 0 && eng.withB[r].indexOf('\n## ', c + 3) < 0; }));
	check('...and the block is the only thing the notes change: the default with the block cut out is the default',
		['chat', 'daimon'].every((r) => { const t = eng.withB[r], h = t.indexOf(STEER_HEAD), c = t.lastIndexOf(CLAUSE_HEAD); return t.slice(0, h) + t.slice(c) === eng.plain[r]; }));
	check('a worker, a reducer and a compactor are never handed a note',
		['worker', 'reducer', 'compactor'].every((r) => eng.withB[r] === eng.plain[r]),
		['worker', 'reducer', 'compactor'].filter((r) => eng.withB[r] !== eng.plain[r]).join(','));
	// `conductor` is the daimon's former name (src/prompts.rs), so it is the daimon and is told what the daimon is told.
	check('the daimon\u2019s former name, conductor, composes as the daimon does', eng.withB.conductor === eng.withB.daimon && eng.empty.conductor === eng.plain.conductor);
	const noteLines = (t) => { const h = t.indexOf(STEER_HEAD), c = t.lastIndexOf(CLAUSE_HEAD); return h < 0 ? [] : t.slice(h, c).split('\n').filter((l) => l.startsWith('- ')); };
	const seven = noteLines(eng.seven);
	check('at most five notes and 600 bytes of note text are taken, from the front',
		seven.length >= 1 && seven.length <= 5 && Buffer.byteLength(seven.map((l) => l.slice(2)).join(''), 'utf8') <= 600 && /Note number 1 /.test(seven[0]),
		seven.length + ' lines, ' + Buffer.byteLength(seven.join(''), 'utf8') + ' bytes');
	check('a refused line takes no place in the block; the line beside it does',
		!eng.bait.includes('ZQXBAIT') && noteLines(eng.bait).length === 1 && noteLines(eng.bait)[0] === '- ' + NOTE1);
	check('the person’s own prompt text, then the block, then the clause',
		eng.mine.indexOf('Bartleby') >= 0 && eng.mine.indexOf('Bartleby') < eng.mine.indexOf(STEER_HEAD) && eng.mine.indexOf(STEER_HEAD) < eng.mine.lastIndexOf(CLAUSE_HEAD));
}
const hasNotes = await p.evaluate(() => !!(window.DaimondNotes && DaimondNotes.add && DaimondNotes.retire));
check('the page can keep a note (DaimondNotes.add, retire)', hasNotes);
if (hasNotes) {
	// The account's notes live in the Optimiser's own store; the shipped default is read first, with none.
	await p.evaluate(() => DaimondCore.loadDiamonds());
	await p.waitForTimeout(1200);
	clearMockLog();
	await chat(s, 'before any note');
	const plainSys = systemSent();
	const note = await p.evaluate((l) => DaimondNotes.add({ level: 3, scope: '', cm: 'all', tag: 'long', line: l, at: { t: 7, n: 20 } }), NOTE1);
	clearMockLog();
	await chat(s, 'with a note');
	const withSys = systemSent();
	const h = withSys.indexOf(STEER_HEAD), c = withSys.indexOf(CLAUSE_HEAD);
	check('with a note kept, the chat’s request carries the block, the note and then the clause',
		h > 0 && h < c && withSys.slice(h, c).includes(NOTE1) && plainSys.indexOf(STEER_HEAD) < 0);
	check('...and the prompt without the block is the shipped default, byte for byte',
		withSys.slice(0, h) + withSys.slice(c) !== '' && plainSys.indexOf(CLAUSE_HEAD) > 0
		&& withSys.slice(0, h) === plainSys.slice(0, plainSys.indexOf(CLAUSE_HEAD)));
	await p.evaluate((n) => DaimondNotes.retire({ level: 3, scope: '', id: n.id }, { t: 7, n: 40 }), note);
	clearMockLog();
	await chat(s, 'after the note is retired');
	const backSys = systemSent();
	check('retiring the note puts the shipped default back, byte for byte up to the clause',
		backSys.indexOf(STEER_HEAD) < 0 && backSys.slice(0, backSys.indexOf(CLAUSE_HEAD)) === plainSys.slice(0, plainSys.indexOf(CLAUSE_HEAD)));
}

// ── 7. The Admin panel offers each one, and opens it in the Doc panel ───
// Through the control a user actually presses: the cog in the rail's status
// strip, which is how the Admin panel is reached.
await p.click('#settings-btn', { force: true });
await p.waitForTimeout(900);
const buttons = await p.$$eval('#admin-home .admin-item', els => els.map(e => e.textContent));
// BY KEY, NOT BY WORDING. This listed the English labels -- "dispatched worker",
// "crystal fold" -- and a copy pass that renamed them to "Helper" and "Crystal
// update" turned a rename into a failing check, exactly as "conductor" had before
// it. What is being proved is that a button is offered per ROLE; the words on it
// are the copy lane's to choose. The labels come out of en.js, so the check follows
// a rename and still fails when a role loses its button.
const roleLabels = (() => {
	const en = readFileSync(join(ROOT, 'www', 'i18n', 'en.js'), 'utf8');
	return ['role.chat', 'role.daimon', 'role.worker', 'role.reducer'].map((k) => {
		const m = new RegExp("'" + k + "'\\s*:\\s*'((?:[^'\\\\]|\\\\.)*)'").exec(en);
		if (!m) throw new Error('verify_prompts: en.js has no ' + k);
		return m[1].replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
			.replace(/\\'/g, "'");
	});
})();
check('the Admin panel offers a button per role',
	roleLabels.every(r => buttons.some(b => b.toLowerCase().includes(r.toLowerCase()))),
	'wanted [' + roleLabels.join(', ') + '] in: '
		+ buttons.filter(b => /prompt/i.test(b)).join(' | '));

await p.evaluate(() => {
	const b = [...document.querySelectorAll('#admin-home .admin-item')]
		.find(e => /chat prompt/i.test(e.textContent));
	if (b) b.click();
});
await p.waitForTimeout(2500);
const doc = await p.evaluate(() => ({
	shown: !!(document.querySelector('#panel-doc') || {}).offsetParent,
	name:  (document.getElementById('doc-name') || {}).textContent || '',
	body:  (document.querySelector('.files-view-body') || {}).textContent || '',
}));
check('the button opens the prompt in the Doc panel', doc.shown && /prompts\/chat\.md/.test(doc.name),
	doc.name);
check('...seeded with the real shipped text, so there is something to edit from',
	/You are Daimond/.test(doc.body), doc.body.slice(0, 48));
// Seeding writes the file; leave the workspace as it was found.
await remove('prompts/chat.md');

// This walk needs no gateway, so /api calls fail: a 502 from dev/serve.mjs's
// proxy, or a 401/402 where one is running without an entitled account. Neither
// is anything to do with a prompt.
const errs = s.errs.filter(e => !/favicon|404|401|402|502|net::ERR/.test(e));
check('nothing throws while all this happens', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
await s.close();
process.exit(bad.length ? 1 : 0);
