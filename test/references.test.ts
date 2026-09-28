import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineProvider } from '../src/engineContext';
import { EngineInstall, locateEngine } from '../src/engine/locate';
import { syncEngineIndex } from '../src/engine/sync';
import { ProjectIndex } from '../src/indexer';
import { findCallers, findReferences, ReferenceResult, renderCallers, renderReferences } from '../src/references';
import { limitsFor, runTool, ToolContext } from '../src/tools';
import { copyFixture, SAMPLE_GAME } from './fixtures';

const FAKE_ENGINE = path.join(__dirname, 'fixtures/FakeEngine/UE_9.9');

/** Code that uses the sample's symbols in the ways references must tell apart. */
const PROJECT_FILES: Record<string, string> = {
    'Source/SampleGame/Private/SampleGameMode.cpp': [
        '#include "SampleCharacter.h"',
        '',
        'void ASampleGameMode::HurtPlayer(ASampleCharacter* Player, FSampleStats& Stats)',
        '{',
        '\tPlayer->ApplyDamage(0.5f, Stats);',
        '\t// ApplyDamage is also called by traps',
        '\tPlayer->OnHealthChanged.AddDynamic(this, &ASampleGameMode::HandleHealth);',
        '\tUE_LOG(LogTemp, Log, TEXT("ApplyDamage done"));',
        '}',
        '',
        'void ASampleGameMode::SetupInput(UInputComponent* Input)',
        '{',
        '\tInput->BindAction("Jump", IE_Pressed, this, &ACharacter::Jump);',
        '}',
        '',
    ].join('\n'),
    'Source/SampleGame/Private/Trap.cpp': [
        'struct FTrap',
        '{',
        '\tvoid ApplyDamage(float Amount) {}',
        '\tvoid Spring() { ApplyDamage(1.f); }',
        '};',
        '',
    ].join('\n'),
    'Source/SampleGame/Public/SampleHero.h': [
        '#pragma once',
        '#include "SampleCharacter.h"',
        '',
        'class ASampleHero : public ASampleCharacter',
        '{',
        'public:',
        '\tvirtual void Interact(AActor* Instigator) override;',
        '};',
        '',
    ].join('\n'),
};

/** Engine code that calls ACharacter::Jump, added at the ends of existing files so line numbers elsewhere don't move. */
const ENGINE_APPENDS: Record<string, string> = {
    'Engine/Source/Runtime/Engine/Private/Character.cpp': '\nvoid ACharacter::CheckJumpInput(float DeltaTime)\n{\n\tif (bPressedJump)\n\t{\n\t\tJump();\n\t}\n}\n',
    'Engine/Source/Runtime/Engine/Private/Actor.cpp': '\nvoid AActor::TestJump(ACharacter* Character)\n{\n\tCharacter->Jump();\n}\n',
};

