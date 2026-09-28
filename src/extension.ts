import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { version } from '../package.json';
import { MCP_SERVER_LABEL, mergeAgentsFile, renderAgentFile, renderAgentsSection } from './agentInstructions';
import { INDEX_DIR, writeIndex } from './emit';
import { EngineProvider } from './engineContext';
import { EngineInstall, listEngineCandidates, locateEngine, versionLabel } from './engine/locate';
import { defaultCacheDir, engineCachePaths } from './engine/paths';
import { ProjectIndex } from './indexer';
import { MEMORY_DIR, MemoryStore } from './memory';
import { registerUnrealParticipant } from './participant';
import { findRipgrep } from './search';
import { indexSections } from './server';
import { DEFAULT_READ_LINES, DEFAULT_RESULT_TOKENS, limitsFor } from './tools';

const WATCH_GLOB = '{Source,Plugins}/**/*.{h,hpp,hh,inl,cpp,cc,cxx,c,cs,uplugin}';
const IGNORED_PATH = /[\\/](Intermediate|Binaries|Saved|DerivedDataCache|\.llm-index)[\\/]/i;
const REBUILD_DELAY_MS = 1000;
/** Where VS Code looks for custom agents in a workspace folder. */
export const AGENT_FILE = path.join('.github', 'agents', 'unreal.agent.md');

interface IndexedProject {
    name: string;
    root: string;
    /** MCP server label; the first project's is the plain label the bundled agent refers to. */
    label: string;
    index: ProjectIndex;
    engine: EngineProvider;
    install?: EngineInstall;
    engineError?: string;
    /** Notes in <project>/.llm-memory, unless memory is turned off. */
    memory?: MemoryStore;
    disposables: vscode.Disposable[];
}

