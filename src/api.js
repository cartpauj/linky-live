'use strict';

/**
 * Client for the linky-live worker.
 *
 * Deliberately thin: the worker holds the real Cloudflare token and does all
 * privileged work, so this only ever sends a team API key and a site id.
 */

const https = require('https');

class WorkerApi {
	/**
	 * @param {() => {controlHostname: string, apiKey: string}} getConfig
	 */
	constructor(getConfig) {
		this.getConfig = getConfig;
	}

	request(method, endpoint, body) {
		const { controlHostname, apiKey } = this.getConfig();

		if (!controlHostname) {
			return Promise.reject(
				new Error('Set your Linky Live service address in the Linky Live tab first.'),
			);
		}

		if (!apiKey) {
			return Promise.reject(new Error('Add your Linky Live API key in the Linky Live tab first.'));
		}

		const payload = body ? JSON.stringify(body) : null;

		const options = {
			hostname: controlHostname,
			port: 443,
			path: endpoint,
			method,
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Accept': 'application/json',
				...(payload
					? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
					: {}),
			},
			timeout: 30000,
		};

		return new Promise((resolve, reject) => {
			const req = https.request(options, (res) => {
				let raw = '';

				res.setEncoding('utf8');
				res.on('data', (chunk) => {
					raw += chunk;
				});

				res.on('end', () => {
					let parsed;

					try {
						parsed = JSON.parse(raw);
					} catch {
						reject(new Error(`Live link service returned an unreadable response (HTTP ${res.statusCode}).`));
						return;
					}

					if (res.statusCode >= 400 || parsed.ok === false) {
						// The worker's own message is the useful one; surface it verbatim.
						reject(new Error(parsed.error || `Live link service error (HTTP ${res.statusCode}).`));
						return;
					}

					resolve(parsed);
				});
			});

			req.on('timeout', () => {
				req.destroy(new Error('The live link service timed out.'));
			});

			req.on('error', reject);

			if (payload) {
				req.write(payload);
			}

			req.end();
		});
	}

	/** Allocate a hostname for a site, or return the one it already owns. */
	provision(siteId, siteName, port) {
		return this.request('POST', '/v1/provision', { siteId, siteName, port });
	}

	/** Update the owner-controlled credentials and bypass paths. */
	config(siteId, changes) {
		return this.request('POST', '/v1/config', { siteId, ...changes });
	}

	/** Permanently give up a hostname. Invalidates any registered webhook URL. */
	release(siteId) {
		return this.request('POST', '/v1/release', { siteId });
	}

	status(siteId) {
		const query = siteId ? `?siteId=${encodeURIComponent(siteId)}` : '';

		return this.request('GET', `/v1/status${query}`);
	}
}

module.exports = { WorkerApi };
