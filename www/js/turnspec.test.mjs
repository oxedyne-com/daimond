// turnspec.test.mjs -- U4a TURNSPEC: the turn's model, preset and depth are decided once, in Rust.
//
//	node --test www/js/turnspec.test.mjs
//
// `src/testdata/turn_golden.json` holds twelve sends as the page decided them before the decision
// moved into `src/engine/turn.rs`. This replays that recorded JS decision over the rows (so the
// table is the page's own answer), requires the page to ask the engine (`Wasm.turn_spec`) instead of
// deciding again, and, where a DEV wasm sits in www/pkg, requires the export to give the same rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE   = dirname(fileURLToPath(import.meta.url));
const APP    = join(HERE, '..', '..');
const GOLDEN = JSON.parse(readFileSync(join(APP, 'src', 'testdata', 'turn_golden.json'), 'utf8'));
const PAGE   = readFileSync(join(HERE, 'daimond.js'), 'utf8');

// The page's decision as it stood (daimond.js `runSteerHeld`, `diamondModel`, `diamondCanRun`;
// models.js `resolve`), over the golden row's inputs. `keyed` is the providers configured with a key.
function jsDecision(i) {
	const d = i.default || { provider: '', model: '' };
	const keyed = i.keyed || [];
	const resolve = (provider, model) => {
		const id = provider || d.provider;
		const m  = model || (provider ? '' : d.model);
		if (!id || keyed.indexOf(id) < 0) return null;
		if (!m) return null;
		return { provider: id, model: m };
	};
	const dm = (i.stored && i.stored.model) ? i.stored : d;
	const preset = (typeof i.preset === 'string') ? i.preset : '';
	const depth  = (typeof i.depth === 'number') ? i.depth : 0;
	const hasBox = typeof i.typed === 'string';
	const instruction = preset || (hasBox ? i.typed.trim() : '');
	const r = resolve(dm.provider, dm.model);
	let refused = '';
	if ((!hasBox && !preset) || !instruction) refused = 'empty';
	else if (!r) refused = 'no_key';
	return { model: r, preset, depth, instruction: (!hasBox && !preset) ? '' : instruction, refused };
}

const pick = (o) => ({ model: o.model, preset: o.preset, depth: o.depth, instruction: o.instruction, refused: o.refused });

test('the golden table has twelve sends and each is the JS decision recorded', () => {
	assert.equal(GOLDEN.sends.length, 12);
	for (const s of GOLDEN.sends) assert.deepEqual(jsDecision(s.in), pick(s.want), s.name);
});

test('the engine exports turn_spec', () => {
	const src = readFileSync(join(APP, 'src', 'wasm', 'entry.rs'), 'utf8');
	assert.match(src, /#\[wasm_bindgen\]\s*pub fn turn_spec\(/, 'no turn_spec export in src/wasm/entry.rs');
});

// The body of `runSteerHeld`, up to the next top-level function.
function steerBody() {
	const at = PAGE.indexOf('async function runSteerHeld(');
	assert.ok(at > 0, 'no runSteerHeld');
	const end = PAGE.indexOf('\n\tasync function ', at + 10);
	return PAGE.slice(at, end > at ? end : at + 40000);
}

test('the page asks the engine for the turn and does not decide it again', () => {
	const b = steerBody();
	assert.match(b, /turnSpecFor\(/, 'runSteerHeld does not ask for the engine\'s TurnSpec');
	assert.match(PAGE, /Wasm\.turn_spec\(/, 'the page never calls Wasm.turn_spec');
	assert.doesNotMatch(b, /typeof presetArg === 'string'\) \? presetArg/, 'runSteerHeld still decides the preset itself');
	assert.doesNotMatch(b, /typeof depthArg === 'number'\) \? depthArg/, 'runSteerHeld still decides the depth itself');
	assert.doesNotMatch(b, /diamondCanRun\(f\.id\)/, 'runSteerHeld still asks the page whether the model can run');
	assert.doesNotMatch(b, /claimDaimon\(daimonApp\(f\.id\)\)/, 'the turn\'s client is built from a model the page chose again');
});

let ENGINE = null;
try {
	const mod = await import(join(APP, 'www', 'pkg', 'oxedyne_daimond.js'));
	mod.initSync({ module: readFileSync(join(APP, 'www', 'pkg', 'oxedyne_daimond_bg.wasm')) });
	ENGINE = mod;
} catch (e) { ENGINE = null; }

if (!ENGINE) {
	console.log('  SKIP the real engine rows: no www/pkg wasm here (VSET carries them)');
} else {
	test('ENGINE: turn_spec gives every golden send the same model, preset and depth', () => {
		assert.equal(typeof ENGINE.turn_spec, 'function', 'the built wasm has no turn_spec export');
		for (const s of GOLDEN.sends) {
			const got = JSON.parse(ENGINE.turn_spec(JSON.stringify(s.in)));
			assert.deepEqual(pick(got), pick(s.want), s.name);
			assert.equal(got.detached, !!s.want.detached, s.name + ' detached');
			assert.deepEqual(got.lease, s.want.lease || null, s.name + ' lease');
		}
	});
}
