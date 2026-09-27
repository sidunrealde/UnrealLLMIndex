import { readFileSync } from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { compactSpecifiers, parseSource } from '../src/parse';
import { sanitize } from '../src/sanitize';
import { CodeSymbol } from '../src/types';

const fixture = (rel: string) => readFileSync(path.join(__dirname, 'fixtures/SampleGame', rel), 'utf8');
const lineOf = (src: string, needle: string) => src.split('\n').findIndex(l => l.includes(needle)) + 1;
const find = (symbols: CodeSymbol[], qualified: string, isDefinition?: boolean) =>
    symbols.find(
        s => (s.container ? `${s.container}::${s.name}` : s.name) === qualified && (isDefinition === undefined || !!s.isDefinition === isDefinition),
    );

describe('sanitize', () => {
    it('blanks comments, strings and preprocessor lines but keeps offsets and newlines', () => {
        const src = '#include "A.h"\nint X = 1; // note\nFString S = TEXT("a;b{"); /* c\nd */ int Y;';
        const { code, display } = sanitize(src);
        expect(code.length).toBe(src.length);
        expect(code.split('\n').length).toBe(src.split('\n').length);
        expect(code).not.toContain('include');
        expect(code).not.toContain('note');
        expect(code).not.toContain('a;b{');
        expect(code).toContain('int Y;');
        expect(display).toContain('TEXT("a;b{")');
        expect(display).not.toContain('note');
    });

    it('does not treat digit separators as character literals', () => {
        const { code } = sanitize("int N = 1'000; int M;");
        expect(code).toContain('int M;');
    });
});

describe('parseSource: header', () => {
    const src = fixture('Source/SampleGame/Public/SampleCharacter.h');
    const symbols = parseSource(src, 'Source/SampleGame/Public/SampleCharacter.h');

    it('finds delegates declared with UE macros, including RetVal variants', () => {
        const health = find(symbols, 'FOnHealthChanged');
        expect(health?.kind).toBe('delegate');
        expect(health?.line).toBe(lineOf(src, 'FOnHealthChanged, float'));
        expect(find(symbols, 'FCanInteract')?.kind).toBe('delegate');
    });

    it('skips forward declarations and records namespace constants', () => {
        expect(symbols.some(s => s.name === 'UInputAction')).toBe(false);
        expect(find(symbols, 'SampleTags::Player')?.kind).toBe('variable');
        expect(find(symbols, 'SampleTags::MaxLevel')?.kind).toBe('variable');
    });

    it('parses UENUMs with their values', () => {
        const state = find(symbols, 'ESampleState');
        expect(state).toMatchObject({ kind: 'enum', members: ['Idle', 'Running', 'Dead'] });
        expect(state?.ue?.name).toBe('UENUM');
        expect(state?.startLine).toBe(lineOf(src, 'UENUM(BlueprintType)'));
    });

    it('parses USTRUCTs, stripping the export macro, with properties and inline functions', () => {
        const stats = find(symbols, 'FSampleStats');
        expect(stats).toMatchObject({ kind: 'struct', signature: 'struct FSampleStats' });
        // ENUM_CLASS_FLAGS before USTRUCT must not be taken as the struct's start
        expect(stats?.startLine).toBe(lineOf(src, 'USTRUCT(BlueprintType)'));
        const health = find(symbols, 'FSampleStats::Health');
        expect(health).toMatchObject({ kind: 'property', access: 'public' });
        expect(health?.ue).toEqual({ name: 'UPROPERTY', args: 'EditAnywhere, BlueprintReadWrite, Category = "Stats", meta = (ClampMin = "0")' });
        expect(find(symbols, 'FSampleStats::Inventory')?.kind).toBe('property');
        expect(find(symbols, 'FSampleStats::IsAlive')).toMatchObject({ kind: 'function', isDefinition: true });
    });

    it('marks both halves of a UINTERFACE as interfaces', () => {
        expect(find(symbols, 'USampleInteractable')?.kind).toBe('interface');
        expect(find(symbols, 'ISampleInteractable')?.kind).toBe('interface');
        expect(find(symbols, 'ISampleInteractable::Interact')).toMatchObject({ kind: 'function', access: 'public', isDefinition: false });
    });

    it('parses a UCLASS with export macro, final, and multiple bases', () => {
        const character = find(symbols, 'ASampleCharacter');
        expect(character).toMatchObject({
            kind: 'class',
            bases: ['ACharacter', 'ISampleInteractable'],
            line: lineOf(src, 'class SAMPLEGAME_API ASampleCharacter'),
            startLine: lineOf(src, 'UCLASS(Blueprintable'),
        });
        expect(character?.ue?.name).toBe('UCLASS');
        expect(character?.endLine).toBe(src.trimEnd().split('\n').length);
    });

    it('tracks access specifiers and UFUNCTION specifiers on members', () => {
        const ctor = find(symbols, 'ASampleCharacter::ASampleCharacter');
        expect(ctor).toMatchObject({ kind: 'function', access: 'public', startLine: lineOf(src, 'ASampleCharacter();') });
        const damage = find(symbols, 'ASampleCharacter::ApplyDamage');
        expect(damage?.ue?.name).toBe('UFUNCTION');
        expect(damage?.startLine).toBe(lineOf(src, 'Category = "Sample|Combat"'));
        expect(damage?.line).toBe(lineOf(src, 'void ApplyDamage'));
        expect(find(symbols, 'ASampleCharacter::BeginPlay')?.access).toBe('protected');
        expect(find(symbols, 'ASampleCharacter::Callback')?.access).toBe('private');
    });

    it('handles inline bodies, operators, bitfields, std::function-like types and aliases', () => {
        expect(find(symbols, 'ASampleCharacter::GetHealth')).toMatchObject({ kind: 'function', isDefinition: true });
        expect(find(symbols, 'ASampleCharacter::operator==')?.kind).toBe('function');
        expect(find(symbols, 'ASampleCharacter::Callback')?.kind).toBe('property');
        expect(find(symbols, 'ASampleCharacter::Flags')?.kind).toBe('property');
        expect(find(symbols, 'ASampleCharacter::Greeting')?.signature).toBe('FString Greeting = TEXT("Hello; {world}");');
        expect(find(symbols, 'ASampleCharacter::DefaultTags')?.kind).toBe('property');
        expect(find(symbols, 'ASampleCharacter::FTagArray')?.kind).toBe('alias');
    });
});

