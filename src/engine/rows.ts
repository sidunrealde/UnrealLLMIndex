import { qualifiedName } from '../indexer';
import { parseSource } from '../parse';
import { readText } from '../scan';
import { CodeSymbol } from '../types';
import { ACCESS_LEVELS, FLAG_DEFINITION, KINDS, UE_DELEGATE, UE_MACROS } from './schema';

/** [qualified name, simple name, kind, flags, line, startLine, endLine, ue] */
export type SymbolRow = [string, string, number, number, number, number, number, number];

export interface ParsedFile {
    rel: string;
    lines: number;
    rows: SymbolRow[];
    error?: string;
}

const isHeaderPath = (rel: string) => /\.(h|hpp|hh|inl)$/i.test(rel);

export function symbolRow(s: CodeSymbol): SymbolRow {
    const access = s.access ? ACCESS_LEVELS.indexOf(s.access) : 0;
    const ue = s.ue ? (UE_MACROS.indexOf(s.ue.name) > 0 ? UE_MACROS.indexOf(s.ue.name) : UE_DELEGATE) : 0;
    return [qualifiedName(s), s.name, KINDS.indexOf(s.kind), (s.isDefinition ? FLAG_DEFINITION : 0) | (access << 1), s.line, s.startLine, s.endLine, ue];
}

/** Symbols of one file worth storing: everything except file-local variables in implementation files. */
export function parseFileRows(abs: string, rel: string): ParsedFile {
    try {
        const text = readText(abs);
        const header = isHeaderPath(rel);
        const rows = parseSource(text, rel)
            .filter(s => header || s.kind !== 'variable')
            .map(symbolRow);
        return { rel, lines: text.split('\n').length, rows };
    } catch (e: any) {
        return { rel, lines: 0, rows: [], error: String(e?.message ?? e) };
    }
}
