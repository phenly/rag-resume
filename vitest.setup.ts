import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

afterEach(async () => {
  // Only the jsdom project has a DOM to clean up.
  if (typeof document !== "undefined") {
    const { cleanup } = await import("@testing-library/react");
    cleanup();
  }
});
