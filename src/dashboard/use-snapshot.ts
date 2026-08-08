import { useEffect, useState } from "react";
import { DashboardApiError, loadDashboardSnapshot } from "./api.js";
import type { DashboardSnapshot, ViewState } from "./types.js";
export function useSnapshot(
  initial?: DashboardSnapshot,
): ViewState<DashboardSnapshot> {
  const [state, setState] = useState<ViewState<DashboardSnapshot>>(
    initial ? { kind: "ready", value: initial } : { kind: "loading" },
  );
  useEffect(() => {
    if (initial) return;
    const controller = new AbortController();
    void loadDashboardSnapshot(controller.signal)
      .then((value) => setState({ kind: "ready", value }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState(
          error instanceof DashboardApiError &&
            (error.status === 401 || error.status === 403)
            ? { kind: "unauthorized" }
            : {
                kind: "error",
                message:
                  error instanceof Error
                    ? error.message
                    : "Dashboard data is unavailable.",
              },
        );
      });
    return () => controller.abort();
  }, [initial]);
  return state;
}
