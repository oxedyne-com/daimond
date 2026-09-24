// verify_handoff_q4grant.mjs -- a consent grant answered on one device reaches the runner
// that asked, however many other devices collect it first (R3 QA Q4, D126).
//
// WHAT HAPPENED. The relay's ack was one watermark for the whole account. A grant carried
// no addressee, so the device that answered folded its own grant on its next collect and
// acked through it; a third device holding nothing below it did the same. Either ack took
// the grant off the relay for the whole account, and the runner -- which the answer was
// for -- never got it: it waited out its consent window and parked the turn ("no device
// was available to grant it") although the person had said Allow.
//
// THE FIX (gateway release 5 with its page half). A grant names the runner that asked
// (`to`, from the ask's `dispatchedBy`), `sealForSelf` tells the relay (`for`), and a relay
// that acks per device (`acks:"device"`) drops the row only on that runner's own ack.
//
// THE PROBE. Three devices of one account on this world's gateway: R the runner, L the
// device that answers, P a third. R posts a consent ask and goes OFFLINE, so it cannot
// collect before the others. L answers with a grant. L and P collect and ack through the
// grant. Then R comes back and collects. Asserted:
//   - the relay still holds the grant after L's and P's acks, addressed to R;
//   - R receives the grant (once), after coming back;
//   - R's own ack then takes it off the relay.
// On a page without the fix (release/r4), or a relay without per-device acks, the first two
// fail: the grant is gone before R returns. That run is the baseline, not a regression.
//
// Usage: node dev/verify_handoff_q4grant.mjs      (the world's env, one gateway on its port)
//        Q4_TARGET=L node dev/verify_handoff_q4grant.mjs
//        Q4_SWAP=<path> node dev/verify_handoff_q4grant.mjs
// With Q4_SWAP the probe is a ROLLBACK probe: once the relay is shown keeping the grant for R,
// it writes <path>.ready and waits for <path>.done, which the world's runner writes after
// putting the OLD gateway on the same store and port (tools/gw6_inner.sh, SWAPBIN). R then comes
// back to a relay that does not ack per device and must still receive the grant: an addressed
// row is an account row to the old gateway, and R's page goes back to the account's rules.
// With Q4_TARGET=L the ask names L, the device that answers it. Release 5 (SIM-3) holds an ask
// with no addressee for every device while it can be answered, so on its pages no device acks
// through the grant inside the probe's window; an ask addressed to L is the case the per-device
// ack changes there.

import fs from 'node:fs';
import { open, signInAs, connectMock } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { pair, checker, until, settle, comeBack, WAKE } from './handoffpair.mjs';

const { ok, bad, check } = checker();

/// The relay's rows as one device reads them, through its own session.
const relayRows = (s) => s.page.evaluate(async () => {
	const r = await window.DaimondGateway.gwFetch('/api/post?since=0', {
		method: 'GET', credentials: 'same-origin',
		headers: { 'x-daimond-api': String(window.DaimondGateway.clientApi()) },
	});
	const j = await r.json();
	return { status: r.status, acks: j.acks || '', rows: (j.rows || []).map((x) => ({
		seq: x.seq, addr: x.addr, for: x['for'] === undefined ? null : x['for'] })) };
}).catch((e) => ({ status: 0, acks: '', rows: [], err: String(e) }));

