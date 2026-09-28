import * as fs from 'fs';
import * as vscode from 'vscode';
import { TOOL_AGENT_PROMPT } from './agentInstructions';
import { capOutput, runTool, ToolContext, toolJsonSchema, TOOLS } from './tools';

export const PARTICIPANT_ID = 'unrealLlmIndex.unreal';

/** Conservative for code: budgets are computed with fewer characters per token than outlines average. */
const CHARS_PER_TOKEN = 3;
/** Older tool results are elided once the conversation passes this share of the model's input limit. */
const ELIDE_AT = 0.7;
/** The share of the input limit the project map may take in the first message. */
const INDEX_SHARE = 0.3;

export interface ParticipantDeps {
    /** Tools for the project the request is about, or undefined when no Unreal project is open. */
    toolContext(request: vscode.ChatRequest): ToolContext | undefined;
    maxToolRounds(): number;
}

type Message = vscode.LanguageModelChatMessage;

interface ToolResultRef {
    message: number;
    part: number;
    call: string;
    elided?: boolean;
}

export function registerUnrealParticipant(deps: ParticipantDeps): vscode.Disposable {
    const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, (request, context, stream, token) => handleChatRequest(request, context, stream, token, deps));
    participant.iconPath = new vscode.ThemeIcon('book');
    return participant;
}

const partChars = (part: unknown): number => {
    if (part instanceof vscode.LanguageModelTextPart) {
        return part.value.length;
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
        return part.content.reduce((n: number, p) => n + partChars(p), 0);
    }
    if (part instanceof vscode.LanguageModelToolCallPart) {
        return part.name.length + JSON.stringify(part.input).length;
    }
    return 0;
};

export const messageChars = (message: Message) => message.content.reduce((n: number, p) => n + partChars(p), 0);

/** Replaces the oldest tool results with a note until the conversation fits in `maxChars`. */
export function elideToolResults(messages: Message[], results: ToolResultRef[], maxChars: number): number {
    let total = messages.reduce((n, m) => n + messageChars(m), 0);
    let elided = 0;
    for (const ref of results) {
        if (total <= maxChars) {
            break;
        }
        if (ref.elided) {
            continue;
        }
        const parts = [...messages[ref.message].content];
        const original = parts[ref.part];
        if (!(original instanceof vscode.LanguageModelToolResultPart)) {
            continue;
        }
        const note = new vscode.LanguageModelToolResultPart(original.callId, [
            new vscode.LanguageModelTextPart(`[Result removed to save context. Call ${ref.call} again if you still need it.]`),
        ]);
        parts[ref.part] = note;
        messages[ref.message] = vscode.LanguageModelChatMessage.User(parts as vscode.LanguageModelToolResultPart[]);
        total -= partChars(original) - partChars(note);
        ref.elided = true;
        elided++;
    }
    return elided;
}

/** Earlier turns with this participant, as text: tool calls and results are not kept between requests. */
export function historyMessages(context: vscode.ChatContext): Message[] {
    const messages: Message[] = [];
    for (const turn of context.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
            messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
            const text = turn.response
                .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
                .map(p => p.value.value)
                .join('');
            if (text) {
                messages.push(vscode.LanguageModelChatMessage.Assistant(text));
            }
        }
    }
    return messages;
}

/** The prompt plus the text of files or selections attached with #file or drag and drop. */
function promptWithReferences(request: vscode.ChatRequest, maxChars: number): string {
    const parts = [request.prompt];
    for (const ref of request.references) {
        try {
            const value = ref.value;
            if (value instanceof vscode.Uri) {
                parts.push(`Attached file ${value.fsPath}:\n\`\`\`\n${capOutput(fs.readFileSync(value.fsPath, 'utf8'), 'Use read_lines for the rest.', maxChars)}\n\`\`\``);
            } else if (value instanceof vscode.Location) {
                const lines = fs.readFileSync(value.uri.fsPath, 'utf8').split(/\r?\n/).slice(value.range.start.line, value.range.end.line + 1);
                parts.push(`Attached ${value.uri.fsPath}:${value.range.start.line + 1}-${value.range.end.line + 1}:\n\`\`\`\n${capOutput(lines.join('\n'), 'Use read_lines for the rest.', maxChars)}\n\`\`\``);
            } else if (typeof value === 'string') {
                parts.push(value);
            }
        } catch {
            // An unreadable attachment is skipped
        }
    }
    return parts.join('\n\n');
}

const describeCall = (call: vscode.LanguageModelToolCallPart) => {
    const args = JSON.stringify(call.input ?? {});
    return `${call.name}(${args.length > 80 ? `${args.slice(0, 77)}...` : args})`;
};

/** CamelCase identifiers and qualified names in a prompt, for when the model can't call tools itself. */
export function identifiersIn(prompt: string): string[] {
    const found = prompt.match(/\b[A-Za-z_]\w*(?:::[A-Za-z_]\w*)+|\b[A-Z][a-z0-9]*[A-Z]\w*\b/g) ?? [];
    return [...new Set(found)].slice(0, 5);
}

