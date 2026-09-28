import { ProjectIndex, qualifiedName } from './indexer';
import { compactSpecifiers } from './parse';
import { CodeSymbol, ModuleInfo, SourceIndex, SymbolKind } from './types';

const TYPE_KINDS = new Set<SymbolKind>(['class', 'struct', 'interface']);
const MAX_NAMES = 25;
/** Modules with more files than this get a folder summary unless a filter is given. */
export const MODULE_FILE_LIMIT = 60;

export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
export const isHeader = (rel: string) => /\.(h|hpp|hh|inl)$/i.test(rel);

const byLine = (a: CodeSymbol, b: CodeSymbol) => a.line - b.line;
const stripUparam = (s: string) => s.replace(/UPARAM\s*\((?:[^()]|\([^()]*\))*\)\s*/g, '');

export function nameList(names: string[], max = MAX_NAMES): string {
    const unique = [...new Set(names)];
    return unique.length > max ? `${unique.slice(0, max).join(', ')}, … (+${unique.length - max})` : unique.join(', ');
}

function macroLabel(s: CodeSymbol): string {
    if (!s.ue || s.kind === 'delegate') {
        return '';
    }
    return `${s.ue.name}(${compactSpecifiers(s.ue.args)}) `;
}

/** "UAgent (UCLASS : UXAPIActor, IJsonModel)" */
export function typeSummary(s: CodeSymbol): string {
    const tag = s.kind === 'delegate' ? 'delegate' : s.ue?.name ?? s.kind;
    const bases = s.bases?.length ? ` : ${s.bases.join(', ')}` : '';
    return `${s.name} (${tag}${bases})`;
}

export function moduleRelative(module: ModuleInfo | undefined, rel: string): string {
    return module && rel.toLowerCase().startsWith(module.dir.toLowerCase() + '/') ? rel.slice(module.dir.length + 1) : rel;
}

/** Symbols in `rel` that are not members of a type declared in the same file. */
function rootSymbols(index: SourceIndex, rel: string): CodeSymbol[] {
    const symbols = index.symbolsInFile(rel);
    const localTypes = new Set(symbols.filter(s => TYPE_KINDS.has(s.kind)).map(qualifiedName));
    return symbols.filter(s => !s.container || !localTypes.has(s.container)).sort(byLine);
}

/**
 * One-line summary of what a file declares, for INDEX.md. Implementation files only report
 * types, so file-local helpers and globals in .cpp files don't clutter the index.
 */
export function fileSummary(index: SourceIndex, rel: string): string {
    const parts: string[] = [];
    const roots = rootSymbols(index, rel);
    for (const s of roots) {
        if (TYPE_KINDS.has(s.kind) || s.kind === 'enum' || s.kind === 'delegate') {
            parts.push(typeSummary(s));
        }
    }
    if (!isHeader(rel)) {
        return parts.join('; ');
    }
    const constantsByNamespace = new Map<string, number>();
    for (const s of roots.filter(s => s.kind === 'variable' && s.container && !index.isType(s.container))) {
        constantsByNamespace.set(s.container!, (constantsByNamespace.get(s.container!) ?? 0) + 1);
    }
    for (const [ns, count] of constantsByNamespace) {
        parts.push(`namespace ${ns} (${count} constants)`);
    }
    const freeFunctions = roots.filter(s => s.kind === 'function' && !index.isType(s.container));
    if (freeFunctions.length) {
        parts.push(`functions: ${nameList(freeFunctions.map(qualifiedName), 8)}`);
    }
    return parts.join('; ');
}

/** How file paths are printed: shortest unique suffix (tools resolve these) or full project-relative path. */
type PathStyle = (rel: string) => string;

