import { qualifiedName } from './indexer';
import { searchEngineCode } from './codeSearch';
import { searchFiles } from './search';
import type { ToolContext } from './tools';
import { CodeSymbol, SourceIndex, SymbolKind } from './types';

/**
 * Finds where a symbol is used, by name. There is no compiler here: references are occurrences
 * of the name, sorted out with the parser (declarations, overrides, the function each hit is in)
 * and Unreal conventions (delegate and input bindings, Super::, _Implementation/_Validate).
 */

export type ReferenceKind = 'call' | 'binding' | 'override' | 'base' | 'use' | 'mention';

export interface ReferenceHit {
    index: SourceIndex;
    file: string;
    line: number;
    text: string;
    kind: ReferenceKind;
    /** The innermost function or type the hit is in. */
    enclosing?: { name: string; line: number };
    /** False for a class member when nothing in the file ties the hit to that class. */
    likely: boolean;
}

export interface ReferenceTarget {
    /** What is searched for, e.g. "ACharacter::Jump". */
    label: string;
    /** The bare name, e.g. "Jump". */
    simple: string;
    kind?: SymbolKind;
    /** For class members: the class. */
    className?: string;
    /** The class, its base classes and the project's subclasses of it. */
    related: Set<string>;
    /** The class's base classes. */
    ancestors: Set<string>;
    /** The symbol's own declarations and definitions, which aren't reported as references. */
    own: CodeSymbol[];
    blueprint: boolean;
}

export interface ReferenceResult {
    target: ReferenceTarget;
    hits: ReferenceHit[];
    /** Whether other mentions (comments, strings, same-named variables) are among the hits. */
    textIncluded: boolean;
    skipped: { text: number; otherMembers: number; unanalyzed: number };
    notes: string[];
}

export interface ReferenceOptions {
    scope?: 'project' | 'engine' | 'all';
    pathFilter?: string;
    /** Also report other mentions: in comments and strings, and a function's name used without a call. */
    includeText?: boolean;
}

const MAX_MATCHES = 2000;
const MAX_FILES = 150;
const TYPE_KINDS = new Set<SymbolKind>(['class', 'struct', 'interface', 'enum', 'delegate', 'alias']);
const BINDING_CALLS =
    /\b(Add(Unique)?Dynamic|RemoveDynamic|BindDynamic|AddUObject|AddRaw|AddSP|AddLambda|AddStatic|AddWeakLambda|BindUObject|BindRaw|BindSP|BindStatic|BindUFunction|BindWeakLambda|BindAction|BindAxis|BindKey|BindTouch|CreateUObject|CreateRaw|CreateSP|CreateStatic|CreateUFunction|GET_FUNCTION_NAME_CHECKED|GET_MEMBER_NAME_CHECKED)\b/;
const BLUEPRINT_SPECIFIERS = /\bBlueprint(Callable|Pure|ImplementableEvent|NativeEvent|ReadWrite|ReadOnly|Assignable|Authority)\b|\bExec\b/;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const baseName = (name: string) => name.replace(/<.*$/, '').trim().split('::').pop() ?? name;

/** True if the column is inside a string literal on this line. */
function inString(line: string, col: number): boolean {
    let quotes = 0;
    for (let i = 0; i < col; i++) {
        if (line[i] === '\\') {
            i++;
        } else if (line[i] === '"') {
            quotes++;
        }
    }
    return quotes % 2 === 1;
}

function inComment(line: string, col: number): boolean {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        return true;
    }
    for (let i = line.indexOf('//'); i !== -1 && i < col; i = line.indexOf('//', i + 2)) {
        if (!inString(line, i)) {
            return true;
        }
    }
    return false;
}

/** How strongly an occurrence says "this uses the symbol"; the strongest occurrence on a line wins. */
const RANK: Record<ReferenceKind | 'text', number> = { binding: 5, call: 4, override: 3, base: 3, use: 2, mention: 1, text: 0 };

/** Innermost function body or type that contains the line. */
function enclosingSymbol(symbols: CodeSymbol[], line: number): CodeSymbol | undefined {
    let best: CodeSymbol | undefined;
    for (const s of symbols) {
        const container = (s.kind === 'function' && s.isDefinition) || s.kind === 'class' || s.kind === 'struct' || s.kind === 'interface';
        if (container && s.startLine <= line && line <= s.endLine && (!best || s.endLine - s.startLine < best.endLine - best.startLine)) {
            best = s;
        }
    }
    return best;
}

