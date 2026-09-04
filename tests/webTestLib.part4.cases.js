import { describe, expect, goalStatus, it, loadScenario } from "./webTestLib.testHarness";

describe("snake pointer lifecycle scenario", () => {
  it("uses real hover, resize, scroll and keyboard actions and retains five independent button observations", async () => {
    const scenario = await loadScenario(
      "tools/runtime-tester/scenarios/snake-service-lifecycle.json",
    );
    expect(scenario.actions.filter((action) => action.type === "press")).toHaveLength(5);
    expect(scenario.actions.some((action) => action.type === "set_viewport")).toBe(true);
    expect(
      scenario.actions.some((action) => action.type === "scroll_key" && action.key === "PageUp"),
    ).toBe(true);
    expect(scenario.goal.watch_equals).toEqual({
      "LIFE_BUTTON:0": "41",
      "LIFE_BUTTON:1": "",
      "LIFE_BUTTON:2": "",
      "LIFE_BUTTON:3": "41",
      "LIFE_BUTTON:4": "",
    });
    const complete = {
      output: [...scenario.goal.output_contains],
      wait: { kind: "integer_value" },
      watches: { ...scenario.goal.watch_equals },
    };
    expect(goalStatus(complete, scenario.goal).satisfied).toBe(true);
    expect(
      goalStatus(
        { ...complete, watches: { ...complete.watches, "LIFE_BUTTON:4": "41" } },
        scenario.goal,
      ).satisfied,
    ).toBe(false);
  });
});
