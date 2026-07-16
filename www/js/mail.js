/* mail.js — Daimond's mailboxes.
 *
 * A browser has no TCP socket, so Daimond cannot speak IMAP. The gateway makes the
 * connection and hands back the raw RFC 5322 bytes; everything else happens
 * here. The mail is written into the workspace as a Maildir, which is to say:
 * as ordinary files, in ordinary folders, that the agents' existing file tools
 * already read. Nothing about mail is a special case downstream of the socket.
 *
 *   mail/<address>/INBOX/cur/<uid>.<uidvalidity>.daimond:2,<flags>
 *   mail/<address>/INBOX/index.md      a digest, so an agent can see the shape
 *                                      of an inbox without reading every message
 *
 * The credential is an app password. It is wrapped under the user's passphrase
 * with the same key that wraps their API key, and it is sent to the gateway only
 * as part of a sync — the gateway holds it for one IMAP conversation and then
 * forgets it. Daimond stores no mail server-side, and never sees the passphrase.
 *
 * The UID is the thing that makes an incremental sync possible: `since_uid` is
 * the last message already held, so a sync asks only for what arrived after it.
 * `uidvalidity` is the mailbox's generation — if the server changes it, every
 * UID held locally is meaningless and the mailbox is rebuilt from scratch.
 */
