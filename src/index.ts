import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type RequestOptions,
  type Body as MockBody,
  type MockRequest,
  type MockResponse,
  type RequestMethod,
  type Headers as MockHeaders,
  createRequest,
  createResponse as createMockResponse,
} from "node-mocks-http";
import Connect from "connect";
import { Elysia } from "elysia";

type ConnectServer = Connect.Server;

export type ConnectMiddleware = Connect.HandleFunction;

export function connect(...middlewares: ConnectMiddleware[]) {
  const connectApp = Connect();

  for (const middleware of middlewares) {
    connectApp.use(middleware);
  }

  return new Elysia({
    name: "connect",
    seed: middlewares,
  }).onRequest(async function processConnectMiddlewares({ request, set }) {
    const message = await transformRequestToIncomingMessage(
      connectApp,
      request,
    );

    return await new Promise<Response | undefined>((resolve) => {
      const response = createResponseProxy(message, resolve);

      connectApp.handle(message, response, () => {
        const webResponse = toWebResponse(response);

        webResponse.headers.forEach((value, key) => {
          set.headers[key] = value;
        });
        set.status = webResponse.status;

        resolve(undefined);
      });
    });
  });
}

function mockAppAtRequest(
  message: MockRequest<IncomingMessage>,
  connectApp: ConnectServer,
) {
  message.app = connectApp;

  // Express middleware calls req.app.get('env') to read settings.
  // Connect has no settings system, so we stub it.
  message.app.get = (_setting: string) => false;

  return message;
}

async function transformRequestToIncomingMessage(
  connectApp: ConnectServer,
  request: Request,
  options?: RequestOptions,
): Promise<MockRequest<IncomingMessage>> {
  const parsedURL = new URL(request.url, "http://localhost");

  const query: Record<string, string> = {};

  for (const [key, value] of parsedURL.searchParams.entries()) {
    query[key] = value;
  }

  let body: MockBody | undefined;

  try {
    body = (await request.clone().json()) as MockBody;
  } catch {
    body = undefined;
  }

  const message = createRequest<IncomingMessage>({
    method: request.method.toUpperCase() as RequestMethod,
    url: parsedURL.pathname + parsedURL.search,
    path: parsedURL.pathname,
    originalUrl: parsedURL.pathname + parsedURL.search,
    baseUrl: parsedURL.origin,
    headers: headersToRecord(request.headers),
    query,
    body,
    ...options,
  });

  return mockAppAtRequest(message, connectApp);
}

function headersToRecord(headers: Headers): MockHeaders {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result as MockHeaders;
}

function toWebResponse(
  mockResponse: MockResponse<ServerResponse>,
): Response {
  const headers = new Headers();
  const rawHeaders = mockResponse.getHeaders();

  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, String(value));
    }
  }

  return new Response(
    mockResponse._getData() || mockResponse._getBuffer(),
    {
      status: mockResponse.statusCode,
      statusText: mockResponse.statusMessage,
      headers,
    },
  );
}

interface NodeResponseInternals {
  _implicitHeader?: () => void;
}

function createResponseProxy(
  request: MockRequest<IncomingMessage>,
  resolve: (value: Response) => void,
): MockResponse<ServerResponse> {
  const response = createMockResponse<ServerResponse>({
    req: request,
  });

  // Some middleware (e.g. compression) calls Node's internal _implicitHeader.
  const withInternals = response as MockResponse<ServerResponse> &
    NodeResponseInternals;
  if (!withInternals._implicitHeader) {
    withInternals._implicitHeader = () => {};
  }

  const originalEnd = response.end;

  // Wrap end() to intercept the completed response and resolve the promise.
  // ServerResponse.end() has multiple overloaded signatures that can't be
  // represented by a single implementation, so a type assertion is needed.
  response.end = ((...args: unknown[]) => {
    const result = (originalEnd as Function).apply(response, args);
    resolve(toWebResponse(response));
    return result;
  }) as typeof response.end;

  return response;
}
