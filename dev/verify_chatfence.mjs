// verify_chatfence.mjs — a chat's worker reads freely, writes where it was told,
// and runs commands only where the user deliberately put something.
//
// The fence is on the VERB and not on the surface, and since 2026-08-13 that is
// the rule everywhere — a chat, a chat's worker, and a Diamond's daimon alike:
//
//   * READING IS FREE. "Summarise these ten files" must not require attaching
//     ten files first. A worker reading what the chat could already read is
//     equal reach, not greater — a person asked the question either way.
//   * WRITING GOES WHERE THE USER MARKED: the chat's own working folder, and
//     whatever they marked into its workspace.
//   * A COMMAND COUNTS AS A WRITE, because there is no way to look at an argv
//     and say whether it alters anything. No attachment, no command.
//   * AND A COMMAND'S READING IS NOT SPLIT OUT EITHER. The same sentence that
//     makes a command a write makes it opaque: it can read a million files,
//     follow a symlink out, and hold the network on a clean turn. So its fence
//     names the marked folders for both verbs, the granted root appears in
//     NEITHER list, and this file asserts that — the compartment
//     `dev/verify_scope.mjs` proves through the kernel depends on it.
//
// "No attachment, no command" is not enforced by a rule of its own: a chat's
// scratch lives under `chats/`, which `is_store_path` answers for, so
// `fence_spec` cannot map it onto the machine and `default_cwd` skips it. The
// refusal falls out of where the folder lives, which is why it cannot drift from
// the rule it implements.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST.
//
//   node dev/verify_chatfence.mjs --break markall     # 1 fails: writing widens
//   node dev/verify_chatfence.mjs --break writeopen   # 2 fails: nothing in scope
//   node dev/verify_chatfence.mjs --break noscratch   # 3 fails: no working folder
//   node dev/verify_chatfence.mjs                     # and then, clean
//
// The breaks are applied to the SCOPE THE PAGE ASKS FOR, not to the engine: the
// engine is the thing under test, and a break that damaged it would prove only
// that a damaged engine misbehaves. Each one is a plausible caller mistake.
//
// THERE IS NO CALLER BREAK FOR THE READ CHECKS, and that is worth saying rather
// than leaving as a gap: no argument to `set_chat_scope` can fence a read any
// more, because the scope it builds declares no read fence at all. That property
// is proved red at the engine instead — `cargo test --lib tools::` with
// `diamond_bounds` emitting `Bound::OnlyUnder`, which is the 2026-08-12
// regression put back, turns sixteen unit tests red including the reads below.
import { open } from './harness.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'chatfence', signIn: true, connect: false });
const { page } = s;
await page.waitForFunction(() => !!window.DaimondCore, null, { timeout: 15000 }).catch(() => {});

