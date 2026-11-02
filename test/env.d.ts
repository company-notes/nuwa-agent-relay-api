/// <reference types="@cloudflare/vitest-plugin/types" />
import type { Env as AppEnv } from '../src/Env';

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import('../src/Index');
    }

    interface Env extends AppEnv {}
  }
}
