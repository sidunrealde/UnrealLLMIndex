import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfo, PluginInfo, ProjectInfo } from './types';

/** Directories that never contain hand-written source. Compared case-insensitively. */
export const SKIP_DIRS = new Set([
    'intermediate', 'binaries', 'saved', 'deriveddatacache', 'content',
    '.git', '.vs', '.vscode', '.idea', 'node_modules', '.llm-index',
]);

export const SOURCE_EXTENSIONS = new Set(['.h', '.hpp', '.hh', '.inl', '.cpp', '.cc', '.cxx', '.c']);

export const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

export function readText(file: string): string {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

function readJson(file: string): any {
    try {
        return JSON.parse(readText(file));
    } catch {
        return {};
    }
}

/** Accepts a project directory, a .uproject file, or a folder with the project one level down. */
export function findUprojectFile(input: string): string | undefined {
    const resolved = path.resolve(input);
    if (resolved.toLowerCase().endsWith('.uproject') && fs.existsSync(resolved)) {
        return resolved;
    }
    const inDir = (dir: string) => {
        try {
            const match = fs.readdirSync(dir).find(f => f.toLowerCase().endsWith('.uproject'));
            return match ? path.join(dir, match) : undefined;
        } catch {
            return undefined;
        }
    };
    const direct = inDir(resolved);
    if (direct) {
        return direct;
    }
    try {
        for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
            if (entry.isDirectory() && !SKIP_DIRS.has(entry.name.toLowerCase())) {
                const nested = inDir(path.join(resolved, entry.name));
                if (nested) {
                    return nested;
                }
            }
        }
    } catch {
        // Not a readable directory
    }
    return undefined;
}

interface WalkResult {
    sources: string[];
    buildFiles: string[];
    pluginFiles: string[];
}

function walk(dir: string, out: WalkResult) {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name.toLowerCase())) {
                walk(full, out);
            }
            continue;
        }
        const lower = entry.name.toLowerCase();
        if (lower.endsWith('.build.cs')) {
            out.buildFiles.push(full);
        } else if (lower.endsWith('.uplugin')) {
            out.pluginFiles.push(full);
        } else if (SOURCE_EXTENSIONS.has(path.extname(lower))) {
            out.sources.push(full);
        }
    }
}

/** Extracts Public/PrivateDependencyModuleNames from a .Build.cs file. */
export function parseBuildCs(text: string): { publicDeps: string[]; privateDeps: string[] } {
    const clean = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const deps = { Public: new Set<string>(), Private: new Set<string>() };
    const strings = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map(m => m[1]);

    for (const m of clean.matchAll(/(Public|Private)DependencyModuleNames\s*\.\s*AddRange\s*\(\s*new\s*(?:string\s*)?\[\s*\]\s*\{([^}]*)\}/g)) {
        strings(m[2]).forEach(d => deps[m[1] as 'Public' | 'Private'].add(d));
    }
    for (const m of clean.matchAll(/(Public|Private)DependencyModuleNames\s*\.\s*Add\s*\(\s*"([^"]+)"\s*\)/g)) {
        deps[m[1] as 'Public' | 'Private'].add(m[2]);
    }
    return { publicDeps: [...deps.Public], privateDeps: [...deps.Private] };
}

const isInside = (dir: string, file: string) => file.toLowerCase().startsWith(dir.toLowerCase() + '/');

export function scanProject(input: string): ProjectInfo {
    const uprojectFile = findUprojectFile(input);
    if (!uprojectFile) {
        throw new Error(`No .uproject file found in ${path.resolve(input)}`);
    }
    const root = path.dirname(uprojectFile);
    const uproject = readJson(uprojectFile);

    const found: WalkResult = { sources: [], buildFiles: [], pluginFiles: [] };
    for (const top of ['Source', 'Plugins']) {
        walk(path.join(root, top), found);
    }

    const plugins: PluginInfo[] = found.pluginFiles.map(file => {
        const json = readJson(file);
        const description = typeof json.Description === 'string' ? json.Description.trim() : '';
        return {
            name: path.basename(file, path.extname(file)),
            dir: toRel(root, path.dirname(file)),
            friendlyName: json.FriendlyName || undefined,
            description: description ? description.slice(0, 200) : undefined,
            modules: Array.isArray(json.Modules) ? json.Modules.map((m: any) => String(m.Name)) : [],
        };
    });

    const moduleDescriptors = new Map<string, any>();
    for (const m of Array.isArray(uproject.Modules) ? uproject.Modules : []) {
        moduleDescriptors.set(String(m.Name).toLowerCase(), m);
    }
    for (const file of found.pluginFiles) {
        const json = readJson(file);
        for (const m of Array.isArray(json.Modules) ? json.Modules : []) {
            moduleDescriptors.set(String(m.Name).toLowerCase(), m);
        }
    }

    const modules: ModuleInfo[] = found.buildFiles.map(file => {
        const name = path.basename(file).replace(/\.build\.cs$/i, '');
        const dir = toRel(root, path.dirname(file));
        const plugin = plugins
            .filter(p => isInside(p.dir, dir))
            .sort((a, b) => b.dir.length - a.dir.length)[0];
        const descriptor = moduleDescriptors.get(name.toLowerCase());
        return {
            name: descriptor?.Name ? String(descriptor.Name) : name,
            dir,
            type: descriptor?.Type,
            loadingPhase: descriptor?.LoadingPhase,
            plugin: plugin?.name,
            ...parseBuildCs(readText(file)),
            files: [],
        };
    });

    // Longest directory first so nested modules win
    const byDepth = [...modules].sort((a, b) => b.dir.length - a.dir.length);
    const looseFiles: string[] = [];
    for (const abs of found.sources.sort()) {
        const rel = toRel(root, abs);
        const owner = byDepth.find(m => isInside(m.dir, rel));
        if (owner) {
            owner.files.push(rel);
        } else {
            looseFiles.push(rel);
        }
    }

    modules.sort((a, b) => Number(!!a.plugin) - Number(!!b.plugin) || a.name.localeCompare(b.name));

    const enabledPlugins = (Array.isArray(uproject.Plugins) ? uproject.Plugins : [])
        .filter((p: any) => p.Enabled !== false)
        .map((p: any) => String(p.Name));

    return {
        root,
        uprojectFile,
        name: path.basename(uprojectFile, '.uproject'),
        engineAssociation: typeof uproject.EngineAssociation === 'string' ? uproject.EngineAssociation : '',
        enabledPlugins,
        plugins,
        modules,
        looseFiles,
    };
}

export function allSourceFiles(project: ProjectInfo): string[] {
    return [...project.modules.flatMap(m => m.files), ...project.looseFiles];
}
