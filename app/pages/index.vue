<template>
  <div class="relative">
    <!--
      Fixed, viewport-sized layer so the chosen background sits behind the
      whole page instead of being clipped to the hero. The dark gradient base
      keeps text legible where a canvas renders transparent.
    -->
    <div
      class="fixed inset-0 z-0 bg-gradient-to-b from-black via-[#1A0033] to-[#0A001A]"
    >
      <Transition name="bg-fade" mode="out-in">
        <div
          v-if="selectedBackgroundComponent"
          :key="selectedBackground?.id"
          class="absolute inset-0 pointer-events-none"
        >
          <!--
            Scenes resolve from their own lazy chunk, so the cross-fade is
            applied to this stable wrapper (never the async child) and the
            fallback keeps the gradient base visible while it loads.
          -->
          <Suspense>
            <component :is="selectedBackgroundComponent" />
            <template #fallback>
              <div class="absolute inset-0" />
            </template>
          </Suspense>
        </div>
      </Transition>
    </div>

    <section
      class="relative z-10 flex flex-col items-center justify-between min-h-[90vh] text-white pb-16 text-sm"
    >
      <FpsBadge class="absolute bottom-6 right-6 z-20" />

      <div class="w-full flex justify-center px-4 pt-6 z-10">
        <nav
          class="flex items-center justify-between px-6 py-3 max-w-4xl w-full rounded-full bg-black/20 backdrop-blur-xl border border-white/10 shadow-lg shadow-black/20"
        >
          <a href="/" class="flex items-center gap-2">
            <img
              ref="logoRef"
              src="/1.svg"
              alt="openbackgrounds"
              class="h-6 invert"
            />
            <span ref="logoTextRef" class="text-base font-semibold text-white"
              >openbackgrounds</span
            >
          </a>

          <div class="flex items-center gap-2">
            <a
              href="https://github.com/alvinunreal/openbackgrounds"
              target="_blank"
              rel="noopener noreferrer"
              class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/15 text-gray-300 border border-white/10"
              aria-label="View on GitHub"
            >
              <Icon name="mdi:github" size="16" />
            </a>
          </div>
        </nav>
      </div>

      <div
        class="flex flex-col items-center flex-1 justify-center px-4 relative z-10"
      >
        <h1
          class="text-4xl md:text-5xl text-center font-medium max-w-3xl bg-gradient-to-r from-white to-[#748298] text-transparent bg-clip-text"
        >
          Build. Animate. Captivate. Without the complexity.
        </h1>
        <p
          class="text-slate-100 md:text-base max-md:px-2 text-center max-w-xl mt-3"
        >
          A curated collection of stunning animated backgrounds built with
          Three.js, WebGL, and Canvas that helps you ship fast and scale without
          limits.
        </p>

        <div
          class="bg-gradient-to-t from-indigo-900 to-slate-600 p-px rounded-md mt-8 relative overflow-hidden w-full max-w-xs cursor-pointer hover:opacity-90 transition-opacity"
          @click="selectNextBackground"
        >
          <div
            class="bg-black rounded-md px-6 py-3 relative flex items-center justify-between"
          >
            <div class="text-base font-medium text-white">
              {{ selectedBackground ? selectedBackground.name : "Loading..." }}
            </div>
            <Icon name="heroicons:forward" size="18" class="text-white" />
          </div>
        </div>
      </div>

      <div
        class="overflow-hidden w-full relative max-w-6xl mx-auto select-none mb-8 z-10 mask-gradient"
      >
        <div class="marquee-inner flex will-change-transform min-w-[200%]">
          <div class="flex py-4">
            <div
              v-for="(logo, index) in [...logos, ...logos]"
              :key="index"
              class="mx-14"
              v-html="logo"
            />
          </div>
        </div>
      </div>
    </section>

    <div class="relative z-10 h-16">
      <div
        class="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-500/30 to-transparent"
      />
    </div>

    <section
      class="relative z-10 text-white py-12 px-4 md:px-16 lg:px-24 xl:px-32"
    >
      <div class="max-w-6xl mx-auto">
        <div
          class="flex flex-col md:flex-row md:items-center md:justify-between mb-8 gap-4 md:gap-0"
        >
          <h2 class="text-2xl font-semibold text-white">Backgrounds</h2>

          <div
            class="flex gap-1 bg-white/[0.04] border border-white/10 p-1 rounded-xl flex-wrap backdrop-blur-xl"
          >
            <button
              v-for="category in categories"
              :key="category.name"
              :class="[
                'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                selectedCategory === category.name
                  ? 'bg-white/10 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-white/5',
              ]"
              @click="selectedCategory = category.name"
            >
              {{ category.name }}
              <span class="ml-1.5 text-xs opacity-60">
                {{ category.count }}
              </span>
            </button>
          </div>
        </div>

        <div
          class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5"
        >
          <BackgroundCard
            v-for="bg in filteredBackgrounds"
            :key="bg.id"
            :bg="bg"
            :active="selectedBackground?.id === bg.id"
            @select="selectBackground"
            @pointerenter="preloadBackgroundComponent(bg.component)"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, shallowRef, computed, onMounted } from "vue";
