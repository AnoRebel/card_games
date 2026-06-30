<script setup lang="ts">
const { $t, $switchLocale, $getLocales, $getLocale } = useI18n()
const { isDark, toggle } = useThemeMode()
const settings = useSettingsPanel()

const locales = computed(() => $getLocales())
</script>

<template>
  <div
    class="min-h-dvh flex flex-col"
    :style="{ background: 'var(--cg-bg)', color: 'var(--cg-text)' }"
  >
    <header
      class="sticky top-0 z-40 border-b"
      :style="{
        borderColor: 'var(--cg-border)',
        background: 'color-mix(in oklch, var(--cg-bg) 82%, transparent)',
        backdropFilter: 'blur(10px)',
      }"
    >
      <nav class="mx-auto max-w-5xl px-3 h-12 flex items-center justify-between gap-2">
        <NuxtLink
          to="/"
          class="font-display font-bold tracking-tight inline-flex items-center gap-1.5"
        >
          <span class="text-lg leading-none">🂡</span>
          <span class="hidden xs:inline">Card Games</span>
        </NuxtLink>

        <div class="flex items-center gap-0.5">
          <UDropdownMenu
            :items="locales.map((l) => ({
              label: l.code.toUpperCase(),
              onSelect: () => $switchLocale(l.code),
            }))"
          >
            <UButton
              variant="ghost"
              color="neutral"
              size="sm"
              icon="i-lucide-languages"
              :title="$t('common.language')"
            >
              {{ $getLocale().toUpperCase() }}
            </UButton>
          </UDropdownMenu>

          <ClientOnly>
            <UButton
              :icon="isDark ? 'i-lucide-moon' : 'i-lucide-sun'"
              variant="ghost"
              color="neutral"
              size="sm"
              :title="isDark ? $t('theme.lightMode') : $t('theme.darkMode')"
              :aria-label="isDark ? $t('theme.lightMode') : $t('theme.darkMode')"
              @click="(e: MouseEvent) => toggle(e)"
            />
            <template #fallback>
              <UButton icon="i-lucide-sun" variant="ghost" color="neutral" size="sm" />
            </template>
          </ClientOnly>
          <UButton
            variant="ghost"
            color="neutral"
            size="sm"
            icon="i-lucide-settings"
            :title="$t('common.settings')"
            :aria-label="$t('common.settings')"
            @click="settings.show()"
          />
        </div>
      </nav>
    </header>

    <main class="flex-1 mx-auto w-full max-w-5xl px-3 py-4">
      <slot />
    </main>

    <AppFooter />

    <GlobalSettings />
  </div>
</template>
