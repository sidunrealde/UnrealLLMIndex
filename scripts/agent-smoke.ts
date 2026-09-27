/**
 * Minimal agent loop for testing the index end to end with a local Ollama model:
 * starts the MCP server, exposes its tools to the model, and prints each tool call.
 *
 *   node dist/agent-smoke.js --project <dir> [--model qwen2.5:7b] [--ctx 32768] "question"
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'path';
import rules from '../templates/rules/unreal-llm-index.md';

interface ToolCall {
    function: { name: string; arguments: Record<string, unknown> };
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_name?: string;
}

const USAGE =
    'Usage: node dist/agent-smoke.js --project <dir> [--model qwen2.5:7b] [--ctx 32768] [--steps 10] [--host http://localhost:11434] "question"';

function parseArgs(argv: string[]) {
    const options: Record<string, string> = {};
    const rest: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            options[argv[i].slice(2)] = argv[++i] ?? '';
        } else {
            rest.push(argv[i]);
        }
    }
    return { options, question: rest.join(' ') };
}

async function main() {
    const { options, question } = parseArgs(process.argv.slice(2));
    const project = options.project ?? process.env.UE_LLM_INDEX_PROJECT;
    if (!project || !question) {
        console.error(USAGE);
        process.exit(1);
    }
    const model = options.model ?? 'qwen2.5:7b';
    const numCtx = Number(options.ctx ?? 32768);
    const maxSteps = Number(options.steps ?? 10);
    const host = options.host ?? 'http://localhost:11434';

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(__dirname, 'cli.js'), 'serve', project, '--no-write'],
        stderr: 'inherit',
    });
    const client = new Client({ name: 'agent-smoke', version: '0.1.0' });
    await client.connect(transport);

    const { tools } = await client.listTools();
    const ollamaTools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    console.log(`model ${model}, num_ctx ${numCtx}, ${tools.length} tools\nQ: ${question}\n`);
    const messages: ChatMessage[] = [
        { role: 'system', content: rules },
        { role: 'user', content: question },
    ];

    try {
        for (let step = 1; step <= maxSteps; step++) {
            const response = await fetch(`${host}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, messages, tools: ollamaTools, stream: false, options: { num_ctx: numCtx } }),
            });
            if (!response.ok) {
                throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
            }
            const data = (await response.json()) as { message: ChatMessage; prompt_eval_count?: number; eval_count?: number };
            const message: ChatMessage = data.message;
            messages.push(message);
            console.log(`step ${step}: prompt ${data.prompt_eval_count ?? '?'} tokens, reply ${data.eval_count ?? '?'} tokens`);

            if (!message.tool_calls?.length) {
                console.log(`\n=== Answer ===\n${message.content}`);
                return;
            }
            for (const call of message.tool_calls) {
                const args = call.function.arguments ?? {};
                console.log(`  -> ${call.function.name}(${JSON.stringify(args)})`);
                const result = await client.callTool({ name: call.function.name, arguments: args });
                const text = (result.content as { type: string; text?: string }[])
                    .filter(c => c.type === 'text')
                    .map(c => c.text)
                    .join('\n');
                console.log(`     ${result.isError ? 'ERROR ' : ''}${text.length} chars: ${text.split('\n')[0].slice(0, 100)}`);
                messages.push({ role: 'tool', content: text, tool_name: call.function.name });
            }
        }
        console.log(`\nStopped after ${maxSteps} steps without a final answer.`);
    } finally {
        await client.close();
    }
}

main().catch(err => {
    console.error(`Error: ${err.message ?? err}`);
    process.exit(1);
});
