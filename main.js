const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');

const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11434;

// ─── Config ───────────────────────────────────────────────────────────────────
let BRAVE_API_KEY = '';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  BRAVE_API_KEY = cfg.braveApiKey ?? '';
} catch {
  console.warn('[config] No config.json found — web search disabled.');
}

// ─── Persistence path ─────────────────────────────────────────────────────────
const CHATS_PATH = path.join(app.getPath('userData'), 'chats.json');

// ─── Tool definition ──────────────────────────────────────────────────────────
const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the internet for current information. Use this whenever the user asks about recent events, news, live data, or anything you are uncertain about.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to look up.' },
      },
      required: ['query'],
    },
  },
};

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 550,
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Persistence ──────────────────────────────────────────────────────────────
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

// ─── Read file ────────────────────────────────────────────────────────────────
ipcMain.handle('read-file', async (_event, filePath) => {
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

// ─── Ollama: non-streaming (tool loop) ───────────────────────────────────────
function ollamaRequest(messages, tools, systemPrompt, temperature, maxTokens, model) {
  return new Promise((resolve, reject) => {
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
    req.on('error', () => reject(`Cannot reach Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}.`));
    req.write(body); req.end();
  });
}

// ─── Ollama: streaming (final answer) ────────────────────────────────────────
function ollamaStream(event, messages, systemPrompt, temperature, maxTokens, model) {
  return new Promise((resolve, reject) => {
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
      res.on('error', reject);
    });
    req.on('error', () => reject(`Cannot reach Ollama at ${OLLAMA_HOST}:${OLLAMA_PORT}.`));
    req.write(body); req.end();
  });
}

// ─── IPC: chat with tool loop ─────────────────────────────────────────────────
ipcMain.handle('ollama-chat', async (event, { messages, systemPrompt, temperature, maxTokens, model, searchEnabled }) => {
  const activeModel = model || 'gemma4:latest';
  const tools = (searchEnabled && BRAVE_API_KEY) ? [WEB_SEARCH_TOOL] : [];
  let loopMessages = [...messages];

  for (let round = 0; round < 4; round++) {
    const response = await ollamaRequest(loopMessages, tools, systemPrompt, temperature, maxTokens, activeModel);
    const msg = response.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      loopMessages.push({ role: 'assistant', content: msg.content ?? '' });
      await ollamaStream(event, loopMessages, systemPrompt, temperature, maxTokens, activeModel);
      return 'done';
    }

    loopMessages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });

    for (const toolCall of msg.tool_calls) {
      if (toolCall.function?.name === 'web_search') {
        const query = toolCall.function.arguments?.query ?? '';
        console.log(`[tool] web_search: "${query}"`);
        event.sender.send('ollama-tool-call', { tool: 'web_search', query });
        let result;
        try { result = await braveSearch(query); }
        catch(err) { result = `Search failed: ${err}`; }
        loopMessages.push({ role: 'tool', content: result });
      }
    }
  }

  await ollamaStream(event, loopMessages, systemPrompt, temperature, maxTokens, activeModel);
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
          resolve({ ok: true, models, searchEnabled: !!BRAVE_API_KEY });
        } catch { resolve({ ok: true, models: [], searchEnabled: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false, models: [], searchEnabled: false }));
  });
});
