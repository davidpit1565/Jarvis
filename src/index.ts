import { loadConfig } from "@/config";
import { EventBus } from "@/core/events/EventBus";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { ClaudeBrain } from "@/core/brain/ClaudeBrain";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import { readOnlyFileInfoTool } from "@/tools/filesystem/ReadOnlyFileInfoTool";
import { getActiveApplicationTool } from "@/tools/system/GetActiveApplicationTool";
import { MemoryStore } from "@/memory/MemoryStore";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";

function main() {
  const config = loadConfig();

  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerTool(readOnlyFileInfoTool);
  toolRegistry.registerTool(getActiveApplicationTool);

  const permissionService = new PermissionService();
  const memoryStore = new MemoryStore(config.memoryDbPath);
  const deviceRegistry = new DeviceRegistry();
  const pairingService = new PairingService();
  const deviceConnectionManager = new DeviceConnectionManager(eventBus);
  const conversation = new ConversationManager(eventBus);
  const brain = new ClaudeBrain(config.anthropicApiKey);

  const orchestrator = new Orchestrator({
    brain,
    conversation,
    toolRegistry,
    permissionService,
    eventBus,
    deviceRegistry,
    deviceConnectionManager,
  });

  const wsServer = new JarvisWebSocketServer({
    deviceRegistry,
    deviceConnectionManager,
    pairingService,
    eventBus,
    toolRegistry,
  });
  wsServer.start(config.port);

  eventBus.on("brain.response", ({ text, toolCallCount }) => {
    console.log(`[jarvis] brain responded (toolCalls=${toolCallCount}): ${text.slice(0, 120)}`);
  });

  eventBus.on("device.registered", ({ device }) => {
    console.log(`[jarvis] device registered: ${device.name} (${device.id}), pending pairing approval`);
  });

  eventBus.on("device.connected", ({ deviceId }) => {
    console.log(`[jarvis] device connected: ${deviceId}`);
  });

  eventBus.on("device.disconnected", ({ deviceId, reason }) => {
    console.log(`[jarvis] device disconnected: ${deviceId} (${reason})`);
  });

  console.log(`JARVIS Core listening on port ${config.port}`);
  console.log(`Registered tools: ${toolRegistry.listTools().map((t) => t.name).join(", ")}`);

  process.on("SIGINT", () => {
    memoryStore.close();
    process.exit(0);
  });

  runChatLoop(orchestrator);

  // Exposed for future entry points (HTTP handler, CLI, tests).
  return {
    orchestrator,
    memoryStore,
    deviceRegistry,
    pairingService,
    deviceConnectionManager,
    toolRegistry,
    permissionService,
    eventBus,
  };
}

const DEFAULT_USER_ID = "local-user";

/**
 * Minimal interactive CLI for talking to JARVIS from the same process that
 * holds the live device connections — this is what actually proves the
 * full loop (Claude -> tool decision -> permission -> device -> result ->
 * Claude -> response) end to end against a real connected device. It has
 * to live in this process, not a separate script, because the device's
 * WebSocket connection and the Orchestrator's registries only exist here.
 */
async function runChatLoop(orchestrator: Orchestrator): Promise<void> {
  console.log('\nJARVIS is ready. Type a message and press Enter (Ctrl+C to quit).\n');

  for await (const line of console) {
    const message = line.trim();
    if (!message) continue;

    try {
      const response = await orchestrator.handleUserMessage(DEFAULT_USER_ID, message);
      console.log(`\nJARVIS: ${response}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[jarvis] error handling message: ${reason}\n`);
    }
  }
}

if (import.meta.main) {
  main();
}

export { main };
