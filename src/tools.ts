import { z } from 'zod';
import { EnabledPlugin, resolveEnabledPlugins } from './engine/enablement';
import { EngineProvider, EngineState, renderEngineSection } from './engineContext';
import { ProjectIndex, qualifiedName } from './indexer';
import { isHeader, renderFileOutline, renderIndex, renderModuleSummary } from './outline';
import { checkNote, MEMORY_DIR, MemoryStore, NOTE_KINDS, noteLine, notesAbout, renderMemorySection, resolveAnchors } from './memory';
import { searchFiles, SearchHit, toRegex } from './search';
import { searchEngineCode } from './codeSearch';
import { findCallers, findReferences, renderCallers, renderReferences } from './references';
import { CodeSymbol, PluginInfo, SourceIndex, SourceRange, SymbolKind } from './types';

/** How much a single tool result may contain. */
export interface OutputLimits {
    maxChars: number;
    maxReadLines: number;
}

export const DEFAULT_RESULT_TOKENS = 8000;
export const DEFAULT_READ_LINES = 400;

/** Limits from a token budget (about 3.5 characters per token) and a line count. */
export function limitsFor(resultTokens = DEFAULT_RESULT_TOKENS, readLines = DEFAULT_READ_LINES): OutputLimits {
    return { maxChars: Math.round(Math.max(500, resultTokens) * 3.5), maxReadLines: Math.max(20, Math.round(readLines)) };
}

export interface ToolContext {
    project: ProjectIndex;
    /** The project's engine index; without it, tools cover the project only. */
    engine?: EngineProvider;
    limits: OutputLimits;
    /** ripgrep, for searching engine code. */
    rgPath?: string;
    /** Project memory; without it, the memory tools report that memory is off. */
    memory?: MemoryStore;
    /** Recorded on notes this context saves: "@unreal" or "agent". */
    source?: string;
    /** Called for each source range a tool returns, e.g. to show references in chat. `label` is "path:start-end" as shown. */
    onRead?(absolutePath: string, startLine: number, endLine: number, label: string): void;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
    name: string;
    title: string;
    description: string;
    input: S;
    /** Tools that only read run without confirmation in VS Code. Defaults to true. */
    readOnly?: boolean;
    /** Tools that delete something. */
    destructive?: boolean;
    run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): string | Promise<string>;
}

const defineTool = <S extends z.ZodRawShape>(tool: ToolDef<S>): ToolDef<any> => tool;

export function capOutput(text: string, hint: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    const cut = text.lastIndexOf('\n', max);
    const kept = text.slice(0, cut > max / 2 ? cut : max);
    const remainingLines = text.slice(kept.length).split('\n').length;
    return `${kept}\n… [truncated: ${remainingLines} more lines. ${hint}]`;
}

const scopeInput = (fallback: string) =>
    z.enum(['project', 'engine', 'all']).optional().describe(`"project" (this project and its plugins), "engine" (engine, engine and Marketplace plugins) or "all". Default "${fallback}".`);

function engineState(ctx: ToolContext): EngineState {
    return ctx.engine?.state() ?? { message: 'No engine index is configured for this project.' };
}

interface Located {
    index: SourceIndex;
    rel: string;
}

/** A file in the project, or in the engine for "Engine/..." paths and paths the project doesn't have. */
function locateFile(ctx: ToolContext, input: string): Located {
    const enginePath = /^engine[\\/]/i.test(input.trim().replace(/^\.?[\\/]/, ''));
    let projectError: Error | undefined;
    if (!enginePath) {
        try {
            return { index: ctx.project, rel: ctx.project.resolvePath(input) };
        } catch (e: any) {
            if (/several files/.test(e.message)) {
                throw e;
            }
            projectError = e;
        }
    }
    const state = engineState(ctx);
    if (!('handle' in state)) {
        throw enginePath ? new Error(state.message) : projectError!;
    }
    try {
        return { index: state.handle.index, rel: state.handle.index.resolvePath(input) };
    } catch (e: any) {
        if (enginePath || /several/.test(e.message)) {
            throw e;
        }
        throw new Error(`File not found in the project or the engine: "${input}". Use a path from get_index or find_symbol.`);
    }
}

