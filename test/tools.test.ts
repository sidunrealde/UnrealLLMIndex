import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineProvider } from '../src/engineContext';
import { locateEngine, EngineInstall } from '../src/engine/locate';
import { syncEngineIndex } from '../src/engine/sync';
import { ProjectIndex } from '../src/indexer';
import { MemoryStore } from '../src/memory';
import { createServer } from '../src/server';
import { capOutput, limitsFor, runTool, toolJsonSchema, TOOLS } from '../src/tools';

const FIXTURE = path.join(__dirname, 'fixtures/SampleGame');
const FAKE_ENGINE = path.join(__dirname, 'fixtures/FakeEngine/UE_9.9');

describe('capOutput', () => {
    it('leaves short text alone and cuts long text at a line boundary with a hint', () => {
        expect(capOutput('short', 'hint', 100)).toBe('short');
        const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
        const capped = capOutput(long, 'Narrow it.', 100);
        expect(capped.length).toBeLessThan(160);
        expect(capped).toMatch(/\n… \[truncated: \d+ more lines\. Narrow it\.\]$/);
    });
});

async function connect(index: ProjectIndex, engine: EngineProvider | undefined, limits = limitsFor(), memory?: MemoryStore) {
    const client = new Client({ name: 'test', version: '0' });
    const server = createServer(index, { version: 'test', writeFiles: false, engine, limits, memory });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        return { text: (result.content as { text: string }[]).map(c => c.text).join('\n'), isError: !!result.isError };
    };
    return { client, call };
}

