// verify_crystalcap.mjs — a crystal is a summary, and the ceiling is what says so.
//
// The crystal carries the reduced state of a Diamond; the scope attached to it
// carries the weight. Nothing enforced that, so a daimon that started recording
// rather than reducing simply kept going — and the bill arrived somewhere else,
// because every fold copies the whole crystal into `versions/` and all of it
// rides in the sync parcel.
//
// The rule is one function, `tools::crystal_write_refused`, and it is checked at
// BOTH doors, which is the only reason it holds:
//
//   * `Tool::FileWrite`, which is how a DAIMON edits its crystal. The store sees
//     that write only afterwards, when `record_steer` snapshots what is on disk,
//     so a check there would be refusing a write that already happened.
//   * `diamond::snapshot`, which is how a HAND EDIT and a FOLD reach the file.
//     They never touch the file tool, so the first door does not see them.
//
// And two things the ceiling must NOT do, each of which would be worse than
// having no ceiling at all:
//
//   * refuse a write that makes an oversized crystal SMALLER, which would leave
//     every Diamond that predates the rule unable to be edited down to it;
//   * apply to anything but the crystal — a `versions/NNNN.md` snapshot of an
//     oversized crystal has to keep being written, or the Diamond at the ceiling
//     cannot be recorded at all.
//
//   node dev/verify_crystalcap.mjs
//
// Needs dev/serve.mjs on :8777. No gateway, no mock LLM: nothing here runs a turn.
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'crystalcap');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'crystalcap', profile: PROFILE, connect: false });
const { page } = s;

try {
	await page.waitForTimeout(1500);

	const out = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);

		// A small ceiling, so the test is about the rule and not about writing 16 KB.
		const CAP = 1000;
		app.set_crystal_cap(CAP);

		const id  = await app.create_diamond('Capped');
		const dir = 'diamonds/' + id;
		const big   = 'x'.repeat(CAP + 500);
		const small = 'y'.repeat(200);
		const r = {};

		// `run_tool` RESOLVES with the error text rather than rejecting, so a
		// refusal and a write look identical to a `try`/`catch`. Success is the
		// "Wrote N bytes" shape and nothing else -- reading it the other way round
		// made this file report two passes it had not earned.
		const write = async (path, content) => {
			let msg;
			try { msg = String(await app.run_tool('file_write', JSON.stringify({ path, content }))); }
			catch (e) { msg = String(e && e.message ? e.message : e); }
			return { ok: /^Wrote \d+ bytes/.test(msg), msg: msg.replace(/\[[0-9;]*m/g, '') };
		};
		const read = async (path) => {
			try { return await app.run_tool('file_read', JSON.stringify({ path })); }
			catch (e) { return 'ERR ' + e; }
		};

		// ── The daimon's door ────────────────────────────────────────
		r.underCap = await write(dir + '/crystal.md', small);
		r.overCap  = await write(dir + '/crystal.md', big);
		// And the file must still hold the small one: a refusal that wrote anyway
		// is not a refusal.
		r.afterRefusal = await read(dir + '/crystal.md');

		// ── Not the crystal, not capped ──────────────────────────────
		r.versionBig  = await write(dir + '/versions/0007.md', big);
		r.ordinaryBig = await write(dir + '/notes.md', big);

		// ── The store's door ─────────────────────────────────────────
		// `write_crystal` DOES reject, so here a throw is the refusal.
		const hand = async (md) => {
			try { await app.write_crystal(id, md); return { ok: true, msg: 'accepted' }; }
			catch (e) {
				return { ok: false, msg: String(e && e.message ? e.message : e).replace(/\[[0-9;]*m/g, '') };
			}
		};
		r.storeOver  = await hand(big);
		r.storeUnder = await hand(small);

		// ── An already-oversized crystal can still be edited DOWN ────
		// Seeded past the ceiling with the ceiling RAISED -- not with zero, which
		// means the default (16 KiB) rather than "no ceiling", and which quietly
		// refused the seed the first time this was written.
		app.set_crystal_cap(64 * 1024);
		const huge = 'z'.repeat(20 * 1024);
		r.seeded = await write(dir + '/crystal.md', huge);
		app.set_crystal_cap(CAP);
		r.shrinkToward = await write(dir + '/crystal.md', 'z'.repeat(5 * 1024));	// still over, but smaller
		r.shrinkUnder  = await write(dir + '/crystal.md', small);					// and all the way down
		r.growAgain    = await write(dir + '/crystal.md', 'z'.repeat(6 * 1024));	// over again: refused

		return r;
	});

	const names = (m) => /scope/i.test(m || '');

	check(out.underCap.ok, 'a crystal under the ceiling is written', out.underCap.msg);
	check(!out.overCap.ok, 'a crystal over it is refused at the daimon\'s door', out.overCap.msg);
	check(names(out.overCap.msg), 'and the refusal names the scope as the place for the detail',
		out.overCap.msg);
	check(/^y+$/.test(out.afterRefusal.replace(/^\s*1\t/, '').trim()),
		'and the refused bytes did not reach the file');

	check(out.versionBig.ok, 'a version snapshot is not measured against the ceiling',
		out.versionBig.msg);
	check(out.ordinaryBig.ok, 'nor is an ordinary file in the Diamond', out.ordinaryBig.msg);

	check(!out.storeOver.ok, 'a hand edit over the ceiling is refused at the store\'s door',
		out.storeOver.msg);
	check(names(out.storeOver.msg), 'and that refusal names the scope too', out.storeOver.msg);
	check(out.storeUnder.ok, 'a hand edit under it is written', out.storeUnder.msg);

	check(out.seeded.ok, 'a Diamond can be seeded past the ceiling with the ceiling lifted');
	check(out.shrinkToward.ok, 'an oversized crystal can be edited SMALLER while still over',
		out.shrinkToward.msg);
	check(out.shrinkUnder.ok, 'and all the way under', out.shrinkUnder.msg);
	check(!out.growAgain.ok, 'but not grown again once it is under', out.growAgain.msg);

} finally {
	await s.close();
}

console.log(bad === 0 ? '\nall checks passed' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