function numberedRange(ctx: ToolContext, index: SourceIndex, range: SourceRange): string {
    const lines = index.readFileLines(range.file);
    const start = Math.max(1, range.startLine);
    const end = Math.min(range.endLine, lines.length, start + ctx.limits.maxReadLines - 1);
    const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(4)}| ${l}`).join('\n');
    const clipped = end < range.endLine ? ` (first ${end - start + 1} of ${range.endLine - start + 1} lines; use read_lines for the rest)` : '';
    const label = `${index.shortPath(range.file)}:${start === end ? start : `${start}-${end}`}`;
    ctx.onRead?.(index.absolutePath(range.file), start, end, label);
    return `// ${label}${clipped}\n${body}`;
}

function symbolLine(index: SourceIndex, s: CodeSymbol): string {
    const location = s.isDefinition ? `${index.shortPath(s.file)}:${s.startLine}-${s.endLine}` : `${index.shortPath(s.file)}:${s.line}`;
    const defs = s.definitions?.length ? ` → ${s.definitions.map(d => `${index.shortPath(d.file)}:${d.startLine}-${d.endLine}`).join(', ')}` : '';
    return `${s.kind} ${qualifiedName(s)} — ${location} — ${s.signature}${defs}`;
}

interface Hit {
    index: SourceIndex;
    symbol: CodeSymbol;
    tier: number;
    bonus: number;
    engine: boolean;
}

/** Project and engine matches merged by how well they match; the project wins ties. */
function findHits(ctx: ToolContext, query: string, kind: SymbolKind | undefined, scope: string, limit: number): { hits: Hit[]; note?: string } {
    const hits: Hit[] = [];
    let note: string | undefined;
    if (scope !== 'engine') {
        hits.push(...ctx.project.findSymbolMatches(query, kind, limit).map(m => ({ ...m, index: ctx.project, engine: false })));
    }
    if (scope !== 'project') {
        const state = engineState(ctx);
        if ('handle' in state) {
            const index = state.handle.index;
            hits.push(...index.findSymbolMatches(query, kind, limit, state.handle.rank).map(m => ({ ...m, index, engine: true })));
        } else {
            note = state.message;
        }
    }
    hits.sort((a, b) => b.tier - a.tier || Number(a.engine) - Number(b.engine) || b.bonus - a.bonus);
    return { hits: hits.slice(0, limit), note };
}

const REASONS: Record<EnabledPlugin['reason'], (e: EnabledPlugin) => string> = {
    uproject: () => 'enabled in .uproject',
    project: () => 'project plugin',
    default: () => 'enabled by default',
    dependency: e => `enabled as a dependency of ${e.via}`,
};

function pluginLine(plugin: PluginInfo, enabled?: EnabledPlugin): string {
    const friendly = plugin.friendlyName && plugin.friendlyName !== plugin.name ? ` ("${plugin.friendlyName}")` : '';
    const status = enabled ? REASONS[enabled.reason](enabled) : 'not enabled';
    const modules = plugin.modules.length ? `; modules: ${plugin.modules.join(', ')}` : '';
    return `- ${plugin.name}${friendly} [${plugin.category}, ${status}] — ${plugin.description?.replace(/\s+/g, ' ') ?? 'no description'} (${plugin.dir}${modules})`;
}

const hitLine = (index: SourceIndex | undefined, hit: SearchHit) => `${index ? index.shortPath(hit.path) : hit.path}:${hit.line}: ${hit.text}`;

const MEMORY_OFF = 'Project memory is off for this project (the unrealLlmIndex.memory.enabled setting, or --no-memory).';

/** Notes about the given symbols or files, to append to a tool result; empty when there are none. */
function notesSection(ctx: ToolContext, targets: string[], options: { members?: boolean; max?: number } = {}): string {
    if (!ctx.memory) {
        return '';
    }
    const notes = notesAbout(ctx.memory.list(), targets, { members: options.members });
    if (!notes.length) {
        return '';
    }
    const max = options.max ?? 8;
    const more = notes.length > max ? `\n… ${notes.length - max} more; recall(about) lists them.` : '';
    return `\n\nProject memory notes about this code:\n${notes.slice(0, max).map(n => noteLine(ctx, n, 300)).join('\n')}${more}`;
}

