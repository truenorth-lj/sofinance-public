// Mock for server-only package when running MCP server
// The server-only package is a Next.js-specific guard that prevents
// client-side imports. When running as a standalone Node.js process
// (MCP server), we need to bypass this check.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === "server-only") {
    // Return a fake path that will resolve to an empty module
    return require.resolve("./server-only-mock-impl.js");
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
