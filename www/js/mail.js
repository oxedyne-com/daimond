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

	/// What the app says. The table lives in i18n/en.js; this is the one name
	/// the rest of this file uses. Guarded, because a page that failed to load
	/// the engine should still show its mail rather than nothing.
	function t(k, v)     { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	function tn(k, n, v) { return window.DaimondI18n ? DaimondI18n.tn(k, n, v) : k; }

	var LS      = 'daimond-mail';
	var deps    = null;              // { writeBytes, openFile, refreshFiles, runTool, showDoc }
	var els     = {};
	var state   = {
		accounts: [],                // [{address, host, port, user, pass (wrapped), folder, folders:{}}]
		sel:      null,              // the selected address
		msgs:     [],                // the digest of the selected mailbox
		drafts:   [],                // unsent messages held for the selected mailbox
		// address -> { list: [{name, dir, label, role, selectable, delimiter}], err, busy }
		// The folder list is the SERVER's answer, cached per account for as long
		// as the page lives. Nothing is stored: a folder that was renamed on the
		// server should not go on being offered after a reload.
		folders:  {},
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
	/// The guidance a preset carries is a `note` KEY, not a sentence: the dialog
	/// is built when it opens, so it reads the table then and gets whatever
	/// language is in force at that moment.
	var PRESETS = {
		'gmail.com':      { host: 'imap.gmail.com',        port: 993, smtpHost: 'smtp.gmail.com',        smtpPort: 587, note: 'mail.preset.gmail' },
		'googlemail.com': { host: 'imap.gmail.com',        port: 993, smtpHost: 'smtp.gmail.com',        smtpPort: 587, note: 'mail.preset.gmail_short' },
		'outlook.com':    { host: 'outlook.office365.com', port: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587, note: 'mail.preset.outlook' },
		'hotmail.com':    { host: 'outlook.office365.com', port: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587, note: 'mail.preset.outlook' },
		'live.com':       { host: 'outlook.office365.com', port: 993, smtpHost: 'smtp.office365.com',    smtpPort: 587, note: '' },
		'yahoo.com':      { host: 'imap.mail.yahoo.com',   port: 993, smtpHost: 'smtp.mail.yahoo.com',   smtpPort: 465, note: 'mail.preset.yahoo' },
		'icloud.com':     { host: 'imap.mail.me.com',      port: 993, smtpHost: 'smtp.mail.me.com',      smtpPort: 587, note: 'mail.preset.icloud' },
		'me.com':         { host: 'imap.mail.me.com',      port: 993, smtpHost: 'smtp.mail.me.com',      smtpPort: 587, note: 'mail.preset.icloud' },
		'fastmail.com':   { host: 'imap.fastmail.com',     port: 993, smtpHost: 'smtp.fastmail.com',     smtpPort: 465, note: 'mail.preset.fastmail' },
		'fastmail.fm':    { host: 'imap.fastmail.com',     port: 993, smtpHost: 'smtp.fastmail.com',     smtpPort: 465, note: '' },
		'zoho.com':       { host: 'imap.zoho.com',         port: 993, smtpHost: 'smtp.zoho.com',         smtpPort: 587, note: '' },
		'aol.com':        { host: 'imap.aol.com',          port: 993, smtpHost: 'smtp.aol.com',          smtpPort: 465, note: '' },
	};

	/// Providers that have no IMAP server anyone else can reach. Saying so is
	/// the honest thing; letting the user type a password into a form that
	/// cannot work is not. The value is a key, as with the presets above.
	var UNREACHABLE = {
		'proton.me':      'mail.unreachable.proton',
		'protonmail.com': 'mail.unreachable.proton',
		'pm.me':          'mail.unreachable.proton',
		'tutanota.com':   'mail.unreachable.tuta',
		'tuta.io':        'mail.unreachable.tuta',
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
			state.accounts.forEach(liftFolders);
			state.sel = j.sel || (state.accounts[0] && state.accounts[0].address) || null;
		} catch (e) { state.accounts = []; }
	}

	/// An account's sync watermarks used to be the account's, because there was
	/// one mailbox and it was the inbox. They belong to a FOLDER — `uidvalidity`
	/// is per-mailbox and so is every UID under it — so an older record has its
	/// four numbers lifted into the inbox's slot rather than being discarded,
	/// which would re-download an inbox that is already on disk.
	function liftFolders(a) {
		if (!a.folder) a.folder = 'INBOX';
		if (a.folders && a.folders[a.folder]) return;
		a.folders = a.folders || {};
		a.folders.INBOX = a.folders.INBOX || {
			dir:         'INBOX',
			uidValidity: a.uidValidity || 0,
			lastUid:     a.lastUid  || 0,
			firstUid:    a.firstUid || 0,
			heldBack:    a.heldBack || 0,
			limit:       a.limit    || 0,
			lastSync:    a.lastSync || 0,
		};
		if (!a.folders[a.folder]) a.folders[a.folder] = blankFolder(a.folder);
	}

	function blankFolder(name) {
		return {
			dir: dirFor(name), uidValidity: 0, lastUid: 0, firstUid: 0,
			heldBack: 0, limit: 0, lastSync: 0,
		};
	}

	/// The per-folder record for an account, made if this is the first time the
	/// folder has been looked at.
	function fld(a, name) {
		if (!a) return null;
		name = name || a.folder || 'INBOX';
		a.folders = a.folders || {};
		if (!a.folders[name]) a.folders[name] = blankFolder(name);
		return a.folders[name];
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
					var q = txt.replace(/_/g, ' ');
					var arr = [];
					for (var i = 0; i < q.length; i++) {
						if (q[i] === '=' && /[0-9a-f]{2}/i.test(q.substr(i + 1, 2))) {
							arr.push(parseInt(q.substr(i + 1, 2), 16)); i += 2;
						} else { arr.push(q.charCodeAt(i)); }
					}
					bytes = new Uint8Array(arr);
				}
				return new TextDecoder(cs.toLowerCase().replace(/^utf8$/, 'utf-8')).decode(bytes);
			} catch (e) { return txt; }
		}).replace(/\?=\s*=\?/g, '');
	}

	/// A date the reader can read, in the language the interface is speaking.
	/// `toDateString` is English whatever the locale, which is what this quoted
	/// a reply's date in for every user in the world.
	function longDate(d) {
		var loc = window.DaimondI18n ? DaimondI18n.locale() : undefined;
		try {
			return d.toLocaleDateString(loc,
				{ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
		} catch (e) { return d.toDateString(); }
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
		var bare = String(html)
			.replace(/<style[\s\S]*?<\/style>/gi, '')
			.replace(/<script[\s\S]*?<\/script>/gi, '')
			.replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]+>/g, '');
		var d = document.createElement('textarea');
		d.innerHTML = bare;                              // entity decode only
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

	/// A folder name as one path segment.
	///
	/// A server names its folders in its own alphabet, with its own separator:
	/// `[Gmail]/All Mail`, `Работа`, `INBOX.Sent`. None of that can be a
	/// directory name here, so it is flattened — and, because flattening can
	/// collide (`A/B` and `A_B` both give `A_B`), anything that had to be
	/// changed carries a short hash of the ORIGINAL name. The server's own
	/// spelling is what a sync sends; this is only where the files sit.
	function dirFor(name) {
		name = String(name == null ? '' : name);
		if (name === 'INBOX') return 'INBOX';           // the shape already on disk
		var safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
		// A name of nothing but dots is `.` or `..`, which are not folder names
		// but instructions to a filesystem. They never reach one from here.
		if (/^\.+$/.test(safe)) safe = '';
		if (safe === name && safe) return safe;
		return (safe || 'folder') + '-' + hash36(name);
	}

	/// A short, stable hash of a string. Not a security property: it is a
	/// suffix that keeps two different folder names in two different folders.
	function hash36(s) {
		var h = 5381;
		for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
		return h.toString(36);
	}

	function mailboxDir(address, folder) {
		var a = acct(address);
		var name = folder || (a && a.folder) || 'INBOX';
		var f = a ? fld(a, name) : null;
		return mailDir(address) + '/' + ((f && f.dir) || dirFor(name));
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
		if (!d.from) throw new Error(t('mail.err.draft_needs_mailbox'));
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
				subject: decodeWords(header(hs, 'subject')) || t('mail.no_subject'),
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
			throw new Error(t('mail.err.draft_unreadable'));
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
		if (!a) throw new Error(t('mail.err.send_from_added'));
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			throw new Error(t('mail.err.unlock_first'));
		}
		var rcpt = addrsOf(d.to).concat(addrsOf(d.cc));
		if (!rcpt.length) throw new Error(t('mail.err.no_recipients'));

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
	async function syncAccount(address, older, folder) {
		var a = acct(address);
		if (!a || state.busy) return;
		var name = folder || a.folder || 'INBOX';
		var f    = fld(a, name);
		if (older && !f.firstUid) return;      // nothing held, so nothing to reach back from
		state.busy = true; state.err = '';
		state.note = t(older ? 'mail.note.fetching_older' : 'mail.note.syncing',
			{ address: address, folder: labelFor(a, name) });
		render();
		try {
			if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
				throw new Error(t('mail.err.unlock_first'));
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
				// The SERVER's spelling, not the flattened directory name: this
				// is the string it will SELECT.
				mailbox:   name,
			};
			if (older) body.before_uid = f.firstUid;
			else       body.since_uid  = f.lastUid || 0;
			var j = await post('/api/mail/sync', body);

			// The mailbox generation changed, so every UID held locally names a
			// different message now — or no message. Start again. It is the
			// FOLDER's generation: two folders on one server have two of them.
			if (f.uidValidity && j.uid_validity && j.uid_validity !== f.uidValidity) {
				f.lastUid = 0;
				f.firstUid = 0;
				f.uidValidity = j.uid_validity;
				save();
				state.note = t('mail.note.rebuilt');
				render();
				j = await post('/api/mail/sync', Object.assign({}, body, { since_uid: 0, before_uid: 0 }));
			}
			f.uidValidity = j.uid_validity || f.uidValidity;

			var msgs = j.messages || [];
			for (var i = 0; i < msgs.length; i++) {
				var m = msgs[i];
				var bytes = Uint8Array.from(atob(m.raw), function (c) { return c.charCodeAt(0); });
				var path = mailboxDir(a.address, name) + '/cur/'
					+ maildirName(m.uid, f.uidValidity, m.flags);
				await deps.writeBytes(path, bytes);
				if (m.uid > (f.lastUid || 0)) f.lastUid = m.uid;
				// The oldest UID held is the floor a later "fetch older" reaches back from.
				if (!f.firstUid || m.uid < f.firstUid) f.firstUid = m.uid;
			}
			// What the cap left behind, so the panel can offer to go back for it.
			f.heldBack = j.held_back || 0;
			f.limit    = j.limit || f.limit || 0;
			f.lastSync = Date.now();
			a.lastSync = f.lastSync;           // the account's row shows its latest sync
			save();

			await rebuildIndex(a, name);
			await loadDigest(a.address, name);
			var parts = [];
			if (!msgs.length) {
				parts.push(t(older ? 'mail.note.no_older' : 'mail.note.up_to_date'));
			} else {
				parts.push(tn(older ? 'mail.note.older' : 'mail.note.new', msgs.length));
				if (j.charged_minor) parts.push(fmtMinor(j.charged_minor));
				if (f.heldBack) parts.push(tn('mail.note.still_older', f.heldBack));
			}
			state.note = parts.join(' · ');
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
		if (!a || state.busy) return;
		var name = a.folder || 'INBOX';
		var f = fld(a, name);
		if (!f.heldBack) return;

		var total = f.heldBack;
		var ok = await deps.confirm(
			t('mail.all.title', { n: fmtCount(total) }),
			t('mail.all.body',  { batch: f.limit || 25 }),
			{ ok: t('mail.all.ok') });
		if (!ok) return;

		state.draining = true;
		var got = 0;
		while (state.draining) {
			var before = f.firstUid;
			await syncAccount(address, true, name);       // one batch older
			a = acct(address);
			if (!a) break;
			f = fld(a, name);
			// No progress means the server has nothing further below what we hold: stop, rather
			// than ask again forever.
			if (!f.firstUid || f.firstUid === before) break;
			got = total - (f.heldBack || 0);
			if (!f.heldBack) break;
			if (state.draining) {
				state.note = t('mail.all.progress',
					{ got: fmtCount(got), total: fmtCount(total) });
				render();
			}
		}
		var stopped = !state.draining;
		state.draining = false;
		a = acct(address);
		f = a ? fld(a, name) : null;
		var count = tn('mail.all.count', got, { n: fmtCount(got) });
		state.note = (f && f.heldBack)
			? t(stopped ? 'mail.all.stopped_left' : 'mail.all.done_left',
				{ count: count, left: fmtCount(f.heldBack) })
			: t(stopped ? 'mail.all.stopped' : 'mail.all.done', { count: count });
		render();
	}

	/// A digest of the mailbox, written where the agents look. Without it, an
	/// agent asked "what is in my inbox" has to open every message to find out.
	async function rebuildIndex(a, folder) {
		var name = folder || a.folder || 'INBOX';
		var f    = fld(a, name);
		var msgs = await readMailbox(a.address, name);
		// English, and deliberately so: this file is written for the agents'
		// file tools to read, and a digest whose column headings move with the
		// interface language would be a moving target for every prompt.
		var lines = [
			'# ' + a.address + ' — ' + name,
			'',
			'Synced ' + new Date(f.lastSync || Date.now()).toISOString() + '. '
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
			path: mailboxDir(a.address, name) + '/index.md',
			content: lines.join('\n') + '\n',
		});
	}

	/// Read the mailbox back off disk. The files are the truth; nothing about a
	/// message is cached anywhere else, so a mailbox survives a wiped
	/// localStorage and is legible to anything that can read a folder.
	async function readMailbox(address, folder) {
		var dir = mailboxDir(address, folder) + '/cur';
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
				subject: decodeWords(header(hs, 'subject')) || t('mail.no_subject'),
				date:    header(hs, 'date'),
				seen:    /:2,[^,]*S/.test(name),
			});
		}
		out.sort(function (x, y) { return x.uid - y.uid; });
		return out;
	}

	async function loadDigest(address, folder) {
		state.msgs = await readMailbox(address, folder);
	}

	// ── The gateway ─────────────────────────────────────────────────

	async function post(path, body) {
		if (!window.DaimondGateway) throw new Error(t('mail.err.service_unavailable'));
		var st = DaimondGateway.state();
		if (!st.authed) {
			var ok = await DaimondGateway.bootstrap();
			if (!ok) throw new Error(t('mail.err.service_unreachable'));
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
		// Syncing and sending cost credits, and the reply says what is left. One place owns
		// that number; this hands it over rather than letting the header go stale.
		if (window.DaimondGateway && DaimondGateway.noteBalance) DaimondGateway.noteBalance(j);
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

			// Email is part of Pro now, not a separate purchase, so there is no
			// à la carte price to fetch: the pitch points at Pro instead.
		} catch (e) {
			state.unlocked = null;               // unknown, not "locked"
		}
		render();
	}

	// ── Folders ─────────────────────────────────────────────────────
	// A mailbox is not an inbox. The gateway asks the server what it has
	// (`LIST`) and hands back each folder's own spelling — which may be
	// localised (`[Gmail]/Gesendet`), nested, or a container holding no mail at
	// all. What is NOT localised is the RFC 6154 role, so a folder the server
	// declares `\Sent` is called Sent here whatever the server calls it.
	//
	// Nothing about the list is stored. A folder renamed on the server should
	// stop being offered the moment the page is reloaded, and the files already
	// pulled out of it stay where they are either way.

	/// The order roles are offered in — the order a mail client has put them in
	/// for thirty years, rather than the order the server happened to answer.
	var ROLE_ORDER = ['drafts', 'sent', 'archive', 'flagged', 'junk', 'trash', 'all'];

	/// What a folder is called on screen: the role's name where the server
	/// declares one, and the server's own spelling where it does not.
	function labelFor(a, name) {
		if (name === 'INBOX') return t('mail.folder.inbox');
		var e = folderEntry(a, name);
		if (e && e.role && ROLE_ORDER.indexOf(e.role) >= 0) return t('mail.folder.' + e.role);
		return name;
	}

	function folderEntry(a, name) {
		var c = a && state.folders[a.address];
		if (!c || !c.list) return null;
		for (var i = 0; i < c.list.length; i++) if (c.list[i].name === name) return c.list[i];
		return null;
	}

	/// Put the server's answer in the order and shape the panel draws.
	function shapeFolders(raw) {
		var out = (raw || []).map(function (f) {
			return {
				name:       String(f.name || ''),
				role:       f.role || '',
				selectable: f.selectable !== false,
				delimiter:  f.delimiter || '',
			};
		}).filter(function (f) { return f.name; });
		// A server that does not name its inbox in LIST still has one.
		if (!out.some(function (f) { return f.name === 'INBOX'; })) {
			out.unshift({ name: 'INBOX', role: '', selectable: true, delimiter: '' });
		}
		// The inbox first, then the roles every mail client has put in that
		// order for thirty years, then the folders the user made — and All Mail
		// below all of them. It is a copy of everything already listed above it,
		// so it is the one entry that is never what somebody meant to open.
		var rank = function (f) {
			if (f.name === 'INBOX')  return -1;
			if (f.role === 'all')    return ROLE_ORDER.length + 1;
			var i = ROLE_ORDER.indexOf(f.role);
			return i < 0 ? ROLE_ORDER.length : i;
		};
		out.sort(function (x, y) {
			var d = rank(x) - rank(y);
			if (d) return d;
			return x.name.localeCompare(y.name);
		});
		return out;
	}

	/// Ask the server what folders it has. Free — the gateway charges nothing
	/// for a LIST — so it runs when the panel opens and when the account
	/// changes, and again whenever the user asks.
	async function loadFolders(address, force) {
		var a = acct(address);
		if (!a) return;
		var cur = state.folders[address];
		if (cur && cur.busy) return;
		if (cur && cur.list && !force) return;
		// The password is encrypted under the passphrase. A locked device is not
		// an error here; it simply means the inbox is all that can be offered.
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return;
		state.folders[address] = { busy: true, err: '', list: (cur && cur.list) || null };
		render();
		try {
			var password = await DaimondIdentity.unwrap(a.pass);
			var j = await post('/api/mail/folders', {
				address:  a.address,
				host:     a.host,
				port:     a.port || 993,
				security: a.security || (a.port === 143 ? 'starttls' : 'tls'),
				user:     a.user || a.address,
				password: password,
			});
			state.folders[address] = { busy: false, err: '', list: shapeFolders(j.folders) };
			// A folder that is no longer there cannot go on being the selected
			// one, or every sync would ask for a mailbox the server has not got.
			var list = state.folders[address].list;
			if (a.folder && !list.some(function (f) { return f.name === a.folder && f.selectable; })) {
				a.folder = 'INBOX';
				save();
				await loadDigest(address, 'INBOX');
			}
		} catch (e) {
			state.folders[address] = {
				busy: false,
				err:  t('mail.folders_err', { reason: friendly(e) }),
				list: (cur && cur.list) || null,
			};
		}
		render();
	}

	/// Move to another folder of the same account. The messages already on disk
	/// are read straight back; nothing is fetched until a sync is asked for.
	async function selectFolder(name) {
		var a = acct(state.sel);
		if (!a || a.folder === name) return;
		a.folder = name;
		fld(a, name);
		save();
		state.note = '';
		state.err  = '';
		await loadDigest(a.address, name);
		render();
		// A folder opened for the first time holds nothing, and an empty list
		// looks like an empty folder rather than one never fetched. Go and get
		// its first batch, which is what the user meant by opening it.
		if (!state.msgs.length && !fld(a, name).lastSync) syncAccount(a.address, false, name);
	}

	/// Email rides Pro now, so the button opens the Pro surface in Credits
	/// rather than a checkout of its own. The purchase, the return handling and
	/// the "you own it" confirmation all live in one place.
	function unlock() {
		if (window.DaimondAdmin && DaimondAdmin.credits) DaimondAdmin.credits(t('mail.pro_pitch'));
	}

	function friendly(e) {
		var m = (e && e.message) ? e.message : String(e);
		return m.replace(/\[[0-9;]*m/g, '');
	}
	function fmtMinor(n) {
		return window.DaimondGateway ? DaimondGateway.fmtMoney(n, 'usd') : ('$' + (n / 100).toFixed(2));
	}
	function ago(ts) {
		if (!ts) return t('mail.ago.never');
		var s = Math.floor((Date.now() - ts) / 1000);
		if (s < 60)    return t('mail.ago.just_now');
		if (s < 3600)  return t('mail.ago.mins',  { n: Math.floor(s / 60) });
		if (s < 86400) return t('mail.ago.hours', { n: Math.floor(s / 3600) });
		return t('mail.ago.days', { n: Math.floor(s / 86400) });
	}

	// ── The panel ───────────────────────────────────────────────────

	function render() {
		if (!els.state) return;

		// The unlock, or the reason there is nothing to show.
		els.state.innerHTML = '';
		if (state.unlocked === false) {
			els.state.appendChild(html(
				'<div class="mail-pitch">'
				+ '<p>' + t('mail.pitch.head') + '</p>'
				+ '<p class="mail-fine">' + t('mail.pitch.fine', { cap: state.cap }) + '</p>'
				+ '<p class="mail-fine">' + t('mail.pitch.privacy') + '</p>'
				+ '<button class="mail-unlock"' + (state.busy ? ' disabled' : '') + '>'
				+ esc(t('pro.buy')) + '</button>'
				+ '</div>'));
			var ub = els.state.querySelector('.mail-unlock');
			if (ub) ub.addEventListener('click', unlock);
		} else if (state.unlocked === null) {
			els.state.appendChild(html('<div class="mail-fine">'
				+ esc(t('mail.pitch.unknown')) + '</div>'));
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
				del.title = t('mail.remove_mailbox');
				del.textContent = '×';
				del.addEventListener('click', function (ev) {
					ev.stopPropagation();
					removeAccount(a.address);
				});
				row.appendChild(del);
				row.addEventListener('click', function () {
					state.sel = a.address; save();
					Promise.all([loadDigest(a.address), refreshDrafts()]).then(render);
					loadFolders(a.address);
				});
				els.accounts.appendChild(row);
			});
			if (!state.accounts.length && state.unlocked) {
				els.accounts.appendChild(html('<div class="mail-fine">'
					+ t('mail.no_mailbox') + '</div>'));
			}
		}

		renderFolders();

		// The drafts. Unsent mail sits above the inbox because it is the only thing in the
		// panel that is waiting on the user — and because a draft an agent wrote for them
		// to check would otherwise be written into a folder nobody looks in.
		els.list.innerHTML = '';
		if (state.sel && state.drafts.length) {
			var box = html('<div class="mail-drafts"><div class="mail-drafts-head">'
				+ esc(t('mail.drafts_head', { n: state.drafts.length })) + '</div></div>');
			state.drafts.forEach(function (d) {
				var row = document.createElement('div');
				row.className = 'mail-draft';
				row.innerHTML = '<div class="mail-subj">' + esc(d.subject) + '</div>'
					+ '<div class="mail-from">' + esc(d.to || t('mail.no_recipient')) + '</div>';
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
				row.innerHTML = '<div class="mail-from">' + esc(m.from || t('mail.unknown_sender')) + '</div>'
					+ '<div class="mail-subj">' + esc(m.subject) + '</div>'
					+ '<div class="mail-date">' + esc((m.date || '').replace(/\s*\(.*\)$/, '')) + '</div>';
				row.addEventListener('click', function () { openMessage(m); });
				els.list.appendChild(row);
			});

			// A sync stops at the cap, and a list that just stops looks like a mailbox that ends.
			// Say what is still up there, and offer to go and get it.
			var sel = acct(state.sel);
			var sf  = sel ? fld(sel) : null;
			if (sf && sf.heldBack > 0) {
				var n = Math.min(sf.limit || 0, sf.heldBack) || sf.heldBack;
				var more = html(
					'<div class="mail-more">'
					+ '<div class="mail-fine">'
					+ esc(tn('mail.more.note', sf.heldBack,
						{ n: fmtCount(sf.heldBack), batch: sf.limit || n }))
					+ '</div>'
					+ '<div class="mail-more-btns">'
					+ '<button class="mail-older"' + (state.busy ? ' disabled' : '') + '>'
					+ esc(t('mail.more.next', { n: n })) + '</button>'
					+ (state.draining
						? '<button class="mail-stop">' + esc(t('mail.more.stop')) + '</button>'
						: '<button class="mail-all"' + (state.busy ? ' disabled' : '') + '>'
							+ esc(t('mail.more.all')) + '</button>')
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
			els.list.appendChild(html('<div class="mail-fine">' + t('mail.nothing_yet') + '</div>'));
		}
	}

	/// The folder picker: which of the account's mailboxes the list below is
	/// showing. It is drawn only when there is an account to have folders, and
	/// stays a single row — the inbox — until the server has answered.
	function renderFolders() {
		if (!els.folders) return;
		els.folders.innerHTML = '';
		var a = acct(state.sel);
		if (!a || state.unlocked === false) return;

		var cache = state.folders[a.address] || {};
		var list  = cache.list || [{ name: 'INBOX', role: '', selectable: true }];

		var head = html('<div class="mail-folders-head">'
			+ '<span>' + esc(t('mail.folders')) + '</span>'
			+ '<button class="mail-refresh" title="' + esc(t('mail.folders_refresh')) + '"'
			+ (cache.busy ? ' disabled' : '') + '>⟳</button></div>');
		var hb = head.querySelector('.mail-refresh');
		hb.addEventListener('click', function () { loadFolders(a.address, true); });
		els.folders.appendChild(head);

		var box = document.createElement('div');
		box.className = 'mail-folder-list';
		list.forEach(function (f) {
			var row = document.createElement('div');
			// `mail-acct` carries the row's shape and its selected state already:
			// a folder is the same kind of choice as a mailbox, one level down.
			row.className = 'mail-acct mail-folder' + (f.name === (a.folder || 'INBOX') ? ' on' : '');
			row.setAttribute('data-folder', f.name);
			if (f.role) row.setAttribute('data-role', f.role);
			var depth = f.delimiter ? f.name.split(f.delimiter).length - 1 : 0;
			if (depth > 0) row.style.setProperty('--folder-depth', depth);
			row.innerHTML = '<span class="mail-addr">' + esc(labelFor(a, f.name)) + '</span>';
			if (!f.selectable) {
				// A container, not a mailbox: `[Gmail]` holds folders, not mail.
				row.setAttribute('aria-disabled', 'true');
			} else {
				row.addEventListener('click', function () { selectFolder(f.name); });
			}
			box.appendChild(row);
		});
		els.folders.appendChild(box);

		if (cache.busy) {
			els.folders.appendChild(html('<div class="mail-fine">'
				+ esc(t('mail.folders_loading')) + '</div>'));
		} else if (cache.err) {
			els.folders.appendChild(html('<div class="mail-fine">' + esc(cache.err) + '</div>'));
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
			state.err = t('mail.err.msg_unreadable');
			render();
			return;
		}
		var hs    = parseHeaders(raw);
		var mime  = parseMime(raw, 0);
		var view = {
			subject: decodeWords(header(hs, 'subject')) || t('mail.no_subject'),
			from:    splitAddr(header(hs, 'from')),
			to:      decodeWords(header(hs, 'to')),
			cc:      decodeWords(header(hs, 'cc')),
			replyTo: decodeWords(header(hs, 'reply-to')),
			date:    header(hs, 'date'),
			html:    mime.html,
			text:    mime.plain || (mime.html ? '' : readableText(raw)),
			attachments: mime.attachments,
			mailbox: state.sel,
			// The folder it was read from, so an attachment saved out of it
			// lands beside the message rather than in the inbox.
			folder:  (acct(state.sel) || {}).folder || 'INBOX',
			file:    m.file,
			// What a reply to this message must point back at, so it threads rather than
			// arriving as an unrelated message with a similar subject.
			messageId:  header(hs, 'message-id'),
			references: header(hs, 'references'),
			// Saving an attachment is the panel's job, but the workspace is the mail module's:
			// it knows where this mailbox lives on disk.
			save:    async function (att) {
				var dir  = mailboxDir(state.sel, view.folder) + '/attachments';
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
			state.err = t('mail.err.add_mailbox_first');
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
		var who  = (v.from && (v.from.name || v.from.addr)) || t('mail.quote.they');
		var when = v.date ? new Date(v.date) : null;
		var dated = when && !isNaN(when.getTime());
		// A quote with no readable date used to put the phrase "an earlier date"
		// into a slot the sentence was built around a DATE for, which every
		// translator then had to work around. An undated quote gets its own
		// sentence instead.
		var head = dated
			? t('mail.quote.head', { date: longDate(when), who: who })
			: t('mail.quote.head_undated', { who: who });
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
		// The separator is what the reader sees; the four field names below it
		// are the message's own headers, and stay spelled as headers are.
		var head = '\n\n' + t('mail.fwd.sep') + '\n'
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
			state.err = tn('mail.err.cap', state.cap);
			render();
			return;
		}
		var v = await deps.mailDialog(PRESETS, UNREACHABLE);
		if (!v) return;
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			state.err = t('mail.err.unlock_first');
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
			// The inbox is where a new mailbox starts; the rest of its folders
			// arrive when the server is asked what it has.
			folder:      'INBOX',
			folders:     { INBOX: blankFolder('INBOX') },
			lastSync:    0,
		});
		state.sel = v.address;
		save();
		render();
		syncAccount(v.address);
		loadFolders(v.address, true);
	}

	async function removeAccount(address) {
		var ok = await deps.confirm(t('mail.remove.title', { address: address }),
			t('mail.remove.body'),
			{ ok: t('mail.remove.ok'), danger: true });
		if (!ok) return;
		state.accounts = state.accounts.filter(function (a) { return a.address !== address; });
		delete state.folders[address];
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
		els.folders  = document.getElementById('mail-folders');
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
			var a = acct(state.sel);
			Promise.all([loadDigest(state.sel, a && a.folder), refreshDrafts()]).then(render);
			// Free, so it can be asked every time the panel is opened; cached,
			// so it is asked of the server once per account per page.
			loadFolders(state.sel);
		}
	}

	/// Logging out clears the user's content from the DOM. Mail is theirs.
	function clear() {
		state.accounts = [];
		state.msgs = [];
		state.drafts = [];
		state.folders = {};
		state.sel = null;
		state.unlocked = null;
		state.note = '';
		state.err = '';
		render();
	}

	// The panel stays mounted once it is open, so a language change has to
	// redraw it where it stands rather than waiting for it to be built again.
	if (window.DaimondI18n) {
		DaimondI18n.onChange(function () { if (els.state) render(); });
	}

	window.DaimondMail = {
		init:    init,
		/// Whether any account is configured. The Message and Compose panels are
		/// held off the chip row until one is, since neither means anything
		/// without somewhere for mail to come from.
		hasAccounts: function () { return state.accounts.length > 0; },
		onOpen:  onOpen,
		clear:   clear,
		sync:    function () { if (state.sel) syncAccount(state.sel); },
		reload:  function () { load(); render(); },
		/// The folder list held for an account, and the way to ask for it
		/// again. Exposed so a test can see what the server offered without
		/// reading it back out of the DOM.
		folders:      function (address) {
			var c = state.folders[address || state.sel];
			return (c && c.list) ? c.list.slice() : [];
		},
		loadFolders:  function (address, force) { return loadFolders(address || state.sel, force); },
		folder:       function () { var a = acct(state.sel); return (a && a.folder) || 'INBOX'; },
		selectFolder: selectFolder,
		/// Where a folder's messages sit in the workspace.
		folderDir:    function (address, name) { return mailboxDir(address || state.sel, name); },
		compose: function () {
			openCompose({ to: '', cc: '', subject: '', body: '', attachments: [] });
		},
		// Exposed for the tests, which have no business driving the DOM to find out whether
		// a message they built is the message that would go on the wire.
		build:   buildMessage,
	};
})();
