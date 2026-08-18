// verify_mailtunnel.mjs — the blind mail tunnel, from the browser's end.
//
// TLS terminates in the page (`src/wasm/mailtls.rs`) and the gateway forwards
// opaque bytes, so the mail password never leaves the browser. This drives the
// client half of that — `www/js/mail.js`'s tunnel section — in a real browser,
// against a real provider's certificate and a real bad one.
//
// WHAT IT PROVES, and what each proof is worth:
//
//   1. the shipped bundle is the verify-always build, not the testing one. A
//      handshake that succeeds because verification was off is not a handshake;
//   2. a tunnel reaches `open` against imap.gmail.com:993 — an EXTERNAL oracle,
//      because the certificate chain and the root store are both somebody else's;
//   3. a self-signed certificate becomes `failed` with rustls's own discriminant,
//      inside a round trip and not by timing out. That is the defect the wasm was
//      fixed for once already: `state` reads `failed` first because rustls
//      abandons a handshake mid-flight, so a client polling for `open` alone hangs;
//   4. each close-code PAIR gets its own sentence. The PAIR, because 4403 and 4429
//      are overloaded and the reason word is the only discriminator — and `host`
//      against `unresolved` is the pair that once let the gateway's own test pass
//      with the check it was named after switched off;
//   5. THE ONE THIS FEATURE EXISTS FOR: a secret written into a tunnel appears in
//      no request the browser makes and in no byte the relay forwards. Recorded
//      first, greped second, and each grep shown to go red.
//
// WHAT IT DOES NOT PROVE. `mail_imap` and `mail_smtp_send` do not exist, so no
// IMAP conversation happens here and mail still travels the old bridge. The
// password check below writes a marker through `tun.write` — the same door the
// protocol layer will use — which proves the transport encrypts what is written to
// it. It cannot prove that the unwritten protocol layer writes the password there
// rather than somewhere else. See the seam in mail.js.
//
//   node dev/verify_mailtunnel.mjs
//
// Brings up its own world: a dev server on :8785 whose /api hop points at a stub
// relay on :9421 rather than the gateway. The relay is a DUMB PIPE, as the gateway
// is: it dials plain TCP and copies bytes, so the TLS is genuinely end to end.
// Needs outbound network for the real-provider checks, which are reported as
// skipped rather than passed when it is absent.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP  = path.resolve(HERE, '..');
// NOT /tmp: tmpfs pages are RAM charged to whoever wrote them, and this lane's
// artefacts go under its own named subdirectory of a shared root it does not own.
const WORK = path.join(os.homedir(), '.cache', 'daimond', 'laneC');

const PORT      = 8785;   // the dev server for this run
const RELAY     = 9421;   // the stub /api hop the dev server proxies to
const TLS_FIX   = 8796;   // a local TLS server with a self-signed certificate
const CLEAR_FIX = 8797;   // a local plain server that answers nothing
const CA_FIX    = 8798;   // a local TLS server presenting a CA as its own leaf

const ok = [], bad = [], skip = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (name, why) => {
	skip.push(name);
	console.log('  skip  ' + name + (why ? ' — ' + why : ''));
};

fs.mkdirSync(WORK, { recursive: true });

// ── The fixtures ────────────────────────────────────────────────────────────

/// Two bad certificates, made locally so the refusal checks need no network.
///
/// TWO, and the second one is the reason this function is longer than it was. The
/// obvious fixture — `openssl req -x509` — is a CA certificate, because that is what
/// `-x509` writes, and rustls refuses it as `CaUsedAsEndEntity` rather than
/// `UnknownIssuer`. So the check named for an untrusted ISSUER was passing on a
/// different refusal entirely and its sentence assertion failed, which is how the
/// mistake was found. `leaf` is a real end-entity certificate signed by a CA no root
/// store carries, which is the case a user actually meets; `ca` keeps the other one,
/// because it is a real refusal class too and it must still reach a sentence.
function badCerts() {
	const f = (n) => path.join(WORK, n);
	if (!fs.existsSync(f('leaf.crt'))) {
		const ext = f('leaf.ext');
		fs.writeFileSync(ext, 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\n');
		execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
			'-keyout', f('ca.key'), '-out', f('ca.crt'), '-days', '30',
			'-subj', '/CN=laneC-test-ca'], { stdio: 'ignore' });
		execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes',
			'-keyout', f('leaf.key'), '-out', f('leaf.csr'),
			'-subj', '/CN=localhost'], { stdio: 'ignore' });
		execFileSync('openssl', ['x509', '-req', '-in', f('leaf.csr'),
			'-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-days', '30',
			'-extfile', ext, '-out', f('leaf.crt')], { stdio: 'ignore' });
	}
	return {
		leaf: { key: fs.readFileSync(f('leaf.key')), cert: fs.readFileSync(f('leaf.crt')) },
		ca:   { key: fs.readFileSync(f('ca.key')),   cert: fs.readFileSync(f('ca.crt')) },
	};
}

