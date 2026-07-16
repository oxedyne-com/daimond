// verify_accounts.mjs — several people, one browser, and none of them sees the others.
//
// The promise is isolation: account B must not see account A's chats, provider keys, credits
// ledger, or workspace files, and switching back to A must find A's data intact. The test drives
// the real storage layer — the localStorage shim in accounts.js and the OPFS namespace in the
// wasm — and checks the two directly:
//
//   * localStorage: write a marker under A, switch to B, confirm it is gone; confirm B's own
//     marker does not bleed back to A.
//   * OPFS: write a file through the wasm's own write_file under A, switch to B, confirm B's
//     read_file cannot find it and lists a different root.
//
// The primary account keeps the raw keys and the OPFS root (so an existing install is untouched);
// only a SECOND account brings a namespace into being. Both halves are checked.
import { open, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// signIn:false — we drive the identity/account machinery ourselves.
const s = await open({ name: 'accounts', connect: false, signIn: false });
const p = s.page;
await p.waitForTimeout(1500);

// ── One browser starts with exactly one account: the primary ────────────

const start = await p.evaluate(() => {
	const A = window.DaimondAccounts;
	return { count: A.list().length, primary: A.account().primary, prefix: A.prefix(), opfsNs: A.opfsNs() };
});
check('a browser starts with one account, the primary', start.count === 1 && start.primary === true);
check('and the primary is un-namespaced — raw keys, OPFS root',
	start.prefix === '' && start.opfsNs === '', `prefix="${start.prefix}" ns="${start.opfsNs}"`);

// ── Account A writes distinctive data ───────────────────────────────────

const aId = await p.evaluate(async () => {
	const A = window.DaimondAccounts;
	// Sensitive data in localStorage: a chat, a provider key.
	localStorage.setItem('daimond-chats', JSON.stringify([{ id: 'cA', name: 'A-secret-chat' }]));
	localStorage.setItem('daimond-byok', JSON.stringify({ apiKey: 'KEY-FOR-A' }));
	// A workspace file, written through the wasm's own OPFS edge.
	const mod = await import('../pkg/oxedyne_daimond.js');
	await mod.write_file('a-file.txt', 'A-workspace-secret');
	return A.current();
});
const aData = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return {
		chats: localStorage.getItem('daimond-chats'),
		key:   localStorage.getItem('daimond-byok'),
		file:  await mod.read_file('a-file.txt').catch(() => '(unreadable)'),
	};
});
check('account A sees its own chat, key and file',
	/A-secret-chat/.test(aData.chats) && /KEY-FOR-A/.test(aData.key) && aData.file === 'A-workspace-secret');

// ── Add account B, and switch to it (a reload, as the app does) ──────────

await p.evaluate(() => { window.DaimondAccounts.add('Bob'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1800);

const bState = await p.evaluate(() => {
	const A = window.DaimondAccounts;
	return { count: A.list().length, primary: A.account().primary, prefix: A.prefix(), opfsNs: A.opfsNs(), name: A.account().name };
});
check('adding an account makes two, and lands on the new one', bState.count === 2 && bState.name === 'Bob');
check('the second account IS namespaced — its own prefix and OPFS subdir',
	bState.prefix !== '' && bState.opfsNs !== '', `prefix="${bState.prefix}" ns="${bState.opfsNs}"`);

// The whole point: B must see none of A's data.
const bData = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return {
		chats: localStorage.getItem('daimond-chats'),
		key:   localStorage.getItem('daimond-byok'),
		file:  await mod.read_file('a-file.txt').then(() => 'FOUND-A-FILE').catch(() => 'not-found'),
	};
});
check('account B does NOT see A\'s chat', !bData.chats || !/A-secret-chat/.test(bData.chats), String(bData.chats));
check('account B does NOT see A\'s provider key', !bData.key || !/KEY-FOR-A/.test(bData.key), String(bData.key));
check('account B does NOT see A\'s workspace file', bData.file === 'not-found', bData.file);

// B writes its own data.
await p.evaluate(async () => {
	localStorage.setItem('daimond-chats', JSON.stringify([{ id: 'cB', name: 'B-secret-chat' }]));
	localStorage.setItem('daimond-byok', JSON.stringify({ apiKey: 'KEY-FOR-B' }));
	const mod = await import('../pkg/oxedyne_daimond.js');
	await mod.write_file('b-file.txt', 'B-workspace-secret');
});

// ── Switch back to A: its data intact, B's invisible ────────────────────

await p.evaluate((id) => { window.DaimondAccounts.setCurrent(id); }, aId);
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1800);

const backToA = await p.evaluate(async () => {
	const A = window.DaimondAccounts;
	const mod = await import('../pkg/oxedyne_daimond.js');
	return {
		current: A.account().name || '(primary)',
		chats: localStorage.getItem('daimond-chats'),
		key:   localStorage.getItem('daimond-byok'),
		aFile: await mod.read_file('a-file.txt').catch(() => '(gone)'),
		bFile: await mod.read_file('b-file.txt').then(() => 'FOUND-B').catch(() => 'not-found'),
	};
});
check('switching back reaches account A again', backToA.current === '(primary)');
check('account A\'s chat, key and file survived the round trip',
	/A-secret-chat/.test(backToA.chats) && /KEY-FOR-A/.test(backToA.key) && backToA.aFile === 'A-workspace-secret',
	backToA.aFile);
check('and A cannot see B\'s file either', backToA.bFile === 'not-found', backToA.bFile);

// ── The unlock picker shows both accounts ───────────────────────────────

const picker = await p.evaluate(() => {
	// Force the identity modal to render in unlock mode via the app's own path is heavy; instead
	// confirm the registry the picker reads from names both, with B nameable without unlocking.
	const A = window.DaimondAccounts;
	return A.list().map(a => a.name || '(primary, unnamed)');
});
check('the registry names both accounts, so the picker can list them without unlocking',
	picker.length === 2 && picker.some(n => n === 'Bob'), picker.join(', '));

const errs = errors(s).filter(e => !/favicon|404|401|502|Bad Gateway|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
check('nothing throws through all the switching', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
