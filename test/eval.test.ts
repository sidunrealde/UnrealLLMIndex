import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineProvider } from '../src/engineContext';
import { EngineInstall, locateEngine } from '../src/engine/locate';
import { syncEngineIndex } from '../src/engine/sync';
import {
    checkAnswer,
    compareReports,
    EvalReport,
    EvalResult,
    generateQuestions,
    parseGrade,
    parseQuestions,
    renderQuestionsFile,
    renderReport,
    summarize,
    writeReport,
} from '../src/eval';
import { runEvalInChat } from '../src/evalChat';
import { runEvalWithEndpoint } from '../src/evalCli';
import { ProjectIndex } from '../src/indexer';
import { MemoryStore } from '../src/memory';
import { createServer } from '../src/server';
import { limitsFor, ToolContext } from '../src/tools';
import { copyFixture, SAMPLE_GAME } from './fixtures';
import { LanguageModelTextPart, LanguageModelToolCallPart } from './vscode-mock';

const FAKE_ENGINE = path.join(__dirname, 'fixtures/FakeEngine/UE_9.9');

const result = (id: string, pass: boolean, extra: Partial<EvalResult> = {}): EvalResult => ({
    id,
    question: `Question ${id}?`,
    answer: `Answer ${id}.`,
    toolCalls: ['find_symbol({"query":"X"})'],
    rounds: 2,
    ms: 1500,
    checks: [{ name: 'mentions "X"', pass }],
    pass,
    ...extra,
});

const report = (model: string, results: EvalResult[]): EvalReport => ({
    kit: 1,
    createdAt: '2026-09-28T12:00:00.000Z',
    runner: 'cli',
    model,
    project: 'D:/Game',
    config: { extension: '0.5.0' },
    summary: summarize(results),
    results,
});

describe('questions', () => {
    it('reads a question file and fills in ids', () => {
        const questions = parseQuestions(
            JSON.stringify({
                questions: [
                    { id: 'jump', question: ' How does Jump work? ', expect: { mentions: ['CheckJumpInput'], tools: ['read_symbol'], maxToolCalls: 10 }, reference: 'It sets a flag.' },
                    { question: 'Second?' },
                ],
            }),
        );
        expect(questions).toEqual([
            {
                id: 'jump',
                question: 'How does Jump work?',
                expect: { mentions: ['CheckJumpInput'], notMentions: undefined, tools: ['read_symbol'], maxToolCalls: 10 },
                reference: 'It sets a flag.',
                note: undefined,
            },
            { id: 'q2', question: 'Second?', expect: { mentions: undefined, notMentions: undefined, tools: undefined, maxToolCalls: undefined }, reference: undefined, note: undefined },
        ]);
    });

    it('says what is wrong with a bad file', () => {
        expect(() => parseQuestions('{ nope')).toThrow(/questions\.json is not valid JSON/);
        expect(() => parseQuestions('{"questions": []}')).toThrow(/needs a "questions" list/);
        expect(() => parseQuestions('{"questions": [{"id": "a", "question": "x"}, {"id": "a", "question": "y"}]}')).toThrow(/id "a" is used twice/);
        expect(() => parseQuestions('{"questions": [{"question": "x", "expect": {"mentions": "Jump"}}]}')).toThrow(/expect\.mentions must be a list of strings/);
        expect(() => parseQuestions('{"questions": [{"id": "a"}]}')).toThrow(/question 1 has no "question" text/);
    });

    it('checks answers and tool use', () => {
        const q = parseQuestions(JSON.stringify([{ question: 'Q', expect: { mentions: ['DoJump'], notMentions: ['UPawnMovement'], tools: ['callers'], maxToolCalls: 2 } }]))[0];
        const checks = checkAnswer(q, 'It calls dojump() via CheckJumpInput.', ['callers({"name":"X"})', 'read_symbol({})', 'read_lines({})']);
        expect(checks).toEqual([
            { name: 'mentions "DoJump"', pass: true },
            { name: 'doesn\'t mention "UPawnMovement"', pass: true },
            { name: 'calls callers', pass: true },
            { name: 'at most 2 tool calls', pass: false, detail: '3 calls' },
        ]);
        expect(checkAnswer({ id: 'x', question: 'Q' }, '  ', [])).toEqual([{ name: 'gives an answer', pass: false }]);
    });

    it('reads grades from replies with extra text', () => {
        expect(parseGrade('```json\n{"score": 4, "reason": "Misses one caller."}\n```')).toEqual({ score: 4, reason: 'Misses one caller.' });
        expect(parseGrade('Sure! {"score": "5"}')).toEqual({ score: 5, reason: '' });
        expect(parseGrade('{"score": 9}')).toBeUndefined();
        expect(parseGrade('no json')).toBeUndefined();
    });
});

