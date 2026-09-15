/// feed.js -- the followers-only feed: what this account writes to the people it
/// has approved, and what the people it follows have written.
///
/// ## What is different here, and it is the whole file
///
/// Every other thing the Social panel carries is SEALED. A message, a roster and
/// a shared diamond reach the relay as ciphertext and leave it as ciphertext, and
/// the gateway carries bytes it cannot read. A feed post does not: it is stored on
/// Oxedyne's gateway IN THE CLEAR, shown to the followers the author approved and
/// to nobody else, readable by the operator so that a report can be acted on, and
/// deletable. That is the trade the feature is, and the screens in here say it in
/// as many words -- there is no seal to point at, so the words are all there is.
///
/// Two consequences run through everything below:
///
///  1. **No post body is ever written to this device's record.** The record keeps
///     ids and marks (`DaimondPost.feedState`), never words. A deletion therefore
///     propagates on the next read, because there is no cached copy to go stale.
///  2. **`{ok:true}` on a follow request means nothing about whether it was
///     stored.** The gateway answers a blocked ask exactly as it answers an
///     ordinary one, so nothing in here may say "requested" as though it were a
///     fact about the other person, and nothing may infer a block.
///
/// ## What this module owns
///
/// The inside of `#social-feed-list`, and nothing else on the page. The panel's
/// head, chips and empty line belong to js/improve.js; the record, the transport
/// and the tray belong to js/post.js, which this file reaches through
/// `DaimondPost` rather than repeating. There is one relay door in this app and
/// this is not a second one.
///
/// Attaches one global, `window.DaimondFeed`.
(function () {
	'use strict';

	// ── Saying things ──────────────────────────────────────────

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string from the table, or the English written at the call site where the
	/// table has no entry for it yet. The same helper post.js carries.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return v[name] != null ? String(v[name]) : whole;
		});
	}

	function log(/* ...args */) {
		try {
			if (!window.DAIMOND_DEBUG) return;
			console.log.apply(console, ['[feed]'].concat([].slice.call(arguments)));
		} catch (e) { /* no console */ }
	}

	// ── Where things are ───────────────────────────────────────

	/// The region the Social panel gives this module.
	var HOST = '#social-feed-list';

	/// Which view of the Social panel this module owns.
	var VIEW = 'feed';

	/// The most a post may carry, in bytes of UTF-8. The gateway's
	/// `FEED_POST_MAX_BYTES` exactly: checked here so a person is told before they
	/// have pressed anything, and checked there because that is the authority.
	var POST_MAX = 4096;

	/// How long the merged read may go unmade while the app is up. A feed post is
	/// NOT delivered and NOT doorbelled -- a doorbell is for a message to you --
	/// so this cadence is the whole of how a signed-in reader learns there is
	/// something new, and five minutes is the latency that buys.
	var POLL_MS = 5 * 60 * 1000;

	/// How often the cadence is CONSIDERED. A tick that finds the errand channel
	/// dead or the five minutes unspent does nothing at all.
	var TICK_MS = 60 * 1000;

	// ── What is held, none of which is words ───────────────────

	var _tab    = 'following';	// which half is drawn
	var _rows   = [];			// the merged read, newest first
	var _more   = false;		// the merged read had more above the mark
	var _mine   = null;			// { handle, rows, followers, pending } or null
	var _list   = null;			// `?view=followers` -> { approved, pending }
	var _follow = null;			// `?view=following` -> { <pub>: approved|requested }
	var _say    = '';			// the one status line under the box
	var _draft  = '';			// what is half-typed, kept across a redraw
	var _lastRead = 0;			// when the merged read last completed
	var _ticking  = false;

	// ── The relay ──────────────────────────────────────────────
	//
	// THROUGH post.js's OWN DOOR. `DaimondPost.call` is the path, the api header
	// and the deadline handling this app has one of; a second fetch here would be
	// a second place for a gateway version gate to be got wrong.

	function gone() {
		return { status: 0, json: null, off: true };
	}

	async function ask(query) {
		if (!window.DaimondPost || !DaimondPost.call) return gone();
		try { return await DaimondPost.call('GET', undefined, query); }
		catch (e) { return gone(); }
	}

	async function tell(query, body) {
		if (!window.DaimondPost || !DaimondPost.call) return gone();
		try { return await DaimondPost.call('POST', body, query); }
		catch (e) { return gone(); }
	}

	/// What a refusal says, in this account's own language.
	///
	/// KEYED ON `reason` AND NOT ON THE SENTENCE. The gateway's `error` is English
	/// and is written for a developer; `reason` is the contract. A reason this
	/// build does not know falls back to the general line rather than showing a
	/// token, and the 429s deliberately name no allowance -- the gateway does not
	/// publish one and a number invented here would be a promise.
	function whyRefused(r) {
		var why = (r && r.json && r.json.reason) || '';
		if (why === 'empty')          return tOr('feed.err_empty', 'Write something first.');
		if (why === 'too_long')       return tOr('feed.err_long', 'Longer than {n} characters.',
			{ n: POST_MAX });
		if (why === 'pro_required')   return tOr('feed.err_pro', 'Posting needs Daimond Pro.');
		if (why === 'quota' || why === 'too_fast' || why === 'throttled') {
			return tOr('feed.err_busy', 'Too many just now. Try later.');
		}
		if (why === 'followers_full') return tOr('feed.err_full', 'Too many followers.');
		if (why === 'following_full') return tOr('feed.err_following_full', 'You follow too many people.');
		if (why === 'not_pending')    return tOr('feed.err_not_pending', 'Nobody asked to follow you.');
		if (why === 'not_following')  return tOr('feed.err_not_following', 'They have not approved you.');
		if (why === 'no_such_handle') return tOr('feed.err_no_handle', 'No such handle.');
		return tOr('feed.load_fail', 'Could not load.');
	}

	/// One row off the wire, kept to the fields it is. No field of it is trusted
	/// as markup anywhere below: every draw is `textContent`.
	function cleanRow(r) {
		if (!r || typeof r !== 'object') return null;
		return {
			author:  String(r.author || ''),
			handle:  String(r.author_handle || ''),
			pub:     String(r.author_pub || ''),
			id:      r.id | 0,
			ts:      r.ts | 0,
			bytes:   r.bytes | 0,
			removed: String(r.removed || ''),
			body:    String(r.body || ''),
		};
	}

	function cleanRows(j) {
		var raw = (j && Array.isArray(j.rows)) ? j.rows : [];
		var out = [];
		raw.forEach(function (r) { var c = cleanRow(r); if (c) out.push(c); });
		return out;
	}

	// ── The four reads ─────────────────────────────────────────

	/// The merged read: everybody this account follows AND is approved by, newest
	/// first. `since` filters on `ts`, and the mark moves only on a page that says
	/// there is nothing above it -- a partial page that advanced the mark would
	/// skip every row the next page held.
	async function readFollowing(since) {
		var r = await ask('?view=feed&since=' + (since | 0));
		if (r.status !== 200 || !r.json || !r.json.ok) {
			return { ok: false, why: whyRefused(r), rows: [], more: false };
		}
		return { ok: true, rows: cleanRows(r.json), more: r.json.more === true };
	}

	/// This account's own feed, which is the only read that carries the removed
	/// entries and the two counts.
	async function readMine() {
		var me = handle();
		if (!me) return { ok: false, why: tOr('feed.no_handle', 'This account has no handle yet.') };
		var r = await ask('?view=feed&author=' + encodeURIComponent(me) + '&since=0');
		if (r.status !== 200 || !r.json || !r.json.ok || r.json.mine !== true) {
			return { ok: false, why: whyRefused(r) };
		}
		return { ok: true, handle: String(r.json.handle || me), rows: cleanRows(r.json),
			followers: r.json.followers | 0, pending: r.json.pending | 0 };
	}

	/// Who may read this account. The ONLY screen in the app that names a
	/// follower, and it is shown to the author alone.
	async function readFollowers() {
		var r = await ask('?view=followers');
		if (r.status !== 200 || !r.json || !r.json.ok) return { ok: false, why: whyRefused(r) };
		var one = function (x) {
			return { acct: String(x.acct || ''), handle: String(x.handle || ''),
				pub: String(x.pub || ''), since: (x.since | 0) || (x.when | 0) };
		};
		return { ok: true,
			approved: (r.json.approved || []).map(one),
			pending:  (r.json.pending  || []).map(one) };
	}

	/// Whom this account follows, and which of them have approved it. Read for the
	/// People rows, which draw "Following" or "Requested" off it.
	async function readFollowingList() {
		var r = await ask('?view=following');
		if (r.status !== 200 || !r.json || !r.json.ok) return { ok: false, why: whyRefused(r) };
		var by = {};
		(r.json.authors || []).forEach(function (a) {
			by[String(a.pub || '')] = a.approved === true ? 'following' : 'requested';
		});
		_follow = by;
		return { ok: true, by: by };
	}

	// ── The three writes ───────────────────────────────────────

	/// Post to this account's followers. Answers `{ok, id, ts, followers, dropped}`
	/// or `{ok:false, why}` with the sentence already in the reader's language.
	async function post(body) {
		var words = String(body == null ? '' : body);
		if (!words.trim()) return { ok: false, why: tOr('feed.err_empty', 'Write something first.') };
		// SAID BEFORE THE REQUEST. The gateway's 413 is the authority, but a person
		// who has just typed six hundred words is owed the answer without a round
		// trip that throws them away.
		if (new TextEncoder().encode(words).length > POST_MAX) {
			return { ok: false, why: tOr('feed.err_long', 'Longer than {n} characters.', { n: POST_MAX }) };
		}
		var r = await tell('?op=feed', { body: words });
		if (r.status !== 200 || !r.json || !r.json.ok) {
			return { ok: false, status: r.status | 0, why: whyRefused(r) };
		}
		return { ok: true, id: r.json.id | 0, ts: r.json.ts | 0,
			followers: r.json.followers | 0,
			dropped: r.json.dropped != null ? (r.json.dropped | 0) : null };
	}

	/// Delete one of this account's own posts. The body record goes; what survives
	/// is at most `{id, ts, removed}` on the author's own index.
	async function remove(id) {
		var r = await tell('?op=feed_delete', { id: id | 0 });
		if (r.status !== 200 || !r.json || !r.json.ok) {
			return { ok: false, status: r.status | 0, why: whyRefused(r) };
		}
		return { ok: true, deleted: r.json.deleted === true };
	}

	/// Ask to follow, answer somebody who asked, or let go either way. post.js
	/// holds the verb, because it is the door `connect` takes.
	async function follow(pub, action) {
		if (!window.DaimondPost || !DaimondPost.follow) {
			return { ok: false, why: tOr('feed.load_fail', 'Could not load.') };
		}
		var r = await DaimondPost.follow(pub, action);
		if (!r.ok) return { ok: false, why: whyRefused({ json: { reason: r.why } }) };
		// KEPT LOCALLY AS "ASKED", NEVER AS "THEY HAVE IT". The answer is the same
		// whether the request was stored, deduped or dropped by a block, so this is
		// a record of what this device did and not a claim about the other account.
		if (_follow) {
			if (action === 'request') _follow[String(pub)] = 'requested';
			if (action === 'unfollow') delete _follow[String(pub)];
		}
		return { ok: true };
	}

	// ── Unread, and what "read" means ──────────────────────────
	//
	// DRAWN, NOT FETCHED, exactly as post.js's `markDrawnRead` has it: a cadence
	// read folds rows while the panel is shut, and a device that cleared its own
	// badge on the read would clear it for posts nobody has looked at.

	/// How many posts have arrived and not been drawn. The record is the
	/// authority; nothing is counted off what happens to be in memory.
	function unread() {
		try { return (window.DaimondPost && DaimondPost.feedUnread) ? DaimondPost.feedUnread() : 0; }
		catch (e) { return 0; }
	}

	/// Mark what is ON SCREEN as read, and answer how many authors moved.
	///
	/// An absent region and a hidden one both measure nothing, which is the honest
	/// answer for both.
	function markDrawnRead(rows) {
		var h = host();
		if (!h || !rows || !rows.length) return 0;
		var b = h.getBoundingClientRect();
		if (!(b.width > 1 && b.height > 1)) return 0;
		var top = {};
		rows.forEach(function (r) {
			if (!r.author) return;
			if (!top[r.author] || r.id > top[r.author]) top[r.author] = r.id;
		});
		var authors = Object.keys(top);
		if (!authors.length) return 0;
		authors.forEach(function (a) {
			try { DaimondPost.feedDrawn(a, top[a]); } catch (e) { /* locked */ }
		});
		return authors.length;
	}

	/// Say that `n` posts landed. The SAME event post.js raises for a message, so
	/// the one Social badge counts both -- `postBadge` in js/daimond.js sums the
	/// two tallies and the comment there is the reason there is one badge.
	var ARRIVED = 'daimond:post-arrived';

	function announce(n) {
		if (!(n > 0)) return 0;
		try {
			window.dispatchEvent(new CustomEvent(ARRIVED, {
				detail: { count: n | 0, unread: unread(), kind: 'feed', addrs: [] },
			}));
		} catch (e) { /* an old browser: the rows are folded either way */ }
		return n | 0;
	}

	// ── The cadence ────────────────────────────────────────────

	/// This account's own public handle, or ''. `DaimondSync` owns it; asked here
	/// rather than kept, because it can be claimed mid-session.
	function handle() {
		try { return (window.DaimondSync && DaimondSync.handle()) || ''; }
		catch (e) { return ''; }
	}

	function authed() {
		try { return !!(window.DaimondGateway && DaimondGateway.state().authed); }
		catch (e) { return false; }
	}

	/// One merged read, above the record's own mark, counting what is new.
	///
	/// This is the READ THE PANEL DOES NOT SEE: it runs while the Social panel is
	/// shut, and everything it learns goes into the record and the badge. Nothing
	/// is marked read by it, because nobody has looked at anything.
	async function poll() {
		if (!authed()) return { ok: false, why: 'off' };
		var st = null;
		try { st = (window.DaimondPost && DaimondPost.feedState) ? DaimondPost.feedState() : null; }
		catch (e) { st = null; }
		if (!st) return { ok: false, why: 'locked' };
		var got = await readFollowing(st.since | 0);
		_lastRead = Date.now();
		if (!got.ok) return { ok: false, why: got.why };
		var byAuthor = {}, newest = st.since | 0;
		got.rows.forEach(function (r) {
			if (r.removed) return;				// a removed entry is not an arrival
			(byAuthor[r.author] = byAuthor[r.author] || []).push(r.id);
			if (r.ts > newest) newest = r.ts;
		});
		var fresh = 0;
		var authors = Object.keys(byAuthor);
		for (var i = 0; i < authors.length; i++) {
			fresh += await DaimondPost.feedSaw(authors[i], byAuthor[authors[i]], false);
		}
		// ONLY ON A COMPLETE PAGE. `more` says the gateway had rows above the mark
		// it could not fit; moving the mark now would step over them for ever.
		if (!got.more) await DaimondPost.feedSince(newest);
		_rows = got.rows;
		_more = got.more;
		if (_tab === 'following') render();
		announce(fresh);
		return { ok: true, got: got.rows.length, fresh: fresh, more: got.more };
	}

	/// Consider the cadence. Nothing happens unless the errand channel has
	/// actually answered since the last read -- a device whose park is down is a
	/// device that is not being told anything, and polling it on a timer would be
	/// a request every five minutes into a hole.
	async function tick() {
		if (!authed()) return false;
		if (Date.now() - _lastRead < POLL_MS) return false;
		var serviced = 0;
		try { serviced = (window.DaimondPost && DaimondPost.servicedAt) ? DaimondPost.servicedAt() : 0; }
		catch (e) { serviced = 0; }
		if (!(serviced > _lastRead)) return false;
		await poll();
		return true;
	}

	function startTicking() {
		if (_ticking) return false;
		_ticking = true;
		setInterval(function () { tick().then(null, function (e) { log('a cadence read failed', e); }); },
			TICK_MS);
		return true;
	}

	// ── The panel ──────────────────────────────────────────────
	//
	// Built with `createElement` and `textContent`, never `innerHTML`. A feed post
	// is a stranger's words arriving over a wire, and the one thing this reader
	// must never do is build markup out of them.

	function host() { return document.querySelector(HOST); }

	function elt(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = String(text);
		return e;
	}

	function btn(cls, act, label) {
		var b = elt('button', cls, label);
		b.type = 'button';
		b.dataset.act = act;
		return b;
	}

	/// A short relative-time label, through the `sync.when_*` keys every locale
	/// already carries. The same four rungs the drawer's own clock uses; the words
	/// live in the catalogue, so there is one of them and not two.
	function when(ts) {
		var ms = (ts | 0) * 1000;
		if (!ms) return '';
		var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 60) return t('sync.when_just_now');
		var m = Math.round(s / 60);
		if (m < 60) return t('sync.when_mins', { n: m });
		var h = Math.round(m / 60);
		if (h < 24) return t('sync.when_hours', { n: h });
		return t('sync.when_days', { n: Math.round(h / 24) });
	}

	/// Take the panel's own empty line down, because this view has drawn.
	function filled(drew) {
		try {
			if (window.DaimondSocial && DaimondSocial.filled) {
				DaimondSocial.filled(VIEW, drew ? 1 : 0);
			}
		} catch (e) { /* the panel is not up */ }
	}

	function say(words) {
		_say = String(words || '');
		var line = document.getElementById('feed-say');
		if (line) line.textContent = _say;
	}

	/// The reason an entry is marked removed, out of the relay's own notice where
	/// this device holds one. The index says only THAT it was removed; the
	/// `feedgone` row carries "<id> <reason>", and the reason is what a person
	/// wants.
	function removedWhy(id) {
		try {
			var notes = (window.DaimondPost && DaimondPost.notices) ? DaimondPost.notices() : [];
			for (var i = 0; i < notes.length; i++) {
				var n = notes[i];
				if (n.kind !== 'feedgone') continue;
				var parts = String(n.text || '').split(' ');
				if ((parts[0] | 0) === (id | 0)) return parts.slice(1).join(' ');
			}
		} catch (e) { /* the record is locked */ }
		return '';
	}

	/// The two halves, as a row of chips. The panel's own chips name the views;
	/// these name the halves of one view, so they are drawn smaller and inside it.
	function drawTabs() {
		var row = elt('div', 'feed-tabs');
		row.setAttribute('role', 'tablist');
		[['following', tOr('feed.following', 'Following')],
		 ['mine',      tOr('feed.mine', 'Mine')]].forEach(function (pair) {
			var b = btn('feed-tab' + (_tab === pair[0] ? ' on' : ''), 'feed-tab', pair[1]);
			b.dataset.tab = pair[0];
			b.setAttribute('role', 'tab');
			b.setAttribute('aria-selected', _tab === pair[0] ? 'true' : 'false');
			row.appendChild(b);
		});
		return row;
	}

	/// One post by somebody this account follows.
	///
	/// The handle is a BUTTON: pressing it looks the name up and offers the card,
	/// which is where a follow is asked for. A handle is the gateway's namespace
	/// and not a matched key, so it is drawn as the claim it is and carries no
	/// official shape whatever -- the same rule the message list keeps.
	function drawRow(r, unreadIds) {
		var row = elt('article', 'post-msg feed-row');
		row.dataset.author = r.author;
		row.dataset.id     = String(r.id);
		if (unreadIds[r.author] && r.id > unreadIds[r.author]) row.classList.add('feed-unread');
		var who = elt('div', 'post-who');
		var name = btn('post-link feed-who', 'feed-who', r.handle || tOr('post.someone', 'Someone new'));
		name.dataset.handle = r.handle || '';
		who.appendChild(name);
		who.appendChild(elt('span', 'post-fp', when(r.ts)));
		row.appendChild(who);
		if (r.removed) {
			row.appendChild(elt('p', 'post-bad', tOr('feed.removed',
				'Removed by the operator: {reason}.',
				{ reason: removedWhy(r.id) || tOr('feed.gone_why', 'the operator gave no reason') })));
			return row;
		}
		row.appendChild(elt('p', 'post-body', r.body));
		var acts = elt('div', 'post-acts');
		var rep = btn('post-btn', 'feed-report', tOr('feed.report', 'Report'));
		rep.dataset.reportPost = r.author;
		rep.dataset.reportId   = String(r.id);
		acts.appendChild(rep);
		row.appendChild(acts);
		return row;
	}

	/// The Following half: the merged read, and the line for an account that
	/// follows nobody yet.
	function drawFollowing(h) {
		var sec = elt('section', 'post-list feed-list');
		sec.id = 'feed-list';
		var live = _rows.filter(function (r) { return !r.removed; });
		if (!live.length) {
			var line = (window.DaimondPost && DaimondPost.peopleLine)
				? DaimondPost.peopleLine('post-empty', tOr('feed.none', 'Follow somebody in {people}.'))
				: elt('p', 'post-empty', tOr('feed.none', 'Follow somebody in {people}.'));
			sec.appendChild(line);
			h.appendChild(sec);
			return [];
		}
		var marks = {};
		try {
			var st = DaimondPost.feedState();
			marks = (st && st.read) || {};
		} catch (e) { marks = {}; }
		live.forEach(function (r) { sec.appendChild(drawRow(r, marks)); });
		h.appendChild(sec);
		return live;
	}

	/// The compose box. TWO ROWS, as the note box is, and the audience is named
	/// above the button and not on it: the count is a fact about this account's
	/// followers and the button is one word.
	///
	/// NO PUBLIC WARNING, deliberately. There is no public here -- a post reaches
	/// the approved followers and the operator and nobody else -- and a sentence
	/// warning about an audience that does not exist would teach the wrong thing
	/// about the one that does.
	function drawWrite(h) {
		var box = elt('form', 'post-write feed-write');
		box.id = 'feed-write';
		var ta = elt('textarea', 'imp-box');
		ta.id = 'feed-box';
		ta.rows = 2;
		ta.value = _draft;
		ta.placeholder = tOr('feed.box_ph', 'What you want to say');
		ta.setAttribute('aria-label', tOr('feed.box_ph', 'What you want to say'));
		ta.addEventListener('input', function () { _draft = ta.value; });
		box.appendChild(ta);
		var acts = elt('div', 'post-acts');
		acts.appendChild(elt('span', 'imp-as feed-count',
			tOr('feed.followers', '{n} followers', { n: (_mine && _mine.followers) | 0 })));
		acts.appendChild(btn('imp-send', 'feed-post', tOr('feed.post', 'Post')));
		box.appendChild(acts);
		var line = elt('p', 'imp-say feed-say', _say);
		line.id = 'feed-say';
		line.setAttribute('role', 'status');
		box.appendChild(line);
		h.appendChild(box);
	}

	/// One of this account's own posts, with the one control it has.
	function drawMineRow(r) {
		var row = elt('article', 'post-msg post-out feed-row');
		row.dataset.id = String(r.id);
		var who = elt('div', 'post-who');
		who.appendChild(elt('span', 'post-name', tOr('post.you', 'You')));
		who.appendChild(elt('span', 'post-fp', when(r.ts)));
		row.appendChild(who);
		if (r.removed) {
			row.appendChild(elt('p', 'post-bad', tOr('feed.removed',
				'Removed by the operator: {reason}.',
				{ reason: removedWhy(r.id) || tOr('feed.gone_why', 'the operator gave no reason') })));
			return row;
		}
		row.appendChild(elt('p', 'post-body', r.body));
		var acts = elt('div', 'post-acts');
		var del = btn('post-btn', 'feed-delete', tOr('feed.delete', 'Delete'));
		del.dataset.id = String(r.id);
		acts.appendChild(del);
		row.appendChild(acts);
		return row;
	}

	/// Who may read this account, named to the author and to nobody else.
	function drawFollowers(h) {
		var sec = elt('section', 'post-list feed-followers');
		sec.id = 'feed-followers';
		var who = (_list && _list.approved) || [];
		sec.appendChild(elt('h3', null, tOr('feed.followers_head', 'Followers ({n})', { n: who.length })));
		if (!who.length) {
			sec.appendChild(elt('p', 'post-empty', tOr('feed.no_followers', 'Nobody follows you yet.')));
			h.appendChild(sec);
			return;
		}
		who.forEach(function (p) {
			var row = elt('article', 'post-req feed-follower');
			row.dataset.peer = p.pub;
			var line = elt('div', 'post-who');
			line.appendChild(elt('span', 'post-name', p.handle || tOr('post.someone', 'Someone new')));
			row.appendChild(line);
			var acts = elt('div', 'post-acts');
			var rm = btn('post-btn', 'feed-remove', tOr('feed.remove', 'Remove'));
			rm.dataset.peer = p.pub;
			acts.appendChild(rm);
			row.appendChild(acts);
			sec.appendChild(row);
		});
		h.appendChild(sec);
	}

	/// The Mine half: the box, this account's own posts, and its followers.
	function drawMine(h) {
		drawWrite(h);
		var sec = elt('section', 'post-list feed-list');
		sec.id = 'feed-list';
		var rows = (_mine && _mine.rows) || [];
		if (!rows.length) {
			sec.appendChild(elt('p', 'post-empty', tOr('feed.mine_none', 'No posts yet.')));
		} else {
			rows.forEach(function (r) { sec.appendChild(drawMineRow(r)); });
		}
		h.appendChild(sec);
		drawFollowers(h);
	}

	function render() {
		var h = host();
		if (!h) return;
		h.textContent = '';
		h.appendChild(drawTabs());

		if (!window.DaimondPost || !DaimondPost.feedState || !DaimondPost.feedState()) {
			h.appendChild(elt('p', 'post-empty', tOr('feed.locked',
				'Unlock Daimond to read your feed.')));
			filled(true);		// locked is a state this view drew, not an absent feature
			return;
		}

		var drawn = [];
		if (_tab === 'mine') drawMine(h);
		else drawn = drawFollowing(h);

		filled(true);

		// READ WHEN DRAWN. Last, because it measures the elements it has just put
		// on the screen, and a row counted before it was placed is a row nobody saw.
		if (_tab === 'following') markDrawnRead(drawn);
	}

	// ── The presses ────────────────────────────────────────────

	document.addEventListener('click', function (e) {
		var h = e.target && e.target.closest ? e.target.closest(HOST) : null;
		if (!h) return;
		var b = e.target.closest('[data-act]');
		if (!b) return;
		var act = b.dataset.act;

		if (act === 'feed-tab') {
			e.preventDefault();
			_tab = b.dataset.tab === 'mine' ? 'mine' : 'following';
			render();
			refresh();
			return;
		}
		if (act === 'feed-post') {
			e.preventDefault();
			var ta = document.getElementById('feed-box');
			var words = ta ? ta.value : _draft;
			b.disabled = true;
			say(tOr('feed.posting', 'Posting…'));
			post(words).then(function (r) {
				b.disabled = false;
				if (!r.ok) { say(r.why); return; }		// THE DRAFT STAYS. It was not sent.
				_draft = '';
				if (ta) ta.value = '';
				// The oldest went to make room, and the author is the one person who
				// can be told: nothing else on any screen would ever say it.
				say(tOr('feed.posted', 'Posted.')
					+ (r.dropped != null ? ' ' + tOr('feed.dropped', 'Your oldest post went.') : ''));
				refresh();
			});
			return;
		}
		if (act === 'feed-delete') {
			e.preventDefault();
			b.disabled = true;
			remove(b.dataset.id | 0).then(function (r) {
				b.disabled = false;
				say(r.ok ? tOr('feed.deleted', 'Deleted.') : r.why);
				refresh();
			});
			return;
		}
		if (act === 'feed-remove') {
			e.preventDefault();
			b.disabled = true;
			follow(String(b.dataset.peer || ''), 'remove').then(function (r) {
				b.disabled = false;
				if (!r.ok) { say(r.why); return; }
				refresh();
			});
			return;
		}
		if (act === 'feed-who') {
			e.preventDefault();
			// THE PEOPLE FLOW, not a second one. trust.js owns the finder, the card
			// and everything said about a key; this hands it a handle.
			try {
				if (window.DaimondTrust && DaimondTrust.findHandle) {
					DaimondTrust.findHandle(String(b.dataset.handle || ''));
				}
			} catch (err) { log('the finder did not open', err); }
			return;
		}
		if (act === 'feed-report') {
			e.preventDefault();
			// report.js draws the sheet. It reads the row back through `find` below,
			// so what is on screen is what this device holds and not a second copy.
			try {
				if (window.DaimondReport && DaimondReport.openPost) {
					DaimondReport.openPost(String(b.dataset.reportPost || ''), b.dataset.reportId | 0);
				}
			} catch (err) { log('the report sheet did not open', err); }
			return;
		}
	});

	// ── Opening, and keeping in step ───────────────────────────

	/// Read whichever half is showing. The merged read is made WHOLE here (since
	/// 0) rather than above the mark: this is the list somebody is looking at, and
	/// a list that showed only what had arrived since the last poll would be a
	/// list that emptied itself as it worked.
	async function refresh() {
		if (!authed()) { render(); return { ok: false, why: 'off' }; }
		if (_tab === 'mine') {
			var mine = await readMine();
			if (mine.ok) _mine = mine; else say(mine.why);
			var list = await readFollowers();
			if (list.ok) _list = list;
			render();
			return mine;
		}
		var got = await readFollowing(0);
		_lastRead = Date.now();
		if (!got.ok) { say(got.why); render(); return got; }
		_rows = got.rows;
		_more = got.more;
		// WHAT IS HERE, ENTIRE. A whole read replaces the arrival list rather than
		// adding to it, which is how a post its author deleted stops being counted
		// as unread on this device.
		var byAuthor = {};
		got.rows.forEach(function (r) {
			if (!r.removed) (byAuthor[r.author] = byAuthor[r.author] || []).push(r.id);
		});
		var authors = Object.keys(byAuthor);
		for (var i = 0; i < authors.length; i++) {
			await DaimondPost.feedSaw(authors[i], byAuthor[authors[i]], true);
		}
		render();
		return got;
	}

	/// The Feed view was opened. Read at once -- somebody is looking -- and read
	/// the following list, which is what the People rows say Follow or Following
	/// off.
	function onOpen() {
		startTicking();
		return refresh().then(function () {
			return readFollowingList();
		}).then(function () { return true; }, function (e) { log('open failed', e); render(); return false; });
	}

	/// Take the Feed view of the Social panel and keep in step with it. Read
	/// LAZILY, on the open, exactly as post.js and trust.js do.
	function attachPanel() {
		if (!host()) return false;
		try {
			if (window.DaimondSocial && DaimondSocial.watch) {
				DaimondSocial.watch(function (view) { if (view === VIEW) onOpen(); });
			}
		} catch (e) { /* no panel to watch */ }
		render();
		return true;
	}

	function start() {
		if (!attachPanel()) document.addEventListener('DOMContentLoaded', attachPanel);
		// THE CADENCE RUNS WITH THE PANEL SHUT. It is the whole of how a badge
		// lights for a feed post, so it is not waited on an open that may never
		// come; each tick still refuses unless the errand channel has answered.
		startTicking();
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();

	// The record is read at unlock, and a badge counted before that answers 0.
	window.addEventListener('daimond:unlock', function () { render(); });

	// ── Public surface ─────────────────────────────────────────
	window.DaimondFeed = {
		/// The panel.
		onOpen:  onOpen,
		render:  render,
		refresh: refresh,
		/// Which half is showing, and switching it without a press.
		tab:     function (which) {
			if (which === 'mine' || which === 'following') { _tab = which; render(); }
			return _tab;
		},
		/// The four reads, published so a verifier drives the doors the panel
		/// drives rather than a second set of its own.
		following:     readFollowing,
		mine:          readMine,
		followers:     readFollowers,
		followingList: readFollowingList,
		/// Whom this account follows, as `{ <pub>: 'following'|'requested' }`, or
		/// null while nobody has read it. What a People row draws its state off.
		follows:  function () { return _follow ? JSON.parse(JSON.stringify(_follow)) : null; },
		/// The three writes.
		post:    post,
		remove:  remove,
		follow:  follow,
		/// The cadence: one read above the mark, and the tick that decides whether
		/// to make it. Published because a verifier must be able to land a post
		/// with the panel shut, which is the case the badge exists for.
		poll:    poll,
		tick:    tick,
		/// The rows in hand, for report.js and for a verifier. NO BODY OF ANY OF
		/// THEM IS IN THE RECORD -- this is the session's own copy and it goes
		/// with the tab.
		rows:    function () { return _rows.slice(); },
		mineRows: function () { return ((_mine && _mine.rows) || []).slice(); },
		/// One row by author and id, wherever it is held. report.js reads the
		/// words it draws through this rather than keeping a second copy.
		find:    function (author, id) {
			var all = _rows.concat((_mine && _mine.rows) || []);
			for (var i = 0; i < all.length; i++) {
				if (String(all[i].author || '') === String(author) && (all[i].id | 0) === (id | 0)) return all[i];
				// This account's own rows carry no author on the wire, so a Mine row
				// is matched on the id under this account's own handle.
				if (!all[i].author && (all[i].id | 0) === (id | 0)) return all[i];
			}
			return null;
		},
		/// How many posts arrived and have not been drawn, and the event raised
		/// when some do. The Social badge sums this with `DaimondPost.unread()`.
		unread:       unread,
		arrivedEvent: ARRIVED,
		/// Everything this module would say if asked.
		state:   function () {
			return { tab: _tab, rows: _rows.length, more: _more, unread: unread(),
				lastRead: _lastRead, followers: (_mine && _mine.followers) | 0,
				pending: (_mine && _mine.pending) | 0, say: _say };
		},
	};
})();
