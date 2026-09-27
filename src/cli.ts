import * as path from 'path';
import { version } from '../package.json';
import { writeIndex } from './emit';
import { ProjectIndex } from './indexer';
import { startServer } from './server';

const USAGE = `unreal-llm-index ${version}
Builds a compact, Unreal-aware index of a UE C++ project for local LLMs, and serves it over MCP.

Usage:
  ue-llm-index build [projectDir] [--out <dir>]   Write .llm-index/ (INDEX.md, modules/*.md, symbols.json)
  ue-llm-index serve [projectDir] [--no-write]    Start the MCP server on stdio (keeps .llm-index/ up to date)

projectDir is a folder containing a .uproject (or the .uproject itself).
It defaults to $UE_LLM_INDEX_PROJECT, then the current directory.`;

function parseArgs(argv: string[]) {
    const positional: string[] = [];
    const flags = new Map<string, string | true>();
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--out') {
            flags.set('out', argv[++i] ?? '');
        } else if (arg.startsWith('--')) {
            flags.set(arg.slice(2), true);
        } else if (arg === '-h') {
            flags.set('help', true);
        } else if (arg === '-v') {
            flags.set('version', true);
        } else {
            positional.push(arg);
        }
    }
    return { positional, flags };
}

async function main() {
    const { positional, flags } = parseArgs(process.argv.slice(2));
    if (flags.has('version')) {
        console.log(version);
        return;
    }
    const [command, projectArg] = positional;
    if (flags.has('help') || !command) {
        console.log(USAGE);
        return;
    }
    const projectDir = projectArg ?? process.env.UE_LLM_INDEX_PROJECT ?? process.cwd();

    switch (command) {
        case 'build': {
            const started = Date.now();
            const index = new ProjectIndex(projectDir);
            index.refresh(true);
            const out = typeof flags.get('out') === 'string' ? path.resolve(flags.get('out') as string) : undefined;
            const emitted = writeIndex(index, out);
            console.log(
                `Indexed ${index.project.name}: ${index.indexedFiles().length} files, ${index.allSymbols().length} symbols in ${Date.now() - started} ms`,
            );
            for (const file of emitted) {
                console.log(`  ${path.relative(index.root, file.path).padEnd(40)} ~${file.tokens.toLocaleString('en-US')} tokens`);
            }
            break;
        }
        case 'serve':
            await startServer(projectDir, { version, writeFiles: !flags.has('no-write') });
            break;
        default:
            console.error(`Unknown command "${command}".\n\n${USAGE}`);
            process.exitCode = 1;
    }
}

main().catch(err => {
    console.error(`Error: ${err.message ?? err}`);
    process.exit(1);
});
