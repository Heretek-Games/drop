/**
 * Integration check for the ZTNET mesh backend.
 *
 * Requires a running ZTNET + controller (see deploy-template/compose.ztnet.yaml):
 *   GSE_ZTNET_URL=http://localhost:3001 \
 *   GSE_ZTNET_ORG=<org id> GSE_ZTNET_TOKEN=<org token> \
 *     pnpm exec jiti dev-tools/gse-ztnet-check.ts
 */
import { ZtnetBackend } from "../server/internal/plugins/builtin/gse/ztnet";

const baseUrl = process.env.GSE_ZTNET_URL;
const apiToken = process.env.GSE_ZTNET_TOKEN;
const organizationId = process.env.GSE_ZTNET_ORG;

if (!baseUrl || !apiToken || !organizationId) {
  console.error(
    "Set GSE_ZTNET_URL, GSE_ZTNET_TOKEN and GSE_ZTNET_ORG before running.",
  );
  process.exit(2);
}

const sanitizeForLog = (value: unknown) => String(value).replace(/[\r\n]/g, "");

const backend = new ZtnetBackend({ baseUrl, apiToken, organizationId });
const roomId = `check-${Date.now()}`;
// A synthetic ZeroTier node id (10 hex); the API pre-authorizes members that
// have not joined yet.
const memberId = "abcdef0123";

const mesh = await backend.provision(roomId, Date.now() + 60 * 60 * 1000);
console.log("provisioned", mesh);
if (mesh.backend !== "zerotier") {
  throw new Error("unexpected mesh backend");
}

let address: string | undefined;
for (let attempt = 0; attempt < 15 && !address; attempt++) {
  address = await backend.authorizeMember(roomId, "user-1", memberId);
  if (!address) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
console.log("member address", sanitizeForLog(address));
if (!address) {
  throw new Error("no address assigned to the member");
}

await backend.revokeMember(roomId, "user-1");
await backend.teardown(roomId, mesh);
console.log("torn down");

console.log("OK");
