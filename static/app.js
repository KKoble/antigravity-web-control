// Antigravity Web Control - Main Application Logic

let authToken = localStorage.getItem("ag_token") || "";
let activeSocket = null;
let currentConversationId = null;
let isGenerating = false;

// Selected Model & Effort
let selectedModel = "gemini-3.8-flash-high";
let selectedEffort = "high";
let availableModels = [];
let availableEfforts = [];

// Conversation caching
let allConversations = [];

// Attached files for upload
let attachedFiles = [];

// Feature 2: Approval Mode state
let isApprovalMode = localStorage.getItem("ag_approval_mode") === "true";
let isFileEditApproval = localStorage.getItem("ag_file_edit_approval") !== "false";

// Feature 4: Voice Dictation state
let speechRecognition = null;
let isListening = false;

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeMarkdown(raw) {
  if (!raw) return "";
  const parsed = window.marked ? marked.parse(raw) : escapeHtml(raw);
  if (window.DOMPurify) {
    return DOMPurify.sanitize(parsed, {
      ALLOWED_TAGS: [
        "h1","h2","h3","h4","h5","h6","blockquote","p","a","ul","ol","nl","li","b","i",
        "strong","em","strike","code","hr","br","div","table","thead","caption","tbody",
        "tr","th","td","pre","span","details","summary"
      ],
      ALLOWED_ATTR: ["href", "name", "target", "class", "id", "style", "open"]
    });
  }
  return parsed;
}

// DOM Elements
const authModal = document.getElementById("authModal");
const authForm = document.getElementById("authForm");
const authPassword = document.getElementById("authPassword");
const authError = document.getElementById("authError");
const conversationsList = document.getElementById("conversationsList");
const messagesList = document.getElementById("messagesList");
const welcomeHero = document.getElementById("welcomeHero");
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");
const chatScrollArea = document.getElementById("chatScrollArea");

const modelDropdownBtn = document.getElementById("modelDropdownBtn");
const modelMenu = document.getElementById("modelMenu");
const selectedModelLabel = document.getElementById("selectedModelLabel");
const selectedModelBadge = document.getElementById("selectedModelBadge");
const modelListOptions = document.getElementById("modelListOptions");
const activeModelPill = document.getElementById("activeModelPill");

const effortDropdownBtn = document.getElementById("effortDropdownBtn");
const effortMenu = document.getElementById("effortMenu");
const selectedEffortLabel = document.getElementById("selectedEffortLabel");
const effortListOptions = document.getElementById("effortListOptions");
const activeEffortPill = document.getElementById("activeEffortPill");

const tunnelStatusText = document.getElementById("tunnelStatusText");

// Initialize Marked.js
if (window.marked) {
  marked.setOptions({
    breaks: true,
    gfm: true
  });
}

// -------------------------------------------------------------
// Initialization
// -------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  if (!authToken) {
    showAuthModal();
  } else {
    const valid = await verifyAuthToken();
    if (!valid) {
      showAuthModal();
    } else {
      initApp();
    }
  }

  // Close menus on outside click
  document.addEventListener("click", (e) => {
    if (!modelDropdownBtn.contains(e.target) && !modelMenu.contains(e.target)) {
      modelMenu.classList.add("hidden");
    }
    if (!effortDropdownBtn.contains(e.target) && !effortMenu.contains(e.target)) {
      effortMenu.classList.add("hidden");
    }
  });

  // Ctrl+N shortcut for new chat
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      startNewChat();
    }
  });

  setupDragAndDrop();
  updateApprovalModeUI();
  updateFileEditApprovalUI();
  setupSlashCommands();
  setupTerminalResize();
  setupTerminalCmdInput();
});

async function initApp() {
  hideAuthModal();
  updateApprovalModeUI();
  updateFileEditApprovalUI();
  await loadModelsAndEfforts();
  await loadConversations();
  connectWebSocket();
  checkTunnelStatus();
  fetchQuotaData();
  loadSessionCountBadge();
}

// -------------------------------------------------------------
// Authentication
// -------------------------------------------------------------
function showAuthModal() {
  authModal.classList.remove("hidden");
  authPassword.value = "";
  authPassword.focus();
}

function hideAuthModal() {
  authModal.classList.add("hidden");
  authError.classList.add("hidden");
}

async function verifyAuthToken() {
  try {
    const res = await fetch("/api/auth/verify", {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const password = authPassword.value;
  authError.classList.add("hidden");

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (data.ok && data.token) {
      authToken = data.token;
      localStorage.setItem("ag_token", authToken);
      initApp();
    } else {
      authError.textContent = data.message || "Incorrect password.";
      authError.classList.remove("hidden");
    }
  } catch (err) {
    authError.textContent = "Failed to connect to server: " + err.message;
    authError.classList.remove("hidden");
  }
}

async function handleLogout() {
  if (!confirm("Are you sure you want to log out?\nThis device session will also be revoked on the server.")) return;
  // Revoke token on the server
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Authorization": `Bearer ${authToken}` }
    });
  } catch (e) {
    // Ignore network error — still clear local token
  }
  localStorage.removeItem("ag_token");
  authToken = "";
  if (activeSocket) activeSocket.close();
  showAuthModal();
}

// -------------------------------------------------------------
// Models & Reasoning Effort
// -------------------------------------------------------------
async function loadModelsAndEfforts() {
  try {
    const res = await fetch("/api/models", {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    availableModels = data.models || [];
    availableEfforts = data.efforts || [];

    renderModelMenu();
    renderEffortMenu();
  } catch (e) {
    console.error("Failed to load models:", e);
  }
}

function renderModelMenu() {
  modelListOptions.innerHTML = "";
  availableModels.forEach((m) => {
    const isSelected = m.id === selectedModel;
    const item = document.createElement("button");
    item.className = `w-full text-left px-3 py-2 flex items-center justify-between hover:bg-[#333333] transition-colors rounded-lg text-xs ${
      isSelected ? "bg-[#333333] font-medium text-white" : "text-[#d1d1d1]"
    }`;
    item.onclick = () => selectModel(m.id);

    item.innerHTML = `
      <div class="flex flex-col">
        <span class="text-white">${m.name}</span>
        <span class="text-[10px] text-[#888888]">${m.provider || "Antigravity"}</span>
      </div>
      ${m.badge ? `<span class="text-[10px] bg-[#10a37f]/20 text-[#10a37f] px-1.5 py-0.5 rounded border border-[#10a37f]/30">${m.badge}</span>` : ""}
    `;
    modelListOptions.appendChild(item);
  });
}

function selectModel(modelId) {
  selectedModel = modelId;
  const m = availableModels.find((x) => x.id === modelId);
  if (m) {
    selectedModelLabel.textContent = m.name;
    if (m.badge) {
      selectedModelBadge.textContent = m.badge;
      selectedModelBadge.classList.remove("hidden");
    } else {
      selectedModelBadge.classList.add("hidden");
    }
    activeModelPill.textContent = m.name;

    const dModel = document.getElementById("detailQuotaModel");
    if (dModel) dModel.textContent = m.name;
    updateQuotaUI(currentQuotaData);
  }
  renderModelMenu();
  modelMenu.classList.add("hidden");
}

function toggleModelDropdown() {
  modelMenu.classList.toggle("hidden");
  effortMenu.classList.add("hidden");
}

function renderEffortMenu() {
  effortListOptions.innerHTML = "";
  availableEfforts.forEach((eff) => {
    const isSelected = eff.id === selectedEffort;
    const item = document.createElement("button");
    item.className = `w-full text-left px-3 py-2 flex items-center justify-between hover:bg-[#333333] transition-colors rounded-lg text-xs ${
      isSelected ? "bg-[#333333] font-medium text-white" : "text-[#d1d1d1]"
    }`;
    item.onclick = () => selectEffort(eff.id);

    item.innerHTML = `
      <div class="flex flex-col">
        <span class="text-white capitalize">${eff.name}</span>
        <span class="text-[10px] text-[#888888]">${eff.description || ""}</span>
      </div>
      ${isSelected ? `<span class="text-[#10a37f] text-xs font-bold">✓</span>` : ""}
    `;
    effortListOptions.appendChild(item);
  });
}

function selectEffort(effortId) {
  selectedEffort = effortId;
  const eff = availableEfforts.find((x) => x.id === effortId);
  if (eff) {
    selectedEffortLabel.textContent = eff.name;
    activeEffortPill.textContent = `Effort: ${eff.name}`;
  }
  renderEffortMenu();
  effortMenu.classList.add("hidden");
}

function toggleEffortDropdown() {
  effortMenu.classList.toggle("hidden");
  modelMenu.classList.add("hidden");
}

// -------------------------------------------------------------
// Conversations & Sidebar History
// -------------------------------------------------------------
async function loadConversations() {
  try {
    const res = await fetch("/api/conversations", {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    allConversations = data.conversations || [];
    renderConversations(allConversations);
  } catch (e) {
    console.error("Failed to load conversations:", e);
    conversationsList.innerHTML = `<div class="text-xs text-rose-400 px-3 py-2">Failed to load conversation list</div>`;
  }
}

function groupConversationsByDate(convs) {
  const groups = {
    today: [],
    yesterday: [],
    last7Days: [],
    older: []
  };

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  const startOfYesterday = startOfToday - 86400;
  const startOf7DaysAgo = startOfToday - 86400 * 7;

  convs.forEach((c) => {
    const t = c.updated_timestamp;
    if (t >= startOfToday) {
      groups.today.push(c);
    } else if (t >= startOfYesterday) {
      groups.yesterday.push(c);
    } else if (t >= startOf7DaysAgo) {
      groups.last7Days.push(c);
    } else {
      groups.older.push(c);
    }
  });

  return groups;
}

function renderConversations(convs) {
  if (!convs || convs.length === 0) {
    conversationsList.innerHTML = `<div class="text-xs text-[#737373] px-3 py-4 text-center">No conversation history.</div>`;
    return;
  }

  const groups = groupConversationsByDate(convs);
  conversationsList.innerHTML = "";

  const sectionDefs = [
    { key: "today", label: "Today" },
    { key: "yesterday", label: "Yesterday" },
    { key: "last7Days", label: "Last 7 Days" },
    { key: "older", label: "Older" }
  ];

  sectionDefs.forEach(({ key, label }) => {
    const list = groups[key];
    if (list && list.length > 0) {
      const header = document.createElement("div");
      header.className = "text-[11px] font-semibold text-[#666666] px-3 pt-3 pb-1 uppercase tracking-wider";
      header.textContent = label;
      conversationsList.appendChild(header);

      list.forEach((c) => {
        const isCurrent = c.id === currentConversationId;
        const item = document.createElement("div");
        item.className = `group flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition-colors text-xs ${
          isCurrent ? "bg-[#282828] text-white font-medium" : "text-[#b4b4b4] hover:bg-[#212121] hover:text-white"
        }`;
        item.onclick = () => loadConversation(c.id);

        item.innerHTML = `
          <div class="flex items-center gap-2 overflow-hidden flex-1 mr-1">
            <svg class="w-3.5 h-3.5 flex-shrink-0 text-[#737373] group-hover:text-[#10a37f]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>
            </svg>
            <span class="truncate">${c.title || "New Chat"}</span>
          </div>
          <button onclick="deleteConversation(event, '${c.id}')" title="Delete" class="opacity-0 group-hover:opacity-100 p-1 hover:text-rose-400 rounded transition-opacity">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
            </svg>
          </button>
        `;
        conversationsList.appendChild(item);
      });
    }
  });
}

function filterConversations(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    renderConversations(allConversations);
    return;
  }
  const filtered = allConversations.filter(
    (c) => c.title && c.title.toLowerCase().includes(q)
  );
  renderConversations(filtered);
}

async function loadConversation(convId) {
  currentConversationId = convId;
  welcomeHero.classList.add("hidden");
  messagesList.innerHTML = `<div class="text-xs text-[#737373] text-center py-6">Loading conversation...</div>`;
  renderConversations(allConversations);

  // Subscribe to live CLI updates for this conversation
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ action: "watch", conversation_id: convId }));
  }

  try {
    const res = await fetch(`/api/conversations/${convId}`, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) throw new Error("Failed to load conversation");
    const data = await res.json();
    renderConversationMessages(data.messages || [], false);
    handlePendingActionUI(data.pending_action);
  } catch (e) {
    messagesList.innerHTML = `<div class="text-xs text-rose-400 text-center py-6">Cannot load conversation: ${e.message}</div>`;
  }
}

// -------------------------------------------------------------
// Flicker-Free & Jump-Free Message Rendering (Incremental)
// -------------------------------------------------------------
function isScrolledNearBottom() {
  const threshold = 180;
  return (chatScrollArea.scrollHeight - chatScrollArea.scrollTop - chatScrollArea.clientHeight) <= threshold;
}

function smartScrollToBottom(force = false) {
  if (force || isScrolledNearBottom()) {
    chatScrollArea.scrollTo({ top: chatScrollArea.scrollHeight, behavior: 'smooth' });
  }
}

function renderConversationMessages(messages, isIncremental = false) {
  if (!messages || messages.length === 0) {
    welcomeHero.classList.remove("hidden");
    messagesList.innerHTML = "";
    return;
  }
  welcomeHero.classList.add("hidden");

  const wasNearBottom = isScrolledNearBottom();

  if (!isIncremental) {
    messagesList.innerHTML = "";
  }

  messages.forEach((msg, idx) => {
    const elId = `msg-turn-${idx}`;
    let node = document.getElementById(elId);

    if (msg.role === "user") {
      if (!node) {
        node = createUserMessageElement(msg.content, msg.attachments);
        node.id = elId;
        messagesList.appendChild(node);
      } else {
        updateUserMessageElement(node, msg.content, msg.attachments);
      }
    } else if (msg.role === "assistant") {
      if (!node) {
        node = createAssistantMessageElement(msg.content, msg.thinking, msg.thinking_tokens, msg.actions);
        node.id = elId;
        messagesList.appendChild(node);
      } else {
        updateAssistantMessageElement(node, msg.content, msg.thinking, msg.thinking_tokens, msg.actions);
      }
    }
  });

  // Remove excess nodes if any (never remove active node while generating)
  const existingNodes = messagesList.querySelectorAll('[id^="msg-turn-"]');
  for (let i = messages.length; i < existingNodes.length; i++) {
    const el = document.getElementById(`msg-turn-${i}`);
    if (el && (!isGenerating || el !== currentAssistantNode)) {
      el.remove();
    }
  }

  if (wasNearBottom || !isIncremental) {
    smartScrollToBottom(true);
  }
}

