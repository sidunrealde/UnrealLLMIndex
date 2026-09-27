import { ProjectIndex, qualifiedName } from './indexer';
import { compactSpecifiers } from './parse';
import { CodeSymbol, ModuleInfo, SymbolKind } from './types';

const TYPE_KINDS = new Set<SymbolKind>(['class', 'struct', 'interface']);
const MAX_NAMES = 25;

export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
export const isHeader = (rel: string) => /\.(h|hpp|hh|inl)$/i.test(rel);

const byLine = (a: CodeSymbol, b: CodeSymbol) => a.line - b.line;
const stripUparam = (s: string) => s.replace(/UPARAM\s*\((?:[^()]|\([^()]*\))*\)\s*/g, '');

function nameList(names: string[], max = MAX_NAMES): string {
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
function rootSymbols(index: ProjectIndex, rel: string): CodeSymbol[] {
    const symbols = index.symbolsInFile(rel);
    const localTypes = new Set(symbols.filter(s => TYPE_KINDS.has(s.kind)).map(qualifiedName));
    return symbols.filter(s => !s.container || !localTypes.has(s.container)).sort(byLine);
}

/**
 * One-line summary of what a file declares, for INDEX.md. Implementation files only report
 * types, so file-local helpers and globals in .cpp files don't clutter the index.
 */
export function fileSummary(index: ProjectIndex, rel: string): string {
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

function renderSymbols(index: ProjectIndex, list: CodeSymbol[], all: CodeSymbol[], indent: string, out: string[]) {
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
                renderSymbols(index, members, all, indent + '    ', out);
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
                    ? `  → ${s.definitions.map(d => `${index.shortPath(d.file)}:${d.startLine}-${d.endLine}`).join(', ')}`
                    : '';
                out.push(`${indent}L${range} ${macroLabel(s)}${signature}${defs}`);
                break;
            }
            default:
                out.push(`${indent}L${s.line} ${macroLabel(s)}${signature}`);
        }
    }
}

/** Every declaration in a file with line numbers, and where each declared function is implemented. */
export function renderFileOutline(index: ProjectIndex, rel: string): string {
    const out = [`### ${index.shortPath(rel)} (${index.lineCount(rel)} lines)`];
    const roots = rootSymbols(index, rel);
    if (!roots.length) {
        out.push('(no declarations)');
    }
    renderSymbols(index, roots, index.symbolsInFile(rel), '', out);
    return out.join('\n');
}

function moduleHeader(module: ModuleInfo): string[] {
    const meta = [module.type, module.plugin ? `plugin ${module.plugin}` : 'game module'].filter(Boolean).join(', ');
    const deps = [
        module.publicDeps.length ? `public ${module.publicDeps.join(', ')}` : '',
        module.privateDeps.length ? `private ${module.privateDeps.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    return [`## Module ${module.name} (${meta})`, `Dir: ${module.dir}`, `Depends on: ${deps || 'nothing listed'}`];
}

/** Classes of one module with their member names: small enough for one tool call. */
export function renderModuleSummary(index: ProjectIndex, module: ModuleInfo): string {
    const out = moduleHeader(module);
    const implementationOnly: string[] = [];
    for (const rel of [...module.files].sort((a, b) => Number(!isHeader(a)) - Number(!isHeader(b)) || a.localeCompare(b))) {
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

/** Full outline of every file in a module (headers first). Written to .llm-index/modules/<Module>.md. */
export function renderModuleOutline(index: ProjectIndex, module: ModuleInfo): string {
    const files = [...module.files].sort((a, b) => Number(!isHeader(a)) - Number(!isHeader(b)) || a.localeCompare(b));
    return [moduleHeader(module).join('\n'), ...files.map(rel => renderFileOutline(index, rel))].join('\n\n') + '\n';
}

export const INDEX_PREAMBLE = `## How to use this index
This is a compact map of the project's C++ source. Read it first, then fetch only what you need instead of opening whole files:
- get_file_outline(path): every declaration in one file, with line numbers and where each function is implemented.
- get_module_outline(module): the classes of one module and their member names.
- find_symbol(query): find a class, function, property, enum or delegate by full or partial name.
- read_symbol(name): the source of one symbol only, e.g. "UAgent::ToJsonObject" (declaration and implementation) or "UAgent" (class declaration).
- read_lines(path, start, end): an exact line range (max 200 lines).
- search_code(pattern): regex search across the project's source files.
File paths below are relative to their module's Dir. Tools accept any unique path suffix ("Public/Agent.h" or "Agent.h"). Line numbers are 1-based.
Without tools: full outlines are in .llm-index/modules/<Module>.md.
Unreal conventions: UCLASS/USTRUCT/UENUM/UINTERFACE mark reflected types, UFUNCTION/UPROPERTY mark reflected members. Type prefixes: U = UObject, A = Actor, F = plain struct/class, I = interface, E = enum, T = template.`;

export function renderIndex(index: ProjectIndex): string {
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
        INDEX_PREAMBLE,
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

    out.push('', '## Modules');
    for (const module of project.modules) {
        out.push('', ...moduleHeader(module).map((line, i) => (i === 0 ? line.replace(/^## /, '### ') : line)));
        const implementation: string[] = [];
        for (const rel of [...module.files].sort((a, b) => Number(!isHeader(a)) - Number(!isHeader(b)) || a.localeCompare(b))) {
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
