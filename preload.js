/**
 * preload.js
 * Exposes window.gemma API to the renderer via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Track registered listeners so removeListeners() can clean them up
const listeners = [];

function on(channel, callback) {
  const handler = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, handler);
  listeners.push({ channel, handler });
}

contextBridge.exposeInMainWorld('gemma', {

  ping:         ()       => ipcRenderer.invoke('ollama-ping'),
  chat:         (params) => ipcRenderer.invoke('ollama-chat', params),
  abort:        ()       => ipcRenderer.invoke('ollama-abort'),
  saveChats:    (data)   => ipcRenderer.invoke('save-chats', data),
  loadChats:    ()       => ipcRenderer.invoke('load-chats'),
  readFile:     (path)   => ipcRenderer.invoke('read-file', path),
  focusWindow:  ()       => ipcRenderer.invoke('focus-window'),
  resolveConfirm: (params) => ipcRenderer.invoke('confirm-resolve', params),

  onToken:          (cb) => on('ollama-token', cb),
  onDone:           (cb) => on('ollama-done', cb),
  onToolCall:       (cb) => on('ollama-tool-call', cb),
  onConfirmRequest: (cb) => on('confirm-request', cb),
  onFileAdded:      (cb) => on('file-added', cb),

  removeListeners: () => {
    for (const { channel, handler } of listeners) {
      ipcRenderer.removeListener(channel, handler);
    }
    listeners.length = 0;
  },

});
