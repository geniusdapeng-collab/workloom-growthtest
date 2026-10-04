"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("workloomDesktop", Object.freeze({
  login: () => ipcRenderer.invoke("workloom:desktop-login"),
}));