describe('parseSource: implementation file', () => {
    const src = fixture('Source/SampleGame/Private/SampleCharacter.cpp');
    const symbols = parseSource(src, 'Source/SampleGame/Private/SampleCharacter.cpp');

    it('finds out-of-line definitions with their full line ranges', () => {
        const damage = find(symbols, 'ASampleCharacter::ApplyDamage', true);
        expect(damage).toMatchObject({
            startLine: lineOf(src, 'void ASampleCharacter::ApplyDamage'),
            // The "}" inside a string literal must not end the body early
            endLine: lineOf(src, 'a brace inside a string') + 1,
        });
        expect(find(symbols, 'ASampleCharacter::operator==', true)).toBeDefined();
        expect(find(symbols, 'ASampleCharacter::BeginPlay', true)?.endLine).toBe(src.trimEnd().split('\n').length);
    });

    it('drops constructor initializer lists from signatures', () => {
        expect(find(symbols, 'ASampleCharacter::ASampleCharacter', true)?.signature).toBe('ASampleCharacter::ASampleCharacter()');
    });

    it('records functions in anonymous namespaces without a container', () => {
        expect(find(symbols, 'Clamp01', true)).toBeDefined();
    });

    it('does not report statements inside function bodies', () => {
        expect(symbols.some(s => s.name === 'Lambda' || s.name === 'Msg')).toBe(false);
    });
});

describe('parseSource: edge cases', () => {
    it('treats direct-initialized globals as variables, not function declarations', () => {
        const symbols = parseSource('namespace uuid {\n static std::mt19937 gen(rd());\n static std::uniform_int_distribution<> dis(0, 15);\n int Make(int Seed);\n}', 'a.h');
        expect(find(symbols, 'uuid::gen')?.kind).toBe('variable');
        expect(find(symbols, 'uuid::dis')?.kind).toBe('variable');
        expect(find(symbols, 'uuid::Make')?.kind).toBe('function');
    });

    it('survives unbalanced braces without throwing', () => {
        expect(() => parseSource('class A {\n void F() {\n', 'broken.h')).not.toThrow();
    });
});

describe('compactSpecifiers', () => {
    it('removes Category and meta but keeps behavior specifiers', () => {
        expect(compactSpecifiers('BlueprintCallable, Category = "A|B", meta = (WorldContext = "Owner")')).toBe('BlueprintCallable');
        expect(compactSpecifiers('ClassGroup = (XAPI), meta = (BlueprintSpawnableComponent)')).toBe('ClassGroup = (XAPI)');
    });
});
