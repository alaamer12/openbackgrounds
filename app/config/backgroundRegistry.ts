import { defineAsyncComponent } from "vue";
import type { Component } from "vue";
import { backgrounds } from "./backgrounds";

/**
 * Single source of truth for resolving a `config.component` string to a real
 * component. Lives next to backgrounds.js (not in app/composables) because
 * `import.meta.glob` keys resolve relative to *this* file, so both pages can
 * import one registry instead of each maintaining its own copy.
 *
 * Non-eager on purpose: exactly one scene renders at a time, so 50 heavy
 * WebGL/Three.js modules must not land in the entry chunk.
 */
const loaders = import.meta.glob("../components/bg/*.vue");

const fileNameOf = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.vue$/, "");

const loaderByName: Record<string, () => Promise<unknown>> = Object.fromEntries(
  Object.entries(loaders).map(([path, load]) => [fileNameOf(path), load]),
);

// One async definition per name, cached. Without this every lookup hands
// <component :is> a brand-new definition, which remounts the scene and
// refetches the chunk on every re-render.
const asyncByname = new Map<string, Component>();

export type BackgroundLoader = () => Promise<unknown>;

export function getBackgroundComponent(name: string): Component | undefined {
  const load = loaderByName[name];
  if (!load) return undefined;

  if (!asyncByname.has(name)) {
    asyncByname.set(
      name,
      defineAsyncComponent({
        loader: load as () => Promise<{ default: Component }>,
        timeout: 15000,
        // A transient or stale-deploy chunk fetch failure should not leave the
        // page with a permanently empty background.
        onError(error, retry, fail, attempts) {
          if (attempts <= 2) retry();
          else fail();
        },
      }),
    );
  }

  return asyncByname.get(name);
}

/** Warms the chunk without rendering it, so a later switch is instant. */
export function preloadBackgroundComponent(name: string) {
  loaderByName[name]?.();
}

export function hasBackgroundComponent(name: string) {
  return Boolean(loaderByName[name]);
}

/**
 * Drift guard. Adding a background is meant to be "drop a .vue file, add a
 * config entry", and the failure mode of getting that wrong used to be silent:
 * an unregistered file was simply invisible, and a config typo produced a
 * black screenshot rather than an error.
 */
function warnOnDrift() {
  const declared = new Set<string>();
  const ids = new Set<string>();

  for (const bg of backgrounds as { id: string; component: string }[]) {
    if (declared.has(bg.component)) {
      console.warn(
        `[backgrounds] component "${bg.component}" is used by more than one entry`,
      );
    }
    if (ids.has(bg.id)) {
      console.warn(
        `[backgrounds] duplicate id "${bg.id}" breaks ?bg= restore and overwrites screenshots`,
      );
    }
    declared.add(bg.component);
    ids.add(bg.id);

    if (!loaderByName[bg.component]) {
      console.warn(
        `[backgrounds] config entry "${bg.id}" points at missing app/components/bg/${bg.component}.vue`,
      );
    }
  }

  for (const name of Object.keys(loaderByName)) {
    if (!declared.has(name)) {
      console.warn(
        `[backgrounds] app/components/bg/${name}.vue exists but is not in config/backgrounds.js`,
      );
    }
  }
}

warnOnDrift();
