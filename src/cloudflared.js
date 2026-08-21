'use strict';

/**
 * Locates, downloads, and runs the cloudflared binary.
 *
 * Teammates should never have to install anything by hand, so a system-wide
 * cloudflared is used when present and otherwise a private copy is fetched once
 * per machine into the addon's own data directory.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

/**
 * Map the current platform to its release asset.
 *
 * Linux and Windows publish bare executables. macOS only ships a .tgz, so that
 * one needs an extra extraction step.
 */
function assetForPlatform() {
	const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';

	if (process.platform === 'win32') {
		/*
		 * Cloudflare publishes no windows-arm64 build, so an ARM machine (Surface,
		 * Snapdragon laptops) has to take the amd64 one. Windows runs it under
		 * emulation. Requesting the arm64 asset would simply 404.
		 */
		return { asset: 'cloudflared-windows-amd64.exe', binary: 'cloudflared.exe', archive: false };
	}

	if (process.platform === 'darwin') {
		return { asset: `cloudflared-darwin-${arch}.tgz`, binary: 'cloudflared', archive: true };
	}

	if (process.platform === 'linux') {
		return { asset: `cloudflared-linux-${arch}`, binary: 'cloudflared', archive: false };
	}

	return null;
}

/** Follow redirects manually; GitHub release downloads always redirect to a CDN. */
function download(url, destination, onProgress, redirectsLeft = 5) {
	return new Promise((resolve, reject) => {
		https
			.get(url, { headers: { 'User-Agent': 'linky-live' } }, (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();

					if (redirectsLeft === 0) {
						reject(new Error('Too many redirects while downloading cloudflared.'));
						return;
					}

					download(res.headers.location, destination, onProgress, redirectsLeft - 1)
						.then(resolve)
						.catch(reject);

					return;
				}

				if (res.statusCode !== 200) {
					res.resume();
					reject(new Error(`Download failed with HTTP ${res.statusCode}.`));
					return;
				}

				const total = Number(res.headers['content-length']) || 0;
				let received = 0;

				const file = fs.createWriteStream(destination);

				res.on('data', (chunk) => {
					received += chunk.length;

					if (onProgress && total) {
						onProgress(Math.round((received / total) * 100));
					}
				});

				res.pipe(file);

				file.on('finish', () => file.close(resolve));
				file.on('error', reject);
			})
			.on('error', reject);
	});
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		execFile(command, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
	});
}

/**
 * Work out why cloudflared stopped, from its own log output.
 *
 * cloudflared exits non-zero for almost everything, so the exit code alone
 * cannot distinguish "the laptop's wifi dropped" (worth retrying) from "this
 * tunnel was deleted" (retrying forever would be pointless noise).
 *
 * @param {string[]} lines Recent output.
 * @returns {'localUnreachable'|'unauthorized'|'notFound'|'network'|'unknown'}
 */
function classifyExit(lines = []) {
	const text = lines.join('\n').toLowerCase();

	// The local site is not listening — retrying cannot help until it is started.
	if (text.includes('connection refused') || text.includes('no such host') || text.includes('dial tcp')) {
		return 'localUnreachable';
	}

	if (text.includes('unauthorized') || text.includes('invalid tunnel token') || text.includes('401')) {
		return 'unauthorized';
	}

	if (text.includes('tunnel not found') || text.includes('has been deleted') || text.includes('404')) {
		return 'notFound';
	}

	if (
		text.includes('failed to serve') ||
		text.includes('connect: network is unreachable') ||
		text.includes('timeout') ||
		text.includes('temporary failure in name resolution')
	) {
		return 'network';
	}

	return 'unknown';
}

/** Reasons where reconnecting is futile, so we stop and tell the user instead. */
const FATAL_REASONS = new Set(['unauthorized', 'notFound']);

class Cloudflared {
	/**
	 * @param {string} dataDir Addon-owned directory for the cached binary.
	 * @param {object} logger
	 */
	constructor(dataDir, logger) {
		this.dataDir = dataDir;
		this.logger = logger;
		this.binDir = path.join(dataDir, 'bin');

		/** @type {Map<string, object>} siteId -> running tunnel info */
		this.processes = new Map();
	}

	get binaryPath() {
		const target = assetForPlatform();

		return target ? path.join(this.binDir, target.binary) : null;
	}

	/** True once a usable binary is available without any network access. */
	async isInstalled() {
		if (fs.existsSync(this.binaryPath)) {
			return true;
		}

		return Boolean(await this.systemBinary());
	}

