import { AsyncLocalStorage } from "node:async_hooks";

/* The Request a route handler is currently answering; read by the next/headers mock in setup.ts */
export const reqStore = new AsyncLocalStorage<Request>();
