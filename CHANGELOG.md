# Changelog

All notable changes to unreal-llm-index are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-28

### Added
- **Engine and plugin index.** The engine the project uses is indexed with all of its engine plugins, Marketplace/Fab plugins and platform extensions.
  - **Storage:** a SQLite database per engine install in the user cache, shared by the CLI and every VS Code window. UE 5.8 takes about 15 seconds on worker threads and about 300 MB.
  - **Updates:** incremental. Only changed files are parsed again, for example after a launcher update, a Fab install or source-build edits.
- **Engine discovery** from `EngineAssociation`:
  - launcher installs, found through the registry and `LauncherInstalled.dat`
  - source builds, found by GUID or through `Install.ini`
  - a project inside an engine tree
  - `unrealLlmIndex.enginePath` and **Select Engine…** override it.
- **Plugin enablement:** follows UE's rules (the `.uproject`, `EnabledByDefault`, dependencies). Engine results from modules and plugins the project uses rank first.
- **Tool changes:**
  - `scope` (`project`, `engine`, `all`) on `find_symbol`, `read_symbol` and `search_code`.
  - `list_plugins`.
  - `get_module_outline` and `get_file_outline` work on engine modules, plugins and files.
  - `get_module_outline` takes `filter`; `get_file_outline` takes `type`.
  - Engine `search_code` uses the ripgrep that ships with VS Code.
- **Chat:**
  - An **Unreal** custom agent bundled with the extension, and a command to copy it into the workspace.
  - An **`@unreal`** chat participant that runs its own tool loop with the selected model, shows the code it read as references, and trims old tool results as the conversation nears the model's context limit.
- **INDEX.md** has an Engine section: the version, plugins the `.uproject` enables, installed Marketplace plugins, and the engine modules the project uses.
- **Commands:** Sync Engine Index, Rebuild Engine Index, Select Engine…, Clear Engine Index Cache, Copy Unreal Agent to Workspace.
- **Settings:** `engine.enabled`, `engine.autoSync`, `enginePath`, `cacheDir`, `maxResultTokens`, `maxReadLines`, `chat.maxToolRounds`.
- **CLI:** `engine locate|list|sync|info` and `tool <name> <json>`; `serve` takes `--engine`, `--no-engine`, `--cache-dir`, `--rg` and output limits.

### Changed
- MCP tools are marked read-only, so VS Code runs them without a confirmation prompt.
- Tool results are capped at 8,000 tokens and 400 lines by default (previously about 3,000 tokens and 200 lines), and are configurable.
- Files whose full outline is too long get a compact outline, and classes too large for one read return their member outline instead.
- Project scanning walks the tree once, which scales to engine-sized trees.
- Requires VS Code 1.138 and Node.js 22.13 or later.

## [0.2.0] - 2026-09-27

### Added
- VS Code extension. It activates in workspaces with a `.uproject`, builds `.llm-index/` and keeps it up to date as files change, and shows a status bar item.
- The index is registered as an MCP server through VS Code's MCP API, so chat agents get the tools automatically with whichever model is selected. It runs on VS Code's own Node.js.
- **Add Instructions to AGENTS.md** command, which writes a marked section pointing agents at `.llm-index/INDEX.md`. It only runs when invoked.
- Per-file outlines in `.llm-index/files/<Module>/<path>.md` (about 200 tokens each) with full source paths, for agents that can only read files.

### Changed
- `.llm-index/modules/<Module>.md` is now the compact module summary instead of one large outline.
- `INDEX.md` explains both ways to use the index (plain file reading and MCP tools), with examples taken from the project.
- `agent-smoke` works with any OpenAI-compatible endpoint (`--base-url`, `--model`, `--api-key`) instead of Ollama only.
- Unchanged index files are no longer rewritten, and outlines of deleted source files are removed.

### Removed
- Ollama-specific setup instructions, and the Continue and Cline config templates. The tool is now provider-agnostic.

## [0.1.0] - 2026-09-27

### Added
- `ue-llm-index build`: scans a UE project (`.uproject`, project plugins, `*.Build.cs` modules) and writes `.llm-index/` with `INDEX.md`, per-module outlines and `symbols.json`.
- Unreal-aware outline parser for headers and `.cpp` files: UCLASS/USTRUCT/UENUM/UINTERFACE types, UFUNCTION/UPROPERTY members with specifiers, delegates, export macros, access sections, and links from header declarations to their implementations.
- `ue-llm-index serve`: MCP server (stdio) with `get_index`, `get_module_outline`, `get_file_outline`, `find_symbol`, `read_symbol`, `read_lines` and `search_code`. Every result is capped at about 3k tokens, and the index refreshes when files change.
- `agent-smoke` script to test the tools end to end with a local Ollama model.
- Templates for Continue, Cline/Roo Code and an agent rules file.
