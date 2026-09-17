import { loadConfig } from "@/config";
import { EventBus } from "@/core/events/EventBus";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { ClaudeBrain } from "@/core/brain/ClaudeBrain";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { readOnlyFileInfoTool } from "@/tools/filesystem/ReadOnlyFileInfoTool";
import { MemoryStore } from "@/memory/MemoryStore";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";

function main() {
  const config = loadConfig();

  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerTool(readOnlyFileInfoTool);

  const permissionService = new PermissionService();
  const memoryStore = new MemoryStore(config.memoryDbPath);
  const deviceRegistry = new DeviceRegistry();
  const conversation = new ConversationManager(eventBus);
  const brain = new ClaudeBrain(config.anthropicApiKey);

  const orchestrator = new Orchestrator({
    brain,
    conversation,
    toolRegistry,
    permissionService,
    eventBus,
  });

  const wsServer = new JarvisWebSocketServer();
  wsServer.start(config.port);

  eventBus.on("brain.response", ({ text, toolCallCount }) => {
    console.log(`[jarvis] brain responded (toolCalls=${toolCallCount}): ${text.slice(0, 120)}`);
  });

  console.log(`JARVIS Core listening on port ${config.port}`);
  console.log(`Registered tools: ${toolRegistry.listTools().map((t) => t.name).join(", ")}`);

  process.on("SIGINT", () => {
    memoryStore.close();
    process.exit(0);
  });

  // Exposed for future entry points (HTTP handler, CLI, tests).
  return { orchestrator, memoryStore, deviceRegistry, toolRegistry, permissionService, eventBus };
}

if (import.meta.main) {
  main();
}

export { main };
