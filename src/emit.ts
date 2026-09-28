import * as fs from 'fs';
import * as path from 'path';
import { ProjectIndex } from './indexer';
import { estimateTokens, outlineFilePath, renderFileOutline, renderIndex, renderModuleSummary } from './outline';

export const INDEX_DIR = '.llm-index';

export interface EmittedFile {
    path: string;
    tokens: number;
}

const safeFileName = (name: string) => name.replace(/[^\w.-]+/g, '_');

/**
 * Writes the static index:
 *   INDEX.md                       project map
 *   modules/<Module>.md            classes of one module with member names
 *   files/<Module>/<path>.md       outline of one source file
 *   symbols.json                   machine-readable symbol table
 * Files left over from deleted sources or modules are removed. Unchanged files are not rewritten.
 */
export interface WriteOptions {
    /** Defaults to <project>/.llm-index. */
    outDir?: string;
    /** Engine lines for INDEX.md, from renderEngineSection. */
    engineSection?: string[];
}

export function writeIndex(index: ProjectIndex, options: WriteOptions = {}): EmittedFile[] {
    const outDir = options.outDir ?? path.join(index.root, INDEX_DIR);
    const emitted: EmittedFile[] = [];
    const expected = new Set<string>();
    const write = (relPath: string, content: string) => {
        const file = path.join(outDir, relPath);
        expected.add(path.resolve(file).toLowerCase());
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let current: string | undefined;
        try {
            current = fs.readFileSync(file, 'utf8');
        } catch {
            // New file
        }
        if (current !== content) {
            fs.writeFileSync(file, content, 'utf8');
        }
        emitted.push({ path: file, tokens: estimateTokens(content) });
    };

    write('INDEX.md', renderIndex(index, { engineSection: options.engineSection }));

    for (const module of index.project.modules) {
        write(`modules/${safeFileName(module.name)}.md`, renderModuleSummary(index, module, { maxFiles: 0, outlineFiles: true }) + '\n');
        for (const rel of module.files) {
            write(outlineFilePath(module, rel), renderFileOutline(index, rel, { fullPaths: true }) + '\n');
        }
    }
    for (const rel of index.project.looseFiles) {
        write(outlineFilePath(undefined, rel), renderFileOutline(index, rel, { fullPaths: true }) + '\n');
    }

    write('symbols.json', JSON.stringify({
        generatedAt: index.generatedAt.toISOString(),
        project: index.project,
        symbols: index.allSymbols(),
    }));

    removeStale(path.join(outDir, 'modules'), expected);
    removeStale(path.join(outDir, 'files'), expected);
    return emitted;
}

/** Deletes files under `dir` that were not written this time, then empty directories. */
function removeStale(dir: string, expected: Set<string>) {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            removeStale(full, expected);
            if (fs.readdirSync(full).length === 0) {
                fs.rmdirSync(full);
            }
        } else if (!expected.has(path.resolve(full).toLowerCase())) {
            fs.unlinkSync(full);
        }
    }
}
