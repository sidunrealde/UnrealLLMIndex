import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { scanEngine, ScanTreeResult } from '../scan';
import { requireSqlite } from '../sqlite';
import { EngineVersion, parseBuildVersion } from './locate';
import { canonicalRoot, EngineCachePaths, engineCachePaths } from './paths';
import { ParsedFile, parseFileRows } from './rows';
import { INDEXES_SQL, PARSER_VERSION, SCHEMA_VERSION, SIMPLE_NAME, TABLES_SQL } from './schema';

export type SyncPhase = 'scan' | 'parse' | 'index';

export interface SyncProgress {
    phase: SyncPhase;
    done: number;
    total: number;
}

export interface SyncOptions {
    /** The folder that contains Engine/. */
    engineRoot: string;
    cacheDir: string;
    /** Parse every file again, even unchanged ones. */
    full?: boolean;
    /** Do nothing if the index was synced recently and the engine version and plugin folders are unchanged. */
    ifStale?: boolean;
    /** Parser threads. 1 parses on this thread. Defaults to the number of cores minus one, at most 8. */
    jobs?: number;
    /** The bundled worker (dist/parseWorker.js). Without it, files are parsed on this thread. */
    workerScript?: string;
    onProgress?(progress: SyncProgress): void;
    signal?: AbortSignal;
}

export interface SyncResult {
    dbPath: string;
    files: number;
    symbols: number;
    /** Files parsed in this run. */
    parsed: number;
    /** Files dropped because they no longer exist. */
    removed: number;
    ms: number;
    /** Set when the sync was skipped, with the reason. */
    skipped?: string;
}

/** Another process holds the lock; `pid` is updating the same index. */
export class EngineBusyError extends Error {
    constructor(readonly pid: number, readonly startedAt: number) {
        super(`The engine index is already being updated by process ${pid}, started ${new Date(startedAt).toLocaleTimeString()}.`);
    }
}

/** An index older than this is synced again on startup. */
export const STALE_AFTER_MS = 12 * 3600_000;
const LOCK_EXPIRY_MS = 3600_000;
const CHUNK_SIZE = 100;

interface PendingFile {
    abs: string;
    rel: string;
    moduleId: number | null;
    mtime: number;
    size: number;
}

export function readEngineVersionAt(root: string): EngineVersion | undefined {
    try {
        return parseBuildVersion(fs.readFileSync(path.join(root, 'Engine', 'Build', 'Build.version'), 'utf8'));
    } catch {
        return undefined;
    }
}

/** Changes when a plugin folder is added or removed, e.g. a Fab install. */
function pluginFoldersStamp(root: string): string {
    return ['Engine/Plugins', 'Engine/Plugins/Marketplace']
        .map(dir => {
            try {
                return String(Math.round(fs.statSync(path.join(root, dir)).mtimeMs));
            } catch {
                return '-';
            }
        })
        .join(',');
}

/** The meta table of an index, or undefined if it doesn't exist or can't be read. */
export function readIndexMeta(dbPath: string): Record<string, string> | undefined {
    if (!fs.existsSync(dbPath)) {
        return undefined;
    }
    let db: DatabaseSync | undefined;
    try {
        db = new (requireSqlite().DatabaseSync)(dbPath);
        db.exec('PRAGMA query_only = 1; PRAGMA busy_timeout = 5000;');
        return Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
    } catch {
        return undefined;
    } finally {
        db?.close();
    }
}

/** Why the index needs a sync, or undefined if it's current. */
export function staleReason(paths: EngineCachePaths, root: string, version: EngineVersion, now = Date.now()): string | undefined {
    const meta = readIndexMeta(paths.db);
    if (!meta) {
        return 'no index yet';
    }
    if (meta.parser !== String(PARSER_VERSION)) {
        return 'the parser changed';
    }
    if (meta.changelist !== String(version.changelist)) {
        return 'the engine was updated';
    }
    if (meta.plugin_stamp !== pluginFoldersStamp(root)) {
        return 'plugins were added or removed';
    }
    if (now - Number(meta.last_sync) > STALE_AFTER_MS) {
        return 'the last sync is over 12 hours old';
    }
    return undefined;
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e?.code === 'EPERM';
    }
}

/** Holder of the lock, if a live process holds it. */
export function lockHolder(lockFile: string): { pid: number; startedAt: number } | undefined {
    try {
        const holder = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        const alive = typeof holder.pid === 'number' && Date.now() - holder.startedAt < LOCK_EXPIRY_MS && pidAlive(holder.pid);
        return alive ? holder : undefined;
    } catch {
        return undefined;
    }
}

