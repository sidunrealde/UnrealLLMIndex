import * as fs from 'fs';
import * as path from 'path';
import { parseSource } from './parse';
import { allSourceFiles, readText, scanProject, SKIP_DIRS } from './scan';
import { CodeSymbol, ModuleInfo, ProjectInfo, SymbolKind } from './types';

interface FileEntry {
    mtimeMs: number;
    size: number;
    lineCount: number;
    symbols: CodeSymbol[];
}

const TYPE_KINDS = new Set<SymbolKind>(['class', 'struct', 'interface']);
const REFRESH_THROTTLE_MS = 1500;

export const qualifiedName = (s: CodeSymbol) => (s.container ? `${s.container}::${s.name}` : s.name);

export class ProjectIndex {
    private projectInfo?: ProjectInfo;
    private readonly files = new Map<string, FileEntry>();
    private shortPaths = new Map<string, string>();
    private typeNames = new Set<string>();
    private structureKey = '';
    private lastRefresh = 0;
    generatedAt = new Date();

    constructor(private readonly input: string) {}

    get project(): ProjectInfo {
        if (!this.projectInfo) {
            this.refresh(true);
        }
        return this.projectInfo!;
    }

    get root(): string {
        return this.project.root;
    }

    /** Rescans the project and re-parses files whose size or mtime changed. Returns true if anything changed. */
    refresh(force = false): boolean {
        if (!force && Date.now() - this.lastRefresh < REFRESH_THROTTLE_MS) {
            return false;
        }
        this.lastRefresh = Date.now();

        const project = scanProject(this.input);
        const sources = allSourceFiles(project);
        const structureKey = JSON.stringify([
            project.engineAssociation,
            project.enabledPlugins,
            project.modules.map(m => [m.name, m.dir, m.publicDeps, m.privateDeps]),
            sources,
        ]);
        let changed = structureKey !== this.structureKey;

        const seen = new Set<string>();
        for (const rel of sources) {
            seen.add(rel);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(path.join(project.root, rel));
            } catch {
                continue;
            }
            const previous = this.files.get(rel);
            if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
                continue;
            }
            const text = readText(path.join(project.root, rel));
            this.files.set(rel, {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                lineCount: text.split('\n').length,
                symbols: parseSource(text, rel),
            });
            changed = true;
        }
        for (const rel of [...this.files.keys()]) {
            if (!seen.has(rel)) {
                this.files.delete(rel);
                changed = true;
            }
        }

        this.projectInfo = project;
        this.structureKey = structureKey;
        if (changed) {
            this.rebuildDerived();
            this.generatedAt = new Date();
        }
        return changed;
    }

    private rebuildDerived() {
        const all = this.allSymbols();

        // Link header declarations to out-of-line definitions
        const definitions = new Map<string, CodeSymbol[]>();
        for (const s of all) {
            s.definitions = undefined;
            if (s.kind === 'function' && s.isDefinition) {
                const key = qualifiedName(s);
                definitions.set(key, [...(definitions.get(key) ?? []), s]);
            }
        }
        for (const s of all) {
            if (s.kind === 'function' && !s.isDefinition) {
                const defs = definitions.get(qualifiedName(s));
                if (defs?.length) {
                    s.definitions = defs.map(d => ({ file: d.file, startLine: d.startLine, endLine: d.endLine }));
                }
            }
        }

        this.typeNames = new Set(all.filter(s => TYPE_KINDS.has(s.kind)).map(qualifiedName));

        // Shortest path suffix that uniquely identifies each file, e.g. "Agent.cpp" or "Private/Agent.cpp"
        const files = [...this.files.keys()];
        const suffixCounts = new Map<string, number>();
        for (const rel of files) {
            const parts = rel.toLowerCase().split('/');
            for (let take = 1; take <= parts.length; take++) {
                const suffix = parts.slice(-take).join('/');
                suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
            }
        }
        this.shortPaths = new Map();
        for (const rel of files) {
            const parts = rel.split('/');
            let take = 1;
            while (take < parts.length && suffixCounts.get(parts.slice(-take).join('/').toLowerCase()) !== 1) {
                take++;
            }
            this.shortPaths.set(rel, parts.slice(-take).join('/'));
        }
    }

    allSymbols(): CodeSymbol[] {
        return [...this.files.values()].flatMap(f => f.symbols);
    }

    symbolsInFile(rel: string): CodeSymbol[] {
        return this.files.get(rel)?.symbols ?? [];
    }

    lineCount(rel: string): number {
        return this.files.get(rel)?.lineCount ?? 0;
    }

    indexedFiles(): string[] {
        return [...this.files.keys()];
    }

    /** True if `qualified` names a class, struct or interface anywhere in the project. */
    isType(qualified: string | undefined): boolean {
        return !!qualified && this.typeNames.has(qualified);
    }

    shortPath(rel: string): string {
        return this.shortPaths.get(rel) ?? rel;
    }

    moduleOf(rel: string): ModuleInfo | undefined {
        return this.project.modules.find(m => m.files.includes(rel));
    }

    findModule(name: string): ModuleInfo | undefined {
        const lower = name.toLowerCase();
        return this.project.modules.find(m => m.name.toLowerCase() === lower || m.dir.toLowerCase() === lower);
    }

    /**
     * Resolves a user-supplied path: a project-relative path or any unique suffix of an indexed file.
     * Falls back to other text files inside the project (e.g. Config/*.ini). Never leaves the project root.
     */
    resolvePath(input: string): string {
        const wanted = input.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
        const lower = wanted.toLowerCase();
        const files = this.indexedFiles();

        const exact = files.find(f => f.toLowerCase() === lower);
        if (exact) {
            return exact;
        }
        const suffixMatches = files.filter(f => f.toLowerCase().endsWith('/' + lower));
        if (suffixMatches.length === 1) {
            return suffixMatches[0];
        }
        if (suffixMatches.length > 1) {
            throw new Error(`"${input}" matches several files, use a longer path:\n${suffixMatches.map(f => `  ${f}`).join('\n')}`);
        }

        const abs = path.resolve(this.root, wanted);
        const insideRoot = abs.toLowerCase().startsWith(path.resolve(this.root).toLowerCase() + path.sep);
        const rel = path.relative(this.root, abs).split(path.sep).join('/');
        const skipped = rel.split('/').slice(0, -1).some(part => SKIP_DIRS.has(part.toLowerCase()));
        if (insideRoot && !skipped && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            return rel;
        }
        throw new Error(`File not found in project: "${input}". Use a path from the index, e.g. "${this.shortPath(files[0] ?? '')}".`);
    }

    readFileLines(rel: string): string[] {
        const abs = path.join(this.root, rel);
        if (fs.statSync(abs).size > 2_000_000) {
            throw new Error(`${rel} is too large to read`);
        }
        return readText(abs).split(/\r?\n/);
    }

    /** Ranked symbol search: exact qualified name, exact name, prefix, substring, then subsequence. */
    findSymbols(query: string, kind?: SymbolKind, limit = 20): CodeSymbol[] {
        const q = query.trim().toLowerCase();
        if (!q) {
            return [];
        }
        const scored: { s: CodeSymbol; score: number }[] = [];
        for (const s of this.allSymbols()) {
            if (kind && s.kind !== kind) {
                continue;
            }
            const qn = qualifiedName(s).toLowerCase();
            const name = s.name.toLowerCase();
            let score = 0;
            if (qn === q) {
                score = 100;
            } else if (name === q) {
                score = 90;
            } else if (qn.endsWith('::' + q)) {
                score = 85;
            } else if (name.startsWith(q)) {
                score = 70;
            } else if (qn.includes(q)) {
                score = 50;
            } else if (isSubsequence(q, qn)) {
                score = 20;
            }
            if (score) {
                // Prefer declarations over definitions, and types over members
                if (TYPE_KINDS.has(s.kind) || s.kind === 'enum') {
                    score += 5;
                }
                if (s.isDefinition && s.file.match(/\.(cpp|cc|cxx|c)$/)) {
                    score -= 2;
                }
                scored.push({ s, score });
            }
        }
        scored.sort((a, b) => b.score - a.score || qualifiedName(a.s).length - qualifiedName(b.s).length);
        return scored.slice(0, limit).map(x => x.s);
    }

    /** Symbols matching a name exactly: "UAgent::ToJsonObject", "ToJsonObject" or "UAgent". */
    resolveSymbol(name: string): CodeSymbol[] {
        const q = name.trim().replace(/\s*::\s*/g, '::').replace(/\(\)$/, '').toLowerCase();
        const all = this.allSymbols();
        const byQualified = all.filter(s => qualifiedName(s).toLowerCase() === q);
        if (byQualified.length) {
            return byQualified;
        }
        const bySuffix = all.filter(s => qualifiedName(s).toLowerCase().endsWith('::' + q));
        if (bySuffix.length) {
            return bySuffix;
        }
        return all.filter(s => s.name.toLowerCase() === q);
    }
}

function isSubsequence(needle: string, haystack: string): boolean {
    let i = 0;
    for (const c of haystack) {
        if (c === needle[i]) {
            i++;
            if (i === needle.length) {
                return true;
            }
        }
    }
    return false;
}
