// gateway: none
// probe_imagesmodel.mjs — is the configured images model alive? (2026-10-12 liveness gate)
//
// On 12 Oct the account's default images model answered every look with 401 "User not found",
// and the daimon went blind without anybody knowing. The cause there was a revoked key on the
// owner's tab (healed now by `DaimondModels.sendOnKey`), but a retired model id or a provider
// route gone dark fails the same way, and no mock-backed verifier can see either. This asks the
// real provider to look at a 16 px red square and passes only on an answer in words.
//
//   node dev/probe_imagesmodel.mjs [--model ~deepseek/deepseek-flash-latest] [--url https://openrouter.ai/api/v1]
//
// Key: DAIMOND_PROBE_KEY, or the file DAIMOND_PROBE_KEY_FILE, or ~/.config/oxedyne/daimond/openrouter.key
// (0600). The key is never printed.
//
// A dead PROBE KEY is not a dead model, and the two must never read alike: one is an owner step
// (replace the key), the other is the finding this probe exists for. So the provider's answer is
// sorted before it is reported: 401 is the key (expired, revoked, unknown user), 402 is the key's
// account (no credit), and anything else -- a refusal, a retired id, a route gone dark, or an
// answer with no words -- is the model.
//
// Exit 0 alive, 1 model refused or wordless, 2 not configured, 3 probe key expired or rejected,
// 4 probe key out of credit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const MODEL = flag('model', '~deepseek/deepseek-flash-latest');
const URL_  = flag('url', 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

function readKey() {
	const env = (process.env.DAIMOND_PROBE_KEY || '').trim();
	if (env) return env;
	const file = process.env.DAIMOND_PROBE_KEY_FILE || path.join(os.homedir(), '.config/oxedyne/daimond/openrouter.key');
	let text = '';
	try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
	return text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
}

/// A w-by-w PNG of one colour, so the probe carries no binary fixture.
function square(w, rgb) {
	const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
	const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
	const chunk = (t, d) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
		const td = Buffer.concat([Buffer.from(t, 'ascii'), d]);
		const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array(w).fill(Buffer.from(rgb)))]);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(w).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

const key = readKey();
if (!key) { console.error('No provider key: set DAIMOND_PROBE_KEY or put one in ~/.config/oxedyne/daimond/openrouter.key.'); process.exit(2); }
const png = square(16, [220, 20, 20]).toString('base64');
const t0 = Date.now();
let res, raw = '';
try {
	res = await fetch(URL_ + '/chat/completions', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
		body: JSON.stringify({ model: MODEL, max_tokens: 40, stream: false, messages: [{ role: 'user', content: [
			{ type: 'text', text: 'What single colour fills this picture? One word.' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }] }] }),
	});
	raw = await res.text();
} catch (e) {
	console.log(`FAIL ${MODEL} at ${URL_}: could not be reached: ${String(e && e.message || e).slice(0, 160)}`);
	process.exit(1);
}
let j = {};
try { j = JSON.parse(raw); } catch (e) { j = {}; }
const ms = Date.now() - t0;
if (!res.ok) {
	const why = String((j.error && (j.error.message || j.error)) || raw.slice(0, 160)).slice(0, 160);
	if (res.status === 401) {
		console.log(`FAIL probe key expired: ${URL_} answered 401 (${why}). The model was never asked; `
			+ 'this is the probe\'s key, not the model. Owner step: replace the key, then run this again.');
		process.exit(3);
	}
	if (res.status === 402) {
		console.log(`FAIL probe key out of credit: ${URL_} answered 402 (${why}). The model was never asked; `
			+ 'owner step: top up or replace the key, then run this again.');
		process.exit(4);
	}
	console.log(`FAIL model refused: ${MODEL} at ${URL_} answered ${res.status}: ${why}`);
	process.exit(1);
}
const text = String(((j.choices || [])[0] || {}).message && j.choices[0].message.content || '').trim();
if (!text) { console.log(`FAIL model refused: ${MODEL} answered with no words (${ms} ms)`); process.exit(1); }
console.log(`ok   ${MODEL} sees: "${text.slice(0, 60)}"${/red/i.test(text) ? '' : ' (not "red": alive, but check it reads pictures)'} — ${ms} ms, routed to ${j.model || '?'}`);
process.exit(0);
