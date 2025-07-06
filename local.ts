#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { ZigDocsBase, type BuiltinFunction, type StdApi } from "./zig-docs-base.js";
import { generateZigDocs } from "./get-zig-docs.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Parse command line arguments
const args = process.argv.slice(2);
const buildDocsLocally = args.includes("--build-zig-docs-locally");

class ZigDocsLocalMcp extends ZigDocsBase {
    private async downloadFile(url: string, filePath: string): Promise<boolean> {
        try {
            console.log(`Downloading ${url}...`);
            const response = await fetch(url);
            if (!response.ok) {
                console.log(`Failed to download ${url}: ${response.status}`);
                return false;
            }
            const buffer = await response.arrayBuffer();
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, new Uint8Array(buffer));
            console.log(`Downloaded ${url} to ${filePath}`);
            return true;
        } catch (error) {
            console.log(`Error downloading ${url}: ${error}`);
            return false;
        }
    }

    private async generateDocs(): Promise<void> {
        console.log("Generating documentation from Zig source...");
        try {
            await generateZigDocs();
            console.log("Documentation generation completed");
        } catch (error) {
            throw new Error(`Failed to generate documentation: ${error}`);
        }
    }

    private async ensureFile(filePath: string, url: string): Promise<void> {
        if (fs.existsSync(filePath)) {
            return;
        }

        if (buildDocsLocally) {
            console.log(`--build-zig-docs-locally flag set, generating ${path.basename(filePath)} from source...`);
            await this.generateDocs();
            
            if (!fs.existsSync(filePath)) {
                throw new Error(`Failed to generate ${path.basename(filePath)} from source`);
            }
        } else {
            const success = await this.downloadFile(url, filePath);
            if (!success) {
                console.log(`Failed to download ${path.basename(filePath)}, generating from source...`);
                await this.generateDocs();
                
                if (!fs.existsSync(filePath)) {
                    throw new Error(`Failed to obtain ${path.basename(filePath)} either by download or generation`);
                }
            }
        }
    }

    async loadBuiltinFunctions(): Promise<BuiltinFunction[]> {
        // Try dist directory first (when installed via npm), then current directory (development)
        let dataPath = path.join(__dirname, "data", "builtin-functions.json");
        if (!fs.existsSync(dataPath)) {
            dataPath = path.join(__dirname, "..", "data", "builtin-functions.json");
        }

        await this.ensureFile(dataPath, "https://mcp.zigwasm.org/builtin-functions.json");

        const data = fs.readFileSync(dataPath, "utf-8");
        return JSON.parse(data);
    }

    async loadStdApi(): Promise<StdApi> {
        // Try dist directory first (when installed via npm), then current directory (development)
        let tarPath = path.join(__dirname, "data", "sources.tar");
        let wasmPath = path.join(__dirname, "main.wasm");

        if (!fs.existsSync(tarPath)) {
            tarPath = path.join(__dirname, "..", "data", "sources.tar");
        }
        if (!fs.existsSync(wasmPath)) {
            wasmPath = path.join(__dirname, "..", "main.wasm");
        }

        await this.ensureFile(tarPath, "https://mcp.zigwasm.org/sources.tar");
        await this.ensureFile(wasmPath, "https://mcp.zigwasm.org/main.wasm");

        const tar = fs.readFileSync(tarPath);
        const wasmBuffer = fs.readFileSync(wasmPath);
        // @ts-ignore - WebAssembly.compile exists in Node.js
        const wasmModule = await WebAssembly.compile(new Uint8Array(wasmBuffer));

        return await ZigDocsBase.initStdApi(wasmModule, tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength));
    }
}

async function main() {
    const mcp = new ZigDocsLocalMcp();
    await mcp.init();

    const transport = new StdioServerTransport();
    await mcp.server.connect(transport);
}

main().catch((error) => {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
});
