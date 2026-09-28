type SqliteModule = typeof import('node:sqlite');

let loaded: SqliteModule | null | undefined;

/** Node's built-in SQLite (Node.js 22.13+), or undefined on runtimes without it. Loaded on first use. */
export function loadSqlite(): SqliteModule | undefined {
    if (loaded === undefined) {
        try {
            loaded = (process.getBuiltinModule?.('node:sqlite') as SqliteModule | undefined) ?? null;
        } catch {
            loaded = null;
        }
    }
    return loaded ?? undefined;
}

export const SQLITE_MISSING = 'The engine index needs Node.js 22.13 or later (node:sqlite). VS Code 1.101 and later include it.';

export function requireSqlite(): SqliteModule {
    const sqlite = loadSqlite();
    if (!sqlite) {
        throw new Error(SQLITE_MISSING);
    }
    return sqlite;
}
