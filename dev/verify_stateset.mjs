// gateway: none
// verify_stateset.mjs -- a daimon's `state_set` lands in its own Diamond's STATE.md (QA r572y
// C4-1, UNBLOCK-18).
//
// The live fault (r572y): `state_set` named the bare `STATE.md`, which with the app's empty
// path prefix is the workspace ROOT's file, outside the Diamond's write fence. Every call was
// refused, each a paid round, and the refusal told the daimon to ask the owner to attach a
// folder. Driven here through a real steer turn against the mock provider:
//
//   S1  the tool reports success, not a refusal.
//   S2  `diamonds/<id>/STATE.md` holds the section afterwards.
//   S3  a 5 KB section is landed through `state_md::land`: the Diamond's archive grew.
//   S4  the workspace root has no `STATE.md`.
//
//   eval "$(bash dev/world.sh 90 --up)" ; eval "$(bash dev/world.sh 90 --env)"
//   node dev/verify_stateset.mjs
import { open, signInAs, connectMock } from './harness.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' -- ' + detail));
	ok ? pass++ : fail++;
};

const s = await open({ name: 'stateset' });
const page = s.page;
await signInAs(s, 'stateset');
await connectMock(s);
await page.waitForTimeout(1500);
const MOCK = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';

try {
	await page.evaluate(async (mock) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		window.__m  = m;
		window.__vf = new m.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
	}, MOCK);
	const read = (p) => page.evaluate((x) => window.__m.read_file(x).catch(() => null), p);
	const text = (v) => v == null ? null : (typeof v === 'string' ? v : new TextDecoder().decode(v));

	const dia = await page.evaluate((nm) => window.__vf.create_diamond(nm), 'Stateset');
	check('S0. a Diamond to work in', !!dia, dia);
	const own     = `diamonds/${dia}/STATE.md`;
	const archive = `diamonds/${dia}/.daimond/decisions-archive.md`;
	const archBefore = (text(await read(archive)) || '').length;

	// Five KB of one section: over the section's own bound, so `land` must archive the excess.
	let body = '';
	for (let i = 0; body.length < 5 * 1024; i++) body += `line ${i} of where the work stands, said plainly.\n`;
	const marker = 'line 0 of where the work stands';
	const call = '@tool state_set ' + JSON.stringify({ key: 'Where things are', text: body });

	const out = await page.evaluate(async (a) => {
		const msgs = await window.__vf.steer_crystal(a.id, a.call, '[]', [], () => {});
		return Array.from(msgs || []).map((m) => ({ role: m.role, content: m.content || '' }));
	}, { id: dia, call });
	const said = (out.find((m) => m.role === 'tool') || {}).content || '';
	check('S1. state_set reports success, not a refusal',
		!!said && !/refused|not in this Diamond|not working inside/i.test(said), said.slice(0, 300));

	const st = text(await read(own)) || '';
	check('S2. the Diamond\'s own STATE.md holds the section',
		st.includes('## Where things are') && st.includes(marker), st.slice(0, 300));

	const archAfter = (text(await read(archive)) || '').length;
	check('S3. the 5 KB section was landed: the archive grew',
		archAfter > archBefore, `archive ${archBefore} -> ${archAfter} bytes, STATE.md ${st.length} bytes`);

	const root = await read('STATE.md');
	check('S4. the workspace root has no STATE.md', root == null, text(root)?.slice(0, 200));
} catch (e) {
	check('the run completed', false, String((e && e.stack) || e));
}

console.log(`\n${pass} passed, ${fail} failed`);
await s.close?.();
process.exit(fail ? 1 : 0);