import { backgrounds } from "~/config/backgrounds";
import {
  getBackgroundComponent,
  hasBackgroundComponent,
  preloadBackgroundComponent,
} from "~/config/backgroundRegistry";
import FpsBadge from "~/components/FpsBadge.vue";
import BackgroundCard from "~/components/BackgroundCard.vue";

import gsap from "gsap";

const route = useRoute();
const router = useRouter();

const normalizeQueryValue = (value) =>
  Array.isArray(value) ? value[0] : value;
const logoRef = ref(null);
const logoTextRef = ref(null);
const sectionHeaderRef = ref(null);

const selectedBackgroundComponent = shallowRef(null);
const selectedBackground = ref(null);
const selectedCategory = ref("All");

const persistQuery = (overrides = {}) => {
  const newQuery = { ...route.query };

  if ("bg" in overrides) {
    const bgValue = overrides.bg;
    if (bgValue === null || bgValue === undefined) {
      delete newQuery.bg;
    } else {
      newQuery.bg = `${bgValue}`;
    }
  } else if (selectedBackground.value) {
    newQuery.bg = `${selectedBackground.value.id}`;
  } else {
    delete newQuery.bg;
  }

  router.replace({ query: newQuery });
};

const categories = computed(() => {
  const validBackgrounds = backgrounds.filter((bg) => bg.name && bg.category);
  const categoryMap = {};

  validBackgrounds.forEach((bg) => {
    categoryMap[bg.category] = (categoryMap[bg.category] || 0) + 1;
  });

  const result = [{ name: "All", count: validBackgrounds.length }];

  Object.entries(categoryMap).forEach(([name, count]) => {
    result.push({ name, count });
  });

  return result;
});

const filteredBackgrounds = computed(() => {
  const validBackgrounds = backgrounds.filter((bg) => bg.name);

  if (selectedCategory.value === "All") {
    return validBackgrounds;
  }

  return validBackgrounds.filter(
    (bg) => bg.category === selectedCategory.value,
  );
});

// Derived from the filtered list so the hero's forward button cycles within the
// active category instead of stepping through all 50 in config order.
const selectableBackgrounds = computed(() =>
  filteredBackgrounds.value.filter((bg) =>
    hasBackgroundComponent(bg.component),
  ),
);

const getNextBackground = () => {
  const available = selectableBackgrounds.value;
  if (available.length === 0) {
    return null;
  }

  if (!selectedBackground.value) {
    return available[0];
  }

  const currentIndex = available.findIndex(
    (bg) => bg.id === selectedBackground.value?.id,
  );
  const nextIndex =
    currentIndex === -1 ? 0 : (currentIndex + 1) % available.length;

  return available[nextIndex];
};