/** How many notes are about each symbol or file, by lower-case key. */
function noteCounts(ctx: ToolContext): Map<string, number> {
    const counts = new Map<string, number>();
    for (const note of ctx.memory?.list() ?? []) {
        for (const anchor of note.about) {
            counts.set(anchor.toLowerCase(), (counts.get(anchor.toLowerCase()) ?? 0) + 1);
        }
    }
    return counts;
}

function requireMemory(ctx: ToolContext): MemoryStore {
    if (!ctx.memory) {
        throw new Error(MEMORY_OFF);
    }
    return ctx.memory;
}

export const TOOLS: ToolDef<any>[] = [
    defineTool({
        name: 'get_index',
        title: 'Project index',
        description:
            'Start here. Returns the project map: modules with their dependencies, every source file with the types it declares, the engine version and plugins the project uses, and project memory (open tasks and recent decisions from earlier sessions).',
        input: {},
        run: (_args, ctx) => {
            const engineSection = ctx.engine ? renderEngineSection(engineState(ctx), ctx.project.project) : undefined;
            const memorySection = ctx.memory ? renderMemorySection(ctx, ctx.memory) : undefined;
            return capOutput(renderIndex(ctx.project, { engineSection, memorySection }), 'Use get_module_outline(module) for one module.', ctx.limits.maxChars * 1.5);
        },
    }),

    defineTool({
        name: 'get_module_outline',
        title: 'Module outline',
        description:
            'Classes, structs, enums and delegates of one module with their function and property names. Works for project modules, engine modules (e.g. "Engine", "UMG") and plugins. Large modules list their folders first; pass filter to outline part of one.',
        input: {
            module: z.string().describe('Module or plugin name, e.g. "MyGame", "Engine" or "EnhancedInput"'),
            filter: z.string().optional().describe('Only files whose path contains this text, e.g. "GameFramework" or "Character"'),
        },
        run: ({ module, filter }, ctx) => {
            const max = ctx.limits.maxChars;
            const found = ctx.project.findModule(module);
            if (found) {
                return capOutput(renderModuleSummary(ctx.project, found, { filter, outlineFiles: true }), 'Pass a filter, or use get_file_outline(path) for one file.', max);
            }
            const state = engineState(ctx);
            if ('handle' in state) {
                const index = state.handle.index;
                const engineModule = index.findModule(module);
                if (engineModule) {
                    return capOutput(renderModuleSummary(index, engineModule, { filter }), 'Pass a filter, or use get_file_outline(path) for one file.', max);
                }
                const plugin = index.findPlugin(module);
                if (plugin) {
                    const modules = plugin.modules.map(name => index.findModule(name)).filter(m => m !== undefined);
                    return [
                        pluginLine(plugin, state.handle.enabled.get(plugin.name.toLowerCase())),
                        ...modules.map(m => `  module ${m.name} (${m.type ?? 'module'}): ${m.dir}, ${m.files.length} files`),
                        `Call get_module_outline with one of these module names.`,
                    ].join('\n');
                }
            }
            const projectPlugin = ctx.project.project.plugins.find(p => p.name.toLowerCase() === module.trim().toLowerCase());
            if (projectPlugin) {
                return `${pluginLine(projectPlugin)}\nCall get_module_outline with one of its modules: ${projectPlugin.modules.join(', ')}`;
            }
            const engineHint = 'handle' in state ? ' Engine modules and plugins work too, e.g. "Engine"; find one with find_symbol or list_plugins.' : ` (${state.message})`;
            throw new Error(`Unknown module "${module}". Modules: ${ctx.project.project.modules.map(m => m.name).join(', ')}.${engineHint}`);
        },
    }),

    defineTool({
        name: 'get_file_outline',
        title: 'File outline',
        description:
            'All declarations in one file with signatures and line numbers. For headers, "→ file:lines" shows where each function is implemented. Accepts any unique path suffix, e.g. "Agent.h", or an engine path such as "GameFramework/Character.h". Very long files get a compact outline; pass type for one class.',
        input: {
            path: z.string().describe('File path or unique suffix, e.g. "Public/Agent.h" or "GameFramework/Character.h"'),
            type: z.string().optional().describe('Only this class, struct or enum and its members, e.g. "ACharacter"'),
        },
        run: ({ path, type }, ctx) => {
            const { index, rel } = locateFile(ctx, path);
            const outline = capOutput(renderFileOutline(index, rel, { type, maxChars: ctx.limits.maxChars }), 'Pass type, or use read_symbol or read_lines for details.', ctx.limits.maxChars);
            return outline + notesSection(ctx, [rel, ...index.symbolsInFile(rel).map(qualifiedName)]);
        },
    }),

    defineTool({
        name: 'find_symbol',
        title: 'Find symbol',
        description:
            'Find classes, structs, enums, functions, properties or delegates by full or partial name, e.g. "ToJson", "ACharacter" or "UCharacterMovementComponent::DoJump". Searches the project and the engine; engine results from modules and plugins the project uses come first. Returns kind, qualified name, location and signature.',
        input: {
            query: z.string().describe('Name or part of a name'),
            kind: z.enum(['class', 'struct', 'interface', 'enum', 'function', 'property', 'variable', 'delegate', 'alias']).optional().describe('Only return symbols of this kind'),
            scope: scopeInput('all'),
            limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default 20)'),
        },
        run: ({ query, kind, scope, limit }, ctx) => {
            const { hits, note } = findHits(ctx, query, kind as SymbolKind | undefined, scope ?? 'all', limit ?? 20);
            if (!hits.length && note && scope === 'engine') {
                return note;
            }
            const notice = note ? `\n(Engine not searched: ${note})` : '';
            if (!hits.length) {
                return `No symbols match "${query}". Try a shorter query, another scope, or search_code.${notice}`;
            }
            const counts = noteCounts(ctx);
            const lines = hits.map(h => {
                const notes = counts.get(qualifiedName(h.symbol).toLowerCase());
                return symbolLine(h.index, h.symbol) + (notes ? ` [${notes} note${notes > 1 ? 's' : ''}]` : '');
            });
            return capOutput(lines.join('\n') + notice, 'Narrow the query or pass kind.', ctx.limits.maxChars);
        },
    }),

    defineTool({
        name: 'read_symbol',
        title: 'Read symbol source',
        description:
            'Source code of one symbol with line numbers: a function\'s declaration and its implementation, or a class/struct/enum declaration (large classes return their member outline instead). Use a qualified name like "UAgent::ToJsonObject" or "ACharacter::Jump" when a name exists in several classes. The project is searched before the engine.',
        input: {
            name: z.string().describe('Symbol name, e.g. "UAgent::ToJsonObject", "ACharacter::Jump" or "FAttachment"'),
            scope: scopeInput('all'),
        },
        run: ({ name, scope }, ctx) => {
            const where = scope ?? 'all';
            let index: SourceIndex = ctx.project;
            let matches: CodeSymbol[] = where === 'engine' ? [] : ctx.project.resolveSymbol(name);
            let engineNote = '';
            if (!matches.length && where !== 'project') {
                const state = engineState(ctx);
                if ('handle' in state) {
                    index = state.handle.index;
                    matches = state.handle.index.resolveSymbol(name, state.handle.rank);
                } else {
                    engineNote = ` (Engine not searched: ${state.message})`;
                }
            }
            if (!matches.length) {
                const { hits } = findHits(ctx, name, undefined, where, 8);
                return hits.length
                    ? `No symbol named "${name}". Did you mean:\n${hits.map(h => symbolLine(h.index, h.symbol)).join('\n')}`
                    : `No symbol named "${name}". Try find_symbol or search_code.${engineNote}`;
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
                    ctx.limits.maxChars,
                );
            }
            const first = matches[0];
            const span = first.endLine - first.startLine + 1;
            if (['class', 'struct', 'interface', 'enum'].includes(first.kind) && span > ctx.limits.maxReadLines) {
                const outline = renderFileOutline(index, first.file, { type: qualifiedName(first), maxChars: ctx.limits.maxChars });
                const notes = notesSection(ctx, [qualifiedName(first)], { members: true });
                return (
                    capOutput(
                        `${qualifiedName(first)} spans ${span} lines (${index.shortPath(first.file)}:${first.startLine}-${first.endLine}), more than one read, so here is its outline. ` +
                            `Use read_symbol("${qualifiedName(first)}::<member>") or read_lines for parts.\n\n${outline}`,
                        'Use read_symbol for one member.',
                        ctx.limits.maxChars,
                    ) + notes
                );
            }
            const ranges = new Map<string, SourceRange>();
            for (const s of matches) {
                ranges.set(`${s.file}:${s.startLine}`, { file: s.file, startLine: s.startLine, endLine: s.endLine });
                for (const d of s.definitions ?? []) {
                    ranges.set(`${d.file}:${d.startLine}`, d);
                }
            }
            const text = [...ranges.values()].map(r => numberedRange(ctx, index, r)).join('\n\n');
            // Notes about the symbol itself and the class it belongs to
            const notes = notesSection(ctx, [qualifiedName(first), first.container ?? ''], { members: ['class', 'struct', 'interface', 'enum'].includes(first.kind) });
            return capOutput(text, 'Use read_lines(path, start, end) for a specific part.', ctx.limits.maxChars) + notes;
        },
    }),

    defineTool({
        name: 'read_lines',
        title: 'Read lines',
        description: 'Read an exact line range of a project or engine file, with line numbers. Paths as in the other tools\' results.',
        input: {
            path: z.string().describe('File path or unique suffix'),
            start: z.number().int().min(1).describe('First line (1-based)'),
            end: z.number().int().min(1).optional().describe('Last line (default start + 99)'),
        },
        run: ({ path, start, end }, ctx) => {
            const { index, rel } = locateFile(ctx, path);
            const total = index.readFileLines(rel).length;
            if (start > total) {
                throw new Error(`${rel} has only ${total} lines`);
            }
            const last = Math.min(end ?? start + 99, start + ctx.limits.maxReadLines - 1, total);
            return capOutput(numberedRange(ctx, index, { file: rel, startLine: start, endLine: last }), 'Request a smaller range.', ctx.limits.maxChars);
        },
    }),

    defineTool({
        name: 'search_code',
        title: 'Search code',
        description:
            'Regex search across C++ source. Returns "file:line: text". scope "project" (default) searches the project; "engine" searches the engine modules and plugins the project uses, or with path_filter a module, plugin or folder (e.g. "Engine", "EnhancedInput", "GameFramework").',
        input: {
            pattern: z.string().describe('Regular expression (plain text also works)'),
            scope: scopeInput('project'),
            path_filter: z.string().optional().describe('Project: only paths containing this text. Engine: a module, plugin or folder name'),
            ignore_case: z.boolean().optional().describe('Case-insensitive (default true)'),
            max_results: z.number().int().min(1).max(100).optional().describe('Maximum matches (default 40)'),
        },
        run: async ({ pattern, scope, path_filter, ignore_case, max_results }, ctx) => {
            const where = scope ?? 'project';
            const ignoreCase = ignore_case !== false;
            const max = max_results ?? 40;
            const regex = toRegex(pattern, ignoreCase);
            const lines: string[] = [];
            const notes: string[] = [];
            let total = 0;

            if (where !== 'engine') {
                const filter = path_filter?.replace(/\\/g, '/').toLowerCase();
                const files = ctx.project.indexedFiles().filter(rel => !filter || rel.toLowerCase().includes(filter));
                const result = searchFiles(files, rel => ctx.project.readFileLines(rel), regex, max);
                lines.push(...result.hits.map(h => hitLine(ctx.project, h)));
                total += result.total;
            }
            if (where !== 'project' && lines.length < max) {
                const state = engineState(ctx);
                if (!('handle' in state)) {
                    if (where === 'engine') {
                        return state.message;
                    }
                    notes.push(`Engine not searched: ${state.message}`);
                } else {
                    const result = await searchEngineCode(state.handle, ctx.rgPath, { pattern, ignoreCase, filter: path_filter, maxResults: max - lines.length });
                    lines.push(...result.hits.map(h => hitLine(undefined, h)));
                    total += result.total;
                    notes.push(`Engine: searched ${result.label}${result.complete ? '' : '; stopped early, so there may be more'}.`);
                }
            }
            if (!lines.length) {
                return `No matches for /${pattern}/${ignoreCase ? 'i' : ''}.${notes.length ? `\n${notes.join('\n')}` : ''}`;
            }
            const more = total > lines.length ? `\n… ${total - lines.length}${total >= 2000 ? '+' : ''} more matches. Narrow the pattern or use path_filter.` : '';
            return capOutput(lines.join('\n') + more + (notes.length ? `\n${notes.join('\n')}` : ''), 'Narrow the pattern or use path_filter.', ctx.limits.maxChars);
        },
    }),

    defineTool({
        name: 'list_plugins',
        title: 'List plugins',
        description:
            'Plugins available to the project: its own, the engine\'s, and Marketplace/Fab plugins installed in the engine, with whether each is enabled and why, its description and modules. By default lists enabled and Marketplace plugins.',
        input: {
            query: z.string().optional().describe('Only plugins whose name, description or folder contains this text'),
            include_disabled: z.boolean().optional().describe('Also list plugins the project does not enable (default false)'),
        },
        run: ({ query, include_disabled }, ctx) => {
            const project = ctx.project.project;
            const state = engineState(ctx);
            const enginePlugins = 'handle' in state ? state.handle.index.plugins() : [];
            const enabled =
                'handle' in state
                    ? state.handle.enabled
                    : resolveEnabledPlugins({ refs: project.pluginRefs, disableEnginePluginsByDefault: project.disableEnginePluginsByDefault, projectPlugins: project.plugins, enginePlugins: [] });
            const q = query?.trim().toLowerCase();
            const seen = new Set<string>();
            const order = (p: PluginInfo) => {
                const reason = enabled.get(p.name.toLowerCase())?.reason;
                return p.category === 'project' ? 0 : reason === 'uproject' ? 1 : p.category === 'marketplace' ? 2 : reason === 'dependency' ? 3 : reason === 'default' ? 4 : 5;
            };
            const shown = [...project.plugins, ...enginePlugins]
                .filter(p => {
                    const key = p.name.toLowerCase();
                    if (seen.has(key)) {
                        return false;
                    }
                    seen.add(key);
                    return include_disabled || enabled.has(key) || p.category === 'marketplace';
                })
                .filter(p => !q || [p.name, p.friendlyName ?? '', p.description ?? '', p.dir].some(t => t.toLowerCase().includes(q)))
                .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));
            const scopeText = include_disabled ? 'all plugins' : 'enabled and Marketplace plugins (pass include_disabled for all)';
            const header = `${shown.length} ${scopeText}${query ? ` matching "${query}"` : ''}:`;
            const notice = 'handle' in state ? '' : `\n(Engine plugins not listed: ${state.message})`;
            return capOutput([header, ...shown.map(p => pluginLine(p, enabled.get(p.name.toLowerCase())))].join('\n') + notice, 'Pass a query to narrow the list.', ctx.limits.maxChars);
        },
    }),

    defineTool({
        name: 'find_references',
        title: 'Find references',
        description:
            'Where a symbol is used: calls, delegate and input bindings (AddDynamic, BindAction), overrides, and uses of types and properties, each with the function it is in. ' +
            'Found by name and sorted with the parser, so same-named members of other classes are left out and uncertain hits are marked. Use before changing a function or type.',
        input: {
            name: z.string().describe('Symbol, qualified when the name is common, e.g. "ACharacter::Jump", "FHouseLayout" or "OnHealthChanged"'),
            scope: scopeInput('all'),
            path_filter: z.string().optional().describe('Project: only paths containing this text. Engine: a module, plugin or folder name'),
            include_text: z.boolean().optional().describe('Also list other mentions: comments, strings, and a function name used without a call (default false)'),
            limit: z.number().int().min(1).max(200).optional().describe('Maximum references listed (default 50)'),
        },
        run: async ({ name, scope, path_filter, include_text, limit }, ctx) => {
            const result = await findReferences(ctx, name, { scope, pathFilter: path_filter, includeText: include_text });
            if ('error' in result) {
                return result.error;
            }
            return capOutput(renderReferences(result, limit ?? 50), 'Narrow with path_filter or scope.', ctx.limits.maxChars);
        },
    }),

    defineTool({
        name: 'callers',
        title: 'Callers',
        description:
            'Which functions call a function, or bind it to a delegate or input, and optionally who calls those (depth up to 3). Built on find_references, so it is name-based; ' +
            'calls from Blueprints and through function pointers are not traced.',
        input: {
            name: z.string().describe('Function, e.g. "ACharacter::Jump" or "UHouseSubsystem::Generate"'),
            depth: z.number().int().min(1).max(3).optional().describe('Levels of callers to follow (default 1)'),
            scope: scopeInput('all'),
            path_filter: z.string().optional().describe('Project: only paths containing this text. Engine: a module, plugin or folder name'),
        },
        run: async ({ name, depth, scope, path_filter }, ctx) => {
            const result = await findCallers(ctx, name, { depth, scope, pathFilter: path_filter });
            if ('error' in result) {
                return result.error;
            }
            return capOutput(renderCallers(result, 60), 'Lower depth or narrow with path_filter.', ctx.limits.maxChars);
        },
    }),

    defineTool({
        name: 'remember',
        title: 'Remember',
        readOnly: false,
        description:
            'Save a note to project memory so later sessions (and teammates) know it: a decision made, a non-obvious fact about the code, a gotcha, or an unfinished task. ' +
            'Keep it to one or two self-contained sentences and attach it to the symbols or files it is about. Check recall first to avoid duplicates.',
        input: {
            text: z.string().min(1).describe('The note: one or two self-contained sentences'),
            kind: z.enum(NOTE_KINDS).optional().describe('decision, fact, gotcha, task or summary (default fact)'),
            about: z.array(z.string()).optional().describe('Symbols or files it is about, e.g. ["AHouseActor::Rebuild", "HouseActor.cpp"]'),
        },
        run: ({ text, kind, about }, ctx) => {
            const store = requireMemory(ctx);
            const anchors = resolveAnchors(ctx, about ?? []);
            const note = store.add({ text, kind: kind ?? 'fact', about: anchors.about, fingerprints: anchors.fingerprints, source: ctx.source });
            const problems = anchors.notes.length ? ` Kept as plain tags: ${anchors.notes.join('; ')}.` : '';
            return `Saved ${note.kind} [${note.id}] to ${MEMORY_DIR}/${note.file}${note.about.length ? `, about ${note.about.join(', ')}` : ''}.${problems}`;
        },
    }),

    defineTool({
        name: 'recall',
        title: 'Recall',
        description:
            'Search project memory: decisions, facts, gotchas and tasks saved in earlier sessions. Filter by words, by a symbol or file (notes about a class include notes about its members), or by kind. ' +
            'Each note shows whether the code it is about changed since it was written.',
        input: {
            query: z.string().optional().describe('Words the note must contain'),
            about: z.string().optional().describe('A symbol or file, e.g. "AHouseActor" or "HouseActor.cpp"'),
            kind: z.enum(NOTE_KINDS).optional().describe('Only notes of this kind'),
            include_done: z.boolean().optional().describe('Include finished tasks (default false)'),
            limit: z.number().int().min(1).max(50).optional().describe('Maximum notes (default 20)'),
        },
        run: ({ query, about, kind, include_done, limit }, ctx) => {
            const store = requireMemory(ctx);
            let notes = store.list();
            if (about?.trim()) {
                const resolved = resolveAnchors(ctx, [about]).about;
                notes = notesAbout(notes, [...resolved, about], { members: true });
            }
            const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
            notes = notes.filter(
                n =>
                    (!kind || n.kind === kind) &&
                    (include_done || n.status !== 'done') &&
                    words.every(w => `${n.text} ${n.about.join(' ')}`.toLowerCase().includes(w)),
            );
            if (!notes.length) {
                const total = store.list().length;
                return total ? `No notes match. Project memory has ${total} notes; try fewer words or no filter.` : 'Project memory is empty.';
            }
            const max = limit ?? 20;
            const more = notes.length > max ? `\n… ${notes.length - max} more; narrow the search.` : '';
            return capOutput(`${notes.length} note${notes.length > 1 ? 's' : ''}:\n${notes.slice(0, max).map(n => noteLine(ctx, n)).join('\n')}${more}`, 'Narrow the search.', ctx.limits.maxChars);
        },
    }),

    defineTool({
        name: 'update_note',
        title: 'Update note',
        readOnly: false,
        description:
            'Change a project memory note: its text, kind, what it is about, or a task\'s status (mark it done). Called with only an id, it confirms that a note flagged as possibly outdated still holds for the current code.',
        input: {
            id: z.string().describe('The note id, e.g. "k3f9a2"'),
            text: z.string().optional().describe('New text'),
            kind: z.enum(NOTE_KINDS).optional().describe('New kind'),
            about: z.array(z.string()).optional().describe('New symbols or files it is about (replaces the old ones)'),
            status: z.enum(['open', 'done']).optional().describe('For tasks'),
        },
        run: ({ id, text, kind, about, status }, ctx) => {
            const store = requireMemory(ctx);
            const current = store.get(id);
            if (!current) {
                throw new Error(`No note with id "${id}". recall lists the notes and their ids.`);
            }
            // Re-fingerprint the anchors either way: the note now describes the current code
            const anchors = resolveAnchors(ctx, about ?? current.about);
            const wasOutdated = checkNote(ctx, current);
            const note = store.update(current.id, { text, kind, status, about: anchors.about, fingerprints: anchors.fingerprints });
            const confirmed = !text && !kind && !about && !status && (wasOutdated.changed.length || wasOutdated.missing.length) ? ' Confirmed against the current code.' : '';
            const problems = anchors.notes.length ? ` Kept as plain tags: ${anchors.notes.join('; ')}.` : '';
            return `Updated ${note.kind}${note.status ? ` (${note.status})` : ''} [${note.id}]: ${note.text}${confirmed}${problems}`;
        },
    }),

    defineTool({
        name: 'forget',
        title: 'Forget',
        readOnly: false,
        destructive: true,
        description: 'Delete a project memory note that is wrong or no longer useful.',
        input: {
            id: z.string().describe('The note id, e.g. "k3f9a2"'),
        },
        run: ({ id }, ctx) => {
            const note = requireMemory(ctx).remove(id);
            return `Deleted ${note.kind} [${note.id}]: ${note.text}`;
        },
    }),
];

