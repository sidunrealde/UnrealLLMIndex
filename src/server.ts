import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { writeIndex } from './emit';
import { ProjectIndex, qualifiedName } from './indexer';
import { isHeader, renderFileOutline, renderIndex, renderModuleSummary } from './outline';
import { CodeSymbol, SourceRange, SymbolKind } from './types';

/** About 3k tokens: keeps every tool result small enough for 8k–32k context windows. */
export const MAX_OUTPUT_CHARS = 10_000;
export const MAX_READ_LINES = 200;

const SYMBOL_KINDS = ['class', 'struct', 'interface', 'enum', 'function', 'property', 'variable', 'delegate', 'alias'] as const;

const SERVER_INSTRUCTIONS =
    'Index of an Unreal Engine C++ project. Call get_index first to see modules and files, ' +
    'then use get_file_outline, find_symbol and read_symbol to fetch only the code you need. ' +
    'Avoid reading whole files; every result is size-capped.';

export function capOutput(text: string, hint: string, max = MAX_OUTPUT_CHARS): string {
    if (text.length <= max) {
        return text;
    }
    const cut = text.lastIndexOf('\n', max);
    const kept = text.slice(0, cut > max / 2 ? cut : max);
    const remainingLines = text.slice(kept.length).split('\n').length;
    return `${kept}\n… [truncated: ${remainingLines} more lines. ${hint}]`;
}

const log = (message: string) => process.stderr.write(`[unreal-llm-index] ${message}\n`);

function numberedRange(index: ProjectIndex, range: SourceRange): string {
    const lines = index.readFileLines(range.file);
    const start = Math.max(1, range.startLine);
    const end = Math.min(range.endLine, lines.length, start + MAX_READ_LINES - 1);
    const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(4)}| ${l}`).join('\n');
    const clipped = end < range.endLine ? ` (first ${end - start + 1} of ${range.endLine - start + 1} lines; use read_lines for the rest)` : '';
    return `// ${index.shortPath(range.file)}:${start === end ? start : `${start}-${end}`}${clipped}\n${body}`;
}

function symbolLine(index: ProjectIndex, s: CodeSymbol): string {
    const location = s.isDefinition ? `${index.shortPath(s.file)}:${s.startLine}-${s.endLine}` : `${index.shortPath(s.file)}:${s.line}`;
    const defs = s.definitions?.length
        ? ` → ${s.definitions.map(d => `${index.shortPath(d.file)}:${d.startLine}-${d.endLine}`).join(', ')}`
        : '';
    return `${s.kind} ${qualifiedName(s)} — ${location} — ${s.signature}${defs}`;
}

