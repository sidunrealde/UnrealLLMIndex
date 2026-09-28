import type { DatabaseSync, StatementSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { qualifiedName } from '../indexer';
import { parseSource } from '../parse';
import { readText, toRel } from '../scan';
import { requireSqlite } from '../sqlite';
import { CodeSymbol, ModuleInfo, PluginInfo, SourceIndex, SourceRange, SymbolKind } from '../types';
import { FLAG_DEFINITION, KINDS, SIMPLE_NAME, TYPE_KIND_CODES } from './schema';

/** What the project uses, to rank engine results: its module dependencies and enabled plugins (lower-case names). */
export interface RankContext {
    depModules: Map<string, 'direct' | 'transitive'>;
    enabledPlugins: Set<string>;
}

/** A search hit: `tier` is how well the name matched (100 exact … 20 fuzzy), `bonus` breaks ties within a tier. */
export interface SymbolMatch {
    symbol: CodeSymbol;
    tier: number;
    bonus: number;
}

interface SymbolRecord {
    name_id: number;
    kind: number;
    flags: number;
    line: number;
    start_line: number;
    end_line: number;
    qn: string;
    path: string;
    module_id: number | null;
}

interface Structure {
    stamp: string;
    checkedAt: number;
    meta: Record<string, string>;
    modules: Map<number, ModuleInfo>;
    plugins: PluginInfo[];
}

const PARSED_CACHE_SIZE = 64;
const STRUCTURE_TTL_MS = 5000;
const CANDIDATE_LIMIT = 3000;
const MAX_FILE_BYTES = 2_000_000;

const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);
const SYMBOL_COLUMNS = 's.name_id, s.kind, s.flags, s.line, s.start_line, s.end_line, n.qn, f.path, f.module_id';
/** SIMPLE_NAME for the names table aliased as n, so its expression index applies. */
const N_SIMPLE_NAME = 'lower(substr(n.qn, n.name_at))';
/** The part of a lower-case qualified name after the last "::". */
const simpleOf = (qualified: string) => (qualified.includes('::') ? qualified.slice(qualified.lastIndexOf('::') + 2) : qualified);

/**
 * Read-only view of an engine index built by syncEngineIndex. The database locates symbols;
 * outlines and signatures come from parsing the engine's files on demand.
 */
export class EngineIndex implements SourceIndex {
    private readonly statements = new Map<string, StatementSync>();
    private readonly parsed = new Map<string, { mtimeMs: number; symbols: CodeSymbol[] }>();
    private readonly types = new Map<string, boolean>();
    private cached?: Structure;

    private constructor(
        private readonly db: DatabaseSync,
        /** The folder that contains Engine/. */
        readonly root: string,
        readonly dbPath: string,
    ) {}

    static open(dbPath: string, root: string): EngineIndex {
        const db = new (requireSqlite().DatabaseSync)(dbPath);
        db.exec('PRAGMA query_only = 1; PRAGMA busy_timeout = 5000;');
        return new EngineIndex(db, root, dbPath);
    }

    close() {
        this.db.close();
    }

    private stmt(sql: string): StatementSync {
        let statement = this.statements.get(sql);
        if (!statement) {
            statement = this.db.prepare(sql);
            this.statements.set(sql, statement);
        }
        return statement;
    }

