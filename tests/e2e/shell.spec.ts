import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

test("shared shell exposes menus and the unified settings dialog", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "RustyEra" })).toBeVisible();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect(page.getByRole("button", { name: "项目设置…" })).toBeDisabled();
  await page.getByRole("button", { name: "文件", exact: true }).click();

  await page.getByRole("button", { name: "调试", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续运行", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "调试", exact: true }).click();

  await page.getByRole("button", { name: "帮助", exact: true }).click();
  await expect(page.getByRole("button", { name: "导出诊断信息…" })).toBeDisabled();
  await page.getByRole("button", { name: "关于…" }).click();
  const about = page.getByRole("dialog", { name: "关于 RustyEra" });
  await expect(about).toBeVisible();
  await expect(about.getByText("PrunusSerrulata")).toBeVisible();
  const coreRevision = readFileSync("rustyera-core.rev", "utf8").trim().slice(0, 8);
  await expect(about.getByText(`0.6.0 (${coreRevision})`)).toBeVisible();
  await expect(about.getByText("GPL-3.0-only")).toBeVisible();
  await about.getByRole("button", { name: "确定" }).click();
  await expect(about).toBeHidden();
});
