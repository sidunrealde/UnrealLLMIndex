# Unreal LLM Index

**Let any LLM in VS Code chat understand your Unreal Engine C++ project: your code, the engine it runs on, and every engine and Fab plugin.** It works with hosted models and with models you run yourself.

An Unreal project is far bigger than any context window. UE 5.8's engine source alone is about 83,000 files, over 200 million tokens. Unreal LLM Index gives the model a compact map of your project and tools to fetch exactly the class, function or lines it needs, wherever they are. It also keeps what you and the model worked out, so the next session doesn't start from zero.

## What you get

- **Your project, the engine and its plugins, all searchable.** Find a class, read a function's declaration and body, outline a file or module, or search the code. This covers your project, the engine version it uses, engine plugins, and Marketplace/Fab plugins.
- **Where things are used.** `find_references` and `callers` show who calls a function, where a delegate is bound, and which classes override a method. They understand Unreal patterns such as `AddDynamic`, `BindAction`, `Super::` and `_Implementation`.
- **Project memory.** Decisions, facts, gotchas and open tasks are saved as small notes next to your `.uproject` and shared through your repo. Each note is linked to the code it's about, shown whenever that code is read, and flagged when that code changes.
- **An evaluation kit.** Ask your model a set of questions about your project and get a report: what passed, which tools it used, how long it took, and how big the prompts got. Compare models, settings and versions on the same questions.
- **Built for Unreal.** The parser understands `UCLASS`, `UFUNCTION`, `UPROPERTY`, `*_API` macros, delegates, modules and plugins. Results rank the modules and plugins your project actually uses first.

## Works with VS Code chat, and any model

- **Agent mode:** the tools appear in the chat's tools picker automatically.
- **The Unreal agent:** pick **Unreal** in the agent list for a mode set up with the tools and how to use them.
- **`@unreal`:** a chat participant that looks things up for you, shows the code it read, and saves the conversation to memory with `/save`.

Use a Copilot model, or add your own. For example, add a self-hosted Qwen served by vLLM as a **Custom Endpoint** model. Lookup tools are read-only and run without confirmation prompts.

## Getting started

1. Install the extension and open a folder that contains a `.uproject`.
2. The project is indexed right away. The engine is indexed in the background the first time, in about 15 seconds to a minute, and kept up to date after that. To update it yourself, click **LLM Index** in the status bar and choose **Update index**.
3. In chat, ask something like `@unreal how does ACharacter::Jump reach UCharacterMovementComponent?`

Requires VS Code 1.138 or later and a chat model that supports tool calling. Windows, macOS and Linux; the engine is found through the Epic launcher, the registry, or a source build's registration.

## Learn more

- **[User guide](docs/USER_GUIDE.md):** setup, connecting your own model, every tool and command, memory, references, the evaluation kit, and troubleshooting.
- **[Design](docs/DESIGN.md):** how it works and why it's built this way.
- **[Changelog](CHANGELOG.md)**

Unreal Engine and Fab are trademarks of Epic Games. This extension is not affiliated with Epic Games. MIT License.