describe('reports', () => {
    it('summarizes, renders and writes a run', () => {
        const run = report('qwen3.6', [result('a', true, { promptTokens: 12000, grade: { score: 4, reason: 'Good.' } }), result('b', false, { promptTokens: 8000, error: 'timeout' })]);
        expect(run.summary).toEqual({ questions: 2, passed: 1, averageToolCalls: 1, averageSeconds: 1.5, averagePromptTokens: 10000, averageGrade: 4 });
        const md = renderReport(run);
        expect(md).toMatch(/^# Evaluation: qwen3\.6\n/);
        expect(md).toContain('| 1 of 2 | 1 | 1.5 s | 10,000 tokens | 4 / 5 |');
        expect(md).toContain('## ✅ a\n\n**Q:** Question a?');
        expect(md).toContain('## ❌ b');
        expect(md).toContain('**Error:** timeout');
        expect(md).toContain('- Grade: 4 / 5: Good.');
        expect(md).toContain('1. `find_symbol({"query":"X"})`');

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-eval-'));
        try {
            const written = writeReport(dir, run);
            expect(path.basename(written)).toBe('2026-09-28T12-00-00-qwen3.6.md');
            expect(JSON.parse(fs.readFileSync(written.replace(/\.md$/, '.json'), 'utf8')).summary.passed).toBe(1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('compares two runs question by question', () => {
        const a = report('qwen3.6', [result('a', false, { promptTokens: 9000 }), result('b', true)]);
        const b = report('qwen3.6', [result('a', true, { promptTokens: 7000, toolCalls: [] }), result('c', true)]);
        const md = compareReports(a, b);
        expect(md).toContain('| A | 1 of 2 |');
        expect(md).toContain('| a | ❌ | ✅ | 1 → 0 | 9,000 → 7,000 | — → — |');
        expect(md).toContain('| b | ✅ | — | 1 → — |');
        expect(md).toContain('Only in B: c');
    });
});

/** A sample project with a caller, and the fake engine, for generating and running questions. */
describe('running an evaluation', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ue-llm-eval-run-'));
    let ctx: ToolContext;
    let engine: EngineProvider;

    beforeAll(async () => {
        const project = path.join(temp, 'SampleGame');
        copyFixture(SAMPLE_GAME, project);
        fs.writeFileSync(
            path.join(project, 'Source/SampleGame/Private/SampleGameMode.cpp'),
            '#include "SampleCharacter.h"\n\nvoid ASampleGameMode::HurtPlayer(ASampleCharacter* Player, FSampleStats& Stats)\n{\n\tPlayer->ApplyDamage(0.5f, Stats);\n}\n',
        );
        const index = new ProjectIndex(project);
        index.refresh(true);
        const install = locateEngine('', project, { override: FAKE_ENGINE }) as EngineInstall;
        await syncEngineIndex({ engineRoot: install.root, cacheDir: path.join(temp, 'cache'), jobs: 1 });
        engine = new EngineProvider({ project: index, cacheDir: path.join(temp, 'cache'), install });
        const memory = new MemoryStore(path.join(project, '.llm-memory'));
        memory.add({ text: 'Balance the damage numbers before the demo.', kind: 'task', about: [], fingerprints: {} });
        ctx = { project: index, engine, memory, limits: limitsFor() };
    });

    afterAll(() => {
        engine.dispose();
        fs.rmSync(temp, { recursive: true, force: true });
    });

    it('generates starter questions whose expectations come from the index', async () => {
        const questions = await generateQuestions(ctx);
        const byId = Object.fromEntries(questions.map(q => [q.id, q]));
        expect(byId['implementation-applydamage']).toMatchObject({
            question: 'Where is ASampleCharacter::ApplyDamage implemented, and what does it do?',
            expect: { mentions: ['SampleCharacter.cpp'], tools: ['read_symbol'] },
        });
        expect(questions.find(q => q.id.startsWith('module-'))?.expect?.mentions).toEqual(['SampleGame', 'Core', 'CoreUObject']);
        expect(byId['engine-base-asamplecharacter']).toMatchObject({ expect: { mentions: ['ACharacter', 'Character.h'] } });
        expect(byId['callers-applydamage']).toMatchObject({ question: 'Which functions call ASampleCharacter::ApplyDamage?', expect: { mentions: ['HurtPlayer'] } });
        expect(byId['memory-open-tasks']).toMatchObject({ expect: { mentions: ['Balance'] } });

        const file = JSON.parse(renderQuestionsFile(questions));
        expect(file.questions.at(-1)).toMatchObject({ id: 'your-question', reference: expect.stringContaining('Optional') });
        expect(parseQuestions(renderQuestionsFile(questions))).toHaveLength(questions.length + 1);
    });

    it('runs questions against an OpenAI-compatible endpoint through the MCP tools, with grading', async () => {
        const requests: any[] = [];
        const server = http.createServer((req, res) => {
            let raw = '';
            req.on('data', chunk => (raw += chunk));
            req.on('end', () => {
                const body = JSON.parse(raw);
                requests.push(body);
                const toolResult = body.messages.find((m: any) => m.role === 'tool');
                const message = !body.tools
                    ? { role: 'assistant', content: '{"score": 5, "reason": "Matches the reference."}' }
                    : toolResult
                      ? { role: 'assistant', content: `It is in SampleCharacter.cpp: ${toolResult.content.split('\n')[0]}` }
                      : { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_symbol', arguments: '{"name":"ApplyDamage"}' } }] };
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1000 * requests.length, completion_tokens: 10 } }));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const client = new Client({ name: 'test', version: '0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([createServer(ctx.project, { version: 'test', writeFiles: false, engine, memory: ctx.memory, readOnlyMemory: true }).connect(serverTransport), client.connect(clientTransport)]);
        try {
            const { tools } = await client.listTools();
            expect(tools.map(t => t.name)).not.toContain('remember');

            const questions = parseQuestions(
                JSON.stringify([{ id: 'where', question: 'Where is ApplyDamage implemented?', expect: { mentions: ['SampleCharacter.cpp'], tools: ['read_symbol'] }, reference: 'SampleCharacter.cpp' }]),
            );
            const run = await runEvalWithEndpoint({
                client,
                baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
                model: 'qwen-test',
                questions,
                project: ctx.project.root,
                grade: true,
            });
            expect(run).toMatchObject({ runner: 'cli', model: 'qwen-test', summary: { questions: 1, passed: 1, averageGrade: 5 } });
            expect(run.results[0]).toMatchObject({ pass: true, rounds: 2, promptTokens: 2000, promptTokensEstimated: false, toolCalls: ['read_symbol({"name":"ApplyDamage"})'] });
            expect(run.results[0].answer).toContain('// SampleCharacter.h:');
            expect(requests.at(-1).messages[0].content).toMatch(/^You grade answers/);
        } finally {
            await client.close();
            server.close();
        }
    });

    it('runs questions through @unreal with a VS Code chat model, without writing memory', async () => {
        const requests: any[] = [];
        const model = {
            name: 'Qwen 3.6',
            vendor: 'customendpoint',
            maxInputTokens: 200_000,
            async sendRequest(messages: any[], options: any) {
                requests.push({ messages: [...messages], options });
                const toolsOffered = options?.tools?.length;
                const hasResult = messages.some(m => m.content.some((p: any) => p.callId));
                const parts = !toolsOffered
                    ? [new LanguageModelTextPart('{"score": 3, "reason": "Partly right."}')]
                    : hasResult
                      ? [new LanguageModelTextPart('ApplyDamage is called from HurtPlayer.')]
                      : [new LanguageModelToolCallPart('c1', 'callers', { name: 'ASampleCharacter::ApplyDamage', scope: 'project' })];
                return { stream: (async function* () { yield* parts; })() };
            },
        };
        const progress: string[] = [];
        const run = await runEvalInChat({
            model: model as unknown as vscode.LanguageModelChat,
            questions: parseQuestions(JSON.stringify([{ id: 'callers', question: 'Who calls ApplyDamage?', expect: { mentions: ['HurtPlayer'], tools: ['callers'] }, reference: 'HurtPlayer' }])),
            project: ctx.project.root,
            toolContext: () => ctx,
            maxToolRounds: 5,
            grade: true,
            token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as unknown as vscode.CancellationToken,
            onProgress: (done, total, id) => progress.push(`${done}/${total} ${id}`),
        });
        expect(run).toMatchObject({ runner: 'vscode', model: 'Qwen 3.6 (customendpoint)', summary: { passed: 1, averageGrade: 3 } });
        expect(run.results[0]).toMatchObject({ answer: 'ApplyDamage is called from HurtPlayer.', promptTokensEstimated: true, rounds: 2 });
        expect(run.results[0].promptTokens).toBeGreaterThan(100);
        expect(requests[0].options.tools.map((t: any) => t.name)).not.toContain('remember');
        expect(progress).toEqual(['0/1 callers', '1/1 ']);
    });
});