const selectBackground = (bg) => {
  if (!bg) return;

  const component = getBackgroundComponent(bg.component);
  if (!component) return;

  selectedBackgroundComponent.value = component;
  selectedBackground.value = bg;

  persistQuery({ bg: bg.id });

  // Warm the next scene in the cycle so the forward button never stalls on a
  // chunk fetch, without eagerly pulling 50 modules up front.
  const available = selectableBackgrounds.value;
  const index = available.findIndex((b) => b.id === bg.id);
  if (index !== -1) {
    const next = available[(index + 1) % available.length];
    if (next) preloadBackgroundComponent(next.component);
  }
};

const selectNextBackground = () => {
  const bg = getNextBackground();
  selectBackground(bg);
};

onMounted(() => {
  const available = selectableBackgrounds.value;
  if (!available.length) return;

  const initialBgParam = normalizeQueryValue(route.query.bg);
  const initialBg = initialBgParam
    ? available.find((bg) => `${bg.id}` === `${initialBgParam}`)
    : null;

  selectBackground(initialBg || available[0]);

  if (logoRef.value && logoTextRef.value) {
    gsap.fromTo(
      logoRef.value,
      { opacity: 0, scale: 0.5, rotation: -180 },
      {
        opacity: 1,
        scale: 1,
        rotation: 0,
        duration: 1.2,
        ease: "elastic.out(1, 0.5)",
      },
    );
    gsap.fromTo(
      logoTextRef.value,
      { opacity: 0, x: -20 },
      { opacity: 1, x: 0, duration: 0.8, delay: 0.3, ease: "power2.out" },
    );
  }

  if (sectionHeaderRef.value) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            gsap.fromTo(
              entry.target,
              { opacity: 0, y: 30 },
              { opacity: 1, y: 0, duration: 0.8, ease: "power2.out" },
            );
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.2 },
    );
    observer.observe(sectionHeaderRef.value);
  }
});

const logos = [
  `<svg class="mx-auto" width="120" height="40" viewBox="0 0 120 40" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="0" y="28" font-family="Arial, sans-serif" font-size="24" font-weight="bold" class="fill-slate-200">Three.js</text></svg>`,
  `<svg class="mx-auto" width="100" height="40" viewBox="0 0 100 40" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="0" y="28" font-family="Arial, sans-serif" font-size="24" font-weight="bold" class="fill-slate-200">WebGL</text></svg>`,
  `<svg class="mx-auto" width="110" height="40" viewBox="0 0 110 40" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="0" y="28" font-family="Arial, sans-serif" font-size="24" font-weight="bold" class="fill-slate-200">Canvas</text></svg>`,
  `<svg class="mx-auto" width="100" height="40" viewBox="0 0 100 40" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="0" y="28" font-family="Arial, sans-serif" font-size="24" font-weight="bold" class="fill-slate-200">P5.js</text></svg>`,
  `<svg class="mx-auto" width="110" height="40" viewBox="0 0 110 40" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="0" y="28" font-family="Arial, sans-serif" font-size="24" font-weight="bold" class="fill-slate-200">GSAP</text></svg>`,
];
</script>

<style scoped>
* {
  font-family: "Poppins", sans-serif;
}

.marquee-inner {
  animation: marqueeScroll 35s linear infinite;
}

@keyframes marqueeScroll {
  0% {
    transform: translateX(0%);
  }
  100% {
    transform: translateX(-50%);
  }
}

.mask-gradient {
  -webkit-mask-image: linear-gradient(
    to right,
    transparent,
    black 10%,
    black 90%,
    transparent
  );
  mask-image: linear-gradient(
    to right,
    transparent,
    black 10%,
    black 90%,
    transparent
  );
}

.bg-fade-enter-active,
.bg-fade-leave-active {
  transition: opacity 0.3s ease;
}

.bg-fade-enter-from {
  opacity: 0;
}

.bg-fade-leave-to {
  opacity: 0;
}
</style>
