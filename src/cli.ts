import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { version } from '../package.json';
import { writeIndex } from './emit';
import { EngineProvider } from './engineContext';
import { EngineInstall, listEngineCandidates, locateEngine, versionLabel } from './engine/locate';
import { canonicalRoot, defaultCacheDir, engineCachePaths } from './engine/paths';
import { EngineBusyError, readEngineVersionAt, readIndexMeta, syncEngineIndex } from './engine/sync';
import { compareReports, EVAL_DIR, EvalReport, generateQuestions, loadQuestions, QUESTIONS_FILE, renderQuestionsFile, writeReport } from './eval';
import { runEvalWithEndpoint } from './evalCli';
import { ProjectIndex } from './indexer';
import { MEMORY_DIR, MemoryStore } from './memory';
import { indexSections, startServer } from './server';
import { findRipgrep } from './search';
import { limitsFor, runTool, TOOL_NAMES } from './tools';

const USAGE = `unreal-llm-index ${version}
Builds a compact, Unreal-aware index of a UE C++ project, its engine and plugins for LLM agents, and serves it over MCP.

Usage:
  ue-llm-index build [projectDir] [--out <dir>]       Write .llm-index/ (INDEX.md, modules/, files/, symbols.json)
  ue-llm-index serve [projectDir] [--no-write]        Start the MCP server on stdio (keeps .llm-index/ up to date)
  ue-llm-index engine locate [projectDir]             Show which engine install the project uses
  ue-llm-index engine list                            List the engine installs registered on this machine
  ue-llm-index engine sync [projectDir] [--full] [--if-stale] [--jobs N] [--json]
                                                      Build or update the engine index (engine, engine and Marketplace plugins)
  ue-llm-index engine info [projectDir]               Show the engine index's location and size
  ue-llm-index tool <name> [json] [--project <dir>]   Run one tool and print its result (${TOOL_NAMES.join(', ')})
  ue-llm-index eval init [projectDir] [--force]       Write a starter question set to ${EVAL_DIR}/${QUESTIONS_FILE}
  ue-llm-index eval run [questions.json] --base-url <url>/v1 --model <name> [--api-key <key>] [--grade] [--label <text>]
                                                      Answer each question with the model and the tools; write a report
  ue-llm-index eval compare <a.json> <b.json>         Compare two evaluation reports

Options:
  --engine <dir>              Engine install to use (the folder containing Engine/), instead of the project's EngineAssociation
  --no-engine                 Index and serve the project only
  --cache-dir <dir>           Where engine indexes are kept (default ${defaultCacheDir()})
  --memory-dir <dir>          Project memory folder (default <project>/${MEMORY_DIR})
  --no-memory                 Turn project memory off
  --rg <path>                 ripgrep for engine searches (default: $UE_LLM_INDEX_RG or rg on PATH)
  --max-result-tokens <n>     Size cap for each tool result (default 8000)
  --max-read-lines <n>        Lines per read (default 400)
  --read-only-memory          serve: leave out the tools that change project memory

projectDir is a folder containing a .uproject (or the .uproject itself).
It defaults to $UE_LLM_INDEX_PROJECT, then the current directory.`;

const VALUE_FLAGS = new Set([
    'out', 'engine', 'cache-dir', 'memory-dir', 'rg', 'max-result-tokens', 'max-read-lines', 'jobs', 'project',
    'base-url', 'model', 'api-key', 'steps', 'label',
]);

function parseArgs(argv: string[]) {
    const positional: string[] = [];
    const flags = new Map<string, string | true>();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const name = arg.slice(2);
            flags.set(name, VALUE_FLAGS.has(name) ? argv[++i] ?? '' : true);
        } else if (arg === '-h') {
            flags.set('help', true);
        } else if (arg === '-v') {
            flags.set('version', true);
        } else {
            positional.push(arg);
        }
    }
    const value = (name: string) => (typeof flags.get(name) === 'string' ? (flags.get(name) as string) : undefined);
    return { positional, flags, value };
}

type Args = ReturnType<typeof parseArgs>;

const projectDirOf = (arg?: string) => arg ?? process.env.UE_LLM_INDEX_PROJECT ?? process.cwd();

