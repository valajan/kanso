// The MCP stdio transport, in full: JSON-RPC 2.0 messages, one per line, on a
// stream pair. That is the entire wire protocol, which is why Kanso speaks it
// directly rather than depending on the reference SDK — whose stdio server
// pulls in express, hono, jose and ajv to serve the transports we do not use.
//
// Nothing here knows what a tool does: `createDispatcher` is handed a list of
// them and answers the four methods a tools-only server owes a host.

const JSONRPC = '2.0';

// The version Kanso speaks, and the older ones it answers to. A host asking
// for one of these is told its own version back; a host asking for anything
// else is told ours, and decides whether to go on.
export const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'];

export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
};

// Raised by a tool when the arguments it was called with are not usable. The
// host gets an invalid-params error naming what is wrong, which is what its
// model reads before calling again.
export class InvalidParams extends Error {}

// A method this server does not have. Everything else that escapes a handler
// is Kanso's own fault, and is reported as an internal error.
class MethodNotFound extends Error {}

// Builds the function that answers one message. Returns the response to send,
// or null for a notification, which is answered by silence.
//
// `tools` are { name, title, description, inputSchema, annotations, run }, and
// `run(args, { progress })` returns the tool result — see src/mcp/tools.js.
export function createDispatcher({ serverInfo, instructions, tools }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  // The handler is the server's own business; the host is sent the rest.
  const listed = tools.map(({ run, ...tool }) => tool);

  return async function dispatch(message, { notify }) {
    if (message == null || typeof message !== 'object' || Array.isArray(message)) {
      return errorResponse(null, RPC.invalidRequest, 'a JSON-RPC message is an object');
    }
    // A notification carries no id and is owed no answer — including the
    // `notifications/cancelled` a host sends for a call it gave up on: an audit
    // already under way costs the same whether or not its answer is read.
    if (message.id === undefined || message.id === null) return null;
    if (typeof message.method !== 'string') {
      return errorResponse(message.id, RPC.invalidRequest, 'a JSON-RPC request carries a method');
    }

    try {
      return { jsonrpc: JSONRPC, id: message.id, result: await answer(message, { notify }) };
    } catch (err) {
      const code = err instanceof InvalidParams ? RPC.invalidParams
        : err instanceof MethodNotFound ? RPC.methodNotFound
        : RPC.internalError;
      return errorResponse(message.id, code, err?.message ?? String(err));
    }
  };

  async function answer(message, { notify }) {
    const { method } = message;
    // `params` is optional, and a host is free to send it as null.
    const params = message.params ?? {};

    switch (method) {
      // Kanso holds no session state: an audit is one call, start to finish,
      // and a host that reconnects has nothing to rebuild. So `initialize`
      // reports what is on offer and nothing is remembered from it.
      case 'initialize':
        return {
          protocolVersion: negotiate(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions,
        };

      case 'ping':
        return {};

      case 'tools/list':
        return { tools: listed };

      case 'tools/call': {
        const tool = byName.get(params.name);
        if (!tool) throw new InvalidParams(`unknown tool: ${params.name}`);
        return await tool.run(params.arguments ?? {}, { progress: progressTo(params._meta?.progressToken, notify) });
      }

      default:
        throw new MethodNotFound(`unknown method: ${method}`);
    }
  }
}

// A host only hears about progress if it asked, by sending a token to attach
// the notifications to. Without one, the tool runs and says nothing.
function progressTo(token, notify) {
  if (token === undefined || token === null) return () => {};
  return (progress, message) => notify('notifications/progress', { progressToken: token, progress, message });
}

function negotiate(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

function errorResponse(id, code, message) {
  return { jsonrpc: JSONRPC, id, error: { code, message } };
}

// Reads messages off `input` and writes answers to `output`, one JSON object
// per line. Resolves when the input ends — which is how an MCP host says it is
// done with the server.
//
// Requests are not serialized: an audit is a minute long, and a host that pings
// during one expects an answer before it declares the server dead.
export function serve({ input, output, dispatch }) {
  const send = (message) => output.write(JSON.stringify(message) + '\n');
  const notify = (method, params) => send({ jsonrpc: JSONRPC, method, params });
  const inFlight = new Set();
  let buffer = '';

  return new Promise((resolve, reject) => {
    input.setEncoding?.('utf8');

    input.on('data', (chunk) => {
      // A message can arrive split across chunks, or several in one: the line
      // is the frame, and the remainder waits for the rest of itself.
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) handle(line);
      }
    });

    input.on('error', reject);
    input.on('end', () => {
      // Whatever was still running gets to finish and answer: the host is
      // closing the pipe, not cancelling the work.
      Promise.allSettled([...inFlight]).then(() => resolve());
    });
  });

  function handle(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return send(errorResponse(null, RPC.parseError, 'invalid JSON'));
    }

    const task = Promise.resolve(dispatch(message, { notify }))
      .then((response) => {
        if (response) send(response);
      })
      .catch((err) => {
        // dispatch answers its own errors; reaching here means the server
        // itself broke, and the host is owed an answer rather than a silence.
        if (message?.id != null) send(errorResponse(message.id, RPC.internalError, err?.message ?? String(err)));
      })
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  }
}
