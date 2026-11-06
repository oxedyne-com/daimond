// www/js/seatkimberlite.test.mjs -- SEAT-LABEL (owner, 06 Nov 2026, D-20261105-01): "below the input
// box we have "Here | <Kimberlite host>" in my case argonaut. That should be Kimberlite on all devices".
//
// The REAL renderSeatSwitch (and placeText, the Doc panel's Compile/Publish words) over a
// Kimberlite runner on host "argonaut": the switch reads "Kimberlite", its hover "Kimberlite on
// argonaut"; a browser desktop keeps its own name. THE GATE: the seat label is never the host,
// and every locale names it "Kimberlite" (a proper noun) with a {host} hover.
//
//     node www/js/seatkimberlite.test.mjs        (MM_SRC_REV=<sha> runs it against that commit)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { source, liftFn } from './testlift.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let checks = 0, failures = 0;
function check(name, ok, detail) {
	checks++; if (!ok) failures++;
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '  (' + detail + ')'));
}

const SRC = source('daimond.js');
const EN = {};
{
	const ctx = vm.createContext({}); ctx.window = ctx;
	ctx.DaimondI18n = { register: (_l, t) => Object.assign(EN, t), add: (_l, t) => Object.assign(EN, t) };
	vm.runInContext(readFileSync(join(HERE, '..', 'i18n', 'en.js'), 'utf8'), ctx);
}
function t(k, v) {
	let s = EN[k] != null ? EN[k] : k;
	for (const n of Object.keys(v || {})) s = s.split('{' + n + '}').join(String(v[n]));
	return s;
}
function el() {
	return { textContent: '', title: '', hidden: true, dataset: {}, attrs: {},
		setAttribute(k, v) { this.attrs[k] = String(v); } };
}

function world(kind) {
	const els = { 'seat-switch': el(), 'seat-here': el(), 'seat-runner': el() };
	const presence = { kdu5d0t4wuaax7f6: { kind, name: 'argonaut' } };
	const ctx = vm.createContext({
		t, console, Object, String, Date,
		document: { getElementById: (id) => els[id] || null },
		current: { id: 'c1' },
		window: null,
		DaimondPresence: { snapshot: () => presence },
		seatSwitchFor: () => ({ runner: { deviceId: 'kdu5d0t4wuaax7f6', label: 'argonaut' }, choice: 'runner', until: 0 }),
		deviceLabelFor: () => 'argonaut',
		armSeatSwitchTimer: () => {}, loadDevices: () => ({ a: 1, b: 1 }),
		_seatWhyOpen: '',
	});
	ctx.window = ctx;
	const names = ['isKimberliteSeat', 'seatRunnerLabel', 'seatReason', 'seatWhyKey', 'renderSeatSwitch', 'placeText'];
	vm.runInContext(names.map((n) => liftFn(SRC, n)).join('\n'), ctx);
	return { ctx, els };
}

// ── the switch ──
{
	const { ctx, els } = world('runner');
	ctx.renderSeatSwitch();
	const run = els['seat-runner'];
	check('Kimberlite runner on argonaut: the switch reads "Kimberlite"', run.textContent === 'Kimberlite', run.textContent);
	check('its hover reads "Kimberlite on argonaut"', run.title === 'Kimberlite on argonaut', run.title);
	check('GATE: the seat label never shows the host name', !/argonaut/.test(run.textContent), run.textContent);
	check('the switch is shown', els['seat-switch'].hidden === false);
	// The Doc panel's buttons are a seat choice too.
	const pt = ctx.placeText ? ctx.placeText({ key: 'files.compile_on', titleKey: '', where: 'runner',
		deviceId: 'kdu5d0t4wuaax7f6', label: 'argonaut', can: true }) : null;
	check('the Doc panel reads "Compile on Kimberlite"', pt && pt.text === 'Compile on Kimberlite', pt && pt.text);
}
{
	const { ctx, els } = world('desktop');
	ctx.renderSeatSwitch();
	check('a browser desktop (not a Kimberlite) keeps its own name', els['seat-runner'].textContent === 'argonaut',
		els['seat-runner'].textContent);
}

// ── GATE: every locale names the seat "Kimberlite", the host only on the hover ──
for (const f of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans']) {
	const s = readFileSync(join(HERE, '..', 'i18n', f + '.js'), 'utf8');
	const a = /\n\t'seat\.kimberlite':\s*'([^']*)'/.exec(s), b = /\n\t'seat\.kimberlite_on':\s*'([^']*)'/.exec(s);
	check(f + ': seat.kimberlite is "Kimberlite"', !!a && a[1] === 'Kimberlite', a && a[1]);
	check(f + ': seat.kimberlite_on names Kimberlite and {host}', !!b && /Kimberlite/.test(b[1]) && /\{host\}/.test(b[1]), b && b[1]);
}
// ── GATE: the switch's label is drawn through seatRunnerLabel only, never straight from a host name ──
{
	const r = liftFn(SRC, 'renderSeatSwitch');
	check('renderSeatSwitch sets the runner label only from seatRunnerLabel',
		/run\.textContent = seatTxt\.text;/.test(r) && !/run\.textContent = deviceLabelFor/.test(r));
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