function createUserMessageElement(content, attachments) {
  const wrapper = document.createElement("div");
  wrapper.className = "flex justify-end";

  const bubble = document.createElement("div");
  bubble.className = "max-w-2xl bg-[#2f2f2f] text-white px-4 py-3 rounded-2xl rounded-tr-sm text-sm leading-relaxed shadow-sm";

  const gallery = document.createElement("div");
  gallery.className = "attachment-gallery flex flex-wrap gap-2 mb-2 pb-2 border-b border-[#3f3f3f] hidden";
  bubble.appendChild(gallery);

  const textNode = document.createElement("div");
  textNode.className = "user-text whitespace-pre-wrap";
  bubble.appendChild(textNode);

  wrapper.appendChild(bubble);
  updateUserMessageElement(wrapper, content, attachments);
  return wrapper;
}

function updateUserMessageElement(node, content, attachments) {
  const textNode = node.querySelector(".user-text");
  if (textNode) textNode.textContent = content || "";

  const gallery = node.querySelector(".attachment-gallery");
  if (gallery) {
    if (attachments && attachments.length > 0) {
      gallery.classList.remove("hidden");
      gallery.innerHTML = "";
      attachments.forEach((file) => {
        if (file.is_image) {
          const img = document.createElement("img");
          img.src = file.url;
          img.alt = file.original_name;
          img.className = "max-h-36 rounded-lg object-cover border border-[#444444]";
          gallery.appendChild(img);
        } else {
          const card = document.createElement("div");
          card.className = "flex items-center gap-1.5 bg-[#242424] border border-[#3f3f3f] px-2.5 py-1.5 rounded-lg text-xs text-neutral-300";
          card.innerHTML = `
            <span>📄</span>
            <span class="font-medium truncate max-w-[140px]">${file.original_name}</span>
            <span class="text-[10px] text-[#888888]">(${formatBytes(file.size)})</span>
          `;
          gallery.appendChild(card);
        }
      });
    } else {
      gallery.classList.add("hidden");
    }
  }
}

function createAssistantMessageElement(content, thinking, thinkingTokens, actions) {
  const wrapper = document.createElement("div");
  wrapper.className = "flex gap-3.5";

  wrapper.innerHTML = `
    <!-- Avatar -->
    <div class="w-8 h-8 rounded-full bg-[#10a37f] flex items-center justify-center flex-shrink-0 text-white font-bold text-xs shadow-md mt-0.5">
      <svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path>
        <path d="M2 12h20"></path>
      </svg>
    </div>

    <!-- Message Content Body -->
    <div class="flex-1 overflow-hidden">
      <!-- Actions Container (● Read, ● Edit, ● Run) -->
      <div class="action-list mb-2 space-y-1"></div>

      <!-- Thinking Accordion -->
      <div class="thinking-container hidden mb-2">
        <div class="thinking-header" onclick="toggleThinkingAccordion(this)">
          <div class="flex items-center gap-2">
            <span class="text-xs">▸</span>
            <span class="thinking-status font-mono text-xs">Thought process</span>
          </div>
          <svg class="w-3.5 h-3.5 text-[#737373] transform transition-transform chevron" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
          </svg>
        </div>
        <div class="thinking-body hidden"></div>
      </div>

      <!-- Text Content -->
      <div class="prose max-w-none text-sm leading-relaxed text-[#ececec] markdown-body"></div>
    </div>
  `;

  updateAssistantMessageElement(wrapper, content, thinking, thinkingTokens, actions);
  return wrapper;
}

function cleanFrontendCmd(str) {
  if (!str) return "";
  let s = String(str).trim();
  if ((s.startsWith('\"') && s.endsWith('\"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return s;
}

function toggleActionsTray(header) {
  const tray = header.closest(".actions-tray");
  if (!tray) return;
  const body = tray.querySelector(".actions-tray-body");
  const label = tray.querySelector(".tray-toggle-label");
  if (!body) return;

  const isHidden = body.classList.contains("hidden");
  if (isHidden) {
    body.classList.remove("hidden");
    if (label) label.textContent = "Collapse ▴";
    tray.setAttribute("data-expanded", "true");
  } else {
    body.classList.add("hidden");
    if (label) label.textContent = "Expand ▾";
    tray.setAttribute("data-expanded", "false");
  }
}

function renderActionsTray(container, actions, isStreaming = false) {
  if (!container) return;
  if (!actions || actions.length === 0) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  container.classList.remove("hidden");

  const existingTray = container.querySelector(".actions-tray");
  const wasExpanded = existingTray ? existingTray.getAttribute("data-expanded") === "true" : false;

  let runCount = 0;
  let editCount = 0;
  let readCount = 0;
  let searchCount = 0;
  let taskCount = 0;

  actions.forEach((act) => {
    const t = act.type || "generic";
    if (t === "run") runCount++;
    else if (t === "edit") editCount++;
    else if (t === "read") readCount++;
    else if (t === "search") searchCount++;
    else taskCount++;
  });

  const summaryParts = [];
  if (runCount > 0) summaryParts.push(`Terminal: ${runCount}`);
  if (editCount > 0) summaryParts.push(`File Edit: ${editCount}`);
  if (readCount > 0) summaryParts.push(`File Read: ${readCount}`);
  if (searchCount > 0) summaryParts.push(`Search: ${searchCount}`);
  if (taskCount > 0) summaryParts.push(`Other Task: ${taskCount}`);

  const subSummary = summaryParts.length > 0 ? ` · ${summaryParts.join(", ")}` : "";
  const titleText = isStreaming
    ? `Executing tasks (${actions.length})`
    : `Tool tasks (${actions.length})`;

  const tray = document.createElement("div");
  tray.className = "actions-tray";
  tray.setAttribute("data-expanded", wasExpanded ? "true" : "false");

  tray.innerHTML = `
    <div class="actions-tray-header" onclick="toggleActionsTray(this)">
      <div class="flex items-center gap-2 overflow-hidden flex-1 mr-2">
        <span class="text-sm flex-shrink-0 ${isStreaming ? 'animate-pulse text-amber-400' : 'text-emerald-400'}">⚡</span>
        <span class="text-xs font-semibold text-white truncate">${titleText}</span>
        <span class="text-[11px] text-[#8e8e8e] truncate hidden sm:inline">${subSummary}</span>
      </div>
      <div class="flex items-center gap-1.5 flex-shrink-0 text-xs text-[#a3a3a3]">
        <span class="tray-toggle-label text-[11px]">${wasExpanded ? "Collapse ▴" : "Expand ▾"}</span>
      </div>
    </div>
    <div class="actions-tray-body ${wasExpanded ? '' : 'hidden'}"></div>
  `;

  const body = tray.querySelector(".actions-tray-body");

  actions.forEach((act) => {
    const type = act.type || "generic";
    let chipClass = "action-chip-task";
    let chipIcon = "⚙️";
    let chipLabel = "Task";

    if (type === "run") {
      chipClass = "action-chip-run";
      chipIcon = "⚡";
      chipLabel = "Terminal";
    } else if (type === "read") {
      chipClass = "action-chip-read";
      chipIcon = "📖";
      chipLabel = "Read";
    } else if (type === "edit") {
      chipClass = "action-chip-edit";
      chipIcon = "✏️";
      chipLabel = "Edit";
    } else if (type === "search") {
      chipClass = "action-chip-search";
      chipIcon = "🔍";
      chipLabel = "Search";
    }

    let targetText = act.cmd || act.target || "";
    if (!targetText && act.label) {
      const m = act.label.match(/●\s*\w+\((.*)\)/);
      targetText = m ? m[1] : act.label;
    }
    if (!targetText && act.name) {
      targetText = act.name;
    }
    targetText = cleanFrontendCmd(targetText);

    const rowContainer = document.createElement("div");
    rowContainer.className = "action-row-container flex flex-col";

    if (type === "run") {
      const outputText = act.output || "(Terminal command completed)";
      rowContainer.innerHTML = `
        <div class="action-row">
          <div class="flex items-center gap-2 overflow-hidden flex-1 mr-2">
            <span class="action-chip ${chipClass}">${chipIcon} ${chipLabel}</span>
            <span class="font-mono text-xs text-[#d1d1d1] truncate" title="${escapeHtml(targetText)}">${escapeHtml(targetText)}</span>
          </div>
          <button type="button" class="action-btn-terminal" onclick="toggleTerminalView(this)">
            <span class="terminal-badge">View Terminal ▾</span>
          </button>
        </div>
        <div class="terminal-box hidden mt-1">
          <div class="terminal-header flex items-center justify-between">
            <div class="flex items-center gap-2 overflow-hidden mr-2">
              <span class="w-2 h-2 rounded-full bg-purple-400 flex-shrink-0 ${isStreaming ? 'animate-pulse' : ''}"></span>
              <span class="font-mono text-[11px] text-[#b4b4b4] truncate">Command: <code class="text-white">${escapeHtml(targetText)}</code></span>
            </div>
            <button type="button" class="copy-code-btn flex-shrink-0" onclick="copyTerminalText(this)">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
              <span>Copy</span>
            </button>
          </div>
          <pre class="terminal-body">${escapeHtml(outputText)}</pre>
        </div>
      `;
    } else {
      rowContainer.innerHTML = `
        <div class="action-row">
          <div class="flex items-center gap-2 overflow-hidden flex-1">
            <span class="action-chip ${chipClass}">${chipIcon} ${chipLabel}</span>
            <span class="font-mono text-xs text-[#d1d1d1] truncate" title="${escapeHtml(targetText)}">${escapeHtml(targetText)}</span>
          </div>
        </div>
      `;
    }

    body.appendChild(rowContainer);
  });

  container.innerHTML = "";
  container.appendChild(tray);
}

function updateAssistantMessageElement(node, content, thinking, thinkingTokens, actions) {
  // Update actions
  const actionList = node.querySelector(".action-list");
  if (actionList) {
    renderActionsTray(actionList, actions || [], false);
  }

  // Update Thinking
  const thinkingContainer = node.querySelector(".thinking-container");
  const thinkingStatus = node.querySelector(".thinking-status");
  const thinkingBody = node.querySelector(".thinking-body");
  if (thinking && thinking.trim()) {
    thinkingContainer.classList.remove("hidden");
    const tok = thinkingTokens ? `${thinkingTokens} tokens` : "Thinking";
    thinkingStatus.textContent = `Thought process (${tok})`;
    thinkingBody.textContent = thinking;
  } else {
    thinkingContainer.classList.add("hidden");
  }

  // Update Markdown Body
  const markdownBody = node.querySelector(".markdown-body");
  if (markdownBody) {
    const raw = content && content.trim() ? content : (actions && actions.length > 0 ? "*(Tasks completed)*" : "");
    markdownBody.innerHTML = safeMarkdown(raw);
    enhanceCodeBlocks(node);
  }
}

async function deleteConversation(e, convId) {
  e.stopPropagation();
  if (!confirm("Are you sure you want to delete this conversation?")) return;

  try {
    const res = await fetch(`/api/conversations/${convId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (res.ok) {
      if (currentConversationId === convId) {
        startNewChat();
      }
      loadConversations();
    }
  } catch (err) {
    alert("Delete failed: " + err.message);
  }
}

function startNewChat() {
  currentConversationId = null;
  messagesList.innerHTML = "";
  welcomeHero.classList.remove("hidden");
  promptInput.value = "";
  promptInput.style.height = "auto";
  attachedFiles = [];
  renderAttachmentPreviews();
  renderConversations(allConversations);
  promptInput.focus();
}

// -------------------------------------------------------------
// File Upload & Attachment Handlers
// -------------------------------------------------------------
function setupDragAndDrop() {
  const overlay = document.getElementById("globalDropOverlay");
  const dropCard = document.getElementById("globalDropCard");
  const dropZone = document.getElementById("dropZoneContainer");

  let dragCounter = 0;

  // Window dragenter
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes("Files")) {
      dragCounter++;
      if (overlay) {
        overlay.classList.remove("hidden");
        overlay.style.pointerEvents = "auto";
        if (dropCard) {
          dropCard.classList.remove("scale-95");
          dropCard.classList.add("scale-100");
        }
      }
    }
  });

  // Window dragover
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
  });

  // Window dragleave
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      if (overlay) {
        overlay.classList.add("hidden");
        overlay.style.pointerEvents = "none";
        if (dropCard) {
          dropCard.classList.remove("scale-100");
          dropCard.classList.add("scale-95");
        }
      }
    }
  });

  // Window drop
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    if (overlay) {
      overlay.classList.add("hidden");
      overlay.style.pointerEvents = "none";
      if (dropCard) {
        dropCard.classList.remove("scale-100");
        dropCard.classList.add("scale-95");
      }
    }

    const files = e.dataTransfer ? e.dataTransfer.files : null;
    if (files && files.length > 0) {
      handleFileSelected(files);
    }
  });

  // DropZone specific dragover style
  if (dropZone) {
    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("drag-over");
    });
    dropZone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
    });
    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
    });
  }

  // Global Paste Handler (Ctrl + V) for Images and Files
  window.addEventListener("paste", (e) => {
    const clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    const items = clipboardData.items;
    if (!items || items.length === 0) return;

    const filesToUpload = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          let finalFile = file;
          if (file.type.startsWith("image/") && (!file.name || file.name === "image.png")) {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, "0");
            const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            const ext = file.type.split("/")[1] || "png";
            const newName = `screenshot_${timestamp}.${ext}`;
            finalFile = new File([file], newName, { type: file.type });
          }
          filesToUpload.push(finalFile);
        }
      }
    }

    if (filesToUpload.length > 0) {
      e.preventDefault();
      handleFileSelected(filesToUpload);
    }
  });
}

async function handleFileSelected(files) {
  if (!files || files.length === 0) return;
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append("files", files[i]);
  }

  const previewContainer = document.getElementById("attachmentPreviewContainer");
  previewContainer.classList.remove("hidden");
  const uploadingPill = document.createElement("div");
  uploadingPill.id = "uploadingPill";
  uploadingPill.className = "attachment-chip animate-pulse";
  uploadingPill.innerHTML = `<span>⏳</span><span>Uploading...</span>`;
  previewContainer.appendChild(uploadingPill);

  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "Authorization": `Bearer ${authToken}` },
      body: formData
    });
    const data = await res.json();
    if (data.ok && data.files) {
      attachedFiles.push(...data.files);
    } else {
      alert("File upload failed: " + (data.message || "Error"));
    }
  } catch (err) {
    alert("File upload error: " + err.message);
  } finally {
    const pill = document.getElementById("uploadingPill");
    if (pill) pill.remove();
    renderAttachmentPreviews();
    document.getElementById("fileInput").value = "";
  }
}

function removeAttachment(index) {
  attachedFiles.splice(index, 1);
  renderAttachmentPreviews();
}

function renderAttachmentPreviews() {
  const container = document.getElementById("attachmentPreviewContainer");
  if (!container) return;
  container.innerHTML = "";

  if (attachedFiles.length === 0) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");
  attachedFiles.forEach((file, idx) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";

    let iconHtml = file.is_image
      ? `<img src="${file.url}" class="attachment-thumb" alt="preview" />`
      : `<span>📄</span>`;

    chip.innerHTML = `
      ${iconHtml}
      <span class="truncate max-w-[120px]" title="${file.original_name}">${file.original_name}</span>
      <span class="text-[10px] text-[#737373]">(${formatBytes(file.size)})</span>
      <button type="button" class="attachment-remove" onclick="removeAttachment(${idx})" title="Delete">✕</button>
    `;
    container.appendChild(chip);
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// -------------------------------------------------------------
// WebSocket Streaming Communication
// -------------------------------------------------------------
function connectWebSocket() {
  if (!authToken) return;

  if (activeSocket) {
    try {
      activeSocket.close();
    } catch (e) {}
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/ws/chat?token=${encodeURIComponent(authToken)}`;

  activeSocket = new WebSocket(wsUrl);

  activeSocket.onopen = () => {
    console.log("WebSocket connected to Antigravity");
    if (authToken) {
      activeSocket.send(JSON.stringify({ action: "auth", token: authToken }));
    }
    if (currentConversationId) {
      activeSocket.send(JSON.stringify({ action: "watch", conversation_id: currentConversationId }));
    }
  };

  activeSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "error" && data.message && data.message.includes("auth") || data.message.includes("auth")) {
        showAuthModal();
      }
      handleWebSocketMessage(data);
    } catch (e) {
      console.error("Error parsing WS message:", e);
    }
  };

  activeSocket.onerror = (err) => {
    console.error("WebSocket error:", err);
  };

  activeSocket.onclose = (event) => {
    // If closed due to policy violation (invalid token), do not spam reconnect
    if (event.code === 1008 || event.code === 4401) {
      console.warn("WebSocket closed due to auth failure. Please log in again.");
      showAuthModal();
      return;
    }
    console.log("WebSocket disconnected, reconnecting in 3s...");
    setTimeout(() => {
      if (authToken) connectWebSocket();
    }, 3000);
  };
}

let currentAssistantNode = null;
let currentTextContent = "";
let currentThinkingContent = "";
let currentActionList = [];
let thinkingStartTime = null;
let thinkingInterval = null;

function handleWebSocketMessage(data) {
  const type = data.type;

  if (type === "init") {
    if (data.conversation_id) {
      currentConversationId = data.conversation_id;
    }
  } else if (type === "thought") {
    const delta = data.delta || "";
    currentThinkingContent += delta;
    updateThinkingUI(currentThinkingContent);
  } else if (type === "token") {
    const delta = data.delta || "";
    currentTextContent += delta;
    updateAssistantTextUI(currentTextContent);
  } else if (type === "tool_step" || type === "tool_action") {
    if (currentAssistantNode) {
      const actionContainer = currentAssistantNode.querySelector(".action-list");
      if (actionContainer) {
        const actionType = data.action_type || (data.name === "view_file" ? "read" : data.name === "run_command" ? "run" : (data.name === "write_to_file" || data.name === "replace_file_content") ? "edit" : (data.name === "search_web" || data.name === "read_url_content") ? "search" : "task");
        const cmd = data.cmd || (data.args && (data.args.CommandLine || data.args.TargetFile || data.args.AbsolutePath || data.args.query)) || data.name || "action";
        
        currentActionList.push({
          type: actionType,
          name: data.name,
          cmd: cmd,
          label: data.label || `● ${data.name || "action"}(${cleanFrontendCmd(cmd)})`,
          output: data.output || ""
        });

        renderActionsTray(actionContainer, currentActionList, true);
      }
      const status = currentAssistantNode.querySelector(".thinking-status");
      if (status) {
        status.textContent = `Running tool: ${data.name}...`;
      }

      // Check file edit approval vs general tool approval:
      const isFileEdit = Boolean(data.is_file_edit || actionType === "edit");
      const actId = data.action_id || `act_${Date.now()}`;

      if (isFileEdit && (isFileEditApproval || isApprovalMode || data.approval_required)) {
        showFileEditApprovalBanner(actId, data);
      } else if (isApprovalMode || data.approval_required) {
        const cmdOrTarget = (data.args && (data.args.CommandLine || data.args.TargetFile || data.args.AbsolutePath)) || data.name || "";
        showApprovalBanner(actId, data.name || "Tool Execution", cmdOrTarget);
      }
    }
    smartScrollToBottom();
  } else if (type === "approval_required") {
    showApprovalBanner(data.action_id || `act_${Date.now()}`, data.name || "Command", data.description || "Execution approval required");
    smartScrollToBottom();
  } else if (type === "usage") {
    updateQuotaUsage(data.usage);
  } else if (type === "result" || type === "done") {
    if (data.response && (data.response.length > currentTextContent.length || !currentTextContent.trim())) {
      currentTextContent = data.response;
      updateAssistantTextUI(currentTextContent);
    }
    if (data.usage) {
      updateQuotaUsage(data.usage);
    }
    finishGenerating();
    loadConversations();
  } else if (type === "cli_live_sync") {
    // Incremental DOM update without flickering or jumping to top
    if (data.conversation_id === currentConversationId) {
      if (!isGenerating) {
        renderConversationMessages(data.messages || [], true);
      }
      handlePendingActionUI(data.pending_action);
      const badge = document.getElementById("quotaModelName");
      if (badge) {
        badge.innerHTML = `<span class="text-emerald-400 font-semibold animate-pulse">CLI Live Synced</span>`;
        setTimeout(() => {
          if (badge) badge.textContent = "Quota: Normal";
        }, 2000);
      }
    }
  } else if (type === "cli_conversations_updated") {
    loadConversations();
    if (data.pending_action) {
      if (!currentConversationId && data.latest_conv_id) {
        loadConversation(data.latest_conv_id);
      } else if (currentConversationId === data.latest_conv_id) {
        handlePendingActionUI(data.pending_action);
      } else {
        showToast("⚠️ Pending permission approval request in console.");
      }
    }
  } else if (type === "stopped") {
    currentTextContent += "\n\n*(Generation stopped)*";
    updateAssistantTextUI(currentTextContent);
    finishGenerating();
  } else if (type === "error") {
    currentTextContent += `\n\n> ⚠️ **Error**: ${data.message}`;
    updateAssistantTextUI(currentTextContent);
    finishGenerating();
  }
}

function sendPrompt() {
  const prompt = promptInput.value.trim();
  if ((!prompt && attachedFiles.length === 0) || isGenerating) return;

  const currentAttachments = [...attachedFiles];
  welcomeHero.classList.add("hidden");

  // Append user message with attachment cards
  const userMsgText = prompt || (currentAttachments.length > 0 ? "Attachment analysis request" : "");
  const userNode = createUserMessageElement(userMsgText, currentAttachments);
  userNode.id = `msg-turn-${messagesList.children.length}`;
  messagesList.appendChild(userNode);

  // Clear input and attachments
  promptInput.value = "";
  promptInput.style.height = "auto";
  attachedFiles = [];
  renderAttachmentPreviews();

  // Create Assistant Message Placeholder
  currentTextContent = "";
  currentThinkingContent = "";
  currentActionList = [];
  currentAssistantNode = createAssistantMessageElement("", "", 0, []);
  currentAssistantNode.id = `msg-turn-${messagesList.children.length}`;
  messagesList.appendChild(currentAssistantNode);

  // Start Generation State
  isGenerating = true;
  sendBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");

  // Start Thinking timer
  thinkingStartTime = Date.now();
  startThinkingTimer();

  // Construct payload with attachments for agy
  let fullPrompt = prompt;
  if (currentAttachments.length > 0) {
    let filesSummary = "[User attached files]:\n";
    currentAttachments.forEach((f) => {
      filesSummary += `- ${f.original_name} (Saved path: ${f.path})\n`;
    });
    fullPrompt = `${filesSummary}\n${prompt || "Please read the attached files and analyze them thoroughly."}`;
  }

  // Send via WebSocket
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(
      JSON.stringify({
        action: "chat",
        prompt: fullPrompt,
        conversation_id: currentConversationId,
        model: selectedModel,
        effort: selectedEffort,
        approval_mode: isApprovalMode
      })
    );
  } else {
    currentTextContent = "> ⚠️ Disconnected from Agent WebSocket server.";
    updateAssistantTextUI(currentTextContent);
    finishGenerating();
  }

  smartScrollToBottom(true);
}

function stopGenerating() {
  if (!isGenerating) return;
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ action: "stop" }));
  }
  finishGenerating();
}