/// Where a host name the page asks for actually goes, and what happens instead of
/// a dial.
///
/// Keyed on the host because that is all a client may put in the query, and it
/// keeps each case's intent in the test rather than in a mutable mode on the
/// relay: two cases can never be reading each other's state.
const ROUTES = {
	// Refusals. Each is a DISTINCT code/reason pair, so no case can pass by
	// walking another's path.
	'c4401.test':      { close: [4401, 'auth'] },
	'c4402.test':      { close: [4402, 'pro'] },
	'c4403port.test':  { close: [4403, 'port'] },
	'c4403host.test':  { close: [4403, 'host'] },
	'c4403unres.test': { close: [4403, 'unresolved'] },
	'c4429cred.test':  { close: [4429, 'credits'] },
	'c4429conc.test':  { close: [4429, 'concurrent'] },
	'c1009.test':      { close: [1009, 'toobig'] },
	'c1013.test':      { close: [1013, 'unreachable'] },
	'c1000done.test':  { close: [1000, 'done'] },
	'c1000idle.test':  { close: [1000, 'idle'] },
	// A local TLS server whose certificate is signed by a CA no root store carries.
	'localhost':       { dial: ['127.0.0.1', TLS_FIX] },
	// And one presenting a CA certificate as its own leaf, which is a different
	// refusal and must still reach a sentence rather than a raw discriminant.
	'ca-as-leaf.test': { dial: ['127.0.0.1', CA_FIX] },
	// A plain server, for the clear phase of a STARTTLS tunnel: whatever is
	// written before the promotion goes across in the open, which is what makes
	// the ciphertext grep below able to go red.
	'clear.test':      { dial: ['127.0.0.1', CLEAR_FIX] },
	// The real thing, and the external oracle: a certificate chain and a root
	// store that are both somebody else's.
	'imap.gmail.com':  { dial: ['imap.gmail.com', 993] },
	// The same socket under a name the certificate does not carry.
	'wrongname.test':  { dial: ['imap.gmail.com', 993] },
	// A certificate from a real issuer that expired years ago. The browser's own
	// clock is the expiry oracle here, which mailtls.rs discloses.
	'expired.badssl.com': { dial: ['expired.badssl.com', 443] },
};

