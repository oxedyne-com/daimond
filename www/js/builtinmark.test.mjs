// NAMES N1 (16 Oct 2026): the built-ins are called Neil and Lucy, which are names a person gives
// their own Diamonds, so a NAME can never say "this is a built-in". The boot that matched by name
// moved his own "Lucy" into the Built-in group and put it in the Trash on reload. A built-in is
// now known by its fixed id or by a lasting marker in its own record (`builtin`, the fixed id it
// stands for), which the page sets on the fixed-id copies and on an older random-id copy it can
// prove by its old seed name and text.
//
// The functions live in a 50,000-line IIFE this harness cannot load, so each is cut out of the
// source by its own name and run alone.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const src  = readFileSync(join(HERE, 'daimond.js'), 'utf8');

function cut(name, optional) {
	let at = src.indexOf('\tfunction ' + name + '(');
	if (at < 0) at = src.indexOf('\tasync function ' + name + '(');
	if (at < 0 && optional) return '';
	assert.ok(at >= 0, name + ' is not in daimond.js');
	const end = src.indexOf('\n\t}\n', at);
	return src.slice(at, end + 3);
}

const DEFAULT_IDS  = { Neil: '0da1000000e1', Lucy: '0da1000000f2' };
const LEGACY_NAMES = { 'Daimond Help': 'Neil', 'Daimond Optimiser': 'Lucy' };	// names-gate: legacy
const OLD_LUCY_CRYSTAL = '{"title":"Daimond Optimiser"}';	// names-gate: legacy (stands in for the old seed text)

/// A small world: the rail's list, an engine that records what is asked of it, and every name
/// the cut functions reach for.
function world(list, crystals) {
	const calls = [];
	const W = {
		diamonds: list,
		chats: [],
		calls,
		app: {
			rename_diamond: async (id, name) => { calls.push(['rename', id, name]); const f = list.find((d) => d.id === id); if (f) f.name = name; },
			name_built_in:  async (id, name) => { calls.push(['rename', id, name]); const f = list.find((d) => d.id === id); if (f) { f.name = name; f.builtin_named = true; } },
			mark_built_in:  async (id, fixed) => { calls.push(['mark', id, fixed]); const f = list.find((d) => d.id === id); if (f) f.builtin = fixed; },
			read_crystal_data: async (id) => (crystals || {})[id] || '',
			write_crystal_data: async (id, json) => { calls.push(['write', id, json]); },
		},
		trash: { put: (id) => calls.push(['trash', id]) },
		toasts: [],
	};
	const deps = {
		DEFAULT_IDS, LEGACY_NAMES,
		diamonds: list,
		chats: W.chats,
		chatMsgCount: (c) => (c && c.msgCount) || 0,
		diamondApp: () => W.app,
		loadDiamonds: async () => {},
		renderDiamondList: () => {},
		toast: (s) => W.toasts.push(s),
		t: (k, a) => k + (a ? JSON.stringify(a) : ''),
		window: { DaimondTrash: W.trash },
		DaimondTrash: W.trash,
		crystalJson: (s) => s,
		DEFAULT_DIAMONDS: [],
	};
	const names = ['builtInSlot', 'isBuiltInDiamond', 'legacySeedProved', 'markBuiltIns',
		'renameLegacyBuiltIns', 'sweepSeededDuplicates', 'sweepSeededSpares', 'refreshLegacySeedCrystal', 'legacySeedCrystal'];
	const body = names.map((n) => cut(n, true)).join('\n');
	W.fn = new Function(...Object.keys(deps), body + '\nreturn {'
		+ names.map((n) => n + ': typeof ' + n + " === 'function' ? " + n + ' : null').join(',') + '};')(...Object.values(deps));
	return W;
}

test('his own unused "Lucy" is not a built-in, is not swept and is not renamed', async () => {
	const lucy = { id: '0da1000000f2', name: 'Lucy', crystal_version: 1, builtin: '0da1000000f2' };
	const his  = { id: 'aa11bb22cc33', name: 'Lucy', crystal_version: 0 };
	const W = world([lucy, his]);
	assert.equal(W.fn.isBuiltInDiamond(his), false, 'his Lucy was read as a built-in');
	assert.equal(W.fn.isBuiltInDiamond(lucy), true, 'the real Lucy was not recognised');
	if (W.fn.markBuiltIns) await W.fn.markBuiltIns();
	await W.fn.sweepSeededDuplicates();
	assert.deepEqual(W.calls.filter((c) => c[1] === his.id), [], 'his Lucy was touched: ' + JSON.stringify(W.calls));
	assert.deepEqual(W.toasts, []);
	assert.equal(his.name, 'Lucy');
	assert.equal(W.fn.isBuiltInDiamond(his), false, 'his Lucy became a built-in on boot');
});