    /** Plugins, modules and meta, re-read after a sync has updated the index. */
    private structure(): Structure {
        const now = Date.now();
        if (this.cached && now - this.cached.checkedAt < STRUCTURE_TTL_MS) {
            return this.cached;
        }
        const meta = Object.fromEntries((this.stmt('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
        const stamp = meta.last_sync ?? '';
        if (this.cached?.stamp === stamp) {
            this.cached.checkedAt = now;
            return this.cached;
        }
        const modules = new Map<number, ModuleInfo>();
        for (const r of this.stmt('SELECT * FROM modules').all() as any[]) {
            modules.set(r.id, {
                name: r.name,
                dir: r.dir,
                type: r.type ?? undefined,
                loadingPhase: r.loading_phase ?? undefined,
                plugin: r.plugin ?? undefined,
                publicDeps: JSON.parse(r.public_deps),
                privateDeps: JSON.parse(r.private_deps),
                files: [],
            });
        }
        const plugins: PluginInfo[] = (this.stmt('SELECT * FROM plugins ORDER BY name_lower').all() as any[]).map(r => ({
            name: r.name,
            dir: r.dir,
            friendlyName: r.friendly ?? undefined,
            description: r.description ?? undefined,
            modules: JSON.parse(r.modules),
            category: r.category,
            enabledByDefault: r.enabled_by_default === null ? undefined : !!r.enabled_by_default,
            installed: r.installed ? true : undefined,
            pluginDeps: JSON.parse(r.plugin_deps),
        }));
        this.parsed.clear();
        this.types.clear();
        this.cached = { stamp, checkedAt: now, meta, modules, plugins };
        return this.cached;
    }

    /** Changes after every sync. */
    get syncStamp(): string {
        return this.structure().stamp;
    }

    meta(): Record<string, string> {
        return this.structure().meta;
    }

    plugins(): PluginInfo[] {
        return this.structure().plugins;
    }

    /** Every module, without file lists. */
    modules(): ModuleInfo[] {
        return [...this.structure().modules.values()];
    }

    findPlugin(name: string): PluginInfo | undefined {
        const lower = name.trim().toLowerCase();
        return this.plugins().find(p => p.name.toLowerCase() === lower);
    }

    /** A module by name or folder, with its file list. */
    findModule(name: string): ModuleInfo | undefined {
        const lower = name.trim().replace(/\\/g, '/').toLowerCase();
        const row = this.stmt('SELECT id FROM modules WHERE name_lower = ? OR dir_lower = ? ORDER BY length(dir) LIMIT 1').get(lower, lower) as { id: number } | undefined;
        const module = row && this.structure().modules.get(row.id);
        if (!module) {
            return undefined;
        }
        const files = (this.stmt('SELECT path FROM files WHERE module_id = ? ORDER BY path').all(row.id) as { path: string }[]).map(r => r.path);
        return { ...module, files };
    }

    /** Indexed files in a folder, e.g. a plugin's. */
    filesUnder(dir: string): string[] {
        const prefix = `${dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}/`;
        return (this.stmt(`SELECT path FROM files WHERE path_lower LIKE ? ESCAPE '\\' ORDER BY path`).all(`${escapeLike(prefix)}%`) as { path: string }[]).map(r => r.path);
    }

    moduleOf(rel: string): ModuleInfo | undefined {
        const row = this.stmt('SELECT module_id FROM files WHERE path_lower = ?').get(rel.toLowerCase()) as { module_id: number | null } | undefined;
        return row?.module_id != null ? this.structure().modules.get(row.module_id) : undefined;
    }

    private moduleIdOf(rel: string): number | null {
        const row = this.stmt('SELECT module_id FROM files WHERE path_lower = ?').get(rel.toLowerCase()) as { module_id: number | null } | undefined;
        return row?.module_id ?? null;
    }

    lineCount(rel: string): number {
        const row = this.stmt('SELECT lines FROM files WHERE path_lower = ?').get(rel.toLowerCase()) as { lines: number } | undefined;
        return row?.lines ?? this.readFileLines(rel).length;
    }

    /** Engine paths are shown in full ("Engine/Source/..."), which resolvePath accepts back. */
    shortPath(rel: string): string {
        return rel;
    }

    absolutePath(rel: string): string {
        return path.join(this.root, rel);
    }

    readFileLines(rel: string): string[] {
        const abs = this.absolutePath(rel);
        if (fs.statSync(abs).size > MAX_FILE_BYTES) {
            throw new Error(`${rel} is too large to read`);
        }
        return readText(abs).split(/\r?\n/);
    }

    /**
     * An indexed engine file by path ("Engine/Source/...") or unique suffix ("GameFramework/Character.h").
     * Other files inside Engine/ (config, Build.cs) can be named by their full path. Never leaves the install.
     */
    resolvePath(input: string): string {
        const wanted = input.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
        const lower = wanted.toLowerCase();
        const exact = this.stmt('SELECT path FROM files WHERE path_lower = ?').get(lower) as { path: string } | undefined;
        if (exact) {
            return exact.path;
        }
        const matches = (this.stmt(`SELECT path FROM files WHERE path_lower LIKE ? ESCAPE '\\' LIMIT 11`).all(`%/${escapeLike(lower)}`) as { path: string }[]).map(r => r.path);
        if (matches.length === 1) {
            return matches[0];
        }
        if (matches.length > 1) {
            const listed = matches.slice(0, 10).map(f => `  ${f}`).join('\n');
            throw new Error(`"${input}" matches several engine files, use a longer path:\n${listed}${matches.length > 10 ? '\n  …' : ''}`);
        }
        const abs = path.resolve(this.root, wanted);
        const insideEngine = abs.toLowerCase().startsWith(path.join(path.resolve(this.root), 'Engine').toLowerCase() + path.sep);
        if (insideEngine && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            return toRel(this.root, abs);
        }
        throw new Error(`File not found in the engine: "${input}".`);
    }

    isType(qualified: string | undefined): boolean {
        if (!qualified) {
            return false;
        }
        const key = qualified.toLowerCase();
        let result = this.types.get(key);
        if (result === undefined) {
            result = !!this.stmt(
                `SELECT 1 FROM names n JOIN symbols s ON s.name_id = n.id
                 WHERE ${N_SIMPLE_NAME} = ? AND lower(n.qn) = ? AND s.kind IN (${TYPE_KIND_CODES.join(',')}) LIMIT 1`,
            ).get(simpleOf(key), key);
            this.types.set(key, result);
        }
        return result;
    }

    /** Parsed from the file on disk (cached while it is unchanged), with links to out-of-line definitions. */
    symbolsInFile(rel: string): CodeSymbol[] {
        this.structure();
        const key = rel.toLowerCase();
        let mtimeMs: number;
        try {
            mtimeMs = fs.statSync(this.absolutePath(rel)).mtimeMs;
        } catch {
            return [];
        }
        const cached = this.parsed.get(key);
        if (cached && cached.mtimeMs === mtimeMs) {
            // Most recently used goes last
            this.parsed.delete(key);
            this.parsed.set(key, cached);
            return cached.symbols;
        }
        const symbols = parseSource(readText(this.absolutePath(rel)), rel);
        this.linkDefinitions(symbols, rel);
        this.parsed.set(key, { mtimeMs, symbols });
        if (this.parsed.size > PARSED_CACHE_SIZE) {
            this.parsed.delete(this.parsed.keys().next().value!);
        }
        return symbols;
    }

    /** Definition ranges for qualified names, preferring definitions in `moduleId` when there are several. */
    private definitionsFor(qualifiedLower: string[], moduleId: number | null): Map<string, SourceRange[]> {
        const rows = this.stmt(`
            SELECT lower(n.qn) AS qn, f.path, s.start_line, s.end_line, f.module_id
            FROM names n JOIN symbols s ON s.name_id = n.id JOIN files f ON f.id = s.file_id
            WHERE ${N_SIMPLE_NAME} IN (SELECT value FROM json_each(?)) AND lower(n.qn) IN (SELECT value FROM json_each(?))
                AND (s.flags & ${FLAG_DEFINITION}) = ${FLAG_DEFINITION}
            ORDER BY f.path, s.start_line`).all(JSON.stringify([...new Set(qualifiedLower.map(simpleOf))]), JSON.stringify(qualifiedLower)) as { qn: string; path: string; start_line: number; end_line: number; module_id: number | null }[];
        const grouped = new Map<string, typeof rows>();
        for (const row of rows) {
            grouped.set(row.qn, [...(grouped.get(row.qn) ?? []), row]);
        }
        const result = new Map<string, SourceRange[]>();
        for (const [qn, list] of grouped) {
            const local = list.filter(r => r.module_id === moduleId);
            result.set(qn, (local.length ? local : list).map(r => ({ file: r.path, startLine: r.start_line, endLine: r.end_line })));
        }
        return result;
    }

    private linkDefinitions(symbols: CodeSymbol[], rel: string) {
        const declarations = symbols.filter(s => s.kind === 'function' && !s.isDefinition);
        if (!declarations.length) {
            return;
        }
        const keys = [...new Set(declarations.map(s => qualifiedName(s).toLowerCase()))];
        const definitions = this.definitionsFor(keys, this.moduleIdOf(rel));
        for (const s of declarations) {
            const defs = definitions.get(qualifiedName(s).toLowerCase());
            s.definitions = defs?.length ? defs : undefined;
        }
    }

    /** The parsed symbol behind a database row, or a minimal stand-in if the file changed since the last sync. */
    private hydrate(record: SymbolRecord): CodeSymbol {
        const kind = KINDS[record.kind] ?? 'function';
        const qnLower = record.qn.toLowerCase();
        const parsed = this.symbolsInFile(record.path);
        const match =
            parsed.find(s => s.line === record.line && s.kind === kind && qualifiedName(s).toLowerCase() === qnLower) ??
            parsed.find(s => s.kind === kind && qualifiedName(s).toLowerCase() === qnLower);
        if (match) {
            return match;
        }
        const sep = record.qn.lastIndexOf('::');
        return {
            name: sep === -1 ? record.qn : record.qn.slice(sep + 2),
            container: sep === -1 ? undefined : record.qn.slice(0, sep),
            kind,
            file: record.path,
            line: record.line,
            startLine: record.start_line,
            endLine: record.end_line,
            signature: record.qn,
            isDefinition: (record.flags & FLAG_DEFINITION) === FLAG_DEFINITION,
        };
    }

    private records(nameIds: number[], kind?: SymbolKind): SymbolRecord[] {
        if (!nameIds.length) {
            return [];
        }
        const kindFilter = kind ? `AND s.kind = ${KINDS.indexOf(kind)}` : '';
        return this.stmt(`
            SELECT ${SYMBOL_COLUMNS} FROM symbols s JOIN names n ON n.id = s.name_id JOIN files f ON f.id = s.file_id
            WHERE s.name_id IN (SELECT value FROM json_each(?)) ${kindFilter}`).all(JSON.stringify(nameIds)) as unknown as SymbolRecord[];
    }

    private nameIds(sql: string, ...params: (string | number)[]): number[] {
        return (this.stmt(sql).all(...params) as { id: number }[]).map(r => r.id);
    }

    /** The name with exactly this lower-case qualified name. */
    private exactNameIds(q: string): number[] {
        return this.nameIds(`SELECT id FROM names WHERE ${SIMPLE_NAME} = ? AND lower(qn) = ?`, simpleOf(q), q);
    }

    /** Names ending in "::q", e.g. "Character::Jump" for "ACharacter::Jump". */
    private suffixNameIds(q: string, limit: number): number[] {
        return this.nameIds(`SELECT id FROM names WHERE ${SIMPLE_NAME} = ? AND lower(qn) LIKE ? ESCAPE '\\' LIMIT ${limit}`, simpleOf(q), `%::${escapeLike(q)}`);
    }

    /**
     * Names containing `q`: the trigram index finds candidates for the longest piece without LIKE
     * wildcards ("_" is common in names), and instr() confirms the whole text.
     */
    private substringNameIds(q: string): number[] {
        const piece = q.split(/[_%]/).filter(p => p.length >= 3).sort((a, b) => b.length - a.length)[0];
        if (piece) {
            return this.nameIds(
                `SELECT n.id FROM names_fts JOIN names n ON n.id = names_fts.rowid WHERE names_fts.qn LIKE ? AND instr(lower(n.qn), ?) > 0 LIMIT ${CANDIDATE_LIMIT}`,
                `%${piece}%`,
                q,
            );
        }
        return this.nameIds(`SELECT id FROM names WHERE instr(lower(qn), ?) > 0 LIMIT ${CANDIDATE_LIMIT}`, q);
    }

    private bonus(record: SymbolRecord, rank?: RankContext): number {
        let bonus = 0;
        const module = record.module_id != null ? this.structure().modules.get(record.module_id) : undefined;
        if (rank && module) {
            const dep = rank.depModules.get(module.name.toLowerCase());
            if (dep === 'direct') {
                bonus += 6;
            } else if (dep === 'transitive') {
                bonus += 4;
            } else if (module.plugin && rank.enabledPlugins.has(module.plugin.toLowerCase())) {
                bonus += 3;
            } else if (!module.plugin) {
                bonus += 1;
            }
        }
        if (TYPE_KIND_CODES.includes(record.kind) || KINDS[record.kind] === 'enum') {
            bonus += 2;
        }
        if ((record.flags & FLAG_DEFINITION) && !/\.(h|hpp|hh|inl)$/i.test(record.path)) {
            bonus -= 1;
        }
        return bonus;
    }

    /**
     * Ranked search: exact qualified name, exact name, qualified suffix, name prefix, then substring.
     * Within a tier, symbols in modules and plugins the project uses come first.
     */
    findSymbolMatches(query: string, kind?: SymbolKind, limit = 20, rank?: RankContext): SymbolMatch[] {
        const q = query.trim().toLowerCase().replace(/\s*::\s*/g, '::');
        if (!q) {
            return [];
        }
        const qualified = q.includes('::');
        const tiers: [number, () => number[]][] = [
            [100, () => this.exactNameIds(q)],
            [90, () => (qualified ? [] : this.nameIds(`SELECT id FROM names WHERE ${SIMPLE_NAME} = ? LIMIT ${CANDIDATE_LIMIT}`, q))],
            [85, () => (qualified ? this.suffixNameIds(q, CANDIDATE_LIMIT) : [])],
            [70, () => (qualified ? [] : this.nameIds(`SELECT id FROM names WHERE ${SIMPLE_NAME} > ? AND ${SIMPLE_NAME} < ? LIMIT ${CANDIDATE_LIMIT}`, q, `${q}￿`))],
            [50, () => this.substringNameIds(q)],
        ];
        const seenNames = new Set<number>();
        const scored: { record: SymbolRecord; tier: number; bonus: number }[] = [];
        for (const [tier, find] of tiers) {
            if (scored.length >= limit) {
                // Lower tiers can't outrank what we have
                break;
            }
            const ids = find().filter(id => !seenNames.has(id));
            ids.forEach(id => seenNames.add(id));
            for (const record of this.records(ids, kind)) {
                scored.push({ record, tier, bonus: this.bonus(record, rank) });
            }
        }
        scored.sort((a, b) => b.tier - a.tier || b.bonus - a.bonus || a.record.qn.length - b.record.qn.length || a.record.path.localeCompare(b.record.path));
        return scored.slice(0, limit).map(({ record, tier, bonus }) => ({ symbol: this.hydrate(record), tier, bonus }));
    }

    findSymbols(query: string, kind?: SymbolKind, limit = 20, rank?: RankContext): CodeSymbol[] {
        return this.findSymbolMatches(query, kind, limit, rank).map(m => m.symbol);
    }

    /** Symbols matching a name exactly: "ACharacter::Jump", "Character::Jump" (suffix) or "Jump". */
    resolveSymbol(name: string, rank?: RankContext): CodeSymbol[] {
        const q = name.trim().replace(/\s*::\s*/g, '::').replace(/\(\)$/, '').toLowerCase();
        if (!q) {
            return [];
        }
        let ids = this.exactNameIds(q);
        if (!ids.length && q.includes('::')) {
            ids = this.suffixNameIds(q, 50);
        }
        if (!ids.length && !q.includes('::')) {
            ids = this.nameIds(`SELECT id FROM names WHERE ${SIMPLE_NAME} = ? LIMIT 200`, q);
        }
        const records = this.records(ids).sort((a, b) => this.bonus(b, rank) - this.bonus(a, rank) || a.path.localeCompare(b.path) || a.line - b.line);
        return records.slice(0, 100).map(r => this.hydrate(r));
    }
}
