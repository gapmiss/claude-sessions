import { describe, it, expect } from 'vitest';
import { parseTaskNotification, parsePeerMessage, stripHandbackFrame } from '../src/parsers/claude-subagent';

describe('stripHandbackFrame', () => {
	it('drops the frame line and the per-line indent', () => {
		const body = '[Subagent hand-back] Frame text. The report follows:\n  First.\n  \n  - item\n    nested';
		expect(stripHandbackFrame(body)).toBe('First.\n\n- item\n  nested');
	});

	it('leaves a body without the frame alone apart from trimming', () => {
		expect(stripHandbackFrame('plain\ntext\n')).toBe('plain\ntext');
	});
});

describe('parsePeerMessage', () => {
	it('returns null for user and task-notification origins', () => {
		expect(parsePeerMessage({ origin: { kind: 'human' }, prompt: 'hi' })).toBeNull();
		expect(parsePeerMessage({ origin: { kind: 'task-notification' } })).toBeNull();
		expect(parsePeerMessage({ prompt: 'hi' })).toBeNull();
	});

	it('reads a hand-back', () => {
		expect(parsePeerMessage({
			origin: { kind: 'peer', from: 'a1', name: 'general-purpose', body: '[Subagent hand-back] x\n  ok', handback: true },
		})).toEqual({ agentId: 'a1', name: 'general-purpose', text: 'ok', handback: true });
	});
});

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