function finishGenerating() {
  isGenerating = false;
  sendBtn.classList.remove("hidden");
  stopBtn.classList.add("hidden");
  stopThinkingTimer();

  if (currentAssistantNode) {
    const cursor = currentAssistantNode.querySelector(".streaming-cursor");
    if (cursor) cursor.remove();
    enhanceCodeBlocks(currentAssistantNode);

    const actionContainer = currentAssistantNode.querySelector(".action-list");
    if (actionContainer && currentActionList.length > 0) {
      renderActionsTray(actionContainer, currentActionList, false);
    }
  }

  currentAssistantNode = null;
}

function updateThinkingUI(thinkingText) {
  if (!currentAssistantNode) return;
  const container = currentAssistantNode.querySelector(".thinking-container");
  const body = currentAssistantNode.querySelector(".thinking-body");
  if (container && body) {
    container.classList.remove("hidden");
    body.textContent = thinkingText;
  }
}

function updateAssistantTextUI(rawText) {
  if (!currentAssistantNode) return;
  const markdownBody = currentAssistantNode.querySelector(".markdown-body");
  if (markdownBody) {
    const parsed = safeMarkdown(rawText);
    markdownBody.innerHTML = parsed + `<span class="streaming-cursor"></span>`;
    smartScrollToBottom();
  }
}

function toggleThinkingAccordion(header) {
  const container = header.closest(".thinking-container");
  const body = container.querySelector(".thinking-body");
  const chevron = header.querySelector(".chevron");
  body.classList.toggle("hidden");
  chevron.classList.toggle("rotate-180");
}

function startThinkingTimer() {
  stopThinkingTimer();
  thinkingInterval = setInterval(() => {
    if (!currentAssistantNode || !thinkingStartTime) return;
    const elapsed = Math.floor((Date.now() - thinkingStartTime) / 1000);
    const status = currentAssistantNode.querySelector(".thinking-status");
    if (status) {
      status.textContent = `Thinking (${elapsed}s)...`;
    }
  }, 1000);
}

function stopThinkingTimer() {
  if (thinkingInterval) {
    clearInterval(thinkingInterval);
    thinkingInterval = null;
  }
  if (currentAssistantNode && thinkingStartTime) {
    const elapsed = Math.max(1, Math.floor((Date.now() - thinkingStartTime) / 1000));
    const status = currentAssistantNode.querySelector(".thinking-status");
    if (status) {
      status.textContent = `Thought for ${elapsed}s`;
    }
  }
}

function enhanceCodeBlocks(parent) {
  const pres = parent.querySelectorAll("pre");
  pres.forEach((pre) => {
    if (pre.querySelector(".code-header")) return;

    const code = pre.querySelector("code");
    let lang = "code";
    if (code && code.className) {
      const match = code.className.match(/language-(\w+)/);
      if (match) lang = match[1];
    }

    const header = document.createElement("div");
    header.className = "code-header";
    header.innerHTML = `
      <span>${lang}</span>
      <button class="copy-code-btn" onclick="copyCode(this)">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
        </svg>
        <span>Copy</span>
      </button>
    `;
    pre.insertBefore(header, pre.firstChild);
  });
}

function copyCode(btn) {
  const pre = btn.closest("pre");
  const code = pre.querySelector("code");
  if (code) {
    navigator.clipboard.writeText(code.innerText).then(() => {
      const span = btn.querySelector("span");
      span.textContent = "Copied!";
      setTimeout(() => {
        span.textContent = "Copy";
      }, 2000);
    });
  }
}

// -------------------------------------------------------------
// Tunnel & Utility Functions
// -------------------------------------------------------------
async function checkTunnelStatus() {
  const el = document.getElementById("tunnelStatusText");
  if (!el) return;
  try {
    const res = await fetch("/api/tunnel/status", {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.active && data.url) {
      el.innerHTML = `<a href="${data.url}" target="_blank" class="text-emerald-400 underline font-medium">Cloudflare Active</a>`;
    } else {
      el.textContent = "Local Mode (8000)";
    }
  } catch (e) {}
}

async function openCliTerminal() {
  const btn = document.getElementById("openCliTerminalBtn");
  // Open embedded web terminal panel on the right
  if (!webTerminalOpen) {
    toggleWebTerminal();
  }

  const cmd = currentConversationId ? `agy --conversation ${currentConversationId}` : "agy -c";

  // Give socket half a second to connect if not ready, then write command
  setTimeout(() => {
    if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
      terminalSocket.send(JSON.stringify({ type: "input", data: cmd + "\r" }));
      showToast(`⚡ Executed in web terminal: ${cmd}`);
    } else {
      showToast(`📋 Command copied to clipboard: ${cmd}`);
      if (navigator.clipboard) navigator.clipboard.writeText(cmd);
    }
  }, 600);

  if (btn) {
    if (btn) btn.innerHTML = origHtml;
  }
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  sidebar.classList.toggle("-translate-x-full");
  backdrop.classList.toggle("hidden");
}

