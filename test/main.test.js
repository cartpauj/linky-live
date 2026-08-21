'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

/**
 * Local resolves `@getflywheel/local/main` through a process-wide module alias
 * that only exists inside the running app, so the same trick is used here to
 * load the addon exactly as Local would.
 */
const stubs = new Map();
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
	if (stubs.has(request)) {
		return request;
	}

	return originalResolve.call(this, request, ...rest);
};

const originalLoad = Module._load;

Module._load = function (request, ...rest) {
	if (stubs.has(request)) {
		return stubs.get(request);
	}

	return originalLoad.call(this, request, ...rest);
};

/** Build a fake Local environment plus a temporary site on disk. */
function harness() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'linky-test-'));
	const sitePath = path.join(tmp, 'sites', 'my-site');

	fs.mkdirSync(path.join(sitePath, 'app', 'public'), { recursive: true });

	const site = {
		id: 'site-1',
		name: 'my-site',
		path: sitePath,
		frontendPort: 10063,
		frontendUrl: 'http://localhost:10063',
	};

	const actions = new Map();
	const ipc = new Map();
	const ipcMainHandlers = new Map();
	const sent = [];
	const notifications = [];

	// Records every WP-CLI invocation so tests can assert on the URL rewriting.
	const wpCliCalls = [];
	let currentHome = 'http://localhost:10063';

	const wpCli = {
		getOption: async (_site, option) => (option === 'home' ? currentHome : ''),
		run: async (_site, args) => {
			wpCliCalls.push(args);

			if (args[0] === 'search-replace') {
				currentHome = args[2];
			}

			if (args[0] === 'option' && args[1] === 'update' && args[2] === 'home') {
				currentHome = args[3];
			}

			return { stdout: '' };
		},
	};

	stubs.set('@getflywheel/local/main', {
		getServiceContainer: () => ({
			cradle: {
				siteData: { getSite: (id) => (id === site.id ? site : null) },
				wpCli,
				localLogger: {
					child: () => ({ info() {}, warn() {}, error() {} }),
				},
			},
		}),
		addIpcAsyncListener: (channel, fn) => ipc.set(channel, fn),
		sendIPCEvent: (channel, payload) => sent.push({ channel, payload }),
		formatHomePath: (p) => p,
	});

	const opened = [];

	const context = {
		environment: { userDataPath: path.join(tmp, 'userData') },
		electron: {
			app: { on() {} },
			dialog: {},
			ipcMain: { on: (channel, fn) => ipcMainHandlers.set(channel, fn) },
			shell: { openExternal: async (url) => opened.push(url) },
		},
		hooks: {
			addAction: (name, fn) => actions.set(name, fn),
			addFilter() {},
		},
		notifier: { notify: (n) => notifications.push(n) },
		fileSystem: fs,
	};

	/** Write the cached record the way enable()/disable() would leave it. */
	const optIn = (record) => {
		const dir = path.join(tmp, 'userData', 'linky-live');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'sites.json'), JSON.stringify({ [site.id]: { siteId: site.id, ...record } }));
	};

	return {
		tmp, site, sitePath, actions, ipc, ipcMainHandlers, sent, notifications, context, optIn, opened,
		wpCliCalls,
		home: () => currentHome,
		setHome: (url) => { currentHome = url; },
	};
}

const muPluginPath = (sitePath, file) =>
	path.join(sitePath, 'app', 'public', 'wp-content', 'mu-plugins', file);

test('addon loads and registers its hooks and IPC endpoints', () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	const addon = require('../src/main.js');

	assert.equal(typeof addon, 'function', 'Local requires the entrypoint to export a function');

	addon(H.context);

	// Without these two the search-engine rule and cleanup never run.
	assert.ok(H.actions.has('siteStarted'), 'must hook siteStarted');
	assert.ok(H.actions.has('siteStopped'), 'must hook siteStopped');

	for (const channel of [
		'linky-live:get-state',
		'linky-live:get-settings',
		'linky-live:save-settings',
		'linky-live:enable',
		'linky-live:disable',
		'linky-live:release',
		'linky-live:update-auth',
		'linky-live:update-paths',
		'linky-live:open',
	]) {
		assert.ok(H.ipc.has(channel), `must register ${channel}`);
	}
});

