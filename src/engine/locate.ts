import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Contents of Engine/Build/Build.version. */
export interface EngineVersion {
    major: number;
    minor: number;
    patch: number;
    changelist: number;
    branch?: string;
}

export type EngineSource = 'setting' | 'registry' | 'launcher' | 'sourceBuild' | 'defaultDir' | 'parentDir';

export interface EngineInstall {
    /** The folder that contains Engine/. */
    root: string;
    version: EngineVersion;
    /** Where the install was found. */
    source: EngineSource;
    /** The version ("5.8") or source-build id it was registered under. */
    id?: string;
}

/** A registered engine that failed validation, e.g. an uninstalled version left in the registry. */
export interface EngineCandidate {
    root: string;
    source: EngineSource;
    id?: string;
    version?: EngineVersion;
    problem?: string;
}

export interface EngineLookupError {
    error: string;
    candidates: EngineCandidate[];
}

/** File and registry access, injectable for tests. */
export interface LocateEnv {
    platform: NodeJS.Platform;
    home: string;
    programData?: string;
    programFiles?: string;
    readFile(file: string): string | undefined;
    /** Output of `reg query <key> /s` (Windows only), or undefined if the key doesn't exist. */
    regQuery?(key: string): string | undefined;
    /** Canonical on-disk casing of a path. */
    realpath?(p: string): string;
}

export const versionLabel = (v: EngineVersion) => `${v.major}.${v.minor}.${v.patch}`;

export function defaultLocateEnv(): LocateEnv {
    return {
        platform: process.platform,
        home: os.homedir(),
        programData: process.env.ProgramData ?? process.env.PROGRAMDATA,
        programFiles: process.env.ProgramFiles ?? process.env.PROGRAMFILES,
        readFile: file => {
            try {
                return fs.readFileSync(file, 'utf8');
            } catch {
                return undefined;
            }
        },
        regQuery: key => {
            try {
                return execFileSync('reg', ['query', key, '/s'], {
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 5000,
                    stdio: ['ignore', 'pipe', 'ignore'],
                });
            } catch {
                return undefined;
            }
        },
        realpath: p => {
            try {
                return fs.realpathSync.native(p);
            } catch {
                return p;
            }
        },
    };
}

export function parseBuildVersion(json: string): EngineVersion | undefined {
    try {
        const v = JSON.parse(json.replace(/^﻿/, ''));
        if (typeof v.MajorVersion !== 'number' || typeof v.MinorVersion !== 'number') {
            return undefined;
        }
        return {
            major: v.MajorVersion,
            minor: v.MinorVersion,
            patch: Number(v.PatchVersion) || 0,
            changelist: Number(v.Changelist) || 0,
            branch: typeof v.BranchName === 'string' ? v.BranchName : undefined,
        };
    } catch {
        return undefined;
    }
}

/** Parses `reg query /s` output into key path → value name → data. */
export function parseRegQuery(stdout: string): Map<string, Map<string, string>> {
    const keys = new Map<string, Map<string, string>>();
    let current: Map<string, string> | undefined;
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.replace(/\s+$/, '');
        if (/^HKEY_/i.test(line)) {
            current = new Map();
            keys.set(line, current);
            continue;
        }
        const value = /^\s+(.*?)\s{4}(REG_[A-Z_]+)(?:\s{4}(.*))?$/.exec(line);
        if (value && current) {
            current.set(value[1], value[3] ?? '');
        }
    }
    return keys;
}

/** Engine entries ("AppName": "UE_5.8") of the Epic launcher's LauncherInstalled.dat. */
export function parseLauncherInstalled(json: string): { version: string; location: string }[] {
    try {
        const list = JSON.parse(json.replace(/^﻿/, '')).InstallationList;
        return (Array.isArray(list) ? list : [])
            .map((e: any) => ({ match: /^UE_(\d+\.\d+)$/.exec(String(e?.AppName ?? '')), location: e?.InstallLocation }))
            .filter((e: any) => e.match && typeof e.location === 'string')
            .map((e: any) => ({ version: e.match[1], location: e.location }));
    } catch {
        return [];
    }
}

/** The [Installations] section of Install.ini (source builds on macOS and Linux): id → path. */
export function parseInstallIni(text: string): Map<string, string> {
    const result = new Map<string, string>();
    let inSection = false;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('[')) {
            inSection = line.toLowerCase() === '[installations]';
        } else if (inSection && line.includes('=')) {
            const eq = line.indexOf('=');
            result.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
        }
    }
    return result;
}

export function normalizeAssociation(association: string): { kind: 'version' | 'id' | 'empty'; value: string } {
    const value = association.trim();
    if (!value) {
        return { kind: 'empty', value };
    }
    return /^\d+\.\d+$/.test(value) ? { kind: 'version', value } : { kind: 'id', value };
}

const sameId = (a: string, b: string) => a.replace(/[{}]/g, '').toLowerCase() === b.replace(/[{}]/g, '').toLowerCase();

