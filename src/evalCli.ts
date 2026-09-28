import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { TOOL_AGENT_PROMPT } from './agentInstructions';
import { runAgentLoop } from './agentLoop';
import { checkAnswer, EvalQuestion, EvalReport, EvalResult, gradingPrompt, parseGrade, summarize } from './eval';

export interface EndpointEvalOptions {
    /** A client connected to `ue-llm-index serve` for the project. */
    client: Pick<Client, 'listTools' | 'callTool'>;
    baseUrl: string;
    model: string;
    apiKey?: string;
    questions: EvalQuestion[];
    project: string;
    /** Score answers that have a reference, with the same model. */
    grade?: boolean;
    maxSteps?: number;
    config?: EvalReport['config'];
    log?(line: string): void;
}

const label = (name: string, args: Record<string, unknown>) => {
    const json = JSON.stringify(args);
    return `${name}(${json.length > 80 ? `${json.slice(0, 77)}...` : json})`;
};

/** One chat completion without tools, for grading. */
async function complete(options: EndpointEvalOptions, prompt: string): Promise<string> {
    const response = await fetch(`${options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) },
        body: JSON.stringify({ model: options.model, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) {
        throw new Error(`grading request returned ${response.status}`);
    }
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
}

/** Runs each question through the model and the MCP tools, as agent-smoke does, and checks the answers. */
export async function runEvalWithEndpoint(options: EndpointEvalOptions): Promise<EvalReport> {
    const log = options.log ?? (() => undefined);
    const results: EvalResult[] = [];
    for (const [i, question] of options.questions.entries()) {
        log(`[${i + 1}/${options.questions.length}] ${question.id}`);
        const started = Date.now();
        try {
            const run = await runAgentLoop({
                client: options.client,
                baseUrl: options.baseUrl,
                model: options.model,
                apiKey: options.apiKey,
                systemPrompt: TOOL_AGENT_PROMPT,
                question: question.question,
                maxSteps: options.maxSteps ?? 15,
            });
            const answer = run.answer ?? '';
            const toolCalls = run.toolCalls.map(c => label(c.name, c.args));
            const checks = checkAnswer(question, answer, toolCalls);
            if (run.answer === undefined) {
                checks.push({ name: `finishes within ${options.maxSteps ?? 15} model requests`, pass: false });
            }
            let grade: EvalResult['grade'];
            if (options.grade && question.reference) {
                grade = parseGrade(await complete(options, gradingPrompt(question, answer)));
            }
            results.push({
                id: question.id,
                question: question.question,
                answer,
                toolCalls,
                rounds: run.steps,
                ms: Date.now() - started,
                promptTokens: run.maxPromptTokens,
                promptTokensEstimated: false,
                checks,
                pass: checks.every(c => c.pass),
                grade,
            });
        } catch (e: any) {
            results.push({
                id: question.id,
                question: question.question,
                answer: '',
                toolCalls: [],
                rounds: 0,
                ms: Date.now() - started,
                checks: [],
                pass: false,
                error: String(e?.message ?? e),
            });
        }
        const last = results[results.length - 1];
        log(`    ${last.pass ? 'pass' : 'FAIL'} · ${last.toolCalls.length} tool calls · ${(last.ms / 1000).toFixed(1)} s${last.error ? ` · ${last.error}` : ''}`);
    }
    return {
        kit: 1,
        createdAt: new Date().toISOString(),
        runner: 'cli',
        model: options.model,
        project: options.project,
        config: options.config ?? {},
        summary: summarize(results),
        results,
    };
}
