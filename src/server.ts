import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { writeIndex } from './emit';
import { EngineProvider, renderEngineSection } from './engineContext';
import { EngineInstall } from './engine/locate';
import { defaultCacheDir } from './engine/paths';
import { ProjectIndex } from './indexer';
import { findRipgrep } from './search';
import { limitsFor, OutputLimits, ToolContext, TOOLS } from './tools';

export { capOutput } from './tools';

const SERVER_INSTRUCTIONS =
    'Index of an Unreal Engine C++ project, its engine, and engine and Marketplace plugins. Call get_index first to see modules, files and the engine, ' +
    'then use get_file_outline, find_symbol and read_symbol to fetch only the code you need (scope "engine" for engine classes). ' +
    'Avoid reading whole files; every result is size-capped.';

const log = (message: string) => process.stderr.write(`[unreal-llm-index] ${message}\n`);

export interface ServerOptions {
    version: string;
    /** Keep .llm-index/ up to date when the project changes. */
    writeFiles: boolean;
    engine?: EngineProvider;
    limits?: OutputLimits;
    rgPath?: string;
}

export function createServer(index: ProjectIndex, options: ServerOptions): McpServer {
    const server = new McpServer({ name: 'unreal-llm-index', version: options.version }, { instructions: SERVER_INSTRUCTIONS });
    const ctx: ToolContext = { project: index, engine: options.engine, limits: options.limits ?? limitsFor(), rgPath: options.rgPath };

    const refresh = () => {
        if (index.refresh() && options.writeFiles) {
            try {
                writeIndex(index, { engineSection: options.engine && renderEngineSection(options.engine.state(), index.project) });
            } catch (e: any) {
                log(`could not write index files: ${e.message}`);
            }
        }
    };

    for (const tool of TOOLS) {
        server.registerTool(
            tool.name,
            {
                title: tool.title,
                description: tool.description,
                inputSchema: tool.input,
                // Read-only tools run without a confirmation prompt in VS Code
                annotations: { readOnlyHint: true, openWorldHint: false },
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
    rgPath?: string;
    limits?: OutputLimits;
}

export async function startServer(projectDir: string, options: StartOptions) {
    const index = new ProjectIndex(projectDir);
    index.refresh(true);
    const engine = new EngineProvider({ project: index, cacheDir: options.cacheDir ?? defaultCacheDir(), install: options.engine });
    if (options.writeFiles) {
        try {
            writeIndex(index, { engineSection: renderEngineSection(engine.state(), index.project) });
        } catch (e: any) {
            log(`could not write index files: ${e.message}`);
        }
    }
    const rgPath = options.rgPath ?? findRipgrep();
    const server = createServer(index, { version: options.version, writeFiles: options.writeFiles, engine, limits: options.limits, rgPath });
    await server.connect(new StdioServerTransport());
    const state = engine.state();
    const engineText = 'handle' in state ? `engine ${state.handle.install.root}` : `no engine index (${state.message})`;
    log(`serving ${index.project.name}: ${index.indexedFiles().length} files, ${index.allSymbols().length} symbols; ${engineText}; ripgrep ${rgPath ?? 'not found'}`);
}
