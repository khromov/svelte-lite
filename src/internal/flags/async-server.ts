// what compiled server output imports when `experimental.async` is on, which
// Svelte's server runtime supports
import { enable_async_mode_flag } from './index.ts';

enable_async_mode_flag();