test('a site that never opted in is left completely untouched', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	await H.actions.get('siteStarted')(H.site);

	// The addon is opt-in per site. A site with no live link must not have its
	// mu-plugins directory touched at all.
	assert.equal(
		fs.existsSync(muPluginPath(H.sitePath, 'linky-live-noindex.php')),
		false,
		'must not install noindex into a site that never opted in',
	);

	assert.equal(fs.existsSync(muPluginPath(H.sitePath, 'linky-live-urls.php')), false);

	assert.equal(
		fs.existsSync(path.join(H.sitePath, 'app', 'public', 'wp-content', 'mu-plugins')),
		false,
		'must not even create the mu-plugins directory',
	);
});

test('an enabled site gets noindex re-asserted on every start', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// Simulate a site that already has a live link allocated.
	H.optIn({ hostname: 'linky-k4d8vn.example.com', port: 10063, bypassPaths: [], enabled: true });

	await H.actions.get('siteStarted')(H.site);

	const installed = muPluginPath(H.sitePath, 'linky-live-noindex.php');

	assert.ok(fs.existsSync(installed), 'noindex must be installed for an enabled site');

	const contents = fs.readFileSync(installed, 'utf8');

	assert.match(contents, /pre_option_blog_public/, 'must filter the option, not just set it');
	assert.match(contents, /pre_update_option_blog_public/, 'must also refuse writes');

	// The loopback guard belongs to an active tunnel, not merely a started site.
	assert.equal(
		fs.existsSync(muPluginPath(H.sitePath, 'linky-live-urls.php')),
		false,
		'the URL helper must not be installed merely because the site started',
	);
});

test('an outdated noindex mu-plugin gets overwritten on the next start', async () => {
	const H = harness();

	const target = muPluginPath(H.sitePath, 'linky-live-noindex.php');
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, '<?php // stale version');

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	H.optIn({ hostname: 'linky-k4d8vn.example.com', port: 10063, bypassPaths: [], enabled: true });

	await H.actions.get('siteStarted')(H.site);

	assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /stale version/, 'must overwrite, not skip');
});

test('a site with the link switched off is not touched on start', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// Has a hostname reserved, but the user turned the link off. Keeping a URL
	// reserved must not mean the addon keeps editing the site.
	H.optIn({ hostname: 'linky-k4d8vn.example.com', port: 10063, bypassPaths: [], enabled: false });

	await H.actions.get('siteStarted')(H.site);

	assert.equal(
		fs.existsSync(muPluginPath(H.sitePath, 'linky-live-noindex.php')),
		false,
		'noindex must only be forced while the link is switched on',
	);
});

test('turning the link off preserves it being off across a site restart', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	H.optIn({ hostname: 'linky-k4d8vn.example.com', port: 10063, bypassPaths: [], enabled: true });

	await H.ipc.get('linky-live:disable')(H.site.id);

	const state = await H.ipc.get('linky-live:get-state')(H.site.id);

	assert.equal(state.enabled, false, 'the off choice must persist');
	assert.equal(state.allocated, true, 'but the URL stays reserved');

	// A stopped site must not silently re-enable itself either.
	await H.actions.get('siteStopped')(H.site);

	assert.equal((await H.ipc.get('linky-live:get-state')(H.site.id)).enabled, false);
});

test('state reports sensibly before anything is configured', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	const state = await H.ipc.get('linky-live:get-state')(H.site.id);

	assert.deepEqual(state, {
		siteId: 'site-1',
		enabled: false,
		running: false,
		allocated: false,
		// Nothing is listening on the harness site's port, which is exactly the
		// condition that produces a 502 through a live tunnel.
		siteRunning: false,
		site: null,
		configured: false,
		hasApiKey: false,
		keyHint: '',
		controlHostname: '',
	});
});

