import { Platform, requestUrl } from 'obsidian';

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

/** How often to re-fetch from the API (5 minutes). */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: CacheEntry | null = null;
let inflight: Promise<RateLimitData | null> | null = null;

/**
 * Read the Claude OAuth access token from ~/.claude/.credentials.json (Linux)
 * or macOS Keychain. Returns null if unavailable or expired.
 */
async function getAccessToken(): Promise<string | null> {
	if (!Platform.isDesktop) return null;

	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const fs = require('fs') as typeof import('fs');
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const path = require('path') as typeof import('path');
	const home = process.env.HOME || process.env.USERPROFILE || '';

	// Try macOS Keychain first
	if (process.platform === 'darwin') {
		try {
			const { execSync } = require('child_process') as typeof import('child_process');
			const raw = execSync(
				'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
				{ encoding: 'utf-8', timeout: 3000 },
			).trim();
			if (raw) {
				const parsed = JSON.parse(raw);
				const creds = parsed.claudeAiOauth || parsed;
				if (creds.accessToken) {
					if (creds.expiresAt && creds.expiresAt <= Date.now()) return null;
					return creds.accessToken;
				}
			}
		} catch { /* fall through to file */ }
	}

	// Fall back to credentials file
	const credPath = path.join(home, '.claude', '.credentials.json');
	try {
		if (!fs.existsSync(credPath)) return null;
		const parsed = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
		const creds = parsed.claudeAiOauth || parsed;
		if (creds.accessToken) {
			if (creds.expiresAt && creds.expiresAt <= Date.now()) return null;
			return creds.accessToken;
		}
	} catch { /* ignore */ }

	return null;
}

/**
 * Fetch rate limit utilization from the Anthropic OAuth usage API.
 * Returns cached data if within TTL. Returns null if unavailable.
 */
export async function fetchRateLimits(): Promise<RateLimitData | null> {
	// Return cached if fresh
	if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
		return cached.data;
	}

	// Deduplicate concurrent requests
	if (inflight) return inflight;

	inflight = (async () => {
		try {
			const token = await getAccessToken();
			if (!token) return cached?.data ?? null;

			const response = await requestUrl({
				url: 'https://api.anthropic.com/api/oauth/usage',
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`,
					'anthropic-beta': 'oauth-2025-04-20',
					'Content-Type': 'application/json',
				},
			});

			if (response.status !== 200) return cached?.data ?? null;

			const body = response.json;
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
			return data;
		} catch {
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