function fillPrompt(text) {
  promptInput.value = text;
  autoResizeTextarea(promptInput);
  promptInput.focus();
}

function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
}

function handleInputKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
}

function scrollToBottom() {
  chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
}

// -------------------------------------------------------------
// Quota & Limits Modal and Updates
// -------------------------------------------------------------
// Quota & Limits Modal and Updates (Antigravity Models)
// -------------------------------------------------------------
let currentQuotaData = {
  gemini: {
    weekly_percent: 97,
    weekly_refresh: "6 days, 23 hours",
    five_hour_percent: 81,
    five_hour_refresh: "4 hours, 16 minutes",
  },
  claude_gpt: {
    weekly_percent: 100,
    weekly_refresh: "7 days",
    five_hour_percent: 100,
    five_hour_refresh: "5 hours",
  }
};

function renderCircleRingSvg(percent, color = "#22c55e") {
  const p = Math.max(0, Math.min(100, percent));
  return `
    <svg class="w-9 h-9 transform -rotate-90" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#2a2a2a" stroke-width="3.8" />
      <circle cx="18" cy="18" r="15.9155" fill="none" stroke="${color}" stroke-width="3.8" stroke-dasharray="${p} 100" stroke-linecap="round" class="transition-all duration-700" />
    </svg>
  `;
}

function updateQuotaUI(data) {
  if (!data) return;

  // Update user account and live status badge
  const userAcc = document.getElementById("quotaUserAccount");
  if (userAcc && data.user) {
    userAcc.textContent = `Account: ${data.user.email || 'Verified'} · Plan: ${data.user.plan || 'Pro'}`;
  }
  const liveBadge = document.getElementById("quotaLiveBadge");
  if (liveBadge) {
    if (data.live) {
      liveBadge.textContent = "Live API Sync";
      liveBadge.className = "text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded-full border border-emerald-500/30 font-semibold";
    } else {
      liveBadge.textContent = "Cached Data";
      liveBadge.className = "text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full border border-amber-500/30 font-semibold";
    }
  }

  if (data.gemini) {
    const gwVal = document.getElementById("geminiWeeklyVal");
    const gwRefresh = document.getElementById("geminiWeeklyRefresh");
    const gwRing = document.getElementById("geminiWeeklyRing");
    const gwText = document.getElementById("geminiWeeklyText");
    if (gwVal) gwVal.textContent = `${data.gemini.weekly_percent}%`;
    if (gwRefresh) gwRefresh.textContent = data.gemini.weekly_refresh || "7 Days";
    if (gwRing) gwRing.innerHTML = renderCircleRingSvg(data.gemini.weekly_percent);
    if (gwText && data.gemini.weekly_desc) {
      gwText.innerHTML = escapeHtml(data.gemini.weekly_desc).replace(
        /(refresh in [^.]+)/,
        '<span class="text-neutral-300 font-medium">$1</span>'
      );
    }

    const g5Val = document.getElementById("gemini5hVal");
    const g5Refresh = document.getElementById("gemini5hRefresh");
    const g5Ring = document.getElementById("gemini5hRing");
    const g5Text = document.getElementById("gemini5hText");
    if (g5Val) g5Val.textContent = `${data.gemini.five_hour_percent}%`;
    if (g5Refresh) g5Refresh.textContent = data.gemini.five_hour_refresh || "5 Hours";
    if (g5Ring) g5Ring.innerHTML = renderCircleRingSvg(data.gemini.five_hour_percent);
    if (g5Text && data.gemini.five_hour_desc) {
      g5Text.innerHTML = escapeHtml(data.gemini.five_hour_desc).replace(
        /(refresh in [^.]+)/,
        '<span class="text-neutral-300 font-medium">$1</span>'
      );
    }
  }

  if (data.claude_gpt) {
    const cwVal = document.getElementById("claudeWeeklyVal");
    const cwRing = document.getElementById("claudeWeeklyRing");
    if (cwVal) cwVal.textContent = `${data.claude_gpt.weekly_percent}%`;
    if (cwRing) cwRing.innerHTML = renderCircleRingSvg(data.claude_gpt.weekly_percent);

    const c5Val = document.getElementById("claude5hVal");
    const c5Ring = document.getElementById("claude5hRing");
    if (c5Val) c5Val.textContent = `${data.claude_gpt.five_hour_percent}%`;
    if (c5Ring) c5Ring.innerHTML = renderCircleRingSvg(data.claude_gpt.five_hour_percent);
  }

  // Update bottom-right pill
  const badge = document.getElementById("quotaModelName");
  if (badge && data.gemini) {
    const isGemini = !selectedModel.includes("claude") && !selectedModel.includes("gpt");
    if (isGemini) {
      badge.textContent = `Gemini: ${data.gemini.five_hour_percent}% (5h) · ${data.gemini.weekly_percent}% (Weekly)`;
    } else if (data.claude_gpt) {
      badge.textContent = `Claude/GPT: ${data.claude_gpt.five_hour_percent}% (5h) · ${data.claude_gpt.weekly_percent}% (Weekly)`;
    }
  }
}

async function fetchQuotaData(force = false) {
  try {
    const url = force ? "/api/quota?force=true" : "/api/quota";
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && data.quota) {
      currentQuotaData = data.quota;
      updateQuotaUI(currentQuotaData);
      if (data.quota.tokens) {
        updateQuotaUsage(data.quota.tokens, false);
      }
    }
  } catch (e) {
    console.warn("Failed to fetch quota data:", e);
  }
}

function updateQuotaUsage(usage, triggerFetch = true) {
  if (!usage) return;
  const inTokens = usage.input_tokens || 0;
  const outTokens = usage.output_tokens || 0;
  const thinkTokens = usage.thinking_tokens || 0;
  const cacheTokens = usage.cache_read_tokens || 0;
  const total = usage.total_tokens || (inTokens + outTokens);

  const badge = document.getElementById("quotaTokenUsage");
  if (badge) {
    badge.textContent = `${total.toLocaleString()} tokens used`;
  }
  const dIn = document.getElementById("detailInputTokens");
  if (dIn) dIn.textContent = inTokens.toLocaleString();
  const dOut = document.getElementById("detailOutputTokens");
  if (dOut) dOut.textContent = outTokens.toLocaleString();
  const dThink = document.getElementById("detailThinkingTokens");
  if (dThink) dThink.textContent = thinkTokens.toLocaleString();
  const dCache = document.getElementById("detailCacheTokens");
  if (dCache) dCache.textContent = cacheTokens.toLocaleString();
  const dTot = document.getElementById("detailTotalTokens");
  if (dTot) dTot.textContent = `${total.toLocaleString()} tokens`;

  // Periodically refresh real quota from Google API when tokens are consumed
  if (triggerFetch && total > 0) {
    fetchQuotaData();
  }
}

function toggleQuotaModal() {
  const modal = document.getElementById("quotaModal");
  if (modal) {
    modal.classList.toggle("hidden");
    if (!modal.classList.contains("hidden")) {
      fetchQuotaData(true);
    }
  }
}

// -------------------------------------------------------------
// Unified Tools & Settings Dropdown Menu
// -------------------------------------------------------------
function toggleToolsDropdown() {
  const menu = document.getElementById("toolsMenu");
  if (!menu) return;
  menu.classList.toggle("hidden");
  updateToolsMenuStatus();
}

function handleMenuAction(actionFn) {
  const menu = document.getElementById("toolsMenu");
  if (menu) menu.classList.add("hidden");
  if (typeof actionFn === "function") {
    actionFn();
  }
}

// Close toolsMenu when clicking outside
document.addEventListener("click", (e) => {
  const btn = document.getElementById("toolsDropdownBtn");
  const menu = document.getElementById("toolsMenu");
  if (btn && menu && !btn.contains(e.target) && !menu.contains(e.target)) {
    menu.classList.add("hidden");
  }
});

