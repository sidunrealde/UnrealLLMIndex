import { describe, expect, it } from 'vitest';
import { engineModuleClosure, resolveEnabledPlugins } from '../src/engine/enablement';
import { ModuleInfo, PluginInfo } from '../src/types';

const plugin = (name: string, category: PluginInfo['category'], extra: Partial<PluginInfo> = {}): PluginInfo => ({
    name,
    dir: `Plugins/${name}`,
    modules: [name],
    category,
    pluginDeps: [],
    ...extra,
});

const engine = [
    plugin('EnhancedInput', 'engine', { enabledByDefault: false }),
    plugin('DefaultOn', 'engine', { enabledByDefault: true, pluginDeps: [{ name: 'Hidden', enabled: true }, { name: 'Optional', enabled: false }] }),
    plugin('Hidden', 'engine'),
    plugin('Optional', 'engine'),
    plugin('Fabby', 'marketplace', { enabledByDefault: false, installed: true }),
    plugin('Shadowed', 'engine', { enabledByDefault: true }),
];

describe('resolveEnabledPlugins', () => {
    const resolve = (refs: { name: string; enabled: boolean }[], disableEnginePluginsByDefault = false) =>
        resolveEnabledPlugins({
            refs,
            disableEnginePluginsByDefault,
            projectPlugins: [plugin('Telemetry', 'project'), plugin('OptOut', 'project', { enabledByDefault: false }), plugin('Shadowed', 'project')],
            enginePlugins: engine,
        });

    it('follows the .uproject, descriptor defaults and dependencies', () => {
        const enabled = resolve([{ name: 'EnhancedInput', enabled: true }]);
        const reasons = Object.fromEntries([...enabled].map(([key, e]) => [key, e.reason + (e.via ? `:${e.via}` : '')]));
        expect(reasons).toEqual({
            enhancedinput: 'uproject',
            telemetry: 'project',
            shadowed: 'project',
            defaulton: 'default',
            hidden: 'dependency:DefaultOn',
        });
        // Project plugins shadow engine plugins with the same name
        expect(enabled.get('shadowed')?.plugin.category).toBe('project');
    });

    it('lets the .uproject turn plugins off, including defaults and dependencies', () => {
        const enabled = resolve([{ name: 'DefaultOn', enabled: false }, { name: 'Telemetry', enabled: false }]);
        expect([...enabled.keys()].sort()).toEqual(['shadowed']);
    });

    it('honours DisableEnginePluginsByDefault and explicit Marketplace plugins', () => {
        const enabled = resolve([{ name: 'fabby', enabled: true }], true);
        expect([...enabled.keys()].sort()).toEqual(['fabby', 'shadowed', 'telemetry']);
    });
});

describe('engineModuleClosure', () => {
    const module = (name: string, publicDeps: string[] = [], privateDeps: string[] = []): ModuleInfo => ({ name, dir: name, publicDeps, privateDeps, files: [] });
    const engineModules = new Map(
        [module('Core'), module('CoreUObject', ['Core']), module('Engine', ['Core', 'CoreUObject'], ['InputCore']), module('InputCore', ['Core'])].map(m => [m.name.toLowerCase(), m]),
    );

    it('takes Build.cs dependencies and their public dependencies, not private ones', () => {
        const closure = engineModuleClosure([module('Game', ['Engine'], ['Json'])], engineModules);
        expect([...closure]).toEqual([['engine', 'direct'], ['core', 'transitive'], ['coreuobject', 'transitive']]);
    });
});
