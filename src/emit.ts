import * as fs from 'fs';
import * as path from 'path';
import { ProjectIndex } from './indexer';
import { estimateTokens, renderFileOutline, renderIndex, renderModuleOutline } from './outline';

export const INDEX_DIR = '.llm-index';

export interface EmittedFile {
    path: string;
    tokens: number;
}

const safeFileName = (name: string) => name.replace(/[^\w.-]+/g, '_');

/** Writes INDEX.md, modules/<Module>.md and symbols.json. Removes module files that no longer exist. */
export function writeIndex(index: ProjectIndex, outDir = path.join(index.root, INDEX_DIR)): EmittedFile[] {
    const modulesDir = path.join(outDir, 'modules');
    fs.mkdirSync(modulesDir, { recursive: true });

    const emitted: EmittedFile[] = [];
    const write = (file: string, content: string) => {
        fs.writeFileSync(file, content, 'utf8');
        emitted.push({ path: file, tokens: estimateTokens(content) });
    };

    write(path.join(outDir, 'INDEX.md'), renderIndex(index));

    const moduleFiles = new Set<string>();
    for (const module of index.project.modules) {
        const file = `${safeFileName(module.name)}.md`;
        moduleFiles.add(file);
        write(path.join(modulesDir, file), renderModuleOutline(index, module));
    }
    if (index.project.looseFiles.length) {
        const file = '_Other.md';
        moduleFiles.add(file);
        write(path.join(modulesDir, file), ['## Source files outside modules', ...index.project.looseFiles.map(rel => renderFileOutline(index, rel))].join('\n\n') + '\n');
    }
    for (const stale of fs.readdirSync(modulesDir)) {
        if (stale.endsWith('.md') && !moduleFiles.has(stale)) {
            fs.unlinkSync(path.join(modulesDir, stale));
        }
    }

    const symbolsJson = JSON.stringify({
        generatedAt: index.generatedAt.toISOString(),
        project: index.project,
        symbols: index.allSymbols(),
    });
    fs.writeFileSync(path.join(outDir, 'symbols.json'), symbolsJson, 'utf8');

    return emitted;
}
