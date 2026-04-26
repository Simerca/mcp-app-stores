#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCredentials } from "./auth.js";
import { AscClient } from "./client.js";
import { registerTools } from "./tools.js";
import { registerMediaTools } from "./media.js";
import { registerSubmissionTools } from "./submission.js";
import { registerReviewTools } from "./review.js";
import { registerAppInfoTools } from "./appinfo.js";
import { loadGpCredentials } from "./gp-auth.js";
import { GpClient } from "./gp-client.js";
import { registerGpTools } from "./gp-tools.js";
import { registerUnifiedTools } from "./unified.js";

async function main() {
  const ascCreds = loadCredentials();
  const gpCreds = loadGpCredentials();

  if (!ascCreds && !gpCreds) {
    throw new Error(
      "No credentials configured. Set ASC_KEY_ID/ASC_ISSUER_ID/ASC_PRIVATE_KEY_PATH and/or GOOGLE_SERVICE_ACCOUNT_JSON_PATH.",
    );
  }

  const asc = ascCreds ? new AscClient(ascCreds) : null;
  const gp = gpCreds ? new GpClient(gpCreds) : null;

  const server = new McpServer({
    name: "mcp-app-stores",
    version: "0.2.0",
  });

  if (asc) {
    registerTools(server, asc);
    registerMediaTools(server, asc);
    registerSubmissionTools(server, asc);
    registerReviewTools(server, asc);
    registerAppInfoTools(server, asc);
  }
  if (gp) {
    registerGpTools(server, gp);
  }
  registerUnifiedTools(server, asc, gp);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[mcp-app-stores] ready — appstore:${asc ? "on" : "off"} playstore:${gp ? "on" : "off"}`,
  );
}

main().catch((err) => {
  console.error("[mcp-app-stores] Fatal:", err);
  process.exit(1);
});
