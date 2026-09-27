import { Access, CodeSymbol, MacroUse, SymbolKind } from './types';
import { LineMap, sanitize } from './sanitize';

/**
 * Lightweight, Unreal-aware C++ outline parser.
 *
 * It does not build an AST. It walks the source by brace depth and classifies each
 * statement (text up to `;`, `{` or `}`) as a namespace, class, enum, function,
 * property, delegate, etc. Function bodies are skipped. This handles the patterns UE
 * code relies on (export macros, UCLASS/UPROPERTY/UFUNCTION prefixes, GENERATED_BODY)
 * that general-purpose parsers such as tree-sitter misread.
 */

const UE_TYPE_MACROS = new Set(['UCLASS', 'USTRUCT', 'UINTERFACE', 'UENUM']);
const UE_MEMBER_MACROS = new Set(['UFUNCTION', 'UPROPERTY']);
/** Macros that belong to the declaration that follows them (unlike GENERATED_BODY or ENUM_CLASS_FLAGS). */
const ATTACHED_MACROS = new Set([...UE_TYPE_MACROS, ...UE_MEMBER_MACROS]);
const NOT_A_FUNCTION_NAME = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'alignof', 'alignas', 'decltype',
    'static_assert', 'new', 'delete', 'throw', 'case', 'void', 'int', 'bool', 'char', 'float',
    'double', 'long', 'short', 'unsigned', 'signed', 'auto', 'const', 'volatile', 'typename', 'template',
]);

interface Scope {
    kind: 'file' | 'namespace' | 'class' | 'extern';
    name?: string;
    access?: Access;
    symbol?: CodeSymbol;
}

interface StatementPrefix {
    /** Offset where the statement proper begins, after leading macros and access labels. */
    restOffset: number;
    macros: (MacroUse & { offset: number })[];
}

interface FunctionHead {
    /** Name chain as written, e.g. "UAgent::ToJsonObject". */
    qualifiedName: string;
    nameOffset: number;
    /** Offset just past the closing parenthesis of the parameter list. */
    paramsEnd: number;
}

/**
 * A macro call at the start of a statement: ALL_CAPS, or an ALL_CAPS head with mixed-case
 * segments such as DECLARE_DELEGATE_RetVal_OneParam.
 */
const MACRO_CALL = /^([A-Z][A-Z0-9]*(?:_[A-Za-z0-9]+)+|[A-Z][A-Z0-9_]*)\s*\(/;
/** Names that are macros rather than functions. Stricter than MACRO_CALL so K2_OnBeginPlay stays a function. */
const MACRO_NAME = /^[A-Z][A-Z0-9_]*$|^(?:DECLARE|DEFINE|IMPLEMENT|GENERATED|UE)_/;

const normalizeSpace = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripExportMacros = (s: string) => s.replace(/\b[A-Z][A-Z0-9_]*_API\s+/g, '');

/** Finds the index of the bracket matching the one at `open`. Returns text.length - 1 if unbalanced. */
function matchBracket(text: string, open: number, openCh: string, closeCh: string, limit = text.length): number {
    let depth = 0;
    for (let i = open; i < limit; i++) {
        const c = text[i];
        if (c === openCh) {
            depth++;
        } else if (c === closeCh) {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return limit - 1;
}

/** Splits `text` on commas that are not nested inside (), <>, [] or {}. */
function splitTopLevel(text: string, sep = ','): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '<' || c === '[' || c === '{') {
            depth++;
        } else if (c === ')' || c === '>' || c === ']' || c === '}') {
            depth = Math.max(0, depth - 1);
        } else if (c === sep && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts.map(p => p.trim()).filter(Boolean);
}

/** Index where a declarator's name ends: the first top-level `=`, `{`, `[`, `(` or bitfield `:`. */
function declaratorEnd(text: string): number {
    let angle = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '<') {
            angle++;
        } else if (c === '>' && angle > 0) {
            angle--;
        } else if (angle === 0 && (c === '=' || c === '{' || c === '[' || c === '(')) {
            return i;
        } else if (angle === 0 && c === ':' && text[i + 1] !== ':' && text[i - 1] !== ':') {
            return i;
        }
    }
    return text.length;
}

