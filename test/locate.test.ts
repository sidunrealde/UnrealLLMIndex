import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    listEngineCandidates,
    LocateEnv,
    locateEngine,
    normalizeAssociation,
    parseBuildVersion,
    parseInstallIni,
    parseLauncherInstalled,
    parseRegQuery,
} from '../src/engine/locate';

const FAKE_ENGINE = path.join(__dirname, 'fixtures/FakeEngine/UE_9.9');

const BUILD_VERSION = JSON.stringify({ MajorVersion: 5, MinorVersion: 8, PatchVersion: 3, Changelist: 58210709, BranchName: '++UE5+Release-5.8' });

// Captured from `reg query "HKLM\SOFTWARE\EpicGames\Unreal Engine" /s`
const REG_ENGINES = [
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\EpicGames\\Unreal Engine\\5.4',
    '    InstalledDirectory    REG_SZ    D:\\EpicGames\\Engine\\UE_5.4',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\EpicGames\\Unreal Engine\\5.7',
    '    InstalledDirectory    REG_SZ    C:\\Program Files\\Epic Games\\UE_5.7',
    '',
].join('\r\n');

const REG_BUILDS = [
    '',
    'HKEY_CURRENT_USER\\Software\\Epic Games\\Unreal Engine\\Builds',
    '    {8C6FC5A1-4A3B-4F0E-9D1A-0123456789AB}    REG_SZ    E:/Source/UnrealEngine',
    '',
].join('\r\n');

const LAUNCHER = JSON.stringify({
    InstallationList: [
        { InstallLocation: 'D:\\EpicGames\\Engine\\UE_5.8', AppName: 'UE_5.8' },
        { InstallLocation: 'D:\\EpicGames\\Engine\\UE_5.8', AppName: 'FabPlugin_5.8' },
    ],
});

/** A Windows machine with files at the given paths (compared case-insensitively, either slash). */
function fakeEnv(files: Record<string, string>, registry: Record<string, string> = {}): LocateEnv {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    const byPath = new Map(Object.entries(files).map(([p, text]) => [norm(p), text]));
    return {
        platform: 'win32',
        home: 'C:\\Users\\me',
        programData: 'C:\\ProgramData',
        programFiles: 'C:\\Program Files',
        readFile: p => byPath.get(norm(p)),
        regQuery: key => registry[key],
    };
}

const versionAt = (root: string) => ({ [path.join(root, 'Engine', 'Build', 'Build.version')]: BUILD_VERSION });

describe('engine descriptor parsers', () => {
    it('reads Build.version', () => {
        expect(parseBuildVersion(BUILD_VERSION)).toEqual({ major: 5, minor: 8, patch: 3, changelist: 58210709, branch: '++UE5+Release-5.8' });
        expect(parseBuildVersion('{}')).toBeUndefined();
        expect(parseBuildVersion('not json')).toBeUndefined();
    });

    it('reads reg query output', () => {
        const keys = parseRegQuery(REG_ENGINES);
        expect([...keys.keys()].map(k => k.split('\\').pop())).toEqual(['5.4', '5.7']);
        expect(keys.get('HKEY_LOCAL_MACHINE\\SOFTWARE\\EpicGames\\Unreal Engine\\5.7')?.get('InstalledDirectory')).toBe('C:\\Program Files\\Epic Games\\UE_5.7');
        const builds = [...parseRegQuery(REG_BUILDS).values()][0];
        expect(builds.get('{8C6FC5A1-4A3B-4F0E-9D1A-0123456789AB}')).toBe('E:/Source/UnrealEngine');
    });

    it('reads LauncherInstalled.dat, keeping engines only', () => {
        expect(parseLauncherInstalled(LAUNCHER)).toEqual([{ version: '5.8', location: 'D:\\EpicGames\\Engine\\UE_5.8' }]);
        expect(parseLauncherInstalled('garbage')).toEqual([]);
    });

    it('reads the [Installations] section of Install.ini', () => {
        const ini = '[Other]\nX=1\n\n[Installations]\n{ABC}=/home/me/UnrealEngine\nMyBuild = /opt/ue\n';
        expect([...parseInstallIni(ini)]).toEqual([['{ABC}', '/home/me/UnrealEngine'], ['MyBuild', '/opt/ue']]);
    });

    it('classifies associations', () => {
        expect(normalizeAssociation('5.8')).toEqual({ kind: 'version', value: '5.8' });
        expect(normalizeAssociation(' {8C6FC5A1-4A3B} ')).toEqual({ kind: 'id', value: '{8C6FC5A1-4A3B}' });
        expect(normalizeAssociation('')).toEqual({ kind: 'empty', value: '' });
    });
});

