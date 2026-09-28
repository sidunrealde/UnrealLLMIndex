import { EngineHandle } from './engineContext';
import { ENGINE_TOPS } from './scan';
import { ripgrep, searchFiles, SearchResult, toRegex } from './search';

/** Engine folders to search: a named module, plugin or folder, or else what the project uses. */
export function engineSearchTargets(handle: EngineHandle, filter?: string): { paths: string[]; globs?: string[]; label: string } {
    const index = handle.index;
    if (filter?.trim()) {
        const f = filter.trim().replace(/\\/g, '/').replace(/\/+$/, '');
        const module = index.findModule(f);
        if (module) {
            return { paths: [module.dir], label: `engine module ${module.name}` };
        }
        const plugin = index.findPlugin(f);
        if (plugin) {
            return { paths: [plugin.dir], label: `plugin ${plugin.name}` };
        }
        if (/^engine\//i.test(f)) {
            return { paths: [f], label: f };
        }
        return { paths: ENGINE_TOPS, globs: [`**/*${f}*/**`, `**/*${f}*`], label: `engine paths containing "${filter}"` };
    }
    const moduleDirs = new Map(index.modules().map(m => [m.name.toLowerCase(), m.dir]));
    const modules = [...handle.depModules.keys()].map(k => moduleDirs.get(k)).filter((d): d is string => !!d);
    // Plugins the project chose, not the ~200 the engine enables by default
    const plugins = [...handle.enabled.values()].filter(e => e.plugin.category !== 'project' && e.reason !== 'default').map(e => e.plugin.dir);
    const sorted = [...new Set([...modules, ...plugins])].sort();
    const paths = sorted.filter((dir, i) => !sorted.some((other, j) => j !== i && dir.toLowerCase().startsWith(other.toLowerCase() + '/')));
    return { paths, label: `the ${modules.length} engine modules the project depends on and ${plugins.length} plugins it enables (pass path_filter to search elsewhere)` };
}

/**
 * Searches engine code with ripgrep, or without it by reading the indexed files of the chosen
 * folders (refused past 3,000 files). Paths in the result are relative to the engine root.
 */
export async function searchEngineCode(
    handle: EngineHandle,
    rgPath: string | undefined,
    options: { pattern: string; ignoreCase: boolean; filter?: string; maxResults: number },
): Promise<SearchResult & { label: string }> {
    const target = engineSearchTargets(handle, options.filter);
    if (rgPath) {
        const result = await ripgrep({
            rgPath,
            cwd: handle.install.root,
            paths: target.paths,
            pattern: options.pattern,
            ignoreCase: options.ignoreCase,
            globs: target.globs,
            maxResults: options.maxResults,
        });
        return { ...result, label: target.label };
    }
    const filter = options.filter?.trim().toLowerCase();
    const files = target.paths.flatMap(dir => handle.index.filesUnder(dir)).filter(rel => !target.globs || !filter || rel.toLowerCase().includes(filter));
    if (files.length > 3000) {
        throw new Error(`Searching ${files.length} engine files needs ripgrep, which wasn't found. Pass a narrower path_filter (a module, plugin or folder name).`);
    }
    const result = searchFiles(files, rel => handle.index.readFileLines(rel), toRegex(options.pattern, options.ignoreCase), options.maxResults);
    return { ...result, label: target.label };
}
