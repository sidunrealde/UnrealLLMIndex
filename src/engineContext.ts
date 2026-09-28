import * as fs from 'fs';
import { EnabledPlugin, engineModuleClosure, resolveEnabledPlugins } from './engine/enablement';
import { EngineIndex, RankContext } from './engine/engineIndex';
import { EngineInstall, EngineLookupError, locateEngine, versionLabel } from './engine/locate';
import { EngineCachePaths, engineCachePaths } from './engine/paths';
import { lockHolder } from './engine/sync';
import { ProjectIndex } from './indexer';
import { loadSqlite, SQLITE_MISSING } from './sqlite';
import { ModuleInfo, ProjectInfo } from './types';

/** An engine index ready to query, with what the project uses from it. */
export interface EngineHandle {
    install: EngineInstall;
    index: EngineIndex;
    /** Plugins the project loads (its own included), keyed by lower-case name. */
    enabled: Map<string, EnabledPlugin>;
    /** Engine modules the project depends on, keyed by lower-case name. */
    depModules: Map<string, 'direct' | 'transitive'>;
    rank: RankContext;
}

/** Either a usable engine index, or why there isn't one (shown to the model as is). */
export type EngineState = { handle: EngineHandle } | { message: string; install?: EngineInstall };

export interface EngineProviderOptions {
    project: ProjectIndex;
    cacheDir: string;
    /**
     * The engine to use: an install, a lookup error to report, null to turn engine lookups off,
     * or undefined to locate it from the project's EngineAssociation on first use.
     */
    install?: EngineInstall | EngineLookupError | null;
}

/**
 * Opens the project's engine index once it exists (another process may still be building it)
 * and keeps the project's plugin and module view of it current.
 */
export class EngineProvider {
    private located: EngineInstall | EngineLookupError | null | undefined;
    private index?: EngineIndex;
    private handle?: EngineHandle;
    private handleKey = '';

    constructor(private readonly options: EngineProviderOptions) {
        this.located = options.install;
    }

    private locate(): EngineInstall | EngineLookupError | null {
        if (this.located === undefined) {
            const project = this.options.project.project;
            this.located = locateEngine(project.engineAssociation, project.root);
        }
        return this.located;
    }

    get install(): EngineInstall | undefined {
        const located = this.locate();
        return located && !('error' in located) ? located : undefined;
    }

    get paths(): EngineCachePaths | undefined {
        const install = this.install;
        return install && engineCachePaths(this.options.cacheDir, install);
    }

    state(): EngineState {
        const located = this.locate();
        if (located === null) {
            return { message: 'Engine lookups are turned off (unrealLlmIndex.engine.enabled).' };
        }
        if ('error' in located) {
            return { message: located.error };
        }
        if (!loadSqlite()) {
            return { message: SQLITE_MISSING, install: located };
        }
        if (!this.index) {
            const paths = engineCachePaths(this.options.cacheDir, located);
            if (!fs.existsSync(paths.db)) {
                return { message: notIndexedMessage(located, paths), install: located };
            }
            try {
                this.index = EngineIndex.open(paths.db, located.root);
            } catch (e: any) {
                return { message: `Could not open the engine index ${paths.db}: ${e.message}`, install: located };
            }
        }
        const key = `${this.options.project.structureKey}|${this.index.syncStamp}`;
        if (!this.handle || key !== this.handleKey) {
            const project = this.options.project.project;
            const enabled = resolveEnabledPlugins({
                refs: project.pluginRefs,
                disableEnginePluginsByDefault: project.disableEnginePluginsByDefault,
                projectPlugins: project.plugins,
                enginePlugins: this.index.plugins(),
            });
            const engineModules = new Map<string, ModuleInfo>(this.index.modules().map(m => [m.name.toLowerCase(), m]));
            const depModules = engineModuleClosure(project.modules, engineModules);
            this.handle = { install: located, index: this.index, enabled, depModules, rank: { depModules, enabledPlugins: new Set(enabled.keys()) } };
            this.handleKey = key;
        }
        return { handle: this.handle };
    }

    dispose() {
        this.index?.close();
        this.index = undefined;
        this.handle = undefined;
    }
}

function notIndexedMessage(install: EngineInstall, paths: EngineCachePaths): string {
    const label = `Unreal Engine ${versionLabel(install.version)}`;
    if (lockHolder(paths.lock)) {
        let progress = '';
        try {
            const status = JSON.parse(fs.readFileSync(paths.status, 'utf8'));
            progress = status.phase === 'parse' && status.total ? ` (${Math.floor((100 * status.done) / status.total)}%)` : status.phase === 'index' ? ' (finishing)' : '';
        } catch {
            // No progress yet
        }
        return `The ${label} index is being built${progress}. Engine lookups work once it finishes, usually within a minute or two; use scope "project" meanwhile.`;
    }
    return `${label} (${install.root}) has not been indexed yet. Run "Unreal LLM Index: Sync Engine Index" in VS Code, or \`ue-llm-index engine sync\`.`;
}

const count = (n: string | number | undefined) => Number(n ?? 0).toLocaleString('en-US');

/** The "## Engine" part of INDEX.md: kept short, with the details behind list_plugins and the tools. */
export function renderEngineSection(state: EngineState, project: ProjectInfo): string[] {
    const out = ['## Engine'];
    if ('message' in state) {
        if (state.install) {
            out.push(`- Unreal Engine ${versionLabel(state.install.version)} at ${state.install.root}`);
        }
        out.push(`- ${state.message}`);
        return out;
    }
    const { install, index, enabled, depModules } = state.handle;
    const meta = index.meta();
    out.push(
        `- Unreal Engine ${versionLabel(install.version)} at ${install.root}: ${count(meta.files)} source files and ${count(meta.symbols)} symbols indexed, ` +
            'including engine and Marketplace plugins. Use scope "engine" or "all" in find_symbol, read_symbol and search_code.',
    );
    const fromUproject = project.pluginRefs
        .filter(r => r.enabled && enabled.get(r.name.toLowerCase())?.plugin.category !== 'project')
        .map(r => enabled.get(r.name.toLowerCase())?.plugin.name ?? `${r.name} (not found in the engine)`);
    if (fromUproject.length) {
        out.push(`- Engine plugins the .uproject enables: ${fromUproject.join(', ')}`);
    }
    const marketplace = index.plugins().filter(p => p.category === 'marketplace');
    if (marketplace.length) {
        out.push(`- Marketplace/Fab plugins installed in the engine: ${marketplace.map(p => `${p.name}${enabled.has(p.name.toLowerCase()) ? ' (enabled)' : ''}`).join(', ')}`);
    }
    const names = new Map(index.modules().map(m => [m.name.toLowerCase(), m.name]));
    const direct = [...depModules].filter(([, kind]) => kind === 'direct').map(([key]) => names.get(key) ?? key);
    if (direct.length) {
        out.push(`- Engine modules the project's Build.cs files use: ${direct.join(', ')} (and ${depModules.size - direct.length} more through their public dependencies)`);
    }
    out.push(`- ${enabled.size} plugins are enabled in all, counting defaults and dependencies; list_plugins(query) shows them.`);
    return out;
}
