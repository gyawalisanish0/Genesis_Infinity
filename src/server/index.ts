import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createEngine, type Engine } from "../core/index.js";
import { loadExperience } from "../data/loaders/experience.js";
import { getState } from "../state/index.js";
import { getScope } from "../scope/index.js";
import type { BackendConfig, ToolCallRecord } from "../ai/index.js";
import { createScheduler, type Scheduler } from "../scheduler/index.js";
import { searchGgufModels, listGgufFiles, downloadGgufModel } from "./modelCatalogue.js";
import { KNOWN_API_PROVIDERS, isKnownApiProvider, type ApiProviderId, type ConfiguredApiProvider } from "./apiProviders.js";
import { listApiModels } from "./apiModelCatalogue.js";

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
   * Server-side-only credentials for the "api" backend, one per known
   * provider (see apiProviders.ts). The frontend's model picker only ever
   * sends a provider id + `model` string — the actual baseURL/apiKey stay
   * on the server and are never accepted from or echoed to a request, so
   * the real credential can't leak through the browser or its network tab.
   * A provider absent from this map is simply unavailable to the frontend.
   */
  apiProviders?: Partial<Record<ApiProviderId, ConfiguredApiProvider>>;
  /** Where downloaded GGUF files are cached. Defaults to "models". */
  modelsDir?: string;
  /**
   * Server-side equivalent of io/cli.ts's --debug flag: logs each turn's
   * input, tool calls (name, params, result), and final narration to the
   * process's console — visible in the container logs of a deployed Space,
   * where there's otherwise no way to see what a turn actually did (unlike
   * the CLI, which prints this to the same terminal the player is using).
   */
  debug?: boolean;
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
  | {
      status: "ready";
      backend: { type: "llamaCpp"; modelPath: string } | { type: "api"; provider: ApiProviderId; model: string };
    }
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
  let scheduler: Scheduler | null = null;
  let status: BackendStatus = { status: "idle" };

  // Single-session beta (see this function's own doc comment): only one
  // turn is ever in flight at a time, so a single mutable slot is enough to
  // route a turn's tool-call events to whichever /api/turn request is
  // currently streaming it, without threading a per-request callback all
  // the way through core/'s Engine (onToolCall is bound once, at Engine
  // creation, for the Engine's whole lifetime — see core/index.ts).
  let activeTurnListener: ((call: ToolCallRecord) => void) | null = null;
  // Same pattern, for an autonomous NPC turn's own tool calls (see
  // scheduler/) — set only while runNpcTurnBroadcasting below is actually
  // running one, so a player's own turn's tool calls (already covered by
  // activeTurnListener above) are never also duplicated onto the
  // persistent /api/events stream, and vice versa.
  let npcTurnListener: ((call: ToolCallRecord) => void) | null = null;

  // Clients connected to the persistent GET /api/events stream (see
  // scheduler/'s own doc comment for why this exists) — a Set rather than
  // a single slot so a reconnect/second tab is handled for free.
  const eventClients = new Set<ServerResponse>();
  function broadcastEvent(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of eventClients) {
      try {
        client.write(frame);
      } catch {
        eventClients.delete(client);
      }
    }
  }

  async function setBackend(backend: BackendConfig, readyStatus: BackendStatus): Promise<void> {
    status = { status: "starting" };
    try {
      const previousEngine = engine;
      const previousScheduler = scheduler;
      engine = null;
      scheduler = null;
      previousScheduler?.dispose();
      if (previousEngine) await previousEngine.dispose();

      engine = await createEngine({
        experienceDir: options.experienceDir,
        dbPath: options.dbPath,
        backend,
        playerCharacterId: options.characterId,
        onToolCall: (call) => {
          if (options.debug) {
            console.log(`[debug] ${call.name}(${JSON.stringify(call.params)}) -> ${JSON.stringify(call.result)}`);
          }
          activeTurnListener?.(call);
          npcTurnListener?.(call);
        },
      });

      scheduler = createScheduler({
        dtm: engine.toolCtx.dtm,
        experienceId: engine.toolCtx.loaded.experience.id,
        timeline: engine.toolCtx.timeline,
        characterIds: engine.toolCtx.loaded.characters.map((c) => c.id),
        playerCharacterId: options.characterId,
        getScope: currentScope,
        broadcast: broadcastEvent,
        runNpcTurn: async (characterId) => {
          npcTurnListener = (call) => broadcastEvent("tool_call", { characterId, ...call });
          try {
            return await engine!.runNpcTurn(characterId);
          } finally {
            npcTurnListener = null;
          }
        },
      });

      status = readyStatus;
    } catch (error) {
      engine = null;
      scheduler = null;
      status = { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Disposes the current Engine (freeing the loaded model's RAM) and
   * returns to idle, without touching anything on disk — a previously
   * downloaded GGUF stays cached in modelsDir so reloading the same
   * profile later skips the download.
   */
  async function unloadEngine(): Promise<void> {
    const previousEngine = engine;
    const previousScheduler = scheduler;
    engine = null;
    scheduler = null;
    status = { status: "idle" };
    previousScheduler?.dispose();
    if (previousEngine) await previousEngine.dispose();
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

      if (req.method === "GET" && url.pathname === "/api/backend/providers") {
        const configured = (Object.keys(KNOWN_API_PROVIDERS) as ApiProviderId[])
          .filter((id) => options.apiProviders?.[id])
          .map((id) => ({ id, label: KNOWN_API_PROVIDERS[id].label }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(configured));
        return;
      }

      const apiModelsMatch = url.pathname.match(/^\/api\/models\/api\/([^/]+)$/);
      if (req.method === "GET" && apiModelsMatch) {
        const provider = apiModelsMatch[1]!;
        if (!isKnownApiProvider(provider) || !options.apiProviders?.[provider]) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Provider "${provider}" is not configured on this server` }));
          return;
        }
        const models = await listApiModels(provider);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(models));
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
          | { type: "api"; provider: string; model: string };

        // Reject overlapping switches rather than letting two downloads race
        // to write the same modelsDir path — observed in practice as a
        // corrupted GGUF (truncated mid-tensor) when a second request landed
        // before the first's download/load finished.
        if (status.status === "downloading" || status.status === "starting") {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "A model switch is already in progress" }));
          return;
        }

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
          if (typeof body.model !== "string" || body.model.trim() === "" || typeof body.provider !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Request body must be { type: \"api\", provider, model }" }));
            return;
          }
          if (!isKnownApiProvider(body.provider)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Unknown provider "${body.provider}"` }));
            return;
          }
          const provider = body.provider;
          const configured = options.apiProviders?.[provider];
          if (!configured) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Provider "${provider}" has no API key configured on this server` }));
            return;
          }
          const model = body.model;
          const { baseURL, apiKey } = configured;
          void setBackend(
            { type: "api", baseURL, apiKey, model },
            { status: "ready", backend: { type: "api", provider, model } },
          );
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "starting" }));
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body must have type \"llamaCpp\" or \"api\"" }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/backend/unload") {
        if (status.status === "downloading" || status.status === "starting") {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Cannot unload while a model switch is in progress" }));
          return;
        }
        await unloadEngine();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
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

      if (req.method === "GET" && url.pathname === "/api/events") {
        // Opened once at connect time and kept open for the session (see
        // scheduler/'s own doc comment) — carries only things that happen
        // *without* an in-flight request: an autonomous NPC turn's
        // turn_start/tool_call/turn_done, and your_turn signals. The
        // player's own submitted turns keep using POST /api/turn's
        // existing per-request SSE stream below, untouched — this is a
        // separate channel, not a replacement for that one.
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        eventClients.add(res);
        // Catches up a client that connects after the scheduler already
        // broadcast your_turn to nobody — the very first armNext() fires
        // almost immediately (everyone seeded due "now"), typically before
        // the frontend has even had a chance to open this connection (see
        // scheduler/'s own doc comment on isWaitingOnPlayer).
        if (scheduler?.isWaitingOnPlayer()) {
          res.write(`event: your_turn\ndata: ${JSON.stringify({ characterId: options.characterId })}\n\n`);
        }
        req.on("close", () => eventClients.delete(res));
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
        if (options.debug) console.log(`[debug] turn input: ${JSON.stringify(input)}`);

        // Server-Sent Events instead of a single JSON reply: a turn can run
        // several tool calls before it has any narration to show, and the
        // frontend wants to render each one live (see frontend/'s tool
        // activity log) rather than only learning what happened once the
        // whole turn has already finished.
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const sendEvent = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        activeTurnListener = (call) => sendEvent("tool_call", call);
        try {
          const { narration, reasoning } = await engine.takeTurn(input);
          if (options.debug) console.log(`[debug] turn narration: ${JSON.stringify(narration)}`);
          sendEvent("done", { narration, reasoning, scope: currentScope() });
          // Reports the player's own completed turn to scheduler/ - rolls
          // their next scheduled position and re-arms whoever's due next
          // (possibly an NPC, immediately, if their turn was already due
          // and waiting - see scheduler/'s own doc comment on tie-breaking).
          scheduler?.onCharacterActed(options.characterId);
        } catch (error) {
          sendEvent("error", { error: error instanceof Error ? error.message : String(error) });
        } finally {
          activeTurnListener = null;
          res.end();
        }
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
      for (const client of eventClients) {
        client.end();
      }
      eventClients.clear();
      scheduler?.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (engine) await engine.dispose();
    },
  };
}
