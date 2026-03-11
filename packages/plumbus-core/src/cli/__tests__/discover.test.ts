import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverResources, hasAppDirectory } from "../discover.js";

describe("discoverResources", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plumbus-discover-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("returns empty when app/ directory does not exist", async () => {
    const root = makeTmpDir();
    const result = await discoverResources(root);
    expect(result.capabilities).toEqual([]);
    expect(result.entities).toEqual([]);
    expect(result.flows).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.prompts).toEqual([]);
  });

  it("hasAppDirectory returns false when app/ missing", () => {
    const root = makeTmpDir();
    expect(hasAppDirectory(root)).toBe(false);
  });

  it("hasAppDirectory returns true when app/ exists", () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, "app"));
    expect(hasAppDirectory(root)).toBe(true);
  });

  it("returns empty arrays when app/ subdirs are empty", async () => {
    const root = makeTmpDir();
    const dirs = ["capabilities", "entities", "flows", "events", "prompts"];
    for (const d of dirs) {
      fs.mkdirSync(path.join(root, "app", d), { recursive: true });
    }
    const result = await discoverResources(root);
    expect(result.capabilities).toEqual([]);
    expect(result.entities).toEqual([]);
  });
});
