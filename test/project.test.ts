import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeIndex } from '../src/emit';
import { ProjectIndex, qualifiedName } from '../src/indexer';
import { renderFileOutline, renderIndex, renderModuleSummary } from '../src/outline';
import { parseBuildCs, scanProject } from '../src/scan';

const FIXTURE = path.join(__dirname, 'fixtures/SampleGame');
const tempDirs: string[] = [];

function copyFixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-index-'));
    fs.cpSync(FIXTURE, dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('scanProject', () => {
    const project = scanProject(FIXTURE);

    it('reads the .uproject', () => {
        expect(project.name).toBe('SampleGame');
        expect(project.engineAssociation).toBe('5.4');
        expect(project.enabledPlugins).toEqual(['EnhancedInput']);
    });

    it('finds game and plugin modules with their dependencies', () => {
        expect(project.modules.map(m => m.name)).toEqual(['SampleGame', 'Telemetry']);
        const game = project.modules[0];
        expect(game).toMatchObject({ type: 'Runtime', plugin: undefined, dir: 'Source/SampleGame' });
        expect(game.publicDeps).toEqual(['Core', 'CoreUObject', 'Engine']);
        expect(game.privateDeps).toEqual(['Json']);
        expect(project.modules[1]).toMatchObject({ plugin: 'Telemetry', privateDeps: ['CoreUObject', 'Engine', 'HTTP'] });
        expect(project.plugins[0]).toMatchObject({ name: 'Telemetry', description: 'Sends gameplay events to an analytics backend.' });
    });

    it('assigns files to modules and skips Intermediate', () => {
        const all = project.modules.flatMap(m => m.files);
        expect(all).toContain('Source/SampleGame/Private/SampleCharacter.cpp');
        expect(all).toContain('Plugins/Telemetry/Source/Telemetry/Public/Utils.h');
        expect(all.some(f => f.includes('Intermediate'))).toBe(false);
        expect(project.looseFiles).toEqual([]);
    });

    it('also accepts the .uproject path itself', () => {
        expect(scanProject(path.join(FIXTURE, 'SampleGame.uproject')).name).toBe('SampleGame');
    });
});

describe('parseBuildCs', () => {
    it('ignores commented-out dependencies', () => {
        const deps = parseBuildCs('// PublicDependencyModuleNames.Add("A");\nPublicDependencyModuleNames.AddRange(new[] { "B" /* "C" */ });');
        expect(deps).toEqual({ publicDeps: ['B'], privateDeps: [] });
    });
});

describe('ProjectIndex', () => {
    const index = new ProjectIndex(FIXTURE);
    index.refresh(true);

    it('links header declarations to their implementations', () => {
        const decl = index.resolveSymbol('ASampleCharacter::ApplyDamage').find(s => !s.isDefinition);
        expect(decl?.definitions).toEqual([
            expect.objectContaining({ file: 'Source/SampleGame/Private/SampleCharacter.cpp' }),
        ]);
        const pure = index.resolveSymbol('ISampleInteractable::Interact')[0];
        expect(pure.definitions).toBeUndefined();
    });

    it('uses the shortest unique path suffix', () => {
        expect(index.shortPath('Source/SampleGame/Private/SampleCharacter.cpp')).toBe('SampleCharacter.cpp');
        expect(index.shortPath('Source/SampleGame/Public/Utils.h')).toBe('SampleGame/Public/Utils.h');
        expect(index.shortPath('Plugins/Telemetry/Source/Telemetry/Public/Utils.h')).toBe('Telemetry/Public/Utils.h');
    });

    it('resolves paths by unique suffix and refuses ambiguous or outside paths', () => {
        expect(index.resolvePath('SampleCharacter.h')).toBe('Source/SampleGame/Public/SampleCharacter.h');
        expect(index.resolvePath('.\\Source\\SampleGame\\Public\\SampleCharacter.h')).toBe('Source/SampleGame/Public/SampleCharacter.h');
        expect(() => index.resolvePath('Utils.h')).toThrow(/several files/);
        expect(() => index.resolvePath('../outside.txt')).toThrow(/not found/);
        expect(() => index.resolvePath('Plugins/Telemetry/Intermediate/Build/Utils.generated.h')).toThrow(/not found/);
        expect(index.resolvePath('SampleGame.uproject')).toBe('SampleGame.uproject');
    });

    it('ranks exact matches first in find_symbol', () => {
        expect(qualifiedName(index.findSymbols('ApplyDamage')[0])).toBe('ASampleCharacter::ApplyDamage');
        expect(index.findSymbols('asamplechar')[0].name).toBe('ASampleCharacter');
        expect(index.findSymbols('Stats', 'property').every(s => s.kind === 'property')).toBe(true);
    });

    it('renders outlines with implementation links', () => {
        const outline = renderFileOutline(index, 'Source/SampleGame/Public/SampleCharacter.h');
        expect(outline).toMatch(/UFUNCTION\(BlueprintCallable\) void ApplyDamage\(float Amount, FSampleStats& InStats\);\s+→ SampleCharacter\.cpp:\d+-\d+/);
        expect(outline).toContain('protected:');
        expect(outline).toContain('namespace SampleTags constants: Player, MaxLevel');
        const summary = renderModuleSummary(index, index.findModule('telemetry')!);
        expect(summary).toContain('FTelemetryUtils (class) L');
        const md = renderIndex(index);
        expect(md).toContain('- Public/SampleCharacter.h: FOnHealthChanged (delegate); FCanInteract (delegate); ESampleState (UENUM); FSampleStats (USTRUCT);');
        expect(md).toContain('ASampleCharacter (UCLASS : ACharacter, ISampleInteractable)');
    });
});

describe('incremental refresh and writing', () => {
    it('picks up edited, added and deleted files', () => {
        const dir = copyFixture();
        const index = new ProjectIndex(dir);
        index.refresh(true);
        expect(index.refresh(true)).toBe(false);

        const header = path.join(dir, 'Source/SampleGame/Public/Utils.h');
        fs.writeFileSync(header, fs.readFileSync(header, 'utf8').replace('FString Describe(int32 Value);', 'FString Describe(int32 Value);\n\tint32 Twice(int32 Value);'));
        const added = path.join(dir, 'Source/SampleGame/Public/NewThing.h');
        fs.writeFileSync(added, 'USTRUCT()\nstruct FNewThing\n{\n\tGENERATED_BODY()\n};\n');
        fs.rmSync(path.join(dir, 'Plugins/Telemetry/Source/Telemetry/Private/Utils.cpp'));

        expect(index.refresh(true)).toBe(true);
        expect(index.resolveSymbol('SampleUtils::Twice')).toHaveLength(1);
        expect(index.resolveSymbol('FNewThing')).toHaveLength(1);
        expect(index.resolveSymbol('FTelemetryUtils::MakeEventName')[0].definitions).toBeUndefined();
    });

    it('writes INDEX.md, module outlines and symbols.json', () => {
        const dir = copyFixture();
        const index = new ProjectIndex(dir);
        index.refresh(true);
        const emitted = writeIndex(index);
        const out = path.join(dir, '.llm-index');
        expect(fs.readFileSync(path.join(out, 'INDEX.md'), 'utf8')).toContain('# LLM index: SampleGame');
        expect(fs.readdirSync(path.join(out, 'modules')).sort()).toEqual(['SampleGame.md', 'Telemetry.md']);
        expect(JSON.parse(fs.readFileSync(path.join(out, 'symbols.json'), 'utf8')).symbols.length).toBe(index.allSymbols().length);
        expect(emitted.every(f => f.tokens > 0)).toBe(true);
        // The index folder itself must never be indexed
        index.refresh(true);
        expect(index.indexedFiles().some(f => f.startsWith('.llm-index'))).toBe(false);
    });
});
