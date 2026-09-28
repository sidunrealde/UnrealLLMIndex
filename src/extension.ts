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
import { compareReports, EVAL_DIR, EvalReport, generateQuestions, loadQuestions, QUESTIONS_FILE, renderQuestionsFile, writeReport } from './eval';
import { runEvalInChat } from './evalChat';
import { DEFAULT_READ_LINES, DEFAULT_RESULT_TOKENS, limitsFor, ToolContext } from './tools';

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
    status.command = 'unrealLlmIndex.showMenu';
    const serversChanged = new vscode.EventEmitter<void>();
    const cliPath = context.asAbsolutePath(path.join('dist', 'cli.js'));
    const rgPath = findRipgrep(vscode.env.appRoot);
    const config = () => vscode.workspace.getConfiguration('unrealLlmIndex');
    const cacheDir = () => config().get<string>('cacheDir', '') || defaultCacheDir();
    const syncs = new Map<string, RunningSync>();
    let projects: IndexedProject[] = [];

    context.subscriptions.push(output, status, serversChanged, { dispose: () => projects.forEach(disposeProject) });

    const log = (message: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);

    type EngineStatus = { kind: 'off' | 'missing' | 'building' | 'notIndexed' | 'indexed'; text: string };

    /** Where a project's engine index stands, in words for the status bar and the menu. */
    function engineStatus(p: IndexedProject): EngineStatus {
        if (!p.install) {
            return p.engineError ? { kind: 'missing', text: 'no engine found' } : { kind: 'off', text: 'engine lookups off' };
        }
        const label = `UE ${versionLabel(p.install.version)}`;
        const sync = syncs.get(p.install.root.toLowerCase());
        if (sync) {
            return { kind: 'building', text: `${label} indexing${sync.percent !== undefined ? ` ${sync.percent}%` : '…'}` };
        }
        const state = p.engine.state();
        if (!('handle' in state)) {
            return { kind: 'notIndexed', text: `${label} not indexed yet` };
        }
        const meta = state.handle.index.meta();
        const hours = (Date.now() - Number(meta.last_sync)) / 3600_000;
        const age = hours < 1 ? 'less than an hour ago' : hours < 48 ? `${Math.round(hours)} h ago` : `${Math.round(hours / 24)} days ago`;
        return { kind: 'indexed', text: `${label} indexed (${Number(meta.files).toLocaleString('en-US')} files), updated ${age}` };
    }

    function updateStatus() {
        if (!projects.length) {
            status.hide();
            return;
        }
        const running = [...syncs.values()].find(s => s.percent !== undefined);
        const engines = projects.map(engineStatus);
        const lines = projects.map((p, i) => `${p.name}: ${p.index.allSymbols().length} symbols in ${p.index.indexedFiles().length} files; ${engines[i].text}`);
        const notIndexed = engines.some(e => e.kind === 'notIndexed');
        if (running) {
            status.text = `$(sync~spin) LLM Index ${running.percent}%`;
        } else if (notIndexed) {
            status.text = '$(warning) LLM Index: engine not indexed';
        } else {
            status.text = '$(book) LLM Index';
        }
        status.backgroundColor = notIndexed && !running ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        status.tooltip = `${lines.join('\n')}\nClick for actions: update the index, rebuild the engine database, open INDEX.md`;
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
                                if (options.notify) {
                                    const label = `Unreal Engine ${versionLabel(install.version)}`;
                                    const changes = event.parsed || event.removed ? `${event.parsed} files parsed, ${event.removed} removed` : 'nothing had changed';
                                    void vscode.window.showInformationMessage(
                                        `Unreal LLM Index: ${label} index ${first ? 'built' : 'updated'}: ${Number(event.files).toLocaleString('en-US')} files, ${Number(event.symbols).toLocaleString('en-US')} symbols; ${changes} (${(event.ms / 1000).toFixed(1)} s).`,
                                    );
                                }
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

    const offeredIndexing = new Set<string>();

    function autoSync() {
        if (config().get<string>('engine.autoSync', 'onStartup') === 'onStartup') {
            engines().forEach(install => void syncEngine(install, { ifStale: true }));
            return;
        }
        // Manual mode: offer to build an engine database that doesn't exist yet, once per session
        for (const project of projects) {
            const install = project.install;
            if (!install || engineStatus(project).kind !== 'notIndexed' || offeredIndexing.has(install.root.toLowerCase())) {
                continue;
            }
            offeredIndexing.add(install.root.toLowerCase());
            void vscode.window
                .showInformationMessage(
                    `Unreal LLM Index: Unreal Engine ${versionLabel(install.version)}, used by ${project.name}, isn't indexed yet, so engine lookups are off.`,
                    'Index now',
                )
                .then(choice => {
                    if (choice) {
                        void syncEngine(install, { notify: true });
                    }
                });
        }
    }

    /** The project map and every engine database: re-parse what changed, and build a database that doesn't exist. */
    async function updateIndex() {
        projects.forEach(p => build(p, 'manual update', true));
        const list = engines();
        if (!list.length) {
            const reason = projects.map(p => p.engineError).find(Boolean);
            void vscode.window.showInformationMessage(`Unreal LLM Index: project index updated.${reason ? ` No engine to index: ${reason}` : ''}`);
            return;
        }
        await Promise.all(list.map(install => syncEngine(install, { notify: true })));
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

    /** Tools for @unreal and evaluation runs, sized for the request's model. */
    function chatToolContext(project: IndexedProject | undefined, model: vscode.LanguageModelChat): ToolContext | undefined {
        if (!project) {
            return undefined;
        }
        project.index.refresh();
        const configured = config().get<number>('maxResultTokens', DEFAULT_RESULT_TOKENS);
        // 0 means "size results to the model"
        const tokens = configured > 0 ? configured : Math.min(16_000, Math.max(2_000, Math.round(model.maxInputTokens * 0.06)));
        return {
            project: project.index,
            engine: project.engine,
            memory: project.memory,
            limits: limitsFor(tokens, config().get<number>('maxReadLines', DEFAULT_READ_LINES)),
            rgPath,
        };
    }

    if (typeof vscode.chat?.createChatParticipant === 'function') {
        context.subscriptions.push(
            registerUnrealParticipant({
                toolContext: request => chatToolContext(projectFor(vscode.window.activeTextEditor?.document.uri), request.model),
                maxToolRounds: () => config().get<number>('chat.maxToolRounds', 15),
            }),
        );
    }

    async function createQuestions(project: IndexedProject, file: string) {
        const ctx = chatToolContext(project, { maxInputTokens: 128_000 } as vscode.LanguageModelChat)!;
        const questions = await generateQuestions(ctx);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, renderQuestionsFile(questions), 'utf8');
        log(`${project.name}: wrote ${questions.length} starter questions to ${file}`);
        await vscode.window.showTextDocument(vscode.Uri.file(file));
        void vscode.window.showInformationMessage(
            `Created ${EVAL_DIR}/${QUESTIONS_FILE} with ${questions.length} questions generated from this project. Replace them with questions from your own work, then run the evaluation.`,
        );
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('unrealLlmIndex.updateIndex', () => updateIndex()),

        vscode.commands.registerCommand('unrealLlmIndex.showMenu', async () => {
            if (!projects.length) {
                void vscode.window.showWarningMessage('Unreal LLM Index: no .uproject found in this workspace.');
                return;
            }
            const summary = projects.map(p => `${p.name}: ${engineStatus(p).text}`).join(' · ');
            const hasEngine = engines().length > 0;
            const items: (vscode.QuickPickItem & { command: string })[] = [
                {
                    label: '$(sync) Update index',
                    description: hasEngine ? 'Re-parse what changed, and build the engine database if it doesn\'t exist yet' : 'Re-parse the project',
                    command: 'unrealLlmIndex.updateIndex',
                },
                ...(hasEngine
                    ? [{ label: '$(database) Rebuild engine database', description: 'Parse the whole engine again, from scratch', command: 'unrealLlmIndex.rebuildEngineIndex' }]
                    : []),
                { label: '$(book) Open INDEX.md', description: 'The project map agents start from', command: 'unrealLlmIndex.openIndex' },
                { label: '$(settings-gear) Select engine…', description: 'Choose which engine install to index', command: 'unrealLlmIndex.selectEngine' },
                { label: '$(beaker) Run evaluation…', description: 'Ask a chat model your evaluation questions and get a report', command: 'unrealLlmIndex.runEvaluation' },
            ];
            const choice = await vscode.window.showQuickPick(items, { title: 'Unreal LLM Index', placeHolder: summary });
            if (choice) {
                await vscode.commands.executeCommand(choice.command);
            }
        }),

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

        vscode.commands.registerCommand('unrealLlmIndex.createEvaluation', async () => {
            const project = await pickProject('Create evaluation questions for which project?');
            if (!project) {
                return;
            }
            const file = path.join(project.root, EVAL_DIR, QUESTIONS_FILE);
            if (fs.existsSync(file)) {
                const replace = await vscode.window.showWarningMessage(`${EVAL_DIR}/${QUESTIONS_FILE} already exists. Replace it with generated questions?`, { modal: true }, 'Replace');
                if (replace !== 'Replace') {
                    return;
                }
            }
            await createQuestions(project, file);
        }),

        vscode.commands.registerCommand('unrealLlmIndex.runEvaluation', async () => {
            const project = await pickProject('Evaluate which project?');
            if (!project) {
                return;
            }
            const file = path.join(project.root, EVAL_DIR, QUESTIONS_FILE);
            if (!fs.existsSync(file)) {
                const create = await vscode.window.showInformationMessage(
                    `There are no evaluation questions yet. Create ${EVAL_DIR}/${QUESTIONS_FILE} with starter questions from this project?`,
                    'Create',
                );
                if (create) {
                    await createQuestions(project, file);
                }
                return;
            }
            let questions;
            try {
                questions = loadQuestions(file);
            } catch (e: any) {
                void vscode.window.showErrorMessage(`Unreal LLM Index: ${e.message}`);
                await vscode.window.showTextDocument(vscode.Uri.file(file));
                return;
            }
            const models = await vscode.lm.selectChatModels();
            if (!models.length) {
                void vscode.window.showWarningMessage('Unreal LLM Index: no chat models are available. Add or sign in to one in the chat view first.');
                return;
            }
            const choice = await vscode.window.showQuickPick(
                models.map(model => ({ label: model.name, description: `${model.vendor} · ${model.family}`, detail: `${model.maxInputTokens.toLocaleString()} input tokens`, model })),
                { placeHolder: `Which model should answer the ${questions.length} questions?` },
            );
            if (!choice) {
                return;
            }
            let grade = false;
            if (questions.some(q => q.reference)) {
                const answer = await vscode.window.showQuickPick(
                    [
                        { label: 'Checks and grading', description: 'The same model scores answers that have a reference, 1 to 5', grade: true },
                        { label: 'Checks only', grade: false },
                    ],
                    { placeHolder: 'Grade answers against their reference answers?' },
                );
                if (!answer) {
                    return;
                }
                grade = answer.grade;
            }
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `Evaluating ${choice.model.name}`, cancellable: true },
                async (progress, token) => {
                    let reported = 0;
                    const report = await runEvalInChat({
                        model: choice.model,
                        questions: questions!,
                        project: project.root,
                        toolContext: request => chatToolContext(project, request.model),
                        maxToolRounds: config().get<number>('chat.maxToolRounds', 15),
                        grade,
                        config: {
                            extension: version,
                            engine: !!project.install,
                            memory: !!project.memory,
                            maxResultTokens: config().get<number>('maxResultTokens', DEFAULT_RESULT_TOKENS),
                        },
                        token,
                        onProgress: (done, total, id) => {
                            const percent = Math.floor((100 * done) / total);
                            progress.report({ message: id ? `${done + 1} of ${total}: ${id}` : 'writing the report', increment: percent - reported });
                            reported = percent;
                        },
                    });
                    const markdown = writeReport(path.join(project.root, EVAL_DIR, 'results'), report);
                    log(`${project.name}: evaluation of ${report.model}: ${report.summary.passed} of ${report.summary.questions} passed → ${markdown}`);
                    await vscode.window.showTextDocument(vscode.Uri.file(markdown));
                    void vscode.window.showInformationMessage(`Evaluation: ${report.summary.passed} of ${report.summary.questions} questions passed with ${choice.model.name}.`);
                },
            );
        }),

        vscode.commands.registerCommand('unrealLlmIndex.compareEvaluations', async () => {
            const project = await pickProject('Compare evaluations of which project?');
            if (!project) {
                return;
            }
            const dir = path.join(project.root, EVAL_DIR, 'results');
            const reports = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse() : [];
            if (reports.length < 2) {
                void vscode.window.showInformationMessage('Unreal LLM Index: run the evaluation at least twice to compare results.');
                return;
            }
            const picked = await vscode.window.showQuickPick(reports, { canPickMany: true, placeHolder: 'Pick two runs to compare (older first is A)' });
            if (!picked || picked.length !== 2) {
                return;
            }
            const [a, b] = [...picked].sort().map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as EvalReport);
            const out = path.join(dir, `compare-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`);
            fs.writeFileSync(out, compareReports(a, b), 'utf8');
            await vscode.window.showTextDocument(vscode.Uri.file(out));
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
