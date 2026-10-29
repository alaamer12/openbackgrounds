<template>
  <div
    class="fixed inset-0 w-full h-full overflow-hidden bg-gradient-to-b from-black to-[#1A0033]"
  >
    <component :is="bgComponent" v-if="bgComponent" />
  </div>
</template>

<script setup>
import { shallowRef } from "vue";
import { backgrounds } from "@/config/backgrounds";
import { getBackgroundComponent } from "@/config/backgroundRegistry";

const route = useRoute();
const background = backgrounds.find((bg) => bg.id === route.params.id);

if (!background) {
  throw createError({ statusCode: 404, message: "Background not found" });
}

const bgComponent = shallowRef(
  getBackgroundComponent(background.component) || null,
);

if (!bgComponent.value) {
  throw createError({
    statusCode: 404,
    message: `Component "${background.component}" is not registered`,
  });
}

useHead({
  title: `Preview: ${background.name || background.id}`,
  bodyAttrs: {
    class: "overflow-hidden",
  },
});
</script>
