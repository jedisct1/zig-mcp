import type { ZigDocsBase } from "../zig-docs-base.js";

export interface McpRequest {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params?: any;
}

export interface McpResponse {
    jsonrpc: "2.0";
    id: number;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

export class MockTransport {
    private requestHandlers = new Map<string, (params: any) => Promise<any>>();

    onRequest(method: string, handler: (params: any) => Promise<any>) {
        this.requestHandlers.set(method, handler);
    }

    async sendRequest(request: McpRequest): Promise<McpResponse> {
        const handler = this.requestHandlers.get(request.method);
        if (!handler) {
            return {
                jsonrpc: "2.0",
                id: request.id,
                error: {
                    code: -32601,
                    message: `Method not found: ${request.method}`,
                },
            };
        }

        try {
            const result = await handler(request.params || {});
            return {
                jsonrpc: "2.0",
                id: request.id,
                result,
            };
        } catch (error) {
            return {
                jsonrpc: "2.0",
                id: request.id,
                error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : String(error),
                },
            };
        }
    }
}

export async function setupMcpServer(zigDocsImpl: ZigDocsBase): Promise<MockTransport> {
    const transport = new MockTransport();

    await zigDocsImpl.init();

    // Set up standard MCP protocol handlers
    transport.onRequest("initialize", async (params) => ({
        protocolVersion: "2024-11-05",
        capabilities: {
            tools: { listChanged: true },
        },
        serverInfo: {
            name: "ZigDocs",
            description: "Retrieves up-to-date documentation and code examples for Zig programming language standard library.",
            version: process.env.ZIG_VERSION || "0.15.0",
        },
    }));

    transport.onRequest("tools/list", async () => ({
        tools: [
            {
                name: "list_builtin_functions",
                description: "Lists all available Zig builtin functions",
            },
            {
                name: "get_builtin_function",
                description: "Search for Zig builtin functions by name and get their documentation",
                inputSchema: {
                    type: "object",
                    properties: {
                        function_name: {
                            type: "string",
                            description: "Function name or keywords",
                        },
                    },
                    required: ["function_name"],
                },
            },
            {
                name: "list_std_members",
                description: "List all members of a given Zig stdlib namespace",
                inputSchema: {
                    type: "object",
                    properties: {
                        parent: {
                            type: "string",
                            description: "Namespace path",
                            default: "std",
                        },
                    },
                },
            },
            {
                name: "get_std_doc_item",
                description: "Get detailed documentation for a specific Zig stdlib item",
                inputSchema: {
                    type: "object",
                    properties: {
                        fqn: {
                            type: "string",
                            description: "Fully qualified name of the item",
                        },
                        include_source: {
                            type: "boolean",
                            description: "Whether to include the full source code",
                            default: false,
                        },
                    },
                    required: ["fqn"],
                },
            },
        ],
    }));

    transport.onRequest("tools/call", async (params) => {
        const { name, arguments: args = {} } = params;

        // Find the tool implementation in the server
        const toolMap = new Map([
            ["list_builtin_functions", () => callBuiltinFunctionsList(zigDocsImpl)],
            ["get_builtin_function", (args: any) => callBuiltinFunctionGet(zigDocsImpl, args)],
            ["list_std_members", (args: any) => callStdMembersList(zigDocsImpl, args)],
            ["get_std_doc_item", (args: any) => callStdDocItem(zigDocsImpl, args)],
        ]);

        const toolFn = toolMap.get(name);
        if (!toolFn) {
            throw new Error(`Unknown tool: ${name}`);
        }

        return await toolFn(args);
    });

    return transport;
}

async function callBuiltinFunctionsList(impl: ZigDocsBase) {
    const functionList = impl.builtinFunctions.map((fn) => `- ${fn.signature}`).join("\n");
    const message = `Available ${impl.builtinFunctions.length} builtin functions:\n\n${functionList}`;

    return {
        content: [{ type: "text", text: message }],
    };
}

async function callBuiltinFunctionGet(impl: ZigDocsBase, { function_name }: { function_name?: string }) {
    if (!function_name) {
        return {
            content: [
                {
                    type: "text",
                    text: "Please provide a function name or keywords. Try searching for a function name like '@addWithOverflow' or keywords like 'overflow' or 'atomic'.",
                },
            ],
        };
    }

    const queryLower = function_name.toLowerCase().trim();

    if (!queryLower) {
        return {
            content: [
                {
                    type: "text",
                    text: "Please provide a function name or keywords. Try searching for a function name like '@addWithOverflow' or keywords like 'overflow' or 'atomic'.",
                },
            ],
        };
    }

    const scoredFunctions = impl.builtinFunctions
        .map((fn) => {
            const funcLower = fn.func.toLowerCase();
            let score = 0;

            if (funcLower === queryLower) score += 1000;
            else if (funcLower.startsWith(queryLower)) score += 500;
            else if (funcLower.includes(queryLower)) score += 300;

            if (score > 0) score += Math.max(0, 50 - fn.func.length);

            return { ...fn, score };
        })
        .filter((fn) => fn.score > 0);

    scoredFunctions.sort((a, b) => b.score - a.score);

    if (scoredFunctions.length === 0) {
        return {
            content: [
                {
                    type: "text",
                    text: `No builtin functions found matching "${function_name}". Try using 'list_builtin_functions' to see available functions, or refine your search terms.`,
                },
            ],
        };
    }

    const results = scoredFunctions.map((fn) => `**${fn.func}**\n\`\`\`zig\n${fn.signature}\n\`\`\`\n\n${fn.docs}`).join("\n\n---\n\n");
    const message = scoredFunctions.length === 1 ? results : `Found ${scoredFunctions.length} matching functions:\n\n${results}`;

    return {
        content: [{ type: "text", text: message }],
    };
}

async function callStdMembersList(impl: ZigDocsBase, { parent = "std" }: { parent?: string }) {
    const { kind: parentKind } = impl.stdApi!.resolveFqnAndKind(parent);
    const results = impl.stdApi!.listMembers(parent);

    if (!results || results.length === 0) {
        return {
            content: [{ type: "text", text: `No members found in "${parent}".` }],
        };
    }

    const md = results
        .map((item: { name: string; kind: string; briefDoc: string }) =>
            item.briefDoc
                ? `- **${item.name.replace(/^root\./, "std.")}** (${item.kind})\n  ${item.briefDoc}`
                : `- **${item.name.replace(/^root\./, "std.")}** (${item.kind})`,
        )
        .join("\n");

    return {
        content: [
            {
                type: "text",
                text: `Members of \`${parent.replace(/^root\./, "std.")}\` (${parentKind}):\n\n${md}`,
            },
        ],
    };
}

async function callStdDocItem(impl: ZigDocsBase, { fqn, include_source = false }: { fqn: string; include_source?: boolean }) {
    const details = impl.stdApi!.getItemDetails(fqn, include_source);

    if (!details) {
        return {
            content: [{ type: "text", text: `No documentation found for "${fqn}".` }],
        };
    }

    return {
        content: [{ type: "text", text: details.markdown }],
    };
}
