/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CIC_SIGN_IN_URL: string | undefined;
  readonly VITE_CIC_OSS_REPO: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
