// Stand-in for the 'cloudflare:workers' module when worker/index.mjs runs under Node (local/server.mjs).
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
