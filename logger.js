function normalizeValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeValue(item)]),
    );
  }

  return value;
}

export function redactDatabaseUrl(connectionString) {
  if (!connectionString) {
    return null;
  }

  try {
    const url = new URL(connectionString);

    if (url.password) {
      url.password = "***";
    }

    return url.toString();
  } catch {
    return "<unparseable-database-url>";
  }
}

function emit(severity, message, meta = {}) {
  const payload = {
    ...normalizeValue(meta),
    severity,
    message,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    service: process.env.K_SERVICE || process.env.SERVICE_NAME || "stdpods",
    revision: process.env.K_REVISION || null,
    component: meta.component || null,
  };

  const line = JSON.stringify(payload);

  if (severity === "ERROR") {
    console.error(line);
    return;
  }

  if (severity === "WARNING") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export function logInfo(message, meta = {}) {
  emit("INFO", message, meta);
}

export function logWarn(message, meta = {}) {
  emit("WARNING", message, meta);
}

export function logError(message, meta = {}) {
  emit("ERROR", message, meta);
}

export function installProcessHandlers(component) {
  process.on("unhandledRejection", (reason) => {
    logError("unhandled_rejection", { component, reason });
  });

  process.on("uncaughtException", (error) => {
    logError("uncaught_exception", { component, error });
    process.exit(1);
  });

  process.on("SIGTERM", () => {
    logInfo("process_sigterm_received", { component });
  });
}
