// dev/serve.mjs — a local launcher for Daimond.
//
// Serves www/ on http://localhost:8777 (a secure context, so OPFS works) and
// reverse-proxies /api and /webhook to THIS WORLD'S gateway — exactly what Steel
// does in production, so the session cookie is same-origin and every
// gateway-backed feature (read, credits, email) works locally. If this world has
// no gateway, those calls are REFUSED and the browser-only tiers carry on.
//
//   node dev/serve.mjs            # from the app root
//
// The port is `DAIMOND_PORT`, default 8777, and the gateway it proxies to is
// `DAIMOND_GW_PORT`.  Both are settable so that several agents can
// each hold a whole world -- server, mock provider and browser profile -- at once;
// with one fixed port only one browser harness could run at a time, and no agent
// could see its own work.  `dev/world.sh N` prints a matching set, and its
// gateway row is 9700 + N: a port of the world's own that nothing binds unless
// the world asked for a gateway.
//
// THE DEFAULT IS ONLY FOR A SERVER STARTED BY HAND. Under a world the variable is
// always set, and it is set to something that is not 9002 -- because 9002 is where
// a stray `devgw.sh` lands, and until 2026-08-25 every world proxied there, so
// which lane's account state a verifier read was whichever lane had a gateway up.
// `dev/world.sh` carries the measurement.
//
// No dependencies; plain Node http.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..', 'www'));
const PORT = Number(process.env.DAIMOND_PORT || 8777);
const GATEWAY = { host: '127.0.0.1', port: Number(process.env.DAIMOND_GW_PORT || 9002) };

const TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	// The vendored Typst compiler's glue is `.mjs`, and a dynamic import() refuses anything that
	// is not served as JavaScript. Without this the whole feature failed locally with "Failed to
	// fetch dynamically imported module" -- a MIME type, reported as a broken compiler.
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json',
	// The web app manifest. Steel already serves this extension correctly
	// (fe2o3_net::file), and without it here a locally served Daimond is not
	// installable -- which is exactly the thing that has to be testable locally.
	'.webmanifest': 'application/manifest+json',
	'.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
	'.woff2': 'font/woff2', '.map': 'application/json', '.pdf': 'application/pdf',
	'.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function proxy(req, res) {
	const opts = {
		host: GATEWAY.host, port: GATEWAY.port,
		method: req.method, path: req.url, headers: req.headers,
	};
	const up = http.request(opts, u => {
		res.writeHead(u.statusCode || 502, u.headers);
		u.pipe(res);
	});
	// THE REFUSAL NAMES THE PORT AND SAYS WHOSE IT IS. A caller that reads "the
	// gateway is not running" and knows only the phrase cannot tell an absent
	// gateway from one it was never entitled to reach, and the whole point of the
	// world's own port is that the second case no longer exists.
	up.on('error', () => {
		res.writeHead(502, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: `No gateway is running on 127.0.0.1:${GATEWAY.port}, `
			+ `which is this world's own. No other world's gateway is reachable from here: `
			+ `start one on this port (DAIMOND_GW_PORT), or use the browser-only features.` }));
	});
	req.pipe(up);
}

// A WebSocket upgrade on an /api path is relayed to the gateway and then left
// alone, which is what Steel's own proxy does (fe2o3_steel::srv::wsproxy): the
// handshake is forwarded verbatim so the gateway computes the accept value the
// browser checks, and after the 101 this hop copies bytes and parses nothing.
// Without it the sync wake channel could only be tested in production.
function proxyUpgrade(req, socket, head) {
	if (!(req.url || '').startsWith('/api/')) { socket.destroy(); return; }
	const up = http.request({
		host: GATEWAY.host, port: GATEWAY.port,
		method: req.method, path: req.url, headers: req.headers,
	});
	up.on('upgrade', (ures, usocket, uhead) => {
		const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`];
		for (let i = 0; i < ures.rawHeaders.length; i += 2) {
			lines.push(`${ures.rawHeaders[i]}: ${ures.rawHeaders[i + 1]}`);
		}
		socket.write(lines.join('\r\n') + '\r\n\r\n');
		if (uhead && uhead.length) socket.write(uhead);
		if (head && head.length) usocket.write(head);
		usocket.pipe(socket);
		socket.pipe(usocket);
		const shut = () => { usocket.destroy(); socket.destroy(); };
		usocket.on('error', shut); socket.on('error', shut);
		usocket.on('close', shut); socket.on('close', shut);
	});
	// The gateway answered without upgrading (a 401, say). Pass that on whole, so
	// the browser reports a refusal rather than a connection that vanished.
	up.on('response', ures => {
		socket.write(`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}\r\n`
			+ 'Content-Length: 0\r\nConnection: close\r\n\r\n');
		ures.resume();
		socket.end();
	});
	up.on('error', () => socket.destroy());
	up.end();
}

const server = http.createServer(async (req, res) => {
	const url = decodeURIComponent((req.url || '/').split('?')[0]);
	if (url.startsWith('/api/') || url.startsWith('/webhook/')) return proxy(req, res);

	// WHICH TREE THIS SERVES, so a caller can identify the process holding the
	// port instead of trusting that it is the one it started.
	//
	// `dev/world.sh --up` leaves an already-bound port alone, which is right when
	// a person is sharing a world and was ruinous on 2026-08-17: a gate of
	// 99c838e found world 9 still held by an interrupted gate of b536d60, said
	// "already serving, left alone", and spent two hours driving a browser at
	// ANOTHER COMMIT'S FILES while reporting the result against 99c838e. Nothing
	// in the run could have noticed, because nothing could ask. Now it can.
	//
	// `__` so it can never collide with a served file, and dev-only: this server
	// is not what runs in production.
	if (url === '/__world') {
		const body = JSON.stringify({ root: ROOT, port: PORT, gateway: GATEWAY.port, pid: process.pid });
		res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		return res.end(body);
	}

	let path = normalize(join(ROOT, url === '/' ? '/index.html' : url));
	if (!path.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
	try {
		const s = await stat(path);
		if (s.isDirectory()) path = join(path, 'index.html');
		const body = await readFile(path);
		res.writeHead(200, {
			'content-type': TYPES[extname(path)] || 'application/octet-stream',
			// Cross-origin isolation is not needed, but no-cache keeps you on the
			// latest build while you test.
			'cache-control': 'no-cache',
		});
		res.end(body);
	} catch (e) {
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('Not found: ' + url);
	}
});

server.on('upgrade', proxyUpgrade);

server.listen(PORT, 'localhost', () => {
	console.log(`Daimond dev server → http://localhost:${PORT}`);
	console.log(`  /api and /webhook proxy to the gateway on :${GATEWAY.port} (start it separately for read/email/credits)`);
});
