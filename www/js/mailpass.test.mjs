// MAIL-PASS (25 Oct): the Add-a-mailbox form asks for the mailbox's PASSWORD, and says under
// the field that an app password is what some providers want instead. It read "App password"
// and "The app password is required", which told the owner, on his own server with no app
// passwords, that he needed something he did not have. Red at 9f601b5b4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../..', import.meta.url).pathname;
let table = {};
const ctx = { window: { DaimondI18n: { register: (_c, tb) => { table = tb; } } } };
ctx.DaimondI18n = ctx.window.DaimondI18n;
vm.runInNewContext(readFileSync(root + 'www/i18n/en.js', 'utf8'), ctx);
const t = (k) => table[k] ?? k;
const src = readFileSync(root + 'www/js/daimond.js', 'utf8');
const fn = (name) => {
	const at = src.indexOf('\tfunction ' + name + '(');
	assert.ok(at >= 0, name + ' is in daimond.js');
	return src.slice(at, src.indexOf('\n\t}\n', at) + 3);
};

// Just enough of a DOM for buildForm to lay out the fields, in order, into one host.
function node(tag) {
	return {
		tag, className: '', textContent: '', attrs: {}, kids: [], value: '', dataset: {},
		appendChild(k) { this.kids.push(k); return k; },
		setAttribute(a, v) { this.attrs[a] = v; },
		addEventListener() {},
	};
}
const document = { createElement: node };
const mark = (n, attr, text) => { if (attr) n.attrs[attr] = text; else n.textContent = text; };

// The form as mailDialog builds it, captured where DaimondAdmin.form would show it.
function mailForm() {
	let opts = null;
	const sb = {
		t, mark, document, window: {}, String, parseInt,
		DaimondAdmin: { form: (o) => { opts = o; } },
		installSecretMask: () => {}, getSecret: (el) => el.value, secretEye: (el) => el,
	};
	vm.runInNewContext(fn('buildForm') + '\n' + fn('mailDialog')
		+ '\nthis.buildForm = buildForm; this.mailDialog = mailDialog;', sb);
	sb.mailDialog({}, {});
	const host = node('div');
	sb.buildForm(host, opts);
	return { opts, host };
}

test('mailpass: the field is labelled Password, with the app-password hint under it', () => {
	const { host } = mailForm();
	const k = host.kids;
	const lab = k.findIndex((n) => n.className === 'cfg-fieldlabel' && n.textContent === 'Password');
	assert.ok(lab >= 0, 'a field is labelled "Password": '
		+ k.filter((n) => n.className === 'cfg-fieldlabel').map((n) => n.textContent).join(' | '));
	assert.equal(k[lab + 1].tag, 'input', 'the password input follows its label');
	const hint = k[lab + 2];
	assert.equal(hint.className, 'cfg-fieldnote', 'a note stands under the password input');
	assert.equal(hint.textContent,
		'or an app password, if your provider uses them (Gmail, iCloud, Outlook)');
});

test('mailpass: an empty password is refused as "The password is required."', () => {
	const { opts } = mailForm();
	const bad = opts.validate({ address: 'hello@oxedyne.com', password: '', host: 'imap.oxedyne.com',
		port: '993', smtpHost: 'smtp.oxedyne.com', smtpPort: '587' });
	assert.equal(bad, 'The password is required.');
});

test('mailpass: no string the form shows calls the credential an app password', () => {
	for (const k of ['mail.add.password', 'mail.add.password_ph', 'mail.add.err_password']) {
		assert.ok(!/app password/i.test(t(k)), k + ' reads: ' + t(k));
	}
});
