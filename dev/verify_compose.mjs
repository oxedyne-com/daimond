// verify_compose.mjs — drive the compose path end to end, against real servers.
//
// The IMAP fixture (fe2o3's imap_test_server, 127.0.0.1:1143) puts real mail in the
// mailbox; a stand-in submission provider (127.0.0.1:1587) takes what is sent and
// writes it to a file. So the question this answers is not "did the UI do something"
// but "what exactly did Daimond put on the wire" — the headers, the encoding, the
// threading, the envelope.
//
// Needs: the gateway with `dev_insecure` on the mail routes, the fixture, the
// stand-in, and the `email` entitlement granted to the harness's account.
import fs from 'node:fs';
import { open, shot } from './harness.mjs';

const SENT = process.env.SENT_EML || '/tmp/sent.eml';
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// A fixed profile, so the identity — and therefore the gateway account holding the
// email unlock and the credits — is the same one every run.
const s = await open({ name: 'compose', connect: false, profile: '/tmp/daimond-compose-profile' });
const p = s.page;

// ── Clear the drafts this run is about to make claims about.
//
// The profile is fixed, so OPFS persists between runs — and the run below seeds a draft of
// its own (the one the agent writes). Left behind, that draft is still sitting there when the
// NEXT run asserts that sending cleared the drafts folder, and the run fails on the leavings
// of the run before it. The state under test is this run's; start it empty.
await p.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	try {
		const mail = await root.getDirectoryHandle('mail');
		const box  = await mail.getDirectoryHandle('alice@test.local');
		await box.removeEntry('drafts', { recursive: true });
	} catch (e) { /* no mailbox yet, which is the state we are asking for */ }
});

// ── Seed the mailbox the way the add-dialog would, but pointed at the fixture.
// The dialog infers security from the port and offers no plaintext, so a loopback
// test server can only be reached by seeding the record (a known gotcha).
await p.evaluate(async () => {
	const pass = await window.DaimondIdentity.wrap('test-app-password');
	localStorage.setItem('daimond-mail', JSON.stringify({
		accounts: [{
			address: 'alice@test.local',
			host: '127.0.0.1', port: 1143, security: 'plain',
			smtpHost: '127.0.0.1', smtpPort: 1587, smtpSecurity: 'plain',
			user: 'alice@test.local', pass,
			uidValidity: 0, lastUid: 0, lastSync: 0,
		}],
		sel: 'alice@test.local',
	}));
	window.DaimondMail.reload();
	window.DaimondPanels.show('mail');
	window.DaimondMail.onOpen();
});
await p.waitForTimeout(1200);

// ── Sync, so there is something to reply to.
await p.evaluate(() => window.DaimondMail.sync());
await p.waitForSelector('.mail-msg', { timeout: 20000 });
const msgs = await p.$$eval('.mail-msg', els => els.length);
check('the fixture mailbox syncs', msgs >= 3, msgs + ' messages');

// ── Open one, and answer it.
await p.click('.mail-msg');
await p.waitForSelector('#panel-msg .msg-acts', { timeout: 10000 });
const verbs = await p.$$eval('.msg-act', els => els.map(e => e.textContent));
check('the message offers the verbs', verbs.includes('Reply') && verbs.includes('Forward'), verbs.join(', '));

await p.click('.msg-act');                       // Reply
await p.waitForSelector('#panel-compose', { state: 'visible', timeout: 10000 });
const pre = await p.evaluate(() => ({
	to:      document.getElementById('compose-to').value,
	subject: document.getElementById('compose-subject').value,
	body:    document.getElementById('compose-text').value,
	from:    document.getElementById('compose-from').value,
	staged:  !!document.querySelector('#panel-compose').offsetParent,
	aiToo:   !!document.querySelector('[data-panel="ai"]').offsetParent,
}));
check('reply opens on the stage, beside the daimon', pre.staged && pre.aiToo);
check('reply addresses the sender',      /@/.test(pre.to), pre.to);
check('reply carries Re:',               /^Re:/i.test(pre.subject), pre.subject);
check('reply quotes what it answers',    /^> /m.test(pre.body));
check('reply is from the mailbox',       pre.from === 'alice@test.local', pre.from);

// ── Write it: a non-ASCII subject and body (encoded-words and quoted-printable),
// and a file (the multipart path).
fs.writeFileSync('/tmp/compose-att.txt', 'the attachment survived the journey\n');
await p.fill('#compose-subject', 'Re: naïve — a résumé of the façade');
await p.fill('#compose-text', 'Thanks — the café is fine.\nA line with trailing space \nFrom the top.\n\n> quoted still\n');
await p.setInputFiles('#compose-file', '/tmp/compose-att.txt');
await p.waitForSelector('.compose-att', { timeout: 5000 });
check('an attachment can be added', true, await p.$eval('.compose-att', e => e.textContent));

// ── Save it as a draft first: the file is the draft.
await p.click('#compose-save');
await p.waitForFunction(() => /Saved to /.test(document.getElementById('compose-note').textContent), { timeout: 10000 });
const draftPath = await p.$eval('#compose-note', e => e.textContent.replace('Saved to ', ''));
check('a draft is a file in the workspace', /^mail\/.*\/drafts\/.*\.eml$/.test(draftPath), draftPath);

