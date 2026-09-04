import {
  Buffer,
  assertCancelledLifecycle,
  describe,
  expect,
  it,
  lifecycleRestartReady,
  lifecycleSession,
  mkdir,
  mkdtemp,
  nativeWebdriverOption,
  observePendingCanvas,
  path,
  readFile,
  rm,
  sha256,
  symlink,
  tmpdir,
  validateNativeWebdriverSource,
  writeFile,
} from "./tauriTestSupport.testHarness";

describe("real lifecycle race evidence assertions", () => {
  const sourceUrl = "http://127.0.0.1:19001/snake-lifecycle/" + "a".repeat(64) + ".png";
  const request = {
    index: 8,
    sessionGeneration: 4,
    direction: "receive",
    epoch: "20",
    message: {
      type: "service_request",
      value: { request_id: "9", kind: "canvas", operation: "sample_canvas_pixel" },
    },
  };
  const authorized = {
    index: 0,
    phase: "resource_authorized",
    sourceUrl,
    resourceGeneration: 4,
    sha256: "b".repeat(64),
    byteLength: 71,
  };
  const start = { index: 1, phase: "start", sourceUrl, resourceGeneration: 4 };
  const cancel = { index: 2, phase: "cancelled", sourceUrl, resourceGeneration: 4 };
  const settled = {
    index: 4,
    phase: "settled",
    sourceUrl,
    resourceGeneration: 4,
    outcome: "resolved",
  };
  const fresh = {
    index: 9,
    sessionGeneration: 5,
    direction: "receive",
    epoch: "21",
    message: {
      type: "service_request",
      value: { request_id: "9", kind: "canvas", operation: "sample_canvas_pixel" },
    },
  };
  const reply = {
    index: 10,
    sessionGeneration: 5,
    direction: "send",
    epoch: "21",
    message: { type: "service_response", value: { request_id: "9", result: { type: "ready" } } },
  };
  const freshDecode = {
    index: 3,
    phase: "settled",
    resourceId: "resources/lifecycle-next.png",
    resourceGeneration: 5,
    outcome: "resolved",
  };
  const state = (wire = [request], decode = [authorized, start], epoch = "20") => ({
    runtimeEpoch: epoch,
    fault: null,
    serviceEvidence: {
      enabled: true,
      overflow: false,
      failure: null,
      records: wire,
      sessionGeneration: epoch === "21" ? 5 : 4,
    },
    serviceLifecycle: { enabled: true, failure: null, records: decode },
  });

  it("waits past retained old prompts and new-session loading until a fresh integer wait", () => {
    const previous = { sessionGeneration: 4, epoch: "20" };
    const oldReady = {
      ...state(),
      projectLoading: false,
      canInteract: true,
      wait: { kind: "integer_value" },
      output: ["SNAKE_LIFECYCLE_START"],
    };
    expect(lifecycleRestartReady(oldReady, previous)).toBe(false);
    const newReady = {
      ...oldReady,
      // Restart may reuse the numeric epoch, so session generation must remain part of identity.
      serviceEvidence: { ...oldReady.serviceEvidence, sessionGeneration: 5 },
    };
    expect(lifecycleRestartReady({ ...newReady, projectLoading: true }, previous)).toBe(false);
    expect(lifecycleRestartReady({ ...newReady, canInteract: false }, previous)).toBe(false);
    expect(lifecycleRestartReady({ ...newReady, wait: { kind: "void" } }, previous)).toBe(false);
    expect(lifecycleRestartReady({ ...newReady, output: [] }, previous)).toBe(false);
    expect(lifecycleRestartReady(newReady, previous)).toBe(true);
    // The first restart precedes arming the image gate, so decoder observations are not enabled.
    const beforeGate = {
      ...newReady,
      serviceLifecycle: { enabled: false, failure: null, records: [] },
    };
    expect(lifecycleSession(beforeGate)).toEqual({ sessionGeneration: 5, epoch: "20" });
    expect(lifecycleRestartReady(beforeGate, previous)).toBe(true);
    expect(() => observePendingCanvas(beforeGate, sourceUrl, 7)).toThrow(
      "complete real lifecycle/transport evidence",
    );
    for (const invalid of [
      { ...beforeGate, runtimeEpoch: undefined },
      { ...beforeGate, serviceEvidence: { ...beforeGate.serviceEvidence, enabled: false } },
      { ...beforeGate, serviceEvidence: { ...beforeGate.serviceEvidence, overflow: true } },
    ])
      expect(() => lifecycleSession(invalid)).toThrow("transport session evidence");
  });

  it("requires actual pending service, source authorization and unfinished physical decode", () => {
    expect(observePendingCanvas(state(), sourceUrl, 7)).toMatchObject({
      epoch: "20",
      authorization: authorized,
    });
    expect(observePendingCanvas(state([request], []), sourceUrl, 7)).toBeNull();
    expect(() => observePendingCanvas(state([], [authorized, start]), sourceUrl, 7)).toThrow(
      "exactly one",
    );
    expect(() => observePendingCanvas(state([request], [start]), sourceUrl, 7)).toThrow(
      "authorized source hash",
    );
    expect(() =>
      observePendingCanvas(state([request], [authorized, start, settled]), sourceUrl, 7),
    ).toThrow("not physically");
    expect(() =>
      observePendingCanvas(
        state([request, { ...reply, epoch: "20", sessionGeneration: 4 }]),
        sourceUrl,
        7,
      ),
    ).toThrow("already replied");
    expect(() =>
      observePendingCanvas(
        { ...state(), serviceEvidence: { enabled: true, overflow: true } },
        sourceUrl,
        7,
      ),
    ).toThrow("complete real");
  });

  it("does not match old replies when a restarted transport reuses its epoch and request ID", () => {
    const history = { ...reply, index: 3, epoch: "20", sessionGeneration: 3 };
    const earlier = { ...reply, index: 5, epoch: "20", sessionGeneration: 4 };
    const pending = observePendingCanvas(state([history, earlier, request]), sourceUrl, 7);
    expect(pending.request.index).toBe(8);
    const held = state(
      [history, earlier, request, { ...fresh, epoch: "20" }, { ...reply, epoch: "20" }],
      [authorized, start, cancel, freshDecode],
      "21",
    );
    held.runtimeEpoch = "20";
    const completed = {
      ...held,
      serviceLifecycle: {
        ...held.serviceLifecycle,
        records: [authorized, start, cancel, freshDecode, settled],
      },
    };
    expect(
      assertCancelledLifecycle(pending, held, completed, true).beforeReleaseSessionGeneration,
    ).toBe(5);
    const stale = {
      ...completed,
      serviceEvidence: {
        ...completed.serviceEvidence,
        records: [
          ...completed.serviceEvidence.records,
          { ...reply, index: 11, epoch: "20", sessionGeneration: 4 },
        ],
      },
    };
    expect(() => assertCancelledLifecycle(pending, held, stale, true)).toThrow("stale reply");
  });

  it("separates actual cancellation, new request progress, late settle and resource generation", () => {
    const pending = observePendingCanvas(state(), sourceUrl, 7);
    const held = state([request, fresh, reply], [authorized, start, cancel, freshDecode], "21");
    const completed = state(
      [request, fresh, reply],
      [authorized, start, cancel, freshDecode, settled],
      "21",
    );
    expect(assertCancelledLifecycle(pending, held, completed, true).settled).toEqual(settled);
    expect(() =>
      assertCancelledLifecycle(
        pending,
        state([request, fresh, reply], [authorized, start, freshDecode], "21"),
        completed,
        true,
      ),
    ).toThrow("actually cancelled");
    expect(() => assertCancelledLifecycle(pending, completed, completed, true)).toThrow(
      "physical decode",
    );
    expect(() =>
      assertCancelledLifecycle(
        pending,
        {
          ...held,
          runtimeEpoch: "20",
          serviceEvidence: { ...held.serviceEvidence, sessionGeneration: 4 },
        },
        completed,
        true,
      ),
    ).toThrow("new runtime session");
    expect(() =>
      assertCancelledLifecycle(
        pending,
        state([request, fresh], [authorized, start, cancel], "21"),
        completed,
        false,
      ),
    ).toThrow("did not complete");
    expect(() =>
      assertCancelledLifecycle(
        pending,
        state([request, fresh, reply], [authorized, start, cancel], "21"),
        completed,
        true,
      ),
    ).toThrow("newer real resource generation");
    expect(() =>
      assertCancelledLifecycle(
        pending,
        held,
        state(
          [request, fresh, reply, { ...reply, index: 11, epoch: "20", sessionGeneration: 4 }],
          completed.serviceLifecycle.records,
          "21",
        ),
        true,
      ),
    ).toThrow("stale reply");
  });
});