describe('locateEngine', () => {
    it('finds launcher installs the registry does not list, and skips stale registry entries', () => {
        const env = fakeEnv(
            { 'C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat': LAUNCHER, ...versionAt('D:\\EpicGames\\Engine\\UE_5.8') },
            { 'HKLM\\SOFTWARE\\EpicGames\\Unreal Engine': REG_ENGINES },
        );
        expect(locateEngine('5.8', 'D:\\Projects\\Game', { env })).toMatchObject({ root: 'D:\\EpicGames\\Engine\\UE_5.8', source: 'launcher', version: { minor: 8 } });

        // 5.7 is registered but its folder has no Build.version (uninstalled)
        const missing = locateEngine('5.7', 'D:\\Projects\\Game', { env });
        expect(missing).toMatchObject({ error: expect.stringContaining('EngineAssociation "5.7"') });
        expect((missing as any).error).toContain('UE_5.7 (registry): no Engine/Build/Build.version');
        expect((missing as any).candidates.find((c: any) => c.id === '5.8')).toMatchObject({ version: { minor: 8 } });
    });

    it('prefers the registry, then the default install folder', () => {
        const env = fakeEnv(
            { ...versionAt('D:\\EpicGames\\Engine\\UE_5.4'), ...versionAt('C:\\Program Files\\Epic Games\\UE_5.6') },
            { 'HKLM\\SOFTWARE\\EpicGames\\Unreal Engine': REG_ENGINES },
        );
        expect(locateEngine('5.4', 'D:\\P', { env })).toMatchObject({ root: 'D:\\EpicGames\\Engine\\UE_5.4', source: 'registry' });
        expect(locateEngine('5.6', 'D:\\P', { env })).toMatchObject({ root: 'C:\\Program Files\\Epic Games\\UE_5.6', source: 'defaultDir' });
    });

    it('finds source builds by GUID, with or without braces', () => {
        const env = fakeEnv(versionAt('E:/Source/UnrealEngine'), { 'HKCU\\Software\\Epic Games\\Unreal Engine\\Builds': REG_BUILDS });
        expect(locateEngine('8C6FC5A1-4A3B-4F0E-9D1A-0123456789ab', 'D:\\P', { env })).toMatchObject({ root: 'E:/Source/UnrealEngine', source: 'sourceBuild' });
    });

    it('finds the engine a project sits inside', () => {
        const env = fakeEnv(versionAt('E:\\UE'));
        expect(locateEngine('', 'E:\\UE\\Games\\MyGame', { env })).toMatchObject({ root: 'E:\\UE', source: 'parentDir' });
    });

    it('uses the configured path, accepting its Engine subfolder, and reports a bad one', () => {
        expect(locateEngine('5.8', 'D:\\P', { override: FAKE_ENGINE })).toMatchObject({ source: 'setting', version: { major: 9, minor: 9 } });
        expect(locateEngine('5.8', 'D:\\P', { override: path.join(FAKE_ENGINE, 'Engine') })).toMatchObject({ version: { major: 9 } });
        const bad = locateEngine('5.8', 'D:\\P', { override: __dirname });
        expect(bad).toMatchObject({ error: expect.stringContaining('is not an Unreal Engine install') });
    });

    it('lists candidates once each, with problems for broken ones', () => {
        const env = fakeEnv(
            { 'C:\\ProgramData\\Epic\\UnrealEngineLauncher\\LauncherInstalled.dat': LAUNCHER, ...versionAt('D:\\EpicGames\\Engine\\UE_5.8') },
            { 'HKLM\\SOFTWARE\\EpicGames\\Unreal Engine': REG_ENGINES },
        );
        const candidates = listEngineCandidates(env);
        expect(candidates.map(c => [c.id, !!c.version])).toEqual([['5.4', false], ['5.7', false], ['5.8', true]]);
    });
});