function updateToolsMenuStatus() {
  const expStatus = document.getElementById("menuFileExplorerStatus");
  const termStatus = document.getElementById("menuWebTerminalStatus");
  const badge = document.getElementById("toolsActiveBadge");

  if (expStatus) {
    expStatus.textContent = fileExplorerOpen ? "Open ●" : "Closed";
    expStatus.className = fileExplorerOpen 
      ? "text-[10px] px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 font-mono font-semibold" 
      : "text-[10px] px-2 py-0.5 rounded-md bg-[#181818] text-[#888] font-mono";
  }
  if (termStatus) {
    termStatus.textContent = webTerminalOpen ? "Open ●" : "Closed";
    termStatus.className = webTerminalOpen 
      ? "text-[10px] px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 font-mono font-semibold" 
      : "text-[10px] px-2 py-0.5 rounded-md bg-[#181818] text-[#888] font-mono";
  }
  if (badge) {
    if (fileExplorerOpen || webTerminalOpen) {
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }
}

// -------------------------------------------------------------
// Feature 2: Tool Execution Approval Mode
// -------------------------------------------------------------
function updateApprovalModeUI() {
  const btn = document.getElementById("approvalModeBtn");
  const icon = document.getElementById("approvalModeIcon");
  const label = document.getElementById("approvalModeLabel");
  const menuIcon = document.getElementById("menuApprovalIcon");
  const menuBadge = document.getElementById("menuApprovalBadge");

  if (isApprovalMode) {
    if (icon) icon.textContent = "🛡️";
    if (label) label.textContent = "Approval Mode (Safe)";
    if (btn) {
      btn.className = "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border border-amber-500/60 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-all shadow-sm";
      btn.setAttribute("title", "Approval Mode active: Requires confirmation before tool execution. (Click to switch to Auto)");
    }
    if (menuIcon) menuIcon.textContent = "🛡️";
    if (menuBadge) {
      menuBadge.textContent = "Approval";
      menuBadge.className = "text-[10px] px-2 py-0.5 rounded-full font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30";
    }
  } else {
    if (icon) icon.textContent = "⚡";
    if (label) label.textContent = "Auto Execute";
    if (btn) {
      btn.className = "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border border-[#333333] hover:bg-[#2c2c2c] transition-all text-[#b4b4b4]";
      btn.setAttribute("title", "Auto Mode active: Automatically approves and executes tools. (Click to switch to Approval)");
    }
    if (menuIcon) menuIcon.textContent = "⚡";
    if (menuBadge) {
      menuBadge.textContent = "Auto Execute";
      menuBadge.className = "text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30";
    }
  }
}

function toggleApprovalMode() {
  isApprovalMode = !isApprovalMode;
  localStorage.setItem("ag_approval_mode", isApprovalMode);
  updateApprovalModeUI();
  showToast(isApprovalMode ? "🛡️ Tool execution: Approval Mode" : "⚡ Tool execution: Auto-Execute Mode");
}

function updateFileEditApprovalUI() {
  const btn = document.getElementById("fileEditApprovalBtn");
  const icon = document.getElementById("fileEditApprovalIcon");
  const label = document.getElementById("fileEditApprovalLabel");
  const menuIcon = document.getElementById("menuFileEditIcon");
  const menuBadge = document.getElementById("menuFileEditBadge");

  if (isFileEditApproval) {
    if (icon) icon.textContent = "🛡️";
    if (label) label.textContent = "File Edit Approval";
    if (btn) {
      btn.className = "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border border-amber-500/60 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-all shadow-sm";
      btn.setAttribute("title", "File Edit Approval ON: Prompts for review before modifying files. (Click to switch to Auto)");
    }
    if (menuIcon) menuIcon.textContent = "🛡️";
    if (menuBadge) {
      menuBadge.textContent = "Approval Mode";
      menuBadge.className = "text-[10px] px-2 py-0.5 rounded-full font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30";
    }
  } else {
    if (icon) icon.textContent = "✏️";
    if (label) label.textContent = "File Edit Auto";
    if (btn) {
      btn.className = "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border border-[#333333] hover:bg-[#2c2c2c] transition-all text-[#888888]";
      btn.setAttribute("title", "File Edit Auto Mode: File changes are approved automatically. (Click to switch to Approval)");
    }
    if (menuIcon) menuIcon.textContent = "✏️";
    if (menuBadge) {
      menuBadge.textContent = "Auto Approve";
      menuBadge.className = "text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30";
    }
  }
}

function toggleFileEditApproval() {
  isFileEditApproval = !isFileEditApproval;
  localStorage.setItem("ag_file_edit_approval", isFileEditApproval);
  updateFileEditApprovalUI();
  showToast(isFileEditApproval ? "🛡️ File Edit: Pre-Approval Mode" : "✏️ File Edit: Auto-Approval Mode");
}

function showFileEditApprovalBanner(actionId, data, targetContainer = null) {
  const existing = document.getElementById(`file-approval-${actionId}`);
  if (existing) return;

  const targetFile = data.target_file || (data.args && (data.args.TargetFile || data.args.AbsolutePath)) || "file";
  const instruction = data.instruction || (data.args && (data.args.Instruction || data.args.Description)) || "";
  const targetContent = data.target_content || (data.args && data.args.TargetContent) || "";
  const replacementContent = data.replacement_content || (data.args && (data.args.ReplacementContent || data.args.CodeContent)) || "";
  const hasDiff = Boolean(targetContent || replacementContent);

  const banner = document.createElement("div");
  banner.id = `file-approval-${actionId}`;
  banner.className = "file-edit-approval-card pending-approval-banner my-3 p-3 bg-[#1e1e1e] border-2 border-amber-500/50 rounded-xl shadow-lg animate-pulse transition-all";
  banner.innerHTML = `
    <div class="flex items-center justify-between gap-3 pb-2 border-b border-[#333333] flex-wrap">
      <div class="flex items-center gap-2.5 overflow-hidden">
        <div class="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-300 flex items-center justify-center flex-shrink-0 text-base">✏️</div>
        <div class="overflow-hidden">
          <div class="text-xs font-bold text-white flex items-center gap-1.5">
            <span>File Edit Permission Approval</span>
            <span class="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded font-mono">Pending</span>
          </div>
          <div class="text-[11px] font-mono text-emerald-400 mt-0.5 truncate max-w-sm sm:max-w-md" title="${escapeHtml(targetFile)}">
            📄 ${escapeHtml(targetFile)}
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0" id="file-approval-actions-${actionId}">
        <button type="button" onclick="handleFileApprovalResponse('${actionId}', true)" class="px-3 py-1.5 bg-[#10a37f] hover:bg-[#0e8e6e] text-white rounded-lg text-xs font-semibold transition-all shadow flex items-center gap-1">
          <span>✓</span><span>Approve (y)</span>
        </button>
        <button type="button" onclick="handleFileApprovalResponse('${actionId}', false)" class="px-2.5 py-1.5 bg-[#333333] hover:bg-[#444444] text-rose-400 hover:text-white rounded-lg text-xs font-medium transition-all flex items-center gap-1">
          <span>✕</span><span>Reject (n)</span>
        </button>
        <button type="button" onclick="toggleWebTerminal()" class="px-2.5 py-1.5 bg-[#262626] hover:bg-[#333333] text-neutral-300 rounded-lg text-xs font-medium transition-all flex items-center gap-1" title="Open Web Terminal">
          <span>🖥️ Terminal</span>
        </button>
      </div>
    </div>
    ${instruction ? `
      <div class="mt-2 text-xs text-[#d1d1d1] leading-relaxed">
        <span class="text-[#888888] font-medium">Changes:</span> ${escapeHtml(instruction)}
      </div>
    ` : ''}
    ${hasDiff ? `
      <div class="mt-2 pt-1 border-t border-[#2a2a2a]/60">
        <div class="flex items-center justify-between text-[11px] text-[#888888] mb-1.5">
          <span>Code Changes Preview</span>
          <button type="button" onclick="toggleFileDiff(this)" class="text-emerald-400 hover:underline text-[11px] flex items-center gap-1">
            <span>View Content ▾</span>
          </button>
        </div>
        <div class="file-diff-box hidden font-mono text-xs max-h-56 overflow-y-auto">
          ${targetContent ? `
            <div class="text-rose-400 mb-2">
              <div class="text-[10px] bg-rose-500/20 text-rose-300 px-1.5 py-0.5 rounded inline-block font-sans mb-1">- Before:</div>
              <pre class="whitespace-pre-wrap text-[11px] opacity-80 pl-2 border-l-2 border-rose-500/40">${escapeHtml(targetContent)}</pre>
            </div>
          ` : ''}
          ${replacementContent ? `
            <div class="text-emerald-400">
              <div class="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded inline-block font-sans mb-1">+ After:</div>
              <pre class="whitespace-pre-wrap text-[11px] pl-2 border-l-2 border-emerald-500/40">${escapeHtml(replacementContent)}</pre>
            </div>
          ` : ''}
        </div>
      </div>
    ` : ''}
  `;

  let mountNode = targetContainer || currentAssistantNode;
  if (mountNode) {
    const container = mountNode.querySelector(".markdown-body") || mountNode;
    if (container.parentNode) {
      container.parentNode.insertBefore(banner, container);
    } else {
      mountNode.appendChild(banner);
    }
  } else {
    messagesList.appendChild(banner);
  }
  smartScrollToBottom();
}

function handleFileApprovalResponse(actionId, approved) {
  const banner = document.getElementById(`file-approval-${actionId}`);
  const actionsDiv = document.getElementById(`file-approval-actions-${actionId}`);
  if (banner) {
    banner.classList.remove("animate-pulse");
    if (approved) {
      banner.style.borderColor = "rgba(16, 163, 127, 0.5)";
      banner.style.backgroundColor = "rgba(16, 163, 127, 0.08)";
      if (actionsDiv) {
        actionsDiv.innerHTML = `<span class="text-emerald-400 text-xs font-semibold px-2.5 py-1 bg-emerald-500/10 rounded-md border border-emerald-500/30">✓ File edit approved</span>`;
      }
    } else {
      banner.style.borderColor = "rgba(244, 63, 94, 0.5)";
      banner.style.backgroundColor = "rgba(244, 63, 94, 0.08)";
      if (actionsDiv) {
        actionsDiv.innerHTML = `<span class="text-rose-400 text-xs font-semibold px-2.5 py-1 bg-rose-500/10 rounded-md border border-rose-500/30">✕ File edit rejected</span>`;
      }
    }
  }

  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({
      action: "approval_response",
      action_id: actionId,
      approved: approved
    }));
  }

  if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
    terminalSocket.send(JSON.stringify({ type: "input", data: approved ? "y\r" : "n\r" }));
  }

  fetch("/api/approval", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${authToken}`
    },
    body: JSON.stringify({ action_id: actionId, approved: approved })
  }).catch(() => {});

  showToast(approved ? "✓ Approval sent (synced with terminal)" : "✕ Rejection sent");
}

function toggleFileDiff(btn) {
  const card = btn.closest(".file-edit-approval-card");
  if (!card) return;
  const diffBox = card.querySelector(".file-diff-box");
  const span = btn.querySelector("span") || btn;
  if (diffBox) {
    const isHidden = diffBox.classList.contains("hidden");
    if (isHidden) {
      diffBox.classList.remove("hidden");
      span.textContent = "Collapse Content ▴";
    } else {
      diffBox.classList.add("hidden");
      span.textContent = "View Content ▾";
    }
  }
}

function showApprovalBanner(actionId, toolName, toolDesc, targetNode = null) {
  const existing = document.getElementById(`approval-${actionId}`);
  if (existing) return;

  const banner = document.createElement("div");
  banner.id = `approval-${actionId}`;
  banner.className = "approval-banner pending-approval-banner flex items-center justify-between gap-3 my-3 p-3 bg-[#1e1e1e] border-2 border-amber-500/50 rounded-xl shadow-lg animate-pulse transition-all";
  banner.innerHTML = `
    <div class="flex items-center gap-2.5 overflow-hidden">
      <div class="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center flex-shrink-0 text-base">🛡️</div>
      <div class="overflow-hidden">
        <div class="text-xs font-bold text-white flex items-center gap-1.5">
          <span>Tool Execution Approval Required</span>
          <span class="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded font-mono">Pending</span>
        </div>
        <div class="text-[11px] text-[#b4b4b4] font-mono truncate max-w-md" title="${escapeHtml(toolName)}: ${escapeHtml(toolDesc)}">
          <strong class="text-white">${escapeHtml(toolName)}</strong>: <span class="text-amber-200">${escapeHtml(toolDesc)}</span>
        </div>
      </div>
    </div>
    <div class="flex items-center gap-2 flex-shrink-0" id="approval-actions-${actionId}">
      <button onclick="handleApprovalResponse('${actionId}', true)" class="px-3 py-1.5 bg-[#10a37f] hover:bg-[#0e8e6e] text-white rounded-lg text-xs font-semibold transition-all shadow flex items-center gap-1">
        <span>✓</span><span>Approve (y)</span>
      </button>
      <button onclick="handleApprovalResponse('${actionId}', false)" class="px-2.5 py-1.5 bg-[#333333] hover:bg-[#444444] text-rose-400 hover:text-white rounded-lg text-xs font-medium transition-all">
        <span>✕</span><span>Reject (n)</span>
      </button>
      <button type="button" onclick="toggleWebTerminal()" class="px-2.5 py-1.5 bg-[#262626] hover:bg-[#333333] text-neutral-300 rounded-lg text-xs font-medium transition-all flex items-center gap-1" title="Open Web Terminal">
        <span>🖥️ Terminal</span>
      </button>
    </div>
  `;

  let mountNode = targetNode || currentAssistantNode;
  if (mountNode) {
    const container = mountNode.querySelector(".markdown-body") || mountNode;
    if (container.parentNode) {
      container.parentNode.insertBefore(banner, container);
    } else {
      mountNode.appendChild(banner);
    }
  } else {
    messagesList.appendChild(banner);
  }
  smartScrollToBottom();
}

function handleApprovalResponse(actionId, approved) {
  const banner = document.getElementById(`approval-${actionId}`);
  const actionsDiv = document.getElementById(`approval-actions-${actionId}`);
  if (banner) {
    banner.classList.remove("animate-pulse");
    if (approved) {
      banner.style.borderColor = "rgba(16, 163, 127, 0.4)";
      banner.style.backgroundColor = "rgba(16, 163, 127, 0.08)";
      if (actionsDiv) {
        actionsDiv.innerHTML = `<span class="text-emerald-400 text-xs font-semibold px-2 py-1 bg-emerald-500/10 rounded-md">✓ Approved</span>`;
      }
    } else {
      banner.style.borderColor = "rgba(244, 63, 94, 0.4)";
      banner.style.backgroundColor = "rgba(244, 63, 94, 0.08)";
      if (actionsDiv) {
        actionsDiv.innerHTML = `<span class="text-rose-400 text-xs font-semibold px-2 py-1 bg-rose-500/10 rounded-md">✕ Rejected</span>`;
      }
    }
  }

  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({
      action: "approval_response",
      action_id: actionId,
      approved: approved
    }));
  }

  if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
    terminalSocket.send(JSON.stringify({ type: "input", data: approved ? "y\r" : "n\r" }));
  }

  fetch("/api/approval", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${authToken}`
    },
    body: JSON.stringify({ action_id: actionId, approved: approved })
  }).catch(() => {});

  showToast(approved ? "✓ Approval sent (synced with terminal)" : "✕ Rejection sent");
}

function showQuestionApprovalCard(data, targetContainer = null) {
  const existing = document.getElementById(`question-card-${data.action_id}`);
  if (existing) return;

  const card = document.createElement("div");
  card.id = `question-card-${data.action_id}`;
  card.className = "question-approval-card pending-approval-banner my-3 p-4 bg-[#1e1e1e] border-2 border-amber-500/60 rounded-2xl shadow-xl animate-pulse transition-all";

  let questionsHtml = "";
  const questions = Array.isArray(data.questions) ? data.questions : [];
  questions.forEach((q, qIdx) => {
    questionsHtml += `
      <div class="mb-3 last:mb-0">
        <div class="text-sm font-semibold text-amber-300 flex items-center gap-2 mb-2">
          <span>❓</span>
          <span>${escapeHtml(q.question || "Question")}</span>
        </div>
        <div class="space-y-1.5 pl-6">
          ${(q.options || []).map((opt, oIdx) => `
            <button type="button" onclick="submitQuestionAnswer('${data.action_id}', ${qIdx}, '${escapeHtml(opt)}', ${oIdx + 1})" 
              class="w-full text-left px-3 py-2 text-xs rounded-xl bg-[#2a2a2a] hover:bg-[#333333] hover:border-amber-500/60 border border-[#3a3a3a] text-[#ececec] transition-all flex items-center justify-between group">
              <span class="flex items-center gap-2">
                <span class="w-5 h-5 rounded-full bg-[#1e1e1e] text-amber-400 flex items-center justify-center font-mono text-[10px] font-bold group-hover:bg-amber-500 group-hover:text-black">${oIdx + 1}</span>
                <span>${escapeHtml(opt)}</span>
              </span>
              <span class="text-[10px] text-[#737373] group-hover:text-amber-300 font-mono">Select ↵</span>
            </button>
          `).join("")}
        </div>
      </div>
    `;
  });

  card.innerHTML = `
    <div class="flex items-center justify-between pb-2 border-b border-[#333333] mb-3">
      <div class="flex items-center gap-2">
        <span class="text-base">⚡</span>
        <span class="text-xs font-bold text-amber-400">Console Input / User Choice Required</span>
      </div>
      <span class="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full font-mono font-semibold">Pending</span>
    </div>
    ${questionsHtml}
    <div class="mt-3 pt-2 border-t border-[#333333] flex items-center justify-between text-[11px] text-[#888]">
      <span>💡 Synced with console terminal. Click option to send answer.</span>
      <button onclick="toggleWebTerminal()" class="text-emerald-400 hover:underline font-mono text-[11px]">🖥️ Open Terminal</button>
    </div>
  `;

  let mountNode = targetContainer || currentAssistantNode;
  if (mountNode) {
    const container = mountNode.querySelector(".markdown-body") || mountNode;
    if (container.parentNode) {
      container.parentNode.insertBefore(card, container);
    } else {
      mountNode.appendChild(card);
    }
  } else {
    messagesList.appendChild(card);
  }
  smartScrollToBottom();
}

