import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type CliIo } from "../command";
import { main } from "../main";

function captureIo(): { stdout: string[]; stderr: string[]; io: CliIo } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string) => stdout.push(chunk) },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    },
  };
}

describe("CLI actor commands", () => {
  let tmpDir: string;
  let actorDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "actor-cli-test-"));
    actorDir = path.join(tmpDir, ".actors");

    // Populate a test SQLite actor database using @di-framework/actors
    const { SqliteActorStorage, ActorRuntime, Actor, ActorMethod, ActorContext } = await import("../../di-framework-actors/src/index.ts");
    const storage = new SqliteActorStorage({ baseDir: actorDir });
    const runtime = new ActorRuntime({ storage, namespace: "cli-app" });

    @Actor()
    class TestCounter {
      @ActorContext()
      ctx!: any;

      @ActorMethod()
      async inc(): Promise<number> {
        const cur = (await this.ctx.storage.get("val")) ?? 0;
        await this.ctx.storage.set("val", cur + 1);
        return cur + 1;
      }
    }

    runtime.register(TestCounter);
    const counter = runtime.get(TestCounter, "test-key");
    await counter.inc();
    await runtime.clear();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("actor list outputs known actors in human text and json format", async () => {
    const textCap = captureIo();
    const code = await main(["actor", "list", "--dir", actorDir, "--namespace", "cli-app"], textCap.io);
    expect(code).toBe(0);
    const text = textCap.stdout.join("");
    expect(text).toContain("Known Actors");
    expect(text).toContain("TestCounter");

    const jsonCap = captureIo();
    const jsonCode = await main(["actor", "list", "--dir", actorDir, "--namespace", "cli-app", "--json"], jsonCap.io);
    expect(jsonCode).toBe(0);
    const json = JSON.parse(jsonCap.stdout.join(""));
    expect(json.ok).toBe(true);
    expect(json.data.actors.length).toBeGreaterThanOrEqual(1);
    expect(json.data.actors[0].actorType).toBe("TestCounter");
  });

  it("actor inspect outputs actor details without dumping private state unless requested", async () => {
    const textCap = captureIo();
    const code = await main(
      ["actor", "inspect", "TestCounter", "--key", "test-key", "--dir", actorDir, "--namespace", "cli-app"],
      textCap.io,
    );
    expect(code).toBe(0);
    const text = textCap.stdout.join("");
    expect(text).toContain("Actor Identity: cli-app:TestCounter:test-key");
    expect(text).not.toContain("Committed State");

    // With --show-state
    const stateCap = captureIo();
    const stateCode = await main(
      ["actor", "inspect", "TestCounter", "--key", "test-key", "--dir", actorDir, "--namespace", "cli-app", "--show-state"],
      stateCap.io,
    );
    expect(stateCode).toBe(0);
    expect(stateCap.stdout.join("")).toContain("Committed State");

    // JSON format
    const jsonCap = captureIo();
    await main(
      ["actor", "inspect", "TestCounter", "--key", "test-key", "--dir", actorDir, "--namespace", "cli-app", "--show-state", "--json"],
      jsonCap.io,
    );
    const json = JSON.parse(jsonCap.stdout.join(""));
    expect(json.ok).toBe(true);
    expect(json.data.state.val).toBe(1);
  });

  it("actor reset enforces explicit scope and removes persisted actor files", async () => {
    // Missing scope should fail with exitCode 2
    const failCap = captureIo();
    const failCode = await main(["actor", "reset", "--dir", actorDir], failCap.io);
    expect(failCode).toBe(2);

    // Scoped reset of actor
    const resetCap = captureIo();
    const resetCode = await main(
      ["actor", "reset", "--actor", "TestCounter", "--key", "test-key", "--dir", actorDir, "--namespace", "cli-app", "--json"],
      resetCap.io,
    );
    expect(resetCode).toBe(0);
    const json = JSON.parse(resetCap.stdout.join(""));
    expect(json.ok).toBe(true);
    expect(json.data.deletedFiles.length).toBeGreaterThanOrEqual(1);

    // After reset, state is gone
    const inspectCap = captureIo();
    await main(
      ["actor", "inspect", "TestCounter", "--key", "test-key", "--dir", actorDir, "--namespace", "cli-app", "--show-state", "--json"],
      inspectCap.io,
    );
    const afterJson = JSON.parse(inspectCap.stdout.join(""));
    expect(afterJson.data.state?.val).toBeUndefined();
  });

  it("actor clean behaves as an alias for actor reset", async () => {
    const cleanCap = captureIo();
    const cleanCode = await main(
      ["actor", "clean", "--all", "--dir", actorDir, "--json"],
      cleanCap.io,
    );
    expect(cleanCode).toBe(0);
    const json = JSON.parse(cleanCap.stdout.join(""));
    expect(json.ok).toBe(true);
  });
});
