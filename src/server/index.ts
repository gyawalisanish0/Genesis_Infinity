import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { createEngine, type Engine } from "../core/index.js";
import { loadExperience, type LoadedExperience } from "../data/loaders/experience.js";
import { getState } from "../state/index.js";
import { getScope } from "../scope/index.js";
import type { BackendConfig, ToolCallRecord } from "../ai/index.js";
import { createScheduler, type Scheduler } from "../scheduler/index.js";
import { discoverPackages, importPackageZip, createCustomCharacter, type CreateCharacterInput } from "../packages/index.js";
import { searchGgufModels, listGgufFiles, downloadGgufModel } from "./modelCatalogue.js";
import { KNOWN_API_PROVIDERS, isKnownApiProvider, type ApiProviderId, type ConfiguredApiProvider } from "./apiProviders.js";
import { listApiModels } from "./apiModelCatalogue.js";

export interface ServerOptions {
  experienceDir: string;
  dbPath: string;
  /** Single-session beta: which character the one connected player controls. */
  characterId: string;
  /**
   * Where imported Experience packages are installed, and the primary
   * discovery root for GET /api/experiences. Defaults to "experiences".
   * The parent directory of `experienceDir` (e.g. "examples") is always
   * scanned as a second discovery root, so the bootstrap Experience is
   * itself listed/selectable without being copied anywhere.
   */
  experiencesDir?: string;
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
 * Reads a request body as raw bytes (for the binary .zip package upload —
 * readJsonBody above accumulates a UTF-8 string, which corrupts binary
 * data), rejecting past `maxBytes` so a runaway upload can't exhaust
 * memory before the packages/ module's own size guards ever see it.
 */
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Which character the connected player controls in a given Experience —
 * resolved fresh on every Experience select, since the server-configured
 * default (cli.ts's CHARACTER_ID) only makes sense for the Experience it
 * was deployed with. Precedence: the Experience's own `playerCharacterId`
 * declaration (content-authored, always wins when valid), then the
 * server-configured id if that character actually exists here, then the
 * first declared placement, then the first character sheet.
 */
function resolvePlayerCharacterId(loaded: LoadedExperience, configuredId: string): string {
  const sheetIds = new Set(loaded.characters.map((c) => c.id));
  const declared = loaded.experience.playerCharacterId;
  if (declared && sheetIds.has(declared)) return declared;
  if (sheetIds.has(configuredId)) return configuredId;
  const firstPlacement = loaded.experience.characters?.[0]?.characterId;
  if (firstPlacement && sheetIds.has(firstPlacement)) return firstPlacement;
  const firstSheet = loaded.characters[0]?.id;
  if (firstSheet) return firstSheet;
  throw new Error(`Experience "${loaded.experience.id}" has no characters`);
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
  const experiencesDir = options.experiencesDir ?? "experiences";
  // Discovery roots: imports land in experiencesDir; the bootstrap
  // Experience's parent (e.g. "examples") is scanned too so it's listed
  // without being copied. discoverPackages dedupes by id, first root wins.
  const experienceRoots = [experiencesDir, dirname(options.experienceDir)];

  // The current Experience is mutable server state (switchable at runtime
  // via POST /api/experiences/select), seeded from the deploy-time
  // options. Loaded once up front so /api/health can report the name even
  // before the frontend has picked a model; playerCharacterId is
  // re-resolved per Experience (see resolvePlayerCharacterId) since the
  // configured CHARACTER_ID only makes sense for the bootstrap Experience.
  const initialLoaded = await loadExperience(options.experienceDir);
  let current = {
    id: initialLoaded.experience.id,
    name: initialLoaded.experience.name,
    dir: options.experienceDir,
    dbPath: options.dbPath,
    playerCharacterId: resolvePlayerCharacterId(initialLoaded, options.characterId),
  };

  let engine: Engine | null = null;
  let scheduler: Scheduler | null = null;
  let status: BackendStatus = { status: "idle" };
  // The last successfully-applied backend, remembered so switching
  // Experiences while a model is loaded can rebuild the Engine against
  // the new Experience with the same model, without the frontend having
  // to re-pick one.
  let lastBackend: { backend: BackendConfig; readyStatus: BackendStatus } | null = null;

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
        experienceDir: current.dir,
        dbPath: current.dbPath,
        backend,
        playerCharacterId: current.playerCharacterId,
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
        playerCharacterId: current.playerCharacterId,
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
      lastBackend = { backend, readyStatus };
    } catch (error) {
      engine = null;
      scheduler = null;
      status = { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Reassigns the mutable `current` Experience/player-character slot from
   * a freshly loaded package, then — if a model is already loaded —
   * rebuilds the Engine against it with the same backend (fire-and-forget,
   * same status-polling contract as POST /api/backend). Shared by
   * POST /api/experiences/select and POST /api/experiences/:id/characters:
   * both need this exact "make this the active Experience/player" step,
   * but the create-character route always calls it unconditionally,
   * never short-circuited by an id match the way select's is — a newly
   * written character file requires the fresh `loaded` this always takes.
   */
  /** The `current` fields every /api/experiences* response echoes back — factored out so playerCharacterId isn't forgotten at a new call site. */
  function currentInfo() {
    return { id: current.id, name: current.name, playerCharacterId: current.playerCharacterId };
  }

  function applyCurrentExperience(loaded: LoadedExperience, dir: string, playerCharacterId: string): void {
    current = {
      id: loaded.experience.id,
      name: loaded.experience.name,
      dir,
      dbPath: join(dir, "dtm.sqlite"),
      playerCharacterId,
    };
    if (engine && status.status === "ready" && lastBackend) {
      void setBackend(lastBackend.backend, lastBackend.readyStatus);
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
    return getScope(engine.toolCtx.world, state, current.playerCharacterId);
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

    // `/` and `/api/health` are exempt from auth so platform health checks
    // (e.g. a Hugging Face Space probing the app port) and the frontend's
    // initial connectivity probe succeed without the key — otherwise, when
    // SERVER_API_KEY is set, the probe gets a 401, the container never reports
    // healthy, and the Space hangs at "starting" before failing.
    const url = new URL(req.url ?? "/", "http://localhost");
    const isPublicPath = url.pathname === "/" || url.pathname === "/api/health";
    if (!isPublicPath && options.apiKey && req.headers["x-api-key"] !== options.apiKey) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    try {
      // Root path: a plain 200 so a container/platform health check on the app
      // port passes. HEAD is answered with headers only.
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: "ok", service: "Genesis Infinity API", health: "/api/health" }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", experience: current.name }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/backend/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/experiences") {
        const packages = await discoverPackages(experienceRoots);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ current: currentInfo(), packages }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/experiences/select") {
        // Same in-flight guard as POST /api/backend: an Experience switch
        // rebuilds the Engine, which must not race a model download/load.
        if (status.status === "downloading" || status.status === "starting") {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "A model switch is already in progress" }));
          return;
        }
        const body = (await readJsonBody(req)) as { id?: unknown; characterId?: unknown };
        if (typeof body.id !== "string" || body.id.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body must be { id: string, characterId?: string }" }));
          return;
        }
        if (body.characterId !== undefined && typeof body.characterId !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "characterId must be a string when provided" }));
          return;
        }
        const requestedCharacterId = body.characterId;
        // Nothing to do only when BOTH the Experience and the requested
        // character (if any was named) already match current state - an
        // explicit characterId for the already-selected Experience must
        // still go through the reload below, since that's how a player
        // switches which existing character they control without leaving
        // the Experience.
        if (body.id === current.id && (requestedCharacterId === undefined || requestedCharacterId === current.playerCharacterId)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ current: currentInfo(), status }));
          return;
        }
        const packages = await discoverPackages(experienceRoots);
        const target = packages.find((p) => p.id === body.id);
        if (!target) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `No installed Experience with id "${body.id}"` }));
          return;
        }
        const loaded = await loadExperience(target.dir);
        let playerCharacterId: string;
        if (requestedCharacterId !== undefined) {
          if (!loaded.characters.some((c) => c.id === requestedCharacterId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Experience "${target.id}" has no character "${requestedCharacterId}"` }));
            return;
          }
          playerCharacterId = requestedCharacterId;
        } else {
          playerCharacterId = resolvePlayerCharacterId(loaded, options.characterId);
        }
        applyCurrentExperience(loaded, target.dir, playerCharacterId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ current: currentInfo(), status }));
        return;
      }

      const createCharacterMatch = url.pathname.match(/^\/api\/experiences\/([^/]+)\/characters$/);
      if (req.method === "POST" && createCharacterMatch) {
        // Same in-flight guard as select/backend: this also rebuilds the Engine.
        if (status.status === "downloading" || status.status === "starting") {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "A model switch is already in progress" }));
          return;
        }
        const targetId = decodeURIComponent(createCharacterMatch[1]!);
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        if (typeof body.name !== "string" || body.name.trim() === "") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body must include a non-empty { name: string }" }));
          return;
        }
        const packages = await discoverPackages(experienceRoots);
        const target = packages.find((p) => p.id === targetId);
        if (!target) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `No installed Experience with id "${targetId}"` }));
          return;
        }
        const asRecord = (value: unknown): Record<string, number> | undefined =>
          value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, number>) : undefined;
        const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
        const input: CreateCharacterInput = {
          name: body.name,
          class: asString(body.class),
          race: asString(body.race),
          background: asString(body.background),
          personality: asString(body.personality),
          tone: asString(body.tone),
          abilities: asRecord(body.abilities),
          skills: asRecord(body.skills),
        };
        try {
          const targetLoaded = await loadExperience(target.dir);
          const created = await createCustomCharacter(target.dir, targetLoaded, input);
          const reloaded = await loadExperience(target.dir);
          applyCurrentExperience(reloaded, target.dir, created.id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ current: currentInfo(), character: created, status }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/experiences/import") {
        // Cap slightly above packages/'s own uncompressed-size guard — a
        // compressed archive is never larger than its uncompressed content.
        const zipBuffer = await readRawBody(req, 60 * 1024 * 1024);
        if (zipBuffer.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body must be the .zip file's raw bytes" }));
          return;
        }
        try {
          const imported = await importPackageZip(zipBuffer, experiencesDir);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(imported));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
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
          res.write(`event: your_turn\ndata: ${JSON.stringify({ characterId: current.playerCharacterId })}\n\n`);
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
          scheduler?.onCharacterActed(current.playerCharacterId);
        } catch (error) {
          // Always logged (not gated behind options.debug) - a crashed turn
          // is exactly the kind of thing that must show up in a deployed
          // Space's container logs, the only visibility a live player's
          // session otherwise has, unlike the frontend's own error bubble
          // which is far more likely to be missed or already gone by the
          // time anyone looks.
          console.error(`[error] turn crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
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
      console.error(`[error] request to ${req.method} ${url.pathname} crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  // Bind explicitly to 0.0.0.0 (all IPv4 interfaces). Without a host, Node may
  // bind IPv6-only (::), which a container platform's IPv4 health probe can't
  // reach — leaving the Space stuck at "starting".
  await new Promise<void>((resolve) => server.listen(options.port, "0.0.0.0", resolve));
  console.log(`Genesis Infinity API server listening on 0.0.0.0:${options.port}`);

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
