import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("spike", {
  getState: () => ipcRenderer.invoke("state:get"),
  recordButtonClick: () => ipcRenderer.invoke("button:click"),
  onState: (callback: (state: unknown) => void) => {
    ipcRenderer.on("state:update", (_event, state) => callback(state));
  },
});
