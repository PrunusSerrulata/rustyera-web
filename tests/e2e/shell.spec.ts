import { expect, test } from "@playwright/test";

test("shared shell exposes menus and draggable preferences", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "RustyEra" })).toBeVisible();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "偏好设置…" }).click();
  const dialog = page.getByRole("dialog", { name: "偏好设置" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("图片放大倍率")).toBeVisible();
  await expect(dialog.getByText("音量", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "偏好设置…" }).click();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "调试", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续运行", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "调试", exact: true }).click();

  await page.getByRole("button", { name: "帮助", exact: true }).click();
  await expect(page.getByRole("button", { name: "导出诊断信息…" })).toBeDisabled();
  await page.getByRole("button", { name: "关于…" }).click();
  const about = page.getByRole("dialog", { name: "关于 RustyEra" });
  await expect(about).toBeVisible();
  await expect(about.getByText("PrunusSerrulata")).toBeVisible();
  await expect(about.getByText("0.0.3-alpha.1 (c6e613fa)")).toBeVisible();
  await expect(about.getByText("GPL-3.0-only")).toBeVisible();
  await about.getByRole("button", { name: "确定" }).click();
  await expect(about).toBeHidden();
});
