import { createServer, type IncomingMessage } from "node:http";
import { createEngine, type Engine } from "../core/index.js";
import { loadExperience } from "../data/loaders/experience.js";
import { getState } from "../state/index.js";
import { getScope } from "../scope/index.js";
import type { BackendConfig } from "../ai/index.js";
import { searchGgufModels, listGgufFiles, downloadGgufModel } from "./modelCatalogue.js";

export interface ServerOptions {
  experienceDir: string;
  dbPath: string;
  /** Single-session beta: which character the one connected player controls. */
  characterId: string;
  port: number;
  /**
   * Shared secret checked against the X-Api-Key request header. This is a
   * public HTTP endpoint sitting in front of a real, cost-incurring model
   * call — without this, anyone who finds the URL could drive turns on
   * your account's quota. Omit only for fully local/private testing.
   */
  apiKey?: string;
  /** Allowed CORS origin (e.g. the GitHub Pages URL serving frontend/). "*" allows any origin. */
  corsOrigin: string;
  /**
   * Server-side-only credentials for the "api" backend. The frontend's
   * model picker only ever sends a `model` id string — baseURL/apiKey stay
   * on the server and are never accepted from or echoed to a request, so
   * the real credential can't leak through the browser or its network tab.
   */
  apiBackendDefaults?: { baseURL: string; apiKey: string };
  /** Where downloaded GGUF files are cached. Defaults to "models". */
  modelsDir?: string;
}

/**
 * The server boots with no Engine and waits for the frontend's first
 * POST /api/backend — model/backend choice is made live from the browser
 * rather than fixed at deploy time (see modelCatalogue.ts).
 */
export type BackendStatus =
  | { status: "idle" }
  | { status: "downloading"; repoId: string; filename: string }
  | { status: "starting" }
  | { status: "ready"; backend: { type: "llamaCpp"; modelPath: string } | { type: "api"; model: string } }
  | { status: "error"; message: string };

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Starts a minimal HTTP API in front of a single core/ Engine instance —
 * the bridge between frontend/'s static UI and the engine, since core/'s
 * Engine was previously only ever driven directly from io/cli.ts's stdin
 * loop. Single-session beta scope: one Engine, one player-controlled
 * character, for the lifetime of the process. The Engine itself is
 * created lazily, once the frontend picks a backend/model over
 * POST /api/backend, rather than fixed at startup.
 */
export async function startServer(options: ServerOptions): Promise<{ close: () => Promise<void> }> {
  const modelsDir = options.modelsDir ?? "models";

  // Experience metadata (name, characters, world) doesn't depend on a
  // backend — loaded once up front so /api/health can report it even
  // before the frontend has picked a model.
  const experienceName = (await loadExperience(options.experienceDir)).experience.name;

  let engine: Engine | null = null;
  let status: BackendStatus = { status: "idle" };

  async function setBackend(backend: BackendConfig, readyStatus: BackendStatus): Promise<void> {
    status = { status: "starting" };
    try {
      const previousEngine = engine;
      engine = null;
      if (previousEngine) await previousEngine.dispose();

      engine = await createEngine({
        experienceDir: options.experienceDir,
        dbPath: options.dbPath,
        backend,
      });
      status = readyStatus;
    } catch (error) {
      engine = null;
      status = { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  function currentScope() {
    if (!engine) throw new Error("No model configured yet");
    const state = getState(
      engine.toolCtx.dtm,
      engine.toolCtx.loaded,
      engine.toolCtx.world,
      engine.currentTurn(),
      engine.toolCtx.timeline.currentUnit(),
    );
    return getScope(engine.toolCtx.world, state, options.characterId);
  }

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", options.corsOrigin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // /api/health is exempt from auth so uptime checks / the frontend's
    // initial connectivity probe don't need the key.
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/health" && options.apiKey && req.headers["x-api-key"] !== options.apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", experience: experienceName }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/backend/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/models/search") {
        const query = url.searchParams.get("q") ?? "";
        const results = await searchGgufModels(query);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(results));
        return;
      }

      const filesMatch = url.pathname.match(/^\/api\/models\/(.+)\/files$/);
      if (req.method === "GET" && filesMatch) {
        const repoId = decodeURIComponent(filesMatch[1]);
        const files = await listGgufFiles(repoId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(files));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/backend") {
        const body = (await readJsonBody(req)) as
          | { type: "llamaCpp"; repoId: string; filename: string }
          | { type: "api"; model: string };

        if (body.type === "llamaCpp") {
          if (typeof body.repoId !== "string" || typeof body.filename !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Request body must be { type: \"llamaCpp\", repoId, filename }" }));
            return;
          }
          const repoId = body.repoId;
          const filename = body.filename;
          status = { status: "downloading", repoId, filename };
          // Fire-and-forget: downloads + model load can take minutes, so the
          // frontend polls GET /api/backend/status rather than blocking here.
          void (async () => {
            try {
              const modelPath = await downloadGgufModel(repoId, filename, modelsDir);
              await setBackend({ type: "llamaCpp", modelPath }, { status: "ready", backend: { type: "llamaCpp", modelPath } });
            } catch (error) {
              status = { status: "error", message: error instanceof Error ? error.message : String(error) };
            }
          })();
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify(status));
          return;
        }

        if (body.type === "api") {
          if (typeof body.model !== "string" || body.model.trim() === "") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Request body must be { type: \"api\", model }" }));
            return;
          }
          if (!options.apiBackendDefaults) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "This server has no api backend credentials configured" }));
            return;
          }
          const model = body.model;
          const { baseURL, apiKey } = options.apiBackendDefaults;
          void setBackend({ type: "api", baseURL, apiKey, model }, { status: "ready", backend: { type: "api", model } });
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "starting" }));
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body must have type \"llamaCpp\" or \"api\"" }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/scope") {
        if (!engine || status.status !== "ready") {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No model configured yet" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(currentScope()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/turn") {
        if (!engine || status.status !== "ready") {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No model configured yet" }));
          return;
        }
        const body = await readJsonBody(req);
        const input = (body as { input?: unknown }).input;
        if (typeof input !== "string" || input.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body must be { input: string }" }));
          return;
        }
        const narration = await engine.takeTurn(input);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ narration, scope: currentScope() }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port, resolve));
  console.log(`Genesis Infinity API server listening on port ${options.port}`);

  return {
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (engine) await engine.dispose();
    },
  };
}