/** Every engine registered on this machine, before validation. */
function registeredEngines(env: LocateEnv): Omit<EngineCandidate, 'version' | 'problem'>[] {
    const found: Omit<EngineCandidate, 'version' | 'problem'>[] = [];
    const launcher = (file: string) =>
        parseLauncherInstalled(env.readFile(file) ?? '').forEach(e => found.push({ root: e.location, source: 'launcher', id: e.version }));
    const installIni = (file: string) =>
        parseInstallIni(env.readFile(file) ?? '').forEach((root, id) => found.push({ root, source: 'sourceBuild', id }));

    if (env.platform === 'win32') {
        for (const key of ['HKLM\\SOFTWARE\\EpicGames\\Unreal Engine', 'HKLM\\SOFTWARE\\WOW6432Node\\EpicGames\\Unreal Engine']) {
            for (const [keyPath, values] of parseRegQuery(env.regQuery?.(key) ?? '')) {
                const id = keyPath.split('\\').pop() ?? '';
                const dir = values.get('InstalledDirectory');
                if (dir && /^\d+\.\d+$/.test(id)) {
                    found.push({ root: dir, source: 'registry', id });
                }
            }
        }
        for (const values of parseRegQuery(env.regQuery?.('HKCU\\Software\\Epic Games\\Unreal Engine\\Builds') ?? '').values()) {
            values.forEach((root, id) => found.push({ root, source: 'sourceBuild', id }));
        }
        launcher(path.join(env.programData ?? 'C:\\ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'));
    } else if (env.platform === 'darwin') {
        launcher(path.join(env.home, 'Library', 'Application Support', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'));
        installIni(path.join(env.home, 'Library', 'Application Support', 'Epic', 'UnrealEngine', 'Install.ini'));
    } else {
        installIni(path.join(env.home, '.config', 'Epic', 'UnrealEngine', 'Install.ini'));
    }
    return found;
}

function defaultDirs(version: string, env: LocateEnv): string[] {
    if (env.platform === 'win32') {
        return [path.join(env.programFiles ?? 'C:\\Program Files', 'Epic Games', `UE_${version}`)];
    }
    return env.platform === 'darwin' ? [path.join('/Users/Shared/Epic Games', `UE_${version}`)] : [];
}

/** Accepts the install folder or its Engine/ subfolder. */
function normalizeRoot(input: string, env: LocateEnv): string {
    const trimmed = input.trim().replace(/[\\/]+$/, '');
    const hasVersion = (dir: string) => env.readFile(path.join(dir, 'Engine', 'Build', 'Build.version')) !== undefined;
    if (!hasVersion(trimmed) && path.basename(trimmed).toLowerCase() === 'engine' && hasVersion(path.dirname(trimmed))) {
        return path.dirname(trimmed);
    }
    return trimmed;
}

function validate(candidate: Omit<EngineCandidate, 'version' | 'problem'>, env: LocateEnv): EngineCandidate {
    const root = normalizeRoot(candidate.root, env);
    const text = env.readFile(path.join(root, 'Engine', 'Build', 'Build.version'));
    const version = text === undefined ? undefined : parseBuildVersion(text);
    if (!version) {
        return { ...candidate, root, problem: text === undefined ? 'no Engine/Build/Build.version (not installed, or incomplete)' : 'unreadable Build.version' };
    }
    return { ...candidate, root: env.realpath?.(root) ?? root, version };
}

const toInstall = (c: EngineCandidate): EngineInstall => ({ root: c.root, version: c.version!, source: c.source, id: c.id });

/** Registered engines with their versions, or why each one isn't usable. Duplicates are removed. */
export function listEngineCandidates(env: LocateEnv = defaultLocateEnv()): EngineCandidate[] {
    const seen = new Set<string>();
    const result: EngineCandidate[] = [];
    for (const raw of registeredEngines(env)) {
        const candidate = validate(raw, env);
        const key = candidate.root.toLowerCase().replace(/\\/g, '/');
        if (!seen.has(key)) {
            seen.add(key);
            result.push(candidate);
        }
    }
    return result;
}

/**
 * Finds the engine a project uses, from its EngineAssociation: a launcher version ("5.8"),
 * a registered source build (a GUID or name), or empty for a project inside an engine tree.
 */
export function locateEngine(
    association: string,
    projectRoot: string,
    options: { override?: string; env?: LocateEnv } = {},
): EngineInstall | EngineLookupError {
    const env = options.env ?? defaultLocateEnv();
    const lookupError = (error: string): EngineLookupError => ({ error, candidates: listEngineCandidates(env) });

    if (options.override?.trim()) {
        const candidate = validate({ root: options.override, source: 'setting' }, env);
        return candidate.version
            ? toInstall(candidate)
            : lookupError(`The configured engine path "${options.override}" is not an Unreal Engine install: ${candidate.problem}.`);
    }

    const assoc = normalizeAssociation(association);
    const problems: string[] = [];
    const tryAll = (candidates: Omit<EngineCandidate, 'version' | 'problem'>[]) => {
        for (const raw of candidates) {
            const candidate = validate(raw, env);
            if (candidate.version) {
                return toInstall(candidate);
            }
            problems.push(`${candidate.root} (${candidate.source}): ${candidate.problem}`);
        }
        return undefined;
    };

    const registered = registeredEngines(env);
    let found: EngineInstall | undefined;
    if (assoc.kind === 'version') {
        found = tryAll([
            ...registered.filter(c => (c.source === 'registry' || c.source === 'launcher') && c.id === assoc.value),
            ...defaultDirs(assoc.value, env).map(root => ({ root, source: 'defaultDir' as const, id: assoc.value })),
        ]);
    } else if (assoc.kind === 'id') {
        found = tryAll(registered.filter(c => c.source === 'sourceBuild' && c.id !== undefined && sameId(c.id, assoc.value)));
    }
    if (found) {
        return found;
    }

    // The project may live inside an engine tree (source builds with an empty association)
    let dir = path.resolve(projectRoot);
    for (;;) {
        const candidate = validate({ root: dir, source: 'parentDir' }, env);
        if (candidate.version) {
            return toInstall(candidate);
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }

    const wanted = assoc.kind === 'empty' ? 'no EngineAssociation' : `EngineAssociation "${assoc.value}"`;
    const tried = problems.length ? ` Tried: ${problems.join('; ')}.` : '';
    return lookupError(`No Unreal Engine install found for ${wanted}.${tried} Set unrealLlmIndex.enginePath (or pass --engine) to the engine folder.`);
}