(function () {
	'use strict';

	var LS      = 'daimond-mail';
	var deps    = null;              // { writeBytes, openFile, refreshFiles, runTool, showDoc }
	var els     = {};
	var state   = {
		accounts: [],                // [{address, host, port, user, pass (wrapped), uidValidity, lastUid, lastSync}]
		sel:      null,              // the selected address
		msgs:     [],                // the digest of the selected mailbox
		drafts:   [],                // unsent messages held for the selected mailbox
		unlocked: null,              // null = not yet asked the gateway
		// The cap is the gateway's to state — it is the only place it means anything — so this
		// is what the panel says before the gateway has answered, and it must not promise more
		// than the unlock actually covers.
		cap:      3,
		price:    null,              // minor units, from the gateway's catalogue
		busy:     false,
		draining: false,             // a "fetch all" is walking the mailbox down
		note:     '',
		err:      '',
	};

	/// What each provider calls its IMAP server, and what it demands instead of
	/// a password. Guessed from the address so the user is asked for as little
	/// as possible; every field stays editable, because a guess is not a fact.
	/// Reading a mailbox and posting from it are two different servers, so a preset names
	/// both. Submission runs on 587 (which starts in the clear and upgrades) or 465 (which
	/// is encrypted from the first byte); the gateway dials no other port.
	var PRESETS = {
		'gmail.com':      { host: 'imap.gmail.com',        port: 993, smtpHost: 'smtp.gmail.com',        smtpPort: 587, note: 'Gmail needs an <b>App Password</b> (Google Account → Security → 2-Step Verification → App passwords), not your Google password.' },
		'googlemail.com': { host: 'imap.gmail.com',        port: 993, smtpHost: 'smtp.gmail.com',        smtpPort: 587, note: 'Gmail needs an <b>App Password</b>, not your Google password.' },
		'outlook.com':    { host: 'outlook.office365.com', port: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587, note: 'Outlook needs an <b>app password</b> if two-step verification is on.' },
		'hotmail.com':    { host: 'outlook.office365.com', port: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587, note: 'Outlook needs an <b>app password</b> if two-step verification is on.' },
		'live.com':       { host: 'outlook.office365.com', port: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587, note: '' },
		'yahoo.com':      { host: 'imap.mail.yahoo.com',   port: 993, smtpHost: 'smtp.mail.yahoo.com',   smtpPort: 465, note: 'Yahoo requires an <b>app password</b> generated in Account Security.' },
		'icloud.com':     { host: 'imap.mail.me.com',      port: 993, smtpHost: 'smtp.mail.me.com',      smtpPort: 587, note: 'iCloud requires an <b>app-specific password</b>.' },
		'me.com':         { host: 'imap.mail.me.com',      port: 993, smtpHost: 'smtp.mail.me.com',      smtpPort: 587, note: 'iCloud requires an <b>app-specific password</b>.' },
		'fastmail.com':   { host: 'imap.fastmail.com',     port: 993, smtpHost: 'smtp.fastmail.com',     smtpPort: 465, note: 'Fastmail requires an app password with IMAP access.' },
		'fastmail.fm':    { host: 'imap.fastmail.com',     port: 993, smtpHost: 'smtp.fastmail.com',     smtpPort: 465, note: '' },
		'zoho.com':       { host: 'imap.zoho.com',         port: 993, smtpHost: 'smtp.zoho.com',         smtpPort: 587, note: '' },
		'aol.com':        { host: 'imap.aol.com',          port: 993, smtpHost: 'smtp.aol.com',          smtpPort: 465, note: '' },
	};

	/// Providers that have no IMAP server anyone else can reach. Saying so is
	/// the honest thing; letting the user type a password into a form that
	/// cannot work is not.
	var UNREACHABLE = {
		'proton.me':      'Proton mail is only reachable through the Proton Bridge running on your own machine, which Daimond’s gateway cannot connect to.',
		'protonmail.com': 'Proton mail is only reachable through the Proton Bridge running on your own machine, which Daimond’s gateway cannot connect to.',
		'pm.me':          'Proton mail is only reachable through the Proton Bridge running on your own machine, which Daimond’s gateway cannot connect to.',
		'tutanota.com':   'Tuta does not offer IMAP at all, so no mail client can read it — Daimond included.',
		'tuta.io':        'Tuta does not offer IMAP at all, so no mail client can read it — Daimond included.',
	};

	function esc(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}
	function domainOf(addr) {
		var i = String(addr || '').lastIndexOf('@');
		return i < 0 ? '' : addr.slice(i + 1).toLowerCase().trim();
	}
	function load() {
		try {
			var j = JSON.parse(localStorage.getItem(LS) || '{}');
			state.accounts = Array.isArray(j.accounts) ? j.accounts : [];
			state.sel = j.sel || (state.accounts[0] && state.accounts[0].address) || null;
		} catch (e) { state.accounts = []; }
	}
	function save() {
		localStorage.setItem(LS, JSON.stringify({ accounts: state.accounts, sel: state.sel }));
	}
	function acct(address) {
		return state.accounts.find(function (a) { return a.address === address; }) || null;
	}

	// ── RFC 5322, enough of it ──────────────────────────────────────
	// Enough to show a message to a person: the headers that matter, and the
	// readable part of the body. An agent gets the raw file and can do better.

	/// Unfold the header block (a header may continue on an indented line) and
	/// return it as an ordered list of [name, value].
	function parseHeaders(text) {
		var end = text.search(/\r?\n\r?\n/);
		var block = end < 0 ? text : text.slice(0, end);
		var lines = block.split(/\r?\n/);
		var out = [], cur = null;
		lines.forEach(function (l) {
			if (/^[ \t]/.test(l) && cur) { cur[1] += ' ' + l.trim(); return; }
			var i = l.indexOf(':');
			if (i < 0) return;
			cur = [l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()];
			out.push(cur);
		});
		return out;
	}
	function header(hs, name) {
		var h = hs.find(function (x) { return x[0] === name; });
		return h ? h[1] : '';
	}
	function bodyOf(text) {
		var m = text.match(/\r?\n\r?\n/);
		return m ? text.slice(m.index + m[0].length) : '';
	}

	/// Decode an RFC 2047 encoded-word (`=?utf-8?B?...?=`), which is how a
	/// subject line carries anything that is not ASCII.
	function decodeWords(s) {
		return String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, function (_, cs, enc, txt) {
			try {
				var bytes;
				if (enc.toLowerCase() === 'b') {
					bytes = Uint8Array.from(atob(txt), function (c) { return c.charCodeAt(0); });
				} else {
					var t = txt.replace(/_/g, ' ');
					var arr = [];
					for (var i = 0; i < t.length; i++) {
						if (t[i] === '=' && /[0-9a-f]{2}/i.test(t.substr(i + 1, 2))) {
							arr.push(parseInt(t.substr(i + 1, 2), 16)); i += 2;
						} else { arr.push(t.charCodeAt(i)); }
					}
					bytes = new Uint8Array(arr);
				}
				return new TextDecoder(cs.toLowerCase().replace(/^utf8$/, 'utf-8')).decode(bytes);
			} catch (e) { return txt; }
		}).replace(/\?=\s*=\?/g, '');
	}

	/// Thousands separators, because "69635 older messages" is a number the eye has to count.
	function fmtCount(n) {
		return String(n || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	}

	function decodeQP(s) {
		return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, function (_, h) {
			return String.fromCharCode(parseInt(h, 16));
		});
	}
	function decodeB64(s) {
		try { return atob(s.replace(/\s+/g, '')); } catch (e) { return s; }
	}

	/// Re-read a decoded byte-string as UTF-8. `atob` and quoted-printable both
	/// yield one character per byte, so a multi-byte character arrives as
	/// mojibake unless it is decoded again.
	function asUtf8(bytes, charset) {
		try {
			var arr = Uint8Array.from(bytes, function (c) { return c.charCodeAt(0) & 0xff; });
			var cs = (charset || 'utf-8').toLowerCase().replace(/^utf8$/, 'utf-8');
			return new TextDecoder(cs, { fatal: false }).decode(arr);
		} catch (e) { return bytes; }
	}

	/// The readable text of a message: the `text/plain` part of a multipart, or
	/// the body itself, decoded out of whatever transfer encoding it arrived in.
	function readableText(raw) {
		var hs   = parseHeaders(raw);
		var ctype = header(hs, 'content-type') || 'text/plain';
		var body  = bodyOf(raw);

		var mb = ctype.match(/boundary="?([^";]+)"?/i);
		if (/multipart/i.test(ctype) && mb) {
			var parts = body.split('--' + mb[1]);
			var plain = null, html = null;
			parts.forEach(function (p) {
				var phs = parseHeaders(p.replace(/^\r?\n/, ''));
				var pct = header(phs, 'content-type') || '';
				var pte = (header(phs, 'content-transfer-encoding') || '').toLowerCase();
				var pb  = bodyOf(p.replace(/^\r?\n/, ''));
				if (!pb) return;
				if (pte === 'base64')           pb = decodeB64(pb);
				else if (pte === 'quoted-printable') pb = decodeQP(pb);
				var pcs = (pct.match(/charset="?([^";]+)"?/i) || [])[1];
				pb = asUtf8(pb, pcs);
				if (/text\/plain/i.test(pct) && plain === null) plain = pb;
				else if (/text\/html/i.test(pct) && html === null) html = pb;
				else if (/multipart/i.test(pct) && plain === null) {
					// One level of nesting: multipart/alternative inside
					// multipart/mixed is the common shape of a message with an
					// attachment, and the text is inside the inner part.
					var inner = readableText('content-type: ' + pct + '\r\n\r\n' + pb);
					if (inner) plain = inner;
				}
			});
			if (plain) return plain.trim();
			if (html) return stripHtml(html).trim();
			return '';
		}

		var te = (header(hs, 'content-transfer-encoding') || '').toLowerCase();
		if (te === 'base64')                 body = decodeB64(body);
		else if (te === 'quoted-printable')  body = decodeQP(body);
		var cs = (ctype.match(/charset="?([^";]+)"?/i) || [])[1];
		body = asUtf8(body, cs);
		if (/text\/html/i.test(ctype)) return stripHtml(body).trim();
		return body.trim();
	}

	/// Reduce HTML to its text. The message is never inserted as markup: a mail
	/// body is the least trustworthy string in the application.
	function stripHtml(html) {
		var t = String(html)
			.replace(/<style[\s\S]*?<\/style>/gi, '')
			.replace(/<script[\s\S]*?<\/script>/gi, '')
			.replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]+>/g, '');
		var d = document.createElement('textarea');
		d.innerHTML = t;                                 // entity decode only
		return d.value.replace(/\n{3,}/g, '\n\n');
	}

	// ── Maildir ─────────────────────────────────────────────────────

	/// A Maildir filename: `<unique>:2,<flags>`, flags in ASCII order. The
	/// unique part is derived from the UID and the mailbox generation rather
	/// than from the clock, so syncing the same message twice overwrites one
	/// file instead of making two.
	function maildirName(uid, uidValidity, flags) {
		var f = '';
		var has = function (n) { return (flags || []).some(function (x) { return x.toLowerCase() === n; }); };
		if (has('\\draft'))    f += 'D';
		if (has('\\flagged'))  f += 'F';
		if (has('\\answered')) f += 'R';
		if (has('\\seen'))     f += 'S';
		if (has('\\deleted'))  f += 'T';
		return uid + '.' + uidValidity + '.daimond:2,' + f;
	}
	function mailDir(address) {
		return 'mail/' + String(address || '').replace(/[^A-Za-z0-9@._-]/g, '_');
	}
	function mailboxDir(address) {
		return mailDir(address) + '/INBOX';
	}

	// ── Writing a message ───────────────────────────────────────────
	// RFC 5322 in the other direction. The gateway posts bytes rather than
	// intentions — it opens one submission conversation with the user's provider and
	// hands over a finished document — so the document is built here, in full, and
	// nothing server-side decides what a message says or who it goes to.

	function utf8(s) {
		return new TextEncoder().encode(String(s == null ? '' : s));
	}
	/// Base64 a byte array, in chunks: `String.fromCharCode` blows the argument
	/// limit on an attachment of any size.
	function b64(bytes) {
		var s = '', CH = 0x8000;
		for (var i = 0; i < bytes.length; i += CH) {
			s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
		}
		return btoa(s);
	}
	function isAscii(s) {
		return !/[^\x20-\x7e]/.test(String(s == null ? '' : s));
	}

	/// A header value with anything but plain ASCII in it, as RFC 2047 encoded-words.
	///
	/// The words are chunked so no line runs past the 76-character limit, and the chunk
	/// boundary is taken at a *character*, never inside a multi-byte one — split a
	/// character across two encoded-words and the recipient decodes rubbish.
	function encodeWord(s) {
		s = String(s == null ? '' : s);
		if (isAscii(s)) return s;
		var out = [], chunk = '', bytes = 0;
		for (var i = 0; i < s.length; i++) {
			var ch = s[i];
			// A surrogate pair is one character and must not be halved.
			if (/[\uD800-\uDBFF]/.test(ch) && i + 1 < s.length) ch += s[++i];
			var n = utf8(ch).length;
			if (bytes + n > 39 && chunk) {
				out.push('=?utf-8?B?' + b64(utf8(chunk)) + '?=');
				chunk = ''; bytes = 0;
			}
			chunk += ch; bytes += n;
		}
		if (chunk) out.push('=?utf-8?B?' + b64(utf8(chunk)) + '?=');
		return out.join('\r\n ');
	}

	/// One address as a header writes it: `Name <addr>`, with the name encoded if it
	/// needs it and quoted if it holds a character that would otherwise punctuate.
	function encodeAddr(a) {
		if (typeof a === 'string') a = splitAddr(a);
		if (!a || !a.addr) return '';
		if (!a.name) return a.addr;
		var nm = isAscii(a.name)
			? (/[(),:;<>@\[\]".]/.test(a.name) ? '"' + a.name.replace(/(["\\])/g, '\\$1') + '"' : a.name)
			: encodeWord(a.name);
		return nm + ' <' + a.addr + '>';
	}
	/// Split a header's worth of addresses on the commas that separate them, ignoring
	/// the ones inside a quoted display name.
	function addrList(s) {
		var out = [], cur = '', q = false;
		String(s || '').split('').forEach(function (c) {
			if (c === '"') q = !q;
			if (c === ',' && !q) { out.push(cur); cur = ''; return; }
			cur += c;
		});
		out.push(cur);
		return out.map(function (x) { return x.trim(); }).filter(Boolean);
	}
	/// Just the addresses, which is what the envelope carries: a display name is for
	/// the reader, and the provider is not the reader.
	function addrsOf(s) {
		return addrList(s).map(function (x) { return splitAddr(x).addr; }).filter(Boolean);
	}

	/// Quoted-printable, over the UTF-8 bytes.
	///
	/// The rules that bite: a space or tab at the end of a line is invisible and would be
	/// stripped in transit, so it is encoded; a line is folded with a soft break before it
	/// reaches 76 characters; and a line beginning `From ` is escaped, because some
	/// software still treats one as the start of a new message.
	function encodeQP(text) {
		var bytes = utf8(String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
		var lines = [], line = '', held = '';
		function flush() { lines.push(line); line = ''; }
		function push(tok) {
			if (line.length + tok.length > 75) { lines.push(line + '='); line = ''; }
			line += tok;
		}
		for (var i = 0; i < bytes.length; i++) {
			var b = bytes[i];
			if (b === 0x0a) {                                   // end of line
				if (held) { push(held === ' ' ? '=20' : '=09'); held = ''; }
				flush();
				continue;
			}
			if (held) { push(held); held = ''; }
			if (b === 0x20) { held = ' '; continue; }
			if (b === 0x09) { held = '\t'; continue; }
			if (b >= 33 && b <= 126 && b !== 61) push(String.fromCharCode(b));
			else push('=' + ('0' + b.toString(16).toUpperCase()).slice(-2));
			if (line === 'From' && i + 1 < bytes.length && bytes[i + 1] === 0x20) {
				line = '=46rom';                                // a line may not begin "From "
			}
		}
		if (held) push(held === ' ' ? '=20' : '=09');
		flush();
		return lines.join('\r\n');
	}
	/// Base64, wrapped to the 76-character line a MIME body is allowed.
	function b64Lines(bytes) {
		return (b64(bytes).match(/.{1,76}/g) || []).join('\r\n');
	}

	/// The date, as a mail header spells it. Built by hand rather than through
	/// `toLocaleString`, because the format is fixed and English and the user's locale
	/// is neither.
	function mailDate(d) {
		var DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
		var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		var pad = function (n) { return ('0' + n).slice(-2); };
		var off = -d.getTimezoneOffset();
		var sign = off < 0 ? '-' : '+';
		off = Math.abs(off);
		return DAY[d.getDay()] + ', ' + d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear()
			+ ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
			+ ' ' + sign + pad(Math.floor(off / 60)) + pad(off % 60);
	}
	function rand(n) {
		var a = new Uint8Array(n || 8);
		crypto.getRandomValues(a);
		return Array.from(a).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
	}
	function messageId(from) {
		return '<' + rand(10) + '.' + Date.now() + '@' + (domainOf(from) || 'daimond.local') + '>';
	}

	/// Build the RFC 5322 document a draft describes.
	///
	/// A draft with no attachment is one `text/plain` part; a draft with attachments is a
	/// `multipart/mixed` whose first part is that text. Nothing here is optional
	/// decoration: the `Message-ID` is what a reply to this message will point back at,
	/// and `In-Reply-To` / `References` are what make a reply *thread* in the recipient's
	/// client rather than arrive as an unrelated message with a similar subject.
	function buildMessage(d) {
		var from = { name: d.fromName || '', addr: d.from };
		var id   = d.messageId || messageId(d.from);
		var h    = [];
		h.push('Message-ID: ' + id);
		h.push('Date: ' + mailDate(new Date()));
		h.push('From: ' + encodeAddr(from));
		h.push('To: ' + addrList(d.to).map(encodeAddr).join(', '));
		if (String(d.cc || '').trim()) h.push('Cc: ' + addrList(d.cc).map(encodeAddr).join(', '));
		h.push('Subject: ' + encodeWord(d.subject || ''));
		if (d.inReplyTo) {
			h.push('In-Reply-To: ' + d.inReplyTo);
			h.push('References: ' + (d.references || d.inReplyTo));
		}
		h.push('MIME-Version: 1.0');
		h.push('User-Agent: Daimond');

		var atts = d.attachments || [];
		if (!atts.length) {
			h.push('Content-Type: text/plain; charset=utf-8');
			h.push('Content-Transfer-Encoding: quoted-printable');
			return h.join('\r\n') + '\r\n\r\n' + encodeQP(d.body || '') + '\r\n';
		}

		var bnd = '=_daimond_' + rand(12);
		h.push('Content-Type: multipart/mixed; boundary="' + bnd + '"');
		var out = h.join('\r\n') + '\r\n\r\n'
			+ 'This is a message in MIME format.\r\n'
			+ '--' + bnd + '\r\n'
			+ 'Content-Type: text/plain; charset=utf-8\r\n'
			+ 'Content-Transfer-Encoding: quoted-printable\r\n\r\n'
			+ encodeQP(d.body || '') + '\r\n';
		atts.forEach(function (att) {
			var name = att.name || 'attachment';
			out += '--' + bnd + '\r\n'
				+ 'Content-Type: ' + (att.type || 'application/octet-stream') + '\r\n'
				+ 'Content-Transfer-Encoding: base64\r\n'
				+ 'Content-Disposition: attachment; filename="' + encodeWord(name).replace(/"/g, '') + '"\r\n\r\n'
				+ b64Lines(att.bytes) + '\r\n';
		});
		out += '--' + bnd + '--\r\n';
		return out;
	}

	/// Where a message is posted from, which is not where it was read from: submission is
	/// a different server on a different port, and a preset knows both. An account the
	/// user configured by hand wins over the guess.
	function smtpFor(a) {
		var p = PRESETS[domainOf(a.address)] || {};
		var host = a.smtpHost || p.smtpHost || ('smtp.' + domainOf(a.address));
		var port = parseInt(a.smtpPort || p.smtpPort || 587, 10);
		// 465 is encrypted from the first byte; 587 starts in the clear and must upgrade
		// before the password is spoken. A mailbox may say otherwise — a test server on
		// loopback speaks neither — and what the account says wins over what the port implies.
		return {
			host:     host,
			port:     port,
			security: a.smtpSecurity || (port === 465 ? 'tls' : 'starttls'),
		};
	}

	// ── Drafts ──────────────────────────────────────────────────────
	// A draft is a file: `mail/<address>/drafts/<id>.eml`, the same RFC 5322 bytes that
	// would go on the wire. That makes it legible to every file tool the agent already
	// has — which is the whole of the agent's access to sending. It may WRITE a draft
	// here for the user to read, correct and send; it has no tool that puts a message on
	// the wire, and it is not going to be given one. Only a person pressing Send sends.

	function draftsDir(address) { return mailDir(address) + '/drafts'; }
	function sentDir(address)   { return mailDir(address) + '/sent'; }

	async function saveDraft(d) {
		if (!d.from) throw new Error('A draft needs a mailbox to be from.');
		d.id = d.id || ('draft-' + Date.now() + '-' + rand(3));
		d.messageId = d.messageId || messageId(d.from);
		var path = draftsDir(d.from) + '/' + d.id + '.eml';
		await deps.writeBytes(path, utf8(buildMessage(d)));
		if (deps.refreshFiles) deps.refreshFiles();
		return path;
	}

	/// Every draft held for a mailbox, newest first — including any an agent wrote.
	async function listDrafts(address) {
		var dir = draftsDir(address);
		var listing;
		try { listing = await deps.runTool('file_list', { path: dir }); }
		catch (e) { return []; }
		if (typeof listing !== 'string' || /^\s*Error\b/i.test(listing)) return [];
		var names = listing.split('\n').map(function (l) {
			var m = l.match(/^\s*(?:[-*]\s*)?(\S.*?)(?:\s+\(\d+.*\))?\s*$/);
			return m ? m[1].trim().replace(/\/$/, '') : '';
		}).filter(function (n) { return /\.eml$/i.test(n); });

		var out = [];
		for (var i = 0; i < names.length; i++) {
			var path = dir + '/' + names[i];
			var raw = await deps.runTool('file_read', { path: path });
			if (typeof raw !== 'string' || /^\s*Error\b/i.test(raw)) continue;
			var hs = parseHeaders(raw);
			out.push({
				path:    path,
				id:      names[i].replace(/\.eml$/i, ''),
				to:      decodeWords(header(hs, 'to')),
				subject: decodeWords(header(hs, 'subject')) || '(no subject)',
				date:    header(hs, 'date'),
			});
		}
		out.sort(function (x, y) { return (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0); });
		return out;
	}

	/// Read a draft file back into the thing the compose panel edits. A draft an agent
	/// wrote is an ordinary message file, so it opens the same way.
	async function readDraft(address, path) {
		var raw = await deps.runTool('file_read', { path: path });
		if (typeof raw !== 'string' || /^\s*Error\b/i.test(raw)) {
			throw new Error('That draft could not be read.');
		}
		var hs   = parseHeaders(raw);
		var mime = parseMime(raw, 0);
		var f    = splitAddr(header(hs, 'from'));
		return {
			id:          (path.split('/').pop() || '').replace(/\.eml$/i, ''),
			path:        path,
			from:        f.addr || address,
			fromName:    f.name,
			to:          decodeWords(header(hs, 'to')),
			cc:          decodeWords(header(hs, 'cc')),
			subject:     decodeWords(header(hs, 'subject')),
			body:        mime.plain || (mime.html ? stripHtml(mime.html) : ''),
			inReplyTo:   header(hs, 'in-reply-to'),
			references:  header(hs, 'references'),
			messageId:   header(hs, 'message-id'),
			attachments: mime.attachments,
		};
	}

	async function discardDraft(d) {
		if (!d.path && !d.id) return;
		var path = d.path || (draftsDir(d.from) + '/' + d.id + '.eml');
		try { await deps.runTool('file_delete', { path: path }); } catch (e) { /* never existed */ }
		if (deps.refreshFiles) deps.refreshFiles();
	}

	// ── Sending ─────────────────────────────────────────────────────

	/// Post a draft through the user's own provider.
	///
	/// The envelope recipients are the addresses in To and Cc, and they are named to the
	/// gateway explicitly: a `To:` header is text a person reads, and the envelope is the
	/// instruction the provider acts on. Keeping them one list built here means the two
	/// cannot drift apart.
	async function sendDraft(d) {
		var a = acct(d.from);
		if (!a) throw new Error('Send from a mailbox you have added and synced.');
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			throw new Error('Unlock Daimond with your passphrase first — the mail password is encrypted under it.');
		}
		var rcpt = addrsOf(d.to).concat(addrsOf(d.cc));
		if (!rcpt.length) throw new Error('A message with no recipients cannot be sent.');

		var smtp    = smtpFor(a);
		var raw     = buildMessage(d);
		var payload = b64(utf8(raw));
		var password = await DaimondIdentity.unwrap(a.pass);

		var j = await post('/api/mail/send', {
			address:  a.address,
			host:     smtp.host,
			port:     smtp.port,
			security: smtp.security,
			user:     a.user || a.address,
			password: password,
			rcpt:     rcpt,
			raw:      payload,
		});

		// A sent message is a file too, so "what did I send them" is answerable by the
		// same agent, with the same tools, as "what did they send me".
		try {
			await deps.writeBytes(sentDir(a.address) + '/' + (d.id || rand(6)) + '.eml', utf8(raw));
		} catch (e) { /* the mail is gone whatever the local copy did */ }
		await discardDraft(d);
		return j;
	}

	// ── The sync ────────────────────────────────────────────────────

	/// Sync a mailbox.
	///
	/// A sync normally walks *forwards*: it asks for what arrived after the newest message already
	/// held. With `older` set it reaches *backwards* instead, for the batch just below the oldest
	/// message held — which is the only way to reach mail older than the first batch, since a
	/// mailbox is never pulled down whole.
	async function syncAccount(address, older) {
		var a = acct(address);
		if (!a || state.busy) return;
		if (older && !a.firstUid) return;      // nothing held, so nothing to reach back from
		state.busy = true; state.err = '';
		state.note = (older ? 'Fetching older mail from ' : 'Syncing ') + address + '…';
		render();
		try {
			if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
				throw new Error('Unlock Daimond with your passphrase first — the mail password is encrypted under it.');
			}
			var password = await DaimondIdentity.unwrap(a.pass);

			var body = {
				address:   a.address,
				host:      a.host,
				port:      a.port || 993,
				// 993 is TLS from the first byte; 143 starts in the clear and
				// must upgrade before the password is sent. Without this the
				// gateway assumed TLS on both, so port 143 could never work.
				security:  a.security || (a.port === 143 ? 'starttls' : 'tls'),
				user:      a.user || a.address,
				password:  password,
				mailbox:   'INBOX',
			};
			if (older) body.before_uid = a.firstUid;
			else       body.since_uid  = a.lastUid || 0;
			var j = await post('/api/mail/sync', body);

			// The mailbox generation changed, so every UID held locally names a
			// different message now — or no message. Start again.
			if (a.uidValidity && j.uid_validity && j.uid_validity !== a.uidValidity) {
				a.lastUid = 0;
				a.firstUid = 0;
				a.uidValidity = j.uid_validity;
				save();
				state.note = 'The mailbox was rebuilt on the server; resyncing from the start…';
				render();
				j = await post('/api/mail/sync', Object.assign({}, body, { since_uid: 0, before_uid: 0 }));
			}
			a.uidValidity = j.uid_validity || a.uidValidity;

			var msgs = j.messages || [];
			for (var i = 0; i < msgs.length; i++) {
				var m = msgs[i];
				var bytes = Uint8Array.from(atob(m.raw), function (c) { return c.charCodeAt(0); });
				var path = mailboxDir(a.address) + '/cur/' + maildirName(m.uid, a.uidValidity, m.flags);
				await deps.writeBytes(path, bytes);
				if (m.uid > (a.lastUid || 0)) a.lastUid = m.uid;
				// The oldest UID held is the floor a later "fetch older" reaches back from.
				if (!a.firstUid || m.uid < a.firstUid) a.firstUid = m.uid;
			}
			// What the cap left behind, so the panel can offer to go back for it.
			a.heldBack = j.held_back || 0;
			a.limit    = j.limit || a.limit || 0;
			a.lastSync = Date.now();
			save();

			await rebuildIndex(a);
			await loadDigest(a.address);
			var cost = j.charged_minor ? ' · ' + fmtMinor(j.charged_minor) : '';
			if (!msgs.length) {
				state.note = older ? 'No older mail left to fetch.' : 'Up to date.';
			} else {
				state.note = msgs.length + (older ? ' older' : ' new') + ' message'
					+ (msgs.length === 1 ? '' : 's') + cost
					+ (a.heldBack ? ' · ' + a.heldBack + ' older still on the server' : '');
			}
			if (deps.refreshFiles) deps.refreshFiles();
		} catch (e) {
			state.err = friendly(e);
			state.note = '';
		} finally {
			state.busy = false;
			render();
		}
	}

	/// Walk the whole mailbox down, a batch at a time, until nothing is left on the server.
	///
	/// This is the one action that can pull ten years of mail across the wire, so it says what it
	/// is about to do before it does it, reports progress while it runs, and stops the moment it
	/// is asked to. Every batch is an ordinary sync, so a run that is stopped — or that fails
	/// halfway — leaves the mailbox exactly as consistent as it would have been anyway, and can be
	/// resumed later.
	async function fetchAll(address) {
		var a = acct(address);
		if (!a || state.busy || !a.heldBack) return;

		var total = a.heldBack;
		var ok = await deps.confirm(
			'Fetch all ' + fmtCount(total) + ' remaining messages?',
			'They are downloaded in batches of ' + (a.limit || 25) + ' and written into the '
			+ 'workspace, so a large mailbox takes a while and uses disk. Syncing is metered '
			+ 'against your credits by the megabyte. You can stop part-way; what has arrived '
			+ 'stays.',
			{ ok: 'Fetch all' });
		if (!ok) return;

		state.draining = true;
		var got = 0;
		while (state.draining) {
			var before = a.firstUid;
			await syncAccount(address, true);       // one batch older
			a = acct(address);
			if (!a) break;
			// No progress means the server has nothing further below what we hold: stop, rather
			// than ask again forever.
			if (!a.firstUid || a.firstUid === before) break;
			got = total - (a.heldBack || 0);
			if (!a.heldBack) break;
			if (state.draining) {
				state.note = 'Fetched ' + fmtCount(got) + ' of ' + fmtCount(total) + '…';
				render();
			}
		}
		var stopped = !state.draining;
		state.draining = false;
		a = acct(address);
		state.note = (stopped ? 'Stopped. ' : 'Done. ')
			+ fmtCount(got) + ' message' + (got === 1 ? '' : 's') + ' fetched'
			+ (a && a.heldBack ? ', ' + fmtCount(a.heldBack) + ' still on the server.' : '.');
		render();
	}

	/// A digest of the mailbox, written where the agents look. Without it, an
	/// agent asked "what is in my inbox" has to open every message to find out.
	async function rebuildIndex(a) {
		var msgs = await readMailbox(a.address);
		var lines = [
			'# ' + a.address + ' — INBOX',
			'',
			'Synced ' + new Date(a.lastSync || Date.now()).toISOString() + '. '
				+ msgs.length + ' message' + (msgs.length === 1 ? '' : 's') + '.',
			'The full message is the file named in the last column.',
			'',
			'| UID | Date | From | Subject | File |',
			'|----:|------|------|---------|------|',
		];
		msgs.slice().reverse().forEach(function (m) {
			var cell = function (s) { return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' '); };
			lines.push('| ' + m.uid + ' | ' + cell(m.date) + ' | ' + cell(m.from)
				+ ' | ' + cell(m.subject) + ' | `' + cell(m.file) + '` |');
		});
		await deps.runTool('file_write', {
			path: mailboxDir(a.address) + '/index.md',
			content: lines.join('\n') + '\n',
		});
	}

	/// Read the mailbox back off disk. The files are the truth; nothing about a
	/// message is cached anywhere else, so a mailbox survives a wiped
	/// localStorage and is legible to anything that can read a folder.
	async function readMailbox(address) {
		var dir = mailboxDir(address) + '/cur';
		var listing;
		try {
			listing = await deps.runTool('file_list', { path: dir });
		} catch (e) {
			return [];                       // the workspace is not up yet
		}
		if (typeof listing !== 'string' || /^\s*Error\b/i.test(listing)) return [];
		var out = [];
		var names = listing.split('\n').map(function (l) {
			var m = l.match(/^\s*(?:[-*]\s*)?(\S.*?)(?:\s+\(\d+.*\))?\s*$/);
			return m ? m[1].trim() : '';
		}).filter(function (n) { return n && n.indexOf(':2,') > 0; });

		for (var i = 0; i < names.length; i++) {
			var name = names[i].replace(/\/$/, '');
			var raw = await deps.runTool('file_read', { path: dir + '/' + name });
			if (typeof raw !== 'string' || /^\s*Error\b/i.test(raw)) continue;
			var hs = parseHeaders(raw);
			out.push({
				uid:     parseInt(name.split('.')[0], 10) || 0,
				file:    dir + '/' + name,
				from:    decodeWords(header(hs, 'from')),
				subject: decodeWords(header(hs, 'subject')) || '(no subject)',
				date:    header(hs, 'date'),
				seen:    /:2,[^,]*S/.test(name),
			});
		}
		out.sort(function (x, y) { return x.uid - y.uid; });
		return out;
	}

	async function loadDigest(address) {
		state.msgs = await readMailbox(address);
	}

	// ── The gateway ─────────────────────────────────────────────────

	async function post(path, body) {
		if (!window.DaimondGateway) throw new Error('The account service is unavailable.');
		var st = DaimondGateway.state();
		if (!st.authed) {
			var ok = await DaimondGateway.bootstrap();
			if (!ok) throw new Error('Could not reach the Daimond account service. Try again shortly.');
		}
		var r = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'same-origin',
			body: JSON.stringify(body || {}),
		});
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		if (!r.ok || !j || j.ok === false) {
			throw new Error((j && j.error) || ('HTTP ' + r.status));
		}
		return j;
	}

	/// Ask the gateway what this account may do. Called when the panel opens, so
	/// the panel never advertises a mailbox the account cannot have.
	async function refreshEntitlement() {
		try {
			var st = DaimondGateway.state();
			if (!st.authed) await DaimondGateway.bootstrap();
			var r = await fetch('/api/mail/accounts', { credentials: 'same-origin' });
			var j = await r.json();
			if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
			state.unlocked = !!j.unlocked;
			state.cap = j.max_accounts || state.cap;

			// The price is the gateway's to state, not the client's to assume:
			// a copy here would eventually disagree with what is charged.
			if (!state.unlocked && state.price === null) {
				try {
					var c = await fetch('/api/checkout/pack', { credentials: 'same-origin' });
					var cj = await c.json();
					var t = (cj.tools || []).find(function (x) { return x.tool === 'email'; });
					if (t) state.price = t.price_minor;
				} catch (e2) { /* the pitch reads without a price */ }
			}
		} catch (e) {
			state.unlocked = null;               // unknown, not "locked"
		}
		render();
	}

	async function unlock() {
		try {
			state.busy = true; state.err = ''; render();
			var j = await post('/api/checkout/pack', { pack: 'email' });
			if (!j.url) throw new Error('The checkout session came back without a URL.');
			window.location = j.url;
		} catch (e) {
			state.err = friendly(e);
			state.busy = false;
			render();
		}
	}

	function friendly(e) {
		var m = (e && e.message) ? e.message : String(e);
		return m.replace(/\[[0-9;]*m/g, '');
	}
	function fmtMinor(n) {
		return window.DaimondGateway ? DaimondGateway.fmtMoney(n, 'usd') : ('$' + (n / 100).toFixed(2));
	}
	function ago(ts) {
		if (!ts) return 'never';
		var s = Math.floor((Date.now() - ts) / 1000);
		if (s < 60) return 'just now';
		if (s < 3600) return Math.floor(s / 60) + 'm ago';
		if (s < 86400) return Math.floor(s / 3600) + 'h ago';
		return Math.floor(s / 86400) + 'd ago';
	}

	// ── The panel ───────────────────────────────────────────────────

	function render() {
		if (!els.state) return;

		// The unlock, or the reason there is nothing to show.
		els.state.innerHTML = '';
		if (state.unlocked === false) {
			els.state.appendChild(html(
				'<div class="mail-pitch">'
				+ '<p><b>Daimond can read your mail.</b> Your inbox lands in the workspace as ordinary '
				+ 'files, so every agent can read it, search it, and work from it.</p>'
				+ '<p class="mail-fine">Bought once, kept for good. Covers ' + state.cap + ' mailboxes. '
				+ 'Syncing is metered against credits, like inference. Nothing renews.</p>'
				+ '<p class="mail-fine">Daimond’s gateway makes the connection and forgets your password. '
				+ 'No mail is ever stored on our side.</p>'
				+ '<button class="mail-unlock"' + (state.busy ? ' disabled' : '') + '>Unlock Email'
				+ (state.price ? ' — ' + esc(fmtMinor(state.price)) : '') + '</button>'
				+ '</div>'));
			var ub = els.state.querySelector('.mail-unlock');
			if (ub) ub.addEventListener('click', unlock);
		} else if (state.unlocked === null) {
			els.state.appendChild(html('<div class="mail-fine">The account service is not reachable, '
				+ 'so Daimond cannot tell whether Email is unlocked here.</div>'));
		}
		if (state.err) els.state.appendChild(html('<div class="mail-err">' + esc(state.err) + '</div>'));
		else if (state.note) els.state.appendChild(html('<div class="mail-note">' + esc(state.note) + '</div>'));

		// The mailboxes.
		els.accounts.innerHTML = '';
		if (state.unlocked !== false) {
			state.accounts.forEach(function (a) {
				var row = document.createElement('div');
				row.className = 'mail-acct' + (a.address === state.sel ? ' on' : '');
				row.innerHTML = '<span class="mail-addr">' + esc(a.address) + '</span>'
					+ '<span class="mail-when">' + esc(ago(a.lastSync)) + '</span>';
				var del = document.createElement('button');
				del.className = 'mail-del';
				del.title = 'Remove this mailbox';
				del.textContent = '×';
				del.addEventListener('click', function (ev) {
					ev.stopPropagation();
					removeAccount(a.address);
				});
				row.appendChild(del);
				row.addEventListener('click', function () {
					state.sel = a.address; save();
					Promise.all([loadDigest(a.address), refreshDrafts()]).then(render);
				});
				els.accounts.appendChild(row);
			});
			if (!state.accounts.length && state.unlocked) {
				els.accounts.appendChild(html('<div class="mail-fine">No mailbox yet. '
					+ 'Press <b>+</b> to add one.</div>'));
			}
		}

		// The drafts. Unsent mail sits above the inbox because it is the only thing in the
		// panel that is waiting on the user — and because a draft an agent wrote for them
		// to check would otherwise be written into a folder nobody looks in.
		els.list.innerHTML = '';
		if (state.sel && state.drafts.length) {
			var box = html('<div class="mail-drafts"><div class="mail-drafts-head">Drafts · '
				+ state.drafts.length + '</div></div>');
			state.drafts.forEach(function (d) {
				var row = document.createElement('div');
				row.className = 'mail-draft';
				row.innerHTML = '<div class="mail-subj">' + esc(d.subject) + '</div>'
					+ '<div class="mail-from">' + esc(d.to || '(no recipient)') + '</div>';
				row.addEventListener('click', function () { openDraft(d.path); });
				box.appendChild(row);
			});
			els.list.appendChild(box);
		}

		// The messages.
		if (state.sel && state.msgs.length) {
			state.msgs.slice().reverse().forEach(function (m) {
				var row = document.createElement('div');
				row.className = 'mail-msg' + (m.seen ? '' : ' unread');
				row.innerHTML = '<div class="mail-from">' + esc(m.from || '(unknown)') + '</div>'
					+ '<div class="mail-subj">' + esc(m.subject) + '</div>'
					+ '<div class="mail-date">' + esc((m.date || '').replace(/\s*\(.*\)$/, '')) + '</div>';
				row.addEventListener('click', function () { openMessage(m); });
				els.list.appendChild(row);
			});

			// A sync stops at the cap, and a list that just stops looks like a mailbox that ends.
			// Say what is still up there, and offer to go and get it.
			var sel = acct(state.sel);
			if (sel && sel.heldBack > 0) {
				var n = Math.min(sel.limit || 0, sel.heldBack) || sel.heldBack;
				var more = html(
					'<div class="mail-more">'
					+ '<div class="mail-fine">' + fmtCount(sel.heldBack) + ' older message'
					+ (sel.heldBack === 1 ? '' : 's') + ' still on the server. Daimond fetches the '
					+ 'newest ' + (sel.limit || n) + ' at a time, so your whole mailbox is never '
					+ 'pulled down at once.</div>'
					+ '<div class="mail-more-btns">'
					+ '<button class="mail-older"' + (state.busy ? ' disabled' : '') + '>'
					+ 'Fetch next ' + n + '</button>'
					+ (state.draining
						? '<button class="mail-stop">Stop</button>'
						: '<button class="mail-all"' + (state.busy ? ' disabled' : '') + '>Fetch all</button>')
					+ '</div>'
					+ '</div>');
				var ob = more.querySelector('.mail-older');
				if (ob) ob.addEventListener('click', function () { syncAccount(state.sel, true); });
				var ab = more.querySelector('.mail-all');
				if (ab) ab.addEventListener('click', function () { fetchAll(state.sel); });
				var sb = more.querySelector('.mail-stop');
				if (sb) sb.addEventListener('click', function () { state.draining = false; });
				els.list.appendChild(more);
			}
		} else if (state.sel && state.unlocked !== false) {
			els.list.appendChild(html('<div class="mail-fine">Nothing here yet. Press <b>⟳</b> to sync.</div>'));
		}
	}

	function html(s) {
		var d = document.createElement('div');
		d.innerHTML = s;
		return d.firstElementChild || d;
	}

	/// Show a message where there is room to read it. The body is inserted as
	/// text, never as markup — a mail body is the least trustworthy string in
	/// the application, and this is the one place it meets the DOM.
	/// Walk a MIME tree and collect what a reader needs: the plain part, the HTML part, and every
	/// attachment. `readableText` answers "what does this message say" in one string, which is the
	/// right answer for an index and the wrong one for a person reading their mail — it throws
	/// away the markup, the pictures and the files.
	///
	/// Returns `{ plain, html, attachments: [{ name, type, size, bytes }] }`.
	function parseMime(raw, depth) {
		var out = { plain: '', html: '', attachments: [] };
		if ((depth || 0) > 8) return out;                 // a malformed message must not recurse forever

		var hs    = parseHeaders(raw);
		var ctype = header(hs, 'content-type') || 'text/plain';
		var body  = bodyOf(raw);
		var mb    = ctype.match(/boundary="?([^";]+)"?/i);

		if (/^multipart\//i.test(ctype.trim()) && mb) {
			var parts = body.split('--' + mb[1]);
			parts.forEach(function (p) {
				p = p.replace(/^\r?\n/, '');
				if (!p.trim() || /^--/.test(p)) return;   // the closing delimiter, not a part
				var sub = parseMime(p, (depth || 0) + 1);
				if (!out.plain && sub.plain) out.plain = sub.plain;
				if (!out.html  && sub.html)  out.html  = sub.html;
				out.attachments = out.attachments.concat(sub.attachments);
			});
			return out;
		}

		// A leaf part.
		var enc  = (header(hs, 'content-transfer-encoding') || '').toLowerCase();
		var disp = header(hs, 'content-disposition') || '';
		var name = decodeWords(
			(disp.match(/filename="?([^";]+)"?/i) || ctype.match(/name="?([^";]+)"?/i) || [])[1] || '');

		var decoded = body;
		if (enc === 'base64')                 decoded = decodeB64(body);
		else if (enc === 'quoted-printable')  decoded = decodeQP(body);

		// An attachment is anything the sender marked as one, or any leaf that is not text and
		// carries a filename. Inline images (a signature logo) are attachments too as far as we
		// are concerned: we do not render remote or embedded pictures.
		var isText = /^text\/(plain|html)/i.test(ctype.trim());
		if (/attachment/i.test(disp) || (!isText && name)) {
			var bytes = new Uint8Array(decoded.length);
			for (var i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i) & 0xff;
			out.attachments.push({
				name: name || 'attachment',
				type: (ctype.split(';')[0] || '').trim(),
				size: bytes.length,
				bytes: bytes,
			});
			return out;
		}

		var cs = (ctype.match(/charset="?([^";]+)"?/i) || [])[1];
		var txt = asUtf8(decoded, cs);
		if (/text\/html/i.test(ctype))       out.html  = txt;
		else if (/text\/plain/i.test(ctype)) out.plain = txt;
		else if (!/^multipart\//i.test(ctype.trim()) && !name) out.plain = txt;
		return out;
	}

	/// Split "Jason Hoogland <jason@example.com>" into the two things a reader wants shown
	/// differently: a name to read, and an address to check.
	function splitAddr(s) {
		s = decodeWords(s || '').trim();
		var m = s.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
		if (m) {
			var nm = m[1].replace(/^["']|["']$/g, '').trim();
			return { name: nm, addr: m[2].trim() };
		}
		return { name: '', addr: s };
	}

	async function openMessage(m) {
		var raw = await deps.runTool('file_read', { path: m.file });
		if (typeof raw !== 'string' || /^\s*Error\b/i.test(raw)) {
			state.err = 'That message could not be read.';
			render();
			return;
		}
		var hs    = parseHeaders(raw);
		var mime  = parseMime(raw, 0);
		var view = {
			subject: decodeWords(header(hs, 'subject')) || '(no subject)',
			from:    splitAddr(header(hs, 'from')),
			to:      decodeWords(header(hs, 'to')),
			cc:      decodeWords(header(hs, 'cc')),
			replyTo: decodeWords(header(hs, 'reply-to')),
			date:    header(hs, 'date'),
			html:    mime.html,
			text:    mime.plain || (mime.html ? '' : readableText(raw)),
			attachments: mime.attachments,
			mailbox: state.sel,
			file:    m.file,
			// What a reply to this message must point back at, so it threads rather than
			// arriving as an unrelated message with a similar subject.
			messageId:  header(hs, 'message-id'),
			references: header(hs, 'references'),
			// Saving an attachment is the panel's job, but the workspace is the mail module's:
			// it knows where this mailbox lives on disk.
			save:    async function (att) {
				var dir  = mailboxDir(state.sel) + '/attachments';
				var safe = String(att.name || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_');
				var path = dir + '/' + safe;
				await deps.writeBytes(path, att.bytes);
				if (deps.refreshFiles) deps.refreshFiles();
				return path;
			},
		};
		// The verbs live on the message, where the reader is when they decide to answer it.
		view.reply    = function () { replyTo(view, false); };
		view.replyAll = function () { replyTo(view, true); };
		view.forward  = function () { forward(view); };
		view.canReplyAll = others(view, view.mailbox).length > 0;
		deps.showMessage(view);
	}

	// ── Composing ───────────────────────────────────────────────────

	/// Hand a draft to the compose panel, with the three things it can do to it.
	///
	/// The panel edits fields and hands them back; the draft's threading — its own
	/// `Message-ID`, and what it is a reply to — is not on screen and not editable, so it
	/// is carried here rather than through the DOM.
	function openCompose(d) {
		if (!deps.showCompose) return;
		if (!state.accounts.length) {
			state.err = 'Add a mailbox before writing a message.';
			render();
			return;
		}
		d.from = d.from || state.sel || state.accounts[0].address;
		deps.showCompose({
			draft:   d,
			from:    state.accounts.map(function (a) { return a.address; }),
			send:    async function (fields) { return sendDraft(Object.assign({}, d, fields)); },
			save:    async function (fields) {
				var path = await saveDraft(Object.assign(d, fields));
				await refreshDrafts();
				return path;
			},
			discard: async function () {
				await discardDraft(d);
				await refreshDrafts();
			},
			sent:    function (note) {
				state.note = note;
				state.err = '';
				refreshDrafts().then(render);
			},
		});
	}

	/// The quoted body of a message being answered, in the shape every mail client has
	/// used for thirty years: a line saying who said it, then their words behind `>`.
	function quote(v) {
		var who  = (v.from && (v.from.name || v.from.addr)) || 'they';
		var when = v.date ? new Date(v.date) : null;
		var head = 'On ' + (when && !isNaN(when.getTime()) ? when.toDateString() : (v.date || 'an earlier date'))
			+ ', ' + who + ' wrote:';
		var text = v.text || (v.html ? stripHtml(v.html) : '');
		var body = String(text).split('\n').map(function (l) { return '> ' + l; }).join('\n');
		return '\n\n' + head + '\n' + body + '\n';
	}

	/// Everyone on the message except me: a reply-all that copies the sender back to
	/// themselves is a nuisance, and one that copies *me* is noise in my own inbox.
	function others(v, mine) {
		var seen = {};
		return addrList([v.to, v.cc].filter(Boolean).join(', '))
			.filter(function (x) {
				var a = splitAddr(x).addr.toLowerCase();
				if (!a || a === String(mine || '').toLowerCase() || seen[a]) return false;
				seen[a] = 1;
				return true;
			});
	}

	function replyTo(v, all) {
		var mine = v.mailbox || state.sel;
		var to   = v.replyTo || (v.from && (v.from.name ? v.from.name + ' <' + v.from.addr + '>' : v.from.addr)) || '';
		var subj = /^re:/i.test(v.subject || '') ? v.subject : 'Re: ' + (v.subject || '');
		openCompose({
			from:       mine,
			to:         to,
			cc:         all ? others(v, mine).join(', ') : '',
			subject:    subj,
			body:       quote(v),
			inReplyTo:  v.messageId || '',
			// A thread is the chain of every message before this one, so the reply carries
			// the parent's references and adds the parent itself.
			references: [v.references, v.messageId].filter(Boolean).join(' ').trim(),
			attachments: [],
		});
	}

	function forward(v) {
		var subj = /^fwd?:/i.test(v.subject || '') ? v.subject : 'Fwd: ' + (v.subject || '');
		var head = '\n\n---------- Forwarded message ----------\n'
			+ 'From: ' + ((v.from && (v.from.name ? v.from.name + ' <' + v.from.addr + '>' : v.from.addr)) || '') + '\n'
			+ (v.date ? 'Date: ' + v.date + '\n' : '')
			+ 'Subject: ' + (v.subject || '') + '\n'
			+ (v.to ? 'To: ' + v.to + '\n' : '') + '\n';
		openCompose({
			from:        v.mailbox || state.sel,
			to:          '',
			cc:          '',
			subject:     subj,
			body:        head + (v.text || (v.html ? stripHtml(v.html) : '')),
			// A forward that dropped the attachments would forward the wrong message.
			attachments: (v.attachments || []).slice(),
		});
	}

	async function refreshDrafts() {
		state.drafts = state.sel ? await listDrafts(state.sel) : [];
	}

	async function openDraft(path) {
		try {
			openCompose(await readDraft(state.sel, path));
		} catch (e) {
			state.err = friendly(e);
			render();
		}
	}

	// ── Adding a mailbox ────────────────────────────────────────────

	async function addAccount() {
		if (state.unlocked === false) { unlock(); return; }
		if (state.accounts.length >= state.cap) {
			state.err = 'This unlock covers ' + state.cap + ' mailboxes. Remove one to add another.';
			render();
			return;
		}
		var v = await deps.mailDialog(PRESETS, UNREACHABLE);
		if (!v) return;
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			state.err = 'Unlock Daimond with your passphrase first — the mail password is encrypted under it.';
			render();
			return;
		}
		var wrapped = await DaimondIdentity.wrap(v.password);
		state.accounts.push({
			address:     v.address,
			host:        v.host,
			port:        v.port,
			// Reading and posting are different servers, and the account holds both, so a
			// message can be sent from the mailbox it was read in without asking again.
			smtpHost:    v.smtpHost,
			smtpPort:    v.smtpPort,
			user:        v.user || v.address,
			pass:        wrapped,
			uidValidity: 0,
			lastUid:     0,
			lastSync:    0,
		});
		state.sel = v.address;
		save();
		render();
		syncAccount(v.address);
	}

	async function removeAccount(address) {
		var ok = await deps.confirm('Remove ' + address + '?',
			'The mail already synced stays in the workspace. The mailbox frees a seat on your unlock.',
			{ ok: 'Remove', danger: true });
		if (!ok) return;
		state.accounts = state.accounts.filter(function (a) { return a.address !== address; });
		if (state.sel === address) {
			state.sel = (state.accounts[0] && state.accounts[0].address) || null;
			state.msgs = [];
		}
		save();
		// Free the seat at the gateway, which is the only place the cap is real.
		try {
			await fetch('/api/mail/accounts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify({ address: address }),
			});
		} catch (e) { /* the local list is what the user sees; the seat is retried on the next add */ }
		render();
	}

	// ── Wiring ──────────────────────────────────────────────────────

	function init(d) {
		deps = d;
		var panel = document.getElementById('panel-mail');
		if (!panel) return;
		els.state    = document.getElementById('mail-state');
		els.accounts = document.getElementById('mail-accounts');
		els.list     = document.getElementById('mail-list');
		var add  = panel.querySelector('[data-act="mail-add"]');
		var sync = panel.querySelector('[data-act="mail-sync"]');
		var neu  = panel.querySelector('[data-act="mail-new"]');
		if (add)  add.addEventListener('click', addAccount);
		if (sync) sync.addEventListener('click', function () {
			if (state.sel) syncAccount(state.sel);
		});
		if (neu) neu.addEventListener('click', function () {
			openCompose({ to: '', cc: '', subject: '', body: '', attachments: [] });
		});
		load();
		render();
		// The digest is NOT read here: init runs during boot, before the wasm
		// module that backs the file tools exists, and reading it threw a
		// TypeError into the console. It is read in onOpen(), which runs once
		// the app is up.
	}

	/// Called when the panel is opened, and after a returning Stripe checkout.
	function onOpen() {
		refreshEntitlement();
		if (state.sel) {
			Promise.all([loadDigest(state.sel), refreshDrafts()]).then(render);
		}
	}

	/// Logging out clears the user's content from the DOM. Mail is theirs.
	function clear() {
		state.accounts = [];
		state.msgs = [];
		state.drafts = [];
		state.sel = null;
		state.unlocked = null;
		state.note = '';
		state.err = '';
		render();
	}

	window.DaimondMail = {
		init:    init,
		onOpen:  onOpen,
		clear:   clear,
		sync:    function () { if (state.sel) syncAccount(state.sel); },
		reload:  function () { load(); render(); },
		compose: function () {
			openCompose({ to: '', cc: '', subject: '', body: '', attachments: [] });
		},
		// Exposed for the tests, which have no business driving the DOM to find out whether
		// a message they built is the message that would go on the wire.
		build:   buildMessage,
	};
})();
