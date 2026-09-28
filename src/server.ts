import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as path from 'path';
import { writeIndex, WriteOptions } from './emit';
import { EngineProvider, renderEngineSection } from './engineContext';
import { EngineInstall } from './engine/locate';
import { defaultCacheDir } from './engine/paths';
import { ProjectIndex } from './indexer';
import { MEMORY_DIR, MemoryStore, renderMemorySection } from './memory';
import { findRipgrep } from './search';
import { limitsFor, OutputLimits, ToolContext, TOOLS } from './tools';

export { capOutput } from './tools';

const SERVER_INSTRUCTIONS =
    'Index of an Unreal Engine C++ project, its engine, and engine and Marketplace plugins, with project memory. Call get_index first to see modules, files, ' +
    'the engine, and open tasks and decisions from earlier sessions; then use get_file_outline, find_symbol and read_symbol to fetch only the code you need ' +
    '(scope "engine" for engine classes). Avoid reading whole files; every result is size-capped. Save decisions, non-obvious facts, gotchas and unfinished work with remember.';

const log = (message: string) => process.stderr.write(`[unreal-llm-index] ${message}\n`);

export interface ServerOptions {
    version: string;
    /** Keep .llm-index/ up to date when the project changes. */
    writeFiles: boolean;
    engine?: EngineProvider;
    memory?: MemoryStore;
    limits?: OutputLimits;
    rgPath?: string;
}

/** The Engine and Project memory sections of INDEX.md. */
export function indexSections(ctx: Pick<ToolContext, 'project' | 'engine' | 'memory'>): WriteOptions {
    return {
        engineSection: ctx.engine && renderEngineSection(ctx.engine.state(), ctx.project.project),
        memorySection: ctx.memory && renderMemorySection(ctx, ctx.memory),
    };
}

export function createServer(index: ProjectIndex, options: ServerOptions): McpServer {
    const server = new McpServer({ name: 'unreal-llm-index', version: options.version }, { instructions: SERVER_INSTRUCTIONS });
    const ctx: ToolContext = {
        project: index,
        engine: options.engine,
        memory: options.memory,
        source: 'agent',
        limits: options.limits ?? limitsFor(),
        rgPath: options.rgPath,
    };

    const refresh = () => {
        if (index.refresh() && options.writeFiles) {
            try {
                writeIndex(index, indexSections(ctx));
            } catch (e: any) {
                log(`could not write index files: ${e.message}`);
            }
        }
    };

    for (const tool of TOOLS) {
        const readOnly = tool.readOnly !== false;
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: tool.description,
                inputSchema: tool.input,
                // Read-only tools run without a confirmation prompt in VS Code; memory writes ask
                annotations: { readOnlyHint: readOnly, destructiveHint: readOnly ? undefined : !!tool.destructive, openWorldHint: false },
            },
            async (args: any) => {
                try {
                    refresh();
                    return { content: [{ type: 'text' as const, text: await tool.run(args ?? {}, ctx) }] };
                } catch (e: any) {
                    return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
                }
            },
        );
    }
    return server;
}

export interface StartOptions {
    version: string;
    writeFiles: boolean;
    /** An engine install, null for no engine, or undefined to locate it from the project. */
    engine?: EngineInstall | null;
    cacheDir?: string;
    /** The memory folder, null for no memory, or undefined for <project>/.llm-memory. */
    memoryDir?: string | null;
    rgPath?: string;
    limits?: OutputLimits;
}

export async function startServer(projectDir: string, options: StartOptions) {
    const index = new ProjectIndex(projectDir);
    index.refresh(true);
    const engine = new EngineProvider({ project: index, cacheDir: options.cacheDir ?? defaultCacheDir(), install: options.engine });
    const memory = options.memoryDir === null ? undefined : new MemoryStore(options.memoryDir ?? path.join(index.root, MEMORY_DIR));
    if (options.writeFiles) {
        try {
            writeIndex(index, indexSections({ project: index, engine, memory }));
        } catch (e: any) {
            log(`could not write index files: ${e.message}`);
        }
    }
    const rgPath = options.rgPath ?? findRipgrep();
    const server = createServer(index, { version: options.version, writeFiles: options.writeFiles, engine, memory, limits: options.limits, rgPath });
    await server.connect(new StdioServerTransport());
    const state = engine.state();
    const engineText = 'handle' in state ? `engine ${state.handle.install.root}` : `no engine index (${state.message})`;
    const memoryText = memory ? `memory ${memory.dir} (${memory.list().length} notes)` : 'memory off';
    log(`serving ${index.project.name}: ${index.indexedFiles().length} files, ${index.allSymbols().length} symbols; ${engineText}; ${memoryText}; ripgrep ${rgPath ?? 'not found'}`);
}