/// Every byte the relay forwarded from the browser towards a provider, which is
/// exactly what the gateway would hold. The recorder for check 5.
let upBytes = [];

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/// One WebSocket frame out, unmasked, as a server sends them.
function frame(opcode, payload) {
	const len = payload.length;
	let head;
	if (len < 126)        { head = Buffer.from([0x80 | opcode, len]); }
	else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
	else                  { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
	return Buffer.concat([head, payload]);
}

/// Pull whole frames out of a growing buffer. Client frames are masked.
function frames(buf) {
	const out = [];
	let i = 0;
	for (;;) {
		if (buf.length - i < 2) break;
		const op = buf[i] & 0x0f, masked = (buf[i + 1] & 0x80) !== 0;
		let len = buf[i + 1] & 0x7f, j = i + 2;
		if (len === 126) { if (buf.length - j < 2) break; len = buf.readUInt16BE(j); j += 2; }
		else if (len === 127) { if (buf.length - j < 8) break; len = Number(buf.readBigUInt64BE(j)); j += 8; }
		let mask = null;
		if (masked) { if (buf.length - j < 4) break; mask = buf.subarray(j, j + 4); j += 4; }
		if (buf.length - j < len) break;
		const body = Buffer.from(buf.subarray(j, j + len));
		if (mask) for (let k = 0; k < body.length; k++) body[k] ^= mask[k & 3];
		out.push({ op, body });
		i = j + len;
	}
	return { got: out, rest: buf.subarray(i) };
}

/// The stub /api hop: a WebSocket-to-TCP pipe on the tunnel path, and a
/// permissive stand-in for the gateway's other routes so the app boots.
function startRelay() {
	const srv = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		// Deliberately generous: this file is not testing the gateway's routes, and
		// a bootstrap that fails would leave the panel saying so instead of saying
		// what the tunnel said.
		res.end(JSON.stringify({ ok: true, credits_minor: 100000, currency: 'usd',
			unlocked: true, max_accounts: 10, accounts: [] }));
	});
	srv.on('upgrade', (req, sock) => {
		const u    = new URL(req.url, 'http://x');
		const host = u.searchParams.get('host') || '';
		const key  = req.headers['sec-websocket-key'] || '';
		const acc  = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
		sock.write('HTTP/1.1 101 Switching Protocols\r\n'
			+ 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
			+ 'Sec-WebSocket-Accept: ' + acc + '\r\n\r\n');
		const route = ROUTES[host];
		if (!route) { sock.end(frame(8, Buffer.from([0x0f, 0xa3, ...Buffer.from('host')]))); return; }
		if (route.close) {
			const [code, reason] = route.close;
			const p = Buffer.alloc(2 + Buffer.byteLength(reason));
			p.writeUInt16BE(code, 0);
			p.write(reason, 2);
			sock.end(frame(8, p));
			return;
		}
		const far = net.connect(route.dial[1], route.dial[0]);
		far.on('error', () => sock.destroy());
		far.on('data', (d) => { try { sock.write(frame(2, d)); } catch (e) { /* gone */ } });
		far.on('close', () => sock.destroy());
		let buf = Buffer.alloc(0);
		sock.on('data', (d) => {
			buf = Buffer.concat([buf, d]);
			const { got, rest } = frames(buf);
			buf = rest;
			for (const f of got) {
				if (f.op === 8) { far.destroy(); sock.destroy(); return; }
				if (f.op !== 2) continue;
				// The recorder. This is the gateway's whole view of the payload.
				upBytes.push(f.body);
				far.write(f.body);
			}
		});
		sock.on('error', () => far.destroy());
		sock.on('close', () => far.destroy());
	});
	return new Promise((res) => srv.listen(RELAY, '127.0.0.1', () => res(srv)));
}

function startFixtures() {
	const certs = badCerts();
	const greet = (sock) => sock.write('* OK fixture ready\r\n');
	const lsrv  = tls.createServer(certs.leaf, greet);
	const asrv  = tls.createServer(certs.ca, greet);
	const csrv  = net.createServer(() => { /* accept and say nothing */ });
	return Promise.all([
		new Promise((r) => lsrv.listen(TLS_FIX, '127.0.0.1', () => r(lsrv))),
		new Promise((r) => asrv.listen(CA_FIX, '127.0.0.1', () => r(asrv))),
		new Promise((r) => csrv.listen(CLEAR_FIX, '127.0.0.1', () => r(csrv))),
	]);
}

function startServer() {
	const p = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], {
		cwd: APP,
		env: { ...process.env, DAIMOND_PORT: String(PORT), DAIMOND_GW_PORT: String(RELAY) },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return new Promise((res, rej) => {
		const t = setTimeout(() => rej(new Error('the dev server never bound :' + PORT)), 8000);
		p.stdout.on('data', (d) => {
			if (String(d).includes('http://localhost:' + PORT)) { clearTimeout(t); res(p); }
		});
	});
}

/// Is a real host reachable at all? The real-provider checks are skipped rather
/// than failed when it is not, because "no network" is not "rustls is broken".
function reachable(host, port) {
	return new Promise((res) => {
		const s = net.connect({ host, port });
		const done = (v) => { try { s.destroy(); } catch (e) {} res(v); };
		s.setTimeout(6000);
		s.on('connect', () => done(true));
		s.on('error', () => done(false));
		s.on('timeout', () => done(false));
	});
}

// ── The run ─────────────────────────────────────────────────────────────────

const relay = await startRelay();
const fixes = await startFixtures();
const serve = await startServer();

// The recorder, armed BEFORE anything navigates.
//
// Every request the browser makes, and every WebSocket URL and frame it sends. The
// harness's `route` hook runs BEFORE the navigation, which is the whole reason it
// exists: a recorder attached after the traffic reports silence, and silence reads
// as absence.
const seen = { reqs: [], sockets: [], sent: [] };
const record = (pg) => {
	pg.on('request', (r) => {
		let post = '';
		try { post = r.postData() || ''; } catch (e) { post = ''; }
		seen.reqs.push({ url: r.url(), method: r.method(), post });
	});
	pg.on('websocket', (w) => {
		seen.sockets.push(w.url());
		w.on('framesent', (f) => {
			try { seen.sent.push(Buffer.from(f.payload)); } catch (e) { /* text frame */ }
		});
	});
};

