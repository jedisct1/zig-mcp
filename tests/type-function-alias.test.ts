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
            throw new Error(`Builtin functions data not found at ${dataPath}`);
        }
        const data = fs.readFileSync(dataPath, "utf-8");
        return JSON.parse(data);
    }

    async loadStdApi(): Promise<StdApi> {
        const tarPath = path.join(__dirname, "..", "data", "sources.tar");
        const wasmPath = path.join(__dirname, "..", "main.wasm");

        if (!fs.existsSync(tarPath) || !fs.existsSync(wasmPath)) {
            throw new Error(`Required files not found. Please run 'npm run get-docs'`);
        }

        const tar = fs.readFileSync(tarPath);
        const wasmBuffer = fs.readFileSync(wasmPath);
        // @ts-ignore
        const wasmModule = await WebAssembly.compile(new Uint8Array(wasmBuffer));

        return await ZigDocsBase.initStdApi(wasmModule, tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength));
    }
}

describe("Type Function Alias Resolution", () => {
    let transport: MockTransport;
    let zigDocs: TestZigDocsLocal;

    beforeAll(async () => {
        zigDocs = new TestZigDocsLocal();
        transport = await setupMcpServer(zigDocs);
    }, 30000);

    it("should list members of std.array_list.ArrayListAligned (this should work)", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
                name: "list_std_members",
                arguments: {
                    parent: "std.array_list.ArrayListAligned",
                },
            },
        });

        console.log("ArrayListAligned members:", `${response.result?.content?.[0]?.text?.substring(0, 200)}...`);

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).not.toContain("No members found");
        expect(response.result.content[0].text).toContain("ArrayListAligned");
    });

    it("should list members of std.array_list.ArrayList (this currently fails)", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
                name: "list_std_members",
                arguments: {
                    parent: "std.array_list.ArrayList",
                },
            },
        });

        console.log("ArrayList members:", response.result?.content?.[0]?.text);

        // This currently fails - let's see what we get
        if (response.result.content[0].text.includes("No members found")) {
            console.log("❌ ArrayList member listing is currently broken (as expected)");
        } else {
            console.log("✅ ArrayList member listing works!");
        }
    });

    it("should get documentation for ArrayList (this should work after our previous fix)", async () => {
        const response = await transport.sendRequest({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
                name: "get_std_doc_item",
                arguments: {
                    fqn: "std.array_list.ArrayList",
                },
            },
        });

        expect(response.error).toBeUndefined();
        expect(response.result.content[0].text).not.toContain("No documentation found");
        expect(response.result.content[0].text).toContain("ArrayList");
    });
});
