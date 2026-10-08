import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

import packageJson from "../package.json" with { type: "json" };
import { createSdkFixture } from "./fixtures/pi-sdk-1-1-0.js";

describe("Pi SDK compatibility", () => {
  it("tracks the current Earendil Pi SDK release", () => {
    expect(packageJson.engines.node).toBe(">=22.19.0");
    const packages = ["pi-agent-core", "pi-ai", "pi-coding-agent"] as const;
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    for (const name of packages) {
      const fullName = `@earendil-works/${name}` as keyof typeof packageJson.dependencies;
      expect(packageJson.dependencies[fullName]).toBe("1.1.0");
      expect(lock.packages[""].dependencies[fullName]).toBe("1.1.0");
      const occurrences = Object.entries(lock.packages).filter(([key]) => key.endsWith(`node_modules/${fullName}`));
      expect(occurrences).toHaveLength(1);
      for (const [, metadata] of occurrences) expect((metadata as { version: string }).version).toBe("1.1.0");
      // Vitest's import.meta shim has no resolve; resolve under native Node's ESM conditions.
      const entrypoint = execFileSync(process.execPath, ["--input-type=module", "-e",
        "console.log(import.meta.resolve(process.argv[1]))", fullName,
      ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }).trim();
      let directory = path.dirname(fileURLToPath(entrypoint));
      while (!existsSync(path.join(directory, "package.json"))) {
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error(`No installed metadata for ${fullName}`);
        directory = parent;
      }
      const installed = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
      expect(installed.name).toBe(fullName);
      expect(installed.version).toBe("1.1.0");
    }
    expect(packageJson.dependencies.undici).toBe("8.10.2");
  });

  it("documents and releases on the supported Node version", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const releaseWorkflow = readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );

    expect(readme).toContain("- **Node.js 22.19+**");
    expect(releaseWorkflow).toMatch(/node-version:\s*["']?22\.19["']?/);
  });

  it("loads external extensions that import Earendil Pi packages", async () => {
    const fixture = createSdkFixture();
    const extensionPath = path.join(fixture.root, "extension.ts");

    try {
      writeFileSync(
        extensionPath,
        [
          'import { DefaultResourceLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";',
          'import { Container } from "@earendil-works/pi-tui";',
          'import { uuidv7 as aiUuidv7 } from "@earendil-works/pi-ai";',
          'import { Agent } from "@earendil-works/pi-agent-core";',
          "",
          "export default function extension(pi: ExtensionAPI): void {",
          "  const runtimeImports = [DefaultResourceLoader, Container, aiUuidv7, Agent];",
          "  pi.registerCommand(\"telepi-sdk-check\", {",
          "    description: `loaded:${runtimeImports.every(Boolean)}`,",
          "    handler: async () => {},",
          "  });",
          "}",
          "",
        ].join("\n"),
      );

      const loader = new DefaultResourceLoader({
        cwd: fixture.workspace,
        agentDir: fixture.agentDir,
        additionalExtensionPaths: [extensionPath],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

      await loader.reload();
      const result = loader.getExtensions();

      expect(result.errors).toEqual([]);
      expect(result.extensions).toHaveLength(3);
      const extension = result.extensions.find((item) => item.commands.has("telepi-sdk-check"));
      expect(extension).toBeDefined();
      expect(extension?.commands.has("telepi-sdk-check")).toBe(true);
      expect(extension?.commands.get("telepi-sdk-check")?.description).toBe("loaded:true");
      expect(fixture.faux.models.map((model) => model.id)).toEqual(["saved", "override"]);
      expect(fixture.fetchSpy).not.toHaveBeenCalled();
      expect(fixture.networkSpy).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });
});
