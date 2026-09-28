# Unreal LLM Index

Gives any LLM in VS Code chat a compact, **Unreal Engine-aware index** of your project, **the engine it uses, and every engine and Marketplace (Fab) plugin**. This works whether the model is hosted or running on your own machine.

An Unreal project is too big for any context window. UE 5.8's engine source alone is about 83,000 C++ files, over 200 million tokens. Unreal LLM Index gives the model a small map of your project and tools to look up exactly the class, function or line range it needs, in your code or in the engine.

The parser understands Unreal's conventions:

- `UCLASS`, `USTRUCT`, `UENUM` and `UINTERFACE`
- `UFUNCTION` and `UPROPERTY` specifiers
- `*_API` export macros, `GENERATED_BODY()` and delegate macros
- modules from `*.Build.cs`, and plugins from `*.uplugin`

It links each function declared in a header to its body in a `.cpp` file.

## Using it in VS Code chat

Open a folder that contains a `.uproject`. The extension indexes the project straight away, then indexes its engine in the background. There are three ways to use the index in chat, with whichever model you pick:

1. **Agent mode.** The **Unreal LLM Index** MCP server is registered with VS Code automatically. Its tools appear in the chat tools picker. They are read-only, so they run without confirmation prompts.
2. **The Unreal agent.** Pick **Unreal** in the chat's agent dropdown. It's set up with the index tools and instructions for using them. **Unreal LLM Index: Copy Unreal Agent to Workspace** writes an editable copy to `.github/agents/unreal.agent.md`.
3. **`@unreal`.** Ask `@unreal how does ACharacter::Jump reach UCharacterMovementComponent?` in any chat mode. The participant does four things:
   - starts from the project map
   - calls the tools itself, showing each call
   - lists the code it read as references
   - removes old tool results when the conversation nears the model's context limit

### Using your own model

VS Code chat can use any OpenAI-compatible endpoint, including a self-hosted model such as Qwen served by vLLM, SGLang or llama.cpp:

1. Open the chat model picker and choose to manage models.
2. Add a **Custom Endpoint** model with its URL.
3. Turn on **tool calling** and set its context window.

For Qwen 3.x on vLLM or SGLang, start the server with `--tool-call-parser qwen3_coder --reasoning-parser qwen3` so tool calls are recognized.

Tool results are capped at 8,000 tokens by default. With a long-context model you can raise `unrealLlmIndex.maxResultTokens`; with a small one, lower it.

## What gets indexed

| | What | Where the index lives |
|---|---|---|
| **Project** | `Source/` and the project's `Plugins/` | In memory, updated as you edit. Also written to `.llm-index/` for agents that only read files. |
| **Engine** | `Engine/Source/Runtime`, `Developer` and `Editor`; every plugin in `Engine/Plugins`, including Marketplace/Fab plugins in `Engine/Plugins/Marketplace`; and platform extensions | A SQLite database per engine install in your user cache (about 300 MB for UE 5.8). It is shared by all projects and VS Code windows that use that engine. Nothing is written to the engine folder. |

Not indexed:
- `ThirdParty`, `Intermediate`, `Binaries`, `Programs`, plugin templates and generated headers.
- Blueprints and other assets.

**Finding the engine.** The engine comes from the project's `EngineAssociation`:
- Launcher installs are found through the registry or `LauncherInstalled.dat`.
- Source builds are found through their registered GUID, or through `Install.ini` on macOS and Linux.
- A project inside an engine tree uses that engine.

**Unreal LLM Index: Select Engine…** lists every install it finds and can set `unrealLlmIndex.enginePath` for you.

**First build and updates.** The first build takes about 15 seconds to a minute for a full engine, with a progress notification. After that, a sync re-parses only files that changed: after a launcher update, a Fab plugin install or source-build edits. A sync runs on startup when the index is over 12 hours old or the engine changed, and when you run **Sync Engine Index**.

**Which code ranks first.** Engine results are ranked by what your project actually uses:
1. modules listed in your `Build.cs` files
2. their public dependencies
3. plugins your project enables

A plugin counts as enabled through the `.uproject`, through its own `EnabledByDefault`, or as a dependency of an enabled plugin. `list_plugins` shows which plugins are enabled and why.

## Tools

| Tool | What it returns |
|---|---|
| `get_index()` | The project map: modules, dependencies, each file's types, and the engine and plugins in use. |
| `get_module_outline(module, filter?)` | A module's classes with their function and property names. Works for project modules, engine modules (`"Engine"`, `"UMG"`) and plugins. Large modules list their folders until you pass a filter. |
| `get_file_outline(path, type?)` | Every declaration in a file, with line numbers and `→ file:lines` links to implementations. Very long files get a compact outline. |
| `find_symbol(query, kind?, scope?, limit?)` | Classes, functions, properties, enums or delegates matching a full or partial name, from the project and the engine. |
| `read_symbol(name, scope?)` | A function's declaration and implementation, or a type's declaration. Classes too large for one read return their member outline. |
| `read_lines(path, start, end?)` | An exact line range of a project or engine file. |
| `search_code(pattern, scope?, path_filter?, …)` | A regex search of the project, or of the engine code the project uses. Name a module, plugin or folder to search it instead. Engine searches use the ripgrep that ships with VS Code. |
| `list_plugins(query?, include_disabled?)` | Project, engine and Marketplace plugins: whether each is enabled and why, its description and its modules. |

