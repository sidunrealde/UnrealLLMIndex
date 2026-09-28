import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineIndex } from '../src/engine/engineIndex';
import { engineCachePaths } from '../src/engine/paths';
import { EngineBusyError, readEngineVersionAt, staleReason, syncEngineIndex, SyncProgress } from '../src/engine/sync';
import { qualifiedName } from '../src/indexer';
import { renderFileOutline, renderModuleSummary } from '../src/outline';
import { scanEngine } from '../src/scan';

const FAKE_ENGINE = path.join(__dirname, 'fixtures/FakeEngine/UE_9.9');
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function copyEngine(): string {
    const dir = path.join(tempDir('ue-llm-index-engine-'), 'UE_9.9');
    fs.cpSync(FAKE_ENGINE, dir, { recursive: true });
    return dir;
}

afterAll(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('scanEngine', () => {
    const scan = scanEngine(FAKE_ENGINE);

    it('finds engine modules, plugins and platform extensions', () => {
        expect(scan.modules.map(m => m.name).sort()).toEqual(
            ['Core', 'CoreUObject', 'DefaultOn', 'Engine', 'EnhancedInput', 'Fabby', 'Hidden', 'InputCore', 'Unused', 'WinThing'].sort(),
        );
        const categories = Object.fromEntries(scan.plugins.map(p => [p.name, p.category]));
        expect(categories).toMatchObject({ EnhancedInput: 'engine', Fabby: 'marketplace', PluginBrowser: 'engine' });
        expect(scan.plugins.find(p => p.name === 'Fabby')).toMatchObject({ installed: true, enabledByDefault: false, friendlyName: 'Fabby Widgets' });
        expect(scan.plugins.find(p => p.name === 'DefaultOn')?.pluginDeps).toEqual([{ name: 'Hidden', enabled: true }]);
        expect(scan.modules.find(m => m.name === 'EnhancedInput')).toMatchObject({ plugin: 'EnhancedInput', loadingPhase: 'PreDefault' });
    });

    it('skips ThirdParty, Intermediate and plugin templates', () => {
        const files = [...scan.modules.flatMap(m => m.files), ...scan.looseFiles];
        expect(files.some(f => /ThirdParty|Intermediate|PLUGIN_NAME/.test(f))).toBe(false);
        expect(files).toContain('Engine/Source/Runtime/Engine/Private/Character.cpp');
    });
});

describe('engine index', () => {
    const cacheDir = tempDir('ue-llm-index-cache-');
    let index: EngineIndex;
    const progress: SyncProgress[] = [];

    beforeAll(async () => {
        const result = await syncEngineIndex({ engineRoot: FAKE_ENGINE, cacheDir, jobs: 1, onProgress: p => progress.push(p) });
        expect(result).toMatchObject({ files: 15, parsed: 15, removed: 0 });
        index = EngineIndex.open(result.dbPath, FAKE_ENGINE);
    });

    afterAll(() => index?.close());

    it('builds into a per-engine cache folder and reports progress', () => {
        const paths = engineCachePaths(cacheDir, { root: FAKE_ENGINE, version: readEngineVersionAt(FAKE_ENGINE)! });
        expect(path.basename(paths.dir)).toMatch(/^9\.9-[0-9a-f]{10}$/);
        expect(fs.existsSync(paths.db)).toBe(true);
        expect(fs.existsSync(`${paths.db}.partial`)).toBe(false);
        expect(fs.existsSync(paths.lock)).toBe(false);
        expect(progress.map(p => p.phase)).toEqual(expect.arrayContaining(['scan', 'parse', 'index']));
        expect(progress.find(p => p.phase === 'parse' && p.done === 15)?.total).toBe(15);
        expect(index.meta()).toMatchObject({ files: '15', changelist: '12345' });
    });

    it('finds symbols by exact, partial and qualified name, ranking what the project uses first', () => {
        const rank = { depModules: new Map([['engine', 'direct' as const]]), enabledPlugins: new Set(['hidden']) };
        const jumps = index.findSymbolMatches('Jump', 'function', 4, rank).map(m => `${qualifiedName(m.symbol)}@${path.basename(m.symbol.file)}`);
        expect(jumps).toEqual(['ACharacter::Jump@Character.h', 'ACharacter::Jump@Character.cpp', 'FHiddenJump::Jump@HiddenJump.h', 'FUnusedJump::Jump@UnusedJump.h']);
        expect(qualifiedName(index.findSymbols('ACharacter')[0])).toBe('ACharacter');
        expect(index.findSymbols('haracterMove').length).toBe(0);
        expect(index.findSymbols('k2_destroy').map(qualifiedName)).toContain('AActor::K2_DestroyActor');
        expect(index.findSymbols('ACharacter::StopJ').map(qualifiedName)).toContain('ACharacter::StopJumping');
        expect(index.findSymbols('Clamp01')[0]).toMatchObject({ name: 'Clamp01', signature: 'static float Clamp01(float X);' });
    });

    it('links declarations to their definitions', () => {
        const [decl, def] = index.resolveSymbol('ACharacter::Jump');
        expect(decl).toMatchObject({ file: 'Engine/Source/Runtime/Engine/Classes/GameFramework/Character.h', isDefinition: false });
        expect(decl.definitions).toEqual([{ file: 'Engine/Source/Runtime/Engine/Private/Character.cpp', startLine: 7, endLine: 11 }]);
        expect(def).toMatchObject({ isDefinition: true, startLine: 7 });
        expect(index.resolveSymbol('Jump').length).toBe(4);
        expect(index.resolveSymbol('clamp01()').map(s => s.isDefinition)).toEqual([false, true]);
    });

    it('resolves engine paths by suffix and refuses to leave the install', () => {
        expect(index.resolvePath('GameFramework/Character.h')).toBe('Engine/Source/Runtime/Engine/Classes/GameFramework/Character.h');
        expect(index.resolvePath('Engine\\Config\\BaseEngine.ini')).toBe('Engine/Config/BaseEngine.ini');
        expect(() => index.resolvePath('Actor.h')).toThrow(/several engine files/);
        expect(index.resolvePath('GameFramework/Actor.h')).toBe('Engine/Source/Runtime/Engine/Classes/GameFramework/Actor.h');
        expect(() => index.resolvePath('../../package.json')).toThrow(/not found/);
    });

    it('renders outlines and module summaries of engine code', () => {
        const outline = renderFileOutline(index, 'Engine/Source/Runtime/Engine/Classes/GameFramework/Character.h');
        expect(outline).toMatch(/UFUNCTION\(BlueprintCallable\) virtual void Jump\(\);\s+→ Engine\/Source\/Runtime\/Engine\/Private\/Character\.cpp:7-11/);
        const engine = index.findModule('engine')!;
        expect(engine.files).toHaveLength(4);
        expect(renderModuleSummary(index, engine)).toContain('ACharacter (UCLASS : AActor) L');
        expect(renderModuleSummary(index, engine, { maxFiles: 2 })).toContain('4 files, too many to outline at once');
        expect(index.moduleOf('Engine/Plugins/Marketplace/Fabby/Source/Fabby/Public/FabbyWidget.h')?.plugin).toBe('Fabby');
        expect(index.plugins().map(p => p.name)).toContain('PluginBrowser');
    });

    it('skips a sync when nothing changed and it is recent', async () => {
        const result = await syncEngineIndex({ engineRoot: FAKE_ENGINE, cacheDir, jobs: 1, ifStale: true });
        expect(result.skipped).toBe('up to date');
    });
});

describe('incremental engine sync', () => {
    it('re-parses changed files, adds new plugins and drops deleted files', async () => {
        const root = copyEngine();
        const cacheDir = tempDir('ue-llm-index-cache-');
        const first = await syncEngineIndex({ engineRoot: root, cacheDir, jobs: 1 });
        const version = readEngineVersionAt(root)!;
        const paths = engineCachePaths(cacheDir, { root, version });
        expect(staleReason(paths, root, version)).toBeUndefined();

        const character = path.join(root, 'Engine/Source/Runtime/Engine/Classes/GameFramework/Character.h');
        fs.writeFileSync(character, fs.readFileSync(character, 'utf8').replace('virtual void StopJumping();', 'virtual void StopJumping();\n\tvoid LaunchCharacter();'));
        fs.rmSync(path.join(root, 'Engine/Source/Runtime/InputCore/Public/InputCoreTypes.h'));
        const fab = path.join(root, 'Engine/Plugins/Marketplace/NewFab');
        fs.mkdirSync(path.join(fab, 'Source/NewFab/Public'), { recursive: true });
        fs.writeFileSync(path.join(fab, 'NewFab.uplugin'), JSON.stringify({ FriendlyName: 'New Fab', Installed: true, Modules: [{ Name: 'NewFab' }] }));
        fs.writeFileSync(path.join(fab, 'Source/NewFab/NewFab.Build.cs'), 'public class NewFab : ModuleRules {}');
        fs.writeFileSync(path.join(fab, 'Source/NewFab/Public/NewFabThing.h'), 'struct FNewFabThing { void Launch(); };\n');
        expect(staleReason(paths, root, version)).toBe('plugins were added or removed');

        const second = await syncEngineIndex({ engineRoot: root, cacheDir, jobs: 1 });
        expect(second).toMatchObject({ parsed: 2, removed: 1, files: first.files });

        const index = EngineIndex.open(second.dbPath, root);
        try {
            expect(index.resolveSymbol('ACharacter::LaunchCharacter')).toHaveLength(1);
            expect(index.findSymbols('FKey')).toHaveLength(0);
            expect(index.findSymbols('Launch').map(qualifiedName)).toEqual(expect.arrayContaining(['ACharacter::LaunchCharacter', 'FNewFabThing::Launch']));
            expect(index.plugins().find(p => p.name === 'NewFab')).toMatchObject({ category: 'marketplace', friendlyName: 'New Fab' });
            // Names added by an update are searchable by substring too
            expect(index.findSymbols('aunchChar').map(qualifiedName)).toContain('ACharacter::LaunchCharacter');
        } finally {
            index.close();
        }
    });

    it('refuses to run while another live process holds the lock, and takes over stale locks', async () => {
        const root = copyEngine();
        const cacheDir = tempDir('ue-llm-index-cache-');
        const paths = engineCachePaths(cacheDir, { root, version: readEngineVersionAt(root)! });
        fs.mkdirSync(paths.dir, { recursive: true });

        // Our own pid is alive
        fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
        await expect(syncEngineIndex({ engineRoot: root, cacheDir, jobs: 1 })).rejects.toBeInstanceOf(EngineBusyError);

        fs.writeFileSync(paths.lock, JSON.stringify({ pid: 999_999_999, startedAt: Date.now() }));
        await expect(syncEngineIndex({ engineRoot: root, cacheDir, jobs: 1 })).resolves.toMatchObject({ files: 15 });
        expect(fs.existsSync(paths.lock)).toBe(false);
    });

    it('cleans up after a cancelled first build', async () => {
        const root = copyEngine();
        const cacheDir = tempDir('ue-llm-index-cache-');
        const controller = new AbortController();
        controller.abort();
        await expect(syncEngineIndex({ engineRoot: root, cacheDir, jobs: 1, signal: controller.signal })).rejects.toThrow(/cancelled/);
        const paths = engineCachePaths(cacheDir, { root, version: readEngineVersionAt(root)! });
        expect(fs.readdirSync(paths.dir)).toEqual([]);
    });
});
