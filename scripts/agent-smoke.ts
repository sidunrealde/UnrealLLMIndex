/**
 * Tests the index end to end with any OpenAI-compatible model endpoint:
 * starts the MCP server, gives its tools to the model, and prints each tool call.
 *
 *   node dist/agent-smoke.js --project <dir> --base-url <url>/v1 --model <name> [--api-key <key>] "question"
 *
 * Without those flags, the endpoint, model and key come from $OPENAI_BASE_URL, $OPENAI_MODEL and $OPENAI_API_KEY.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'path';
import { TOOL_AGENT_PROMPT } from '../src/agentInstructions';
import { runAgentLoop } from '../src/agentLoop';

const USAGE =
    'Usage: node dist/agent-smoke.js --project <dir> --base-url <url>/v1 --model <name> [--api-key <key>] [--steps 10] ' +
    '[--engine <dir>] [--cache-dir <dir>] [--rg <path>] [--max-result-tokens <n>] "question"';

/** Options passed on to `ue-llm-index serve`. */
const SERVER_OPTIONS = ['engine', 'cache-dir', 'rg', 'max-result-tokens', 'max-read-lines'];

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
    const baseUrl = options['base-url'] ?? process.env.OPENAI_BASE_URL;
    const model = options.model ?? process.env.OPENAI_MODEL;
    if (!project || !baseUrl || !model || !question) {
        console.error(USAGE);
        process.exit(1);
    }

    const client = new Client({ name: 'agent-smoke', version: '0.3.0' });
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: [
                path.join(__dirname, 'cli.js'), 'serve', project, '--no-write',
                ...SERVER_OPTIONS.filter(name => options[name]).flatMap(name => [`--${name}`, options[name]]),
            ],
            stderr: 'inherit',
        }),
    );

    try {
        console.log(`model ${model} at ${baseUrl}\nQ: ${question}\n`);
        const result = await runAgentLoop({
            client,
            baseUrl,
            model,
            apiKey: options['api-key'] ?? process.env.OPENAI_API_KEY,
            systemPrompt: TOOL_AGENT_PROMPT,
            question,
            maxSteps: Number(options.steps ?? 10),
            log: line => console.log(line),
        });
        console.log(
            result.answer !== undefined
                ? `\n=== Answer (${result.steps} steps, max prompt ${result.maxPromptTokens ?? '?'} tokens) ===\n${result.answer}`
                : `\nStopped after ${result.steps} steps without a final answer.`,
        );
    } finally {
        await client.close();
    }
}

main().catch(err => {
    console.error(`Error: ${err.message ?? err}`);
    process.exit(1);
});
