import { ref } from "vue";

import {
  debugVariableKey,
  formatDebugValue,
  refreshDebugStop,
  selectedDebugFiber,
} from "@/core/debug";

export const MAXIMUM_DEBUG_CONSOLE_ENTRIES = 2_000;
export const MAXIMUM_DEBUG_CONSOLE_BYTES = 2 * 1024 * 1024;

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
  private outputBytes = 0;

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
      const output = [...(response.value.output ?? [])].map(String);
      if (response.value.value != null) output.push(`=> ${formatDebugValue(response.value.value)}`);
      for (const diagnostic of response.value.diagnostics ?? []) {
        output.push(`[${diagnostic.code}] ${diagnostic.message}`);
      }
      this.appendOutput(output);
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
    this.outputBytes = 0;
    this.variables.value = [];
    this.fibers.value = [];
    this.frames.value = [];
    this.variableValues.value = {};
  }

  private appendOutput(lines: string[]): void {
    for (const line of lines) {
      const bounded = trimDebugLine(line);
      this.output.value.push(bounded);
      this.outputBytes += debugTextBytes(bounded);
    }
    let remove = 0;
    while (
      remove < this.output.value.length &&
      (this.output.value.length - remove > MAXIMUM_DEBUG_CONSOLE_ENTRIES ||
        this.outputBytes > MAXIMUM_DEBUG_CONSOLE_BYTES)
    ) {
      this.outputBytes -= debugTextBytes(this.output.value[remove]);
      remove += 1;
    }
    if (remove > 0) this.output.value.splice(0, remove);
  }
}

function debugTextBytes(value: string): number {
  return value.length * Uint16Array.BYTES_PER_ELEMENT;
}

function trimDebugLine(value: string): string {
  const maximumCodeUnits = MAXIMUM_DEBUG_CONSOLE_BYTES / Uint16Array.BYTES_PER_ELEMENT;
  return value.length <= maximumCodeUnits ? value : value.slice(-maximumCodeUnits);
}
