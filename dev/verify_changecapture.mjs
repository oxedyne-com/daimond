// verify_changecapture.mjs — --capture then --from builds the same three trees as a
// direct run, so the answer can be kept out of the tree that builds the engine.
//
// WHY THIS EXISTS.  `dev/reflux_change.mjs` reads the working tree twice -- `laneChange()`
// and `splitChange`'s `#[cfg(test)]` scan -- and the engine staleguard runs 163 lines
// later.  A run with the change still in the tree therefore either dies at the guard or
// forces a rebuild that compiles THE ANSWER into the engine the daimon speaks through,
// which for a `src/tools.rs` change hands the daimon the API it is being asked to invent.
// `--capture` writes the split down; the lane restores HEAD; `--from` runs clean.
//
// The claim that needs proving is that the two paths are the SAME MEASUREMENT.  A capture
// that quietly produced a different `work/` would be worse than no capture at all, because
// every number after it would be about a tree nobody looked at.
//
// It applies a patch of its own and puts the tree back with `git checkout --`, and it
// REFUSES to start on a dirty worktree so that "put it back" can never mean "throw the
// lane's work away".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PATCH = path.join(os.homedir(), '.cache/daimond/lane-ag-tasks/task1_insert_before.patch');
const CAP   = path.join(os.homedir(), '.cache/daimond/lane-ag-tasks/capture.json');
const TREES = path.join(os.homedir(), '.cache/daimond-change/trees');
const GRANT = path.join(os.homedir(), '.cache/daimond-change/work');

const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
const bad = [];
const say = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad.push(what); };

/// Every file's path and content, as one hash. Build artefacts are excluded: a target
/// directory differs between two runs for reasons that are nothing to do with the split.
function treeHash(dir) {
	const h = crypto.createHash('sha256');
	const walk = (d, rel) => {
		let ents;
		try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of ents.sort((a, b) => a.name < b.name ? -1 : 1)) {
			if (e.name === '.git' || e.name === 'target' || e.name === '.cargo') continue;
			const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(p, r);
			else if (e.isFile()) { h.update(r); h.update(fs.readFileSync(p)); }
		}
	};
	walk(dir, '');
	return h.digest('hex');
}

function run(args, label) {
	const r = spawnSync('node', [path.join(ROOT, 'dev/reflux_change.mjs'), ...args],
		{ cwd: ROOT, encoding: 'utf8', env: { ...process.env } });
	const out = (r.stdout || '') + (r.stderr || '');
	if (r.status !== 0) console.log(out.split('\n').slice(-6).join('\n'));
	return { ok: r.status === 0, out, label };
}

const dirty = git('status', '--porcelain').stdout.trim();
if (dirty) {
	console.log('verify_changecapture: REFUSED — this worktree has uncommitted changes, and this '
		+ 'check puts the tree back with `git checkout --`. It will not do that to somebody\'s work.');
	process.exit(2);
}
if (!fs.existsSync(PATCH)) {
	console.log(`verify_changecapture: SKIPPED — no fixture patch at ${PATCH}`);
	process.exit(0);
}

// ── 1. The direct path, with the change in the tree ──
if (git('apply', '--whitespace=nowarn', PATCH).status !== 0) {
	console.log('verify_changecapture: the fixture patch does not apply to this HEAD; it was '
		+ 'taken at an older one. Retake it or delete it.');
	process.exit(2);
}
const direct = run(['--world', '2', '--dry', '--apply-answer'], 'direct');
say(direct.ok, 'the direct path passes with the change in the tree');
say(/PASS\s+\d+ test\(s\), 0 failing/.test(direct.out), 'the direct path is green on the answer');
const dMeasure = treeHash(path.join(TREES, 'measure'));
const dWork    = treeHash(path.join(GRANT, 'repo'));

// ── 2. Capture, restore, and run from the capture ──
const cap = run(['--world', '2', '--capture', CAP], 'capture');
say(cap.ok && fs.existsSync(CAP), 'the split can be captured to a file');
git('checkout', '--', '.');
say(!git('status', '--porcelain').stdout.trim(), 'the worktree is back at HEAD before the engine is built');

const from = run(['--world', '2', '--dry', '--apply-answer', '--from', CAP], 'from');
say(from.ok, 'the captured path passes against a clean worktree');
say(/PASS\s+\d+ test\(s\), 0 failing/.test(from.out), 'the captured path is green on the answer');
const fMeasure = treeHash(path.join(TREES, 'measure'));
const fWork    = treeHash(path.join(GRANT, 'repo'));

// ── 3. THE CLAIM ──
say(dMeasure === fMeasure, `measure/ is the same tree either way (${dMeasure.slice(0, 12)})`);
say(dWork === fWork, `work/repo is the same tree either way (${dWork.slice(0, 12)})`);

// ── 4. And the two refusals that keep --from honest ──
git('apply', '--whitespace=nowarn', PATCH);
const onDirty = run(['--world', '2', '--dry', '--from', CAP], 'dirty');
say(!onDirty.ok && /CLEAN worktree/.test(onDirty.out), '--from refuses a dirty worktree');
git('checkout', '--', '.');
const moved = JSON.parse(fs.readFileSync(CAP, 'utf8'));
moved.head = '0'.repeat(40);
fs.writeFileSync(CAP + '.moved', JSON.stringify(moved));
const onMoved = run(['--world', '2', '--dry', '--from', CAP + '.moved'], 'moved');
say(!onMoved.ok && /captured at/.test(onMoved.out), '--from refuses a capture taken at another HEAD');
fs.rmSync(CAP + '.moved', { force: true });

console.log(bad.length
	? `\nverify_changecapture: ${bad.length} check(s) failed.`
	: '\nverify_changecapture: both paths build the same three trees, and --from refuses a '
		+ 'dirty tree and a moved HEAD.');
process.exit(bad.length ? 1 : 0);