test('enabling without an API key fails with a clear message', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	await assert.rejects(
		() => H.ipc.get('linky-live:enable')(H.site.id),
		/service address|API key/i,
		'the error must point the user at what is missing',
	);
});

test('the API key is stored with owner-only permissions', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	await H.ipc.get('linky-live:save-settings')({
		apiKey: 'super-secret',
		controlHostname: 'linky-live.example.com',
	});

	const state = await H.ipc.get('linky-live:get-state')(H.site.id);
	assert.equal(state.hasApiKey, true);
	assert.equal(state.configured, true);

	const settingsFile = path.join(H.context.environment.userDataPath, 'linky-live', 'settings.json');

	assert.ok(fs.existsSync(settingsFile));

	if (process.platform !== 'win32') {
		const mode = fs.statSync(settingsFile).mode & 0o777;

		assert.equal(mode, 0o600, 'a shared-team credential must not be world-readable');
	}
});

test('state flags when the site itself is not running', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// A link can be on for a stopped site: the tunnel connects and then 502s, so
	// the UI needs to tell the two apart.
	H.optIn({ hostname: 'linky-k4d8vn.example.com', port: 10063, bypassPaths: [], enabled: true });

	const state = await H.ipc.get('linky-live:get-state')(H.site.id);

	assert.equal(state.enabled, true, 'the link is switched on');
	assert.equal(state.running, false, 'but no tunnel process is up');
	assert.equal(state.siteRunning, false, 'and nothing is serving the port');
});

test('the running probe resolves quickly and never throws', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// The probe runs on every state read, so a closed or filtered port must fail
	// fast rather than hanging the panel.
	const started = process.hrtime.bigint();

	await H.ipc.get('linky-live:get-state')(H.site.id);

	const ms = Number(process.hrtime.bigint() - started) / 1e6;

	assert.ok(ms < 2000, `state read took ${Math.round(ms)}ms, expected well under the timeout`);
});

test('the renderer never receives the tunnel token or Cloudflare ids', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// Everything the worker returns gets cached, including secrets the UI has no
	// use for. Anyone holding a tunnel token can serve traffic on that hostname.
	H.optIn({
		hostname: 'linky-k4d8vn.example.com',
		url: 'https://linky-k4d8vn.example.com',
		localUrl: 'http://localhost:10063',
		port: 10063,
		bypassPaths: [],
		enabled: true,
		tunnelToken: 'SUPER-SECRET-TUNNEL-TOKEN',
		tunnelId: 'tunnel-uuid',
		dnsRecordId: 'dns-id',
		routeId: 'route-id',
		keyHash: 'abc123',
	});

	const state = await H.ipc.get('linky-live:get-state')(H.site.id);
	const serialised = JSON.stringify(state);

	for (const secret of ['SUPER-SECRET-TUNNEL-TOKEN', 'tunnel-uuid', 'dns-id', 'route-id', 'abc123']) {
		assert.ok(!serialised.includes(secret), `${secret} must not reach the renderer`);
	}

	// The fields the UI genuinely needs must still be present.
	assert.equal(state.site.hostname, 'linky-k4d8vn.example.com');
	assert.equal(state.site.url, 'https://linky-k4d8vn.example.com');
	assert.deepEqual(state.site.bypassPaths, []);
});

test('the tunnel is taken down before Local stops the site', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// Listening to the post-stop action alone leaves a window where the hostname
	// is live but nginx is already gone, which serves visitors a 502.
	assert.ok(
		H.ipcMainHandlers.has('siteStopped:before'),
		'must listen for the pre-stop event, not only the post-stop action',
	);
});

