// verify_p14save.mjs — the false "changed on disk" save conflict (forge #14), in isolation.
//
// node dev/verify_p14save.mjs --break staleanchor   restore the shipped defect and run
// Declared breaks: staleanchor
// Live symptom: the user edits a file in the Doc panel, presses Save, and is told
// "Save failed: file_write: 'X' changed on disk since you read it -- another agent
// edited it. Re-read the file and reapply your change so theirs is not lost." It
// fires repeatedly although nobody else touched the file.
//
// THE MECHANISM, in one paragraph. The write guard inside Tool::FileWrite
// (src/tools.rs:16412-16426) compares the bytes on disk with the hash the
// app-lifetime `read_seen` cache holds for that path, and refuses on mismatch.
// That cache is written ONLY by tool-layer calls (tools.rs:16476/16485/16507/
// 16527/16579/16661/16893/16967) — never by the Doc panel, whose opens go
// through the raw exports `Wasm.read_file`/`Wasm.store_read` (entry.rs:280/443)
// and whose store-door saves go through `Wasm.store_write` (entry.rs:456),
// none of which touch the cache. So one anchor is installed when any agent
// turn reads the file, and every write that bypasses the tool layer — a store
// save, sync materialising the file, a Restore — drifts the disk under it
// without ever refreshing it. The app already knows this failure mode and
// patches one instance of it (forget_seen after versions_restore, app.rs:1998);
// the Doc panel's save had no such patch, so one drift refused every save
// forever: the panel cannot "re-read and reapply", because nothing in its flow
// ever re-anchors.
//
// THE FIX, verified here: `writeOpenFile` (www/js/daimond.js) on its tool door
// now performs a `file_read` of the path immediately before the `file_write`,
// refreshing the anchor to the current bytes — the panel holds them (readRaw)
// and its soft conflict check has already compared them, so the write passes
// the guard honestly. The function is lifted VERBATIM from daimond.js via
// grabFn and driven through the three sequences that matter: a save with no
// prior anchor, a save over a stale anchor (the shipped defect's shape), and
// a save the fence refuses (the write must still report refusal, not success).
//
// Declared break `staleanchor` restores the defect exactly as it shipped: the
// tool door skips the re-anchoring read and calls file_write directly over the
// stale anchor, which reddens the stale-anchor check below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Declared breaks, run by the verify verb as `--break <name>`. Each restores
// the defect EXACTLY as it shipped, so what reddens under it is what a user
// saw in the product — never a synthetic weakening of the check.
const BREAKS = {
	// Before the fix there was no re-anchoring read: the tool door called
	// file_write over whatever anchor happened to sit in the cache, stale or
	// not. Restoring that is the defect the reporter saw on the forge (#14).
	staleanchor: [{
		file: 'js/daimond.js',
		// The door waits on the version mark first (2026-09-25), one level deeper.
		find: '\t\t\t\treturn tools().run_tool_outcome(\'file_read\',\n'
			+ '\t\t\t\t\tJSON.stringify({ path: path })).then(function () {\n'
			+ '\t\t\t\t\treturn tools().run_tool_outcome(\'file_write\',\n'
			+ '\t\t\t\t\t\tJSON.stringify({ path: path, content: content }));\n'
			+ '\t\t\t\t});',
		with: '\t\t\t\treturn tools().run_tool_outcome(\'file_write\',\n'
			+ '\t\t\t\t\tJSON.stringify({ path: path, content: content }));',
	}],
};

const BREAK = process.argv.find(a => a.startsWith('--break='))?.slice(8)
	|| (process.argv[2] === '--break' ? process.argv[3] : null);
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

