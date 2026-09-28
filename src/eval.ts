import * as fs from 'fs';
import * as path from 'path';
import { qualifiedName } from './indexer';
import { isHeader } from './outline';
import { findReferences } from './references';
import type { ToolContext } from './tools';
import { CodeSymbol } from './types';

/**
 * The evaluation kit: a set of questions about a project, run through a model with the tools,
 * checked automatically, and reported so runs can be compared (another model, other settings,
 * a new version of the extension).
 */

export const EVAL_DIR = '.llm-eval';
export const QUESTIONS_FILE = 'questions.json';

export interface EvalExpectations {
    /** Words or names the answer must contain (case-insensitive). */
    mentions?: string[];
    /** Words the answer must not contain, e.g. a wrong class. */
    notMentions?: string[];
    /** Tools that must be called at least once. */
    tools?: string[];
    /** Most tool calls allowed. */
    maxToolCalls?: number;
}

export interface EvalQuestion {
    id: string;
    question: string;
    expect?: EvalExpectations;
    /** A model answer, for the optional grader. */
    reference?: string;
    /** Free text for people: why the question is there, what a good answer has. */
    note?: string;
}

export interface EvalCheck {
    name: string;
    pass: boolean;
    detail?: string;
}

export interface EvalResult {
    id: string;
    question: string;
    answer: string;
    toolCalls: string[];
    /** Model requests made. */
    rounds: number;
    ms: number;
    /** Largest prompt sent, in tokens. Estimated when the runner can't count them. */
    promptTokens?: number;
    promptTokensEstimated?: boolean;
    checks: EvalCheck[];
    pass: boolean;
    grade?: { score: number; reason: string };
    error?: string;
}

export interface EvalReport {
    kit: 1;
    createdAt: string;
    /** "vscode" (a VS Code chat model through @unreal) or "cli" (an OpenAI-compatible endpoint). */
    runner: 'vscode' | 'cli';
    model: string;
    project: string;
    /** Anything else that describes the run: extension version, settings, a label. */
    config: Record<string, string | number | boolean>;
    summary: {
        questions: number;
        passed: number;
        averageToolCalls: number;
        averageSeconds: number;
        averagePromptTokens?: number;
        averageGrade?: number;
    };
    results: EvalResult[];
}

// ---------------------------------------------------------------------------------------------
// Questions

/** Reads and checks a question file, with messages that say what to fix. */
export function parseQuestions(text: string, file = QUESTIONS_FILE): EvalQuestion[] {
    let json: any;
    try {
        json = JSON.parse(text.replace(/^﻿/, ''));
    } catch (e: any) {
        throw new Error(`${file} is not valid JSON: ${e.message}`);
    }
    const list = Array.isArray(json) ? json : json?.questions;
    if (!Array.isArray(list) || !list.length) {
        throw new Error(`${file} needs a "questions" list with at least one question.`);
    }
    const ids = new Set<string>();
    return list.map((q: any, i: number) => {
        const where = `${file}, question ${i + 1}`;
        if (typeof q?.question !== 'string' || !q.question.trim()) {
            throw new Error(`${where} has no "question" text.`);
        }
        const id = typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `q${i + 1}`;
        if (ids.has(id)) {
            throw new Error(`${where}: the id "${id}" is used twice.`);
        }
        ids.add(id);
        const expect = q.expect ?? {};
        const strings = (value: unknown, name: string) => {
            if (value === undefined) {
                return undefined;
            }
            if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
                throw new Error(`${where}: expect.${name} must be a list of strings.`);
            }
            return value as string[];
        };
        if (expect.maxToolCalls !== undefined && (!Number.isInteger(expect.maxToolCalls) || expect.maxToolCalls < 0)) {
            throw new Error(`${where}: expect.maxToolCalls must be a whole number.`);
        }
        return {
            id,
            question: q.question.trim(),
            expect: {
                mentions: strings(expect.mentions, 'mentions'),
                notMentions: strings(expect.notMentions, 'notMentions'),
                tools: strings(expect.tools, 'tools'),
                maxToolCalls: expect.maxToolCalls,
            },
            reference: typeof q.reference === 'string' && q.reference.trim() ? q.reference.trim() : undefined,
            note: typeof q.note === 'string' ? q.note : undefined,
        };
    });
}

