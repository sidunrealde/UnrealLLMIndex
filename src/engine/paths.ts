import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EngineVersion } from './locate';
import { SCHEMA_VERSION } from './schema';

/**
 * Where engine indexes are kept: one shared folder per user, so the CLI and every VS Code window
 * reuse the same database. UE_LLM_INDEX_CACHE overrides it.
 */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
    if (env.UE_LLM_INDEX_CACHE) {
        return env.UE_LLM_INDEX_CACHE;
    }
    if (platform === 'win32') {
        return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'unreal-llm-index');
    }
    if (platform === 'darwin') {
        return path.join(home, 'Library', 'Caches', 'unreal-llm-index');
    }
    return path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'unreal-llm-index');
}

/** An absolute engine root with its on-disk casing, so every process derives the same cache folder. */
export function canonicalRoot(root: string): string {
    const resolved = path.resolve(root.trim()).replace(/[\\/]+$/, '');
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        return resolved;
    }
}

export interface EngineCachePaths {
    dir: string;
    db: string;
    /** Held by the process that is updating the database. */
    lock: string;
    /** Progress of a running build, for other processes to report. */
    status: string;
}

/**
 * One folder per engine install: "<major>.<minor>-<hash of the install path>". The path is made
 * canonical first, so "C:\Users\RUNNER~1\..." and its long form share a folder.
 */
export function engineCachePaths(cacheDir: string, engine: { root: string; version: EngineVersion }): EngineCachePaths {
    const hash = createHash('sha1').update(canonicalRoot(engine.root).toLowerCase().replace(/\\/g, '/')).digest('hex').slice(0, 10);
    const dir = path.join(cacheDir, 'engines', `${engine.version.major}.${engine.version.minor}-${hash}`);
    return {
        dir,
        db: path.join(dir, `index.v${SCHEMA_VERSION}.db`),
        lock: path.join(dir, 'sync.lock'),
        status: path.join(dir, 'status.json'),
    };
}