describe('MCP tools', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-index-tools-'));
    const index = new ProjectIndex(FIXTURE);
    let install: EngineInstall;
    let engine: EngineProvider;
    let session: Awaited<ReturnType<typeof connect>>;
    const call = (name: string, args: Record<string, unknown> = {}) => session.call(name, args);

    beforeAll(async () => {
        index.refresh(true);
        install = locateEngine('', FIXTURE, { override: FAKE_ENGINE }) as EngineInstall;
        await syncEngineIndex({ engineRoot: install.root, cacheDir, jobs: 1 });
        engine = new EngineProvider({ project: index, cacheDir, install });
        session = await connect(index, engine);
    });

    afterAll(async () => {
        await session.client.close();
        engine.dispose();
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    it('lists the tools; lookups are read-only so VS Code runs them without asking, memory writes ask', async () => {
        const { tools } = await session.client.listTools();
        const lookups = ['find_symbol', 'get_file_outline', 'get_index', 'get_module_outline', 'list_plugins', 'read_lines', 'read_symbol', 'recall', 'search_code'];
        expect(tools.map(t => t.name).sort()).toEqual([...lookups, 'forget', 'remember', 'update_note'].sort());
        for (const tool of tools) {
            const readOnly = lookups.includes(tool.name);
            expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: readOnly, openWorldHint: false });
            if (!readOnly) {
                expect(tool.annotations?.destructiveHint, tool.name).toBe(tool.name === 'forget');
            }
        }
    });

    it('get_index starts with the project heading and describes the engine', async () => {
        const { text } = await call('get_index');
        expect(text.startsWith('# LLM index: SampleGame')).toBe(true);
        expect(text).toContain('## Engine');
        expect(text).toContain('Unreal Engine 9.9.1 at');
        expect(text).toContain('- Engine plugins the .uproject enables: EnhancedInput');
        expect(text).toContain('- Marketplace/Fab plugins installed in the engine: Fabby');
        expect(text).toContain("- Engine modules the project's Build.cs files use: Core, CoreUObject, Engine");
    });

    it('read_symbol returns the declaration first, then the implementation', async () => {
        const { text } = await call('read_symbol', { name: 'ASampleCharacter::ApplyDamage' });
        const header = text.indexOf('// SampleCharacter.h:');
        const source = text.indexOf('// SampleCharacter.cpp:');
        expect(header).toBeGreaterThanOrEqual(0);
        expect(source).toBeGreaterThan(header);
        expect(text).toContain('InStats.Health -= Clamp01(Amount);');
    });

    it('read_symbol falls back to the engine, with full engine paths', async () => {
        const { text } = await call('read_symbol', { name: 'ACharacter::Jump' });
        expect(text).toContain('// Engine/Source/Runtime/Engine/Classes/GameFramework/Character.h:');
        expect(text).toContain('// Engine/Source/Runtime/Engine/Private/Character.cpp:7-11');
        expect(text).toContain('bPressedJump = true;');
        const projectOnly = await call('read_symbol', { name: 'ACharacter::Jump', scope: 'project' });
        expect(projectOnly.text).toMatch(/^No symbol named/);
    });

    it('read_symbol lists each candidate once for ambiguous names', async () => {
        const { text } = await call('read_symbol', { name: 'Interact' });
        expect(text).toContain('is ambiguous');
        expect(text.match(/ASampleCharacter::Interact/g)).toHaveLength(1);
        expect(text).toContain('ISampleInteractable::Interact');
    });

    it('find_symbol merges project and engine results by how well they match', async () => {
        const { text } = await call('find_symbol', { query: 'ACharacter', limit: 3 });
        expect(text.split('\n')[0]).toMatch(/^class ACharacter — Engine\/Source\/Runtime\/Engine\/Classes\/GameFramework\/Character\.h:\d+/);
        const project = await call('find_symbol', { query: 'ApplyDamage' });
        expect(project.text.split('\n')[0]).toContain('function ASampleCharacter::ApplyDamage — SampleCharacter.h:');
        const jumps = await call('find_symbol', { query: 'Jump', kind: 'function', scope: 'engine', limit: 4 });
        expect(jumps.text.split('\n').map(l => l.split(' — ')[0])).toEqual([
            'function ACharacter::Jump',
            'function ACharacter::Jump',
            'function FHiddenJump::Jump',
            'function FUnusedJump::Jump',
        ]);
    });

    it('get_file_outline and read_lines work on engine files', async () => {
        const outline = await call('get_file_outline', { path: 'GameFramework/Character.h', type: 'ACharacter' });
        expect(outline.text).toMatch(/virtual void Jump\(\);\s+→ Engine\/Source\/Runtime\/Engine\/Private\/Character\.cpp:7-11/);
        expect(outline.text).not.toMatch(/^L\d+ function ACharacter$/m);
        const ini = await call('read_lines', { path: 'Engine/Config/BaseEngine.ini', start: 1 });
        expect(ini.text).toContain('bSmoothFrameRate=false');
        const ambiguous = await call('get_file_outline', { path: 'Actor.h' });
        expect(ambiguous).toMatchObject({ isError: true, text: expect.stringContaining('several engine files') });
    });

    it('read_lines caps the range and rejects paths outside the project and engine', async () => {
        const { text } = await call('read_lines', { path: 'SampleCharacter.cpp', start: 1, end: 3 });
        expect(text.split('\n')).toHaveLength(4);
        const outside = await call('read_lines', { path: '../../package.json', start: 1 });
        expect(outside.isError).toBe(true);
    });

    it('search_code escapes invalid regexes and honors path_filter', async () => {
        // "Clamp01(" is not a valid regex, so it is searched as plain text
        const { text } = await call('search_code', { pattern: 'Clamp01(' });
        expect(text).toContain('SampleCharacter.cpp:');
        expect(text).not.toContain('Engine/');
        const filtered = await call('search_code', { pattern: 'FString', path_filter: 'Telemetry' });
        expect(filtered.text.split('\n').every(l => l.startsWith('Telemetry/') || l.startsWith('Utils.cpp'))).toBe(true);
    });

    it('search_code searches the engine code the project uses, or a named module or plugin', async () => {
        const engineHits = await call('search_code', { pattern: 'bPressedJump = true', scope: 'engine' });
        expect(engineHits.text).toContain('Engine/Source/Runtime/Engine/Private/Character.cpp:9: bPressedJump = true;');
        expect(engineHits.text).toContain('Engine: searched the 3 engine modules the project depends on');
        // Unused is not enabled, so it is only searched when named
        expect((await call('search_code', { pattern: 'FUnusedJump', scope: 'engine' })).text).toMatch(/^No matches/);
        const named = await call('search_code', { pattern: 'FUnusedJump', scope: 'engine', path_filter: 'Unused' });
        expect(named.text).toContain('UnusedJump.h:3: struct FUnusedJump');
        expect(named.text).toContain('module Unused');
    });

    it('get_module_outline covers engine modules and plugins, and reports unknown names', async () => {
        expect((await call('get_module_outline', { module: 'Engine' })).text).toContain('ACharacter (UCLASS : AActor) L');
        expect((await call('get_module_outline', { module: 'PluginBrowser' })).text).toContain('- PluginBrowser [engine, enabled by default]');
        const { text, isError } = await call('get_module_outline', { module: 'Nope' });
        expect(isError).toBe(true);
        expect(text).toContain('SampleGame, Telemetry');
    });

    it('list_plugins shows enabled and Marketplace plugins with the reason, or all of them', async () => {
        const { text } = await call('list_plugins');
        expect(text).toContain('- Telemetry [project, project plugin]');
        expect(text).toContain('- EnhancedInput ("Enhanced Input") [engine, enabled in .uproject]');
        expect(text).toContain('- Fabby ("Fabby Widgets") [marketplace, not enabled]');
        expect(text).toContain('- Hidden [engine, enabled as a dependency of DefaultOn]');
        expect(text).not.toContain('Unused');
        expect((await call('list_plugins', { include_disabled: true, query: 'nobody' })).text).toContain('- Unused [engine, not enabled]');
    });

    it('returns large classes as an outline when they do not fit in one read', async () => {
        const small = await connect(index, engine, { maxChars: 10_000, maxReadLines: 5 });
        try {
            const { text } = await small.call('read_symbol', { name: 'AActor' });
            expect(text).toMatch(/^AActor spans \d+ lines .* so here is its outline/);
            expect(text).toContain('virtual void BeginPlay();');
        } finally {
            await small.client.close();
        }
    });
});