try {
	// A HAND HAS TO BE PAIRED, or `run` refuses at the first gate — "no machine hand
	// paired with this browser" — and never reaches the rule under test. That is a
	// refusal for the wrong reason, and a check that reads it as the right one is a
	// false green: it would pass with the whole fence deleted.
	//
	// Only the RELAY is stubbed, and it reports a real root and a real fence
	// capability, so everything the rule depends on — `Machine::from_status`,
	// `fence_enforced`, `default_cwd`, `fence_spec` — is the shipped code. What it
	// records is what a command would have been ALLOWED to do, which is how "no
	// attachment, no command" is asserted at the hand rather than at the model's
	// reply.
	await page.evaluate(() => {
		window.__hand = { runs: [] };
		window.DaimondHand = {
			status: async () => ({
				paired: true, os: 'linux (stub)', root: '/home/tester/granted',
				home: '/home/tester', caps: ['fence:linux'],
			}),
			run: async (specJson) => {
				const spec = JSON.parse(specJson);
				window.__hand.runs.push(spec);
				return { exit_code: 0, stdout: 'stub ran ' + (spec.argv || []).join(' '), stderr: '' };
			},
		};
	});

	// Lay down two files the worker never had attached, and one folder it did.
	// Written through an UNSCOPED app, which is what the user's own chat is.
	await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: 'elsewhere/notes.md', content: 'the user own note\n' }));
		await app.run_tool('file_write', JSON.stringify({ path: 'papers/spec.md', content: 'attached spec\n' }));
		window.__seed = true;
	});

	/// A chat's worker, scoped exactly as `scopeChatTo` scopes one.
	const worker = async (attached, brk) => await page.evaluate(async ({ attached, brk }) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		app.set_unsupervised();
		let scratch = 'chats/c-test/work';
		let list = attached.slice();
		// The breaks, each a caller mistake rather than a damaged engine.
		if (brk === 'markall') {
			// The mistake ATTACH_CONTRACT §6 is about: reading the paperclip's whole
			// list as a permission list, so a path attached only to be QUOTED is
			// marked into the workspace and becomes writable. Now that reading is
			// free this is a pure widening of the write fence, which is exactly the
			// direction that must never go unnoticed.
			list = list.concat(['elsewhere']);
		}
		if (brk === 'writeopen') scratch = '';      // no working folder named…
		if (brk === 'writeopen') list = [];         // …and nothing attached either
		if (brk === 'noscratch') scratch = '';
		app.set_chat_scope(scratch, JSON.stringify(list));
		window.__app = app;
		return JSON.parse(app.diamond_scope() || '{}');
	}, { attached, brk });

	const tool = (name, args) => page.evaluate(
		({ name, args }) => window.__app.run_tool(name, JSON.stringify(args)).then(String),
		{ name, args });

	// ── With nothing attached ──
	const bare = await worker([], BREAK);
	check('a chat worker declares a write fence and no read fence',
		Array.isArray(bare.write_allow) && bare.write_allow.length > 0
			&& (bare.allow || []).length === 0,
		JSON.stringify(bare));

	// THE DECISION A REVIEWER STOPS AT, asserted rather than implied: this worker
	// was marked UNSUPERVISED above (`app.set_unsupervised()`, the same call
	// `markAlone` makes in daimond.js), and it reads freely all the same. The
	// answer to the fear underneath the question is the network, not the fence —
	// an unattended actor loses it on a clean turn as much as a dirty one, which
	// the fence check below asserts, so a worker that reads widely cannot post
	// what it read.
	const alone = await page.evaluate(() => window.__app.is_unsupervised());
	check('the worker under test is genuinely unattended, or the reads below prove nothing',
		alone === true, String(alone));

	const readFar = await tool('file_read', { path: 'elsewhere/notes.md' });
	check('reading is free, even for an unattended worker: a file nobody attached is readable',
		/the user own note/.test(readFar), readFar.slice(0, 90));

	const writeFar = await tool('file_write', { path: 'elsewhere/notes.md', content: 'clobbered\n' });
	check('writing is not: the same file cannot be written',
		/Refused/.test(writeFar), writeFar.slice(0, 90));

	const stillThere = await tool('file_read', { path: 'elsewhere/notes.md' });
	check('and the refusal is real — the file is untouched',
		/the user own note/.test(stillThere) && !/clobbered/.test(stillThere),
		stillThere.slice(0, 90));

	const writeScratch = await tool('file_write', { path: 'chats/c-test/work/draft.md', content: 'mine\n' });
	check('a worker always has its own working folder to write in',
		!/Refused/.test(writeScratch), writeScratch.slice(0, 90));

	// No attachment, no command. Asserted on the REFUSAL and on its wording being
	// the chat's own: the Diamond sentence points at a Diamond that does not exist
	// and at a panel that is not where this is fixed.
	await page.evaluate(() => { window.__hand.runs = []; });
	const ranBare = await tool('run', { argv: ['echo', 'hello'] });
	const bareRuns = await page.evaluate(() => window.__hand.runs.length);
	check('with nothing attached, a command is refused', /Refused/.test(ranBare), ranBare.slice(0, 110));
	// Asked AT THE HAND. A refusal in the reply text with the command already run is
	// the failure this is here to catch, and only the hand can tell them apart.
	check('and nothing reached the machine', bareRuns === 0, 'the hand saw ' + bareRuns + ' run(s)');
	check('and the refusal is about this chat, not about a Diamond',
		/chat/i.test(ranBare) && !/this Diamond has no folder/i.test(ranBare),
		ranBare.slice(0, 140));

	// ── With a folder attached ──
	const held = await worker(['papers'], BREAK);
	check('an attached folder is in the write fence',
		(held.write_allow || []).indexOf('papers') >= 0, JSON.stringify(held.write_allow));

	const writeHeld = await tool('file_write', { path: 'papers/spec.md', content: 'edited by the worker\n' });
	check('and what the user attached can be written',
		!/Refused/.test(writeHeld), writeHeld.slice(0, 90));

	const writeFar2 = await tool('file_write', { path: 'elsewhere/notes.md', content: 'clobbered\n' });
	check('while everything else still cannot be',
		/Refused/.test(writeFar2), writeFar2.slice(0, 90));

	const readFar2 = await tool('file_read', { path: 'elsewhere/notes.md' });
	check('and reading everything else still can',
		/the user own note/.test(readFar2), readFar2.slice(0, 90));

	// The other half of "no attachment, no command": WITH one, a command runs, and
	// it runs inside the attached folder rather than at the granted root. A rule
	// that only ever refuses is indistinguishable from the tool being broken.
	await page.evaluate(() => { window.__hand.runs = []; });
	const ranHeld = await tool('run', { argv: ['echo', 'hello'] });
	const heldRun = await page.evaluate(() => window.__hand.runs[0] || null);
	check('with a folder attached, a command runs', !/Refused/.test(ranHeld), ranHeld.slice(0, 110));
	check('and it runs in the attached folder, not at the granted root',
		!!heldRun && /\/papers$/.test(String(heldRun.cwd || '')),
		heldRun ? String(heldRun.cwd) : 'the hand saw nothing');
	// The fence the command actually carried, and the ONE place the verb split is
	// deliberately not followed. `rw` is the marked folder; the granted root is in
	// NEITHER list, so a command reads exactly where it may write and no further.
	// A program cannot be asked what it will do, which is the same sentence that
	// makes it a write — and a fence handing it the whole root read-only would put
	// one `tar | curl` between a stranger's instruction and everything the user
	// owns, and would dissolve the compartment dev/verify_scope.mjs proves through
	// the kernel.
	const fence = heldRun && heldRun.fence;
	check('the fence gives the marked folder to a command and the granted root to nothing',
		!!fence && (fence.rw || []).some(p => /\/papers$/.test(p))
			&& !(fence.rw || []).includes('/home/tester/granted')
			&& !(fence.ro || []).includes('/home/tester/granted'),
		JSON.stringify(fence));
	check('and Daimond\'s own directory is denied to it outright',
		!!fence && (fence.deny || []).some(p => /\/\.daimond$/.test(p)),
		JSON.stringify(fence && fence.deny));
	// An unattended worker gets no network inside a command, on a clean turn as
	// much as a dirty one: it cannot be asked about a destination, so the
	// alternative is a process reaching anywhere with nobody in the loop.
	check('and an unattended worker\'s command has no network',
		!!fence && fence.net === false, JSON.stringify(fence && fence.net));

	// Daimond's own directory is out of bounds in a chat's scope too — this is the
	// one scope that reads freely otherwise, so the deny has more work to do here.
	const readOwn = await tool('file_read', { path: '.daimond/config.json' });
	check('Daimond\'s own directory is not readable even so',
		/Refused/.test(readOwn), readOwn.slice(0, 90));
} catch (e) {
	check('no exception during the run', false, String(e && e.message || e));
} finally {
	try { await s.browser.close(); } catch (e) { /* ignore */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
