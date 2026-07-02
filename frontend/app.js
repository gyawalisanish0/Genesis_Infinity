const STORAGE_KEY = "genesis-infinity-connection";

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

function setStatus(state) {
  el.statusDot.classList.remove("connected", "error");
  if (state === "connected") el.statusDot.classList.add("connected");
  if (state === "error") el.statusDot.classList.add("error");
}

function addMessage(text, kind) {
  const div = document.createElement("div");
  div.className = `message ${kind}`;
  div.textContent = text;
  el.messages.appendChild(div);
  el.messages.scrollTop = el.messages.scrollHeight;
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
  try {
    const health = await apiFetch("/api/health");
    el.experienceName.textContent = health.experience ?? "Genesis Infinity";

    const scope = await apiFetch(`/api/scope?characterId=${encodeURIComponent(connection.characterId)}`);
    renderScope(scope);

    setStatus("connected");
    el.input.disabled = false;
    el.sendBtn.disabled = false;
    addMessage(`Connected to "${health.experience}".`, "system");
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

  try {
    const result = await apiFetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });
    addMessage(result.narration, "narrator");
    if (result.scope) renderScope(result.scope);
  } catch (error) {
    addMessage(`Error: ${error.message}`, "system");
  } finally {
    el.input.disabled = false;
    el.sendBtn.disabled = false;
    el.input.focus();
  }
});

connection = loadConnection();
if (connection) {
  connect();
} else {
  openSettings();
}