`scope` is `"project"`, `"engine"` or `"all"`. Paths can be any unique suffix, such as `Character.h` or `GameFramework/Character.h`. Engine paths start with `Engine/`. Tools only read files inside the project and the engine.

## Files in `.llm-index/`

For agents that read files rather than calling tools:

| File | Contents |
|---|---|
| `INDEX.md` | How to use the index; the modules with their dependencies; every source file with the types it declares; and the engine version, enabled plugins and engine modules in use. |
| `modules/<Module>.md` | One module's classes with their function and property names. |
| `files/<Module>/<path>.md` | One source file's declarations with signatures, line numbers and links to implementations (about 200 tokens each). |
| `symbols.json` | The project's full symbol table. |

**Unreal LLM Index: Add Instructions to AGENTS.md** adds a marked section to `AGENTS.md` that points agents at the index. `.llm-index/` is generated, so add it to `.gitignore`.

## Commands

| Command | What it does |
|---|---|
| **Sync Engine Index** / **Rebuild Engine Index** | Update the engine index / parse the whole engine again. |
| **Select Engine…** | Choose which engine install to index. |
| **Clear Engine Index Cache** | Delete the engine indexes. They are rebuilt when needed. |
| **Copy Unreal Agent to Workspace** | Write an editable `.github/agents/unreal.agent.md`. |
| **Add Instructions to AGENTS.md** | Point `AGENTS.md`-reading agents at the index. |
| **Open INDEX.md** / **Rebuild Index** | Open or rebuild the project map. |

## Settings

| Setting | Default | |
|---|---|---|
| `unrealLlmIndex.engine.enabled` | `true` | Index the engine and its plugins. |
| `unrealLlmIndex.engine.autoSync` | `onStartup` | `manual` to sync only when you run the command. |
| `unrealLlmIndex.enginePath` | | The engine folder (the one containing `Engine/`), instead of `EngineAssociation`. |
| `unrealLlmIndex.cacheDir` | OS cache | Where engine indexes are kept. |
| `unrealLlmIndex.maxResultTokens` | `8000` | Largest tool result. With `0`, `@unreal` sizes results to the model. |
| `unrealLlmIndex.maxReadLines` | `400` | Most lines per read. |
| `unrealLlmIndex.chat.maxToolRounds` | `15` | Most rounds of tool calls per `@unreal` question. |
| `unrealLlmIndex.registerMcpServer` | `true` | Register the MCP server with VS Code. |
| `unrealLlmIndex.writeIndexFiles` | `true` | Keep `.llm-index/` up to date. |

## Alongside Epic's Unreal MCP

UE 5.8 includes an experimental **Unreal MCP** plugin with editor toolsets for Blueprints, actors, assets and live coding. It works inside the running editor. Unreal LLM Index covers the C++ source instead: your code, the engine's and plugins'. It works without the editor running, on any engine version. The two can be used together.

## Command line

The same index works without VS Code. `npm run build` produces `dist/cli.js` (Node.js 22.13 or later):

```sh
ue-llm-index build   <project>                # write .llm-index/
ue-llm-index serve   <project>                # MCP server on stdio, with the engine index
ue-llm-index engine  sync <project>           # build or update the engine index
ue-llm-index engine  locate <project>         # which engine the project uses
ue-llm-index engine  list                     # engine installs found on this machine
ue-llm-index tool    find_symbol '{"query":"ACharacter::Jump"}' --project <project>
```

- `--engine <dir>` picks the engine; `--no-engine` indexes the project only.
- `--cache-dir <dir>` moves the engine index cache.
- `--rg <path>` points engine searches at ripgrep.

MCP clients that don't use VS Code's registry, such as Continue, Cline or Roo Code, can run the server from their own config:

```json
{
  "mcpServers": {
    "unreal-llm-index": {
      "command": "node",
      "args": ["<path>/dist/cli.js", "serve", "<path>/MyProject"]
    }
  }
}
```

### Testing with a model

`dist/agent-smoke.js` runs a minimal agent loop against any OpenAI-compatible endpoint and prints each tool call:

```sh
node dist/agent-smoke.js --project D:/Projects/MyGame \
  --base-url http://my-server:8000/v1 --model qwen3.6 \
  "How does ACharacter::Jump reach UCharacterMovementComponent?"
```

## Limitations

- **The parser is a heuristic, not a compiler.** It reads both branches of `#if` blocks and can't see types generated by custom macros. It never fails on odd code; it just records less. On the UE 5.8 `Engine` module it finds all 1,330 `UCLASS` types.
- **Search is by name and text.** There is no semantic search, and no find-references.
- **Needs a recent VS Code.** Requires VS Code 1.138 or later, for its built-in Node.js with SQLite and for the chat and MCP APIs.

## Roadmap

- **Session memory.** Notes and decisions that carry across chat sessions, attached to the symbols they're about.

## Development

```sh
npm install
npm run typecheck
npm test          # vitest; fixtures in test/fixtures (SampleGame and a fake engine)
npm run build     # dist/cli.js, dist/extension.js, dist/parseWorker.js, dist/agent-smoke.js
npm run package   # .vsix
```

Release history is in `CHANGELOG.md`.

## License

MIT License. Copyright (c) 2026 Siddartha Gonnabattula.
