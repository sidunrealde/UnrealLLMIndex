# Changelog

All notable changes to unreal-llm-index are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-27

### Added
- `ue-llm-index build`: scans a UE project (`.uproject`, project plugins, `*.Build.cs` modules) and writes `.llm-index/` with `INDEX.md`, per-module outlines and `symbols.json`.
- Unreal-aware outline parser for headers and `.cpp` files: UCLASS/USTRUCT/UENUM/UINTERFACE types, UFUNCTION/UPROPERTY members with specifiers, delegates, export macros, access sections, and links from header declarations to their implementations.
- `ue-llm-index serve`: MCP server (stdio) with `get_index`, `get_module_outline`, `get_file_outline`, `find_symbol`, `read_symbol`, `read_lines` and `search_code`. Every result is capped at about 3k tokens, and the index refreshes when files change.
- `agent-smoke` script to test the tools end to end with a local Ollama model.
- Templates for Continue, Cline/Roo Code and an agent rules file.
