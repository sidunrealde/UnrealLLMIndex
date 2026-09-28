# Unreal LLM Index user guide

This guide covers everything the extension does and how to get the most from it with your own model. For how it works inside, see the [design document](DESIGN.md).

- [1. Getting started](#1-getting-started)
- [2. Connecting your model](#2-connecting-your-model)
- [3. Asking questions in chat](#3-asking-questions-in-chat)
- [4. The engine and plugins](#4-the-engine-and-plugins)
- [5. Finding references and callers](#5-finding-references-and-callers)
- [6. Project memory](#6-project-memory)
- [7. The evaluation kit](#7-the-evaluation-kit)
- [8. Tools reference](#8-tools-reference)
- [9. Files the extension creates](#9-files-the-extension-creates)
- [10. Settings and commands](#10-settings-and-commands)
- [11. Command line](#11-command-line)
- [12. Troubleshooting](#12-troubleshooting)

## 1. Getting started

**Requirements**
- VS Code 1.138 or later.
- A chat model that can call tools, either a Copilot model or your own (see [section 2](#2-connecting-your-model)).
- A Unreal Engine C++ project. Any engine version works, as long as the engine is installed on the machine.

**First run.** Open a folder that contains a `.uproject`. The extension then:
1. **Indexes your project** in a fraction of a second, and keeps the index up to date as you edit.
2. **Finds the engine** your project uses, from `EngineAssociation` in the `.uproject`.
3. **Indexes the engine in the background** with a progress notification. This covers the engine source, every engine plugin, and Marketplace/Fab plugins installed in the engine. It takes about 15 seconds to a minute the first time, and the index is shared by every project on that engine.
4. **Registers the tools** with VS Code chat and adds the **Unreal** agent and the `@unreal` participant.

The **LLM Index** item in the status bar shows the state. Hover over it for symbol counts and engine status, or click it to open the project map (`INDEX.md`).

**Your repository.** Add these to `.gitignore`:

```gitignore
.llm-index/
.llm-eval/results/
```

Commit `.llm-memory/`, the shared project memory, and `.llm-eval/questions.json` if you use the evaluation kit.

## 2. Connecting your model

**Copilot models** work out of the box: pick one in the chat model picker.

**Your own model**, such as a self-hosted Qwen, Llama or DeepSeek served by vLLM, SGLang, llama.cpp or LM Studio:
1. Open the chat model picker and choose to manage models.
2. Add a **Custom Endpoint** model with your server's URL. It uses the OpenAI-compatible Chat Completions API by default.
3. Turn on **tool calling**, and set the model's **context window**.
4. Select the model in chat.

**Make sure your server parses tool calls.** Without that, the model's tool calls come back as plain text and nothing happens. For Qwen 3.x on vLLM or SGLang, start the server with:

```sh
--tool-call-parser qwen3_coder --reasoning-parser qwen3
```

**Size results to your model.** Each tool result is capped at 8,000 tokens by default (`unrealLlmIndex.maxResultTokens`), and reads at 400 lines (`unrealLlmIndex.maxReadLines`):
- **Long context** (128k and up): raise the cap to 12,000–16,000 for fewer round trips.
- **Small models** (8k–32k): lower it to 2,000–4,000.
- **`0`**: `@unreal` sizes results to whichever model is selected.

To check whether a change helps your model, measure it with the [evaluation kit](#7-the-evaluation-kit).

## 3. Asking questions in chat

There are three ways in. All of them use the same tools with whichever model you pick.

### Agent mode

Switch chat to agent mode, and the **Unreal LLM Index** tools appear in the tools picker. Ask your question normally and the model decides which tools to call.

Lookup tools are read-only, so VS Code runs them without asking. Tools that save memory notes ask first; choose **Always allow** to stop the prompts.

### The Unreal agent

Pick **Unreal** in the chat's agent list. It's agent mode with the index tools selected and instructions on how to use them: start from the project map, look things up instead of reading whole files, use references before changing code, and save decisions to memory.

To customize it, run **Unreal LLM Index: Copy Unreal Agent to Workspace**. That writes `.github/agents/unreal.agent.md`, which you can edit; the built-in agent then steps aside.

### `@unreal`

Type `@unreal` followed by your question, in any chat mode:

- It starts every conversation from the project map and project memory.
- It calls tools on its own, showing each call as it goes and listing the code it read as clickable references.
- In a long conversation, it remembers what earlier answers looked at, and drops old tool results before the model's context fills up.
- Commands:
  - **`@unreal /save`** turns the conversation into memory notes, and shows each note it saves.
  - **`@unreal /memory`** lists everything in project memory.

**Questions that work well:**
- "How does `ACharacter::Jump` reach `UCharacterMovementComponent`?"
- "Where is `UHouseSubsystem::Generate` implemented, and what calls it?"
- "Which engine and Fab plugins does this project enable, and why?"
- "What would break if I change the signature of `FHouseLayout::AddRoom`?"
- "What did we decide about how walls are generated?", which is answered from memory.

## 4. The engine and plugins

**How the engine is found**, from the project's `EngineAssociation`:
- **A version such as `5.8`:** the Windows registry, the Epic launcher's install list (`LauncherInstalled.dat`), then the default install folder.
- **A GUID:** a registered source build, from the registry on Windows or `Install.ini` on macOS and Linux.
- **Empty:** the engine tree the project sits inside.

**Choosing it yourself:** run **Unreal LLM Index: Select Engine…**. It lists every install found, with a version for each valid one, and a Browse option. Or set `unrealLlmIndex.enginePath` to the folder that contains `Engine/`.

**What is indexed:**
- `Engine/Source/Runtime`, `Developer` and `Editor`.
- Every plugin under `Engine/Plugins`, including Fab/Marketplace plugins in `Engine/Plugins/Marketplace`.
- Platform extensions in `Engine/Platforms`.

Third-party libraries, programs, plugin templates, generated headers, and Blueprints and other assets are left out.

**Where the index lives:**
- **Location:** one SQLite database per engine install in your user cache, about 300 MB for UE 5.8:
  - `%LOCALAPPDATA%\unreal-llm-index` on Windows
  - `~/Library/Caches/unreal-llm-index` on macOS
  - `~/.cache/unreal-llm-index` on Linux
- **Changing it:** set `unrealLlmIndex.cacheDir`.
- **Shared:** every project and VS Code window using that engine uses the same database.
- **Read-only engine:** the engine folder itself is never written to.

**Keeping it current.** On startup the index is updated if it's more than 12 hours old, if the engine was updated, or if plugins were added. An update re-parses only files that changed. To do it by hand:
- **Sync Engine Index** updates now.
- **Rebuild Engine Index** parses everything again.
- **Clear Engine Index Cache** deletes the databases.

**What ranks first.** Engine results are ranked by what your project uses:
1. modules your `Build.cs` files depend on, and their public dependencies
2. plugins your project enables

A plugin is enabled if the `.uproject` enables it, if its descriptor says `EnabledByDefault`, or if an enabled plugin depends on it. `list_plugins` shows each plugin and why it's on.

**Searching engine code.** `search_code` with scope `engine` searches the modules and plugins your project uses. Pass `path_filter` with a module, plugin or folder name to search somewhere else, e.g. `"Engine"`, `"EnhancedInput"` or `"GameFramework"`. It uses the ripgrep that ships with VS Code.

## 5. Finding references and callers

**`find_references(name)`** lists where something is used:
- **calls**, including `Super::` calls and `Broadcast`/`Execute` of delegates
- **bindings**: `AddDynamic`, `BindAction(..., &AMyChar::Jump)`, `BindUFunction(this, "Jump")`, `GET_FUNCTION_NAME_CHECKED`
- **overrides** in subclasses, and the same function declared in a base class
- **uses** of types and properties

Each result names the function it's in. It covers your project and the engine code your project uses, or one scope with `scope`.

**`callers(name, depth)`** groups the call and binding sites by the calling function and can follow them up to three levels. For example, `DoJump ← CheckJumpInput ← ControlledCharacterMove ← …`.

**How it works, and its limits.** References are found by name, then sorted out with the parser and class hierarchy. There is no compiler involved, so:
- **Use qualified names** such as `ACharacter::Jump`. An ambiguous name gets a list of candidates.
- **Other classes' members are left out:** same-named members of unrelated classes are skipped, and counted at the end.
- **Uncertain calls are separated:** a call through a variable whose type isn't visible is listed under *Possibly unrelated* when the file doesn't mention the class or a subclass.
- **Comments and strings are hidden by default,** along with a function's name used without calling it. Pass `include_text: true` to see them.
- **Blueprints aren't covered:** calls from Blueprints aren't indexed, and results for Blueprint-exposed functions say so.
- **Common names:** for names that appear in many files, the files that look most like real calls are analyzed first. Narrow with `path_filter` if the result says files were skipped.

## 6. Project memory

The index describes the code. Memory keeps what the code doesn't say: why it's built this way, what you decided, what to watch out for, and what's left to do.

**What a note is.** A note is a `decision`, `fact`, `gotcha`, `task` or `summary`: one or two sentences, linked to the symbols or files it's about. Each note is a small Markdown file in `.llm-memory/`, next to your `.uproject`:

```md
---
id: k3f9a2
kind: decision
about: ["UHouseSubsystem::Generate"]
fingerprints: {"UHouseSubsystem::Generate": "9c1e04a1b7d2"}
created: 2026-09-29T10:12:00.000Z
updated: 2026-09-29T10:12:00.000Z
source: "@unreal"
---
Layout generation goes through UHouseSubsystem::Generate; never call FLayoutBuilder directly.
```

**How notes get saved:**
- **As the model works:** it saves notes with `remember` when you decide something together, when it learns something non-obvious, when it hits a gotcha, or when work is left unfinished.
- **`@unreal /save`:** goes back over a conversation and saves what it established, updating existing notes rather than duplicating them.
- **By hand:** you can write or edit notes yourself. A file without the header is read as a fact.

**Where notes show up:**
- **At the start of every session:** `get_index`, and `INDEX.md` for file-reading agents, list the open tasks and latest decisions.
- **Next to the code:** `read_symbol` and `get_file_outline` show notes about the code being read, including notes about a class's members when reading the class.
- **In search:** `find_symbol` marks symbols that have notes, and `recall` searches all notes by words, by the code they're about, or by kind.

**Notes that may be outdated.** Each note remembers what its code looked like when it was written; whitespace doesn't count. When that code changes, the note is marked *may be outdated*. When the code is deleted, the note says so. The model then checks the code and does one of three things:
- confirms the note with `update_note(id)`
- corrects it
- deletes it with `forget`

**Sharing with your team.** Commit `.llm-memory/`. Every note is its own file, so teammates adding notes never get merge conflicts.

To turn memory off, set `unrealLlmIndex.memory.enabled` to `false`.

## 7. The evaluation kit

The evaluation kit tells you how well your model answers questions about your project. Use it to:
- choose between models
- tune `maxResultTokens`
- check that a new version of the extension helps rather than hurts

### Writing questions

Run **Unreal LLM Index: Create Evaluation Questions**. It writes `.llm-eval/questions.json` with starter questions generated from your project, covering implementations, modules, engine base classes, callers and open tasks, plus one example to copy. Then replace the generated questions with real ones from your work, questions whose answers you know:

```json
{
  "questions": [
    {
      "id": "jump-flow",
      "question": "How does ACharacter::Jump reach UCharacterMovementComponent?",
      "expect": {
        "mentions": ["CheckJumpInput", "DoJump"],
        "notMentions": ["UPawnMovementComponent"],
        "tools": ["read_symbol"],
        "maxToolCalls": 15
      },
      "reference": "Jump sets bPressedJump; CheckJumpInput calls DoJump on the movement component.",
      "note": "Why this question matters, for people reading the file."
    }
  ]
}
```

| Field | Checks |
|---|---|
| `expect.mentions` | Each word or name appears in the answer (case-insensitive). |
| `expect.notMentions` | None of these appear: useful for a wrong class the model tends to name. |
| `expect.tools` | Each tool was called at least once. |
| `expect.maxToolCalls` | The model stayed within this many tool calls. |
| `reference` | Optional. With grading on, the model scores the answer against it from 1 to 5. |

### Running it in VS Code

Run **Unreal LLM Index: Run Evaluation**:
1. Pick a model. Any chat model set up in VS Code works, including your Custom Endpoint model, so you don't need to share any endpoint details.
2. If questions have references, choose whether to grade them.

Each question is answered through `@unreal`, exactly as in chat. Memory is read but never written during a run. The report opens when it's done.

### Running it from the command line

To test against an OpenAI-compatible endpoint directly, for example in a script:

```sh
node dist/cli.js eval run MyGame/.llm-eval/questions.json --base-url http://my-server:8000/v1 --model qwen3.6 --grade --label "8k results"
```

This uses the MCP tools instead of `@unreal`, and reports real token counts from the server.

### Reading the results

Reports are saved as Markdown and JSON in `.llm-eval/results/`. Each report shows the pass rate, average tool calls, time, largest prompt and grade. For each question it lists:
- every check, pass or fail
- the tool calls in order
- the full answer

To compare two runs, run **Compare Evaluation Results** in VS Code or `eval compare a.json b.json` on the command line. You get a table of both runs, question by question.

**Tips:**
- Ten to twenty questions from your real work say more than a hundred generated ones.
- Keep the question file fixed and change one thing at a time: the model, `maxResultTokens`, or the extension version.
- Token counts in VS Code runs are estimates, because the chat API doesn't report them. Command-line runs report the server's counts.

## 8. Tools reference

Paths can be any unique suffix, such as `Character.h` or `GameFramework/Character.h`. Engine paths start with `Engine/`. `scope` is `"project"`, `"engine"` or `"all"`.

| Tool | What it does |
|---|---|
| `get_index()` | The project map: modules and dependencies, each file's types, the engine and plugins in use, and memory's open tasks and latest decisions. |
| `get_module_outline(module, filter?)` | A module's or plugin's classes with their functions and properties. Large engine modules list folders first; pass `filter` (e.g. `"GameFramework"`). |
| `get_file_outline(path, type?)` | Every declaration in a file, with line numbers and links to implementations. `type` narrows it to one class; very long files get a compact outline. |
| `find_symbol(query, kind?, scope?, limit?)` | Find classes, functions, properties, enums or delegates by full or partial name. |
| `read_symbol(name, scope?)` | A function's declaration and body, or a type's declaration. A class too long for one read returns its member outline. |
| `read_lines(path, start, end?)` | An exact line range of a project or engine file. |
| `search_code(pattern, scope?, path_filter?, ignore_case?, max_results?)` | Regex search of the project, or of the engine code the project uses. |
| `list_plugins(query?, include_disabled?)` | Project, engine and Fab plugins: whether each is enabled and why, plus its description and modules. |
| `find_references(name, scope?, path_filter?, include_text?, limit?)` | Where something is used: calls, bindings, overrides and uses, each with the function it's in. |
| `callers(name, depth?, scope?, path_filter?)` | Which functions call or bind a function, up to 3 levels. |
| `remember(text, kind?, about?)` | Save a memory note (asks for confirmation in agent mode). |
| `recall(query?, about?, kind?, include_done?)` | Search memory, with outdated notes flagged. |
| `update_note(id, text?, kind?, about?, status?)` | Change a note or mark a task done; with only the id, confirm an outdated note. |
| `forget(id)` | Delete a note. |

## 9. Files the extension creates

| Where | What | Commit it? |
|---|---|---|
| `<project>/.llm-index/` | The project map for agents that read files: `INDEX.md`, per-module and per-file outlines, and `symbols.json`. Regenerated automatically. | No |
| `<project>/.llm-memory/` | Project memory notes, plus a `README.md` explaining the folder. | Yes |
| `<project>/.llm-eval/questions.json` | Your evaluation questions. | Yes |
| `<project>/.llm-eval/results/` | Evaluation reports. | Your choice |
| `.github/agents/unreal.agent.md` | Only if you run **Copy Unreal Agent to Workspace**. | Yes, if you customize it |
| `AGENTS.md` | Only if you run **Add Instructions to AGENTS.md**; changes a marked section only. | Yes |
| User cache | Engine indexes (see [section 4](#4-the-engine-and-plugins)). | Not in a repo |

## 10. Settings and commands

### Settings

| Setting | Default | What it does |
|---|---|---|
| `unrealLlmIndex.engine.enabled` | `true` | Index the engine and its plugins. |
| `unrealLlmIndex.engine.autoSync` | `onStartup` | `manual`: only sync when you run **Sync Engine Index**. |
| `unrealLlmIndex.enginePath` | | The engine folder, instead of the project's `EngineAssociation`. |
| `unrealLlmIndex.cacheDir` | user cache | Where engine indexes are kept. |
| `unrealLlmIndex.memory.enabled` | `true` | Keep project memory in `.llm-memory/`. |
| `unrealLlmIndex.maxResultTokens` | `8000` | Largest tool result; `0` sizes `@unreal`'s results to the model. |
| `unrealLlmIndex.maxReadLines` | `400` | Most lines per read. |
| `unrealLlmIndex.chat.maxToolRounds` | `15` | Most rounds of tool calls for one `@unreal` question. |
| `unrealLlmIndex.registerMcpServer` | `true` | Offer the tools to VS Code chat. |
| `unrealLlmIndex.writeIndexFiles` | `true` | Keep `.llm-index/` up to date. |

### Commands

All commands are in the Command Palette under **Unreal LLM Index**.

| Command | What it does |
|---|---|
| **Open INDEX.md** / **Rebuild Index** | Open or rebuild the project map. |
| **Sync Engine Index** / **Rebuild Engine Index** | Update the engine index, or parse the whole engine again. |
| **Select Engine…** | Choose which engine install to index. |
| **Clear Engine Index Cache** | Delete engine indexes; they're rebuilt when needed. |
| **Run Evaluation** / **Create Evaluation Questions** / **Compare Evaluation Results** | The evaluation kit. |
| **Copy Unreal Agent to Workspace** | Write an editable copy of the Unreal agent. |
| **Add Instructions to AGENTS.md** | Point `AGENTS.md`-reading agents at the index and memory. |

## 11. Command line

Everything also works outside VS Code with Node.js 22.13 or later. The script is `dist/cli.js`, which is in the extension's install folder or built with `npm run build`.

```sh
node dist/cli.js build   <project>                    # write .llm-index/
node dist/cli.js serve   <project>                    # MCP server on stdio, for Continue, Cline, Roo Code and others
node dist/cli.js engine  sync <project>               # build or update the engine index
node dist/cli.js engine  locate <project>             # which engine the project uses
node dist/cli.js engine  list                         # engine installs on this machine, and problems with them
node dist/cli.js tool    callers '{"name":"ACharacter::Jump","depth":2}' --project <project>
node dist/cli.js eval    init <project>               # starter evaluation questions
node dist/cli.js eval    run <questions.json> --base-url <url>/v1 --model <name> [--grade]
node dist/cli.js eval    compare <a.json> <b.json>
```

**Options:**
- `--engine <dir>` picks the engine; `--no-engine` works with the project only.
- `--cache-dir <dir>` moves the engine cache.
- `--memory-dir <dir>` moves memory; `--no-memory` turns it off.
- `--rg <path>` sets which ripgrep to use.
- `--max-result-tokens <n>` and `--max-read-lines <n>` set the size limits.

A typical MCP client configuration:

```json
{
  "mcpServers": {
    "unreal-llm-index": { "command": "node", "args": ["<path>/dist/cli.js", "serve", "<path>/MyGame"] }
  }
}
```

## 12. Troubleshooting

**"No Unreal Engine install found for EngineAssociation 5.x".**
- **Check what's actually installed:** the registry can list engine versions that are no longer installed. The message lists what was tried.
- **Install that version,** or point to another one with **Select Engine…**.
- **See every install found** with `engine list`.

**The engine index is "being built" for a long time.** Another VS Code window may be building it; it's shared, and the second window waits for the first. The **Unreal LLM Index** output channel shows progress. A full build of UE 5.8 takes about 15 seconds on a many-core machine and longer on fewer cores.

**The model doesn't call tools, or prints tool calls as text.**
- Check that tool calling is turned on for your Custom Endpoint model.
- Check that your server parses tool calls, e.g. `--tool-call-parser qwen3_coder` for Qwen on vLLM or SGLang (see [section 2](#2-connecting-your-model)).
- `@unreal` falls back to answering from the index when a model can't call tools.

**VS Code asks for confirmation on every tool call.** That should only happen for the memory tools (`remember`, `update_note`, `forget`). Choose **Always allow**. If lookup tools ask too, make sure you're on the latest version of the extension.

**Answers are cut short, or results say "[truncated …]".** Raise `unrealLlmIndex.maxResultTokens`, or ask for narrower results: pass `type` to `get_file_outline`, or `filter` to `get_module_outline`.

**A note says "may be outdated".** The code it's about changed. Ask the model to check the note, or confirm it yourself by calling `update_note` with its id.

**Folders with sample `.uproject` files get indexed**, for example test fixtures in a tools repository. The extension indexes every `.uproject` in the workspace except those under `Engine`, `Templates`, `Samples`, `Plugins`, `Intermediate`, `Binaries` and `Saved`. Open the project folder you work on rather than a parent folder.

**Using Epic's Unreal MCP as well.** UE 5.8's experimental **Unreal MCP** plugin covers the running editor: Blueprints, actors, assets and live coding. Unreal LLM Index covers C++ source and works without the editor. You can enable both in chat.
