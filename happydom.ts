import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register happy-dom with a real-looking URL so `window.location.href`
// can serve as a base for `new URL(to, base)` resolutions in router
// tests. The default ("about:blank") rejects history.pushState to a
// different origin and produces unhelpful errors when test code
// constructs URLs from relative paths.
GlobalRegistrator.register({ url: "https://app.test/" });
