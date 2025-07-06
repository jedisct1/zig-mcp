import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ZIG_REPO = "https://github.com/ziglang/zig.git";

export async function generateZigDocs(): Promise<void> {
    // Step 1: Create temp dir
    const TEMP_DIR = mkdtempSync(join(tmpdir(), "zig-repo-"));
    console.log(`Cloning Zig repository into ${TEMP_DIR}...`);

    try {
        // Step 2: Clone Zig
        execSync(`git clone --depth 1 ${ZIG_REPO} "${TEMP_DIR}"`, { stdio: "inherit" });

        // Step 3: Extract Zig version
        const versionFile = join(TEMP_DIR, "build.zig");
        if (!existsSync(versionFile)) {
            throw new Error("Could not find build.zig file");
        }

        const buildZigContent = readFileSync(versionFile, "utf-8");
        const match = buildZigContent.match(/const zig_version: std\.SemanticVersion = \.{\s*\.major = (\d+),\s*\.minor = (\d+),\s*\.patch = (\d+)/);

        if (!match) {
            throw new Error("Failed to extract Zig version from build.zig");
        }

        const zigVersion = `${match[1]}.${match[2]}.${match[3]}`;
        console.log(`Found Zig version: ${zigVersion}`);

        // Step 4: Write .dev.vars
        writeFileSync(".dev.vars", `ZIG_VERSION=${zigVersion}\n`);
        console.log(`Updated .dev.vars with ZIG_VERSION=${zigVersion}`);

        // Step 5: Build std-docs and langref
        console.log("Building std-docs and langref...");
        execSync("zig build std-docs langref", {
            cwd: TEMP_DIR,
            stdio: "inherit",
        });

        // Step 6: Run extract-docs.ts with ZIG_DOCS_DIR
        console.log("Running extract-docs.ts...");
        process.env.ZIG_DOCS_DIR = join(TEMP_DIR, "zig-out", "doc");
        execSync("node --experimental-transform-types ./extract-docs.ts", {
            env: { ...process.env },
            stdio: "inherit",
        });

        // Step 7: Copy artifacts
        console.log("Copying main.wasm and sources.tar...");
        cpSync(join(TEMP_DIR, "zig-out", "doc", "std", "main.wasm"), "./main.wasm", { force: true });
        cpSync(join(TEMP_DIR, "zig-out", "doc", "std", "main.wasm"), "./data/main.wasm", { force: true });
        cpSync(join(TEMP_DIR, "zig-out", "doc", "std", "sources.tar"), "./data/sources.tar", { force: true });

        console.log("Done!");
    } finally {
        // Step 8: Cleanup
        rmSync(TEMP_DIR, { recursive: true, force: true });
    }
}

// Only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    generateZigDocs().catch((error) => {
        console.error("Error generating Zig docs:", error);
        process.exit(1);
    });
}
