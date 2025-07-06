import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { ZigDocsBase, type BuiltinFunction, type StdApi } from "../zig-docs-base.js";
import { setupMcpServer, type MockTransport } from "./mcp-helpers.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

class TestZigDocsLocal extends ZigDocsBase {
    async loadBuiltinFunctions(): Promise<BuiltinFunction[]> {
        const dataPath = path.join(__dirname, "..", "data", "builtin-functions.json");

        if (!fs.existsSync(dataPath)) {
            throw new Error(`Builtin functions data not found at ${dataPath}. Please run 'npm run get-docs' to generate the documentation data.`);
        }

        const data = fs.readFileSync(dataPath, "utf-8");
        return JSON.parse(data);
    }

    async loadStdApi(): Promise<StdApi> {
        const tarPath = path.join(__dirname, "..", "data", "sources.tar");
        const wasmPath = path.join(__dirname, "..", "main.wasm");

        if (!fs.existsSync(tarPath)) {
            throw new Error(`Stdlib documentation data not found at ${tarPath}. Please run 'npm run get-docs' to generate the documentation data.`);
        }

        if (!fs.existsSync(wasmPath)) {
            throw new Error(`WASM module not found at ${wasmPath}. Please ensure main.wasm is present.`);
        }

        const tar = fs.readFileSync(tarPath);
        const wasmBuffer = fs.readFileSync(wasmPath);
        // @ts-ignore - WebAssembly.compile exists in Node.js
        const wasmModule = await WebAssembly.compile(new Uint8Array(wasmBuffer));

        return await ZigDocsBase.initStdApi(wasmModule, tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength));
    }
}

describe("Local MCP Server", () => {
    let transport: MockTransport;
    let zigDocs: TestZigDocsLocal;

    beforeAll(async () => {
        zigDocs = new TestZigDocsLocal();
        transport = await setupMcpServer(zigDocs);
    }, 30000);

    it("should initialize successfully", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test", version: "1.0.0" },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result).toBeDefined();
        expect(response.result.serverInfo.name).toBe("ZigDocs");
        expect(response.result.capabilities.tools).toBeDefined();
    });

    it("should list available tools", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
        });

        expect(response.error).toBeUndefined();
        expect(response.result.tools).toHaveLength(4);
        expect(response.result.tools.map((t: any) => t.name)).toEqual([
            "list_builtin_functions",
            "get_builtin_function",
            "list_std_members",
            "get_std_doc_item",
        ]);
    });

    it("should list builtin functions", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
                name: "list_builtin_functions",
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe("text");
        expect(response.result.content[0].text).toContain("Available");
        expect(response.result.content[0].text).toContain("builtin functions");
    });

    it("should search for builtin functions", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
                name: "get_builtin_function",
                arguments: {
                    function_name: "@addWithOverflow",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe("text");
        expect(response.result.content[0].text).toContain("@addWithOverflow");
    });

    it("should handle search for non-existent builtin function", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: {
                name: "get_builtin_function",
                arguments: {
                    function_name: "@nonExistentFunction12345",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).toContain("No builtin functions found");
    });

    it("should list std namespace members", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 6,
            method: "tools/call",
            params: {
                name: "list_std_members",
                arguments: {
                    parent: "std",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe("text");
        expect(response.result.content[0].text).toContain("Members of `std`");
        // The actual std namespace contains many items, just check for some common ones
        const text = response.result.content[0].text;
        expect(text.includes("std.") || text.includes("Target") || text.includes("Abi")).toBe(true);
    });

    it("should list std.fs members", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
                name: "list_std_members",
                arguments: {
                    parent: "std.fs",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).toContain("Members of `std.fs`");
    });

    it("should get documentation for std.mem.Allocator", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 8,
            method: "tools/call",
            params: {
                name: "get_std_doc_item",
                arguments: {
                    fqn: "std.mem.Allocator",
                    include_source: false,
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content).toHaveLength(1);
        expect(response.result.content[0].type).toBe("text");
        expect(response.result.content[0].text).toContain("std.mem.Allocator");
    });

    it("should handle invalid std doc item", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 9,
            method: "tools/call",
            params: {
                name: "get_std_doc_item",
                arguments: {
                    fqn: "std.nonExistent.InvalidItem",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).toContain("No documentation found");
    });

    it("should handle missing tool arguments gracefully", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 10,
            method: "tools/call",
            params: {
                name: "get_builtin_function",
                arguments: {},
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).toContain("Please provide a function name");
    });

    it("should handle unknown tool", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 11,
            method: "tools/call",
            params: {
                name: "unknown_tool",
            },
        });

        expect(response.error).toBeDefined();
        expect(response.error!.message).toContain("Unknown tool");
    });

    it("should resolve common stdlib aliases like std.ArrayList", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 12,
            method: "tools/call",
            params: {
                name: "get_std_doc_item",
                arguments: {
                    fqn: "std.ArrayList",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).not.toContain("No documentation found");
        expect(response.result.content[0].text).toContain("ArrayList");
        expect(response.result.content[0].text).toContain("std.array_list.ArrayList");
    });

    it("should resolve common stdlib aliases like std.HashMap", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 13,
            method: "tools/call",
            params: {
                name: "get_std_doc_item",
                arguments: {
                    fqn: "std.HashMap",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).not.toContain("No documentation found");
        expect(response.result.content[0].text).toContain("HashMap");
        expect(response.result.content[0].text).toContain("std.hash_map.HashMap");
    });
});
