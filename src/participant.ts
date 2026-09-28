import * as fs from 'fs';
import * as vscode from 'vscode';
import { TOOL_AGENT_PROMPT } from './agentInstructions';
import { MEMORY_DIR, MemoryNote, MemoryStore, noteLine } from './memory';
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
            // Tool results aren't kept between turns; list what was read so it can be fetched again
            const read: unknown = turn.result.metadata?.read;
            const looked = Array.isArray(read) && read.length ? `\n\n(Looked at: ${read.join(', ')})` : '';
            if (text || looked) {
                messages.push(vscode.LanguageModelChatMessage.Assistant(text + looked));
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

/** Everything in project memory, open tasks first: the `/memory` command. */
export function renderMemoryOverview(ctx: ToolContext, store: MemoryStore): string {
    const notes = store.list();
    if (!notes.length) {
        return `Project memory is empty. Notes appear in \`${MEMORY_DIR}/\` when the model saves decisions, facts, gotchas and tasks, or when you run \`@unreal /save\`.`;
    }
    const groups: [string, MemoryNote[]][] = [
        ['Open tasks', notes.filter(n => n.kind === 'task' && n.status !== 'done')],
        ['Decisions', notes.filter(n => n.kind === 'decision')],
        ['Gotchas', notes.filter(n => n.kind === 'gotcha')],
        ['Facts', notes.filter(n => n.kind === 'fact')],
        ['Summaries', notes.filter(n => n.kind === 'summary')],
        ['Finished tasks', notes.filter(n => n.kind === 'task' && n.status === 'done')],
    ];
    const out = [`**Project memory**: ${notes.length} notes in \`${MEMORY_DIR}/\``];
    for (const [title, group] of groups.filter(([, g]) => g.length)) {
        out.push('', `**${title}**`, ...group.slice(0, 25).map(n => noteLine(ctx, n, 300)));
        if (group.length > 25) {
            out.push(`- … ${group.length - 25} more`);
        }
    }
    return out.join('\n');
}

const SAVE_PROMPT = [
    'Save what this conversation established to project memory, so later sessions start from it.',
    'First call recall to see what is already saved. Then, for each decision made, non-obvious fact learned about the code, gotcha found, or task left unfinished,',
    'call remember with one self-contained note of one or two sentences, attached to the symbols or files it is about.',
    'Update notes that changed with update_note instead of adding duplicates, and mark finished tasks done.',
    'Skip anything obvious from the code itself. Finish with one line saying what you saved.',
].join(' ');

const MEMORY_TOOLS = new Set(['recall', 'remember', 'update_note']);
const WRITE_TOOLS = new Set(['remember', 'update_note', 'forget']);

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
    const command = request.command;
    if ((command === 'memory' || command === 'save') && !base.memory) {
        stream.markdown('Project memory is off. Turn on `unrealLlmIndex.memory.enabled` to keep notes across sessions.');
        return {};
    }
    if (command === 'memory') {
        stream.markdown(renderMemoryOverview(base, base.memory!));
        return { metadata: { command } };
    }

    const model = request.model;
    const budget = model.maxInputTokens * CHARS_PER_TOKEN;
    const referenced = new Set<string>();
    const read: string[] = [];
    const ctx: ToolContext = {
        ...base,
        source: '@unreal',
        onRead: (file, start, end, label) => {
            const key = `${file}:${start}-${end}`;
            if (!referenced.has(key)) {
                referenced.add(key);
                read.push(label);
                stream.reference(new vscode.Location(vscode.Uri.file(file), new vscode.Range(start - 1, 0, Math.max(start, end) - 1, 0)));
            }
        },
    };

    const index = await runTool('get_index', {}, base);
    const map = capOutput(index.text, 'Call get_module_outline or find_symbol for more.', Math.floor(budget * INDEX_SHARE));
    const prompt = command === 'save' ? `${SAVE_PROMPT}${request.prompt.trim() ? `\n\nThe user adds: ${request.prompt.trim()}` : ''}` : promptWithReferences(request, base.limits.maxChars);
    const messages: Message[] = [
        vscode.LanguageModelChatMessage.User(`${TOOL_AGENT_PROMPT}\n\nThe project index (what get_index returns):\n\n${map}`),
        vscode.LanguageModelChatMessage.Assistant('I have the project index and will look up what I need with the tools.'),
        ...historyMessages(context),
        vscode.LanguageModelChatMessage.User(prompt),
    ];
    const tools: vscode.LanguageModelChatTool[] = TOOLS.filter(t => command !== 'save' || MEMORY_TOOLS.has(t.name)).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: toolJsonSchema(t),
    }));
    const results: ToolResultRef[] = [];
    const calls: string[] = [];
    const saved: string[] = [];
    let useTools = true;
    const maxRounds = Math.max(1, deps.maxToolRounds());
    const finish = (rounds: number): vscode.ChatResult => {
        if (command === 'save') {
            stream.markdown(saved.length ? `\n\n_${saved.length} note${saved.length > 1 ? 's' : ''} saved to \`${MEMORY_DIR}/\`._` : '\n\n_Nothing new was saved._');
        }
        return { metadata: { rounds, toolCalls: calls, read: read.slice(0, 30) } };
    };

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
            return finish(round);
        }

        messages.push(vscode.LanguageModelChatMessage.Assistant([...(text.length ? [new vscode.LanguageModelTextPart(text.join(''))] : []), ...toolCalls]));
        const parts: vscode.LanguageModelToolResultPart[] = [];
        for (const call of toolCalls) {
            const label = describeCall(call);
            stream.progress(label);
            calls.push(label);
            const result = await runTool(call.name, call.input, ctx);
            if (WRITE_TOOLS.has(call.name) && !result.isError) {
                // Memory changes are shown, since @unreal doesn't ask before running tools
                stream.markdown(`\n\n> 📝 ${result.text}\n\n`);
                if (call.name === 'remember') {
                    saved.push(result.text);
                }
            }
            parts.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(result.text)]));
        }
        messages.push(vscode.LanguageModelChatMessage.User(parts));
        parts.forEach((_, i) => results.push({ message: messages.length - 1, part: i, call: calls[calls.length - parts.length + i] }));
    }
    stream.markdown(`\n\n_Stopped after ${maxRounds} rounds of tool calls. Ask a narrower question, or raise \`unrealLlmIndex.chat.maxToolRounds\`._`);
    return finish(maxRounds);
}
