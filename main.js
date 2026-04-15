const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');
const chokidar = require('chokidar');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');

const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11434;

// ─── Sandbox root ─────────────────────────────────────────────────────────────
const AI_ROOT = path.join(os.homedir(), 'ai');

// Ensure ~/ai exists
if (!fs.existsSync(AI_ROOT)) {
  fs.mkdirSync(AI_ROOT, { recursive: true });
  console.log(`[fs] Created sandbox directory: ${AI_ROOT}`);
}

// Resolve and validate a path is inside AI_ROOT — throws if not
function sandboxPath(userPath) {
  // Allow absolute paths inside AI_ROOT, or relative paths from AI_ROOT
  const resolved = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(AI_ROOT, userPath);

  if (!resolved.startsWith(AI_ROOT + path.sep) && resolved !== AI_ROOT) {
    throw new Error(`Access denied: path must be inside ~/ai\nRequested: ${resolved}`);
  }
  return resolved;
}

// ─── Config ───────────────────────────────────────────────────────────────────
let BRAVE_API_KEY = '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  BRAVE_API_KEY = cfg.braveApiKey ?? '';
} catch {
  console.warn('[config] No config.json — web search disabled.');
}

// ─── Persistence ──────────────────────────────────────────────────────────────
const CHATS_PATH = path.join(app.getPath('userData'), 'chats.json');

// ─── Tool definitions ─────────────────────────────────────────────────────────
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the internet for current information.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query.' } },
      required: ['query'],
    },
  },
};

const FS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file inside ~/ai. Use relative paths like "notes.txt" or "projects/main.py".',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File path relative to ~/ai, e.g. "notes.txt" or "projects/app.js".' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file inside ~/ai. Creates the file and any needed parent directories. ALWAYS requires user confirmation before executing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to ~/ai, e.g. "output.md".' },
          content: { type: 'string', description: 'The full content to write to the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and subdirectories inside ~/ai. Pass "" or "." to list the root ~/ai directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path relative to ~/ai. Use "" for the root.' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unzip_file',
      description: 'Extract a zip file inside ~/ai to a target directory inside ~/ai. Use this to unzip log archives before reading them.',
      parameters: {
        type: 'object',
        properties: {
          zip_path: { type: 'string', description: 'Path to the zip file relative to ~/ai, e.g. "defender_logs/logs.zip".' },
          extract_to: { type: 'string', description: 'Directory to extract into, relative to ~/ai, e.g. "defender_logs/extracted".' },
        },
        required: ['zip_path', 'extract_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_docx',
      description: 'Write a report as a formatted Word document (.docx) to ~/ai. Use markdown-style content with # for headings, ## for subheadings, and plain text for paragraphs. ALWAYS requires user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Output file path relative to ~/ai, e.g. "report.docx". Must end in .docx.' },
          content: { type: 'string', description: 'Report content in markdown format. Use # for title, ## for sections, ### for subsections, plain text for paragraphs, - for bullet points.' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 550,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d0f12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  startFileWatcher();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ─── File watcher ─────────────────────────────────────────────────────────────
let watcher = null;

function startFileWatcher() {
  // Small delay so initial scan doesn't flood the UI on startup
  const STARTUP_GRACE = 5000; // ms — ignore events for 5s after launch
  const startTime = Date.now();

  // Track files we've already notified about to avoid duplicates
  const notified = new Set();

  watcher = chokidar.watch(AI_ROOT, {
    persistent: true,
    ignoreInitial: true,       // don't fire for files that already exist
    recursive: true,
    awaitWriteFinish: {
      stabilityThreshold: 1000, // wait for write to finish before notifying
      pollInterval: 200,
    },
    ignored: [
      /(^|[\/])\./, // hidden files/dirs
      /~$/,           // temp files
    ],
  });

  watcher.on('add', (filePath) => {
    // Ignore events during startup grace period
    if (Date.now() - startTime < STARTUP_GRACE) return;
    if (notified.has(filePath)) return;
    notified.add(filePath);

    // Clear from notified set after a while so re-creation works
    setTimeout(() => notified.delete(filePath), 10000);

    const relativePath = path.relative(AI_ROOT, filePath);
    const stat = fs.statSync(filePath);
    const size = stat.size;

    console.log(`[watcher] new file: ${relativePath} (${size} bytes)`);

    // Send to renderer — mainWindow might not exist yet
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file-watcher-add', {
        relativePath,
        absolutePath: filePath,
        size,
        ext: path.extname(filePath).toLowerCase(),
        timestamp: Date.now(),
      });
    }
  });

  watcher.on('error', (err) => console.error('[watcher] error:', err));
  console.log(`[watcher] watching ${AI_ROOT}`);
}

