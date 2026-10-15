// Installs this app's configuration into @sofinance/engine (the engine never reads process.env itself).
// Imported (for its side effect) by every module that imports the engine, so every entrypoint —
// Next routes, the MCP server, scripts and tests — configures it before the first engine call.
// The provider returns the live process.env on every read, exactly what the engine's former inline
// reads saw (rotated keys and per-test stubs are visible immediately).
import { configureEngine } from "@sofinance/engine/host";

configureEngine({ env: () => process.env });
