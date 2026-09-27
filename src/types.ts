export type SymbolKind =
    | 'class'
    | 'struct'
    | 'interface'
    | 'enum'
    | 'namespace'
    | 'function'
    | 'property'
    | 'variable'
    | 'delegate'
    | 'alias';

export type Access = 'public' | 'protected' | 'private';

/** A reflection or declaration macro attached to a symbol, e.g. UFUNCTION(BlueprintCallable). */
export interface MacroUse {
    name: string;
    /** Text between the parentheses, whitespace-normalized. */
    args: string;
}

export interface SourceRange {
    file: string;
    startLine: number;
    endLine: number;
}

export interface CodeSymbol {
    /** Simple name, e.g. "ToJsonObject". */
    name: string;
    kind: SymbolKind;
    /** Enclosing classes/namespaces joined by "::", e.g. "UAgent". */
    container?: string;
    /** Project-relative path with forward slashes. */
    file: string;
    /** 1-based line of the symbol's name. */
    line: number;
    /** First line of the whole declaration, including a preceding reflection macro. */
    startLine: number;
    /** Last line: closing brace or semicolon. */
    endLine: number;
    /** Compact one-line declaration. */
    signature: string;
    access?: Access;
    /** UCLASS / USTRUCT / UENUM / UINTERFACE / UFUNCTION / UPROPERTY / DECLARE_*DELEGATE*. */
    ue?: MacroUse;
    /** Classes and structs: parent types. */
    bases?: string[];
    /** Functions: true when the body is in this file at this location. */
    isDefinition?: boolean;
    /** Enums: enumerator names. Namespaces are not recorded as symbols. */
    members?: string[];
    /** Functions declared in a header: where their bodies live. Filled in by the indexer. */
    definitions?: SourceRange[];
}

export interface ModuleInfo {
    name: string;
    /** Project-relative module directory (contains <Name>.Build.cs). */
    dir: string;
    type?: string;
    loadingPhase?: string;
    /** Name of the project plugin that owns the module, if any. */
    plugin?: string;
    publicDeps: string[];
    privateDeps: string[];
    /** Project-relative source files belonging to this module. */
    files: string[];
}

export interface PluginInfo {
    name: string;
    dir: string;
    friendlyName?: string;
    description?: string;
    modules: string[];
}

export interface ProjectInfo {
    root: string;
    uprojectFile: string;
    name: string;
    engineAssociation: string;
    /** Plugins enabled in the .uproject (mostly engine plugins). */
    enabledPlugins: string[];
    plugins: PluginInfo[];
    modules: ModuleInfo[];
    /** Source files under Source/ or Plugins/ that are not inside a module. */
    looseFiles: string[];
}
