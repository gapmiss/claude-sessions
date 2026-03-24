/** Minimal mock of the obsidian module for parser tests. */

export const Platform = {
	isDesktop: true,
	isDesktopApp: true,
	isMobile: false,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
};

export function normalizePath(path: string): string {
	return path;
}

export function setIcon(): void {}

export class Notice {
	constructor(_message: string) {}
}