test('the URL helper is installed and removed with the tunnel', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	const helper = muPluginPath(H.sitePath, 'linky-live-urls.php');

	H.optIn({
		hostname: 'linky-k4d8vn.example.com',
		url: 'https://linky-k4d8vn.example.com',
		port: 10063,
		bypassPaths: [],
		enabled: true,
	});

	// Simulate the file an active link would have left behind.
	fs.mkdirSync(path.dirname(helper), { recursive: true });
	fs.writeFileSync(helper, '<?php // active');

	await H.ipc.get('linky-live:disable')(H.site.id);

	assert.equal(
		fs.existsSync(helper),
		false,
		'the helper must not outlive the tunnel: its rewriting is only correct while one is up',
	);
});

test('the URL helper sends the header the gateway needs', () => {
	const source = fs.readFileSync(
		path.join(__dirname, '..', 'mu-plugins', 'linky-live-urls.php'),
		'utf8',
	);

	// Without this header the gateway cannot know which host to replace, and URLs
	// hardcoded in post content stay broken.
	assert.match(source, /header\(\s*'X-Local-Host: '/, 'must send X-Local-Host');

	// It must only act on requests that actually came through the gateway.
	assert.match(source, /HTTP_X_LINKY_LIVE/, 'must require the gateway marker');

	// The port has to survive: Local serves every site on its own port.
	assert.match(source, /\$home\['port'\]/, 'must keep the port when detecting the local host');

	// And the public hostname must never be written into the database.
	assert.match(source, /pre_update_option/, 'must rewrite values on their way into the DB');
});

test('quitting is never blocked, even with links enabled', async () => {
	const H = harness();

	const quitHandlers = [];
	let quitCalls = 0;
	let preventedCalls = 0;

	H.context.electron.app = {
		on: (event, fn) => {
			if (event === 'before-quit') {
				quitHandlers.push(fn);
			}
		},
		quit: () => {
			quitCalls += 1;
		},
	};

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// A site with its link on is exactly the state that used to deadlock the quit:
	// the handler prevented it, cleaned up, called quit() again, and the still-
	// enabled site made it prevent the quit once more — forever.
	H.optIn({
		hostname: 'linky-k4d8vn.example.com',
		url: 'https://linky-k4d8vn.example.com',
		port: 10063,
		bypassPaths: [],
		enabled: true,
	});

	assert.equal(quitHandlers.length, 1, 'must register a before-quit handler');

	const event = {
		preventDefault: () => {
			preventedCalls += 1;
		},
	};

	await quitHandlers[0](event);

	assert.equal(preventedCalls, 0, 'must never cancel the quit');
	assert.equal(quitCalls, 0, 'must not re-trigger quit and risk recursion');
});


test('the service address is stored as a bare hostname however it is pasted', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// People paste a full URL as often as a hostname, and a trailing slash is easy
	// to include by accident.
	for (const input of [
		'linky-live.example.com',
		'https://linky-live.example.com',
		'http://linky-live.example.com/',
		'  https://linky-live.example.com/v1/status  ',
	]) {
		await H.ipc.get('linky-live:save-settings')({ apiKey: 'k', controlHostname: input });

		const state = await H.ipc.get('linky-live:get-state')(H.site.id);

		assert.equal(state.controlHostname, 'linky-live.example.com', `failed for: ${input}`);
	}
});

test('nothing is configured out of the box', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// Shipping a default service would point every install at somebody else's.
	const state = await H.ipc.get('linky-live:get-state')(H.site.id);

	assert.equal(state.controlHostname, '');
	assert.equal(state.configured, false);

	// A key alone is not enough to be usable.
	await H.ipc.get('linky-live:save-settings')({ apiKey: 'k' });

	assert.equal((await H.ipc.get('linky-live:get-state')(H.site.id)).configured, false);
});

test('a site with no resolvable port fails loudly rather than guessing 80', async () => {
	const H = harness();

	// This is the site-domains-mode shape: the URL is a bare domain with no port.
	// Defaulting to 80 there would point the tunnel at Local's router instead of
	// the site, which serves the wrong content instead of reporting a problem.
	H.site.frontendPort = undefined;
	H.site.frontendUrl = 'http://mysite.local';

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	await H.ipc.get('linky-live:save-settings')({
		apiKey: 'k',
		controlHostname: 'linky-live.example.com',
	});

	await assert.rejects(
		() => H.ipc.get('linky-live:enable')(H.site.id),
		/port/i,
		'must report that it could not determine the port',
	);
});

