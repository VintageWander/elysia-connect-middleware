import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { Elysia } from "elysia";

export type ConnectMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: any) => void,
) => void;

export function connect(...middlewares: ConnectMiddleware[]) {
  return new Elysia({
    name: "connect",
    seed: middlewares,
  }).onRequest(async function processConnectMiddlewares({ request, set }) {
    const req = await toNodeRequest(request);

    return await new Promise<Response | undefined>((resolve) => {
      const res = createNodeResponse(req, resolve);

      runMiddleware(middlewares, req, res, () => {
        const webResponse = toWebResponse(res);

        webResponse.headers.forEach((value, key) => {
          set.headers[key] = value;
        });
        set.status = webResponse.status;

        resolve(undefined);
      });
    });
  });
}

// Minimal connect-compatible middleware runner. Walks the stack calling next()
// to advance; dispatches error handlers (arity 4) when an error is present,
// skips normal handlers in that case, and vice-versa.
function runMiddleware(
  stack: ((...args: any[]) => void)[],
  req: unknown,
  res: unknown,
  done: (err?: unknown) => void,
) {
  let index = 0;

  function next(err?: unknown) {
    const handle = stack[index++];
    if (!handle) {
      done(err);
      return;
    }

    try {
      if (err) {
        if (handle.length >= 4) {
          handle(err, req, res, next);
        } else {
          next(err);
        }
      } else {
        if (handle.length < 4) {
          handle(req, res, next);
        } else {
          next();
        }
      }
    } catch (e) {
      next(e);
    }
  }

  next();
}

function createMockSocket() {
  return Object.assign(new EventEmitter(), {
    destroy() {},
    remoteAddress: "127.0.0.1",
    writable: true,
    encrypted: false,
  });
}

async function toNodeRequest(request: Request) {
  const parsed = new URL(request.url, "http://localhost");

  const query: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    query[key] = value;
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    body = undefined;
  }

  const socket = createMockSocket();

  // Express middleware calls req.app.get('env') to read settings.
  // Connect has no settings system, so we stub it.
  const app = { get: () => false };

  return Object.assign(new EventEmitter(), {
    method: request.method.toUpperCase(),
    url: parsed.pathname + parsed.search,
    originalUrl: parsed.pathname + parsed.search,
    baseUrl: parsed.origin,
    path: parsed.pathname,
    headers,
    rawHeaders: Object.entries(headers).flat(),
    query,
    body,
    params: {},
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    readable: true,
    aborted: false,
    socket,
    connection: socket,
    app,

    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
    unpipe() {
      return this;
    },
    resume() {
      return this;
    },
    pause() {
      return this;
    },
    destroy() {},
    setTimeout(_ms: number, _cb?: () => void) {
      return this;
    },
  });
}

function concatChunks(chunks: Uint8Array[]): ArrayBuffer {
  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  if (totalLength === 0) return new ArrayBuffer(0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

function createNodeResponse(
  req: { socket: ReturnType<typeof createMockSocket> },
  resolvePromise: (value: Response) => void,
) {
  const headers: Record<string, string | number | string[]> = {};
  let data = "";
  const chunks: Uint8Array[] = [];
  let endCalled = false;

  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    statusMessage: "OK",
    headersSent: false,
    finished: false,
    writableEnded: false,
    writableFinished: false,
    writable: true,
    req,
    socket: req.socket,

    _implicitHeader() {},
    flushHeaders() {},
    cork() {},
    uncork() {},

    setHeader(name: string, value: string | number | string[]) {
      headers[name.toLowerCase()] = value;
      return res;
    },

    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },

    getHeaders(): Record<string, string | number | string[] | undefined> {
      return { ...headers };
    },

    getHeaderNames() {
      return Object.keys(headers);
    },

    hasHeader(name: string) {
      return name.toLowerCase() in headers;
    },

    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },

    appendHeader(name: string, value: string | string[]) {
      const key = name.toLowerCase();
      const existing = headers[key];
      if (existing === undefined) {
        headers[key] = value;
      } else if (Array.isArray(existing)) {
        headers[key] = existing.concat(value);
      } else {
        headers[key] = [String(existing)].concat(value);
      }
      return res;
    },

    writeHead(
      statusCode: number,
      statusMessageOrHeaders?:
        | string
        | Record<string, string | number | string[]>,
      maybeHeaders?: Record<string, string | number | string[]>,
    ) {
      res.statusCode = statusCode;
      let hdrs: Record<string, string | number | string[]> | undefined;

      if (typeof statusMessageOrHeaders === "string") {
        res.statusMessage = statusMessageOrHeaders;
        hdrs = maybeHeaders;
      } else if (typeof statusMessageOrHeaders === "object") {
        hdrs = statusMessageOrHeaders;
      }

      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          res.setHeader(k, v);
        }
      }

      res.headersSent = true;
      return res;
    },

    write(
      chunk: string | Uint8Array,
      encodingOrCallback?: string | (() => void),
      callback?: () => void,
    ) {
      res.headersSent = true;

      if (typeof chunk === "string") {
        data += chunk;
      } else {
        chunks.push(chunk);
      }

      const cb =
        typeof encodingOrCallback === "function"
          ? encodingOrCallback
          : callback;
      if (cb) cb();

      return true;
    },

    end(
      chunkOrCallback?: string | Uint8Array | (() => void),
      encodingOrCallback?: string | (() => void),
      callback?: () => void,
    ) {
      if (endCalled) return res;
      endCalled = true;

      let chunk: string | Uint8Array | undefined;
      let cb: (() => void) | undefined;

      if (typeof chunkOrCallback === "function") {
        cb = chunkOrCallback;
      } else {
        chunk = chunkOrCallback;
        cb =
          typeof encodingOrCallback === "function"
            ? encodingOrCallback
            : callback;
      }

      if (chunk != null) {
        if (typeof chunk === "string") {
          data += chunk;
        } else {
          chunks.push(chunk);
        }
      }

      res.finished = true;
      res.writableEnded = true;
      res.headersSent = true;

      res.emit("end");
      res.writableFinished = true;
      res.emit("finish");

      if (cb) cb();

      resolvePromise(toWebResponse(res));

      return res;
    },

    getData() {
      return data;
    },

    getBuffer(): ArrayBuffer {
      return concatChunks(chunks);
    },

    setTimeout(_ms: number, _cb?: () => void) {
      return res;
    },
  });

  return res;
}

type NodeResponse = ReturnType<typeof createNodeResponse>;

function toWebResponse(res: NodeResponse): Response {
  const headers = new Headers();
  const rawHeaders = res.getHeaders();

  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, String(value));
    }
  }

  const body = res.getData() || res.getBuffer();
  return new Response(body, {
    status: res.statusCode,
    statusText: res.statusMessage,
    headers,
  });
}