// ── Send it. The confirm is the last thing between a person and an irreversible act.
await p.click('#compose-send');
await p.waitForSelector('.dlg-card', { timeout: 5000 });
const confirmText = await p.$eval('.dlg-card', e => e.textContent);
check('sending asks first', /cannot be recalled/i.test(confirmText));
await p.click('.dlg-card button.danger, .dlg-card .dlg-ok, .dlg-card button:not(.dlg-cancel)');
await p.waitForTimeout(3000);

// ── What actually went on the wire.
let raw = '';
for (let i = 0; i < 20 && !raw; i++) {
	try { raw = fs.readFileSync(SENT, 'binary'); } catch { await p.waitForTimeout(500); }
}
check('the provider received a message', !!raw, raw.length + ' bytes');
if (raw) {
	const head = raw.split('\r\n\r\n')[0];
	check('it is From the mailbox',        /^From: alice@test\.local/m.test(head));
	check('it has a Message-ID',           /^Message-ID: <.+@test\.local>/m.test(head));
	check('it threads (In-Reply-To)',      /^In-Reply-To: <.+>/m.test(head), (head.match(/^In-Reply-To: .*/m) || [''])[0]);
	check('it threads (References)',       /^References: <.+>/m.test(head));
	check('a non-ASCII subject is encoded',/^Subject: .*=\?utf-8\?B\?/m.test(head), (head.match(/^Subject: .*/m) || [''])[0].slice(0, 60));
	check('it is multipart with the file', /Content-Type: multipart\/mixed/.test(head));
	check('the body is quoted-printable',  /Content-Transfer-Encoding: quoted-printable/.test(raw));
	check('a trailing space is encoded',   /space=20\r\n/.test(raw) || /space=\r\n/.test(raw));
	check('a "From " line is escaped',     /^=46rom the top\./m.test(raw));
	check('the attachment is carried',     /filename="compose-att.txt"/.test(raw));
	// The attachment's bytes, decoded back out of the base64 part.
	const b64 = (raw.split('filename="compose-att.txt"')[1] || '').split('\r\n\r\n')[1] || '';
	const back = Buffer.from(b64.split('\r\n--')[0].replace(/\s+/g, ''), 'base64').toString();
	check('the attachment survives',       /survived the journey/.test(back), JSON.stringify(back.slice(0, 40)));
	// The é in the body: quoted-printable of UTF-8 is =C3=A9.
	check('a non-ASCII body is encoded',   /caf=C3=A9/.test(raw));
	fs.writeFileSync('/tmp/sent-head.txt', head);
}

// ── The sent copy, and the draft that is now gone.
const after = await p.evaluate(async () => {
	const walk = async (dir, path) => {
		const out = [];
		for await (const [name, h] of dir.entries()) {
			if (h.kind === 'directory') out.push(...await walk(h, path + name + '/'));
			else out.push(path + name);
		}
		return out;
	};
	const root = await navigator.storage.getDirectory();
	const mail = await root.getDirectoryHandle('mail');
	return await walk(mail, 'mail/');
});
check('the sent message is kept as a file', after.some(f => /\/sent\/.*\.eml$/.test(f)),
	after.filter(f => /sent/.test(f)).join(', '));
check('the sent draft is cleared',          !after.some(f => /\/drafts\/.*\.eml$/.test(f)),
	after.filter(f => /drafts/.test(f)).join(', ') || 'none left');

// ── The agent's channel: a draft IT wrote must appear where the user looks.
await p.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	const mail = await root.getDirectoryHandle('mail');
	const box  = await mail.getDirectoryHandle('alice@test.local');
	const dir  = await box.getDirectoryHandle('drafts', { create: true });
	const fh   = await dir.getFileHandle('agent-reply.eml', { create: true });
	const w    = await fh.createWritable();
	await w.write('From: alice@test.local\r\nTo: bob@test.local\r\n'
		+ 'Subject: The draft the daimon wrote\r\n\r\nI have written this for you to check.\r\n');
	await w.close();
});
await p.evaluate(() => window.DaimondMail.onOpen());
await p.waitForSelector('.mail-draft', { timeout: 10000 });
const drafted = await p.$eval('.mail-draft', e => e.textContent);
check('a draft the agent wrote is offered to the user', /daimon wrote/.test(drafted), drafted);

await p.click('.mail-draft');
await p.waitForSelector('#panel-compose', { state: 'visible', timeout: 5000 });
const reopened = await p.evaluate(() => ({
	to:   document.getElementById('compose-to').value,
	subj: document.getElementById('compose-subject').value,
	body: document.getElementById('compose-text').value,
}));
check('the agent\'s draft opens for the human to send',
	reopened.to === 'bob@test.local' && /check/.test(reopened.body), JSON.stringify(reopened));

await shot(s, 'compose');
console.log('\nconsole errors:', s.errs.filter(e => !/favicon|404/.test(e)).slice(0, 5));
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
await s.close();
process.exit(bad.length ? 1 : 0);