// Through the harness, so the passphrase gate is passed and the wasm is instantiated
// the way the app does it. `connect: false` because nothing here needs a model. The
// env is set before the import because harness.mjs reads it at load.
process.env.DAIMOND_PORT    = String(PORT);
process.env.DAIMOND_APP     = 'http://localhost:' + PORT;
process.env.DAIMOND_SCRATCH = WORK;
const { open } = await import('./harness.mjs');
const s = await open({ name: 'mailtunnel', connect: false, route: record });
const { page, errs } = s;

try {
	await page.waitForFunction(() => !!window.DaimondMail && !!window.DaimondI18n,
		null, { timeout: 20000 });

	// ── 1. The bundle is the one that always verifies ──────────────────
	const flavour = await page.evaluate(() => window.DaimondMail.flavour());
	check('the shipped bundle is the verify-always build, not the testing one',
		flavour === 'mailtls/verify-always', flavour);
	check('mail.js offers the tunnel it is supposed to own',
		await page.evaluate(() => typeof window.DaimondMail.tunnel === 'function'));

	// The page's own driver, so every check below runs the SAME `openTunnel` the
	// sync path will call rather than a simpler one written for the test.
	const drive = async (spec, plan) => page.evaluate(async ([spec, plan]) => {
		const out = { err: '', state: '', version: '', fault: '', closed: null };
		let tun;
		try {
			tun = await window.DaimondMail.tunnel(spec);
		} catch (e) {
			out.err = e.message;
			return out;
		}
		try {
			await tun.ready(plan.want || 'open');
			out.state   = tun.state();
			out.version = tun.version();
			if (plan.write) tun.write(new TextEncoder().encode(plan.write));
			// A beat, so what was written reaches the socket before it is closed.
			if (plan.write) await new Promise((r) => setTimeout(r, 400));
		} catch (e) {
			out.err = e.message;
		}
		out.state  = out.state || tun.state();
		out.fault  = tun.fault();
		out.closed = tun.closed();
		tun.close();
		return out;
	}, [spec, plan]);

	// ── 2. A real provider, which is somebody else's certificate ───────
	const netUp = await reachable('imap.gmail.com', 993);
	if (!netUp) {
		note('a tunnel reaches `open` against imap.gmail.com:993', 'no outbound network');
		note('a certificate for the wrong host is refused by name', 'no outbound network');
	} else {
		const good = await drive({ host: 'imap.gmail.com', port: 993, security: 'tls' }, {});
		check('a tunnel reaches `open` against imap.gmail.com:993, verified against the bundled roots',
			good.state === 'open' && !good.err, `state=${good.state} version=${good.version} err=${good.err}`);
		check('and it negotiated a real TLS version rather than nothing',
			/TLSv1_[23]/.test(good.version || ''), good.version);

		// ── 3a. The same socket under a name the certificate lacks ──
		const wrong = await drive({ host: 'wrongname.test', port: 993, security: 'tls' }, {});
		check('a certificate valid for another host is refused, and refused BY NAME',
			wrong.state === 'failed' && /NotValidForName/.test(wrong.fault || ''),
			`state=${wrong.state} fault=${wrong.fault}`);
		check('and the refusal reaches the user as the wrong-host sentence',
			/different server/.test(wrong.err) && wrong.err.includes('wrongname.test'),
			wrong.err.slice(0, 90));
	}

	// ── 3b. A certificate from an untrusted issuer, no network needed ──
	const t0   = Date.now();
	const self = await drive({ host: 'localhost', port: TLS_FIX, security: 'tls' }, {});
	const took = Date.now() - t0;
	check('a certificate from an issuer no root store carries is refused',
		self.state === 'failed', `state=${self.state} fault=${self.fault}`);
	check('and the fault is rustls’s own discriminant, not a guess',
		/UnknownIssuer/.test(self.fault || ''), self.fault);
	check('and the refusal reaches the user as the untrusted-issuer sentence',
		/issuer/.test(self.err), self.err.slice(0, 90));
	// A HANG is the failure this is really about: rustls abandons a handshake
	// mid-flight, so a client that polled for `open` alone would never return. The
	// bound is deliberately far below the 20s handshake deadline — a check that
	// allowed 19s would pass on a client that was in fact waiting for the deadline.
	check('and it comes back inside a round trip rather than on the handshake deadline',
		took < 3000, `${took}ms, deadline is 20000ms`);

	// ── 3c. A CA certificate offered as a leaf, which is a DIFFERENT class ──
	//
	// Here because it is what `openssl req -x509` produces, so it is what anybody
	// pointing this at a hand-made fixture will meet — and because it proves the
	// generic arm of `certWords` reaches a sentence. Without it that arm was dead
	// code that nothing had ever run.
	const caLeaf = await drive({ host: 'ca-as-leaf.test', port: CA_FIX, security: 'tls' }, {});
	check('a CA certificate offered as a leaf is refused too',
		caLeaf.state === 'failed' && /CaUsedAsEndEntity/.test(caLeaf.fault || ''),
		`state=${caLeaf.state} fault=${caLeaf.fault}`);
	check('and a refusal class with no sentence of its own still gets the general one, carrying the fault',
		/could not verify/.test(caLeaf.err) && caLeaf.err.includes('CaUsedAsEndEntity'),
		caLeaf.err.slice(0, 100));

	// ── 3d. An expired certificate from a real issuer ──────────────────
	if (await reachable('expired.badssl.com', 443)) {
		const exp = await drive({ host: 'expired.badssl.com', port: 443, security: 'tls' }, {});
		check('an expired certificate is refused, and refused AS expired',
			exp.state === 'failed' && /Expired/.test(exp.fault || ''),
			`state=${exp.state} fault=${exp.fault}`);
		check('and the expiry sentence mentions this machine’s clock, which is the oracle',
			/clock/.test(exp.err), exp.err.slice(0, 90));
	} else {
		note('an expired certificate is refused, and refused AS expired', 'no outbound network');
		note('and the expiry sentence mentions this machine’s clock', 'no outbound network');
	}

	// ── 4. Every close pair gets its own sentence ──────────────────────
	//
	// THE PAIR, not the code. Each case names a unique pair, so a case cannot pass
	// by walking another's path — which is how the gateway's own unbound-host test
	// once passed with the binding check switched off.
	const pairs = [
		['c4401.test',      4401, 'auth',       /signed this device out/],
		['c4402.test',      4402, 'pro',        /part of Pro/],
		['c4403port.test',  4403, 'port',       /993, 143, 465 and 587/],
		['c4403host.test',  4403, 'host',       /has bound/],
		['c4403unres.test', 4403, 'unresolved', /does not resolve/],
		['c4429cred.test',  4429, 'credits',    /credits ran out/],
		['c4429conc.test',  4429, 'concurrent', /four mail connections/],
		['c1009.test',      1009, 'toobig',     /more at once than the gateway/],
		['c1013.test',      1013, 'unreachable', /could not be reached/],
		['c1000done.test',  1000, 'done',       /ended the connection/],
		['c1000idle.test',  1000, 'idle',       /stopped answering/],
	];
	const said = new Map();
	for (const [host, code, reason, want] of pairs) {
		const r = await drive({ host, port: 993, security: 'tls' }, {});
		check(`close ${code}/${reason} says its own sentence`,
			want.test(r.err), `${code}/${reason} — ${r.err.slice(0, 90)}`);
		said.set(`${code}/${reason}`, r.err);
	}
	check('and no two of the eleven pairs say the same thing',
		new Set(said.values()).size === said.size,
		`${new Set(said.values()).size} distinct of ${said.size}`);
	// The overloaded codes, asserted as the thing that matters: the halves differ.
	check('4403 host and 4403 unresolved are DIFFERENT sentences, which is the pair that hid a dead check',
		said.get('4403/host') !== said.get('4403/unresolved')
			&& !!said.get('4403/host') && !!said.get('4403/unresolved'));
	check('4429 credits and 4429 concurrent are different sentences too',
		said.get('4429/credits') !== said.get('4429/concurrent')
			&& !!said.get('4429/credits'));

	// ── 5. The password appears nowhere the browser sends it ───────────
	//
	// The assertion this whole feature exists for. A marker is written into an OPEN
	// tunnel through `tun.write`, which is the door the protocol layer will use.
	const SECRET = 'laneC-app-password-' + crypto.randomBytes(6).toString('hex');
	let ciphered = null;
	if (netUp) {
		upBytes = [];
		seen.sent = [];
		ciphered = await drive({ host: 'imap.gmail.com', port: 993, security: 'tls' },
			{ write: SECRET });
		const relayHeld  = Buffer.concat(upBytes);
		const browserPut = Buffer.concat(seen.sent);
		check('the secret was actually written down a tunnel that had reached `open`',
			ciphered.state === 'open' && relayHeld.length > 0,
			`state=${ciphered.state} relay held ${relayHeld.length}B`);
		check('and the gateway’s whole view of the payload does not contain it',
			!relayHeld.includes(SECRET), `${relayHeld.length} bytes forwarded`);
		check('nor does any frame the browser sent, read from the browser’s own side',
			browserPut.length > 0 && !browserPut.includes(SECRET),
			`${browserPut.length} bytes in ${seen.sent.length} frame(s)`);
	} else {
		note('a secret written into an open tunnel is ciphertext on the wire', 'no outbound network');
	}

	// THE RED PROOF for that grep. The clear phase of a STARTTLS tunnel passes bytes
	// through untouched, by design, so the same write on the same recorder must be
	// FOUND. A grep that cannot find a secret it is looking straight at is a grep
	// that proves nothing about the case where it finds none.
	upBytes = [];
	const clear = await drive({ host: 'clear.test', port: CLEAR_FIX, security: 'starttls' },
		{ want: 'clear', write: SECRET });
	const clearHeld = Buffer.concat(upBytes);
	check('RED PROOF: the same write over an unpromoted STARTTLS tunnel IS found in the clear',
		clearHeld.includes(SECRET),
		`state=${clear.state}, ${clearHeld.length} bytes forwarded`);

	// ── The request recorder, proved to work ──────────────────────────
	const inReq = (needle) => seen.reqs.some((r) =>
		r.url.includes(needle) || (r.post || '').includes(needle));
	check('the password is in no request URL and no request body',
		!inReq(SECRET), `${seen.reqs.length} request(s) recorded`);
	check('and in no WebSocket URL either — a URL is the worst place for a secret',
		!seen.sockets.some((u) => u.includes(SECRET)),
		`${seen.sockets.length} socket(s): ${seen.sockets.slice(0, 1).join(' ')}`);
	// A recorder that records nothing passes both of those. So put the secret
	// somewhere it should not be, on purpose, and watch the same grep find it.
	const CANARY = 'laneC-canary-' + crypto.randomBytes(4).toString('hex');
	await page.evaluate(async (c) => {
		try {
			await fetch('/api/laneC-canary?probe=' + encodeURIComponent(c),
				{ method: 'POST', body: JSON.stringify({ password: c }) });
		} catch (e) { /* the answer does not matter; the recording does */ }
	}, CANARY);
	await page.waitForTimeout(300);
	check('RED PROOF: the same recorder finds a secret deliberately put in a body and a URL',
		inReq(CANARY), `${seen.reqs.length} request(s) recorded`);

	// ── 6. The release fact: mail still travels the old bridge ─────────
	//
	// The tunnel is inert in this release, and a file that CLAIMED otherwise while
	// the bridge carried the password would be the worst outcome available. Asserted
	// on the source, because that is where the claim would live.
	const src = fs.readFileSync(path.join(APP, 'www', 'js', 'mail.js'), 'utf8');
	check('syncOne still posts to /api/mail/sync, so mail works in this release',
		src.includes("post('/api/mail/sync', body)"));
	check('and the header says so rather than claiming the tunnel carries mail',
		/NOT\s*\n\s*\*\s*yet carrying anything/.test(src));
	check('the seam fails loudly rather than answering an empty mailbox',
		src.includes("mail.err.protocol_pending"));

	// PAGE ERRORS, not console errors. The app is booting against a stub for the
	// gateway's other routes, so console noise is this harness's own doing; an
	// uncaught exception is not, and is the only one of the two that means the
	// tunnel code threw somewhere nothing caught it.
	const thrown = errs.filter((e) => /^pageerror:/.test(e));
	check('nothing threw uncaught in the page while any of that ran',
		thrown.length === 0, thrown.slice(0, 2).join(' | ') || `${errs.length} console line(s)`);
} finally {
	await s.close().catch(() => {});
	serve.kill();
	relay.close();
	fixes.forEach((f) => f.close());
	// A Playwright profile per run: left on tmpfs it took the fleet down three times,
	// and left on disk it is still a directory per run.
	try { fs.rmSync(path.join(WORK, 'pw'), { recursive: true, force: true }); } catch (e) {}
}

console.log(`\nverify_mailtunnel: ${ok.length} ok, ${bad.length} failed, ${skip.length} skipped.`);
if (bad.length) { bad.forEach((b) => console.log('  FAILED: ' + b)); process.exit(1); }
process.exit(0);
