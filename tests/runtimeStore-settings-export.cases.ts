import { bridge } from "./runtimeStoreTestSupport";
import { describe, expect, it, vi } from "vitest";
import {
  installRuntimeStoreTestHarness,
  blake3,
  emptyBatch,
  mockProjectSelection,
  normalizePreferences,
  projectConfigurationReport,
  stateExportChunkEvent,
  stateExportReadyEvent,
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
      schemaVersion: 5,
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

  it("aborts a prepared transaction when the host write fails and does not hot-apply it", async () => {
    let messageId = 40;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.writeProjectConfiguration.mockRejectedValueOnce(new Error("disk full"));
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", projectConfigurationReport(5, 6, "12"))],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    bridge.applyProjectConfiguration.mockClear();
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
              project_revision: 5,
              expected_source_digest: new Uint8Array(32).fill(6),
              contents,
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode(contents)),
            },
            41,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_committed",
            { configuration: projectConfigurationReport(5, 6, "12").configuration },
            42,
          ),
        ],
      });

    await vi.advanceTimersByTimeAsync(64);
    await saving;

    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "finalize_configuration_update",
        value: { preparation_message_id: 41, outcome: "abort" },
      },
      undefined,
    );
    expect(bridge.applyProjectConfiguration).not.toHaveBeenCalled();
    expect(store.projectSettingsError).toContain("disk full");
  });

  it("clears a rejected finalization so a later save can start", async () => {
    let messageId = 60;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.createSession.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [runtimeEvent("project_load_report", projectConfigurationReport(8, 9, "12"))],
    });
    const store = useRuntimeStore();
    await store.enableDebug();
    const firstSave = store.saveProjectSettings([{ code: "FontSize", value: "18" }]);
    await Promise.resolve();
    const contents = "[text]\nfont_size = 18\n";
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "configuration_update_prepared",
            {
              project_revision: 8,
              expected_source_digest: new Uint8Array(32).fill(9),
              contents,
              restart_required: false,
              prepared_source_digest: blake3(new TextEncoder().encode(contents)),
            },
            61,
          ),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("command_rejected", { message: "finalize rejected" }, 62)],
      });
    await vi.advanceTimersByTimeAsync(64);
    await firstSave;
    expect(store.projectSettingsError).toContain("finalize rejected");

    void store.saveProjectSettings([{ code: "FontSize", value: "20" }]);
    await Promise.resolve();

    const prepareCalls = bridge.submitRuntime.mock.calls.filter(
      (call: unknown[]) => (call[0] as any).type === "prepare_configuration_update",
    );
    expect(prepareCalls).toHaveLength(2);
  });

  it("uses the browser close gesture for the WASM exit action", async () => {
    bridge.kind = "browser";
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const store = useRuntimeStore();

    await store.shutdown();

    expect(close).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.status).toContain("请手动关闭此标签页");
  });

  it("uses the TUI snapshot filename format in local time", async () => {
    vi.setSystemTime(new Date(2026, 6, 30, 0, 30, 7));
    const store = useRuntimeStore();

    await store.exportSnapshot();

    expect(store.testTransferState()).toMatchObject({
      export: { name: "runtime_20260730-003007.snapshot" },
    });
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "vm_snapshot", snapshot_purpose: "normal" },
      },
      undefined,
    );
  });

  it.each([
    {
      label: "suppresses the exact state-export warning mirror",
      runtimeWarning: "state export is ineligible: [StableWaitRequired]",
      expectedNotifications: 1,
    },
    {
      label: "keeps an unrelated adjacent state-export warning",
      runtimeWarning: "an unrelated export warning",
      expectedNotifications: 2,
    },
  ])("$label", async ({ runtimeWarning, expectedNotifications }) => {
    const store = useRuntimeStore();
    await store.enableDebug();
    await store.exportSnapshot();
    bridge.pump.mockResolvedValueOnce({
      ...emptyBatch(),
      events: [
        runtimeEvent("log", { level: "warning", message: runtimeWarning }),
        runtimeEvent(
          "state_export_ready",
          {
            kind: "vm_snapshot",
            result: { type: "ineligible", reasons: ["stable_wait_required"] },
          },
          1,
        ),
      ],
    });

    await vi.advanceTimersByTimeAsync(16);

    expect(store.testTransferState().export).toBeNull();
    expect(store.logs.map((entry) => entry.message).slice(-2)).toEqual([
      runtimeWarning,
      "当前状态不能导出快照：stable_wait_required",
    ]);
    expect(store.logNotifications).toHaveLength(expectedNotifications);
  });

  it("streams a titled project file through the host export boundary", async () => {
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 }),
          runtimeEvent("presentation_snapshot", {
            revision: 1,
            title: "测试项目",
            history: { logical_lines: [] },
          }),
        ],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          stateExportReadyEvent("full_project_file", 7, [1, 2, 3]),
          {
            ...stateExportChunkEvent(7, []),
            dataBytes: Uint8Array.of(1, 2, 3),
          },
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportProjectFile();
    expect(store.gameInteractionsBlocked).toBe(true);
    expect(store.canInteract).toBe(false);
    expect(store.canOpenProject).toBe(false);
    await vi.advanceTimersByTimeAsync(32);

    expect(bridge.beginProjectFileExport).toHaveBeenCalledWith("测试项目.reraproj");
    expect(bridge.stageFullProjectManifest).toHaveBeenCalledOnce();
    expect(bridge.submitRuntime).toHaveBeenCalledWith(
      {
        type: "state_export_request",
        value: { kind: "full_project_file", snapshot_purpose: "normal" },
      },
      undefined,
    );
    expect(
      bridge.submitRuntime.mock.calls
        .map(
          ([message]: unknown[]) =>
            message as { type?: string; value?: { maximum_bytes?: number } },
        )
        .filter((message) => message.type === "state_export_chunk_request")
        .map((message) => message.value?.maximum_bytes),
    ).toEqual([16 * 1024 * 1024]);
    expect(bridge.writeProjectFileChunk).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3), true, true);
    expect(store.gameInteractionsBlocked).toBe(false);
  });

  it("imports a full manifest in chunks before requesting project packaging", async () => {
    const manifest = Uint8Array.of(1, 2, 3, 4, 5);
    bridge.stageFullProjectManifest.mockResolvedValueOnce({ totalBytes: manifest.byteLength });
    bridge.readFullProjectManifestChunk.mockImplementationOnce(async (offset, maximumBytes) =>
      manifest.slice(offset, offset + maximumBytes),
    );
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_import_ready", { transfer_id: 19, kind: "full_project_manifest" }, 1),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(48);

    const messages = bridge.submitRuntime.mock.calls.map(([message]) => message);
    expect(messages).toContainEqual({
      type: "state_import_begin",
      value: {
        kind: "full_project_manifest",
        total_bytes: manifest.byteLength,
        digest: null,
        artifact_id: null,
      },
    });
    expect(messages).toContainEqual({
      type: "state_import_chunk",
      value: { transfer_id: 19, offset: 0, data: manifest },
    });
    expect(messages).toContainEqual({
      type: "state_import_commit",
      value: { transfer_id: 19, digest: blake3(manifest) },
    });
    expect(messages).toContainEqual({
      type: "state_export_request",
      value: { kind: "full_project_file", snapshot_purpose: "normal" },
    });
    await store.cancelProjectFileExport();
  });

  it("reads full manifests larger than four MiB through exact bounded bridge chunks", async () => {
    const manifest = new Uint8Array(4 * 1024 * 1024 + 3).fill(7);
    let messageId = 1;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.stageFullProjectManifest.mockResolvedValueOnce({ totalBytes: manifest.byteLength });
    bridge.readFullProjectManifestChunk.mockImplementation(async (offset, maximumBytes) =>
      manifest.slice(offset, offset + maximumBytes),
    );
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_import_ready", { transfer_id: 19, kind: "full_project_manifest" }, 4),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(48);

    expect(bridge.readFullProjectManifestChunk.mock.calls).toEqual([
      [0, 4 * 1024 * 1024],
      [4 * 1024 * 1024, 3],
    ]);
    const chunks = bridge.submitRuntime.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "state_import_chunk");
    expect(chunks.map((message) => [message.value.offset, message.value.data.byteLength])).toEqual([
      [0, 4 * 1024 * 1024],
      [4 * 1024 * 1024, 3],
    ]);
    expect(bridge.releaseFullProjectManifest).toHaveBeenCalledOnce();
    await store.cancelProjectFileExport();
  });

  it("does not package a project for mismatched manifest Ready events", async () => {
    let messageId = 1;
    bridge.submitRuntime.mockImplementation(async () => messageId++);
    bridge.stageFullProjectManifest.mockResolvedValueOnce({ totalBytes: 1 });
    bridge.readFullProjectManifestChunk.mockResolvedValueOnce(Uint8Array.of(1));
    bridge.pump
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
      })
      .mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent("state_import_ready", { transfer_id: 20, kind: "full_project_manifest" }, 3),
          runtimeEvent("state_import_ready", { transfer_id: 19, kind: "vm_snapshot" }, 3),
        ],
      });
    const store = useRuntimeStore();
    store.projectOpen = true;
    await store.enableDebug();
    await vi.advanceTimersByTimeAsync(0);

    await store.exportProjectFile();
    await vi.advanceTimersByTimeAsync(48);

    expect(
      bridge.submitRuntime.mock.calls.some(
        ([message]) =>
          message.type === "state_export_request" && message.value.kind === "full_project_file",
      ),
    ).toBe(false);
    await store.cancelProjectFileExport();
  });

  it.each([
    { phase: "begin", rejectionBatch: 2, correlation: 1, accepted: false },
    { phase: "chunk", rejectionBatch: 3, correlation: 2, accepted: true },
    { phase: "commit", rejectionBatch: 3, correlation: 3, accepted: true },
  ])(
    "cleans a rejected full-manifest $phase command",
    async ({ rejectionBatch, correlation, accepted }) => {
      let messageId = 1;
      bridge.submitRuntime.mockImplementation(async () => messageId++);
      bridge.stageFullProjectManifest.mockResolvedValueOnce({ totalBytes: 1 });
      bridge.readFullProjectManifestChunk.mockResolvedValueOnce(Uint8Array.of(1));
      bridge.pump.mockResolvedValueOnce({
        ...emptyBatch(),
        events: [runtimeEvent("state_changed", { phase: "waiting_input", epoch: 2 })],
      });
      if (accepted) {
        bridge.pump.mockResolvedValueOnce({
          ...emptyBatch(),
          events: [runtimeEvent("state_import_accepted", { transfer_id: 19 }, 1)],
        });
      }
      bridge.pump.mockResolvedValueOnce({
        ...emptyBatch(),
        events: [
          runtimeEvent(
            "command_rejected",
            { code: "invalid_value", message: "rejected" },
            correlation,
          ),
        ],
      });
      const store = useRuntimeStore();
      store.projectOpen = true;
      await store.enableDebug();
      await vi.advanceTimersByTimeAsync(0);

      await store.exportProjectFile();
      await vi.advanceTimersByTimeAsync(rejectionBatch * 16);

      expect(bridge.releaseFullProjectManifest).toHaveBeenCalled();
      expect(bridge.cancelProjectFileExport).toHaveBeenCalled();
      if (accepted)
        expect(bridge.submitRuntime).toHaveBeenCalledWith(
          { type: "state_transfer_cancel", value: { transfer_id: 19 } },
          undefined,
        );
      expect(store.gameInteractionsBlocked).toBe(false);
    },
  );
});