export function loadQuestions(file: string): EvalQuestion[] {
    return parseQuestions(fs.readFileSync(file, 'utf8'), path.basename(file));
}

// ---------------------------------------------------------------------------------------------
// Checking and grading

/** The name of the tool in a call label like 'find_symbol({"query":"X"})'. */
export const toolName = (call: string) => call.replace(/\(.*$/s, '');

export function checkAnswer(question: EvalQuestion, answer: string, toolCalls: string[]): EvalCheck[] {
    const checks: EvalCheck[] = [];
    const text = answer.toLowerCase();
    const expect = question.expect ?? {};
    for (const word of expect.mentions ?? []) {
        checks.push({ name: `mentions "${word}"`, pass: text.includes(word.toLowerCase()) });
    }
    for (const word of expect.notMentions ?? []) {
        checks.push({ name: `doesn't mention "${word}"`, pass: !text.includes(word.toLowerCase()) });
    }
    const used = new Set(toolCalls.map(toolName));
    for (const tool of expect.tools ?? []) {
        checks.push({ name: `calls ${tool}`, pass: used.has(tool) });
    }
    if (expect.maxToolCalls !== undefined) {
        checks.push({ name: `at most ${expect.maxToolCalls} tool calls`, pass: toolCalls.length <= expect.maxToolCalls, detail: `${toolCalls.length} calls` });
    }
    if (!answer.trim()) {
        checks.push({ name: 'gives an answer', pass: false });
    }
    return checks;
}

/** The grader's prompt: compare an answer with the reference and score it 1 to 5. */
export function gradingPrompt(question: EvalQuestion, answer: string): string {
    return [
        'You grade answers to questions about an Unreal Engine C++ codebase.',
        'Compare the candidate answer with the reference answer. Judge correctness and completeness of the facts, not style or length.',
        'Score 5: all key facts right. 4: minor omissions. 3: partly right. 2: mostly wrong or missing key facts. 1: wrong or no answer.',
        'Reply with only JSON: {"score": <1-5>, "reason": "<one sentence>"}',
        '',
        `Question: ${question.question}`,
        '',
        `Reference answer:\n${question.reference}`,
        '',
        `Candidate answer:\n${answer || '(no answer)'}`,
    ].join('\n');
}

/** Reads the grader's reply; tolerates text or code fences around the JSON. */
export function parseGrade(reply: string): { score: number; reason: string } | undefined {
    const json = /\{[\s\S]*\}/.exec(reply)?.[0];
    if (!json) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(json);
        const score = Number(parsed.score);
        if (!Number.isFinite(score) || score < 1 || score > 5) {
            return undefined;
        }
        return { score: Math.round(score), reason: String(parsed.reason ?? '').trim() };
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------------------------
// Reports

const average = (values: number[]) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : 0);

export function summarize(results: EvalResult[]): EvalReport['summary'] {
    const tokens = results.map(r => r.promptTokens).filter((n): n is number => n !== undefined);
    const grades = results.map(r => r.grade?.score).filter((n): n is number => n !== undefined);
    return {
        questions: results.length,
        passed: results.filter(r => r.pass).length,
        averageToolCalls: average(results.map(r => r.toolCalls.length)),
        averageSeconds: average(results.map(r => r.ms / 1000)),
        averagePromptTokens: tokens.length ? Math.round(average(tokens)) : undefined,
        averageGrade: grades.length ? average(grades) : undefined,
    };
}

const quote = (text: string) => text.trim().split('\n').map(l => `> ${l}`).join('\n');

export function renderReport(report: EvalReport): string {
    const s = report.summary;
    const estimated = report.results.some(r => r.promptTokensEstimated) ? ' (estimated)' : '';
    const out = [
        `# Evaluation: ${report.model}`,
        '',
        `${report.createdAt.slice(0, 16).replace('T', ' ')} UTC · ${report.runner === 'vscode' ? 'VS Code chat model, through @unreal' : 'OpenAI-compatible endpoint, through the MCP tools'} · ${report.project}`,
        '',
        '| Passed | Avg. tool calls | Avg. time | Avg. largest prompt | Avg. grade |',
        '|---|---|---|---|---|',
        `| ${s.passed} of ${s.questions} | ${s.averageToolCalls} | ${s.averageSeconds} s | ${s.averagePromptTokens !== undefined ? `${s.averagePromptTokens.toLocaleString('en-US')} tokens${estimated}` : '—'} | ${s.averageGrade !== undefined ? `${s.averageGrade} / 5` : '—'} |`,
    ];
    const config = Object.entries(report.config);
    if (config.length) {
        out.push('', `Settings: ${config.map(([k, v]) => `${k} = ${v}`).join(', ')}`);
    }
    for (const r of report.results) {
        out.push('', `## ${r.pass ? '✅' : '❌'} ${r.id}`, '', `**Q:** ${r.question}`, '');
        if (r.error) {
            out.push(`**Error:** ${r.error}`, '');
        }
        for (const c of r.checks) {
            out.push(`- ${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
        }
        if (r.grade) {
            out.push(`- Grade: ${r.grade.score} / 5: ${r.grade.reason}`);
        }
        const tokens = r.promptTokens !== undefined ? `, largest prompt ${Math.round(r.promptTokens).toLocaleString('en-US')} tokens${r.promptTokensEstimated ? ' (estimated)' : ''}` : '';
        out.push('', `${r.toolCalls.length} tool calls, ${r.rounds} model requests, ${(r.ms / 1000).toFixed(1)} s${tokens}`);
        if (r.toolCalls.length) {
            out.push('', ...r.toolCalls.map((c, i) => `${i + 1}. \`${c}\``));
        }
        out.push('', quote(r.answer || '(no answer)'));
    }
    return out.join('\n') + '\n';
}

