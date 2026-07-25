import { contextBridge, ipcRenderer } from "electron";
import type {
  AIUsageMonitorAPI,
  ForceRefreshRequest,
} from "../shared/contracts";

const api: AIUsageMonitorAPI = {
  readQuota: () => ipcRenderer.invoke("quota:read"),
  forceRefresh: (request: ForceRefreshRequest) =>
    ipcRenderer.invoke("quota:force-refresh", request),
  quit: () => ipcRenderer.invoke("app:quit"),
};

contextBridge.exposeInMainWorld("aiUsageMonitor", Object.freeze(api));
