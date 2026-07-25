import type { AIUsageMonitorAPI } from "../shared/contracts";

declare global {
  interface Window {
    aiUsageMonitor: AIUsageMonitorAPI;
  }
}

export {};