function acquireLock(lockFile: string): () => void {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx' });
            return () => fs.rmSync(lockFile, { force: true });
        } catch (e: any) {
            if (e?.code !== 'EEXIST') {
                throw e;
            }
            const holder = lockHolder(lockFile);
            if (holder) {
                throw new EngineBusyError(holder.pid, holder.startedAt);
            }
            // Left behind by a process that died
            fs.rmSync(lockFile, { force: true });
        }
    }
    throw new Error(`Could not lock ${lockFile}`);
}

/** Reports progress to the caller and, throttled, to a status file other processes can read. */
function progressReporter(statusFile: string, onProgress?: (p: SyncProgress) => void) {
    const startedAt = Date.now();
    let lastWrite = 0;
    return {
        report(progress: SyncProgress) {
            onProgress?.(progress);
            const now = Date.now();
            if (now - lastWrite > 500 || progress.phase !== 'parse') {
                lastWrite = now;
                try {
                    fs.writeFileSync(statusFile, JSON.stringify({ pid: process.pid, startedAt, ...progress }));
                } catch {
                    // Progress is informational
                }
            }
        },
        clear: () => fs.rmSync(statusFile, { force: true }),
    };
}

export function defaultJobs(): number {
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.min(8, cores - 1));
}

const abortError = () => Object.assign(new Error('Engine sync cancelled'), { name: 'AbortError' });

/** Parses files in chunks, on worker threads when available, and hands each chunk to `store`. */
async function parseFiles(files: PendingFile[], options: SyncOptions, store: (results: ParsedFile[]) => void) {
    const chunks: PendingFile[][] = [];
    for (let i = 0; i < files.length; i += CHUNK_SIZE) {
        chunks.push(files.slice(i, i + CHUNK_SIZE));
    }
    const script = options.workerScript ?? path.join(__dirname, 'parseWorker.js');
    const jobs = Math.min(options.jobs ?? defaultJobs(), chunks.length);
    if (jobs <= 1 || !fs.existsSync(script)) {
        for (const chunk of chunks) {
            if (options.signal?.aborted) {
                throw abortError();
            }
            store(chunk.map(f => parseFileRows(f.abs, f.rel)));
            // Let cancellation and progress events through
            await new Promise(resolve => setImmediate(resolve));
        }
        return;
    }

    const workers = Array.from({ length: jobs }, () => new Worker(script));
    let next = 0;
    try {
        await Promise.all(
            workers.map(
                worker =>
                    new Promise<void>((resolve, reject) => {
                        const feed = () => {
                            if (options.signal?.aborted) {
                                reject(abortError());
                            } else if (next >= chunks.length) {
                                resolve();
                            } else {
                                const chunk = chunks[next++];
                                worker.postMessage({ id: next, files: chunk.map(f => ({ abs: f.abs, rel: f.rel })) });
                            }
                        };
                        worker.on('message', (message: { results: ParsedFile[] }) => {
                            try {
                                store(message.results);
                                feed();
                            } catch (e) {
                                reject(e);
                            }
                        });
                        worker.on('error', reject);
                        feed();
                    }),
            ),
        );
    } finally {
        await Promise.all(workers.map(w => w.terminate()));
    }
}

