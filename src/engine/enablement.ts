import { ModuleInfo, PluginInfo, PluginRef } from '../types';

/** Why a plugin is enabled for the project. */
export type EnabledReason = 'uproject' | 'project' | 'default' | 'dependency';

export interface EnabledPlugin {
    plugin: PluginInfo;
    reason: EnabledReason;
    /** For dependencies: the plugin that needs this one. */
    via?: string;
}

export interface EnablementInput {
    /** The .uproject's "Plugins" list. */
    refs: PluginRef[];
    disableEnginePluginsByDefault: boolean;
    projectPlugins: PluginInfo[];
    enginePlugins: PluginInfo[];
}

/**
 * Which plugins the project loads, keyed by lower-case name. Follows UE's rules: the .uproject's
 * list wins; otherwise project plugins are on unless they opt out, and engine plugins are off
 * unless their descriptor says EnabledByDefault. Plugins that enabled plugins depend on are on too.
 */
export function resolveEnabledPlugins(input: EnablementInput): Map<string, EnabledPlugin> {
    const byName = new Map<string, PluginInfo>();
    for (const plugin of input.enginePlugins) {
        byName.set(plugin.name.toLowerCase(), plugin);
    }
    // Project plugins shadow engine plugins with the same name
    for (const plugin of input.projectPlugins) {
        byName.set(plugin.name.toLowerCase(), plugin);
    }
    const explicit = new Map(input.refs.map(r => [r.name.toLowerCase(), r.enabled]));

    const enabled = new Map<string, EnabledPlugin>();
    const queue: string[] = [];
    const enable = (key: string, reason: EnabledReason, via?: string) => {
        const plugin = byName.get(key);
        if (plugin && !enabled.has(key) && explicit.get(key) !== false) {
            enabled.set(key, { plugin, reason, via });
            queue.push(key);
        }
    };

    for (const [key, isOn] of explicit) {
        if (isOn) {
            enable(key, 'uproject');
        }
    }
    for (const [key, plugin] of byName) {
        if (plugin.category === 'project' ? plugin.enabledByDefault !== false : plugin.enabledByDefault === true && !input.disableEnginePluginsByDefault) {
            enable(key, plugin.category === 'project' ? 'project' : 'default');
        }
    }
    while (queue.length) {
        const { plugin } = enabled.get(queue.shift()!)!;
        for (const dep of plugin.pluginDeps) {
            if (dep.enabled) {
                enable(dep.name.toLowerCase(), 'dependency', plugin.name);
            }
        }
    }
    return enabled;
}

/**
 * Engine modules the project's modules depend on, keyed by lower-case name: 'direct' for modules
 * listed in their Build.cs files, 'transitive' for the public dependencies of those.
 */
export function engineModuleClosure(projectModules: ModuleInfo[], engineModules: Map<string, ModuleInfo>): Map<string, 'direct' | 'transitive'> {
    const result = new Map<string, 'direct' | 'transitive'>();
    const queue: string[] = [];
    const add = (name: string, kind: 'direct' | 'transitive') => {
        const key = name.toLowerCase();
        if (engineModules.has(key) && !result.has(key)) {
            result.set(key, kind);
            queue.push(key);
        }
    };
    for (const module of projectModules) {
        [...module.publicDeps, ...module.privateDeps].forEach(dep => add(dep, 'direct'));
    }
    while (queue.length) {
        engineModules.get(queue.shift()!)!.publicDeps.forEach(dep => add(dep, 'transitive'));
    }
    return result;
}
