# Working in this Unreal Engine project

This project is indexed by the `unreal-llm-index` MCP server. Your context window is small, so navigate the code with its tools instead of reading whole files:

1. Call `get_index` once at the start. It lists the modules, their dependencies, and every source file with the types it declares.
2. To understand a class or file, call `get_file_outline` (signatures, line numbers, and where each function is implemented) or `get_module_outline`.
3. To find something by name, call `find_symbol`. If you only know what the code does, use `search_code` with a short regex.
4. To see actual code, call `read_symbol` with a qualified name such as `UMyActor::BeginPlay`, or `read_lines` for a specific range. Fetch only the lines you need.
5. Do not read entire .h or .cpp files unless the user asks you to.

Unreal conventions: U = UObject-derived class, A = Actor, F = struct or plain class, I = interface, E = enum, T = template. UCLASS, USTRUCT, UENUM, UINTERFACE, UFUNCTION and UPROPERTY are reflection macros. `*.generated.h` files are produced by the build and are not part of the index.