function isToolSupportError(e: unknown): boolean {
    return /tool/i.test(String((e as Error)?.message ?? e)) && !(e instanceof vscode.CancellationError);
}

function errorResult(e: unknown, stream: vscode.ChatResponseStream): vscode.ChatResult {
    if (e instanceof vscode.CancellationError) {
        return {};
    }
    const message = e instanceof vscode.LanguageModelError ? `${e.message} (${e.code})` : String((e as Error)?.message ?? e);
    stream.markdown(`\n\nThe language model request failed: ${message}`);
    return { errorDetails: { message } };
}

export async function handleChatRequest(
    request: vscode.ChatRequest,
    context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    deps: ParticipantDeps,
): Promise<vscode.ChatResult> {
    const base = deps.toolContext(request);
    if (!base) {
        stream.markdown('No Unreal Engine project (.uproject) is open in this workspace, so @unreal has nothing to look up.');
        return {};
    }
    const model = request.model;
    const budget = model.maxInputTokens * CHARS_PER_TOKEN;
    const referenced = new Set<string>();
    const ctx: ToolContext = {
        ...base,
        onRead: (file, start, end) => {
            const key = `${file}:${start}-${end}`;
            if (!referenced.has(key)) {
                referenced.add(key);
                stream.reference(new vscode.Location(vscode.Uri.file(file), new vscode.Range(start - 1, 0, Math.max(start, end) - 1, 0)));
            }
        },
    };

    const index = await runTool('get_index', {}, base);
    const map = capOutput(index.text, 'Call get_module_outline or find_symbol for more.', Math.floor(budget * INDEX_SHARE));
    const messages: Message[] = [
        vscode.LanguageModelChatMessage.User(`${TOOL_AGENT_PROMPT}\n\nThe project index (what get_index returns):\n\n${map}`),
        vscode.LanguageModelChatMessage.Assistant('I have the project index and will look up what I need with the tools.'),
        ...historyMessages(context),
        vscode.LanguageModelChatMessage.User(promptWithReferences(request, base.limits.maxChars)),
    ];
    const tools: vscode.LanguageModelChatTool[] = TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: toolJsonSchema(t) }));
    const results: ToolResultRef[] = [];
    const calls: string[] = [];
    let useTools = true;
    const maxRounds = Math.max(1, deps.maxToolRounds());

    for (let round = 1; round <= maxRounds; round++) {
        elideToolResults(messages, results, budget * ELIDE_AT);
        let response: vscode.LanguageModelChatResponse;
        try {
            response = await model.sendRequest(messages, useTools ? { tools, justification: 'Look up code in the Unreal LLM Index' } : {}, token);
        } catch (e) {
            if (useTools && round === 1 && isToolSupportError(e)) {
                // The model can't call tools: answer from the index plus lookups of the names in the question
                useTools = false;
                const lookups: string[] = [];
                for (const name of identifiersIn(request.prompt)) {
                    lookups.push(`find_symbol("${name}"):\n${(await runTool('find_symbol', { query: name, limit: 5 }, ctx)).text}`);
                }
                const last = messages.length - 1;
                messages[last] = vscode.LanguageModelChatMessage.User(
                    `${promptWithReferences(request, base.limits.maxChars)}\n\n(The model cannot call tools, so here are lookups of names in the question.)\n\n${lookups.join('\n\n')}`,
                );
                stream.progress('This model cannot call tools; answering from the index');
                round--;
                continue;
            }
            return errorResult(e, stream);
        }

        const text: string[] = [];
        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        try {
            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    stream.markdown(part.value);
                    text.push(part.value);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                }
            }
        } catch (e) {
            return errorResult(e, stream);
        }
        if (!toolCalls.length || token.isCancellationRequested) {
            return { metadata: { rounds: round, toolCalls: calls } };
        }

        messages.push(vscode.LanguageModelChatMessage.Assistant([...(text.length ? [new vscode.LanguageModelTextPart(text.join(''))] : []), ...toolCalls]));
        const parts: vscode.LanguageModelToolResultPart[] = [];
        for (const call of toolCalls) {
            const label = describeCall(call);
            stream.progress(label);
            calls.push(label);
            const result = await runTool(call.name, call.input, ctx);
            parts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result.text)]));
        }
        messages.push(vscode.LanguageModelChatMessage.User(parts));
        parts.forEach((_, i) => results.push({ message: messages.length - 1, part: i, call: calls[calls.length - parts.length + i] }));
    }
    stream.markdown(`\n\n_Stopped after ${maxRounds} rounds of tool calls. Ask a narrower question, or raise \`unrealLlmIndex.chat.maxToolRounds\`._`);
    return { metadata: { rounds: maxRounds, toolCalls: calls } };
}
