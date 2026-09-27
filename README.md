# Unreal LLM Index

Helps **local LLMs** (Ollama, LM Studio, llama.cpp) work with **Unreal Engine C++ projects** without running out of context.

Small models can't read a whole UE project: even a modest one is 30–40k tokens of source, before the agent's own prompt. Unreal LLM Index gives the model a compact map of the project and a set of lookup tools, so it reads a ~2k-token overview first and then fetches only the function or line range it needs.

It has two parts:

- **`ue-llm-index build`** writes a `.llm-index/` folder into your project:
  - `INDEX.md`: modules, their dependencies, and every source file with the types it declares (~2k tokens for a typical project)
  - `modules/<Module>.md`: every declaration with signatures and line numbers, linked to where each function is implemented
  - `symbols.json`: the machine-readable symbol table
- **`ue-llm-index serve`** is an [MCP](https://modelcontextprotocol.io) server that coding agents (Continue, Cline, Roo Code, ...) call as tools. Every result is capped at ~3k tokens, and it re-parses changed files automatically.

The parser understands Unreal's conventions: `UCLASS`/`USTRUCT`/`UENUM`/`UINTERFACE`, `UFUNCTION`/`UPROPERTY` specifiers, `*_API` export macros, `GENERATED_BODY()`, delegate macros, modules from `*.Build.cs`, and project plugins. `Intermediate/`, `Binaries/`, `Saved/` and generated headers are skipped.

## Example

What the model sees from `get_file_outline("Agent.h")`:

```text
### Agent.h (73 lines)
L16-24 namespace Agent constants: NAME_FIELD_NAME, MBOX_FIELD_NAME, ...
L27-72 UCLASS(ClassGroup = (XAPI)) class UAgent : public UXAPIActor, public IJsonModel, public IStatementTarget
  public:
    L34 UAgent();  → Agent.cpp:5-10
  protected:
    L38 virtual void BeginPlay() override;  → Agent.cpp:12-16
  public:
    L42 virtual TSharedPtr<class FJsonObject> ToJsonObject() override;  → Agent.cpp:18-55
    L45 UFUNCTION(BlueprintPure, BlueprintCallable) virtual FString GetObjectType() override;  → Agent.cpp:57-60
    L52 UPROPERTY(VisibleAnywhere, BlueprintReadOnly) FString ObjectType = FString();
```

With `qwen2.5:7b` and a 32k window, the question *"Where is UAgent::ToJsonObject implemented, and which JSON fields does it write?"* took 4 tool steps (`get_index` → `find_symbol` → `read_lines` → answer). The largest prompt was 3.8k tokens, against ~37k tokens for the whole project.

## Install

Requires Node.js 20 or later.

```sh
git clone <this repo> UnrealLLMIndex
cd UnrealLLMIndex
npm install
npm run build
```

This produces a single self-contained file, `dist/cli.js`. You can run it with `node dist/cli.js ...`, or run `npm link` to get a global `ue-llm-index` command.

## Usage

```sh
# Write .llm-index/ into the project (the folder with the .uproject)
node dist/cli.js build D:/Projects/UnrealEngine/MyProject

# Start the MCP server on stdio (normally your agent starts this for you)
node dist/cli.js serve D:/Projects/UnrealEngine/MyProject
```

- `build --out <dir>` writes the index somewhere else.
- `serve --no-write` keeps everything in memory. By default the server also keeps `.llm-index/` up to date.
- If no project is given, `UE_LLM_INDEX_PROJECT` and then the current directory are used.

`.llm-index/` is generated, so add it to your project's `.gitignore` unless you want to commit it.

### MCP tools

| Tool | What it returns |
|---|---|
| `get_index()` | The project map (`INDEX.md`). Call this first. |
| `get_module_outline(module)` | One module's classes with their function and property names. |
| `get_file_outline(path)` | Every declaration in a file with signatures, line numbers, and `→ file:lines` implementation links. |
| `find_symbol(query, kind?, limit?)` | Classes, functions, properties, enums or delegates matching a full or partial name. |
| `read_symbol(name)` | The source of one symbol: a function's declaration and implementation, or a class/struct/enum. |
| `read_lines(path, start, end?)` | An exact line range, up to 200 lines. |
| `search_code(pattern, path_filter?, ignore_case?, max_results?)` | Regex search across the project's source files. |

Paths can be any unique suffix, such as `Agent.h` or `Public/Agent.h`. Tools only read files inside the project folder.

## Setting up a local LLM

### 1. Give Ollama a bigger context window

Ollama uses a small default context unless you raise it. That alone makes agents fail on real code. To set 32k for every model (PowerShell), then restart Ollama:

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_CONTEXT_LENGTH', '32768', 'User')
```

### 2. Pick a model that is good at tool calling

On a 24 GB GPU (e.g. RTX 4090):

- **`qwen3-coder:30b`** (19 GB): mixture-of-experts coder built for agentic use, 256k native context. Recommended.
- **`qwen2.5-coder:14b`** (~9 GB): lighter, and leaves more room for context.
- `qwen2.5:7b` handles simple lookups (tested above) but struggles with multi-step tasks.

```sh
ollama pull qwen3-coder:30b
```

### 3. Connect a coding agent

The server works with any MCP-capable client. In each config, replace the two paths with your checkout of this repo and your UE project.

**Continue** (recommended for local models: its system prompt is lighter than Cline's or Roo's, which matters in 32k):

1. Copy [`templates/continue/mcpServers/unreal-llm-index.yaml`](templates/continue/mcpServers/unreal-llm-index.yaml) to `<project>/.continue/mcpServers/`.
2. Copy [`templates/rules/unreal-llm-index.md`](templates/rules/unreal-llm-index.md) to `<project>/.continue/rules/`. It tells the model to use the index instead of opening whole files.
3. Select your Ollama model and use **Agent** mode. MCP tools are only available there.

**Cline / Roo Code**: add the entry from [`templates/mcp.json`](templates/mcp.json) to Cline's `cline_mcp_settings.json`, or to Roo's project file `.roo/mcp.json`. Then add the rules file as `.clinerules` or a Roo custom instruction.

### 4. Test it without an editor

`agent-smoke` is a minimal agent loop that connects Ollama to the server and prints every tool call:

```sh
node dist/agent-smoke.js --project D:/Projects/UnrealEngine/MyProject --model qwen3-coder:30b --ctx 32768 "How does the save flow work?"
```

It passes `num_ctx` per request, so it works even before step 1.

## Limitations

- The parser is a fast, Unreal-aware heuristic, not a compiler. It reads both branches of `#if` blocks, and it can't see types generated by custom macros. It never throws on odd code; it just records less.
- Only the project's own source (`Source/` and `Plugins/`) is indexed. Engine headers are not indexed yet (see Roadmap).
- Overloads share a name. `read_symbol` returns all of them.

## Roadmap

- **Engine lookup**: a `find_engine_symbol` tool that finds the installed engine from the project's `EngineAssociation` and returns outlines of engine classes such as `ACharacter` or `UCharacterMovementComponent`. Results would be cached per engine version.

## Development

```sh
npm run typecheck
npm test          # vitest; fixtures in test/fixtures/SampleGame
npm run build
```

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT License. Copyright (c) 2026 Siddartha Gonnabattula.
