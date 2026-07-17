// verify/ext/popup.js — show the active tab's verdict, and let the user re-run.

const dot = document.getElementById('dot');
const headline = document.getElementById('headline');
const checksEl = document.getElementById('checks');
const idsEl = document.getElementById('ids');
const btn = document.getElementById('recheck');

function mark(c) { return c.ok === true ? ['ok', '✓'] : c.ok === false ? ['no', '✗'] : ['warn', '?']; }

function render(v) {
	if (!v) {
		dot.className = 'dot';
		headline.textContent = 'Not a Daimond page, or not checked yet.';
		checksEl.innerHTML = ''; idsEl.textContent = '';
		return;
	}
	dot.className = 'dot ' + (v.ok ? 'ok' : v.failed ? 'no' : 'warn');
	headline.textContent = v.ok ? 'Published source, sealed.'
		: v.failed ? 'Does NOT match the published source.'
		: 'Could not fully verify.';
	checksEl.innerHTML = '';
	(v.checks || []).forEach(c => {
		const m = mark(c);
		const li = document.createElement('li');
		li.innerHTML = '<span class="mk ' + m[0] + '">' + m[1] + '</span>'
			+ '<span>' + c.name + (c.detail ? ' <span class="dt">— ' + c.detail + '</span>' : '') + '</span>';
		checksEl.appendChild(li);
	});
	idsEl.textContent = v.build ? 'build ' + v.build + '\nbundle ' + v.bundle : '';
}

async function activeTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab;
}

async function load() {
	const tab = await activeTab();
	const v = await chrome.runtime.sendMessage({ type: 'verdict', tabId: tab.id });
	render(v);
}

btn.addEventListener('click', async () => {
	const tab = await activeTab();
	headline.textContent = 'Checking…'; dot.className = 'dot';
	const v = await chrome.runtime.sendMessage({ type: 'recheck', tabId: tab.id, url: tab.url });
	render(v);
});

load();