test('a "Neil" of his own beside no built-in at all is still his', async () => {
	const his = { id: 'bb11bb22cc33', name: 'Neil', crystal_version: 0 };
	const W = world([his]);
	assert.equal(W.fn.isBuiltInDiamond(his), false);
});

test('the seed is not skipped because he has a Diamond called Lucy', () => {
	const seed = cut('seedDefaultDiamonds');
	assert.doesNotMatch(seed, /f\.name === d\.name/, 'the seed still skips on a name');
	assert.match(seed, /builtInSlot\(f\) === d\.name/, 'the seed skips only on a built-in of that slot');
	assert.doesNotMatch(cut('releaseSeededSelf'), /f\.name !== d\.name/, 'the self repair still goes by name');
});

test('isBuiltInDiamond reads no name', () => {
	const fn = cut('isBuiltInDiamond') + cut('builtInSlot', true);
	assert.doesNotMatch(fn, /\.name\b/, 'a name still decides whether a Diamond is built-in');
});

test('the fixed-id copy is marked, and a legacy random-id seed is proved by name and text', async () => {
	const fixed  = { id: '0da1000000e1', name: 'Neil', crystal_version: 1 };
	const legacy = { id: 'cc11bb22cc33', name: 'Daimond Optimiser', crystal_version: 3 };	// names-gate: legacy
	const named  = { id: 'dd11bb22cc33', name: 'Daimond Optimiser', crystal_version: 0 };	// names-gate: legacy
	const W = world([fixed, legacy, named], { cc11bb22cc33: OLD_LUCY_CRYSTAL, dd11bb22cc33: '{"title":"my own"}' });
	await W.fn.markBuiltIns();
	assert.equal(fixed.builtin, '0da1000000e1');
	assert.equal(legacy.builtin, '0da1000000f2', 'the old seed was not proved');
	assert.equal(named.builtin, undefined, 'a Diamond that only shares the old name was marked');
	assert.equal(W.fn.isBuiltInDiamond(legacy), true);
	assert.equal(W.fn.isBuiltInDiamond(named), false);
});

test('the sweep runs on the old names, before the rename, and the rename moves only marked copies', async () => {
	// Two legacy copies of the old Optimiser, both proved; the untouched one is the spare.
	const a = { id: 'cc11bb22cc33', name: 'Daimond Optimiser', crystal_version: 4, builtin: '0da1000000f2' };	// names-gate: legacy
	const b = { id: 'ee11bb22cc33', name: 'Daimond Optimiser', crystal_version: 0, builtin: '0da1000000f2' };	// names-gate: legacy
	const c = { id: 'ff11bb22cc33', name: 'Daimond Optimiser', crystal_version: 0 };	// names-gate: legacy (unproved)
	const W = world([a, b, c]);
	await W.fn.sweepSeededDuplicates();
	const kinds = W.calls.map((x) => x[0] + ':' + x[1]);
	assert.ok(kinds.indexOf('trash:ee11bb22cc33') >= 0, 'the spare was not swept: ' + kinds);
	assert.ok(kinds.indexOf('trash:ff11bb22cc33') < 0, 'an unproved copy was swept');
	assert.ok(kinds.indexOf('rename:cc11bb22cc33') > kinds.indexOf('trash:ee11bb22cc33'), 'renamed before the sweep: ' + kinds);
	assert.ok(kinds.indexOf('rename:ff11bb22cc33') < 0, 'an unmarked copy was renamed');
	assert.equal(a.name, 'Lucy');
});

// ── N2: the crystal's old heading, rewritten only where it is still the seed's own text ──

// d26e2aaa's seed for Help, verbatim, so the derivation below is held to the real old bytes.
const OLD_HELP_SEED = '# Daimond Help\n\n'	// names-gate: legacy
	+ 'Ask me how Daimond works. I answer from this build itself: its '
	+ 'panels, its tools, its settings.\n\n'
	+ 'The user guide is mirrored at `system/guide/`, one file per page. '
	+ 'Search it before answering, and say which page an answer came from.\n\n'
	+ '## What I know\n\n'
	+ '- Nothing yet. Press play, ask a question, and this fills in.\n';

/// The seeds as the source holds them, cut out with what they need.
function seeds() {
	const at = src.indexOf('\tvar DEFAULT_DIAMONDS = [');
	const end = src.indexOf('\n\t];\n', at);
	return new Function('DEFAULT_IDS', 'USAGE_DIR', 'GUIDE_DIR', src.slice(at, end + 5) + '\nreturn DEFAULT_DIAMONDS;')(DEFAULT_IDS, '', '');
}

