import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineProvider } from '../src/engineContext';
import { EngineInstall, locateEngine } from '../src/engine/locate';
import { syncEngineIndex } from '../src/engine/sync';
import { ProjectIndex } from '../src/indexer';
import { MemoryStore } from '../src/memory';
import { elideToolResults, handleChatRequest, historyMessages, identifiersIn } from '../src/participant';
import { limitsFor, ToolContext } from '../src/tools';
import {
    ChatRequestTurn,
    ChatResponseMarkdownPart,
    ChatResponseTurn,
    LanguageModelChatMessage,
    LanguageModelError,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    Location,
} from './vscode-mock';

const FIXTURE = path.join(__dirname, 'fixtures/SampleGame');
const FAKE_ENGINE = path.join(__dirname, 'fixtures/FakeEngine/UE_9.9');

type Step = (messages: LanguageModelChatMessage[], options: any) => unknown[];

/** A model that answers from a script: each step returns the parts of one response. */
function fakeModel(steps: Step[], maxInputTokens = 100_000) {
    const requests: { messages: LanguageModelChatMessage[]; options: any }[] = [];
    return {
        requests,
        model: {
            maxInputTokens,
            async sendRequest(messages: LanguageModelChatMessage[], options: any) {
                requests.push({ messages: [...messages], options });
                const step = steps.shift();
                if (!step) {
                    throw new Error('unexpected request');
                }
                const parts = step(messages, options);
                return { stream: (async function* () { yield* parts; })(), text: (async function* () {})() };
            },
        },
    };
}

function fakeStream() {
    const out = { markdown: [] as string[], progress: [] as string[], references: [] as Location[] };
    const stream = {
        markdown: (value: string) => out.markdown.push(value),
        progress: (value: string) => out.progress.push(value),
        reference: (value: Location) => out.references.push(value),
    };
    return { out, stream: stream as unknown as vscode.ChatResponseStream };
}

const textOf = (message: LanguageModelChatMessage) =>
    message.content.map(p => (p instanceof LanguageModelTextPart ? p.value : p instanceof LanguageModelToolResultPart ? (p.content as LanguageModelTextPart[]).map(c => c.value).join('') : '')).join('');

