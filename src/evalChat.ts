import * as vscode from 'vscode';
import { checkAnswer, EvalQuestion, EvalReport, EvalResult, gradingPrompt, parseGrade, summarize } from './eval';
import { handleChatRequest } from './participant';
import { ToolContext } from './tools';

export interface ChatEvalOptions {
    model: vscode.LanguageModelChat;
    questions: EvalQuestion[];
    project: string;
    toolContext(request: vscode.ChatRequest): ToolContext | undefined;
    maxToolRounds: number;
    grade?: boolean;
    config?: EvalReport['config'];
    token: vscode.CancellationToken;
    onProgress?(done: number, total: number, id: string): void;
}

/** A response stream that keeps the answer text and ignores the rest. */
function collectingStream(): { stream: vscode.ChatResponseStream; text: () => string } {
    const parts: string[] = [];
    const ignore = () => undefined;
    const stream = {
        markdown: (value: string | vscode.MarkdownString) => parts.push(typeof value === 'string' ? value : value.value),
        progress: ignore,
        reference: ignore,
        anchor: ignore,
        button: ignore,
        filetree: ignore,
        push: ignore,
    };
    return { stream: stream as unknown as vscode.ChatResponseStream, text: () => parts.join('') };
}

async function ask(model: vscode.LanguageModelChat, prompt: string, token: vscode.CancellationToken): Promise<string> {
    const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
    let text = '';
    for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
            text += part.value;
        }
    }
    return text;
}

/**
 * Runs each question through @unreal with a VS Code chat model, such as a self-hosted model added
 * as a Custom Endpoint, so no endpoint details are needed. Memory is read but never written.
 */
export async function runEvalInChat(options: ChatEvalOptions): Promise<EvalReport> {
    const results: EvalResult[] = [];
    for (const [i, question] of options.questions.entries()) {
        if (options.token.isCancellationRequested) {
            break;
        }
        options.onProgress?.(i, options.questions.length, question.id);
        const started = Date.now();
        const { stream, text } = collectingStream();
        const request = {
            prompt: question.question,
            command: undefined,
            references: [],
            toolReferences: [],
            toolInvocationToken: undefined,
            model: options.model,
        } as unknown as vscode.ChatRequest;
        try {
            const result = await handleChatRequest(request, { history: [] } as unknown as vscode.ChatContext, stream, options.token, {
                toolContext: options.toolContext,
                maxToolRounds: () => options.maxToolRounds,
                readOnlyMemory: true,
            });
            const answer = text();
            const toolCalls: string[] = result.metadata?.toolCalls ?? [];
            const checks = checkAnswer(question, answer, toolCalls);
            let grade: EvalResult['grade'];
            if (options.grade && question.reference && !result.errorDetails) {
                grade = parseGrade(await ask(options.model, gradingPrompt(question, answer), options.token));
            }
            results.push({
                id: question.id,
                question: question.question,
                answer,
                toolCalls,
                rounds: result.metadata?.rounds ?? 0,
                ms: Date.now() - started,
                promptTokens: result.metadata?.maxPromptTokens,
                promptTokensEstimated: true,
                checks,
                pass: !result.errorDetails && checks.every(c => c.pass),
                grade,
                error: result.errorDetails?.message,
            });
        } catch (e: any) {
            results.push({ id: question.id, question: question.question, answer: text(), toolCalls: [], rounds: 0, ms: Date.now() - started, checks: [], pass: false, error: String(e?.message ?? e) });
        }
    }
    options.onProgress?.(results.length, options.questions.length, '');
    return {
        kit: 1,
        createdAt: new Date().toISOString(),
        runner: 'vscode',
        model: `${options.model.name} (${options.model.vendor})`,
        project: options.project,
        config: options.config ?? {},
        summary: summarize(results),
        results,
    };
}
