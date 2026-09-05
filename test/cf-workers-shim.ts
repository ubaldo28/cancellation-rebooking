/**
 * Stand-in for the `cloudflare:workers` module, which only exists inside the
 * Workers runtime. Node cannot resolve it, so any test that imports the Worker
 * entry point — or a Durable Object class — fails at import time without this.
 */
export class DurableObject<E = unknown> {
  constructor(public ctx: any, public env: E) {}
}
