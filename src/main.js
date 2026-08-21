'use strict';

/**
 * Main-process half of the addon.
 *
 * Responsibilities:
 *   - manage mu-plugins and the cloudflared process for opted-in sites
 *   - re-assert the noindex rule when an enabled site starts
 *   - expose IPC endpoints the renderer drives
 *
 * The addon is opt-in per site and touches nothing until a site's live link is
 * switched on.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const { Cloudflared, FATAL_REASONS } = require('./cloudflared');
const { WorkerApi } = require('./api');

const MU_NOINDEX = 'linky-live-noindex.php';
const MU_LIVE_LINK = 'linky-live-urls.php';

/**
 * There is no default service to talk to.
 *
 * Every organisation runs its own Linky Live Worker, so the hostname is asked for
 * on first run alongside the key. Shipping a default would point installs at
 * somebody else's service.
 */
const DEFAULT_CONTROL_HOSTNAME = '';

const IPC = {
	GET_STATE: 'linky-live:get-state',
	GET_SETTINGS: 'linky-live:get-settings',
	SAVE_SETTINGS: 'linky-live:save-settings',
	ENABLE: 'linky-live:enable',
	DISABLE: 'linky-live:disable',
	RELEASE: 'linky-live:release',
	UPDATE_AUTH: 'linky-live:update-auth',
	UPDATE_PATHS: 'linky-live:update-paths',
	GET_ALL: 'linky-live:get-all',
	CHANGED: 'linky-live:changed',
};