/** A class's base classes, all the way up, from the project and the engine. */
function ancestors(ctx: ToolContext, className: string): string[] {
    const found: string[] = [];
    const queue = [className];
    const engine = ctx.engine?.state();
    const handle = engine && 'handle' in engine ? engine.handle : undefined;
    while (queue.length && found.length < 30) {
        const name = queue.shift()!;
        const types = [...ctx.project.resolveSymbol(name), ...(handle ? handle.index.resolveSymbol(name, handle.rank) : [])].filter(s =>
            ['class', 'struct', 'interface'].includes(s.kind),
        );
        for (const base of types.flatMap(t => t.bases ?? []).map(baseName)) {
            if (base && base !== className && !found.includes(base)) {
                found.push(base);
                queue.push(base);
            }
        }
    }
    return found;
}

/** Project classes that derive from any of `names`, directly or not. */
function projectSubclasses(ctx: ToolContext, names: Set<string>): string[] {
    const types = ctx.project.allSymbols().filter(s => ['class', 'struct', 'interface'].includes(s.kind) && s.bases?.length);
    const found = new Set<string>();
    for (let changed = true; changed; ) {
        changed = false;
        for (const t of types) {
            if (!found.has(t.name) && !names.has(t.name) && t.bases!.map(baseName).some(b => names.has(b) || found.has(b))) {
                found.add(t.name);
                changed = true;
            }
        }
    }
    return [...found];
}

/** The symbol to search for, or an explanation when the name is ambiguous or unsupported. */
export function resolveTarget(ctx: ToolContext, name: string): ReferenceTarget | { error: string } {
    const q = name.trim().replace(/\(\)$/, '').replace(/\s*::\s*/g, '::');
    if (!q) {
        return { error: 'Pass a symbol name, e.g. "ACharacter::Jump" or "FHouseLayout".' };
    }
    if (/\boperator\b/.test(q)) {
        return { error: 'References to operators can\'t be found by name. Search for their uses with search_code.' };
    }
    const engine = ctx.engine?.state();
    const handle = engine && 'handle' in engine ? engine.handle : undefined;
    const own = [...ctx.project.resolveSymbol(q), ...(handle ? handle.index.resolveSymbol(q, handle.rank) : [])];
    const names = [...new Set(own.map(qualifiedName))];
    if (names.length > 1) {
        return { error: `"${name}" is ambiguous; pass one of: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}` };
    }
    const symbol = own[0];
    const simple = symbol?.name ?? q.split('::').pop()!;
    if (!/^[A-Za-z_]\w*$/.test(simple)) {
        return { error: `"${simple}" isn't a plain identifier, so it can't be searched for as a name.` };
    }
    const container = symbol?.container ?? (q.includes('::') ? q.slice(0, q.lastIndexOf('::')) : undefined);
    const isMember = !!container && (ctx.project.isType(container) || !!handle?.index.isType(container) || !symbol);
    const className = isMember ? baseName(container!) : undefined;
    const related = new Set<string>();
    const bases = new Set(className ? ancestors(ctx, className) : []);
    if (className) {
        related.add(className);
        bases.forEach(n => related.add(n));
        projectSubclasses(ctx, new Set([className])).forEach(n => related.add(n));
    }
    const blueprint = own.some(s => s.ue && BLUEPRINT_SPECIFIERS.test(s.ue.args));
    return { label: names[0] ?? q, simple, kind: symbol?.kind, className, related, ancestors: bases, own, blueprint };
}

interface RawMatch {
    engine: boolean;
    file: string;
    line: number;
    text: string;
}

/**
 * Where a symbol is used. Declarations and definitions of the symbol itself are left out, and
 * so are same-named members of unrelated classes.
 */