function submitQuestionAnswer(actionId, qIdx, answerText, optionNum) {
  const card = document.getElementById(`question-card-${actionId}`);
  if (card) {
    card.classList.remove("animate-pulse");
    card.style.borderColor = "rgba(16, 163, 127, 0.6)";
    card.style.backgroundColor = "rgba(16, 163, 127, 0.1)";
  }

  showToast(`Selected: [${optionNum}] ${answerText}`);

  if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
    terminalSocket.send(JSON.stringify({ type: "input", data: `${optionNum}\r` }));
  }

  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({
      action: "question_response",
      action_id: actionId,
      answer: answerText,
      option_num: optionNum
    }));
  }

  fetch("/api/approval", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${authToken}`
    },
    body: JSON.stringify({ action_id: actionId, approved: true, answer: answerText, option_num: optionNum })
  }).catch(() => {});
}

function handlePendingActionUI(pending) {
  if (!pending) {
    document.querySelectorAll(".pending-approval-banner").forEach(el => el.remove());
    return;
  }

  let targetContainer = currentAssistantNode;
  if (!targetContainer) {
    const bubbles = messagesList.querySelectorAll('[id^="msg-turn-"]');
    if (bubbles.length > 0) {
      targetContainer = bubbles[bubbles.length - 1];
    }
  }

  if (pending.is_question) {
    showQuestionApprovalCard(pending, targetContainer);
  } else if (pending.is_file_edit) {
    showFileEditApprovalBanner(pending.action_id, pending, targetContainer);
  } else {
    showApprovalBanner(pending.action_id, pending.name || "Command execution", pending.cmd || pending.name, targetContainer);
  }
}

// -------------------------------------------------------------
// Feature 4: Voice Dictation (Web Speech API)
// -------------------------------------------------------------
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert("Speech recognition is not supported in this browser. Chrome, Edge, or Safari is recommended.");
    return null;
  }

  const rec = new SpeechRecognition();
  rec.lang = "ko-KR";
  rec.continuous = true;
  rec.interimResults = true;

  rec.onstart = () => {
    isListening = true;
    const micBtn = document.getElementById("micBtn");
    if (micBtn) {
      micBtn.classList.add("mic-listening");
      micBtn.setAttribute("title", "Listening... (Click to stop)");
    }
    const input = document.getElementById("promptInput");
    if (input && !input.value) {
      input.setAttribute("placeholder", "Speak now... (Listening)");
    }
  };

  rec.onresult = (event) => {
    let finalStr = "";
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalStr += event.results[i][0].transcript;
      }
    }
    if (finalStr) {
      const input = document.getElementById("promptInput");
      if (input) {
        if (input.value && !input.value.endsWith(" ")) {
          input.value += " " + finalStr.trim();
        } else {
          input.value += finalStr.trim();
        }
        autoResizeTextarea(input);
      }
    }
  };

  rec.onerror = (event) => {
    console.warn("Speech recognition error:", event.error);
    if (event.error === "not-allowed") {
      alert("Microphone permission is required. Please allow mic access in your browser settings.");
    }
    stopVoiceDictation();
  };

  rec.onend = () => {
    stopVoiceDictation();
  };

  return rec;
}

function toggleVoiceDictation() {
  if (isListening) {
    if (speechRecognition) {
      speechRecognition.stop();
    }
    stopVoiceDictation();
  } else {
    if (!speechRecognition) {
      speechRecognition = initSpeechRecognition();
    }
    if (speechRecognition) {
      try {
        speechRecognition.start();
      } catch (e) {
        console.error("Speech recognition start failed:", e);
      }
    }
  }
}

function stopVoiceDictation() {
  isListening = false;
  const micBtn = document.getElementById("micBtn");
  if (micBtn) {
    micBtn.classList.remove("mic-listening");
    micBtn.setAttribute("title", "Voice Input (Microphone)");
  }
  const input = document.getElementById("promptInput");
  if (input && input.getAttribute("placeholder") && input.getAttribute("placeholder").includes("Speak")) {
    input.setAttribute("placeholder", "Instruct Antigravity Agent or drag and drop files here...");
  }
}

// -------------------------------------------------------------
// Feature 5: Terminal Console Output Viewer & Helper
// -------------------------------------------------------------
function toggleTerminalView(btn) {
  const wrapper = btn.closest(".action-row-container") || btn.closest(".action-run-wrapper");
  if (!wrapper) return;
  const box = wrapper.querySelector(".terminal-box");
  const badge = wrapper.querySelector(".terminal-badge") || btn.querySelector("span");
  if (box) {
    const isHidden = box.classList.contains("hidden");
    if (isHidden) {
      box.classList.remove("hidden");
      if (badge) badge.textContent = "Collapse Terminal ▴";
    } else {
      box.classList.add("hidden");
      if (badge) badge.textContent = "View Terminal ▾";
    }
  }
}

function copyTerminalText(btn) {
  const box = btn.closest(".terminal-box");
  const body = box ? box.querySelector(".terminal-body") : null;
  if (body) {
    navigator.clipboard.writeText(body.innerText).then(() => {
      const span = btn.querySelector("span");
      if (span) {
        span.textContent = "Copied!";
        setTimeout(() => { span.textContent = "Copy"; }, 2000);
      }
    });
  }
}

// ====================================================================
// FEATURE 1: Slash Command Autocomplete
// ====================================================================

const SLASH_COMMANDS = [
  { cmd: "/plan",           icon: "🗺️",  desc: "Create step-by-step plan before execution" },
  { cmd: "/goal",           icon: "🎯",  desc: "Run thoroughly until goal is achieved" },
  { cmd: "/schedule",       icon: "⏰",  desc: "Run on schedule or recurring timer" },
  { cmd: "/learn",          icon: "📚",  desc: "Learn user patterns and behaviors" },
  { cmd: "/boost",          icon: "🚀",  desc: "Deep analysis, multi-angle review & verification" },
  { cmd: "/browser",        icon: "🌐",  desc: "Web browser navigation & page actions" },
  { cmd: "/grill-me",       icon: "🔥",  desc: "Interactive interview to align on plan" },
  { cmd: "/teamwork-preview", icon: "👥", desc: "Multi-agent team parallel collaboration" },
];

let slashPopupActive = false;
let slashSelectedIndex = -1;
let slashFilteredCmds = [];

function setupSlashCommands() {
  const input = document.getElementById("promptInput");
  const popup = document.getElementById("slashCommandPopup");
  if (!input || !popup) return;

  input.addEventListener("input", () => {
    const val = input.value;
    const lastSlash = val.lastIndexOf("/");
    if (lastSlash !== -1 && !val.slice(lastSlash).includes(" ")) {
      const query = val.slice(lastSlash + 1).toLowerCase();
      slashFilteredCmds = SLASH_COMMANDS.filter(c => c.cmd.slice(1).startsWith(query));
      if (slashFilteredCmds.length > 0) {
        slashSelectedIndex = 0;
        renderSlashPopup(slashFilteredCmds);
        positionSlashPopup(input, popup);
        popup.classList.remove("hidden");
        slashPopupActive = true;
        return;
      }
    }
    closeSlashPopup();
  });

  input.addEventListener("keydown", (e) => {
    if (!slashPopupActive) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashSelectedIndex = (slashSelectedIndex + 1) % slashFilteredCmds.length;
      renderSlashPopup(slashFilteredCmds);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      slashSelectedIndex = (slashSelectedIndex - 1 + slashFilteredCmds.length) % slashFilteredCmds.length;
      renderSlashPopup(slashFilteredCmds);
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (slashSelectedIndex >= 0 && slashFilteredCmds[slashSelectedIndex]) {
        e.preventDefault();
        applySlashCommand(slashFilteredCmds[slashSelectedIndex].cmd);
      }
    } else if (e.key === "Escape") {
      closeSlashPopup();
    }
  });

  document.addEventListener("click", (e) => {
    if (!popup.contains(e.target) && e.target !== input) {
      closeSlashPopup();
    }
  });
}

function renderSlashPopup(cmds) {
  const list = document.getElementById("slashCommandList");
  if (!list) return;
  list.innerHTML = cmds.map((c, i) => `
    <div class="slash-cmd-item flex items-center gap-3 px-3 py-2 cursor-pointer transition-all ${i === slashSelectedIndex ? 'bg-[#10a37f]/20 border-l-2 border-[#10a37f]' : 'hover:bg-[#333] border-l-2 border-transparent'}"
         onclick="applySlashCommand('${c.cmd}')">
      <span class="text-base flex-shrink-0">${c.icon}</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-mono font-semibold text-white">${c.cmd}</div>
        <div class="text-[11px] text-[#999] truncate">${c.desc}</div>
      </div>
    </div>
  `).join("");
}

function positionSlashPopup(input, popup) {
  const rect = input.getBoundingClientRect();
  popup.style.left = rect.left + "px";
  popup.style.bottom = (window.innerHeight - rect.top + 6) + "px";
  popup.style.top = "auto";
  popup.style.width = Math.max(rect.width, 288) + "px";
}

function applySlashCommand(cmd) {
  const input = document.getElementById("promptInput");
  if (!input) return;
  const val = input.value;
  const lastSlash = val.lastIndexOf("/");
  if (lastSlash !== -1) {
    input.value = val.slice(0, lastSlash) + cmd + " ";
  } else {
    input.value = cmd + " ";
  }
  closeSlashPopup();
  input.focus();
  autoResizeTextarea(input);
}

function closeSlashPopup() {
  const popup = document.getElementById("slashCommandPopup");
  if (popup) popup.classList.add("hidden");
  slashPopupActive = false;
  slashSelectedIndex = -1;
  slashFilteredCmds = [];
}


// ====================================================================
// FEATURE 2: Project File Explorer & Code Viewer
// ====================================================================

let fileExplorerOpen = false;
let fileExplorerCurrentPath = "";
let fileViewerCurrentPath = "";
let fileViewerOriginalContent = "";

function toggleFileExplorer() {
  fileExplorerOpen = !fileExplorerOpen;
  const panel = document.getElementById("fileExplorerPanel");
  const btn = document.getElementById("fileExplorerBtn");
  if (!panel) return;

  if (fileExplorerOpen) {
    // If web terminal is open, close it to avoid clutter
    if (webTerminalOpen) {
      toggleWebTerminal();
    }
    panel.classList.remove("hidden");
    btn && btn.classList.add("border-[#10a37f]/60", "text-[#10a37f]", "bg-[#10a37f]/10");
    loadFileExplorer(fileExplorerCurrentPath);
    adjustMainLayout();
  } else {
    panel.classList.add("hidden");
    btn && btn.classList.remove("border-[#10a37f]/60", "text-[#10a37f]", "bg-[#10a37f]/10");
    adjustMainLayout();
  }
  updateToolsMenuStatus();
}


async function loadFileExplorer(path = "") {
  const tree = document.getElementById("fileExplorerTree");
  const breadcrumb = document.getElementById("fileExplorerBreadcrumb");
  if (!tree) return;

  tree.innerHTML = `<div class="px-4 py-8 text-center text-[#555] text-xs">Loading...</div>`;
  fileExplorerCurrentPath = path;

  try {
    const url = `/api/files?path=${encodeURIComponent(path)}`;
    const res = await fetch(url, { headers: { "Authorization": `Bearer ${authToken}` } });
    const data = await res.json();

    if (!data.ok) {
      tree.innerHTML = `<div class="px-4 py-4 text-[#e55] text-xs">Error: ${escapeHtml(data.detail || "Unknown error")}</div>`;
      return;
    }

    // Update breadcrumb
    if (breadcrumb) {
      breadcrumb.textContent = path ? `/ ${path}` : "/ (Project Root)";
    }

    if (data.type === "file") {
      // Shouldn't get here normally, but open viewer anyway
      openFileViewer(data);
      loadFileExplorer(path.split("/").slice(0, -1).join("/"));
      return;
    }

    // Render entries
    if (!data.entries || data.entries.length === 0) {
      tree.innerHTML = `<div class="px-4 py-8 text-center text-[#555] text-xs">Directory is empty.</div>`;
      return;
    }

    tree.innerHTML = data.entries.map(entry => {
      const isDir = entry.type === "dir";
      const icon = isDir ? "📁" : getFileIcon(entry.ext);
      const sizeStr = (!isDir && entry.size != null) ? formatFileSize(entry.size) : "";
      return `<div class="flex items-center gap-2 px-3 py-1.5 hover:bg-[#252525] cursor-pointer group text-sm transition-all"
                   onclick="${isDir ? `loadFileExplorer('${entry.path}')` : `openFile('${entry.path}')`}">
        <span class="text-base flex-shrink-0">${icon}</span>
        <span class="flex-1 truncate text-[#d4d4d4] font-${isDir ? 'medium' : 'normal'} text-[13px]">${escapeHtml(entry.name)}</span>
        ${sizeStr ? `<span class="text-[10px] text-[#555] flex-shrink-0 group-hover:hidden">${sizeStr}</span>` : ""}
        ${!isDir ? `
          <button onclick="downloadFile(event, '${escapeHtml(entry.path)}', '${escapeHtml(entry.name)}')"
                  class="opacity-0 group-hover:opacity-100 p-1 hover:bg-[#383838] text-[#aaa] hover:text-white rounded transition-all flex-shrink-0 text-xs"
                  title="Download">
            📥
          </button>
        ` : ""}
      </div>`;
    }).join("");

  } catch (e) {
    tree.innerHTML = `<div class="px-4 py-4 text-[#e55] text-xs">Connection Error: ${escapeHtml(e.message)}</div>`;
  }
}

function fileExplorerGoUp() {
  if (!fileExplorerCurrentPath) return;
  const parts = fileExplorerCurrentPath.split("/").filter(Boolean);
  parts.pop();
  loadFileExplorer(parts.join("/"));
}

function fileExplorerRefresh() {
  loadFileExplorer(fileExplorerCurrentPath);
}

async function openFile(path) {
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    const data = await res.json();
    if (data.ok && data.type === "file") {
      openFileViewer(data);
    }
  } catch (e) {
    console.error("File open error:", e);
  }
}

let fileViewerDirty = false;
let editorListenersAttached = false;

function openFileViewer(fileData) {
  const modal = document.getElementById("fileViewerModal");
  const iconEl = document.getElementById("fileViewerIcon");
  const nameEl = document.getElementById("fileViewerName");
  const pathEl = document.getElementById("fileViewerPath");
  const textarea = document.getElementById("fileViewerTextarea");
  const highlight = document.getElementById("fileViewerHighlight");
  const codeEl = document.getElementById("fileViewerCode");
  const saveBtn = document.getElementById("fileViewerSaveBtn");
  const dirtyBadge = document.getElementById("fileViewerDirtyBadge");
  const typeEl = document.getElementById("editorFileType");
  const saveStatus = document.getElementById("editorSaveStatus");
  if (!modal) return;

  fileViewerCurrentPath = fileData.path;
  fileViewerOriginalContent = fileData.content || "";
  fileViewerDirty = false;

  if (iconEl) iconEl.textContent = getFileIcon(fileData.ext);
  if (nameEl) nameEl.textContent = fileData.name;
  if (pathEl) pathEl.textContent = fileData.path;
  if (dirtyBadge) dirtyBadge.classList.add("hidden");
  if (saveStatus) {
    saveStatus.textContent = "Saved ✓";
    saveStatus.className = "text-emerald-400";
  }
  if (typeEl) {
    typeEl.textContent = fileData.ext ? fileData.ext.toUpperCase() : "Plain Text";
  }

  // Determine editability
  const nonEditableExts = ["png","jpg","jpeg","gif","webp","bmp","ico","pdf","zip","tar","gz","rar","7z","exe","dll","so","dylib","woff","woff2","ttf","eot","mp3","mp4","mov","avi"];
  const isBinary = nonEditableExts.includes((fileData.ext || "").toLowerCase());

  if (!isBinary) {
    if (textarea) {
      textarea.classList.remove("hidden");
      textarea.value = fileViewerOriginalContent;
      textarea.readOnly = false;
      updateEditorGutter();
      updateEditorStats();
    }
    if (highlight) highlight.classList.add("hidden");
    if (saveBtn) saveBtn.classList.remove("hidden");
    setEditorDirty(false);
    initEditorEventListeners();
  } else {
    if (textarea) textarea.classList.add("hidden");
    if (highlight) highlight.classList.remove("hidden");
    if (codeEl) {
      codeEl.className = "text-sm text-[#888]";
      codeEl.textContent = `[Binary file or preview not supported: ${fileData.name}]`;
    }
    if (saveBtn) saveBtn.classList.add("hidden");
    const gutter = document.getElementById("fileEditorGutter");
    if (gutter) gutter.innerHTML = "";
  }

  modal.classList.remove("hidden");
  if (textarea && !isBinary) {
    setTimeout(() => {
      textarea.focus();
      updateEditorGutter();
    }, 100);
  }
}

function updateEditorGutter() {
  const textarea = document.getElementById("fileViewerTextarea");
  const gutter = document.getElementById("fileEditorGutter");
  if (!textarea || !gutter) return;

  const lines = (textarea.value.match(/\n/g) || []).length + 1;
  let gutterHtml = "";
  for (let i = 1; i <= lines; i++) {
    gutterHtml += `<div>${i}</div>`;
  }
  gutter.innerHTML = gutterHtml;
  gutter.scrollTop = textarea.scrollTop;
}

function updateEditorStats() {
  const textarea = document.getElementById("fileViewerTextarea");
  const statsEl = document.getElementById("editorStats");
  const cursorEl = document.getElementById("editorCursorPos");
  if (!textarea) return;

  const val = textarea.value;
  const lineCount = (val.match(/\n/g) || []).length + 1;
  const charCount = val.length;
  if (statsEl) statsEl.textContent = `${lineCount.toLocaleString()} lines | ${charCount.toLocaleString()} chars`;

  if (cursorEl) {
    const selStart = textarea.selectionStart || 0;
    const textBefore = val.substring(0, selStart);
    const lineNum = (textBefore.match(/\n/g) || []).length + 1;
    const colNum = selStart - textBefore.lastIndexOf("\n");
    cursorEl.textContent = `Ln ${lineNum}, Col ${colNum}`;
  }
}

function setEditorDirty(dirty) {
  fileViewerDirty = dirty;
  const dirtyBadge = document.getElementById("fileViewerDirtyBadge");
  const saveStatus = document.getElementById("editorSaveStatus");
  const saveBtn = document.getElementById("fileViewerSaveBtn");

  if (dirty) {
    if (dirtyBadge) dirtyBadge.classList.remove("hidden");
    if (saveStatus) {
      saveStatus.textContent = "Modified (Ctrl+S)";
      saveStatus.className = "text-amber-400 font-semibold";
    }
    if (saveBtn) {
      saveBtn.classList.remove("bg-[#10a37f]", "hover:bg-[#0e8e6e]");
      saveBtn.classList.add("bg-amber-600", "hover:bg-amber-500");
    }
  } else {
    if (dirtyBadge) dirtyBadge.classList.add("hidden");
    if (saveStatus) {
      saveStatus.textContent = "Saved ✓";
      saveStatus.className = "text-emerald-400";
    }
    if (saveBtn) {
      saveBtn.classList.remove("bg-amber-600", "hover:bg-amber-500");
      saveBtn.classList.add("bg-[#10a37f]", "hover:bg-[#0e8e6e]");
    }
  }
}

function initEditorEventListeners() {
  if (editorListenersAttached) return;
  const textarea = document.getElementById("fileViewerTextarea");
  const gutter = document.getElementById("fileEditorGutter");
  if (!textarea) return;

  editorListenersAttached = true;

  // Sync scroll
  textarea.addEventListener("scroll", () => {
    if (gutter) gutter.scrollTop = textarea.scrollTop;
  });

  // Track edits
  textarea.addEventListener("input", () => {
    updateEditorGutter();
    updateEditorStats();
    setEditorDirty(textarea.value !== fileViewerOriginalContent);
  });

  // Cursor tracking
  textarea.addEventListener("keyup", updateEditorStats);
  textarea.addEventListener("click", updateEditorStats);
  textarea.addEventListener("select", updateEditorStats);

  // Keyboard Shortcuts (Tab / Shift+Tab, Ctrl+S, Esc)
  textarea.addEventListener("keydown", (e) => {
    // Ctrl+S or Cmd+S
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveFileFromViewer();
      return;
    }

    // Escape
    if (e.key === "Escape") {
      e.preventDefault();
      closeFileViewer();
      return;
    }

    // Tab key indent
    if (e.key === "Tab") {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;

      if (!e.shiftKey) {
        // Insert 2 spaces
        textarea.value = val.substring(0, start) + "  " + val.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      } else {
        // Unindent current line
        const lineStart = val.lastIndexOf("\n", start - 1) + 1;
        if (val.substring(lineStart, lineStart + 2) === "  ") {
          textarea.value = val.substring(0, lineStart) + val.substring(lineStart + 2);
          textarea.selectionStart = textarea.selectionEnd = Math.max(lineStart, start - 2);
        } else if (val.charAt(lineStart) === " ") {
          textarea.value = val.substring(0, lineStart) + val.substring(lineStart + 1);
          textarea.selectionStart = textarea.selectionEnd = Math.max(lineStart, start - 1);
        }
      }
      updateEditorGutter();
      updateEditorStats();
      setEditorDirty(textarea.value !== fileViewerOriginalContent);
    }
  });
}

async function saveFileFromViewer() {
  const textarea = document.getElementById("fileViewerTextarea");
  const saveStatus = document.getElementById("editorSaveStatus");
  if (!textarea || !fileViewerCurrentPath) return;

  const content = textarea.value;
  if (saveStatus) {
    saveStatus.textContent = "Saving...";
    saveStatus.className = "text-sky-400";
  }

  try {
    const res = await fetch("/api/files/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`
      },
      body: JSON.stringify({ path: fileViewerCurrentPath, content })
    });
    const data = await res.json();
    if (data.ok) {
      fileViewerOriginalContent = content;
      setEditorDirty(false);
      showToast("✅ File saved: " + fileViewerCurrentPath);
    } else {
      if (saveStatus) {
        saveStatus.textContent = "Save Failed ✗";
        saveStatus.className = "text-rose-400 font-semibold";
      }
      showToast("❌ Save failed: " + (data.detail || "Error"), "error");
    }
  } catch (e) {
    if (saveStatus) {
      saveStatus.textContent = "Save Error ✗";
      saveStatus.className = "text-rose-400 font-semibold";
    }
    showToast("❌ Save error: " + e.message, "error");
  }
}

