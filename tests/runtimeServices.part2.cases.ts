import {
  RuntimePointerObservation,
  RuntimeServiceError,
  RuntimeServiceRequests,
  RuntimeViewportState,
  afterEach,
  decodeServicePayload,
  deferred,
  describe,
  emptyPresentation,
  encodeProjectionServicePayload,
  encodeServicePayload,
  expect,
  handleRuntimeService,
  htmlPointerButtonValue,
  it,
  pointerButtonValue,
  projectionContext,
  projectionMap,
  registerPointerButton,
  serviceHarness,
  serviceRequest,
  uncheckedServiceEncoder,
  validateServiceRequest,
  vi,
  wasmServiceRequest,
} from "./runtimeServices.testHarness";
import type { RuntimeServiceRequest } from "./runtimeServices.testHarness";

describe("projection runtime services", () => {
  it("accepts WASM bigint pointer versions and bytes without changing identities", async () => {
    const harness = serviceHarness();
    await handleRuntimeService(wasmServiceRequest(serviceRequest()), 42n, harness.context);
    const [response, correlation] = harness.send.mock.calls[0] as unknown as [any, bigint];
    expect(response.value.request_id).toBe(1n);
    expect(response.value.result.type).toBe("ready");
    expect(correlation).toBe(42n);
  });

  it.each([-1n, 65536n, 1.5, NaN, "1"])("rejects invalid service version %s", (major) => {
    const request = {
      ...serviceRequest(),
      operation_version: { major, minor: 0n },
    } as RuntimeServiceRequest;
    expect(() => validateServiceRequest(request)).toThrow("service operation version is invalid");
  });

  it.each([-1n, 256n, 1.5, NaN, "163"])("rejects invalid protocol byte %s", (byte) => {
    const request = { ...serviceRequest(), payload: [byte] } as RuntimeServiceRequest;
    expect(() => validateServiceRequest(request)).toThrow("service payload contains a non-byte");
  });

  it("preserves full-width request and correlation identities", async () => {
    const identity = 0xffff_ffff_ffff_fff0n;
    const harness = serviceHarness(identity);
    await handleRuntimeService(
      serviceRequest("pointer_state", projectionMap(projectionContext), identity),
      identity - 1n,
      harness.context,
    );
    expect((harness.send.mock.calls[0] as unknown as [any, bigint])[0].value.request_id).toBe(
      identity,
    );
    expect((harness.send.mock.calls[0] as unknown as [any, bigint])[1]).toBe(identity - 1n);
  });

  it("returns pointer values with exact u64 revisions and the request correlation", async () => {
    const { context, send } = serviceHarness();
    await handleRuntimeService(serviceRequest(), 42, context);
    expect(send).toHaveBeenCalledOnce();
    const [response, correlation] = send.mock.calls[0] as unknown as [any, number];
    expect(correlation).toBe(42);
    expect(response.value.request_id).toBe(1);
    expect(decodeServicePayload(response.value.result.payload)).toEqual(
      new Map<number, unknown>([
        [0, 13],
        [1, -21],
        [2, "canonical"],
        [3, projectionContext.presentationRevision],
        [4, 7],
        [5, 9],
      ]),
    );
  });

  it("does not invalidate pointer sampling when only virtual layout identity advances", async () => {
    const { context, send } = serviceHarness();
    context.projection!.matches = () => false;

    await handleRuntimeService(serviceRequest(), 42, context);

    expect(context.projection!.prepareEnvironment).toHaveBeenCalledOnce();
    const [response] = send.mock.calls[0] as unknown as [any];
    expect(response.value.result.type).toBe("ready");
  });

  it("returns revision-bound geometry for the requested stable line identity", async () => {
    const { context, send } = serviceHarness();
    const lineId = 0xffff_ffff_ffff_fffdn;
    const request: RuntimeServiceRequest = {
      request_id: 1,
      kind: "presentation_query",
      operation: "get_line_geometry_v1",
      operation_version: { major: 1, minor: 0 },
      payload: encodeProjectionServicePayload(
        new Map<number, unknown>([
          [0, projectionMap(projectionContext)],
          [1, lineId],
        ]),
      ),
    };
    await handleRuntimeService(request, undefined, context);
    expect(context.projection!.lineGeometry).toHaveBeenCalledWith(
      { context: projectionContext, lineId },
      context.lease,
    );
    expect(decodeServicePayload((send.mock.calls[0] as any)[0].value.result.payload)).toEqual(
      new Map<number, unknown>([
        [0, projectionMap(projectionContext)],
        [1, lineId],
        [2, -4],
        [3, 18],
        [4, 600],
      ]),
    );
  });

  it.each([
    [
      "unknown operation",
      (request: RuntimeServiceRequest) => {
        request.operation = "unknown";
      },
      "frontend.unsupported_service",
    ],
    [
      "future version",
      (request: RuntimeServiceRequest) => {
        request.operation_version.major = 2;
      },
      "frontend.unsupported_service",
    ],
    [
      "missing version",
      (request: RuntimeServiceRequest) => {
        delete (request as Partial<RuntimeServiceRequest>).operation_version;
      },
      "frontend.invalid_request",
    ],
    [
      "string revision",
      (request: RuntimeServiceRequest) => {
        request.payload = encodeServicePayload(
          new Map<number, unknown>([
            [0, "4"],
            [1, 7],
            [2, 9],
          ]),
        );
      },
      "frontend.invalid_request",
    ],
    [
      "missing field",
      (request: RuntimeServiceRequest) => {
        request.payload = encodeServicePayload(
          new Map([
            [0, 4],
            [1, 7],
          ]),
        );
      },
      "frontend.invalid_request",
    ],
    [
      "non-byte payload",
      (request: RuntimeServiceRequest) => {
        request.payload = [256];
      },
      "frontend.invalid_request",
    ],
  ] as const)("rejects %s without invoking its provider", async (_name, mutate, code) => {
    const { context, send } = serviceHarness();
    const request = serviceRequest();
    mutate(request);
    await handleRuntimeService(request, undefined, context);
    expect((send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(code);
    expect(context.projection!.prepare).not.toHaveBeenCalled();
  });

  it.each(["stale_projection", "resource_limit", "backend_failure"] as const)(
    "preserves %s rather than reporting unsupported",
    async (category) => {
      const { context, send } = serviceHarness();
      context.projection!.prepareEnvironment = async () => {
        throw new RuntimeServiceError(category, "query failed");
      };
      await handleRuntimeService(serviceRequest(), undefined, context);
      expect((send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(
        `frontend.${category}`,
      );
    },
  );

  it.each(["cancel", "epoch", "reset"])(
    "suppresses success and error after %s during asynchronous work",
    async (reason) => {
      for (const fails of [false, true]) {
        const { requests, context, send } = serviceHarness();
        const gate = deferred<void>();
        context.projection!.prepare = async () => {
          await gate.promise;
          if (fails) throw new Error("decode failed");
          return emptyPresentation();
        };
        const pending = handleRuntimeService(serviceRequest(), undefined, context);
        if (reason === "cancel") requests.cancel(1);
        else if (reason === "epoch") requests.enterEpoch(2);
        else requests.reset();
        gate.resolve();
        await pending;
        expect(send).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects a duplicate ID once and retires the original work", async () => {
    const { requests, context, send } = serviceHarness();
    const gate = deferred<void>();
    context.projection!.prepare = async () => {
      await gate.promise;
      return emptyPresentation();
    };
    const original = handleRuntimeService(serviceRequest(), undefined, context);
    const duplicate = { ...context, lease: requests.begin(1, 1) };
    await handleRuntimeService(serviceRequest(), undefined, duplicate);
    gate.resolve();
    await original;
    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(
      "frontend.invalid_request",
    );
  });

  it("bounds active requests and makes reset a definite cancellation boundary", () => {
    const requests = new RuntimeServiceRequests();
    requests.enterEpoch(1);
    const leases = Array.from({ length: 32 }, (_, index) => requests.begin(index, 1));
    expect(() => requests.begin(32, 1)).toThrow("too many active");
    leases[0].finish();
    expect(requests.begin(32, 1).active()).toBe(true);
    requests.reset();
    expect(leases.every((lease) => !lease.active())).toBe(true);
    requests.enterEpoch(2);
    expect(requests.begin(0, 2).active()).toBe(true);
  });

  it.each([17, 0xffff_ffff_ffff_fffen])(
    "decodes canvas pixel maps without coercing identities or coordinates (%s)",
    async (canvasRevision) => {
      const { context, send } = serviceHarness();
      const payload = new Map<number, unknown>([
        [0, projectionMap(projectionContext)],
        [1, 4],
        [2, canvasRevision],
        [
          3,
          new Map([
            [0, 2],
            [1, 3],
          ]),
        ],
      ]);
      const request = { ...serviceRequest("sample_canvas_pixel", payload), kind: "canvas" };
      await handleRuntimeService(request, undefined, context);
      expect(context.projection!.canvas).toHaveBeenCalledWith(
        { context: projectionContext, canvasId: 4, canvasRevision, x: 2, y: 3 },
        expect.anything(),
        context.lease,
      );
      expect(
        decodeServicePayload((send.mock.calls[0] as unknown as [any])[0].value.result.payload),
      ).toEqual(
        new Map<number, unknown>([
          [0, projectionMap(projectionContext)],
          [1, canvasRevision],
          [2, 0x12345678],
        ]),
      );
      for (const coordinate of ["2", 1.5, 2147483648]) {
        const failed = serviceHarness();
        payload.set(
          3,
          new Map<number, unknown>([
            [0, coordinate],
            [1, 0],
          ]),
        );
        await handleRuntimeService(
          // Deliberately bypass the production encoder's exact-integer guard so
          // the service decoder receives and rejects malformed external CBOR.
          { ...request, payload: uncheckedServiceEncoder.encode(payload) },
          undefined,
          failed.context,
        );
        expect(failed.context.projection!.canvas).not.toHaveBeenCalled();
        expect((failed.send.mock.calls[0] as unknown as [any])[0].value.result.error.code).toBe(
          "frontend.invalid_request",
        );
      }
    },
  );
});

describe("realized viewport identity", () => {
  it("reuses the confirmed environment after output publishes without hiding real changes", async () => {
    let message = 0;
    const send = vi.fn(async () => ++message);
    const viewport = new RuntimeViewportState(send);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    await viewport.observe(measurement, true, 8, "", "font-one");
    await viewport.observe({ ...measurement }, true, 9n, "", "font-one");
    expect(send).toHaveBeenCalledOnce();
    const expected = {
      presentationRevision: 9n,
      environmentRevision: 1,
      projectionSpaceRevision: 1,
    };
    expect(viewport.matches(expected, 9n, measurement, "font-one")).toBe(true);
    await viewport.observe(measurement, true, 9n, "", "font-two");
    expect(send).toHaveBeenCalledTimes(2);
    expect(viewport.matches(expected, 9n, measurement, "font-two")).toBe(false);
    await viewport.observe(measurement, true, 9n, "typed", "font-two");
    expect(send).toHaveBeenCalledTimes(3);
    viewport.reject("3");
    await viewport.observe(measurement, true, 9n, "typed", "font-two");
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("records only acknowledged observations and invalidates rejected or reset identities", async () => {
    const gate = deferred<number>();
    const viewport = new RuntimeViewportState(() => gate.promise);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    const expected = {
      presentationRevision: 9,
      environmentRevision: 1,
      projectionSpaceRevision: 1,
    };
    const pending = viewport.observe(measurement, true, 8, "");
    expect(viewport.matches(expected, 9, measurement)).toBe(false);
    gate.resolve(4);
    await pending;
    // New output can use the existing measured environment after Vue publishes that revision.
    expect(viewport.matches(expected, 9, measurement)).toBe(true);
    expect(viewport.matches(expected, 8, measurement)).toBe(false);
    expect(viewport.matches(expected, 9, { ...measurement, height: 201 })).toBe(false);
    for (const field of ["environmentRevision", "projectionSpaceRevision"] as const)
      expect(viewport.matches({ ...expected, [field]: 2 }, 9, measurement)).toBe(false);
    viewport.reject("4");
    expect(viewport.matches(expected, 9, measurement)).toBe(false);
    viewport.reset();
    expect(viewport.matches(expected, 9, measurement)).toBe(false);
  });

  it("keeps an HTML environment usable when layout, columns and text-box projection advance", async () => {
    let message = 0;
    const viewport = new RuntimeViewportState(async () => ++message);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    await viewport.observe(measurement, true, 8, "1", "layout-one", "font-one");
    const expected = {
      presentationRevision: 9,
      environmentRevision: 1,
      projectionSpaceRevision: 1,
    };
    const changedColumns = { ...measurement, lineColumns: 31 };
    await viewport.observe(changedColumns, true, 9, "", "layout-two", "font-one");
    expect(viewport.matches(expected, 9, measurement, "layout-two")).toBe(false);
    expect(viewport.matchesEnvironment(expected, 9, "font-one")).toBe(true);
    expect(viewport.matchesEnvironment(expected, 9, "font-two")).toBe(false);
    expect(
      JSON.parse(viewport.describeEnvironmentMismatch(expected, 9, measurement, "font-two")),
    ).toMatchObject({
      expected: {
        presentationRevision: "9",
        environmentRevision: "1",
        projectionSpaceRevision: "1",
      },
      publishedPresentationRevision: "9",
      measurement: { width: 300, height: 200 },
      observation: {
        width: 300,
        height: 200,
        environmentStyleIdentity: "font-one",
      },
      environmentStyleIdentity: "font-two",
    });
    expect(viewport.matchesEnvironment(expected, 9, "font-one")).toBe(true);
    expect(viewport.environment(expected, 9, "font-one")).toEqual({ width: 300, height: 200 });
  });
});

describe("late viewport acknowledgements", () => {
  it("invalidates candidates on submission failure without clearing a newer session", async () => {
    let messageId = 0;
    const send = vi.fn(async () => ++messageId);
    const viewport = new RuntimeViewportState(send);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    const expected = {
      presentationRevision: 1,
      environmentRevision: 1,
      projectionSpaceRevision: 1,
    };
    await viewport.observe(measurement, true, 1, "");
    const olderSubmission = deferred<number>();
    send.mockReturnValueOnce(olderSubmission.promise);
    const older = viewport.observe({ ...measurement, width: 301 }, true, 1, "");
    const failure = new Error("submission failed after transport delivery");
    send.mockRejectedValueOnce(failure);
    await expect(viewport.observe({ ...measurement, width: 302 }, true, 1, "")).rejects.toBe(
      failure,
    );
    olderSubmission.resolve(42);
    await older;
    viewport.reject("unrelated");
    expect(viewport.matches(expected, 1, measurement)).toBe(false);
    expect(
      viewport.matches({ ...expected, environmentRevision: 2, projectionSpaceRevision: 2 }, 1, {
        ...measurement,
        width: 301,
      }),
    ).toBe(false);
    await viewport.observe(measurement, true, 1, "");
    expect(
      viewport.matches(
        { ...expected, environmentRevision: 4, projectionSpaceRevision: 4 },
        1,
        measurement,
      ),
    ).toBe(true);
    let rejectSend!: (error: Error) => void;
    send.mockReturnValueOnce(
      new Promise<number>((_resolve, reject) => {
        rejectSend = reject;
      }),
    );
    const pending = viewport.observe({ ...measurement, width: 301 }, true, 1, "");
    viewport.reset();
    await viewport.observe(measurement, true, 1, "");
    rejectSend(failure);
    await expect(pending).rejects.toBe(failure);
    expect(viewport.matches(expected, 1, measurement)).toBe(true);
  });

  it.each(["before", "after"])(
    "restores environment 5 only when candidate 6 is rejected %s submission returns",
    async (rejectionOrder) => {
      let messageId = 32;
      const send = vi.fn(async () => ++messageId);
      const viewport = new RuntimeViewportState(send);
      const measurement = {
        width: 325,
        height: 430,
        lineColumns: 40,
        chromeWidth: 0,
        chromeHeight: 0,
      };
      for (let revision = 1; revision <= 5; revision += 1)
        await viewport.observe(
          { ...measurement, height: measurement.height + 5 - revision },
          true,
          45,
          "",
          "font-one",
        );
      const expected = {
        presentationRevision: 50,
        environmentRevision: 5,
        projectionSpaceRevision: 5,
      };
      expect(viewport.matches(expected, 50, measurement, "font-one")).toBe(true);
      const gate = deferred<number>();
      send.mockReturnValueOnce(gate.promise);
      const pending = viewport.observe({ ...measurement, width: 327 }, true, 45, "2", "font-one");
      // Input advances canonical presentation while this geometry observation is in flight.
      expect(viewport.matches(expected, 50, measurement, "font-one")).toBe(false);
      if (rejectionOrder === "before") {
        viewport.reject("39");
        expect(viewport.matches(expected, 50, measurement, "font-one")).toBe(false);
      }
      gate.resolve(39);
      await pending;
      if (rejectionOrder === "after") {
        // Merely submitting the newer candidate cannot authorize an older query context.
        expect(viewport.matches(expected, 50, measurement, "font-one")).toBe(false);
        viewport.reject("39");
      }
      expect(viewport.matches(expected, 50, measurement, "font-one")).toBe(true);
      expect(viewport.matches(expected, 50, { ...measurement, width: 327 }, "font-one")).toBe(
        false,
      );
      expect(viewport.matches(expected, 50, measurement, "font-two")).toBe(false);
      expect(
        viewport.matches({ ...expected, environmentRevision: 6 }, 50, measurement, "font-one"),
      ).toBe(false);
      await viewport.observe(measurement, true, 50, "", "font-one");
      expect(send).toHaveBeenCalledTimes(6);
    },
  );

  it("cannot confirm an observation rejected before its submission acknowledgement", async () => {
    const gate = deferred<number>();
    const viewport = new RuntimeViewportState(() => gate.promise);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    const pending = viewport.observe(measurement, true, 1, "", "font-one");
    viewport.reject("4");
    gate.resolve(4);
    await pending;
    expect(
      viewport.matches(
        { presentationRevision: 1, environmentRevision: 1, projectionSpaceRevision: 1 },
        1,
        measurement,
        "font-one",
      ),
    ).toBe(false);
  });

  it("rejects changed font identity even when viewport dimensions and rounded column counts are unchanged", async () => {
    const viewport = new RuntimeViewportState(async () => 1);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    await viewport.observe(measurement, true, 1, "", "font-one");
    const expected = {
      presentationRevision: 2,
      environmentRevision: 1,
      projectionSpaceRevision: 1,
    };
    expect(viewport.matches(expected, 2, measurement, "font-one")).toBe(true);
    expect(viewport.matches(expected, 2, measurement, "font-two")).toBe(false);
  });

  it("invalidates the confirmed environment while newer geometry or font observations are pending", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const third = deferred<number>();
    const send = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const viewport = new RuntimeViewportState(send);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    const one = viewport.observe(measurement, true, 1, "");
    first.resolve(1);
    await one;
    const old = { presentationRevision: 2, environmentRevision: 1, projectionSpaceRevision: 1 };
    expect(viewport.matches(old, 2, measurement)).toBe(true);
    const two = viewport.observe({ ...measurement, lineColumns: 20 }, true, 2, "");
    expect(viewport.matches(old, 2, measurement)).toBe(false);
    const three = viewport.observe({ ...measurement, lineColumns: 25 }, true, 2, "");
    second.resolve(2);
    await two;
    expect(
      viewport.matches(
        { ...old, environmentRevision: 2, projectionSpaceRevision: 2 },
        2,
        measurement,
      ),
    ).toBe(false);
    third.resolve(3);
    await three;
    expect(
      viewport.matches(
        { ...old, environmentRevision: 3, projectionSpaceRevision: 3 },
        2,
        measurement,
      ),
    ).toBe(true);
  });

  it("does not republish observation identity after the session has been reset", async () => {
    const gate = deferred<number>();
    const viewport = new RuntimeViewportState(() => gate.promise);
    const measurement = {
      width: 300,
      height: 200,
      lineColumns: 30,
      chromeWidth: 0,
      chromeHeight: 0,
    };
    const pending = viewport.observe(measurement, true, 1, "");
    viewport.reset();
    gate.resolve(4);
    await pending;
    expect(
      viewport.matches(
        { presentationRevision: 1, environmentRevision: 1, projectionSpaceRevision: 1 },
        1,
        measurement,
      ),
    ).toBe(false);
    expect(viewport.pendingMessages.size).toBe(0);
  });
});

describe("pointer canonical button observation", () => {
  const originalHitTest = document.elementFromPoint;
  let pointer: RuntimePointerObservation | undefined;
  afterEach(() => {
    pointer?.stop();
    pointer = undefined;
    document.body.replaceChildren();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: originalHitTest,
    });
    vi.restoreAllMocks();
  });

  it("uses viewport coordinates and model values across scrolling, disabled input, resize and focus loss", () => {
    const viewport = document.createElement("main");
    const button = document.createElement("button");
    const child = document.createElement("span");
    child.textContent = "visible text is not the script value";
    button.disabled = true;
    button.append(child);
    viewport.append(button);
    document.body.append(viewport);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 200 },
    });
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ left: 10, top: 20 } as DOMRect);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let hit: Element = child;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => hit),
    });
    const unregister = registerPointerButton(button, () => ({ epoch: 1, value: "42" }));
    pointer = new RuntimePointerObservation(() => viewport);
    pointer.start();
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 50, buttons: 2 }));
    expect(pointer.sample(1)).toEqual({ x: 20, y: -170, buttonValue: "42" });
    expect(pointer.sample(2).buttonValue).toBe("");
    hit = viewport;
    viewport.dispatchEvent(new Event("scroll"));
    // Firefox may report the old hover location in a layout-driven pointerout.
    window.dispatchEvent(
      new MouseEvent("pointerout", { clientX: 199, clientY: 150, relatedTarget: viewport }),
    );
    expect(pointer.sample(1)).toEqual({ x: 20, y: -170, buttonValue: "" });
    hit = child;
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 250 });
    window.dispatchEvent(new Event("resize"));
    expect(pointer.sample(1).y).toBe(-220);
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(
      new MouseEvent("pointerout", { clientX: 30, clientY: 50, relatedTarget: child }),
    );
    expect(pointer.sample(1)).toEqual({ x: 0, y: 0, buttonValue: "" });
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 30, clientY: 50 }));
    window.dispatchEvent(new MouseEvent("pointerout", { relatedTarget: null }));
    expect(pointer.sample(1).buttonValue).toBe("");
    for (const type of ["pointermove", "pointerdown", "pointerup"]) {
      focus.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new MouseEvent(type, { clientX: 199, clientY: 150 }));
      focus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
      // An event delivered in the background cannot reappear when keyboard focus returns.
      expect(pointer.sample(1)).toEqual({ x: 0, y: 0, buttonValue: "" });
      window.dispatchEvent(new MouseEvent(type, { clientX: 30, clientY: 50 }));
      expect(pointer.sample(1)).toEqual({ x: 20, y: -220, buttonValue: "42" });
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new MouseEvent(type, { clientX: 199, clientY: 150 }));
      expect(pointer.sample(1)).toEqual({ x: 0, y: 0, buttonValue: "" });
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(pointer.sample(1)).toEqual({ x: 0, y: 0, buttonValue: "" });
      window.dispatchEvent(new MouseEvent(type, { clientX: 30, clientY: 50 }));
      expect(pointer.sample(1)).toEqual({ x: 20, y: -220, buttonValue: "42" });
    }
    unregister();
  });

  it("preserves integer and string values from the canonical run/HTML model", () => {
    expect(pointerButtonValue({ type: "integer", value: -9223372036854775808n })).toBe(
      "-9223372036854775808",
    );
    expect(pointerButtonValue({ type: "string", value: "001" })).toBe("001");
    expect(htmlPointerButtonValue({ integer_value: 42 })).toBe("42");
    expect(htmlPointerButtonValue({ string_value: "button text", integer_value: null })).toBe(
      "button text",
    );
    expect(pointerButtonValue({ type: "integer", value: "42" })).toBeUndefined();
  });
});
