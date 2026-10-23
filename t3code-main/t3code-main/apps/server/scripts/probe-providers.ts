// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off preferSchemaOverJson:off - Host-side diagnostic.
// Starts a server in a fresh T3 home and prints what Settings → Providers shows for each provider.
// Usage (from the repository root): node apps/server/scripts/probe-providers.ts
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { ORCHESTRATION_PROTOCOL_VERSION, ORCHESTRATION_PROTOCOL_HEADER, WsRpcGroup } from "@t3tools/contracts";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-probe-"));
const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((done) => reservation.once("listening", done));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((done) => reservation.close(() => done()));
const origin = `http://127.0.0.1:${address.port}`;
const bootstrap = NodeCrypto.randomUUID();
const server = NodeChildProcess.spawn(
  process.execPath,
  ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3", "--log-level", "debug"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe", "pipe"] },
);
const pipe = server.stdio[3];
NodeAssert.ok(pipe && "write" in pipe);
pipe.end(
  JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port: address.port,
    t3Home: home,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrap,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
);
const ready = Promise.withResolvers<void>();
let log = "";
for (const stream of [server.stdout, server.stderr])
  stream?.on("data", (data: Buffer) => {
    log = (log + data.toString()).slice(-20_000);
    if (log.includes("startup phase: complete")) ready.resolve();
  });
server.once("exit", (code) => ready.reject(new Error(`server exited ${code}\n${log}`)));
const deadline = setTimeout(() => ready.reject(new Error("startup timed out")), 120_000);
try {
  await ready.promise;
  clearTimeout(deadline);
  const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await (
      await fetch(`${origin}/oauth/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: bootstrap,
          subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
          requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        }),
      })
    ).json(),
  );
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const ticket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
    await (await fetch(`${origin}/api/auth/websocket-ticket`, { method: "POST", headers })).json(),
  );
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(
        `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
      ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );
  const report = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      const refreshed = yield* client["server.refreshProviders"]({});
      const config = yield* client["server.getConfig"]({});
      return { refreshed, config };
    }).pipe(Effect.scoped, Effect.provide(protocol)),
  );
  const providers = (report.config as { providers: ReadonlyArray<Record<string, unknown>> }).providers;
  for (const p of providers) {
    const models = (p.models as ReadonlyArray<{ slug?: string; id?: string }>) ?? [];
    console.log(
      JSON.stringify({
        instance: p.instanceId,
        driver: p.driver,
        enabled: p.enabled,
        installed: p.installed,
        version: p.version,
        status: p.status,
        auth: p.auth,
        availability: p.availability,
        message: p.message,
        unavailableReason: p.unavailableReason,
        models: models.length,
      }),
    );
  }
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  NodeChildProcess.spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
}