	/**
	 * Prefer a cloudflared the user already has; it may be newer and is likely on
	 * a managed update path.
	 */
	async systemBinary() {
		const probe = process.platform === 'win32' ? 'where' : 'which';

		try {
			const out = await run(probe, ['cloudflared']);
			const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];

			return first || null;
		} catch {
			return null;
		}
	}

	/** Resolve the binary to use, downloading one if necessary. */
	async ensureBinary(onProgress) {
		const system = await this.systemBinary();

		if (system) {
			return system;
		}

		const target = assetForPlatform();

		if (!target) {
			throw new Error(`cloudflared has no build for ${process.platform}/${process.arch}.`);
		}

		const finalPath = this.binaryPath;

		if (fs.existsSync(finalPath)) {
			return finalPath;
		}

		fs.mkdirSync(this.binDir, { recursive: true });

		const tmp = path.join(this.binDir, `.download-${Date.now()}`);

		this.logger.info(`Downloading ${target.asset}`);

		await download(`${RELEASE_BASE}/${target.asset}`, tmp, onProgress);

		if (target.archive) {
			// macOS ships a tarball containing a single `cloudflared` binary. tar is
			// present on every supported macOS version.
			await run('tar', ['-xzf', tmp, '-C', this.binDir]);
			fs.unlinkSync(tmp);
		} else {
			fs.renameSync(tmp, finalPath);
		}

		if (process.platform !== 'win32') {
			fs.chmodSync(finalPath, 0o755);
		}

		this.logger.info(`cloudflared ready at ${finalPath}`);

		return finalPath;
	}

	isRunning(siteId) {
		return this.processes.has(siteId);
	}

	/**
	 * Start a tunnel for a site using the token issued by the worker.
	 *
	 * A remotely-managed tunnel carries its own ingress configuration, so the
	 * token is the only thing needed here — no config file, no login, no
	 * credentials on disk.
	 */
	async start(siteId, tunnelToken, { onExit, onProgress } = {}) {
		if (this.processes.has(siteId)) {
			return this.processes.get(siteId);
		}

		const binary = await this.ensureBinary(onProgress);

		const args = [
			'tunnel',
			'--no-autoupdate',
			// Local's log file is the one place a teammate can look for answers.
			'--loglevel',
			'info',
			'run',
			'--token',
			tunnelToken,
		];

		this.logger.info(`Starting cloudflared for site ${siteId}`);

		const child = spawn(binary, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			// Detaching would outlive Local and leave orphaned tunnels behind.
			detached: false,
			windowsHide: true,
		});

		const entry = { child, siteId, startedAt: Date.now(), stopping: false, tail: [] };

		this.processes.set(siteId, entry);

		const relay = (buffer) => {
			const text = String(buffer).trim();

			if (!text) {
				return;
			}

			this.logger.info(`[cloudflared ${siteId}] ${text}`);

			// Keep a short tail so an exit can be classified. cloudflared reports
			// failures as log lines, not exit codes, so there is nothing else to go on.
			entry.tail.push(text);

			if (entry.tail.length > 40) {
				entry.tail.shift();
			}
		};

		child.stdout.on('data', relay);
		child.stderr.on('data', relay);

		child.on('exit', (code, signal) => {
			this.processes.delete(siteId);

			const reason = classifyExit(entry.tail);

			this.logger.info(
				`cloudflared for ${siteId} exited (code ${code}, signal ${signal}, reason ${reason})`,
			);

			// Only surface unexpected deaths; a deliberate stop is not an error.
			if (!entry.stopping && onExit) {
				onExit(code, signal, reason);
			}
		});

		child.on('error', (err) => {
			this.processes.delete(siteId);
			this.logger.warn(`cloudflared for ${siteId} failed to start: ${err.message}`);
		});

		return entry;
	}

	async stop(siteId) {
		const entry = this.processes.get(siteId);

		if (!entry) {
			return;
		}

		entry.stopping = true;

		return new Promise((resolve) => {
			let settled = false;

			const done = () => {
				if (!settled) {
					settled = true;
					this.processes.delete(siteId);
					resolve();
				}
			};

			entry.child.once('exit', done);

			try {
				if (process.platform === 'win32') {
					// SIGTERM is not delivered reliably on Windows.
					execFile('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], () => {});
				} else {
					entry.child.kill('SIGTERM');
				}
			} catch (err) {
				this.logger.warn(`Could not signal cloudflared for ${siteId}: ${err.message}`);
				done();
				return;
			}

			// Escalate if it ignores the polite request.
			setTimeout(() => {
				if (!settled) {
					try {
						entry.child.kill('SIGKILL');
					} catch {
						/* already gone */
					}

					done();
				}
			}, 8000);
		});
	}

	async stopAll() {
		await Promise.all([...this.processes.keys()].map((siteId) => this.stop(siteId)));
	}
}

module.exports = { Cloudflared, assetForPlatform, classifyExit, FATAL_REASONS };
