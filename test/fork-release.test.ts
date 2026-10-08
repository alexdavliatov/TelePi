import { readFileSync } from "node:fs";

function readRepoFile(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

function readmeSection(heading: string): string {
  const readme = readRepoFile("README.md");
  const start = readme.indexOf(`## ${heading}\n`);
  expect(start, `Missing README section: ${heading}`).toBeGreaterThanOrEqual(0);
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end < 0 ? undefined : end);
}

describe("fork source release contracts", () => {
  it("points metadata at the fork without changing upstream package identity", () => {
    const pkg = JSON.parse(readRepoFile("package.json"));
    expect(pkg.name).toBe("@futurelab-studio/telepi");
    expect(pkg.version).toBe("0.4.2");
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/alexdavliatov/TelePi.git",
    });
    expect(pkg.homepage).toBe("https://github.com/alexdavliatov/TelePi#readme");
    expect(pkg.bugs.url).toBe("https://github.com/alexdavliatov/TelePi/issues");
  });

  it("retains MIT upstream attribution", () => {
    const license = readRepoFile("LICENSE");
    expect(license).toMatch(/^MIT License\n/);
    expect(license).toContain("Copyright (c) 2026 Benedict Bleimschein");
    expect(license).toContain("The above copyright notice and this permission notice shall be included");
  });

  it("guards the entire release job, not just a step or comment", () => {
    const workflow = readRepoFile(".github/workflows/release.yml");
    const release = workflow.match(/^jobs:\n  release:\n((?:[ \t]+.*\n|\n)*)/m)?.[1];
    expect(release).toBeDefined();
    const stepsStart = release!.indexOf("    steps:\n");
    expect(stepsStart).toBeGreaterThan(0);
    expect(release!.slice(0, stepsStart)).toMatch(
      /^    if: github\.repository == 'benedict2310\/TelePi'$/m,
    );
    expect(release).toContain("Publish package to npm");
    expect(release).toContain("Publish GitHub Release assets");
    expect(workflow).toContain('- "v*.*.*"');
  });

  it("installs the SDK 1.1.0 fork from the explicit source branch", () => {
    const readme = readRepoFile("README.md");
    const install = readmeSection("Try it in 5 minutes");
    expect(readme).toContain("Pi SDK **1.1.0**");
    expect(readme).toContain("https://github.com/benedict2310/TelePi");
    expect(install).toMatch(
      /git clone --branch feat\/pi-1\.1\.0 https:\/\/github\.com\/alexdavliatov\/TelePi\.git\ncd TelePi\nnpm ci\nnpm run build\nnode dist\/cli\.js setup\nnode dist\/cli\.js status/,
    );
    expect(install).toContain("- **Node.js 22.19+**");
    expect(readme).not.toContain("npm install -g @futurelab-studio/telepi");
    expect(readme).toContain("upstream npm package is not this fork");
  });

  it("describes persisted-history handoff and cooperative single-writer limits", () => {
    const handoff = readmeSection("Session Hand-off");
    expect(handoff).toMatch(/persisted history only/i);
    expect(handoff).toContain("not a running terminal stack, an in-flight run, or an already-open dialog");
    expect(handoff).toContain("cooperative single-writer");
    expect(handoff).toContain("no cross-process session-file lock");
    expect(handoff).toContain("Do not open independent CLI and TelePi writers simultaneously");
    expect(handoff).toContain("before shutting down Pi CLI");
    expect(handoff).toContain("TelePi disposes the session");
    expect(handoff).not.toMatch(/seamless|lossless/i);
  });

  it("discloses headless project trust and unsupported terminal interfaces", () => {
    const security = readmeSection("Security model");
    expect(security).toContain("Configured and resumed workspaces are treated as trusted");
    expect(security).toContain("including their project extensions");
    expect(security).toContain("no new trust prompt");
    expect(security).toContain("not a filesystem sandbox");
    const commands = readmeSection("Telegram Commands");
    expect(commands).toContain("select/confirm/input");
    expect(commands).toContain("`custom()` and `editor()` are unsupported");
    expect(commands).toContain("Gauntlet/XPowers terminal dashboards");
    expect(commands).toContain("custom question interfaces");
  });

  it("documents model restoration and the per-session bash settings limitation", () => {
    const sessions = readmeSection("Cross-Workspace Sessions");
    expect(sessions).toContain("saved workspace, settings, and extensions");
    expect(sessions).toContain("Explicit `PI_MODEL` takes precedence");
    expect(sessions).toContain("When unset, an available saved model is restored");
    expect(sessions).toContain("unavailable-model fallback");
    expect(sessions).toContain("does not recreate unavailable models or providers");
    expect(sessions).toContain("`shellPath` and `commandPrefix` are captured per session");
    expect(sessions).toContain("after `/reload`, reopen the session");
  });

  it("limits this fork to source delivery and distinguishes upstream publishing", () => {
    const release = readmeSection("Release Automation");
    expect(release).toContain("This fork must not publish `@futurelab-studio/telepi` or create release tags");
    expect(release).toContain("benedict2310/TelePi");
    expect(release).toContain("feat/pi-1.1.0");
    expect(release).toContain("default branch remains upstream until separately accepted");
    expect(release).not.toContain("npm version");
    expect(release).not.toContain("--follow-tags");
    const agents = readRepoFile("AGENTS.md").split("## Release Automation\n")[1];
    expect(agents).toContain("This fork must not publish `@futurelab-studio/telepi` or create release tags");
    expect(agents).toContain("benedict2310/TelePi");
    expect(agents).toContain("feat/pi-1.1.0");
    expect(agents).toContain("Do not follow the upstream tag-push flow in this fork");
  });

  it("does not represent offline automated checks as live deployment verification", () => {
    const development = readmeSection("Development");
    expect(development).toContain("synthetic offline SDK fixtures and mocked Telegram transport");
    expect(development).toContain("No live Telegram end-to-end tests");
    expect(development).toContain("separate authorization");
  });
});
