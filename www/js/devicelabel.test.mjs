/* ============================================================
   Test — what a device id is called when it is shown to a person (Q23).
   ------------------------------------------------------------
   `deviceLabelFor` lives inside `www/js/daimond.js`, which cannot be loaded
   whole in Node, so this lifts the real function bodies out of the source with
   the brace-balanced scan devicename.test.mjs uses, and runs them against
   stand-ins for presence, the roster and `localStorage`.

   The fault: a device neither beating nor in the roster (taken off the list,
   or never seen here) was shown as the first six characters of its id --
   "Allowed on 3fa9c1." A person never sees ids. Now:
     (a) a beating device is named by its beat, a rostered one by its line;
     (b) a device once named and since gone keeps the last name it had here;
     (c) one never named here is "another device", never a slice of its id;
     (d) the remembered names are bounded, and a renamed device's newest name
         wins.

   Run:  node www/js/devicelabel.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

function extractFn(src, name) {
	const start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return '';
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

function extractVar(src, name) {
	const re = new RegExp('\\n\\tvar ' + name + '\\s*=[^\\n]*;');
	const m = re.exec(src);
	return m ? m[0].trim() : '';
}

function main() {
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const en  = readFileSync(join(HERE, '..', 'i18n', 'en.js'), 'utf8');

	const parts = {
		DEVICE_ID_RE:       extractVar(src, 'DEVICE_ID_RE'),
		DEVICE_NAMES_KEY:   extractVar(src, 'DEVICE_NAMES_KEY'),
		DEVICE_NAMES_MAX:   extractVar(src, 'DEVICE_NAMES_MAX'),
		_deviceNames:       extractVar(src, '_deviceNames'),
		deviceNamesKnown:   extractFn(src, 'deviceNamesKnown'),
		rememberDeviceName: extractFn(src, 'rememberDeviceName'),
		deviceLabelFor:     extractFn(src, 'deviceLabelFor'),
	};
	const missing = Object.keys(parts).filter((k) => !parts[k]);
	check('the remembered-name store is in daimond.js', missing.length === 0, 'missing: ' + missing.join(', '));
	const lifted = Object.keys(parts).map((k) => parts[k]).join('\n');

	const m = /'devices\.another':\s*'([^']*)'/.exec(en);
	const ANOTHER = m ? m[1] : '';
	check('en.js names "another device" under devices.another', ANOTHER === 'another device', ANOTHER);

	const harness = `
		var _beats = {}, _reg = {}, _ls = {};
		var window = { DaimondPresence: { name: function (id) { return _beats[id] || ''; } } };
		var DaimondPresence = window.DaimondPresence;
		var localStorage = {
			getItem: function (k) { return Object.prototype.hasOwnProperty.call(_ls, k) ? _ls[k] : null; },
			setItem: function (k, v) { _ls[k] = String(v); },
			removeItem: function (k) { delete _ls[k]; },
		};
		function loadDevices() { return _reg; }
		function readJson(k, fb) { try { var v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } }
		function t(key) { return key === 'devices.another' ? ${JSON.stringify(ANOTHER || 'another device')} : key; }
		return {
			label: deviceLabelFor,
			beats: function (b) { _beats = b; },
			roster: function (r) { _reg = r; },
			stored: function () { return _ls; },
			reload: function () { _deviceNames = null; },
		};
	`;
	let api;
	try { api = new Function(lifted + harness)(); }
	catch (e) { check('the lifted functions run', false, e.message); }
	if (!api) { finish(); return; }

	const A = 'aaaaaaaaaaaaaaaa', B = 'bbbbbbbbbbbbbbbb', C = '3fa9c1d2e3f40516';

	console.log('\n(a) presence first, then the roster');
	api.beats({ [A]: 'Kitchen laptop' });
	api.roster({ [B]: { label: 'Office desktop', name: 'Chrome on Linux' } });
	check('a beating device is named by its beat', api.label(A) === 'Kitchen laptop', api.label(A));
	check('a rostered device is named by its label', api.label(B) === 'Office desktop', api.label(B));
	check('an empty id is still empty', api.label('') === '');

	console.log('\n(b) a device since gone keeps the last name it had here');
	api.beats({}); api.roster({});
	check('A, no longer beating, is still "Kitchen laptop"', api.label(A) === 'Kitchen laptop', api.label(A));
	check('B, off the roster, is still "Office desktop"', api.label(B) === 'Office desktop', api.label(B));
	api.reload();
	check('the name survives a reload (it is stored, not only held)', api.label(B) === 'Office desktop', api.label(B));

	console.log('\n(c) a device never named here');
	const c = api.label(C);
	check('is "another device"', c === (ANOTHER || 'another device'), c);
	check('never shows a slice of its id', c.indexOf(C.slice(0, 6)) === -1, c);

	console.log('\n(d) bounded, and the newest name wins');
	api.roster({ [B]: { label: 'Den desktop' } });
	api.label(B);
	api.roster({});
	check('a renamed device is remembered by its new name', api.label(B) === 'Den desktop', api.label(B));
	const many = {};
	for (let i = 0; i < 200; i++) many[(i.toString(16).padStart(4, '0')).repeat(4)] = { label: 'Dev ' + i };
	api.roster(many);
	Object.keys(many).forEach((id) => api.label(id));
	const raw = api.stored()['daimond-device-names'] || '{}';
	const n = Object.keys(JSON.parse(raw)).length;
	check('the remembered names are bounded', n > 0 && n <= 64, n);
	api.roster({});
	check('the newest-seen device is kept when the bound drops the oldest', api.label('00c700c700c700c7') === 'Dev 199', api.label('00c700c700c700c7'));
	check('an id that is not a device id is never stored', (api.label('not-an-id'), raw.indexOf('not-an-id') === -1));

	finish();
}

function finish() {
	console.log(checks + ' checks, ' + failures + ' failed');
	process.exit(failures ? 1 : 0);
}

main();
