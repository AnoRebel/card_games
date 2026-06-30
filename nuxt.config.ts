// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  future: {
    compatibilityVersion: 5,
  },

  compatibilityDate: '2026-06-01',

  modules: [
    '@nuxt/ui',
    '@vueuse/nuxt',
    '@vueuse/motion/nuxt',
    '@nuxt/eslint',
    '@nuxt/icon',
    '@nuxt/image',
    '@nuxt/fonts',
    'nuxt-i18n-micro',
    'nuxt-umami',
  ],

  // Privacy-friendly, self-hosted analytics (same stack as other side projects).
  // Both are no-ops until their site ids are provided via env, so local/dev runs
  // don't phone home.
  umami: {
    id: process.env.NUXT_UMAMI_SITE_ID || '',
    host: 'https://umami.anorebel.net',
    autoTrack: true,
    proxy: 'cloak',
  },

  // Rybbit (self-hosted) injected DIRECTLY via app.head — the docs' alternative
  // method. We deliberately avoid @nuxt/scripts here: its registry proxies the
  // script through /_scripts/p/... and rewrites the SDK's API host to the SaaS
  // default app.rybbit.io, so tracking POSTed to
  // /_scripts/p/app.rybbit.io/api/track → 404 "Site not found". Loading the
  // script straight from the instance makes the SDK derive its API host from its
  // own origin (rybbit.anorebel.net) and POST there. Only inject when a site id
  // is present; the script handles SPA route tracking itself.
  app: {
    head: {
      script: process.env.NUXT_RYBBIT_SITE_ID
        ? [
            {
              src: 'https://rybbit.anorebel.net/api/script.js',
              defer: true,
              'data-site-id': process.env.NUXT_RYBBIT_SITE_ID,
            },
          ]
        : [],
    },
  },

  // i18n: English + Swahili (sw). Albastini's East-African roots make sw a
  // natural fit (Dume/Jike/Mzungu surface in translations).
  i18n: {
    locales: [
      { code: 'en', iso: 'en-US', dir: 'ltr' },
      { code: 'sw', iso: 'sw-TZ', dir: 'ltr' },
    ],
    defaultLocale: 'en',
    translationDir: 'locales',
    meta: true,
    // Remember the chosen locale across reloads.
    localeCookie: 'cg-locale',
  },

  // Prettier owns formatting; keep ESLint focused on code-quality rules only.
  eslint: {
    config: {
      stylistic: false,
    },
  },

  // Nitro native WebSockets (crossws) carry the room/game protocol with pub/sub.
  nitro: {
    experimental: {
      websocket: true,
    },
  },

  devtools: { enabled: true },

  // Register nested component dirs without a path prefix so e.g.
  // components/games/LastCardTable.vue is usable as <LastCardTable>.
  components: [{ path: '~/components', pathPrefix: false }],

  css: ['~/assets/css/main.css'],

  // Self-hosted fonts only. Files live in /public/fonts using the @nuxt/fonts
  // auto-discovery pattern (<family>-<weight>-<style>.woff2); the module
  // generates @font-face + fallback metrics. No remote provider is fetched.
  //   Bricolage Grotesque → brand/display   Inter → UI/body
  //   Outfit → Last Card accent             Fraunces → Albastini accent
  fonts: {
    defaults: {
      weights: ['400', '500', '600', '700'],
      styles: ['normal'],
      subsets: ['latin'],
    },
    families: [
      {
        name: 'Inter',
        provider: 'local',
        weights: ['400', '500', '600', '700'],
      },
      {
        name: 'Bricolage Grotesque',
        provider: 'local',
        weights: ['600', '700', '800'],
      },
      { name: 'Outfit', provider: 'local', weights: ['500', '600', '700'] },
      {
        // Fraunces ships expressive italics — kept for Albastini's heritage feel.
        name: 'Fraunces',
        provider: 'local',
        weights: ['500', '600', '700'],
        styles: ['normal', 'italic'],
      },
    ],
  },

  // Transpile the workspace engine/game packages (shipped as TS source).
  build: {
    transpile: [
      '@card-games/engine-core',
      '@card-games/game-last-card',
      '@card-games/game-albastini',
    ],
  },

  // All overridable via env vars (NUXT_* for private, NUXT_PUBLIC_* for public),
  // e.g. NUXT_PUBLIC_CONDUIT_PATH, NUXT_CONDUIT_AUTH_MODE, NUXT_CONDUIT_KEY.
  runtimeConfig: {
    // Server-only Conduit signaling settings. Conduit is an OPTIONAL WebRTC P2P
    // enhancement; the Nitro-native WS path is the default carrier, so this is
    // off unless explicitly enabled (NUXT_CONDUIT_ENABLED=true).
    conduit: {
      enabled: false,
      authMode: 'none', // 'none' | 'key'
      key: 'conduit', // required when authMode === 'key'
      relayMaxMessageBytes: 65536,
      allowedOrigins: '', // comma-separated; empty = allow all (dev)
    },
    // Analytics site ids (overridable via NUXT_RYBBIT_SITE_ID / NUXT_UMAMI_SITE_ID).
    rybbit: {
      siteId: process.env.NUXT_RYBBIT_SITE_ID || '',
    },
    umami: {
      id: process.env.NUXT_UMAMI_SITE_ID || '',
    },
    public: {
      conduit: {
        // Signaling/relay endpoint path (same Nitro server by default).
        path: '/api/conduit',
        // Preferred transport: 'auto' | 'webrtc' | 'websocket'.
        transport: 'auto',
      },
    },
  },

  typescript: {
    strict: true,
  },
})
