import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/**
 * A minimal agent loop against any OpenAI-compatible chat completions endpoint
 * (hosted APIs, vLLM, LM Studio, llama.cpp server, Ollama, ...). Used to test the
 * index end to end without an editor.
 */

interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string | Record<string, unknown> };
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

interface ChatCompletion {
    choices?: { message?: ChatMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface AgentLoopOptions {
    client: Pick<Client, 'listTools' | 'callTool'>;
    /** Base URL including the version path, e.g. "https://api.example.com/v1". */
    baseUrl: string;
    model: string;
    apiKey?: string;
    systemPrompt: string;
    question: string;
    maxSteps?: number;
    log?: (line: string) => void;
}

export interface AgentLoopResult {
    answer?: string;
    steps: number;
    toolCalls: { name: string; args: Record<string, unknown> }[];
    maxPromptTokens?: number;
}

function parseArguments(raw: string | Record<string, unknown> | undefined): Record<string, unknown> {
    if (!raw) {
        return {};
    }
    if (typeof raw !== 'string') {
        return raw;
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
    const log = options.log ?? (() => undefined);
    const maxSteps = options.maxSteps ?? 10;
    const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const { tools } = await options.client.listTools();
    const openAiTools = tools.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema },
    }));

    const messages: ChatMessage[] = [
        { role: 'system', content: options.systemPrompt },
        { role: 'user', content: options.question },
    ];
    const result: AgentLoopResult = { steps: 0, toolCalls: [] };

    for (let step = 1; step <= maxSteps; step++) {
        result.steps = step;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
            },
            body: JSON.stringify({ model: options.model, messages, tools: openAiTools, tool_choice: 'auto' }),
        });
        if (!response.ok) {
            throw new Error(`${url} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
        }
        const data = (await response.json()) as ChatCompletion;
        const message = data.choices?.[0]?.message;
        if (!message) {
            throw new Error(`${url} returned no message`);
        }
        messages.push(message);

        const promptTokens = data.usage?.prompt_tokens;
        if (promptTokens !== undefined) {
            result.maxPromptTokens = Math.max(result.maxPromptTokens ?? 0, promptTokens);
        }
        log(`step ${step}: prompt ${promptTokens ?? '?'} tokens, completion ${data.usage?.completion_tokens ?? '?'} tokens`);

        if (!message.tool_calls?.length) {
            result.answer = message.content ?? '';
            return result;
        }

        for (const call of message.tool_calls) {
            let text: string;
            try {
                const args = parseArguments(call.function.arguments);
                result.toolCalls.push({ name: call.function.name, args });
                log(`  -> ${call.function.name}(${JSON.stringify(args)})`);
                const toolResult = await options.client.callTool({ name: call.function.name, arguments: args });
                text = (toolResult.content as { type: string; text?: string }[])
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
                log(`     ${toolResult.isError ? 'ERROR ' : ''}${text.length} chars: ${text.split('\n')[0].slice(0, 100)}`);
            } catch (e: any) {
                text = `Error: ${e.message ?? e}`;
                log(`     ${text}`);
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: text });
        }
    }
    return result;
}
