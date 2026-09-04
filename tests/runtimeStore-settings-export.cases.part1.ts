import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  blake3,
  emptyBatch,
  mockProjectSelection,
  normalizePreferences,
  projectConfigurationReport,
  useRuntimeStore,
  runtimeEvent,
} from "./runtimeStoreTestSupport";
describe("runtime store settings-export", () => {
  installRuntimeStoreTestHarness();

  it("continues loading when the host cannot apply a native window setting", async () => {
    bridge.applyProjectConfiguration.mockRejectedValueOnce(new Error("window unavailable"));
    const configuration = {
      project_revision: 1,
      source_digest: new Uint8Array(32).fill(1),
      entries: [
        {
          code: "SizableWindow",
          japanese: "",
          english: "Resizable window",
          value: "YES",
          effective_value: "YES",
          preference_eligible: false,
          client_effective_value: "YES",
          kind: "boolean",
          allowed: [],
          fixed: false,
          applicability: 8,
        },
      ],
    };
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration,
        }),
      ],
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("client_preferences_applied", { configuration }, 1)],
    });
    const store = useRuntimeStore();

    await expect(store.enableDebug()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(16);

    expect(store.fault).toBeNull();
    expect(store.status).toBe("项目加载完成，正在启动游戏…");
    expect(store.logs.at(-1)?.message).toContain("客户端项目配置应用失败");
  });

  it("keeps project progress active until host configuration application finishes", async () => {
    let finishHostConfiguration!: () => void;
    bridge.applyProjectConfiguration.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishHostConfiguration = resolve;
      }),
    );
    const report = projectConfigurationReport(2, 3, "18");
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", report)],
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("client_preferences_applied", { configuration: report.configuration }, 1),
      ],
    });
    const store = useRuntimeStore();
    store.projectLoading = true;

    const loading = store.enableDebug();
    await vi.advanceTimersByTimeAsync(16);
    expect(store.projectLoading).toBe(true);
    finishHostConfiguration();
    await loading;
    await vi.advanceTimersByTimeAsync(16);

    expect(store.projectLoading).toBe(false);
    expect(store.status).toBe("项目加载完成，正在启动游戏…");
  });

  it.each([
    {
      label: "refreshes the compiled cache after a full-source configuration update",
      diagnostics: [],
      requestsCompiledCache: true,
    },
    {
      label: "defers cache replacement after a cache-hit configuration update",
      diagnostics: [
        {
          code: "runtime.compiled_cache_hit",
          level: "info",
          message: "loaded the exact compiled project cache",
        },
      ],
      requestsCompiledCache: false,
    },
  ])("$label", async ({ diagnostics, requestsCompiledCache }) => {
    let messageId = 20;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    const configuration = {
      project_revision: 3,
      source_digest: new Uint8Array(32).fill(7),
      entries: [
        {
          code: "FontSize",
          japanese: "フォントサイズ",
          english: "Font size",
          value: "12",
          effective_value: "12",
          preference_eligible: true,
          client_effective_value: "12",
          kind: "integer",
          allowed: [],
          fixed: false,
          applicability: 8,
        },
      ],
    };
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics,
          configuration,
        }),
      ],
    });
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("client_preferences_applied", { configuration }, 20)],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(16);
    store.projectOpen = true;
    const saving = store.saveProjectSettings([{ code: "FontSize", value: "18" }]);
    await Promise.resolve();
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 3,
              expected_source_digest: new Uint8Array(32).fill(7),
              contents: "[text]\nfont_size = 18\n",
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode("[text]\nfont_size = 18\n")),
            },
            22,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_committed",
            {
              configuration: {
                project_revision: 3,
                source_digest: blake3(new TextEncoder().encode("[text]\nfont_size = 18\n")),
                restart_pending: false,
                generated_source: null,
                entries: [
                  {
                    code: "FontSize",
                    japanese: "フォントサイズ",
                    english: "Font size",
                    value: "18",
                    effective_value: "18",
                    default_value: "18",
                    application: "hot",
                    kind: "integer",
                    allowed: [],
                    fixed: false,
                    applicability: 8,
                  },
                ],
              },
            },
            23,
          ),
        ],
      });

    await vi.advanceTimersByTimeAsync(64);
    await saving;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(bridge.writeProjectConfiguration).toHaveBeenCalledWith(
      new Uint8Array(32).fill(7),
      "[text]\nfont_size = 18\n",
    );
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "finalize_configuration_update",
        value: { preparation_message_id: 22, outcome: "commit" },
      },
      undefined,
    );
    expect(
      bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "compiled_project_cache",
      ),
    ).toBe(requestsCompiledCache);
    expect(store.status).toBe("项目设置已应用");
    expect(
      store.logs.some((entry) => entry.message.includes("runtime.compiled_cache_failed")),
    ).toBe(false);
    expect(bridge.restartProject).not.toHaveBeenCalled();

    if (!requestsCompiledCache) {
      const cacheRequestCount = () =>
        bridge.submitRuntime.mock.calls.filter(
          ([message]: unknown[]) =>
            (message as { type?: string; value?: { kind?: string } }).type ===
              "state_export_request" &&
            (message as { value?: { kind?: string } }).value?.kind === "compiled_project_cache",
        ).length;
      const requestsBeforeReload = cacheRequestCount();
      bridge.pump.mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("project_load_report", {
            success: true,
            diagnostics: [],
            configuration: {
              project_revision: 3,
              source_digest: blake3(new TextEncoder().encode("[text]\nfont_size = 18\n")),
              entries: [
                {
                  code: "FontSize",
                  japanese: "フォントサイズ",
                  english: "Font size",
                  value: "18",
                  effective_value: "18",
                  default_value: "18",
                  application: "hot",
                  kind: "integer",
                  allowed: [],
                  fixed: false,
                  applicability: 8,
                },
              ],
            },
          }),
        ],
      });

      await store.reloadProject();
      await vi.advanceTimersByTimeAsync(16);

      const secondContents = "[text]\nfont_size = 20\n";
      const savingAgain = store.saveProjectSettings([{ code: "FontSize", value: "20" }]);
      await Promise.resolve();
      const secondPrepareMessageId = messageId - 1;
      bridge.pump.mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 3,
              expected_source_digest: blake3(new TextEncoder().encode("[text]\nfont_size = 18\n")),
              contents: secondContents,
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode(secondContents)),
            },
            secondPrepareMessageId,
          ),
        ],
      });
      await vi.advanceTimersByTimeAsync(16);
      const secondFinalizeMessageId = messageId - 1;
      bridge.pump.mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_committed",
            {
              configuration: {
                project_revision: 3,
                source_digest: blake3(new TextEncoder().encode(secondContents)),
                restart_pending: false,
                generated_source: null,
                entries: [
                  {
                    code: "FontSize",
                    japanese: "フォントサイズ",
                    english: "Font size",
                    value: "20",
                    effective_value: "20",
                    default_value: "20",
                    application: "hot",
                    kind: "integer",
                    allowed: [],
                    fixed: false,
                    applicability: 8,
                  },
                ],
              },
            },
            secondFinalizeMessageId,
          ),
        ],
      });
      await vi.advanceTimersByTimeAsync(16);
      await savingAgain;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(cacheRequestCount()).toBeGreaterThan(requestsBeforeReload);
    }
  });

  it("lets hot project fonts take effect after migrating hidden legacy overrides", async () => {
    const textLine = (fontFamily: string, fontSize: number) => ({
      line_id: 1,
      temporary: false,
      logical_line_start: true,
      line_end: true,
      alignment: "left",
      runs: [
        {
          type: "text",
          text: "font sample",
          style: {
            foreground: { red: 255, green: 255, blue: 255, alpha: 255 },
            bold: false,
            italic: false,
            underline: false,
            strikeout: false,
            font_family: fontFamily,
            font_millipixels: fontSize * 1_000,
          },
        },
      ],
    });
    const configuration = (fontFamily: string, fontSize: string, digestByte: number) => ({
      project_revision: 3,
      source_digest: new Uint8Array(32).fill(digestByte),
      restart_pending: false,
      generated_source: null,
      entries: [
        {
          code: "FontName",
          japanese: "フォント名",
          english: "Font name",
          value: fontFamily,
          effective_value: fontFamily,
          default_value: "ＭＳ ゴシック",
          application: "hot",
          kind: "string",
          allowed: [],
          fixed: false,
          applicability: 8,
        },
        {
          code: "FontSize",
          japanese: "フォントサイズ",
          english: "Font size",
          value: fontSize,
          effective_value: fontSize,
          default_value: "18",
          application: "hot",
          kind: "integer",
          allowed: [],
          fixed: false,
          applicability: 8,
        },
      ],
    });
    const migrated = normalizePreferences({
      schemaVersion: 2,
      fontFamilyOverride: "Hidden Legacy Font",
      fontSizeOverridePx: 42,
      imageScale: 1.5,
      masterVolume: 0.75,
    });
    expect(migrated).toMatchObject({
      schemaVersion: 7,
      interactionAssistMode: "auto",
      fontFamilyOverride: null,
      fontSizeOverridePx: null,
      imageScale: 1.5,
      masterVolume: 0.75,
    });
    bridge.savePreferences.mockResolvedValueOnce(migrated);
    bridge.projectConfigurationWritable.mockReturnValue(false);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: configuration("Old Project Font", "16", 7),
        }),
        runtimeEvent("presentation_snapshot", {
          revision: 1,
          title: "font migration",
          history: { logical_lines: [textLine("Old Project Font", 16)] },
        }),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    expect(store.gameTextStyle).toMatchObject({
      fontFamily: "Old Project Font",
      fontSize: "16px",
    });

    let messageId = 70;
    bridge.submitRuntime.mockReset();
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    const saving = store.saveProjectSettings([
      { code: "FontName", value: "New Project Font" },
      { code: "FontSize", value: "20" },
    ]);
    await Promise.resolve();
    const contents = "フォント名:New Project Font\nフォントサイズ:20\n";
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 3,
              expected_source_digest: new Uint8Array(32).fill(7),
              contents,
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode(contents)),
            },
            70,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_committed",
            { configuration: configuration("New Project Font", "20", 8) },
            71,
          ),
          runtimeEvent("presentation_delta", {
            base_revision: 1,
            new_revision: 2,
            operations: [
              {
                type: "replace_line",
                line_id: 1,
                line: textLine("New Project Font", 20),
              },
            ],
          }),
        ],
      });

    await vi.advanceTimersByTimeAsync(64);
    await saving;

    expect(bridge.applyProjectConfiguration).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ code: "FontName", effective_value: "New Project Font" }),
        expect.objectContaining({ code: "FontSize", effective_value: "20" }),
      ]),
      { width: 0, height: 0 },
      ["FontName", "FontSize"],
    );
    expect(store.gameTextStyle).toMatchObject({
      fontFamily: "New Project Font",
      fontSize: "20px",
    });
  });

  it("commits hot project-file settings for this session without writing the package", async () => {
    let messageId = 30;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.projectConfigurationWritable.mockReturnValue(false);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", projectConfigurationReport(4, 5, "16"))],
    });
    mockProjectSelection(
      {
        submittedAtMs: 0,
        quickScanMs: 1,
        cacheReadMs: 0,
        sourceReadMs: 0,
        submitMs: 1,
        cacheImported: true,
      },
      "openProjectFile",
    );
    const store = useRuntimeStore();
    await store.openProjectFile();
    await vi.advanceTimersByTimeAsync(64);
    expect(store.configurationReadOnly).toBe(true);
    expect(store.configurationSessionOnly).toBe(true);
    expect(store.projectSource).toBe("file");

    const saving = store.saveProjectSettings([{ code: "FontSize", value: "18" }]);
    await Promise.resolve();
    const contents = "[text]\nfont_size = 18\n";
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 4,
              expected_source_digest: new Uint8Array(32).fill(5),
              contents,
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode(contents)),
            },
            31,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_committed",
            { configuration: projectConfigurationReport(4, 6, "18").configuration },
            32,
          ),
        ],
      });

    await vi.advanceTimersByTimeAsync(64);
    await saving;

    expect(bridge.writeProjectConfiguration).not.toHaveBeenCalled();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "finalize_configuration_update",
        value: { preparation_message_id: 31, outcome: "commit" },
      },
      undefined,
    );
    expect(store.status).toContain("退出游戏后将丢失");
    expect(
      bridge.submitRuntime.mock.calls.some(
        ([message]: unknown[]) =>
          (message as { type?: string; value?: { kind?: string } }).type ===
            "state_export_request" &&
          (message as { value?: { kind?: string } }).value?.kind === "compiled_project_cache",
      ),
    ).toBe(false);
    expect(store.configurationEntries[0]?.effective_value).toBe("18");
  });

  it("refreshes directory writability after an early project configuration report", async () => {
    bridge.projectConfigurationWritable.mockReturnValue(false);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", projectConfigurationReport(4, 5, "16"))],
    });
    bridge.openProject.mockImplementation(async (onSubmitted, prepareAfterSelection) => {
      onSubmitted?.(performance.now());
      await prepareAfterSelection?.();
      bridge.projectConfigurationWritable.mockReturnValue(true);
      return {
        submittedAtMs: performance.now(),
        quickScanMs: 1,
        cacheReadMs: 0,
        sourceReadMs: 1,
        submitMs: 1,
        cacheImported: false,
      };
    });
    const store = useRuntimeStore();

    await store.openProject();

    expect(store.projectSource).toBe("directory");
    expect(store.configurationReadOnly).toBe(false);
    expect(store.configurationSessionOnly).toBe(false);
  });

  it("rejects non-hot project-file changes before starting a Runtime transaction", async () => {
    bridge.projectConfigurationWritable.mockReturnValue(false);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("project_load_report", {
          success: true,
          diagnostics: [],
          configuration: {
            project_revision: 7,
            source_digest: new Uint8Array(32).fill(8),
            restart_pending: false,
            generated_source: null,
            entries: [
              {
                code: "AutoSave",
                japanese: "自動保存",
                english: "Auto save",
                value: "YES",
                effective_value: "YES",
                default_value: "YES",
                application: "restart",
                kind: "boolean",
                allowed: [],
                fixed: false,
                applicability: 8,
              },
              {
                code: "FontSize",
                japanese: "フォントサイズ",
                english: "Font size",
                value: "16",
                effective_value: "16",
                default_value: "16",
                application: "hot",
                kind: "integer",
                allowed: [],
                fixed: true,
                applicability: 8,
              },
            ],
          },
        }),
      ],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    bridge.submitRuntime.mockClear();

    for (const change of [
      { code: "AutoSave", value: "NO" },
      { code: "FontSize", value: "18" },
      { code: "UnknownDisplaySetting", value: "1" },
    ]) {
      await store.saveProjectSettings([change]);
      expect(store.projectSettingsError).toContain("仅支持当前会话内即时生效的设置");
    }

    expect(bridge.submitRuntime).not.toHaveBeenCalled();
    expect(bridge.writeProjectConfiguration).not.toHaveBeenCalled();
  });
});
