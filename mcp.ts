import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import wasmModule from "./main.wasm";

interface BuiltinFunction {
    func: string;
    signature: string;
    docs: string;
}

interface StdApi {
    search: (query: string) => Array<{ name: string; kind: string; briefDoc: string }>;
    listMembers: (fqn: string) => Array<{ name: string; kind: string; briefDoc: string }>;
    resolveFqnAndKind: (fqn: string) => { resolvedFqn: string; kind: string };
    getItemDetails: (fqn: string, include_source: boolean) => { markdown: string } | null;
}

export class ZigDocsMcp extends McpAgent<Env> {
    server = new McpServer({
        name: "ZigDocs",
        description: "Retrieves up-to-date documentation and code examples for Zig programming language standard library.",
        version: process.env.ZIG_VERSION!,
    });
    builtinFunctions: BuiltinFunction[] = [];
    stdApi: StdApi | null = null;

    async init() {
        // Fetch builtin functions data from Cloudflare Workers assets
        this.builtinFunctions = await this.loadBuiltinFunctions();
        // Initialize stdApi for stdlib docs search
        this.stdApi = await ZigDocsMcp.loadStdApi(this.env);

        this.server.tool(
            "list_builtin_functions",
            "Lists all available Zig builtin functions. Builtin functions are provided by the compiler and are prefixed with '@'. The comptime keyword on a parameter means that the parameter must be known at compile time. Use this to discover what functions are available, then use 'get_builtin_function' to get detailed documentation.",
            {},
            async () => {
                const functionList = this.builtinFunctions.map((fn) => `- ${fn.signature}`).join("\n");
                const message = `Available ${this.builtinFunctions.length} builtin functions:\n\n${functionList}`;

                return {
                    content: [
                        {
                            type: "text",
                            text: message,
                        },
                    ],
                };
            },
        );

        this.server.tool(
            "get_builtin_function",
            "Search for Zig builtin functions by name and get their documentation, signatures, and usage information. Returns all matching functions ranked by relevance.",
            {
                function_name: z
                    .string()
                    .min(1, "Query cannot be empty")
                    .describe("Function name or keywords (e.g., '@addWithOverflow', 'overflow', 'atomic')"),
            },
            async ({ function_name }) => {
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

                // Score and rank functions based on relevance
                const scoredFunctions = this.builtinFunctions
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

                // Sort by score (highest first)
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

                // Format results
                const results = scoredFunctions.map((fn) => `**${fn.func}**\n\`\`\`zig\n${fn.signature}\n\`\`\`\n\n${fn.docs}`).join("\n\n---\n\n");

                const message = scoredFunctions.length === 1 ? results : `Found ${scoredFunctions.length} matching functions:\n\n${results}`;

                return {
                    content: [
                        {
                            type: "text",
                            text: message,
                        },
                    ],
                };
            },
        );

        // --- STD DOCS LIST MEMBERS TOOL ---
        this.server.tool(
            "list_std_members",
            "List all members (functions, types, sub-namespaces, etc.) of a given Zig stdlib namespace/type/module.\n\n" +
                "- Members can be of kind: 'namespace' (submodule), 'container' (struct/enum/union/opaque), 'function', 'type', 'global_const', etc.\n" +
                "- For 'container' and 'namespace' kinds, you can recursively call this tool with the member's name to explore its members.\n" +
                "- Use 'std.' prefix or no prefix for top-level queries (e.g., 'std.fs' or 'fs').\n" +
                "- The output uses 'std.' as the root, matching Zig's import style.\n" +
                "- Example: To list members of the File struct, call with 'std.fs.File'.\n\n" +
                "Kind summary:\n" +
                "- namespace: module or namespace block (can be explored recursively)\n" +
                "- container: struct, enum, union, or opaque (can be explored recursively)\n" +
                "- function: function (cannot be explored recursively)\n" +
                "- type: type alias or type (cannot be explored recursively)\n" +
                "- global_const: global constant (cannot be explored recursively)\n" +
                "- primitive: built-in type like u8, i32, etc. (cannot be explored recursively)\n",
            {
                parent: z.string().default("std").describe("Namespace path (e.g., 'std.fs', 'std.ArrayList', 'std.mem')"),
            },
            async ({ parent }) => {
                // Get the resolved FQN and its kind/type
                const { kind: parentKind } = this.stdApi!.resolveFqnAndKind(parent);
                const results = this.stdApi!.listMembers(parent);
                if (!results || results.length === 0) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No members found in "${parent}".`,
                            },
                        ],
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
            },
        );

        this.server.tool(
            "get_std_doc_item",
            "Get detailed documentation for a specific Zig stdlib item (function, type, struct, etc.) by fully qualified name (FQN). Returns kind, signature, full docs, parameters, errors, examples, and optionally source code.",
            {
                fqn: z.string().describe("Fully qualified name of the item (e.g., 'std.fs.File.read' or 'fs.File.read')."),
                include_source: z.boolean().optional().default(false).describe("Whether to include the full source code. Default: false."),
            },
            async ({ fqn, include_source = false }) => {
                const details = this.stdApi!.getItemDetails(fqn, include_source);
                if (!details) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No documentation found for "${fqn}".`,
                            },
                        ],
                    };
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: details.markdown,
                        },
                    ],
                };
            },
        );
    }

    private async loadBuiltinFunctions(): Promise<BuiltinFunction[]> {
        const request = new Request("https://assets.local/builtin-functions.json");
        const response = await this.env.ASSETS.fetch(request);

        if (!response.ok) {
            throw new Error("Failed to fetch builtin functions (MCP server error)");
        }

        return await response.json();
    }

    // --- STD DOCS WASM/JS LOADER ---
    static stdApiCache: any = null;
    static async loadStdApi(env: Env) {
        if (ZigDocsMcp.stdApiCache) return ZigDocsMcp.stdApiCache;
        const tarResp = await env.ASSETS.fetch(new Request("https://assets.local/sources.tar"));
        if (!tarResp.ok) {
            throw new Error("Failed to fetch Zig stdlib documentation assets (MCP server error)");
        }
        const tar = await tarResp.arrayBuffer();
        // Use statically imported wasmModule
        const stdApi = await ZigDocsMcp.initStdApi(wasmModule, tar);
        ZigDocsMcp.stdApiCache = stdApi;
        return stdApi;
    }

    static async initStdApi(wasmModule: WebAssembly.Module, tar: ArrayBuffer): Promise<StdApi> {
        const textDecoder = new TextDecoder();
        const textEncoder = new TextEncoder();
        const imports = {
            js: {
                log: (level: number, ptr: number, len: number) => {
                    // ignore logs
                },
            },
            env: {},
        };
        // Instantiate WASM using the statically imported module
        const wasmResult = await WebAssembly.instantiate(wasmModule, imports);
        const wasmInstance: WebAssembly.Instance = (wasmResult as any).instance ?? wasmResult;
        const wasmExports: Record<string, any> = wasmInstance.exports as Record<string, any>;
        const memory: WebAssembly.Memory = wasmExports.memory as WebAssembly.Memory;
        // Load sources.tar into WASM memory and call unpack
        const tarPtr = wasmExports.alloc(tar.byteLength);
        const wasmTar = new Uint8Array(memory.buffer, tarPtr, tar.byteLength);
        wasmTar.set(new Uint8Array(tar));
        wasmExports.unpack(tarPtr, tar.byteLength);
        // --- Helpers ---
        function safeBigInt(value: number | bigint): bigint {
            if (typeof value === "bigint") return value;
            return BigInt(value);
        }
        function unwrapString(ptrOrBigint: number | bigint): string {
            const big = safeBigInt(ptrOrBigint);
            const ptr = Number(big & 0xffffffffn);
            const len = Number(big >> 32n);
            if (len === 0) return "";
            return textDecoder.decode(new Uint8Array(memory.buffer, ptr, len));
        }
        function unwrapSlice32(ptrOrBigint: number | bigint): number[] {
            const big = safeBigInt(ptrOrBigint);
            const ptr = Number(big & 0xffffffffn);
            const len = Number(big >> 32n);
            if (len === 0) return [];
            return Array.from(new Uint32Array(memory.buffer, ptr, len));
        }
        function unwrapSlice64(ptrOrBigint: number | bigint): bigint[] {
            const big = safeBigInt(ptrOrBigint);
            const ptr = Number(big & 0xffffffffn);
            const len = Number(big >> 32n);
            if (len === 0) return [];
            return Array.from(new BigUint64Array(memory.buffer, ptr, len));
        }
        function setQueryString(s: string): void {
            const jsArray = textEncoder.encode(s);
            const len = jsArray.length;
            const ptr = wasmExports.query_begin(len);
            const wasmArray = new Uint8Array(memory.buffer, ptr, len);
            wasmArray.set(jsArray);
        }
        function executeQuery(query_string: string, ignore_case: boolean): Uint32Array {
            setQueryString(query_string);
            const ptr = wasmExports.query_exec(ignore_case);
            const head = new Uint32Array(memory.buffer, ptr, 1);
            const len = head[0];
            return new Uint32Array(memory.buffer, ptr + 4, len);
        }
        function fullyQualifiedName(decl_index: number): string {
            // Use the WASM export to get the FQN pointer/length pair, then unwrapString
            return unwrapString(wasmExports.decl_fqn(decl_index));
        }
        function declDocsHtmlShort(decl_index: number): string {
            return unwrapString(decl_index);
        }
        function categorizeDecl(decl_index: number): number {
            return wasmExports.categorize_decl(decl_index, 0);
        }
        // Convert category to kind string
        function kindString(cat: number): string {
            switch (cat) {
                case 0:
                    return "namespace";
                case 1:
                    return "container";
                case 2:
                    return "global_variable";
                case 3:
                    return "function";
                case 4:
                    return "primitive";
                case 5:
                    return "error_set";
                case 6:
                    return "global_const";
                case 7:
                    return "alias";
                case 8:
                    return "type";
                case 9:
                    return "type_type";
                case 10:
                    return "type_function";
                default:
                    return "unknown";
            }
        }
        // --- Search API ---
        function search(query: string): Array<{ name: string; kind: string; briefDoc: string }> {
            const ignoreCase = query.toLowerCase() === query;
            const results = executeQuery(query, ignoreCase);
            // Each result is a decl_index
            return Array.from(results).map((decl_index: number) => {
                const name = fullyQualifiedName(decl_index);
                const kind = kindString(categorizeDecl(decl_index));
                // Convert HTML doc to markdown (very basic: strip tags)
                const briefDoc = declDocsHtmlShort(decl_index)
                    .replace(/<[^>]+>/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
                return { name, kind, briefDoc };
            });
        }
        // --- List Members API ---
        function findDecl(fqn: string): number | null {
            // Set input string in WASM memory
            const jsArray = textEncoder.encode(fqn);
            const len = jsArray.length;
            const ptr = wasmExports.set_input_string(len);
            const wasmArray = new Uint8Array(memory.buffer, ptr, len);
            wasmArray.set(jsArray);
            const result = wasmExports.find_decl();
            if (result === -1) return null;
            return result;
        }
        function namespaceMembers(decl_index: number, include_private: boolean): number[] {
            return unwrapSlice32(wasmExports.namespace_members(decl_index, include_private));
        }
        function listMembers(fqn: string): Array<{ name: string; kind: string; briefDoc: string }> {
            const triedFqns: string[] = [];
            let fqnToUse: string;
            if (fqn === "" || fqn === "root" || fqn === "std") {
                fqnToUse = "root";
                triedFqns.push(fqnToUse);
            } else if (!fqn.startsWith("root.") && !fqn.startsWith("std.")) {
                triedFqns.push(`root.${fqn}`);
                triedFqns.push(`std.${fqn}`);
                triedFqns.push(fqn); // fallback
                fqnToUse = `root.${fqn}`;
            } else if (fqn.startsWith("std.")) {
                triedFqns.push(fqn.replace(/^std\./, "root."));
                triedFqns.push(fqn);
                fqnToUse = fqn.replace(/^std\./, "root.");
            } else {
                fqnToUse = fqn;
                triedFqns.push(fqnToUse);
            }
            let decl_index: number | null = null;
            for (const candidate of triedFqns) {
                decl_index = findDecl(candidate);
                if (decl_index !== null) break;
            }
            if (decl_index === null) return [];
            const members = namespaceMembers(decl_index, false);
            return members.map((member_index: number) => {
                let real_index: number = member_index;
                let kind = kindString(categorizeDecl(real_index));
                // Unwrap aliases
                while (kind === "alias") {
                    real_index = Number(wasmExports.get_aliasee());
                    kind = kindString(categorizeDecl(real_index));
                }
                const name = fullyQualifiedName(real_index); // keep the original name for navigation
                const briefDoc = declDocsHtmlShort(real_index)
                    .replace(/<[^>]+>/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
                return { name, kind, briefDoc };
            });
        }
        function resolveFqnAndKind(fqn: string): { resolvedFqn: string; kind: string } {
            const triedFqns: string[] = [];
            let fqnToUse: string;
            if (fqn === "" || fqn === "root" || fqn === "std") {
                fqnToUse = "root";
                triedFqns.push(fqnToUse);
            } else if (!fqn.startsWith("root.") && !fqn.startsWith("std.")) {
                triedFqns.push(`root.${fqn}`);
                triedFqns.push(`std.${fqn}`);
                triedFqns.push(fqn); // fallback
                fqnToUse = `root.${fqn}`;
            } else if (fqn.startsWith("std.")) {
                triedFqns.push(fqn.replace(/^std\./, "root."));
                triedFqns.push(fqn);
                fqnToUse = fqn.replace(/^std\./, "root.");
            } else {
                fqnToUse = fqn;
                triedFqns.push(fqnToUse);
            }
            let decl_index: number | null = null;
            let resolvedFqn: string = fqnToUse;
            for (const candidate of triedFqns) {
                decl_index = findDecl(candidate);
                if (decl_index !== null) {
                    resolvedFqn = candidate;
                    break;
                }
            }
            let kind = "unknown";
            if (decl_index !== null) {
                kind = kindString(categorizeDecl(decl_index));
            }
            // Remove 'root.' prefix for output
            return { resolvedFqn: resolvedFqn.replace(/^root\./, "std."), kind };
        }
        function getItemDetails(fqn: string, include_source = false): { markdown: string } | null {
            // Use the same FQN resolution logic as listMembers
            const triedFqns: string[] = [];
            let fqnToUse: string;
            if (fqn === "" || fqn === "root" || fqn === "std") {
                fqnToUse = "root";
                triedFqns.push(fqnToUse);
            } else if (!fqn.startsWith("root.") && !fqn.startsWith("std.")) {
                triedFqns.push(`root.${fqn}`);
                triedFqns.push(`std.${fqn}`);
                triedFqns.push(fqn); // fallback
                fqnToUse = `root.${fqn}`;
            } else if (fqn.startsWith("std.")) {
                triedFqns.push(fqn.replace(/^std\./, "root."));
                triedFqns.push(fqn);
                fqnToUse = fqn.replace(/^std\./, "root.");
            } else {
                fqnToUse = fqn;
                triedFqns.push(fqnToUse);
            }
            let decl_index: number | null = null;
            for (const candidate of triedFqns) {
                decl_index = findDecl(candidate);
                if (decl_index !== null) break;
            }
            if (decl_index === null) return null;
            // Unwrap aliases
            let real_index: number = decl_index;
            let kind = kindString(categorizeDecl(real_index));
            while (kind === "alias") {
                real_index = Number(wasmExports.get_aliasee());
                kind = kindString(categorizeDecl(real_index));
            }
            const name = fullyQualifiedName(real_index).replace(/^root\./, "std.");
            const doc = unwrapString(wasmExports.decl_docs_html(real_index, false))
                .replace(/<[^>]+>/g, "")
                .replace(/\s+/g, " ")
                .trim();
            let signature = "";
            if (kind === "function" || kind === "type_function") {
                signature = unwrapString(wasmExports.decl_fn_proto_html(real_index, false)).replace(/<[^>]+>/g, "");
            }
            // Parameters
            let paramsMd = "";
            const params = unwrapSlice32(wasmExports.decl_params(real_index));
            if (params.length > 0) {
                paramsMd = `\n**Parameters:**\n${params
                    .map((paramIdx: number) =>
                        unwrapString(wasmExports.decl_param_html(real_index, paramIdx))
                            .replace(/<[^>]+>/g, "")
                            .replace(/\s+/g, " ")
                            .trim(),
                    )
                    .join("\n")}`;
            }
            // Errors
            let errorsMd = "";
            const errorSet = wasmExports.fn_error_set ? wasmExports.fn_error_set(real_index) : null;
            if (errorSet && errorSet !== 0) {
                const base_decl = wasmExports.fn_error_set_decl(real_index, errorSet);
                const errorSetList = unwrapSlice64(wasmExports.error_set_node_list(real_index, errorSet));
                if (errorSetList.length > 0) {
                    errorsMd = `\n**Errors:**\n${errorSetList
                        .map((errIdx: bigint) => {
                            const html = unwrapString(wasmExports.error_html(base_decl, errIdx));
                            // Extract <dt>...</dt> and <dd>...</dd>
                            const dtMatch = html.match(/<dt>([\s\S]*?)<\/dt>/);
                            const ddMatch = html.match(/<dd>([\s\S]*?)<\/dd>/);
                            const summary = dtMatch
                                ? dtMatch[1]
                                      .replace(/<[^>]+>/g, "")
                                      .replace(/\s+/g, " ")
                                      .trim()
                                : "";
                            let desc = ddMatch
                                ? ddMatch[1]
                                      .replace(/<[^>]+>/g, "")
                                      .replace(/\s*\n/g, "\n")
                                      .replace(/\s+/g, " ")
                                      .trim()
                                : "";
                            if (desc) {
                                // Indent all lines of the description
                                desc = desc
                                    .split(/\n+/)
                                    .map((line) => (line.trim() ? `  ${line.trim()}` : ""))
                                    .join("\n");
                                return `- ${summary}\n${desc}`;
                            }
                            return `- ${summary}`;
                        })
                        .join("\n")}`;
                }
            }
            // Example usage
            let exampleMd = "";
            if (wasmExports.decl_doctest_html) {
                const example = unwrapString(wasmExports.decl_doctest_html(real_index));
                if (example) {
                    exampleMd = `\n**Example usage:**\n\`\`\`zig\n${example.replace(/<[^>]+>/g, "").trim()}\n\`\`\``;
                }
            }
            // Source code (optional)
            let sourceMd = "";
            if (include_source && wasmExports.decl_source_html) {
                const source = unwrapString(wasmExports.decl_source_html(real_index));
                if (source) {
                    sourceMd = `\n**Source code:**\n\`\`\`zig\n${source.replace(/<[^>]+>/g, "").trim()}\n\`\`\``;
                }
            }
            // Compose markdown
            let markdown = `### ${name} (${kind})\n`;
            if (signature) markdown += `\n\`\`\`zig\n${signature}\n\`\`\`\n`;
            if (doc) markdown += `\n${doc}\n`;
            if (paramsMd) markdown += `\n${paramsMd}\n`;
            if (errorsMd) markdown += `\n${errorsMd}\n`;
            if (exampleMd) markdown += `\n${exampleMd}\n`;
            if (sourceMd) markdown += `\n${sourceMd}\n`;
            if (kind === "namespace" || kind === "container") {
                const members = namespaceMembers(real_index, false);
                const types: { idx: number; real: number }[] = [];
                const namespaces: { idx: number; real: number }[] = [];
                const functions: { idx: number; real: number }[] = [];
                const values: { idx: number; real: number }[] = [];
                for (const member_index of members) {
                    let real = member_index;
                    let memberKind = kindString(categorizeDecl(real));
                    // Unwrap aliases
                    while (memberKind === "alias") {
                        real = Number(wasmExports.get_aliasee());
                        memberKind = kindString(categorizeDecl(real));
                    }
                    if (memberKind === "container" || memberKind === "type" || memberKind === "type_function")
                        types.push({ idx: member_index, real });
                    else if (memberKind === "namespace") namespaces.push({ idx: member_index, real });
                    else if (memberKind === "function") functions.push({ idx: member_index, real });
                    else values.push({ idx: member_index, real });
                }
                if (types.length) {
                    markdown += `\n#### Types\n${types.map(({ idx }) => `- [${fullyQualifiedName(idx).replace(/^root\./, "std.")}](${fullyQualifiedName(idx).replace(/^root\./, "std.")})`).join("\n")}`;
                }
                if (namespaces.length) {
                    markdown += `\n#### Namespaces\n${namespaces.map(({ idx }) => `- [${fullyQualifiedName(idx).replace(/^root\./, "std.")}](${fullyQualifiedName(idx).replace(/^root\./, "std.")})`).join("\n")}`;
                }
                if (functions.length) {
                    markdown += `\n#### Functions\n${functions
                        .map(({ idx, real }) => {
                            const sig = unwrapString(wasmExports.decl_fn_proto_html(real, false)).replace(/<[^>]+>/g, "");
                            const doc = unwrapString(wasmExports.decl_docs_html(real, true))
                                .replace(/<[^>]+>/g, "")
                                .replace(/\s+/g, " ")
                                .trim();
                            return `- **${fullyQualifiedName(idx).replace(/^root\./, "std.")}**\n  \`\`\`zig\n${sig}\n\`\`\`${doc ? `\n  ${doc}` : ""}`;
                        })
                        .join("\n")}`;
                }
                if (values.length) {
                    markdown += `\n#### Values\n${values
                        .map(({ idx, real }) => {
                            const doc = unwrapString(wasmExports.decl_docs_html(real, true))
                                .replace(/<[^>]+>/g, "")
                                .replace(/\s+/g, " ")
                                .trim();
                            return `- **${fullyQualifiedName(idx).replace(/^root\./, "std.")}**${doc ? `\n  ${doc}` : ""}`;
                        })
                        .join("\n")}`;
                }
            }
            return { markdown };
        }
        return { search, listMembers, resolveFqnAndKind, getItemDetails };
    }
}

export default {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
        const url = new URL(request.url);

        if (url.pathname === "/sse" || url.pathname === "/sse/message") {
            return ZigDocsMcp.serveSSE("/sse").fetch(request, env, ctx);
        }

        if (url.pathname === "/mcp") {
            return ZigDocsMcp.serve("/mcp").fetch(request, env, ctx);
        }

        return new Response("Not found", { status: 404 });
    },
};
