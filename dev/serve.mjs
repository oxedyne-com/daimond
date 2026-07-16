// dev/serve.mjs — a local launcher for Daimond.
//
// Serves www/ on http://localhost:8777 (a secure context, so OPFS works) and
// reverse-proxies /api and /webhook to the gateway on 127.0.0.1:9002 — exactly
// what Steel does in production, so the session cookie is same-origin and every
// gateway-backed feature (read, credits, email) works locally. If the gateway
// is not running, those calls simply fail and the browser-only tiers carry on.
//
//   node dev/serve.mjs            # from the app root
//
// No dependencies; plain Node http.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..', 'www'));
const PORT = 8777;
const GATEWAY = { host: '127.0.0.1', port: 9002 };

const TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8', '.json': 'application/json',
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
	up.on('error', () => {
		res.writeHead(502, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'The gateway is not running on :9002. Start it, or use the browser-only features.' }));
	});
	req.pipe(up);
}

const server = http.createServer(async (req, res) => {
	const url = decodeURIComponent((req.url || '/').split('?')[0]);
	if (url.startsWith('/api/') || url.startsWith('/webhook/')) return proxy(req, res);

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

server.listen(PORT, 'localhost', () => {
	console.log(`Daimond dev server → http://localhost:${PORT}`);
	console.log(`  /api and /webhook proxy to the gateway on :${GATEWAY.port} (start it separately for read/email/credits)`);
});