test('the old seed text is derived exactly from the new one', () => {
	const D = seeds();
	const legacySeedCrystal = new Function(cut('legacySeedCrystal') + '\nreturn legacySeedCrystal;')();
	assert.equal(legacySeedCrystal(D[0]), OLD_HELP_SEED);
	assert.match(legacySeedCrystal(D[1]), /^# Daimond Optimiser\n\nI find what should/);	// names-gate: legacy
});

test('a crystal still byte-identical to the old seed gets the new heading, as a new version', async () => {
	const D = seeds();
	const neil = { id: '0da1000000e1', name: 'Daimond Help', crystal_version: 1, builtin: '0da1000000e1' };	// names-gate: legacy
	const fresh = world([neil], { '0da1000000e1': OLD_HELP_SEED });
	const lifted = new Function('DEFAULT_IDS', 'LEGACY_NAMES', 'DEFAULT_DIAMONDS', 'diamonds', 'diamondApp',
		'loadDiamonds', 'crystalJson', [cut('builtInSlot'), cut('legacySeedCrystal'), cut('refreshLegacySeedCrystal'),
			cut('renameLegacyBuiltIns')].join('\n') + '\nreturn renameLegacyBuiltIns;')(
		DEFAULT_IDS, LEGACY_NAMES, D, [neil], () => fresh.app, async () => {}, (s) => s);
	await lifted();
	const writes = fresh.calls.filter((c) => c[0] === 'write');
	assert.equal(writes.length, 1, 'no new version written: ' + JSON.stringify(fresh.calls));
	assert.equal(writes[0][2], D[0].crystal);
	assert.equal(neil.name, 'Neil');
});

test('an edited crystal keeps every word, the old heading included', async () => {
	const D = seeds();
	const neil = { id: '0da1000000e1', name: 'Daimond Help', crystal_version: 2, builtin: '0da1000000e1' };	// names-gate: legacy
	const edited = OLD_HELP_SEED + '- He asked about tags.\n';
	const w = world([neil], { '0da1000000e1': edited });
	const lifted = new Function('DEFAULT_IDS', 'LEGACY_NAMES', 'DEFAULT_DIAMONDS', 'diamonds', 'diamondApp',
		'loadDiamonds', 'crystalJson', [cut('builtInSlot'), cut('legacySeedCrystal'), cut('refreshLegacySeedCrystal'),
			cut('renameLegacyBuiltIns')].join('\n') + '\nreturn renameLegacyBuiltIns;')(
		DEFAULT_IDS, LEGACY_NAMES, D, [neil], () => w.app, async () => {}, (s) => s);
	await lifted();
	assert.deepEqual(w.calls.filter((c) => c[0] === 'write'), [], 'an edited crystal was rewritten');
	assert.equal(neil.name, 'Neil', 'the name still moves');
});

// R568-FU F2: the rename ran on every boot, so a built-in he renamed BACK to its old seed name
// was renamed again on the next one. It runs once per Diamond, recorded in the Diamond's own
// record beside the marker (`builtin_named`), so the record travels and a second device does not
// redo what the first already did.
test('a built-in is renamed from its old seed name once, and the rename is recorded', async () => {
	const lucy = { id: '0da1000000f2', name: 'Daimond Optimiser', crystal_version: 3, builtin: '0da1000000f2' };	// names-gate: legacy
	const W = world([lucy]);
	await W.fn.renameLegacyBuiltIns();
	assert.equal(lucy.name, 'Lucy');
	assert.equal(lucy.builtin_named, true, 'the rename was not recorded: ' + JSON.stringify(W.calls));
});

test('a built-in he renamed back to its old seed name keeps it, on this boot and every other', async () => {
	const lucy = { id: '0da1000000f2', name: 'Daimond Optimiser', crystal_version: 3, builtin: '0da1000000f2', builtin_named: true };	// names-gate: legacy
	const neil = { id: 'ab11bb22cc33', name: 'Daimond Help', crystal_version: 2, builtin: '0da1000000e1', builtin_named: true };	// names-gate: legacy
	const W = world([lucy, neil]);
	await W.fn.renameLegacyBuiltIns();
	await W.fn.sweepSeededDuplicates();
	assert.deepEqual(W.calls.filter((c) => c[0] === 'rename'), [], 'his own name was taken again: ' + JSON.stringify(W.calls));
	assert.equal(lucy.name, 'Daimond Optimiser');	// names-gate: legacy
	assert.equal(neil.name, 'Daimond Help');	// names-gate: legacy
});
