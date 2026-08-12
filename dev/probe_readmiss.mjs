// probe_readmiss.mjs — what the file door says when a path is not there.
//
// `Pending.sweep` may only drop a tile when the answer is "that file is gone",
// never when it is "the door did not answer" — so it has to be able to tell the
// two apart. This asks the door directly.
import { open } from './harness.mjs';

const s = await open({ name: 'readmiss', connect: false, defaults: false });
const p = s.page;
await p.waitForTimeout(1500);

const out = await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const say = async (label, fn) => {
		try { const r = await fn(); return { label, threw: false, value: String(r).slice(0, 120) }; }
		catch (e) { return { label, threw: true, name: e && e.name, msg: String(e && (e.message || e)).slice(0, 200) }; }
	};
	await m.write_file('probe-here.txt', 'here');
	return [
		await say('present file', () => m.read_file('probe-here.txt')),
		await say('missing file', () => m.read_file('probe-gone.txt')),
		await say('missing under a missing dir', () => m.read_file('nope/deeper/gone.eml')),
		await say('probe of a missing file', () => m.file_probe('probe-gone.txt')),
	];
});
console.log(JSON.stringify(out, null, 2));
await s.close();