// The damaged source, loaded BEFORE any check reads it: the break edits the
// file the checks grep and evaluate, so a red here is the shipped defect.
// The pristine copy is taken BEFORE any damage, so exit-restore undoes it.
const SRC_DIR = path.join(HERE, '..', 'www');
const PATCHES = BREAK ? BREAKS[BREAK] : [];
const MEMENTOES = new Map();
function memento(file) {
	if (!MEMENTOES.has(file)) MEMENTOES.set(file, fs.readFileSync(file, 'utf8'));
	return MEMENTOES.get(file);
}
for (const p of PATCHES) {
	const file = path.join(SRC_DIR, p.file);
	const src = memento(file);
	if (!src.includes(p.find)) {
		console.error(`break '${BREAK}': anchor not found in ${p.file}`);
		process.exit(2);
	}
	fs.writeFileSync(file, src.replace(p.find, p.with));
}
process.on('exit', () => { for (const p of PATCHES) {                    // restore on exit, always
	const file = path.join(SRC_DIR, p.file);
	const src = MEMENTOES.get(file);
	if (src != null) fs.writeFileSync(file, src);
} });

// The damaged source as it NOW sits on disk, read AFTER any break was applied:
// the checks must see the defect, while MEMENTOES holds the pristine bytes
// captured BEFORE the patch loop for the restore-on-exit.
const DAIMOND_SRC = fs.readFileSync(path.join(SRC_DIR, 'js', 'daimond.js'), 'utf8');