module.exports = function addon(context) {
	const { electron, hooks, environment, notifier } = context;
	// electron.app is used for shutdown cleanup; see before-quit below.

	const LocalMain = require('@getflywheel/local/main');
	const { getServiceContainer, addIpcAsyncListener, sendIPCEvent } = LocalMain;

	const serviceContainer = getServiceContainer().cradle;
	const { siteData, localLogger } = serviceContainer;

	const logger = localLogger.child({ thread: 'main', class: 'LinkyLive' });

	const dataDir = path.join(environment.userDataPath, 'linky-live');
	fs.mkdirSync(dataDir, { recursive: true });

	const settingsPath = path.join(dataDir, 'settings.json');
	const cloudflared = new Cloudflared(dataDir, logger);

	/* ---------------------------------------------------------------- *
	 * Settings — the API key lives here, outside any site directory.
	 * ---------------------------------------------------------------- */

	function readSettings() {
		try {
			const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

			return {
				apiKey: raw.apiKey || '',
				controlHostname: normaliseHostname(raw.controlHostname),
			};
		} catch {
			return { apiKey: '', controlHostname: DEFAULT_CONTROL_HOSTNAME };
		}
	}

	/**
	 * Accept whatever shape the service hostname is pasted in.
	 *
	 * People paste a full URL as often as a bare hostname, and a trailing slash is
	 * easy to include by accident. Storing a bare hostname keeps the API client
	 * simple.
	 */
	function normaliseHostname(value) {
		const raw = String(value || '').trim();

		if (raw === '') {
			return '';
		}

		try {
			return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
		} catch {
			return '';
		}
	}

	function writeSettings(next) {
		const merged = { ...readSettings(), ...next };

		if (next && next.controlHostname !== undefined) {
			merged.controlHostname = normaliseHostname(next.controlHostname);
		}

		fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2), { mode: 0o600 });

		return merged;
	}

	const api = new WorkerApi(readSettings);

	/* ---------------------------------------------------------------- *
	 * Per-site cache of the worker's answer, so the UI can render the URL
	 * and credentials without a network round trip on every paint.
	 * ---------------------------------------------------------------- */

	const cachePath = path.join(dataDir, 'sites.json');

	function readCache() {
		try {
			return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
		} catch {
			return {};
		}
	}

	function writeCache(cache) {
		fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
	}

	/**
	 * Merge into the cached record rather than replacing it, so writing fresh
	 * worker data never clobbers the locally-owned `enabled` intent flag.
	 */
	function cacheSite(siteId, patch) {
		const cache = readCache();

		cache[siteId] = { ...(cache[siteId] || {}), ...patch };
		writeCache(cache);

		return cache[siteId];
	}

	/** Has the user switched the live link on for this site? */
	function isEnabled(siteId) {
		return Boolean(readCache()[siteId]?.enabled);
	}

	function uncacheSite(siteId) {
		const cache = readCache();
		delete cache[siteId];
		writeCache(cache);
	}

	/* ---------------------------------------------------------------- *
	 * mu-plugins
	 * ---------------------------------------------------------------- */

	function muPluginsDir(site) {
		const sitePath = LocalMain.formatHomePath(site.path);

		return path.join(sitePath, 'app', 'public', 'wp-content', 'mu-plugins');
	}

	/**
	 * Copy a bundled mu-plugin in, overwriting any older copy.
	 *
	 * Always overwriting means a fixed or updated mu-plugin reaches every site on
	 * the next start without any migration step.
	 */
	function installMuPlugin(site, filename) {
		const target = muPluginsDir(site);

		try {
			fs.mkdirSync(target, { recursive: true });
			fs.copyFileSync(path.join(__dirname, '..', 'mu-plugins', filename), path.join(target, filename));

			return true;
		} catch (err) {
			logger.warn(`Could not install ${filename} for ${site.name}: ${err.message}`);

			return false;
		}
	}

	function removeMuPlugin(site, filename) {
		try {
			fs.rmSync(path.join(muPluginsDir(site), filename), { force: true });
		} catch (err) {
			logger.warn(`Could not remove ${filename} for ${site.name}: ${err.message}`);
		}
	}

	/* ---------------------------------------------------------------- *
	 * State reported to the renderer
	 * ---------------------------------------------------------------- */

	/**
	 * Is anything actually accepting connections on the site's port?
	 *
	 * A link can be switched on for a stopped site — the tunnel connects fine and
	 * then returns 502, because cloudflared has nothing to forward to. Without this
	 * check the UI would claim the link is live while every request failed.
	 */
	function probePort(port, timeout = 700) {
		return new Promise((resolve) => {
			if (!port) {
				resolve(false);
				return;
			}

			const socket = new net.Socket();
			const done = (result) => {
				socket.destroy();
				resolve(result);
			};

			socket.setTimeout(timeout);
			socket.once('connect', () => done(true));
			socket.once('timeout', () => done(false));
			socket.once('error', () => done(false));
			socket.connect(port, '127.0.0.1');
		});
	}

	/**
	 * Fields the renderer is allowed to see.
	 *
	 * Deliberately a whitelist, following Local's own `_processKeyWhiteList`: the
	 * cached record also holds the tunnel token and Cloudflare resource ids, and
	 * anyone holding a tunnel token can serve traffic on that hostname. None of it
	 * is needed to draw the UI, so none of it is sent.
	 */
	const RENDERER_FIELDS = [
		'siteId',
		'siteName',
		'hostname',
		'url',
		'localUrl',
		'port',
		'authUser',
		'authPass',
		'bypassPaths',
		'createdAt',
		'enabled',
	];

	function publicSiteView(record) {
		if (!record) {
			return null;
		}

		return RENDERER_FIELDS.reduce((acc, key) => {
			if (record[key] !== undefined) {
				acc[key] = record[key];
			}

			return acc;
		}, {});
	}

	async function getState(siteId) {
		const cache = readCache();
		const site = cache[siteId] || null;
		const settings = readSettings();

		const localSite = siteData.getSite(siteId);

		return {
			siteId,
			// `enabled` is the user's persisted choice; `running` is whether the
			// tunnel process is actually up right now. They differ while a site is
			// stopped or a resume failed.
			enabled: Boolean(site && site.enabled),
			running: cloudflared.isRunning(siteId),
			allocated: Boolean(site),
			// Distinguishes "the link is broken" from "the site it points at is off",
			// which is by far the more common cause of a 502.
			siteRunning: localSite ? await probePort(frontendPort(localSite)) : false,
			site: publicSiteView(site),
			// Both halves are needed before anything can be provisioned.
			configured: Boolean(settings.apiKey && settings.controlHostname),
			hasApiKey: Boolean(settings.apiKey),
			// Enough of the key to recognise which one is in use, never enough to
			// reconstruct it.
			keyHint: settings.apiKey ? `…${settings.apiKey.slice(-6)}` : '',
			controlHostname: settings.controlHostname,
		};
	}

	async function broadcast(siteId) {
		sendIPCEvent(IPC.CHANGED, await getState(siteId));
	}

	/* ---------------------------------------------------------------- *
	 * Enable / disable
	 * ---------------------------------------------------------------- */

	function frontendPort(site) {
		// Local exposes this directly, but fall back to parsing the URL for older
		// versions or unusual routing modes.
		if (site.frontendPort) {
			return Number(site.frontendPort);
		}

		try {
			const url = new URL(site.frontendUrl);

			return Number(url.port) || 80;
		} catch {
			return null;
		}
	}

	async function enable(siteId) {
		const site = siteData.getSite(siteId);

		if (!site) {
			throw new Error('That site no longer exists.');
		}

		const port = frontendPort(site);

		if (!port) {
			throw new Error('Could not determine the site port. Start the site first, then try again.');
		}

		// Reuses the existing hostname when the site already has one, which is what
		// keeps a registered webhook URL valid across restarts.
		const { site: allocated } = await api.provision(siteId, site.name, port);

		cacheSite(siteId, { ...allocated, enabled: true });

		installMuPlugin(site, MU_NOINDEX);

		/*
		 * No database changes. WordPress keeps believing it lives at its local
		 * address, which is what keeps Local's one-click admin, WordPress's loopback
		 * requests, and .local browsing all working. The helper mu-plugin points
		 * generated URLs at the public host and tells the gateway what to rewrite in
		 * the response body.
		 */
		installMuPlugin(site, MU_LIVE_LINK);

		await cloudflared.start(siteId, allocated.tunnelToken, {
			onExit: (code, signal, reason) => handleUnexpectedExit(siteId, code, reason),
		});

		reconnects.delete(siteId);
		broadcast(siteId);

		return getState(siteId);
	}

	/**
	 * Delay before the next reconnect attempt.
	 *
	 * Fibonacci, as Local's own Live Links does: quick retries for a momentary
	 * blip, backing off fast enough that a sustained outage is not hammered.
	 */
	function reconnectDelay(attempt) {
		let a = 1;
		let b = 0;

		for (let i = 0; i <= attempt; i += 1) {
			const previous = a;
			a += b;
			b = previous;
		}

		return b * 1000;
	}

	/** Give up after this long, rather than retrying forever in the background. */
	const MAX_RECONNECT_MS = 60 * 1000;

	/** Attempt bookkeeping per site, cleared on any successful manual action. */
	const reconnects = new Map();

	/**
	 * A tunnel died on its own. Decide whether to retry.
	 *
	 * Previously any exit was terminal, so a dropped wifi connection or a laptop
	 * waking from sleep permanently killed the link with only a notification —
	 * despite the tunnel being trivially restartable.
	 */
	async function handleUnexpectedExit(siteId, code, reason) {
		const site = siteData.getSite(siteId);
		const name = site ? site.name : siteId;

		// The user may have switched it off while the process was dying.
		if (!isEnabled(siteId)) {
			return;
		}

		if (FATAL_REASONS.has(reason)) {
			logger.warn(`Live link for ${name} failed permanently (${reason}); not retrying.`);

			notifier.notify({
				title: 'Live Link failed',
				message: reason === 'unauthorized'
					? `The live link for ${name} was rejected. Check your API key, or release and re-enable the address.`
					: `The live link for ${name} no longer exists. Release the address and turn it on again.`,
			});

			await disable(siteId);

			return;
		}

		if (reason === 'localUnreachable') {
			logger.warn(`Live link for ${name} could not reach the site; waiting for it to start.`);

			notifier.notify({
				title: 'Live Link paused',
				message: `${name} is not reachable on its port. The link will return when the site is running.`,
			});

			await stopTunnel(siteId);

			return;
		}

		const state = reconnects.get(siteId) || { attempt: 0, since: Date.now() };

		if (Date.now() - state.since >= MAX_RECONNECT_MS) {
			logger.warn(`Giving up reconnecting the live link for ${name} after ${MAX_RECONNECT_MS / 1000}s.`);

			notifier.notify({
				title: 'Live Link stopped',
				message: `The live link for ${name} could not reconnect (exit ${code}). Turn it on again when ready.`,
			});

			reconnects.delete(siteId);
			await stopTunnel(siteId);

			return;
		}

		state.attempt += 1;
		reconnects.set(siteId, state);

		const delay = reconnectDelay(state.attempt);

		logger.info(`Reconnecting the live link for ${name} in ${delay / 1000}s (attempt ${state.attempt}).`);

		broadcast(siteId);

		setTimeout(() => {
			// Re-check intent: the user may have turned it off while we waited.
			if (!isEnabled(siteId)) {
				reconnects.delete(siteId);

				return;
			}

			enable(siteId).catch((err) => {
				logger.warn(`Reconnect attempt for ${name} failed: ${err.message}`);
			});
		}, delay).unref?.();
	}

	/**
	 * Stop the tunnel process, leaving the user's on/off intent alone.
	 *
	 * Used when Local stops the site: the link should come back with the site, so
	 * stopping the process must not be mistaken for the user turning it off.
	 */
	async function stopTunnel(siteId) {
		const site = siteData.getSite(siteId);

		await cloudflared.stop(siteId);

		if (site) {
			// The helper is only correct while a tunnel is actually up.
			removeMuPlugin(site, MU_LIVE_LINK);
		}

		broadcast(siteId);
	}

	/** The user explicitly switched the link off. */
	async function disable(siteId) {
		cacheSite(siteId, { enabled: false });

		await stopTunnel(siteId);

		return getState(siteId);
	}

	async function release(siteId) {
		const site = siteData.getSite(siteId);

		await disable(siteId);
		await api.release(siteId);


		// Releasing is a full opt-out, so leave nothing of ours behind — including
		// the noindex enforcement, which only existed because the site was exposed.
		if (site) {
			removeMuPlugin(site, MU_NOINDEX);
			removeMuPlugin(site, MU_LIVE_LINK);
		}

		uncacheSite(siteId);
		broadcast(siteId);

		return getState(siteId);
	}

	/* ---------------------------------------------------------------- *
	 * Hooks
	 * ---------------------------------------------------------------- */

	/**
	 * Re-assert the search-engine rule on start, for opted-in sites only.
	 *
	 * The addon is opt-in per site: a site that has never been given a live link
	 * is left completely untouched, including its mu-plugins directory. Once a
	 * site does have one, indexing is forced off on every start and cannot be
	 * turned back on, because that site can be made public at any moment.
	 */
	hooks.addAction('siteStarted', async (site) => {
		if (!isEnabled(site.id)) {
			return;
		}

		installMuPlugin(site, MU_NOINDEX);

		// Bring the link back up with the site. Without this the switch would read
		// as on while nothing served it, and a registered webhook would fail
		// silently after every restart. enable() also re-provisions, which corrects
		// the ingress port if Local reassigned one.
		try {
			await enable(site.id);
		} catch (err) {
			logger.warn(`Could not resume the live link for ${site.name}: ${err.message}`);

			notifier.notify({
				title: 'Live Link did not resume',
				message: `${site.name} is running, but its live link could not start: ${err.message}`,
			});
		}
	});

	/**
	 * Take the tunnel down *before* Local stops the site's services.
	 *
	 * The `siteStopped` action fires after nginx is already gone, which leaves a
	 * window where the hostname is still live and every visitor gets a 502. Local's
	 * own Live Links listens to this same pre-stop event for that reason.
	 *
	 * `sendIPCEvent` re-emits on ipcMain, which is how an addon can observe it.
	 */
	electron.ipcMain.on('siteStopped:before', async (_event, stoppingSite) => {
		const id = stoppingSite && stoppingSite.id;

		if (id && cloudflared.isRunning(id)) {
			await stopTunnel(id);
		}
	});

	// Backstop, in case the pre-stop event is ever missed.
	hooks.addAction('siteStopped', async (site) => {
		if (cloudflared.isRunning(site.id)) {
			await stopTunnel(site.id);
		}
	});

	/* ---------------------------------------------------------------- *
	 * IPC
	 * ---------------------------------------------------------------- */

	addIpcAsyncListener(IPC.GET_STATE, (siteId) => getState(siteId));

	/**
	 * Every site's public URL in one call.
	 *
	 * The renderer needs this synchronously to answer Local's `openSiteUrl` filter,
	 * which decides where the "Open site" and one-click admin buttons point. It
	 * cannot await, so it keeps a local copy refreshed from here.
	 */
	addIpcAsyncListener(IPC.GET_ALL, () => {
		const cache = readCache();

		return Object.keys(cache).reduce((acc, id) => {
			acc[id] = {
				url: cache[id].url || '',
				localUrl: cache[id].localUrl || '',
				enabled: Boolean(cache[id].enabled),
			};

			return acc;
		}, {});
	});
	addIpcAsyncListener(IPC.GET_SETTINGS, () => readSettings());

	addIpcAsyncListener(IPC.SAVE_SETTINGS, (next) => writeSettings(next));

	addIpcAsyncListener(IPC.ENABLE, (siteId) => enable(siteId));
	addIpcAsyncListener(IPC.DISABLE, (siteId) => disable(siteId));
	addIpcAsyncListener(IPC.RELEASE, (siteId) => release(siteId));

	addIpcAsyncListener(IPC.UPDATE_AUTH, async ({ siteId, authUser, authPass, regenerate }) => {
		const { site } = await api.config(siteId, { authUser, authPass, regenerate });

		cacheSite(siteId, { ...readCache()[siteId], ...site });
		broadcast(siteId);

		return getState(siteId);
	});

	addIpcAsyncListener(IPC.UPDATE_PATHS, async ({ siteId, bypassPaths }) => {
		const { site } = await api.config(siteId, { bypassPaths });

		cacheSite(siteId, { ...readCache()[siteId], ...site });
		broadcast(siteId);

		return getState(siteId);
	});

	/**
	 * Tidy up on quit rather than leaving it to the next launch.
	 *
	 * Tunnels are child processes so they would die anyway, but the site's URLs
	 * would stay pointed at the public hostname — which breaks the site locally
	 * until something restores them. Local's Live Links cleans its mu-plugins up on
	 * shutdown for the same reason.
	 */
	/**
	 * Stop tunnels on the way out.
	 *
	 * Deliberately does not delay the quit. An earlier version called
	 * `event.preventDefault()` to restore database URLs first, then `app.quit()` —
	 * which re-fires this event, hits the same still-enabled sites, and prevents
	 * the quit again. Local could then never exit, so "relaunch" hung forever.
	 *
	 * There is nothing left to wait for anyway: the database is no longer modified,
	 * and cloudflared is a child process that exits with Local regardless.
	 */
	electron.app.on('before-quit', () => {
		cloudflared.stopAll();
	});

	logger.info('Linky Live add-on loaded');
};

module.exports.IPC = IPC;
