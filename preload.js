const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gemma', {
  // Chat
  chat:        (payload)   => ipcRenderer.invoke('ollama-chat', payload),
  ping:        ()          => ipcRenderer.invoke('ollama-ping'),
  readFile:    (filePath)  => ipcRenderer.invoke('read-file', filePath),

  // Persistence
  saveChats:   (data)      => ipcRenderer.invoke('save-chats', data),
  loadChats:   ()          => ipcRenderer.invoke('load-chats'),

  // Streaming events
  onToken:     (cb) => ipcRenderer.on('ollama-token',     (_e, token) => cb(token)),
  onDone:      (cb) => ipcRenderer.on('ollama-done',      () => cb()),
  onToolCall:  (cb) => ipcRenderer.on('ollama-tool-call', (_e, data) => cb(data)),

  removeListeners: () => {
    ipcRenderer.removeAllListeners('ollama-token');
    ipcRenderer.removeAllListeners('ollama-done');
    ipcRenderer.removeAllListeners('ollama-tool-call');
  },
});
