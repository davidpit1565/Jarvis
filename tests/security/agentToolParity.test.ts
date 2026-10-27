import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CORE_TOOLS_DIR = join(REPO_ROOT, "src", "tools");
const AGENT_TOOLS_DIR = join(REPO_ROOT, "agents", "imac", "JarvisAgent", "Sources", "JarvisAgent", "Tools");
// The iPhone app (ios/JarvisApp/, added 2026-10-27) has its own device-side
// tool registry, same named-compiled-in-functions-only pattern as the Mac
// agent's — see its Tools/ToolRegistry.swift. A Core device tool genuinely
// scoped to one platform (e.g. OPEN_CAMERA/CLOSE_CAMERA, iPhone-only today:
// the Mac agent has no camera hardware wiring) only needs to be registered
// on the platform it actually applies to, so parity below is checked
// against the UNION of both device registries, not the Mac agent alone.
const IOS_TOOLS_DIR = join(REPO_ROOT, "ios", "JarvisApp", "Sources", "JarvisApp", "Tools");

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

/** Every tool name registered in a Swift `AgentTool(name: "...")` call under the given directory. */
function registeredToolNames(dir: string): Set<string> {
  const names = new Set<string>();
  for (const filePath of listFilesRecursive(dir, ".swift")) {
    const content = readFileSync(filePath, "utf8");
    for (const match of content.matchAll(/AgentTool\(name:\s*"([a-z_]+)"/g)) {
      names.add(match[1]!);
    }
  }
  return names;
}

/** Every tool name the Mac agent's own AgentToolRegistry actually registers. */
function agentRegisteredToolNames(): Set<string> {
  return registeredToolNames(AGENT_TOOLS_DIR);
}

/** Every tool name the iPhone app's own AgentToolRegistry actually registers. */
function iosRegisteredToolNames(): Set<string> {
  return registeredToolNames(IOS_TOOLS_DIR);
}

describe("Core <-> Agent device tool parity", () => {
  test("every Core device tool has a matching name registered in at least one device's own tool registry (Mac agent or iPhone app)", () => {
    const coreNames = coreDeviceToolNames();
    const deviceNames = new Set([...agentRegisteredToolNames(), ...iosRegisteredToolNames()]);

    const missingFromEveryDevice = [...coreNames].filter((name) => !deviceNames.has(name));
    expect(missingFromEveryDevice).toEqual([]);
  });

  test("every side actually found at least one device tool (a false pass would mean this test isn't checking anything)", () => {
    expect(coreDeviceToolNames().size).toBeGreaterThan(0);
    expect(agentRegisteredToolNames().size).toBeGreaterThan(0);
    expect(iosRegisteredToolNames().size).toBeGreaterThan(0);
  });
});
