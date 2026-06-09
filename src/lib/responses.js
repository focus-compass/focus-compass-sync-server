// Thrown by the response helpers below once the HTTP response has been written,
// to short-circuit the router chain in server.js. The top-level onRequest handler
// re-throws it so Hocuspocus treats the request as handled. A real Error means an
// actual failure; this sentinel means "response already sent — stop routing".
export const RESPONSE_SENT = Symbol("RESPONSE_SENT");

export const json = (response, statusCode, data, extraHeaders = {}) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(data));
  throw RESPONSE_SENT;
};

export const text = (response, statusCode, body, extraHeaders = {}) => {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
  throw RESPONSE_SENT;
};

export const noContent = (response, extraHeaders = {}) => {
  response.writeHead(204, { "Cache-Control": "no-store", ...extraHeaders });
  response.end();
  throw RESPONSE_SENT;
};
