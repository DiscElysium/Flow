import assert from "node:assert/strict";
import test from "node:test";

const siteTitle = /<title>Alpine Flow Lab — Procedural Low-Poly Terrain<\/title>/i;
const siteDescription = /<meta(?=[^>]*\bname=["']description["'])(?=[^>]*\bcontent=["']A generative low-poly mountain lab shaped by terrain tools and dynamic water flow\.["'])[^>]*>/i;

test("renders Alpine Flow Lab metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, siteTitle);
  assert.match(html, siteDescription);
});
