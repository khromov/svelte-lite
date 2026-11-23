import type { Readable, Subscriber } from './public.ts';

/** Pair of subscriber and invalidator. */
export type SubscribeInvalidateTuple<T> = [Subscriber<T>, () => void];

/** One or more `Readable`s. */
export type Stores = Readable<any> | [Readable<any>, ...Array<Readable<any>>] | Array<Readable<any>>;

/** One or more values from `Readable` stores. */
export type StoresValues<T> =
	T extends Readable<infer U> ? U : { [K in keyof T]: T[K] extends Readable<infer U> ? U : never };
