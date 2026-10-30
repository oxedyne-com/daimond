// settingsgroups.js -- the Settings drawer, grouped by intent (D-20261024-16).
//
// It runs after `renderHomeBody` has drawn the drawer, and only MOVES what that drew:
// nothing is created that does a job, nothing is removed. Each node is put in a group by
// the heading it was drawn under, and a few rows by their own label, both read through
// the same `t()` the drawer wrote them with, so a locale change regroups the same way.
//
// The top level is the weekly stop (Models, Credits), six doors, one per group, and the
// session actions (Lock, Log out, Forget) last. A door opens its group as a page of its own.
//
// On a phone (Stack A3, frame b5) Settings is a page of the stack, drawn as grouped inset rows:
// the signed-in member's row is the door to "You and devices", the other five doors follow in
// their order, each with its icon tile, then Appearance, moved in from the top-bar menu. A door
// pushes its group as a page of the stack, which `phone` (admin.js) hosts.
(function () {
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	// The six groups, in door order: what a week uses first. Name and line are i18n keys.
	var GROUPS = ['models', 'tools', 'you', 'prompts', 'data', 'help'].map(function (id) {
		return { id: id, name: 'settings.group_' + id, what: 'settings.group_' + id + '_what' };
	});
	// The weekly stop: these stand above the doors, one tap from opening Settings.
	var QUICK = ['astat-model', 'astat-account'];
	// The heading a row was drawn under decides its group...
	var BY_SEC = {
		'home.sec_account': 'you', 'home.sec_devices': 'you', 'home.sec_accounts': 'you',
		'home.sec_lens': 'you', 'home.sec_prompts': 'prompts', 'home.sec_running': 'tools',
		'home.sec_push': 'tools', 'home.sec_sync': 'help', 'home.sec_diag': 'help',
		'home.sec_debugshare': 'help',
	};
	// ...unless its own label says it belongs elsewhere.
	var BY_LABEL = {
		'home.export_backup': 'data', 'home.import_backup': 'data',
		'devices.runner_code': 'tools', 'devices.runner_mint': 'tools', 'home.limits': 'models',
		'safe.turn_off': 'data', 'safe.turn_on': 'data',
		'home.lock': 'foot', 'home.log_out': 'foot', 'identity.forget': 'foot',
	};
	// The old status rows, by id: they lose their "This device" heading and join their group.
	var BY_ID = {
		'astat-model': 'models', 'astat-account': 'models', 'astat-byok': 'models', 'astat-pro': 'models',
		'astat-tools': 'tools', 'astat-hand': 'tools',
		'astat-release': 'help',
		'astat-store': 'data', 'astat-store-native': 'data', 'astat-sync': 'data',
		'admin-social-settings': 'you',
	};

	// A door's icon tile on a phone, drawn in the icon set's 24-unit box.
	var ICONS = {
		models:  '<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
		tools:   '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
		prompts: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
		data:    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
		help:    '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>',
	};

	var statusRows = null;	// the status rows, kept: `innerHTML = ''` would otherwise lose them
	var open = '';		// the group page standing, or '' for the doors

	function secOf(text) {
		for (var k in BY_SEC) if (t(k) === text) return k;
		return '';
	}
	function labelGroup(text) {
		for (var k in BY_LABEL) if (t(k) === text) return BY_LABEL[k];
		return '';
	}
	// A note, an output line or a panel that belongs to the row above it.
	function follows(n) {
		return n.classList.contains('admin-note') || n.classList.contains('device-skew')
			|| (n.tagName === 'DIV' && !n.className);
	}

	function apply(home, title, phone) {
		if (!home) return;
		var detail = document.getElementById('astat-detail');
		if (!statusRows && detail) statusRows = Array.prototype.slice.call(detail.children);
		var admin = document.getElementById('admin');
		if (!admin || !admin.classList.contains('admin-open')) open = '';

		// Sort what was drawn into the groups, keeping the order inside each.
		var units = { foot: [], top: [] };
		GROUPS.forEach(function (g) { units[g.id] = []; });
		var sec = '', last = 'top', heads = {};
		Array.prototype.slice.call(home.children).forEach(function (n) {
			if (n === detail) return;
			if (n.classList.contains('admin-sec')) {
				sec = secOf(n.textContent);
				if (BY_SEC[sec]) heads[BY_SEC[sec]] = (heads[BY_SEC[sec]] || 0) + 1;
				if (BY_SEC[sec]) units[BY_SEC[sec]].push(n);
				return;
			}
			var g = (n.id && BY_ID[n.id]) || labelGroup((n.textContent || '').trim());
			if (!g && follows(n)) g = last;
			if (!g) g = sec ? (BY_SEC[sec] || 'top') : (last === 'top' ? 'top' : last);
			units[g].push(n);
			last = g;
		});
		(statusRows || []).forEach(function (n) {
			var id = n.id || (n.querySelector('[id]') || {}).id;
			var g = BY_ID[id] || 'data';
			n.classList.add('sg-status');
			units[g].unshift(n);		// the live readings lead their group
		});
		// unshift reversed them: put the status rows back in drawn order.
		GROUPS.forEach(function (g) {
			var s = units[g.id].filter(function (n) { return n.classList.contains('sg-status'); }).reverse();
			units[g.id] = s.concat(units[g.id].filter(function (n) { return !n.classList.contains('sg-status'); }));
		});

		home.innerHTML = '';
		home.classList.add('sg');
		units.top.forEach(function (n) { home.appendChild(n); });	// the first-run call to connect
		if (phone) drawPhone(home, units, title, phone);
		else draw(home, units, title);
	}

	// Only "You and devices" keeps its old headings (Account, Devices, Accounts): they name
	// real things. Help's three (syncing, diagnostics, debug sharing) were history, not intent.
	function bodyOf(gid, list, keepHeads) {
		var frag = document.createDocumentFragment();
		var seen = 0;
		list.forEach(function (n) {
			if (n.classList.contains('admin-sec')) {
				seen++;
				if (!keepHeads) return;
				n.classList.add('sg-subhead');
			}
			frag.appendChild(n);
		});
		return frag;
	}

	function foot(home, units) {
		if (!units.foot.length) return;
		var f = document.createElement('div');
		f.className = 'sg-foot';
		units.foot.forEach(function (n) { f.appendChild(n); });
		home.appendChild(f);
	}

	function draw(home, units, title) {
		if (open) {
			var g = GROUPS.filter(function (x) { return x.id === open; })[0];
			var back = document.createElement('button');
			back.className = 'admin-item sg-back';
			back.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
			back.appendChild(document.createTextNode(t('admin.settings')));
			back.addEventListener('click', function () { open = ''; redraw(); });
			home.appendChild(back);
			if (title) title.textContent = t(g.name);
			var page = document.createElement('div');
			page.className = 'sg-group';
			page.appendChild(bodyOf(g.id, units[g.id], g.id === 'you'));
			home.appendChild(page);
			return;
		}
		if (title) title.textContent = t('admin.settings');
		var quick = document.createElement('div');
		quick.className = 'sg-quick';
		units.models = units.models.filter(function (n) {
			if (QUICK.indexOf(n.id) < 0) return true;
			quick.appendChild(n);
			return false;
		});
		if (quick.children.length) home.appendChild(quick);
		var list = document.createElement('div');
		list.className = 'sg-doors';
		GROUPS.forEach(function (g) {
			if (!units[g.id].length) return;
			var b = document.createElement('button');
			b.className = 'admin-item sg-door';
			b.dataset.sgroup = g.id;
			var name = document.createElement('span');
			name.className = 'sg-name';
			name.textContent = t(g.name);
			var what = document.createElement('span');
			what.className = 'sg-what';
			what.textContent = t(g.what);
			b.appendChild(name);
			b.appendChild(what);
			b.insertAdjacentHTML('beforeend',
				'<svg class="ic sg-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>');
			b.addEventListener('click', function () { open = g.id; redraw(); });
			list.appendChild(b);
		});
		home.appendChild(list);
		// The rows the doors carried are kept off-page, not dropped: their painters still fill them by id.
		var hold = document.createElement('div');
		hold.hidden = true;
		GROUPS.forEach(function (g) { units[g.id].forEach(function (n) { hold.appendChild(n); }); });
		home.appendChild(hold);
		foot(home, units);
	}

	// The signed-in member, read from the identity, never a name kept here: the row is whoever
	// holds this device now, and a second member is the same row with another name (q6).
	function member() {
		var id = window.DaimondIdentity;
		if (id && id.exists && id.exists() && id.isUnlocked && id.isUnlocked()) {
			return (id.displayName && id.displayName()) || t('admin.local_identity');
		}
		return t(id && id.exists && id.exists() ? 'admin.locked' : 'admin.no_account');
	}

	function door(cls, name, what, icon) {
		var b = document.createElement('button');
		b.className = 'admin-item sg-door ' + cls;
		if (icon) b.insertAdjacentHTML('beforeend', icon);
		var words = document.createElement('span');
		words.className = 'sg-words';
		var n = document.createElement('span');
		n.className = 'sg-name';
		n.textContent = name;
		var w = document.createElement('span');
		w.className = 'sg-what';
		w.textContent = what;
		words.appendChild(n);
		words.appendChild(w);
		b.appendChild(words);
		b.insertAdjacentHTML('beforeend',
			'<svg class="ic sg-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>');
		return b;
	}

	// Settings as a page of the phone's stack: the member's row, the doors, Appearance, the foot.
	// A door's group is its own page (`phone.group`), and the group standing is drawn into it
	// afresh with every redraw, since a redraw builds every row anew.
	function drawPhone(home, units, title, phone) {
		if (title) title.textContent = t('settings.title');
		var gname = function (id) { return GROUPS.filter(function (x) { return x.id === id; })[0]; };
		// The push draws it: the stack's top page says which group (admin.js followStack).
		function openGroup(id) {
			open = id;
			phone.push(id);
		}
		function fillGroup() {
			var g = open && gname(open);
			phone.group(g ? t(g.name) : '', g ? bodyOf(g.id, units[g.id], g.id === 'you') : null,
				function () { open = ''; }, g ? g.id : '');
		}
		// The stack showing a group page with nothing drawn on it (Forward, a reload).
		phone.show = function (id) { if (gname(id)) { open = id; fillGroup(); } };
		var you = units.you.length ? door('sg-ident', member(), t('settings.group_you_what'), '') : null;
		if (you) {
			var av = document.createElement('span');
			av.className = 'sg-avatar';
			av.setAttribute('aria-hidden', 'true');
			av.textContent = (member().trim().charAt(0) || '·').toUpperCase();
			you.insertBefore(av, you.firstChild);
			you.dataset.sgroup = 'you';
			you.addEventListener('click', function () { openGroup('you'); });
			var idBox = document.createElement('div');
			idBox.className = 'sg-inset';
			idBox.appendChild(you);
			home.appendChild(idBox);
		}
		var list = document.createElement('div');
		list.className = 'sg-doors sg-inset';
		GROUPS.forEach(function (g) {
			if (g.id === 'you' || !units[g.id].length) return;
			var b = door('', t(g.name), t(g.what),
				'<span class="sg-tile sg-tile-' + g.id + '"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
				+ ICONS[g.id] + '</svg></span>');
			b.dataset.sgroup = g.id;
			b.addEventListener('click', function () { openGroup(g.id); });
			list.appendChild(b);
		});
		if (list.children.length) home.appendChild(list);
		// Appearance, moved in from the top bar: the menu's own node, drawn by its own renderer.
		if (window.DaimondWorkspace && DaimondWorkspace.mountAppearance) {
			var head = document.createElement('div');
			head.className = 'sg-head';
			head.textContent = t('topbar.appearance');
			home.appendChild(head);
			var look = document.createElement('div');
			look.className = 'sg-inset sg-appearance';
			home.appendChild(look);
			DaimondWorkspace.mountAppearance(look);
		}
		foot(home, units);
		// The open group's rows stand on its page; every other group's are kept off-page.
		var hold = document.createElement('div');
		hold.hidden = true;
		GROUPS.forEach(function (g) {
			if (g.id !== open) units[g.id].forEach(function (n) { hold.appendChild(n); });
		});
		home.appendChild(hold);
		fillGroup();
	}

	function redraw() {
		if (window.DaimondAdmin && DaimondAdmin.homeContent) DaimondAdmin.homeContent();
		var sc = document.getElementById('admin-scroll');
		if (sc) sc.scrollTop = 0;
		var slot = document.getElementById('settings-slot');
		if (slot) slot.scrollTop = 0;
	}

	window.DaimondSettingsGroups = { apply: apply };
})();
