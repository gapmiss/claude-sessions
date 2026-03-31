import type { PluginSettings } from '../types';

export type LogLevel = 'none' | 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
	none: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

const PREFIX = '[claude-sessions]';

export class Logger {
	private static settings: PluginSettings | null = null;

	static init(settings: PluginSettings): void {
		Logger.settings = settings;
	}

	private static shouldLog(level: LogLevel): boolean {
		if (!Logger.settings) return false;
		return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[Logger.settings.debugLevel];
	}

	static debug(message: string, data?: unknown): void {
		if (!Logger.shouldLog('debug')) return;
		if (data !== undefined) console.log(`${PREFIX} ${message}`, data);
		else console.log(`${PREFIX} ${message}`);
	}

	static info(message: string, data?: unknown): void {
		if (!Logger.shouldLog('info')) return;
		if (data !== undefined) console.info(`${PREFIX} ${message}`, data);
		else console.info(`${PREFIX} ${message}`);
	}

	static warn(message: string, data?: unknown): void {
		if (!Logger.shouldLog('warn')) return;
		if (data !== undefined) console.warn(`${PREFIX} ${message}`, data);
		else console.warn(`${PREFIX} ${message}`);
	}

	static error(message: string, data?: unknown): void {
		if (!Logger.shouldLog('error')) return;
		if (data !== undefined) console.error(`${PREFIX} ${message}`, data);
		else console.error(`${PREFIX} ${message}`);
	}
}