describe('@unreal participant', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-index-chat-'));
    const index = new ProjectIndex(FIXTURE);
    let engine: EngineProvider;
    let ctx: ToolContext;
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as unknown as vscode.CancellationToken;

    const ask = (prompt: string, model: object, history: unknown[] = [], toolContext: ToolContext | null = ctx, command?: string) => {
        const { out, stream } = fakeStream();
        const request = { prompt, command, references: [], toolReferences: [], model } as unknown as vscode.ChatRequest;
        const result = handleChatRequest(request, { history } as unknown as vscode.ChatContext, stream, token, { toolContext: () => toolContext ?? undefined, maxToolRounds: () => 3 });
        return result.then(r => ({ result: r, out }));
    };

    beforeAll(async () => {
        index.refresh(true);
        const install = locateEngine('', FIXTURE, { override: FAKE_ENGINE }) as EngineInstall;
        await syncEngineIndex({ engineRoot: install.root, cacheDir, jobs: 1 });
        engine = new EngineProvider({ project: index, cacheDir, install });
        ctx = { project: index, engine, limits: limitsFor() };
    });

    afterAll(() => {
        engine.dispose();
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    it('starts from the index, runs the tools the model asks for, and streams the answer', async () => {
        const { model, requests } = fakeModel([
            () => [new LanguageModelTextPart('Looking. '), new LanguageModelToolCallPart('c1', 'read_symbol', { name: 'ACharacter::Jump' })],
            () => [new LanguageModelTextPart('It sets bPressedJump.')],
        ]);
        const { result, out } = await ask('What does ACharacter::Jump do?', model);

        expect(out.markdown.join('')).toBe('Looking. It sets bPressedJump.');
        expect(out.progress).toEqual(['read_symbol({"name":"ACharacter::Jump"})']);
        expect(out.references.map(r => `${path.basename(r.uri.fsPath)}:${r.range.start.line + 1}`)).toEqual(['Character.h:15', 'Character.cpp:7']);
        expect(result.metadata).toEqual({
            rounds: 2,
            toolCalls: ['read_symbol({"name":"ACharacter::Jump"})'],
            read: ['Engine/Source/Runtime/Engine/Classes/GameFramework/Character.h:15-16', 'Engine/Source/Runtime/Engine/Private/Character.cpp:7-11'],
            maxPromptTokens: expect.any(Number),
        });

        const [first, second] = requests;
        expect(textOf(first.messages[0])).toContain('# LLM index: SampleGame');
        expect(textOf(first.messages[0])).toContain('## Engine');
        expect(first.options.tools.map((t: any) => t.name)).toContain('find_symbol');
        expect(first.options.tools.find((t: any) => t.name === 'read_lines').inputSchema.required).toEqual(['path', 'start']);
        const toolResult = second.messages.at(-1)!;
        expect(toolResult.content[0]).toBeInstanceOf(LanguageModelToolResultPart);
        expect(textOf(toolResult)).toContain('bPressedJump = true;');
    });

    it('stops after the configured number of tool rounds', async () => {
        const call = () => [new LanguageModelToolCallPart('c', 'find_symbol', { query: 'Jump' })];
        const { model } = fakeModel([call, call, call]);
        const { result, out } = await ask('Loop forever', model);
        expect(result.metadata?.rounds).toBe(3);
        expect(out.markdown.join('')).toContain('Stopped after 3 rounds of tool calls');
    });

    it('answers from the index with lookups when the model cannot call tools', async () => {
        const { model, requests } = fakeModel([
            () => {
                throw new Error('This model does not support tool calling');
            },
            () => [new LanguageModelTextPart('It is in SampleCharacter.cpp.')],
        ]);
        const { out } = await ask('Where is ASampleCharacter::ApplyDamage implemented?', model);
        expect(out.markdown.join('')).toBe('It is in SampleCharacter.cpp.');
        expect(requests[1].options.tools).toBeUndefined();
        expect(textOf(requests[1].messages.at(-1)!)).toContain('find_symbol("ASampleCharacter::ApplyDamage"):\nfunction ASampleCharacter::ApplyDamage');
    });

    it('reports model errors and a missing project', async () => {
        const { model } = fakeModel([
            () => {
                throw new LanguageModelError('quota exceeded', 'Blocked');
            },
        ]);
        const failed = await ask('Anything', model);
        expect(failed.result.errorDetails?.message).toBe('quota exceeded (Blocked)');
        const noProject = await ask('Anything', fakeModel([]).model, [], null);
        expect(noProject.out.markdown.join('')).toContain('No Unreal Engine project');
    });

    it('keeps earlier turns as text, with what each answer looked at', () => {
        const messages = historyMessages({
            history: [
                new ChatRequestTurn('Where is Jump?'),
                new ChatResponseTurn([new ChatResponseMarkdownPart('In '), new ChatResponseMarkdownPart('Character.cpp.')], { metadata: { read: ['Character.cpp:7-11', 'Character.h:15'] } }),
                new ChatRequestTurn('And StopJumping?'),
                new ChatResponseTurn([new ChatResponseMarkdownPart('Right below it.')]),
            ],
        } as unknown as vscode.ChatContext);
        expect(messages.map(m => [m.role, textOf(m as unknown as LanguageModelChatMessage)])).toEqual([
            [1, 'Where is Jump?'],
            [2, 'In Character.cpp.\n\n(Looked at: Character.cpp:7-11, Character.h:15)'],
            [1, 'And StopJumping?'],
            [2, 'Right below it.'],
        ]);
    });

    describe('with project memory', () => {
        let memory: MemoryStore;
        let memoryCtx: ToolContext;

        beforeAll(() => {
            memory = new MemoryStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-index-chat-memory-')));
            memoryCtx = { ...ctx, memory };
        });

        afterAll(() => fs.rmSync(memory.dir, { recursive: true, force: true }));

        it('/save turns the conversation into notes with the memory tools only, showing each one', async () => {
            const { model, requests } = fakeModel([
                () => [new LanguageModelToolCallPart('r', 'recall', {})],
                () => [
                    new LanguageModelToolCallPart('a', 'remember', { text: 'Jump only sets bPressedJump; movement reads it later.', about: ['ACharacter::Jump'] }),
                    new LanguageModelToolCallPart('b', 'remember', { text: 'Add a double jump.', kind: 'task', about: ['ACharacter'] }),
                ],
                () => [new LanguageModelTextPart('Saved a fact and a task.')],
            ]);
            const history = [new ChatRequestTurn('How does Jump work?'), new ChatResponseTurn([new ChatResponseMarkdownPart('It sets a flag.')])];
            const { out, result } = await ask('Focus on jumping', model, history, memoryCtx, 'save');

            const first = requests[0];
            expect(first.options.tools.map((t: any) => t.name).sort()).toEqual(['recall', 'remember', 'update_note']);
            expect(textOf(first.messages.at(-1)!)).toMatch(/^Save what this conversation established to project memory[\s\S]*The user adds: Focus on jumping$/);
            expect(first.messages.map(m => textOf(m))).toContain('It sets a flag.');

            const text = out.markdown.join('');
            expect(text).toMatch(/> 📝 Saved fact \[\w{6}\] to \.llm-memory\/\w{6}-jump-only-sets-bpressedjump-movement-reads\.md, about ACharacter::Jump\./);
            expect(text).toContain('> 📝 Saved task [');
            expect(text).toMatch(/Saved a fact and a task\.\n\n_2 notes saved to `\.llm-memory\/`\._$/);
            expect(memory.list().map(n => n.kind).sort()).toEqual(['fact', 'task']);
            expect(memory.list().every(n => n.source === '@unreal')).toBe(true);
            expect(result.metadata?.toolCalls).toHaveLength(3);
        });

        it('/memory lists the notes without calling the model', async () => {
            const { model, requests } = fakeModel([]);
            const { out } = await ask('', model, [], memoryCtx, 'memory');
            const text = out.markdown.join('');
            expect(requests).toHaveLength(0);
            expect(text).toMatch(/^\*\*Project memory\*\*: 2 notes in `\.llm-memory\/`\n\n\*\*Open tasks\*\*\n- \[\w{6}\] task \(open\), .*: Add a double jump\. — about ACharacter/);
            expect(text).toContain('**Facts**\n- [');
        });

        it('says so when memory is off', async () => {
            const { out } = await ask('', fakeModel([]).model, [], ctx, 'save');
            expect(out.markdown.join('')).toContain('Project memory is off');
        });
    });

    it('elides the oldest tool results when the conversation gets too long', () => {
        const big = 'x'.repeat(1000);
        const messages = [
            LanguageModelChatMessage.User('question'),
            LanguageModelChatMessage.User([new LanguageModelToolResultPart('a', [new LanguageModelTextPart(big)])]),
            LanguageModelChatMessage.User([new LanguageModelToolResultPart('b', [new LanguageModelTextPart(big)])]),
        ] as unknown as vscode.LanguageModelChatMessage[];
        const refs = [
            { message: 1, part: 0, call: 'find_symbol({"query":"A"})' },
            { message: 2, part: 0, call: 'find_symbol({"query":"B"})' },
        ];
        expect(elideToolResults(messages, refs, 1500)).toBe(1);
        expect(textOf(messages[1] as unknown as LanguageModelChatMessage)).toBe('[Result removed to save context. Call find_symbol({"query":"A"}) again if you still need it.]');
        expect(textOf(messages[2] as unknown as LanguageModelChatMessage)).toBe(big);
        expect(elideToolResults(messages, refs, 100_000)).toBe(0);
    });

    it('picks out identifiers worth looking up', () => {
        expect(identifiersIn('How does ACharacter::Jump reach UCharacterMovementComponent, and what is DoJump?')).toEqual([
            'ACharacter::Jump',
            'UCharacterMovementComponent',
            'DoJump',
        ]);
    });
});
