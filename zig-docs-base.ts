import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface BuiltinFunction {
    func: string;
    signature: string;
    docs: string;
}

export interface StdApi {
    search: (query: string) => Array<{ name: string; kind: string; briefDoc: string }>;
    listMembers: (fqn: string) => Array<{ name: string; kind: string; briefDoc: string }>;
    resolveFqnAndKind: (fqn: string) => { resolvedFqn: string; kind: string };
    getItemDetails: (fqn: string, include_source: boolean) => { markdown: string } | null;
}

export abstract class ZigDocsBase {
    server = new McpServer({
        name: "ZigDocs",
        description: "Retrieves up-to-date documentation and code examples for Zig programming language standard library.",
        version: process.env.ZIG_VERSION || "0.15.0",
    });
    builtinFunctions: BuiltinFunction[] = [];
    stdApi: StdApi | null = null;

    abstract loadBuiltinFunctions(): Promise<BuiltinFunction[]>;
    abstract loadStdApi(): Promise<StdApi>;

    async init() {
        this.builtinFunctions = await this.loadBuiltinFunctions();
        this.stdApi = await this.loadStdApi();

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

    protected static async initStdApi(wasmModule: WebAssembly.Module, tar: ArrayBuffer): Promise<StdApi> {
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
        
        const wasmResult = await WebAssembly.instantiate(wasmModule, imports);
        const wasmInstance: WebAssembly.Instance = (wasmResult as any).instance ?? wasmResult;
        const wasmExports: Record<string, any> = wasmInstance.exports as Record<string, any>;
        const memory: WebAssembly.Memory = wasmExports.memory as WebAssembly.Memory;
        
        const tarPtr = wasmExports.alloc(tar.byteLength);
        const wasmTar = new Uint8Array(memory.buffer, tarPtr, tar.byteLength);
        wasmTar.set(new Uint8Array(tar));
        wasmExports.unpack(tarPtr, tar.byteLength);
        
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
            return unwrapString(wasmExports.decl_fqn(decl_index));
        }
        function declDocsHtmlShort(decl_index: number): string {
            return unwrapString(wasmExports.decl_docs_html(decl_index, true));
        }
        function categorizeDecl(decl_index: number): number {
            return wasmExports.categorize_decl(decl_index, 0);
        }
        function kindString(cat: number): string {
            switch (cat) {
                case 0: return "namespace";
                case 1: return "container";
                case 2: return "global_variable";
                case 3: return "function";
                case 4: return "primitive";
                case 5: return "error_set";
                case 6: return "global_const";
                case 7: return "alias";
                case 8: return "type";
                case 9: return "type_type";
                case 10: return "type_function";
                default: return "unknown";
            }
        }
        function search(query: string): Array<{ name: string; kind: string; briefDoc: string }> {
            const ignoreCase = query.toLowerCase() === query;
            const results = executeQuery(query, ignoreCase);
            return Array.from(results).map((decl_index: number) => {
                const name = fullyQualifiedName(decl_index);
                const kind = kindString(categorizeDecl(decl_index));
                const briefDoc = declDocsHtmlShort(decl_index)
                    .replace(/<[^>]+>/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
                return { name, kind, briefDoc };
            });
        }
        function findDecl(fqn: string): number | null {
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
            let decl_index: number | null = null;
            
            // Handle root/std namespace specially to show the std aliases
            if (fqn === "" || fqn === "root" || fqn === "std") {
                // Instead of using find_module_root(0) which returns the Target module,
                // we want to show the std.* aliases like std.ArrayList, std.HashMap, etc.
                // These aliases exist but are not contained in a listable namespace.
                // We'll use search to find all std.* items and present them as the std namespace
                const ignoreCase = false;
                const results = executeQuery("std.", ignoreCase);
                
                // Filter to only direct std.* items (not std.*.* items)
                const stdItems: Array<{ name: string; kind: string; briefDoc: string }> = [];
                const seenNames = new Set<string>();
                
                for (const result_index of Array.from(results)) {
                    const fullName = fullyQualifiedName(result_index);
                    
                    // Only include direct std.* items (like std.ArrayList, std.HashMap)
                    // Skip deeper nested items (like std.array_list.ArrayList)
                    if (fullName.startsWith("root.std.")) {
                        const stdName = fullName.replace(/^root\./, "");
                        const parts = stdName.split('.');
                        
                        // Only include direct children of std (std.Something, not std.Something.SomethingElse)
                        if (parts.length === 2 && !seenNames.has(stdName)) {
                            seenNames.add(stdName);
                            
                            let real_index = result_index;
                            let kind = kindString(categorizeDecl(real_index));
                            
                            // Follow alias chain
                            while (kind === "alias") {
                                wasmExports.categorize_decl(real_index, 0);
                                real_index = Number(wasmExports.get_aliasee());
                                kind = kindString(categorizeDecl(real_index));
                            }
                            
                            const briefDoc = declDocsHtmlShort(real_index)
                                .replace(/<[^>]+>/g, "")
                                .replace(/\s+/g, " ")
                                .trim();
                            
                            stdItems.push({ name: stdName, kind, briefDoc });
                        }
                    }
                }
                
                // Sort by name for consistent output
                stdItems.sort((a, b) => a.name.localeCompare(b.name));
                return stdItems;
            } else {
                // For other namespaces, try different FQN patterns
                const triedFqns: string[] = [];
                if (!fqn.startsWith("root.") && !fqn.startsWith("std.")) {
                    triedFqns.push(`root.${fqn}`);
                    triedFqns.push(`std.${fqn}`);
                    triedFqns.push(fqn);
                } else if (fqn.startsWith("std.")) {
                    triedFqns.push(fqn.replace(/^std\./, "root."));
                    triedFqns.push(fqn);
                } else {
                    triedFqns.push(fqn);
                }
                
                for (const candidate of triedFqns) {
                    decl_index = findDecl(candidate);
                    if (decl_index !== null) break;
                }
            }
            
            if (decl_index === null) return [];
            
            // Use the proper WASM function based on declaration type
            const category = categorizeDecl(decl_index);
            let members: number[];
            
            if (category === 10) { // CAT_type_function
                // For type functions, use type_fn_members instead of namespace_members
                members = unwrapSlice32(wasmExports.type_fn_members(decl_index, false));
            } else {
                // For regular namespaces and containers, use namespace_members
                members = namespaceMembers(decl_index, false);
            }
            return members.map((member_index: number) => {
                let real_index: number = member_index;
                const original_index = member_index;
                let kind = kindString(categorizeDecl(real_index));
                
                // Follow the alias chain like the original JS does
                while (kind === "alias") {
                    // Call get_aliasee() after categorizing the current member
                    wasmExports.categorize_decl(real_index, 0);
                    real_index = Number(wasmExports.get_aliasee());
                    kind = kindString(categorizeDecl(real_index));
                }
                
                // Use the original index for the name to preserve alias names in the output
                const name = fullyQualifiedName(original_index);
                const briefDoc = declDocsHtmlShort(real_index)
                    .replace(/<[^>]+>/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
                return { name, kind, briefDoc };
            });
        }
        function resolveFqnAndKind(fqn: string): { resolvedFqn: string; kind: string } {
            let decl_index: number | null = null;
            let resolvedFqn: string = fqn;
            
            // Handle root/std namespace specially - it's a virtual namespace containing aliases
            if (fqn === "" || fqn === "root" || fqn === "std") {
                // The std namespace is virtual - it's not a real declaration but contains aliases
                resolvedFqn = "std";
                return { resolvedFqn, kind: "namespace" };
            } else {
                // For other namespaces, try different FQN patterns
                const triedFqns: string[] = [];
                if (!fqn.startsWith("root.") && !fqn.startsWith("std.")) {
                    triedFqns.push(`root.${fqn}`);
                    triedFqns.push(`std.${fqn}`);
                    triedFqns.push(fqn);
                } else if (fqn.startsWith("std.")) {
                    triedFqns.push(fqn.replace(/^std\./, "root."));
                    triedFqns.push(fqn);
                } else {
                    triedFqns.push(fqn);
                }
                
                for (const candidate of triedFqns) {
                    decl_index = findDecl(candidate);
                    if (decl_index !== null) {
                        resolvedFqn = candidate;
                        break;
                    }
                }
            }
            let kind = "unknown";
            if (decl_index !== null) {
                let real_index = decl_index;
                kind = kindString(categorizeDecl(real_index));
                
                // Follow alias chain like the original JS
                while (kind === "alias") {
                    wasmExports.categorize_decl(real_index, 0);
                    real_index = Number(wasmExports.get_aliasee());
                    kind = kindString(categorizeDecl(real_index));
                }
            }
            return { resolvedFqn: resolvedFqn.replace(/^root\./, "std."), kind };
        }
        function getItemDetails(fqn: string, include_source = false): { markdown: string } | null {
            // Helper function to convert camelCase to snake_case for common Zig stdlib patterns
            function toSnakeCase(str: string): string {
                return str.replace(/[A-Z]/g, (letter, index) => {
                    return index === 0 ? letter.toLowerCase() : `_${letter.toLowerCase()}`;
                });
            }

            let decl_index: number | null = null;
            
            // Handle root/std namespace specially like the original website
            if (fqn === "" || fqn === "root" || fqn === "std") {
                // Use find_module_root(0) to get the actual root module like the original website
                decl_index = wasmExports.find_module_root(0);
            } else {
                // Build comprehensive candidate list for non-root items
                const triedFqns: string[] = [];
                
                if (!fqn.startsWith("root.") && !fqn.startsWith("std.")) {
                    triedFqns.push(`root.${fqn}`);
                    triedFqns.push(`std.${fqn}`);
                    triedFqns.push(fqn);
                } else if (fqn.startsWith("std.")) {
                    triedFqns.push(fqn.replace(/^std\./, "root."));
                    triedFqns.push(fqn);
                    
                    // Add common stdlib alias patterns for items like std.ArrayList -> std.array_list.ArrayList
                    const parts = fqn.split('.');
                    if (parts.length === 2 && parts[0] === 'std') {
                        const itemName = parts[1];
                        const snakeCaseName = toSnakeCase(itemName);
                        
                        // Try common patterns:
                        // std.ArrayList -> std.array_list.ArrayList
                        // std.HashMap -> std.hash_map.HashMap
                        if (snakeCaseName !== itemName.toLowerCase()) {
                            triedFqns.push(`root.${snakeCaseName}.${itemName}`);
                            triedFqns.push(`std.${snakeCaseName}.${itemName}`);
                        }
                    }
                } else {
                    triedFqns.push(fqn);
                }
                
                // Try to find declaration with all candidates
                for (const candidate of triedFqns) {
                    decl_index = findDecl(candidate);
                    if (decl_index !== null) {
                        break;
                    }
                }
            }

            // If still not found, try a broader search by looking through the std namespace
            if (decl_index === null && fqn.startsWith("std.")) {
                const itemName = fqn.substring(4); // Remove "std." prefix
                
                // Search through common std submodules for the item
                const commonSubmodules = [
                    'array_list', 'hash_map', 'linked_list', 'priority_queue', 
                    'segmented_list', 'multi_array_list', 'bit_set', 'enums',
                    'mem', 'fs', 'json', 'fmt', 'crypto', 'compress', 'net', 'http'
                ];
                
                for (const submodule of commonSubmodules) {
                    const candidate = `root.${submodule}.${itemName}`;
                    decl_index = findDecl(candidate);
                    if (decl_index !== null) {
                        break;
                    }
                }
            }
            
            if (decl_index === null) return null;
            
            // Follow alias chain like the original JS to get the final implementation
            let real_index: number = decl_index;
            let kind = kindString(categorizeDecl(real_index));
            const original_fqn = fullyQualifiedName(decl_index);
            
            while (kind === "alias") {
                // Call categorize_decl to set up the aliasee context
                wasmExports.categorize_decl(real_index, 0);
                real_index = Number(wasmExports.get_aliasee());
                kind = kindString(categorizeDecl(real_index));
            }
            
            // Use the resolved name but show it as the original requested name for consistency
            const resolved_name = fullyQualifiedName(real_index).replace(/^root\./, "std.");
            // For the title, prefer the original requested name if it was a std.* alias
            let display_name = resolved_name;
            
            // Check if the user requested a simple std.* name and we found it via the alias search
            if (fqn.startsWith("std.") && fqn.split('.').length === 2) {
                // User requested something like "std.ArrayList", use that as the display name
                display_name = fqn;
            } else if (original_fqn.startsWith("root.std.") && original_fqn.split('.').length === 3) {
                // Handle direct root.std.* lookups
                display_name = original_fqn.replace(/^root\./, "");
            }
            
            const doc = unwrapString(wasmExports.decl_docs_html(real_index, false))
                .replace(/<[^>]+>/g, "")
                .replace(/\s+/g, " ")
                .trim();
            let signature = "";
            if (kind === "function" || kind === "type_function") {
                signature = unwrapString(wasmExports.decl_fn_proto_html(real_index, false)).replace(/<[^>]+>/g, "");
            }
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
            let errorsMd = "";
            const errorSet = wasmExports.fn_error_set ? wasmExports.fn_error_set(real_index) : null;
            if (errorSet && errorSet !== 0) {
                const base_decl = wasmExports.fn_error_set_decl(real_index, errorSet);
                const errorSetList = unwrapSlice64(wasmExports.error_set_node_list(real_index, errorSet));
                if (errorSetList.length > 0) {
                    errorsMd = `\n**Errors:**\n${errorSetList
                        .map((errIdx: bigint) => {
                            const html = unwrapString(wasmExports.error_html(base_decl, errIdx));
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
            let exampleMd = "";
            if (wasmExports.decl_doctest_html) {
                const example = unwrapString(wasmExports.decl_doctest_html(real_index));
                if (example) {
                    exampleMd = `\n**Example usage:**\n\`\`\`zig\n${example.replace(/<[^>]+>/g, "").trim()}\n\`\`\``;
                }
            }
            let sourceMd = "";
            if (include_source && wasmExports.decl_source_html) {
                const source = unwrapString(wasmExports.decl_source_html(real_index));
                if (source) {
                    sourceMd = `\n**Source code:**\n\`\`\`zig\n${source.replace(/<[^>]+>/g, "").trim()}\n\`\`\``;
                }
            }
            let markdown = `### ${display_name} (${kind})\n`;
            if (signature) markdown += `\n\`\`\`zig\n${signature}\n\`\`\`\n`;
            if (doc) markdown += `\n${doc}\n`;
            if (paramsMd) markdown += `\n${paramsMd}\n`;
            if (errorsMd) markdown += `\n${errorsMd}\n`;
            if (exampleMd) markdown += `\n${exampleMd}\n`;
            if (sourceMd) markdown += `\n${sourceMd}\n`;
            if (kind === "namespace" || kind === "container" || kind === "type_function") {
                // For type functions, use type_fn_members, otherwise use namespace_members
                const members = (kind === "type_function") 
                    ? unwrapSlice32(wasmExports.type_fn_members(real_index, false))
                    : namespaceMembers(real_index, false);
                const types: { idx: number; real: number }[] = [];
                const namespaces: { idx: number; real: number }[] = [];
                const functions: { idx: number; real: number }[] = [];
                const values: { idx: number; real: number }[] = [];
                for (const member_index of members) {
                    let real = member_index;
                    let memberKind = kindString(categorizeDecl(real));
                    while (memberKind === "alias") {
                        // Call categorize_decl to set up the aliasee context
                        wasmExports.categorize_decl(real, 0);
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