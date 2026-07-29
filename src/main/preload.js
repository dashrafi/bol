// Bol preload — the only bridge between renderers and main. Channel-allowlisted.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'settings:get', 'settings:set', 'settings:captureHotkey',
  'mic:list',
  'history:list', 'history:delete', 'history:clear',
  'dict:list', 'dict:add', 'dict:remove', 'dict:suggest',
  'snippets:list', 'snippets:add', 'snippets:remove',
  'analytics:get', 'app:version', 'test:stt', 'test:cleanup', 'insert:text',
]);
const SEND = new Set(['audio:chunk', 'audio:level', 'audio:error', 'audio:silent', 'mic:devices', 'mic:picked', 'hud:cancel']);
const ON = new Set(['hud:state', 'settings:changed', 'rec:start', 'rec:stop', 'mic:enumerate', 'mic:reprobe']);

contextBridge.exposeInMainWorld('bol', {
  invoke: (ch, payload) => INVOKE.has(ch) ? ipcRenderer.invoke(ch, payload) : Promise.reject(new Error('blocked channel: ' + ch)),
  send: (ch, payload) => { if (SEND.has(ch)) ipcRenderer.send(ch, payload); },
  on: (ch, cb) => {
    if (!ON.has(ch)) return () => {};
    const fn = (e, payload) => cb(payload);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  },
});
