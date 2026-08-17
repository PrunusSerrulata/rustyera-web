import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.resolve(import.meta.dirname, "../.github/workflows/deploy-pages.yml");
const workflow = await readFile(workflowPath, "utf8");
const coreInput = workflow.slice(
  workflow.indexOf("      core_commit:\n"),
  workflow.indexOf("\n\npermissions:"),
);

function job(name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`missing ${name} job`);

  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

const buildJob = job("build");
const deployJob = job("deploy");

describe("GitHub Pages deployment workflow", () => {
  it("uses the requested core commit or resolves the latest default-branch commit", () => {
    expect(coreInput).toContain("required: false");
    expect(coreInput).toContain('default: ""');
    expect(buildJob).toContain("CORE_COMMIT: ${{ inputs.core_commit }}");
    expect(buildJob).toContain(
      "git ls-remote https://github.com/PrunusSerrulata/rustyera-core.git HEAD",
    );
    expect(buildJob).toContain("failed to resolve rustyera-core default branch HEAD");
    expect(buildJob).toContain('[[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]');
    expect(buildJob).toContain(
      "node scripts/pin-core-dependencies.mjs '${{ steps.core.outputs.revision }}'",
    );
  });

  it("builds and uploads the WASM site for the Pages base path", () => {
    const wasmBuild = buildJob.indexOf("npm run build:wasm");
    const frontendBuild = buildJob.indexOf(
      "npm run build -- --base='${{ steps.pages.outputs.base_path }}/'",
    );
    const artifactUpload = buildJob.indexOf("actions/upload-pages-artifact@v5");

    expect(wasmBuild).toBeGreaterThan(-1);
    expect(frontendBuild).toBeGreaterThan(wasmBuild);
    expect(artifactUpload).toBeGreaterThan(frontendBuild);
    expect(workflow).toContain("pages: write");
    expect(workflow).toContain("id-token: write");
  });

  it("deploys the uploaded artifact after the build job", () => {
    expect(deployJob).toContain("needs: build");
    expect(deployJob).toContain("actions/deploy-pages@v5");
  });
});
