import { describe, it, expect } from 'vitest';
import { parseTaskNotification } from '../src/parsers/claude-subagent';

describe('parseTaskNotification', () => {
	it('extracts all fields from task notification XML', () => {
		const xml = `<task-notification>
			<tool-use-id>tu_abc123</tool-use-id>
			<task-id>task-456</task-id>
			<result>The analysis is complete.</result>
			<summary>Analyzed 5 files</summary>
		</task-notification>`;

		const result = parseTaskNotification(xml);
		expect(result).not.toBeNull();
		expect(result!.toolUseId).toBe('tu_abc123');
		expect(result!.taskId).toBe('task-456');
		expect(result!.result).toBe('The analysis is complete.');
		expect(result!.summary).toBe('Analyzed 5 files');
	});

	it('returns null when tool-use-id is missing', () => {
		const xml = `<task-notification>
			<task-id>task-456</task-id>
			<result>done</result>
		</task-notification>`;

		expect(parseTaskNotification(xml)).toBeNull();
	});

	it('handles missing optional fields with empty strings', () => {
		const xml = `<task-notification>
			<tool-use-id>tu_1</tool-use-id>
		</task-notification>`;

		const result = parseTaskNotification(xml);
		expect(result).not.toBeNull();
		expect(result!.toolUseId).toBe('tu_1');
		expect(result!.taskId).toBe('');
		expect(result!.result).toBe('');
		expect(result!.summary).toBe('');
	});

	it('trims whitespace from extracted values', () => {
		const xml = `<task-notification>
			<tool-use-id>  tu_spaced  </tool-use-id>
			<task-id>  task-spaced  </task-id>
		</task-notification>`;

		const result = parseTaskNotification(xml);
		expect(result!.toolUseId).toBe('tu_spaced');
		expect(result!.taskId).toBe('task-spaced');
	});
});