function renderSymbols(index: SourceIndex, list: CodeSymbol[], all: CodeSymbol[], indent: string, out: string[], pathOf: PathStyle) {
    let lastAccess: string | undefined;
    for (let i = 0; i < list.length; i++) {
        const s = list[i];

        if (s.access && s.access !== lastAccess && indent) {
            out.push(`${indent.slice(2)}${s.access}:`);
            lastAccess = s.access;
        }

        if (s.kind === 'variable') {
            // Collapse runs of variables in the same namespace into one line
            let j = i;
            while (j + 1 < list.length && list[j + 1].kind === 'variable' && list[j + 1].container === s.container) {
                j++;
            }
            const run = list.slice(i, j + 1);
            const label = s.container && !index.isType(s.container) ? `namespace ${s.container} constants` : 'variables';
            out.push(`${indent}L${run[0].line}-${run[run.length - 1].line} ${label}: ${nameList(run.map(v => v.name))}`);
            i = j;
            continue;
        }

        const signature = stripUparam(s.signature);
        switch (s.kind) {
            case 'class':
            case 'struct':
            case 'interface': {
                out.push(`${indent}L${s.startLine}-${s.endLine} ${macroLabel(s)}${signature}`);
                const members = all.filter(m => m.container === qualifiedName(s)).sort(byLine);
                renderSymbols(index, members, all, indent + '    ', out, pathOf);
                break;
            }
            case 'enum': {
                const members = s.members?.length ? ` { ${nameList(s.members, 15)} }` : '';
                out.push(`${indent}L${s.startLine}-${s.endLine} ${macroLabel(s)}${signature}${members}`);
                break;
            }
            case 'function': {
                const range = s.isDefinition ? `${s.startLine}-${s.endLine}` : `${s.line}`;
                const defs = s.definitions?.length
                    ? `  → ${s.definitions.map(d => `${pathOf(d.file)}:${d.startLine}-${d.endLine}`).join(', ')}`
                    : '';
                out.push(`${indent}L${range} ${macroLabel(s)}${signature}${defs}`);
                break;
            }
            default:
                out.push(`${indent}L${s.line} ${macroLabel(s)}${signature}`);
        }
    }
}

/** Types with their member names and lines only: for files whose full outline is too long. */
function renderCompact(list: CodeSymbol[], all: CodeSymbol[], indent: string, out: string[]) {
    for (const s of list) {
        if (!TYPE_KINDS.has(s.kind)) {
            const range = s.kind === 'enum' || (s.kind === 'function' && s.isDefinition) ? `${s.startLine}-${s.endLine}` : `${s.line}`;
            out.push(`${indent}L${range} ${s.kind} ${s.name}`);
            continue;
        }
        out.push(`${indent}L${s.startLine}-${s.endLine} ${macroLabel(s)}${stripUparam(s.signature)}`);
        const members = all.filter(m => m.container === qualifiedName(s)).sort(byLine);
        const groups: [string, CodeSymbol[]][] = [
            ['functions', members.filter(m => m.kind === 'function')],
            ['properties', members.filter(m => m.kind === 'property' || m.kind === 'variable')],
            ['other', members.filter(m => !TYPE_KINDS.has(m.kind) && !['function', 'property', 'variable'].includes(m.kind))],
        ];
        for (const [label, group] of groups) {
            if (group.length) {
                out.push(`${indent}  ${label}: ${group.map(m => `${m.name} L${m.line}`).join(', ')}`);
            }
        }
        renderCompact(members.filter(m => TYPE_KINDS.has(m.kind)), all, indent + '  ', out);
    }
}

export interface FileOutlineOptions {
    /** Print full paths (static files) instead of the index's short paths (tool output). */
    fullPaths?: boolean;
    /** Only this type (class, struct, enum, …) and its members. */
    type?: string;
    /** Switch to a compact outline (member names and lines) when the full one is longer than this. */
    maxChars?: number;
}

/**
 * Every declaration in a file with line numbers, and where each declared function is implemented.
 * Tool output uses short paths; static files use full project-relative paths so a plain
 * file-reading agent can open the source directly.
 */
