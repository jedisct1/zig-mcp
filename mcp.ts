import { McpAgent } from "agents/mcp";
import wasmModule from "./main.wasm";
import { ZigDocsBase, type BuiltinFunction, type StdApi } from "./zig-docs-base.js";

export class ZigDocsMcp extends McpAgent<Env> {
    private zigDocs: ZigDocsCloudflareImpl = new ZigDocsCloudflareImpl(this);

    async init() {
        await this.zigDocs.init();
    }

    get server(): typeof this.zigDocs.server {
        return this.zigDocs.server;
    }
}

class ZigDocsCloudflareImpl extends ZigDocsBase {
    constructor(private mcpAgent: McpAgent<Env>) {
        super();
    }

    async init() {
        await super.init();
    }

    async loadBuiltinFunctions(): Promise<BuiltinFunction[]> {
        const request = new Request("https://assets.local/builtin-functions.json");
        const response = await (this.mcpAgent as any).env.ASSETS.fetch(request, {
            cf: {
                cacheEverything: true,
            },
        });

        if (!response.ok) {
            throw new Error("Failed to fetch builtin functions (MCP server error)");
        }

        return await response.json();
    }

    private static stdApiCache: StdApi | null = null;
    async loadStdApi(): Promise<StdApi> {
        if (ZigDocsCloudflareImpl.stdApiCache) return ZigDocsCloudflareImpl.stdApiCache;
        const tarResp = await (this.mcpAgent as any).env.ASSETS.fetch(new Request("https://assets.local/sources.tar"), {
            cf: {
                cacheEverything: true,
            },
        });
        if (!tarResp.ok) {
            throw new Error("Failed to fetch Zig stdlib documentation assets (MCP server error)");
        }
        const tar = await tarResp.arrayBuffer();
        const stdApi = await ZigDocsBase.initStdApi(wasmModule, tar);
        ZigDocsCloudflareImpl.stdApiCache = stdApi;
        return stdApi;
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
