/**
 * Registers every action handler on Cordis ctx.connection.fetch with standardized RPC envelopes.
 */
export function registerWorkRouter(ctx, handlers, { getStoredGithubAuth, redactGitError }) {
  const handleAction = async (action, args, signal) => {
    const handler = handlers[action];
    if (!handler) {
      return { ok: false, error: { code: 'ENDPOINT_NOT_FOUND', message: `Unknown action: ${action}` } };
    }
    try {
      return await handler(args, signal);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: redactGitError(error.message || 'Error occurred in Work RPC', (await getStoredGithubAuth())?.token || ''),
          details: { name: error.name },
        },
      };
    }
  };

  for (const action of Object.keys(handlers)) {
    ctx.connection.fetch.register({
      path: `/api/work/${action}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        let envelope;
        try {
          envelope = await request.json();
        } catch {
          return new Response('Invalid request', { status: 400 });
        }
        if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.method !== `work/${action}`) {
          return new Response('Invalid request', { status: 400 });
        }
        const outcome = await handleAction(action, envelope.payload?.args ?? {}, request.signal);
        const result = outcome.ok ? outcome : {
          ok: false,
          error: { code: outcome.error.code || 'WORK_ERROR', message: outcome.error.message, details: outcome.error.details || {} },
        };
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result });
      },
    });
  }

  return handleAction;
}
