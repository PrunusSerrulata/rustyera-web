/* global document, window */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

// The official runner retains its independent five-second full DOM/runtime watchdog.
export async function cancelProjectExportDuringTransfer(page, action) {
  assert.ok(path.isAbsolute(action.evidence_path), "cancellation evidence needs an absolute path");
  const samples = [];
  await writeFile(action.evidence_path, JSON.stringify({ status: "started" }), { flag: "wx" });
  const observe = async (phase) => {
    const state = await page.evaluate(() => {
      const state = window.__RUSTYERA_TEST__.snapshotSummary();
      return {
        memory: state.memory,
        transfer: state.transfer,
        fault: state.fault,
        canInteract: state.canInteract,
        status: state.status,
      };
    });
    samples.push({ phase, timestamp: Date.now(), elapsedMs: Date.now() - started, ...state });
    await writeFile(action.evidence_path, JSON.stringify({ status: "observing", samples }));
    assert.equal(state.fault, null);
    return state;
  };
  const started = Date.now();
  let evidence;
  try {
    await observe("before");
    await page.locator(action.selector).click();
    await page.locator(".full-project-export").waitFor({ state: "visible" });
    // Use actual submitted bytes, never elapsed time after the initial scan button click.
    await page.waitForFunction(
      () => {
        const state = window.__RUSTYERA_TEST__.snapshotSummary();
        if (state.fault) throw new Error(JSON.stringify(state.fault));
        if (!document.querySelector(".full-project-export"))
          throw new Error(`export ended before the cancellation boundary: ${state.status}`);
        return state.transfer.fullManifest?.submittedBytes >= 8 * 1024 * 1024;
      },
      undefined,
      { polling: 50, timeout: 0 },
    );
    const beforeCancel = await observe("before-cancel");
    assert.ok(beforeCancel.transfer.fullManifest.submittedBytes > 0);
    assert.equal(beforeCancel.canInteract, false);
    await page
      .getByRole("dialog", { name: "导出全量项目文件", exact: true })
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await observe("cancel-submitted");
    await page.waitForFunction(
      () => {
        const state = window.__RUSTYERA_TEST__.snapshotSummary();
        return (
          state.canInteract &&
          !document.querySelector(".full-project-export") &&
          state.transfer.fullManifest === null
        );
      },
      undefined,
      { polling: 50, timeout: 0 },
    );
    await observe("finished");
    evidence = await page.evaluate(() =>
      window.__RUSTYERA_TEST__.protocolEvidence([
        "state_import_chunk",
        "state_import_commit",
        "state_transfer_cancel",
        "state_export_cancel",
        "state_export_request",
      ]),
    );
    assert.equal(evidence.failure, null, "protocol evidence must be complete");
    const sent = evidence.records.filter((record) => record.direction === "send");
    const cancelled = sent.findLastIndex(
      (record) => record.message.type === "state_transfer_cancel",
    );
    assert.ok(cancelled >= 0, "manifest transfer cancellation was not submitted");
    assert.ok(
      !sent
        .slice(cancelled + 1)
        .some(
          (record) =>
            ["state_import_chunk", "state_import_commit"].includes(record.message.type) ||
            (record.message.type === "state_export_request" &&
              record.message.value.kind === "full_project_file"),
        ),
      "cancelled export must not continue uploading or request packaging",
    );
    await writeFile(action.evidence_path, JSON.stringify({ status: "passed", samples, evidence }));
    return { query: { cancellation: { evidence: action.evidence_path, samples } } };
  } catch (error) {
    await writeFile(
      action.evidence_path,
      JSON.stringify({ status: "failed", error: String(error), samples, evidence }),
    );
    throw error;
  }
}
