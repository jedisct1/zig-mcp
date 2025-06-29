# Zig Docs MCP Server

A Model Context Protocol (MCP) server that provides up-to-date documentation for the Zig programming language standard library and builtin functions.

## Features

- **Builtin Functions**: Search and get documentation for Zig's builtin functions (e.g., `@addWithOverflow`, `@atomicLoad`)
- **Standard Library**: Browse and search the complete Zig standard library documentation
- **Real-time Updates**: Automatically fetches the latest Zig master build documentation daily
- **MCP Integration**: Works with any MCP-compatible client

## Tools

### Builtin Functions
- `list_builtin_functions` - Lists all available Zig builtin functions
- `get_builtin_function` - Search for specific builtin functions by name or keywords

### Standard Library
- `list_std_members` - List members of a namespace/module (e.g., `std.fs`, `std.ArrayList`)
- `get_std_doc_item` - Get detailed documentation for a specific item with examples and source code

## Deployment

The server is deployed as a Cloudflare Worker and automatically updates daily with the latest Zig documentation from the master branch.

## Development

```bash
npm install
```
```bash
./get-zig-docs.sh
```
```bash
npm run dev
```
