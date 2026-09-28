import * as fs from 'fs';
import * as path from 'path';
import { parseSource } from './parse';
import { allSourceFiles, readText, scanProject, SKIP_DIRS } from './scan';
import { CodeSymbol, ModuleInfo, ProjectInfo, SourceIndex, SymbolKind } from './types';

interface FileEntry {
    mtimeMs: number;
    size: number;
    lineCount: number;
    symbols: CodeSymbol[];
}

const TYPE_KINDS = new Set<SymbolKind>(['class', 'struct', 'interface']);
const REFRESH_THROTTLE_MS = 1500;

export const qualifiedName = (s: CodeSymbol) => (s.container ? `${s.container}::${s.name}` : s.name);

export class ProjectIndex implements SourceIndex {
    private projectInfo?: ProjectInfo;
    private readonly files = new Map<string, FileEntry>();
    private shortPaths = new Map<string, string>();
    private typeNames = new Set<string>();
    private structure = '';
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

    /** Changes whenever modules, their dependencies, plugins or the file list change. */
    get structureKey(): string {
        return this.structure;
    }

    /** Rescans the project and re-parses files whose size or mtime changed. Returns true if anything changed. */
    refresh(force = false): boolean {
        if (!force && Date.now() - this.lastRefresh < REFRESH_THROTTLE_MS) {
            return false;
        }
        this.lastRefresh = Date.now();

        const project = scanProject(this.input);
        const sources = allSourceFiles(project);
        const structure = JSON.stringify([
            project.engineAssociation,
            project.pluginRefs,
            project.disableEnginePluginsByDefault,
            project.plugins.map(p => [p.name, p.dir]),
            project.modules.map(m => [m.name, m.dir, m.publicDeps, m.privateDeps]),
            sources,
        ]);
        let changed = structure !== this.structure;

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
        this.structure = structure;
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

    absolutePath(rel: string): string {
        return path.join(this.root, rel);
    }

    readFileLines(rel: string): string[] {
        const abs = this.absolutePath(rel);
        if (fs.statSync(abs).size > 2_000_000) {
            throw new Error(`${rel} is too large to read`);
        }
        return readText(abs).split(/\r?\n/);
    }

    /**
     * Ranked symbol search: exact qualified name, exact name, qualified suffix, prefix, substring, then
     * subsequence (`tier` 100 to 20). Within a tier, types and declarations come first (`bonus`).
     */
    findSymbolMatches(query: string, kind?: SymbolKind, limit = 20): { symbol: CodeSymbol; tier: number; bonus: number }[] {
        const q = query.trim().toLowerCase();
        if (!q) {
            return [];
        }
        const scored: { symbol: CodeSymbol; tier: number; bonus: number }[] = [];
        for (const s of this.allSymbols()) {
            if (kind && s.kind !== kind) {
                continue;
            }
            const qn = qualifiedName(s).toLowerCase();
            const name = s.name.toLowerCase();
            let tier = 0;
            if (qn === q) {
                tier = 100;
            } else if (name === q) {
                tier = 90;
            } else if (qn.endsWith('::' + q)) {
                tier = 85;
            } else if (name.startsWith(q)) {
                tier = 70;
            } else if (qn.includes(q)) {
                tier = 50;
            } else if (isSubsequence(q, qn)) {
                tier = 20;
            }
            if (tier) {
                // Prefer declarations over definitions, and types over members
                let bonus = 0;
                if (TYPE_KINDS.has(s.kind) || s.kind === 'enum') {
                    bonus += 5;
                }
                if (s.isDefinition && s.file.match(/\.(cpp|cc|cxx|c)$/)) {
                    bonus -= 2;
                }
                scored.push({ symbol: s, tier, bonus });
            }
        }
        scored.sort((a, b) => b.tier + b.bonus - (a.tier + a.bonus) || qualifiedName(a.symbol).length - qualifiedName(b.symbol).length);
        return scored.slice(0, limit);
    }

    findSymbols(query: string, kind?: SymbolKind, limit = 20): CodeSymbol[] {
        return this.findSymbolMatches(query, kind, limit).map(m => m.symbol);
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
