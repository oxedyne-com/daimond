// verify_crystalcap.mjs — a crystal is a summary, and the ceiling is what says so.
//
// The crystal carries the reduced state of a Diamond; the scope attached to it
// carries the weight. Nothing enforced that, so a daimon that started recording
// rather than reducing simply kept going — and the bill arrived somewhere else,
// because every fold copies the whole crystal into `versions/` and all of it
// rides in the sync parcel.
//
// The rule is one function, `tools::crystal_write_refused`, and it is checked at
// all THREE doors, which is the only reason it holds:
//
//   * `Tool::FileWrite`, which is how a DAIMON rewrites its crystal. The store
//     sees that write only afterwards, when `record_steer` snapshots what is on
//     disk, so a check there would be refusing a write that already happened.
//   * `Tool::FileEdit`, which is how a daimon edits it IN PLACE. This door was
//     missing until 2026-08-09, and the file said "BOTH doors" while a daimon
//     that edited rather than rewrote walked past the ceiling entirely. The
//     store's door did then fire, but too late to help: it reads the old length
//     from disk, and by then the edit had landed, so `old == new`, the refusal
//     arrived after the fact, `record_steer` errored, the turn failed, and an
//     OVERSIZED CRYSTAL WAS LEFT ON DISK WITH NO VERSION SNAPSHOT AND NO LOG
//     RECORD. Every assertion below used to go through the other two doors,
//     which is exactly why nothing went red.
//   * `diamond::snapshot`, which is how a HAND EDIT and a FOLD reach the file.
//     They never touch the file tool, so the first two doors do not see them.
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
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no mock LLM: nothing
// here runs a turn.
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

		// ── The daimon's OTHER door: file_edit ───────────────────────
		// `file_edit` writes the file just as `file_write` does, so it needs the
		// same ceiling. Anchored on a unique token, because the tool refuses an
		// `old_string` that appears more than once and a run of identical letters
		// matches itself many times over.
		const edit = async (path, oldS, newS) => {
			let msg;
			try {
				msg = String(await app.run_tool('file_edit',
					JSON.stringify({ path, old_string: oldS, new_string: newS })));
			} catch (e) { msg = String(e && e.message ? e.message : e); }
			return { ok: /^Edited /.test(msg), msg: msg.replace(/\[[0-9;]*m/g, '') };
		};
		r.editSeed  = await write(dir + '/crystal.md', 'HEAD\n' + small);
		r.editUnder = await edit(dir + '/crystal.md', 'HEAD', 'HEADER');
		r.editOver  = await edit(dir + '/crystal.md', 'HEADER', 'z'.repeat(CAP + 500));
		// The specific harm this door caused: not that the write was allowed, but
		// that the turn then died at the store's door leaving the oversized bytes
		// on disk, unsnapshotted and unlogged. So the file itself is the assertion.
		r.afterEditRefusal = await read(dir + '/crystal.md');

		// ── An already-oversized crystal can still be edited DOWN ────
		// Seeded past the ceiling with the ceiling RAISED -- not with zero, which
		// means the default (16 KiB) rather than "no ceiling", and which quietly
		// refused the seed the first time this was written.
		app.set_crystal_cap(64 * 1024);
		const huge = 'z'.repeat(20 * 1024);
		r.seeded = await write(dir + '/crystal.md', huge);
		app.set_crystal_cap(CAP);
		// The asymmetry has to hold at the edit door too, or a Diamond that
		// predates the rule could be rewritten down to size but never edited down.
		// A hair over half, so it matches once rather than twice.
		r.editShrink   = await edit(dir + '/crystal.md', 'z'.repeat(10 * 1024 + 1), '');
		// 20 KB less 10241 leaves 10239 -- still over, so the writes below are
		// still shrinking and the chain that follows is unchanged.
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

	check(out.editSeed.ok, 'a crystal small enough to edit is in place', out.editSeed.msg);
	check(out.editUnder.ok, 'an edit that keeps the crystal under the ceiling is written',
		out.editUnder.msg);
	check(!out.editOver.ok, 'an edit that would push it over is refused at the edit door',
		out.editOver.msg);
	check(names(out.editOver.msg), 'and that refusal names the scope as well', out.editOver.msg);
	// The one that matters most: the old failure was not a permitted write, it was
	// a write that landed and then killed the turn, leaving bytes nothing recorded.
	check(!/z/.test(out.afterEditRefusal || ''),
		'and the refused bytes never reached the file, so no unsnapshotted crystal is left behind');
	check(out.editShrink.ok, 'an edit may still make an oversized crystal SMALLER',
		out.editShrink.msg);

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
