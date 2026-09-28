import { ProjectIndex } from './indexer';
import { exampleFile, outlineFilePath, UNREAL_CONVENTIONS } from './outline';

export const SECTION_START = '<!-- unreal-llm-index:start -->';
export const SECTION_END = '<!-- unreal-llm-index:end -->';

/** The MCP server's name in VS Code, and the tool-set name agent files use for its tools. */
export const MCP_SERVER_LABEL = 'Unreal LLM Index';
export const toolSetName = (label: string) => label.toLowerCase().replace(/\s+/g, '-');

/**
 * Instructions for coding agents, written between markers into the project's AGENTS.md.
 * Many agents read AGENTS.md automatically; the rest can be pointed at it.
 */
export function renderAgentsSection(index: ProjectIndex): string {
    const example = exampleFile(index);
    const outline = example ? `\`.llm-index/${outlineFilePath(example.module, example.rel)}\`` : '`.llm-index/files/<Module>/<path>.md`';
    const symbol = example?.qualified ?? 'AMyActor::BeginPlay';
    return [
        SECTION_START,
        '## Navigating this Unreal Engine project',
        '',
        'This project has an LLM index in `.llm-index/`, kept up to date by the Unreal LLM Index extension. Use it instead of reading whole source files:',
        '',
        '1. Read `.llm-index/INDEX.md` first. It lists the modules, their dependencies, every source file with the types it declares, and the engine and plugins the project uses.',
        '2. For one module, read `.llm-index/modules/<Module>.md`: its classes with their function and property names.',
        `3. For one file, read \`.llm-index/files/<Module>/<path>.md\` (e.g. ${outline}): every declaration with line numbers, and \`→ file:lines\` links to implementations.`,
        '4. Then read only the line ranges you need from the actual source file.',
        '',
        `If the \`unreal-llm-index\` MCP tools are available, prefer them: \`find_symbol\` locates a class or function by name, \`read_symbol\` returns just its code (e.g. \`${symbol}\`), \`find_references\` and \`callers\` show where it is used, and \`search_code\` searches the source. ` +
            'They also cover the engine and its plugins: pass `scope: "engine"` for engine classes such as `ACharacter`, and use `list_plugins` to see which plugins the project enables.',
        '',
        'Project memory: `.llm-memory/` holds notes (decisions, facts, gotchas, open tasks) linked to the code they are about, and INDEX.md lists open tasks and recent decisions. ' +
            'Read the notes about code before changing it; with the MCP tools, save new ones with `remember`.',
        '',
        UNREAL_CONVENTIONS,
        SECTION_END,
    ].join('\n');
}

const TOOL_STEPS = [
    '1. Call get_index once at the start: it lists the project\'s modules, files and types, and the engine version and plugins the project uses.',
    '2. Use find_symbol to locate something by name. It searches the project and the engine (scope "all"); use scope "engine" for engine classes such as ACharacter or UCharacterMovementComponent.',
    '3. Use get_file_outline or get_module_outline to understand a file or module. Engine modules work too (e.g. "Engine" with a filter such as "GameFramework").',
    '4. Use read_symbol (e.g. "ACharacter::Jump") or read_lines to see code. Fetch only the lines you need; never read whole files, especially engine files.',
    '5. Use find_references to see where a function, type, property or delegate is used (calls, bindings, overrides) before changing it, and callers to trace who calls a function, a few levels up with depth.',
    '6. Use search_code with a short regex if you only know what the code does. For engine code pass scope "engine", optionally with a module, plugin or folder as path_filter.',
    '7. Use list_plugins to see which engine and Marketplace plugins the project enables.',
    '8. Project memory carries decisions across sessions. get_index lists open tasks and recent decisions, and read_symbol and get_file_outline show notes about the code you read: follow them. ' +
        'If a note is marked possibly outdated, check the code, then confirm it with update_note(id) or correct it. ' +
        'When you and the user decide something, learn something non-obvious about the code, hit a gotcha, or leave work unfinished, save it with remember, attached to the symbols involved.',
];

/** System prompt for agents that have the tools (agent-smoke and the @unreal participant). */
export const TOOL_AGENT_PROMPT = [
    'You are working in an Unreal Engine C++ project that is indexed by the unreal-llm-index tools, together with its engine and all engine and Marketplace plugins. Your context is limited, so:',
    ...TOOL_STEPS,
    'Cite file paths with line numbers when you explain code.',
    UNREAL_CONVENTIONS,
].join('\n');

/**
 * The "Unreal" custom agent for VS Code chat. `servers` are the MCP server labels whose tools it may use.
 * The extension bundles the version for the default label; the Copy command writes one per workspace.
 */
export function renderAgentFile(servers: string[] = [MCP_SERVER_LABEL]): string {
    const tools = [...servers.map(label => `${toolSetName(label)}/*`), 'read', 'search', 'edit', 'execute', 'todo'];
    return [
        '---',
        'name: Unreal',
        'description: Unreal Engine C++ help that uses the Unreal LLM Index of this project, its engine, and engine and Marketplace plugins.',
        'argument-hint: Ask about your UE C++ code, engine classes or plugins',
        `tools: [${tools.map(t => `'${t}'`).join(', ')}]`,
        '---',
        'You are an Unreal Engine C++ assistant for this project. The unreal-llm-index tools index the project\'s own code, the engine it uses, and all engine and Marketplace (Fab) plugins. Use them instead of reading whole files:',
        '',
        ...TOOL_STEPS,
        '',
        'Before changing code, read the declarations involved and follow the conventions of the surrounding code. Cite file paths with line numbers when you explain code.',
        '',
        UNREAL_CONVENTIONS,
        '',
    ].join('\n');
}

/** Inserts or replaces the marked section, leaving the rest of the file untouched. */
export function mergeAgentsFile(existing: string | undefined, section: string): string {
    if (!existing?.trim()) {
        return `# AGENTS.md\n\n${section}\n`;
    }
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const block = section.replace(/\n/g, eol);
    const start = existing.indexOf(SECTION_START);
    const end = existing.indexOf(SECTION_END);
    if (start !== -1 && end > start) {
        return existing.slice(0, start) + block + existing.slice(end + SECTION_END.length);
    }
    return `${existing.replace(/\s*$/, '')}${eol}${eol}${block}${eol}`;
}
