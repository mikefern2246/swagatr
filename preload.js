'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('api', {
  act: (type, payload) => ipcRenderer.invoke('act', type, payload),
  getState: () => ipcRenderer.invoke('act', 'state'),
  getFeed: () => ipcRenderer.invoke('act', 'feed'),
  onState: cb => on('state', cb),
  onItem: cb => on('item', cb),
  onTotals: cb => on('totals', cb),
  onDebug: cb => on('debug', cb),
  onFeedCleared: cb => on('feed-cleared', cb),
  onRasterize: cb => on('rasterize', cb),
  rasterDone: (id, out) => ipcRenderer.send('raster-done', id, out)
});
