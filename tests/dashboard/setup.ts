import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
// jsdom does not implement scrollIntoView -- a well-known gap, not
// something worth a real dependency; the conversation workspace's
// auto-scroll-to-latest-message effect calls it on every render.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
afterEach(cleanup);
