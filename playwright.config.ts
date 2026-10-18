import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

/* Runs against production by default; BASE_URL=http://localhost:3000 for a local server */
export default defineConfig({
  testDir: "tests",
  timeout: 45_000,
  retries: 1,
  workers: 2,
  reporter: [["list"], ["json", { outputFile: "test-results/results.json" }]],
  use: {
    baseURL: process.env.BASE_URL || "https://sales-portal-sooty.vercel.app",
    locale: "de-DE",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"], storageState: "test-results/.auth.json" }, dependencies: ["setup"] },
    { name: "mobile", use: { ...devices["Pixel 7"], storageState: "test-results/.auth.json" }, dependencies: ["setup"], testMatch: /views\.spec\.ts/ },
  ],
});