let bad = 0, ran = 0;
const check = (pass, name, detail) => {
	ran++;
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// Same device as verify_report_cap.mjs's grabFn: a function found by its
// declaration and brace-matched from the opening `{`, so a rename or a move
// throws here rather than silently testing a stale copy.
function grabFn(src, sig) {
	const start = src.indexOf(sig);
	if (start < 0) { console.error(`could not find '${sig}'`); process.exit(2); }
	const open = src.indexOf('{', start);
	let depth = 0, i = open;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}

// writeOpenFile is lifted verbatim; its free variables (tools, storeFile, Wasm,
// versionsPath, window) are supplied as parameters of the factory so the
// sequence under test can observe and vary them.
const WOF_SRC = grabFn(DAIMOND_SRC, 'function writeOpenFile(');
if (!BREAK && !/file_read/.test(WOF_SRC)) {
	console.error('writeOpenFile no longer re-anchors before the write — fix regressed?');
	process.exit(2);
}

// A tiny tools() double: records the call sequence and answers as the tool
// layer does. `anchors` is the read_seen stand-in: file_read inserts
// content_hash(bytes on "disk"), file_write compares it — the real guard's
// logic in miniature, taken from src/tools.rs:16412-16426.
function makeWorld(disk0) {
	const seq = [];
	let disk = disk0;
	const anchors = new Map();                       // path -> hash the cache holds
	const hash = s => {                              // FNV-1a, as content_hash
		let h = 0x811c9dc5;
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		return h;
	};
	const tools = () => ({
		run_tool_outcome(name, args) {
			seq.push([name, args]);
			const a = JSON.parse(args);
			if (name === 'file_read') {
				anchors.set(a.path, hash(disk));
				return Promise.resolve({ outcome: 'ok', text: disk });
			}
			if (name === 'file_write') {
				// The guard, in the shape of tools.rs:16412-16426: a stored
				// anchor that no longer matches the disk is refused, naming
				// another agent. This is the refusal the reporter saw.
				if (anchors.has(a.path) && anchors.get(a.path) !== hash(disk)) {
					return Promise.resolve({
						outcome: 'error',
						text: "file_write: '" + a.path + "' changed on disk since you read it -- "
							+ 'another agent edited it. Re-read the file and reapply your change '
							+ "so theirs is not lost.",
					});
				}
				disk = a.content;
				anchors.set(a.path, hash(disk));     // tools.rs:16485
				return Promise.resolve({ outcome: 'ok', text: '' });
			}
			return Promise.reject(new Error('no such tool ' + name));
		},
	});
	return { tools, seq, anchors, disk: () => disk, disk_set: s => { disk = s; } };
}

// The panel's own view of the file, which readRaw handed it: whatever the
// "disk" held when the panel opened it.
const SAVED = '## Standing instructions\n\n- One more line the user typed.\n';

async function makePanel(world, openedAs) {
	let storeFile = false;
	const versionsPath = () => null;
	const Wasm = {};
	const window = { DaimondVersions: null };
	const factory = new Function('tools', 'storeFile', 'Wasm', 'versionsPath', 'window',
		WOF_SRC + '\nreturn writeOpenFile;');
	const writeOpenFile = factory(world.tools, storeFile, Wasm, versionsPath, window);
	return writeOpenFile;
}

console.log('writeOpenFile — the tool door, against the guard in miniature');

// ── A save with no prior anchor: the ordinary case, passes ────────────
{
	const world = makeWorld('original bytes\n');
	const save = await makePanel(world);
	const r = await save('DAIMOND.md', SAVED);
	check(r.outcome === 'ok', 'a save with no prior anchor writes cleanly', JSON.stringify(r));
	check(world.disk() === SAVED, 'the disk now holds the saved content');
}

// ── A SAVE OVER A STALE ANCHOR: the shipped defect's exact shape ──────
// An agent read the file at anchor-time; sync (or a store save, or a
// Restore) then changed the disk under the anchor; the user now saves an
// edit built on CURRENT bytes. Before the fix: refused forever. After: the
// re-anchoring read refreshes the hash to current bytes and the write passes.
{
	const world = makeWorld('original bytes\n');
	// The anchor, installed by some earlier agent turn and drifted since.
	await world.tools().run_tool_outcome('file_read', JSON.stringify({ path: 'DAIMOND.md' }));
	world.disk_set('changed by sync, not by any agent\n');       // drift under the anchor
	const save = await makePanel(world);
	const r = await save('DAIMOND.md', SAVED);
	check(r.outcome === 'ok',
		'a save over a stale anchor writes cleanly (was: refused as "another agent edited it")',
		JSON.stringify(r));
	check(world.disk() === SAVED, 'the stale-anchor save landed');
}

// ── A REFUSED WRITE STILL REPORTS REFUSAL, not success ────────────────
// The fence can stop a write (no_write, a refusal the re-read cannot cure).
// The .then chain must carry the tool layer's answer through untouched, so
// the panel still tells the user the truth — this is the contract that
// writeOpenFile exists to keep (its own doc comment names a past bug where a
// refused save resolved and was reported as saved).
{
	const world = makeWorld('original bytes\n');
	// file_write that always refuses, for whatever reason the fence has.
	const refuse = () => ({ tools: () => ({
		run_tool_outcome(name, args) {
			if (name === 'file_read') return Promise.resolve({ outcome: 'ok', text: '' });
			return Promise.resolve({
				outcome: 'error',
				text: 'file_write: the write was refused by the fence.',
			});
		},
	}), seq: [], anchors: new Map(), disk: () => 'original bytes\n' });
	const w2 = refuse();
	const save = await makePanel(w2);
	const r = await save('DAIMOND.md', SAVED);
	check(r.outcome === 'error' && /refused/.test(r.text),
		'a refused write is still reported as refused, never as saved', JSON.stringify(r));
}

// ── THE ORDER THE CALLS ARRIVE IN: read before write, always ─────────
{
	const world = makeWorld('original bytes\n');
	await world.tools().run_tool_outcome('file_read', JSON.stringify({ path: 'DAIMOND.md' }));
	world.disk_set('sync drift\n');
	const save = await makePanel(world);
	await save('DAIMOND.md', SAVED);
	const names = world.seq.map(([n]) => n).join(',');
	check(names === 'file_read,file_read,file_write',
		'the re-anchoring read precedes the write', names);
}

// ── The store door is untouched by this fix ────────────────────────────
{
	// storeFile true: the save must go through Wasm.store_write and never the
	// tools — the store door has no guard to satisfy and adding a read there
	// would cost a round trip for nothing. Checked by source, since driving
	// it needs no behaviour beyond the branch itself.
	check(/\bif \(storeFile\)/.test(WOF_SRC) && /store_write/.test(WOF_SRC),
		'the store door still goes straight to store_write');
}

console.log(`${ran - bad}/${ran} checks passed${bad ? ` — ${bad} FAILED` : ''}`);
process.exit(bad ? 1 : 0);
