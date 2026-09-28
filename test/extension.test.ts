import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { version } from '../package.json';
import { SECTION_START } from '../src/agentInstructions';
import { canonicalRoot } from '../src/engine/paths';
import { syncEngineIndex } from '../src/engine/sync';
import { activate, AGENT_FILE } from '../src/extension';
import { copyFixture } from './fixtures';
import { mock, Uri } from './vscode-mock';

const FIXTURE = path.join(__dirname, 'fixtures/SampleGame');
const FAKE_ENGINE = canonicalRoot(path.join(__dirname, 'fixtures/FakeEngine/UE_9.9'));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

function fakeContext() {
    return {
        subscriptions: [] as { dispose(): void }[],
        asAbsolutePath: (rel: string) => path.join(EXTENSION_ROOT, rel),
    } as any;
}

describe('extension', () => {
    let dir: string;
    let cacheDir: string;
    let context: ReturnType<typeof fakeContext>;
    const indexMd = () => fs.readFileSync(path.join(dir, '.llm-index/INDEX.md'), 'utf8');

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        mock.reset();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-index-ext-'));
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-index-ext-cache-'));
        copyFixture(FIXTURE, dir);
        mock.uprojects = [path.join(dir, 'SampleGame.uproject')];
        mock.workspaceFolders = [dir];
        mock.settings['unrealLlmIndex.enginePath'] = FAKE_ENGINE;
        mock.settings['unrealLlmIndex.cacheDir'] = cacheDir;
        // Tests build the engine index in-process instead of spawning the CLI
        mock.settings['unrealLlmIndex.engine.autoSync'] = 'manual';
        context = fakeContext();
        activate(context);
        await vi.waitFor(() => expect(fs.existsSync(path.join(dir, '.llm-index/INDEX.md'))).toBe(true));
    });

    afterEach(() => {
        context.subscriptions.forEach((d: { dispose(): void }) => d.dispose());
        vi.useRealTimers();
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    it('builds .llm-index/ on activation and shows the status bar item', () => {
        expect(fs.existsSync(path.join(dir, '.llm-index/files/SampleGame/Public/SampleCharacter.h.md'))).toBe(true);
        expect(mock.statusText).toBe('$(book) LLM Index');
        expect(mock.contextKeys).toEqual({ 'unrealLlmIndex.hasProject': true, 'unrealLlmIndex.hasWorkspaceAgent': false });
    });

    it('registers an MCP server that runs the bundled CLI on VS Code\'s Node with the project\'s engine', async () => {
        const provider = mock.mcpProviders.get('unrealLlmIndex');
        const [server] = await provider.provideMcpServerDefinitions();
        expect(server.label).toBe('Unreal LLM Index');
        expect(server.command).toBe(process.execPath);
        expect(server.args.slice(0, 8)).toEqual([path.join(EXTENSION_ROOT, 'dist', 'cli.js'), 'serve', dir, '--no-write', '--cache-dir', cacheDir, '--engine', FAKE_ENGINE]);
        expect(server.args.slice(8, 10)).toEqual(['--memory-dir', path.join(dir, '.llm-memory')]);
        expect(server.args.slice(-4)).toEqual(['--max-result-tokens', '8000', '--max-read-lines', '400']);
        expect(server.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
        expect(server.version).toBe(`${version}+9.9.1-12345`);
    });

    it('provides no servers when registration is turned off', async () => {
        mock.settings['unrealLlmIndex.registerMcpServer'] = false;
        expect(await mock.mcpProviders.get('unrealLlmIndex').provideMcpServerDefinitions()).toEqual([]);
    });

    it('describes the engine in INDEX.md, before and after the engine index is built', async () => {
        expect(indexMd()).toMatch(/## Engine\n- Unreal Engine 9\.9\.1 at .*\n- .*has not been indexed yet/);
        await syncEngineIndex({ engineRoot: FAKE_ENGINE, cacheDir, jobs: 1 });
        await mock.commands.get('unrealLlmIndex.rebuild')!();
        expect(indexMd()).toContain('15 source files and');
        expect(indexMd()).toContain('- Engine plugins the .uproject enables: EnhancedInput');
    });

    it('rebuilds after source changes, ignoring Intermediate', () => {
        const header = path.join(dir, 'Source/SampleGame/Public/Utils.h');
        fs.writeFileSync(header, fs.readFileSync(header, 'utf8').replace('FString Describe(int32 Value);', 'FString Describe(int32 Value);\n\tint32 Twice(int32 Value);'));
        const watcher = mock.watchers.find(w => w.pattern.pattern.includes('Source'))!;

        watcher.change.fire(Uri.file(path.join(dir, 'Plugins/Telemetry/Intermediate/Build/Utils.generated.h')));
        vi.runAllTimers();
        const outline = path.join(dir, '.llm-index/files/SampleGame/Public/Utils.h.md');
        expect(fs.readFileSync(outline, 'utf8')).not.toContain('Twice');

        watcher.change.fire(Uri.file(header));
        vi.runAllTimers();
        expect(fs.readFileSync(outline, 'utf8')).toContain('int32 Twice(int32 Value);');
    });

    it('writes AGENTS.md only when the command runs, and only its own section', async () => {
        const agentsFile = path.join(dir, 'AGENTS.md');
        expect(fs.existsSync(agentsFile)).toBe(false);
        fs.writeFileSync(agentsFile, '# Team rules\n\nUse tabs.\n');

        await mock.commands.get('unrealLlmIndex.addAgentsInstructions')!();
        const content = fs.readFileSync(agentsFile, 'utf8');
        expect(content.startsWith('# Team rules\n\nUse tabs.\n')).toBe(true);
        expect(content).toContain(SECTION_START);

        await mock.commands.get('unrealLlmIndex.addAgentsInstructions')!();
        expect(fs.readFileSync(agentsFile, 'utf8')).toBe(content);
        expect(mock.messages.at(-1)).toContain('already has');
    });

    it('copies the Unreal agent into the workspace, which hides the bundled one', async () => {
        await mock.commands.get('unrealLlmIndex.copyUnrealAgent')!();
        const agent = fs.readFileSync(path.join(dir, AGENT_FILE), 'utf8');
        expect(agent).toContain("tools: ['unreal-llm-index/*', 'read', 'search', 'edit', 'execute', 'todo']");
        expect(mock.contextKeys['unrealLlmIndex.hasWorkspaceAgent']).toBe(true);
        expect(mock.openedDocuments).toEqual([path.join(dir, AGENT_FILE)]);
    });

    it('keeps INDEX.md\'s project memory current when notes are added or edited', () => {
        expect(indexMd()).toContain('## Project memory\nNo notes yet.');
        const notes = path.join(dir, '.llm-memory');
        fs.mkdirSync(notes);
        fs.writeFileSync(path.join(notes, 'stairs.md'), '---\nkind: task\n---\nFinish the stair generator.\n');
        const watcher = mock.watchers.find(w => w.pattern.pattern === '.llm-memory/*.md')!;
        watcher.create.fire(Uri.file(path.join(notes, 'stairs.md')));
        vi.runAllTimers();
        expect(indexMd()).toMatch(/Open tasks \(1\):\n- \[stairs\] task \(open\), .*: Finish the stair generator\./);
    });

    it('registers the @unreal chat participant', () => {
        expect(mock.participants.has('unrealLlmIndex.unreal')).toBe(true);
    });

    it('opens INDEX.md from the status bar command', async () => {
        await mock.commands.get('unrealLlmIndex.openIndex')!();
        expect(mock.openedDocuments).toEqual([path.join(dir, '.llm-index', 'INDEX.md')]);
    });
});

describe('extension with engine lookups and memory turned off', () => {
    it('serves the project only', async () => {
        mock.reset();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-index-ext-'));
        copyFixture(FIXTURE, dir);
        mock.uprojects = [path.join(dir, 'SampleGame.uproject')];
        mock.settings['unrealLlmIndex.engine.enabled'] = false;
        mock.settings['unrealLlmIndex.memory.enabled'] = false;
        const context = fakeContext();
        try {
            activate(context);
            await vi.waitFor(() => expect(fs.existsSync(path.join(dir, '.llm-index/INDEX.md'))).toBe(true));
            const [server] = await mock.mcpProviders.get('unrealLlmIndex').provideMcpServerDefinitions();
            expect(server.args).toContain('--no-engine');
            expect(server.args).toContain('--no-memory');
            const indexMd = fs.readFileSync(path.join(dir, '.llm-index/INDEX.md'), 'utf8');
            expect(indexMd).toContain('Engine lookups are turned off');
            expect(indexMd).not.toContain('## Project memory');
        } finally {
            context.subscriptions.forEach((d: { dispose(): void }) => d.dispose());
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
