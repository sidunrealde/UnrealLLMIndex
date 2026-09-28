import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAgentLoop } from '../src/agentLoop';
import { ProjectIndex } from '../src/indexer';
import { createServer } from '../src/server';

/** A fake OpenAI-compatible endpoint: first asks for a tool call, then answers. */
function startFakeModel() {
    const requests: { headers: http.IncomingHttpHeaders; body: any }[] = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => (raw += chunk));
        req.on('end', () => {
            const body = JSON.parse(raw);
            requests.push({ headers: req.headers, body });
            const toolResult = body.messages.find((m: any) => m.role === 'tool');
            const message = toolResult
                ? { role: 'assistant', content: `Found it: ${toolResult.content.split('\n')[0]}` }
                : {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                          { id: 'call_1', type: 'function', function: { name: 'find_symbol', arguments: '{"query":"ApplyDamage","limit":1}' } },
                      ],
                  };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100 * requests.length, completion_tokens: 10 } }));
        });
    });
    return new Promise<{ url: string; requests: typeof requests; close: () => void }>(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({ url: `http://127.0.0.1:${port}/v1`, requests, close: () => server.close() });
        });
    });
}

describe('runAgentLoop', () => {
    const client = new Client({ name: 'test', version: '0' });
    let model: Awaited<ReturnType<typeof startFakeModel>>;

    beforeAll(async () => {
        const index = new ProjectIndex(path.join(__dirname, 'fixtures/SampleGame'));
        index.refresh(true);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([createServer(index, { version: 'test', writeFiles: false }).connect(serverTransport), client.connect(clientTransport)]);
        model = await startFakeModel();
    });

    afterAll(async () => {
        model.close();
        await client.close();
    });

    it('calls MCP tools requested by the model and returns its final answer', async () => {
        const result = await runAgentLoop({
            client,
            baseUrl: model.url + '/',
            model: 'any-model',
            apiKey: 'secret',
            systemPrompt: 'system',
            question: 'Where is ApplyDamage?',
        });

        expect(result.toolCalls).toEqual([{ name: 'find_symbol', args: { query: 'ApplyDamage', limit: 1 } }]);
        expect(result.answer).toContain('Found it: function ASampleCharacter::ApplyDamage');
        expect(result.steps).toBe(2);
        expect(result.maxPromptTokens).toBe(200);

        const [first, second] = model.requests;
        expect(first.headers.authorization).toBe('Bearer secret');
        expect(first.body.model).toBe('any-model');
        expect(first.body.tools.map((t: any) => t.function.name)).toContain('read_symbol');
        const toolMessage = second.body.messages.find((m: any) => m.role === 'tool');
        expect(toolMessage.tool_call_id).toBe('call_1');
    });
});