describe('references', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-index-refs-'));
    let ctx: ToolContext;
    let engine: EngineProvider;

    const references = async (name: string, options = {}) => {
        const result = await findReferences(ctx, name, options);
        if ('error' in result) {
            throw new Error(result.error);
        }
        return result;
    };
    const lines = (result: ReferenceResult) => result.hits.map(h => `${path.basename(h.file)}:${h.line} ${h.kind}${h.enclosing ? ` in ${h.enclosing.name}` : ''}${h.likely ? '' : ' (possible)'}`);

    beforeAll(async () => {
        const project = path.join(temp, 'SampleGame');
        copyFixture(SAMPLE_GAME, project);
        for (const [rel, text] of Object.entries(PROJECT_FILES)) {
            fs.writeFileSync(path.join(project, rel), text);
        }
        const engineRoot = path.join(temp, 'UE_9.9');
        fs.cpSync(FAKE_ENGINE, engineRoot, { recursive: true });
        for (const [rel, text] of Object.entries(ENGINE_APPENDS)) {
            fs.appendFileSync(path.join(engineRoot, rel), text);
        }
        const index = new ProjectIndex(project);
        index.refresh(true);
        const install = locateEngine('', project, { override: engineRoot }) as EngineInstall;
        await syncEngineIndex({ engineRoot: install.root, cacheDir: path.join(temp, 'cache'), jobs: 1 });
        engine = new EngineProvider({ project: index, cacheDir: path.join(temp, 'cache'), install });
        ctx = { project: index, engine, limits: limitsFor() };
    });

    afterAll(() => {
        engine.dispose();
        fs.rmSync(temp, { recursive: true, force: true });
    });

    it('finds calls, leaves out the symbol itself, comments and other classes\' members, and marks unrelated hits', async () => {
        const result = await references('ASampleCharacter::ApplyDamage', { scope: 'project' });
        expect(lines(result)).toEqual(['SampleGameMode.cpp:5 call in ASampleGameMode::HurtPlayer', 'Trap.cpp:4 call in FTrap::Spring (possible)']);
        expect(result.skipped).toMatchObject({ text: 2, otherMembers: 1 });
        const text = renderReferences(result, 50);
        expect(text).toMatch(/^References to ASampleCharacter::ApplyDamage \(function\), found by name: 2 calls\.\nIt is exposed to Blueprints/);
        expect(text).toContain('Possibly unrelated: these files don\'t mention ASampleCharacter or a related class');
        expect(text).toContain('Skipped 1 same-named member of other classes.');
        expect(text).toContain('2 other mentions (comments, strings, same-named variables) left out; pass include_text to see them.');
        const withText = await references('ASampleCharacter::ApplyDamage', { scope: 'project', includeText: true });
        expect(lines(withText)).toEqual(expect.arrayContaining(['SampleGameMode.cpp:6 mention in ASampleGameMode::HurtPlayer', 'SampleGameMode.cpp:8 mention in ASampleGameMode::HurtPlayer']));
    });

    it('finds engine callers and input bindings of an engine function', async () => {
        const result = await references('ACharacter::Jump');
        // Files with bindings first, then calls
        expect(lines(result)).toEqual([
            'SampleGameMode.cpp:13 binding in ASampleGameMode::SetupInput',
            'Actor.cpp:17 call in AActor::TestJump',
            'Character.cpp:27 call in ACharacter::CheckJumpInput',
        ]);
        // FHiddenJump::Jump is another class's member; the Unused plugin isn't enabled, so it isn't searched
        expect(result.skipped.otherMembers).toBe(1);
        expect(result.notes[0]).toMatch(/^Engine: searched the 3 engine modules the project depends on and 2 plugins it enables/);
    });

    it('tells overrides from base-class declarations', async () => {
        const result = await references('ASampleCharacter::Interact', { scope: 'project' });
        expect(lines(result)).toEqual(['SampleCharacter.h:55 base in ISampleInteractable', 'SampleHero.h:7 override in ASampleHero']);
    });

    it('finds delegate bindings and broadcasts, and uses of types', async () => {
        expect(lines(await references('OnHealthChanged', { scope: 'project' }))).toEqual([
            'SampleGameMode.cpp:7 binding in ASampleGameMode::HurtPlayer',
            'SampleCharacter.cpp:24 call in ASampleCharacter::ApplyDamage',
        ]);
        const stats = lines(await references('FSampleStats', { scope: 'project' }));
        expect(stats).toContain('SampleGameMode.cpp:3 use in ASampleGameMode::HurtPlayer');
        expect(stats.every(l => l.includes(' use'))).toBe(true);
    });

    it('asks for a qualified name when a name is ambiguous', async () => {
        expect(await findReferences(ctx, 'Interact')).toEqual({ error: expect.stringMatching(/^"Interact" is ambiguous; pass one of: .*ASampleCharacter::Interact/) });
        expect(await findReferences(ctx, 'operator==')).toEqual({ error: expect.stringContaining('operators') });
    });

    it('builds a caller tree', async () => {
        const result = await findCallers(ctx, 'ACharacter::Jump', { depth: 2 });
        if ('error' in result) {
            throw new Error(result.error);
        }
        expect(result.callers.map(c => [c.name, c.calls, c.bindings])).toEqual([
            ['AActor::TestJump', 1, 0],
            ['ACharacter::CheckJumpInput', 1, 0],
            ['ASampleGameMode::SetupInput', 0, 1],
        ]);
        const text = renderCallers(result, 60);
        expect(text).toMatch(/^Callers of ACharacter::Jump \(function\), found by name\./);
        expect(text).toContain('- ACharacter::CheckJumpInput — Engine/Source/Runtime/Engine/Private/Character.cpp:27 (1 call)\n  (no callers found)');
        expect(text).toContain('- ASampleGameMode::SetupInput — SampleGameMode.cpp:13 (bound 1×)');
    });

    it('is available as tools', async () => {
        expect((await runTool('find_references', { name: 'ACharacter::Jump', scope: 'engine' }, ctx)).text).toContain('call in ACharacter::CheckJumpInput');
        expect((await runTool('callers', { name: 'ASampleCharacter::ApplyDamage', scope: 'project' }, ctx)).text).toContain('- ASampleGameMode::HurtPlayer —');
    });
});
