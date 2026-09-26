import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REMINDER_SERVICE_PATH = fileURLToPath(
  new URL(
    "../../../../../agents/reminder-service/tools/reminder-service",
    import.meta.url,
  ),
);

const OPERATIONS = new Set([
  "create-intent",
  "list-reminders",
  "find-reminders",
  "update-reminder",
  "pause-reminder",
  "resume-reminder",
  "delete-reminder",
]);

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function objectValue(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function updatePatch(value) {
  const input = objectValue(value, "input");
  const allowed = new Set(["recipientId", "content", "schedule", "calendar", "verbatimRequest"]);
  const unsupported = Object.keys(input).filter((field) => !allowed.has(field));
  if (unsupported.length > 0) {
    throw new Error(
      `unsupported Reminder update fields: ${unsupported.sort().join(",")}`,
    );
  }
  const patch = {};
  for (const field of ["recipientId", "content", "schedule", "calendar", "verbatimRequest"]) {
    if (Object.hasOwn(input, field)) {
      patch[field] = input[field];
    }
  }
  if (!["content", "schedule", "calendar"].some((field) => Object.hasOwn(patch, field))) {
    throw new Error("Reminder update patch must not be empty");
  }
  return patch;
}

export function buildArgv(params) {
  const operation = requiredString(params?.operation, "operation");
  if (!OPERATIONS.has(operation)) {
    throw new Error(`unsupported Reminder operation: ${operation}`);
  }

  if (operation === "create-intent") {
    return [
      operation,
      "--input-json",
      JSON.stringify(objectValue(params.input, "input")),
    ];
  }

  if (operation === "update-reminder") {
    return [
      operation,
      "--reminder-id",
      requiredString(params.reminderId, "reminderId"),
      "--requester",
      requiredString(params.requesterId, "requesterId"),
      "--input-json",
      JSON.stringify(updatePatch(params.input)),
    ];
  }

  if (["pause-reminder", "resume-reminder", "delete-reminder"].includes(operation)) {
    return [
      operation,
      "--reminder-id",
      requiredString(params.reminderId, "reminderId"),
      "--requester",
      requiredString(params.requesterId, "requesterId"),
    ];
  }

  const argv = [
    operation,
    "--requester",
    requiredString(params.requesterId, "requesterId"),
  ];
  if (operation === "list-reminders") {
    if (params.recipient !== undefined) {
      argv.push("--recipient", requiredString(params.recipient, "recipient"));
    }
    if (params.enabled !== undefined) {
      if (typeof params.enabled !== "boolean") {
        throw new Error("enabled must be boolean");
      }
      argv.push("--enabled", params.enabled ? "true" : "false");
    }
    return argv;
  }

  const filters = [
    ["reminderId", "--reminder-id"],
    ["jobId", "--job-id"],
    ["recipient", "--recipient"],
    ["text", "--text"],
  ];
  for (const [field, flag] of filters) {
    if (params[field] !== undefined) {
      argv.push(flag, requiredString(params[field], field));
    }
  }
  if (params.enabled !== undefined) {
    if (typeof params.enabled !== "boolean") {
      throw new Error("enabled must be boolean");
    }
    argv.push("--enabled", params.enabled ? "true" : "false");
  }
  return argv;
}

export function runReminderService(params, signal, servicePath = REMINDER_SERVICE_PATH) {
  const argv = buildArgv(params);
  return new Promise((resolve, reject) => {
    const child = spawn(servicePath, argv, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("Reminder operation was aborted"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("Reminder operation timed out"));
    }, 180_000);

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 8_388_608) {
        child.kill("SIGTERM");
        finish(new Error("Reminder result exceeded the 8 MiB limit"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      let value;
      try {
        value = JSON.parse(stdout.trim());
      } catch (error) {
        finish(
          new Error(
            stderr.trim() ||
              `Reminder service returned invalid JSON (exit ${code ?? "unknown"})`,
          ),
        );
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        finish(new Error("Reminder service returned a non-object result"));
        return;
      }
      if (code !== 0 && value.status !== "failure") {
        finish(
          new Error(
            stderr.trim() || `Reminder service exited ${code} without a structured failure`,
          ),
        );
        return;
      }
      finish(null, value);
    });
  });
}