export async function findReferences(ctx: ToolContext, name: string, options: ReferenceOptions = {}): Promise<ReferenceResult | { error: string }> {
    const target = resolveTarget(ctx, name);
    if ('error' in target) {
        return target;
    }
    const scope = options.scope ?? 'all';
    const isFunction = !target.kind || target.kind === 'function';
    const names = isFunction ? [target.simple, `${target.simple}_Implementation`, `${target.simple}_Validate`] : [target.simple];
    const pattern = `\\b(?:${names.map(escapeRegex).join('|')})\\b`;
    const notes: string[] = [];
    const raw: RawMatch[] = [];

    if (scope !== 'engine') {
        const filter = options.pathFilter?.replace(/\\/g, '/').toLowerCase();
        const files = ctx.project.indexedFiles().filter(rel => !filter || rel.toLowerCase().includes(filter));
        const found = searchFiles(files, rel => ctx.project.readFileLines(rel), new RegExp(pattern), MAX_MATCHES);
        raw.push(...found.hits.map(h => ({ engine: false, file: h.path, line: h.line, text: h.text })));
    }
    const engine = ctx.engine?.state();
    const handle = engine && 'handle' in engine ? engine.handle : undefined;
    if (scope !== 'project') {
        if (!handle) {
            notes.push(`Engine not searched: ${engine && 'message' in engine ? engine.message : 'no engine index'}`);
        } else {
            const found = await searchEngineCode(handle, ctx.rgPath, { pattern, ignoreCase: false, filter: options.pathFilter, maxResults: MAX_MATCHES });
            raw.push(...found.hits.map(h => ({ engine: true, file: h.path, line: h.line, text: h.text })));
            notes.push(`Engine: searched ${found.label}${found.complete ? '' : '; the search stopped early, so there may be more'}.`);
        }
    }

    const byFile = new Map<string, RawMatch[]>();
    for (const m of raw) {
        const key = `${m.engine ? 'E' : 'P'}|${m.file}`;
        byFile.set(key, [...(byFile.get(key) ?? []), m]);
    }
    const nameRegex = new RegExp(pattern, 'g');
    const ownKeys = new Set(target.own.map(s => `${s.file.toLowerCase()}:${s.line}`));
    const hits: ReferenceHit[] = [];
    const skipped = { text: 0, otherMembers: 0, unanalyzed: 0 };
    // A file that names the class or a subclass probably means this class's member (base classes
    // such as UObject are named almost everywhere, so they don't count)
    const family = [...target.related].filter(n => !target.ancestors.has(n));
    const familyRegex = family.length ? new RegExp(`\\b(?:${family.map(escapeRegex).join('|')})\\b`) : undefined;

    // With many matching files, analyze first those whose lines look like calls, bindings or the
    // class's own code, so the file limit drops the noise rather than real references
    const alternatives = names.map(escapeRegex).join('|');
    const promising = new RegExp(`(?:[.>:&(,=!]\\s*|^\\s*)(?:${alternatives})\\s*\\(|&\\s*\\w+::(?:${alternatives})\\b`);
    const files = [...byFile.values()].sort(
        (a, b) => Number(b.some(m => promising.test(m.text) || !!familyRegex?.test(m.text))) - Number(a.some(m => promising.test(m.text) || !!familyRegex?.test(m.text))),
    );
    let analyzed = 0;
    for (const matches of files) {
        if (analyzed++ >= MAX_FILES) {
            skipped.unanalyzed += matches.length;
            continue;
        }
        const index: SourceIndex = matches[0].engine && handle ? handle.index : ctx.project;
        const file = matches[0].file;
        let lines: string[];
        let symbols: CodeSymbol[];
        try {
            lines = index.readFileLines(file);
            symbols = index.symbolsInFile(file);
        } catch {
            skipped.unanalyzed += matches.length;
            continue;
        }
        const mentionsRelated = !familyRegex || familyRegex.test(lines.join('\n'));

        for (const m of matches) {
            const text = lines[m.line - 1] ?? '';
            // A declaration or definition on this line: the symbol itself, an override, or another class's member
            const declared = symbols.find(s => s.line === m.line && names.includes(s.name) && (s.kind === 'function' || TYPE_KINDS.has(s.kind) || s.kind === 'property' || s.kind === 'variable'));
            let kind: ReferenceKind | 'text' | undefined;
            let qualifier: string | undefined;
            if (declared) {
                const owner = declared.container ? baseName(declared.container) : undefined;
                if (ownKeys.has(`${file.toLowerCase()}:${m.line}`) || (owner === target.className && declared.name === target.simple)) {
                    continue;
                }
                if (target.className && owner && target.ancestors.has(owner)) {
                    kind = 'base';
                } else if (target.className && owner && target.related.has(owner)) {
                    kind = 'override';
                } else if (target.className || qualifiedName(declared) !== target.label) {
                    skipped.otherMembers++;
                    continue;
                } else {
                    continue;
                }
            } else {
                // The strongest reading of any occurrence of the name on this line
                for (const occurrence of text.matchAll(nameRegex)) {
                    const start = occurrence.index ?? 0;
                    const before = text.slice(0, start);
                    const after = text.slice(start + occurrence[0].length);
                    const qual = /(\w+)\s*::\s*$/.exec(before)?.[1];
                    let k: ReferenceKind | 'text';
                    if (inComment(text, start)) {
                        k = 'text';
                    } else if (/(?:^|[^&\w)\]])&\s*(?:\w+\s*::\s*)*$/.test(before) || BINDING_CALLS.test(text)) {
                        // &AMyClass::Jump (not a && b), BindUFunction(this, "Jump"), GET_FUNCTION_NAME_CHECKED(AMyClass, Jump)
                        k = 'binding';
                    } else if (inString(text, start)) {
                        k = 'text';
                    } else if (/^\s*(?:\.|->)\s*(?:Add\w*|Bind\w*|Remove\w*)\s*\(/.test(after)) {
                        k = 'binding';
                    } else if (/^\s*(?:\.|->)\s*(?:Broadcast|Execute\w*)\s*\(/.test(after) || (isFunction && /^\s*\(/.test(after))) {
                        k = 'call';
                    } else if (target.kind && target.kind !== 'function') {
                        k = 'use';
                    } else {
                        // A function's name that is neither called nor taken with &: usually a same-named variable or enumerator
                        k = 'text';
                    }
                    if (qual && target.className && qual !== 'Super' && qual !== 'ThisClass' && !target.related.has(qual) && k !== 'text') {
                        // e.g. UOtherClass::Jump(): a different class's member with the same name
                        continue;
                    }
                    if (kind === undefined || RANK[k] > RANK[kind]) {
                        kind = k;
                        qualifier = qual;
                    }
                }
                if (kind === undefined) {
                    skipped.otherMembers++;
                    continue;
                }
            }
            if (kind === 'text') {
                skipped.text++;
                if (!options.includeText) {
                    continue;
                }
                kind = 'mention';
            }
            const enclosing = enclosingSymbol(symbols, m.line);
            if (kind === 'mention' && enclosing && qualifiedName(enclosing) === target.label) {
                // Strings and comments inside the symbol's own body aren't references to it
                continue;
            }
            const enclosingOwner = enclosing?.container ? baseName(enclosing.container) : enclosing && ['class', 'struct', 'interface'].includes(enclosing.kind) ? enclosing.name : undefined;
            const likely =
                !target.className ||
                mentionsRelated ||
                (!!qualifier && (qualifier === 'Super' || target.related.has(qualifier))) ||
                (!!enclosingOwner && target.related.has(enclosingOwner));
            const clipped = text.trim();
            hits.push({
                index,
                file,
                line: m.line,
                text: clipped.length > 200 ? `${clipped.slice(0, 200)}…` : clipped,
                kind,
                enclosing: enclosing ? { name: qualifiedName(enclosing), line: enclosing.startLine } : undefined,
                likely,
            });
        }
    }
    // Files with calls and bindings first, then uses and mentions
    const fileRank = new Map<string, number>();
    for (const h of hits) {
        fileRank.set(h.file, Math.max(fileRank.get(h.file) ?? 0, RANK[h.kind]));
    }
    hits.sort(
        (a, b) =>
            Number(b.likely) - Number(a.likely) || fileRank.get(b.file)! - fileRank.get(a.file)! || a.file.localeCompare(b.file) || a.line - b.line,
    );
    return { target, hits, textIncluded: !!options.includeText, skipped, notes };
}

const KIND_LABELS: Record<ReferenceKind, string> = { call: 'call', binding: 'binding', override: 'override', base: 'base-class declaration', use: 'use', mention: 'mention' };

function describeTarget(target: ReferenceTarget): string {
    const kind = target.kind ?? 'name';
    return `${target.label} (${kind}${target.own.length ? '' : ', not found in the index'})`;
}

function blueprintNote(target: ReferenceTarget): string {
    return target.blueprint ? '\nIt is exposed to Blueprints, which aren\'t indexed, so Blueprint uses aren\'t listed.' : '';
}

/** find_references output: hits grouped by file, likely ones first. */
export function renderReferences(result: ReferenceResult, limit: number): string {
    const { target, hits, skipped, notes } = result;
    const counts = new Map<ReferenceKind, number>();
    hits.forEach(h => counts.set(h.kind, (counts.get(h.kind) ?? 0) + 1));
    const summary = [...counts].map(([k, n]) => `${n} ${KIND_LABELS[k]}${n > 1 ? 's' : ''}`).join(', ') || 'none';
    const out = [`References to ${describeTarget(target)}, found by name: ${summary}.${blueprintNote(target)}`];

    const shown = hits.slice(0, limit);
    const section = (list: ReferenceHit[]) => {
        let lastFile = '';
        for (const h of list) {
            const path = h.index.shortPath(h.file);
            if (path !== lastFile) {
                out.push('', path);
                lastFile = path;
            }
            out.push(`  L${h.line} ${h.kind}${h.enclosing ? ` in ${h.enclosing.name}` : ''}: ${h.text}`);
        }
    };
    section(shown.filter(h => h.likely));
    const unlikely = shown.filter(h => !h.likely);
    if (unlikely.length) {
        out.push('', `Possibly unrelated: these files don't mention ${target.className} or a related class, so they may use another type's ${target.simple}:`);
        section(unlikely);
    }
    const tail: string[] = [];
    if (hits.length > shown.length) {
        tail.push(`${hits.length - shown.length} more not shown; narrow with path_filter or scope.`);
    }
    if (skipped.otherMembers) {
        tail.push(`Skipped ${skipped.otherMembers} same-named member${skipped.otherMembers > 1 ? 's' : ''} of other classes.`);
    }
    if (skipped.text) {
        tail.push(`${skipped.text} other mention${skipped.text > 1 ? 's' : ''} (comments, strings, same-named variables) ${result.textIncluded ? 'included' : 'left out; pass include_text to see them'}.`);
    }
    if (skipped.unanalyzed) {
        tail.push(`${skipped.unanalyzed} matches in further files weren't analyzed (those least like calls); narrow with path_filter to include them.`);
    }
    tail.push(...notes);
    if (tail.length) {
        out.push('', ...tail);
    }
    return out.join('\n');
}

export interface CallerNode {
    name: string;
    file: string;
    line: number;
    index: SourceIndex;
    calls: number;
    bindings: number;
    likely: boolean;
    callers?: CallerNode[];
}

/** Functions that call (or bind) a function, and optionally their callers, up to `depth` levels. */
export async function findCallers(ctx: ToolContext, name: string, options: ReferenceOptions & { depth?: number; perLevel?: number } = {}): Promise<{ target: ReferenceTarget; callers: CallerNode[]; notes: string[] } | { error: string }> {
    const first = await findReferences(ctx, name, options);
    if ('error' in first) {
        return first;
    }
    const depth = Math.min(Math.max(options.depth ?? 1, 1), 3);
    const perLevel = options.perLevel ?? 8;
    const visited = new Set([first.target.label]);
    let searches = 1;

    const group = (result: ReferenceResult): CallerNode[] => {
        const nodes = new Map<string, CallerNode>();
        for (const h of result.hits.filter(h => h.kind === 'call' || h.kind === 'binding')) {
            const key = h.enclosing?.name ?? `${h.index.shortPath(h.file)} (outside any function)`;
            const node = nodes.get(key) ?? { name: key, file: h.file, line: h.line, index: h.index, calls: 0, bindings: 0, likely: false };
            node[h.kind === 'call' ? 'calls' : 'bindings']++;
            node.likely ||= h.likely;
            nodes.set(key, node);
        }
        return [...nodes.values()].sort((a, b) => Number(b.likely) - Number(a.likely) || b.calls + b.bindings - (a.calls + a.bindings) || a.name.localeCompare(b.name));
    };

    const expand = async (nodes: CallerNode[], level: number) => {
        if (level >= depth) {
            return;
        }
        for (const node of nodes.slice(0, perLevel)) {
            if (visited.has(node.name) || !/^[\w:~]+$/.test(node.name) || searches >= 20) {
                continue;
            }
            visited.add(node.name);
            searches++;
            const result = await findReferences(ctx, node.name, options);
            if (!('error' in result)) {
                node.callers = group(result);
                await expand(node.callers, level + 1);
            }
        }
    };

    const callers = group(first);
    await expand(callers, 1);
    return { target: first.target, callers, notes: first.notes };
}

/** callers output: an indented tree, likely callers first. */
export function renderCallers(result: { target: ReferenceTarget; callers: CallerNode[]; notes: string[] }, limit: number): string {
    const out = [
        `Callers of ${describeTarget(result.target)}, found by name. Calls through function pointers and from Blueprints aren't traced.${blueprintNote(result.target)}`,
    ];
    if (!result.callers.length) {
        out.push('', 'No calls or bindings found in the code that was searched.');
    }
    let lines = 0;
    const walk = (nodes: CallerNode[], indent: string) => {
        for (const node of nodes) {
            if (lines++ >= limit) {
                return;
            }
            const what = [node.calls ? `${node.calls} call${node.calls > 1 ? 's' : ''}` : '', node.bindings ? `bound ${node.bindings}×` : ''].filter(Boolean).join(', ');
            out.push(`${indent}- ${node.name} — ${node.index.shortPath(node.file)}:${node.line} (${what}${node.likely ? '' : '; possibly unrelated'})`);
            if (node.callers?.length) {
                walk(node.callers, `${indent}  `);
            } else if (node.callers) {
                out.push(`${indent}  (no callers found)`);
            }
        }
    };
    walk(result.callers, '');
    if (lines > limit) {
        out.push(`… more callers not shown; lower depth or narrow with path_filter.`);
    }
    if (result.notes.length) {
        out.push('', ...result.notes);
    }
    return out.join('\n');
}
