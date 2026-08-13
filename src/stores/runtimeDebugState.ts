import { ref } from "vue";

import {
  debugVariableKey,
  formatDebugValue,
  refreshDebugStop,
  selectedDebugFiber,
} from "@/core/debug";

export class RuntimeDebugState {
  readonly consoleOpen = ref(false);
  readonly variablesOpen = ref(false);
  readonly stackOpen = ref(false);
  readonly enabled = ref(false);
  readonly singleStepEnabled = ref(false);
  readonly grant = ref<any>(null);
  readonly stop = ref<any>(null);
  readonly output = ref<string[]>([]);
  readonly variables = ref<any[]>([]);
  readonly variablesLoading = ref(false);
  readonly fibers = ref<any[]>([]);
  readonly frames = ref<any[]>([]);
  readonly variableValues = ref<Record<string, string>>({});

  acceptGrant(value: any): void {
    this.grant.value = value;
    this.enabled.value = true;
    this.singleStepEnabled.value = false;
    this.stop.value = null;
  }

  revokeGrant(): void {
    this.grant.value = null;
    this.enabled.value = false;
    this.singleStepEnabled.value = false;
    this.stop.value = null;
  }

  acceptStop(value: any): void {
    this.stop.value = value;
    this.fibers.value = [];
    this.frames.value = [];
  }

  clearGrant(): void {
    this.grant.value = null;
    this.stop.value = null;
  }

  clearVariables(): void {
    this.variables.value = [];
    this.variableValues.value = {};
  }

  clearStack(): void {
    this.fibers.value = [];
    this.frames.value = [];
  }

  applyResponse(response: any): any | undefined {
    this.stop.value = refreshDebugStop(this.stop.value, response.value);
    if (response.type === "variable_page") {
      this.variables.value = response.value.variables ?? [];
    } else if (response.type === "variable_value") {
      this.variableValues.value[debugVariableKey(response.value)] = formatDebugValue(
        response.value.value,
      );
    } else if (response.type === "fiber_page") {
      this.fibers.value = response.value.fibers ?? [];
      const selected = selectedDebugFiber(this.stop.value);
      return (
        this.fibers.value.find((candidate) => candidate.fiber_id === selected) ??
        this.fibers.value.find((candidate) => candidate.frame_count > 0)
      );
    } else if (response.type === "call_stack") {
      this.frames.value = response.value.frames ?? [];
    } else if (response.type === "console") {
      this.output.value.push(...(response.value.output ?? []));
      if (response.value.value != null)
        this.output.value.push(`=> ${formatDebugValue(response.value.value)}`);
      for (const diagnostic of response.value.diagnostics ?? []) {
        this.output.value.push(`[${diagnostic.code}] ${diagnostic.message}`);
      }
      for (const changed of response.value.changed_variables ?? []) {
        this.variableValues.value[debugVariableKey(changed)] = formatDebugValue(changed.value);
      }
    }
    return undefined;
  }

  resetSession(): void {
    this.enabled.value = false;
    this.singleStepEnabled.value = false;
    this.grant.value = null;
    this.stop.value = null;
    this.output.value = [];
    this.variables.value = [];
    this.fibers.value = [];
    this.frames.value = [];
    this.variableValues.value = {};
  }
}