export function createServer(index: ProjectIndex, options: { version: string; writeFiles: boolean }): McpServer {
    const server = new McpServer({ name: 'unreal-llm-index', version: options.version }, { instructions: SERVER_INSTRUCTIONS });

    const refresh = () => {
        if (index.refresh() && options.writeFiles) {
            try {
                writeIndex(index);
            } catch (e: any) {
                log(`could not write index files: ${e.message}`);
            }
        }
    };

    const run = (fn: () => string) => {
        try {
            refresh();
            return { content: [{ type: 'text' as const, text: fn() }] };
        } catch (e: any) {
            return { content: [{ type: 'text' as const, text: `Error: ${e.message}` }], isError: true };
        }
    };

    server.registerTool(
        'get_index',
        {
            title: 'Project index',
            description:
                'Start here. Returns the project map: modules, their dependencies, and every source file with the types it declares.',
        },
        () => run(() => capOutput(renderIndex(index), 'Use get_module_outline(module) for one module.', MAX_OUTPUT_CHARS * 1.5)),
    );

    server.registerTool(
        'get_module_outline',
        {
            title: 'Module outline',
            description:
                'Classes, structs, enums and delegates of one module with their function and property names and line numbers. Use a module name from get_index.',
            inputSchema: { module: z.string().describe('Module name, e.g. "XAPI"') },
        },
        ({ module }) =>
            run(() => {
                const found = index.findModule(module);
                if (!found) {
                    throw new Error(`Unknown module "${module}". Modules: ${index.project.modules.map(m => m.name).join(', ')}`);
                }
                return capOutput(renderModuleSummary(index, found), 'Use get_file_outline(path) for one file.');
            }),
    );

    server.registerTool(
        'get_file_outline',
        {
            title: 'File outline',
            description:
                'All declarations in one file with signatures and line numbers. For headers, "→ file:lines" shows where each function is implemented. Accepts any unique path suffix, e.g. "Agent.h".',
            inputSchema: { path: z.string().describe('File path or unique suffix, e.g. "Public/Agent.h"') },
        },
        ({ path }) =>
            run(() => capOutput(renderFileOutline(index, index.resolvePath(path)), 'Use read_symbol or read_lines for details.')),
    );

    server.registerTool(
        'find_symbol',
        {
            title: 'Find symbol',
            description:
                'Find classes, structs, enums, functions, properties or delegates by full or partial name, e.g. "ToJson", "UAgent" or "UAgent::Get". Returns kind, qualified name, location and signature.',
            inputSchema: {
                query: z.string().describe('Name or part of a name'),
                kind: z.enum(SYMBOL_KINDS).optional().describe('Only return symbols of this kind'),
                limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 20)'),
            },
        },
        ({ query, kind, limit }) =>
            run(() => {
                const results = index.findSymbols(query, kind as SymbolKind | undefined, limit ?? 20);
                if (!results.length) {
                    return `No symbols match "${query}". Try a shorter query or search_code.`;
                }
                return capOutput(results.map(s => symbolLine(index, s)).join('\n'), 'Narrow the query or pass kind.');
            }),
    );

    server.registerTool(
        'read_symbol',
        {
            title: 'Read symbol source',
            description:
                'Source code of one symbol with line numbers: a function\'s declaration and its implementation, or a class/struct/enum declaration. Use a qualified name like "UAgent::ToJsonObject" when a name exists in several classes.',
            inputSchema: { name: z.string().describe('Symbol name, e.g. "UAgent::ToJsonObject" or "FAttachment"') },
        },
        ({ name }) =>
            run(() => {
                const matches = index.resolveSymbol(name);
                if (!matches.length) {
                    const suggestions = index.findSymbols(name, undefined, 8);
                    return suggestions.length
                        ? `No symbol named "${name}". Did you mean:\n${suggestions.map(s => symbolLine(index, s)).join('\n')}`
                        : `No symbol named "${name}". Try find_symbol or search_code.`;
                }
                // Declarations (headers) before implementations
                matches.sort((a, b) => Number(!!a.isDefinition) - Number(!!b.isDefinition) || Number(!isHeader(a.file)) - Number(!isHeader(b.file)));
                const distinct = new Map<string, CodeSymbol>();
                for (const s of matches) {
                    if (!distinct.has(qualifiedName(s))) {
                        distinct.set(qualifiedName(s), s);
                    }
                }
                if (distinct.size > 1) {
                    return capOutput(
                        `"${name}" is ambiguous. Call read_symbol again with one of these qualified names:\n${[...distinct.values()].map(s => symbolLine(index, s)).join('\n')}`,
                        'Use a qualified name.',
                    );
                }
                const ranges = new Map<string, SourceRange>();
                for (const s of matches) {
                    ranges.set(`${s.file}:${s.startLine}`, { file: s.file, startLine: s.startLine, endLine: s.endLine });
                    for (const d of s.definitions ?? []) {
                        ranges.set(`${d.file}:${d.startLine}`, d);
                    }
                }
                const text = [...ranges.values()].map(r => numberedRange(index, r)).join('\n\n');
                return capOutput(text, 'Use read_lines(path, start, end) for a specific part.');
            }),
    );

    server.registerTool(
        'read_lines',
        {
            title: 'Read lines',
            description: `Read an exact line range of a project file, with line numbers (max ${MAX_READ_LINES} lines per call).`,
            inputSchema: {
                path: z.string().describe('File path or unique suffix'),
                start: z.number().int().min(1).describe('First line (1-based)'),
                end: z.number().int().min(1).optional().describe('Last line (default start + 99)'),
            },
        },
        ({ path, start, end }) =>
            run(() => {
                const rel = index.resolvePath(path);
                const total = index.readFileLines(rel).length;
                if (start > total) {
                    throw new Error(`${rel} has only ${total} lines`);
                }
                const last = Math.min(end ?? start + 99, start + MAX_READ_LINES - 1, total);
                return capOutput(numberedRange(index, { file: rel, startLine: start, endLine: last }), 'Request a smaller range.');
            }),
    );

    server.registerTool(
        'search_code',
        {
            title: 'Search code',
            description:
                'Regex search across the project\'s C++ source files. Returns "file:line: text". Use path_filter to limit to paths containing a substring, e.g. "Private/" or "LRSActions".',
            inputSchema: {
                pattern: z.string().describe('JavaScript regular expression (plain text also works)'),
                path_filter: z.string().optional().describe('Only search files whose path contains this text'),
                ignore_case: z.boolean().optional().describe('Case-insensitive (default true)'),
                max_results: z.number().int().min(1).max(100).optional().describe('Maximum matches (default 40)'),
            },
        },
        ({ pattern, path_filter, ignore_case, max_results }) =>
            run(() => {
                const flags = ignore_case === false ? '' : 'i';
                let regex: RegExp;
                try {
                    regex = new RegExp(pattern, flags);
                } catch {
                    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
                }
                const limit = max_results ?? 40;
                const filter = path_filter?.replace(/\\/g, '/').toLowerCase();
                const hits: string[] = [];
                let total = 0;
                for (const rel of index.indexedFiles()) {
                    if (filter && !rel.toLowerCase().includes(filter)) {
                        continue;
                    }
                    index.readFileLines(rel).forEach((line, i) => {
                        if (regex.test(line)) {
                            total++;
                            if (hits.length < limit) {
                                const text = line.trim();
                                hits.push(`${index.shortPath(rel)}:${i + 1}: ${text.length > 200 ? text.slice(0, 200) + '…' : text}`);
                            }
                        }
                    });
                }
                if (!hits.length) {
                    return `No matches for /${pattern}/${flags}.`;
                }
                const more = total > hits.length ? `\n… ${total - hits.length} more matches. Narrow the pattern or use path_filter.` : '';
                return capOutput(hits.join('\n') + more, 'Narrow the pattern or use path_filter.');
            }),
    );

    return server;
}

export async function startServer(projectDir: string, options: { version: string; writeFiles: boolean }) {
    const index = new ProjectIndex(projectDir);
    index.refresh(true);
    if (options.writeFiles) {
        try {
            writeIndex(index);
        } catch (e: any) {
            log(`could not write index files: ${e.message}`);
        }
    }
    const server = createServer(index, options);
    await server.connect(new StdioServerTransport());
    log(`serving ${index.project.name}: ${index.indexedFiles().length} files, ${index.allSymbols().length} symbols (${index.root})`);
}
