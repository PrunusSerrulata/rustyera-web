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
});