app.on('before-quit', () => { if (watcher) watcher.close(); });

// ─── Focus window IPC ────────────────────────────────────────────────────────
ipcMain.handle('focus-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.show();
    mainWindow.focus();
    // Release always-on-top after a moment so it doesn't stay permanently on top
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
      }
    }, 2000);
  }
});

// ─── Persistence IPC ──────────────────────────────────────────────────────────
ipcMain.handle('save-chats', async (_e, data) => {
  fs.writeFileSync(CHATS_PATH, JSON.stringify(data, null, 2), 'utf8');
  return true;
});
ipcMain.handle('load-chats', async () => {
  try {
    if (!fs.existsSync(CHATS_PATH)) return null;
    return JSON.parse(fs.readFileSync(CHATS_PATH, 'utf8'));
  } catch { return null; }
});

// ─── File attachment IPC (manual drag/drop upload) ────────────────────────────
ipcMain.handle('read-file', async (_e, filePath) => {
  const MAX_BYTES = 200_000;
  const ALLOWED_EXT = [
    '.txt','.md','.markdown','.csv','.json','.jsonl',
    '.js','.jsx','.ts','.tsx','.mjs','.cjs',
    '.py','.rb','.rs','.go','.java','.c','.cpp','.h',
    '.css','.scss','.html','.xml','.yaml','.yml',
    '.sh','.bash','.zsh','.env','.toml','.ini','.cfg','.log','.sql',
  ];
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw new Error(`Unsupported file type: ${ext}`);
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_BYTES) {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(MAX_BYTES);
    fs.readSync(fd, buf, 0, MAX_BYTES, 0);
    fs.closeSync(fd);
    return { name: path.basename(filePath), ext, content: buf.toString('utf8'), truncated: true, size: stat.size };
  }
  return { name: path.basename(filePath), ext, content: fs.readFileSync(filePath, 'utf8'), truncated: false, size: stat.size };
});

// ─── Confirmation IPC — renderer resolves these ───────────────────────────────
// We use a Map of pending promises keyed by a request ID
const pendingConfirmations = new Map();

ipcMain.handle('confirm-resolve', (_e, { id, approved }) => {
  const resolve = pendingConfirmations.get(id);
  if (resolve) { resolve(approved); pendingConfirmations.delete(id); }
});

// Ask the renderer to show a confirmation dialog, wait for user response
function askConfirmation(event, payload) {
  return new Promise((resolve) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    pendingConfirmations.set(id, resolve);
    event.sender.send('confirm-request', { id, ...payload });
  });
}

// ─── Filesystem tool implementations ─────────────────────────────────────────
function fsReadFile(userPath) {
  const resolved = sandboxPath(userPath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${userPath}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`Not a file: ${userPath}`);
  const MAX = 200_000;
  if (stat.size > MAX) {
    const fd = fs.openSync(resolved, 'r');
    const buf = Buffer.alloc(MAX);
    fs.readSync(fd, buf, 0, MAX, 0);
    fs.closeSync(fd);
    return buf.toString('utf8') + `\n\n[...truncated — file is ${(stat.size/1024).toFixed(1)} KB, showing first 200 KB]`;
  }
  return fs.readFileSync(resolved, 'utf8');
}

