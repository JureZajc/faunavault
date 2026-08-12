import "@testing-library/dom";
import { vi } from "vitest";

vi.mock("next/navigation", async () => {
  const React = await import("react");
  const subscribe = (callback: () => void) => {
    window.addEventListener("popstate", callback);
    return () => window.removeEventListener("popstate", callback);
  };
  const snapshot = () => window.location.href;
  const useLocation = () =>
    React.useSyncExternalStore(subscribe, snapshot, () => "http://localhost/");
  const navigate = (href: string, replace: boolean) => {
    window.history[replace ? "replaceState" : "pushState"](null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return {
    usePathname: () => {
      useLocation();
      return window.location.pathname;
    },
    useSearchParams: () => {
      useLocation();
      return new URLSearchParams(window.location.search);
    },
    useRouter: () => ({
      push: (href: string) => navigate(href, false),
      replace: (href: string) => navigate(href, true),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
    }),
  };
});
