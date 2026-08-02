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
import { open, chat, mockLog, clearMockLog } from './harness.mjs';

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

// ── 7. The Admin panel offers each one, and opens it in the Doc panel ───
// Through the control a user actually presses: the cog in the rail's status
// strip, which is how the Admin panel is reached.
await p.click('#settings-btn', { force: true });
await p.waitForTimeout(900);
const buttons = await p.$$eval('#admin-home .admin-item', els => els.map(e => e.textContent));
check('the Admin panel offers a button per role',
	// "daimon", not "conductor": the agent behind a Diamond was renamed and this
	// list was not, so the check went on looking for a word the app stopped using.
	['chat', 'diamond daimon', 'dispatched worker', 'crystal fold']
		.every(r => buttons.some(b => b.toLowerCase().includes(r))),
	buttons.filter(b => /prompt/i.test(b)).join(' | '));

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
