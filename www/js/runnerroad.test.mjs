// www/js/runnerroad.test.mjs -- RUNNER-ROAD (owner, 25 Oct): his Nancy turn failed on the runner,
// from a DNS fault inside its run child, and the page said "Could not reach that endpoint. Check
// the base URL in Settings, and your connection." -- the TAB's sentence, sending him to his own
// Settings for a fault on the runner.
//
// THE RULE: where a failure happened is DATA, the row's `ranOn` (the device that ran the turn,
// stamped by the runner on its final row), never guessed from the words. A road failure on another
// device reads "<runner> can't reach <host>" as a seat-reason label, its sentence on hover or tap,
// through the one renderer `seatReason`; a road failure here keeps the tab's own text.
//
//     node www/js/runnerroad.test.mjs

import vm from 'node:vm';
import { source, lift } from './testlift.mjs';

let checks = 0, failures = 0;
function check(name, ok, detail) {
	checks++;
	if (!ok) failures++;
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  (' + detail + ')'));
}

const src = source('daimond.js');
const L = lift(src, ['runnerRoad', 'roadHost', 'seatReason', 'isUnreachable', 'stripAnsi'],
	['CLIENT_ROAD', 'BROWSER_ROAD']);
check('the runner-road reader and its parts are there', L.missing.length === 0, L.missing.join());

if (!L.missing.length) {
	const ctx = vm.createContext({ t: (k, o) => k + (o ? JSON.stringify(o) : ''),
		selfDeviceId: () => 'tab', deviceLabelFor: (id) => (id === 'rn' ? 'argonaut' : '') });
	ctx.window = ctx;
	const api = vm.runInContext(L.body + ';({runnerRoad, roadHost})', ctx);
	// The runner's own sentence, as kimberlite's final row carries it (src/llm.rs `crossed`).
	const dns = 'LLM: could not reach openrouter.ai: LLM: TCP connect to openrouter.ai:443 failed. '
		+ 'failed to lookup address information: Temporary failure in name resolution';
	const row = (o) => Object.assign({ role: 'error_log', content: dns }, o);

	const r = api.runnerRoad(row({ ranOn: 'rn' }));
	check('a road failure on the runner names the runner and the host', !!r
		&& r.label === 'seat.label_runner_road{"name":"argonaut","host":"openrouter.ai"}'
		&& r.why === 'seat.why_runner_road{"name":"argonaut","host":"openrouter.ai"}', JSON.stringify(r));
	check('a road failure here keeps the tab\'s text', api.runnerRoad(row({ ranOn: 'tab' })) === null
		&& api.runnerRoad(row({})) === null);
	check('a runner failure that is not the road is not called one',
		api.runnerRoad(row({ ranOn: 'rn', content: 'LLM: HTTP error: 401 Unauthorized' })) === null);
	const b = api.runnerRoad(row({ ranOn: 'rn',
		content: 'Could not reach that endpoint. Check the base URL in Settings, and your connection.' }));
	check('a browser runner\'s road failure, with no host, still names the runner',
		!!b && b.label === 'seat.label_runner_road_any{"name":"argonaut"}', JSON.stringify(b));
	const u = api.runnerRoad(row({ ranOn: 'zz' }));
	check('an unnamed runner is "another device", never this one or blank', !!u && u.label.indexOf('devices.another') > 0, JSON.stringify(u));
	check('only an error row is read', api.runnerRoad({ role: 'assistant', ranOn: 'rn', content: dns }) === null
		&& api.runnerRoad(null) === null);
	for (const [s, h] of [[dns, 'openrouter.ai'], ['could not reach 127.0.0.1:1', '127.0.0.1'],
		['TLS handshake with api.anthropic.com failed', 'api.anthropic.com'],
		['could not reach the provider', ''], ['Could not reach that endpoint.', '']]) {
		check('roadHost(' + JSON.stringify(s.slice(0, 40)) + ') = ' + JSON.stringify(h), api.roadHost(s) === h, api.roadHost(s));
	}
}

// THE WIRING: the history draws an error row through `appendError` WITH the row, `appendError`
// asks `runnerRoad` first, and every error row a turn writes is stamped `ranOn`, the device it failed on.
const ae = /function appendError\(msg, m\) \{[\s\S]*?\n\t\}/.exec(src);
check('appendError reads the row\'s origin', !!ae && /runnerRoad\(m\)/.test(ae[0]), ae ? '' : 'no appendError(msg, m)');
check('the history passes the row', /m\.role === 'error_log'\) \{ appendError\(m\.content, m\); \}/.test(src));
const stamped = src.match(/role: (?:'error_log'|failRole\(e\)), content: friendlyError\([^)]*\)\)?,[^\n]*ranOn: selfDeviceId\(\)/g) || [];
check('a runner\'s own error rows carry ranOn', stamped.length === 2, stamped.length + ' stamped');

console.log(checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
