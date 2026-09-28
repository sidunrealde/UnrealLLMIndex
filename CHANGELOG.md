# Changelog

All notable changes to unreal-llm-index are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-09-28

### Added
- **`find_references`** shows where a function, type, property or delegate is used.
  - **What it finds:** calls, delegate and input bindings (`AddDynamic`, `BindAction(..., &AClass::Func)`, `BindUFunction`), `Broadcast`/`Execute` calls, overrides, base-class declarations, and uses of types and properties. Each hit comes with the function it's in.
  - **How:** matches are found by name and sorted out with the parser. The symbol's own declarations and same-named members of unrelated classes are left out. Hits in files that don't name the class or a subclass are marked as possibly unrelated.
  - **Hidden by default:** comments, strings and bare mentions, unless `include_text` is set.
- **`callers`** lists the functions that call or bind a function, following them up to three levels.
- **The evaluation kit:**
  - **Questions:** in `.llm-eval/questions.json`, with automatic checks (names the answer must or must not mention, tools to call, a tool-call budget) and optional grading against a reference answer.
  - **Runs:** **Run Evaluation** uses any VS Code chat model (including Custom Endpoint models) through `@unreal`, or `eval run` uses an OpenAI-compatible endpoint.
  - **Reports:** Markdown and JSON in `.llm-eval/results/`, and **Compare Evaluation Results** / `eval compare` puts two runs side by side.
  - **Starter set:** **Create Evaluation Questions** / `eval init` generates questions from the project's index.
- **Documentation:** a [user guide](docs/USER_GUIDE.md) and a [design document](docs/DESIGN.md). The README is now a short introduction.

### Changed
- `@unreal` reports an estimate of its largest prompt, and can leave out the memory-writing tools; evaluation runs never write memory.
- `serve --read-only-memory` leaves out the memory-writing tools.

## [0.4.0] - 2026-09-28

### Added
- **Project memory:** notes that carry decisions, facts about the code, gotchas and open tasks across sessions.
  - **Storage:** `.llm-memory/` next to the `.uproject`, one Markdown file per note, to be committed and shared with the team.
  - **Anchoring:** each note is linked to symbols or files. It is marked *may be outdated* when that code changes, and says so when the code is gone.
- **Memory tools:** `remember`, `recall`, `update_note` and `forget`. They're marked as writing tools, so VS Code asks before saving (with Always allow); `recall` is read-only.
- **Notes appear automatically:**
  - `get_index` and INDEX.md list open tasks and the latest decisions.
  - `read_symbol` and `get_file_outline` show notes about the code being read.
  - `find_symbol` marks symbols that have notes.
- **`@unreal` changes:**
  - `/save` turns the conversation into notes; `/memory` lists them.
  - Every note it saves is shown in the chat.
  - Later turns are told what earlier answers looked at.
- **Setting:** `unrealLlmIndex.memory.enabled`.
- **CLI:** `--memory-dir` and `--no-memory` options.
- **Instructions:** the Unreal agent, the tool prompt and the AGENTS.md section explain when to read and save notes.

### Fixed
- INDEX.md is rewritten when a project is opened, so it no longer keeps an older layout until a source file changes.

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