describe('project memory over MCP', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-index-memtools-'));
    const memoryDir = path.join(cacheDir, '.llm-memory');
    const index = new ProjectIndex(FIXTURE);
    let engine: EngineProvider;
    let session: Awaited<ReturnType<typeof connect>>;
    const call = (name: string, args: Record<string, unknown> = {}) => session.call(name, args);

    beforeAll(async () => {
        index.refresh(true);
        const install = locateEngine('', FIXTURE, { override: FAKE_ENGINE }) as EngineInstall;
        await syncEngineIndex({ engineRoot: install.root, cacheDir, jobs: 1 });
        engine = new EngineProvider({ project: index, cacheDir, install });
        session = await connect(index, engine, limitsFor(), new MemoryStore(memoryDir));
    });

    afterAll(async () => {
        await session.client.close();
        engine.dispose();
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    it('saves notes and shows them in the index and next to the code they are about', async () => {
        expect((await call('get_index')).text).toContain('## Project memory\nNo notes yet.');
        const decision = await call('remember', { text: 'Damage always goes through ApplyDamage so the health delegate fires.', kind: 'decision', about: ['ApplyDamage'] });
        expect(decision.text).toMatch(/^Saved decision \[(\w{6})\] to \.llm-memory\/.*, about ASampleCharacter::ApplyDamage\.$/);
        const id = /\[(\w{6})\]/.exec(decision.text)![1];
        await call('remember', { text: 'Wire up the interaction prompt UI.', kind: 'task', about: ['ASampleCharacter'] });
        await call('remember', { text: 'Jump only sets a flag; CharacterMovement does the work.', about: ['ACharacter::Jump'] });

        const indexText = (await call('get_index')).text;
        expect(indexText).toMatch(/## Project memory\n3 notes in \.llm-memory\//);
        expect(indexText).toMatch(/Open tasks \(1\):\n- \[\w{6}\] task \(open\), .*: Wire up the interaction prompt UI\. — about ASampleCharacter/);

        const read = (await call('read_symbol', { name: 'ASampleCharacter::ApplyDamage' })).text;
        expect(read).toContain('Project memory notes about this code:\n');
        expect(read).toContain(`\n- [${id}] decision, `);
        expect(read).toContain('Damage always goes through ApplyDamage');
        expect(read).toContain('Wire up the interaction prompt UI.');
        expect((await call('read_symbol', { name: 'ACharacter::Jump' })).text).toContain('Jump only sets a flag');
        expect((await call('get_file_outline', { path: 'SampleCharacter.h' })).text).toContain('Project memory notes about this code:');
        expect((await call('find_symbol', { query: 'ApplyDamage', limit: 1 })).text).toMatch(/ASampleCharacter::ApplyDamage — .* \[1 note\]$/);
    });

    it('recalls, updates and forgets notes', async () => {
        const tasks = (await call('recall', { kind: 'task' })).text;
        expect(tasks).toMatch(/^1 note:\n- \[\w{6}\] task \(open\)/);
        const id = /\[(\w{6})\]/.exec(tasks)![1];
        expect((await call('update_note', { id, status: 'done' })).text).toMatch(/^Updated task \(done\) \[\w{6}\]: Wire up the interaction prompt UI\.$/);
        expect((await call('recall', { kind: 'task' })).text).toMatch(/^No notes match/);
        expect((await call('recall', { kind: 'task', include_done: true })).text).toContain('task (done)');
        expect((await call('recall', { query: 'health delegate' })).text).toContain('Damage always goes through ApplyDamage');
        expect((await call('recall', { about: 'ACharacter' })).text).toContain('Jump only sets a flag');

        expect((await call('forget', { id })).text).toMatch(/^Deleted task \[\w{6}\]/);
        expect(await call('forget', { id })).toMatchObject({ isError: true, text: expect.stringContaining('No note with id') });
        expect(fs.readdirSync(memoryDir).filter(f => f !== 'README.md')).toHaveLength(2);
    });
});

describe('tools without an engine index', () => {
    const index = new ProjectIndex(FIXTURE);
    index.refresh(true);
    const emptyCache = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-index-empty-'));
    const install = locateEngine('', FIXTURE, { override: FAKE_ENGINE }) as EngineInstall;
    const ctx = { project: index, engine: new EngineProvider({ project: index, cacheDir: emptyCache, install }), limits: limitsFor() };

    afterAll(() => fs.rmSync(emptyCache, { recursive: true, force: true }));

    it('explains that the engine is not indexed yet and still answers from the project', async () => {
        const engineOnly = await runTool('find_symbol', { query: 'ACharacter', scope: 'engine' }, ctx);
        expect(engineOnly.text).toMatch(/Unreal Engine 9\.9\.1 .* has not been indexed yet/);
        const all = await runTool('find_symbol', { query: 'ApplyDamage' }, ctx);
        expect(all.text).toContain('ASampleCharacter::ApplyDamage');
        expect(all.text).toContain('(Engine not searched: ');
        expect((await runTool('get_index', {}, ctx)).text).toContain('has not been indexed yet');
    });

    it('validates arguments and describes inputs as plain JSON Schema', async () => {
        expect(await runTool('find_symbol', {}, ctx)).toMatchObject({ isError: true, text: expect.stringContaining('Invalid arguments for find_symbol') });
        expect(await runTool('nope', {}, ctx)).toMatchObject({ isError: true });
        const schema = toolJsonSchema(TOOLS.find(t => t.name === 'read_lines')!) as any;
        expect(schema.$schema).toBeUndefined();
        expect(schema.required).toEqual(['path', 'start']);
        expect(schema.properties.start).toEqual({ type: 'integer', minimum: 1, description: 'First line (1-based)' });
    });
});