/** True if a parenthesized list holds values (`0, 15`, `rd()`) rather than parameter declarations. */
function hasArgumentList(inner: string): boolean {
    return splitTopLevel(inner).some(arg => {
        if (/^[-+]?[\d.'"]|^(true|false|nullptr)$/.test(arg)) {
            return true;
        }
        let angle = 0;
        for (const c of arg) {
            if (c === '<') {
                angle++;
            } else if (c === '>') {
                angle = Math.max(0, angle - 1);
            } else if (c === '(' && angle === 0) {
                return true;
            }
        }
        return false;
    });
}

/** Removes Category=... and meta=(...) from macro specifiers for compact outlines. */
export function compactSpecifiers(args: string): string {
    return splitTopLevel(args)
        .filter(part => !/^(Category|meta)\s*=/i.test(part))
        .join(', ');
}

export function parseSource(src: string, file: string): CodeSymbol[] {
    const { code, display } = sanitize(src);
    const lines = new LineMap(src);
    const n = code.length;
    const symbols: CodeSymbol[] = [];
    const stack: Scope[] = [{ kind: 'file' }];

    const top = () => stack[stack.length - 1];
    const containerName = () =>
        stack
            .filter(s => (s.kind === 'namespace' || s.kind === 'class') && s.name)
            .map(s => s.name)
            .join('::') || undefined;
    const displayText = (from: number, to: number) => stripExportMacros(normalizeSpace(display.slice(from, to)));

    /** Consumes leading ALL_CAPS macro calls (UFUNCTION(...), GENERATED_BODY(), ...) and access labels. */
    function readPrefix(start: number, end: number): StatementPrefix {
        const macros: StatementPrefix['macros'] = [];
        let p = start;
        for (;;) {
            while (p < end && /\s/.test(code[p])) {
                p++;
            }
            const rest = code.slice(p, end);
            const access = /^(public|protected|private)\s*:(?!:)/.exec(rest);
            if (access) {
                const scope = top();
                if (scope.kind === 'class') {
                    scope.access = access[1] as Access;
                }
                p += access[0].length;
                continue;
            }
            const macro = MACRO_CALL.exec(rest);
            if (macro) {
                const open = p + macro[0].length - 1;
                const close = matchBracket(code, open, '(', ')', end);
                macros.push({ name: macro[1], args: normalizeSpace(display.slice(open + 1, close)), offset: p });
                p = close + 1;
                continue;
            }
            break;
        }
        return { restOffset: p, macros };
    }

    /** Recognizes `ReturnType Qualified::Name(params)` at the start of a statement. */
    function readFunctionHead(start: number, end: number): FunctionHead | undefined {
        let angle = 0;
        let paren = -1;
        for (let i = start; i < end; i++) {
            const c = code[i];
            if (c === '<' && code[i + 1] !== '<' && code[i - 1] !== '<' && code[i + 1] !== '=') {
                angle++;
            } else if (c === '>' && code[i - 1] !== '-' && angle > 0) {
                angle--;
            } else if (c === '(' && angle === 0) {
                paren = i;
                break;
            } else if (c === '=' && angle === 0 && !/operator\s*[^\s\w]*$/.test(code.slice(start, i))) {
                // `Type Name = Init(...)` is a variable, not a function
                return undefined;
            } else if (c === '{' || c === ';') {
                return undefined;
            }
        }
        if (paren === -1) {
            return undefined;
        }

        const before = code.slice(start, paren);
        const nameMatch = /((?:[A-Za-z_]\w*\s*(?:<[^()]*?>)?\s*::\s*)*(?:~\s*[A-Za-z_]\w*|operator\s*(?:[^\s\w(]+|\w+[\s*&]*)|[A-Za-z_]\w*))\s*$/.exec(before);
        if (!nameMatch) {
            return undefined;
        }
        let qualifiedName = normalizeSpace(nameMatch[1]).replace(/\s*::\s*/g, '::');
        const simple = qualifiedName.split('::').pop() ?? '';
        if (NOT_A_FUNCTION_NAME.has(simple) || MACRO_NAME.test(simple)) {
            return undefined;
        }

        let params = paren;
        if (simple === 'operator' && code[paren + 1] === ')') {
            // operator() — the real parameter list follows
            qualifiedName += '()';
            params = code.indexOf('(', paren + 2);
            if (params === -1 || params >= end) {
                return undefined;
            }
        }
        const close = matchBracket(code, params, '(', ')', end);
        return { qualifiedName, nameOffset: start + nameMatch.index, paramsEnd: close + 1 };
    }

    /** Signature for display: the statement text up to the body, without a constructor initializer list. */
    function functionSignature(start: number, head: FunctionHead, end: number): string {
        const tail = code.slice(head.paramsEnd, end);
        const init = /(^|[^:]):(?!:)/.exec(tail);
        const sigEnd = init ? head.paramsEnd + init.index + init[1].length : end;
        return displayText(start, sigEnd);
    }

    const lastMacro = (macros: StatementPrefix['macros'], names: Set<string>) =>
        [...macros].reverse().find(m => names.has(m.name));
    const ueInfo = (macros: StatementPrefix['macros'], names: Set<string>): MacroUse | undefined => {
        const macro = lastMacro(macros, names);
        return macro && { name: macro.name, args: macro.args };
    };

    function recordDelegates(prefix: StatementPrefix, end: number) {
        for (const macro of prefix.macros) {
            if (!/^DECLARE_(DYNAMIC_)?(MULTICAST_)?(DELEGATE|EVENT|DERIVED_EVENT)/.test(macro.name)) {
                continue;
            }
            const args = splitTopLevel(macro.args);
            const nameIndex = /EVENT/.test(macro.name) ? 1 : /RetVal/.test(macro.name) ? 1 : 0;
            const name = args[nameIndex];
            if (!name || !/^\w+$/.test(name)) {
                continue;
            }
            symbols.push({
                name,
                kind: 'delegate',
                container: containerName(),
                file,
                line: lines.lineOf(macro.offset),
                startLine: lines.lineOf(macro.offset),
                endLine: lines.lineOf(end),
                signature: `${macro.name}(${macro.args})`,
                ue: { name: macro.name, args: macro.args },
            });
        }
    }

    function handleOpen(stmtStart: number, brace: number): { next: number; keepStatement: boolean } {
        const scope = top();
        const prefix = readPrefix(stmtStart, brace);
        const start = prefix.restOffset;
        const raw = code.slice(start, brace);
        const startLine = lines.lineOf(lastMacro(prefix.macros, ATTACHED_MACROS)?.offset ?? start);

        const ns =/^(?:inline\s+)?namespace\b\s*([\w:]*)\s*$/.exec(raw);
        if (ns) {
            stack.push({ kind: 'namespace', name: ns[1] || undefined });
            return { next: brace + 1, keepStatement: false };
        }

        if (/^extern\s*"\s*"\s*$/.test(raw)) {
            stack.push({ kind: 'extern' });
            return { next: brace + 1, keepStatement: false };
        }

        const close = matchBracket(code, brace, '{', '}');

        const en = /^(?:typedef\s+)?enum\b(?:\s+(?:class|struct))?(?:\s+(?:[A-Z][A-Z0-9_]*_API\s+)?([A-Za-z_]\w*))?\s*(?::\s*([\w:\s]+))?$/d.exec(raw);
        if (en) {
            const name = en[1];
            if (name && en.indices?.[1]) {
                const members = splitTopLevel(code.slice(brace + 1, close))
                    .map(m => /^[A-Za-z_]\w*/.exec(m)?.[0])
                    .filter((m): m is string => !!m);
                symbols.push({
                    name,
                    kind: 'enum',
                    container: containerName(),
                    file,
                    line: lines.lineOf(start + en.indices[1][0]),
                    startLine,
                    endLine: lines.lineOf(close),
                    signature: displayText(start, brace),
                    access: scope.kind === 'class' ? scope.access : undefined,
                    ue: ueInfo(prefix.macros, UE_TYPE_MACROS),
                    members,
                });
            }
            return { next: close + 1, keepStatement: false };
        }

        const cls = /(?:^|[\s>])(class|struct|union)\s+((?:[A-Z][A-Z0-9_]*_API\s+|alignas\s*\([^)]*\)\s*|[A-Z_][A-Z0-9_]*\s*\([^)]*\)\s*)*)([A-Za-z_]\w*)(\s+final)?\s*(?::(?!:)\s*([^;]*))?$/d.exec(raw);
        if (cls?.indices?.[3] && !/^\s*(?:typedef|using)\b/.test(raw)) {
            const keyword = cls[1];
            const name = cls[3];
            const ueMacro = ueInfo(prefix.macros, UE_TYPE_MACROS);
            const kind: SymbolKind = ueMacro?.name === 'UINTERFACE' ? 'interface' : keyword === 'class' ? 'class' : 'struct';
            const bases = cls[5]
                ? splitTopLevel(cls[5]).map(b => normalizeSpace(b.replace(/\b(public|protected|private|virtual)\b/g, '')))
                : undefined;
            const symbol: CodeSymbol = {
                name,
                kind,
                container: containerName(),
                file,
                line: lines.lineOf(start + cls.indices[3][0]),
                startLine,
                endLine: lines.lineOf(close),
                signature: displayText(start, brace),
                access: scope.kind === 'class' ? scope.access : undefined,
                ue: ueMacro,
                bases,
            };
            symbols.push(symbol);
            stack.push({ kind: 'class', name, access: keyword === 'class' ? 'private' : 'public', symbol });
            return { next: brace + 1, keepStatement: false };
        }

        const head = readFunctionHead(start, brace);
        if (head) {
            const chain = head.qualifiedName.split('::');
            const name = chain.pop() ?? head.qualifiedName;
            const container = [containerName(), ...chain.map(c => c.replace(/<.*>$/, ''))].filter(Boolean).join('::') || undefined;
            symbols.push({
                name,
                kind: 'function',
                container,
                file,
                line: lines.lineOf(head.nameOffset),
                startLine,
                endLine: lines.lineOf(close),
                signature: functionSignature(start, head, brace),
                access: scope.kind === 'class' ? scope.access : undefined,
                ue: ueInfo(prefix.macros, UE_MEMBER_MACROS),
                isDefinition: true,
            });
            return { next: close + 1, keepStatement: false };
        }

        // Initializer braces (`= { ... }`), lambdas, anonymous types: skip, statement continues
        return { next: close + 1, keepStatement: true };
    }

    function handleSemicolon(stmtStart: number, semi: number) {
        const scope = top();
        const prefix = readPrefix(stmtStart, semi);
        const start = prefix.restOffset;
        const raw = code.slice(start, semi).trim();
        const startLine = lines.lineOf(lastMacro(prefix.macros, ATTACHED_MACROS)?.offset ?? start);

        recordDelegates(prefix, semi);
        if (!raw) {
            return;
        }
        if (/^(using\s+namespace|friend|static_assert|template\s+(class|struct)\b|extern\s+template)\b/.test(raw)) {
            return;
        }
        // Forward declarations
        if (/^(?:class|struct|union|enum(?:\s+class)?)\s+(?:[A-Z][A-Z0-9_]*_API\s+)?[A-Za-z_]\w*\s*(?::\s*[\w\s:]+)?$/.test(raw)) {
            return;
        }

        const alias = /^using\s+([A-Za-z_]\w*)\s*=/.exec(raw) ?? (/^typedef\b/.test(raw) ? /([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$/.exec(raw) : null);
        if (alias) {
            symbols.push({
                name: alias[1],
                kind: 'alias',
                container: containerName(),
                file,
                line: lines.lineOf(start),
                startLine,
                endLine: lines.lineOf(semi),
                signature: displayText(start, semi),
                access: scope.kind === 'class' ? scope.access : undefined,
            });
            return;
        }

        const head = readFunctionHead(start, semi);
        // Outside classes, `Type name(args);` may be a variable with direct initialization
        const isInitializedVariable = head && scope.kind !== 'class' && hasArgumentList(code.slice(code.indexOf('(', head.nameOffset) + 1, head.paramsEnd - 1));
        if (head && !isInitializedVariable) {
            const chain = head.qualifiedName.split('::');
            const name = chain.pop() ?? head.qualifiedName;
            symbols.push({
                name,
                kind: 'function',
                container: [containerName(), ...chain].filter(Boolean).join('::') || undefined,
                file,
                line: lines.lineOf(head.nameOffset),
                startLine,
                endLine: lines.lineOf(semi),
                signature: displayText(start, semi) + ';',
                access: scope.kind === 'class' ? scope.access : undefined,
                ue: ueInfo(prefix.macros, UE_MEMBER_MACROS),
                isDefinition: false,
            });
            return;
        }

        // Property / variable: the name is the last identifier before an initializer, bitfield or array bound
        const declarator = splitTopLevel(raw)[0] ?? raw;
        const cut = declaratorEnd(declarator);
        const lhs = declarator.slice(0, cut);
        const nameMatch = /([A-Za-z_]\w*)\s*$/.exec(lhs);
        if (!nameMatch || !/\S\s*[\s*&>]\s*[A-Za-z_]\w*\s*$/.test(lhs)) {
            return;
        }
        symbols.push({
            name: nameMatch[1],
            kind: scope.kind === 'class' ? 'property' : 'variable',
            container: containerName(),
            file,
            line: lines.lineOf(start + raw.indexOf(nameMatch[1], nameMatch.index)),
            startLine,
            endLine: lines.lineOf(semi),
            signature: displayText(start, semi) + ';',
            access: scope.kind === 'class' ? scope.access : undefined,
            ue: ueInfo(prefix.macros, UE_MEMBER_MACROS),
        });
    }

    let i = 0;
    let stmtStart = -1;
    while (i < n) {
        const c = code[i];
        if (c === '{') {
            const { next, keepStatement } = handleOpen(stmtStart < 0 ? i : stmtStart, i);
            i = next;
            if (!keepStatement) {
                stmtStart = -1;
            }
            continue;
        }
        if (c === '}') {
            if (stack.length > 1) {
                stack.pop();
            }
            stmtStart = -1;
            i++;
            continue;
        }
        if (c === ';') {
            if (stmtStart >= 0) {
                handleSemicolon(stmtStart, i);
            }
            stmtStart = -1;
            i++;
            continue;
        }
        if (stmtStart < 0 && !/\s/.test(c)) {
            stmtStart = i;
        }
        i++;
    }

    linkInterfaces(symbols);
    return symbols;
}

/** A UINTERFACE declares a UFoo shell plus an IFoo class with the actual interface; mark both. */
function linkInterfaces(symbols: CodeSymbol[]) {
    for (const shell of symbols.filter(s => s.kind === 'interface' && s.name.startsWith('U'))) {
        const iface = symbols.find(s => s.kind === 'class' && s.name === `I${shell.name.slice(1)}` && s.file === shell.file);
        if (iface) {
            iface.kind = 'interface';
        }
    }
}
