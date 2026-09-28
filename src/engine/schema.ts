import { SymbolKind } from '../types';

/** Part of the database file name: a new schema means a new file, never a migration. */
export const SCHEMA_VERSION = 1;
/** Bump when parse.ts produces different symbols, so engine files are parsed again. */
export const PARSER_VERSION = 1;

/** Symbol kinds by their stored number. */
export const KINDS: SymbolKind[] = ['class', 'struct', 'interface', 'enum', 'namespace', 'function', 'property', 'variable', 'delegate', 'alias'];
export const TYPE_KIND_CODES = [0, 1, 2];

/** Reflection macros by their stored number. 0 is none; any DECLARE_*DELEGATE* macro is stored as UE_DELEGATE. */
export const UE_MACROS = ['', 'UCLASS', 'USTRUCT', 'UINTERFACE', 'UENUM', 'UFUNCTION', 'UPROPERTY'];
export const UE_DELEGATE = 7;

/** symbols.flags: bit 0 is "has a body here"; bits 1-2 are the access level. */
export const FLAG_DEFINITION = 1;
export const ACCESS_LEVELS = [undefined, 'public', 'protected', 'private'] as const;

/**
 * The index stores where symbols are, not their text: outlines and signatures are parsed from
 * the engine's files when asked for, so the database stays small and never shows stale lines.
 */
export const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS plugins (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL, dir TEXT NOT NULL, dir_lower TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL, friendly TEXT, description TEXT, enabled_by_default INTEGER, installed INTEGER,
    plugin_deps TEXT NOT NULL, modules TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS modules (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_lower TEXT NOT NULL, dir TEXT NOT NULL, dir_lower TEXT NOT NULL UNIQUE,
    plugin TEXT, type TEXT, loading_phase TEXT, public_deps TEXT NOT NULL, private_deps TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL, path_lower TEXT NOT NULL UNIQUE, module_id INTEGER,
    mtime REAL NOT NULL, size INTEGER NOT NULL, lines INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS names (id INTEGER PRIMARY KEY, qn TEXT NOT NULL, name_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS symbols (
    file_id INTEGER NOT NULL, name_id INTEGER NOT NULL, kind INTEGER NOT NULL, flags INTEGER NOT NULL,
    line INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, ue INTEGER NOT NULL);
`;

/**
 * Names are looked up through their simple name (the part after the last "::"), then matched on the
 * full qualified name: one index instead of two, which matters with over a million names.
 */
export const SIMPLE_NAME = 'lower(substr(qn, name_at))';

/** Created after the first bulk load, which is much faster without them. */
export const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS symbols_name ON symbols (name_id);
CREATE INDEX IF NOT EXISTS symbols_file ON symbols (file_id);
CREATE INDEX IF NOT EXISTS names_name ON names (${SIMPLE_NAME});
CREATE INDEX IF NOT EXISTS files_module ON files (module_id);
CREATE INDEX IF NOT EXISTS modules_name ON modules (name_lower);
CREATE INDEX IF NOT EXISTS plugins_name ON plugins (name_lower);
CREATE VIRTUAL TABLE IF NOT EXISTS names_fts USING fts5 (qn, content = 'names', content_rowid = 'id', tokenize = 'trigram', detail = 'none', columnsize = 0);
`;
