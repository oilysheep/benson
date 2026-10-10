import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { getConversationSession } from "openclaw/plugin-sdk/session-store-runtime";
import {
  REMINDER_TOOL_DEFINITIONS, executeReminderTool,
  resolveReminderRuntimeRoute, reminderSchemaForRuntimeRoute,
  createReminderTaskToolFactory,
} from "./contracts.js";
import { runReminderService } from "./runner.js";

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export default definePluginEntry({
  id: "benson-reminder-tool",
  name: "Benson Reminder Tool",
  description:
    "Operation-specific OpenClaw tool contracts over the deterministic Benson Reminder Service.",
  register(api) {
    const reminderServicePath = api.resolvePath("../../../../agents/reminder-service/tools/reminder-service");
    api.registerTool({ contextVersion: 2, create: createReminderTaskToolFactory({
      jsonResult, validateJsonSchemaValue,
      runReminderService: (params, signal) => runReminderService(params, signal, reminderServicePath),
    }) }, { name: 'reminder_task', optional: true });
    for (const definition of REMINDER_TOOL_DEFINITIONS) {
      api.registerTool(
        (toolContext) => {
          if (toolContext.agentId !== "reminder-service") return null;
          const runtimeRoute = resolveReminderRuntimeRoute(toolContext);
          if (!runtimeRoute) return null;
          const runtimeSchema = reminderSchemaForRuntimeRoute(definition, runtimeRoute);
          return {
            name: definition.name,
            label: definition.label,
            description: definition.description,
            parameters: runtimeSchema,
            executionMode: "sequential",
            async execute(_toolCallId, params, signal) {
              const readCurrentUserText = async () => {
                if (!toolContext.sessionKey || !toolContext.agentId) {
                  throw new Error("current Reminder session identity is unavailable");
                }
                const entries = await readVisibleSessionTranscriptMessageEntries({
                  agentId: toolContext.agentId,
                  sessionKey: toolContext.sessionKey,
                  ...(toolContext.sessionId ? { sessionId: toolContext.sessionId } : {}),
                });
                return entries
                  .filter((entry) => entry?.message?.role === "user")
                  .map((entry) => messageText(entry.message.content))
                  .join("\n");
              };
              const readOriginalUserTurns = async () => {
                const binding = getConversationSession({
                  agentId: "main",
                  channel: "whatsapp",
                  accountId: toolContext.deliveryContext.accountId,
                  kind: runtimeRoute.sourceType === "group" ? "group" : "direct",
                  peerId: runtimeRoute.sourceId,
                });
                if (!binding) throw new Error("original Main conversation binding is unavailable");
                const entries = await readVisibleSessionTranscriptMessageEntries({
                  agentId: "main",
                  sessionKey: binding.sessionKey,
                  sessionId: binding.sessionId,
                });
                return entries
                  .filter((entry) => entry?.message?.role === "user"
                    && entry.message.__openclaw?.transport?.channel === "whatsapp"
                    && entry.message.__openclaw?.senderId === runtimeRoute.senderId)
                  .map((entry) => ({ text: messageText(entry.message.content) }));
              };
              return jsonResult(
                await executeReminderTool(definition, params, signal, {
                  validateJsonSchemaValue,
                  runReminderService: (params, operationSignal) =>
                    runReminderService(params, operationSignal, reminderServicePath),
                  readCurrentUserText,
                  runtimeRoute,
                  runtimeSchema,
                  readOriginalUserTurns,
                }),
              );
            },
          };
        },
        { name: definition.name, optional: true },
      );
    }
  },
});
