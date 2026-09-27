// createContext() must be called outside a component: a type-safe [get, set, has] triple
import { createContext } from 'svelte';

export const [getUser, setUser, hasUser] = createContext();
