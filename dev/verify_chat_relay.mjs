// gateway: live
// verify_chat_relay.mjs — the chat relay at /api/chat/relay answers through the real gateway binary
// (daimond-next RELAY.md §1, milestone 1).
//
// THE PROPERTY: a signed-in page's socket opens and its first frame is `hello` with its `conn` and the
// account's Kimberlites (none here); before the 101 the gateway refuses an upgrade with no session 401,
// one from another origin 403 and a page that names no device 400.
//
// RED on 325eb3df1, the base (no relay route: the page's socket never opens and no refusal is the
// relay's). The handler's own tests (gateway chat_relay_tests.rs) cover the frames; this proves the
// route, the config and the binary that ships.
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway (DAIMOND_GW_PORT).
//   node dev/verify_chat_relay.mjs

import http from 'node:http';

import { open, checker } from './harness.mjs';
import { GW_PORT } from './ports.mjs';

const { ok, bad, check } = checker();
const PATH = '/api/chat/relay';
const WAIT = 8000;

/// The gateway's answer to an upgrade sent straight to it: the status alone.
const upgradeStatus = (query, headers) => new Promise((resolve) => {
	const req = http.request({
		host: '127.0.0.1', port: GW_PORT, path: PATH + query, method: 'GET',
		headers: {
			Connection: 'Upgrade', Upgrade: 'websocket',
			'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
			...headers,
		},
	});
	const t = setTimeout(() => { req.destroy(); resolve('no answer'); }, WAIT);
	req.on('upgrade', (res, sock) => { clearTimeout(t); sock.destroy(); resolve(res.statusCode); });
	req.on('response', (res) => { clearTimeout(t); res.resume(); resolve(res.statusCode); });
	req.on('error', (e) => { clearTimeout(t); resolve('error ' + e.code); });
	req.end();
});

let s;
try {
	s = await open({});
	const origin = new URL(s.page.url()).origin;
	const cookie = (await s.page.context().cookies()).find((c) => c.name === 'daimond_gw_sess');
	check('[ctl] the page holds a gateway session', !!cookie);
	const sess = cookie ? 'daimond_gw_sess=' + cookie.value : '';
	const dev = await s.page.evaluate(() => window.DaimondIdentity.deviceId());

	const hello = await s.page.evaluate(({ path, dev, wait }) => new Promise((resolve) => {
		const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + path
			+ '?device=' + encodeURIComponent(dev));
		const t = setTimeout(() => { ws.close(); resolve({ none: 'no frame in ' + wait + ' ms' }); }, wait);
		ws.onmessage = (e) => { clearTimeout(t); ws.close(); resolve({ frame: String(e.data) }); };
		ws.onclose = (e) => { clearTimeout(t); resolve({ none: 'closed ' + e.code }); };
	}), { path: PATH, dev, wait: WAIT });
	let h = null;
	try { h = hello.frame ? JSON.parse(hello.frame) : null; } catch (e) { /* not JSON */ }
	check("the page's socket opens and its first frame is hello", !!h && h.t === 'hello', JSON.stringify(hello));
	check('hello carries its conn and the account has no Kimberlite here',
		!!h && typeof h.conn === 'string' && h.conn.length > 0 && Array.isArray(h.kims) && h.kims.length === 0,
		JSON.stringify(h));

	const st = {
		none:    await upgradeStatus('?device=' + dev, { Origin: origin }),
		evil:    await upgradeStatus('?device=' + dev, { Origin: 'https://evil.example', Cookie: sess }),
		nodev:   await upgradeStatus('', { Origin: origin, Cookie: sess }),
	};
	check('no session is refused 401 before the upgrade', st.none === 401, 'got ' + st.none);
	check('another origin is refused 403', st.evil === 403, 'got ' + st.evil);
	check('a page that names no device is refused 400', st.nodev === 400, 'got ' + st.nodev);
} catch (e) {
	check('verifier ran', false, String(e && e.stack || e).slice(0, 600));
} finally {
	try { await s?.close(); } catch (e) { /* gone */ }
	console.log('\n' + ok.length + ' passed, ' + bad.length + ' failed' + (bad.length ? ': ' + JSON.stringify(bad) : ''));
	process.exit(bad.length ? 1 : 0);
}
