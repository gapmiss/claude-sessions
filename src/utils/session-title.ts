/** Fields that can name a session, from parsed metadata or the session index. */
export interface TitledSession {
	customTitle?: string;
	aiTitle?: string;
	project: string;
}

/**
 * Display name for a session: the /rename title, then the title Claude Code
 * generated (ai-title record), then the project name.
 *
 * Claude Code stopped writing ai-title after 2.1.312, so newer sessions fall
 * back to the project. The first user prompt is deliberately not used: it is
 * often boilerplate and makes a worse name than the project. See "Generated
 * session titles" in COMPATIBILITY.md before adding another source.
 */
export function sessionDisplayName(s: TitledSession): string {
	return s.customTitle || s.aiTitle || s.project;
}
