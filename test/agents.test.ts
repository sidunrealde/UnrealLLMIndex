import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { mergeAgentsFile, renderAgentFile, renderAgentsSection, SECTION_END, SECTION_START } from '../src/agentInstructions';
import { ProjectIndex } from '../src/indexer';

const index = new ProjectIndex(path.join(__dirname, 'fixtures/SampleGame'));
index.refresh(true);
const section = renderAgentsSection(index);

describe('renderAgentsSection', () => {
    it('is wrapped in markers and uses real paths and symbols from the project', () => {
        expect(section.startsWith(SECTION_START)).toBe(true);
        expect(section.endsWith(SECTION_END)).toBe(true);
        expect(section).toContain('`.llm-index/INDEX.md`');
        expect(section).toContain('`.llm-index/files/SampleGame/Public/SampleCharacter.h.md`');
        expect(section).toContain('`ASampleCharacter::');
    });
});

describe('mergeAgentsFile', () => {
    it('creates a new file', () => {
        expect(mergeAgentsFile(undefined, section)).toBe(`# AGENTS.md\n\n${section}\n`);
    });

    it('appends to an existing file without touching its content', () => {
        const existing = '# Project rules\n\nUse tabs.\n';
        const merged = mergeAgentsFile(existing, section);
        expect(merged.startsWith('# Project rules\n\nUse tabs.\n\n<!-- unreal-llm-index:start -->')).toBe(true);
        expect(merged.endsWith(`${SECTION_END}\n`)).toBe(true);
    });

    it('replaces only its own section and is idempotent', () => {
        const existing = `# Rules\n\n${SECTION_START}\nold text\n${SECTION_END}\n\n## More rules\n`;
        const merged = mergeAgentsFile(existing, section);
        expect(merged).toBe(`# Rules\n\n${section}\n\n## More rules\n`);
        expect(mergeAgentsFile(merged, section)).toBe(merged);
    });

    it('keeps Windows line endings', () => {
        const merged = mergeAgentsFile('# Rules\r\n\r\nUse tabs.\r\n', section);
        expect(merged.replace(/\r\n/g, '')).not.toContain('\n');
    });
});

describe('renderAgentFile', () => {
    it('matches the agent bundled with the extension', () => {
        // Git may check the file out with CRLF line endings
        expect(fs.readFileSync(path.join(__dirname, '../agents/unreal.agent.md'), 'utf8').replace(/\r\n/g, '\n')).toBe(renderAgentFile());
    });

    it('lists the tools of every MCP server label', () => {
        expect(renderAgentFile(['Unreal LLM Index', 'Unreal LLM Index Other Game'])).toContain(
            "tools: ['unreal-llm-index/*', 'unreal-llm-index-other-game/*', 'read', 'search', 'edit', 'execute', 'todo']",
        );
    });
});
