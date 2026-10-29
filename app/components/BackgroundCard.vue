<template>
  <div
    :class="cardClasses"
    role="button"
    tabindex="0"
    :aria-pressed="active ? 'true' : 'false'"
    :aria-label="`Apply ${bg.name} background`"
    @click="$emit('select', bg)"
    @keydown.enter.prevent="$emit('select', bg)"
    @keydown.space.prevent="$emit('select', bg)"
  >
    <div class="relative aspect-[16/10] overflow-hidden bg-slate-900">
      <div
        class="absolute inset-0"
        :class="categoryAccent[bg.category] || FALLBACK"
      />

      <img
        v-if="bg.id && !imageFailed"
        :src="`/screenshots/${bg.id}.png`"
        :alt="bg.name"
        loading="lazy"
        decoding="async"
        class="relative h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04]"
        @error="imageFailed = true"
      />

      <div
        class="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/55 to-transparent"
      />
      <div
        class="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/45 to-transparent"
      />

      <span
        class="absolute left-3 top-3 rounded-full border border-white/15 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider text-white/85 backdrop-blur-md"
      >
        {{ bg.category || "Background" }}
      </span>

      <span
        v-if="active"
        class="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur-md"
      >
        <span
          class="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]"
        />
        Live
      </span>

      <a
        :href="sourceUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-black/50 text-white/80 opacity-0 backdrop-blur-md transition duration-200 hover:bg-black/70 hover:text-white focus-visible:opacity-100 group-hover:opacity-100"
        title="View source code"
        aria-label="View source code"
        @click.stop
        @keydown.stop
      >
        <Icon name="heroicons:code-bracket" size="16" />
      </a>
    </div>

    <div class="flex flex-1 flex-col p-4">
      <h3
        class="text-[15px] font-semibold leading-snug tracking-tight text-white"
      >
        {{ bg.name }}
      </h3>

      <p class="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-slate-400">
        {{ bg.description }}
      </p>

      <div
        class="mt-auto flex items-center justify-between gap-3 border-t border-white/[0.07] pt-3.5"
      >
        <a
          v-if="bg.author && bg.author.name"
          :href="bg.author.url"
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:text-indigo-300"
          @click.stop
          @keydown.stop
        >
          <Icon name="heroicons:user" size="13" class="shrink-0" />
          <span class="truncate">{{ bg.author.name }}</span>
        </a>
        <span v-else class="text-[11px] font-medium text-slate-600"
          >Original</span
        >

        <span
          class="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold transition-colors"
          :class="[
            active
              ? 'text-emerald-300'
              : 'text-slate-500 group-hover:text-white',
          ]"
        >
          {{ active ? "Applied" : "Apply" }}
          <Icon
            :name="active ? 'heroicons:check' : 'heroicons:arrow-right'"
            size="13"
          />
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from "vue";

const props = defineProps({
  bg: { type: Object, required: true },
  active: { type: Boolean, default: false },
});

defineEmits(["select"]);

const FALLBACK = "bg-gradient-to-br from-slate-800 via-slate-900 to-black";

const categoryAccent = {
  WebGL: "bg-gradient-to-br from-indigo-600/45 via-violet-800/35 to-slate-950",
  Canvas: "bg-gradient-to-br from-emerald-600/45 via-teal-800/35 to-slate-950",
};

const imageFailed = ref(false);

const sourceUrl = computed(
  () =>
    `https://github.com/alvinunreal/openbackgrounds/blob/main/app/components/bg/${props.bg.component}.vue`,
);

const cardClasses = computed(() => [
  "group relative flex h-full flex-col overflow-hidden rounded-2xl border text-left cursor-pointer select-none",
  "bg-white/[0.035] backdrop-blur-xl",
  "transition duration-300 ease-out",
  "hover:-translate-y-1 hover:bg-white/[0.07] hover:shadow-[0_18px_40px_-12px_rgba(0,0,0,0.75)]",
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A001A]",
  props.active
    ? "border-indigo-400/60 ring-1 ring-indigo-400/40 bg-white/[0.07]"
    : "border-white/10 hover:border-white/25",
]);
</script>

<style scoped>
* {
  font-family: "Poppins", sans-serif;
}

/* Thin highlight along the top edge of the card, for depth. */
.group::before {
  content: "";
  position: absolute;
  inset: 0 auto auto 0;
  height: 1px;
  width: 100%;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.28),
    transparent
  );
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
  z-index: 2;
}

.group:hover::before,
.group:focus-visible::before {
  opacity: 1;
}
</style>
