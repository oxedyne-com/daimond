/* ============================================================
   Test — this device's derived name, with and without a hostname.
   ------------------------------------------------------------
   `deviceName`, `deviceSelfName`, `shortBrand`, `uaBrand`, `uaPlatform` and
   `applyHandHostname` live inside `www/js/daimond.js`, which cannot be loaded
   whole in Node: it is an ES module that imports the compiled wasm surface
   (see badge.test.mjs for the same limit). So this LIFTS the exact function
   bodies out of the real source with a brace-balanced scan -- not retyped,
   read from the file every run, so a change to the real functions is what
   this test exercises -- and runs them against a mocked `navigator` and a
   minimal `t()` matching the real English strings.

   `loadDevices` / `saveDevices` / `deviceId` are NOT lifted: `applyHandHostname`
   is tested against small stand-ins that satisfy the same contract (a plain
   object keyed by id), because the real roster store's own behaviour is
   `verify_devices.mjs`'s job.

   Covers:
     (a) no hostname: "<Brand> on <Platform>" / "<Brand> on <Platform> · tail",
         exactly as before this change;
     (b) a hostname: "<Brand> on <hostname>", no id tail;
     (c) "Google Chrome" / "Microsoft Edge" (what userAgentData actually
         hands back) shorten to "Chrome" / "Edge", never "Google ...";
     (d) Firefox and Safari, which have no userAgentData, go through the
         user-agent string path;
     (e) a hostname arriving updates an UNLABELLED line's name and bumps
         `seen`, changes nothing when the name already matches, and never
         touches a line the user has labelled.

   Run:  node www/js/devicename.test.mjs
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

/// Lifts `function name(...) { ... }` out of `src` by counting braces from
/// its opening one, so nesting inside the function (an object literal, a
/// `for` loop) cannot end the scan early.
function extractFn(src, name) {
	const start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) throw new Error('function not found in daimond.js: ' + name);
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

/// Lifts a single-line `var NAME = ...;` declaration.
function extractVar(src, name) {
	const re = new RegExp('\\n\\tvar ' + name + '\\s*=[^\\n]*;');
	const m = re.exec(src);
	if (!m) throw new Error('var not found in daimond.js: ' + name);
	return m[0].trim();
}

function main() {
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');

	const lifted = [
		extractVar(src, 'DEVICE_NAME_MAX'),
		extractVar(src, '_handHostname'),
		extractFn(src, 'uaBrand'),
		extractFn(src, 'uaPlatform'),
		extractFn(src, 'shortBrand'),
		extractFn(src, 'deviceName'),
		extractFn(src, 'deviceSelfName'),
		extractFn(src, 'applyHandHostname'),
	].join('\n');

	// Stand-ins for the roster store, satisfying `applyHandHostname`'s contract
	// (loadDevices() -> object keyed by id; saveDevices(reg) -> write it back;
	// deviceId() -> this device's id) without the real store behind them.
	const harness = `
		var _reg = {};
		function loadDevices() { return _reg; }
		function saveDevices(reg) { _reg = reg; return reg; }
		function deviceId() { return 'aaaaaaaaaaaaaaaa'; }
		return {
			deviceName: deviceName,
			deviceSelfName: deviceSelfName,
			applyHandHostname: applyHandHostname,
			setHost: function (h) { _handHostname = h || ''; },
			getHost: function () { return _handHostname; },
			setReg: function (r) { _reg = r; },
			getReg: function () { return _reg; },
		};
	`;

	// The real English strings these functions interpolate through `t()`.
	const STRINGS = {
		'devices.on_platform': '{brand} on {platform}',
		'devices.on_host':     '{brand} on {host}',
		'devices.unknown':     'This device',
	};
	function t(key, vars) {
		const s = STRINGS[key] || key;
		if (!vars) return s;
		return s.replace(/\{(\w+)\}/g, (whole, k) => (vars[k] != null ? String(vars[k]) : whole));
	}

	function build(navigator) {
		const fn = new Function('navigator', 't', lifted + '\n' + harness);
		return fn(navigator, t);
	}

	function chromeLinuxNav() {
		return {
			userAgentData: {
				platform: 'Linux',
				brands: [
					{ brand: 'Not;A Brand', version: '99' },
					{ brand: 'Chromium', version: '128' },
					{ brand: 'Google Chrome', version: '128' },
				],
			},
			userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
				+ 'Chrome/128.0.0.0 Safari/537.36',
		};
	}
	function edgeWindowsNav() {
		return {
			userAgentData: {
				platform: 'Windows',
				brands: [
					{ brand: 'Not;A Brand', version: '99' },
					{ brand: 'Chromium', version: '128' },
					{ brand: 'Microsoft Edge', version: '128' },
				],
			},
			userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
				+ '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
		};
	}
	function firefoxLinuxNav() {
		// Firefox never exposes userAgentData.
		return { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' };
	}
	function safariMacNav() {
		return {
			userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
				+ '(KHTML, like Gecko) Version/17.4 Safari/605.1.15',
		};
	}

	// ── (a) no hostname: today's format, unchanged ──────────────────
	{
		const m = build(chromeLinuxNav());
		check('Chrome/Linux with no hand names itself "Chrome on Linux"',
			m.deviceName() === 'Chrome on Linux', m.deviceName());
		check('the self line keeps its four-hex id tail with no hand',
			m.deviceSelfName('0123456789abcdef') === 'Chrome on Linux · cdef',
			m.deviceSelfName('0123456789abcdef'));
	}

	// ── (b) a hostname: no tail, the machine's real name ────────────
	{
		const m = build(chromeLinuxNav());
		m.setHost('argonaut');
		check('a known hostname names the browser and the machine',
			m.deviceName() === 'Chrome on argonaut', m.deviceName());
		check('a known hostname drops the id tail entirely',
			m.deviceSelfName('0123456789abcdef') === 'Chrome on argonaut',
			m.deviceSelfName('0123456789abcdef'));
	}

	// ── (c) userAgentData's own words are shortened, never "Google ..." ──
	{
		const m1 = build(chromeLinuxNav());
		check('"Google Chrome" (userAgentData\'s own brand) shortens to "Chrome"',
			m1.deviceName() === 'Chrome on Linux', m1.deviceName());
		const m2 = build(edgeWindowsNav());
		check('"Microsoft Edge" shortens to "Edge"',
			m2.deviceName() === 'Edge on Windows', m2.deviceName());
	}

	// ── (d) Firefox and Safari, no userAgentData at all ─────────────
	{
		const m = build(firefoxLinuxNav());
		check('Firefox (no userAgentData) is read from the UA string',
			m.deviceName() === 'Firefox on Linux', m.deviceName());
		m.setHost('gilgamesh');
		check('Firefox with a known hostname',
			m.deviceName() === 'Firefox on gilgamesh', m.deviceName());
	}
	{
		const m = build(safariMacNav());
		check('Safari (no userAgentData) is read from the UA string',
			m.deviceName() === 'Safari on macOS', m.deviceName());
	}

	// ── (e) the hand naming this device updates an unlabelled line ──
	{
		const m = build(chromeLinuxNav());
		m.setReg({ aaaaaaaaaaaaaaaa: {
			name: 'Chrome on Linux · aaaa', label: '', created: 1, namedAt: 0, seen: 1, build: '',
		} });
		m.applyHandHostname('argonaut');
		const line = m.getReg().aaaaaaaaaaaaaaaa;
		check('an unlabelled line is renamed once the hand says the hostname',
			line.name === 'Chrome on argonaut', line.name);
		check('renaming bumps `seen` so the fresher line wins a merge',
			line.seen > 1, line.seen);
	}
	{
		const m = build(chromeLinuxNav());
		m.setReg({ aaaaaaaaaaaaaaaa: {
			name: 'The Study Machine', label: 'The Study Machine', namedAt: 5, created: 1, seen: 1, build: '',
		} });
		m.applyHandHostname('argonaut');
		const line = m.getReg().aaaaaaaaaaaaaaaa;
		check('a label the user typed is never overwritten by the hostname',
			line.name === 'The Study Machine', line.name);
		check('a labelled line\'s `seen` is left alone',
			line.seen === 1, line.seen);
	}
	{
		// The same hostname arriving twice (a reconnect) changes nothing further.
		const m = build(chromeLinuxNav());
		m.setReg({ aaaaaaaaaaaaaaaa: {
			name: 'Chrome on argonaut', label: '', created: 1, namedAt: 0, seen: 1, build: '',
		} });
		m.applyHandHostname('argonaut');
		const line = m.getReg().aaaaaaaaaaaaaaaa;
		check('a hostname that already matches the stored name changes nothing',
			line.seen === 1, line.seen);
	}

	console.log(checks + ' checks, ' + failures + ' failed');
	process.exit(failures ? 1 : 0);
}

main();