function fsWriteFile(userPath, content) {
  const resolved = sandboxPath(userPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');
  return `Written ${content.length} characters to ${userPath}`;
}

function fsListDirectory(userPath) {
  const target = (userPath === '' || userPath === '.') ? AI_ROOT : sandboxPath(userPath);
  if (!fs.existsSync(target)) throw new Error(`Directory not found: ${userPath || '~/ai'}`);
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${userPath}`);

  const entries = fs.readdirSync(target, { withFileTypes: true });
  if (entries.length === 0) return `Directory is empty: ${userPath || '~/ai'}`;

  const lines = entries.map(e => {
    if (e.isDirectory()) return `📁 ${e.name}/`;
    const size = fs.statSync(path.join(target, e.name)).size;
    const sizeStr = size < 1024 ? `${size}B` : size < 1048576 ? `${(size/1024).toFixed(1)}KB` : `${(size/1048576).toFixed(1)}MB`;
    return `📄 ${e.name} (${sizeStr})`;
  });

  const displayPath = userPath ? `~/ai/${userPath}` : '~/ai';
  return `Contents of ${displayPath}:\n${lines.join('\n')}`;
}

// ─── Unzip ────────────────────────────────────────────────────────────────────
function fsUnzipFile(zipUserPath, extractUserPath) {
  const zipResolved     = sandboxPath(zipUserPath);
  const extractResolved = sandboxPath(extractUserPath);

  if (!fs.existsSync(zipResolved)) throw new Error(`Zip file not found: ${zipUserPath}`);
  fs.mkdirSync(extractResolved, { recursive: true });

  const zip = new AdmZip(zipResolved);
  const entries = zip.getEntries();

  // Safety check — ensure all entries stay inside sandbox
  for (const entry of entries) {
    const dest = path.resolve(extractResolved, entry.entryName);
    if (!dest.startsWith(AI_ROOT)) throw new Error(`Zip contains unsafe path: ${entry.entryName}`);
  }

  zip.extractAllTo(extractResolved, true);
  const count = entries.filter(e => !e.isDirectory).length;
  return `Extracted ${count} file(s) from ${zipUserPath} to ~/ai/${extractUserPath}`;
}

// ─── Write DOCX ───────────────────────────────────────────────────────────────
async function fsWriteDocx(userPath, markdownContent) {
  const resolved = sandboxPath(userPath);
  if (!resolved.endsWith('.docx')) throw new Error('Path must end in .docx');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  // Cap content size — very large documents cause Packer to hang
  const MAX_CONTENT = 80_000;
  const content = markdownContent.length > MAX_CONTENT
    ? markdownContent.slice(0, MAX_CONTENT) + '\n\n*[Report truncated at 80KB limit]*'
    : markdownContent;

  // Parse markdown into docx elements
  const lines = content.split('\n');
  const children = [];

  for (const line of lines) {
    if (line.startsWith('# ')) {
      children.push(new Paragraph({ text: line.slice(2).trim(), heading: HeadingLevel.HEADING_1 }));
    } else if (line.startsWith('## ')) {
      children.push(new Paragraph({ text: line.slice(3).trim(), heading: HeadingLevel.HEADING_2 }));
    } else if (line.startsWith('### ')) {
      children.push(new Paragraph({ text: line.slice(4).trim(), heading: HeadingLevel.HEADING_3 }));
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      children.push(new Paragraph({ text: line.slice(2).trim(), bullet: { level: 0 } }));
    } else if (line.trim() === '') {
      children.push(new Paragraph({ text: '' }));
    } else {
      const runs = [];
      const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
      for (const part of parts) {
        if (part.startsWith('**') && part.endsWith('**')) {
          runs.push(new TextRun({ text: part.slice(2, -2), bold: true }));
        } else if (part.startsWith('*') && part.endsWith('*')) {
          runs.push(new TextRun({ text: part.slice(1, -1), italics: true }));
        } else if (part) {
          runs.push(new TextRun({ text: part }));
        }
      }
      children.push(new Paragraph({ children: runs }));
    }
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });

  // Wrap Packer in a 30s timeout to prevent hanging
  const buffer = await Promise.race([
    Packer.toBuffer(doc),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('write_docx timed out after 30s — try a shorter report')), 30000)
    ),
  ]);

  fs.writeFileSync(resolved, buffer);
  return `Saved Word document to ~/ai/${userPath} (${(buffer.length / 1024).toFixed(1)} KB)`;
}

// ─── Brave Search ─────────────────────────────────────────────────────────────
function braveSearch(query) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ q: query, count: '5' });
    const req = https.request({
      hostname: 'api.search.brave.com',
      path: `/res/v1/web/search?${params}`,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Accept-Encoding': 'identity', 'X-Subscription-Token': BRAVE_API_KEY },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          const results = (json.web?.results ?? []).slice(0, 5)
            .map((r, i) => `[${i+1}] ${r.title}\n${r.url}\n${r.description ?? ''}`)
            .join('\n\n');
          resolve(results || 'No results found.');
        } catch(e) { reject('Parse error: ' + e.message); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Ollama: non-streaming ────────────────────────────────────────────────────
function ollamaRequest(messages, tools, systemPrompt, temperature, maxTokens, model) {
  return new Promise((resolve, reject) => {
    if (abortRequested) return reject('aborted');
    const body = JSON.stringify({
      model,
      messages: [...(systemPrompt ? [{role:'system', content:systemPrompt}] : []), ...messages],
      tools: tools ?? [],
      stream: false,
      options: { temperature: temperature ?? 0.7, num_predict: maxTokens ?? 2048 },
    });
    const req = http.request({
      hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e.message); } });
      res.on('error', reject);
    });
    req.on('error', (e) => { if (!abortRequested) reject(`Cannot reach Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}.`); });
    activeRequest = req;
    req.write(body); req.end();
  });
}

// ─── Ollama: streaming ────────────────────────────────────────────────────────
function ollamaStream(event, messages, systemPrompt, temperature, maxTokens, model) {
  return new Promise((resolve, reject) => {
    if (abortRequested) return resolve('aborted');
    const body = JSON.stringify({
      model,
      messages: [...(systemPrompt ? [{role:'system', content:systemPrompt}] : []), ...messages],
      stream: true,
      options: { temperature: temperature ?? 0.7, num_predict: maxTokens ?? 2048 },
    });
    const req = http.request({
      hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let buffer = '';
      res.on('data', chunk => {
        if (abortRequested) { req.destroy(); return resolve('aborted'); }
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            const token = json?.message?.content ?? '';
            if (token) event.sender.send('ollama-token', token);
            if (json.done) event.sender.send('ollama-done');
          } catch { /* skip */ }
        }
      });
      res.on('end', () => resolve('done'));
      res.on('error', (e) => { if (!abortRequested) reject(e); else resolve('aborted'); });
    });
    req.on('error', (e) => { if (!abortRequested) reject(`Cannot reach Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}.`); });
    activeRequest = req;
    req.write(body); req.end();
  });
}

// ─── IPC: main chat handler ───────────────────────────────────────────────────
// Track active requests so we can abort them
let activeRequest = null;
let abortRequested = false;

ipcMain.handle('ollama-abort', () => {
  abortRequested = true;
  if (activeRequest) {
    try { activeRequest.destroy(); } catch(e) {}
    activeRequest = null;
  }
  console.log('[abort] request aborted by user');
});

ipcMain.handle('ollama-chat', async (event, { messages, systemPrompt, temperature, maxTokens, model, searchEnabled, fsEnabled }) => {
  abortRequested = false;
  const activeModel = model || 'gemma4:latest';

  const tools = [
    ...(searchEnabled && BRAVE_API_KEY ? [WEB_SEARCH_TOOL] : []),
    ...(fsEnabled ? FS_TOOLS : []),
  ];

  // Build effective system prompt — inject filesystem context when fs is enabled
  const fsSystemAddendum = fsEnabled ? `You are running locally on the user's Linux machine with direct filesystem access. The directory ~/ai (${AI_ROOT}) is your shared workspace.

