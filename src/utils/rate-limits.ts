import { Platform, requestUrl } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Logger } from './logger';

export interface RateLimitData {
	fiveHourPercent: number | null;
	fiveHourResetsAt: string | null;
	weeklyPercent: number | null;
	weeklyResetsAt: string | null;
}

/** Cache entry with timestamp for TTL checks. */
interface CacheEntry {
	data: RateLimitData;
	fetchedAt: number;
}

interface CredentialData {
	claudeAiOauth?: { accessToken?: string; expiresAt?: number };
	accessToken?: string;
	expiresAt?: number;
}

interface UsageResponse {
	five_hour?: { utilization?: unknown; resets_at?: string };
	seven_day?: { utilization?: unknown; resets_at?: string };
}

/** How often to re-fetch from the API (5 minutes). */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** How often to re-fetch from the API (1 minute). */
// const CACHE_TTL_MS = 1 * 60 * 1000;
// CAUSING TOO MANY REQUEST error 429

let cached: CacheEntry | null = null;
let inflight: Promise<RateLimitData | null> | null = null;

/**
 * Read the Claude OAuth access token from ~/.claude/.credentials.json (Linux)
 * or macOS Keychain. Returns null if unavailable or expired.
 */
function getAccessToken(): string | null {
	if (!Platform.isDesktop) {
		Logger.debug('[rate-limits] not desktop, skipping token retrieval');
		return null;
	}

	const home = process.env.HOME || process.env.USERPROFILE || '';

	// Try macOS Keychain first
	if (process.platform === 'darwin') {
		try {
			Logger.debug('[rate-limits] attempting keychain lookup...');
			const raw = execSync(
				'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
				{ encoding: 'utf-8', timeout: 3000 },
			).trim();
			if (raw) {
				const parsed = JSON.parse(raw) as CredentialData;
				const creds = parsed.claudeAiOauth ?? parsed;
				if (creds.accessToken) {
					if (creds.expiresAt && creds.expiresAt <= Date.now()) {
						Logger.warn('[rate-limits] keychain token expired', {
							expiresAt: new Date(creds.expiresAt).toISOString(),
							now: new Date().toISOString(),
						});
						return null;
					}
					Logger.debug('[rate-limits] keychain token found and valid');
					return creds.accessToken;
				}
			}
			Logger.debug('[rate-limits] keychain entry found but no accessToken');
		} catch (err) {
			Logger.debug('[rate-limits] keychain lookup failed, trying file', err);
		}
	}

	// Fall back to credentials file
	const credPath = path.join(home, '.claude', '.credentials.json');
	Logger.debug('[rate-limits] checking credentials file:', credPath);
	try {
		if (!fs.existsSync(credPath)) {
			Logger.debug('[rate-limits] credentials file not found');
			return null;
		}
		const parsed = JSON.parse(fs.readFileSync(credPath, 'utf-8')) as CredentialData;
		const creds = parsed.claudeAiOauth ?? parsed;
		if (creds.accessToken) {
			if (creds.expiresAt && creds.expiresAt <= Date.now()) {
				Logger.warn('[rate-limits] file token expired', {
					expiresAt: new Date(creds.expiresAt).toISOString(),
					now: new Date().toISOString(),
				});
				return null;
			}
			Logger.debug('[rate-limits] file token found and valid');
			return creds.accessToken;
		}
		Logger.debug('[rate-limits] credentials file parsed but no accessToken');
	} catch (err) {
		Logger.error('[rate-limits] failed to read credentials file', err);
	}

	return null;
}

/**
 * Fetch rate limit utilization from the Anthropic OAuth usage API.
 * Returns cached data if within TTL. Returns null if unavailable.
 */
export async function fetchRateLimits(): Promise<RateLimitData | null> {
	// Return cached if fresh
	if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
		const age = Math.round((Date.now() - cached.fetchedAt) / 1000);
		Logger.debug(`[rate-limits] returning cached data (${age}s old)`);
		return cached.data;
	}

	// Deduplicate concurrent requests
	if (inflight) {
		Logger.debug('[rate-limits] request already inflight, deduping');
		return inflight;
	}

	Logger.debug('[rate-limits] fetching fresh data...');

	inflight = (async () => {
		try {
			const token = getAccessToken();
			if (!token) {
				Logger.warn('[rate-limits] no OAuth token found');
				return cached?.data ?? null;
			}
			Logger.debug('[rate-limits] token found, calling API...');

			const response = await requestUrl({
				url: 'https://api.anthropic.com/api/oauth/usage',
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`,
					'anthropic-beta': 'oauth-2025-04-20',
					'Content-Type': 'application/json',
				},
			});

			if (response.status !== 200) {
				Logger.warn(`[rate-limits] API returned status ${response.status}`, response.text);
				return cached?.data ?? null;
			}

			const body = response.json as UsageResponse;
			Logger.debug('[rate-limits] API response:', JSON.stringify(body, null, 2));

			const clamp = (v: unknown): number | null => {
				if (v == null || typeof v !== 'number' || !isFinite(v)) return null;
				return Math.max(0, Math.min(100, v));
			};

			const data: RateLimitData = {
				fiveHourPercent: clamp(body.five_hour?.utilization),
				fiveHourResetsAt: body.five_hour?.resets_at ?? null,
				weeklyPercent: clamp(body.seven_day?.utilization),
				weeklyResetsAt: body.seven_day?.resets_at ?? null,
			};

			cached = { data, fetchedAt: Date.now() };
			Logger.debug('[rate-limits] cached fresh data:', data);
			return data;
		} catch (err) {
			Logger.error('[rate-limits] fetch failed:', err);
			return cached?.data ?? null;
		} finally {
			inflight = null;
		}
	})();

	return inflight;
}

/** Clear the in-memory cache (e.g. when the setting is toggled off). */
export function clearRateLimitCache(): void {
	cached = null;
}