describe("explicit native WebDriver source binding", () => {
  const upstreamChecksum = "30c5bffe978c41b06ad44a5f4b5b543405918cf316b98756c678a6431061f2e9";
  const row = (file, text) => ({
    path: file,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
  });

  async function fixture(run, cargoVersion = "1.2.0") {
    const root = await mkdtemp(path.join(tmpdir(), "rustyera-native-provider-"));
    const provider = path.join(root, "provider space");
    const manifests = path.join(root, "trusted");
    const cargo = `[package]\nname = "tauri-plugin-wdio-webdriver"\nversion = "${cargoVersion}"\n`;
    const originalSource = "original provider\n";
    const nativeSource = "native overlay\n";
    try {
      await mkdir(path.join(provider, "src"), { recursive: true });
      await mkdir(manifests);
      await writeFile(path.join(provider, "Cargo.toml"), cargo);
      await writeFile(path.join(provider, "src/lib.rs"), nativeSource);
      await writeFile(
        path.join(manifests, "original-inventory.json"),
        JSON.stringify({
          package: "tauri-plugin-wdio-webdriver",
          version: "1.2.0",
          registryChecksum: upstreamChecksum,
          files: [row("Cargo.toml", cargo), row("src/lib.rs", originalSource)],
        }),
      );
      await writeFile(
        path.join(manifests, "overlay-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          upstreamPackage: "tauri-plugin-wdio-webdriver",
          upstreamVersion: "1.2.0",
          files: [row("src/lib.rs", nativeSource)],
        }),
      );
      await run({
        provider,
        manifests,
        nativeSource,
        validate: () =>
          validateNativeWebdriverSource(provider, {
            manifestDirectory: manifests,
            platform: "darwin",
          }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("does not add an override to ordinary test commands on any platform", () => {
    expect(nativeWebdriverOption(["--spec", "example.spec.mjs"], "linux")).toBeUndefined();
    expect(nativeWebdriverOption(["--native-webdriver-source", "/source space"], "darwin")).toBe(
      "/source space",
    );
  });

  it.each([
    [["--native-webdriver-source"], "darwin", /requires a path/],
    [["--native-webdriver-source", "--project", "/game"], "darwin", /requires a path/],
    [
      ["--native-webdriver-source", "/one", "--native-webdriver-source", "/two"],
      "darwin",
      /only once/,
    ],
    [["--native-webdriver-source", "/one"], "linux", /only on macOS/],
  ])("rejects malformed or unsupported opt-in arguments %#", (args, platform, message) => {
    expect(() => nativeWebdriverOption(args, platform)).toThrow(message);
  });

  it("binds the overlaid source and preserves one escaped Cargo argument", async () => {
    await fixture(async ({ validate }) => {
      const result = await validate();
      expect(result.cargoArguments).toEqual([
        "--",
        "--config",
        `patch.crates-io.tauri-plugin-wdio-webdriver.path=${JSON.stringify(result.provenance.source)}`,
      ]);
      expect(result.provenance).toMatchObject({
        package: "tauri-plugin-wdio-webdriver",
        version: "1.2.0",
        upstreamChecksum,
        fileCount: 2,
      });
      expect(result.provenance.materializedInventorySha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it.each(["modified", "missing", "extra"])("rejects a %s materialized input", async (kind) => {
    await fixture(async ({ provider, validate }) => {
      if (kind === "modified") await writeFile(path.join(provider, "src/lib.rs"), "tampered\n");
      if (kind === "missing") await rm(path.join(provider, "src/lib.rs"));
      if (kind === "extra") await writeFile(path.join(provider, "unexpected.rs"), "extra\n");
      await expect(validate()).rejects.toThrow(/identity mismatch|missing or unexpected/);
    });
  });

  it("rejects symlinked input even if its target has the expected bytes", async () => {
    await fixture(async ({ provider, manifests, nativeSource, validate }) => {
      const target = path.join(manifests, "native.rs");
      await writeFile(target, nativeSource);
      await rm(path.join(provider, "src/lib.rs"));
      await symlink(target, path.join(provider, "src/lib.rs"));
      await expect(validate()).rejects.toThrow(/symlinks/);
    });
  });

  it("rejects empty-directory nesting independently of the file count", async () => {
    await fixture(async ({ provider, validate }) => {
      await mkdir(path.join(provider, ...Array.from({ length: 17 }, () => "nested")), {
        recursive: true,
      });
      await expect(validate()).rejects.toThrow(/nesting is too deep/);
    });
  });

  it("rejects a source file that grew beyond the byte cap before hashing", async () => {
    await fixture(async ({ provider, validate }) => {
      await writeFile(path.join(provider, "src/lib.rs"), Buffer.alloc(2 * 1024 * 1024 + 1));
      await expect(validate()).rejects.toThrow(/bounded regular file/);
    });
  });

  it("rejects an unsafe or duplicate trusted overlay row", async () => {
    for (const kind of ["unsafe", "duplicate"]) {
      await fixture(async ({ manifests, validate }) => {
        const filename = path.join(manifests, "overlay-manifest.json");
        const manifest = JSON.parse(await readFile(filename, "utf8"));
        if (kind === "unsafe") manifest.files[0].path = "../outside";
        else manifest.files.push(manifest.files[0]);
        await writeFile(filename, JSON.stringify(manifest));
        await expect(validate()).rejects.toThrow(/unsafe file path|duplicate file path/);
      });
    }
  });

  it("checks Cargo package identity even when the supplied file digest matches", async () => {
    await fixture(async ({ validate }) => {
      await expect(validate()).rejects.toThrow(/Cargo package must be/);
    }, "9.9.9");
  });
});
