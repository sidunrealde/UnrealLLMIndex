import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { EngineProvider } from './engineContext';
import { ProjectIndex, qualifiedName } from './indexer';
import { CodeSymbol, SourceIndex } from './types';

/** Project memory lives next to the .uproject, to be committed with the project. */
export const MEMORY_DIR = '.llm-memory';

export const NOTE_KINDS = ['decision', 'fact', 'gotcha', 'task', 'summary'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export interface MemoryNote {
    /** Short id the model quotes, e.g. "k3f9a2". */
    id: string;
    kind: NoteKind;
    /** Tasks only. */
    status?: 'open' | 'done';
    /** Symbols ("AActor::BeginPlay"), file paths, or plain tags the note is about. */
    about: string[];
    /** A hash of each anchor's code when the note was written or last confirmed. */
    fingerprints: Record<string, string>;
    created: string;
    updated: string;
    /** Who wrote it: "@unreal", "agent" or "user". */
    source?: string;
    text: string;
    /** File name inside the memory folder. */
    file: string;
}

export interface NoteInput {
    text: string;
    kind: NoteKind;
    about: string[];
    fingerprints: Record<string, string>;
    source?: string;
}

const FOLDER_README = `# Project memory

Notes that LLM agents using Unreal LLM Index (and people) keep about this project:
decisions, facts about the code, gotchas and open tasks, each linked to the code it's about.
Agents read them at the start of a session and next to the code they look at.

Commit this folder so everyone's agents share the same notes. Each note is a Markdown file
with a short header; edit or delete them freely.
`;

// ---------------------------------------------------------------------------------------------
// Note files

/** Reads a note. Files without a header become facts named after the file, so hand-written notes work. */
export function parseNote(content: string, file: string, mtime = new Date(0)): MemoryNote {
    const text = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
    const header = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    const fields: Record<string, unknown> = {};
    if (header) {
        for (const line of header[1].split('\n')) {
            const kv = /^\s*([A-Za-z_]\w*)\s*:\s*(.*)$/.exec(line);
            if (!kv) {
                continue;
            }
            let value: unknown = kv[2].trim();
            if (/^[[{"]/.test(value as string)) {
                try {
                    value = JSON.parse(value as string);
                } catch {
                    // Keep the raw text
                }
            } else {
                // Plain values may carry a YAML comment
                value = (value as string).replace(/\s+#.*$/, '');
            }
            fields[kv[1]] = value;
        }
    }
    const kind = NOTE_KINDS.includes(fields.kind as NoteKind) ? (fields.kind as NoteKind) : 'fact';
    const about = Array.isArray(fields.about)
        ? fields.about.map(String)
        : typeof fields.about === 'string' && fields.about
          ? fields.about.split(',').map(s => s.trim()).filter(Boolean)
          : [];
    const fingerprints: Record<string, string> = {};
    if (fields.fingerprints && typeof fields.fingerprints === 'object') {
        for (const [key, value] of Object.entries(fields.fingerprints as Record<string, unknown>)) {
            fingerprints[key] = String(value);
        }
    }
    const stamp = (value: unknown) => (typeof value === 'string' && value ? value : mtime.toISOString());
    return {
        id: typeof fields.id === 'string' && fields.id ? fields.id : path.basename(file, path.extname(file)),
        kind,
        status: kind === 'task' ? (fields.status === 'done' ? 'done' : 'open') : undefined,
        about,
        fingerprints,
        created: stamp(fields.created),
        updated: stamp(fields.updated ?? fields.created),
        source: typeof fields.source === 'string' && fields.source ? fields.source : undefined,
        text: (header ? header[2] : text).trim(),
        file,
    };
}

export function formatNote(note: MemoryNote): string {
    const lines = ['---', `id: ${note.id}`, `kind: ${note.kind}`];
    if (note.status) {
        lines.push(`status: ${note.status}`);
    }
    lines.push(`about: ${JSON.stringify(note.about)}`);
    if (Object.keys(note.fingerprints).length) {
        lines.push(`fingerprints: ${JSON.stringify(note.fingerprints)}`);
    }
    lines.push(`created: ${note.created}`, `updated: ${note.updated}`);
    if (note.source) {
        lines.push(`source: ${JSON.stringify(note.source)}`);
    }
    lines.push('---', note.text.trim(), '');
    return lines.join('\n');
}

/** The first few words of a note, for a readable file name. */
function slug(text: string): string {
    let out = '';
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6)) {
        const next = out ? `${out}-${word}` : word;
        if (next.length > 48) {
            break;
        }
        out = next;
    }
    return out || 'note';
}

/** Notes in one folder, one Markdown file each. Re-read when any file changes. */
export class MemoryStore {
    private cached?: { key: string; notes: MemoryNote[] };

    constructor(readonly dir: string) {}

    private noteFiles(): { file: string; stat: fs.Stats }[] {
        let names: string[];
        try {
            names = fs.readdirSync(this.dir);
        } catch {
            return [];
        }
        return names
            .filter(name => name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'readme.md')
            .map(file => ({ file, stat: fs.statSync(path.join(this.dir, file)) }))
            .filter(entry => entry.stat.isFile());
    }

    /** All notes, most recently updated first. */
    list(): MemoryNote[] {
        const files = this.noteFiles();
        const key = files.map(f => `${f.file}:${f.stat.mtimeMs}:${f.stat.size}`).join('|');
        if (this.cached?.key !== key) {
            const notes = files.map(f => parseNote(fs.readFileSync(path.join(this.dir, f.file), 'utf8'), f.file, f.stat.mtime));
            notes.sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
            this.cached = { key, notes };
        }
        return this.cached.notes;
    }

    /** A note by id, or by an id prefix that matches only one note. */
    get(id: string): MemoryNote | undefined {
        const wanted = id.trim().replace(/^\[|\]$/g, '').toLowerCase();
        const notes = this.list();
        const exact = notes.find(n => n.id.toLowerCase() === wanted);
        if (exact) {
            return exact;
        }
        const prefixed = notes.filter(n => n.id.toLowerCase().startsWith(wanted));
        return wanted && prefixed.length === 1 ? prefixed[0] : undefined;
    }

    add(input: NoteInput): MemoryNote {
        fs.mkdirSync(this.dir, { recursive: true });
        const readme = path.join(this.dir, 'README.md');
        if (!fs.existsSync(readme)) {
            fs.writeFileSync(readme, FOLDER_README, 'utf8');
        }
        const taken = new Set(this.list().map(n => n.id));
        let id: string;
        do {
            id = randomBytes(4).readUInt32BE(0).toString(36).padStart(6, '0').slice(-6);
        } while (taken.has(id));
        const now = new Date().toISOString();
        const note: MemoryNote = {
            id,
            kind: input.kind,
            status: input.kind === 'task' ? 'open' : undefined,
            about: input.about,
            fingerprints: input.fingerprints,
            created: now,
            updated: now,
            source: input.source,
            text: input.text.trim(),
            file: `${id}-${slug(input.text)}.md`,
        };
        fs.writeFileSync(path.join(this.dir, note.file), formatNote(note), 'utf8');
        this.cached = undefined;
        return note;
    }

    update(id: string, patch: Partial<Pick<MemoryNote, 'text' | 'kind' | 'status' | 'about' | 'fingerprints'>>): MemoryNote {
        const current = this.get(id);
        if (!current) {
            throw new Error(`No note with id "${id}". recall lists the notes and their ids.`);
        }
        const kind = patch.kind ?? current.kind;
        const note: MemoryNote = {
            ...current,
            ...patch,
            kind,
            status: kind === 'task' ? (patch.status ?? current.status ?? 'open') : undefined,
            text: (patch.text ?? current.text).trim(),
            updated: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(this.dir, note.file), formatNote(note), 'utf8');
        this.cached = undefined;
        return note;
    }

    remove(id: string): MemoryNote {
        const note = this.get(id);
        if (!note) {
            throw new Error(`No note with id "${id}". recall lists the notes and their ids.`);
        }
        fs.rmSync(path.join(this.dir, note.file), { force: true });
        this.cached = undefined;
        return note;
    }
}

// ---------------------------------------------------------------------------------------------
// Anchors: what a note is about, and whether that code changed since

/** What anchors are resolved against: the project, and the engine when it's indexed. */
export interface CodeContext {
    project: ProjectIndex;
    engine?: EngineProvider;
}

interface ResolvedAnchor {
    /** How the anchor is stored: a qualified name, a file path, or the input as a tag. */
    key: string;
    fingerprint?: string;
    note?: string;
}

const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12);
const normalize = (lines: string[]) => lines.join('\n').replace(/\s+/g, ' ').trim();
const looksLikePath = (input: string) => /[\\/]|\.(h|hpp|hh|inl|cpp|cc|cxx|c|cs|ini|uplugin|uproject|md|json)$/i.test(input);

/** A hash of a symbol's declarations and definitions, ignoring whitespace. */
function symbolFingerprint(index: SourceIndex, matches: CodeSymbol[]): string {
    const ranges = new Map<string, { file: string; start: number; end: number }>();
    for (const s of matches) {
        ranges.set(`${s.file}:${s.startLine}`, { file: s.file, start: s.startLine, end: s.endLine });
        for (const d of s.definitions ?? []) {
            ranges.set(`${d.file}:${d.startLine}`, { file: d.file, start: d.startLine, end: d.endLine });
        }
    }
    const parts = [...ranges.values()]
        .sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start)
        .map(r => normalize(index.readFileLines(r.file).slice(r.start - 1, r.end)));
    return hash(parts.join('\n'));
}

/** Symbols named `input` in one index, if they share one qualified name. */
function uniqueSymbol(matches: CodeSymbol[]): { qualified: string; matches: CodeSymbol[] } | 'ambiguous' | undefined {
    const names = [...new Set(matches.map(qualifiedName))];
    if (!names.length) {
        return undefined;
    }
    return names.length === 1 ? { qualified: names[0], matches } : 'ambiguous';
}

/** Resolves one anchor now: a project or engine symbol, a project or engine file, or a plain tag. */
export function resolveAnchor(ctx: CodeContext, input: string): ResolvedAnchor {
    const raw = input.trim();
    const state = ctx.engine?.state();
    const engine = state && 'handle' in state ? state.handle : undefined;
    let ambiguous: string[] = [];

    if (!looksLikePath(raw)) {
        for (const [index, matches] of [
            [ctx.project, ctx.project.resolveSymbol(raw)] as const,
            ...(engine ? [[engine.index, engine.index.resolveSymbol(raw, engine.rank)] as const] : []),
        ]) {
            const found = uniqueSymbol(matches);
            if (found === 'ambiguous') {
                ambiguous = [...new Set(matches.map(qualifiedName))];
                break;
            }
            if (found) {
                return { key: found.qualified, fingerprint: symbolFingerprint(index, found.matches) };
            }
        }
        if (ambiguous.length) {
            return { key: raw, note: `"${raw}" matches ${ambiguous.slice(0, 4).join(', ')}; use a qualified name` };
        }
    }
    for (const index of [ctx.project, ...(engine ? [engine.index] : [])]) {
        try {
            const rel = index.resolvePath(raw);
            return { key: rel, fingerprint: hash(normalize(index.readFileLines(rel))) };
        } catch {
            // Not a file in this index
        }
    }
    return { key: raw, note: `"${raw}" isn't a symbol or file in the project or engine` };
}

/** Anchors and their fingerprints for a new or updated note. */
export function resolveAnchors(ctx: CodeContext, inputs: string[]): { about: string[]; fingerprints: Record<string, string>; notes: string[] } {
    const about: string[] = [];
    const fingerprints: Record<string, string> = {};
    const notes: string[] = [];
    for (const input of inputs.map(s => s.trim()).filter(Boolean)) {
        const anchor = resolveAnchor(ctx, input);
        if (!about.includes(anchor.key)) {
            about.push(anchor.key);
        }
        if (anchor.fingerprint) {
            fingerprints[anchor.key] = anchor.fingerprint;
        }
        if (anchor.note) {
            notes.push(anchor.note);
        }
    }
    return { about, fingerprints, notes };
}

export interface NoteCheck {
    /** Anchors whose code changed since the note was written or confirmed. */
    changed: string[];
    /** Anchors that no longer exist. */
    missing: string[];
}

/** Compares a note's anchors with the code as it is now. Plain tags are not checked. */
export function checkNote(ctx: CodeContext, note: MemoryNote): NoteCheck {
    const check: NoteCheck = { changed: [], missing: [] };
    for (const [key, fingerprint] of Object.entries(note.fingerprints)) {
        const now = resolveAnchor(ctx, key);
        if (!now.fingerprint) {
            check.missing.push(key);
        } else if (now.fingerprint !== fingerprint) {
            check.changed.push(key);
        }
    }
    return check;
}

// ---------------------------------------------------------------------------------------------
// Finding and showing notes

/** Notes about any of these symbols or files (case-insensitive). With `members`, also notes about their members. */
export function notesAbout(notes: MemoryNote[], targets: string[], options: { members?: boolean } = {}): MemoryNote[] {
    const wanted = new Set(targets.filter(Boolean).map(t => t.toLowerCase()));
    return notes.filter(note =>
        note.about.some(anchor => {
            const key = anchor.toLowerCase();
            return wanted.has(key) || (options.members && [...wanted].some(t => key.startsWith(`${t}::`)));
        }),
    );
}

const clip = (text: string, max: number) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One line per note: id, kind, date, text, what it's about, and whether that code changed since. */
export function noteLine(ctx: CodeContext, note: MemoryNote, maxText = 400): string {
    const check = checkNote(ctx, note);
    const status = note.kind === 'task' ? ` (${note.status ?? 'open'})` : '';
    const about = note.about.length ? ` — about ${note.about.join(', ')}` : '';
    const flags = [
        check.missing.length ? `${check.missing.join(', ')} no longer exists` : '',
        check.changed.length ? `may be outdated: ${check.changed.join(', ')} changed since ${note.updated.slice(0, 10)}` : '',
    ].filter(Boolean);
    return `- [${note.id}] ${note.kind}${status}, ${note.updated.slice(0, 10)}: ${clip(note.text, maxText)}${about}${flags.length ? ` [${flags.join('; ')}]` : ''}`;
}

/** The "Project memory" part of INDEX.md and get_index: open tasks and the latest decisions and facts. */
export function renderMemorySection(ctx: CodeContext, store: MemoryStore): string[] {
    const notes = store.list();
    const out = ['## Project memory'];
    if (!notes.length) {
        out.push(`No notes yet. Notes are kept in ${MEMORY_DIR}/ across sessions: save decisions, non-obvious facts, gotchas and unfinished work with remember(text, kind, about).`);
        return out;
    }
    out.push(
        `${notes.length} notes in ${MEMORY_DIR}/, kept across sessions and shared with the team. ` +
            'Follow them; if one is marked outdated, check the code and confirm it with update_note(id) or correct it. recall(query or about) finds more; remember(...) adds one.',
    );
    const open = notes.filter(n => n.kind === 'task' && n.status !== 'done');
    if (open.length) {
        out.push('', `Open tasks (${open.length}):`, ...open.slice(0, 10).map(n => noteLine(ctx, n, 200)));
    }
    const recent = notes.filter(n => n.kind !== 'task').slice(0, 10);
    if (recent.length) {
        out.push('', 'Latest decisions, facts and gotchas:', ...recent.map(n => noteLine(ctx, n, 200)));
    }
    return out;
}