interface RunningSync {
    promise: Promise<void>;
    percent?: number;
}

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Unreal LLM Index');
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    status.command = 'unrealLlmIndex.openIndex';
    const serversChanged = new vscode.EventEmitter<void>();
    const cliPath = context.asAbsolutePath(path.join('dist', 'cli.js'));
    const rgPath = findRipgrep(vscode.env.appRoot);
    const config = () => vscode.workspace.getConfiguration('unrealLlmIndex');
    const cacheDir = () => config().get<string>('cacheDir', '') || defaultCacheDir();
    const syncs = new Map<string, RunningSync>();
    let projects: IndexedProject[] = [];

    context.subscriptions.push(output, status, serversChanged, { dispose: () => projects.forEach(disposeProject) });

    const log = (message: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);

    function updateStatus() {
        if (!projects.length) {
            status.hide();
            return;
        }
        const running = [...syncs.values()].find(s => s.percent !== undefined);
        const lines = projects.map(p => {
            const engine = p.install
                ? `UE ${versionLabel(p.install.version)}${syncs.has(p.install.root.toLowerCase()) ? ' (indexing)' : 'handle' in p.engine.state() ? ' indexed' : ' not indexed yet'}`
                : p.engineError ?? 'engine lookups off';
            return `${p.name}: ${p.index.allSymbols().length} symbols in ${p.index.indexedFiles().length} files; ${engine}`;
        });
        status.text = running ? `$(book) LLM Index $(sync~spin) ${running.percent}%` : '$(book) LLM Index';
        status.tooltip = `${lines.join('\n')}\nClick to open INDEX.md`;
        status.show();
    }

    const canWriteFiles = () => vscode.workspace.isTrusted !== false && config().get<boolean>('writeIndexFiles', true);

    function writeFiles(project: IndexedProject) {
        writeIndex(project.index, indexSections({ project: project.index, engine: project.engine, memory: project.memory }));
    }

    const memoryFor = (project: IndexedProject) =>
        config().get<boolean>('memory.enabled', true) ? new MemoryStore(path.join(project.root, MEMORY_DIR)) : undefined;

    function build(project: IndexedProject, reason: string, force = false) {
        try {
            const started = Date.now();
            const changed = project.index.refresh(true);
            const indexFile = path.join(project.root, INDEX_DIR, 'INDEX.md');
            if (canWriteFiles() && (changed || force || !fs.existsSync(indexFile))) {
                writeFiles(project);
            }
            log(`${project.name}: ${reason} — ${project.index.indexedFiles().length} files, ${project.index.allSymbols().length} symbols (${Date.now() - started} ms)`);
        } catch (e: any) {
            log(`${project.name}: ${reason} failed — ${e.message}`);
        }
        updateStatus();
    }

    function disposeProject(project: IndexedProject) {
        project.disposables.forEach(d => d.dispose());
        project.engine.dispose();
    }

    /** Finds the project's engine (or the configured one) and prepares its index. */
    function setupEngine(project: IndexedProject) {
        project.engine?.dispose();
        project.install = undefined;
        project.engineError = undefined;
        if (!config().get<boolean>('engine.enabled', true)) {
            project.engine = new EngineProvider({ project: project.index, cacheDir: cacheDir(), install: null });
            return;
        }
        const found = locateEngine(project.index.project.engineAssociation, project.index.project.root, { override: config().get<string>('enginePath', '') || undefined });
        project.engine = new EngineProvider({ project: project.index, cacheDir: cacheDir(), install: found });
        if ('error' in found) {
            project.engineError = found.error;
            log(`${project.name}: ${found.error}`);
        } else {
            project.install = found;
            log(`${project.name}: Unreal Engine ${versionLabel(found.version)} at ${found.root} (${found.source})`);
        }
    }

    /**
     * Builds or updates an engine's index in a separate process (on VS Code's own Node), so the
     * editor stays responsive. One sync per engine at a time; other windows wait on the lock.
     */
    function syncEngine(install: EngineInstall, options: { full?: boolean; ifStale?: boolean; notify?: boolean } = {}): Promise<void> {
        const key = install.root.toLowerCase();
        const running = syncs.get(key);
        if (running) {
            return running.promise;
        }
        const first = !fs.existsSync(engineCachePaths(cacheDir(), install).db);
        const entry: RunningSync = { promise: Promise.resolve() };
        syncs.set(key, entry);
        const location = first || options.notify ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window;
        const title = `Indexing Unreal Engine ${versionLabel(install.version)}`;
        entry.promise = Promise.resolve(
            vscode.window.withProgress({ location, title, cancellable: true }, (progress, token) =>
                new Promise<void>(resolve => {
                    const args = [cliPath, 'engine', 'sync', '--engine', install.root, '--cache-dir', cacheDir(), '--json'];
                    if (options.full) {
                        args.push('--full');
                    }
                    if (options.ifStale) {
                        args.push('--if-stale');
                    }
                    const child = spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
                    let buffered = '';
                    let reported = 0;
                    let busy = false;
                    child.stdout.setEncoding('utf8');
                    child.stdout.on('data', (chunk: string) => {
                        buffered += chunk;
                        const lines = buffered.split('\n');
                        buffered = lines.pop() ?? '';
                        for (const line of lines) {
                            let event: any;
                            try {
                                event = JSON.parse(line);
                            } catch {
                                continue;
                            }
                            if (event.type === 'progress' && event.phase === 'parse' && event.total) {
                                const percent = Math.floor((100 * event.done) / event.total);
                                progress.report({ message: `${event.done.toLocaleString()} of ${event.total.toLocaleString()} files`, increment: percent - reported });
                                reported = percent;
                                entry.percent = percent;
                                updateStatus();
                            } else if (event.type === 'progress') {
                                progress.report({ message: event.phase === 'scan' ? 'finding modules and plugins' : 'finishing' });
                            } else if (event.type === 'done') {
                                log(event.skipped
                                    ? `Engine index for ${install.root} is up to date`
                                    : `Indexed ${install.root}: ${event.files} files, ${event.symbols} symbols (${event.parsed} parsed, ${event.removed} removed) in ${(event.ms / 1000).toFixed(1)} s`);
                            } else if (event.type === 'error') {
                                busy = !!event.busy;
                                log(`Engine indexing: ${event.message}`);
                                if (!busy) {
                                    void vscode.window.showWarningMessage(`Unreal LLM Index: indexing the engine failed: ${event.message}`);
                                }
                            }
                        }
                    });
                    child.stderr.setEncoding('utf8');
                    child.stderr.on('data', (chunk: string) => {
                        const text = chunk.trim();
                        if (text && !/ExperimentalWarning|--trace-warnings/.test(text)) {
                            log(text);
                        }
                    });
                    token.onCancellationRequested(() => child.kill());
                    const finish = () => {
                        syncs.delete(key);
                        for (const project of projects.filter(p => p.install?.root.toLowerCase() === key)) {
                            build(project, 'engine index updated', true);
                        }
                        if (busy) {
                            // Another window is building it; check again later
                            const timer = setTimeout(() => void syncEngine(install, { ifStale: true }), 60_000);
                            context.subscriptions.push({ dispose: () => clearTimeout(timer) });
                        }
                        updateStatus();
                        resolve();
                    };
                    child.on('error', e => {
                        log(`Could not start engine indexing: ${e.message}`);
                        finish();
                    });
                    child.on('close', finish);
                }),
            ),
        );
        updateStatus();
        return entry.promise;
    }

    /** Each engine once, with a project that uses it. */
    const engines = () => [...new Map(projects.filter(p => p.install).map(p => [p.install!.root.toLowerCase(), p.install!])).values()];

    function autoSync() {
        if (config().get<string>('engine.autoSync', 'onStartup') === 'onStartup') {
            engines().forEach(install => void syncEngine(install, { ifStale: true }));
        }
    }

    function watch(project: IndexedProject) {
        let timer: NodeJS.Timeout | undefined;
        const schedule = (uri: vscode.Uri) => {
            if (IGNORED_PATH.test(uri.fsPath)) {
                return;
            }
            clearTimeout(timer);
            timer = setTimeout(() => build(project, 'files changed'), REBUILD_DELAY_MS);
        };
        for (const pattern of [WATCH_GLOB, '*.uproject']) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.root, pattern));
            watcher.onDidChange(schedule);
            watcher.onDidCreate(schedule);
            watcher.onDidDelete(schedule);
            project.disposables.push(watcher);
        }

        // Notes change INDEX.md's memory section, whether a model or a person wrote them
        let memoryTimer: NodeJS.Timeout | undefined;
        const memoryChanged = () => {
            clearTimeout(memoryTimer);
            memoryTimer = setTimeout(() => {
                if (project.memory && canWriteFiles()) {
                    try {
                        writeFiles(project);
                    } catch (e: any) {
                        log(`${project.name}: could not update INDEX.md — ${e.message}`);
                    }
                }
            }, REBUILD_DELAY_MS);
        };
        const notes = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(project.root, `${MEMORY_DIR}/*.md`));
        notes.onDidChange(memoryChanged);
        notes.onDidCreate(memoryChanged);
        notes.onDidDelete(memoryChanged);
        project.disposables.push(notes, { dispose: () => clearTimeout(timer) }, { dispose: () => clearTimeout(memoryTimer) });
    }

    function workspaceFolderOf(project: IndexedProject): string {
        return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.root))?.uri.fsPath ?? project.root;
    }

    function updateContextKeys() {
        void vscode.commands.executeCommand('setContext', 'unrealLlmIndex.hasProject', projects.length > 0);
        const folders = [...new Set(projects.map(workspaceFolderOf))];
        void vscode.commands.executeCommand('setContext', 'unrealLlmIndex.hasWorkspaceAgent', folders.some(f => fs.existsSync(path.join(f, AGENT_FILE))));
    }

    async function discover() {
        projects.forEach(disposeProject);
        // Engine source trees contain template and sample projects that aren't the user's
        const found = await vscode.workspace.findFiles('**/*.uproject', '**/{Intermediate,Binaries,Saved,Plugins,node_modules,Templates,Samples,Engine}/**', 20);
        const roots = [...new Set(found.map(uri => path.dirname(uri.fsPath)))].sort();
        projects = roots.map((root, i) => {
            const project: IndexedProject = {
                name: path.basename(root),
                root,
                label: i === 0 ? MCP_SERVER_LABEL : `${MCP_SERVER_LABEL} ${path.basename(root)}`,
                index: new ProjectIndex(root),
                engine: undefined as unknown as EngineProvider,
                disposables: [],
            };
            return project;
        });
        for (const project of projects) {
            project.index.refresh(true);
            setupEngine(project);
            project.memory = memoryFor(project);
            // Always write: files from an older version, or before the engine was indexed, may be out of date
            build(project, 'initial build', true);
            watch(project);
        }
        updateContextKeys();
        serversChanged.fire();
        updateStatus();
        autoSync();
    }

    async function pickProject(placeHolder: string): Promise<IndexedProject | undefined> {
        if (projects.length <= 1) {
            if (!projects.length) {
                vscode.window.showWarningMessage('Unreal LLM Index: no .uproject found in this workspace.');
            }
            return projects[0];
        }
        const choice = await vscode.window.showQuickPick(
            projects.map(p => ({ label: p.name, description: p.root, project: p })),
            { placeHolder },
        );
        return choice?.project;
    }

    function projectFor(uri?: vscode.Uri): IndexedProject | undefined {
        const file = uri?.fsPath.toLowerCase();
        return (file && projects.find(p => file.startsWith(p.root.toLowerCase() + path.sep))) || projects[0];
    }

    function resetEngines() {
        for (const project of projects) {
            setupEngine(project);
            build(project, 'engine settings changed', true);
        }
        serversChanged.fire();
        updateStatus();
        autoSync();
    }

    // Expose the index to VS Code chat agents: any model the user picks can call the tools.
    if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function') {
        context.subscriptions.push(
            vscode.lm.registerMcpServerDefinitionProvider('unrealLlmIndex', {
                onDidChangeMcpServerDefinitions: serversChanged.event,
                provideMcpServerDefinitions: () => {
                    if (!config().get<boolean>('registerMcpServer', true)) {
                        return [];
                    }
                    const tokens = config().get<number>('maxResultTokens', DEFAULT_RESULT_TOKENS) || DEFAULT_RESULT_TOKENS;
                    const lines = config().get<number>('maxReadLines', DEFAULT_READ_LINES);
                    return projects.map(p => {
                        const engineArgs = p.install ? ['--engine', p.install.root] : config().get<boolean>('engine.enabled', true) ? [] : ['--no-engine'];
                        const memoryArgs = p.memory ? ['--memory-dir', p.memory.dir] : ['--no-memory'];
                        const args = [cliPath, 'serve', p.root, '--no-write', '--cache-dir', cacheDir(), ...engineArgs, ...memoryArgs];
                        if (rgPath) {
                            args.push('--rg', rgPath);
                        }
                        args.push('--max-result-tokens', String(tokens), '--max-read-lines', String(lines));
                        const engineKey = p.install ? `${versionLabel(p.install.version)}-${p.install.version.changelist}` : 'none';
                        return new vscode.McpStdioServerDefinition(p.label, process.execPath, args, { ELECTRON_RUN_AS_NODE: '1' }, `${version}+${engineKey}`);
                    });
                },
            }),
        );
    } else {
        log('This VS Code version has no MCP server API; only the .llm-index/ files are provided.');
    }

    if (typeof vscode.chat?.createChatParticipant === 'function') {
        context.subscriptions.push(
            registerUnrealParticipant({
                toolContext: request => {
                    const project = projectFor(vscode.window.activeTextEditor?.document.uri);
                    if (!project) {
                        return undefined;
                    }
                    project.index.refresh();
                    const configured = config().get<number>('maxResultTokens', DEFAULT_RESULT_TOKENS);
                    // 0 means "size results to the model"
                    const tokens = configured > 0 ? configured : Math.min(16_000, Math.max(2_000, Math.round(request.model.maxInputTokens * 0.06)));
                    return {
                        project: project.index,
                        engine: project.engine,
                        memory: project.memory,
                        limits: limitsFor(tokens, config().get<number>('maxReadLines', DEFAULT_READ_LINES)),
                        rgPath,
                    };
                },
                maxToolRounds: () => config().get<number>('chat.maxToolRounds', 15),
            }),
        );
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('unrealLlmIndex.rebuild', () => {
            projects.forEach(p => build(p, 'manual rebuild', true));
            if (projects.length) {
                vscode.window.showInformationMessage(`Unreal LLM Index rebuilt for ${projects.map(p => p.name).join(', ')}.`);
            }
        }),

        vscode.commands.registerCommand('unrealLlmIndex.openIndex', async () => {
            const project = await pickProject('Open the index of which project?');
            if (!project) {
                return;
            }
            const indexFile = path.join(project.root, INDEX_DIR, 'INDEX.md');
            if (!fs.existsSync(indexFile)) {
                writeFiles(project);
            }
            await vscode.window.showTextDocument(vscode.Uri.file(indexFile));
        }),

        vscode.commands.registerCommand('unrealLlmIndex.addAgentsInstructions', async () => {
            const project = await pickProject('Add AGENTS.md instructions to which project?');
            if (!project) {
                return;
            }
            const agentsFile = path.join(project.root, 'AGENTS.md');
            const existing = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, 'utf8') : undefined;
            const updated = mergeAgentsFile(existing, renderAgentsSection(project.index));
            if (updated === existing) {
                vscode.window.showInformationMessage('AGENTS.md already has the current Unreal LLM Index instructions.');
                return;
            }
            fs.writeFileSync(agentsFile, updated, 'utf8');
            log(`${project.name}: ${existing === undefined ? 'created' : 'updated'} AGENTS.md`);
            const open = await vscode.window.showInformationMessage(
                `${existing === undefined ? 'Created' : 'Updated'} AGENTS.md in ${project.name}. Agents that read AGENTS.md will now use the index.`,
                'Open AGENTS.md',
            );
            if (open) {
                await vscode.window.showTextDocument(vscode.Uri.file(agentsFile));
            }
        }),

        vscode.commands.registerCommand('unrealLlmIndex.syncEngineIndex', async () => {
            const list = engines();
            if (!list.length) {
                vscode.window.showWarningMessage(`Unreal LLM Index: no engine to index. ${projects.map(p => p.engineError).filter(Boolean)[0] ?? ''}`);
                return;
            }
            await Promise.all(list.map(install => syncEngine(install, { notify: true })));
        }),

        vscode.commands.registerCommand('unrealLlmIndex.rebuildEngineIndex', async () => {
            await Promise.all(engines().map(install => syncEngine(install, { full: true, notify: true })));
        }),

        vscode.commands.registerCommand('unrealLlmIndex.selectEngine', async () => {
            type Item = vscode.QuickPickItem & { root?: string; action?: 'browse' | 'reset' };
            const items: Item[] = listEngineCandidates()
                .filter(c => c.version)
                .map(c => ({ label: `Unreal Engine ${versionLabel(c.version!)}`, description: c.root, detail: `found in ${c.source}`, root: c.root }));
            items.push({ label: 'Browse…', description: 'Choose an engine folder', action: 'browse' });
            items.push({ label: 'Use each project\'s EngineAssociation', description: 'Clear unrealLlmIndex.enginePath', action: 'reset' });
            const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Which Unreal Engine should be indexed?' });
            if (!choice) {
                return;
            }
            let root = choice.root;
            if (choice.action === 'browse') {
                const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use this engine' });
                root = picked?.[0]?.fsPath;
                if (!root) {
                    return;
                }
            }
            await config().update('enginePath', choice.action === 'reset' ? undefined : root, vscode.ConfigurationTarget.Workspace);
        }),

        vscode.commands.registerCommand('unrealLlmIndex.clearEngineCache', async () => {
            const dir = path.join(cacheDir(), 'engines');
            const confirm = await vscode.window.showWarningMessage(`Delete the engine indexes in ${dir}? They are rebuilt when needed.`, { modal: true }, 'Delete');
            if (confirm !== 'Delete') {
                return;
            }
            projects.forEach(p => p.engine.dispose());
            try {
                fs.rmSync(dir, { recursive: true, force: true });
                vscode.window.showInformationMessage('Unreal LLM Index: engine indexes deleted.');
            } catch (e: any) {
                vscode.window.showWarningMessage(`Unreal LLM Index: some files are in use (close other VS Code windows on this engine): ${e.message}`);
            }
            resetEngines();
        }),

        vscode.commands.registerCommand('unrealLlmIndex.copyUnrealAgent', async () => {
            const project = await pickProject('Add the Unreal agent to which workspace folder?');
            if (!project) {
                return;
            }
            const file = path.join(workspaceFolderOf(project), AGENT_FILE);
            if (fs.existsSync(file)) {
                const overwrite = await vscode.window.showWarningMessage(`${AGENT_FILE} already exists. Replace it?`, { modal: true }, 'Replace');
                if (overwrite !== 'Replace') {
                    return;
                }
            }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, renderAgentFile(projects.map(p => p.label)), 'utf8');
            log(`Wrote ${file}`);
            updateContextKeys();
            await vscode.window.showTextDocument(vscode.Uri.file(file));
        }),

        vscode.workspace.onDidChangeWorkspaceFolders(() => discover()),

        vscode.workspace.onDidChangeConfiguration(e => {
            if (['enginePath', 'engine.enabled', 'cacheDir'].some(key => e.affectsConfiguration(`unrealLlmIndex.${key}`))) {
                resetEngines();
                return;
            }
            if (e.affectsConfiguration('unrealLlmIndex.memory.enabled')) {
                for (const project of projects) {
                    project.memory = memoryFor(project);
                    if (canWriteFiles()) {
                        writeFiles(project);
                    }
                }
            }
            if (['registerMcpServer', 'maxResultTokens', 'maxReadLines', 'memory.enabled'].some(key => e.affectsConfiguration(`unrealLlmIndex.${key}`))) {
                serversChanged.fire();
            }
            if (e.affectsConfiguration('unrealLlmIndex.writeIndexFiles') && canWriteFiles()) {
                projects.forEach(writeFiles);
            }
        }),
    );

    void discover();
}

export function deactivate() {}