/** The engine for a command: --engine, --no-engine (null), or the project's association (undefined = locate later). */
function engineArg(args: Args): EngineInstall | null | undefined {
    if (args.flags.has('no-engine')) {
        return null;
    }
    const root = args.value('engine');
    if (!root) {
        return undefined;
    }
    const canonical = canonicalRoot(root);
    const engineVersion = readEngineVersionAt(canonical);
    if (!engineVersion) {
        throw new Error(`--engine ${root} is not an Unreal Engine install (no Engine/Build/Build.version).`);
    }
    return { root: canonical, version: engineVersion, source: 'setting' };
}

/** The engine a command works on: --engine, or the one the project's EngineAssociation names. */
function requireEngine(args: Args, projectArg?: string): EngineInstall {
    const explicit = engineArg(args);
    if (explicit) {
        return explicit;
    }
    const index = new ProjectIndex(projectDirOf(projectArg));
    const found = locateEngine(index.project.engineAssociation, index.project.root);
    if ('error' in found) {
        throw new Error(found.error);
    }
    return found;
}

/** Project memory for a command: --memory-dir, <project>/.llm-memory, or none with --no-memory. */
function memoryFor(args: Args, index: ProjectIndex): MemoryStore | undefined {
    return args.flags.has('no-memory') ? undefined : new MemoryStore(args.value('memory-dir') ?? path.join(index.root, MEMORY_DIR));
}

function limits(args: Args) {
    const tokens = Number(args.value('max-result-tokens')) || undefined;
    const lines = Number(args.value('max-read-lines')) || undefined;
    return limitsFor(tokens, lines);
}

async function engineCommand(sub: string | undefined, projectArg: string | undefined, args: Args) {
    const cacheDir = args.value('cache-dir') ?? defaultCacheDir();
    switch (sub) {
        case 'locate': {
            const index = new ProjectIndex(projectDirOf(projectArg));
            console.log(JSON.stringify(locateEngine(index.project.engineAssociation, index.project.root), null, 2));
            return;
        }
        case 'list': {
            for (const c of listEngineCandidates()) {
                console.log(`${(c.id ?? '').padEnd(40)} ${c.version ? versionLabel(c.version).padEnd(8) : 'invalid '.padEnd(8)} ${c.root} (${c.source})${c.problem ? ` — ${c.problem}` : ''}`);
            }
            return;
        }
        case 'info': {
            const install = requireEngine(args, projectArg);
            const paths = engineCachePaths(cacheDir, install);
            const meta = readIndexMeta(paths.db);
            console.log(JSON.stringify({ engine: install, db: paths.db, indexed: !!meta, meta }, null, 2));
            return;
        }
        case 'sync': {
            const install = requireEngine(args, projectArg);
            const json = args.flags.has('json');
            const emit = (event: object) => console.log(JSON.stringify(event));
            try {
                // Stay out of the way of the editor and the compiler
                os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
            } catch {
                // Not permitted on some systems
            }
            let lastLog = 0;
            try {
                const result = await syncEngineIndex({
                    engineRoot: install.root,
                    cacheDir,
                    full: args.flags.has('full'),
                    ifStale: args.flags.has('if-stale'),
                    jobs: Number(args.value('jobs')) || undefined,
                    onProgress: p => {
                        // Throttled: writing to a pipe on every chunk slows the sync down several times
                        if (Date.now() - lastLog < (json ? 250 : 2000) && p.phase === 'parse' && p.done < p.total) {
                            return;
                        }
                        lastLog = Date.now();
                        if (json) {
                            emit({ type: 'progress', ...p });
                        } else {
                            console.log(p.phase === 'parse' ? `parsing ${p.done}/${p.total} files` : `${p.phase}…`);
                        }
                    },
                });
                if (json) {
                    emit({ type: 'done', ...result });
                } else {
                    console.log(
                        result.skipped
                            ? `Engine index is ${result.skipped}: ${result.dbPath}`
                            : `Indexed Unreal Engine ${versionLabel(install.version)}: ${result.files} files, ${result.symbols} symbols (${result.parsed} parsed, ${result.removed} removed) in ${(result.ms / 1000).toFixed(1)} s → ${result.dbPath}`,
                    );
                }
            } catch (e: any) {
                if (json) {
                    emit({ type: 'error', message: e.message, busy: e instanceof EngineBusyError });
                    process.exitCode = e instanceof EngineBusyError ? 3 : 1;
                    return;
                }
                throw e;
            }
            return;
        }
        default:
            throw new Error(`Unknown engine command "${sub ?? ''}". Use locate, list, sync or info.`);
    }
}

