// verify_lockkeys.mjs — a locked Daimond holds no readable key.
//
// That is the contract, and it used to be kept by one line: `cfg.apiKey = ''`, because there was
// one key and it lived there. There are now a key per PROVIDER, held in memory by DaimondModels,
// and a built agent for every chat and every Diamond with its key already handed to the wasm.
// `DaimondModels.lock()` was written to forget the first of those -- and never called.
//
// So the lock is tested from the outside: after locking, can anything still name a key, and can
// any built agent still reach a provider? Asking the app whether it FEELS locked would prove
// nothing; the question is whether the key is gone.
import { open, chat, errors } from './harness.mjs';
import http from 'node:http';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// A provider that records every request it is sent.
const seen = [];
const srv = http.createServer((req, res) => {
	if (req.method === 'OPTIONS') {
		res.writeHead(204, {
			'access-control-allow-origin': '*',
			'access-control-allow-headers': '*',
			'access-control-allow-methods': 'POST, GET, OPTIONS',
		});
		return res.end();
	}
	let body = '';
	req.on('data', c => (body += c));
	req.on('end', () => {
		if (req.url.endsWith('/models')) {
			res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
			return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
		}
		seen.push(req.headers.authorization || '');
		res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
		res.end(JSON.stringify({
			choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		}));
	});
});
srv.listen(9121, '127.0.0.1');
const URL = 'http://127.0.0.1:9121/v1/chat/completions';

const s = await open({ name: 'lockkeys', connect: false });
const p = s.page;
await p.waitForTimeout(1200);

// A provider with a key, sealed under the passphrase, and a chat running on it.
await p.evaluate(async (u) => {
	const M = window.DaimondModels;
	M.addProvider('secret', { name: 'Secret Co', url: u });
	await M.setKey('secret', 'SUPERSECRET-KEY');
	await M.fetchModels('secret');
	M.setDefault('secret', 'test-model');
}, URL);
await p.waitForTimeout(500);

await chat(s, 'hello');
check('while unlocked, the chat reaches the provider with its key',
	seen.length === 1 && seen[0].includes('SUPERSECRET-KEY'), seen[0] || '(nothing sent)');

const unlocked = await p.evaluate(() => ({
	key:  window.DaimondModels.keyFor('secret'),
	apps: (window.__daimondChats || []).length,   // not exposed; only the key matters here
}));
check('and the key is readable, as it must be to work',
	unlocked.key === 'SUPERSECRET-KEY');

// ── Lock ───────────────────────────────────────────────────────────────

await p.evaluate(() => {
	// The lock is "Log out" in the user menu. Drive the real one.
	const row = document.querySelector('.user-row');
	if (row) row.click();
});
await p.waitForTimeout(400);
const locked = await p.evaluate(async () => {
	const item = [...document.querySelectorAll('button, .menu-item, [role="menuitem"]')]
		.find(b => /log out/i.test(b.textContent || ''));
	if (!item) return { drove: false };
	item.click();
	await new Promise(r => setTimeout(r, 900));
	return {
		drove:  true,
		key:    window.DaimondModels.keyFor('secret'),
		sealed: window.DaimondModels.isSealed('secret'),
		hasKey: window.DaimondModels.hasKey('secret'),
		gateUp: getComputedStyle(document.getElementById('identity-modal')).display !== 'none',
	};
});
check('the lock is reachable from the user menu', locked.drove === true);
check('after locking, no plaintext key can be named',
	locked.key === '', locked.key ? 'STILL READABLE: ' + locked.key : '(gone)');
check('the key is still THERE, just sealed — locking is not deleting',
	locked.hasKey === true && locked.sealed === true,
	'hasKey=' + locked.hasKey + ' sealed=' + locked.sealed);
check('and the passphrase gate is up', locked.gateUp === true);

// The sharper test: an agent built BEFORE the lock had the key handed to it. If that agent
// survived, the lock is cosmetic — the key is still in the wasm and still reaches the provider.
const before = seen.length;
const survivor = await p.evaluate(async () => {
	// Try to make the app that was serving the chat take another turn. If the lock nulled it,
	// there is nothing here to run.
	const input = document.getElementById('chat-input');
	if (input && input.offsetParent !== null) {
		input.value = 'again';
		document.getElementById('chat-send').click();
		await new Promise(r => setTimeout(r, 2500));
		return 'the composer is still live';
	}
	return 'no composer while locked';
});
await p.waitForTimeout(1500);
check('no agent built before the lock can still reach the provider',
	seen.length === before, `${seen.length - before} request(s) after locking — ${survivor}`);

const errs = errors(s).filter(e => !/favicon|404|401|502|Bad Gateway|net::ERR/.test(e));
check('nothing throws while locking', errs.length === 0, errs[0] || '');

await s.close();
srv.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