FILESYSTEM RULES:
- Use tools immediately and autonomously — do not ask permission between steps
- Chain tool calls without stopping: list → read → analyse → write in one flow
- When asked to analyse files and write a report, complete the entire workflow end-to-end
- Display directory listings and file contents verbatim, do not summarise tool results
- For reports: be concise and structured. Aim for under 2000 words. Use ## sections and bullet points
- write_docx content must be under 80KB — summarise findings, do not paste raw log data into the report
- If you encounter many similar log entries, summarise patterns rather than listing each one` : '';

  const effectiveSystemPrompt = [systemPrompt, fsSystemAddendum].filter(Boolean).join('\n\n');

  let loopMessages = [...messages];

  for (let round = 0; round < 12; round++) {
    if (abortRequested) { event.sender.send('ollama-done'); return 'aborted'; }
    const response = await ollamaRequest(loopMessages, tools, effectiveSystemPrompt, temperature, maxTokens, activeModel);
    const msg = response.message;

    // No tool calls — stream final answer
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      loopMessages.push({ role: 'assistant', content: msg.content ?? '' });
      await ollamaStream(event, loopMessages, effectiveSystemPrompt, temperature, maxTokens, activeModel);
      return 'done';
    }

    loopMessages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });

    for (const toolCall of msg.tool_calls) {
      const fnName = toolCall.function?.name;
      const args   = toolCall.function?.arguments ?? {};
      let result;

      try {
        if (fnName === 'web_search') {
          const query = args.query ?? '';
          console.log(`[tool] web_search: "${query}"`);
          event.sender.send('ollama-tool-call', { tool: 'web_search', query });
          result = await braveSearch(query);

        } else if (fnName === 'read_file') {
          const p = args.path ?? '';
          console.log(`[tool] read_file: "${p}"`);
          event.sender.send('ollama-tool-call', { tool: 'read_file', path: p });
          result = fsReadFile(p);

        } else if (fnName === 'list_directory') {
          const p = args.path ?? '';
          console.log(`[tool] list_directory: "${p}"`);
          event.sender.send('ollama-tool-call', { tool: 'list_directory', path: p });
          result = fsListDirectory(p);

        } else if (fnName === 'write_file') {
          const p          = args.path ?? '';
          const content    = args.content ?? '';
          console.log(`[tool] write_file: "${p}" (${content.length} chars)`);

          event.sender.send('ollama-tool-call', { tool: 'write_file', path: p, size: content.length });
          const approved = await askConfirmation(event, {
            tool: 'write_file',
            path: p,
            preview: content.slice(0, 300) + (content.length > 300 ? '\n...' : ''),
            size: content.length,
          });
          result = approved ? fsWriteFile(p, content) : `User declined to write file: ${p}`;

        } else if (fnName === 'unzip_file') {
          const zipPath    = args.zip_path ?? '';
          const extractTo  = args.extract_to ?? '';
          console.log(`[tool] unzip_file: "${zipPath}" -> "${extractTo}"`);
          event.sender.send('ollama-tool-call', { tool: 'unzip_file', path: zipPath });
          result = fsUnzipFile(zipPath, extractTo);

        } else if (fnName === 'write_docx') {
          const p          = args.path ?? '';
          const content    = args.content ?? '';
          console.log(`[tool] write_docx: "${p}" (${content.length} chars)`);

          event.sender.send('ollama-tool-call', { tool: 'write_docx', path: p, size: content.length });
          const approved = await askConfirmation(event, {
            tool: 'write_docx',
            path: p,
            preview: content.slice(0, 300) + (content.length > 300 ? '\n...' : ''),
            size: content.length,
          });
          result = approved ? await fsWriteDocx(p, content) : `User declined to write docx: ${p}`;

        } else {
          result = `Unknown tool: ${fnName}`;
        }

      } catch(err) {
        result = `Tool error (${fnName}): ${err.message ?? err}`;
        console.error(`[tool error] ${fnName}:`, err);
      }

      loopMessages.push({ role: 'tool', content: result });
    }
  }

  // Safety fallback
  await ollamaStream(event, loopMessages, effectiveSystemPrompt, temperature, maxTokens, activeModel);
  return 'done';
});

// ─── IPC: ping ────────────────────────────────────────────────────────────────
ipcMain.handle('ollama-ping', async () => {
  return new Promise((resolve) => {
    const req = http.get(`http://${OLLAMA_HOST}:${OLLAMA_PORT}/api/tags`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const models = json.models?.map(m => m.name) ?? [];
          resolve({ ok: true, models, searchEnabled: !!BRAVE_API_KEY, aiRoot: AI_ROOT });
        } catch { resolve({ ok: true, models: [], searchEnabled: false, aiRoot: AI_ROOT }); }
      });
    });
    req.on('error', () => resolve({ ok: false, models: [], searchEnabled: false, aiRoot: AI_ROOT }));
  });
});
