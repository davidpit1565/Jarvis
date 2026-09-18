import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CORE_TOOLS_DIR = join(REPO_ROOT, "src", "tools");
const AGENT_TOOLS_DIR = join(REPO_ROOT, "agents", "imac", "JarvisAgent", "Sources", "JarvisAgent", "Tools");

function listFilesRecursive(dir: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, extension));
    } else if (extname(entry.name) === extension) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Every Core tool name whose definition declares `target: "device"`. */
function coreDeviceToolNames(): Set<string> {
  const names = new Set<string>();
  for (const filePath of listFilesRecursive(CORE_TOOLS_DIR, ".ts")) {
    const content = readFileSync(filePath, "utf8");
    if (!/target:\s*"device"/.test(content)) continue;
    const match = content.match(/name:\s*"([a-z_]+)"/);
    if (match) names.add(match[1]!);
  }
  return names;
}

/** Every tool name the Agent's own AgentToolRegistry actually registers. */
function agentRegisteredToolNames(): Set<string> {
  const names = new Set<string>();
  for (const filePath of listFilesRecursive(AGENT_TOOLS_DIR, ".swift")) {
    const content = readFileSync(filePath, "utf8");
    for (const match of content.matchAll(/AgentTool\(name:\s*"([a-z_]+)"/g)) {
      names.add(match[1]!);
    }
  }
  return names;
}

describe("Core <-> Agent device tool parity", () => {
  test("every Core device tool has a matching name registered in the Agent's own tool registry", () => {
    const coreNames = coreDeviceToolNames();
    const agentNames = agentRegisteredToolNames();

    const missingFromAgent = [...coreNames].filter((name) => !agentNames.has(name));
    expect(missingFromAgent).toEqual([]);
  });

  test("both sides actually found at least one device tool (a false pass would mean this test isn't checking anything)", () => {
    expect(coreDeviceToolNames().size).toBeGreaterThan(0);
    expect(agentRegisteredToolNames().size).toBeGreaterThan(0);
  });
});