/// A third device of the account, paired from `lead` exactly as `pair` pairs the second.
async function third(lead, name) {
	const c = await open({ name, signIn: false, connect: false });
	c.account = lead.account; c.name = name;
	await c.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 90000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await c.page.evaluate((k) => DaimondPairing.redeem(k), code.code);
	await c.page.reload({ waitUntil: 'domcontentloaded' });
	await c.page.waitForFunction(() => {
		const btn = document.getElementById('id-primary');
		if (btn && btn.offsetParent !== null) return true;
		try { return !!window.__DAIMOND_READY && window.DaimondIdentity.isUnlocked(); } catch (e) { return false; }
	}, null, { timeout: 90000 }).catch(() => {});
	await signInAs(c, lead.account);
	await c.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(c.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(c);
	if (WAKE) await c.page.evaluate((m) => window.DaimondSync.wakeVia(m), WAKE);
	await c.page.waitForTimeout(2000);
	await settle(c.page);
	await until(c.page, () => { try { return window.DaimondPost.state().park.parks > 0; } catch (e) { return false; } }, null, 8000);
	return c;
}

console.log('Q4 -- a grant for the runner survives the other devices\' acks');
const { a: R, b: L } = await pair(check, 'q4run', 'q4lap');
const P = await third(R, 'q4pho');
const [idR, idL, idP] = await Promise.all([R, L, P].map((s) =>
	s.page.evaluate(() => window.DaimondIdentity.deviceId())));
check('three distinct devices', new Set([idR, idL, idP]).size === 3, [idR, idL, idP].join(' '));

// R's grant handler is replaced by a spy for the probe: what reaches R is what is counted.
await R.page.evaluate(() => {
	window.__q4grants = [];
	window.DaimondPeer.onGrant(async (g) => { window.__q4grants.push({ cid: g.cid, to: g.to || '' }); });
});

// R asks, as a runner blocked on a consent does: `dispatchedBy` is R, so the answer routes home.
const CID = 'q4-' + Date.now().toString(36);
const TARGET = process.env.Q4_TARGET === 'L' ? idL : '';
if (TARGET) console.log('  the ask names L (Q4_TARGET=L)');
await R.page.evaluate(async ({ cid, idR, target }) => {
	const ask = window.DaimondPeer.makeAsk({
		cid, eid: 'q4-eid', turnId: 'q4-turn', chatId: '', tool: 'web_fetch', host: 'example.com',
		detail: 'fetch https://example.com (probe)', deadline: Date.now() + 120000,
		dispatchedBy: idR, target,
	});
	await window.DaimondPost.post(await window.DaimondPeer.sealForSelf(ask));
}, { cid: CID, idR, target: TARGET });

// L has the ask once its cursor is past it.
const askRows = await relayRows(L);
const askSeq = Math.max(0, ...askRows.rows.map((x) => x.seq));
const lSawAsk = await until(L.page, (s) => window.DaimondPost.state().through >= s, askSeq, 30000);
check('L collected the ask', lSawAsk, 'ask seq ' + askSeq);

// R goes offline: it cannot collect before the others do.
await R.page.context().setOffline(true);

// L answers.
const grantAddr = await L.page.evaluate(async ({ cid, idL }) => {
	const grant = window.DaimondPeer.makeGrant({ cid, eid: 'q4-eid', turnId: 'q4-turn', verdict: 'allow', by: idL });
	const body = await window.DaimondPeer.sealForSelf(grant);
	await window.DaimondPost.post(body);
	return body.addr;
}, { cid: CID, idL });
const withGrant = await relayRows(L);
const grantRow = withGrant.rows.find((x) => x.addr === grantAddr) || null;
check('the grant is on the relay', !!grantRow, JSON.stringify(withGrant.rows));
const gSeq = grantRow ? grantRow.seq : 1e9;
console.log('  relay says acks=' + JSON.stringify(withGrant.acks) + '; grant seq ' + gSeq + ' for '
	+ JSON.stringify(grantRow && grantRow['for']) + ' (R is ' + idR + ')');

// L and P collect and ack through the grant, as a device holding nothing below it does.
const lAcked = await until(L.page, (s) => window.DaimondPost.state().acked >= s, gSeq, 45000);
const pAcked = await until(P.page, (s) => window.DaimondPost.state().acked >= s, gSeq, 45000);
console.log('  L acked through ' + await L.page.evaluate(() => window.DaimondPost.state().acked)
	+ ', P through ' + await P.page.evaluate(() => window.DaimondPost.state().acked));
check('L and P acked through the grant', lAcked && pAcked);

const afterAcks = await relayRows(L);
const kept = afterAcks.rows.find((x) => x.addr === grantAddr) || null;
check('THE RELAY STILL HOLDS THE GRANT FOR R after the other devices\' acks', !!kept,
	JSON.stringify(afterAcks.rows));
check('the kept grant is addressed to R', !!kept && kept['for'] === idR, JSON.stringify(kept));

// The rollback, where asked for: the old gateway on this store, under R's kept grant.
if (process.env.Q4_SWAP) {
	const sw = process.env.Q4_SWAP;
	fs.writeFileSync(sw + '.ready', String(Date.now()));
	const t0 = Date.now();
	while (!fs.existsSync(sw + '.done') && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 500));
	const done = fs.existsSync(sw + '.done') ? fs.readFileSync(sw + '.done', 'utf8').trim() : 'no swap inside 90 s';
	console.log('  gateway swapped: ' + done);
	check('THE OLD GATEWAY NOW SERVES THIS STORE', /swapped/.test(done) && /"store_ok": ?true/.test(done), done);
	const onOld = await relayRows(L);
	check('the old relay does not ack per device', onOld.acks !== 'device', JSON.stringify(onOld.acks));
	check('the old relay still carries the grant', onOld.rows.some((x) => x.addr === grantAddr), JSON.stringify(onOld.rows));
}

// R comes back, as a device does: its network returns and its tab comes to the front,
// which starts the collect a returning device makes (`peerCollectOnReturn`). A park loop
// that backed off while the network was gone is not what is under test, so a mailbox round
// is asked for as well, until the grant is in or the minute is up.
await R.page.context().setOffline(false);
await R.page.evaluate(() => { try { window.dispatchEvent(new Event('online')); } catch (e) {} });
await comeBack(R.page);
let got = false;
for (let i = 0; i < 12 && !got; i++) {
	const r = await R.page.evaluate(async () => {
		try { return await window.DaimondPost.round(); } catch (e) { return { ok: false, why: String(e) }; }
	});
	if (i === 0) console.log('  R\'s first round after coming back: ' + JSON.stringify(r));
	got = await until(R.page, (c) => (window.__q4grants || []).some((g) => g.cid === c), CID, 5000, 250);
}
const grants = await R.page.evaluate((c) => (window.__q4grants || []).filter((g) => g.cid === c), CID);
check('R RECEIVED THE GRANT after coming back', got, JSON.stringify(grants));
check('R received it once', grants.length === 1, 'received ' + grants.length);
check('the grant R received names R', grants.length > 0 && grants[0].to === idR, JSON.stringify(grants));

// R's own ack takes it.
const rAcked = await until(R.page, (s) => window.DaimondPost.state().acked >= s, gSeq, 45000);
const finalRows = await relayRows(L);
check('R acked through the grant', rAcked);
check('R\'s ack took the grant off the relay',
	!finalRows.rows.some((x) => x.addr === grantAddr), JSON.stringify(finalRows.rows));

console.log('\n' + ok.length + ' passed, ' + bad.length + ' failed');
if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
for (const s of [R, L, P]) { try { await s.close(); } catch (e) { /* already gone */ } }
process.exit(bad.length ? 1 : 0);
