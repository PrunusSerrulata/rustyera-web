<script setup lang="ts">
import { ref } from "vue";

import DraggableDialog from "@/components/DraggableDialog.vue";
import { debugStopToken, debugVariableKey } from "@/core/debug";
import { useRuntimeStore } from "@/stores/runtime";

const store = useRuntimeStore();
const source = ref("");

async function consoleCommand(execute: boolean): Promise<void> {
  const stop = debugStopToken(store.debugStop);
  if (!source.value || !stop) return;
  await store.debugCommand({
    type: "console",
    stop,
    command: { type: execute ? "execute_safe" : "evaluate", source: source.value },
  });
  source.value = "";
}

function readVariable(variable: any): void {
  const stop = debugStopToken(store.debugStop);
  if (!stop) return;
  void store.debugCommand({
    type: "read_variable",
    stop,
    value: {
      symbol_key: variable.symbol_key,
      storage: variable.storage,
      fiber_id: null,
      frame_id: null,
      generation: stop.program_generation,
      character: null,
      indices: [],
    },
  });
}

function readStack(fiber: any): void {
  const stop = debugStopToken(store.debugStop);
  if (stop)
    void store.debugCommand({
      type: "read_call_stack",
      stop,
      fiber_id: fiber.fiber_id,
    });
}
</script>

<template>
  <DraggableDialog
    :open="store.debugConsoleOpen"
    title="EraBasic 调试控制台"
    wide
    @close="store.debugConsoleOpen = false"
  >
    <pre class="debug-output">{{ store.debugOutput.join("\n") }}</pre>
    <input
      v-model="source"
      class="debug-input"
      placeholder="输入表达式或安全语句"
      @keyup.enter="consoleCommand(false)"
    />
    <footer class="dialog-actions">
      <span class="spacer" /><button
        type="button"
        class="primary"
        :disabled="!source || !debugStopToken(store.debugStop)"
        @click="consoleCommand(false)"
      >
        求值</button
      ><button
        type="button"
        :disabled="!source || !debugStopToken(store.debugStop)"
        @click="consoleCommand(true)"
      >
        安全执行
      </button>
    </footer>
  </DraggableDialog>

  <DraggableDialog
    :open="store.variablesOpen"
    title="变量查看器"
    wide
    @close="store.variablesOpen = false"
  >
    <table class="debug-table">
      <thead>
        <tr>
          <th>名称</th>
          <th>存储</th>
          <th>类型</th>
          <th>维度</th>
          <th>值（双击读取）</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="variable in store.debugVariables"
          :key="variable.name"
          tabindex="0"
          @dblclick="readVariable(variable)"
        >
          <td>{{ variable.name }}</td>
          <td>{{ variable.storage }}</td>
          <td>{{ variable.value_kind }}</td>
          <td>{{ variable.dimensions.join(" × ") }}</td>
          <td>{{ store.debugVariableValues[debugVariableKey(variable)] ?? "" }}</td>
        </tr>
      </tbody>
    </table>
  </DraggableDialog>

  <DraggableDialog
    :open="store.stackOpen"
    title="Fibers / 调用栈"
    wide
    @close="store.stackOpen = false"
  >
    <div class="debug-columns">
      <table class="debug-table">
        <thead>
          <tr>
            <th>Fiber</th>
            <th>状态</th>
            <th>帧数</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="fiber in store.debugFibers" :key="fiber.fiber_id" @click="readStack(fiber)">
            <td>{{ fiber.fiber_id }}</td>
            <td>{{ fiber.state }}</td>
            <td>{{ fiber.frame_count }}</td>
          </tr>
        </tbody>
      </table>
      <table class="debug-table">
        <thead>
          <tr>
            <th>函数</th>
            <th>指令</th>
            <th>位置</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="frame in store.debugFrames" :key="frame.frame_id">
            <td>{{ frame.function_name }}</td>
            <td>{{ frame.instruction }}</td>
            <td>
              {{
                frame.source ? `${frame.source.relative_path}:${Number(frame.source.line) + 1}` : ""
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </DraggableDialog>
</template>
