import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectIndex } from '../src/indexer';
import { capOutput, createServer } from '../src/server';

const FIXTURE = path.join(__dirname, 'fixtures/SampleGame');

describe('capOutput', () => {
    it('leaves short text alone and cuts long text at a line boundary with a hint', () => {
        expect(capOutput('short', 'hint')).toBe('short');
        const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
        const capped = capOutput(long, 'Narrow it.', 100);
        expect(capped.length).toBeLessThan(160);
        expect(capped).toMatch(/\n… \[truncated: \d+ more lines\. Narrow it\.\]$/);
    });
});

describe('MCP tools', () => {
    const client = new Client({ name: 'test', version: '0' });

    beforeAll(async () => {
        const index = new ProjectIndex(FIXTURE);
        index.refresh(true);
        const server = createServer(index, { version: 'test', writeFiles: false });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    });

    afterAll(async () => {
        await client.close();
    });

    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        return { text: (result.content as { text: string }[]).map(c => c.text).join('\n'), isError: !!result.isError };
    };

    it('lists the seven tools', async () => {
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name).sort()).toEqual(
            ['find_symbol', 'get_file_outline', 'get_index', 'get_module_outline', 'read_lines', 'read_symbol', 'search_code'].sort(),
        );
    });

    it('read_symbol returns the declaration first, then the implementation', async () => {
        const { text } = await call('read_symbol', { name: 'ASampleCharacter::ApplyDamage' });
        const header = text.indexOf('// SampleCharacter.h:');
        const source = text.indexOf('// SampleCharacter.cpp:');
        expect(header).toBeGreaterThanOrEqual(0);
        expect(source).toBeGreaterThan(header);
        expect(text).toContain('InStats.Health -= Clamp01(Amount);');
    });

    it('read_symbol lists each candidate once for ambiguous names', async () => {
        const { text } = await call('read_symbol', { name: 'Interact' });
        expect(text).toContain('is ambiguous');
        expect(text.match(/ASampleCharacter::Interact/g)).toHaveLength(1);
        expect(text).toContain('ISampleInteractable::Interact');
    });

    it('read_lines caps the range and rejects paths outside the project', async () => {
        const { text } = await call('read_lines', { path: 'SampleCharacter.cpp', start: 1, end: 3 });
        expect(text.split('\n')).toHaveLength(4);
        const outside = await call('read_lines', { path: '../../package.json', start: 1 });
        expect(outside.isError).toBe(true);
    });

    it('search_code escapes invalid regexes and honors path_filter', async () => {
        // "Clamp01(" is not a valid regex, so it is searched as plain text
        const { text } = await call('search_code', { pattern: 'Clamp01(' });
        expect(text).toContain('SampleCharacter.cpp:');
        const filtered = await call('search_code', { pattern: 'FString', path_filter: 'Telemetry' });
        expect(filtered.text.split('\n').every(l => l.startsWith('Telemetry/') || l.startsWith('Utils.cpp'))).toBe(true);
    });

    it('get_module_outline reports unknown modules with the valid names', async () => {
        const { text, isError } = await call('get_module_outline', { module: 'Nope' });
        expect(isError).toBe(true);
        expect(text).toContain('SampleGame, Telemetry');
    });

    it('get_index starts with the project heading', async () => {
        const { text } = await call('get_index');
        expect(text.startsWith('# LLM index: SampleGame')).toBe(true);
    });
});
