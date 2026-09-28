import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfo, PluginCategory, PluginInfo, PluginRef, ProjectInfo } from './types';

/** Directories that never contain hand-written source. Compared case-insensitively. */
export const SKIP_DIRS = new Set([
    'intermediate', 'binaries', 'saved', 'deriveddatacache', 'content',
    '.git', '.vs', '.vscode', '.idea', 'node_modules', '.llm-index',
]);

/** Engine installs also skip bundled third-party code, standalone programs, plugin templates and non-code folders. */
export const ENGINE_SKIP_DIRS = new Set([...SKIP_DIRS, 'thirdparty', 'programs', 'resources', 'shaders', 'documentation', 'extras', 'templates']);

/** Engine folders that hold modules and plugins, relative to the install root. */
export const ENGINE_TOPS = ['Engine/Source/Runtime', 'Engine/Source/Developer', 'Engine/Source/Editor', 'Engine/Plugins', 'Engine/Platforms'];

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

/** "Plugins" entries of a .uproject or .uplugin. */
function pluginRefs(list: unknown): PluginRef[] {
    return Array.isArray(list)
        ? list.filter(p => p && typeof p.Name === 'string').map(p => ({ name: String(p.Name), enabled: p.Enabled !== false }))
        : [];
}

/** Module entries (Name, Type, LoadingPhase) of a descriptor, keyed by lower-case name. */
function moduleDescriptors(list: unknown): Map<string, any> {
    const map = new Map<string, any>();
    for (const m of Array.isArray(list) ? list : []) {
        if (m && typeof m.Name === 'string') {
            map.set(m.Name.toLowerCase(), m);
        }
    }
    return map;
}

export interface ScanTreeOptions {
    /** Directory names to skip, lower-case. Defaults to SKIP_DIRS. */
    skipDirs?: Set<string>;
    /** Category of a plugin found in `dir` (relative to the base). Defaults to 'project'. */
    categoryOf?: (dir: string) => PluginCategory;
    /** Module descriptors known before the walk, such as the .uproject's. */
    moduleDescriptors?: Map<string, any>;
}

export interface ScanTreeResult {
    plugins: PluginInfo[];
    modules: ModuleInfo[];
    /** Source files that are not inside a module. */
    looseFiles: string[];
}

interface WalkContext {
    plugin?: PluginInfo;
    descriptors: Map<string, any>;
    module?: ModuleInfo;
}

/**
 * Finds plugins (*.uplugin), modules (*.Build.cs) and source files under `tops` in one walk.
 * Each file belongs to the innermost module above it, and each module to the innermost plugin.
 */
export function scanTree(base: string, tops: string[], options: ScanTreeOptions = {}): ScanTreeResult {
    const skip = options.skipDirs ?? SKIP_DIRS;
    const result: ScanTreeResult = { plugins: [], modules: [], looseFiles: [] };

    const walk = (dir: string, rel: string, ctx: WalkContext) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        // Descriptors first: they own everything in and below this folder
        for (const entry of entries) {
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.uplugin')) {
                const json = readJson(path.join(dir, entry.name));
                const description = typeof json.Description === 'string' ? json.Description.trim() : '';
                const plugin: PluginInfo = {
                    name: entry.name.slice(0, -'.uplugin'.length),
                    dir: rel,
                    friendlyName: typeof json.FriendlyName === 'string' && json.FriendlyName ? json.FriendlyName : undefined,
                    description: description ? description.slice(0, 200) : undefined,
                    modules: Array.isArray(json.Modules) ? json.Modules.map((m: any) => String(m.Name)) : [],
                    category: options.categoryOf?.(rel) ?? 'project',
                    enabledByDefault: typeof json.EnabledByDefault === 'boolean' ? json.EnabledByDefault : undefined,
                    installed: json.Installed === true ? true : undefined,
                    pluginDeps: pluginRefs(json.Plugins),
                };
                result.plugins.push(plugin);
                ctx = { plugin, descriptors: moduleDescriptors(json.Modules) };
            }
        }
        for (const entry of entries) {
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.build.cs')) {
                const name = entry.name.slice(0, -'.build.cs'.length);
                const descriptor = ctx.descriptors.get(name.toLowerCase()) ?? options.moduleDescriptors?.get(name.toLowerCase());
                const module: ModuleInfo = {
                    name: descriptor?.Name ? String(descriptor.Name) : name,
                    dir: rel,
                    type: descriptor?.Type,
                    loadingPhase: descriptor?.LoadingPhase,
                    plugin: ctx.plugin?.name,
                    ...parseBuildCs(readText(path.join(dir, entry.name))),
                    files: [],
                };
                result.modules.push(module);
                ctx = { ...ctx, module };
            }
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!skip.has(entry.name.toLowerCase())) {
                    walk(path.join(dir, entry.name), `${rel}/${entry.name}`, ctx);
                }
            } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                (ctx.module ? ctx.module.files : result.looseFiles).push(`${rel}/${entry.name}`);
            }
        }
    };

    for (const top of tops) {
        walk(path.join(base, top), top.split(/[\\/]/).join('/'), { descriptors: new Map() });
    }
    for (const module of result.modules) {
        module.files.sort();
    }
    result.looseFiles.sort();
    return result;
}

export function scanProject(input: string): ProjectInfo {
    const uprojectFile = findUprojectFile(input);
    if (!uprojectFile) {
        throw new Error(`No .uproject file found in ${path.resolve(input)}`);
    }
    const root = path.dirname(uprojectFile);
    const uproject = readJson(uprojectFile);

    const { plugins, modules, looseFiles } = scanTree(root, ['Source', 'Plugins'], { moduleDescriptors: moduleDescriptors(uproject.Modules) });
    modules.sort((a, b) => Number(!!a.plugin) - Number(!!b.plugin) || a.name.localeCompare(b.name));

    const refs = pluginRefs(uproject.Plugins);
    return {
        root,
        uprojectFile,
        name: path.basename(uprojectFile, '.uproject'),
        engineAssociation: typeof uproject.EngineAssociation === 'string' ? uproject.EngineAssociation : '',
        enabledPlugins: refs.filter(p => p.enabled).map(p => p.name),
        pluginRefs: refs,
        disableEnginePluginsByDefault: uproject.DisableEnginePluginsByDefault === true,
        plugins,
        modules,
        looseFiles,
    };
}

export function engineCategoryOf(dir: string): PluginCategory {
    const lower = dir.toLowerCase();
    if (lower.startsWith('engine/plugins/marketplace/')) {
        return 'marketplace';
    }
    return lower.startsWith('engine/platforms/') ? 'platform' : 'engine';
}

/** Modules and plugins of an engine install. `root` is the folder that contains Engine/. */
export function scanEngine(root: string): ScanTreeResult {
    return scanTree(root, ENGINE_TOPS, { skipDirs: ENGINE_SKIP_DIRS, categoryOf: engineCategoryOf });
}

export function allSourceFiles(project: ProjectInfo): string[] {
    return [...project.modules.flatMap(m => m.files), ...project.looseFiles];
}