export function renderFileOutline(index: SourceIndex, rel: string, options: FileOutlineOptions = {}): string {
    const pathOf: PathStyle = options.fullPaths ? p => p : p => index.shortPath(p);
    const all = index.symbolsInFile(rel);
    let roots = rootSymbols(index, rel);
    const heading = `### ${pathOf(rel)} (${index.lineCount(rel)} lines)`;

    if (options.type) {
        const wanted = options.type.trim().toLowerCase();
        const named = all.filter(s => s.name.toLowerCase() === wanted || qualifiedName(s).toLowerCase() === wanted);
        // A class and its constructors share a name
        const types = named.filter(s => TYPE_KINDS.has(s.kind) || s.kind === 'enum');
        const matches = types.length ? types : named;
        if (!matches.length) {
            const types = roots.filter(s => TYPE_KINDS.has(s.kind) || s.kind === 'enum').map(s => s.name);
            throw new Error(`${pathOf(rel)} declares no "${options.type}". Types in it: ${types.join(', ') || 'none'}`);
        }
        roots = matches.sort(byLine);
    }

    const out = [heading];
    if (!roots.length) {
        out.push('(no declarations)');
    }
    renderSymbols(index, roots, all, '', out, pathOf);
    const full = out.join('\n');
    if (!options.maxChars || full.length <= options.maxChars) {
        return full;
    }
    const compact = [`${heading} — compact outline (member names and lines); the full outline is ${estimateTokens(full)} tokens`];
    renderCompact(roots, all, '', compact);
    compact.push('Use get_file_outline with type for one class, read_symbol for one member, or read_lines for a range.');
    return compact.join('\n');
}

/** Where the static outline of a source file is written, relative to .llm-index/. */
export function outlineFilePath(module: ModuleInfo | undefined, rel: string): string {
    return `files/${module?.name ?? '_Other'}/${moduleRelative(module, rel)}.md`;
}

