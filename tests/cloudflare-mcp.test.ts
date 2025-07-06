import { describe, it, expect, beforeAll, vi } from "vitest";
import { ZigDocsBase, type BuiltinFunction, type StdApi } from "../zig-docs-base.js";
import { setupMcpServer, type MockTransport } from "./mcp-helpers.js";

// Mock Cloudflare Workers environment
const mockBuiltinFunctions: BuiltinFunction[] = [
    {
        func: "@addWithOverflow",
        signature: "@addWithOverflow(comptime T: type, a: T, b: T) struct { T, u1 }",
        docs: "Performs addition and returns a tuple containing the result and a possible overflow bit.",
    },
    {
        func: "@atomicLoad",
        signature: "@atomicLoad(comptime T: type, ptr: *const T, comptime ordering: AtomicOrdering) T",
        docs: "Atomically loads the value stored in ptr.",
    },
];

const mockBuiltinFunctionsJson = JSON.stringify(mockBuiltinFunctions);

const mockSourcesTar = new ArrayBuffer(8);

// Mock WASM module that provides basic stdlib API
const mockWasmModule = {
    exports: {
        memory: { buffer: new ArrayBuffer(1024) },
        alloc: vi.fn(() => 0),
        unpack: vi.fn(),
        query_begin: vi.fn(() => 0),
        query_exec: vi.fn(() => 0),
        decl_fqn: vi.fn(() => 0n),
        categorize_decl: vi.fn(() => 0),
        set_input_string: vi.fn(() => 0),
        find_decl: vi.fn(() => 0),
        namespace_members: vi.fn(() => 0n),
        get_aliasee: vi.fn(() => 0),
        decl_docs_html: vi.fn(() => 0n),
        decl_fn_proto_html: vi.fn(() => 0n),
        decl_params: vi.fn(() => 0n),
        fn_error_set: vi.fn(() => 0),
        fn_error_set_decl: vi.fn(() => 0),
        error_set_node_list: vi.fn(() => 0n),
        error_html: vi.fn(() => 0n),
        decl_doctest_html: vi.fn(() => 0n),
        decl_source_html: vi.fn(() => 0n),
    },
};

// Mock the global WebAssembly.instantiate
global.WebAssembly = {
    ...global.WebAssembly,
    instantiate: vi.fn().mockResolvedValue({
        instance: mockWasmModule,
    }) as any,
};

class TestZigDocsCloudflare extends ZigDocsBase {
    constructor(private mockEnv: any) {
        super();
    }

    async loadBuiltinFunctions(): Promise<BuiltinFunction[]> {
        const request = new Request("https://assets.local/builtin-functions.json");
        const response = await this.mockEnv.ASSETS.fetch(request);

        if (!response.ok) {
            throw new Error("Failed to fetch builtin functions (MCP server error)");
        }

        return await response.json();
    }

    async loadStdApi(): Promise<StdApi> {
        const tarResp = await this.mockEnv.ASSETS.fetch(new Request("https://assets.local/sources.tar"));
        if (!tarResp.ok) {
            throw new Error("Failed to fetch Zig stdlib documentation assets (MCP server error)");
        }
        const tar = await tarResp.arrayBuffer();

        // Return a mock StdApi implementation
        return {
            search: (query: string) => [
                { name: "std.mem.Allocator", kind: "container", briefDoc: "General-purpose allocator interface" },
                { name: "std.fs.File", kind: "container", briefDoc: "File handle for I/O operations" },
            ],
            listMembers: (fqn: string) => {
                if (fqn === "std") {
                    return [
                        { name: "std.mem", kind: "namespace", briefDoc: "Memory management utilities" },
                        { name: "std.fs", kind: "namespace", briefDoc: "File system operations" },
                        { name: "std.json", kind: "namespace", briefDoc: "JSON parsing and serialization" },
                    ];
                }
                if (fqn === "std.fs") {
                    return [
                        { name: "std.fs.File", kind: "container", briefDoc: "File handle for I/O operations" },
                        { name: "std.fs.Dir", kind: "container", briefDoc: "Directory handle" },
                    ];
                }
                return [];
            },
            resolveFqnAndKind: (fqn: string) => {
                if (fqn === "std") return { resolvedFqn: "std", kind: "namespace" };
                if (fqn === "std.fs") return { resolvedFqn: "std.fs", kind: "namespace" };
                if (fqn === "std.mem.Allocator") return { resolvedFqn: "std.mem.Allocator", kind: "container" };
                return { resolvedFqn: fqn, kind: "unknown" };
            },
            getItemDetails: (fqn: string, include_source: boolean) => {
                if (fqn === "std.mem.Allocator") {
                    return {
                        markdown:
                            "### std.mem.Allocator (container)\n\n```zig\nconst Allocator = struct { ... }\n```\n\nGeneral-purpose allocator interface used throughout the Zig standard library.",
                    };
                }
                return null;
            },
        };
    }
}

