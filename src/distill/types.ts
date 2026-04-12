/**
 * Types for session distillation — converting parsed sessions into
 * structured Obsidian notes with queryable frontmatter.
 */

/**
 * Controlled vocabulary for session classification.
 * Multi-select — a session can have multiple types.
 */
export type SessionType =
	| 'bug-fix'
	| 'feature'
	| 'refactor'
	| 'exploration'
	| 'discussion'
	| 'config'
	| 'docs'
	| 'test'
	| 'review'
	| 'deploy';

/**
 * Frontmatter schema for distilled session notes.
 * Fields marked optional may be absent in Layer 0 extraction
 * (e.g., session_type requires LLM classification).
 */
export interface DistilledFrontmatter {
	// Identity
	tags: string[];
	session_id: string;
	schema_version: number;

	// Project context
	project: string;
	cwd: string;
	branch?: string;
	model?: string;

	// Timing
	start_time?: string;
	duration_min?: number;

	// Cost & tokens
	cost_usd?: number;
	input_tokens?: number;
	output_tokens?: number;
	cache_read_tokens?: number;

	// Interaction shape
	user_turns?: number;
	assistant_turns?: number;
	tools_used?: string[];
	files_touched?: string[];

	// Errors (count only — details in session timeline)
	error_count?: number;

	// Classification (LLM-only — populated by /distill skill, absent in Layer 0)
	session_type?: SessionType[];

	// Source reference
	source_path?: string;
	obsidian_uri?: string;
}

/**
 * Options for the distill pipeline.
 */
export interface DistillOptions {
	/** Overwrite existing note even if session_id matches. */
	force?: boolean;
	/** Skip writing and return the note content. */
	dryRun?: boolean;
}

/** Current schema version for migration support. */
export const DISTILL_SCHEMA_VERSION = 1;