/** Upserts plugins and modules by folder so their ids stay stable, and removes the ones that are gone. */
function writeStructure(db: DatabaseSync, scan: ScanTreeResult): Map<string, number> {
    const upsertPlugin = db.prepare(`
        INSERT INTO plugins (name, name_lower, dir, dir_lower, category, friendly, description, enabled_by_default, installed, plugin_deps, modules)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (dir_lower) DO UPDATE SET name = excluded.name, name_lower = excluded.name_lower, dir = excluded.dir,
            category = excluded.category, friendly = excluded.friendly, description = excluded.description,
            enabled_by_default = excluded.enabled_by_default, installed = excluded.installed,
            plugin_deps = excluded.plugin_deps, modules = excluded.modules
        RETURNING id`);
    const upsertModule = db.prepare(`
        INSERT INTO modules (name, name_lower, dir, dir_lower, plugin, type, loading_phase, public_deps, private_deps)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (dir_lower) DO UPDATE SET name = excluded.name, name_lower = excluded.name_lower, dir = excluded.dir,
            plugin = excluded.plugin, type = excluded.type, loading_phase = excluded.loading_phase,
            public_deps = excluded.public_deps, private_deps = excluded.private_deps
        RETURNING id`);

    db.exec('BEGIN');
    const pluginIds: number[] = [];
    for (const p of scan.plugins) {
        const row = upsertPlugin.get(
            p.name, p.name.toLowerCase(), p.dir, p.dir.toLowerCase(), p.category, p.friendlyName ?? null, p.description ?? null,
            p.enabledByDefault === undefined ? null : Number(p.enabledByDefault), p.installed ? 1 : null,
            JSON.stringify(p.pluginDeps), JSON.stringify(p.modules),
        ) as { id: number };
        pluginIds.push(row.id);
    }
    const moduleIds = new Map<string, number>();
    for (const m of scan.modules) {
        const row = upsertModule.get(
            m.name, m.name.toLowerCase(), m.dir, m.dir.toLowerCase(), m.plugin ?? null, m.type ?? null, m.loadingPhase ?? null,
            JSON.stringify(m.publicDeps), JSON.stringify(m.privateDeps),
        ) as { id: number };
        moduleIds.set(m.dir.toLowerCase(), row.id);
    }
    db.prepare('DELETE FROM plugins WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(pluginIds));
    db.prepare('DELETE FROM modules WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify([...moduleIds.values()]));
    db.exec('COMMIT');
    return moduleIds;
}

/**
 * Brings the engine's index up to date: parses new and changed files, drops deleted ones,
 * and refreshes the plugin and module tables. The first build writes to a temporary file
 * that is renamed when complete, so readers never see a half-built index.
 */
export async function syncEngineIndex(options: SyncOptions): Promise<SyncResult> {
    const started = Date.now();
    const root = canonicalRoot(options.engineRoot);
    const version = readEngineVersionAt(root);
    if (!version) {
        throw new Error(`${root} is not an Unreal Engine install (no Engine/Build/Build.version).`);
    }
    const paths = engineCachePaths(options.cacheDir, { root, version });
    fs.mkdirSync(paths.dir, { recursive: true });
    const result: SyncResult = { dbPath: paths.db, files: 0, symbols: 0, parsed: 0, removed: 0, ms: 0 };

    if (options.ifStale && !options.full && !staleReason(paths, root, version)) {
        const meta = readIndexMeta(paths.db)!;
        return { ...result, files: Number(meta.files), symbols: Number(meta.symbols), ms: Date.now() - started, skipped: 'up to date' };
    }

    const releaseLock = acquireLock(paths.lock);
    const progress = progressReporter(paths.status, options.onProgress);
    const fresh = !fs.existsSync(paths.db);
    const target = fresh ? `${paths.db}.partial` : paths.db;
    const removePartial = () => ['', '-wal', '-shm', '-journal'].forEach(suffix => fs.rmSync(target + suffix, { force: true }));
    if (fresh) {
        removePartial();
    }
    const db = new (requireSqlite().DatabaseSync)(target);
    let open = true;
    try {
        db.exec(fresh ? 'PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;' : 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000;');
        db.exec('PRAGMA cache_size = -65536; PRAGMA temp_store = MEMORY;');
        db.exec(TABLES_SQL);
        if (!fresh) {
            db.exec(INDEXES_SQL);
        }
        const meta = Object.fromEntries((db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
        const full = !!options.full || fresh || meta.parser !== String(PARSER_VERSION);

        progress.report({ phase: 'scan', done: 0, total: 0 });
        const scan = scanEngine(root);
        const moduleIds = writeStructure(db, scan);

        // Compare what's on disk with what's indexed
        const existing = new Map<string, { id: number; mtime: number; size: number; module: number | null }>();
        if (!fresh) {
            for (const row of db.prepare('SELECT id, path_lower, mtime, size, module_id FROM files').all() as any[]) {
                existing.set(row.path_lower, { id: row.id, mtime: row.mtime, size: row.size, module: row.module_id });
            }
        }
        const onDisk = [
            ...scan.modules.flatMap(m => m.files.map(rel => ({ rel, moduleId: moduleIds.get(m.dir.toLowerCase()) ?? null }))),
            ...scan.looseFiles.map(rel => ({ rel, moduleId: null })),
        ];
        const changed: PendingFile[] = [];
        const seen = new Set<string>();
        const setModule = db.prepare('UPDATE files SET module_id = ? WHERE id = ?');
        const deleteSymbols = db.prepare('DELETE FROM symbols WHERE file_id = ?');
        const deleteFile = db.prepare('DELETE FROM files WHERE id = ?');
        db.exec('BEGIN');
        for (const file of onDisk) {
            const key = file.rel.toLowerCase();
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const abs = path.join(root, file.rel);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(abs);
            } catch {
                continue;
            }
            const old = existing.get(key);
            if (!full && old && old.mtime === stat.mtimeMs && old.size === stat.size) {
                if (old.module !== file.moduleId) {
                    setModule.run(file.moduleId, old.id);
                }
                continue;
            }
            changed.push({ abs, rel: file.rel, moduleId: file.moduleId, mtime: stat.mtimeMs, size: stat.size });
        }
        for (const [key, old] of existing) {
            if (!seen.has(key)) {
                deleteSymbols.run(old.id);
                deleteFile.run(old.id);
                result.removed++;
            }
        }
        db.exec('COMMIT');

        // Parse and store. A first build keeps every name in memory; an update looks existing names up.
        const nameIds = new Map<string, number>();
        let nextNameId = fresh ? 1 : ((db.prepare('SELECT max(id) AS id FROM names').get() as { id: number | null }).id ?? 0) + 1;
        const findName = db.prepare(`SELECT id FROM names WHERE ${SIMPLE_NAME} = ? AND lower(qn) = ?`);
        const existingName = (key: string, name: string) =>
            fresh ? undefined : (findName.get(name.toLowerCase(), key) as { id: number } | undefined)?.id;
        const upsertFile = db.prepare(`
            INSERT INTO files (path, path_lower, module_id, mtime, size, lines) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (path_lower) DO UPDATE SET path = excluded.path, module_id = excluded.module_id,
                mtime = excluded.mtime, size = excluded.size, lines = excluded.lines
            RETURNING id`);
        const insertName = db.prepare('INSERT INTO names (id, qn, name_at) VALUES (?, ?, ?)');
        const insertFts = fresh ? undefined : db.prepare('INSERT INTO names_fts (rowid, qn) VALUES (?, ?)');
        const insertSymbol = db.prepare('INSERT INTO symbols (file_id, name_id, kind, flags, line, start_line, end_line, ue) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
        const pending = new Map(changed.map(f => [f.rel, f]));

        const store = (results: ParsedFile[]) => {
            db.exec('BEGIN');
            for (const parsed of results) {
                const file = pending.get(parsed.rel)!;
                const { id: fileId } = upsertFile.get(file.rel, file.rel.toLowerCase(), file.moduleId, file.mtime, file.size, parsed.lines) as { id: number };
                if (!fresh) {
                    deleteSymbols.run(fileId);
                }
                for (const [qn, name, kind, flags, line, startLine, endLine, ue] of parsed.rows) {
                    const key = qn.toLowerCase();
                    let nameId = nameIds.get(key) ?? existingName(key, name);
                    if (nameId !== undefined) {
                        nameIds.set(key, nameId);
                    } else {
                        nameId = nextNameId++;
                        nameIds.set(key, nameId);
                        insertName.run(nameId, qn, qn.length - name.length + 1);
                        insertFts?.run(nameId, qn);
                    }
                    insertSymbol.run(fileId, nameId, kind, flags, line, startLine, endLine, ue);
                }
            }
            db.exec('COMMIT');
            result.parsed += results.length;
            progress.report({ phase: 'parse', done: result.parsed, total: changed.length });
        };
        progress.report({ phase: 'parse', done: 0, total: changed.length });
        await parseFiles(changed, options, store);

        progress.report({ phase: 'index', done: 0, total: 0 });
        if (fresh) {
            db.exec(INDEXES_SQL);
            db.exec(`INSERT INTO names_fts (names_fts) VALUES ('rebuild')`);
        }
        const counts = db.prepare('SELECT (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM symbols) AS symbols').get() as { files: number; symbols: number };
        result.files = counts.files;
        result.symbols = counts.symbols;
        const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
        db.exec('BEGIN');
        for (const [key, value] of Object.entries({
            schema: SCHEMA_VERSION,
            parser: PARSER_VERSION,
            root,
            version: JSON.stringify(version),
            changelist: version.changelist,
            plugin_stamp: pluginFoldersStamp(root),
            last_sync: Date.now(),
            files: counts.files,
            symbols: counts.symbols,
        })) {
            setMeta.run(key, String(value));
        }
        db.exec('COMMIT');
        db.exec(fresh ? 'PRAGMA journal_mode = WAL' : 'PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
        open = false;
        if (fresh) {
            fs.renameSync(target, paths.db);
        }
        result.ms = Date.now() - started;
        return result;
    } catch (e) {
        if (open) {
            try {
                db.close();
            } catch {
                // Already failing
            }
        }
        if (fresh) {
            removePartial();
        }
        throw e;
    } finally {
        progress.clear();
        releaseLock();
    }
}
