import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface SearchHit {
    /** Path relative to the search root, with forward slashes. */
    path: string;
    line: number;
    text: string;
}

export interface SearchResult {
    hits: SearchHit[];
    /** Matches seen, which may be more than `hits`. */
    total: number;
    /** False when the search stopped early (too many matches or the time limit). */
    complete: boolean;
}

export interface RipgrepRequest {
    rgPath: string;
    /** Search root; `paths` and results are relative to it. */
    cwd: string;
    paths: string[];
    pattern: string;
    ignoreCase: boolean;
    /** Only files matching one of these globs (case-insensitive). */
    globs?: string[];
    maxResults: number;
    timeoutMs?: number;
}

/** Stop reading after this many matches; the count is reported as "N+". */
const MAX_COUNTED = 2000;
const MAX_LINE = 200;

const clip = (text: string) => {
    const trimmed = text.trim();
    return trimmed.length > MAX_LINE ? `${trimmed.slice(0, MAX_LINE)}…` : trimmed;
};

/**
 * A ripgrep binary: $UE_LLM_INDEX_RG, the one bundled with VS Code (under `appRoot`), or rg on the PATH.
 */
export function findRipgrep(appRoot?: string): string | undefined {
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const candidates = [process.env.UE_LLM_INDEX_RG ?? ''];
    if (appRoot) {
        candidates.push(
            path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', `${process.platform}-${process.arch}`, exe),
            path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe),
            path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe),
        );
    }
    candidates.push(...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, exe)));
    return candidates.find(file => {
        try {
            return !!file && fs.statSync(file).isFile();
        } catch {
            return false;
        }
    });
}

/** Searches C++ files with ripgrep. Invalid regexes are retried as plain text. */
export function ripgrep(request: RipgrepRequest): Promise<SearchResult> {
    const run = (fixed: boolean) =>
        new Promise<SearchResult & { regexError?: boolean; error?: string }>(resolve => {
            const args = [
                '--no-config', '--no-heading', '--line-number', '--color', 'never', '--no-ignore',
                '--max-columns', '300', '--max-columns-preview',
                '--type-add', 'ue:*.{h,hpp,hh,inl,cpp,cc,cxx,c}', '--type', 'ue',
                '--glob', '!**/Intermediate/**', '--glob', '!**/Binaries/**', '--glob', '!**/ThirdParty/**',
                request.ignoreCase ? '--ignore-case' : '--case-sensitive',
                ...(fixed ? ['--fixed-strings'] : []),
                ...(request.globs ?? []).flatMap(g => ['--iglob', g]),
                '--regexp', request.pattern, '--', ...request.paths,
            ];
            const child = spawn(request.rgPath, args, { cwd: request.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            const hits: SearchHit[] = [];
            let total = 0;
            let complete = true;
            let buffered = '';
            let stderr = '';
            const stop = () => {
                complete = false;
                child.kill();
            };
            const timer = setTimeout(stop, request.timeoutMs ?? 15_000);
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                buffered += chunk;
                const lines = buffered.split('\n');
                buffered = lines.pop() ?? '';
                for (const line of lines) {
                    const match = /^(.*?):(\d+):(.*)$/.exec(line.replace(/\r$/, ''));
                    if (!match || total >= MAX_COUNTED) {
                        continue;
                    }
                    total++;
                    if (hits.length < request.maxResults) {
                        hits.push({ path: match[1].replace(/\\/g, '/').replace(/^\.\//, ''), line: Number(match[2]), text: clip(match[3]) });
                    }
                }
                if (total >= MAX_COUNTED) {
                    stop();
                }
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => (stderr += chunk));
            child.on('error', e => {
                clearTimeout(timer);
                resolve({ hits, total, complete: false, error: e.message });
            });
            child.on('close', code => {
                clearTimeout(timer);
                const failed = code === 2 && !hits.length;
                resolve({ hits, total, complete, regexError: failed && /regex/i.test(stderr), error: failed ? stderr.trim().split('\n')[0] : undefined });
            });
        });

    return run(false).then(async result => {
        const final = result.regexError ? await run(true) : result;
        if (final.error && !final.hits.length) {
            throw new Error(`ripgrep failed: ${final.error}`);
        }
        return { hits: final.hits, total: final.total, complete: final.complete };
    });
}

/** Line-by-line search in JavaScript, for when ripgrep isn't available. */
export function searchFiles(files: string[], readLines: (rel: string) => string[], regex: RegExp, maxResults: number): SearchResult {
    const hits: SearchHit[] = [];
    let total = 0;
    for (const rel of files) {
        let lines: string[];
        try {
            lines = readLines(rel);
        } catch {
            continue;
        }
        lines.forEach((line, i) => {
            if (regex.test(line)) {
                total++;
                if (hits.length < maxResults) {
                    hits.push({ path: rel, line: i + 1, text: clip(line) });
                }
            }
        });
    }
    return { hits, total, complete: true };
}

/** A JavaScript regex from user input; plain text if it isn't a valid pattern. */
export function toRegex(pattern: string, ignoreCase: boolean): RegExp {
    const flags = ignoreCase ? 'i' : '';
    try {
        return new RegExp(pattern, flags);
    } catch {
        return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    }
}
