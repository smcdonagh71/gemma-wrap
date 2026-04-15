const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gemma', {
  // Chat
  chat:     (payload)  => ipcRenderer.invoke('ollama-chat', payload),
  ping:     ()         => ipcRenderer.invoke('ollama-ping'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),

  // Persistence
  saveChats: (data) => ipcRenderer.invoke('save-chats', data),
  loadChats: ()     => ipcRenderer.invoke('load-chats'),

  // Streaming events — these get re-registered each message so must be cleared
  onToken:    (cb) => ipcRenderer.on('ollama-token',     (_e, token) => cb(token)),
  onDone:     (cb) => ipcRenderer.on('ollama-done',      ()          => cb()),
  onToolCall: (cb) => ipcRenderer.on('ollama-tool-call', (_e, data)  => cb(data)),

  // Confirmation dialog — registered ONCE at startup, never cleared
  onConfirmRequest: (cb) => ipcRenderer.on('confirm-request', (_e, data) => cb(data)),
  resolveConfirm:   (id, approved) => ipcRenderer.invoke('confirm-resolve', { id, approved }),
  focusWindow:      () => ipcRenderer.invoke('focus-window'),
  abort:            () => ipcRenderer.invoke('ollama-abort'),

  // File watcher — registered ONCE at startup, never cleared
  onFileAdded: (cb) => ipcRenderer.on('file-watcher-add', (_e, data) => cb(data)),

  // Only clears the per-message streaming listeners
  removeListeners: () => {
    ipcRenderer.removeAllListeners('ollama-token');
    ipcRenderer.removeAllListeners('ollama-done');
    ipcRenderer.removeAllListeners('ollama-tool-call');
    // NOTE: confirm-request and file-watcher-add are intentionally NOT cleared here
  },
});
