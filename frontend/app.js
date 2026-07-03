const STORAGE_KEY = "genesis-infinity-connection";
const PROFILES_KEY = "genesis-infinity-model-profiles";

const el = {
  statusDot: document.getElementById("status-dot"),
  experienceName: document.getElementById("experience-name"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  sendBtn: document.getElementById("send-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsDialog: document.getElementById("settings-dialog"),
  settingsForm: document.getElementById("settings-form"),
  settingsCancel: document.getElementById("settings-cancel"),
  settingBaseUrl: document.getElementById("setting-base-url"),
  settingApiKey: document.getElementById("setting-api-key"),
  settingCharacterId: document.getElementById("setting-character-id"),
  modelBtn: document.getElementById("model-btn"),
  modelDot: document.getElementById("model-dot"),
  modelStatusText: document.getElementById("model-status-text"),
  modelDialog: document.getElementById("model-dialog"),
  modelDialogStatus: document.getElementById("model-dialog-status"),
  modelDialogClose: document.getElementById("model-dialog-close"),
  tabLocal: document.getElementById("tab-local"),
  tabApi: document.getElementById("tab-api"),
  panelLocal: document.getElementById("panel-local"),
  panelApi: document.getElementById("panel-api"),
  modelSearchForm: document.getElementById("model-search-form"),
  modelSearchInput: document.getElementById("model-search-input"),
  modelSearchResults: document.getElementById("model-search-results"),
  modelFileSection: document.getElementById("model-file-section"),
  modelSelectedRepo: document.getElementById("model-selected-repo"),
  modelFileResults: document.getElementById("model-file-results"),
  modelApiForm: document.getElementById("model-api-form"),
  modelApiProvider: document.getElementById("model-api-provider"),
  modelApiSelectWrap: document.getElementById("model-api-select-wrap"),
  modelApiSelectLabel: document.getElementById("model-api-select-label"),
  modelApiModelSelect: document.getElementById("model-api-model-select"),
  modelApiManualLabel: document.getElementById("model-api-manual-label"),
  modelApiInput: document.getElementById("model-api-input"),
  modelApiNone: document.getElementById("model-api-none"),
  modelProfilesList: document.getElementById("model-profiles-list"),
  modelUnloadBtn: document.getElementById("model-unload-btn"),
  sidebarEmpty: document.getElementById("sidebar-empty"),
  sidebarContent: document.getElementById("sidebar-content"),
  charName: document.getElementById("char-name"),
  charSub: document.getElementById("char-sub"),
  hpValue: document.getElementById("hp-value"),
  hpFill: document.getElementById("hp-fill"),
  acValue: document.getElementById("ac-value"),
  nodeName: document.getElementById("node-name"),
  nodeDesc: document.getElementById("node-desc"),
  inventoryList: document.getElementById("inventory-list"),
  othersList: document.getElementById("others-list"),
};

let connection = null; // { baseUrl, apiKey, characterId }

function loadConnection() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveConnection(value) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

// Model profiles - saved per-browser (like connection settings), one entry
// per distinct model the user has loaded (local GGUF or API), so switching
// back later doesn't require re-searching. Sanitized the same way
// modelCatalogue.ts's downloadGgufModel sanitizes a filename onto disk, so
// a profile can be matched against the server's reported modelPath.
function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function profileId(profile) {
  return profile.type === "llamaCpp"
    ? `llamaCpp:${profile.repoId}/${profile.filename}`
    : `api:${profile.provider}:${profile.model}`;
}

function loadProfiles() {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveProfiles(profiles) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

function upsertProfile(profile) {
  const profiles = loadProfiles();
  const id = profileId(profile);
  const existing = profiles.findIndex((p) => profileId(p) === id);
  const entry = { ...profile, lastUsed: Date.now() };
  if (existing >= 0) profiles[existing] = entry;
  else profiles.push(entry);
  saveProfiles(profiles);
  return entry;
}

function removeProfile(id) {
  saveProfiles(loadProfiles().filter((p) => profileId(p) !== id));
}

function setStatus(state) {
  el.statusDot.classList.remove("connected", "error");
  if (state === "connected") el.statusDot.classList.add("connected");
  if (state === "error") el.statusDot.classList.add("error");
}

let selectedRepo = null;
let statusPollTimer = null;
let wasReady = false;
let modelSwitchInFlight = false;
let pendingLocalRepo = null; // { repoId, filename } set right before a llamaCpp switch is requested
let autoOpenedModelDialog = false; // reset per connect() - guides a fresh connection straight to model selection

function describeBackendStatus(status) {
  switch (status.status) {
    case "idle":
      return "No model";
    case "downloading":
      return `Downloading ${status.filename}…`;
    case "starting":
      return "Starting…";
    case "ready":
      return status.backend.type === "llamaCpp"
        ? status.backend.modelPath.split("/").pop()
        : `${status.backend.provider}: ${status.backend.model}`;
    case "error":
      return "Model error";
  }
}

function applyBackendStatus(status) {
  el.modelDot.classList.remove("connected", "downloading", "starting", "error");
  if (status.status === "ready") el.modelDot.classList.add("connected");
  if (status.status === "downloading" || status.status === "starting") {
    el.modelDot.classList.add(status.status);
  }
  if (status.status === "error") el.modelDot.classList.add("error");

  el.modelStatusText.textContent = describeBackendStatus(status);
  el.modelDialogStatus.textContent = `Status: ${describeBackendStatus(status)}${
    status.status === "error" ? ` — ${status.message}` : ""
  }`;

  if (status.status === "ready" || status.status === "error") {
    modelSwitchInFlight = false;
  }

  if (status.status === "idle" && !autoOpenedModelDialog) {
    autoOpenedModelDialog = true;
    openModelDialog();
  }

  const isReady = status.status === "ready";
  el.input.disabled = !isReady;
  el.sendBtn.disabled = !isReady;
  el.modelUnloadBtn.disabled = !isReady;

  if (isReady && !wasReady) {
    apiFetch(`/api/scope?characterId=${encodeURIComponent(connection.characterId)}`)
      .then(renderScope)
      .catch(() => {});
    addMessage(`Model ready: ${describeBackendStatus(status)}`, "system");
    recordProfileFromStatus(status);
  }
  wasReady = isReady;
  renderProfiles(status);
}

// Called only once a switch actually reaches "ready" - an attempt that
// errors out never gets saved as a profile.
function recordProfileFromStatus(status) {
  if (status.backend.type === "llamaCpp" && pendingLocalRepo) {
    const expectedBasename = sanitizeFilename(pendingLocalRepo.filename);
    if (status.backend.modelPath.endsWith(expectedBasename)) {
      upsertProfile({
        type: "llamaCpp",
        repoId: pendingLocalRepo.repoId,
        filename: pendingLocalRepo.filename,
        displayName: `${pendingLocalRepo.repoId} / ${pendingLocalRepo.filename}`,
      });
    }
  } else if (status.backend.type === "api") {
    upsertProfile({
      type: "api",
      provider: status.backend.provider,
      model: status.backend.model,
      displayName: `${status.backend.provider}: ${status.backend.model}`,
    });
  }
  pendingLocalRepo = null;
}

function isProfileActive(profile, status) {
  if (status.status !== "ready") return false;
  if (profile.type === "llamaCpp") {
    return status.backend.type === "llamaCpp" && status.backend.modelPath.endsWith(sanitizeFilename(profile.filename));
  }
  return status.backend.type === "api" && status.backend.provider === profile.provider && status.backend.model === profile.model;
}

function renderProfiles(status) {
  const profiles = loadProfiles().sort((a, b) => b.lastUsed - a.lastUsed);
  el.modelProfilesList.innerHTML = "";
  if (profiles.length === 0) {
    el.modelProfilesList.innerHTML = '<li class="empty">No saved models yet - load one below to save it.</li>';
    return;
  }
  for (const profile of profiles) {
    const id = profileId(profile);
    const li = document.createElement("li");
    if (isProfileActive(profile, status)) li.classList.add("selected");

    const label = document.createElement("span");
    label.className = "profile-label";
    const badge = document.createElement("span");
    badge.className = "profile-badge";
    badge.textContent = profile.type === "llamaCpp" ? "Local" : "API";
    const name = document.createElement("span");
    name.textContent = profile.displayName;
    label.append(badge, name);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "profile-remove";
    removeBtn.setAttribute("aria-label", "Remove saved model");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      removeProfile(id);
      pollBackendStatus();
    });

    li.append(label, removeBtn);
    li.addEventListener("click", () => {
      if (profile.type === "llamaCpp") loadLocalModel(profile.repoId, profile.filename);
      else useApiModel(profile.provider, profile.model);
    });
    el.modelProfilesList.appendChild(li);
  }
}

async function pollBackendStatus() {
  try {
    const status = await apiFetch("/api/backend/status");
    applyBackendStatus(status);
  } catch {
    // Connection issue — leave the last-known status displayed.
  }
}

function startStatusPolling() {
  if (statusPollTimer) return;
  pollBackendStatus();
  statusPollTimer = setInterval(pollBackendStatus, 3000);
}

function addMessage(text, kind) {
  const div = document.createElement("div");
  div.className = `message ${kind}`;
  div.textContent = text;
  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
  return div;
}

// A narrator bubble shown the instant a turn is submitted, before any
// tool call or narration exists yet - replaced in place (see the composer
// submit handler) once the turn's "done" event arrives, so the player
// always has feedback that the Engine is working rather than a dead gap.
function addPendingMessage() {
  const div = document.createElement("div");
  div.className = "message narrator pending";
  div.innerHTML =
    '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
  return div;
}

function describeToolCall(call) {
  return `${call.name}(${JSON.stringify(call.params)})`;
}

// A live, Codex/Claude-Code-style feed of this turn's tool calls - starts
// hidden and expanded, revealed on the first tool_call event and filled in
// as more arrive, then collapsed (not removed) once the turn's "done"
// event lands so the activity stays inspectable without cluttering the
// transcript by default.
function addToolLog() {
  const details = document.createElement("details");
  details.className = "tool-log hidden";
  details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = "Tool calls (0)";
  const list = document.createElement("ul");
  details.append(summary, list);
  el.messages.appendChild(details);
  return { details, summary, list };
}

function appendToolLogEntry(log, call) {
  log.details.classList.remove("hidden");
  const li = document.createElement("li");
  li.textContent = describeToolCall(call);
  log.list.appendChild(li);
  log.summary.textContent = `Tool calls (${log.list.children.length})`;
  el.messages.scrollTop = el.messages.scrollHeight;
}

// Reasoning models (e.g. DeepSeek R1) emit a chain-of-thought alongside
// their narration (see ai/index.ts's extractReasoning) - shown as a
// collapsed-by-default block right before the narration bubble it
// produced, rather than either hiding it entirely or leaking it inline.
function addReasoningBlock(text, beforeNode) {
  const details = document.createElement("details");
  details.className = "reasoning-block";
  const summary = document.createElement("summary");
  summary.textContent = "Thinking";
  const body = document.createElement("div");
  body.className = "reasoning-text";
  body.textContent = text;
  details.append(summary, body);
  el.messages.insertBefore(details, beforeNode);
  return details;
}

/**
 * Streams a turn over Server-Sent Events. Can't use the browser's native
 * EventSource here - it's GET-only with no request body or custom headers,
 * and /api/turn needs POST (a JSON body) plus the X-Api-Key header - so
 * this reads the fetch response's body stream directly and splits it into
 * SSE frames by hand. `handlers` maps event name -> callback(data).
 */
async function postSSE(path, body, handlers) {
  const response = await fetch(`${connection.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(connection.apiKey ? { "X-Api-Key": connection.apiKey } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let frameEnd;
    while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const eventMatch = frame.match(/^event: (.+)$/m);
      const dataMatch = frame.match(/^data: (.+)$/m);
      if (!eventMatch || !dataMatch) continue;
      handlers[eventMatch[1]]?.(JSON.parse(dataMatch[1]));
    }
  }
}

function hpMeterColor(current, max) {
  if (max <= 0) return "var(--status-good)";
  const ratio = current / max;
  if (ratio > 0.5) return "var(--status-good)";
  if (ratio > 0.25) return "var(--status-warning)";
  return "var(--status-critical)";
}

function renderScope(scope) {
  el.sidebarEmpty.classList.add("hidden");
  el.sidebarContent.classList.remove("hidden");

  el.charName.textContent = scope.character.name;
  el.charSub.textContent = [scope.character.class, scope.character.race].filter(Boolean).join(" · ");

  const hp = scope.effectiveStats.hitPoints;
  if (hp) {
    el.hpValue.textContent = `${hp.current} / ${hp.max}`;
    const pct = hp.max > 0 ? Math.max(0, Math.min(100, (hp.current / hp.max) * 100)) : 0;
    el.hpFill.style.width = `${pct}%`;
    el.hpFill.style.backgroundColor = hpMeterColor(hp.current, hp.max);
  } else {
    el.hpValue.textContent = "—";
    el.hpFill.style.width = "0%";
  }

  el.acValue.textContent = scope.effectiveStats.armorClass ?? "—";

  el.nodeName.textContent = scope.node.name;
  el.nodeDesc.textContent = scope.node.description;

  el.inventoryList.innerHTML = "";
  if (scope.inventory.length === 0) {
    el.inventoryList.innerHTML = '<li class="empty">Nothing carried.</li>';
  } else {
    for (const item of scope.inventory) {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = item.itemId + (item.equipped ? " (equipped)" : "");
      const qty = document.createElement("span");
      qty.textContent = `×${item.quantity}`;
      li.append(label, qty);
      el.inventoryList.appendChild(li);
    }
  }

  el.othersList.innerHTML = "";
  if (scope.othersPresent.length === 0) {
    el.othersList.innerHTML = '<li class="empty">No one else here.</li>';
  } else {
    for (const other of scope.othersPresent) {
      const li = document.createElement("li");
      li.textContent = other.name;
      el.othersList.appendChild(li);
    }
  }
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(connection.apiKey ? { "X-Api-Key": connection.apiKey } : {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return data;
}

async function connect() {
  setStatus(null);
  autoOpenedModelDialog = false;
  try {
    const health = await apiFetch("/api/health");
    el.experienceName.textContent = health.experience ?? "Genesis Infinity";

    setStatus("connected");
    addMessage(`Connected to "${health.experience}".`, "system");
    startStatusPolling();
  } catch (error) {
    setStatus("error");
    addMessage(`Connection failed: ${error.message}`, "system");
    openSettings();
  }
}

function openSettings() {
  if (connection) {
    el.settingBaseUrl.value = connection.baseUrl;
    el.settingApiKey.value = connection.apiKey ?? "";
    el.settingCharacterId.value = connection.characterId;
  }
  el.settingsDialog.showModal();
}

function openModelDialog() {
  pollBackendStatus();
  el.modelDialog.showModal();
}

function switchBackendTab(backend) {
  el.tabLocal.classList.toggle("active", backend === "llamaCpp");
  el.tabApi.classList.toggle("active", backend === "api");
  el.panelLocal.classList.toggle("hidden", backend !== "llamaCpp");
  el.panelApi.classList.toggle("hidden", backend !== "api");
  if (backend === "api") loadApiProviders();
}

async function loadApiProviders() {
  let providers = [];
  try {
    providers = await apiFetch("/api/backend/providers");
  } catch {
    providers = [];
  }
  el.modelApiProvider.innerHTML = "";
  for (const provider of providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.label;
    el.modelApiProvider.appendChild(option);
  }
  const hasProviders = providers.length > 0;
  el.modelApiNone.classList.toggle("hidden", hasProviders);
  el.modelApiProvider.disabled = !hasProviders;
  el.modelApiInput.disabled = !hasProviders;
  el.modelApiForm.querySelector("button[type=submit]").disabled = !hasProviders;

  if (hasProviders) await loadApiModelsForProvider(el.modelApiProvider.value);
}

// Populates the model dropdown for a provider, if that provider has a
// public catalogue (see apiModelCatalogue.ts). Falls back to manual
// model-id entry (the only option) when it doesn't. Only OpenRouter's list
// is actually free (its zero-cost tier) - Hugging Face's list is filtered
// to tool-calling-capable models but still billed through the user's own
// HF_API_KEY, so the label says "Suggested" there instead of "Free".
async function loadApiModelsForProvider(provider) {
  el.modelApiModelSelect.innerHTML = "";
  // Stale manual text must never silently outlive a provider switch and
  // override whatever the dropdown ends up defaulting to (see the submit
  // handler below, which prefers a non-empty manual value over the select).
  el.modelApiInput.value = "";
  let models = [];
  try {
    models = await apiFetch(`/api/models/api/${encodeURIComponent(provider)}`);
  } catch {
    models = [];
  }
  const hasModels = models.length > 0;
  el.modelApiSelectWrap.classList.toggle("hidden", !hasModels);
  el.modelApiSelectLabel.textContent = provider === "openrouter" ? "Free model" : "Suggested model";
  el.modelApiManualLabel.textContent = hasModels ? "Or enter a model id manually" : "Model id";
  el.modelApiInput.required = !hasModels;
  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    el.modelApiModelSelect.appendChild(option);
  }
}

function renderSearchResults(results) {
  el.modelSearchResults.innerHTML = "";
  if (results.length === 0) {
    el.modelSearchResults.innerHTML = '<li class="empty">No results.</li>';
    return;
  }
  for (const result of results) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = result.id;
    const downloads = document.createElement("span");
    downloads.textContent = `${result.downloads.toLocaleString()} dl`;
    li.append(label, downloads);
    li.addEventListener("click", () => selectRepo(result.id));
    el.modelSearchResults.appendChild(li);
  }
}

async function selectRepo(repoId) {
  selectedRepo = repoId;
  el.modelSelectedRepo.textContent = repoId;
  el.modelFileSection.classList.remove("hidden");
  el.modelFileResults.innerHTML = '<li class="empty">Loading…</li>';
  try {
    const files = await apiFetch(`/api/models/${encodeURIComponent(repoId)}/files`);
    el.modelFileResults.innerHTML = "";
    if (files.length === 0) {
      el.modelFileResults.innerHTML = '<li class="empty">No .gguf files in this repo.</li>';
      return;
    }
    for (const filename of files) {
      const li = document.createElement("li");
      li.textContent = filename;
      li.addEventListener("click", () => loadLocalModel(repoId, filename));
      el.modelFileResults.appendChild(li);
    }
  } catch (error) {
    el.modelFileResults.innerHTML = `<li class="empty">${error.message}</li>`;
  }
}

async function loadLocalModel(repoId, filename) {
  if (modelSwitchInFlight) return;
  modelSwitchInFlight = true;
  pendingLocalRepo = { repoId, filename };
  try {
    await apiFetch("/api/backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "llamaCpp", repoId, filename }),
    });
    pollBackendStatus();
  } catch (error) {
    modelSwitchInFlight = false;
    pendingLocalRepo = null;
    el.modelDialogStatus.textContent = `Status: ${error.message}`;
  }
}

async function useApiModel(provider, model) {
  if (!provider || !model || modelSwitchInFlight) return;
  modelSwitchInFlight = true;
  try {
    await apiFetch("/api/backend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api", provider, model }),
    });
    pollBackendStatus();
  } catch (error) {
    modelSwitchInFlight = false;
    el.modelDialogStatus.textContent = `Status: ${error.message}`;
  }
}

async function unloadModel() {
  try {
    await apiFetch("/api/backend/unload", { method: "POST" });
    pollBackendStatus();
  } catch (error) {
    el.modelDialogStatus.textContent = `Status: ${error.message}`;
  }
}

el.modelBtn.addEventListener("click", openModelDialog);
el.modelDialogClose.addEventListener("click", () => el.modelDialog.close());
el.tabLocal.addEventListener("click", () => switchBackendTab("llamaCpp"));
el.tabApi.addEventListener("click", () => switchBackendTab("api"));
el.modelApiProvider.addEventListener("change", () => loadApiModelsForProvider(el.modelApiProvider.value));

el.modelSearchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = el.modelSearchInput.value.trim();
  try {
    const results = await apiFetch(`/api/models/search?q=${encodeURIComponent(query)}`);
    renderSearchResults(results);
  } catch (error) {
    el.modelSearchResults.innerHTML = `<li class="empty">${error.message}</li>`;
  }
});

// An explicit dropdown pick must never be silently overridden by leftover
// text in the manual field (mobile autofill, or a value typed before
// switching to the dropdown) - selecting a free model clears it so the
// dropdown's choice always wins for that selection.
el.modelApiModelSelect.addEventListener("change", () => {
  el.modelApiInput.value = "";
});

el.modelApiForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const model = el.modelApiInput.value.trim() || el.modelApiModelSelect.value;
  useApiModel(el.modelApiProvider.value, model);
});

el.modelUnloadBtn.addEventListener("click", unloadModel);

el.settingsBtn.addEventListener("click", openSettings);
el.settingsCancel.addEventListener("click", () => el.settingsDialog.close());

el.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  connection = {
    baseUrl: el.settingBaseUrl.value.replace(/\/+$/, ""),
    apiKey: el.settingApiKey.value,
    characterId: el.settingCharacterId.value.trim(),
  };
  saveConnection(connection);
  el.settingsDialog.close();
  connect();
});

el.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = el.input.value.trim();
  if (!input) return;

  addMessage(input, "player");
  el.input.value = "";
  el.input.disabled = true;
  el.sendBtn.disabled = true;

  const toolLog = addToolLog();
  const pending = addPendingMessage();
  const settleToolLog = () => {
    if (toolLog.list.children.length === 0) toolLog.details.remove();
    else toolLog.details.open = false;
  };

  try {
    let turnError = null;
    await postSSE(
      "/api/turn",
      { input },
      {
        tool_call: (call) => appendToolLogEntry(toolLog, call),
        done: ({ narration, reasoning, scope }) => {
          settleToolLog();
          if (reasoning) addReasoningBlock(reasoning, pending);
          pending.classList.remove("pending");
          pending.textContent = narration;
          if (scope) renderScope(scope);
          el.messages.scrollTop = el.messages.scrollHeight;
        },
        error: (data) => {
          turnError = data.error ?? "Unknown error";
        },
      },
    );
    if (turnError) throw new Error(turnError);
  } catch (error) {
    settleToolLog();
    pending.remove();
    addMessage(`Error: ${error.message}`, "system");
  } finally {
    el.input.disabled = false;
    el.sendBtn.disabled = false;
    el.input.focus();
  }
});

renderProfiles({ status: "idle" });

connection = loadConnection();
if (connection) {
  connect();
} else {
  openSettings();
}