/** Server options passed through to `serve` when evaluating. */
const SERVER_VALUE_FLAGS = ['engine', 'cache-dir', 'memory-dir', 'rg', 'max-result-tokens', 'max-read-lines'];
const SERVER_BOOLEAN_FLAGS = ['no-engine', 'no-memory'];

async function evalCommand(sub: string | undefined, rest: string[], args: Args) {
    switch (sub) {
        case 'init': {
            const index = new ProjectIndex(projectDirOf(rest[0] ?? args.value('project')));
            index.refresh(true);
            const engine = new EngineProvider({ project: index, cacheDir: args.value('cache-dir') ?? defaultCacheDir(), install: engineArg(args) });
            try {
                const out = args.value('out') ? path.resolve(args.value('out')!) : path.join(index.root, EVAL_DIR, QUESTIONS_FILE);
                if (fs.existsSync(out) && !args.flags.has('force')) {
                    throw new Error(`${out} already exists. Pass --force to replace it, or --out to write another file.`);
                }
                const questions = await generateQuestions({ project: index, engine, memory: memoryFor(args, index), limits: limitsFor(), rgPath: args.value('rg') ?? findRipgrep() });
                fs.mkdirSync(path.dirname(out), { recursive: true });
                fs.writeFileSync(out, renderQuestionsFile(questions));
                console.log(`Wrote ${questions.length} generated questions and one example to edit: ${out}`);
            } finally {
                engine.dispose();
            }
            return;
        }
        case 'run': {
            const projectArg = args.value('project');
            const file = path.resolve(rest[0] ?? path.join(new ProjectIndex(projectDirOf(projectArg)).root, EVAL_DIR, QUESTIONS_FILE));
            const questions = loadQuestions(file);
            // By default the project is the folder that holds .llm-eval/
            const projectDir = projectArg ?? (path.basename(path.dirname(file)) === EVAL_DIR ? path.dirname(path.dirname(file)) : projectDirOf(undefined));
            const root = new ProjectIndex(projectDir).root;
            const baseUrl = args.value('base-url') ?? process.env.OPENAI_BASE_URL;
            const model = args.value('model') ?? process.env.OPENAI_MODEL;
            if (!baseUrl || !model) {
                throw new Error(
                    'Pass --base-url and --model, or set OPENAI_BASE_URL and OPENAI_MODEL. To use a model set up in VS Code chat instead, run "Unreal LLM Index: Run Evaluation" there.',
                );
            }
            const serverArgs = [process.argv[1], 'serve', root, '--no-write', '--read-only-memory'];
            for (const flag of SERVER_VALUE_FLAGS) {
                if (args.value(flag)) {
                    serverArgs.push(`--${flag}`, args.value(flag)!);
                }
            }
            SERVER_BOOLEAN_FLAGS.filter(flag => args.flags.has(flag)).forEach(flag => serverArgs.push(`--${flag}`));
            const client = new Client({ name: 'ue-llm-index-eval', version });
            await client.connect(new StdioClientTransport({ command: process.execPath, args: serverArgs, stderr: 'ignore' }));
            try {
                console.log(`Evaluating ${model} on ${questions.length} questions from ${file}\n`);
                const report = await runEvalWithEndpoint({
                    client,
                    baseUrl,
                    model,
                    apiKey: args.value('api-key') ?? process.env.OPENAI_API_KEY,
                    questions,
                    project: root,
                    grade: args.flags.has('grade'),
                    maxSteps: Number(args.value('steps')) || undefined,
                    config: {
                        extension: version,
                        ...(args.value('label') ? { label: args.value('label')! } : {}),
                        engine: !args.flags.has('no-engine'),
                        memory: !args.flags.has('no-memory'),
                        maxResultTokens: Number(args.value('max-result-tokens')) || 8000,
                    },
                    log: line => console.log(line),
                });
                const written = writeReport(args.value('out') ? path.resolve(args.value('out')!) : path.join(root, EVAL_DIR, 'results'), report);
                console.log(`\n${report.summary.passed} of ${report.summary.questions} passed. Report: ${written}`);
            } finally {
                await client.close();
            }
            return;
        }
        case 'compare': {
            const [a, b] = rest;
            if (!a || !b) {
                throw new Error('Pass two report files: ue-llm-index eval compare <a.json> <b.json>');
            }
            const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as EvalReport;
            const text = compareReports(read(a), read(b));
            if (args.value('out')) {
                fs.writeFileSync(args.value('out')!, text);
                console.log(`Wrote ${args.value('out')}`);
            } else {
                console.log(text);
            }
            return;
        }
        default:
            throw new Error(`Unknown eval command "${sub ?? ''}". Use init, run or compare.`);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.flags.has('version')) {
        console.log(version);
        return;
    }
    const [command, ...rest] = args.positional;
    if (args.flags.has('help') || !command) {
        console.log(USAGE);
        return;
    }
    const cacheDir = args.value('cache-dir') ?? defaultCacheDir();

    switch (command) {
        case 'build': {
            const started = Date.now();
            const index = new ProjectIndex(projectDirOf(rest[0]));
            index.refresh(true);
            const engine = new EngineProvider({ project: index, cacheDir, install: engineArg(args) });
            const out = args.value('out') ? path.resolve(args.value('out')!) : undefined;
            const emitted = writeIndex(index, { outDir: out, ...indexSections({ project: index, engine, memory: memoryFor(args, index) }) });
            console.log(`Indexed ${index.project.name}: ${index.indexedFiles().length} files, ${index.allSymbols().length} symbols in ${Date.now() - started} ms`);
            const tokens = (n: number) => `~${n.toLocaleString('en-US')} tokens`;
            const outlines = emitted.filter(f => f.path.includes(`${path.sep}files${path.sep}`));
            for (const file of emitted.filter(f => !outlines.includes(f) && !f.path.endsWith('symbols.json'))) {
                console.log(`  ${path.relative(index.root, file.path).padEnd(40)} ${tokens(file.tokens)}`);
            }
            if (outlines.length) {
                const max = Math.max(...outlines.map(f => f.tokens));
                const avg = Math.round(outlines.reduce((sum, f) => sum + f.tokens, 0) / outlines.length);
                console.log(`  ${'.llm-index/files/'.padEnd(40)} ${outlines.length} file outlines, avg ${tokens(avg)}, max ${tokens(max)}`);
            }
            engine.dispose();
            break;
        }
        case 'serve':
            await startServer(projectDirOf(rest[0]), {
                version,
                writeFiles: !args.flags.has('no-write'),
                engine: engineArg(args),
                cacheDir,
                memoryDir: args.flags.has('no-memory') ? null : args.value('memory-dir'),
                readOnlyMemory: args.flags.has('read-only-memory'),
                rgPath: args.value('rg'),
                limits: limits(args),
            });
            break;
        case 'engine':
            await engineCommand(rest[0], rest[1], args);
            break;
        case 'eval':
            await evalCommand(rest[0], rest.slice(1), args);
            break;
        case 'tool': {
            const [name, json] = rest;
            const index = new ProjectIndex(projectDirOf(args.value('project')));
            index.refresh(true);
            const engine = new EngineProvider({ project: index, cacheDir, install: engineArg(args) });
            const result = await runTool(name ?? '', json ? JSON.parse(json) : {}, {
                project: index,
                engine,
                memory: memoryFor(args, index),
                source: 'user',
                limits: limits(args),
                rgPath: args.value('rg') ?? findRipgrep(),
            });
            console.log(result.text);
            process.exitCode = result.isError ? 1 : 0;
            engine.dispose();
            break;
        }
        default:
            console.error(`Unknown command "${command}".\n\n${USAGE}`);
            process.exitCode = 1;
    }
}

main().catch(err => {
    console.error(`Error: ${err.message ?? err}`);
    process.exit(1);
});