export const TOOL_NAMES = TOOLS.map(t => t.name);

/** Runs a tool by name with unvalidated input, as the chat participant receives it from the model. */
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<{ text: string; isError: boolean }> {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) {
        return { text: `Unknown tool "${name}". Tools: ${TOOL_NAMES.join(', ')}`, isError: true };
    }
    const parsed = z.object(tool.input).safeParse(input ?? {});
    if (!parsed.success) {
        return { text: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`, isError: true };
    }
    try {
        return { text: await tool.run(parsed.data, ctx), isError: false };
    } catch (e: any) {
        return { text: `Error: ${e?.message ?? e}`, isError: true };
    }
}

/** JSON Schema of a tool's input, kept plain for small models: no $schema, no default integer bounds. */
export function toolJsonSchema(tool: ToolDef<any>): Record<string, unknown> {
    const schema = z.toJSONSchema(z.object(tool.input), { target: 'draft-7', io: 'input' }) as Record<string, any>;
    delete schema.$schema;
    for (const prop of Object.values<Record<string, unknown>>(schema.properties ?? {})) {
        if (prop.minimum === Number.MIN_SAFE_INTEGER) {
            delete prop.minimum;
        }
        if (prop.maximum === Number.MAX_SAFE_INTEGER) {
            delete prop.maximum;
        }
    }
    return schema;
}
