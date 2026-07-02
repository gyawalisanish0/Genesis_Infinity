import { createServer, type IncomingMessage } from "node:http";
import { createEngine } from "../core/index.js";
import { getState } from "../state/index.js";
import { getScope } from "../scope/index.js";
import type { BackendConfig } from "../ai/index.js";

export interface ServerOptions {
  experienceDir: string;
  dbPath: string;
  backend: BackendConfig;
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
}

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
 * character, for the lifetime of the process.
 */
export async function startServer(options: ServerOptions): Promise<{ close: () => Promise<void> }> {
  const engine = await createEngine({
    experienceDir: options.experienceDir,
    dbPath: options.dbPath,
    backend: options.backend,
  });

  function currentScope() {
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
        res.end(JSON.stringify({ status: "ok", experience: engine.loaded.experience.name }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/scope") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(currentScope()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/turn") {
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
      await engine.dispose();
    },
  };
}
