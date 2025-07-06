import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const sleep = promisify(setTimeout);

describe("Integration Tests", () => {
    it("should start local MCP server successfully", async () => {
        const mcp = spawn("node", ["dist/local.js"], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        let output = "";
        let error = "";

        mcp.stdout.on("data", (data) => {
            output += data.toString();
        });

        mcp.stderr.on("data", (data) => {
            error += data.toString();
        });

        // Send MCP initialize request
        const initRequest = `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: {
                    name: "test-client",
                    version: "1.0.0",
                },
            },
        })}\n`;

        mcp.stdin.write(initRequest);

        // Wait for response
        await sleep(3000);

        mcp.kill();

        expect(error).toBe("");
        expect(output).toContain('"result"');
        expect(output).toContain('"serverInfo"');
        expect(output).toContain('"ZigDocs"');
    }, 10000);

    it("should respond to tools/list request", async () => {
        const mcp = spawn("node", ["dist/local.js"], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        let output = "";

        mcp.stdout.on("data", (data) => {
            output += data.toString();
        });

        // Initialize first
        const initRequest = `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test", version: "1.0.0" },
            },
        })}\n`;

        mcp.stdin.write(initRequest);
        await sleep(2000);

        // Request tools list
        const toolsRequest = `${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
        })}\n`;

        mcp.stdin.write(toolsRequest);
        await sleep(1000);

        mcp.kill();

        expect(output).toContain("list_builtin_functions");
        expect(output).toContain("get_builtin_function");
        expect(output).toContain("list_std_members");
        expect(output).toContain("get_std_doc_item");
    }, 15000);
});