/** Writes <dir>/<timestamp>-<model>.json and .md, and returns the Markdown path. */
export function writeReport(dir: string, report: EvalReport): string {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = report.createdAt.replace(/[:.]/g, '-').slice(0, 19);
    const base = path.join(dir, `${stamp}-${report.model.replace(/[^\w.-]+/g, '_').slice(0, 40)}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    fs.writeFileSync(`${base}.md`, renderReport(report));
    return `${base}.md`;
}

/** Two runs side by side, question by question. */
export function compareReports(a: EvalReport, b: EvalReport): string {
    const label = (r: EvalReport) => `${r.model} (${r.createdAt.slice(0, 16).replace('T', ' ')}${r.config.label ? `, ${r.config.label}` : ''})`;
    const byId = new Map(b.results.map(r => [r.id, r]));
    const mark = (r?: EvalResult) => (r ? (r.pass ? '✅' : '❌') : '—');
    const num = (n?: number) => (n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));
    const out = [
        '# Evaluation comparison',
        '',
        `A: ${label(a)}  `,
        `B: ${label(b)}`,
        '',
        '| | Passed | Avg. tool calls | Avg. time | Avg. largest prompt | Avg. grade |',
        '|---|---|---|---|---|---|',
        ...[a, b].map((r, i) => {
            const s = r.summary;
            return `| ${i ? 'B' : 'A'} | ${s.passed} of ${s.questions} | ${s.averageToolCalls} | ${s.averageSeconds} s | ${num(s.averagePromptTokens)} | ${s.averageGrade ?? '—'} |`;
        }),
        '',
        '| Question | A | B | Tool calls A → B | Largest prompt A → B | Grade A → B |',
        '|---|---|---|---|---|---|',
    ];
    for (const ra of a.results) {
        const rb = byId.get(ra.id);
        out.push(
            `| ${ra.id} | ${mark(ra)} | ${mark(rb)} | ${ra.toolCalls.length} → ${rb ? rb.toolCalls.length : '—'} | ${num(ra.promptTokens)} → ${num(rb?.promptTokens)} | ${ra.grade?.score ?? '—'} → ${rb?.grade?.score ?? '—'} |`,
        );
    }
    const onlyB = b.results.filter(r => !a.results.some(x => x.id === r.id));
    if (onlyB.length) {
        out.push('', `Only in B: ${onlyB.map(r => r.id).join(', ')}`);
    }
    return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// A starter question set

const basename = (file: string) => file.split('/').pop() ?? file;

/**
 * Questions about the project, with expectations taken from its index. They check that the model
 * uses the tools and reports what the code says; replace or extend them with your own questions.
 */
export async function generateQuestions(ctx: ToolContext, max = 8): Promise<EvalQuestion[]> {
    const project = ctx.project;
    const questions: EvalQuestion[] = [];
    const types = project.allSymbols().filter(s => ['class', 'struct'].includes(s.kind) && isHeader(s.file));

    // Implementations: a method declared in a header and defined in a .cpp
    const implemented = project
        .allSymbols()
        // Plain methods: not constructors, destructors or operators
        .filter(s => s.kind === 'function' && !s.isDefinition && s.definitions?.length && s.container && s.name !== basename(s.container) && /^[A-Za-z_]\w*$/.test(s.name));
    for (const fn of implemented.slice(0, 3)) {
        const def = fn.definitions![0];
        questions.push({
            id: `implementation-${fn.name.toLowerCase()}`,
            question: `Where is ${qualifiedName(fn)} implemented, and what does it do?`,
            expect: { mentions: [basename(def.file)], tools: ['read_symbol'] },
            note: `Generated: the answer should point to ${def.file}:${def.startLine} and describe the body.`,
        });
    }

    // Modules
    const typeWithModule = types.find(t => project.moduleOf(t.file));
    if (typeWithModule) {
        const module = project.moduleOf(typeWithModule.file)!;
        questions.push({
            id: `module-${typeWithModule.name.toLowerCase()}`,
            question: `Which module declares ${typeWithModule.name}, and which modules does that module depend on?`,
            expect: { mentions: [module.name, ...module.publicDeps.slice(0, 2)] },
            note: 'Generated: answerable from get_index alone.',
        });
    }

    // Engine base classes
    const engine = ctx.engine?.state();
    if (engine && 'handle' in engine) {
        const handle = engine.handle;
        for (const t of types) {
            const base = t.bases?.map(b => b.replace(/<.*$/, '')).find(b => !project.resolveSymbol(b).length && handle.index.resolveSymbol(b).some(s => ['class', 'struct'].includes(s.kind)));
            if (base) {
                const declared = handle.index.resolveSymbol(base).find(s => ['class', 'struct'].includes(s.kind))!;
                questions.push({
                    id: `engine-base-${t.name.toLowerCase()}`,
                    question: `Which engine class does ${t.name} derive from, and in which engine file is that class declared?`,
                    expect: { mentions: [base, basename(declared.file)] },
                    note: `Generated: ${base} is declared in ${declared.file}.`,
                });
                break;
            }
        }
    }

    // Callers
    for (const fn of implemented.slice(0, 10)) {
        const result = await findReferences(ctx, qualifiedName(fn), { scope: 'project' });
        if ('error' in result) {
            continue;
        }
        const callers = [...new Set(result.hits.filter(h => h.kind === 'call' && h.likely && h.enclosing).map(h => h.enclosing!.name.split('::').pop()!))];
        if (callers.length) {
            questions.push({
                id: `callers-${fn.name.toLowerCase()}`,
                question: `Which functions call ${qualifiedName(fn)}?`,
                expect: { mentions: callers.slice(0, 3) },
                note: 'Generated: find_references or callers should find these.',
            });
            break;
        }
    }

    // Project memory
    const openTask = ctx.memory?.list().find(n => n.kind === 'task' && n.status !== 'done');
    if (openTask) {
        const word = openTask.text.split(/\s+/).find(w => w.length > 5) ?? openTask.text.split(/\s+/)[0];
        questions.push({
            id: 'memory-open-tasks',
            question: 'What open tasks are recorded for this project?',
            expect: { mentions: [word.replace(/[^\w-]/g, '')] },
            note: 'Generated: answerable from project memory in get_index.',
        });
    }
    return questions.slice(0, max);
}

/** The starter file: generated questions plus an example of every field, to edit. */
export function renderQuestionsFile(questions: EvalQuestion[], exampleSymbol?: CodeSymbol): string {
    const example: EvalQuestion = {
        id: 'your-question',
        question: exampleSymbol ? `Explain how ${qualifiedName(exampleSymbol)} works and what calls it.` : 'Ask something you need to know about this project.',
        expect: { mentions: ['a name the answer must contain'], notMentions: [], tools: ['find_references'], maxToolCalls: 15 },
        reference: 'Optional: a correct answer. With grading on, the model scores each answer against it from 1 to 5.',
        note: 'Replace the generated questions with ones from your real work: questions whose answers you know.',
    };
    return JSON.stringify({ questions: [...questions, example] }, null, 2) + '\n';
}
