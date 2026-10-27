// Tests run with the same live-env host every production host installs.
import { configureEngine } from "./src/host";

configureEngine({ env: () => process.env });