test('the nginx port is used in either router mode', async () => {
	// Local resolves frontendPort from the site's own HTTP service config, so it is
	// present in both modes even though the URL differs.
	for (const frontendUrl of ['http://localhost:10028', 'http://mysite.local']) {
		const H = harness();

		H.site.frontendPort = 10028;
		H.site.frontendUrl = frontendUrl;

		delete require.cache[require.resolve('../src/main.js')];
		require('../src/main.js')(H.context);

		H.optIn({
			hostname: 'linky-k4d8vn.example.com',
			url: 'https://linky-k4d8vn.example.com',
			port: 10028,
			bypassPaths: [],
			enabled: false,
		});

		const state = await H.ipc.get('linky-live:get-state')(H.site.id);

		// The port probe ran against the nginx port, not the router's 80.
		assert.equal(state.siteRunning, false, `${frontendUrl}: nothing is listening on 10028 in tests`);
		assert.equal(state.site.port, 10028, `${frontendUrl}: must record the nginx port`);
	}
});

test('the open endpoint builds the URL itself rather than taking one', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	H.optIn({ hostname: 'linky-k4d8vn.example.com', url: 'https://linky-k4d8vn.example.com', enabled: true });

	// The site's public address, and its wp-admin, are the only two things this
	// can open — the renderer sends a flag, not a URL, so nothing it could be fed
	// turns this into a way to launch arbitrary addresses.
	assert.deepEqual(
		await H.ipc.get('linky-live:open')({ siteId: H.site.id, admin: false }),
		{ ok: true, url: 'https://linky-k4d8vn.example.com/' },
	);

	assert.deepEqual(
		await H.ipc.get('linky-live:open')({ siteId: H.site.id, admin: true }),
		{ ok: true, url: 'https://linky-k4d8vn.example.com/wp-admin/' },
	);

	assert.deepEqual(H.opened, [
		'https://linky-k4d8vn.example.com/',
		'https://linky-k4d8vn.example.com/wp-admin/',
	], 'both must reach the default browser');
});

test('opening a site with no address does nothing', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// A site that never opted in has no hostname, so there is nothing to open and
	// no URL to guess at.
	assert.deepEqual(await H.ipc.get('linky-live:open')({ siteId: H.site.id, admin: false }), { ok: false });
	assert.deepEqual(H.opened, [], 'the browser must not be launched');
});

test('starting or stopping a site tells the panel, even with the link off', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// An address that is allocated but switched off. The panel still reports
	// whether the site is up, so it has to hear about a start it did not cause —
	// otherwise the tab reads "not running" until you navigate away and back.
	H.optIn({ hostname: 'linky-k4d8vn.example.com', url: 'https://linky-k4d8vn.example.com', enabled: false });

	await H.actions.get('siteStarted')(H.site);

	const started = H.sent.filter((m) => m.channel === 'linky-live:changed');

	assert.equal(started.length, 1, 'a start must be broadcast');
	assert.equal(started[0].payload.siteId, H.site.id);

	await H.actions.get('siteStopped')(H.site);

	assert.equal(
		H.sent.filter((m) => m.channel === 'linky-live:changed').length,
		2,
		'and so must a stop',
	);
});

test('a site that never opted in is not broadcast about', async () => {
	const H = harness();

	delete require.cache[require.resolve('../src/main.js')];
	require('../src/main.js')(H.context);

	// Opt-in per site is the whole contract: a site with no record has nothing to
	// report and no panel state to keep current.
	await H.actions.get('siteStarted')(H.site);
	await H.actions.get('siteStopped')(H.site);

	assert.deepEqual(H.sent.filter((m) => m.channel === 'linky-live:changed'), []);
});
