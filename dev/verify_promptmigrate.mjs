// A renamed role carries its old prompt file across.
//
// `prompts/conductor.md` was the daimon's before the rename, and it is a file a
// user may have spent an afternoon on. Renaming the role without carrying it
// would leave that file in the workspace being read by nothing: the agent
// quietly back on the shipped default, the edited file still on disk looking as
// though it were in force. Of the three ways this could go, that is the worst,
// because nothing about it looks wrong.
import { open, shot, signInAs } from './harness.mjs';

const s = await open({ name: 'promptmig' });
const { page } = s;
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

const wasm = (fn) => page.evaluate(async (src) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await (new Function('app', `return (${src})(app);`))(app);
}, fn.toString());

const MINE = '# My own daimon prompt\nKeep the crystal terse.\n';

// A prompt file written under the OLD name, as a user upgrading would have.
await wasm(async (app) => await app.run_tool('file_write',
	JSON.stringify({ path: 'prompts/conductor.md', content: '# My own daimon prompt\nKeep the crystal terse.\n' })));
await page.waitForTimeout(300);

// The real upgrade path: the user reloads into a build where the role has been
// renamed. Nothing is called directly -- boot has to do it, or it will not
// happen for anyone.
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'promptmig');       // a reload lands on the gate; boot resumes past it
await page.waitForTimeout(2000);

const after = await wasm(async (app) => {
	const read = async (p) => {
		try { return await app.run_tool('file_read', JSON.stringify({ path: p })); }
		catch (e) { return 'ERR'; }
	};
	return { neu: await read('prompts/daimon.md'), old: await read('prompts/conductor.md') };
});
console.log(JSON.stringify(after));

check(after.neu === MINE, 'the edited prompt now reads under the new name');
check(after.old === MINE, 'and the old file is left alone rather than destroyed');

// Running again must not clobber a daimon.md the user has since edited.
await wasm(async (app) => await app.run_tool('file_write',
	JSON.stringify({ path: 'prompts/daimon.md', content: 'newer\n' })));
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'promptmig');       // a reload lands on the gate; boot resumes past it
await page.waitForTimeout(2000);
const again = await wasm(async (app) => {
	try { return await app.run_tool('file_read', JSON.stringify({ path: 'prompts/daimon.md' })); }
	catch (e) { return 'ERR'; }
});
check(again === 'newer\n', `a second run does not overwrite the new file (${JSON.stringify(again)})`);

console.log(bad ? `\n${bad} FAILED` : '\nALL PASS');
await s.close();
process.exit(bad ? 1 : 0);