async function downloadFile(e, path, filename) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  if (!path) return;
  const name = filename || path.split("/").pop();

  try {
    showToast(`📥 Downloading: ${name}`);
    const res = await fetch(`/api/files/download?path=${encodeURIComponent(path)}`, {
      headers: { "Authorization": `Bearer ${authToken}` }
    });

    if (!res.ok) {
      let errDetail = "Download failed";
      try {
        const errJson = await res.json();
        errDetail = errJson.detail || errDetail;
      } catch (_) {}
      throw new Error(errDetail);
    }

    const blob = await res.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => window.URL.revokeObjectURL(blobUrl), 1000);
    showToast(`✅ Downloaded: ${name}`);
  } catch (err) {
    showToast(`❌ Download error: ${err.message}`, "error");
  }
}

function downloadCurrentFileViewer() {
  if (!fileViewerCurrentPath) return;
  const nameEl = document.getElementById("fileViewerName");
  const filename = nameEl ? nameEl.textContent : "";
  downloadFile(null, fileViewerCurrentPath, filename);
}

function closeFileViewer() {
  if (fileViewerDirty) {
    if (!confirm("You have unsaved changes. Are you sure you want to close?")) {
      return;
    }
  }
  const modal = document.getElementById("fileViewerModal");
  if (modal) modal.classList.add("hidden");
  fileViewerDirty = false;
}

function getFileIcon(ext) {
  const icons = {
    "py": "🐍", "js": "📜", "ts": "📘", "jsx": "⚛️", "tsx": "⚛️",
    "html": "🌐", "css": "🎨", "json": "📋", "yaml": "📋", "yml": "📋",
    "md": "📝", "txt": "📄", "sh": "⚡", "bat": "⚡", "env": "🔒",
    "png": "🖼️", "jpg": "🖼️", "jpeg": "🖼️", "gif": "🖼️", "svg": "🖼️",
    "pdf": "📕", "zip": "📦", "tar": "📦", "gz": "📦",
    "toml": "⚙️", "ini": "⚙️", "cfg": "⚙️", "conf": "⚙️",
  };
  return icons[ext] || "📄";
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

function showToast(msg, type = "success") {
  const t = document.createElement("div");
  t.className = `fixed bottom-24 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-xl text-sm font-medium shadow-2xl border transition-all ${
    type === "error" ? "bg-rose-950 border-rose-700 text-rose-300" : "bg-emerald-950 border-emerald-700 text-emerald-300"
  }`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transform = "translateX(-50%) translateY(10px)";
    setTimeout(() => t.remove(), 400);
  }, 2500);
}


// ====================================================================
// FEATURE 3: Browser Web Terminal (Xterm.js + WebSocket)
// ====================================================================

let xtermInstance = null;
let xtermFitAddon = null;
let terminalSocket = null;
let webTerminalOpen = false;

function adjustMainLayout(overrideWidth = null) {
  const main = document.getElementById("mainContent");
  const termPanel = document.getElementById("webTerminalPanel");
  const filePanel = document.getElementById("fileExplorerPanel");
  if (!main) return;

  // On small mobile screens, do not push main content, let panel overlay
  if (window.innerWidth < 768) {
    main.style.marginRight = "0px";
    return;
  }

  let rightMargin = 0;
  if (overrideWidth !== null) {
    rightMargin = overrideWidth;
  } else if (webTerminalOpen && termPanel && !termPanel.classList.contains("hidden")) {
    rightMargin = termPanel.offsetWidth || 480;
  } else if (fileExplorerOpen && filePanel && !filePanel.classList.contains("hidden")) {
    rightMargin = filePanel.offsetWidth || 320;
  }

  main.style.marginRight = rightMargin + "px";
}

// Adjust layout on window resize
window.addEventListener("resize", () => {
  adjustMainLayout();
  fitTerminal();
});

let currentTermTab = "shell"; // "shell" or "agy"

function toggleWebTerminal() {
  webTerminalOpen = !webTerminalOpen;
  const panel = document.getElementById("webTerminalPanel");
  const btn = document.getElementById("webTerminalBtn");
  if (!panel) return;

  if (webTerminalOpen) {
    // If file explorer is open, close it to avoid dual overlay
    if (fileExplorerOpen) {
      toggleFileExplorer();
    }
    panel.classList.remove("hidden");
    btn && btn.classList.add("border-emerald-500/60", "text-emerald-400", "bg-emerald-500/10");
    initXterm();
    adjustMainLayout();
  } else {
    panel.classList.add("hidden");
    btn && btn.classList.remove("border-emerald-500/60", "text-emerald-400", "bg-emerald-500/10");
    if (terminalSocket) {
      try {
        terminalSocket.onclose = null;
        terminalSocket.onerror = null;
        terminalSocket.close();
      } catch (e) {}
      terminalSocket = null;
    }
    adjustMainLayout();
  }
  updateToolsMenuStatus();
}


let isTerminalComposing = false;
let terminalIncomingQueue = [];
let terminalFlushTimer = null;

function flushTerminalQueue() {
  if (isTerminalComposing) return;
  if (terminalIncomingQueue.length > 0 && xtermInstance) {
    const chunk = terminalIncomingQueue.join("");
    terminalIncomingQueue = [];
    xtermInstance.write(chunk);
  }
}

function initXterm() {
  const container = document.getElementById("webTerminalXterm");
  if (!container) return;

  // Re-use if already initialized
  if (xtermInstance) {
    fitTerminal();
    if (!terminalSocket || terminalSocket.readyState !== WebSocket.OPEN) {
      connectTerminalSocket();
    }
    setupTerminalCmdInput();
    return;
  }

  if (!window.Terminal) {
    const statusEl = document.getElementById("webTerminalStatus");
    if (statusEl) statusEl.textContent = "Failed to load Xterm.js";
    return;
  }

  xtermInstance = new Terminal({
    theme: {
      background: "#0d0d0d",
      foreground: "#e0e0e0",
      cursor: "#10a37f",
      selectionBackground: "#10a37f44",
    },
    fontFamily: "'Cascadia Code', 'Consolas', 'Malgun Gothic', 'NanumGothicCoding', 'D2Coding', monospace",
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    convertEol: true,
    allowProposedApi: true,
    windowsPty: {
      backend: 'conpty',
      buildNumber: 19045
    }
  });

  if (window.FitAddon) {
    xtermFitAddon = new FitAddon.FitAddon();
    xtermInstance.loadAddon(xtermFitAddon);
  }

  xtermInstance.open(container);
  fitTerminal();

  // Attach IME composition listeners to xterm helper textarea
  const termTextarea = container.querySelector(".xterm-helper-textarea") || xtermInstance.textarea;
  if (termTextarea) {
    termTextarea.addEventListener("compositionstart", () => {
      isTerminalComposing = true;
      if (terminalFlushTimer) {
        clearTimeout(terminalFlushTimer);
        terminalFlushTimer = null;
      }
    });

    termTextarea.addEventListener("compositionend", () => {
      isTerminalComposing = false;
      if (terminalFlushTimer) clearTimeout(terminalFlushTimer);
      terminalFlushTimer = setTimeout(() => {
        flushTerminalQueue();
      }, 35);
    });
  }

  xtermInstance.onData((data) => {
    if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
      terminalSocket.send(JSON.stringify({ type: "input", data }));
    }
  });

  connectTerminalSocket();
  setupTerminalCmdInput();

  // Handle resize
  window.addEventListener("resize", fitTerminal);
}

