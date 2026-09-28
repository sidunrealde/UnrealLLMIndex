/**
 * Minimal stand-in for the `vscode` module so the extension can be activated in unit tests.
 * Only the APIs the extension uses are implemented; calls are recorded in `mock`.
 */
import * as path from 'path';

type Listener<T> = (value: T) => void;

export class EventEmitter<T> {
    private listeners: Listener<T>[] = [];
    event = (listener: Listener<T>) => {
        this.listeners.push(listener);
        return { dispose: () => (this.listeners = this.listeners.filter(l => l !== listener)) };
    };
    fire(value: T) {
        this.listeners.forEach(l => l(value));
    }
    dispose() {
        this.listeners = [];
    }
}

export class Uri {
    private constructor(readonly fsPath: string) {}
    static file(p: string) {
        return new Uri(path.resolve(p));
    }
}

export class RelativePattern {
    constructor(readonly base: string, readonly pattern: string) {}
}

export class McpStdioServerDefinition {
    constructor(
        readonly label: string,
        public command: string,
        public args: string[] = [],
        public env: Record<string, string | number | null> = {},
        public version?: string,
    ) {}
}

export class ThemeIcon {
    constructor(readonly id: string) {}
}

export class Position {
    constructor(readonly line: number, readonly character: number) {}
}

export class Range {
    readonly start: Position;
    readonly end: Position;
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
        this.start = new Position(startLine, startCharacter);
        this.end = new Position(endLine, endCharacter);
    }
}

export class Location {
    constructor(readonly uri: Uri, readonly range: Range) {}
}

export class MarkdownString {
    constructor(public value = '') {}
}

export class CancellationError extends Error {}

export class LanguageModelError extends Error {
    constructor(message: string, readonly code = 'Unknown') {
        super(message);
    }
}

export class LanguageModelTextPart {
    constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
    constructor(public callId: string, public name: string, public input: object) {}
}

export class LanguageModelToolResultPart {
    constructor(public callId: string, public content: unknown[]) {}
}

export enum LanguageModelChatMessageRole {
    User = 1,
    Assistant = 2,
}

export class LanguageModelChatMessage {
    content: unknown[];
    constructor(public role: LanguageModelChatMessageRole, content: string | unknown[]) {
        this.content = typeof content === 'string' ? [new LanguageModelTextPart(content)] : content;
    }
    static User(content: string | unknown[]) {
        return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content);
    }
    static Assistant(content: string | unknown[]) {
        return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content);
    }
}

export class ChatRequestTurn {
    constructor(readonly prompt: string, readonly participant = 'unrealLlmIndex.unreal') {}
}

export class ChatResponseMarkdownPart {
    readonly value: MarkdownString;
    constructor(value: string) {
        this.value = new MarkdownString(value);
    }
}

export class ChatResponseTurn {
    constructor(readonly response: unknown[], readonly result = {}, readonly participant = 'unrealLlmIndex.unreal') {}
}

export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
}

export enum ProgressLocation {
    SourceControl = 1,
    Window = 10,
    Notification = 15,
}

export enum ConfigurationTarget {
    Global = 1,
    Workspace = 2,
    WorkspaceFolder = 3,
}

export interface FakeWatcher {
    pattern: RelativePattern;
    change: EventEmitter<Uri>;
    create: EventEmitter<Uri>;
    delete: EventEmitter<Uri>;
}

export const mock = {
    uprojects: [] as string[],
    workspaceFolders: [] as string[],
    settings: {} as Record<string, unknown>,
    commands: new Map<string, (...args: any[]) => any>(),
    contextKeys: {} as Record<string, unknown>,
    mcpProviders: new Map<string, any>(),
    participants: new Map<string, { handler: (...args: any[]) => any; iconPath?: unknown }>(),
    watchers: [] as FakeWatcher[],
    messages: [] as string[],
    progress: [] as { title?: string; location: ProgressLocation }[],
    openedDocuments: [] as string[],
    statusText: '',
    reset() {
        this.uprojects = [];
        this.workspaceFolders = [];
        this.settings = {};
        this.commands.clear();
        this.contextKeys = {};
        this.mcpProviders.clear();
        this.participants.clear();
        this.watchers = [];
        this.messages = [];
        this.progress = [];
        this.openedDocuments = [];
        this.statusText = '';
    },
};

const noopDisposable = { dispose() {} };

export const window = {
    activeTextEditor: undefined as undefined | { document: { uri: Uri } },
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    createStatusBarItem: () => ({
        command: undefined as string | undefined,
        tooltip: '',
        set text(value: string) {
            mock.statusText = value;
        },
        get text() {
            return mock.statusText;
        },
        show() {},
        hide() {},
        dispose() {},
    }),
    showInformationMessage: async (message: string) => {
        mock.messages.push(message);
        return undefined;
    },
    showWarningMessage: async (message: string) => {
        mock.messages.push(message);
        return undefined;
    },
    showErrorMessage: async (message: string) => {
        mock.messages.push(message);
        return undefined;
    },
    showQuickPick: async (items: any[]) => items[0],
    showOpenDialog: async () => undefined,
    showTextDocument: async (uri: Uri) => {
        mock.openedDocuments.push(uri.fsPath);
    },
    withProgress: async (options: { title?: string; location: ProgressLocation }, task: (progress: any, token: any) => Promise<unknown>) => {
        mock.progress.push(options);
        return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => noopDisposable });
    },
};

export const env = { appRoot: '' };

export const workspace = {
    isTrusted: true,
    get workspaceFolders() {
        return mock.workspaceFolders.map((folder, index) => ({ uri: Uri.file(folder), name: path.basename(folder), index }));
    },
    getWorkspaceFolder: (uri: Uri) => {
        const folder = mock.workspaceFolders.find(f => uri.fsPath.toLowerCase().startsWith(path.resolve(f).toLowerCase()));
        return folder ? { uri: Uri.file(folder), name: path.basename(folder), index: 0 } : undefined;
    },
    findFiles: async () => mock.uprojects.map(p => Uri.file(p)),
    createFileSystemWatcher: (pattern: RelativePattern) => {
        const watcher: FakeWatcher = { pattern, change: new EventEmitter(), create: new EventEmitter(), delete: new EventEmitter() };
        mock.watchers.push(watcher);
        return {
            onDidChange: watcher.change.event,
            onDidCreate: watcher.create.event,
            onDidDelete: watcher.delete.event,
            dispose() {},
        };
    },
    getConfiguration: (section: string) => ({
        get: <T>(key: string, fallback: T): T => (`${section}.${key}` in mock.settings ? (mock.settings[`${section}.${key}`] as T) : fallback),
        update: async (key: string, value: unknown) => {
            mock.settings[`${section}.${key}`] = value;
        },
    }),
    onDidChangeWorkspaceFolders: () => noopDisposable,
    onDidChangeConfiguration: () => noopDisposable,
};

export const commands = {
    registerCommand: (id: string, handler: (...args: any[]) => any) => {
        mock.commands.set(id, handler);
        return noopDisposable;
    },
    executeCommand: async (id: string, ...args: unknown[]) => {
        if (id === 'setContext') {
            mock.contextKeys[args[0] as string] = args[1];
        }
    },
};

export const lm = {
    registerMcpServerDefinitionProvider: (id: string, provider: any) => {
        mock.mcpProviders.set(id, provider);
        return noopDisposable;
    },
};

export const chat = {
    createChatParticipant: (id: string, handler: (...args: any[]) => any) => {
        const participant = { handler, iconPath: undefined as unknown, dispose() {} };
        mock.participants.set(id, participant);
        return participant;
    },
};
