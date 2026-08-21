<script setup lang="ts">
withDefaults(
  defineProps<{
    id: string;
    labelId: string;
    modelValue?: string;
    name?: string;
    options: readonly { value: string; label: string }[];
    disabled?: boolean;
  }>(),
  {
    modelValue: undefined,
    name: undefined,
    disabled: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();
</script>

<template>
  <div :id="id" class="setting-radio-control" role="radiogroup" :aria-labelledby="labelId">
    <label v-for="option in options" :key="option.value" :for="`${id}-${option.value}`">
      <input
        :id="`${id}-${option.value}`"
        type="radio"
        :name="name ?? id"
        :value="option.value"
        :checked="modelValue === option.value"
        :disabled="disabled"
        @change="emit('update:modelValue', option.value)"
      />
      <span>{{ option.label }}</span>
    </label>
  </div>
</template>
