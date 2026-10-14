import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TokenStore, hashToken } from "../src/lib/tokenStore.js";

const tmpFile = async () => join(await mkdtemp(join(os.tmpdir(), "fc-tokens-")), "tokens.json");

test("TokenStore issues, verifies, lists, and revokes hashed tokens", async () => {
  const filePath = await tmpFile();
  const store = await new TokenStore({ filePath }).load();
  assert.equal(store.initialized, false);

  const a = await store.create({ name: "Default" });
  const b = await store.create({ name: "   " });
  const c = await store.create();
  assert.equal(b.item.name, "Token 2");
  assert.equal(c.item.name, "Token 3");
  assert.notEqual(a.token, b.token);

  const raw = await readFile(filePath, "utf8");
  for (const t of [a, b, c]) {
    assert.equal(raw.includes(t.token), false, "plaintext persisted");
    assert.ok(raw.includes(hashToken(t.token)));
  }

  assert.ok(store.verify(a.token));
  assert.equal(store.verify("wrong"), null);
  assert.equal(store.verify(""), null);
  assert.equal(store.verify(null), null);
  assert.ok(store.list()[0].lastUsedAt);

  assert.equal(await store.revoke(b.item.id), true);
  assert.equal(await store.revoke(b.item.id), false);
  assert.equal(store.verify(b.token), null);

  // Auto-name counter does not reuse numbers after revocation.
  const d = await store.create({});
  assert.equal(d.item.name, "Token 4");

  const reloaded = await new TokenStore({ filePath }).load();
  assert.deepEqual(reloaded.list().map((t) => t.name), ["Default", "Token 3", "Token 4"]);
  assert.ok(reloaded.verify(c.token));
  assert.equal(reloaded.verify(b.token), null);
});

test("TokenStore rejects overlong names and strips control characters", async () => {
  const store = await new TokenStore({ filePath: await tmpFile() }).load();
  await assert.rejects(store.create({ name: "x".repeat(65) }));
  const t = await store.create({ name: "CI\u0000 bot\n" });
  assert.equal(t.item.name, "CI bot");
});

test("ACCESS_TOKEN env entry is accepted, listed, and not revocable", async () => {
  const store = await new TokenStore({ filePath: await tmpFile(), envToken: "env-secret-token" }).load();
  assert.equal(store.initialized, true);
  assert.ok(store.verify("env-secret-token"));
  const [env] = store.list();
  assert.equal(env.envManaged, true);
  assert.equal(await store.revoke(env.id), false);
  assert.ok(store.verify("env-secret-token"));
});
