import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

const shared = {
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname) } },
};

export default defineConfig({
  test: {
    projects: [
      {
        ...shared,
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        ...shared,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
        },
      },
    ],
  },
});
