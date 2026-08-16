import { writeAppArtifacts } from "@imprun/app-sdk/node";
import { app } from "../src/main.js";

await writeAppArtifacts(app);
