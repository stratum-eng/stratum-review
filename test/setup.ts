import { afterAll, vi } from "vitest";
import { Miniflare } from "miniflare";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Disable telemetry during unit/integration tests to prevent polluting production metrics
process.env.TELEMETRY_DISABLED = "true";

const TEST_ENV_FILES = [
  ".env.test",
  ".env.local",
  ".env",
  ".dev.vars",
  ".env.test.example",
];
const REQUIRED_TEST_ENV_KEYS = [
  "GITHUB_APP_SLUG",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "AUTH_CALLBACK_URL",
  "APP_URL",
  "DASHBOARD_ALLOWED_USERS",
  "BOT_USERNAME",
];

// Global mocks for Cloudflare environment
vi.stubGlobal("QUEUE", {
  send: async (msg: any) => {
    console.log("Mock Queue Send:", msg);
  },
});

vi.mock("cloudflare:workers", () => {
  return {
    WorkflowEntrypoint: class {},
  };
});

function parseEnvValue(value: string) {
  let trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1);
  }

  return trimmed.replace(/\\n/g, "\n");
}

function usableEnvValue(value: string | undefined) {
  return value && value !== "undefined" && value !== "null" ? value : null;
}

function loadTestEnvFromFiles() {
  const keys = new Set(REQUIRED_TEST_ENV_KEYS);

  for (const file of TEST_ENV_FILES) {
    try {
      const filePath = existsSync(path.join(repoRoot, file))
        ? path.join(repoRoot, file)
        : path.join(process.cwd(), file);
      const content = readFileSync(filePath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex === -1) continue;

        const key = trimmed.slice(0, separatorIndex).trim();
        if (keys.has(key) && process.env[key] === undefined) {
          process.env[key] = parseEnvValue(trimmed.slice(separatorIndex + 1));
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function assertRequiredTestEnv() {
  const missing = REQUIRED_TEST_ENV_KEYS.filter(
    (key) => !usableEnvValue(process.env[key]),
  );
  if (missing.length === 0) return;

  throw new Error(
    [
      `Missing required test environment variables: ${missing.join(", ")}.`,
      "Set these values in .env.test, .env.local, .env, .dev.vars, .env.test.example, or CI.",
    ].join("\n"),
  );
}

loadTestEnvFromFiles();
assertRequiredTestEnv();

// A real D1 engine for each test file, so SQL in the suite runs on what production runs. The jsdom UI
// specs never touch the database, and Miniflare cannot start in that environment.
if (typeof window === "undefined") {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(); } }",
    d1Databases: ["DB"],
    r2Buckets: ["BLOBS"],
    compatibilityFlags: ["nodejs_compat"],
  });
  const d1 = await miniflare.getD1Database("DB");
  const migrationsDir = path.join(repoRoot, "packages/db/migrations");
  for (const file of readdirSync(migrationsDir).sort()) {
    // D1 runs one statement per prepare; the migrations have no semicolons inside strings or triggers.
    const statements = readFileSync(path.join(migrationsDir, file), "utf8")
      .replace(/^\s*--.*$/gm, "")
      .split(/;\s*$/m)
      .map((statement) => statement.trim())
      .filter(Boolean);
    await d1.batch(statements.map((statement) => d1.prepare(statement)));
  }
  (globalThis as any).__TEST_D1 = d1;
  (globalThis as any).__TEST_BLOBS = await miniflare.getR2Bucket("BLOBS");
  afterAll(() => miniflare.dispose());
}

vi.setConfig({ testTimeout: 300000 });

if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("dark"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const originalConsoleWarn = console.warn;
console.warn = (...args: any[]) => {
  if (
    typeof args[0] === "string" &&
    args[0].includes(
      "The width(-1) and height(-1) of chart should be greater than 0",
    )
  ) {
    return;
  }
  originalConsoleWarn(...args);
};

const isJsonLog = (args: any[]) => {
  if (
    typeof args[0] === "string" &&
    args[0].includes('"timestamp"') &&
    args[0].includes('"level"')
  )
    return true;
  return false;
};

const originalConsoleInfo = console.info;
console.info = (...args: any[]) => {
  if (isJsonLog(args)) return;
  originalConsoleInfo(...args);
};

const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  if (isJsonLog(args)) return;
  originalConsoleError(...args);
};

const originalConsoleLog = console.log;
console.log = (...args: any[]) => {
  if (isJsonLog(args)) return;
  originalConsoleLog(...args);
};