function moduleHeader(module: ModuleInfo): string[] {
    const meta = [module.type, module.plugin ? `plugin ${module.plugin}` : 'game module'].filter(Boolean).join(', ');
    const deps = [
        module.publicDeps.length ? `public ${module.publicDeps.join(', ')}` : '',
        module.privateDeps.length ? `private ${module.privateDeps.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    return [`## Module ${module.name} (${meta})`, `Dir: ${module.dir}`, `Depends on: ${deps || 'nothing listed'}`];
}

const headersFirst = (a: string, b: string) => Number(!isHeader(a)) - Number(!isHeader(b)) || a.localeCompare(b);

/** Folders of a large module with some of their header names, so the caller can pick a filter. */
function renderModuleFolders(module: ModuleInfo): string {
    const folders = new Map<string, string[]>();
    const privateFolders = new Set<string>();
    let privateFiles = 0;
    for (const rel of module.files) {
        const local = moduleRelative(module, rel);
        const slash = local.lastIndexOf('/');
        const folder = slash === -1 ? '.' : local.slice(0, slash);
        if (/^(private|internal)(\/|$)/i.test(folder)) {
            privateFiles++;
            privateFolders.add(folder);
        } else {
            folders.set(folder, [...(folders.get(folder) ?? []), local.slice(slash + 1)]);
        }
    }
    const out = [...moduleHeader(module), `${module.files.length} files, too many to outline at once. Folders, with some of their headers:`];
    for (const [folder, files] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) {
        out.push(`- ${folder}/ (${files.length}): ${nameList(files.filter(isHeader).sort(), 8) || 'implementation only'}`);
    }
    if (privateFiles) {
        out.push(`- Private/: ${privateFiles} implementation files in ${privateFolders.size} folders`);
    }
    const example = [...folders.keys()].find(f => f !== '.') ?? 'Public';
    out.push(`Call get_module_outline("${module.name}", filter) with a folder or file name, e.g. "${example}", or get_file_outline(path).`);
    return out.join('\n');
}

export interface ModuleSummaryOptions {
    /** Only files whose module-relative path contains this text (case-insensitive). */
    filter?: string;
    /** Above this many files, list folders instead. Defaults to MODULE_FILE_LIMIT; 0 means no limit. */
    maxFiles?: number;
    /** Mention the static per-file outlines in .llm-index/files/ (project modules only). */
    outlineFiles?: boolean;
}

/**
 * Classes of one module with their member names: small enough for one tool call.
 * Also written to .llm-index/modules/<Module>.md.
 */
export function renderModuleSummary(index: SourceIndex, module: ModuleInfo, options: ModuleSummaryOptions = {}): string {
    const filter = options.filter?.trim().replace(/\\/g, '/').toLowerCase();
    let files = module.files;
    if (filter) {
        files = files.filter(rel => moduleRelative(module, rel).toLowerCase().includes(filter));
        if (!files.length) {
            throw new Error(`No files in module ${module.name} match "${options.filter}".`);
        }
    }
    const maxFiles = options.maxFiles ?? MODULE_FILE_LIMIT;
    if (maxFiles && files.length > maxFiles) {
        return renderModuleFolders({ ...module, files });
    }

    const out = [...moduleHeader(module)];
    if (options.outlineFiles) {
        out.push(`File outlines: .llm-index/files/${module.name}/<path>.md`);
    }
    if (filter) {
        out.push(`Files matching "${options.filter}": ${files.length} of ${module.files.length}`);
    }
    const implementationOnly: string[] = [];
    for (const rel of [...files].sort(headersFirst)) {
        const roots = rootSymbols(index, rel);
        const types = roots.filter(s => TYPE_KINDS.has(s.kind) || s.kind === 'enum' || s.kind === 'delegate');
        if (!types.length && !isHeader(rel)) {
            implementationOnly.push(moduleRelative(module, rel));
            continue;
        }
        const summary = fileSummary(index, rel);
        out.push(`${moduleRelative(module, rel)}${summary && !types.length ? ` — ${summary}` : ''}`);
        for (const t of types) {
            const members = index.symbolsInFile(rel).filter(m => m.container === qualifiedName(t));
            const fns = members.filter(m => m.kind === 'function').map(m => m.name);
            const props = members.filter(m => m.kind === 'property').map(m => m.name);
            const detail = [
                fns.length ? `fn: ${nameList(fns)}` : '',
                props.length ? `props: ${nameList(props)}` : '',
                t.members?.length ? `values: ${nameList(t.members, 15)}` : '',
            ].filter(Boolean).join(' | ');
            out.push(`  ${typeSummary(t)} L${t.line}${detail ? ` — ${detail}` : ''}`);
        }
    }
    if (implementationOnly.length) {
        out.push(`Implementation files: ${implementationOnly.join(', ')}`);
    }
    return out.join('\n');
}

export const UNREAL_CONVENTIONS =
    'Unreal conventions: UCLASS/USTRUCT/UENUM/UINTERFACE mark reflected types, UFUNCTION/UPROPERTY mark reflected members. ' +
    'Type prefixes: U = UObject, A = Actor, F = plain struct/class, I = interface, E = enum, T = template. ' +
    '*.generated.h files are produced by the build and are not indexed.';

/** A real module and header from the project, used to make instructions concrete. */
export function exampleFile(index: ProjectIndex): { module: ModuleInfo; rel: string; qualified?: string } | undefined {
    for (const module of index.project.modules) {
        for (const rel of module.files.filter(isHeader)) {
            const symbols = index.symbolsInFile(rel);
            for (const type of symbols.filter(s => TYPE_KINDS.has(s.kind))) {
                // A regular method with an implementation, not a constructor
                const member = symbols.find(
                    s => s.kind === 'function' && s.container === qualifiedName(type) && s.name !== type.name && s.definitions?.length,
                );
                if (member) {
                    return { module, rel, qualified: qualifiedName(member) };
                }
            }
        }
    }
    const module = index.project.modules.find(m => m.files.some(isHeader));
    return module && { module, rel: module.files.find(isHeader)! };
}

function renderPreamble(index: ProjectIndex): string {
    const example = exampleFile(index);
    const outline = example ? `.llm-index/${outlineFilePath(example.module, example.rel)}` : '.llm-index/files/<Module>/<path>.md';
    const source = example ? example.rel : '<Dir>/<path>';
    const symbol = example?.qualified ?? 'AMyActor::BeginPlay';
    return [
        '## How to use this index',
        'A compact map of this Unreal Engine project\'s C++ source. Read it first, then look up only what you need instead of opening whole files.',
        '',
        'With plain file reading:',
        `- .llm-index/modules/<Module>.md lists a module's classes with their function and property names.`,
        `- .llm-index/files/<Module>/<path>.md outlines one file: declarations, line numbers, and "→ file:lines" links to implementations. Example: ${outline}`,
        `- Then read only those line ranges of the source file (<Dir>/<path>, e.g. ${source}).`,
        '',
        'With the unreal-llm-index MCP tools (if available, prefer them):',
        `- get_module_outline(module), get_file_outline(path), find_symbol(query), read_symbol(name) such as "${symbol}", read_lines(path, start, end), search_code(pattern), list_plugins(query).`,
        '- find_references(name) lists where something is used (calls, delegate and input bindings, overrides); callers(name, depth) traces who calls a function.',
        '- find_symbol, read_symbol and search_code take scope "project", "engine" or "all", so engine classes (e.g. ACharacter) and engine or Marketplace plugin code can be looked up too.',
        '- Tools accept any unique path suffix, such as the file name alone. Engine paths start with "Engine/".',
        '- Project memory: recall(query or about) finds notes from earlier sessions; remember(text, kind, about) saves decisions, facts, gotchas and unfinished tasks. Without the tools, the notes are the files in .llm-memory/.',
        '',
        'Paths listed under each module below are relative to that module\'s Dir. Line numbers are 1-based.',
        UNREAL_CONVENTIONS,
    ].join('\n');
}

export interface IndexOptions {
    /** Markdown lines describing the engine, from renderEngineSection. */
    engineSection?: string[];
    /** Markdown lines with open tasks and recent notes, from renderMemorySection. */
    memorySection?: string[];
}

export function renderIndex(index: ProjectIndex, options: IndexOptions = {}): string {
    const project = index.project;
    const symbols = index.allSymbols();
    const engine = /^\{?[0-9A-F-]{36}\}?$/i.test(project.engineAssociation)
        ? `source build ${project.engineAssociation}`
        : project.engineAssociation || 'unknown';

    const out = [
        `# LLM index: ${project.name}`,
        '',
        `Generated by unreal-llm-index on ${index.generatedAt.toISOString().slice(0, 16).replace('T', ' ')}. ${index.indexedFiles().length} source files, ${symbols.length} symbols.`,
        '',
        renderPreamble(index),
        '',
        '## Project',
        `- Unreal Engine: ${engine}`,
    ];
    if (project.enabledPlugins.length) {
        out.push(`- Plugins enabled in .uproject: ${project.enabledPlugins.join(', ')}`);
    }
    for (const plugin of project.plugins) {
        const description = plugin.description ? ` — ${plugin.description.replace(/\s+/g, ' ')}` : '';
        out.push(`- Project plugin ${plugin.name} (${plugin.dir})${description}`);
    }
    if (options.engineSection?.length) {
        out.push('', ...options.engineSection);
    }
    if (options.memorySection?.length) {
        out.push('', ...options.memorySection);
    }

    out.push('', '## Modules');
    for (const module of project.modules) {
        out.push('', ...moduleHeader(module).map((line, i) => (i === 0 ? line.replace(/^## /, '### ') : line)));
        const implementation: string[] = [];
        for (const rel of [...module.files].sort(headersFirst)) {
            const summary = fileSummary(index, rel);
            if (!summary && !isHeader(rel)) {
                implementation.push(moduleRelative(module, rel));
            } else {
                out.push(`- ${moduleRelative(module, rel)}${summary ? `: ${summary}` : ''}`);
            }
        }
        if (implementation.length) {
            out.push(`- Implementation: ${implementation.join(', ')}`);
        }
    }

    if (project.looseFiles.length) {
        out.push('', '## Other source files');
        for (const rel of project.looseFiles) {
            const summary = fileSummary(index, rel);
            out.push(`- ${rel}${summary ? `: ${summary}` : ''}`);
        }
    }
    return out.join('\n') + '\n';
}
