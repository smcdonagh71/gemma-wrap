/**
 * preload.js
 * Exposes a safe `window.aiFiles` API to the renderer (claude.ai web page)
 * for read/write access to ~/ai and read access to allowed directories
 * via Electron's contextBridge + IPC.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiFiles', {

  // ── ~/ai operations (read + write) ────────────────────────────────────────

  list: () => ipcRenderer.invoke('aifiles:list'),

  read: (relativePath) => ipcRenderer.invoke('aifiles:read', relativePath),

  write: (relativePath, content) =>
    ipcRenderer.invoke('aifiles:write', relativePath, content),

  append: (relativePath, content) =>
    ipcRenderer.invoke('aifiles:append', relativePath, content),

  delete: (relativePath) => ipcRenderer.invoke('aifiles:delete', relativePath),

  exists: (relativePath) => ipcRenderer.invoke('aifiles:exists', relativePath),

  // ── Multi-directory read operations ───────────────────────────────────────

  listDir: (relativePath) => ipcRenderer.invoke('aifiles:list-dir', relativePath),

  listAll: () => ipcRenderer.invoke('aifiles:list-all'),

  allowedDirs: () => ipcRenderer.invoke('aifiles:allowed-dirs'),

  // ── Watch ~/ai for changes ────────────────────────────────────────────────

  watch: (callback) => {
    const handler = (_event, eventType, relativePath) =>
      callback(eventType, relativePath);
    ipcRenderer.on('aifiles:change', handler);
    ipcRenderer.invoke('aifiles:watch-start');
    return () => {
      ipcRenderer.off('aifiles:change', handler);
      ipcRenderer.invoke('aifiles:watch-stop');
    };
  },
});

// ── MCP server ────────────────────────────────────────────────────────────────
// C2 fix: getEndpointUrl now returns { url, token } so the renderer can pass
// the bearer token in Authorization headers when connecting to the MCP server.
// getToken() provides direct access to the token for use in SSE connection setup.
contextBridge.exposeInMainWorld('claudeLinuxMcp', {
  getEndpoint: () => ipcRenderer.invoke('mcp:get-endpoint-url'),
  // Legacy shim: returns just the URL string for any code expecting a plain URL
  getEndpointUrl: async () => {
    const result = await ipcRenderer.invoke('mcp:get-endpoint-url');
    return result ? result.url : null;
  },
});

// ── Text injection from main process ─────────────────────────────────────────
// Receives text from index.js injectText() and inserts it into the claude.ai
// chat input. The main process sends 'inject-text' over IPC with the content
// as a plain string — no eval, no interpolation into JS templates.
//
// Selector cascade:
//   1. data-testid="chat-input"  — claude.ai's primary rich-text input (ProseMirror div)
//   2. div[contenteditable]      — fallback if testid changes
//   3. textarea                  — last resort for any legacy input
ipcRenderer.on('inject-text', (_event, text) => {
  const input = document.querySelector('[data-testid="chat-input"]')
             || document.querySelector('div[contenteditable="true"]')
             || document.querySelector('textarea');
  if (!input) {
    console.error('[inject-text] no chat input found — cannot inject:', text.slice(0, 80));
    return;
  }
  input.focus();
  // execCommand('insertText') works for both contenteditable divs and textareas,
  // triggers React's synthetic input events, and keeps undo history intact.
  const ok = document.execCommand('insertText', false, text);
  if (!ok) {
    // execCommand may return false in some sandboxed contexts — fall back to
    // dispatching a native input event so React picks up the change.
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    );
    if (nativeInputValueSetter && input.tagName === 'TEXTAREA') {
      nativeInputValueSetter.set.call(input, (input.value || '') + text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable path: append a text node and fire input event
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  console.log('[inject-text] injected', text.length, 'chars into', input.tagName);
});

// ── Command request observer ──────────────────────────────────────────────────
// Watches the claude.ai DOM for assistant messages containing ```cmd_request
// blocks and automatically writes ~/ai/cmd_request.json so the Electron app
// can pick them up, show the approval dialog, and inject the result back.

(function installCmdObserver() {
  const CMD_REQUEST_PATH = 'ai/cmd_request.json';
  const CMD_RESULT_PATH  = 'ai/cmd_result.json';

  const queue      = [];
  let   processing = false;
  const processed  = new WeakSet(); // DOM nodes already handled
  const firedIds   = new Set();     // request ids already fired — survives DOM remounts
  let   recentlyStreamed = false;   // true briefly after a streaming message completes
  let   streamedTimer    = null;

  function enqueue(requests) {
    const fresh = requests.filter(r => !firedIds.has(r.id));
    if (fresh.length === 0) return;
    queue.push(...fresh);
    drainQueue();
  }

  function drainQueue() {
    if (processing || queue.length === 0) return;
    const req = queue.shift();
    fireRequest(req);
  }

  async function fireRequest(req) {
    processing = true;
    firedIds.add(req.id);
    console.log('[cmd-observer] firing request:', req.id, req.cmd);
    try {
      // Use ipcRenderer directly — window.aiFiles is exposed to the renderer page
      // but the preload script runs in a separate Node context where it's unavailable.
      await ipcRenderer.invoke('aifiles:write', CMD_REQUEST_PATH, JSON.stringify(req));
    } catch (e) {
      console.error('[cmd-observer] failed to write cmd_request.json:', e);
      processing = false;
      drainQueue();
      return;
    }
    waitForResult();
  }

  function waitForResult() {
    const POLL_MS  = 100;
    const MAX_WAIT = 30000;
    let   elapsed  = 0;
    let   lastSize = -1;

    const interval = setInterval(async () => {
      elapsed += POLL_MS;
      if (elapsed > MAX_WAIT) {
        console.warn('[cmd-observer] timed out waiting for cmd_result.json');
        clearInterval(interval);
        processing = false;
        drainQueue();
        return;
      }

      try {
        // Use ipcRenderer directly for same reason as above
        const content = await ipcRenderer.invoke('aifiles:read', CMD_RESULT_PATH);
        if (content && content.length !== lastSize) {
          lastSize = content.length;
          return;
        }
        if (content && content.length === lastSize && lastSize > 0) {
          clearInterval(interval);
          processing = false;
          console.log('[cmd-observer] result received, queue length:', queue.length);
          drainQueue();
        }
      } catch (_) {
        // File doesn't exist yet — keep polling
      }
    }, POLL_MS);
  }

  function extractCmdRequests(node) {
    const requests = [];
    const codeBlocks = node.querySelectorAll('code, pre');
    for (const block of codeBlocks) {
      const text = block.textContent || '';
      const isTagged = block.closest('pre')?.previousElementSibling?.textContent?.trim() === 'cmd_request'
                    || block.className?.includes('cmd_request')
                    || block.className?.includes('language-cmd_request');
      if (!isTagged) continue;

      try {
        const req = JSON.parse(text.trim());
        if (req && typeof req.cmd === 'string') {
          if (!req.id) req.id = `auto-${Date.now()}`;
          requests.push(req);
        }
      } catch (_) {
        console.warn('[cmd-observer] failed to parse cmd_request block:', text.slice(0, 100));
      }
    }
    return requests;
  }

  function checkNode(node) {
    if (!(node instanceof Element)) return;
    if (processed.has(node)) return;

    const isStreaming = node.getAttribute('data-is-streaming');
    if (isStreaming === 'true') return;

    // Only fire cmd_request blocks from genuinely new messages — i.e. those that
    // just finished streaming. History blocks render via mutations too but are
    // never preceded by a streaming state change, so recentlyStreamed will be false.
    if (!recentlyStreamed) return;

    const requests = extractCmdRequests(node);
    if (requests.length === 0) return;

    processed.add(node);
    console.log(`[cmd-observer] found ${requests.length} cmd_request(s) in message`);
    enqueue(requests);
  }

  // H2 fix: rate-limit the MutationObserver callback.
  // claude.ai produces hundreds of DOM mutations per second during streaming
  // (one per token). Processing addedNodes synchronously on each mutation
  // caused querySelectorAll() to run at token rate, burning CPU and causing
  // observable lag on long responses.
  //
  // Fix: the streaming-state transition (data-is-streaming) is still handled
  // synchronously so recentlyStreamed is set immediately. Actual node checking
  // is batched: nodes are collected into a pending set and flushed once via
  // requestAnimationFrame (≈16ms), coalescing an entire frame's worth of
  // mutations into a single DOM query pass.
  const pendingNodes = new Set();
  let rafPending = false;

  function flushPendingNodes() {
    rafPending = false;
    for (const node of pendingNodes) checkNode(node);
    pendingNodes.clear();
  }

  function scheduleCheck(node) {
    pendingNodes.add(node);
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(flushPendingNodes);
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Streaming completion: data-is-streaming flipped from true → false/removed.
      // Handled synchronously so recentlyStreamed is set before the RAF fires.
      if (mutation.type === 'attributes' && mutation.attributeName === 'data-is-streaming') {
        const wasStreaming = mutation.oldValue === 'true';
        const nowDone = mutation.target.getAttribute('data-is-streaming') !== 'true';
        if (wasStreaming && nowDone) {
          recentlyStreamed = true;
          clearTimeout(streamedTimer);
          // Reset flag after 5s — enough time for the DOM to settle after streaming
          streamedTimer = setTimeout(() => { recentlyStreamed = false; }, 5000);
        }
        scheduleCheck(mutation.target);
      }

      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          scheduleCheck(node);
          const descendants = node.querySelectorAll(
            '[data-is-streaming], .font-claude-message, [class*="assistant"]'
          );
          for (const d of descendants) scheduleCheck(d);
        }
      }
    }
  });

  function start() {
    // Seed firedIds from any cmd_request blocks already in the DOM so we don't
    // re-fire history blocks when the conversation loads or when navigating back.
    document.querySelectorAll('code.language-cmd_request').forEach(block => {
      try {
        const req = JSON.parse(block.textContent.trim());
        if (req && req.id) {
          firedIds.add(req.id);
          console.log('[cmd-observer] seeding firedIds with existing block:', req.id);
        }
      } catch (_) {}
    });

    observer.observe(document.body, {
      childList:       true,
      subtree:         true,
      attributes:      true,
      attributeFilter: ['data-is-streaming'],
      attributeOldValue: true,
    });
    console.log('[cmd-observer] installed');
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }
})();