describe("Cloudflare Workers MCP Server", () => {
    let transport: MockTransport;
    let zigDocs: TestZigDocsCloudflare;
    let mockEnv: any;

    beforeAll(async () => {
        // Mock Cloudflare Workers ASSETS binding
        mockEnv = {
            ASSETS: {
                fetch: vi.fn().mockImplementation((request: Request) => {
                    const url = new URL(request.url);
                    if (url.pathname === "/builtin-functions.json") {
                        return Promise.resolve({
                            ok: true,
                            json: () => Promise.resolve(mockBuiltinFunctions),
                        });
                    }
                    if (url.pathname === "/sources.tar") {
                        return Promise.resolve({
                            ok: true,
                            arrayBuffer: () => Promise.resolve(mockSourcesTar),
                        });
                    }
                    return Promise.resolve({ ok: false });
                }),
            },
        };

        zigDocs = new TestZigDocsCloudflare(mockEnv);
        transport = await setupMcpServer(zigDocs);
    });

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
    });

    it("should fetch builtin functions from Cloudflare assets", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
                name: "list_builtin_functions",
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).toContain("Available 2 builtin functions");
        expect(response.result.content[0].text).toContain("@addWithOverflow");
        expect(response.result.content[0].text).toContain("@atomicLoad");

        // Verify ASSETS.fetch was called
        expect(mockEnv.ASSETS.fetch).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://assets.local/builtin-functions.json",
            }),
        );
    });

    it("should search builtin functions", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
                name: "get_builtin_function",
                arguments: {
                    function_name: "overflow",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).toContain("@addWithOverflow");
        expect(response.result.content[0].text).toContain("Performs addition and returns a tuple");
    });

    it("should list std members using mocked stdlib API", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
                name: "list_std_members",
                arguments: {
                    parent: "std",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).toContain("Members of `std`");
        expect(response.result.content[0].text).toContain("std.mem");
        expect(response.result.content[0].text).toContain("std.fs");
        expect(response.result.content[0].text).toContain("std.json");

        // Verify sources.tar was fetched
        expect(mockEnv.ASSETS.fetch).toHaveBeenCalledWith(
            expect.objectContaining({
                url: "https://assets.local/sources.tar",
            }),
        );
    });

    it("should get documentation for stdlib items", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: {
                name: "get_std_doc_item",
                arguments: {
                    fqn: "std.mem.Allocator",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).toContain("### std.mem.Allocator (container)");
        expect(response.result.content[0].text).toContain("General-purpose allocator interface");
    });

    it("should handle asset fetch errors gracefully", async () => {
        // Create a new instance with failing ASSETS
        const failingEnv = {
            ASSETS: {
                fetch: vi.fn().mockResolvedValue({ ok: false }),
            },
        };

        const failingZigDocs = new TestZigDocsCloudflare(failingEnv);

        await expect(failingZigDocs.loadBuiltinFunctions()).rejects.toThrow("Failed to fetch builtin functions (MCP server error)");

        await expect(failingZigDocs.loadStdApi()).rejects.toThrow("Failed to fetch Zig stdlib documentation assets (MCP server error)");
    });

    it("should handle search for atomic functions", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 6,
            method: "tools/call",
            params: {
                name: "get_builtin_function",
                arguments: {
                    function_name: "atomic",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).toContain("@atomicLoad");
        expect(response.result.content[0].text).toContain("Atomically loads the value");
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
        expect(response.result.content[0].text).toContain("std.fs.File");
        expect(response.result.content[0].text).toContain("std.fs.Dir");
    });
});
