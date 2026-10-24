// settingsgroups.js -- the Settings drawer, grouped by intent (D-20261024-16).
//
// It runs after `renderHomeBody` has drawn the drawer, and only MOVES what that drew:
// nothing is created that does a job, nothing is removed. Each node is put in a group by
// the heading it was drawn under, and a few rows by their own label, both read through
// the same `t()` the drawer wrote them with, so a locale change regroups the same way.
//
// The top level is the weekly stop (Models, Credits), six doors, one per group, and the
// session actions (Lock, Log out, Forget) last. A door opens its group as a page of its own.
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
		'devices.runner_mint': 'tools', 'home.limits': 'models',
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

	function apply(home, title) {
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
		draw(home, units, title);
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

	function redraw() {
		if (window.DaimondAdmin && DaimondAdmin.homeContent) DaimondAdmin.homeContent();
		var sc = document.getElementById('admin-scroll');
		if (sc) sc.scrollTop = 0;
		var slot = document.getElementById('settings-slot');
		if (slot) slot.scrollTop = 0;
	}

	window.DaimondSettingsGroups = { apply: apply };
})();
