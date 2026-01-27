export const json = (response, statusCode, data, extraHeaders = {}) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(data));
  throw null;
};

export const text = (response, statusCode, body, extraHeaders = {}) => {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(body);
  throw null;
};

export const noContent = (response, extraHeaders = {}) => {
  response.writeHead(204, { "Cache-Control": "no-store", ...extraHeaders });
  response.end();
  throw null;
};