function fitTerminal() {
  if (xtermFitAddon) {
    try {
      xtermFitAddon.fit();
      if (xtermInstance && terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
        const { cols, rows } = xtermInstance;
        terminalSocket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    } catch (e) {}
  }
}

function connectTerminalSocket() {
  if (terminalSocket) {
    try {
      terminalSocket.onclose = null;
      terminalSocket.onerror = null;
      terminalSocket.close();
    } catch (e) {}
    terminalSocket = null;
  }

  const statusEl = document.getElementById("webTerminalStatus");
  if (statusEl) statusEl.textContent = "Connecting...";

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const convParam = (currentTermTab === "agy" && currentConversationId) ? `&conv_id=${encodeURIComponent(currentConversationId)}` : "";
  const wsUrl = `${proto}://${location.host}/ws/terminal?token=${encodeURIComponent(authToken || "")}&mode=${encodeURIComponent(currentTermTab)}${convParam}`;

  try {
    terminalSocket = new WebSocket(wsUrl);
  } catch (e) {
    if (statusEl) statusEl.textContent = "WebSocket Error";
    if (xtermInstance) xtermInstance.write("\r\n[WebSocket connection failed]\r\n");
    return;
  }

  terminalSocket.onopen = () => {
    if (statusEl) statusEl.textContent = "Connected ✓";
    if (authToken) {
      terminalSocket.send(JSON.stringify({ type: "auth", token: authToken }));
    }
    fitTerminal();
  };

  terminalSocket.onmessage = (event) => {
    if (!xtermInstance) return;
    // Buffer output during active Korean IME composition to prevent character tearing/splitting
    if (isTerminalComposing) {
      terminalIncomingQueue.push(event.data);
    } else {
      if (terminalIncomingQueue.length > 0) {
        terminalIncomingQueue.push(event.data);
        flushTerminalQueue();
      } else {
        xtermInstance.write(event.data);
      }
    }
  };

  terminalSocket.onerror = () => {
    if (statusEl) statusEl.textContent = "Connection Error ✗";
    if (xtermInstance) xtermInstance.write("\r\n[Connection error]\r\n");
  };

  terminalSocket.onclose = () => {
    if (statusEl && webTerminalOpen) statusEl.textContent = "Disconnected";
    if (xtermInstance && webTerminalOpen) xtermInstance.write("\r\n[Session ended — click 'Reconnect' above]\r\n");
  };
}

function webTerminalClear() {
  if (xtermInstance) xtermInstance.clear();
  terminalIncomingQueue = [];
}

function webTerminalReconnect() {
  if (xtermInstance) {
    xtermInstance.clear();
    terminalIncomingQueue = [];
    const title = currentTermTab === "agy" ? "🤖 agy CLI" : "⚡ PowerShell";
    xtermInstance.write(`\r\n\x1b[36m[${title} Session Reconnecting...]\x1b[0m\r\n`);
  }
  connectTerminalSocket();
}

// -------------------------------------------------------------
// Korean-Friendly Quick Command Input Bar
// -------------------------------------------------------------
let termCmdHistory = [];
let termCmdHistoryIndex = -1;

function sendTerminalCmdInput() {
  const input = document.getElementById("terminalCmdInput");
  if (!input) return;
  const cmd = input.value;
  if (cmd.trim()) {
    termCmdHistory.push(cmd);
    termCmdHistoryIndex = termCmdHistory.length;
  }
  if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
    terminalSocket.send(JSON.stringify({ type: "input", data: cmd + "\r" }));
  }
  input.value = "";
  input.focus();
}

function setupTerminalCmdInput() {
  const cmdInput = document.getElementById("terminalCmdInput");
  if (!cmdInput || cmdInput._cmdSetup) return;
  cmdInput._cmdSetup = true;

  cmdInput.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // Do not interrupt Korean composition
    if (e.key === "Enter") {
      e.preventDefault();
      sendTerminalCmdInput();
    } else if (e.key === "ArrowUp") {
      if (termCmdHistory.length > 0 && termCmdHistoryIndex > 0) {
        termCmdHistoryIndex--;
        cmdInput.value = termCmdHistory[termCmdHistoryIndex] || "";
      }
    } else if (e.key === "ArrowDown") {
      if (termCmdHistoryIndex < termCmdHistory.length - 1) {
        termCmdHistoryIndex++;
        cmdInput.value = termCmdHistory[termCmdHistoryIndex] || "";
      } else {
        termCmdHistoryIndex = termCmdHistory.length;
        cmdInput.value = "";
      }
    } else if (e.ctrlKey && e.key.toLowerCase() === "c") {
      if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
        terminalSocket.send(JSON.stringify({ type: "input", data: "\x03" }));
      }
    }
  });
}

// Terminal panel drag-to-resize
function setupTerminalResize() {
  const handle = document.getElementById("webTerminalResizeHandle");
  const panel = document.getElementById("webTerminalPanel");
  if (!handle || !panel) return;

  let dragging = false;
  let startX = 0;
  let startW = 480;

  const main = document.getElementById("mainContent");

  handle.addEventListener("mousedown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = panel.offsetWidth;
    document.body.style.userSelect = "none";
    if (main) main.style.transition = "none"; // disable transition while dragging for instant responsiveness
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    // Dragging left increases width, dragging right decreases width
    const delta = startX - e.clientX;
    const newW = Math.max(280, Math.min(window.innerWidth * 0.85, startW + delta));
    panel.style.width = newW + "px";
    adjustMainLayout(newW);
    fitTerminal();
  });

  document.addEventListener("mouseup", () => {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = "";
      if (main) main.style.transition = ""; // restore smooth transition
      adjustMainLayout();
      fitTerminal();
    }
  });
}


function switchTermTab(tab) {
  if (currentTermTab === tab && terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
    return;
  }
  currentTermTab = tab;
  const shellBtn = document.getElementById("termTabShell");
  const agyBtn = document.getElementById("termTabAgy");

  if (tab === "shell") {
    if (shellBtn) {
      shellBtn.className = "flex-1 px-3 py-2 text-[11px] font-semibold text-white border-b-2 border-emerald-500 transition-all";
    }
    if (agyBtn) {
      agyBtn.className = "flex-1 px-3 py-2 text-[11px] font-semibold text-[#666] hover:text-white border-b-2 border-transparent transition-all";
    }
  } else if (tab === "agy") {
    if (agyBtn) {
      agyBtn.className = "flex-1 px-3 py-2 text-[11px] font-semibold text-white border-b-2 border-emerald-500 transition-all";
    }
    if (shellBtn) {
      shellBtn.className = "flex-1 px-3 py-2 text-[11px] font-semibold text-[#666] hover:text-white border-b-2 border-transparent transition-all";
    }
  }

  if (xtermInstance) {
    xtermInstance.clear();
    const title = tab === "agy" ? "🤖 agy CLI" : "⚡ PowerShell";
    xtermInstance.write(`\r\n\x1b[36m[${title} Switching session...]\x1b[0m\r\n`);
  }
  connectTerminalSocket();
}



// ====================================================================
// SECURITY DASHBOARD — Session Management & Audit Log
// ====================================================================

let secCurrentTab = "sessions";

async function openSecurityDashboard() {
  document.getElementById("securityModal").classList.remove("hidden");
  await loadSecurityData();
}

function closeSecurityDashboard() {
  document.getElementById("securityModal").classList.add("hidden");
}

function switchSecTab(tab) {
  secCurrentTab = tab;
  const tabs = { sessions: "secTabSessions", audit: "secTabAudit", password: "secTabPassword" };
  const panels = { sessions: "secPanelSessions", audit: "secPanelAudit", password: "secPanelPassword" };

  for (const [key, tabId] of Object.entries(tabs)) {
    const btn = document.getElementById(tabId);
    const panel = document.getElementById(panels[key]);
    if (!btn || !panel) continue;
    if (key === tab) {
      btn.classList.add("text-white", "border-[#10a37f]");
      btn.classList.remove("text-[#888]", "border-transparent");
      panel.classList.remove("hidden");
    } else {
      btn.classList.remove("text-white", "border-[#10a37f]");
      btn.classList.add("text-[#888]", "border-transparent");
      panel.classList.add("hidden");
    }
  }
}

async function submitChangePassword() {
  const oldPw = document.getElementById("secOldPassword").value;
  const newPw = document.getElementById("secNewPassword").value;
  const confirmPw = document.getElementById("secNewPasswordConfirm").value;

  if (!oldPw) {
    showPasswordMsg("Please enter your current password.", true);
    return;
  }
  if (!newPw || newPw.length < 4) {
    showPasswordMsg("New password must be at least 4 characters.", true);
    return;
  }
  if (newPw !== confirmPw) {
    showPasswordMsg("New password and confirmation do not match.", true);
    return;
  }

  try {
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${authToken}`
      },
      body: JSON.stringify({ old_password: oldPw, new_password: newPw })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showPasswordMsg(data.detail || "Failed to change password", true);
      return;
    }

    showPasswordMsg("✅ Password updated and salted (bcrypt) securely!", false);
    document.getElementById("secOldPassword").value = "";
    document.getElementById("secNewPassword").value = "";
    document.getElementById("secNewPasswordConfirm").value = "";
    showToast("✅ New password applied successfully.");
  } catch (err) {
    showPasswordMsg("Error: " + err.message, true);
  }
}

function showPasswordMsg(text, isError) {
  const el = document.getElementById("secPasswordMsg");
  if (!el) return;
  el.classList.remove("hidden", "text-rose-400", "text-emerald-400");
  el.classList.add(isError ? "text-rose-400" : "text-emerald-400");
  el.textContent = text;
}


async function loadSecurityData() {
  // Load both in parallel
  await Promise.all([loadSessions(), loadAuditLog()]);
}

async function loadSessions() {
  const panel = document.getElementById("secPanelSessions");
  const label = document.getElementById("sessionCountLabel");

  try {
    const res = await fetch("/api/auth/sessions", {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.detail || "Error");

    const sessions = data.sessions || [];

    // Update sidebar badge
    if (label) label.textContent = `Active Sessions: ${sessions.length}`;

    if (sessions.length === 0) {
      panel.innerHTML = `<div class="text-xs text-[#555] text-center py-8">No active sessions</div>`;
      return;
    }

    panel.innerHTML = sessions.map(s => {
      const created = new Date(s.created_at * 1000).toLocaleString("ko-KR");
      const lastUsed = new Date(s.last_used * 1000).toLocaleString("ko-KR");
      const expires = new Date(s.expires_at * 1000).toLocaleString("ko-KR");
      const isCurrentSession = (s.last_used > Date.now() / 1000 - 300); // active in last 5 min
      return `
        <div class="flex items-start justify-between gap-3 p-3 bg-[#212121] border border-[#2d2d2d] rounded-xl hover:border-[#3a3a3a] transition-all">
          <div class="flex-1 min-w-0 space-y-1">
            <div class="flex items-center gap-2">
              ${isCurrentSession ? '<span class="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0"></span>' : '<span class="w-2 h-2 rounded-full bg-[#444] flex-shrink-0"></span>'}
              <span class="text-xs font-mono text-[#aaa] truncate">${escapeHtml(s.ip || "Unknown")}</span>
              ${isCurrentSession ? '<span class="text-[10px] px-1.5 py-0.5 bg-emerald-900/60 text-emerald-400 rounded font-medium">Current Session</span>' : ''}
            </div>
            <div class="text-[11px] text-[#666] truncate">${escapeHtml(s.user_agent || "—")}</div>
            <div class="text-[10px] text-[#555] font-mono">
              Created: ${created} · Last: ${lastUsed} · Expires: ${expires}
            </div>
          </div>
          <button onclick="revokeSession(${s.id})" title="Terminate session" class="flex-shrink-0 px-2.5 py-1 bg-rose-950/60 hover:bg-rose-900 border border-rose-900 text-rose-400 hover:text-rose-200 text-[11px] rounded-lg transition-all">
            Terminate
          </button>
        </div>
      `;
    }).join("");

  } catch (e) {
    panel.innerHTML = `<div class="text-xs text-rose-400 text-center py-8">Error: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadAuditLog() {
  const panel = document.getElementById("secPanelAudit");

  try {
    const res = await fetch("/api/auth/audit", {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.detail || "Error");

    const attempts = data.attempts || [];
    if (attempts.length === 0) {
      panel.innerHTML = `<div class="text-xs text-[#555] text-center py-8">No login history</div>`;
      return;
    }

    panel.innerHTML = `
      <table class="w-full text-xs">
        <thead>
          <tr class="text-[#666] border-b border-[#2d2d2d]">
            <th class="text-left py-2 pr-3">IP Address</th>
            <th class="text-left py-2 pr-3">Time</th>
            <th class="text-left py-2">Result</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-[#1e1e1e]">
          ${attempts.map(a => `
            <tr class="hover:bg-[#1e1e1e] transition-all">
              <td class="py-1.5 pr-3 font-mono text-[#aaa]">${escapeHtml(a.ip)}</td>
              <td class="py-1.5 pr-3 text-[#666]">${new Date(a.time * 1000).toLocaleString("ko-KR")}</td>
              <td class="py-1.5">
                ${a.success
                  ? '<span class="text-emerald-400 font-semibold">✓ Success</span>'
                  : '<span class="text-rose-400 font-semibold">✗ Failed</span>'}
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } catch (e) {
    panel.innerHTML = `<div class="text-xs text-rose-400 text-center py-8">Error: ${escapeHtml(e.message)}</div>`;
  }
}

async function revokeSession(sessionId) {
  if (!confirm("Are you sure you want to terminate this session?")) return;
  try {
    await fetch(`/api/auth/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    await loadSessions();
    showToast("✅ Session terminated.");
  } catch (e) {
    showToast("❌ Error: " + e.message, "error");
  }
}

async function revokeAllSessions() {
  if (!confirm("⚠️ All active sessions will be revoked.\nDo you want to continue?")) return;
  try {
    const res = await fetch("/api/auth/revoke-all", {
      method: "POST",
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    // Clear local token and re-login
    localStorage.removeItem("ag_token");
    authToken = "";
    closeSecurityDashboard();
    if (activeSocket) activeSocket.close();
    showToast("✅ All sessions terminated. Please log in again.");
    setTimeout(() => showAuthModal(), 1500);
  } catch (e) {
    showToast("❌ Error: " + e.message, "error");
  }
}

// Load session count on startup
async function loadSessionCountBadge() {
  try {
    const res = await fetch("/api/auth/sessions", {
      headers: { "Authorization": `Bearer ${authToken}` }
    });
    const data = await res.json();
    const label = document.getElementById("sessionCountLabel");
    if (data.ok && label) {
      label.textContent = `Active Sessions: ${data.sessions.length}`;
    }
  } catch (e) {}
}
