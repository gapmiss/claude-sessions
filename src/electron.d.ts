/** Minimal Electron type declarations for the subset used by this plugin. */
declare module 'electron' {
	interface SaveDialogOptions {
		title?: string;
		defaultPath?: string;
		filters?: { name: string; extensions: string[] }[];
	}
	interface SaveDialogReturnValue {
		canceled: boolean;
		filePath?: string;
	}
	interface Dialog {
		showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>;
	}
	const remote: { dialog: Dialog } | undefined;
}
