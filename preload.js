const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  invoke: (c, ...a) => ipcRenderer.invoke(c, ...a),
  onLog: cb => ipcRenderer.on('log', (_, m) => cb(m)),
  win: a => ipcRenderer.send('win', a)
});
